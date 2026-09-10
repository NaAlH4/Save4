/* ════════════════════════════════════════════════════════════
   Save4 — journal.js  （日记 / 随笔模块）
   目标：零摩擦地「快速开写」，并随时回看。
   - 自动保存（输入停顿即存），无需手动点保存
   - 打开日记页：若今天已写过则接着写，否则是一张空白页
   - 全部日记：按时间倒序 + 关键词搜索 + 单条删除
   存储：localStorage（key: journal.entries），随「数据导出/导入」一起备份迁移
   数据结构：[{ id, createdAt, updatedAt, content }]
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var KEY = 'journal.entries';
  var AUTOSAVE_MS = 700;

  var els = {};
  var currentId = null;   // 正在编辑的日记 id（null = 新日记）
  var saveTimer = null;

  /* ---------- 数据层 ---------- */
  function load() {
    var list = S().read(KEY, []);
    return Array.isArray(list) ? list : [];
  }
  function persist(list) { return S().write(KEY, list); }
  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function byId(id) {
    return load().find(function (e) { return e.id === id; }) || null;
  }

  /* ---------- 小工具 ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(iso) {           // 2026/9/10 周三
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' 周' + wk;
  }
  function fmtTime(iso) {           // 14:32
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtShort(iso) {          // 9/10 14:32
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + fmtTime(iso);
  }
  function isSameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() &&
           x.getMonth() === y.getMonth() &&
           x.getDate() === y.getDate();
  }
  function titleOf(content) {
    var line = String(content || '').split('\n').map(function (l) { return l.trim(); })
                 .filter(Boolean)[0] || '';
    return line.slice(0, 30) || '（空白）';
  }
  function excerptOf(content) {
    var t = String(content || '').replace(/\s+/g, ' ').trim();
    return t.length > 46 ? t.slice(0, 46) + '…' : t;
  }
  function countOf(content) {
    return String(content || '').replace(/\s/g, '').length;
  }

  /* ---------- 视图切换 ---------- */
  function showEditor() {
    els.editor.classList.remove('hidden');
    els.listView.classList.add('hidden');
  }
  function showList() {
    els.listView.classList.remove('hidden');
    els.editor.classList.add('hidden');
    renderList(els.search ? els.search.value : '');
  }

  /* ---------- 编辑器 ---------- */
  function setStatus(text) {
    if (els.status) els.status.textContent = text || '';
  }
  function refreshMeta() {
    if (els.count) els.count.textContent = countOf(els.text.value) + ' 字';
  }
  function openNew() {
    currentId = null;
    els.text.value = '';
    els.date.textContent = fmtDate(Date.now()) + ' · 新日记';
    setStatus('想到什么写什么，会自动保存');
    refreshMeta();
    showEditor();
    els.text.focus();
  }
  function openEntry(id) {
    var e = byId(id);
    if (!e) return;
    currentId = e.id;
    els.text.value = e.content || '';
    els.date.textContent = fmtDate(e.createdAt);
    setStatus('已保存 ' + fmtTime(e.updatedAt));
    refreshMeta();
    showEditor();
    els.text.focus();
  }
  /* 打开日记页：今天写过就接着写，否则新建 */
  function openLatestOrNew() {
    var list = load();
    var today = Date.now();
    var entry = list.filter(function (e) { return isSameDay(e.createdAt, today); })
                    .sort(function (a, b) { return b.updatedAt - a.updatedAt; })[0];
    if (entry) openEntry(entry.id); else openNew();
  }

  /* 保存当前编辑内容；空内容不落库，避免产生空白日记 */
  function save(silent) {
    var content = els.text.value;
    if (!content.trim()) {
      if (!silent) setStatus('内容为空，未保存');
      return false;
    }
    var list = load();
    var now = Date.now();   // 数值时间戳：便于排序比较（ISO 字符串相减会得 NaN）
    if (currentId) {
      var idx = list.findIndex(function (e) { return e.id === currentId; });
      if (idx >= 0) {
        list[idx].content = content;
        list[idx].updatedAt = now;
      } else {
        currentId = null; // 意外丢失，走新建
      }
    }
    if (!currentId) {
      var item = { id: makeId(), createdAt: now, updatedAt: now, content: content };
      list.push(item);
      currentId = item.id;
      els.date.textContent = fmtDate(item.createdAt);
    }
    var ok = persist(list);
    setStatus(ok ? ('已保存 ' + fmtTime(now)) : '保存失败（存储空间可能已满）');
    return ok;
  }

  function scheduleSave() {
    refreshMeta();
    setStatus('输入中…');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; save(true); }, AUTOSAVE_MS);
  }
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; save(true); }
  }

  /* ---------- 列表 ---------- */
  function renderList(filter) {
    var list = load().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    var q = String(filter || '').trim().toLowerCase();
    if (q) {
      list = list.filter(function (e) {
        return String(e.content || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    els.entries.innerHTML = '';
    if (!list.length) {
      els.entries.innerHTML = '<div class="journal-empty dim">'
        + (q ? '没有匹配的日记' : '还没有日记，回到编辑页写下第一篇吧～') + '</div>';
      return;
    }
    list.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'journal-row';
      row.dataset.id = e.id;

      var main = document.createElement('div');
      main.className = 'journal-row-main';
      var t = document.createElement('div');
      t.className = 'journal-row-title';
      t.textContent = titleOf(e.content);
      var ex = document.createElement('div');
      ex.className = 'journal-row-excerpt';
      ex.textContent = excerptOf(e.content);
      main.appendChild(t);
      main.appendChild(ex);

      var meta = document.createElement('div');
      meta.className = 'journal-row-meta';
      meta.textContent = fmtShort(e.updatedAt) + ' · ' + countOf(e.content) + ' 字';

      var del = document.createElement('button');
      del.className = 'journal-row-del';
      del.textContent = '✕';
      del.title = '删除这篇日记';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!window.confirm('确定删除这篇日记吗？此操作不可恢复。')) return;
        var rest = load().filter(function (x) { return x.id !== e.id; });
        persist(rest);
        if (currentId === e.id) openNew();
        renderList(els.search ? els.search.value : '');
      });

      row.appendChild(main);
      row.appendChild(meta);
      row.appendChild(del);
      row.addEventListener('click', function () { openEntry(e.id); });
      els.entries.appendChild(row);
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    els.editor = document.getElementById('journal-editor');
    els.listView = document.getElementById('journal-list-view');
    els.text = document.getElementById('journal-text');
    els.date = document.getElementById('journal-date');
    els.status = document.getElementById('journal-status');
    els.count = document.getElementById('journal-count');
    els.entries = document.getElementById('journal-entries');
    els.search = document.getElementById('journal-search');

    els.text.addEventListener('input', scheduleSave);
    els.text.addEventListener('blur', flush);
    els.text.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); }
    });

    document.getElementById('journal-new').addEventListener('click', function () {
      flush(); openNew();
    });
    document.getElementById('journal-list-btn').addEventListener('click', function () {
      flush(); showList();
    });
    document.getElementById('journal-back').addEventListener('click', function () {
      openLatestOrNew();
    });
    els.search.addEventListener('input', function () { renderList(els.search.value); });

    // 关闭页面前落盘，避免丢字
    window.addEventListener('beforeunload', flush);

    openLatestOrNew();
  }

  global.Save4 = global.Save4 || {};
  global.Save4.journal = {
    init: init,
    // 快速开写：外部入口（工具条/右键菜单）调用
    quickWrite: function () { flush(); openNew(); },
    openJournal: function () { flush(); openLatestOrNew(); },
    flush: flush,
    count: function () { return load().length; }
  };
})(window);
