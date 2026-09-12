'use strict';

/**
 * 下载进度的截图小工具：把底部状态栏那一条放大画出来，用来肉眼核对排版。
 *
 *   npx electron test/progressshot.js [输出目录]
 *
 * 做法：先加载真的 index.html，把状态栏那块 **真实 markup** 取出来，
 * 再放进一个只用于预览的页面（同样内联真的 style.css），
 * 每个状态单独截一张 —— 整体放大 2.5 倍后截图。
 *
 * 几个踩过的坑，改这个脚本时注意：
 *   1) 不能用 setZoomFactor 放大：这台机器屏幕小，窗口会被系统压到 987×546 DIP，
 *      一放大布局就挤变形，截出来的不是真实排版。用 transform: scale()。
 *   2) capturePage 的 rect 不能超过窗口可视区 —— 超了 Chromium 会把整页
 *      缩放进那个矩形，得到一张「整体变小」的图（看着像放大没生效）。
 *      所以这里每次都把 rect 夹到可视区内。
 *   3) 预览页里的 status-msg 要收掉：真界面上它是 flex:1 的空位，
 *      会把进度块顶到右边，放大后直接超出可视区。
 *
 * 输出（默认写到临时目录，不落进仓库）：
 *   1-progress.png 2-unknown.png 3-done.png 4-fail.png 5-idle.png
 *   6-window.png（真界面 1 倍全窗口，看整体布局）
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const outDir = process.argv[2] || path.join(os.tmpdir(), 'scriptdock-progress-shots');
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCALE = 2.5;

const STATES = [
  { file: '1-progress.png', label: '下载中（服务器给了长度）', cls: 'dl-progress', name: '斗破苍穹.txt  28.0 MB/44.0 MB', pct: '64%', width: '64%', ind: false },
  { file: '2-unknown.png', label: '长度未知（走跑马灯）', cls: 'dl-progress', name: '未知大小.rar', pct: '5.0 MB', width: '100%', ind: true },
  { file: '3-done.png', label: '下载完成', cls: 'dl-progress done', name: '斗破苍穹.txt', pct: '完成', width: '100%', ind: false },
  { file: '4-fail.png', label: '下载失败', cls: 'dl-progress fail', name: '坏的.zip', pct: '失败', width: '100%', ind: false },
  { file: '5-idle.png', label: '空闲（整块藏起来，只剩左边提示区）', cls: null, name: '', pct: '', width: '', ind: false }
];

async function main() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: false }
  });

  const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'style.css');
  const cssText = fs.readFileSync(cssPath, 'utf8');

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // 真界面：拿状态栏 markup
  await win.loadFile(indexPath);
  await sleep(300);
  const barHtml = await js(`document.querySelector('.statusbar').innerHTML`);
  if (!barHtml || !/dl-progress/.test(barHtml)) {
    throw new Error('没取到状态栏 markup：' + String(barHtml).slice(0, 200));
  }

  const viewport = await js(`({ w: window.innerWidth, h: window.innerHeight })`);
  console.log('  窗口可视区：' + viewport.w + 'x' + viewport.h + ' DIP');

  const crop = (rect) => ({
    x: Math.max(0, Math.min(rect.x, viewport.w - 1)),
    y: Math.max(0, Math.min(rect.y, viewport.h - 1)),
    width: Math.max(1, Math.min(rect.width, viewport.w)),
    height: Math.max(1, Math.min(rect.height, viewport.h))
  });

  const shot = async (file, rect) => {
    const img = await win.webContents.capturePage(rect ? crop(rect) : undefined);
    const out = path.join(outDir, file);
    fs.writeFileSync(out, img.toPNG());
    console.log('  ' + out + '   ' + img.getSize().width + 'x' + img.getSize().height);
  };

  // ---- 每个状态单独一页：状态栏 + 放大，截出来刚好够大够清楚 ----
  for (const st of STATES) {
    const page = `<!doctype html><html><head><meta charset="utf-8">
<style>${cssText}</style>
<style>
  body { margin: 0; padding: 10px; background: #eef0f3; font-family: "Microsoft YaHei", sans-serif; }
  .statusbar { width: 380px; }
  .status-msg { display: none; }
</style></head><body>
<div class="frame"><div class="statusbar">${barHtml}</div></div>
</body></html>`;

    const tmp = path.join(os.tmpdir(), 'scriptdock-progress-preview.html');
    fs.writeFileSync(tmp, page);
    await win.loadFile(tmp);
    await sleep(200);

    const rect = await js(`(() => {
      const box = document.querySelector('.dl-progress');
      const name = box.querySelector('.dl-progress-name');
      const bar = box.querySelector('.dl-progress-bar');
      const fill = box.querySelector('.dl-progress-fill');
      const pct = box.querySelector('.dl-progress-pct');
      const cls = ${JSON.stringify(st.cls)};
      if (cls === null) { box.hidden = true; }
      else {
        box.hidden = false;
        box.className = cls;
        name.textContent = ${JSON.stringify(st.name)};
        pct.textContent = ${JSON.stringify(st.pct)};
        fill.style.width = ${JSON.stringify(st.width)};
        bar.classList.toggle('indeterminate', ${st.ind ? 'true' : 'false'});
      }
      const strip = document.querySelector('.statusbar');
      strip.style.transformOrigin = 'top left';
      strip.style.transform = 'scale(${SCALE})';
      const r = strip.getBoundingClientRect();
      return { x: 0, y: 0, width: Math.ceil(r.width) + 2, height: Math.ceil(r.height) + 2 };
    })()`);

    // 等两帧再截：软件渲染下新页面第一帧可能还没画出来，
    // 直接截会得到一张「什么都没有」的图（实测第一张就是这样丢的）
    await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    await sleep(500);
    await shot(st.file, rect);
    try { fs.unlinkSync(tmp); } catch (e) {}
  }

  // ---- 真界面：整体布局（1 倍），顺便看一眼侧栏常驻 + 底部进度 ----
  const win2 = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'uismoke-preload.js'),
      contextIsolation: false,
      sandbox: false
    }
  });
  await win2.loadFile(indexPath);
  await sleep(400);
  await win2.webContents.executeJavaScript(
    `__emit('ui:toast', { message: '已下载到 Download：斗破苍穹.txt', kind: 'ok' });
     __emit('download:progress', { name: '斗破苍穹.txt', received: 29360128, total: 46137344, state: 'progressing' });`,
    true
  );
  await sleep(300);
  const img2 = await win2.webContents.capturePage();
  const out2 = path.join(outDir, '6-window.png');
  fs.writeFileSync(out2, img2.toPNG());
  console.log('  ' + out2 + '   ' + img2.getSize().width + 'x' + img2.getSize().height);

  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('截图失败：', e);
    app.exit(1);
  })
);
