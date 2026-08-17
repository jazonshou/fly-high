import { describe, expect, it } from "vitest";
import {
  NOISE_LATTICE_WRAP_PERIOD_CELLS,
  valueNoise2D,
} from "../src/world/noise";
import { hashCoordinates, hashSeed, mixSeed, unitFloatFromHash } from "../src/world/seed";
import { sampleGeologicalRelief } from "../src/world/geology";
import {
  createWorld,
  sampleNaturalTerrainHeight,
  sampleTerrainMoisture,
  sampleTerrainTemperature,
} from "../src/world";

/**
 * 0-4 — kernel portability. These tests pin the properties that make the
 * analytic kernel portable to WGSL at 4-1 without changing what it computes:
 * a 24-bit hash quotient that f32 reproduces exactly, a per-octave domain
 * wrap that keeps lattice arithmetic bounded, and the threaded-but-inert
 * filterWidthMeters parameter that 1B-2 will later activate.
 */

/** The pre-0-4 valueNoise2D, minus the wrap: the near-origin reference. */
function unwrappedValueNoise2D(seedHash: number, x: number, z: number): number {
  const fade = (value: number): number =>
    value * value * value * (value * (value * 6 - 15) + 10);
  const lattice = (latticeX: number, latticeZ: number): number =>
    unitFloatFromHash(hashCoordinates(seedHash, latticeX, latticeZ)) * 2 - 1;
  const lerp = (start: number, end: number, amount: number): number =>
    start + (end - start) * amount;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = fade(x - x0);
  const tz = fade(z - z0);
  const a = lerp(lattice(x0, z0), lattice(x0 + 1, z0), tx);
  const b = lerp(lattice(x0, z0 + 1), lattice(x0 + 1, z0 + 1), tx);
  return lerp(a, b, tz);
}

