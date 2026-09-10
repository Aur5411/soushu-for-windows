'use strict';

/* ==========================================================================
   搜书吧电脑版 — 渲染进程
   ========================================================================== */

const api = window.scriptdock;

const state = {
  version: '1.0.0',
  scripts: [],
  scriptsDir: '',
  cacheDir: '',
  settings: {},
  tabs: [],
  activeId: null,
  compat: null,
  forum: null,
  externalDirs: [],
  download: null,
  historyCount: 0,
  historyItems: [],
  historyKeyword: '',
  menuCommands: [],
  editingId: null,
  matchedIds: [],
  addressFocused: false,
  dragDepth: 0
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 启动

async function init() {
  const info = await api.getInfo();
  state.version = info.version;
  state.scriptsDir = info.scriptsDir || '';
  state.cacheDir = info.cacheDir || '';
  state.settings = info.settings || {};
  state.compat = info.compat || null;

  $('verText').textContent = 'v' + info.version;

  state.scripts = await api.listScripts();
  renderList();

  bindUi();
  setupContentBounds();

  api.on('tabs:state', onTabsState);
  api.on('scripts:changed', (list) => {
    state.scripts = list;
    renderList();
    refreshMatchBadge();
  });
  api.on('settings:changed', (s) => {
    state.settings = Object.assign({}, state.settings, s || {});
  });
  api.on('menus:state', (payload) => {
    state.menuCommands = (payload && payload.commands) || [];
  });
  api.on('ui:toast', (t) => toast(t.message, t.kind));
  api.on('ui:focus-address', focusAddress);
  api.on('ui:page-focused', () => scheduleCollapse(300));
  api.on('download:done', () => refreshDownloadInfo());
  api.on('history:changed', (payload) => {
    state.historyCount = (payload && payload.count) || 0;
    renderHistoryInfo();
  });

  await refreshSettings();
  await refreshDownloadInfo();
  await refreshHistoryInfo();

  const pinned = !state.settings.sidebarAutoCollapse;
  if (pinned) {
    $('railPin').textContent = '⇤';
    $('railPin').title = '恢复自动收起';
  }
  scheduleCollapse(2600);
}

// ---------------------------------------------------------------- 提示

let statusTimer = null;

/**
 * 提示统一走底部状态栏。
 * 不能用浮层：网页区域是原生图层，永远盖在 DOM 之上，
 * 侧边栏收起后浮层伸出去的部分会被网页吃掉。
 */
function toast(message, kind) {
  const el = $('statusMsg');
  const text = String(message == null ? '' : message);

  el.textContent = text;
  el.title = text;
  el.className = 'status-msg ' + (kind === 'ok' ? 'ok' : kind === 'error' ? 'error' : 'info');

  clearTimeout(statusTimer);
  statusTimer = setTimeout(
    () => {
      el.textContent = '';
      el.title = '';
      el.className = 'status-msg';
    },
    kind === 'error' ? 6000 : 3500
  );
}

// ---------------------------------------------------------------- 网页视图区域

let pushContentBounds = () => {};

function setupContentBounds() {
  const area = $('contentArea');

  const push = () => {
    const r = area.getBoundingClientRect();
    api.view.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  };

  pushContentBounds = push;

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(push).observe(area);
  }
  window.addEventListener('resize', push);
  requestAnimationFrame(push);
  setTimeout(push, 120);
  setTimeout(push, 600);
}

/** 抽屉打开时要让出原生视图，否则会被盖住 */
function setPageVisible(visible) {
  api.view.setVisible(visible);
}

// ---------------------------------------------------------------- 脚本列表

function domainOf(pattern) {
  const m = /^[a-z*]+:\/\/(?:[^/]*@)?([^/]+)/i.exec(String(pattern || ''));
  if (m) return m[1];
  if (String(pattern || '').startsWith('/')) return '正则';
  return String(pattern || '');
}

function rulesLabel(script) {
  const all = (script.matches || []).concat(script.includes || []);
  if (!all.length) return '未配置匹配规则';
  const shown = all.slice(0, 2).map(domainOf).join(' · ');
  return all.length > 2 ? shown + ' +' + (all.length - 2) : shown;
}

