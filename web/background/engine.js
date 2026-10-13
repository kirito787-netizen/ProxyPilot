// ProxyPilot extension engine. Maps the shared profile model onto the
// chrome.proxy settings API and answers proxy authentication challenges.
// All popup/options traffic funnels through here so exactly one context
// writes proxy settings and options storage.

import {
  BUILTIN, LEGACY_STORAGE_KEY, normalizeOptions, PROFILE_TYPE, SCHEMA_VERSION, STORAGE_KEY, initialOptions,
} from '../lib/model.js';
import { generateAutoPac } from '../lib/pac.js';
import { normalizeHost } from '../lib/site.js';
import {
  STATS_KEY, classifyRoute, emptyStats, markActive, pruneStats, recordRequest, resetStats,
} from '../lib/stats.js';

const REGULAR = { scope: 'regular' };
const AUTH_RETRY_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_TRIES = 3;

let proxyError = null;
let engineLabel = 'DIRECT';
// Routing snapshot refreshed on every successful apply so the request
// counter can classify traffic without reading storage per request.
let routeContext = null;
let statsCache = null;
let statsDirty = false;
let statsFlushTimer = null;
let countedRequests = 0;
// Self-writes also fire storage.onChanged in this worker; the counter keeps
// the change listener from re-applying (and re-broadcasting) those.
let selfWrites = 0;
// host:port:realm -> { count, at } to avoid retry loops with bad credentials.
const authAttempts = new Map();

// ---- options storage ----

export async function loadOptions() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
  const raw = (stored && stored[STORAGE_KEY]) || (stored && stored[LEGACY_STORAGE_KEY]);
  if (!raw || typeof raw !== 'object' || !raw.profiles || typeof raw.profiles !== 'object') {
    const fresh = initialOptions();
    selfWrites++;
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
    return fresh;
  }
  normalizeOptions(raw);
  const defs = initialOptions();
  const options = {
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    settings: { ...defs.settings, ...(raw.settings || {}) },
    profiles: raw.profiles,
    activeProfile: raw.activeProfile || BUILTIN.DIRECT,
  };
  if (!stored[STORAGE_KEY] && stored[LEGACY_STORAGE_KEY]) {
    // One-time move to the current storage key; drop the legacy entry.
    selfWrites++;
    await chrome.storage.local.set({ [STORAGE_KEY]: options });
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
  }
  return options;
}

async function persistOptions(opts) {
  selfWrites++;
  await chrome.storage.local.set({ [STORAGE_KEY]: opts });
}

// ---- proxy application ----

function proxyResult(server) {
  const scheme = ['http', 'https', 'quic', 'socks4', 'socks5'].includes(server.scheme) ? server.scheme : 'http';
  return { scheme, host: String(server.host || ''), port: Number(server.port) };
}

function fixedRules(profile) {
  const rules = { fallbackProxy: proxyResult(profile.fallbackProxy || {}) };
  const bypass = (profile.bypassList || []).map((line) => String(line).trim()).filter(Boolean);
  if (bypass.length) rules.bypassList = bypass;
  return rules;
}

async function setProxy(value) {
  await chrome.proxy.settings.set({ ...REGULAR, value });
}

async function applyProxySettings(name, opts) {
  const profile = opts.profiles[name];
  if (name === BUILTIN.SYSTEM) {
    // Hand control back to the browser, which follows the OS proxy settings.
    await chrome.proxy.settings.clear(REGULAR);
    engineLabel = 'SYSTEM';
    return;
  }
  if (!profile) {
    if (name === BUILTIN.DIRECT) {
      await setProxy({ mode: 'direct' });
      engineLabel = 'DIRECT';
      return;
    }
    throw new Error('未找到情景模式：' + name);
  }
  if (profile.type === PROFILE_TYPE.FIXED && !profile.fallbackProxy) {
    await setProxy({ mode: 'direct' });
    engineLabel = 'DIRECT';
    return;
  }
  if (profile.type === PROFILE_TYPE.FIXED) {
    if (!profile.fallbackProxy.host) throw new Error('固定代理没有填写服务器地址');
    await setProxy({ mode: 'fixed_servers', rules: fixedRules(profile) });
    const server = profile.fallbackProxy;
    engineLabel = 'FIXED · ' + server.host + ':' + server.port;
    return;
  }
  if (profile.type === PROFILE_TYPE.PAC) {
    if (profile.pacUrl && profile.pacUrl.trim()) {
      await setProxy({ mode: 'pac_script', pacScript: { url: profile.pacUrl.trim(), mandatory: true } });
      engineLabel = 'PAC · ' + profile.pacUrl.trim();
    } else if (profile.pacScript && profile.pacScript.trim()) {
      await setProxy({ mode: 'pac_script', pacScript: { data: profile.pacScript, mandatory: true } });
      engineLabel = 'PAC · script';
    } else {
      throw new Error('PAC 情景需要网址或脚本');
    }
    return;
  }
  if (profile.type === PROFILE_TYPE.AUTO) {
    await setProxy({ mode: 'pac_script', pacScript: { data: generateAutoPac(profile, opts).script, mandatory: true } });
    engineLabel = 'PAC · auto';
    return;
  }
  await setProxy({ mode: 'direct' });
  engineLabel = 'DIRECT';
}

