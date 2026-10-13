import {
  MSG,
  BUILTIN,
  PROFILE_TYPE,
  SCHEMES,
  SCHEME_LABEL,
  SCHEME_DEFAULT_PORT,
  CONDITION_TYPE,
} from '../common/constants.js';
import { loadOptions, clone, exportBackup, parseBackup, onChanged } from '../common/storage.js';
import { listProfiles, describe, blankProfile, validateProfile, nameTaken } from '../common/profiles.js';
import { applyTheme, glyphFor, send } from '../common/ui.js';
import { makeT, LANGS, LANG_LABELS } from '../common/i18n.js';
import { platform } from '../common/platform.js';

let committed = null;
let draft = null;
let view = { kind: 'profile', name: null };
let t = makeT('en');

// ---- hyperscript ----
function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
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
const $ = (id) => document.getElementById(id);
const frag = (...n) => { const f = document.createDocumentFragment(); f.append(...n.flat().filter(Boolean)); return f; };

// ---- dirty tracking ----
function isDirty() { return JSON.stringify(draft) !== JSON.stringify(committed); }
function refreshDirty() {
  const dirty = isDirty();
  $('apply').disabled = !dirty;
  $('discard').disabled = !dirty;
  const banner = $('dirty');
  banner.hidden = !dirty;
}
function mutate(fn) { fn(draft); refreshDirty(); }

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.classList.remove('show'); setTimeout(() => (el.hidden = true), 220); }, 1900);
}

// ---- init ----
async function init() {
  try {
    const state = await send({ type: MSG.GET_STATE });
    if (!state?.ok || !state.opts) throw new Error(state?.error || '桌面服务没有返回配置');
    committed = state.opts;
    draft = clone(committed);
    t = makeT(draft.settings?.lang || 'en');
    applyTheme(draft.settings?.theme || 'dark');
    document.documentElement.lang = draft.settings?.lang || 'en';

    const first = Object.keys(draft.profiles)[0];
    view = first ? { kind: 'profile', name: first } : { kind: 'general' };

    onChanged(async () => {
      if (isDirty()) return;
      committed = await loadOptions();
      draft = clone(committed);
      t = makeT(draft.settings?.lang || 'en');
      applyTheme(draft.settings?.theme || 'dark');
      renderAll();
    });

    renderAll();
  } catch (error) {
    const root = $('view');
    root.innerHTML = '';
    root.append(
      h('div', { class: 'card' },
        h('h2', {}, 'ProxyPilot 启动失败'),
        h('p', { class: 'hint', style: 'overflow-wrap:anywhere' }, String(error?.message || error || '未知错误')),
        h('button', { class: 'opt-btn primary', onclick: () => window.location.reload() }, '重新加载'),
      ),
    );
  }
}

async function applyChanges() {
  for (const [key, p] of Object.entries(draft.profiles)) {
    const errs = validateProfile(p);
    if (errs.length) {
      view = { kind: 'profile', name: key };
      renderAll();
      toast(t('toast.invalid', { key, err: t(errs[0].key, errs[0].params) }));
      return;
    }
  }
  const res = await send({ type: MSG.SAVE_OPTIONS, opts: draft });
  if (!res?.ok) {
    toast(t('toast.proxyFail', { msg: res.error || 'unknown error' }));
    return;
  }
  committed = res.opts;
  draft = clone(committed);
  refreshDirty();
  toast(t('toast.applied'));
}
function discardChanges() {
  draft = clone(committed);
  t = makeT(draft.settings?.lang || 'en');
  applyTheme(draft.settings?.theme || 'dark');
  renderAll();
  toast(t('toast.discarded'));
}

// ---- render shell ----
function renderAll() {
  applyTheme(draft.settings?.theme || 'dark');
  document.documentElement.lang = draft.settings?.lang || 'en';
  renderSidebar();
  renderView();
  // dirty banner content (localized)
  $('dirty').innerHTML = '';
  $('dirty').append(t('dirty.msg'), ' ', h('button', { class: 'opt-link', onclick: applyChanges }, t('dirty.applyNow')));
  refreshDirty();
}

