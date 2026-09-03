/**
 * A/B SHAPE — compare two captures of one shot by the SHAPE of the change,
 * not by its mean.
 *
 * Drop into `scripts/` of any checkout (it imports `./frame-forensics.mts`) and:
 *
 *   npx tsx scripts/ab-shape.mts <before.png> <after.png> <hidden.png> [maskThreshold=8]
 *
 * `hidden.png` is a `VITE_PERF_HIDE_VEGETATION=1` capture of the SAME shot at
 * the AFTER commit; it supplies the vegetation mask. A pixel is vegetation when
 * any channel differs from the hidden frame by more than the threshold.
 *
 * ---------------------------------------------------------------------------
 * WHY BIN ON THE *BEFORE* VALUE
 *
 * This settled `C6-8`. The canopy "darkened by -0.009 mean" and six mechanisms
 * were proposed and refuted against that number, because every one of them was
 * a level-shift model and the mean cannot distinguish a level shift from a
 * REDISTRIBUTION. Binned on prior luminance the real shape appeared at once:
 * dark vegetation +30.9%, lit vegetation -15.5%, crossover at 0.045, with
 * R x0.928 / G x0.938 / B x1.003 — the direct-sun channels moving while the
 * ambient channel did not. That is `twoSidedLighting` reassigning the direct
 * term, and no summary statistic could have shown it.
 *
 * Binning on the BEFORE value matters specifically: bin on the after value, or
 * on the delta, and the bin depends on the quantity being measured, which
 * manufactures the trend you are looking for.
 *
 * ---------------------------------------------------------------------------
 * VERIFY THE MASK BEFORE YOU TRUST A RUN, AND IT COSTS TWO CAPTURES.
 *
 * Capture two HIDDEN frames across a change to the surface under test. If they
 * DIFFER, the mask is blind to that surface -- geometry cannot change a frame
 * it is absent from. Cheap, decisive, and it needs no knowledge of the
 * renderer. Same shape as STEP 0.
 *
 * It would have caught this immediately: `VITE_PERF_HIDE_VEGETATION` matches
 * `detail-` only, and the compute blade field's meshes are
 * `ground-cover-ring-N`. So 100% of blade pixels are classified TERRAIN --
 * measured ~100% of a blade-only change landing in the terrain row on
 * `grove-meadow-2m` and ~91% on `grove-forest-2m`, the difference being that
 * the forest has crowns behind its blades and the meadow does not.
 *
 * And fixing the predicate is NOT sufficient: with `ground-cover-` added, two
 * HIDDEN frames STILL differ across a blade change, so `isVisible = false`
 * does not suppress the blade draw. `GroundCoverSystem` gates with
 * `setEnabled()`, re-asserts it every update, and sets
 * `alwaysSelectAsActiveMesh = true`. A real fix has to suppress the indirect
 * draw itself.
 *
 * ---------------------------------------------------------------------------
 * THE TERRAIN ROW IS NOT A CONTROL FOR A GROUND-COVER CHANGE.
 *
 * Measured 2026-09-01 on `grove-meadow-2m`: toggling the blade winding in
 * place moved TERRAIN by -0.00317 while VEGETATION moved -0.00001. The null
 * A/B on that shot is byte-identical, so that terrain movement IS the blade
 * fix -- the effect is real and the mask is scoring it in the wrong
 * population. Lowering `maskThreshold` from 8 to 2 moved 32k pixels and did
 * not fix it.
 *
 * So for thin, low-contrast ground cover -- exactly the surface this script
 * was built to verify -- a near-zero vegetation dY with a moving terrain row
 * is an INSTRUMENT ARTIFACT, not a null result. Read both rows together, and
 * do not quote "the change did essentially nothing" from the vegetation row
 * alone.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE THE FRAMES, NOT AFTER
 *
 * 1. **The winding fix is correct and NOT monotonic.** It reassigns the direct
 *    term across the complementary set of fragments: some correctly GAIN direct
 *    sun and some correctly LOSE it. A frame whose lit canopy darkened is what
 *    a correct fix looks like here. To an eye expecting improvement everywhere
 *    it reads as a regression.
 *
 * 2. **A pre-authorised category is not a prediction; a shape is.** "Blades
 *    change materially" and "non-monotonic, file neither" between them sanction
 *    almost any movement, including the failure they were meant to let through.
 *    The prediction that can actually be wrong is: **dark bins RISE, lit bins
 *    FALL slightly, crossover LOW.**
 *      - Uniform brightening across all bins -> does NOT fit. File it.
 *      - Dark bins FALLING -> does NOT fit. File it.
 *    Both satisfy "changed materially" in words and contradict it in shape.
 *
 * 3. **`aada1cd`'s coverage guard guarantees the BUILDER is represented, not
 *    that every VARIANT it produces is.** One builder, four clutter kinds, one
 *    checked is exactly how `mossCushion` stayed invisible. Green there does not
 *    mean a surface is covered.
 * ---------------------------------------------------------------------------
 */

