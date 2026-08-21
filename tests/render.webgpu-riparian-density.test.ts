import { describe, expect, it } from "vitest";
import { hashSeed } from "../src/world/seed";
import {
  densityField,
  riparianVegetationFactors,
} from "../src/render/webgpu/detail/densityField";
import { VEGETATION_DENSITY_FIELD_WGSL } from
  "../src/render/webgpu/detail/densityFieldWgsl";

describe("Phase 5 riparian and channel exclusion", () => {
  it("makes every wetted sample exactly stem-free", () => {
    const seed = hashSeed("riparian-exclusion");
    for (let z = -4_000; z <= 4_000; z += 400) {
      for (let x = -4_000; x <= 4_000; x += 400) {
        const sample = densityField(seed, {
          x,
          z,
          heightMeters: 240,
          seaLevelMeters: 0,
          slope: 0.03,
          moisture: 0.72,
          shoreDistanceMeters: -0.01,
          dayOfYear: 172,
          filterWidthMeters: 0,
        });
        expect(sample.treeStemsPerSquareMeter).toBe(0);
        expect(sample.shrubStemsPerSquareMeter).toBe(0);
      }
    }
  });

  it("boosts the exported bank band without changing distant density", () => {
    const seed = hashSeed("riparian-bank-band");
    let baselineTrees = 0;
    let baselineShrubs = 0;
    let bankTrees = 0;
    let bankShrubs = 0;
    let distantTrees = 0;
    for (let z = -12_000; z <= 12_000; z += 600) {
      for (let x = -12_000; x <= 12_000; x += 600) {
        const input = {
          x,
          z,
          heightMeters: 180,
          seaLevelMeters: 0,
          slope: 0.025,
          moisture: 0.7,
          dayOfYear: 172,
          filterWidthMeters: 0,
        } as const;
        const baseline = densityField(seed, input);
        const bank = densityField(seed, { ...input, shoreDistanceMeters: 12 });
        const distant = densityField(seed, { ...input, shoreDistanceMeters: 100 });
        baselineTrees += baseline.treeStemsPerSquareMeter;
        baselineShrubs += baseline.shrubStemsPerSquareMeter;
        bankTrees += bank.treeStemsPerSquareMeter;
        bankShrubs += bank.shrubStemsPerSquareMeter;
        distantTrees += distant.treeStemsPerSquareMeter;
      }
    }
    expect(bankTrees).toBeGreaterThan(baselineTrees);
    expect(bankShrubs).toBeGreaterThan(baselineShrubs);
    expect(distantTrees).toBeCloseTo(baselineTrees, 12);
  });

  it("keeps TS and WGSL on the same multiplicative field", () => {
    expect(riparianVegetationFactors(undefined)).toEqual({
      clearance: 1,
      treeDensityGain: 1,
      shrubDensityGain: 1,
    });
    expect(riparianVegetationFactors(0).clearance).toBe(0);
    expect(riparianVegetationFactors(12).shrubDensityGain).toBeGreaterThan(1);
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("drivers.shoreDistanceMeters <= 0.0");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("riparianBand");
  });
});
