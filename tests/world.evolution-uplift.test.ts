import { describe, expect, it } from "vitest";
import {
  MAX_TERRAIN_HEIGHT,
  MIN_TERRAIN_HEIGHT,
  TERRAIN_FINE_BAND_24M_AMPLITUDE_METERS,
  TERRAIN_FINE_BAND_9M_AMPLITUDE_METERS,
  sampleNaturalTerrainHeight,
  sampleTerrainEvolutionGeology,
  sampleTerrainFineBandRelief,
  sampleTerrainUpliftHeight,
} from "../src/world";
import { sampleTerrainPlates } from "../src/world/geology";
import { terrainFineBandSurvival } from "../src/render/webgpu/terrain/TerrainPageHydrology";

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

/**
 * `W-4` (Gate W, register C-4). Two claims that a statistics suite cannot
 * make, because they are about the FIELD rather than about a landscape: the
 * plate tessellation is continuous everywhere (an earlier nearest-site form
 * jumped 0.97 of full scale at triple junctions, which would have been a cliff
 * in the terrain), and it survives world-scale coordinates.
 */
describe("W-4 Lloyd plate model", () => {
  const seedHash = 0x51fa_20b7;

  it("is continuous at every scale a page or a macro texel can step", () => {
    // 96 km cell, 0.3-cell jitter and a 0.22-cell belt: the steepest legal
    // gradient is the belt's own edge, so a 512 m step cannot cross more than
    // a fraction of it. A triple-junction discontinuity shows up here as a
    // full-scale jump, which is exactly how the first implementation failed.
    let worst512 = 0;
    let worst2 = 0;
    for (let z = -260_000; z <= 260_000; z += 4_096) {
      let previous = sampleTerrainPlates(seedHash, -260_000, z, 0).convergence;
      for (let x = -260_000 + 512; x <= 260_000; x += 512) {
        const value = sampleTerrainPlates(seedHash, x, z, 0).convergence;
        worst512 = Math.max(worst512, Math.abs(value - previous));
        previous = value;
      }
    }
    for (let index = 0; index < 4_000; index += 1) {
      const x = -180_000 + index * 91;
      const z = 40_000 - index * 57;
      const here = sampleTerrainPlates(seedHash, x, z, 0).convergence;
      const stepped = sampleTerrainPlates(seedHash, x + 2, z, 0).convergence;
      worst2 = Math.max(worst2, Math.abs(stepped - here));
    }
    expect(worst512).toBeLessThan(0.05);
    expect(worst2).toBeLessThan(0.001);
  });

  it("keeps its distribution and its structure kilometres out", () => {
    // The sin-fract trap: a hash that collapses at world scale reads as a
    // constant (or a row-striped) field far from the origin. Both the spread
    // and the presence of convergent belts have to survive.
    for (const radius of [0, 100_000, 1_000_000, 2_600_000]) {
      const values: number[] = [];
      for (let index = 0; index < 3_000; index += 1) {
        const angle = index * 0.618_033_988_75 * Math.PI * 2;
        values.push(sampleTerrainPlates(
          seedHash,
          radius + Math.cos(angle) * 200_000,
          radius * 0.7 + Math.sin(angle) * 200_000,
          0,
        ).convergence);
      }
      const converging = values.filter((value) => value > 0.25).length / values.length;
      expect(Math.min(...values), `min at ${radius} m`).toBeLessThan(0.02);
      expect(Math.max(...values), `max at ${radius} m`).toBeGreaterThan(0.6);
      expect(converging, `convergent share at ${radius} m`).toBeGreaterThan(0.02);
      expect(converging, `convergent share at ${radius} m`).toBeLessThan(0.5);
    }
  });

  it("ignores filter width, deterministically", () => {
    for (let index = 0; index < 200; index += 1) {
      const x = -70_000 + index * 811;
      const z = 25_000 - index * 613;
      const full = sampleTerrainPlates(seedHash, x, z, 0).convergence;
      expect(sampleTerrainPlates(seedHash, x, z, 512).convergence).toBe(full);
      expect(sampleTerrainPlates(seedHash, x, z, 0).convergence).toBe(full);
    }
  });
});

describe("W-4 post-erosion fine bands", () => {
  const seedHash = 0x7d31_04c9;

  it("is mean-removed and fades out with the sampling footprint", () => {
    let total = 0;
    let count = 0;
    let extreme = 0;
    for (let z = -8_000; z <= 8_000; z += 37) {
      for (let x = -8_000; x <= 8_000; x += 41) {
        const value = sampleTerrainFineBandRelief(seedHash, x, z, 0);
        total += value;
        extreme = Math.max(extreme, Math.abs(value));
        count += 1;
      }
    }
    // Both bands subtract RIDGED_OCTAVE_BAND_LIMIT_MEAN, so the field adds no
    // bias to the surface it is applied to.
    expect(Math.abs(total / count)).toBeLessThan(0.05);
    expect(extreme).toBeGreaterThan(0.5);
    expect(extreme).toBeLessThan(
      TERRAIN_FINE_BAND_24M_AMPLITUDE_METERS + TERRAIN_FINE_BAND_9M_AMPLITUDE_METERS,
    );
    // At a 512 m footprint every octave is far below Nyquist and the whole
    // term rests at exactly zero — which is why the macro pass, and the
    // `macroUplift` leg of the page seed, never see it at all.
    for (let index = 0; index < 64; index += 1) {
      expect(sampleTerrainFineBandRelief(seedHash, index * 977, -index * 613, 512)).toBe(0);
    }
  });

  it("survives on thin convex ground and is buried by deep soil", () => {
    const crest = terrainFineBandSurvival(0.4, 0.05);
    const floor = terrainFineBandSurvival(6, -0.05);
    expect(crest).toBeGreaterThan(0.9);
    expect(floor).toBe(0);
    // Monotone in soil depth at fixed curvature, and in curvature at fixed
    // soil: the mask must not have a local maximum a landscape could sit in.
    let previousSoil = Number.POSITIVE_INFINITY;
    for (let depth = 0; depth <= 8; depth += 0.25) {
      const value = terrainFineBandSurvival(depth, 0.02);
      expect(value).toBeLessThanOrEqual(previousSoil + 1e-12);
      previousSoil = value;
    }
    let previousCurvature = -1;
    for (let curvature = -0.06; curvature <= 0.06; curvature += 0.002) {
      const value = terrainFineBandSurvival(0.5, curvature);
      expect(value).toBeGreaterThanOrEqual(previousCurvature - 1e-12);
      previousCurvature = value;
    }
    expect(() => terrainFineBandSurvival(Number.NaN, 0)).toThrow(RangeError);
    expect(() => terrainFineBandSurvival(1, Number.NaN)).toThrow(RangeError);
  });
});
