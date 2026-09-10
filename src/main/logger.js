'use strict';

/**
 * 文件日志。
 *
 * 为什么需要：软件是双击启动的，没有控制台 —— console.log 全部丢弃，
 * 一旦下载/注入出问题，用户说「提示失败」时什么都查不到。
 *
 * 做法：init() 时把 console 包一层，所有既有日志自动落盘，不用改调用点。
 * 位置：<userData>/logs/main.log，超过上限轮转一份 main.1.log。
 */

const fs = require('fs');
const path = require('path');

/** 单个日志文件上限 */
const MAX_BYTES = 2 * 1024 * 1024;

let logFile = '';
let installed = false;
let broken = false;

/** 超过上限就把当前文件挪成 main.1.log，重新开一个 */
function rotateIfNeeded() {
  try {
    const st = fs.statSync(logFile);
    if (st.size < MAX_BYTES) return;

    const backup = logFile.replace(/\.log$/, '') + '.1.log';
    try {
      fs.unlinkSync(backup);
    } catch (e) {
      /* 旧备份不存在就算了 */
    }
    fs.renameSync(logFile, backup);
  } catch (e) {
    /* 文件不存在等，忽略 */
  }
}

function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch (e) {
        return String(a);
      }
    })
    .join(' ');
}

function write(level, args) {
  if (!logFile || broken) return;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] [' + level + '] ' + formatArgs(args) + '\n', 'utf8');
  } catch (e) {
    broken = true; // 日志写不了就闭嘴，别影响主流程
  }
}

/** 包装 console：原来的输出照旧，同时落盘 */
function install() {
  if (installed) return;
  installed = true;

  const origin = { log: console.log, warn: console.warn, error: console.error };

  console.log = function () {
    origin.log.apply(console, arguments);
    write('INFO', Array.prototype.slice.call(arguments));
  };
  console.warn = function () {
    origin.warn.apply(console, arguments);
    write('WARN', Array.prototype.slice.call(arguments));
  };
  console.error = function () {
    origin.error.apply(console, arguments);
    write('ERROR', Array.prototype.slice.call(arguments));
  };
}

/**
 * 启动日志。必须在任何 console 输出之前调用，否则前面那些就丢了。
 * @param {string} userDataPath
 * @returns {string} 日志文件路径，不可写时返回 ''
 */
function init(userDataPath) {
  try {
    const dir = path.join(userDataPath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
  } catch (e) {
    logFile = '';
  }

  install();
  return logFile;
}

function getLogFile() {
  return logFile;
}

function getLogDir() {
  return logFile ? path.dirname(logFile) : '';
}

module.exports = { init, getLogFile, getLogDir, write, MAX_BYTES };
