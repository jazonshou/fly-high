/** Bounding box of the pixels that differ between two frames. */
import { decodePng } from "./frame-forensics.mts";
const a = decodePng(process.argv[2]!), b = decodePng(process.argv[3]!);
const T = Number(process.argv[4] ?? 2);
let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, maxd = 0;
for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) {
  const o = (y * a.width + x) * 4;
  const d = Math.max(
    Math.abs(a.data[o]! - b.data[o]!),
    Math.abs(a.data[o + 1]! - b.data[o + 1]!),
    Math.abs(a.data[o + 2]! - b.data[o + 2]!));
  if (d > T) {
    n += 1;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (d > maxd) maxd = d;
  }
}
console.log(`changed pixels (>${T}): ${n}`);
if (n) console.log(`bbox: x ${x0}..${x1} (${x1 - x0 + 1} wide), y ${y0}..${y1} (${y1 - y0 + 1} tall), max delta ${maxd}`);
