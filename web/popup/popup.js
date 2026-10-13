import { api, h, setThemeMode, onStorageChanged, describeProfile, summarizeProfile } from '../lib/ui.js';
import { createTranslator } from '../lib/i18n.js';
import { BUILTIN, PROFILE_TYPE, Message } from '../lib/model.js';
import { generateAutoPac } from '../lib/pac.js';
import { normalizeHost, hostMatches } from '../lib/site.js';
import { dailyTotals, dayKey, formatDuration, topEntries } from '../lib/stats.js';
import { SUBS_DEFAULT_INTERVAL, formatBytes, subIntervalMinutes } from '../lib/subs.js';

let state = null;
let t = createTranslator('zh');
let page = 'home';
let siteTimer = null;
let siteHostValue = '';
let siteAutoHost = null;
let siteUserEdited = false;
let siteRelated = null;
let siteRelatedHost = null;
let siteRelatedTargetName = null;
let siteRelatedToken = 0;
const siteRelatedSelection = new Set();

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
  else if (page === 'subs') { content.append(pageSubsHead()); renderSubsPage(content); }
  else if (page === 'stats') { content.append(pageStatsHead()); renderStatsPage(content); }
  else content.append(pageHome());

  if (page === 'home' && isAutoContext()) {
    startSitePolling();
    updateSiteBlock();
  }

  if (page === 'home') renderHomeSummary(content);
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
  if (state.desktop && state.desktop.active) {
    frag.append(h('div', { class: 'hint-line' }, t('desktop.takeover')));
  }
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

// ---- usage statistics ----
function pageStatsHead() {
  return h('div', { style: 'display:flex;align-items:center;gap:8px;' },
    h('strong', { class: 'section-title', style: 'flex:1;' }, t('stats.title')),
    h('button', { class: 'icon-btn', title: t('stats.reset'), onclick: resetStatsFlow }, t('stats.reset')),
  );
}

async function resetStatsFlow() {
  if (!window.confirm(t('stats.resetConfirm'))) return;
  const response = await call(Message.STATS_RESET);
  if (response && response.ok) render();
}

async function renderStatsPage(container) {
  const response = await call(Message.STATS_GET);
  const stats = response && response.ok ? response.stats : null;
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:10px;' });
  if (!stats || !stats.days || Object.keys(stats.days).length === 0) {
    wrap.append(pagePlaceholder('stats'));
    container.append(wrap);
    return;
  }
  const today = stats.days[dayKey()] || {};
  const todayCard = h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:6px;' }, h('h3', {}, t('stats.today')));
  for (const [name, ms] of Object.entries(today.activeMs || {}).sort((a, b) => b[1] - a[1])) {
    todayCard.append(h('div', { class: 'current-row' },
      h('span', { style: 'flex:1;' }, name),
      h('span', { class: 'summary' }, formatDuration(ms)),
    ));
  }
  const switchTotal = Object.values(today.switches || {}).reduce((sum, count) => sum + count, 0);
  if (switchTotal) todayCard.append(h('div', { class: 'summary' }, t('stats.switchCount') + ': ' + switchTotal));
  if (today.requests) {
    todayCard.append(h('div', { class: 'summary' },
      t('stats.proxied') + ': ' + (today.requests.proxied || 0) + ' · ' + t('stats.direct') + ': ' + (today.requests.direct || 0)));
  }
  if (todayCard.children.length > 1) wrap.append(todayCard);

  const totals = dailyTotals(stats, 7);
  const metric = (day) => (day.proxied + day.direct) || Math.round(day.activeMs / 60000);
  const maxMetric = Math.max(1, ...totals.map(metric));
  const bars = h('div', { style: 'display:flex;align-items:flex-end;gap:6px;height:72px;' });
  const labels = h('div', { style: 'display:flex;gap:6px;' });
  for (const day of totals) {
    const value = metric(day);
    bars.append(h('div', {
      title: day.key,
      style: 'flex:1;border-radius:4px 4px 0 0;background:var(--accent);opacity:' + (value ? '0.85' : '0.18') + ';height:' + Math.max(4, Math.round((value / maxMetric) * 64)) + 'px;',
    }));
    labels.append(h('div', { style: 'flex:1;text-align:center;color:var(--muted);font-size:10px;' }, day.key.slice(5)));
  }
  wrap.append(h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px;' },
    h('h3', {}, t('stats.last7')), bars, labels));

  const topHosts = topEntries(today.hosts || {}, 8);
  if (topHosts.length) {
    const card = h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:6px;' }, h('h3', {}, t('stats.topHosts')));
    for (const [host, count] of topHosts) {
      card.append(h('div', { class: 'current-row' },
        h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, host),
        h('span', { class: 'summary' }, String(count)),
      ));
    }
    wrap.append(card);
  }
  const topRules = topEntries(today.ruleHits || {}, 8);
  if (topRules.length) {
    const card = h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:6px;' }, h('h3', {}, t('stats.topRules')));
    for (const [key, count] of topRules) {
      const parts = key.split('|');
      card.append(h('div', { class: 'current-row' },
        h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, parts[parts.length - 1] + ' (' + parts[0] + ')'),
        h('span', { class: 'summary' }, String(count)),
      ));
    }
    wrap.append(card);
  }
  container.append(wrap);
}

