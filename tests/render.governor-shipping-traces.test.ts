import { describe, expect, it } from "vitest";
import {
  CPU_WORK_MAX_LEVEL,
  GPU_WORK_MAX_LEVEL,
  createGovernorState,
  governorConfigForProfile,
  gpuWorkLeverName,
  nextGovernorDecision,
  observeRenderScaleApplication,
  rebaseGovernorState,
  resolveSignals,
  stepWasEffective,
  summariseIntervals,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import type { FrameRateCap, PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import {
  frameTimingPercentile95,
  resolveWebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";

/**
 * The governor as it runs for players (PR B, step 2.1). Shipping gameplay has
 * no GPU timestamps, so `gpuP95Ms` is always null, and vsync quantises every
 * presented interval to a whole number of refreshes: 16.67 ms on time, 33.3
 * ms one refresh late. Every older governor test feeds timestamp signals that
 * shipping never has, and none of them showed what R5's Node traces did: a
 * healthy 60 Hz frame never got its shed work back.
 *
 * Medium (tier 1, render scale 0.86) throughout, as R5 traced it. A window is
 * written the way FlightRenderer summarises 120 frames, so its p95, mean and
 * late share agree: with 6 or fewer late frames the nearest-rank p95 is still
 * the on-time interval.
 *
 * G-1 put today's defects in as `it.fails`; G1 (G-2) turned each into `it`.
 */

const medium = resolveWebGpuQualityProfile("medium", "balanced");
const config = governorConfigForProfile(medium);
const VSYNC_60 = 1_000 / 60;
const VSYNC_120 = 1_000 / 120;
const VSYNC_144 = 1_000 / 144;

function cadence(
  frameCapHz: FrameRateCap,
  divisor: number,
  hz: number | null,
  periodConfirmed: boolean,
): PresentationCadence {
  return { frameCapHz, divisor, displayPeriodMs: hz === null ? null : 1_000 / hz, periodConfirmed };
}

/** One window of 120 frames: `late` of them took `slowMs`, the rest `onTimeMs`. */
function frames(
  cpuP95Ms: number,
  late = 0,
  slowMs = 2 * VSYNC_60,
  onTimeMs = VSYNC_60,
): GovernorSignals {
  const slowFrames = Math.round(late * 120);
  return {
    gpuP95Ms: null,
    cpuP95Ms: cpuP95Ms,
    intervalP95Ms: slowFrames > 6 ? slowMs : onTimeMs,
    intervalMeanMs: onTimeMs + (slowFrames / 120) * (slowMs - onTimeMs),
    lateFraction: slowFrames / 120,
  };
}

/** A window summarised exactly as FlightRenderer does, against `governorConfig`'s late threshold. */
function windowOf(intervals: readonly number[], cpuP95Ms: number, governorConfig: GovernorConfig): GovernorSignals {
  const { mean, late } = summariseIntervals(intervals, governorConfig.lateIntervalMs);
  return {
    gpuP95Ms: null,
    cpuP95Ms,
    intervalP95Ms: frameTimingPercentile95(intervals),
    intervalMeanMs: mean,
    lateFraction: late,
  };
}

/** 120 intervals of `onTimeMs`, the first `late` of them `slowMs` instead. */
function intervals(onTimeMs: number, late = 0, slowMs = 2 * onTimeMs): number[] {
  return Array.from({ length: 120 }, (_, frame) => (frame < late ? slowMs : onTimeMs));
}

interface TraceOptions {
  readonly config?: GovernorConfig;
  /**
   * The cap or the 0.4 Mpx minimum absorbs every downward step: before PR B
   * part 2 (G4) the cap did at 1440p and on Retina (R5 §2.3); since, the
   * minimum does on a small Low viewport.
   */
  readonly capBinds?: boolean;
}

/** The state after each window; `states[w - 1]` is the state after window w. */
function trace(
  start: GovernorState,
  windows: number,
  signals: (window: number, state: GovernorState) => GovernorSignals,
  options: TraceOptions = {},
): GovernorState[] {
  const governorConfig = options.config ?? config;
  const states: GovernorState[] = [];
  let state = start;
  for (let window = 1; window <= windows; window += 1) {
    const previous = state;
    state = nextGovernorDecision(state, signals(window, state), governorConfig);
    if (options.capBinds && state.renderScale < previous.renderScale - 1e-9) {
      state = observeRenderScaleApplication(state, false, governorConfig);
    }
    states.push(state);
  }
  return states;
}

/** The first window (from 1) whose state matches, or -1. */
function firstWindow(states: readonly GovernorState[], match: (state: GovernorState) => boolean): number {
  const index = states.findIndex(match);
  return index < 0 ? -1 : index + 1;
}

/** Every window (from 1) whose state matches its predecessor's that way. */
function windowsWhere(
  start: GovernorState,
  states: readonly GovernorState[],
  match: (state: GovernorState, previous: GovernorState) => boolean,
): number[] {
  const found: number[] = [];
  states.forEach((state, index) => {
    if (match(state, index === 0 ? start : states[index - 1]!)) found.push(index + 1);
  });
  return found;
}

function withLevels(cpuWorkLevel: number, gpuWorkLevel: number, extra: Partial<GovernorState> = {}): GovernorState {
  return Object.freeze({ ...createGovernorState(config), cpuWorkLevel, gpuWorkLevel, ...extra });
}

/**
 * PR B part 2 (K1): the ladders' lengths, so a reorder or a new rung moves
 * these traces with it. On cadence every rung comes back after four calm
 * windows, a streaming rung's four-window trial included; off cadence a
 * ladder sheds a rung every second hot window.
 */
const CPU_RECOVERY_WINDOWS = 4 * CPU_WORK_MAX_LEVEL;
const GPU_RECOVERY_WINDOWS = 4 * GPU_WORK_MAX_LEVEL;
/** Resolution comes back the same way, after the GPU rungs: 0.025 a step from the floor to the ceiling. */
const SCALE_RECOVERY_WINDOWS = 4 * Math.ceil((config.scaleCeiling - config.scaleFloor) / 0.025 - 1e-9);
const CPU_SHED_WINDOWS = 2 * CPU_WORK_MAX_LEVEL;
/**
 * PR B part 2 (G6): every frame a refresh late is a mean of 33.3 ms, twice
 * the target, so the window is urgent: once the miss has lasted two windows,
 * each sheds a rung by itself.
 */
const CPU_URGENT_SHED_WINDOWS = 2 + (CPU_WORK_MAX_LEVEL - 1);

/** The ladder level whose rung moved `lever` first. */
function levelOf(maxLevel: number, leverName: (level: number) => string | null, lever: string): number {
  for (let level = 1; level <= maxLevel; level += 1) {
    if (leverName(level) === lever) return level;
  }
  throw new Error(`no rung moves ${lever}`);
}

describe("the shipping governor on a healthy cadence", () => {
  it("S1 (R5 trace A): a healthy 60 Hz frame with a 5 ms CPU moves nothing", () => {
    const states = trace(createGovernorState(config), 3, () => frames(5));
    for (const state of states) {
      expect(state.mode).toBe("on-cadence");
      expect(state.renderScale).toBe(config.scaleCeiling);
      expect(state.pendingProbe).toBeNull();
      expect(state.cpuWorkLevel).toBe(0);
      expect(state.gpuWorkLevel).toBe(0);
    }
  });

  it("S2 (R5 trace3): a CPU ladder shed to the top comes back, one rung per four windows", () => {
    for (const cpu of [3, 5, 7, 8.5]) {
      const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => frames(cpu));
      expect(firstWindow(states, (state) => state.cpuWorkLevel === 0), `render() p95 ${cpu} ms`).toBe(CPU_RECOVERY_WINDOWS);
    }
  });

  it("S3: the CPU ladder recovers with render() p95 up to 0.9 of the 16.67 ms target", () => {
    // The red team's dead band: a gate at 0.8 x 13.7 = 10.96 ms left every
    // machine between 11 and 16.7 ms with its CPU rungs shed for good.
    for (const cpu of [10.9, 11.4, 12.5, 14.5]) {
      const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => frames(cpu));
      expect(firstWindow(states, (state) => state.cpuWorkLevel === 0), `render() p95 ${cpu} ms`).toBe(CPU_RECOVERY_WINDOWS);
    }
  });

  it("S3: a render() p95 above 15 ms keeps its CPU rungs", () => {
    const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => frames(15.5));
    expect(states.every((state) => state.cpuWorkLevel === CPU_WORK_MAX_LEVEL)).toBe(true);
  });

  it("S3c: at 144 Hz paced to 72, CPU work comes back only within 0.9 of the 13.89 ms slot", () => {
    // A frame there makes two refreshes or is late, so the 60 fps gate of
    // 15 ms never bound and only the trial guarded CPU recovery.
    const paced = governorConfigForProfile(medium, cadence(60, 2, 144, true));
    expect(paced.cpuRecoveryCeilingMs).toBeCloseTo(0.9 * 2 * VSYNC_144, 9);
    const at72 = (cpu: number) => windowOf(intervals(2 * VSYNC_144), cpu, paced);
    const kept = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => at72(13), { config: paced });
    expect(kept.every((state) => state.cpuWorkLevel === CPU_WORK_MAX_LEVEL)).toBe(true);
    const back = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => at72(12), { config: paced });
    expect(firstWindow(back, (state) => state.cpuWorkLevel === 0)).toBe(CPU_RECOVERY_WINDOWS);
    // Where a frame of more refreshes is still on time, the target's gate stands:
    // three refreshes at 165 Hz are 18.2 ms, and two at 120 Hz 16.67.
    expect(governorConfigForProfile(medium, cadence(60, 2, 165, true)).cpuRecoveryCeilingMs).toBeCloseTo(15, 9);
    expect(governorConfigForProfile(medium, cadence(60, 2, 120, true)).cpuRecoveryCeilingMs).toBeCloseTo(15, 9);
  });

  it("S4: a 120 Hz display paced to 60 recovers exactly like S2", () => {
    const paced = governorConfigForProfile(medium, cadence(60, 2, 120, true));
    expect(paced.presentationTargetMs).toBe(config.presentationTargetMs);
    expect(paced.gpuTargetMs).toBe(config.gpuTargetMs);
    // Half a refresh past the second: a single missed slot (25 ms) is late.
    expect(paced.lateIntervalMs).toBeCloseTo(2.5 * VSYNC_120, 9);
    expect(summariseIntervals([25], paced.lateIntervalMs).late).toBe(1);
    const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => frames(5), { config: paced });
    expect(firstWindow(states, (state) => state.cpuWorkLevel === 0)).toBe(CPU_RECOVERY_WINDOWS);
  });

  it("S5: Match display at 120 Hz (8.33 ms intervals) recovers the CPU ladder", () => {
    const states = trace(
      withLevels(CPU_WORK_MAX_LEVEL, 0),
      CPU_RECOVERY_WINDOWS + 12,
      () => frames(5, 0, 2 * VSYNC_120, VSYNC_120),
    );
    expect(firstWindow(states, (state) => state.cpuWorkLevel === 0)).toBe(CPU_RECOVERY_WINDOWS);
  });

  it("S6 (R5 trace4): a fast CPU on a healthy, latched 60 Hz frame sheds no GPU work", () => {
    // render() p95 2.5 ms made the old proxy 14.17 ms, over the 13.7 ms target.
    const latched = withLevels(0, 0, { resolutionInsensitive: true, insensitiveWindowsRemaining: 15 });
    const states = trace(latched, 14, () => frames(2.5));
    expect(states.every((state) => state.gpuWorkLevel === 0)).toBe(true);
    // The latch keeps counting down to its re-arm.
    expect(states[13]!.resolutionInsensitive).toBe(true);
    expect(states[13]!.insensitiveWindowsRemaining).toBe(1);
  });

  it("S9: exactly 5% late frames (6 of 120) moves nothing", () => {
    const states = trace(createGovernorState(config), 20, () => frames(9, 0.05));
    for (const state of states) {
      expect(state.mode).toBe("on-cadence");
      expect(state.renderScale).toBe(config.scaleCeiling);
      expect(state.cpuWorkLevel).toBe(0);
      expect(state.gpuWorkLevel).toBe(0);
    }
  });
});

