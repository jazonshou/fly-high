import type {
  BenchCompileCounts,
  BenchCount,
  BenchFlightCadence,
  BenchFrameLog,
  BenchHeapSample,
  BenchHeapSummary,
  BenchHistogram,
  BenchIntervalSummary,
  BenchLongAnimationFrameEntry,
  BenchLongAnimationFrameSummary,
  BenchLongTaskEntry,
  BenchLongTaskSummary,
  BenchPerSecondColumn,
  BenchPerSecondRow,
  BenchPerSecondTable,
  BenchRafReport,
  BenchRefresh,
  BenchSecondSample,
  BenchSegment,
  BenchTimerReport,
  BenchTimings,
  BenchVsyncBuckets,
  BenchWindowMetrics,
  BenchWindowSpec,
  BenchWorstFrame,
} from "./types";

/**
 * The bench's statistics: pure functions over the controller's frame log and
 * the instruments' raw entries. Nothing here reads a clock.
 *
 * **What "a frame's interval" means here.** Frame `i`'s interval is the time
 * from its rAF timestamp to the next frame's, `frameTimeMs[i + 1] -
 * frameTimeMs[i]`: how long frame `i` stayed on screen, which its own
 * `render()` (and any compile inside it) lengthens. A frame belongs to a
 * window by its own timestamp, so the controller should log the first frame
 * at or past the flight's end too, to close the last interval.
 *
 * Percentiles are nearest-rank, the rule `frameTimingPercentile` uses
 * (QualityProfile.ts), so a p95 here and the renderer's p95 agree on the
 * same samples.
 */

/** 60 s at 360 Hz with room to spare; the standard flight is 75 s. */
export const FRAME_LOG_CAPACITY = 32_768;
/** Below this many frames a second a window is too thin to read. */
export const LOW_SAMPLE_FPS = 6;
/** Timers this coarse or coarser make render-time percentiles noise (S11). */
export const COARSE_TIMER_MS = 0.5;
/** Below this the browser or display caps the frame rate (S9). */
export const LIMITED_RAF_HZ = 50;
const HISTOGRAM_BINS = 100;

export function createFrameLog(capacity = FRAME_LOG_CAPACITY): BenchFrameLog {
  return {
    capacity,
    length: 0,
    overflowed: false,
    frameTimeMs: new Float64Array(capacity),
    renderStartMs: new Float64Array(capacity),
    renderMs: new Float64Array(capacity),
    compiles: new Uint16Array(capacity),
    scaleStep: new Uint8Array(capacity),
    gpuMs: new Float32Array(capacity),
    overheadMs: new Float32Array(capacity),
  };
}

/** Appends one frame; false (and `overflowed` set) when the log is full. */
export function recordFrame(
  log: BenchFrameLog,
  frameTimeMs: number,
  renderStartMs: number,
  renderMs: number,
  compiles: number,
  scaleStep: boolean,
  gpuMs: number | null,
): boolean {
  const index = log.length;
  if (index >= log.capacity) {
    log.overflowed = true;
    return false;
  }
  log.frameTimeMs[index] = frameTimeMs;
  log.renderStartMs[index] = renderStartMs;
  log.renderMs[index] = renderMs;
  log.compiles[index] = Math.min(0xffff, Math.max(0, compiles));
  log.scaleStep[index] = scaleStep ? 1 : 0;
  log.gpuMs[index] = gpuMs ?? Number.NaN;
  log.overheadMs[index] = 0;
  log.length = index + 1;
  return true;
}

/** The recorder's own cost for the last recorded frame, measured after it was recorded. */
export function recordOverhead(log: BenchFrameLog, overheadMs: number): void {
  if (log.length > 0) log.overheadMs[log.length - 1] = overheadMs;
}

// --- primitives ----------------------------------------------------------------

/** Finite, positive values, ascending. */
export function sortedPositive(values: Iterable<number>): Float64Array {
  const kept: number[] = [];
  for (const value of values) if (Number.isFinite(value) && value > 0) kept.push(value);
  return Float64Array.from(kept).sort();
}

/** Nearest-rank percentile of an ascending array; null when empty. */
export function nearestRank(sorted: ArrayLike<number>, quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? null;
}

