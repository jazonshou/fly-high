/**
 * Wave G — the ground-cover blade LAW.
 *
 * INVARIANT THIS FILE OWNS: one authority decides how many grass blades are
 * placed per square metre at each camera range, per tier, what each blade may
 * cost in vertices, and how the whole system fades with altitude. The
 * GroundCoverSystem's lattice sizing, its compute dispatch counts, its GPU
 * buffer capacities and the budget test all read these constants.
 *
 * Design (wave-G research, Ghost-of-Tsushima calibrated): blades are opaque
 * Bézier ribbons regenerated every frame by compute as a pure function of
 * world position — no streaming state, no popping, speed-independent. Three
 * camera-centred rings step density and blade vertex count down with range;
 * beyond the last ring the terrain material carries the ground alone. The
 * altitude gate scales ring radii (and so blade counts quadratically) to
 * zero across the fade band, which makes the system free in almost all of
 * the flight envelope — it exists for the terrain viewer's 2 m eye and the
 * final metres of a landing.
 *
 * Class P: pure data + arithmetic, Node-tested.
 */

export interface GroundCoverRing {
  /** Outer radius of the ring at full altitude gate, metres. */
  readonly outerRadiusMeters: number;
  /** Blade lattice spacing, metres (density = 1/s²). */
  readonly spacingMeters: number;
  /** Bézier segments per blade (vertices = 2·segments + 1). */
  readonly segments: number;
  /** Width multiplier compensating the ring's lower density. */
  readonly widthScale: number;
}

export interface GroundCoverLaw {
  readonly rings: readonly [GroundCoverRing, GroundCoverRing, GroundCoverRing];
  /** Full blade coverage below this camera height above ground. */
  readonly altitudeFadeLowMeters: number;
  /** No blades above this camera height above ground. */
  readonly altitudeFadeHighMeters: number;
}

/** Vertices for one blade ribbon of the ring's segment count. */
export function groundCoverBladeVertices(ring: GroundCoverRing): number {
  return 2 * ring.segments + 1;
}

/** Triangles for one blade ribbon. */
export function groundCoverBladeTriangles(ring: GroundCoverRing): number {
  return 2 * ring.segments - 1;
}

/**
 * Lattice edge cells for a ring at the FULL gate. The lattice is fixed at
 * the full-gate size so GPU buffer capacities never move with altitude; the
 * gate shrinks the live radius through a uniform and out-of-radius lanes
 * write degenerate blades.
 */
export function groundCoverLatticeEdge(ring: GroundCoverRing): number {
  return Math.ceil((2 * ring.outerRadiusMeters) / ring.spacingMeters) + 1;
}

export function groundCoverLaneCount(ring: GroundCoverRing): number {
  const edge = groundCoverLatticeEdge(ring);
  return edge * edge;
}

/** Worst-case vertex invocations per frame across a law's three rings. */
export function estimateGroundCoverVertexLoad(law: GroundCoverLaw): number {
  return law.rings.reduce(
    (sum, ring) => sum + groundCoverLaneCount(ring) * groundCoverBladeVertices(ring),
    0,
  );
}

/**
 * Per-tier laws. The v1 renderer deliberately ships the research plan's
 * "no-compaction" rung: every lattice lane writes its record each frame
 * (blade or degenerate), so correctness needs no atomics, no counters and no
 * indirect draws. The vertex-load estimator above is therefore the honest
 * cost model, and the budget test pins it per tier.
 */
export const GROUND_COVER_LAWS: readonly GroundCoverLaw[] = Object.freeze([
  // Tier 0 — a modest near carpet only.
  Object.freeze({
    rings: Object.freeze([
      Object.freeze({ outerRadiusMeters: 9, spacingMeters: 0.21, segments: 5, widthScale: 1 }),
      Object.freeze({ outerRadiusMeters: 24, spacingMeters: 0.42, segments: 3, widthScale: 1.7 }),
      Object.freeze({ outerRadiusMeters: 52, spacingMeters: 0.85, segments: 2, widthScale: 2.6 }),
    ] as const),
    altitudeFadeLowMeters: 16,
    altitudeFadeHighMeters: 55,
  }),
  // Tier 1 — the G-target tier.
  Object.freeze({
    rings: Object.freeze([
      Object.freeze({ outerRadiusMeters: 13, spacingMeters: 0.18, segments: 7, widthScale: 1 }),
      Object.freeze({ outerRadiusMeters: 34, spacingMeters: 0.36, segments: 3, widthScale: 1.8 }),
      Object.freeze({ outerRadiusMeters: 80, spacingMeters: 0.72, segments: 2, widthScale: 2.8 }),
    ] as const),
    altitudeFadeLowMeters: 20,
    altitudeFadeHighMeters: 80,
  }),
  // Tier 2.
  Object.freeze({
    rings: Object.freeze([
      Object.freeze({ outerRadiusMeters: 15, spacingMeters: 0.16, segments: 7, widthScale: 1 }),
      Object.freeze({ outerRadiusMeters: 40, spacingMeters: 0.32, segments: 3, widthScale: 1.8 }),
      Object.freeze({ outerRadiusMeters: 95, spacingMeters: 0.64, segments: 2, widthScale: 2.8 }),
    ] as const),
    altitudeFadeLowMeters: 22,
    altitudeFadeHighMeters: 90,
  }),
  // Tier 3.
  Object.freeze({
    rings: Object.freeze([
      Object.freeze({ outerRadiusMeters: 18, spacingMeters: 0.15, segments: 7, widthScale: 1 }),
      Object.freeze({ outerRadiusMeters: 48, spacingMeters: 0.3, segments: 3, widthScale: 1.8 }),
      Object.freeze({ outerRadiusMeters: 110, spacingMeters: 0.6, segments: 2, widthScale: 2.8 }),
    ] as const),
    altitudeFadeLowMeters: 25,
    altitudeFadeHighMeters: 110,
  }),
]);

/**
 * Domain tile: a camera-snapped CPU bake of the rendered surface (height from
 * the consumer authority) and the classifier's ground attributes, uploaded as
 * small textures the placement compute samples. Height at 1 m matches the
 * terrain's own 2 m L0 texel content; attributes at 4 m carry only regional
 * tone and density.
 */
export const GROUND_COVER_TILE_SPAN_METERS = 256;
export const GROUND_COVER_HEIGHT_TILE_EDGE = 256;
export const GROUND_COVER_ATTRIBUTE_TILE_EDGE = 64;
/** The tile re-centres when the camera crosses this quantum. */
export const GROUND_COVER_TILE_SNAP_METERS = 32;
/** CPU milliseconds per frame the amortised tile bake may spend. */
export const GROUND_COVER_TILE_BAKE_MILLISECONDS_PER_FRAME = 1.5;

/** GPU bytes for one blade record (two vec4f). */
export const GROUND_COVER_BLADE_STRIDE_BYTES = 32;

export function groundCoverBufferBytes(law: GroundCoverLaw): number {
  return law.rings.reduce(
    (sum, ring) => sum + groundCoverLaneCount(ring) * GROUND_COVER_BLADE_STRIDE_BYTES,
    0,
  );
}
