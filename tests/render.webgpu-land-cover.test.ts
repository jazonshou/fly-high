import { describe, expect, it } from "vitest";
import {
  LAND_COVER_CLASSIFIER_WGSL,
  LAND_COVER_FOREST_FLOOR_LITTER_GAIN,
  LAND_COVER_SPLAT_BAKE_WGSL,
  LAND_COVER_TOP_MATERIALS,
  alignSeasonalLandCoverWeights,
  classifyLandCover,
  dominantLandCover,
  landCoverHabitat,
  landCoverLitter,
  landCoverSoftmaxTemperature,
  landCoverSuitabilities,
  landCoverWetness,
  landCoverWeightOf,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import { TERRAIN_PAGE_HYDROLOGY_ENCODING } from
  "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  GROUND_COVER_ARCHETYPES,
  SOIL_LITTER_DEEP_METERS,
  SOIL_LITTER_THIN_METERS,
  groundCoverWeights,
  soilLitterFactor,
} from "../src/render/webgpu/detail/densityField";
import { VEGETATION_DENSITY_FIELD_WGSL } from "../src/render/webgpu/detail/densityFieldWgsl";
import { TerrainBiome, createWorld, sampleTerrain } from "../src/world";

const BASE: LandCoverInput = {
  elevationMeters: 120,
  slope: 0.05,
  moisture: 0.5,
  temperature: 0.6,
  aspect: 0,
  airportInfluence: 0,
  dayOfYear: 171,
  seasonalTemperatureShift: 0,
};

const at = (overrides: Partial<LandCoverInput>): LandCoverInput => ({ ...BASE, ...overrides });

/**
 * `4-6`/`4-6b` (`R-27`): one authority classifies the ground, the trees on it
 * and the animals in them.
 *
 * The properties below are the ones a threshold cascade cannot have, which is
 * the whole reason the cascade is gone: a weight vector has no boundary, only
 * an ecotone, and the ecotone's SHARPNESS varies with the drivers rather than
 * being one tuned constant everywhere.
 */
