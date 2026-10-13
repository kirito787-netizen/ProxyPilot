// Host matching used by the current-site block. Pattern semantics mirror the
// PAC builder in pac.js, so what the UI shows matches what the system PAC does.

export function normalizeHost(value) {
  let text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text.includes('://')) {
    try { text = new URL(text).hostname || text; } catch (_) { /* keep raw */ }
  }
  return text.split('/')[0].split(':')[0].trim();
}

function wildcardMatch(pattern, value) {
  const source = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, (ch) => '\\' + ch)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(source + '$', 'i').test(value);
}

export function hostMatches(type, pattern, host) {
  const trimmed = String(pattern || '').trim();
  if (!trimmed || !host) return false;
  try {
    if (type === 'host-wildcard' || type === 'url-wildcard') {
      return wildcardMatch(trimmed, host) || (trimmed.startsWith('*.') && host === trimmed.slice(2));
    }
    if (type === 'host-regex') return new RegExp(trimmed, 'i').test(host);
    if (type === 'url-regex') return new RegExp(trimmed, 'i').test(host);
  } catch (_) {
    return false;
  }
  return false;
}
