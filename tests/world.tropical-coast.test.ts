import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { TerrainBiome, createWorld } from "../src/world";
import {
  CLIMATE_PROVINCE_PRESETS,
  sampleClimateProvinceUnmasked,
} from "../src/world/climateProvince";
import { hashSeed } from "../src/world/seed";
import {
  TROPICAL_COAST,
  TROPICAL_COAST_WGSL,
  tropicalCoastWeight,
} from "../src/world/tropicalCoast";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  LAND_COVER_CLASSIFIER_WGSL,
  classifyLandCover,
  landCoverWeightOf,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  WaterEnvironmentField,
  waterBedCarbonate,
  waterRunoff,
} from "../src/render/webgpu/water/WaterEnvironmentField";
import { WATER_DEPTH_OPTICS_WGSL } from "../src/render/webgpu/water/WaterShaders";
import {
  WATER_FRAGMENT_WGSL,
  WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/SpectralOceanSystem";
import { HYDROLOGY_WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/HydrologySystem";
import { TREE_SPECIES_COHORTS } from "../src/render/webgpu/detail/treePrototypeFamily";
import type {
  DetailTerrainSampler,
  TreeSpecies,
} from "../src/render/webgpu/detail/types";

const CONIFERS_AND_WILLOW: ReadonlySet<TreeSpecies> = new Set([
  "pine", "cedar", "spruce", "willow",
]);

/** A wet lowland forest a few metres to a few tens of metres above the sea. */
function lowlandForest(
  province: { readonly temperatureOffset: number; readonly dryness: number } | null,
  baseHeight = 14,
): DetailTerrainSampler {
  return (x, z) => ({
    height: baseHeight + Math.sin(x * 0.004) * 6 + Math.cos(z * 0.005) * 4,
    slope: 0.04,
    moisture: 0.7,
    biome: TerrainBiome.FOREST,
    ...(province ?? {}),
  });
}

function speciesOf(
  province: { readonly temperatureOffset: number; readonly dryness: number } | null,
  options: { readonly dayOfYear?: number; readonly baseHeight?: number } = {},
) {
  const trees = [];
  for (let cell = 0; cell < 3; cell += 1) {
    trees.push(...generateDetailCell({
      worldSeed: "tropical-coast",
      cellX: cell,
      cellZ: -cell,
      seaLevelMeters: 0,
      terrainSample: lowlandForest(province, options.baseHeight),
      ...(options.dayOfYear === undefined ? {} : { dayOfYear: options.dayOfYear }),
    }).trees);
  }
  return trees;
}

/** The temperature offset at which the tropical weight is `weight` (wet ground). */
function offsetForWeight(weight: number): number {
  let low: number = TROPICAL_COAST.temperatureStart;
  let high: number = TROPICAL_COAST.temperatureFull;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (tropicalCoastWeight(middle, -0.15) < weight) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

describe("tropical coast weight", () => {
  it("is exactly 0 in the temperate core, on the warm plateau and in the dry provinces", () => {
    expect(tropicalCoastWeight(0, 0)).toBe(0);
    expect(tropicalCoastWeight(0.12, -0.15)).toBe(0);
    expect(tropicalCoastWeight(TROPICAL_COAST.temperatureStart, -0.15)).toBe(0);
    const savanna = CLIMATE_PROVINCE_PRESETS.savanna;
    expect(tropicalCoastWeight(savanna.temperatureOffset, savanna.dryness)).toBe(0);
    expect(tropicalCoastWeight(0.28, 0.25)).toBe(0);
    expect(tropicalCoastWeight(0.28, 0.5)).toBe(0);
    for (const preset of ["boreal", "tundra", "high-desert"] as const) {
      const row = CLIMATE_PROVINCE_PRESETS[preset];
      expect(tropicalCoastWeight(row.temperatureOffset, row.dryness), preset).toBe(0);
    }
  });

  it("is full on the tropical preset and on hot, ordinary ground", () => {
    const tropical = CLIMATE_PROVINCE_PRESETS.tropical;
    expect(tropicalCoastWeight(tropical.temperatureOffset, tropical.dryness)).toBe(1);
    expect(tropicalCoastWeight(0.28, 0)).toBe(1);
    expect(tropicalCoastWeight(0.2, 0)).toBeGreaterThan(0.3);
    expect(tropicalCoastWeight(0.2, 0)).toBeLessThan(0.7);
  });

  it("carries the same constants into the bake's WGSL twin", () => {
    expect(TROPICAL_COAST_WGSL).toContain(
      `kSmoothstep(${TROPICAL_COAST.temperatureStart.toFixed(2)}, ${TROPICAL_COAST.temperatureFull.toFixed(2)}, temperatureOffset)`,
    );
    expect(TROPICAL_COAST_WGSL).toContain(
      `kSmoothstep(${TROPICAL_COAST.drynessStart.toFixed(2)}, ${TROPICAL_COAST.drynessEnd.toFixed(2)}, dryness)`,
    );
  });
});

describe("tropical coast trees", () => {
  it("leaves the temperate core's stems exactly as they were", () => {
    expect(speciesOf({ temperatureOffset: 0, dryness: 0 })).toEqual(speciesOf(null));
  });

  it("grows palms and broadleaf, and no conifer or willow, in the tropics", () => {
    const trees = speciesOf(CLIMATE_PROVINCE_PRESETS.tropical);
    const species = new Set(trees.map((tree) => tree.species));
    expect(trees.length).toBeGreaterThan(200);
    expect(species.has("palm")).toBe(true);
    for (const excluded of CONIFERS_AND_WILLOW) expect(species.has(excluded), excluded).toBe(false);
    const tropicalCohort = TREE_SPECIES_COHORTS.find((cohort) => cohort.includes("palm"))!;
    for (const name of species) expect(tropicalCohort).toContain(name);
    const palmShare = trees.filter((tree) => tree.species === "palm").length / trees.length;
    expect(palmShare).toBeGreaterThan(0.3);
    expect(palmShare).toBeLessThan(0.95);
  });

  it("keeps palms on the lowlands", () => {
    const upland = speciesOf(CLIMATE_PROVINCE_PRESETS.tropical, { baseHeight: 600 });
    expect(upland.length).toBeGreaterThan(50);
    expect(upland.some((tree) => tree.species === "palm")).toBe(false);
  });

  it("grows broadleaf alone in the belt between the cohorts", () => {
    for (const weight of [TROPICAL_COAST.broadleafOnlyWeight + 0.02, 0.5, TROPICAL_COAST.palmWeight - 0.02]) {
      const species = new Set(
        speciesOf({ temperatureOffset: offsetForWeight(weight), dryness: -0.15 })
          .map((tree) => tree.species),
      );
      for (const excluded of [...CONIFERS_AND_WILLOW, "palm" as const]) {
        expect(species.has(excluded), `${excluded} at weight ${weight}`).toBe(false);
      }
    }
  });

  it("keeps the tropical broadleaf in leaf through the northern winter", () => {
    const tropical = speciesOf(CLIMATE_PROVINCE_PRESETS.tropical, { dayOfYear: 355 });
    const broadleaf = tropical.filter((tree) => tree.species !== "palm");
    expect(broadleaf.length).toBeGreaterThan(20);
    // A full leaf fraction is also what keeps the far band's impostor off its
    // bare bucket (the shader's tint veto).
    for (const tree of broadleaf) expect(tree.color[3], tree.species).toBe(1);
    const temperate = speciesOf(null, { dayOfYear: 355 })
      .filter((tree) => tree.species === "oak" || tree.species === "maple");
    expect(temperate.length).toBeGreaterThan(20);
    expect(temperate.every((tree) => tree.color[3] < 0.5)).toBe(true);
  });
});

describe("tropical cohort separation on the natural province field", () => {
  it("keeps the palm line and the conifer line apart over almost all of the world", () => {
    // Positions whose tier-1 mid-band disk (1.1 km, priced as a 1.5 km box)
    // holds both a palm-capable and a conifer-capable point. Measured on five
    // seeds over 400 km squares: 0.05-2.0% of the world. One seed here (the one
    // with the most tropical ground of the five), a
    // 240 km square, to keep the test fast.
    const step = 500;
    const n = 480;
    const radius = 3;
    const seedHash = hashSeed("a");
    const target = { temperatureOffset: 0, dryness: 0 };
    const palm = new Int32Array((n + 1) * (n + 1));
    const conifer = new Int32Array((n + 1) * (n + 1));
    let palmPoints = 0;
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        sampleClimateProvinceUnmasked(seedHash, (i - n / 2) * step, (j - n / 2) * step, target);
        const weight = tropicalCoastWeight(target.temperatureOffset, target.dryness);
        const p = weight > TROPICAL_COAST.palmWeight ? 1 : 0;
        const c = weight < TROPICAL_COAST.broadleafOnlyWeight ? 1 : 0;
        palmPoints += p;
        const at = (j + 1) * (n + 1) + i + 1;
        palm[at] = p + palm[at - 1]! + palm[at - n - 1]! - palm[at - n - 2]!;
        conifer[at] = c + conifer[at - 1]! + conifer[at - n - 1]! - conifer[at - n - 2]!;
      }
    }
    const box = (table: Int32Array, i: number, j: number) => {
      const i0 = i - radius;
      const j0 = j - radius;
      const i1 = i + radius + 1;
      const j1 = j + radius + 1;
      return table[j1 * (n + 1) + i1]! - table[j0 * (n + 1) + i1]!
        - table[j1 * (n + 1) + i0]! + table[j0 * (n + 1) + i0]!;
    };
    let both = 0;
    let total = 0;
    for (let j = radius; j < n - radius; j += 1) {
      for (let i = radius; i < n - radius; i += 1) {
        total += 1;
        if (box(palm, i, j) > 0 && box(conifer, i, j) > 0) both += 1;
      }
    }
    // Non-vacuous: this square does grow palms.
    expect(palmPoints / (n * n)).toBeGreaterThan(0.02);
    expect(both / total).toBeLessThan(0.025);
  });
});

describe("tropical coast ground and water", () => {
  function shoreInput(
    elevationMeters: number,
    province: { readonly temperatureOffset: number; readonly dryness: number },
  ): LandCoverInput {
    return {
      elevationMeters,
      slope: 0.03,
      moisture: 0.62,
      temperature: 0.66 + province.temperatureOffset,
      aspect: 0,
      airportInfluence: 0,
      dayOfYear: 172,
      seasonalTemperatureShift: 0,
      temperatureOffset: province.temperatureOffset,
      dryness: province.dryness,
    };
  }

  it("leaves the temperate shore band exactly as it was", () => {
    for (const elevation of [-0.5, 0.5, 1.5, 2.5, 4, 6]) {
      const input = shoreInput(elevation, { temperatureOffset: 0, dryness: 0 });
      const withoutProvince: LandCoverInput = { ...input };
      delete (withoutProvince as { temperatureOffset?: number }).temperatureOffset;
      delete (withoutProvince as { dryness?: number }).dryness;
      expect(classifyLandCover(input)).toEqual(classifyLandCover(withoutProvince));
    }
  });

  it("widens the beach to a ridge of about 5 m and drops the wave-washed gravel", () => {
    const tropical = CLIMATE_PROVINCE_PRESETS.tropical;
    const sand = (elevation: number, province: typeof tropical) => landCoverWeightOf(
      classifyLandCover(shoreInput(elevation, province)),
      SurfaceMaterial.Sand,
    );
    const gravel = (elevation: number, province: typeof tropical) => landCoverWeightOf(
      classifyLandCover(shoreInput(elevation, province)),
      SurfaceMaterial.Gravel,
    );
    const temperate = CLIMATE_PROVINCE_PRESETS.temperate;
    // At 2.5 m a temperate shore is already grass; a tropical one is beach.
    expect(sand(2.5, temperate)).toBeLessThan(0.1);
    expect(sand(2.5, tropical)).toBeGreaterThan(0.6);
    expect(sand(3.5, tropical)).toBeGreaterThan(0.4);
    // Above the ridge both are land again.
    expect(sand(8, tropical)).toBeLessThan(0.05);
    for (const elevation of [0.5, 1, 1.5, 2, 3]) {
      expect(gravel(elevation, tropical), `${elevation} m`)
        .toBeLessThanOrEqual(gravel(elevation, temperate));
    }
  });

  it("mirrors the beach into the bake's WGSL twin", () => {
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("fn tropicalCoastWeight(");
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      "let tropical = tropicalCoastWeight(input.temperatureOffset, input.dryness);",
    );
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `kSmoothstep(-1.0, 3.0 + ${TROPICAL_COAST.beachExtraMeters}.0 * tropical, elevation)`,
    );
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("(1.0 - shore) * 0.4 * (1.0 - tropical)");
  });

  it("keeps a tropical coast's runoff offshore and leaves every other coast's alone", () => {
    for (const moisture of [0, 0.3, 0.62, 0.9, 1]) {
      expect(waterRunoff(moisture, 0)).toBe(waterRunoff(moisture));
    }
    expect(waterRunoff(0.8, 1)).toBeCloseTo(0.8 * (1 - TROPICAL_COAST.lagoonRunoffCut), 12);
    // Below the ocean shader's contrast floor (0.18), so the coast reads as
    // the clearest water the model makes.
    expect(waterRunoff(0.85, 1)).toBeLessThan(0.18);
  });

  it("lays a carbonate bed under tropical water and nowhere else", () => {
    expect(waterBedCarbonate(0)).toBe(0);
    expect(waterBedCarbonate(1)).toBe(1);
    const bakedCarbonate = (world: ReturnType<typeof createWorld>) => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const field = new WaterEnvironmentField(scene, world);
      field.update(0, 0);
      // The bytes the field uploads (NullEngine textures keep no copy).
      const data = (field as unknown as { readonly data: Uint8Array }).data;
      expect(data.length).toBeGreaterThan(0);
      const blue = new Set<number>();
      for (let offset = 2; offset < data.length; offset += 4) blue.add(data[offset]!);
      field.dispose();
      scene.dispose();
      engine.dispose();
      return blue;
    };
    // The core and every province but the tropics carry a zero B channel,
    // which the bed reads as `mix(x, y, 0)`: the bed it always was.
    expect([...bakedCarbonate(createWorld("phase1-perf-baseline", { climateProvince: "temperate" }))])
      .toEqual([0]);
    expect([...bakedCarbonate(createWorld("phase1-perf-baseline", { climateProvince: "savanna" }))])
      .toEqual([0]);
    expect([...bakedCarbonate(createWorld("phase1-perf-baseline", { climateProvince: "tropical" }))])
      .toEqual([255]);
  });

  it("threads the carbonate from the field to the bed, and none into inland water", () => {
    expect(WATER_DEPTH_OPTICS_WGSL).toContain(
      "analyticWaterBedAlbedo(bedXZ, bedElevation, bedWetness, bedCarbonate)",
    );
    expect(WATER_DEPTH_OPTICS_WGSL).toContain(
      "mix(mineral * 0.32, 0.7 + 0.25 * mineral, carbonate)",
    );
    // The ocean reads it from the field's B channel at the vertex...
    expect(WATER_VERTEX_WGSL).toContain(").xyz;");
    expect(WATER_VERTEX_WGSL).toContain("varying waterProvince: vec4f;");
    expect(WATER_FRAGMENT_WGSL).toContain("input.waterProvince.w,");
    // ...and inland water, whose bed is the catchment's silt, passes 0.0.
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toMatch(/0\.75,\n\s*0\.0,\n\s*downwelling,/u);
  });
});
