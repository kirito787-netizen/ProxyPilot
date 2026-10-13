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
import { SUBS_STORAGE_KEY, blankSubscription, fetchSubscription, isSubDue } from '../lib/subs.js';

const REGULAR = { scope: 'regular' };
const AUTH_RETRY_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_TRIES = 3;
// While the ProxyPilot desktop app runs it owns the OS proxy (system PAC).
// chrome.proxy settings would override the system and make the desktop app
// invisible in this browser, so the engine yields whenever it detects it.
// Overridable so the automated test can point the probe at a controlled
// endpoint; "process" does not exist inside a service worker.
const DESKTOP_STATE_URL = (typeof process !== 'undefined' && process.env && process.env.PROXYPILOT_DESKTOP_STATE_URL) || 'http://127.0.0.1:17777/proxypilot.state';
const DESKTOP_PROBE_TIMEOUT_MS = 2000;
const DESKTOP_ALARM = 'proxypilot:desktop-watch';

let proxyError = null;
let engineLabel = 'DIRECT';
let desktopState = { active: false, checkedAt: 0, info: null };
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
    subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
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

async function probeDesktop() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DESKTOP_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(DESKTOP_STATE_URL, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.app === 'ProxyPilot' ? data : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshDesktopState() {
  const info = await probeDesktop();
  desktopState = { active: !!info, checkedAt: Date.now(), info };
  return desktopState.active;
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
  if (await refreshDesktopState()) {
    // Desktop takeover: follow the OS proxy (its system PAC) instead.
    await chrome.proxy.settings.clear(REGULAR);
    engineLabel = 'DESKTOP';
    routeContext = null;
    return;
  }
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
    if (details.type === 'main_frame') tabHosts.delete(details.tabId);
    noteTabHost(details.tabId, host);
    const decision = classifyRoute(routeContext.options, host, details.url);
    if (decision.via === 'skip') return;
    const stats = await loadStats();
    recordRequest(stats, decision, host);
    if (++countedRequests % 25 === 0) await flushStats();
    else scheduleStatsFlush();
  } catch (_) { /* statistics never break proxying */ }
}

// ---- per-tab host observations (related-domain suggestions) ----
// What a page actually loads is detectable; corporate affiliation is not.
// So the UI suggests observed cross-domain hosts and the user picks.

const TAB_HOSTS_LIMIT = 100;
const TABS_LIMIT = 30;
const tabHosts = new Map();

function noteTabHost(tabId, host) {
  if (!Number.isInteger(tabId) || tabId < 0 || !host) return;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return; // IPs are not domain candidates
  let hosts = tabHosts.get(tabId);
  if (!hosts) {
    while (tabHosts.size >= TABS_LIMIT) {
      const oldest = tabHosts.keys().next().value;
      tabHosts.delete(oldest);
    }
    hosts = new Map();
    tabHosts.set(tabId, hosts);
  }
  hosts.set(host, (hosts.get(host) || 0) + 1);
  if (hosts.size > TAB_HOSTS_LIMIT) {
    let smallest = null;
    for (const key of hosts.keys()) {
      if (smallest === null || hosts.get(key) < hosts.get(smallest)) smallest = key;
    }
    hosts.delete(smallest);
  }
}

