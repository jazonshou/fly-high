import { describe, expect, it } from "vitest";
import { TerrainBiome } from "../src/world";
import {
  BOREAL_COLD_FULL,
  BOREAL_COLD_ONSET,
  TUNDRA_COLD_FULL,
  TUNDRA_COLD_ONSET,
  borealShare,
  splitColdDraw,
  tundraShare,
} from "../src/world/coldBiomes";
import { CLIMATE_PROVINCE_PRESETS } from "../src/world/climateProvince";
import {
  classifyLandCover,
  landCoverSuitabilities,
  landCoverWeightOf,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import { densityField } from "../src/render/webgpu/detail/densityField";
import type { DetailTerrainSampler } from "../src/render/webgpu/detail/types";
import {
  resolveLakeConstituents,
  resolveRiverConstituents,
  type InlandWaterEnvironment,
  type WaterConstituents,
} from "../src/render/webgpu/water/WaterConstituents";

/**
 * The cold biomes — boreal forest and tundra — as data on the province's cold
 * offset (`src/world/coldBiomes.ts`).
 *
 * THE INVARIANT FIRST: at cold 0 (the temperate core around the start airport,
 * where every baseline shot sits) every consumer is BIT-IDENTICAL to the
 * temperate law. Each check compares with `Object.is`, element by element,
 * so a `-0` or a last-ulp move fails it. The frozen-law tests that already
 * guard the classifier (`render.webgpu-land-cover-alpine-partition`) and the
 * byte-identity tests of `render.webgpu-detail-generation` run through the same
 * code with the field omitted, which is the other half of the proof.
 *
 * Then each biome is checked for the look it exists to give, with a positive
 * control: a test that cannot tell boreal from temperate cannot fail.
 */

const REFERENCE_DAY = 171;
const BOREAL = CLIMATE_PROVINCE_PRESETS.boreal.temperatureOffset;
const TUNDRA = CLIMATE_PROVINCE_PRESETS.tundra.temperatureOffset;

const landCover = (overrides: Partial<LandCoverInput>): LandCoverInput => ({
  elevationMeters: 120,
  slope: 0.05,
  moisture: 0.5,
  temperature: 0.6,
  aspect: 0,
  airportInfluence: 0,
  dayOfYear: REFERENCE_DAY,
  seasonalTemperatureShift: 0,
  ...overrides,
});

function expectBitIdentical(actual: readonly number[], expected: readonly number[], label: string) {
  expect(actual.length, label).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(Object.is(actual[index], expected[index]), `${label} [${index}]`).toBe(true);
  }
}

function constituentList(value: WaterConstituents): number[] {
  return [value.chlorophyll, value.cdom440, value.sediment, value.mineral];
}

function rollingTerrain(moisture: number, temperatureOffset?: number): DetailTerrainSampler {
  return (x, z) => ({
    height: 120 + Math.sin(x * 0.002) * 3 + Math.cos(z * 0.0025) * 2,
    slope: 0.05,
    moisture: moisture + Math.sin(x * 0.011 + z * 0.007) * 0.08,
    biome: TerrainBiome.FOREST,
    ...(temperatureOffset !== undefined ? { temperatureOffset } : {}),
  });
}

