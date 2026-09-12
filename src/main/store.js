'use strict';

/**
 * 脚本仓库。
 *
 * 设计取舍：不搞数据库，脚本目录本身就是唯一数据源。
 *
 *   <userData>/scripts/*.user.js   内部脚本：导入的、新建的，归软件管
 *   <外部目录>/*.user.js|*.js|*.txt 外部脚本：你原本放脚本的文件夹（比如桌面 2），
 *                                   软件只读监视、直接加载，不复制不改路径
 *   <userData>/state.json          只存「启用/禁用」这类不写回脚本文件的运行时状态
 *   <userData>/cache/deps/          @require / @resource 外链依赖的本地缓存
 *
 * 外部脚本的定位是「你自己的文件」：可以在软件里编辑（直接写回原文件），
 * 但不允许在软件里删除，免得误删你桌面上的东西。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const http = require('./http');
const {
  parseUserscript,
  metaToScript,
  serializeUserscript,
  safeFileName
} = require('./metadata');

/** 可导入的文件类型。.txt 常见于各种脚本站的分享，收下后统一转成 .user.js */
const ACCEPTED_EXTENSIONS = ['.js', '.txt'];

/** 外部脚本的 id 前缀，后面跟绝对路径 */
const EXTERNAL_PREFIX = 'ext|';

/** 内置脚本的 id 前缀（随软件加载） */
const BUILTIN_PREFIX = 'builtin|';

/** 内置脚本用这个 namespace 标记，界面据此显示「内置」徽章 */
const BUILTIN_NAMESPACE = 'soushu.builtin';

/**
 * 允许出现在左侧脚本列表里的内置脚本（按文件名匹配）。
 *
 * 默认所有内置脚本都完全隐藏，只在「脚本设置 → 内置脚本」里开关；
 * 但有些是「用户想随时一键停掉」的，把文件名加进来就会在左侧列表里多一个条目。
 * 它们仍然不是普通脚本：源码只读、不能删，随软件一同加载。
 */
const BUILTIN_IN_SIDEBAR = ['内置-自动回复.user.js'];

/**
 * 内置脚本（去广告 / 浮层修复 / 自动回复 / 附件重试）随软件一起提供，
 * 从安装目录直接加载，**不落盘到用户脚本目录** —— 这样升级软件就能一并更新，
 * 也不会和用户自己改过的版本混淆。旧版本复制进用户目录的副本会被自动清理。
 */
function builtinSourceDir() {
  return path.join(__dirname, '..', '..', 'builtin-scripts');
}

/** 单个外链依赖的体积上限，防止把页面拖垮 */
const DEP_MAX_BYTES = 3 * 1024 * 1024;

let scriptsDir = '';
let cacheDir = '';
let stateFile = '';
let settingsFile = '';

/** id -> { enabled: boolean } */
let state = {};
let settings = {};
let cache = [];

/** 依赖下载完成后通知外部（主进程拿去刷新注入与界面） */
let changeListener = null;

function onChange(fn) {
  changeListener = fn;
}

function notifyChanged() {
  if (typeof changeListener === 'function') {
    try {
      changeListener();
    } catch (e) {
      /* 通知失败不影响数据 */
    }
  }
}

// ---------------------------------------------------------------- 初始化

function defaultSettings() {
  return {
    // 论坛地址。空 = 还没配过，首次运行会引导填写
    forumUrl: '',
    // 启动就直接进论坛，而不是停在起始页
    openForumOnStart: true,
    // 站外链接交给系统浏览器，避免这个窗口变成通用浏览器
    externalLinksToSystem: true,
    // 点击右侧网页时自动收起左侧脚本面板（开机默认常驻展开）
    sidebarAutoCollapse: true,
    // 点附件链接时后台下载，不把帖子页顶掉；下载完自动刷新页面解锁隐藏内容
    autoDownloadAttachments: true,
    refreshAfterDownload: true,
    homeUrl: 'https://www.bing.com',
    autoReloadOnSave: true,
    // null = 自动判断；true = 强制开兼容模式；false = 强制关
    compatMode: null,
    // 外部脚本目录（绝对路径数组），软件会监视并直接加载其中的脚本
    extraScriptDirs: [],
    // 下载保存目录。空 = 自动（软件文件夹下的 Download）
    downloadDir: null,
    lastUrl: ''
  };
}

