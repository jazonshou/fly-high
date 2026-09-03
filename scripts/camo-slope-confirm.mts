/**
 * Defect 4 (terrain camo splotches): independent confirmation, and the
 * measurement that decides the fix.
 *
 * The adversarial workflow's root cause: the suitability laws disagree about
 * where slope matters. Grass/Sand/DryGrass die by slope 0.26 via
 * `gentle = 1 - smoothstep(0.06, 0.26, slope)`; ForestFloor is untouched below
 * 0.24; Rock and Gravel switch on at 0.24. The softmax then turns the overlaps
 * near-categorical, so a smoothly varying slope field paints three tones.
 *
 * This confirms it by a second route and answers the question the fix turns on
 * that a dominant-material table cannot: **how WIDE is each transition**, in
 * slope units and then in METRES on real terrain? A hard edge and a soft one
 * have the same dominant-material table and look completely different.
 *
 *   - narrow in slope units  -> softmax temperature is the lever
 *   - windows that overlap   -> threshold alignment is the lever
 *   - both                   -> both, and the order matters
 *
 * CPU-only. No render, no token.
 *
 *   npx tsx scripts/camo-slope-confirm.mts
 */
import {
  classifyLandCover,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import { SURFACE_MATERIALS } from "../src/render/webgpu/terrain/surfaceMaterials";
import { createWorld, sampleTerrain } from "../src/world";

function baseInput(slope: number): LandCoverInput {
  return {
    elevationMeters: 60,
    slope,
    moisture: 0.55,
    temperature: 0.5,
    aspect: 0,
    airportInfluence: 0,
    dayOfYear: 171,
    seasonalTemperatureShift: 0,
  };
}

const nameOf = (id: number) => SURFACE_MATERIALS[id]?.name ?? `#${id}`;

function dominant(slope: number) {
  const w = classifyLandCover(baseInput(slope));
  let best = 0;
  for (let i = 1; i < w.ids.length; i += 1) {
    if (w.weights[i]! > w.weights[best]!) best = i;
  }
  return { id: w.ids[best]!, weight: w.weights[best]!, ids: w.ids, weights: w.weights };
}

// ---------------------------------------------------------------------------
// 1. Where the dominant flips, and how wide the flip is in SLOPE units.
//
// "Width" here is the slope interval over which the outgoing material falls
// from 0.75 to 0.25 of the total weight — a blend that spans a wide interval
// reads as an ecotone, one that spans a narrow interval reads as a cut line.
// ---------------------------------------------------------------------------
console.log("=== dominant material vs slope (elev 60 m, moisture 0.55, no canopy) ===");
const STEP = 0.002;
let previous = -1;
const flips: Array<{ slope: number; from: number; to: number }> = [];
for (let slope = 0; slope <= 0.7; slope += STEP) {
  const d = dominant(slope);
  if (previous >= 0 && d.id !== previous) {
    flips.push({ slope, from: previous, to: d.id });
    console.log(
      `  flip at slope ${slope.toFixed(3)}: ${nameOf(previous)} -> ${nameOf(d.id)}`
      + `  (winner weight ${d.weight.toFixed(3)})`,
    );
  }
  previous = d.id;
}

console.log("\n=== transition WIDTH in slope units (0.75 -> 0.25 of the outgoing) ===");
for (const flip of flips) {
  const share = (slope: number, id: number) => {
    const w = classifyLandCover(baseInput(slope));
    let total = 0;
    let mine = 0;
    for (let i = 0; i < w.ids.length; i += 1) {
      total += w.weights[i]!;
      if (w.ids[i] === id) mine += w.weights[i]!;
    }
    return total > 0 ? mine / total : 0;
  };
  let hi = flip.slope;
  let lo = flip.slope;
  while (hi > 0 && share(hi, flip.from) < 0.75) hi -= STEP;
  while (lo < 0.7 && share(lo, flip.from) > 0.25) lo += STEP;
  console.log(
    `  ${nameOf(flip.from)} -> ${nameOf(flip.to)}: 0.75 at slope ${hi.toFixed(3)},`
    + ` 0.25 at ${lo.toFixed(3)}  =>  width ${(lo - hi).toFixed(3)} slope units`,
  );
}

// ---------------------------------------------------------------------------
// 2. Convert that to METRES on real terrain.
//
// A transition 0.02 slope units wide is invisible if slope takes 200 m to move
// that far, and a hard cut line if it takes 2 m. This measures the actual
// |d(slope)/d(distance)| of the shipping world.
// ---------------------------------------------------------------------------
const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const ax = world.airport?.centerX ?? 0;
const az = world.airport?.centerZ ?? 0;
const PROBE = 8; // metres between slope samples
const gradients: number[] = [];
for (let dz = -6_000; dz <= 6_000; dz += 250) {
  for (let dx = -6_000; dx <= 6_000; dx += 250) {
    const x = ax + dx;
    const z = az + dz;
    const s0 = sampleTerrain(world, x, z, undefined, 171).slope;
    if (sampleTerrain(world, x, z, undefined, 171).height < world.seaLevel + 10) continue;
    const sx = sampleTerrain(world, x + PROBE, z, undefined, 171).slope;
    const sz = sampleTerrain(world, x, z + PROBE, undefined, 171).slope;
    const grad = Math.hypot(sx - s0, sz - s0) / PROBE; // slope units per metre
    if (grad > 0) gradients.push(grad);
  }
}
gradients.sort((a, b) => a - b);
const pct = (q: number) => gradients[Math.floor(q * (gradients.length - 1))]!;
console.log(
  `\n=== terrain slope gradient (${gradients.length} land probes) ===`
  + `\n  slope units per metre: p10 ${pct(0.1).toExponential(2)},`
  + ` median ${pct(0.5).toExponential(2)}, p90 ${pct(0.9).toExponential(2)}`,
);

console.log("\n=== transition width in METRES on this terrain ===");
console.log("  transition                        width(slope)   p90-steep   median   p10-flat");
for (const flip of flips) {
  const share = (slope: number, id: number) => {
    const w = classifyLandCover(baseInput(slope));
    let total = 0;
    let mine = 0;
    for (let i = 0; i < w.ids.length; i += 1) {
      total += w.weights[i]!;
      if (w.ids[i] === id) mine += w.weights[i]!;
    }
    return total > 0 ? mine / total : 0;
  };
  let hi = flip.slope;
  let lo = flip.slope;
  while (hi > 0 && share(hi, flip.from) < 0.75) hi -= STEP;
  while (lo < 0.7 && share(lo, flip.from) > 0.25) lo += STEP;
  const width = lo - hi;
  const label = `${nameOf(flip.from)} -> ${nameOf(flip.to)}`;
  console.log(
    `  ${label.padEnd(32)}  ${width.toFixed(3).padStart(11)}`
    + `  ${(width / pct(0.9)).toFixed(1).padStart(9)} m`
    + `  ${(width / pct(0.5)).toFixed(1).padStart(7)} m`
    + `  ${(width / pct(0.1)).toFixed(1).padStart(8)} m`,
  );
}

console.log(
  `\nReading: the metre columns are how far you must WALK for the material to`
  + ` change over, on steep / median / flat ground. Anything of order a few`
  + ` metres seen from 489 m AGL is one pixel — a cut line, not an ecotone.`,
);
