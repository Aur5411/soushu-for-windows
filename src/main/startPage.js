'use strict';

/**
 * 内置起始页。用 scriptdock://start 协议提供，
 * 地址栏里显示的是一个干净的内部地址，不会暴露本机路径。
 */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function domainOf(pattern) {
  const m = /^[a-z*]+:\/\/(?:[^/]*@)?([^/]+)/i.exec(String(pattern || ''));
  return m ? m[1] : String(pattern || '');
}

function render(scripts, info) {
  const enabled = scripts.filter((s) => s.enabled);
  const builtinCount = Number(info.builtinCount || 0);
  const external = scripts.filter((s) => s.source === 'external');
  const rows = enabled.length
    ? enabled
        .map(
          (s) => `
        <li class="item">
          <div class="item-main">
            <span class="dot"></span>
            <span class="item-name">${escapeHtml(s.name)}</span>
          </div>
          <div class="item-rules">${escapeHtml(
            (s.matches.concat(s.includes).slice(0, 3).map(domainOf).join('  ·  ')) || '未配置匹配规则'
          )}${s.matches.concat(s.includes).length > 3 ? '  …' : ''}</div>
        </li>`
        )
        .join('')
    : '';

  const shortcuts = [
    [info.forumUrl || 'https://www.soushu2030.com', '进入论坛'],
    ['https://www.bing.com', 'Bing'],
    ['https://github.com', 'GitHub']
  ]
    .map(([url, label], i) => `<a class="chip${i === 0 ? ' chip-main' : ''}" href="${url}">${label}</a>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>搜书吧</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #ffffff; --fg: #1b1d21; --fg-2: #6b7280;
    --line: #e5e7eb; --accent: #3b6ef5; --ok: #16a34a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg);
    font: 14px/1.6 "Microsoft YaHei", "PingFang SC", -apple-system, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 40px 20px;
  }
  .wrap { width: 100%; max-width: 760px; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .mark {
    width: 44px; height: 44px; border-radius: 12px; flex: none;
    background: linear-gradient(135deg, #4f7ff7, #7aa6ff);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 20px; font-weight: 700;
    box-shadow: 0 6px 16px rgba(59, 110, 245, 0.28);
  }
  h1 { font-size: 24px; margin: 0; letter-spacing: 0.5px; }
  .sub { color: var(--fg-2); margin: 0 0 28px 56px; font-size: 13px; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 20px 22px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  }
  .card h2 {
    font-size: 13px; margin: 0 0 14px; color: var(--fg-2);
    font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;
  }
  .stat { display: flex; gap: 34px; }
  .stat b { display: block; font-size: 26px; line-height: 1.2; font-weight: 700; }
  .stat span { color: var(--fg-2); font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .item { padding: 9px 0; border-bottom: 1px dashed var(--line); }
  .item:last-child { border-bottom: 0; }
  .item-main { display: flex; align-items: center; gap: 8px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
  .item-name { font-weight: 600; }
  .item-rules { color: var(--fg-2); font-size: 12px; margin-left: 15px; font-family: Consolas, monospace; }
  .empty { color: var(--fg-2); }
  .chip {
    display: inline-block; padding: 6px 14px; margin: 0 8px 8px 0; border-radius: 999px;
    background: #eef2ff; color: var(--accent); text-decoration: none; font-size: 13px;
  }
  .chip:hover { background: #e0e7ff; }
  .chip-main { background: #3b6ef5; color: #fff; font-weight: 600; }
  .chip-main:hover { background: #2f60e8; }
  kbd {
    background: #f1f2f4; border: 1px solid var(--line); border-bottom-width: 2px;
    border-radius: 5px; padding: 1px 6px; font: 12px Consolas, monospace;
  }
  ol { margin: 0; padding-left: 20px; color: var(--fg-2); }
  ol li { margin-bottom: 6px; }
  ol b { color: var(--fg); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo">
      <div class="mark">书</div>
      <h1>搜书吧</h1>
    </div>
    <p class="sub">电脑版 · v${escapeHtml(info.version)} · 内置脚本引擎，附件一键下载</p>

    <div class="card">
      <div class="stat">
        <div><b>${enabled.length}</b><span>运行中的脚本</span></div>
        <div><b>${builtinCount}</b><span>内置脚本</span></div>
        <div><b>${external.length}</b><span>外部目录脚本</span></div>
      </div>
    </div>

    <div class="card">
      <h2>当前生效的脚本</h2>
      ${rows ? `<ul>${rows}</ul>` : '<p class="empty">还没有启用的脚本。点左上角的「导入」把 .user.js 加进来。</p>'}
    </div>

    <div class="card">
      <h2>用法</h2>
      <ol>
        <li>软件启动默认直接进论坛；想换域名，点左侧的 <b>⚙ 论坛设置</b>。</li>
        <li>帖子页点附件即下载，文件统一存到软件文件夹下的 <b>Download</b>，文件名取帖子标题。</li>
        <li><b>回复可见</b>的内容会自动回复解锁（61 秒冷却，付费附件不碰）。</li>
        <li>脚本面板不用时会自动收起，鼠标移到左侧边缘就展开。</li>
      </ol>
    </div>

    <div class="card">
      <h2>开始</h2>
      ${shortcuts}
      <p class="sub" style="margin: 12px 0 0;">快捷键：<kbd>Ctrl</kbd>+<kbd>T</kbd> 新标签　<kbd>Ctrl</kbd>+<kbd>W</kbd> 关闭　<kbd>Ctrl</kbd>+<kbd>L</kbd> 地址栏　<kbd>Alt</kbd>+<kbd>←</kbd> 后退　<kbd>F12</kbd> 开发者工具</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { render };
