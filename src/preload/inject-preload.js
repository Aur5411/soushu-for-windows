'use strict';

/**
 * 网页侧的注入 preload。
 *
 * 为什么用 preload 而不是 CDP：
 *   - preload 的执行时机早于页面里任何一段脚本，是 Electron 里天然的 document-start
 *   - 不需要 debugger 通道，因此不会和 F12 开发者工具抢占
 *   - 每个 frame（含 iframe）都会独立执行，符合油猴 @noframes 的语义
 *
 * 两条职责：
 *   1. 把注入分发器送进页面主世界（脚本引擎本体）
 *   2. 暴露一个受限桥接层 __scriptdock_bridge__，供 GM_xmlhttpRequest / 剪贴板 /
 *      菜单注册这类需要主进程配合的 API 使用
 *
 * 这里刻意用同步 IPC：异步的话就错过 document-start 了。
 */

const { ipcRenderer, webFrame, contextBridge } = require('electron');

(function () {
  let url = '';
  try {
    url = location.href;
  } catch (e) {
    /* 极少数文档拿不到 location，放弃注入 */
  }

  // ---------- 1. 桥接层（必须在注入脚本之前就位） ----------
  try {
    contextBridge.exposeInMainWorld('__scriptdock_bridge__', {
      // 跨域请求：主进程用 Chromium 网络栈发，不受 CORS 限制、自带 cookie
      request: (options) => ipcRenderer.invoke('scriptdock:gm-xhr', options),
      clipboard: (text) => ipcRenderer.invoke('scriptdock:gm-clipboard', String(text)),
      download: (options) => ipcRenderer.invoke('scriptdock:gm-download', options),
      // 同步注册，页面侧要立刻拿到 id 才能建索引
      registerMenu: (name, accessKey) =>
        ipcRenderer.sendSync('scriptdock:gm-menu-register', {
          url: location.href,
          name: String(name || ''),
          accessKey: String(accessKey || '')
        }),
      clearMenu: (id) => ipcRenderer.send('scriptdock:gm-menu-unregister', { id })
    });
  } catch (e) {
    /* 桥接失败不影响纯 DOM 脚本 */
  }

  // ---------- 2. 取分发器源码 ----------
  let payload = null;
  try {
    payload = ipcRenderer.sendSync('scriptdock:dispatcher', url);
  } catch (e) {
    return;
  }

  if (!payload || !payload.source) return;

  // ---------- 3. 注入页面主世界 ----------
  try {
    webFrame.executeJavaScript(payload.source);
  } catch (e) {
    /* 注入失败不影响页面本身 */
  }
})();
