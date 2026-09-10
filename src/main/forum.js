'use strict';

/**
 * 搜书吧论坛相关的小工具。
 *
 * 关于取舍：Android 版有一大套文件名乱码重编码（4×4 编码穷举、GB2312 字库区判定）
 * 和双通道下载器，那是移动端 WebView 的产物 —— WebView 对 Content-Disposition
 * 的 GBK 编码处理不完善，才需要自己兜。桌面端跑的是完整 Chromium，
 * 这类问题基本不存在，所以这里只保留真正跨平台有价值的：
 *   - 去站点标记（文件名带 [sxsy.org] 这类前缀是真实存在的）
 *   - 后缀补全（按 Content-Type / 魔数）
 *   - 论坛地址规范化、站内站外判断
 */

const path = require('path');
const iconv = require('iconv-lite');

// ---------------------------------------------------------------- 常量

/** 找不到论坛地址时的固定入口 */
const DEFAULT_ENTRY = 'https://www.soushu2030.com';

/**
 * 桌面 UA。Electron 默认 UA 里带 "Electron/xx"，不少站点会据此改行为
 * （弹「请用浏览器打开」之类），换成一个干净的 Chrome UA 更省事。
 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 这些域名历史上证书链有问题，只有它们放行证书错误，其余一律拒绝 */
const ENTRY_HOST_MARKERS = ['soushu2030', 'soushufabu', 'allshu', '.soushu'];

/**
 * 「发布链路」URL 标记（对齐 Android 版 entryHostMarkers）。
 * 比证书名单多两个：book/ 和 /o/ 是发布导航页的路径特征，不是域名。
 * URL 里含任意一个，就说明还在发布页链路上，没进真正的论坛。
 */
const ENTRY_URL_MARKERS = ENTRY_HOST_MARKERS.concat(['book/', '/o/']);

/**
 * 发布页上自动挑「最新地址」链接的脚本（照搬 Android 版 autoJumpToForum 的打分规则）。
 *
 * 发布页的域名和结构会变，所以不能写死选择器 —— 这里按
 * 「链接文字/地址里的关键词打分 + .link-box 结构加分」来挑最像论坛入口的那个。
 * 只在冷启动入口窗口里跑，进了论坛就停手，否则帖子页的「首页」链接会被误点。
 */
const ENTRY_JUMP_JS = `(function(){
  try{
    var info={};
    info.url=location.href;
    info.linkBox=document.querySelectorAll('.link-box').length;
    info.jumped=!!window.__entryJumped;

    // 把各种写法的地址统一成绝对地址（发布页有时用相对路径、裸文件名或 // 开头）
    function abs(h){
      h=String(h||'').trim();
      if(!h) return '';
      if(/^https?:\\/\\//i.test(h)) return h;
      if(/^\\/\\//.test(h)) return location.protocol + h;
      // javascript: / mailto: / 锚点 这些不是链接目标
      if(/^(javascript|mailto|tel|data|#)/i.test(h)) return '';
      // 剩下的：只要像「路径或文件名」（含 . 或 /，且不带协议冒号）就按当前地址解析
      if(/^[^:]*[.\\/][^:]*$/.test(h)){
        try{ return new URL(h, location.href).href; }catch(e){ return ''; }
      }
      return '';
    }

    // 候选地址来源：a[href]、area[href]，以及 data-url / data-href / onclick 里写的地址
    function candidates(){
      var out=[];
      var nodes=document.querySelectorAll('a[href],area[href],[data-url],[data-href],[onclick]');
      for(var i=0;i<nodes.length;i++){
        var n=nodes[i];
        var raw=(n.getAttribute&&(n.getAttribute('href')||n.getAttribute('data-url')||n.getAttribute('data-href')))||'';
        var oc=(n.getAttribute&&n.getAttribute('onclick'))||'';
        if(!raw && oc){
          var m=/https?:\\/\\/[^'"\\s)]+/.exec(oc);
          if(m) raw=m[0];
        }
        var url=abs(raw);
        if(url) out.push({el:n,url:url});
      }
      return out;
    }

    function pick(list){
      var best=null, score=-1;
      for(var i=0;i<list.length;i++){
        var a=list[i].el;
        var href=list[i].url;
        var txt=((a.textContent||'')+(a.getAttribute&&(a.getAttribute('title')||'')||'')).replace(/\\s+/g,'');
        if(!/最新地址|最新网址|最新|地址|搜书|进入论坛|论坛|bbs|discuz|soushu/i.test(txt+href)) continue;
        var s=0;
        if(/最新地址|最新网址/i.test(txt)) s+=5;
        if(/最新/i.test(txt)) s+=3;
        if(/搜书|soushu/i.test(txt+href)) s+=2;
        if(/论坛|bbs|discuz/i.test(txt+href)) s+=1;
        if((a.className||'').indexOf('link')>=0) s+=1;
        // 发布页自身的地址（同主机且路径像发布导航）降权，免得跳回自己
        if(href.indexOf(location.host)>=0 && /\\/o\\/|soushufabu|soushu2030|book\\//i.test(href)) s-=3;
        if(s>score){ score=s; best=href; }
      }
      return { target: best, score: score };
    }

    var r=pick(candidates());
    info.target=r.target||'';
    info.score=r.score;
    info.cand=r.target?1:0;

    // 只有「确实是发布页」才允许跳：
    //   - 有 .link-box 结构，或
    //   - 链接文字/地址里明确写着「最新地址 / 最新网址」（score>=5）
    // 否则论坛自身的导航栏（一堆「论坛」「首页」链接）会被误命中，
    // 把用户从帖子页拽回首页。这一条对齐 Android 版的原逻辑。
    info.strong=(info.linkBox>0 || r.score>=5)?1:0;

    if(!r.target || info.jumped || !info.strong) return JSON.stringify(info);
    window.__entryJumped=1;
    window.location.href = r.target;
    info.jumped=true;
    return JSON.stringify(info);
  }catch(e){ return JSON.stringify({err:String(e)}); }
})();`;

