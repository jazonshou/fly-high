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

// ---------------------------------------------------------------------------
// `6-9` — the field carries every ground-cover archetype, not just grass
// ---------------------------------------------------------------------------

/**
 * The four archetypes the GPU field renders, in the order the 2-bit code uses.
 *
 * `densityField.ts`'s `GROUND_COVER_ARCHETYPES` has FIVE lanes; the fifth
 * (`clutter` — fallen wood, stones) is deliberately absent. Clutter is not a
 * ribbon: it is `2-15`'s solid debris with its own prototypes, lithologies
 * and slope alignment, and forcing it through a Bézier strip would be a
 * second, worse answer to a question the card path already answers well. The
 * mix is still normalised over all five (the WGSL law computes the clutter
 * lane exactly as the TypeScript does) — clutter simply loses its draw here
 * and keeps its card, which is what makes the handoff share-preserving.
 */
export const GROUND_COVER_FIELD_ARCHETYPES = [
  "grass",
  "fern",
  "heather",
  "reed",
] as const;

export type GroundCoverFieldArchetype = (typeof GROUND_COVER_FIELD_ARCHETYPES)[number];

/**
 * Per-archetype ribbon shape, read by BOTH the placement compute and the
 * blade material plugin.
 *
 * `heightScale`/`widthScale` multiply the ring's base blade size; `bendBias`
 * shifts the tilt distribution (a fern arches, a reed does not); `taper` is
 * the exponent of the root-to-tip width profile (grass tapers to a point,
 * a fern frond keeps its width most of the way); `windResponse` scales the
 * shared gust term. The numbers mirror the card path's own per-archetype
 * scales in `generation.ts`/`presentationBuild.ts` so the two representations
 * read as the same plant at the handoff radius rather than as two species.
 */
export interface GroundCoverArchetypeShape {
  readonly heightScale: number;
  readonly widthScale: number;
  readonly bendBias: number;
  readonly taper: number;
  readonly windResponse: number;
  /**
   * Share of the lattice this archetype claims where it wins the mix.
   *
   * **This is the count lever, and it exists because a frond is not a blade.**
   * The lattice is sized for grass — 30 lanes per square metre in the near
   * ring — and placing a fern on every one of them would draw a wall of
   * triangles where the card path drew about a third of a patch. Each number
   * lands the archetype's realised density within a small multiple of the
   * card density it replaces, so the handoff at the radius reads as one
   * population rather than two.
   */
  readonly densityScale: number;
  /**
   * The CARD path's per-archetype instance tint, verbatim
   * (`generation.ts`'s `buildGroundCoverGrid`).
   *
   * **It is a tint, not an albedo, and the grass row is what proves it:**
   * grass reads `[0.42, 0.56, 0.30]` where the Grass surface material's own
   * `referenceAlbedo` — the linear space the whole terrain palette is
   * authored in — is `[0.118, 0.183, 0.058]`, a factor of 3.1–3.6. The card
   * path multiplies this into a textured card, so the numbers only ever mean
   * anything relative to each other. Read
   * `groundCoverArchetypeAlbedoTint` for the factor the BLADE path needs;
   * never mix this value into a linear albedo directly.
   */
  readonly color: readonly [number, number, number];
  /**
   * How far the ground albedo is pulled toward this archetype's tint
   * (0 = pure ground).
   */
  readonly colorMix: number;
}

export const GROUND_COVER_ARCHETYPE_SHAPES:
Readonly<Record<GroundCoverFieldArchetype, GroundCoverArchetypeShape>> = Object.freeze({
  // Grass is the reference: every number is 1 and the colour is the ground's.
  grass: Object.freeze({
    heightScale: 1,
    widthScale: 1,
    bendBias: 0,
    taper: 0.82,
    windResponse: 1,
    densityScale: 1,
    color: Object.freeze([0.42, 0.56, 0.3] as const),
    colorMix: 0,
  }),
  // A frond: lower, much wider, strongly arched, barely tapered, and stiff
  // (it grows in shelter, so it does not ripple like open grass).
  fern: Object.freeze({
    heightScale: 0.85,
    widthScale: 2.6,
    bendBias: 0.34,
    taper: 0.34,
    windResponse: 0.5,
    densityScale: 0.18,
    color: Object.freeze([0.34, 0.5, 0.3] as const),
    colorMix: 0.62,
  }),
  // A woody sprig: short, narrow, upright and stiff.
  heather: Object.freeze({
    heightScale: 0.55,
    widthScale: 0.75,
    bendBias: -0.06,
    taper: 0.95,
    windResponse: 0.3,
    densityScale: 0.4,
    color: Object.freeze([0.5, 0.44, 0.5] as const),
    colorMix: 0.55,
  }),
  // A stalk: tall, very narrow, near-untapered, and it sways.
  reed: Object.freeze({
    heightScale: 1.9,
    widthScale: 0.55,
    bendBias: -0.08,
    taper: 0.2,
    windResponse: 0.9,
    densityScale: 0.3,
    color: Object.freeze([0.55, 0.58, 0.38] as const),
    colorMix: 0.5,
  }),
});

