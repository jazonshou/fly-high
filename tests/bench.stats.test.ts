import { describe, expect, it } from "vitest";
import {
  benchCadence,
  compileDelta,
  compileTotal,
  countOver,
  createFrameLog,
  earlyStopCheck,
  estimateRefresh,
  flightCadence,
  flightSegments,
  intervalHistogram,
  missedRefresh,
  nearestRank,
  onePercentLowFps,
  overheadSummary,
  pacedHz,
  perSecondRows,
  rafReport,
  recordFrame,
  recordOverhead,
  sortedPositive,
  spread,
  summarizeHeap,
  summarizeLongAnimationFrames,
  summarizeLongTasks,
  summarizeWindow,
  timerReport,
  vsyncBuckets,
  windowHistogram,
  worstFrames,
  ZERO_COMPILES,
  type FrameWindowContext,
} from "../src/bench/stats";
import { benchTimings } from "../src/bench/plan";
import type { BenchFrameLog, BenchWindowSpec } from "../src/bench/types";
import { frameTimingPercentile } from "../src/render/webgpu/core/QualityProfile";

/** A deterministic generator, so a failing stream can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface Stream {
  readonly intervals: readonly number[];
  readonly renderMs?: (frame: number) => number;
  readonly compiles?: (frame: number) => number;
}

/** A log whose frame `i` stays up for `intervals[i]`; one extra frame closes the last interval. */
function logOf(stream: Stream, startMs = 1_000): BenchFrameLog {
  const log = createFrameLog(stream.intervals.length + 8);
  let time = startMs;
  stream.intervals.forEach((interval, frame) => {
    recordFrame(log, time, time + 0.1, stream.renderMs?.(frame) ?? 4, stream.compiles?.(frame) ?? 0, false, null);
    time += interval;
  });
  recordFrame(log, time, time + 0.1, 4, 0, false, null);
  return log;
}

function context(refreshHz: number | null, granularityMs: number | null = 0.005, divisor = 1): FrameWindowContext {
  return {
    flightStartMs: 1_000,
    refreshMs: refreshHz === null ? null : 1_000 / refreshHz,
    divisor,
    granularityMs,
    tierThresholdMs: 27.4,
  };
}

const WHOLE: BenchWindowSpec = { name: "air", startS: 0, endS: 1_000 };

describe("percentiles", () => {
  it("match frameTimingPercentile's nearest rank on every quantile", () => {
    const next = random(7);
    for (const size of [1, 2, 3, 10, 99, 240, 1_001]) {
      const samples = Array.from({ length: size }, () => 2 + next() * 60);
      samples.push(0, -1, Number.NaN, Number.POSITIVE_INFINITY);
      const sorted = sortedPositive(samples);
      for (const quantile of [0, 0.01, 0.5, 0.9, 0.95, 0.99, 0.999, 1]) {
        expect(nearestRank(sorted, quantile), `${size} @ ${quantile}`)
          .toBe(frameTimingPercentile(samples, quantile));
      }
    }
    expect(nearestRank([], 0.5)).toBeNull();
  });
});

