import { describe, expect, it } from "vitest";
import {
  CLIMATE_PROVINCE,
  CLIMATE_PROVINCE_METERS_PER_TEMPERATURE,
  CLIMATE_PROVINCE_NAMES,
  CLIMATE_PROVINCE_PRESETS,
  CLIMATE_PROVINCE_SNOWLINE_METERS_PER_TEMPERATURE,
  applyClimateProvinceDryness,
  climateProvinceCoreCenter,
  climateProvinceStaircase,
  sampleClimateProvince,
  sampleClimateProvinceUnmasked,
  terrainSnowlineThermalHeight,
  terrainThermalHeight,
} from "@/src/world/climateProvince";
import { createWorld } from "@/src/world/world";
import { sampleTerrain, sampleTerrainMoisture, terrainTemperatureFromClimate } from "@/src/world/terrain";
import { classifyLandCover, type LandCoverInput } from "@/src/render/webgpu/terrain/LandCoverClassifier";
import {
  TERRAIN_KERNEL_LATTICES,
  TERRAIN_KERNEL_LATTICE_COUNT,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainClimateProvinceInput,
} from "@/src/render/webgpu/terrain/TerrainKernel";
import { hashSeed } from "@/src/world/seed";

/**
 * Climate provinces (`src/world/climateProvince.ts`): two slow offsets on the
 * climate chain, masked to EXACTLY 0 in a temperate core around the start
 * airport. The core is what keeps every perf baseline bit-identical, so the
 * first block is the contract and the rest is the field's shape.
 */

const SEEDS = ["phase1-perf-baseline", "open-skies", 9_021] as const;
const WORLDS = SEEDS.map((seed) => createWorld(seed));

function ringPoints(
  center: { x: number; z: number },
  radius: number,
  count: number,
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + radius * 1e-5;
    points.push([center.x + Math.cos(angle) * radius, center.z + Math.sin(angle) * radius]);
  }
  return points;
}

describe("the temperate core", () => {
  it("is exactly zero within 70 km of the start airport, for every seed", () => {
    for (const world of WORLDS) {
      const center = climateProvinceCoreCenter(world);
      expect(world.airport).not.toBeNull();
      expect(center.x).toBe(world.airport!.centerX);
      for (const radius of [0, 1_000, 20_000, 45_000, 69_999]) {
        for (const [x, z] of ringPoints(center, radius, 16)) {
          const sample = sampleClimateProvince(world, x, z);
          expect(Object.is(sample.temperatureOffset, 0), `${world.seed} r=${radius}`).toBe(true);
          expect(Object.is(sample.dryness, 0), `${world.seed} r=${radius}`).toBe(true);
        }
      }
    }
  });

  it("reaches full strength past the ramp, and moves the climate there", () => {
    for (const world of WORLDS) {
      const center = climateProvinceCoreCenter(world);
      let temperatureMoved = 0;
      let drynessMoved = 0;
      let total = 0;
      for (const radius of [150_000, 300_000, 600_000]) {
        for (const [x, z] of ringPoints(center, radius, 64)) {
          const masked = sampleClimateProvince(world, x, z);
          const unmasked = sampleClimateProvinceUnmasked(world.seedHash, x, z);
          expect(masked).toEqual(unmasked);
          if (masked.temperatureOffset !== 0) temperatureMoved += 1;
          if (masked.dryness !== 0) drynessMoved += 1;
          total += 1;
        }
      }
      // The temperate plateau is 30 % of province ground and ordinary
      // moisture 35 %; the rest moves. Loose bounds: the shares test pins them.
      expect(temperatureMoved / total, world.seed).toBeGreaterThan(0.3);
      expect(drynessMoved / total, world.seed).toBeGreaterThan(0.3);
    }
  });

  it("leaves the shipped climate bit for bit where the offsets are 0", () => {
    const world = WORLDS[0]!;
    const center = climateProvinceCoreCenter(world);
    for (const [x, z] of ringPoints(center, 12_000, 24)) {
      for (const filterWidth of [0, 64, 512]) {
        // The default argument samples the province; the core hands back 0.
        expect(Object.is(
          sampleTerrainMoisture(world, x, z, filterWidth),
          sampleTerrainMoisture(world, x, z, filterWidth, 0),
        )).toBe(true);
      }
      for (const height of [0, 450, 1_800]) {
        expect(Object.is(
          terrainTemperatureFromClimate(world, 0.3, height),
          terrainTemperatureFromClimate(world, 0.3, height, 0),
        )).toBe(true);
      }
      const terrain = sampleTerrain(world, x, z);
      expect(Object.is(terrain.temperatureOffset, 0)).toBe(true);
      expect(Object.is(terrain.dryness, 0)).toBe(true);
    }
  });

  it("anchors on the origin without an airport", () => {
    const world = createWorld("open-skies", { airport: false });
    expect(climateProvinceCoreCenter(world)).toEqual({ x: 0, z: 0 });
    const inside = sampleClimateProvince(world, 50_000, -40_000);
    expect(Object.is(inside.temperatureOffset, 0)).toBe(true);
    expect(Object.is(inside.dryness, 0)).toBe(true);
  });
});

