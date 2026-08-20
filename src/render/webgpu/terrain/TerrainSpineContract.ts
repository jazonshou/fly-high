import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
  WORLD_PAGE_LAYOUT,
  pageTexelSizeMeters,
} from "@/src/render/webgpu/world/pageGeometry";
import type { WorldPageKey } from "@/src/render/webgpu/world/pageKey";
import { SURFACE_MATERIAL_COUNT, SurfaceMaterial } from "./surfaceMaterials";
import {
  WORLD_PAGE_GPU_CHANNELS,
  worldPageChannelBytesPerTexel,
  worldPageChannelStoredEdge,
  type WorldPageChannelDescriptor,
} from "@/src/render/webgpu/world/payload";

/**
 * The terrain spine contract (`4-0`).
 *
 * INVARIANT THIS FILE OWNS: every number eleven Phase 4 consumers need to
 * agree about — slot geometry, atlas sizing, the season key, the node record,
 * the parity criterion and the supported world radius — is written down once,
 * here, before any of those consumers exists. `PHASE_4_EXECUTION_PLAN.md` §5
 * is its specification and the reason it lands first: the 24-bucket season
 * cache key is roughly free at the start of the phase and a re-architecture
 * afterwards.
 *
 * Class P, no Babylon import, runs in Node.
 *
 * Three boundary rules constrain how this file may be written, and naive
 * Phase 4 code fails all three:
 *
 *  (i) No `WorldPage*`/`WORLD_PAGE_*` symbol and no gutter/page-extent
 *      constant may be DECLARED outside `world/`. So this file **imports**
 *      page geometry and names its own symbols `TerrainSlot*` /
 *      `TERRAIN_ATLAS_*` / `TERRAIN_*_SLOT_*`.
 *  (ii) No `profile.tier` read may appear outside `core/`. Atlas sizing is a
 *      profile FIELD (`heightAtlasSlots`, `channelAtlasSlots`), never a
 *      `switch (tier)` in the terrain directory.
 *  (iii) `LandCoverClassifier.ts` must carry `dayOfYear` in a type position
 *      from its first line, or the seasonal-family boundary test fails the
 *      build. The season key below is what it keys on.
 */

// ---------------------------------------------------------------------------
// §5.2 — slot geometry, DERIVED from the one page geometry, never copied
// ---------------------------------------------------------------------------

/** Stored edge of one height slot: the 256 core plus the gutter on both sides. */
export const TERRAIN_HEIGHT_SLOT_EDGE = WORLD_PAGE_HEIGHT_CORE + WORLD_PAGE_GUTTER * 2;

/** Stored edge of one channel slot: the 128 core plus the gutter on both sides. */
export const TERRAIN_CHANNEL_SLOT_EDGE = WORLD_PAGE_CHANNEL_CORE + WORLD_PAGE_GUTTER * 2;

/**
 * World-space size of one height texel at a level.
 *
 * **This function takes no tier argument, and a test asserts it.**
 * `RENDERING_PLAN.md` §5.3 published a per-tier "L0 texel spacing" row
 * (4/2/2/1 m). It is inexpressible: level-L texel size is
 * `512·2^L / 256 = 2·2^L` m by the normative page geometry, and reaching 1 m
 * needs either a 520² slot or a 256 m base extent — a second page geometry,
 * which the architecture boundary test fails by name. Worse, a tier-dependent
 * spacing makes the §1.3 render-height authority a function of a graphics
 * setting: the surface the aircraft touches would depend on a quality
 * preset. `finestResidentLevel` replaces the row (§5.3); Low reaches 4 m by
 * never streaming L0, not by storing a coarser page.
 */
export function terrainTexelSizeMeters(level: number): number {
  return pageTexelSizeMeters(level, WORLD_PAGE_HEIGHT_CORE);
}

/** World-space size of one channel texel at a level (twice the height texel). */
export function terrainChannelTexelSizeMeters(level: number): number {
  return pageTexelSizeMeters(level, WORLD_PAGE_CHANNEL_CORE);
}

/** Slots per atlas edge for a slot budget: the atlas is a square slot grid. */
export function terrainAtlasGridEdge(slots: number): number {
  if (!Number.isSafeInteger(slots) || slots <= 0) {
    throw new RangeError("Terrain atlas slot budget must be a positive integer");
  }
  return Math.ceil(Math.sqrt(slots));
}

