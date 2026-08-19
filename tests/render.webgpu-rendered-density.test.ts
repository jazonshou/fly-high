import { describe, expect, it } from "vitest";
import {
  RENDERED_DENSITY_LAWS,
  WOODY_TRIANGLE_BUDGETS,
  estimateRenderedWoodyLoad,
  renderedShareAtDistance,
} from "../src/render/webgpu/detail/renderedDensity";
import {
  TREE_VARIANT_COUNTS,
  buildTreePrototype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";

/**
 * R-21 — the rendered-density law is a live budget, not prose (R-22). The
 * saturated closed-forest integral of every tier's law must fit its woody
 * triangle ceiling, the near triangle allowance must cover the REAL
 * prototypes, and the law's bands must sit inside each tier's vegetation
 * distance. D-2's Phase-1 constants integrate to ~17 M triangles against
 * Phase-2 geometry — the negative control pins why the law replaced them.
 */
describe("rendered-density law (R-21)", () => {
  it("fits every tier's saturated integral under its woody triangle budget", () => {
    RENDERED_DENSITY_LAWS.forEach((law, tier) => {
      const estimate = estimateRenderedWoodyLoad(law);
      expect(estimate.totalTriangles, `tier ${tier}`).toBeLessThanOrEqual(
        WOODY_TRIANGLE_BUDGETS[tier]!,
      );
      // Non-vacuous: the budget is a ceiling being approached, not a
      // formality — every tier spends at least half its allowance.
      expect(estimate.totalTriangles, `tier ${tier} vacuous`).toBeGreaterThan(
        WOODY_TRIANGLE_BUDGETS[tier]! * 0.5,
      );
    });
  });

  it("covers the real prototype triangle counts with the near allowance", () => {
    for (const species of Object.keys(TREE_VARIANT_COUNTS) as (keyof typeof TREE_VARIANT_COUNTS)[]) {
      const prototype = buildTreePrototype(species, 0, 7);
      const triangles = prototype.trunk.triangleCount + prototype.crown.triangleCount;
      for (const law of RENDERED_DENSITY_LAWS) {
        expect(triangles, String(species)).toBeLessThanOrEqual(law.near.trianglesPerPlant + 40);
      }
    }
  });

  it("keeps each tier's bands inside the profile's vegetation distance", () => {
    const tiers: readonly [QualityLevel, RenderingMode][] = [
      ["low", "performance"],
      ["medium", "balanced"],
      ["high", "balanced"],
      ["high", "ultra"],
    ];
    for (const [quality, mode] of tiers) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      const law = RENDERED_DENSITY_LAWS[profile.tier]!;
      expect(law.far.outerRadiusMeters, `tier ${profile.tier}`).toBeLessThanOrEqual(
        profile.vegetationDistance,
      );
      expect(law.near.outerRadiusMeters).toBeLessThan(law.mid.outerRadiusMeters);
      expect(law.mid.outerRadiusMeters).toBeLessThan(law.far.outerRadiusMeters);
    }
  });

  it("falls off inverse-square from the near boundary with a far floor", () => {
    const law = RENDERED_DENSITY_LAWS[1]!;
    expect(renderedShareAtDistance(law, 0)).toBe(1);
    expect(renderedShareAtDistance(law, law.near.outerRadiusMeters)).toBe(1);
    expect(renderedShareAtDistance(law, law.near.outerRadiusMeters * 2)).toBeCloseTo(0.25, 5);
    expect(renderedShareAtDistance(law, law.far.outerRadiusMeters)).toBe(law.farFloorShare);
    expect(() => renderedShareAtDistance(law, -1)).toThrow(RangeError);
  });

  it("pins the negative control: D-2's constants do not survive Phase-2 geometry", () => {
    // D-2 as shipped in Phase 1: 70/ha to the 1,400 m near boundary, then
    // (1000/d)² floored at 0.04, everything at full prototype cost.
    const d2 = {
      nearStemsPerHectare: 70,
      near: { outerRadiusMeters: 1_400, trianglesPerPlant: 180 },
      mid: { outerRadiusMeters: 4_500, trianglesPerPlant: 180 },
      far: { outerRadiusMeters: 4_500, trianglesPerPlant: 180 },
      farFloorShare: 0.04,
    };
    const estimate = estimateRenderedWoodyLoad(d2);
    expect(estimate.totalTriangles).toBeGreaterThan(10_000_000);
  });
});