describe("the shipping governor off cadence", () => {
  it("S7 (R5 trace2, P9): a CPU-bound host sheds CPU work and keeps its resolution", () => {
    // render() p95 alternating 14 and 16 ms, 48 of 120 frames a refresh
    // late: the p95 is 33.3 ms, as vsync makes it. Before G1 the pacing
    // label pre-empted the split, the resolution probe read 23 -> 7 ms as a
    // 70% gain, and the scale walked to its floor while the CPU ladder never
    // moved. G1 split on the proxy alone, which at 33.3 ms read 14 ms as
    // GPU-bound and 16 ms as pacing-bound: the scale pumped, latched, and
    // every GPU rung went while the CPU ladder stayed at 0.
    const states = trace(createGovernorState(config), CPU_SHED_WINDOWS, (window) => frames(window % 2 === 1 ? 14 : 16, 0.4));
    expect(states[0]!.mode).toBe("cpu-work");
    expect(firstWindow(states, (state) => state.cpuWorkLevel > 0)).toBe(2);
    expect(states[CPU_SHED_WINDOWS - 1]!.cpuWorkLevel).toBe(CPU_WORK_MAX_LEVEL);
    expect(states.every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
    expect(states.every((state) => state.gpuWorkLevel === 0)).toBe(true);
    expect(states.some((state) => state.resolutionInsensitive)).toBe(false);
  });

  it("S7b: a 60 Hz host whose render() alone misses the cadence never sheds resolution or GPU work", () => {
    // Every frame a refresh late: p95 and mean 33.3 ms. Split on the proxy
    // alone, 15.5-17.8 ms read as pacing-bound and 14 ms as GPU-bound.
    for (const cpu of [15.5, 16, 17, 17.8, 20]) {
      const states = trace(createGovernorState(config), 40, () => frames(cpu, 1));
      const label = `render() p95 ${cpu} ms`;
      expect(firstWindow(states, (state) => state.cpuWorkLevel === CPU_WORK_MAX_LEVEL), label).toBe(CPU_URGENT_SHED_WINDOWS);
      expect(states.every((state) => state.urgent), label).toBe(true);
      expect(states.every((state) => state.gpuWorkLevel === 0), label).toBe(true);
      expect(states.every((state) => state.renderScale === config.scaleCeiling), label).toBe(true);
      expect(states[39]!.mode, label).toBe("cpu-work");
    }
  });

  it("S7b: render() over the GPU target sheds the CPU ladder before resolution or GPU work", () => {
    // 14 ms with 3 ms of other main-thread work misses 16.67 ms; the CPU
    // rungs are what can bring it back. With the ladder spent and render()
    // under 15 ms, a resolution step is tried, and undone when it buys
    // nothing; no GPU rung follows.
    const states = trace(createGovernorState(config), 40, () => frames(14, 1));
    const spent = CPU_URGENT_SHED_WINDOWS;
    expect(firstWindow(states, (state) => state.cpuWorkLevel === CPU_WORK_MAX_LEVEL)).toBe(spent);
    expect(states.slice(0, spent).every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
    expect(states[spent]!.renderScale).toBeLessThan(config.scaleCeiling);
    expect(firstWindow(states, (state) => state.resolutionInsensitive)).toBe(spent + 3);
    // Latched while it lasts: the scale is not probed again when the latch would re-arm.
    expect(states.slice(spent + 2).every((state) => state.resolutionInsensitive)).toBe(true);
    expect(states.slice(spent + 2).every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
    expect(states.every((state) => state.gpuWorkLevel === 0)).toBe(true);
  });

  it("S7b: a host with main-thread work outside render() sheds CPU work and no GPU work", () => {
    // Each CPU rung takes 3% off render(), and 3 ms of other main-thread
    // work makes a frame a refresh late whenever the two pass 16.37 ms.
    // Split on the proxy alone, 15.5 ms took the scale and then every GPU
    // rung; 20 ms ends with the CPU ladder spent, render() at 14.8 ms and
    // every frame still late.
    const host = (cpu: number) => trace(createGovernorState(config), 60, (_, state) => {
      const render = cpu * 0.97 ** state.cpuWorkLevel;
      return frames(render, render + 3 > VSYNC_60 - 0.3 ? 1 : 0);
    });
    for (const cpu of [15.5, 16, 17, 17.5, 18, 20]) {
      const states = host(cpu);
      const label = `render() p95 ${cpu} ms at level 0`;
      expect(states.every((state) => state.gpuWorkLevel === 0), label).toBe(true);
      expect(states.some((state) => state.cpuWorkLevel >= 5), label).toBe(true);
      expect(states[59]!.renderScale, label).toBe(config.scaleCeiling);
    }
    // PR B part 2 (K1): once a rung takes render() under the 13.7 ms GPU
    // target while the frame is still late, the proxy reads the window as
    // GPU-bound. Ten rungs take render() further than seven, and 18 ms
    // stopped at rung 9 of 10 and shed every GPU rung instead of the one CPU
    // rung that fixes it. Whatever the start, no GPU rung goes while the CPU
    // ladder has one left.
    for (let tenths = 140; tenths <= 200; tenths += 1) {
      const states = host(tenths / 10);
      expect(
        states.every((state) => state.gpuWorkLevel === 0 || state.cpuWorkLevel === CPU_WORK_MAX_LEVEL),
        `render() p95 ${tenths / 10} ms at level 0`,
      ).toBe(true);
    }
  });

  it("S7b: once the CPU ladder is spent, resolution steps that work may take the GPU ladder on", () => {
    // render() 14 ms on a GPU that is short too: each step cuts the late
    // share, so the GPU is part of the miss.
    const lateAt = (scale: number) => (scale > 0.85 ? 1 : scale > 0.8 ? 0.6 : scale > 0.755 ? 0.3 : 0.2);
    const windows = CPU_URGENT_SHED_WINDOWS + 16;
    const states = trace(createGovernorState(config), windows, (_, state) => frames(14, lateAt(state.renderScale)));
    expect(firstWindow(states, (state) => state.cpuWorkLevel === CPU_WORK_MAX_LEVEL)).toBe(CPU_URGENT_SHED_WINDOWS);
    expect(firstWindow(states, (state) => state.renderScale === config.scaleFloor)).toBeGreaterThan(CPU_URGENT_SHED_WINDOWS);
    expect(states.some((state) => state.resolutionInsensitive)).toBe(false);
    expect(states[windows - 1]!.gpuWorkLevel).toBeGreaterThan(0);
  });

  it("S7c: a pacing-bound miss that resolution did not fix sheds CPU work before GPU work", () => {
    // 120 Hz paced to 60: a missed slot is 25 ms, and render() p95 12.5 ms
    // leaves a proxy that neither side explains.
    const paced = governorConfigForProfile(medium, cadence(60, 2, 120, true));
    const pacing = () => windowOf(intervals(VSYNC_60, 36, 25), 12.5, paced);
    const states = trace(createGovernorState(paced), CPU_SHED_WINDOWS + 6, pacing, { config: paced });
    expect(resolveSignals(windowOf(intervals(VSYNC_60, 36, 25), 12.5, paced), paced.gpuTargetMs, paced.presentationTargetMs)
      .classification).toBe("pacing-bound");
    // Two steps that buy nothing, undone and latched at window 4; then a CPU
    // rung where E3 sheds a GPU one. With ten CPU rungs the latch re-arms at
    // window 19, before the last of them, and resolution is probed and
    // latched once more (three windows) before the CPU ladder goes on.
    expect(firstWindow(states, (state) => state.resolutionInsensitive)).toBe(4);
    expect(firstWindow(states, (state) => state.cpuWorkLevel > 0)).toBe(5);
    expect(states[CPU_SHED_WINDOWS + 5]!.cpuWorkLevel).toBe(CPU_WORK_MAX_LEVEL);
    expect(states.every((state) => state.gpuWorkLevel === 0)).toBe(true);
  });

  /** R5 trace B: streaming hitches, one window in ten frames a refresh late, behind a binding pixel cap. */
  const hitchy = trace(createGovernorState(config), 5 + 2 * GPU_WORK_MAX_LEVEL, () => frames(9, 0.1), { capBinds: true });

  it("S8 (R5 trace B): a hitchy frame behind a binding pixel cap latches and sheds the whole GPU ladder", () => {
    expect(firstWindow(hitchy, (state) => state.resolutionInsensitive)).toBeLessThanOrEqual(2);
    // Latched at window 2, then a rung every second window. firstWindow is
    // -1 for a ladder that never tops out, so the bound alone was vacuous.
    const topped = firstWindow(hitchy, (state) => state.gpuWorkLevel === GPU_WORK_MAX_LEVEL);
    expect(topped).toBeGreaterThan(0);
    expect(topped).toBeLessThanOrEqual(3 + 2 * GPU_WORK_MAX_LEVEL);
    expect(hitchy.every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
    expect(hitchy.every((state) => state.cpuWorkLevel === 0)).toBe(true);
  });

  it("S8 (R5 trace C): once the frame is healthy again, the whole GPU ladder comes back", () => {
    const shed = hitchy[hitchy.length - 1]!;
    expect(shed.gpuWorkLevel).toBe(GPU_WORK_MAX_LEVEL);
    const states = trace(shed, 60, () => frames(5));
    // Four calm windows a rung: 44 windows for eleven, 88 s at 60 fps.
    expect(firstWindow(states, (state) => state.gpuWorkLevel === 0)).toBe(GPU_RECOVERY_WINDOWS);
    expect(states[59]!.cpuWorkLevel).toBe(0);
  });
});

describe("recovery on trial", () => {
  const recovered = (state: GovernorState, previous: GovernorState): boolean =>
    state.gpuWorkLevel < previous.gpuWorkLevel;
  const restored = (state: GovernorState, previous: GovernorState): boolean =>
    state.gpuWorkLevel > previous.gpuWorkLevel;

  it("S10: a GPU rung that costs the cadence back is tried less and less often", () => {
    // Calm at GPU level 3 or above; level 2 puts 10 of 120 frames a refresh late.
    const start = withLevels(0, 3);
    const states = trace(start, 240, (_, state) => frames(5, state.gpuWorkLevel <= 2 ? 0.08 : 0));
    // Backoffs of 15, 30, then 60 windows. Strikes are kept on a pass and one
    // is forgiven per 60 windows without a failure, so after the third the
    // ladder settles at one trial per 61 windows (122 s).
    expect(windowsWhere(start, states, recovered)).toEqual([4, 20, 51, 112, 173, 234]);
    expect(windowsWhere(start, states, restored)).toEqual([5, 21, 52, 113, 174, 235]);
    expect(states.every((state) => state.gpuWorkLevel >= 2)).toBe(true);
    expect(Math.max(...states.map((state) => state.recovery.gpu.strikes))).toBe(3);
    expect(states[239]!.gpuWorkLevel).toBe(3);
  });

  it("S10c: at 144 Hz paced to 72, a failing rung is tried no more often in time than at 60 fps", () => {
    // A window of 120 frames lasts 1.67 s at 72 fps. Counted in windows,
    // the 60 fps backoffs retried a failing rung every 102 s here.
    const paced = governorConfigForProfile(medium, cadence(60, 2, 144, true));
    expect(paced.recoveryBackoffWindows).toEqual([18, 36, 72]);
    expect(paced.strikeForgivenAfterWindows).toBe(72);
    expect(paced.lateFailureWindows).toBe(18);
    const windowSeconds = (paced.windowFrames * 2 * VSYNC_144) / 1_000;
    const start = withLevels(0, 3);
    const states = trace(start, 400, (_, state) =>
      windowOf(intervals(2 * VSYNC_144, state.gpuWorkLevel <= 2 ? 10 : 0, 3 * VSYNC_144), 5, paced), { config: paced });
    const recoveries = windowsWhere(start, states, recovered);
    expect(recoveries).toEqual([4, 23, 60, 133, 206, 279, 352]);
    // After the third strike, one pair per 73 windows: 122 s, as at 60 fps.
    const gaps = recoveries.slice(3).map((window, index) => (window - recoveries[index + 2]!) * windowSeconds);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(120);
  });

  it("S10b: a rung whose cost arrives three windows late is not tried more than once a minute", () => {
    // The red team's delayed-cost model: from the vegetation-distance rung, a
    // recovered rung's cost (12% of frames late) arrives three windows after
    // the recovery. Vegetation distance is a streaming rung, so its
    // four-window trial is still open when the cost lands.
    const vegetation = levelOf(GPU_WORK_MAX_LEVEL, gpuWorkLeverName, "vegetation-distance");
    const start = withLevels(0, vegetation);
    let level = start.gpuWorkLevel;
    let recoveredAt = Number.NEGATIVE_INFINITY;
    const states = trace(start, 300, (window, state) => {
      if (state.gpuWorkLevel < level) recoveredAt = window - 1;
      level = state.gpuWorkLevel;
      return frames(5, level < vegetation && window - recoveredAt > 3 ? 0.12 : 0);
    }, { capBinds: true });
    const recoveries = windowsWhere(start, states, recovered);
    expect(recoveries).toEqual([4, 23, 57, 121, 185, 249]);
    // At most one pair per 60 windows after the first 60 (plan §5.4: one per 2 min).
    expect(recoveries.filter((window) => window > 60).length).toBeLessThanOrEqual(240 / 60);
    expect(states.every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
  });

  it("S11: a resolution step that costs the cadence back is tried less and less often", () => {
    // Calm at 0.835 or below; 0.86 puts 10 of 120 frames a refresh late.
    const start = withLevels(0, 0, { renderScale: 0.81 });
    const states = trace(start, 180, (_, state) => frames(5, state.renderScale > 0.835 + 1e-9 ? 0.08 : 0));
    const moves = windowsWhere(start, states, (state, previous) => state.renderScale !== previous.renderScale)
      .map((window) => [window, Number(states[window - 1]!.renderScale.toFixed(3))]);
    expect(moves).toEqual([
      [4, 0.835], [8, 0.86], [9, 0.835],
      [24, 0.86], [25, 0.835],
      [55, 0.86], [56, 0.835],
      [116, 0.86], [117, 0.835],
      [177, 0.86], [178, 0.835],
    ]);
    expect(states.every((state) => !state.resolutionInsensitive && state.pendingProbe === null)).toBe(true);
  });

  it("S16: an on-cadence window that is not calm still passes a trial", () => {
    const start = withLevels(0, 3);
    const lates = [0, 0, 0, 0, 0.05, 0];
    const states = trace(start, lates.length, (window) => frames(5, lates[window - 1]!));
    expect(states[3]!.gpuWorkLevel).toBe(2);
    expect(states[3]!.trial).toMatchObject({ ladder: "gpu", restoreLevel: 3, windowsPassed: 0, streaming: false });
    expect(states[4]!.trial?.windowsPassed).toBe(1);
    expect(states[5]!.trial).toBeNull();
    expect(states[5]!.gpuWorkLevel).toBe(2);
    expect(states[5]!.recovery.gpu.strikes).toBe(0);
  });

  it("a streaming rung's trial lasts four windows and ends only once streaming has caught up", () => {
    // CPU level 1 is a terrain-page-request rung: its cost arrives with the pages.
    const start = withLevels(1, 0);
    const backlog = [0, 0, 0, 0, 0, 0, 0, 12, 0];
    const states = trace(start, backlog.length, (window) => ({
      ...frames(5),
      streamingBacklog: backlog[window - 1]!,
    }));
    expect(states[3]!.cpuWorkLevel).toBe(0);
    expect(states[3]!.trial).toMatchObject({ ladder: "cpu", streaming: true, openBacklog: 0 });
    expect(states[6]!.trial?.windowsPassed).toBe(3);
    // The fourth window passes, but 12 items are still streaming in.
    expect(states[7]!.trial?.windowsPassed).toBe(4);
    expect(states[8]!.trial).toBeNull();
    expect(states[8]!.cpuWorkLevel).toBe(0);
  });

  it("a streaming trial needs a settled backlog, not an empty one", () => {
    // In flight the detail backlog rarely reads 0: new cells keep coming
    // into reach. A trial that waited for 0 never ended, and held every
    // other recovery while it stayed open.
    const steady = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => ({ ...frames(5), streamingBacklog: 5 }));
    expect(firstWindow(steady, (state) => state.cpuWorkLevel === 0)).toBe(CPU_RECOVERY_WINDOWS);
    const fromBoth = trace(withLevels(CPU_WORK_MAX_LEVEL, GPU_WORK_MAX_LEVEL), 120, () => ({ ...frames(5), streamingBacklog: 5 }));
    expect(firstWindow(fromBoth, (state) => state.cpuWorkLevel === 0 && state.gpuWorkLevel === 0))
      .toBeLessThanOrEqual(CPU_RECOVERY_WINDOWS + GPU_RECOVERY_WINDOWS + 6);
  });

  it("a streaming trial waits while the backlog is above where it was, at most two windows past its four", () => {
    const start = withLevels(1, 0);
    // The rung comes back at window 4 with 6 items waiting.
    const backlog = [6, 6, 6, 6, 9, 9, 7, 8, 5, 5, 5];
    const states = trace(start, backlog.length, (window) => ({ ...frames(5), streamingBacklog: backlog[window - 1]! }));
    expect(states[3]!.trial).toMatchObject({ openBacklog: 6, windowsPassed: 0 });
    // Windows 5-8 pass the cadence, but the backlog is above 6.
    expect(states[7]!.trial?.windowsPassed).toBe(4);
    expect(states[8]!.trial).toBeNull();
    // Growing for good: it ends on the cadence alone after six windows.
    const growing = trace(start, 12, (window) => ({ ...frames(5), streamingBacklog: 10 * window }));
    expect(growing[8]!.trial?.windowsPassed).toBe(5);
    expect(growing[9]!.trial).toBeNull();
    expect(growing[9]!.cpuWorkLevel).toBe(0);
    // Not growing, but still above where it was: the same.
    const high = trace(start, 12, (window) => ({ ...frames(5), streamingBacklog: window <= 4 ? 2 : 3 }));
    expect(high[8]!.trial?.windowsPassed).toBe(5);
    expect(high[9]!.trial).toBeNull();
  });

  it("keeps a strike through a passed trial and forgives it after 60 windows without a failure", () => {
    // GPU level 1; the first recovery fails, the cost then goes away.
    const start = withLevels(0, 1);
    const states = trace(start, 70, (window, state) => frames(5, window === 5 && state.gpuWorkLevel === 0 ? 0.08 : 0));
    expect(states[4]!.recovery.gpu).toMatchObject({ strikes: 1, backoffWindows: 15 });
    expect(states[4]!.gpuWorkLevel).toBe(1);
    // Backoff over at window 20: the rung comes back and passes.
    expect(windowsWhere(start, states, recovered)).toEqual([4, 20]);
    expect(states[21]!.trial).toBeNull();
    expect(states[21]!.recovery.gpu.strikes).toBe(1);
    expect(states[63]!.recovery.gpu.strikes).toBe(1);
    expect(states[64]!.recovery.gpu.strikes).toBe(0);
  });

  it("counts a re-shed within 15 windows of a passed trial as a failed one", () => {
    const latched = { resolutionInsensitive: true, insensitiveWindowsRemaining: 1_000 };
    const costFrom = (from: number) => (window: number) => frames(5, window >= from ? 0.12 : 0);
    // Recovered at window 4, passed at window 6.
    const early = trace(withLevels(0, 1, latched), 9, costFrom(8));
    expect(early[5]!.recovery.gpu.windowsSincePass).toBe(0);
    expect(early[8]!.gpuWorkLevel).toBe(1);
    expect(early[8]!.recovery.gpu).toMatchObject({ strikes: 1, backoffWindows: 15 });
    // Sixteen windows after the pass, a shed is a new load, not a missed trial.
    const late = trace(withLevels(0, 1, latched), 31, costFrom(30));
    expect(late[30]!.gpuWorkLevel).toBe(1);
    expect(late[30]!.recovery.gpu).toMatchObject({ strikes: 0, backoffWindows: 0 });
  });

  it("S17: a cadence rebase drops what the old targets judged and keeps the trial on its verdict", () => {
    const state = Object.freeze({
      ...withLevels(2, 4, { renderScale: 0.81, resolutionInsensitive: true, insensitiveWindowsRemaining: 9 }),
      pendingProbe: Object.freeze({
        preStepGpuP95Ms: 33.3,
        preStepScale: 0.86,
        metric: "interval" as const,
        preIntervalMeanMs: 20,
        preLateFraction: 0.2,
      }),
      ineffectiveDownSteps: 1,
      restoreScale: 0.86,
      cpuHotWindows: 1,
      gpuHotWindows: 1,
      offCadenceWindows: 3,
      calmStreak: Object.freeze([0, 0.01]),
      trial: Object.freeze({
        ladder: "gpu" as const,
        restoreLevel: 5,
        restoreScale: 0.81,
        windowsPassed: 1,
        streaming: false,
        openBacklog: null,
        lastBacklog: null,
      }),
    });
    const rebased = rebaseGovernorState(state);
    expect(rebased).toMatchObject({
      pendingProbe: null,
      ineffectiveDownSteps: 0,
      restoreScale: null,
      cpuHotWindows: 0,
      gpuHotWindows: 0,
      offCadenceWindows: 0,
      calmStreak: [],
      trial: { ladder: "gpu", restoreLevel: 5, windowsPassed: 0 },
      cpuWorkLevel: 2,
      gpuWorkLevel: 4,
      renderScale: 0.81,
      resolutionInsensitive: true,
      insensitiveWindowsRemaining: 9,
    });
    expect(rebased.recovery).toBe(state.recovery);
    // The restarted trial needs its two windows again, and still fails off cadence.
    const passing = trace(rebased, 2, () => frames(5));
    expect(passing[0]!.trial?.windowsPassed).toBe(1);
    expect(passing[1]!.trial).toBeNull();
    const failing = trace(rebased, 1, () => frames(5, 0.1));
    expect(failing[0]!.gpuWorkLevel).toBe(5);
    expect(failing[0]!.recovery.gpu.strikes).toBe(1);
  });
});

describe("the shipping governor at other cadences", () => {
  it("S12: at the 30 fps setting 33.3 ms is on cadence, a CPU up to 30 ms recovers, and 10% late sheds", () => {
    const thirty = governorConfigForProfile(medium, cadence(30, 2, 60, true));
    expect(thirty.presentationTargetMs).toBe(1_000 / 30);
    expect(thirty.gpuTargetMs).toBe(30);
    expect(thirty.lateIntervalMs).toBeCloseTo(2.5 * VSYNC_60, 9);
    const steady = trace(createGovernorState(thirty), 20, () => windowOf(intervals(1_000 / 30), 9, thirty), { config: thirty });
    expect(steady.every((state) => state.mode === "on-cadence" && state.renderScale === thirty.scaleCeiling)).toBe(true);
    // Machines that hold 30 get their rungs back: 0.9 x 33.3 = 30 ms of render().
    const recovering = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), CPU_RECOVERY_WINDOWS + 12, () => windowOf(intervals(1_000 / 30), 20, thirty), { config: thirty });
    expect(firstWindow(recovering, (state) => state.cpuWorkLevel === 0)).toBe(CPU_RECOVERY_WINDOWS);
    // 12 of 120 frames at 50 ms: off cadence twice, then a resolution step.
    const hitching = trace(createGovernorState(thirty), 2, () => windowOf(intervals(1_000 / 30, 12, 50), 9, thirty), { config: thirty });
    expect(hitching[0]!.renderScale).toBe(thirty.scaleCeiling);
    expect(hitching[1]!.renderScale).toBeCloseTo(thirty.scaleCeiling - 0.05, 9);
  });

  it("S13: a confirmed 50 Hz panel sheds as it did before PR B", () => {
    const fifty = governorConfigForProfile(medium, cadence(60, 1, 50, true));
    // PR B part 2 (G6): only urgency and the spent count read the panel's own
    // 20 ms; every target and threshold is the null cadence's.
    expect(fifty.displayLimitMs).toBeCloseTo(20, 9);
    expect({ ...fifty, displayLimitMs: 0 }).toEqual(config);
    expect(fifty.lateIntervalMs).toBeCloseTo(1.15 * VSYNC_60, 9);
    const at50 = (governorConfig: GovernorConfig) =>
      trace(createGovernorState(governorConfig), 12, () => windowOf(intervals(20), 6, governorConfig), { config: governorConfig });
    const states = at50(fifty);
    expect(states).toEqual(at50(config));
    expect(states[0]!.mode).not.toBe("on-cadence");
    expect(states[1]!.renderScale).toBeLessThan(config.scaleCeiling);
    // Without a late share the p95 rule reads 20 ms as off cadence too.
    expect(resolveSignals({ gpuP95Ms: null, cpuP95Ms: 6, intervalP95Ms: 20 }, fifty.gpuTargetMs, fifty.presentationTargetMs)
      .classification).not.toBe("on-cadence");
  });

  it("S14: a slow machine whose observed period is its own 33.3 ms frame sheds as it did before PR B", () => {
    const slow = governorConfigForProfile(medium, cadence(60, 1, 30, false));
    expect(slow).toEqual(config);
    const run = (governorConfig: GovernorConfig) =>
      trace(createGovernorState(governorConfig), 12, () => windowOf(intervals(1_000 / 30), 9, governorConfig), {
        config: governorConfig,
      });
    const states = run(slow);
    expect(states).toEqual(run(config));
    expect(states.some((state) => state.resolutionInsensitive)).toBe(true);
    expect(states[11]!.gpuWorkLevel).toBeGreaterThan(0);
  });

  it("S15: a confirmed 30 Hz rAF sheds at the 60 setting as before, and is on cadence at the 30 setting", () => {
    const at60 = governorConfigForProfile(medium, cadence(60, 1, 30, true));
    // PR B part 2 (G6): as at 50 Hz, only urgency and the spent count read the 33.3 ms.
    expect(at60.displayLimitMs).toBeCloseTo(1_000 / 30, 9);
    expect({ ...at60, displayLimitMs: 0 }).toEqual(config);
    const shedding = trace(createGovernorState(at60), 2, () => windowOf(intervals(1_000 / 30), 6, at60), { config: at60 });
    expect(shedding[1]!.renderScale).toBeLessThan(config.scaleCeiling);
    const at30 = governorConfigForProfile(medium, cadence(30, 1, 30, true));
    expect(at30.presentationTargetMs).toBe(1_000 / 30);
    expect(at30.lateIntervalMs).toBeCloseTo(50, 9);
    const states = trace(createGovernorState(at30), 12, () => windowOf(intervals(1_000 / 30), 6, at30), { config: at30 });
    expect(states.every((state) => state.mode === "on-cadence" && state.renderScale === at30.scaleCeiling)).toBe(true);
  });

  it("S19: a slow machine on a fast panel, period unconfirmed, sheds toward 60", () => {
    // The period it observes may be the panel's or a multiple of it; neither
    // may read a missed refresh as on time.
    const cases: readonly [number, number, number][] = [
      // [panel Hz, refreshes per frame, observed multiple]
      [144, 3, 1], [144, 3, 3],
      [165, 4, 1], [165, 4, 4],
      [240, 5, 1], [240, 5, 5],
      [120, 3, 1], [120, 3, 2], [120, 3, 3],
    ];
    for (const [hz, refreshes, observed] of cases) {
      const governorConfig = governorConfigForProfile(medium, cadence(60, 1, hz / observed, false));
      const frameMs = (refreshes * 1_000) / hz;
      const label = `${hz} Hz at ${(1_000 / frameMs).toFixed(0)} fps, observing ${observed} refreshes`;
      const states = trace(createGovernorState(governorConfig), 2, () => windowOf(intervals(frameMs), 6, governorConfig), {
        config: governorConfig,
      });
      expect(states[0]!.mode, label).not.toBe("on-cadence");
      expect(states[1]!.renderScale, label).toBeLessThan(config.scaleCeiling);
    }
  });

  it("S19: at a confirmed 90 Hz, two refreshes are on time and three late, whatever the jitter", () => {
    const ninety = governorConfigForProfile(medium, cadence(60, 1, 90, true));
    const period = 1_000 / 90;
    expect(ninety.lateIntervalMs).toBeCloseTo(2.5 * period, 9);
    const jittered = (refreshes: number) =>
      Array.from({ length: 120 }, (_, frame) => refreshes * period + ((frame % 5) - 2) * 0.5);
    expect(summariseIntervals(jittered(2), ninety.lateIntervalMs).late).toBe(0);
    expect(summariseIntervals(jittered(3), ninety.lateIntervalMs).late).toBe(1);
  });
});

describe("the late threshold", () => {
  it("keeps clear of every whole refresh on panels up to 240 Hz", () => {
    // Vsync puts every presented interval on a multiple of the true period,
    // so a threshold near one lets timestamp jitter decide frames. Every
    // common rate, setting, confirmation and observed multiple, for every
    // divisor the pacer might choose. The closest are 0.83 ms: an unconfirmed
    // 19.17 ms against a 20 ms refresh (50 and 100 Hz), and 38.33 against
    // 37.5 (240 Hz at the 30 setting).
    const profiles = [medium, resolveWebGpuQualityProfile("high", "ultra")];
    const caps: readonly FrameRateCap[] = [60, 30, null];
    let closest = Number.POSITIVE_INFINITY;
    for (const profile of profiles) {
      for (const hz of [48, 50, 60, 75, 90, 100, 120, 144, 165, 240]) {
        const period = 1_000 / hz;
        for (const cap of caps) {
          for (let divisor = 1; divisor <= 8; divisor += 1) {
            const observed = [1, 2, 3, 4, 5, 6].map((multiple) => multiple * period).filter((ms) => ms <= 34);
            const cadences = [
              cadence(cap, divisor, hz, true),
              ...observed.map((ms) => cadence(cap, divisor, 1_000 / ms, false)),
              cadence(cap, divisor, null, false),
            ];
            for (const each of cadences) {
              const late = governorConfigForProfile(profile, each).lateIntervalMs;
              const margin = Math.abs(late - Math.round(late / period) * period);
              closest = Math.min(closest, margin);
              expect(margin, `${hz} Hz, cap ${cap}, divisor ${divisor}, ${JSON.stringify(each)}`)
                .toBeGreaterThanOrEqual(0.8);
            }
          }
        }
      }
    }
    expect(closest).toBeCloseTo(5 / 6, 2);
  });
});

describe("binomial spikes (red team finding 6)", () => {
  /** A seeded generator, so each case sees the same windows whatever runs before it. */
  function spikes(seed: number) {
    let value = seed;
    const random = (): number => {
      value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
      return value / 2_147_483_648;
    };
    // 40 ms spikes outside render(), render() p95 4 ms.
    return (share: number): GovernorSignals =>
      windowOf(Array.from({ length: 120 }, () => (random() < share ? 2.5 * VSYNC_60 : VSYNC_60)), 4, config);
  }

  const SEEDS = [987_654_321, 12_345, 424_242];

  it("S18: 2% spikes move nothing, and 3% walk the scale to its floor with at most one GPU rung", () => {
    for (const seed of SEEDS) {
      const at2 = spikes(seed);
      const states = trace(createGovernorState(config), 150, () => at2(0.02));
      expect(states.every((state) => state.renderScale === config.scaleCeiling && state.gpuWorkLevel === 0), `seed ${seed}`)
        .toBe(true);
    }
    // At 3% one window in fourteen is off cadence. Two in a row step the
    // scale, and a pooled 3% is never calm enough to undo it, so the scale
    // drifts to its floor (as in the red team's own amended prototype),
    // by window 82, 270 and 187 for these seeds (PR B part 2's floor, 0.6 of
    // the capped pixels, is four steps down); only then can a pair reach the
    // GPU ladder.
    for (const seed of SEEDS) {
      const at3 = spikes(seed);
      const states = trace(createGovernorState(config), 300, () => at3(0.03));
      expect(firstWindow(states, (state) => state.renderScale === config.scaleFloor), `seed ${seed}`).toBeGreaterThan(0);
      expect(Math.max(...states.map((state) => state.gpuWorkLevel)), `seed ${seed}`).toBeLessThanOrEqual(1);
      expect(states.every((state) => state.cpuWorkLevel === 0), `seed ${seed}`).toBe(true);
    }
  });

  it("S18: whatever 3-7% spikes shed comes back once they fall to 1.5%", () => {
    // Spike-dominated windows still shed GPU rungs from about 4%, every one
    // of them by window 285 at 4%: the GPU ladder has no effectiveness latch
    // (a known limit, left to G6/G7).
    for (const seed of SEEDS) {
      for (const share of [0.03, 0.05, 0.07]) {
        const label = `seed ${seed}, ${share * 100}% spikes`;
        const window = spikes(seed);
        const shed = trace(createGovernorState(config), 150, () => window(share));
        const calm = trace(shed[149]!, 100, () => window(0.015));
        const back = firstWindow(calm, (state) =>
          state.gpuWorkLevel === 0 && state.cpuWorkLevel === 0 && state.renderScale === config.scaleCeiling);
        expect(back, label).toBeGreaterThan(0);
        // From the top of the GPU ladder and the floor, a rung or a step per
        // four calm windows. A 1.5% window off cadence now and then restarts
        // the count: that costs the slowest of these cases 4 windows, and the
        // bound allows 8 more.
        expect(back, label).toBeLessThanOrEqual(GPU_RECOVERY_WINDOWS + SCALE_RECOVERY_WINDOWS + 4 + 8);
        expect(calm[99]!.renderScale, label).toBe(config.scaleCeiling);
        expect(calm[99]!.gpuWorkLevel, label).toBe(0);
      }
    }
  });
});

describe("G2: a step test that sees through vsync", () => {
  // Medium, render() p95 8 ms, and the presented p95 pinned at 33.3 ms by
  // vsync whatever a step buys: only the late share and the mean can move.
  const path = (states: readonly GovernorState[]) => states.map((state) => Number(state.renderScale.toFixed(2)));

  it("E2: a step that cuts the late share is kept until the cadence is met", () => {
    const lateAt = (scale: number) => (scale > 0.85 ? 0.3 : scale > 0.8 ? 0.2 : scale > 0.75 ? 0.12 : 0.04);
    const states = trace(createGovernorState(config), 6, (_, state) => frames(8, lateAt(state.renderScale)));
    // PR B part 2 (G4): 4% late at 0.71 is on cadence, so the walk stops
    // there, above the floor (0.666), not at it.
    expect(path(states)).toEqual([0.86, 0.81, 0.76, 0.71, 0.71, 0.71]);
    expect(0.71).toBeGreaterThan(config.scaleFloor);
    expect(states.some((state) => state.resolutionInsensitive)).toBe(false);
    expect(states.every((state) => state.ineffectiveDownSteps === 0)).toBe(true);
    expect(states[4]!.mode).toBe("on-cadence");
  });

  it("E3: a dead lever is undone and latched, and the GPU ladder takes over", () => {
    const states = trace(createGovernorState(config), 9, () => frames(8, 0.3));
    expect(path(states)).toEqual([0.86, 0.81, 0.76, 0.86, 0.86, 0.86, 0.86, 0.86, 0.86]);
    expect(firstWindow(states, (state) => state.resolutionInsensitive)).toBe(4);
    expect(states.map((state) => state.gpuWorkLevel)).toEqual([0, 0, 0, 0, 1, 1, 2, 2, 3]);
  });

  it("E: signals without a late share or mean keep today's p95 test, and latch the same way", () => {
    const today = trace(createGovernorState(config), 9, () => ({ gpuP95Ms: null, cpuP95Ms: 8, intervalP95Ms: 33.3 }));
    const e3 = trace(createGovernorState(config), 9, () => frames(8, 0.3));
    const summary = (states: readonly GovernorState[]) =>
      states.map((state) => [state.renderScale, state.gpuWorkLevel, state.resolutionInsensitive]);
    expect(summary(today)).toEqual(summary(e3));
  });

  it("a 4% fall in the mean interval alone counts", () => {
    const means = [25, 25, 23.5];
    const states = trace(createGovernorState(config), 3, (window) => ({
      gpuP95Ms: null,
      cpuP95Ms: 8,
      intervalP95Ms: 33.3,
      intervalMeanMs: means[window - 1]!,
    }));
    expect(states[1]!.pendingProbe).toMatchObject({ preIntervalMeanMs: 25, preLateFraction: null });
    expect(states[2]!.ineffectiveDownSteps).toBe(0);
    expect(states[2]!.resolutionInsensitive).toBe(false);
  });

  it("an on-cadence window after a step counts, however little it moved", () => {
    const lates = [0.1, 0.1, 0.05];
    const states = trace(createGovernorState(config), 3, (window) => frames(8, lates[window - 1]!));
    expect(states[1]!.pendingProbe).not.toBeNull();
    expect(states[2]).toMatchObject({ pendingProbe: null, ineffectiveDownSteps: 0, mode: "on-cadence" });
    expect(states[2]!.renderScale).toBeCloseTo(0.81, 9);
  });

  it("a late share needs to fall by a quarter and by three frames", () => {
    const judged = (preLateFraction: number, lateFrames: number, windowFrames: number): boolean => {
      const probe = {
        preStepGpuP95Ms: 33.3,
        preStepScale: 0.86,
        metric: "interval" as const,
        preIntervalMeanMs: null,
        preLateFraction,
      };
      const signals: GovernorSignals = {
        gpuP95Ms: null,
        cpuP95Ms: 8,
        intervalP95Ms: 33.3,
        lateFraction: lateFrames / windowFrames,
      };
      const resolved = resolveSignals(signals, config.gpuTargetMs, config.presentationTargetMs);
      return stepWasEffective(probe, signals, resolved, windowFrames);
    };
    // A 60-frame window: 6 -> 4 late is a third, but only two frames.
    expect(judged(6 / 60, 4, 60)).toBe(false);
    expect(judged(6 / 60, 3, 60)).toBe(true);
    // Less than a quarter is not enough, however many frames it is.
    expect(judged(0.4, 39, 120)).toBe(false);
    expect(judged(0.4, 36, 120)).toBe(true);
    // Nor is any drop from 2% of frames late or fewer.
    expect(judged(0.02, 0, 120)).toBe(false);
  });
});
