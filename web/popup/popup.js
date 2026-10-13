import { api, h, setThemeMode, onStorageChanged, describeProfile, summarizeProfile } from '../lib/ui.js';
import { createTranslator } from '../lib/i18n.js';
import { BUILTIN, PROFILE_TYPE, Message } from '../lib/model.js';
import { generateAutoPac } from '../lib/pac.js';
import { normalizeHost, hostMatches } from '../lib/site.js';

let state = null;
let t = createTranslator('zh');
let page = 'home';
let siteTimer = null;
let siteHostValue = '';
let siteAutoHost = null;
let siteUserEdited = false;

function call(type, extra = {}) {
  return api.call({ type, ...extra });
}

async function refresh() {
  const response = await call(Message.GET_STATE);
  if (!response?.ok) {
    renderError(response?.error || t('status.error'));
    return;
  }
  state = response;
  render();
}

function renderError(message) {
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.append(
    h('div', { class: 'boot-error' },
      h('strong', {}, message || t('status.error')),
      h('button', { class: 'btn', onclick: () => window.location.reload() }, t('status.active') === '当前方案' ? '重新加载' : 'Reload'),
    ),
  );
  setStatus('bad');
}

function setStatus(kind, label) {
  const status = document.getElementById('status');
  status.className = 'status ' + (kind || '');
  status.textContent = label || '';
  status.title = label || '';
}

async function switchTo(name) {
  const response = await call(Message.SWITCH_PROFILE, { name });
  if (response?.ok) {
    state.opts = response.opts;
    render();
  } else {
    setStatus('bad', response?.error || t('status.error'));
  }
}

function goPage(next) { page = next; render(); }

function render() {
  stopSitePolling();
  const options = state.opts;
  const lang = options.settings?.lang || 'zh';
  t = createTranslator(lang);
  document.documentElement.lang = lang;
  setThemeMode(options.settings?.theme);
  setStatus(state.proxyError ? 'bad' : 'ok', state.proxyError || '');

  const content = document.getElementById('content');
  content.innerHTML = '';
  if (page === 'servers') content.append(pageServers());
  else if (page === 'rules') content.append(pageRules());
  else if (page === 'pac') content.append(pagePac());
  else if (page === 'subs' || page === 'stats') content.append(pagePlaceholder(page));
  else content.append(pageHome());

  if (page === 'home' && isAutoContext()) {
    startSitePolling();
    updateSiteBlock();
  }

  renderCmdBar();
  document.getElementById('foot-left').textContent = 'v' + (api.version || '1.0.0');
  document.getElementById('foot-right').textContent = state.engine || '';
}

function pageHead(title, meta) {
  return h('div', { class: 'page-head' },
    h('strong', { class: 'page-title' }, title),
    h('span', { class: 'page-meta' }, meta || ''),
  );
}

// ---- home: profile switcher ----
function pageHome() {
  const options = state.opts;
  const active = describeProfile(options.activeProfile, options, t);
  const frag = document.createDocumentFragment();
  frag.append(
    h('section', { class: 'current' },
      h('span', { class: 'label' }, t('status.active')),
      h('div', { class: 'current-row' },
        h('span', { class: 'dot', style: 'background:' + active.color }),
        h('strong', { class: 'current-name' }, active.label),
      ),
      h('span', { class: 'summary' }, summarizeProfile(options.activeProfile, options, t)),
    ),
  );
  if (isAutoContext()) {
    frag.append(buildSiteBlock(options));
  } else if (Object.values(options.profiles).some((profile) => profile.type === PROFILE_TYPE.AUTO)) {
    frag.append(h('div', { class: 'hint-line' }, t('site.autoOnly')));
  }
  frag.append(h('div', { class: 'section-title' }, t('main.profiles')));

  const list = h('div', { class: 'profile-list' });
  const entries = [
    describeProfile('direct', options, t),
    describeProfile('system', options, t),
    ...Object.keys(options.profiles).map((name) => describeProfile(name, options, t)),
  ];
  entries.forEach((entry, index) => {
    list.append(
      h('button', {
        class: 'profile' + (options.activeProfile === entry.name ? ' active' : ''),
        onclick: () => switchTo(entry.name),
      },
        h('span', { class: 'dot', style: 'background:' + entry.color }),
        h('span', { class: 'profile-text' },
          h('span', { class: 'profile-name' }, entry.label),
          h('span', { class: 'profile-summary' }, summarizeProfile(entry.name, options, t)),
        ),
        h('kbd', {}, index < 9 ? String(index + 1) : ''),
      ),
    );
  });
  if (Object.keys(options.profiles).length === 0) {
    list.append(h('div', { class: 'empty' }, t('main.empty')));
  }
  frag.append(list);
  return frag;
}

