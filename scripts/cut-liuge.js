/* ════════════════════════════════════════════════════════════
   Save4 — 抠图脚本：刘哥点赞.jpg → liuge.png（透明背景）
   做法：遍历像素，把「接近纯白」的抠成透明（alpha=0），
   白色过渡区保留部分透明，避免边缘锯齿/白边。
   用法: node scripts/cut-liuge.js

   注意：源图与产物均为真人照片素材，因涉及他人肖像，
   未包含在本开源仓库中（见 .gitignore）。
   如需自行制作：把源图放到项目根目录并命名为「刘哥点赞.jpg」后运行本脚本。
   ════════════════════════════════════════════════════════════ */
'use strict';

const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, '..', '刘哥点赞.jpg');
const OUT = path.join(__dirname, '..', 'liuge.png');

// RGB 三通道都高于此值视为“背景白”（头部/身体颜色一般有一通道偏低）
const BG = 232;
const EDGE = 200; // 低于此值不透明，之间做过渡

async function main() {
  const img = sharp(SRC);
  const meta = await img.metadata();
  console.log('原始尺寸: %s x %s', meta.width, meta.height);

  const data = await img
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer();

  const ch = 4; // RGBA
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // 用“最暗通道”判断是否偏白（避免把浅色衣服误删）
    const min = Math.min(r, g, b);
    if (min >= BG) {
      data[i + 3] = 0;               // 纯白 → 完全透明
    } else if (min >= EDGE) {
      // 过渡区：按比例给部分透明，圆滑边缘
      const a = Math.round(255 * (1 - (min - EDGE) / (BG - EDGE)));
      data[i + 3] = 255 - Math.max(0, Math.min(255, a));
    } else {
      data[i + 3] = 255;             // 主体 → 不透明
    }
  }

  await sharp(data, { raw: { width: meta.width, height: meta.height, channels: ch } })
    .png()
    .toFile(OUT);
  console.log('完成 → %s', OUT);
}

main().catch((e) => { console.error('抠图失败:', e); process.exit(1); });