describe("synthetic display streams", () => {
  const rates = [50, 59.94, 60, 75, 120, 144, 165, 240];

  it("a clean stream at each refresh rate reads as that rate, display-capped, every frame on vsync", () => {
    for (const hz of rates) {
      const period = 1_000 / hz;
      const frames = Math.round(hz * 20);
      const window = summarizeWindow(logOf({ intervals: new Array(frames).fill(period) }), WHOLE, context(hz));
      expect(window.fps, `${hz}`).toBeCloseTo(hz, 6);
      expect(window.frames).toBe(frames);
      expect(window.seconds).toBeCloseTo((frames * period) / 1_000, 6);
      expect(window.displayCapped).toBe(true);
      expect(window.vsyncBuckets).toMatchObject({ divisor: 1, x1: frames, x2: 0, x3: 0, x4plus: 0, offSlot: 0, irregular: 0 });
      expect(window.missedRefresh).toEqual({ count: 0, per240: 0, longestStreak: 0 });
      expect(window.over["27.4"].count).toBe(0);
      expect(window.onePercentLowFps).toBeCloseTo(hz, 6);
    }
  });

  it("jitter within 3% stays on vsync; a dropped refresh lands in x2 and counts as missed", () => {
    for (const hz of rates) {
      const period = 1_000 / hz;
      const next = random(hz * 100);
      const intervals = Array.from({ length: 1_200 }, (_, frame) =>
        (frame % 10 === 9 ? 2 * period : period) + (next() - 0.5) * 0.04 * period);
      const window = summarizeWindow(logOf({ intervals }), WHOLE, context(hz));
      expect(window.vsyncBuckets, `${hz}`).toMatchObject({ x1: 1_080, x2: 120, x3: 0, x4plus: 0, irregular: 0 });
      expect(window.missedRefresh).toEqual({ count: 120, per240: 24, longestStreak: 1 });
      // The median frame still sits on the refresh period.
      expect(window.displayCapped).toBe(true);
    }
  });

  it("a VRR-like stream reads mostly irregular and not display-capped", () => {
    const next = random(3);
    const intervals = Array.from({ length: 2_000 }, () => 7 + next() * 13);
    const window = summarizeWindow(logOf({ intervals }), WHOLE, context(144));
    const buckets = window.vsyncBuckets!;
    expect(buckets.irregular).toBeGreaterThan(buckets.x1 + buckets.x2 + buckets.x3);
    expect(window.displayCapped).toBe(false);
    expect(buckets.x1 + buckets.x2 + buckets.x3 + buckets.x4plus + buckets.offSlot + buckets.irregular).toBe(2_000);
  });

  it("long stalls land in x4plus and in the 50 and 100 ms counts", () => {
    const period = 1_000 / 60;
    const intervals = new Array<number>(240).fill(period);
    intervals[10] = 60;
    intervals[20] = 120;
    intervals[30] = 33.3;
    const window = summarizeWindow(logOf({ intervals }), WHOLE, context(60));
    expect(window.vsyncBuckets).toMatchObject({ x4plus: 2, x2: 1, x1: 237 });
    expect(window.over["27.4"].count).toBe(3);
    expect(window.over["50"].count).toBe(2);
    expect(window.over["100"].count).toBe(1);
    expect(window.over.hitch).toMatchObject({ count: 3, thresholdMs: 27.4 });
    expect(window.intervalMs?.max).toBe(120);
  });
});

describe("counts, histogram, 1% low and spread", () => {
  it("counts per 240 frames and per minute of the intervals' own time", () => {
    const intervals = new Array<number>(234).fill(16).concat(new Array<number>(6).fill(30));
    const over = countOver(intervals, 27.4);
    const totalMs = 234 * 16 + 6 * 30;
    expect(over).toEqual({ count: 6, per240: 6, perMinute: (6 * 60_000) / totalMs });
    expect(countOver(new Array<number>(10).fill(27.4), 27.4).count).toBe(0);
    expect(countOver([], 27.4)).toEqual({ count: 0, per240: 0, perMinute: 0 });
  });

  it("bins 1 ms wide with everything from 100 ms in the last bin", () => {
    const histogram = intervalHistogram([0.2, 0.99, 1, 16.7, 99.999, 100, 500]);
    expect(histogram.binMs).toBe(1);
    expect(histogram.counts).toHaveLength(101);
    expect(histogram.counts[0]).toBe(2);
    expect(histogram.counts[1]).toBe(1);
    expect(histogram.counts[16]).toBe(1);
    expect(histogram.counts[99]).toBe(1);
    expect(histogram.counts[100]).toBe(2);
    expect(histogram.counts.reduce((sum, count) => sum + count, 0)).toBe(7);
  });

  it("1% low is the frame rate of the slowest 1% of frames", () => {
    const intervals = new Array<number>(990).fill(10).concat(new Array<number>(10).fill(50));
    expect(onePercentLowFps(sortedPositive(intervals))).toBeCloseTo(20, 9);
    expect(onePercentLowFps(sortedPositive([10, 40]))).toBeCloseTo(25, 9);
    expect(onePercentLowFps([])).toBeNull();
  });

  it("spread is |a - b| / min(a, b): 10.0% sits on the threshold, 10.1% over it", () => {
    expect(spread(100, 110)).toBeCloseTo(0.1, 12);
    expect(spread(110, 100)! <= 0.1).toBe(true);
    expect(spread(110.1, 100)! > 0.1).toBe(true);
    expect(spread(null, 100)).toBeNull();
    expect(spread(0, 100)).toBeNull();
  });
});

