'use strict';

/**
 * 注入引擎（主进程侧）。
 *
 * 时机问题怎么解决的：网页里由 preload 负责在 document-start 把分发器注入主世界，
 * 主进程这边只做两件事 —— 按网址筛出该跑的脚本，生成分发器源码。
 *
 * 为什么是「一个分发器」而不是每个脚本注册一次：
 * 分发器里带着脚本和它们的匹配规则，进入文档时自己决定跑哪些。
 * 于是主进程不必跟踪每个标签页、每次导航的注册状态，天然支持多标签、多 frame。
 */

const fs = require('fs');
const path = require('path');

const { VERSION } = require('../shared/version');
const { sdMatchUrl } = require('../shared/match');

const MATCH_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'match.js'), 'utf8');

/** 分发器使用的页面侧命名空间，避免污染网页变量 */
const NS = '__scriptdock__';
/** 页面侧的菜单命令注册表（主进程点菜单时按 id 回调这里） */
const MENU_REGISTRY = '__scriptdock_menu__';
/** 页面侧桥接对象名，与 inject-preload.js 保持一致 */
const BRIDGE_NAME = '__scriptdock_bridge__';

/** 页面侧运行时（URL 匹配 + GM API + run-at 调度） */
function buildRuntimeSource(scripts) {
  const payload = (scripts || []).map((s) => ({
    id: String(s.id || ''),
    name: String(s.name || '未命名脚本'),
    version: String(s.version || ''),
    runAt: s.runAt || 'document-end',
    noframes: !!s.noframes,
    matches: s.matches || [],
    includes: s.includes || [],
    excludes: s.excludes || [],
    excludeMatches: s.excludeMatches || [],
    grants: s.grants || [],
    requiresText: s.requiresText || [],
    resourceMap: s.resourceMap || {},
    code: String(s.code || '')
  }));

  return `(function () {
  "use strict";
  var NS = ${JSON.stringify(NS)};
  if (window[NS] && window[NS].dispatched) { return; }
  try {
    Object.defineProperty(window, NS, { value: { dispatched: true }, enumerable: false, configurable: true, writable: true });
  } catch (e) {
    window[NS] = { dispatched: true };
  }

  /* ---- 内联的 URL 匹配引擎（与主进程共用同一份源码） ---- */
${MATCH_SOURCE}

  var SCRIPTS = ${JSON.stringify(payload)};
  var VERSION = ${JSON.stringify(VERSION)};
  var BRIDGE = window.${BRIDGE_NAME} || null;

  /* 菜单命令注册表：主进程点菜单时按 id 回调这里 */
  var MENU = window.${MENU_REGISTRY} = window.${MENU_REGISTRY} || {};
  var MENU_SEQ = 1;

  /* GM 值变更监听：storageKey -> { id: { key, fn, scriptId } } */
  var VALUE_LISTENERS = {};
  var VALUE_SEQ = 1;

  function safeJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function rawHeaders(headers) {
    if (!headers) return "";
    var lines = [];
    for (var k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k)) lines.push(k + ": " + headers[k]);
    }
    return lines.join("\\r\\n");
  }

  function toDataUrl(text) {
    try {
      return "data:text/plain;charset=utf-8;base64," +
        btoa(unescape(encodeURIComponent(String(text))));
    } catch (e) { return ""; }
  }

  function storageKey(id, key) { return NS + ":v:" + id + ":" + key; }

  function fireListeners(sk, oldRaw, newRaw, remote) {
    var bag = VALUE_LISTENERS[sk];
    if (!bag) return;
    for (var id in bag) {
      if (!Object.prototype.hasOwnProperty.call(bag, id)) continue;
      var item = bag[id];
      try {
        item.fn(item.key, safeJson(oldRaw), safeJson(newRaw), !!remote);
      } catch (e) {
        console.error("[" + NS + "] 值变更回调出错：", e);
      }
    }
  }

  /* 其它标签页改了同一个值 —— localStorage 会广播 storage 事件 */
  try {
    window.addEventListener("storage", function (e) {
      if (!e || !e.key) return;
      if (e.key.indexOf(NS + ":v:") !== 0) return;
      fireListeners(e.key, e.oldValue, e.newValue, true);
    });
  } catch (e) {}

  function makeRes(url, text) {
    return typeof text === "string" ? text : "";
  }

  function makeGM(script) {
    var resources = script.resourceMap || {};

    function getValue(key, fallback) {
      try {
        var raw = localStorage.getItem(storageKey(script.id, key));
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    }

    function setValue(key, value) {
      var sk = storageKey(script.id, key);
      var oldRaw = null;
      try { oldRaw = localStorage.getItem(sk); } catch (e) {}
      try { localStorage.setItem(sk, JSON.stringify(value)); } catch (e) { return; }
      fireListeners(sk, oldRaw, JSON.stringify(value), false);
    }

    function deleteValue(key) {
      var sk = storageKey(script.id, key);
      var oldRaw = null;
      try { oldRaw = localStorage.getItem(sk); } catch (e) {}
      try { localStorage.removeItem(sk); } catch (e) {}
      fireListeners(sk, oldRaw, null, false);
    }

    function listValues() {
      var out = [];
      try {
        var prefix = storageKey(script.id, "");
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
        }
      } catch (e) {}
      return out;
    }

    function addValueChangeListener(key, fn) {
      if (typeof fn !== "function") return -1;
      var sk = storageKey(script.id, key);
      var id = VALUE_SEQ++;
      if (!VALUE_LISTENERS[sk]) VALUE_LISTENERS[sk] = {};
      VALUE_LISTENERS[sk][id] = { key: key, fn: fn, scriptId: script.id };
      return id;
    }

    function removeValueChangeListener(id) {
      for (var sk in VALUE_LISTENERS) {
        if (VALUE_LISTENERS[sk] && VALUE_LISTENERS[sk][id]) {
          delete VALUE_LISTENERS[sk][id];
          return;
        }
      }
    }

    function addStyle(css) {
      var el = document.createElement("style");
      el.setAttribute("data-scriptdock", script.name);
      el.textContent = String(css);
      (document.head || document.documentElement || document).appendChild(el);
      return el;
    }

    function addElement(parent, tag, attrs) {
      var el = document.createElement(tag);
      if (attrs) {
        for (var k in attrs) {
          if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
        }
      }
      if (parent) parent.appendChild(el);
      return el;
    }

    function log() {
      var args = ["[" + NS + "][" + script.name + "]"].concat([].slice.call(arguments));
      console.log.apply(console, args);
    }

    function openInTab(url, options) {
      var opts = options || {};
      if (opts.active === false) {
        var w = window.open(url, "_blank");
        try { if (w) w.blur(); window.focus(); } catch (e) {}
        return w;
      }
      return window.open(url, "_blank");
    }

    function notification(text, title, image, onclick) {
      try {
        if (typeof Notification === "undefined") return;
        var fire = function () {
          var n = new Notification(title || script.name, { body: String(text), icon: image || undefined });
          if (typeof onclick === "function") n.onclick = onclick;
        };
        if (Notification.permission === "granted") fire();
        else if (Notification.permission !== "denied") {
          Notification.requestPermission().then(function (p) { if (p === "granted") fire(); });
        }
      } catch (e) {}
    }

    function setClipboard(text, type) {
      if (BRIDGE && BRIDGE.clipboard) {
        return BRIDGE.clipboard(String(text));
      }
      try {
        if (navigator.clipboard) return navigator.clipboard.writeText(String(text));
      } catch (e) {}
      return Promise.resolve();
    }

    /* ---- 跨域请求：走主进程的 Chromium 网络栈，不受 CORS 限制、自带 cookie ---- */
    function runXhr(details) {
      details = details || {};
      var aborted = false;
      var headers = details.headers || null;
      var body = details.data != null ? details.data : (details.body != null ? details.body : null);

      var promise;
      if (!BRIDGE || !BRIDGE.request) {
        promise = Promise.reject(new Error("桥接层不可用，无法发起跨域请求"));
      } else {
        promise = BRIDGE.request({
          url: String(details.url || ""),
          method: String(details.method || "GET").toUpperCase(),
          headers: headers,
          data: body == null ? null : String(body),
          timeout: Number(details.timeout) || 30000,
          responseType: String(details.responseType || "text"),
          anonymous: !!details.anonymous
        });
      }

      var handler = promise.then(
        function (res) {
          if (aborted) return null;
          var response = {
            readyState: 4,
            status: res.status,
            statusCode: res.status,
            statusText: res.statusText || "",
            finalUrl: res.finalUrl || details.url,
            responseHeaders: rawHeaders(res.responseHeaders),
            responseText: res.responseText,
            response: String(details.responseType || "text").toLowerCase() === "json"
              ? safeJson(res.responseText)
              : res.responseText
          };
          if (typeof details.onload === "function") {
            try { details.onload(response); } catch (e) { console.error("[" + NS + "] onload 出错：", e); }
          }
          if (typeof details.onreadystatechange === "function") {
            try { details.onreadystatechange(response); } catch (e) {}
          }
          return response;
        },
        function (err) {
          if (aborted) return null;
          var info = {
            readyState: 4,
            status: 0,
            statusText: "",
            error: String((err && err.message) || err),
            responseText: ""
          };
          if (typeof details.onerror === "function") {
            try { details.onerror(info); } catch (e) {}
          }
          if (typeof details.ontimeout === "function" && /超时/.test(info.error)) {
            try { details.ontimeout(info); } catch (e) {}
          }
          throw err;
        }
      );

      // 吞掉未捕获的 rejection，避免在页面上冒出红色报错
      handler.catch(function () {});

      return {
        promise: handler,
        abort: function () {
          aborted = true;
          if (typeof details.onabort === "function") {
            try { details.onabort({ readyState: 4, status: 0, statusText: "" }); } catch (e) {}
          }
        }
      };
    }

    function xhrLegacy(details) {
      var task = runXhr(details);
      return { abort: task.abort };
    }

    function xhrModern(details) {
      var task = runXhr(details);
      return task.promise;
    }

    function download(details) {
      details = details || {};
      if (!BRIDGE || !BRIDGE.download) return Promise.reject(new Error("桥接层不可用"));
      return BRIDGE.download({
        url: String(details.url || ""),
        name: details.name ? String(details.name) : "",
        headers: details.headers || null
      }).then(function (res) {
        if (res && res.ok && typeof details.onload === "function") {
          try { details.onload(res); } catch (e) {}
        } else if (res && !res.ok && typeof details.onerror === "function") {
          try { details.onerror(res); } catch (e) {}
        }
        return res;
      });
    }

    function registerMenuCommand(name, fn, accessKey) {
      if (!BRIDGE || !BRIDGE.registerMenu || typeof fn !== "function") return -1;
      var id;
      try {
        id = BRIDGE.registerMenu(String(name), accessKey ? String(accessKey) : "");
      } catch (e) {
        return -1;
      }
      if (id === undefined || id === null) return -1;
      MENU[id] = fn;
      return id;
    }

    function unregisterMenuCommand(id) {
      if (MENU[id]) delete MENU[id];
      if (BRIDGE && BRIDGE.clearMenu) {
        try { BRIDGE.clearMenu(id); } catch (e) {}
      }
    }

    return {
      info: {
        script: {
          name: script.name,
          version: script.version,
          description: "",
          matches: script.matches,
          grants: script.grants,
          runAt: script.runAt
        },
        scriptMetaStr: "",
        scriptHandler: "Soushuba",
        version: VERSION,
        platform: navigator.platform
      },
      getValue: getValue,
      setValue: setValue,
      deleteValue: deleteValue,
      listValues: listValues,
      addValueChangeListener: addValueChangeListener,
      removeValueChangeListener: removeValueChangeListener,
      addStyle: addStyle,
      addElement: addElement,
      log: log,
      openInTab: openInTab,
      notification: notification,
      setClipboard: setClipboard,
      xhrLegacy: xhrLegacy,
      xhrModern: xhrModern,
      download: download,
      registerMenuCommand: registerMenuCommand,
      unregisterMenuCommand: unregisterMenuCommand,
      getResourceText: function (name) { return makeRes(name, resources[name]); },
      getResourceURL: function (name) { return toDataUrl(makeRes(name, resources[name])); }
    };
  }

  function run(script) {
    if (script.noframes && window.top !== window.self) return;

    var gm = makeGM(script);

    // 老式写法：裸的 GM_xxx 全局
    window.GM_getValue = gm.getValue;
    window.GM_setValue = gm.setValue;
    window.GM_deleteValue = gm.deleteValue;
    window.GM_listValues = gm.listValues;
    window.GM_addValueChangeListener = gm.addValueChangeListener;
    window.GM_removeValueChangeListener = gm.removeValueChangeListener;
    window.GM_addStyle = gm.addStyle;
    window.GM_addElement = gm.addElement;
    window.GM_log = gm.log;
    window.GM_info = gm.info;
    window.GM_openInTab = gm.openInTab;
    window.GM_notification = gm.notification;
    window.GM_setClipboard = gm.setClipboard;
    window.GM_xmlhttpRequest = gm.xhrLegacy;
    window.GM_download = gm.download;
    window.GM_registerMenuCommand = gm.registerMenuCommand;
    window.GM_unregisterMenuCommand = gm.unregisterMenuCommand;
    window.GM_getResourceText = gm.getResourceText;
    window.GM_getResourceURL = gm.getResourceURL;

    // 新式写法：GM.setValue 之类
    window.GM = {
      info: gm.info,
      getValue: gm.getValue,
      setValue: gm.setValue,
      deleteValue: gm.deleteValue,
      listValues: gm.listValues,
      addValueChangeListener: gm.addValueChangeListener,
      removeValueChangeListener: gm.removeValueChangeListener,
      addStyle: gm.addStyle,
      addElement: gm.addElement,
      log: gm.log,
      openInTab: gm.openInTab,
      notification: gm.notification,
      setClipboard: gm.setClipboard,
      xmlHttpRequest: gm.xhrModern,
      download: gm.download,
      registerMenuCommand: gm.registerMenuCommand,
      unregisterMenuCommand: gm.unregisterMenuCommand,
      getResourceText: gm.getResourceText,
      getResourceURL: gm.getResourceURL
    };

    window.unsafeWindow = window;

    try {
      // @require 的外链依赖先执行，脚本正文才能用到它们
      var deps = script.requiresText || [];
      for (var d = 0; d < deps.length; d++) {
        try {
          (0, eval)(deps[d].text + "\\n//# sourceURL=" + NS + "/require/" + d);
        } catch (depErr) {
          console.error("[" + NS + "] 「" + script.name + "」的 @require 执行失败（" + deps[d].url + "）：", depErr);
        }
      }

      var wrapped = script.code + "\\n//# sourceURL=" + NS + "/" + String(script.id).replace(/[^\\w.\\-]/g, "_");
      (0, eval)(wrapped);
    } catch (err) {
      console.error("[" + NS + "] 脚本「" + script.name + "」执行出错：", err);
    }
  }

  function onIdle(script) {
    if (document.readyState === "complete") {
      setTimeout(function () { run(script); }, 0);
    } else {
      window.addEventListener("load", function () { setTimeout(function () { run(script); }, 0); }, { once: true });
    }
  }

  function schedule(script) {
    var at = script.runAt;
    if (at === "document-start") { run(script); return; }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        if (at === "document-idle") onIdle(script);
        else run(script);
      }, { once: true });
      return;
    }

    if (at === "document-idle") onIdle(script);
    else run(script);
  }

  var hits = [];
  for (var i = 0; i < SCRIPTS.length; i++) {
    if (sdMatchUrl(location.href, SCRIPTS[i])) hits.push(SCRIPTS[i]);
  }

  if (hits.length) {
    try {
      console.log("[" + NS + "] " + location.host + " 命中 " + hits.length + " 个脚本：" +
        hits.map(function (s) { return s.name; }).join("、"));
    } catch (e) {}
    for (var j = 0; j < hits.length; j++) schedule(hits[j]);
  }
})();`;
}

