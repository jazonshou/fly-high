import { describe, expect, it } from "vitest";
import {
  GovernorTrace,
  classifySignals,
  pixelsAtScale,
  type GovernorObservation,
  type ScaleContext,
} from "../src/bench/governorTrace";
import { benchTimings } from "../src/bench/plan";
import {
  CPU_WORK_MAX_LEVEL,
  createGovernorState,
  governorConfigForProfile,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";

const timings = benchTimings(false);

function setup(quality: QualityLevel, cssWidth = 1920, cssHeight = 1080, devicePixelRatio = 1) {
  const profile = resolveWebGpuQualityProfile(quality, "balanced");
  const config = governorConfigForProfile(profile);
  const scale: ScaleContext = {
    cssWidth,
    cssHeight,
    devicePixelRatio,
    maxDevicePixelRatio: profile.maxDevicePixelRatio,
    maxRenderPixels: profile.maxRenderPixels,
  };
  const trace = new GovernorTrace({ windows: { ground: timings.ground, air: timings.air }, flightS: timings.flightS, scale });
  return { config, scale, trace };
}

/** A probe the test mutates in place, as the renderer's accessor would fill it. */
function probe(config: GovernorConfig, scale: ScaleContext): GovernorObservation & {
  governorState: GovernorState;
  governorSignals: GovernorSignals;
  appliedRenderScale: number;
  renderWidth: number;
  renderHeight: number;
} {
  const state = createGovernorState(config);
  const pixels = pixelsAtScale(state.renderScale, scale);
  return {
    governorState: state,
    governorSignals: { gpuP95Ms: null, cpuP95Ms: null, intervalP95Ms: null },
    governorConfig: config,
    appliedRenderScale: state.renderScale,
    renderWidth: Math.round(Math.sqrt(pixels)),
    renderHeight: Math.round(Math.sqrt(pixels)),
    pinned: false,
  };
}

function decide(
  target: ReturnType<typeof probe>,
  change: Partial<GovernorState>,
  signals: GovernorSignals,
  scale: ScaleContext,
): void {
  target.governorState = Object.freeze({ ...target.governorState, ...change });
  target.governorSignals = { ...signals };
  target.appliedRenderScale = target.governorState.renderScale;
  const pixels = pixelsAtScale(target.governorState.renderScale, scale);
  target.renderWidth = Math.round(Math.sqrt(pixels));
  target.renderHeight = Math.round(Math.sqrt(pixels));
}

const GPU_HOT: GovernorSignals = { gpuP95Ms: null, cpuP95Ms: 5, intervalP95Ms: 25 };

describe("governor classification through resolveSignals", () => {
  const tier1 = governorConfigForProfile(resolveWebGpuQualityProfile("medium", "balanced"));

  it("at 50 Hz, pacing-bound only while CPU p95 sits between 4.93 and 15.07 ms (N2)", () => {
    expect(classifySignals({ gpuP95Ms: null, cpuP95Ms: 8, intervalP95Ms: 20 }, tier1))
      .toEqual({ signalClass: "pacing-bound", proxyMs: 20 });
    expect(classifySignals({ gpuP95Ms: null, cpuP95Ms: 5, intervalP95Ms: 20 }, tier1).signalClass)
      .toBe("pacing-bound");
    // Below 4.93 ms the proxy (20 - cpu) passes 15.07 ms and the window reads GPU-bound.
    expect(classifySignals({ gpuP95Ms: null, cpuP95Ms: 3, intervalP95Ms: 20 }, tier1))
      .toEqual({ signalClass: "gpu-bound", proxyMs: 17 });
  });

  it("a proxy under 2 ms is CPU-bound by definition, with no GPU estimate", () => {
    expect(classifySignals({ gpuP95Ms: null, cpuP95Ms: 19, intervalP95Ms: 20 }, tier1))
      .toEqual({ signalClass: "cpu-bound", proxyMs: null });
    expect(classifySignals({ gpuP95Ms: null, cpuP95Ms: null, intervalP95Ms: null }, tier1))
      .toEqual({ signalClass: "unknown", proxyMs: null });
    // A measured GPU time is not a proxy.
    expect(classifySignals({ gpuP95Ms: 14, cpuP95Ms: 4, intervalP95Ms: 16.6 }, tier1))
      .toEqual({ signalClass: "gpu-bound", proxyMs: null });
  });
});

describe("governor trace", () => {
  it("counts decisions by the signals' identity, and events from the state each made", () => {
    const { config, scale, trace } = setup("high");
    const current = probe(config, scale);
    const fps = 60;
    let frame = -5 * fps;
    const step = (until: number, each?: (tS: number) => void): void => {
      for (; frame < until * fps; frame += 1) {
        const tS = frame / fps;
        each?.(tS);
        trace.observe(tS, current);
      }
    };
    step(-2);
    decide(current, { mode: "holding" }, GPU_HOT, scale); // one settle decision
    step(5);
    decide(current, { mode: "cpu-work", cpuWorkLevel: 1, lastLever: "terrain-page-requests" }, { gpuP95Ms: null, cpuP95Ms: 19, intervalP95Ms: 20 }, scale);
    step(32);
    decide(current, { mode: "gpu-resolution", renderScale: 0.95 }, GPU_HOT, scale);
    step(40);
    decide(current, { mode: "gpu-resolution", renderScale: 0.75 }, GPU_HOT, scale);
    step(50);
    decide(current, { mode: "gpu-work", gpuWorkLevel: 1, resolutionInsensitive: true, lastLever: "compute-budget" }, GPU_HOT, scale);
    step(60);
    decide(current, { mode: "balanced", cpuWorkLevel: 0, gpuWorkLevel: 0, renderScale: 0.775 }, { gpuP95Ms: null, cpuP95Ms: 5, intervalP95Ms: 16.7 }, scale);
    step(76);

    const summary = trace.summary();
    expect(summary.pinned).toBe(false);
    expect(summary.scaleLeverAvailable).toBe(true);
    expect(summary.decisionsDuringSettle).toBe(1);
    expect(summary.decisions).toHaveLength(6);
    expect(summary.decisions[2]!.slice(0, 6)).toEqual([32, "gpu-resolution", "gpu-bound", 20, 0.95, 0.95]);
    expect(summary.decisions[2]!.slice(7)).toEqual([1, 0, "terrain-page-requests", false, null, 5, 25, null]);
    expect(summary.decisions[1]!.slice(1, 4)).toEqual(["cpu-work", "cpu-bound", null]);
    expect(summary.flight.decisions).toBe(5);
    expect(summary.flight.events).toEqual({
      scaleDown: 2, scaleUp: 1, cpuShed: 1, cpuRecover: 1, gpuShed: 1, gpuRecover: 1, insensitiveLatched: 1,
    });
    expect(summary.windows.ground.decisions).toBe(1);
    expect(summary.windows.ground.events.cpuShed).toBe(1);
    expect(summary.windows.air.decisions).toBe(4);
    expect(summary.windows.air.events.scaleUp).toBe(1);

    const air = summary.windows.air;
    expect(air.frames).toBe(45 * fps);
    // 0.95 for 8 s, the floor for 20 s, then 0.775 for 15 s.
    expect(air.share.atScaleFloor).toBeCloseTo(20 / 45, 9);
    expect(air.share.belowCeiling).toBeCloseTo(43 / 45, 9);
    expect(air.share.gpuShed).toBeCloseTo(10 / 45, 9);
    expect(air.share.cpuShed).toBeCloseTo(30 / 45, 9);
    expect(air.share.cpuAtMax).toBe(0);
    expect(air.modeShare).toEqual({
      "balanced": 15 / 45, "cpu-work": 2 / 45, "gpu-resolution": 18 / 45, "gpu-work": 10 / 45,
    });
    expect(air.scaleStepFrames).toBe(3);
    expect(Object.values(air.classShare).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 9);

    expect(summary.atSettleEnd).toMatchObject({ mode: "holding", targetScale: 1 });
    expect(summary.atFlightStart).toMatchObject({ mode: "holding", cpuLevel: 0 });
    expect(summary.atEnd).toMatchObject({ mode: "balanced", targetScale: 0.775, gpuLevel: 0 });
  });

  it("reads target, applied and rendered apart: a step the pixel cap absorbs is no step (S2)", () => {
    // Tier 1 at 2560x1440: the 1.5 Mpx cap binds below the 0.75 floor, so no
    // scale between the floor and the ceiling changes a pixel.
    const { config, scale, trace } = setup("medium", 2560, 1440, 1);
    expect(pixelsAtScale(config.scaleFloor, scale)).toBeCloseTo(pixelsAtScale(config.scaleCeiling, scale), 6);
    const current = probe(config, scale);
    trace.observe(0, current);
    decide(current, { mode: "gpu-resolution", renderScale: config.scaleFloor }, GPU_HOT, scale);
    for (let frame = 1; frame < 75 * 30; frame += 1) trace.observe(frame / 30, current);
    const summary = trace.summary();
    expect(summary.scaleLeverAvailable).toBe(false);
    expect(summary.windows.air.share.atScaleFloor).toBeNull();
    expect(summary.windows.air.share.belowCeiling).toBeNull();
    expect(summary.windows.air.scaleStepFrames).toBe(0);
    expect(summary.atEnd).toMatchObject({ targetScale: config.scaleFloor, appliedScale: config.scaleFloor });
    expect(summary.atEnd!.renderPixels).toBe(summary.atFlightStart!.renderPixels);
  });

  it("tier 0 has no resolution lever: its floor share is null", () => {
    const { config, scale, trace } = setup("low");
    expect(config.scaleFloor).toBe(config.scaleCeiling);
    const current = probe(config, scale);
    for (let frame = 0; frame < 75 * 30; frame += 1) trace.observe(frame / 30, current);
    expect(trace.summary().scaleLeverAvailable).toBe(false);
    expect(trace.summary().windows.air.share.atScaleFloor).toBeNull();
    expect(trace.summary().windows.air.share.cpuShed).toBe(0);
  });

  it("a pinned renderer never decides and reads as pinned", () => {
    const { config, scale, trace } = setup("medium");
    const current = { ...probe({ ...config, frozen: true }, scale), pinned: true };
    for (let frame = -60; frame < 75 * 60; frame += 1) trace.observe(frame / 60, current);
    const summary = trace.summary();
    expect(summary.pinned).toBe(true);
    expect(summary.decisions).toHaveLength(0);
    expect(summary.scaleLeverAvailable).toBe(false);
    expect(summary.windows.air.modeShare).toEqual({ pinned: 1 });
    expect(summary.atEnd?.mode).toBe("pinned");
    expect(summary.config?.frozen).toBe(true);
  });

  it("keeps at most maxDecisions and says when it dropped some", () => {
    const { config, scale } = setup("high");
    const trace = new GovernorTrace({
      windows: { ground: timings.ground, air: timings.air }, flightS: timings.flightS, scale, maxDecisions: 4,
    });
    const current = probe(config, scale);
    for (let frame = 0; frame < 10 * 60; frame += 1) {
      if (frame > 0 && frame % 60 === 0) decide(current, {}, GPU_HOT, scale);
      trace.observe(frame / 60, current);
    }
    const summary = trace.summary();
    expect(summary.decisions).toHaveLength(4);
    expect(summary.decisionsTruncated).toBe(true);
    expect(summary.flight.decisions).toBe(9);
  });

  it("gives a window the flight never reached null shares, not zeros", () => {
    // An early stop at 20 s: the roll and climb flew, the air window (30 s on) did not.
    const { config, scale, trace } = setup("high");
    const current = probe(config, scale);
    trace.observe(0, current);
    decide(current, { mode: "gpu-resolution", renderScale: config.scaleFloor }, GPU_HOT, scale);
    for (let frame = 1; frame <= 20 * 60; frame += 1) trace.observe(frame / 60, current);
    const summary = trace.summary();
    expect(summary.scaleLeverAvailable).toBe(true);
    expect(summary.windows.ground.share.atScaleFloor).toBeGreaterThan(0.9);
    expect(summary.windows.air.frames).toBe(0);
    expect(summary.windows.air.share).toEqual({
      atScaleFloor: null, belowCeiling: null, cpuShed: null, gpuShed: null, cpuAtMax: null, gpuAtMax: null,
    });
    expect(summary.windows.air.modeShare).toEqual({});
    expect(summary.windows.air.classShare).toEqual({});
  });

  it("counts every governor ladder rung at its maximum as at max", () => {
    const { config, scale, trace } = setup("high");
    const current = probe(config, scale);
    trace.observe(29, current);
    decide(current, { cpuWorkLevel: CPU_WORK_MAX_LEVEL }, GPU_HOT, scale);
    for (let frame = 30 * 10; frame < 75 * 10; frame += 1) trace.observe(frame / 10, current);
    expect(trace.summary().windows.air.share.cpuAtMax).toBe(1);
    expect(trace.summary().windows.air.share.gpuAtMax).toBe(0);
  });
});
