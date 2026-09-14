/* ════════════════════════════════════════════════════════════
   Save4 — game.js  （桌面贪吃蛇）
   玩法：桌宠变成蛇头，桌面上真实文件的图标变成「豆」。
         方向键/WASD 转向，吃豆变长；吃完所有豆通关；撞墙或撞身体失败。
         ESC 退出（桌面文件与图标位置从未被修改，退出即原样）。

   结构：core（纯逻辑，可单测） + 渲染/输入/循环
   入口：右键菜单「🎮 桌面贪吃蛇」→ Save4.game.start()
   依赖：app.js 负责模式快照与恢复；desktop.js 负责关闭点击穿透并抢焦点
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var BEST_KEY = 'game.snake.best';

  var CELL = 40;            // 每格像素
  var BASE_MS = 150;        // 基础步进间隔
  var MIN_MS = 70;          // 最快间隔
  var RAMP_EVERY = 5;       // 每吃几颗提速一次
  var RAMP_STEP = 8;        // 每次提速的毫秒数
  var MAX_ICONS = 80;       // 最多取多少颗豆（限制加载时间）

  var els = {};
  var geo = null;           // { cols, rows, cell, offX, offY }
  var st = null;            // 游戏状态（core 的产物）
  var icons = [];           // 豆的图标池 [{icon, name}]
  var timer = null;
  var speed = BASE_MS;
  var running = false;
  var paused = false;
  var elapsedMs = 0;
  var lastTickAt = 0;
  var segNodes = [];        // 蛇身 DOM 复用池
  var audioCtx = null;

  /* ══════════════════════════════════════════════════════════
     一、纯核心逻辑（不碰 DOM，可在 Node 中单测）
     ══════════════════════════════════════════════════════════ */
  var core = {
    /* 建立初始状态：蛇在中央、朝右、长度 3 */
    makeState: function (cols, rows, total, rng) {
      rng = rng || Math.random;
      var cap = Math.max(1, cols * rows - 4);
      total = Math.max(1, Math.min(total, cap));
      var cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
      var state = {
        cols: cols, rows: rows,
        snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }],
        dir: { x: 1, y: 0 },
        pending: [],
        food: null,
        eaten: 0,
        total: total,
        alive: true,
        won: false,
        rng: rng
      };
      state.food = core.spawnFood(state);
      return state;
    },

    /* 在空格中随机放一颗豆（排除蛇身） */
    spawnFood: function (state) {
      var occ = {};
      state.snake.forEach(function (s) { occ[s.x + ',' + s.y] = 1; });
      var free = [];
      for (var y = 0; y < state.rows; y++) {
        for (var x = 0; x < state.cols; x++) {
          if (!occ[x + ',' + y]) free.push({ x: x, y: y });
        }
      }
      if (!free.length) return null;
      return free[Math.floor(state.rng() * free.length)];
    },

    /* 转向：禁止 180° 反向与重复同向；最多缓冲 2 次按键 */
    turn: function (state, dir) {
      if (!dir) return false;
      var last = state.pending.length ? state.pending[state.pending.length - 1] : state.dir;
      if (dir.x === -last.x && dir.y === -last.y) return false;   // 反向
      if (dir.x === last.x && dir.y === last.y) return false;     // 同向
      if (state.pending.length >= 2) return false;
      state.pending.push(dir);
      return true;
    },

    /* 走一步。返回事件名：move / eat / win / lose-wall / lose-self / none */
    step: function (state) {
      if (!state.alive || state.won) return 'none';
      if (state.pending.length) state.dir = state.pending.shift();

      var head = state.snake[0];
      var nx = head.x + state.dir.x;
      var ny = head.y + state.dir.y;

      if (nx < 0 || ny < 0 || nx >= state.cols || ny >= state.rows) {
        state.alive = false;
        return 'lose-wall';
      }

      var eating = !!(state.food && nx === state.food.x && ny === state.food.y);
      // 自撞判定：若不吃豆，尾巴本步会移开，故尾格不算障碍
      var limit = eating ? state.snake.length : state.snake.length - 1;
      for (var i = 0; i < limit; i++) {
        if (state.snake[i].x === nx && state.snake[i].y === ny) {
          state.alive = false;
          return 'lose-self';
        }
      }

      state.snake.unshift({ x: nx, y: ny });

      if (eating) {
        state.eaten++;
        if (state.eaten >= state.total) {
          state.won = true;
          state.food = null;
          return 'win';
        }
        state.food = core.spawnFood(state);
        return 'eat';
      }
      state.snake.pop();
      return 'move';
    },

    /* 当前速度（随吃豆数递增） */
    speedOf: function (eaten) {
      return Math.max(MIN_MS, BASE_MS - Math.floor(eaten / RAMP_EVERY) * RAMP_STEP);
    }
  };

  /* ══════════════════════════════════════════════════════════
     二、素材：蛇头用当前桌宠皮肤；豆用真实桌面文件图标
     ══════════════════════════════════════════════════════════ */
  /* 几何小猫皮肤的头部（内联 SVG，颜色与页面一致） */
  function catHeadUrl() {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
      + '<polygon points="34,34 40,8 58,26" fill="#f9c877" stroke="#5c4132" stroke-width="4" stroke-linejoin="round"/>'
      + '<polygon points="86,34 80,8 62,26" fill="#f9c877" stroke="#5c4132" stroke-width="4" stroke-linejoin="round"/>'
      + '<polygon points="45,28 43.5,17 52,23" fill="#f58f7b"/>'
      + '<polygon points="75,28 76.5,17 68,23" fill="#f58f7b"/>'
      + '<circle cx="60" cy="56" r="32" fill="#f9c877" stroke="#5c4132" stroke-width="4"/>'
      + '<ellipse cx="47" cy="55" rx="4.2" ry="6" fill="#3b2b22"/>'
      + '<ellipse cx="73" cy="55" rx="4.2" ry="6" fill="#3b2b22"/>'
      + '<path d="M55.5,64 L64.5,64 L60,70.5 Z" fill="#ef8f7c"/>'
      + '<path d="M52,69.5 q4,5.5 8,0 q4,5.5 8,0" fill="none" stroke="#3b2b22" stroke-width="3" stroke-linecap="round"/>'
      + '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* 按当前皮肤选蛇头图片 */
  function headImageUrl() {
    var key = S().read('ui.petSkin', 'cat');
    if (key === 'anime') return 'flipped_cut.png';
    if (key === 'liuge') return 'liuge.png';
    if (key === 'custom') {
      var p = S().read('skin.custom', null);
      if (p && p.dataUrl) return p.dataUrl;
    }
    return catHeadUrl();
  }

  /* 豆的图标：桌面版取真实文件图标；浏览器版退化为内置 emoji */
  var FALLBACK_ICONS = ['📄', '📁', '⭐', '🍎', '📌', '🎁', '🔔', '🍇', '💎', '🍒', '🧩', '📎'];

  function loadIcons() {
    var desk = global.Save4Desktop;
    if (desk && desk.isDesktop && desk.listDesktopIcons) {
      return desk.listDesktopIcons().then(function (list) {
        var arr = (list || []).filter(function (x) { return x && x.name; })
          .slice(0, MAX_ICONS)
          .map(function (x) { return { name: x.name, icon: x.icon || '' }; });
        return arr.length ? arr : fallbackIcons();
      }).catch(function () { return fallbackIcons(); });
    }
    return Promise.resolve(fallbackIcons());
  }

  function fallbackIcons() {
    var out = [];
    for (var i = 0; i < 10; i++) {
      out.push({ name: '豆 ' + (i + 1), icon: '', emoji: FALLBACK_ICONS[i % FALLBACK_ICONS.length] });
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════
     三、音效（WebAudio，无外部资源）
     ══════════════════════════════════════════════════════════ */
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* 音频不可用则静默 */ }
  }
  function beep(freq, dur, type) {
    if (!audioCtx) return;
    try {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.07, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (dur || 0.09));
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + (dur || 0.09) + 0.02);
    } catch (e) { /* 忽略 */ }
  }

  /* ══════════════════════════════════════════════════════════
     四、布局与渲染
     ══════════════════════════════════════════════════════════ */
  function layout() {
    var W = window.innerWidth, H = window.innerHeight;
    var cell = CELL;
    var cols = Math.max(8, Math.floor((W - 24) / cell));
    var rows = Math.max(6, Math.floor((H - 96) / cell));
    var bw = cols * cell, bh = rows * cell;
    var offX = Math.round((W - bw) / 2);
    var offY = Math.round((H - bh) / 2) + 8;
    els.board.style.left = offX + 'px';
    els.board.style.top = offY + 'px';
    els.board.style.width = bw + 'px';
    els.board.style.height = bh + 'px';
    geo = { cols: cols, rows: rows, cell: cell, offX: offX, offY: offY };
    return geo;
  }

  function placeAt(el, x, y) {
    el.style.transform = 'translate(' + (x * geo.cell) + 'px,' + (y * geo.cell) + 'px)';
  }

  function setTransition(ms) {
    var t = 'transform ' + ms + 'ms linear';
    els.head.style.transition = t;
    els.food.style.transition = 'transform ' + ms + 'ms linear, opacity .15s';
    segNodes.forEach(function (n) { n.style.transition = t; });
  }

  function paint() {
    if (!st || !geo) return;
    // 蛇头
    placeAt(els.head, st.snake[0].x, st.snake[0].y);
    // 蛇身
    var bodyLen = st.snake.length - 1;
    while (segNodes.length < bodyLen) {
      var d = document.createElement('div');
      d.className = 'seg';
      els.board.appendChild(d);
      segNodes.push(d);
    }
    for (var i = 0; i < segNodes.length; i++) {
      var node = segNodes[i];
      if (i < bodyLen) {
        node.style.display = '';
        placeAt(node, st.snake[i + 1].x, st.snake[i + 1].y);
      } else {
        node.style.display = 'none';
      }
    }
    // 豆
    if (st.food) {
      els.food.style.display = '';
      placeAt(els.food, st.food.x, st.food.y);
      paintFoodIcon();
    } else {
      els.food.style.display = 'none';
    }
    paintHud();
  }

  /* 当前豆显示第 eaten 号图标（吃掉后自动换成下一个） */
  function paintFoodIcon() {
    var item = icons[st.eaten % icons.length];
    if (!item) return;
    if (item.icon) {
      els.foodImg.src = item.icon;
      els.foodImg.style.display = '';
      els.foodEmoji.style.display = 'none';
    } else {
      els.foodEmoji.textContent = item.emoji || '🍎';
      els.foodEmoji.style.display = '';
      els.foodImg.style.display = 'none';
    }
    els.food.title = item.name || '';
  }

  function paintHud() {
    if (!st) return;
    els.score.textContent = st.eaten;
    els.remain.textContent = Math.max(0, st.total - st.eaten);
    els.time.textContent = fmtTime(elapsedMs);
    els.best.textContent = S().read(BEST_KEY, 0);
    els.pauseHint.textContent = paused ? '⏸ 已暂停（空格继续）' : '';
  }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  /* ══════════════════════════════════════════════════════════
     五、循环与控制
     ══════════════════════════════════════════════════════════ */
  function schedule() {
    if (timer) clearInterval(timer);
    speed = core.speedOf(st ? st.eaten : 0);
    setTransition(speed);
    timer = setInterval(tick, speed);
  }

  function tick() {
    if (!running || paused || !st) return;
    var now = Date.now();
    elapsedMs += now - lastTickAt;
    lastTickAt = now;

    var ev = core.step(st);
    if (ev === 'eat') { ensureAudio(); beep(880, 0.08); schedule(); }
    else if (ev === 'win') { finish(true); return; }
    else if (ev === 'lose-wall' || ev === 'lose-self') { finish(false, ev); return; }
    paint();
  }

  function finish(won, reason) {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    var best = S().read(BEST_KEY, 0);
    if (st.eaten > best) { S().write(BEST_KEY, st.eaten); best = st.eaten; }
    if (won) { ensureAudio(); beep(660, 0.12); setTimeout(function () { beep(990, 0.18); }, 130); }
    else { ensureAudio(); beep(200, 0.3, 'sawtooth'); }

    els.over.classList.remove('hidden');
    els.overTitle.textContent = won ? '🎉 通关！吃光了所有图标' : '💥 游戏失败';
    els.overSub.textContent = won
      ? '你把桌面上的图标全吃完了'
      : (reason === 'lose-self' ? '撞到了自己的身体' : '撞到了屏幕边缘');
    els.overStats.innerHTML = '吃到 <b>' + st.eaten + '</b> / ' + st.total + ' 颗'
      + ' · 用时 <b>' + fmtTime(elapsedMs) + '</b> · 最高 <b>' + best + '</b>';
    paintHud();
  }

  function togglePause(force) {
    if (!running) return;
    paused = (force === undefined) ? !paused : !!force;
    if (!paused) lastTickAt = Date.now();
    paintHud();
  }

  var DIRS = {
    ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
    w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
    W: { x: 0, y: -1 }, S: { x: 0, y: 1 }, A: { x: -1, y: 0 }, D: { x: 1, y: 0 }
  };

  function onKey(e) {
    // ESC 只在游戏进行中生效，避免非游戏状态下误触发退出/恢复流程
    if (e.key === 'Escape') {
      if (running) { e.preventDefault(); quit(); }
      return;
    }
    if (!running) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); return; }
    var d = DIRS[e.key];
    if (d && st && st.alive && !st.won) {
      e.preventDefault();
      ensureAudio();
      core.turn(st, d);
    }
  }

  /* ══════════════════════════════════════════════════════════
     六、开始 / 退出
     ══════════════════════════════════════════════════════════ */
  function countdown(done) {
    var n = 3;
    els.count.classList.remove('hidden');
    function show() {
      if (n > 0) {
        els.count.textContent = String(n);
        beep(520, 0.08);
        n--;
        setTimeout(show, 620);
      } else {
        els.count.textContent = '开始!';
        beep(880, 0.14);
        setTimeout(function () {
          els.count.classList.add('hidden');
          done();
        }, 420);
      }
    }
    show();
  }

  function start() {
    if (running) return;
    els.over.classList.add('hidden');
    els.pauseHint.textContent = '加载图标中…';
    els.head.style.backgroundImage = 'url("' + headImageUrl() + '")';
    layout();

    loadIcons().then(function (list) {
      icons = list;
      st = core.makeState(geo.cols, geo.rows, icons.length);
      segNodes.forEach(function (n) { n.remove(); });
      segNodes = [];
      elapsedMs = 0;
      paused = false;
      running = true;
      paint();
      // 吸附到当前皮肤；游戏期间窗口需要键盘焦点
      if (global.Save4.desktop && global.Save4.desktop.focusWindow) {
        global.Save4.desktop.focusWindow();
      }
      countdown(function () {
        lastTickAt = Date.now();
        schedule();
      });
    });
  }

  function quit() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    els.over.classList.add('hidden');
    els.count.classList.add('hidden');
    els.pauseHint.textContent = '';
    segNodes.forEach(function (n) { n.remove(); });
    segNodes = [];
    st = null;
    if (global.Save4.app && global.Save4.app.endGame) global.Save4.app.endGame();
  }

  /* ══════════════════════════════════════════════════════════
     七、初始化
     ══════════════════════════════════════════════════════════ */
  function init() {
    els.root = document.getElementById('game');
    els.board = document.getElementById('game-board');
    els.head = document.getElementById('game-head');
    els.food = document.getElementById('game-food');
    els.foodImg = document.getElementById('game-food-img');
    els.foodEmoji = document.getElementById('game-food-emoji');
    els.score = document.getElementById('game-score');
    els.remain = document.getElementById('game-remain');
    els.time = document.getElementById('game-time');
    els.best = document.getElementById('game-best');
    els.pauseHint = document.getElementById('game-pause-hint');
    els.count = document.getElementById('game-count');
    els.over = document.getElementById('game-over');
    els.overTitle = document.getElementById('game-over-title');
    els.overSub = document.getElementById('game-over-sub');
    els.overStats = document.getElementById('game-over-stats');

    if (!els.root || !els.board) return;

    document.getElementById('game-exit').addEventListener('click', quit);
    document.getElementById('game-pause').addEventListener('click', function () { togglePause(); });
    document.getElementById('game-retry').addEventListener('click', function () {
      els.over.classList.add('hidden');
      running = false;
      start();
    });
    document.getElementById('game-quit').addEventListener('click', quit);

    document.addEventListener('keydown', onKey);
    // 失焦自动暂停，避免“点开别的窗口后蛇还在跑”
    window.addEventListener('blur', function () { togglePause(true); });
    window.addEventListener('resize', function () {
      if (!running) return;
      togglePause(true);
      layout();
      st = core.makeState(geo.cols, geo.rows, st.total);
      segNodes.forEach(function (n) { n.remove(); });
      segNodes = [];
      paint();
    });
  }

  global.Save4 = global.Save4 || {};
  global.Save4.game = {
    init: init,
    start: start,
    quit: quit,
    core: core,            // 暴露纯逻辑便于测试
    isRunning: function () { return running; },
    _catHeadUrl: catHeadUrl
  };
})(window);
