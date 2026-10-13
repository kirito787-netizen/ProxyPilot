import assert from 'node:assert/strict';
import { defaultOptions } from '../src/common/constants.js';
import { buildAutoPac, buildSystemPac } from '../src/common/proxy.js';

const opts = defaultOptions();
const autoPac = buildAutoPac(opts.profiles['自动切换'], opts);
assert.ok(autoPac.includes('shExpMatch(host, \"*.google.com\")'));
assert.ok(autoPac.includes('PROXY 127.0.0.1:7890'));
assert.ok(autoPac.includes('return \"DIRECT\"'));
const fixedPac = buildSystemPac('代理服务器', opts);
assert.ok(fixedPac.includes('PROXY 127.0.0.1:7890'));
assert.ok(fixedPac.includes("host.indexOf('.') === -1"));

const autoFunction = new Function('shExpMatch', 'host', 'url', autoPac + '; return FindProxyForURL(url, host);');
const matcher = (value, pattern) => { const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return re.test(value); };
assert.equal(autoFunction(matcher, 'google.com', 'https://google.com'), 'PROXY 127.0.0.1:7890');
assert.equal(autoFunction(matcher, 'example.com', 'https://example.com'), 'DIRECT');
console.log('PAC assertions passed');
