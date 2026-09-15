/* ════════════════════════════════════════════════════════════
   Save4 — 人设/气泡 界面自测（在渲染进程里执行）
   由 scripts/test-persona-ui.js 通过 executeJavaScript 注入。
   返回 { pass:[], fail:[] }。
   ════════════════════════════════════════════════════════════ */
(async () => {
  const pass = [], fail = [];
  const ok = (name, cond, extra) => (cond ? pass : fail).push(name + (extra ? ' → ' + extra : ''));

  const $ = (id) => document.getElementById(id);
  const chat = window.Save4 && window.Save4.chat;
  const bubble = window.Save4 && window.Save4.bubble;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LS = window.localStorage;
  const K_ROLE = 'save4.ai.rolecard', K_MEM = 'save4.ai.memory', K_CFG = 'save4.ai.config';

  const bubText = () => { const e = $('bubble-text'); return e ? (e.textContent || '').trim() : ''; };
  const bubShown = () => { const e = $('bubble'); return !!e && !e.classList.contains('hidden'); };
  const msgs = () => chat.messages();
  const last = () => { const m = msgs(); return m.length ? m[m.length - 1] : { role: '', content: '' }; };
  /* 清空气泡队列，保证每次断言的都是刚触发的那条 */
  const drain = () => { let g = 0; while (bubble.isShowing() && g++ < 20) bubble.dismiss(); };
  const setRole = (v) => chat.setRoleCard(v);

  if (!chat || !bubble) { return { pass: [], fail: ['页面未加载完成：chat/bubble 模块缺失'] }; }

  ok('页面模块加载（chat / bubble / pet / DOM）',
    !!(chat.parseRoleCard && bubble.enqueue && window.Save4.pet && $('ai-rolecard') && $('role-info')),
    'rolecard=' + !!$('ai-rolecard') + ' roleinfo=' + !!$('role-info'));

  /* ─────────── 0. 清场：模拟「用户已有旧人设」的初始状态 ─────────── */
  setRole('');
  LS.removeItem(K_MEM);
  drain();
  ok('初始状态：人设为空', chat.resolvedPersona() === '', JSON.stringify(chat.resolvedPersona()));
  ok('初始状态：气泡隐藏', !bubShown());

  /* ─────────── 1. bug2：点「📁 导入 .json」按钮 → 文件真的被读进来 ─────────── */
  const roleFile = $('role-file');
  let clicked = 0;
  const rawClick = roleFile.click.bind(roleFile);
  roleFile.click = function () { clicked++; };          // 拦掉真实系统文件框
  $('btn-role-import').click();
  roleFile.click = rawClick;
  ok('按钮「导入 .json」会拉起文件选择器', clicked === 1 && roleFile.value === '', 'clicked=' + clicked);

  /* 用户那张自定义字段的「刘哥」角色卡（含应被忽略的头像 base64） */
  const CARD = {
    '名称': '刘哥',
    '身份': '隔壁工位的老同事',
    '性格': '直爽、爱开玩笑，嘴上不饶人但心里护着你',
    '说话风格': '短句、口语，偶尔带点东北腔',
    '口头禅': '兄弟你这不行啊',
    'avatar': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  };
  const cardText = JSON.stringify(CARD, null, 2);

  const dt = new DataTransfer();
  dt.items.add(new File([cardText], 'liuge.json', { type: 'application/json' }));
  roleFile.files = dt.files;
  roleFile.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300);                                    // FileReader 异步

  ok('导入后文本域内容 = 文件内容', $('ai-rolecard').value === cardText,
    'len=' + $('ai-rolecard').value.length);
  ok('导入后已写入存储（保存有效）', chat.getRoleCard() === cardText.trim(),
    'stored.len=' + String(chat.getRoleCard() || '').length);
  ok('导入后提示区显示解析结果', /已导入/.test($('role-info').textContent || ''),
    ($('role-info').textContent || '').slice(0, 60));
  ok('导入后桌宠冒泡反馈', /已导入角色卡/.test(bubText()), bubText());
  drain();

  const persona = chat.resolvedPersona();
  ok('人设已生效（含 刘哥 / 直爽 / 口头禅）',
    /刘哥/.test(persona) && /直爽/.test(persona) && /兄弟你这不行啊/.test(persona),
    'len=' + persona.length);
  ok('头像 base64 被过滤，未注入人设', !/base64/i.test(persona) && !/avatar/i.test(persona));

  /* ─────────── 2. 指令 test：输出当前人设（不发 AI 请求） ─────────── */
  drain();
  const beforeTest = msgs().length;
  chat.send('test');
  await sleep(200);
  const t = last();
  ok('test：新增 用户+助手 两条消息', msgs().length === beforeTest + 2);
  ok('test：回复含【当前人设】且带上 刘哥', /【当前人设】/.test(t.content) && /刘哥/.test(t.content));
  ok('test：回复含格式/字段/画像/记忆/注入模式',
    ['【格式】', '识别字段：', '【用户画像】', '【长期记忆】', '【注入模式】']
      .every((k) => t.content.indexOf(k) >= 0),
    '缺少：' + ['【格式】', '识别字段：', '【用户画像】', '【长期记忆】', '【注入模式】']
      .filter((k) => t.content.indexOf(k) < 0).join('') + ' ｜ ' + t.content.replace(/\n/g, '⏎').slice(0, 150));
  ok('test：桌宠冒泡说话', /人设已输出/.test(bubText()), bubText());
  drain();

  /* ─────────── 3. 按钮 🔍 查看人设：提示区显示将注入的原文 ─────────── */
  $('btn-role-test').click();
  ok('按钮「查看人设」列出注入内容',
    /将作为人设注入的内容/.test($('role-info').textContent || '') && /刘哥/.test($('role-info').textContent || ''));

  /* ─────────── 4. bug1：发送「清除」→ 人设真的没了 ─────────── */
  drain();
  chat.send('清除');
  await sleep(200);
  ok('清除：存储已被写空', chat.getRoleCard() === '', JSON.stringify(chat.getRoleCard()));
  ok('清除：实际生效人设为空', chat.resolvedPersona() === '', JSON.stringify(chat.resolvedPersona()));
  ok('清除：对话已重置为单条说明', msgs().length === 1 && /已清除角色卡设定/.test(last().content),
    'len=' + msgs().length);
  ok('清除：提示了「清除记忆」入口', /清除记忆/.test(last().content));
  ok('清除：桌宠冒泡说话', /已清除人设/.test(bubText()), bubText());
  ok('清除：设置面板文本域同步清空（避免点「保存」把人设装回去）',
    $('ai-rolecard').value === '' && /已清除角色卡人设/.test($('role-info').textContent || ''),
    'value.len=' + $('ai-rolecard').value.length + ' info=' + ($('role-info').textContent || '').slice(0, 30));
  ok('清除后 test 复核：已无角色卡',
    (() => { chat.send('test'); return /（未设置角色卡/.test(last().content); })(),
    last().content.slice(0, 40));
  drain();

  /* ─────────── 5. 按钮 🧹 清除人设（设置面板路径） ─────────── */
  setRole(cardText);
  $('ai-rolecard').value = cardText;
  $('btn-role-clear').click();
  ok('按钮「清除人设」同时清空文本域与存储',
    $('ai-rolecard').value === '' && chat.getRoleCard() === '',
    'value.len=' + $('ai-rolecard').value.length + ' stored=' + JSON.stringify(chat.getRoleCard()));
  ok('按钮「清除人设」提示区确认', /已清除/.test($('role-info').textContent || ''));
  drain();

  /* ─────────── 6. 纯文本人设也能被清除（旧 bug 的主场景） ─────────── */
  setRole('你是刘哥，说话很冲，用东北腔。');
  ok('纯文本人设生效', /刘哥/.test(chat.resolvedPersona()));
  chat.send('清除');
  await sleep(150);
  ok('纯文本人设可被清除', chat.resolvedPersona() === '', JSON.stringify(chat.resolvedPersona()));
  drain();

  /* ─────────── 7. 清除记忆 ─────────── */
  LS.setItem(K_MEM, JSON.stringify([{ date: '2024-01-01', summary: '用户最近在纠结要不要换工作' }]));
  chat.send('清除记忆');
  await sleep(150);
  ok('清除记忆：摘要已清空', (LS.getItem(K_MEM) || '') === '[]' || LS.getItem(K_MEM) === null,
    JSON.stringify(LS.getItem(K_MEM)));
  ok('清除记忆：桌宠冒泡反馈', /已清空长期记忆/.test(bubText()), bubText());
  drain();

  /* ─────────── 8. AI 回复时桌宠气泡说话（走真实 send → ai:chat 桩） ─────────── */
  LS.setItem(K_CFG, JSON.stringify({ baseUrl: 'http://stub.local/v1', apiKey: 'x', model: 'stub-model' }));
  drain();
  chat.send('你好');
  await sleep(600);
  const aiMsg = last();
  ok('AI 回复已进入对话', aiMsg.role === 'assistant' && /桌宠/.test(aiMsg.content), aiMsg.content.slice(0, 30));
  ok('AI 回复时桌宠出现气泡说话', bubShown() && /桌宠/.test(bubText()), 'shown=' + bubShown() + ' text=' + bubText());
  ok('气泡文本已截断（不超过 61 字）', bubText().length <= 61, 'len=' + bubText().length);
  drain();

  /* ─────────── 9. 长回复截断 + 出错也有气泡 ─────────── */
  chat.say('一'.repeat(200));
  await sleep(100);
  ok('超长文本冒泡被截断为 60 字 + 省略号', bubText().length === 61 && /…$/.test(bubText()), 'len=' + bubText().length);
  drain();

  return { pass, fail };
})();