// Apply a profile, then record it as the active one for statistics.
async function applyProxy(name, opts) {
  await applyProxySettings(name, opts);
  routeContext = { name, options: opts };
  try { await markProxyActive(name); } catch (_) { /* statistics never break proxying */ }
}

// ---- usage statistics ----

async function loadStats() {
  if (statsCache) return statsCache;
  const stored = await chrome.storage.local.get(STATS_KEY);
  const parsed = stored && stored[STATS_KEY];
  statsCache = parsed && typeof parsed === 'object' && parsed.days ? parsed : emptyStats();
  pruneStats(statsCache);
  return statsCache;
}

async function flushStats() {
  if (statsFlushTimer) { clearTimeout(statsFlushTimer); statsFlushTimer = null; }
  if (!statsDirty || !statsCache) return;
  statsDirty = false;
  try {
    await chrome.storage.local.set({ [STATS_KEY]: statsCache });
  } catch (_) {
    statsDirty = true;
  }
}

// MV3 may kill the worker before the debounce fires, which can lose a few
// seconds of request counters; switch events always flush immediately.
function scheduleStatsFlush() {
  statsDirty = true;
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => { statsFlushTimer = null; flushStats(); }, 10000);
  if (typeof statsFlushTimer.unref === 'function') statsFlushTimer.unref();
}

async function markProxyActive(name) {
  const stats = await loadStats();
  markActive(stats, name);
  pruneStats(stats);
  statsDirty = true;
  await flushStats();
}

async function recordObservedRequest(details) {
  try {
    if (!details || !details.url || !routeContext) return;
    const host = normalizeHost(details.url);
    if (!host) return;
    const decision = classifyRoute(routeContext.options, host, details.url);
    if (decision.via === 'skip') return;
    const stats = await loadStats();
    recordRequest(stats, decision, host);
    if (++countedRequests % 25 === 0) await flushStats();
    else scheduleStatsFlush();
  } catch (_) { /* statistics never break proxying */ }
}

async function controlLevel() {
  try {
    const details = await chrome.proxy.settings.get(REGULAR);
    return details && details.levelOfControl ? details.levelOfControl : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

async function updateBadge(opts) {
  const name = opts.activeProfile;
  let text = '';
  let color = '#64748b';
  let label = name;
  if (name === BUILTIN.DIRECT) { text = 'DI'; color = '#64748b'; label = 'Direct'; }
  else if (name === BUILTIN.SYSTEM) { text = 'SY'; color = '#94a3b8'; label = 'System'; }
  else {
    const profile = opts.profiles[name];
    if (profile) { text = String(profile.name || name).slice(0, 2); color = profile.color || '#3b82f6'; label = profile.name || name; }
  }
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title: 'ProxyPilot — ' + label });
  } catch (_) { /* action API unavailable in some test contexts */ }
}

async function switchProfile(name) {
  const previous = await loadOptions();
  const candidate = structuredClone(previous);
  candidate.activeProfile = name;
  try {
    await applyProxy(name, candidate);
  } catch (error) {
    proxyError = String((error && error.message) || error);
    try { await applyProxy(previous.activeProfile, previous); } catch (_) { /* keep first error */ }
    throw error;
  }
  proxyError = null;
  await persistOptions(candidate);
  await updateBadge(candidate);
  return candidate;
}

async function saveOptionsMessage(opts) {
  const previous = await loadOptions();
  try {
    await applyProxy(opts.activeProfile, opts);
  } catch (error) {
    proxyError = String((error && error.message) || error);
    try { await applyProxy(previous.activeProfile, previous); } catch (_) { /* keep first error */ }
    throw error;
  }
  proxyError = null;
  await persistOptions(opts);
  await updateBadge(opts);
  return opts;
}

// ---- proxy authentication ----

function authCandidates(opts) {
  const out = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    const profile = opts.profiles[name];
    if (!profile || profile.type !== PROFILE_TYPE.FIXED) return;
    const auth = profile.fallbackProxy && profile.fallbackProxy.auth;
    if (auth && (auth.username || auth.password)) {
      out.push({
        host: stripBrackets(String(profile.fallbackProxy.host || '').toLowerCase()),
        port: Number(profile.fallbackProxy.port),
        username: auth.username || '',
        password: auth.password || '',
      });
    }
  };
  add(opts.activeProfile);
  for (const key of Object.keys(opts.profiles)) add(key);
  return out;
}

function stripBrackets(host) {
  return String(host || '').replace(/^\[|\]$/g, '');
}

