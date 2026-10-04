// ==UserScript==
// @name         论坛广告清理（内置）
// @namespace    soushu.builtin
// @version      1.0.0
// @description  两类广告：首页外链推广分区（Discuz redirect 型）+ 分区主题列表里的站内内容广告帖（content广告位插件）。均按官方结构标记判定，与标题文案无关
// @author       搜书吧
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

/**
 * 搜书吧论坛（Discuz! X3.4）广告清理，两条互不干扰的规则。
 *
 * -- 规则一：首页外链推广分区 ---
 * 外链分区（点了就 302 到站外推广站）在首页渲染成
 * `<dd><a href="...">链接到外部地址</a></dd>`。该文案来自模板 `{lang url_link}`
 *（lang_template.php -> 中文「链接到外部地址」），且**只在 $forum['redirect'] 分支内输出**
 * —— 所以「格子文本含该文案」严格等价于「该分区是外链推广分区」，与 fid 无关，
 * 站点日后新增多少外链分区都会自动命中，无需升级。
 * 实测首页 6 个：fid=53 自助改名、73 搜书网址发布器下载、78 赚币攻略、
 * 85 岛国APP、86 韩漫在线、97 帮助中心。
 *
 * -- 规则二：主题列表里的站内内容广告帖 ---
 * Discuz「content广告位」插件生成的假主题，标题链接是
 * `forum.php?mod=viewthread&tid=adver&aid=N`（**tid 不是数字**），行内还带content_adver 标记。
 * 典型标题如「H韩漫在线无限制观看,会员招募中,详情见本贴」「国产资源app,适合午夜观看」。
 * 实测该页 59 条主题里非数字 tid 只有 adver 一个取值，所以不会误伤正常主题。
 *
 * **不按中文标题关键词匹配** —— 标题随时会被换文案，只有结构标记才一劳永逸。
 *
 * 与 Android 版（AdBlocker.kt）同源同判据，两端行为一致。
 */