/** 认得的文档后缀，用于判断该不该补后缀 */
const KNOWN_DOC_EXTS = [
  '.txt', '.zip', '.epub', '.pdf', '.rar', '.7z', '.gz',
  '.mobi', '.azw3', '.azw', '.chm', '.umd',
  '.html', '.htm', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mp3'
];

/** MIME → 后缀 */
const MIME_EXT = {
  'text/plain': '.txt',
  'application/zip': '.zip',
  'application/epub+zip': '.epub',
  'application/pdf': '.pdf',
  'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar',
  'application/x-7z-compressed': '.7z',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-mobipocket-ebook': '.mobi'
};

// ---------------------------------------------------------------- URL

/** 补协议、补末尾斜杠（对齐 Prefs.normalizeUrl） */
function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!/\/$/.test(url)) url += '/';
  return url;
}

/** 取源（协议 + 主机 + 端口） */
function originOf(input) {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
    return u.protocol + '//' + u.host + '/';
  } catch (e) {
    return '';
  }
}

/** 主机名是否在证书放行名单里 */
function hostMatchesMarkers(host) {
  const h = String(host || '').toLowerCase();
  return ENTRY_HOST_MARKERS.some((m) => h.indexOf(m) >= 0);
}

/** URL 是否还停在「发布链路」上（对齐 Android 版 isEntryHostUrl） */
function isEntryUrl(url) {
  const low = String(url || '').toLowerCase();
  if (!low) return false;
  return ENTRY_URL_MARKERS.some((m) => low.indexOf(m) >= 0);
}

/** 是否是可视为内容页的真实 http(s) 地址 */
function isRealHttpUrl(url) {
  const low = String(url || '').toLowerCase();
  return low.startsWith('http://') || low.startsWith('https://');
}

// ---------------------------------------------------------------- 文件名

/** 去掉文件名里的站点标记，只处理主体、保留扩展名 */
function stripWebsite(name) {
  let base = String(name || '');
  const ext = path.extname(base);
  let stem = ext ? path.basename(base, ext) : base;

  stem = stem.replace(
    /(?:www\.)?[a-z0-9][a-z0-9-]{0,62}(?:\.(?:com|net|org|cn|cc|vip|xyz|top|site|me|info|io|co|tv|la|in|pw|fun|icu))+/gi,
    ''
  );

  stem = stem
    .replace(/[@_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[- ]{2,}/g, ' ')
    .replace(/[\[\(【（]\s*[\]\)】）]/g, ' ')
    .replace(/^[\s@\])】）_，,、.·-]+/, '')
    .replace(/[\s@\[(【（_，,、.·-]+$/, '')
    .trim();

  if (!stem) stem = 'download';
  return stem + ext;
}

// ---------------------------------------------------------------- 乱码修复
//
// 论坛服务器常用 GBK 发 Content-Disposition 的 filename=，而 HTTP 头按规范
// 是 Latin-1，浏览器照做就得到一串 ÃÂ 开头的乱码。下面这套（候选穷举 + 打分择优）
// 是 Android 版 DownloadHelper 里验证过的做法，这里按同样的思路搬过来。
//
// 关键点：不要试图「猜」是哪一种编码错位，而是把各种可能都生成出来，用评分函数挑最好的。

/** 明显的乱码特征（对齐 looksMojibake） */
function looksGarbled(text) {
  const s = String(text || '');
  if (s.indexOf('\uFFFD') >= 0) return true;
  if (/[ÃÂÐÑÞæøå]/.test(s)) return true;
  if (s.indexOf('锟') >= 0) return true;
  // 日文假名出现在中文书名里，基本就是解码错位
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(s)) return true;
  return false;
}