async function handleAuthChallenge(details, callback) {
  if (!details || details.isProxy !== true || typeof callback !== 'function') {
    if (typeof callback === 'function') callback();
    return;
  }
  const host = stripBrackets(String((details.challenger && details.challenger.host) || '').toLowerCase());
  const port = Number((details.challenger && details.challenger.port) || 0);
  const key = host + ':' + port + ':' + (details.realm || '');
  const now = Date.now();
  const attempt = authAttempts.get(key);
  if (!attempt || now - attempt.at > AUTH_RETRY_WINDOW_MS) {
    authAttempts.set(key, { count: 0, at: now });
  }
  const current = authAttempts.get(key);
  if (current.count >= AUTH_MAX_TRIES) { callback(); return; }
  const opts = await loadOptions();
  const candidates = authCandidates(opts);
  const exact = candidates.filter((item) => item.host === host && item.port === port);
  const pick = exact[0] || (candidates.length === 1 ? candidates[0] : null);
  if (!pick) { callback(); return; }
  current.count += 1;
  current.at = now;
  callback({ authCredentials: { username: pick.username, password: pick.password } });
}

// ---- tab helpers ----

async function findTabHost() {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (_) { return null; }
  if (!tab || !tab.url) return null;
  try {
    return new URL(tab.url).hostname || null;
  } catch (_) {
    return null;
  }
}

// ---- message hub ----

async function handleMessage(message) {
  const opts = await loadOptions();
  switch (message && message.type) {
    case 'state.get':
      return {
        ok: true,
        opts,
        levelOfControl: proxyError ? 'not_controllable' : await controlLevel(),
        proxyError,
        engine: engineLabel,
      };
    case 'profile.switch':
      return { ok: true, opts: await switchProfile(message.name) };
    case 'options.save':
      return { ok: true, opts: await saveOptionsMessage(message.opts) };
    case 'proxy.apply': {
      try {
        await applyProxy(opts.activeProfile, opts);
      } catch (error) {
        proxyError = String((error && error.message) || error);
        throw error;
      }
      proxyError = null;
      await updateBadge(opts);
      return { ok: true };
    }
    case 'rule.addQuick': {
      const auto = opts.profiles[message.autoProfileName];
      if (!auto || auto.type !== PROFILE_TYPE.AUTO) throw new Error('目标不是自动切换情景');
      auto.rules = auto.rules || [];
      auto.rules.unshift({
        condition: { type: message.conditionType || 'host-wildcard', pattern: message.pattern },
        profileName: message.targetProfileName,
      });
      return { ok: true, opts: await saveOptionsMessage(opts) };
    }
    case 'tab.findHost':
      return { ok: true, host: await findTabHost() };
    case 'control.level':
      return { ok: true, levelOfControl: await controlLevel() };
    case 'stats.get': {
      const stats = await loadStats();
      await flushStats();
      return { ok: true, stats };
    }
    case 'stats.reset': {
      statsCache = resetStats(await loadStats());
      statsDirty = true;
      await flushStats();
      return { ok: true, stats: statsCache };
    }
    default:
      return { ok: false, error: '未知消息类型：' + ((message && message.type) || '(none)') };
  }
}

// One error funnel shared by the runtime listener and the test dispatch:
// failures answer as { ok: false } instead of rejecting into the void.
async function respond(message) {
  try {
    return await handleMessage(message);
  } catch (error) {
    const opts = await loadOptions();
    return { ok: false, error: String((error && error.message) || error), opts };
  }
}

export function dispatch(message) {
  return respond(message);
}

// ---- listeners ----

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  respond(message).then(sendResponse);
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  if (selfWrites > 0) { selfWrites--; return; }
  // External write (dev tools, synced restore): make the proxy follow it.
  const next = changes[STORAGE_KEY].newValue;
  if (!next || typeof next !== 'object') return;
  applyProxy(next.activeProfile, next)
    .then(() => updateBadge(next))
    .catch((error) => { proxyError = String((error && error.message) || error); });
});

// Request counters: only feasible in the extension; the desktop cannot see
// browser traffic, so it only tracks switches and active time.
chrome.webRequest.onCompleted.addListener(
  (details) => { recordObservedRequest(details); },
  { urls: ['http://*/*', 'https://*/*'] },
);

// Apply the configured startup profile on install and browser start only, so
// it does not fight later profile switches when the worker wakes up.
async function applyStartupProfile() {
  const opts = await loadOptions();
  const target = (opts.settings && opts.settings.startupProfile) || opts.activeProfile;
  if (target && target !== opts.activeProfile && (opts.profiles[target] || target === BUILTIN.DIRECT || target === BUILTIN.SYSTEM)) {
    opts.activeProfile = target;
    await persistOptions(opts);
  }
  try {
    await applyProxy(opts.activeProfile, opts);
    proxyError = null;
  } catch (error) {
    proxyError = String((error && error.message) || error);
  }
  await updateBadge(opts);
}

// Re-assert the active profile whenever the service worker wakes: proxy
// settings survive worker restarts, but the badge does not.
async function wake() {
  const opts = await loadOptions();
  try {
    await applyProxy(opts.activeProfile, opts);
    proxyError = null;
  } catch (error) {
    proxyError = String((error && error.message) || error);
  }
  await updateBadge(opts);
}

chrome.runtime.onInstalled.addListener(() => { applyStartupProfile().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { applyStartupProfile().catch(() => {}); });
wake().catch(() => {});

chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    handleAuthChallenge(details, asyncCallback).catch(() => asyncCallback());
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);
