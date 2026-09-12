'use strict';

/**
 * 真机冒烟：把**真的主进程**（src/main/main.js）跑起来，用 DevTools 协议
 * 从外面看界面状态。界面逻辑由 test/uismoke.js 覆盖，这个补上主进程那一半 ——
 * 尤其是「开机后脚本面板要一直常驻，别自己收走」——
 * 收起现在只由 input-event（用户真的按下鼠标）触发。
 *
 *   node test/appsmoke.js
 *
 * 用的是临时 userData，不会碰你真实的脚本和设置。
 *
 * 关于 --disable-gpu：这台机器（以及 CI）没有可用 GPU，Chromium 的 GPU 进程
 * 会反复崩，最后 FATAL 把整个应用带走。纯粹是测试环境的事，跟应用无关。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 9333;
const electronBin = require('electron');
const root = path.join(__dirname, '..');
const userData = path.join(os.tmpdir(), 'scriptdock-appsmoke-' + Date.now());

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

async function listTargets() {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    return await res.json();
  } catch (e) {
    return null;
  }
}

/** 连上一个 target 的 DevTools，执行表达式并取回结果 */
function evalOnce(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error('DevTools 超时'));
    }, timeoutMs || 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('DevTools 连接失败'));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      const r = msg.result;
      if (r && r.exceptionDetails) return reject(new Error(r.exceptionDetails.text || '页面里报错'));
      resolve(r && r.result ? r.result.value : undefined);
    };
  });
}

async function evalIn(wsUrl, expression, timeoutMs) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try {
      return await evalOnce(wsUrl, expression, timeoutMs);
    } catch (e) {
      last = e;
      await sleep(600);
    }
  }
  throw last;
}

function sendCmd(wsUrl, method, params) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(false); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
    ws.onmessage = () => { clearTimeout(timer); try { ws.close(); } catch (e) {} resolve(true); };
  });
}

const COLLAPSED = `document.querySelector('.app').classList.contains('sidebar-collapsed')`;

/** 每次都重新取一次界面窗口的 debugger 地址（刷新/重建后会变） */
async function findUiTarget() {
  for (let i = 0; i < 8; i++) {
    const targets = (await listTargets()) || [];
    const ui = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
    if (ui && ui.webSocketDebuggerUrl) return ui.webSocketDebuggerUrl;
    await sleep(400);
  }
  return null;
}

/** 在界面窗口里执行一段表达式 */
async function ui(expression) {
  const url = await findUiTarget();
  if (!url) throw new Error('找不到界面窗口的 DevTools target');
  return evalIn(url, expression);
}

/** 反复求值直到为真（界面刚起来时 DOM 可能还没解析完） */
async function waitFor(expression, timeoutMs) {
  const until = Date.now() + (timeoutMs || 6000);
  let last;
  while (Date.now() < until) {
    try {
      last = await ui(expression);
      if (last) return last;
    } catch (e) {
      /* 还没就绪 */
    }
    await sleep(300);
  }
  return last;
}

async function main() {
  fs.mkdirSync(userData, { recursive: true });

  const child = spawn(
    electronBin,
    ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData, '--disable-gpu', '--disable-gpu-compositing', '--no-sandbox'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  const t0 = Date.now();
  const logs = [];
  const echoOut = !!process.env.SMOKE_ECHO;
  child.stdout.on('data', (d) => {
    logs.push(String(d));
    if (echoOut) String(d).split('\n').filter((x) => x.trim() && !/gpu_process/.test(x)).forEach((x) => console.log('   [' + at() + 's] ' + x));
  });
  child.stderr.on('data', (d) => {
    logs.push(String(d));
    if (echoOut) String(d).split('\n').filter((x) => x.trim() && !/gpu_process/.test(x)).forEach((x) => console.log('   [' + at() + 's] ' + x));
  });

  const at = () => ((Date.now() - t0) / 1000).toFixed(1);

  try {
    // 等界面窗口起来
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (await findUiTarget()) break;
    }
    if (!(await findUiTarget())) throw new Error('界面窗口一直没起来（没拿到 DevTools target）');

    console.log('\n== 主进程真机冒烟 ==');

    const hasBar = await waitFor(`!!document.getElementById('dlProgress')`);
    check('界面起来了，进度条节点在位', hasBar === true);

    const version = await ui(`document.getElementById('verText').textContent`);
    check('版本号已升到 v1.2.14', version === 'v1.2.14', '实际 ' + version);

    // ------------------------------------------------------------
    // 盯 20 秒：开机这段时间面板必须一直是展开的。
    // 以前是两个固定检查点（4s / 7s），但「发布页自动跳转」这条链路的耗时
    // 每次都不一样，抓点会漏 —— 改成全程盯着，一旦收起就记下时间。
    // ------------------------------------------------------------
    let collapsedAt = null;
    let lastState = null;
    const watchUntil = Date.now() + 20000;
    while (Date.now() < watchUntil) {
      let st = null;
      try {
        st = await ui(COLLAPSED);
      } catch (e) {
        /* 界面偶尔忙，跳过这一拍 */
      }
      if (st !== lastState) {
        console.log('  · [' + at() + 's] 面板收起=' + st);
        lastState = st;
      }
      if (st === true && collapsedAt === null) collapsedAt = at();
      await sleep(300);
    }

    check(
      '开机 20 秒全程面板都常驻（不再自己收起）',
      collapsedAt === null,
      collapsedAt ? '第 ' + collapsedAt + ' 秒自己收起来了' : ''
    );

    // 这几件事都会让网页视图自己把焦点拿回去，都不该把面板收走：
    // 发布页自动跳转（程序替用户点链接）、导航完成、切标签
    const page = ((await listTargets()) || []).find((t) => t.type === 'page' && !/index\.html/.test(t.url || ''));
    if (page && page.webSocketDebuggerUrl) {
      const pageHasFocus = await evalIn(page.webSocketDebuggerUrl, 'document.hasFocus()');
      console.log('  · 网页 hasFocus=' + pageHasFocus + '（URL ' + (page.url || '').slice(0, 50) + '）');
      // 网页此刻持有焦点（document.hasFocus() === true）而面板不收 —— 这正是不再
      // 拿 focus 当收起依据之后该有的样子
      check('网页持有焦点也没把面板收走（不再拿 focus 当依据）', (await ui(COLLAPSED)) === false);
    } else {
      check('找到网页视图', false, '没拿到页面 target');
    }

    // 主动收起 / 展开这两个入口还得能用
    await ui(`document.getElementById('btnFoldSidebar').click()`);
    await sleep(300);
    check('点收起按钮 → 收起', (await ui(COLLAPSED)) === true);

    await ui(`document.getElementById('railExpand').click()`);
    await sleep(300);
    check('点展开按钮 → 展开', (await ui(COLLAPSED)) === false);

    // 说明：这里没法用 CDP 合成一次「真的点击网页」——
    // CDP 的 Input.dispatchMouseEvent 绕过了浏览器进程的输入分发，收不到
    // WebContents 的 input-event。（主进程侧那条链路是在真机上用
    // webContents.sendInputEvent 单独验证过的：能收到 mouseDown。）
    // 渲染侧「收到 ui:page-clicked 就收起」由 test/uismoke.js 覆盖。

    const crashed = logs.join('').match(/Uncaught|TypeError|ReferenceError/);
    check('主进程/渲染层没有未捕获异常', !crashed, crashed ? crashed[0] : '');
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(600);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n真机冒烟自己崩了：' + e.message);
  process.exit(2);
});
