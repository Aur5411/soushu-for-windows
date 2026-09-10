'use strict';

/**
 * 浏览历史。
 *
 * 存在 <userData>/history.json，纯 JSON 数组，最新的在前。
 * 同一个地址重复访问只保留一条（提到最前并更新时间），避免历史被刷爆。
 */

const fs = require('fs');
const path = require('path');

/** 最多保留多少条 */
const MAX_ENTRIES = 2000;

function createHistoryStore(filePath) {
  let items = [];

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) items = parsed.filter((it) => it && it.url);
  } catch (e) {
    items = [];
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(items), 'utf8');
    } catch (e) {
      /* 写不了不影响浏览 */
    }
  }

  /** 记一条访问。返回新记录，非 http(s) 地址会被忽略 */
  function add(entry) {
    const url = String((entry && entry.url) || '');
    if (!/^https?:\/\//i.test(url)) return null;

    const title = String((entry && entry.title) || '').trim().slice(0, 200);
    const at = entry && entry.at ? Number(entry.at) : Date.now();

    items = items.filter((it) => it.url !== url);
    items.unshift({ url, title, at });

    if (items.length > MAX_ENTRIES) items.length = MAX_ENTRIES;

    save();
    return items[0];
  }

  /** @param {string} [keyword] 按标题或地址过滤 */
  function list(keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return items.slice();

    return items.filter((it) => {
      return (
        String(it.title || '').toLowerCase().indexOf(kw) >= 0 ||
        String(it.url || '').toLowerCase().indexOf(kw) >= 0
      );
    });
  }

  function remove(url) {
    const target = String(url || '');
    const before = items.length;
    items = items.filter((it) => it.url !== target);
    if (items.length !== before) save();
    return { ok: items.length !== before, removed: before - items.length };
  }

  function clear() {
    const removed = items.length;
    items = [];
    save();
    return { ok: true, removed };
  }

  function count() {
    return items.length;
  }

  return { add, list, remove, clear, count };
}

module.exports = { createHistoryStore, MAX_ENTRIES };
