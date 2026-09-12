'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 渲染进程唯一可用的能力入口，全部通过 IPC 走主进程 */
contextBridge.exposeInMainWorld('scriptdock', {
  // 基础信息
  getInfo: () => ipcRenderer.invoke('app:info'),

  // 日志（排障用）
  getLogPath: () => ipcRenderer.invoke('app:logPath'),
  openLog: () => ipcRenderer.invoke('app:openLog'),

  // 清空缓存（网页资源 + 代码 + 脚本依赖；不动 Cookie 和登录状态）
  clearCache: () => ipcRenderer.invoke('app:clearCache'),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 兼容模式（无沙箱 / 软件渲染），改动需重启生效
  setCompatMode: (mode) => ipcRenderer.invoke('compat:set', mode),

  // 脚本管理
  listScripts: () => ipcRenderer.invoke('scripts:list'),
  reloadScripts: () => ipcRenderer.invoke('scripts:reload'),
  saveScript: (data) => ipcRenderer.invoke('scripts:save', data),
  deleteScript: (id) => ipcRenderer.invoke('scripts:delete', id),
  setScriptEnabled: (id, enabled) => ipcRenderer.invoke('scripts:setEnabled', id, enabled),
  importScripts: () => ipcRenderer.invoke('scripts:import'),
  importFolder: () => ipcRenderer.invoke('scripts:importFolder'),
  importPaths: (paths) => ipcRenderer.invoke('scripts:importPaths', paths),
  openScriptsDir: () => ipcRenderer.invoke('scripts:openDir'),
  listBuiltinScripts: () => ipcRenderer.invoke('scripts:listBuiltin'),
  testMatch: (url, script) => ipcRenderer.invoke('scripts:test', url, script),
  matchUrl: (url) => ipcRenderer.invoke('scripts:matchUrl', url),

  // 外部脚本目录（软件会监视并直接加载其中的脚本）
  dirs: {
    list: () => ipcRenderer.invoke('dirs:list'),
    add: (dir) => ipcRenderer.invoke('dirs:add', dir),
    remove: (dir) => ipcRenderer.invoke('dirs:remove', dir),
    open: (dir) => ipcRenderer.invoke('dirs:open', dir)
  },

  // @require / @resource 外链依赖缓存
  deps: {
    refresh: () => ipcRenderer.invoke('deps:refresh'),
    clear: () => ipcRenderer.invoke('deps:clear')
  },

  // 论坛地址与站内/站外策略
  forum: {
    get: () => ipcRenderer.invoke('forum:get'),
    set: (url, options) => ipcRenderer.invoke('forum:set', url, options),
    open: () => ipcRenderer.invoke('forum:open')
  },

  // 下载：应用内列表 + 打开文件 + 在文件夹中定位
  download: {
    info: () => ipcRenderer.invoke('download:info'),
    list: () => ipcRenderer.invoke('download:list'),
    openFile: (p) => ipcRenderer.invoke('download:openFile', p),
    reveal: (p) => ipcRenderer.invoke('download:reveal', p),
    open: () => ipcRenderer.invoke('download:open'),
    choose: () => ipcRenderer.invoke('download:choose'),
    reset: () => ipcRenderer.invoke('download:reset')
  },

  // 浏览历史
  history: {
    list: (keyword) => ipcRenderer.invoke('history:list', keyword),
    remove: (url) => ipcRenderer.invoke('history:remove', url),
    clear: () => ipcRenderer.invoke('history:clear')
  },

  // GM_registerMenuCommand 注册出来的页面菜单
  menus: {
    invoke: (tabId, menuId) => ipcRenderer.invoke('menu:invoke', tabId, menuId)
  },

  // 标签页
  tabs: {
    create: (url) => ipcRenderer.invoke('tabs:new', url),
    close: (id) => ipcRenderer.invoke('tabs:close', id),
    activate: (id) => ipcRenderer.invoke('tabs:activate', id),
    navigate: (id, url) => ipcRenderer.invoke('tabs:navigate', id, url),
    action: (action) => ipcRenderer.invoke('tabs:action', action),
    toggleDevTools: () => ipcRenderer.invoke('tabs:devtools')
  },

  // 网页视图区域
  view: {
    setBounds: (rect) => ipcRenderer.invoke('view:setBounds', rect),
    setVisible: (visible) => ipcRenderer.invoke('view:setVisible', visible)
  },

  // 主进程推来的事件
  on: (channel, handler) => {
    const allowed = [
      'tabs:state',
      'scripts:changed',
      'settings:changed',
      'menus:state',
      'ui:toast',
      'ui:focus-address',
      'ui:setup-forum',
      'ui:page-clicked',
      'download:done',
      'download:progress',
      'history:changed'
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Electron 32+ 取拖入文件的真实路径
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      return '';
    }
  }
});