function mean(sorted: ArrayLike<number>): number | null {
  if (sorted.length === 0) return null;
  let sum = 0;
  for (let index = 0; index < sorted.length; index += 1) sum += sorted[index]!;
  return sum / sorted.length;
}

export function summarizeIntervals(sorted: ArrayLike<number>): BenchIntervalSummary | null {
  if (sorted.length === 0) return null;
  return {
    mean: mean(sorted)!,
    p50: nearestRank(sorted, 0.5)!,
    p90: nearestRank(sorted, 0.9)!,
    p95: nearestRank(sorted, 0.95)!,
    p99: nearestRank(sorted, 0.99)!,
    p999: nearestRank(sorted, 0.999)!,
    max: sorted[sorted.length - 1]!,
  };
}

/** The frame rate of the slowest 1% of frames (at least one): 1000 / their mean interval. */
export function onePercentLowFps(sorted: ArrayLike<number>): number | null {
  if (sorted.length === 0) return null;
  const count = Math.max(1, Math.floor(sorted.length / 100));
  let sum = 0;
  for (let index = sorted.length - count; index < sorted.length; index += 1) sum += sorted[index]!;
  return 1_000 / (sum / count);
}

/** Intervals strictly over `thresholdMs`, per frame and per minute of the intervals' own time. */
export function countOver(intervals: ArrayLike<number>, thresholdMs: number): BenchCount {
  let count = 0;
  let totalMs = 0;
  for (let index = 0; index < intervals.length; index += 1) {
    const value = intervals[index]!;
    totalMs += value;
    if (value > thresholdMs) count += 1;
  }
  return {
    count,
    per240: intervals.length > 0 ? (count * 240) / intervals.length : 0,
    perMinute: totalMs > 0 ? (count * 60_000) / totalMs : 0,
  };
}

/** 1 ms bins [0, 1) ... [99, 100), then one bin for 100 ms and over. */
export function intervalHistogram(intervals: ArrayLike<number>): BenchHistogram {
  const counts = new Array<number>(HISTOGRAM_BINS + 1).fill(0);
  for (let index = 0; index < intervals.length; index += 1) {
    const bin = Math.min(HISTOGRAM_BINS, Math.max(0, Math.floor(intervals[index]!)));
    counts[bin]! += 1;
  }
  return { binMs: 1, counts };
}

/** |a - b| / min(a, b): the repeatability measure. 10.0% passes, 10.1% voids. */
export function spread(first: number | null, last: number | null): number | null {
  if (first === null || last === null || !(first > 0) || !(last > 0)) return null;
  return Math.abs(first - last) / Math.min(first, last);
}

// --- refresh, cadence and timers ------------------------------------------------

/** Fewer usable intervals than this give no refresh estimate. */
export const MIN_REFRESH_SAMPLES = 5;

/**
 * A rAF loop's frame period, from the idle probe or the flight's own deltas.
 *
 * The median would do for an idle loop but not for a flight on a machine that
 * misses frames, where it lands between one and two refresh periods. So the
 * period is the mean of the intervals within [0.8, 1.25] of the 10th
 * percentile: the fastest cadence the loop sustains, with dropped frames and
 * stalls left out. The mean, not the median, because a 1 ms timer (Firefox,
 * Safari) splits a 16.67 ms period into 16s and 17s. Below 1.5 ms is no
 * display's period (a catch-up callback), and 1 s or more is a stall. Null
 * with fewer than five usable intervals.
 */
export function estimateRefresh(deltas: ArrayLike<number>, count: number = deltas.length): BenchRefresh | null {
  const usable: number[] = [];
  for (let index = 0; index < Math.min(count, deltas.length); index += 1) {
    const value = deltas[index]!;
    if (Number.isFinite(value) && value >= 1.5 && value < 1_000) usable.push(value);
  }
  if (usable.length < MIN_REFRESH_SAMPLES) return null;
  const sorted = Float64Array.from(usable).sort();
  const p10Ms = nearestRank(sorted, 0.1)!;
  let sum = 0;
  let kept = 0;
  for (const value of sorted) {
    if (value < p10Ms * 0.8 || value > p10Ms * 1.25) continue;
    sum += value;
    kept += 1;
  }
  const periodMs = sum / kept;
  return {
    rafHz: 1_000 / periodMs,
    periodMs,
    medianMs: nearestRank(sorted, 0.5)!,
    p10Ms,
    p90Ms: nearestRank(sorted, 0.9)!,
    samples: sorted.length,
    outliers: sorted.length - kept,
  };
}

