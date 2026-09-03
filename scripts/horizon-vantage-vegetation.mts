/**
 * Is there actually vegetation where the horizon shot needs it?
 *
 * `6-11`'s far-field horizon term is evidenced only by IMPOSTOR trees standing
 * on horizon-shadowed ground in the 1,400-3,000 m annulus. A vantage with
 * perfect horizon geometry and no trees at the far end evidences nothing, and
 * SWE II's ray march found the candidate sites read alpine at 1,800-3,000 m —
 * exactly where the evidence has to come from.
 *
 * This closes that, CPU-only, before a capture slot is spent on it.
 *
 * SEED NOTE, and it is the trap D-18 fell into: vegetation keys on
 * `world.sourceSeedHash`, NOT `world.seedHash` (the terrain-region hash that
 * the guaranteed-airport search replaces). `FlightRenderer.ts:789` passes
 * `sourceSeedHash` into the detail scatter. Using the wrong one here would
 * report a different world's forest.
 *
 *   npx tsx scripts/horizon-vantage-vegetation.mts
 */
import { createWorld, sampleTerrain } from "../src/world";
import { densityField } from "../src/render/webgpu/detail/densityField";

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const airportX = world.airport?.centerX ?? 0;
const airportZ = world.airport?.centerZ ?? 0;
const DAY_OF_YEAR = 171;

/** Closed forest is 0.03-0.08 stems/m^2, per the field's own docblock. */
const CLOSED_FOREST_STEMS = 0.03;

interface Site {
  readonly label: string;
  readonly camOffsetX: number;
  readonly camOffsetZ: number;
  /** Ground-track bearing toward the sun, radians, atan2(z, x). */
  readonly sunAzimuth: number;
}

// Sun ground azimuth at 18.2 h, day 171, 45N — from horizon-vantage-search.
const SUN_AZIMUTH_18_2H = (161.0 * Math.PI) / 180;

const SITES: readonly Site[] = [
  { label: "site 1 (SWE II's shot 4)", camOffsetX: -5_420, camOffsetZ: 12_784, sunAzimuth: SUN_AZIMUTH_18_2H },
  { label: "site 2 (18000, 3750)", camOffsetX: 20_080, camOffsetZ: 3_034, sunAzimuth: SUN_AZIMUTH_18_2H },
  { label: "site 3 (9750, 4500)", camOffsetX: 11_830, camOffsetZ: 3_784, sunAzimuth: SUN_AZIMUTH_18_2H },
];

const RANGES = [1_400, 1_800, 2_200, 2_600, 3_000];

function densityAt(x: number, z: number) {
  const sample = sampleTerrain(world, x, z, undefined, DAY_OF_YEAR);
  const field = densityField(world.sourceSeedHash, {
    filterWidthMeters: 0,
    x,
    z,
    heightMeters: sample.height,
    seaLevelMeters: world.seaLevel,
    slope: sample.slope,
    moisture: sample.moisture,
    normalX: sample.normal.x,
    normalZ: sample.normal.z,
    dayOfYear: DAY_OF_YEAR,
  });
  return { sample, field };
}

for (const site of SITES) {
  const camX = airportX + site.camOffsetX;
  const camZ = airportZ + site.camOffsetZ;
  console.log(`\n=== ${site.label}  camera offset (${site.camOffsetX}, ${site.camOffsetZ}) ===`);
  console.log(
    "  range   ground   biome        moisture  treeStems/m2   heightFactor  verdict",
  );
  for (const range of RANGES) {
    const x = camX + Math.cos(site.sunAzimuth) * range;
    const z = camZ + Math.sin(site.sunAzimuth) * range;
    const { sample, field } = densityAt(x, z);
    const stems = field.treeStemsPerSquareMeter;
    // What matters is not "some vegetation" but enough CANOPY to read as
    // impostor trees at 2 km. Krummholz at heightFactor 0.12 is a shrub.
    const verdict = stems <= 0 ? "NO TREES"
      : stems < CLOSED_FOREST_STEMS * 0.25 ? "sparse"
      : field.heightFactor < 0.4 ? "krummholz/stunted"
      : "IMPOSTOR-CAPABLE";
    console.log(
      `  ${String(range).padStart(5)}   ${sample.height.toFixed(0).padStart(5)} m`
      + `   ${String(sample.biome).padEnd(11)}  ${sample.moisture.toFixed(3).padStart(6)}`
      + `   ${stems.toFixed(5).padStart(9)}      ${field.heightFactor.toFixed(3).padStart(6)}`
      + `      ${verdict}`,
    );
  }
}

console.log(
  `\nWorld: seed "phase1-perf-baseline", sourceSeedHash ${world.sourceSeedHash},`
  + ` terrain seedHash ${world.seedHash} (deliberately different — see the seed note).`
  + `\nReference: closed forest is 0.03-0.08 stems/m^2; heightFactor 1 is closed`
  + ` forest and ~0.12 is krummholz at the treeline.`,
);
