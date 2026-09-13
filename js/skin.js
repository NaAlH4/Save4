/* ════════════════════════════════════════════════════════════
   Save4 — skin.js  （自定义桌宠形象）
   导入一张图片 → 作为新的桌宠皮肤。处理全部在本地 Canvas 完成。

   两种处理方式（设置里可切换）：
   - 自动抠图(auto)：从四边泛洪填充去除背景，再裁出主体
   - 保留原图(none)：完全不改像素，只裁掉四周透明留白并缩放
     ※ 导入的图片若本身已带透明通道（如透明 PNG），会自动切到「保留原图」，
       避免多余的抠图破坏原图；用户仍可手动改回自动抠图。

   抠图算法（auto 模式）：
   - 背景参考色 = 边框不透明像素的主色（量化直方图取众数）
   - 仅当邻居颜色接近当前像素、且与背景色差距在容差内才扩散 → 跨轮廓即停
   - 因此主体内部的背景色区域不会被误删
   - 羽化仅作用于「紧贴已抠除区域」的过渡像素

   存储：localStorage（key: skin.custom），随「数据导出/导入」一起备份迁移
   数据结构：{ v, dataUrl, w, h, mode, createdAt }
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = function () { return global.Save4.store; };
  var CUSTOM_KEY = 'skin.custom';

  var MAX_PROC = 800;    // 处理前先缩到该边长内（提速、降噪）
  var MAX_OUT = 384;     // 最终保存的最大边长
  var MAX_BYTES = 1600000;

  var els = {};
  var currentFile = null;
  var currentBitmap = null;   // 缓存解码结果，调参/切模式时无需重新解码
  var sourceHasAlpha = false; // 源图是否自带透明通道
  var mode = 'auto';          // 'auto' | 'none'
  var pending = null;
  var tolTimer = null;

  /* ══════════ 纯算法：对 ImageData 去背景（可在 Node 中单测） ══════════ */
  function cutData(img, tolerance) {
    var w = img.width, h = img.height, d = img.data;
    var N = w * h;
    var visited = new Uint8Array(N);
    var queue = new Int32Array(N);
    var qh = 0, qt = 0;

    // ---- 1) 边框像素统计 ----
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

    // 已带透明背景 → 不做抠图（由「保留原图」处理）
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

    var LOCAL = 16;
    border.forEach(function (i) {
      if (visited[i]) return;
      if (d[i * 4 + 3] < 10) { visited[i] = 1; return; }
      if (distRef(i) <= tolerance) { visited[i] = 1; queue[qt++] = i; }
    });

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

    // ---- 写回 alpha（背景透明 + 仅边缘羽化） ----
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
      if (dr2 > tolerance && dr2 < softMax && adjacentToVisited(k)) {
        var a = Math.round(255 * (dr2 - tolerance) / (softMax - tolerance));
        d[p2 + 3] = Math.max(0, Math.min(255, a));
      }
    }
    return { skipped: false };
  }

  /* ══════════ 图像工具 ══════════ */
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

  /* 裁掉四周透明留白（只裁透明区域，不裁任何不透明内容） */
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
    if (maxX < 0) return canvas;   // 整张透明（异常图）→ 原样返回
    // 四周本就没有透明像素 → 无需裁剪
    if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return canvas;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    var cw = maxX - minX + 1, ch = maxY - minY + 1;
    var out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /* 探测源图是否自带透明通道
     统计整张图（缩略到 200px 内）的透明像素占比：
     只看边框会漏判「主体占满画面、透明区在内部」的图，从而误当作需要抠图。 */
  function probeAlpha(bmp) {
    var c = drawToCanvas(bmp, 200);
    var w = c.width, h = c.height;
    var d = c.getContext('2d').getImageData(0, 0, w, h).data;
    var total = w * h, clear = 0;
    for (var i = 0; i < total; i++) {
      if (d[i * 4 + 3] < 10) clear++;
    }
    return total > 0 && (clear / total) > 0.03;   // 有 3% 以上透明像素 → 认为自带透明
  }

  /* ══════════ 主处理：由缓存的位图渲染结果 ══════════ */
  function renderFromBitmap(bmp, tolerance, useMode) {
    var stage = drawToCanvas(bmp, MAX_PROC);
    var ctx = stage.getContext('2d');
    var cut = false, skipped = false;

    if (useMode !== 'none') {
      var img = ctx.getImageData(0, 0, stage.width, stage.height);
      var r = cutData(img, tolerance);
      if (r.skipped) {
        skipped = true;               // 原图已透明 → 按原图处理
      } else {
        ctx.putImageData(img, 0, 0);
        cut = true;
      }
    }

    var cropped = cropToSubject(stage, 2);
    var fitted = fitCanvas(cropped, MAX_OUT);
    var dataUrl = fitted.toDataURL('image/png');
    if (dataUrl.length > MAX_BYTES) {
      fitted = fitCanvas(fitted, 256);
      dataUrl = fitted.toDataURL('image/png');
    }
    return {
      canvas: fitted, dataUrl: dataUrl,
      w: fitted.width, h: fitted.height,
      cut: cut, skipped: skipped
    };
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
    var how = res.skipped ? '原图已透明，按原图保留'
            : (res.cut ? '已自动抠图' : '保留原图（未抠图）');
    els.info.textContent = res.w + '×' + res.h + ' · 约 ' + kb + 'KB · ' + how;
  }

  function syncModeUI() {
    document.querySelectorAll('input[name="skinMode"]').forEach(function (r) {
      r.checked = (r.value === mode);
    });
    if (els.tolRow) els.tolRow.style.display = (mode === 'none') ? 'none' : '';
  }

  function setMode(m) {
    mode = (m === 'none') ? 'none' : 'auto';
    syncModeUI();
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
    var payload = {
      v: 1, dataUrl: pending.dataUrl, w: pending.w, h: pending.h,
      mode: pending.skipped ? 'none' : mode, createdAt: Date.now()
    };
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
    pending = null; currentFile = null; currentBitmap = null;
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
    currentBitmap = null;
    els.previewWrap.classList.remove('hidden');
    els.info.textContent = '处理中…';

    loadBitmap(file).then(function (bmp) {
      if (file !== currentFile) return;   // 期间换了图片
      currentBitmap = bmp;
      sourceHasAlpha = probeAlpha(bmp);
      // 自带透明通道 → 默认「保留原图」，避免多余抠图破坏原图
      setMode(sourceHasAlpha ? 'none' : 'auto');
      render();
    }).catch(function (e) {
      els.info.textContent = '处理失败：' + (e && e.message || e);
    });
  }

  function render() {
    if (!currentBitmap) return;
    var tol = Number(els.tolerance.value) || 60;
    try {
      pending = renderFromBitmap(currentBitmap, tol, mode);
    } catch (e) {
      els.info.textContent = '处理失败：' + (e && e.message || e);
      return;
    }
    drawPreview(pending.canvas);
    setInfo(pending);
    els.saveBtn.disabled = false;
  }

  function scheduleRender() {
    if (tolTimer) clearTimeout(tolTimer);
    tolTimer = setTimeout(render, 200);
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
    els.tolRow = document.getElementById('skin-tol-row');
    els.info = document.getElementById('skin-info');
    els.optCustom = document.getElementById('skin-opt-custom');
    els.petImg = document.getElementById('pet-img-custom');

    if (!els.file || !els.preview) return;

    // 先恢复已保存的自定义形象（必须早于 app.js 读取皮肤）
    loadStored();
    syncModeUI();

    els.pickBtn.addEventListener('click', function () { els.file.value = ''; els.file.click(); });
    els.file.addEventListener('change', function () {
      handleFile(els.file.files && els.file.files[0]);
    });
    els.saveBtn.addEventListener('click', save);
    els.delBtn.addEventListener('click', remove);

    document.querySelectorAll('input[name="skinMode"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        setMode(r.value);
        render();                     // 切换处理方式后立即重算
      });
    });

    els.tolerance.addEventListener('input', function () {
      els.tolVal.textContent = els.tolerance.value;
      scheduleRender();
    });

    var stored = S().read(CUSTOM_KEY, null);
    if (stored && stored.dataUrl) {
      els.tolVal.textContent = els.tolerance.value;
      if (stored.mode) setMode(stored.mode);
      els.info.textContent = '当前已有自定义形象（' + stored.w + '×' + stored.h + '），可重新导入替换';
    }
  }

  global.Save4 = global.Save4 || {};
  global.Save4.skin = {
    init: init,
    cutData: cutData,                  // 纯算法（可单测）
    probeAlpha: probeAlpha,
    renderFromBitmap: renderFromBitmap,
    loadStored: loadStored,
    save: save,
    remove: remove
  };
})(window);