describe("the force-province world option", () => {
  it("applies every preset everywhere, temperate core included", () => {
    for (const name of CLIMATE_PROVINCE_NAMES) {
      const world = createWorld("phase1-perf-baseline", { climateProvince: name });
      const preset = CLIMATE_PROVINCE_PRESETS[name];
      expect(world.climateProvince).toEqual(preset);
      const center = climateProvinceCoreCenter(world);
      for (const [x, z] of [[center.x, center.z], [center.x + 400_000, center.z - 90_000]]) {
        expect(sampleClimateProvince(world, x!, z!)).toEqual(preset);
      }
    }
  });

  it("does not move the terrain itself, only its climate", () => {
    const natural = createWorld("phase1-perf-baseline");
    const forced = createWorld("phase1-perf-baseline", { climateProvince: "boreal" });
    expect(forced.seedHash).toBe(natural.seedHash);
    expect(forced.airport).toEqual(natural.airport);
    const { centerX, centerZ } = natural.airport!;
    const a = sampleTerrain(natural, centerX + 3_000, centerZ + 1_000);
    const b = sampleTerrain(forced, centerX + 3_000, centerZ + 1_000);
    expect(b.height).toBe(a.height);
    expect(b.temperatureOffset).toBe(CLIMATE_PROVINCE_PRESETS.boreal.temperatureOffset);
    expect(b.temperature).toBeLessThan(a.temperature);
  });

  it("accepts explicit offsets and rejects what it cannot honour", () => {
    const world = createWorld("open-skies", {
      climateProvince: { temperatureOffset: -0.1, dryness: 0.3 },
    });
    expect(world.climateProvince).toEqual({ temperatureOffset: -0.1, dryness: 0.3 });
    expect(Object.isFrozen(world.climateProvince)).toBe(true);
    expect(() => createWorld("open-skies", {
      climateProvince: "steppe" as never,
    })).toThrow(RangeError);
    expect(() => createWorld("open-skies", {
      climateProvince: { temperatureOffset: Number.NaN, dryness: 0 },
    })).toThrow(RangeError);
    expect(() => createWorld("open-skies", {
      climateProvince: { temperatureOffset: 0, dryness: 1.5 },
    })).toThrow(RangeError);
  });

  it("gives the natural presets the same numbers as the field's plateaus", () => {
    const levels = CLIMATE_PROVINCE.temperature.levels;
    expect(levels).toContain(CLIMATE_PROVINCE_PRESETS.tundra.temperatureOffset);
    expect(levels).toContain(CLIMATE_PROVINCE_PRESETS.boreal.temperatureOffset);
    expect(levels).toContain(CLIMATE_PROVINCE_PRESETS.savanna.temperatureOffset);
    expect(levels).toContain(CLIMATE_PROVINCE_PRESETS.tropical.temperatureOffset);
    const dryness = CLIMATE_PROVINCE.dryness.levels;
    expect(dryness).toContain(CLIMATE_PROVINCE_PRESETS["high-desert"].dryness);
    expect(dryness).toContain(CLIMATE_PROVINCE_PRESETS.savanna.dryness);
    expect(dryness).toContain(CLIMATE_PROVINCE_PRESETS.tropical.dryness);
  });
});

