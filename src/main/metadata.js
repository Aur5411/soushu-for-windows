'use strict';

/**
 * .user.js 元数据块的解析与序列化。
 *
 * 处理的格式就是 Tampermonkey / Violentmonkey 通用的那套：
 *
 *   // ==UserScript==
 *   // @name        脚本名字
 *   // @match       https://example.com/*
 *   // @run-at      document-start
 *   // ==/UserScript==
 *   ...脚本正文...
 */

const BLOCK_RE = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/;
const HEADER_LINE_RE = /^\s*\/\/\s*@([A-Za-z0-9_-]+)[ \t]*(.*)$/;

const MULTI_KEYS = ['match', 'include', 'exclude', 'exclude-match', 'grant', 'require', 'resource', 'connect'];

/** 把一行元数据键名归一化成内部字段名 */
function normalizeKey(key) {
  const k = String(key).toLowerCase();
  if (k === 'exclude-match') return 'excludeMatch';
  if (k === 'run-at') return 'runAt';
  if (k === 'name:zh-cn' || k === 'name:zh' || k === 'name:zh_tw') return 'name';
  if (k === 'description:zh-cn' || k === 'description:zh') return 'description';
  return k;
}

/**
 * 解析一段 .user.js 源码
 * @returns {{meta: object, headers: Array, body: string}}
 */
function parseUserscript(code) {
  const text = String(code == null ? '' : code);
  const match = BLOCK_RE.exec(text);

  const meta = {};
  const headers = [];
  let body = text;

  if (match) {
    const raw = match[1];
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const m = HEADER_LINE_RE.exec(line);
      if (!m) continue;

      const key = m[1];
      const value = m[2].trim();
      headers.push({ key, value });

      const norm = normalizeKey(key);

      if (MULTI_KEYS.includes(key.toLowerCase())) {
        if (!meta[norm]) meta[norm] = [];
        meta[norm].push(value);
      } else if (meta[norm] === undefined) {
        meta[norm] = value;
      }
    }

    body = text.slice(match.index + match[0].length).replace(/^\s*\n/, '');
  }

  return { meta, headers, body };
}

/** 元数据 → 统一的脚本对象 */
function metaToScript(meta, body) {
  const runAtRaw = String(meta.runAt || 'document-end').toLowerCase().trim();
  let runAt = 'document-end';
  if (runAtRaw === 'document-start' || runAtRaw === 'start') runAt = 'document-start';
  else if (runAtRaw === 'document-idle' || runAtRaw === 'idle') runAt = 'document-idle';

  return {
    name: meta.name || '未命名脚本',
    namespace: meta.namespace || '',
    version: meta.version || '1.0.0',
    description: meta.description || '',
    author: meta.author || '',
    matches: meta.match || [],
    includes: meta.include || [],
    excludes: meta.exclude || [],
    excludeMatches: meta.excludeMatch || [],
    runAt,
    noframes: meta.noframes !== undefined && meta.noframes !== 'false',
    icon: meta.icon || '',
    homepage: meta.homepage || meta.website || '',
    requires: meta.require || [],
    resources: meta.resource || [],
    grants: meta.grant || [],
    updateURL: meta.updateurl || meta.updateURL || '',
    downloadURL: meta.downloadurl || meta.downloadURL || '',
    code: body || ''
  };
}

/** 脚本对象 → 元数据键值对列表（保持稳定的顺序） */
function scriptToHeaders(script) {
  const out = [];
  const push = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    out.push([key, value]);
  };

  push('name', script.name);
  push('namespace', script.namespace);
  push('version', script.version || '1.0.0');
  push('description', script.description);
  push('author', script.author);

  for (const m of script.matches || []) push('match', m);
  for (const m of script.includes || []) push('include', m);
  for (const m of script.excludes || []) push('exclude', m);
  for (const m of script.excludeMatches || []) push('exclude-match', m);
  for (const m of script.requires || []) push('require', m);
  for (const m of script.resources || []) push('resource', m);

  push('run-at', script.runAt || 'document-end');
  if (script.noframes) push('noframes', '');
  push('icon', script.icon);
  push('homepage', script.homepage);

  // 授权声明原样保留，方便脚本被搬去别的管理器时行为一致
  for (const g of script.grants || []) push('grant', g);

  return out;
}

/** 脚本对象 → 完整 .user.js 文本 */
function serializeUserscript(script) {
  const headers = scriptToHeaders(script);
  const width = headers.reduce((w, [k]) => Math.max(w, k.length), 0);

  const lines = ['// ==UserScript=='];
  for (const [key, value] of headers) {
    lines.push('// @' + key.padEnd(width) + (value ? '  ' + value : ''));
  }
  lines.push('// ==/UserScript==');
  lines.push('');
  lines.push(String(script.code || '').replace(/\s+$/, ''));
  lines.push('');

  return lines.join('\n');
}

/** 从脚本名生成安全的文件名 */
function safeFileName(name) {
  let base = String(name || 'script')
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\.+$/, '')
    .slice(0, 80);
  if (!base) base = 'script';
  if (!/\.user\.js$/i.test(base)) base += '.user.js';
  return base;
}

module.exports = {
  parseUserscript,
  metaToScript,
  serializeUserscript,
  scriptToHeaders,
  safeFileName
};
