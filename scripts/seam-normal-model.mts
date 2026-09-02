/**
 * The NORMAL-MODEL half of the mid->impostor seam, computed from the baked
 * normals themselves.
 *
 * `DetailInstanceMaterialPlugin.ts:1021-1023` records that the impostor atlas
 * stores "the geometry bands' OWN authored normals ... so the sprite is the
 * mid band's normal model verbatim". So both bands draw from the SAME normal
 * distribution, and the entire normal-model difference is one operation: the
 * mid band's material sets `twoSidedLighting`, which flips the normal toward
 * the viewer, and the impostor path overwrites `normalW` with the unflipped
 * baked normal.
 *
 * That makes the ratio computable exactly, with no rendering: take every baked
 * normal that survives the alpha test, and compare mean N.L under the flipped
 * and unflipped models over a sweep of sun-versus-view geometries.
 *
 * Independent of `SWE III`'s 0.515x, which was measured from frames.
 *
 *   npx tsx scripts/seam-normal-model.mts
 */
import {
  IMPOSTOR_ALPHA_TEST_THRESHOLD,
  IMPOSTOR_LAYER_EDGE,
  IMPOSTOR_SEASON_BUCKETS,
  IMPOSTOR_SPECIES,
  planImpostorAtlas,
} from "../src/render/webgpu/detail/ImpostorAtlas";

const plans = planImpostorAtlas("phase1-perf-baseline");
const albedo = plans.albedo.packedLevels[0]!;
const normalDepth = plans.normalDepth.packedLevels[0]!;
const layerCount = IMPOSTOR_SPECIES.length * IMPOSTOR_SEASON_BUCKETS;
const edge = IMPOSTOR_LAYER_EDGE;

/** Baked normals that actually draw (alpha test passes on the albedo plane). */
const normals: Array<readonly [number, number, number]> = [];
let degenerate = 0;
for (let layer = 0; layer < layerCount; layer += 1) {
  const layerStride = edge * edge * 4;
  for (let i = 0; i < edge * edge; i += 1) {
    const o = layer * layerStride + i * 4;
    if (albedo[o + 3]! / 255 < IMPOSTOR_ALPHA_TEST_THRESHOLD) continue;
    const nx = (normalDepth[o]! / 255) * 2 - 1;
    const ny = (normalDepth[o + 1]! / 255) * 2 - 1;
    const nz = (normalDepth[o + 2]! / 255) * 2 - 1;
    const len = Math.hypot(nx, ny, nz);
    // The shader's own guard: below 0.25 the texel is dilated/mip-blended and
    // falls back to straight up, the dome distribution's mean.
    if (len <= 0.25) { degenerate += 1; normals.push([0, 1, 0]); continue; }
    normals.push([nx / len, ny / len, nz / len]);
  }
}
console.log(
  `baked normals sampled: ${normals.length} texels surviving the ${IMPOSTOR_ALPHA_TEST_THRESHOLD}`
  + ` alpha test across ${layerCount} layers`
  + ` (${((degenerate / normals.length) * 100).toFixed(2)}% degenerate -> +Y)`,
);

const dot3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Mean lambertian response under each model.
 *
 * flipped  = the mid band: `twoSidedLighting` turns the normal to face the
 *            viewer before lighting, so a back-facing leaf lights as if front.
 * unflipped= the impostor band: the baked normal, used as authored.
 */
function respond(
  view: readonly [number, number, number],
  light: readonly [number, number, number],
) {
  let flipped = 0;
  let unflipped = 0;
  for (const n of normals) {
    const nl = dot3(n, light);
    unflipped += Math.max(0, nl);
    const facing = dot3(n, view) < 0 ? -1 : 1;
    flipped += Math.max(0, nl * facing);
  }
  return { flipped: flipped / normals.length, unflipped: unflipped / normals.length };
}

// The impostor is a billboard facing the camera, so the view vector is
// horizontal-ish toward the viewer. Sweep the sun's azimuth relative to it and
// its elevation, because the whole point of the wave-R note is that the two
// models diverge WORST with the sun behind the camera.
console.log("\n=== mean N.L: mid (flipped) vs impostor (unflipped) ===");
console.log("  sunElev  relAzimuth   midFlipped  farUnflipped   far/mid");
const view: readonly [number, number, number] = [0, 0, -1];
const rows: Array<{ elev: number; az: number; ratio: number }> = [];
for (const elevDeg of [10, 20, 30, 45, 60]) {
  for (const azDeg of [0, 45, 90, 135, 180]) {
    const e = (elevDeg * Math.PI) / 180;
    const a = (azDeg * Math.PI) / 180;
    // azimuth 0 = sun behind the camera (same side as the view direction).
    const light: readonly [number, number, number] = [
      Math.cos(e) * Math.sin(a),
      Math.sin(e),
      -Math.cos(e) * Math.cos(a),
    ];
    const r = respond(view, light);
    const ratio = r.unflipped / Math.max(r.flipped, 1e-9);
    rows.push({ elev: elevDeg, az: azDeg, ratio });
    console.log(
      `  ${String(elevDeg).padStart(7)}  ${String(azDeg).padStart(10)}`
      + `   ${r.flipped.toFixed(4).padStart(10)}  ${r.unflipped.toFixed(4).padStart(12)}`
      + `   ${ratio.toFixed(3).padStart(7)}`,
    );
  }
}
const ratios = rows.map((r) => r.ratio).sort((x, y) => x - y);
const median = ratios[Math.floor(ratios.length / 2)]!;
console.log(
  `\nfar/mid ratio: min ${ratios[0]!.toFixed(3)}, median ${median.toFixed(3)},`
  + ` max ${ratios[ratios.length - 1]!.toFixed(3)}`
  + `\nSWE III measured 0.515x from frames — a single configuration.`
  + `\n\nThe flip does NOT simply brighten: for a normal facing away from the`
  + ` viewer, flipping replaces max(0, N.L) with max(0, -N.L), so it RAISES the`
  + ` response when that normal also faces away from the sun and ZEROES it when`
  + ` it faces toward the sun. Which case dominates is set by the sun's azimuth`
  + ` relative to the view, so the ratio crosses 1 and the seam CHANGES SIGN.`
  + `\n\nPopulation-level, not frame-level: this weights all layers and all view`
  + ` tiles equally, where a frame sees particular species at particular views.`
  + ` Treat the SHAPE (sign change, and the range) as the finding, not any`
  + ` single cell as a prediction.`,
);