/**
 * The fastest common cadence among a flight's intervals: the cluster within
 * 15% of the 10th percentile, and its median. On a vsync-paced display that
 * is the refresh period or a whole multiple of it; on a VRR panel, or after a
 * dynamic refresh-rate switch, it need not be (critique S8).
 */
export function flightCadence(intervals: ArrayLike<number>): BenchFlightCadence | null {
  const sorted = sortedPositive(Array.from(intervals));
  if (sorted.length < 5) return null;
  const anchor = nearestRank(sorted, 0.1)!;
  const cluster = sorted.filter((value) => value >= anchor * 0.85 && value <= anchor * 1.15);
  const medianMs = nearestRank(cluster, 0.5)!;
  return { hz: 1_000 / medianMs, medianMs, share: cluster.length / sorted.length };
}

/**
 * The step's frame-rate context. The flight's cadence disagrees with the
 * idle probe when, being a common cadence (a quarter of the frames or more),
 * it is not a whole multiple of the idle period within 5%. A slow game at
 * half the refresh rate agrees; a display that switched rate does not.
 */
export function rafReport(idle: BenchRefresh | null, flight: BenchFlightCadence | null): BenchRafReport {
  const idleHz = idle?.rafHz ?? null;
  let disagrees = false;
  if (idle !== null && flight !== null && flight.share >= 0.25) {
    const ratio = flight.medianMs / idle.periodMs;
    const multiple = Math.max(1, Math.round(ratio));
    disagrees = Math.abs(ratio - multiple) / multiple > 0.05;
  }
  return { idleHz, flight, disagrees, limited: idleHz !== null && idleHz < LIMITED_RAF_HZ };
}

export function timerReport(granularityMs: number | null): BenchTimerReport {
  return { granularityMs, coarse: granularityMs !== null && granularityMs >= COARSE_TIMER_MS };
}

/** The vsync tolerance: 3% of the period, widened to twice a coarse timer's step (S11). */
export function vsyncToleranceMs(periodMs: number, granularityMs: number | null): number {
  return Math.max(0.03 * periodMs, 2 * (granularityMs ?? 0));
}

/**
 * Each interval as a whole number of refresh periods, within the tolerance,
 * or irregular. Four or more is one bucket. A VRR panel reads mostly
 * irregular, which is itself the finding.
 */
export function vsyncBuckets(
  intervals: ArrayLike<number>,
  periodMs: number,
  granularityMs: number | null,
): BenchVsyncBuckets {
  const toleranceMs = vsyncToleranceMs(periodMs, granularityMs);
  let x1 = 0;
  let x2 = 0;
  let x3 = 0;
  let x4plus = 0;
  let irregular = 0;
  for (let index = 0; index < intervals.length; index += 1) {
    const value = intervals[index]!;
    if (value >= 3.5 * periodMs) {
      x4plus += 1;
      continue;
    }
    const multiple = Math.round(value / periodMs);
    if (multiple < 1 || Math.abs(value - multiple * periodMs) > toleranceMs) irregular += 1;
    else if (multiple === 1) x1 += 1;
    else if (multiple === 2) x2 += 1;
    else x3 += 1;
  }
  return { x1, x2, x3, x4plus, irregular, toleranceMs };
}

/** Intervals over 1.5 refresh periods: at least one refresh showed the same frame twice. */
export function missedRefresh(
  intervals: ArrayLike<number>,
  periodMs: number,
): { readonly count: number; readonly per240: number; readonly longestStreak: number } {
  let count = 0;
  let streak = 0;
  let longestStreak = 0;
  for (let index = 0; index < intervals.length; index += 1) {
    if (intervals[index]! > 1.5 * periodMs) {
      count += 1;
      streak += 1;
      longestStreak = Math.max(longestStreak, streak);
    } else {
      streak = 0;
    }
  }
  return { count, per240: intervals.length > 0 ? (count * 240) / intervals.length : 0, longestStreak };
}