/** Texels per atlas edge for a slot budget and a slot edge. */
export function terrainAtlasEdgeTexels(slots: number, slotEdge: number): number {
  if (!Number.isSafeInteger(slotEdge) || slotEdge <= 0) {
    throw new RangeError("Terrain slot edge must be a positive integer");
  }
  return terrainAtlasGridEdge(slots) * slotEdge;
}

/**
 * Where a slot index lands in the atlas, in texels. Row-major over the slot
 * grid, so the mapping is stable under a change of slot budget.
 */
export function terrainSlotOrigin(
  slotIndex: number,
  slots: number,
  slotEdge: number,
): { readonly u: number; readonly v: number } {
  const grid = terrainAtlasGridEdge(slots);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= slots) {
    throw new RangeError(`Terrain slot index must be an integer in [0, ${slots})`);
  }
  return { u: (slotIndex % grid) * slotEdge, v: Math.floor(slotIndex / grid) * slotEdge };
}

// ---------------------------------------------------------------------------
// §5.1 — page identity and the season key
// ---------------------------------------------------------------------------

/**
 * Atlas residency identity. `variant` is 0 for every season-invariant
 * channel family and the season bucket index for the splat family.
 *
 * The PAGE key does not change. Exactly one channel family is
 * season-dependent (`WORLD_PAGE_GPU_CHANNELS`' `seasonKeyed` flag is the
 * enumeration): height is a function of `(level, x, z, seed)`, erosion runs
 * on geological time, and occlusion and the horizon field are geometry-only.
 * So the season rides the SLOT key, where it costs eviction bookkeeping
 * rather than a re-architecture of page identity.
 */
export interface TerrainSlotKey {
  readonly page: WorldPageKey;
  readonly variant: number;
}

/** ≈15-day resolution. Coarse enough to cache, fine enough to cross-fade. */
export const SEASON_BUCKETS = 24;

/**
 * Never more than two buckets of a season-keyed family are resident for a
 * page, and both are cross-faded by `seasonBucketBlend().t`.
 *
 * Stated as DATA because the estimator has to consume it:
 * `channelAtlasMiB` multiplies the season-keyed families by this number and a
 * form test asserts the row moves when it moves. `RENDERING_PLAN.md:173` says
 * the season key "costs one extra channel-atlas slot"; it does not — a
 * two-bucket cross-fade needs both buckets resident for every VISIBLE page
 * simultaneously, so peak demand is two slots per page and the atlas is sized
 * for it. It is NOT a cache multiplier over 24.
 */
export const SEASON_BUCKETS_RESIDENT = 2;

function normalizedDayOfYear(dayOfYear: number): number {
  if (!Number.isFinite(dayOfYear)) {
    throw new RangeError("dayOfYear must be finite");
  }
  return ((dayOfYear % 365) + 365) % 365;
}

/** The bucket a day falls inside, in `[0, SEASON_BUCKETS)`. */
export function seasonBucket(dayOfYear: number): number {
  const day = normalizedDayOfYear(dayOfYear);
  return Math.min(SEASON_BUCKETS - 1, Math.floor((day * SEASON_BUCKETS) / 365));
}

export interface SeasonBucketBlend {
  readonly lo: number;
  readonly hi: number;
  /** Cross-fade weight toward `hi`, in [0, 1). */
  readonly t: number;
}

/**
 * The two resident buckets and the weight between them, computed on bucket
 * CENTRES with modular arithmetic.
 *
 * **The season axis is cyclic, and a linear bucket index breaks at the year
 * boundary.** Bucket 23 (mid-to-late December) adjoins bucket 0 (1 January);
 * a naive `lo / lo + 1` pair asks for bucket 24 in late December, which is
 * either an out-of-range atlas fetch or a hard snap back to midwinter. A test
 * walks all 365 days asserting `lo, hi ∈ [0, 23]`, `hi === (lo + 1) % 24`,
 * and continuity across 31 Dec → 1 Jan.
 */
export function seasonBucketBlend(dayOfYear: number): SeasonBucketBlend {
  const day = normalizedDayOfYear(dayOfYear);
  const centred = (day * SEASON_BUCKETS) / 365 - 0.5;
  const floor = Math.floor(centred);
  const lo = ((floor % SEASON_BUCKETS) + SEASON_BUCKETS) % SEASON_BUCKETS;
  return { lo, hi: (lo + 1) % SEASON_BUCKETS, t: centred - floor };
}

