import { describe, expect, it } from "vitest";
import {
  MAX_TERRAIN_HEIGHT,
  MIN_TERRAIN_HEIGHT,
  sampleNaturalTerrainHeight,
  sampleTerrainEvolutionGeology,
  sampleTerrainUpliftHeight,
} from "../src/world";

describe("Phase 5 tectonic uplift authority", () => {
  it("is deterministic, bounded, and distinct from the analytic compatibility kernel", () => {
    const seedHash = 0x35ac_71d2;
    let changed = 0;
    for (let z = -96_000; z <= 96_000; z += 16_000) {
      for (let x = -96_000; x <= 96_000; x += 16_000) {
        const first = sampleTerrainUpliftHeight(seedHash, x, z, 0);
        const repeated = sampleTerrainUpliftHeight(seedHash, x, z, 0);
        expect(first).toBe(repeated);
        expect(first).toBeGreaterThanOrEqual(MIN_TERRAIN_HEIGHT);
        expect(first).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
        if (first !== sampleNaturalTerrainHeight(seedHash, x, z, 0)) changed += 1;
      }
    }
    expect(changed).toBeGreaterThan(100);
    expect(MAX_TERRAIN_HEIGHT).toBe(4_500);
    expect(MIN_TERRAIN_HEIGHT).toBeLessThanOrEqual(-4_000);
  });

  it("publishes a continuous unit double-angle fabric and spatial lithology", () => {
    const seedHash = 0x118c_9037;
    const first = sampleTerrainEvolutionGeology(seedHash, -70_000, 31_000, 0);
    const adjacent = sampleTerrainEvolutionGeology(seedHash, -69_999.5, 31_000, 0);
    expect(Math.hypot(first.fabricCos2, first.fabricSin2)).toBeCloseTo(1, 12);
    expect(Math.hypot(adjacent.fabricCos2, adjacent.fabricSin2)).toBeCloseTo(1, 12);
    expect(Math.hypot(
      first.fabricCos2 - adjacent.fabricCos2,
      first.fabricSin2 - adjacent.fabricSin2,
    )).toBeLessThan(0.001);
    expect(first.erodibility).toBeGreaterThan(0);
    expect(first.reposeDegrees).toBeGreaterThanOrEqual(28);
    expect(first.reposeDegrees).toBeLessThanOrEqual(42);

    const orientations = new Set<string>();
    const erodibilities: number[] = [];
    for (let z = -180_000; z <= 180_000; z += 60_000) {
      for (let x = -180_000; x <= 180_000; x += 60_000) {
        const sample = sampleTerrainEvolutionGeology(seedHash, x, z, 0);
        orientations.add(`${sample.fabricCos2.toFixed(2)}/${sample.fabricSin2.toFixed(2)}`);
        erodibilities.push(sample.erodibility);
      }
    }
    expect(orientations.size).toBeGreaterThan(4);
    expect(Math.max(...erodibilities) - Math.min(...erodibilities)).toBeGreaterThan(0.15);
  });

  it("contains an abyssal profile and band-limits the fine lithology field", () => {
    const seedHash = 0x2c6f_91a3;
    let minimum = Number.POSITIVE_INFINITY;
    let fineDifference = 0;
    for (let z = -240_000; z <= 240_000; z += 24_000) {
      for (let x = -240_000; x <= 240_000; x += 24_000) {
        const full = sampleTerrainUpliftHeight(seedHash, x + 3.25, z - 7.5, 0);
        const macro = sampleTerrainUpliftHeight(seedHash, x + 3.25, z - 7.5, 512);
        minimum = Math.min(minimum, full);
        fineDifference += Math.abs(full - macro);
      }
    }
    expect(minimum).toBeLessThan(-1_000);
    expect(fineDifference).toBeGreaterThan(1);
  });
});