// Naive registrable domain: last two labels. Good enough to tell the user
// which hosts are already covered by the *.domain wildcard they add.
function baseDomain(host) {
  const labels = String(host || '').split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

async function findRelatedHosts() {
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch (_) { return null; }
  if (!tab || !tab.url || !Number.isInteger(tab.id)) return null;
  let host = null;
  try { host = new URL(tab.url).hostname || null; } catch (_) { return null; }
  if (!host) return null;
  const base = baseDomain(host);
  const token = (base.split('.')[0] || '').toLowerCase();
  const observed = tabHosts.get(tab.id) || new Map();
  const hosts = [];
  let covered = 0;
  for (const [candidate, count] of observed) {
    if (candidate === host) continue;
    if (baseDomain(candidate) === base) { covered++; continue; }
    hosts.push({ host: candidate, count, affinity: token && candidate.includes(token) ? 1 : 0 });
  }
  hosts.sort((a, b) => (b.affinity - a.affinity) || (b.count - a.count));
  return { host, base, covered, hosts: hosts.slice(0, 12) };
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
  if (desktopState.active) {
    try {
      await chrome.action.setBadgeText({ text: 'DT' });
      await chrome.action.setBadgeBackgroundColor({ color: '#22C55E' });
      await chrome.action.setTitle({ title: 'ProxyPilot — 桌面版已接管系统代理 / Desktop app owns the system proxy' });
    } catch (_) { /* action API unavailable in some test contexts */ }
    return;
  }
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

// ---- subscriptions ----

async function loadSubsCache() {
  const stored = await chrome.storage.local.get(SUBS_STORAGE_KEY);
  const parsed = stored && stored[SUBS_STORAGE_KEY];
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function saveSubsCache(cache) {
  await chrome.storage.local.set({ [SUBS_STORAGE_KEY]: cache });
}

// Apply fetched content: PAC feeds the target profile's script, config sync
// replaces the profiles table (local settings are kept).
async function applySubscriptionContent(opts, sub, content) {
  if (sub.kind === 'pac') {
    const profile = opts.profiles[sub.targetProfile];
    if (!profile || profile.type !== PROFILE_TYPE.PAC) throw new Error('目标情景不存在或不是 PAC 情景');
    profile.pacScript = content;
    return;
  }
  const incoming = JSON.parse(content);
  opts.profiles = incoming.profiles;
  if (!opts.profiles[opts.activeProfile]) opts.activeProfile = BUILTIN.DIRECT;
}

async function refreshSubscription(opts, sub, now = Date.now()) {
  const result = await fetchSubscription(sub, fetch, now);
  sub.updatedAt = result.state.updatedAt;
  sub.lastError = result.state.lastError;
  sub.extra = result.state.extra || null;
  if (result.state.serverInterval) sub.serverInterval = result.state.serverInterval;
  if (!result.ok) {
    await persistOptions(opts);
    return { ok: false, error: result.error };
  }
  const cache = await loadSubsCache();
  if (cache[sub.id] && cache[sub.id].content === result.content) {
    await persistOptions(opts);
    return { ok: true, changed: false };
  }
  cache[sub.id] = { content: result.content, updatedAt: now };
  await saveSubsCache(cache);
  await applySubscriptionContent(opts, sub, result.content);
  await persistOptions(opts);
  await applyProxy(opts.activeProfile, opts);
  await updateBadge(opts);
  return { ok: true, changed: true };
}

async function refreshDueSubscriptions() {
  const opts = await loadOptions();
  for (const sub of opts.subscriptions || []) {
    if (!isSubDue(sub)) continue;
    try { await refreshSubscription(opts, sub); }
    catch (_) { /* keep going; the next alarm retries */ }
  }
}

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
        desktop: { active: desktopState.active, checkedAt: desktopState.checkedAt, profileName: desktopState.info ? desktopState.info.profileName : null },
      };
    case 'desktop.check': {
      await applyProxy(opts.activeProfile, opts);
      await updateBadge(opts);
      return { ok: true, desktop: { active: desktopState.active, checkedAt: desktopState.checkedAt, profileName: desktopState.info ? desktopState.info.profileName : null }, opts };
    }
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
    case 'tab.relatedHosts':
      return { ok: true, related: await findRelatedHosts() };
    case 'rules.addBulk': {
      const auto = opts.profiles[message.autoProfileName];
      if (!auto || auto.type !== PROFILE_TYPE.AUTO) throw new Error('目标不是自动切换情景');
      const patterns = [...new Set((Array.isArray(message.patterns) ? message.patterns : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean))];
      if (!patterns.length) return { ok: false, error: '没有可添加的规则' };
      auto.rules = auto.rules || [];
      let added = 0;
      for (const pattern of patterns) {
        const kind = message.conditionType || 'host-wildcard';
        const exists = (auto.rules).some((rule) => rule.condition && rule.condition.type === kind && rule.condition.pattern === pattern);
        if (exists) continue;
        auto.rules.unshift({ condition: { type: kind, pattern }, profileName: message.targetProfileName });
        added++;
      }
      return { ok: true, opts: await saveOptionsMessage(opts), added };
    }
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
    case 'subs.list':
      return { ok: true, subscriptions: opts.subscriptions || [] };
    case 'subs.add': {
      const sub = blankSubscription(message);
      if (!sub.url) return { ok: false, error: '无效的订阅链接，需要 http(s) 地址' };
      if (sub.kind === 'pac') {
        const profile = opts.profiles[sub.targetProfile];
        if (!profile || profile.type !== PROFILE_TYPE.PAC) return { ok: false, error: '请选择一个 PAC 情景' };
      }
      sub.name = sub.name || (new URL(sub.url)).hostname;
      opts.subscriptions = Array.isArray(opts.subscriptions) ? opts.subscriptions : [];
      opts.subscriptions.push(sub);
      const result = await refreshSubscription(opts, sub);
      if (!result.ok) {
        opts.subscriptions = opts.subscriptions.filter((item) => item.id !== sub.id);
        await persistOptions(opts);
        return { ok: false, error: result.error, subscriptions: opts.subscriptions };
      }
      return { ok: true, opts, subscriptions: opts.subscriptions };
    }
    case 'subs.remove': {
      const before = (opts.subscriptions || []).length;
      opts.subscriptions = (opts.subscriptions || []).filter((item) => item.id !== message.id);
      if (opts.subscriptions.length === before) return { ok: false, error: '订阅不存在' };
      const cache = await loadSubsCache();
      delete cache[message.id];
      await saveSubsCache(cache);
      await persistOptions(opts);
      return { ok: true, opts, subscriptions: opts.subscriptions };
    }
    case 'subs.refresh': {
      const sub = (opts.subscriptions || []).find((item) => item.id === message.id);
      if (!sub) return { ok: false, error: '订阅不存在' };
      const result = await refreshSubscription(opts, sub);
      if (!result.ok) return { ok: false, error: result.error, opts, subscriptions: opts.subscriptions };
      return { ok: true, opts, subscriptions: opts.subscriptions, changed: result.changed };
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

// Subscription auto-refresh: chrome.alarms survives worker shutdowns, and
// the module-eval catch-up covers worker wake-ups between alarm fires.
const SUBS_ALARM = 'proxypilot:subs-refresh';
try { chrome.alarms.create(SUBS_ALARM, { periodInMinutes: 30 }); } catch (_) { /* unavailable in some test contexts */ }
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === SUBS_ALARM) refreshDueSubscriptions().catch(() => { /* retried next alarm */ });
});
refreshDueSubscriptions().catch(() => { /* retried next alarm */ });

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
const initialWake = wake().catch(() => {});
// Resolves once the startup proxy application (including the desktop probe)
// has settled; automated tests and future callers can await it.
export function ready() { return initialWake; }

// Periodic handoff watch: pick control back up when the desktop app exits,
// and yield again shortly after it starts. One minute keeps the gap small
// without keeping the worker alive.
try { chrome.alarms.create(DESKTOP_ALARM, { periodInMinutes: 1 }); } catch (_) { /* unavailable in some test contexts */ }
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === DESKTOP_ALARM) {
    loadOptions()
      .then(async (opts) => { await applyProxy(opts.activeProfile, opts); await updateBadge(opts); })
      .catch(() => { /* retried on the next alarm */ });
  }
});

chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    handleAuthChallenge(details, asyncCallback).catch(() => asyncCallback());
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);
