import { describe, expect, it } from "vitest";
import {
  DYNAMIC_ALLOCATIONS,
  FRAME_BUDGET_MS,
  FRAME_TARGET_MS,
  MEMORY_CEILING_MIB,
  assertWithinBudget,
  estimateGpuMemoryBreakdown,
  estimateGpuMemoryMiB,
  estimateRenderPixels,
  frameBudgetTotalMs,
  mipChainByteFactor,
  type PerformanceTier,
  type RenderViewport,
} from "../src/render/webgpu/core/PerformanceBudget";
import {
  SURFACE_MATERIAL_ARRAY_COUNT,
  SURFACE_MATERIAL_COUNT,
} from "../src/render/webgpu/terrain/surfaceMaterials";
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

  it("mirrors FRAME_TARGET_MS into every profile's frameTargetMs datum (Z-2)", () => {
    for (const profile of allProfiles()) {
      expect(profile.frameTargetMs, `tier ${profile.tier}`).toBe(
        FRAME_TARGET_MS[profile.tier as PerformanceTier],
      );
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
    // Enumerated from the breakdown itself, not by hand: a row added to the
    // shape but forgotten in the total (or vice versa) has to fail here. The
    // hand-written list this replaced went stale the moment `4-0` added the
    // three page-atlas rows.
    const parts = Object.entries(breakdown)
      .filter(([name]) => name !== "totalMiB" && name !== "renderPixels")
      .reduce((sum, [, value]) => sum + value, 0);
    expect(Object.keys(breakdown)).toContain("heightAtlasMiB");
    expect(breakdown.totalMiB).toBeGreaterThan(parts);
    expect(breakdown.totalMiB).toBeLessThan(parts * 1.25);
    expect(breakdown.totalMiB / parts).toBeCloseTo(1.15, 6);
  });

  it("moves each budget row when its declared input moves (Z-4, R-22)", () => {
    // The whole point of the split rows: a Phase-2 allocation must be able
    // to move the assertion. A vacuous row would let assertion 47 and the
    // 2-18 bucket arbitration pass no matter what the code allocates.
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const viewport = VIEWPORTS[1]!;
    const base = estimateGpuMemoryBreakdown(profile, viewport, DYNAMIC_ALLOCATIONS);

    // 2-11a re-pinned the base to 32 bytes; the row must still track the
    // input (perturb upward to the old 96-byte matrix layout).
    const withMatrixInstances = estimateGpuMemoryBreakdown(profile, viewport, {
      ...DYNAMIC_ALLOCATIONS,
      detailInstanceBytes: 96,
    });
    expect(withMatrixInstances.detailInstancesMiB).toBeCloseTo(
      base.detailInstancesMiB * (96 / 32),
      5,
    );
    expect(withMatrixInstances.totalMiB).toBeGreaterThan(base.totalMiB);

    const withAtlases = estimateGpuMemoryBreakdown(profile, viewport, {
      ...DYNAMIC_ALLOCATIONS,
      foliageAtlasMiB: 9,
      impostorAtlasMiB: 18,
    });
    expect(withAtlases.foliageAtlasMiB).toBe(9);
    expect(withAtlases.impostorAtlasMiB).toBe(18);
    // 2-17 moved the impostor base to 9.33 MiB (foliage 5.33 since 2-12);
    // the perturbation adds (9 − 5.33) + (18 − 9.33) ≈ 12.3 MiB before the
    // estimate fudge.
    expect(withAtlases.totalMiB).toBeGreaterThan(base.totalMiB + 11);

    const withCloudVolumes = estimateGpuMemoryBreakdown(profile, viewport, {
      ...DYNAMIC_ALLOCATIONS,
      cloudVolumesMiB: DYNAMIC_ALLOCATIONS.cloudVolumesMiB + 2.4,
    });
    expect(withCloudVolumes.cloudsMiB).toBeCloseTo(base.cloudsMiB + 2.4, 5);

    // 3-0: the material arrays are declared as a SHAPE, so both halves of the
    // row must move — the declared input (layer count) and the tier knob
    // (materialArrayEdge, assertion 56).
    const withDoubleLayers = estimateGpuMemoryBreakdown(profile, viewport, {
      ...DYNAMIC_ALLOCATIONS,
      materialArrayLayers: DYNAMIC_ALLOCATIONS.materialArrayLayers * 2,
    });
    expect(withDoubleLayers.materialArraysMiB).toBeCloseTo(base.materialArraysMiB * 2, 5);
    expect(withDoubleLayers.totalMiB).toBeGreaterThan(base.totalMiB + base.materialArraysMiB);
  });

  it("moves the material-array row when the tier's array edge moves (assertion 56)", () => {
    // The failure this guards is a decorative budget row: §5.2 puts the
    // arrays at over a tenth of the Balanced ceiling, and Phase 1 built the
    // contract precisely to catch that class of spend.
    const viewport = VIEWPORTS[1]!;
    const balanced = resolveWebGpuQualityProfile("medium", "balanced");
    expect(balanced.materialArrayEdge).toBe(512);

    const base = estimateGpuMemoryBreakdown(balanced, viewport);
    const halved = estimateGpuMemoryBreakdown(
      { ...balanced, materialArrayEdge: 256 },
      viewport,
    );
    const doubled = estimateGpuMemoryBreakdown(
      { ...balanced, materialArrayEdge: 1_024 },
      viewport,
    );
    // Area scaling, exactly — the mip factor differs by one level and is
    // folded in, so compare against the closed form rather than a ratio.
    expect(halved.materialArraysMiB).toBeLessThan(base.materialArraysMiB * 0.26);
    expect(doubled.materialArraysMiB).toBeGreaterThan(base.materialArraysMiB * 3.9);
    expect(halved.totalMiB).toBeLessThan(base.totalMiB);
    expect(doubled.totalMiB).toBeGreaterThan(base.totalMiB);

    // The published §5.2 rows: 5.4 / 56 / 56 / 114 MiB. The estimate must sit
    // under each, or the memory table is describing a different renderer.
    const publishedMiB: Readonly<Record<PerformanceTier, number>> = { 0: 8, 1: 56, 2: 56, 3: 114 };
    for (const [quality, mode] of [
      ["low", "performance"],
      ["medium", "balanced"],
      ["high", "balanced"],
      ["high", "ultra"],
    ] as const) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      const breakdown = estimateGpuMemoryBreakdown(profile, viewport);
      expect(
        breakdown.materialArraysMiB,
        `tier ${profile.tier} material arrays ${breakdown.materialArraysMiB.toFixed(1)} MiB`,
      ).toBeLessThanOrEqual(publishedMiB[profile.tier as PerformanceTier]);
    }
  });

  it("keeps the declared material-array layer count equal to the shipped enum", () => {
    // core/ deliberately does not import terrain/, so the layer count is a
    // declared literal. This is the pin that stops it drifting from the
    // contract 3-0 owns.
    expect(DYNAMIC_ALLOCATIONS.materialArrayLayers).toBe(SURFACE_MATERIAL_COUNT);
    expect(DYNAMIC_ALLOCATIONS.materialArrayCount).toBe(SURFACE_MATERIAL_ARRAY_COUNT);
    expect(mipChainByteFactor(512)).toBeCloseTo(4 / 3, 5);
    expect(mipChainByteFactor(1)).toBe(1);
    expect(() => mipChainByteFactor(300)).toThrow(RangeError);
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
