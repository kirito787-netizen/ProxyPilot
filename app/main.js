import { api, h, applyTheme, onStorageChanged, describeProfile, summarizeProfile } from './shared.js';
import { makeT } from './i18n.js';
import { Message } from './model.js';

let state = null;
let t = makeT('zh');

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
      h('button', { class: 'btn', onclick: () => window.location.reload() }, t('action.apply') === '应用' ? '重新加载' : 'Reload'),
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

function render() {
  const options = state.opts;
  const lang = options.settings?.lang || 'zh';
  t = makeT(lang);
  document.documentElement.lang = lang;
  applyTheme(options.settings?.theme);

  const active = describeProfile(options.activeProfile, options, t);
  setStatus(state.proxyError ? 'bad' : 'ok', state.proxyError || '');

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.append(
    h('section', { class: 'current' },
      h('span', { class: 'label' }, t('status.active')),
      h('div', { class: 'current-row' },
        h('span', { class: 'dot', style: 'background:' + active.color }),
        h('strong', { class: 'current-name' }, active.label),
      ),
      h('span', { class: 'summary' }, summarizeProfile(options.activeProfile, options, t)),
    ),
    h('div', { class: 'section-title' }, t('main.profiles')),
  );

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
  content.append(list);

  document.getElementById('foot-left').textContent = 'v' + (api.version || '1.0.0');
  document.getElementById('foot-right').textContent = state.pacUrl || '';
}

document.getElementById('open-settings').addEventListener('click', () => api.openOptions());
document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
  const index = Number(event.key);
  if (index >= 1 && index <= 9 && state) {
    const entries = ['direct', 'system', ...Object.keys(state.opts.profiles)];
    const name = entries[index - 1];
    if (name) switchTo(name);
  }
});
onStorageChanged((next) => {
  if (next && state) { state.opts = next; render(); }
});
refresh();
