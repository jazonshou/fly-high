import { describe, expect, it } from "vitest";
import {
  DESERT_GROUND_COVER_KEEP,
  DESERT_SHRUB_SHARE,
  DESERT_TREE_SHARE,
  DRY_PROVINCE_DESERT_FULL,
  DRY_PROVINCE_PARKLAND_FULL,
  PARKLAND_SHRUB_SHARE,
  PARKLAND_TREE_SHARE,
  canopyClosure,
  densityField,
  dryProvinceGroundCoverKeep,
  dryProvinceShares,
  type VegetationDensityInput,
} from "../src/render/webgpu/detail/densityField";
import { VEGETATION_DENSITY_FIELD_WGSL } from "../src/render/webgpu/detail/densityFieldWgsl";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type { DetailTerrainSampler } from "../src/render/webgpu/detail/types";
import {
  LAND_COVER_CLASSIFIER_WGSL,
  LAND_COVER_DRY_PROVINCE,
  LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS,
  LAND_COVER_FAR_DESERT_START_TEXEL_METERS,
  LAND_COVER_SPLAT_BAKE_WGSL,
  classifyLandCover,
  landCoverDryProvinceTerms,
  landCoverFarDesertRamp,
  landCoverFarDesertWeights,
  landCoverSuitabilities,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  DESERT_RIVER_SEDIMENT,
  resolveRiverConstituents,
  type InlandWaterEnvironment,
} from "../src/render/webgpu/water/WaterConstituents";
import {
  CLIMATE_PROVINCE,
  CLIMATE_PROVINCE_PRESETS,
  sampleClimateProvince,
  type ClimateProvinceName,
} from "../src/world/climateProvince";
import { TerrainBiome, createWorld, sampleTerrain } from "../src/world";
import { TERRAIN_REFERENCE_DAY_OF_YEAR } from "../src/world/terrain";

/**
 * **The dry provinces: high desert (sagebrush steppe) and oak savanna.**
 *
 * Both are data on the existing materials, species and water types, read from
 * the climate province's raw dryness offset. Every term is a product with a
 * share that is EXACTLY 0 at zero dryness, so the temperate core (where the
 * offset is exactly 0) and every one of its baselines are bit-identical. That
 * is the first thing this file pins; the second is that the forced provinces
 * actually read as the ecologies they claim, measured on a real world rather
 * than restated from the constants.
 */

const SLOPES = [0, 0.001, 0.004, 0.012, 0.03, 0.07, 0.12, 0.2, 0.3, 0.45];
const MOISTURES = [0.1, 0.25, 0.4, 0.55, 0.7, 0.9];
const ELEVATIONS = [3, 40, 180, 520, 1_100, 1_800];

function classifierInputs(): LandCoverInput[] {
  const inputs: LandCoverInput[] = [];
  for (const slope of SLOPES) {
    for (const moisture of MOISTURES) {
      for (const elevationMeters of ELEVATIONS) {
        inputs.push({
          elevationMeters,
          slope,
          moisture,
          temperature: 0.66 - elevationMeters / 2_450,
          aspect: 0.3,
          airportInfluence: 0,
          dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
          seasonalTemperatureShift: 0,
          canopyClosure: moisture * 0.6,
          grassCover: 0.5,
        });
      }
    }
  }
  return inputs;
}

function densityInputs(): VegetationDensityInput[] {
  const inputs: VegetationDensityInput[] = [];
  let index = 0;
  for (const slope of SLOPES) {
    for (const moisture of MOISTURES) {
      for (const heightMeters of ELEVATIONS) {
        index += 1;
        inputs.push({
          x: 1_731 + index * 97.3,
          z: -2_209 + index * 61.9,
          heightMeters,
          seaLevelMeters: 0,
          slope,
          moisture,
          normalX: 0.1,
          normalZ: -0.05,
          dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
          filterWidthMeters: 0,
        });
      }
    }
  }
  return inputs;
}