describe("the province field's shape", () => {
  function nearestLevel(value: number, levels: readonly number[]): number {
    let best = 0;
    for (let index = 1; index < levels.length; index += 1) {
      if (Math.abs(value - levels[index]!) < Math.abs(value - levels[best]!)) best = index;
    }
    return best;
  }

  it("covers each plateau with about its chosen share of the world", () => {
    const temperatureShares = [0.15, 0.2, 0.3, 0.2, 0.15];
    const drynessShares = [0.2, 0.35, 0.25, 0.2];
    const temperatureCounts = temperatureShares.map(() => 0);
    const drynessCounts = drynessShares.map(() => 0);
    let total = 0;
    for (const seed of ["shares-a", "shares-b", "shares-c", "shares-d"]) {
      const seedHash = hashSeed(seed);
      for (let row = 0; row < 90; row += 1) {
        for (let column = 0; column < 90; column += 1) {
          const sample = sampleClimateProvinceUnmasked(
            seedHash, (column - 45) * 33_000 + 917, (row - 45) * 33_000 - 411);
          temperatureCounts[nearestLevel(sample.temperatureOffset, CLIMATE_PROVINCE.temperature.levels)]! += 1;
          drynessCounts[nearestLevel(sample.dryness, CLIMATE_PROVINCE.dryness.levels)]! += 1;
          total += 1;
        }
      }
    }
    temperatureShares.forEach((share, index) => {
      expect(temperatureCounts[index]! / total, `temperature plateau ${index}`)
        .toBeGreaterThan(share - 0.08);
      expect(temperatureCounts[index]! / total, `temperature plateau ${index}`)
        .toBeLessThan(share + 0.08);
    });
    drynessShares.forEach((share, index) => {
      expect(drynessCounts[index]! / total, `dryness plateau ${index}`)
        .toBeGreaterThan(share - 0.08);
      expect(drynessCounts[index]! / total, `dryness plateau ${index}`)
        .toBeLessThan(share + 0.08);
    });
  });

  it("is a staircase: its plateaus, and only steps between them", () => {
    const { levels, thresholds } = CLIMATE_PROVINCE.temperature;
    expect(climateProvinceStaircase(-5, levels, thresholds)).toBe(levels[0]);
    expect(climateProvinceStaircase(5, levels, thresholds)).toBeCloseTo(levels[levels.length - 1]!, 12);
    // Midway between two thresholds, well clear of both ecotones: a plateau.
    expect(climateProvinceStaircase(0, levels, thresholds)).toBeCloseTo(0, 12);
    let previous = -Infinity;
    for (let value = -1; value <= 1; value += 0.001) {
      const step = climateProvinceStaircase(value, levels, thresholds);
      expect(step).toBeGreaterThanOrEqual(previous);
      previous = step;
    }
  });
});

describe("dryness and thermal height", () => {
  it("leaves moisture bit-identical at zero dryness and keeps its structure when dry", () => {
    for (let index = 0; index <= 100; index += 1) {
      const moisture = index / 100;
      expect(Object.is(applyClimateProvinceDryness(moisture, 0), moisture)).toBe(true);
      expect(applyClimateProvinceDryness(moisture, 0.5)).toBeCloseTo(moisture * 0.5, 12);
      expect(applyClimateProvinceDryness(moisture, -0.15)).toBeCloseTo(moisture + (1 - moisture) * 0.15, 12);
    }
    // Scaling, not subtract-and-clamp: an arid province keeps an ordering.
    expect(applyClimateProvinceDryness(0.2, 0.5)).toBeLessThan(applyClimateProvinceDryness(0.4, 0.5));
    expect(applyClimateProvinceDryness(0.2, 0.5)).toBeGreaterThan(0);
  });

  it("lifts a cold province's altitude bands, and the snowline only partly", () => {
    for (const height of [0, 312.5, 1_800]) {
      expect(Object.is(terrainThermalHeight(height, 0), height)).toBe(true);
      expect(Object.is(terrainSnowlineThermalHeight(height, 0), height)).toBe(true);
    }
    expect(terrainThermalHeight(0, -0.22)).toBeCloseTo(0.22 * CLIMATE_PROVINCE_METERS_PER_TEMPERATURE, 9);
    expect(terrainSnowlineThermalHeight(0, -0.22))
      .toBeCloseTo(0.22 * CLIMATE_PROVINCE_SNOWLINE_METERS_PER_TEMPERATURE, 9);
    expect(CLIMATE_PROVINCE_SNOWLINE_METERS_PER_TEMPERATURE)
      .toBeLessThan(CLIMATE_PROVINCE_METERS_PER_TEMPERATURE);
  });

  it("classifies the ground identically with zero offsets and with none", () => {
    const base: LandCoverInput = {
      elevationMeters: 0,
      slope: 0.05,
      moisture: 0.5,
      temperature: 0.6,
      aspect: 0,
      airportInfluence: 0,
      dayOfYear: 172,
      seasonalTemperatureShift: 0,
    };
    for (const elevationMeters of [2, 180, 900, 1_350, 1_700, 2_600]) {
      for (const slope of [0.02, 0.15, 0.4]) {
        for (const moisture of [0.15, 0.55, 0.9]) {
          for (const flow of [undefined, 4e5]) {
            const input: LandCoverInput = {
              ...base,
              elevationMeters,
              slope,
              moisture,
              temperature: 0.66 - elevationMeters / 2_450,
              ...(flow === undefined ? {} : { flowAccumulationAreaM2: flow }),
            };
            expect(classifyLandCover({ ...input, temperatureOffset: 0, dryness: 0 }))
              .toEqual(classifyLandCover(input));
          }
        }
      }
    }
  });
});

