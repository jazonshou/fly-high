/**
 * Independent decomposition of the mid->impostor band seam.
 *
 * The question Jason's decision turns on: of the visible step at the handoff,
 * how much is the NORMAL MODEL (the mid band lights with `twoSidedLighting`,
 * flipping the normal toward the viewer, while the impostor path overwrites
 * `normalW` with the unflipped baked normal) and how much is STRUCTURAL — the
 * alpha-tested card shell versus the coverage-averaged, mip-rescaled,
 * three-view-blended sprite?
 *
 * A normal-model fix removes only the first. If the structural residual is
 * large, no normal fix closes the seam and the option costed on that basis is
 * mispriced.
 *
 * CPU-only: `planImpostorAtlas` and `planFoliageAtlas` do all pixel work on the
 * CPU and only `upload*` touches a GPU, so this runs under the thermal window.
 *
 *   npx tsx scripts/seam-residual-decompose.mts
 */
import {
  IMPOSTOR_ALPHA_TEST_THRESHOLD,
  IMPOSTOR_LAYER_EDGE,
  IMPOSTOR_SEASON_BUCKETS,
  IMPOSTOR_SPECIES,
  IMPOSTOR_TILE_EDGE,
  IMPOSTOR_VIEW_GRID,
  planImpostorAtlas,
} from "../src/render/webgpu/detail/ImpostorAtlas";

const plans = planImpostorAtlas("phase1-perf-baseline");
const levels = plans.albedo.packedLevels;
const layerCount = plans.albedo.layerCount ?? IMPOSTOR_SPECIES.length * IMPOSTOR_SEASON_BUCKETS;

console.log(
  `impostor albedo: ${levels.length} mip levels, ${layerCount} layers,`
  + ` base edge ${IMPOSTOR_LAYER_EDGE}, tile ${IMPOSTOR_TILE_EDGE},`
  + ` ${IMPOSTOR_VIEW_GRID}x${IMPOSTOR_VIEW_GRID} views, alpha test`
  + ` ${IMPOSTOR_ALPHA_TEST_THRESHOLD}`,
);

/** Alpha plane of one view tile at one mip level, as floats in [0,1]. */
function tileAlpha(level: number, layer: number, viewX: number, viewY: number): number[] {
  const edge = IMPOSTOR_LAYER_EDGE >> level;
  const tile = IMPOSTOR_TILE_EDGE >> level;
  if (tile < 1) return [];
  const bytes = levels[level]!;
  const layerStride = edge * edge * 4;
  const out: number[] = [];
  for (let y = 0; y < tile; y += 1) {
    for (let x = 0; x < tile; x += 1) {
      const px = viewX * tile + x;
      const py = viewY * tile + y;
      const offset = layer * layerStride + (py * edge + px) * 4;
      out.push(bytes[offset + 3]! / 255);
    }
  }
  return out;
}

const coverage = (alpha: readonly number[]) =>
  alpha.length === 0 ? 0
    : alpha.filter((a) => a >= IMPOSTOR_ALPHA_TEST_THRESHOLD).length / alpha.length;
const mean = (alpha: readonly number[]) =>
  alpha.length === 0 ? 0 : alpha.reduce((s, a) => s + a, 0) / alpha.length;

// ---------------------------------------------------------------------------
// 1. Coverage across mip levels.
//
// A tree ~18 m tall at 2,200 m subtends about 18/2200 * (720/(2*tan(30deg)))
// ~= 5.7 px, against a 64 px tile — so the impostor samples around mip 3-4.
// If coverage is not preserved there, the sprite draws a different amount of
// tree than the cards do, and no normal model can correct it.
// ---------------------------------------------------------------------------
console.log("\n=== coverage vs mip level (alpha >= 0.5 after the atlas's own rescale) ===");
console.log("  level  edge  tile   meanAlpha   coverage   vs base");
const baseCoverageByLayer: number[] = [];
for (let level = 0; level < levels.length; level += 1) {
  const tile = IMPOSTOR_TILE_EDGE >> level;
  if (tile < 2) break;
  let covSum = 0;
  let meanSum = 0;
  let n = 0;
  for (let layer = 0; layer < layerCount; layer += 1) {
    for (let vy = 0; vy < IMPOSTOR_VIEW_GRID; vy += 1) {
      for (let vx = 0; vx < IMPOSTOR_VIEW_GRID; vx += 1) {
        const a = tileAlpha(level, layer, vx, vy);
        covSum += coverage(a);
        meanSum += mean(a);
        n += 1;
      }
    }
  }
  const cov = covSum / n;
  if (level === 0) baseCoverageByLayer.push(cov);
  const base = baseCoverageByLayer[0]!;
  console.log(
    `  ${String(level).padStart(5)}  ${String(IMPOSTOR_LAYER_EDGE >> level).padStart(4)}`
    + `  ${String(tile).padStart(4)}   ${(meanSum / n).toFixed(4).padStart(9)}`
    + `   ${cov.toFixed(4).padStart(8)}   ${(cov - base >= 0 ? "+" : "")}${(cov - base).toFixed(4)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. The three-view blend.
//
// The shader samples THREE adjacent views and blends them premultiplied, THEN
// alpha-tests the blend at 0.5. Thresholding a smoothed field is not the same
// as smoothing thresholded fields: blending pulls alpha toward the mean, so
// texels that would individually pass or fail can flip. This measures the
// difference directly, at the mip an impostor actually samples.
// ---------------------------------------------------------------------------
console.log("\n=== single view vs 3-view blend, thresholded at 0.5 ===");
console.log("  level   singleCov   blendCov    delta    ratio");
for (const level of [0, 2, 3, 4]) {
  const tile = IMPOSTOR_TILE_EDGE >> level;
  if (tile < 2) continue;
  let single = 0;
  let blended = 0;
  let n = 0;
  for (let layer = 0; layer < layerCount; layer += 1) {
    for (let vy = 0; vy < IMPOSTOR_VIEW_GRID; vy += 1) {
      for (let vx = 0; vx < IMPOSTOR_VIEW_GRID - 2; vx += 1) {
        const a = tileAlpha(level, layer, vx, vy);
        const b = tileAlpha(level, layer, vx + 1, vy);
        const c = tileAlpha(level, layer, vx + 2, vy);
        if (a.length === 0) continue;
        // Representative interior weights: the grid triangle's barycentric
        // coordinates away from a vertex, where all three views contribute.
        const wA = 0.5;
        const wB = 0.3;
        const wC = 0.2;
        const blend = a.map((_, i) => a[i]! * wA + b[i]! * wB + c[i]! * wC);
        single += coverage(a);
        blended += coverage(blend);
        n += 1;
      }
    }
  }
  const s = single / n;
  const bl = blended / n;
  console.log(
    `  ${String(level).padStart(5)}   ${s.toFixed(4).padStart(9)}   ${bl.toFixed(4).padStart(8)}`
    + `  ${(bl - s >= 0 ? "+" : "")}${(bl - s).toFixed(4)}   ${(bl / Math.max(s, 1e-6)).toFixed(3)}`,
  );
}

console.log(
  `\nReading: 'coverage' is the fraction of a view tile that SURVIVES the 0.5`
  + ` alpha test — i.e. the fraction of the sprite's footprint that draws tree`
  + ` rather than background. A coverage ratio far from 1.0 between what the`
  + ` cards draw and what the sprite draws is a STRUCTURAL step that no`
  + ` normal-model change can remove.`,
);
