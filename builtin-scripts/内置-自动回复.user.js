// ==UserScript==
// @name         自动回复解锁
// @namespace    soushu.builtin
// @version      2.2.6
// @description  楼主 1 楼有「回复可见」隐藏内容（[hide]）且无「可见的」付费/购买按钮时，静默自动回复并刷新解锁。付费判断覆盖：attachpay 链接、购买/付费按钮、「售价 X 金币」标记（点击文件即付费的付费附件）；排除淘专辑/标签/合集等名字带「购买」的非付费导航链接。回复成功后 61 秒冷却倒计时独立运行
// @author       DiscuzNovel
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (window.__dzAutoReply) return; window.__dzAutoReply = 1;

    // ===== 可自定义参数 =====
    var REPLY_TEXT = '谢谢楼主辛苦分享，让我看看隐藏的内容';   // ≥15字，避免论坛字数限制
    var COOLDOWN_MS = 61000;   // 回复成功后冷却 61 秒
    // ========================

    var pollCount = 0;

    function log(s) {
        try { if (window.console && console.log) console.log('[自动回复] ' + s); } catch (e) {}
    }

    log('脚本已加载 URL=' + location.href);

    function getLastSuccess() {
        try { var v = localStorage.getItem('__dzLastReplySuccess'); return v ? parseInt(v, 10) : 0; } catch (e) { return 0; }
    }
    function setLastSuccess() {
        try { localStorage.setItem('__dzLastReplySuccess', String(Date.now())); } catch (e) {}
    }

    // 定位楼主 1 楼容器
    function getFirstFloor() {
        try {
            var f = document.querySelector('#postlist [id^="post_"]');
            if (f) return f;
            var m = document.querySelector('[id^="postmessage_"]');
            if (m) return m.closest('[id^="post_"]') || m;
            var p = document.querySelector('.plhin');
            if (p) return p;
            return null;
        } catch (e) { return null; }
    }

    // 元素是否「可见」：自身及祖先无 display:none / visibility:hidden / opacity:0，且非零尺寸
    function isVisible(el) {
        if (!el) return false;
        try {
            var n = el;
            while (n && n.nodeType === 1) {
                var s = window.getComputedStyle(n);
                if (!s || s.display === 'none' || s.visibility === 'hidden') return false;
                if (parseFloat(s.opacity) === 0) return false;
                n = n.parentElement;
            }
            var r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return false;
            return true;
        } catch (e) { return true; }  // 计算失败时保守按可见处理，避免漏掉真付费
    }

    // 判断某个「购买/付费」按钮是否本质是「回复可见/0银」门控（回复即可解锁，不算真付费）
    function isReplyVisibleGate(el) {
        try {
            var nodes = [], n = el;
            for (var k = 0; k < 3 && n && n.nodeType === 1; k++) {
                nodes.push(n);
                n = n.parentElement;
            }
            var t = '';
            for (var k = 0; k < nodes.length; k++) t += (nodes[k].textContent || '') + ' ';
            return /回复可见|回复即可|回复后|0银|免费|回帖/.test(t);
        } catch (e) { return false; }
    }

    // 判断一个 <a> 链接是否指向「付费/购买」动作页；排除淘专辑(mod=collection)、标签(mod=tag)、
    // 合集等普通导航链接（这些只是名字里带"购买"字样，实际不是付费动作）
    function isPayHref(el) {
        try {
            if (el.tagName && el.tagName.toLowerCase() !== 'a') return false;
            var href = (el.getAttribute && el.getAttribute('href')) || '';
            if (!href) return false;
            // 明确排除：淘专辑/合集、标签、空间、版块列表、帖子正文、门户等非付费链接
            // 注意 mod=misc&action=attachpay 是真正的付费附件链接，不能排除
            if (/mod=(collection|tag|space|forumdisplay|viewthread|guide)|space-uid|home\.php/.test(href)) return false;
            // 明确付费特征：attachpay / 购买动作 / 积分支付
            return /attachpay|action=(pay|buy)|buyattach|payto|credits/.test(href);
        } catch (e) { return false; }
    }

    // 元素描述：用于诊断日志，输出标签/class/href/display/visibility + 一段 outerHTML
    function desc(el) {
        try {
            var st = window.getComputedStyle(el);
            var cls = (typeof el.className === 'string') ? el.className : '';
            var href = (el.getAttribute && el.getAttribute('href')) || '';
            var html = (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 180);
            return '<' + el.tagName.toLowerCase() + '> class=' + cls + ' href=' + href + ' disp=' + st.display + ' vis=' + st.visibility + ' | ' + html;
        } catch (e) { return String(el); }
    }

    // 检测「真正可见且非回复门控」的付费/购买按钮：
    //  - 藏在 [hide]（display:none）里的隐藏付费按钮不算
    //  - 「回复可见 / 0银 / 免费」型按钮是回复解锁，不算真付费
    //  - 覆盖三种付费形态：attachpay 链接、购买/付费按钮、「售价」标记（点击文件即付费的付费附件）
    function hasPayButton(scope) {
        try {
            var root = scope || document;
            if (!root) return false;
            // 1) attachpay 付费附件购买链接
            var links = root.querySelectorAll('a[href*="attachpay"]');
            for (var i = 0; i < links.length; i++) {
                if (isVisible(links[i]) && !isReplyVisibleGate(links[i])) {
                    log('检测到可见付费附件链接: ' + desc(links[i]));
                    return true;
                }
            }
            // 2) 「售价」标记：付费附件价格（点击文件即付费，链接可能是 mod=attachment 但带售价）
            var priceEls = root.querySelectorAll('span, em, strong, font, b, i, div, p');
            for (var k = 0; k < priceEls.length; k++) {
                var pt = (priceEls[k].textContent || '').replace(/\s+/g, '');
                if (/售价\s*[:：]?\s*\d+/.test(pt)) {
                    if (!isVisible(priceEls[k])) {
                        log('售价标记已隐藏(回复可见)，忽略: ' + desc(priceEls[k]));
                        continue;
                    }
                    if (isReplyVisibleGate(priceEls[k])) {
                        log('售价标记属「回复可见/0银」门控，不算真付费: ' + desc(priceEls[k]));
                        continue;
                    }
                    log('检测到付费附件售价标记: ' + desc(priceEls[k]));
                    return true;
                }
            }
            // 3) 购买/付费按钮（<a> 链接需过 isPayHref 排除淘专辑/标签等导航）
            var els = root.querySelectorAll('a, button, input[type="submit"], input[type="button"]');
            for (var j = 0; j < els.length; j++) {
                var t = ((els[j].textContent || '') + (els[j].value || '')).replace(/\s+/g, '');
                if (t.indexOf('购买') >= 0 || t.indexOf('付费') >= 0) {
                    // <a> 链接若 href 明确指向非付费页（淘专辑/标签/合集等），不算付费按钮
                    var isA = (els[j].tagName && els[j].tagName.toLowerCase() === 'a');
                    if (isA && !isPayHref(els[j])) {
                        log('「购买」字样链接指向非付费页，忽略: ' + desc(els[j]));
                        continue;
                    }
                    if (!isVisible(els[j])) {
                        log('付费按钮已隐藏(回复可见)，忽略: ' + desc(els[j]));
                        continue;
                    }
                    if (isReplyVisibleGate(els[j])) {
                        log('付费按钮属「回复可见/0银」门控，不算真付费: ' + desc(els[j]));
                        continue;
                    }
                    log('检测到可见真付费按钮: ' + desc(els[j]));
                    return true;
                }
            }
            return false;
        } catch (e) { return false; }
    }

    // 检测「回复可见」隐藏提示（Discuz [hide] 标签），限定在给定容器内
    function hasLockedHint(scope) {
        try {
            var root = scope || document;
            if (!root) return false;
            var t = (root.innerText || root.textContent || '');
            return /隐藏[^。]{0,40}回复|回复[^。]{0,30}(可见|浏览|查看|即可)|需要回复|本帖隐藏|回复后.{0,10}(显示|可见)|回复即可|隐藏的内容/.test(t);
        } catch (e) { return false; }
    }

    function isFirstPage() {
        try {
            var url = location.href;
            if (/[?&]goto=findpost/.test(url)) return false;
            var m = /[?&]page=(\d+)/.exec(url);
            if (m && parseInt(m[1], 10) > 1) return false;
            return true;
        } catch (e) { return true; }
    }

    function findMsg() {
        return document.getElementById('fastpostmessage')
            || document.querySelector('textarea[name="message"]')
            || document.getElementById('postmessage')
            || document.querySelector('#fastpostform textarea')
            || document.querySelector('textarea');
    }

    function findSubmit() {
        return document.getElementById('fastpostsubmit')
            || document.querySelector('button[name="replysubmit"]')
            || document.querySelector('#fastpostsubmit')
            || document.querySelector('#fastpostform button[type="submit"]')
            || document.querySelector('#fastpostform input[type="submit"]');
    }

    // 冷却倒计时浮窗：独立运行，幂等（校准剩余秒数，不重建定时器），不受回复功能暂停影响
    var __dzToastTimer = null;
    var __dzToastSec = 0;
    function showCooldownToast(remainSec) {
        try {
            var toast = document.getElementById('__dzCooldownToast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = '__dzCooldownToast';
                toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.82);color:#fff;padding:10px 22px;border-radius:22px;font-size:14px;z-index:99999;pointer-events:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.35);';
                (document.body || document.documentElement).appendChild(toast);
            }
            __dzToastSec = remainSec;
            toast.textContent = '自动回复冷却中，还剩 ' + __dzToastSec + ' 秒';
            if (!__dzToastTimer) {
                __dzToastTimer = setInterval(function () {
                    __dzToastSec--;
                    if (__dzToastSec <= 0) {
                        if (toast.parentNode) toast.remove();
                        clearInterval(__dzToastTimer);
                        __dzToastTimer = null;
                        return;
                    }
                    toast.textContent = '自动回复冷却中，还剩 ' + __dzToastSec + ' 秒';
                }, 1000);
            }
        } catch (e) {}
    }

    // 提交回复：填内容 + 点击提交（静默），成功后记冷却时间戳并刷新解锁（倒计时由刷新后 tryAutoReply 弹出）
    function doReply(msg) {
        try {
            var savedScroll = window.scrollY;
            msg.value = REPLY_TEXT;
            try { msg.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
            try { msg.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
            log('已填入回复内容，准备静默提交');
            setTimeout(function () {
                try {
                    var btn = findSubmit();
                    if (!btn) { log('未找到提交按钮'); return; }
                    setLastSuccess();   // 先记录冷却时间戳再点击，即使同步跳转也不丢
                    btn.click();
                    try { window.scrollTo(0, savedScroll); } catch (e) {}
                    log('已提交回复，进入 61 秒冷却');
                    setTimeout(function () {
                        log('刷新页面以解锁隐藏内容');
                        location.reload();
                    }, 1500);
                } catch (e) { log('提交异常: ' + e.message); }
            }, 1000);
        } catch (e) { log('doReply 异常: ' + e.message); }
    }

    function tryAutoReply() {
        try {
            // 1) 冷却检查（最高优先级）：冷却期间回复功能暂停，倒计时独立运行
            var last = getLastSuccess();
            if (last > 0 && Date.now() - last < COOLDOWN_MS) {
                var remain = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
                showCooldownToast(remain);
                return;   // 暂停回复，等下次轮询（冷却结束后自动恢复）
            }

            // 2) 冷却已过，检测回复条件
            if (/forumdisplay/.test(location.href)) return;
            if (!isFirstPage()) { log('非帖子第一页，不自动回复'); return; }

            var scope = getFirstFloor() || document;

            if (hasPayButton(scope)) { log('楼主层有付费按钮，脚本不生效'); return; }
            if (!hasLockedHint(scope)) { log('未检测到隐藏提示'); return; }
            log('检测到隐藏提示，需要回复');

            var msg = findMsg();
            if (!msg) { log('未找到回复框'); return; }
            log('找到回复框: id=' + (msg.id || '无') + ', name=' + (msg.name || '无'));
            if (msg.value && msg.value.trim()) { log('回复框已有内容，跳过'); return; }

            doReply(msg);
        } catch (e) { log('tryAutoReply 异常: ' + e.message); }
    }

    function schedule() {
        if (pollCount >= 45) return;   // 最多约 90 秒，覆盖 61 秒冷却 + 缓冲
        pollCount++;
        tryAutoReply();
        setTimeout(schedule, 2000);
    }

    if (document.readyState === 'complete') { schedule(); }
    else { window.addEventListener('load', schedule); }
})();
