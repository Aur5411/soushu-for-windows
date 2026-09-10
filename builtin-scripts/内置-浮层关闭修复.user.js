// ==UserScript==
// @name         浮层关闭修复（内置）
// @namespace    soushu.builtin
// @version      1.0.0
// @description  修复「购买附件后 register/login 浮层关不掉」。站点装的 boan_h5upload 插件引入 jQuery 并执行 noConflict()，Discuz 的 $() 被干扰后 hideWindow 定位不到浮层
// @author       搜书吧
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  if (window.__dzFloatFix) return;
  window.__dzFloatFix = 1;

  function byId(id) {
    return document.getElementById(id);
  }

  // 强制关闭某个浮层 key：移除 fwin_<k> 与遮罩，清理 append_parent 下的孤儿浮层
  function forceClose(k) {
    try {
      var el = byId('fwin_' + k);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      var cover = byId('fwin_' + k + '_cover');
      if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
    } catch (e) {}

    // 兜底：移除所有 fwin_* 浮层（含遮罩），确保购买/登录/注册等任何浮层都能真正关掉
    try {
      var all = document.querySelectorAll('[id^="fwin_"]');
      for (var i = 0; i < all.length; i++) {
        var n = all[i];
        if (n && n.parentNode && /^fwin_/.test(n.id) && !/_content_/.test(n.id)) {
          n.parentNode.removeChild(n);
        }
      }
    } catch (e) {}

    try {
      var ap = byId('append_parent');
      if (ap) ap.style.display = 'none';
    } catch (e) {}
  }

  // 重写 hideWindow：先走原实现(若存在)，再强制 DOM 移除兜底
  try {
    var orig = window.hideWindow;
    window.hideWindow = function (k) {
      try {
        if (orig) orig.apply(this, arguments);
      } catch (e) {}
      forceClose(k);
    };
  } catch (e) {}

  // 捕获阶段点击兜底：onclick 里写 hideWindow('xxx') 的关闭按钮，确保真正关掉
  try {
    document.addEventListener(
      'click',
      function (e) {
        var n = e.target;
        var hops = 0;
        while (n && n.nodeType === 1 && hops++ < 6) {
          var oc = (n.getAttribute && n.getAttribute('onclick')) || '';
          var m = /hideWindow\s*\(\s*['"]([^'"]+)['"]/.exec(oc);
          if (m) forceClose(m[1]);
          n = n.parentNode;
        }
      },
      true
    );
  } catch (e) {}

  // MutationObserver：浮层是新插入的，监听以保证关闭能力始终存在
  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (!node || node.nodeType !== 1) continue;
          if (node.id && /^fwin_/.test(node.id)) {
            try {
              var btns = node.querySelectorAll('[onclick*="hideWindow"]');
              for (var b = 0; b < btns.length; b++) {
                (function (btn) {
                  btn.addEventListener('click', function () {
                    var m = /(['"])([^'"]+)\1/.exec(btn.getAttribute('onclick') || '');
                    if (m) forceClose(m[2]);
                  });
                })(btns[b]);
              }
            } catch (e) {}
          }
        }
      }
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch (e) {}
})();
