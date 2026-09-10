'use strict';

/**
 * 页面侧 GM API 依赖的全部 IPC 通道。
 *
 * 抽成独立模块有两个原因：
 *   1. 主进程入口文件不至于被这一堆通道撑爆
 *   2. 自检能复用同一份实现，测的是真代码而不是复制品
 *
 * 依赖通过参数注入，避免这个模块反过来依赖主进程的全局状态。
 */

const fs = require('fs');
const path = require('path');
const { clipboard } = require('electron');

const http = require('./http');

const XHR_MAX_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;

function registerGmApi(options) {
  const {
    ipcMain,
    resolveDownloadDir,
    uniqueTarget,
    pushToast = () => {},
    registerMenu = () => null,
    unregisterMenu = () => {},
    invokeMenu = () => Promise.resolve(false),
    listMenus = () => []
  } = options || {};

  /** GM_xmlhttpRequest：用 Chromium 网络栈发，绕过 CORS、自带该站点 cookie */
  ipcMain.handle('scriptdock:gm-xhr', async (e, rawOptions) => {
    const opts = rawOptions || {};
    const res = await http.request({
      url: opts.url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      data: opts.data === undefined ? null : opts.data,
      timeout: Number(opts.timeout) || 30000,
      maxBytes: XHR_MAX_BYTES
    });

    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      finalUrl: res.finalUrl,
      responseHeaders: res.responseHeaders,
      responseText: res.responseText,
      bytes: res.bytes
    };
  });

  /** GM_setClipboard */
  ipcMain.handle('scriptdock:gm-clipboard', (e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });

  /** GM_download */
  ipcMain.handle('scriptdock:gm-download', async (e, rawOptions) => {
    const opts = rawOptions || {};
    try {
      const res = await http.request({
        url: opts.url,
        headers: opts.headers || {},
        timeout: 120000,
        maxBytes: DOWNLOAD_MAX_BYTES,
        wantBuffer: true
      });

      let name = String(opts.name || '').trim();
      if (!name) {
        try {
          const pathname = new URL(opts.url).pathname;
          name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
        } catch (err) {
          name = '';
        }
      }

      const dir = resolveDownloadDir();
      const target = uniqueTarget(dir, name || 'download');
      fs.writeFileSync(target, res.buffer || Buffer.from(res.responseText, 'utf8'));

      const base = path.basename(target);
      pushToast('已下载到 Download：' + base, 'ok');
      return { ok: true, path: target, name: base, dir };
    } catch (err) {
      const msg = String((err && err.message) || err);
      pushToast('下载失败：' + msg, 'error');
      return { ok: false, error: msg };
    }
  });

  /** GM_registerMenuCommand：同步返回 id，页面侧拿它建回调索引 */
  ipcMain.on('scriptdock:gm-menu-register', (event, payload) => {
    const wcId = event.sender ? event.sender.id : null;
    const data = payload || {};
    if (!wcId || !data.name) {
      event.returnValue = null;
      return;
    }
    event.returnValue = registerMenu(wcId, {
      name: String(data.name),
      accessKey: String(data.accessKey || ''),
      url: String(data.url || '')
    });
  });

  ipcMain.on('scriptdock:gm-menu-unregister', (event, payload) => {
    const wcId = event.sender ? event.sender.id : null;
    if (wcId && payload && payload.id) unregisterMenu(wcId, payload.id);
  });

  ipcMain.handle('menu:invoke', (e, tabId, menuId) => invokeMenu(tabId, menuId));
  ipcMain.handle('menu:list', () => listMenus());

  /** 下载目录的「打开」。查询/更改/恢复默认带业务信息，放在主进程里注册 */
  ipcMain.handle('download:open', async () => {
    const { shell } = require('electron');
    return shell.openPath(resolveDownloadDir());
  });
}

module.exports = { registerGmApi };
