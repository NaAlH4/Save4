/* ════════════════════════════════════════════════════════════
   Save4 — pet.js  （M2/M4 桌宠模块）
   表情状态机 + 情绪动画（作用范围:#pet-body，SVG 猫与立绘皮肤通用）。
   - 表情: Save4.pet.setExpression('idle'|'happy'|'angry')
   - 动画: Save4.pet.fx('happy'|'angry')   （跳起/炸毛抖动）
   - 开心反馈: Save4.pet.celebrate()      （表情+动画，短暂恢复）
   - 皮肤: Save4.pet.setSkin(key)  → 在 #pet 上切换 body[data-skin]
   注意: 立绘皮肤是静态图，无法切换五官，setExpression 仅在
   SVG 皮肤时真正生效；对立绘仅保留"情绪动画"（跳/抖）。
   ════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var svg = null;        // #pet-svg
  var body = null;       // #pet-body（动画作用层）
  var root = null;       // #pet（容器）
  var exprClass = 'pet-expr-idle';
  var resetTimer = null;

  function setExpression(name) {
    if (!svg) return;
    svg.classList.remove(exprClass);
    exprClass = 'pet-expr-' + name;
    svg.classList.add(exprClass);
  }

  /* 播放一次性情绪动画（挂在 #pet-body，动画结束后自动移除类） */
  function fx(name) {
    if (!body) return;
    var cls = 'fx-' + name;
    body.classList.remove('fx-happy', 'fx-angry');
    // 强制重排以重启动画
    void body.getBoundingClientRect();
    body.classList.add(cls);
  }

  /* 开心反馈：眯眼笑 + 小跳，一段时间后回到 idle */
  function celebrate(ms) {
    if (!body) return;
    setExpression('happy');
    fx('happy');
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(function () { setExpression('idle'); }, ms || 900);
  }

  /* 切换皮肤: 'cat' | 'anime'（作用在 body 上，与 app.js 一致） */
  function setSkin(key) {
    if (document.body) document.body.setAttribute('data-skin', key || 'cat');
  }

  function init() {
    svg = document.getElementById('pet-svg');
    body = document.getElementById('pet-body');
    root = document.getElementById('pet');
    setExpression('idle');
    // 动画结束自动移除 fx 类
    if (body) {
      body.addEventListener('animationend', function (e) {
        if (e.animationName && e.animationName.indexOf('fx-') === 0) {
          body.classList.remove('fx-happy', 'fx-angry');
        }
      });
    }
  }

  global.Save4 = global.Save4 || {};
  global.Save4.pet = {
    init: init,
    setExpression: setExpression,
    fx: fx,
    celebrate: celebrate,
    setSkin: setSkin
  };
})(window);