function renderList() {
  const list = $('scriptList');
  const enabledCount = state.scripts.filter((s) => s.enabled).length;

  $('summary').textContent = `共 ${state.scripts.length} 个脚本 · 启用 ${enabledCount} 个`;

  list.textContent = '';

  if (!state.scripts.length) {
    const empty = document.createElement('li');
    empty.className = 'side-summary';
    empty.style.padding = '14px 8px';
    empty.textContent = '还没有脚本。点上面的「导入脚本」把 .user.js / .js / .txt 加进来。';
    list.appendChild(empty);
    return;
  }

  for (const s of state.scripts) {
    const li = document.createElement('li');
    li.className = 'script-item' + (s.enabled ? '' : ' off');
    li.dataset.id = s.id;

    const top = document.createElement('div');
    top.className = 'script-item-top';

    const name = document.createElement('div');
    name.className = 'script-name';
    name.textContent = s.name;
    name.title = s.name + (s.description ? '\n' + s.description : '');

    const isBuiltin = s.source === 'builtin';

    const edit = document.createElement('button');
    edit.className = 'small-btn';
    edit.textContent = isBuiltin ? '源码' : '编辑';
    edit.title = isBuiltin ? '查看内置脚本源码（只读）' : '打开编辑器修改脚本内容';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(s);
    });

    const sw = document.createElement('button');
    sw.className = 'switch' + (s.enabled ? ' on' : '');
    sw.title = s.enabled ? '点击停用' : '点击启用';
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleScript(s, sw);
    });

    top.appendChild(name);
    if (s.source === 'external') {
      const badge = document.createElement('span');
      badge.className = 'script-badge';
      badge.textContent = '外部';
      badge.title = '来自外部目录：' + (s.path || '');
      top.appendChild(badge);
    } else if (isBuiltin) {
      const badge = document.createElement('span');
      badge.className = 'script-badge builtin';
      badge.textContent = '内置';
      badge.title = '随软件提供：能开关、能看源码，但不能改也不能删';
      top.appendChild(badge);
    }
    top.appendChild(edit);
    top.appendChild(sw);

    const rules = document.createElement('div');
    rules.className = 'script-rules';
    if (state.matchedIds.includes(s.id)) {
      const hit = document.createElement('span');
      hit.className = 'hit';
      hit.textContent = '● 已在此页生效';
      rules.appendChild(hit);
    } else {
      rules.textContent = rulesLabel(s);
    }

    li.appendChild(top);
    li.appendChild(rules);
    li.addEventListener('click', () => openEditor(s));
    list.appendChild(li);
  }
}

async function toggleScript(script, btn) {
  const next = !script.enabled;
  btn.classList.toggle('on', next);
  const res = await api.setScriptEnabled(script.id, next);
  if (!res || !res.ok) {
    btn.classList.toggle('on', !next);
    toast((res && res.error) || '操作失败', 'error');
    return;
  }
  toast(`已${next ? '启用' : '停用'}「${script.name}」`, 'ok');
}

// ---------------------------------------------------------------- 内置脚本（不出现在列表里）

// ---------------------------------------------------------------- 标签页

function onTabsState(payload) {
  state.tabs = payload.tabs || [];
  state.activeId = payload.activeId;
  renderTabs();
  syncAddressBar();
  refreshMatchBadge();
}

function renderTabs() {
  const strip = $('tabStrip');
  strip.textContent = '';

  for (const t of state.tabs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t.id === state.activeId ? ' active' : '');
    tab.title = t.title + '\n' + t.url;

    if (t.loading) {
      const sp = document.createElement('div');
      sp.className = 'tab-spinner';
      tab.appendChild(sp);
    }

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = t.title || '新标签页';
    tab.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭标签页 (Ctrl+W)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      api.tabs.close(t.id);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => api.tabs.activate(t.id));
    strip.appendChild(tab);
  }

  const add = document.createElement('button');
  add.className = 'tab-new';
  add.textContent = '+';
  add.title = '新标签页 (Ctrl+T)';
  add.addEventListener('click', () => api.tabs.create('scriptdock://start'));
  strip.appendChild(add);
}

function syncAddressBar() {
  if (state.addressFocused) return;
  const tab = state.tabs.find((t) => t.id === state.activeId);
  $('addressBar').value = tab ? tab.url || '' : '';
}

async function refreshMatchBadge() {
  const tab = state.tabs.find((t) => t.id === state.activeId);
  const url = tab ? tab.url : '';

  if (!url || url.startsWith('scriptdock://') || url === 'about:blank') {
    state.matchedIds = [];
    renderList();
    return;
  }

  try {
    state.matchedIds = (await api.matchUrl(url)) || [];
  } catch (e) {
    state.matchedIds = [];
  }

  renderList();
}


// ---------------------------------------------------------------- 侧边栏自动收起

let sidebarTimer = null;

function anyOverlayOpen() {
  return (
    $('drawer').classList.contains('open') ||
    $('settingsDrawer').classList.contains('open') ||
    $('downloadsDrawer').classList.contains('open') ||
    $('historyDrawer').classList.contains('open')
  );
}

