// ==UserScript==
// @name         搜书吧免银币下载
// @namespace    com.junzi.kanshu
// @version      1.0
// @description  搜书吧
// @author       Fuck
// @match       *://*/forum.php?mod=viewthread&tid=*
// @run-at       document-end
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yousuu.com
// @grant        none
// ==/UserScript==

(() => {
  const dl = h => {
    const n = (h || '').match(/\d{3,}/g);
    return n && n.length > 1 ? `?mod=attachment&aid=${btoa([n[0], 1, 1, 1, n[1]].join('|'))}` : null;
  };
  document.querySelectorAll('.buttons').forEach(b => {
    if (b.dataset.p) return;
    const a = b.querySelector('a');
    const href = a ? a.getAttribute('href') : '';
    if (!/mod=attachment|aid=|attachment|download/i.test(href)) return;
    const url = dl(href);
    if (url) {
      b.dataset.p = '1';
      b.innerHTML = `<a href="${url}" target="_self">免银币下载</a>`;
    }
  });
})();
