// UI helpers and the extension message bridge shared by the popup and the
// options page. Mirrors the desktop renderer bridge (app/shared.js) so the
// page logic stays close to its desktop counterpart.

import { STORAGE_KEY } from './model.js';

export const api = {
  version: chrome.runtime.getManifest().version,
  call(message) {
    return chrome.runtime.sendMessage(message);
  },
  openOptions() {
    chrome.runtime.openOptionsPage();
  },
};

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'value' || key === 'checked' || key === 'selected') element[key] = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function setThemeMode(theme) {
  const resolved = theme === 'light' || theme === 'dark'
    ? theme
    : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = resolved;
}

// Options live in chrome.storage.local under the desktop storage key, so
// exported desktop backups import unchanged.
export function onStorageChanged(handler) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEY];
    if (change) handler(change.newValue || null, change.oldValue || null);
  });
}

export function describeProfile(name, options, t) {
  if (name === 'direct') return { name, builtin: true, label: t('profile.direct'), color: '#64748b', type: 'direct' };
  if (name === 'system') return { name, builtin: true, label: t('profile.system'), color: '#94a3b8', type: 'system' };
  const profile = options.profiles[name];
  if (!profile) return { name, builtin: false, missing: true, label: name, color: '#94a3b8', type: 'unknown' };
  return { name, builtin: false, label: profile.name || name, color: profile.color || '#3b82f6', type: profile.type, profile };
}

export function summarizeProfile(name, options, t) {
  if (name === 'direct') return t('profile.direct');
  if (name === 'system') return t('profile.system');
  const profile = options.profiles[name];
  if (!profile) return '—';
  if (profile.type === 'fixed') {
    const server = profile.fallbackProxy || {};
    return (server.scheme || 'http').toUpperCase() + ' ' + (server.host || '—') + ':' + (server.port || '');
  }
  if (profile.type === 'pac') return profile.pacUrl ? 'PAC · ' + profile.pacUrl : 'PAC';
  if (profile.type === 'auto') return t('type.auto') + ' · ' + (profile.rules || []).length;
  return '';
}