import { decodePng, luminance, pixelAt } from "./frame-forensics.mts";

const [beforePath, afterPath, hiddenPath, thresholdArg] = process.argv.slice(2);
if (!beforePath || !afterPath || !hiddenPath) {
  console.error("usage: ab-shape.mts <before.png> <after.png> <hidden.png> [maskThreshold=8]");
  process.exit(2);
}
const MASK_THRESHOLD = Number(thresholdArg ?? 8);

const before = decodePng(beforePath);
const after = decodePng(afterPath);
const hidden = decodePng(hiddenPath);
const W = Math.min(before.width, after.width, hidden.width);
const H = Math.min(before.height, after.height, hidden.height);
console.log(`dims ${W}x${H}  maskThreshold=${MASK_THRESHOLD}`);

// -------------------------------------------------------------- STEP 0
// Is the BEFORE image a normal capture, or is it secretly a hidden one?
//
// This check costs one comparison and it is the entire difference between a
// sound measurement and the one that cost a night. A `prior/` directory was
// assembled by bulk-copying artifacts; one file in it was a vegetation-HIDDEN
// capture, and three sessions reasoned from it for hours. A hidden frame reads
// ~0% here; a normal one reads tens of percent. NEVER SKIP THIS.
let over = 0;
let sampled = 0;
for (let y = 0; y < H; y += 2) {
  for (let x = 0; x < W; x += 2) {
    const a = pixelAt(before, x, y);
    const h = pixelAt(hidden, x, y);
    sampled += 1;
    if (Math.max(Math.abs(a[0] - h[0]), Math.abs(a[1] - h[1]), Math.abs(a[2] - h[2])) > 18) {
      over += 1;
    }
  }
}
const overPct = (100 * over) / sampled;
console.log(`\nSTEP 0  before-vs-hidden: ${overPct.toFixed(1)}% over threshold`);
console.log(overPct < 5
  ? "  *** STOP: the BEFORE image looks like a HIDDEN capture. Do not compare. ***"
  : "  ok — BEFORE is a normal capture (a hidden one reads ~0%)");

// -------------------------------------------------------------- STEP 0b
// Is BEFORE the same image as AFTER?
//
// After a promotion, `tests/perf/baseline/<shot>.png` IS the candidate that was
// just promoted, so the obvious invocation compares a frame against itself and
// every bin reads exactly 1.000. That is indistinguishable from "the change did
// nothing" -- a clean, plausible, entirely false result, and STEP 0 cannot see
// it because both images are normal captures.
//
// Measured: re-running the blade verification after `090bf2f` returned 1.000 in
// all nine bins for `grove-forest-2m`, a shot whose dark bin actually moved
// x8.741. Recover the true "before" from git rather than the working tree:
//
//   git show <promotion-commit>^:tests/perf/baseline/<shot>.png > /tmp/before.png
let identical = true;
for (let y = 0; y < H && identical; y += 2) {
  for (let x = 0; x < W; x += 2) {
    const a = pixelAt(before, x, y);
    const b = pixelAt(after, x, y);
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) { identical = false; break; }
  }
}
console.log(`\nSTEP 0b before-vs-after: ${identical ? "IDENTICAL" : "differ"}`);
if (identical) {
  console.log("  *** STOP: BEFORE and AFTER are the same image. Every ratio below");
  console.log("      will read 1.000 and that is an artifact, not a result. If the");
  console.log("      baselines were promoted, recover the pre-promotion frame with");
  console.log("      `git show <promotion>^:tests/perf/baseline/<shot>.png`. ***");
  process.exit(2);
}

