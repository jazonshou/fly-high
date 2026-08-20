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
   *
   * That claim is only true of the DOMINANT stems, and it is why the runtime
   * thins by canopy rank rather than by a uniform key: the authored field's
   * mean crown radius is 3.40 m, its 70 widest stems per hectare average
   * 5.80 m, and the difference between them is the difference between 0.26
   * and 0.55 rendered cover (`tests/render.webgpu-canopy-closure.test.ts`).
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
 *
 * **Re-tuned 2026-08-19 by the vegetation perf-debt pass.** The band radii
 * are now the ones `RENDERING_PLAN.md` §5.3 publishes — card-tree LOD radius
 * (near + mid) 700 / 1,100 / 1,500 / 2,000 m and impostor radius
 * (= `vegetationDistance`, = `far.outerRadiusMeters`) 2.0 / 3.0 / 4.0 /
 * 6.0 km. Those three rows were added to §5.3 by the realignment precisely
 * because they "sat outside every cut ladder", and Gate 2C shipped against
 * the pre-amendment values (4.5 km / 8 km). Bringing them in is lever 2 of
 * §5.3's vegetation trade-off rule — the COUNT moves, no card changes — and
 * it is what pays for the open near-field frame debt: saturated closed
 * forest drops 19,445 → 14,497 rendered stems at tier 1 and 40,503 → 22,633
 * at tier 2, and the far band's submitted chunk count falls with the square
 * of its radius (that is where the draw calls were).
 */