/** 兼容旧名字 */
function buildDispatcherSource(scripts) {
  return buildRuntimeSource(scripts);
}

/**
 * 注册页面侧要调用的同步通道。
 * 主进程在这里一次性完成「按网址筛选」，页面侧只拿到用得上的脚本，
 * 避免每个 frame 都背着一份全量脚本列表。
 */
function registerDispatcherChannel({ ipcMain, getScripts, onDispatch }) {
  ipcMain.on('scriptdock:dispatcher', (event, url) => {
    const target = String(url || '');
    let source = '';
    let names = [];

    try {
      const all = getScripts() || [];
      const hits = target ? all.filter((s) => sdMatchUrl(target, s)) : [];
      if (hits.length) {
        source = buildRuntimeSource(hits);
        names = hits.map((s) => s.name);
      }
    } catch (e) {
      console.error('[搜书吧] 生成注入源码失败', e);
    }

    if (typeof onDispatch === 'function') {
      try {
        onDispatch(target, names, event.sender ? event.sender.id : null);
      } catch (e) {
        /* 仅用于统计，出错不影响注入 */
      }
    }

    event.returnValue = { source };
  });
}

/**
 * 生成「在页面里调用某个 GM 菜单命令」的源码。
 * 主进程和自检共用，保证测的就是真逻辑。
 */
function buildMenuInvokeSource(menuId) {
  return (
    '(function(){try{var r=window.' +
    MENU_REGISTRY +
    '||{};var f=r[' +
    JSON.stringify(String(menuId)) +
    '];if(typeof f==="function"){f();return true;}}catch(e){console.error(e);}return false;})()'
  );
}

module.exports = {
  buildRuntimeSource,
  buildDispatcherSource,
  registerDispatcherChannel,
  buildMenuInvokeSource,
  NS,
  MENU_REGISTRY,
  BRIDGE_NAME
};
