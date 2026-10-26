import { describe, expect, it } from "vitest";
import {
  CPU_WORK_MAX_LEVEL,
  GPU_WORK_MAX_LEVEL,
  createGovernorState,
  governorConfigForProfile,
  nextGovernorDecision,
  observeRenderScaleApplication,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

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
 * `it.fails` marks a defect of today's governor; PR B's G1 turns each into `it`.
 */

const medium = resolveWebGpuQualityProfile("medium", "balanced");
const config = governorConfigForProfile(medium);
const VSYNC_60 = 1_000 / 60;
const VSYNC_120 = 1_000 / 120;

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
    cpuP95Ms,
    intervalP95Ms: slowFrames > 6 ? slowMs : onTimeMs,
    intervalMeanMs: onTimeMs + (slowFrames / 120) * (slowMs - onTimeMs),
    lateFraction: slowFrames / 120,
  };
}

interface TraceOptions {
  readonly config?: GovernorConfig;
  /** The pixel cap absorbs every downward step, as at 1440p and on Retina (R5 §2.3). */
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

function withLevels(cpuWorkLevel: number, gpuWorkLevel: number, extra: Partial<GovernorState> = {}): GovernorState {
  return Object.freeze({ ...createGovernorState(config), cpuWorkLevel, gpuWorkLevel, ...extra });
}

describe("the shipping governor on a healthy cadence", () => {
  it("S1 (R5 trace A): a healthy 60 Hz frame with a 5 ms CPU moves nothing", () => {
    const states = trace(createGovernorState(config), 3, () => frames(5));
    for (const state of states) {
      expect(state.renderScale).toBe(config.scaleCeiling);
      expect(state.pendingProbe).toBeNull();
      expect(state.cpuWorkLevel).toBe(0);
      expect(state.gpuWorkLevel).toBe(0);
    }
  });

  it.fails("S2 (R5 trace3): a CPU ladder shed to the top comes back, one rung per four windows", () => {
    for (const cpu of [3, 5, 7, 8.5]) {
      const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), 40, () => frames(cpu));
      expect(firstWindow(states, (state) => state.cpuWorkLevel === 0), `render() p95 ${cpu} ms`).toBe(28);
    }
  });

  it.fails("S3: the CPU ladder recovers with render() p95 up to 0.9 of the 16.67 ms target", () => {
    // The red team's dead band: a gate at 0.8 x 13.7 = 10.96 ms left every
    // machine between 11 and 16.7 ms with its CPU rungs shed for good.
    for (const cpu of [10.9, 11.4, 12.5, 14.5]) {
      const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), 40, () => frames(cpu));
      expect(firstWindow(states, (state) => state.cpuWorkLevel === 0), `render() p95 ${cpu} ms`).toBe(28);
    }
  });

  it("S3: a render() p95 above 15 ms keeps its CPU rungs", () => {
    const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), 40, () => frames(15.5));
    expect(states.every((state) => state.cpuWorkLevel === CPU_WORK_MAX_LEVEL)).toBe(true);
  });

  it.fails("S4: a 120 Hz display paced to 60 recovers exactly like S2", () => {
    // Today the config cannot see the cadence, so the paced stream (every
    // second refresh, 16.67 ms apart) reads exactly as a 60 Hz display does.
    const states = trace(withLevels(CPU_WORK_MAX_LEVEL, 0), 40, () => frames(5));
    expect(firstWindow(states, (state) => state.cpuWorkLevel === 0)).toBe(28);
  });

  it("S5: Match display at 120 Hz (8.33 ms intervals) recovers the CPU ladder", () => {
    const states = trace(
      withLevels(CPU_WORK_MAX_LEVEL, 0),
      40,
      () => frames(5, 0, 2 * VSYNC_120, VSYNC_120),
    );
    expect(firstWindow(states, (state) => state.cpuWorkLevel === 0)).toBe(28);
  });

  it.fails("S6 (R5 trace4): a fast CPU on a healthy, latched 60 Hz frame sheds no GPU work", () => {
    // render() p95 2.5 ms makes today's proxy 14.17 ms, over the 13.7 ms target.
    const latched = withLevels(0, 0, { resolutionInsensitive: true, insensitiveWindowsRemaining: 15 });
    const states = trace(latched, 14, () => frames(2.5));
    expect(states.every((state) => state.gpuWorkLevel === 0)).toBe(true);
  });

  it("S9: exactly 5% late frames (6 of 120) moves nothing", () => {
    const states = trace(createGovernorState(config), 20, () => frames(9, 0.05));
    for (const state of states) {
      expect(state.renderScale).toBe(config.scaleCeiling);
      expect(state.cpuWorkLevel).toBe(0);
      expect(state.gpuWorkLevel).toBe(0);
    }
  });
});

describe("the shipping governor off cadence", () => {
  it.fails("S7 (R5 trace2, P9): a CPU-bound host sheds CPU work and keeps its resolution", () => {
    // render() p95 alternating 14 and 16 ms with the interval held at 23 ms.
    // Today the pacing label pre-empts the split, the resolution probe reads
    // 23 -> 7 ms as a 70% gain, and the scale walks to its floor while the
    // CPU ladder never moves.
    const states = trace(createGovernorState(config), 14, (window) => ({
      gpuP95Ms: null,
      cpuP95Ms: window % 2 === 1 ? 14 : 16,
      intervalP95Ms: 23,
      intervalMeanMs: 20,
      lateFraction: 0.4,
    }));
    expect(firstWindow(states, (state) => state.cpuWorkLevel > 0)).toBe(2);
    expect(states[13]!.cpuWorkLevel).toBe(CPU_WORK_MAX_LEVEL);
    expect(states.every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
    expect(states.some((state) => state.resolutionInsensitive)).toBe(false);
  });

  /** R5 trace B: streaming hitches, one window in ten frames a refresh late, behind a binding pixel cap. */
  const hitchy = trace(createGovernorState(config), 22, () => frames(9, 0.1), { capBinds: true });

  it("S8 (R5 trace B): a hitchy frame behind a binding pixel cap latches and sheds the whole GPU ladder", () => {
    expect(firstWindow(hitchy, (state) => state.resolutionInsensitive)).toBeLessThanOrEqual(2);
    expect(firstWindow(hitchy, (state) => state.gpuWorkLevel === GPU_WORK_MAX_LEVEL)).toBeLessThanOrEqual(22);
    expect(hitchy.every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
    expect(hitchy.every((state) => state.cpuWorkLevel === 0)).toBe(true);
  });

  it.fails("S8 (R5 trace C): once the frame is healthy again, the whole GPU ladder comes back", () => {
    const shed = hitchy[hitchy.length - 1]!;
    expect(shed.gpuWorkLevel).toBe(GPU_WORK_MAX_LEVEL);
    const states = trace(shed, 60, () => frames(5));
    // Nine rungs, four calm windows each: 36 windows, 72 s at 60 fps.
    expect(firstWindow(states, (state) => state.gpuWorkLevel === 0)).toBe(36);
    expect(states[59]!.cpuWorkLevel).toBe(0);
  });
});