/**
 * 输入是不是「GBK 字节被当成 Latin-1 读」的典型乱码。
 *
 * 判据：U+00A1–U+00FF 区间的字符占比很高。
 * 中文书名里不会出现这些带重音/符号的拉丁字符，出现了就是字节被错解。
 *
 * 注意：不要用「含 ÃÂÐÑ 几个特定字符」这种窄判据 ——
 * GBK 字节当 Latin-1 读出来更像 ¡¾Íê½á¡¿¶·ÆÆ²Ôñ·，一个都命中不了。
 */
function looksLikeLatin1Mojibake(text) {
  const s = String(text || '');
  if (!s) return false;

  const chars = [];
  for (const c of s) {
    if (c.charCodeAt(0) > 0x1f) chars.push(c); // 排除控制字符
  }
  if (chars.length < 2) return false;

  let hi = 0;
  for (const c of chars) {
    const code = c.charCodeAt(0);
    if (code >= 0xa1 && code <= 0xff) hi += 1;
  }

  return hi / chars.length >= 0.4;
}

/** 文件名质量打分，越小越好 */
function scoreName(name) {
  const s = String(name || '');
  if (!s) return 1e9;

  let score = 0;

  const stem = path.basename(s, path.extname(s));
  if (!stem || /^[\s.\-_]+$/.test(stem)) score += 1000;

  // U+00A1–U+00FF 几乎只出现在乱码里，重罚，保证原始乱码永远赢不了修复结果
  const latin1Junk = (s.match(/[\u00A1-\u00FF]/g) || []).length;
  score += latin1Junk * 40;

  if (s.indexOf('\uFFFD') >= 0) score += 200 * (s.match(/\uFFFD/g) || []).length;
  if (s.indexOf('锟') >= 0) score += 120;
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(s)) score += 60;

  if (/[\\/:*?"<>|\r\n\t]/.test(s)) score += 200;

  // 含中文是加分项，但**封顶**：不能让「乱码汉字更多」的候选胜出
  const hans = (s.match(/[\u4E00-\u9FFF]/g) || []).length;
  score -= Math.min(hans, 6) * 3;

  if (s.length > 120) score += (s.length - 120) / 2;

  return score;
}

/** %XX 百分号还原：先按 UTF-8 解，再按原始字节（GBK）解一次 */
function percentCandidates(raw) {
  const s = String(raw || '');
  const out = [];
  if (s.indexOf('%') < 0) return out;

  try {
    out.push(decodeURIComponent(s));
  } catch (e) {
    /* 非法百分号序列 */
  }

  // %CE%D2 这种是 GBK 字节的百分号编码：按字节还原后再按 GBK 解
  try {
    const bytes = [];
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(s.charCodeAt(i) & 0xff);
      }
    }
    const buf = Buffer.from(bytes);
    out.push(iconv.decode(buf, 'gbk'));
    out.push(buf.toString('utf8'));
  } catch (e) {
    /* ignore */
  }

  return out;
}

/**
 * 乱码修复。
 *
 * 做法（刻意做成确定性的，不做「候选穷举 + 打分」）：
 *   浏览器对 Content-Disposition 里的非 ASCII 字节会按 Latin-1 兜底，
 *   所以只要输入呈现 Latin-1 乱码特征，**原始字节就是 charCode 序列**，
 *   拿它按 GB18030 / Big5 重新解一次即可 —— 这是唯一正确的方向。
 *
 * 早先试过 App 里那套「两两编码转换 + 择优」：在中文场景下会翻车，
 * 因为错方向也能解出一堆汉字，评分反而更高（实测把正确书名换成了乱码）。
 *
 * @returns {{best: string, via: string, score: number}}
 */
