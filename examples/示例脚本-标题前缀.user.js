// ==UserScript==
// @name         示例 · 页面标题加个前缀
// @namespace    scriptdock.example
// @version      1.0.0
// @description  演示脚本坞的完整用法：document-end 时机改 DOM + 用 GM 存储记住访问次数
// @author       ScriptDock
// @match        *://*.example.com/*
// @match        https://www.bing.com/*
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // GM 存储：记录这个站点被打开过几次
  var host = location.host;
  var key = 'visits:' + host;
  var visits = Number(GM_getValue(key, 0)) + 1;
  GM_setValue(key, visits);

  // 改标题
  document.title = '[' + visits + '] ' + document.title;

  // 右下角挂一个提示条
  GM_addStyle(
    '#scriptdock-demo{' +
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
      'padding:8px 14px;border-radius:10px;' +
      'background:#3b6ef5;color:#fff;font:13px/1.5 "Microsoft YaHei",sans-serif;' +
      'box-shadow:0 6px 18px rgba(59,110,245,.35);' +
    '}'
  );

  var tip = document.createElement('div');
  tip.id = 'scriptdock-demo';
  tip.textContent = '脚本坞已注入 · ' + host + ' 第 ' + visits + ' 次访问';
  document.body.appendChild(tip);

  setTimeout(function () {
    tip.style.transition = 'opacity .4s';
    tip.style.opacity = '0';
    setTimeout(function () {
      tip.remove();
    }, 400);
  }, 3000);

  GM_log('示例脚本执行完成，累计访问 ' + visits + ' 次');
})();
