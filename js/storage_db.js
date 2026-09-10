/* ════════════════════════════════════════════════════════════
   Save4 — storage_db.js  （IndexedDB 封装：AI 存储专用，M5）
   文档要求: AI 完整对话历史 / 长期记忆摘要 / 用户特质画像 → IndexedDB
   - 若 IndexedDB 不可用（极少见）或异常，自动降级为 localStorage
   - 统一 async API，供 chat.js 使用
   库: save4_ai / 版本:1 / 表 conversations: { id, title, date, mode, summary, messages[] }
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var DB_NAME = 'save4_ai';
  var DB_VER = 1;
  var STORE = 'conversations';
  var FB_KEY = 'save4.ai.conversations';

  var dbPromise = null;
  var useFallback = false;

  /* ---------- 降级: localStorage ---------- */
  function fbRead() {
    try { var raw = localStorage.getItem(FB_KEY); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }
  function fbWrite(list) { try { localStorage.setItem(FB_KEY, JSON.stringify(list)); } catch (e) {} }

  /* ---------- 打开 IndexedDB ---------- */
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function () { useFallback = true; resolve(null); };
        req.onblocked = function () { useFallback = true; resolve(null); };
      } catch (err) {
        useFallback = true;
        resolve(null);
      }
    });
    return dbPromise;
  }

  /* ---------- 对外 API ---------- */
  var db = {
    usingIDB: function () { return !useFallback; },

    list: function () {
      return open().then(function (d) {
        if (!d) return fbRead();
        return new Promise(function (resolve) {
          var req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          req.onsuccess = function () {
            var arr = req.result || [];
            arr.sort(function (a, b) { return (b.date || 0) - (a.date || 0); });
            resolve(arr);
          };
          req.onerror = function () { resolve([]); };
        });
      });
    },

    get: function (id) {
      return open().then(function (d) {
        if (!d) {
          return Promise.resolve(fbRead().find(function (c) { return c.id === id; }) || null);
        }
        return new Promise(function (resolve) {
          var req = d.transaction(STORE, 'readonly').objectStore(STORE).get(id);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        });
      });
    },

    save: function (item) {
      return open().then(function (d) {
        if (!d) {
          var list = fbRead();
          var idx = list.findIndex(function (c) { return c.id === item.id; });
          if (idx >= 0) list[idx] = item; else list.unshift(item);
          fbWrite(list);
          return Promise.resolve();
        }
        return new Promise(function (resolve, reject) {
          var tx = d.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(item);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(new Error('save failed')); };
        });
      });
    },

    remove: function (id) {
      return open().then(function (d) {
        if (!d) {
          fbWrite(fbRead().filter(function (c) { return c.id !== id; }));
          return Promise.resolve();
        }
        return new Promise(function (resolve, reject) {
          var tx = d.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(id);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(new Error('remove failed')); };
        });
      });
    }
  };

  global.Save4 = global.Save4 || {};
  global.Save4.db = db;
})(window);
