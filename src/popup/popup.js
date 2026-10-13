import { MSG, BUILTIN, PROFILE_TYPE, CONDITION_TYPE } from '../common/constants.js';
import { listProfiles, summarize, describe } from '../common/profiles.js';
import { saveOptions } from '../common/storage.js';
import { buildAutoPac } from '../common/proxy.js';
import { applyTheme, glyphFor, send } from '../common/ui.js';
import { makeT, LANGS } from '../common/i18n.js';
import { platform } from '../common/platform.js';

const app = document.getElementById('app');
const VERSION = platform.runtime.getManifest().version;

let state = null; // { opts, levelOfControl }
let t = makeT('en');
let page = 'home';

// ---- tiny hyperscript ----
function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}
const frag = (...n) => { const f = document.createDocumentFragment(); f.append(...n.flat().filter(Boolean)); return f; };

async function init() {
  try {
    state = await send({ type: MSG.GET_STATE });
    if (!state?.ok || !state.opts) throw new Error(state?.error || '桌面服务没有返回配置');
    t = makeT(state.opts.settings?.lang || 'en');
    applyTheme(state.opts.settings?.theme || 'dark');
    document.documentElement.lang = state.opts.settings?.lang || 'en';
    render();
    await renderSiteAsync();
  } catch (error) {
    renderBootError(error);
  }
}

function renderBootError(error) {
  const message = String(error?.message || error || '未知错误');
  app.innerHTML = '';
  app.style.padding = '28px 22px';
  app.style.display = 'flex';
  app.style.flexDirection = 'column';
  app.style.gap = '12px';
  app.append(
    h('strong', { style: 'font-size:14px;color:#F87171' }, 'ProxyPilot 启动失败'),
    h('span', { style: 'color:var(--fg-2);line-height:1.6;overflow-wrap:anywhere' }, message),
    h('button', { class: 't-btn', style: 'width:max-content', onclick: () => window.location.reload() }, '重新加载'),
  );
}

const opts = () => state.opts;
const active = () => state.opts.activeProfile;

function render() {
  app.innerHTML = '';
  const body =
    page === 'home' ? pageHome()
    : page === 'servers' ? pageServers()
    : page === 'rules' ? pageRules()
    : page === 'pac' ? pagePac()
    : page === 'subs' ? pageSubs()
    : page === 'stats' ? pageStats()
    : pageHome();
  app.append(body, cmdBar(), statusLine());
}

// ---- home ----
function pageHome() {
  const d = describe(active(), opts(), t);
  const head = h('div', { class: 't-head' },
    h('div', { class: 't-prompt' },
      h('span', {}, h('b', {}, 'proxy'), '@local'),
      h('span', { class: 'dim' }, ':~$'),
      h('span', {}, t('home.cmd')),
      h('span', { class: 'blink' }),
      h('span', { class: 'ctl-group' },
        h('button', { class: 't-ctl', title: t('ctl.lang'), onclick: cycleLang }, langGlyph()),
        h('button', { class: 't-ctl', title: t('ctl.theme'), onclick: toggleTheme }, '◐'),
        h('button', { class: 't-ctl', title: t('ctl.options'), onclick: openOptions }, '⚙'),
      ),
    ),
    h('div', { class: 't-card' },
      cardRow(t('home.active'), h('span', { class: 'v big' }, d.label), h('span', { class: 'v lat-na' }, '—')),
      cardRow(t('home.via'), h('span', { class: 'v' }, summarize(active(), opts(), t)), h('span', { class: 'v dim' }, glyphFor(d))),
      cardRow(t('home.type'), h('span', { class: 'v' }, typeLabel(d.type)), h('span', { class: 'v dim' }, '')),
    ),
    siteBlockPlaceholder(),
  );

  const profiles = listProfiles(opts(), t);
  const list = h('div', { class: 't-list' },
    ...profiles.map((p, i) => profileRow(p, i)),
  );

  return frag(
    head,
    h('div', { class: 't-section-label' }, h('span', {}, t('home.profiles')), h('span', {}, String(profiles.length))),
    list,
  );
}

function cardRow(k, vNode, rightNode) {
  return h('div', { class: 'row' }, h('span', { class: 'k' }, k), vNode, rightNode);
}

