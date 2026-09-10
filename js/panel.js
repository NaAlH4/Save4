/* ════════════════════════════════════════════════════════════
   Save4 — panel.js  （面板/收起条逻辑）
   负责「收起条」文本渲染，内容类型由设置决定：
   - todos : 待办总数（数据来自 todos.js）
   - recent: 最近事项
   - time  : 最近提醒时间
   备忘录面板正文内容由 todos.js 渲染。
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };

  // 摘要数据源（由 todos.js / reminder.js 写入）
  var summary = { todos: 0, recent: '—', time: '—' };
  var stripEl = null;

  function stripContentType() {
    return S().read(S().KEYS.STRIP_CONTENT, 'todos');
  }

  function renderStrip(el) {
    var target = el || stripEl;
    if (!target) return '';
    var t = stripContentType();
    var text = '待办 ' + summary.todos + ' 项 · 点击展开';
    if (t === 'recent') text = '最近：' + summary.recent + ' · 点击展开';
    if (t === 'time') text = '最近提醒：' + summary.time + ' · 点击展开';
    target.textContent = text;
    return text;
  }

  global.Save4 = global.Save4 || {};
  global.Save4.panel = {
    init: function (el) { stripEl = el; },
    renderStrip: renderStrip,
    setSummary: function (patch) {
      Object.keys(patch || {}).forEach(function (k) {
        if (k in summary) summary[k] = patch[k];
      });
    },
    stripContentType: stripContentType
  };
})(window);
