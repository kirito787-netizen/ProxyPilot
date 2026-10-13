// Diagnostic: does an ALREADY-RUNNING Chrome pick up a system PAC (AutoConfigURL) change?
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const pacPort = 17891, originPort = 17892, proxyPort = 17893, cdpPort = 17894;
const regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const watched = ['AutoConfigURL', 'AutoDetect', 'ProxyEnable', 'ProxyServer', 'ProxyOverride'];
const backup = new Map();
let directHits = 0, proxyHits = 0;

const q = (name) => { try { const out = execFileSync('reg.exe', ['query', regPath, '/v', name], { encoding: 'utf8', windowsHide: true }); const m = out.match(new RegExp('\\s' + name + '\\s+(REG_DWORD|REG_SZ)\\s+(.+)$', 'mi')); return m ? { present: true, type: m[1].toUpperCase(), value: m[2].trim() } : { present: false }; } catch (_) { return { present: false }; } };
const setR = (name, type, value) => execFileSync('reg.exe', ['add', regPath, '/v', name, '/t', type, '/d', String(value), '/f'], { windowsHide: true, stdio: 'ignore' });
const delR = (name) => { try { execFileSync('reg.exe', ['delete', regPath, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} };
const refreshWinInet = () => { const code = 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public static class R { [DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr p, int l); }"; [R]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null; [R]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null'; try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} };

const pacBody = (proxyPort_) => 'function FindProxyForURL(url, host) { host = host.toLowerCase(); if (host === "proxy-test.local" || host.endsWith(".proxy-test.local")) return "PROXY 127.0.0.1:' + proxyPort_ + '"; return "DIRECT"; }';
const listen = (server, port) => new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const origin = createServer((_req, res) => { directHits++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('DIRECT_ORIGIN'); });
const proxy = createServer((_req, res) => { proxyHits++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('PROXY_ORIGIN'); });
let pacMode = 'direct';
const pac = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' }); res.end(pacMode === 'proxy' ? pacBody(proxyPort) : 'function FindProxyForURL(url, host) { return "DIRECT"; }'); });

async function pageWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('no CDP page');
}

async function navAndBody(ws, url) {
  let id = 0; const pending = new Map(); let events = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Page.enable');
  await send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const ev0 = events; events = [];
    if (ev0.some((e) => e.method === 'Page.loadEventFired')) break;
    const r = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
    const value = r.result?.result?.value;
    if (value === 'DIRECT_ORIGIN' || value === 'PROXY_ORIGIN') return value;
    if (r.result?.exceptionDetails) break;
  }
  const r = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
  return r.result?.result?.value || 'UNKNOWN';
}

try {
  for (const name of watched) backup.set(name, q(name));
  await Promise.all([listen(origin, originPort), listen(proxy, proxyPort), listen(pac, pacPort)]);
  setR('AutoDetect', 'REG_DWORD', 0);
  setR('AutoConfigURL', 'REG_SZ', 'http://127.0.0.1:' + pacPort + '/proxypilot.pac');
  setR('ProxyEnable', 'REG_DWORD', 0);
  refreshWinInet();

  const profile = await mkdtemp(path.join(tmpdir(), 'proxypilot-running-'));
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + cdpPort, '--host-resolver-rules=MAP proxy-test.local 127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true });
  const ws = new WebSocket(await pageWsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const before = await navAndBody(ws, 'http://proxy-test.local:' + originPort + '/');
  console.log('[1] before PAC flip (PAC=all DIRECT):', before, '(directHits=' + directHits + ', proxyHits=' + proxyHits + ')');

  pacMode = 'proxy';
  setR('AutoConfigURL', 'REG_SZ', 'http://127.0.0.1:' + pacPort + '/proxypilot.pac?v=2');
  refreshWinInet();
  const started = Date.now();
  let after = 'TIMEOUT';
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    after = await navAndBody(ws, 'http://proxy-test.local:' + originPort + '/?t=' + i);
    if (after === 'PROXY_ORIGIN') { console.log('[2] running Chrome picked up PAC change after ' + Math.round((Date.now() - started) / 1000) + 's'); break; }
    if (i === 4) console.log('[2] still DIRECT after ' + Math.round((Date.now() - started) / 1000) + 's...');
  }
  console.log('[2] after PAC flip (PAC=proxy):', after, '(directHits=' + directHits + ', proxyHits=' + proxyHits + ')');
  console.log(after === 'PROXY_ORIGIN' ? 'RESULT: running Chrome DOES refresh system PAC' : 'RESULT: running Chrome does NOT refresh system PAC (root cause confirmed)');
  ws.close();
  child.kill();
  await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  await rm(profile, { recursive: true, force: true });
} finally {
  origin.close(); proxy.close(); pac.close();
  for (const name of watched) { const item = backup.get(name); if (item && item.present) setR(name, item.type, item.value); else delR(name); }
  refreshWinInet();
}
