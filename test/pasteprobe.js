'use strict';

/**
 * 诊断工具（不属于产品代码、也不跑在 npm test 里）：输入框能不能选中 / 粘贴。
 *
 *   electron test/pasteprobe.js
 *
 * 什么时候用：脚本编辑器里打不了字、选不中、粘贴没反应时。
 * 输出里重点看两个值：
 *
 *   taUserSelect    应该是 text。如果是 none，说明被祖先的 user-select:none 继承了
 *                   （body 上就有这个规则），结果是文字选不中、触摸长按也弹不出粘贴菜单。
 *   rangeSelectable 应该是 true。false 就是选不中。
 *
 * 对应的自检项在 selftest.js 的「编辑器输入框能选中文字」。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function stub() {
  ipcMain.handle('app:info', () => ({
    version: '1.2.10',
    scriptsDir: 'X:/scripts',
    cacheDir: 'X:/cache',
    externalDirs: [],
    settings: { sidebarAutoCollapse: false, theme: 'light' },
    compat: { mode: 'auto', enabled: false },
    dispatchLog: []
  }));
  ipcMain.handle('scripts:list', () => []);
  ipcMain.handle('scripts:listBuiltin', () => []);
  ipcMain.handle('scripts:reload', () => []);
  ipcMain.handle('tabs:list', () => ({ tabs: [], activeId: null }));
  ipcMain.handle('downloads:info', () => ({ dir: 'X:/d', count: 0, defaultDir: 'X:/d' }));
  ipcMain.handle('history:list', () => ({ items: [], total: 0 }));
  ipcMain.handle('settings:get', () => ({}));
  ipcMain.handle('app:logPath', () => 'X:/logs/app.log');
  ipcMain.handle('forum:get', () => ({ url: '', defaultEntry: 'x', origin: '' }));
}

app.whenReady().then(async () => {
  stub();

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  let electronContextMenuFired = 0;
  win.webContents.on('context-menu', () => {
    electronContextMenuFired += 1;
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(900);

  await win.webContents.executeJavaScript(
    "document.querySelector('#btnNewScript').click()",
    true
  );
  await wait(700);

  const probe = await win.webContents.executeJavaScript(
    `(function () {
       var ta = document.querySelector('#fCode');
       var nm = document.querySelector('#fName');
       var cs = function (el) { return getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect; };

       // 能不能真的选中：塞点文字、全选、看选区
       ta.value = 'line1\\nline2\\nline3';
       ta.focus();
       ta.select();
       var sel = String(window.getSelection ? window.getSelection().toString() : '');
       var selLen = sel.length;
       var rangeOk = false;
       try {
         var r = document.createRange();
         r.selectNodeContents(ta);
         rangeOk = String(r.toString()).length > 0;
       } catch (e) { rangeOk = false; }

       var rect = ta.getBoundingClientRect();
       return {
         bodyUserSelect: cs(document.body),
         taUserSelect: cs(ta),
         nameUserSelect: cs(nm),
         taReadOnly: ta.readOnly,
         taDisabled: ta.disabled,
         taEditable: !ta.readOnly && !ta.disabled,
         taCursor: getComputedStyle(ta).cursor,
         taPointerEvents: getComputedStyle(ta).pointerEvents,
         taZIndexTop: (function () {
           var el = document.elementFromPoint(
             Math.round(rect.left + rect.width / 2),
             Math.round(rect.top + 20)
           );
           return el ? (el.tagName + (el.id ? '#' + el.id : '')) : 'null';
         })(),
         selectionLength: selLen,
         rangeSelectable: rangeOk,
         selectionStart: ta.selectionStart,
         selectionEnd: ta.selectionEnd,
         valueLength: ta.value.length
       };
     })()`,
    true
  );

  console.log('=== 编辑器输入框探针 ===');
  for (const [k, v] of Object.entries(probe)) console.log('  ' + k + ' = ' + JSON.stringify(v));
  console.log('  （脚本内合成的 contextmenu 不会触发 Electron 的 context-menu 事件，');
  console.log('    所以 electronContextMenuFired=' + electronContextMenuFired + ' 属正常，仅供参考）');

  win.destroy();
  app.exit(0);
});
