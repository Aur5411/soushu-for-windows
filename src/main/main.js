'use strict';

/**
 * 搜书吧电脑版 — 主进程
 *
 * 负责：窗口与标签页、脚本仓库、注入通道、兼容模式、IPC。
 */

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
  dialog,
  clipboard,
  Menu,
  protocol,
  screen,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');

// 名字要在 ready 之前定下来，userData 目录才是确定的
app.setName(require('./../shared/version').APP_NAME);

const store = require('./store');
const startPage = require('./startPage');
const http = require('./http');
const { registerGmApi } = require('./gmApi');
const { appFolder, resolveDownloadDir, uniqueTarget } = require('./downloadDir');
const { createAttachmentDownloader } = require('./attachment');
const { createHistoryStore } = require('./history');
const logger = require('./logger');
const {
  DEFAULT_ENTRY,
  DESKTOP_UA,
  ENTRY_JUMP_JS,
  normalizeUrl,
  originOf,
  hostMatchesMarkers,
  isEntryUrl,
  isRealHttpUrl,
  isAttachmentUrl,
  isPaidAttachmentUrl,
  isTextFileUrl,
  isFileResponse,
  findRetryDownloadLink,
  decideFilename
} = require('./forum');
const { installPopupHandler } = require('./popupHandler');
const { buildContextMenu, ROLE_ITEMS } = require('./contextMenu');
const { createCacheCleaner } = require('./cache');
const { registerDispatcherChannel, buildMenuInvokeSource } = require('./injector');
const { sdMatchUrl } = require('../shared/match');
const { VERSION, CODENAME } = require('../shared/version');

const TAG = '[搜书吧]';


// 必须在任何 console 输出之前启动，否则前面那些日志就丢了
logger.init(app.getPath('userData'));
console.log('日志文件：' + (logger.getLogFile() || '（不可写）'));


const TAB_PRELOAD = path.join(__dirname, '..', 'preload', 'inject-preload.js');
const UI_PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

// ==================================================================
// 兼容模式
//
// 有些环境（远程桌面、虚拟机、受限会话）里 Chromium 的沙箱进程起不来，
// 表现是渲染进程 ERR_FAILED 或 GPU 进程反复崩溃后直接 FATAL 退出。
// 这类环境需要关掉沙箱并改用软件渲染。
//
// 策略：默认自动判断 —— 上次启动崩过就切到兼容模式并记住；
// 用户也可以手动强制开/关。这里必须在 app ready 之前决定。
// ==================================================================

const compatStateFile = path.join(app.getPath('userData'), 'compat.json');

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    /* 状态文件写不了不影响运行 */
  }
}

/** 'auto' | 'on' | 'off' */
function resolveCompatMode() {
  if (process.argv.includes('--compat')) return 'on';
  if (process.argv.includes('--no-compat')) return 'off';

  const settings = readJsonSafe(path.join(app.getPath('userData'), 'settings.json'), {});
  if (settings.compatMode === true) return 'on';
  if (settings.compatMode === false) return 'off';
  return 'auto';
}

const compatMode = resolveCompatMode();
const compatHistory = readJsonSafe(compatStateFile, {});

let compatEnabled;
if (compatMode === 'on') {
  compatEnabled = true;
} else if (compatMode === 'off') {
  compatEnabled = false;
} else {
  // 自动：上次崩过 / 上次没跑完 / 远程桌面会话
  const remoteSession = /^RDP/i.test(process.env.SESSIONNAME || '');
  compatEnabled = compatHistory.compat === true || compatHistory.pending === true || remoteSession;
}

if (compatEnabled) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.disableHardwareAcceleration();
}

// 自动模式下记录「本次启动进行中」，窗口起来后清掉。
// 如果这次崩了，标记会留着，下次启动就自动进兼容模式。
if (compatMode === 'auto') {
  writeJsonSafe(compatStateFile, { compat: compatEnabled, pending: true, at: Date.now() });
}

// ==================================================================
// 起始页协议
// ==================================================================

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'scriptdock',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

let win = null;
let history = null;

/** tabId -> { id, view, title, url, loading } */
const tabs = new Map();
let activeTabId = null;
let contentBounds = { x: 0, y: 0, width: 0, height: 0 };
let contentVisible = true;

/**
 * 用户是不是点了右边的网页？
 *
 * 一开始想用「网页拿到焦点」来判断（WebContents 的 focus 事件），实测不行：
 * 开机首帧渲染、地址发布页自动跳转、站点重定向、切标签……都会让网页自己
 * 拿到焦点，用它当依据，面板会在开机几秒后自己收起来 —— 正是要修的毛病。
 * 试过用时间窗把「程序造成的焦点」滤掉，但每次发布页跳转的耗时都不一样，
 * 总有漏网的（实测有 5.7 秒、8.8 秒、12.1 秒各中过一次）。
 *
 * 换成 input-event：真正的鼠标按下去才会有 mouseDown，程序再怎么跳转都不会。
 * 判定依据从「猜」变成「事实」。
 */
function isPageClick(input) {
  const type = input && input.type;
  return (
    type === 'mouseDown' ||
    type === 'pointerDown' ||
    type === 'touchStart' ||
    type === 'gestureTapDown'
  );
}

/** 注入统计：最近命中的网址 */
const dispatchLog = [];

// ==================================================================
// 下载目录
//
// 需求：软件里所有下载的东西都落到「软件文件夹」里的 Download 目录。
// 路径解析逻辑在 downloadDir.js 里（独立模块，方便自检），这里只做接线。
// ==================================================================

/** 当前生效的下载目录 */
function downloadDir() {
  return resolveDownloadDir(() => store.getSettings().downloadDir);
}

/**
 * 生效的论坛地址：没手动配过就用内置入口。
 * 对齐 Android 版 Prefs.getUrl 默认空 + beginForumEntry 固定入口的逻辑。
 */
function effectiveForumUrl() {
  return store.getSettings().forumUrl || DEFAULT_ENTRY;
}

// ==================================================================
// 发布页自动跳转
//
// 内置入口 www.soushu2030.com 其实是个「地址发布页」：它用 .link-box 列出
// 当前最新的论坛地址，需要点进去才是真论坛。发布页的域名和结构会换，
// 所以不能写死选择器 —— 让页面里的脚本按关键词打分挑最像入口的那个链接。
//
// entryMode 只在「冷启动通往论坛」这段窗口内为 true：一旦进了真论坛就停手，
// 否则帖子页里的「首页」链接会被误命中，把用户拽回主页。
// ==================================================================

let entryMode = false;
let entryAttempt = 0;
let entryTimers = [];

function clearEntryTimers() {
  for (const t of entryTimers) clearTimeout(t);
  entryTimers = [];
}

function startEntryMode() {
  clearEntryTimers();
  entryMode = true;
  entryAttempt = 0;
}

function endEntryMode(success) {
  clearEntryTimers();
  entryMode = false;
  entryAttempt = 0;
  if (success) console.log( '已进入论坛，退出自动跳转窗口');
}

