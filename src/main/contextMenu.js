'use strict';

/**
 * 右键 / 长按菜单的模板。
 *
 * 为什么要抽成模块：Electron **没有**默认右键菜单，网页部分和界面部分都得自己造。
 * 这套模板原本只挂在了标签页上 —— 结果脚本编辑器（住在界面窗口里）右键 / 长按
 * 什么都不弹，想粘贴连入口都没有。
 *
 * 纯函数：只产出「标签 + 动作 id」，动作由调用方自己接（可单测）。
 */

function add(out, id, label, enabled) {
  if (id === 'sep') {
    out.push({ id: 'sep' });
    return;
  }
  out.push(enabled === false ? { id, label, enabled: false } : { id, label });
}

/** 去掉开头、结尾、连续的分隔线；只剩分隔线就等于空菜单 */
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (it.id !== 'sep') {
      out.push(it);
      continue;
    }
    if (!out.length || out[out.length - 1].id === 'sep') continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].id === 'sep') out.pop();
  return out;
}

/**
 * @param {object} params Electron context-menu 的 params
 *   （isEditable / selectionText / linkURL / pageURL / editFlags）
 * @param {object} [opts]
 * @param {boolean} [opts.tabMode]  true = 网页标签页，附带后退/前进/刷新/站外打开
 * @param {boolean} [opts.canGoBack]
 * @param {boolean} [opts.canGoForward]
 * @param {boolean} [opts.devTools]    末尾附一个「开发者工具」（只给网页标签页用）
 * @returns {Array<{id:string,label?:string,enabled?:boolean}>} 空数组 = 什么都不弹
 */
function buildContextMenu(params, opts) {
  const p = params || {};
  const o = opts || {};
  const tabMode = !!o.tabMode;
  const flags = p.editFlags || {};
  const out = [];

  if (tabMode && p.linkURL) {
    add(out, 'openLinkInTab', '在新标签页打开链接');
    add(out, 'copyLink', '复制链接地址');
    add(out, 'sep');
  }

  if (p.isEditable) {
    add(out, 'undo', '撤销', flags.canUndo);
    add(out, 'redo', '重做', flags.canRedo);
    add(out, 'sep');
    add(out, 'cut', '剪切', flags.canCut);
    add(out, 'copy', '复制', flags.canCopy);
    add(out, 'paste', '粘贴', flags.canPaste);
    add(out, 'selectAll', '全选', flags.canSelectAll);
    add(out, 'sep');
  } else if (p.selectionText) {
    add(out, 'copy', '复制');
    if (tabMode) {
      add(out, 'searchSelection', '搜索「' + String(p.selectionText).slice(0, 12) + '」');
    }
    add(out, 'sep');
  }

  if (tabMode) {
    add(out, 'back', '后退', o.canGoBack);
    add(out, 'forward', '前进', o.canGoForward);
    add(out, 'reload', '刷新');
    if (p.pageURL && /^https?:/i.test(p.pageURL)) {
      add(out, 'openExternal', '在系统浏览器中打开');
    }
    if (p.pageURL && !p.linkURL && !p.selectionText && !p.isEditable) {
      add(out, 'sep');
      add(out, 'copyPageUrl', '复制页面地址');
    }
    if (o.devTools) {
      add(out, 'sep');
      add(out, 'toggleDevTools', '开发者工具');
    }
  }

  return tidy(out);
}

/** 这些是 Electron 的原生 role，不用自己实现 */
const ROLE_ITEMS = {
  undo: 'undo',
  redo: 'redo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll'
};

module.exports = { buildContextMenu, ROLE_ITEMS };
