/** Crop a region out of a frame and magnify it, so it can be LOOKED at. */
import { writeFileSync } from "node:fs";
import { decodePng, type DecodedImage } from "./frame-forensics.mts";

/**
 * Magnify a region of a decoded frame into RGBA.
 *
 * THE SOURCE IS NOT NECESSARILY RGBA, and assuming it was is what made this
 * script quietly produce garbage for months. Playwright writes its screenshots
 * as THREE-channel RGB when the page is opaque, so a decoded frame's row
 * stride is `width * 3`; indexing it at `* 4` walks a third of a pixel further
 * along every pixel and a whole row further every three, which comes out as a
 * sheared, scanline-striped version of the real image — recognisable enough to
 * be mistaken for a rendering fault, which is exactly what happened.
 *
 * `decodePng` has always reported `channels`. Nothing read it.
 */
export function magnifyRegion(
  img: DecodedImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  scale: number,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`crop scale must be a positive integer, not ${scale}`);
  }
  if (!(w > 0 && h > 0)) throw new RangeError(`crop size must be positive, not ${w}x${h}`);
  const stride = img.channels;
  if (stride !== 3 && stride !== 4) {
    throw new RangeError(`cannot crop a ${stride}-channel image`);
  }
  if (img.data.length !== img.width * img.height * stride) {
    throw new RangeError(
      `${img.width}x${img.height} at ${stride} channels needs `
      + `${img.width * img.height * stride} bytes, got ${img.data.length}`,
    );
  }
  const width = w * scale;
  const height = h * scale;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(img.width - 1, x0 + Math.floor(x / scale));
      const sy = Math.min(img.height - 1, y0 + Math.floor(y / scale));
      const source = (sy * img.width + sx) * stride;
      const target = (y * width + x) * 4;
      rgba[target] = img.data[source]!;
      rgba[target + 1] = img.data[source + 1]!;
      rgba[target + 2] = img.data[source + 2]!;
      rgba[target + 3] = 255;
    }
  }
  return { width, height, rgba };
}

// Run as a script only. Imported (by its test), it is the function above.
const invokedDirectly = process.argv[1]?.endsWith("frame-crop.mts") ?? false;
const img = invokedDirectly ? decodePng(process.argv[2]!) : null;
const x0 = Number(process.argv[3]);
const y0 = Number(process.argv[4]);
const w = Number(process.argv[5]);
const h = Number(process.argv[6]);
const SCALE = Number(process.argv[7] ?? 6);
const outPath = process.argv[8] ?? "/tmp/crop.png";
if (!img) {
  // Imported for its function; nothing to write.
} else {
const { width: W, height: H, rgba } = magnifyRegion(img, x0, y0, w, h, SCALE);
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
}