export const RENDERED_DENSITY_LAWS: readonly RenderedDensityLaw[] = Object.freeze([
  // Tier 0 — vegetationDistance 2,000 m, 1.2 ms row.
  Object.freeze({
    nearStemsPerHectare: 55,
    near: Object.freeze({ outerRadiusMeters: 250, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 700, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 2_000, trianglesPerPlant: 8 }),
    farFloorShare: 0.02,
  }),
  // Tier 1 — the G-target. vegetationDistance 3,000 m, 1.8 ms row.
  // 70 -> 78 stems/ha at the perf-debt pass: with canopy-rank thinning the
  // drawn stand's crown cover measures 0.532 at 70/ha and 0.551 at 78/ha
  // against Gate 2C's 0.55 criterion. The +11% near stems are paid for many
  // times over by the band radii moving to §5.3's (total rendered stems fall
  // 19,445 -> 15,441), so the count row still moves DOWN in this commit.
  Object.freeze({
    nearStemsPerHectare: 78,
    near: Object.freeze({ outerRadiusMeters: 350, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 1_100, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 3_000, trianglesPerPlant: 8 }),
    farFloorShare: 0.02,
  }),
  // Tier 2 — vegetationDistance 4,000 m, 1.9 ms row.
  Object.freeze({
    nearStemsPerHectare: 79,
    near: Object.freeze({ outerRadiusMeters: 400, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 1_500, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 4_000, trianglesPerPlant: 8 }),
    farFloorShare: 0.015,
  }),
  // Tier 3 — same near cap as tier 2 with the 3.6 ms row's slack spent on a
  // deeper near and card band, not more stems.
  Object.freeze({
    nearStemsPerHectare: 79,
    near: Object.freeze({ outerRadiusMeters: 550, trianglesPerPlant: 180 }),
    mid: Object.freeze({ outerRadiusMeters: 2_000, trianglesPerPlant: 48 }),
    far: Object.freeze({ outerRadiusMeters: 6_000, trianglesPerPlant: 8 }),
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

// ---------------------------------------------------------------------------
// Canopy closure — the Gate 2C exit criterion, as a kernel instead of an eye.
// ---------------------------------------------------------------------------

/**
 * Gate 2C's canopy-closure criterion: rendered crown cover over a 2 km
 * window must reach 0.55 in closed forest. It sat unautomated at the phase
 * close ("pairs with the perf-debt pass, which will tune the same
 * constants") — which is exactly the shape R-22 warns about, a criterion
 * nothing can fail. It is a kernel now, and `tests/render.webgpu-canopy-
 * closure.test.ts` feeds it REAL generated stems.
 */
export const CANOPY_CLOSURE_TARGET = 0.55;

/**
 * Boolean-model crown cover for a Poisson field of discs: a point is bare
 * only if no crown covers it, and crown centres are (near enough) Poisson,
 * so `cover = 1 − exp(−Σπr² / A)`. Taking Σπr² rather than n·π r̄² is what
 * keeps a mixed-species stand honest — cover is driven by the second moment
 * of the radius distribution, and a few large crowns close a canopy that the
 * mean radius says is open.
 *
 * @param summedCrownAreaSquareMeters Σ π·r² over the RENDERED stems.
 * @param windowAreaSquareMeters      the measurement window's ground area.
 */
export function crownCoverFromAreas(
  summedCrownAreaSquareMeters: number,
  windowAreaSquareMeters: number,
): number {
  if (!(windowAreaSquareMeters > 0) || !Number.isFinite(summedCrownAreaSquareMeters)) {
    throw new RangeError("Crown cover needs a positive window area and a finite crown area");
  }
  return 1 - Math.exp(-Math.max(0, summedCrownAreaSquareMeters) / windowAreaSquareMeters);
}

/**
 * The same cover, evaluated at a law's near cap for a uniform crown radius —
 * the closed form the near cap was chosen against. At tier 1 (70 stems/ha)
 * this reads 0.55 at a 6.0 m crown radius and 0.66 at 7.0 m, which is the
 * "~60–80 stems/ha with 6–7 m crowns" the law's own comment claims.
 */
export function renderedCanopyClosure(
  law: RenderedDensityLaw,
  crownRadiusMeters: number,
): number {
  const HECTARE = 10_000;
  return crownCoverFromAreas(
    law.nearStemsPerHectare * Math.PI * crownRadiusMeters * crownRadiusMeters,
    HECTARE,
  );
}

// ---------------------------------------------------------------------------
// The draw-call model — the vegetation frame row, made non-vacuous.
// ---------------------------------------------------------------------------

/**
 * Measured at `2-12`: every (species, variant, band) mesh is ONE draw per
 * presentation chunk per pass, at ~26 µs of GPU each, and `Δgpu` tracked
 * `Δdraws` linearly across all thirteen capture shots while triangle deltas
 * measured ~0. Vegetation is a draw-call workload, not a triangle workload,
 * so the vegetation frame row has to be spent in draws to mean anything.
 */
export const VEGETATION_DRAW_COST_MS = 0.026;

/**
 * Fraction of the far band's presentation chunks that survives frustum
 * culling. The camera's 62° horizontal FOV is 0.172 of a circle; chunks are
 * coarse (4,096 m — eight 512 m generation cells) so any chunk clipped by
 * either frustum edge still submits, which inflates the share well above the
 * FOV ratio. Near and mid chunks are NOT scaled by it: their bands are
 * smaller than one chunk, so the observer is inside every chunk that carries
 * them and none of those is ever fully outside the frustum.
 */
export const VEGETATION_FRUSTUM_CHUNK_SHARE = 0.35;

export interface VegetationDrawModelInput {
  readonly law: RenderedDensityLaw;
  /** Presentation-chunk edge in metres (`spatialChunks.ts` × the cell size). */
  readonly chunkEdgeMeters: number;
  /** Distinct meshes a chunk submits inside the near band (crown + trunk). */
  readonly nearMeshesPerChunk: number;
  readonly midMeshesPerChunk: number;
  /** `2-17`: ONE merged impostor mesh per chunk since the perf-debt pass. */
  readonly farMeshesPerChunk: number;
  /** Understory, rocks, clutter and ground cover — all near-band only. */
  readonly understoryMeshesPerChunk: number;
  /** Shadow-casting meshes per near chunk, times the cascade count. */
  readonly shadowMeshesPerChunk: number;
  readonly shadowCascades: number;
}

export interface VegetationDrawEstimate {
  readonly near: number;
  readonly mid: number;
  readonly far: number;
  readonly understory: number;
  readonly shadow: number;
  readonly total: number;
  readonly estimatedMs: number;
}

/**
 * Presentation chunks a disc of the given radius touches. A chunk grid is
 * axis-aligned, so the disc spans `1 + 2R/C` chunks per axis in the worst
 * case (the observer standing on a corner) — squared for the plane. This is
 * a count of chunks that SUBMIT the band's meshes, not of their area: one
 * instance inside a chunk costs the same draw as ten thousand.
 */
function chunksTouchedByDisc(radiusMeters: number, chunkEdgeMeters: number): number {
  return (1 + (2 * radiusMeters) / chunkEdgeMeters) ** 2;
}

/** Vegetation draw calls per frame, beauty pass plus the shadow cascades. */
export function estimateVegetationDrawCalls(
  input: VegetationDrawModelInput,
): VegetationDrawEstimate {
  const { law, chunkEdgeMeters } = input;
  const nearChunks = chunksTouchedByDisc(law.near.outerRadiusMeters, chunkEdgeMeters);
  const midChunks = chunksTouchedByDisc(law.mid.outerRadiusMeters, chunkEdgeMeters);
  const farChunks = Math.max(
    1,
    chunksTouchedByDisc(law.far.outerRadiusMeters, chunkEdgeMeters)
      * VEGETATION_FRUSTUM_CHUNK_SHARE,
  );
  const near = nearChunks * input.nearMeshesPerChunk;
  const mid = midChunks * input.midMeshesPerChunk;
  const far = farChunks * input.farMeshesPerChunk;
  const understory = nearChunks * input.understoryMeshesPerChunk;
  const shadow = nearChunks * input.shadowMeshesPerChunk * input.shadowCascades;
  const total = near + mid + far + understory + shadow;
  return Object.freeze({
    near,
    mid,
    far,
    understory,
    shadow,
    total,
    estimatedMs: total * VEGETATION_DRAW_COST_MS,
  });
}

/**
 * **The open vegetation frame debt, as a number.**
 *
 * The 2-17-close ledger recorded "vegetation GPU cost at tier 1 near-field
 * runs ~3-7 ms against the 1.8 ms row" and named three remaining rungs:
 * near-field density tuning, instance-buffer reuse, and shadow-pass alpha
 * simplification. The perf-debt pass took all three and then measured what
 * they were worth, which turned out to be the useful result:
 *
 * - **Density and radius tuning moves almost nothing.** Draws scale with
 *   (chunks × meshes), and a presentation chunk is 4,096 m — wider than the
 *   whole near+mid field at every tier. Halving the impostor radius removes
 *   a couple of far-band chunks; it cannot remove a near-band mesh.
 * - **Instance-buffer reuse is a CPU and allocation win, not a draw win.**
 * - **Only mesh COUNT per chunk moves the number**, and §5.3's vegetation
 *   trade-off rule puts crown variants per species on the "not a budget knob
 *   at any tier" list. So no lever the rule permits can close this row.
 *
 * Gate B-2 measured the structural option this model prices: one prototype
 * carrying crown and trunk would halve the near, mid and shadow terms —
 * 347 → 186 modelled draws and 9.0 → 4.8 modelled ms at tier 1. The real
 * adapter result rejected it. Moving opaque trunks into the alpha-test
 * foliage bucket regressed GPU p95 in every one of the five core sub-30-fps
 * shots (0.78–2.09 ms), instead of improving each by at least 2 ms. The
 * experiment was reverted exactly as the conditional gate required, so the
 * separate opaque trunk pre-fill remains live and these pre-merge ceilings
 * deliberately remain the regression guard.
 *
 * These ceilings are what the renderer meets today. They are a regression
 * guard, not a budget: `estimatedMs` at each of them is still above §5.4's
 * vegetation row, and the ratio below says by how much.
 */
export const VEGETATION_DRAW_CEILING: readonly number[] = Object.freeze([
  270,
  360,
  // `4-8b` cut this tier from four shadow cascades to three (§5.3's near-field
  // rows), and the near band submits its meshes once per cascade — so the
  // ceiling comes down with the measurement rather than staying a number the
  // renderer now sits comfortably under. Measured 462.0 draws.
  500,
  650,
]);

/**
 * Measured debt against §5.4's vegetation frame row, per tier — the number
 * the next pass has to move. Pinned by test so it can only change with a
 * measurement, and so that closing the debt fails the assertion and forces
 * this record to be deleted rather than quietly outlived.
 */
export const VEGETATION_FRAME_DEBT_RATIO: readonly number[] = Object.freeze([
  5.57,
  5.01,
  // Re-measured at `4-8b`: 7.38 → 6.32, from the tier-2 cascade cut. The debt
  // is not closed and this record is not deleted; it moved, and a moved number
  // has to be re-pinned or the assertion stops meaning anything.
  6.32,
  4.56,
]);
