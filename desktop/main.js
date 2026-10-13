import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from 'electron';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN, PROFILE_TYPE, SCHEMA_VERSION, STORAGE_KEY, defaultOptions } from '../app/model.js';
import { buildSystemPac } from '../app/pac.js';
import { findVisibleTabHost } from './tabs.js';
app.disableHardwareAcceleration();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.PROXYPILOT_DATA_DIR;
if (dataDir) app.setPath('userData', dataDir);
const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PAC_HOST = '127.0.0.1';
const PAC_PORT = 17777;
let pacPort = PAC_PORT;
let pacUrl = 'http://' + PAC_HOST + ':' + pacPort + '/proxypilot.pac';
const BACKUP_FILE = 'system-proxy-backup.json';

let mainWindow = null;
let optionsWindow = null;
let tray = null;
let pacServer = null;
let currentPac = directPac();
let currentOptions = null;
let isQuitting = false;
let systemProxyBackup = null;
let proxyError = null;

app.setName('ProxyPilot');
app.commandLine.appendSwitch('disable-gpu');
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
else app.on('second-instance', () => showWindow(mainWindow));

const clone = (value) => structuredClone(value);
// Electron IPC uses structured clone. Keep all renderer responses JSON-safe so
// an accidental non-cloneable value cannot break the settings window.
const ipcClone = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value));
const optionsPath = () => path.join(app.getPath('userData'), 'options.json');
const backupPath = () => path.join(app.getPath('userData'), BACKUP_FILE);

async function loadOptions() {
  try {
    const parsed = JSON.parse(await readFile(optionsPath(), 'utf8'));
    const defs = defaultOptions();
    currentOptions = {
      ...parsed,
      schemaVersion: SCHEMA_VERSION,
      settings: { ...defs.settings, ...(parsed.settings || {}) },
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      activeProfile: parsed.activeProfile || BUILTIN.DIRECT,
    };
  } catch (_) {
    currentOptions = defaultOptions();
    await saveOptions(currentOptions, false);
  }
  return clone(currentOptions);
}

async function saveOptions(opts, broadcast = true) {
  const previous = currentOptions;
  currentOptions = clone(opts);
  currentOptions.schemaVersion = SCHEMA_VERSION;
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(optionsPath(), JSON.stringify(currentOptions, null, 2), 'utf8');
  if (broadcast && previous) broadcastStorageChange(previous, currentOptions);
  return clone(currentOptions);
}

