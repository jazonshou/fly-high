import { describe, expect, it, vi } from "vitest";
import { WebGpuFrameGraph } from "../src/render/webgpu/core/FrameGraph";
import {
  nextDynamicRenderScale,
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
    const high = resolveWebGpuQualityProfile("high", "ultra");
    expect(high.tier).toBe(2);
    expect(high.oceanCascades).toBe(5);
    expect(high).toMatchObject({
      cloudResolutionScale: 0.6,
      cloudPrimarySteps: 96,
      cloudLightSteps: 6,
    });
    expect(resolveWebGpuQualityProfile("low", "performance").oceanResolution).toBe(128);
    expect(resolveWebGpuQualityProfile("medium", "balanced").terrainRings).toBe(8);
  });

  it("changes dynamic resolution gradually", () => {
    const profile = resolveWebGpuQualityProfile("high", "balanced");
    expect(nextDynamicRenderScale(1, 22, profile)).toBeCloseTo(0.96);
    expect(nextDynamicRenderScale(0.8, 10, profile)).toBeCloseTo(0.82);
  });
});