describe("windows over a flight", () => {
  // 64 Hz: a period exact in binary, so frame times sum without rounding.
  const period = 15.625;
  const flight = { intervals: new Array<number>(75 * 64).fill(period) };

  it("cuts frames by their own timestamp and closes each interval with the next frame", () => {
    const log = logOf(flight);
    const timings = benchTimings(false);
    const ground = summarizeWindow(log, timings.ground, context(64));
    const air = summarizeWindow(log, timings.air, context(64));
    expect(ground.frames).toBe(12 * 64);
    expect(air.frames).toBe(45 * 64);
    expect(ground.name).toBe("ground");
    expect(air.lowSample).toBe(false);
    const segments = flightSegments(log, context(64), timings.flightS);
    expect(segments.map((segment) => [segment.startS, segment.endS]))
      .toEqual([[0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 75]]);
    expect(segments.every((segment) => segment.fps === 64)).toBe(true);
    expect(windowHistogram(log, timings.air, context(64)).counts[15]).toBe(45 * 64);
  });

  it("splits interval statistics on frames that compiled from those that did not", () => {
    const intervals = new Array<number>(600).fill(period);
    intervals[100] = 80;
    intervals[200] = 40;
    const log = logOf({ intervals, compiles: (frame) => (frame === 100 || frame === 200 ? 3 : 0) });
    const window = summarizeWindow(log, WHOLE, context(64));
    expect(window.framesWithCompiles).toBe(2);
    expect(window.compileSplit.withCompiles).toEqual({ frames: 2, p50: 40, p95: 80, max: 80 });
    expect(window.compileSplit.withoutCompiles.frames).toBe(598);
    expect(window.compileSplit.withoutCompiles.max).toBe(period);
  });

  it("render time, its start-to-start interval and GPU samples come from the log", () => {
    const log = createFrameLog(64);
    for (let frame = 0; frame < 41; frame += 1) {
      const time = 1_000 + frame * period;
      recordFrame(log, time, time + 0.2, 2 + (frame % 4), 0, frame === 7, frame % 2 === 0 ? 5 : null);
    }
    const window = summarizeWindow(log, WHOLE, context(64, 1));
    expect(window.frames).toBe(40);
    expect(window.renderMs).toMatchObject({ p50: 3, max: 5, coarse: true });
    expect(window.renderStartIntervalMs?.max).toBe(period);
    expect(window.gpuMs).toMatchObject({ samples: 20, p50: 5 });
    expect(window.scaleStepFrames).toBe(1);
    expect(summarizeWindow(log, WHOLE, context(64, 0.005)).renderMs?.coarse).toBe(false);
  });

  it("with no idle probe, refresh-based figures are null rather than guessed", () => {
    const window = summarizeWindow(logOf(flight), WHOLE, context(null));
    expect(window.missedRefresh).toBeNull();
    expect(window.vsyncBuckets).toBeNull();
    expect(window.displayCapped).toBe(false);
  });

  it("an empty window reads as nothing, not as zero frame time", () => {
    const window = summarizeWindow(logOf(flight), { name: "air", startS: 500, endS: 600 }, context(64));
    expect(window).toMatchObject({ frames: 0, fps: null, intervalMs: null, renderMs: null, gpuMs: null, lowSample: true });
  });

  it("names the worst frames with what they did and the long tasks inside them", () => {
    const intervals = new Array<number>(300).fill(period);
    intervals[50] = 90;
    intervals[120] = 45;
    const log = logOf({ intervals, renderMs: (frame) => (frame === 50 ? 70 : 3), compiles: (frame) => (frame === 120 ? 2 : 0) });
    const start50 = 1_000 + 50 * period;
    const worst = worstFrames(log, WHOLE, context(64), [{ startMs: start50 + 10, durationMs: 60 }, { startMs: 0, durationMs: 1 }], 3);
    expect(worst).toHaveLength(3);
    expect(worst[0]).toMatchObject({ t: (50 * period) / 1_000, intervalMs: 90, renderMs: 70, compiles: 0, longTaskMs: 60 });
    expect(worst[1]).toMatchObject({ intervalMs: 45, compiles: 2, longTaskMs: 0 });
    expect(worstFrames(log, WHOLE, context(64), null, 1)[0]!.longTaskMs).toBeNull();
  });

  it("per-second rows merge the controller's once-a-second snapshot", () => {
    const rows = perSecondRows(logOf(flight), context(64), 3, [
      { appliedScale: 0.86, renderPixels: 1_500_000, cpuLevel: 0, gpuLevel: 1, heapBytes: 104_857_600 },
      null,
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ second: 0, frames: 64, over27: 0, appliedScale: 0.86, gpuLevel: 1, heapMiB: 100 });
    expect(rows[1]).toMatchObject({ second: 1, appliedScale: null, heapMiB: null });
    expect(rows[2]!.maxIntervalMs).toBe(period);
  });

  it("stops early under 5 fps between 3 and 20 s, and with no frames at all", () => {
    const timings = benchTimings(false);
    expect(earlyStopCheck(logOf({ intervals: new Array<number>(100).fill(250) }), context(60), timings))
      .toMatchObject({ stop: true });
    expect(earlyStopCheck(logOf({ intervals: new Array<number>(100).fill(250) }), context(60), timings).fps)
      .toBeCloseTo(4, 9);
    expect(earlyStopCheck(logOf({ intervals: new Array<number>(600).fill(100) }), context(60), timings).stop)
      .toBe(false);
    expect(earlyStopCheck(createFrameLog(4), context(60), timings)).toEqual({ stop: true, fps: null });
  });

  it("flags overflow instead of writing past the arrays, and keeps the overhead per frame", () => {
    const log = createFrameLog(2);
    expect(recordFrame(log, 1_000, 1_000, 1, 0, false, null)).toBe(true);
    recordOverhead(log, 0.05);
    expect(recordFrame(log, 1_010, 1_010, 1, 70_000, false, null)).toBe(true);
    recordOverhead(log, 0.15);
    expect(log.compiles[1]).toBe(0xffff);
    expect(recordFrame(log, 1_020, 1_020, 1, 0, false, null)).toBe(false);
    expect(log.overflowed).toBe(true);
    expect(log.length).toBe(2);
    const overhead = overheadSummary(log, context(60), 0, 1);
    expect(overhead?.p50).toBeCloseTo(0.05, 6);
    expect(overhead?.p95).toBeCloseTo(0.15, 6);
  });
});