// -------------------------------------------------------------- populations
const EDGES = [0, 0.02, 0.04, 0.06, 0.08, 0.11, 0.15, 0.20, 0.30, 99];
const nBin = EDGES.length - 1;
const bn = new Array<number>(nBin).fill(0);
const bb = new Array<number>(nBin).fill(0);
const ba = new Array<number>(nBin).fill(0);
const veg: number[] = [];
const terr: number[] = [];
let vB = 0, vA = 0, tB = 0, tA = 0;
let rB = 0, gB = 0, blB = 0, rA = 0, gA = 0, blA = 0;

for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const p = pixelAt(after, x, y);
    const h = pixelAt(hidden, x, y);
    const q = pixelAt(before, x, y);
    const isVeg = Math.max(Math.abs(p[0] - h[0]), Math.abs(p[1] - h[1]), Math.abs(p[2] - h[2]))
      > MASK_THRESHOLD;
    const yb = luminance(q[0], q[1], q[2]);
    const ya = luminance(p[0], p[1], p[2]);
    if (isVeg) {
      vB += yb; vA += ya; veg.push(ya);
      rB += q[0]; gB += q[1]; blB += q[2];
      rA += p[0]; gA += p[1]; blA += p[2];
      for (let i = 0; i < nBin; i += 1) {
        if (yb >= EDGES[i]! && yb < EDGES[i + 1]!) { bn[i]! += 1; bb[i]! += yb; ba[i]! += ya; break; }
      }
    } else { tB += yb; tA += ya; terr.push(ya); }
  }
}
const vN = veg.length || 1;
const tN = terr.length || 1;

console.log(`\nVEGETATION n=${veg.length}  meanY ${(vB / vN).toFixed(5)} -> ${(vA / vN).toFixed(5)}`
  + `   dY=${((vA - vB) / vN).toFixed(5)}`);
console.log(`TERRAIN    n=${terr.length}  meanY ${(tB / tN).toFixed(5)} -> ${(tA / tN).toFixed(5)}`
  + `   dY=${((tA - tB) / tN).toFixed(5)}   <- control; should be ~0`);

console.log(`\nPER-CHANNEL (vegetation mean byte)`);
console.log(`  R ${(rB / vN).toFixed(1)} -> ${(rA / vN).toFixed(1)}  x${(rA / rB).toFixed(3)}`);
console.log(`  G ${(gB / vN).toFixed(1)} -> ${(gA / vN).toFixed(1)}  x${(gA / gB).toFixed(3)}`);
console.log(`  B ${(blB / vN).toFixed(1)} -> ${(blA / vN).toFixed(1)}  x${(blA / blB).toFixed(3)}`
  + `   <- R,G move + B flat = a DIRECT-light change, ambient untouched`);

console.log(`\nBINNED BY *BEFORE* LUMINANCE (the bin never depends on the measured value)`);
console.log(`  beforeY range        n      meanBefore   meanAfter    ratio`);
let crossover: string | null = null;
let previousRatio: number | null = null;
for (let i = 0; i < nBin; i += 1) {
  if (bn[i]! < 200) continue;
  const ratio = ba[i]! / bb[i]!;
  const hi = EDGES[i + 1] === 99 ? "inf " : EDGES[i + 1]!.toFixed(2);
  console.log(`  ${EDGES[i]!.toFixed(2)}-${hi}   ${String(bn[i]!).padStart(8)}   `
    + `${(bb[i]! / bn[i]!).toFixed(5)}     ${(ba[i]! / bn[i]!).toFixed(5)}     ${ratio.toFixed(3)}`);
  if (previousRatio !== null && previousRatio > 1 && ratio < 1 && crossover === null) {
    crossover = `${EDGES[i]!.toFixed(2)}-${hi}`;
  }
  previousRatio = ratio;
}

console.log(`\nSHAPE VERDICT`);
console.log(`  crossover bin: ${crossover ?? "none found (no bin crosses 1.0)"}`);
console.log(`  EXPECTED: dark bins > 1.0, lit bins < 1.0, crossover low.`);
console.log(`  A UNIFORM ratio across all bins, or dark bins < 1.0, does NOT fit`);
console.log(`  the sanctioned description and should be FILED, not waved through.`);