function init() {
  const base = app.getPath('userData');
  scriptsDir = path.join(base, 'scripts');
  cacheDir = path.join(base, 'cache', 'deps');
  stateFile = path.join(base, 'state.json');
  settingsFile = path.join(base, 'settings.json');

  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  state = readJson(stateFile, {});
  settings = Object.assign(defaultSettings(), readJson(settingsFile, {}));
  if (!Array.isArray(settings.extraScriptDirs)) settings.extraScriptDirs = [];

  removeLegacyBuiltinCopies();
  reload();
}

/**
 * 清理旧版本遗留在脚本目录里的内置脚本副本。
 *
 * 早期版本会把内置脚本复制进用户脚本目录（便于编辑），现在改成
 * 「随软件加载、界面里完全隐藏」，所以要把那些副本删掉，
 * 否则它们会混在用户脚本列表里。
 *
 * 只删「文件在脚本目录里」且「namespace 是我们自己的」的那些，动不到用户自己的脚本。
 */
function removeLegacyBuiltinCopies() {
  let files = [];
  try {
    files = fs.readdirSync(scriptsDir);
  } catch (e) {
    return 0;
  }

  let removed = 0;
  for (const file of files) {
    const full = path.join(scriptsDir, file);
    try {
      if (!fs.statSync(full).isFile()) continue;
      const { meta } = parseUserscript(fs.readFileSync(full, 'utf8'));
      if (!meta || meta.namespace !== BUILTIN_NAMESPACE) continue;
      fs.unlinkSync(full);
      delete state[file];
      removed += 1;
    } catch (e) {
      /* 单个文件失败不影响其它 */
    }
  }

  if (removed) {
    writeJson(stateFile, state);
    console.log('[搜书吧] 已清理 ' + removed + ' 个旧的内置脚本副本');
  }
  return removed;
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[搜书吧] 写入失败 ' + file, e);
    return false;
  }
}

// ---------------------------------------------------------------- 目录

function scriptsDirectory() {
  return scriptsDir;
}

function cacheDirectory() {
  return cacheDir;
}

/** 当前生效的外部目录（过滤掉已不存在的） */
function externalDirs() {
  return settings.extraScriptDirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch (e) {
      return false;
    }
  });
}

/** 主目录 + 全部外部目录 */
function allDirs() {
  return [{ dir: scriptsDir, source: 'internal' }]
    .concat(externalDirs().map((dir) => ({ dir, source: 'external' })))
    .concat([{ dir: builtinSourceDir(), source: 'builtin' }]);
}

function isBuiltin(id) {
  return String(id || '').indexOf(BUILTIN_PREFIX) === 0;
}

function isExternal(id) {
  return String(id || '').indexOf(EXTERNAL_PREFIX) === 0;
}

/** id → 绝对路径 */
function resolvePath(id) {
  if (isExternal(id)) return String(id).slice(EXTERNAL_PREFIX.length);
  return path.join(scriptsDir, String(id));
}

function makeId(filePath, source) {
  if (source === 'external') return EXTERNAL_PREFIX + filePath;
  if (source === 'builtin') return BUILTIN_PREFIX + path.basename(filePath);
  return path.basename(filePath);
}

// ---------------------------------------------------------------- 依赖缓存

function depHash(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex');
}

function depCacheFile(url) {
  return path.join(cacheDir, depHash(url) + '.js');
}

function readDepCache(url) {
  try {
    return fs.readFileSync(depCacheFile(url), 'utf8');
  } catch (e) {
    return null;
  }
}

/** @resource 的值形如「名字 地址」，拆开 */
function parseResourceEntry(entry) {
  const text = String(entry || '').trim();
  const spaceAt = text.search(/\s/);
  if (spaceAt === -1) return { name: text, url: '' };
  return { name: text.slice(0, spaceAt), url: text.slice(spaceAt).trim() };
}

// ---------------------------------------------------------------- 读取

function safeStat(file) {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtime: s.mtimeMs };
  } catch (e) {
    return { size: 0, mtime: 0 };
  }
}

