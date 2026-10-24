import { describe, expect, it } from "vitest";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";
import {
  classifyLandCover,
  dominantLandCover,
  LAND_COVER_BASALT_GAIN,
  LAND_COVER_CLASSIFIER_WGSL,
  LAND_COVER_TEPHRA_GAIN,
  LAND_COVER_TEPHRA_REPOSE_SLOPE,
  landCoverHabitat,
  landCoverSuitabilities,
  landCoverVolcanicBareShare,
  landCoverWeightOf,
  type LandCoverInput,
  type LandCoverWeights,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  SURFACE_MATERIAL_BASE_COUNT,
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import { TerrainBiome } from "../src/world";

/**
 * Volcanic land, phase 2: the classifier's three volcanic inputs.
 *
 * The invariant first, because it is the one every shipped pixel depends on:
 * with both covers 0 (or omitted) the classification is BIT-IDENTICAL to the
 * ten-material classifier this branch started from. The two volcanic
 * suitabilities are not merely zero there; they are absent from the softmax.
 */

/** mulberry32: a seeded stream, so the sweep is the same sweep every run. */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Random classifier inputs over the whole space the callers reach, including
 * every optional seam present and absent. Built with the same draws in the
 * same order whatever the volcanic variant, so the variants are comparable
 * input for input.
 */
function randomInputs(count: number): LandCoverInput[] {
  const random = stream(0x5eed_0a11);
  const inputs: LandCoverInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const draw = (): number => random();
    const elevationMeters = -20 + draw() * 2_600;
    const slope = draw() * draw() * 0.95;
    const moisture = draw();
    const temperature = draw() * 0.75;
    const aspect = draw() * 2 - 1;
    const airportInfluence = draw() < 0.1 ? draw() : 0;
    const dayOfYear = Math.floor(draw() * 365);
    const seasonalTemperatureShift = -draw() * 0.5;
    const withFlow = draw() < 0.4;
    const flowAccumulationAreaM2 = draw() * 5_000_000;
    const withSoil = draw() < 0.4;
    const soilDepthMeters = draw() * 4;
    const withCanopy = draw() < 0.5;
    const canopyClosure = draw();
    const grassCover = draw();
    const withProvince = draw() < 0.5;
    const temperatureOffset = (draw() - 0.5) * 0.4;
    const dryness = (draw() - 0.5) * 0.4;
    inputs.push({
      elevationMeters,
      slope,
      moisture,
      temperature,
      aspect,
      airportInfluence,
      dayOfYear,
      seasonalTemperatureShift,
      ...(withFlow ? { flowAccumulationAreaM2 } : {}),
      ...(withSoil ? { soilDepthMeters } : {}),
      ...(withCanopy ? { canopyClosure, grassCover } : {}),
      ...(withProvince ? { temperatureOffset, dryness } : {}),
    });
  }
  return inputs;
}

/** FNV-1a over the exact bits of every id, weight and base suitability. */
function digest(classify: (input: LandCoverInput) => {
  readonly weights: LandCoverWeights;
  readonly suitability: readonly number[];
}, inputs: readonly LandCoverInput[]): string {
  const view = new DataView(new ArrayBuffer(8));
  let hash = 0x811c_9dc5;
  const mixByte = (byte: number): void => {
    hash = Math.imul(hash ^ byte, 0x0100_0193) >>> 0;
  };
  const mixNumber = (value: number): void => {
    view.setFloat64(0, value);
    for (let byte = 0; byte < 8; byte += 1) mixByte(view.getUint8(byte));
  };
  for (const input of inputs) {
    const { weights, suitability } = classify(input);
    mixNumber(weights.ids.length);
    for (let slot = 0; slot < weights.ids.length; slot += 1) {
      mixNumber(weights.ids[slot]!);
      mixNumber(weights.weights[slot]!);
    }
    for (let id = 0; id < SURFACE_MATERIAL_BASE_COUNT; id += 1) mixNumber(suitability[id]!);
  }
  return hash.toString(16).padStart(8, "0");
}

const SWEEP = randomInputs(40_000);

/**
 * The digest of the same sweep through the classifier at `bb7b6b1`, the
 * commit this work started from (ten materials, no volcanic inputs). Captured
 * by running this file's `digest` against an export of that tree.
 */
const BASE_TREE_DIGEST = "618153d6";

