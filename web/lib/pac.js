// Proxy Auto-Config document generation for the desktop system PAC endpoint.

import { BUILTIN, PROFILE_TYPE, RuleKind } from './model.js';

const PAC_SCHEME = { http: 'PROXY', https: 'HTTPS', socks4: 'SOCKS', socks5: 'SOCKS5' };

const literal = (value) => JSON.stringify(String(value));

function endpoint(server) {
  if (!server || !server.host) return 'DIRECT';
  let host = String(server.host).trim();
  if (host.includes(':') && !host.startsWith('[')) host = '[' + host + ']';
  return (PAC_SCHEME[server.scheme] || 'PROXY') + ' ' + host + ':' + Number(server.port);
}

// Wildcard patterns that start with "*." also cover the bare domain, so
// "*.example.com" matches both "example.com" and every subdomain.
function wildcardTests(pattern) {
  const list = [literal(pattern.toLowerCase())];
  if (pattern.startsWith('*.')) list.push(literal(pattern.slice(2).toLowerCase()));
  return list.map((value) => 'shExpMatch(host, ' + value + ')');
}

function conditionTest(kind, pattern) {
  const lower = pattern.trim().toLowerCase();
  switch (kind) {
    case RuleKind.HOST_WILDCARD: return wildcardTests(pattern.trim()).join(' || ');
    case RuleKind.HOST_REGEX: return 'reHost(' + literal(pattern) + ', host)';
    case RuleKind.URL_WILDCARD: return 'shExpMatch(url, ' + literal(pattern) + ')';
    case RuleKind.URL_REGEX: return 'reUrl(' + literal(pattern) + ', url)';
    default: return '';
  }
}

// Resolve a profile reference to a PAC result string.
function resultFor(name, options, depth = 0) {
  if (!name || name === BUILTIN.DIRECT || name === BUILTIN.SYSTEM) return 'DIRECT';
  if (depth > 3) return 'DIRECT';
  const profile = options.profiles[name];
  if (!profile) return 'DIRECT';
  if (profile.type === PROFILE_TYPE.FIXED) return endpoint(profile.fallbackProxy);
  if (profile.type === PROFILE_TYPE.AUTO) return generateAutoPac(profile, options, depth + 1).fallback;
  return 'DIRECT';
}

// Emit an auto-switch PAC body. Returns the script plus its fallback result
// so parent profiles can inline it.
export function generateAutoPac(profile, options, depth = 0) {
  const lines = ['function FindProxyForURL(url, host) {', '  host = host.toLowerCase();'];
  const helpers = [];
  for (const rule of profile.rules || []) {
    const pattern = (rule.condition?.pattern || '').trim();
    if (!pattern) continue;
    const target = resultFor(rule.profileName, options, depth);
    const test = conditionTest(rule.condition?.type || RuleKind.HOST_WILDCARD, pattern);
    if (!test) continue;
    if (test.includes('reHost(')) {
      helpers.push('var reHost' + helpers.length + ' = new RegExp(' + literal(pattern) + ', "i");');
      lines.push('  if (reHost' + (helpers.length - 1) + '.test(host)) return ' + JSON.stringify(target) + ';');
      continue;
    }
    if (test.includes('reUrl(')) {
      helpers.push('var reUrl' + helpers.length + ' = new RegExp(' + literal(pattern) + ', "i");');
      lines.push('  if (reUrl' + (helpers.length - 1) + '.test(url)) return ' + JSON.stringify(target) + ';');
      continue;
    }
    lines.push('  if (' + test + ') return ' + JSON.stringify(target) + ';');
  }
  const fallback = resultFor(profile.defaultProfileName, options, depth);
  lines.push('  return ' + JSON.stringify(fallback) + ';', '}');
  const helperBlock = helpers.length ? helpers.join('\n') + '\n' : '';
  return { script: helperBlock + lines.join('\n'), fallback };
}

// Build the PAC document served for a given active profile.
export function buildSystemPac(name, options) {
  if (name === BUILTIN.DIRECT || name === BUILTIN.SYSTEM || !options.profiles[name]) {
    return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }
  const profile = options.profiles[name];
  if (profile.type === PROFILE_TYPE.PAC && profile.pacScript && profile.pacScript.trim()) {
    return profile.pacScript;
  }
  if (profile.type === PROFILE_TYPE.AUTO) {
    return generateAutoPac(profile, options).script;
  }
  if (profile.type !== PROFILE_TYPE.FIXED || !profile.fallbackProxy) {
    return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }
  const bypass = [];
  for (const raw of profile.bypassList || []) {
    const pattern = String(raw).trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === '<local>') bypass.push("host.indexOf('.') === -1");
    else bypass.push(...wildcardTests(pattern));
  }
  return [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    '  if (' + (bypass.join(' || ') || 'false') + ') return "DIRECT";',
    '  return ' + JSON.stringify(endpoint(profile.fallbackProxy)) + ';',
    '}',
  ].join('\n');
}