function repeat(pattern: readonly number[], times: number): number[] {
  return Array.from({ length: times }, () => pattern).flat();
}

describe("refresh, cadence and timers", () => {
  it("estimates the idle refresh and drops outliers", () => {
    const deltas = new Array<number>(118).fill(1_000 / 144).concat([40, 2, 0.4, 1_200]);
    const refresh = estimateRefresh(deltas)!;
    expect(refresh.rafHz).toBeCloseTo(144, 6);
    expect(refresh.periodMs).toBeCloseTo(1_000 / 144, 9);
    // 0.4 ms is a catch-up callback and 1.2 s a stall: neither is usable.
    expect(refresh.samples).toBe(120);
    expect(refresh.outliers).toBe(2);
    expect(estimateRefresh([16, 16, 16])).toBeNull();
    expect(estimateRefresh(new Float64Array(10), 0)).toBeNull();
  });

  it("finds the refresh period under a flight that misses two frames in five", () => {
    const deltas = repeat([16.6, 16.75, 33.3, 16.65, 33.4], 60);
    const refresh = estimateRefresh(deltas)!;
    expect(refresh.rafHz).toBeCloseTo(60, 0);
    expect(refresh.medianMs).toBeCloseTo(16.75, 9);
    expect(refresh.p90Ms).toBeCloseTo(33.4, 9);
  });

  it("averages a 1 ms clock's 16s and 17s back to 60 Hz", () => {
    const refresh = estimateRefresh(repeat([17, 16, 17], 40))!;
    expect(refresh.rafHz).toBeGreaterThan(59.5);
    expect(refresh.rafHz).toBeLessThan(60.5);
  });

  it("reads 50, 120, 144 and 240 Hz", () => {
    for (const hz of [50, 120, 144, 240]) {
      const jitter = [-0.05, 0.05, 0, 0.02, -0.02];
      expect(estimateRefresh(repeat(jitter.map((offset) => 1_000 / hz + offset), 30))!.rafHz).toBeCloseTo(hz, 0);
    }
  });

  it("a slow game at half the refresh agrees with the idle probe; a switched display does not", () => {
    const idle = estimateRefresh(new Array<number>(60).fill(1_000 / 60))!;
    const halfRate = rafReport(idle, flightCadence(new Array<number>(600).fill(1_000 / 30)));
    expect(halfRate.idleHz).toBeCloseTo(60, 9);
    expect(halfRate.disagrees).toBe(false);
    expect(halfRate.limited).toBe(false);
    const switched = flightCadence(new Array<number>(600).fill(1_000 / 120));
    expect(rafReport(idle, switched).disagrees).toBe(true);
    const vrr = flightCadence(new Array<number>(600).fill(1_000 / 48));
    expect(rafReport(idle, vrr).disagrees).toBe(true);
    // A rare fast cluster is not a cadence.
    const rare = flightCadence(new Array<number>(570).fill(1_000 / 60).concat(new Array<number>(30).fill(1_000 / 120)))!;
    expect(rare.medianMs).toBeCloseTo(1_000 / 60, 6);
    expect(rafReport(idle, rare).disagrees).toBe(false);
  });

  it("a 30 Hz idle probe marks the step limited by the browser or display", () => {
    const capped = estimateRefresh(new Array<number>(30).fill(1_000 / 30))!;
    expect(rafReport(capped, null)).toEqual({ idleHz: capped.rafHz, flight: null, disagrees: false, limited: true });
    expect(rafReport(null, null).limited).toBe(false);
  });

  it("measures timer granularity and widens the vsync tolerance on a coarse clock", () => {
    expect(timerReport(1)).toEqual({ granularityMs: 1, coarse: true });
    expect(timerReport(0.1).coarse).toBe(false);
    expect(timerReport(null).coarse).toBe(false);
    const period = 1_000 / 60;
    expect(vsyncBuckets([period + 1.5], period, 0.005).irregular).toBe(1);
    const coarse = vsyncBuckets([period + 1.5], period, 1);
    expect(coarse.toleranceMs).toBe(2);
    expect(coarse.x1).toBe(1);
    expect(missedRefresh([period, 30, 30, period, 30], period)).toEqual({ count: 3, per240: 144, longestStreak: 2 });
  });
});

