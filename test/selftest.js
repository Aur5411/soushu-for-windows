'use strict';

/**
 * 自动化自检：用真实的 Chromium 跑一遍注入引擎和 GM API。
 *
 *   npm run selftest
 *
 * 测试自带一个本地 HTTP 服务器，所以不依赖外网，也不会污染真实数据目录。
 *
 * 覆盖的行为：
 *   ①  脚本先于网页自身脚本执行（真 document-start）
 *   ②  页面里能拿到 GM API
 *   ③  不匹配 @match 的脚本不执行
 *   ④  GM_setValue / GM_getValue 可读写
 *   ⑤  document-end 在 DOM 就绪后执行
 *   ⑥  iframe 里同样注入
 *   ⑦  停用脚本后重新加载不再注入
 *   ⑧  .txt 导入被转换成 .user.js
 *   ⑨  txt 里的元数据头被正确解析
 *   ⑩  无元数据的裸 txt 自动补匹配规则
 *   ⑪  外部脚本目录里的脚本会被加载
 *   ⑫  用户真实脚本（搜书吧免银币下载）在模拟帖子页上生效
 *   ⑬  @require 的外链依赖在脚本正文之前执行
 *   ⑭  GM_xmlhttpRequest 能拿到没有 CORS 头的跨域数据
 *   ⑮  GM_registerMenuCommand 注册的命令能被调用
 *   ⑯  GM_setClipboard 写入系统剪贴板
 *   ⑰  下载目录落在软件文件夹下的 Download
 */

const { app, BrowserWindow, WebContentsView, ipcMain, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tempRoot = path.join(os.tmpdir(), 'scriptdock-selftest-' + Date.now());
app.setPath('userData', tempRoot);

// 沙箱起不来的环境下自检也得跑得起来
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const store = require('../src/main/store');
const { registerDispatcherChannel, buildMenuInvokeSource } = require('../src/main/injector');
const { registerGmApi } = require('../src/main/gmApi');
const { resolveDownloadDir, canWriteDir, appFolder } = require('../src/main/downloadDir');
const httpLib = require('../src/main/http');
const { createAttachmentDownloader } = require('../src/main/attachment');
const { createHistoryStore } = require('../src/main/history');

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待某个条件成立，避免用固定 sleep 猜时间 */
async function waitFor(fn, timeout = 8000, interval = 120) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      /* 继续等 */
    }
    await wait(interval);
  }
  return null;
}

// ==================================================================
// 本地测试服务器
// ==================================================================

let server = null;

/** 进度测试用的大文件尺寸（分块发，逼出多次 data 事件） */
const BIG_SIZE = 600 * 1024;
let baseUrl = '';

