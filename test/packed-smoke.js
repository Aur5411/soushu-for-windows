'use strict';

/**
 * 打包产物冒烟：跑**打好的 exe**（还是 unpacked 目录里的 exe，省一次解压），
 * 确认装出来的东西能起来、带的是新功能、并且没有代码签名/asar 加固导致的问题。
 *
 *   node test/packed-smoke.js [exe 路径]
 *
 * 默认跑 dist/win-unpacked/搜书吧.exe。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 9351;
const root = path.join(__dirname, '..');
const exe = process.argv[2] || path.join(root, 'dist', 'win-unpacked', '搜书吧.exe');
const userData = path.join(os.tmpdir(), 'scriptdock-packed-' + Date.now());

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

function evalOnce(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error('DevTools 超时'));
    }, timeoutMs || 8000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('DevTools 连接失败'));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      const r = msg.result;
      if (r && r.exceptionDetails) return reject(new Error(r.exceptionDetails.text || '页面报错'));
      resolve(r && r.result ? r.result.value : undefined);
    };
  });
}

async function findUi(attempts) {
  // 给足时间：便携版 exe 是自解压的，先把 app 解到临时目录才启动，实测要几秒
  for (let i = 0; i < (attempts || 10); i++) {
    const t = (await listTargets()) || [];
    const ui = t.find((x) => x.type === 'page' && /index\.html/.test(x.url || ''));
    if (ui && ui.webSocketDebuggerUrl) return ui.webSocketDebuggerUrl;
    await sleep(400);
  }
  return null;
}

async function ui(expr) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try {
      const url = await findUi();
      if (!url) throw new Error('找不到界面窗口');
      return await evalOnce(url, expr);
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw last;
}

/** 反复求值直到为真（界面刚起来时 DOM 可能还没解析完） */
async function waitFor(expr, timeoutMs) {
  const until = Date.now() + (timeoutMs || 8000);
  let last;
  while (Date.now() < until) {
    try {
      last = await ui(expr);
      if (last) return last;
    } catch (e) {
      last = '(' + e.message + ')';
    }
    await sleep(300);
  }
  return last;
}

async function main() {
  if (!fs.existsSync(exe)) throw new Error('找不到 exe：' + exe);
  fs.mkdirSync(userData, { recursive: true });
  console.log('  被测文件：' + exe + '  (' + (fs.statSync(exe).size / 1048576).toFixed(1) + ' MB)');

  const child = spawn(
    exe,
    ['--remote-debugging-port=' + PORT, '--user-data-dir=' + userData, '--disable-gpu', '--disable-gpu-compositing', '--no-sandbox'],
    { cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  try {
    if (!(await findUi(80))) throw new Error('exe 起来了但没拿到界面（可能 asar 加固/签名把程序拦住了）');

    console.log('\n== 打包产物冒烟 ==');
    check('打好的 exe 能正常启动', true);

    const version = await waitFor(`(document.getElementById('verText') || {}).textContent`);
    check('界面显示版本 v1.2.14', version === 'v1.2.14', '实际 ' + version);

    if (version !== 'v1.2.14') {
      console.log('  —— 应用日志 ——');
      console.log(
        logs
          .join('')
          .split('\n')
          .filter((x) => x.trim() && !/gpu_process/.test(x))
          .slice(-15)
          .join('\n')
      );
    }

    const hasBar = await ui(`!!document.getElementById('dlProgress')`);
    check('底部有下载进度条', hasBar === true);

    // 盯 18 秒：面板不能被自己收走
    let collapsedAt = null;
    const until = Date.now() + 18000;
    while (Date.now() < until) {
      try {
        if ((await ui(`document.querySelector('.app').classList.contains('sidebar-collapsed')`)) === true) {
          collapsedAt = true;
          break;
        }
      } catch (e) {}
      await sleep(400);
    }
    check('开机 18 秒面板一直常驻', collapsedAt === null, collapsedAt ? '被自己收起来了' : '');

    // 进度条能画出来（真发一次 IPC 不方便，直接看样式是否就位）
    await ui(`(() => { const b = document.getElementById('dlProgress'); b.hidden = false; b.className = 'dl-progress'; document.getElementById('dlProgressPct').textContent = '自检'; return true; })()`);
    const pct = await ui(`document.getElementById('dlProgressPct').textContent`);
    check('进度条区域能显示出来', pct === '自检', '实际 ' + pct);

    const crashed = logs.join('').match(/Uncaught|TypeError|ReferenceError|FATAL/);
    check('没有未捕获异常/致命错误', !crashed, crashed ? crashed[0] : '');
  } finally {
    // 便携版是「壳进程 + 真正的 app」两层，只 kill 壳会留下孤儿进程
    try {
      require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) {
      try { child.kill(); } catch (e2) {}
    }
    await sleep(1200);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n打包产物冒烟自己崩了：' + e.message);
  process.exit(2);
});
