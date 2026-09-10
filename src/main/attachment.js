'use strict';

/**
 * 附件下载链路。
 *
 * 用户脚本（免银币那类）把附件链接改造成伪造签名的 `?mod=attachment&aid=<base64>`，
 * 直接访问会被 Discuz 打回到「抱歉，原附件链接已失效」提示页，页里放着真正的
 * 「点击这里重新下载」地址。所以要跟着这条链走到底才算拿到文件。
 *
 * 抽成独立模块并注入依赖，是为了让自检能用本地假服务器把整条链路跑一遍 ——
 * 这是最容易出边界问题的代码（判断是不是文件、跟随跳转、文件名、Cookie）。
 */

/** 最多跟几跳，防环 */
const MAX_HOPS = 4;

/** 单文件上限 */
const MAX_BYTES = 256 * 1024 * 1024;

/** 请求头：对齐 Android 版 DownloadHelper.openConn 的关键几项 */
function buildHeaders({ url, referer, cookie, userAgent }) {
  const headers = {
    'User-Agent': userAgent,
    Referer: referer || url,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Upgrade-Insecure-Requests': '1'
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * @param {object} deps
 * @param {Function} deps.request              主进程 HTTP（返回 {status,responseHeaders,responseText,buffer}）
 * @param {Function} deps.cookiesFor           取该地址的 Cookie 字符串
 * @param {Function} deps.downloadDir          下载目录
 * @param {Function} deps.uniqueTarget         同名文件加序号
 * @param {Function} deps.decideFilename       文件名决策
 * @param {Function} deps.isFileResponse       响应是不是文件
 * @param {Function} deps.findRetryDownloadLink 从提示页里找真实下载地址
 * @param {string}   deps.userAgent
 * @param {Function} [deps.onHop]              每跳回调，用于日志
 * @param {Function} [deps.onReject]           判定「不是文件」时回调，带上响应细节，便于排查
 *                                             （出问题时往往就是服务器回了 HTML 页面）
 */
function createAttachmentDownloader(deps) {
  const {
    request,
    cookiesFor,
    downloadDir,
    uniqueTarget,
    decideFilename,
    isFileResponse,
    findRetryDownloadLink,
    userAgent,
    onHop,
    onReject,
    log
  } = deps;

  /** 统一的诊断输出：下载失败时没有这个根本查不动 */
  const say = (msg) => {
    if (typeof log === 'function') log(msg);
  };

  /** HTML 正文预览：看清服务器到底回了个什么页面 */
  function preview(text) {
    return String(text || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  /**
   * @returns {Promise<{ok:boolean,name?:string,path?:string,hops?:number,reason?:string}>}
   */
  async function download(startUrl, options) {
    const opts = options || {};
    let url = String(startUrl || '');
    if (!url) return { ok: false, reason: '空地址' };

    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      let cookie = '';
      try {
        cookie = (await cookiesFor(url)) || '';
      } catch (e) {
        cookie = '';
      }

      const res = await request({
        url,
        method: 'GET',
        headers: buildHeaders({
          url,
          referer: opts.referer,
          cookie,
          userAgent
        }),
        timeout: 120000,
        maxBytes: MAX_BYTES,
        wantBuffer: true
      });

      const headers = res.responseHeaders || {};
      say(
        `[附件] 第${hop + 1}跳 GET ${url}\n` +
          `        状态=${res.status} 类型=${headers['content-type'] || '(无)'} ` +
          `处置=${headers['content-disposition'] || '(无)'} 长度=${res.bytes || 0} ` +
          `Cookie=${cookie ? cookie.length + '字符' : '无'}`
      );

      if (res.status >= 400) {
        say('[附件] ✗ HTTP ' + res.status + '，服务器拒绝了这次请求');
        return { ok: false, reason: 'HTTP ' + res.status, hops: hop };
      }

      if (isFileResponse(res.responseHeaders)) {
        const name = decideFilename({
          threadSubject: opts.threadSubject || '',
          disposition: res.responseHeaders['content-disposition'] || '',
          url: res.finalUrl || url,
          suggested: '',
          contentType: res.responseHeaders['content-type'] || '',
          head: res.buffer ? res.buffer.slice(0, 64) : null
        });

        const dir = downloadDir();
        const target = uniqueTarget(dir, name);
        const { writeFileSync } = require('fs');
        writeFileSync(target, res.buffer || Buffer.from(res.responseText, 'utf8'));

        const finalName = require('path').basename(target);
        say('[附件] ✓ 判定为文件 → ' + finalName);
        return { ok: true, name: finalName, path: target, hops: hop };
      }

      // 不是文件：去提示页里找真正的下载地址继续跟
      const next = findRetryDownloadLink(res.responseText, res.finalUrl || url);
      if (!next || next === url) {
        if (typeof onReject === 'function') {
          onReject({
            status: res.status,
            headers: res.responseHeaders || {},
            body: String(res.responseText || '').slice(0, 600),
            url: res.finalUrl || url
          });
        }
        const bodyPreview = preview(res.responseText);
        say('[附件] ✗ 服务器返回的是网页，页面里也没有「重新下载」链接');
        say('[附件]   正文预览：' + (bodyPreview || '(空)'));
        return {
          ok: false,
          reason: '服务器返回的是网页而不是文件（HTTP ' + res.status + '）',
          hops: hop,
          preview: bodyPreview
        };
      }

      if (typeof onHop === 'function') onHop(hop + 1, next);
      url = next;
    }

    say('[附件] ✗ 跳转层数过多（' + MAX_HOPS + '），放弃');
    return { ok: false, reason: '跳转层数过多，已放弃', hops: MAX_HOPS };
  }

  return { download };
}

module.exports = { createAttachmentDownloader, buildHeaders, MAX_HOPS, MAX_BYTES };