// --- windows over the frame log --------------------------------------------------

/** What the window summaries need besides the log. */
export interface FrameWindowContext {
  /** The rAF timestamp of the flight's first frame: t = 0. */
  readonly flightStartMs: number;
  /** The step's refresh period from its idle probe; null when it did not run. */
  readonly refreshMs: number | null;
  readonly granularityMs: number | null;
  /** `hitchThresholdMilliseconds` of the step's tier: 27.4 ms, or 60 ms on Ultra. */
  readonly tierThresholdMs: number;
}

/** Frames whose timestamp is in [startS, endS) of flight time and whose interval is closed. */
export function windowFrames(
  log: BenchFrameLog,
  context: Pick<FrameWindowContext, "flightStartMs">,
  startS: number,
  endS: number,
): number[] {
  const from = context.flightStartMs + startS * 1_000;
  const to = context.flightStartMs + endS * 1_000;
  const frames: number[] = [];
  for (let index = 0; index + 1 < log.length; index += 1) {
    const time = log.frameTimeMs[index]!;
    if (time >= from && time < to) frames.push(index);
  }
  return frames;
}

function intervalOf(log: BenchFrameLog, index: number): number {
  return log.frameTimeMs[index + 1]! - log.frameTimeMs[index]!;
}

function intervalsOf(log: BenchFrameLog, frames: readonly number[]): Float64Array {
  const intervals = new Float64Array(frames.length);
  frames.forEach((frame, slot) => {
    intervals[slot] = intervalOf(log, frame);
  });
  return intervals;
}

function splitSummary(intervals: readonly number[]): BenchWindowMetrics["compileSplit"]["withCompiles"] {
  const sorted = sortedPositive(intervals);
  return {
    frames: intervals.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
  };
}

/** Every frame metric of one window: the air (headline) and ground windows alike. */
export function summarizeWindow(
  log: BenchFrameLog,
  spec: BenchWindowSpec,
  context: FrameWindowContext,
): BenchWindowMetrics {
  const frames = windowFrames(log, context, spec.startS, spec.endS);
  const intervals = intervalsOf(log, frames);
  const sorted = sortedPositive(intervals);
  const summary = summarizeIntervals(sorted);
  let totalMs = 0;
  for (const value of intervals) totalMs += value;
  const seconds = totalMs / 1_000;
  const windowSeconds = spec.endS - spec.startS;

  const renders = sortedPositive(frames.map((frame) => log.renderMs[frame]!));
  const renderStarts = sortedPositive(
    frames.map((frame) => log.renderStartMs[frame + 1]! - log.renderStartMs[frame]!),
  );
  const gpu = sortedPositive(frames.map((frame) => log.gpuMs[frame]!));
  const withCompiles: number[] = [];
  const withoutCompiles: number[] = [];
  let scaleStepFrames = 0;
  frames.forEach((frame, slot) => {
    (log.compiles[frame]! > 0 ? withCompiles : withoutCompiles).push(intervals[slot]!);
    scaleStepFrames += log.scaleStep[frame]!;
  });
  const period = context.refreshMs;
  const tolerance = period === null ? null : vsyncToleranceMs(period, context.granularityMs);

  return {
    name: spec.name,
    startS: spec.startS,
    endS: spec.endS,
    frames: frames.length,
    seconds,
    lowSample: frames.length < LOW_SAMPLE_FPS * windowSeconds,
    fps: summary === null ? null : 1_000 / summary.mean,
    displayCapped: summary !== null && period !== null && tolerance !== null
      && Math.abs(summary.p50 - period) <= tolerance,
    intervalMs: summary,
    onePercentLowFps: onePercentLowFps(sorted),
    over: {
      "27.4": countOver(intervals, 27.4),
      "50": countOver(intervals, 50),
      "100": countOver(intervals, 100),
      hitch: { ...countOver(intervals, context.tierThresholdMs), thresholdMs: context.tierThresholdMs },
    },
    missedRefresh: period === null ? null : missedRefresh(intervals, period),
    vsyncBuckets: period === null ? null : vsyncBuckets(intervals, period, context.granularityMs),
    renderMs: renders.length === 0 ? null : {
      mean: mean(renders)!,
      p50: nearestRank(renders, 0.5)!,
      p95: nearestRank(renders, 0.95)!,
      p99: nearestRank(renders, 0.99)!,
      max: renders[renders.length - 1]!,
      coarse: (context.granularityMs ?? 0) >= COARSE_TIMER_MS,
    },
    renderStartIntervalMs: renderStarts.length === 0 ? null : {
      p95: nearestRank(renderStarts, 0.95)!,
      p99: nearestRank(renderStarts, 0.99)!,
      max: renderStarts[renderStarts.length - 1]!,
    },
    gpuMs: gpu.length === 0 ? null : {
      samples: gpu.length,
      p50: nearestRank(gpu, 0.5)!,
      p95: nearestRank(gpu, 0.95)!,
      p99: nearestRank(gpu, 0.99)!,
      max: gpu[gpu.length - 1]!,
    },
    compileSplit: { withCompiles: splitSummary(withCompiles), withoutCompiles: splitSummary(withoutCompiles) },
    framesWithCompiles: withCompiles.length,
    scaleStepFrames,
  };
}

