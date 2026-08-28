import { describe, expect, it } from "vitest";
import {
  luminanceFromRgba,
  meanRgbSsim,
  meanSsim,
  perfCaptureImageContentFailures,
  rawFrameIntervalMetrics,
  sustainedFpsFromFrameIntervals,
  tier1BalancedPerformanceFailures,
  tileStatistics,
  worstTileRgbSsim,
} from "../scripts/perf-capture.mts";

/**
 * The sustained-fps metric split (Gate 2A re-pin): `minFps` gates the
 * SUSTAINED rate and must therefore ignore sparse stalls — those are what
 * `maxFrameMs`/`p999FrameMs`/`hitchCount` exist for — while still failing a
 * build that is slow in every frame.
 */
describe("sustainedFpsFromFrameIntervals", () => {
  it("returns the exact rate for uniform intervals", () => {
    const intervals = Array.from({ length: 240 }, () => 1000 / 30);
    expect(sustainedFpsFromFrameIntervals(intervals)).toBeCloseTo(30, 5);
  });

  it("ignores sparse stalls that a wall-clock mean re-counts", () => {
    // 235 healthy 33.3ms frames + 5 × 350ms stalls: the wall-clock mean drops
    // to ~24.9 fps, the sustained rate stays ~30.
    const intervals = [
      ...Array.from({ length: 235 }, () => 1000 / 30),
      ...Array.from({ length: 5 }, () => 350),
    ];
    const wallClock = intervals.length
      / (intervals.reduce((a, b) => a + b, 0) / 1000);
    expect(wallClock).toBeLessThan(26);
    expect(sustainedFpsFromFrameIntervals(intervals)).toBeCloseTo(30, 1);
  });

  it("still fails a uniformly slow build (the run-1 regression shape)", () => {
    // Every frame ~38ms (the slant-10km 26.4 fps regression): trimming the
    // slowest 5% of identical intervals cannot rescue it.
    const intervals = Array.from({ length: 240 }, () => 1000 / 26.4);
    expect(sustainedFpsFromFrameIntervals(intervals)).toBeCloseTo(26.4, 1);
  });

  it("keeps at least one interval at extreme trim fractions", () => {
    expect(sustainedFpsFromFrameIntervals([20, 1000], 0.9)).toBeCloseTo(50, 5);
  });

  it("rejects empty input and invalid trims", () => {
    expect(() => sustainedFpsFromFrameIntervals([])).toThrow(RangeError);
    expect(() => sustainedFpsFromFrameIntervals([16], 1)).toThrow(RangeError);
    expect(() => sustainedFpsFromFrameIntervals([16], -0.1)).toThrow(RangeError);
  });
});

describe("strict tier-1 frame-delivery metrics", () => {
  it("keeps freezes in wall-clock fps and fails them at the strict gate", () => {
    const metrics = rawFrameIntervalMetrics([
      ...Array.from({ length: 235 }, () => 16),
      ...Array.from({ length: 5 }, () => 350),
    ]);

    expect(metrics.wallClockFps).toBeLessThan(60);
    expect(metrics.framesOver16_67Ms).toBe(5);
    expect(metrics.framesOver27_4Ms).toBe(5);
    expect(metrics.maxFrameMs).toBe(350);
    expect(tier1BalancedPerformanceFailures(metrics)).toEqual(expect.arrayContaining([
      expect.stringContaining("wall-clock fps"),
      expect.stringContaining("maximum frame"),
    ]));
  });

  it("rejects 59.9 wall-clock fps even when every other metric clears", () => {
    expect(tier1BalancedPerformanceFailures({
      wallClockFps: 59.9,
      frameIntervalMsP95: 16.67,
      framesOver27_4Ms: 5,
      maxFrameMs: 50,
    })).toEqual([expect.stringContaining("wall-clock fps")]);
  });

  it("rejects a 50.1 ms worst frame", () => {
    expect(tier1BalancedPerformanceFailures({
      wallClockFps: 60,
      frameIntervalMsP95: 16.67,
      framesOver27_4Ms: 5,
      maxFrameMs: 50.1,
    })).toEqual([expect.stringContaining("maximum frame")]);
  });

  it("enforces p95 and the explicit 27.4 ms hitch count", () => {
    expect(tier1BalancedPerformanceFailures({
      wallClockFps: 75,
      frameIntervalMsP95: 16.68,
      framesOver27_4Ms: 6,
      maxFrameMs: 40,
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("frame-interval p95"),
      expect.stringContaining("frames exceeded 27.4 ms"),
    ]));
  });

  it("accepts the exact strict boundary and validates raw inputs", () => {
    expect(tier1BalancedPerformanceFailures({
      wallClockFps: 60,
      frameIntervalMsP95: 16.67,
      framesOver27_4Ms: 5,
      maxFrameMs: 50,
    })).toEqual([]);
    expect(() => rawFrameIntervalMetrics([])).toThrow(RangeError);
    expect(() => rawFrameIntervalMetrics([16, Number.NaN])).toThrow(RangeError);
    expect(() => rawFrameIntervalMetrics([16, 0])).toThrow(RangeError);
  });

  it("counts only intervals strictly over the explicit frame budgets", () => {
    const metrics = rawFrameIntervalMetrics([16.67, 16.671, 27.4, 27.401]);
    expect(metrics.framesOver16_67Ms).toBe(3);
    expect(metrics.framesOver27_4Ms).toBe(1);
  });
});

function solidRgba(
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(color, index * 4);
  }
  return pixels;
}