describe("paced display streams (PR B)", () => {
  it("a flight paced to every Nth refresh keeps up in x1, display-capped at its slot, missing nothing", () => {
    for (const [hz, divisor] of [[120, 2], [144, 2], [165, 2], [240, 4], [60, 2], [120, 4]] as const) {
      const period = 1_000 / hz;
      const next = random(hz * divisor);
      const intervals = Array.from({ length: 1_200 }, () => divisor * period + (next() - 0.5) * 0.04 * period);
      const window = summarizeWindow(logOf({ intervals }), WHOLE, context(hz, 0.005, divisor));
      const label = `${hz} Hz / ${divisor}`;
      expect(window.fps, label).toBeCloseTo(hz / divisor, 0);
      expect(window.displayCapped, label).toBe(true);
      expect(window.vsyncBuckets, label).toMatchObject({ divisor, x1: 1_200, x2: 0, x3: 0, x4plus: 0, offSlot: 0, irregular: 0 });
      expect(window.missedRefresh, label).toEqual({ count: 0, per240: 0, longestStreak: 0 });
      // Read as every refresh, the same flight would miss every one.
      expect(summarizeWindow(logOf({ intervals }), WHOLE, context(hz)).missedRefresh!.count, label).toBe(1_200);
    }
  });

  it("counts a missed refresh against the paced slot: at 120 Hz paced to 60, 16.7 ms is on time and 25 ms is not", () => {
    const period = 1_000 / 120;
    expect(missedRefresh([2 * period, 3 * period, 2 * period, 3 * period, 3 * period], period, 2))
      .toEqual({ count: 3, per240: 144, longestStreak: 2 });
    expect(missedRefresh([2 * period, 2.49 * period], period, 2).count).toBe(0);
    expect(missedRefresh([2.51 * period], period, 2).count).toBe(1);
    // A divisor of 1 is the old rule: 1.5 refresh periods.
    expect(missedRefresh([1.49 * period, 1.51 * period], period).count).toBe(1);
    expect(missedRefresh([1.49 * period, 1.51 * period], period, 1)).toEqual(missedRefresh([1.49 * period, 1.51 * period], period));
  });

  it("buckets in slots, with a refresh past the slot apart from irregular frames", () => {
    // 240 Hz paced to 60: one slot is four refreshes.
    const period = 1_000 / 240;
    const buckets = vsyncBuckets(
      [4, 5, 6, 7, 8, 12, 14, 16, 2, 4.5].map((refreshes) => refreshes * period),
      period,
      0.005,
      4,
    );
    expect(buckets).toMatchObject({ divisor: 4, x1: 1, offSlot: 3, x2: 1, x3: 1, x4plus: 2, irregular: 2 });
    // The 30 fps setting on a 60 Hz panel: 33.3 ms keeps up, 50 ms missed by a refresh, 66.7 ms by a slot.
    const sixty = 1_000 / 60;
    expect(vsyncBuckets([2 * sixty, 3 * sixty, 4 * sixty], sixty, 0.005, 2))
      .toMatchObject({ x1: 1, offSlot: 1, x2: 1, irregular: 0 });
    // Every refresh drawn: no interval is off its slot.
    expect(vsyncBuckets([sixty, 2 * sixty, 3 * sixty], sixty, 0.005).offSlot).toBe(0);
  });

  it("records a cadence by its rate, a common one as its whole number", () => {
    const at = (hz: number, divisor: number) =>
      ({ frameCapHz: 60, divisor, displayPeriodMs: 1_000 / hz, periodConfirmed: true }) as const;
    expect(benchCadence(at(165, 2))).toEqual({ frameCapHz: 60, divisor: 2, displayHz: 165, confirmed: true, fallbackHz: null });
    expect(pacedHz(at(165, 2))).toBe(82.5);
    // The governor's even fallback (G6): its rate, which is also the paced one.
    expect(benchCadence({ ...at(60, 2), fallbackHz: 30 })).toEqual({
      frameCapHz: 60, divisor: 2, displayHz: 60, confirmed: true, fallbackHz: 30,
    });
    expect(pacedHz({ ...at(100, 3), fallbackHz: 100 / 3 })).toBeCloseTo(100 / 3, 9);
    expect(pacedHz(at(144, 2))).toBe(72);
    expect(pacedHz(at(60, 1))).toBe(60);
    expect(benchCadence({ ...at(60, 1), displayPeriodMs: null })!.displayHz).toBeNull();
    expect(pacedHz({ ...at(60, 1), displayPeriodMs: null })).toBeNull();
    expect(benchCadence(null)).toBeNull();
    expect(pacedHz(null)).toBeNull();
  });

  it("at 165 Hz paced to every 2nd refresh, a frame one refresh late is missed and off its slot", () => {
    const period = 1_000 / 165;
    const late = 3 * period;
    expect(late).toBeCloseTo(18.18, 2);
    expect(missedRefresh([late], period, 2).count).toBe(1);
    expect(vsyncBuckets([late], period, 0.005, 2)).toMatchObject({ x1: 0, offSlot: 1 });
  });
});