// ---- servers: fixed-proxy profiles ----
function pageServers() {
  const options = state.opts;
  const fixed = Object.values(options.profiles).filter((profile) => profile.type === PROFILE_TYPE.FIXED);
  const frag = document.createDocumentFragment();
  frag.append(pageHead(t('servers.title'), t('servers.count', { n: fixed.length })));

  const list = h('div', { class: 'profile-list', id: 'server-list' });
  for (const profile of fixed) {
    const server = profile.fallbackProxy || {};
    list.append(h('button', {
      class: 'profile',
      'data-q': (profile.name + ' ' + (server.host || '') + ' ' + (server.scheme || '')).toLowerCase(),
      onclick: () => api.openOptions(),
    },
      h('span', { class: 'dot', style: 'background:' + (profile.color || '#94a3b8') }),
      h('span', { class: 'profile-text' },
        h('span', { class: 'profile-name' }, profile.name || ''),
        h('span', { class: 'profile-summary' }, (server.scheme || 'http').toUpperCase() + ' ' + (server.host || '—') + ':' + (server.port || '')),
      ),
    ));
  }

  const filter = h('input', { placeholder: t('servers.filter'), oninput: (event) => {
    const query = event.target.value.trim().toLowerCase();
    for (const row of list.children) {
      row.style.display = !query || (row.getAttribute('data-q') || '').includes(query) ? '' : 'none';
    }
  } });
  frag.append(h('div', { class: 'toolbar' }, filter,
    h('button', { class: 'btn', onclick: () => api.openOptions() }, t('servers.new'))));
  frag.append(fixed.length ? list : h('div', { class: 'empty' }, t('servers.empty')));
  return frag;
}

// ---- rules: aggregated auto-switch rules ----
function pageRules() {
  const options = state.opts;
  const rows = [];
  for (const profile of Object.values(options.profiles)) {
    if (profile.type !== PROFILE_TYPE.AUTO) continue;
    for (const rule of profile.rules || []) {
      rows.push({ match: rule.condition?.pattern || '', via: describeProfile(rule.profileName, options, t).label });
    }
    rows.push({ match: t('rules.default'), via: describeProfile(profile.defaultProfileName, options, t).label, dim: true });
  }
  const frag = document.createDocumentFragment();
  frag.append(pageHead(t('rules.title'), t('rules.count', { n: rows.filter((row) => !row.dim).length })));
  if (!rows.length) {
    frag.append(h('div', { class: 'empty' }, t('rules.empty')));
    return frag;
  }
  const list = h('div', { class: 'profile-list' });
  for (const row of rows) {
    list.append(h('div', { class: 'rule-line' + (row.dim ? ' dim' : '') },
      h('span', { class: 'rule-match' }, row.match),
      h('span', { class: 'rule-via' }, '→ ' + row.via),
    ));
  }
  frag.append(list, h('button', { class: 'btn', onclick: () => api.openOptions() }, t('main.settings')));
  return frag;
}