function profileRow(p, i) {
  const isActive = active() === p.name;
  return h('div', {
    class: 't-row' + (isActive ? ' active' : ''),
    onclick: () => switchTo(p.name),
  },
    h('span', { class: 'dot' }),
    h('span', { class: 'scheme' }, glyphFor(p)),
    h('span', {},
      h('div', { class: 'name' }, p.label),
      h('div', { class: 'host' }, summarize(p.name, opts(), t)),
    ),
    h('span', { class: 'lat lat-na' }, '—'),
    h('span', { class: 'hot' }, i < 9 ? String(i + 1) : ''),
  );
}

function typeLabel(type) {
  return { direct: 'DIRECT', system: 'SYSTEM', fixed: 'FIXED', pac: 'PAC', auto: 'AUTO' }[type] || type;
}

async function switchTo(name) {
  const res = await send({ type: MSG.SWITCH_PROFILE, name });
  if (!res?.ok) {
    state = { ...state, opts: res.opts || state.opts, levelOfControl: 'not_controllable', proxyError: res.error || 'proxy change failed' };
    render();
    return;
  }
  state = { ...state, opts: res.opts };
  render();
  await renderSiteAsync();
  if (opts().settings?.refreshTabOnChange) {
    const [tab] = await platform.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) platform.tabs.reload(tab.id);
  }
}

// ---- current-site quick rule (only when active profile is auto) ----
function siteBlockPlaceholder() {
  // Filled asynchronously by renderSiteAsync once the tab host is known.
  return h('div', { id: 'site-slot' });
}

async function renderSiteAsync() {
  const slot = document.getElementById('site-slot');
  if (!slot) return;
  slot.innerHTML = '';
  const a = opts().profiles[active()];
  if (!a || a.type !== PROFILE_TYPE.AUTO) return;

  const [tab] = await platform.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { if (tab?.url) host = new URL(tab.url).hostname; } catch (_) { /* non-web */ }
  if (!host) return;

  const targets = [describe(BUILTIN.DIRECT, opts(), t),
    ...listProfiles(opts(), t).filter((d) => d.kind === 'user' && d.type === PROFILE_TYPE.FIXED)];

  slot.append(
    h('div', { class: 't-site' },
      h('div', { class: 'site-head' },
        h('span', { class: 'site-host' }, host),
        h('span', {}, t('home.matches'), ' → ', ruleResultFor(host, a)),
      ),
      h('div', { class: 'chips' },
        ...targets.map((tg) =>
          h('button', { class: 'chip', onclick: () => addRule(host, a.name, tg.name) },
            t('home.routeVia'), ' ', tg.label),
        ),
      ),
    ),
  );
}

function ruleResultFor(host, auto) {
  for (const r of auto.rules || []) {
    const c = r.condition || {};
    if (c.pattern && matchHost(c.type, c.pattern.trim(), host)) return describe(r.profileName, opts(), t).label;
  }
  return describe(auto.defaultProfileName, opts(), t).label;
}
function matchHost(type, pat, host) {
  host = host.toLowerCase();
  try {
    if (type === CONDITION_TYPE.HOST_WILDCARD) return wildcard(pat, host) || (pat.startsWith('*.') && host === pat.slice(2));
    if (type === CONDITION_TYPE.HOST_REGEX) return new RegExp(pat).test(host);
    if (type === CONDITION_TYPE.URL_WILDCARD) return wildcard(pat, host);
    if (type === CONDITION_TYPE.URL_REGEX) return new RegExp(pat).test(host);
  } catch (_) { /* invalid */ }
  return false;
}
function wildcard(pat, str) {
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(str);
}
async function addRule(host, autoName, targetName) {
  const res = await send({
    type: MSG.ADD_QUICK_RULE,
    autoProfileName: autoName,
    targetProfileName: targetName,
    conditionType: CONDITION_TYPE.HOST_WILDCARD,
    pattern: `*.${host.replace(/^www\./, '')}`,
  });
  if (res.ok) { state = { ...state, opts: res.opts }; render(); await renderSiteAsync(); }
}

