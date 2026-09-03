/**
 * Is canopy closure semantically alive before we gate ForestFloor on it?
 *
 * The proposed defect-4 fix makes ForestFloor's suitability scale toward zero
 * as closure -> 0, because litter exists BECAUSE of canopy. That is only safe
 * if closure actually reads high under real forest. `D-18` is the precedent
 * for why this must be measured rather than assumed: a seed mismatch made
 * measured closure read **0.008 against 0.90 standing**, i.e. a channel
 * structurally present and semantically empty. Gating on such a channel would
 * replace a camo defect with a bare-forest defect.
 *
 * This measures closure over real terrain, then SIMULATES the gated law and
 * reports the material histogram before and after — so the blast radius is
 * known before the law is touched.
 *
 * SCOPE LIMIT, stated up front: this exercises the **CPU** density field and
 * the **CPU** classifier. The shipping splat bake runs the WGSL twins, and
 * D-18's failure was in the WGSL path's seed plumbing specifically. This can
 * prove the LAW is sound; it cannot prove the BAKE feeds it correctly. That
 * needs a render.
 *
 *   npx tsx scripts/closure-distribution.mts
 */
import { canopyClosure, densityField } from "../src/render/webgpu/detail/densityField";
import {
  landCoverSuitabilities,
  LAND_COVER_CANOPY_CLOSURE_GAIN,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import { SURFACE_MATERIALS, SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { createWorld, sampleTerrain } from "../src/world";

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const ax = world.airport?.centerX ?? 0;
const az = world.airport?.centerZ ?? 0;
const DAY = 171;
const nameOf = (id: number) => SURFACE_MATERIALS[id]?.name ?? `#${id}`;

interface Probe {
  readonly stems: number;
  readonly closure: number;
  readonly slope: number;
  readonly moisture: number;
  readonly elevation: number;
}

const probes: Probe[] = [];
for (let dz = -14_000; dz <= 14_000; dz += 200) {
  for (let dx = -14_000; dx <= 14_000; dx += 200) {
    const x = ax + dx;
    const z = az + dz;
    const s = sampleTerrain(world, x, z, undefined, DAY);
    if (s.height < world.seaLevel + 5) continue;
    const f = densityField(world.sourceSeedHash, {
      filterWidthMeters: 0,
      x,
      z,
      heightMeters: s.height,
      seaLevelMeters: world.seaLevel,
      slope: s.slope,
      moisture: s.moisture,
      normalX: s.normal.x,
      normalZ: s.normal.z,
      dayOfYear: DAY,
    });
    probes.push({
      stems: f.treeStemsPerSquareMeter,
      closure: f.canopyClosure,
      slope: s.slope,
      moisture: s.moisture,
      elevation: s.height,
    });
  }
}
console.log(`land probes: ${probes.length}`);

// ---------------------------------------------------------------------------
// 1. Is the channel alive at all?
// ---------------------------------------------------------------------------
const closures = probes.map((p) => p.closure).sort((a, b) => a - b);
const q = (f: number) => closures[Math.floor(f * (closures.length - 1))]!;
const nonZero = closures.filter((c) => c > 0.01).length;
console.log(
  `\n=== closure distribution ===`
  + `\n  p10 ${q(0.1).toFixed(4)}  p50 ${q(0.5).toFixed(4)}  p90 ${q(0.9).toFixed(4)}`
  + `  p99 ${q(0.99).toFixed(4)}  max ${q(1).toFixed(4)}`
  + `\n  fraction above 0.01: ${((nonZero / closures.length) * 100).toFixed(2)}%`,
);

// The decisive check: where trees ARE dense, does closure follow?
const treed = probes.filter((p) => p.stems > 0).sort((a, b) => b.stems - a.stems);
console.log(`\n=== closure where trees stand (${treed.length} treed probes) ===`);
if (treed.length > 0) {
  const topDecile = treed.slice(0, Math.max(1, Math.floor(treed.length * 0.1)));
  const meanOf = (rows: Probe[], pick: (p: Probe) => number) =>
    rows.reduce((s, p) => s + pick(p), 0) / rows.length;
  console.log(
    `  densest decile: mean stems ${meanOf(topDecile, (p) => p.stems).toFixed(4)}/m2`
    + `  ->  mean closure ${meanOf(topDecile, (p) => p.closure).toFixed(4)}`,
  );
  console.log(
    `  all treed:      mean stems ${meanOf(treed, (p) => p.stems).toFixed(4)}/m2`
    + `  ->  mean closure ${meanOf(treed, (p) => p.closure).toFixed(4)}`,
  );
  // The law's own reference point, for comparison.
  console.log(
    `  law reference:  0.08 stems/m2 -> closure ${canopyClosure(0.08).toFixed(4)}`
    + ` (docblock says 0.945)`,
  );
}

// ---------------------------------------------------------------------------
// 2. Simulate the gate, and report the blast radius.
//
// Gate rather than gain: replace (1 + closure*GAIN) with a factor that goes to
// ~0 with closure. Modelled here as `closure` itself scaled so a CLOSED canopy
// keeps today's value — i.e. no retune of the 1.1 base is implied.
// ---------------------------------------------------------------------------
const CLOSED = 1 + LAND_COVER_CANOPY_CLOSURE_GAIN; // today's factor at closure 1

function dominantWith2(p: Probe, gateFn: (c: number) => number): number {
  const input: LandCoverInput = {
    elevationMeters: p.elevation,
    slope: p.slope,
    moisture: p.moisture,
    temperature: 0.5,
    aspect: 0,
    airportInfluence: 0,
    dayOfYear: DAY,
    seasonalTemperatureShift: 0,
    canopyClosure: p.closure,
  };
  const suit = [...landCoverSuitabilities(input)];
  const today = 1 + p.closure * LAND_COVER_CANOPY_CLOSURE_GAIN;
  const gatedFactor = gateFn(p.closure);
  suit[SurfaceMaterial.ForestFloor] = suit[SurfaceMaterial.ForestFloor]!
    * (gatedFactor / Math.max(today, 1e-6));
  let best = 0;
  for (let i = 1; i < suit.length; i += 1) if (suit[i]! > suit[best]!) best = i;
  return best;
}

const GATES: ReadonlyArray<readonly [string, (c: number) => number]> = [
  ["today (gain)", (c) => 1 + c * LAND_COVER_CANOPY_CLOSURE_GAIN],
  ["linear gate", (c) => c * CLOSED],
  ["soft gate 0.15 floor", (c) => (0.15 + 0.85 * c) * CLOSED],
  ["smoothstep(0.15,0.65)", (c) => {
    const t = Math.min(1, Math.max(0, (c - 0.15) / 0.5));
    return t * t * (3 - 2 * t) * CLOSED;
  }],
];
for (const [gateName, gateFn] of GATES) {
  const counts = new Map<number, number>();
  for (const p of probes) {
    const id = dominantWith2(p, gateFn);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n=== dominant material, ${gateName} ===`);
  for (const [id, n] of rows) {
    console.log(
      `  ${nameOf(id).padEnd(13)} ${((n / probes.length) * 100).toFixed(2).padStart(6)}%`,
    );
  }
}

console.log(
  `\nRead the two histograms together. If gating moves ForestFloor's share to`
  + ` roughly the treed fraction of the world and Grass takes the remainder,`
  + ` the gate is doing what it should. If ForestFloor collapses toward zero`
  + ` EVERYWHERE, closure is semantically empty and the gate must not land.`,
);
