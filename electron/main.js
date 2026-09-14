/* ════════════════════════════════════════════════════════════
   Save4 — Electron 主进程
   形态：透明置顶「覆盖层」窗口，桌宠直接浮在桌面/其他窗口之上；
   只有桌宠/面板等交互区域接收鼠标，其余区域点击穿透到桌面。
   另含：系统托盘(隐藏/恢复/退出)、原生通知、单实例、F12 调试台。
   环境变量: SAVE4_WINDOW=window → 以普通窗口模式运行（备用）
   ════════════════════════════════════════════════════════════ */
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain,
        nativeImage, protocol, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const IS_OVERLAY = process.env.SAVE4_WINDOW !== 'window';
const ICON_PATH = path.join(ROOT, 'shortcut_icon.ico');
const HOST = 'save4'; // app://save4/index.html 固定 origin → localStorage 稳定

let win = null;
let tray = null;
let isQuitting = false;

/* ---------- 自定义 app:// 协议：文件即页面，origin 恒定、存储可靠 ---------- */
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

async function serveAppFile(request) {
  try {
    const u = new URL(request.url);
    if (u.host !== HOST) return new Response('bad host', { status: 400 });
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const fp = path.normalize(path.join(ROOT, p));
    if (!fp.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    const st = fs.statSync(fp);
    if (!st.isFile()) return new Response('not found', { status: 404 });
    const ext = path.extname(fp).toLowerCase();
    return new Response(Readable.toWeb(fs.createReadStream(fp)), {
      headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return new Response('not found', { status: 404 });
  }
}

/* ---------- 窗口 ---------- */
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    x: wa.x, y: wa.y,
    width: wa.width, height: wa.height,
    frame: false,
    transparent: IS_OVERLAY,
    backgroundColor: IS_OVERLAY ? '#00000000' : '#fff6ea',
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 托盘态/失焦时定时器照常运行 → 提醒可靠
      spellcheck: false,
      additionalArguments: ['--save4-overlay=' + (IS_OVERLAY ? '1' : '0')]
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL('app://' + HOST + '/index.html');
  win.once('ready-to-show', () => win.show());

  // 覆盖层默认点击穿透（页面检测到鼠标进入交互区后会通过 IPC 关闭穿透）
  if (IS_OVERLAY) win.setIgnoreMouseEvents(true, { forward: true });

  // F12 调试台；Ctrl+R 刷新页面（拉取最新代码）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown') {
      if (input.key === 'F12') win.webContents.toggleDevTools();
      if (input.control && input.key.toLowerCase() === 'r') {
        win.webContents.reload();
      }
    }
  });

  // 关窗 → 收进托盘而不是退出
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('show', () => { if (win) win.webContents.send('app:visibility', true); });
  win.on('hide', () => { if (win) win.webContents.send('app:visibility', false); });

  return win;
}

/* ---------- 托盘 ---------- */
function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Save4 桌宠');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    { label: '刷新页面', click: () => { if (win) win.webContents.reload(); } },
    { label: '重启应用', click: () => { app.relaunch(); app.quit(); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => toggleWindow());
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
  // 页面若处于 hidden(页面托盘) 态，则恢复为「仅形象」
  win.webContents.send('app:restore');
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else showWindow();
}

/* ---------- IPC ---------- */
ipcMain.on('app:hide', () => { if (win) win.hide(); });
ipcMain.on('app:interactive', (e, v) => {
  if (win && IS_OVERLAY) win.setIgnoreMouseEvents(!v, { forward: true });
});
ipcMain.on('app:reminder', (e, text) => {
  // 窗口不可见时：原生通知 + 唤醒窗口
  if (win && !win.isVisible()) {
    if (Notification.isSupported()) {
      new Notification({ title: 'Save4 提醒', body: String(text || '有新的提醒'), icon: ICON_PATH }).show();
    }
    showWindow();
  }
});

/* ---------- 桌面贪吃蛇：枚举桌面图标（读取真实文件图标，只读不改动） ---------- */
ipcMain.handle('game:icons', async () => {
  const dirs = [];
  try { dirs.push(app.getPath('desktop')); } catch (e) {}
  if (process.env.PUBLIC) dirs.push(path.join(process.env.PUBLIC, 'Desktop'));

  const out = [];
  const LIMIT = 80;
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      if (out.length >= LIMIT) break;
      if (ent.name === 'desktop.ini') continue;
      const full = path.join(dir, ent.name);
      let icon = '';
      try {
        const img = await app.getFileIcon(full, { size: 'normal' });
        icon = img.toDataURL();
      } catch (e) { icon = ''; }
      out.push({ name: ent.name, isDir: ent.isDirectory(), icon: icon });
    }
  }
  return out;
});

/* ---------- 游戏需要键盘焦点：暂时关掉点击穿透并抢焦点 ---------- */
ipcMain.handle('game:focus', () => {
  if (!win) return false;
  try {
    win.setIgnoreMouseEvents(false);
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.focus();
  } catch (e) { return false; }
  return true;
});

/* ---------- AI 对话代理（桌面版核心：主进程发请求，规避浏览器 CORS） ----------
   请求体: { baseUrl, apiKey, model, messages, temperature }
   返回:   { ok, text } | { ok:false, error }  （仅支持 OpenAI 兼容 chat/completions）
   注意: 该方案把 model 名称原样传给服务端，兼容 DeepSeek/通义/OpenAI 等。 */
ipcMain.handle('ai:chat', async (e, opts) => {
  try {
    const { baseUrl, apiKey, model, messages, temperature } = opts || {};
    if (!baseUrl) return { ok: false, error: '未设置接口地址' };
    if (!model) return { ok: false, error: '未设置模型' };

    // 规范化 baseUrl：允许用户填 "https://api.deepseek.com" 或带上 /v1
    let base = String(baseUrl).replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';

    const body = JSON.stringify({
      model: model,
      messages: messages || [],
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      stream: false
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (apiKey || ''),
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 60000
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const status = res.statusCode || 0;
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) {}
          if (status >= 200 && status < 300) {
            const msg = parsed && parsed.choices && parsed.choices[0] &&
                        parsed.choices[0].message;
            // 正文(content) 与 思考(reasoning_content，如 deepseek-reasoner) 都取回
            resolve({ ok: true, text: (msg && msg.content) || '',
                      reasoning: (msg && msg.reasoning_content) || '', raw: parsed });
          } else {
            const em = (parsed && parsed.error && (parsed.error.message || parsed.error.code)) || data;
            reject(new Error('API ' + status + ': ' + String(em).slice(0, 300)));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('请求超时')); });
      req.write(body);
      req.end();
    });

    return result;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('data:export', async (e, payload) => {
  if (!win) return { ok: false, error: 'no window' };
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0') + '_' +
                String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  const r = await dialog.showSaveDialog(win, {
    title: '导出 Save4 数据',
    defaultPath: path.join(app.getPath('documents'), 'save4-backup-' + stamp + '.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, payload, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('data:import', async () => {
  if (!win) return { ok: false, error: 'no window' };
  const r = await dialog.showOpenDialog(win, {
    title: '导入 Save4 数据',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    return { ok: true, text: text, path: r.filePaths[0] };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* ---------- 单实例 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

/* ---------- 启动 ---------- */
if (process.env.SAVE4_USERDATA) app.setPath('userData', process.env.SAVE4_USERDATA);
app.setAppUserModelId('com.save4.desktop');

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  createWindow();
  createTray();
  if (process.env.SAVE4_SMOKE) {
    // 冒烟测试：启动后自动退出
    setTimeout(() => { console.log('SMOKE_OK'); app.quit(); }, 4000);
  }
});
