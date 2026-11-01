import { describe, expect, it } from "vitest";
import {
  GOVERNED_MIN_RENDER_PIXELS,
  resolveGovernedHardwareScalingLevel,
  scalingLevelChanged,
  type HardwareScalingInputs,
} from "../src/render/renderScaleLevel";
import {
  EXHAUSTED_AFTER_WINDOWS,
  GPU_WORK_MAX_LEVEL,
  createGovernorState,
  governorConfigForProfile,
  governorExhausted,
  nextGovernorDecision,
  observeRenderScaleApplication,
  summariseIntervals,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import {
  frameTimingPercentile95,
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";

/**
 * PR B part 2 (K2, design §3.2-3.5): the governor's resolution floor is a
 * share of the capped pixels, renderScale × sqrt(governorPixelFloorRatio),
 * and the step applies after the pixel cap (R5). Part 1's fixed 0.75 left
 * tier 0 no resolution lever at all.
 *
 * A step that would leave under half a step above the floor goes to the
 * floor, so the walk down from the ceiling moves the pixels by 8% or more a
 * step, and a step back onto the floor after one recovery step by 6% or
 * more. Without the rule tier 0's last step would move them by 4%: a resize,
 * a reallocation and a history reset no step test can judge. The renderer's
 * 0.4 Mpx minimum, with its 4% snap, absorbs what is left on a small Low
 * viewport: such a step leaves the level unchanged, and the anti-ratchet
 * latch restores a scale at that same level, so nothing resizes.
 *
 * K3 (G6) adds the spent count: a re-armed step the minimum absorbs is a
 * probe, which neither resets nor advances it, so a Low host that has shed
 * everything stays exhausted across the re-arm.
 *
 * Every trace here is shipping-shaped: no GPU timestamps, intervals on whole
 * refreshes.
 */

const low = resolveWebGpuQualityProfile("low", "balanced");
const medium = resolveWebGpuQualityProfile("medium", "balanced");
const high = resolveWebGpuQualityProfile("high", "balanced");
const ultra = resolveWebGpuQualityProfile("high", "ultra");

/** One window of 120 frames on whole refreshes of the target, `late` of them one target late. */
function window(config: GovernorConfig, late: number, cpuP95Ms = 4): GovernorSignals {
  const onTime = config.presentationTargetMs;
  const slowFrames = Math.round(Math.min(1, Math.max(0, late)) * 120);
  const intervals = Array.from({ length: 120 }, (_, frame) => (frame < slowFrames ? 2 * onTime : onTime));
  const { mean, late: lateFraction } = summariseIntervals(intervals, config.lateIntervalMs);
  return {
    gpuP95Ms: null,
    cpuP95Ms,
    intervalP95Ms: frameTimingPercentile95(intervals),
    intervalMeanMs: mean,
    lateFraction,
  };
}

/** The render scales a trace stepped through, in order, from the first state's. */
function scalePath(start: GovernorState, states: readonly GovernorState[]): number[] {
  const path = [start.renderScale];
  for (const state of states) {
    if (state.renderScale !== path[path.length - 1]) path.push(state.renderScale);
  }
  return path;
}

function withRatio(profile: WebGpuQualityProfile, governorPixelFloorRatio: number): WebGpuQualityProfile {
  return { ...profile, governorPixelFloorRatio };
}

describe("the governor's resolution floor (G4)", () => {
  it("is renderScale × sqrt(the pixel floor ratio) on every tier", () => {
    expect(low.tier).toBe(0);
    expect(medium.tier).toBe(1);
    expect(high.tier).toBe(2);
    expect(ultra.tier).toBe(3);
    expect(governorConfigForProfile(low).scaleFloor).toBeCloseTo(0.557710, 6);
    expect(governorConfigForProfile(medium).scaleFloor).toBeCloseTo(0.666153, 6);
    // 9/16 is exact and sqrt rounds correctly: High and Ultra keep part 1's 0.75.
    expect(Object.is(governorConfigForProfile(high).scaleFloor, 0.75)).toBe(true);
    expect(Object.is(governorConfigForProfile(ultra).scaleFloor, 0.75)).toBe(true);
    // D4's other answer.
    expect(governorConfigForProfile(withRatio(low, 0.5)).scaleFloor).toBeCloseTo(0.509117, 6);
    expect(governorConfigForProfile(withRatio(medium, 0.5)).scaleFloor).toBeCloseTo(0.608112, 6);
  });

  it("is reached from the ceiling in steps that each move the pixels by 8% or more", () => {
    const cases: readonly [WebGpuQualityProfile, readonly number[]][] = [
      [low, [0.72, 0.67, 0.62, 0.557710]],
      [withRatio(low, 0.5), [0.72, 0.67, 0.62, 0.57, 0.509117]],
      [medium, [0.86, 0.81, 0.76, 0.71, 0.666153]],
      [withRatio(medium, 0.5), [0.86, 0.81, 0.76, 0.71, 0.66, 0.608112]],
      [high, [1, 0.95, 0.9, 0.85, 0.8, 0.75]],
      [ultra, [1, 0.95, 0.9, 0.85, 0.8, 0.75]],
    ];
    for (const [profile, expected] of cases) {
      const config = governorConfigForProfile(profile);
      const label = `tier ${profile.tier} at ${profile.governorPixelFloorRatio}`;
      // A GPU-bound host that every step helps (its late share falls from
      // all frames at the ceiling to a fifth at the floor) and that is still
      // off cadence at the floor, so the scale walks all the way down.
      const lateAt = (scale: number) =>
        0.2 + (0.8 * (scale - config.scaleFloor)) / (config.scaleCeiling - config.scaleFloor);
      const start = createGovernorState(config);
      const states: GovernorState[] = [];
      let state = start;
      for (let index = 0; index < 20; index += 1) {
        state = nextGovernorDecision(state, window(config, lateAt(state.renderScale)), config);
        states.push(state);
      }
      const path = scalePath(start, states);
      expect(path, label).toHaveLength(expected.length);
      path.forEach((scale, step) => expect(scale, `${label}, step ${step}`).toBeCloseTo(expected[step]!, 6));
      expect(path[path.length - 1], label).toBe(config.scaleFloor);
      expect(states.some((each) => each.resolutionInsensitive), label).toBe(false);
      for (let step = 1; step < path.length; step += 1) {
        const pixels = (path[step]! / path[step - 1]!) ** 2;
        expect(pixels, `${label}, step ${step}`).toBeLessThan(0.92);
      }
    }
  });

  it("is reached by 6% or more of the pixels from a recovery step above it", () => {
    // [profile, the pixels the step back to the floor cuts]
    const cases: readonly [WebGpuQualityProfile, number][] = [
      [low, 0.084],
      [medium, 0.071],
      [high, 0.0635],
      [ultra, 0.0635],
    ];
    for (const [profile, cut] of cases) {
      const config = governorConfigForProfile(profile);
      const label = `tier ${profile.tier}`;
      // The host of the test above walks down to the floor, where it is on
      // cadence until one +0.025 recovery has passed its trial; then it is
      // late again. The next step down would leave under half a step above
      // the floor, so it goes to the floor: the smallest step the rule allows.
      const lateAt = (scale: number) =>
        0.2 + (0.8 * (scale - config.scaleFloor)) / (config.scaleCeiling - config.scaleFloor);
      const start = createGovernorState(config);
      const states: GovernorState[] = [];
      let state = start;
      let floored = false;
      let recovered = false;
      for (let index = 0; index < 120; index += 1) {
        const late = !floored ? lateAt(state.renderScale) : !recovered || state.trial !== null ? 0 : 0.2;
        state = nextGovernorDecision(state, window(config, late), config);
        states.push(state);
        if (state.renderScale === config.scaleFloor) {
          if (recovered) break;
          floored = true;
        } else if (floored) {
          recovered = true;
        }
      }
      const path = scalePath(start, states);
      const above = config.scaleFloor + 0.025;
      expect(path.slice(-3), label).toEqual([config.scaleFloor, above, config.scaleFloor]);
      expect(states.some((each) => each.resolutionInsensitive), label).toBe(false);
      expect(1 - (config.scaleFloor / above) ** 2, label).toBeCloseTo(cut, 3);
    }
  });
});

interface Replayed {
  readonly state: GovernorState;
  /** Rendered megapixels at the level applied after this window. */
  readonly megapixels: number;
  readonly resized: boolean;
}

/**
 * A GPU-bound Low host replayed through the governor, the governed resolver
 * and `observeRenderScaleApplication` as FlightRenderer.updateGovernor runs
 * them: a level that moves by more than the epsilon resizes; one that does
 * not is "unchanged", and a downward step that changed nothing latches.
 * Its late share grows with the pixels it renders (1.5 per Mpx, less 0.35:
 * 47% at 0.544 Mpx, 25% at 0.4 Mpx), so every real step is judged to work
 * and the host is still late at the minimum.
 */
function replay(cssWidth: number, cssHeight: number, windows: number): Replayed[] {
  const config = governorConfigForProfile(low);
  const display: Omit<HardwareScalingInputs, "renderScale"> = {
    cssWidth,
    cssHeight,
    devicePixelRatio: 1,
    maxDevicePixelRatio: low.maxDevicePixelRatio,
    maxRenderPixels: low.maxRenderPixels,
  };
  const levelAt = (renderScale: number) => resolveGovernedHardwareScalingLevel({
    ...display,
    renderScale,
    ceilingScale: config.scaleCeiling,
    minRenderPixels: GOVERNED_MIN_RENDER_PIXELS,
  });
  const megapixelsAt = (level: number) => (cssWidth * cssHeight) / (level * level) / 1e6;
  let applied = levelAt(config.scaleCeiling);
  let state = createGovernorState(config);
  const out: Replayed[] = [];
  for (let index = 0; index < windows; index += 1) {
    const previous = state;
    state = nextGovernorDecision(state, window(config, 1.5 * megapixelsAt(applied) - 0.35), config);
    let resized = false;
    if (Math.abs(state.renderScale - previous.renderScale) > 1e-6) {
      const level = levelAt(state.renderScale);
      const changed = scalingLevelChanged(level, applied);
      if (changed) {
        applied = level;
        resized = true;
      }
      if (state.renderScale < previous.renderScale) {
        state = observeRenderScaleApplication(state, changed, config);
        const restored = levelAt(state.renderScale);
        if (scalingLevelChanged(restored, applied)) {
          applied = restored;
          resized = true;
        }
      }
    }
    out.push({ state, megapixels: megapixelsAt(applied), resized });
  }
  return out;
}

/** The megapixels after each resize, from the first window's. */
function pixelPath(replayed: readonly Replayed[]): number[] {
  return [replayed[0]!.megapixels, ...replayed.filter((each) => each.resized).map((each) => each.megapixels)]
    .map((megapixels) => Number(megapixels.toFixed(3)));
}

describe("a step the 0.4 Mpx minimum absorbs (G4, red team)", () => {
  it("at 1366×768 on Low: two real steps, then an absorbed one that latches without a resize", () => {
    const replayed = replay(1366, 768, 60);
    expect(pixelPath(replayed)).toEqual([0.544, 0.471, 0.4]);
    // The step to the floor (0.62 → 0.5577) is absorbed: the level stays and
    // the latch restores 0.62, which is at the same level.
    const latched = replayed.findIndex((each) => each.state.resolutionInsensitive);
    expect(latched).toBeGreaterThan(0);
    expect(replayed[latched]!.resized).toBe(false);
    expect(replayed[latched]!.state.renderScale).toBeCloseTo(0.62, 9);
    expect(replayed[latched]!.megapixels).toBeCloseTo(0.4, 3);
    // Resolution shown not to help, the GPU ladder takes over. A latch set
    // before it topped out is stale once it has (G6): re-armed in the next
    // window, the scale is probed again with every rung shed, and the
    // minimum absorbs that step too.
    const topped = replayed.findIndex((each) => each.state.gpuWorkLevel === GPU_WORK_MAX_LEVEL);
    expect(topped).toBeGreaterThan(latched);
    expect(replayed[topped + 1]!.state.resolutionInsensitive).toBe(false);
    expect(replayed[topped + 2]!.state).toMatchObject({ resolutionInsensitive: true, latchedAtGpuLevel: GPU_WORK_MAX_LEVEL });
    // Each 15-window re-arm steps into the same absorbed step and latches
    // again within its window, at the same level: no resize, ever.
    const config = governorConfigForProfile(low);
    const latches = replayed
      .map((each, index) => (each.state.insensitiveWindowsRemaining === config.insensitiveRearmWindows ? index : -1))
      .filter((index) => index >= 0);
    expect(latches).toEqual([latched, latched + 15, topped + 2, topped + 17, topped + 32]);
    expect(replayed.filter((each, index) => index >= latched && !each.state.resolutionInsensitive)).toHaveLength(1);
    expect(replayed.slice(latched).every((each) => each.state.renderScale === replayed[latched]!.state.renderScale)).toBe(true);
    expect(replayed.filter((each) => each.resized)).toHaveLength(2);
    expect(replayed.every((each) => each.megapixels > 0.4 - 1e-9)).toBe(true);
    // With nothing left to shed and still a quarter of its frames late (a
    // mean of 20.8 ms, over 1.2× the target), every window from the fresh
    // latch on is spent. The re-arm's step is a probe: the count holds
    // through it, so the governor stays exhausted.
    const exhausted = replayed.findIndex((each) => governorExhausted(each.state));
    expect(exhausted).toBe(topped + 2 + EXHAUSTED_AFTER_WINDOWS);
    expect(replayed.slice(exhausted).every((each) => governorExhausted(each.state))).toBe(true);
    for (const rearm of [topped + 17, topped + 32]) {
      expect(replayed[rearm]!.state.spentWindows).toBe(replayed[rearm - 1]!.state.spentWindows);
      expect(replayed[rearm + 1]!.state.spentWindows).toBe(replayed[rearm - 1]!.state.spentWindows + 1);
    }
  });

  it("at 1280×720 on Low: one real step, snapped onto the minimum, then the absorbed one", () => {
    const replayed = replay(1280, 720, 40);
    expect(pixelPath(replayed)).toEqual([0.478, 0.4]);
    const latched = replayed.findIndex((each) => each.state.resolutionInsensitive);
    expect(latched).toBeGreaterThan(0);
    expect(replayed[latched]!.resized).toBe(false);
    expect(replayed[latched]!.state.renderScale).toBeCloseTo(0.67, 9);
    expect(replayed.filter((each) => each.resized)).toHaveLength(1);
  });

  it("at 1536×864 on Low: every step is real, the last snapped onto the minimum", () => {
    const replayed = replay(1536, 864, 20);
    expect(pixelPath(replayed)).toEqual([0.688, 0.596, 0.51, 0.4]);
    expect(replayed.some((each) => each.state.resolutionInsensitive)).toBe(false);
    expect(replayed[replayed.length - 1]!.state.renderScale).toBe(governorConfigForProfile(low).scaleFloor);
  });
});
