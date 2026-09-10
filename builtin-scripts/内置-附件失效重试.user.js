// ==UserScript==
// @name         附件失效自动重试（内置）
// @namespace    soushu.builtin
// @version      1.0.0
// @description  免银币脚本伪造签名下载时，Discuz 会返回「原附件链接已失效」提示页；该页内含「点击这里重新下载」链接，这里自动点掉，完成下载无需手动
// @author       搜书吧
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  if (window.__dzRetryAttach) return;
  window.__dzRetryAttach = 1;
  try {
    var mt = document.getElementById('messagetext');
    if (!mt) return;
    var txt = mt.textContent || mt.innerText || '';
    if (txt.indexOf('原附件链接已失效') < 0 && txt.indexOf('重新下载') < 0) return;
    var link = mt.querySelector('a[href*="mod=attachment"]') || mt.querySelector('a[href*="aid="]');
    if (link) {
      var href = link.getAttribute('href') || link.href || '';
      if (href && href.indexOf('mod=attachment') >= 0) {
        // 延迟一点确保页面稳定，再触发导航（走下载拦截链路）
        setTimeout(function () {
          try {
            window.location.href = href;
          } catch (e) {}
        }, 300);
      }
    }
  } catch (e) {}
})();
