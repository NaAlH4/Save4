/* ════════════════════════════════════════════════════════════
   Save4 — 发布脚本：把 release/ 下的 exe 上传到 GitHub Releases
   ────────────────────────────────────────────────────────────
   为什么需要它：GitHub 网页界面限制单文件 25MB，而我们的安装包约 108MB，
   必须走 Releases API（单文件上限 2GB）。

   用法：
     npm run release             # 版本号取 package.json 的 version
     npm run release -- v0.1.2   # 或显式指定 tag

   认证（按顺序尝试，无需手填）：
     1. 环境变量 GH_TOKEN
     2. 本机 Git 凭据管理器里已保存的 github.com 凭据（git credential fill）

   代理：
     若设置了 HTTPS_PROXY / HTTP_PROXY，脚本会自动以 --use-env-proxy 重启自身，
     无需你手动加参数。（你本机代理为 http://127.0.0.1:9567）

   发布说明：
     若项目根目录存在 RELEASE_NOTES.md 就用它作为 Release 说明；
     否则自动用「下载说明 + 自上个 tag 以来的提交记录」生成。

   特性：自动创建 Release（若不存在）；清理上次中断留下的未完成资产；
        每个文件最多重试 3 次。
   ════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

/* ---------- 代理：自动以 --use-env-proxy 重启自身 ---------- */
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy ||
              process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY && !process.execArgv.includes('--use-env-proxy')) {
  console.log('检测到代理 ' + PROXY + '，自动以 --use-env-proxy 重启…\n');
  const r = spawnSync(process.execPath,
    ['--use-env-proxy', __filename].concat(process.argv.slice(2)),
    { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

/* ---------- 工具 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

/* 从 git remote 解析 owner/repo（支持 https 与 ssh 两种写法） */
function repoFromGit() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (m) return { owner: m[1], repo: m[2] };
  } catch (e) {}
  return null;
}

/* 从凭据管理器取 token（不自造、不外传，仅用于本次上传） */
function tokenFromGitCredential() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      cwd: ROOT,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const m = /^password=(.+)$/m.exec(out);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

/* 自上个 tag 以来的提交，用于生成发布说明 */
function recentCommits() {
  try {
    let prev = '';
    try { prev = execFileSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD^'],
      { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) {}
    const range = prev ? prev + '..HEAD' : '-15';
    return execFileSync('git', ['log', '--oneline', range],
      { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) { return ''; }
}

function defaultNotes(tag, assets) {
  const lines = [
    '一个住在你桌面的元认知陪练：在思维溢出之前，先存档，再落地。',
    '',
    '## 下载',
    '- **安装版**：可选安装目录，自动创建桌面 / 开始菜单快捷方式',
    '- **便携版**：双击即用，无需安装',
    ''
  ];
  const commits = recentCommits();
  if (commits) { lines.push('## 本次更新'); lines.push('```'); lines.push(commits); lines.push('```'); lines.push(''); }
  lines.push('> 首次启动后：右键桌宠 → 设置 → AI 对话，填入接口地址与 API Key 即可使用 AI 功能。');
  return lines.join('\n');
}

async function api(token, url, opts) {
  opts = opts || {};
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign({
      'User-Agent': 'Save4-Release',
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token
    }, opts.headers || {}),
    body: opts.body,
    signal: AbortSignal.timeout(1800000)
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status + ' ' + text.slice(0, 300));
    e.status = res.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

/* 清掉未完成的资产（上传中断会留下 state=starter 的半截文件） */
async function cleanIncomplete(token, owner, repo, releaseId) {
  const list = await api(token, `${API}/repos/${owner}/${repo}/releases/${releaseId}/assets`);
  for (const a of list || []) {
    if (a.state !== 'uploaded') {
      console.log('  清理未完成的资产: ' + a.name + ' (state=' + a.state + ')');
      await api(token, `${API}/repos/${owner}/${repo}/releases/assets/${a.id}`, { method: 'DELETE' });
    }
  }
  return (list || []).filter((a) => a.state === 'uploaded');
}

async function uploadOnce(token, owner, repo, releaseId, file) {
  const abs = path.join(ROOT, file);
  const name = path.basename(abs);
  const buf = fs.readFileSync(abs);
  const res = await fetch(
    `${UPLOADS}/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        'User-Agent': 'Save4-Release',
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length)
      },
      body: buf,
      signal: AbortSignal.timeout(1800000)
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 300));
  return JSON.parse(text);
}

/* ---------- 主流程 ---------- */
(async () => {
  const p = pkg();
  const tag = process.argv[2] || ('v' + p.version);
  const target = repoFromGit();
  if (!target) { console.error('无法从 git remote 解析 owner/repo（请确认已配置 origin）'); process.exit(1); }
  const { owner, repo } = target;

  const token = process.env.GH_TOKEN || tokenFromGitCredential();
  if (!token) {
    console.error('未取得 GitHub Token。请先执行一次 git push（凭据会被记住），或设置环境变量 GH_TOKEN');
    process.exit(1);
  }

  const dir = path.join(ROOT, 'release');
  const assets = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f)).map((f) => path.join('release', f))
    : [];
  if (!assets.length) {
    console.error('release/ 下没有 exe。请先构建：npm run dist');
    process.exit(1);
  }

  console.log('仓库   : ' + owner + '/' + repo);
  console.log('标签   : ' + tag);
  console.log('待上传 : ' + assets.map((a) => path.basename(a)).join(', '));
  console.log('代理   : ' + (PROXY || '(直连)') + '\n');

  // 1) 找到或创建 Release
  let rel = null;
  try {
    rel = await api(token, `${API}/repos/${owner}/${repo}/releases/tags/${tag}`);
    console.log('已存在 Release: ' + rel.id);
  } catch (e) {
    if (e.status !== 404) throw e;
    const notesFile = path.join(ROOT, 'RELEASE_NOTES.md');
    const body = fs.existsSync(notesFile)
      ? fs.readFileSync(notesFile, 'utf8')
      : defaultNotes(tag, assets);
    rel = await api(token, `${API}/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: p.productName + ' ' + tag,
        body: body,
        draft: false,
        prerelease: false
      })
    });
    console.log('已创建 Release: ' + rel.id + ' → ' + rel.html_url);
  }

  // 2) 清理半截资产
  const done = await cleanIncomplete(token, owner, repo, rel.id);

  // 3) 逐个上传（每项最多 3 次）
  let allOk = true;
  for (const f of assets) {
    const name = path.basename(f);
    const uploaded = done.find((a) => a.name === name || a.name === name.replace(/ /g, '.'));
    if (uploaded) { console.log('已存在，跳过: ' + uploaded.name); continue; }

    const mb = (fs.statSync(path.join(ROOT, f)).size / 1024 / 1024).toFixed(1);
    let ok = false;
    for (let i = 1; i <= 3 && !ok; i++) {
      console.log('上传 ' + name + ' (' + mb + ' MB) · 第 ' + i + '/3 次…');
      try {
        const j = await uploadOnce(token, owner, repo, rel.id, f);
        console.log('  ✔ ' + j.name + '  ' + (j.size / 1024 / 1024).toFixed(1) + ' MB');
        console.log('    ' + j.browser_download_url);
        ok = true;
      } catch (e) {
        console.log('  ✗ 失败: ' + (e.cause?.code || e.message));
        if (i < 3) { await cleanIncomplete(token, owner, repo, rel.id).catch(() => {}); await sleep(4000); }
      }
    }
    if (!ok) allOk = false;
  }

  const final = await api(token, `${API}/repos/${owner}/${repo}/releases/${rel.id}/assets`);
  console.log('\n最终资产：');
  (final || []).forEach((a) => console.log('  - ' + a.name + '  ' + (a.size / 1024 / 1024).toFixed(1) + 'MB  ' + a.state));
  console.log(allOk ? '\n✅ 完成 → ' + rel.html_url : '\n❌ 有文件未传完，可重跑本脚本（会自动续传缺失项）');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('失败:', e.cause?.code || e.message); process.exit(1); });
