/* ============================================================
   注册 / 登录
   说明：GitHub Pages 是纯静态站点，没有后端，这里用 localStorage
   保存账号与会话，属于演示级实现。真正的鉴权要等服务端网关接入，
   届时注册登录与 API Key 签发都应改由后端完成。
   ============================================================ */
(function () {
  'use strict';

  var K_USERS = 'localai_users';        // { email: {salt, hash, createdAt} }
  var K_SESSION = 'localai_session';    // 当前登录邮箱
  var K_SUB = 'localai_sub_';           // 每个账号的套餐
  var K_KEYS = 'localai_keys_';         // 每个账号的 Key 列表
  var K_PENDING = 'localai_pending';    // 待处理的购买

  var listeners = [];

  function read(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
    catch (e) { return d; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  function hash(pwd, salt) {
    var input = salt + '::' + pwd;
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
        .then(function (buf) {
          var arr = new Uint8Array(buf), s = '';
          for (var i = 0; i < arr.length; i++) s += ('0' + arr[i].toString(16)).slice(-2);
          return s;
        })
        .catch(function () { return simpleHash(input); });
    }
    return Promise.resolve(simpleHash(input));
  }

  function simpleHash(s) {
    var h = 0, i;
    for (i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return 'x' + (h >>> 0).toString(16);
  }

  function salt() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function validEmail(e) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  var Auth = {
    /* ---------- 账号 ---------- */
    users: function () { return read(K_USERS, {}) || {}; },

    register: function (email, pwd) {
      email = (email || '').trim().toLowerCase();
      if (!validEmail(email)) return Promise.reject(new Error('请填写有效的邮箱地址'));
      if (!pwd || pwd.length < 6) return Promise.reject(new Error('密码至少 6 位'));
      var users = Auth.users();
      if (users[email]) return Promise.reject(new Error('该邮箱已注册，请直接登录'));
      var s = salt();
      return hash(pwd, s).then(function (h) {
        users[email] = { salt: s, hash: h, createdAt: Date.now() };
        write(K_USERS, users);
        write(K_SESSION, email);
        Auth.emit();
        return email;
      });
    },

    login: function (email, pwd) {
      email = (email || '').trim().toLowerCase();
      var users = Auth.users();
      var u = users[email];
      if (!u) return Promise.reject(new Error('账号不存在，请先注册'));
      return hash(pwd, u.salt).then(function (h) {
        if (h !== u.hash) return Promise.reject(new Error('密码不正确'));
        write(K_SESSION, email);
        Auth.emit();
        return email;
      });
    },

    logout: function () {
      try { localStorage.removeItem(K_SESSION); } catch (e) {}
      Auth.emit();
    },

    user: function () {
      try { return localStorage.getItem(K_SESSION) || null; } catch (e) { return null; }
    },
    isLoggedIn: function () { return !!Auth.user(); },

    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); },
    emit: function () { listeners.forEach(function (cb) { try { cb(Auth.user()); } catch (e) {} }); },

    /* ---------- 套餐与 Key ---------- */
    getSub: function () {
      var u = Auth.user();
      if (!u) return null;
      return read(K_SUB + u, null);
    },
    setSub: function (sub) {
      var u = Auth.user();
      if (!u) return;
      write(K_SUB + u, sub);
    },
    keys: function () {
      var u = Auth.user();
      if (!u) return [];
      return read(K_KEYS + u, []) || [];
    },
    saveKeys: function (list) {
      var u = Auth.user();
      if (!u) return;
      write(K_KEYS + u, list);
    },
    createKey: function (label) {
      var bytes = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
      var key = { id: hex.slice(0, 8), key: 'sk-live-' + hex, label: label || '默认 Key', createdAt: Date.now(), revoked: false };
      var list = Auth.keys();
      list.unshift(key);
      Auth.saveKeys(list);
      return key;
    },
    revokeKey: function (id) {
      var list = Auth.keys().map(function (k) {
        if (k.id === id) k.revoked = true;
        return k;
      });
      Auth.saveKeys(list);
    },
    pending: function () { return read(K_PENDING, null); },
    setPending: function (p) { write(K_PENDING, p); },
    clearPending: function () { try { localStorage.removeItem(K_PENDING); } catch (e) {} }
  };

  /* ============================================================
     界面：顶栏账户区 + 登录/注册弹窗
     ============================================================ */

  var modal = null;
  var pendingAction = null;   // 登录成功后要执行的操作
  var hintText = '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'auth-mask';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="auth-box" role="dialog" aria-modal="true" aria-label="登录或注册">' +
        '<button class="auth-close" aria-label="关闭">×</button>' +
        '<div class="auth-tabs">' +
          '<button class="auth-tab is-on" data-tab="login">登录</button>' +
          '<button class="auth-tab" data-tab="reg">注册</button>' +
        '</div>' +
        '<p class="auth-hint" hidden></p>' +
        '<label class="auth-field"><span>邮箱</span>' +
          '<input type="email" id="auth-email" autocomplete="email" placeholder="you@example.com"></label>' +
        '<label class="auth-field"><span>密码</span>' +
          '<input type="password" id="auth-pwd" autocomplete="current-password" placeholder="至少 6 位"></label>' +
        '<p class="auth-err" hidden></p>' +
        '<button class="btn primary auth-submit" style="width:100%;justify-content:center">登录</button>' +
        '<p class="auth-foot">本站为静态演示，账号与 Key 保存在你自己的浏览器里，不会上传到服务器。</p>' +
      '</div>';
    document.body.appendChild(modal);

    var cur = 'login';
    var tabs = modal.querySelectorAll('.auth-tab');
    var submit = modal.querySelector('.auth-submit');
    var err = modal.querySelector('.auth-err');

    function setTab(t) {
      cur = t;
      tabs.forEach(function (b) { b.classList.toggle('is-on', b.dataset.tab === t); });
      submit.textContent = t === 'login' ? '登录' : '注册并登录';
      modal.querySelector('#auth-pwd').setAttribute('autocomplete', t === 'login' ? 'current-password' : 'new-password');
      err.hidden = true;
    }
    tabs.forEach(function (b) {
      b.onclick = function () { setTab(b.dataset.tab); };
    });

    modal.querySelector('.auth-close').onclick = function () { closeModal(); };
    modal.onclick = function (e) { if (e.target === modal) closeModal(); };

    submit.onclick = function () {
      var email = modal.querySelector('#auth-email').value;
      var pwd = modal.querySelector('#auth-pwd').value;
      err.hidden = true;
      submit.disabled = true;
      var p = cur === 'login' ? Auth.login(email, pwd) : Auth.register(email, pwd);
      p.then(function () {
        submit.disabled = false;
        closeModal();
        if (pendingAction) { var fn = pendingAction; pendingAction = null; fn(); }
        else toast('已登录');
      }).catch(function (e2) {
        submit.disabled = false;
        err.textContent = e2.message || '操作失败';
        err.hidden = false;
      });
    };

    modal.querySelector('#auth-pwd').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit.click();
    });

    return modal;
  }

  function openModal(hint, action) {
    var m = buildModal();
    hintText = hint || '';
    pendingAction = action || null;
    var h = m.querySelector('.auth-hint');
    h.textContent = hintText;
    h.hidden = !hintText;
    m.querySelector('.auth-err').hidden = true;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { m.querySelector('#auth-email').focus(); }, 30);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  /* 未登录时拦截：弹出登录框并说明原因 */
  Auth.requireLogin = function (actionName, fn) {
    if (Auth.isLoggedIn()) { fn(); return; }
    openModal('请先登录后再' + (actionName || '继续操作') + '。', fn);
  };

  /* ---------- 轻提示 ---------- */
  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'site-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2200);
  }
  Auth.toast = toast;

  /* ---------- 顶栏账户区 ---------- */
  function renderNav() {
    var cta = document.querySelector('.nav-cta');
    if (!cta) return;

    var old = cta.querySelector('.account');
    if (old) old.remove();

    var wrap = document.createElement('div');
    wrap.className = 'account';

    if (!Auth.isLoggedIn()) {
      var b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = '登录 / 注册';
      b.onclick = function () { openModal('', null); };
      wrap.appendChild(b);
    } else {
      var email = Auth.user();
      var btn = document.createElement('button');
      btn.className = 'account-btn';
      btn.innerHTML = '<span class="account-ava">' + esc(email.charAt(0).toUpperCase()) + '</span>' +
                      '<span class="account-mail">' + esc(email) + '</span>';
      var menu = document.createElement('div');
      menu.className = 'account-menu';
      menu.innerHTML =
        '<a href="console.html">API 控制台</a>' +
        '<a href="pricing.html">套餐与续费</a>' +
        '<button type="button" class="account-out">退出登录</button>';
      btn.onclick = function (e) {
        e.stopPropagation();
        menu.classList.toggle('is-on');
      };
      menu.querySelector('.account-out').onclick = function () {
        Auth.logout();
        toast('已退出登录');
      };
      document.addEventListener('click', function () { menu.classList.remove('is-on'); });
      wrap.appendChild(btn);
      wrap.appendChild(menu);
    }
    cta.appendChild(wrap);
  }

  Auth.renderNav = renderNav;

  Auth.onChange(function () { renderNav(); });

  document.addEventListener('DOMContentLoaded', function () {
    renderNav();
  });
  if (document.readyState !== 'loading') renderNav();

  window.Auth = Auth;
})();
