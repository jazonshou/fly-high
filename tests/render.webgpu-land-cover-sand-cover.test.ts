import { describe, expect, it } from "vitest";
import {
  LAND_COVER_CLASSIFIER_WGSL,
  LAND_COVER_SAND_COVER_GAIN,
  LAND_COVER_SAND_SLOPE_HIGH,
  LAND_COVER_SAND_SLOPE_LOW,
  classifyLandCover,
  dominantLandCover,
  landCoverSandCoverTerms,
  landCoverSoftmaxTemperature,
  landCoverSuitabilities,
  landCoverWeightOf,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";

/**
 * Sand seas in the classifier: `sandCover` overrides the climate on dune
 * ground (Sand rises, plants and dune-angle Rock fall) and is invisible
 * everywhere else. The first block is the contract that keeps every perf
 * baseline still: a zero cover is the shipped classifier bit for bit.
 */

const BASE: LandCoverInput = {
  elevationMeters: 0,
  slope: 0,
  moisture: 0.5,
  temperature: 0.6,
  aspect: 0,
  airportInfluence: 0,
  dayOfYear: 172,
  seasonalTemperatureShift: 0,
};

/** The optional seams, cycled through the sweep so every value meets every main axis. */
const OPTIONAL_SEAMS: readonly Partial<LandCoverInput>[] = [
  {},
  { flowAccumulationAreaM2: 4e5 },
  { soilDepthMeters: 0.4, canopyClosure: 0 },
  { soilDepthMeters: 6, canopyClosure: 0.8, grassCover: 0.3 },
  { grassCover: 0.9, airportInfluence: 0.6 },
  { temperatureOffset: -0.3, dryness: 0.2 },
  { temperatureOffset: 0.28, dryness: -0.15, flowAccumulationAreaM2: 2e3 },
  { seasonalTemperatureShift: -0.2, aspect: -0.7, dayOfYear: 15 },
  { aspect: 0.7, airportInfluence: 1, canopyClosure: 0.4 },
];

function sweep(visit: (input: LandCoverInput) => void): number {
  let count = 0;
  for (const elevationMeters of [-2, 0.5, 2, 6, 180, 420, 700, 900, 1_350, 1_700, 2_600]) {
    for (const slope of [0, 0.02, 0.1, 0.134, 0.15, 0.2, 0.25, 0.4, 0.7]) {
      for (const moisture of [0, 0.15, 0.55, 0.9, 1]) {
        for (const temperature of [0, 0.1, 0.3, 0.6, 0.9]) {
          for (const seams of OPTIONAL_SEAMS) {
            visit({ ...BASE, elevationMeters, slope, moisture, temperature, ...seams });
            count += 1;
          }
        }
      }
    }
  }
  return count;
}

describe("sand cover off the sand seas", () => {
  it("classifies the existing input space bit-identically with sandCover 0 and with none", () => {
    const count = sweep((input) => {
      const shipped = landCoverSuitabilities(input);
      for (const sandCover of [0, -0]) {
        const covered = landCoverSuitabilities({ ...input, sandCover });
        expect(covered.length).toBe(shipped.length);
        for (let id = 0; id < shipped.length; id += 1) {
          expect(Object.is(covered[id], shipped[id]), `material ${id}`).toBe(true);
        }
        expect(Object.is(
          landCoverSoftmaxTemperature({ ...input, sandCover }),
          landCoverSoftmaxTemperature(input),
        )).toBe(true);
        expect(classifyLandCover({ ...input, sandCover })).toEqual(classifyLandCover(input));
      }
    });
    expect(count).toBe(11 * 9 * 5 * 5 * OPTIONAL_SEAMS.length);
  });

  it("is a struct field, a helper and a branch in the WGSL twin too", () => {
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("sandCover: f32,");
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("fn landCoverSandCoverTerms(sandCover: f32, slope: f32) -> vec3f");
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain("if (input.sandCover > 0.0) {");
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `const LAND_COVER_SAND_COVER_GAIN: f32 = ${LAND_COVER_SAND_COVER_GAIN};`);
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `const LAND_COVER_SAND_SLOPE_LOW: f32 = ${LAND_COVER_SAND_SLOPE_LOW};`);
    expect(LAND_COVER_CLASSIFIER_WGSL).toContain(
      `const LAND_COVER_SAND_SLOPE_HIGH: f32 = ${LAND_COVER_SAND_SLOPE_HIGH};`);
  });
});