// ---- servers (fixed-proxy profiles) ----
function pageServers() {
  const fixed = Object.values(opts().profiles).filter((p) => p.type === PROFILE_TYPE.FIXED);
  return frag(
    subHead(t('servers.title'), t('servers.entries', { n: fixed.length })),
    h('div', { class: 't-toolbar' },
      h('input', { id: 'srv-filter', placeholder: t('servers.filter'), oninput: filterServers }),
      h('button', { class: 't-btn', onclick: () => openOptions() }, t('servers.new')),
    ),
    fixed.length
      ? h('div', { class: 't-list', id: 'srv-list', style: 'padding:0' },
          ...fixed.map((s) => serverRow(s)))
      : emptyState(t('servers.empty')),
  );
}
function serverRow(s) {
  const fp = s.fallbackProxy || {};
  return h('div', { class: 't-server-row', 'data-q': `${s.name} ${fp.host} ${fp.scheme}`.toLowerCase() },
    h('span', { class: 'scheme' }, (fp.scheme || '').toUpperCase()),
    h('span', {},
      h('div', {}, s.name, h('span', { class: 'fade' }, ` · ${fp.host || '—'}:${fp.port || ''}`)),
      h('div', { class: 'fade', style: 'font-size:10px' }, fp.auth?.username ? `auth · ${fp.auth.username}` : '—'),
    ),
    h('button', { class: 'edit', onclick: () => openOptions() }, t('servers.edit')),
  );
}
function filterServers(e) {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#srv-list .t-server-row').forEach((row) => {
    row.style.display = !q || row.getAttribute('data-q').includes(q) ? '' : 'none';
  });
}

// ---- rules (aggregate auto-switch rules) ----
function pageRules() {
  const autos = Object.values(opts().profiles).filter((p) => p.type === PROFILE_TYPE.AUTO);
  const rows = [];
  for (const a of autos) {
    for (const r of a.rules || []) {
      rows.push({ match: r.condition?.pattern || '', via: describe(r.profileName, opts(), t).label });
    }
    rows.push({ match: t('rules.default'), via: describe(a.defaultProfileName, opts(), t).label, dim: true });
  }
  return frag(
    subHead(t('rules.title'), t('rules.count', { n: rows.filter((r) => !r.dim).length })),
    rows.length
      ? frag(
          h('div', { class: 't-list', style: 'padding:0' },
            ...rows.map((r) =>
              h('div', { class: 't-rule-row' },
                h('span', { class: 'match' + (r.dim ? ' fade' : '') }, r.match),
                h('span', { class: 'via' }, '→ ', r.via),
              ),
            ),
          ),
          h('div', { class: 't-toolbar', style: 'border-top:1px solid var(--line);border-bottom:0' },
            h('button', { class: 't-btn', onclick: () => openOptions() }, t('rules.manage')),
          ),
        )
      : emptyState(t('rules.empty')),
  );
}

// ---- pac ----
function pagePac() {
  const resolved = pacSource();
  if (!resolved) {
    return frag(subHead(t('pac.title'), ''), emptyState(t('pac.empty')));
  }
  const lines = resolved.src.split('\n');
  const pre = h('div', { class: 't-pac' });
  lines.forEach((l, i) => {
    pre.append(h('div', {}, h('span', { class: 'ln' }, String(i + 1)), highlightPac(l)));
  });
  return frag(
    subHead(t('pac.title'), t('pac.meta', { n: lines.length })),
    resolved.note ? h('div', { class: 't-toolbar' }, h('span', { class: 'fade' }, resolved.note)) : null,
    pre,
    h('div', { class: 't-toolbar', style: 'border-top:1px solid var(--line);border-bottom:0' },
      h('button', { class: 't-btn', onclick: () => openOptions() }, t('pac.editIn')),
    ),
  );
}
function pacSource() {
  const a = opts().profiles[active()];
  if (a && a.type === PROFILE_TYPE.PAC) {
    if (a.pacScript && a.pacScript.trim()) return { src: a.pacScript };
    if (a.pacUrl) return { src: `// url: ${a.pacUrl}` };
  }
  if (a && a.type === PROFILE_TYPE.AUTO) return { src: buildAutoPac(a, opts()), note: t('pac.generated') };
  const firstPac = Object.values(opts().profiles).find((p) => p.type === PROFILE_TYPE.PAC);
  if (firstPac) {
    if (firstPac.pacScript?.trim()) return { src: firstPac.pacScript };
    if (firstPac.pacUrl) return { src: `// url: ${firstPac.pacUrl}` };
  }
  const firstAuto = Object.values(opts().profiles).find((p) => p.type === PROFILE_TYPE.AUTO);
  if (firstAuto) return { src: buildAutoPac(firstAuto, opts()), note: t('pac.generated') };
  return null;
}
const KEYWORDS = ['function', 'return', 'if', 'else', 'var', 'const', 'let', 'new'];
function highlightPac(line) {
  const out = h('span');
  const tokens = line.split(/("(?:[^"\\]|\\.)*")/g);
  tokens.forEach((tok, i) => {
    if (i % 2 === 1) { out.append(h('span', { class: 'str' }, tok)); return; }
    const ci = tok.indexOf('//');
    if (ci >= 0) {
      appendKeywords(out, tok.slice(0, ci));
      out.append(h('span', { class: 'com' }, tok.slice(ci)));
    } else {
      appendKeywords(out, tok);
    }
  });
  return out;
}
function appendKeywords(out, text) {
  text.split(/\b(function|return|if|else|var|const|let|new)\b/).forEach((p) => {
    out.append(KEYWORDS.includes(p) ? h('span', { class: 'kw' }, p) : document.createTextNode(p));
  });
}