/** 发布页上按关键词打分挑「最新地址」并主框架直达 */
async function runEntryJump(wc, attempt) {
  if (!entryMode || wc.isDestroyed()) return;

  // 决定性保险：只在「当前页面确实还是发布页」时才动手。
  // 定时器有可能在跳转完成之后才轮到执行，那时页面已经是真论坛了 ——
  // 如果不检查，就会在论坛页上把「首页/论坛」之类的链接当成最新地址点掉，
  // 把用户从帖子页拽回首页。
  const current = wc.getURL();
  if (!isEntryUrl(current)) {
    endEntryMode(true);
    return;
  }

  let info = null;
  try {
    info = JSON.parse(await wc.executeJavaScript(ENTRY_JUMP_JS, true));
  } catch (e) {
    return;
  }

  if (!info || info.err) return;

  console.log(
    `发布页跳转第 ${attempt} 次：link-box ${info.linkBox} 个，最高分 ${info.score}，命中 ${info.target || '（无）'}`
  );

  // 页面不像发布页（没有 .link-box，链接也没写着「最新地址」）：
  // 说明已经不在入口链路上了，收手，别把论坛导航里的「首页」当成入口点掉
  if (!info.strong) {
    endEntryMode(true);
    return;
  }

  if (info.jumped) {
    pushToast('正在从地址发布页跳转到论坛…', 'info');
    return;
  }

  // 未命中但确认是发布页：链接可能是后注入的，再等一会儿重试（与 Android 版一致，最多 4 次）
  if (attempt < 4 && entryMode && !info.cand) {
    entryTimers.push(setTimeout(() => runEntryJump(wc, attempt + 1), 550));
    return;
  }

  if (attempt >= 4 && entryMode && !info.cand) {
    pushToast('发布页上没找到论坛入口，请手动点页面里的「最新地址」', 'error');
  }
}

function scheduleEntryJump(wc) {
  if (!entryMode) return;
  if (!isEntryUrl(wc.getURL())) return;
  clearEntryTimers();
  entryAttempt = 0;
  // 页面刚 load 完可能还在跳 about:blank，等一拍再查
  entryTimers.push(
    setTimeout(() => {
      entryAttempt += 1;
      runEntryJump(wc, entryAttempt);
    }, 350)
  );
}

/**
 * 记住真正的站点根。
 *
 * 论坛域名会换，内置入口只保证「能进去」；落地之后把实际域名写回去，
 * 下次启动直达，不用再走一次跳转（对齐 Android 版 rememberForumUrl）。
 *
 * 注意：发布页自己的地址**绝不能**记下来 —— 记了下次就直接去发布页，
 * 而且那时不在入口窗口内，不会再自动跳转，等于永久卡在发布页。
 */
function rememberForumOrigin(url) {
  if (!isRealHttpUrl(url)) return;
  if (isEntryUrl(url)) return;

  const origin = originOf(url);
  if (!origin) return;

  const current = store.getSettings().forumUrl;
  if (current && originOf(current) === origin) return;

  store.setSettings({ forumUrl: origin });
  if (win) win.webContents.send('settings:changed', store.getSettings());
  console.log( '已记住论坛站点根：' + origin);
}

/** 存下来的网址是否已经失效（指向发布页链路） */
function isStaleForumUrl(url) {
  return !!url && isEntryUrl(url);
}

/**
 * 打开论坛。
 * 已经知道真域名就直接进；否则走内置入口的发布页 + 自动跳转。
 */
function goForum() {
  const wc = activeWebContents();
  const configured = store.getSettings().forumUrl;

  if (configured && !isStaleForumUrl(configured)) {
    endEntryMode(false);
    if (wc) wc.loadURL(configured).catch(() => {});
    return configured;
  }

  startEntryMode();
  if (wc) wc.loadURL(DEFAULT_ENTRY).catch(() => {});
  return DEFAULT_ENTRY;
}

/** 启动时决定第一个标签页去哪，并同步好 entryMode */
function initialTarget() {
  const configured = store.getSettings().forumUrl;

  if (configured && !isStaleForumUrl(configured)) {
    endEntryMode(false);
    return configured;
  }

  // 没配过，或者存下来的域名已经退回发布页：重新走「发布页 → 最新地址」
  if (isStaleForumUrl(configured)) {
    console.log( '保存的论坛地址已失效（指向发布页），重新走自动跳转');
  }
  startEntryMode();
  return DEFAULT_ENTRY;
}

/** 给「下载目录」面板用的完整信息 */
function downloadInfo() {
  const dir = downloadDir();
  let count = 0;
  try {
    count = fs.readdirSync(dir).filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch (e) {
        return false;
      }
    }).length;
  } catch (e) {
    count = 0;
  }
  return {
    dir,
    count,
    custom: store.getSettings().downloadDir || '',
    defaultDir: path.join(appFolder(), 'Download'),
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR
  };
}

/**
 * 拦截网页自身发起的下载（点附件链接、脚本触发的 a[download] 等），
 * 统一存到 Download 目录，并顺手把文件名收拾干净。
 */
function setupDownloadInterceptor() {
  try {
    session.defaultSession.on('will-download', (event, item) => {
      const rawName = item.getFilename();
      const url = item.getURL();

      let disposition = '';
      try {
        const headers = item.getContentDisposition ? item.getContentDisposition() : '';
        disposition = headers || '';
      } catch (e) {
        disposition = '';
      }

      const wc = safeGetDownloadWebContents(item);
      const subject = wc ? threadSubjects.get(wc.id) || '' : threadSubjects.get(activeTabId) || '';

      const name = decideFilename({
        threadSubject: subject,
        disposition,
        url,
        suggested: rawName
      });

      // 落盘路径定了才不会弹保存框。这里连兜底都要有：
      // 一旦没设成，Electron 就会把系统「另存为」对话框弹出来 —— 那是用户明确不要的。
      let target = uniqueTarget(downloadDir(), name);
      let saved = applySavePath(item, target);
      if (!saved) {
        target = uniqueTarget(app.getPath('downloads'), name);
        saved = applySavePath(item, target);
      }
      if (!saved) {
        pushToast('无法确定保存位置，已取消下载：' + name, 'error');
        try {
          item.cancel();
        } catch (e2) {
          /* 取消失败也没别的办法了 */
        }
        return;
      }

      const base = path.basename(target);
      pushToast('开始下载：' + base, 'info');

      item.on('updated', (e2, state) => {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        if (state === 'interrupted') {
          reportDownloadProgress({ name: base, received, total, state: 'fail' }, true);
          pushToast('下载中断：' + base, 'error');
        } else {
          reportDownloadProgress({ name: base, received, total, state: 'progressing' });
        }
      });

      item.once('done', (e2, state) => {
        if (state === 'completed') {
          const size = item.getTotalBytes() || item.getReceivedBytes();
          reportDownloadProgress({ name: base, received: size, total: size, state: 'done' }, true);
          pushToast('已下载到 Download：' + base, 'ok');
          notifyDownloadDone();
        } else if (state === 'cancelled') {
          reportDownloadProgress({ name: base, state: 'cancelled' }, true);
          pushToast('下载已取消：' + base, 'info');
        } else {
          reportDownloadProgress({ name: base, state: 'fail' }, true);
          pushToast('下载失败：' + base, 'error');
        }
      });
    });
  } catch (e) {
    console.error(TAG + ' ' + '无法挂载下载拦截', e);
  }
}

/**
 * 给下载项设定落盘路径。设成了 → 浏览器就不会再弹「另存为」对话框。
 * 不抛异常，失败返回 false，由调用方决定兜底。
 */
function applySavePath(item, target) {
  try {
    item.setSavePath(target);
    return true;
  } catch (e) {
    console.error(TAG + ' 设置下载路径失败：' + target + ' | ' + ((e && e.message) || e));
    return false;
  }
}