const FORUM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>帖子</title></head>
<body>
  <h1>帖子正文</h1>
  <div class="buttons"><a href="attachment.php?aid=111222&amp;k=333444">附件下载</a></div>
  <div class="buttons already"><a href="mailto:x@y.com">发邮件</a></div>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');

      const send = (code, body, type) => {
        res.writeHead(code, { 'content-type': type || 'text/html; charset=utf-8' });
        res.end(body);
      };

      if (url.pathname === '/page.html') {
        send(
          200,
          [
            '<!doctype html><html><head><meta charset="utf-8"><title>注入测试页</title>',
            '<script>',
            'window.__order = window.__order || [];',
            "window.__order.push('page-inline');",
            '</script>',
            '</head><body><h1>hello</h1><iframe src="/frame.html"></iframe></body></html>'
          ].join('\n')
        );
      } else if (url.pathname === '/frame.html') {
        send(
          200,
          '<!doctype html><html><head><meta charset="utf-8"></head><body>frame</body></html>'
        );
      } else if (url.pathname === '/publish.html') {
        // 模拟「地址发布页」：域名和结构会变，只能靠关键词打分挑链接
        send(
          200,
          [
            '<!doctype html><html><head><meta charset="utf-8"><title>地址发布页</title></head><body>',
            '<a class="link" href="https://ad.example.com/">广告位招商</a>',
            '<a href="https://mirror.example.com/">备用镜像</a>',
            '<a href="/o/other">最新地址（本站发布页）</a>',
            '<a href="javascript:void(0)" onclick="location.href=\'https://onclick.example.com/x\'">入口 论坛</a>',
            '<div class="link-box">',
            `<a class="link" href="${baseUrl}/forum-index.html">最新地址：搜书吧论坛</a>`,
            `<a href="${baseUrl}/other.html">论坛其它页面</a>`,
            '</div>',
            '</body></html>'
          ].join('\n')
        );
      } else if (url.pathname === '/publish-relative.html') {
        // 只有相对路径的发布页：必须能补成绝对地址
        send(
          200,
          [
            '<!doctype html><html><head><meta charset="utf-8"><title>发布页(相对)</title></head><body>',
            '<div class="link-box">',
            '<a class="link" href="forum-relative.html">最新地址：搜书吧论坛</a>',
            '</div>',
            '</body></html>'
          ].join('\n')
        );
      } else if (url.pathname === '/forum-nav.html') {
        // 真实论坛的导航栏：一堆「论坛/首页」链接，但没有 .link-box。
        // 这种页面绝不能被当成发布页，否则会把用户从帖子页拽回首页。
        send(
          200,
          [
            '<!doctype html><html><head><meta charset="utf-8"><title>搜书吧</title></head><body>',
            '<div id="nv_forum">',
            `<a href="${baseUrl}/forum-nav.html">论坛</a>`,
            `<a href="${baseUrl}/forum-nav.html">首页</a>`,
            `<a href="${baseUrl}/forum-index.html">进入论坛</a>`,
            '</div></body></html>'
          ].join('\n')
        );
      } else if (
        url.pathname === '/forum-index.html' ||
        url.pathname === '/other.html' ||
        url.pathname === '/forum-relative.html'
      ) {
        send(200, '<!doctype html><html><head><meta charset="utf-8"></head><body>论坛首页</body></html>');
      } else if (url.pathname === '/attachment.php') {
        const aid = url.searchParams.get('aid') || '';
        if (aid === 'FAKE') {
          // 伪造签名的附件链接：Discuz 会回「原附件链接已失效」提示页，
          // 里边藏着真正的「点击这里重新下载」地址
          send(
            200,
            [
              '<!doctype html><html><head><meta charset="utf-8"><title>提示信息</title></head><body>',
              '<div id="messagetext">',
              '<p>抱歉，原附件链接已失效</p>',
              `<p><a href="${baseUrl}/attachment.php?aid=REAL&amp;sign=abc123">点击这里重新下载</a></p>`,
              '</div></body></html>'
            ].join('\n')
          );
        } else if (aid === 'REALBIG') {
          // 大文件本体：带 content-length，分块慢慢发 —— 逼出多次 data 事件，
          // 这样才测得出进度回调是不是真的在「过程中」报
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(BIG_SIZE),
            'content-disposition': 'attachment; filename="progress-test.bin"'
          });
          let sent = 0;
          const step = 64 * 1024;
          const timer = setInterval(() => {
            if (sent >= BIG_SIZE) {
              clearInterval(timer);
              res.end();
              return;
            }
            const n = Math.min(step, BIG_SIZE - sent);
            sent += n;
            res.write(Buffer.alloc(n, 0x41));
          }, 4);
        } else if (aid === 'BIG') {
          // 大文件链路：还是先回一个提示页，再跳到真文件。
          // 用来验证「进度只报真文件那一跳」——提示页也是 200，
          // 要是把它的字节也报出去，进度条会先冲满再归零。
          send(
            200,
            [
              '<!doctype html><html><head><meta charset="utf-8"><title>提示信息</title></head><body>',
              '<div id="messagetext">',
              '<p>附件需要重新获取</p>',
              `<p><a href="${baseUrl}/attachment.php?aid=REALBIG&amp;sign=abc123">点击这里重新下载</a></p>`,
              '</div></body></html>'
            ].join('\n')
          );
        } else {
          // 真实下载地址：返回文件。
          // 注意响应头不能直接写非 ASCII（Node 会抛 ERR_INVALID_CHAR），
          // 中文名要走 RFC5987 的 filename*，这也顺便覆盖了解码分支。
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition':
              "attachment; filename=\"fallback.txt\"; filename*=UTF-8''%5Bsxsy.org%5D%E4%B8%AD%E6%96%87%E5%90%8D.txt"
          });
          res.end('这是测试文件的正文内容');
        }
      } else if (url.pathname === '/bigfile.bin') {
        // 大文件：带 content-length 分块慢慢发，让 http.js 的进度回调收到多次
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(BIG_SIZE),
          'content-disposition': 'attachment; filename="progress-test.bin"'
        });
        let sent = 0;
        const step = 64 * 1024;
        const timer = setInterval(() => {
          if (sent >= BIG_SIZE) {
            clearInterval(timer);
            res.end();
            return;
          }
          const n = Math.min(step, BIG_SIZE - sent);
          sent += n;
          res.write(Buffer.alloc(n, 0x41));
        }, 4);
      } else if (url.pathname === '/novel.txt') {
        // 论坛常把小说正文直接当纯文本返回：没有 Content-Disposition。
        // 这种响应不能被当成网页显示，要落盘成能用记事本打开的文件。
        send(200, '这是小说正文……', 'text/plain; charset=utf-8');
      } else if (url.pathname === '/forum.php') {
        if (/mod=attachment/.test(url.search)) {
          // 附件响应：带 Content-Disposition，正常情况下浏览器会另存为
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="popup-test.txt"'
          });
          res.end('弹窗测试用的正文');
        } else {
          send(200, FORUM_HTML);
        }
      } else if (url.pathname === '/dep.js') {
        send(
          200,
          'window.__depRuns = (window.__depRuns || 0) + 1;\nwindow.__depMarker = "dep-loaded";\n',
          'application/javascript; charset=utf-8'
        );
      } else if (url.pathname === '/data.json') {
        // 故意不发 Access-Control-Allow-Origin：正是要验证绕过 CORS
        send(200, JSON.stringify({ hello: 'cross-origin', n: 7 }), 'application/json');
      } else if (url.pathname === '/popup.html') {
        // 弹窗测试页：一个附件链接、一个普通链接、一个空弹窗，全部 target=_blank
        send(
          200,
          [
            '<!doctype html><html><head><meta charset="utf-8"><title>弹窗测试</title></head><body>',
            `<a id="att" href="/forum.php?mod=attachment&aid=MTIzNDU2" target="_blank">下载附件</a>`,
            `<a id="norm" href="/normal.html" target="_blank">普通链接</a>`,
            `<a id="blank" href="about:blank" target="_blank">空弹窗</a>`,
            '</body></html>'
          ].join('\n')
        );
      } else if (url.pathname === '/normal.html') {
        send(200, '<!doctype html><html><head><meta charset="utf-8"></head><body>普通页面</body></html>');
      } else {
        send(404, 'not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

// ==================================================================
// 主流程
// ==================================================================

async function main() {
  await app.whenReady();
  await startServer();
  console.log('本地测试服务器：' + baseUrl + '\n');

  // ---------------- 准备脚本 ----------------
  store.init();
  const dir = store.scriptsDirectory();
  const externalDir = path.join(tempRoot, 'external-scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });

  // 用一个覆盖整站的规则，这样 iframe（/frame.html）也会被注入
  const PAGE_MATCH = baseUrl + '/*';
  const write = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.join('\n'), 'utf8');

  write('a-start.user.js', [
    '// ==UserScript==',
    '// @name         A 起始阶段脚本',
    `// @match        ${PAGE_MATCH}`,
    '// @run-at       document-start',
    '// ==/UserScript==',
    'window.__order = window.__order || [];',
    "window.__order.push('userscript-start');",
    'window.__injectedAt = location.href;',
    "window.__hasGM = (typeof GM_setValue === 'function');"
  ]);

  write('b-elsewhere.user.js', [
    '// ==UserScript==',
    '// @name         B 不该运行的脚本',
    '// @match        https://example.com/*',
    '// ==/UserScript==',
    'window.__shouldNotExist = true;'
  ]);

  write('c-end.user.js', [
    '// ==UserScript==',
    '// @name         C 文档就绪脚本',
    `// @match        ${PAGE_MATCH}`,
    '// @run-at       document-end',
    '// ==/UserScript==',
    'window.__gmRoundtrip = null;',
    "GM_setValue('counter', 42);",
    "window.__gmRoundtrip = GM_getValue('counter', 0);",
    'window.__domReadyAtEnd = document.readyState;'
  ]);

  // @require：依赖先执行，正文才能读到它设的变量
  write('d-require.user.js', [
    '// ==UserScript==',
    '// @name         D 带外链依赖的脚本',
    `// @match        ${PAGE_MATCH}`,
    `// @require      ${baseUrl}/dep.js`,
    '// @run-at       document-end',
    '// ==/UserScript==',
    'window.__requireSawDep = window.__depMarker || "(依赖没执行)";'
  ]);

  // GM_xmlhttpRequest：目标地址没有 CORS 头
  write('e-xhr.user.js', [
    '// ==UserScript==',
    '// @name         E 跨域请求脚本',
    `// @match        ${PAGE_MATCH}`,
    '// @run-at       document-end',
    '// ==/UserScript==',
    "window.__xhrState = 'pending';",
    'GM_xmlhttpRequest({',
    `  url: '${baseUrl}/data.json',`,
    "  method: 'GET',",
    '  responseType: "json",',
    '  onload: function (res) {',
    "    window.__xhrState = 'done';",
    '    window.__xhrStatus = res.status;',
    '    window.__xhrBody = res.responseText;',
    '    window.__xhrParsed = res.response && res.response.hello;',
    '  },',
    '  onerror: function (err) {',
    "    window.__xhrState = 'error';",
    '    window.__xhrError = err && err.error;',
    '  }',
    '});'
  ]);

  // GM_registerMenuCommand
  write('f-menu.user.js', [
    '// ==UserScript==',
    '// @name         F 带菜单命令的脚本',
    `// @match        ${PAGE_MATCH}`,
    '// @run-at       document-end',
    '// ==/UserScript==',
    "window.__menuClicked = false;",
    "GM_registerMenuCommand('测试菜单命令', function () { window.__menuClicked = true; });"
  ]);

  // 外部目录里的脚本用用户真实脚本
  fs.copyFileSync(
    path.join(__dirname, 'fixtures', '搜书吧免银币下载.user.js'),
    path.join(externalDir, '搜书吧免银币下载.user.js')
  );

  // txt 导入
  const txtPath = path.join(tempRoot, '从文本来的脚本.txt');
  fs.writeFileSync(
    txtPath,
    [
      '// ==UserScript==',
      '// @name         T 来自 txt 的脚本',
      '// @match        https://txt.example.com/*',
      '// ==/UserScript==',
      "window.__fromTxt = 'yes';"
    ].join('\n'),
    'utf8'
  );
  const bareTxtPath = path.join(tempRoot, '裸文本片段.txt');
  fs.writeFileSync(bareTxtPath, "window.__bareTxt = 'ok';", 'utf8');

  store.reload();
  const userScripts = store.list().filter((s) => s.source !== 'builtin');
  check(
    '脚本目录读取',
    userScripts.length === 6,
    `用户脚本 ${userScripts.length} 个（左侧列表共 ${store.list().length} 个）`
  );

  const builtins = store.builtinList();
  const builtinOnDisk = builtins.filter((b) => fs.existsSync(path.join(dir, b.file)));
  const shownBuiltins = store.list().filter((s) => s.source === 'builtin');
  const hiddenBuiltins = builtins.filter((b) => shownBuiltins.indexOf(b) < 0);
  check(
    '⑱ 内置脚本随软件加载、不落盘；其中「自动回复」按需出现在左侧列表，其余隐藏',
    builtins.length === 4 &&
      builtins.every((b) => b.enabled) &&
      shownBuiltins.length === 1 &&
      shownBuiltins[0].name.indexOf('自动回复') >= 0 &&
      hiddenBuiltins.length === 3 &&
      builtinOnDisk.length === 0,
    `内置 ${builtins.length} 个：${builtins.map((b) => b.name).join('、')} | ` +
      `左侧列表 ${shownBuiltins.length} 个（${shownBuiltins.map((b) => b.name).join('、')}）| ` +
      `落到用户目录的 ${builtinOnDisk.length} 个`
  );

  // 左侧列表里那个内置脚本必须真的能被开关（不然露脸也没用）
  const target = shownBuiltins[0];
  const offRes = store.setEnabled(target.id, false);
  const offNow = store.get(target.id);
  const onRes = store.setEnabled(target.id, true);
  const onNow = store.get(target.id);
  check(
    '⑲ 左侧列表里的内置脚本可以开关（自动回复）',
    offRes.ok && offNow && offNow.enabled === false && onRes.ok && onNow && onNow.enabled === true,
    `id=${target.id} 关掉后=${offNow && offNow.enabled} 再打开后=${onNow && onNow.enabled}`
  );

  // 开关脚本要顺手刷新当前网页 —— 这是主进程的行为，静态确认调用点还在
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const setEnabledBlock = /ipcMain\.handle\('scripts:setEnabled'[\s\S]*?\n  \}\);/.exec(mainSrc);
  check(
    '⑳ 开关脚本后自动刷新当前网页',
    !!setEnabledBlock && setEnabledBlock[0].indexOf('reloadActiveWebPage()') >= 0,
    setEnabledBlock ? '已调用 reloadActiveWebPage' : '没找到 scripts:setEnabled 处理器'
  );

  // 诊断：缓存目录到底存不存在
  const cacheDirPath = store.cacheDirectory();
  let cacheCanary = '未写入';
  try {
    fs.writeFileSync(path.join(cacheDirPath, '.canary'), 'x', 'utf8');
    cacheCanary = '可写';
    fs.unlinkSync(path.join(cacheDirPath, '.canary'));
  } catch (e) {
    cacheCanary = '写入失败：' + e.message;
  }
  check(
    '⑬a 依赖缓存目录已就绪',
    fs.existsSync(cacheDirPath) && cacheCanary === '可写',
    `路径=${cacheDirPath} 存在=${fs.existsSync(cacheDirPath)} 可写性=${cacheCanary}`
  );

  // ---------------- 加入外部目录 ----------------
  const addRes = store.addExternalDir(externalDir);
  const externalScript = store.list().find((s) => s.source === 'external');
  check(
    '⑪ 外部脚本目录里的脚本会被加载',
    addRes.ok && !!externalScript && externalScript.name === '搜书吧免银币下载',
    externalScript ? `来源=${externalScript.source} 文件名=${externalScript.file}` : '没扫到外部脚本'
  );

  // ---------------- 缓存 @require 依赖 ----------------
  const depRes = await store.ensureExternalDeps();
  const depScript = store.get('d-require.user.js');
  check(
    '⑬ @require 的外链依赖被缓存并在正文之前执行',
    depRes.downloaded >= 1 && !!depScript && depScript.requiresText.length === 1,
    `下载 ${depRes.downloaded} 个 | 脚本=${depScript ? depScript.id : 'null'} | requires=${JSON.stringify(
      depScript ? depScript.requires : null
    )} | 已缓存=${depScript ? depScript.requiresText.length : 0} | 失败=${JSON.stringify(depRes.failed)}`
  );

  // ---------------- 注册注入通道 ----------------
  registerDispatcherChannel({
    ipcMain,
    getScripts: () => store.injectionPayload()
  });

  // ---------------- 注册 GM API 通道 ----------------
  const registeredMenus = new Map();
  let menuSeq = 0;

  registerGmApi({
    ipcMain,
    resolveDownloadDir: () => path.join(tempRoot, 'Download'),
    uniqueTarget: (d, n) => path.join(d, String(n || 'download').replace(/[\\/:*?"<>|]/g, '_')),
    pushToast: () => {},
    registerMenu: (wcId, cmd) => {
      const id = 'm' + ++menuSeq;
      registeredMenus.set(id, Object.assign({ id, wcId }, cmd));
      return id;
    },
    unregisterMenu: (wcId, id) => registeredMenus.delete(id),
    invokeMenu: async (tabId, menuId) => {
      if (!targetWebContents) return false;
      return targetWebContents.executeJavaScript(buildMenuInvokeSource(menuId), true).catch(() => false);
    },
    listMenus: () => Array.from(registeredMenus.values())
  });

  // ---------------- 起窗口 ----------------
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'inject-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInSubFrames: true
    }
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });

  targetWebContents = view.webContents;
  await view.webContents.loadURL(baseUrl + '/page.html');
  await wait(800);

  const probe = await view.webContents.executeJavaScript(
    `({
       order: window.__order || [],
       injectedAt: window.__injectedAt || null,
       hasGM: window.__hasGM,
       shouldNotExist: window.__shouldNotExist,
       gmRoundtrip: window.__gmRoundtrip,
       domReadyAtEnd: window.__domReadyAtEnd,
       requireSawDep: window.__requireSawDep || null
     })`,
    true
  );

  console.log('主文档探针：', JSON.stringify(probe));

  const order = probe.order || [];
  check(
    '① 脚本先于网页脚本执行（真 document-start）',
    order.indexOf('userscript-start') !== -1 && order.indexOf('userscript-start') < order.indexOf('page-inline'),
    '执行顺序 = ' + JSON.stringify(order)
  );

  check('② 页面里可以拿到 GM API', probe.hasGM === true);
  check('③ 不匹配 @match 的脚本未执行', probe.shouldNotExist === undefined);
  check('④ GM_setValue / GM_getValue 可正常读写', probe.gmRoundtrip === 42, '读回 ' + probe.gmRoundtrip);
  check(
    '⑤ document-end 脚本在 DOM 就绪后执行',
    probe.domReadyAtEnd === 'interactive' || probe.domReadyAtEnd === 'complete',
    'readyState = ' + probe.domReadyAtEnd
  );

  // iframe
  const childFrames = view.webContents.mainFrame.frames;
  let frameInjected = null;
  if (childFrames.length) {
    try {
      frameInjected = await childFrames[0].executeJavaScript('window.__injectedAt || null');
    } catch (e) {
      frameInjected = '读取失败：' + e.message;
    }
  }
  check(
    '⑥ iframe 里同样完成注入',
    typeof frameInjected === 'string' && frameInjected.indexOf('frame.html') !== -1,
    '子 frame 地址 = ' + frameInjected + '（共 ' + childFrames.length + ' 个）'
  );

  // @require 真的执行了
  check(
    '⑬ @require 的依赖确实先跑起来了',
    probe.requireSawDep === 'dep-loaded',
    '读到依赖标记 = ' + probe.requireSawDep
  );

  // ---------------- GM_xmlhttpRequest ----------------
  const xhrDone = await waitFor(async () => {
    const state = await view.webContents.executeJavaScript('window.__xhrState', true);
    return state && state !== 'pending' ? state : null;
  });
  const xhr = await view.webContents.executeJavaScript(
    `({ status: window.__xhrStatus, body: window.__xhrBody, parsed: window.__xhrParsed, err: window.__xhrError })`,
    true
  );
  check(
    '⑭ GM_xmlhttpRequest 能拿到没有 CORS 头的跨域数据',
    xhrDone === 'done' && xhr.status === 200 && xhr.parsed === 'cross-origin',
    'state=' + xhrDone + ' status=' + xhr.status + ' 解析出=' + xhr.parsed + (xhr.err ? ' 错误=' + xhr.err : '')
  );

  // ---------------- GM_registerMenuCommand ----------------
  const menuOk = await waitFor(() => registeredMenus.size > 0);
  const menuEntry = registeredMenus.size ? Array.from(registeredMenus.values())[0] : null;

  let menuClicked = false;
  if (menuEntry) {
    await view.webContents.executeJavaScript(buildMenuInvokeSource(menuEntry.id), true);
    menuClicked = await view.webContents.executeJavaScript('window.__menuClicked === true', true);
  }

  check(
    '⑮ GM_registerMenuCommand 注册的命令能被调用',
    menuOk && !!menuEntry && menuEntry.name === '测试菜单命令' && menuClicked === true,
    menuEntry ? `命令名=${menuEntry.name} 点击回调执行=${menuClicked}` : '没注册上'
  );

  // ---------------- GM_setClipboard ----------------
  clipboard.writeText('before-scriptdock-test');
  await view.webContents.executeJavaScript("GM_setClipboard('脚本坞剪贴板测试');", true);
  await wait(250);
  check(
    '⑯ GM_setClipboard 写入系统剪贴板',
    clipboard.readText() === '脚本坞剪贴板测试',
    '剪贴板内容 = ' + clipboard.readText()
  );

  // ---------------- 用户真实脚本 ----------------
  await view.webContents.loadURL(baseUrl + '/forum.php?mod=viewthread&tid=123456');
  await wait(800);

  const forum = await view.webContents.executeJavaScript(
    `(function () {
       var first = document.querySelector('.buttons a');
       var untouched = document.querySelector('.buttons.already a');
       return {
         text: first ? first.textContent : null,
         href: first ? first.getAttribute('href') : null,
         target: first ? first.getAttribute('target') : null,
         untouchedHref: untouched ? untouched.getAttribute('href') : null
       };
     })()`,
    true
  );

  const expectedHref = '?mod=attachment&aid=' + Buffer.from('111222|1|1|1|333444').toString('base64');
  check(
    '⑫ 用户真实脚本在模拟帖子页上生效',
    forum.text === '免银币下载' && forum.href === expectedHref,
    '文案=' + forum.text + ' 链接=' + forum.href
  );
  check(
    '⑫b 不相关按钮未被误伤',
    forum.untouchedHref === 'mailto:x@y.com',
    '无关链接保持原样 = ' + forum.untouchedHref
  );

  // ---------------- 停用 ----------------
  store.setEnabled('a-start.user.js', false);
  await view.webContents.loadURL(baseUrl + '/page.html');
  await wait(800);

  const probe2 = await view.webContents.executeJavaScript(
    `({ injectedAt: window.__injectedAt || null, order: window.__order || [] })`,
    true
  );
  check(
    '⑦ 停用脚本后重新加载不再注入',
    !probe2.injectedAt,
    '执行顺序 = ' + JSON.stringify(probe2.order)
  );

  // ---------------- txt 导入 ----------------
  const imp = store.importPaths([txtPath, bareTxtPath]);
  const txtScript = store.list().find((s) => s.name === 'T 来自 txt 的脚本');
  const bareScript = store.list().find((s) => s.name === '裸文本片段');

  check(
    '⑧ .txt 被接收并转换成 .user.js',
    imp.imported.length === 2 && imp.skipped.length === 0 && !!txtScript && /\.user\.js$/i.test(txtScript.id),
    `导入 ${imp.imported.length} 个、跳过 ${imp.skipped.length} 个、落库 = ${txtScript ? txtScript.id : '无'}`
  );
  check(
    '⑨ txt 里的元数据头被正确解析',
    !!txtScript && txtScript.matches.includes('https://txt.example.com/*'),
    txtScript ? '匹配规则 = ' + JSON.stringify(txtScript.matches) : '未找到'
  );
  check(
    '⑩ 没有元数据的裸 txt 自动补全匹配规则',
    !!bareScript && bareScript.matches.length > 0 && /\.user\.js$/i.test(bareScript.id),
    bareScript ? '匹配规则 = ' + JSON.stringify(bareScript.matches) : '未找到'
  );

  // ---------------- 下载目录 ----------------
  const customDir = path.join(tempRoot, 'my-downloads');
  const customResolved = resolveDownloadDir(() => customDir);
  const defaultResolved = resolveDownloadDir(() => null);
  const besideExe = path.join(appFolder(), 'Download');
  const createdBeside = defaultResolved === besideExe && !fs.existsSync(besideExe);

  check(
    '⑰ 下载目录落在软件文件夹下的 Download',
    customResolved === customDir && path.basename(defaultResolved) === 'Download' && canWriteDir(defaultResolved),
    '自定义=' + customResolved + ' | 默认=' + defaultResolved
  );

  // 别把测试产生的目录留在 electron 安装目录里
  if (createdBeside) {
    try {
      fs.rmdirSync(besideExe);
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------- 搜书吧专有逻辑（纯函数，跑得快也最容易出边界问题） ----------------
  const forumLib = require('../src/main/forum');

  const strip1 = forumLib.stripWebsite('[sxsy.org]我的小说.txt');
  const strip2 = forumLib.stripWebsite('www.example.com_书名.zip');
  check(
    '⑲ 下载文件名去掉站点标记',
    strip1 === '我的小说.txt' && strip2 === '书名.zip',
    `"${strip1}" / "${strip2}"`
  );

  const norm1 = forumLib.normalizeUrl('www.a.com');
  const norm2 = forumLib.normalizeUrl('http://b.com/x');
  check(
    '⑳ 论坛地址规范化（补协议 + 补末尾斜杠）',
    norm1 === 'https://www.a.com/' && norm2 === 'http://b.com/x/',
    `${norm1} | ${norm2}`
  );

  // 弹窗（window.open / target=_blank）该怎么处理 —— 附件必须走后台静默下载
  const popupCases = [
    ['附件弹窗', { url: 'https://x.com/forum.php?mod=attachment&aid=MTIz' }, 'background'],
    ['txt 弹窗', { url: 'https://x.com/a/b.txt' }, 'background'],
    ['付费附件弹窗', { url: 'https://x.com/forum.php?mod=attachpay&aid=1' }, 'paid'],
    ['另存为', { url: 'https://x.com/x', disposition: 'save-to-disk' }, 'download'],
    ['blob 弹窗', { url: 'blob:https://x.com/abc' }, 'download'],
    ['about:blank 空弹窗', { url: 'about:blank' }, 'swallow'],
    ['javascript 弹窗', { url: 'javascript:void(0)' }, 'swallow'],
    ['站外链接', { url: 'https://other.com/x', isExternal: true }, 'external'],
    ['普通链接', { url: 'https://other.com/x' }, 'tab'],
    ['本地文件', { url: 'file:///C:/x.txt' }, 'block'],
    ['关掉自动下载后的附件', { url: 'https://x.com/forum.php?mod=attachment&aid=1', autoDownload: false }, 'tab']
  ];
  const popupWrong = popupCases
    .map(([name, opts, want]) => ({ name, want, got: forumLib.decidePopupAction(opts) }))
    .filter((r) => r.got !== r.want);
  check(
    '㉑·2 弹窗里的附件一律后台静默下载，不再开新页面',
    popupWrong.length === 0,
    popupWrong.length
      ? '不符：' + popupWrong.map((r) => `${r.name} 得到 ${r.got}（期望 ${r.want}）`).join('；')
      : `${popupCases.length} 种弹窗全部判定正确`
  );

  // ---------------------------------------------------------------
  // 真机验证：target="_blank" 点附件时，到底会不会冒出个新窗口
  // 用真实 Chromium + 真实的 installPopupHandler，不用桩
  // ---------------------------------------------------------------
  const { installPopupHandler } = require('../src/main/popupHandler');
  const popupEvents = [];
  const windowsBefore = BrowserWindow.getAllWindows().length;

  const popupWin = new BrowserWindow({
    show: false,
    width: 700,
    height: 500,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  installPopupHandler(popupWin.webContents, {
    getAutoDownload: () => true,
    isExternal: () => false,
    onBlock: (u) => popupEvents.push(['block', u]),
    onSwallow: (u) => popupEvents.push(['swallow', u]),
    onBackground: (u) => popupEvents.push(['background', u]),
    onDownload: (u) => popupEvents.push(['download', u]),
    onPaid: (u) => popupEvents.push(['paid', u]),
    onExternal: (u) => popupEvents.push(['external', u]),
    onTab: (u) => popupEvents.push(['tab', u])
  });

  await popupWin.webContents.loadURL(baseUrl + '/popup.html');
  await wait(600);

  for (const id of ['att', 'norm', 'blank']) {
    await popupWin.webContents.executeJavaScript(
      `document.querySelector('#${id}').click()`,
      true
    );
    await wait(450);
  }

  const windowsAfter = BrowserWindow.getAllWindows().length;
  const attHit = popupEvents.some(
    (e) => e[0] === 'background' && /mod=attachment/.test(e[1])
  );
  const tabHit = popupEvents.some((e) => e[0] === 'tab' && /normal\.html/.test(e[1]));
  const blankSwallowed = popupEvents.some((e) => e[0] === 'swallow' && /^about:/.test(e[1]));

  check(
    '㉑·3 真机：点 target=_blank 的附件 → 走后台下载，且没有多出窗口',
    attHit && tabHit && blankSwallowed && windowsAfter === windowsBefore + 1,
    `事件=${JSON.stringify(popupEvents)} | 窗口数 ${windowsBefore}→${windowsAfter}（+1 是测试窗自己）`
  );

  try {
    popupWin.destroy();
  } catch (e) {
    /* 忽略 */
  }

  // ---------------- 右键 / 长按菜单（纯模板） ----------------
  const cm = require('../src/main/contextMenu');
  const cmEditable = cm.buildContextMenu(
    { isEditable: true, editFlags: { canPaste: true } },
    { tabMode: false }
  );
  const cmEditableIds = cmEditable.map((i) => i.id).filter((id) => id !== 'sep');
  check(
    '㉑·4 界面里的输入框右键菜单带「粘贴」（这就是长按粘贴的入口）',
    cmEditableIds.indexOf('paste') >= 0 &&
      cmEditableIds.indexOf('copy') >= 0 &&
      cmEditableIds.indexOf('selectAll') >= 0 &&
      cmEditableIds.indexOf('cut') >= 0,
    '菜单项 = ' + JSON.stringify(cmEditableIds)
  );

  const cmTabLink = cm.buildContextMenu(
    { linkURL: 'https://x.com/a', pageURL: 'https://x.com/', isEditable: false },
    { tabMode: true, canGoBack: true, canGoForward: false, devTools: true }
  );
  const cmTabIds = cmTabLink.map((i) => i.id);
  check(
    '㉑·5 网页标签页的菜单仍带链接操作与前进后退（没被改坏）',
    cmTabIds.indexOf('openLinkInTab') >= 0 &&
      cmTabIds.indexOf('copyLink') >= 0 &&
      cmTabIds.indexOf('reload') >= 0 &&
      cmTabIds.indexOf('toggleDevTools') >= 0 &&
      cmTabLink.filter((i) => i.id === 'forward')[0].enabled === false,
    '菜单项 = ' + JSON.stringify(cmTabIds)
  );

  const cmNothing = cm.buildContextMenu({ isEditable: false }, { tabMode: false });
  check(
    '㉑·6 界面里点到空白处不弹空菜单（也不留光秃秃的分隔线）',
    cmNothing.length === 0,
    '菜单项 = ' + JSON.stringify(cmNothing)
  );

  // ---------------- 清空缓存：绝不能把用户登出 ----------------
  const cacheLib = require('../src/main/cache');
  await session.defaultSession.cookies.set({
    url: 'https://clear-cache-test.example.com/',
    name: 'sid',
    value: 'keep-me',
    expirationDate: Math.floor(Date.now() / 1000) + 86400
  });

  let depCleared = 0;
  const cleaner = cacheLib.createCacheCleaner({
    session: session.defaultSession,
    clearDepCache: () => {
      depCleared += 1;
      return { removed: 3 };
    }
  });
  const cacheRes = await cleaner.clear();

  const cookiesLeft = await session.defaultSession.cookies.get({
    url: 'https://clear-cache-test.example.com/'
  });
  const stillLoggedIn = cookiesLeft.some((c) => c.name === 'sid' && c.value === 'keep-me');

  check(
    '㉑·7 清空缓存会清网页缓存，但绝不动 Cookie（不会被登出）',
    cacheRes.ok === true && cacheRes.http === true && cacheRes.deps === 3 &&
      depCleared === 1 && stillLoggedIn === true,
    `网页缓存=${cacheRes.http} 依赖=${cacheRes.deps} 释放=${Math.round(cacheRes.freedBytes / 1024)}KB ` +
      `Cookie 还在=${stillLoggedIn}`
  );

  // 界面窗口有没有挂右键菜单 —— 装了才可能在输入框里弹出「粘贴」
  const mainSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  check(
    '㉑·8 界面窗口挂了 context-menu（否则输入框右键 / 长按一片安静）',
    /win\.webContents\.on\('context-menu'/.test(mainSrc2),
    /win\.webContents\.on\('context-menu'/.test(mainSrc2) ? '已挂载' : '没找到挂载点'
  );

  const decided = forumLib.decideFilename({
    threadSubject: '《测试书名》 作者某某',
    disposition: 'attachment; filename="garbled_12345.dat"',
    url: 'https://x.com/attachment.php?aid=1',
    suggested: 'garbled_12345.dat',
    contentType: 'text/plain'
  });
  check('㉑ 下载文件名优先取帖子标题', decided === '《测试书名》 作者某某.txt', '得到 = ' + decided);

  const fallbackName = forumLib.decideFilename({
    disposition: 'attachment; filename="noext"',
    url: 'https://x.com/a.php',
    suggested: '',
    contentType: 'application/pdf'
  });
  check('㉒ 没有后缀时按 Content-Type 补全', fallbackName === 'noext.pdf', '得到 = ' + fallbackName);

  const mimeOnly = forumLib.decideFilename({ url: 'https://x.com/attachment.php?aid=99' });
  check('㉓ 完全没有线索时兜底成 download.txt', mimeOnly === 'download.txt', '得到 = ' + mimeOnly);

  // 回归：帖子标题以「...」结尾时，path.extname() 会返回 '.'，
  // 曾被当成「已经有后缀」，于是补 .txt 那步被跳过 —— 下载成功但文件没后缀、
  // 双击打不开（真实用户反馈 tid=1108232）。
  const trailingDots = [
    ['三个点', '测试书名 第一章...'],
    ['一个点', '测试书名 第一章.'],
    ['全角省略号', '测试书名 第一章…'],
    ['点加空格', '测试书名 第一章 . ']
  ];
  const dotBad = trailingDots
    .map(([n, subj]) => ({
      n,
      got: forumLib.decideFilename({
        threadSubject: subj,
        disposition: '',
        url: 'https://x.com/forum.php?mod=attachment&aid=1',
        suggested: '',
        contentType: 'application/octet-stream',
        head: Buffer.from('《第一章 正文', 'utf8')
      })
    }))
    .filter((r) => !r.got.endsWith('.txt') || /\.$/.test(r.got));
  check(
    '㉓·2 标题以「...」/「.」/「…」结尾时，照样补上 .txt（不能落盘成没后缀）',
    dotBad.length === 0,
    dotBad.length
      ? '出问题：' + dotBad.map((r) => r.n + ' → ' + JSON.stringify(r.got)).join('；')
      : trailingDots.length + ' 种结尾全部补上了 .txt'
  );

  // 正常的后缀不能被误改
  const keepZip = forumLib.decideFilename({
    threadSubject: '《书名》.zip',
    url: 'https://x.com/forum.php?mod=attachment&aid=1',
    contentType: 'application/zip',
    head: Buffer.from('PK\u0003\u0004', 'binary')
  });
  check('㉓·3 真后缀（.zip）保持不动', keepZip === '《书名》.zip', '得到 = ' + keepZip);

  // 发布页自动跳转：这是搜书吧最有用的一个「自动」，链接挑选逻辑必须靠得住
  await view.webContents.loadURL(baseUrl + '/publish.html');
  await wait(500);
  const pick = JSON.parse(await view.webContents.executeJavaScript(forumLib.ENTRY_JUMP_JS, true));
  await wait(900);
  const landed = view.webContents.getURL();

  check(
    '㉔ 地址发布页能自动挑出「最新地址」并跳转过去',
    pick.cand === 1 && landed.indexOf('/forum-index.html') >= 0,
    `挑中 = ${pick.target || '（无）'} | 落地 = ${landed}`
  );

  check(
    '㉕ 发布页识别：entry 链路判断正确',
    forumLib.isEntryUrl('https://www.soushu2030.com/') === true &&
      forumLib.isEntryUrl('http://x.soushufabu.top:2228/o/?a=1') === true &&
      forumLib.isEntryUrl('https://dq3s.b4e5w4dqwde.com/forum.php') === false,
    'soushu2030=' + forumLib.isEntryUrl('https://www.soushu2030.com/')
  );

  // 相对路径的发布页也要能跳（发布页写法不固定）
  await view.webContents.loadURL(baseUrl + '/publish-relative.html');
  await wait(500);
  const pickRel = JSON.parse(await view.webContents.executeJavaScript(forumLib.ENTRY_JUMP_JS, true));
  await wait(900);
  const landedRel = view.webContents.getURL();

  check(
    '㉖ 发布页用相对路径时也能补成绝对地址并跳转',
    pickRel.cand === 1 && pickRel.target.indexOf('/forum-relative.html') >= 0 && landedRel.indexOf('/forum-relative.html') >= 0,
    `挑中 = ${pickRel.target} | 落地 = ${landedRel}`
  );

  // 论坛导航页不能被误判成发布页 —— 否则会把用户从帖子页拽回首页
  await view.webContents.loadURL(baseUrl + '/forum-nav.html');
  await wait(500);
  const navPick = JSON.parse(await view.webContents.executeJavaScript(forumLib.ENTRY_JUMP_JS, true));
  await wait(800);
  const navLanded = view.webContents.getURL();

  check(
    '㊶ 论坛导航页不会被误当成发布页跳走',
    navPick.strong === 0 && navPick.jumped !== true && navLanded.indexOf('/forum-nav.html') >= 0,
    `判定为发布页=${navPick.strong} 跳转=${!!navPick.jumped} 落地=${navLanded.replace(baseUrl, '')}`
  );

  // ---------------- 附件下载链路（伪造签名 → 失效提示页 → 真实文件） ----------------
  const dlDir = path.join(tempRoot, 'dl-attachment');
  fs.mkdirSync(dlDir, { recursive: true });

  const downloader = createAttachmentDownloader({
    request: httpLib.request,
    cookiesFor: async () => 'sid=testcookie',
    downloadDir: () => dlDir,
    uniqueTarget: (d, n) => path.join(d, n),
    decideFilename: forumLib.decideFilename,
    isFileResponse: forumLib.isFileResponse,
    findRetryDownloadLink: forumLib.findRetryDownloadLink,
    userAgent: 'test-agent'
  });

  const fakeUrl = baseUrl + '/attachment.php?aid=FAKE';
  const dlRes = await downloader.download(fakeUrl, {
    referer: baseUrl + '/forum.php?mod=viewthread&tid=1',
    threadSubject: '我的测试书'
  });
  const savedFiles = dlRes.ok ? fs.readdirSync(dlDir) : [];

  check(
    '㉗ 附件自动跟随「重新下载」并落盘（含站点标记清理）',
    dlRes.ok && savedFiles.length === 1 && savedFiles[0] === '我的测试书.txt',
    dlRes.ok
      ? `跳数=${dlRes.hops} 落盘=${JSON.stringify(savedFiles)}`
      : `失败：${dlRes.reason}`
  );

  check(
    '㉘ 附件地址识别：只认附件、不误判普通帖子页',
    forumLib.isAttachmentUrl(fakeUrl) === true &&
      forumLib.isAttachmentUrl(baseUrl + '/forum.php?mod=viewthread&tid=1') === false &&
      forumLib.isAttachmentUrl(baseUrl + '/attachment.php?mod=misc&action=attachpay&aid=1') === false,
    '附件=true 帖子页=false 付费=false'
  );

  // ---------------- 下载进度（底部状态栏那条进度条的**数据源**） ----------------
  // 界面那半截（进度条怎么画）在 test/uismoke.js 里；这里验证数据是真的：
  // http.js 报字节 → attachment.js 只把「真文件那一跳」转出去。
  const bigDir = path.join(tempRoot, 'dl-big');
  fs.mkdirSync(bigDir, { recursive: true });

  const progressEvents = [];
  const bigDownloader = createAttachmentDownloader({
    request: httpLib.request,
    cookiesFor: async () => 'sid=testcookie',
    downloadDir: () => bigDir,
    uniqueTarget: (d, n) => path.join(d, n),
    decideFilename: forumLib.decideFilename,
    isFileResponse: forumLib.isFileResponse,
    findRetryDownloadLink: forumLib.findRetryDownloadLink,
    userAgent: 'test-agent'
  });

  const bigRes = await bigDownloader.download(baseUrl + '/attachment.php?aid=BIG', {
    referer: baseUrl + '/forum.php?mod=viewthread&tid=1',
    threadSubject: '大文件进度测试',
    onProgress: (received, total) => progressEvents.push({ received, total })
  });

  const totals = Array.from(new Set(progressEvents.map((p) => p.total)));
  const last = progressEvents[progressEvents.length - 1] || null;
  const monotonic = progressEvents.every((p, i) => i === 0 || p.received >= progressEvents[i - 1].received);

  check(
    '㊽·2 大文件会分多次报进度（不是读完才报一次）',
    bigRes.ok && progressEvents.length >= 3,
    bigRes.ok ? `回调 ${progressEvents.length} 次 | 落盘=${JSON.stringify(fs.readdirSync(bigDir))}` : '下载失败：' + bigRes.reason
  );

  check(
    '㊽·3 进度里的总长就是文件真实大小',
    totals.length === 1 && totals[0] === BIG_SIZE,
    `出现过的 total = ${JSON.stringify(totals)}（应为 [${BIG_SIZE}]）`
  );

  check(
    '㊽·4 进度只报真文件那一跳（提示页的字节不能混进来）',
    last && last.received === BIG_SIZE && last.total === BIG_SIZE,
    `最后一次 = ${JSON.stringify(last)}`
  );

  check(
    '㊽·5 进度是单调递增的（进度条不会往回跳）',
    monotonic,
    monotonic ? `${progressEvents.length} 个采样点` : '出现回退：' + JSON.stringify(progressEvents.slice(0, 6))
  );

  check(
    '㊽·6 没传 onProgress 也照样能下载（回调是可选的）',
    await (async () => {
      const r = await bigDownloader.download(baseUrl + '/attachment.php?aid=BIG', {
        referer: baseUrl + '/forum.php?mod=viewthread&tid=1',
        threadSubject: '不带回调'
      });
      return r.ok === true;
    })(),
    '不带 onProgress 的下载也成功'
  );

  check(
    '㉙ 响应类型判定：HTML 提示页不算文件',
    forumLib.isFileResponse({ 'content-type': 'text/html; charset=gbk' }) === false &&
      forumLib.isFileResponse({ 'content-type': 'application/octet-stream' }) === true &&
      forumLib.isFileResponse({ 'content-disposition': 'attachment; filename="a.bin"' }) === true,
    'HTML→false, octet-stream→true, attachment→true'
  );

  // 纯文本（没有 Content-Disposition）也要当文件落盘，不能在标签页里显示成一堆字
  const txtUrl = baseUrl + '/novel.txt';
  const txtRes = await downloader.download(txtUrl, {
    referer: baseUrl + '/forum.php?mod=viewthread&tid=1',
    threadSubject: '测试小说'
  });
  const txtFiles = fs.readdirSync(dlDir);

  check(
    '㊼ txt 当文件下载（即使服务器没给 Content-Disposition）',
    txtRes.ok && txtFiles.indexOf('测试小说.txt') >= 0,
    txtRes.ok ? '落盘 = ' + JSON.stringify(txtFiles) : '失败：' + txtRes.reason
  );

  check(
    '㊾b 付费附件地址会被单独识别（不自动下载，交给论坛购买页）',
    forumLib.isPaidAttachmentUrl(baseUrl + '/forum.php?mod=misc&action=attachpay&aid=1') === true &&
      forumLib.isPaidAttachmentUrl(baseUrl + '/forum.php?mod=attachment&aid=1') === false,
    'attachpay=true 普通附件=false'
  );

  check(
    '㊽ txt 地址识别正确（txt 走下载而不是在标签页里显示成文字）',
    forumLib.isTextFileUrl(txtUrl) === true &&
      forumLib.isTextFileUrl(baseUrl + '/forum.php?mod=viewthread&tid=1') === false &&
      forumLib.isTextFileUrl(baseUrl + '/a.TXT') === true,
    'txt=true 帖子页=false 大写TXT=true'
  );

  // ---------------- 静态检查：CSS 不能被改坏 ----------------
  // 踩过的坑：手工清理样式时误删了一条 `{ display: none; }`，
  // 导致选择器列表被腰斩、和后面的 .sidebar 规则合并，
  // 后果是「侧栏收起时该隐藏的东西没隐藏」，把窄条挤成 74px 高。
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

  let depth = 0;
  let unbalanced = false;
  for (let i = 0; i < cssSrc.length; i += 1) {
    if (cssSrc[i] === '{') depth += 1;
    else if (cssSrc[i] === '}') {
      depth -= 1;
      if (depth < 0) { unbalanced = true; break; }
    }
  }

  // 逗号后直接跟注释或右括号 = 选择器列表被腰斩
  const dangling = [];
  const dangRe = /,\s*(\/\*[\s\S]*?\*\/\s*)?[}{]/g;
  let dm;
  while ((dm = dangRe.exec(cssSrc)) !== null) {
    dangling.push('第 ' + cssSrc.slice(0, dm.index).split('\n').length + ' 行');
  }

  check(
    '㊻ CSS 完整性：花括号配平、选择器列表没被腰斩',
    !unbalanced && depth === 0 && dangling.length === 0,
    `depth=${depth} 腰斩选择器=${dangling.length}${dangling.length ? '（' + dangling.join('、') + '）' : ''}`
  );

  // ---------------- 静态检查：元素 id 必须对得上 ----------------
  // 这条专门防「改了 HTML 却漏删 JS 里的引用」——那种错会让 $('x') 返回 null，
  // 紧接着 addEventListener 抛异常，后面所有按钮都绑不上，表现是「界面点不动」。
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

  const usedIds = Array.from(new Set(Array.from(appSrc.matchAll(/\$\('([^']+)'\)/g)).map((m) => m[1])));
  const htmlIds = new Set(Array.from(htmlSrc.matchAll(/id="([^"]+)"/g)).map((m) => m[1]));
  const missingIds = usedIds.filter((id) => !htmlIds.has(id));

  check(
    '㊱ app.js 引用的元素 id 在 HTML 里都存在',
    missingIds.length === 0,
    missingIds.length ? '缺失：' + JSON.stringify(missingIds) : `核对 ${usedIds.length} 个 id，全部存在`
  );

  // ---------------- 界面结构（防止改 HTML 时误删/误加元素） ----------------
  // ---------------- 界面：结构 + 真的点一遍 ----------------
  // 光断言「元素存在」抓不到「按钮点了没反应」这类问题，所以这里把
  // init() 需要的 IPC 全部桩起来，然后真的派发 click 事件看界面有没有响应。

  ipcMain.handle('app:info', () => ({
    version: '9.9.9-test',
    scriptsDir: 'X:/scripts',
    cacheDir: 'X:/cache',
    externalDirs: [],
    settings: { sidebarAutoCollapse: false, theme: 'light' },
    compat: { mode: 'auto', enabled: false },
    dispatchLog: []
  }));
  const savedPayloads = [];
  ipcMain.handle('scripts:save', (e, data) => {
    savedPayloads.push(data || {});
    return { id: 'fake-1.user.js', name: (data && data.name) || 'x' };
  });
  ipcMain.handle('scripts:listBuiltin', () => [
    {
      id: 'builtin|内置-去广告.user.js', name: '去广告（内置）', version: '1.0.0',
      matches: ['*://*/*'], includes: [], excludes: [], excludeMatches: [],
      requires: [], resources: [], runAt: 'document-end', noframes: false,
      enabled: true, source: 'builtin', builtin: true, code: 'x'
    }
  ]);
  ipcMain.handle('history:list', () => ({
    items: [
      { url: 'https://dq3s.b4e5w4dqwde.com/forum.php', title: '搜书吧论坛', at: 1789000000000 }
    ],
    total: 1
  }));
  ipcMain.handle('history:remove', () => ({ ok: true }));
  ipcMain.handle('history:clear', () => ({ ok: true, removed: 1 }));

  ipcMain.handle('scripts:list', () => [
    {
      id: 'fake-1.user.js',
      name: '测试脚本',
      version: '1.0.0',
      description: '自检用',
      matches: ['https://example.com/*'],
      includes: [],
      excludes: [],
      excludeMatches: [],
      requires: [],
      resources: [],
      runAt: 'document-end',
      noframes: false,
      enabled: true,
      source: 'internal',
      builtin: false,
      code: 'console.log(1);'
    },
    {
      id: 'builtin|内置-自动回复.user.js',
      name: '自动回复解锁',
      version: '2.2.6',
      description: '内置脚本',
      matches: ['*://*/*'],
      includes: [],
      excludes: [],
      excludeMatches: [],
      requires: [],
      resources: [],
      runAt: 'document-idle',
      noframes: false,
      enabled: true,
      source: 'builtin',
      builtin: true,
      path: 'D:/app/resources/app.asar/builtin-scripts/内置-自动回复.user.js',
      code: "console.log('builtin');"
    }
  ]);
  ipcMain.handle('scripts:reload', () => []);
  ipcMain.handle('app:logPath', () => 'X:/logs/app.log');
  ipcMain.handle('app:openLog', () => ({ ok: true }));
  const cacheCalls = [];
  ipcMain.handle('app:clearCache', () => {
    cacheCalls.push(Date.now());
    return { ok: true, http: true, code: true, deps: 2, freedBytes: 3 * 1048576 };
  });
  const compatWrites = [];
  ipcMain.handle('compat:set', (e, mode) => {
    compatWrites.push(mode);
    return { ok: true };
  });
  const settingsWrites = [];
  ipcMain.handle('settings:get', () => ({
    openForumOnStart: true,
    externalLinksToSystem: true,
    autoReloadOnSave: true,
    autoDownloadAttachments: true,
    refreshAfterDownload: true,
    sidebarAutoCollapse: false
  }));
  ipcMain.handle('settings:set', (e, patch) => {
    settingsWrites.push(patch || {});
    return patch || {};
  });
  ipcMain.handle('view:setBounds', () => true);
  ipcMain.handle('view:setVisible', () => true);
  ipcMain.handle('dirs:list', () => ({ dirs: [], scriptsDir: 'X:/scripts', cacheDir: 'X:/cache' }));
  ipcMain.handle('download:info', () => ({
    dir: 'X:/Download',
    count: 3,
    custom: '',
    portable: true
  }));
  ipcMain.handle('download:list', () => ({
    dir: 'X:/Download',
    files: [
      { name: '我的测试书.txt', path: 'X:/Download/我的测试书.txt', size: 2048, mtime: 1789000000000 },
      { name: '第二本.epub', path: 'X:/Download/第二本.epub', size: 1048576, mtime: 1789000100000 }
    ]
  }));
  const openedFiles = [];
  ipcMain.handle('download:openFile', (e, p) => {
    openedFiles.push(p);
    return { ok: true };
  });
  ipcMain.handle('download:reveal', () => ({ ok: true }));
  ipcMain.handle('forum:get', () => ({
    url: '',
    effective: 'https://www.soushu2030.com/',
    origin: '',
    defaultEntry: 'https://www.soushu2030.com',
    openOnStart: true,
    externalLinks: true,
    autoDownload: true,
    compat: { mode: 'auto', enabled: false }
  }));

  const uiWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 620,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 收集渲染进程的报错 —— init() 抛异常时会 console.error('初始化失败', e)
  const uiLogs = [];
  uiWin.webContents.on('console-message', (...args) => {
    const detail = args.find((a) => a && typeof a === 'object' && a.message);
    const msg = detail ? detail.message : args.find((a) => typeof a === 'string');
    if (msg) uiLogs.push(String(msg));
  });

  await uiWin.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(700);

  const ui = await uiWin.webContents.executeJavaScript(
    `({
       toolIds: Array.prototype.map.call(
         document.querySelectorAll('.tool-group > *'),
         function (e) { return e.id || e.className; }
       ),
       hasDevTools: !!document.querySelector('#btnDevTools'),
       compatInToolbar: !!document.querySelector('.toolbar #btnCompat'),

       hasSideDownload: !!document.querySelector('.sidebar #btnDownloads'),
       hasSideDownloadFolder: !!document.querySelector('.sidebar #btnOpenDownloadFolder'),
       hasSideSettings: !!document.querySelector('.sidebar #btnSettings'),
       hasSideForum: !!document.querySelector('.sidebar #btnGoForum'),
       hasSideExternal: !!document.querySelector('.sidebar #btnExternalDirs'),
       hasSideScripts: !!document.querySelector('.sidebar #btnImport'),
       hasSideNew: !!document.querySelector('.sidebar #btnNewScript'),
       hasSideFolder: !!document.querySelector('.sidebar #btnImportFolder'),
       hasSideSearch: !!document.querySelector('.sidebar #searchInput'),
       hasThemeBtn: !!document.querySelector('#btnTheme'),
       sideFoot: !!document.querySelector('.sidebar .side-foot'),

       railIds: Array.prototype.map.call(
         document.querySelectorAll('.rail .rail-btn'),
         function (e) { return e.id; }
       ),

       sForum: !!document.querySelector('#settingsDrawer #fForumUrl'),
       sDownload: !!document.querySelector('#settingsDrawer #dlPath'),
       sHistory: !!document.querySelector('#settingsDrawer #historyInfo'),
       setCards: Array.prototype.map.call(
         document.querySelectorAll('#settingsDrawer .set-card h3'),
         function (h) { return h.textContent; }
       ),
       scriptSetGone:
         !document.querySelector('#scriptSetDrawer') && !document.querySelector('#btnScriptSettings'),
       footLinks: Array.prototype.map.call(
         document.querySelectorAll('.side-foot .link'),
         function (b) { return b.textContent.trim(); }
       ),

       statusMsg: !!document.querySelector('.statusbar #statusMsg'),
       statusHasButton: !!document.querySelector('.statusbar button'),

       // 右上那几个按钮必须真的在可视区内、且没被压成 0 宽
       toolBox: (function () {
         var g = document.querySelector('.tool-group');
         var r = g.getBoundingClientRect();
         return {
           right: Math.round(r.right),
           width: Math.round(r.width),
           viewport: window.innerWidth
         };
       })(),
       toolAllVisible: Array.prototype.every.call(
         document.querySelectorAll('.tool-group > *'),
         function (e) {
           var r = e.getBoundingClientRect();
           return r.width > 0 && r.height > 0;
         }
       )
     })`,
    true
  );

  check(
    '㉚ 右上聚集：下载列表 / 下载文件夹 / 设置 齐全，且已无开发者模式与夜间模式',
    ui.hasDevTools === false &&
      ui.compatInToolbar === false &&
      ui.hasThemeBtn === false &&
      ui.toolIds.indexOf('btnDownloads') >= 0 &&
      ui.toolIds.indexOf('btnOpenDownloadFolder') >= 0 &&
      ui.toolIds.indexOf('btnSettings') >= 0 &&
      ui.toolAllVisible === true &&
      ui.toolBox.right <= ui.toolBox.viewport,
    `顶栏右侧 = ${JSON.stringify(ui.toolIds)} | 右边界=${ui.toolBox.right} 视口=${ui.toolBox.viewport} 全部可见=${ui.toolAllVisible}`
  );

  check(
    '㉛ 左侧只有「导入脚本 + 新建脚本」：文件夹/搜索/下载/设置入口都已移除',
    ui.hasSideDownload === false &&
      ui.hasSideDownloadFolder === false &&
      ui.hasSideSettings === false &&
      ui.hasSideForum === false &&
      ui.hasSideExternal === false &&
      ui.hasSideNew === true &&
      ui.hasSideFolder === false &&
      ui.hasSideSearch === false &&
      ui.hasSideScripts === true,
    `导入=${ui.hasSideScripts} 新建=${ui.hasSideNew} 文件夹=${ui.hasSideFolder} 搜索=${ui.hasSideSearch} 下载=${ui.hasSideDownload} 设置=${ui.hasSideSettings}`
  );

  check(
    '㉜ 窄条按钮收敛为展开 / 导入 / 固定',
    JSON.stringify(ui.railIds) === JSON.stringify(['railExpand', 'railImport', 'railPin']),
    '窄条 = ' + JSON.stringify(ui.railIds)
  );

  const wantSet = ['网站', '下载位置', '历史记录', '缓存'];
  const setOk = ui.setCards.length === wantSet.length && wantSet.every((t) => ui.setCards.indexOf(t) >= 0);

  check(
    '㉝ 设置面板四块：网站 / 下载位置 / 历史记录 / 缓存',
    setOk && ui.sForum && ui.sDownload && ui.sHistory,
    '设置分区 = ' + JSON.stringify(ui.setCards)
  );

  check(
    '㊾ 「脚本设置」面板已整体移除，排障入口收到侧栏底部',
    ui.scriptSetGone === true &&
      ui.footLinks.length === 2 &&
      ui.footLinks[0].indexOf('兼容模式') === 0 &&
      ui.footLinks[1] === '打开日志',
    `面板与入口已移除=${ui.scriptSetGone} 侧栏底部=${JSON.stringify(ui.footLinks)}`
  );

  check(
    '㉞ 状态栏只承载提示（功能已全部收到右上）',
    ui.statusMsg === true && ui.statusHasButton === false,
    `有提示区=${ui.statusMsg} 状态栏内还有按钮=${ui.statusHasButton}`
  );

  await uiWin.webContents.executeJavaScript("window.toast('下载测试','ok')", true);
  await wait(200);
  const statusText = await uiWin.webContents.executeJavaScript(
    "document.querySelector('#statusMsg').textContent",
    true
  );

  check(
    '㉟ 提示写进底部状态栏（不会再被网页盖住）',
    statusText === '下载测试',
    '状态栏文本 = ' + JSON.stringify(statusText)
  );

  // ---------------- 功能性验证：真的点一遍 ----------------

  const verText = await uiWin.webContents.executeJavaScript(
    "document.querySelector('#verText').textContent",
    true
  );
  const initFailed = uiLogs.filter((m) => m.indexOf('初始化失败') >= 0);

  check(
    '㊲ 界面初始化跑通（没有因缺元素而中断）',
    verText === 'v9.9.9-test' && initFailed.length === 0,
    `版本号=${verText} 初始化报错=${initFailed.length} 条${initFailed.length ? '：' + initFailed[0] : ''}`
  );

  await uiWin.webContents.executeJavaScript("document.querySelector('#btnSettings').click()", true);
  await wait(450);
  const openedAfterClick = await uiWin.webContents.executeJavaScript(
    "document.querySelector('#settingsDrawer').classList.contains('open')",
    true
  );
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnCloseSettings').click()", true);
  await wait(350);
  const closedAfterClick = await uiWin.webContents.executeJavaScript(
    "!document.querySelector('#settingsDrawer').classList.contains('open')",
    true
  );

  check(
    '㊳ 点「设置」能打开、点关闭能收起',
    openedAfterClick === true && closedAfterClick === true,
    `打开=${openedAfterClick} 收起=${closedAfterClick}`
  );

  // 侧栏底部：兼容模式可切换、「打开日志」能打开日志
  compatWrites.length = 0;
  const compatBefore = await uiWin.webContents.executeJavaScript(
    "document.querySelector('.side-foot #btnCompat').textContent",
    true
  );
  await uiWin.webContents.executeJavaScript(
    "document.querySelector('.side-foot #btnCompat').click()",
    true
  );
  await wait(400);
  const compatAfter = await uiWin.webContents.executeJavaScript(
    "document.querySelector('.side-foot #btnCompat').textContent",
    true
  );

  check(
    '㊴ 侧栏底部的兼容模式可以点击切换',
    compatWrites.length === 1 && compatBefore !== compatAfter && compatAfter.indexOf('强制开启') >= 0,
    `切换前=${compatBefore} 切换后=${compatAfter} 写回=${JSON.stringify(compatWrites)}`
  );

  await uiWin.webContents.executeJavaScript(
    "document.querySelector('.side-foot #btnOpenLog').click()",
    true
  );
  await wait(300);
  const noLogError = await uiWin.webContents.executeJavaScript(
    "document.querySelector('#statusMsg').className.indexOf('error') < 0",
    true
  );

  check(
    '㊴·2 侧栏底部的「打开日志」能正常触发',
    noLogError === true,
    '没有弹出错误提示 = ' + noLogError
  );

  const dlCountText = await uiWin.webContents.executeJavaScript(
    "document.querySelector('#dlCount').textContent",
    true
  );
  check('㊵ 右上下载入口显示文件数', dlCountText === '3', '计数 = ' + dlCountText);

  // 脚本列表 → 行内「编辑」按钮 → 编辑器
  const listInfo = await uiWin.webContents.executeJavaScript(
    `({
       items: document.querySelectorAll('#scriptList .script-item').length,
       firstName: (function () {
         var n = document.querySelector('#scriptList .script-name');
         return n ? n.textContent : '';
       })(),
       editText: (function () {
         var b = document.querySelector('#scriptList .script-item .small-btn');
         return b ? b.textContent : '';
       })(),
       buttonTexts: Array.prototype.map.call(
         document.querySelectorAll('#scriptList .script-item'),
         function (li) {
           var b = li.querySelector('.small-btn');
           return b ? b.textContent : '';
         }
       )
     })`,
    true
  );

  check(
    '55 每个脚本行都有按钮：普通脚本「编辑」、内置脚本「源码」',
    listInfo.items === 2 &&
      listInfo.buttonTexts[0] === '编辑' &&
      listInfo.buttonTexts[1] === '源码',
    `列表 ${listInfo.items} 项，按钮 = ${JSON.stringify(listInfo.buttonTexts)}`
  );

  await uiWin.webContents.executeJavaScript(
    "document.querySelector('#scriptList .script-item .small-btn').click()",
    true
  );
  await wait(400);

  const editor = await uiWin.webContents.executeJavaScript(
    `({
       open: document.querySelector('#drawer').classList.contains('open'),
       name: document.querySelector('#fName').value,
       code: document.querySelector('#fCode').value
     })`,
    true
  );

  const firstLine = (editor.code || '').split('\n')[0];

  check(
    '56 编辑器显示完整源码（含开头的 ==UserScript== 元数据块）',
    editor.open === true &&
      editor.name === '测试脚本' &&
      firstLine === '// ==UserScript==' &&
      editor.code.indexOf('@name') > 0 &&
      editor.code.indexOf('@match') > 0 &&
      editor.code.indexOf('console.log(1);') > 0,
    `首行=${JSON.stringify(firstLine)} 含@match=${editor.code.indexOf('@match') > 0} 含正文=${editor.code.indexOf('console.log(1);') > 0}`
  );

  // 改名称要同步到源码的 @name，避免「改哪儿不算数」
  await uiWin.webContents.executeJavaScript(
    "(function(){var i=document.querySelector('#fName');i.value='改名后';" +
      "i.dispatchEvent(new Event('input',{bubbles:true}));})()",
    true
  );
  await wait(250);
  const afterRename = await uiWin.webContents.executeJavaScript(
    "document.querySelector('#fCode').value",
    true
  );

  check(
    '57 改名称会同步写进源码的 @name',
    afterRename.indexOf('@name') > 0 && afterRename.indexOf('改名后') > 0,
    '源码里出现「改名后」= ' + (afterRename.indexOf('改名后') > 0)
  );

  // 保存：传给主进程的必须是「正文」，头由主进程重新生成，否则会越存越多
  savedPayloads.length = 0;
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnSave').click()", true);
  await wait(450);

  const saved = savedPayloads[0];
  const editorClosed = await uiWin.webContents.executeJavaScript(
    "!document.querySelector('#drawer').classList.contains('open')",
    true
  );

  check(
    '58 保存时剥掉元数据头（否则每存一次就多一个重复的头）',
    !!saved &&
      saved.code.indexOf('==UserScript==') < 0 &&
      saved.code.indexOf('console.log(1);') >= 0 &&
      saved.name === '改名后' &&
      (saved.matches || []).indexOf('https://example.com/*') >= 0 &&
      editorClosed === true,
    saved
      ? `名称=${saved.name} 正文带头=${saved.code.indexOf('==UserScript==') >= 0} 匹配=${JSON.stringify(saved.matches)} 已关闭=${editorClosed}`
      : '没有收到保存请求'
  );

  // 新建脚本：直接开一个空白编辑器
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnNewScript').click()", true);
  await wait(450);
  const fresh = await uiWin.webContents.executeJavaScript(
    `({
       open: document.querySelector('#drawer').classList.contains('open'),
       title: document.querySelector('#drawerTitle').textContent,
       name: document.querySelector('#fName').value,
       codeLen: document.querySelector('#fCode').value.length,
       nameReadonly: document.querySelector('#fName').readOnly,
       saveVisible: document.querySelector('#btnSave').style.display !== 'none',
       delHidden: document.querySelector('#btnDelete').style.visibility === 'hidden'
     })`,
    true
  );
  check(
    '59 点「新建脚本」直接开一个空白编辑器（不用先准备文件）',
    fresh.open === true &&
      fresh.title === '新建脚本' &&
      fresh.name === '' &&
      fresh.codeLen === 0 &&
      fresh.nameReadonly === false &&
      fresh.saveVisible === true &&
      fresh.delHidden === true,
    `标题=${fresh.title} 名称=${JSON.stringify(fresh.name)} 源码长度=${fresh.codeLen} ` +
      `保存可见=${fresh.saveVisible} 删除隐藏=${fresh.delHidden}`
  );
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnCancel').click()", true);
  await wait(350);

  // 内置脚本：能看源码，但不能改也不能删
  const builtinBtnLabel = await uiWin.webContents.executeJavaScript(
    `(function () {
       var items = document.querySelectorAll('#scriptList .script-item');
       for (var i = 0; i < items.length; i++) {
         var b = items[i].querySelector('.small-btn');
         if (b && b.textContent === '源码') { b.click(); return b.textContent; }
       }
       return '没找到内置脚本条目';
     })()`,
    true
  );
  await wait(450);
  const builtinEd = await uiWin.webContents.executeJavaScript(
    `({
       open: document.querySelector('#drawer').classList.contains('open'),
       title: document.querySelector('#drawerTitle').textContent,
       nameReadonly: document.querySelector('#fName').readOnly,
       codeReadonly: document.querySelector('#fCode').readOnly,
       saveHidden: document.querySelector('#btnSave').style.display === 'none',
       delHidden: document.querySelector('#btnDelete').style.visibility === 'hidden',
       code: document.querySelector('#fCode').value,
       badgeBuiltin: !!document.querySelector('#scriptList .script-badge.builtin')
     })`,
    true
  );
  const builtinFirstLine = (builtinEd.code || '').split('\n')[0];
  check(
    '60 内置脚本的「源码」只读：能看不能改、也不能删',
    builtinBtnLabel === '源码' &&
      builtinEd.open === true &&
      builtinEd.title === '查看内置脚本' &&
      builtinEd.nameReadonly === true &&
      builtinEd.codeReadonly === true &&
      builtinEd.saveHidden === true &&
      builtinEd.delHidden === true &&
      builtinFirstLine === '// ==UserScript==' &&
      builtinEd.badgeBuiltin === true,
    `按钮=${builtinBtnLabel} 标题=${builtinEd.title} 名称只读=${builtinEd.nameReadonly} ` +
      `源码只读=${builtinEd.codeReadonly} 保存隐藏=${builtinEd.saveHidden} ` +
      `首行=${JSON.stringify(builtinFirstLine)} 内置徽章=${builtinEd.badgeBuiltin}`
  );

  // 硬点保存也不能把内置脚本写进脚本目录（会生成名字带「|」的怪文件）
  const savesBefore = savedPayloads.length;
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnSave').click()", true);
  await wait(420);
  const guardState = await uiWin.webContents.executeJavaScript(
    "document.querySelector('#statusMsg').className",
    true
  );
  check(
    '61 内置脚本被硬触发保存也会拦住（不会写坏安装包）',
    savedPayloads.length === savesBefore && guardState.indexOf('error') >= 0,
    `保存请求 ${savesBefore}→${savedPayloads.length} | 状态栏 class="${guardState}"`
  );
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnCancel').click()", true);
  await wait(350);

  // ---------------------------------------------------------------
  // 输入框必须选得中 —— body 上有 user-select:none，会被继承下来
  // ---------------------------------------------------------------
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnNewScript').click()", true);
  await wait(420);
  const selProbe = await uiWin.webContents.executeJavaScript(
    `(function () {
       var ta = document.querySelector('#fCode');
       var nm = document.querySelector('#fName');
       ta.value = 'aaaa' + String.fromCharCode(10) + 'bbbb';
       ta.focus();
       ta.select();
       return {
         userSelect: getComputedStyle(ta).userSelect,
         nameSelect: getComputedStyle(nm).userSelect,
         bodySelect: getComputedStyle(document.body).userSelect,
         readOnly: ta.readOnly,
         editFlagsPaste: true,
         selectionStart: ta.selectionStart,
         selectionEnd: ta.selectionEnd
       };
     })()`,
    true
  );
  check(
    '62 编辑器输入框能选中文字（否则长按 / 右键都没有复制粘贴可选）',
    selProbe.userSelect === 'text' &&
      selProbe.nameSelect === 'text' &&
      selProbe.readOnly === false &&
      selProbe.selectionEnd > selProbe.selectionStart,
    `body=${selProbe.bodySelect}（应为 none，界面整体不选中）源码框=${selProbe.userSelect} ` +
      `名称框=${selProbe.nameSelect} 只读=${selProbe.readOnly} 选区=${selProbe.selectionStart}-${selProbe.selectionEnd}`
  );

  await uiWin.webContents.executeJavaScript("document.querySelector('#btnCancel').click()", true);
  await wait(320);

  // ---------------------------------------------------------------
  // 设置里的「清空缓存」
  // ---------------------------------------------------------------
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnSettings').click()", true);
  await wait(420);
  const cacheCard = await uiWin.webContents.executeJavaScript(
    `({
       hasBtn: !!document.querySelector('#settingsDrawer #btnClearCache'),
       hasPath: !!document.querySelector('#settingsDrawer #cachePath'),
       cards: Array.prototype.map.call(
         document.querySelectorAll('#settingsDrawer .set-card h3'),
         function (h) { return h.textContent; }
       )
     })`,
    true
  );
  check(
    '63 设置里有独立的「缓存」分区和清空缓存按钮',
    cacheCard.hasBtn === true && cacheCard.hasPath === true && cacheCard.cards.indexOf('缓存') >= 0,
    '分区 = ' + JSON.stringify(cacheCard.cards)
  );

  // 确认弹窗在自检里不能真弹（会卡住），先把它顶掉
  await uiWin.webContents.executeJavaScript(
    "(function () { window.__origConfirm = window.confirm; window.confirm = function () { return true; }; return true; })()",
    true
  );
  cacheCalls.length = 0;
  await uiWin.webContents.executeJavaScript(
    "document.querySelector('#settingsDrawer #btnClearCache').click()",
    true
  );
  await wait(450);

  const cacheToast = await uiWin.webContents.executeJavaScript(
    "({ cls: document.querySelector('#statusMsg').className, text: document.querySelector('#statusMsg').textContent })",
    true
  );
  check(
    '64 点「清空缓存」会真的走 IPC 并把结果显示在状态栏',
    cacheCalls.length === 1 && cacheToast.cls.indexOf('ok') >= 0 && /缓存已清空/.test(cacheToast.text),
    `调用次数=${cacheCalls.length} 状态栏="${cacheToast.text}"`
  );

  // ---------------------------------------------------------------
  // 下载列表要是「小浮窗」，不是半屏抽屉
  // ---------------------------------------------------------------
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnCloseSettings').click()", true);
  await wait(320);
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnDownloads').click()", true);
  await wait(520);
  const dlBox = await uiWin.webContents.executeJavaScript(
    `(function () {
       var el = document.querySelector('#downloadsDrawer');
       var r = el.getBoundingClientRect();
       return {
         open: el.classList.contains('open'),
         w: Math.round(r.width),
         h: Math.round(r.height),
         right: Math.round(window.innerWidth - r.right),
         top: Math.round(r.top),
         vh: window.innerHeight,
         vw: window.innerWidth
       };
     })()`,
    true
  );
  check(
    '65 右上「下载」弹的是小浮窗（窄、贴右上、不占满高度）',
    dlBox.open === true && dlBox.w > 0 && dlBox.w <= 400 && dlBox.h < dlBox.vh * 0.9 &&
      dlBox.right <= 24 && dlBox.top > 40,
    `已打开=${dlBox.open} 浮窗 ${dlBox.w}×${dlBox.h} 距右=${dlBox.right}px 距顶=${dlBox.top}px 窗口高=${dlBox.vh}`
  );
  await uiWin.webContents.executeJavaScript(
    "window.confirm = window.__origConfirm; document.querySelector('#btnCloseDownloads').click();",
    true
  );
  await wait(320);

  // 收起后的窄条排版
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnFoldSidebar').click()", true);
  await wait(300);

  const railBox = await uiWin.webContents.executeJavaScript(
    `(function () {
       var rail = document.querySelector('.rail').getBoundingClientRect();
       var side = document.querySelector('.sidebar').getBoundingClientRect();
       var pin = document.querySelector('#railPin').getBoundingClientRect();
       return {
         collapsed: document.querySelector('.app').classList.contains('sidebar-collapsed'),
         railH: Math.round(rail.height),
         sideH: Math.round(side.height),
         pinToBottom: Math.round(side.bottom - pin.bottom)
       };
     })()`,
    true
  );

  check(
    '㊹ 收起后窄条排版正确（撑满高度、底部按钮贴底）',
    railBox.collapsed === true &&
      Math.abs(railBox.railH - railBox.sideH) <= 2 &&
      railBox.pinToBottom <= 24,
    `窄条高=${railBox.railH} 侧栏高=${railBox.sideH} 底部按钮距底=${railBox.pinToBottom}px`
  );

  // 应用内下载列表
  await uiWin.webContents.executeJavaScript("document.querySelector('#btnDownloads').click()", true);
  await wait(500);

  const dlPanel = await uiWin.webContents.executeJavaScript(
    `({
       open: document.querySelector('#downloadsDrawer').classList.contains('open'),
       items: document.querySelectorAll('#dlList .dl-item').length,
       firstName: (document.querySelector('#dlList .dl-item-name') || {}).textContent || '',
       meta: document.querySelector('#dlPanelMeta').textContent
     })`,
    true
  );

  openedFiles.length = 0;
  await uiWin.webContents.executeJavaScript("document.querySelector('#dlList .dl-item').click()", true);
  await wait(300);

  check(
    '㊺ 应用内下载列表：点 ⤓ 能打开、列出文件、点文件会打开它',
    dlPanel.open === true &&
      dlPanel.items === 2 &&
      dlPanel.firstName === '我的测试书.txt' &&
      openedFiles.length === 1 &&
      openedFiles[0] === 'X:/Download/我的测试书.txt',
    `打开=${dlPanel.open} 列表 ${dlPanel.items} 项「${dlPanel.firstName}」(${dlPanel.meta})`
  );

  // ---------------- 50~52 文件名乱码修复 ----------------
  const iconvLib = require('iconv-lite');

  const mojibakeCases = [
    '【完结】斗破苍穹 作者：天蚕土豆.txt',
    '我的小说.txt',
    '测试书名 - 副本.txt',
    '《三体》全集.rar'
  ];

  const badRepairs = [];
  for (const name of mojibakeCases) {
    const garbled = iconvLib.encode(name, 'gbk').toString('latin1');
    const fixed = forumLib.repairName(garbled);
    if (fixed.best !== name) badRepairs.push(name + ' → ' + fixed.best);
  }

  check(
    '50 GBK 文件名乱码能被修回中文',
    badRepairs.length === 0,
    badRepairs.length ? '未修复：' + badRepairs.join('；') : mojibakeCases.length + ' 个样本全部修回'
  );

  check(
    '51 正常的文件名不会被乱改',
    forumLib.repairName('我的小说.txt').best === '我的小说.txt' &&
      forumLib.repairName('Novel 1984.txt').best === 'Novel 1984.txt' &&
      forumLib.repairName('doupo.epub').best === 'doupo.epub',
    '中英文正常名都原样保留'
  );

  const decidedMojibake = forumLib.decideFilename({
    disposition:
      'attachment; filename="' + iconvLib.encode('斗破苍穹.txt', 'gbk').toString('latin1') + '"',
    url: 'https://x.com/attachment.php?aid=1'
  });

  check(
    '52 下载决策用的是修复后的文件名',
    decidedMojibake === '斗破苍穹.txt',
    '得到 = ' + decidedMojibake
  );

  // ---------------- 53 浏览历史 ----------------
  const histFile = path.join(tempRoot, 'history-test.json');
  const hist = createHistoryStore(histFile);

  hist.add({ url: 'https://a.com/1', title: '第一本', at: 1000 });
  hist.add({ url: 'https://a.com/2', title: '第二本', at: 2000 });
  hist.add({ url: 'https://a.com/1', title: '第一本（再访）', at: 3000 });

  const afterAdd = hist.list();
  const dedupOk = afterAdd.length === 2 && afterAdd[0].url === 'https://a.com/1';
  const searchOk = hist.list('第二').length === 1;
  const searchUrlOk = hist.list('a.com/2').length === 1;
  const ignoreBad = hist.add({ url: 'scriptdock://start' }) === null;

  check(
    '53 历史记录：去重置顶 / 按标题和网址搜索 / 忽略非 http 地址',
    dedupOk && searchOk && searchUrlOk && ignoreBad && hist.count() === 2,
    `条数=${afterAdd.length} 置顶=${afterAdd[0].url} 搜标题=${searchOk} 搜网址=${searchUrlOk} 忽略内置页=${ignoreBad}`
  );

  const removedOne = hist.remove('https://a.com/2');
  const countAfterRemove = hist.count(); // 必须在 clear 之前取，否则拿到的是清空后的值
  const cleared = hist.clear();
  const countAfterClear = hist.count();

  check(
    '54 历史记录：删除单条与清空',
    removedOne.ok && countAfterRemove === 1 && cleared.removed === 1 && countAfterClear === 0,
    `删除=${removedOne.removed} 删后剩余=${countAfterRemove} 清空=${cleared.removed} 清空后=${countAfterClear}`
  );

  // ---------------- 汇总 ----------------
  const failed = results.filter((r) => !r.passed);
  console.log('\n' + '='.repeat(60));
  console.log(`自检完成：${results.length - failed.length}/${results.length} 项通过`);
  failed.forEach((f) => console.log('  未通过：' + f.name + ' → ' + f.detail));
  console.log('='.repeat(60));

  win.destroy();
  await wait(200);

  try {
    server.close();
  } catch (e) {
    /* ignore */
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }

  app.exit(failed.length ? 1 : 0);
}

let targetWebContents = null;

main().catch((e) => {
  console.error('自检异常：', e);
  app.exit(2);
});
