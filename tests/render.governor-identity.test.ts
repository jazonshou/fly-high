import { describe, expect, it } from "vitest";
import type { QualityLevel, RequestedRenderingMode } from "../src/game/types";
import { resolveGovernedWork } from "../src/render/governedWork";
import {
  createGovernorState,
  governorConfigForProfile,
  nextGovernorDecision,
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
 * is bench-b1's config plus a late threshold only the unfrozen governor
 * reads, a frozen governor never leaves its first state, and at that state,
 * levels (0, 0), the relative levers hand every subsystem what it took
 * before the governor existed.
 */

/** bench-b1's literals for one tier, plus PR B's late threshold. */
function expectedConfig(tier: number, renderScale: number): GovernorConfig {
  const ultra = tier === 3;
  return {
    gpuTargetMs: ultra ? 30 : 13.7,
    presentationTargetMs: ultra ? 1_000 / 30 : 1_000 / 60,
    // 15% over the cadence: 19.17 ms, or 38.33 on Ultra.
    lateIntervalMs: 1.15 * (ultra ? 1_000 / 30 : 1_000 / 60),
    scaleCeiling: renderScale,
    scaleFloor: Math.min(0.75, renderScale),
    windowFrames: 120,
    downCooldownFrames: 90,
    upCooldownFrames: 240,
    insensitiveRearmWindows: 15,
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
  it("is bench-b1's config for every quality and mode, plus the late threshold", () => {
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
      ];
      const initial = createGovernorState(frozen);
      let state = initial;
      for (let window = 0; window < 50; window += 1) {
        state = nextGovernorDecision(state, overloaded[window % overloaded.length]!, frozen);
      }
      expect(state, `${quality} ${mode}`).toBe(initial);
    }
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
      });
    }
  });
});