describe("per-frame cadence (fly-high.bench/4, G6)", () => {
  const period = 1_000 / 60;

  it("counts a missed refresh against each interval's own divisor, which wins over the scalar", () => {
    // At 60 Hz, two frames at 60 and two under the even fallback (divisor 2):
    // 33.3 ms misses a refresh at 60 and is on time under the fallback, 50 ms misses one under either.
    const intervals = [16.7, 33.3, 33.3, 50];
    expect(missedRefresh(intervals, period, 1, [1, 1, 2, 2])).toEqual({ count: 2, per240: 120, longestStreak: 1 });
    expect(missedRefresh(intervals, period, 1).count).toBe(3);
    expect(missedRefresh(intervals, period, 2).count).toBe(1);
    // A 0 (none logged) leaves the scalar.
    expect(missedRefresh(intervals, period, 1, [0, 0, 2, 0]).count).toBe(2);
    // 33.3 ms is two slots at 60 and one under the fallback; 50 ms missed the fallback's slot by a refresh.
    expect(vsyncBuckets(intervals, period, 0.005, 1, [1, 1, 2, 2]))
      .toMatchObject({ divisor: 1, x1: 2, x2: 1, offSlot: 1, irregular: 0 });
    expect(vsyncBuckets([2 * period, 2 * period, 3 * period], period, 0.005, 1, [1, 2, 2]))
      .toMatchObject({ divisor: 1, x2: 1, x1: 1, offSlot: 1, irregular: 0 });
  });

  it("counts a hitch against each interval's own threshold where it has one", () => {
    expect(countOver([30, 30, 70], 27.4, [27.4, 60, 60])).toMatchObject({ count: 2 });
    expect(countOver([30, 30, 70], 27.4, [Number.NaN, 60, Number.NaN])).toMatchObject({ count: 2 });
    expect(countOver([30, 30, 70], 27.4)).toMatchObject({ count: 3 });
  });

  /**
   * A log of `intervals` at 60 Hz whose frame `i` was drawn under
   * `divisors[i]`, one more than the intervals for the closing frame, with
   * the threshold that divisor has at 60 Hz.
   */
  function pacedLog(intervals: readonly number[], divisors: readonly number[]): BenchFrameLog {
    const log = createFrameLog(intervals.length + 8);
    const threshold = (divisor: number) => (divisor === 2 ? 60 : 27.4);
    let time = 1_000;
    intervals.forEach((interval, frame) => {
      recordFrame(log, time, time + 0.1, 4, 0, false, null, divisors[frame]!, threshold(divisors[frame]!));
      time += interval;
    });
    const last = divisors[intervals.length]!;
    recordFrame(log, time, time + 0.1, 4, 0, false, null, last, threshold(last));
    return log;
  }

  it("judges each interval by the cadence the frame that closes it was drawn under: a switch is on time both ways", () => {
    // 60 at 60 Hz, then the fallback at 30, then a trial back at 60. The
    // pacer skips and draws by a new cadence from the tick it emits it, so
    // the first 33.3 ms interval ends on the first frame drawn under the
    // fallback, and the first 16.7 ms one after it on the first back at 60.
    const intervals = [
      ...new Array<number>(120).fill(period),
      ...new Array<number>(60).fill(2 * period),
      ...new Array<number>(120).fill(period),
    ];
    // Frame 120 is the last drawn at 60 and stays up 33.3 ms; frame 121 is
    // the first drawn under the fallback. Frame 180 is the last under it and
    // stays up 16.7 ms; frame 181 is the first back at 60.
    const drawn = [
      ...new Array<number>(121).fill(1),
      ...new Array<number>(60).fill(2),
      ...new Array<number>(120).fill(1),
    ];
    const window = summarizeWindow(pacedLog(intervals, drawn), WHOLE, context(60));
    expect(window.frames).toBe(300);
    expect(window.missedRefresh).toEqual({ count: 0, per240: 0, longestStreak: 0 });
    expect(window.vsyncBuckets).toMatchObject({ divisor: 1, x1: 300, x2: 0, offSlot: 0, irregular: 0 });
    expect(window.over.hitch).toMatchObject({ count: 0, thresholdMs: 60 });
    expect(window.over["27.4"].count).toBe(60);
    expect(window.displayCapped).toBe(true);

    // Read by its own frame's cadence instead, each switch would cost an interval.
    const own = summarizeWindow(pacedLog(intervals, [1, ...drawn.slice(0, -1)]), WHOLE, context(60));
    expect(own.missedRefresh!.count).toBe(1);
    expect(own.vsyncBuckets).toMatchObject({ x1: 298, irregular: 1, x2: 1 });
    // And by the flight's first frame's cadence, as `/3` read it, every fallback frame would.
    const flat = summarizeWindow(logOf({ intervals }), WHOLE, context(60));
    expect(flat.missedRefresh!.count).toBe(60);
    expect(flat.over.hitch).toMatchObject({ count: 60, thresholdMs: 27.4 });
  });

  it("is display-capped by the slot of the median interval's own cadence", () => {
    // Mostly under the fallback: the median is 33.3 ms, on the fallback's slot.
    const intervals = [...new Array<number>(40).fill(period), ...new Array<number>(80).fill(2 * period)];
    const drawn = [...new Array<number>(41).fill(1), ...new Array<number>(80).fill(2)];
    const window = summarizeWindow(pacedLog(intervals, drawn), WHOLE, context(60));
    expect(window.intervalMs!.p50).toBeCloseTo(2 * period, 9);
    expect(window.displayCapped).toBe(true);
    // The same intervals by the flight-start divisor alone are not.
    expect(summarizeWindow(logOf({ intervals }), WHOLE, context(60)).displayCapped).toBe(false);
  });
});