/**
 * One archetype's albedo tint RELATIVE to the reference row, as a per-channel
 * multiplier the blade path applies to the ground's own harmonised albedo.
 *
 * The table above holds the card path's instance tints, which live in the
 * card's own space; the blade's base colour is the terrain's *linear* albedo
 * (`SURFACE_MATERIALS[...].referenceAlbedo`, 0.06–0.18 for every ground
 * material). Mixing 50–62% of a 0.30–0.58 tint into a 0.10 albedo is a units
 * error, and it is the one `6-9` shipped: fern/heather/reed came out at
 * linear luminance 0.32–0.36 against a grass ground of 0.16 and a forest
 * floor of 0.084 — 2.2× and 4.3× too bright — desaturated toward the tint's
 * own grey (reed's blue/red ratio rose from the ground's 0.49 to 0.66,
 * heather's to 0.92). That is what read as "grey-blue shapes that do not
 * read as vegetation".
 *
 * Dividing by the reference row is not a rescale chosen to look right: the
 * table's own docblock already says "Grass is the reference: every number is
 * 1 and the colour is the ground's", and this makes that true of the colour
 * lane as well as of the shape lanes. Grass returns exactly `[1, 1, 1]` and,
 * with its `colorMix` of 0, is byte-identical either way.
 */
export function groundCoverArchetypeAlbedoTint(
  archetype: GroundCoverFieldArchetype,
): readonly [number, number, number] {
  const reference = GROUND_COVER_ARCHETYPE_SHAPES.grass.color;
  const { color } = GROUND_COVER_ARCHETYPE_SHAPES[archetype];
  return [
    color[0] / reference[0],
    color[1] / reference[1],
    color[2] / reference[2],
  ];
}

/**
 * Radius inside which the GPU field is the ground cover, in metres.
 *
 * The card path skips every archetype inside it and keeps them outside, so
 * the two representations partition the ground rather than overlapping. It is
 * the law's OUTERMOST ring radius at the full gate — the field's own reach —
 * and it is a property of the law rather than a tuned constant so a tier
 * retune cannot move one half of the handoff without the other.
 */
export function groundCoverHandoffRadiusMeters(law: GroundCoverLaw): number {
  return law.rings[law.rings.length - 1]!.outerRadiusMeters;
}

// ---------------------------------------------------------------------------
// `6-9` — GPU cull (§7 R4): compaction, its counter, and its readback ring
// ---------------------------------------------------------------------------

/**
 * Counter slots per frame: one `atomic<u32>` per ring, padded to 16 bytes so
 * the buffer stays a whole number of `vec4u`.
 */
export const GROUND_COVER_COUNTER_SLOTS = 4;

/**
 * Frames of counter buffers in flight.
 *
 * The same lesson `TERRAIN_PAGE_BOUNDS_SLOTS`' ring records, in a per-frame
 * path: a readback's `copyBufferToBuffer` is encoded into whichever command
 * encoder is open when `read()` is called, and the buffer is re-zeroed at the
 * top of every frame. One buffer would therefore be reset by frame N+1 before
 * frame N's copy executed, and every count would read back as the atomic
 * identity — zero — which presents as the field drawing nothing at all. Three
 * is one more than the two frames a mapped readback takes here.
 */
export const GROUND_COVER_COUNTER_RING = 3;

export function groundCoverCounterBytes(): number {
  return GROUND_COVER_COUNTER_RING * GROUND_COVER_COUNTER_SLOTS * 4;
}

/**
 * Headroom the drawn instance count keeps above the last count read back.
 *
 * The compaction predicate is deliberately STABLE — ground cover, slope,
 * radius and the density gate, never the frustum (which the vertex stage
 * still collapses per blade). A stable predicate makes the live count a
 * slowly-moving quantity: the lattice window slides by whole spacing steps,
 * so at 100 m/s barely 1% of a ring's lanes turn over in a frame. The margin
 * therefore only has to cover the readback's own two-frame latency, and the
 * ratchet below re-opens to full capacity the moment the count approaches
 * what is being drawn — so a count that grows faster than the margin widens
 * the draw instead of truncating the field.
 */
export const GROUND_COVER_DRAW_COUNT_MARGIN = 1.25;
/** Absolute slack added to the margin, in instances. */
export const GROUND_COVER_DRAW_COUNT_SLACK = 512;
/** Above this share of the drawn count, the draw re-opens to full capacity. */
export const GROUND_COVER_DRAW_COUNT_REOPEN_SHARE = 0.9;

/**
 * The conservative instance count to draw, given the last count read back.
 *
 * `null` (no count yet, or a failed readback) draws the whole lattice, which
 * is exactly wave G's shipped behaviour — the cull DEGRADES to the v1 rung
 * rather than breaking, which is the property `§7 R4` asks of the whole
 * feature. Pure arithmetic so the ratchet is Node-testable.
 */
export function groundCoverDrawCount(
  laneCount: number,
  lastCount: number | null,
  previousDrawCount: number,
): number {
  if (lastCount === null || !Number.isFinite(lastCount) || lastCount < 0) return laneCount;
  if (lastCount > previousDrawCount * GROUND_COVER_DRAW_COUNT_REOPEN_SHARE) return laneCount;
  const wanted = Math.ceil(lastCount * GROUND_COVER_DRAW_COUNT_MARGIN)
    + GROUND_COVER_DRAW_COUNT_SLACK;
  return Math.max(0, Math.min(laneCount, wanted));
}