function renderSidebar() {
  const side = $('sidebar');
  side.innerHTML = '';

  side.append(
    h('div', { class: 'opt-brand' }, h('b', {}, 'proxy'), h('span', { class: 'dim' }, '@local:~$'), h('span', { class: 'blink' })),
  );

  // profiles group
  const profList = h('ul', { class: 'opt-navlist' });
  for (const name of Object.keys(draft.profiles)) {
    const d = describe(name, draft, t);
    profList.append(
      h('li', {}, h('button', {
        class: 'opt-navitem' + (view.kind === 'profile' && view.name === name ? ' active' : ''),
        onclick: () => { view = { kind: 'profile', name }; renderAll(); },
      },
        h('span', { class: 'scheme' }, glyphFor(d)),
        h('span', {}, d.label),
      )),
    );
  }
  side.append(
    h('div', { class: 'opt-navgroup' },
      h('div', { class: 'opt-navtitle' }, t('opt.profiles')),
      profList,
      h('button', { class: 'opt-navadd', onclick: openNewDialog }, t('opt.new')),
    ),
  );

  // settings group
  const settingsItems = [['general', t('opt.general')], ['appearance', t('opt.appearance')], ['backup', t('opt.backup')]];
  side.append(
    h('div', { class: 'opt-navgroup' },
      h('div', { class: 'opt-navtitle' }, t('opt.settings')),
      h('ul', { class: 'opt-navlist' },
        ...settingsItems.map(([id, label]) =>
          h('li', {}, h('button', {
            class: 'opt-navitem' + (view.kind === id ? ' active' : ''),
            onclick: () => { view = { kind: id }; renderAll(); },
          }, h('span', { class: 'scheme' }, '··'), h('span', {}, label))),
        ),
      ),
    ),
  );

  // actions
  side.append(
    h('div', { class: 'opt-actions' },
      h('button', { id: 'apply', class: 'opt-btn primary', onclick: applyChanges }, t('act.apply')),
      h('button', { id: 'discard', class: 'opt-btn', onclick: discardChanges }, t('act.discard')),
    ),
  );
}

function renderView() {
  const root = $('view');
  root.innerHTML = '';
  if (view.kind === 'profile') {
    if (!draft.profiles[view.name]) {
      const first = Object.keys(draft.profiles)[0];
      view = first ? { kind: 'profile', name: first } : { kind: 'general' };
      return renderView();
    }
    root.append(renderProfile(view.name));
  } else if (view.kind === 'general') root.append(renderGeneral());
  else if (view.kind === 'appearance') root.append(renderAppearance());
  else if (view.kind === 'backup') root.append(renderBackup());
}

// ---- profile editor ----
function renderProfile(key) {
  const p = draft.profiles[key];
  const d = describe(key, draft, t);

  const nameInput = h('input', {
    type: 'text', value: p.name,
    onchange: (e) => renameProfile(key, e.target.value.trim()),
  });

  const head = h('div', { class: 'opt-vhead' },
    h('h1', { class: 'opt-h1' }, h('span', { class: 'scheme' }, glyphFor(d)), nameInput),
    h('button', { class: 'opt-btn danger', onclick: () => deleteProfile(key) }, t('prof.delete')),
  );

  const out = frag(head);
  if (p.type === PROFILE_TYPE.FIXED) out.append(renderFixed(key, p));
  else if (p.type === PROFILE_TYPE.PAC) out.append(renderPac(key, p));
  else if (p.type === PROFILE_TYPE.AUTO) out.append(renderAuto(key, p));
  return out;
}

function renderFixed(key, p) {
  const s = p.fallbackProxy;
  const scheme = h('select', {
    onchange: (e) => mutate((d) => {
      d.profiles[key].fallbackProxy.scheme = e.target.value;
      if (!s.port) d.profiles[key].fallbackProxy.port = SCHEME_DEFAULT_PORT[e.target.value];
    }),
  }, ...SCHEMES.map((sc) => h('option', { value: sc, ...(sc === s.scheme ? { selected: true } : {}) }, SCHEME_LABEL[sc])));

  const host = h('input', { type: 'text', value: s.host, placeholder: t('field.hostPlaceholder'),
    oninput: (e) => mutate((d) => (d.profiles[key].fallbackProxy.host = e.target.value)) });
  const port = h('input', { type: 'number', value: s.port, min: '1', max: '65535',
    oninput: (e) => mutate((d) => (d.profiles[key].fallbackProxy.port = Number(e.target.value))) });

  const serverCard = h('div', { class: 'card' },
    h('h3', {}, t('fixed.serverTitle')),
    h('p', { class: 'hint' }, t('fixed.serverHint')),
    h('div', { class: 'row proxy-grid' },
      field(t('field.scheme'), scheme),
      field(t('field.host'), host),
      field(t('field.port'), port),
    ),
    renderAuth(key, p),
  );

  const bypass = h('textarea', { placeholder: t('fixed.bypassPlaceholder'),
    oninput: (e) => mutate((d) => (d.profiles[key].bypassList = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))) });
  bypass.value = (p.bypassList || []).join('\n');

  const bypassCard = h('div', { class: 'card' },
    h('h3', {}, t('fixed.bypassTitle')),
    h('p', { class: 'hint', html: esc(t('fixed.bypassHint')) }),
    bypass,
  );
  return frag(serverCard, bypassCard);
}

