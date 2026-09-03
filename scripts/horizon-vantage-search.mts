/**
 * Find capture vantages where the far-field horizon term actually fires —
 * over ground that actually has trees.
 *
 * `6-11` gave far vegetation the horizon-shadow term terrain already had, but
 * the A/B pin moved no pixels, which is equally consistent with "correctly
 * inert on this shot set" and "no shot frames the geometry". This searches for
 * the geometry so a shot can be authored from evidence.
 *
 * THE CORRECTION THIS FILE EXISTS FOR: the first version of this search scored
 * vantages on horizon margin ALONE and produced three sites with excellent
 * occlusion and effectively no vegetation along the sun ray — evidencing
 * nothing, because the claim is about far VEGETATION receiving the term. A
 * shadowed bare hillside proves only what `4-7` already shipped for terrain.
 * The gate is now a conjunction: the target must be horizon-occluded AND carry
 * impostor-capable canopy, sampled across the whole annulus rather than at one
 * point.
 *
 * CPU-only and Node-only by design: the reference host is thermally exhausted
 * and `perf:capture` / `test:gpu` are barred.
 *
 * SEED NOTE (the trap D-18 fell into): vegetation keys on
 * `world.sourceSeedHash`, NOT `world.seedHash`, which the guaranteed-airport
 * search replaces. `FlightRenderer.ts:789` passes `sourceSeedHash` to the
 * detail scatter. Terrain height uses `seedHash` via `sampleTerrain`.
 *
 *   npx tsx scripts/horizon-vantage-search.mts
 */
import { createWorld, sampleTerrain, sampleTerrainHeight } from "../src/world";
import { densityField } from "../src/render/webgpu/detail/densityField";
import {
  HORIZON_FIELD_AZIMUTHS_MARCHED,
  HORIZON_FIELD_AZIMUTHS_STORED,
  HORIZON_FIELD_MARCH_STEPS,
} from "../src/render/webgpu/terrain/HorizonField";
import { solarPosition } from "../src/render/webgpu/nature/EnvironmentDirector";

const PERF_CAPTURE_SEED = "phase1-perf-baseline";
/** The global field's own texel, and therefore the march's first step. */
const HEIGHT_TEXEL_METERS = 512;
const REACH_METERS = 45_000;
const LATITUDE_DEGREES = 45;
const DAY_OF_YEAR = 171;

/** Closed forest is 0.03-0.08 stems/m^2, per the density field's own docblock. */
const IMPOSTOR_CAPABLE_STEMS = 0.0075;
/** Below this the stand is krummholz, not a tree an impostor can represent. */
const IMPOSTOR_CAPABLE_HEIGHT_FACTOR = 0.4;

/** Tier 1: cascades end at shadowDistance, impostors end at vegetationDistance. */
const ANNULUS_INNER_METERS = 1_400;
const ANNULUS_OUTER_METERS = 3_000;
const ANNULUS_SAMPLES = [1_500, 1_800, 2_100, 2_400, 2_700, 2_900];

const world = createWorld(PERF_CAPTURE_SEED, { worldEvolution: "analytic" });
const airportX = world.airport?.centerX ?? 0;
const airportZ = world.airport?.centerZ ?? 0;

const growth = Math.pow(
  REACH_METERS / HEIGHT_TEXEL_METERS,
  1 / (HORIZON_FIELD_MARCH_STEPS - 1),
);

/**
 * The height the PYRAMID would hold, not the height the terrain has.
 *
 * The shipped field marches a 256² pyramid at 512 m/texel, band-limited at its
 * own texel size, so it cannot see a cliff narrower than half a kilometre.
 * Point-sampling finds exactly those cliffs and ranks the sites where the two
 * disagree most to the top. Snap to the lattice and box-filter one texel.
 */
