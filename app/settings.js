import { api, h, setThemeMode, onStorageChanged } from './shared.js';
import { createTranslator } from './i18n.js';
import { BUILTIN, PROFILE_TYPE, RuleKind, SCHEMES, DEFAULT_PORT, Message, freshProfile } from './model.js';

let committed = null;
let draft = null;
let view = { kind: 'profile', name: null };
let t = createTranslator('zh');
let toastTimer = null;

const pane = () => document.getElementById('pane');
const isDirty = () => JSON.stringify(draft) !== JSON.stringify(committed);

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function describe(name) {
  if (name === BUILTIN.DIRECT) return { label: t('profile.direct'), color: '#64748b' };
  if (name === BUILTIN.SYSTEM) return { label: t('profile.system'), color: '#94a3b8' };
  const profile = draft.profiles[name];
  return { label: profile ? profile.name : name, color: profile ? profile.color : '#94a3b8' };
}

function refreshBar() {
  const bar = document.getElementById('actionbar');
  bar.innerHTML = '';
  const dirty = isDirty();
  bar.append(
    h('span', { class: 'msg' + (dirty ? ' bad' : '') }, dirty ? t('dirty.unsaved') : ''),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn', onclick: discard, disabled: !dirty }, t('action.discard')),
    h('button', { class: 'btn primary', onclick: apply, disabled: !dirty }, t('action.apply')),
  );
}

function mutate(fn) { fn(draft); refreshBar(); }

function validate() {
  const errors = [];
  const names = new Set();
  for (const profile of Object.values(draft.profiles)) {
    if (!profile.name || !profile.name.trim()) errors.push(t('err.nameRequired'));
    const lower = profile.name ? profile.name.trim().toLowerCase() : '';
    if (lower && names.has(lower)) errors.push(t('err.nameTaken'));
    names.add(lower);
    if (profile.type === PROFILE_TYPE.FIXED) {
      if (!profile.fallbackProxy.host || !profile.fallbackProxy.host.trim()) errors.push(t('err.hostRequired'));
      const port = Number(profile.fallbackProxy.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(t('err.portRange'));
    }
    if (profile.type === PROFILE_TYPE.PAC && !profile.pacUrl?.trim() && !profile.pacScript?.trim()) {
      errors.push(t('err.pacRequired'));
    }
    (profile.rules || []).forEach((rule, index) => {
      if (!rule.condition?.pattern?.trim()) errors.push(t('err.rulePattern', { n: index + 1 }));
    });
  }
  return errors;
}

async function apply() {
  const errors = validate();
  if (errors.length) { toast(errors[0]); return; }
  const response = await api.call({ type: Message.SAVE_OPTIONS, opts: draft });
  if (!response?.ok) { toast(t('toast.error') + ': ' + (response?.error || '')); return; }
  committed = response.opts;
  draft = JSON.parse(JSON.stringify(committed));
  refreshBar();
  toast(t('toast.saved'));
}

function discard() {
  draft = JSON.parse(JSON.stringify(committed));
  setThemeMode(draft.settings?.theme);
  renderAll();
  toast(t('toast.discarded'));
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  nav.append(h('div', { class: 'group' }, t('nav.profiles')));
  for (const name of Object.keys(draft.profiles)) {
    const info = describe(name);
    nav.append(h('button', {
      class: 'item' + (view.kind === 'profile' && view.name === name ? ' active' : ''),
      onclick: () => { view = { kind: 'profile', name }; renderAll(); },
    },
      h('span', { class: 'dot', style: 'background:' + info.color }),
      h('span', {}, info.label),
    ));
  }
  nav.append(h('button', { class: 'item', onclick: addProfile }, '+ ' + t('nav.new')));
  nav.append(h('div', { class: 'spacer' }));
  nav.append(h('div', { class: 'group' }, t('main.settings')));
  const sections = { general: t('nav.general'), appearance: t('nav.appearance'), backup: t('nav.backup') };
  for (const kind of ['general', 'appearance', 'backup']) {
    nav.append(h('button', {
      class: 'item' + (view.kind === kind ? ' active' : ''),
      onclick: () => { view = { kind }; renderAll(); },
    }, sections[kind]));
  }
}

function addProfile() {
  // Electron does not implement window.prompt(), so the new-profile flow uses
  // an in-page dialog with a name field and a profile-type picker.
  const nameInput = h('input', {
    placeholder: t('field.name'),
    onkeydown: (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') close();
    },
  });
  const typeSelect = h('select', {},
    h('option', { value: PROFILE_TYPE.FIXED }, t('type.fixed')),
    h('option', { value: PROFILE_TYPE.PAC }, t('type.pac')),
    h('option', { value: PROFILE_TYPE.AUTO }, t('type.auto')),
  );
  const overlay = h('div', {
    class: 'dialog-overlay',
    onclick: (event) => { if (event.target === overlay) close(); },
  },
    h('div', { class: 'dialog' },
      h('h3', {}, t('nav.new')),
      field(t('field.name'), nameInput),
      field(t('field.type'), typeSelect),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: close }, t('action.cancel')),
        h('button', { class: 'btn primary', onclick: submit }, t('action.create')),
      ),
    ),
  );
  function close() { overlay.remove(); }
  function submit() {
    const name = nameInput.value.trim();
    if (!name) { toast(t('err.nameRequired')); nameInput.focus(); return; }
    if (draft.profiles[name]) { toast(t('err.nameTaken')); nameInput.focus(); return; }
    const type = typeSelect.value;
    close();
    mutate((data) => { data.profiles[name] = freshProfile(name, type, data.profiles); });
    view = { kind: 'profile', name };
    renderAll();
  }
  document.body.append(overlay);
  setTimeout(() => nameInput.focus(), 0);
}