function repairName(raw) {
  const input = String(raw == null ? '' : raw).trim();

  const candidates = [];
  const consider = (value, via) => {
    const s = String(value == null ? '' : value).trim();
    if (!s) return;
    if (candidates.some((c) => c.name === s)) return;
    candidates.push({ name: s, via, score: scoreName(s) });
  };

  consider(input, 'raw');

  // 百分号编码本身就是「字节的另一种写法」，解出来直接就是候选
  const percents = percentCandidates(input);
  for (const p of percents) consider(p, 'percent');

  // 呈 Latin-1 乱码特征：原始字节就是 charCode 序列，按中文编码重新解
  for (const seed of [input].concat(percents)) {
    if (!looksLikeLatin1Mojibake(seed)) continue;

    const bytes = Buffer.from(seed, 'latin1');

    for (const enc of ['gb18030', 'big5']) {
      let decoded = '';
      try {
        decoded = iconv.decode(bytes, enc);
      } catch (e) {
        continue;
      }
      if (!decoded || decoded.indexOf('\uFFFD') >= 0) continue; // 解出替换符说明编码不对
      consider(decoded, 'latin1->' + enc);
    }
  }

  let best = candidates[0] || { name: input, via: 'raw', score: 0 };
  for (const c of candidates) {
    if (c.score < best.score) best = c;
  }

  return { best: best.name, via: best.via, score: best.score };
}

/**
 * 页面标题 → 帖子标题。
 * Discuz 的 <title> 形如「书名 - 小说下载区 - 搜书吧 - Powered by Discuz!」，
 * 取第一段就是书名。
 */
function titleToSubject(title) {
  let t = String(title || '').trim();
  if (!t) return '';
  const parts = t.split(/\s+[-–—|]\s+/);
  if (parts.length > 1) t = parts[0];
  return t.replace(/[_\-–—|\s]+$/, '').trim();
}

/** Content-Disposition 取文件名（RFC5987 的 filename*= 优先） */
function filenameFromDisposition(disposition) {
  const raw = String(disposition || '');
  if (!raw) return '';

  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(raw);
  if (star && star[2]) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch (e) {
      return star[2].trim();
    }
  }

  const plain = /filename\s*=\s*"([^"]*)"/i.exec(raw) || /filename\s*=\s*([^;]+)/i.exec(raw);
  return plain && plain[1] ? plain[1].trim() : '';
}

/** URL 最后一段（排除 .php 之类的脚本名） */
function filenameFromUrl(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const last = segs.length ? decodeURIComponent(segs[segs.length - 1]) : '';
    if (!last || /\.(php|asp|aspx|jsp|cgi)$/i.test(last)) return '';
    return last;
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------- 附件下载

/**
 * 是不是 Discuz 的附件下载地址。
 * 用户脚本（免银币那类）会把附件链接改造成 `?mod=attachment&aid=<base64>`，
 * 点击后本来会导航走；我们把它截下来后台下载，帖子页就不会被顶掉。
 */
function isAttachmentUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/attachpay/i.test(url)) return false; // 付费附件不碰
  return /[?&]mod=attachment\b|attachment\.php|[?&]aid=/i.test(url);
}

/**
 * 是不是付费附件（需要银币/金币才能下）。
 * 这类链接**故意不拦截** —— 得让论坛自己的购买页出来，用户才有机会自行决定买不买。
 */
function isPaidAttachmentUrl(url) {
  return /attachpay|action=(pay|buy)|buyattach|payto/i.test(String(url || ''));
}

/**
 * 是不是文本文件地址（.txt 等）。
 *
 * 论坛常把小说正文当普通文本文档返回，这时候没有 Content-Disposition，
 * Chromium 会在标签页里直接显示纯文本 —— 用户想拿到的是能用记事本打开的文件。
 * 所以这类地址也按「下载」处理。
 */
function isTextFileUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(txt|text|md)$/.test(pathname);
  } catch (e) {
    return false;
  }
}

/** 响应是不是文件（而不是 HTML 提示页） */
function isFileResponse(responseHeaders) {
  const headers = responseHeaders || {};
  const disp = String(headers['content-disposition'] || '');
  if (/attachment/i.test(disp)) return true;

  const ct = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ct) return true; // 没有类型信息时按文件处理
  if (ct.indexOf('text/html') === 0) return false;
  if (ct.indexOf('text/') === 0) return true;
  if (ct.indexOf('xml') >= 0 || ct.indexOf('json') >= 0) return false;
  return true;
}