describe("volcanic classifier inputs (phase 2): parity off volcanic ground", () => {
  const classify = (input: LandCoverInput) => ({
    weights: classifyLandCover(input),
    suitability: landCoverSuitabilities(input),
  });

  it("is bit-identical to the base tree with the inputs omitted", () => {
    expect(digest(classify, SWEEP)).toBe(BASE_TREE_DIGEST);
  });

  it("is bit-identical with both covers exactly 0, whatever the age", () => {
    const random = stream(0xa9e);
    const zeroed = SWEEP.map((input) => ({
      ...input, lavaCover: 0, tephraCover: 0, volcanicAge: random(),
    }));
    expect(digest(classify, zeroed)).toBe(BASE_TREE_DIGEST);
    // Negative zero is zero too.
    const negativeZero = SWEEP.map((input) => ({ ...input, lavaCover: -0, tephraCover: -0 }));
    expect(digest(classify, negativeZero)).toBe(BASE_TREE_DIGEST);
  });

  it("POSITIVE CONTROL: the digest does move once any cover is present", () => {
    const volcanic = SWEEP.map((input) => ({ ...input, tephraCover: 0.5, volcanicAge: 0.1 }));
    expect(digest(classify, volcanic)).not.toBe(BASE_TREE_DIGEST);
  });

  it("never names a volcanic material off volcanic ground", () => {
    for (const input of SWEEP.slice(0, 5_000)) {
      const weights = classifyLandCover(input);
      for (const id of weights.ids) expect(id).toBeLessThan(SURFACE_MATERIAL_BASE_COUNT);
      const suitability = landCoverSuitabilities(input);
      expect(suitability).toHaveLength(SURFACE_MATERIAL_COUNT);
      expect(Object.is(suitability[SurfaceMaterial.Basalt], 0)).toBe(true);
      expect(Object.is(suitability[SurfaceMaterial.Tephra], 0)).toBe(true);
      expect(landCoverVolcanicBareShare(input)).toBe(0);
    }
  });
});

/** A point on gentle temperate lowland unless overridden. */
function at(overrides: Partial<LandCoverInput>): LandCoverInput {
  return {
    elevationMeters: 180,
    slope: 0.04,
    moisture: 0.55,
    temperature: 0.42,
    aspect: 0,
    airportInfluence: 0,
    dayOfYear: 172,
    seasonalTemperatureShift: 0,
    ...overrides,
  };
}

const dominant = (input: LandCoverInput): string =>
  SURFACE_MATERIALS[dominantLandCover(classifyLandCover(input))]!.name;

/** Normalised steepness of a slope in degrees. */
const steepness = (degrees: number): number => 1 - Math.cos((degrees * Math.PI) / 180);