describe("kernel portability (0-4)", () => {
  it("returns a 24-bit hash quotient exactly representable in f32", () => {
    const seeds = [hashSeed("open-skies"), hashSeed(42), 0, 0xffff_ffff, 0x00ff, 0xff00_0000];
    for (const hash of seeds) {
      const value = unitFloatFromHash(hash);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      // The binding §1.3 requirement: bit-identical between f64 and f32.
      expect(Math.fround(value)).toBe(value);
      expect(value).toBe((hash >>> 8) / 16_777_216);
    }
  });

  it("keeps the domain wrap an exact no-op near the origin", () => {
    // §0-4 promises no change for |x| < 10⁴ m; the wrap is actually an exact
    // no-op out to period/2 lattice cells. Cover the promised range for every
    // kernel octave scale, in lattice units.
    const seed = mixSeed(hashSeed("wrap-noop"), 7);
    const octaveMeters = [43, 105, 310, 850, 13_500];
    for (const wavelength of octaveMeters) {
      for (let step = -20; step <= 20; step += 1) {
        const worldX = (step / 20) * 10_000;
        const worldZ = ((20 - step) / 20) * 10_000 - 5_000;
        const x = worldX / wavelength;
        const z = worldZ / wavelength;
        expect(valueNoise2D(seed, x, z)).toBe(unwrappedValueNoise2D(seed, x, z));
      }
    }
  });

  it("stays continuous and periodic across the wrap seam at planetary distances", () => {
    // The failure mode this guards: a parity test that passes near the origin
    // and a simulation that breaks at 500 km. The wrap seam nearest a given
    // octave's 5×10⁶ m mark must be invisible: the field is continuous through
    // it and exactly periodic across it. (A statistical step-size transect is
    // deliberately not used per octave — value noise's own slope distribution
    // exceeds 4× its median without any seam; the composed-kernel transect
    // below covers the plan's transect form.)
    const seed = mixSeed(hashSeed("wrap-seam"), 11);
    const period = NOISE_LATTICE_WRAP_PERIOD_CELLS;
    for (const wavelength of [43, 105, 310, 850]) {
      const seamIndex = Math.max(0, Math.round(5e6 / (period * wavelength) - 0.5));
      const seamCells = (seamIndex + 0.5) * period;
      // Continuity: an infinitesimal straddle of the seam moves the value by
      // no more than the local derivative can explain. A seam bug decorrelates
      // the lattice and shows up as an O(1) jump.
      const epsilon = 1e-6;
      const below = valueNoise2D(seed, seamCells - epsilon, 0.35);
      const above = valueNoise2D(seed, seamCells + epsilon, 0.35);
      expect(Math.abs(above - below)).toBeLessThan(1e-5);
      // Periodicity: the wrapped field repeats bit-exactly every period, which
      // is precisely the property the WGSL page-origin reduction (4-1) needs.
      for (const offsetCells of [-7.25, -0.5, 0.125, 3.75]) {
        const x = seamCells + offsetCells;
        expect(valueNoise2D(seed, x + period, 0.35)).toBe(valueNoise2D(seed, x, 0.35));
        expect(valueNoise2D(seed, x - period, 0.35)).toBe(valueNoise2D(seed, x, 0.35));
        expect(valueNoise2D(seed, 0.35, x + period)).toBe(valueNoise2D(seed, 0.35, x));
      }
    }
  });

  it("keeps the composed kernel continuous across a wrap seam at ~4.9×10⁶ m", () => {
    // Centered on an exact seam so the assertion can actually fail on a seam
    // bug: the `fine` channel (terrain.ts) samples unwarped x/310 with
    // lacunarity 2.04, so its third octave wraps at (period/2)·310/2.04².
    const seamX = (0.5 * NOISE_LATTICE_WRAP_PERIOD_CELLS * 310) / 2.04 ** 2;
    const world = createWorld("wrap-composed-transect", { airport: false });
    const steps: number[] = [];
    let previous = sampleNaturalTerrainHeight(world.seedHash, seamX - 500, 137.5, 0);
    for (let offset = -499; offset <= 500; offset += 1) {
      const value = sampleNaturalTerrainHeight(world.seedHash, seamX + offset, 137.5, 0);
      steps.push(Math.abs(value - previous));
      previous = value;
    }
    const sorted = [...steps].sort((first, second) => first - second);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const largest = sorted[sorted.length - 1] ?? 0;
    expect(Number.isFinite(largest)).toBe(true);
    expect(largest).toBeLessThanOrEqual(Math.max(median * 4, 0.5));
  });

  it("treats filterWidthMeters as a behavioural no-op in Phase 0", () => {
    // 1B-2 relaxes this to the 1 mm L0 bound; until then width 0 and width 8
    // must agree bit-for-bit everywhere.
    const world = createWorld("filter-width-invariance", { airport: false });
    for (let index = 0; index < 4_096; index += 1) {
      // Deterministic low-discrepancy-ish scatter over ±40 km.
      const x = ((index * 2_654_435_761 % 4_294_967_296) / 4_294_967_296 - 0.5) * 80_000;
      const z = ((index * 2_246_822_519 % 4_294_967_296) / 4_294_967_296 - 0.5) * 80_000;
      expect(sampleNaturalTerrainHeight(world.seedHash, x, z, 0)).toBe(
        sampleNaturalTerrainHeight(world.seedHash, x, z, 8),
      );
    }
    const probe = [12_345.5, -6_789.25] as const;
    expect(sampleTerrainMoisture(world, probe[0], probe[1], 0)).toBe(
      sampleTerrainMoisture(world, probe[0], probe[1], 8),
    );
    expect(sampleTerrainTemperature(world, probe[0], probe[1], 0)).toBe(
      sampleTerrainTemperature(world, probe[0], probe[1], 8),
    );
    expect(sampleGeologicalRelief(world.seedHash, probe[0], probe[1], 0, 1, 0.8, 0.65)).toBe(
      sampleGeologicalRelief(world.seedHash, probe[0], probe[1], 8, 1, 0.8, 0.65),
    );
  });

  it("rejects malformed filter widths at every kernel entry point", () => {
    const world = createWorld("filter-width-validation", { airport: false });
    expect(() => sampleNaturalTerrainHeight(world.seedHash, 0, 0, -1)).toThrow(RangeError);
    expect(() => sampleNaturalTerrainHeight(world.seedHash, 0, 0, Number.NaN)).toThrow(RangeError);
    expect(() => sampleTerrainMoisture(world, 0, 0, -1)).toThrow(RangeError);
    expect(() => sampleTerrainTemperature(world, 0, 0, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    expect(() => sampleGeologicalRelief(world.seedHash, 0, 0, -0.5, 1, 1, 1)).toThrow(RangeError);
  });
});
