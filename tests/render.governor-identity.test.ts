import { describe, expect, it } from "vitest";
import type { QualityLevel, RequestedRenderingMode } from "../src/game/types";
import { FlightRenderer } from "../src/render/FlightRenderer";
import { resolveGovernedWork } from "../src/render/governedWork";
import {
  cadenceFallbackRequest,
  createGovernorState,
  FALLBACK_OFF,
  governorConfigForProfile,
  governorExhausted,
  nextGovernorDecision,
  rebaseGovernorState,
  workLeverSettingsFor,
  type CadenceFallbackPhase,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import type { FrameRateCap, PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import { resolveWebGpuQualityProfile, type WebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

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
 * target and the profile's pixel floor ratio, which the unfrozen governor's
 * scale floor derives from (G4) and a pin overrides, the state starts not urgent,
 * unlatched and with no spent windows, and the levers at (0, 0) leave the
 * cloud march, the CSM and cloud-depth refresh and CDLOD selection on the
 * profile's own values.
 *
 * Part 2b (G6) adds the even fallback's gate: without a cadence the config
 * allows no fallback, whatever the profile's rate, so a harness never falls
 * back; and the state starts with the fallback off.
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
    // PR B part 2 (G4): that share of the capped pixels. Only the unfrozen
    // governor steps toward it; a pin replaces it (below).
    scaleFloor: renderScale * Math.sqrt(tier <= 1 ? 0.6 : 0.5625),
    pixelFloorRatio: tier <= 1 ? 0.6 : 0.5625,
    // PR B part 2 (G6): no confirmed display period, so urgency and the spent
    // count judge against the target alone.
    displayLimitMs: 0,
    windowFrames: 120,
    downCooldownFrames: 90,
    upCooldownFrames: 240,
    insensitiveRearmWindows: 15,
    // 30/60/120 s, 120 s and 30 s, in windows of frames at the target.
    recoveryBackoffWindows: ultra ? [8, 15, 30] : [15, 30, 60],
    strikeForgivenAfterWindows: ultra ? 30 : 60,
    lateFailureWindows: ultra ? 8 : 15,
    cpuRecoveryCeilingMs: 0.9 * (ultra ? 1_000 / 30 : 1_000 / 60),
    // PR B part 2b (G6): no cadence, so no fallback, no period or divisors
    // for it; and 120 frames at the target.
    cadenceFallbackHz: null,
    fallbackPeriodMs: null,
    fallbackDivisors: null,
    windowMs: 120 * (ultra ? 1_000 / 30 : 1_000 / 60),
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
      // 9/16 is exact and sqrt rounds correctly: tiers 2-3 keep part 1's 0.75 to the bit.
      if (tier >= 2) expect(Object.is(governorConfigForProfile(profile).scaleFloor, 0.75), `${quality} ${mode}`).toBe(true);
    }
    expect(governorConfigForProfile(resolveWebGpuQualityProfile("medium", "balanced")).lateIntervalMs)
      .toBeCloseTo(19.167, 3);
    expect(governorConfigForProfile(resolveWebGpuQualityProfile("high", "ultra")).lateIntervalMs)
      .toBeCloseTo(38.333, 3);
    // PR B part 2 (G6): a confirmed period sets the display limit, at the paced divisor.
    const thirtyHz = { frameCapHz: 60, divisor: 1, displayPeriodMs: 1_000 / 30, periodConfirmed: true } as const;
    expect(governorConfigForProfile(resolveWebGpuQualityProfile("medium", "balanced"), thirtyHz).displayLimitMs)
      .toBeCloseTo(33.333, 3);
  });

  it("pins both scale bounds for a capture, whatever the pixel floor ratio", () => {
    // FlightRenderer.resolveGovernorConfig, on a receiver with only what it reads.
    const resolve = (profile: WebGpuQualityProfile, pinnedRenderScale: number | null): GovernorConfig => {
      const target = Object.assign(Object.create(FlightRenderer.prototype) as object, {
        profile,
        presentationCadence: null,
        pinnedRenderScale,
      });
      return (target as unknown as { resolveGovernorConfig(): GovernorConfig }).resolveGovernorConfig();
    };
    for (const [quality, mode] of PAIRS) {
      for (const governorPixelFloorRatio of [0.5, 0.6, 0.9]) {
        const profile = { ...resolveWebGpuQualityProfile(quality, mode), governorPixelFloorRatio };
        const base = governorConfigForProfile(profile);
        const label = `${quality} ${mode} at ${governorPixelFloorRatio}`;
        expect(resolve(profile, null), label).toEqual(base);
        for (const pin of [profile.renderScale, 0.5]) {
          expect(resolve(profile, pin), label).toEqual({ ...base, frozen: true, scaleCeiling: pin, scaleFloor: pin });
        }
      }
    }
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
      // PR B part 2b (G6): and with the fallback off, so nothing is asked of the pacer.
      expect(initial.fallback, `${quality} ${mode}`).toBe(FALLBACK_OFF);
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
    expect(rebaseGovernorState(spent).fallback).toBe(FALLBACK_OFF);
  });
});

