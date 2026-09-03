/**
 * Locate and characterise the anti-correlated tile.
 *
 * `reference-viewport` reported `worstTileRgbSsim = -0.1076` at `ed5b703`.
 * Everything tonight moved in ONE direction — surfaces that received no direct
 * sun now receive it — so a monotone brightening cannot produce a NEGATIVE
 * SSIM. Anti-correlation means the tile's structure inverted, and the two
 * candidate explanations have opposite consequences:
 *
 *   * high-frequency structure where SSIM is unstable on small features
 *     (benign — promote), or
 *   * a surface now lit INVERSELY, meaning one of the six winding sites was
 *     corrected the wrong way. The winding guard proves the sign of the
 *     geometry; it does not prove every consumer agrees with it.
 *
 * Reuses `perf-capture.mts`'s OWN `meanRgbSsim` so this measures the same
 * quantity the gate does, then writes the tile out of both frames so it can be
 * looked at rather than inferred from statistics.
 *
 *   npx tsx scripts/worst-tile-locate.mts
 */
import { writeFileSync } from "node:fs";
import { decodePng } from "./frame-forensics.mts";
import { meanRgbSsim, PERF_CAPTURE_COLOR_TILE } from "./perf-capture.mts";

const REPO = "/Users/jaszhou/git/flight-simulator";
const SHOT = process.argv[2] ?? "reference-viewport";
const AFTER_DIR = process.argv[3] ?? `${REPO}/tests/perf/artifacts`;
const BASE = `${REPO}/tests/perf/baseline/${SHOT}.png`;
const AFTER = `${AFTER_DIR}/${SHOT}.png`;

const a = decodePng(BASE);
const b = decodePng(AFTER);
console.log(`baseline ${a.width}x${a.height}, after ${b.width}x${b.height}`);
if (a.width !== b.width || a.height !== b.height) throw new Error("size mismatch");

const edge = PERF_CAPTURE_COLOR_TILE;
interface Tile { x: number; y: number; ssim: number }
const tiles: Tile[] = [];
for (let top = 0; top + edge <= a.height; top += edge) {
  for (let left = 0; left + edge <= a.width; left += edge) {
    tiles.push({
      x: left,
      y: top,
      ssim: meanRgbSsim(a.data, b.data, a.width, a.height,
        { x: left, y: top, width: edge, height: edge }),
    });
  }
}
tiles.sort((p, q) => p.ssim - q.ssim);
console.log(`\n${tiles.length} tiles of ${edge}px. Worst ten:`);
for (const t of tiles.slice(0, 10)) {
  console.log(`  (${String(t.x).padStart(4)}, ${String(t.y).padStart(3)})  ssim ${t.ssim.toFixed(4)}`);
}
const negatives = tiles.filter((t) => t.ssim < 0);
console.log(`\nanti-correlated tiles (ssim < 0): ${negatives.length}`);

/** Per-channel statistics of a tile, in both frames. */
function stats(img: typeof a, x: number, y: number) {
  const out = { r: 0, g: 0, bl: 0, varL: 0 };
  const lum: number[] = [];
  for (let dy = 0; dy < edge; dy += 1) {
    for (let dx = 0; dx < edge; dx += 1) {
      const o = ((y + dy) * img.width + (x + dx)) * 4;
      const r = img.data[o]!, g = img.data[o + 1]!, bl = img.data[o + 2]!;
      out.r += r; out.g += g; out.bl += bl;
      lum.push(0.2126 * r + 0.7152 * g + 0.0722 * bl);
    }
  }
  const n = edge * edge;
  out.r /= n; out.g /= n; out.bl /= n;
  const m = lum.reduce((s, v) => s + v, 0) / n;
  out.varL = lum.reduce((s, v) => s + (v - m) ** 2, 0) / n;
  return { ...out, meanL: m };
}

console.log("\nworst tile, both frames:");
for (const t of tiles.slice(0, 3)) {
  const sa = stats(a, t.x, t.y);
  const sb = stats(b, t.x, t.y);
  console.log(
    `  (${t.x},${t.y}) ssim ${t.ssim.toFixed(4)}`
    + `\n     baseline rgb(${sa.r.toFixed(1)}, ${sa.g.toFixed(1)}, ${sa.bl.toFixed(1)})`
    + ` lum ${sa.meanL.toFixed(1)} var ${sa.varL.toFixed(1)}`
    + `\n     after    rgb(${sb.r.toFixed(1)}, ${sb.g.toFixed(1)}, ${sb.bl.toFixed(1)})`
    + ` lum ${sb.meanL.toFixed(1)} var ${sb.varL.toFixed(1)}`
    + `\n     luminance ratio ${(sb.meanL / Math.max(sa.meanL, 1e-6)).toFixed(3)}`
    + `  variance ratio ${(sb.varL / Math.max(sa.varL, 1e-6)).toFixed(3)}`,
  );
}

// Write the worst tile from both frames, magnified 6x, side by side, so it can
// be LOOKED at. A statistic that says "inverted" and a picture that shows grass
// are different conclusions.
const worst = tiles[0]!;
const SCALE = 6;
const W = edge * SCALE * 2 + 12;
const H = edge * SCALE;
const rgba = new Uint8ClampedArray(W * H * 4);
rgba.fill(255);
for (let dy = 0; dy < H; dy += 1) {
  for (let dx = 0; dx < edge * SCALE; dx += 1) {
    const sx = worst.x + Math.floor(dx / SCALE);
    const sy = worst.y + Math.floor(dy / SCALE);
    for (const [img, xoff] of [[a, 0], [b, edge * SCALE + 12]] as const) {
      const so = (sy * img.width + sx) * 4;
      const dofs = (dy * W + (dx + xoff)) * 4;
      rgba[dofs] = img.data[so]!;
      rgba[dofs + 1] = img.data[so + 1]!;
      rgba[dofs + 2] = img.data[so + 2]!;
      rgba[dofs + 3] = 255;
    }
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
const outPath = `/tmp/worst-tile-${SHOT}.png`;
writeFileSync(outPath, file);
console.log(`\nwrote ${outPath} — baseline LEFT, after RIGHT, ${SCALE}x, tile (${worst.x},${worst.y})`);
