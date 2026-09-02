import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TerrainBiome,
  createWorld,
  hashSeed,
  sampleTerrain,
  sampleTerrainEvolutionGeology,
  type TerrainBiomeId,
} from "../src/world";
import {
  terrainSlopeAngleFromNormalizedSteepness,
  terrainSoilDepthMeters,
  terrainTopographicWetnessIndex,
} from "../src/render/webgpu/terrain/TerrainPageHydrology";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  TALUS_APEX_BLOCK_RADIUS_METERS,
  TALUS_NO_SUPPLY,
  TALUS_RUNOUT_FAR_METERS,
  TALUS_SOIL_BARE_METERS,
  TALUS_SOIL_BURIED_METERS,
  TALUS_TOE_BLOCK_RADIUS_METERS,
  talusBlockiness,
  talusFailureFraction,
  talusPlacement,
  talusReposeSteepness,
  talusRestWeight,
} from "../src/render/webgpu/detail/talusField";
import type { DetailTerrainSample, DetailTerrainSampler } from "../src/render/webgpu/detail/types";
import { readSource } from "./support/sourceText";

/**
 * `6-7` — talus and scree PLACEMENT.
 *
 * `2-15` shipped the rock instancing, the per-lithology prototypes, the
 * normal-aligned orientation, the sink and the slope-shedding snow. What it
 * did not ship was a reason for a rock to be anywhere: a biome table plus
 * `slope · 0.35`, which put its DENSEST loose-block population on the
 * steepest faces in the world — the one place a loose block cannot stay.
 *
 * These tests hold three claims:
 *
 *  1. **The law is a redistribution, not an addition.** Over-repose faces
 *     shed; the apron below gains. Every measured window's net rock count
 *     FALLS, and the mid-band (mid-range-drawn boulder) population falls
 *     hardest, so nothing about this item pushes on a draw ceiling.
 *  2. **Analytic movement is intended, bounded and MEASURED.** Where the law
 *     is inert — flat ground with no failure face above it — an analytic
 *     world is byte-identical to the pre-6-7 tree. Where it is live, the
 *     movement is pinned as a number measured against that tree, not
 *     asserted.
 *  3. **The eroded channel refines a law that already runs.** `5-5`'s soil
 *     depth is a factor, not the gate: slope and lithology exist in both
 *     worlds, so an analytic world grows real scree and a provisioned world
 *     grows slightly less of it in its wet convergent hollows.
 */

const WORLD = createWorld("talus-6-7");
const SEED_HASH = hashSeed(WORLD.seed);
const REFERENCE_REPOSE_DEGREES = 34;

// ---------------------------------------------------------------------------
// The law, on fixtures
// ---------------------------------------------------------------------------

function supply(failureReliefMeters: number, travelMeters: number) {
  return { failureReliefMeters, travelMeters };
}

function placement(
  slope: number,
  overrides: {
    reposeDegrees?: number;
    soilDepthMeters?: number;
    relief?: number;
    travel?: number;
    aboveSnowline?: number;
  } = {},
) {
  return talusPlacement({
    slope,
    reposeDegrees: overrides.reposeDegrees ?? REFERENCE_REPOSE_DEGREES,
    soilDepthMeters: overrides.soilDepthMeters ?? 0.3,
    probe: supply(overrides.relief ?? 45, overrides.travel ?? 30),
    metersAbovePermanentSnowline: overrides.aboveSnowline ?? -800,
  });
}

