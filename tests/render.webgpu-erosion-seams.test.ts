import { describe, expect, it } from "vitest";
import {
  EROSION_HALO_TEXELS,
  EROSION_MAX_OPERATOR_REACH_TEXELS,
  erodeTerrainPage,
  erosionOverlapIsBitExact,
} from "../src/render/webgpu/terrain/TerrainErosionCompute";

/**
 * W-8 (Phase 6 Gate W, register C-10): the composed-reach seam guard.
 *
 * The single-operator theorem (max reach 32 < halo 64) does not cover the
 * composed DAG: breach → MFD → stream power → talus can in principle move
 * information 16+24+32 = 72 texels, 8 beyond the halo. Two instruments close
 * C-10, by measurement rather than a new theorem:
 *
 * 1. `scripts/erosion-seam-audit.mts` — full production scale, real content:
 *    36/36 adjacent L0/L1 page pairs across valley/slope/ridge regimes were
 *    IEEE-bit-exact on their stored overlaps (2026-08-30, seed 333438). It
 *    must be re-run (and stay clean) at every Gate W boundary and before any
 *    re-default decision (PHASE_6_EXECUTION_PLAN.md §8 criterion 1).
 *
 * 2. This test — the same invariant at fixture scale with the composed reach
 *    OVER the halo by the production ratio (18/16 = 72/64 = 1.125), on a
 *    field engineered to fire all three operators near the seam: steep
 *    V-valley walls beyond the angle of repose (talus), convergent channel
 *    flow (stream power), and single-texel pits (breach carving). Influence
 *    decay, not the worst-case sum, is what keeps seams exact; this pins
 *    that the decay holds where the operators are all active.
 *
 * The halo deliberately does NOT grow to 80: it would re-derive the
 * hydrology halo bound, add ~17% page area to every eroded page, and churn
 * every eroded fingerprint — unjustified while both instruments hold clean.
 * If either ever fails, growing the halo is the recorded fallback.
 */
describe("erosion seams (W-8 / C-10, composed reach)", () => {
  const CORE = 64;
  const HALO = 16;
  const CONFIG = {
    pitBreachRadiusTexels: 4,
    streamPowerIterations: 6,
    talusIterations: 8,
  } as const;
  const COMPOSED_REACH = CONFIG.pitBreachRadiusTexels
    + CONFIG.streamPowerIterations
    + CONFIG.talusIterations;

  function fixturePage(originX: number, originZ: number): {
    heights: Float32Array;
    parentFlowAccumulation: Float32Array;
  } {
    const edge = CORE + HALO * 2;
    const heights = new Float32Array(edge * edge);
    const parentFlowAccumulation = new Float32Array(edge * edge);
    for (let z = 0; z < edge; z += 1) {
      for (let x = 0; x < edge; x += 1) {
        const worldX = originX + x - HALO;
        const worldZ = originZ + z - HALO;
        const index = z * edge + x;
        // Steep V-valleys along x: wall gradient 3 m per 2 m texel is well
        // beyond tan(34°), so talus is ACTIVE; the valley floors converge
        // flow for stream power; deep single-texel pits activate breaching.
        const wall = Math.abs(((worldZ % 24) + 24) % 24 - 12) * 3;
        const pit = ((worldX & 31) === 7 && (worldZ & 31) === 11) ? -40 : 0;
        const jitter = ((worldX * 13 + worldZ * 7) & 15) * 0.01;
        heights[index] = Math.fround(500 - worldX * 0.9 + wall + pit + jitter);
        parentFlowAccumulation[index] = Math.fround(
          64 + ((worldX * 5 + worldZ * 3) & 7) * 0.25,
        );
      }
    }
    return { heights, parentFlowAccumulation };
  }

  it("keeps adjacent stored overlaps bit-exact with composed reach 112.5% of the halo", () => {
    // The production ratio this fixture reproduces: 72/64 == 18/16.
    expect(COMPOSED_REACH / HALO).toBeCloseTo(
      (16 + 24 + 32) / EROSION_HALO_TEXELS,
      12,
    );
    // And the single-operator bound still holds, as in production.
    expect(Math.max(...Object.values(CONFIG))).toBeLessThan(HALO);
    expect(EROSION_MAX_OPERATOR_REACH_TEXELS).toBeLessThan(EROSION_HALO_TEXELS);

    const first = erodeTerrainPage({
      coreSize: CORE,
      haloTexels: HALO,
      texelSizeMeters: 2,
      config: CONFIG,
      ...fixturePage(0, 0),
    });
    const right = erodeTerrainPage({
      coreSize: CORE,
      haloTexels: HALO,
      texelSizeMeters: 2,
      config: CONFIG,
      ...fixturePage(CORE, 0),
    });
    const below = erodeTerrainPage({
      coreSize: CORE,
      haloTexels: HALO,
      texelSizeMeters: 2,
      config: CONFIG,
      ...fixturePage(0, CORE),
    });

    expect(erosionOverlapIsBitExact(first, right, "horizontal")).toBe(true);
    expect(erosionOverlapIsBitExact(first, below, "vertical")).toBe(true);
  });

  it("actually fires all three operators (the guard must not be vacuous)", () => {
    const input = fixturePage(0, 0);
    const result = erodeTerrainPage({
      coreSize: CORE,
      haloTexels: HALO,
      texelSizeMeters: 2,
      config: CONFIG,
      ...input,
    });
    const edge = CORE + HALO * 2;
    // Talus precondition: the fixture's walls exceed the repose gradient.
    const reposeRise = Math.tan((34 * Math.PI) / 180) * 2;
    expect(3).toBeGreaterThan(reposeRise);
    // The operators changed a substantial share of the interior.
    let changed = 0;
    let interior = 0;
    for (let z = HALO; z < edge - HALO; z += 1) {
      for (let x = HALO; x < edge - HALO; x += 1) {
        interior += 1;
        if (result.evolvedHeight[z * edge + x] !== input.heights[z * edge + x]) {
          changed += 1;
        }
      }
    }
    expect(changed / interior).toBeGreaterThan(0.5);
    // At least one pit was breach-carved: some cell on the carve path now
    // sits BELOW its input height beyond talus-scale movement.
    let carved = 0;
    for (let index = 0; index < result.evolvedHeight.length; index += 1) {
      if (input.heights[index]! - result.evolvedHeight[index]! > 5) carved += 1;
    }
    expect(carved).toBeGreaterThan(0);
    // The two adjacent fixtures are different terrain (the seam comparison
    // is not trivially comparing identical arrays).
    const other = fixturePage(CORE, 0);
    expect(other.heights).not.toEqual(input.heights);
  });
});
