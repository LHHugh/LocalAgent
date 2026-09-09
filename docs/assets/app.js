/* ============================================================
   Qwen3-VL 智能体演示站 —— 前端逻辑
   零依赖：不引入任何框架与 CDN，Markdown 渲染自行实现
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.DEMO_CONFIG || {};
  var SITE = CFG.site || {};
  var DEF = CFG.defaults || { temperature: 0.7, maxTokens: 1024, maxInputChars: 4000 };

  var LS = {
    endpoint: 'qwen_demo_endpoint',
    temp: 'qwen_demo_temp',
    max: 'qwen_demo_max',
    conv: 'qwen_demo_conv'
  };

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var S = {
    messages: [],      // {role:'user'|'assistant', content:'', tools:[]}
    busy: false,
    abort: null,
    endpoint: '',
    temp: DEF.temperature,
    max: DEF.maxTokens,
    healthy: null,     // true / false / null
    seq: 0
  };

  /* ───────────────────────── 工具函数 ───────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function readLS(k, d) {
    try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  }
  function writeLS(k, v) {
    try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {}
  }

  function normEndpoint(u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    return u;
  }

  // ngrok 免费版会在浏览器请求前插一张「Visit Site」拦截页，
  // 带上这个头即可绕过。只对 ngrok 域名附加，避免给自建端点引入多余的预检。
  function extraHeaders() {
    return /ngrok/i.test(S.endpoint) ? { 'ngrok-skip-browser-warning': 'true' } : {};
  }

  /* ───────────────────────── Markdown 渲染 ─────────────────────────
     策略：先把代码块与行内代码抽成占位符 → 整体转义 → 做块级/行级变换
           → 最后回填代码。这样既能防 XSS，又不会破坏代码里的尖括号。     */

  function renderInline(s) {
    // 链接
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g,
      function (m, t, u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'; });
    // 加粗 / 斜体 / 删除线
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
  }

  function renderMarkdown(src) {
    var blocks = [];
    var s = String(src == null ? '' : src).replace(/\r\n/g, '\n');

    // 抽出围栏代码块
    s = s.replace(/```([A-Za-z0-9_+-]*)[ \t]*\n?([\s\S]*?)```/g, function (m, lang, code) {
      blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code>' +
        '<button class="copy-btn" type="button">复制</button></pre>');
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });
    // 抽出行内代码
    s = s.replace(/`([^`\n]+)`/g, function (m, c) {
      blocks.push('<code>' + esc(c) + '</code>');
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });

    s = esc(s);

    var lines = s.split('\n');
    var out = [];
    var i = 0;

    function isTableSep(l) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.indexOf('-') >= 0; }
    function splitRow(l) {
      l = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
      return l.split('|').map(function (c) { return c.trim(); });
    }

    while (i < lines.length) {
      var line = lines[i];

      // 占位代码块
      var pm = /^\u0000B(\d+)\u0000$/.exec(line.trim());
      if (pm) { out.push(blocks[+pm[1]]); i++; continue; }

      // 空行
      if (!line.trim()) { i++; continue; }

      // 分隔线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // 标题
      var hm = /^(#{1,4})\s+(.*)$/.exec(line);
      if (hm) {
        var lv = hm[1].length;
        out.push('<h' + lv + '>' + renderInline(hm[2].trim()) + '</h' + lv + '>');
        i++; continue;
      }

      // 引用
      if (/^\s*&gt;/.test(line)) {
        var buf = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderInline(buf.join(' ')) + '</blockquote>');
        continue;
      }

      // 表格
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = splitRow(line);
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          body.push(splitRow(lines[i])); i++;
        }
        var th = '<tr>' + head.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') + '</tr>';
        var tb = body.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + renderInline(c) + '</td>'; }).join('') + '</tr>';
        }).join('');
        out.push('<table><thead>' + th + '</thead><tbody>' + tb + '</tbody></table>');
        continue;
      }

      // 列表
      var lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (lm) {
        var ordered = /\d/.test(lm[2]);
        var items = [];
        while (i < lines.length) {
          var m2 = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m2) break;
          var ord2 = /\d/.test(m2[2]);
          if (ord2 !== ordered) break;
          items.push('<li>' + renderInline(m2[3]) + '</li>');
          i++;
        }
        out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        continue;
      }

      // 段落
      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,4})\s/.test(lines[i]) && !/^\s*&gt;/.test(lines[i]) &&
             !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) out.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
      else i++;
    }

    var html = out.join('\n');
    html = html.replace(/\u0000B(\d+)\u0000/g, function (m, n) { return blocks[+n]; });
    return html;
  }

  /* ───────────────────────── 消息渲染 ───────────────────────── */

  var BOT_AV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="13" rx="3"/><path d="M12 2v4M8.5 19v1.5M15.5 19v1.5"/><circle cx="9.2" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>';

  function toolCardHtml(t) {
    var title = t.name || 'tool';
    var body = t.args ? ('参数：' + t.args) : '';
    if (t.result) body += (body ? '\n\n结果：' : '结果：') + t.result;
    return '<div class="tool-card' + (t.open ? ' open' : '') + '" data-tool="' + t.id + '">' +
      '<div class="tool-head">' +
        '<span class="tool-badge">TOOL</span>' +
        '<span class="tool-title">' + esc(title) + '</span>' +
        '<svg class="tool-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>' +
      '</div>' +
      '<div class="tool-body">' + esc(body || '（无输出）') + '</div>' +
    '</div>';
  }

  function messageHtml(m, idx) {
    var isUser = m.role === 'user';
    var tools = (m.tools || []).map(toolCardHtml).join('');
    var bodyHtml = isUser
      ? '<div class="bubble"><div class="md">' + esc(m.content).replace(/\n/g, '<br>') + '</div></div>'
      : '<div class="md">' + renderMarkdown(m.content) + (m.streaming ? '<span class="cursor"></span>' : '') + '</div>';

    return '<div class="msg ' + (isUser ? 'user' : 'bot') + '" data-i="' + idx + '">' +
      '<div class="avatar">' + (isUser ? '我' : BOT_AV) + '</div>' +
      '<div class="body">' +
        '<div class="name">' + esc(isUser ? '你' : (SITE.botName || 'Qwen-Agent')) + '</div>' +
        tools + bodyHtml +
      '</div>' +
    '</div>';
  }

  var pendingFrame = null;
  function render() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(function () {
      pendingFrame = null;
      var box = $('#messages');
      var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      box.innerHTML = S.messages.map(messageHtml).join('');
      bindDynamic();
      if (nearBottom) box.scrollTop = box.scrollHeight;
      saveConv();
    });
  }

  function renderWelcome() {
    var sug = (CFG.suggestions || []).map(function (t) {
      return '<button class="suggestion" data-q="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    $('#messages').innerHTML =
      '<div class="welcome">' +
        '<div class="wlogo">' + BOT_AV + '</div>' +
        '<h2>' + esc(SITE.title || 'Qwen3-VL 智能体') + '</h2>' +
        '<p>' + esc(SITE.subtitle || '') + '</p>' +
        (sug ? '<div class="suggestions">' + sug + '</div>' : '') +
      '</div>';
    $$('.suggestion').forEach(function (b) {
      b.onclick = function () { $('#input').value = b.dataset.q; autosize(); send(); };
    });
  }

  function bindDynamic() {
    $$('.tool-head').forEach(function (h) {
      h.onclick = function () { h.parentNode.classList.toggle('open'); };
    });
    $$('.copy-btn').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var code = b.parentNode.querySelector('code');
        if (!code) return;
        var txt = code.textContent;
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
          .then(function () { b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制'; }, 1500); })
          .catch(function () { b.textContent = '复制失败'; });
      };
    });
  }

  function saveConv() {
    try {
      var keep = S.messages.map(function (m) {
        return { role: m.role, content: m.content, tools: m.tools || [] };
      }).slice(-40);
      writeLS(LS.conv, JSON.stringify(keep));
    } catch (e) {}
  }

  function loadConv() {
    try {
      var raw = readLS(LS.conv, '');
      if (!raw) return null;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? arr : null;
    } catch (e) { return null; }
  }

  /* ───────────────────────── 服务状态 ───────────────────────── */

  function setStatus(kind, text) {
    var el = $('#status');
    el.className = 'status ' + kind;
    el.querySelector('.status-text').textContent = text;
  }

  function showBanner(msg) {
    $('#banner-text').textContent = msg;
    $('#banner').hidden = false;
  }
  function hideBanner() { $('#banner').hidden = true; }

  function checkHealth() {
    var ep = S.endpoint;
    if (!ep || ep.indexOf('REPLACE-ME') >= 0) {
      S.healthy = false;
      setStatus('warn', '未配置');
      showBanner('尚未配置智能体服务地址。点击右上角「设置」填入服务端点，或查看仓库 README 了解如何自行部署。');
      $('#cfg-health').textContent = '未配置端点。';
      return;
    }
    setStatus('loading', '检测中');
    var t0 = Date.now();
    fetch(ep + '/api/health', { method: 'GET', cache: 'no-store', headers: extraHeaders() })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (j) {
        S.healthy = true;
        setStatus('ok', '在线 · ' + (Date.now() - t0) + 'ms');
        hideBanner();
        var lines = [
          '状态        : 在线',
          '模型        : ' + (j.model || '-'),
          '模型服务    : ' + ((j.vllm && j.vllm.ok) ? '正常' : '未知'),
          '工具        : ' + (((j.agent && j.agent.tools) || []).join(', ') || '-'),
          '响应耗时    : ' + (Date.now() - t0) + ' ms'
        ];
        $('#cfg-health').textContent = lines.join('\n');
      })
      .catch(function (e) {
        S.healthy = false;
        setStatus('err', '离线');
        showBanner('智能体服务当前无法访问（' + e.message + '）。服务器可能已关机或隧道地址已变更，可稍后重试或在「设置」中更换端点。');
        $('#cfg-health').textContent = '无法连接：' + e.message;
      });
  }

  /* ───────────────────────── 发送 / 流式接收 ───────────────────────── */

  function autosize() {
    var ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }

  function setBusy(b) {
    S.busy = b;
    var btn = $('#btn-send');
    btn.classList.toggle('stopping', b);
    btn.title = b ? '停止生成' : '发送';
    btn.disabled = b ? false : !$('#input').value.trim();
    $('#input').disabled = false;
  }

  function send() {
    if (S.busy) return;
    var text = $('#input').value.trim();
    if (!text) return;
    if (!S.endpoint || S.endpoint.indexOf('REPLACE-ME') >= 0) {
      showBanner('请先在「设置」中填写智能体服务端点。');
      openDrawer();
      return;
    }
    if (text.length > (DEF.maxInputChars || 4000)) {
      showBanner('消息过长，请控制在 ' + (DEF.maxInputChars || 4000) + ' 字以内。');
      return;
    }

    if (!S.messages.length) $('#messages').innerHTML = '';
    S.messages.push({ role: 'user', content: text });
    render();

    $('#input').value = '';
    autosize();
    hideBanner();

    var history = S.messages
      .filter(function (m) { return !m.streaming; })
      .slice(-10)
      .map(function (m) { return { role: m.role, content: m.content }; });

    var reply = { role: 'assistant', content: '', tools: [], streaming: true };
    S.messages.push(reply);
    setBusy(true);
    render();

    var ctrl = new AbortController();
    S.abort = ctrl;

    fetch(S.endpoint + '/api/chat', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders()),
      body: JSON.stringify({
        messages: history,
        temperature: S.temp,
        max_tokens: S.max
      }),
      signal: ctrl.signal
    }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      if (!resp.body) throw new Error('该浏览器不支持流式读取');
      return readStream(resp.body.getReader(), reply);
    }).catch(function (e) {
      if (e.name === 'AbortError') {
        reply.content += '\n\n_（已停止生成）_';
      } else {
        reply.content = reply.content
          ? reply.content + '\n\n**请求失败**：' + e.message
          : '**请求失败**：' + e.message + '\n\n请检查服务端点是否正确、服务是否在线。';
      }
    }).then(function () {
      reply.streaming = false;
      S.abort = null;
      setBusy(false);
      render();
    });
  }

  function readStream(reader, reply) {
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var cardSeq = 0;
    var openCard = null;

    function handle(obj) {
      switch (obj.type) {
        case 'text':
          reply.content += obj.delta || '';
          break;
        case 'tool_start':
          openCard = { id: 't' + (++cardSeq), name: obj.name || 'tool', args: fmtArgs(obj.arguments || obj.args), open: false };
          reply.tools.push(openCard);
          break;
        case 'tool':
          if (openCard) {
            openCard.result = String(obj.content || obj.output || obj.result || '');
            openCard.open = true;
          } else {
            reply.tools.push({ id: 't' + (++cardSeq), name: obj.name || 'tool', result: String(obj.content || ''), open: true });
          }
          break;
        case 'step_start':
          reply.content += '\n\n> 步骤 ' + obj.id + '/' + obj.total + '：' + (obj.title || '') + '\n\n';
          break;
        case 'error':
          reply.content += '\n\n**服务错误**：' + (obj.message || '未知错误');
          break;
        default:
          break;
      }
      render();
    }

    function fmtArgs(a) {
      if (a == null) return '';
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a, null, 0); } catch (e) { return String(a); }
    }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          if (buf.trim()) buf.split('\n').forEach(tryLine);
          return;
        }
        buf += decoder.decode(r.value, { stream: true });
        var parts = buf.split('\n');
        buf = parts.pop();
        parts.forEach(tryLine);
        return pump();
      });
    }

    function tryLine(line) {
      line = line.trim();
      if (!line || line.indexOf('data:') !== 0) return;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try { handle(JSON.parse(payload)); } catch (e) { /* 忽略半包 */ }
    }

    return pump();
  }

  /* ───────────────────────── 设置抽屉 ───────────────────────── */

  function openDrawer() { $('#drawer-mask').hidden = false; $('#drawer').hidden = false; }
  function closeDrawer() { $('#drawer-mask').hidden = true; $('#drawer').hidden = true; }

  /* ───────────────────────── 初始化 ───────────────────────── */

  function init() {
    document.title = SITE.title || 'Qwen3-VL 智能体';
    $('#site-title').textContent = SITE.title || 'Qwen3-VL 智能体';
    $('#site-subtitle').textContent = SITE.subtitle || '';
    $('#btn-repo').href = SITE.repo || '#';
    $('#hint').textContent = (CFG.disclaimer || '') || $('#hint').textContent;

    S.endpoint = normEndpoint(readLS(LS.endpoint, null) || CFG.endpoint || '');
    S.temp = parseFloat(readLS(LS.temp, DEF.temperature));
    S.max = parseInt(readLS(LS.max, DEF.maxTokens), 10);

    $('#cfg-endpoint').value = readLS(LS.endpoint, '') ;
    $('#cfg-endpoint').placeholder = normEndpoint(CFG.endpoint || '');
    $('#cfg-temp').value = S.temp;
    $('#cfg-temp-val').textContent = S.temp;
    $('#cfg-max').value = S.max;
    $('#cfg-max-val').textContent = S.max;

    var saved = loadConv();
    if (saved) { S.messages = saved; render(); } else { renderWelcome(); }

    // 发送 / 输入
    $('#btn-send').onclick = function () { S.busy ? stop() : send(); };
    $('#input').oninput = function () { autosize(); if (!S.busy) $('#btn-send').disabled = !$('#input').value.trim(); };
    $('#input').onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    };

    // 抽屉
    $('#btn-settings').onclick = openDrawer;
    $('#btn-close-drawer').onclick = closeDrawer;
    $('#drawer-mask').onclick = closeDrawer;
    $('#banner-close').onclick = hideBanner;

    $('#cfg-endpoint').onchange = function () {
      var v = normEndpoint(this.value);
      if (v) writeLS(LS.endpoint, v); else writeLS(LS.endpoint, null);
      S.endpoint = v || normEndpoint(CFG.endpoint || '');
      checkHealth();
    };
    $('#cfg-temp').oninput = function () {
      S.temp = parseFloat(this.value); writeLS(LS.temp, this.value);
      $('#cfg-temp-val').textContent = S.temp;
    };
    $('#cfg-max').oninput = function () {
      S.max = parseInt(this.value, 10); writeLS(LS.max, this.value);
      $('#cfg-max-val').textContent = S.max;
    };

    $('#btn-clear').onclick = function () {
      S.messages = []; writeLS(LS.conv, null); renderWelcome(); closeDrawer();
    };
    $('#btn-reset').onclick = function () {
      [LS.endpoint, LS.temp, LS.max].forEach(function (k) { writeLS(k, null); });
      location.reload();
    };

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    autosize();
    checkHealth();
    setInterval(checkHealth, 60000);
    $('#input').focus();
  }

  function stop() {
    if (S.abort) { S.abort.abort(); S.abort = null; }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
