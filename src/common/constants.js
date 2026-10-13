// Shared constants & data-model defaults for ProxyPilot.

export const STORAGE_KEY = 'proxypilot.options';
export const SCHEMA_VERSION = 1;

// Builtin pseudo-profiles. They are referenced by name but never stored.
export const BUILTIN = {
  DIRECT: 'direct',
  SYSTEM: 'system',
};

// Profile types for user-created profiles.
export const PROFILE_TYPE = {
  FIXED: 'fixed', // fixed proxy server(s)
  PAC: 'pac', // PAC script (url or inline)
  AUTO: 'auto', // auto-switch by rules
};

// Proxy schemes supported by chrome.proxy fixed_servers + PAC.
export const SCHEMES = ['http', 'https', 'socks4', 'socks5'];

export const SCHEME_LABEL = {
  http: 'HTTP',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5',
};

// Default port per scheme, used to pre-fill the editor.
export const SCHEME_DEFAULT_PORT = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080,
};

// Auto-switch condition types.
export const CONDITION_TYPE = {
  HOST_WILDCARD: 'HostWildcard',
  HOST_REGEX: 'HostRegex',
  URL_WILDCARD: 'UrlWildcard',
  URL_REGEX: 'UrlRegex',
};

export const CONDITION_LABEL = {
  HostWildcard: '主机通配符',
  HostRegex: '主机正则',
  UrlWildcard: '网址通配符',
  UrlRegex: '网址正则',
};

// A curated palette for profile color dots / badges.
export const PALETTE = [
  '#4F8CFF',
  '#22C55E',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#EC4899',
  '#14B8A6',
  '#6366F1',
  '#F97316',
  '#0EA5E9',
];

export const BUILTIN_COLORS = {
  direct: '#64748B',
  system: '#94A3B8',
};

export const MSG = {
  GET_STATE: 'getState',
  SWITCH_PROFILE: 'switchProfile',
  SAVE_OPTIONS: 'saveOptions',
  APPLY_ACTIVE: 'applyActive',
  GET_LEVEL_OF_CONTROL: 'getLevelOfControl',
  ADD_QUICK_RULE: 'addQuickRule',
};

// Default options object created on first run.
export function defaultOptions() {
  const localPort = 7890;
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProfile: BUILTIN.DIRECT,
    settings: {
      theme: 'dark', // auto | light | dark
      lang: 'zh', // en | zh | ja
      showQuickSwitch: true,
      refreshTabOnChange: false,
      startupProfile: '', // '' = keep current applied profile
    },
    profiles: {
      代理服务器: {
        name: '代理服务器',
        type: PROFILE_TYPE.FIXED,
        color: '#4F8CFF',
        fallbackProxy: {
          scheme: 'http',
          host: '127.0.0.1',
          port: localPort,
          auth: null,
        },
        bypassList: ['127.0.0.1', '::1', 'localhost', '<local>'],
      },
      自动切换: {
        name: '自动切换',
        type: PROFILE_TYPE.AUTO,
        color: '#22C55E',
        defaultProfileName: BUILTIN.DIRECT,
        rules: [
          {
            condition: { type: CONDITION_TYPE.HOST_WILDCARD, pattern: '*.google.com' },
            profileName: '代理服务器',
          },
        ],
      },
    },
  };
}
