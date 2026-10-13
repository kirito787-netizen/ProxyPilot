// Profile helpers: descriptors, validation, and resolution.

import {
  BUILTIN,
  BUILTIN_COLORS,
  PROFILE_TYPE,
  PALETTE,
  SCHEME_DEFAULT_PORT,
} from './constants.js';

// Identity translator used when no i18n function is supplied.
const ID = (k) => k;

// A uniform descriptor used by popup/options to render any profile,
// including the two builtin pseudo-profiles. Pass `t` to localize builtin labels.
export function describe(name, opts, t = ID) {
  if (name === BUILTIN.DIRECT) {
    return { name, kind: 'builtin', type: 'direct', label: t('builtin.direct'), color: BUILTIN_COLORS.direct };
  }
  if (name === BUILTIN.SYSTEM) {
    return { name, kind: 'builtin', type: 'system', label: t('builtin.system'), color: BUILTIN_COLORS.system };
  }
  const p = opts.profiles[name];
  if (!p) return { name, kind: 'missing', type: 'unknown', label: name, color: '#94A3B8' };
  // User profile names are data — never translated.
  return { name, kind: 'user', type: p.type, label: p.name, color: p.color || '#4F8CFF', profile: p };
}

// Ordered list of all selectable profiles (builtins first).
export function listProfiles(opts, t = ID) {
  const out = [describe(BUILTIN.DIRECT, opts, t), describe(BUILTIN.SYSTEM, opts, t)];
  for (const name of Object.keys(opts.profiles)) {
    out.push(describe(name, opts, t));
  }
  return out;
}

// One-line summary of where a profile sends traffic, for list rows.
export function summarize(name, opts, t = ID) {
  if (name === BUILTIN.DIRECT) return t('sum.direct');
  if (name === BUILTIN.SYSTEM) return t('sum.system');
  const p = opts.profiles[name];
  if (!p) return t('sum.missing');
  if (p.type === PROFILE_TYPE.FIXED && p.fallbackProxy) {
    const s = p.fallbackProxy;
    return t('sum.fixed', { scheme: s.scheme.toUpperCase(), host: s.host || '—', port: s.port });
  }
  if (p.type === PROFILE_TYPE.PAC) {
    return p.pacUrl ? t('sum.pacUrl', { url: p.pacUrl }) : t('sum.pac');
  }
  if (p.type === PROFILE_TYPE.AUTO) {
    return t('sum.auto', { n: (p.rules || []).length });
  }
  return '';
}

// Pick the next palette color not already used by a profile.
export function nextColor(opts) {
  const used = new Set(Object.values(opts.profiles).map((p) => (p.color || '').toLowerCase()));
  for (const c of PALETTE) {
    if (!used.has(c.toLowerCase())) return c;
  }
  return PALETTE[Object.keys(opts.profiles).length % PALETTE.length];
}

// Build a blank profile of the given type.
export function blankProfile(name, type, opts) {
  const base = { name, type, color: nextColor(opts) };
  if (type === PROFILE_TYPE.FIXED) {
    return {
      ...base,
      fallbackProxy: { scheme: 'http', host: '', port: SCHEME_DEFAULT_PORT.http, auth: null },
      bypassList: ['127.0.0.1', '::1', 'localhost', '<local>'],
    };
  }
  if (type === PROFILE_TYPE.PAC) {
    return { ...base, pacUrl: '', pacScript: '' };
  }
  if (type === PROFILE_TYPE.AUTO) {
    return { ...base, defaultProfileName: BUILTIN.DIRECT, rules: [] };
  }
  return base;
}

// Validate a profile; returns array of { key, params } (empty = valid).
// The UI localizes each via t(key, params).
export function validateProfile(p) {
  const errors = [];
  if (!p.name || !p.name.trim()) errors.push({ key: 'err.nameEmpty' });

  if (p.type === PROFILE_TYPE.FIXED) {
    const s = p.fallbackProxy || {};
    if (!s.host || !s.host.trim()) errors.push({ key: 'err.hostEmpty' });
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push({ key: 'err.portRange' });
  } else if (p.type === PROFILE_TYPE.PAC) {
    if (!p.pacUrl?.trim() && !p.pacScript?.trim()) errors.push({ key: 'err.pacEmpty' });
  } else if (p.type === PROFILE_TYPE.AUTO) {
    (p.rules || []).forEach((r, i) => {
      if (!r.condition?.pattern?.trim()) errors.push({ key: 'err.rulePattern', params: { n: i + 1 } });
      if (!r.profileName) errors.push({ key: 'err.ruleTarget', params: { n: i + 1 } });
    });
  }
  return errors;
}

// True if a name collides with an existing profile or a reserved builtin.
export function nameTaken(name, opts, exceptKey = null) {
  const lower = name.trim().toLowerCase();
  if (lower === BUILTIN.DIRECT || lower === BUILTIN.SYSTEM) return true;
  if (['直接连接', '系统代理', '[direct]', '[system proxy]'].includes(lower)) return true;
  return Object.keys(opts.profiles).some(
    (k) => k !== exceptKey && k.trim().toLowerCase() === lower,
  );
}