/**
 * 从「抱歉，原附件链接已失效」这类提示页里找出「点击这里重新下载」的真实链接。
 * 伪造签名的附件链接被 Discuz 打回时就是这个页面，跟着它才能拿到文件。
 */
function findRetryDownloadLink(html, baseUrl) {
  const text = String(html || '');
  if (!text) return '';

  const candidates = [];
  const push = (href) => {
    const h = String(href || '').replace(/&amp;/g, '&').trim();
    if (!h) return;
    if (!/[?&]mod=attachment\b|attachment\.php|[?&]aid=/i.test(h)) return;
    if (/attachpay/i.test(h)) return;
    if (!candidates.includes(h)) candidates.push(h);
  };

  // 1) 普通链接
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(text)) !== null) push(m[1]);

  // 2) meta refresh / JS 跳转里写的地址
  if (!candidates.length) {
    const jumpRe = /(?:url\s*=|location(?:\.href)?\s*=\s*|window\.open\s*\()\s*['"]([^'"]+)['"]/gi;
    while ((m = jumpRe.exec(text)) !== null) push(m[1]);
  }

  if (!candidates.length) return '';

  // 优先「mod=attachment 且带 aid」的，那才是真正的取件地址
  const best =
    candidates.find((h) => /mod=attachment/i.test(h) && /[?&]aid=/i.test(h)) || candidates[0];

  try {
    return new URL(best, baseUrl).href;
  } catch (e) {
    return best;
  }
}

/** Content-Type → 后缀 */
function guessExtFromMime(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[ct] || '';
}

/** 魔数 → 后缀（只在没有合理后缀时才用） */
function guessExtFromMagic(buffer) {
  if (!buffer || buffer.length < 8) return '';
  const b = buffer;
  if (b.slice(0, 4).toString('latin1') === '%PDF') return '.pdf';
  if (b.slice(0, 4).toString('latin1') === 'Rar!') return '.rar';
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return '.7z';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return '.zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return '.gz';
  const head = b.slice(0, 68).toString('latin1');
  if (head.indexOf('BOOKMOBI') >= 0 || head.indexOf('TEXtREAd') >= 0) return '.mobi';
  return '';
}

/**
 * 综合决定最终文件名。
 * 优先级：帖子标题 > 响应头 > Chromium 建议名 > URL
 */
/**
 * 综合决定最终文件名。
 *
 * 每个候选来源都先做一次乱码修复，再择优：
 *   1. 帖子标题 —— Discuz 的附件名常是乱码或纯数字，标题才是最可读的
 *   2. Content-Disposition（filename* 优先）
 *   3. 浏览器给的建议名
 *   4. URL 最后一段
 *
 * @param {object} opts
 * @param {string} [opts.threadSubject] 帖子标题，最可信
 * @param {string} [opts.disposition]   Content-Disposition
 * @param {string} [opts.url]
 * @param {string} [opts.suggested]     Chromium 给出的建议名
 * @param {string} [opts.contentType]
 * @param {Buffer} [opts.head]          头部字节，用于魔数探测
 * @param {boolean} [opts.trace]        返回诊断信息
 */
function decideFilename(opts) {
  const {
    threadSubject = '',
    disposition = '',
    url = '',
    suggested = '',
    contentType = '',
    head = null,
    trace = false
  } = opts || {};

  const raw = {
    subject: String(threadSubject || '').replace(/\[\/?[a-z0-9=*]+\]/gi, '').trim(),
    disposition: filenameFromDisposition(disposition),
    suggested: String(suggested || '').trim(),
    url: filenameFromUrl(url)
  };

  const sources = [];
  for (const kind of ['subject', 'disposition', 'suggested', 'url']) {
    if (!raw[kind]) continue;
    const fixed = repairName(raw[kind]);
    sources.push({ kind, name: fixed.best, score: fixed.score, from: raw[kind] });
  }

  // 帖子标题最可信，但它得先通过「不像乱码」这一关
  const subject = sources.find((s) => s.kind === 'subject' && !looksGarbled(s.name));
  let picked = subject || null;

  if (!picked) {
    for (const s of sources) {
      if (!picked || s.score < picked.score) picked = s;
    }
  }

  let chosen = picked ? picked.name : '';

  chosen = stripWebsite(chosen);
  chosen = chosen.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();

  if (!chosen) chosen = 'download';

  // 后缀补全：现有后缀不认识时，用 MIME 或魔数补一个
  let ext = path.extname(chosen).toLowerCase();
  if (ext && !KNOWN_DOC_EXTS.includes(ext)) {
    const better = (head ? guessExtFromMagic(head) : '') || guessExtFromMime(contentType);
    if (better) {
      chosen = chosen.slice(0, chosen.length - ext.length);
      ext = better;
    } else if (/^\.(php|asp|aspx|jsp|cgi)$/i.test(ext)) {
      // 认不出来又不是真的后缀，去掉
      chosen = chosen.slice(0, chosen.length - ext.length);
      ext = '';
    }
  }

  if (!ext) {
    const added = (head ? guessExtFromMagic(head) : '') || guessExtFromMime(contentType);
    if (added) {
      chosen += added;
    } else if (!path.extname(chosen)) {
      chosen += '.txt';
    }
  }

  const finalExt = path.extname(chosen);
  const stem = path.basename(chosen, finalExt).slice(0, 150);
  const result = stem + finalExt;

  if (trace) {
    return {
      name: result,
      raw,
      sources: sources.map((s) => ({ kind: s.kind, from: s.from, to: s.name, score: s.score })),
      picked: picked ? picked.kind : 'fallback'
    };
  }

  return result;
}