describe("the province on the GPU page uniform", () => {
  const PROVINCE_LATTICES = TERRAIN_KERNEL_LATTICES
    .map((lattice, index) => ({ lattice, index }))
    .filter(({ lattice }) => lattice.name.startsWith("province"));

  it("appends its lattices after every existing one, unfiltered at any level", () => {
    expect(PROVINCE_LATTICES).toHaveLength(
      CLIMATE_PROVINCE.temperature.octaves + CLIMATE_PROVINCE.dryness.octaves);
    // Appended right after the climate chain, so every lattice index the
    // kernel already used is unchanged (the landforms' come after them).
    const climateEnd = TERRAIN_KERNEL_LATTICES.findIndex((lattice) => lattice.name === "climate[2]");
    expect(PROVINCE_LATTICES[0]!.index).toBe(climateEnd + 1);
    expect(PROVINCE_LATTICES.at(-1)!.index).toBeLessThan(TERRAIN_KERNEL_LATTICE_COUNT);
    for (const { lattice } of PROVINCE_LATTICES) {
      expect(lattice.filterWidthMetersOverride, lattice.name).toBe(0);
    }
  });

  it("injects the staircases' levels and thresholds rather than retyping them", () => {
    expect(TERRAIN_KERNEL_WGSL).toContain("fn kProvinceTemperatureStaircase(value: f32) -> f32 {");
    expect(TERRAIN_KERNEL_WGSL).toContain("fn kProvinceDrynessStaircase(value: f32) -> f32 {");
    expect(TERRAIN_KERNEL_WGSL).toContain("fn terrainClimateProvince(");
    expect(TERRAIN_KERNEL_WGSL).toMatch(new RegExp(
      `kSmoothstep\\(\\s*${CLIMATE_PROVINCE.coreRadiusMeters}\\.0,\\s*`
        + `${CLIMATE_PROVINCE.coreRadiusMeters + CLIMATE_PROVINCE.rampMeters}\\.0,`, "u"));
    const { thresholds } = CLIMATE_PROVINCE.temperature;
    const halfWidth = CLIMATE_PROVINCE.ecotoneHalfWidth;
    expect(TERRAIN_KERNEL_WGSL).toContain(String(thresholds[0]! - halfWidth));
  });

  function provinceRows(buffer: ArrayBuffer): number[] {
    const floats = new Float32Array(buffer);
    const keptBase = TERRAIN_KERNEL_LATTICE_COUNT * 8;
    return [...floats.slice(keptBase + 4, keptBase + 12)];
  }

  it("writes zero rows without a province, the core offset and gain 1 for the natural field", () => {
    const page = { seedHash: 7, originX: 40_960, originZ: -12_288, filterWidthMeters: 16 };
    expect(provinceRows(buildTerrainKernelPageUniform(page))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const world = WORLDS[0]!;
    const natural = terrainClimateProvinceInput(world);
    expect(provinceRows(buildTerrainKernelPageUniform({ ...page, climateProvince: natural }))).toEqual([
      Math.fround(page.originX - world.airport!.centerX),
      Math.fround(page.originZ - world.airport!.centerZ),
      1, 0, 0, 0, 0, 0,
    ]);
  });

  it("writes gain 0 and the forced offsets for a forced world", () => {
    const world = createWorld("phase1-perf-baseline", { climateProvince: "savanna" });
    const page = { seedHash: world.seedHash, originX: 0, originZ: 0, filterWidthMeters: 0 };
    const rows = provinceRows(buildTerrainKernelPageUniform({
      ...page,
      climateProvince: terrainClimateProvinceInput(world),
    }));
    expect(rows[2]).toBe(0);
    expect(rows[4]).toBe(Math.fround(CLIMATE_PROVINCE_PRESETS.savanna.temperatureOffset));
    expect(rows[5]).toBe(Math.fround(CLIMATE_PROVINCE_PRESETS.savanna.dryness));
  });
});