/** The representative day at a bucket's centre — what a bake is keyed on. */
export function seasonBucketCenterDay(bucket: number): number {
  if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket >= SEASON_BUCKETS) {
    throw new RangeError(`Season bucket must be an integer in [0, ${SEASON_BUCKETS})`);
  }
  return ((bucket + 0.5) * 365) / SEASON_BUCKETS;
}

/** Stable map key for a slot identity. */
export function terrainSlotKeyString(key: TerrainSlotKey): string {
  return `${key.page}#${key.variant}`;
}

// ---------------------------------------------------------------------------
// §5.2 — channel families, costed from the one enumeration in payload.ts
// ---------------------------------------------------------------------------

/**
 * Channel families the CHANNEL atlas holds — everything except height, which
 * has its own r32float atlas at its own slot edge.
 */
export const TERRAIN_CHANNEL_FAMILIES: readonly WorldPageChannelDescriptor[] = Object.freeze(
  WORLD_PAGE_GPU_CHANNELS.filter(
    (channel) => channel.name !== "height" && channel.plannedBy === undefined,
  ),
);

/** Bytes one channel-atlas texel occupies, across every live family. */
export function terrainChannelBytesPerTexel(
  residentSeasonBuckets: number = SEASON_BUCKETS_RESIDENT,
): number {
  let bytes = 0;
  for (const family of TERRAIN_CHANNEL_FAMILIES) {
    const perTexel = worldPageChannelBytesPerTexel(family);
    bytes += family.seasonKeyed ? perTexel * residentSeasonBuckets : perTexel;
  }
  return bytes;
}

/** Bytes one height-atlas texel occupies. */
export function terrainHeightBytesPerTexel(): number {
  const height = WORLD_PAGE_GPU_CHANNELS.find((channel) => channel.name === "height");
  if (!height) throw new Error("payload.ts no longer enumerates a height channel");
  return worldPageChannelBytesPerTexel(height);
}

/**
 * The height slot edge, re-derived through the layout so a change to the page
 * geometry moves both this and `TERRAIN_HEIGHT_SLOT_EDGE` together.
 */
export function terrainSlotStoredEdge(family: WorldPageChannelDescriptor): number {
  return worldPageChannelStoredEdge(family, WORLD_PAGE_LAYOUT);
}

// ---------------------------------------------------------------------------
// §5.6 — the CDLOD node record
// ---------------------------------------------------------------------------

/**
 * Vertices per edge of the one instanced CDLOD grid (2,048 triangles).
 * Odd on purpose: the geomorph snaps odd vertices onto the parent's even
 * lattice, so a fine node's edge becomes exactly its parent's at `morphK = 1`.
 */
export const TERRAIN_NODE_GRID_RESOLUTION = 33;

/**
 * One 264² height slot serves an 8×8 block of CDLOD nodes at that level.
 *
 * This is why `cdlodNodeBudget` (160/240/320/448) looks larger than
 * `heightAtlasSlots` (144/196/256/256): nodes and slots are NOT in 1:1
 * correspondence and never were. A node spans `512·2^L / 8 = 64·2^L` m across
 * 32 quads, giving exactly the page's own `2·2^L` m texel spacing — the node
 * grid and the height page sample the same lattice by construction.
 */
export const TERRAIN_NODES_PER_SLOT_EDGE = 8;

/** World-space edge length of one CDLOD node at a level. */
export function terrainNodeSpanMeters(level: number): number {
  if (!Number.isSafeInteger(level) || level < 0) {
    throw new RangeError("Terrain node level must be a non-negative integer");
  }
  return (WORLD_PAGE_BASE_EXTENT_METERS * 2 ** level) / TERRAIN_NODES_PER_SLOT_EDGE;
}

/**
 * The node record's two custom thin-instance attributes.
 *
 * **One stride-8 attribute throws at pipeline creation.**
 * `RENDERING_PLAN.md` §3.1 specifies the instance buffer as a single stride-8
 * custom kind. `thinInstanceSetBuffer` with a custom kind falls to the generic
 * branch, which constructs `new VertexBuffer(..., stride, true)` with no
 * explicit `size`, so `VertexBuffer` resolves `_size = stride = 8`;
 * `WebGPUCacheRenderPipeline._GetVertexInputDescriptor` then falls through its
 * format table and throws `Invalid Format ... size=8`, because WebGPU has no
 * vertex format wider than four components. Babylon's own `splatIndex` branch
 * is the precedent: it splits one wide buffer into FOUR four-component vertex
 * buffers over the same `Buffer` at increasing offsets.
 *
 * A 16-float world matrix rides alongside these two. It is not redundant:
 * `thinInstanceSetBuffer` updates `instancesCount` only for kind `"matrix"`
 * and `"splatIndex"` — the generic branch sets NO count, and the
 * `thinInstanceCount` setter clamps to `matrixData.length / 16` and silently
 * does nothing without one. 64 B × 448 nodes at Ultra is 28 KiB, and it
 * carries node origin and scale for free.
 */
