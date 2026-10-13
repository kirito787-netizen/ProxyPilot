import fs from 'node:fs';
import path from 'node:path';
import { createPackage } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = process.cwd();
const stage = path.join(root, '.pack-slim');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'dist', 'ProxyPilot');

// GPU/ANGLE/Vulkan DLLs: unused because hardware acceleration is disabled.
const removeRoot = new Set([
  'dxcompiler.dll', 'dxil.dll', 'd3dcompiler_47.dll',
  'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
  'libEGL.dll', 'libGLESv2.dll',
]);
// Keep only the display languages the app actually offers.
const keepLocales = new Set(['zh-CN.pak', 'en-US.pak']);
// The 14.5 MB bundled third-party license catalog. Flip to true before
// distributing publicly if you want to ship the full catalog.
const includeLicenses = false;

try { execFileSync('taskkill', ['/F', '/IM', 'ProxyPilot.exe', '/T'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
await new Promise((resolve) => setTimeout(resolve, 800));

// 1) Pack current source.
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const name of ['desktop', 'app', 'icons', 'package.json']) {
  fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true, force: true });
}
const tempAsar = path.join(root, 'dist', '.slim.asar');
fs.rmSync(tempAsar, { force: true });
await createPackage(stage, tempAsar);

// 2) Assemble the runtime, trimmed.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const ent of fs.readdirSync(electronDist, { withFileTypes: true })) {
  if (ent.name === 'resources' || ent.name === 'locales' || removeRoot.has(ent.name)) continue;
  if (!includeLicenses && ent.name === 'LICENSES.chromium.html') continue;
  if (ent.name === 'electron.exe') {
    fs.copyFileSync(path.join(electronDist, ent.name), path.join(outDir, 'ProxyPilot.exe'));
    continue;
  }
  fs.cpSync(path.join(electronDist, ent.name), path.join(outDir, ent.name), { recursive: true, force: true });
}
fs.mkdirSync(path.join(outDir, 'locales'), { recursive: true });
for (const file of fs.readdirSync(path.join(electronDist, 'locales'))) {
  if (keepLocales.has(file)) {
    fs.copyFileSync(path.join(electronDist, 'locales', file), path.join(outDir, 'locales', file));
  }
}
const resDir = path.join(outDir, 'resources');
fs.mkdirSync(resDir, { recursive: true });
fs.copyFileSync(tempAsar, path.join(resDir, 'app.asar'));
// Portable marker: main.js keeps app data in .\data next to the exe when
// this file exists. Delete it to fall back to the per-user AppData location.
fs.writeFileSync(path.join(outDir, 'portable.marker'), 'ProxyPilot portable build - app data lives in the data folder next to ProxyPilot.exe\n', 'utf8');
fs.rmSync(tempAsar, { force: true });
fs.rmSync(stage, { recursive: true, force: true });

// Embed the application icon into the executable.
try {
  const require = createRequire(import.meta.url);
  const rceditModule = require('rcedit');
  const rcedit = rceditModule.rcedit || rceditModule.default || rceditModule;
  await rcedit(path.join(outDir, 'ProxyPilot.exe'), { icon: path.join(root, 'icons', 'proxypilot.ico') });
  console.log('icon embedded');
} catch (error) {
  console.warn('icon embed skipped: ' + (error && error.message));
}

let total = 0;
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else total += fs.statSync(full).size;
  }
};
walk(outDir);
console.log(JSON.stringify({
  out: path.relative(root, outDir),
  sizeMB: +(total / 1048576).toFixed(1),
  locales: fs.readdirSync(path.join(outDir, 'locales')).length,
}));