(function () {
  var MARKS = ['链接到外部地址', '鏈接到外部地址', 'url_link'];

  /**
   * 修「分区/帖子要点两下才进去」—— Discuz `static/js/forum.js:289` 的
   *   function atarget(obj){ obj.target = getcookie('atarget') > 0 ? '_blank' : ''; }
   * 会把帖子链接的 target 改成空字符串；本客户端开了 setSupportMultipleWindows(true)
   * （为了接住跳转页的 window.open / target=_blank 下载链接），空 target 同样触发
   * onCreateWindow，于是每次点击都多走一次「新建临时 WebView → 请求 → 才 loadUrl」，
   * 主界面在这段时间毫无反应，感知上就是要点两下。
   * 这里把 target 同步定为 _self，点击直接由主 WebView 处理，省掉整整一跳。
   * 保留 window.atarget 供 Discuz 的 setatarget 开关 UI 继续使用。
   */
  try {
    window.atarget = function (obj) {
      try { if (obj) obj.target = '_self'; } catch (e) {}
    };
  } catch (e) {}
  // 捕获阶段兜底：AJAX 重渲染可能让 target 变回 _blank，点击瞬间同步纠正。
  // 站内链接多为相对路径(portal.php?mod=xx)，所以只排除非 http(s) 的协议类。
  try {
    document.addEventListener('click', function (ev) {
      var a = null;
      try { a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null; } catch (e) { a = null; }
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) return;
      if ((a.getAttribute('target') || '') !== '_blank') return;
      try { a.setAttribute('target', '_self'); } catch (e) {}
    }, true);
  } catch (e) {}

  function isForumHome() {
    var path = String(location.pathname || '').toLowerCase();
    var q = String(location.search || '').replace(/^\?/, '');
    var mod = '', hasFid = false, hasTid = false, hasGoto = false;
    if (q) {
      var parts = q.split('&');
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split('=');
        var k = (kv[0] || '').toLowerCase();
        var v = decodeURIComponent(kv[1] || '').toLowerCase();
        if (k === 'mod') mod = v;
        else if (k === 'fid') hasFid = true;
        else if (k === 'tid') hasTid = true;
        else if (k === 'goto') hasGoto = true;
      }
    }
    if (mod) return mod === 'index';
    if (hasFid || hasTid || hasGoto) return false;
    var p = path.slice(path.lastIndexOf('/') + 1);
    return p === '' || p === 'forum.php' || p === 'index.php' || p === 'portal.php';
  }

  function isThreadList() {
    var path = String(location.pathname || '').toLowerCase();
    var q = String(location.search || '').replace(/^\?/, '');
    var mod = '', hasTid = false;
    if (q) {
      var parts = q.split('&');
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split('=');
        var k = (kv[0] || '').toLowerCase();
        var v = decodeURIComponent(kv[1] || '').toLowerCase();
        if (k === 'mod') mod = v;
        else if (k === 'tid') hasTid = true;
      }
    }
    if (mod === 'viewthread' || hasTid) return false;
    if (mod === 'forumdisplay') return true;
    return /\/forum-\d+-\d+\.html$/.test(path);
  }

  // ---------------- 规则一：首页外链推广分区 ----------------

  function isExtText(s) {
    if (!s) return false;
    for (var i = 0; i < MARKS.length; i++) {
      if (s.indexOf(MARKS[i]) >= 0) return true;
    }
    return false;
  }

  function cleanHome() {
    var cells = [], sc = document.querySelectorAll('td.fl_g'), i, t, c, ch, k, hasInner;
    for (i = 0; i < sc.length; i++) cells.push(sc[i]);
    sc = document.querySelectorAll('li.normal');
    for (i = 0; i < sc.length; i++) cells.push(sc[i]);

    var rows = [];
    for (t = 0; t < cells.length; t++) {
      c = cells[t];
      if (!isExtText(c.textContent)) continue;
      if (!c.parentNode) continue;
      hasInner = false;
      ch = c.children;
      for (k = 0; k < ch.length; k++) {
        if (ch[k].querySelector && ch[k].querySelector('td.fl_g')) { hasInner = true; break; }
      }
      if (hasInner) continue;
      var row = c.parentNode;
      if (row && row.nodeType === 1 &&
          (row.tagName === 'TR' || row.tagName === 'LI' || row.tagName === 'UL')) {
        rows.push(row);
      }
      if (row) row.removeChild(c);
    }

    // 摘完格子后，把因此变空且仍在版块表内的行也清掉
    var tables = document.querySelectorAll('table.fl_tb'), j, inTable;
    for (j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (!r || !r.parentNode) continue;
      if (r.tagName === 'TR') {
        inTable = false;
        for (t = 0; t < tables.length; t++) {
          if (tables[t] === r.parentNode || tables[t].contains(r)) { inTable = true; break; }
        }
        if (!inTable) continue;
        if (r.querySelector('.fl_g')) continue;
        if ((r.textContent || '').replace(/\s|\u00a0/g, '').length > 0) continue;
        if (r.parentNode) r.parentNode.removeChild(r);
      } else if (r.tagName === 'UL') {
        if ((r.textContent || '').replace(/\s|\u00a0/g, '').length > 0) continue;
        if (r.parentNode) r.parentNode.removeChild(r);
      }
    }

    // 双列布局补位：版块表每行 2 格、每格 width=49.9%，摘掉一个后剩下的仍占半行宽，
    // 右边会空出一大块。所以给「因清理只剩一个格子」的行补 colspan=2、宽度改 100%。
    // 纯版式修正，不改内容与顺序。
    var allRows = document.querySelectorAll('table.fl_tb tr'), z;
    for (z = 0; z < allRows.length; z++) {
      var rr = allRows[z], tds = [], kids = rr.children, q;
      for (q = 0; q < kids.length; q++) if (kids[q].tagName === 'TD') tds.push(kids[q]);
      if (tds.length === 1 && (tds[0].className || '').indexOf('fl_g') >= 0) {
        tds[0].setAttribute('colspan', '2');
        tds[0].setAttribute('width', '100%');
        tds[0].style.width = '100%';
      }
    }
  }

  // -------------- 规则二：主题列表里的站内内容广告帖 -------------

  function tidOfTbody(tb) {
    var a = tb.querySelector('a.s.xst');
    if (!a) return '';
    var h = a.getAttribute('href') || '';
    var m = h.match(/[?&]tid=([^&#]*)/);
    if (!m) return '';
    var t = m[1].replace(/&amp;/g, '&');
    var amp = t.indexOf('&');
    if (amp > 0) t = t.slice(0, amp);
    try { return decodeURIComponent(t); } catch (e) { return t; }
  }

  function hasAdMark(tb) {
    // 同一页可能有多条广告共用同一个 tbody id（实测 aid=4 与 aid=5 就是），
    // 单数 querySelector 只返回第一个会漏，所以用 querySelectorAll 全量查。
    var marks = tb.querySelectorAll('a[id^="content_adver"]');
    if (marks && marks.length > 0) return true;
    var html = tb.innerHTML || '';
    return html.indexOf('CONTENT_TID=') >= 0 || html.indexOf('content_adver') >= 0;
  }

  function cleanThreadList() {
    var tbs = document.querySelectorAll('tbody'), i, tb, tid, kill = [];
    for (i = 0; i < tbs.length; i++) {
      tb = tbs[i];
      if (!tb.parentNode) continue;
      tid = tidOfTbody(tb);
      if (!tid) continue;
      if (/^\d+$/.test(tid)) continue;   // 纯数字 = 正常主题
      if (!hasAdMark(tb)) continue;
      kill.push(tb);
    }
    for (i = 0; i < kill.length; i++) {
      if (kill[i].parentNode) kill[i].parentNode.removeChild(kill[i]);
    }
    // 广告被摘后残留的分隔线一并清掉（判据保守：里面没主题且文本近乎为空才算残骸）
    var seps = document.querySelectorAll('tbody[id="separatorline"]');
    for (i = seps.length - 1; i >= 0; i--) {
      var e = seps[i];
      if (!e.parentNode) continue;
      if (e.querySelector('a.s.xst')) continue;
      if ((e.textContent || '').replace(/\s|\u00a0/g, '').length > 2) continue;
      e.parentNode.removeChild(e);
    }
  }

  try {
    if (isForumHome()) cleanHome();
    else if (isThreadList()) cleanThreadList();
  } catch (e) {}
})();