/** DownloadItem 关联的 webContents 不一定拿得到，拿不到就退回当前标签页 */function safeGetDownloadWebContents(item) {
  try {
    if (typeof item.getWebContents === 'function') {
      const wc = item.getWebContents();
      if (wc && !wc.isDestroyed()) return wc;
    }
  } catch (e) {
    /* 老版本没有这个 API */
  }
  const tab = tabs.get(activeTabId);
  return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
}

/**
 * 记住帖子标题。下载时优先拿它当文件名 ——
 * Discuz 的附件名常常是乱码或纯数字，而帖子标题才是用户认得出的书名。
 */
const threadSubjects = new Map();

function rememberThreadSubject(id, wc) {
  wc
    .executeJavaScript(
      '(function(){var e=document.querySelector("#thread_subject, .tsubject, h1.ts");' +
        'return e && e.textContent ? e.textContent.trim() : "";})()',
      true
    )
    .then((title) => {
      if (title) threadSubjects.set(id, title);
      else threadSubjects.delete(id);
    })
    .catch(() => {});
}

/**
 * 站外链接交给系统浏览器。
 * 站点外的域名没理由占用这个窗口，也避免它变成一个通用浏览器。
 *
 * 两个必须放行的例外，否则会把「进入论坛」这条路堵死：
 *   1. 入口跳转期间（发布页 → 真论坛）一律放行。
 *      那时还不知道真域名是什么，跳转目标必然被判成「站外」，
 *      结果就是刚找到论坛地址又被丢给系统浏览器，永远进不去。
 *   2. 还没记住真域名时（forumUrl 为空或仍指向发布页）没有「站内」概念，先不拦。
 */
function shouldOpenExternally(targetUrl) {
  if (entryMode) return false;
  if (!store.getSettings().externalLinksToSystem) return false;
  if (!/^https?:\/\//i.test(targetUrl)) return false;

  const forum = store.getSettings().forumUrl;
  const forumHost =
    forum && !isEntryUrl(forum)
      ? (() => {
          try {
            return new URL(forum).host;
          } catch (e) {
            return '';
          }
        })()
      : '';

  if (!forumHost) return false;

  let host = '';
  try {
    host = new URL(targetUrl).host;
  } catch (e) {
    return false;
  }

  if (host === forumHost) return false;
  // 同一主域的子域也算站内
  if (host.endsWith('.' + forumHost.replace(/^www\./, ''))) return false;
  if (hostMatchesMarkers(host)) return false;

  return true;
}

/**
 * GM_registerMenuCommand 注册的命令。
 * tabId -> Map<menuId, { id, name, accessKey, url }>，导航时清空。
 */
const tabMenus = new Map();
let menuSeq = 0;

// ==================================================================
// 起始页
// ==================================================================

function handleStartProtocol() {
  protocol.handle('scriptdock', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return new Response('bad request', { status: 400 });
    }

    if (url.hostname !== 'start') {
      return new Response('Not Found', { status: 404 });
    }

    const html = startPage.render(store.list(), {
      version: VERSION,
      forumUrl: effectiveForumUrl(),
      builtinCount: store.builtinList().length
    });
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  });
}

// ==================================================================
// 主窗口
// ==================================================================

function createWindow() {
  // 按屏幕工作区自适应，避免小屏/缩放下窗口超出可视范围
  let work = { width: 1280, height: 800 };
  try {
    work = screen.getPrimaryDisplay().workAreaSize;
  } catch (e) {
    /* 拿不到就用默认值 */
  }

  const width = Math.min(1320, Math.max(880, work.width - 80));
  const height = Math.min(860, Math.max(560, work.height - 80));

  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(880, width),
    minHeight: Math.min(560, height),
    title: `${CODENAME} v${VERSION}`,
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: UI_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 界面自己的右键 / 长按菜单（输入框里的剪切/复制/粘贴就靠它）
  win.webContents.on('context-menu', (event, params) => openUiContextMenu(params));

  // ----------------------------------------------------------------
  // 标签页要**立刻**建，不要等 ready-to-show。
  //
  // 实测：界面首帧要等 Chromium 渲染进程冷启动（这台上约 1 秒），而论坛页
  // 联网还要两三秒。原来标签页是在 ready-to-show 里才建的，等于让最慢的
  // 那段（网络）白等了一秒。
  //
  // 现在两件事并行：界面画首帧的同时，论坛已经开始下载了。
  // 这么做不会「盖住界面」——新视图的 contentBounds 初始是 0×0，
  // 要等界面报上真实内容区尺寸才会撑开。
  // ----------------------------------------------------------------
  const bootSettings = store.getSettings();
  if (bootSettings.openForumOnStart !== false) createTab(initialTarget());
  else createTab('scriptdock://start');

  // 立刻把窗口显示出来。
  //
  // 构造函数里设了 backgroundColor: #f5f6f8（和界面底色一样），所以露出来的是
  // 「软件自己的底色 + 空壳」，不会白屏闪一下。界面首帧还得等渲染进程冷启动
  // （这台上实测约 1 秒），没必要让用户干等那一秒才看见窗口出现 ——
  // 实测窗口出现从 1.26s 提前到 0.24s。
  win.show();

  // 界面起来了说明这次启动没问题，清掉崩溃标记
  win.webContents.once('did-finish-load', () => {
    if (compatMode === 'auto') {
      writeJsonSafe(compatStateFile, { compat: compatEnabled, pending: false, at: Date.now() });
    }
  });

  win.on('resize', applyBounds);
  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    const wc = activeWebContents();

    if (ctrl && key === 't') {
      event.preventDefault();
      createTab('scriptdock://start');
    } else if (ctrl && key === 'w') {
      event.preventDefault();
      closeTab(activeTabId);
    } else if (ctrl && key === 'r') {
      event.preventDefault();
      if (wc) wc.reload();
    } else if (input.key === 'F12') {
      event.preventDefault();
      toggleDevTools();
    }
  });
}

// ==================================================================
// 标签页
// ==================================================================

