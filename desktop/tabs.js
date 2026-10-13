// Detect the visible browser tab through a local Chrome/Edge DevTools
// endpoint (the browser must run with --remote-debugging-port). Probes are
// read-only: the HTTP target list plus a visibility check per page. When no
// endpoint answers, detection quietly returns null and the UI falls back to
// the manual host input.

const PROBE_PORTS = [9222, 9223];
const VISIBILITY_SNIPPET = 'JSON.stringify({ host: location.hostname, vis: document.visibilityState, focus: document.hasFocus() })';

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function evaluateOnPage(wsUrl, timeoutMs) {
  if (typeof WebSocket === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let socket = null;
    const finish = (value) => {
      clearTimeout(timer);
      try { if (socket) socket.close(); } catch (_) { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      socket = new WebSocket(wsUrl);
    } catch (_) {
      finish(null);
      return;
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: VISIBILITY_SNIPPET, returnByValue: true } }));
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) {
          const payload = message.result?.result?.value;
          finish(payload ? JSON.parse(payload) : null);
        }
      } catch (_) {
        finish(null);
      }
    });
    socket.addEventListener('error', () => finish(null));
  });
}

export async function findVisibleTabHost() {
  for (const port of PROBE_PORTS) {
    const targets = await fetchJson('http://127.0.0.1:' + port + '/json/list', 700);
    if (!Array.isArray(targets)) continue;
    const pages = targets
      .filter((target) => target.type === 'page' && /^https?:/i.test(target.url || '') && target.webSocketDebuggerUrl)
      .slice(0, 12);
    const states = (await Promise.all(pages.map((page) => evaluateOnPage(page.webSocketDebuggerUrl, 1200)))).filter(Boolean);
    const focused = states.find((state) => state.focus && state.vis === 'visible' && state.host);
    const visible = states.find((state) => state.vis === 'visible' && state.host);
    const host = (focused || visible || {}).host;
    if (host) return String(host).toLowerCase();
  }
  return null;
}