describe("perf-capture screenshot non-vacuity", () => {
  const statisticsFor = (
    width: number,
    height: number,
    pixels: Uint8ClampedArray,
  ) => tileStatistics(luminanceFromRgba(pixels, width, height), width, height);

  it("rejects a black frame independently of baseline similarity", () => {
    const statistics = statisticsFor(32, 32, solidRgba(32, 32, [0, 0, 0, 255]));

    expect(perfCaptureImageContentFailures(statistics)).toEqual([
      expect.stringContaining("mean luminance"),
      expect.stringContaining("mean per-tile luminance variance"),
      expect.stringContaining("structured tile fraction"),
    ]);
  });

  it("rejects a uniformly bright frame that clears the luminance floor", () => {
    const statistics = statisticsFor(32, 32, solidRgba(32, 32, [96, 96, 96, 255]));

    expect(statistics.meanLuminance).toBeGreaterThan(0.01);
    expect(perfCaptureImageContentFailures(statistics)).toEqual([
      expect.stringContaining("mean per-tile luminance variance"),
      expect.stringContaining("structured tile fraction"),
    ]);
  });

  it("rejects a tiny noisy patch even when it rescues whole-frame mean variance", () => {
    const width = 128;
    const height = 128;
    const pixels = solidRgba(width, height, [96, 96, 96, 255]);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const value = (x + y) % 2 === 0 ? 0 : 255;
        pixels.set([value, value, value, 255], (y * width + x) * 4);
      }
    }
    const statistics = statisticsFor(width, height, pixels);

    expect(statistics.meanVariance).toBeGreaterThan(0.000_1);
    expect(statistics.structuredTileFraction).toBe(0.0625);
    expect(perfCaptureImageContentFailures(statistics)).toEqual([
      expect.stringContaining("structured tile fraction"),
    ]);
  });

  it("accepts dim structure distributed across the frame", () => {
    const width = 128;
    const height = 128;
    const pixels = solidRgba(width, height, [2, 2, 2, 255]);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((x + y) % 2 === 0) pixels.set([9, 9, 9, 255], (y * width + x) * 4);
      }
    }
    const statistics = statisticsFor(width, height, pixels);

    expect(statistics.meanVariance).toBeGreaterThan(0.000_1);
    expect(statistics.structuredTileFraction).toBe(1);
    expect(perfCaptureImageContentFailures(statistics)).toEqual([]);
  });

  it("accepts the exact 50 percent distributed-coverage boundary", () => {
    expect(perfCaptureImageContentFailures({
      meanLuminance: 0.2,
      meanVariance: 0.001,
      structuredTileFraction: 0.5,
    })).toEqual([]);
  });

  it("pins the known slate-frame regression independently of baseline SSIM", () => {
    const knownBlankFailure = {
      meanLuminance: 0.3959,
      meanVariance: 0.000_006,
      structuredTileFraction: 0.1489,
    };

    expect(perfCaptureImageContentFailures(knownBlankFailure)).toEqual([
      expect.stringContaining("mean per-tile luminance variance"),
      expect.stringContaining("structured tile fraction"),
    ]);
    expect(perfCaptureImageContentFailures(knownBlankFailure, {
      minMeanTileVariance: 0.000_005,
      minStructuredTileFraction: 0.1,
    })).toEqual([]);
    expect(() => perfCaptureImageContentFailures(knownBlankFailure, {
      minMeanTileVariance: Number.NaN,
    })).toThrow(RangeError);
    expect(() => perfCaptureImageContentFailures(knownBlankFailure, {
      minStructuredTileFraction: 1.01,
    })).toThrow(RangeError);
  });
});

describe("color- and locality-aware visual metrics", () => {
  it("detects an equal-luminance hue replacement that grayscale SSIM misses", () => {
    const width = 8;
    const height = 8;
    const red = solidRgba(width, height, [255, 0, 0, 255]);
    // Rec.709 luminance is effectively the same as pure red: 76/255 * .7152 ≈ .213.
    const green = solidRgba(width, height, [0, 76, 0, 255]);
    const redLuma = luminanceFromRgba(red, width, height);
    const greenLuma = luminanceFromRgba(green, width, height);

    expect(meanSsim(redLuma, greenLuma, width, height)).toBeGreaterThan(0.999);
    expect(meanRgbSsim(red, green, width, height)).toBeLessThan(0.4);
  });

  it("exposes one broken terrain tile even when the whole-frame mean stays high", () => {
    const width = 256;
    const height = 256;
    const baseline = solidRgba(width, height, [82, 116, 72, 255]);
    const regressed = baseline.slice();
    for (let y = 128; y < 192; y += 1) {
      for (let x = 128; x < 192; x += 1) {
        regressed.set([176, 42, 168, 255], (y * width + x) * 4);
      }
    }

    expect(meanRgbSsim(baseline, regressed, width, height)).toBeGreaterThan(0.9);
    expect(worstTileRgbSsim(baseline, regressed, width, height)).toBeLessThan(0.72);
  });

  it("validates RGBA dimensions, regions, and tile sizes", () => {
    const pixels = solidRgba(8, 8, [0, 0, 0, 255]);
    expect(meanRgbSsim(pixels, pixels, 8, 8)).toBe(1);
    expect(() => meanRgbSsim(pixels, pixels, 8, 8, {
      x: 0,
      y: 0,
      width: 9,
      height: 8,
    })).toThrow(RangeError);
    expect(() => worstTileRgbSsim(pixels, pixels, 8, 8, 10)).toThrow(RangeError);
  });
});
