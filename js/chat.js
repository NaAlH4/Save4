/* ════════════════════════════════════════════════════════════
   Save4 — chat.js  （M5 AI 对话消化系统，文档功能三·核心亮点）
   双模式:
   - 情绪安抚(soothe): 温暖共情陪伴，先引导说出身体感受，再给情感支持
   - 认知解构(struct): 冷静苏格拉底式提问，拆解问题并促进产出「最小行动」
   能力:
   - OpenAI 兼容 API（桌面版走主进程代理绕 CORS；网页版直连 fetch）
   - 展示模型「思考过程」(reasoning_content，如 deepseek-reasoner)
   - 对话历史存 IndexedDB（storage_db.js）
   - 对话结束自动生成摘要（100-200字）作长期记忆上下文
   - 预设提示词可留白；预留角色卡(JSON 或文本)接入点
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var K = S().KEYS;
  var db = global.Save4.db;

  var AI_KEY = 'ai.config';                 // { baseUrl, apiKey, model }
  var PROFILE_KEY = 'ai.profile';           // 用户画像文本
  var MEMORY_KEY = 'ai.memory';             // [{date, summary}] 最近 N 条摘要
  var ROLE_KEY = 'ai.rolecard';             // 角色卡：可留空；JSON/文本

  var mode = 'soothe';
  var messages = [];                        // 本次对话 {role, content, reasoning?}
  var convId = null;
  var els = {};
  var sending = false;
  var historyOpen = false;

  /* ══════════ 提示词（预设留白，供角色卡接管） ══════════ */
  // 读取角色卡：支持存字符串或 {name, system|prompt} 对象，解析出 system 段
  function roleSystem() {
    var raw = S().read(ROLE_KEY, '');
    if (!raw) return '';
    if (typeof raw === 'string') {
      var t = raw.trim();
      if (!t) return '';
      // 若看起来是 JSON，尝试解析出 system/prompt 字段
      if (t[0] === '{') {
        try {
          var obj = JSON.parse(t);
          return (obj.system || obj.prompt || obj.description || '').trim();
        } catch (e) { return t; }
      }
      return t; // 纯文本角色设定
    }
    if (typeof raw === 'object') {
      return (raw.system || raw.prompt || raw.description || '').trim();
    }
    return '';
  }

  function basePrompt() {
    var role = roleSystem();
    var profile = S().read(PROFILE_KEY, '');
    var memory = S().read(MEMORY_KEY, []);

    var ctx = role
      ? ('【角色设定】' + role)
      : '你是 Save4 桌面桌宠的 AI 助手，用中文回复，语气温柔克制，一次话不要过长。';
    // 用户画像 + 长期记忆（作为系统背景注入）
    if (profile) ctx += '\n\n【用户画像】' + profile;
    if (memory && memory.length) {
      var recent = memory.slice(0, 5).map(function (m) {
        return '· ' + (m.date || '') + '：' + m.summary;
      }).join('\n');
      ctx += '\n\n【之前的对话摘要（长期记忆）】\n' + recent;
    }
    return ctx;
  }

  function systemPrompt(m) {
    var base = basePrompt();
    // 仅附加简短模式提示；具体话术可留空交由角色卡/后续精细
    if (m === 'struct') {
      return base + '\n\n【模式：认知解构】通过提问帮用户拆解问题，最后引导产出一个小而可立即执行的「最小行动」。';
    }
    return base + '\n\n【模式：情绪安抚】先关心用户的感受与身体状态，给予共情支持，不急于讲道理或给方案。';
  }

  /* ══════════ API 调用（读取 content + reasoning_content） ══════════ */
  function getConfig() {
    return S().read(AI_KEY, {});
  }
  function configReady() {
    var c = getConfig();
    return !!(c.baseUrl && c.model);
  }

  function callAI(userMessages) {
    var c = getConfig();
    var desk = global.Save4Desktop;
    if (desk && desk.isDesktop && desk.aiChat) {
      return desk.aiChat({
        baseUrl: c.baseUrl, apiKey: c.apiKey || '', model: c.model,
        messages: userMessages, temperature: 0.7
      }).then(function (r) {
        return { ok: !!(r && r.ok), text: (r && r.text) || '', reasoning: (r && r.reasoning) || '', error: r && r.error || '' };
      }, function (e) {
        return { ok: false, text: '', reasoning: '', error: String(e && e.message || e) };
      });
    }
    // 网页版：浏览器直连 fetch
    var base = String(c.baseUrl || '').replace(/\/+$/, '');
    var url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (c.apiKey || '')
      },
      body: JSON.stringify({
        model: c.model, messages: userMessages, temperature: 0.7, stream: false
      })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { return { ok: false, text: '', reasoning: '', error: 'API ' + res.status + ': ' + t.slice(0, 200) }; });
      }
      return res.json().then(function (j) {
        var msg = j && j.choices && j.choices[0] && j.choices[0].message;
        return { ok: true, text: (msg && msg.content) || '', reasoning: (msg && msg.reasoning_content) || '' };
      });
    }, function (e) { return { ok: false, text: '', reasoning: '', error: String(e && e.message || e) }; });
  }

  /* ══════════ 渲染 ══════════ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  /* 提取消息中的「最小行动」文本；若无则返回 null */
  function extractAction(content) {
    var t = String(content || '');
    // 匹配 【最小行动】... 或 「最小行动」之后的文本
    var m = t.match(/(?:【最小行动】|\[最小行动\]|最小行动)[：:]\s*([\s\S]{2,})/);
    if (m) return m[1].trim().slice(0, 120);
    // 兜底：取最后一句非空行
    var lines = t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length) return lines[lines.length - 1].slice(0, 120);
    return null;
  }

  function msgHTML(msg) {
    var cls = msg.role === 'user' ? 'msg-user' : 'msg-ai';
    var avatar = msg.role === 'user' ? '🧑' : '🐾';
    var html = '<div class="msg ' + cls + '"><div class="msg-av">' + avatar + '</div>'
             + '<div class="msg-bubble">';
    // 思考过程（可折叠展示）
    if (msg.reasoning) {
      html += '<details class="reasoning"><summary>💭 思考过程</summary>'
            + '<div class="reasoning-body">' + esc(msg.reasoning) + '</div></details>';
    }
    html += esc(msg.content);
    // 助手消息：若含「最小行动」，提供一键加入待办
    if (msg.role !== 'user') {
      var action = extractAction(msg.content);
      if (action) {
        html += '<button class="add-todo-btn" data-add-todo="' + esc(action) + '">➕ 最小行动 → 加入待办</button>';
      }
    }
    html += '</div></div>';
    return html;
  }

  /* 把一段文本加入待办（默认无提醒，可后续加） */
  function addToTodo(text) {
    if (!text || !global.Save4.todos) return;
    global.Save4.todos.addTodo({ text: text, remindAt: null, repeat: 'none' });
    global.Save4.bubble.enqueue({ text: '✅ 已加入待办：' + text.slice(0, 30) });
  }

  function render() {
    els.body.innerHTML = messages.map(msgHTML).join('') || '<div class="chat-empty dim">'
      + (configReady() ? '点击桌宠说点什么吧～' : '请先在 设置 → AI 对话 里填入接口地址和模型')
      + '</div>';
    els.body.scrollTop = els.body.scrollHeight;
  }

  /* ══════════ 摘要生成（对话结束后调用，作长期记忆） ══════════ */
  function makeSummary() {
    if (!configReady() || messages.length < 2) return;
    var turn = messages.slice(-8).map(function (m) {
      return (m.role === 'user' ? '用户：' : 'AI：') + m.content;
    }).join('\n');
    var prompt = [
      { role: 'system', content: '你是一个摘要助手。请用简洁的中文给下面这段对话写一段 100-200 字的摘要，提炼用户的情绪、关键困惑与已经产出的行动。只输出摘要本身。' },
      { role: 'user', content: turn }
    ];
    callAI(prompt).then(function (r) {
      if (!r.ok || !r.text) return;
      var mem = S().read(MEMORY_KEY, []);
      mem.unshift({ date: new Date().toISOString().slice(0, 10), summary: r.text.trim() });
      mem = mem.slice(0, 8);
      S().write(MEMORY_KEY, mem);
    }).catch(function () {});
  }

  /* ══════════ 发送 ══════════ */
  function pushMsg(role, content, reasoning) {
    messages.push({ role: role, content: content, reasoning: reasoning || '' });
  }

  function send(text) {
    if (sending) return;
    text = String(text || '').trim();
    if (!text) return;
    if (!configReady()) {
      els.body.innerHTML = '<div class="chat-empty dim">请先在 设置 → AI 对话 配置接口地址与模型后再聊～</div>';
      return;
    }

    pushMsg('user', text);
    render();
    els.input.value = '';
    sending = true;
    setSendState(true);

    var history = [{ role: 'system', content: systemPrompt(mode) }]
      .concat(messages.map(function (m) { return { role: m.role, content: m.content }; }));

    callAI(history).then(function (r) {
      sending = false;
      setSendState(false);
      if (r.ok) {
        pushMsg('assistant', r.text, r.reasoning);
      } else {
        pushMsg('assistant', '⚠️ ' + (r.error || '请求失败，请检查 AI 配置或网络。'));
      }
      render();
      makeSummary();  // 触发摘要（长期记忆）
    });
  }

  function setSendState(busy) {
    els.send.disabled = busy;
    els.send.textContent = busy ? '…' : '发送';
  }

  /* ══════════ 历史记录 ══════════ */
  function friendlyDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function toggleHistory() {
    historyOpen = !historyOpen;
    els.historyPanel.classList.toggle('hidden', !historyOpen);
    if (historyOpen) loadHistoryList();
  }
  function loadHistoryList() {
    db.list().then(function (list) {
      els.historyList.innerHTML = '';
      if (!list.length) { els.historyList.innerHTML = '<div class="dim">暂无历史对话</div>'; return; }
      list.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'hist-row';
        row.innerHTML = '<div class="hist-title">' + esc(c.title || '未命名') + '</div>'
          + '<div class="hist-meta">' + esc(friendlyDate(c.date)) + ' · '
          + (c.mode === 'struct' ? '认知解构' : (c.mode === 'soothe' ? '情绪安抚' : '')) + '</div>';
        row.addEventListener('click', function () { openConv(c.id); });
        var del = document.createElement('button');
        del.className = 'hist-del'; del.textContent = '✕'; del.title = '删除';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          db.remove(c.id).then(function () { loadHistoryList(); });
        });
        row.appendChild(del);
        els.historyList.appendChild(row);
      });
    });
  }
  function openConv(id) {
    db.get(id).then(function (c) {
      if (!c) return;
      messages = (c.messages || []).map(function (m) {
        // 兼容旧记录：没有 reasoning 字段
        return { role: m.role, content: m.content, reasoning: m.reasoning || '' };
      });
      mode = c.mode || 'soothe';
      setMode(mode, false);
      convId = id;
      toggleHistory();
      render();
      els.body.scrollTop = els.body.scrollHeight;
    });
  }
  function newConv() {
    messages = [];
    convId = null;
    toggleHistory();
    render();
  }

  /* ══════════ 打开/关闭 ══════════ */
  function open(m) {
    els.chat.classList.remove('hidden');
    if (m) setMode(m, false);
    render();
    els.input.focus();
  }
  function close() {
    if (messages.length && configReady()) {
      var firstUser = messages.find(function (x) { return x.role === 'user'; });
      var item = {
        id: convId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        title: (firstUser && firstUser.content) ? firstUser.content.slice(0, 24) : '未命名',
        date: new Date().toISOString(),
        mode: mode,
        messages: messages.slice()
      };
      db.save(item);
    }
    els.chat.classList.add('hidden');
  }

  /* ══════════ 模式切换 ══════════ */
  function setMode(m, rerender) {
    mode = (m === 'struct') ? 'struct' : 'soothe';
    var btns = document.querySelectorAll('.chat-mode-btn');
    btns.forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
    if (rerender !== false) render();
  }

  /* ══════════ 初始化 ══════════ */
  function init(drag, dragOpts) {
    els.chat = document.getElementById('chat');
    els.body = document.getElementById('chat-body');
    els.input = document.getElementById('chat-input');
    els.send = document.getElementById('chat-send');
    els.historyPanel = document.getElementById('chat-history-panel');
    els.historyList = document.getElementById('chat-history-list');

    // 模式按钮：阻断祖先(标题栏)的拖拽 pointerdown，确保点击生效
    document.querySelectorAll('.chat-mode-btn').forEach(function (b) {
      b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      b.addEventListener('click', function () { setMode(b.dataset.mode, true); });
    });
    // 标题栏操作按钮：同样阻断拖拽
    ['chat-close', 'chat-clear', 'chat-history'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    });

    els.send.addEventListener('click', function () { send(els.input.value); });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(els.input.value); }
    });
    els.input.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    document.getElementById('chat-close').addEventListener('click', close);
    document.getElementById('chat-clear').addEventListener('click', newConv);
    document.getElementById('chat-history').addEventListener('click', toggleHistory);

    // 正文：委托处理「加入待办」按钮
    els.body.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-add-todo]');
      if (!btn) return;
      var text = btn.getAttribute('data-add-todo');
      addToTodo(text);
    });

    // 拖拽（标题栏移动；模式按钮/输入栏等交互区排除在外）
    if (drag) {
      drag.makeDraggable(els.chat, {
        handle: document.getElementById('chat-header'),
        ignore: '.chat-mode, .chat-actions, .chat-inputbar, .chat-history-panel',
        onMove: dragOpts && dragOpts.onMove,
        onEnd: dragOpts && dragOpts.onEnd
      });
    }

    setMode('soothe', false);
    render();
  }

  global.Save4 = global.Save4 || {};
  global.Save4.chat = {
    init: init,
    open: open,
    close: close,
    send: send,
    setMode: function (m) { setMode(m, true); },
    getMode: function () { return mode; },
    messages: function () { return messages.slice(); },
    configReady: configReady,
    getConfig: getConfig
  };
})(window);