export function windowHistogram(
  log: BenchFrameLog,
  spec: BenchWindowSpec,
  context: Pick<FrameWindowContext, "flightStartMs">,
): BenchHistogram {
  return intervalHistogram(intervalsOf(log, windowFrames(log, context, spec.startS, spec.endS)));
}

/** The flight in `segmentS` slices, from t = 0 to `flightS`. */
export function flightSegments(
  log: BenchFrameLog,
  context: Pick<FrameWindowContext, "flightStartMs">,
  flightS: number,
  segmentS = 10,
): BenchSegment[] {
  const segments: BenchSegment[] = [];
  for (let startS = 0; startS < flightS; startS += segmentS) {
    const endS = Math.min(flightS, startS + segmentS);
    const frames = windowFrames(log, context, startS, endS);
    const sorted = sortedPositive(intervalsOf(log, frames));
    let compiles = 0;
    for (const frame of frames) compiles += log.compiles[frame]!;
    const average = mean(sorted);
    segments.push({
      startS,
      endS,
      frames: frames.length,
      fps: average === null ? null : 1_000 / average,
      p95: nearestRank(sorted, 0.95),
      p99: nearestRank(sorted, 0.99),
      over27: countOver(sorted, 27.4).count,
      compiles,
    });
  }
  return segments;
}

/** Long-task time overlapping [fromMs, toMs). */
function longTaskOverlapMs(entries: readonly BenchLongTaskEntry[], fromMs: number, toMs: number): number {
  let total = 0;
  for (const entry of entries) {
    const start = Math.max(fromMs, entry.startMs);
    const end = Math.min(toMs, entry.startMs + entry.durationMs);
    if (end > start) total += end - start;
  }
  return total;
}

/** The window's longest intervals, longest first, with what their frame did. */
export function worstFrames(
  log: BenchFrameLog,
  spec: BenchWindowSpec,
  context: Pick<FrameWindowContext, "flightStartMs">,
  longTasks: readonly BenchLongTaskEntry[] | null,
  count = 10,
): BenchWorstFrame[] {
  return windowFrames(log, context, spec.startS, spec.endS)
    .map((frame) => ({ frame, interval: intervalOf(log, frame) }))
    .sort((a, b) => b.interval - a.interval || a.frame - b.frame)
    .slice(0, count)
    .map(({ frame, interval }) => {
      const time = log.frameTimeMs[frame]!;
      return {
        t: (time - context.flightStartMs) / 1_000,
        intervalMs: interval,
        renderMs: log.renderMs[frame]!,
        compiles: log.compiles[frame]!,
        scaleStep: log.scaleStep[frame] === 1,
        longTaskMs: longTasks === null ? null : longTaskOverlapMs(longTasks, time, time + interval),
      };
    });
}

/**
 * One row per second of flight: the log's frames in that second, merged with
 * the controller's once-a-second snapshot (`samples[second]`, null if none).
 */