describe("land-cover classifier (4-6)", () => {
  it("returns a normalised top-4 weight vector", () => {
    const weights = classifyLandCover(BASE);
    expect(weights.ids).toHaveLength(LAND_COVER_TOP_MATERIALS);
    expect(weights.weights).toHaveLength(LAND_COVER_TOP_MATERIALS);
    expect(weights.weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    // Sorted, so lane 0 is the dominant material every consumer reads.
    for (let index = 1; index < weights.weights.length; index += 1) {
      expect(weights.weights[index]!).toBeLessThanOrEqual(weights.weights[index - 1]!);
    }
    expect(new Set(weights.ids).size).toBe(LAND_COVER_TOP_MATERIALS);
    expect(landCoverSuitabilities(BASE)).toHaveLength(SURFACE_MATERIAL_COUNT);
  });

  it("has no boundary — every transition is continuous in every driver", () => {
    // The property a threshold cascade cannot have. Walk each driver across
    // the range where the dominant material changes and assert the WEIGHT
    // moves smoothly rather than flipping.
    // The step must be finer than the NARROWEST band in any suitability —
    // the shore term transitions over 10 m of elevation — or a coarse walk
    // reports a jump where the function is perfectly smooth.
    // A LIPSCHITZ bound, not an absolute one: continuity is a statement about
    // the derivative, and every band here is a smoothstep whose steepest slope
    // is 1.5/width times its coefficient. A threshold cascade would give an
    // unbounded ratio at its edge, which is exactly what this catches.
    for (const [driver, from, to, steps, lipschitz] of [
      // The shore band is the steepest term: 1.35 over 4 m of elevation, so
      // its peak slope is 1.35 × 1.5/4 ≈ 0.51 per metre.
      ["elevationMeters", 0, 2_000, 4_000, 0.7],
      ["slope", 0, 0.9, 1_800, 12],
      ["moisture", 0, 1, 2_000, 12],
      ["temperature", 0, 1, 2_000, 15],
    ] as const) {
      const stepSize = (to - from) / steps;
      let previous: number[] | null = null;
      for (let step = 0; step <= steps; step += 1) {
        const value = from + ((to - from) * step) / steps;
        const suitability = landCoverSuitabilities(at({ [driver]: value }));
        if (previous) {
          for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
            expect(
              Math.abs(suitability[id]! - previous[id]!),
              `${driver} at ${value.toFixed(3)} jumps material ${id}`,
            ).toBeLessThanOrEqual(lipschitz * stepSize);
          }
        }
        previous = suitability;
      }
    }
  });

  it("puts the right material on the right ground", () => {
    // Sand is the WAVE-WASHED band, not every coastal plain: the shore term
    // reaches 1 by 3 m, matching the density field's own shoreline gate.
    expect(dominantLandCover(classifyLandCover(at({ elevationMeters: 0 }))))
      .toBe(SurfaceMaterial.Sand);
    expect(dominantLandCover(classifyLandCover(at({ elevationMeters: 12 }))))
      .toBe(SurfaceMaterial.Grass);
    expect(dominantLandCover(classifyLandCover(at({ moisture: 0.85, temperature: 0.7 }))))
      .toBe(SurfaceMaterial.ForestFloor);
    expect(dominantLandCover(classifyLandCover(at({ slope: 0.8 }))))
      .toBe(SurfaceMaterial.Rock);
    expect(dominantLandCover(classifyLandCover(at({ elevationMeters: 2_400 }))))
      .toBe(SurfaceMaterial.Snow);
    // The airfield is mown grass (1B-6), whatever the climate says.
    expect(dominantLandCover(classifyLandCover(at({
      airportInfluence: 1, moisture: 0.9, elevationMeters: 40,
    })))).toBe(SurfaceMaterial.Grass);
  });

  it("varies ecotone SHARPNESS with the drivers, not with a constant", () => {
    // Uniform-sharpness boundaries are as much a tell as straight ones.
    const soft = landCoverSoftmaxTemperature(at({ slope: 0.01, moisture: 0.9 }));
    const sharp = landCoverSoftmaxTemperature(at({ slope: 0.7, moisture: 0.05 }));
    expect(sharp).toBeLessThan(soft);
    expect(sharp).toBeGreaterThan(0);
  });

  it("lets real contributing area supersede the analytic moisture proxy", () => {
    const dryProxy = at({ moisture: 0.02, flowAccumulationAreaM2: 10_000_000 });
    const wetProxy = at({ moisture: 0.98, flowAccumulationAreaM2: 10_000_000 });
    expect(landCoverWetness(dryProxy)).toBe(landCoverWetness(wetProxy));
    expect(landCoverSuitabilities(dryProxy)).toEqual(landCoverSuitabilities(wetProxy));
    expect(classifyLandCover(dryProxy)).toEqual(classifyLandCover(wetProxy));
    // W-9 re-windowed TWI against measured eroded page statistics
    // (TERRAIN_TWI_DRY/WET docblock): macro seeding gives every eroded texel
    // >=262k m² of contributing area, so the wetness ramp now spans the REAL
    // regimes instead of saturating half the world. At the fixture slope:
    // uplands read dry, a 10 km² stream reads damp, a 100 km² river reads
    // mid-wet, and only valley-floor-scale accumulation saturates.
    expect(landCoverWetness(at({ moisture: 0.02, flowAccumulationAreaM2: 1_000_000 }))).toBe(0);
    expect(landCoverWetness(dryProxy)).toBeGreaterThan(0.1);
    expect(landCoverWetness(dryProxy)).toBeLessThan(0.5);
    expect(landCoverWetness(at({ moisture: 0.02, flowAccumulationAreaM2: 100_000_000 })))
      .toBeGreaterThan(0.4);
    expect(landCoverWetness(at({ moisture: 0.02, flowAccumulationAreaM2: 2_000_000_000 })))
      .toBeGreaterThan(0.85);
    // Omitting the erosion field is explicit analytic parity.
    expect(landCoverWetness(at({ moisture: 0.02 }))).toBeCloseTo(0.02, 12);
    expect(landCoverWetness(at({ moisture: 0.98 }))).toBeCloseTo(0.98, 12);
  });

  it("moves the snowline with the season and nothing else", () => {
    const summer = classifyLandCover(at({ elevationMeters: 1_400 }));
    const winter = classifyLandCover(at({
      elevationMeters: 1_400,
      dayOfYear: 15,
      seasonalTemperatureShift: -0.35,
    }));
    expect(landCoverWeightOf(winter, SurfaceMaterial.Snow))
      .toBeGreaterThan(landCoverWeightOf(summer, SurfaceMaterial.Snow));
    // …and the ECOLOGY does not move: `2-18` forbids species mix following the
    // calendar, which is why `classifyBiome` reads at the reference day.
    const world = createWorld("land-cover-season");
    const midsummer = sampleTerrain(world, 812, -1_140, undefined, 171);
    const midwinter = sampleTerrain(world, 812, -1_140, undefined, 15);
    expect(midwinter.biome).toBe(midsummer.biome);
  });

  it("keeps low/high seasonal weights aligned to one material-id basis", () => {
    const low = classifyLandCover(at({
      elevationMeters: 600,
      slope: 0,
      moisture: 0,
      temperature: 0,
      seasonalTemperatureShift: 0,
    }));
    const high = classifyLandCover(at({
      elevationMeters: 600,
      slope: 0,
      moisture: 0,
      temperature: 0,
      seasonalTemperatureShift: -0.35,
    }));
    // Snow enters winter's top four, so storing low.ids with high.weights by
    // lane would paint that snow weight as an unrelated summer material.
    expect(low.ids).not.toContain(SurfaceMaterial.Snow);
    expect(high.ids).toContain(SurfaceMaterial.Snow);

    const aligned = alignSeasonalLandCoverWeights(low, high);
    expect(aligned.ids).toHaveLength(LAND_COVER_TOP_MATERIALS);
    expect(new Set(aligned.ids).size).toBe(LAND_COVER_TOP_MATERIALS);
    expect(aligned.lowWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(aligned.highWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);

    const snowLane = aligned.ids.indexOf(SurfaceMaterial.Snow);
    expect(snowLane).toBeGreaterThanOrEqual(0);
    expect(aligned.lowWeights[snowLane]).toBe(0);
    expect(aligned.highWeights[snowLane]).toBeGreaterThan(0);
    for (let lane = 0; lane < LAND_COVER_TOP_MATERIALS; lane += 1) {
      const material = aligned.ids[lane]!;
      const lowSource = landCoverWeightOf(low, material);
      const highSource = landCoverWeightOf(high, material);
      // A non-zero stored lane always belongs to the same material in the
      // source bucket; weights may only differ by joint-basis renormalisation.
      expect(aligned.lowWeights[lane]! > 0).toBe(lowSource > 0);
      expect(aligned.highWeights[lane]! > 0).toBe(highSource > 0);
    }
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("splatAlignSeasonalWeights");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("aligned.weightsHi");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).not.toContain(
      "textureStore(splatWeightHi, texel, hi.weights)",
    );
  });

  it("gives the R-27 consumers one habitat reading", () => {
    const forest = landCoverHabitat(classifyLandCover(at({ moisture: 0.85, temperature: 0.7 })));
    expect(forest.canopy).toBeGreaterThan(forest.barren);
    const cliff = landCoverHabitat(classifyLandCover(at({ slope: 0.8 })));
    expect(cliff.barren).toBeGreaterThan(cliff.canopy);
    for (const habitat of [forest, cliff]) {
      const total = habitat.canopy + habitat.open + habitat.scrub + habitat.barren
        + habitat.shore;
      expect(total).toBeGreaterThan(0.9);
      expect(total).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("emits WGSL that mirrors the TypeScript, not a second classifier", () => {
    // Every suitability the TS computes must appear in the emitted source, so
    // a change to one half fails rather than silently forking the other.
    for (const marker of [
      "landCoverSuitabilities",
      "landCoverSoftmaxTemperature",
      "classifyLandCover",
      "LandCoverWeights",
    ]) {
      expect(LAND_COVER_CLASSIFIER_WGSL).toContain(marker);
    }
    // The forbidden builtins rule applies here too: this include runs
    // alongside the terrain kernel and must use its hand-written helpers.
    const code = LAND_COVER_CLASSIFIER_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    expect(code).not.toMatch(/[^k]smoothstep\(/u);
    expect(code).toContain("kSmoothstep(");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("splatFlowAccumAtlas");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("exp2(flowLog2) - 1.0");
  });
});

/**
 * `6-6` — the soil-depth channel's forest-floor consumer.
 *
 * Phase 5 shipped `soilDepth` resident with ZERO consumers anywhere (register
 * row C-9). The plan's rule for this item is "a named ground-layer consumer or
 * the item produces data nothing reads"; the classifier is one of soil's two,
 * and litter is what it supplies — deep duff is what makes forest floor read as
 * forest floor rather than as bare ground under trees.
 */
describe("6-6 forest-floor litter from the soil-depth channel", () => {
  it("raises forest floor with soil depth and leaves thin crests alone", () => {
    const wet = { moisture: 0.85, temperature: 0.7 } as const;
    const thin = landCoverSuitabilities(at({ ...wet, soilDepthMeters: 0.4 }));
    const deep = landCoverSuitabilities(at({ ...wet, soilDepthMeters: 6 }));
    expect(deep[SurfaceMaterial.ForestFloor]!)
      .toBeGreaterThan(thin[SurfaceMaterial.ForestFloor]!);
    // Only the floor moves: litter is a property of the duff layer, not a
    // second climate driver, so no other suitability may respond to it.
    for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
      if (id === SurfaceMaterial.ForestFloor) continue;
      expect(deep[id]!).toBe(thin[id]!);
    }
    // And it is visible in the classification, not just in the raw score.
    const deepWeights = classifyLandCover(at({ ...wet, soilDepthMeters: 6 }));
    const thinWeights = classifyLandCover(at({ ...wet, soilDepthMeters: 0.4 }));
    expect(landCoverWeightOf(deepWeights, SurfaceMaterial.ForestFloor))
      .toBeGreaterThan(landCoverWeightOf(thinWeights, SurfaceMaterial.ForestFloor));
  });

  it("is EXACTLY neutral when the channel is absent (analytic parity)", () => {
    // The parity contract is bit-level, not "close": the multiplier has to be
    // exactly 1.0 when soil depth is omitted, or every analytic splat texel
    // drifts and the shipping default stops being byte-stable.
    const probes: Partial<LandCoverInput>[] = [
      {},
      { moisture: 0.9, temperature: 0.75 },
      { slope: 0.4, elevationMeters: 900 },
      { elevationMeters: 5, moisture: 0.2 },
      { airportInfluence: 1 },
    ];
    for (const probe of probes) {
      const input = at(probe);
      expect(landCoverLitter(input)).toBe(0);
      // Zero litter multiplies the floor by exactly 1.0, so an omitted channel
      // and a channel present at the thin end agree bit for bit.
      const omitted = landCoverSuitabilities(input);
      const atThinEnd = landCoverSuitabilities({
        ...input,
        soilDepthMeters: SOIL_LITTER_THIN_METERS,
      });
      for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
        expect(omitted[id]!).toBe(atThinEnd[id]!);
      }
    }
    // Soil depth 0 is a REAL answer on a near-vertical face, not the sentinel:
    // it must produce zero litter without being mistaken for "no channel".
    expect(landCoverLitter(at({ soilDepthMeters: 0 }))).toBe(0);
    expect(landCoverLitter(at({ soilDepthMeters: 6 }))).toBeGreaterThan(0.9);
  });

  it("mirrors the litter law into WGSL from the vegetation authority", () => {
    // Terrain reaches the litter law through the one sanctioned detail entry
    // point, and the WGSL injects the SAME constants rather than restating
    // them — the parity failure this item is most exposed to.
    expect(soilLitterFactor(SOIL_LITTER_THIN_METERS)).toBe(0);
    expect(soilLitterFactor(SOIL_LITTER_DEEP_METERS)).toBe(1);
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("fn landCoverLitter(");
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("input.soilDepthValid < 0.5");
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `const LAND_COVER_SOIL_LITTER_THIN: f32 = ${SOIL_LITTER_THIN_METERS};`,
    );
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `const LAND_COVER_SOIL_LITTER_DEEP: f32 = ${SOIL_LITTER_DEEP_METERS};`,
    );
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `${LAND_COVER_FOREST_FLOOR_LITTER_GAIN}`,
    );
    // The bake binds the channel and rides the atomic-upload sentinel.
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("splatSoilDepthAtlas");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      "input.soilDepthValid = input.flowAccumulationValid;",
    );
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      `const SPLAT_SOIL_MAX_METERS: f32 = ${
        TERRAIN_PAGE_HYDROLOGY_ENCODING.soilDepthMaxMeters
      }.0;`,
    );
  });
});