describe("the dry provinces leave the temperate core bit-identical", () => {
  it("reads both shares as exactly 0 at zero, wet or ordinary dryness", () => {
    for (const dryness of [0, -0.15, ...CLIMATE_PROVINCE.dryness.levels.filter((d) => d <= 0)]) {
      expect(dryProvinceShares(dryness)).toEqual({ arid: 0, parkland: 0 });
    }
  });

  it("makes every classifier term an identity element at zero dryness", () => {
    for (const slope of SLOPES) {
      for (const wetness of MOISTURES) {
        const terms = landCoverDryProvinceTerms(0, slope, wetness);
        expect(terms).toEqual({
          sand: 0, shrub: 0, gravel: 0, rock: 0, grassKeep: 1, dryGrassKeep: 1,
        });
      }
    }
  });

  it("scores every material identically with dryness 0 and with it omitted", () => {
    for (const input of classifierInputs()) {
      const omitted = landCoverSuitabilities(input);
      const zero = landCoverSuitabilities({ ...input, dryness: 0 });
      for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
        expect(Object.is(zero[id], omitted[id])).toBe(true);
      }
    }
  });

  it("plants the same density field with dryness 0 and with it omitted", () => {
    for (const input of densityInputs()) {
      expect(densityField(4_242, { ...input, dryness: 0 })).toEqual(densityField(4_242, input));
    }
  });

  it("keeps every blade and card of ground cover outside a desert", () => {
    for (const dryness of [-0.15, 0, 0.1, 0.25, CLIMATE_PROVINCE_PRESETS.savanna.dryness]) {
      expect(dryProvinceGroundCoverKeep(dryness)).toBe(1);
    }
    expect(dryProvinceGroundCoverKeep(0.5)).toBeCloseTo(DESERT_GROUND_COVER_KEEP, 12);
  });

  it("muddies no river with dryness 0", () => {
    const environment: InlandWaterEnvironment = {
      elevationAboveSeaMeters: 140, temperature: 0.55, moisture: 0.48,
    };
    expect(resolveRiverConstituents({ ...environment, dryness: 0 }, 22, 1.1, 0.004))
      .toEqual(resolveRiverConstituents(environment, 22, 1.1, 0.004));
  });

  it("leaves the far bake alone at zero dryness and on trusted pages", () => {
    const weights = [0.1, 0.05, 0.2, 0.05, 0.1, 0.1, 0.15, 0.1, 0.1, 0.05];
    expect(landCoverFarDesertWeights(weights, 0, 128)).toEqual(weights);
    expect(landCoverFarDesertWeights(weights, 0.5, LAND_COVER_FAR_DESERT_START_TEXEL_METERS))
      .toEqual(weights);
    expect(landCoverFarDesertWeights(weights, 0.5, 4)).toEqual(weights);
  });
});