function setSidebarCollapsed(collapsed) {
  document.querySelector('.app').classList.toggle('sidebar-collapsed', !!collapsed);

  // 侧栏宽度是 CSS 过渡出来的，但右边那块网页是**原生图层**，它不会自己跟着动。
  // 以前只在 200ms 后补报一次尺寸 —— 整个过渡过程中视图和侧栏是错位的，
  // 看起来就像动画「跳」了一下。这里改成逐帧上报，跟过渡时长对齐。
  requestAnimationFrame(() => {
    pushContentBounds();
    syncBoundsDuring(200);
  });
}

/** 过渡期间逐帧上报内容区尺寸，让原生视图跟得上 CSS 动画 */
function syncBoundsDuring(ms) {
  const t0 = performance.now();
  const step = () => {
    pushContentBounds();
    if (performance.now() - t0 < ms) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function expandSidebar() {
  clearTimeout(sidebarTimer);
  setSidebarCollapsed(false);
}

function scheduleCollapse(delay) {
  if (!state.settings.sidebarAutoCollapse) return;
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(
    () => {
      if (anyOverlayOpen()) return;
      setSidebarCollapsed(true);
    },
    delay === undefined ? 1000 : delay
  );
}

async function toggleSidebarPin() {
  const next = !state.settings.sidebarAutoCollapse;
  state.settings.sidebarAutoCollapse = next;
  await api.setSettings({ sidebarAutoCollapse: next });

  const pin = $('railPin');
  pin.textContent = next ? '⇥' : '⇤';
  pin.title = next ? '固定展开（关掉自动收起）' : '恢复自动收起';

  if (next) {
    toast('已恢复：脚本面板不用时自动收起', 'ok');
    scheduleCollapse(1500);
  } else {
    expandSidebar();
    toast('已固定展开，面板不再自动收起', 'ok');
  }
}

// ---------------------------------------------------------------- 抽屉通用

function openDrawer(id, focusId) {
  const el = $(id);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');

  const mask = $(id.replace('Drawer', 'Mask'));
  if (mask) mask.classList.add('show');

  setPageVisible(false);
  if (focusId) setTimeout(() => $(focusId).focus(), 220);
}

function closeDrawer(id) {
  const el = $(id);
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');

  const mask = $(id.replace('Drawer', 'Mask'));
  if (mask) mask.classList.remove('show');

  if (!$('drawer').classList.contains('open') && !anyOverlayOpen()) {
    setPageVisible(true);
  }
}

// ---------------------------------------------------------------- 设置（网站 / 下载位置 / 历史记录）

async function refreshSettings() {
  const [info, settings] = await Promise.all([api.forum.get(), api.getSettings()]);
  state.forum = info;
  state.settings = Object.assign({}, state.settings, settings || {});

  $('fForumUrl').value = info.url || '';
  $('fOpenOnStart').checked = state.settings.openForumOnStart !== false;
  $('fExternalLinks').checked = state.settings.externalLinksToSystem !== false;

  const box = $('forumInfo');
  box.textContent = '';

  for (const line of [
    '论坛地址：' + (info.url || '（未设置，用内置入口 ' + info.defaultEntry + '）'),
    '站点根：' + (info.origin || '（未设置）'),
    '脚本目录：' + (state.scriptsDir || '—'),
    '依赖缓存：' + (state.cacheDir || '—')
  ]) {
    const div = document.createElement('div');
    div.textContent = line;
    box.appendChild(div);
  }

  $('cachePath').textContent = state.cacheDir || '—';
  $('cachePath').title = state.cacheDir || '';

  if (state.compat) updateCompatButton();

  $('btnHome').title = info.url ? '回到论坛：' + info.url : '回到论坛（内置入口）';
}

async function saveForum() {
  const raw = $('fForumUrl').value.trim();
  const res = await api.forum.set(raw, { navigate: !!raw });

  if (!raw) {
    toast('已清空论坛地址，启动时会从内置入口走', 'ok');
    closeDrawer('settingsDrawer');
    return;
  }
  if (!res || !res.ok) {
    toast('地址保存失败', 'error');
    return;
  }
  toast('已保存，正在前往 ' + (res.url || raw), 'ok');
  closeDrawer('settingsDrawer');
}

// ---------------------------------------------------------------- 排障（兼容模式 / 日志）

/** 兼容模式：自动 → 强制开 → 强制关 → 自动 */
function updateCompatButton() {
  const mode = (state.compat && state.compat.mode) || 'auto';
  const enabled = !!(state.compat && state.compat.enabled);
  const label = mode === 'on' ? '强制开启' : mode === 'off' ? '强制关闭' : '自动';
  const btn = $('btnCompat');
  if (!btn) return;
  btn.textContent = '兼容模式：' + label;
  btn.classList.toggle('active', enabled);
  btn.title = enabled
    ? '当前正跑在兼容模式下（无沙箱 + 软件渲染）· 点击切换'
    : '点击切换。软件打不开时才需要改成「强制开启」';
}

async function cycleCompatMode() {
  const current = (state.compat && state.compat.mode) || 'auto';
  const order = ['auto', 'on', 'off'];
  const next = order[(order.indexOf(current) + 1) % order.length];

  await api.setCompatMode(next === 'auto' ? null : next === 'on');
  if (state.compat) state.compat.mode = next;
  updateCompatButton();

  const label = next === 'auto' ? '自动判断' : next === 'on' ? '强制开启' : '强制关闭';
  toast(`兼容模式：${label}，重启软件后生效`, 'info');
}

// ---------------------------------------------------------------- 下载

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function formatTime(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

async function refreshDownloadInfo() {
  try {
    const info = await api.download.info();
    state.download = info;
    $('dlPath').textContent = info.dir || '—';
    $('dlPath').title = info.dir || '';
    $('dlCount').textContent = String(info.count || 0);

    const bits = [];
    if (info.custom) bits.push('自定义');
    else if (info.portable) bits.push('便携版：exe 所在文件夹');
    else bits.push('默认位置');
    bits.push(info.count + ' 个文件');
    $('dlMeta').textContent = bits.join(' · ');
  } catch (e) {
    $('dlPath').textContent = '读取失败';
  }
}

async function openDownloads() {
  await refreshDownloads();
  openDrawer('downloadsDrawer');
}

async function refreshDownloads() {
  const data = await api.download.list();
  const files = data.files || [];

  $('dlPanelPath').textContent = data.dir || '—';
  $('dlPanelPath').title = data.dir || '';
  $('dlPanelMeta').textContent = files.length + ' 个文件';
  $('dlCount').textContent = String(files.length);

  const list = $('dlList');
  list.textContent = '';

  if (!files.length) {
    const li = document.createElement('li');
    li.className = 'dl-empty';
    li.textContent = '还没有下载任何文件。在帖子页点附件就会自动下到这里。';
    list.appendChild(li);
    return;
  }

  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'dl-item';

    const isText = /\.(txt|text|md)$/i.test(f.name);
    li.title = '点击打开：' + f.path + (isText ? '（用记事本打开）' : '');

    const main = document.createElement('div');
    main.className = 'dl-item-main';

    const name = document.createElement('div');
    name.className = 'dl-item-name';
    name.textContent = f.name;

    const meta = document.createElement('div');
    meta.className = 'dl-item-meta';
    meta.textContent = formatSize(f.size) + ' · ' + formatTime(f.mtime);

    main.appendChild(name);
    main.appendChild(meta);

    const reveal = document.createElement('button');
    reveal.className = 'small-btn';
    reveal.textContent = '定位';
    reveal.title = '在资源管理器中选中这个文件';
    reveal.addEventListener('click', (e) => {
      e.stopPropagation();
      api.download.reveal(f.path);
    });

    li.appendChild(main);
    li.appendChild(reveal);
    li.addEventListener('click', async () => {
      const res = await api.download.openFile(f.path);
      if (!res || !res.ok) toast('打不开：' + ((res && res.error) || '未知原因'), 'error');
    });

    list.appendChild(li);
  }
}

async function chooseDownloadDir() {
  const res = await api.download.choose();
  if (!res || res.canceled) return;
  toast('下载目录已改为：' + res.dir, 'ok');
  await refreshDownloadInfo();
  if ($('downloadsDrawer').classList.contains('open')) await refreshDownloads();
}

async function resetDownloadDir() {
  const res = await api.download.reset();
  toast('下载目录已恢复默认：' + ((res && res.dir) || ''), 'ok');
  await refreshDownloadInfo();
}

// ---------------------------------------------------------------- 历史记录

async function refreshHistoryInfo() {
  const data = await api.history.list();
  state.historyCount = (data.items || []).length;
  renderHistoryInfo();
}

function renderHistoryInfo() {
  const box = $('historyInfo');
  if (!box) return;
  box.textContent = '已记录 ' + state.historyCount + ' 条浏览记录（最多保留 2000 条）';
}

async function openHistory() {
  state.historyKeyword = '';
  $('historySearch').value = '';
  await refreshHistory();
  openDrawer('historyDrawer');
}

async function refreshHistory() {
  const data = await api.history.list(state.historyKeyword);
  state.historyItems = data.items || [];
  state.historyCount = data.total || state.historyItems.length;
  renderHistoryInfo();

  const list = $('historyList');
  list.textContent = '';

  if (!state.historyItems.length) {
    const li = document.createElement('li');
    li.className = 'dl-empty';
    li.textContent = state.historyKeyword ? '没有匹配的记录。' : '还没有浏览记录。';
    list.appendChild(li);
    return;
  }

  for (const it of state.historyItems) {
    const li = document.createElement('li');
    li.className = 'dl-item';
    li.title = it.url;

    const main = document.createElement('div');
    main.className = 'dl-item-main';

    const name = document.createElement('div');
    name.className = 'dl-item-name';
    name.textContent = it.title || it.url;

    const meta = document.createElement('div');
    meta.className = 'dl-item-meta';
    meta.textContent = formatTime(it.at) + ' · ' + it.url;

    main.appendChild(name);
    main.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'small-btn';
    del.textContent = '删除';
    del.title = '从历史里删掉这一条';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.history.remove(it.url);
      await refreshHistory();
    });

    li.appendChild(main);
    li.appendChild(del);
    li.addEventListener('click', () => {
      api.tabs.navigate(state.activeId, it.url);
      closeDrawer('historyDrawer');
    });

    list.appendChild(li);
  }
}