// ---- pac: inspect the active PAC source ----
function pacSource() {
  const options = state.opts;
  const active = options.profiles[options.activeProfile];
  if (active?.type === PROFILE_TYPE.PAC) {
    if (active.pacScript?.trim()) return { src: active.pacScript };
    if (active.pacUrl) return { src: '// url: ' + active.pacUrl };
  }
  if (active?.type === PROFILE_TYPE.AUTO) return { src: generateAutoPac(active, options).script, note: t('pac.generated') };
  const firstPac = Object.values(options.profiles).find((profile) =>
    profile.type === PROFILE_TYPE.PAC && (profile.pacScript?.trim() || profile.pacUrl));
  if (firstPac) {
    return firstPac.pacScript?.trim()
      ? { src: firstPac.pacScript, note: firstPac.name }
      : { src: '// url: ' + firstPac.pacUrl, note: firstPac.name };
  }
  const firstAuto = Object.values(options.profiles).find((profile) => profile.type === PROFILE_TYPE.AUTO);
  if (firstAuto) return { src: generateAutoPac(firstAuto, options).script, note: t('pac.generated') };
  return null;
}

const PAC_KEYWORDS = ['function', 'return', 'if', 'else', 'var', 'const', 'let', 'new'];
function appendKeywords(out, text) {
  for (const part of text.split(/\b(function|return|if|else|var|const|let|new)\b/)) {
    out.append(PAC_KEYWORDS.includes(part) ? h('span', { class: 'kw' }, part) : document.createTextNode(part));
  }
}

function highlightPacLine(line) {
  const out = h('span');
  line.split(/("(?:[^"\\]|\\.)*")/g).forEach((token, index) => {
    if (index % 2 === 1) { out.append(h('span', { class: 'str' }, token)); return; }
    const commentAt = token.indexOf('//');
    if (commentAt >= 0) {
      appendKeywords(out, token.slice(0, commentAt));
      out.append(h('span', { class: 'com' }, token.slice(commentAt)));
    } else {
      appendKeywords(out, token);
    }
  });
  return out;
}

function pagePac() {
  const resolved = pacSource();
  const frag = document.createDocumentFragment();
  frag.append(pageHead(t('pac.title'), resolved ? t('pac.lines', { n: resolved.src.split('\n').length }) : ''));
  if (!resolved) {
    frag.append(h('div', { class: 'empty' }, t('pac.empty')));
    return frag;
  }
  if (resolved.note) frag.append(h('div', { class: 'hint-line' }, resolved.note));
  const view = h('div', { class: 'pac-view' });
  resolved.src.split('\n').forEach((line, index) => {
    view.append(h('div', {}, h('span', { class: 'ln' }, String(index + 1)), highlightPacLine(line)));
  });
  frag.append(view);
  return frag;
}

// ---- placeholders kept from the classic UI ----
function pagePlaceholder(kind) {
  return h('div', { class: 'empty' },
    h('div', {}, t(kind + '.empty')),
    h('div', { class: 'note' }, t(kind + '.note')),
  );
}

// ---- current-site quick routing ----
function isAutoContext() {
  const options = state.opts;
  const active = options.profiles[options.activeProfile];
  return active?.type === PROFILE_TYPE.AUTO ? options.activeProfile : null;
}

function siteTargets(options) {
  return [
    { name: BUILTIN.DIRECT, label: t('profile.direct') },
    ...Object.entries(options.profiles)
      .filter(([, profile]) => profile.type === PROFILE_TYPE.FIXED)
      .map(([name, profile]) => ({ name, label: profile.name || name })),
  ];
}

function siteMatchLabel(host, options, autoName) {
  const auto = options.profiles[autoName];
  if (!auto || auto.type !== PROFILE_TYPE.AUTO) return '—';
  for (const rule of auto.rules || []) {
    if (hostMatches(rule.condition?.type || 'host-wildcard', rule.condition?.pattern, host)) {
      return describeProfile(rule.profileName, options, t).label;
    }
  }
  return describeProfile(auto.defaultProfileName, options, t).label;
}

