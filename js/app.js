/* ════════════════════════════════════════════════════════════
   Save4 — app.js  （M1/M2 协调入口）
   职责：
   1. 三种显示模式状态机: full(形象+面板) / pet(仅形象+收起条) / hidden(托盘)
   2. 桌宠与面板的位置/尺寸：本地记忆、拖拽移动、拖角缩放、边界钳制
   3. 右键菜单、悬停工具条、设置对话框
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var store = global.Save4.store;
  var drag = global.Save4.drag;
  var pet = global.Save4.pet;
  var panel = global.Save4.panel;
  var todos = global.Save4.todos;
  var reminder = global.Save4.reminder;
  var bubble = global.Save4.bubble;
  var timer = global.Save4.timer;
  var dataio = global.Save4.dataio;
  var chat = global.Save4.chat;
  var journal = global.Save4.journal;
  var skinMod = global.Save4.skin;   // 自定义形象模块（注意勿与下方 skin() 函数重名）
  var K = store.KEYS;

  var petGeo, panelGeo, mode;
  var els = {};
  var prevModeBeforeHide = 'full'; // Electron 托盘隐藏前的模式
  var tabs = null, panes = {};      // 面板页签缓存

  /* 皮肤定义：cat=SVG 猫(方形)，anime=立绘(竖版)，liuge=刘哥点赞
     custom=用户导入的图片（运行时由 skin.js 注册） */
  var SKINS = {
    cat:   { ratio: 1,     defW: 150, defH: 150, minW: 90,  maxW: 300 },
    anime: { ratio: 0.732, defW: 150, defH: 205, minW: 90,  maxW: 300 },
    liuge: { ratio: 0.904, defW: 160, defH: 177, minW: 90,  maxW: 320 }
  };
  var skinKey = 'cat';
  function skin() { return SKINS[skinKey] || SKINS.cat; }
  function currentRatio() { return skin().ratio; }

  /* 注册/注销「自定义形象」皮肤（供 skin.js 调用） */
  function registerCustomSkin(meta) {
    if (!meta || !meta.ratio || !isFinite(meta.ratio)) { delete SKINS.custom; return; }
    var ratio = Math.max(0.2, Math.min(5, meta.ratio));
    var s = { ratio: ratio, minW: 90, maxW: 320 };
    // 默认尺寸：长边约 170px，保持图片比例
    if (ratio >= 1) { s.defW = 170; s.defH = Math.round(170 / ratio); }
    else { s.defH = 170; s.defW = Math.round(170 * ratio); }
    SKINS.custom = s;
  }
  function unregisterCustomSkin() {
    delete SKINS.custom;
    if (skinKey === 'custom') selectSkin('cat');
  }

  /* ══════════ 工具 ══════════ */
  function $(id) { return document.getElementById(id); }

  function saveMode(m) {
    mode = m;
    store.write(K.MODE, m);
    document.body.setAttribute('data-mode', m);
  }

  function defaultPetGeo() {
    var s = skin();
    return {
      x: Math.max(8, window.innerWidth - s.defW - 24),
      y: Math.max(8, window.innerHeight - s.defH - 24),
      w: s.defW, h: s.defH
    };
  }

  function defaultPanelGeo() {
    // 放在桌宠左上方，避免初次遮挡
    var w = 320, h = 380;
    var pg = store.read(K.PET_GEO, null) || defaultPetGeo();
    return {
      x: Math.max(8, pg.x - w - 16),
      y: Math.max(8, pg.y - 40),
      w: w, h: h
    };
  }

  function clampGeo(geo) {
    geo.x = drag.clamp(geo.x, 0, Math.max(0, window.innerWidth - geo.w));
    geo.y = drag.clamp(geo.y, 0, Math.max(0, window.innerHeight - geo.h));
  }

  function applyGeo(el, geo) {
    el.style.left = geo.x + 'px';
    el.style.top = geo.y + 'px';
    el.style.width = geo.w + 'px';
    el.style.height = geo.h + 'px';
  }

  /* ══════════ 收起条跟随桌宠 ══════════
     注：「仅形象」模式已不再显示收起条，此处保留定位逻辑以备将来启用；
     元素隐藏时（offsetParent 为 null）直接早退，避免拖拽时做无谓计算。 */
  function placeStrip() {
    var petEl = els.pet;
    if (!els.strip || !els.strip.offsetParent) return;
    var rect = petEl.getBoundingClientRect();
    var sw = els.strip.offsetWidth;
    var x = drag.clamp(rect.left + rect.width / 2 - sw / 2, 6, window.innerWidth - sw - 6);
    els.strip.style.left = x + 'px';
    els.strip.style.top = (rect.bottom + 8) + 'px';
  }

  /* ══════════ 模式切换 ══════════ */
  function setMode(m) {
    var prev = mode || 'full';
    saveMode(m);
    if (m === 'pet') placeStrip();
    if (m === 'pet' || m === 'full') {
      // 收起条显示内容按设置渲染
      panel.renderStrip($('strip-text'));
    }
    // Electron 桌面模式：隐藏 = 收进系统托盘
    if (m === 'hidden') {
      prevModeBeforeHide = (prev === 'hidden') ? prevModeBeforeHide : prev;
      if (global.Save4Desktop && global.Save4Desktop.isDesktop) {
        global.Save4Desktop.hide();
      }
    }
  }

  /* Electron 托盘图标点击恢复：回到隐藏前的模式 */
  function restoreFromTray() {
    if (global.Save4Desktop && global.Save4Desktop.isDesktop) {
      global.Save4Desktop.setInteractive(true);
    }
    // 只有页面处于 hidden 态才需要恢复模式；否则（窗口被托盘菜单直接隐藏）
    // 页面 data-mode 未变，窗口重新可见即回到原状
    if (mode === 'hidden') {
      var back = (prevModeBeforeHide === 'hidden') ? 'pet' : (prevModeBeforeHide || 'pet');
      setMode(back);
    }
  }

  /* ══════════ 右键菜单 ══════════ */
  var menu = null;
  function showMenu(x, y) {
    menu = $('menu');
    menu.classList.remove('hidden');
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }
  function hideMenu() { if (menu) menu.classList.add('hidden'); }

  function onMenuClick(e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    hideMenu();
    if (act === 'chat') { chat.open(); return; }
    if (act === 'journal') { openJournal(true); return; }
    if (act === 'settings') { els.settings.showModal(); return; }
    if (act === 'full' || act === 'pet' || act === 'hidden') setMode(act);
  }

  /* ══════════ 皮肤 ══════════ */
  function validSkin(key) { return SKINS[key] ? key : 'cat'; }

  function applySkin(key, saveGeo) {
    skinKey = validSkin(key);
    pet.setSkin(skinKey);
    // 若切换到与当前比例不符的皮肤，重置为默认尺寸（避免拉伸）
    if (saveGeo) {
      var s = skin();
      petGeo.w = s.defW; petGeo.h = s.defH;
      clampGeo(petGeo);
      applyGeo(els.pet, petGeo);
      store.write(K.PET_GEO, petGeo);
    }
  }

  /* 同步皮肤单选按钮的选中态 */
  function syncSkinRadios() {
    var rs = document.querySelectorAll('input[name="petSkin"]');
    rs.forEach(function (r) { r.checked = (r.value === skinKey); });
  }

  /* 选择皮肤（持久化 + 应用 + 同步 UI），供 skin.js 保存自定义形象后调用 */
  function selectSkin(key) {
    store.write(K.SKIN, validSkin(key));
    applySkin(key, true);
    syncSkinRadios();
  }

  /* ══════════ 设置对话框 ══════════ */
  function initSettings() {
    var dlg = els.settings;
    // 皮肤
    var skinRadios = dlg.querySelectorAll('input[name="petSkin"]');
    skinRadios.forEach(function (r) {
      r.checked = (r.value === skinKey);
      r.addEventListener('change', function () {
        if (r.checked) selectSkin(r.value);
      });
    });
    // 说明：收起条已不再显示（「仅形象」模式只留桌宠本体），
    // 因此原来的「收起条显示内容」设置项及其绑定一并移除。

    initAISettings();
  }

  /* ══════════ AI 对话设置（M5） ══════════ */
  function initAISettings() {
    var aiKey = 'ai.config';   // 与 chat.js 的 AI_KEY 一致
    var aiEl = {
      base: $('ai-baseurl'), key: $('ai-key'), model: $('ai-model'),
      save: $('btn-ai-save'), test: $('btn-ai-test')
    };
    var cfg = store.read(aiKey, null) || {};
    aiEl.base.value = cfg.baseUrl || '';
    aiEl.key.value = cfg.apiKey || '';
    aiEl.model.value = cfg.model || '';

    // 模型胶囊：点击即填充输入框，解决 datalist 被前缀过滤看不到其他模型的问题
    var chips = document.querySelectorAll('#ai-model-chips .model-chip');
    function refreshActiveChip() {
      chips.forEach(function (c) {
        c.classList.toggle('active', c.dataset.model === aiEl.model.value.trim());
      });
    }
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        aiEl.model.value = c.dataset.model;
        refreshActiveChip();
      });
    });
    aiEl.model.addEventListener('input', refreshActiveChip);
    refreshActiveChip();

    // 角色卡 / 用户画像
    var roleEl = $('ai-rolecard'), profEl = $('ai-profile'), roleSave = $('btn-ai-role-save');
    var roleVal = store.read('ai.rolecard', '');
    var profVal = store.read('ai.profile', '');
    roleEl.value = (typeof roleVal === 'string') ? roleVal : JSON.stringify(roleVal || {});
    profEl.value = profVal || '';
    roleSave.addEventListener('click', function () {
      store.write('ai.rolecard', roleEl.value.trim() || '');
      store.write('ai.profile', profEl.value.trim() || '');
      bubble.enqueue({ text: '✅ 角色卡 / 画像已保存' });
    });

    aiEl.save.addEventListener('click', function () {
      store.write(aiKey, {
        baseUrl: aiEl.base.value.trim(),
        apiKey: aiEl.key.value.trim(),
        model: aiEl.model.value.trim()
      });
      bubble.enqueue({ text: '✅ AI 配置已保存' });
    });

    aiEl.test.addEventListener('click', function () {
      var m = { baseUrl: aiEl.base.value.trim(), apiKey: aiEl.key.value.trim(), model: aiEl.model.value.trim() };
      if (!m.baseUrl || !m.model) { bubble.enqueue({ text: '请先填写接口地址与模型' }); return; }
      aiEl.test.disabled = true; aiEl.test.textContent = '测试中…';
      // 用一个极短请求探测连通性
      callChatTest(m).then(function (r) {
        aiEl.test.disabled = false; aiEl.test.textContent = '测试连接';
        if (r && r.ok) bubble.enqueue({ text: '✅ 连接成功：' + (r.text || 'OK') });
        else bubble.enqueue({ text: '❌ ' + (r && r.error || '连接失败') });
      });
    });
  }

  // 探测：让模型返回一个字，验证连通
  function callChatTest(cfg) {
    var desk = global.Save4Desktop;
    var messages = [{ role: 'user', content: '请只回复两个字：正常' }];
    if (desk && desk.isDesktop && desk.aiChat) {
      return desk.aiChat({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, messages: messages, temperature: 0 });
    }
    var base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    var url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.apiKey || '') },
      body: JSON.stringify({ model: cfg.model, messages: messages, temperature: 0, stream: false })
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { ok: false, error: 'API ' + res.status + ': ' + t.slice(0, 120) }; });
      return res.json().then(function (j) {
        return { ok: true, text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || 'OK' };
      });
    }, function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  /* ══════════ 拖拽 / 缩放 + 位置记忆 ══════════ */
  function initDrag() {
    // 桌宠移动（整只拖，除 .no-drag 按钮/手柄）
    drag.makeDraggable(els.pet, {
      onMove: function (x, y) { petGeo.x = x; petGeo.y = y; if (mode === 'pet') placeStrip(); },
      onEnd: function (x, y) {
        petGeo.x = x; petGeo.y = y;
        store.write(K.PET_GEO, petGeo);
        pet.celebrate(700); // 轻量反馈
      }
    });
    // 桌宠缩放（按当前皮肤比例，cat=方形 anime=竖版）
    drag.makeResizable(els.pet, els.petResize, {
      ratioOf: currentRatio, minW: skin().minW, maxW: skin().maxW,
      minH: 90, maxH: 420,
      onEnd: function (w, h) {
        petGeo.w = w; petGeo.h = h;
        store.write(K.PET_GEO, petGeo);
        if (mode === 'pet') placeStrip();
      }
    });
    // 按住右键上下拖动缩放桌宠（右键单击仍呼出菜单）
    drag.makeRightDragScale(els.pet, {
      ratioOf: currentRatio, minW: skin().minW, maxW: skin().maxW,
      minH: 90, maxH: 420, span: 300,
      onResize: function (w, h) {
        petGeo.w = w; petGeo.h = h;
        if (mode === 'pet') placeStrip();
      },
      onEnd: function (w, h) {
        petGeo.w = w; petGeo.h = h;
        store.write(K.PET_GEO, petGeo);
        if (mode === 'pet') placeStrip();
      },
      onRightClick: function (x, y) { showMenu(x, y); }
    });
    // 面板移动（用标题栏作拖拽手柄）
    drag.makeDraggable(els.panel, {
      handle: els.panelHeader,
      onMove: function (x, y) { panelGeo.x = x; panelGeo.y = y; },
      onEnd: function (x, y) {
        panelGeo.x = x; panelGeo.y = y;
        store.write(K.PANEL_GEO, panelGeo);
      }
    });
    // 面板缩放
    drag.makeResizable(els.panel, els.panelResize, {
      minW: 240, maxW: 560, minH: 200, maxH: 520,
      onEnd: function (w, h) {
        panelGeo.w = w; panelGeo.h = h;
        store.write(K.PANEL_GEO, panelGeo);
      }
    });
  }

  /* ══════════ 皮肤素材缺失时的优雅降级 ══════════
     开源仓库不包含「刘哥」皮肤素材（含他人肖像），因此若图片加载失败：
     隐藏该皮肤选项，并在当前正用它时回退到几何小猫，避免出现裂图。 */
  function guardMissingSkins() {
    var img = $('pet-img-liuge');
    var opt = $('skin-opt-liuge');
    if (!img || !opt) return;

    function degrade() {
      opt.style.display = 'none';
      if (skinKey === 'liuge') {
        store.write(K.SKIN, 'cat');
        applySkin('cat', true);
        var r = document.querySelector('input[name="petSkin"][value="cat"]');
        if (r) r.checked = true;
      }
    }
    // 图片此前已加载失败（naturalWidth 为 0），或之后失败
    if (img.complete && img.naturalWidth === 0) { degrade(); return; }
    img.addEventListener('error', degrade);
  }

  /* ══════════ 顶栏按钮 / 托盘 ══════════ */
  function initButtons() {
    // 工具条：AI 对话
    $('btn-chat').addEventListener('click', function () { chat.open(); });
    // 工具条：写日记（快速开写）
    $('btn-journal').addEventListener('click', function () { openJournal(true); });
    // 顶栏：展开/收起面板（full <-> pet）
    $('btn-toggle-mode').addEventListener('click', function () {
      setMode(mode === 'full' ? 'pet' : 'full');
    });
    $('btn-hide').addEventListener('click', function () { setMode('hidden'); });
    // 面板内：收起 / 隐藏
    $('btn-collapse').addEventListener('click', function () { setMode('pet'); });
    $('btn-panel-hide').addEventListener('click', function () { setMode('hidden'); });
    // 收起条：点击展开为完整模式
    els.strip.addEventListener('click', function () { setMode('full'); });
    // 托盘：恢复
    els.tray.addEventListener('click', function () { setMode('pet'); });
    // 右键菜单：只屏蔽原生菜单
    // （菜单的呼出改由 makeRightDragScale 的「右键单击且未移动」回调负责，
    //   这样右键上下拖动可用于缩放，不会误弹菜单）
    els.pet.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    $('menu').addEventListener('click', onMenuClick);   // 菜单项点击
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#menu')) hideMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideMenu();
    });
  }

  /* ══════════ 面板页签（备忘录 / 定时器 / 日记） ══════════ */
  function initTabs() {
    tabs = document.querySelectorAll('.panel-tab');
    panes = {};
    tabs.forEach(function (t) {
      panes[t.dataset.pane] = document.getElementById('pane-' + t.dataset.pane);
    });
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activateTab(tab.dataset.pane); });
    });
  }

  /* 切到指定页签（供日记快速入口等复用） */
  function activateTab(name) {
    if (!tabs || !panes[name]) return;
    tabs.forEach(function (t) { t.classList.toggle('on', t.dataset.pane === name); });
    Object.keys(panes).forEach(function (k) {
      if (panes[k]) panes[k].classList.toggle('hidden', k !== name);
    });
  }

  /* ══════════ 日记快速入口（工具条 📔 / 右键菜单） ══════════ */
  function openJournal(fresh) {
    if (mode !== 'full') setMode('full');   // 确保面板可见
    activateTab('journal');
    if (journal) {
      if (fresh) journal.quickWrite();
      else journal.openJournal();
    }
  }

  /* ══════════ 窗口尺寸变化时钳制在可视范围内 ══════════ */
  function onResize() {
    clampGeo(petGeo); applyGeo(els.pet, petGeo);
    clampGeo(panelGeo); applyGeo(els.panel, panelGeo);
    if (mode === 'pet') placeStrip();
  }

  /* ══════════ 启动 ══════════ */
  function boot() {
    els.pet = $('pet');
    els.panel = $('panel');
    els.strip = $('strip');
    els.tray = $('tray');
    els.petResize = $('pet-resize');
    els.panelResize = $('panel-resize');
    els.panelHeader = $('panel-header');
    els.settings = $('settings-dialog');

    // 先初始化自定义形象：它会把已保存的图片注册为 custom 皮肤，
    // 因此必须早于下面的皮肤读取（否则上次选了 custom 会回退成小猫）
    if (skinMod) skinMod.init();

    // 恢复皮肤（影响 pet 默认比例/尺寸）
    skinKey = validSkin(store.read(K.SKIN, 'cat'));
    document.body.setAttribute('data-skin', skinKey);

    // 恢复几何，无记录时给默认位置
    petGeo = store.read(K.PET_GEO, null) || defaultPetGeo();
    panelGeo = store.read(K.PANEL_GEO, null) || defaultPanelGeo();
    clampGeo(petGeo); clampGeo(panelGeo);
    applyGeo(els.pet, petGeo);
    applyGeo(els.panel, panelGeo);

    // 恢复模式；若上次为 hidden，则打开时回到 pet，避免“找不到桌宠”
    var saved = store.read(K.MODE, 'full');
    setMode(saved === 'hidden' ? 'pet' : saved);

    // 初始化模块：桌宠 -> 面板(收起条) -> 气泡 -> 待办 -> 提醒调度 -> 定时器
    pet.init($('pet-svg'));
    pet.setSkin(skinKey);
    panel.init($('strip-text'));
    bubble.init();
    todos.init();
    reminder.init();
    timer.init();
    journal.init();
    initTabs();
    initDrag();
    initButtons();
    guardMissingSkins();   // 必须在 initSettings 之前：缺素材则先回退皮肤
    initSettings();
    dataio.init();
    initChat();

    window.addEventListener('resize', onResize);
    // 给首次打开一个欢快反馈
    setTimeout(function () { pet.celebrate(900); }, 500);
  }

  /* ══════════ AI 对话窗口（M5）：初始化 + 拖拽/缩放 + 位置记忆 ══════════ */
  var chatGeo = { x: null, y: null, w: 360, h: 460 };
  function initChat() {
    var c = $('chat');
    var stored = store.read(K.CHAT_GEO, null);
    if (stored) chatGeo = { x: stored.x, y: stored.y, w: stored.w, h: stored.h };
    // 默认放在面板右侧
    if (chatGeo.x == null) chatGeo.x = window.innerWidth - chatGeo.w - 30;
    if (chatGeo.y == null) chatGeo.y = 60;

    // 拖拽(标题栏)与缩放由 chat.init 统一处理，这里只恢复几何 + 位置记忆
    drag.makeResizable(c, $('chat-resize'), {
      minW: 300, maxW: 760, minH: 320, maxH: 720,
      onEnd: function (w, h) { chatGeo.w = w; chatGeo.h = h; store.write(K.CHAT_GEO, chatGeo); }
    });
    c.style.left = chatGeo.x + 'px';
    c.style.top = chatGeo.y + 'px';
    c.style.width = chatGeo.w + 'px';
    c.style.height = chatGeo.h + 'px';

    chat.init(drag, {
      onMove: function (x, y) { chatGeo.x = x; chatGeo.y = y; },
      onEnd: function (x, y) { chatGeo.x = x; chatGeo.y = y; store.write(K.CHAT_GEO, chatGeo); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露给其他模块（如 reminder 需要把 hidden 恢复为 pet；skin 需要注册自定义皮肤）
  global.Save4.app = {
    setMode: setMode,
    restoreFromTray: restoreFromTray,
    getMode: function () { return mode; },
    registerCustomSkin: registerCustomSkin,
    unregisterCustomSkin: unregisterCustomSkin,
    selectSkin: selectSkin,
    getSkin: function () { return skinKey; }
  };
})(window);
