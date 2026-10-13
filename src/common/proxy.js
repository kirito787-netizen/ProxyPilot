// Translates ProxyPilot profiles into chrome.proxy configuration objects,
// including PAC-script generation for auto-switch profiles.

import { BUILTIN, PROFILE_TYPE } from './constants.js';

// Map our scheme to the PAC return keyword.
const PAC_KEYWORD = {
  http: 'PROXY',
  https: 'HTTPS',
  socks4: 'SOCKS',
  socks5: 'SOCKS5',
};

// Build a chrome.proxy `value` object for the given profile name.
// Returns { config } or throws if the profile is unresolvable.
export function buildProxyConfig(name, opts) {
  if (name === BUILTIN.DIRECT) {
    return { mode: 'direct' };
  }
  if (name === BUILTIN.SYSTEM) {
    return { mode: 'system' };
  }

  const p = opts.profiles[name];
  if (!p) throw new Error(`未找到情景模式：${name}`);

  if (p.type === PROFILE_TYPE.FIXED) {
    return fixedConfig(p);
  }
  if (p.type === PROFILE_TYPE.PAC) {
    return pacConfig(p);
  }
  if (p.type === PROFILE_TYPE.AUTO) {
    return { mode: 'pac_script', pacScript: { data: buildAutoPac(p, opts), mandatory: false } };
  }
  throw new Error(`未知的情景类型：${p.type}`);
}

function fixedConfig(p) {
  const s = p.fallbackProxy;
  const singleProxy = {
    scheme: s.scheme,
    host: s.host.trim(),
    port: Number(s.port),
  };
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy,
      bypassList: normalizeBypass(p.bypassList),
    },
  };
}

function pacConfig(p) {
  if (p.pacUrl && p.pacUrl.trim()) {
    return { mode: 'pac_script', pacScript: { url: p.pacUrl.trim(), mandatory: false } };
  }
  return { mode: 'pac_script', pacScript: { data: p.pacScript || '', mandatory: false } };
}

function normalizeBypass(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

// Resolve a (possibly builtin) profile name to a single PAC return string.
function pacReturnFor(name, opts) {
  if (!name || name === BUILTIN.DIRECT || name === BUILTIN.SYSTEM) return 'DIRECT';
  const p = opts.profiles[name];
  if (!p) return 'DIRECT';
  if (p.type === PROFILE_TYPE.FIXED && p.fallbackProxy) {
    const s = p.fallbackProxy;
    const kw = PAC_KEYWORD[s.scheme] || 'PROXY';
    return `${kw} ${s.host.trim()}:${Number(s.port)}`;
  }
  // Nested PAC/auto profiles are not expanded inline; fall back to DIRECT.
  return 'DIRECT';
}

// JS string literal escaper for safe embedding into generated PAC source.
function jsStr(value) {
  return JSON.stringify(String(value));
}

// Convert a host wildcard like "*.example.com" into matcher expressions.
// Returns an array of shExpMatch arguments covering subdomains + bare domain.
function hostWildcardExprs(pattern) {
  const pat = pattern.trim();
  const exprs = [pat];
  if (pat.startsWith('*.')) {
    exprs.push(pat.slice(2)); // also match the apex domain
  }
  return exprs;
}

// Generate a PAC script implementing an auto-switch profile's rules.
export function buildAutoPac(profile, opts) {
  const lines = [];
  lines.push('function FindProxyForURL(url, host) {');
  lines.push('  host = host.toLowerCase();');

  for (const rule of profile.rules || []) {
    const ret = pacReturnFor(rule.profileName, opts);
    const cond = rule.condition || {};
    const pat = cond.pattern || '';
    if (!pat.trim()) continue;

    let test = null;
    switch (cond.type) {
      case 'HostWildcard': {
        const checks = hostWildcardExprs(pat)
          .map((e) => `shExpMatch(host, ${jsStr(e)})`)
          .join(' || ');
        test = checks;
        break;
      }
      case 'UrlWildcard':
        test = `shExpMatch(url, ${jsStr(pat)})`;
        break;
      case 'HostRegex':
        test = `new RegExp(${jsStr(pat)}).test(host)`;
        break;
      case 'UrlRegex':
        test = `new RegExp(${jsStr(pat)}).test(url)`;
        break;
      default:
        continue;
    }
    lines.push(`  if (${test}) return ${jsStr(ret)};`);
  }

  const fallback = pacReturnFor(profile.defaultProfileName, opts);
  lines.push(`  return ${jsStr(fallback)};`);
  lines.push('}');
  return lines.join('\n');
}

// Build a PAC document for a system-wide PAC endpoint used by the desktop app.
export function buildSystemPac(name, opts) {
  if (name === BUILTIN.DIRECT || name === BUILTIN.SYSTEM) {
    return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }
  const p = opts.profiles[name];
  if (!p) throw new Error('未找到情景模式：' + name);
  if (p.type === PROFILE_TYPE.AUTO) return buildAutoPac(p, opts);
  if (p.type === PROFILE_TYPE.PAC && p.pacScript && p.pacScript.trim()) return p.pacScript;
  if (p.type !== PROFILE_TYPE.FIXED || !p.fallbackProxy) return null;

  const s = p.fallbackProxy;
  const kw = PAC_KEYWORD[s.scheme] || 'PROXY';
  const host = s.host.trim();
  const endpointHost = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
  const checks = [];
  for (const raw of normalizeBypass(p.bypassList)) {
    const pattern = String(raw).toLowerCase();
    if (pattern === '<local>') checks.push("host.indexOf('.') === -1");
    else {
      checks.push('shExpMatch(host, ' + jsStr(pattern) + ')');
      if (pattern.startsWith('*.')) checks.push('shExpMatch(host, ' + jsStr(pattern.slice(2)) + ')');
    }
  }
  return [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    '  if (' + (checks.join(' || ') || 'false') + ') return "DIRECT";',
    '  return ' + jsStr(kw + ' ' + endpointHost + ':' + Number(s.port)) + ';',
    '}',
  ].join('\n');
}

// Return cached proxy auth credentials for the active fixed profile, if any.
export function authFor(name, opts) {
  if (!name || name === BUILTIN.DIRECT || name === BUILTIN.SYSTEM) return null;
  const p = opts.profiles[name];
  if (p && p.type === PROFILE_TYPE.FIXED && p.fallbackProxy && p.fallbackProxy.auth) {
    const a = p.fallbackProxy.auth;
    if (a.username) return { username: a.username, password: a.password || '' };
  }
  return null;
}
