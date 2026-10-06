/* ============================================================
   背景交互粒子
   - 粒子之间、粒子与鼠标之间按距离连线
   - 鼠标近距离吸附，极近距离避让
   - 移动端 / 低端设备 / 用户要求减少动效时，只渲染一帧静态图，不启动动画
   - 运行期监测帧率，过低自动停止动画，避免拖垮页面
   ============================================================ */
(function () {
  'use strict';

  var CFG = {
    density: 17000,      // 每个粒子占用的像素面积，越小越密
    maxCount: 90,
    staticCount: 34,     // 降级（静态）时的粒子数
    linkDist: 112,       // 粒子之间连线距离
    mouseLink: 155,      // 粒子与鼠标连线距离
    attractDist: 95,     // 吸附作用距离
    avoidDist: 46,       // 避让作用距离
    dotMin: 1.1,
    dotMax: 2.3,
    speed: 0.28
  };

  var DOT = '29, 29, 31';   // 与站点主色 --text 一致，浅灰近黑

  function shouldAnimate() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if ((navigator.maxTouchPoints || 0) > 0) return false;          // 触屏设备
    if (window.innerWidth < 860) return false;                      // 窄屏
    if ((navigator.hardwareConcurrency || 8) <= 4) return false;    // CPU 核心少
    if ((navigator.deviceMemory || 8) <= 4) return false;           // 内存小
    return true;
  }

  var canvas = document.createElement('canvas');
  canvas.id = 'bg-particles';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);

  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, dpr = 1;
  var particles = [];
  var mouse = { x: -9999, y: -9999, active: false };
  var animate = shouldAnimate();
  var rafId = null;
  var running = false;

  // 帧率监测
  var frames = 0, fpsWindowStart = 0, stopped = false;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(count) {
    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * CFG.speed * 2,
        vy: (Math.random() - 0.5) * CFG.speed * 2,
        r: CFG.dotMin + Math.random() * (CFG.dotMax - CFG.dotMin)
      });
    }
  }

  function targetCount() {
    if (!animate) return CFG.staticCount;
    var n = Math.round((W * H) / CFG.density);
    return Math.max(24, Math.min(CFG.maxCount, n));
  }

  function step() {
    var i, j, p, q, dx, dy, dist;

    // 位置推进 + 鼠标作用
    for (i = 0; i < particles.length; i++) {
      p = particles[i];

      if (mouse.active) {
        dx = mouse.x - p.x;
        dy = mouse.y - p.y;
        dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < CFG.avoidDist) {
          // 极近 → 避让（推开）
          p.vx -= (dx / dist) * 0.55;
          p.vy -= (dy / dist) * 0.55;
        } else if (dist < CFG.attractDist) {
          // 中距 → 轻微吸附
          p.vx += (dx / dist) * 0.055;
          p.vy += (dy / dist) * 0.055;
        }
      }

      p.vx *= 0.972;
      p.vy *= 0.972;
      // 保底漂移，避免整体静止
      p.vx += (Math.random() - 0.5) * 0.012;
      p.vy += (Math.random() - 0.5) * 0.012;

      p.x += p.vx;
      p.y += p.vy;

      // 环绕
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
    }

    // 连线：粒子之间
    ctx.lineWidth = 1;
    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      for (j = i + 1; j < particles.length; j++) {
        q = particles[j];
        dx = p.x - q.x; dy = p.y - q.y;
        if (Math.abs(dx) > CFG.linkDist || Math.abs(dy) > CFG.linkDist) continue;
        dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > CFG.linkDist) continue;
        ctx.strokeStyle = 'rgba(' + DOT + ',' + ((1 - dist / CFG.linkDist) * 0.1).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    }

    // 连线：鼠标
    if (mouse.active) {
      for (i = 0; i < particles.length; i++) {
        p = particles[i];
        dx = mouse.x - p.x; dy = mouse.y - p.y;
        if (Math.abs(dx) > CFG.mouseLink || Math.abs(dy) > CFG.mouseLink) continue;
        dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > CFG.mouseLink) continue;
        ctx.strokeStyle = 'rgba(' + DOT + ',' + ((1 - dist / CFG.mouseLink) * 0.2).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
      }
    }

    // 粒子本体
    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      ctx.fillStyle = 'rgba(' + DOT + ',0.34)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    step();
  }

  function loop(ts) {
    if (!running) return;
    draw();

    frames++;
    if (!fpsWindowStart) fpsWindowStart = ts;
    if (frames >= 90) {
      var fps = (frames * 1000) / (ts - fpsWindowStart);
      frames = 0; fpsWindowStart = ts;
      if (fps < 22 && !stopped) {   // 帧率过低 → 关掉动画，保留静态图
        stopped = true;
        stop();
        canvas.style.opacity = '0.5';
        return;
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running || stopped) return;
    running = true;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function init() {
    resize();
    spawn(targetCount());
    draw();               // 无论如何先画一帧，保证降级时也有视觉
    if (animate) start();
  }

  // ---- 事件 ----
  window.addEventListener('mousemove', function (e) {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
  }, { passive: true });

  window.addEventListener('mouseleave', function () {
    mouse.active = false;
  });

  var rzTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(function () {
      var wasAnimate = animate;
      animate = shouldAnimate();
      resize();
      spawn(targetCount());
      draw();
      if (animate && !wasAnimate) { stopped = false; canvas.style.opacity = ''; start(); }
      if (!animate) stop();
    }, 180);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else if (animate && !stopped) start();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
