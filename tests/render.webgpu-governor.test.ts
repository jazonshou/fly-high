import { describe, expect, it } from "vitest";
import {
  CPU_WORK_MAX_LEVEL,
  GPU_WORK_MAX_LEVEL,
  cpuWorkLeverName,
  gpuWorkLeverName,
  createGovernorState,
  governorConfigForProfile,
  nextGovernorDecision,
  observeRenderScaleApplication,
  workLeverSettingsFor,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

/**
 * 1A-6b, assertion 21 — the permanent guard against the ratchet returning.
 * A CPU-bound trace must never move resolution; a GPU-bound trace that does
 * not improve must stop after two ineffective steps and restore the scale.
 * R-11 extends the contract: no work step is ever recovered while the frame
 * is GPU-bound, and a GPU-bound frame whose resolution lever is dead (latched
 * or floored) sheds GPU-cost work levers instead.
 */

const config = governorConfigForProfile(resolveWebGpuQualityProfile("high", "balanced"));

function runWindows(
  initial: GovernorState,
  signals: GovernorSignals,
  windows: number,
): GovernorState {
  let state = initial;
  for (let window = 0; window < windows; window += 1) {
    state = nextGovernorDecision(state, signals, config);
  }
  return state;
}

describe("adaptive governor (1A-6b)", () => {
  it("wave R: a frozen (pinned-capture) governor never moves ANY lever", () => {
    // Z-1's rule is "deterministic shipping pixels": on a slow capture host
    // (the CI runner's ~28 ms frames) the unfrozen work ladders walked —
    // vegetation distance, shadow caster distance, cloud-shadow cadence —
    // and the CI render diverged from the committed baseline while the fast
    // reference host, whose governor never stepped, kept matching it.
    const frozen = Object.freeze({ ...config, frozen: true });
    const overloaded: GovernorSignals = { gpuP95Ms: 40, cpuP95Ms: 40, intervalP95Ms: 45 };
    let state = createGovernorState(frozen);
    const initial = state;
    for (let window = 0; window < 50; window += 1) {
      state = nextGovernorDecision(state, overloaded, frozen);
    }
    expect(state).toBe(initial);
    expect(state.renderScale).toBe(initial.renderScale);
    expect(state.cpuWorkLevel).toBe(0);
    expect(state.gpuWorkLevel).toBe(0);
  });

  it("leaves renderScale untouched over 50 CPU-bound windows and moves the work ladder", () => {
    const cpuBound: GovernorSignals = { gpuP95Ms: 6, cpuP95Ms: 22, intervalP95Ms: 22 };
    let state = createGovernorState(config);
    const initialScale = state.renderScale;
    let sawCpuWork = false;
    for (let window = 0; window < 50; window += 1) {
      state = nextGovernorDecision(state, cpuBound, config);
      expect(state.renderScale).toBe(initialScale);
      if (state.mode === "cpu-work") sawCpuWork = true;
    }
    expect(sawCpuWork).toBe(true);
    expect(state.cpuWorkLevel).toBeGreaterThan(0);
    expect(state.cpuWorkLevel).toBeLessThanOrEqual(CPU_WORK_MAX_LEVEL);
    expect(state.lastLever).not.toBeNull();
  });

  it("classifies a tiny synthesised GPU share as CPU-bound and does not touch resolution", () => {
    // No timestamp queries at all: interval ≈ cpu means the CPU is the story.
    const noGpuTiming: GovernorSignals = { gpuP95Ms: null, cpuP95Ms: 21, intervalP95Ms: 22 };
    let state = createGovernorState(config);
    const initialScale = state.renderScale;
    state = runWindows(state, noGpuTiming, 10);
    expect(state.renderScale).toBe(initialScale);
    expect(state.cpuWorkLevel).toBeGreaterThan(0);
  });

  it("acts on failed frame pacing even when both component counters look calm", () => {
    const pacingBound: GovernorSignals = {
      gpuP95Ms: 10,
      cpuP95Ms: 6.6,
      intervalP95Ms: 37.5,
    };
    const initial = createGovernorState(config);
    const state = nextGovernorDecision(initial, pacingBound, config);

    expect(state.mode).toBe("frame-pacing");
    expect(state.renderScale).toBeLessThan(initial.renderScale);
    expect(state.pendingProbe?.preStepGpuP95Ms).toBe(37.5);
    expect(state.pendingProbe?.metric).toBe("interval");
  });

  it("holds a healthy 60 Hz cadence when component counters are calm", () => {
    const healthy: GovernorSignals = {
      gpuP95Ms: 8,
      cpuP95Ms: 6,
      intervalP95Ms: 16.67,
    };
    const initial = createGovernorState(config);
    const state = nextGovernorDecision(initial, healthy, config);

    expect(state.renderScale).toBe(initial.renderScale);
    expect(state.pendingProbe).toBeNull();
    expect(state.gpuWorkLevel).toBe(0);
  });

  it("undoes a scale probe when its timing source changes", () => {
    const initial = createGovernorState(config);
    const pacingStep = nextGovernorDecision(initial, {
      gpuP95Ms: 10,
      cpuP95Ms: 6.6,
      intervalP95Ms: 37.5,
    }, config);
    expect(pacingStep.pendingProbe?.metric).toBe("interval");

    const timestampWindow = nextGovernorDecision(pacingStep, {
      gpuP95Ms: 20,
      cpuP95Ms: 6,
      intervalP95Ms: 21,
    }, config);
    expect(timestampWindow.renderScale).toBe(initial.renderScale);
    expect(timestampWindow.pendingProbe).toBeNull();
    expect(timestampWindow.mode).toBe("holding");
  });

  it("never recovers work while pilot-visible frame pacing is over budget", () => {
    const initial = Object.freeze({
      ...createGovernorState(config),
      gpuWorkLevel: 2,
      cpuWorkLevel: 2,
    }) as GovernorState;
    const pacingBound: GovernorSignals = {
      gpuP95Ms: 8,
      cpuP95Ms: 7,
      intervalP95Ms: 24,
    };
    const state = runWindows(initial, pacingBound, 8);

    expect(state.gpuWorkLevel).toBeGreaterThanOrEqual(initial.gpuWorkLevel);
    expect(state.cpuWorkLevel).toBe(initial.cpuWorkLevel);
  });

  it("lowers resolution while GPU-bound and stops after two ineffective steps", () => {
    // GPU pegged at 20 ms and completely insensitive to resolution.
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 6, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    const initialScale = state.renderScale;

    state = nextGovernorDecision(state, gpuBound, config);
    expect(state.renderScale).toBeCloseTo(initialScale - 0.05, 5);
    expect(state.mode).toBe("gpu-resolution");

    state = nextGovernorDecision(state, gpuBound, config);
    expect(state.renderScale).toBeCloseTo(initialScale - 0.1, 5);
    expect(state.ineffectiveDownSteps).toBe(1);

    // Second ineffective evaluation: both steps bought nothing, so the scale
    // restores to its value before the ineffective pair, and the latch sets.
    state = nextGovernorDecision(state, gpuBound, config);
    expect(state.resolutionInsensitive).toBe(true);
    expect(state.renderScale).toBe(initialScale);

    // Latched: many more GPU-bound windows change nothing.
    const latchedScale = state.renderScale;
    for (let window = 0; window < 5; window += 1) {
      state = nextGovernorDecision(state, gpuBound, config);
      expect(state.renderScale).toBe(latchedScale);
    }
  });

  it("keeps stepping down while each step genuinely helps", () => {
    let state = createGovernorState(config);
    const initialScale = state.renderScale;
    // Each window's GPU time reflects a ~10% improvement from the last step.
    let gpu = 20;
    state = nextGovernorDecision(state, { gpuP95Ms: gpu, cpuP95Ms: 6, intervalP95Ms: 21 }, config);
    gpu *= 0.9;
    state = nextGovernorDecision(state, { gpuP95Ms: gpu, cpuP95Ms: 6, intervalP95Ms: 19 }, config);
    gpu *= 0.9;
    state = nextGovernorDecision(state, { gpuP95Ms: gpu, cpuP95Ms: 6, intervalP95Ms: 17 }, config);
    expect(state.renderScale).toBeCloseTo(initialScale - 0.15, 5);
    expect(state.resolutionInsensitive).toBe(false);
    expect(state.ineffectiveDownSteps).toBe(0);
  });

  it("latches immediately when the pixel cap absorbs a downward step", () => {
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 6, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    const initialScale = state.renderScale;
    state = nextGovernorDecision(state, gpuBound, config);
    expect(state.renderScale).toBeLessThan(initialScale);
    // applyRenderScale reported no effective change: the cap is binding.
    state = observeRenderScaleApplication(state, false, config);
    expect(state.resolutionInsensitive).toBe(true);
    expect(state.renderScale).toBe(initialScale);
  });

  it("re-arms the resolution-insensitive latch after its window count", () => {
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 6, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    state = nextGovernorDecision(state, gpuBound, config);
    state = observeRenderScaleApplication(state, false, config);
    expect(state.resolutionInsensitive).toBe(true);
    state = runWindows(state, { gpuP95Ms: 10, cpuP95Ms: 6, intervalP95Ms: 11 },
      config.insensitiveRearmWindows);
    expect(state.resolutionInsensitive).toBe(false);
  });

  it("recovers one work step after four calm windows", () => {
    const cpuBound: GovernorSignals = { gpuP95Ms: 6, cpuP95Ms: 22, intervalP95Ms: 22 };
    let state = createGovernorState(config);
    state = runWindows(state, cpuBound, 4);
    const loadedLevel = state.cpuWorkLevel;
    expect(loadedLevel).toBeGreaterThan(0);
    // Genuinely calm and balanced: neither stream dominates, both far below
    // target — the ladder recovers one step after four such windows.
    const calm: GovernorSignals = { gpuP95Ms: 4, cpuP95Ms: 4, intervalP95Ms: 5 };
    state = runWindows(state, calm, 4);
    expect(state.cpuWorkLevel).toBe(loadedLevel - 1);
  });

  it("respects the raised 0.75 scale floor", () => {
    const gpuBound = (gpu: number): GovernorSignals => (
      { gpuP95Ms: gpu, cpuP95Ms: 6, intervalP95Ms: gpu + 1 }
    );
    let state = createGovernorState(config);
    // Every step improves so the anti-ratchet never fires; drive to the floor.
    let gpu = 40;
    for (let window = 0; window < 40; window += 1) {
      state = nextGovernorDecision(state, gpuBound(gpu), config);
      gpu = Math.max(16, gpu * 0.9);
    }
    expect(state.renderScale).toBeGreaterThanOrEqual(config.scaleFloor - 1e-9);
    expect(config.scaleFloor).toBeCloseTo(0.75, 5);
  });

  it("splits the ladders by cost and keeps each ordered cheapest-looking first (R-11)", () => {
    expect(workLeverSettingsFor(0, 0)).toMatchObject({
      terrainPageRequestsPerUpdate: Number.POSITIVE_INFINITY,
      detailCellBudgetMs: 2,
      detailCellCap: 24,
      cloudShadowIntervalFrames: null,
      vegetationDistanceScale: 1,
    });
    // The CPU ladder touches only CPU-side fields.
    expect(workLeverSettingsFor(1, 0).terrainPageRequestsPerUpdate).toBe(8);
    expect(workLeverSettingsFor(3, 0).terrainPageRequestsPerUpdate).toBe(2);
    expect(workLeverSettingsFor(4, 0)).toMatchObject({
      detailCellBudgetMs: 1.25,
      detailCellCap: 16,
    });
    expect(workLeverSettingsFor(CPU_WORK_MAX_LEVEL, 0)).toMatchObject({
      terrainPageRequestsPerUpdate: 2,
      detailCellBudgetMs: 0.75,
      detailCellCap: 8,
      activeAnimalBudgetCap: 16,
      // GPU-cost levers stay untouched at any CPU level.
      cloudShadowIntervalFrames: null,
      shadowCasterDistanceMeters: Number.POSITIVE_INFINITY,
      vegetationDistanceScale: 1,
      computeBudgetScale: 1,
    });
    // The GPU ladder touches only render-side fields. (2-10 retired the
    // planar-reflection rungs with their system.)
    // 4-0b: rung 0 is the shared compute cap, and it moves BEFORE any lever
    // the pilot can see. Assertion 71's companion property.
    expect(workLeverSettingsFor(0, 1)).toMatchObject({
      computeBudgetScale: 0.6,
      cloudShadowIntervalFrames: null,
      shadowCasterDistanceMeters: Number.POSITIVE_INFINITY,
      vegetationDistanceScale: 1,
    });
    expect(workLeverSettingsFor(0, 2).computeBudgetScale).toBe(0.35);
    expect(workLeverSettingsFor(0, 2).cloudShadowIntervalFrames).toBeNull();
    expect(workLeverSettingsFor(0, 3).cloudShadowIntervalFrames).toBe(3);
    expect(workLeverSettingsFor(0, GPU_WORK_MAX_LEVEL)).toMatchObject({
      computeBudgetScale: 0.35,
      cloudShadowIntervalFrames: 4,
      shadowCasterDistanceMeters: 1_200,
      vegetationDistanceScale: 0.75,
      terrainPageRequestsPerUpdate: Number.POSITIVE_INFINITY,
      detailCellBudgetMs: 2,
      activeAnimalBudgetCap: Number.POSITIVE_INFINITY,
    });
    expect(cpuWorkLeverName(0)).toBeNull();
    expect(cpuWorkLeverName(1)).toBe("terrain-page-requests");
    expect(cpuWorkLeverName(CPU_WORK_MAX_LEVEL)).toBe("animal-budget");
    expect(gpuWorkLeverName(1)).toBe("compute-budget");
    expect(gpuWorkLeverName(3)).toBe("cloud-shadow-cadence");
    expect(gpuWorkLeverName(GPU_WORK_MAX_LEVEL)).toBe("vegetation-distance");
    expect(() => workLeverSettingsFor(CPU_WORK_MAX_LEVEL + 1, 0)).toThrow(RangeError);
    expect(() => workLeverSettingsFor(0, GPU_WORK_MAX_LEVEL + 1)).toThrow(RangeError);
  });

  it("R-11 trace: gpu-bound + latched sheds GPU-cost levers and never recovers work", () => {
    // The reference-machine state (R-6): pixel cap binds, so the first down
    // step is absorbed and the latch fires immediately.
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 4, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    // Load one CPU work level first so there is something to wrongly recover.
    state = Object.freeze({ ...state, cpuWorkLevel: 3 }) as GovernorState;
    state = nextGovernorDecision(state, gpuBound, config);
    state = observeRenderScaleApplication(state, false, config);
    expect(state.resolutionInsensitive).toBe(true);

    // GPU-bound with a calm CPU used to fall through to the balanced branch
    // and RECOVER cpu work (R-5). It must never do that again — and the GPU
    // ladder must engage instead.
    const before = state.cpuWorkLevel;
    let sawGpuWork = false;
    for (let window = 0; window < 12; window += 1) {
      state = nextGovernorDecision(state, gpuBound, config);
      expect(state.cpuWorkLevel).toBe(before);
      if (state.mode === "gpu-work") sawGpuWork = true;
      expect(state.renderScale).toBe(createGovernorState(config).renderScale);
    }
    expect(sawGpuWork).toBe(true);
    expect(state.gpuWorkLevel).toBeGreaterThan(0);
    expect(state.lastLever).toBe(gpuWorkLeverName(state.gpuWorkLevel));
  });

  it("R-11 trace: GPU levers recover only from a calm, non-GPU-bound state", () => {
    const gpuBound: GovernorSignals = { gpuP95Ms: 20, cpuP95Ms: 4, intervalP95Ms: 21 };
    let state = createGovernorState(config);
    state = nextGovernorDecision(state, gpuBound, config);
    state = observeRenderScaleApplication(state, false, config);
    for (let window = 0; window < 6; window += 1) {
      state = nextGovernorDecision(state, gpuBound, config);
    }
    const shedLevel = state.gpuWorkLevel;
    expect(shedLevel).toBeGreaterThan(0);

    // Still GPU-bound but now under target: hold, never recover.
    const gpuBoundCalm: GovernorSignals = { gpuP95Ms: 9, cpuP95Ms: 4, intervalP95Ms: 10 };
    for (let window = 0; window < 8; window += 1) {
      state = nextGovernorDecision(state, gpuBoundCalm, config);
      expect(state.gpuWorkLevel).toBe(shedLevel);
    }

    // Balanced and genuinely calm: one GPU lever recovers per calm streak.
    const calm: GovernorSignals = { gpuP95Ms: 5, cpuP95Ms: 5, intervalP95Ms: 6 };
    for (let window = 0; window < 4; window += 1) {
      state = nextGovernorDecision(state, calm, config);
    }
    expect(state.gpuWorkLevel).toBe(shedLevel - 1);
  });

  it("uses the 30 ms target on the Ultra tier", () => {
    const ultra = governorConfigForProfile(resolveWebGpuQualityProfile("high", "ultra"));
    expect(ultra.gpuTargetMs).toBe(30);
    // 18 ms GPU-bound is comfortably inside Ultra's target: no step.
    let state = createGovernorState(ultra);
    const initial = state.renderScale;
    state = runWindows(state, { gpuP95Ms: 18, cpuP95Ms: 6, intervalP95Ms: 19 }, 3);
    expect(state.renderScale).toBe(initial);
  });
});
