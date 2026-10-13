// Generates ProxyPilot's PNG icons with no external dependencies.
// A white globe on a blue gradient rounded square, rendered with 4x
// supersampling for clean antialiased edges.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

// Neutral charcoal — matches the monospace "tool" aesthetic (no AI blue).
const ACCENT_LIGHT = [0x2e, 0x35, 0x40];
const ACCENT_DARK = [0x1a, 0x1f, 0x27];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
// Soft 1px coverage from a signed distance (negative = inside).
const cov = (signed) => clamp01(0.5 - signed);
// Coverage of a stroke band given absolute distance to its centerline.
const band = (absDist, halfWidth) => clamp01(halfWidth - absDist + 0.5);

function renderRGBA(S) {
  const SS = 4;
  const N = S * SS;
  const buf = Buffer.alloc(N * N * 4, 0);

  const c = N / 2;
  const half = N / 2;
  const corner = N * 0.24;

  const R = N * 0.3; // globe radius
  const w = Math.max(N * 0.06, 1); // stroke width
  const hw = w * 0.42; // half stroke for thin lines

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;

      // Rounded-square background mask.
      const qx = Math.abs(px) - (half - corner);
      const qy = Math.abs(py) - (half - corner);
      const outside =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
      const bgA = cov(outside);
      if (bgA <= 0) continue;

      // Diagonal gradient.
      const t = clamp01((x + y) / (2 * N));
      const br = lerp(ACCENT_LIGHT[0], ACCENT_DARK[0], t);
      const bg = lerp(ACCENT_LIGHT[1], ACCENT_DARK[1], t);
      const bb = lerp(ACCENT_LIGHT[2], ACCENT_DARK[2], t);

      // Globe (white strokes).
      const d = Math.hypot(px, py);
      const insideMask = clamp01(R - d + 0.5); // clip lines to the disc
      const ring = band(Math.abs(d - R), w / 2);
      const equator = band(Math.abs(py), hw) * insideMask;
      const meridian = band(Math.abs(px), hw) * insideMask;
      // Vertical ellipse → the two curved side meridians.
      const rx = R * 0.55;
      const ry = R;
      const f = Math.sqrt((px * px) / (rx * rx) + (py * py) / (ry * ry));
      const ellipse = band(Math.abs(f - 1) * rx, hw) * insideMask;

      const fg = Math.min(1, Math.max(ring, equator, meridian, ellipse)) * 0.96;

      const r = lerp(br, 255, fg);
      const g = lerp(bg, 255, fg);
      const b = lerp(bb, 255, fg);

      const i = (y * N + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = bgA * 255;
    }
  }

  return downsample(buf, N, SS);
}

// Box-downsample with premultiplied alpha to avoid dark edge fringes.
function downsample(src, N, SS) {
  const S = N / SS;
  const out = Buffer.alloc(S * S * 4, 0);
  for (let oy = 0; oy < S; oy++) {
    for (let ox = 0; ox < S; ox++) {
      let a = 0, pr = 0, pg = 0, pb = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((oy * SS + dy) * N + (ox * SS + dx)) * 4;
          const av = src[i + 3] / 255;
          a += av;
          pr += src[i] * av;
          pg += src[i + 1] * av;
          pb += src[i + 2] * av;
        }
      }
      const n = SS * SS;
      const oi = (oy * S + ox) * 4;
      const outA = a / n;
      if (a > 0) {
        out[oi] = Math.round(pr / a);
        out[oi + 1] = Math.round(pg / a);
        out[oi + 2] = Math.round(pb / a);
      }
      out[oi + 3] = Math.round(outA * 255);
    }
  }
  return out;
}

// ---- minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, S) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10,11,12 = 0 (compression, filter, interlace)

  const stride = S * 4;
  const raw = Buffer.alloc((stride + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const rgba = renderRGBA(size);
  const png = encodePNG(rgba, size);
  writeFileSync(join(OUT, `icon${size}.png`), png);
  console.log(`wrote icon${size}.png (${png.length} bytes)`);
}
