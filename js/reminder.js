/* ════════════════════════════════════════════════════════════
   Save4 — reminder.js  （M3 提醒调度模块）
   每 6 秒扫描一次待办，到点通过公共气泡(bubble.js)提醒。
   - 一次性: 触发后 remindAt 置空
   - daily/weekly: 触发后自动顺延到下一个周期
   - 过期超过 24h 的单次提醒静默清除（不翻旧账）；
     周期提醒过期超过 24h 也直接顺延（避免补发一堆旧提醒）
   - 桌面版(Electron)窗口隐藏时 → 系统原生通知并唤醒窗口
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var K = S().KEYS;
  var ONE_DAY = 24 * 3600 * 1000;
  var TICK = 6000;

  /* ---------- 周期顺延 ---------- */
  function advance(t) {
    var d = new Date(t.remindAt);
    if (t.repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (t.repeat === 'weekly') d.setDate(d.getDate() + 7);
    t.remindAt = d.getTime();
  }

  /* ---------- 扫描到点待办 ---------- */
  function scan() {
    var now = Date.now();
    var todos = global.Save4.todos;
    var due = todos.getAll().filter(function (t) {
      if (t.done || !t.remindAt) return false;
      if (t.remindAt > now) return false;
      return true;
    }).sort(function (a, b) { return a.remindAt - b.remindAt; });

    if (!due.length) return;

    // 桌面(Electron)判定：窗口在系统托盘隐藏中？
    var desktop = global.Save4Desktop;
    var desktopHidden = !!(desktop && desktop.isDesktop &&
      global.Save4.desktop && !global.Save4.desktop.windowVisible());

    // 网页版：若处于页面托盘态，先恢复为「仅形象」以便看到气泡
    if (document.body.getAttribute('data-mode') === 'hidden' && !desktopHidden) {
      if (global.Save4.app) global.Save4.app.setMode('pet');
    }

    var pendingTexts = [];
    due.forEach(function (t) {
      var overdue = now - t.remindAt;
      var isRepeat = t.repeat && t.repeat !== 'none';

      if (overdue > ONE_DAY) {
        if (isRepeat) {
          do { advance(t); } while (t.remindAt <= now);
          todos.updateTodo(t.id, { remindAt: t.remindAt });
        } else {
          todos.updateTodo(t.id, { remindAt: null });
        }
        return;
      }

      var label = (isRepeat ? '[' + (t.repeat === 'daily' ? '每天' : '每周') + '] ' : '') + t.text;
      pendingTexts.push('🔔 ' + label);

      if (isRepeat) {
        do { advance(t); } while (t.remindAt <= now);
        todos.updateTodo(t.id, { remindAt: t.remindAt });
      } else {
        todos.updateTodo(t.id, { remindAt: null });
      }
      S().write(K.LAST_FIRED, new Date().toISOString());
    });

    if (!pendingTexts.length) return;
    todos.syncSummary();

    // 桌面版窗口藏在托盘 → 系统通知 + 唤醒（不弹页面气泡）
    if (desktopHidden && desktop.reminderHit) {
      desktop.reminderHit(pendingTexts.join('｜'));
      return;
    }

    // 页面气泡（多到点时逐条入队）
    pendingTexts.forEach(function (text) {
      global.Save4.bubble.enqueue({
        text: text,
        onShow: function () {
          if (global.Save4.pet) global.Save4.pet.celebrate(1400);
        }
      });
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    setInterval(scan, TICK);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scan();
    });
    window.addEventListener('focus', scan);
    setTimeout(scan, 800); // 启动后补扫一次
  }

  global.Save4 = global.Save4 || {};
  global.Save4.reminder = { init: init, scan: scan };
})(window);
