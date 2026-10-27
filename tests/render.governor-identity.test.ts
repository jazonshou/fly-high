import { describe, expect, it } from "vitest";
import type { QualityLevel, RequestedRenderingMode } from "../src/game/types";
import { resolveGovernedWork } from "../src/render/governedWork";
import {
  createGovernorState,
  governorConfigForProfile,
  governorExhausted,
  nextGovernorDecision,
  rebaseGovernorState,
  workLeverSettingsFor,
  type GovernorConfig,
  type GovernorSignals,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

/**
 * PR B must move none of the reference pictures and no perf:ab number
 * (design §10). Captures, perf:ab and perf:flight drive FlightRenderer
 * directly, so the presentation cadence stays null, and they pin the render
 * scale, which freezes the governor. These are the guards: a null cadence
 * is bench-b1's config plus a late threshold, recovery spans and a CPU
 * recovery gate only the unfrozen governor reads, a frozen governor never leaves its first state, and at that state,
 * levels (0, 0), the relative levers hand every subsystem what it took
 * before the governor existed.
 *
 * PR B part 2 adds to each: the config carries the tier's own presentation
 * target and the profile's pixel floor ratio, the state starts not urgent,
 * unlatched and with no spent windows, and the levers at (0, 0) leave the
 * cloud march, the CSM and cloud-depth refresh and CDLOD selection on the
 * profile's own values.
 */

/** bench-b1's literals for one tier, plus what only PR B's unfrozen governor reads. */
function expectedConfig(tier: number, renderScale: number): GovernorConfig {
  const ultra = tier === 3;
  return {
    gpuTargetMs: ultra ? 30 : 13.7,
    presentationTargetMs: ultra ? 1_000 / 30 : 1_000 / 60,
    // PR B part 2: what a profile refresh interval counts frames at. A null
    // cadence leaves the presentation target on it.
    tierPresentationTargetMs: ultra ? 1_000 / 30 : 1_000 / 60,
    // 15% over the cadence: 19.17 ms, or 38.33 on Ultra.
    lateIntervalMs: 1.15 * (ultra ? 1_000 / 30 : 1_000 / 60),
    scaleCeiling: renderScale,
    scaleFloor: Math.min(0.75, renderScale),
    // PR B part 2 (G4): informational; scaleFloor does not read it yet.
    pixelFloorRatio: tier <= 1 ? 0.6 : 0.5625,
    windowFrames: 120,
    downCooldownFrames: 90,
    upCooldownFrames: 240,
    insensitiveRearmWindows: 15,
    // 30/60/120 s, 120 s and 30 s, in windows of frames at the target.
    recoveryBackoffWindows: ultra ? [8, 15, 30] : [15, 30, 60],
    strikeForgivenAfterWindows: ultra ? 30 : 60,
    lateFailureWindows: ultra ? 8 : 15,
    cpuRecoveryCeilingMs: 0.9 * (ultra ? 1_000 / 30 : 1_000 / 60),
  };
}

const PAIRS: readonly [QualityLevel, RequestedRenderingMode, number, number][] = [
  // [quality, mode, tier, render scale]
  ["low", "performance", 0, 0.72],
  ["low", "balanced", 0, 0.72],
  ["low", "ultra", 1, 0.86],
  ["medium", "performance", 0, 0.72],
  ["medium", "balanced", 1, 0.86],
  ["medium", "ultra", 2, 1],
  ["high", "performance", 1, 0.86],
  ["high", "balanced", 2, 1],
  ["high", "ultra", 3, 1],
];

describe("the governor without a cadence (captures, perf:ab, perf:flight)", () => {
  it("is bench-b1's config for every quality and mode, plus what only the unfrozen governor reads", () => {
    for (const [quality, mode, tier, renderScale] of PAIRS) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      expect(profile.tier, `${quality} ${mode}`).toBe(tier);
      expect(governorConfigForProfile(profile), `${quality} ${mode}`).toEqual(expectedConfig(tier, renderScale));
      expect(governorConfigForProfile(profile, null), `${quality} ${mode}`).toEqual(governorConfigForProfile(profile));
    }
    expect(governorConfigForProfile(resolveWebGpuQualityProfile("medium", "balanced")).lateIntervalMs)
      .toBeCloseTo(19.167, 3);
    expect(governorConfigForProfile(resolveWebGpuQualityProfile("high", "ultra")).lateIntervalMs)
      .toBeCloseTo(38.333, 3);
  });

  it("is frozen while pinned, and returns the very state it was given", () => {
    for (const [quality, mode] of PAIRS) {
      const frozen = Object.freeze({
        ...governorConfigForProfile(resolveWebGpuQualityProfile(quality, mode)),
        frozen: true,
      });
      const overloaded: readonly GovernorSignals[] = [
        { gpuP95Ms: 40, cpuP95Ms: 40, intervalP95Ms: 45 },
        { gpuP95Ms: null, cpuP95Ms: 14, intervalP95Ms: 33.3, intervalMeanMs: 25, lateFraction: 0.5, streamingBacklog: 40 },
        { gpuP95Ms: null, cpuP95Ms: 4, intervalP95Ms: 16.67, intervalMeanMs: 16.67, lateFraction: 0 },
        // PR B part 2 (G6): every frame a refresh late, a mean twice the target.
        { gpuP95Ms: null, cpuP95Ms: 30, intervalP95Ms: 33.33, intervalMeanMs: 33.33, lateFraction: 1 },
      ];
      const initial = createGovernorState(frozen);
      let state = initial;
      for (let window = 0; window < 50; window += 1) {
        state = nextGovernorDecision(state, overloaded[window % overloaded.length]!, frozen);
      }
      expect(state, `${quality} ${mode}`).toBe(initial);
    }
  });

  it("starts not urgent, unlatched and with no spent windows, and a rebase clears urgency and the count", () => {
    for (const [quality, mode] of PAIRS) {
      const initial = createGovernorState(governorConfigForProfile(resolveWebGpuQualityProfile(quality, mode)));
      expect(initial, `${quality} ${mode}`).toMatchObject({ urgent: false, latchedAtGpuLevel: null, spentWindows: 0 });
      expect(governorExhausted(initial), `${quality} ${mode}`).toBe(false);
    }
    const spent = Object.freeze({
      ...createGovernorState(governorConfigForProfile(resolveWebGpuQualityProfile("low", "balanced"))),
      urgent: true,
      latchedAtGpuLevel: 4,
      spentWindows: 4,
    });
    expect(governorExhausted(spent)).toBe(true);
    // The cadence moving is a new judgement; the latch it was set at stays.
    expect(rebaseGovernorState(spent)).toMatchObject({ urgent: false, latchedAtGpuLevel: 4, spentWindows: 0 });
  });
});

describe("the work levers at levels (0, 0)", () => {
  it("hand every subsystem exactly the profile's own values", () => {
    for (const [quality, mode] of PAIRS) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      expect(resolveGovernedWork(profile, workLeverSettingsFor(0, 0)), `${quality} ${mode}`).toEqual({
        terrainPageRequestsPerUpdate: Number.POSITIVE_INFINITY,
        computeBudgetScale: 1,
        detailGenerationCap: null,
        activeAnimalBudget: profile.activeAnimalBudget,
        cloudShadowIntervalFloor: null,
        shadowCasterDistanceMeters: Number.POSITIVE_INFINITY,
        vegetationDistance: profile.vegetationDistance,
        groundCoverGateScale: 1,
        cloudMarchScale: 1,
        shadowRefreshFrames: profile.shadowRefreshFrames,
        shadowRefreshExtraFrames: 0,
        cloudDepthRefreshFrames: profile.cloudDepthRefreshFrames,
        cloudDepthRefreshExtraFrames: 0,
        cdlodNodeBudget: profile.cdlodNodeBudget,
        cdlodPixelThreshold: profile.cdlodPixelThreshold,
      });
    }
  });
});
