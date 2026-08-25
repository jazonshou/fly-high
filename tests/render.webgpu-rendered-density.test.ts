import { describe, expect, it } from "vitest";
import {
  RENDERED_DENSITY_LAWS,
  VEGETATION_DRAW_CEILING,
  VEGETATION_DRAW_COST_MS,
  VEGETATION_DRAW_SUBMISSION_RATIO,
  WOODY_TRIANGLE_BUDGETS,
  estimateRenderedWoodyLoad,
  estimateVegetationDrawCalls,
  renderedShareAtDistance,
} from "../src/render/webgpu/detail/renderedDensity";
import { FRAME_BUDGET_MS } from "../src/render/webgpu/core/PerformanceBudget";
import { DETAIL_PRESENTATION_CHUNK_CELL_SPAN } from "../src/render/webgpu/detail/spatialChunks";
import { DEFAULT_DETAIL_CELL_SIZE_METERS } from "../src/render/webgpu/detail/types";
import { IMPOSTOR_SPECIES } from "../src/render/webgpu/detail/ImpostorAtlas";
import {
  SHRUB_VARIANT_COUNTS,
  TREE_VARIANT_COUNTS,
  buildShrubPrototype,
  buildTreePrototype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import { treePrototypeSpecies } from "../src/render/webgpu/detail/treePrototypeFamily";
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

  it("fits every band prototype inside the law's per-plant allowance", () => {
    // Strict, every variant, every band, NO fudge: the original form checked
    // variant 0 against `near + 40`, and the drift it tolerated (a 220-
    // triangle forked oak against a 180 allowance, mid/far bands drawing
    // near geometry) integrated to 4.7× budget in the first 2-12 capture —
    // 29 ms of GPU where the law promised 13.
    for (const species of Object.keys(TREE_VARIANT_COUNTS) as (keyof typeof TREE_VARIANT_COUNTS)[]) {
      for (let variant = 0; variant < TREE_VARIANT_COUNTS[species]; variant += 1) {
        for (const band of ["near", "mid", "far"] as const) {
          const prototype = buildTreePrototype(species, variant, 7, band);
          const triangles = prototype.trunk.triangleCount + prototype.crown.triangleCount;
          for (const law of RENDERED_DENSITY_LAWS) {
            expect(triangles, `${species} v${variant} ${band}`).toBeLessThanOrEqual(
              law[band].trianglesPerPlant,
            );
          }
        }
      }
    }
  });

  it("fits every shrub prototype inside the mid-band allowance (2-12b)", () => {
    // Shrubs draw at near and mid only (hard cutoff at the mid boundary),
    // so the mid allowance is their ceiling everywhere they exist.
    for (const species of Object.keys(SHRUB_VARIANT_COUNTS) as (keyof typeof SHRUB_VARIANT_COUNTS)[]) {
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        const prototype = buildShrubPrototype(species, variant, 7);
        for (const law of RENDERED_DENSITY_LAWS) {
          expect(prototype.triangleCount, `${species} v${variant}`).toBeLessThanOrEqual(
            law.mid.trianglesPerPlant,
          );
        }
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
      // §5.3 defines vegetationDistance AS the impostor radius, so the far
      // band's outer edge and the profile row are the same number — a
      // larger vegetationDistance would describe plants nothing draws, and a
      // smaller one would cull the band the law budgets for. Equality, not
      // an inequality: Gate 2C shipped 4,500 m of far band under an 8,000 m
      // profile row and the slack was invisible.
      expect(law.far.outerRadiusMeters, `tier ${profile.tier}`).toBe(
        profile.vegetationDistance,
      );
      expect(law.near.outerRadiusMeters).toBeLessThan(law.mid.outerRadiusMeters);
      expect(law.mid.outerRadiusMeters).toBeLessThan(law.far.outerRadiusMeters);
    }
  });

  it("keeps §5.3's published band radii", () => {
    // The three vegetation rows the realignment added to §5.3 precisely
    // because they "sat outside every cut ladder". If a later pass wants
    // different radii it moves this table and the plan together.
    const cardTreeLodRadius = [700, 1_100, 1_500, 2_000];
    const impostorRadius = [2_000, 3_000, 4_000, 6_000];
    RENDERED_DENSITY_LAWS.forEach((law, tier) => {
      expect(law.mid.outerRadiusMeters, `tier ${tier} card radius`)
        .toBe(cardTreeLodRadius[tier]);
      expect(law.far.outerRadiusMeters, `tier ${tier} impostor radius`)
        .toBe(impostorRadius[tier]);
    });
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

/**
 * The vegetation FRAME row, made non-vacuous by the perf-debt pass. 2-12
 * measured the currency: every (species, variant, band) mesh is one draw per
 * presentation chunk per pass at ~26 µs of GPU, and Δgpu tracked Δdraws
 * linearly across all thirteen capture shots while triangle deltas measured
 * ~0. The woody-triangle budget above therefore guards the wrong axis on its
 * own; this is the other one.
 */
describe("vegetation draw-call budget (perf-debt pass)", () => {
  const CHUNK_EDGE_METERS =
    DETAIL_PRESENTATION_CHUNK_CELL_SPAN * DEFAULT_DETAIL_CELL_SIZE_METERS;

  /** Meshes a chunk submits, from the runtime's own prototype registrations. */
  function meshCounts(
    treeVariantCap: number,
    prototypeMode: "families" | "species" = "species",
  ): {
    near: number;
    mid: number;
    far: number;
    understory: number;
  } {
    const authoredSpecies = Object.keys(TREE_VARIANT_COUNTS) as (keyof typeof TREE_VARIANT_COUNTS)[];
    const species = [...new Set(
      authoredSpecies.map((name) => treePrototypeSpecies(name, prototypeMode)),
    )];
    const nearVariants = species.reduce(
      (sum, name) => sum + Math.min(TREE_VARIANT_COUNTS[name], treeVariantCap, 3),
      0,
    );
    const midVariants = species.reduce(
      (sum, name) => sum + Math.min(TREE_VARIANT_COUNTS[name], treeVariantCap, 3),
      0,
    );
    const shrubMeshes = Object.values(SHRUB_VARIANT_COUNTS).reduce((a, b) => a + b, 0);
    return {
      // Crown and trunk are separate materials, so separate draws.
      near: nearVariants * 2,
      mid: midVariants * 2,
      far: 1,
      // Shrub variants + three rock lithologies + four clutter kinds + four
      // ground-cover archetypes, all near-band only.
      understory: shrubMeshes + 3 + 4 + 4,
    };
  }

  it("collapsed the far band to ONE mesh per chunk", () => {
    // 2-17 registered one impostor prototype PER SPECIES. The quad geometry
    // never differed; only the bake frame did, and that is a per-instance
    // uniform row now. The far band spans more chunks than near and mid
    // together, so this is where the draw calls were.
    expect(meshCounts(5).far).toBe(1);
    expect(IMPOSTOR_SPECIES.length).toBeGreaterThan(1);
  });

  const TIERS: readonly [QualityLevel, RenderingMode][] = [
    ["low", "performance"],
    ["medium", "balanced"],
    ["high", "balanced"],
    ["high", "ultra"],
  ];

  function estimateForTier(quality: QualityLevel, mode: RenderingMode) {
    const profile = resolveWebGpuQualityProfile(quality, mode);
    const counts = meshCounts(profile.treeVariantCap, profile.treePrototypeMode);
    return {
      profile,
      counts,
      estimate: estimateVegetationDrawCalls({
        law: profile.renderedDensityLaw,
        chunkEdgeMeters: CHUNK_EDGE_METERS,
        nearMeshesPerChunk: counts.near,
        midMeshesPerChunk: counts.mid,
        farMeshesPerChunk: counts.far,
        understoryMeshesPerChunk: counts.understory,
        // Only the near band casts, and only where the tier's
        // `vegetationCastsShadows` datum lets it (4.5-C1): mid, far,
        // understory and ground cover are all registered with castsShadows
        // false in the runtime itself.
        shadowMeshesPerChunk: profile.vegetationCastsShadows ? counts.near : 0,
        shadowCascades: profile.shadowCascades,
      }),
    };
  }

  it("holds every tier under the draw ceiling the renderer currently meets", () => {
    for (const [quality, mode] of TIERS) {
      const { profile, estimate } = estimateForTier(quality, mode);
      const ceiling = VEGETATION_DRAW_CEILING[profile.tier]!;
      expect(estimate.total, `tier ${profile.tier} draws`).toBeLessThanOrEqual(ceiling);
      // Non-vacuous: a ceiling the renderer sits far under is not a guard.
      expect(estimate.total, `tier ${profile.tier} vacuous ceiling`)
        .toBeGreaterThan(ceiling * 0.8);
      expect(estimate.total * VEGETATION_DRAW_COST_MS).toBeCloseTo(estimate.estimatedMs, 9);
    }
  });

  it("pins submission spend without claiming full vegetation-frame closure", () => {
    for (const [quality, mode] of TIERS) {
      const { profile, estimate } = estimateForTier(quality, mode);
      const row = FRAME_BUDGET_MS[profile.tier].vegetation;
      const ratio = estimate.estimatedMs / row;
      expect(ratio, `tier ${profile.tier} debt ratio`)
        .toBeCloseTo(VEGETATION_DRAW_SUBMISSION_RATIO[profile.tier]!, 2);
      if (profile.tier <= 1) {
        expect(ratio, `tier ${profile.tier} family submission path`).toBeLessThanOrEqual(1);
      } else {
        expect(ratio, `tier ${profile.tier} still over budget`).toBeGreaterThan(1);
      }
    }
  });

  it("67c: prices and rejects the measured crown/trunk structural rung", () => {
    // The prospective model assumed crown/trunk geometry could share one
    // draw after resolving their different radial-aspect values per vertex.
    // The experiment showed the model omitted a material-bucket cost: opaque
    // trunks lost depth pre-fill when carried by the alpha-tested foliage
    // material. Keep pricing the attractive count reduction here, but keep
    // the measured rejection beside it so a later pass cannot treat the
    // arithmetic as proof of a real GPU win.
    const { profile, counts, estimate } = estimateForTier("medium", "balanced");
    const merged = estimateVegetationDrawCalls({
      law: profile.renderedDensityLaw,
      chunkEdgeMeters: CHUNK_EDGE_METERS,
      nearMeshesPerChunk: counts.near / 2,
      midMeshesPerChunk: counts.mid / 2,
      farMeshesPerChunk: counts.far,
      understoryMeshesPerChunk: counts.understory,
      shadowMeshesPerChunk: profile.vegetationCastsShadows ? counts.near / 2 : 0,
      shadowCascades: profile.shadowCascades,
    });
    expect(merged.total).toBeLessThan(estimate.total);
    // Prototype-family batching closes tier 1 without moving opaque trunks
    // into the alpha-test bucket that regressed every measured heavy shot.
    expect(estimate.estimatedMs).toBeLessThan(FRAME_BUDGET_MS[profile.tier].vegetation);

    // Gate B's five core sub-30 shots, recorded as OLD minus MERGED GPU p95.
    // Acceptance required every value >= 2 ms and no regression; negative
    // values are regressions. The alpha-test merge therefore stays reverted.
    const coreGpuImprovementsMs = Object.freeze({
      "approach-500ft": -1.725,
      "reference-viewport": -2.087,
      "winter-noon": -1.013,
      night: -0.784,
      "motion-banked-turn": -1.169,
    });
    expect(Object.values(coreGpuImprovementsMs).every((delta) => delta >= 2)).toBe(false);
    expect(Object.values(coreGpuImprovementsMs).every((delta) => delta < 0)).toBe(true);
    expect(counts.near % 2, "split crown/trunk mesh count remains live").toBe(0);
  });

  it("pins what the far-band merge was worth", () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const counts = meshCounts(profile.treeVariantCap, profile.treePrototypeMode);
    const shared = { 
      law: profile.renderedDensityLaw,
      chunkEdgeMeters: CHUNK_EDGE_METERS,
      nearMeshesPerChunk: counts.near,
      midMeshesPerChunk: counts.mid,
      understoryMeshesPerChunk: counts.understory,
      shadowMeshesPerChunk: profile.vegetationCastsShadows ? counts.near : 0,
      shadowCascades: profile.shadowCascades,
    };
    const merged = estimateVegetationDrawCalls({ ...shared, farMeshesPerChunk: 1 });
    const perSpecies = estimateVegetationDrawCalls({
      ...shared,
      farMeshesPerChunk: IMPOSTOR_SPECIES.length,
    });
    expect(perSpecies.far).toBeGreaterThan(merged.far * 6);
    expect(merged.estimatedMs).toBeLessThan(perSpecies.estimatedMs);
  });
});
