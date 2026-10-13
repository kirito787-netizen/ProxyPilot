// Usage statistics model shared by the desktop app and the extension.
// Counters live under a dedicated storage key so recording never rewrites
// option files. Scope follows platform reality: the extension can observe
// requests and re-evaluate routing rules, the desktop only sees profile
// switches, and byte accounting is out of scope on both (MV3 cannot see
// reliable body sizes and the desktop never touches browser traffic).

import { BUILTIN, PROFILE_TYPE } from './model.js';
import { hostMatches } from './site.js';

export const STATS_KEY = 'proxypilot/stats';
export const STATS_SCHEMA_VERSION = 1;
export const STATS_RETENTION_DAYS = 90;
export const STATS_MAX_HOSTS = 50;

export function emptyStats() {
  return { schemaVersion: STATS_SCHEMA_VERSION, days: {}, active: null };
}

export function dayKey(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

function bucketFor(stats, key) {
  const days = stats.days || (stats.days = {});
  const bucket = days[key] || (days[key] = {});
  bucket.switches = bucket.switches || {};
  bucket.activeMs = bucket.activeMs || {};
  return bucket;
}

function bump(map, key, delta = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + delta;
}

// Drop buckets older than the retention window.
export function pruneStats(stats, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - STATS_RETENTION_DAYS);
  const cutoffKey = dayKey(cutoff);
  for (const key of Object.keys(stats.days || {})) {
    if (key < cutoffKey) delete stats.days[key];
  }
  return stats;
}

export function recordSwitch(stats, name, now = new Date()) {
  if (!name) return stats;
  bump(bucketFor(stats, dayKey(now)).switches, name);
  return stats;
}

// Add the time a profile was active between the two timestamps, splitting
// at local midnight so day buckets stay honest.
export function settleActive(stats, name, sinceMs, untilMs) {
  if (!name || !(untilMs > sinceMs)) return stats;
  let cursor = sinceMs;
  while (cursor < untilMs) {
    const start = new Date(cursor);
    const nextMidnight = new Date(start);
    nextMidnight.setHours(24, 0, 0, 0);
    const end = Math.min(untilMs, nextMidnight.getTime());
    bump(bucketFor(stats, dayKey(start)).activeMs, name, end - cursor);
    cursor = end;
  }
  return stats;
}

// The engines call this whenever a profile is applied: settle the previous
// run, count a switch when the profile actually changed, mark the new one.
export function markActive(stats, name, now = Date.now()) {
  if (!name) return stats;
  const previous = stats.active;
  if (previous && previous.name) {
    settleActive(stats, previous.name, Number(previous.since) || now, now);
    if (previous.name !== name) recordSwitch(stats, name, new Date(now));
  } else {
    recordSwitch(stats, name, new Date(now));
  }
  stats.active = { name, since: now };
  return stats;
}

// Reset history but keep tracking the currently active profile.
export function resetStats(stats, now = Date.now()) {
  const active = stats && stats.active;
  const fresh = emptyStats();
  fresh.active = active && active.name ? { name: active.name, since: now } : null;
  return fresh;
}

// Re-evaluate which route a request would take under the active profile.
// Mirrors the decisions pac.js bakes into the PAC document, so the counted
// route matches what actually happens. PAC scripts are opaque, so their
// traffic counts as proxied. Returns { via: 'proxied'|'direct'|'skip' }.
export function classifyRoute(options, host, url = '') {
  const name = options && options.activeProfile;
  if (!name) return { via: 'skip' };
  if (name === BUILTIN.DIRECT) return { via: 'direct' };
  if (name === BUILTIN.SYSTEM) return { via: 'skip' };
  const profile = options.profiles && options.profiles[name];
  if (!profile) return { via: 'skip' };
  if (profile.type === PROFILE_TYPE.FIXED) {
    for (const raw of profile.bypassList || []) {
      const pattern = String(raw).trim();
      if (!pattern) continue;
      if (pattern.toLowerCase() === '<local>') {
        if (!String(host).includes('.')) return { via: 'direct' };
      } else if (hostMatches('host-wildcard', pattern, host)) {
        return { via: 'direct' };
      }
    }
    return { via: 'proxied' };
  }
  if (profile.type === PROFILE_TYPE.PAC) return { via: 'proxied', approx: true };
  if (profile.type !== PROFILE_TYPE.AUTO) return { via: 'skip' };
  const viaTarget = (targetName) => {
    const target = targetName && options.profiles && options.profiles[targetName];
    if (!targetName || targetName === BUILTIN.DIRECT || targetName === BUILTIN.SYSTEM || !target) return 'direct';
    return 'proxied';
  };
  for (const rule of profile.rules || []) {
    const kind = (rule.condition && rule.condition.type) || 'host-wildcard';
    const pattern = ((rule.condition && rule.condition.pattern) || '').trim();
    if (!pattern) continue;
    if (hostMatches(kind, pattern, host) || (url && hostMatches(kind, pattern, url))) {
      return { via: viaTarget(rule.profileName), ruleKey: name + '|' + kind + '|' + pattern };
    }
  }
  return { via: viaTarget(profile.defaultProfileName), ruleKey: name + '|default' };
}

export function recordRequest(stats, decision, host, now = new Date()) {
  if (!decision || decision.via === 'skip') return stats;
  const bucket = bucketFor(stats, dayKey(now));
  bucket.requests = bucket.requests || { proxied: 0, direct: 0 };
  bucket.requests[decision.via] = (bucket.requests[decision.via] || 0) + 1;
  if (decision.ruleKey) bump(bucket.ruleHits = bucket.ruleHits || {}, decision.ruleKey);
  if (host) {
    const hosts = bucket.hosts = bucket.hosts || {};
    bump(hosts, host);
    if (Object.keys(hosts).length > STATS_MAX_HOSTS) {
      let smallest = null;
      for (const key of Object.keys(hosts)) {
        if (key !== 'other' && (smallest === null || hosts[key] < hosts[smallest])) smallest = key;
      }
      if (smallest) {
        hosts.other = (hosts.other || 0) + hosts[smallest];
        delete hosts[smallest];
      }
    }
  }
  return stats;
}

// Per-day totals for the trend bars, oldest day first.
export function dailyTotals(stats, days = 7, now = new Date()) {
  const out = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    const key = dayKey(date);
    const bucket = stats && stats.days && stats.days[key];
    out.push({
      key,
      proxied: (bucket && bucket.requests && bucket.requests.proxied) || 0,
      direct: (bucket && bucket.requests && bucket.requests.direct) || 0,
      activeMs: bucket ? Object.values(bucket.activeMs || {}).reduce((sum, ms) => sum + ms, 0) : 0,
      switches: bucket ? Object.values(bucket.switches || {}).reduce((sum, count) => sum + count, 0) : 0,
    });
  }
  return out;
}

export function topEntries(map = {}, limit = 10) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export function formatDuration(ms) {
  const totalMinutes = Math.round((ms || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return minutes + 'm';
  return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
}
