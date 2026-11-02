import { describe, expect, it } from "vitest";
import { FramePacer, IDLE_PROBE_LEAD_TICKS } from "../src/game/framePacer";
import {
  CPU_WORK_MAX_LEVEL,
  EXHAUSTED_AFTER_WINDOWS,
  FALLBACK_OFF,
  GPU_WORK_MAX_LEVEL,
  cadenceFallbackRequest,
  createGovernorState,
  governorConfigForProfile,
  governorExhausted,
  nextGovernorDecision,
  observeRenderScaleApplication,
  rebaseGovernorState,
  sameGovernorTargets,
  summariseIntervals,
  type CadenceFallbackPhase,
  type CadenceFallbackRequest,
  type CadenceFallbackState,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import {
  fallbackDivisorFor,
  fallbackDivisorRange,
  sameCadence,
  type PresentationCadence,
} from "../src/render/webgpu/core/presentationCadence";
import { frameTimingPercentile95, resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { FrameRateSetting } from "../src/settings";

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

/**
 * PR B part 2b (K4, design §21.2): the even fallback's machine, window by
 * window. Tier 0 as it ships, with T0d's rate (30 Hz), on a confirmed 60 Hz
 * display under the 60 fps setting (`at60`), and on the same display while
 * the pacer draws the fallback, every 2nd refresh (`atFallback`: a 33.3 ms
 * target, late past 41.67 ms, 4 s windows).
 */
const t0 = resolveWebGpuQualityProfile("low", "balanced");
/** Tier 0 without a fallback rate: 0, as tiers 1-3 ship and tier 0 did before T0d. */
const t0NoFallback = Object.freeze({ ...t0, cadenceFallbackHz: 0 });
const at60 = governorConfigForProfile(t0, cadence(60, 1, 60, true));
const atFallback = governorConfigForProfile(t0, { ...cadence(60, 2, 60, true), fallbackHz: 30 });
/** Match display on the same display: no fallback allowed. */
const atDisplay = governorConfigForProfile(t0, { frameCapHz: null, divisor: 1, displayPeriodMs: VSYNC_60, periodConfirmed: true });
/** A confirmed 75 Hz display: the setting's cadence (every refresh), and the fallback at its faster divisor, 2 (37.5 fps). */
const VSYNC_75 = 1_000 / 75;
const at75 = governorConfigForProfile(t0, cadence(60, 1, 75, true));
const at75Fallback = governorConfigForProfile(t0, { ...cadence(60, 2, 75, true), fallbackHz: 37.5 });

/** A state with some of the fallback's fields replaced. */
function withFallback(state: GovernorState, fallback: Partial<CadenceFallbackState>): GovernorState {
  return Object.freeze({ ...state, fallback: Object.freeze({ ...state.fallback, ...fallback }) });
}

/** 120 frames of `ms` each, render() p95 `cpuP95Ms`, against `governorConfig`. */
function steady(ms: number, cpuP95Ms: number, governorConfig: GovernorConfig): GovernorSignals {
  return windowOf(Array.from({ length: 120 }, () => ms), cpuP95Ms, governorConfig);
}

describe("G6 even fallback: the machine (PR B part 2b, K4)", () => {
  it("engages in the window that makes the governor exhausted, with that window's mean as the shortest interval", () => {
    expect(t0.cadenceFallbackHz).toBe(30);
    expect(at60.cadenceFallbackHz).toBe(30);
    // CPU-bound (render() 22 ms, every frame a refresh late): spent once its ladder is.
    const states = trace(createGovernorState(at60), 20, () => steady(2 * VSYNC_60, 22, at60), { config: at60 });
    const exhausted = firstWindow(states, governorExhausted);
    expect(exhausted).toBe(1 + CPU_WORK_MAX_LEVEL + EXHAUSTED_AFTER_WINDOWS);
    expect(firstWindow(states, (state) => state.fallback.phase !== "off")).toBe(exhausted);
    const engaged = states[exhausted - 1]!;
    expect(engaged.fallback).toMatchObject({
      phase: "engaged",
      trialDueInMs: 60_000,
      trialFrom: "engaged",
      trialLates: [],
      failedTrials: 0,
      msSinceExit: null,
    });
    expect(engaged.fallback.minIntervalMs).toBeCloseTo(2 * VSYNC_60, 9);
    expect(cadenceFallbackRequest(engaged, at60)).toEqual({ hz: 30, minIntervalMs: engaged.fallback.minIntervalMs });
    // A rate of 0 (tier 0 before T0d): just as exhausted, and nothing asked.
    const noRate = governorConfigForProfile(t0NoFallback, cadence(60, 1, 60, true));
    const plain = trace(createGovernorState(noRate), 20, () => steady(2 * VSYNC_60, 22, noRate), { config: noRate });
    expect(firstWindow(plain, governorExhausted)).toBe(exhausted);
    expect(plain.every((state) => state.fallback === FALLBACK_OFF && cadenceFallbackRequest(state, noRate) === null)).toBe(true);
  });

  it("does not engage while a resolution step waits for its verdict", () => {
    // Every GPU rung shed, the scale free, GPU-bound (render() 9 ms): resolution
    // is stepped twice, which holds the spent count at 4, then latched.
    const start = Object.freeze({
      ...createGovernorState(at60),
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      offCadenceWindows: 2,
      spentWindows: EXHAUSTED_AFTER_WINDOWS,
    });
    const states = trace(start, 3, () => steady(2 * VSYNC_60, 9, at60), { config: at60 });
    for (const state of states.slice(0, 2)) {
      expect(state.pendingProbe).not.toBeNull();
      expect(governorExhausted(state)).toBe(true);
      expect(state.fallback).toBe(FALLBACK_OFF);
    }
    // The second verdict latches and restores the scale; the window is spent, and engages.
    expect(states[2]).toMatchObject({ pendingProbe: null, resolutionInsensitive: true, renderScale: at60.scaleCeiling });
    expect(states[2]!.fallback.phase).toBe("engaged");
  });

  it("fails a trial on an off-cadence window: clearly (under 50 fps) settles at once, otherwise at the second failure", () => {
    const trial = (failedTrials: number, trialFrom: "engaged" | "settled"): GovernorState => withFallback(
      Object.freeze({ ...createGovernorState(at60), gpuWorkLevel: GPU_WORK_MAX_LEVEL }),
      { phase: "trial", trialFrom, failedTrials },
    );
    // 12 of 120 frames a refresh late: a mean of 18.3 ms (55 fps). 30 of them: 20.8 ms (48 fps).
    const narrow = windowOf(intervals(12), 5, at60);
    const clear = windowOf(intervals(30), 5, at60);
    expect(narrow.intervalMeanMs!).toBeLessThan(1.2 * VSYNC_60);
    expect(clear.intervalMeanMs!).toBeGreaterThan(1.2 * VSYNC_60);
    const cases: readonly [GovernorState, GovernorSignals, Partial<CadenceFallbackState>][] = [
      [trial(0, "engaged"), narrow, { phase: "engaged", failedTrials: 1, trialDueInMs: 120_000, trialFrom: "engaged" }],
      [trial(1, "engaged"), narrow, { phase: "settled", failedTrials: 2, trialDueInMs: 300_000, trialFrom: "settled" }],
      [trial(0, "settled"), narrow, { phase: "settled", failedTrials: 1, trialDueInMs: 300_000, trialFrom: "settled" }],
      [trial(0, "engaged"), clear, { phase: "settled", failedTrials: 1, trialDueInMs: 300_000, trialFrom: "settled" }],
    ];
    for (const [index, [state, signals, expected]] of cases.entries()) {
      const next = nextGovernorDecision(state, signals, at60);
      expect(next.fallback, `case ${index}`).toMatchObject({ ...expected, trialLates: [], msSinceExit: null });
      // Judged, never acted on.
      expect(next, `case ${index}`).toMatchObject({ mode: "fallback-trial", gpuWorkLevel: GPU_WORK_MAX_LEVEL, cpuWorkLevel: 0 });
      expect(next.renderScale).toBe(at60.scaleCeiling);
    }
  });

  it("passes a trial on two calm on-cadence windows, and judges one more when two are on cadence but not calm", () => {
    const trial = withFallback(
      Object.freeze({ ...createGovernorState(at60), gpuWorkLevel: GPU_WORK_MAX_LEVEL }),
      { phase: "trial", failedTrials: 1 },
    );
    // 5 of 120 frames late (4.2%: on cadence, not calm) twice, then none: pooled 4.2%, then 2.1%.
    const late = [5, 5, 0];
    const states = trace(trial, 3, (window) => windowOf(intervals(late[window - 1]!), 5, at60), { config: at60 });
    expect(states.map((state) => state.fallback.phase)).toEqual(["trial", "trial", "off"]);
    expect(states.every((state) => state.mode === "fallback-trial")).toBe(true);
    expect(states[1]!.fallback.trialLates).toHaveLength(1);
    expect(states[2]!.fallback).toEqual({ ...FALLBACK_OFF, failedTrials: 1, msSinceExit: 0 });
    expect(states[2]).toMatchObject({ spentWindows: 0, calmStreak: [], gpuWorkLevel: GPU_WORK_MAX_LEVEL });
    expect(states.every((state) => cadenceFallbackRequest(state, at60) === null)).toBe(true);
  });

  it("counts an engage within 60 s of a passed trial as a failed trial, and settles at two", () => {
    const spent = Object.freeze({
      ...createGovernorState(at60),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      spentWindows: EXHAUSTED_AFTER_WINDOWS - 1,
    });
    const engage = (fallback: Partial<CadenceFallbackState>): CadenceFallbackState =>
      nextGovernorDecision(withFallback(spent, fallback), steady(2 * VSYNC_60, 22, at60), at60).fallback;
    // The exit clock runs first: 57 s reads 59 s when the engage is judged.
    expect(engage({ msSinceExit: 57_000 })).toMatchObject({ phase: "engaged", failedTrials: 1, trialDueInMs: 120_000, msSinceExit: null });
    expect(engage({ msSinceExit: 57_000, failedTrials: 1 })).toMatchObject({ phase: "settled", failedTrials: 2, trialDueInMs: 300_000 });
    // 61 s after the exit it is a new engage: the first wait, 60 s.
    expect(engage({ msSinceExit: 59_000 })).toMatchObject({ phase: "engaged", failedTrials: 0, trialDueInMs: 60_000 });
    // Two failed trials kept from before (the setting toggled away and back): straight to settled.
    expect(engage({ failedTrials: 2 })).toMatchObject({ phase: "settled", failedTrials: 2, trialFrom: "settled" });
  });

  it("returns to off where no fallback is allowed, resetting the trial's clocks but keeping the failed trials", () => {
    expect(atDisplay.cadenceFallbackHz).toBeNull();
    for (const phase of ["engaged", "trial", "settled"] as const) {
      const on = withFallback(createGovernorState(at60), {
        phase,
        trialDueInMs: 30_000,
        trialFrom: phase === "settled" ? "settled" : "engaged",
        trialLates: [0],
        failedTrials: 2,
        minIntervalMs: 2 * VSYNC_60,
      });
      // The request stops at once; the phase follows at the next judged window.
      expect(cadenceFallbackRequest(on, atDisplay), phase).toBeNull();
      const next = nextGovernorDecision(on, steady(VSYNC_60, 5, atDisplay), atDisplay);
      expect(next.fallback, phase).toEqual({ ...FALLBACK_OFF, failedTrials: 2 });
    }
  });

  it("forgives the failed trials 240 s after a passed trial, under any setting", () => {
    for (const governorConfig of [at60, atDisplay]) {
      const exited = withFallback(createGovernorState(governorConfig), { failedTrials: 2, msSinceExit: 0 });
      const states = trace(exited, 130, () => steady(VSYNC_60, 5, governorConfig), { config: governorConfig });
      // 120 windows of 2 s, give or take a window to float noise.
      const forgiven = firstWindow(states, (state) => state.fallback.failedTrials === 0);
      expect(Math.abs(forgiven - 120)).toBeLessThanOrEqual(1);
      expect(states.slice(0, forgiven - 1).every((state) => state.fallback.failedTrials === 2)).toBe(true);
      expect(states[forgiven - 1]!.fallback).toEqual(FALLBACK_OFF);
    }
  });

  it("settled, starts a trial only from full quality with a calm streak, and only once 300 s have passed", () => {
    const settled = { phase: "settled", trialFrom: "settled", failedTrials: 2, minIntervalMs: 2 * VSYNC_60 } as const;
    const onCadence = (): GovernorSignals => steady(2 * VSYNC_60, 5, atFallback);
    // Due, but a GPU rung short: four calm windows bring it back on trial
    // (window 4), two more pass that (6), and the trial waits for a calm
    // streak of four again, which the rung's recovery cleared (8).
    const short = withFallback(Object.freeze({ ...createGovernorState(atFallback), gpuWorkLevel: 1 }), { ...settled, trialDueInMs: 0 });
    const states = trace(short, 10, onCadence, { config: atFallback });
    expect(firstWindow(states, (state) => state.gpuWorkLevel === 0)).toBe(4);
    expect(firstWindow(states, (state) => state.trial === null && state.gpuWorkLevel === 0)).toBe(6);
    expect(firstWindow(states, (state) => state.fallback.phase === "trial")).toBe(8);
    expect(states[7]!.mode).toBe("fallback-trial");
    expect(states.slice(0, 7).every((state) => state.fallback.phase === "settled")).toBe(true);
    // At full quality, the wait: 300 s of 4 s windows.
    const waiting = withFallback(createGovernorState(atFallback), { ...settled, trialDueInMs: 300_000 });
    const started = firstWindow(trace(waiting, 80, onCadence, { config: atFallback }), (state) => state.fallback.phase === "trial");
    expect(Math.abs(started - 75)).toBeLessThanOrEqual(1);
  });

  it("settled, starts no trial with the CPU rung, a scale step or a streaming recovery trial still out", () => {
    const settled = { phase: "settled", trialFrom: "settled", failedTrials: 2, minIntervalMs: 2 * VSYNC_60, trialDueInMs: 0 } as const;
    const full = createGovernorState(atFallback);
    const trialStarts = (states: readonly GovernorState[]): number => firstWindow(states, (state) => state.fallback.phase === "trial");
    // Each start below is due, and every window is calm on the fallback's cadence.
    // CPU one rung short, and render() over the CPU recovery ceiling, so it never comes back: never a trial.
    const cpuShort = withFallback(Object.freeze({ ...full, cpuWorkLevel: 1 }), settled);
    const blocked = trace(cpuShort, 16, () => steady(2 * VSYNC_60, atFallback.cpuRecoveryCeilingMs + 2, atFallback), { config: atFallback });
    expect(blocked.every((state) => state.fallback.phase === "settled" && state.cpuWorkLevel === 1)).toBe(true);
    // The same rung where it can come back: the trial waits for it.
    const recovering = trace(cpuShort, 16, () => steady(2 * VSYNC_60, 5, atFallback), { config: atFallback });
    const cpuBack = firstWindow(recovering, (state) => state.cpuWorkLevel === 0 && state.trial === null);
    expect(cpuBack).toBeGreaterThan(0);
    expect(trialStarts(recovering)).toBeGreaterThanOrEqual(cpuBack);
    // One recovery step below the scale ceiling: no trial until the scale is back at it.
    const scaleShort = withFallback(Object.freeze({ ...full, renderScale: atFallback.scaleCeiling - 0.025 }), settled);
    const rescaled = trace(scaleShort, 16, () => steady(2 * VSYNC_60, 5, atFallback), { config: atFallback });
    const scaleBack = firstWindow(rescaled, (state) => state.renderScale >= atFallback.scaleCeiling - 1e-6 && state.trial === null);
    expect(scaleBack).toBeGreaterThan(0);
    expect(trialStarts(rescaled)).toBeGreaterThanOrEqual(scaleBack);
    // Full quality, but a streaming recovery trial (a CPU rung back) still open while its backlog grows.
    const streaming = withFallback(Object.freeze({
      ...full,
      trial: Object.freeze({
        ladder: "cpu" as const,
        restoreLevel: 1,
        restoreScale: full.renderScale,
        windowsPassed: 0,
        streaming: true,
        openBacklog: 10,
        lastBacklog: 10,
      }),
    }), settled);
    const open = trace(streaming, 10, (window) => ({ ...steady(2 * VSYNC_60, 5, atFallback), streamingBacklog: 10 + window }), { config: atFallback });
    expect(open[2]!.trial).not.toBeNull();
    expect(trialStarts(open)).toBeGreaterThan(0);
    expect(open.every((state) => state.fallback.phase !== "trial" || state.trial === null)).toBe(true);
    for (const states of [recovering, rescaled, open]) {
      const started = states[trialStarts(states) - 1]!;
      expect(started).toMatchObject({ cpuWorkLevel: 0, gpuWorkLevel: 0, trial: null });
      expect(started.renderScale).toBeGreaterThanOrEqual(atFallback.scaleCeiling - 1e-6);
    }
  });

  it("engages with the engaging window's mean interval, not its p95", () => {
    // 72 of 120 frames two refreshes: a mean of 26.67 ms, a p95 of 33.3 ms.
    const spent = Object.freeze({
      ...createGovernorState(at60),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      spentWindows: EXHAUSTED_AFTER_WINDOWS - 1,
    });
    const window = windowOf(intervals(72), 22, at60);
    expect(window.intervalMeanMs!).toBeCloseTo(1.6 * VSYNC_60, 9);
    expect(window.intervalP95Ms!).toBeCloseTo(2 * VSYNC_60, 9);
    const engaged = nextGovernorDecision(spent, window, at60);
    expect(engaged.fallback.phase).toBe("engaged");
    expect(engaged.fallback.minIntervalMs).toBeCloseTo(window.intervalMeanMs!, 9);
  });

  it("a failed trial takes its window's mean as the shortest interval, so a raise from a stall does not outlast it", () => {
    // Engaged at 75 Hz after an 8 s stall raised the shortest interval to 37.2 ms (divisor 3, 25 fps).
    const raised = withFallback(
      Object.freeze({ ...createGovernorState(at75), gpuWorkLevel: GPU_WORK_MAX_LEVEL }),
      { phase: "trial", trialFrom: "engaged", minIntervalMs: 37.2 },
    );
    const range = fallbackDivisorRange(75, 30, 1)!;
    expect(fallbackDivisorFor(range, VSYNC_75, raised.fallback.minIntervalMs)).toBe(3);
    // The trial at the setting's cadence: every frame two refreshes, 26.67 ms. Clearly failed: settled.
    const failed = nextGovernorDecision(raised, steady(2 * VSYNC_75, 5, at75), at75);
    expect(failed.fallback).toMatchObject({ phase: "settled", failedTrials: 1 });
    expect(failed.fallback.minIntervalMs).toBeCloseTo(2 * VSYNC_75, 9);
    expect(fallbackDivisorFor(range, VSYNC_75, cadenceFallbackRequest(failed, at75)!.minIntervalMs)).toBe(2);
    // A narrow failure at 60 Hz goes back to engaged with that window's mean too.
    const narrow = windowOf(intervals(12), 5, at60);
    const back = nextGovernorDecision(
      withFallback(createGovernorState(at60), { phase: "trial", minIntervalMs: 2.6 * VSYNC_60 }),
      narrow,
      at60,
    );
    expect(back.fallback.phase).toBe("engaged");
    expect(back.fallback.minIntervalMs).toBeCloseTo(narrow.intervalMeanMs!, 9);
  });

  it("a failed trial moves to a faster divisor only if it shows the host calm there; the same or a slower one takes its mean", () => {
    // The setting's cadence carries what the pacer chooses from: the period and [2, 3] at 75 Hz.
    expect(at75.fallbackPeriodMs).toBeCloseTo(VSYNC_75, 9);
    expect(at75.fallbackDivisors).toEqual([2, 3]);
    const range = at75.fallbackDivisors!;
    // A trial from divisor 3 (25 fps), where an engage or a raise left 2.4 refreshes.
    const fromThree = withFallback(
      Object.freeze({ ...createGovernorState(at75), gpuWorkLevel: GPU_WORK_MAX_LEVEL }),
      { phase: "trial", trialFrom: "engaged", minIntervalMs: 2.4 * VSYNC_75 },
    );
    // 120 frames at the setting's cadence: `ones` of one refresh, then `threes` of three, the rest two.
    const window = (ones: number, threes: number, governorConfig: GovernorConfig = at75): GovernorSignals => windowOf(
      Array.from({ length: 120 }, (_, frame) => (frame < ones ? 1 : frame < ones + threes ? 3 : 2) * VSYNC_75),
      5,
      governorConfig,
    );
    const after = (trial: GovernorState, signals: GovernorSignals, governorConfig: GovernorConfig = at75): number => {
      const failed = nextGovernorDecision(trial, signals, governorConfig);
      expect(failed.fallback.phase).toBe("settled");
      return failed.fallback.minIntervalMs;
    };
    const divisorOf = (minIntervalMs: number): number => fallbackDivisorFor(range, VSYNC_75, minIntervalMs);
    // Every frame two refreshes: calm at 2, which the mean chooses.
    expect(after(fromThree, window(0, 0))).toBeCloseTo(2 * VSYNC_75, 9);
    // 5 of 120 three refreshes (a mean of 2.042): it fits 2 (within 0.05 of a
    // refresh), but not calmly (0.025), so the interval stays on 3.
    expect(divisorOf(window(0, 5).intervalMeanMs!)).toBe(2);
    expect(after(fromThree, window(0, 5))).toBe(2.4 * VSYNC_75);
    // 3 of 120 (2.025) is calm.
    expect(after(fromThree, window(0, 3))).toBeCloseTo(2.025 * VSYNC_75, 9);
    // 12 frames of one refresh pull the mean under 2 (1.958) while 7 of 120
    // still take three: its p95 is late at 2, so the interval stays on 3.
    // With 6 of 120 (5%), the p95 is two refreshes, and it moves to 2.
    expect(window(12, 7).intervalMeanMs! / VSYNC_75).toBeCloseTo(1.958, 3);
    expect(window(12, 7).intervalP95Ms).toBeCloseTo(3 * VSYNC_75, 9);
    expect(after(fromThree, window(12, 7))).toBe(2.4 * VSYNC_75);
    expect(window(12, 6).intervalP95Ms).toBeCloseTo(2 * VSYNC_75, 9);
    expect(after(fromThree, window(12, 6))).toBeCloseTo(1.95 * VSYNC_75, 9);
    // The same divisor takes the mean: 72 of 120 three refreshes (2.6) from 2.4.
    expect(after(fromThree, window(0, 72))).toBeCloseTo(2.6 * VSYNC_75, 9);
    // A slower one too, at once: 48 of 120 (2.4) from divisor 2's two refreshes.
    const fromTwo = withFallback(fromThree, { minIntervalMs: 2 * VSYNC_75 });
    expect(divisorOf(after(fromTwo, window(0, 48)))).toBe(3);
    // Without the divisors to choose from, the mean replaces it.
    const blind = Object.freeze({ ...at75, fallbackDivisors: null });
    expect(after(fromThree, window(0, 5, blind), blind)).toBeCloseTo(window(0, 5).intervalMeanMs!, 9);
  });

  it("passes a trial whose four judged windows were all on cadence, though never calm in a pair", () => {
    // 5 of 120 frames late (4.2%) every window, or 4 and 5 in turn: on cadence, never a calm pool.
    for (const [label, lates] of [["4.2% each", [5, 5, 5, 5]], ["3.3% and 4.2%", [4, 5, 4, 5]]] as const) {
      for (const trialFrom of ["engaged", "settled"] as const) {
        const trial = withFallback(
          Object.freeze({ ...createGovernorState(at60), gpuWorkLevel: trialFrom === "engaged" ? GPU_WORK_MAX_LEVEL : 0 }),
          { phase: "trial", trialFrom, failedTrials: 1 },
        );
        const states = trace(trial, 4, (window) => windowOf(intervals(lates[window - 1]!), 5, at60), { config: at60 });
        const name = `${label}, from ${trialFrom}`;
        expect(states.map((state) => state.fallback.phase), name).toEqual(["trial", "trial", "trial", "off"]);
        expect(states.every((state) => state.mode === "fallback-trial"), name).toBe(true);
        expect(states.slice(0, 3).every(governorExhausted), name).toBe(true);
        expect(states[3]!.fallback, name).toEqual({ ...FALLBACK_OFF, failedTrials: 1, msSinceExit: 0 });
        expect(governorExhausted(states[3]!), name).toBe(false);
        expect(cadenceFallbackRequest(states[3]!, at60), name).toBeNull();
      }
    }
    // An off-cadence window still fails it, the third included.
    const trial = withFallback(createGovernorState(at60), { phase: "trial", trialFrom: "engaged" });
    const lates = [5, 5, 12];
    const failed = trace(trial, 3, (window) => windowOf(intervals(lates[window - 1]!), 5, at60), { config: at60 });
    expect(failed.map((state) => state.fallback.phase)).toEqual(["trial", "trial", "engaged"]);
  });

  it("asks for the slower divisor after two off-cadence windows in a row that move no lever, engaged or settled", () => {
    // At 75 Hz on divisor 2 (26.67 ms), every frame three refreshes (40 ms): it cannot hold 2.
    const unheld = (): GovernorSignals => steady(3 * VSYNC_75, 5, at75Fallback);
    const range = fallbackDivisorRange(75, 30, 1)!;
    for (const phase of ["engaged", "settled"] as const) {
      const base = Object.freeze({
        ...createGovernorState(at75Fallback),
        cpuWorkLevel: CPU_WORK_MAX_LEVEL,
        gpuWorkLevel: GPU_WORK_MAX_LEVEL,
        renderScale: at75Fallback.scaleFloor,
      });
      const fallback = { phase, trialFrom: phase, trialDueInMs: 300_000, minIntervalMs: 2 * VSYNC_75 } as const;
      // Nothing left to shed: spent, then spent and raised.
      const spent = trace(withFallback(base, fallback), 2, unheld, { config: at75Fallback });
      expect(spent.map((state) => state.unheldWindows), phase).toEqual([1, 2]);
      expect(spent[0]!.fallback.minIntervalMs, phase).toBeCloseTo(2 * VSYNC_75, 9);
      expect(spent[1]!.fallback.minIntervalMs, phase).toBeCloseTo(3 * VSYNC_75, 9);
      expect(fallbackDivisorFor(range, VSYNC_75, cadenceFallbackRequest(spent[1]!, at75Fallback)!.minIntervalMs), phase).toBe(3);
      // A GPU rung left: the second window sheds it and starts the count again,
      // so the raise comes two windows after the shed, never with it.
      const rung = trace(withFallback({ ...base, gpuWorkLevel: GPU_WORK_MAX_LEVEL - 1 }, fallback), 4, unheld, { config: at75Fallback });
      expect(rung.map((state) => state.gpuWorkLevel), phase).toEqual([GPU_WORK_MAX_LEVEL - 1, ...Array(3).fill(GPU_WORK_MAX_LEVEL)]);
      expect(rung.map((state) => state.unheldWindows), phase).toEqual([1, 0, 1, 2]);
      expect(rung.slice(0, 3).every((state) => Math.abs(state.fallback.minIntervalMs - 2 * VSYNC_75) < 1e-9), phase).toBe(true);
      expect(rung[3]!.fallback.minIntervalMs, phase).toBeCloseTo(3 * VSYNC_75, 9);
      // An on-cadence window between two off-cadence ones restarts the count.
      const broken = trace(withFallback(base, fallback), 3, (window) => (window === 2 ? steady(2 * VSYNC_75, 5, at75Fallback) : unheld()), { config: at75Fallback });
      expect(broken.map((state) => state.unheldWindows), phase).toEqual([1, 0, 1]);
      expect(broken.every((state) => Math.abs(state.fallback.minIntervalMs - 2 * VSYNC_75) < 1e-9), phase).toBe(true);
    }
  });
});

/**
 * PR B part 2b (K4, design §21.10): the even fallback closed through the
 * real FramePacer, as FlightGame closes it. Each tick hands the pacer the
 * governor's last request. A drawn tick hands the renderer the pacer's new
 * cadence first: the config follows it, and a move of the targets rebases
 * the state (at most once a window) and restarts the window. Then the frame
 * is drawn, and the request is read after it. The display ticks at a fixed
 * rate with ±0.3 ms of stamp jitter, the startup probe's quiet lead confirms
 * its period, and a drawn frame that costs more than a refresh pushes the
 * next tick to the vsync after it.
 *
 * A machine is render() and GPU time at full quality and the scale ceiling,
 * which the ladders cut by up to `cpuSave` and `gpuSave` at their tops and
 * the scale by its pixels' share of the GPU time, with noise of `jitter`.
 * No step is absorbed (a display large enough for every step). The governor
 * sees what shipping gameplay sees: no GPU timestamps, presented intervals on
 * whole refreshes. The prototype's seconds were simulated with placeholder
 * ladders, so these tests assert phase sequences and bounds, not seconds.
 */
interface Machine {
  /** render() ms at full quality, by flight time in seconds and the fallback's phase. */
  readonly cpuMs: (tS: number, phase: CadenceFallbackPhase) => number;
  /** GPU ms at full quality and the scale ceiling, likewise. */
  readonly gpuMs: (tS: number, phase: CadenceFallbackPhase) => number;
  /** The share of each that its ladder saves at the top. */
  readonly cpuSave: number;
  readonly gpuSave: number;
  /** The share of GPU time that follows the pixels. */
  readonly pixelShare: number;
  readonly jitter: number;
}

interface FlyOptions {
  readonly seconds: number;
  readonly hz?: number;
  readonly setting?: (tS: number) => FrameRateSetting;
  readonly profile?: Parameters<typeof governorConfigForProfile>[0];
  /** Paused from the first time to the second: the governor held, the pacer re-probing. */
  readonly pausedS?: readonly [number, number];
  readonly seed?: number;
  /** The startup probe's quiet lead, which confirms the display period (on by default). */
  readonly probe?: boolean;
  /** False: never hand the renderer a cadence, as the capture harnesses never do. */
  readonly paced?: boolean;
}

interface LoopWindow {
  readonly tS: number;
  readonly state: GovernorState;
  /** The config, and the cadence, the window was judged under. */
  readonly config: GovernorConfig;
  readonly cadence: PresentationCadence | null;
  readonly signals: GovernorSignals;
}

interface Loop {
  readonly windows: readonly LoopWindow[];
  /** Each change of the fallback's phase, at the window that made it. */
  readonly phases: readonly { readonly tS: number; readonly phase: CadenceFallbackPhase; readonly failedTrials: number }[];
  /** Each cadence that moved into or out of the fallback, or between its divisors. */
  readonly switches: readonly { readonly tS: number; readonly cadence: PresentationCadence }[];
  /** The state either side of each rebase. */
  readonly rebases: readonly { readonly tS: number; readonly before: GovernorState; readonly after: GovernorState }[];
  /** Ticks on which the pacer was handed a request. */
  readonly requested: number;
}

function fly(machine: Machine, options: FlyOptions): Loop {
  const hz = options.hz ?? 60;
  const periodMs = 1_000 / hz;
  const profile = options.profile ?? t0;
  let seed = (options.seed ?? 12_345) >>> 0;
  const random = (): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed / 4_294_967_296;
  };
  // The sum of four uniforms, scaled to unit variance.
  const noise = (): number => (random() + random() + random() + random() - 2) / Math.sqrt(1 / 3);
  const stamp = (tick: number): number => Math.sin(tick * 7.1) * 0.3;
  const pacer = new FramePacer({ pace60: true });
  let vsync = 1_000;
  let tick = 0;
  if (options.probe ?? true) {
    for (let lead = 0; lead < IDLE_PROBE_LEAD_TICKS; lead += 1) {
      pacer.probe(vsync + stamp(tick), true);
      tick += 1;
      vsync += periodMs;
    }
  }
  const start = vsync;
  let cadence: PresentationCadence | null = null;
  let pending: PresentationCadence | null = null;
  let config = governorConfigForProfile(profile, null);
  let state = createGovernorState(config);
  let request: CadenceFallbackRequest | null = null;
  let held = false;
  let rebasedThisWindow = false;
  let lastDrawnMs: number | null = null;
  let intervals: number[] = [];
  let cpus: number[] = [];
  let requested = 0;
  const windows: LoopWindow[] = [];
  const phases: { tS: number; phase: CadenceFallbackPhase; failedTrials: number }[] = [];
  const switches: { tS: number; cadence: PresentationCadence }[] = [];
  const rebases: { tS: number; before: GovernorState; after: GovernorState }[] = [];
  // FlightRenderer.setPresentationCadence.
  const present = (next: PresentationCadence, tS: number): void => {
    if (sameCadence(next, cadence)) return;
    if (cadence !== null && (cadence.divisor !== next.divisor || cadence.fallbackHz !== next.fallbackHz)) {
      switches.push({ tS, cadence: next });
    }
    cadence = next;
    const nextConfig = governorConfigForProfile(profile, next);
    const moved = !sameGovernorTargets(nextConfig, config);
    config = nextConfig;
    if (!moved || rebasedThisWindow) return;
    const before = state;
    state = rebaseGovernorState(state);
    rebases.push({ tS, before, after: state });
    intervals = [];
    cpus = [];
    rebasedThisWindow = true;
  };
  while (vsync - start < options.seconds * 1_000) {
    const tS = (vsync - start) / 1_000;
    const now = vsync + stamp(tick);
    tick += 1;
    const paused = options.pausedS !== undefined && tS >= options.pausedS[0] && tS < options.pausedS[1];
    if (request !== null) requested += 1;
    const paced = pacer.tick(now, options.setting?.(tS) ?? "60", paused, request);
    if (paced.cadence !== null) pending = paced.cadence;
    if (!paced.render) {
      vsync += periodMs;
      continue;
    }
    // FlightGame's frame, then FlightRenderer.render's governor window.
    if (paused !== held) {
      held = paused;
      intervals = [];
      cpus = [];
    }
    if (paced.afterReprobe) lastDrawnMs = null;
    if (pending !== null && (options.paced ?? true)) present(pending, tS);
    pending = null;
    const phase = state.fallback.phase;
    const pixels = machine.pixelShare * (state.renderScale / config.scaleCeiling) ** 2 + (1 - machine.pixelShare);
    const cpuMs = machine.cpuMs(tS, phase) * (1 - (machine.cpuSave * state.cpuWorkLevel) / CPU_WORK_MAX_LEVEL)
      * (1 + machine.jitter * noise());
    const gpuMs = machine.gpuMs(tS, phase) * (1 - (machine.gpuSave * state.gpuWorkLevel) / GPU_WORK_MAX_LEVEL)
      * pixels * (1 + machine.jitter * noise());
    if (lastDrawnMs !== null && !held) {
      intervals.push(Math.min(100, Math.max(1_000 / 240, now - lastDrawnMs)));
      cpus.push(cpuMs);
    }
    lastDrawnMs = now;
    if (intervals.length >= config.windowFrames) {
      const { mean, late } = summariseIntervals(intervals, config.lateIntervalMs);
      const signals: GovernorSignals = {
        gpuP95Ms: null,
        cpuP95Ms: frameTimingPercentile95(cpus),
        intervalP95Ms: frameTimingPercentile95(intervals),
        intervalMeanMs: mean,
        lateFraction: late,
        streamingBacklog: 0,
      };
      intervals = [];
      cpus = [];
      rebasedThisWindow = false;
      const previous = state;
      state = nextGovernorDecision(state, signals, config);
      windows.push({ tS, state, config, cadence, signals });
      if (state.fallback.phase !== previous.fallback.phase) {
        phases.push({ tS, phase: state.fallback.phase, failedTrials: state.fallback.failedTrials });
      }
    }
    request = cadenceFallbackRequest(state, config);
    vsync += Math.max(1, Math.ceil((Math.max(cpuMs, gpuMs) + 0.3) / periodMs - 1e-9)) * periodMs;
  }
  return { windows, phases, switches, rebases, requested };
}

const flat = (ms: number) => (): number => ms;
/**
 * UHD 620-shaped: GPU-bound, 50 ms a frame at full quality and about 23 ms
 * with everything shed, so it never holds 60 and always holds 30.
 */
const uhd620: Machine = { cpuMs: flat(10), gpuMs: flat(50), cpuSave: 0.3, gpuSave: 0.3, pixelShare: 0.85, jitter: 0.08 };
/**
 * Exhausted by a heavy first two minutes, then near 55 fps fully shed (GPU
 * 32 ms at full quality, 14.8 ms shed): off cadence at 60, but not clearly.
 */
const narrow: Machine = { ...uhd620, gpuMs: (tS) => (tS < 120 ? 50 : 32) };
/** A frame of `ms` whatever the governor sheds. */
const fixed = (ms: number): Machine => ({ cpuMs: flat(5), gpuMs: flat(ms), cpuSave: 0, gpuSave: 0, pixelShare: 0, jitter: 0.05 });

/** The phases a loop went through, from off. */
function sequence(loop: Loop): CadenceFallbackPhase[] {
  return ["off", ...loop.phases.map(({ phase }) => phase)];
}

/** When the loop entered `phase`, at or after `fromS`. */
function entered(loop: Loop, phase: CadenceFallbackPhase, fromS = 0): number {
  const change = loop.phases.find((candidate) => candidate.phase === phase && candidate.tS >= fromS);
  expect(change, `${phase} after ${fromS} s`).toBeDefined();
  return change!.tS;
}

/**
 * Design §21.4: every rebase keeps the fallback's phase, clocks and shortest
 * interval and clears only the trial's windows, and a host on the fallback
 * stays exhausted through it, though it zeroes the spent count.
 */
function expectRebasesKeepTheFallback(loop: Loop): void {
  for (const { tS, before, after } of loop.rebases) {
    expect(after.fallback, `rebase at ${tS} s`).toEqual({ ...before.fallback, trialLates: [] });
    expect(after.spentWindows).toBe(0);
    if (before.fallback.phase !== "off") expect(governorExhausted(after), `rebase at ${tS} s`).toBe(true);
  }
}

/** The windows judged wholly in `phase`: the window before it ended there too. */
function judgedIn(loop: Loop, phase: CadenceFallbackPhase): LoopWindow[] {
  return loop.windows.filter((_window, index) => index > 0 && loop.windows[index - 1]!.state.fallback.phase === phase);
}

describe("G6 even fallback: closed loop through the real FramePacer (PR B part 2b, K4)", () => {
  it("a UHD 620-shaped host engages, settles at once when its first trial fails clearly, and recovers at 30", () => {
    const loop = fly(uhd620, { seconds: 400 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "settled"]);
    const engagedAt = entered(loop, "engaged");
    const trialAt = entered(loop, "trial");
    const settledAt = entered(loop, "settled");
    // The trial about 60 s after engaging; settled by the trial's first window, within about 70 s.
    expect(trialAt - engagedAt).toBeGreaterThanOrEqual(56);
    expect(trialAt - engagedAt).toBeLessThanOrEqual(70);
    expect(settledAt - engagedAt).toBeLessThanOrEqual(75);
    expect(loop.phases.at(-1)!.failedTrials).toBe(1);
    // Engaged and settled, the pacer draws every 2nd refresh, judged against
    // 33.3 ms and late half a refresh past it; the trial at the setting's
    // cadence, against 16.67 ms, and only judged.
    for (const window of [...judgedIn(loop, "engaged"), ...judgedIn(loop, "settled")]) {
      expect(window.cadence).toEqual({ frameCapHz: 60, divisor: 2, displayPeriodMs: expect.closeTo(VSYNC_60, 2), periodConfirmed: true, fallbackHz: expect.closeTo(30, 2) });
      expect(window.config.presentationTargetMs).toBeCloseTo(2 * VSYNC_60, 1);
      expect(window.config.lateIntervalMs).toBeCloseTo(2.5 * VSYNC_60, 1);
    }
    const trialWindows = judgedIn(loop, "trial");
    expect(trialWindows).toHaveLength(1);
    expect(trialWindows[0]!.cadence).toMatchObject({ divisor: 1 });
    expect(trialWindows[0]!.cadence?.fallbackHz).toBeUndefined();
    expect(trialWindows[0]!.config.presentationTargetMs).toBeCloseTo(VSYNC_60, 1);
    expect(trialWindows[0]!.signals.intervalMeanMs!).toBeGreaterThan(1.2 * VSYNC_60);
    expect(trialWindows[0]!.state.mode).toBe("fallback-trial");
    // Shed only while engaged, through the trial.
    const engaged = loop.windows.filter((window) => window.tS >= engagedAt && window.tS <= settledAt);
    for (let index = 1; index < engaged.length; index += 1) {
      const [was, now] = [engaged[index - 1]!.state, engaged[index]!.state];
      expect(now.gpuWorkLevel).toBeGreaterThanOrEqual(was.gpuWorkLevel);
      expect(now.cpuWorkLevel).toBeGreaterThanOrEqual(was.cpuWorkLevel);
      expect(now.renderScale).toBeLessThanOrEqual(was.renderScale);
    }
    // Exhausted from the engage on, through the rebase that zeroed the spent count.
    expect(loop.windows.filter((window) => window.tS >= engagedAt).every((window) => governorExhausted(window.state))).toBe(true);
    const engageRebase = loop.rebases.find((rebase) => rebase.tS >= engagedAt)!;
    expect(engageRebase.before.spentWindows).toBeGreaterThanOrEqual(EXHAUSTED_AFTER_WINDOWS);
    expect(engageRebase.after).toMatchObject({ spentWindows: 0, fallback: { phase: "engaged" } });
    expect(governorExhausted(engageRebase.after)).toBe(true);
    expectRebasesKeepTheFallback(loop);
    // Settled, rungs come back at 30.
    const atSettle = loop.windows.find((window) => window.tS === settledAt)!.state;
    expect(loop.windows.at(-1)!.state.gpuWorkLevel).toBeLessThan(atSettle.gpuWorkLevel);
  });

  it("a host that narrowly fails goes engaged, trial, engaged, trial (+120 s), settled", () => {
    const loop = fly(narrow, { seconds: 400 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "engaged", "trial", "settled"]);
    const failedAt = loop.phases[2]!.tS;
    const secondTrialAt = entered(loop, "trial", failedAt);
    expect(secondTrialAt - failedAt).toBeGreaterThanOrEqual(116);
    expect(secondTrialAt - failedAt).toBeLessThanOrEqual(130);
    expect(loop.phases.map(({ failedTrials }) => failedTrials)).toEqual([0, 0, 1, 1, 2]);
    // Each trial failed on one window off cadence at 60, not clearly: 50 fps or more.
    for (const window of judgedIn(loop, "trial")) {
      expect(window.signals.lateFraction!).toBeGreaterThan(0.05);
      expect(window.signals.intervalMeanMs!).toBeLessThanOrEqual(1.2 * VSYNC_60);
    }
    expectRebasesKeepTheFallback(loop);
  });

  it("a heavy stretch engages, the first trial passes, and every rung comes back after the exit", () => {
    const heavy: Machine = { ...uhd620, cpuMs: flat(8), gpuMs: (tS) => (tS >= 20 && tS < 110 ? 40 : 11) };
    const loop = fly(heavy, { seconds: 600 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "off"]);
    const exitedAt = loop.phases.at(-1)!.tS;
    expect(loop.phases.at(-1)!.failedTrials).toBe(0);
    const atExit = loop.windows.find((window) => window.tS === exitedAt)!.state;
    expect(atExit).toMatchObject({ gpuWorkLevel: GPU_WORK_MAX_LEVEL, spentWindows: 0, calmStreak: [] });
    expect(atExit.fallback).toEqual({ ...FALLBACK_OFF, msSinceExit: 0 });
    expect(loop.windows.at(-1)!.state).toMatchObject({ gpuWorkLevel: 0, cpuWorkLevel: 0, renderScale: t0.renderScale });
    // Back at the setting's cadence after the exit, and no request since.
    expect(loop.windows.filter((window) => window.tS > exitedAt).every((window) => window.cadence?.fallbackHz === undefined)).toBe(true);
    expectRebasesKeepTheFallback(loop);
  });

  it("alternating load switches the cadence at most twice in any 120 s from the first trial on", () => {
    for (const [heavyS, lightS] of [[60, 60], [90, 30], [120, 120]] as const) {
      for (const seed of [1, 7, 42]) {
        const alternating: Machine = {
          ...uhd620,
          cpuMs: flat(8),
          gpuMs: (tS) => (tS % (heavyS + lightS) < heavyS ? 40 : 11),
        };
        const loop = fly(alternating, { seconds: 1_200, seed });
        const label = `${heavyS}/${lightS} s, seed ${seed}`;
        const firstTrial = entered(loop, "trial");
        const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= firstTrial);
        expect(times.length, label).toBeGreaterThanOrEqual(2);
        for (const from of times) {
          expect(times.filter((tS) => tS >= from && tS < from + 120).length, `${label}, from ${from.toFixed(0)} s`)
            .toBeLessThanOrEqual(2);
        }
        expectRebasesKeepTheFallback(loop);
      }
    }
  });

  it("a host too slow for 30 stays engaged and is never trialled", () => {
    // GPU 90 ms at full quality, 42 ms shed: every fallback frame takes three refreshes.
    const loop = fly({ ...uhd620, gpuMs: flat(90) }, { seconds: 400 });
    expect(sequence(loop)).toEqual(["off", "engaged"]);
    const engaged = judgedIn(loop, "engaged");
    expect(engaged.length).toBeGreaterThan(30);
    expect(engaged.every((window) => window.state.mode !== "fallback-trial" && window.signals.lateFraction! > 0.05)).toBe(true);
    // It cannot hold 2, and asks for longer: at 60 Hz the range has nothing slower.
    expect(loop.windows.at(-1)!.state.fallback.minIntervalMs).toBeGreaterThan(2.5 * VSYNC_60);
    expect(engaged.every((window) => window.cadence?.divisor === 2)).toBe(true);
    expect(loop.switches).toHaveLength(1);
  });

  it("never falls back under Match display or 30 fps, at a rate of 0, without a confirmed cadence, or on a 30 or 50 Hz display", () => {
    const cases: readonly [string, FlyOptions, boolean][] = [
      ["Match display", { seconds: 240, setting: () => "display" }, true],
      ["the 30 fps setting", { seconds: 240, setting: () => "30" }, false],
      ["a rate of 0 (tier 0 before T0d)", { seconds: 240, profile: t0NoFallback }, true],
      ["no cadence (the capture harnesses)", { seconds: 240, paced: false }, true],
      ["a period never confirmed (no startup probe)", { seconds: 240, probe: false }, true],
      ["a 30 Hz display", { seconds: 240, hz: 30 }, false],
      ["a 50 Hz display (red team)", { seconds: 240, hz: 50 }, true],
    ];
    for (const [label, options, exhausts] of cases) {
      const loop = fly(uhd620, options);
      expect(sequence(loop), label).toEqual(["off"]);
      expect(loop.requested, label).toBe(0);
      expect(loop.windows.every((window) => window.cadence?.fallbackHz === undefined), label).toBe(true);
      // Not vacuous: the governor is exhausted wherever the display can show the target.
      expect(loop.windows.some((window) => governorExhausted(window.state)), label).toBe(exhausts);
    }
  });

  it("75 Hz: 37.5 fps for a host at 22 ms a frame, 25 for one at 30, and 2 → 3 for one that cannot hold 2 (red team)", () => {
    const rate = (loop: Loop): { divisor: number; fallbackHz: number | undefined; targetMs: number }[] =>
      judgedIn(loop, "engaged").map(({ cadence, config }) => ({
        divisor: cadence!.divisor,
        fallbackHz: cadence!.fallbackHz,
        targetMs: Math.round(config.presentationTargetMs * 100) / 100,
      }));
    const fits = fly(fixed(22), { seconds: 200, hz: 75 });
    expect(sequence(fits).slice(0, 2)).toEqual(["off", "engaged"]);
    expect(new Set(rate(fits).map((entry) => JSON.stringify(entry)))).toEqual(new Set([JSON.stringify({ divisor: 2, fallbackHz: 37.5, targetMs: 26.67 })]));
    expect(judgedIn(fits, "engaged").every((window) => window.state.mode !== "frame-pacing" && window.signals.lateFraction! <= 0.05)).toBe(true);
    const slower = fly(fixed(30), { seconds: 200, hz: 75 });
    expect(new Set(rate(slower).map((entry) => JSON.stringify(entry)))).toEqual(new Set([JSON.stringify({ divisor: 3, fallbackHz: 25, targetMs: 40 })]));
    // Heavier once on the fallback: two windows off cadence at 2, then 3, where it holds.
    const unheld = fly({ ...fixed(22), gpuMs: (_tS, phase) => (phase === "off" ? 22 : 30) }, { seconds: 200, hz: 75 });
    const engaged = rate(unheld);
    expect(engaged.slice(0, 2)).toEqual([
      { divisor: 2, fallbackHz: 37.5, targetMs: 26.67 },
      { divisor: 2, fallbackHz: 37.5, targetMs: 26.67 },
    ]);
    expect(new Set(engaged.slice(2).map((entry) => JSON.stringify(entry)))).toEqual(new Set([JSON.stringify({ divisor: 3, fallbackHz: 25, targetMs: 40 })]));
    expect(judgedIn(unheld, "engaged").slice(2).every((window) => window.signals.lateFraction! <= 0.05)).toBe(true);
    expectRebasesKeepTheFallback(unheld);
  });

  it("144 Hz: 36 fps or 28.8 by the host's mean", () => {
    const divisors = (loop: Loop): Set<string> => new Set(judgedIn(loop, "engaged").map(({ cadence, config }) =>
      `${cadence!.divisor} at ${config.presentationTargetMs.toFixed(2)} ms`));
    expect(divisors(fly(fixed(25), { seconds: 200, hz: 144 }))).toEqual(new Set(["4 at 27.78 ms"]));
    expect(divisors(fly(fixed(30), { seconds: 200, hz: 144 }))).toEqual(new Set(["5 at 34.72 ms"]));
  });

  it("75 Hz with levers left on the side that was not spent: the step and the raise never share a window (review)", () => {
    // CPU-bound off the fallback (render() 22 ms, GPU 8 ms), GPU-bound on it
    // (26 ms): exhausted on the CPU side, then a resolution step on the fallback.
    const host: Machine = {
      cpuMs: flat(22),
      gpuMs: (_tS, phase) => (phase === "off" ? 8 : 26),
      cpuSave: 0.3,
      gpuSave: 0.3,
      pixelShare: 0.85,
      jitter: 0.06,
    };
    for (const seed of [1, 2, 3]) {
      const loop = fly(host, { seconds: 160, hz: 75, seed });
      const label = `seed ${seed}`;
      expect(sequence(loop).slice(0, 2), label).toEqual(["off", "engaged"]);
      const fallbackWindows = loop.windows.filter((_window, index) => {
        const phase = loop.windows[index - 1]?.state.fallback.phase;
        return phase === "engaged" || phase === "settled";
      });
      // Not vacuous: a step was taken on the fallback.
      expect(fallbackWindows.some((window) => window.state.pendingProbe !== null), label).toBe(true);
      for (let index = 1; index < loop.windows.length; index += 1) {
        const [was, now] = [loop.windows[index - 1]!.state, loop.windows[index]!.state];
        if (was.fallback.phase === "off" || was.fallback.phase === "trial") continue;
        if (now.fallback.minIntervalMs <= was.fallback.minIntervalMs + 1e-9) continue;
        // A raise moves nothing else, and no step waits for its verdict.
        expect({ cpu: now.cpuWorkLevel, gpu: now.gpuWorkLevel, scale: now.renderScale, probe: now.pendingProbe }, label)
          .toEqual({ cpu: was.cpuWorkLevel, gpu: was.gpuWorkLevel, scale: was.renderScale, probe: null });
      }
      // Every step on the fallback gets its verdict: no rebase there drops a probe.
      expect(loop.rebases.filter(({ before }) => before.fallback.phase !== "off" && before.pendingProbe !== null), label).toEqual([]);
      // The step holds divisor 2 (37.5 fps).
      expect(fallbackWindows.every((window) => window.cadence?.divisor === 2), label).toBe(true);
      expectRebasesKeepTheFallback(loop);
    }
  });

  it("75 Hz, settled at divisor 2, then heavier: moves to 3 and stops drawing every frame late (review)", () => {
    // 22 ms a frame settles at divisor 2; from 250 s every frame costs 30 ms,
    // which no lever cuts. The run ends before the next settled trial (300 s on).
    const loop = fly({ ...fixed(22), gpuMs: (tS) => (tS < 250 ? 22 : 30) }, { seconds: 420, hz: 75 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "settled"]);
    const settledAt = entered(loop, "settled");
    expect(settledAt).toBeLessThan(250);
    const settled = loop.windows.filter((window) => window.tS > settledAt);
    expect(settled.filter((window) => window.tS < 250).every((window) => window.cadence?.divisor === 2)).toBe(true);
    // Settled, it moves to the slower divisor once the load grows, and holds it.
    const moved = loop.switches.filter(({ tS }) => tS > 250);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.cadence).toMatchObject({ divisor: 3, fallbackHz: expect.closeTo(25, 2) });
    const atSlower = settled.filter((window) => window.tS > moved[0]!.tS + 1);
    expect(atSlower.length).toBeGreaterThan(5);
    expect(atSlower.every((window) => window.cadence?.divisor === 3 && window.signals.lateFraction! <= 0.05)).toBe(true);
    expect(loop.windows.at(-1)!.state.fallback.minIntervalMs).toBeGreaterThan(2.05 * VSYNC_75);
    expectRebasesKeepTheFallback(loop);
  });

  it("75 Hz: an 8 s stall while engaged moves to divisor 3 only until the next trial fails (review)", () => {
    const quiet = fly(fixed(22), { seconds: 200, hz: 75 });
    const engagedAt = entered(quiet, "engaged");
    const stall = [engagedAt + 10, engagedAt + 18] as const;
    const loop = fly({ ...fixed(22), gpuMs: (tS) => (tS >= stall[0] && tS < stall[1] ? 32 : 22) }, { seconds: 240, hz: 75 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "settled"]);
    expect(entered(loop, "engaged")).toBe(engagedAt);
    const trialAt = entered(loop, "trial");
    const settledAt = entered(loop, "settled");
    // The stall raised the shortest interval: divisor 3 before the trial.
    expect(judgedIn(loop, "engaged").filter((window) => window.tS < trialAt).at(-1)!.cadence?.divisor).toBe(3);
    // The trial at the setting's cadence fails, and its window's mean chooses divisor 2 again.
    const failing = loop.windows.find((window) => window.tS === settledAt)!;
    expect(failing.state.fallback.minIntervalMs).toBeCloseTo(failing.signals.intervalMeanMs!, 9);
    expect(failing.state.fallback.minIntervalMs).toBeLessThan(2.05 * VSYNC_75);
    const after = judgedIn(loop, "settled");
    expect(after.length).toBeGreaterThan(10);
    expect(after.every((window) => window.cadence?.divisor === 2 && window.signals.lateFraction! <= 0.05)).toBe(true);
    expectRebasesKeepTheFallback(loop);
  });

  it("75 and 165 Hz, hosts that only just fit the faster divisor: at most two cadence switches in any 120 s from the first trial on (review)", () => {
    // Each fits the faster divisor by its 60-class mean, but draws more than
    // 5% of its frames late there. Before the failed trial's hysteresis, a
    // failed trial moved each to the faster divisor and a raise moved it back
    // 7 to 100 s later: three switches in 120 s.
    const hosts: readonly [string, Machine, number][] = [
      ["UHD 620-shaped at 75 Hz", uhd620, 75],
      ["27 ms a frame (8% noise) at 165 Hz", { ...fixed(27), jitter: 0.08 }, 165],
    ];
    for (const [name, machine, hz] of hosts) {
      let kept = 0;
      for (const seed of [1, 7, 42]) {
        const loop = fly(machine, { seconds: 900, hz, seed });
        const label = `${name}, seed ${seed}`;
        const firstTrial = entered(loop, "trial");
        const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= firstTrial);
        expect(times.length, label).toBeGreaterThanOrEqual(2);
        for (const from of times) {
          expect(times.filter((tS) => tS >= from && tS < from + 120).length, `${label}, from ${from.toFixed(0)} s`)
            .toBeLessThanOrEqual(2);
        }
        // Count the failed trials whose mean chose the faster divisor and that kept the slower one.
        loop.windows.forEach((window, index) => {
          const was = loop.windows[index - 1]?.state.fallback.phase;
          const now = window.state.fallback.phase;
          if (was !== "trial" || now === "trial" || now === "off") return;
          const range = window.config.fallbackDivisors!;
          const period = window.config.fallbackPeriodMs!;
          const chosen = fallbackDivisorFor(range, period, window.signals.intervalMeanMs!);
          if (chosen < fallbackDivisorFor(range, period, window.state.fallback.minIntervalMs)) kept += 1;
        });
        expectRebasesKeepTheFallback(loop);
      }
      // Not vacuous: the rule held the slower divisor at least once for each host.
      expect(kept, name).toBeGreaterThan(0);
    }
  });

  it("a pause delays the trial by the pause's length and keeps the phase", () => {
    const unpaused = fly(uhd620, { seconds: 300 });
    const engagedAt = entered(unpaused, "engaged");
    const pause = [engagedAt + 10, engagedAt + 40] as const;
    const paused = fly(uhd620, { seconds: 300, pausedS: pause });
    expect(sequence(paused)).toEqual(sequence(unpaused));
    expect(entered(paused, "engaged")).toBe(engagedAt);
    const delay = entered(paused, "trial") - entered(unpaused, "trial");
    expect(delay).toBeGreaterThanOrEqual(30 - 4);
    expect(delay).toBeLessThanOrEqual(30 + 8);
    // No window is judged while paused.
    expect(paused.windows.some((window) => window.tS > pause[0] + 1 && window.tS < pause[1])).toBe(false);
  });

  it("a setting toggled 60 → display → 60 after two failed trials keeps them, so the engage settles at once (red team)", () => {
    const settledAt = entered(fly(narrow, { seconds: 300 }), "settled");
    const away = settledAt + 20;
    const back = settledAt + 80;
    // The heavy load comes back with the toggle, so the governor is exhausted again.
    const loop = fly({ ...narrow, gpuMs: (tS) => (tS < 120 || tS >= away ? 50 : 32) }, {
      seconds: back + 60,
      setting: (tS) => (tS >= away && tS < back ? "display" : "60"),
    });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "engaged", "trial", "settled", "off", "settled"]);
    const [off, settled] = loop.phases.slice(-2);
    expect(off!.tS).toBeGreaterThanOrEqual(away);
    expect(off!.tS).toBeLessThan(back);
    expect(off!.failedTrials).toBe(2);
    expect(settled!.tS).toBeGreaterThanOrEqual(back);
    expect(settled!.failedTrials).toBe(2);
    // Under Match display, nothing asked and nothing drawn at the fallback.
    expect(loop.windows.filter((window) => window.tS > off!.tS && window.tS < back).every((window) =>
      window.cadence?.fallbackHz === undefined && window.config.cadenceFallbackHz === null)).toBe(true);
    expectRebasesKeepTheFallback(loop);
  });
});
