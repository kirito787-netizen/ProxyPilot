// ProxyPilot background service worker.
// Owns proxy application, the toolbar badge, proxy auth, and messaging.

import { BUILTIN, MSG, CONDITION_TYPE } from '../common/constants.js';
import {
  loadOptions,
  saveOptions,
  getCached,
  onChanged,
} from '../common/storage.js';
import { buildProxyConfig, authFor } from '../common/proxy.js';
import { describe } from '../common/profiles.js';
import { makeT } from '../common/i18n.js';

// Credentials for the currently active fixed proxy (used by onAuthRequired).
let activeAuth = null;

// ---- Proxy application ----

async function applyProfile(name, opts) {
  const config = buildProxyConfig(name, opts);
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
  activeAuth = authFor(name, opts);
  await updateBadge(name, opts);
}

// Apply whatever profile is marked active in options (used on boot / reapply).
async function applyActive() {
  const opts = getCached() || (await loadOptions());
  try {
    await applyProfile(opts.activeProfile, opts);
  } catch (e) {
    console.warn('[ProxyPilot] apply failed, falling back to direct:', e);
    opts.activeProfile = BUILTIN.DIRECT;
    await saveOptions(opts);
    await applyProfile(BUILTIN.DIRECT, opts);
  }
}

// ---- Badge ----

function abbreviate(label) {
  const trimmed = (label || '').trim();
  // For CJK, one glyph is wide enough; for latin, take two.
  const isCJK = /[一-鿿]/.test(trimmed);
  return isCJK ? trimmed.slice(0, 1) : trimmed.slice(0, 2).toUpperCase();
}

async function updateBadge(name, opts) {
  const t = makeT(opts.settings?.lang || 'en');
  const d = describe(name, opts, t);
  let text = '';
  if (name === BUILTIN.SYSTEM) text = 'SYS';
  else if (name !== BUILTIN.DIRECT) text = abbreviate(d.label);

  // Conflict indicator: another extension/app controls the proxy.
  let color = d.color;
  try {
    const ctrl = await chrome.proxy.settings.get({ incognito: false });
    if (ctrl.levelOfControl === 'controlled_by_other_extensions' ||
        ctrl.levelOfControl === 'not_controllable') {
      text = '!';
      color = '#EF4444';
    }
  } catch (_) { /* ignore */ }

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
  await chrome.action.setTitle({ title: `ProxyPilot · ${d.label}` });
}

// ---- Proxy authentication ----

chrome.webRequest.onAuthRequired.addListener(
  (details) => {
    if (details.isProxy && activeAuth) {
      return { authCredentials: activeAuth };
    }
    return {};
  },
  { urls: ['<all_urls>'] },
  ['blocking'],
);

// ---- Lifecycle ----

chrome.runtime.onInstalled.addListener(async () => {
  const opts = await loadOptions();
  const startup = opts.settings?.startupProfile;
  if (startup && (startup === BUILTIN.DIRECT || startup === BUILTIN.SYSTEM || opts.profiles[startup])) {
    opts.activeProfile = startup;
    await saveOptions(opts);
  }
  await applyActive();
});

chrome.runtime.onStartup.addListener(async () => {
  const opts = await loadOptions();
  const startup = opts.settings?.startupProfile;
  if (startup && (startup === BUILTIN.DIRECT || startup === BUILTIN.SYSTEM || opts.profiles[startup])) {
    opts.activeProfile = startup;
    await saveOptions(opts);
  }
  await applyActive();
});

// Re-sync badge if proxy control changes (another extension grabs it).
chrome.proxy.settings.onChange.addListener(async () => {
  const opts = getCached() || (await loadOptions());
  await updateBadge(opts.activeProfile, opts);
});

// Keep the in-memory cache & auth warm when options change elsewhere.
onChanged((opts) => {
  if (opts) activeAuth = authFor(opts.activeProfile, opts);
});

// ---- Messaging ----

async function handleMessage(msg) {
  switch (msg.type) {
    case MSG.GET_STATE: {
      const opts = await loadOptions();
      let levelOfControl = 'unknown';
      try {
        const ctrl = await chrome.proxy.settings.get({ incognito: false });
        levelOfControl = ctrl.levelOfControl;
      } catch (_) { /* ignore */ }
      return { ok: true, opts, levelOfControl };
    }

    case MSG.SWITCH_PROFILE: {
      const opts = getCached() || (await loadOptions());
      opts.activeProfile = msg.name;
      await saveOptions(opts);
      await applyProfile(msg.name, opts);
      return { ok: true, opts };
    }

    case MSG.SAVE_OPTIONS: {
      const saved = await saveOptions(msg.opts);
      await applyProfile(saved.activeProfile, saved);
      return { ok: true, opts: saved };
    }

    case MSG.APPLY_ACTIVE: {
      await applyActive();
      return { ok: true };
    }

    case MSG.GET_LEVEL_OF_CONTROL: {
      const ctrl = await chrome.proxy.settings.get({ incognito: false });
      return { ok: true, levelOfControl: ctrl.levelOfControl };
    }

    case MSG.ADD_QUICK_RULE: {
      const opts = getCached() || (await loadOptions());
      const auto = opts.profiles[msg.autoProfileName];
      if (!auto || auto.type !== 'auto') return { ok: false, error: '目标不是自动切换情景' };
      auto.rules = auto.rules || [];
      auto.rules.unshift({
        condition: { type: msg.conditionType || CONDITION_TYPE.HOST_WILDCARD, pattern: msg.pattern },
        profileName: msg.targetProfileName,
      });
      await saveOptions(opts);
      if (opts.activeProfile === msg.autoProfileName) {
        await applyProfile(opts.activeProfile, opts);
      }
      return { ok: true, opts };
    }

    default:
      return { ok: false, error: `未知消息类型：${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// Ensure the active profile is applied whenever the worker spins up.
applyActive();
