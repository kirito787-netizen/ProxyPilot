// Small shared UI helpers for popup & options pages.
import { platform } from './platform.js';

// Resolve 'auto' against the OS preference, then set [data-theme].
export function applyTheme(theme) {
  let resolved = theme;
  if (theme === 'auto' || !theme) {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// Two-letter scheme glyph shown in the terminal rows, matching the design.
const GLYPH = {
  direct: 'DR',
  system: 'SY',
  pac: 'PA',
  auto: 'AU',
  http: 'HT',
  https: 'HS',
  socks4: 'S4',
  socks5: 'S5',
};

// Glyph for a profile descriptor (builtin or user).
export function glyphFor(desc) {
  if (desc.type === 'direct') return GLYPH.direct;
  if (desc.type === 'system') return GLYPH.system;
  if (desc.type === 'pac') return GLYPH.pac;
  if (desc.type === 'auto') return GLYPH.auto;
  if (desc.type === 'fixed') {
    const scheme = desc.profile?.fallbackProxy?.scheme;
    return GLYPH[scheme] || 'FX';
  }
  return '··';
}

export function latencyClass(ms) {
  if (ms == null) return 'lat-na';
  if (ms < 30) return 'lat-good';
  if (ms < 80) return 'lat-ok';
  if (ms < 150) return 'lat-mid';
  return 'lat-bad';
}

// Messaging wrapper.
export function send(message) {
  return platform.runtime.sendMessage(message);
}
