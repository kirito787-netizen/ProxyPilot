// Persistence layer over chrome.storage.local.

import { STORAGE_KEY, SCHEMA_VERSION, defaultOptions, BUILTIN } from './constants.js';
import { platform } from './platform.js';

let cache = null;

// Deep clone helper (structuredClone is available in MV3 SW + pages).
export function clone(obj) {
  return structuredClone(obj);
}

// Load the full options object, seeding defaults on first run.
export async function loadOptions() {
  const stored = await platform.storage.local.get(STORAGE_KEY);
  let opts = stored[STORAGE_KEY];
  if (!opts || typeof opts !== 'object') {
    opts = defaultOptions();
    await platform.storage.local.set({ [STORAGE_KEY]: opts });
  } else {
    opts = migrate(opts);
  }
  cache = opts;
  return clone(opts);
}

// Persist a full options object.
export async function saveOptions(opts) {
  opts.schemaVersion = SCHEMA_VERSION;
  cache = clone(opts);
  await platform.storage.local.set({ [STORAGE_KEY]: opts });
  return clone(opts);
}

// Synchronous access to last-loaded cache (background keeps it warm).
export function getCached() {
  return cache ? clone(cache) : null;
}

// Persist only the active profile name without rewriting everything else.
export async function setActiveProfile(name) {
  const opts = (getCached() || (await loadOptions()));
  opts.activeProfile = name;
  return saveOptions(opts);
}

function migrate(opts) {
  const defs = defaultOptions();
  if (!opts.schemaVersion) opts.schemaVersion = SCHEMA_VERSION;
  opts.settings = { ...defs.settings, ...(opts.settings || {}) };
  if (!opts.profiles) opts.profiles = {};
  if (!opts.activeProfile) opts.activeProfile = BUILTIN.DIRECT;
  return opts;
}

// Listen for external changes (e.g. options page saved while popup open).
export function onChanged(callback) {
  if (platform.storage && platform.storage.onChanged && typeof platform.storage.onChanged.addListener === 'function') {
    platform.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes && changes[STORAGE_KEY]) {
        cache = changes[STORAGE_KEY].newValue || null;
        callback(cache ? clone(cache) : null);
      }
    });
    return;
  }
  window.addEventListener('proxypilot:storage-changed', (event) => {
    const detail = event.detail || {};
    const changes = detail.changes || {};
    const area = detail.area || 'local';
    if (area === 'local' && changes[STORAGE_KEY]) {
      cache = changes[STORAGE_KEY].newValue || null;
      callback(cache ? clone(cache) : null);
    }
  });
}

// ---- Import / Export ----

export function exportBackup(opts) {
  return JSON.stringify(
    {
      app: 'ProxyPilot',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      options: opts,
    },
    null,
    2,
  );
}

export function parseBackup(text) {
  const data = JSON.parse(text);
  // Accept either our backup wrapper or a raw options object.
  const opts = data && data.options ? data.options : data;
  if (!opts || typeof opts !== 'object' || !opts.profiles) {
    throw new Error('备份文件格式无法识别');
  }
  return migrate(opts);
}