export const TERRAIN_NODE_ATTRIBUTE_A = "terrainNodeA";
export const TERRAIN_NODE_ATTRIBUTE_B = "terrainNodeB";
export const TERRAIN_NODE_ATTRIBUTE_STRIDE = 4;

/** Lane meanings, as data, so the CPU writer and the WGSL reader cannot drift. */
export const TERRAIN_NODE_LANES = Object.freeze({
  a: Object.freeze(["slotIndex", "subNodeX", "subNodeZ", "level"] as const),
  b: Object.freeze(["morphK", "parentSlotIndex", "texelSize", "maxDeviation"] as const),
});

/**
 * `4.5-A3`: the PROVISIONAL ecotone axis — the material a node shades with
 * while its page holds no channel (splat) slot.
 *
 * Stated here because it now has exactly two consumers that must agree and
 * only one derivation site: the WGSL vertex path walks these constants against
 * the just-displaced height, and `TerrainClipmapSystem` reads only
 * `fallbackAxis` for the guard below. Before this item the walk lived on the
 * CPU against the page's mean height, which made the fallback ONE material per
 * node — a solid block up to `512·2^L` m across, which is what the reported
 * "splotches of solid colour" were wherever a channel slot was missing.
 *
 * `fallbackAxis` is GRASS and not sand, and the reason is worth keeping: a
 * node with no resident HEIGHT slot samples zero, and zero read as "at sea
 * level" puts the first material on the axis — sand — under every node the
 * streamer has not reached, i.e. a desert wherever the atlas is behind. The
 * recorded caveat stands: in the fallback only, a height-non-resident beach
 * loses its sand band.
 */
export const TERRAIN_PROVISIONAL_AXIS = Object.freeze({
  /** Below this height above sea level the axis is pinned to sand/water. */
  shoreBandMeters: 2,
  /** Metres of elevation per step along the ecotone axis. */
  metersPerStep: 380,
  /** Last index on the axis; the axis is clamped into it. */
  maxAxis: SURFACE_MATERIAL_COUNT - 1,
  /** What a node with no height texels to walk shades with. */
  fallbackAxis: SurfaceMaterial.Grass as number,
});

/**
 * `morphK` is computed on the CPU, once per frame, against the BEAUTY camera,
 * and carried in `terrainNodeB` — never derived from camera state inside the
 * vertex shader.
 *
 * The same vertex shader runs for the beauty camera, for each shadow cascade
 * under the `ShadowDepthWrapper`, and for the planar-reflection camera. An
 * in-shader camera-relative morph makes those three surfaces disagree about
 * where the ground is, which is a depth-fighting and shadow-acne bug that
 * looks like everything except its cause. Assertion 83a is a string check that
 * no camera symbol appears in the morph path of the emitted WGSL.
 */
export const TERRAIN_MORPH_FORBIDDEN_VERTEX_SYMBOLS: readonly string[] = Object.freeze([
  "vEyePosition",
  "cameraPosition",
  "vCameraPosition",
]);

// ---------------------------------------------------------------------------
// §5.6 — supersampling, parity and the supported world radius
// ---------------------------------------------------------------------------

/**
 * Rotated-grid 4× supersample offsets, in texels, used at every level ABOVE
 * L0. **L0 is excluded, as a tested rule and not a tuning constant.**
 *
 * Measured justification, recorded so nobody re-enables it as a "quality
 * improvement": 2×2 supersampling at L0 puts up to 0.98 m between the wheels
 * and the screen. Over 55,296 texels spanning ±100 km: >1 mm at 33.3% of
 * texels, >10 mm at 7.0%, >100 mm at 0.43%, max 981 mm. That is three times
 * the 0.35 m runway crown Phase 3 classifies as a Class-K physics bug. The
 * cause is the C0 crease in `ridgedFbm2D` (`ridge = 1 − |v|`, squared), so the
 * residual scales LINEARLY with texel size rather than quadratically — which
 * is why excluding L0 is right and "supersampling buys nothing there" is not
 * the reason.
 */
