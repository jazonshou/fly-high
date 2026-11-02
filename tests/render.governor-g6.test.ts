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
/** The same display while the fallback draws at its slower divisor, 3 (25 fps). */
const at75Slow = governorConfigForProfile(t0, { ...cadence(60, 3, 75, true), fallbackHz: 25 });
/** Settled at 75 Hz on divisor 2, engaged there. */
const settledAtTwo = {
  phase: "settled",
  trialFrom: "settled",
  failedTrials: 1,
  minIntervalMs: 2 * VSYNC_75,
  engageIntervalMs: 2 * VSYNC_75,
} as const;

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
    // Off, the failed trials kept until forgiven, and the passing window's
    // mean with them: the host measured holding the setting's cadence.
    expect(states[2]!.fallback).toEqual({ ...FALLBACK_OFF, failedTrials: 1, msSinceExit: 0, exitIntervalMs: expect.closeTo(VSYNC_60, 9) });
    expect(states[2]).toMatchObject({ spentWindows: 0, calmStreak: [], gpuWorkLevel: GPU_WORK_MAX_LEVEL });
    expect(states.every((state) => cadenceFallbackRequest(state, at60) === null)).toBe(true);
  });

  it("counts an engage after a passed trial as a failed trial until 240 s forgive it; it settles at the engage only from the third (review)", () => {
    const spent = Object.freeze({
      ...createGovernorState(at60),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      spentWindows: EXHAUSTED_AFTER_WINDOWS - 1,
    });
    const engage = (fallback: Partial<CadenceFallbackState>): CadenceFallbackState =>
      nextGovernorDecision(withFallback(spent, fallback), steady(2 * VSYNC_60, 22, at60), at60).fallback;
    // Engaged: the first wait or the later one, nothing kept to retry.
    const engaged = (failedTrials: number): Partial<CadenceFallbackState> => ({
      phase: "engaged",
      trialFrom: "engaged",
      failedTrials,
      trialDueInMs: failedTrials === 0 ? 60_000 : 120_000,
      msSinceExit: null,
      exitIntervalMs: null,
      raisedFromMs: null,
      retryDueInMs: 0,
      settledRetries: 0,
    });
    // Settled at the engage. At 60 Hz there is one divisor, so the passed
    // trial's interval is never kept: nothing to retry.
    const settled = (failedTrials: number): Partial<CadenceFallbackState> => ({
      phase: "settled",
      trialFrom: "settled",
      failedTrials,
      trialDueInMs: 300_000,
      msSinceExit: null,
      exitIntervalMs: null,
      raisedFromMs: null,
      retryDueInMs: 0,
      settledRetries: 0,
    });
    // The exit clock runs first: 57 s reads 59 s when the engage is judged.
    expect(engage({ msSinceExit: 57_000, exitIntervalMs: VSYNC_60 })).toMatchObject(engaged(1));
    // Round 5 settled here, at the second failed trial, on the engaging
    // window's mean: the window that exhausted the governor, heavy by
    // construction, with nothing kept to retry.
    expect(engage({ msSinceExit: 57_000, failedTrials: 1, exitIntervalMs: VSYNC_60 })).toMatchObject(engaged(2));
    // The third settles (review: engaged every time, alternating load passed
    // each trial in a light stretch and engaged again in the next heavy one
    // for the session).
    expect(engage({ msSinceExit: 57_000, failedTrials: 2, exitIntervalMs: VSYNC_60 })).toMatchObject(settled(3));
    // More than a minute after the exit it still counts (review: the trial's
    // four-window cap passes hosts 3-5% late at 60, and the next heavy stretch
    // came 60-100 s later to a fresh 60 s wait), up to the last window before
    // forgiveness: 236 s reads 238 s.
    for (const msSinceExit of [59_000, 120_000, 236_000]) {
      expect(engage({ msSinceExit, exitIntervalMs: VSYNC_60 }), `${msSinceExit} ms`).toMatchObject(engaged(1));
      expect(engage({ msSinceExit, failedTrials: 1, exitIntervalMs: VSYNC_60 }), `${msSinceExit} ms`).toMatchObject(engaged(2));
      expect(engage({ msSinceExit, failedTrials: 3, exitIntervalMs: VSYNC_60 }), `${msSinceExit} ms`).toMatchObject(settled(4));
    }
    // 240 s after the exit the clock forgives first, and clears the kept
    // interval with it: a new engage, with the first wait, 60 s.
    expect(engage({ msSinceExit: 238_000, failedTrials: 2, exitIntervalMs: VSYNC_60 })).toMatchObject(engaged(0));
    expect(engage({})).toMatchObject(engaged(0));
    // Failed trials kept from before (the setting toggled away and back), no
    // exit since: it engages however many it carries, so its trial measures
    // (review: settled at the engage with nothing to keep, a host heavy only
    // on that window stayed on the slower divisor for the session).
    expect(engage({ failedTrials: 2 })).toMatchObject(engaged(2));
    expect(engage({ failedTrials: 3 })).toMatchObject(engaged(3));
    // The trial that follows an engage settles on any failure, a narrow one too.
    const trial = withFallback(spent, { ...engage({ msSinceExit: 120_000, failedTrials: 1 }), phase: "trial" });
    const failed = nextGovernorDecision(trial, windowOf(intervals(12), 5, at60), at60).fallback;
    expect(failed).toMatchObject({ phase: "settled", trialFrom: "settled", failedTrials: 3, trialDueInMs: 300_000 });
  });

  it("75 Hz: a passed trial keeps its window's mean, and an engage that settles keeps it to retry where it is on a faster divisor (review)", () => {
    const divisorOf = (minIntervalMs: number): number => fallbackDivisorFor(at75.fallbackDivisors!, VSYNC_75, minIntervalMs);
    // 120 frames at the setting's cadence, `threes` of them three refreshes and the rest two.
    const window = (threes: number, cpuP95Ms: number): GovernorSignals => windowOf(
      Array.from({ length: 120 }, (_, frame) => (frame < threes ? 3 : 2) * VSYNC_75),
      cpuP95Ms,
      at75,
    );
    const spent = Object.freeze({
      ...createGovernorState(at75),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      spentWindows: EXHAUSTED_AFTER_WINDOWS - 1,
    });
    // An early re-entry's trial (two failed trials counted) passes on two
    // calm windows at the setting's cadence: 60 fps, every frame on time.
    const trial = withFallback(spent, {
      phase: "trial",
      trialFrom: "engaged",
      failedTrials: 2,
      minIntervalMs: 2.9 * VSYNC_75,
      engageIntervalMs: 2.9 * VSYNC_75,
    });
    const passed = trace(trial, 2, () => steady(VSYNC_60, 5, at75), { config: at75 });
    expect(passed.map((state) => state.fallback.phase)).toEqual(["trial", "off"]);
    const exit = passed[1]!.fallback;
    expect(exit).toEqual({ ...FALLBACK_OFF, failedTrials: 2, msSinceExit: 0, exitIntervalMs: expect.closeTo(VSYNC_60, 6) });
    // Off, the kept interval rides along with the exit clock.
    const off = trace(withFallback(passed[1]!, {}), 3, () => steady(VSYNC_60, 5, at75), { config: at75 });
    expect(off.every((state) => state.fallback.exitIntervalMs === exit.exitIntervalMs)).toBe(true);
    // 150 s later a heavy stretch (2.9 refreshes a frame) exhausts the
    // governor again: the third failed trial counted, so it settles at the
    // engage, on divisor 3, and keeps the passed trial's interval (divisor 2)
    // to retry 300 s later. Nothing kept (part 1 of the review alone), a host
    // that holds divisor 2 only shed stayed on 3 for the session.
    const reentered = nextGovernorDecision(withFallback(spent, { ...exit, msSinceExit: 150_000 }), window(108, 22), at75);
    expect(reentered.fallback).toMatchObject({
      phase: "settled",
      trialFrom: "settled",
      failedTrials: 3,
      trialDueInMs: 300_000,
      msSinceExit: null,
      exitIntervalMs: null,
      retryDueInMs: 300_000,
      settledRetries: 0,
    });
    expect(divisorOf(reentered.fallback.minIntervalMs)).toBe(3);
    expect(reentered.fallback.engageIntervalMs).toBe(reentered.fallback.minIntervalMs);
    expect(reentered.fallback.raisedFromMs).toBe(exit.exitIntervalMs);
    expect(divisorOf(reentered.fallback.raisedFromMs!)).toBe(2);
    // A second early re-entry engages and keeps nothing: its trial, 120 s on, measures again.
    const second = nextGovernorDecision(withFallback(spent, { ...exit, failedTrials: 1, msSinceExit: 150_000 }), window(108, 22), at75);
    expect(second.fallback).toMatchObject({
      phase: "engaged",
      failedTrials: 2,
      trialDueInMs: 120_000,
      exitIntervalMs: null,
      raisedFromMs: null,
      retryDueInMs: 0,
    });
    // An engaging window already on divisor 2 keeps nothing: no faster divisor to retry.
    const onTwo = nextGovernorDecision(withFallback(spent, { ...exit, msSinceExit: 150_000 }), window(0, 22), at75);
    expect(onTwo.fallback).toMatchObject({ phase: "settled", failedTrials: 3, raisedFromMs: null, retryDueInMs: 0 });
    expect(divisorOf(onTwo.fallback.minIntervalMs)).toBe(2);
    // Forgiven (240 s off after the pass), the interval goes with the failed
    // trials: the next engage is a fresh one, and keeps nothing.
    const forgiven = trace(withFallback(spent, { ...exit, msSinceExit: 240_000 - at75.windowMs }), 1, () => steady(VSYNC_60, 5, at75), { config: at75 });
    expect(forgiven[0]!.fallback).toEqual(FALLBACK_OFF);
    const fresh = nextGovernorDecision(withFallback(spent, forgiven[0]!.fallback), window(108, 22), at75);
    expect(fresh.fallback).toMatchObject({ phase: "engaged", failedTrials: 0, raisedFromMs: null, retryDueInMs: 0 });
    // No exit measured (three failed trials kept through a setting moved
    // away and back): it engages, keeps nothing, and its trial measures.
    const toggled = nextGovernorDecision(withFallback(spent, { failedTrials: 3 }), window(108, 22), at75);
    expect(toggled.fallback).toMatchObject({ phase: "engaged", failedTrials: 3, trialDueInMs: 120_000, raisedFromMs: null, retryDueInMs: 0 });
    // Settled on divisor 3, on cadence there, the retry returns to divisor 2
    // on its own clock, 300 s on, and holds the trial at 60 off for 120 s.
    const slow = trace(rebaseGovernorState(reentered), 90, () => steady(3 * VSYNC_75, 5, at75Slow), { config: at75Slow });
    const retried = firstWindow(slow, (state) => state.fallback.raisedFromMs === null);
    expect(retried).toBeGreaterThanOrEqual(Math.ceil(300_000 / at75Slow.windowMs));
    expect(retried).toBeLessThanOrEqual(Math.ceil(300_000 / at75Slow.windowMs) + 2);
    expect(slow.slice(0, retried - 1).every((state) => state.fallback.phase === "settled" && divisorOf(state.fallback.minIntervalMs) === 3)).toBe(true);
    expect(slow[retried - 1]!.fallback).toMatchObject({ phase: "settled", settledRetries: 1, retryDueInMs: 300_000, trialDueInMs: 120_000 });
    expect(divisorOf(slow[retried - 1]!.fallback.minIntervalMs)).toBe(2);
  });

  it("75 Hz: an early re-entry on a heavy window engages at the slower divisor, and its trial keeps a lighter reading to retry (review)", () => {
    const divisorOf = (minIntervalMs: number): number => fallbackDivisorFor(at75.fallbackDivisors!, VSYNC_75, minIntervalMs);
    // 120 frames at the setting's cadence, `threes` of them three refreshes and the rest two.
    const window = (threes: number, cpuP95Ms: number): GovernorSignals => windowOf(
      Array.from({ length: 120 }, (_, frame) => (frame < threes ? 3 : 2) * VSYNC_75),
      cpuP95Ms,
      at75,
    );
    // A trial passed 150 s ago, after one that failed, and a heavy stretch
    // (2.9 refreshes a frame) exhausts the governor again.
    const spent = withFallback(Object.freeze({
      ...createGovernorState(at75),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      spentWindows: EXHAUSTED_AFTER_WINDOWS - 1,
    }), { failedTrials: 1, msSinceExit: 150_000 });
    const reentered = nextGovernorDecision(spent, window(108, 22), at75);
    expect(reentered.fallback).toMatchObject({ phase: "engaged", failedTrials: 2, trialDueInMs: 120_000, raisedFromMs: null });
    expect(divisorOf(reentered.fallback.minIntervalMs)).toBe(3);
    expect(reentered.fallback.engageIntervalMs).toBe(reentered.fallback.minIntervalMs);
    // Its trial, 120 s on, reads the load after the stretch: calm at divisor
    // 2. It settles on the engage's divisor and keeps the reading to retry
    // 300 s later. Settled at the engage (round 5), it kept the heavy
    // window's mean and nothing to retry: divisor 3 for the session.
    const failed = nextGovernorDecision(withFallback(reentered, { phase: "trial" }), window(0, 5), at75).fallback;
    expect(failed).toMatchObject({ phase: "settled", failedTrials: 3, retryDueInMs: 300_000, settledRetries: 0 });
    expect(divisorOf(failed.minIntervalMs)).toBe(3);
    expect(failed.raisedFromMs).toBeCloseTo(2 * VSYNC_75, 9);
    // A trial that still reads the stretch keeps nothing: no measurement says
    // divisor 2 held, so nothing is retried blind.
    const heavy = nextGovernorDecision(withFallback(reentered, { phase: "trial" }), window(108, 5), at75).fallback;
    expect(heavy).toMatchObject({ phase: "settled", raisedFromMs: null, retryDueInMs: 0 });
    expect(divisorOf(heavy.minIntervalMs)).toBe(3);
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

  it("forgives the failed trials 240 s after a passed trial, under any setting, and the passed trial's interval with them", () => {
    for (const governorConfig of [at60, atDisplay]) {
      const exited = withFallback(createGovernorState(governorConfig), { failedTrials: 2, msSinceExit: 0, exitIntervalMs: VSYNC_60 });
      const states = trace(exited, 130, () => steady(VSYNC_60, 5, governorConfig), { config: governorConfig });
      // 120 windows of 2 s, give or take a window to float noise.
      const forgiven = firstWindow(states, (state) => state.fallback.failedTrials === 0);
      expect(Math.abs(forgiven - 120)).toBeLessThanOrEqual(1);
      expect(states.slice(0, forgiven - 1).every((state) =>
        state.fallback.failedTrials === 2 && state.fallback.exitIntervalMs === VSYNC_60)).toBe(true);
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

  it("a failed trial never sets the interval below the engaging window's mean, so a lighter trial keeps the engage's divisor and its own reading to retry (review)", () => {
    const range = at75.fallbackDivisors!;
    const divisorOf = (minIntervalMs: number): number => fallbackDivisorFor(range, VSYNC_75, minIntervalMs);
    // 120 frames at the setting's cadence, `threes` of them three refreshes and the rest two.
    const window = (threes: number, cpuP95Ms: number): GovernorSignals => windowOf(
      Array.from({ length: 120 }, (_, frame) => (frame < threes ? 3 : 2) * VSYNC_75),
      cpuP95Ms,
      at75,
    );
    // Engaged at 75 Hz by a window of 2.4 refreshes: divisor 3 (25 fps).
    const spent = Object.freeze({
      ...createGovernorState(at75),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      spentWindows: EXHAUSTED_AFTER_WINDOWS - 1,
    });
    const engaged = nextGovernorDecision(spent, window(48, 22), at75);
    expect(engaged.fallback.phase).toBe("engaged");
    expect(engaged.fallback.engageIntervalMs).toBeCloseTo(2.4 * VSYNC_75, 9);
    expect(engaged.fallback.minIntervalMs).toBe(engaged.fallback.engageIntervalMs);
    expect(divisorOf(engaged.fallback.minIntervalMs)).toBe(3);
    // Its trial lands in a light stretch: every frame two refreshes, calm at
    // divisor 2, which alone would choose it. The trial fails, and keeps 3:
    // the next heavy stretch would raise 2 back to 3 (three switches in 25 s).
    // Its own reading is kept to retry, with the retry's first wait (round
    // 4: without it, an engaging window heavier than the load after it held
    // the slower divisor for the session).
    const trial = withFallback(engaged, { phase: "trial" });
    expect(divisorOf(window(0, 5).intervalMeanMs!)).toBe(2);
    const failed = nextGovernorDecision(trial, window(0, 5), at75);
    expect(failed.fallback).toMatchObject({ phase: "settled", failedTrials: 1, settledRetries: 0, retryDueInMs: 300_000, trialDueInMs: 300_000 });
    expect(failed.fallback.engageIntervalMs).toBe(engaged.fallback.engageIntervalMs);
    expect(failed.fallback.minIntervalMs).toBeCloseTo(2.4 * VSYNC_75, 9);
    expect(divisorOf(failed.fallback.minIntervalMs)).toBe(3);
    expect(failed.fallback.raisedFromMs).toBeCloseTo(2 * VSYNC_75, 9);
    expect(divisorOf(failed.fallback.raisedFromMs!)).toBe(2);
    // A heavier trial still takes its mean, and keeps nothing: 72 of 120 three refreshes (2.6).
    const heavier = nextGovernorDecision(trial, window(72, 5), at75).fallback;
    expect(heavier.minIntervalMs).toBeCloseTo(2.6 * VSYNC_75, 9);
    expect(heavier).toMatchObject({ raisedFromMs: null, retryDueInMs: 0 });
    // Engaged at divisor 2 (1.65 refreshes) and raised since, the same light
    // trial returns to 2, as after a stall, and forgets the raise.
    const raised = withFallback(trial, { engageIntervalMs: 1.65 * VSYNC_75, minIntervalMs: 2.4 * VSYNC_75, raisedFromMs: 1.65 * VSYNC_75, retryDueInMs: 200_000 });
    const chosen = nextGovernorDecision(raised, window(0, 5), at75).fallback;
    expect(chosen.minIntervalMs).toBeCloseTo(2 * VSYNC_75, 9);
    expect(chosen).toMatchObject({ phase: "settled", raisedFromMs: null, retryDueInMs: 0, settledRetries: 0 });
  });

  it("a failed trial keeps its reading to retry only where the floor holds a slower divisor (review)", () => {
    const divisorOf = (minIntervalMs: number): number => fallbackDivisorFor(at75.fallbackDivisors!, VSYNC_75, minIntervalMs);
    // 120 frames at the setting's cadence, `threes` of them three refreshes and the rest two.
    const window = (threes: number): GovernorSignals => windowOf(
      Array.from({ length: 120 }, (_, frame) => (frame < threes ? 3 : 2) * VSYNC_75),
      5,
      at75,
    );
    // Engaged by a window of 2.9 refreshes (divisor 3), its first trial at 75 Hz.
    const trial = withFallback(
      Object.freeze({ ...createGovernorState(at75), gpuWorkLevel: GPU_WORK_MAX_LEVEL }),
      { phase: "trial", trialFrom: "engaged", minIntervalMs: 2.9 * VSYNC_75, engageIntervalMs: 2.9 * VSYNC_75 },
    );
    // A reading of 2.5 refreshes is below the floor, but on the same divisor: nothing is kept.
    expect(divisorOf(window(60).intervalMeanMs!)).toBe(3);
    const same = nextGovernorDecision(trial, window(60), at75).fallback;
    expect(same.minIntervalMs).toBeCloseTo(2.9 * VSYNC_75, 9);
    expect(same).toMatchObject({ phase: "settled", raisedFromMs: null, retryDueInMs: 0 });
    // A reading calm at divisor 2 is kept. (Every frame two refreshes is 37.5
    // fps, under 50, so the trial settles at once: at 75, 144 and 165 Hz a
    // reading the floor holds back always does.)
    const kept = nextGovernorDecision(trial, window(0), at75).fallback;
    expect(kept.minIntervalMs).toBeCloseTo(2.9 * VSYNC_75, 9);
    expect(kept).toMatchObject({ phase: "settled", retryDueInMs: 300_000 });
    expect(kept.raisedFromMs).toBeCloseTo(2 * VSYNC_75, 9);
    // A settled trial is floored the same way: the light reading waits for the
    // retry instead of moving the cadence straight after the trial's pair,
    // where the next heavy stretch would raise it back.
    const fromSettled = nextGovernorDecision(withFallback(trial, { trialFrom: "settled" }), window(0), at75).fallback;
    expect(fromSettled.minIntervalMs).toBeCloseTo(2.9 * VSYNC_75, 9);
    expect(fromSettled).toMatchObject({ phase: "settled", retryDueInMs: 300_000 });
    expect(fromSettled.raisedFromMs).toBeCloseTo(2 * VSYNC_75, 9);
    // At 60 Hz the range has one divisor, so the floor never holds a slower one there.
    const at60Trial = withFallback(createGovernorState(at60), { phase: "trial", trialFrom: "engaged", minIntervalMs: 2.4 * VSYNC_60, engageIntervalMs: 2.4 * VSYNC_60 });
    const narrow = nextGovernorDecision(at60Trial, windowOf(intervals(12), 5, at60), at60).fallback;
    expect(narrow).toMatchObject({ phase: "engaged", raisedFromMs: null, retryDueInMs: 0 });
    expect(narrow.minIntervalMs).toBeCloseTo(2.4 * VSYNC_60, 9);
  });

  it("a failed trial is floored at the interval it left where that is shorter than the engage's, so one after a retry keeps the faster divisor (review)", () => {
    const divisorOf = (minIntervalMs: number): number => fallbackDivisorFor(at75.fallbackDivisors!, VSYNC_75, minIntervalMs);
    // 120 frames at the setting's cadence, `threes` of them three refreshes and the rest two.
    const window = (threes: number): GovernorSignals => windowOf(
      Array.from({ length: 120 }, (_, frame) => (frame < threes ? 3 : 2) * VSYNC_75),
      5,
      at75,
    );
    // Engaged by a window of 2.9 refreshes (divisor 3); settled, a retry has
    // returned to the kept 2.02 refreshes (divisor 2), the host reached full
    // quality there, and a settled trial at 75 Hz runs from it.
    const trial = withFallback(createGovernorState(at75), {
      phase: "trial",
      trialFrom: "settled",
      failedTrials: 1,
      minIntervalMs: 2.02 * VSYNC_75,
      engageIntervalMs: 2.9 * VSYNC_75,
      raisedFromMs: null,
      settledRetries: 1,
      retryDueInMs: 180_000,
    });
    expect(divisorOf(trial.fallback.minIntervalMs)).toBe(2);
    expect(divisorOf(trial.fallback.engageIntervalMs)).toBe(3);
    // Its reading, every frame two refreshes, picks divisor 2: it stays there,
    // keeps nothing to retry and starts the retries again. Floored at the
    // engage, it went back to 3 and kept the reading for another retry 300 s
    // on, so every trial undid the retry before it: in closed loop, about 70%
    // of the time at 25 fps for the session.
    expect(divisorOf(window(0).intervalMeanMs!)).toBe(2);
    const stays = nextGovernorDecision(trial, window(0), at75).fallback;
    expect(stays).toMatchObject({ phase: "settled", failedTrials: 2, raisedFromMs: null, retryDueInMs: 0, settledRetries: 0, trialDueInMs: 300_000 });
    expect(divisorOf(stays.minIntervalMs)).toBe(2);
    // The floor is the interval the trial left: a reading below it on the same divisor keeps it.
    expect(stays.minIntervalMs).toBeCloseTo(2.02 * VSYNC_75, 9);
    expect(stays.engageIntervalMs).toBeCloseTo(2.9 * VSYNC_75, 9);
    // A reading that picks divisor 3 still takes its mean (2.6 refreshes),
    // and now keeps the interval it left to retry (round 6; it kept nothing
    // before, and held divisor 3 for the session: below).
    const heavier = nextGovernorDecision(trial, window(72), at75).fallback;
    expect(heavier.minIntervalMs).toBeCloseTo(2.6 * VSYNC_75, 9);
    expect(heavier).toMatchObject({ phase: "settled", retryDueInMs: 600_000, settledRetries: 1 });
    expect(heavier.raisedFromMs).toBeCloseTo(2.02 * VSYNC_75, 9);
  });

  it("a failed trial that lands on a slower divisor than it left keeps the interval it left to retry, as a raise does (review)", () => {
    const divisorOf = (minIntervalMs: number): number => fallbackDivisorFor(at75.fallbackDivisors!, VSYNC_75, minIntervalMs);
    // 120 frames at the setting's cadence, `threes` of them three refreshes and the rest two.
    const window = (threes: number): GovernorSignals => windowOf(
      Array.from({ length: 120 }, (_, frame) => (frame < threes ? 3 : 2) * VSYNC_75),
      5,
      at75,
    );
    // 72 of 120 three refreshes: 2.6, divisor 3. Every frame three: 3, a clear failure too.
    expect(divisorOf(window(72).intervalMeanMs!)).toBe(3);
    const fail = (fallback: Partial<CadenceFallbackState>, signals: GovernorSignals = window(72)): CadenceFallbackState =>
      nextGovernorDecision(withFallback(createGovernorState(at75), { phase: "trial", ...fallback }), signals, at75).fallback;
    // The engaged trial that settles, from divisor 2 (engaged at 1.9
    // refreshes), lands on a stall: the reading picks divisor 3. Before, it
    // settled there and kept nothing, and a host that holds divisor 2 shed
    // never reaches full quality at 3, so it never ran another trial: divisor
    // 3 for the session. It keeps 1.9 now, with the retry's first wait.
    const engaged = fail({ trialFrom: "engaged", minIntervalMs: 1.9 * VSYNC_75, engageIntervalMs: 1.9 * VSYNC_75 });
    expect(engaged).toMatchObject({ phase: "settled", failedTrials: 1, retryDueInMs: 300_000, settledRetries: 0, trialDueInMs: 300_000 });
    expect(divisorOf(engaged.minIntervalMs)).toBe(3);
    expect(engaged.raisedFromMs).toBeCloseTo(1.9 * VSYNC_75, 9);
    // Settled, the retry count is kept, as a raise keeps it, so a host whose
    // load grew waits the longer step: one retry not yet held, 600 s.
    const counted = fail({ trialFrom: "settled", failedTrials: 1, minIntervalMs: 2.02 * VSYNC_75, engageIntervalMs: 2.9 * VSYNC_75, settledRetries: 1, retryDueInMs: 180_000 });
    expect(counted).toMatchObject({ retryDueInMs: 600_000, settledRetries: 1 });
    expect(counted.raisedFromMs).toBeCloseTo(2.02 * VSYNC_75, 9);
    // From divisor 3 with an interval kept already (a raise rose from it, its
    // retry 250 s away): the kept one and its clock stay, two retries counted.
    const kept = { trialFrom: "settled", failedTrials: 1, minIntervalMs: 2.6 * VSYNC_75, engageIntervalMs: 1.9 * VSYNC_75, raisedFromMs: 1.95 * VSYNC_75, settledRetries: 2 } as const;
    const running = fail({ ...kept, retryDueInMs: 250_000 }, window(120));
    expect(divisorOf(running.minIntervalMs)).toBe(3);
    expect(running).toMatchObject({ retryDueInMs: 250_000, settledRetries: 2 });
    expect(running.raisedFromMs).toBeCloseTo(1.95 * VSYNC_75, 9);
    // But never sooner than 120 s after the trial's pair of switches: with
    // the clock 30 s from its end, a retry 86 s after a trial pair broke D5.
    const soon = fail({ ...kept, retryDueInMs: 30_000 }, window(120));
    expect(soon).toMatchObject({ retryDueInMs: 120_000, settledRetries: 2 });
    expect(soon.raisedFromMs).toBeCloseTo(1.95 * VSYNC_75, 9);
    // A reading on the divisor it left keeps nothing.
    const same = fail({ trialFrom: "engaged", minIntervalMs: 2.4 * VSYNC_75, engageIntervalMs: 2.4 * VSYNC_75 });
    expect(same).toMatchObject({ raisedFromMs: null, retryDueInMs: 0 });
    // Engaged, an interval an engaged raise rose from is compared with, and
    // kept, as a settled raise's is: the trial left divisor 3, where a stall
    // raised the host from 2.04, and reads 3. Before, it settled there with
    // nothing kept, and a stall from 20 s after the engage through the trial
    // held the slower divisor for the session. The raise's clock runs on.
    const engagedRaise = fail({ trialFrom: "engaged", minIntervalMs: 2.07 * VSYNC_75, engageIntervalMs: 2.04 * VSYNC_75, raisedFromMs: 2.04 * VSYNC_75, retryDueInMs: 250_000 });
    expect(divisorOf(engagedRaise.minIntervalMs)).toBe(3);
    expect(engagedRaise).toMatchObject({ phase: "settled", retryDueInMs: 250_000, settledRetries: 0 });
    expect(engagedRaise.raisedFromMs).toBeCloseTo(2.04 * VSYNC_75, 9);
    // At 60 Hz the range has one divisor: nothing is ever slower, nothing kept.
    const at60Fail = nextGovernorDecision(
      withFallback(createGovernorState(at60), { phase: "trial", trialFrom: "settled", failedTrials: 1, minIntervalMs: 2 * VSYNC_60, engageIntervalMs: 2 * VSYNC_60 }),
      steady(3 * VSYNC_60, 5, at60),
      at60,
    ).fallback;
    expect(at60Fail).toMatchObject({ phase: "settled", raisedFromMs: null, retryDueInMs: 0, settledRetries: 0 });
  });

  it("a failed settled trial that keeps nothing to retry starts the retries again, so the next raise waits the first step (review)", () => {
    // Settled on divisor 3 with two retries counted (a raise now would wait
    // 1200 s) and nothing kept; a trial at the setting's cadence runs from
    // there and fails on divisor 3, so it keeps nothing either.
    const trial = withFallback(createGovernorState(at75), {
      ...settledAtTwo,
      phase: "trial",
      trialDueInMs: 0,
      minIntervalMs: 3 * VSYNC_75,
      settledRetries: 2,
    });
    const failed = nextGovernorDecision(trial, steady(3 * VSYNC_75, 5, at75), at75);
    expect(failed.fallback).toMatchObject({ phase: "settled", settledRetries: 0, raisedFromMs: null, retryDueInMs: 0 });
    // Fully shed on divisor 2, two windows that cannot hold it raise it to 3: the first step, 300 s.
    const shed = withFallback(Object.freeze({
      ...failed,
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      renderScale: at75Fallback.scaleFloor,
    }), { minIntervalMs: 2 * VSYNC_75 });
    const raised = trace(rebaseGovernorState(shed), 2, () => steady(3 * VSYNC_75, 5, at75Fallback), { config: at75Fallback });
    expect(raised[1]!.fallback.minIntervalMs).toBeCloseTo(3 * VSYNC_75, 9);
    expect(raised[1]!.fallback.retryDueInMs).toBe(300_000);
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
        // The last window's mean is kept: 115 frames on time and 5 a refresh late.
        const exitIntervalMs = expect.closeTo((125 / 120) * VSYNC_60, 9);
        expect(states[3]!.fallback, name).toEqual({ ...FALLBACK_OFF, failedTrials: 1, msSinceExit: 0, exitIntervalMs });
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

  it("an undone resolution step starts the unheld count again, as a shed one does (review)", () => {
    // Engaged at 75 Hz on divisor 2 with every rung shed, every frame 40 ms. A
    // resolution step was ineffective once, and this window's verdict on the
    // second undoes both (the latch): it moved a lever.
    const restored = at75Fallback.scaleFloor + 0.1;
    const stepped = Object.freeze({
      ...createGovernorState(at75Fallback),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      renderScale: at75Fallback.scaleFloor + 0.05,
      ineffectiveDownSteps: 1,
      restoreScale: restored,
      offCadenceWindows: 3,
      pendingProbe: Object.freeze({
        preStepGpuP95Ms: 3 * VSYNC_75,
        preStepScale: restored,
        metric: "interval" as const,
        preIntervalMeanMs: 3 * VSYNC_75,
        preLateFraction: 1,
      }),
    });
    const engaged = withFallback(stepped, { phase: "engaged", trialDueInMs: 60_000, minIntervalMs: 2 * VSYNC_75, engageIntervalMs: 2 * VSYNC_75 });
    const states = trace(engaged, 3, () => steady(3 * VSYNC_75, 5, at75Fallback), { config: at75Fallback });
    expect(states[0]).toMatchObject({ resolutionInsensitive: true, pendingProbe: null });
    expect(states[0]!.renderScale).toBeCloseTo(restored, 9);
    // So the raise comes two windows after the undo, not one.
    expect(states.map((state) => state.unheldWindows)).toEqual([0, 1, 2]);
    const range = fallbackDivisorRange(75, 30, 1)!;
    expect(states.map((state) => fallbackDivisorFor(range, VSYNC_75, state.fallback.minIntervalMs))).toEqual([2, 2, 3]);
  });

  it("a rebase starts the unheld count again (review)", () => {
    // Engaged at 75 Hz on divisor 2, nothing left to shed, one unheld window
    // counted; then the targets move and the state rebases.
    const shed = Object.freeze({
      ...createGovernorState(at75Fallback),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      renderScale: at75Fallback.scaleFloor,
    });
    const engaged = withFallback(shed, { phase: "engaged", trialDueInMs: 60_000, minIntervalMs: 2 * VSYNC_75, engageIntervalMs: 2 * VSYNC_75 });
    const unheld = (): GovernorSignals => steady(3 * VSYNC_75, 5, at75Fallback);
    const one = nextGovernorDecision(engaged, unheld(), at75Fallback);
    expect(one.unheldWindows).toBe(1);
    const rebased = rebaseGovernorState(one);
    expect(rebased.unheldWindows).toBe(0);
    // The window after it counts one, not two, so it raises nothing.
    const after = nextGovernorDecision(rebased, unheld(), at75Fallback);
    expect(after.unheldWindows).toBe(1);
    expect(after.fallback.minIntervalMs).toBeCloseTo(2 * VSYNC_75, 9);
    // Without the rebase the same window raises.
    expect(nextGovernorDecision(one, unheld(), at75Fallback).fallback.minIntervalMs).toBeCloseTo(3 * VSYNC_75, 9);
  });

  it("settled, a raise keeps the interval it rose from and waits 300 s on the retry's own clock; then the faster divisor comes back (review)", () => {
    const range = fallbackDivisorFor.bind(null, fallbackDivisorRange(75, 30, 1)!, VSYNC_75);
    const divisorOf = (state: GovernorState, governorConfig: GovernorConfig): number =>
      range(cadenceFallbackRequest(state, governorConfig)!.minIntervalMs);
    // Settled at divisor 2, fully shed, its wait over; then every frame takes three refreshes.
    const shed = Object.freeze({
      ...createGovernorState(at75Fallback),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      renderScale: at75Fallback.scaleFloor,
    });
    const settled = withFallback(shed, { ...settledAtTwo, trialDueInMs: 0 });
    const raised = trace(settled, 2, () => steady(3 * VSYNC_75, 5, at75Fallback), { config: at75Fallback });
    expect(raised[0]!.fallback).toMatchObject({ raisedFromMs: null, retryDueInMs: 0, trialDueInMs: 0 });
    // The retry's clock, not the trial's: the raise leaves the trial's wait where it was.
    expect(raised[1]!.fallback).toMatchObject({ phase: "settled", settledRetries: 0, retryDueInMs: 300_000, trialDueInMs: 0 });
    expect(raised[1]!.fallback.raisedFromMs).toBeCloseTo(2 * VSYNC_75, 9);
    expect(divisorOf(raised[1]!, at75Fallback)).toBe(3);
    // The pacer draws every 3rd refresh, and the state rebases. On cadence
    // there, rungs come back, and divisor 2 waits out the 300 s.
    const slow = trace(rebaseGovernorState(raised[1]!), 90, () => steady(3 * VSYNC_75, 5, at75Slow), { config: at75Slow });
    const retried = firstWindow(slow, (state) => state.fallback.raisedFromMs === null);
    expect(retried).toBeGreaterThanOrEqual(Math.ceil(300_000 / at75Slow.windowMs));
    expect(slow.slice(0, retried - 1).every((state) => divisorOf(state, at75Slow) === 3)).toBe(true);
    expect(slow.slice(0, retried - 1).some((state) => state.gpuWorkLevel < GPU_WORK_MAX_LEVEL)).toBe(true);
    const [before, at] = [slow[retried - 2]!, slow[retried - 1]!];
    // The retry starts its hold, and keeps the trial at the setting's cadence 120 s off (D5).
    expect(at.fallback).toMatchObject({ phase: "settled", settledRetries: 1, retryDueInMs: 300_000, trialDueInMs: 120_000 });
    expect(divisorOf(at, at75Slow)).toBe(2);
    // The retry moves nothing else, and leaves no recovery trial open.
    expect({ cpu: at.cpuWorkLevel, gpu: at.gpuWorkLevel, scale: at.renderScale, trial: at.trial, probe: at.pendingProbe })
      .toEqual({ cpu: before.cpuWorkLevel, gpu: before.gpuWorkLevel, scale: before.renderScale, trial: null, probe: null });

    // Due, with a raise to undo, on divisor 3, short of full quality: the
    // first on-cadence window retries, calm or not ...
    const due = withFallback(createGovernorState(at75Slow), {
      ...settledAtTwo,
      trialDueInMs: 0,
      minIntervalMs: 3 * VSYNC_75,
      raisedFromMs: 2 * VSYNC_75,
    });
    const onSlow = (): GovernorSignals => steady(3 * VSYNC_75, 5, at75Slow);
    const short = nextGovernorDecision(withFallback({ ...due, gpuWorkLevel: 3 }, {}), onSlow(), at75Slow);
    expect(short.fallback).toMatchObject({ phase: "settled", raisedFromMs: null, settledRetries: 1, retryDueInMs: 300_000, trialDueInMs: 120_000 });
    expect(short.fallback.minIntervalMs).toBe(2 * VSYNC_75);
    expect(short.gpuWorkLevel).toBe(3);
    // ... and at full quality too, before the trial at the setting's cadence,
    // which at full quality on divisor 3 would read divisor 3 (round 4).
    const atFull = nextGovernorDecision(due, onSlow(), at75Slow);
    expect(atFull.fallback).toMatchObject({ phase: "settled", raisedFromMs: null, settledRetries: 1 });
    expect(atFull.fallback.minIntervalMs).toBe(2 * VSYNC_75);
    // With nothing to retry, the trial runs from full quality once a calm streak allows it.
    const full = trace(withFallback(due, { raisedFromMs: null }), 4, onSlow, { config: at75Slow });
    expect(full.map((state) => state.fallback.phase)).toEqual(["settled", "settled", "settled", "trial"]);
    // With a retry kept but not yet due, too: the retry waits on its own clock.
    const waiting = trace(withFallback(due, { retryDueInMs: 600_000 }), 4, onSlow, { config: at75Slow });
    expect(waiting.map((state) => state.fallback.phase)).toEqual(["settled", "settled", "settled", "trial"]);
    // Not while a recovery trial is open: it waits for the trial to pass.
    const open = withFallback(Object.freeze({
      ...due,
      gpuWorkLevel: 3,
      trial: Object.freeze({
        ladder: "gpu" as const,
        restoreLevel: 4,
        restoreScale: due.renderScale,
        windowsPassed: 0,
        streaming: false,
        openBacklog: null,
        lastBacklog: null,
      }),
    }), {});
    const opened = trace(open, 2, onSlow, { config: at75Slow });
    expect(opened.map((state) => state.fallback.raisedFromMs === null)).toEqual([false, true]);
    expect(opened[0]!.trial).not.toBeNull();
    // Nor before the retry's wait is over, nor with no raise to undo: rungs come back as usual.
    for (const [label, fallback] of [
      ["the wait not over", { retryDueInMs: 60_000 }],
      ["no raise", { raisedFromMs: null }],
    ] as const) {
      const states = trace(withFallback({ ...due, gpuWorkLevel: 3 }, fallback), 6, onSlow, { config: at75Slow });
      expect(states.every((state) => state.fallback.minIntervalMs === 3 * VSYNC_75 && state.fallback.settledRetries === 0), label).toBe(true);
      expect(states.at(-1)!.gpuWorkLevel, label).toBeLessThan(3);
    }
  });

  it("settled, each retry that ends in a raise doubles the wait, to 1200 s, and one that holds starts the count again (review)", () => {
    const shed = Object.freeze({
      ...createGovernorState(at75Fallback),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      renderScale: at75Fallback.scaleFloor,
    });
    const unheld = (): GovernorSignals => steady(3 * VSYNC_75, 5, at75Fallback);
    const raise = (fallback: Partial<CadenceFallbackState>): CadenceFallbackState => {
      const states = trace(withFallback(shed, { ...settledAtTwo, trialDueInMs: 0, ...fallback }), 2, unheld, { config: at75Fallback });
      expect(states[1]!.fallback.minIntervalMs).toBeCloseTo(3 * VSYNC_75, 9);
      return states[1]!.fallback;
    };
    // The wait a raise starts, after 0, 1, 2 and 3 retries that ended in raises.
    expect([0, 1, 2, 3].map((settledRetries) => raise({ settledRetries }).retryDueInMs)).toEqual([300_000, 600_000, 1_200_000, 1_200_000]);
    // A longer wait already running stays, and so does the interval from before the first raise.
    const again = raise({ retryDueInMs: 900_000, raisedFromMs: 1.9 * VSYNC_75 });
    expect(again.retryDueInMs).toBe(900_000 - 2 * at75Fallback.windowMs);
    expect(again.raisedFromMs).toBe(1.9 * VSYNC_75);
    // The trial's wait runs down on its own through a raise.
    expect(raise({ trialDueInMs: 150_000 }).trialDueInMs).toBe(150_000 - 2 * at75Fallback.windowMs);
    // Engaged, a raise leaves the trial's wait alone too: the trial at the setting's cadence chooses again.
    const engaged = trace(withFallback(shed, { phase: "engaged", trialDueInMs: 30_000, minIntervalMs: 2 * VSYNC_75 }), 2, unheld, { config: at75Fallback });
    expect(engaged[1]!.fallback.trialDueInMs).toBe(30_000 - 2 * at75Fallback.windowMs);
    expect(engaged[1]!.fallback.raisedFromMs).toBeCloseTo(2 * VSYNC_75, 9);
    // A retry's hold that runs out with no raise since: it held, and the count
    // starts again. With a raise since, it did not, and the retry its wait
    // now allows counts one more. (The trial is not due.)
    const holding = (raisedFromMs: number | null): CadenceFallbackState => nextGovernorDecision(
      withFallback(createGovernorState(at75Fallback), {
        ...settledAtTwo,
        settledRetries: 2,
        raisedFromMs,
        retryDueInMs: at75Fallback.windowMs,
        trialDueInMs: 100_000,
      }),
      steady(2 * VSYNC_75, 5, at75Fallback),
      at75Fallback,
    ).fallback;
    expect(holding(null)).toMatchObject({ retryDueInMs: 0, settledRetries: 0 });
    expect(holding(1.9 * VSYNC_75)).toMatchObject({ raisedFromMs: null, retryDueInMs: 300_000, settledRetries: 3 });
    // The trial's clock running out says nothing about a retry.
    const trialOut = nextGovernorDecision(
      withFallback(createGovernorState(at75Fallback), { ...settledAtTwo, settledRetries: 2, retryDueInMs: 100_000, trialDueInMs: at75Fallback.windowMs }),
      steady(2 * VSYNC_75, 5, at75Fallback),
      at75Fallback,
    ).fallback;
    expect(trialOut).toMatchObject({ trialDueInMs: 0, settledRetries: 2 });
  });

  it("a raise that leaves the divisor where it was keeps nothing to retry and moves no clock (review)", () => {
    // 60 Hz, settled at 30 and fully shed; every frame then takes 2.6
    // refreshes (43 ms): the interval rises, and the divisor stays 2.
    const shed60 = Object.freeze({
      ...createGovernorState(atFallback),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      renderScale: atFallback.scaleFloor,
    });
    expect(atFallback.fallbackDivisors).toEqual([2, 2]);
    const settled60 = withFallback(shed60, { ...settledAtTwo, minIntervalMs: 2 * VSYNC_60, engageIntervalMs: 2 * VSYNC_60, trialDueInMs: 150_000, settledRetries: 1 });
    const raised60 = trace(settled60, 2, () => windowOf(Array.from({ length: 120 }, (_, frame) => (frame % 5 < 3 ? 3 : 2) * VSYNC_60), 5, atFallback), { config: atFallback });
    expect(raised60[1]!.fallback.minIntervalMs).toBeCloseTo(2.6 * VSYNC_60, 9);
    expect(raised60[1]!.fallback).toMatchObject({ raisedFromMs: null, retryDueInMs: 0, settledRetries: 1, trialDueInMs: 150_000 - 2 * atFallback.windowMs });
    // 75 Hz, already on divisor 3 at 2.4 refreshes: a raise to 2.8 stays on 3.
    const shed75 = Object.freeze({
      ...createGovernorState(at75Slow),
      cpuWorkLevel: CPU_WORK_MAX_LEVEL,
      gpuWorkLevel: GPU_WORK_MAX_LEVEL,
      renderScale: at75Slow.scaleFloor,
    });
    const settled75 = withFallback(shed75, { ...settledAtTwo, minIntervalMs: 2.4 * VSYNC_75, trialDueInMs: 150_000 });
    const window75 = (): GovernorSignals => windowOf(Array.from({ length: 120 }, (_, frame) => (frame % 5 < 3 ? 4 : 3) * VSYNC_75), 5, at75Slow);
    const raised75 = trace(settled75, 2, window75, { config: at75Slow });
    expect(raised75[1]!.fallback.minIntervalMs).toBeCloseTo(3.6 * VSYNC_75, 9);
    expect(raised75[1]!.fallback).toMatchObject({ raisedFromMs: null, retryDueInMs: 0, settledRetries: 0 });
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
  /** The share of frames that take `hitchMs` more render() time, at random: a light stretch a few percent late. */
  readonly hitchShare?: number;
  readonly hitchMs?: number;
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
    let cpuMs = machine.cpuMs(tS, phase) * (1 - (machine.cpuSave * state.cpuWorkLevel) / CPU_WORK_MAX_LEVEL)
      * (1 + machine.jitter * noise());
    const gpuMs = machine.gpuMs(tS, phase) * (1 - (machine.gpuSave * state.gpuWorkLevel) / GPU_WORK_MAX_LEVEL)
      * pixels * (1 + machine.jitter * noise());
    if (machine.hitchShare !== undefined && random() < machine.hitchShare) cpuMs += machine.hitchMs ?? 0;
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
/**
 * GPU-bound with levers that save little (a tenth at the top of the GPU
 * ladder, 30% of the GPU time in the pixels): at 20 ms a frame (22 at 165
 * Hz) it draws the faster divisor at full quality, and not 60 even fully shed.
 */
const littleToShed = (gpuMs: (tS: number) => number): Machine => ({ cpuMs: flat(8), gpuMs, cpuSave: 0.3, gpuSave: 0.1, pixelShare: 0.3, jitter: 0.08 });

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

/**
 * Each settled retry of the faster divisor (a settled window whose shortest
 * interval fell) moves nothing else, with no step waiting for its verdict:
 * one lever per window. Returns how many there were.
 */
function expectRetriesMoveNothingElse(loop: Loop): number {
  let retries = 0;
  for (let index = 1; index < loop.windows.length; index += 1) {
    const [was, now] = [loop.windows[index - 1]!.state, loop.windows[index]!.state];
    if (was.fallback.phase !== "settled" || now.fallback.phase !== "settled") continue;
    if (now.fallback.minIntervalMs >= was.fallback.minIntervalMs - 1e-9) continue;
    retries += 1;
    expect({ cpu: now.cpuWorkLevel, gpu: now.gpuWorkLevel, scale: now.renderScale, probe: now.pendingProbe }, `retry at ${loop.windows[index]!.tS} s`)
      .toEqual({ cpu: was.cpuWorkLevel, gpu: was.gpuWorkLevel, scale: was.renderScale, probe: null });
  }
  return retries;
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
    const exitWindow = loop.windows.find((window) => window.tS === exitedAt)!;
    expect(atExit.fallback).toEqual({ ...FALLBACK_OFF, msSinceExit: 0, exitIntervalMs: exitWindow.signals.intervalMeanMs });
    expect(atExit.fallback.exitIntervalMs!).toBeLessThan(1.05 * VSYNC_60);
    expect(loop.windows.at(-1)!.state).toMatchObject({ gpuWorkLevel: 0, cpuWorkLevel: 0, renderScale: t0.renderScale });
    // Back at the setting's cadence after the exit, and no request since.
    expect(loop.windows.filter((window) => window.tS > exitedAt).every((window) => window.cadence?.fallbackHz === undefined)).toBe(true);
    expectRebasesKeepTheFallback(loop);
  });

  it("alternating load switches the cadence at most twice in any 120 s from the first trial on, calm or 4% late between (review)", () => {
    // The light stretch calm, or with 4% of its frames a refresh late at 60
    // (12 ms more render() time): on cadence, never calm. At 60 Hz, before an
    // engage counted as a failed trial until forgiveness, the trial's
    // four-window cap passed such a host, the next heavy stretch came back
    // to a fresh first wait, and runs went to three switches in 120 s. At 75
    // and 144 Hz, before the engage floor, a failed trial in a light stretch
    // chose the faster divisor and the next heavy stretch raised it back.
    const cases: readonly { readonly hz: number; readonly light: "calm" | "4% late"; readonly heavyMs: number }[] = [
      { hz: 60, light: "calm", heavyMs: 40 },
      { hz: 60, light: "4% late", heavyMs: 40 },
      ...[75, 144].flatMap((hz) => [40, 60].map((heavyMs) => ({ hz, light: "4% late" as const, heavyMs }))),
    ];
    for (const { hz, light, heavyMs } of cases) {
      for (const [heavyS, lightS] of [[60, 60], [90, 30], [120, 120]] as const) {
        for (const seed of [1, 7, 42]) {
          const alternating: Machine = {
            ...uhd620,
            cpuMs: flat(8),
            gpuMs: (tS) => (tS % (heavyS + lightS) < heavyS ? heavyMs : 11),
            ...(light === "4% late" ? { hitchShare: 0.04, hitchMs: 12 } : {}),
          };
          const loop = fly(alternating, { seconds: 1_200, hz, seed });
          const label = `${hz} Hz, ${heavyS}/${lightS} s at ${heavyMs} ms, ${light}, seed ${seed}`;
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

  it("75 Hz, settled at divisor 2 only shed, a heavier 30 s moves it to 3, and a retry brings it back after 300 s (review)", () => {
    // UHD 620-shaped at 46 ms a frame: it holds divisor 2 (37.5 fps) settled
    // only with GPU rungs shed, so it never reaches full quality there, and
    // never runs a settled trial. 10 ms more for 30 s raises it to 3 (25 fps),
    // where its rungs come back; before the retry it stayed there for the session.
    const host = (stretch: readonly [number, number] | null): Machine => ({
      ...uhd620,
      gpuMs: (tS) => 46 + (stretch !== null && tS >= stretch[0] && tS < stretch[1] ? 10 : 0),
    });
    const quiet = fly(host(null), { seconds: 900, hz: 75, seed: 1 });
    expect(sequence(quiet)).toEqual(["off", "engaged", "trial", "settled"]);
    const settledAt = entered(quiet, "settled");
    const settledQuiet = quiet.windows.filter((window) => window.tS > settledAt);
    expect(settledQuiet.every((window) => window.cadence?.divisor === 2 && window.state.gpuWorkLevel > 0)).toBe(true);
    const stretch = [settledAt + 60, settledAt + 90] as const;
    const loop = fly(host(stretch), { seconds: 900, hz: 75, seed: 1 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "settled"]);
    const moved = loop.switches.filter(({ tS }) => tS >= stretch[0]);
    expect(moved.map(({ cadence }) => cadence.divisor)).toEqual([3, 2]);
    const [raise, retry] = moved as [Loop["switches"][number], Loop["switches"][number]];
    expect(raise.tS).toBeLessThan(stretch[1] + 8);
    // Back after the 300 s the raise started, and within a minute of it.
    expect(retry.tS - raise.tS).toBeGreaterThanOrEqual(300 - 5);
    expect(retry.tS - raise.tS).toBeLessThanOrEqual(300 + 60);
    // Divisor 2 to the end, on cadence there once it has shed again.
    const back = loop.windows.filter((window) => window.tS > retry.tS + 120);
    expect(back.length).toBeGreaterThan(50);
    expect(back.every((window) => window.cadence?.divisor === 2)).toBe(true);
    expect(back.filter((window) => window.signals.lateFraction! <= 0.05).length / back.length).toBeGreaterThan(0.9);
    expect(expectRetriesMoveNothingElse(loop)).toBe(1);
    expectRebasesKeepTheFallback(loop);
  });

  it("75 Hz, settled at divisor 2, then heavier for good: it holds 3, and retries 2 twice in 1500 s, 300 s then 600 s after a raise (review)", () => {
    // The same host, 10 ms heavier from a minute after it settles: divisor 2
    // is out of reach even fully shed. Each retry sheds everything there and
    // is raised again, so each doubles the wait before the next.
    const host = (fromS: number): Machine => ({ ...uhd620, gpuMs: (tS) => 46 + (tS >= fromS ? 10 : 0) });
    const heavierFrom = entered(fly(host(Infinity), { seconds: 300, hz: 75, seed: 1 }), "settled") + 60;
    const loop = fly(host(heavierFrom), { seconds: 1_500, hz: 75, seed: 1 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "settled"]);
    // Settled windows whose shortest interval rose (a raise) or fell (a retry).
    const moves = (rose: boolean): number[] => loop.windows.filter((window, index) => {
      const was = loop.windows[index - 1]?.state.fallback;
      const now = window.state.fallback;
      if (was?.phase !== "settled" || now.phase !== "settled") return false;
      return rose ? now.minIntervalMs > was.minIntervalMs + 1e-9 : now.minIntervalMs < was.minIntervalMs - 1e-9;
    }).map(({ tS }) => tS);
    const [raises, retries] = [moves(true), moves(false)];
    expect(raises).toHaveLength(3);
    expect(retries).toHaveLength(2);
    expect(raises[0]!).toBeLessThan(heavierFrom + 60);
    expect(retries[0]! - raises[0]!).toBeGreaterThanOrEqual(300 - 5);
    expect(retries[1]! - raises[1]!).toBeGreaterThanOrEqual(600 - 5);
    // Each retry ends in a raise within two minutes, and the next waits 1200 s, past the run.
    for (const [index, retryAt] of retries.entries()) {
      expect(raises[index + 1]! - retryAt).toBeGreaterThan(0);
      expect(raises[index + 1]! - retryAt).toBeLessThan(120);
    }
    expect(loop.windows.at(-1)!.state.fallback).toMatchObject({ settledRetries: 2 });
    expect(loop.windows.at(-1)!.state.fallback.retryDueInMs).toBeGreaterThan(1_200_000 - (1_500 - raises[2]!) * 1_000 - 10_000);
    // At most two switches in any 120 s from the heavier load on, and divisor 3
    // for at least 80% of the time since the first raise.
    const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= heavierFrom);
    expect(times).toHaveLength(5);
    for (const from of times) {
      expect(times.filter((tS) => tS >= from && tS < from + 120).length, `from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
    }
    const since = loop.windows.filter((window) => window.tS > raises[0]! + 1);
    expect(since.filter((window) => window.cadence?.divisor === 3).length / since.length).toBeGreaterThan(0.8);
    expect(loop.windows.at(-1)!.cadence?.divisor).toBe(3);
    expect(expectRetriesMoveNothingElse(loop)).toBe(2);
    expectRebasesKeepTheFallback(loop);
  });

  it("75 Hz: a 5 s spike on the window that engages holds divisor 3 only until the retry, then 2 for good (review)", () => {
    // UHD 620-shaped at 46 ms a frame holds divisor 2 (37.5 fps) shed. 15 ms
    // more for 5 s on the window that exhausts the governor engages at 3,
    // the floor every failed trial kept; before the floor's reading was kept
    // to retry, 25 fps for the session.
    const host = (spike: readonly [number, number] | null): Machine => ({
      ...uhd620,
      gpuMs: (tS) => 46 + (spike !== null && tS >= spike[0] && tS < spike[1] ? 15 : 0),
    });
    const quiet = fly(host(null), { seconds: 1_800, hz: 75, seed: 1 });
    const engagedAt = entered(quiet, "engaged");
    expect(judgedIn(quiet, "settled").every((window) => window.cadence?.divisor === 2)).toBe(true);
    const spike = [engagedAt - 4, engagedAt + 1] as const;
    const loop = fly(host(spike), { seconds: 1_800, hz: 75, seed: 1 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "settled"]);
    // Not vacuous: the spike engaged it at divisor 3, and the failed trial read divisor 2.
    const settledAt = entered(loop, "settled");
    const atSettle = loop.windows.find((window) => window.tS === settledAt)!;
    const range = atSettle.config.fallbackDivisors!;
    const divisorOf = (ms: number): number => fallbackDivisorFor(range, VSYNC_75, ms);
    expect(divisorOf(atSettle.state.fallback.engageIntervalMs)).toBe(3);
    expect(divisorOf(atSettle.state.fallback.minIntervalMs)).toBe(3);
    expect(divisorOf(atSettle.state.fallback.raisedFromMs!)).toBe(2);
    // Divisor 2 within 600 s of settling, and to the end.
    const back = loop.switches.filter(({ tS }) => tS > settledAt + 1);
    expect(back.map(({ cadence }) => cadence.divisor)).toEqual([2]);
    expect(back[0]!.tS - settledAt).toBeLessThanOrEqual(600);
    expect(loop.windows.filter((window) => window.tS > back[0]!.tS + 1).every((window) => window.cadence?.divisor === 2)).toBe(true);
    // At most two switches in any 120 s from the first trial on.
    const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= entered(loop, "trial"));
    for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, `from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
    expect(expectRetriesMoveNothingElse(loop)).toBe(1);
    expectRebasesKeepTheFallback(loop);
  });

  it("75 and 144 Hz: a heavy stretch 60 to 200 s after a passed trial engages again, and the faster divisor comes back about 300 s after its trial (review)", () => {
    // UHD 620-shaped at 46 ms a frame holds the faster divisor only shed.
    // From its first failed trial on, 10 ms: it recovers at the fallback's
    // rate and its settled trial passes. 60, 120 or 200 s after the pass, a
    // heavy stretch (61 or 60 ms) exhausts it again, before 240 s forgive the
    // failed trial, and ends 5 s after the engage; then 46 ms, which holds
    // the faster divisor shed. Round 5 settled at that engage, on the heavy
    // window's mean with nothing kept to retry: the slower divisor for the
    // session in every run.
    for (const [hz, faster, heavyMs] of [[75, 2, 61], [144, 4, 60]] as const) {
      const seed = 1;
      const quiet = fly({ ...uhd620, gpuMs: flat(46) }, { seconds: 400, hz, seed });
      const lightFrom = quiet.phases.find(({ failedTrials }) => failedTrials > 0)!.tS + 0.5;
      const passedAt = entered(fly({ ...uhd620, gpuMs: (tS) => (tS < lightFrom ? 46 : 10) }, { seconds: 900, hz, seed }), "off", lightFrom);
      for (const delayS of [60, 120, 200]) {
        const label = `${hz} Hz, heavy from ${delayS} s after the pass`;
        const heavyFrom = passedAt + delayS;
        const host = (heavyTo: number): Machine => ({
          ...uhd620,
          gpuMs: (tS) => (tS < lightFrom ? 46 : tS < heavyFrom ? 10 : tS < heavyTo ? heavyMs : 46),
        });
        const engagedAt = fly(host(Infinity), { seconds: heavyFrom + 120, hz, seed }).phases.find(({ tS }) => tS > heavyFrom)!.tS;
        const loop = fly(host(engagedAt + 5), { seconds: engagedAt + 1_000, hz, seed });
        const again = loop.phases.filter(({ tS }) => tS >= engagedAt);
        // Engaged, not settled, counting the re-entry: the trial waits 120 s and reads the load after the stretch.
        expect(again.map(({ phase, failedTrials }) => `${phase}(${failedTrials})`), label).toEqual(["engaged(2)", "trial(2)", "settled(3)"]);
        const trialAt = again[1]!.tS;
        expect(trialAt - engagedAt, label).toBeGreaterThanOrEqual(116);
        const atEngage = loop.windows.find((window) => window.tS === engagedAt)!;
        const range = atEngage.config.fallbackDivisors!;
        const period = atEngage.config.fallbackPeriodMs!;
        expect(fallbackDivisorFor(range, period, atEngage.state.fallback.engageIntervalMs), label).toBe(faster + 1);
        // Back on the faster divisor by the retry of the trial's reading, and to the end.
        const settledAt = again[2]!.tS;
        const back = loop.switches.filter(({ tS }) => tS > settledAt + 1);
        expect(back.map(({ cadence }) => cadence.divisor), label).toEqual([faster]);
        expect(back[0]!.tS - settledAt, label).toBeGreaterThanOrEqual(300 - 5);
        expect(back[0]!.tS - settledAt, label).toBeLessThanOrEqual(300 + 60);
        expect(loop.windows.filter((window) => window.tS > back[0]!.tS + 1).every((window) => window.cadence?.divisor === faster), label).toBe(true);
        // At most two switches in any 120 s from the first trial on: the
        // re-entry's trial pair comes 120 s after its engage.
        const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= entered(loop, "trial"));
        for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, `${label}, from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
        expect(expectRetriesMoveNothingElse(loop), label).toBe(1);
        expectRebasesKeepTheFallback(loop);
      }
    }
  });

  it("75 Hz: an 8 s stall on the window of the trial that settles holds divisor 3 only until the retry, about 300 s later (review)", () => {
    // UHD 620-shaped at 46 ms a frame engages at divisor 2, and its first
    // trial fails clearly, which settles it. 15 ms more for 8 s from that
    // trial's start: its reading picks divisor 3. Round 5 settled there and
    // kept nothing to retry, and a host that holds divisor 2 only shed never
    // reaches full quality at 3 for another trial: 25 fps for the session.
    // The trial now keeps the interval it left, as a raise does.
    const host = (stall: readonly [number, number] | null): Machine => ({
      ...uhd620,
      gpuMs: (tS) => 46 + (stall !== null && tS >= stall[0] && tS < stall[1] ? 15 : 0),
    });
    for (const seed of [1, 7]) {
      const label = `seed ${seed}`;
      const trialAt = entered(fly(host(null), { seconds: 300, hz: 75, seed }), "trial");
      const loop = fly(host([trialAt + 0.05, trialAt + 8]), { seconds: 1_200, hz: 75, seed });
      expect(sequence(loop), label).toEqual(["off", "engaged", "trial", "settled"]);
      expect(entered(loop, "trial"), label).toBe(trialAt);
      const settledAt = entered(loop, "settled");
      const atSettle = loop.windows.find((window) => window.tS === settledAt)!;
      const divisorOf = (ms: number): number => fallbackDivisorFor(atSettle.config.fallbackDivisors!, VSYNC_75, ms);
      // Not vacuous: engaged at 2, the stall's reading settled it at 3, and 2's interval is kept.
      expect(divisorOf(atSettle.state.fallback.engageIntervalMs), label).toBe(2);
      expect(divisorOf(atSettle.state.fallback.minIntervalMs), label).toBe(3);
      expect(divisorOf(atSettle.state.fallback.raisedFromMs!), label).toBe(2);
      // Divisor 2 about 300 s after settling, and to the end.
      const back = loop.switches.filter(({ tS }) => tS > settledAt + 1);
      expect(back.map(({ cadence }) => cadence.divisor), label).toEqual([2]);
      expect(back[0]!.tS - settledAt, label).toBeGreaterThanOrEqual(300 - 5);
      expect(back[0]!.tS - settledAt, label).toBeLessThanOrEqual(300 + 60);
      expect(loop.windows.filter((window) => window.tS > back[0]!.tS + 1).every((window) => window.cadence?.divisor === 2), label).toBe(true);
      const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= trialAt);
      for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, `${label}, from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
      expect(expectRetriesMoveNothingElse(loop), label).toBe(1);
      expectRebasesKeepTheFallback(loop);
    }
  });

  it("75, 144 and 165 Hz: a stretch that raises an engaged host and lasts through its trial holds the slower divisor only until the retry, about 300 s after the raise (review)", () => {
    // UHD 620-shaped at 46 ms a frame engages at the faster divisor and holds
    // it shed. From 20 s after the engage until 8 s into the first trial the
    // GPU takes 14 to 16 ms more: the host is raised to the slower divisor
    // while engaged, and the trial reads that one. Round 5 settled there with
    // nothing kept, and a host that holds the faster divisor only shed never
    // reaches full quality at the slower one for another trial: the slower
    // divisor for the session, 16 runs of 16. The trial now keeps the
    // interval the raise rose from, and the raise's clock runs on.
    for (const [hz, faster, extra] of [[75, 2, 15], [144, 4, 14], [165, 5, 16]] as const) {
      for (const seed of [1, 7]) {
        const label = `${hz} Hz, seed ${seed}`;
        const quiet = fly({ ...uhd620, gpuMs: flat(46) }, { seconds: 300, hz, seed });
        const [engagedAt, trialAt] = [entered(quiet, "engaged"), entered(quiet, "trial")];
        const stretch = [engagedAt + 20, trialAt + 8] as const;
        const loop = fly({ ...uhd620, gpuMs: (tS) => 46 + (tS >= stretch[0] && tS < stretch[1] ? extra : 0) }, { seconds: 1_200, hz, seed });
        expect(sequence(loop), label).toEqual(["off", "engaged", "trial", "settled"]);
        const settledAt = entered(loop, "settled");
        const atSettle = loop.windows.find((window) => window.tS === settledAt)!;
        const range = atSettle.config.fallbackDivisors!;
        const period = atSettle.config.fallbackPeriodMs!;
        const divisorOf = (ms: number): number => fallbackDivisorFor(range, period, ms);
        // Not vacuous: engaged at the faster divisor, raised to the slower one
        // by the stretch before the trial, and the trial settled there.
        const raise = loop.switches.find(({ tS, cadence }) => tS > stretch[0] && tS < entered(loop, "trial") && cadence.divisor === faster + 1);
        expect(raise, label).toBeDefined();
        expect(divisorOf(atSettle.state.fallback.engageIntervalMs), label).toBe(faster);
        expect(divisorOf(atSettle.state.fallback.minIntervalMs), label).toBe(faster + 1);
        expect(divisorOf(atSettle.state.fallback.raisedFromMs!), label).toBe(faster);
        // Back on the faster divisor about 300 s after the raise, and to the end.
        const back = loop.switches.filter(({ tS }) => tS > settledAt + 1);
        expect(back.map(({ cadence }) => cadence.divisor), label).toEqual([faster]);
        expect(back[0]!.tS - raise!.tS, label).toBeGreaterThanOrEqual(300 - 5);
        expect(back[0]!.tS - raise!.tS, label).toBeLessThanOrEqual(300 + 30);
        expect(loop.windows.filter((window) => window.tS > back[0]!.tS + 1).every((window) => window.cadence?.divisor === faster), label).toBe(true);
        const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= entered(loop, "trial"));
        for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, `${label}, from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
        expect(expectRetriesMoveNothingElse(loop), label).toBe(1);
        expectRebasesKeepTheFallback(loop);
      }
    }
  });

  it("75 Hz: a host engaged at divisor 2 that cannot hold it even shed retries 2 only with the backoff, 300 s then 600 s after a raise (review)", () => {
    // UHD 620-shaped at 50 ms a frame: the exhausting window's mean, 2.04
    // refreshes, fits divisor 2, which the host holds shed for three windows
    // and then misses by 7%, so it is raised to 3 while engaged and its trial
    // reads 3. The interval the raise rose from is kept, as a settled
    // raise's is, so the host retries 2 and is raised back, and each retry
    // that ends in a raise doubles the wait: what any raise costs a host
    // that only just fails to hold the faster divisor.
    const loop = fly(uhd620, { seconds: 1_500, hz: 75, seed: 1 });
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "settled"]);
    const trialAt = entered(loop, "trial");
    const engaged = judgedIn(loop, "engaged").filter((window) => window.tS < trialAt);
    const range = engaged[0]!.config.fallbackDivisors!;
    const divisorOf = (ms: number): number => fallbackDivisorFor(range, VSYNC_75, ms);
    // Not vacuous: engaged at divisor 2, raised to 3 before the trial.
    expect(divisorOf(engaged.at(-1)!.state.fallback.engageIntervalMs)).toBe(2);
    expect(divisorOf(engaged.at(-1)!.state.fallback.minIntervalMs)).toBe(3);
    const raisedAt = loop.switches.find(({ tS, cadence }) => tS < trialAt && cadence.divisor === 3)!.tS;
    const settledAt = entered(loop, "settled");
    expect(divisorOf(loop.windows.find((window) => window.tS === settledAt)!.state.fallback.raisedFromMs!)).toBe(2);
    // Settled windows whose shortest interval rose (a raise) or fell (a retry).
    const moves = (rose: boolean): number[] => loop.windows.filter((window, index) => {
      const was = loop.windows[index - 1]?.state.fallback;
      const now = window.state.fallback;
      if (was?.phase !== "settled" || now.phase !== "settled") return false;
      return rose ? now.minIntervalMs > was.minIntervalMs + 1e-9 : now.minIntervalMs < was.minIntervalMs - 1e-9;
    }).map(({ tS }) => tS);
    const [raises, retries] = [moves(true), moves(false)];
    expect(retries).toHaveLength(2);
    expect(raises).toHaveLength(2);
    expect(retries[0]! - raisedAt).toBeGreaterThanOrEqual(300 - 5);
    expect(retries[0]! - raisedAt).toBeLessThanOrEqual(300 + 30);
    expect(retries[1]! - raises[0]!).toBeGreaterThanOrEqual(600 - 5);
    for (const [index, retryAt] of retries.entries()) {
      expect(raises[index]! - retryAt).toBeGreaterThan(0);
      expect(raises[index]! - retryAt).toBeLessThan(180);
    }
    // The next waits 1200 s, past the run; divisor 3 for at least 70% of the time from the settle.
    expect(loop.windows.at(-1)!.state.fallback).toMatchObject({ settledRetries: 2 });
    const since = judgedIn(loop, "settled");
    expect(since.filter((window) => window.cadence?.divisor === 3).length / since.length).toBeGreaterThan(0.7);
    const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= trialAt);
    for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, `from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
    expect(expectRetriesMoveNothingElse(loop)).toBe(2);
    expectRebasesKeepTheFallback(loop);
  });

  it("144 and 165 Hz: a heavier load that ends 20 s after the engage holds the slower divisor only until the retry (review)", () => {
    // GPU 60 ms until 20 s after the engage, then 46: the engage chooses the
    // slower divisor, the trial (fully shed, at the lighter load) reads the
    // faster one calm, and the floor holds the slower. The light load alone
    // holds the faster one.
    for (const [hz, faster] of [[144, 4], [165, 5]] as const) {
      for (const seed of [1, 7]) {
        const label = `${hz} Hz, seed ${seed}`;
        const engagedAt = entered(fly({ ...uhd620, gpuMs: flat(60) }, { seconds: 400, hz, seed }), "engaged");
        const loop = fly({ ...uhd620, gpuMs: (tS) => (tS < engagedAt + 20 ? 60 : 46) }, { seconds: 1_500, hz, seed });
        expect(sequence(loop), label).toEqual(["off", "engaged", "trial", "settled"]);
        const settledAt = entered(loop, "settled");
        const atSettle = loop.windows.find((window) => window.tS === settledAt)!;
        const range = atSettle.config.fallbackDivisors!;
        const period = atSettle.config.fallbackPeriodMs!;
        expect(fallbackDivisorFor(range, period, atSettle.state.fallback.minIntervalMs), label).toBe(faster + 1);
        expect(fallbackDivisorFor(range, period, atSettle.state.fallback.raisedFromMs!), label).toBe(faster);
        const back = loop.switches.filter(({ tS }) => tS > settledAt + 1);
        expect(back.map(({ cadence }) => cadence.divisor), label).toEqual([faster]);
        expect(back[0]!.tS - settledAt, label).toBeLessThanOrEqual(600);
        const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= entered(loop, "trial"));
        for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, label).toBeLessThanOrEqual(2);
        expectRebasesKeepTheFallback(loop);
      }
    }
  });

  it("75, 144 and 165 Hz: after a heavy engaging window, a host at full quality on the faster divisor stays there, though every settled trial fails (review)", () => {
    // 45 ms (50 at 165 Hz) until 10 s after the engage, then 20 (22): the
    // engage chooses the slower divisor, the first trial reads the faster one
    // and the floor holds the slower, and the retry returns to the faster one
    // 300 s later. There the host reaches full quality, so a settled trial at
    // 60 follows and fails every 300 s, reading the faster divisor. Before a
    // failed trial was floored at the divisor it left, each one put the host
    // back on the engage's slower divisor and kept its reading for another
    // retry 300 s later: 70 to 80% of the time at the slower divisor.
    for (const [hz, heavyMs, lightMs, faster] of [[75, 45, 20, 2], [144, 45, 20, 4], [165, 50, 22, 5]] as const) {
      for (const seed of [1, 7]) {
        const label = `${hz} Hz, seed ${seed}`;
        const engagedAt = entered(fly(littleToShed(flat(heavyMs)), { seconds: 400, hz, seed }), "engaged");
        const loop = fly(littleToShed((tS) => (tS < engagedAt + 10 ? heavyMs : lightMs)), { seconds: 1_800, hz, seed });
        expect(sequence(loop).slice(0, 4), label).toEqual(["off", "engaged", "trial", "settled"]);
        // Not vacuous: settled on the engage's slower divisor with the faster reading kept to retry ...
        const settledAt = entered(loop, "settled");
        const atSettle = loop.windows.find((window) => window.tS === settledAt)!;
        const range = atSettle.config.fallbackDivisors!;
        const period = atSettle.config.fallbackPeriodMs!;
        const divisorOf = (ms: number): number => fallbackDivisorFor(range, period, ms);
        expect(divisorOf(atSettle.state.fallback.engageIntervalMs), label).toBe(faster + 1);
        expect(divisorOf(atSettle.state.fallback.minIntervalMs), label).toBe(faster + 1);
        expect(divisorOf(atSettle.state.fallback.raisedFromMs!), label).toBe(faster);
        // ... and at least two settled trials left the faster divisor and failed.
        const failedFromFaster = loop.windows.filter((window, index) => {
          const was = loop.windows[index - 1]?.state.fallback;
          return was?.phase === "trial" && window.state.fallback.phase === "settled" && divisorOf(was.minIntervalMs) === faster;
        });
        expect(failedFromFaster.length, label).toBeGreaterThanOrEqual(2);
        // From 600 s after settling, at least 90% of the time on the faster divisor.
        let [total, atFaster] = [0, 0];
        loop.windows.forEach((window, index) => {
          const fromS = Math.max(settledAt + 600, loop.windows[index - 1]?.tS ?? 0);
          if (window.tS <= fromS) return;
          total += window.tS - fromS;
          if (window.cadence?.fallbackHz !== undefined && window.cadence.divisor === faster) atFaster += window.tS - fromS;
        });
        expect(total, label).toBeGreaterThan(900);
        expect(atFaster / total, label).toBeGreaterThanOrEqual(0.9);
        // One retry, and at most two switches in any 120 s from the first trial on.
        expect(expectRetriesMoveNothingElse(loop), label).toBe(1);
        const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= entered(loop, "trial"));
        for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, `${label}, from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
        expectRebasesKeepTheFallback(loop);
      }
    }
  });

  it("60 Hz: a settled raise keeps nothing to retry, so the trial at 60 follows full quality by the calm streak (review)", () => {
    // Settled at 30; a minute later too slow for 30 even shed for 60 s (a
    // raise, which moves no divisor at 60 Hz), then light enough for 60. It
    // recovers to full quality at 30, and the trial at 60 should follow its
    // calm streak, not a retry's wait.
    const seed = 1;
    const settledAt = entered(fly(uhd620, { seconds: 400, hz: 60, seed }), "settled");
    const [heavyFrom, lightFrom] = [settledAt + 60, settledAt + 120];
    const loop = fly({ ...uhd620, gpuMs: (tS) => (tS < heavyFrom ? 50 : tS < lightFrom ? 85 : 12) }, { seconds: lightFrom + 900, hz: 60, seed });
    const settled = loop.windows.filter((window) => window.tS > settledAt && window.state.fallback.phase === "settled");
    // Not vacuous: the heavy minute raised the interval.
    expect(settled.some((window) => window.state.fallback.minIntervalMs > 2.5 * VSYNC_60)).toBe(true);
    // Nothing kept to retry, no retry, no retry counted, no retry clock.
    expect(settled.every((window) => window.state.fallback.raisedFromMs === null && window.state.fallback.retryDueInMs === 0
      && window.state.fallback.settledRetries === 0)).toBe(true);
    expect(expectRetriesMoveNothingElse(loop)).toBe(0);
    const fullQuality = loop.windows.find((window) => window.tS > lightFrom && window.state.gpuWorkLevel === 0
      && window.state.cpuWorkLevel === 0 && window.state.renderScale >= window.config.scaleCeiling - 1e-6)!;
    const trialAt = entered(loop, "trial", lightFrom);
    // The settled wait left at full quality, plus a calm streak and a window.
    const waitLeft = Math.max(0, settledAt + 300 - fullQuality.tS);
    expect(trialAt - fullQuality.tS).toBeLessThanOrEqual(waitLeft + 20);
    expect(loop.switches.filter(({ tS }) => tS > settledAt + 1 && tS < trialAt)).toEqual([]);
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

  it("75, 144 and 165 Hz, a heavy minute every three for an hour: the fallback settles, and at most two switches in any 120 s after 1200 s (review)", () => {
    // Heavy for the first two minutes, light (11 ms) until 190 s, then heavy
    // for 60 s in every 170 or 180. Round 6 never settled at an engage: each
    // trial landed in a light stretch and passed, and the next heavy stretch
    // engaged again within 240 s, for the session (at 165 Hz 21 engages, no
    // settle, and 12 windows of 120 s over two switches after 1200 s). The
    // third early re-entry settles at the engage now.
    for (const [hz, heavyMs, periodS] of [[75, 50, 180], [144, 52, 170], [165, 58, 170]] as const) {
      const label = `${hz} Hz, ${heavyMs}/11 ms, 60 s in ${periodS}`;
      const host: Machine = {
        ...uhd620,
        cpuMs: flat(8),
        gpuMs: (tS) => (tS < 120 ? heavyMs : tS < 190 ? 11 : (tS - 190) % periodS < 60 ? heavyMs : 11),
      };
      const loop = fly(host, { seconds: 3_600, hz, seed: 1 });
      const settledAt = entered(loop, "settled");
      expect(settledAt, label).toBeLessThan(1_200);
      expect(loop.phases.filter(({ phase }) => phase === "engaged").length, label).toBeLessThanOrEqual(4);
      const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= 1_200);
      for (const from of times) {
        expect(times.filter((tS) => tS >= from && tS < from + 120).length, `${label}, from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
      }
      expectRebasesKeepTheFallback(loop);
    }
  });

  it("75 Hz: a third early re-entry on a heavy window settles at the engage, keeps the passed trial's interval, and is back on divisor 2 about 300 s later (review)", () => {
    // UHD 620-shaped. Off, 61 ms a frame: it engages; 5 s after each engage,
    // 10 ms, so each trial passes, and the heavy load comes back with the
    // exit: early re-entries, each counted as a failed trial. The third
    // settles at the engage, on the heavy window's mean (divisor 3), and 5 s
    // on the load drops to 46 ms for good, which holds divisor 2 only shed
    // and never reaches full quality at 3 for a settled trial. Settled with
    // nothing kept, it stayed on divisor 3 for the session; the passed
    // trial's interval, kept, is retried 300 s on.
    let engages = 0;
    let engagedAt = 0;
    let last: CadenceFallbackPhase = "off";
    const gpuMs = (tS: number, phase: CadenceFallbackPhase): number => {
      if (phase !== last) {
        if (last === "off") [engages, engagedAt] = [engages + 1, tS];
        last = phase;
      }
      if (phase === "off") return 61;
      if (tS < engagedAt + 5) return 61;
      return engages > 3 ? 46 : 10;
    };
    const loop = fly({ ...uhd620, gpuMs }, { seconds: 2_000, hz: 75, seed: 1 });
    expect(loop.phases.slice(0, 10).map(({ phase, failedTrials }) => `${phase}(${failedTrials})`)).toEqual([
      "engaged(0)", "trial(0)", "off(0)",
      "engaged(1)", "trial(1)", "off(1)",
      "engaged(2)", "trial(2)", "off(2)",
      "settled(3)",
    ]);
    const settledAt = loop.phases[9]!.tS;
    const atSettle = loop.windows.find((window) => window.tS === settledAt)!;
    const range = atSettle.config.fallbackDivisors!;
    const period = atSettle.config.fallbackPeriodMs!;
    expect(fallbackDivisorFor(range, period, atSettle.state.fallback.minIntervalMs)).toBe(3);
    // The passed trial's window mean, kept to retry: divisor 2.
    const kept = atSettle.state.fallback.raisedFromMs;
    expect(kept).toBe(loop.windows.find((window) => window.tS === loop.phases[8]!.tS)!.signals.intervalMeanMs);
    expect(fallbackDivisorFor(range, period, kept!)).toBe(2);
    expect(atSettle.state.fallback.retryDueInMs).toBe(300_000);
    // Each re-entry came within seconds of its pass, well inside the 240 s that forgive.
    for (const index of [3, 6, 9]) expect(loop.phases[index]!.tS - loop.phases[index - 1]!.tS).toBeLessThan(60);
    // Back on divisor 2 by the retry, about 300 s after the settle, and to the end.
    const back = loop.switches.filter(({ tS }) => tS > settledAt + 1);
    expect(back.map(({ cadence }) => cadence.divisor)).toEqual([2]);
    expect(back[0]!.tS - settledAt).toBeGreaterThanOrEqual(300 - 5);
    expect(back[0]!.tS - settledAt).toBeLessThanOrEqual(300 + 30);
    expect(loop.windows.filter((window) => window.tS > back[0]!.tS + 1).every((window) => window.cadence?.divisor === 2)).toBe(true);
    expect(loop.phases.slice(10).map(({ phase }) => phase)).toEqual([]);
    // At most two switches in any 120 s from the first trial on.
    const times = loop.switches.map(({ tS }) => tS).filter((tS) => tS >= entered(loop, "trial"));
    for (const from of times) expect(times.filter((tS) => tS >= from && tS < from + 120).length, `from ${from.toFixed(0)} s`).toBeLessThanOrEqual(2);
    expect(expectRetriesMoveNothingElse(loop)).toBe(1);
    expectRebasesKeepTheFallback(loop);
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

  it("a setting toggled 60 → display → 60 after two failed trials keeps them, so the engage waits 120 s for one trial, whose failure settles (red team)", () => {
    const settledAt = entered(fly(narrow, { seconds: 300 }), "settled");
    const away = settledAt + 20;
    const back = settledAt + 80;
    // The heavy load comes back with the toggle, so the governor is exhausted again.
    const loop = fly({ ...narrow, gpuMs: (tS) => (tS < 120 || tS >= away ? 50 : 32) }, {
      seconds: back + 200,
      setting: (tS) => (tS >= away && tS < back ? "display" : "60"),
    });
    // Not the episode afresh (a trial after 60 s, then another after 120 s):
    // one trial after the later wait, and its failure settles. An earlier
    // draft settled at the engage; with no exit behind it, an engage never
    // settles, whatever it carries (review).
    expect(sequence(loop)).toEqual(["off", "engaged", "trial", "engaged", "trial", "settled", "off", "engaged", "trial", "settled"]);
    const [off, engaged, trial, settled] = loop.phases.slice(-4);
    expect(off!.tS).toBeGreaterThanOrEqual(away);
    expect(off!.tS).toBeLessThan(back);
    expect(off!.failedTrials).toBe(2);
    expect(engaged!.tS).toBeGreaterThanOrEqual(back);
    expect(engaged!.failedTrials).toBe(2);
    expect(trial!.tS - engaged!.tS).toBeGreaterThanOrEqual(116);
    expect(settled!.failedTrials).toBe(3);
    // Under Match display, nothing asked and nothing drawn at the fallback.
    expect(loop.windows.filter((window) => window.tS > off!.tS && window.tS < back).every((window) =>
      window.cadence?.fallbackHz === undefined && window.config.cadenceFallbackHz === null)).toBe(true);
    expectRebasesKeepTheFallback(loop);
  });
});