export function perSecondRows(
  log: BenchFrameLog,
  context: Pick<FrameWindowContext, "flightStartMs">,
  seconds: number,
  samples: readonly (BenchSecondSample | null | undefined)[],
): BenchPerSecondRow[] {
  const rows: BenchPerSecondRow[] = [];
  for (let second = 0; second < seconds; second += 1) {
    const frames = windowFrames(log, context, second, second + 1);
    const intervals = intervalsOf(log, frames);
    let maxInterval: number | null = null;
    let compiles = 0;
    for (const value of intervals) maxInterval = maxInterval === null ? value : Math.max(maxInterval, value);
    for (const frame of frames) compiles += log.compiles[frame]!;
    const sample = samples[second] ?? null;
    rows.push({
      second,
      frames: frames.length,
      maxIntervalMs: maxInterval,
      over27: countOver(intervals, 27.4).count,
      renderP95Ms: nearestRank(sortedPositive(frames.map((frame) => log.renderMs[frame]!)), 0.95),
      compiles,
      appliedScale: sample?.appliedScale ?? null,
      renderPixels: sample?.renderPixels ?? null,
      cpuLevel: sample?.cpuLevel ?? null,
      gpuLevel: sample?.gpuLevel ?? null,
      heapMiB: sample?.heapBytes === null || sample?.heapBytes === undefined ? null : sample.heapBytes / 1_048_576,
    });
  }
  return rows;
}

const PER_SECOND_COLUMNS: readonly BenchPerSecondColumn[] = Object.freeze([
  "second",
  "frames",
  "maxIntervalMs",
  "over27",
  "renderP95Ms",
  "compiles",
  "appliedScale",
  "renderPixels",
  "cpuLevel",
  "gpuLevel",
  "heapMiB",
]);

/** The rows as the report stores them: one tuple per second, in `columns` order. */
export function perSecondTable(rows: readonly BenchPerSecondRow[]): BenchPerSecondTable {
  return {
    columns: PER_SECOND_COLUMNS,
    rows: rows.map((row) => PER_SECOND_COLUMNS.map((column) => row[column])),
  };
}

/**
 * The early stop: at `earlyStopAtS` of flight, a step running under
 * `earlyStopMinFps` since `earlyStopFromS` stops, because the rest of the
 * flight would take minutes and say nothing new. No closed interval at all
 * counts as zero.
 */
export function earlyStopCheck(
  log: BenchFrameLog,
  context: Pick<FrameWindowContext, "flightStartMs">,
  timings: Pick<BenchTimings, "earlyStopFromS" | "earlyStopAtS" | "earlyStopMinFps">,
): { readonly stop: boolean; readonly fps: number | null } {
  const sorted = sortedPositive(
    intervalsOf(log, windowFrames(log, context, timings.earlyStopFromS, timings.earlyStopAtS)),
  );
  const average = mean(sorted);
  const fps = average === null ? null : 1_000 / average;
  return { stop: fps === null || fps < timings.earlyStopMinFps, fps };
}

/** The recorder's own cost per frame over [startS, endS) of flight. */
export function overheadSummary(
  log: BenchFrameLog,
  context: Pick<FrameWindowContext, "flightStartMs">,
  startS: number,
  endS: number,
): { readonly p50: number; readonly p95: number } | null {
  const values: number[] = [];
  const from = context.flightStartMs + startS * 1_000;
  const to = context.flightStartMs + endS * 1_000;
  for (let index = 0; index < log.length; index += 1) {
    const time = log.frameTimeMs[index]!;
    if (time >= from && time < to) values.push(log.overheadMs[index]!);
  }
  const sorted = Float64Array.from(values.filter((value) => Number.isFinite(value) && value >= 0)).sort();
  if (sorted.length === 0) return null;
  return { p50: nearestRank(sorted, 0.5)!, p95: nearestRank(sorted, 0.95)! };
}

// --- the instruments' entries ---------------------------------------------------------

export function summarizeLongTasks(
  entries: readonly BenchLongTaskEntry[] | null,
  fromMs: number,
  toMs: number,
): BenchLongTaskSummary {
  if (entries === null) return { supported: false, count: 0, totalMs: 0, maxMs: 0 };
  let count = 0;
  let totalMs = 0;
  let maxMs = 0;
  for (const entry of entries) {
    if (entry.startMs < fromMs || entry.startMs >= toMs) continue;
    count += 1;
    totalMs += entry.durationMs;
    maxMs = Math.max(maxMs, entry.durationMs);
  }
  return { supported: true, count, totalMs, maxMs };
}