const FILTER_TAPS = 3;
function pyramidHeight(worldX: number, worldZ: number): number {
  const snappedX = Math.round(worldX / HEIGHT_TEXEL_METERS) * HEIGHT_TEXEL_METERS;
  const snappedZ = Math.round(worldZ / HEIGHT_TEXEL_METERS) * HEIGHT_TEXEL_METERS;
  const spacing = HEIGHT_TEXEL_METERS / FILTER_TAPS;
  let sum = 0;
  for (let iz = 0; iz < FILTER_TAPS; iz += 1) {
    for (let ix = 0; ix < FILTER_TAPS; ix += 1) {
      sum += sampleTerrainHeight(
        world,
        snappedX + (ix - (FILTER_TAPS - 1) / 2) * spacing,
        snappedZ + (iz - (FILTER_TAPS - 1) / 2) * spacing,
      );
    }
  }
  return sum / (FILTER_TAPS * FILTER_TAPS);
}

/** The shared operator's march — sin(horizon elevation) per stored azimuth. */
function horizonAt(worldX: number, worldZ: number): number[] {
  const centre = pyramidHeight(worldX, worldZ);
  const slopes: number[] = [];
  for (let azimuth = 0; azimuth < HORIZON_FIELD_AZIMUTHS_MARCHED; azimuth += 1) {
    const angle = (azimuth + 0.5) * ((Math.PI * 2) / HORIZON_FIELD_AZIMUTHS_MARCHED);
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    let maxSlope = 0;
    let radius = HEIGHT_TEXEL_METERS;
    for (let step = 0; step < HORIZON_FIELD_MARCH_STEPS; step += 1) {
      const h = pyramidHeight(worldX + dirX * radius, worldZ + dirZ * radius);
      maxSlope = Math.max(maxSlope, (h - centre) / radius);
      radius *= growth;
    }
    slopes.push(maxSlope);
  }
  const stored: number[] = [];
  for (let i = 0; i < HORIZON_FIELD_AZIMUTHS_STORED; i += 1) {
    const s = Math.max(slopes[i * 2]!, slopes[i * 2 + 1]!);
    stored.push(s / Math.sqrt(1 + s * s));
  }
  return stored;
}

/** The consumer's azimuth lookup: sun direction -> interpolated horizon sin. */
function horizonTowardSun(stored: number[], sunAzimuthRadians: number): number {
  const index = sunAzimuthRadians * (4 / Math.PI) - 0.5;
  const wrapped = index - Math.floor(index * 0.125) * 8;
  const low = Math.floor(wrapped);
  const blend = wrapped - low;
  const a = stored[low % 8]!;
  const b = stored[(low + 1) % 8]!;
  return a + (b - a) * blend;
}

/** Canopy an impostor could represent, at a world point. */
function canopyAt(x: number, z: number): { stems: number; capable: boolean; height: number } {
  const s = sampleTerrain(world, x, z, undefined, DAY_OF_YEAR);
  if (s.height < world.seaLevel + 10) return { stems: 0, capable: false, height: s.height };
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
    dayOfYear: DAY_OF_YEAR,
  });
  return {
    stems: f.treeStemsPerSquareMeter,
    capable: f.treeStemsPerSquareMeter >= IMPOSTOR_CAPABLE_STEMS
      && f.heightFactor >= IMPOSTOR_CAPABLE_HEIGHT_FACTOR,
    height: s.height,
  };
}

function sunFor(dayOfYear: number, solarTimeHours: number) {
  const p = solarPosition({ dayOfYear, solarTimeHours } as never, LATITUDE_DEGREES);
  const east = Math.sin(p.azimuthRadians);
  const north = Math.cos(p.azimuthRadians);
  return {
    sinElevation: Math.sin(p.elevationRadians),
    groundAzimuth: Math.atan2(north, east),
  };
}

interface Vantage {
  readonly camX: number;
  readonly camZ: number;
  readonly camGround: number;
  /** Annulus samples that are BOTH horizon-shadowed and impostor-capable. */
  readonly evidence: number;
  /** Annulus samples that are impostor-capable and LIT — the contrast. */
  readonly contrast: number;
  readonly treed: number;
  readonly detail: string;
}

