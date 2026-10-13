// Data model for ProxyPilot options. Storage keys and protocol values are
// kept stable so existing option files keep working across versions.

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'proxypilot.options';

export const BUILTIN = { DIRECT: 'direct', SYSTEM: 'system' };
export const PROFILE_TYPE = { FIXED: 'fixed', PAC: 'pac', AUTO: 'auto' };

// Rule condition kinds. The values are persisted inside option files.
export const RuleKind = {
  HOST_WILDCARD: 'HostWildcard',
  HOST_REGEX: 'HostRegex',
  URL_WILDCARD: 'UrlWildcard',
  URL_REGEX: 'UrlRegex',
};

export const SCHEMES = ['http', 'https', 'socks4', 'socks5'];
export const DEFAULT_PORT = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

// Messages understood by the desktop main process.
export const Message = {
  GET_STATE: 'getState',
  SWITCH_PROFILE: 'switchProfile',
  SAVE_OPTIONS: 'saveOptions',
  APPLY_ACTIVE: 'applyActive',
  ADD_RULE: 'addQuickRule',
  CONTROL: 'getLevelOfControl',
};

export function blankProfile(name, type, existing = {}) {
  const used = new Set(Object.values(existing).map((p) => (p.color || '').toLowerCase()));
  const palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  const color = palette.find((c) => !used.has(c.toLowerCase())) || palette[Object.keys(existing).length % palette.length];
  const base = { name, type, color };
  if (type === PROFILE_TYPE.FIXED) {
    return { ...base, fallbackProxy: { scheme: 'http', host: '', port: 80, auth: null }, bypassList: ['127.0.0.1', '::1', 'localhost', '<local>'] };
  }
  if (type === PROFILE_TYPE.PAC) return { ...base, pacUrl: '', pacScript: '' };
  if (type === PROFILE_TYPE.AUTO) {
    return { ...base, defaultProfileName: BUILTIN.DIRECT, rules: [] };
  }
  return base;
}

export function defaultOptions() {
  const proxy = blankProfile('代理服务器', PROFILE_TYPE.FIXED, {});
  proxy.fallbackProxy = { scheme: 'http', host: '127.0.0.1', port: 7890, auth: null };
  const auto = blankProfile('自动切换', PROFILE_TYPE.AUTO, { 代理服务器: proxy });
  auto.rules = [{ condition: { type: RuleKind.HOST_WILDCARD, pattern: '*.google.com' }, profileName: '代理服务器' }];
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProfile: BUILTIN.DIRECT,
    settings: { theme: 'dark', lang: 'zh', startupProfile: '' },
    profiles: { 代理服务器: proxy, 自动切换: auto },
  };
}
