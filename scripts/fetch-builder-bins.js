/* ════════════════════════════════════════════════════════════
   Save4 — 预置 electron-builder 打包工具（走 npmmirror，避开 GitHub）
   下载 nsis / nsis-resources / winCodeSign 到 electron-builder 缓存，
   并校验 SHA256；构建时 electron-builder 将跳过下载直接解压。
   用法: node scripts/fetch-builder-bins.js
   ════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
const CACHE = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '.', 'electron-builder', 'Cache');

const TOOLS = [
  { release: 'nsis-3.0.4.1', file: 'nsis-3.0.4.1.7z',
    sha256: '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa' },
  { release: 'nsis-resources-3.4.1', file: 'nsis-resources-3.4.1.7z',
    sha256: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103' },
  { release: 'winCodeSign-2.6.0', file: 'winCodeSign-2.6.0.7z',
    sha256: 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4' }
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fetchOne(tool) {
  const dir = path.join(CACHE, tool.release);
  const out = path.join(dir, tool.file);
  fs.mkdirSync(dir, { recursive: true });

  // 已存在且校验通过 → 跳过
  if (fs.existsSync(out)) {
    const ok = sha256(fs.readFileSync(out)) === tool.sha256;
    if (ok) { console.log('已存在且校验通过:', tool.file); return; }
    console.log('校验不通过，重新下载:', tool.file);
  }

  const url = MIRROR + tool.release + '/' + tool.file;
  console.log('下载中:', url);
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== tool.sha256) {
    throw new Error('SHA256 不匹配: ' + tool.file + '\n  期望 ' + tool.sha256 + '\n  实际 ' + got);
  }
  fs.writeFileSync(out, buf);
  console.log('  ✔ 完成并校验通过 (' + Math.round(buf.length / 1024) + 'KB)');
}

(async () => {
  console.log('缓存目录:', CACHE);
  for (const t of TOOLS) await fetchOne(t);
  console.log('\n全部工具已就绪，可执行: npm run dist');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