function renderAuth(key, p) {
  const a = p.fallbackProxy.auth || {};
  const enabled = !!(a.username || a.password);
  const body = h('div', { style: 'margin-top:12px' });
  body.hidden = !enabled;
  body.append(
    h('div', { class: 'row', style: 'grid-template-columns:1fr 1fr' },
      field(t('field.username'), h('input', { type: 'text', value: a.username || '', autocomplete: 'off',
        oninput: (e) => mutate((d) => setAuth(d.profiles[key], 'username', e.target.value)) })),
      field(t('field.password'), h('input', { type: 'password', value: a.password || '', autocomplete: 'off',
        oninput: (e) => mutate((d) => setAuth(d.profiles[key], 'password', e.target.value)) })),
    ),
  );
  const toggle = switchRow(t('fixed.authToggle'), t('fixed.authHint'), enabled, (on) => {
    if (!on) mutate((d) => (d.profiles[key].fallbackProxy.auth = null));
    body.hidden = !on;
  });
  return frag(h('div', { style: 'border-top:1px solid var(--line);margin-top:12px;padding-top:2px' }, toggle), body);
}
function setAuth(profile, fieldName, value) {
  profile.fallbackProxy.auth = profile.fallbackProxy.auth || { username: '', password: '' };
  profile.fallbackProxy.auth[fieldName] = value;
}

function renderPac(key, p) {
  const url = h('input', { type: 'url', value: p.pacUrl || '', placeholder: 'https://example.com/proxy.pac',
    oninput: (e) => mutate((d) => (d.profiles[key].pacUrl = e.target.value)) });
  const script = h('textarea', { placeholder: 'function FindProxyForURL(url, host) {\n  return "DIRECT";\n}',
    oninput: (e) => mutate((d) => (d.profiles[key].pacScript = e.target.value)) });
  script.value = p.pacScript || '';
  return h('div', { class: 'card' },
    h('h3', {}, t('pac.editTitle')),
    h('p', { class: 'hint' }, t('pac.editHint')),
    field(t('field.pacUrl'), url),
    field(t('field.pacScript'), script),
  );
}

function renderAuto(key, p) {
  const targets = autoTargets();
  const rulesBox = h('div', { class: 'rules' },
    h('div', { class: 'rule-head' }, h('span', {}, t('rule.colType')), h('span', {}, t('rule.colPattern')), h('span', {}, t('rule.colTarget')), h('span', {})),
  );
  (p.rules || []).forEach((r, i) => rulesBox.append(renderRule(key, r, i, targets)));
  if (!(p.rules || []).length) rulesBox.append(h('div', { class: 'empty-hint' }, t('auto.empty')));

  const addBtn = h('button', { class: 'add-rule', onclick: () => mutate((d) => {
    d.profiles[key].rules = d.profiles[key].rules || [];
    d.profiles[key].rules.push({ condition: { type: CONDITION_TYPE.HOST_WILDCARD, pattern: '' }, profileName: BUILTIN.DIRECT });
    renderView();
  }) }, t('auto.addRule'));

  const def = h('select', { onchange: (e) => mutate((d) => (d.profiles[key].defaultProfileName = e.target.value)) },
    ...targets.map((tg) => h('option', { value: tg.name, ...(tg.name === p.defaultProfileName ? { selected: true } : {}) }, tg.label)));

  return h('div', { class: 'card' },
    h('h3', {}, t('auto.title')),
    h('p', { class: 'hint' }, t('auto.hint')),
    rulesBox,
    addBtn,
    h('div', { class: 'rule-default' },
      h('div', {}, h('strong', { style: 'font-size:12.5px' }, t('auto.defaultTitle')), h('div', { class: 'hint', style: 'margin:0' }, t('auto.defaultHint'))),
      def,
    ),
  );
}
function renderRule(key, r, index, targets) {
  const typeSel = h('select', { onchange: (e) => mutate((d) => (d.profiles[key].rules[index].condition.type = e.target.value)) },
    ...Object.values(CONDITION_TYPE).map((ct) => h('option', { value: ct, ...(ct === r.condition.type ? { selected: true } : {}) }, t('cond.' + ct))));
  const pat = h('input', { type: 'text', value: r.condition.pattern || '', placeholder: '*.example.com',
    oninput: (e) => mutate((d) => (d.profiles[key].rules[index].condition.pattern = e.target.value)) });
  const target = h('select', { onchange: (e) => mutate((d) => (d.profiles[key].rules[index].profileName = e.target.value)) },
    ...targets.map((tg) => h('option', { value: tg.name, ...(tg.name === r.profileName ? { selected: true } : {}) }, tg.label)));
  const del = h('button', { class: 'icon-del', onclick: () => mutate((d) => { d.profiles[key].rules.splice(index, 1); renderView(); }) }, '✕');
  return h('div', { class: 'rule' }, typeSel, pat, target, del);
}
function autoTargets() {
  return listProfiles(draft, t).filter((d) => d.kind === 'builtin' || d.type === PROFILE_TYPE.FIXED);
}