// ---- subs / stats placeholders ----
function pageSubs() {
  return frag(subHead(t('subs.title'), ''), emptyState(t('subs.empty'), t('subs.note')));
}
function pageStats() {
  return frag(subHead(t('stats.title'), ''), emptyState(t('stats.empty'), t('stats.note')));
}
function emptyState(big, note) {
  return h('div', { class: 't-empty' },
    h('div', { class: 'big' }, big),
    note ? h('div', { class: 'note' }, note) : null,
  );
}

// ---- shared chrome: sub header, command bar, status ----
function subHead(title, right) {
  return h('div', { class: 't-sub-head' },
    h('button', { class: 'back', onclick: () => goPage('home') }, t('nav.back')),
    h('span', { class: 'title' }, title),
    h('span', { class: 'right' }, right || ''),
  );
}
function cmdBar() {
  const items = [
    ['home', t('cmd.home'), 'h'],
    ['servers', t('cmd.servers'), 'n'],
    ['rules', t('cmd.rules'), 'r'],
    ['pac', t('cmd.pac'), 'p'],
    ['subs', t('cmd.subs'), 's'],
    ['stats', t('cmd.stats'), 't'],
  ];
  return h('div', { class: 't-cmdbar' },
    ...items.map(([id, label, key]) =>
      h('button', { class: 't-cmd' + (page === id ? ' active' : ''), onclick: () => goPage(id) },
        h('span', {}, label),
        h('span', { class: 'kbd' }, `[${key}]`),
      ),
    ),
  );
}
function statusLine() {
  const d = describe(active(), opts(), t);
  const conflicted = state.levelOfControl === 'controlled_by_other_extensions' || state.levelOfControl === 'not_controllable';
  return h('div', { class: 't-status' },
    h('span', {}, t('status.version', { v: VERSION })),
    h('span', { class: 'mid' + (conflicted ? ' lat-bad' : '') },
      conflicted ? '! ' + (state.proxyError || 'proxy unavailable') : frag(d.label, h('span', { class: 'sep' }, ' · '), glyphFor(d))),
    h('span', {}, '↑ — ', h('span', { class: 'sep' }, '·'), ' ↓ —'),
  );
}

function goPage(p) { page = p; render(); if (p === 'home') renderSiteAsync(); }

// ---- controls ----
function openOptions() { platform.runtime.openOptionsPage(); window.close(); }

async function persistSettings() {
  await saveOptions(state.opts);
}
async function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  state.opts.settings.theme = cur === 'dark' ? 'light' : 'dark';
  applyTheme(state.opts.settings.theme);
  await persistSettings();
}
async function cycleLang() {
  const i = LANGS.indexOf(state.opts.settings.lang || 'en');
  state.opts.settings.lang = LANGS[(i + 1) % LANGS.length];
  t = makeT(state.opts.settings.lang);
  document.documentElement.lang = state.opts.settings.lang;
  await persistSettings();
  render();
  renderSiteAsync();
}
function langGlyph() {
  return { en: 'EN', zh: '中', ja: 'JA' }[state.opts.settings.lang || 'en'] || 'EN';
}

// ---- keyboard ----
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const map = { h: 'home', n: 'servers', r: 'rules', p: 'pac', s: 'subs', t: 'stats' };
  const k = e.key.toLowerCase();
  if (map[k]) { goPage(map[k]); return; }
  if (k === 'escape' || k === 'b') { if (page !== 'home') goPage('home'); return; }
  if (page === 'home' && /^[1-9]$/.test(e.key)) {
    const list = listProfiles(opts(), t);
    const idx = Number(e.key) - 1;
    if (list[idx]) switchTo(list[idx].name);
  }
});

init();
