/**
 * Measure the ecological field's crown-radius distribution.
 *
 * `WorldDetailRuntime.ts:495` claims "measured mean crown radius 3.40 m,
 * median 3.15 m, **p90 1.78 m**". **A 90th percentile cannot be below the
 * median**, so the three numbers cannot describe one sample and the docblock
 * has been carrying an impossible statistic under a live decision — the
 * rendered-share thinning that ranks by crown radius.
 *
 * The conclusion the paragraph draws ("mostly saplings, as a real stand is")
 * is probably right, which is exactly why relabelling `p90` to `p10` on
 * reasoning alone would be wrong: it would substitute one inference for
 * another and leave the claim in the same unverifiable category. So this
 * measures it, through the SHIPPING generator (`generateDetailCell`), with no
 * source change at all.
 *
 * It also checks the paragraph's SECOND measured claim — that ranking by
 * radius draws "the 70/ha widest crowns (measured mean radius 5.80 m)".
 */
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type { DetailTerrainSampler } from "../src/render/webgpu/detail/types";
import { TerrainBiome } from "../src/world/types";

/** Closed forest. Moisture is swept below to find the ~400 stems/ha the claim
 * describes, rather than assuming the test fixture's 0.56 reproduces it. */
const forestAt = (moisture: number): DetailTerrainSampler => (x, z) => ({
  height: 120 + Math.sin(x * 0.002) * 3 + Math.cos(z * 0.0025) * 2,
  slope: 0.06,
  moisture,
  biome: TerrainBiome.FOREST,
});

const CELL = 256;
const CELLS = Number(process.argv[3] ?? 8);
const MOISTURE = Number(process.argv[2] ?? 0.56);
const DENSITY = Number(process.argv[4] ?? 1);
const forest = forestAt(MOISTURE);
const radii: number[] = [];
let areaHectares = 0;

for (let cx = 0; cx < CELLS; cx += 1) {
  for (let cz = 0; cz < CELLS; cz += 1) {
    const cell = generateDetailCell({
      worldSeed: "phase1-perf-baseline",
      cellX: cx,
      cellZ: cz,
      terrainSample: forest,
      cellSizeMeters: CELL,
      densityMultiplier: DENSITY,
    });
    areaHectares += (CELL * CELL) / 10_000;
    for (const tree of cell.trees) radii.push(tree.crownRadiusMeters);
  }
}

radii.sort((a, b) => a - b);
const q = (f: number) => radii[Math.min(radii.length - 1, Math.floor(f * radii.length))]!;
const mean = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(xs.length, 1);

console.log(`${radii.length} trees over ${areaHectares.toFixed(1)} ha `
  + `= ${(radii.length / areaHectares).toFixed(1)} stems/ha\n`);
console.log("CLAIMED: mean 3.40  median 3.15  p90 1.78");
console.log(`MEASURED: mean ${mean(radii).toFixed(2)}  median ${q(0.5).toFixed(2)}`
  + `  p90 ${q(0.9).toFixed(2)}`);
console.log(`  full quantiles  p10 ${q(0.1).toFixed(2)}  p25 ${q(0.25).toFixed(2)}`
  + `  p50 ${q(0.5).toFixed(2)}  p75 ${q(0.75).toFixed(2)}`
  + `  p90 ${q(0.9).toFixed(2)}  max ${radii[radii.length - 1]!.toFixed(2)}`);

// The paragraph's SECOND claim: the widest 70/ha.
const wanted = Math.round(70 * areaHectares);
const widest = radii.slice(-wanted);
console.log(`\nCLAIMED for the widest 70/ha: mean radius 5.80`);
console.log(`MEASURED (top ${wanted} of ${radii.length}): mean ${mean(widest).toFixed(2)}`
  + `  min ${widest[0]!.toFixed(2)}  max ${widest[widest.length - 1]!.toFixed(2)}`);
// Crown cover of the drawn stand: sum of crown discs over the area, which is
// what Gate 2C's 0.55 criterion is about. Overlap is not subtracted, matching
// the "cover 0.53-0.56" figure's own convention.
const cover = widest.reduce((s, r) => s + Math.PI * r * r, 0) / (areaHectares * 10_000);
console.log(`  crown cover ${cover.toFixed(3)}  (claimed 0.53-0.56, Gate 2C wants 0.55)`);
