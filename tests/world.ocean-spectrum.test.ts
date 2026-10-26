import { describe, expect, it } from "vitest";
import {
  createOceanWave,
  oceanCascadeFrequencyReach,
  oceanInitialWave,
  oceanSignedFrequencyIndex,
  oceanSpectrumParameters,
  oceanWavePhaseIndex,
} from "@/src/sim/water/spectrum";
import { resolveSpectralOceanConfig } from "@/src/sim/water/spectrumConfig";

const SHIPPING_SEED = 0x4f434541;
const WIND_DIRECTION: readonly [number, number] = [Math.sin(4.2243797), Math.cos(4.2243797)];

describe("ocean wave phase index", () => {
  it("keeps the 128-point FFT's own texel index for every wave of the 128 grid", () => {
    let moved = 0;
    for (let y = 0; y < 128; y += 1) {
      for (let x = 0; x < 128; x += 1) {
        const index = oceanWavePhaseIndex(
          oceanSignedFrequencyIndex(x, 128),
          oceanSignedFrequencyIndex(y, 128),
        );
        if (index !== x + y * 128) moved += 1;
      }
    }
    expect(moved).toBe(0);
  });

  it("gives every wave of the 512 grid its own index, independent of the FFT size", () => {
    const limit = 128 * 128 + 256 * 256 + 512 * 512;
    const seen = new Set<number>();
    let outOfRange = 0;
    for (let y = 0; y < 512; y += 1) {
      for (let x = 0; x < 512; x += 1) {
        const index = oceanWavePhaseIndex(
          oceanSignedFrequencyIndex(x, 512),
          oceanSignedFrequencyIndex(y, 512),
        );
        if (index < 0 || index >= limit) outOfRange += 1;
        seen.add(index);
      }
    }
    expect(outOfRange).toBe(0);
    expect(seen.size).toBe(512 * 512);
  });
});

describe("tier-independent ocean spectrum", () => {
  it("draws bands 1-4 identically at 128 and 256 points, with nothing outside the 128 grid", () => {
    const wave128 = createOceanWave();
    const wave256 = createOceanWave();
    for (const wind of [3.5, 9.62323060631752, 12]) {
      const low = resolveSpectralOceanConfig({
        resolution: 128,
        seed: SHIPPING_SEED,
        windSpeedMetersPerSecond: wind,
        windDirection: WIND_DIRECTION,
      });
      const high = resolveSpectralOceanConfig({
        resolution: 256,
        seed: SHIPPING_SEED,
        windSpeedMetersPerSecond: wind,
        windDirection: WIND_DIRECTION,
      });
      for (let cascade = 1; cascade < 5; cascade += 1) {
        expect(oceanCascadeFrequencyReach(high, cascade)).toBeLessThanOrEqual(63);
        const lowParams = oceanSpectrumParameters(low, cascade);
        const highParams = oceanSpectrumParameters(high, cascade);
        let nonzero = 0;
        let outside = 0;
        let mismatched = 0;
        for (let fy = -127; fy <= 128; fy += 1) {
          for (let fx = -127; fx <= 128; fx += 1) {
            oceanInitialWave(high, highParams, cascade, fx, fy, wave256);
            const insideLowGrid = Math.max(fx, 1 - fx, fy, 1 - fy) <= 64;
            if (!insideLowGrid) {
              if (wave256.spectrum !== 0) outside += 1;
              continue;
            }
            oceanInitialWave(low, lowParams, cascade, fx, fy, wave128);
            if (wave128.h0Re !== wave256.h0Re || wave128.h0Im !== wave256.h0Im) mismatched += 1;
            if (wave128.spectrum > 0) nonzero += 1;
          }
        }
        expect({ cascade, wind, outside, mismatched }).toEqual({ cascade, wind, outside: 0, mismatched: 0 });
        expect(nonzero).toBeGreaterThan(100);
      }
    }
  });
});
