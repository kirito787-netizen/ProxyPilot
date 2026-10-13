// Assemble icons/proxypilot.ico from the generated PNGs.
// 16/32/48/64 are stored as uncompressed BMP entries (best compatibility);
// 128/256 are stored as PNG entries (supported since Windows Vista).

import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ICONS = path.resolve('icons');

function decodePng(file) {
  const data = readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + file);
  let offset = 8;
  let width = 0; let height = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(body);
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error('unsupported PNG filter ' + filter + ' in ' + file);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgba };
}

function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2];
      xor[dst + 1] = rgba[src + 1];
      xor[dst + 2] = rgba[src];
      xor[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, xor, and]);
}

const pngSizes = [128, 256];
const bmpSizes = [16, 32, 48, 64];
const entries = [];
for (const size of bmpSizes) {
  const { width, height, rgba } = decodePng(path.join(ICONS, 'icon' + size + '.png'));
  if (width !== size || height !== size) throw new Error('size mismatch in icon' + size + '.png');
  entries.push({ size, data: bmpEntry(rgba, size) });
}
for (const size of pngSizes) {
  entries.push({ size, data: readFileSync(path.join(ICONS, 'icon' + size + '.png')) });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);

const directory = Buffer.alloc(16 * entries.length);
let offset = header.length + directory.length;
entries.forEach((entry, index) => {
  const base = index * 16;
  directory.writeUInt8(entry.size === 256 ? 0 : entry.size, base);
  directory.writeUInt8(entry.size === 256 ? 0 : entry.size, base + 1);
  directory.writeUInt8(0, base + 2);
  directory.writeUInt8(0, base + 3);
  directory.writeUInt16LE(1, base + 4);
  directory.writeUInt16LE(32, base + 6);
  directory.writeUInt32LE(entry.data.length, base + 8);
  directory.writeUInt32LE(offset, base + 12);
  offset += entry.data.length;
});

const out = path.join(ICONS, 'proxypilot.ico');
writeFileSync(out, Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]));
console.log('wrote ' + out + ' (' + entries.length + ' sizes)');
