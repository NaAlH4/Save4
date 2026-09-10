/* ════════════════════════════════════════════════════════════
   Save4 — storage.js  （M1 基座模块）
   localStorage 封装：所有持久化走 Save4.store，
   key 形如 "pet.geo" / "panel.geo" / "ui.*"（统一前缀 save4.）。
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var PREFIX = 'save4.';

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.warn('[Save4] 读取失败', key, e);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('[Save4] 写入失败', key, e);
      return false;
    }
  }

  // 常用键（集中管理，避免散落字符串）
  var KEYS = {
    PET_GEO: 'pet.geo',        // {x,y,w,h} 桌宠位置与尺寸
    PANEL_GEO: 'panel.geo',    // {x,y,w,h} 面板位置与尺寸
    MODE: 'ui.mode',           // 'full' | 'pet' | 'hidden'
    STRIP_CONTENT: 'ui.stripContent', // 'todos' | 'recent' | 'time'
    TODOS: 'todos.list',       // 待办数组（M3）
    LAST_FIRED: 'ui.lastFired', // 最近一次提醒触发的 ISO 时间（M3）
    TIMER: 'ui.timer',         // 定时器状态（M4）
    SKIN: 'ui.petSkin',        // 桌宠皮肤: 'cat' | 'anime' | 'liuge'（M4/皮肤）
    CHAT_GEO: 'chat.geo'       // AI 对话窗口位置与尺寸（M5）
  };

  global.Save4 = global.Save4 || {};
  global.Save4.store = { read: read, write: write, KEYS: KEYS };
})(window);