function deleteProfile(key) {
  if (!window.confirm(t('confirm.delete', { name: draft.profiles[key]?.name || key }))) return;
  mutate((data) => {
    delete data.profiles[key];
    if (data.activeProfile === key) data.activeProfile = BUILTIN.DIRECT;
    if (data.settings.startupProfile === key) data.settings.startupProfile = '';
    for (const other of Object.values(data.profiles)) {
      if (other.defaultProfileName === key) other.defaultProfileName = BUILTIN.DIRECT;
      for (const rule of other.rules || []) {
        if (rule.profileName === key) rule.profileName = BUILTIN.DIRECT;
      }
    }
  });
  view = { kind: 'general' };
  renderAll();
}

function renameProfile(key, next) {
  if (!next || next === key) { renderAll(); return; }
  if (draft.profiles[next]) { toast(t('err.nameTaken')); renderAll(); return; }
  mutate((data) => {
    const reordered = {};
    for (const [existing, value] of Object.entries(data.profiles)) {
      if (existing === key) { value.name = next; reordered[next] = value; }
      else reordered[existing] = value;
    }
    data.profiles = reordered;
    if (data.activeProfile === key) data.activeProfile = next;
    if (data.settings.startupProfile === key) data.settings.startupProfile = next;
    for (const other of Object.values(data.profiles)) {
      if (other.defaultProfileName === key) other.defaultProfileName = next;
      for (const rule of other.rules || []) {
        if (rule.profileName === key) rule.profileName = next;
      }
    }
  });
  view = { kind: 'profile', name: next };
  renderAll();
}

function field(labelText, control) {
  return h('label', { class: 'field' }, h('span', {}, labelText), control);
}

function renderProfile(key) {
  const profile = draft.profiles[key];
  const root = pane();
  root.append(h('h1', {}, profile.name || key));
  const typeLabel = { fixed: t('type.fixed'), pac: t('type.pac'), auto: t('type.auto') }[profile.type] || profile.type;
  root.append(h('p', { class: 'sub' }, typeLabel));
  root.append(h('div', { class: 'card' },
    field(t('field.name'), h('input', { value: profile.name, onchange: (e) => renameProfile(key, e.target.value.trim()) })),
  ));
  if (profile.type === PROFILE_TYPE.FIXED) root.append(...fixedCards(key, profile));
  if (profile.type === PROFILE_TYPE.PAC) root.append(pacCard(key, profile));
  if (profile.type === PROFILE_TYPE.AUTO) root.append(autoCard(key, profile));
  root.append(h('div', { class: 'card' },
    h('button', { class: 'btn danger', onclick: () => deleteProfile(key) }, t('action.delete')),
  ));
}

