/* ════════════════════════════════════════════════════════════
   Save4 — drag.js  （M1 基座模块）
   通用「拖拽移动 / 拖角缩放」引擎（Pointer Events，PC/触屏通用）。
   - 拖拽: makeDraggable(el, { handle, clamp, onMove, onEnd })
   - 缩放: makeResizable(el, handle, { minW, maxW, minH, maxH, lockSquare, onEnd })
   元素通过 style.left/top + style.width/height 定位，位置由调用方持久化。
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var DRAG_EV = { x: 0, y: 0 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ---------- 拖拽移动 ---------- */
  function makeDraggable(el, opts) {
    opts = opts || {};
    var handle = opts.handle || el;
    var active = false;
    var startX = 0, startY = 0, baseX = 0, baseY = 0;

    function pointerDown(e) {
      // 仅响应主键（鼠标左键/触摸），右键留给菜单
      if (typeof e.button === 'number' && e.button !== 0) return;
      // 忽略从 .no-drag 交互子元素发起的拖拽
      if (e.target && e.target.closest && e.target.closest('.no-drag')) return;
      // 忽略 opts.ignore 指定区域内的点击（如模式按钮/文本框等需正常交互）
      if (opts.ignore && e.target && e.target.closest && e.target.closest(opts.ignore)) return;
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      var cs = getComputedStyle(el);
      baseX = parseFloat(cs.left) || el.getBoundingClientRect().left;
      baseY = parseFloat(cs.top) || el.getBoundingClientRect().top;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      el.classList.add('dragging');
      if (opts.onStart) opts.onStart(e);
      e.preventDefault();
    }

    function pointerMove(e) {
      if (!active) return;
      var x = baseX + (e.clientX - startX);
      var y = baseY + (e.clientY - startY);
      if (opts.clamp !== false) {
        x = clamp(x, 0, Math.max(0, window.innerWidth - el.offsetWidth));
        y = clamp(y, 0, Math.max(0, window.innerHeight - el.offsetHeight));
      }
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      if (opts.onMove) opts.onMove(x, y);
    }

    function pointerEnd(e) {
      if (!active) return;
      active = false;
      el.classList.remove('dragging');
      if (opts.onEnd) opts.onEnd(parseFloat(el.style.left), parseFloat(el.style.top));
    }

    handle.addEventListener('pointerdown', pointerDown);
    handle.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
  }

  /* ---------- 拖角缩放（锚点固定在元素左上角） ----------
     opts:
       lockSquare : true → 宽=高（方形）
       ratioOf    : function → 返回当前宽高比(宽/高)，非 null 时按比例缩放
       minW/maxW/minH/maxH 为尺寸下限/上限 */
  function makeResizable(el, handle, opts) {
    opts = opts || {};
    var active = false;
    var startX = 0, startY = 0, baseW = 0, baseH = 0, ratio = null;

    function down(e) {
      e.stopPropagation();
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      baseW = el.offsetWidth;
      baseH = el.offsetHeight;
      // 动态取比例：优先 ratioOf 回调（皮肤相关），否则 lockSquare=1
      ratio = opts.ratioOf ? opts.ratioOf() : null;
      if (ratio == null && opts.lockSquare) ratio = 1;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      handle.classList.add('resizing');
      e.preventDefault();
    }

    function move(e) {
      if (!active) return;
      var dw = e.clientX - startX;
      var dh = e.clientY - startY;
      var w = clamp(Math.round(baseW + dw), opts.minW || 80, opts.maxW || 800);
      var h;
      if (ratio != null) {
        h = Math.round(w / ratio); // 按比例伸缩
        h = clamp(h, opts.minH || 60, opts.maxH || 1000);
        w = Math.round(h * ratio); // 回算宽度，保证精确比例
      } else {
        h = clamp(Math.round(baseH + dh), opts.minH || 80, opts.maxH || 800);
      }
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      if (opts.onResize) opts.onResize(w, h);
    }

    function up() {
      if (!active) return;
      active = false;
      handle.classList.remove('resizing');
      if (opts.onEnd) opts.onEnd(el.offsetWidth, el.offsetHeight);
    }

    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  global.Save4 = global.Save4 || {};
  global.Save4.drag = {
    makeDraggable: makeDraggable,
    makeResizable: makeResizable,
    clamp: clamp
  };
})(window);
