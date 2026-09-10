'use strict';

/**
 * 下载保存位置。
 *
 * 需求：软件里下载的东西都落到「软件文件夹」里的 Download 目录，
 * 不要散到系统下载文件夹里去。
 *
 * 解析顺序：
 *   1. 用户在设置里指定的目录
 *   2. 可执行文件旁边的 Download（便携版就是 exe 所在的那个文件夹）
 *   3. 该位置不可写（比如装在 Program Files）时，退回用户数据目录下的 Download
 *
 * 抽成独立模块是为了可测：这里是纯路径逻辑，不依赖主进程的全局状态。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let exeDirWritable = null;

/**
 * 软件所在文件夹。
 * 便携版必须读 PORTABLE_EXECUTABLE_DIR —— 否则拿到的是临时解包目录，用户根本找不到。
 */
function appFolder() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && fs.existsSync(portableDir)) return portableDir;
  try {
    return path.dirname(app.getPath('exe'));
  } catch (e) {
    return app.getPath('userData');
  }
}

function canWriteDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * @param {() => string|null|undefined} getCustomDir 读取用户配置的目录
 */
function resolveDownloadDir(getCustomDir) {
  let custom = null;
  try {
    custom = typeof getCustomDir === 'function' ? getCustomDir() : null;
  } catch (e) {
    custom = null;
  }
  if (custom && canWriteDir(custom)) return custom;

  const beside = path.join(appFolder(), 'Download');
  if (exeDirWritable === null) exeDirWritable = canWriteDir(beside);
  if (exeDirWritable) return beside;

  const fallback = path.join(app.getPath('userData'), 'Download');
  canWriteDir(fallback);
  return fallback;
}

/** 同名文件自动加 (1)(2)，避免直接覆盖 */
function uniqueTarget(dir, fileName) {
  const safe =
    String(fileName || 'download')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 150) || 'download';

  const ext = path.extname(safe);
  const base = path.basename(safe, ext);

  let target = path.join(dir, safe);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, base + '(' + i + ')' + ext);
    i += 1;
  }
  return target;
}

module.exports = { appFolder, canWriteDir, resolveDownloadDir, uniqueTarget };
