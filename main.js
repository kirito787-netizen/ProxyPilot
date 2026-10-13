import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from 'electron';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN, PROFILE_TYPE, SCHEMA_VERSION, STORAGE_KEY, defaultOptions } from '../src/common/constants.js';
import { buildSystemPac } from '../src/common/proxy.js';
app.disableHardwareAcceleration();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.PROXYPILOT_DATA_DIR;
if (dataDir) app.setPath('userData', dataDir);
const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PAC_HOST = '127.0.0.1';
const PAC_PORT = 17777;
const PAC_URL = 'http://' + PAC_HOST + ':' + PAC_PORT + '/proxypilot.pac';
const BACKUP_FILE = 'system-proxy-backup.json';

let mainWindow = null;
let optionsWindow = null;
let tray = null;
let pacServer = null;
let currentPac = directPac();
let currentOptions = null;
let isQuitting = false;
let systemProxyBackup = null;

app.setName('ProxyPilot');
app.commandLine.appendSwitch('disable-gpu');
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => showWindow(mainWindow));

const clone = (value) => structuredClone(value);
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
  currentOptions = opts;
  const profile = opts.profiles[name];
  if (name === BUILTIN.DIRECT || name === BUILTIN.SYSTEM) {
    currentPac = directPac();
    if (name === BUILTIN.DIRECT) await enableDirectConnection();
    else await restoreSystemProxy();
    return;
  }
  if (!profile) throw new Error('未找到情景模式：' + name);
  if (profile.type === PROFILE_TYPE.PAC && profile.pacUrl && profile.pacUrl.trim()) {
    await enableSystemPac(profile.pacUrl.trim());
    return;
  }
  const pac = localPacFor(name, opts);
  if (!pac) throw new Error('PAC 情景模式没有可用的脚本');
  currentPac = pac;
  await enableSystemPac(PAC_URL);
}

async function switchProfile(name) {
  const opts = clone(currentOptions || await loadOptions());
  opts.activeProfile = name;
  const saved = await saveOptions(opts);
  await applyProfile(name, saved);
  buildTrayMenuAndSet();
  return saved;
}

async function handleMessage(message) {
  const opts = clone(currentOptions || await loadOptions());
  switch (message.type) {
    case 'getState': return { ok: true, opts: opts, levelOfControl: 'controlled_by_this_app' };
    case 'switchProfile': return { ok: true, opts: await switchProfile(message.name) };
    case 'saveOptions': {
      const saved = await saveOptions(message.opts);
      await applyProfile(saved.activeProfile, saved);
      return { ok: true, opts: saved };
    }
    case 'applyActive': await applyProfile(opts.activeProfile, opts); return { ok: true };
    case 'getLevelOfControl': return { ok: true, levelOfControl: 'controlled_by_this_app' };
    case 'addQuickRule': {
      const auto = opts.profiles[message.autoProfileName];
      if (!auto || auto.type !== PROFILE_TYPE.AUTO) return { ok: false, error: '目标不是自动切换情景' };
      auto.rules = auto.rules || [];
      auto.rules.unshift({ condition: { type: message.conditionType || 'HostWildcard', pattern: message.pattern }, profileName: message.targetProfileName });
      const saved = await saveOptions(opts);
      if (saved.activeProfile === message.autoProfileName) await applyProfile(saved.activeProfile, saved);
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
  win.on('closed', () => { if (win === mainWindow) mainWindow = null; if (win === optionsWindow) optionsWindow = null; });
  return win;
}

function showWindow(win) { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function openOptionsWindow() {
  if (optionsWindow && !optionsWindow.isDestroyed()) { showWindow(optionsWindow); return; }
  optionsWindow = createWindow({ width: 1040, height: 760, minWidth: 820, minHeight: 600 });
  optionsWindow.loadFile(path.join(__dirname, '..', 'src', 'options', 'options.html'));
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
  const iconPath = path.join(__dirname, '..', 'icons', 'icon32.png');
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon); tray.setToolTip('ProxyPilot'); tray.setContextMenu(buildTrayMenu()); tray.on('double-click', () => showWindow(mainWindow));
}

function startPacServer() {
  pacServer = createServer((request, response) => {
    if ((request.url || '').split('?')[0] === '/proxypilot.pac') {
      response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      response.end(currentPac); return;
    }
    response.writeHead(404); response.end('Not found');
  });
  pacServer.listen(PAC_PORT, PAC_HOST);
}

ipcMain.handle('proxypilot:storage-get', async (_event, key) => ({ [typeof key === 'string' ? key : STORAGE_KEY]: clone(currentOptions || await loadOptions()) }));
ipcMain.handle('proxypilot:storage-set', async (_event, value) => { const next = value && value[STORAGE_KEY]; if (next) await saveOptions(next); });
ipcMain.handle('proxypilot:message', async (_event, message) => { try { return await handleMessage(message); } catch (error) { return { ok: false, error: String(error && (error.message || error)) }; } });
ipcMain.handle('proxypilot:open-options', () => openOptionsWindow());

app.whenReady().then(async () => {
  await loadOptions(); startPacServer();
  mainWindow = createWindow({ width: 430, height: 680, minWidth: 380, minHeight: 540 });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'popup', 'popup.html'));
  mainWindow.on('close', (event) => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } });
  createTray();
  try { await applyProfile(currentOptions.activeProfile, currentOptions); buildTrayMenuAndSet(); }
  catch (error) {
    console.error('Failed to apply startup profile:', error);
    try { await restoreSystemProxy(); } catch (restoreError) { console.error('Failed to restore system proxy:', restoreError); }
  }
});

app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (isQuitting) return; event.preventDefault(); isQuitting = true;
  restoreSystemProxy().catch((error) => console.error('Failed to restore system proxy:', error)).finally(() => { if (pacServer) pacServer.close(); if (tray) tray.destroy(); app.quit(); });
});
