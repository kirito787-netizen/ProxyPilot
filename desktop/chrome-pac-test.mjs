import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { initialOptions } from '../app/model.js';
import { generateAutoPac } from '../app/pac.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const pacPort = 17878;
const originPort = 17879;
const proxyPort = 17880;
const tempProfile = await mkdtemp(path.join(tmpdir(), 'proxypilot-chrome-'));
const testOptions = initialOptions();
testOptions.profiles['自动切换'].rules[0].condition.pattern = '*.proxy-test.local';
let directHits = 0;
let proxyHits = 0;

const origin = createServer((_req, res) => {
  directHits += 1;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('DIRECT_ORIGIN');
});

const proxy = createServer((_req, res) => {
  proxyHits += 1;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('PROXY_ORIGIN');
});

const pac = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-store' });
  const pac = generateAutoPac(testOptions.profiles['自动切换'], testOptions).script.replaceAll('127.0.0.1:7890', '127.0.0.1:' + proxyPort);
  res.end(pac);
});

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });

async function load(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--proxy-pac-url=http://127.0.0.1:' + pacPort + '/proxypilot.pac',
      '--host-resolver-rules=MAP proxy-test.local 127.0.0.1,MAP direct-test.local 127.0.0.1',
      '--user-data-dir=' + tempProfile, '--dump-dom', url,
    ];
    const child = spawn(chrome, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || 'Chrome exited with ' + code)));
  });
}

try {
  await Promise.all([listen(origin, originPort), listen(proxy, proxyPort), listen(pac, pacPort)]);
  const direct = await load('http://direct-test.local:' + originPort + '/');
  const routed = await load('http://proxy-test.local:' + originPort + '/');
  assert.ok(direct.includes('DIRECT_ORIGIN'));
  assert.ok(routed.includes('PROXY_ORIGIN'));
  assert.ok(directHits >= 1);
  assert.ok(proxyHits >= 1);
  console.log('Chrome PAC assertions passed: direct domain bypassed, specified domain used proxy');
} finally {
  origin.close();
  proxy.close();
  pac.close();
  await rm(tempProfile, { recursive: true, force: true });
}
