/* ════════════════════════════════════════════════════════════
   Save4 — 角色卡解析 / 人设存取 单元自测（Node，无需 Electron）
   ────────────────────────────────────────────────────────────
   跑的是真实代码：js/storage.js + js/chat.js（在 vm 里注入假 window/localStorage）。
   覆盖用户报的两个 bug 的纯逻辑层：
     bug1 人设无法清除   → 第 20~24 项（含经真实 storage.js 的读写往返）
     bug2 导入 .json 无效 → 第 3~16 项（各种角色卡格式都要生效）

   用法：node scripts/test-rolecard.js      退出码 0 = 全绿，1 = 有失败
   ════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 假 window / localStorage，跑真实 js ---------- */
function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    get length() { return m.size; },
    _dump: () => Object.fromEntries(m)
  };
}

const sandbox = { console };
sandbox.window = sandbox;
sandbox.localStorage = makeLocalStorage();
sandbox.document = { getElementById: () => null };  // chat.js 里的面板同步按“不存在”处理
vm.createContext(sandbox);

for (const f of ['js/storage.js', 'js/chat.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const chat = sandbox.Save4.chat;
const store = sandbox.Save4.store;

/* ---------- 迷你断言器 ---------- */
const pass = [], fail = [];
function ok(name, cond, extra) {
  (cond ? pass : fail).push(name + (extra ? ' → ' + extra : ''));
}

/* ---------- 1. 纯文本角色卡 ---------- */
{
  const p = chat.parseRoleCard('你是刘哥，说话很冲，用东北腔。');
  ok('纯文本：原样作为人设', p.ok && p.text === '你是刘哥，说话很冲，用东北腔。', 'format=' + p.format);
}
ok('空字符串 → 未设置人设', chat.parseRoleCard('').ok === false && chat.parseRoleCard('').text === '');
ok('null / undefined → 未设置人设',
  chat.parseRoleCard(null).ok === false && chat.parseRoleCard(undefined).ok === false);
ok('纯空白 → 未设置人设', chat.parseRoleCard('   \n\t ').ok === false);

/* ---------- 2. 标准 system/prompt/description ---------- */
{
  const p = chat.parseRoleCard(JSON.stringify({ system: '你是温柔助手', name: '小四' }));
  ok('JSON system：被提取', /温柔助手/.test(p.text) && p.name === '小四', 'name=' + p.name);
}
{
  const p = chat.parseRoleCard(JSON.stringify({ prompt: '只用三句话回答' }));
  ok('JSON prompt：被提取', /只用三句话回答/.test(p.text), 'format=' + p.format);
}
{
  const p = chat.parseRoleCard(JSON.stringify({ description: '一个安静的树洞' }));
  ok('JSON description：被提取', /安静的树洞/.test(p.text));
}

/* ---------- 3. 用户那张自定义字段的「刘哥」卡（本次 bug 核心） ---------- */
const LIUGE = {
  '名称': '刘哥',
  '身份': '隔壁工位的老同事',
  '性格': '直爽、爱开玩笑，嘴上不饶人但心里护着你',
  '说话风格': '短句、口语，偶尔带点东北腔',
  '口头禅': '兄弟你这不行啊',
  'avatar': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
};
{
  const p = chat.parseRoleCard(JSON.stringify(LIUGE, null, 2));
  ok('自定义字段卡：整卡都生效（不再被忽略）',
    p.ok && /刘哥/.test(p.text) && /直爽/.test(p.text) && /兄弟你这不行啊/.test(p.text), 'len=' + p.text.length);
  ok('自定义字段卡：识别出名称', p.name === '刘哥', 'name=' + p.name);
  ok('自定义字段卡：字段清单完整',
    ['名称', '身份', '性格', '说话风格', '口头禅'].every((f) => p.fields.indexOf(f) >= 0),
    p.fields.join('、'));
  ok('自定义字段卡：头像 base64 被过滤', !/base64/i.test(p.text) && !/avatar/i.test(p.text));
}
{
  // 对象直接传入（未经字符串化）
  const p = chat.parseRoleCard(LIUGE);
  ok('对象入参：同样解析成功', p.ok && /刘哥/.test(p.text) && p.format === 'object', 'format=' + p.format);
}

/* ---------- 4. 角色卡 V2（内容在 data 里） ---------- */
{
  const v2 = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '林医生', description: '三甲医院的心理科医生',
      personality: '沉稳、耐心，说话有条理', first_mes: '今天想聊点什么？',
      mes_example: '<START>\n{{user}}: 我睡不着', creator_notes: '内部备注不该进人设',
      avatar: 'card.png', extensions: { talkativeness: '0.5' }
    }
  };
  const p = chat.parseRoleCard(JSON.stringify(v2));
  ok('V2 卡：读取 data 内的字段',
    p.ok && /林医生/.test(p.text) && /心理科医生/.test(p.text) && /沉稳/.test(p.text), 'len=' + p.text.length);
  ok('V2 卡：名称正确', p.name === '林医生', 'name=' + p.name);
  ok('V2 卡：元数据未混入人设',
    !/chara_card_v2/.test(p.text) && !/内部备注/.test(p.text) && !/talkativeness/.test(p.text) && !/card\.png/.test(p.text));
}