function broadcastStorageChange(previous, next) {
  const changes = {};
  changes[STORAGE_KEY] = { oldValue: clone(previous), newValue: clone(next) };
  for (const win of [mainWindow, optionsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('proxypilot:storage-changed', changes, 'local');
  }
}

function registryQuery(name) {
  try {
    const output = execFileSync('reg.exe', ['query', REG_PATH, '/v', name], { encoding: 'utf8', windowsHide: true });
    const line = output.split(/\r?\n/).find((item) => item.trim().startsWith(name + ' '));
    const match = line && line.trim().match(/^\S+\s+(REG_DWORD|REG_SZ)\s+(.+)$/i);
    return match ? { present: true, type: match[1].toUpperCase(), value: match[2].trim() } : { present: false };
  } catch (_) {
    return { present: false };
  }
}

function registrySet(name, type, value) {
  execFileSync('reg.exe', ['add', REG_PATH, '/v', name, '/t', type, '/d', String(value), '/f'], { windowsHide: true, stdio: 'ignore' });
}

function registryDelete(name) {
  try { execFileSync('reg.exe', ['delete', REG_PATH, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
}

function readSystemProxySettings() {
  const names = ['AutoConfigURL', 'AutoDetect', 'ProxyEnable', 'ProxyServer', 'ProxyOverride'];
  return Object.fromEntries(names.map((name) => [name, registryQuery(name)]));
}

function notifyWindowsProxyChange() {
  if (process.platform !== 'win32') return;
  const code = 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public static class WinInetRefresh { [DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr p, int l); }"; [WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null; [WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null';
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
}

function restoreRegistry(settings) {
  for (const [name, item] of Object.entries(settings || {})) {
    if (item && item.present) registrySet(name, item.type, item.value);
    else registryDelete(name);
  }
  notifyWindowsProxyChange();
}

async function ensureProxyBackup() {
  if (systemProxyBackup) return systemProxyBackup;
  try {
    const stored = JSON.parse(await readFile(backupPath(), 'utf8'));
    if (stored.settings) { systemProxyBackup = stored.settings; return systemProxyBackup; }
  } catch (_) {}
  systemProxyBackup = readSystemProxySettings();
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(backupPath(), JSON.stringify({ settings: systemProxyBackup }, null, 2), 'utf8');
  return systemProxyBackup;
}

async function restoreSystemProxy() {
  if (!systemProxyBackup) {
    try { systemProxyBackup = JSON.parse(await readFile(backupPath(), 'utf8')).settings; } catch (_) { systemProxyBackup = null; }
  }
  if (!systemProxyBackup) return;
  restoreRegistry(systemProxyBackup);
  systemProxyBackup = null;
  try { await unlink(backupPath()); } catch (_) {}
}

async function enableSystemPac(url) {
  await ensureProxyBackup();
  registrySet('AutoDetect', 'REG_DWORD', 0);
  registrySet('AutoConfigURL', 'REG_SZ', url);
  registrySet('ProxyEnable', 'REG_DWORD', 0);
  notifyWindowsProxyChange();
  const after = readSystemProxySettings();
  if (after.AutoConfigURL?.value !== url) throw new Error('无法写入 Windows 自动代理脚本设置');
}

async function enableDirectConnection() {
  await ensureProxyBackup();
  registrySet('AutoDetect', 'REG_DWORD', 0);
  registryDelete('AutoConfigURL');
  registrySet('ProxyEnable', 'REG_DWORD', 0);
  notifyWindowsProxyChange();
  const after = readSystemProxySettings();
  if (after.AutoConfigURL?.present || after.ProxyEnable?.value !== '0x0') throw new Error('无法写入 Windows 直连设置');
}

function directPac() { return 'function FindProxyForURL(url, host) { return "DIRECT"; }'; }
function localPacFor(name, opts) {
  return buildSystemPac(name, opts);
}

async function applyProfile(name, opts) {
  const profile = opts.profiles[name];
  let nextPac = directPac();
  if (name === BUILTIN.DIRECT || name === BUILTIN.SYSTEM) {
    if (name === BUILTIN.DIRECT) await enableDirectConnection();
    else await restoreSystemProxy();
  } else {
    if (!profile) throw new Error('未找到情景模式：' + name);
    if (profile.type === PROFILE_TYPE.PAC && profile.pacUrl && profile.pacUrl.trim()) {
      await enableSystemPac(profile.pacUrl.trim());
    } else {
      nextPac = localPacFor(name, opts);
      if (!nextPac) throw new Error('PAC 情景模式没有可用的脚本');
      await enableSystemPac(pacUrl);
    }
  }
  currentPac = nextPac;
  currentOptions = clone(opts);
  proxyError = null;
}

async function switchProfile(name) {
  const previous = clone(currentOptions || await loadOptions());
  const candidate = clone(previous);
  candidate.activeProfile = name;
  await applyProfile(name, candidate);
  try {
    const saved = await saveOptions(candidate);
    buildTrayMenuAndSet();
    return saved;
  } catch (error) {
    try { await applyProfile(previous.activeProfile, previous); } catch (_) {}
    throw error;
  }
}

async function handleMessage(message) {
  const opts = clone(currentOptions || await loadOptions());
  switch (message.type) {
    case 'getState': return { ok: true, opts: opts, levelOfControl: proxyError ? 'not_controllable' : 'controlled_by_this_app', proxyError: proxyError, pacUrl: pacUrl };
    case 'switchProfile': return { ok: true, opts: await switchProfile(message.name) };
    case 'saveOptions': {
      const previous = clone(currentOptions || opts);
      await applyProfile(message.opts.activeProfile, message.opts);
      try {
        const saved = await saveOptions(message.opts);
        return { ok: true, opts: saved };
      } catch (error) {
        try { await applyProfile(previous.activeProfile, previous); } catch (_) {}
        throw error;
      }
    }
    case 'applyActive': await applyProfile(opts.activeProfile, opts); return { ok: true };
    case 'getLevelOfControl': return { ok: true, levelOfControl: proxyError ? 'not_controllable' : 'controlled_by_this_app' };
    case 'findTabHost': return { ok: true, host: await findVisibleTabHost() };
    case 'addQuickRule': {
      const auto = opts.profiles[message.autoProfileName];
      if (!auto || auto.type !== PROFILE_TYPE.AUTO) return { ok: false, error: '目标不是自动切换情景' };
      auto.rules = auto.rules || [];
      auto.rules.unshift({ condition: { type: message.conditionType || 'HostWildcard', pattern: message.pattern }, profileName: message.targetProfileName });
      if (opts.activeProfile === message.autoProfileName) await applyProfile(opts.activeProfile, opts);
      const saved = await saveOptions(opts);
      return { ok: true, opts: saved };
    }
    default: return { ok: false, error: '未知消息类型：' + message.type };
  }
}

function createWindow(options) {
  const win = new BrowserWindow({
    width: options.width, height: options.height, minWidth: options.minWidth, minHeight: options.minHeight,
    show: false, autoHideMenuBar: true, backgroundColor: '#0b0f14',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (win === mainWindow) mainWindow = null;
    if (win === optionsWindow) optionsWindow = null;
  });
  return win;
}

function showWindow(win) { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function openOptionsWindow() {
  if (optionsWindow && !optionsWindow.isDestroyed()) { showWindow(optionsWindow); return; }
  optionsWindow = createWindow({ width: 1040, height: 760, minWidth: 820, minHeight: 600 });
  optionsWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('ProxyPilot options failed to load:', errorCode, errorDescription, validatedURL);
  });
  optionsWindow.loadFile(path.join(__dirname, '..', 'app', 'settings.html'))
    .catch((error) => console.error('ProxyPilot options load failed:', error));
  optionsWindow.show();
  optionsWindow.focus();
}

function buildTrayMenu() {
  const profiles = currentOptions ? [
    { label: '直接连接', name: BUILTIN.DIRECT }, { label: '系统代理', name: BUILTIN.SYSTEM },
    ...Object.entries(currentOptions.profiles).map(([name, profile]) => ({ label: profile.name || name, name: name })),
  ] : [];
  return Menu.buildFromTemplate([
    { label: '打开 ProxyPilot', click: () => showWindow(mainWindow) }, { type: 'separator' },
    ...profiles.map((profile) => ({ label: profile.label, type: 'radio', checked: currentOptions && currentOptions.activeProfile === profile.name, click: async () => { try { await switchProfile(profile.name); } catch (error) { console.error(error); } } })),
    { type: 'separator' }, { label: '退出', click: () => app.quit() },
  ]);
}
function buildTrayMenuAndSet() { if (tray) tray.setContextMenu(buildTrayMenu()); }

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'icons', 'icon32.png');
    const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('ProxyPilot');
    tray.setContextMenu(buildTrayMenu());
    tray.on('double-click', () => showWindow(mainWindow));
  } catch (error) {
    tray = null;
  }
}