describe("the instruments' entries", () => {
  it("long tasks and long animation frames inside the window only; unsupported says so", () => {
    const tasks = [{ startMs: 5, durationMs: 60 }, { startMs: 100, durationMs: 80 }, { startMs: 300, durationMs: 200 }];
    expect(summarizeLongTasks(tasks, 0, 200)).toEqual({ supported: true, count: 2, totalMs: 140, maxMs: 80 });
    expect(summarizeLongTasks(null, 0, 200)).toEqual({ supported: false, count: 0, totalMs: 0, maxMs: 0 });
    const frames = Array.from({ length: 8 }, (_, index) => ({
      startMs: 1_000 + index * 100,
      durationMs: 60 + index,
      blockingMs: 10,
      scripts: Array.from({ length: 6 }, (__, script) => ({ source: `s${script}`, invoker: "i", ms: 1 })),
    }));
    const summary = summarizeLongAnimationFrames(frames, 1_000, 2_000, 1_000);
    expect(summary).toMatchObject({ supported: true, count: 8, blockingMs: 80, maxMs: 67 });
    expect(summary.top).toHaveLength(5);
    expect(summary.top[0]).toMatchObject({ t: 0.7, durationMs: 67 });
    expect(summary.top[0]!.scripts).toHaveLength(4);
    expect(summarizeLongAnimationFrames(null, 0, 1, 0).supported).toBe(false);
  });

  it("a heap that never moved is stale, with no figures (critique S3)", () => {
    const flat = [0, 1_000, 2_000].map((tMs) => ({ tMs, usedBytes: 50 * 1_048_576 }));
    expect(summarizeHeap(flat, 0, 2_000)).toEqual({
      supported: true, stale: true, precise: false, startMiB: null, endMiB: null, peakMiB: null, slopeMiBPerMin: null,
    });
    expect(summarizeHeap(null, 0, 1)).toMatchObject({ supported: false, stale: false, startMiB: null });
    const growing = [0, 30_000, 60_000].map((tMs, index) => ({ tMs, usedBytes: (50 + index) * 1_048_576 }));
    const heap = summarizeHeap(growing, 0, 60_000);
    expect(heap).toMatchObject({ supported: true, stale: false, startMiB: 50, endMiB: 52, peakMiB: 52 });
    expect(heap.slopeMiBPerMin).toBeCloseTo(2, 9);
  });

  it("compile counters subtract field by field and total pipelines with modules", () => {
    const later = { render: 5, renderAsync: 1, compute: 4, computeAsync: 0, shaderModules: 7, wgslKiB: 30 };
    const earlier = { render: 2, renderAsync: 0, compute: 1, computeAsync: 0, shaderModules: 3, wgslKiB: 10 };
    expect(compileDelta(later, earlier)).toEqual({ render: 3, renderAsync: 1, compute: 3, computeAsync: 0, shaderModules: 4, wgslKiB: 20 });
    expect(compileTotal(later)).toBe(17);
    expect(compileTotal(ZERO_COMPILES)).toBe(0);
  });
});
