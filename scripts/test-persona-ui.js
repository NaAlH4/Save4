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

/* ---------- 主进程桩：记录 AI 调用内容，验证本地指令不发请求 ---------- */
const aiPrompts = [];   // 每次请求的最后一条 user 消息
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
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'user') {
        aiPrompts.push(String(list[i].content).slice(0, 40));
        break;
      }
    }
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

  /* 主进程侧断言：本地指令（test / 清除 / 清除记忆）绝不能触发 AI 请求。
     预期只有「你好」那一轮，外加 makeSummary 的摘要轮（同一次对话的收尾）。 */
  const LOCAL = /^(test|\/test|测试|清除|清除人设|清空人设|重置人设|清除记忆|清空记忆|\/clear|\/clearmem)$/i;
  const leaked = aiPrompts.filter((t) => LOCAL.test(t.trim()));
  if (!leaked.length) report.pass.push('主进程：本地指令未发 AI 请求（共 ' + aiPrompts.length + " 次请求，均非指令）");
  else report.fail.push('主进程：本地指令竟触发了 AI 请求 → ' + JSON.stringify(leaked));
  if (aiPrompts[0] === '你好') report.pass.push('主进程：唯一真实对话确为「你好」');
  else report.fail.push('主进程：首条 AI 请求的最后一条用户消息应为「你好」，实际 ' + JSON.stringify(aiPrompts[0]));
  if (aiPrompts.length <= 2) report.pass.push('主进程：请求总数 ' + aiPrompts.length + '（回复 1 + 摘要 ≤1）');
  else report.fail.push('主进程：请求总数异常 = ' + aiPrompts.length + ' → ' + JSON.stringify(aiPrompts));

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