describe("volcanic classifier inputs (phase 2): the age rules", () => {
  it("paints fresh lava Basalt and fresh tephra Tephra, in every climate", () => {
    for (const climate of [
      { moisture: 0.9, temperature: 0.5 },
      { moisture: 0.1, temperature: 0.5 },
      { moisture: 0.8, temperature: 0.05, temperatureOffset: -0.3 },
      { moisture: 0.6, temperature: 0.3, canopyClosure: 1, grassCover: 1, soilDepthMeters: 3 },
    ]) {
      expect(dominant(at({ ...climate, lavaCover: 1, volcanicAge: 0 })), JSON.stringify(climate))
        .toBe("Basalt");
      expect(dominant(at({ ...climate, tephraCover: 1, volcanicAge: 0.1 })), JSON.stringify(climate))
        .toBe("Tephra");
      // Bare means bare: no vegetated weight survives on fresh ground.
      const weights = classifyLandCover(at({ ...climate, lavaCover: 1, volcanicAge: 0 }));
      const habitat = landCoverHabitat(weights);
      expect(habitat.canopy + habitat.open + habitat.scrub).toBeLessThan(0.02);
    }
  });

  it("holds Tephra up to the 34 degree angle of repose and hands the cone to Rock above it", () => {
    expect(LAND_COVER_TEPHRA_REPOSE_SLOPE).toBeCloseTo(steepness(34), 12);
    for (const degrees of [10, 20, 28, 32, 33]) {
      expect(dominant(at({ slope: steepness(degrees), tephraCover: 1, volcanicAge: 0 })), `${degrees}`)
        .toBe("Tephra");
    }
    for (const degrees of [35, 38, 45]) {
      expect(dominant(at({ slope: steepness(degrees), tephraCover: 1, volcanicAge: 0 })), `${degrees}`)
        .toBe("Rock");
    }
    // An ecotone, not a step: the two weights cross smoothly around 34, and
    // inside the hand-over (from ~32.2 degrees) Tephra only ever gives ground.
    let previous = landCoverWeightOf(
      classifyLandCover(at({ slope: steepness(30), tephraCover: 1 })), SurfaceMaterial.Tephra);
    expect(previous).toBeGreaterThan(0.9);
    // At a twentieth of a degree apart; a step would show at any spacing.
    for (let step = 1; step <= 160; step += 1) {
      const degrees = 30 + step * 0.05;
      const share = landCoverWeightOf(
        classifyLandCover(at({ slope: steepness(degrees), tephraCover: 1 })), SurfaceMaterial.Tephra);
      if (degrees >= 32.5) expect(share, `rise at ${degrees}`).toBeLessThanOrEqual(previous + 1e-12);
      expect(Math.abs(previous - share), `step at ${degrees}`).toBeLessThan(0.1);
      previous = share;
    }
    expect(previous).toBeLessThan(0.1);
  });

  it("lets Grass and Shrub creep onto moist middle-aged ground and keeps dry ground bare", () => {
    // Iceland: a cold, wet province at low elevation.
    const iceland = { moisture: 0.92, temperature: 0.06, temperatureOffset: -0.3 };
    const moist = classifyLandCover(at({ ...iceland, lavaCover: 1, volcanicAge: 0.5 }));
    const moistHabitat = landCoverHabitat(moist);
    expect(moistHabitat.open + moistHabitat.scrub).toBeGreaterThan(0.6);
    expect(["Grass", "Shrub"]).toContain(SURFACE_MATERIALS[dominantLandCover(moist)]!.name);
    // Craters of the Moon: dry high desert stays bare at the same age.
    const dry = at({ moisture: 0.08, temperature: 0.3, dryness: 0.25, lavaCover: 1, volcanicAge: 0.5 });
    expect(dominant(dry)).toBe("Basalt");
  });

  it("returns old ground to the climate's cover, fertile, with Rock on the flow fronts", () => {
    // Warm and wet: forest, and more of it than on ordinary ground.
    const warmWet = { moisture: 0.9, temperature: 0.5 };
    const old = classifyLandCover(at({ ...warmWet, lavaCover: 1, volcanicAge: 1 }));
    expect(SURFACE_MATERIALS[dominantLandCover(old)]!.name).toBe("ForestFloor");
    const ordinary = classifyLandCover(at(warmWet));
    expect(landCoverWeightOf(old, SurfaceMaterial.ForestFloor))
      .toBeGreaterThanOrEqual(landCoverWeightOf(ordinary, SurfaceMaterial.ForestFloor));
    expect(landCoverWeightOf(old, SurfaceMaterial.Basalt)).toBeLessThan(1e-3);
    // A steep old flow front is Rock where the flat of the flow is forest.
    expect(dominant(at({ ...warmWet, slope: 0.32, lavaCover: 1, volcanicAge: 1 }))).toBe("Rock");
    // The climate decides, not the lava: old ground in a dry climate is dry cover.
    const dryOld = at({ moisture: 0.12, temperature: 0.45, lavaCover: 1, volcanicAge: 1 });
    expect(dominant(dryOld)).toBe(dominant(at({ moisture: 0.12, temperature: 0.45 })));
  });

  it("lets the existing snowline cap a volcano", () => {
    // Both volcanic claims sit under Snow's 1.5 ceiling, so no new snow code.
    expect(LAND_COVER_BASALT_GAIN).toBeLessThan(1.5);
    expect(LAND_COVER_TEPHRA_GAIN).toBeLessThan(1.5);
    expect(dominant(at({
      elevationMeters: 2_400, temperature: 0.02, slope: 0.08, lavaCover: 1, volcanicAge: 0,
    }))).toBe("Snow");
    expect(dominant(at({
      elevationMeters: 2_400, temperature: 0.02, slope: 0.08, tephraCover: 1, volcanicAge: 0,
    }))).toBe("Snow");
  });

  it("hands the shoreline's Sand to Tephra inside volcanic ground: black sand", () => {
    const beach = { elevationMeters: 0.6, slope: 0.02 };
    expect(dominant(at(beach))).toBe("Sand");
    for (const volcanicAge of [0, 0.5, 1]) {
      const weights = classifyLandCover(at({ ...beach, tephraCover: 1, volcanicAge }));
      expect(SURFACE_MATERIALS[dominantLandCover(weights)]!.name, `${volcanicAge}`).toBe("Tephra");
      expect(landCoverWeightOf(weights, SurfaceMaterial.Sand)).toBeLessThan(1e-3);
    }
  });

  it("fades into the climatic classification as the cover fades to 0", () => {
    for (const input of SWEEP.slice(0, 2_000)) {
      const base = classifyLandCover(input);
      const suitability = landCoverSuitabilities(input);
      const faint = classifyLandCover({ ...input, lavaCover: 1e-9, tephraCover: 1e-9 });
      // The same weights, in the same order.
      expect(faint.weights.length).toBe(base.weights.length);
      for (let slot = 0; slot < base.weights.length; slot += 1) {
        expect(faint.weights[slot]!).toBeCloseTo(base.weights[slot]!, 6);
      }
      // On the same materials, except where a slot holds a material with no
      // claim at all: there a 1e-9 claim breaks the tie among the zeros, as
      // any other material's first 1e-9 does. Same weight, other tail id.
      for (let slot = 0; slot < base.ids.length; slot += 1) {
        const id = base.ids[slot]!;
        if (suitability[id]! <= 1e-6) continue;
        expect(landCoverWeightOf(faint, id)).toBeCloseTo(base.weights[slot]!, 6);
      }
    }
  });
});

