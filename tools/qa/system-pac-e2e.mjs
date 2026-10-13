import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Regression test for the REAL user path: Chrome (no proxy flags) reads the
// Windows system proxy (AutoConfigURL -> local PAC). The existing tests pass
// --proxy-pac-url explicitly, which bypasses the system proxy path entirely.

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const pacPort = 17881;
const originPort = 17882;
const proxyPort = 17883;
const regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const watched = ['AutoConfigURL', 'AutoDetect', 'ProxyEnable', 'ProxyServer', 'ProxyOverride'];
const backup = new Map();

function queryRegistry(name) {
  try {
    const output = execFileSync('reg.exe', ['query', regPath, '/v', name], { encoding: 'utf8', windowsHide: true });
    const line = output.split(/\r?\n/).find((item) => item.trim().startsWith(name + ' '));
    const match = line && line.trim().match(/^\S+\s+(REG_DWORD|REG_SZ)\s+(.+)$/i);
    return match ? { present: true, type: match[1].toUpperCase(), value: match[2].trim() } : { present: false };
  } catch (_) { return { present: false }; }
}
function setRegistry(name, type, value) { execFileSync('reg.exe', ['add', regPath, '/v', name, '/t', type, '/d', String(value), '/f'], { windowsHide: true, stdio: 'ignore' }); }
function deleteRegistry(name) { try { execFileSync('reg.exe', ['delete', regPath, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
function refreshWinInet() {
  const code = 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public static class R { [DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr p, int l); }"; [R]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null; [R]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null';
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
}
function restoreRegistry() {
  for (const name of watched) {
    const item = backup.get(name);
    if (item && item.present) setRegistry(name, item.type, item.value);
    else deleteRegistry(name);
  }
  refreshWinInet();
}

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
let directHits = 0;
let proxyHits = 0;
let pacHits = 0;

const origin = createServer((_req, res) => { directHits += 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('DIRECT_ORIGIN'); });
const proxy = createServer((_req, res) => { proxyHits += 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('PROXY_ORIGIN'); });
const pac = createServer((_req, res) => {
  pacHits += 1;
  res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-store' });
  res.end([
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    '  if (shExpMatch(host, "*.proxy-test.local") || shExpMatch(host, "proxy-test.local")) return "PROXY 127.0.0.1:' + proxyPort + '";',
    '  return "DIRECT";',
    '}',
  ].join('\n'));
});

async function chromeDom(url, userDataDir) {
  return new Promise((resolve, reject) => {
    // No proxy flags on purpose: Chrome must use the Windows system proxy.
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP proxy-test.local 127.0.0.1,MAP direct-test.local 127.0.0.1', '--user-data-dir=' + userDataDir, '--dump-dom', url];
    const child = spawn(chrome, args, { windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(out) : reject(new Error(err || 'Chrome exited with ' + code)));
  });
}

try {
  for (const name of watched) backup.set(name, queryRegistry(name));
  await Promise.all([listen(origin, originPort), listen(proxy, proxyPort), listen(pac, pacPort)]);
  setRegistry('AutoDetect', 'REG_DWORD', 0);
  setRegistry('AutoConfigURL', 'REG_SZ', 'http://127.0.0.1:' + pacPort + '/proxypilot.pac');
  setRegistry('ProxyEnable', 'REG_DWORD', 0);
  refreshWinInet();
  // Prewarm the PAC URL so Chrome never races a cold server on first fetch.
  const warm = await fetch('http://127.0.0.1:' + pacPort + '/proxypilot.pac');
  assert.equal(warm.status, 200, 'PAC endpoint serves after registry flip');
  const tempProfile = await mkdtemp(path.join(tmpdir(), 'proxypilot-syspac-'));
  const direct = await chromeDom('http://direct-test.local:' + originPort + '/', tempProfile);
  // A fresh Chrome may occasionally finish before its PAC fetch settles and
  // resolve the first navigation DIRECT; each retry is a brand-new process
  // with no proxy cache, and a real system-path regression fails all tries.
  let routed = '';
  for (let attempt = 0; attempt < 3 && !routed.includes('PROXY_ORIGIN'); attempt++) {
    routed = await chromeDom('http://proxy-test.local:' + originPort + '/', tempProfile);
  }
  await rm(tempProfile, { recursive: true, force: true });
  assert.match(direct, /DIRECT_ORIGIN/);
  assert.match(routed, /PROXY_ORIGIN/);
  assert.ok(pacHits >= 1, 'Chrome fetched the system PAC at least once (pacHits=' + pacHits + ')');
  assert.ok(directHits >= 1 && proxyHits >= 1, 'origin hit counts: direct=' + directHits + ' proxy=' + proxyHits);
  console.log('System PAC + Chrome (no proxy flags) passed: specified domain routed via proxy, others direct');
} finally {
  origin.close(); proxy.close(); pac.close();
  try { restoreRegistry(); } catch (error) { console.error('Registry restore failed:', error.message); process.exitCode = 1; }
}