function startPacServer() {
  return new Promise((resolve, reject) => {
    const listen = (port, canFallback) => {
      pacServer = createServer((request, response) => {
        if ((request.url || '').split('?')[0] === '/proxypilot.pac') {
          response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
          response.end(currentPac); return;
        }
        response.writeHead(404); response.end('Not found');
      });
      pacServer.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && canFallback) {
          pacServer.close();
          listen(0, false);
          return;
        }
        if (error.code === 'EADDRINUSE' && !canFallback) {
          pacServer.close();
          listen(0, false);
          return;
        }
        reject(error);
      });
      pacServer.listen(port, PAC_HOST, () => {
        const address = pacServer.address();
        pacPort = address.port;
        pacUrl = 'http://' + PAC_HOST + ':' + pacPort + '/proxypilot.pac';
        resolve(address);
      });
    };
    listen(PAC_PORT, true);
  });
}

ipcMain.handle('proxypilot:storage-get', async (_event, key) => ({ [typeof key === 'string' ? key : STORAGE_KEY]: ipcClone(currentOptions || await loadOptions()) }));
ipcMain.handle('proxypilot:storage-set', async (_event, value) => { const next = value && value[STORAGE_KEY]; if (next) await saveOptions(next); return true; });
ipcMain.handle('proxypilot:message', async (_event, message) => {
  try { return ipcClone(await handleMessage(message)); }
  catch (error) {
    proxyError = String(error && (error.message || error));
    return { ok: false, error: proxyError, opts: ipcClone(currentOptions || await loadOptions()) };
  }
});
ipcMain.on('proxypilot:open-options', () => openOptionsWindow());
ipcMain.on('proxypilot:open-main', () => showWindow(mainWindow));

if (isPrimaryInstance) app.whenReady().then(async () => {
  await loadOptions();
  await startPacServer();
  mainWindow = createWindow({ width: 430, height: 680, minWidth: 380, minHeight: 540 });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('ProxyPilot renderer failed to load:', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('ProxyPilot renderer exited:', details.reason, details.exitCode);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error('ProxyPilot renderer:', message, sourceId + ':' + line);
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'app', 'main.html'));
  mainWindow.on('close', (event) => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } });
  createTray();
  try { await applyProfile(currentOptions.activeProfile, currentOptions); buildTrayMenuAndSet(); }
  catch (error) {
    proxyError = String(error && (error.message || error));
    console.error('Failed to apply startup profile:', error);
    try { await restoreSystemProxy(); } catch (restoreError) { console.error('Failed to restore system proxy:', restoreError); }
  }
}).catch((error) => console.error('ProxyPilot startup failed:', error));

if (isPrimaryInstance) app.on('before-quit', (event) => {
  if (isQuitting) return; event.preventDefault(); isQuitting = true;
  restoreSystemProxy().catch((error) => console.error('Failed to restore system proxy:', error)).finally(() => { if (pacServer) pacServer.close(); if (tray) tray.destroy(); app.quit(); });
});
