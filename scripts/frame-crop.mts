/** Crop a region out of a frame and magnify it, so it can be LOOKED at. */
import { writeFileSync } from "node:fs";
import { decodePng } from "./frame-forensics.mts";

const img = decodePng(process.argv[2]!);
const x0 = Number(process.argv[3]);
const y0 = Number(process.argv[4]);
const w = Number(process.argv[5]);
const h = Number(process.argv[6]);
const SCALE = Number(process.argv[7] ?? 6);
const outPath = process.argv[8] ?? "/tmp/crop.png";
const W = w * SCALE;
const H = h * SCALE;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const sx = Math.min(img.width - 1, x0 + Math.floor(x / SCALE));
    const sy = Math.min(img.height - 1, y0 + Math.floor(y / SCALE));
    const so = (sy * img.width + sx) * 4;
    const dof = (y * W + x) * 4;
    rgba[dof] = img.data[so]!;
    rgba[dof + 1] = img.data[so + 1]!;
    rgba[dof + 2] = img.data[so + 2]!;
    rgba[dof + 3] = 255;
  }
}
// Minimal PNG encoder: store-mode deflate, so no dependency is needed.
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
const raw = new Uint8Array(H * (W * 4 + 1));
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 4 + 1)] = 0;
  raw.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1);
}
const blocks: Uint8Array[] = [];
for (let off = 0; off < raw.length; off += 65_535) {
  const len = Math.min(65_535, raw.length - off);
  const last = off + len >= raw.length ? 1 : 0;
  const hdr = new Uint8Array(5);
  hdr[0] = last;
  hdr[1] = len & 0xFF; hdr[2] = (len >> 8) & 0xFF;
  hdr[3] = ~len & 0xFF; hdr[4] = (~len >> 8) & 0xFF;
  blocks.push(hdr, raw.subarray(off, off + len));
}
let adler = 1, s2 = 0;
for (const byte of raw) { adler = (adler + byte) % 65_521; s2 = (s2 + adler) % 65_521; }
const zhdr = new Uint8Array([0x78, 0x01]);
const ztail = new Uint8Array(4);
new DataView(ztail.buffer).setUint32(0, ((s2 << 16) | adler) >>> 0);
const idatLen = 2 + blocks.reduce((s, b) => s + b.length, 0) + 4;
const idat = new Uint8Array(idatLen);
let p = 0;
idat.set(zhdr, p); p += 2;
for (const bl of blocks) { idat.set(bl, p); p += bl.length; }
idat.set(ztail, p);
const ihdr = new Uint8Array(13);
const iv = new DataView(ihdr.buffer);
iv.setUint32(0, W); iv.setUint32(4, H);
ihdr[8] = 8; ihdr[9] = 6;
const png = [
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)),
];
const total = png.reduce((s, c) => s + c.length, 0);
const file = new Uint8Array(total);
let q = 0;
for (const c of png) { file.set(c, q); q += c.length; }
writeFileSync(outPath, file);
console.log(`wrote ${outPath} — ${W}x${H}, ${SCALE}x of ${w}x${h} at (${x0},${y0})`);
