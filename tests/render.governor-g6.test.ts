import { describe, expect, it } from "vitest";
import {
  CPU_WORK_MAX_LEVEL,
  EXHAUSTED_AFTER_WINDOWS,
  GPU_WORK_MAX_LEVEL,
  createGovernorState,
  governorConfigForProfile,
  governorExhausted,
  nextGovernorDecision,
  observeRenderScaleApplication,
  rebaseGovernorState,
  summariseIntervals,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import type { PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import { frameTimingPercentile95, resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

/**
 * PR B part 2 (K3, G6a): urgency, the spent count and the exhausted state,
 * on shipping-shaped windows (no GPU timestamps, intervals on whole
 * refreshes, so a window's mean sits on the vsync lattice).
 *
 * A window whose mean presented interval is over 1.5× the reference is
 * urgent: once the miss has lasted two windows, it sheds a rung by itself
 * instead of every second window. A window off cadence with nothing left to
 * shed for the side that bound it, at a mean over 1.2× the reference, is
 * spent; four in a row make the governor exhausted. The reference is the
 * presentation target, or the interval a confirmed display period allows
 * where that is longer, so a 30 or 50 Hz panel under the 60 fps setting does
 * not make the machine urgent or exhausted. Exhaustion only reports: nothing
 * reads it but diagnostics and the bench.
 */

const VSYNC_60 = 1_000 / 60;
const medium = resolveWebGpuQualityProfile("medium", "balanced");
const config = governorConfigForProfile(medium);

function cadence(frameCapHz: 60 | 30, divisor: number, hz: number, periodConfirmed: boolean): PresentationCadence {
  return { frameCapHz, divisor, displayPeriodMs: 1_000 / hz, periodConfirmed };
}

/** A window summarised exactly as FlightRenderer does, against `governorConfig`'s late threshold. */
function windowOf(intervals: readonly number[], cpuP95Ms: number, governorConfig: GovernorConfig = config): GovernorSignals {
  const { mean, late } = summariseIntervals(intervals, governorConfig.lateIntervalMs);
  return {
    gpuP95Ms: null,
    cpuP95Ms,
    intervalP95Ms: frameTimingPercentile95(intervals),
    intervalMeanMs: mean,
    lateFraction: late,
  };
}

/** 120 frames at 60 Hz, the first `slowFrames` of them `slowMs` instead of on time. */
function intervals(slowFrames: number, slowMs = 2 * VSYNC_60, onTimeMs = VSYNC_60): number[] {
  return Array.from({ length: 120 }, (_, frame) => (frame < slowFrames ? slowMs : onTimeMs));
}

/** One 60 Hz window: `late` of its frames one refresh late. */
function frames(cpuP95Ms: number, late = 0): GovernorSignals {
  return windowOf(intervals(Math.round(late * 120)), cpuP95Ms);
}

interface TraceOptions {
  readonly config?: GovernorConfig;
  /** The cap or the 0.4 Mpx minimum absorbs every downward step: it changes nothing, and latches. */
  readonly absorbed?: boolean;
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
    if (options.absorbed && state.renderScale < previous.renderScale - 1e-9) {
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

/** 40 ms spikes outside render() at a seeded share of frames, render() p95 4 ms (S18's). */
function spikes(seed: number, share: number): () => GovernorSignals {
  let value = seed;
  const random = (): number => {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
    return value / 2_147_483_648;
  };
  return () => windowOf(Array.from({ length: 120 }, () => (random() < share ? 2.5 * VSYNC_60 : VSYNC_60)), 4);
}

describe("G6 urgency", () => {
  it("a miss over 1.5× the target sheds one rung per window once it has lasted two", () => {
    // Every frame a refresh late, a mean of 33.3 ms (2×), render() 20 ms: CPU-bound.
    const urgent = trace(createGovernorState(config), CPU_WORK_MAX_LEVEL + 3, () => frames(20, 1));
    expect(urgent.every((state) => state.urgent)).toBe(true);
    expect(urgent.map((state) => state.cpuWorkLevel)).toEqual([
      0,
      ...Array.from({ length: CPU_WORK_MAX_LEVEL }, (_, rung) => rung + 1),
      CPU_WORK_MAX_LEVEL,
      CPU_WORK_MAX_LEVEL,
    ]);
    expect(urgent.every((state) => state.gpuWorkLevel === 0 && state.renderScale === config.scaleCeiling)).toBe(true);
    // 40% late (a mean of 23.3 ms, 1.4×) is not urgent: a rung every second window, as before.
    const steady = trace(createGovernorState(config), 8, () => frames(20, 0.4));
    expect(steady.some((state) => state.urgent)).toBe(false);
    expect(steady.map((state) => state.cpuWorkLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });

  it("half the frames one refresh late is exactly 1.5× and not urgent; 61 of 120 is", () => {
    const at60 = trace(createGovernorState(config), 6, () => windowOf(intervals(60), 20));
    const at61 = trace(createGovernorState(config), 6, () => windowOf(intervals(61), 20));
    expect(windowOf(intervals(60), 20).intervalMeanMs).toBeCloseTo(1.5 * VSYNC_60, 9);
    expect(at60.some((state) => state.urgent)).toBe(false);
    expect(at60[5]!.cpuWorkLevel).toBe(3);
    expect(at61.every((state) => state.urgent)).toBe(true);
    expect(at61[5]!.cpuWorkLevel).toBe(5);
  });

  it("one urgent window followed by calm sheds nothing", () => {
    const states = trace(createGovernorState(config), 6, (window) => frames(20, window === 1 ? 1 : 0));
    expect(states[0]!.urgent).toBe(true);
    expect(states.every((state) => state.cpuWorkLevel === 0 && state.gpuWorkLevel === 0)).toBe(true);
    expect(states.every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
  });

  it("an urgent window that fails a trial only restores the trial's rung", () => {
    // Four calm windows bring GPU rung 3 back on trial; the fifth window is
    // every frame late, and fails it.
    const start = Object.freeze({ ...createGovernorState(config), gpuWorkLevel: 3 });
    const states = trace(start, 5, (window) => frames(5, window <= 4 ? 0 : 1));
    expect(states[3]!.gpuWorkLevel).toBe(2);
    expect(states[3]!.trial?.ladder).toBe("gpu");
    expect(states[4]).toMatchObject({ urgent: true, gpuWorkLevel: 3, cpuWorkLevel: 0, trial: null, spentWindows: 0 });
    expect(states[4]!.renderScale).toBe(config.scaleCeiling);
  });

  it("7% spikes of 40 ms (a mean of 18.4 ms) are never urgent or exhausted, with every GPU rung shed", () => {
    for (const seed of [987_654_321, 12_345, 424_242]) {
      const states = trace(createGovernorState(config), 300, spikes(seed, 0.07));
      const label = `seed ${seed}`;
      // Not vacuous: the GPU ladder tops out, so its windows are spent but for the mean.
      expect(states.some((state) => state.gpuWorkLevel === GPU_WORK_MAX_LEVEL), label).toBe(true);
      expect(states.some((state) => state.urgent), label).toBe(false);
      // A window with 17 or more spikes (a mean over 20 ms) counts on its
      // own, two to five of them in 300 windows; never two in a row.
      expect(Math.max(...states.map((state) => state.spentWindows)), label).toBeLessThanOrEqual(1);
      expect(states.some(governorExhausted), label).toBe(false);
    }
  });
});

describe("G6 exhausted", () => {
  it("a CPU-bound host is exhausted four windows after its CPU ladder is spent (red team M8)", () => {
    const states = trace(createGovernorState(config), 20, () => frames(22, 1));
    const spent = firstWindow(states, (state) => state.cpuWorkLevel === CPU_WORK_MAX_LEVEL);
    expect(spent).toBe(2 + (CPU_WORK_MAX_LEVEL - 1));
    expect(firstWindow(states, governorExhausted)).toBe(spent + EXHAUSTED_AFTER_WINDOWS);
    expect(states.slice(spent + EXHAUSTED_AFTER_WINDOWS - 1).every(governorExhausted)).toBe(true);
    expect(states.every((state) => state.gpuWorkLevel === 0)).toBe(true);
    expect(states.every((state) => state.renderScale === config.scaleCeiling)).toBe(true);
  });

  it("behind an absorbed step, a latch set at GPU level 0 is re-armed and set again before exhaustion", () => {
    // GPU-bound (render() 9 ms, every frame late): the first step changes
    // nothing and latches at level 0, then the GPU ladder is shed.
    const states = trace(createGovernorState(config), 50, () => frames(9, 1), { absorbed: true });
    const latched = firstWindow(states, (state) => state.resolutionInsensitive);
    expect(states[latched - 1]!.latchedAtGpuLevel).toBe(0);
    const topped = firstWindow(states, (state) => state.gpuWorkLevel === GPU_WORK_MAX_LEVEL);
    expect(topped).toBeGreaterThan(latched);
    // Topped out with a stale latch: re-armed, the scale is tried once more,
    // absorbed, and latched again at the top. Only then is the side spent.
    const fresh = firstWindow(states, (state) => state.latchedAtGpuLevel === GPU_WORK_MAX_LEVEL);
    expect(fresh).toBeGreaterThan(topped);
    expect(states.slice(topped - 1, fresh - 1).some((state) => !state.resolutionInsensitive)).toBe(true);
    expect(states.slice(0, fresh).every((state) => state.spentWindows === 0)).toBe(true);
    expect(firstWindow(states, governorExhausted)).toBe(fresh + EXHAUSTED_AFTER_WINDOWS);
    expect(states.slice(fresh + EXHAUSTED_AFTER_WINDOWS - 1).every(governorExhausted)).toBe(true);
  });

  it("fully shed and 10% late (a mean of 18.3 ms, 55 fps) is never exhausted", () => {
    const start = Object.freeze({
      ...createGovernorState(config),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      resolutionInsensitive: true,
      insensitiveWindowsRemaining: config.insensitiveRearmWindows,
      latchedAtGpuLevel: GPU_WORK_MAX_LEVEL,
    });
    const states = trace(start, 40, () => frames(9, 0.1), { absorbed: true });
    expect(states.every((state) => state.spentWindows === 0 && !state.urgent)).toBe(true);
  });

  it("an on-cadence window, a shed or a cadence rebase restarts the count", () => {
    const shed = Object.freeze({ ...createGovernorState(config), cpuWorkLevel: CPU_WORK_MAX_LEVEL });
    const states = trace(shed, 12, (window) => frames(22, window === 3 ? 0 : 1));
    expect(states.map((state) => state.spentWindows)).toEqual([1, 2, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(governorExhausted(states[11]!)).toBe(true);
    expect(rebaseGovernorState(states[11]!).spentWindows).toBe(0);
    // A GPU-bound window (render() 4 ms) has a resolution step left: a shed.
    const stepped = nextGovernorDecision(states[11]!, frames(4, 1), config);
    expect(stepped.renderScale).toBeLessThan(config.scaleCeiling);
    expect(stepped.spentWindows).toBe(0);
    // A probe (a re-armed step absorbed with every rung shed) holds the
    // count instead: render.governor-g4-floor replays it at 1366×768 on Low.
  });
});

describe("G6 against the display's own interval (product red team)", () => {
  /** A GPU-bound host (render() 6 ms) whose intervals are `slow` of 120 at `slowMs`, the rest at `onTimeMs`. */
  const host = (governorConfig: GovernorConfig, onTimeMs: number, slowFrames = 0, slowMs = 2 * onTimeMs) =>
    trace(createGovernorState(governorConfig), 60, () => windowOf(intervals(slowFrames, slowMs, onTimeMs), 6, governorConfig), {
      config: governorConfig,
    });

  it("a confirmed 30 Hz panel at the 60 fps setting still sheds everything, but is never urgent or exhausted", () => {
    const at30 = governorConfigForProfile(medium, cadence(60, 1, 30, true));
    expect(at30.displayLimitMs).toBeCloseTo(1_000 / 30, 9);
    // Part 1, unchanged: the target stays 16.67 ms and every 33.3 ms frame is late.
    expect(at30.presentationTargetMs).toBe(config.presentationTargetMs);
    const states = host(at30, 1_000 / 30);
    expect(states[59]!.gpuWorkLevel).toBe(GPU_WORK_MAX_LEVEL);
    expect(states.some((state) => state.urgent)).toBe(false);
    expect(states.every((state) => state.spentWindows === 0)).toBe(true);
    // Against the target alone the same windows would be urgent and exhausted.
    const unlimited = host(config, 1_000 / 30);
    expect(unlimited.every((state) => state.urgent)).toBe(true);
    expect(unlimited.some(governorExhausted)).toBe(true);
    // Above the display's own interval it is the machine: a mean of 45 ms
    // (42 frames of two refreshes) is over 1.2× 33.3, so spent and exhausted.
    const slower = host(at30, 1_000 / 30, 42);
    expect(windowOf(intervals(42, 2_000 / 30, 1_000 / 30), 6, at30).intervalMeanMs).toBeCloseTo(45, 9);
    expect(slower.some((state) => state.urgent)).toBe(false);
    expect(slower.some(governorExhausted)).toBe(true);
  });

  it("a confirmed 50 Hz panel is exhausted at a mean of 26 ms, never at its own 20 ms", () => {
    const at50 = governorConfigForProfile(medium, cadence(60, 1, 50, true));
    expect(at50.displayLimitMs).toBeCloseTo(20, 9);
    const own = host(at50, 20);
    expect(own[59]!.gpuWorkLevel).toBe(GPU_WORK_MAX_LEVEL);
    expect(own.every((state) => state.spentWindows === 0 && !state.urgent)).toBe(true);
    // 36 frames of two refreshes: a mean of 26 ms, over 24 and under 30.
    expect(windowOf(intervals(36, 40, 20), 6, at50).intervalMeanMs).toBeCloseTo(26, 9);
    const slower = host(at50, 20, 36);
    expect(slower.some((state) => state.urgent)).toBe(false);
    expect(slower.some(governorExhausted)).toBe(true);
  });

  it("an unconfirmed 30 Hz observation changes nothing", () => {
    const observed = governorConfigForProfile(medium, cadence(60, 1, 30, false));
    expect(observed.displayLimitMs).toBe(0);
    expect(observed).toEqual(config);
    const states = host(observed, 1_000 / 30);
    expect(states).toEqual(host(config, 1_000 / 30));
    expect(states.some(governorExhausted)).toBe(true);
  });
});

describe("G6 under a pinned capture", () => {
  it("leaves every trace above at the initial state", () => {
    const frozen = Object.freeze({ ...config, frozen: true });
    const hosts: readonly ((window: number) => GovernorSignals)[] = [
      () => frames(20, 1),
      () => windowOf(intervals(61), 20),
      () => frames(22, 1),
      () => frames(9, 1),
      () => frames(9, 0.1),
      (window) => frames(22, window === 3 ? 0 : 1),
      spikes(424_242, 0.07),
      () => windowOf(intervals(42, 2_000 / 30, 1_000 / 30), 6),
    ];
    for (const [index, signals] of hosts.entries()) {
      const initial = createGovernorState(frozen);
      const states = trace(initial, 40, signals, { config: frozen, absorbed: true });
      expect(states.every((state) => state === initial), `host ${index}`).toBe(true);
    }
  });
});
