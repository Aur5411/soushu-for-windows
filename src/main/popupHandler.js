'use strict';

/**
 * 接管「网页要开新窗口 / 新标签页」这件事。
 *
 * 为什么单独成模块：判定逻辑（forum.js 的 decidePopupAction）和动作分离，
 * 两边都能单测；主进程只负责把动作接到真实能力上（后台下载 / 系统浏览器 / 新标签页）。
 *
 * 背景：论坛的下载链接大量用 `target="_blank"` 或 `window.open` 打开，
 * 只拦 `will-navigate`（同页导航）会漏掉这条路 —— 用户点一下附件就冒出个
 * 新标签页，还得再点一次才下得下来。
 *
 * 所有分支都返回 `{ action: 'deny' }`：**永远不让 Chromium 自己开窗口**。
 * 需要开页面的，由调用方自己走 createTab，这样布局和脚本注入才受我们控制。
 */

const { decidePopupAction } = require('./forum');

/**
 * @param {object} wc 要接管的 webContents
 * @param {object} deps 各类动作的回调，缺哪个哪个就不做
 * @param {Function} [deps.getAutoDownload] 返回用户是否开着「点附件自动下载」
 * @param {Function} [deps.isExternal]      (url) => 是否站外链接
 * @param {Function} [deps.onBlock]         本地文件：拦下并提示
 * @param {Function} [deps.onSwallow]       about:/javascript: 空弹窗：静默吞掉
 * @param {Function} [deps.onBackground]    附件 / txt / blob：后台静默下载
 * @param {Function} [deps.onDownload]      另存为：交给浏览器静默下载
 * @param {Function} [deps.onPaid]          付费附件：开标签页让用户自己决定
 * @param {Function} [deps.onExternal]      站外链接：系统浏览器
 * @param {Function} [deps.onTab]           其余：正常新标签页
 * @returns {Function} 卸载函数
 */
function installPopupHandler(wc, deps) {
  const d = deps || {};
  const fire = (name, url) => {
    if (typeof d[name] === 'function') d[name](url);
  };

  wc.setWindowOpenHandler(({ url, disposition }) => {
    const action = decidePopupAction({
      url,
      disposition,
      autoDownload:
        typeof d.getAutoDownload === 'function' ? d.getAutoDownload() !== false : true,
      isExternal: typeof d.isExternal === 'function' ? !!d.isExternal(url) : false
    });

    switch (action) {
      case 'block':
        fire('onBlock', url);
        break;
      case 'swallow':
        fire('onSwallow', url);
        break;
      case 'background':
        fire('onBackground', url);
        break;
      case 'download':
        fire('onDownload', url);
        break;
      case 'paid':
        fire('onPaid', url);
        break;
      case 'external':
        fire('onExternal', url);
        break;
      default:
        fire('onTab', url);
        break;
    }

    return { action: 'deny' };
  });

  return () => {
    try {
      wc.setWindowOpenHandler(() => ({ action: 'allow' }));
    } catch (e) {
      /* 已经销毁就无所谓了 */
    }
  };
}

module.exports = { installPopupHandler };
