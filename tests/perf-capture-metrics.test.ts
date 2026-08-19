import { describe, expect, it } from "vitest";
import { sustainedFpsFromFrameIntervals } from "../scripts/perf-capture.mts";

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
