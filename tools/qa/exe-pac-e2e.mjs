import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const exe = path.join(root, 'dist', 'ProxyPilot', 'ProxyPilot.exe');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dataDir = await mkdtemp(path.join(tmpdir(), 'proxypilot-exe-'));
const logPath = path.join(tmpdir(), 'proxypilot-exe-e2e.log');
const pacPort = 17777;
const originPort = 17889;
const proxyPort = 17890;
const regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const registryNames = ['AutoConfigURL', 'AutoDetect', 'ProxyEnable', 'ProxyServer', 'ProxyOverride'];
const oldRegistry = new Map();
let appProcess = null;
let originHits = 0;
let proxyHits = 0;

function queryRegistry(name) {
  try { const output = execFileSync('reg.exe', ['query', regPath, '/v', name], { encoding: 'utf8', windowsHide: true });
    const line = output.split(/\r?\n/).find((item) => item.trim().startsWith(name + ' '));
    const match = line && line.trim().match(/^\S+\s+(REG_DWORD|REG_SZ)\s+(.+)$/i);
    return match ? { present: true, type: match[1].toUpperCase(), value: match[2].trim() } : { present: false };
  } catch (_) { return { present: false }; }
}
function setRegistry(name, type, value) { execFileSync('reg.exe', ['add', regPath, '/v', name, '/t', type, '/d', String(value), '/f'], { windowsHide: true, stdio: 'ignore' }); }
function deleteRegistry(name) { try { execFileSync('reg.exe', ['delete', regPath, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
function restoreRegistry() { for (const name of registryNames) { const item = oldRegistry.get(name); if (item && item.present) setRegistry(name, item.type, item.value); else deleteRegistry(name); } }

function listen(server, port) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
function waitFor(check, timeout = 10000) { return new Promise((resolve, reject) => { const started = Date.now(); const timer = setInterval(async () => { try { const value = await check(); if (value) { clearInterval(timer); resolve(value); } else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('Timed out waiting for ProxyPilot')); } } catch (error) { if (Date.now() - started > timeout) { clearInterval(timer); reject(error); } } }, 100); }); }

async function chromeDom(url) {
  return new Promise((resolve, reject) => {
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--proxy-pac-url=http://127.0.0.1:' + pacPort + '/proxypilot.pac', '--host-resolver-rules=MAP proxy-test.local 127.0.0.1,MAP direct-test.local 127.0.0.1', '--user-data-dir=' + dataDir + '-chrome', '--dump-dom', url];
    const child = spawn(chrome, args, { windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(out) : reject(new Error(err || 'Chrome exited with ' + code)));
  });
}

const origin = createServer((_req, res) => { originHits += 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('DIRECT_ORIGIN'); });
const proxy = createServer((_req, res) => { proxyHits += 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('PROXY_ORIGIN'); });

try {
  try { execFileSync('taskkill', ['/F', '/IM', 'ProxyPilot.exe', '/T'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const name of registryNames) oldRegistry.set(name, queryRegistry(name));
  await Promise.all([listen(origin, originPort), listen(proxy, proxyPort)]);
  const options = { schemaVersion: 1, activeProfile: '自动切换', settings: { theme: 'dark', lang: 'zh', showQuickSwitch: true, refreshTabOnChange: false, startupProfile: '' }, profiles: {
    '代理服务器': { name: '代理服务器', type: 'fixed', color: '#4F8CFF', fallbackProxy: { scheme: 'http', host: '127.0.0.1', port: proxyPort, auth: null }, bypassList: ['127.0.0.1', '::1', 'localhost', '<local>'] },
    '自动切换': { name: '自动切换', type: 'auto', color: '#22C55E', defaultProfileName: 'direct', rules: [{ condition: { type: 'HostWildcard', pattern: 'proxy-test.local' }, profileName: '代理服务器' }] },
  } };
  await writeFile(path.join(dataDir, 'options.json'), JSON.stringify(options, null, 2));
  appProcess = spawn(exe, ['--enable-logging', '--log-file=' + logPath], { env: { ...process.env, PROXYPILOT_DATA_DIR: dataDir }, windowsHide: true });
  const pac = await waitFor(async () => {
    try {
      const response = await fetch('http://127.0.0.1:' + pacPort + '/proxypilot.pac');
      if (!response.ok) return false;
      const text = await response.text();
      return text.includes('PROXY 127.0.0.1:' + proxyPort) ? text : false;
    } catch (_) { return false; }
  });
  assert.match(pac, /PROXY 127\.0\.0\.1:17890/);
  await waitFor(() => queryRegistry('AutoConfigURL').value === 'http://127.0.0.1:17777/proxypilot.pac');
  const direct = await chromeDom('http://direct-test.local:' + originPort + '/');
  const routed = await chromeDom('http://proxy-test.local:' + originPort + '/');
  assert.match(direct, /DIRECT_ORIGIN/); assert.match(routed, /PROXY_ORIGIN/);
  assert.ok(originHits >= 1); assert.ok(proxyHits >= 1);
  console.log('ProxyPilot EXE E2E passed: system PAC installed, Chrome direct bypass and proxy routing verified');
} finally {
  origin.close(); proxy.close();
  if (appProcess && appProcess.pid) { try { execFileSync('taskkill', ['/PID', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
  try { restoreRegistry(); } catch (error) { console.error('Registry restore failed:', error.message); process.exitCode = 1; }
  await rm(dataDir, { recursive: true, force: true });
}
