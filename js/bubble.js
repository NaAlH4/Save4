/* ════════════════════════════════════════════════════════════
   Save4 — bubble.js  （公共气泡模块）
   统一的「气泡」能力，供待办提醒(reminder.js)、定时器到点(timer.js)共用。
   - 队列串行弹出（不会互相覆盖）
   - 支持动作按钮（如定时器到点: 延长5分钟 / 结束）
   - 普通消息默认 7s 自动收起；sticky 消息需手动/点按钮关闭
   用法:
     Save4.bubble.enqueue({ text:'...', actions:[{label, onClick}], sticky:false })
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var queue = [];
  var showing = false;
  var hideTimer = null;
  var currentActions = [];

  var bubbleEl, textEl, actionsEl;

  function position() {
    if (!bubbleEl) return;
    var petEl = document.getElementById('pet');
    var rect = petEl.getBoundingClientRect();
    var bw = bubbleEl.offsetWidth;
    var x = rect.left + rect.width / 2 - bw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    bubbleEl.style.left = x + 'px';
    bubbleEl.style.top = Math.max(8, rect.top - bubbleEl.offsetHeight - 12) + 'px';
  }

  function clearActions() {
    currentActions = [];
    if (actionsEl) actionsEl.innerHTML = '';
  }

  function renderActions(actions) {
    clearActions();
    if (!actions || !actions.length) return;
    currentActions = actions;
    actions.forEach(function (a) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bubble-btn' + (a.primary ? ' primary' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', function () {
        if (typeof a.onClick === 'function') a.onClick();
        dismiss();
      });
      actionsEl.appendChild(btn);
    });
  }

  function show(item) {
    showing = true;
    textEl.textContent = item.text;
    bubbleEl.classList.remove('hidden');
    renderActions(item.actions || []);

    // 高度可能因按钮变化，先定位再重定位一次
    position();
    bubbleEl.classList.remove('pop');
    void bubbleEl.offsetWidth;
    bubbleEl.classList.add('pop');

    if (typeof item.onShow === 'function') item.onShow();

    if (!item.sticky) {
      hideTimer = setTimeout(hide, item.duration || 7000);
    }
  }

  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    bubbleEl.classList.add('hidden');
    clearActions();
    showing = false;
    next();
  }

  function next() {
    if (queue.length && !showing) {
      var item = queue.shift();
      show(item);
    }
  }

  /* ---------- 对外 ---------- */
  function enqueue(item) {
    queue.push(item);
    next();
  }

  function dismiss() {
    if (showing) hide();
  }

  function init() {
    bubbleEl = document.getElementById('bubble');
    textEl = document.getElementById('bubble-text');
    actionsEl = document.getElementById('bubble-actions');
    document.getElementById('bubble-close').addEventListener('click', dismiss);

    // 面板/桌宠被拖动时气泡跟随重定位
    window.addEventListener('resize', function () { if (showing) position(); });
  }

  global.Save4 = global.Save4 || {};
  global.Save4.bubble = {
    init: init,
    enqueue: enqueue,
    dismiss: dismiss,
    isShowing: function () { return showing; }
  };
})(window);
