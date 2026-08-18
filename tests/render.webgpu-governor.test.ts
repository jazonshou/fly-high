import { describe, expect, it } from "vitest";
import {
  CPU_WORK_MAX_LEVEL,
  cpuWorkLeverName,
  cpuWorkSettingsForLevel,
  createGovernorState,
  governorConfigForProfile,
  nextGovernorDecision,
  observeRenderScaleApplication,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

/**
 * 1A-6b, assertion 21 — the permanent guard against the ratchet returning.
 * A CPU-bound trace must never move resolution; a GPU-bound trace that does
 * not improve must stop after two ineffective steps and restore the scale.
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

  it("orders the work ladder cheapest-looking damage first and caps only downward", () => {
    expect(cpuWorkSettingsForLevel(0)).toMatchObject({
      terrainPageRequestsPerUpdate: Number.POSITIVE_INFINITY,
      detailCellBudgetMs: 2,
      detailCellCap: 24,
      planarReflectionIntervalFrames: null,
      cloudShadowIntervalFrames: null,
      vegetationDistanceScale: 1,
    });
    expect(cpuWorkSettingsForLevel(1).terrainPageRequestsPerUpdate).toBe(8);
    expect(cpuWorkSettingsForLevel(3).terrainPageRequestsPerUpdate).toBe(2);
    expect(cpuWorkSettingsForLevel(4)).toMatchObject({
      detailCellBudgetMs: 1.25,
      detailCellCap: 16,
    });
    expect(cpuWorkSettingsForLevel(CPU_WORK_MAX_LEVEL)).toMatchObject({
      terrainPageRequestsPerUpdate: 2,
      detailCellBudgetMs: 0.75,
      detailCellCap: 8,
      planarReflectionIntervalFrames: 8,
      cloudShadowIntervalFrames: 4,
      activeAnimalBudgetCap: 16,
      shadowCasterDistanceMeters: 1_200,
      vegetationDistanceScale: 0.75,
    });
    expect(cpuWorkLeverName(0)).toBeNull();
    expect(cpuWorkLeverName(1)).toBe("terrain-page-requests");
    expect(cpuWorkLeverName(CPU_WORK_MAX_LEVEL)).toBe("vegetation-distance");
    expect(() => cpuWorkSettingsForLevel(CPU_WORK_MAX_LEVEL + 1)).toThrow(RangeError);
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
