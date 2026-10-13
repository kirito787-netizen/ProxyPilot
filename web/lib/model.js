// Data model for ProxyPilot options. Option files written by older builds
// (schema v1) are migrated on load: legacy PascalCase rule-kind values map
// to the current kebab-case values and the legacy storage key is re-read
// once before being dropped.

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'proxypilot/store';
export const LEGACY_STORAGE_KEY = 'proxypilot.options';

export const BUILTIN = { DIRECT: 'direct', SYSTEM: 'system' };
export const PROFILE_TYPE = { FIXED: 'fixed', PAC: 'pac', AUTO: 'auto' };

// Rule condition kinds. The values are persisted inside option files.
export const RuleKind = {
  HOST_WILDCARD: 'host-wildcard',
  HOST_REGEX: 'host-regex',
  URL_WILDCARD: 'url-wildcard',
  URL_REGEX: 'url-regex',
};

const LEGACY_RULE_KINDS = {
  HostWildcard: RuleKind.HOST_WILDCARD,
  HostRegex: RuleKind.HOST_REGEX,
  UrlWildcard: RuleKind.URL_WILDCARD,
  UrlRegex: RuleKind.URL_REGEX,
};

export function normalizeRuleKind(type) {
  return LEGACY_RULE_KINDS[type] || type;
}

// Migrates rule conditions written by older builds, in place.
export function normalizeOptions(options) {
  for (const profile of Object.values(options?.profiles || {})) {
    for (const rule of profile?.rules || []) {
      if (rule?.condition && typeof rule.condition.type === 'string') {
        rule.condition.type = normalizeRuleKind(rule.condition.type);
      }
    }
  }
  return options;
}

export const SCHEMES = ['http', 'https', 'socks4', 'socks5'];
export const DEFAULT_PORT = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

// Messages understood by the desktop main process.
export const Message = {
  GET_STATE: 'state.get',
  SWITCH_PROFILE: 'profile.switch',
  SAVE_OPTIONS: 'options.save',
  APPLY_ACTIVE: 'proxy.apply',
  ADD_RULE: 'rule.addQuick',
  FIND_TAB_HOST: 'tab.findHost',
  TAB_RELATED_HOSTS: 'tab.relatedHosts',
  ADD_RULES_BULK: 'rules.addBulk',
  CONTROL: 'control.level',
  STATS_GET: 'stats.get',
  STATS_RESET: 'stats.reset',
  SUBS_LIST: 'subs.list',
  SUBS_ADD: 'subs.add',
  SUBS_REMOVE: 'subs.remove',
  SUBS_REFRESH: 'subs.refresh',
};

export function freshProfile(name, type, existing = {}) {
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

export function initialOptions() {
  const proxy = freshProfile('代理服务器', PROFILE_TYPE.FIXED, {});
  proxy.fallbackProxy = { scheme: 'http', host: '127.0.0.1', port: 7890, auth: null };
  const auto = freshProfile('自动切换', PROFILE_TYPE.AUTO, { 代理服务器: proxy });
  auto.rules = [{ condition: { type: RuleKind.HOST_WILDCARD, pattern: '*.google.com' }, profileName: '代理服务器' }];
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProfile: BUILTIN.DIRECT,
    settings: { theme: 'dark', lang: 'zh', startupProfile: '' },
    profiles: { 代理服务器: proxy, 自动切换: auto },
    subscriptions: [],
  };
}