/**
 * 网页要开新窗口 / 新标签页时该怎么处理。
 *
 * 背景：论坛的附件链接很多是 `target="_blank"` 或 `window.open` 打开的。
 * 只拦 `will-navigate`（同页导航）不够 —— 弹窗那条路会直接开出一个新页面，
 * 用户看到的就是「点一下附件，冒出个新标签页」。
 *
 * 纯函数，不碰任何 Electron API，方便单测。返回值：
 *
 *   'block'       本地文件等，直接拒绝
 *   'background'  附件 / txt：截下来走我们自己的链路后台静默下载
 *   'download'    浏览器自己判定「另存为」：交给 Chromium 静默下载，不开窗口
 *   'paid'        付费附件：开标签页让用户自己决定买不买
 *   'external'    站外链接：丢给系统浏览器
 *   'tab'         其余：正常开新标签页
 *
 * @param {object} opts
 * @param {string} opts.url          弹窗目标地址
 * @param {string} [opts.disposition] Electron 给的 disposition（'save-to-disk' 等）
 * @param {boolean} [opts.autoDownload] 用户是否开了「点附件自动下载」（默认开）
 * @param {boolean} [opts.isExternal]   是否已判定为站外链接
 */
function decidePopupAction(opts) {
  const url = String((opts && opts.url) || '');
  const disposition = String((opts && opts.disposition) || '');
  const autoDownload = !(opts && opts.autoDownload === false);
  const isExternal = !!(opts && opts.isExternal);

  // 安全优先：本地文件一律不放行
  if (/^file:\/\//i.test(url)) return 'block';

  // 空弹窗：Discuz 的购买/下载弹层常用 about:blank 或 javascript: 做空中转，
  // 放过去就是一片空白页，直接吞掉
  if (/^(about|javascript):/i.test(url)) return 'swallow';

  // 脚本动态生成文件（Blob）的弹窗，基本都是在下载，静默落盘
  if (/^blob:/i.test(url)) return 'download';

  // 付费附件绝不自动下，得让论坛自己的购买页出来
  if (isPaidAttachmentUrl(url)) return 'paid';

  // 附件 / 纯文本：后台静默下载，不开新页面
  if (autoDownload && (isAttachmentUrl(url) || isTextFileUrl(url))) return 'background';

  // 页面明确要求「另存为」：也静默下载，只是不跟随提示页
  if (disposition === 'save-to-disk') return 'download';

  if (isExternal) return 'external';
  return 'tab';
}

module.exports = {
  DEFAULT_ENTRY,
  DESKTOP_UA,
  ENTRY_HOST_MARKERS,
  ENTRY_URL_MARKERS,
  ENTRY_JUMP_JS,
  KNOWN_DOC_EXTS,
  normalizeUrl,
  originOf,
  hostMatchesMarkers,
  isEntryUrl,
  isRealHttpUrl,
  stripWebsite,
  looksGarbled,
  scoreName,
  repairName,
  titleToSubject,
  filenameFromDisposition,
  filenameFromUrl,
  isAttachmentUrl,
  isPaidAttachmentUrl,
  isTextFileUrl,
  decidePopupAction,
  isFileResponse,
  findRetryDownloadLink,
  guessExtFromMime,
  guessExtFromMagic,
  decideFilename
};
