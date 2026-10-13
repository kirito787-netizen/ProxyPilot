import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createPackage, listPackage, extractFile } from '@electron/asar';

const root = process.cwd();
const stage = path.join(root, '.pack-verify');
const asarTemp = path.join(root, 'dist', 'verify.asar');
const exe = path.join(root, 'dist', 'ProxyPilot', 'ProxyPilot.exe');
const archive = path.join(root, 'dist', 'ProxyPilot', 'resources', 'app.asar');
const dataDir = path.join(root, '.settings-cdp-test');
const port = 9333;

const kill = () => { try { execFileSync('taskkill', ['/F', '/IM', 'ProxyPilot.exe', '/T'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

kill();
await sleep(800);

fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(asarTemp, { force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const name of ['desktop', 'src', 'icons', 'package.json']) {
  fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true, force: true });
}
await createPackage(stage, asarTemp);
fs.copyFileSync(asarTemp, archive);
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(asarTemp, { force: true });

const list = listPackage(archive);
const preload = extractFile(archive, 'desktop\\preload.cjs').toString();
const main = extractFile(archive, 'desktop\\main.js').toString();
console.log(JSON.stringify({
  archive: fs.statSync(archive).size,
  entries: list.length,
  bridge: preload.includes("exposeInMainWorld('proxypilot'"),
  safeMessage: preload.includes('sendMessage: async'),
  oneWayOptions: main.includes("ipcMain.on('proxypilot:open-options'"),
  ipcCloneAll: main.includes('return ipcClone(await handleMessage(message))'),
}));

const child = spawn(exe, ['--remote-debugging-port=' + port], {
  cwd: path.dirname(exe),
  env: { ...process.env, PROXYPILOT_DATA_DIR: dataDir },
  windowsHide: true,
  stdio: 'ignore',
});

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      if (response.ok) return await response.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('DevTools endpoint unreachable');
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('CDP timeout')); }, 8000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result?.result?.value);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket failed')); });
  });
}

try {
  const pages = await targets();
  const popup = pages.find((item) => (item.url || '').includes('popup.html'));
  if (!popup) throw new Error('main window not found: ' + JSON.stringify(pages.map((item) => item.url)));
  const bridgeProbe = await evaluate(popup.webSocketDebuggerUrl, "window.proxypilot ? 'bridge-ok' : 'bridge-missing'");
  await evaluate(popup.webSocketDebuggerUrl, "window.proxypilot.runtime.openOptionsPage(); 'sent'");
  let options = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const current = await targets();
    options = current.find((item) => (item.url || '').includes('options.html'));
    if (options) break;
  }
  if (!options) throw new Error('options window did not open');
  await sleep(1200);
  const bodyText = await evaluate(options.webSocketDebuggerUrl, 'document.body.innerText');
  const viewText = await evaluate(options.webSocketDebuggerUrl, "document.getElementById('view') ? document.getElementById('view').innerText : 'NO_VIEW'");
  console.log(JSON.stringify({
    bridgeProbe,
    optionsOpened: true,
    optionsTitle: await evaluate(options.webSocketDebuggerUrl, 'document.title'),
    cloneError: String(bodyText).includes('could not be cloned'),
    bootError: String(bodyText).includes('启动失败'),
    viewSnippet: String(viewText).replace(/\s+/g, ' ').slice(0, 300),
  }, null, 2));
} finally {
  kill();
  child.kill();
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
