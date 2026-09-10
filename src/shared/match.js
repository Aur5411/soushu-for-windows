/**
 * 搜书吧电脑版 — URL 匹配引擎
 *
 * 这份文件是「双端共用」的：
 *   - 主进程用 require('../shared/match.js') 引用来做界面上的匹配预览
 *   - 注入引擎会把整份源码原样内联进网页里运行
 * 因此这里只能用最朴素的 ES5 写法，不能出现 require / import / 箭头函数。
 */

var SD_ESC_RE = /[.+^${}()|[\]\\/?*]/g;

function sdEsc(s) {
  return String(s).replace(SD_ESC_RE, '\\$&');
}

/**
 * 把一个匹配规则字符串编译成正则。
 * 支持三种写法：
 *   1. /regex/            —— 斜杠包裹的正则
 *   2. *://*.a.com/path*  —— Chrome 扩展风格的 match pattern
 *   3. http://a.com/*     —— 宽松通配符写法
 */
function sdPatternToRegExp(pattern) {
  if (!pattern) return null;
  pattern = String(pattern).trim();
  if (!pattern) return null;

  // 斜杠包裹的正则
  if (pattern.charAt(0) === '/' && pattern.charAt(pattern.length - 1) === '/' && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1));
    } catch (e) {
      return null;
    }
  }

  // Chrome match pattern: <scheme>://<host><path>
  var m = /^(\*|https?|file|ftp|ws|wss):\/\/([^\/]*)(\/.*)?$/i.exec(pattern);
  if (m) {
    var scheme = m[1];
    var host = m[2];
    var pathPart = m[3] || '/*';

    if (scheme === '*') {
      scheme = '(?:https?|file|ftp|ws|wss)';
    } else {
      scheme = scheme.toLowerCase();
    }

    var hostRe;
    if (host === '*') {
      hostRe = '[^/]+';
    } else if (host.indexOf('*.') === 0) {
      // *.example.com 需要同时匹配 example.com 与其子域
      hostRe = '(?:[^/]+\\.)?' + sdEsc(host.slice(2));
    } else {
      hostRe = sdEsc(host).replace(/\\\*/g, '[^/]*');
    }

    var pathRe = sdEsc(pathPart).replace(/\\\*/g, '.*');

    try {
      return new RegExp('^' + scheme + '://' + hostRe + pathRe + '$');
    } catch (e) {
      return null;
    }
  }

  // 宽松通配符写法
  try {
    return new RegExp('^' + sdEsc(pattern).replace(/\\\*/g, '.*') + '$');
  } catch (e) {
    return null;
  }
}

/** 收集一个脚本上的所有正向规则 */
function sdCollectRules(script) {
  var rules = [];
  if (script.matches) rules = rules.concat(script.matches);
  if (script.includes) rules = rules.concat(script.includes);
  return rules;
}

/** 收集一个脚本上的所有排除规则 */
function sdCollectExcludes(script) {
  var rules = [];
  if (script.excludes) rules = rules.concat(script.excludes);
  if (script.excludeMatches) rules = rules.concat(script.excludeMatches);
  return rules;
}

/**
 * 判断某个 URL 是否应该执行该脚本。
 * 没有任何正向规则的脚本一律不执行（这是有意为之的保守策略）。
 */
function sdMatchUrl(url, script) {
  if (!url || !script) return false;

  var excludes = sdCollectExcludes(script);
  for (var i = 0; i < excludes.length; i++) {
    var ex = sdPatternToRegExp(excludes[i]);
    if (ex && ex.test(url)) return false;
  }

  var rules = sdCollectRules(script);
  if (!rules.length) return false;

  for (var j = 0; j < rules.length; j++) {
    var re = sdPatternToRegExp(rules[j]);
    if (re && re.test(url)) return true;
  }

  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sdEsc: sdEsc,
    sdPatternToRegExp: sdPatternToRegExp,
    sdMatchUrl: sdMatchUrl,
    sdCollectRules: sdCollectRules,
    sdCollectExcludes: sdCollectExcludes
  };
}