function activeWebContents() {
  const tab = tabs.get(activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  return tab.view.webContents;
}

function createTab(url) {
  if (!win) return null;

  const view = new WebContentsView({
    webPreferences: {
      preload: TAB_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 让 preload 也进入 iframe：很多站点的正文在 iframe 里，
      // 油猴脚本默认也是全 frame 生效的。沙箱开着的，等于只借这个开关放行 preload。
      nodeIntegrationInSubFrames: true,
      spellcheck: false
    }
  });

  const wc = view.webContents;
  const id = wc.id;

  tabs.set(id, {
    id,
    view,
    title: '新标签页',
    url: url || '',
    loading: false,

  });
  win.contentView.addChildView(view);

  wireTab(id, wc);
  setActiveTab(id);

  wc.loadURL(url || 'scriptdock://start').catch((e) => {
    console.error(TAG + ' ' + '加载失败', url, e.message);
    pushToast('无法打开：' + (url || ''), 'error');
  });

  broadcastTabs();
  return id;
}

function wireTab(id, wc) {
  const update = (patch) => {
    const tab = tabs.get(id);
    if (!tab) return;
    Object.assign(tab, patch);
    broadcastTabs();
  };

  wc.on('page-title-updated', (e, title) => update({ title }));
  wc.on('did-start-loading', () => update({ loading: true }));

  // 换了页面，旧的菜单命令就失效了（脚本还没在新的文档里注册）
  wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    if (tabMenus.has(id)) {
      tabMenus.delete(id);
      broadcastMenus();
    }
  });

  wc.on('did-stop-loading', () => {
    if (tabs.has(id)) {
      const current = wc.getURL();
      update({ loading: false, url: current, title: wc.getTitle() });
      rememberThreadSubject(id, wc);

      // 论坛自己弹的「无法下载附件」这类提示，搬到状态栏并记日志
      reportForumMessage(wc);

      // 记浏览历史：跳过发布页链路与内置页面
      if (history && isRealHttpUrl(current) && !isEntryUrl(current)) {
        history.add({ url: current, title: wc.getTitle() });
        if (win) win.webContents.send('history:changed', { count: history.count() });
      }
    }
    // 还在发布页链路上就继续尝试自动跳转
    scheduleEntryJump(wc);
  });

  // 站外链接交给系统浏览器；本地文件一律不放行
  wc.on('will-navigate', (event, url) => {
    if (/^file:\/\//i.test(url)) {
      event.preventDefault();
      pushToast('已拦截对本地文件的访问', 'error');
      return;
    }

    // 付费附件不拦：让论坛自己的购买页出来，但要告诉用户为什么没自动下
    if (isPaidAttachmentUrl(url)) {
      console.log( '检测到付费附件链接，交给论坛页面处理：' + url);
      pushToast('这是付费附件（需要银币），软件不会自动下载', 'error');
      return;
    }

    // 附件 / 文本文件：截下来后台下载，帖子页不动，下完再刷新解锁
    // （.txt 也走这条路：论坛常把它当纯文本返回，不拦就会在标签页里显示成一堆文字，
    //   而用户要的是能用记事本打开的文件）
    if (
      store.getSettings().autoDownloadAttachments !== false &&
      (isAttachmentUrl(url) || isTextFileUrl(url))
    ) {
      event.preventDefault();
      handleAttachmentClick(wc, url);
      return;
    }

    if (shouldOpenExternally(url)) {
      event.preventDefault();
      shell.openExternal(url);
      pushToast('已用系统浏览器打开站外链接', 'info');
    }
  });

  wc.on('did-navigate', (e, url) => {
    update({ url, title: wc.getTitle() });

    if (!isRealHttpUrl(url)) return;

    // 落在发布页：可能是保存的域名失效后被重定向回来的，重新进入自动跳转
    // （不能只在冷启动时判断 —— 域名会过期，旧域名随时可能变成发布页跳转）
    if (isEntryUrl(url)) {
      if (!entryMode) {
        console.log( '检测到地址发布页，启动自动跳转');
        startEntryMode();
      }
      scheduleEntryJump(wc);
      return;
    }

    // 到达真正的论坛/内容页：退出入口窗口，并把真域名记下来
    if (entryMode) {
      endEntryMode(true);
      rememberForumOrigin(url);
      pushToast('已进入论坛', 'ok');
    }
  });
  wc.on('did-navigate-in-page', (e, url) => update({ url }));

  wc.on('did-fail-load', (e, code, desc, validatedURL) => {
    if (code === -3) return; // 用户主动中断
    pushToast(`加载失败（${desc}）：${validatedURL}`, 'error');
  });

  wc.on('render-process-gone', (e, details) => {
    pushToast('页面进程崩溃（' + (details && details.reason) + '），正在重载', 'error');
    wc.reload();
  });

  // 用户在网页上按下了鼠标 —— 通知界面把脚本面板收起来（常驻面板的唯一自动收起时机）
  wc.on('input-event', (e, input) => {
    if (!win || !isPageClick(input)) return;
    win.webContents.send('ui:page-clicked');
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();

    if (ctrl && key === 'l') {
      event.preventDefault();
      win.webContents.send('ui:focus-address');
    } else if (ctrl && key === 't') {
      event.preventDefault();
      createTab('scriptdock://start');
    } else if (ctrl && key === 'w') {
      event.preventDefault();
      closeTab(id);
    }
  });

  // ================================================================
  // 弹窗 / 新标签页（window.open、target="_blank"）
  //
  // 只拦 will-navigate 是不够的：论坛的附件链接大量用 target="_blank" 或
  // window.open 打开，那条路会直接开出一个新页面 —— 用户看到的就是
  // 「点一下附件，冒出个新标签页，还得再点一下」。
  //
  // 策略对齐安卓版搜书吧的 forwardPopupUrl：空弹窗吞掉、附件后台静默下载、
  // 其余才开新标签页。判定逻辑在 forum.js，接管骨架在 popupHandler.js。
  // ================================================================
  installPopupHandler(wc, {
    getAutoDownload: () => store.getSettings().autoDownloadAttachments !== false,
    isExternal: shouldOpenExternally,

    onBlock: () => pushToast('已拦截对本地文件的访问', 'error'),

    // about:blank / javascript: 这类空中转弹窗，放过就是一片空白页
    onSwallow: (url) => console.log(TAG + ' 吞掉空弹窗：' + url),

    // 附件 / txt / blob：截下来后台静默下载，页面原地不动
    onBackground: (url) => {
      console.log(TAG + ' 弹窗下载被截获，改为后台静默下载：' + url);
      handleAttachmentClick(wc, url);
    },

    // 页面明确要求「另存为」：不弹窗口也不弹保存框，直接落盘
    onDownload: (url) => {
      console.log(TAG + ' 弹窗要求另存为，静默下载：' + url);
      safeDownloadUrl(wc, url);
    },

    // 付费附件：得让论坛自己的购买页出来
    onPaid: (url) => createTab(url),

    onExternal: (url) => {
      shell.openExternal(url);
      pushToast('已用系统浏览器打开站外链接', 'info');
    },

    onTab: (url) => createTab(url)
  });

  wc.on('context-menu', (event, params) => openTabContextMenu(wc, params));

  wc.on('destroyed', () => {
    tabs.delete(id);
    tabMenus.delete(id);
    threadSubjects.delete(id);

    if (activeTabId === id) {
      const next = tabs.keys().next();
      if (!next.done) {
        setActiveTab(next.value);
      } else {
        activeTabId = null;
        broadcastTabs();
        createTab('scriptdock://start'); // 始终保留一个标签页
      }
    } else {
      broadcastTabs();
    }
  });
}

/** 把纯模板渲染成 Electron 菜单并弹出。空模板就不弹，免得出现一片空白菜单 */
function popupMenu(template, actions) {
  if (!template || !template.length) return;

  const built = template.map((it) => {
    if (it.id === 'sep') return { type: 'separator' };

    if (ROLE_ITEMS[it.id]) {
      const entry = { role: ROLE_ITEMS[it.id], label: it.label };
      // 只在明确要禁用时写 enabled；否则让 role 自己按焦点状态决定
      if (it.enabled === false) entry.enabled = false;
      return entry;
    }

    return {
      label: it.label,
      enabled: it.enabled !== false,
      click: () => {
        const fn = actions && actions[it.id];
        if (typeof fn === 'function') fn();
      }
    };
  });

  Menu.buildFromTemplate(built).popup({ window: win });
}

/** 网页里的右键 / 长按 */
function openTabContextMenu(wc, params) {
  const nh = wc.navigationHistory;
  const canGoBack = nh ? nh.canGoBack() : wc.canGoBack();
  const canGoForward = nh ? nh.canGoForward() : wc.canGoForward();

  popupMenu(
    buildContextMenu(params, { tabMode: true, canGoBack, canGoForward, devTools: true }),
    {
      openLinkInTab: () => createTab(params.linkURL),
      copyLink: () => clipboard.writeText(params.linkURL),
      searchSelection: () =>
        createTab('https://www.bing.com/search?q=' + encodeURIComponent(params.selectionText)),
      back: () => (nh ? nh.goBack() : wc.goBack()),
      forward: () => (nh ? nh.goForward() : wc.goForward()),
      reload: () => wc.reload(),
      openExternal: () => shell.openExternal(params.pageURL),
      copyPageUrl: () => clipboard.writeText(params.pageURL),
      toggleDevTools: () => toggleDevTools()
    }
  );
}