export function summarizeLongAnimationFrames(
  entries: readonly BenchLongAnimationFrameEntry[] | null,
  fromMs: number,
  toMs: number,
  flightStartMs: number,
  top = 5,
): BenchLongAnimationFrameSummary {
  if (entries === null) return { supported: false, count: 0, blockingMs: 0, maxMs: 0, top: [] };
  const inside = entries.filter((entry) => entry.startMs >= fromMs && entry.startMs < toMs);
  let blockingMs = 0;
  let maxMs = 0;
  for (const entry of inside) {
    blockingMs += entry.blockingMs;
    maxMs = Math.max(maxMs, entry.durationMs);
  }
  return {
    supported: true,
    count: inside.length,
    blockingMs,
    maxMs,
    top: [...inside]
      .sort((a, b) => b.durationMs - a.durationMs || a.startMs - b.startMs)
      .slice(0, top)
      .map((entry) => ({
        t: (entry.startMs - flightStartMs) / 1_000,
        durationMs: entry.durationMs,
        blockingMs: entry.blockingMs,
        scripts: entry.scripts.slice(0, 4),
      })),
  };
}

const MIB = 1_048_576;

/**
 * The JS heap over [fromMs, toMs]: first, last, peak and a least-squares
 * slope. A value that never moved is reported as stale with no figures,
 * because outside a flagged Chromium the heap reading is bucketed and
 * refreshed on a long timer (critique S3). Null `samples` means unsupported.
 */
export function summarizeHeap(
  samples: readonly BenchHeapSample[] | null,
  fromMs: number,
  toMs: number,
): BenchHeapSummary {
  const empty = { precise: false as const, startMiB: null, endMiB: null, peakMiB: null, slopeMiBPerMin: null };
  if (samples === null) return { supported: false, stale: false, ...empty };
  const inside = samples.filter(
    (sample) => sample.tMs >= fromMs && sample.tMs <= toMs && Number.isFinite(sample.usedBytes),
  );
  const first = inside[0];
  const last = inside[inside.length - 1];
  if (!first || !last || inside.every((sample) => sample.usedBytes === first.usedBytes)) {
    return { supported: true, stale: true, ...empty };
  }
  let peak = first.usedBytes;
  let sumT = 0;
  let sumY = 0;
  for (const sample of inside) {
    peak = Math.max(peak, sample.usedBytes);
    sumT += sample.tMs;
    sumY += sample.usedBytes;
  }
  const meanT = sumT / inside.length;
  const meanY = sumY / inside.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of inside) {
    covariance += (sample.tMs - meanT) * (sample.usedBytes - meanY);
    variance += (sample.tMs - meanT) ** 2;
  }
  return {
    supported: true,
    stale: false,
    precise: false,
    startMiB: first.usedBytes / MIB,
    endMiB: last.usedBytes / MIB,
    peakMiB: peak / MIB,
    slopeMiBPerMin: variance > 0 ? ((covariance / variance) * 60_000) / MIB : null,
  };
}

// --- compile counts --------------------------------------------------------------------

export const ZERO_COMPILES: BenchCompileCounts = Object.freeze({
  render: 0,
  renderAsync: 0,
  compute: 0,
  computeAsync: 0,
  shaderModules: 0,
  wgslKiB: 0,
});

/** `later - earlier`, for counters that only grow. */
export function compileDelta(later: BenchCompileCounts, earlier: BenchCompileCounts): BenchCompileCounts {
  return {
    render: later.render - earlier.render,
    renderAsync: later.renderAsync - earlier.renderAsync,
    compute: later.compute - earlier.compute,
    computeAsync: later.computeAsync - earlier.computeAsync,
    shaderModules: later.shaderModules - earlier.shaderModules,
    wgslKiB: later.wgslKiB - earlier.wgslKiB,
  };
}

/** Pipelines and shader modules: what the frame log's `compiles` column counts. */
export function compileTotal(counts: BenchCompileCounts): number {
  return counts.render + counts.renderAsync + counts.compute + counts.computeAsync + counts.shaderModules;
}
