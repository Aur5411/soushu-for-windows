'use strict';

/**
 * UI 冒烟测试用的假 preload。
 *
 * 只为了让 src/renderer/app.js 能在没有主进程的情况下跑起来 ——
 * 把界面用到的 api.* 全部桩掉，并把 api.on 注册的事件处理器收起来，
 * 供测试脚本手动触发（window.__emit）。
 *
 * 这个窗口关掉了 contextIsolation，所以直接赋值即可，不用 contextBridge ——
 * 用 Proxy 才能兜住那些这里没列举到的方法名。
 */

const listeners = new Map();

function fire(channel, payload) {
  const arr = listeners.get(channel) || [];
  for (const fn of arr) {
    try {
      fn(payload);
    } catch (e) {
      console.error('[uismoke] handler error on ' + channel + ': ' + e.message);
    }
  }
}

/** 一个「怎么访问都不会炸」的桩：当函数调用返回 Promise，当对象继续往下钻 */
function flexible(label) {
  const fn = function () {
    return Promise.resolve({});
  };
  return new Proxy(fn, {
    get(t, key) {
      if (key === 'then') return undefined; // 别让它被当成 thenable
      if (key === Symbol.toPrimitive || key === 'toString') return () => '[' + label + ']';
      if (key === Symbol.iterator) return undefined;
      return flexible(label + '.' + String(key));
    },
    apply() {
      return Promise.resolve({});
    }
  });
}

const FIXED = {
  getInfo: () => Promise.resolve({ version: '1.2.14', name: '搜书吧' }),
  getSettings: () => Promise.resolve({ sidebarAutoCollapse: true }),
  setSettings: () => Promise.resolve(true),
  listScripts: () => Promise.resolve([])
};

const NS = {
  forum: { get: () => Promise.resolve({ url: '', defaultEntry: 'https://x/', origin: '' }) },
  download: {
    info: () => Promise.resolve({ dir: 'D:/App/Download', count: 0, custom: false, portable: true })
  },
  history: { list: () => Promise.resolve({ items: [] }) }
};

// 渲染层读的全局名是 window.scriptdock（见 preload.js 的 exposeInMainWorld）
window.scriptdock = new Proxy(
  {},
  {
    get(t, key) {
      const k = String(key);
      if (k === 'on') {
        return (channel, handler) => {
          if (!listeners.has(channel)) listeners.set(channel, []);
          listeners.get(channel).push(handler);
          return () => {};
        };
      }
      if (FIXED[k]) return FIXED[k];
      if (NS[k]) return NS[k];
      return flexible(k);
    }
  }
);

window.__emit = fire;
