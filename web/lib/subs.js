// Subscription model shared by the desktop app and the extension.
// A subscription watches a remote URL and keeps a validated local copy:
// kind 'pac' feeds a PAC profile's script, kind 'config' syncs the profiles
// table from a ProxyPilot options JSON. This is configuration sync — there
// is no clash kernel here, so node-list subscriptions are out of scope.

export const SUBS_STORAGE_KEY = 'proxypilot/subs';
export const SUBS_DEFAULT_INTERVAL = 1440; // minutes (24h)
export const SUBS_TIMEOUT_MS = 20000;

export function normalizeSubUrl(raw) {
  const text = String(raw || '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (!url.hostname) return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

// Content must pass validation before it may replace any local state.
export function validateSubscriptionContent(kind, content) {
  const text = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!text) return '内容为空';
  if (kind === 'pac') {
    if (!/FindProxyForURL/.test(text)) return 'PAC 内容缺少 FindProxyForURL';
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '配置不是 JSON 对象';
    if (parsed.schemaVersion === undefined) return '配置缺少 schemaVersion';
    if (!parsed.profiles || typeof parsed.profiles !== 'object') return '配置缺少 profiles';
    return null;
  } catch (_) {
    return '配置不是合法 JSON';
  }
}

// Parse the airport traffic header: upload=..; download=..; total=..; expire=..
export function parseSubUserInfo(value) {
  const text = String(value || '');
  if (!text) return null;
  const pick = (key) => {
    const match = text.match(new RegExp(key + '=([0-9]+)'));
    return match ? Number(match[1]) : 0;
  };
  const info = { upload: pick('upload'), download: pick('download'), total: pick('total'), expire: pick('expire') };
  if (!info.upload && !info.download && !info.total && !info.expire) return null;
  return info;
}

export function blankSubscription(input, now = Date.now()) {
  const source = input || {};
  return {
    id: 'sub-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: String(source.name || '').trim(),
    url: normalizeSubUrl(source.url) || '',
    kind: source.kind === 'config' ? 'config' : 'pac',
    targetProfile: String(source.targetProfile || ''),
    autoUpdate: source.autoUpdate !== false,
    updateInterval: Number(source.updateInterval) || 0,
    serverInterval: 0,
    updatedAt: 0,
    lastError: null,
    extra: null,
  };
}

export function subIntervalMinutes(sub) {
  if (sub && sub.updateInterval > 0) return sub.updateInterval;
  if (sub && sub.serverInterval > 0) return sub.serverInterval;
  return SUBS_DEFAULT_INTERVAL;
}

export function isSubDue(sub, now = Date.now()) {
  if (!sub || sub.autoUpdate === false) return false;
  return (sub.updatedAt || 0) + subIntervalMinutes(sub) * 60000 <= now;
}

// Fetch one subscription and validate its content. The returned state is
// persisted even on failure so the UI can show "last update failed".
export async function fetchSubscription(sub, fetchImpl, now = Date.now()) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const keepState = () => ({ updatedAt: (sub && sub.updatedAt) || 0, lastError: null, extra: null, serverInterval: (sub && sub.serverInterval) || 0 });
  if (!doFetch) return { ok: false, error: '当前环境无法发起网络请求', state: keepState() };
  const url = normalizeSubUrl(sub && sub.url);
  if (!url) return { ok: false, error: '无效的订阅链接', state: keepState() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBS_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const content = (await response.text()).replace(/^\uFEFF/, '').trim();
    const invalid = validateSubscriptionContent(sub.kind, content);
    if (invalid) throw new Error(invalid);
    const state = keepState();
    state.updatedAt = now;
    const suggested = Number(response.headers && response.headers.get('profile-update-interval'));
    if (suggested > 0) state.serverInterval = suggested * 60;
    try {
      for (const [key, value] of response.headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === 'subscription-userinfo' || lower.endsWith('-subscription-userinfo')) {
          state.extra = parseSubUserInfo(value);
          break;
        }
      }
    } catch (_) { /* header iteration is unavailable in some runtimes */ }
    return { ok: true, content, state };
  } catch (error) {
    const message = String((error && error.message) || error);
    const state = keepState();
    state.lastError = message;
    return { ok: false, error: message, state };
  } finally {
    clearTimeout(timer);
  }
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return (unit === 0 ? String(amount) : amount.toFixed(amount >= 10 ? 0 : 1)) + ' ' + units[unit];
}