function buildSiteBlock(options) {
  const input = h('input', {
    class: 'site-input',
    value: siteHostValue,
    placeholder: t('site.placeholder'),
    oninput: (event) => {
      siteHostValue = event.target.value;
      siteUserEdited = true;
      updateSiteBlock();
    },
  });
  const chips = h('div', { class: 'chips' });
  for (const target of siteTargets(options)) {
    chips.append(h('button', { class: 'chip', onclick: () => addSiteRule(target.name) },
      t('site.routeVia') + ' ' + target.label));
  }
  return h('div', { class: 'site-block', id: 'site-slot' },
    h('div', { class: 'site-head' }, input, h('span', { class: 'site-result' })),
    chips,
  );
}

function updateSiteBlock() {
  const block = document.getElementById('site-slot');
  if (!block) return;
  const autoName = isAutoContext();
  if (!autoName) return;
  const input = block.querySelector('.site-input');
  if (document.activeElement !== input) input.value = siteHostValue;
  const host = normalizeHost(siteHostValue);
  block.querySelector('.site-result').textContent = host
    ? t('site.matches') + ' → ' + siteMatchLabel(host, state.opts, autoName)
    : t('site.matches') + ' → —';
  for (const chip of block.querySelectorAll('.chip')) chip.disabled = !host;
}

async function addSiteRule(targetName) {
  const host = normalizeHost(siteHostValue);
  const autoName = isAutoContext();
  if (!host || !autoName) return;
  const response = await call(Message.ADD_RULE, {
    autoProfileName: autoName,
    targetProfileName: targetName,
    conditionType: 'host-wildcard',
    pattern: '*.' + host.replace(/^www\./, ''),
  });
  if (response?.ok) {
    state.opts = response.opts;
    render();
  } else {
    setStatus('bad', response?.error || t('status.error'));
  }
}

function startSitePolling() {
  const tick = async () => {
    if (page !== 'home' || document.hidden) return;
    const response = await call(Message.FIND_TAB_HOST);
    const host = response?.ok ? response.host : null;
    if (host && host !== siteAutoHost) {
      siteAutoHost = host;
      if (!siteUserEdited) {
        siteHostValue = host;
        updateSiteBlock();
      }
    }
  };
  tick();
  siteTimer = setInterval(tick, 4000);
}

function stopSitePolling() {
  if (siteTimer) { clearInterval(siteTimer); siteTimer = null; }
}

// ---- bottom command bar ----
function renderCmdBar() {
  const bar = document.getElementById('cmdbar');
  bar.innerHTML = '';
  const items = [
    ['home', t('cmd.home'), 'H'],
    ['servers', t('cmd.servers'), 'N'],
    ['rules', t('cmd.rules'), 'R'],
    ['pac', t('cmd.pac'), 'P'],
    ['subs', t('cmd.subs'), 'S'],
    ['stats', t('cmd.stats'), 'T'],
  ];
  for (const [id, label, key] of items) {
    bar.append(h('button', { class: 'cmd' + (page === id ? ' active' : ''), onclick: () => goPage(id) },
      h('span', {}, label),
      h('kbd', {}, key),
    ));
  }
}

document.getElementById('open-settings').addEventListener('click', () => api.openOptions());
document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.tagName === 'SELECT') return;
  const key = event.key.toLowerCase();
  const pages = { h: 'home', n: 'servers', r: 'rules', p: 'pac', s: 'subs', t: 'stats' };
  if (pages[key]) { goPage(pages[key]); return; }
  if ((key === 'escape' || key === 'b') && page !== 'home') { goPage('home'); return; }
  if (page === 'home' && /^[1-9]$/.test(key) && state) {
    const entries = ['direct', 'system', ...Object.keys(state.opts.profiles)];
    const name = entries[Number(key) - 1];
    if (name) switchTo(name);
  }
});
onStorageChanged((next) => {
  if (next && state) { state.opts = next; render(); }
});
refresh();