describe("6-7 talus placement law", () => {
  it("rests debris at or under repose and sweeps the failure face", () => {
    const repose = talusReposeSteepness(REFERENCE_REPOSE_DEGREES);
    // The physical statement, as three points on one curve.
    expect(placement(0.004).density, "valley floor").toBe(0);
    expect(placement(repose * 0.9).density, "apron at repose").toBeGreaterThan(0.5);
    expect(placement(repose + 0.12).density, "developed failure face").toBe(0);
    // And the shed the lag population reads is the same curve, once.
    expect(talusFailureFraction(repose - 0.01, REFERENCE_REPOSE_DEGREES)).toBe(0);
    expect(talusFailureFraction(repose + 0.12, REFERENCE_REPOSE_DEGREES)).toBe(1);
    expect(talusRestWeight(repose + 0.12, REFERENCE_REPOSE_DEGREES)).toBe(0);
  });

  it("needs a failure face above it and thins with travel from that face", () => {
    // No cliff, no cone: the same slope with nothing above it carries nothing.
    expect(talusPlacement({
      slope: 0.15,
      reposeDegrees: REFERENCE_REPOSE_DEGREES,
      soilDepthMeters: 0.3,
      probe: TALUS_NO_SUPPLY,
      metersAbovePermanentSnowline: -800,
    }).density).toBe(0);
    const crag = placement(0.15, { relief: 8 }).density;
    const wall = placement(0.15, { relief: 45 }).density;
    expect(crag).toBeGreaterThan(0);
    expect(wall).toBeGreaterThan(crag * 3);
    // Runout: the apex is dense, the distal apron faint.
    const apex = placement(0.15, { travel: 25 }).density;
    const distal = placement(0.15, { travel: 100 }).density;
    expect(apex).toBeGreaterThan(distal * 4);
  });

  it("coarsens DOWNSLOPE — fall sorting, stated and pinned", () => {
    // The chosen model, recorded so it cannot drift into its opposite: block
    // momentum scales with mass, so large clasts bounce and roll past the
    // apex while chips arrest in the first metres. The apron therefore fines
    // UPSLOPE toward the source, which is the observed sorting of rockfall
    // talus and the opposite of a water-laid deposit's.
    const apex = placement(0.15, { travel: 0 }).grainRadiusMeters;
    const mid = placement(0.15, { travel: TALUS_RUNOUT_FAR_METERS * 0.5 }).grainRadiusMeters;
    const toe = placement(0.15, { travel: TALUS_RUNOUT_FAR_METERS }).grainRadiusMeters;
    expect(apex).toBeLessThan(mid);
    expect(mid).toBeLessThan(toe);
    expect(toe / apex).toBeGreaterThan(4);
    // Bounded by the law's own endpoints times the lithology scale.
    expect(apex).toBeGreaterThanOrEqual(TALUS_APEX_BLOCK_RADIUS_METERS * 0.7);
    expect(toe).toBeLessThanOrEqual(TALUS_TOE_BLOCK_RADIUS_METERS * 1.3);
    // Density and grain read the SAME travel number: the toe is both sparser
    // and coarser, which is one statement about a cone, not two knobs.
    expect(placement(0.15, { travel: 100 }).density)
      .toBeLessThan(placement(0.15, { travel: 25 }).density);
  });

  it("modulates density AND block size with lithology, through repose alone", () => {
    // Hard, massive rock stands steeper and breaks blockier; weak rock stands
    // shallower and weathers to chips that belong to the ground layer.
    const soft = talusPlacement({
      slope: talusReposeSteepness(28) * 0.9,
      reposeDegrees: 28,
      soilDepthMeters: 0.3,
      probe: supply(45, 30),
      metersAbovePermanentSnowline: -800,
    });
    const hard = talusPlacement({
      slope: talusReposeSteepness(42) * 0.9,
      reposeDegrees: 42,
      soilDepthMeters: 0.3,
      probe: supply(45, 30),
      metersAbovePermanentSnowline: -800,
    });
    expect(hard.density).toBeGreaterThan(soft.density * 1.8);
    expect(hard.grainRadiusMeters).toBeGreaterThan(soft.grainRadiusMeters * 1.4);
    expect(talusBlockiness(28)).toBe(0);
    expect(talusBlockiness(42)).toBe(1);
    // Repose is a real angle, so a harder rock's apron also extends to
    // steeper ground: the resting band moves with the lithology.
    expect(talusRestWeight(talusReposeSteepness(38), 42)).toBeGreaterThan(0.5);
    expect(talusRestWeight(talusReposeSteepness(38), 28)).toBe(0);
  });

  it("buries the apron under deep soil, on the measured window", () => {
    // Measured 2026-08-31 over 5,546 apron-capable sites across five 4x4 km
    // windows: analytic-fallback soil p5 0.27 / p50 0.62 / p95 1.62 m, eroded
    // fixture p5 0.32 / p50 0.79 / p95 2.16 m. The window brackets both.
    const bare = placement(0.15, { soilDepthMeters: TALUS_SOIL_BARE_METERS }).density;
    const median = placement(0.15, { soilDepthMeters: 0.79 }).density;
    const buried = placement(0.15, { soilDepthMeters: TALUS_SOIL_BURIED_METERS }).density;
    expect(bare).toBeGreaterThan(0);
    expect(median).toBeLessThan(bare);
    expect(median).toBeGreaterThan(bare * 0.5);
    expect(buried).toBe(0);
    // Monotone, so a deeper soil never grows more scree.
    let previous = Infinity;
    for (let soil = 0; soil <= 3; soil += 0.1) {
      const density = placement(0.15, { soilDepthMeters: soil }).density;
      expect(density).toBeLessThanOrEqual(previous + 1e-12);
      previous = density;
    }
  });

  it("takes the apron off permanent snow and ice", () => {
    expect(placement(0.15, { aboveSnowline: -10 }).density).toBeGreaterThan(0);
    expect(placement(0.15, { aboveSnowline: 150 }).density)
      .toBeLessThan(placement(0.15, { aboveSnowline: -10 }).density);
    expect(placement(0.15, { aboveSnowline: 400 }).density).toBe(0);
  });

  it("rejects impossible inputs instead of silently producing a field", () => {
    expect(() => talusReposeSteepness(0)).toThrow(RangeError);
    expect(() => talusReposeSteepness(90)).toThrow(RangeError);
    expect(() => talusFailureFraction(1.4, 34)).toThrow(RangeError);
    expect(() => placement(0.15, { soilDepthMeters: -1 })).toThrow(RangeError);
    expect(() => placement(0.15, { relief: Number.NaN })).toThrow(RangeError);
    expect(() => placement(0.15, { aboveSnowline: Number.POSITIVE_INFINITY }))
      .toThrow(RangeError);
  });

  it("keeps the house traps out of the new sources", () => {
    // Two traps, both of which have cost this project a wave. A reversed
    // `smoothstep(high, low, x)` turns a ramp into a hard step in the
    // complement of the edge it reads as; a `sin`/`fract` hash collapses into
    // rows once world-anchored ids get large.
    const sources = ["src/render/webgpu/detail/talusField.ts"].map((path) =>
      readSource(join(__dirname, "..", path))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, ""));
    for (const code of sources) {
      const reversed: string[] = [];
      for (const match of code.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,/g)) {
        if (Number(match[2]!) <= Number(match[1]!)) reversed.push(match[0]);
      }
      expect(reversed, `reversed smoothstep call sites: ${reversed.join(", ")}`).toEqual([]);
      expect(code).not.toMatch(/fract\s*\(\s*sin\s*\(/);
      expect(code.match(/smoothstep\(/g)?.length ?? 0).toBeGreaterThan(5);
    }
    // The computed pairs the scan cannot see are all `x` vs `x + positive`
    // or `repose * 0.12` vs `repose * 0.55`; exercise them across the whole
    // published repose range so a sign error cannot hide.
    for (let degrees = 28; degrees <= 42; degrees += 0.5) {
      for (let slope = 0; slope <= 0.999; slope += 0.01) {
        const rest = talusRestWeight(slope, degrees);
        expect(rest).toBeGreaterThanOrEqual(0);
        expect(rest).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Placement, in generation
// ---------------------------------------------------------------------------

/**
 * Two windows in the shipping analytic world, chosen once by a slope scan
 * over ±20 km and pinned with their character asserted below, so a kernel
 * retune cannot quietly turn "the mountain window" into a meadow.
 */
const MOUNTAIN_CELLS = [[-12, -32], [-11, -32], [-12, -31], [-11, -31]] as const;
const FLAT_CELLS = [[12, 4], [13, 4], [12, 5], [13, 5]] as const;
/** ~926 km from the origin: the world-scale determinism site. */
const FAR_CELLS = [[1_801, 171], [1_802, 171]] as const;

function fixtureHash(x: number, z: number): number {
  let hash = Math.imul(Math.round(x * 7.31) ^ 0x9e3779b9, 0x85ebca6b);
  hash ^= Math.imul(Math.round(z * 5.17) ^ 0x165667b1, 0xc2b2ae35);
  hash ^= hash >>> 15;
  return ((hash >>> 0) % 100_000) / 100_000;
}

/**
 * The world sampler, optionally carrying `5-5`'s channel. Soil comes from the
 * OWNED producer rather than an invented ramp, and its contributing area is
 * chosen to reproduce W-9's MEASURED eroded TWI window (~13.3 p1 to ~29
 * p99.9) at each slope. A small literal area — the shape a first draft of
 * this fixture used — puts every texel below `TERRAIN_TWI_DRY`, makes the
 * wetness term vacuous and would have measured the channel as inert.
 */
function worldSampler(withSoil: boolean): DetailTerrainSampler {
  return (x, z) => {
    const terrain = sampleTerrain(WORLD, x, z);
    const slopeRadians = terrainSlopeAngleFromNormalizedSteepness(
      Math.min(0.98, terrain.slope),
    );
    const twi = 12 + fixtureHash(z, x) * 17;
    const area = (Math.tan(slopeRadians) + 1e-4) * Math.exp(twi);
    return {
      height: terrain.height,
      slope: terrain.slope,
      moisture: terrain.moisture,
      biome: terrain.biome,
      normal: terrain.normal,
      ...(withSoil
        ? {
          soilDepthMeters: terrainSoilDepthMeters(
            slopeRadians,
            (fixtureHash(x, z) - 0.5) * 0.06,
            terrainTopographicWetnessIndex(area, slopeRadians),
          ),
        }
        : {}),
    };
  };
}

const SLOPE_BAND_EDGES = [0.05, 0.12, 0.2, 0.3, 0.5];

function slopeBand(slope: number): number {
  let band = 0;
  while (band < SLOPE_BAND_EDGES.length && slope >= SLOPE_BAND_EDGES[band]!) band += 1;
  return band;
}

interface RockRun {
  readonly rocks: number;
  /** Radius ≥ 2.2 m AND selection ≤ 0.22 — the mid-band-drawn population. */
  readonly midBand: number;
  readonly meanRadius: number;
  readonly bands: readonly number[];
  readonly batchKeys: ReadonlySet<string>;
  readonly perCellMaximum: number;
  readonly digest: string;
}

function rockRun(
  sampler: DetailTerrainSampler,
  cells: readonly (readonly [number, number])[],
  dayOfYear = 171,
): RockRun {
  let rocks = 0;
  let midBand = 0;
  let radiusSum = 0;
  let perCellMaximum = 0;
  const bands = [0, 0, 0, 0, 0, 0];
  const batchKeys = new Set<string>();
  const parts: string[] = [];
  for (const [cellX, cellZ] of cells) {
    const cell = generateDetailCell({
      worldSeed: WORLD.seed,
      cellX,
      cellZ,
      terrainSample: sampler,
      seaLevelMeters: WORLD.seaLevel,
      dayOfYear,
      latitudeDegrees: WORLD.latitudeDegrees,
    });
    rocks += cell.rocks.length;
    perCellMaximum = Math.max(perCellMaximum, cell.rocks.length);
    for (const rock of cell.rocks) {
      if (rock.radiusMeters >= 2.2 && rock.selection <= 0.22) midBand += 1;
      radiusSum += rock.radiusMeters;
      bands[slopeBand(sampler(rock.x, rock.z).slope)]! += 1;
      batchKeys.add(`rock-${rock.variant}`);
    }
    // Scoped to placement — position, sink and size — so the pin is a 6-7
    // instrument and not a tripwire on the seasonal tint lane.
    parts.push(JSON.stringify(cell.rocks.map((rock) => [
      rock.variant,
      rock.x.toFixed(4),
      rock.z.toFixed(4),
      rock.y.toFixed(4),
      rock.radiusMeters.toFixed(5),
    ])));
  }
  let digest = 0x811c9dc5;
  const joined = parts.join("|");
  for (let index = 0; index < joined.length; index += 1) {
    digest ^= joined.charCodeAt(index);
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }
  return {
    rocks,
    midBand,
    meanRadius: rocks ? radiusSum / rocks : 0,
    bands,
    batchKeys,
    perCellMaximum,
    digest: digest.toString(16),
  };
}

const ANALYTIC_SAMPLER = worldSampler(false);
const SOIL_SAMPLER = worldSampler(true);

describe("6-7 scree placement in the world", () => {
  it("stands on the terrain the pins were measured against", () => {
    const character = (cells: readonly (readonly [number, number])[]) => {
      let slope = 0;
      let height = 0;
      let probes = 0;
      for (const [cellX, cellZ] of cells) {
        for (let localZ = 32; localZ < 512; localZ += 64) {
          for (let localX = 32; localX < 512; localX += 64) {
            const terrain = sampleTerrain(WORLD, cellX * 512 + localX, cellZ * 512 + localZ);
            slope += terrain.slope;
            height += terrain.height;
            probes += 1;
          }
        }
      }
      return { slope: slope / probes, height: height / probes };
    };
    const mountain = character(MOUNTAIN_CELLS);
    const flat = character(FLAT_CELLS);
    expect(mountain.slope, "mountain fixture").toBeGreaterThan(0.4);
    expect(mountain.height, "mountain fixture").toBeGreaterThan(400);
    expect(flat.slope, "flat fixture").toBeLessThan(0.02);
    expect(flat.height, "flat fixture").toBeGreaterThan(0);
  });

  it("leaves an analytic world byte-identical where the law is inert", () => {
    // MEASURED, not asserted. A tree with the pre-6-7 `generation.ts`
    // restored (the biome table plus `slope · 0.35`, no talus term, no shed,
    // no grain blend) and every other in-flight change left in place produced
    // digest `92acf64d` over these four cells and 11 rocks; this tree
    // produces `92acf64d` and 11 rocks. Flat ground has no fall line, so the
    // probe returns no supply, the shed term multiplies a ~0 slope term, and
    // every downstream number reduces to its 2-15 expression exactly.
    const flat = rockRun(ANALYTIC_SAMPLER, FLAT_CELLS);
    expect(flat.digest).toBe("92acf64d");
    expect(flat.rocks).toBe(11);
    expect(flat.bands[0]).toBe(11);
    // And the soil channel cannot resurrect it: no fall line, no apron.
    expect(rockRun(SOIL_SAMPLER, FLAT_CELLS).digest).toBe("92acf64d");
  });

  it("redistributes mountain rock from the failure faces onto the apron", () => {
    // Measured against the same reconstructed pre-6-7 tree, over the four
    // mountain cells (mean slope 0.489, relief 1,255 m):
    //
    //   slope band     <0.05  0.05  0.12  0.20  0.30  0.50+   total  mid-band
    //   pre-6-7            0     2     1     9    35     95     142        14
    //   6-7                0     4     5     7    26     72     114         9
    //
    // The apron bands (0.05–0.20, i.e. ~10°–37°) nearly TRIPLE, 3 -> 9, while
    // the over-repose faces lose a quarter of their loose blocks, and the net
    // count falls 19.7%. That is the redistribution, as numbers.
    const run = rockRun(ANALYTIC_SAMPLER, MOUNTAIN_CELLS);
        // RE-PINNED at `6-13` for the SLOPE half: `gentle` is now the exact
    // complement of `steep` rather than a second, independently-drifting
    // window. The old pair left every climatic suitability at ~0 across
    // slope 0.24-0.26 (gentle 0.0086, steep 0.0016), where `Sand`'s
    // constant `+0.02` won by default. Rock's own share is essentially
    // unmoved by the change — 18.77%% -> 18.93%% of land, measured over
    // 13,685 probes — because the partition is anchored on `steep`'s
    // existing window precisely so `Rock = steep * 1.25` keeps the
    // calibration that coefficient was tuned against.
    expect(run.digest).toBe("bcd0d548");
        // `6-13` re-pin: total scree FALLS (`gentle` now reaches further up the
    // slope axis, so grass holds ground that previously went to rock).
    // Down is budget-safe; the +1 mid-band boulder noted above is a
    // redistribution outward, not a net increase.
    expect(run.rocks).toBe(108);   // 6-13: 114 -> 108
    expect(run.rocks, "net count falls vs the pre-6-7 142").toBeLessThan(142);
    expect(run.bands[1]! + run.bands[2]!, "apron bands vs pre-6-7 3").toBeGreaterThan(3 * 2);
    expect(run.bands[5]!, "failure-face band vs pre-6-7 95").toBeLessThan(95 * 0.85);
  });

  it("keeps the eroded soil channel a live refinement of a live law", () => {
    const analytic = rockRun(ANALYTIC_SAMPLER, MOUNTAIN_CELLS);
    const eroded = rockRun(SOIL_SAMPLER, MOUNTAIN_CELLS);
    // Live: the channel changes placements.
    expect(eroded.digest).not.toBe(analytic.digest);
        // RE-PINNED at `6-13` for the SLOPE half: `gentle` is now the exact
    // complement of `steep` rather than a second, independently-drifting
    // window. The old pair left every climatic suitability at ~0 across
    // slope 0.24-0.26 (gentle 0.0086, steep 0.0016), where `Sand`'s
    // constant `+0.02` won by default. Rock's own share is essentially
    // unmoved by the change — 18.77%% -> 18.93%% of land, measured over
    // 13,685 probes — because the partition is anchored on `steep`'s
    // existing window precisely so `Rock = steep * 1.25` keeps the
    // calibration that coefficient was tuned against.
    expect(eroded.digest).toBe("18b9e79d");
    // And it only ever REMOVES scree — deep soil is a stable, vegetated
    // slope. Measured at 113 against the analytic 114 here; the effect is
    // small on purpose, because the soil proxy's own slope-retention term has
    // already collapsed on ground steep enough to hold an apron. Its
    // discriminating power lives in the runout toe.
    expect(eroded.rocks).toBeLessThanOrEqual(analytic.rocks);
        // `6-13` re-pin: total scree FALLS (`gentle` now reaches further up the
    // slope axis, so grass holds ground that previously went to rock).
    // Down is budget-safe; the +1 mid-band boulder noted above is a
    // redistribution outward, not a net increase.
    expect(eroded.rocks).toBe(106);  // 6-13: 113 -> 106
    // The pre-6-7 tree read the channel not at all for rocks: 142 with and
    // without it. That is what "the channel was dark and now is not" means
    // here, and it is the same shape 6-6's evidence took.
    expect(analytic.rocks).not.toBe(142);
  });

  it("places nothing on water or paved ground, however big the cliff above", () => {
    const alpine = rockRun(cliffSampler({ biome: TerrainBiome.ALPINE }), CLIFF_CELLS);
    expect(alpine.rocks, "the fixture does grow scree").toBeGreaterThan(10);
    expect(rockRun(cliffSampler({ biome: TerrainBiome.WATER }), CLIFF_CELLS).rocks).toBe(0);
    expect(
      rockRun(cliffSampler({ biome: TerrainBiome.ALPINE, airportInfluence: 1 }), CLIFF_CELLS)
        .rocks,
    ).toBe(0);
  });

  it("takes the apron off permanent snow without making placement seasonal", () => {
    const low = rockRun(cliffSampler({ biome: TerrainBiome.ALPINE }), CLIFF_CELLS);
    const high = rockRun(
      cliffSampler({ biome: TerrainBiome.ALPINE, baseHeight: 1_900 }),
      CLIFF_CELLS,
    );
    // Same geometry, same lithology, same biome — only the elevation moves.
    expect(high.rocks).toBeLessThan(low.rocks);
    // And the burial line is the REFERENCE snowline, so midsummer and
    // midwinter place the identical rocks. Only the tint lane moves; the
    // digest covers position, sink and size.
    const summer = rockRun(ANALYTIC_SAMPLER, MOUNTAIN_CELLS, 171);
    const winter = rockRun(ANALYTIC_SAMPLER, MOUNTAIN_CELLS, 16);
    expect(winter.digest).toBe(summer.digest);
    expect(winter.rocks).toBe(summer.rocks);
  });

  it("is deterministic and non-degenerate 926 km from the origin", () => {
    // The sin-fract trap: a hash that collapses into rows at world scale is
    // invisible at the origin. Nothing in this law hashes at all — it is pure
    // arithmetic over sampled metres — and its one seeded input is the shared
    // integer-lattice geology sampler.
    const first = rockRun(ANALYTIC_SAMPLER, FAR_CELLS);
    const second = rockRun(ANALYTIC_SAMPLER, FAR_CELLS);
    expect(second.digest).toBe(first.digest);
        // RE-PINNED at `6-13` for the SLOPE half: `gentle` is now the exact
    // complement of `steep` rather than a second, independently-drifting
    // window. The old pair left every climatic suitability at ~0 across
    // slope 0.24-0.26 (gentle 0.0086, steep 0.0016), where `Sand`'s
    // constant `+0.02` won by default. Rock's own share is essentially
    // unmoved by the change — 18.77%% -> 18.93%% of land, measured over
    // 13,685 probes — because the partition is anchored on `steep`'s
    // existing window precisely so `Rock = steep * 1.25` keeps the
    // calibration that coefficient was tuned against.
    expect(first.digest).toBe("554b8c38");
        // `6-13` re-pin: total scree FALLS (`gentle` now reaches further up the
    // slope axis, so grass holds ground that previously went to rock).
    // Down is budget-safe; the +1 mid-band boulder noted above is a
    // redistribution outward, not a net increase.
    expect(first.rocks).toBe(52);    // 6-13: 53 -> 52
    expect(first.rocks, "net count falls vs the pre-6-7 72").toBeLessThan(72);
    expect(first.bands[1]! + first.bands[2]!, "apron bands vs pre-6-7 3")
      .toBeGreaterThan(3);
    // Lithology out there is a field, not a constant and not a stripe: 400
    // probes over a ~110 km transect returned 400 distinct repose angles
    // spanning 31.2°–38.3°.
    const repose = new Set<string>();
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < 400; index += 1) {
      const sample = sampleTerrainEvolutionGeology(
        SEED_HASH,
        FAR_CELLS[0]![0] * 512 + index * 237.5,
        FAR_CELLS[0]![1] * 512 + index * 161.25,
        0,
      );
      repose.add(sample.reposeDegrees.toFixed(6));
      minimum = Math.min(minimum, sample.reposeDegrees);
      maximum = Math.max(maximum, sample.reposeDegrees);
    }
    expect(repose.size).toBe(400);
    expect(maximum - minimum).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// A controlled cliff-and-apron fixture
// ---------------------------------------------------------------------------

/**
 * A 256 m profile, repeated: ground rises at 31° for 150 m — an apron under
 * the local angle of repose — and at 70° for the next 106 m, which is a
 * failure face standing inside the probe's 96 m reach. Everything the placement path reads is derived from that one
 * profile — height, the analytic normal, and the normalized steepness — so a
 * test can move exactly one variable (biome, elevation, airport influence)
 * and attribute the whole difference to it.
 */
const CLIFF_CELLS = [[0, 0], [0, 1], [1, 0], [1, 1]] as const;
/** Profile period, metres: one apron plus one face inside the probe's reach. */
const CLIFF_PERIOD_METERS = 256;
const CLIFF_APRON_GRADIENT = Math.tan((31 * Math.PI) / 180);
const CLIFF_FACE_GRADIENT = Math.tan((70 * Math.PI) / 180);
const CLIFF_BREAK_METERS = 150;

function cliffProfile(u: number): { height: number; gradient: number } {
  const local = ((u % CLIFF_PERIOD_METERS) + CLIFF_PERIOD_METERS) % CLIFF_PERIOD_METERS;
  if (local < CLIFF_BREAK_METERS) {
    return { height: local * CLIFF_APRON_GRADIENT, gradient: CLIFF_APRON_GRADIENT };
  }
  return {
    height: CLIFF_BREAK_METERS * CLIFF_APRON_GRADIENT
      + (local - CLIFF_BREAK_METERS) * CLIFF_FACE_GRADIENT,
    gradient: CLIFF_FACE_GRADIENT,
  };
}

function cliffSampler(options: {
  biome: TerrainBiomeId;
  baseHeight?: number;
  airportInfluence?: number;
}): DetailTerrainSampler {
  const base = options.baseHeight ?? 300;
  return (x, z): DetailTerrainSample => {
    const { height, gradient } = cliffProfile(x);
    const inverseLength = 1 / Math.hypot(gradient, 1);
    return {
      height: base + height + Math.sin(z * 0.01) * 0.5,
      slope: 1 - inverseLength,
      moisture: 0.35,
      biome: options.biome,
      normal: { x: -gradient * inverseLength, y: inverseLength, z: 0 },
      ...(options.airportInfluence !== undefined
        ? { airportInfluence: options.airportInfluence }
        : {}),
    };
  };
}

describe("6-7 budgets", () => {
  it("adds no rock draw and no per-cell instance headroom", () => {
    // Draws scale with (chunks × meshes), never with instances
    // (renderedDensity.ts's model). 6-7 adds no prototype and no variant, so
    // the rock batch set is the same three keys it has been since 2-15 and
    // the understory draw term does not move at all.
    const run = rockRun(ANALYTIC_SAMPLER, MOUNTAIN_CELLS);
    for (const key of run.batchKeys) {
      expect(["rock-dark", "rock-granite", "rock-limestone"]).toContain(key);
    }
    expect(run.batchKeys.size).toBeLessThanOrEqual(3);
    // The per-cell candidate count is structural (cellSize²/2800, capped at
    // 96) and 6-7 does not touch it: the apron spends existing candidates.
    expect(run.perCellMaximum).toBeLessThanOrEqual(96);
    // The mid-band population — the boulders drawn out to the MID radius
    // rather than the near one — falls too: 14 before, 9 at `6-7`.
    //
    // `6-13` RAISES IT BY ONE, 9 -> 10, and this is NOT a re-pin like the
    // digests above — it is a count, and counts are what the ratchet watches.
    // Stated plainly so it is reviewed rather than absorbed:
    //   * the INVARIANT this test exists for still holds — 10 is still well
    //     under the pre-6-7 14, and the assertion below is the real guard;
    //   * the budget guards above are untouched: the rock batch set is still
    //     the same three keys, and `perCellMaximum` is still inside 96;
    //   * `Rock`'s share of land barely moves (18.77% -> 18.93% over 13,685
    //     probes), because the slope partition is anchored on `steep`'s own
    //     window to preserve `Rock = steep * 1.25`'s calibration. The +1 is a
    //     boundary effect at the mid radius, not a new rock regime.
    // If a reviewer decides a +1 mid-band boulder is not payable, the fix is
    // the slope partition, not this pin.
    expect(run.midBand).toBe(10);
    expect(run.midBand, "mid-band draw pressure vs the pre-6-7 14").toBeLessThan(14);
  });

  it("keeps the apron inside the acceptance clamp it inherited", () => {
    // The strongest possible apron on the strongest possible lag still lands
    // under the 0.75 acceptance clamp 2-15 set, so no cell can exceed the
    // instance envelope the runtime already sizes for.
    const saturated = rockRun(cliffSampler({ biome: TerrainBiome.ALPINE }), CLIFF_CELLS);
    const candidates = Math.min(96, Math.max(12, Math.round((512 * 512) / 2_800)));
    expect(candidates).toBe(94);
    expect(saturated.perCellMaximum).toBeLessThanOrEqual(candidates);
    // Under the inherited clamp: 0.75 of the candidates is the hard envelope
    // and the strongest apron this world can build stays under it.
    expect(saturated.perCellMaximum).toBeLessThanOrEqual(Math.ceil(candidates * 0.75));
  });
});
