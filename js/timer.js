/* ════════════════════════════════════════════════════════════
   Save4 — timer.js  （M4 倒计时定时器模块）
   给活动设限（文档 2.3 功能二）：
   - 输入活动名 + 时长（分钟）/ 一键预设模板
   - 运行中：剩余时间大数字 + 进度条，支持 暂停/继续、+5分、终止
   - 到点：桌宠炸毛(剧烈晃动)+表情生气+蜂鸣提醒，
     气泡带「延长5分钟 / 结束」动作按钮
   - 关键：剩余时间基于「时间戳差值」计算（endAt - now），
     页面被节流/隐藏/刷新后依然准时，不会因定时器被节流而跑偏。
   状态: idle | run | pause | done，持久化于 ui.timer。
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var K = S().KEYS;

  // state: { st:'idle'|'run'|'pause'|'done', name, totalMs, endAt, remainMs }
  var state = { st: 'idle', name: '', totalMs: 0, endAt: 0, remainMs: 0 };
  var els = {};
  var tick = null;      // UI 刷新定时器
  var alarmCtx = null;  // 蜂鸣用 WebAudio（需用户手势后创建）
  var NOTIFY_MS = 5 * 60 * 1000;

  function persist() {
    S().write(K.TIMER, state);
  }
  function load() {
    var t = S().read(K.TIMER, null);
    if (t && t.st && t.st !== 'idle') {
      state = t;
      // 若运行态已过期（如页面关闭后超时）→ 直接进入到点
      if (state.st === 'run' && state.endAt <= Date.now()) {
        state.st = 'done'; state.remainMs = 0; persist();
      }
      if (state.st === 'pause' && state.remainMs <= 0) {
        state.st = 'done'; persist();
      }
    }
  }

  /* ---------- 蜂鸣（短促急促三声，桌面提醒用） ---------- */
  function ensureAudio() {
    try {
      if (!alarmCtx) alarmCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (alarmCtx.state === 'suspended') alarmCtx.resume();
    } catch (e) { /* 音频不可用则静默 */ }
  }
  function beep(freq, when, dur) {
    if (!alarmCtx) return;
    var o = alarmCtx.createOscillator();
    var g = alarmCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, alarmCtx.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.12, alarmCtx.currentTime + when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, alarmCtx.currentTime + when + dur);
    o.connect(g); g.connect(alarmCtx.destination);
    o.start(alarmCtx.currentTime + when);
    o.stop(alarmCtx.currentTime + when + dur + 0.05);
  }
  function alarmRing() {
    ensureAudio();
    if (!alarmCtx) return;
    // 急促三连 + 低音收尾
    for (var i = 0; i < 3; i++) { beep(880, i * 0.28, 0.18); }
    beep(587, 0.9, 0.4);
  }

  /* ---------- 计时核心 ---------- */
  function remainMs() {
    if (state.st === 'run') return Math.max(0, state.endAt - Date.now());
    return state.remainMs || 0;
  }

  function fmt(ms) {
    var s = Math.ceil(ms / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
  }

  function pct() {
    if (!state.totalMs) return 0;
    return Math.max(0, Math.min(100, 100 * (1 - remainMs() / state.totalMs)));
  }

  /* ---------- 到点触发 ---------- */
  function fireDone() {
    state.st = 'done';
    state.remainMs = 0;
    state.endAt = 0;
    persist();
    renderRun();

    // 桌宠炸毛（M4 强提醒）：剧烈晃动 + 生气脸
    if (global.Save4.pet) {
      global.Save4.pet.setExpression('angry');
      global.Save4.pet.fx('angry');
      setTimeout(function () { if (global.Save4.pet) global.Save4.pet.setExpression('idle'); }, 2500);
    }
    alarmRing();

    // 桌面版窗口藏托盘 → 系统通知唤醒
    var desktop = global.Save4Desktop;
    if (desktop && desktop.isDesktop &&
        global.Save4.desktop && !global.Save4.desktop.windowVisible() && desktop.reminderHit) {
      desktop.reminderHit('⏰ 「' + (state.name || '倒计时') + '」时间到！');
      return;
    }

    // 页面气泡 + 动作按钮
    global.Save4.bubble.enqueue({
      text: '⏰ 「' + (state.name || '倒计时') + '」时间到！',
      sticky: true,
      actions: [
        { label: '+5 分钟', primary: true, onClick: extend5 },
        { label: '结束', onClick: stop }
      ]
    });
  }

  /* ---------- 控制 ---------- */
  function start(name, minutes) {
    var nm = String(name || '').trim();
    var mins = Math.min(480, Math.max(0.1, Number(minutes) || 25));
    state = {
      st: 'run',
      name: nm || '专注',
      totalMs: Math.round(mins * 60 * 1000),
      endAt: Date.now() + Math.round(mins * 60 * 1000),
      remainMs: 0
    };
    persist();
    ensureAudio();
    renderRun();
    startTick();
  }

  function pause() {
    if (state.st !== 'run') return;
    state.st = 'pause';
    state.remainMs = Math.max(0, state.endAt - Date.now());
    state.endAt = 0;
    persist(); renderRun(); stopTick();
  }

  function resume() {
    if (state.st !== 'pause') return;
    state.st = 'run';
    state.endAt = Date.now() + state.remainMs;
    persist(); renderRun(); startTick();
  }

  function extend5() {
    if (state.st === 'idle') return;
    if (state.st === 'done') {
      // 从到点状态恢复并顺延 5 分钟
      state.st = 'run';
      state.totalMs += NOTIFY_MS;
      state.endAt = Date.now() + NOTIFY_MS;
      persist(); renderRun(); startTick();
      return;
    }
    if (state.st === 'pause') {
      state.remainMs += NOTIFY_MS;
    } else { // run
      state.endAt += NOTIFY_MS;
    }
    persist(); renderRun();
  }

  function stop() {
    state = { st: 'idle', name: '', totalMs: 0, endAt: 0, remainMs: 0 };
    persist(); renderSet(); stopTick();
  }

  /* ---------- UI 刷新 ---------- */
  function startTick() {
    stopTick();
    tick = setInterval(function () {
      if (state.st !== 'run') return;
      if (Date.now() >= state.endAt) { fireDone(); return; }
      renderClock();
    }, 200);
  }
  function stopTick() {
    if (tick) { clearInterval(tick); tick = null; }
  }

  function renderClock() {
    els.clock.textContent = fmt(remainMs());
    els.barFill.style.width = pct() + '%';
    if (remainMs() <= 60 * 1000 && state.st === 'run') {
      els.clock.classList.add('urgent');
    } else {
      els.clock.classList.remove('urgent');
    }
  }

  function renderSet() {
    els.setView.classList.remove('hidden');
    els.runView.classList.add('hidden');
  }
  function renderRun() {
    els.setView.classList.add('hidden');
    els.runView.classList.remove('hidden');
    els.runName.textContent = state.name || '专注';
    els.pauseBtn.textContent = (state.st === 'pause') ? '继续' : '暂停';
    els.pauseBtn.disabled = (state.st === 'done');
    renderClock();
    if (state.st === 'done') els.clock.classList.add('done');
    else els.clock.classList.remove('done');
  }

  /* ---------- 预设一键调用 ---------- */
  function applyPreset(name, minutes) {
    start(name, minutes);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    els.setView = document.getElementById('timer-set');
    els.runView = document.getElementById('timer-run');
    els.name = document.getElementById('timer-name');
    els.min = document.getElementById('timer-min');
    els.clock = document.getElementById('timer-clock');
    els.runName = document.getElementById('timer-run-name');
    els.barFill = document.getElementById('timer-bar-fill');
    els.pauseBtn = document.getElementById('timer-pause');

    document.getElementById('timer-start').addEventListener('click', function () {
      start(els.name.value, els.min.value);
    });
    document.getElementById('timer-pause').addEventListener('click', function () {
      if (state.st === 'pause') resume(); else pause();
    });
    document.getElementById('timer-extend').addEventListener('click', extend5);
    document.getElementById('timer-stop').addEventListener('click', stop);

    // 预设模板
    var presets = document.querySelectorAll('#timer-presets [data-name]');
    presets.forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyPreset(btn.dataset.name, Number(btn.dataset.min));
      });
    });

    // 浏览器标签被节流时，回到前台立即补扫到点
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || state.st !== 'run') return;
      if (Date.now() >= state.endAt) fireDone();
      else renderClock();
    });
    window.addEventListener('focus', function () {
      if (state.st !== 'run') return;
      if (Date.now() >= state.endAt) fireDone();
      else renderClock();
    });

    // 恢复持久化状态
    load();
    if (state.st === 'idle') renderSet();
    else {
      renderRun();
      if (state.st === 'run') {
        startTick();
        // 若恢复时已经到点（例如打开页面时刚好超时）
        if (state.endAt <= Date.now()) fireDone();
      }
    }
  }

  global.Save4 = global.Save4 || {};
  global.Save4.timer = {
    init: init,
    start: start,
    pause: pause,
    resume: resume,
    extend5: extend5,
    stop: stop,
    getState: function () { return state.st; }
  };
})(window);