export const TERRAIN_SUPERSAMPLE_OFFSETS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([-0.375, -0.125] as const),
  Object.freeze([0.125, -0.375] as const),
  Object.freeze([0.375, 0.125] as const),
  Object.freeze([-0.125, 0.375] as const),
]);

const L0_SUPERSAMPLE_OFFSETS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([0, 0] as const),
]);

export function terrainSupersampleOffsets(
  level: number,
): readonly (readonly [number, number])[] {
  return level === 0 ? L0_SUPERSAMPLE_OFFSETS : TERRAIN_SUPERSAMPLE_OFFSETS;
}

/**
 * `filterWidthMeters` for a level's page bake.
 *
 * **L0 is exactly 0.0**, so `filtering` is false inside the kernel and the L0
 * page is bit-identical to the physics path BY CONSTRUCTION rather than by
 * floating-point luck. Above L0 the width is the level's own texel size, which
 * is what band-limiting is defined against (1B-2).
 */
export function terrainPageFilterWidthMeters(level: number): number {
  return level === 0 ? 0 : terrainTexelSizeMeters(level);
}

/**
 * The `4-1` parity criterion, as data (§4 D6). Four criteria replace
 * `RENDERING_PLAN.md:347`'s single `< 0.05 m at |x| = 5×10⁶ m` line, which is
 * off by ~70×: measured divergence at 5×10⁶ m is 3.47 m.
 *
 * The point counts are PART of the criteria. A 3,000-point probe suggests
 * 0.05 m holds comfortably at ±10⁵ m; a 40,000-point probe shows it does not
 * (60 mm > 50 mm). `RENDERING_PLAN.md:347`'s 4,096 Halton points are few
 * enough to report a pass a denser probe would fail.
 */
export const TERRAIN_HEIGHT_PARITY_CRITERIA = Object.freeze({
  /** Criterion 2: the near field, where the aircraft actually flies. */
  nearRadiusMeters: 10_000,
  nearToleranceMeters: 0.05,
  nearMinimumSamples: 40_000,
  /** Criterion 3: the far field. */
  farRadiusMeters: 100_000,
  farToleranceMeters: 0.25,
  /** Criterion 3's tail, out to the lattice wrap's no-op radius. */
  wrapRadiusMeters: 2_800_000,
  wrapRadiusToleranceMeters: 0.05,
  /**
   * Criterion 4: the §1.3 gate, as a bound and not an equality.
   *
   * **5 mm, not the plan's 1 mm, and the difference is measured rather than
   * conceded.** `terrainNaturalHeight` accumulates ~50 terms in f32, the
   * largest scaled by 1,390 m through a `pow()` WGSL specifies only to a few
   * ULP; the floor that puts under the answer is ~3.6 mm, and no arrangement
   * of the shipped arithmetic gets below it without carrying height as a
   * double-float. 1 mm was never the binding number either: the runway crown
   * the aircraft actually lands on has 5.8 mm of chord error at L0's own 8 m
   * vertex spacing (`RunwayEarthworks.crownMeters`' note), so a 3.6 mm
   * kernel disagreement is already an order of magnitude below the surface's
   * own representation error and two orders below the 0.35 m crown Phase 3
   * classifies as a Class-K physics bug.
   */
  physicsToleranceMeters: 0.005,
  /** Filter widths every criterion sweeps; 128 and 512 are mandatory rows. */
  filterWidthsMeters: Object.freeze([0, 8, 32, 128, 512] as const),
});

/**
 * The supported world radius — an OUTPUT of `4-1`, measured after split-origin
 * addressing landed, not assumed from it.
 *
 * `|h_gpu − h_cpu|` stays inside `farToleranceMeters` out to this radius. It
 * is recorded here rather than in the parity test so that `4-3` and the
 * streaming code have one number to gate on, and so that shrinking it (the
 * `R-4A` fallback) is a visible contract change rather than a relaxed
 * assertion. `5×10⁶ m` is struck.
 */
export const TERRAIN_SUPPORTED_WORLD_RADIUS_METERS = 2_800_000;