function stripScriptExt(fileName) {
  return String(fileName)
    .replace(/\.user\.js$/i, '')
    .replace(/\.(js|txt)$/i, '');
}

function reload() {
  const list = [];

  for (const { dir, source } of allDirs()) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }

    for (const file of files) {
      if (!ACCEPTED_EXTENSIONS.includes(path.extname(file).toLowerCase())) continue;

      const full = path.join(dir, file);
      let content = '';
      try {
        if (!fs.statSync(full).isFile()) continue;
        content = fs.readFileSync(full, 'utf8');
      } catch (e) {
        continue;
      }

      const id = makeId(full, source);
      const { meta, body } = parseUserscript(content);
      const script = metaToScript(meta, body);
      const stat = safeStat(full);

      script.id = id;
      script.file = file;
      script.path = full;
      script.source = source;
      script.size = stat.size;
      script.updatedAt = stat.mtime;
      script.enabled = state[id] ? state[id].enabled !== false : true;
      script.isPlain = !meta.name;
      script.builtin = source === 'builtin' || script.namespace === BUILTIN_NAMESPACE;
      // 极少数内置脚本（如自动回复）要在左侧列表里露脸，带个开关方便随手停
      script.showInSidebar =
        source === 'builtin' && BUILTIN_IN_SIDEBAR.indexOf(path.basename(file)) >= 0;

      // 把依赖内容从缓存读进来，注入时直接内联，不用每次现取
      script.requiresText = [];
      script.missingDeps = [];
      for (const url of script.requires) {
        const text = readDepCache(url);
        if (text === null) script.missingDeps.push(url);
        else script.requiresText.push({ url, text });
      }

      script.resourceMap = {};
      for (const entry of script.resources) {
        const { name, url } = parseResourceEntry(entry);
        if (!url) continue;
        const text = readDepCache(url);
        if (text === null) script.missingDeps.push(url);
        else script.resourceMap[name] = text;
      }

      list.push(script);
    }
  }

  list.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.source !== b.source) return a.source === 'internal' ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), 'zh-CN');
  });

  cache = list;
  return cache;
}

/**
 * 界面用的列表。
 * 内置脚本默认隐藏，只有 BUILTIN_IN_SIDEBAR 里点名的才出现在这里。
 */
function list() {
  return cache.filter((s) => s.source !== 'builtin' || s.showInSidebar);
}

/** 左侧列表里露脸的内置脚本（用于日志与自检说明） */
function sidebarBuiltins() {
  return cache.filter((s) => s.source === 'builtin' && s.showInSidebar);
}

/** 全量（含内置），内部与测试用 */
function allList() {
  return cache;
}

/** 内置脚本（脚本设置里给开关用） */
function builtinList() {
  return cache.filter((s) => s.source === 'builtin');
}

function get(id) {
  return cache.find((s) => s.id === id) || null;
}

function enabled() {
  return cache.filter((s) => s.enabled);
}

/** 供注入引擎用的精简结构 */
function injectionPayload() {
  return enabled().map((s) => ({
    id: s.id,
    name: s.name,
    version: s.version,
    runAt: s.runAt,
    noframes: !!s.noframes,
    matches: s.matches,
    includes: s.includes,
    excludes: s.excludes,
    excludeMatches: s.excludeMatches,
    grants: s.grants,
    requiresText: s.requiresText,
    resourceMap: s.resourceMap,
    code: s.code
  }));
}

// ---------------------------------------------------------------- 写入

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * 新增或更新脚本。
 * - 带 id 且是内部脚本 → 覆盖原文件
 * - 带 id 且是外部脚本 → 直接写回原路径（保留原后缀）
 * - 无 id → 按脚本名在内部目录新建
 */