/**
 * 界面自己的右键 / 长按（脚本编辑器、地址栏、输入框…）。
 *
 * 这里之前**什么都没挂** —— 而 Electron 没有默认右键菜单，结果在输入框里
 * 右键 / 长按一片安静，想粘贴连入口都找不到。触摸设备上「长按粘贴」就是这么没的。
 */
function openUiContextMenu(params) {
  popupMenu(buildContextMenu(params, { tabMode: false }), {});
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.view.webContents.close();
}

function setActiveTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;
  applyBounds();
  broadcastTabs();
}

function applyBounds() {
  if (!win) return;

  for (const [tabId, tab] of tabs) {
    const isActive = tabId === activeTabId;
    try {
      tab.view.setVisible(isActive && contentVisible);
      if (isActive) tab.view.setBounds(contentBounds);
    } catch (e) {
      /* ignore */
    }
  }
}

function broadcastTabs() {
  if (!win) return;
  win.webContents.send('tabs:state', {
    activeId: activeTabId,
    tabs: Array.from(tabs.values()).map((t) => ({
      id: t.id,
      title: t.title || '新标签页',
      url: t.url || '',
      loading: !!t.loading
    }))
  });
  broadcastMenus();
}

/** 把当前标签页注册的 GM 菜单命令推给界面 */
function broadcastMenus() {
  if (!win) return;
  const bag = tabMenus.get(activeTabId);
  win.webContents.send('menus:state', {
    tabId: activeTabId,
    commands: bag ? Array.from(bag.values()) : []
  });
}

/**
 * 把论坛自己的错误提示（#messagetext 之类）转达给用户。
 * 以前这类消息只在网页里一闪而过，用户只会说「提示无法下载附件」，
 * 而我不知道到底是论坛拒绝、还是软件出错 —— 现在两边的信息都能看到。
 */
function reportForumMessage(wc) {
  wc.executeJavaScript(
    '(function(){' +
      'var e=document.getElementById("messagetext")||document.querySelector(".alert_error,.alert_info,.alert_warning");' +
      'if(!e) return "";' +
      'return (e.textContent||"").replace(/\s+/g," ").trim().slice(0,140);' +
      '})()',
    true
  )
    .then((text) => {
      if (!text) return;
      if (!/附件|下载|银币|金币|权限|登录|回复|失效|不存在/.test(text)) return;
      console.log( '论坛页面提示：' + text);
      pushToast('论坛提示：' + text, 'error');
    })
    .catch(() => {});
}

/** 点菜单命令时，回到页面主世界调用脚本注册的回调 */
function invokeMenuCommand(tabId, menuId) {
  const tab = tabs.get(tabId);
  if (!tab || tab.view.webContents.isDestroyed()) return Promise.resolve(false);
  return tab.view.webContents.executeJavaScript(buildMenuInvokeSource(menuId), true).catch(() => false);
}

function pushToast(message, kind) {
  if (!win) return;
  win.webContents.send('ui:toast', { message, kind: kind || 'info' });
}

/**
 * 把下载进度推给界面（底部状态栏那条进度条）。
 *
 * 必须节流：一个 70MB 的文件会有上千次回调，每次都发 IPC 太浪费。
 * 规则：距上次 ≥120ms，或者百分比变了，才发。
 * 结束/失败的时候 force=true，保证最后一帧一定送出去。
 */
let dlProgressAt = 0;
let dlProgressPct = -1;

function reportDownloadProgress(payload, force) {
  if (!win) return;

  const total = Number(payload && payload.total) || 0;
  const received = Number(payload && payload.received) || 0;
  const pct = total > 0 ? Math.floor((received / total) * 100) : -1;
  const now = Date.now();

  if (!force && now - dlProgressAt < 120 && pct === dlProgressPct) return;
  dlProgressAt = now;
  dlProgressPct = pct;

  try {
    win.webContents.send('download:progress', {
      name: String((payload && payload.name) || ''),
      received,
      total,
      state: (payload && payload.state) || 'progressing',
      at: now
    });
  } catch (e) {
    /* 界面还没起来就算了，进度不是关键路径 */
  }
}

/** 有新文件落盘：让界面刷新下载计数 */
function notifyDownloadDone() {
  if (win) win.webContents.send('download:done', { at: Date.now() });
}

/**
 * 刷新当前正在看的那张网页，让脚本开关的改动立刻生效。
 * 起始页（scriptdock://start）不在这里刷 —— notifyScriptsChanged 会处理它。
 */
function reloadActiveWebPage() {
  try {
    const wc = activeWebContents();
    if (!wc) return;
    if (!/^https?:/i.test(String(wc.getURL() || ''))) return;
    wc.reload();
  } catch (e) {
    /* 刷新失败不影响开关本身 */
  }
}

/**
 * 脚本列表有变动时统一走这里：
 * 通知界面刷新，并让「起始页」跟着更新（它是服务端渲染的静态页面，不刷新会显示旧数字）。
 */
function notifyScriptsChanged() {
  if (!win) return;
  win.webContents.send('scripts:changed', store.list());

  try {
    const wc = activeWebContents();
    const url = wc ? String(wc.getURL() || '') : '';
    if (url.indexOf('scriptdock://start') === 0) {
      wc.reload();
    }
  } catch (e) {
    /* 起始页刷新失败不影响其他逻辑 */
  }
}

function toggleDevTools() {
  const wc = activeWebContents();
  if (!wc) return false;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'bottom' });
  return true;
}

// ==================================================================
// 脚本目录监听（直接往目录丢文件也能被感知）
// ==================================================================

let dirWatchers = [];
let watchTimer = null;

/** 内部目录 + 全部外部目录都要监视 */
function restartWatchers() {
  stopWatchers();

  const seen = new Set();
  for (const { dir, source } of store.allDirs()) {
    // 内置脚本在 asar 包里，既不落盘也不该被监视
    if (source === 'builtin') continue;
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      dirWatchers.push(fs.watch(dir, { persistent: false }, scheduleWatchCheck));
    } catch (e) {
      console.error(TAG + ' ' + '无法监听目录 ' + dir, e);
    }
  }
}

function stopWatchers() {
  for (const w of dirWatchers) {
    try {
      w.close();
    } catch (e) {
      /* ignore */
    }
  }
  dirWatchers = [];
}

function scriptSignature() {
  return store
    .list()
    .map((s) => s.id + ':' + s.updatedAt + ':' + s.enabled)
    .join('|');
}

function scheduleWatchCheck() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const before = scriptSignature();
    store.reload();
    if (before !== scriptSignature()) {
      notifyScriptsChanged();
      pushToast('脚本目录有变化，已重新加载', 'info');
      // 新增的脚本可能带 @require，顺手把缺的依赖拉下来
      store.ensureExternalDeps().catch(() => {});
    }
  }, 350);
}

// ==================================================================
// IPC
// ==================================================================