// ---- settings views ----
function renderGeneral() {
  const startupOpts = [{ name: '', label: t('gen.keepLast') }, ...listProfiles(draft, t).map((d) => ({ name: d.name, label: d.label }))];
  const startup = h('select', { onchange: (e) => mutate((d) => (d.settings.startupProfile = e.target.value)) },
    ...startupOpts.map((o) => h('option', { value: o.name, ...(o.name === (draft.settings.startupProfile || '') ? { selected: true } : {}) }, o.label)));

  return frag(
    sectionHead(t('gen.title')),
    h('div', { class: 'card' },
      h('h3', {}, t('gen.startupTitle')),
      h('p', { class: 'hint' }, t('gen.startupHint')),
      field(t('field.startup'), startup, 'max-width:320px'),
    ),
    h('div', { class: 'card' },
      h('h3', {}, t('gen.behaviorTitle')),
      switchRow(t('gen.refreshTitle'), t('gen.refreshHint'), !!draft.settings.refreshTabOnChange,
        (on) => mutate((d) => (d.settings.refreshTabOnChange = on))),
    ),
  );
}

function renderAppearance() {
  const theme = draft.settings.theme || 'dark';
  const themeSeg = h('div', { class: 'seg' },
    ...[['auto', t('theme.auto')], ['light', t('theme.light')], ['dark', t('theme.dark')]].map(([val, label]) =>
      h('button', { class: theme === val ? 'active' : '', onclick: () => { mutate((d) => (d.settings.theme = val)); renderAll(); } }, label)));

  const lang = draft.settings.lang || 'en';
  const langSeg = h('div', { class: 'seg' },
    ...LANGS.map((val) =>
      h('button', { class: lang === val ? 'active' : '', onclick: () => { mutate((d) => (d.settings.lang = val)); t = makeT(val); renderAll(); } }, LANG_LABELS[val])));

  return frag(
    sectionHead(t('appr.title')),
    h('div', { class: 'card' }, h('h3', {}, t('appr.themeTitle')), h('p', { class: 'hint' }, t('appr.themeHint')), themeSeg),
    h('div', { class: 'card' }, h('h3', {}, t('appr.langTitle')), h('p', { class: 'hint' }, t('appr.langHint')), langSeg),
  );
}

