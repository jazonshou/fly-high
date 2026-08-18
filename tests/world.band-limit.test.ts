import { describe, expect, it } from "vitest";
import { hashSeed } from "../src/world/seed";
import { sampleNaturalTerrainHeight } from "../src/world/terrain";

/**
 * 1B-2 — band-limiting acceptance (assertions 23–25).
 *
 * The kernel carries real amplitude far below a coarse ring's Nyquist; point-
 * sampled, the coarse mesh sat on an arbitrary phase of the 43–160 m noise
 * and was a genuinely different landscape per level — the horizon crawl.
 * Filtered at the grid's own spacing, a coarse page must instead track the
 * local average of the full-bandwidth field (phase agreement, not zero
 * error), without any systematic height bias from the normalisation.
 */

const SEED_HASH = hashSeed("band-limit-acceptance");

/** Deterministic scatter in ±extent, decorrelated from any noise lattice. */
function scatterPoint(index: number, extentMeters: number): { x: number; z: number } {
  const golden = 0.618033988749895;
  const a = (index * golden) % 1;
  const b = (index * index * 0.381966011250105 + index * 0.246979603717467) % 1;
  return {
    x: (a * 2 - 1) * extentMeters,
    z: (b * 2 - 1) * extentMeters,
  };
}

/**
 * 12×12 box average of the full-bandwidth kernel over the band-limit's own
 * footprint. The fade removes wavelengths below 2 × spacing, and a box of
 * extent W suppresses wavelengths below ~W, so the matching reference box
 * spans 2 × spacing — a 1× box keeps exactly the 43–160 m content the filter
 * is required to remove, and would reward point sampling for reproducing it.
 */
function boxAverage(x: number, z: number, spacing: number): number {
  const taps = 12;
  let sum = 0;
  const extent = spacing * 2;
  for (let row = 0; row < taps; row += 1) {
    const dz = ((row + 0.5) / taps - 0.5) * extent;
    for (let column = 0; column < taps; column += 1) {
      const dx = ((column + 0.5) / taps - 0.5) * extent;
      sum += sampleNaturalTerrainHeight(SEED_HASH, x + dx, z + dz, 0);
    }
  }
  return sum / (taps * taps);
}

describe("band-limited terrain kernel (1B-2)", () => {
  it("keeps width 8 within 1 mm of width 0 over 4,096 points (assertion 23)", () => {
    // Physics reads width 0; L0 tiles read width 8. The finest kernel
    // wavelength is 43 m ≥ 3.2 × 8 m, so the fade is exactly a no-op there.
    for (let index = 0; index < 4_096; index += 1) {
      const { x, z } = scatterPoint(index, 40_000);
      const exact = sampleNaturalTerrainHeight(SEED_HASH, x, z, 0);
      const filtered = sampleNaturalTerrainHeight(SEED_HASH, x, z, 8);
      expect(Math.abs(exact - filtered)).toBeLessThan(0.001);
    }
  });

  it("tracks the local box average within 0.25 × spacing RMS (assertion 24)", () => {
    const points = 160;
    for (const spacing of [32, 64, 128, 256, 512]) {
      let filteredSquares = 0;
      let pointSampleSquares = 0;
      for (let index = 0; index < points; index += 1) {
        const { x, z } = scatterPoint(index + 7_000, 20_000);
        const reference = boxAverage(x, z, spacing);
        const filtered = sampleNaturalTerrainHeight(SEED_HASH, x, z, spacing);
        const pointSampled = sampleNaturalTerrainHeight(SEED_HASH, x, z, 0);
        filteredSquares += (filtered - reference) ** 2;
        pointSampleSquares += (pointSampled - reference) ** 2;
      }
      const filteredRms = Math.sqrt(filteredSquares / points);
      const pointSampledRms = Math.sqrt(pointSampleSquares / points);
      expect(filteredRms, `RMS at ${spacing} m`).toBeLessThan(0.25 * spacing);
      // The goal is phase agreement: the filtered field must track the local
      // average better than point sampling does once real fading begins.
      if (spacing >= 128) {
        expect(filteredRms, `improvement at ${spacing} m`).toBeLessThan(pointSampledRms);
      }
    }
  });

  it("keeps the mean height invariant under filter width (assertion 25)", () => {
    // The direct guard on the amplitudeSum normalisation trap: divide by a
    // truncated sum (or fade ridged octaves to zero) and coarse terrain
    // becomes systematically taller or lower. Asserted over a 40 × 40 km
    // window rather than the plan's 100 km²: the mountain-ridge channel fits
    // only ~8 wavelengths across 10 km, so a smaller window measures that
    // one realization's luck (±3 m of estimator noise) instead of the
    // systematic bias the bound is guarding against.
    const gridEdge = 96;
    const extent = 20_000;
    let exactSum = 0;
    let filteredSum = 0;
    for (let row = 0; row < gridEdge; row += 1) {
      const z = (row / (gridEdge - 1) - 0.5) * 2 * extent;
      for (let column = 0; column < gridEdge; column += 1) {
        const x = (column / (gridEdge - 1) - 0.5) * 2 * extent;
        exactSum += sampleNaturalTerrainHeight(SEED_HASH, x, z, 0);
        filteredSum += sampleNaturalTerrainHeight(SEED_HASH, x, z, 512);
      }
    }
    const samples = gridEdge * gridEdge;
    expect(Math.abs(exactSum / samples - filteredSum / samples)).toBeLessThan(2);
  });
});