describe("sand cover on the sand seas", () => {
  // A slipface: 30 degrees, sand's angle of repose.
  const SLIPFACE = 1 - Math.cos((30 * Math.PI) / 180);
  const VEGETATED = [
    SurfaceMaterial.Grass,
    SurfaceMaterial.ForestFloor,
    SurfaceMaterial.Shrub,
    SurfaceMaterial.DryGrass,
  ] as const;

  it("makes a dune sand whatever the climate says", () => {
    const climates: Partial<LandCoverInput>[] = [
      // High desert, temperate wet lowland, hot steppe, and a cold desert whose
      // thermal height is alpine (where Rock and the scree band read slope).
      { moisture: 0.15, temperature: 0.6, dryness: 0.5 },
      { moisture: 0.85, temperature: 0.7, canopyClosure: 0.6 },
      { moisture: 0.3, temperature: 0.9, temperatureOffset: 0.28, dryness: 0.25 },
      { moisture: 0.2, temperature: 0.1, temperatureOffset: -0.55, dryness: 0.5 },
    ];
    for (const climate of climates) {
      for (const slope of [0, 0.05, SLIPFACE, 0.17]) {
        for (const elevationMeters of [40, 150, 450]) {
          const input = { ...BASE, ...climate, slope, elevationMeters };
          const dune = classifyLandCover({ ...input, sandCover: 1 });
          expect(dominantLandCover(dune), JSON.stringify(input)).toBe(SurfaceMaterial.Sand);
          expect(landCoverWeightOf(dune, SurfaceMaterial.Sand)).toBeGreaterThan(0.9);
          const suitability = landCoverSuitabilities({ ...input, sandCover: 1 });
          for (const id of VEGETATED) expect(suitability[id]).toBe(0);
          expect(suitability[SurfaceMaterial.Rock]).toBe(0);
        }
      }
    }
  });

  it("fades the plants with the cover and leaves steep ground its Rock", () => {
    const input = { ...BASE, elevationMeters: 120, moisture: 0.25, slope: 0.05 };
    let previousSand = -Infinity;
    let previousPlants = Infinity;
    for (const sandCover of [0, 0.25, 0.5, 0.75, 1]) {
      const suitability = landCoverSuitabilities({ ...input, sandCover });
      const plants = VEGETATED.reduce((sum, id) => sum + suitability[id]!, 0);
      expect(suitability[SurfaceMaterial.Sand]!).toBeGreaterThan(previousSand);
      expect(plants).toBeLessThanOrEqual(previousPlants);
      previousSand = suitability[SurfaceMaterial.Sand]!;
      previousPlants = plants;
    }
    // A cliff inside an erg: past the dune band Rock and Sand are the shipped ones.
    for (const slope of [LAND_COVER_SAND_SLOPE_HIGH, 0.4, 0.7]) {
      const cliff = { ...input, slope, elevationMeters: 600 };
      const shipped = landCoverSuitabilities(cliff);
      const covered = landCoverSuitabilities({ ...cliff, sandCover: 1 });
      expect(covered[SurfaceMaterial.Rock]).toBe(shipped[SurfaceMaterial.Rock]);
      expect(covered[SurfaceMaterial.Sand]).toBe(shipped[SurfaceMaterial.Sand]);
      // The plants still go: whatever wins a covered cliff is mineral.
      expect(VEGETATED as readonly number[])
        .not.toContain(dominantLandCover(classifyLandCover({ ...cliff, sandCover: 1 })));
    }
  });

  it("releases Rock fully on dune-angle ground and not at all past the band", () => {
    expect(landCoverSandCoverTerms(1, SLIPFACE).rock).toBe(0);
    expect(landCoverSandCoverTerms(1, LAND_COVER_SAND_SLOPE_LOW).rock).toBe(0);
    expect(landCoverSandCoverTerms(1, LAND_COVER_SAND_SLOPE_HIGH).rock).toBe(1);
    expect(landCoverSandCoverTerms(0.4, 0.05).vegetation).toBeCloseTo(0.6, 12);
    expect(landCoverSandCoverTerms(2, 0).sand).toBe(LAND_COVER_SAND_COVER_GAIN);
  });
});