describe("the province plateaus each land on one dry ecology", () => {
  it("makes the semi-arid plateau and the savanna preset full parkland", () => {
    const semiArid = CLIMATE_PROVINCE.dryness.levels[2]!;
    expect(semiArid).toBeGreaterThanOrEqual(DRY_PROVINCE_PARKLAND_FULL);
    expect(dryProvinceShares(semiArid)).toEqual({ arid: 0, parkland: 1 });
    expect(dryProvinceShares(CLIMATE_PROVINCE_PRESETS.savanna.dryness))
      .toEqual({ arid: 0, parkland: 1 });
  });

  it("makes the arid plateau and the high-desert preset full desert", () => {
    const arid = CLIMATE_PROVINCE.dryness.levels[3]!;
    expect(arid).toBeGreaterThanOrEqual(DRY_PROVINCE_DESERT_FULL);
    expect(dryProvinceShares(arid)).toEqual({ arid: 1, parkland: 0 });
    expect(dryProvinceShares(CLIMATE_PROVINCE_PRESETS["high-desert"].dryness))
      .toEqual({ arid: 1, parkland: 0 });
  });

  it("hands over between them without the shares ever summing past one", () => {
    for (let dryness = -0.2; dryness <= 0.6; dryness += 0.005) {
      const { arid, parkland } = dryProvinceShares(dryness);
      expect(arid).toBeGreaterThanOrEqual(0);
      expect(parkland).toBeGreaterThanOrEqual(0);
      expect(arid + parkland).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

interface ProvinceSurvey {
  readonly landProbes: number;
  readonly treesPerHectare: number;
  readonly shrubsPerHectare: number;
  /** Share of land probes each material is dominant on. */
  readonly dominant: readonly number[];
  /** Mean classifier weight of each material over the land probes. */
  readonly mean: readonly number[];
  /** Mean forest-edge (open-grown) form where trees stand. */
  readonly treeEdge: number;
}

/**
 * A 40 km survey around the start airport: forced provinces apply everywhere,
 * the natural world is the temperate core throughout.
 */
function surveyProvince(province: ClimateProvinceName | null): ProvinceSurvey {
  const world = province === null
    ? createWorld("open-skies")
    : createWorld("open-skies", { climateProvince: province });
  const airport = world.airport!;
  const dominant = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  const mean = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  let trees = 0;
  let shrubs = 0;
  let edgeWeighted = 0;
  let landProbes = 0;
  for (let dx = -20_000; dx <= 20_000; dx += 800) {
    for (let dz = -20_000; dz <= 20_000; dz += 800) {
      const x = airport.centerX + dx + 37;
      const z = airport.centerZ + dz + 11;
      const sample = sampleTerrain(world, x, z);
      if (sample.height <= world.seaLevel + 1 || sample.airportInfluence > 0) continue;
      const offsets = sampleClimateProvince(world, x, z);
      landProbes += 1;
      const field = densityField(world.sourceSeedHash, {
        x, z,
        heightMeters: sample.height,
        seaLevelMeters: world.seaLevel,
        slope: sample.slope,
        moisture: sample.moisture,
        normalX: sample.normal.x,
        normalZ: sample.normal.z,
        dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
        filterWidthMeters: 0,
        temperatureOffset: offsets.temperatureOffset,
        dryness: offsets.dryness,
      });
      const cover = classifyLandCover({
        elevationMeters: sample.height - world.seaLevel,
        slope: sample.slope,
        moisture: sample.moisture,
        temperature: sample.temperature,
        aspect: 0,
        airportInfluence: 0,
        dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
        seasonalTemperatureShift: 0,
        temperatureOffset: offsets.temperatureOffset,
        dryness: offsets.dryness,
        canopyClosure: canopyClosure(field.treeStemsPerSquareMeter),
        grassCover: field.groundCover?.grass,
      });
      dominant[cover.ids[0]!] = dominant[cover.ids[0]!]! + 1;
      cover.ids.forEach((id, slot) => { mean[id] = mean[id]! + (cover.weights[slot] ?? 0); });
      trees += field.treeStemsPerSquareMeter;
      shrubs += field.shrubStemsPerSquareMeter;
      edgeWeighted += field.treeStemsPerSquareMeter * field.forestEdge;
    }
  }
  return {
    landProbes,
    treesPerHectare: (trees / landProbes) * 1e4,
    shrubsPerHectare: (shrubs / landProbes) * 1e4,
    dominant: dominant.map((count) => count / landProbes),
    mean: mean.map((weight) => weight / landProbes),
    treeEdge: trees > 0 ? edgeWeighted / trees : 0,
  };
}

describe("a forced dry province reads as its ecology", () => {
  const temperate = surveyProvince(null);
  const desert = surveyProvince("high-desert");
  const savanna = surveyProvince("savanna");

  it("surveys enough land to mean something", () => {
    for (const survey of [temperate, desert, savanna]) {
      expect(survey.landProbes).toBeGreaterThan(800);
    }
    // The core is temperate: grass and forest floor, almost no bare ground.
    expect(temperate.dominant[SurfaceMaterial.Sand]!).toBeLessThan(0.02);
  });

  it("turns the high desert into tan bunchgrass, bare soil and rock instead of green grass", () => {
    // From the air a sagebrush steppe is tan: bunchgrass between grey-green
    // bushes that are too small to colour the ground at range (the bushes
    // themselves are drawn). Shrub, the dark olive material, is kept to the
    // damp swales; the first tuning let it take a third of the ground and the
    // forced desert rendered GREENER than the province's dried moisture alone.
    expect(desert.dominant[SurfaceMaterial.DryGrass]!).toBeGreaterThan(0.6);
    const bare = desert.dominant[SurfaceMaterial.Sand]!
      + desert.dominant[SurfaceMaterial.Gravel]!
      + desert.dominant[SurfaceMaterial.Rock]!;
    expect(bare).toBeGreaterThan(0.12);
    expect(desert.dominant[SurfaceMaterial.Sand]!).toBeGreaterThan(0.05);
    // ... and sand is a share of the basin floors, not the whole province.
    expect(desert.dominant[SurfaceMaterial.Sand]!).toBeLessThan(0.35);
    expect(desert.dominant[SurfaceMaterial.Shrub]!).toBeLessThan(0.1);
    expect(desert.mean[SurfaceMaterial.Shrub]!).toBeGreaterThan(0.04);
    expect(desert.mean[SurfaceMaterial.Shrub]!).toBeLessThan(0.2);
    expect(desert.dominant[SurfaceMaterial.Grass]!).toBeLessThan(0.05);
    expect(desert.dominant[SurfaceMaterial.ForestFloor]!).toBeLessThan(0.02);
  });

  it("leaves the desert a scatter of pinyon, never a forest", () => {
    expect(desert.treesPerHectare).toBeGreaterThan(1);
    expect(desert.treesPerHectare).toBeLessThan(temperate.treesPerHectare * 0.15);
  });

  it("turns the savanna into a straw-coloured sward with open-grown trees", () => {
    expect(savanna.dominant[SurfaceMaterial.DryGrass]!).toBeGreaterThan(0.55);
    expect(savanna.dominant[SurfaceMaterial.ForestFloor]!)
      .toBeLessThan(temperate.dominant[SurfaceMaterial.ForestFloor]! * 0.5);
    expect(savanna.treesPerHectare).toBeGreaterThan(temperate.treesPerHectare * 0.25);
    expect(savanna.treesPerHectare).toBeLessThan(temperate.treesPerHectare * 0.7);
    // Lone trees grow the spreading edge form; the temperate stands do not.
    expect(savanna.treeEdge).toBeGreaterThan(temperate.treeEdge + 0.2);
  });

  it("keeps vegetation density in check: no dry province plants more than the temperate core", () => {
    // Trees and shrubs are the instanced draws; the per-tier budgets scale the
    // same field, so a province under the core here is under it on every tier.
    for (const survey of [desert, savanna]) {
      expect(survey.treesPerHectare).toBeLessThan(temperate.treesPerHectare);
      expect(survey.treesPerHectare + survey.shrubsPerHectare)
        .toBeLessThan(temperate.treesPerHectare + temperate.shrubsPerHectare);
      // Shrubs alone stay within a fifth of the core's.
      expect(survey.shrubsPerHectare).toBeLessThan(temperate.shrubsPerHectare * 1.2);
    }
  });
});

describe("the far desert keeps its colour where the fragment trusts only swards", () => {
  it("hands sand, gravel and rock to dry grass on zero-trust pages, conserving weight", () => {
    const weights = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
    weights[SurfaceMaterial.Sand] = 0.4;
    weights[SurfaceMaterial.Shrub] = 0.35;
    weights[SurfaceMaterial.Gravel] = 0.1;
    weights[SurfaceMaterial.Rock] = 0.15;
    const far = landCoverFarDesertWeights(weights, 0.5, LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS);
    expect(far[SurfaceMaterial.Sand]).toBe(0);
    expect(far[SurfaceMaterial.Gravel]).toBe(0);
    expect(far[SurfaceMaterial.Rock]).toBe(0);
    expect(far[SurfaceMaterial.Shrub]).toBe(0.35);
    expect(far[SurfaceMaterial.DryGrass]).toBeCloseTo(0.65, 12);
    expect(far.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("ramps over the levels instead of switching at one, so it draws no ring", () => {
    // Linear in level: none at L2's 16 m texels, a third at L3, two thirds at
    // L4, all of it from L5's 128 m.
    expect(landCoverFarDesertRamp(16)).toBe(0);
    expect(landCoverFarDesertRamp(32)).toBeCloseTo(1 / 3, 12);
    expect(landCoverFarDesertRamp(64)).toBeCloseTo(2 / 3, 12);
    expect(landCoverFarDesertRamp(128)).toBe(1);
    expect(landCoverFarDesertRamp(512)).toBe(1);
    const weights = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
    weights[SurfaceMaterial.Sand] = 0.6;
    weights[SurfaceMaterial.DryGrass] = 0.4;
    const l4 = landCoverFarDesertWeights(weights, 0.5, 64);
    expect(l4[SurfaceMaterial.Sand]).toBeCloseTo(0.2, 12);
    expect(l4[SurfaceMaterial.DryGrass]).toBeCloseTo(0.8, 12);
  });

  it("is the bake's own branch, gated on the same ramp and desert share", () => {
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      `if (job.shape.x > ${LAND_COVER_FAR_DESERT_START_TEXEL_METERS.toFixed(1)}) {`);
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      `let farRamp = kSaturate(log2(job.shape.x / ${LAND_COVER_FAR_DESERT_START_TEXEL_METERS.toFixed(1)})`);
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      "let farArid = kSmoothstep(LAND_COVER_DESERT_ONSET, LAND_COVER_DESERT_FULL, province.y) * farRamp;");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      `accumulated[${SurfaceMaterial.DryGrass}] = accumulated[${SurfaceMaterial.DryGrass}] + moved;`);
  });
});

describe("the WGSL twins carry the same dry laws", () => {
  it("injects the classifier's table rather than restating it", () => {
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("fn landCoverDryProvinceTerms(");
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("struct LandCoverDryProvinceTerms");
    for (const value of Object.values(LAND_COVER_DRY_PROVINCE)) {
      const literal = Number.isInteger(value) ? `${value}.0` : String(value);
      expect(LAND_COVER_CLASSIFIER_WGSL).toContain(literal);
    }
    for (const marker of [
      "* desert.grassKeep", "* desert.dryGrassKeep", "desert.sand", "desert.shrub",
      "desert.gravel", "desert.rock",
    ]) {
      expect(LAND_COVER_CLASSIFIER_WGSL).toContain(marker);
    }
  });

  it("feeds the bake's density drivers the texel's dryness", () => {
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("drivers.dryness = dryness;");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toMatch(
      /splatCanopyAt\(job, localX \+ tapDx, localZ \+ tapDz, tapMoisture, province\.x, province\.y\)/u);
  });

  it("mirrors the density field's stands and bush", () => {
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("fn vegetationDryProvinceShares(");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("parklandStems + pinyonStems");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(
      "max(forestEdge, parkland * VEG_PARKLAND_OPEN_GROWN_EDGE)");
    for (const value of [
      PARKLAND_TREE_SHARE, DESERT_TREE_SHARE, DESERT_SHRUB_SHARE, PARKLAND_SHRUB_SHARE,
    ]) {
      expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(String(value));
    }
  });
});

function dryTerrain(dryness: number, temperatureOffset: number, moisture: number): DetailTerrainSampler {
  return (x, z) => ({
    height: 160 + Math.sin(x * 0.002) * 3 + Math.cos(z * 0.0025) * 2,
    slope: 0.05,
    moisture,
    biome: TerrainBiome.GRASSLAND,
    dryness,
    temperatureOffset,
  });
}

function speciesCounts(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

describe("the dry provinces draw their own species", () => {
  function cells(terrainSample: DetailTerrainSampler) {
    const trees: string[] = [];
    const shrubs: string[] = [];
    for (let cellX = 0; cellX < 6; cellX += 1) {
      for (let cellZ = 0; cellZ < 6; cellZ += 1) {
        const cell = generateDetailCell({
          worldSeed: "dry-species", cellX, cellZ, terrainSample,
        });
        trees.push(...cell.trees.map((tree) => tree.species));
        shrubs.push(...cell.shrubs.map((shrub) => shrub.species));
      }
    }
    return { trees: speciesCounts(trees), shrubs: speciesCounts(shrubs) };
  }

  it("grows pinyon-juniper and sage in the high desert", () => {
    const { trees, shrubs } = cells(dryTerrain(0.5, 0, 0.25));
    const treeTotal = [...trees.values()].reduce((a, b) => a + b, 0);
    expect(treeTotal).toBeGreaterThan(0);
    expect([...trees.keys()].sort()).toEqual(["cedar", "pine"]);
    const shrubTotal = [...shrubs.values()].reduce((a, b) => a + b, 0);
    expect(shrubs.get("sage") ?? 0).toBeGreaterThan(shrubTotal * 0.6);
    expect(shrubs.get("hazel") ?? 0).toBe(0);
  });

  it("grows open oaks in the warm savanna", () => {
    const { trees } = cells(dryTerrain(0.25, 0.12, 0.38));
    const total = [...trees.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10);
    expect(trees.get("oak") ?? 0).toBeGreaterThan(total * 0.7);
  });

  it("grows aspen parkland, not oaks, where the semi-arid province is cold", () => {
    const { trees } = cells(dryTerrain(0.25, -0.22, 0.38));
    const total = [...trees.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10);
    expect(trees.get("oak") ?? 0).toBe(0);
    expect(trees.get("birch") ?? 0).toBeGreaterThan(total * 0.55);
  });

  it("muddies a desert river towards the validated muddy type", () => {
    const environment: InlandWaterEnvironment = {
      elevationAboveSeaMeters: 900, temperature: 0.52, moisture: 0.22,
    };
    const clear = resolveRiverConstituents(environment, 18, 1.2, 0.006);
    const desert = resolveRiverConstituents({ ...environment, dryness: 0.5 }, 18, 1.2, 0.006);
    const gained = desert.sediment - clear.sediment;
    expect(gained).toBeGreaterThan(DESERT_RIVER_SEDIMENT * 0.35);
    expect(gained).toBeLessThanOrEqual(DESERT_RIVER_SEDIMENT);
  });
});