async function clearHistory() {
  const res = await api.history.clear();
  toast('已清空 ' + ((res && res.removed) || 0) + ' 条历史记录', 'ok');
  await refreshHistoryInfo();
  if ($('historyDrawer').classList.contains('open')) await refreshHistory();
}

// ---------------------------------------------------------------- 脚本编辑器

/**
 * 生成脚本的元数据头文本。
 * 格式与主进程写文件时保持一致，这样编辑器里看到的就是磁盘上的原文。
 */
function buildHeaderText(script) {
  const src = script || {};
  const rows = [];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    rows.push([k, String(v)]);
  };

  push('name', src.name);
  push('namespace', src.namespace);
  push('version', src.version || '1.0.0');
  push('description', src.description);
  push('author', src.author);
  for (const m of src.matches || []) push('match', m);
  for (const m of src.includes || []) push('include', m);
  for (const m of src.excludes || []) push('exclude', m);
  for (const m of src.excludeMatches || []) push('exclude-match', m);
  for (const m of src.requires || []) push('require', m);
  for (const m of src.resources || []) push('resource', m);
  push('run-at', src.runAt || 'document-end');
  if (src.noframes) push('noframes', '');
  push('icon', src.icon);
  push('homepage', src.homepage);

  const width = rows.reduce((w, r) => Math.max(w, r[0].length), 0);
  const lines = ['// ==UserScript=='];
  for (const [k, v] of rows) lines.push('// @' + k.padEnd(width) + (v ? '  ' + v : ''));
  lines.push('// ==/UserScript==');
  return lines.join('\n');
}