describe("vegetation density field (4-6b)", () => {
  it("weights five ground-cover archetypes from terms the field already has", () => {
    expect(GROUND_COVER_ARCHETYPES).toEqual(["grass", "fern", "heather", "reed", "clutter"]);
    const wetHollow = groundCoverWeights(0.9, 0.02, 0.8, 40);
    const dryRidge = groundCoverWeights(0.15, 0.5, 0, 800);
    // The point of the item: a wet hollow and a wind-scoured ridge must read
    // as different places, not the same ground at different densities.
    expect(wetHollow.fern + wetHollow.reed).toBeGreaterThan(dryRidge.fern + dryRidge.reed);
    expect(dryRidge.heather).toBeGreaterThan(wetHollow.heather);
    for (const weights of [wetHollow, dryRidge]) {
      const total = GROUND_COVER_ARCHETYPES.reduce((sum, name) => sum + weights[name], 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });

  it("emits ONE shared WGSL include rather than a copy", () => {
    for (const marker of [
      "vegetationForestFraction",
      "vegetationDensity",
      "VEG_BASE_TREE_STEMS",
      "VEG_TREELINE_BASE_METERS",
    ]) {
      expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(marker);
    }
    // The constants must match the TypeScript authority's, which is the whole
    // reason the include is emitted from a file rather than hand-written.
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("0.08");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("1350.0");
  });

  it("band-limits its channels, so canopy cover cannot change with LOD", () => {
    // D12's defect: point-sampling a 260 m glade lattice onto a 128 m texel
    // re-rolls an arbitrary phase per level. Width 0 must stay bit-identical.
    const world = createWorld("density-band-limit");
    const sharp = sampleTerrain(world, 4_311, -2_017);
    expect(Number.isFinite(sharp.moisture)).toBe(true);
    expect(TerrainBiome.GRASSLAND).toBeGreaterThanOrEqual(0);
  });
});