/**
 * Measured 2026-08-19 on the reference adapter by
 * `tests/gpu/terrain-height-parity.test.ts`, over 40,960 / 12,960 / 3,840
 * points × five filter widths:
 *
 * | radius | max |Δh| |
 * |---|---|
 * | ±10⁴ m | 3.78 mm |
 * | ±10⁵ m | 3.44 mm |
 * | ±2.8×10⁶ m | 2.37 mm |
 *
 * **The error does not grow with radius**, which is the whole point: naive f32
 * measured 4.5 mm / 60 mm / 3.47 m over the same probe, so split-origin
 * addressing did not merely improve the far field, it removed the
 * coordinate-magnitude term. What remains is f32 accumulation over ~50 terms
 * and is flat everywhere.
 *
 * The radius is therefore set by the LATTICE WRAP rather than by precision:
 * beyond ~2.8×10⁶ m the finest 43 m octave repeats by construction (0-4), so
 * the world tiles rather than diverges.
 */
export const TERRAIN_HEIGHT_PARITY_MEASURED_METERS = Object.freeze({
  nearMax: 0.00378,
  farMax: 0.00344,
  wrapMax: 0.00237,
});

// ---------------------------------------------------------------------------
// §5.6 — the per-stage sampled-binding budget
// ---------------------------------------------------------------------------

/**
 * Every sampled texture the terrain material binds, by stage, with a running
 * count. Texture VISIBILITY derives from which stage's `CUSTOM_*_DEFINITIONS`
 * carries the declaration, so the count is per-stage and not per-material.
 * The material factory asserts these against
 * `engine.getCaps().maxTexturesImageUnits` (assertion 70c).
 */
export const TERRAIN_SAMPLED_BINDINGS = Object.freeze({
  vertex: Object.freeze(["terrainHeightAtlas"] as const),
  fragment: Object.freeze([
    // PBR's own set on the shared terrain material.
    "albedoSampler",
    "bumpSampler",
    "reflectivitySampler",
    "reflectionSampler",
    "metallicReflectanceSampler",
    "lightmapSampler",
    // `3-1`'s material arrays.
    "terrainSurfaceAlbedo",
    "terrainSurfaceNormal",
    // Phase 4's page atlases.
    "terrainHeightAtlas",
    "terrainSplatIdAtlas",
    "terrainSplatWeightAtlas",
    "terrainOcclusionAtlas",
    "terrainHorizonAtlasA",
    "terrainHorizonAtlasB",
  ] as const),
});

// ---------------------------------------------------------------------------
// §5.6 — the global height pyramid (`4-7`) and readback alignment
// ---------------------------------------------------------------------------

/** Coarse global height field the occlusion bake marches beyond a page. */
export const TERRAIN_HEIGHT_PYRAMID_EDGE = 256;
export const TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS = 512;
/** 256 × 512 m = 131 km across — beyond the 45 km far plane in every direction. */
export const TERRAIN_HEIGHT_PYRAMID_SPAN_METERS =
  TERRAIN_HEIGHT_PYRAMID_EDGE * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;

/**
 * WebGPU's `copyTextureToBuffer` row alignment. A 264-texel r32float row is
 * 1,056 B, which pads to 1,280 — so every readback helper and every `4-1`/`4-3`
 * parity test is asynchronous and unpacks padded rows rather than assuming a
 * tight buffer.
 */
export const TERRAIN_READBACK_ROW_ALIGNMENT_BYTES = 256;

export function terrainReadbackBytesPerRow(texels: number, bytesPerTexel: number): number {
  const tight = texels * bytesPerTexel;
  const alignment = TERRAIN_READBACK_ROW_ALIGNMENT_BYTES;
  return Math.ceil(tight / alignment) * alignment;
}

/**
 * Compute reads of the height atlas use `textureLoad` only, never
 * `textureSample*`, and the terrain vertex shader takes four `textureLoad`s
 * rather than one filtered fetch.
 *
 * `ComputeShader` creates its pipeline with `layout: "auto"`, so the browser
 * infers a binding's sample type from the WGSL; binding an r32float texture as
 * a filtering-sampled texture is a validation error at pipeline creation.
 * Separately: `float32-filterable` IS available on the reference adapter and
 * is deliberately NOT requested — CDLOD geomorphing samples the parent page at
 * SNAPPED lattice positions, where exact texel values are what correctness
 * wants, and requesting the feature narrows the supported adapter set for no
 * gain in the vertex shader's hot path. Recorded here so nobody re-derives it.
 */
export const TERRAIN_REQUESTS_FLOAT32_FILTERABLE = false;