const CLOCKS: ReadonlyArray<readonly [string, number, number]> = [
  ["18.5h", 171, 18.5],
  ["18.2h", 171, 18.2],
  ["17.8h", 171, 17.8],
];

const SEARCH_RADIUS_METERS = 22_000;
const STEP_METERS = 500;

for (const [label, dayOfYear, solarTimeHours] of CLOCKS) {
  const sun = sunFor(dayOfYear, solarTimeHours);
  const vantages: Vantage[] = [];
  for (let dz = -SEARCH_RADIUS_METERS; dz <= SEARCH_RADIUS_METERS; dz += STEP_METERS) {
    for (let dx = -SEARCH_RADIUS_METERS; dx <= SEARCH_RADIUS_METERS; dx += STEP_METERS) {
      const camX = airportX + dx;
      const camZ = airportZ + dz;
      const camGround = sampleTerrainHeight(world, camX, camZ);
      if (camGround < world.seaLevel + 30) continue;

      // Walk the annulus along the sun bearing and score the CONJUNCTION.
      let evidence = 0;
      let contrast = 0;
      let treed = 0;
      const parts: string[] = [];
      for (const range of ANNULUS_SAMPLES) {
        const x = camX + Math.cos(sun.groundAzimuth) * range;
        const z = camZ + Math.sin(sun.groundAzimuth) * range;
        const canopy = canopyAt(x, z);
        if (!canopy.capable) continue;
        treed += 1;
        const horizonSin = horizonTowardSun(horizonAt(x, z), sun.groundAzimuth);
        if (horizonSin > sun.sinElevation) {
          evidence += 1;
          parts.push(`${range}m SHADOWED(${canopy.stems.toFixed(3)})`);
        } else {
          contrast += 1;
          parts.push(`${range}m lit(${canopy.stems.toFixed(3)})`);
        }
      }
      // Evidence needs BOTH: shadowed canopy to show the term, and lit canopy
      // in the same frame so a uniformly dark result cannot pass for it.
      if (evidence >= 2 && contrast >= 1) {
        vantages.push({ camX, camZ, camGround, evidence, contrast, treed, detail: parts.join(" ") });
      }
    }
  }
  vantages.sort((a, b) => (b.evidence + b.contrast) - (a.evidence + a.contrast)
    || b.evidence - a.evidence);
  console.log(
    `\n=== ${label}  sunSin=${sun.sinElevation.toFixed(4)}`
    + ` (${((Math.asin(sun.sinElevation) * 180) / Math.PI).toFixed(2)} deg)`
    + `  bearing ${((sun.groundAzimuth * 180) / Math.PI).toFixed(1)} deg ===`,
  );
  console.log(`  vantages with >=2 shadowed AND >=1 lit canopy sample: ${vantages.length}`);
  for (const v of vantages.slice(0, 4)) {
    console.log(
      `  CAMERA offsetXMeters ${(v.camX - airportX).toFixed(0)},`
      + ` offsetZMeters ${(v.camZ - airportZ).toFixed(0)}  ground ${v.camGround.toFixed(0)} m`
      + `  [${v.evidence} shadowed / ${v.contrast} lit of ${v.treed} treed]`
      + `\n     ${v.detail}`,
    );
  }
}

console.log(
  `\nAirport centre (${airportX.toFixed(0)}, ${airportZ.toFixed(0)}), sea level ${world.seaLevel} m.`
  + `\nGate: canopy >= ${IMPOSTOR_CAPABLE_STEMS} stems/m^2 AND heightFactor >= ${IMPOSTOR_CAPABLE_HEIGHT_FACTOR}`
  + ` (closed forest is 0.03-0.08; ~0.12 heightFactor is krummholz).`
  + `\nAnnulus ${ANNULUS_INNER_METERS}-${ANNULUS_OUTER_METERS} m is tier 1's`
  + ` shadowDistance..vegetationDistance — the only band this term can act in.`,
);
