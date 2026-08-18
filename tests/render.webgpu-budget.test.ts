import { describe, expect, it } from "vitest";
import {
  FRAME_BUDGET_MS,
  FRAME_TARGET_MS,
  MEMORY_CEILING_MIB,
  assertWithinBudget,
  estimateGpuMemoryBreakdown,
  estimateGpuMemoryMiB,
  estimateRenderPixels,
  frameBudgetTotalMs,
  type PerformanceTier,
  type RenderViewport,
} from "../src/render/webgpu/core/PerformanceBudget";
import {
  assertStartupInvariants,
  collectStartupInvariantFailures,
} from "../src/render/webgpu/core/RenderInvariants";
import {
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";

/**
 * 1A-2 — the budget contract. Assertions 19 and 20: every resolvable profile
 * stays inside its tier's memory ceiling at representative viewports, and the
 * per-subsystem frame rows sum below the tier's frame target. This is what
 * makes every later phase's budget claim falsifiable.
 */

const VIEWPORTS: readonly RenderViewport[] = [
  // 720p external display at DPR 1.
  { cssWidth: 1_280, cssHeight: 720, devicePixelRatio: 1 },
  // The reference laptop panel: 1512×982 CSS at DPR 2.
  { cssWidth: 1_512, cssHeight: 982, devicePixelRatio: 2 },
  // A 4K-class display at DPR 2.
  { cssWidth: 2_560, cssHeight: 1_440, devicePixelRatio: 2 },
];

const QUALITIES: readonly QualityLevel[] = ["low", "medium", "high"];
const MODES: readonly RenderingMode[] = ["performance", "balanced", "ultra"];

function allProfiles(): WebGpuQualityProfile[] {
  const profiles: WebGpuQualityProfile[] = [];
  for (const quality of QUALITIES) {
    for (const mode of MODES) {
      profiles.push(resolveWebGpuQualityProfile(quality, mode));
    }
  }
  return profiles;
}

describe("performance budget (1A-2)", () => {
  it("keeps every profile under its tier memory ceiling at three viewports (assertion 19)", () => {
    for (const profile of allProfiles()) {
      for (const viewport of VIEWPORTS) {
        const estimate = estimateGpuMemoryMiB(profile, viewport);
        const ceiling = MEMORY_CEILING_MIB[profile.tier as PerformanceTier];
        expect(
          estimate,
          `tier ${profile.tier} (${profile.quality}/${profile.mode}) at `
          + `${viewport.cssWidth}×${viewport.cssHeight}@${viewport.devicePixelRatio}`,
        ).toBeLessThanOrEqual(ceiling);
        expect(() => assertWithinBudget(profile, viewport)).not.toThrow();
      }
    }
  });

  it("keeps the per-subsystem frame rows under each tier's frame target (assertion 20)", () => {
    for (const tier of [0, 1, 2, 3] as const) {
      expect(frameBudgetTotalMs(tier), `tier ${tier}`).toBeLessThanOrEqual(
        FRAME_TARGET_MS[tier],
      );
      for (const [row, value] of Object.entries(FRAME_BUDGET_MS[tier])) {
        expect(value, `tier ${tier} row ${row}`).toBeGreaterThan(0);
      }
    }
  });

  it("fails loudly on a synthetic budget overspend", () => {
    const profile = resolveWebGpuQualityProfile("high", "ultra");
    const overspent: WebGpuQualityProfile = {
      ...profile,
      // A 16k × 4-cascade shadow map alone is ~5 GiB — any ceiling must trip.
      shadowMapSize: 16_384,
    };
    expect(() =>
      assertWithinBudget(overspent, { cssWidth: 1_512, cssHeight: 982, devicePixelRatio: 2 }),
    ).toThrowError(/budget overspend/);
  });

  it("caps rendered pixels by the profile's absolute pixel budget", () => {
    const profile = resolveWebGpuQualityProfile("high", "ultra");
    const uncapped = estimateRenderPixels(profile, {
      cssWidth: 3_840,
      cssHeight: 2_160,
      devicePixelRatio: 2,
    });
    expect(uncapped).toBeLessThanOrEqual(profile.maxRenderPixels);
    // Small viewports come in under the cap — the estimate must track the
    // actual scale product, not just report the ceiling.
    const small = estimateRenderPixels(profile, {
      cssWidth: 640,
      cssHeight: 360,
      devicePixelRatio: 1,
    });
    expect(small).toBeLessThan(profile.maxRenderPixels);
  });

  it("reports a breakdown whose parts sum to the total before slack", () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const breakdown = estimateGpuMemoryBreakdown(profile, VIEWPORTS[1]!);
    const parts =
      breakdown.framebuffersMiB
      + breakdown.shadowsMiB
      + breakdown.oceanMiB
      + breakdown.cloudsMiB
      + breakdown.terrainGeometryMiB
      + breakdown.detailMiB
      + breakdown.miscMiB;
    expect(breakdown.totalMiB).toBeGreaterThan(parts);
    expect(breakdown.totalMiB).toBeLessThan(parts * 1.25);
  });

  it("rejects degenerate viewports", () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    expect(() =>
      estimateGpuMemoryMiB(profile, { cssWidth: 0, cssHeight: 720, devicePixelRatio: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      estimateGpuMemoryMiB(profile, {
        cssWidth: 1_280,
        cssHeight: 720,
        devicePixelRatio: Number.NaN,
      }),
    ).toThrow(RangeError);
  });
});

describe("startup render invariants (1A-2)", () => {
  it("accepts a coherent startup state", () => {
    expect(
      collectStartupInvariantFailures({
        timestampQuerySupported: true,
        gpuTimingEnabled: true,
        requestedFeatures: ["timestamp-query"],
        grantedFeatures: ["timestamp-query", "depth-clip-control"],
      }),
    ).toEqual([]);
    expect(() =>
      assertStartupInvariants({
        timestampQuerySupported: false,
        gpuTimingEnabled: false,
        requestedFeatures: [],
        grantedFeatures: [],
      }),
    ).not.toThrow();
  });

  it("fails when GPU timing does not match timestamp-query support", () => {
    const failures = collectStartupInvariantFailures({
      timestampQuerySupported: true,
      gpuTimingEnabled: false,
      requestedFeatures: [],
      grantedFeatures: [],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/GPU timing/);
  });

  it("fails when a requested feature was not granted", () => {
    expect(() =>
      assertStartupInvariants({
        timestampQuerySupported: true,
        gpuTimingEnabled: true,
        requestedFeatures: ["timestamp-query"],
        grantedFeatures: [],
      }),
    ).toThrowError(/timestamp-query/);
  });
});
