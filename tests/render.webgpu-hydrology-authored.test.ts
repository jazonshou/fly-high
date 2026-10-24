import { describe, expect, it } from "vitest";
import {
  generateHydrology,
  type HydrologyAuthoredBasin,
  type HydrologyGenerationOptions,
  type HydrologyGenerationResult,
  type HydrologyTerrainSampler,
} from "../src/render/webgpu/water/HydrologyGeneration";

/**
 * The world's two hydrology inputs, on terrain that is pure arithmetic:
 * authored basins (a lake the world gives a level, or a basin it keeps dry)
 * and porous ground no river rises from. The volcanic inputs themselves are
 * tested against real worlds in `world.volcanic-water.test.ts`.
 */

/** Every number as its exact bits, so "identical" means bit-identical. */
function bits(result: HydrologyGenerationResult): string {
  const view = new DataView(new ArrayBuffer(8));
  return JSON.stringify(result, (_key, value: unknown) => {
    if (typeof value !== "number") return value;
    view.setFloat64(0, value);
    return `${view.getUint32(0).toString(16)}:${view.getUint32(4).toString(16)}`;
  });
}

const BOWL_RADIUS_TO_LEVEL = 0.002;

/** A round bowl, 100 m at its centre, that the tracer fills with basin lakes. */
function bowlTerrain(island = false): HydrologyTerrainSampler {
  return (x, z) => {
    const r = Math.hypot(x, z);
    // An optional cone 90 m high, 70 m round, standing on the bowl's centre.
    const cone = island ? Math.max(0, 90 * (1 - r / 70)) : 0;
    return { height: 100 + r * r * BOWL_RADIUS_TO_LEVEL + cone, moisture: 0.78 };
  };
}

function bowlOptions(terrainSample: HydrologyTerrainSampler): HydrologyGenerationOptions {
  return {
    worldSeed: "authored-basins",
    terrainSample,
    centerX: 0,
    centerZ: 0,
    extentMeters: 1_600,
    seaLevel: 0,
    sourceCandidateSpacingMeters: 260,
    minimumSourceElevationAboveSeaMeters: 0,
    minimumSourceSeparationMeters: 250,
    traceStepMeters: 55,
    traceAngularSamples: 24,
    maximumTraceSteps: 48,
    minimumRiverPoints: 5,
    maximumRivers: 4,
    maximumLakes: 3,
    minimumLakeDepthMeters: 1,
    maximumLakeDepthMeters: 12,
    minimumLakeRadiusMeters: 25,
    maximumLakeRadiusMeters: 420,
    lakeBoundarySegments: 24,
  };
}

function slopedOptions(): HydrologyGenerationOptions {
  return {
    worldSeed: "porous-ground",
    terrainSample: (x, z) => ({
      height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3,
      moisture: 0.64,
    }),
    centerX: 0,
    centerZ: 0,
    extentMeters: 8_000,
    sourceCandidateSpacingMeters: 500,
    traceStepMeters: 90,
    maximumTraceSteps: 64,
    maximumRivers: 12,
    // The ramp is 7.5 %: lift the R-24 grade cull so it carries ribbons.
    maximumRiverGrade: 1,
  };
}

/** A lake authored at 150 m in the bowl: its shore is where 0.002 r^2 = 50. */
const SHORE_RADIUS = Math.sqrt(50 / BOWL_RADIUS_TO_LEVEL);
const BOWL_BASIN: HydrologyAuthoredBasin = Object.freeze({
  id: "test:bowl",
  centerX: 0,
  centerZ: 0,
  levelMeters: 150,
  floorMeters: 100,
  rimRadiusMeters: 300,
});