/** 完整源码 = 元数据头 + 正文：编辑器里要看到全部，包括开头那一段头 */
function buildFullSource(script) {
  const body = String((script && script.code) || '').replace(/\s+$/, '');
  return buildHeaderText(script) + '\n\n' + body + '\n';
}

function openEditor(script) {
  state.editingId = script ? script.id : null;
  const isBuiltin = !!(script && script.source === 'builtin');

  $('drawerTitle').textContent = !script ? '新建脚本' : isBuiltin ? '查看内置脚本' : '编辑脚本';
  $('fName').value = script ? script.name : '';
  // 显示完整源码（含开头的 ==UserScript== 元数据块）
  $('fCode').value = script ? buildFullSource(script) : '';

  const note = $('fSourceNote');
  const isExternal = !!(script && script.source === 'external');
  if (isExternal) {
    note.hidden = false;
    note.className = 'src-note warn';
    note.textContent =
      '这个脚本来自外部目录，是你的原始文件：' + script.path +
      '。保存会直接写回该文件；要删除请到文件夹里操作。';
  } else if (isBuiltin) {
    note.hidden = false;
    note.className = 'src-note';
    note.textContent =
      '软件自带的内置脚本，源码只读（升级软件时会跟着一起更新）。要停用它请点左侧那行的开关。';
  } else if (script) {
    note.hidden = false;
    note.className = 'src-note';
    note.textContent = '保存在：' + (script.path || '');
  } else {
    note.hidden = true;
  }

  // 内置脚本只读：它装在软件包里，写回去会写坏安装文件
  // （save() 会把它当成普通脚本落到脚本目录，生成一个名字带「|」的怪文件）
  $('fName').readOnly = isBuiltin;
  $('fCode').readOnly = isBuiltin;
  $('btnSave').style.display = isBuiltin ? 'none' : '';

  $('btnDelete').style.visibility = script && !isBuiltin ? 'visible' : 'hidden';
  $('btnDelete').disabled = isExternal || isBuiltin;
  $('btnDelete').title = isBuiltin
    ? '内置脚本不能删除'
    : isExternal
      ? '外部目录里的脚本不能在这里删除'
      : '删除脚本文件';

  const tab = state.tabs.find((t) => t.id === state.activeId);

  updateGutter();
  openDrawer('drawer', 'fName');
}

