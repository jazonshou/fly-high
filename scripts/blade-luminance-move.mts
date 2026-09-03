/**
 * Did the ground-cover blades move between baseline and candidate?
 *
 * The blades are the darkest population in the near ground, so the question is
 * answered on the DARK TAIL of the lower frame rather than on a whole-frame
 * mean, which is dominated by lit canopy and would report "moved" for reasons
 * that have nothing to do with blades.
 *
 * Deliberately reports the moved-pixel COUNT as well as the means: two
 * populations can have identical means and be entirely different pixels, and
 * "did it move at all" is a question about pixels, not about averages.
 *
 *   npx tsx scripts/blade-luminance-move.mts <baseline.png> <candidate.png>
 */
import { decodePng } from "./frame-forensics.mts";

const a = decodePng(process.argv[2]!);
const b = decodePng(process.argv[3]!);
if (a.width !== b.width || a.height !== b.height) throw new Error("size mismatch");
const lum = (d: ArrayLike<number>, o: number) =>
  0.2126 * d[o]! + 0.7152 * d[o + 1]! + 0.0722 * d[o + 2]!;

// Lower third: at 1.7 m eye height with 2 deg of pitch this is ground, and
// ground inside the 80 m blade-field radius of the shipping law.
const top = Math.floor(a.height * (2 / 3));
const DARK = 30;
let n = 0, darkA = 0, darkB = 0, sumA = 0, sumB = 0, moved = 0, movedDark = 0;
let maxDelta = 0;
for (let y = top; y < a.height; y += 1) {
  for (let x = 0; x < a.width; x += 1) {
    const o = (y * a.width + x) * 4;
    const la = lum(a.data, o), lb = lum(b.data, o);
    n += 1;
    if (la < DARK) { darkA += 1; sumA += la; }
    if (lb < DARK) { darkB += 1; sumB += lb; }
    const d = Math.abs(la - lb);
    if (d > 0.5) { moved += 1; if (la < DARK) movedDark += 1; }
    if (d > maxDelta) maxDelta = d;
  }
}
console.log(`lower third: ${n} px, rows ${top}..${a.height - 1}`);
console.log(`  dark (<${DARK}) baseline ${darkA} px (${(darkA / n * 100).toFixed(2)}%) mean ${(sumA / Math.max(darkA, 1)).toFixed(2)}`);
console.log(`  dark (<${DARK}) candidate ${darkB} px (${(darkB / n * 100).toFixed(2)}%) mean ${(sumB / Math.max(darkB, 1)).toFixed(2)}`);
console.log(`  pixels moved >0.5 lum: ${moved} (${(moved / n * 100).toFixed(2)}%)`);
console.log(`  of the baseline-dark pixels, moved: ${movedDark} / ${darkA} (${(movedDark / Math.max(darkA, 1) * 100).toFixed(2)}%)`);
console.log(`  max |delta| anywhere in band: ${maxDelta.toFixed(2)}`);