function fixedCards(key, profile) {
  const server = profile.fallbackProxy;
  const scheme = h('select', { onchange: (e) => mutate((data) => {
    data.profiles[key].fallbackProxy.scheme = e.target.value;
    if (!data.profiles[key].fallbackProxy.port) data.profiles[key].fallbackProxy.port = DEFAULT_PORT[e.target.value];
  }) }, ...SCHEMES.map((s) => h('option', { value: s, selected: s === server.scheme }, s.toUpperCase())));
  const host = h('input', { value: server.host, oninput: (e) => mutate((data) => { data.profiles[key].fallbackProxy.host = e.target.value; }) });
  const port = h('input', { type: 'number', min: 1, max: 65535, value: server.port, oninput: (e) => mutate((data) => { data.profiles[key].fallbackProxy.port = Number(e.target.value); }) });
  const authSwitch = h('div', {
    class: 'switch' + (server.auth ? ' on' : ''), role: 'switch',
    onclick: (event) => {
      const on = !event.currentTarget.classList.contains('on');
      event.currentTarget.classList.toggle('on', on);
      mutate((data) => {
        data.profiles[key].fallbackProxy.auth = on
          ? { username: server.auth?.username || '', password: server.auth?.password || '' }
          : null;
      });
      renderAll();
    },
  });
  const bypass = h('textarea', { oninput: (e) => mutate((data) => {
    data.profiles[key].bypassList = e.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
  }) });
  bypass.value = (profile.bypassList || []).join('\n');
  const authCard = h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('strong', {}, t('field.auth')),
        h('p', { class: 'hint' }, t('field.username') + ' / ' + t('field.password')),
      ),
      authSwitch,
    ),
  );
  if (server.auth) {
    authCard.append(h('div', { class: 'grid-2' },
      field(t('field.username'), h('input', { value: server.auth.username || '', oninput: (e) => mutate((data) => { data.profiles[key].fallbackProxy.auth.username = e.target.value; }) })),
      field(t('field.password'), h('input', { type: 'password', value: server.auth.password || '', oninput: (e) => mutate((data) => { data.profiles[key].fallbackProxy.auth.password = e.target.value; }) })),
    ));
  }
  return [
    h('div', { class: 'card' },
      h('div', { class: 'grid' }, field(t('field.scheme'), scheme), field(t('field.host'), host), field(t('field.port'), port)),
    ),
    authCard,
    h('div', { class: 'card' },
      h('h3', {}, t('field.bypass')),
      h('p', { class: 'hint' }, t('field.bypassHint')),
      bypass,
    ),
  ];
}

function pacCard(key, profile) {
  const url = h('input', { value: profile.pacUrl || '', placeholder: 'https://example.com/proxy.pac', oninput: (e) => mutate((data) => { data.profiles[key].pacUrl = e.target.value; }) });
  const script = h('textarea', { rows: 8, oninput: (e) => mutate((data) => { data.profiles[key].pacScript = e.target.value; }) });
  script.value = profile.pacScript || '';
  return h('div', { class: 'card' },
    h('p', { class: 'hint' }, t('field.pacHint')),
    field(t('field.pacUrl'), url),
    field(t('field.pacScript'), script),
  );
}

function autoCard(key, profile) {
  const targets = () => [
    { name: BUILTIN.DIRECT, label: t('profile.direct') },
    ...Object.values(draft.profiles)
      .filter((p) => p.type === PROFILE_TYPE.FIXED)
      .map((p) => ({ name: p.name, label: p.name })),
  ];
  const kindLabels = {
    [RuleKind.HOST_WILDCARD]: t('rule.hostWildcard'),
    [RuleKind.HOST_REGEX]: t('rule.hostRegex'),
    [RuleKind.URL_WILDCARD]: t('rule.urlWildcard'),
    [RuleKind.URL_REGEX]: t('rule.urlRegex'),
  };
  const rulesBox = h('div', { class: 'rules' },
    h('div', { class: 'rule rule-head' },
      h('span', {}, t('rule.type')), h('span', {}, t('rule.pattern')), h('span', {}, t('rule.target')), h('span', {}),
    ),
  );
  (profile.rules || []).forEach((rule, index) => {
    const currentKind = rule.condition?.type || RuleKind.HOST_WILDCARD;
    const kind = h('select', { onchange: (e) => mutate((data) => { data.profiles[key].rules[index].condition.type = e.target.value; }) },
      ...Object.values(RuleKind).map((k) => h('option', { value: k, selected: k === currentKind }, kindLabels[k])),
    );
    const pattern = h('input', { value: rule.condition?.pattern || '', placeholder: '*.example.com', oninput: (e) => mutate((data) => { data.profiles[key].rules[index].condition.pattern = e.target.value; }) });
    const target = h('select', { onchange: (e) => mutate((data) => { data.profiles[key].rules[index].profileName = e.target.value; }) },
      ...targets().map((item) => h('option', { value: item.name, selected: item.name === rule.profileName }, item.label)));
    rulesBox.append(h('div', { class: 'rule' }, kind, pattern, target,
      h('button', { class: 'btn danger', onclick: () => mutate((data) => { data.profiles[key].rules.splice(index, 1); renderAll(); }) }, '✕')));
  });
  const fallbackSelect = h('select', { onchange: (e) => mutate((data) => { data.profiles[key].defaultProfileName = e.target.value; }) },
    ...targets().map((item) => h('option', { value: item.name, selected: item.name === profile.defaultProfileName }, item.label)));
  return h('div', { class: 'card' },
    rulesBox,
    h('button', { class: 'btn', onclick: () => mutate((data) => {
      data.profiles[key].rules = data.profiles[key].rules || [];
      data.profiles[key].rules.push({ condition: { type: RuleKind.HOST_WILDCARD, pattern: '' }, profileName: BUILTIN.DIRECT });
      renderAll();
    }) }, t('action.addRule')),
    field(t('rule.default'), fallbackSelect),
    h('p', { class: 'hint' }, t('rule.hint')),
  );
}