function closeEditor() {
  closeDrawer('drawer');
  state.editingId = null;
}

/** 名称字段改了 → 同步更新源码里的 @name，保证改哪儿都算数 */
function syncNameIntoHeader() {
  const box = $('fCode');
  const name = $('fName').value.trim();
  if (!name) return;

  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(box.value);
  if (!block) return;

  const head = block[1];
  let newHead;

  if (/^\s*\/\/\s*@name\b/m.test(head)) {
    newHead = head.replace(/^(\s*\/\/\s*@name[ \t]+).*$/m, '$1' + name);
  } else {
    newHead = '\n// @name         ' + name + head;
  }

  box.value =
    box.value.slice(0, block.index) +
    '// ==UserScript==' + newHead + '// ==/UserScript==' +
    box.value.slice(block.index + block[0].length);

  updateGutter();
}

function collectForm() {
  const nameInput = $('fName').value.trim();
  const code = $('fCode').value;
  const meta = {};

  // 源码里若带着 ==UserScript== 头，就从里面取元数据
  const blockMatch = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(code);
  let bodyCode = code;

  if (blockMatch) {
    // 头由主进程重新生成，所以这里只把正文送过去，避免头重复
    bodyCode = code.slice(blockMatch.index + blockMatch[0].length).replace(/^\s*\n/, '');

    const re = /^\s*\/\/\s*@([A-Za-z0-9_:-]+)[ \t]*(.*)$/gm;
    let m;
    while ((m = re.exec(blockMatch[1])) !== null) {
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'name') meta.name = value;
      else if (key === 'version') meta.version = value;
      else if (key === 'description') meta.description = value;
      else if (key === 'match' || key === 'include') (meta.matches = meta.matches || []).push(value);
      else if (key === 'exclude' || key === 'exclude-match') (meta.excludes = meta.excludes || []).push(value);
      else if (key === 'require') (meta.requires = meta.requires || []).push(value);
      else if (key === 'resource') (meta.resources = meta.resources || []).push(value);
      else if (key === 'run-at') meta.runAt = value;
      else if (key === 'noframes') meta.noframes = true;
    }
  }

  const existing = state.editingId ? state.scripts.find((s) => s.id === state.editingId) : null;

  let matches = (meta.matches || []).slice();
  if (!matches.length && existing) matches = (existing.matches || []).slice();
  if (!matches.length) matches = ['*://*/*']; // 没写匹配规则就默认全站生效

  return {
    id: state.editingId || undefined,
    name: meta.name || nameInput || (existing ? existing.name : '') || '未命名脚本',
    version: meta.version || (existing ? existing.version : '') || '1.0.0',
    description: meta.description || (existing ? existing.description : '') || '',
    matches,
    includes: [],
    excludes: meta.excludes || (existing ? existing.excludes : []) || [],
    excludeMatches: [],
    requires: meta.requires || (existing ? existing.requires : []) || [],
    resources: meta.resources || (existing ? existing.resources : []) || [],
    runAt: meta.runAt || (existing ? existing.runAt : '') || 'document-end',
    noframes: meta.noframes !== undefined ? meta.noframes : existing ? !!existing.noframes : false,
    code: bodyCode
  };
}

async function saveScript() {
  // 内置脚本只读：真被触发到也要拦住，别把安装包里的文件写坏
  if (state.editingId && String(state.editingId).indexOf('builtin|') === 0) {
    toast('内置脚本不能修改，只能停用', 'error');
    return;
  }

  const data = collectForm();

  const saved = await api.saveScript(data);
  if (!saved) {
    toast('保存失败', 'error');
    return;
  }

  closeEditor();
  toast(`已保存「${saved.name}」，打开匹配的网站即可生效`, 'ok');
}

async function deleteScript() {
  if (!state.editingId) return;
  const script = state.scripts.find((s) => s.id === state.editingId);
  if (!script) return;

  const yes = window.confirm(`确定删除脚本「${script.name}」吗？\n脚本文件会从磁盘移除，无法恢复。`);
  if (!yes) return;

  const res = await api.deleteScript(state.editingId);
  if (res && res.ok) {
    closeEditor();
    toast('已删除', 'ok');
  } else {
    toast((res && res.error) || '删除失败', 'error');
  }
}