/** A cadence as the pacer reports it: cap, divisor, refresh in Hz (or null) and confirmation. */
function cadenceOf(
  frameCapHz: FrameRateCap,
  divisor: number,
  hz: number | null,
  periodConfirmed: boolean,
  fallbackHz?: number,
): PresentationCadence {
  return {
    frameCapHz,
    divisor,
    displayPeriodMs: hz === null ? null : 1_000 / hz,
    periodConfirmed,
    ...(fallbackHz !== undefined ? { fallbackHz } : {}),
  };
}

describe("the fallback gate (PR B part 2b, G6)", () => {
  const low = resolveWebGpuQualityProfile("low", "balanced");
  const lowAt30 = { ...low, cadenceFallbackHz: 30 };
  const lowAt0 = { ...low, cadenceFallbackHz: 0 };
  // [case, cadence, the config's rate for a profile of 30] (design §21.10).
  const cases: readonly [string, PresentationCadence | null, number | null][] = [
    ["no cadence (every harness)", null, null],
    ["the 60 setting at 60 Hz", cadenceOf(60, 1, 60, true), 30],
    ["the 60 setting at 120 Hz", cadenceOf(60, 2, 120, true), 30],
    ["the 60 setting at 144 Hz", cadenceOf(60, 2, 144, true), 30],
    ["the 60 setting at 75 Hz", cadenceOf(60, 1, 75, true), 30],
    // Red team: a confirmed 50 Hz period is not trusted under the 60 setting,
    // and falling back there gave 25 fps for the session.
    ["the 60 setting on a 50 Hz display", cadenceOf(60, 1, 50, true), null],
    ["the 60 setting on a 30 Hz display", cadenceOf(60, 1, 30, true), null],
    ["the 30 fps setting at 60 Hz", cadenceOf(30, 2, 60, true), null],
    ["Match display at 60 Hz", cadenceOf(null, 1, 60, true), null],
    // Already applied: the divisor is the fallback's, so the range test cannot pass.
    ["the 60 setting at 60 Hz, falling back", cadenceOf(60, 2, 60, true, 30), 30],
    ["the 60 setting with no period yet", cadenceOf(60, 1, null, false), null],
    ["the 60 setting at 60 Hz, unconfirmed", cadenceOf(60, 1, 60, false), null],
  ];

  for (const [name, cadence, hz] of cases) {
    it(`${name}: ${hz === null ? "none" : `${hz} Hz`}, and none for a profile of 0`, () => {
      expect(governorConfigForProfile(lowAt30, cadence).cadenceFallbackHz).toBe(hz);
      expect(governorConfigForProfile(lowAt0, cadence).cadenceFallbackHz).toBeNull();
    });
  }

  it("carries the trusted period and, at the setting's cadence, the divisors the pacer chooses from", () => {
    // [case, cadence, the divisors] wherever the config allows a fallback.
    const allowed: readonly [string, PresentationCadence, readonly [number, number] | null][] = [
      ["60 Hz", cadenceOf(60, 1, 60, true), [2, 2]],
      ["75 Hz", cadenceOf(60, 1, 75, true), [2, 3]],
      ["120 Hz", cadenceOf(60, 2, 120, true), [4, 4]],
      ["144 Hz", cadenceOf(60, 2, 144, true), [4, 5]],
      ["165 Hz", cadenceOf(60, 2, 165, true), [5, 6]],
      // Under the fallback's own cadence the divisor is the fallback's, not the setting's.
      ["60 Hz, falling back", cadenceOf(60, 2, 60, true, 30), null],
      ["75 Hz, falling back", cadenceOf(60, 3, 75, true, 25), null],
    ];
    for (const [name, cadence, divisors] of allowed) {
      const config = governorConfigForProfile(lowAt30, cadence);
      expect(config.cadenceFallbackHz, name).toBe(30);
      expect(config.fallbackPeriodMs, name).toBe(cadence.displayPeriodMs);
      expect(config.fallbackDivisors, name).toEqual(divisors);
    }
    // None wherever the config allows no fallback, and none for a profile of 0.
    for (const [name, cadence, hz] of cases) {
      for (const profile of hz === null ? [lowAt30, lowAt0] : [lowAt0]) {
        const config = governorConfigForProfile(profile, cadence);
        expect(config.fallbackPeriodMs, `${name}, ${profile.cadenceFallbackHz}`).toBeNull();
        expect(config.fallbackDivisors, `${name}, ${profile.cadenceFallbackHz}`).toBeNull();
      }
    }
  });

  it("allows none without a cadence, for every quality and mode at any rate", () => {
    for (const [quality, mode] of PAIRS) {
      for (const cadenceFallbackHz of [0, 30]) {
        const profile = { ...resolveWebGpuQualityProfile(quality, mode), cadenceFallbackHz };
        expect(governorConfigForProfile(profile).cadenceFallbackHz, `${quality} ${mode} at ${cadenceFallbackHz}`).toBeNull();
        expect(governorConfigForProfile(profile, null).cadenceFallbackHz, `${quality} ${mode} at ${cadenceFallbackHz}`).toBeNull();
      }
    }
  });

  it("measures a window's length at the paced interval", () => {
    expect(governorConfigForProfile(low).windowMs).toBeCloseTo(2_000, 9);
    expect(governorConfigForProfile(low, cadenceOf(60, 2, 144, true)).windowMs).toBeCloseTo(120 * 2_000 / 144, 9);
    expect(governorConfigForProfile(low, cadenceOf(30, 2, 60, true)).windowMs).toBeCloseTo(4_000, 9);
    // Under the fallback the window runs at its interval: 30 fps at 60 Hz.
    expect(governorConfigForProfile(lowAt30, cadenceOf(60, 2, 60, true, 30)).windowMs).toBeCloseTo(4_000, 9);
  });

  /** A state in `phase`, as the fallback machine will leave it. */
  function inPhase(config: GovernorConfig, phase: CadenceFallbackPhase): GovernorState {
    return Object.freeze({
      ...createGovernorState(config),
      fallback: Object.freeze({ ...FALLBACK_OFF, phase, minIntervalMs: 22 }),
    });
  }

  it("asks the pacer for the fallback only while engaged or settled, and never frozen", () => {
    const config = governorConfigForProfile(lowAt30, cadenceOf(60, 1, 60, true));
    expect(cadenceFallbackRequest(createGovernorState(config), config)).toBeNull();
    expect(cadenceFallbackRequest(inPhase(config, "off"), config)).toBeNull();
    expect(cadenceFallbackRequest(inPhase(config, "trial"), config)).toBeNull();
    expect(cadenceFallbackRequest(inPhase(config, "engaged"), config)).toEqual({ hz: 30, minIntervalMs: 22 });
    expect(cadenceFallbackRequest(inPhase(config, "settled"), config)).toEqual({ hz: 30, minIntervalMs: 22 });
    // A config that allows none, and a pinned one, never ask.
    const none = governorConfigForProfile(lowAt0, cadenceOf(60, 1, 60, true));
    expect(cadenceFallbackRequest(inPhase(none, "engaged"), none)).toBeNull();
    const frozen = Object.freeze({ ...config, frozen: true });
    expect(cadenceFallbackRequest(inPhase(frozen, "engaged"), frozen)).toBeNull();
  });

  it("counts the governor exhausted while the fallback is on, and a rebase keeps the phase and clocks", () => {
    const config = governorConfigForProfile(lowAt30, cadenceOf(60, 2, 60, true, 30));
    for (const phase of ["engaged", "trial", "settled"] as const) {
      const state = inPhase(config, phase);
      // The engaging rebase zeroes the spent count (red team).
      expect(state.spentWindows).toBe(0);
      expect(governorExhausted(state), phase).toBe(true);
    }
    expect(governorExhausted(inPhase(config, "off"))).toBe(false);
    const trial = Object.freeze({
      ...createGovernorState(config),
      spentWindows: 3,
      fallback: Object.freeze({
        ...FALLBACK_OFF,
        phase: "trial" as const,
        trialDueInMs: 0,
        trialFrom: "settled" as const,
        trialLates: Object.freeze([0.01]),
        failedTrials: 1,
        msSinceExit: null,
        minIntervalMs: 24,
      }),
    });
    expect(rebaseGovernorState(trial).fallback).toEqual({ ...trial.fallback, trialLates: [] });
    const engaged = Object.freeze({
      ...trial,
      fallback: Object.freeze({ ...trial.fallback, phase: "engaged" as const, trialDueInMs: 40_000, trialLates: Object.freeze([]) }),
    });
    expect(rebaseGovernorState(engaged).fallback).toBe(engaged.fallback);
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
