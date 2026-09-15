/* ════════════════════════════════════════════════════════════
   Save4 — chat.js  （M5 AI 对话）
   设计原则：不做任何预设。
   - 不预设人格、不预设话术、不预设「模式」：AI 就是一个空白对话模型
   - 唯一的人设来源是**角色卡**（你在设置里导入的 .json / 文本）
   - 没设角色卡时连 system 消息都不发，完全交给模型与服务商默认行为
   - 可选注入（都是你自己填的）：用户画像、历史对话摘要（长期记忆）
   能力:
   - OpenAI 兼容 API（桌面版走主进程代理绕 CORS；网页版直连 fetch）
   - 展示模型「思考过程」(reasoning_content，如 deepseek-reasoner)
   - 对话历史存 IndexedDB（storage_db.js）
   - 对话结束自动生成摘要（100-200字）作长期记忆上下文
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

  var messages = [];                        // 本次对话 {role, content, reasoning?}
  var convId = null;
  var els = {};
  var sending = false;
  var historyOpen = false;

  /* ══════════ 角色卡解析（支持多种 JSON 格式 + 容错） ══════════
     背景：角色卡格式五花八门，之前只认 system/prompt/description，
     导致「合法 JSON 但字段不同 → 被忽略」「非法 JSON → 整段原文当人设」两个极端。
     现在：优先按已知字段名提取；未知字段也会被逐条列出，保证“导入即生效”。 */

  // 字段名 → 中文标签（按优先级排序；中英文都支持）
  var ROLE_FIELDS = [
    ['system', '系统指令'], ['system_prompt', '系统指令'], ['prompt', '系统指令'],
    ['instructions', '指令'], ['instruction', '指令'],
    ['post_history_instructions', '补充指令'],
    ['name', '名称'], ['char_name', '名称'], ['character', '名称'], ['名称'], ['名字'],
    ['identity', '身份'], ['身份'], ['role', '角色'], ['角色'],
    ['description', '设定'], ['persona', '人设'], ['personality', '性格'], ['profile', '简介'],
    ['人设'], ['设定'], ['简介'], ['描述'], ['性格'], ['外貌'],
    ['scenario', '背景'], ['world', '世界观'], ['background', '背景'], ['背景'], ['世界观'], ['场景'],
    ['speech', '说话风格'], ['speaking_style', '说话风格'], ['style', '风格'], ['tone', '语气'],
    ['说话风格'], ['语言风格'], ['语气'], ['口头禅'],
    ['mes_example', '对话示例'], ['example_dialogue', '对话示例'], ['examples', '示例'], ['示例'],
    ['first_mes', '开场白'], ['greeting', '开场白'], ['开场白'],
    ['likes', '喜好'], ['dislikes', '厌恶'], ['爱好'], ['厌恶'],
    ['relationship', '与用户关系'], ['关系'],
    ['major', '专业'], ['age', '年龄'], ['gender', '性别'], ['gender_identity', '性别认同'],
    ['real_name', '真实姓名'], ['self_name', '自称']
  ];
  // 明显是图片/元数据、不应塞进提示词的字段
  var ROLE_SKIP = /^(avatar|image|img|png|icon|photo|banner|thumbnail|base64|data|id|uuid|create_date|creation_date|date|version|spec|spec_version|talkativeness|fav|tags|creator|creator_notes|character_book|extensions|lorebook|world_info)$/i;

  /* 宽松解析：先把常见的 JS 对象写法修成合法 JSON，再 parse */
  function lenientParse(text) {
    var t = String(text || '').trim();
    try { return { ok: true, obj: JSON.parse(t), repaired: false }; } catch (e) {}
    var r = t
      .replace(/\/\/[^\n\r]*/g, '')                 // 去行注释
      .replace(/\/\*[\s\S]*?\*\//g, '')             // 去块注释
      .replace(/,\s*([}\]])/g, '$1')                // 去尾逗号
      .replace(/([{,]\s*)([A-Za-z_$\u4e00-\u9fa5][\w$\-\u4e00-\u9fa5]*)(\s*:)/g, '$1"$2"$3') // 未加引号的键
      .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"'); // 单引号值
    try { return { ok: true, obj: JSON.parse(r), repaired: true }; } catch (e) {}
    return { ok: false, obj: null, repaired: false };
  }

  /* 取"看起来像内容"的字符串（过滤空串、超长 base64） */
  function usableString(v) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    if (!s) return '';
    if (s.length > 4000) return '';                 // 可能是内嵌图片
    if (/^data:image\//i.test(s)) return '';
    if (s.length > 200 && !/[\u4e00-\u9fa5]/.test(s) && !/\s/.test(s)) return ''; // 疑似 base64
    return s;
  }

  /* 把解析出来的对象整理成可读的人设文本 */
  function buildFromObject(obj, avatarsIgnored) {
    // 角色卡 V2：内容在 data 里
    var root = (obj && obj.data && typeof obj.data === 'object') ? obj.data : obj;
    var used = {};
    var parts = [];
    var fields = [];

    ROLE_FIELDS.forEach(function (pair) {
      var key = pair[0], label = pair[1] || pair[0];
      if (used[key]) return;
      var s = usableString(root[key]);
      if (!s) return;
      used[key] = 1;
      fields.push(label);
      parts.push((label === '名称' ? '你是「' + s + '」' : label + '：' + s));
    });

    // 未知字段：值得展示的一并列出（保证任意格式的角色卡都能生效）
    Object.keys(root).forEach(function (k) {
      if (used[k] || ROLE_SKIP.test(k)) return;
      var s = usableString(root[k]);
      if (!s) return;
      fields.push(k);
      parts.push(k + '：' + s);
    });

    var name = usableString(root.name) || usableString(root.char_name) ||
               usableString(root['名称']) || usableString(root['名字']) ||
               usableString(root.character) || '';
    return { text: parts.join('\n'), name: name, fields: fields };
  }

  /* 对外：把任意角色卡（纯文本 / JSON 字符串 / 对象）解析成人设文本 */
  function parseRoleCard(raw) {
    if (raw && typeof raw === 'object') {
      var r0 = buildFromObject(raw, true);
      return { text: r0.text, name: r0.name, fields: r0.fields, format: 'object', ok: !!r0.text };
    }
    var t = String(raw == null ? '' : raw).trim();
    if (!t) return { text: '', name: '', fields: [], format: 'empty', ok: false };

    // 只看首字符会漏掉「带注释/说明开头」的角色卡（如 // 备注 换行后接 {…}），
    // 那种卡会被整段原文当人设注入。这里先剥掉前导注释与空白再判断。
    var strictJson = (t[0] === '{' || t[0] === '[');
    var head = t.replace(/^(?:\s|\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)+/, '');
    var looksJson = strictJson || head[0] === '{' || head[0] === '[';
    if (looksJson) {
      var p = lenientParse(t);
      if (p.ok && p.obj && typeof p.obj === 'object') {
        var r = buildFromObject(p.obj, true);
        if (r.text) {
          return {
            text: r.text, name: r.name, fields: r.fields,
            format: p.repaired ? 'json(已修复格式)' : 'json', ok: true
          };
        }
        // JSON 合法但一个可用字段都没有 → 不要静默失效，退回原文并标注
        return { text: t, name: '', fields: [], format: 'json(无已知字段,按原文)', ok: true };
      }
      // 明确以 { / [ 开头却解析失败 → 按原文使用并标注，便于用户察觉
      if (strictJson) return { text: t, name: '', fields: [], format: '原始文本(非法JSON)', ok: true };
    }
    return { text: t, name: '', fields: [], format: '纯文本', ok: true };
  }

  /* 角色卡 → 人设文本（唯一的人设来源） */
  function roleSystem() {
    return parseRoleCard(S().read(ROLE_KEY, '')).text;
  }

  /* ══════════ 提示词：不预设任何人格/话术，只注入你给的东西 ══════════
     唯一人设来源 = 角色卡。没有角色卡时返回空串，调用方会连 system 消息都不发，
     让模型按服务商默认行为工作（真正的「空白对话模型」）。 */
  function basePrompt() {
    var role = roleSystem();
    var profile = S().read(PROFILE_KEY, '');
    var memory = S().read(MEMORY_KEY, []);

    var parts = [];
    // 唯一的「预设」：让模型照着导入的设定扮演。没有角色卡时这句也不会出现。
    if (role) parts.push('【角色设定】请以下述设定扮演该角色，保持它的身份、语气与说话方式，不要跳出角色：\n' + role);
    if (profile) parts.push('【用户画像】' + profile);
    if (memory && memory.length) {
      var recent = memory.slice(0, 5).map(function (m) {
        return '· ' + (m.date || '') + '：' + m.summary;
      }).join('\n');
      parts.push('【之前的对话摘要（长期记忆）】\n' + recent);
    }
    return parts.join('\n\n');
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

  /* 把一段文本切成句子（保留句末标点与换行），供「右键某句话」定位 */
  function splitSentences(text) {
    var s = String(text || '');
    var out = [], buf = '';
    var ENDS = '。！？!?；;\n';
    for (var i = 0; i < s.length; i++) {
      buf += s[i];
      if (ENDS.indexOf(s[i]) >= 0) { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
    return out;
  }

  /* 助手回复：按句渲染，每句带 data-si 以便右键定位（用户消息按原文） */
  function assistantHTML(content) {
    return splitSentences(content).map(function (p, si) {
      if (!p.trim()) return esc(p);            // 纯空白不参与交互
      return '<span class="sent" data-si="' + si + '">' + esc(p) + '</span>';
    }).join('');
  }

  function msgHTML(msg, mi) {
    var isUser = msg.role === 'user';
    var cls = isUser ? 'msg-user' : 'msg-ai';
    var avatar = isUser ? '🧑' : '🐾';
    var html = '<div class="msg ' + cls + '" data-mi="' + mi + '">'
             + '<div class="msg-av">' + avatar + '</div>'
             + '<div class="msg-bubble">';
    // 思考过程（可折叠展示）
    if (msg.reasoning) {
      html += '<details class="reasoning"><summary>💭 思考过程</summary>'
            + '<div class="reasoning-body">' + esc(msg.reasoning) + '</div></details>';
    }
    // 不再自动挂「加入待办」按钮：改由 ① 用户说「加入待办」② 右键某句话 触发
    html += isUser ? esc(msg.content) : assistantHTML(msg.content);
    html += '</div></div>';
    return html;
  }

  /* 清理待办文本里的标记词（如【最小行动】），让待办读起来更干净 */
  function cleanTodoText(t) {
    return String(t || '')
      .replace(/^\s*[【\[「]?\s*最小行动\s*[】\]」]?\s*[：:、,，\-—]?\s*/, '')
      .replace(/^\s*[【\[「]?\s*下一步\s*[】\]」]?\s*[：:、,，\-—]?\s*/, '')
      .trim();
  }

  /* 把一段文本加入待办（默认无提醒，可后续加） */
  function addToTodo(text) {
    var t = cleanTodoText(text);
    if (!t || !global.Save4.todos) return false;
    global.Save4.todos.addTodo({ text: t, remindAt: null, repeat: 'none' });
    global.Save4.bubble.enqueue({ text: '✅ 已加入待办：' + t.slice(0, 30) });
    return true;
  }

  /* ══════════ 句子浮层：右键 AI 回复的某句话 → 加入待办 ══════════ */
  var pendingSent = '';

  function hideSentMenu() {
    if (els.sentMenu) els.sentMenu.classList.add('hidden');
    pendingSent = '';
  }

  function showSentMenu(x, y, text) {
    if (!els.sentMenu) return;
    pendingSent = text;
    els.sentMenu.classList.remove('hidden');
    var wrap = els.chat.getBoundingClientRect();
    var mw = els.sentMenu.offsetWidth, mh = els.sentMenu.offsetHeight;
    var left = Math.max(4, Math.min(x - wrap.left, wrap.width - mw - 4));
    var top = Math.max(4, Math.min(y - wrap.top, wrap.height - mh - 4));
    els.sentMenu.style.left = left + 'px';
    els.sentMenu.style.top = top + 'px';
  }

  /* 右键：命中某句 → 该句；命中助手气泡空白 → 整条回复；其他 → 不弹 */
  function onBodyContextMenu(e) {
    e.preventDefault();
    var sentEl = e.target.closest && e.target.closest('.sent');
    if (sentEl) {
      var msgEl = sentEl.closest('.msg');
      var mi = msgEl ? Number(msgEl.dataset.mi) : NaN;
      var si = Number(sentEl.dataset.si);
      var m = messages[mi];
      if (m && !isNaN(si)) {
        var parts = splitSentences(m.content);
        var text = (parts[si] || '').trim();
        if (text) { showSentMenu(e.clientX, e.clientY, text); return; }
      }
      return;
    }
    var bubbleMsg = e.target.closest && e.target.closest('.msg-ai');
    if (bubbleMsg) {
      var i2 = Number(bubbleMsg.dataset.mi);
      var mm = messages[i2];
      if (mm && String(mm.content || '').trim()) {
        showSentMenu(e.clientX, e.clientY, String(mm.content).trim().slice(0, 120));
      }
      return;
    }
    hideSentMenu();
  }

  /* ══════════ 「加入待办」指令识别 ══════════ */
  // 支持「加入待办 / 加到待办 / 加入代办(常见误写) / 记到待办 / 加个待办」等说法
  var TODO_TRIGGER = /(加入待办|加到待办|加进待办|加入代办|加到代办|加个待办|新增待办|添加待办|添加到待办|记到待办|记入待办|加入\s*todo|add\s*to\s*todo)/i;

  /* 「加入待办」未带内容时的兜底：取上一条 AI 回复的最后一句（不做任何预设假设） */
  function lastAssistantSentence() {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      var parts = splitSentences(messages[i].content).map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length) return parts[parts.length - 1].slice(0, 120);
      return null;
    }
    return null;
  }

  /* 若用户这句话是「加入待办」指令 → 返回要加入的内容 */
  function parseTodoCommand(text) {
    var m = String(text || '').match(TODO_TRIGGER);
    if (!m) return null;
    var rest = String(text).slice(m.index + m[0].length)
      .replace(/^[\s:：,，、。.\-—]+/, '')
      .replace(/^(把|帮我|请|麻烦|给我)\s*/, '')
      .trim();
    if (rest.length >= 2) return rest.slice(0, 120);
    var fallback = lastAssistantSentence();
    return fallback || null;
  }

  function render() {
    els.body.innerHTML = messages.map(function (m, i) { return msgHTML(m, i); }).join('')
      || '<div class="chat-empty dim">'
      + (configReady() ? '点击桌宠说点什么吧～' : '请先在 设置 → AI 对话 里填入接口地址和模型')
      + '</div>';
    els.body.scrollTop = els.body.scrollHeight;
    hideSentMenu();
  }

  /* ══════════ 摘要生成（对话结束后调用，作长期记忆） ══════════ */
  function makeSummary() {
    if (!configReady() || messages.length < 2) return;
    var turn = messages.slice(-8).map(function (m) {
      return (m.role === 'user' ? '用户：' : 'AI：') + m.content;
    }).join('\n');
    var prompt = [
      { role: 'system', content: '请用简洁的中文把下面这段对话压缩成 100-200 字的摘要，记下关键事实、结论与待办。只输出摘要本身。' },
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

  /* ══════════ 人设指令：test 查看当前人设 / 清除 清空人设 ══════════ */
  var TEST_CMD = /^(test|\/test|测试|查看人设|人设测试)$/i;
  var CLEAR_CMD = /^(\/clear|clear|清除|清除人设|清空人设|重置人设)$/i;
  var CLEAR_MEM_CMD = /^(清除记忆|清空记忆|\/clearmem)$/i;

  /* 桌宠气泡说话（AI 回复时同步冒泡） */
  function say(text, ms) {
    if (!global.Save4.bubble) return;
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (t.length > 60) t = t.slice(0, 60) + '…';
    global.Save4.bubble.enqueue({ text: t, duration: ms || 6000 });
    if (global.Save4.pet) global.Save4.pet.celebrate(900);
  }

  /* 指令清除了人设后，同步设置面板的文本域/提示区。
     否则面板里还留着旧 JSON，用户随手点一次「保存」就把人设又装回去了。 */
  function syncRolePanel() {
    var ta = document.getElementById('ai-rolecard');
    if (ta) ta.value = '';
    var info = document.getElementById('role-info');
    if (info) info.textContent = '🧹 已清除角色卡人设（来自对话指令）';
  }

  /* 处理本地指令；返回 true 表示已处理（不再请求 AI） */
  function handleLocalCommand(text) {
    // ① 加入待办
    var todo = parseTodoCommand(text);
    if (todo) {
      pushMsg('user', text);
      addToTodo(todo);
      pushMsg('assistant', '✅ 已加入待办：' + todo);
      render(); say('已加入待办：' + todo);
      return true;
    }
    // ② test：输出当前人设
    if (TEST_CMD.test(text)) {
      var parsed = parseRoleCard(S().read(ROLE_KEY, ''));
      var profile = S().read(PROFILE_KEY, '');
      var mem = S().read(MEMORY_KEY, []);
      var out = '【当前人设】' + (parsed.text
        ? '\n' + parsed.text
        : '\n（未设角色卡 → 空白对话模型，不注入任何预设）');
      out += '\n\n【格式】' + parsed.format
        + (parsed.name ? ' · 名称：' + parsed.name : '')
        + (parsed.fields && parsed.fields.length ? ' · 识别字段：' + parsed.fields.join('、') : '');
      out += '\n【用户画像】' + (profile ? profile : '（空）');
      out += '\n【长期记忆】' + (mem && mem.length ? mem.length + ' 条摘要' : '（空）');
      out += '\n【人设来源】' + (parsed.text ? '角色卡' : '未设角色卡（空白对话模型，不注入任何预设）');
      pushMsg('user', text);
      pushMsg('assistant', out);
      render(); say('人设已输出到对话里');
      return true;
    }
    // ③ 清除：清空人设（并重置对话，避免旧人设的风格借着历史残留）
    if (CLEAR_CMD.test(text)) {
      S().write(ROLE_KEY, '');
      messages = [];            // 直接重置，不经过 newConv（避免顺带开关历史面板）
      convId = null;
      syncRolePanel();
      pushMsg('assistant', '🧹 已清除角色卡设定，并重置了当前对话。\n'
        + '现在的人设：空白对话模型（不注入任何预设，模型按原样回复）。\n'
        + '小提示：长期记忆摘要仍会作为背景注入；若要一并清空，发送「清除记忆」。');
      render(); say('已清除人设并重置对话');
      return true;
    }
    // ④ 清除记忆（处理人设残留的间接影响）
    if (CLEAR_MEM_CMD.test(text)) {
      S().write(MEMORY_KEY, []);
      pushMsg('user', text);
      pushMsg('assistant', '🧹 已清空长期记忆摘要。');
      render(); say('已清空长期记忆');
      return true;
    }
    return false;
  }

  function send(text) {
    if (sending) return;
    text = String(text || '').trim();
    if (!text) return;

    // 本地指令优先（加入待办 / test / 清除 …）
    if (handleLocalCommand(text)) { els.input.value = ''; return; }

    if (!configReady()) {
      els.body.innerHTML = '<div class="chat-empty dim">请先在 设置 → AI 对话 配置接口地址与模型后再聊～</div>';
      return;
    }

    pushMsg('user', text);
    render();
    els.input.value = '';
    sending = true;
    setSendState(true);

    // 没有角色卡/画像/记忆时不发 system 消息 —— 保持模型原样（空白对话）
    var sys = basePrompt();
    var history = (sys ? [{ role: 'system', content: sys }] : [])
      .concat(messages.map(function (m) { return { role: m.role, content: m.content }; }));

    callAI(history).then(function (r) {
      sending = false;
      setSendState(false);
      if (r.ok) {
        pushMsg('assistant', r.text, r.reasoning);
        say(r.text);                       // 桌宠冒泡说话
      } else {
        pushMsg('assistant', '⚠️ ' + (r.error || '请求失败，请检查 AI 配置或网络。'));
        say('呜…出错了：' + (r.error || '请求失败'), 8000);
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
          + ((c.messages || []).length) + ' 条</div>';
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
  function open() {
    els.chat.classList.remove('hidden');
    refreshRoleTag();          // 期间可能改过角色卡，打开时同步顶部显示
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
        messages: messages.slice()
      };
      db.save(item);
    }
    hideSentMenu();
    els.chat.classList.add('hidden');
  }

  /* ══════════ 顶部「当前扮演谁」（人设只来自角色卡） ══════════ */
  function refreshRoleTag() {
    var el = document.getElementById('chat-role');
    if (!el) return;
    var p = parseRoleCard(S().read(ROLE_KEY, ''));
    if (p.text) {
      el.textContent = '🎭 扮演：' + (p.name || '已设角色卡');
      el.title = '人设来自角色卡（' + p.format + '）：\n' + p.text;
      el.classList.remove('empty');
    } else {
      el.textContent = '🎭 未设人设 · 空白对话模型';
      el.title = '未导入角色卡：不会注入任何预设人格或话术，模型按原样回复。\n'
        + '在 设置 → AI 对话 里导入 .json 角色卡，它就会照着扮演。';
      el.classList.add('empty');
    }
  }

  /* ══════════ 初始化 ══════════ */
  function init(drag, dragOpts) {
    els.chat = document.getElementById('chat');
    els.body = document.getElementById('chat-body');
    els.input = document.getElementById('chat-input');
    els.send = document.getElementById('chat-send');
    els.historyPanel = document.getElementById('chat-history-panel');
    els.historyList = document.getElementById('chat-history-list');

    // 标题栏操作按钮：阻断祖先(标题栏)的拖拽 pointerdown，确保点击生效
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

    // ② 右键 AI 回复的某句话 → 浮层「加入待办」
    els.sentMenu = document.getElementById('chat-sent-menu');
    els.sentBtn = document.getElementById('chat-sent-todo');
    els.body.addEventListener('contextmenu', onBodyContextMenu);
    els.sentBtn.addEventListener('click', function () {
      if (pendingSent) addToTodo(pendingSent);
      hideSentMenu();
    });
    // 浮层内的右键/点击不应穿透为新的右键判定
    els.sentMenu.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    els.sentMenu.addEventListener('click', function (e) { e.stopPropagation(); });
    // 点击别处 / Esc / 滚动正文 → 收起浮层
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('#chat-sent-menu')) hideSentMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideSentMenu();
    });
    els.body.addEventListener('scroll', hideSentMenu);

    // 拖拽（标题栏移动；顶部人设标签/输入栏等交互区排除在外）
    if (drag) {
      drag.makeDraggable(els.chat, {
        handle: document.getElementById('chat-header'),
        ignore: '.chat-role, .chat-actions, .chat-inputbar, .chat-history-panel, .sent-menu',
        onMove: dragOpts && dragOpts.onMove,
        onEnd: dragOpts && dragOpts.onEnd
      });
    }

    refreshRoleTag();
    render();
  }

  global.Save4 = global.Save4 || {};
  global.Save4.chat = {
    init: init,
    open: open,
    close: close,
    send: send,
    messages: function () { return messages.slice(); },
    configReady: configReady,
    getConfig: getConfig,
    // 供设置界面使用：
    parseRoleCard: parseRoleCard,                  // 解析任意角色卡 → {text,name,fields,format,ok}
    resolvedPersona: function () { return roleSystem(); },
    setRoleCard: function (raw) { S().write(ROLE_KEY, raw == null ? '' : raw); },
    getRoleCard: function () { return S().read(ROLE_KEY, ''); },
    refreshRoleTag: refreshRoleTag,                // 角色卡变动后刷新顶部「扮演：xxx」
    basePrompt: basePrompt,                        // 实际会注入的 system 内容（空串=不发 system）
    say: say                                      // 让桌宠冒泡说话
  };
})(window);