describe("cold biomes: the shares", () => {
  it("are exactly 0 through the temperate core, warm provinces and the boreal onset", () => {
    for (const offset of [0, -0, 0.12, 0.28, -BOREAL_COLD_ONSET * 0.5, -BOREAL_COLD_ONSET]) {
      expect(Object.is(borealShare(offset), 0), `boreal at ${offset}`).toBe(true);
      expect(Object.is(tundraShare(offset), 0), `tundra at ${offset}`).toBe(true);
    }
    // The tundra share is still exactly 0 in a FULL boreal province: the
    // taiga changes species, never the ground classifier's tundra terms.
    expect(Object.is(tundraShare(BOREAL), 0)).toBe(true);
    expect(Object.is(tundraShare(-TUNDRA_COLD_ONSET), 0)).toBe(true);
    // Both presets sit on their share's plateau.
    expect(borealShare(BOREAL)).toBe(1);
    expect(borealShare(-BOREAL_COLD_FULL)).toBe(1);
    expect(tundraShare(TUNDRA)).toBe(1);
    expect(tundraShare(-TUNDRA_COLD_FULL)).toBe(1);
    expect(borealShare(TUNDRA)).toBe(1);
  });

  it("hand the temperate table the draw itself at share 0", () => {
    for (let index = 0; index <= 1_000; index += 1) {
      const u = index / 1_000;
      const split = splitColdDraw(0, u);
      expect(split.cold).toBe(false);
      expect(Object.is(split.choice, u)).toBe(true);
      // A full share takes every draw, a closed-on-1 selector included.
      expect(splitColdDraw(1, u)).toEqual({ cold: true, choice: u });
    }
    // And both branches stay uniform on [0, 1) at any share.
    for (const share of [0.25, 0.5, 0.9]) {
      for (let index = 0; index < 1_000; index += 1) {
        const split = splitColdDraw(share, index / 1_000);
        expect(split.choice).toBeGreaterThanOrEqual(0);
        expect(split.choice).toBeLessThan(1);
      }
    }
  });
});

describe("cold biomes: the ground classifier (tundra partition)", () => {
  const elevations = [-2, 0, 2, 40, 300, 420, 700, 980, 1_200, 1_400, 1_600, 1_900];
  const slopes = [0, 0.05, 0.12, 0.2, 0.3, 0.45, 0.7];
  const moistures = [0, 0.3, 0.5, 0.7, 1];
  const temperatures = [0, 0.05, 0.12, 0.3, 0.6];
  const shifts = [0, -0.4];

  it("is bit-identical to the temperate law at offset 0", () => {
    let probes = 0;
    for (const elevationMeters of elevations) {
      for (const slope of slopes) {
        for (const moisture of moistures) {
          for (const temperature of temperatures) {
            for (const seasonalTemperatureShift of shifts) {
              const base = landCover({
                elevationMeters, slope, moisture, temperature, seasonalTemperatureShift,
              });
              const shipped = landCoverSuitabilities(base);
              for (const temperatureOffset of [0, -0]) {
                expectBitIdentical(
                  landCoverSuitabilities({ ...base, temperatureOffset }),
                  shipped,
                  `offset ${temperatureOffset} at ${elevationMeters} m slope ${slope}`,
                );
              }
              probes += 1;
            }
          }
        }
      }
    }
    expect(probes).toBe(4_200);
  });

  it("covers flat tundra in turf, heath and dry grass rather than rock", () => {
    // A full tundra province (the -0.65 preset) on flat, median-moisture
    // lowland 80 m above the sea: thermal height ~1,670 m, temperature ~0.
    const probe = landCover({ elevationMeters: 80, temperature: 0.02, slope: 0.03 });
    const tundra = classifyLandCover({ ...probe, temperatureOffset: TUNDRA });
    // Positive control: the same thermal height on a temperate mountain.
    const mountain = classifyLandCover({ ...probe, elevationMeters: 80 + 0.65 * 2_450 });
    const vegetated = (weights: typeof tundra) =>
      landCoverWeightOf(weights, SurfaceMaterial.Grass)
      + landCoverWeightOf(weights, SurfaceMaterial.DryGrass)
      + landCoverWeightOf(weights, SurfaceMaterial.Shrub);
    expect(tundra.ids[0]).toBe(SurfaceMaterial.Grass);
    expect(vegetated(tundra)).toBeGreaterThan(0.85);
    expect(landCoverWeightOf(tundra, SurfaceMaterial.Shrub)).toBeGreaterThan(0.15);
    expect(landCoverWeightOf(tundra, SurfaceMaterial.Rock)).toBeLessThan(0.05);
    // Positive control: the same ground on a temperate summit is the bare,
    // cold top of a mountain, which is why the partition exists.
    expect(vegetated(mountain)).toBeLessThan(vegetated(tundra) - 0.2);
  });

  it("hands dry tundra to heath and dry grass, and keeps cliffs rock", () => {
    const dry = classifyLandCover(landCover({
      elevationMeters: 80, temperature: 0.02, slope: 0.03, moisture: 0.2,
      temperatureOffset: TUNDRA,
    }));
    expect([SurfaceMaterial.Shrub, SurfaceMaterial.DryGrass]).toContain(dry.ids[0]);
    const cliff = classifyLandCover(landCover({
      elevationMeters: 80, temperature: 0.02, slope: 0.6,
      temperatureOffset: TUNDRA,
    }));
    expect(cliff.ids[0]).toBe(SurfaceMaterial.Rock);
  });
});