function updateGutter() {
  const lines = $('fCode').value.split('\n').length;
  const nums = [];
  for (let i = 1; i <= Math.max(lines, 1); i++) nums.push(i);
  $('gutter').textContent = nums.join('\n');
}

// ---------------------------------------------------------------- 导入

async function doImport() {
  const res = await api.importScripts();
  if (!res) return;
  if (res.canceled) return;

  const parts = [];
  if (res.imported && res.imported.length) parts.push(`导入 ${res.imported.length} 个：` + res.imported.join('、'));
  if (res.converted && res.converted.length) parts.push(`${res.converted.length} 个 txt 已转成 .user.js`);
  if (res.skipped && res.skipped.length) parts.push(`跳过 ${res.skipped.length} 个`);
  if (res.errors && res.errors.length) parts.push(`失败 ${res.errors.length} 个`);

  if (!parts.length) {
    toast('没有发现可导入的脚本', 'error');
    return;
  }
  toast(parts.join('；'), res.errors && res.errors.length ? 'error' : 'ok');
}

// ---------------------------------------------------------------- 事件绑定

function focusAddress() {
  const bar = $('addressBar');
  bar.focus();
  bar.select();
}

function bindUi() {
  // 导入
  $('btnImport').addEventListener('click', doImport);
  $('railImport').addEventListener('click', doImport);
  // 新建：直接开一个空白编辑器，省得先在外面存个文件再导入
  $('btnNewScript').addEventListener('click', () => openEditor(null));

  // 设置（网站 / 下载位置 / 历史记录 / 排障）
  $('btnSettings').addEventListener('click', () => openDrawer('settingsDrawer'));
  $('btnCloseSettings').addEventListener('click', () => closeDrawer('settingsDrawer'));

  // 侧边栏收起
  const sidebar = $('sidebar');
  sidebar.addEventListener('mouseenter', expandSidebar);
  sidebar.addEventListener('mouseleave', () => scheduleCollapse());

  $('btnFoldSidebar').addEventListener('click', () => setSidebarCollapsed(true));
  $('railExpand').addEventListener('click', expandSidebar);
  $('railPin').addEventListener('click', toggleSidebarPin);

  // 地址栏
  const bar = $('addressBar');
  bar.addEventListener('focus', () => {
    state.addressFocused = true;
    bar.select();
  });
  bar.addEventListener('blur', () => {
    state.addressFocused = false;
    syncAddressBar();
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateFromAddress(bar.value);
      bar.blur();
    } else if (e.key === 'Escape') {
      bar.blur();
    }
  });

  // 导航
  $('btnBack').addEventListener('click', () => api.tabs.action('back'));
  $('btnForward').addEventListener('click', () => api.tabs.action('forward'));
  $('btnReloadPage').addEventListener('click', () => api.tabs.action('reload'));
  $('btnHome').addEventListener('click', () => api.tabs.action('home'));

  // 下载
  $('btnDownloads').addEventListener('click', openDownloads);
  $('btnOpenDownloadFolder').addEventListener('click', () => api.download.open());
  $('btnOpenDl').addEventListener('click', () => api.download.open());
  $('btnChooseDl').addEventListener('click', chooseDownloadDir);
  $('btnResetDl').addEventListener('click', resetDownloadDir);
  $('btnCloseDownloads').addEventListener('click', () => closeDrawer('downloadsDrawer'));
  $('dlPanelOpenFolder').addEventListener('click', () => api.download.open());
  $('btnRefreshDlList').addEventListener('click', refreshDownloads);
  $('btnChooseDl2').addEventListener('click', chooseDownloadDir);

  // 历史记录
  $('btnOpenHistory').addEventListener('click', openHistory);
  $('btnCloseHistory').addEventListener('click', () => closeDrawer('historyDrawer'));
  $('btnClearHistory').addEventListener('click', clearHistory);

  // 清空缓存：只清能重建的，绝不碰登录状态
  $('btnClearCache').addEventListener('click', async () => {
    const yes = window.confirm(
      '清空缓存？\n\n' +
        '会清掉：网页资源缓存、代码缓存、脚本外链依赖缓存。\n' +
        '不会清：登录状态（Cookie）、历史记录、脚本文件、已下载的文件。'
    );
    if (!yes) return;

    const res = await api.clearCache();
    if (!res || !res.ok) {
      toast('清空缓存失败，详见日志', 'error');
      return;
    }

    const mb = ((res.freedBytes || 0) / 1048576).toFixed(1) + ' MB';
    toast(
      `缓存已清空（释放约 ${mb}${res.deps ? '，含 ' + res.deps + ' 个依赖' : ''}），当前页已重新加载`,
      'ok'
    );
  });
  $('btnClearHistory2').addEventListener('click', clearHistory);
  $('historySearch').addEventListener('input', (e) => {
    state.historyKeyword = e.target.value;
    refreshHistory();
  });

  // 侧栏底部：排障
  $('btnOpenLog').addEventListener('click', async () => {
    const res = await api.openLog();
    if (!res || !res.ok) toast('打不开日志：' + ((res && res.error) || '未知原因'), 'error');
  });
  $('btnCompat').addEventListener('click', cycleCompatMode);

  // 编辑器
  $('btnCloseDrawer').addEventListener('click', closeEditor);
  $('btnCancel').addEventListener('click', closeEditor);
  $('btnSave').addEventListener('click', saveScript);
  $('btnDelete').addEventListener('click', deleteScript);

  $('fName').addEventListener('input', syncNameIntoHeader);
  $('fCode').addEventListener('input', updateGutter);
  $('fCode').addEventListener('scroll', () => {
    $('gutter').scrollTop = $('fCode').scrollTop;
  });
  $('fCode').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = start + 2;
      updateGutter();
    }
  });


  // 开关即时生效
  const bindToggle = (id, key, onText, offText, tip) => {
    $(id).addEventListener('change', async (e) => {
      const on = e.target.checked;
      state.settings[key] = on;
      await api.setSettings({ [key]: on });
      toast((on ? onText : offText) + (tip ? '：' + tip : ''), 'ok');
    });
  };

  bindToggle('fOpenOnStart', 'openForumOnStart', '已开启', '已关闭', '启动时直接进入论坛');
  bindToggle('fExternalLinks', 'externalLinksToSystem', '已开启', '已关闭', '站外链接交给系统浏览器');

  $('btnSaveForum').addEventListener('click', saveForum);

  // 遮罩点击关闭
  const masks = [
    ['drawerMask', 'drawer'],
    ['settingsMask', 'settingsDrawer'],
    ['downloadsMask', 'downloadsDrawer'],
    ['historyMask', 'historyDrawer']
  ];
  for (const [maskId, drawerId] of masks) {
    $(maskId).addEventListener('click', () => closeDrawer(drawerId));
  }

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape') {
      for (const [, drawerId] of masks) {
        if ($(drawerId).classList.contains('open')) {
          closeDrawer(drawerId);
          return;
        }
      }
    }

    if (ctrl && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      focusAddress();
    } else if (ctrl && e.key.toLowerCase() === 't') {
      e.preventDefault();
      api.tabs.create('scriptdock://start');
    } else if (ctrl && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (state.activeId) api.tabs.close(state.activeId);
    } else if (ctrl && e.key.toLowerCase() === 's') {
      if ($('drawer').classList.contains('open')) {
        e.preventDefault();
        saveScript();
      }
    } else if (e.altKey && e.key === 'ArrowLeft') {
      api.tabs.action('back');
    } else if (e.altKey && e.key === 'ArrowRight') {
      api.tabs.action('forward');
    }
  });

  setupDragAndDrop();
}

