// Generates ProxyPilot desktop icons: a rounded dark tile with an amber
// "route" stroke (two nodes joined by a detour), rendered at 4x and
// box-downsampled for clean edges.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const TOP = [0x24, 0x2b, 0x3e];
const BOTTOM = [0x12, 0x16, 0x20];
const ROUTE = [0xff, 0xb4, 0x3d];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const inside = (distance) => clamp01(0.5 - distance);
const stroke = (distance, half) => clamp01(half - Math.abs(distance) + 0.5);

function distanceToSegment(px, py, from, to) {
  const vx = to.x - from.x;
  const vy = to.y - from.y;
  const wx = px - from.x;
  const wy = py - from.y;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

function shadeAt(x, y, size) {
  const px = x + 0.5 - size / 2;
  const py = y + 0.5 - size / 2;
  const half = size / 2;
  const corner = size * 0.22;
  const qx = Math.abs(px) - (half - corner);
  const qy = Math.abs(py) - (half - corner);
  const tile = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
  const nodeA = { x: -size * 0.26, y: size * 0.3, r: size * 0.09 };
  const nodeB = { x: size * 0.27, y: -size * 0.31, r: size * 0.09 };
  const elbow = { x: size * 0.14, y: size * 0.12 };
  const lineWidth = Math.max(size * 0.055, 1) / 2;
  const line = stroke(Math.min(
    distanceToSegment(px, py, nodeA, elbow),
    distanceToSegment(px, py, elbow, nodeB),
  ), lineWidth);
  const rings = stroke(Math.min(
    Math.hypot(px - nodeA.x, py - nodeA.y) - nodeA.r,
    Math.hypot(px - nodeB.x, py - nodeB.y) - nodeB.r,
  ), lineWidth);
  const tileAlpha = inside(tile);
  const shade = clamp01((x + y) / (2 * size));
  const base = TOP.map((top, index) => Math.round(top + (BOTTOM[index] - top) * shade));
  const glow = Math.max(line, rings) * 0.95;
  const mixed = base.map((channel, index) => Math.round(channel + (ROUTE[index] - channel) * glow));
  return { tileAlpha, mixed };
}

function render(size) {
  const scale = 4;
  const big = size * scale;
  const pixels = Buffer.alloc(big * big * 4, 0);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const { tileAlpha, mixed } = shadeAt(x, y, big);
      if (tileAlpha <= 0) continue;
      const index = (y * big + x) * 4;
      pixels[index] = mixed[0];
      pixels[index + 1] = mixed[1];
      pixels[index + 2] = mixed[2];
      pixels[index + 3] = Math.round(tileAlpha * 255);
    }
  }
  const output = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0; let green = 0; let blue = 0; let alpha = 0;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const index = ((y * scale + dy) * big + (x * scale + dx)) * 4;
          const a = pixels[index + 3] / 255;
          red += pixels[index] * a;
          green += pixels[index + 1] * a;
          blue += pixels[index + 2] * a;
          alpha += a;
        }
      }
      const target = (y * size + x) * 4;
      if (alpha > 0) {
        output[target] = Math.round(red / alpha);
        output[target + 1] = Math.round(green / alpha);
        output[target + 2] = Math.round(blue / alpha);
      }
      output[target + 3] = Math.round((alpha / (scale * scale)) * 255);
    }
  }
  return output;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encode(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128, 256]) {
  const file = join(OUT, 'icon' + size + '.png');
  writeFileSync(file, encode(render(size), size));
  console.log('wrote ' + file);
}