describe("cold biomes: trees, shrubs and ground cover", () => {
  const shared = { worldSeed: "cold-biomes", cellX: 3, cellZ: -2 } as const;

  it("leaves a temperate cell byte-identical at cold 0", () => {
    for (const moisture of [0.3, 0.56, 0.82]) {
      const omitted = generateDetailCell({ ...shared, terrainSample: rollingTerrain(moisture) });
      const core = generateDetailCell({ ...shared, terrainSample: rollingTerrain(moisture, 0) });
      expect(JSON.stringify(core)).toBe(JSON.stringify(omitted));
    }
  });

  it("grows a boreal forest of spruce, pine and birch only, on two tree families", () => {
    for (const moisture of [0.48, 0.56, 0.82]) {
      const boreal = generateDetailCell({
        ...shared,
        terrainSample: rollingTerrain(moisture, BOREAL),
      });
      const temperate = generateDetailCell({ ...shared, terrainSample: rollingTerrain(moisture) });
      expect(boreal.trees.length, `trees at moisture ${moisture}`).toBeGreaterThan(0);
      const species = new Set(boreal.trees.map((tree) => tree.species));
      for (const name of species) expect(["spruce", "pine", "birch"]).toContain(name);
      const conifers = boreal.trees.filter((tree) => tree.species !== "birch").length;
      expect(conifers / boreal.trees.length).toBeGreaterThan(0.6);
      // Positive control: the temperate table at the same ground is not.
      expect(
        temperate.trees.some((tree) => !["spruce", "pine", "birch"].includes(tree.species)),
      ).toBe(true);
      // The taiga is shorter.
      const tallest = (trees: typeof boreal.trees) =>
        Math.max(...trees.map((tree) => tree.heightMeters));
      expect(tallest(boreal.trees)).toBeLessThan(tallest(temperate.trees));
      // Density in check: a boreal stand places no more than a third more
      // stems than the temperate stand on the same ground (narrow conifers
      // pack closer than oaks; the per-tier rendered cap still bounds what is
      // DRAWN), and its shrubs are no more numerous.
      expect(boreal.trees.length).toBeLessThanOrEqual(Math.ceil(temperate.trees.length * 1.34));
      expect(boreal.shrubs.length).toBeLessThanOrEqual(Math.ceil(temperate.shrubs.length * 1.34));
      for (const shrub of boreal.shrubs) expect(["juniper", "hazel"]).toContain(shrub.species);
    }
  });

  it("keeps an arctic dwarf-shrub belt where the alpine one would be bare", () => {
    // The density field's shrub line: on a mountain the shrubs give out
    // 140 m above the treeline; in the arctic they run on as a whole zone.
    // Positive control: a temperate mountain at the SAME thermal height
    // (120 m in tundra is 1,712 m of thermal) carries none.
    const field = (heightMeters: number, temperatureOffset: number) => densityField(0x5eed, {
      x: 1_200,
      z: -800,
      heightMeters,
      seaLevelMeters: 0,
      slope: 0.05,
      moisture: 0.5,
      dayOfYear: REFERENCE_DAY,
      filterWidthMeters: 0,
      temperatureOffset,
    });
    const thermal = 120 - TUNDRA * 2_450;
    expect(field(thermal, 0).shrubStemsPerSquareMeter).toBe(0);
    expect(field(120, TUNDRA).shrubStemsPerSquareMeter).toBeGreaterThan(0);
    expect(field(120, TUNDRA).treeStemsPerSquareMeter).toBe(0);

    // In a cell: no trees, fewer shrubs than the temperate ground, and every
    // one a dwarf, though tall enough to be seen (not the treeline's 10 cm).
    const tundra = generateDetailCell({ ...shared, terrainSample: rollingTerrain(0.5, TUNDRA) });
    const temperate = generateDetailCell({ ...shared, terrainSample: rollingTerrain(0.5) });
    expect(temperate.trees.length).toBeGreaterThan(0);
    expect(tundra.trees.length).toBe(0);
    expect(tundra.shrubs.length).toBeGreaterThan(0);
    expect(tundra.shrubs.length).toBeLessThan(temperate.shrubs.length);
    const heights = tundra.shrubs.map((shrub) => shrub.heightMeters);
    expect(Math.max(...heights)).toBeLessThan(1.4);
    expect(heights.reduce((sum, height) => sum + height, 0) / heights.length)
      .toBeGreaterThan(0.3);
  });

  it("turns open tundra ground cover to heath and sedge", () => {
    const tundra = generateDetailCell({
      ...shared,
      terrainSample: rollingTerrain(0.45, TUNDRA),
    });
    const temperate = generateDetailCell({ ...shared, terrainSample: rollingTerrain(0.45) });
    const heather = (cell: typeof tundra) =>
      cell.groundCover.filter((node) => node.coverage > 0 && node.archetype === "heather").length;
    expect(heather(tundra)).toBeGreaterThan(heather(temperate));
    expect(heather(tundra)).toBeGreaterThan(tundra.groundCover.length * 0.5);
  });
});