let homeStatsToken = 0;
async function renderHomeSummary(container) {
  const token = ++homeStatsToken;
  const response = await call(Message.STATS_GET);
  if (token !== homeStatsToken) return;
  const stats = response && response.ok ? response.stats : null;
  const today = (stats && stats.days && stats.days[dayKey()]) || {};
  const switchTotal = Object.values(today.switches || {}).reduce((sum, count) => sum + count, 0);
  const activeMs = Object.values(today.activeMs || {}).reduce((sum, ms) => sum + ms, 0);
  let line;
  if (today.requests) {
    line = t('stats.homeSummary').replace('{p}', String(today.requests.proxied || 0)).replace('{d}', String(today.requests.direct || 0)).replace('{s}', String(switchTotal));
  } else {
    line = t('stats.homeSummaryDesktop').replace('{s}', String(switchTotal)).replace('{t}', formatDuration(activeMs));
  }
  container.append(h('div', { class: 'summary', style: 'text-align:center;' }, line));
}

// ---- subscriptions ----
let subsFormOpen = false;

function pageSubsHead() {
  return h('div', { style: 'display:flex;align-items:center;gap:8px;' },
    h('strong', { class: 'section-title', style: 'flex:1;' }, t('subs.title')),
    h('button', { class: 'icon-btn', onclick: () => { subsFormOpen = !subsFormOpen; render(); } }, subsFormOpen ? '×' : '+'),
  );
}

function fmtSubTime(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  if (date.toDateString() === new Date().toDateString()) return date.toTimeString().slice(0, 5);
  return date.toISOString().slice(5, 10);
}

function renderSubsPage(container) {
  const subs = state.opts.subscriptions || [];
  if (subsFormOpen) container.append(subsAddForm());
  if (!subs.length) {
    container.append(pagePlaceholder('subs'));
    return;
  }
  for (const sub of subs) {
    const card = h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:6px;' });
    card.append(h('div', { class: 'current-row' },
      h('strong', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, sub.name || sub.url),
      h('span', { class: 'summary' }, sub.kind === 'config' ? t('subs.kindConfig') : t('subs.kindPac')),
    ));
    card.append(h('div', { class: 'summary', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, sub.url));
    const line = [t('subs.lastUpdate') + ': ' + fmtSubTime(sub.updatedAt)];
    if (sub.autoUpdate !== false) line.push(t('subs.nextUpdate') + ': ' + fmtSubTime((sub.updatedAt || 0) + subIntervalMinutes(sub) * 60000));
    if (sub.lastError) line.push(t('subs.lastError') + ': ' + sub.lastError);
    card.append(h('div', { class: 'summary' }, line.join(' · ')));
    if (sub.extra) {
      const parts = [];
      if (sub.extra.upload || sub.extra.download) parts.push(t('subs.upload') + ' ' + formatBytes(sub.extra.upload) + ' / ' + t('subs.download') + ' ' + formatBytes(sub.extra.download));
      if (sub.extra.total) parts.push(t('subs.total') + ' ' + formatBytes(sub.extra.total));
      if (sub.extra.expire) parts.push(t('subs.expire') + ' ' + new Date(sub.extra.expire * 1000).toISOString().slice(0, 10));
      if (parts.length) card.append(h('div', { class: 'summary' }, parts.join(' · ')));
    }
    card.append(h('div', { class: 'current-row' },
      h('button', { class: 'icon-btn', onclick: () => refreshSub(sub.id) }, t('subs.refresh')),
      h('button', { class: 'icon-btn', style: 'margin-left:auto;', onclick: () => removeSub(sub.id) }, t('subs.remove')),
    ));
    container.append(card);
  }
}

function subsAddForm() {
  const pacProfiles = Object.values(state.opts.profiles || {}).filter((profile) => profile.type === PROFILE_TYPE.PAC);
  const nameInput = h('input', { placeholder: t('subs.name') });
  const urlInput = h('input', { placeholder: t('subs.url') });
  const targetSelect = h('select', {},
    ...pacProfiles.map((profile) => h('option', { value: profile.name }, profile.name)));
  const targetWrap = h('label', { class: 'field' }, t('subs.targetProfile'), targetSelect);
  const kindSelect = h('select', {
    onchange: () => { targetWrap.style.display = kindSelect.value === 'pac' ? '' : 'none'; },
  },
  h('option', { value: 'pac' }, t('subs.kindPac')),
  h('option', { value: 'config' }, t('subs.kindConfig')),
  );
  const autoCheck = h('input', { type: 'checkbox' });
  autoCheck.checked = true;
  const intervalInput = h('input', { type: 'number', min: '0', placeholder: String(SUBS_DEFAULT_INTERVAL) });
  const form = h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px;' },
    nameInput, urlInput,
    h('label', { class: 'field' }, t('subs.kind'), kindSelect),
    targetWrap,
    h('label', { class: 'field', style: 'flex-direction:row;align-items:center;gap:6px;' }, autoCheck, t('subs.autoUpdate')),
    h('label', { class: 'field' }, t('subs.interval'), intervalInput),
    h('button', { class: 'btn', onclick: () => submitSub() }, t('subs.add')),
  );
  return form;

  async function submitSub() {
    const response = await call(Message.SUBS_ADD, {
      name: nameInput.value,
      url: urlInput.value,
      kind: kindSelect.value,
      targetProfile: targetSelect.value,
      autoUpdate: autoCheck.checked,
      updateInterval: Number(intervalInput.value) || 0,
    });
    if (!response || !response.ok) {
      setStatus('bad', (response && response.error) || t('subs.invalidUrl'));
      return;
    }
    subsFormOpen = false;
    state.opts = response.opts || state.opts;
    render();
  }
}

