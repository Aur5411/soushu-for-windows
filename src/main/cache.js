'use strict';

/**
 * 清空缓存。
 *
 * 只清「丢了能重建」的东西：
 *   - 网页资源缓存（HTTP / 磁盘缓存）
 *   - 代码缓存（编译后的 JS）
 *   - 脚本依赖缓存（@require / @resource 下下来的文件）
 *
 * **绝不碰**：
 *   - Cookie —— 清了会被登出，而用户点这个按钮通常只是「网页显示不对，想让它重新拉」
 *   - localStorage / IndexedDB、浏览历史、脚本文件、已下载的文件
 *
 * 单独成模块是为了能拿真实 session 做测试（尤其「Cookie 还在不在」这件事，
 * 光看代码不放心）。
 */

/**
 * @param {object} deps
 * @param {object}   deps.session        Electron session
 * @param {Function} [deps.clearDepCache] 清脚本依赖缓存，返回 { removed }
 * @param {Function} [deps.log]          日志
 */
function createCacheCleaner(deps) {
  const d = deps || {};
  const say = (msg) => {
    if (typeof d.log === 'function') d.log(msg);
  };

  async function clear() {
    const result = { ok: true, http: false, code: false, deps: 0, freedBytes: 0 };
    const s = d.session;

    // 清之前先记一下能释放多少，好给用户一个具体反馈
    if (s && typeof s.getCacheSize === 'function') {
      try {
        result.freedBytes = (await s.getCacheSize()) || 0;
      } catch (e) {
        result.freedBytes = 0;
      }
    }

    if (s && typeof s.clearCache === 'function') {
      try {
        await s.clearCache();
        result.http = true;
      } catch (e) {
        result.ok = false;
        say('[缓存] 清网页缓存失败：' + ((e && e.message) || e));
      }
    }

    if (s && typeof s.clearCodeCaches === 'function') {
      try {
        await s.clearCodeCaches({});
        result.code = true;
      } catch (e) {
        say('[缓存] 清代码缓存失败：' + ((e && e.message) || e));
      }
    }

    if (typeof d.clearDepCache === 'function') {
      try {
        const r = d.clearDepCache();
        result.deps = (r && r.removed) || 0;
      } catch (e) {
        say('[缓存] 清脚本依赖缓存失败：' + ((e && e.message) || e));
      }
    }

    say(
      `[缓存] 已清空 | 网页=${result.http} 代码=${result.code} 依赖=${result.deps} 个 | ` +
        `释放≈${(result.freedBytes / 1048576).toFixed(1)} MB | Cookie 与登录状态未动`
    );
    return result;
  }

  return { clear };
}

module.exports = { createCacheCleaner };
