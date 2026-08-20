import { describe, expect, it, vi } from "vitest";
import { WebGpuFrameGraph } from "../src/render/webgpu/core/FrameGraph";
import {
  frameTimingPercentile95,
  freshFrameTiming,
  isUsableFrameTiming,
  resolveWebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";

describe("WebGPU frame graph", () => {
  it("orders dependencies and stable phases", async () => {
    const calls: string[] = [];
    const graph = new WebGpuFrameGraph();
    graph.register({ name: "water", phase: "water", after: ["opaque"], execute: () => calls.push("water") });
    graph.register({ name: "simulation", phase: "simulation", execute: () => calls.push("simulation") });
    graph.register({ name: "opaque", phase: "opaque", after: ["simulation"], execute: () => calls.push("opaque") });
    await graph.execute({ frameIndex: 0, timeSeconds: 0, deltaSeconds: 1 / 60, cameraCut: false, originShifted: false });
    expect(calls).toEqual(["simulation", "opaque", "water"]);
  });

  it("honors cadence and invalidates histories", async () => {
    const execute = vi.fn();
    const invalidateHistory = vi.fn();
    const graph = new WebGpuFrameGraph();
    graph.register({ name: "cloud-shadow", phase: "shadows", cadence: 3, execute, invalidateHistory });
    await graph.execute({ frameIndex: 1, timeSeconds: 0, deltaSeconds: 1 / 60, cameraCut: false, originShifted: false });
    await graph.execute({ frameIndex: 3, timeSeconds: 0, deltaSeconds: 1 / 60, cameraCut: false, originShifted: false });
    graph.invalidateHistory("camera-cut");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(invalidateHistory).toHaveBeenCalledWith("camera-cut");
  });
});

describe("WebGPU quality profiles", () => {
  it("combines quality and renderer intent into bounded profiles", () => {
    expect(resolveWebGpuQualityProfile("low", "performance").tier).toBe(0);
    expect(resolveWebGpuQualityProfile("low", "ultra").tier).toBe(1);
    expect(resolveWebGpuQualityProfile("medium", "balanced").tier).toBe(1);
    expect(resolveWebGpuQualityProfile("high", "balanced").tier).toBe(2);
    // Four tiers since 1A-6b: high+ultra reaches the Ultra tier.
    const ultra = resolveWebGpuQualityProfile("high", "ultra");
    expect(ultra.tier).toBe(3);
    expect(ultra.oceanCascades).toBe(5);
    expect(ultra).toMatchObject({
      cloudResolutionScale: 0.7,
      cloudPrimarySteps: 96,
      cloudLightSteps: 6,
    });
    expect(resolveWebGpuQualityProfile("low", "performance").oceanResolution).toBe(128);
    expect(resolveWebGpuQualityProfile("medium", "balanced")).toMatchObject({
      terrainRings: 7,
      shadowCascades: 2,
      shadowDistance: 7_000,
      oceanResolution: 128,
      cloudResolutionScale: 0.45,
      cloudPrimarySteps: 60,
    });
  });

  it("carries the 3-0 surface-material rows from RENDERING_PLAN.md §5.3", () => {
    // Material array edge 256/512/512/1024, triplanar off/2-axis/3-axis/3-axis,
    // height-blend cap 2/3/4/4 — the three rows the terrain surface system
    // reads instead of branching on the tier.
    expect(resolveWebGpuQualityProfile("low", "performance")).toMatchObject({
      materialArrayEdge: 256,
      terrainTriplanarMode: "planar",
      heightBlendMaxMaterials: 2,
    });
    expect(resolveWebGpuQualityProfile("medium", "balanced")).toMatchObject({
      materialArrayEdge: 512,
      // §5.3's tier rule: the 2-axis fast path is mandatory from Balanced up,
      // not a High-only optimisation.
      terrainTriplanarMode: "biplanar",
      heightBlendMaxMaterials: 3,
    });
    expect(resolveWebGpuQualityProfile("high", "balanced")).toMatchObject({
      materialArrayEdge: 512,
      terrainTriplanarMode: "triplanar",
      heightBlendMaxMaterials: 4,
    });
    // Ultra ships 512, not §5.3's 1024 — see the QualityProfile field comment
    // and the 3-1 CPU-synthesis deviation. The knob is still live: Low is 256.
    expect(resolveWebGpuQualityProfile("high", "ultra")).toMatchObject({
      materialArrayEdge: 512,
      terrainTriplanarMode: "triplanar",
      heightBlendMaxMaterials: 4,
    });
    // Every edge must be a power of two: the CPU mip reducer halves to 1x1.
    for (const [quality, mode] of [
      ["low", "performance"],
      ["medium", "balanced"],
      ["high", "balanced"],
      ["high", "ultra"],
    ] as const) {
      const edge = resolveWebGpuQualityProfile(quality, mode).materialArrayEdge;
      expect(edge & (edge - 1)).toBe(0);
    }
  });

  it("caps rendered pixels and device pixel ratio per tier (1A-6a)", () => {
    expect(resolveWebGpuQualityProfile("low", "performance")).toMatchObject({
      maxRenderPixels: 1_000_000,
      maxDevicePixelRatio: 1,
    });
    expect(resolveWebGpuQualityProfile("medium", "balanced")).toMatchObject({
      maxRenderPixels: 1_500_000,
      maxDevicePixelRatio: 1.5,
    });
    expect(resolveWebGpuQualityProfile("high", "balanced")).toMatchObject({
      maxRenderPixels: 2_400_000,
      maxDevicePixelRatio: 2,
    });
    expect(resolveWebGpuQualityProfile("high", "ultra")).toMatchObject({
      maxRenderPixels: 4_000_000,
      maxDevicePixelRatio: 2,
    });

    // Exit criterion for the jumped 1A-6a item: on the reference 1512×982 CSS
    // viewport at DPR 2, the default profile's cap keeps the render target at
    // or below 1.5 Mpx (it was 5.94 Mpx when DPR multiplied in uncapped).
    const defaults = resolveWebGpuQualityProfile("medium", "balanced");
    const cssPixels = 1_512 * 982;
    const requestedScale = Math.min(2, defaults.maxDevicePixelRatio) * defaults.renderScale;
    const pixelCapScale = Math.sqrt(defaults.maxRenderPixels / cssPixels);
    const effectiveScale = Math.min(requestedScale, pixelCapScale);
    // The sqrt round-trip re-introduces one ulp of noise; allow it.
    expect(cssPixels * effectiveScale * effectiveScale).toBeLessThanOrEqual(
      1_500_000 * (1 + 1e-9),
    );
  });

  // nextDynamicRenderScale and worstFrameTimingPercentile95 are gone (1A-6b):
  // the worst-stream p95 feeding a resolution step was the one-way ratchet.
  // Their replacement lives in AdaptiveGovernor and is tested there.
  it("computes the nearest-rank p95 over usable samples", () => {
    const frameIntervals = Array.from({ length: 100 }, (_, index) => 15 + index / 100);
    expect(frameTimingPercentile95([0, Number.NaN, ...frameIntervals])).toBeCloseTo(15.94);
  });

  it("rejects unavailable and suspended-tab timing values", () => {
    expect(isUsableFrameTiming(0)).toBe(false);
    expect(isUsableFrameTiming(Number.NaN)).toBe(false);
    expect(isUsableFrameTiming(251)).toBe(false);
    expect(isUsableFrameTiming(16.7)).toBe(true);
    expect(frameTimingPercentile95([0, Number.NaN, 500])).toBeNull();
    expect(freshFrameTiming(12.5, 100, 130, 30)).toBe(12.5);
    expect(freshFrameTiming(12.5, 100, 131, 30)).toBeNull();
    expect(freshFrameTiming(0, 100, 100, 30)).toBeNull();
  });
});
