// Extension engine smoke test. The engine module only touches chrome.* APIs,
// so a small in-memory stub is enough to drive the full message flow in node.
// It also syntax-checks every extension script and validates the manifest.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exitCode = 1;
  } else {
    console.log('ok: ' + message);
  }
};

function makeChromeStub() {
  const storage = new Map();
  const storageListeners = [];
  let proxyValue = null;
  const badge = { texts: [], colors: [], titles: [] };
  const registered = { runtime: {}, auth: [] };
  let tabsAnswer = [];

  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { registered.runtime.onInstalled = fn; } },
      onStartup: { addListener: (fn) => { registered.runtime.onStartup = fn; } },
      onMessage: { addListener: (fn) => { registered.runtime.onMessage = fn; } },
    },
    storage: {
      local: {
        get: async (key) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
        set: async (items) => {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: storage.get(key), newValue: value };
            storage.set(key, value);
          }
          for (const listener of storageListeners) listener(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    proxy: {
      settings: {
        set: async ({ value }) => { proxyValue = value; },
        clear: async () => { proxyValue = null; },
        get: async () => ({ value: proxyValue, levelOfControl: 'controlled_by_this_extension' }),
      },
    },
    action: {
      setBadgeText: async (x) => badge.texts.push(x.text),
      setBadgeBackgroundColor: async (x) => badge.colors.push(x.color),
      setTitle: async (x) => badge.titles.push(x.title),
    },
    tabs: {
      query: async () => tabsAnswer,
      __setAnswer: (value) => { tabsAnswer = value; },
    },
    webRequest: {
      onAuthRequired: {
        addListener: (fn, _filter, _extra) => registered.auth.push(fn),
      },
    },
  };
  return { chrome, storage, registered, badge, proxyValue: () => proxyValue };
}

const stub = makeChromeStub();
globalThis.chrome = stub.chrome;

const { dispatch } = await import('../../web/background/engine.js');

// Module evaluation runs wake(): defaults created, direct applied.
let state = await dispatch({ type: 'getState' });
assert(state.ok, 'getState after first wake');
assert(state.opts && state.opts.profiles['代理服务器'], 'default profiles created');
assert(stub.proxyValue() && stub.proxyValue().mode === 'direct', 'initial proxy mode is direct');

// Fire the install listener like Chrome would.
await new Promise((resolve) => {
  stub.registered.runtime.onInstalled();
  setTimeout(resolve, 0);
});

// Switch to the fixed proxy profile.
const fixed = await dispatch({ type: 'switchProfile', name: '代理服务器' });
assert(fixed.ok, 'switchProfile to fixed proxy');
let value = stub.proxyValue();
assert(value.mode === 'fixed_servers', 'fixed proxy applied as fixed_servers');
assert(value.rules.fallbackProxy.host === '127.0.0.1' && value.rules.fallbackProxy.port === 7890, 'fixed fallback endpoint');
assert(stub.badge.texts.at(-1) === '代理', 'badge shows profile name');

// Switch to the auto profile: PAC data generated from rules.
const auto = await dispatch({ type: 'switchProfile', name: '自动切换' });
assert(auto.ok, 'switchProfile to auto profile');
value = stub.proxyValue();
assert(value.mode === 'pac_script' && typeof value.pacScript.data === 'string', 'auto profile applied as pac_script');
assert(value.pacScript.data.includes('shExpMatch(host, "*.google.com")'), 'auto PAC contains the default rule');
assert(value.pacScript.data.includes('PROXY 127.0.0.1:7890'), 'auto PAC routes rule hits to the fixed proxy');
assert(value.pacScript.data.includes('return "DIRECT";'), 'auto PAC falls back to DIRECT');

// Quick rule from the popup site block lands at the top of the rules list.
const rule = await dispatch({
  type: 'addQuickRule',
  autoProfileName: '自动切换',
  targetProfileName: '代理服务器',
  conditionType: 'HostWildcard',
  pattern: '*.example.com',
});
assert(rule.ok && rule.opts.profiles['自动切换'].rules[0].condition.pattern === '*.example.com', 'addQuickRule unshifts a rule');
assert(stub.proxyValue().pacScript.data.includes('*.example.com'), 'PAC regenerated after rule add');

// Save options: theme change persists.
const next = structuredClone(rule.opts);
next.settings.theme = 'light';
const saved = await dispatch({ type: 'saveOptions', opts: next });
const stored = await stub.chrome.storage.local.get('proxypilot.options');
assert(saved.ok && stored['proxypilot.options'].settings.theme === 'light', 'saveOptions persists');

// Invalid PAC profile surfaces an error and keeps the previous proxy.
const broken = structuredClone(saved.opts);
broken.profiles['坏情景'] = { name: '坏情景', type: 'pac', color: '#123456', pacUrl: '', pacScript: '' };
const failed = await dispatch({ type: 'switchProfile', name: '坏情景' });
assert(!failed.ok, 'failed switch reports an error');
assert(stub.proxyValue().mode === 'pac_script', 'failed switch reverts to previous proxy');