function save(data) {
  const name = String(data.name || '').trim() || '未命名脚本';
  const editingExternal = data.id && isExternal(data.id) && fs.existsSync(resolvePath(data.id));

  let targetPath = '';
  if (editingExternal) {
    targetPath = resolvePath(data.id);
  } else if (data.id && fs.existsSync(resolvePath(data.id))) {
    targetPath = resolvePath(data.id);
  } else {
    const base = safeFileName(name);
    let candidate = base;
    let i = 2;
    while (fs.existsSync(path.join(scriptsDir, candidate))) {
      candidate = base.replace(/\.user\.js$/i, '') + '-' + i + '.user.js';
      i += 1;
    }
    targetPath = path.join(scriptsDir, candidate);
  }

  const script = {
    name,
    namespace: data.namespace || '',
    version: data.version || '1.0.0',
    description: data.description || '',
    author: data.author || '',
    matches: normalizeList(data.matches || data.match),
    includes: normalizeList(data.includes || data.include),
    excludes: normalizeList(data.excludes || data.exclude),
    excludeMatches: normalizeList(data.excludeMatches),
    requires: normalizeList(data.requires),
    resources: normalizeList(data.resources),
    grants: normalizeList(data.grants),
    runAt: data.runAt || 'document-end',
    noframes: !!data.noframes,
    icon: data.icon || '',
    homepage: data.homepage || '',
    code: String(data.code || '')
  };

  fs.writeFileSync(targetPath, serializeUserscript(script), 'utf8');

  const id = makeId(targetPath, editingExternal ? 'external' : 'internal');
  if (state[id] === undefined) {
    state[id] = { enabled: true };
    writeJson(stateFile, state);
  }

  reload();
  return get(id);
}

function remove(id) {
  const script = get(id);

  if (isBuiltin(id)) {
    return { ok: false, error: '内置脚本随软件提供，不能删除。想停用可以在「脚本设置」里关掉。' };
  }

  if (isExternal(id)) {
    return {
      ok: false,
      error: '「' + (script ? script.name : '该脚本') + '」在外部目录里，软件不会删除你自己的文件。请到文件夹里删。'
    };
  }

  const full = resolvePath(id);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  delete state[id];
  writeJson(stateFile, state);
  reload();
  return { ok: true };
}

function setEnabled(id, isEnabled) {
  if (!get(id)) return { ok: false, error: '脚本不存在' };
  state[id] = Object.assign({}, state[id], { enabled: !!isEnabled });
  writeJson(stateFile, state);
  reload();
  return { ok: true };
}

// ---------------------------------------------------------------- 导入

/**
 * 从任意路径导入脚本文件（文件或文件夹）。
 * 支持 .js / .user.js / .txt，统一补元数据头后落库成 <脚本名>.user.js。
 */
function importPaths(paths) {
  const result = { imported: [], skipped: [], errors: [], converted: [] };

  const walk = (p) => {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      result.errors.push(p + ' 无法读取');
      return;
    }

    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(p);
      } catch (e) {
        result.errors.push(p + ' 目录无法读取');
        return;
      }
      for (const entry of entries) walk(path.join(p, entry));
      return;
    }

    const base = path.basename(p);
    const ext = path.extname(base).toLowerCase();

    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      result.skipped.push(base + ' 格式不支持（收 .js / .txt）');
      return;
    }

    let content;
    try {
      content = fs.readFileSync(p, 'utf8');
    } catch (e) {
      result.errors.push(base + ' 读取失败');
      return;
    }

    const { meta, body } = parseUserscript(content);
    const name = meta.name || stripScriptExt(base);
    const fromTxt = ext === '.txt';

    let candidate = safeFileName(name);
    let i = 2;
    while (fs.existsSync(path.join(scriptsDir, candidate))) {
      candidate = safeFileName(name).replace(/\.user\.js$/i, '') + '-' + i + '.user.js';
      i += 1;
    }

    const script = metaToScript(meta, body);
    script.name = name;
    script.matches = normalizeList(script.matches);
    script.includes = normalizeList(script.includes);

    if (!script.matches.length && !script.includes.length) {
      script.matches = ['*://*/*'];
      script.description = script.description || '导入时未发现 @match 规则，已默认匹配所有网站';
    }

    if (fromTxt) {
      const note = '由 ' + base + ' 转换而来';
      script.description = script.description ? script.description + '（' + note + '）' : note;
    }

    try {
      fs.writeFileSync(path.join(scriptsDir, candidate), serializeUserscript(script), 'utf8');
    } catch (e) {
      result.errors.push(base + ' 写入失败');
      return;
    }

    state[candidate] = { enabled: true };
    result.imported.push(name);
    if (fromTxt) result.converted.push(base + ' → ' + candidate);
  };

  for (const p of paths || []) walk(p);

  writeJson(stateFile, state);
  reload();
  return result;
}