function navigateFromAddress(raw) {
  const input = String(raw || '').trim();
  if (!input) return;

  let url = input;

  const isUrl =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ||
    /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(input) ||
    /^[\w-]+(\.[\w-]+)+(\/|:|$)/.test(input);

  if (!isUrl) {
    url = 'https://www.bing.com/search?q=' + encodeURIComponent(input);
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    url = 'https://' + input;
  }

  api.tabs.navigate(state.activeId, url);
}

// ---------------------------------------------------------------- 拖拽导入

function setupDragAndDrop() {
  const hint = $('dropHint');

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    state.dragDepth += 1;
    hint.classList.add('show');
    setPageVisible(false);
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    state.dragDepth -= 1;
    if (state.dragDepth <= 0) {
      state.dragDepth = 0;
      hint.classList.remove('show');
      if (!anyOverlayOpen()) setPageVisible(true);
    }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    state.dragDepth = 0;
    hint.classList.remove('show');
    if (!anyOverlayOpen()) setPageVisible(true);

    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);

    if (!paths.length) {
      toast('没能读取到文件路径，试试用「导入脚本」按钮', 'error');
      return;
    }

    const res = await api.importPaths(paths);
    if (!res) return;
    const count = (res.imported || []).length;
    toast(count ? `已导入 ${count} 个脚本` : '没有可导入的脚本', count ? 'ok' : 'error');
  });
}

init().catch((e) => {
  console.error('初始化失败', e);
});