// System profile hands control back to the browser.
const system = await dispatch({ type: 'switchProfile', name: 'system' });
assert(system.ok && stub.proxyValue() === null, 'system profile clears extension proxy');

// Proxy auth: add credentials then answer a challenge for the same endpoint.
const withAuth = structuredClone(saved.opts);
withAuth.profiles['代理服务器'].fallbackProxy.auth = { username: 'alice', password: 'secret' };
await dispatch({ type: 'saveOptions', opts: withAuth });
await dispatch({ type: 'switchProfile', name: '代理服务器' });
const authHandler = stub.registered.auth[0];
assert(typeof authHandler === 'function', 'onAuthRequired listener registered');
await new Promise((resolve) => {
  authHandler(
    { isProxy: true, challenger: { host: '127.0.0.1', port: 7890 }, realm: 'proxy' },
    (result) => {
      assert(result && result.authCredentials && result.authCredentials.username === 'alice', 'auth challenge answered with stored credentials');
      resolve();
    },
  );
});
// Four wrong-credential rounds must end in a decline instead of a loop.
let declined = null;
for (let round = 0; round < 4; round++) {
  await new Promise((resolve) => {
    authHandler(
      { isProxy: true, challenger: { host: '127.0.0.1', port: 7890 }, realm: 'loop' },
      (result) => { if (round === 3) declined = result; resolve(); },
    );
  });
}
assert(declined === undefined, 'auth retries are capped to avoid loops');

// findTabHost reads the focused active tab URL.
stub.chrome.tabs.__setAnswer([{ url: 'https://www.google.com/search?q=pac' }]);
const tab = await dispatch({ type: 'findTabHost' });
assert(tab.ok && tab.host === 'www.google.com', 'findTabHost extracts hostname');

// Unknown message types are rejected cleanly.
const unknown = await dispatch({ type: 'nope' });
assert(!unknown.ok && unknown.error.includes('nope'), 'unknown message rejected');

// ---- static checks: manifest JSON + module syntax for every web script ----

try {
  JSON.parse(readFileSync(join(webRoot, 'manifest.json'), 'utf8'));
  console.log('ok: manifest.json parses');
} catch (error) {
  console.error('FAIL: manifest.json invalid: ' + error.message);
  process.exitCode = 1;
}

function listJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const tempDir = mkdtempSync(join(tmpdir(), 'proxypilot-web-'));
for (const file of listJs(webRoot)) {
  const dest = join(tempDir, file.replaceAll(/[^a-zA-Z0-9]/g, '_') + '.mjs');
  copyFileSync(file, dest);
  const result = spawnSync(process.execPath, ['--check', dest], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error('FAIL: syntax error in ' + file + '\n' + (result.stderr || result.stdout || ''));
    process.exitCode = 1;
  }
}
rmSync(tempDir, { recursive: true, force: true });
if (!process.exitCode) console.log('ok: all extension scripts parse as ES modules');

// Shared logic copies must stay identical to the desktop sources; drift
// means a desktop edit never reached the extension (npm run sync:web fixes it).
const repoRoot = join(webRoot, '..');
const sharedPairs = [
  ['app/model.js', 'web/lib/model.js'],
  ['app/pac.js', 'web/lib/pac.js'],
  ['app/site.js', 'web/lib/site.js'],
  ['app/i18n.js', 'web/lib/i18n.js'],
];
let drifted = false;
for (const [source, target] of sharedPairs) {
  if (readFileSync(join(repoRoot, source), 'utf8') !== readFileSync(join(webRoot, target.slice(4)), 'utf8')) {
    console.error('FAIL: ' + target + ' drifted from ' + source + ' — run npm run sync:web');
    drifted = true;
  }
}
if (drifted) process.exitCode = 1;
else console.log('ok: web/lib shared logic matches the app sources');

console.log(process.exitCode ? 'test:web FAILED' : 'test:web passed');

// Every path the manifest and pages reference must exist inside web/.
const manifest = JSON.parse(readFileSync(join(webRoot, 'manifest.json'), 'utf8'));
const references = [
  join(webRoot, manifest.background.service_worker),
  ...Object.values(manifest.icons).map((ref) => join(webRoot, ref)),
  ...Object.values(manifest.action.default_icon || {}).map((ref) => join(webRoot, ref)),
  join(webRoot, manifest.action.default_popup),
  join(webRoot, manifest.options_ui.page),
];
for (const page of [manifest.action.default_popup, manifest.options_ui.page]) {
  const html = readFileSync(join(webRoot, page), 'utf8');
  const base = join(webRoot, page, '..');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    references.push(join(base, match[1]));
  }
}
const missing = references.filter((ref) => !existsSync(ref));
if (missing.length) {
  for (const ref of missing) console.error('FAIL: missing referenced file: ' + ref);
  process.exitCode = 1;
} else {
  console.log('ok: all ' + references.length + ' referenced files exist');
}