function renderBackup() {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: onRestoreFile });
  return frag(
    sectionHead(t('bk.title')),
    h('div', { class: 'card' }, h('h3', {}, t('bk.backupTitle')), h('p', { class: 'hint' }, t('bk.backupHint')),
      h('button', { class: 'opt-btn', style: 'display:inline-block;width:auto', onclick: doBackup }, t('bk.exportBtn'))),
    h('div', { class: 'card' }, h('h3', {}, t('bk.restoreTitle')), h('p', { class: 'hint' }, t('bk.restoreHint')),
      h('button', { class: 'opt-btn', style: 'display:inline-block;width:auto', onclick: () => fileInput.click() }, t('bk.restoreBtn')),
      fileInput),
  );
}
function doBackup() {
  const blob = new Blob([exportBackup(draft)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `proxypilot-backup-${dateStamp()}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(t('toast.exported'));
}
function onRestoreFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      draft = parseBackup(String(reader.result));
      t = makeT(draft.settings?.lang || 'en');
      const first = Object.keys(draft.profiles)[0];
      view = first ? { kind: 'profile', name: first } : { kind: 'general' };
      renderAll();
      toast(t('toast.restored'));
    } catch (e) { toast(t('toast.restoreFail', { msg: e.message })); }
  };
  reader.readAsText(file);
}

// ---- create / rename / delete ----
let dialogEl = null;
function ensureDialog() {
  if (dialogEl) return dialogEl;
  const types = [
    ['fixed', t('type.fixed'), t('type.fixedDesc')],
    ['auto', t('type.auto'), t('type.autoDesc')],
    ['pac', t('type.pac'), t('type.pacDesc')],
  ];
  const nameInput = h('input', { id: 'np-name', type: 'text', placeholder: t('np.namePlaceholder'), autocomplete: 'off' });
  const errEl = h('small', { id: 'np-error', class: 'field-error' });
  const typeCards = h('div', { class: 'type-cards' },
    ...types.map(([val, title, desc], i) =>
      h('label', { class: 'type-card' },
        h('input', { type: 'radio', name: 'np-type', value: val, ...(i === 0 ? { checked: true } : {}) }),
        h('div', { class: 'tc' }, h('strong', {}, title), h('span', {}, desc)),
      )),
  );
  const cancelBtn = h('button', { type: 'button', class: 'opt-btn', style: 'width:auto', onclick: () => dialogEl.close() }, t('np.cancel'));
  const createBtn = h('button', { class: 'opt-btn primary', style: 'width:auto' }, t('np.create'));

  const form = h('form', { method: 'dialog', class: 'dialog-body' },
    h('h3', {}, t('np.title')),
    h('label', { class: 'field' }, h('span', {}, t('np.name')), nameInput, errEl),
    h('div', { style: 'font-size:11px;color:var(--muted);margin-bottom:6px' }, t('np.selectType')),
    typeCards,
    h('div', { class: 'dialog-actions' }, cancelBtn, createBtn),
  );

  // Create is the only submit button, so Enter and the button share this path.
  form.addEventListener('submit', (ev) => {
    const name = nameInput.value.trim();
    const type = form.querySelector('input[name="np-type"]:checked').value;
    if (!name) { ev.preventDefault(); errEl.textContent = t('np.nameEmpty'); return; }
    if (nameTaken(name, draft)) { ev.preventDefault(); errEl.textContent = t('np.nameTaken'); return; }
    mutate((d) => (d.profiles[name] = blankProfile(name, type, d)));
    view = { kind: 'profile', name };
    renderAll(); // dialog closes via default submit behavior
  });

  dialogEl = h('dialog', { class: 'dialog' }, form);
  document.body.append(dialogEl);
  return dialogEl;
}
function openNewDialog() {
  // Rebuild each time so labels follow the current language.
  if (dialogEl) { dialogEl.remove(); dialogEl = null; }
  const dlg = ensureDialog();
  dlg.showModal();
}

function renameProfile(oldKey, newKey) {
  if (!newKey || newKey === oldKey) { renderAll(); return; }
  if (nameTaken(newKey, draft, oldKey)) { toast(t('toast.nameTaken')); renderAll(); return; }
  mutate((d) => {
    const p = d.profiles[oldKey];
    p.name = newKey;
    const reordered = {};
    for (const k of Object.keys(d.profiles)) reordered[k === oldKey ? newKey : k] = d.profiles[k];
    d.profiles = reordered;
    remapReferences(d, oldKey, newKey);
  });
  view = { kind: 'profile', name: newKey };
  renderAll();
}
function deleteProfile(key) {
  if (!confirm(t('prof.confirmDelete', { name: key }))) return;
  mutate((d) => { delete d.profiles[key]; remapReferences(d, key, BUILTIN.DIRECT); });
  const first = Object.keys(draft.profiles)[0];
  view = first ? { kind: 'profile', name: first } : { kind: 'general' };
  renderAll();
}
function remapReferences(d, from, to) {
  if (d.activeProfile === from) d.activeProfile = to;
  if (d.settings.startupProfile === from) d.settings.startupProfile = to === BUILTIN.DIRECT ? '' : to;
  for (const p of Object.values(d.profiles)) {
    if (p.type === PROFILE_TYPE.AUTO) {
      if (p.defaultProfileName === from) p.defaultProfileName = to;
      for (const r of p.rules || []) if (r.profileName === from) r.profileName = to;
    }
  }
}

// ---- builders ----
function sectionHead(title) { return h('div', { class: 'opt-vhead' }, h('h1', { class: 'opt-h1' }, title)); }
function field(label, control, extraStyle) {
  return h('label', { class: 'field', style: 'margin:0' + (extraStyle ? ';' + extraStyle : '') }, h('span', {}, label), control);
}
function switchRow(title, desc, checked, onToggle) {
  const box = h('button', { class: 't-check' + (checked ? ' on' : '') }, checked ? '[x]' : '[ ]');
  let on = checked;
  box.addEventListener('click', () => { on = !on; box.textContent = on ? '[x]' : '[ ]'; box.classList.toggle('on', on); onToggle(on); });
  return h('div', { class: 'toggle-row' },
    h('div', { class: 'ttext' }, h('strong', {}, title), h('span', {}, desc)),
    box,
  );
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }
function dateStamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }

init();
