// Shared helpers for the desktop renderer windows.

export const api = window.proxypilot;

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

export function applyTheme(theme) {
  const resolved = theme === 'light' || theme === 'dark'
    ? theme
    : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = resolved;
}

// Storage changes arrive as DOM events relayed by the preload bridge.
export function onStorageChanged(handler) {
  window.addEventListener('proxypilot:storage-changed', (event) => {
    const detail = event.detail || {};
    const change = (detail.changes || {})['proxypilot.options'];
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
    const server = profile.server || {};
    return (server.scheme || 'http').toUpperCase() + ' ' + (server.host || '—') + ':' + (server.port || '');
  }
  if (profile.type === 'pac') return profile.pacUrl ? 'PAC · ' + profile.pacUrl : 'PAC';
  if (profile.type === 'auto') return t('type.auto') + ' · ' + (profile.rules || []).length;
  return '';
}
