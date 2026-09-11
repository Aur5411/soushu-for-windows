'use strict';

/**
 * 打包后翻转 Electron 的 fuse 开关。
 *
 * 为什么需要这一步：Electron 默认把这些开关设得比较宽松，而它们恰好是
 * 杀软/EDR 判断「像不像木马」的常见依据 —— 尤其 `RunAsNode`（`ELECTRON_RUN_AS_NODE`
 * 能把 Electron 当 node 解释器跑任意脚本）是已知的恶意软件手法。
 *
 * 为什么要自己写：本项目用的 electron-builder 25 还没有 `electronFuses` 配置项
 * （那是 v26 才加的），所以挂在 `build.afterPack` 里手动翻。
 *
 * 配置在 package.json 的 `build.afterPack`。
 */

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/** 目标状态：true = 开启，false = 关闭 */
const WANT = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false

  // GrantFileProtocolExtraPrivileges 故意**不动**（保持默认的「开启」）。
  //
  // 实测过：把它关掉，界面会直接白屏 —— 主进程日志正常，但渲染层报
  //   Failed to load URL: file://.../app.asar/src/renderer/index.html
  //   with error: ERR_FILE_NOT_FOUND
  // 因为 Electron 的 asar 支持是挂在 file:// 协议的「特权处理」上的，
  // 关掉这个开关就再也读不到 asar 里的文件，而我们的界面正是用
  // win.loadFile() 从 app.asar 里加载的。
  //
  // 要真想关掉它，得先把界面改成走自定义协议（比如 app://）而不是 file://，
  // 那是另一件事，别在这里顺手改。
};

const LABEL = {
  [FuseV1Options.RunAsNode]: 'RunAsNode',
  [FuseV1Options.EnableCookieEncryption]: 'EnableCookieEncryption',
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 'EnableNodeOptionsEnvironmentVariable',
  [FuseV1Options.EnableNodeCliInspectArguments]: 'EnableNodeCliInspectArguments',
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 'EnableEmbeddedAsarIntegrityValidation',
  [FuseV1Options.OnlyLoadAppFromAsar]: 'OnlyLoadAppFromAsar',
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: 'LoadBrowserProcessSpecificV8Snapshot',
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: 'GrantFileProtocolExtraPrivileges'
};

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  if (electronPlatformName !== 'win32') return;

  const exe = path.join(appOutDir, packager.appInfo.productFilename + '.exe');

  try {
    const changed = await flipFuses(exe, Object.assign({ version: FuseVersion.V1 }, WANT));
    const list = Object.keys(WANT).map((k) => LABEL[k] + '=' + (WANT[k] ? '开' : '关'));
    console.log('  • Electron fuses 已加固（改了 ' + changed + ' 项）：' + list.join(', '));
  } catch (e) {
    // 翻转失败不要静默放过 —— 那等于以为加固了其实没加
    throw new Error('翻转 Electron fuse 失败：' + ((e && e.message) || e) + ' | 目标=' + exe);
  }
};
