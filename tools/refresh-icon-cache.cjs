// Clear the Windows icon cache and restart the shell so the new embedded
// application icon shows up in Explorer and the taskbar.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tryKill = (image) => { try { execFileSync('taskkill', ['/F', '/IM', image, '/T'], { stdio: 'ignore', windowsHide: true }); } catch (_) {} };

tryKill('ProxyPilot.exe');
wait(800);
tryKill('explorer.exe');
wait(1200);

const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const explorerDir = path.join(local, 'Microsoft', 'Windows', 'Explorer');
let removed = 0;
try {
  for (const file of fs.readdirSync(explorerDir)) {
    if (/^iconcache_.*\.db$/i.test(file)) {
      try { fs.rmSync(path.join(explorerDir, file), { force: true }); removed++; } catch (_) {}
    }
  }
  fs.rmSync(path.join(local, 'IconCache.db'), { force: true });
  removed++;
} catch (_) {}

spawn(path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe'), [], { detached: true, stdio: 'ignore' }).unref();
wait(2500);
const exe = path.resolve('dist', 'ProxyPilot', 'ProxyPilot.exe');
spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
console.log('icon cache cleared (' + removed + ' files), explorer and ProxyPilot restarted');
