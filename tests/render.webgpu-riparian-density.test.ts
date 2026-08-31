import { describe, expect, it } from "vitest";
import { hashSeed } from "../src/world/seed";
import {
  GROUND_COVER_ARCHETYPES,
  RIPARIAN_BANK_FADE_END_METERS,
  RIPARIAN_BANK_FADE_START_METERS,
  RIPARIAN_BANK_FULL_METERS,
  RIPARIAN_BANK_NEAR_METERS,
  densityField,
  groundCoverWeights,
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
      bankBand: 0,
    });
    expect(riparianVegetationFactors(0).clearance).toBe(0);
    expect(riparianVegetationFactors(12).shrubDensityGain).toBeGreaterThan(1);
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("drivers.shoreDistanceMeters <= 0.0");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("riparianBand");
  });
});

/**
 * `6-6` — the SPECIES half of the shore-distance channel.
 *
 * Phase 5 shipped the density half (the exclusion and the two bank gains) and
 * nothing else, so a river changed how MUCH grew on its bank and never WHAT.
 * These are the properties that make the corridor an ecology rather than a
 * density multiplier, plus the parity that keeps the corridor's shape single-
 * owned across TS, the WGSL mirror and the terrain fragment.
 */
describe("6-6 riparian species half", () => {
  it("exposes the bank band itself, neutral wherever hydrology is absent", () => {
    // The band is 0 both when the channel has not provisioned the point and
    // far from water. Those are the two ways an analytic world reads it, and
    // both must be EXACTLY zero for the sentinel to preserve parity.
    expect(riparianVegetationFactors(undefined).bankBand).toBe(0);
    expect(riparianVegetationFactors(1_000_000).bankBand).toBe(0);
    expect(riparianVegetationFactors(-3).bankBand).toBe(0);
    expect(riparianVegetationFactors(4).bankBand).toBeGreaterThan(0.3);
    // Peak band, and the same four distances the WGSL and the fragment use.
    expect(riparianVegetationFactors(12).bankBand).toBeCloseTo(1, 6);
    expect(RIPARIAN_BANK_NEAR_METERS).toBeLessThan(RIPARIAN_BANK_FULL_METERS);
    expect(RIPARIAN_BANK_FADE_START_METERS).toBeLessThan(RIPARIAN_BANK_FADE_END_METERS);
  });

  it("puts reeds at the water's edge instead of on any wet flat ground", () => {
    // Dry-but-bankside ground: the climatic proxy says grassland, the channel
    // says river bank. Before 6-6 the archetype mix could not tell them apart.
    const dryBank = groundCoverWeights(0.3, 0.02, 0, 40, 1);
    const dryInland = groundCoverWeights(0.3, 0.02, 0, 40, 0);
    expect(dryBank.reed).toBeGreaterThan(dryInland.reed + 0.2);
    // Streamside ferns do not need a closed canopy.
    const shadedBank = groundCoverWeights(0.35, 0.05, 0.2, 60, 1);
    const shadedInland = groundCoverWeights(0.35, 0.05, 0.2, 60, 0);
    expect(shadedBank.fern).toBeGreaterThan(shadedInland.fern + 0.05);
    for (const weights of [dryBank, dryInland, shadedBank, shadedInland]) {
      const total = GROUND_COVER_ARCHETYPES.reduce((sum, name) => sum + weights[name], 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });

  it("is a strict no-op at band zero, which is what analytic parity rests on", () => {
    // The default argument and an explicit zero must produce the SAME numbers,
    // bit for bit: this is the sentinel proof for the archetype half.
    const drivers: [number, number, number, number][] = [
      [0.9, 0.02, 0.8, 40],
      [0.15, 0.5, 0, 800],
      [0.5, 0.12, 0.45, 300],
      [0.72, 0.03, 0.1, 90],
    ];
    for (const [moisture, slope, shade, elevation] of drivers) {
      const implicit = groundCoverWeights(moisture, slope, shade, elevation);
      const explicitZero = groundCoverWeights(moisture, slope, shade, elevation, 0);
      for (const name of GROUND_COVER_ARCHETYPES) {
        expect(explicitZero[name]).toBe(implicit[name]);
      }
    }
    // And a density-field sample with no shore distance carries a zero band.
    const sample = densityField(hashSeed("riparian-species-parity"), {
      x: 1_234,
      z: -908,
      heightMeters: 210,
      seaLevelMeters: 0,
      slope: 0.04,
      moisture: 0.6,
      dayOfYear: 171,
      filterWidthMeters: 0,
    });
    expect(sample.riparianBand).toBe(0);
  });

  it("mirrors the corridor's four distances into the WGSL include, not literals", () => {
    // The mirror is composed into no live shader yet and is pinned only here,
    // so the constants have to be checked against the TS authority by value:
    // a retune that moved one half only would otherwise be invisible.
    for (const value of [
      RIPARIAN_BANK_NEAR_METERS,
      RIPARIAN_BANK_FULL_METERS,
      RIPARIAN_BANK_FADE_START_METERS,
      RIPARIAN_BANK_FADE_END_METERS,
    ]) {
      const literal = Number.isInteger(value) ? `${value}.0` : String(value);
      expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(literal);
    }
    // The band is an OUTPUT of the mirror now, so the composed shader can key
    // the species terms on the same shape the TS half does.
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("riparianBand: f32,");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("result.riparianBand = riparianBand;");
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain("result.riparianBand = 0.0;");
    // The forbidden-builtins rule: the mirror runs beside the terrain kernel.
    const code = VEGETATION_DENSITY_FIELD_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    expect(code).not.toMatch(/[^k]smoothstep\(/u);
  });
});
