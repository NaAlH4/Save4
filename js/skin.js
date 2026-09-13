/* ════════════════════════════════════════════════════════════
   Save4 — skin.js  （自定义桌宠形象）
   导入一张图片 → 自动去除背景、裁剪到主体、缩放 → 作为新的桌宠皮肤。
   处理全部在本地 Canvas 完成（不上传任何数据）。

   抠图算法：从图片四边向内「泛洪填充」（类似魔棒连续选择）
   - 背景参考色 = 边框像素的主色（量化直方图取众数）
   - 仅当邻居与当前像素颜色接近(局部连续性)且与背景色差距在容差内才扩散
   - 因此主体内部的白色区域不会被误删（泛洪到不了）
   - 边缘做半透明羽化，减少锯齿与白边

   存储：localStorage（key: skin.custom），随「数据导出/导入」一起备份迁移
   数据结构：{ v, dataUrl, w, h, createdAt }
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var CUSTOM_KEY = 'skin.custom';

  var MAX_PROC = 800;   // 抠图前先缩到该边长内（提速、降噪）
  var MAX_OUT = 384;    // 最终保存的最大边长
  var MAX_BYTES = 1600000; // dataUrl 体积上限（localStorage 约 5MB）

  var els = {};
  var currentFile = null;   // 待处理的源文件
  var pending = null;       // 处理结果 { dataUrl, w, h, canvas }
  var tolTimer = null;

  /* ══════════ 纯算法：对 ImageData 做背景去除（可在 Node 中单测） ══════════ */
  /* img: { width, height, data }  tolerance: 背景色容差(0-255)
     返回 { skipped: true } 表示原图已带透明通道、无需处理 */
  function cutData(img, tolerance) {
    var w = img.width, h = img.height, d = img.data;
    var N = w * h;
    var visited = new Uint8Array(N);
    var queue = new Int32Array(N);
    var qh = 0, qt = 0;

    // ---- 1) 收集边框像素，统计主色 ----
    var border = [];
    for (var x = 0; x < w; x++) { border.push(x); border.push((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { border.push(y * w); border.push(y * w + w - 1); }

    var hist = {};
    var opaque = 0, transparent = 0;
    border.forEach(function (i) {
      var p = i * 4;
      if (d[p + 3] < 10) { transparent++; return; }
      opaque++;
      var key = (d[p] >> 4) + ',' + (d[p + 1] >> 4) + ',' + (d[p + 2] >> 4);
      var e = hist[key] || (hist[key] = { n: 0, r: 0, g: 0, b: 0 });
      e.n++; e.r += d[p]; e.g += d[p + 1]; e.b += d[p + 2];
    });

    // 原图已经是透明背景（如 PNG 抠图）→ 跳过抠图，只做裁剪缩放
    if (opaque === 0 || transparent / (transparent + opaque) > 0.25) return { skipped: true };

    var bestKey = null;
    Object.keys(hist).forEach(function (k) { if (!bestKey || hist[k].n > hist[bestKey].n) bestKey = k; });
    var be = hist[bestKey];
    var refR = be.r / be.n, refG = be.g / be.n, refB = be.b / be.n;

    function distRef(i) {
      var p = i * 4;
      var dr = d[p] - refR, dg = d[p + 1] - refG, db = d[p + 2] - refB;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    }
    function distPix(a, b) {
      var pa = a * 4, pb = b * 4;
      var dr = d[pa] - d[pb], dg = d[pa + 1] - d[pb + 1], db = d[pa + 2] - d[pb + 2];
      return Math.sqrt(dr * dr + dg * dg + db * db);
    }

    var LOCAL = 16;  // 局部连续性步长：跨越明显轮廓线时停止扩散

    // ---- 2) 种子：边框上接近背景色的像素 ----
    border.forEach(function (i) {
      if (visited[i]) return;
      if (d[i * 4 + 3] < 10) { visited[i] = 1; return; }   // 本来就透明 → 算背景
      if (distRef(i) <= tolerance) { visited[i] = 1; queue[qt++] = i; }
    });

    // ---- 3) 泛洪扩散 ----
    function tryPush(j, from) {
      if (visited[j]) return;
      if (distPix(j, from) <= LOCAL && distRef(j) <= tolerance) {
        visited[j] = 1; queue[qt++] = j;
      }
    }
    while (qh < qt) {
      var i = queue[qh++];
      var ix = i % w, iy = (i / w) | 0;
      if (ix > 0) tryPush(i - 1, i);
      if (ix < w - 1) tryPush(i + 1, i);
      if (iy > 0) tryPush(i - w, i);
      if (iy < h - 1) tryPush(i + w, i);
    }

    // ---- 4) 写回 alpha（背景全透明 + 边缘羽化） ----
    // 羽化只作用于「紧邻已抠除区域」的过渡像素：
    // 否则被主体包围的、恰好也是背景色的区域（如白衣服上的白底花纹）会被误清空。
    var softMax = tolerance * 1.35;
    var canFeather = softMax > tolerance;

    function adjacentToVisited(k) {
      var kx = k % w, ky = (k / w) | 0;
      if (kx > 0 && visited[k - 1]) return true;
      if (kx < w - 1 && visited[k + 1]) return true;
      if (ky > 0 && visited[k - w]) return true;
      if (ky < h - 1 && visited[k + w]) return true;
      return false;
    }

    for (var k = 0; k < N; k++) {
      var p2 = k * 4;
      if (visited[k]) { d[p2 + 3] = 0; continue; }
      if (!canFeather) continue;
      var dr2 = distRef(k);
      // 仅处理 (容差, 羽化上限) 之间的过渡色，且必须贴着已抠除区域
      if (dr2 > tolerance && dr2 < softMax && adjacentToVisited(k)) {
        var a = Math.round(255 * (dr2 - tolerance) / (softMax - tolerance));
        d[p2 + 3] = Math.max(0, Math.min(255, a));
      }
    }
    return { skipped: false };
  }

  /* ══════════ 图像工具（依赖 Canvas） ══════════ */
  function loadBitmap(file) {
    if (global.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  function drawToCanvas(src, maxSide) {
    var sw = src.width, sh = src.height;
    var scale = Math.min(1, maxSide / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c;
  }

  function fitCanvas(canvas, maxSide) {
    var w = canvas.width, h = canvas.height;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    if (scale >= 1) return canvas;
    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    var ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  /* 裁掉四周透明留白，只保留主体 */
  function cropToSubject(canvas, pad) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h), d = img.data;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return canvas;   // 整张都被判为背景
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    var cw = maxX - minX + 1, ch = maxY - minY + 1;
    var out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /* ══════════ 处理流水线 ══════════ */
  function processFile(file, tolerance) {
    return loadBitmap(file).then(function (bmp) {
      var stage = drawToCanvas(bmp, MAX_PROC);
      var ctx = stage.getContext('2d');
      var img = ctx.getImageData(0, 0, stage.width, stage.height);
      var r = cutData(img, tolerance);
      ctx.putImageData(img, 0, 0);
      var cropped = cropToSubject(stage, 2);
      var fitted = fitCanvas(cropped, MAX_OUT);
      var dataUrl = fitted.toDataURL('image/png');
      // 体积过大 → 再压一档
      if (dataUrl.length > MAX_BYTES) {
        fitted = fitCanvas(fitted, 256);
        dataUrl = fitted.toDataURL('image/png');
      }
      return { canvas: fitted, dataUrl: dataUrl, w: fitted.width, h: fitted.height, skipped: r.skipped };
    });
  }

  /* ══════════ 预览 ══════════ */
  function drawPreview(canvas) {
    var pv = els.preview;
    pv.width = canvas.width;
    pv.height = canvas.height;
    var ctx = pv.getContext('2d');
    ctx.clearRect(0, 0, pv.width, pv.height);
    ctx.drawImage(canvas, 0, 0);
  }

  function setInfo(res) {
    var kb = Math.round(res.dataUrl.length / 1024);
    els.info.textContent = res.w + '×' + res.h + ' · 约 ' + kb + 'KB'
      + (res.skipped ? ' · 检测到已是透明图，跳过抠背景' : '');
  }

  /* ══════════ 应用 / 保存 / 删除 ══════════ */
  function applyStored(payload) {
    var img = els.petImg;
    if (!img) return;
    img.src = payload.dataUrl;
    var ratio = payload.w / payload.h;
    if (global.Save4.app && global.Save4.app.registerCustomSkin) {
      global.Save4.app.registerCustomSkin({ ratio: ratio, w: payload.w, h: payload.h });
    }
    if (els.optCustom) els.optCustom.style.display = '';
  }

  function loadStored() {
    var p = S().read(CUSTOM_KEY, null);
    if (p && p.dataUrl && p.w && p.h) { applyStored(p); return p; }
    if (els.optCustom) els.optCustom.style.display = 'none';
    return null;
  }

  function save() {
    if (!pending) return;
    var payload = { v: 1, dataUrl: pending.dataUrl, w: pending.w, h: pending.h, createdAt: Date.now() };
    if (!S().write(CUSTOM_KEY, payload)) {
      if (global.Save4.bubble) global.Save4.bubble.enqueue({ text: '⚠️ 保存失败：图片过大，请换一张更简单的图' });
      return;
    }
    applyStored(payload);
    if (global.Save4.app && global.Save4.app.selectSkin) global.Save4.app.selectSkin('custom');
    if (global.Save4.bubble) global.Save4.bubble.enqueue({ text: '✅ 已保存为桌宠形象' });
  }

  function remove() {
    if (!global.confirm('确定删除自定义桌宠形象吗？')) return;
    S().write(CUSTOM_KEY, null);
    if (els.optCustom) els.optCustom.style.display = 'none';
    if (global.Save4.app && global.Save4.app.unregisterCustomSkin) {
      global.Save4.app.unregisterCustomSkin();
    }
    els.previewWrap.classList.add('hidden');
    els.saveBtn.disabled = true;
    pending = null;
    currentFile = null;
    els.file.value = '';
    els.info.textContent = '';
    if (global.Save4.bubble) global.Save4.bubble.enqueue({ text: '已删除自定义形象' });
  }

  /* ══════════ 导入交互 ══════════ */
  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      if (global.Save4.bubble) global.Save4.bubble.enqueue({ text: '请选择图片文件' });
      return;
    }
    currentFile = file;
    els.previewWrap.classList.remove('hidden');
    els.info.textContent = '处理中…';
    reprocess();
  }

  function reprocess() {
    if (!currentFile) return;
    var tol = Number(els.tolerance.value) || 60;
    var file = currentFile;
    processFile(file, tol).then(function (res) {
      if (file !== currentFile) return;   // 期间换了图片
      pending = res;
      drawPreview(res.canvas);
      setInfo(res);
      els.saveBtn.disabled = false;
    }).catch(function (e) {
      els.info.textContent = '处理失败：' + (e && e.message || e);
    });
  }

  /* ══════════ 初始化 ══════════ */
  function init() {
    els.file = document.getElementById('skin-file');
    els.pickBtn = document.getElementById('btn-skin-pick');
    els.saveBtn = document.getElementById('btn-skin-save');
    els.delBtn = document.getElementById('btn-skin-del');
    els.preview = document.getElementById('skin-preview');
    els.previewWrap = document.getElementById('skin-preview-wrap');
    els.tolerance = document.getElementById('skin-tolerance');
    els.tolVal = document.getElementById('skin-tol-val');
    els.info = document.getElementById('skin-info');
    els.optCustom = document.getElementById('skin-opt-custom');
    els.petImg = document.getElementById('pet-img-custom');

    if (!els.file || !els.preview) return;   // 页面缺元素时安全退出

    // 先恢复已保存的自定义形象（必须在 app.js 读取皮肤之前完成注册）
    loadStored();

    els.pickBtn.addEventListener('click', function () { els.file.value = ''; els.file.click(); });
    els.file.addEventListener('change', function () {
      handleFile(els.file.files && els.file.files[0]);
    });
    els.saveBtn.addEventListener('click', save);
    els.delBtn.addEventListener('click', remove);

    els.tolerance.addEventListener('input', function () {
      els.tolVal.textContent = els.tolerance.value;
      if (tolTimer) clearTimeout(tolTimer);
      tolTimer = setTimeout(reprocess, 260);   // 拖动滑块时防抖重算
    });

    // 已有自定义形象 → 允许直接重新处理/预览
    var stored = S().read(CUSTOM_KEY, null);
    if (stored && stored.dataUrl) {
      els.tolerance.value = els.tolerance.value; // 保持默认
      els.tolVal.textContent = els.tolerance.value;
      els.info.textContent = '当前已有自定义形象（' + stored.w + '×' + stored.h + '），可重新导入替换';
    }
  }

  global.Save4 = global.Save4 || {};
  global.Save4.skin = {
    init: init,
    cutData: cutData,          // 暴露纯算法便于测试
    loadStored: loadStored,
    save: save,
    remove: remove
  };
})(window);
