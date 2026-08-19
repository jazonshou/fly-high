/**
 * R-21 — the rendered-density LAW (Gate 2C head).
 *
 * INVARIANT THIS FILE OWNS: one authority decides how many woody plants are
 * RENDERED per hectare at each range, per tier, and what each one may cost
 * in triangles. `2-14`'s LOD radii, `2-12`'s card budget, `2-17`'s impostor
 * band and the thinning in `WorldDetailRuntime` all read these constants —
 * nothing re-derives its own density ceiling.
 *
 * Why D-2's constants could not simply be adopted: D-2 (Phase 1) capped the
 * rendered field at `40 + 30·density` stems/ha out to the near boundary with
 * a `(1000/d)²` mid falloff floored at 0.04 — tuned when a "tree" was a
 * handful of crown cones. Integrated over tier 1's 4.5 km field with Phase
 * 2's real prototypes (152–212 triangles), that law renders ~94,000 stems ≈
 * 17 M triangles — 10–19× every tier's vegetation frame row. The mechanism
 * (per-hectare cap, inverse-square falloff, selection-keyed thinning)
 * survives; the constants become three-banded and per-tier, derived in the
 * table in `PHASE_2_EXECUTION_PLAN.md` §3 and pinned by test against the
 * frame rows (R-22: the assertion moves when the inputs move).
 *
 * Class P: pure data + arithmetic, Node-tested.
 */

export interface RenderedDensityBand {
  /** Outer radius of the band, metres from the observer. */
  readonly outerRadiusMeters: number;
  /** Triangle allowance per rendered woody plant inside this band. */
  readonly trianglesPerPlant: number;
}

export interface RenderedDensityLaw {
  /**
   * Rendered stems/ha cap at closure inside the near band. Closed forest
   * reaches crown-overlap closure at ~60–80 stems/ha with 6–7 m crowns, so
   * the near cap IS the closure density — the clump keeps its interior.
   */
  readonly nearStemsPerHectare: number;
  /** Full-geometry band (trunk sweep + tilted crown quads). */
  readonly near: RenderedDensityBand;
  /**
   * Card band: same placement, reduced crown quad count. Share falls off as
   * (nearRadius / d)² from the near boundary outward.
   */
  readonly mid: RenderedDensityBand;
  /**
   * Impostor band out to the profile's vegetation distance. Share continues
   * the inverse-square falloff but never below this floor — the horizon
   * forest must not fade to bare ground.
   */
  readonly far: RenderedDensityBand;
  readonly farFloorShare: number;
}

/**
 * Per-tier laws. Derived 2026-08-18 in the plan's §3 three-column table;
 * each tier's integral must land under the woody share of §5.4's vegetation
 * frame row (grass carries its own ≤0.9 M-triangle cap from `2-16`).
 */
export const RENDERED_DENSITY_LAWS: readonly RenderedDensityLaw[] = Object.freeze([
  // Tier 0 — vegetationDistance 2,000 m, 1.2 ms row.
  Object.freeze({
    nearStemsPerHectare: 55,
    near: Object.freeze({ outerRadiusMeters: 250, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 900, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 2_000, trianglesPerPlant: 8 }),
    farFloorShare: 0.02,
  }),
  // Tier 1 — the G-target. vegetationDistance 4,500 m, 1.8 ms row.
  Object.freeze({
    nearStemsPerHectare: 70,
    near: Object.freeze({ outerRadiusMeters: 350, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 1_400, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 4_500, trianglesPerPlant: 8 }),
    farFloorShare: 0.02,
  }),
  // Tier 2 — vegetationDistance 8,000 m, 1.9 ms row: the far field is wide,
  // so the near band stays tight and the floor drops.
  Object.freeze({
    nearStemsPerHectare: 79,
    near: Object.freeze({ outerRadiusMeters: 400, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 1_400, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 8_000, trianglesPerPlant: 8 }),
    farFloorShare: 0.015,
  }),
  // Tier 3 — same field as tier 2 with the 3.6 ms row's slack spent on a
  // deeper near band, not more stems.
  Object.freeze({
    nearStemsPerHectare: 79,
    near: Object.freeze({ outerRadiusMeters: 550, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 1_800, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 8_000, trianglesPerPlant: 8 }),
    farFloorShare: 0.015,
  }),
]);

/** Rendered share of the near cap at range d (the law's falloff curve). */
export function renderedShareAtDistance(law: RenderedDensityLaw, distanceMeters: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new RangeError("Rendered-share distance must be a non-negative finite number");
  }
  if (distanceMeters <= law.near.outerRadiusMeters) return 1;
  const falloff = (law.near.outerRadiusMeters / distanceMeters) ** 2;
  if (distanceMeters <= law.mid.outerRadiusMeters) return falloff;
  return Math.max(falloff, law.farFloorShare);
}

export interface RenderedDensityEstimate {
  readonly nearStems: number;
  readonly midStems: number;
  readonly farStems: number;
  readonly totalStems: number;
  readonly totalTriangles: number;
}

/**
 * Closed-forest worst case: the authored field saturates the cap over the
 * whole disc. The real world is patchier; the budget must survive the
 * saturated case because a player can fly over unbroken forest.
 */
export function estimateRenderedWoodyLoad(law: RenderedDensityLaw): RenderedDensityEstimate {
  const HECTARE = 10_000;
  const integrate = (r0: number, r1: number): number => {
    const steps = 2_048;
    let stems = 0;
    for (let index = 0; index < steps; index += 1) {
      const r = r0 + ((index + 0.5) / steps) * (r1 - r0);
      stems += 2 * Math.PI * r
        * ((law.nearStemsPerHectare * renderedShareAtDistance(law, r)) / HECTARE)
        * ((r1 - r0) / steps);
    }
    return stems;
  };
  const nearStems = integrate(0, law.near.outerRadiusMeters);
  const midStems = integrate(law.near.outerRadiusMeters, law.mid.outerRadiusMeters);
  const farStems = integrate(law.mid.outerRadiusMeters, law.far.outerRadiusMeters);
  return Object.freeze({
    nearStems,
    midStems,
    farStems,
    totalStems: nearStems + midStems + farStems,
    totalTriangles: nearStems * law.near.trianglesPerPlant
      + midStems * law.mid.trianglesPerPlant
      + farStems * law.far.trianglesPerPlant,
  });
}

/**
 * Woody triangle ceilings per tier — the vegetation frame row's share after
 * grass's own `2-16` cap. R-22: the law test asserts each tier's saturated
 * integral fits under these, so a constant change here or in the law moves
 * a real assertion.
 */
export const WOODY_TRIANGLE_BUDGETS: readonly number[] = Object.freeze([
  450_000,
  1_000_000,
  1_800_000,
  2_600_000,
]);
