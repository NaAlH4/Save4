/* ════════════════════════════════════════════════════════════
   Save4 — desktop.js  （Electron 桌面桥接，浏览器中自动失效）
   1. 覆盖层点击穿透：鼠标悬停在交互区(#pet/#panel/#strip/
      #tray/#menu/气泡/对话框)时关闭穿透，离开则恢复穿透；
      拖拽过程中强制可交互，避免拖到半路被桌面“抢走”指针。
   2. 托盘恢复/窗口可见性事件 → 通知 app.js 切模式。
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var desk = global.Save4Desktop;
  if (!desk || !desk.isDesktop) return; // 普通浏览器：本模块不生效

  document.documentElement.classList.add('electron');
  if (desk.overlay) document.documentElement.classList.add('electron-overlay');

  var INTERACTIVE = '#pet, #panel, #strip, #tray, #menu, #bubble, #chat, dialog';
  var dragging = false;
  var lastInteractive = null;
  var windowVisible = true;
  var forceInteractive = false;   // 游戏期间强制整屏可交互

  function hitInteractive(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return false;
    return !!el.closest(INTERACTIVE);
  }

  function sync(e) {
    if (!desk.overlay) return;
    var interactive = forceInteractive || dragging || hitInteractive(e);
    if (interactive !== lastInteractive) {
      lastInteractive = interactive;
      desk.setInteractive(interactive);
    }
  }

  // 拖拽开始/结束期间强制可交互
  document.addEventListener('pointerdown', function (e) {
    if (e.target && e.target.closest && e.target.closest(INTERACTIVE)) {
      dragging = true;
      lastInteractive = true;
      desk.setInteractive(true);
    }
  }, true);
  document.addEventListener('pointerup', function () {
    dragging = false;
    lastInteractive = null; // 交给下一次 pointermove 重新判定
  }, true);

  document.addEventListener('pointermove', sync, { passive: true });

  // 主进程事件：托盘恢复 / 窗口可见性
  desk.onRestore(function () {
    if (global.Save4 && global.Save4.app && global.Save4.app.restoreFromTray) {
      global.Save4.app.restoreFromTray();
    }
  });
  desk.onVisibility(function (v) {
    windowVisible = !!v;
  });

  global.Save4 = global.Save4 || {};
  global.Save4.desktop = {
    windowVisible: function () { return windowVisible; },
    /* 游戏期间：整屏可交互（否则键盘/鼠标事件会被穿透到桌面） */
    setForceInteractive: function (v) {
      forceInteractive = !!v;
      lastInteractive = forceInteractive ? true : null;
      desk.setInteractive(forceInteractive);
    },
    /* 抢窗口焦点，保证方向键能进来 */
    focusWindow: function () {
      if (desk.gameFocus) desk.gameFocus();
      try { window.focus(); } catch (e) {}
    }
  };
})(window);
