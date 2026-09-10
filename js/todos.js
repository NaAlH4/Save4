/* ════════════════════════════════════════════════════════════
   Save4 — todos.js  （M3 备忘录模块）
   待办数据模型 + 增删改 + 完成标记 + 渲染。
   每条待办:
   {
     id:        string
     text:      string           事项内容
     done:      boolean          是否完成
     remindAt:  number|null     下次提醒时间戳(ms)，null=不提醒
     repeat:    'none'|'daily'|'weekly'   重复规则
     createdAt: number           创建时间戳
   }
   提醒触发与周期顺延逻辑在 reminder.js（本模块不负责到点动作）。
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var K = S().KEYS;

  var listEl, formEl, textEl, timeEl, repeatEl, emptyEl;
  var list = [];
  var editingId = null; // 正在编辑的待办 id

  /* ---------- 小工具 ---------- */
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ms -> 'YYYY-MM-DDTHH:mm'（datetime-local 需要）
  function msToLocalInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ms -> '周一 15:00' 风格
  function msToHuman(ms) {
    var d = new Date(ms);
    return '周' + WEEK[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function parseInputToMs(v) {
    if (!v) return null;
    var t = new Date(v).getTime();
    return isNaN(t) ? null : t;
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function load() {
    list = S().read(K.TODOS, []);
    if (!Array.isArray(list)) list = [];
  }
  function persist() { S().write(K.TODOS, list); }

  /* ---------- 对外数据操作 ---------- */
  function addTodo(data) {
    var todo = {
      id: makeId(),
      text: String(data.text || '').trim().slice(0, 120),
      done: false,
      remindAt: data.remindAt || null,
      repeat: data.repeat || 'none',
      createdAt: Date.now()
    };
    if (!todo.text) return null;
    list.unshift(todo);
    persist(); render();
    return todo;
  }

  function updateTodo(id, patch) {
    var t = find(id);
    if (!t) return null;
    if (patch.text !== undefined) t.text = String(patch.text).trim().slice(0, 120);
    if (patch.done !== undefined) t.done = !!patch.done;
    if (patch.remindAt !== undefined) t.remindAt = patch.remindAt;
    if (patch.repeat !== undefined) t.repeat = patch.repeat;
    persist(); render();
    return t;
  }

  function deleteTodo(id) {
    list = list.filter(function (t) { return t.id !== id; });
    if (editingId === id) editingId = null;
    persist(); render();
  }

  function toggleDone(id) {
    var t = find(id);
    if (!t) return;
    t.done = !t.done;
    persist(); render();
  }

  function find(id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function getAll() { return list.slice(); }

  /* ---------- 渲染 ---------- */
  function repeatLabel(t) {
    if (!t.remindAt) return '';
    var base = msToHuman(t.remindAt);
    if (t.repeat === 'daily') return '每天 ' + base.split(' ')[1];
    if (t.repeat === 'weekly') return '每周' + base;
    return base;
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = '';

    // 未完成在前（新->旧），已完成在后
    var sorted = list.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.createdAt - a.createdAt;
    });

    sorted.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'todo-row' + (t.done ? ' done' : '') + (t.id === editingId ? ' editing' : '');
      row.dataset.id = t.id;

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'todo-check';
      cb.checked = t.done;
      cb.title = t.done ? '标记未完成' : '标记完成';

      var main = document.createElement('div');
      main.className = 'todo-main';

      var txt = document.createElement('div');
      txt.className = 'todo-text';
      txt.textContent = t.text;

      var meta = document.createElement('div');
      meta.className = 'todo-meta';
      if (t.done) {
        meta.textContent = '已完成';
      } else if (t.remindAt) {
        var overdue = t.remindAt < Date.now();
        meta.innerHTML = '';
        if (overdue) {
          var warn = document.createElement('span');
          warn.className = 'overdue';
          warn.textContent = '⚠ 已过期 ';
          meta.appendChild(warn);
        }
        meta.appendChild(document.createTextNode(repeatLabel(t)));
      }
      main.appendChild(txt);
      if (meta.childNodes.length) main.appendChild(meta);

      var ops = document.createElement('div');
      ops.className = 'todo-ops';

      var editBtn = document.createElement('button');
      editBtn.className = 'tool-btn tiny';
      editBtn.textContent = '✎';
      editBtn.title = '编辑';
      editBtn.dataset.op = 'edit';

      var delBtn = document.createElement('button');
      delBtn.className = 'tool-btn tiny danger';
      delBtn.textContent = '🗑';
      delBtn.title = '删除';
      delBtn.dataset.op = 'del';

      ops.appendChild(editBtn);
      ops.appendChild(delBtn);

      row.appendChild(cb);
      row.appendChild(main);
      row.appendChild(ops);
      listEl.appendChild(row);
    });

    if (emptyEl) emptyEl.style.display = sorted.length ? 'none' : 'block';
    syncSummary();
  }

  /* 同步收起条摘要（待办总数 / 最近事项） */
  function syncSummary() {
    var pending = list.filter(function (t) { return !t.done; }).length;
    var lastFiredRaw = S().read(K.LAST_FIRED, null);
    var recent = list.length ? list[0].text : '—';
    if (recent.length > 12) recent = recent.slice(0, 12) + '…';
    global.Save4.panel.setSummary({
      todos: pending,
      recent: recent,
      time: lastFiredRaw ? msToHuman(new Date(lastFiredRaw).getTime()) : '—'
    });
    global.Save4.panel.renderStrip();
  }

  /* ---------- 表单：添加 / 编辑 ---------- */
  function resetForm() {
    editingId = null;
    textEl.value = '';
    timeEl.value = '';
    repeatEl.value = 'none';
    document.getElementById('todo-editbar').classList.add('hidden');
    document.getElementById('todo-add').textContent = '＋';
    textEl.focus();
  }

  function startEdit(id) {
    var t = find(id);
    if (!t) return;
    editingId = id;
    textEl.value = t.text;
    timeEl.value = t.remindAt ? msToLocalInput(t.remindAt) : '';
    repeatEl.value = t.repeat || 'none';
    document.getElementById('todo-editbar').classList.remove('hidden');
    document.getElementById('todo-add').textContent = '✓';
    render(); // 高亮当前编辑行
    textEl.focus();
  }

  function onFormSubmit(e) {
    e.preventDefault();
    var text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    var remindAt = parseInputToMs(timeEl.value);
    var repeat = repeatEl.value;
    var payload = { text: text, remindAt: remindAt, repeat: remindAt ? repeat : 'none' };

    if (editingId) {
      var t = find(editingId);
      if (t) updateTodo(editingId, payload);
    } else {
      addTodo(payload);
    }
    resetForm();
    render(); // 清除编辑高亮
  }

  function onListClick(e) {
    var row = e.target.closest('.todo-row');
    if (!row) return;
    var id = row.dataset.id;
    var opBtn = e.target.closest('[data-op]');
    if (opBtn) {
      var op = opBtn.dataset.op;
      if (op === 'del') deleteTodo(id);
      if (op === 'edit') startEdit(id);
      return;
    }
  }

  function onListChange(e) {
    if (e.target.classList && e.target.classList.contains('todo-check')) {
      var row = e.target.closest('.todo-row');
      if (row) toggleDone(row.dataset.id);
    }
  }

  /* ---------- 初始化 ---------- */
  function init() {
    listEl = document.getElementById('todo-list');
    formEl = document.getElementById('todo-form');
    textEl = document.getElementById('todo-text');
    timeEl = document.getElementById('todo-time');
    repeatEl = document.getElementById('todo-repeat');
    emptyEl = document.getElementById('todo-empty');

    formEl.addEventListener('submit', onFormSubmit);
    document.getElementById('todo-cancel-edit').addEventListener('click', resetForm);
    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('change', onListChange);

    load();
    render();
  }

  global.Save4 = global.Save4 || {};
  global.Save4.todos = {
    init: init,
    getAll: getAll,
    addTodo: addTodo,
    updateTodo: updateTodo,
    deleteTodo: deleteTodo,
    toggleDone: toggleDone,
    find: find,
    syncSummary: syncSummary,
    msToHuman: msToHuman
  };
})(window);
