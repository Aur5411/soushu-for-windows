'use strict';

/**
 * 界面冒烟测试：不启动论坛，只把渲染层拉起来，验证这两次的改动。
 *
 *   npx electron test/uismoke.js
 *
 * 覆盖：
 *   A. 底部状态栏的下载进度（1.2.14 新增）
 *   B. 脚本面板开机常驻 + 只有「主动收起 / 点网页」才收起
 *
 * 这里跑的是真实的 index.html + style.css + app.js（真实 Chromium），
 * 主进程相关的 api 用 test/uismoke-preload.js 桩掉。
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

app.setPath('userData', path.join(os.tmpdir(), 'scriptdock-uismoke-' + Date.now()));
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    console.log('  \u2717 ' + name + (detail ? '   \u2192 ' + detail : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'uismoke-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(400);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ============================================================
  console.log('\n== A. 底部下载进度 ==');

  const domReady = await js(`!!document.getElementById('dlProgress')`);
  check('进度条节点存在', domReady);

  const hiddenAtStart = await js(`document.getElementById('dlProgress').hidden`);
  check('没下载时是藏着的', hiddenAtStart === true, 'hidden=' + hiddenAtStart);

  // ---- 正常进度 ----
  await js(`__emit('download:progress', { name: '斗破苍穹.txt', received: 1048576, total: 4194304, state: 'progressing' })`);
  await sleep(60);

  let snap = await js(`(() => {
    const box = document.getElementById('dlProgress');
    return {
      hidden: box.hidden,
      cls: box.className,
      pct: document.getElementById('dlProgressPct').textContent,
      width: document.getElementById('dlProgressFill').style.width,
      name: document.getElementById('dlProgressName').textContent
    };
  })()`);

  check('有进度时自动出现', snap.hidden === false);
  check('百分比算对（1MB / 4MB = 25%）', snap.pct === '25%', '实际 ' + snap.pct);
  check('进度条宽度跟着走', snap.width === '25%', '实际 ' + snap.width);
  check('显示文件名与字节数', /斗破苍穹\.txt/.test(snap.name) && /1\.0 MB/.test(snap.name), '实际 ' + snap.name);
  check('状态是普通进度（无 done/fail 类）', snap.cls === 'dl-progress', '实际 ' + snap.cls);

  // ---- 重复的同一帧不再写 DOM ----
  await js(`window.__writes = 0;
    const _fill = document.getElementById('dlProgressFill').style;
    Object.defineProperty(document.getElementById('dlProgressFill'), 'style', { get: () => new Proxy(_fill, {
      set(t, k, v) { if (k === 'width') window.__writes++; t[k] = v; return true; }
    }) });`);
  await js(`__emit('download:progress', { name: '斗破苍穹.txt', received: 1048576, total: 4194304, state: 'progressing' })`);
  await sleep(40);
  const writes = await js(`window.__writes`);
  check('百分比没变就不重复写 DOM', writes === 0, '写入 ' + writes + ' 次');

  // ---- 服务器没给 content-length ----
  await js(`__emit('download:progress', { name: '未知大小.rar', received: 524288, total: 0, state: 'progressing' })`);
  await sleep(40);
  snap = await js(`(() => {
    const bar = document.getElementById('dlProgressBar');
    return { ind: bar.classList.contains('indeterminate'),
             pct: document.getElementById('dlProgressPct').textContent };
  })()`);
  check('总长未知时走跑马灯', snap.ind === true);
  check('总长未知时显示已下载量', snap.pct === '512 KB', '实际 ' + snap.pct);

  // ---- 完成 ----
  await js(`__emit('download:progress', { name: '斗破苍穹.txt', received: 4194304, total: 4194304, state: 'done' })`);
  await sleep(40);
  snap = await js(`(() => {
    const box = document.getElementById('dlProgress');
    return { hidden: box.hidden, cls: box.className,
             pct: document.getElementById('dlProgressPct').textContent,
             width: document.getElementById('dlProgressFill').style.width };
  })()`);
  check('完成后标成完成', snap.pct === '完成' && snap.cls.indexOf('done') >= 0, JSON.stringify(snap));
  check('完成后进度条满格', snap.width === '100%');
  check('完成后还看得见（不是立刻消失）', snap.hidden === false);

  await sleep(2500);
  const goneAfterDone = await js(`document.getElementById('dlProgress').hidden`);
  check('完成后过一会儿自动隐去', goneAfterDone === true);

  // ---- 失败 ----
  await js(`__emit('download:progress', { name: '坏文件.zip', state: 'fail' })`);
  await sleep(40);
  snap = await js(`(() => {
    const box = document.getElementById('dlProgress');
    return { hidden: box.hidden, cls: box.className,
             pct: document.getElementById('dlProgressPct').textContent,
             name: document.getElementById('dlProgressName').textContent };
  })()`);
  check('失败时显示失败', snap.pct === '失败' && snap.cls.indexOf('fail') >= 0, JSON.stringify(snap));
  check('失败时带上文件名', snap.name === '坏文件.zip', '实际 ' + snap.name);

  // ---- 失败之后马上又开始新下载：不能被上一个的隐藏定时器带走 ----
  await js(`__emit('download:progress', { name: '新任务.txt', received: 100, total: 1000, state: 'progressing' })`);
  await sleep(120);
  snap = await js(`(() => {
    const box = document.getElementById('dlProgress');
    return { hidden: box.hidden, cls: box.className,
             pct: document.getElementById('dlProgressPct').textContent };
  })()`);
  check('新任务能顶掉上一个的收尾状态', snap.hidden === false && snap.cls === 'dl-progress' && snap.pct === '10%', JSON.stringify(snap));

  // ---- 取消 ----
  await js(`__emit('download:progress', { name: '新任务.txt', state: 'cancelled' })`);
  await sleep(40);
  const goneAfterCancel = await js(`document.getElementById('dlProgress').hidden`);
  check('取消后立刻隐去', goneAfterCancel === true);

  // ============================================================
  console.log('\n== B. 脚本面板：常驻 / 收起时机 ==');

  const collapsedAtBoot = await js(`document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  check('开机就是展开的（常驻）', collapsedAtBoot === false);

  const foldBtn = await js(`!!document.getElementById('btnFoldSidebar')`);
  check('收起按钮还在', foldBtn === true);

  // 主动收起
  await js(`document.getElementById('btnFoldSidebar').click()`);
  await sleep(60);
  const collapsedByBtn = await js(`document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  check('点收起按钮 → 收起', collapsedByBtn === true);

  // 鼠标划过不收起（以前 mouseleave 会收起）
  await js(`document.getElementById('sidebar').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
  await sleep(60);
  const expandedByHover = await js(`document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  check('鼠标移进侧栏 → 展开', expandedByHover === false);

  await js(`document.getElementById('sidebar').dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))`);
  await sleep(1200);
  const stillOpenAfterLeave = await js(`document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  check('鼠标离开 → 不收起（要常驻）', stillOpenAfterLeave === false);

  // 点网页才收起
  await js(`__emit('ui:page-clicked')`);
  await sleep(450);
  const collapsedByPage = await js(`document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  check('点网页 → 收起', collapsedByPage === true);

  // 固定展开之后，点网页也不收起
  await js(`document.getElementById('railPin').click()`);
  await sleep(120);
  const pinnedIcon = await js(`document.getElementById('railPin').textContent`);
  check('固定展开后按钮变成 ⇤', pinnedIcon === '\u21e4', '实际 ' + JSON.stringify(pinnedIcon));
  const expandedAfterPin = await js(`document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  check('固定展开后立刻展开', expandedAfterPin === false);

  await js(`__emit('ui:page-clicked')`);
  await sleep(450);
  const afterPinPageFocus = await js(`document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  check('固定展开后点网页也不收起', afterPinPageFocus === false);

  // 恢复
  await js(`document.getElementById('railPin').click()`);
  await sleep(120);
  const backIcon = await js(`document.getElementById('railPin').textContent`);
  check('再点一下恢复，按钮变回 ⇥', backIcon === '\u21e5', '实际 ' + JSON.stringify(backIcon));

  // ============================================================
  console.log('');
  const realErrors = errors.filter((m) => !/Autofill|DevTools/.test(m));
  check('渲染层没有报错', realErrors.length === 0, realErrors.join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  app.exit(fail === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('冒烟测试自己崩了：', e);
    app.exit(2);
  })
);