async function refreshSub(id) {
  const response = await call(Message.SUBS_REFRESH, { id });
  if (response && response.ok) {
    state.opts = response.opts || state.opts;
    render();
  } else {
    setStatus('bad', (response && response.error) || t('status.error'));
  }
}

async function removeSub(id) {
  if (!window.confirm(t('subs.confirmRemove'))) return;
  const response = await call(Message.SUBS_REMOVE, { id });
  if (response && response.ok) {
    state.opts = response.opts || state.opts;
    render();
  }
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
    h('div', { id: 'site-related', class: 'chips', style: 'flex-wrap:wrap;gap:4px;' }),
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
  updateSiteRelated();
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

async function refreshSiteRelated() {
  const token = ++siteRelatedToken;
  const response = await call(Message.TAB_RELATED_HOSTS);
  if (token !== siteRelatedToken) return;
  siteRelated = response && response.ok ? response.related : null;
  siteRelatedSelection.clear();
  for (const item of (siteRelated && siteRelated.hosts) || []) {
    if (item.affinity) siteRelatedSelection.add(item.host);
  }
  updateSiteRelated();
}

function updateSiteRelated() {
  const wrap = document.getElementById('site-related');
  if (!wrap) return;
  wrap.innerHTML = '';
  const hosts = (siteRelated && siteRelated.hosts) || [];
  const host = normalizeHost(siteHostValue);
  if (!hosts.length) {
    wrap.append(h('div', { class: 'summary', style: 'text-align:center;width:100%;' }, t('site.relatedEmpty')));
    return;
  }
  wrap.append(h('div', { class: 'summary', style: 'text-align:center;width:100%;' }, t('site.related')));
  const targets = siteTargets(state.opts);
  if (!siteRelatedTargetName || !targets.some((target) => target.name === siteRelatedTargetName)) {
    siteRelatedTargetName = (targets[0] || {}).name || null;
  }
  if (siteRelatedTargetName) {
    const targetSelect = h('select', {
      style: 'max-width:140px;',
      onchange: (event) => { siteRelatedTargetName = event.target.value; },
    },
    ...targets.map((target) => h('option', { value: target.name, selected: target.name === siteRelatedTargetName }, target.label)),
    );
    wrap.append(h('label', { class: 'field', style: 'width:100%;' }, t('site.relatedTarget'), targetSelect));
  }
  for (const item of hosts) {
    const selected = siteRelatedSelection.has(item.host);
    wrap.append(h('button', {
      class: 'chip',
      style: selected ? '' : 'opacity:0.45;',
      onclick: () => {
        if (siteRelatedSelection.has(item.host)) siteRelatedSelection.delete(item.host);
        else siteRelatedSelection.add(item.host);
        updateSiteRelated();
      },
    }, (selected ? '☑ ' : '☐ ') + item.host + ' ×' + item.count));
  }
  const apply = h('button', { class: 'chip', onclick: () => addRelatedRules() }, t('site.relatedApply'));
  apply.disabled = !host || siteRelatedSelection.size === 0;
  wrap.append(apply);
}

async function addRelatedRules() {
  const autoName = isAutoContext();
  if (!autoName || !siteRelatedTargetName || !siteRelatedSelection.size) return;
  const patterns = [...siteRelatedSelection]
    .map((candidate) => '*.' + candidate.replace(/^www./, ''));
  const response = await call(Message.ADD_RULES_BULK, {
    autoProfileName: autoName,
    targetProfileName: siteRelatedTargetName,
    patterns,
  });
  if (response?.ok) {
    state.opts = response.opts;
    render();
  } else {
    setStatus('bad', (response && response.error) || t('status.error'));
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
    if (host && host !== siteRelatedHost) {
      siteRelatedHost = host;
      await refreshSiteRelated();
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
