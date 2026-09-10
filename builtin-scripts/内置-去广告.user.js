// ==UserScript==
// @name         去广告（内置）
// @namespace    soushu.builtin
// @version      1.0.0
// @description  Discuz 常见广告容器 + 帖内图片外显屏蔽。用 CSS 隐藏而不是删除节点 —— 页面自身脚本可能引用这些节点，物理删除会导致脚本读 null 报错
// @author       搜书吧
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  var css = '#float_left,#float_right,.a_pt,.a_pb,.a_pr,.a_mu,.a_fl,.a_fr,#scbar_ad,#ad_content,.float_ad,#right_ads,.ads,.adbox,a[href*="cpro.baidu.com"],iframe[src*="pos.baidu.com"],div[id^="ad_"]{display:none !important;}';
  css += '.t_f img,.t_f a[href*="mod=attachment"] img,td.t_f img,img[id^="aimg_"],img.zoom{display:none!important;}';
  try {
    var s = document.createElement('style');
    s.type = 'text/css';
    s.setAttribute('data-scriptdock', '去广告（内置）');
    s.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
