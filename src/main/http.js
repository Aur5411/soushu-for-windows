'use strict';

/**
 * 主进程侧的 HTTP 请求工具。
 *
 * 用 Electron 的 net 模块而不是 Node 的 http：
 *   - 走 Chromium 的网络栈，不受 CORS 限制（GM_xmlhttpRequest 的关键）
 *   - 自动带上该站点的 cookie，所以「以登录态抓数据」是能work的
 *   - 支持系统代理设置
 */

const { net } = require('electron');

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method]
 * @param {object} [options.headers] 形如 { 'User-Agent': '...' }
 * @param {string|Buffer} [options.data] 请求体
 * @param {number} [options.timeout]
 * @param {number} [options.maxBytes] 超过则中断，避免把内存吃光
 * @returns {Promise<{status:number,statusText:string,ok:boolean,responseHeaders:object,finalUrl:string,responseText:string,bytes:number}>}
 */
function request(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    data = null,
    timeout = DEFAULT_TIMEOUT,
    maxBytes = DEFAULT_MAX_BYTES
  } = options || {};

  return new Promise((resolve, reject) => {
    if (!url || !/^https?:\/\//i.test(url)) {
      reject(new Error('只支持 http/https 地址：' + url));
      return;
    }

    let req;
    try {
      req = net.request({ method: String(method).toUpperCase(), url, redirect: 'follow' });
    } catch (e) {
      reject(e);
      return;
    }

    let settled = false;
    let timer = null;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    timer = setTimeout(() => {
      try {
        req.abort();
      } catch (e) {
        /* ignore */
      }
      done(reject, new Error('请求超时（' + timeout + 'ms）'));
    }, timeout);

    for (const key of Object.keys(headers)) {
      const value = headers[key];
      if (value === undefined || value === null) continue;
      try {
        req.setHeader(key, String(value));
      } catch (e) {
        /* 非法头名直接忽略，别让整条请求挂掉 */
      }
    }

    req.on('response', (res) => {
      const chunks = [];
      let bytes = 0;

      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          try {
            req.abort();
          } catch (e) {
            /* ignore */
          }
          done(reject, new Error('响应体超过上限 ' + Math.round(maxBytes / 1024) + 'KB'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const out = {
          status: res.statusCode,
          statusText: res.statusMessage || '',
          ok: res.statusCode >= 200 && res.statusCode < 400,
          responseHeaders: normalizeHeaders(res.headers),
          finalUrl: url,
          responseText: buffer.toString('utf8'),
          bytes
        };
        // 需要二进制内容时（下载）才带上 Buffer，避免每次请求都多占一份内存
        if (options && options.wantBuffer) out.buffer = buffer;
        done(resolve, out);
      });

      res.on('error', (err) => done(reject, err));
    });

    req.on('error', (err) => done(reject, err));

    if (data !== null && data !== undefined) {
      try {
        req.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      } catch (e) {
        done(reject, e);
        return;
      }
    }

    req.end();
  });
}

/** Chromium 的响应头是 { name: string[] }，拍平成 { name: 'a, b' } */
function normalizeHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** 按行拼成 GM_xmlhttpRequest 习惯的原始头文本 */
function headersToRaw(headers) {
  return Object.keys(headers || {})
    .map((k) => k + ': ' + headers[k])
    .join('\r\n');
}

module.exports = { request, normalizeHeaders, headersToRaw };
