/* ════════════════════════════════════════════════════════════
   Save4 — dataio.js  （数据导出/导入模块）
   用途：
   1. 备份数据（JSON 文件）
   2. 在 网页版 ↔ 桌面版(Electron) 之间迁移数据
   存储内容：localStorage 中所有 save4.* 键（设置/几何/待办/定时器等）。
   两种通道自动适配：
   - 桌面版(Electron)：主进程「另存为/打开」系统文件对话框
   - 浏览器：触发文件下载 / <input type=file> 选择
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var PREFIX = 'save4.';
  var FILE_NAME = 'save4-data.json';

  function desktop() { return global.Save4Desktop && global.Save4Desktop.isDesktop ? global.Save4Desktop : null; }

  function notify(text) {
    if (global.Save4.bubble) {
      global.Save4.bubble.enqueue({ text: text });
    } else {
      window.alert(text);
    }
  }

  /* ---------- 收集/写入 ---------- */
  function collect() {
    var keys = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var full = localStorage.key(i);
        if (full && full.indexOf(PREFIX) === 0) {
          keys[full.slice(PREFIX.length)] = localStorage.getItem(full);
        }
      }
    } catch (e) { /* 忽略个别不可读键 */ }
    return keys;
  }

  function restore(keys) {
    var n = 0;
    Object.keys(keys || {}).forEach(function (k) {
      try { localStorage.setItem(PREFIX + k, keys[k]); n++; } catch (e) { /* 跳过 */ }
    });
    return n;
  }

  function stamp() {
    var d = new Date();
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function buildPayload() {
    return JSON.stringify({
      app: 'Save4',
      kind: 'save4-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      keys: collect()
    }, null, 2);
  }

  function parse(text) {
    var obj = JSON.parse(text);
    if (!obj || obj.app !== 'Save4' || !obj.keys) {
      throw new Error('不是有效的 Save4 数据文件');
    }
    return obj.keys;
  }

  /* ---------- 导出 ---------- */
  function doExport() {
    var payload = buildPayload();
    var d = desktop();
    if (d && d.exportData) {
      d.exportData(payload).then(function (r) {
        if (r && r.ok) notify('✅ 数据已导出到：\n' + r.path);
        else if (r && !r.canceled && r.error) notify('导出失败：' + r.error);
      }).catch(function (e) { notify('导出失败：' + e); });
      return;
    }
    // 浏览器：下载
    var blob = new Blob([payload], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'save4-data-' + stamp() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    notify('✅ 数据已导出（浏览器下载）');
  }

  /* ---------- 导入 ---------- */
  function doImport() {
    var d = desktop();
    if (d && d.importData) {
      d.importData().then(function (r) {
        if (r && r.ok) { importText(r.text); }
        else if (r && !r.canceled && r.error) notify('读取失败：' + r.error);
      }).catch(function (e) { notify('读取失败：' + e); });
      return;
    }
    // 浏览器：文件选择
    var input = document.getElementById('import-file');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function importText(text) {
    var keys;
    try { keys = parse(text); }
    catch (e) { notify('导入失败：' + e.message); return; }
    var n = restore(keys);
    notify('✅ 已导入 ' + n + ' 项数据，即将刷新页面…');
    setTimeout(function () { location.reload(); }, 800);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    document.getElementById('btn-export').addEventListener('click', doExport);
    document.getElementById('btn-import').addEventListener('click', doImport);
    var input = document.getElementById('import-file');
    if (input) {
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () { importText(String(reader.result || '')); };
        reader.onerror = function () { notify('读取文件失败'); };
        reader.readAsText(f, 'utf-8');
      });
    }
  }

  global.Save4 = global.Save4 || {};
  global.Save4.dataio = { init: init, doExport: doExport, doImport: doImport };
})(window);