describe("authored basins and porous ground", () => {
  it("change nothing, bit for bit, when absent or empty", () => {
    for (const options of [bowlOptions(bowlTerrain()), slopedOptions()]) {
      const before = bits(generateHydrology(options));
      expect(bits(generateHydrology({
        ...options,
        authoredBasins: [],
        sourceExcluded: () => false,
      }))).toBe(before);
      // A basin far outside the region and its halo touches nothing either.
      expect(bits(generateHydrology({
        ...options,
        authoredBasins: [{ ...BOWL_BASIN, centerX: 400_000 }],
      }))).toBe(before);
    }
  });

  it("shore an authored lake at its level, whole and inside its rim, instead of a basin lake", () => {
    const options = bowlOptions(bowlTerrain());
    const traced = generateHydrology(options);
    // Without the basin the tracer fills the bowl itself.
    expect(traced.lakes.length).toBeGreaterThan(0);
    const authored = generateHydrology({ ...options, authoredBasins: [BOWL_BASIN] });
    expect(authored.lakes).toHaveLength(1);
    const lake = authored.lakes[0]!;
    const offset = authored.config.riverSurfaceOffsetMeters;
    expect(lake.id).toMatch(/:lake:test:bowl$/);
    expect(lake.surfaceHeight).toBe(150 + offset);
    expect(lake.maximumDepthMeters).toBe(50);
    expect(lake.boundary).toHaveLength(24);
    for (const point of lake.boundary) {
      const radius = Math.hypot(point.x, point.z);
      expect(point.y).toBe(lake.surfaceHeight);
      // Just outside the true shore (the bracketing dry sample), never past the rim.
      expect(radius).toBeGreaterThanOrEqual(SHORE_RADIUS);
      expect(radius).toBeLessThanOrEqual(SHORE_RADIUS + 40);
      expect(radius).toBeLessThanOrEqual(BOWL_BASIN.rimRadiusMeters);
    }
    expect(lake.areaSquareMeters).toBeGreaterThan(Math.PI * SHORE_RADIUS ** 2 * 0.95);
    expect(structuredClone(authored)).toEqual(authored);
  });

  it("find the OUTER shore round an island standing on the centre", () => {
    const options = bowlOptions(bowlTerrain(true));
    const lake = generateHydrology({ ...options, authoredBasins: [BOWL_BASIN] }).lakes[0]!;
    expect(lake).toBeDefined();
    for (const point of lake.boundary) {
      expect(Math.hypot(point.x, point.z)).toBeGreaterThanOrEqual(SHORE_RADIUS);
    }
  });

  it("keep the rim where the water would spill, and make no lake where no ray is wet", () => {
    const options = bowlOptions(bowlTerrain());
    // Rim 120 m: the 150 m level stands above the ground there on every ray.
    const spill = generateHydrology({
      ...options,
      authoredBasins: [{ ...BOWL_BASIN, rimRadiusMeters: 120 }],
    }).lakes[0]!;
    for (const point of spill.boundary) expect(Math.hypot(point.x, point.z)).toBeCloseTo(120, 6);
    // A level under the bowl's floor: no water anywhere.
    const dryLevel = generateHydrology({
      ...options,
      authoredBasins: [{ ...BOWL_BASIN, levelMeters: 99 }],
    });
    expect(dryLevel.lakes).toHaveLength(0);
  });

  it("keep a basin authored dry free of basin lakes, and drop lakes under the sea", () => {
    const options = bowlOptions(bowlTerrain());
    for (const levelMeters of [Number.NaN, -20]) {
      const result = generateHydrology({
        ...options,
        authoredBasins: [{ ...BOWL_BASIN, levelMeters }],
      });
      expect(result.lakes).toHaveLength(0);
    }
    expect(() => generateHydrology({
      ...options,
      authoredBasins: [{ ...BOWL_BASIN, levelMeters: Number.POSITIVE_INFINITY }],
    })).toThrow(/finite or NaN/);
    expect(() => generateHydrology({
      ...options,
      authoredBasins: [{ ...BOWL_BASIN, rimRadiusMeters: 0 }],
    })).toThrow(/rimRadiusMeters/);
  });

  it("raise no river from porous ground and leave every other river as it was", () => {
    const options = slopedOptions();
    const full = generateHydrology(options);
    expect(full.rivers.length).toBeGreaterThan(2);
    const none = generateHydrology({ ...options, sourceExcluded: () => true });
    expect(none.rivers).toHaveLength(0);
    expect(none.statistics.candidateSourceCount).toBe(0);
    // Porous ground on the high (west) side only.
    const asked: number[] = [];
    const half = generateHydrology({
      ...options,
      sourceExcluded: (x) => {
        asked.push(x);
        return x < 0;
      },
    });
    expect(asked.some((x) => x < 0) && asked.some((x) => x >= 0)).toBe(true);
    expect(half.rivers.length).toBeGreaterThan(0);
    expect(half.rivers.length).toBeLessThan(full.rivers.length);
    const fullById = new Map(full.rivers.map((river) => [river.id, river]));
    for (const river of half.rivers) expect(river).toEqual(fullById.get(river.id));
    // The result stays data: the predicate never reaches the config.
    expect(Object.values(half.config).every((value) => typeof value === "number")).toBe(true);
  });
});