describe("volcanic classifier inputs (phase 2): the WGSL twin", () => {
  const source = LAND_COVER_CLASSIFIER_WGSL;
  it("carries the three inputs and keeps the volcanic scores out of the softmax off volcanic ground", () => {
    expect(source).toMatch(/lavaCover: f32,\s+tephraCover: f32,\s+volcanicAge: f32,\s+\};/u);
    expect(source).toContain(`const LAND_COVER_BASE_COUNT: u32 = ${SURFACE_MATERIAL_BASE_COUNT}u;`);
    expect(source).toContain(
      "let count = select(LAND_COVER_BASE_COUNT, LAND_COVER_COUNT, landCoverIsVolcanic(input));");
    // Both softmax loops and the selection sort read the count, not the axis.
    const classify = source.slice(source.indexOf("fn classifyLandCover("));
    expect(classify.match(/index < count;/gu)).toHaveLength(3);
    expect(classify).not.toContain("index < LAND_COVER_COUNT;");
    // The volcanic rules run only behind the same predicate as the TS twin.
    expect(source).toContain("return input.lavaCover > 0.0 || input.tephraCover > 0.0;");
    expect(source).toContain(
      "if (landCoverIsVolcanic(input)) {\n    return landCoverVolcanicGround(input, suitability, slope, wet, shore);");
  });

  it("injects every volcanic constant rather than retyping it", () => {
    for (const value of [LAND_COVER_BASALT_GAIN, LAND_COVER_TEPHRA_GAIN]) {
      expect(source).toContain(Number.isInteger(value) ? `${value}.0` : String(value));
    }
    expect(source).toContain(String(LAND_COVER_TEPHRA_REPOSE_SLOPE - 0.017));
    expect(source).toContain(String(LAND_COVER_TEPHRA_REPOSE_SLOPE + 0.017));
  });
});

describe("volcanic classifier inputs (phase 2): vegetation follows", () => {
  const forest = (overrides: Partial<DetailTerrainSample>) => () => ({
    height: 320,
    slope: 0.04,
    moisture: 0.72,
    biome: TerrainBiome.FOREST,
    normal: { x: 0.01, y: 0.999, z: 0.02 },
    ...overrides,
  });
  const treesOn = (overrides: Partial<DetailTerrainSample>): number => {
    let total = 0;
    for (let cellX = 0; cellX < 3; cellX += 1) {
      total += generateDetailCell({
        worldSeed: "volcanic-vegetation",
        cellX,
        cellZ: 0,
        densityMultiplier: 1,
        terrainSample: forest(overrides),
        seaLevelMeters: 0,
      }).trees.length;
    }
    return total;
  };

  it("plants no trees on fresh lava, some with age, and all of them on old ground", () => {
    const ordinary = treesOn({});
    expect(ordinary).toBeGreaterThan(20);
    expect(treesOn({ lavaCover: 1, volcanicAge: 0 })).toBe(0);
    const pioneers = treesOn({ lavaCover: 1, volcanicAge: 0.5 });
    expect(pioneers).toBeGreaterThan(0);
    expect(pioneers).toBeLessThan(ordinary);
    // Old ground keeps every stem, bit for bit: the share is exactly 1 there.
    expect(treesOn({ lavaCover: 1, volcanicAge: 1 })).toBe(ordinary);
    // And the zero-cover sample is the ordinary one.
    expect(treesOn({ lavaCover: 0, tephraCover: 0, volcanicAge: 0 })).toBe(ordinary);
  });
});