function registerIpc() {
  ipcMain.handle('app:logPath', () => logger.getLogFile());

  ipcMain.handle('app:openLog', async () => {
    const file = logger.getLogFile();
    if (!file) return { ok: false, error: '日志不可用' };
    const errMsg = await shell.openPath(file);
    return { ok: !errMsg, error: errMsg };
  });

  ipcMain.handle('app:info', () => ({
    version: VERSION,
    codename: CODENAME,
    scriptsDir: store.scriptsDirectory(),
    cacheDir: store.cacheDirectory(),
    externalDirs: store.externalDirs(),
    settings: store.getSettings(),
    compat: {
      mode: compatMode,
      enabled: compatEnabled,
      history: compatHistory,
      remoteSession: /^RDP/i.test(process.env.SESSIONNAME || '')
    },
    dispatchLog: dispatchLog.slice(-30)
  }));

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (e, patch) => {
    const next = store.setSettings(patch);
    if (win) win.webContents.send('settings:changed', next);
    return next;
  });

  // 兼容模式切换：立即写入设置，重启后生效
  ipcMain.handle('compat:set', (e, mode) => {
    const next = mode === true ? true : mode === false ? false : null;
    store.setSettings({ compatMode: next });
    return {
      mode: compatMode,
      enabled: compatEnabled,
      requested: next,
      needRestart: true
    };
  });

  // ---------------------------------------------------------------
  // 论坛地址
  // ---------------------------------------------------------------

  ipcMain.handle('forum:get', () => {
    const s = store.getSettings();
    return {
      url: s.forumUrl || '',
      effective: effectiveForumUrl(),
      origin: s.forumUrl ? originOf(s.forumUrl) : '',
      defaultEntry: DEFAULT_ENTRY,
      openOnStart: s.openForumOnStart !== false,
      externalLinks: s.externalLinksToSystem !== false,
      autoDownload: s.autoDownloadAttachments !== false,
      userAgent: DESKTOP_UA,
      compat: { mode: compatMode, enabled: compatEnabled }
    };
  });

  ipcMain.handle('forum:set', (e, rawUrl, options) => {
    const opts = options || {};
    // 允许清空（清空后回落到内置入口）
    const url = rawUrl ? normalizeUrl(rawUrl) : '';

    const patch = { forumUrl: url };
    if (typeof opts.openOnStart === 'boolean') patch.openForumOnStart = opts.openOnStart;
    if (typeof opts.externalLinks === 'boolean') patch.externalLinksToSystem = opts.externalLinks;
    if (typeof opts.autoDownload === 'boolean') patch.autoDownloadAttachments = opts.autoDownload;
    store.setSettings(patch);

    if (win) win.webContents.send('settings:changed', store.getSettings());

    if (opts.navigate !== false) goForum();

    return { ok: true, url: store.getSettings().forumUrl, effective: effectiveForumUrl() };
  });

  ipcMain.handle('forum:open', () => ({ ok: true, url: goForum() }));

  ipcMain.handle('scripts:list', () => store.list());
  ipcMain.handle('scripts:listBuiltin', () => store.builtinList());

  // ---------------------------------------------------------------
  // 浏览历史
  // ---------------------------------------------------------------

  ipcMain.handle('history:list', (e, keyword) => {
    if (!history) return { items: [], total: 0 };
    return { items: history.list(keyword), total: history.count() };
  });

  ipcMain.handle('history:remove', (e, url) => {
    if (!history) return { ok: false };
    const res = history.remove(url);
    if (win) win.webContents.send('history:changed', { count: history.count() });
    return res;
  });

  ipcMain.handle('history:clear', () => {
    if (!history) return { ok: false };
    const res = history.clear();
    if (win) win.webContents.send('history:changed', { count: history.count() });
    return res;
  });

  ipcMain.handle('scripts:reload', () => {
    store.reload();
    return store.list();
  });

  ipcMain.handle('scripts:save', (e, data) => {
    const saved = store.save(data);
    notifyScriptsChanged();

    // 保存后刷新当前页，让改动立刻可见
    if (store.getSettings().autoReloadOnSave !== false) {
      const wc = activeWebContents();
      if (wc) wc.reload();
    }
    return saved;
  });

  ipcMain.handle('scripts:delete', (e, id) => {
    const res = store.remove(id);
    notifyScriptsChanged();
    return res;
  });

  ipcMain.handle('scripts:setEnabled', (e, id, enabled) => {
    const res = store.setEnabled(id, enabled);
    notifyScriptsChanged();

    // 开/关脚本后直接刷新当前网页：不然要手动点刷新才看得到效果
    if (res && res.ok) reloadActiveWebPage();
    return res;
  });

  ipcMain.handle('scripts:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择要导入的脚本',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '脚本文件（js / txt）', extensions: ['js', 'txt'] },
        { name: '油猴脚本', extensions: ['js'] },
        { name: '文本脚本', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const result = store.importPaths(res.filePaths);
    notifyScriptsChanged();
    return result;
  });

  ipcMain.handle('scripts:importFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择脚本文件夹',
      buttonLabel: '导入整个文件夹',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const result = store.importPaths(res.filePaths);
    notifyScriptsChanged();
    return result;
  });

  ipcMain.handle('scripts:importPaths', (e, paths) => {
    const result = store.importPaths(paths || []);
    notifyScriptsChanged();
    return result;
  });

  ipcMain.handle('scripts:openDir', () => shell.openPath(store.scriptsDirectory()));

  ipcMain.handle('scripts:matchUrl', (e, url) => {
    const u = String(url || '');
    if (!u) return [];
    return store
      .enabled()
      .filter((s) => sdMatchUrl(u, s))
      .map((s) => s.id);
  });

  ipcMain.handle('scripts:test', (e, url, script) => {
    try {
      return { ok: true, matched: sdMatchUrl(String(url || ''), script || {}) };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  });

  // ---------------------------------------------------------------
  // GM API 通道（页面侧通过 __scriptdock_bridge__ 调到这里）
  // 实现在 gmApi.js 里，自检复用同一份
  // ---------------------------------------------------------------

  registerGmApi({
    ipcMain,
    resolveDownloadDir: downloadDir,
    uniqueTarget,
    pushToast,
    registerMenu: (wcId, cmd) => {
      const id = 'm' + ++menuSeq;
      if (!tabMenus.has(wcId)) tabMenus.set(wcId, new Map());
      tabMenus.get(wcId).set(id, Object.assign({ id }, cmd));
      broadcastMenus();
      return id;
    },
    unregisterMenu: (wcId, id) => {
      const bag = tabMenus.get(wcId);
      if (bag && bag.has(id)) {
        bag.delete(id);
        broadcastMenus();
      }
    },
    invokeMenu: (tabId, menuId) => invokeMenuCommand(tabId, menuId),
    listMenus: () => {
      const bag = tabMenus.get(activeTabId);
      return bag ? Array.from(bag.values()) : [];
    }
  });

  /** 下载目录：查询 / 更改 / 恢复默认（「打开」由 gmApi 提供） */
  ipcMain.handle('download:info', () => {
    const dir = downloadDir();
    let count = 0;
    try {
      count = fs.readdirSync(dir).filter((f) => {
        try {
          return fs.statSync(path.join(dir, f)).isFile();
        } catch (e) {
          return false;
        }
      }).length;
    } catch (e) {
      count = 0;
    }
    return {
      dir,
      count,
      custom: store.getSettings().downloadDir || '',
      defaultDir: path.join(appFolder(), 'Download'),
      portable: !!process.env.PORTABLE_EXECUTABLE_DIR
    };
  });

  ipcMain.handle('download:choose', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择下载保存目录',
      buttonLabel: '用这个目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    store.setSettings({ downloadDir: res.filePaths[0] });
    return { ok: true, dir: res.filePaths[0] };
  });

  ipcMain.handle('download:reset', () => {
    store.setSettings({ downloadDir: null });
    return { ok: true, dir: downloadDir() };
  });

  /** 列出下载目录里的文件（应用内下载列表用），按时间倒序 */
  ipcMain.handle('download:list', () => {
    const dir = downloadDir();
    let files = [];

    try {
      files = fs
        .readdirSync(dir)
        .map((name) => {
          const full = path.join(dir, name);
          try {
            const st = fs.statSync(full);
            if (!st.isFile()) return null;
            return { name, path: full, size: st.size, mtime: st.mtimeMs };
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) {
      files = [];
    }

    return { dir, files };
  });

  /** 用系统默认程序打开某个下载文件 */
  ipcMain.handle('download:openFile', async (e, filePath) => {
    const dir = path.resolve(downloadDir());
    const target = path.resolve(String(filePath || ''));

    // 只允许打开下载目录里的文件：渲染进程万一被诱导也不能拿它当任意文件执行器
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      return { ok: false, error: '这个文件不在下载目录里' };
    }

    try {
      if (!fs.existsSync(target)) return { ok: false, error: '文件已经不在了（可能被移动或删除）' };
    } catch (err) {
      return { ok: false, error: '无法访问该文件' };
    }

    const errMsg = await shell.openPath(target);
    return { ok: !errMsg, error: errMsg };
  });

  /** 在资源管理器里定位到该文件 */
  ipcMain.handle('download:reveal', (e, filePath) => {
    const target = path.resolve(String(filePath || ''));
    try {
      if (fs.existsSync(target)) shell.showItemInFolder(target);
      else shell.openPath(downloadDir());
    } catch (err) {
      /* 打不开就算了 */
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------
  // 外部脚本目录
  // ---------------------------------------------------------------

  ipcMain.handle('dirs:list', () => ({
    dirs: store.externalDirs(),
    scriptsDir: store.scriptsDirectory(),
    cacheDir: store.cacheDirectory()
  }));

  ipcMain.handle('dirs:add', async (e, presetPath) => {
    let target = presetPath;

    if (!target) {
      const res = await dialog.showOpenDialog(win, {
        title: '选择要监视的脚本文件夹',
        buttonLabel: '加入监视',
        properties: ['openDirectory']
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true };
      target = res.filePaths[0];
    }

    const result = store.addExternalDir(target);
    restartWatchers();
    notifyScriptsChanged();
    store.ensureExternalDeps().catch(() => {});
    return result;
  });

  ipcMain.handle('dirs:remove', (e, dir) => {
    const result = store.removeExternalDir(dir);
    restartWatchers();
    notifyScriptsChanged();
    return result;
  });

  ipcMain.handle('dirs:open', (e, dir) => shell.openPath(dir || store.scriptsDirectory()));

  ipcMain.handle('deps:refresh', async () => {
    const result = await store.ensureExternalDeps();
    notifyScriptsChanged();
    return result;
  });

  /**
   * 清空缓存：网页资源 + 代码缓存 + 脚本依赖缓存。
   * 故意**不清** Cookie（清了会被登出）、localStorage、历史记录、脚本、已下载的文件。
   */
  ipcMain.handle('app:clearCache', async () => {
    // session.defaultSession 要等 app ready 才能拿，所以就地创建
    const cacheCleaner = createCacheCleaner({
      session: session.defaultSession,
      clearDepCache: () => store.clearDepCache(),
      log: (msg) => console.log(TAG + ' ' + msg)
    });
    const result = await cacheCleaner.clear();
    notifyScriptsChanged();
    // 缓存空了，顺手把当前页重新拉一遍，用户立刻能看到效果
    reloadActiveWebPage();
    return result;
  });

  ipcMain.handle('deps:clear', () => {
    const result = store.clearDepCache();
    notifyScriptsChanged();
    return result;
  });

  // --- 标签页 ---
  ipcMain.handle('tabs:new', (e, url) => createTab(url || 'scriptdock://start'));
  ipcMain.handle('tabs:close', (e, id) => {
    closeTab(id);
    return true;
  });
  ipcMain.handle('tabs:activate', (e, id) => {
    setActiveTab(id);
    return true;
  });

  ipcMain.handle('tabs:navigate', (e, id, url) => {
    const tab = tabs.get(id || activeTabId);
    if (!tab) return false;
    tab.view.webContents.loadURL(url).catch(() => {});
    return true;
  });

  ipcMain.handle('tabs:action', (e, action) => {
    const wc = activeWebContents();
    if (!wc) return false;
    const nh = wc.navigationHistory;

    if (action === 'back') {
      if (nh ? nh.canGoBack() : wc.canGoBack()) nh ? nh.goBack() : wc.goBack();
    } else if (action === 'forward') {
      if (nh ? nh.canGoForward() : wc.canGoForward()) nh ? nh.goForward() : wc.goForward();
    } else if (action === 'reload') {
      wc.reload();
    } else if (action === 'stop') {
      wc.stop();
    } else if (action === 'home') {
      goForum();
    } else if (action === 'start') {
      wc.loadURL('scriptdock://start').catch(() => {});
    }
    return true;
  });

  ipcMain.handle('tabs:devtools', () => toggleDevTools());

  ipcMain.handle('view:setBounds', (e, rect) => {
    if (!rect) return false;
    contentBounds = {
      x: Math.round(rect.x || 0),
      y: Math.round(rect.y || 0),
      width: Math.max(0, Math.round(rect.width || 0)),
      height: Math.max(0, Math.round(rect.height || 0))
    };
    applyBounds();
    return true;
  });

  ipcMain.handle('view:setVisible', (e, visible) => {
    contentVisible = !!visible;
    applyBounds();
    return true;
  });

  ipcMain.handle('shell:openExternal', (e, url) => shell.openExternal(url));

}

// ==================================================================
// 附件下载
//
// 用户脚本（免银币那类）会把附件链接改造成伪造签名的
// `?mod=attachment&aid=<base64>`，点下去本来会带着帖子页一起导航走 ——
// 先跳到 Discuz 的「原附件链接已失效」提示页，再点「重新下载」才拿到文件。
//
// 这里把这次导航截下来，在后台把整个链路走完（跟随提示页里的真实链接），
// 文件直接落到 Download 目录，帖子页原地不动；下载完再刷新一次页面，
// 把「回复可见」的内容解锁出来。等价于 App 里的「点击自动下载并刷新」。
// ==================================================================

/** 取该地址对应的 Cookie，让后台请求保持登录态 */
async function cookiesFor(url) {
  try {
    const list = await session.defaultSession.cookies.get({ url });
    return list.map((c) => c.name + '=' + c.value).join('; ');
  } catch (e) {
    return '';
  }
}

/**
 * 包一层 HTTP：附件下载的每一跳都记进日志。
 * 出问题时（403 / 拿到 HTML 而不是文件 / 找不到下载链接）能直接从日志看出卡在哪。
 */
async function loggedRequest(options) {
  const res = await http.request(options);
  const h = res.responseHeaders || {};
  console.log(
    `  附件请求 ${options.method || 'GET'} ${options.url}\n` +
      `    ← ${res.status} type=${h['content-type'] || '(无)'} ` +
      `disp=${h['content-disposition'] || '(无)'} bytes=${res.bytes} ` +
      `cookie=${((options.headers && options.headers.Cookie) || '').length}字`
  );
  return res;
}

/** 附件下载器：链路实现在 attachment.js，这里只注入依赖 */
const attachmentDownloader = createAttachmentDownloader({
  request: loggedRequest,
  cookiesFor,
  downloadDir: () => downloadDir(),
  uniqueTarget,
  decideFilename: (opts) => {
    const info = decideFilename(Object.assign({}, opts, { trace: true }));
    const sources = info.sources.map((s) => s.kind + ':' + s.from + '→' + s.to);
    console.log(
      TAG + ' 文件名决策 | 来源=' + info.picked + ' | 结果=' + info.name + ' | 候选=' + JSON.stringify(sources)
    );
    return info.name;
  },
  isFileResponse,
  findRetryDownloadLink,
  userAgent: DESKTOP_UA,
  onHop: (n, next) => console.log(TAG + ' 附件链路第 ' + n + ' 跳 → ' + next),

  // 判定「不是文件」时把服务器回了什么记下来 —— 下载失败基本都能从这里看出来
  onReject: (info) => {
    const h = info.headers || {};
    const body = String(info.body || '').replace(/\s+/g, ' ').slice(0, 220);
    console.log(
      TAG + ' 附件被判定不是文件 | 地址=' + info.url + ' | 状态=' + info.status +
        ' | content-type=' + (h['content-type'] || '(无)') +
        ' | content-disposition=' + (h['content-disposition'] || '(无)') +
        ' | 正文开头=' + body
    );
  }
});

function fetchAttachment(url, referer, threadSubject) {
  // 进度条上的名字先用帖子标题顶着 —— 真实文件名要靠正文的魔数/编码才定得下来，
  // 得等整个文件读完，没法提前知道（定下来之后会再报一次最终名字）
  const label = String(threadSubject || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '正在下载附件';

  return attachmentDownloader.download(url, {
    referer,
    threadSubject,
    onProgress: (received, total) =>
      reportDownloadProgress({ name: label, received, total, state: 'progressing' })
  });
}

/** 截到附件导航后走这里：后台下载 + 刷新解锁 */
/**
 * 让 Chromium 自己去下载这个地址：不开窗口、也不弹保存框。
 * 落盘路径由 will-download 里的 setSavePath 决定（那里还会顺手修文件名）。
 */
function safeDownloadUrl(wc, url) {
  try {
    const target = wc && !wc.isDestroyed() ? wc : activeWebContents();
    if (!target) return false;
    target.downloadURL(url);
    return true;
  } catch (e) {
    console.error(TAG + ' 触发下载失败：' + ((e && e.message) || e));
    pushToast('无法下载该文件', 'error');
    return false;
  }
}

async function handleAttachmentClick(wc, url) {
  const referer = wc.isDestroyed() ? url : wc.getURL();
  const subject = threadSubjects.get(wc.id) || '';

  pushToast('正在下载附件…', 'info');
  console.log(TAG + ' 开始下载附件 | 地址=' + url + ' | Referer=' + referer);

  let result;
  try {
    result = await fetchAttachment(url, referer, subject);
  } catch (e) {
    result = { ok: false, reason: String((e && e.message) || e) };
    console.error(TAG + ' ' + '附件下载异常：' + ((e && e.stack) || e));
  }

  if (!result.ok) {
    console.error(TAG + ' ' + `附件下载失败：${result.reason} | 起始地址=${url} | Referer=${referer}`);
    reportDownloadProgress({ name: '', state: 'fail' }, true);
    pushToast('附件下载失败：' + result.reason, 'error');
    return;
  }

  // 这时才知道最终文件名，用它把进度条收尾
  reportDownloadProgress({ name: result.name, received: 1, total: 1, state: 'done' }, true);
  pushToast('已下载到 Download：' + result.name, 'ok');
  notifyDownloadDone();

  // 下载完刷新帖子页：回复可见的内容这时通常已经解锁
  if (store.getSettings().refreshAfterDownload !== false && !wc.isDestroyed()) {
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.reload();
    }, 600);
  }
}

// ==================================================================
// 安全加固
// ==================================================================

/**
 * 证书错误只对名单内域名放行。
 * 那几个域名历史上证书链有问题，但除此之外的错误一律按失败处理，
 * 不能因为「想少点麻烦」就把整个证书校验关掉。
 */
function setupSecurity() {
  app.on('certificate-error', (event, wc, url, error, certificate, callback) => {
    let host = '';
    try {
      host = new URL(url).host;
    } catch (e) {
      host = '';
    }

    if (host && hostMatchesMarkers(host)) {
      console.warn(TAG, '放行证书错误（名单内域名）：' + host + ' ' + error);
      event.preventDefault();
      callback(true);
      return;
    }

    console.error(TAG + ' ' + '拒绝证书错误：' + host + ' ' + error);
    callback(false);
  });
}

/**
 * 换掉 Electron 默认 UA。
 * 默认 UA 里带 "Electron/33"，不少站点会据此判定「不支持的浏览器」并改行为。
 */
function setupUserAgent() {
  try {
    session.defaultSession.setUserAgent(DESKTOP_UA);
  } catch (e) {
    console.error(TAG + ' ' + '设置 UA 失败', e);
  }
}

// ==================================================================
// 启动
// ==================================================================

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {

    store.init();
    history = createHistoryStore(path.join(app.getPath('userData'), 'history.json'));

    // 依赖下载完成后自动刷新注入与界面
    store.onChange(() => notifyScriptsChanged());

    registerDispatcherChannel({
      ipcMain,
      getScripts: () => store.injectionPayload(),
      onDispatch: (url, names) => {
        if (!names.length) return;
        dispatchLog.push({ at: Date.now(), url, names });
        if (dispatchLog.length > 200) dispatchLog.shift();
      }
    });

    // 协议必须先注册（起始页要用），其余注册挪到 createWindow 之后 ——
    // 窗口越早开始加载，用户越早看到东西；这些同步注册只要赶在渲染进程
    // 发出第一个 IPC 之前完成就行（它冷启动要几百毫秒，绰绰有余）。
    handleStartProtocol();
    createWindow();

    registerIpc();
    setupUserAgent();
    setupSecurity();
    setupDownloadInterceptor();
    restartWatchers();

    const settings = store.getSettings();
    const dirs = store.allDirs();
    const userScripts = store.list().filter((s) => s.source !== 'builtin');
    console.log(
      `${TAG} v${VERSION} 已启动 | ` +
        `用户脚本 ${userScripts.length} 个（启用 ${userScripts.filter((s) => s.enabled).length} 个）| ` +
        `内置脚本 ${store.builtinList().length} 个（其中 ${store.sidebarBuiltins().length} 个在左侧列表）| ` +
        `兼容模式：${compatEnabled ? '开' : '关'}（${compatMode}）`
    );
    console.log(
      `${TAG} 论坛地址：${settings.forumUrl || '（未设置，用内置入口 ' + DEFAULT_ENTRY + '）'}`
    );
    console.log(`${TAG} 脚本目录：${store.scriptsDirectory()}`);
    console.log(`${TAG} 下载目录：${downloadDir()}`);
    for (const { dir, source } of dirs) {
      if (source === 'external') console.log(`${TAG} 外部目录：${dir}`);
    }

    // 把外部脚本缺的 @require / @resource 拉下来
    store.ensureExternalDeps().catch((e) => console.error(TAG + ' ' + '依赖下载失败', e));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopWatchers();
    app.quit();
  });
}