// ---------------------------------------------------------------- 外部目录管理

function addExternalDir(dir) {
  const target = path.resolve(String(dir || ''));
  if (!target) return { ok: false, error: '路径为空' };

  try {
    if (!fs.statSync(target).isDirectory()) return { ok: false, error: '不是文件夹' };
  } catch (e) {
    return { ok: false, error: '文件夹不存在或无法访问' };
  }

  if (settings.extraScriptDirs.some((d) => path.resolve(d) === target)) {
    return { ok: false, error: '这个目录已经在列表里了' };
  }

  settings.extraScriptDirs.push(target);
  writeJson(settingsFile, settings);
  reload();
  return { ok: true, dirs: settings.extraScriptDirs, count: cache.filter((s) => s.source === 'external').length };
}

function removeExternalDir(dir) {
  const target = path.resolve(String(dir || ''));
  settings.extraScriptDirs = settings.extraScriptDirs.filter((d) => path.resolve(d) !== target);
  writeJson(settingsFile, settings);
  reload();
  return { ok: true, dirs: settings.extraScriptDirs };
}

// ---------------------------------------------------------------- 依赖下载

/**
 * 把尚未缓存的 @require / @resource 拉下来。
 * 完成后重新读取脚本并通知外部刷新。
 */
async function ensureExternalDeps() {
  reload();

  const pending = new Map(); // url -> true
  for (const script of cache) {
    for (const url of script.missingDeps) pending.set(url, true);
  }

  if (!pending.size) return { downloaded: 0, failed: [] };

  const urls = Array.from(pending.keys());
  const failed = [];
  let downloaded = 0;

  // 小批量并发，别一次把网络打满
  const CONCURRENCY = 4;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (url) => {
        try {
          const res = await http.request({ url, timeout: 20000, maxBytes: DEP_MAX_BYTES });
          if (!res.ok && res.status >= 400) {
            failed.push({ url, reason: 'HTTP ' + res.status });
            return;
          }
          const target = depCacheFile(url);
          // 目录可能被用户或清理工具删掉，写之前再保证一次
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, res.responseText, 'utf8');
          downloaded += 1;
        } catch (e) {
          failed.push({
            url,
            reason: String((e && e.message) || e),
            cacheDir,
            dirExists: fs.existsSync(cacheDir),
            target: depCacheFile(url)
          });
        }
      })
    );
  }

  reload();

  if (downloaded) {
    console.log('[搜书吧] 已缓存 ' + downloaded + ' 个外链依赖');
    notifyChanged();
  }
  if (failed.length) {
    console.warn('[搜书吧] ' + failed.length + ' 个外链依赖下载失败：' + failed.map((f) => f.url).join('、'));
  }

  return { downloaded, failed };
}

/** 清空依赖缓存，下次用到的会重新下载 */
function clearDepCache() {
  let count = 0;
  try {
    for (const file of fs.readdirSync(cacheDir)) {
      fs.unlinkSync(path.join(cacheDir, file));
      count += 1;
    }
  } catch (e) {
    /* ignore */
  }
  reload();
  return { ok: true, removed: count };
}

// ---------------------------------------------------------------- 设置

function getSettings() {
  return Object.assign({}, defaultSettings(), settings);
}

function setSettings(patch) {
  settings = Object.assign({}, defaultSettings(), settings, patch || {});
  if (!Array.isArray(settings.extraScriptDirs)) settings.extraScriptDirs = [];
  writeJson(settingsFile, settings);
  return getSettings();
}

module.exports = {
  init,
  reload,
  list,
  allList,
  builtinList,
  sidebarBuiltins,
  isBuiltin,
  get,
  enabled,
  injectionPayload,
  save,
  remove,
  setEnabled,
  importPaths,
  builtinSourceDir,
  addExternalDir,
  removeExternalDir,
  externalDirs,
  allDirs,
  isExternal,
  resolvePath,
  ensureExternalDeps,
  clearDepCache,
  getSettings,
  setSettings,
  scriptsDirectory,
  cacheDirectory,
  onChange
};
