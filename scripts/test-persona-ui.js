/* ════════════════════════════════════════════════════════════
   Save4 — 人设/气泡 真实界面自测（Electron 渲染进程）
   ────────────────────────────────────────────────────────────
   为什么要它：Node 端的桩测试只能验证 js/chat.js 的纯逻辑，
   验证不了 index.html 的 DOM 接线、app.js 的按钮回调、bubble.js 的气泡。
   本脚本用真实 Electron 加载真实页面（真 preload、真 DOM、真 FileReader），
   把用户报的两个 bug 逐条跑一遍：

     bug1 人设无法清除（旧解析器把非法 JSON 整段当人设）
     bug2 导入 .json 后保存无效

   隔离措施：
     - userData 指向临时目录 → 不会碰到你正在使用的 localStorage / IndexedDB
     - 不获取单实例锁 → 不会打断正在运行的桌宠
     - 窗口 show:false → 不打扰你
     - ai:chat 走本地桩 → 不发真实网络请求

   用法：npx electron scripts/test-persona-ui.js
   退出码 0 = 全绿，1 = 有断言失败
   ════════════════════════════════════════════════════════════ */
'use strict';

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'save4';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* 独立 userData：绝不动用户的真实数据 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'save4-uitest-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('disable-gpu');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

async function serveAppFile(request) {
  try {
    const u = new URL(request.url);
    if (u.host !== HOST) return new Response('bad host', { status: 400 });
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const fp = path.normalize(path.join(ROOT, p));
    if (!fp.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    if (!fs.statSync(fp).isFile()) return new Response('not found', { status: 404 });
    const ext = path.extname(fp).toLowerCase();
    return new Response(Readable.toWeb(fs.createReadStream(fp)), {
      headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return new Response('not found', { status: 404 });
  }
}

/* ---------- 主进程桩：记录 AI 调用内容，验证本地指令不发请求 / system 无预设 ---------- */
const aiCalls = [];     // [{ sys, lastUser }]  sys=null 表示没有 system 消息
const AI_REPLY = '我是你的桌宠呀，今天也一起把想法存档吧';

function stubIpc() {
  ['app:hide', 'app:reminder', 'app:interactive'].forEach((ch) => ipcMain.on(ch, () => {}));
  ipcMain.handle('data:export', () => ({ ok: true }));
  ipcMain.handle('data:import', () => ({ ok: false, canceled: true }));
  ipcMain.handle('game:focus', () => ({}));
  ipcMain.handle('game:icons', () => ({ icons: [], iconSize: 48 }));
  ipcMain.handle('game:wallpaper', () => null);
  ipcMain.handle('ai:chat', (e, opts) => {
    const list = (opts && opts.messages) || [];
    const sys = list.find((m) => m.role === 'system');
    let lastUser = '';
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'user') { lastUser = String(list[i].content); break; }
    }
    aiCalls.push({ sys: sys ? String(sys.content) : null, lastUser });
    return { ok: true, text: AI_REPLY, reasoning: '' };
  });
}

app.whenReady().then(async () => {
  protocol.handle('app', serveAppFile);
  stubIpc();

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
      additionalArguments: ['--save4-overlay=1']
    }
  });

  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) console.log('  [renderer] ' + message);
  });

  await win.loadURL('app://' + HOST + '/index.html');
  await new Promise((r) => setTimeout(r, 600)); // 等各模块 init 完成

  const driver = fs.readFileSync(path.join(__dirname, 'test-persona-ui-renderer.js'), 'utf8');
  let report;
  try {
    report = await win.webContents.executeJavaScript(driver, true);
  } catch (e) {
    console.error('驱动脚本异常: ' + e.message);
    app.exit(1);
    return;
  }

  /* 主进程侧断言：本地指令（test / 清除 / 清除记忆）绝不能触发 AI 请求；
     并且真正发出去的 system 里不能残留任何预设话术。 */
  const LOCAL = /^(test|\/test|测试|清除|清除人设|清空人设|重置人设|清除记忆|清空记忆|\/clear|\/clearmem)$/i;
  // 摘要轮的判据只能是「摘要指令」本身；不能用 /摘要/ 泛匹配，
  // 否则 system 里出现「【之前的对话摘要（长期记忆）】」的真实对话会被误判成摘要轮。
  const isSummary = (c) => /压缩成|只输出摘要本身/.test(c.sys || '');
  const replies = aiCalls.filter((c) => !isSummary(c));
  const summaries = aiCalls.filter(isSummary);

  const leaked = replies.filter((c) => LOCAL.test(c.lastUser.trim()));
  if (!leaked.length) report.pass.push('主进程：本地指令未发 AI 请求（真实回复 ' + replies.length + ' 次，摘要 ' + summaries.length + ' 次）');
  else report.fail.push('主进程：本地指令竟触发了 AI 请求 → ' + JSON.stringify(leaked.map((c) => c.lastUser)));
  if (replies.length === 2) report.pass.push('主进程：恰好 2 轮真实对话（清空人设后一轮 + 设角色卡后一轮）');
  else report.fail.push('主进程：真实对话轮数应为 2，实际 ' + replies.length + ' → ' + JSON.stringify(replies.map((c) => c.lastUser.slice(0, 20))));

  // ① 未设角色卡 → 连 system 消息都不发（空白模型）
  const blank = replies.find((c) => c.lastUser === '你好');
  if (blank && blank.sys === null) report.pass.push('主进程：未设角色卡时未发送 system 消息（空白对话模型）');
  else report.fail.push('主进程：未设角色卡时不应有 system → ' + JSON.stringify(blank && blank.sys));

  // ② 设了角色卡 → system 只有【角色设定】，且无任何预设话术
  const BANNED = /情绪安抚|认知解构|最小行动|温柔克制|苏格拉底|共情|先关心/;
  const dirty = aiCalls.filter((c) => c.sys && BANNED.test(c.sys));
  if (!dirty.length) report.pass.push('主进程：全部 ' + aiCalls.length + ' 次请求的 system 均无预设话术');
  else report.fail.push('主进程：system 里残留预设话术 → ' + JSON.stringify(dirty.map((c) => c.sys.slice(0, 80))));
  const withRole = replies.filter((c) => c.sys && /【角色设定】/.test(c.sys) && /刘哥/.test(c.sys));
  if (withRole.length === 1) report.pass.push('主进程：设角色卡后 system 注入了【角色设定】+ 角色卡内容');
  else report.fail.push('主进程：注入角色设定的请求数应为 1，实际 ' + withRole.length
    + ' → ' + JSON.stringify(replies.map((c) => (c.sys || '(无 system)').slice(0, 40))));

  const line = '─'.repeat(64);
  console.log('\n' + line);
  report.pass.forEach((t) => console.log('  ✔ ' + t));
  report.fail.forEach((t) => console.log('  ✘ ' + t));
  console.log(line);
  console.log(report.fail.length
    ? '❌ ' + report.fail.length + ' 项失败 / ' + report.pass.length + ' 项通过'
    : '✅ 全部通过（' + report.pass.length + ' 项）');
  console.log(line + '\n');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  app.exit(report.fail.length ? 1 : 0);
}).catch((e) => {
  console.error('启动失败: ' + (e && e.stack || e));
  app.exit(1);
});
