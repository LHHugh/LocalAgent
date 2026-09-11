/* ============================================================
   Qwen3-VL 智能体演示站 —— 前端逻辑
   零依赖：不引入任何框架与 CDN，Markdown 渲染自行实现
   功能：多轮对话（侧边栏历史）、对话复制 / 删除（可撤销）/ 重命名、
        技能（自定义系统指令，可附加到对话）、流式输出、工具调用可视化
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
    convs: 'qwen_demo_convs',
    active: 'qwen_demo_active',
    skills: 'qwen_demo_skills'
  };

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var S = {
    convs: [],        // 全部对话
    activeId: null,   // 当前对话 id
    skills: [],       // 全部技能
    attachments: [],  // 待发送附件（图片 / 文本文件）
    busy: false,
    abort: null,
    endpoint: '',
    temp: DEF.temperature,
    max: DEF.maxTokens,
    healthy: null
  };

  /* ───────────────────────── 工具函数 ───────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return esc(s); }

  function readLS(k, d) {
    try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  }
  function writeLS(k, v) {
    try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {}
  }

  function normEndpoint(u) {
    return String(u || '').trim().replace(/\/+$/, '');
  }

  // ngrok 免费版会在浏览器请求前插一张「Visit Site」拦截页，带上此头绕过。
  function extraHeaders() {
    return /ngrok/i.test(S.endpoint) ? { 'ngrok-skip-browser-warning': 'true' } : {};
  }

  function uid(p) {
    return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function dayKey(ts) {
    var d = new Date(ts); var n = new Date();
    var a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var b = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    var diff = Math.round((b - a) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return '近 7 天';
    return '更早';
  }

  function findSkill(id) {
    for (var i = 0; i < S.skills.length; i++) if (S.skills[i].id === id) return S.skills[i];
    return null;
  }

  /* ───────────────────────── 对话持久化 ───────────────────────── */

  function loadConvs() {
    try {
      var raw = readLS(LS.convs, '');
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) arr = [];
      return arr;
    } catch (e) { return []; }
  }
  function saveConvs() {
    try { writeLS(LS.convs, JSON.stringify(S.convs)); } catch (e) {}
  }

  function getActive() {
    var c = null;
    for (var i = 0; i < S.convs.length; i++) if (S.convs[i].id === S.activeId) { c = S.convs[i]; break; }
    if (!c) { c = S.convs[0] || newConv(false); }
    S.activeId = c.id;
    return c;
  }

  function newConv(persist) {
    var c = { id: uid('conv'), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), skillIds: [], messages: [] };
    S.convs.unshift(c);
    S.activeId = c.id;
    if (persist !== false) { saveConvs(); writeLS(LS.active, c.id); }
    return c;
  }

  function selectConv(id) {
    S.activeId = id;
    writeLS(LS.active, id);
    var c = getActive();
    if (!c.messages.length) renderWelcome();
    else render();
    renderSidebar();
    renderActiveSkills();
    $('#input').focus();
  }

  function deleteConv(id) {
    var idx = -1;
    for (var i = 0; i < S.convs.length; i++) if (S.convs[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    var removed = S.convs.splice(idx, 1)[0];
    // 撤销缓存
    pendingUndo = { conv: removed, index: Math.min(idx, S.convs.length) };
    if (S.activeId === id) {
      if (S.convs.length) selectConv(S.convs[0].id);
      else { var nc = newConv(); selectConv(nc.id); }
    }
    saveConvs();
    renderSidebar();
    toast('已删除对话「' + truncate(removed.title, 16) + '」', function () {
      S.convs.splice(pendingUndo.index, 0, pendingUndo.conv);
      saveConvs();
      renderSidebar();
    });
  }
  var pendingUndo = null;

  function renameConv(id, title) {
    var c = null;
    for (var i = 0; i < S.convs.length; i++) if (S.convs[i].id === id) { c = S.convs[i]; break; }
    if (!c) return;
    title = (title || '').trim();
    if (title) c.title = title;
    c.updatedAt = Date.now();
    saveConvs();
    renderSidebar();
  }

  function copyConv(c) {
    var lines = [];
    lines.push(c.title);
    lines.push('');
    (c.messages || []).forEach(function (m) {
      if (!m.content || m.streaming) return;
      var who = m.role === 'user' ? '你' : (SITE.botName || 'Qwen-Agent');
      lines.push('【' + who + '】');
      lines.push(msgText(m));
      lines.push('');
    });
    var text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    copyText(text).then(function () {
      toast('对话已复制到剪贴板');
    }).catch(function () { toast('复制失败，请检查浏览器权限'); });
  }

  function copyText(t) {
    if (navigator.clipboard) return navigator.clipboard.writeText(t);
    return new Promise(function (res, rej) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); res();
      } catch (e) { rej(e); }
    });
  }

  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  // 把消息内容收敛为纯文本（用于侧边栏预览 / 对话复制）
  function msgText(m) {
    var c = m && m.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.map(function (p) {
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text') return p.text || '';
      if (p.type === 'image') return '[图片]';
      if (p.type === 'file') return '【文件：' + (p.name || '') + '】\n' + (p.text || '');
      return '';
    }).join('\n');
  }

  function formatBytes(b) {
    b = b || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  /* ───────────────────────── 技能持久化 ───────────────────────── */

  function loadSkills() {
    try {
      var raw = readLS(LS.skills, '');
      var arr = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(arr)) {
        arr = [
          { id: uid('skill'), name: '学术润色',
            prompt: '你是一位严谨的学术写作助手。回答使用简洁连贯的中文，避免长难句、生僻词与冗余修饰，用连词自然衔接。',
            createdAt: Date.now() },
          { id: uid('skill'), name: '代码讲解',
            prompt: '你擅长把代码讲清楚。遇到代码时，先说明整体作用，再按关键步骤拆解，并点出常见易错点。',
            createdAt: Date.now() }
        ];
        writeLS(LS.skills, JSON.stringify(arr));
      }
      return arr;
    } catch (e) { return []; }
  }
  function saveSkills() { try { writeLS(LS.skills, JSON.stringify(S.skills)); } catch (e) {} }

  function addOrUpdateSkill() {
    var name = $('#skill-name').value.trim();
    var prompt = $('#skill-prompt').value.trim();
    if (!name || !prompt) { toast('请填写技能名称和指令'); return; }
    if (editingSkillId) {
      var sk = findSkill(editingSkillId);
      if (sk) { sk.name = name; sk.prompt = prompt; }
    } else {
      S.skills.push({ id: uid('skill'), name: name, prompt: prompt, createdAt: Date.now() });
    }
    saveSkills();
    editingSkillId = null;
    $('#skill-name').value = '';
    $('#skill-prompt').value = '';
    $('#skill-save').textContent = '保存技能';
    renderSkillList();
    renderActiveSkills();
    toast('技能已保存');
  }
  var editingSkillId = null;

  function deleteSkill(id) {
    S.skills = S.skills.filter(function (s) { return s.id !== id; });
    // 从所有对话中移除该技能
    S.convs.forEach(function (c) {
      if (c.skillIds) c.skillIds = c.skillIds.filter(function (x) { return x !== id; });
    });
    saveSkills(); saveConvs();
    renderSkillList(); renderSidebar(); renderActiveSkills();
    toast('已删除技能');
  }

  function toggleSkill(id, on) {
    var c = getActive();
    c.skillIds = c.skillIds || [];
    if (on) { if (c.skillIds.indexOf(id) < 0) c.skillIds.push(id); }
    else { c.skillIds = c.skillIds.filter(function (x) { return x !== id; }); }
    c.updatedAt = Date.now();
    saveConvs();
    renderActiveSkills();
  }

  /* ───────────────────────── Markdown 渲染 ───────────────────────── */

  function renderInline(s) {
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g,
      function (m, t, u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'; });
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
  }

  function renderMarkdown(src) {
    var blocks = [];
    var s = String(src == null ? '' : src).replace(/\r\n/g, '\n');
    s = s.replace(/```([A-Za-z0-9_+-]*)[ \t]*\n?([\s\S]*?)```/g, function (m, lang, code) {
      blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code>' +
        '<button class="copy-btn" type="button">复制</button></pre>');
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });
    s = s.replace(/`([^`\n]+)`/g, function (m, c) {
      blocks.push('<code>' + esc(c) + '</code>');
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });
    s = esc(s);
    var lines = s.split('\n');
    var out = [], i = 0;
    function isTableSep(l) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.indexOf('-') >= 0; }
    function splitRow(l) { l = l.replace(/^\s*\|/, '').replace(/\|\s*$/, ''); return l.split('|').map(function (c) { return c.trim(); }); }
    while (i < lines.length) {
      var line = lines[i];
      var pm = /^\u0000B(\d+)\u0000$/.exec(line.trim());
      if (pm) { out.push(blocks[+pm[1]]); i++; continue; }
      if (!line.trim()) { i++; continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      var hm = /^(#{1,4})\s+(.*)$/.exec(line);
      if (hm) { var lv = hm[1].length; out.push('<h' + lv + '>' + renderInline(hm[2].trim()) + '</h' + lv + '>'); i++; continue; }
      if (/^\s*&gt;/.test(line)) {
        var buf = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++; }
        out.push('<blockquote>' + renderInline(buf.join(' ')) + '</blockquote>');
        continue;
      }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = splitRow(line); i += 2; var body = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) { body.push(splitRow(lines[i])); i++; }
        var th = '<tr>' + head.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') + '</tr>';
        var tb = body.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + renderInline(c) + '</td>'; }).join('') + '</tr>'; }).join('');
        out.push('<table><thead>' + th + '</thead><tbody>' + tb + '</tbody></table>');
        continue;
      }
      var lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (lm) {
        var ordered = /\d/.test(lm[2]); var items = [];
        while (i < lines.length) {
          var m2 = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m2) break;
          if (/\d/.test(m2[2]) !== ordered) break;
          items.push('<li>' + renderInline(m2[3]) + '</li>'); i++;
        }
        out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,4})\s/.test(lines[i]) && !/^\s*&gt;/.test(lines[i]) &&
             !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) { para.push(lines[i]); i++; }
      if (para.length) out.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
      else i++;
    }
    var html = out.join('\n');
    html = html.replace(/\u0000B(\d+)\u0000/g, function (m, n) { return blocks[+n]; });
    return html;
  }

  /* ───────────────────────── 消息渲染 ───────────────────────── */

  var BOT_AV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="13" rx="3"/><path d="M12 2v4M8.5 19v1.5M15.5 19v1.5"/><circle cx="9.2" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>';
  var COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

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
    var bodyHtml = isUser ? renderUserContent(m)
      : '<div class="md">' + renderMarkdown(m.content) + (m.streaming ? '<span class="cursor"></span>' : '') + '</div>';

    return '<div class="msg ' + (isUser ? 'user' : 'bot') + '" data-i="' + idx + '">' +
      '<div class="avatar">' + (isUser ? '我' : BOT_AV) + '</div>' +
      '<div class="body">' +
        '<div class="name">' + esc(isUser ? '你' : (SITE.botName || 'Qwen-Agent')) + '</div>' +
        tools + bodyHtml +
      '</div>' +
      '<div class="msg-actions">' +
        '<button class="msg-copy" data-i="' + idx + '" title="复制">' + COPY_ICON + '</button>' +
      '</div>' +
    '</div>';
  }

  // 用户消息可能含图片 / 文本文件附件（content 为数组）
  function renderUserContent(m) {
    var c = m.content;
    if (typeof c === 'string' || !Array.isArray(c)) {
      return '<div class="bubble"><div class="md">' + esc(c || '').replace(/\n/g, '<br>') + '</div></div>';
    }
    var inner = c.map(function (p) {
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text') return '<div class="md">' + renderInline(esc(p.text || '')).replace(/\n/g, '<br>') + '</div>';
      if (p.type === 'image') return '<img class="att-img" src="' + esc(p.data || '') + '" alt="' + esc(p.name || '图片') + '">';
      if (p.type === 'file') {
        var head = '<div class="att-file"><span class="att-file-ico">📄</span>' +
          '<span class="att-file-name">' + esc(p.name || '文件') + '</span>' +
          (p.size ? '<span class="att-file-size">' + formatBytes(p.size) + '</span>' : '') + '</div>';
        var body = (p.text && p.text.length)
          ? '<pre class="att-filetext">' + esc(p.text.length > 1500 ? p.text.slice(0, 1500) + '…' : p.text) + '</pre>'
          : '';
        return head + body;
      }
      return '';
    }).join('');
    return '<div class="bubble">' + inner + '</div>';
  }

  var pendingFrame = null;
  function render() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(function () {
      pendingFrame = null;
      var c = getActive();
      var box = $('#messages');
      var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
      box.innerHTML = (c.messages || []).map(messageHtml).join('');
      bindDynamic();
      if (nearBottom) box.scrollTop = box.scrollHeight;
      saveConvs();
    });
  }

  function renderWelcome() {
    var sug = (CFG.suggestions || []).map(function (t) {
      return '<button class="suggestion" data-q="' + escAttr(t) + '">' + esc(t) + '</button>';
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
    $$('.tool-head').forEach(function (h) { h.onclick = function () { h.parentNode.classList.toggle('open'); }; });
    $$('.copy-btn').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var code = b.parentNode.querySelector('code');
        if (!code) return;
        copyText(code.textContent).then(function () { b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制'; }, 1500); })
          .catch(function () { b.textContent = '复制失败'; });
      };
    });
    $$('.msg-copy').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var c = getActive();
        var m = c.messages[+b.dataset.i];
        if (!m) return;
        copyText(m.content).then(function () { toast('已复制该条消息'); })
          .catch(function () { toast('复制失败'); });
      };
    });
  }

  /* ───────────────────────── 侧边栏渲染 ───────────────────────── */

  function convPreview(c) {
    for (var i = c.messages.length - 1; i >= 0; i--) {
      if (c.messages[i].content && !c.messages[i].streaming) return msgText(c.messages[i]).replace(/\n/g, ' ');
    }
    return '暂无消息';
  }

  function renderSidebar() {
    var q = ($('#conv-search').value || '').trim().toLowerCase();
    var list = $('#conv-list');
    var sorted = S.convs.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });

    if (q) {
      var filtered = sorted.filter(function (c) {
        if (c.title.toLowerCase().indexOf(q) >= 0) return true;
        return (c.messages || []).some(function (m) { return (m.content || '').toLowerCase().indexOf(q) >= 0; });
      });
      if (!filtered.length) { list.innerHTML = '<div class="conv-empty">没有匹配的对话</div>'; return; }
      list.innerHTML = filtered.map(convItemHtml).join('');
    } else {
      if (!sorted.length) { list.innerHTML = '<div class="conv-empty">还没有对话，点击「新对话」开始</div>'; return; }
      var html = '', lastKey = null;
      sorted.forEach(function (c) {
        var k = dayKey(c.updatedAt);
        if (k !== lastKey) { html += '<div class="conv-group-label">' + k + '</div>'; lastKey = k; }
        html += convItemHtml(c);
      });
      list.innerHTML = html;
    }
    bindConvItems();
  }

  function convItemHtml(c) {
    var active = c.id === S.activeId ? ' active' : '';
    return '<div class="conv-item' + active + '" data-id="' + escAttr(c.id) + '">' +
      '<svg class="ci-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      '<span class="conv-main">' +
        '<span class="conv-title" title="' + escAttr(c.title) + '">' + esc(c.title) + '</span>' +
        '<span class="conv-prev">' + esc(truncate(convPreview(c), 40)) + '</span>' +
      '</span>' +
      '<span class="conv-actions">' +
        '<button class="conv-copy" data-id="' + escAttr(c.id) + '" title="复制对话">' + COPY_ICON + '</button>' +
        '<button class="conv-del danger" data-id="' + escAttr(c.id) + '" title="删除对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' +
      '</span>' +
    '</div>';
  }

  function bindConvItems() {
    $$('.conv-item').forEach(function (el) {
      var id = el.dataset.id;
      el.onclick = function (e) {
        if (e.target.tagName === 'INPUT') return;          // 正在重命名
        if (e.target.closest('.conv-actions')) return;
        selectConv(id);
        closeSidebarMobile();
      };
      var titleEl = el.querySelector('.conv-title');
      titleEl.ondblclick = function (e) {
        e.stopPropagation();
        startRename(el, id);
      };
    });
    $$('.conv-copy').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var c = null; for (var i = 0; i < S.convs.length; i++) if (S.convs[i].id === b.dataset.id) c = S.convs[i];
        if (c) copyConv(c);
      };
    });
    $$('.conv-del').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); deleteConv(b.dataset.id); };
    });
  }

  function startRename(el, id) {
    var titleEl = el.querySelector('.conv-title');
    var cur = titleEl.textContent;
    var input = document.createElement('input');
    input.type = 'text'; input.value = cur; input.maxLength = 50;
    input.style.cssText = 'width:100%;font-size:13.5px;padding:2px 4px;border:1px solid var(--border-strong);border-radius:6px;font-family:inherit;';
    titleEl.innerHTML = '';
    titleEl.appendChild(input);
    input.focus(); input.select();
    var done = false;
    function commit() { if (done) return; done = true; renameConv(id, input.value); }
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderSidebar(); } };
    input.onblur = commit;
  }

  /* ───────────────────────── 当前对话已附加技能（chips） ───────────────────────── */

  function renderActiveSkills() {
    var c = getActive();
    var box = $('#active-skills');
    var ids = c.skillIds || [];
    if (!ids.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = ids.map(function (id) {
      var sk = findSkill(id); if (!sk) return '';
      return '<span class="skill-chip"><b>' + esc(sk.name) + '</b>' +
        '<button class="chip-x" data-id="' + escAttr(id) + '" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></span>';
    }).join('');
    $$('.chip-x').forEach(function (b) {
      b.onclick = function () { toggleSkill(b.dataset.id, false); };
    });
  }

  /* ───────────────────────── 技能面板渲染 ───────────────────────── */

  function renderSkillList() {
    var box = $('#skill-list');
    if (!S.skills.length) { box.innerHTML = '<div class="skill-empty">还没有技能，先在上方添加一个吧。</div>'; return; }
    var active = getActive();
    var attached = active.skillIds || [];
    box.innerHTML = S.skills.map(function (sk) {
      var on = attached.indexOf(sk.id) >= 0;
      return '<div class="skill-card" data-id="' + escAttr(sk.id) + '">' +
        '<div class="sc-top"><span class="sc-name">' + esc(sk.name) + '</span></div>' +
        '<div class="sc-prompt">' + esc(sk.prompt) + '</div>' +
        '<div class="sc-actions">' +
          '<label class="sc-toggle"><input type="checkbox" class="sc-check" data-id="' + escAttr(sk.id) + '"' + (on ? ' checked' : '') + '>附加到当前对话</label>' +
          '<span class="sc-links">' +
            '<button class="sc-edit" data-id="' + escAttr(sk.id) + '" title="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
            '<button class="sc-del danger" data-id="' + escAttr(sk.id) + '" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' +
          '</span>' +
        '</div>' +
      '</div>';
    }).join('');
    $$('.sc-check').forEach(function (c) { c.onchange = function () { toggleSkill(c.dataset.id, c.checked); }; });
    $$('.sc-edit').forEach(function (b) { b.onclick = function () { editSkill(b.dataset.id); }; });
    $$('.sc-del').forEach(function (b) { b.onclick = function () { deleteSkill(b.dataset.id); }; });
  }

  function editSkill(id) {
    var sk = findSkill(id);
    if (!sk) return;
    editingSkillId = id;
    $('#skill-name').value = sk.name;
    $('#skill-prompt').value = sk.prompt;
    $('#skill-save').textContent = '更新技能';
    $('#skill-name').focus();
  }

  /* ───────────────────────── 服务状态 ───────────────────────── */

  function setStatus(kind, text) {
    var el = $('#status');
    el.className = 'status ' + kind;
    el.querySelector('.status-text').textContent = text;
  }
  function showBanner(msg) { $('#banner-text').textContent = msg; $('#banner').hidden = false; }
  function hideBanner() { $('#banner').hidden = true; }

  function toast(msg, undoFn) {
    var t = $('#toast');
    t.hidden = false;
    if (undoFn) {
      t.innerHTML = '<span></span><button id="toast-undo">撤销</button>';
      t.querySelector('span').textContent = msg;
      t.querySelector('#toast-undo').onclick = function () { undoFn(); t.hidden = true; clearTimeout(toast._t); };
    } else {
      t.innerHTML = '<span></span>';
      t.querySelector('span').textContent = msg;
    }
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, undoFn ? 5000 : 2200);
  }

  function checkHealth() {
    var ep = S.endpoint;
    if (!ep || ep.indexOf('REPLACE-ME') >= 0) {
      S.healthy = false; setStatus('warn', '未配置');
      showBanner('尚未配置智能体服务地址。点击「设置」填入服务端点，或查看仓库 README 了解如何自行部署。');
      $('#cfg-health').textContent = '未配置端点。'; return;
    }
    setStatus('loading', '检测中');
    var t0 = Date.now();
    fetch(ep + '/api/health', { method: 'GET', cache: 'no-store', headers: extraHeaders() })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (j) {
        S.healthy = true; setStatus('ok', '在线 · ' + (Date.now() - t0) + 'ms'); hideBanner();
        $('#cfg-health').textContent = [
          '状态        : 在线',
          '模型        : ' + (j.model || '-'),
          '模型服务    : ' + ((j.vllm && j.vllm.ok) ? '正常' : '未知'),
          '工具        : ' + (((j.agent && j.agent.tools) || []).join(', ') || '-'),
          '响应耗时    : ' + (Date.now() - t0) + ' ms'
        ].join('\n');
      })
      .catch(function (e) {
        S.healthy = false; setStatus('err', '离线');
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
    $('#btn-attach').disabled = b;
    $('#input').disabled = false;
    updateSendBtn();
  }

  /* ───────────────────────── 附件：图片 / 文本文件 ───────────────────────── */

  var TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'py', 'js', 'ts',
    'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'xml', 'yaml', 'yml', 'html', 'css',
    'toml', 'ini', 'sh', 'sql', 'tex'];

  // 把存储用的多模态 content 转成发给后端的 OpenAI 风格数组
  function toWireContent(m) {
    var c = m.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.map(function (p) {
      if (!p || typeof p !== 'object') return null;
      if (p.type === 'image') return { type: 'image_url', image_url: { url: p.data } };
      if (p.type === 'file') return { type: 'text', text: '【文件：' + (p.name || '未命名') + '】\n' + (p.text || '') };
      if (p.type === 'text') return { type: 'text', text: p.text || '' };
      return null;
    }).filter(Boolean).filter(function (p) { return p.type !== 'text' || (p.text && p.text.trim()); });
  }

  // 将图片压缩到最长边 1024px 并转 JPEG，控制体积便于通过公网隧道
  function downscaleImage(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = function () { rej(new Error('读取失败')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { rej(new Error('图片解析失败')); };
        img.onload = function () {
          var max = 1024, w = img.width, h = img.height;
          if (w > max || h > max) { var r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          try { res(cv.toDataURL('image/jpeg', 0.82)); }
          catch (e) { rej(e); }
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function handleFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var pending = 0, done = 0;
    function finishOne() { done++; if (done >= pending && pending > 0) { renderAttachments(); updateSendBtn(); } }
    files.forEach(function (f) {
      if (f.size > 12 * 1024 * 1024) { toast('文件过大（>12MB）：' + f.name); return; }
      if (f.type.indexOf('image/') === 0) {
        pending++;
        downscaleImage(f).then(function (url) {
          S.attachments.push({ kind: 'image', name: f.name, data: url, size: f.size });
        }).catch(function () { toast('图片处理失败：' + f.name); }).then(finishOne);
        return;
      }
      var ext = (f.name.split('.').pop() || '').toLowerCase();
      if (TEXT_EXT.indexOf(ext) < 0) { toast('公开演示暂仅支持图片与纯文本文件：' + f.name); return; }
      pending++;
      var rd = new FileReader();
      rd.onerror = function () { toast('读取失败：' + f.name); finishOne(); };
      rd.onload = function () {
        var txt = String(rd.result || '');
        if (txt.length > 30000) { txt = txt.slice(0, 30000); toast('文本较长，仅截取前 30000 字：' + f.name); }
        S.attachments.push({ kind: 'file', name: f.name, text: txt, size: f.size });
        finishOne();
      };
      rd.readAsText(f);
    });
    if (!pending) renderAttachments();
  }

  function renderAttachments() {
    var box = $('#att-preview');
    if (!S.attachments.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = S.attachments.map(function (a, i) {
      if (a.kind === 'image') {
        return '<div class="att-thumb" data-i="' + i + '"><img src="' + esc(a.data || '') + '" alt="' + esc(a.name || '') + '">' +
          '<button class="att-x" data-i="' + i + '" title="移除" type="button">×</button></div>';
      }
      return '<div class="att-chip" data-i="' + i + '"><span class="att-chip-ico">📄</span>' +
        '<span class="att-chip-name">' + esc(a.name || '文件') + '</span>' +
        '<span class="att-chip-size">' + formatBytes(a.size || 0) + '</span>' +
        '<button class="att-x" data-i="' + i + '" title="移除" type="button">×</button></div>';
    }).join('');
    $$('.att-x').forEach(function (b) {
      b.onclick = function () { S.attachments.splice(+b.dataset.i, 1); renderAttachments(); updateSendBtn(); };
    });
  }

  function updateSendBtn() {
    if (S.busy) return;
    var hasText = $('#input').value.trim();
    var hasAtt = S.attachments.length > 0;
    $('#btn-send').disabled = !(hasText || hasAtt);
  }

  function send() {
    if (S.busy) return;
    var text = $('#input').value.trim();
    if (!text && !S.attachments.length) return;
    if (!S.endpoint || S.endpoint.indexOf('REPLACE-ME') >= 0) { showBanner('请先在「设置」中填写智能体服务端点。'); openDrawer(); return; }
    if (text.length > (DEF.maxInputChars || 4000)) { showBanner('消息过长，请控制在 ' + (DEF.maxInputChars || 4000) + ' 字以内。'); return; }

    // 组装多模态内容：文本 + 图片(vision) + 文本文件(内联)
    var parts = [];
    if (text) parts.push({ type: 'text', text: text });
    S.attachments.forEach(function (a) {
      if (a.kind === 'image') parts.push({ type: 'image', data: a.data, name: a.name });
      else parts.push({ type: 'file', name: a.name, text: a.text, size: a.size });
    });
    var content;
    if (parts.length === 1 && parts[0].type === 'text') content = parts[0].text;
    else if (!parts.length) return;
    else content = parts;

    var c = getActive();
    if (!c.messages.length) $('#messages').innerHTML = '';

    // 首条消息：用文本或首个附件名作为对话标题
    if (c.title === '新对话' && !c.messages.length) {
      c.title = truncate(text || (S.attachments[0] && S.attachments[0].name) || '图片 / 文件消息', 18);
      renderSidebar();
    }
    c.messages.push({ role: 'user', content: content });
    c.updatedAt = Date.now();
    render();

    $('#input').value = ''; S.attachments = []; renderAttachments(); autosize(); hideBanner(); updateSendBtn();

    var history = c.messages
      .filter(function (m) { return !m.streaming && m.content; })
      .slice(-10)
      .map(function (m) { return { role: m.role, content: toWireContent(m) }; });

    // 附加技能作为系统指令注入
    var sys = (c.skillIds || []).map(findSkill).filter(Boolean)
      .map(function (s) { return { role: 'system', content: s.prompt }; });
    var payload = sys.concat(history);

    var reply = { role: 'assistant', content: '', tools: [], streaming: true };
    c.messages.push(reply);
    setBusy(true);
    render();

    var ctrl = new AbortController();
    S.abort = ctrl;

    fetch(S.endpoint + '/api/chat', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders()),
      body: JSON.stringify({ messages: payload, temperature: S.temp, max_tokens: S.max }),
      signal: ctrl.signal
    }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      if (!resp.body) throw new Error('该浏览器不支持流式读取');
      return readStream(resp.body.getReader(), reply, c);
    }).catch(function (e) {
      if (e.name === 'AbortError') { reply.content += '\n\n_（已停止生成）_'; }
      else {
        reply.content = reply.content
          ? reply.content + '\n\n**请求失败**：' + e.message
          : '**请求失败**：' + e.message + '\n\n请检查服务端点是否正确、服务是否在线。';
      }
    }).then(function () {
      reply.streaming = false;
      S.abort = null; setBusy(false);
      c.updatedAt = Date.now();
      saveConvs(); renderSidebar();
      render();
    });
  }

  function readStream(reader, reply, conv) {
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var cardSeq = 0;
    var openCard = null;

    function handle(obj) {
      switch (obj.type) {
        case 'text': reply.content += obj.delta || ''; break;
        case 'tool_start':
          openCard = { id: 't' + (++cardSeq), name: obj.name || 'tool', args: fmtArgs(obj.arguments || obj.args), open: false };
          reply.tools.push(openCard); break;
        case 'tool':
          if (openCard) { openCard.result = String(obj.content || obj.output || obj.result || ''); openCard.open = true; }
          else { reply.tools.push({ id: 't' + (++cardSeq), name: obj.name || 'tool', result: String(obj.content || ''), open: true }); }
          break;
        case 'step_start': reply.content += '\n\n> 步骤 ' + obj.id + '/' + obj.total + '：' + (obj.title || '') + '\n\n'; break;
        case 'error': reply.content += '\n\n**服务错误**：' + (obj.message || '未知错误'); break;
        default: break;
      }
      conv.updatedAt = Date.now();
      render();
    }
    function fmtArgs(a) { if (a == null) return ''; if (typeof a === 'string') return a; try { return JSON.stringify(a, null, 0); } catch (e) { return String(a); } }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { if (buf.trim()) buf.split('\n').forEach(tryLine); return; }
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

  /* ───────────────────────── 抽屉 / 侧边栏开关 ───────────────────────── */

  function openDrawer() { $('#drawer-mask').hidden = false; $('#drawer').hidden = false; }
  function closeDrawer() { $('#drawer-mask').hidden = true; $('#drawer').hidden = true; }
  function openSkills() { renderSkillList(); $('#skills-mask').hidden = false; $('#skills-drawer').hidden = false; }
  function closeSkills() {
    $('#skills-mask').hidden = true; $('#skills-drawer').hidden = true;
    editingSkillId = null; $('#skill-name').value = ''; $('#skill-prompt').value = '';
    $('#skill-save').textContent = '保存技能';
  }
  function toggleSidebar() { document.body.classList.toggle('sidebar-open'); syncSidebarMask(); }
  function closeSidebarMobile() { if (window.innerWidth <= 860) { document.body.classList.remove('sidebar-open'); syncSidebarMask(); } }
  function syncSidebarMask() {
    var open = document.body.classList.contains('sidebar-open');
    $('#sidebar-mask').hidden = !open;
  }

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
    S.convs = loadConvs();
    S.skills = loadSkills();

    var savedActive = readLS(LS.active, null);
    if (savedActive && S.convs.some(function (c) { return c.id === savedActive; })) S.activeId = savedActive;
    if (!S.convs.length) newConv();
    else if (!S.activeId) S.activeId = S.convs[0].id;

    $('#cfg-endpoint').value = readLS(LS.endpoint, '');
    $('#cfg-endpoint').placeholder = normEndpoint(CFG.endpoint || '');
    $('#cfg-temp').value = S.temp; $('#cfg-temp-val').textContent = S.temp;
    $('#cfg-max').value = S.max; $('#cfg-max-val').textContent = S.max;

    var c = getActive();
    if (c.messages && c.messages.length) render(); else renderWelcome();
    renderSidebar();
    renderActiveSkills();

    // 发送 / 输入
    $('#btn-send').onclick = function () { S.busy ? stop() : send(); };
    $('#input').oninput = function () { autosize(); if (!S.busy) updateSendBtn(); };
    $('#input').onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };

    // 附件：图片 / 文本文件
    $('#btn-attach').onclick = function () { if (!S.busy) $('#file-input').click(); };
    $('#file-input').onchange = function () { handleFiles(this.files); this.value = ''; };

    // 顶部 / 侧边栏
    $('#btn-toggle').onclick = toggleSidebar;
    $('#sidebar-mask').onclick = function () { document.body.classList.remove('sidebar-open'); syncSidebarMask(); };
    $('#btn-new').onclick = function () { var nc = newConv(); selectConv(nc.id); };
    $('#conv-search').oninput = renderSidebar;

    // 技能
    $('#btn-skills').onclick = openSkills;
    $('#btn-close-skills').onclick = closeSkills;
    $('#skills-mask').onclick = closeSkills;
    $('#skill-save').onclick = addOrUpdateSkill;

    // 设置抽屉
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
    $('#cfg-temp').oninput = function () { S.temp = parseFloat(this.value); writeLS(LS.temp, this.value); $('#cfg-temp-val').textContent = S.temp; };
    $('#cfg-max').oninput = function () { S.max = parseInt(this.value, 10); writeLS(LS.max, this.value); $('#cfg-max-val').textContent = S.max; };
    $('#btn-clear').onclick = function () {
      var cc = getActive(); cc.messages = []; cc.title = '新对话'; cc.updatedAt = Date.now();
      saveConvs(); renderWelcome(); renderSidebar(); closeDrawer();
    };
    $('#btn-reset').onclick = function () {
      [LS.endpoint, LS.temp, LS.max].forEach(function (k) { writeLS(k, null); });
      location.reload();
    };

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDrawer(); closeSkills(); }
    });
    window.addEventListener('resize', syncSidebarMask);

    autosize();
    updateSendBtn();
    checkHealth();
    setInterval(checkHealth, 60000);
    $('#input').focus();
  }

  function stop() { if (S.abort) { S.abort.abort(); S.abort = null; } }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
