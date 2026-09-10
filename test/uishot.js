'use strict';

/**
 * 一次性可视化验证工具（不属于产品代码）：
 * 起一个可见窗口把界面渲染出来，点开设置面板后截图，用于人工确认排版。
 *
 *   electron test/uishot.js
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

function stub() {
  ipcMain.handle('app:info', () => ({
    version: '1.2.11',
    scriptsDir: 'C:/Users/Administrator/AppData/Roaming/Soushuba/scripts',
    cacheDir: 'C:/Users/Administrator/AppData/Roaming/Soushuba/cache/deps',
    externalDirs: [],
    settings: { sidebarAutoCollapse: false, theme: 'light' },
    compat: { mode: 'auto', enabled: false },
    dispatchLog: []
  }));
  ipcMain.handle('scripts:list', () => [
    {
      id: '下载脚本1.0.user.js', name: '搜书吧免银币下载', version: '1.0',
      description: '把附件链接改成免银币地址',
      matches: ['*://*/forum.php?mod=viewthread&tid=*'], includes: [], excludes: [],
      excludeMatches: [], requires: [], resources: [], runAt: 'document-end',
      noframes: false, enabled: true, source: 'external',
      path: 'C:/Users/Administrator/Desktop/2/下载脚本1.0.txt',
      code: [
        '(function () {',
        "  'use strict';",
        "  // 把付费附件的链接换成免银币地址",
        "  var KEY = 'attach_免银币_';",
        "  function swap() {",
        '    document.querySelectorAll(\'a[href*=attachpay]\').forEach(function (a) {',
        "      a.href = a.href.replace('attachpay', 'attach');",
        '    });',
        '  }',
        "  new MutationObserver(swap).observe(document.body, { childList: true, subtree: true });",
        '  swap();',
        '})();'
      ].join('\n')
    },
    {
      id: '阅读模式.user.js', name: '阅读模式', version: '1.0.0',
      description: '去掉侧栏与浮动广告',
      matches: ['*://*/*'], includes: [], excludes: [], excludeMatches: [],
      requires: [], resources: [], runAt: 'document-start',
      noframes: false, enabled: true, source: 'internal',
      path: 'C:/Users/Administrator/AppData/Roaming/Soushuba/scripts/阅读模式.user.js', code: 'x'
    },
    {
      id: '夜间护眼.user.js', name: '夜间护眼', version: '1.0.0',
      description: '降低亮度',
      matches: ['*://*/*'], includes: [], excludes: [], excludeMatches: [],
      requires: [], resources: [], runAt: 'document-end',
      noframes: false, enabled: false, source: 'internal',
      path: 'C:/Users/Administrator/AppData/Roaming/Soushuba/scripts/夜间护眼.user.js', code: 'x'
    },
    {
      id: 'builtin|内置-自动回复.user.js', name: '自动回复解锁', version: '2.2.6',
      description: '61 秒冷却 + 付费附件过滤 + 限定楼主 1 楼',
      matches: ['*://*/*'], includes: [], excludes: [], excludeMatches: [],
      requires: [], resources: [], runAt: 'document-idle',
      noframes: false, enabled: true, source: 'builtin', builtin: true,
      path: 'D:/app/resources/app.asar/builtin-scripts/内置-自动回复.user.js',
      code: "console.log('builtin');"
    }
  ]);
  ipcMain.handle('scripts:reload', () => []);
  ipcMain.handle('scripts:listBuiltin', () => [
    { id: 'builtin|去广告', name: '去广告（内置）', description: 'Discuz 常见广告容器 + 帖内图片外显屏蔽', enabled: true, source: 'builtin', builtin: true, matches: ['*://*/*'] },
    { id: 'builtin|自动回复', name: '自动回复解锁（内置）', description: '61 秒冷却 + 付费附件过滤 + 限定楼主 1 楼', enabled: true, source: 'builtin', builtin: true, matches: ['*://*/*'] },
    { id: 'builtin|浮层修复', name: '浮层关闭修复（内置）', description: '修「购买附件后浮层关不掉」', enabled: true, source: 'builtin', builtin: true, matches: ['*://*/*'] },
    { id: 'builtin|附件重试', name: '附件失效自动重试（内置）', description: '自动点「重新下载」', enabled: true, source: 'builtin', builtin: true, matches: ['*://*/*'] }
  ]);
  ipcMain.handle('history:list', () => ({
    items: [
      { url: 'https://dq3s.b4e5w4dqwde.com/forum.php?mod=guide&view=new', title: '导读-最新回复 - 搜书吧', at: Date.now() - 60000 },
      { url: 'https://dq3s.b4e5w4dqwde.com/forum.php?mod=viewthread&tid=12345', title: '【完结】斗破苍穹 作者：天蚕土豆', at: Date.now() - 3600000 },
      { url: 'https://dq3s.b4e5w4dqwde.com/forum-2-1.html', title: '小说下载区 - 搜书吧', at: Date.now() - 86400000 }
    ],
    total: 3
  }));
  ipcMain.handle('history:remove', () => ({ ok: true }));
  ipcMain.handle('history:clear', () => ({ ok: true, removed: 3 }));
  ipcMain.handle('settings:get', () => ({
    openForumOnStart: true, externalLinksToSystem: true, autoReloadOnSave: true,
    autoDownloadAttachments: true, refreshAfterDownload: true,
    sidebarAutoCollapse: false, theme: 'light'
  }));
  ipcMain.handle('settings:set', () => ({}));
  ipcMain.handle('view:setBounds', () => true);
  ipcMain.handle('view:setVisible', () => true);
  ipcMain.handle('dirs:list', () => ({ dirs: [], scriptsDir: 'X:/scripts', cacheDir: 'X:/cache' }));
  ipcMain.handle('download:info', () => ({
    dir: 'C:/Users/Administrator/Desktop/1/搜书吧/download',
    count: 3, custom: '', portable: true
  }));
  ipcMain.handle('download:list', () => ({
    dir: 'C:/Users/Administrator/Desktop/1/搜书吧/download',
    files: [
      { name: '我的测试书.txt', path: 'X:/d/我的测试书.txt', size: 2048, mtime: Date.now() },
      { name: '第二本.epub', path: 'X:/d/第二本.epub', size: 1048576, mtime: Date.now() }
    ]
  }));
  ipcMain.handle('download:openFile', () => ({ ok: true }));
  ipcMain.handle('download:reveal', () => ({ ok: true }));
  ipcMain.handle('download:open', () => '');
  ipcMain.handle('forum:get', () => ({
    url: 'https://dq3s.b4e5w4dqwde.com/',
    effective: 'https://dq3s.b4e5w4dqwde.com/',
    origin: 'https://dq3s.b4e5w4dqwde.com/',
    defaultEntry: 'https://www.soushu2030.com',
    openOnStart: true, externalLinks: true, autoDownload: true,
    compat: { mode: 'auto', enabled: false }
  }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  stub();

  let size = { width: 1000, height: 680 };
  try {
    size = screen.getPrimaryDisplay().workAreaSize;
  } catch (e) {
    /* ignore */
  }

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: 0,
    y: 0,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(900);

  const out = path.join(__dirname, '..', 'build', 'ui-shots');
  fs.mkdirSync(out, { recursive: true });

  // 1) 设置（只三块）
  await win.webContents.executeJavaScript("document.querySelector('#btnSettings').click()", true);
  await wait(700);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, '1-settings.png'), img.toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#btnCloseSettings').click()", true);
  await wait(500);

  // 3) 历史记录
  await win.webContents.executeJavaScript("document.querySelector('#btnSettings').click()", true);
  await wait(400);
  await win.webContents.executeJavaScript("document.querySelector('#btnOpenHistory').click()", true);
  await wait(800);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, '2-history.png'), img.toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#btnCloseHistory').click()", true);
  await wait(400);
  await win.webContents.executeJavaScript("document.querySelector('#btnCloseSettings').click()", true);
  await wait(500);

  // 4) 下载列表
  await win.webContents.executeJavaScript("document.querySelector('#btnDownloads').click()", true);
  await wait(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, '3-downloads.png'), img.toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#btnCloseDownloads').click()", true);
  await wait(500);

  // 4.5) 脚本编辑器（完整源码，含开头的元数据块）
  await win.webContents.executeJavaScript(
    "document.querySelector('#scriptList .script-item .small-btn').click()",
    true
  );
  await wait(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, '5-editor.png'), img.toPNG());
  // 滚到代码框顶部，确保能看到 ==UserScript== 开头
  await win.webContents.executeJavaScript(
    "var b=document.querySelector('#fCode'); b.scrollTop=0; b.setSelectionRange(0,0); b.blur();" +
      "var w=document.querySelector('#drawer .drawer-body'); if(w) w.scrollTop=0;",
    true
  );
  await wait(300);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, '6-editor-top.png'), img.toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#btnCancel').click()", true);
  await wait(500);

  // 5) 收起后的窄条 + 左侧脚本列表
  await win.webContents.executeJavaScript("document.querySelector('#btnFoldSidebar').click()", true);
  await wait(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, '4-rail.png'), img.toPNG());

  // 量尺寸前先把侧栏展开（上一步把它收起来了）
  await win.webContents.executeJavaScript(
    "(function(){var b=document.querySelector('#railExpand'); if(b) b.click();})()",
    true
  );
  await wait(900);

  // 展开后的侧栏（本次改动的重点：内置脚本在列表里 + 底部两个入口）
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, '7-sidebar.png'), img.toPNG());

  // ---------------------------------------------------------------
  // 布局测量：图看不出来（或不好量）的问题用数值查
  // ---------------------------------------------------------------
  const metrics = await win.webContents.executeJavaScript(
    `(function () {
       const r = (el) => { const b = el.getBoundingClientRect();
         return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
       const q = (sel) => document.querySelector(sel);
       const side = q('#sidebar') || q('.sidebar');
       const foot = q('.side-foot');
       const links = Array.prototype.map.call(document.querySelectorAll('.side-foot .link'), r);
       return {
         viewport: { w: window.innerWidth, h: window.innerHeight },
         sidebar: r(side),
         brand: r(q('.brand')),
         importRow: q('.side-actions') ? r(q('.side-actions')) : null,
         summary: r(q('#summary')),
         list: r(q('#scriptList')),
         foot: foot ? r(foot) : null,
         footLinks: links,
         // 底部按钮有没有挤出侧栏 / 换行错位
         footOverflow: foot ? Math.round(foot.scrollWidth - foot.clientWidth) : null,
         // 侧栏有没有被内容撑出横向滚动
         sidebarOverflowX: Math.round(side.scrollWidth - side.clientWidth),
         // 页面整体有没有横向溢出
         bodyOverflowX: Math.round(document.documentElement.scrollWidth - window.innerWidth),
         itemCount: document.querySelectorAll('#scriptList .script-item').length,
         // 顶部两个按钮：宽度是否均分、文字有没有被挤
         sideActions: Array.prototype.map.call(
           document.querySelectorAll('.side-actions .btn'),
           function (b) {
             var r = b.getBoundingClientRect();
             return {
               text: b.textContent.trim().replace(/\s+/g, ' '),
               x: Math.round(r.x),
               w: Math.round(r.width),
               overflow: Math.round(b.scrollWidth - b.clientWidth)
             };
           }
         ),
         // 每条脚本：名字还剩多少宽度、有没有被挤没
         items: Array.prototype.map.call(document.querySelectorAll('#scriptList .script-item'), function (li) {
           var top = li.querySelector('.script-item-top');
           var nm = li.querySelector('.script-name');
           var bd = li.querySelector('.script-badge');
           var bt = li.querySelector('.small-btn');
           var sw = li.querySelector('.switch');
           return {
             name: nm ? nm.textContent : '',
             nameW: nm ? Math.round(nm.getBoundingClientRect().width) : 0,
             badge: bd ? bd.textContent : '',
             btn: bt ? bt.textContent : '',
             rowW: top ? Math.round(top.getBoundingClientRect().width) : 0,
             rowScrollW: top ? Math.round(top.scrollWidth) : 0,
             clipped: nm ? nm.scrollWidth > nm.clientWidth + 1 : false
           };
         }),
         // 右上工具组有没有被压
         toolGroup: (function () {
           var g = document.querySelector('.tool-group');
           if (!g) return null;
           var b = g.getBoundingClientRect();
           return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right), vw: window.innerWidth };
         })()
       };
     })()`,
    true
  );
  console.log('布局测量：');
  console.log('  视口        ' + metrics.viewport.w + ' x ' + metrics.viewport.h);
  console.log('  侧栏        x=' + metrics.sidebar.x + ' w=' + metrics.sidebar.w + ' h=' + metrics.sidebar.h);
  console.log('  品牌        y=' + metrics.brand.y + ' h=' + metrics.brand.h);
  console.log('  摘要        y=' + metrics.summary.y);
  console.log('  列表        y=' + metrics.list.y + ' h=' + metrics.list.h + ' 条目=' + metrics.itemCount);
  console.log('  底栏        y=' + (metrics.foot ? metrics.foot.y : '-') + ' h=' + (metrics.foot ? metrics.foot.h : '-')
    + ' 链接=' + JSON.stringify(metrics.footLinks));
  console.log('  底栏横向溢出 ' + metrics.footOverflow + 'px | 侧栏横向溢出 ' + metrics.sidebarOverflowX + 'px | 页面横向溢出 ' + metrics.bodyOverflowX + 'px');
  if (metrics.foot) {
    const inside = metrics.foot.y + metrics.foot.h <= metrics.sidebar.y + metrics.sidebar.h;
    console.log('  底栏在侧栏内  ' + inside);
  }
  for (const l of metrics.footLinks) {
    if (l.x < metrics.sidebar.x || l.x + l.w > metrics.sidebar.x + metrics.sidebar.w) {
      console.log('  ✗ 有链接超出侧栏: ' + JSON.stringify(l));
    }
  }

  console.log('  侧栏按钮：' + metrics.sideActions.map(function (b) {
    return b.text + '(x=' + b.x + ' w=' + b.w + (b.overflow > 0 ? ' ✗溢出' + b.overflow : '') + ')';
  }).join(' | '));
  console.log('  脚本条目：');
  for (const it of metrics.items) {
    console.log('    ' + it.name + ' | 名字宽=' + it.nameW + ' 徽章=' + (it.badge || '无')
      + ' 按钮=' + it.btn + ' 行宽=' + it.rowW + '/' + it.rowScrollW
      + (it.clipped ? ' ✗名字被截断' : '') + (it.rowScrollW > it.rowW + 1 ? ' ✗行溢出' : ''));
  }
  if (metrics.toolGroup) {
    const t = metrics.toolGroup;
    console.log('  右上工具组 x=' + t.x + ' w=' + t.w + ' right=' + t.right + ' 视口宽=' + t.vw
      + (t.right > t.vw ? ' ✗超出视口' : ''));
  }

  console.log('截图已保存到 ' + out);
  win.destroy();
  app.exit(0);
});