/* ---------- 5. 容错：JS 对象写法 / 注释 / 尾逗号 / 未加引号键 / 单引号 ---------- */
{
  const messy = [
    '// 这是我手写的角色卡',
    '{',
    "  name: '王小明',",
    '  /* 备注 */',
    "  system: '你是一个会讲冷笑话的室友',",
    '  tags: ["a","b"],',
    '}'
  ].join('\n');
  const p = chat.parseRoleCard(messy);
  ok('容错解析：注释/单引号/未加引号键/尾逗号都能救回',
    p.ok && p.format !== 'text' && /冷笑话/.test(p.text) && p.name === '王小明',
    'format=' + p.format + ' name=' + p.name);
}
{
  const p = chat.parseRoleCard('{ 这不是合法的 JSON，只是一段话');
  ok('无法解析的文本：整段当人设（不丢内容、不崩溃）',
    p.text === '{ 这不是合法的 JSON，只是一段话', 'format=' + p.format);
}
{
  // 回归：卡前面带注释/说明（手写卡常见），以前只看首字符 → 整段原文被当人设
  const p = chat.parseRoleCard('/* 我的角色卡 v2 */\n' + JSON.stringify(LIUGE));
  ok('前导块注释后接 JSON：仍按 JSON 解析（回归）',
    p.ok && /刘哥/.test(p.text) && !/\{/.test(p.text) && p.format !== '纯文本', 'format=' + p.format);
}
{
  const p = chat.parseRoleCard('这是一段普通文本，里面提到 {大括号} 但并不是角色卡');
  ok('普通文本含大括号：不误判为 JSON，原文保留',
    p.format === '纯文本' && p.text === '这是一段普通文本，里面提到 {大括号} 但并不是角色卡', 'format=' + p.format);
}

/* ---------- 6. 异常输入不崩溃、不注入垃圾 ---------- */
{
  const p = chat.parseRoleCard(JSON.stringify({ avatar: 'data:image/png;base64,' + 'A'.repeat(3000), 备注: 'ok' }));
  ok('纯图片卡 + 短字段：图片被丢弃、短字段保留', /ok/.test(p.text) && !/AAAA/.test(p.text));
}
{
  const p = chat.parseRoleCard(JSON.stringify({ name: 'X', 设定: 'B'.repeat(5000) }));
  ok('超长字符串（疑似内嵌图）被丢弃', !/BBBB/.test(p.text), 'len=' + p.text.length);
}
{
  const p = chat.parseRoleCard(JSON.stringify({ age: 30, vip: true, nested: { a: 1 }, list: [1, 2] }));
  ok('数字/布尔/嵌套对象/数组不会变成 "[object Object]"',
    !/\[object/.test(p.text) && !/undefined/.test(p.text), JSON.stringify(p.text));
}
{
  const p = chat.parseRoleCard('[1,2,3]');
  ok('顶层是数组：不崩溃', typeof p.text === 'string', JSON.stringify(p.text));
}
{
  const p = chat.parseRoleCard(JSON.stringify({ 名称: '反引号测试', 备注: '含 ` 与 ${x} 与 \\ 反斜杠' }));
  ok('特殊字符不被当成模板串执行', /反引号测试/.test(p.text), p.text.slice(0, 40));
}

/* ---------- 7. 经真实 storage.js 的读写往返（bug1/bug2 的落地检查） ---------- */
{
  chat.setRoleCard(JSON.stringify(LIUGE));
  ok('往返：写入后立即生效（无需重启）', /刘哥/.test(chat.resolvedPersona()));
  ok('往返：存储里是 JSON 字符串（与 storage.js 约定一致）',
    typeof sandbox.localStorage.getItem('save4.ai.rolecard') === 'string',
    'raw=' + String(sandbox.localStorage.getItem('save4.ai.rolecard')).slice(0, 20));

  chat.setRoleCard('');
  ok('往返：清空后生效人设为空（bug1 已修）', chat.resolvedPersona() === '', JSON.stringify(chat.resolvedPersona()));
  ok('往返：清空后 getRoleCard 为空串', chat.getRoleCard() === '');

  chat.setRoleCard('你是刘哥，用东北腔。');
  ok('往返：纯文本人设生效', /刘哥/.test(chat.resolvedPersona()));
  chat.setRoleCard('');
  ok('往返：纯文本人设可被清空（旧 bug 主场景）', chat.resolvedPersona() === '');

  chat.setRoleCard(JSON.stringify({ system: '你是一只叫四四的猫' }));
  ok('往返：换一张卡立即替换旧人设',
    /四四/.test(chat.resolvedPersona()) && !/刘哥/.test(chat.resolvedPersona()));

  store.write('ai.rolecard', '');
  ok('往返：直接写空（设置面板路径）同样清空', chat.resolvedPersona() === '');
}

/* ---------- 报告 ---------- */
const line = '─'.repeat(64);
console.log('\n' + line);
pass.forEach((t) => console.log('  ✔ ' + t));
fail.forEach((t) => console.log('  ✘ ' + t));
console.log(line);
console.log(fail.length ? '❌ ' + fail.length + ' 项失败 / ' + pass.length + ' 项通过'
  : '✅ 全部通过（' + pass.length + ' 项）');
console.log(line + '\n');
process.exit(fail.length ? 1 : 0);