describe("cold biomes: lakes and rivers", () => {
  const environments: InlandWaterEnvironment[] = [];
  for (const elevationAboveSeaMeters of [0, 300, 900, 1_500]) {
    for (const temperature of [0.05, 0.3, 0.6]) {
      for (const moisture of [0.2, 0.5, 0.9]) {
        environments.push({ elevationAboveSeaMeters, temperature, moisture });
      }
    }
  }

  it("are bit-identical to the temperate chemistry at cold 0", () => {
    for (const environment of environments) {
      for (const [depth, area] of [[3, 2e4], [40, 4e6]] as const) {
        expectBitIdentical(
          constituentList(
            resolveLakeConstituents({ ...environment, temperatureOffset: 0 }, depth, area),
          ),
          constituentList(resolveLakeConstituents(environment, depth, area)),
          "lake",
        );
      }
      expectBitIdentical(
        constituentList(
          resolveRiverConstituents({ ...environment, temperatureOffset: 0 }, 30, 1.2, 0.01),
        ),
        constituentList(resolveRiverConstituents(environment, 30, 1.2, 0.01)),
        "river",
      );
    }
  });

  it("stain taiga water tea-brown and run tundra water clear", () => {
    const forestPond: InlandWaterEnvironment = {
      elevationAboveSeaMeters: 60, temperature: 0.42, moisture: 0.55,
    };
    const temperate = resolveLakeConstituents(forestPond, 4, 5e4);
    const boreal = resolveLakeConstituents(
      { ...forestPond, temperatureOffset: BOREAL }, 4, 5e4,
    );
    const tundra = resolveLakeConstituents(
      { ...forestPond, temperature: 0.02, temperatureOffset: TUNDRA }, 4, 5e4,
    );
    // Finnish forest lakes: CDOM(440) of a few per metre.
    expect(boreal.cdom440).toBeGreaterThan(2);
    expect(boreal.cdom440).toBeGreaterThan(temperate.cdom440 * 3);
    expect(tundra.cdom440).toBeLessThan(temperate.cdom440);
    // A lowland tundra lake is not a glacial one: flour needs a mountain.
    expect(tundra.mineral).toBe(0);
    const borealRiver = resolveRiverConstituents(
      { ...forestPond, temperatureOffset: BOREAL }, 30, 1.2, 0.002,
    );
    const temperateRiver = resolveRiverConstituents(forestPond, 30, 1.2, 0.002);
    expect(borealRiver.cdom440).toBeGreaterThan(temperateRiver.cdom440 * 2);
  });
});