function renderGeneral() {
  pane().append(h('h1', {}, t('nav.general')));
  const choices = [
    { name: '', label: t('general.keepLast') },
    { name: BUILTIN.DIRECT, label: t('profile.direct') },
    { name: BUILTIN.SYSTEM, label: t('profile.system') },
    ...Object.values(draft.profiles).map((p) => ({ name: p.name, label: p.name })),
  ];
  const startup = h('select', { onchange: (e) => mutate((data) => { data.settings.startupProfile = e.target.value; }) },
    ...choices.map((item) => h('option', { value: item.name, selected: item.name === (draft.settings.startupProfile || '') }, item.label)));
  pane().append(h('div', { class: 'card' },
    h('h3', {}, t('general.startup')),
    h('div', { style: 'max-width:320px' }, field('', startup)),
  ));
}

function renderAppearance() {
  pane().append(h('h1', {}, t('nav.appearance')));
  const theme = draft.settings?.theme || 'dark';
  const lang = draft.settings?.lang || 'zh';
  const seg = (current, values, onPick) => {
    const wrap = h('div', { class: 'seg' });
    for (const value of values) {
      wrap.append(h('button', { class: value.value === current ? 'active' : '', onclick: () => onPick(value.value) }, value.label));
    }
    return wrap;
  };
  pane().append(h('div', { class: 'card' },
    h('h3', {}, t('appearance.theme')),
    seg(theme, [
      { value: 'auto', label: t('theme.auto') },
      { value: 'light', label: t('theme.light') },
      { value: 'dark', label: t('theme.dark') },
    ], (value) => { mutate((data) => { data.settings.theme = value; }); setThemeMode(value); renderAll(); }),
  ));
  pane().append(h('div', { class: 'card' },
    h('h3', {}, t('appearance.language')),
    seg(lang, [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
    ], (value) => { mutate((data) => { data.settings.lang = value; }); renderAll(); }),
  ));
}

function renderBackup() {
  pane().append(h('h1', {}, t('nav.backup')));
  const fileInput = h('input', { type: 'file', accept: '.json', style: 'display:none' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text);
        const options = parsed.options && parsed.options.profiles ? parsed.options : parsed;
        if (!options.profiles) throw new Error('bad format');
        draft = options;
        setThemeMode(draft.settings?.theme);
        toast(t('toast.imported'));
        refreshBar();
        renderAll();
      } catch (error) {
        toast(t('toast.invalid') + ': ' + error.message);
      }
    });
  });
  const stamp = new Date().toISOString().slice(0, 10);
  pane().append(h('div', { class: 'card' },
    h('p', { class: 'hint' }, t('backup.hint')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => {
        const payload = JSON.stringify({ app: 'ProxyPilot', exportedAt: new Date().toISOString(), options: draft }, null, 2);
        const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
        const link = h('a', { href: url, download: 'proxypilot-backup-' + stamp + '.json' });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(t('toast.exported'));
      } }, t('backup.export')),
      h('button', { class: 'btn', onclick: () => fileInput.click() }, t('backup.import')),
      fileInput,
    ),
  ));
}

function renderAll() {
  setThemeMode(draft.settings?.theme);
  document.documentElement.lang = draft.settings?.lang || 'zh';
  t = createTranslator(draft.settings?.lang || 'zh');
  renderNav();
  pane().innerHTML = '';
  if (view.kind === 'profile' && draft.profiles[view.name]) {
    renderProfile(view.name);
  } else if (view.kind === 'general') renderGeneral();
  else if (view.kind === 'appearance') renderAppearance();
  else if (view.kind === 'backup') renderBackup();
  else {
    const first = Object.keys(draft.profiles)[0];
    view = first ? { kind: 'profile', name: first } : { kind: 'general' };
    renderAll();
    return;
  }
  refreshBar();
}

async function init() {
  const response = await api.call({ type: Message.GET_STATE });
  if (!response || !response.ok) {
    pane().innerHTML = '';
    pane().append(h('div', { class: 'card' },
      h('strong', { style: 'color:var(--danger)' }, (response && response.error) || t('status.error')),
      h('button', { class: 'btn', onclick: () => window.location.reload() }, 'Reload'),
    ));
    return;
  }
  committed = response.opts;
  draft = JSON.parse(JSON.stringify(committed));
  onStorageChanged((next) => {
    if (!isDirty() && next) {
      committed = next;
      draft = JSON.parse(JSON.stringify(next));
      renderAll();
    }
  });
  renderAll();
}

init();
