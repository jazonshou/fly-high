import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { AirportDefinition, WorldDefinition } from "@/src/world/types";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageKey,
  worldPageBounds,
  type WorldPageAddress,
} from "@/src/render/webgpu/world/pageKey";
import type { WorldPageOperationToken } from "@/src/render/webgpu/world/lifecycle";
import {
  RUNWAY_EARTHWORKS_UNIFORM_FLOATS,
  RUNWAY_EARTHWORKS_WGSL,
  packRunwayEarthworksUniform,
} from "./RunwayEarthworks";
import { RUNWAY_SDF_WGSL } from "./RunwaySurface";
import {
  EVOLUTION_ANALYTIC_BLEND_METERS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  TERRAIN_PAGE_HYDROLOGY_ENCODING,
} from "./TerrainEvolutionContract";
import {
  TERRAIN_FINE_BAND_CONCAVE_CURVATURE,
  TERRAIN_FINE_BAND_CONVEX_CURVATURE,
  TERRAIN_FINE_BAND_SOIL_DEEP_METERS,
  TERRAIN_FINE_BAND_SOIL_THIN_METERS,
  TERRAIN_TWI_DRY,
  TERRAIN_TWI_SLOPE_EPSILON,
  TERRAIN_TWI_WET,
} from "./TerrainPageHydrology";
import {
  EROSION_HALO_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TERRAIN_EROSION_PRODUCTION_CONFIG,
} from "./TerrainErosionCompute";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "./TerrainKernel";
import {
  TALUS_APPLY_WGSL,
  streamPowerWgsl,
  talusGatherWgsl,
} from "./TerrainMacroErosionGpu";
import {
  TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL,
  terrainErosionOrderableReadbackFaultIndex,
  terrainErosionParentSeedBlock,
  terrainErosionSeedModeForLevel,
  type TerrainErodedPage,
  type TerrainErosionSeedMode,
} from "./TerrainPageErosion";
import type {
  TerrainPageStagedErosionExecutor,
  TerrainStagedErosionJob,
} from "./TerrainPageErosionClient";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_SUPERSAMPLE_OFFSETS,
  terrainPageFilterWidthMeters,
  terrainSupersampleOffsets,
  terrainTexelSizeMeters,
  type TerrainSlotKey,
} from "./TerrainSpineContract";
import {
  TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
  TERRAIN_UPLIFT_KERNEL_WGSL,
  buildTerrainUpliftKernelPageUniform,
  terrainUpliftKernelPageBindingWgsl,
} from "./TerrainUpliftKernel";
// Type-only imports: TerrainPageAtlas also imports this module at runtime, and
// a value import here would close a live ESM cycle.
import type { TerrainAtlasSlot, TerrainPageAtlas } from "./TerrainPageAtlas";

/**
 * `W-1d` + `W-2` (Gate W): the multi-frame GPU page-erosion DAG.
 *
 * Replaces the serial CPU worker page path (2.1–5.5 s/page, one in flight —
 * the recorded G0-1 supply collapse) with a staged producer that amortises one
 * page's fixed erosion DAG across frames under the `erosionCompute` admission
 * meter, behind the SAME client boundary (`TerrainPageGenerator` still
 * resolves a `TerrainErodedPage` and runs the unchanged upload/publish path).
 *
 * Stage machine per page (v1: exactly ONE page in flight):
 *
 *   SEED-INPUTS (worker, CPU)  airport mask + (macro mode) bilinear macro fields
 *   SEED        (GPU, banded)  the C-2 sourceHeight composition + flow field
 *   GEOLOGY     (GPU, banded)  erodibility / repose from the uplift kernel
 *   BREACH      (GPU, 2)       direct receivers, then pit carve via atomicMin
 *                              on orderable-encoded f32 (min-combine is
 *                              commutative/associative/idempotent, so the
 *                              atomic order cannot move bits)
 *   READBACK    (async)        source/breached/receivers/flow to the worker
 *   MFD         (worker, CPU)  the unchanged radix-ordered deterministic pass
 *   DECODE      (GPU, 1)       orderable bits -> f32 stream-power input
 *   STREAM POWER(GPU, 24)      W-1a's ping-pong gather shaders, page config
 *   TALUS       (GPU, 32x2)    W-1a's gather/apply pair
 *   FINE BAND   (GPU, banded)  W-4's post-erosion 24 m/9 m bands under the
 *                              soil-depth/curvature mask, read off the surface
 *                              talus just finished
 *   EVOLVED     (async)        evolved scratch back to the worker
 *   FINISH      (worker, CPU)  unchanged blend/stats/hydrology finalization
 *
 * Determinism: every GPU pass is a pure per-cell gather with fixed neighbour
 * order (or an order-independent atomicMin), so one device produces identical
 * bytes for one page every time; the order-dependent MFD stays the unchanged
 * CPU code. CPU-oracle agreement is tolerance-tier (D-3), frozen in
 * {@link TERRAIN_PAGE_EROSION_GPU_PARITY_CRITERIA}.
 *
 * All shaders here stay TIMED (tests/render.gpu-timing-policy.test.ts lists
 * this file in TIMED_ON_PURPOSE): their counters feed
 * `consumeMeasuredDispatchCostMs`, which the clipmap routes into
 * `ComputeBudget.observeDispatchCostMs("erosionCompute", ...)`.
 */

// ---------------------------------------------------------------------------
// Stage shape + pinned per-dispatch cost seeds
// ---------------------------------------------------------------------------

/**
 * Scratch rows per band of the two SAMPLING stages (seed, geology).
 *
 * These two are the only stages whose whole-384² cost is far over any tier's
 * `erosionCompute` row, so they are the only ones that must be divisible at
 * all — and the divisor has to reach the TIER-0 row (0.2 ms), not just tier
 * 1's 0.4 ms, or the coarsest tier admits them through the floor of one alone
 * and every admission is an over-cap burst. One workgroup row (8) puts a seed
 * band at ~0.14 ms and a geology band at ~0.05 ms on the reference adapter.
 *
 * Bands are selected by `workgroup_id.z` off ONE band-base written to the
 * params buffer per frame, exactly as the analytic generator batches pages:
 * Babylon records a frame into one encoder, so a second cursor write in the
 * same frame would be read by the FIRST dispatch too (the D11 hazard). With
 * the z-indexed form a frame runs as many bands as the meter admitted, from a
 * single write.
 */
export const TERRAIN_EROSION_SEED_BAND_ROWS = 8;
/**
 * Geology bands are six times taller because the sampler is six times cheaper
 * than the composed seed kernel: two filtered value-noise octaves and a fabric
 * angle, once per texel, against the seed's eight supersampled evaluations of
 * the full height and uplift kernels.
 */
export const TERRAIN_EROSION_GEOLOGY_BAND_ROWS = 48;

export type TerrainErosionGpuStage =
  | "idle"
  | "seed-inputs"
  | "seed"
  | "geology"
  | "breach"
  | "readback"
  | "mfd"
  | "decode"
  | "stream-power"
  | "geology-repose"
  | "talus"
  | "fine-band"
  | "evolved-readback"
  | "finish";

/**
 * Measured per-dispatch GPU cost by stage, in milliseconds at the 384²
 * production scratch on the reference adapter (Apple silicon, ANGLE Metal,
 * 2026-08-30, seed w1d-page-erosion-gpu, an L3 page; re-measured by the
 * concentrated whole-page and grouped one-sided guards in
 * tests/gpu/terrain-page-erosion-cost.test.ts). Production ships with GPU
 * timing OFF, so these constants ARE the admission prices for a normal
 * session; the running estimate refines them only on a pinned diagnostic
 * capture.
 *
 * Whole page after `W-4`: **38.1-39.9 ms of GPU across 163 dispatches** over
 * three consecutive runs (48 seed bands, 16 geology bands over two passes, 2
 * breach, 1 decode, 24 stream-power, 64 talus, 8 fine-band), amortised at
 * whatever the meter admits. W-4's FINE BAND pass is the whole delta from the
 * recorded 37.4 ms / 155 dispatches: **+8 dispatches and +0.6-0.9 ms**, or
 * 2.4% of the page, for moving the fine bands off the uplift input.
 *
 * The single-dispatch rows (decode, and stream power at ~20 microseconds each)
 * remain the noisy ones this file already warned about: across five runs on
 * the reference adapter `decode` was measured at 0.085, 0.091, 0.091, 0.198
 * and 0.816 ms, and `streamPower` at 0.066, 0.072, 0.073 and 0.367. Both
 * outliers are the counter, not the shader — the whole-page total moved 4% in
 * the same runs. They deliberately have no individual timing bounds: the gate
 * requires every dispatch to be present, then measures their combined page
 * contribution so counter granularity cannot masquerade as shader drift.
 *
 * Two stages sit ABOVE the tier-0 `erosionCompute` row of 0.2 ms — seed at
 * 0.29 and talus at 0.32 — and both are inside tier 1's 0.4 ms row, which is
 * the shipping tier. At tier 0 they are admitted through the surplus pass
 * (eroded mode leaves `terrainCompute` with no demand at all, so its row is
 * surplus every frame) or, failing that, the floor of one. Neither can be
 * banded further without changes outside this item: the seed band is already
 * one workgroup row, and the talus pair is `W-1a`'s shader, not this file's.
 */
export const TERRAIN_EROSION_STAGE_SEED_COST_MS: Readonly<
  Record<"seed" | "geology" | "breach" | "decode" | "streamPower" | "talus" | "fineBand", number>
> = Object.freeze({
  // One 8-row band of the composed analytic+uplift kernel: eight supersampled
  // evaluations of the two ~750-line kernels per texel above L0, plus the
  // macro-uplift (or parent-filter) leg. 48 bands, 14.0 ms of the page.
  seed: 0.29,
  // One 48-row band of the geology sampler: two filtered value-noise octaves
  // and a fabric angle, once per texel. 8 bands per pass, two passes, 1.3 ms.
  geology: 0.082,
  // Direct-receiver gather, then the sparse (2r+1)² pit carve, over 384².
  // Cheap because almost no cell is a pit: 0.13 ms for the pair.
  breach: 0.067,
  // A single 384² pass, and therefore the one figure here with no averaging
  // behind it — its counter is a single noisy sample of a 0.09 ms dispatch.
  decode: 0.089,
  // One implicit-Jacobi stream-power iteration at 384². 24 of them, ~0.8 ms.
  // The noisiest row: 0.022-0.049 across four runs on one adapter, because a
  // 20-microsecond dispatch is near the counter's own resolution. Centred on
  // the median; the cost gate aggregates all 24 with the other minor stages.
  streamPower: 0.033,
  // One talus gather or one talus apply at 384². **The page's dominant cost:
  // 64 dispatches, 20.7 ms — 55% of the whole DAG.** The gather recomputes
  // every neighbour's full eight-way outflow distribution to stay a pure
  // gather (W-1a's shape, and the reason it is bit-reproducible), which is 64
  // loads per cell. Recorded as the first place to look if the page rate has
  // to improve again.
  talus: 0.32,
  // W-4's FINE BAND band: one 48-row slice of the uplift kernel's fine-band
  // sampler (a fabric angle and three ridged octaves) plus the soil mask's
  // five-tap stencil. Seeded at the geology row it is closest to — geology is
  // two filtered octaves plus a fabric angle over the same band height — and
  // re-measured inside the complete-page aggregate rather than in isolation.
  fineBand: 0.082,
});

/**
 * Frozen measured-criteria contract for CPU-oracle tolerance parity of a
 * complete MACRO-SEEDED page (D-3 doctrine: the point count is part of the
 * criterion; bounds measured on the reference adapter, then pinned with
 * headroom; the achieved values are console.logged by the test).
 *
 * Measured 2026-08-30, seed w1d-page-erosion-gpu, ONE L3 page at (-3, 5),
 * 69,696 stored texels: mean |Δh| = 5.9e-4 m, p99 = 2.1e-4 m, max = 3.74 m.
 * The bulk is the f32 GPU chain against the f64-internal CPU operators —
 * sub-millimetre almost everywhere, which is why the p99 is BELOW the mean.
 * The tail is entirely local: an f32 tie in the breach search or the receiver
 * comparison flips one cell's receiver, and the 24 incision iterations then
 * route a channel a texel to one side.
 *
 * RE-MEASURED AND LOOSENED by `W-4` (2026-08-30). This is a REAL reduction in
 * CPU/GPU agreement and it is recorded as one rather than absorbed. Three
 * things changed at once and only the third matters:
 *
 *  - the criterion now spans THREE L3 pages, not one (the page count is part
 *    of it, exactly as the point count is next door — one page cannot separate
 *    "the producers disagree" from "this page's trunk channel is contested");
 *  - the tail's SHAPE is now pinned too (`reroutedTexelShare`), because the
 *    magnitude alone cannot distinguish a rerouted channel from a spread;
 *  - the plate-model uplift changed the landscape, and one of the three pages
 *    became strongly tie-contested.
 *
 *   page        mean       p99       max      texels > 10 cm   relief
 *   (-3,  5)  1.82e-2 m  6.8e-4 m  14.78 m   505 of 69,696   2.9..146.6 m
 *   ( 2, -4)  1.35e-3 m  4.4e-3 m   1.63 m   113 of 69,696  -559..175.8 m
 *   ( 7,  3)  1.11e-3 m  4.0e-4 m   6.93 m    78 of 69,696  98.1..242.2 m
 *
 * Two of the three sit within 2x of the pre-W-4 numbers. The outlier is a
 * near-sea-level page (min 2.95 m) whose trunk channel the two producers route
 * differently for ~500 texels — 0.72% of the page, in one connected cluster,
 * with the other 99.28% agreeing to 0.68 mm and both producers reporting the
 * same min/max height to 1e-5 m. That is the documented rerouted-channel class
 * at larger amplitude, not a second landscape: the shape claim is carried by
 * `reroutedTexelShare` and by the p99, both of which stay tight.
 *
 * The GPU-vs-GPU authority claims (determinism across rerun, eviction and
 * dispatch rate) are UNAFFECTED and still bit-exact — they are what the
 * eroded world's reproducibility actually rests on. So is the CPU reference's
 * own bit-exact seam.
 *
 * PARENT-seeded pages (`W-2`) have no CPU oracle at all: their seed reads
 * resident parent pages, which the CPU reference path never does. They are
 * held to GPU-vs-GPU determinism, the seam bound and a sanity envelope.
 */
export const TERRAIN_PAGE_EROSION_GPU_PARITY_CRITERIA = Object.freeze({
  meanAbsoluteToleranceMeters: 0.04,
  p99AbsoluteToleranceMeters: 0.01,
  maxAbsoluteToleranceMeters: 30,
  /**
   * Share of a page's texels allowed above 10 cm — the tail's SHAPE, and the
   * assertion that actually says "one rerouted channel" rather than "two
   * landscapes". Measured worst 0.0072; pinned at 0.02.
   */
  reroutedTexelShare: 0.02,
});

/**
 * **Assertion 90 does NOT hold in its bit-exact form for this producer, and
 * the reason is structural.** Two adjacent pages evaluate the same world texel
 * through DIFFERENT `(latticeOrigin, localOffset)` splits, because the WGSL
 * height and uplift kernels are page-relative by construction — that split is
 * the world-scale precision rule (a lattice coordinate taken as an absolute
 * f32 collapses to rows hundreds of kilometres out). `frac_A + i * scale` and
 * `frac_B + j * scale` are the same real number and different f32s, so the two
 * pages' seed fields differ by an ulp or two before a single erosion iteration
 * has run, and the 24 stream-power plus 32 talus passes carry that forward.
 *
 * The CPU reference does not have this property: its seed loop evaluates the
 * ABSOLUTE world coordinate in f64 and is bit-exact across seams, and it stays
 * the oracle for that claim (the GPU test asserts the CPU side's exactness on
 * the same fixture, so this bound is a property of the port and not of the
 * composed operator reach that `W-8` is separately chasing).
 *
 * Measured on the reference adapter (Apple silicon, ANGLE Metal, 2026-08-30,
 * seed w1d-page-erosion-gpu, L3 pages, 2,112 compared texels per axis): worst
 * |Δh| 1.22e-4 m east-west and 9.54e-5 m north-south — about eight f32 ulps at
 * these elevations, four orders of magnitude below the 0.25 m shore-distance
 * quantum and six below anything the collision path can feel.
 *
 * RE-MEASURED AND LOOSENED by `W-4` (2026-08-30) on the plate-model landscape:
 * east-west is unchanged at 9.15e-5 m, north-south is 2.41e-2 m. The asymmetry
 * is the same page pair whose trunk channel the CPU-oracle test finds
 * contested (see TERRAIN_PAGE_EROSION_GPU_PARITY_CRITERIA): the two pages'
 * page-relative f32 splits flip a receiver near the seam and the incision
 * iterations carry it into the overlap band. Still four orders of magnitude
 * inside the physics tolerance and a tenth of the 0.25 m shore-distance
 * quantum, and the CPU reference's own seam stays IEEE-bit-exact on both axes
 * — which is the claim the collision authority actually rests on. Pinned at
 * 2.5x the measured value; a structural seam is orders of magnitude larger
 * again and still caught.
 */
export const TERRAIN_PAGE_EROSION_GPU_SEAM_CRITERIA = Object.freeze({
  worstAbsoluteToleranceMeters: 0.06,
});

// ---------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------

const WORKGROUP_EDGE = 8;
const SCRATCH_EDGE = EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS;
const SCRATCH_COUNT = SCRATCH_EDGE * SCRATCH_EDGE;
const SEED_BAND_COUNT = SCRATCH_EDGE / TERRAIN_EROSION_SEED_BAND_ROWS;
const GEOLOGY_BAND_COUNT = SCRATCH_EDGE / TERRAIN_EROSION_GEOLOGY_BAND_ROWS;
for (const rows of [TERRAIN_EROSION_SEED_BAND_ROWS, TERRAIN_EROSION_GEOLOGY_BAND_ROWS]) {
  if (rows % WORKGROUP_EDGE !== 0 || SCRATCH_EDGE % rows !== 0) {
    throw new Error("Terrain erosion band rows must tile the scratch in whole workgroups");
  }
}
/** Three page uniforms per kernel: child filter, 512 m macro, parent filter. */
const KERNEL_PAGE_SLOTS = 3;

function wgslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * Seed/breach param block. One storage buffer carries every job constant plus
 * the banded-dispatch cursor and the embedded earthworks uniform; it is
 * rewritten at most once per frame (page start, or one banded dispatch), so
 * the single-encoder D11 hazard cannot arise.
 */
function seedParamsWgsl(declareEarthworksStruct: boolean): string {
  // The struct only, for the passes that carry the params block but never
  // sample the earthworks: RUNWAY_EARTHWORKS_WGSL's own functions call the
  // height kernel's noise primitives, and pulling the ~750-line kernel into
  // the breach passes to satisfy a struct they only need the LAYOUT of would
  // be a compile error away either way. Field order is checked against
  // RUNWAY_EARTHWORKS_UNIFORM_FLOATS at module load.
  const structOnly = /* wgsl */ `
struct RunwayEarthworks {
  site: vec4f,
  frame: vec4f,
  blend: vec4f,
  seeds: vec4u,
};
`;
  return /* wgsl */ `
${declareEarthworksStruct ? structOnly : ""}
struct PageErosionParams {
  // (scratchEdge, mode [0 macro | 1 parent], supersampleCount, bandStartRow)
  shape: vec4u,
  // (bandRows, unused, parentBlockBasePageX, parentBlockBasePageZ)
  band: vec4i,
  // (texelSize, originX, originZ, parentTexelSize)
  metrics: vec4f,
  // (parentChannelTexelSize, drainageEpsilonPerTexel, pitBreachRadius, 0)
  breach: vec4f,
  // Per 2x2 block entry: (heightSlotU, heightSlotV, channelSlotU, channelSlotV)
  parentSlots: array<vec4i, 4>,
  earthworks: RunwayEarthworks,
};
@group(0) @binding(0) var<storage, read> params: PageErosionParams;
`;
}

/** Byte layout of PageErosionParams (must match seedParamsWgsl). */
const SEED_PARAMS_FLOATS = 4 + 4 + 4 + 4 + 4 * 4 + RUNWAY_EARTHWORKS_UNIFORM_FLOATS;
const SEED_PARAMS_BYTES = SEED_PARAMS_FLOATS * 4;
if (RUNWAY_EARTHWORKS_UNIFORM_FLOATS !== 16) {
  throw new Error("The page-erosion params block restates RunwayEarthworks as four vec4s");
}

/** The orderable-f32 encoding (TerrainPageAtlas's kOrderable, restated). */
const ORDERABLE_WGSL = /* wgsl */ `
fn pOrderableEncode(value: f32) -> u32 {
  let bits = bitcast<u32>(value);
  if ((bits & 0x80000000u) != 0u) { return ~bits; }
  return bits | 0x80000000u;
}

fn pOrderableDecode(order: u32) -> f32 {
  if ((order & 0x80000000u) != 0u) { return bitcast<f32>(order & 0x7fffffffu); }
  return bitcast<f32>(~order);
}
`;

function supersampleTableWgsl(): string {
  const rows = TERRAIN_SUPERSAMPLE_OFFSETS.map(
    ([x, z]) => `vec2f(${wgslFloat(x)}, ${wgslFloat(z)})`,
  ).join(", ");
  return /* wgsl */ `
const P_SUPERSAMPLE: array<vec2f, ${TERRAIN_SUPERSAMPLE_OFFSETS.length}> = array(${rows});
`;
}

/**
 * SEED pass: the C-2 sourceHeight composition (macro mode) or the `W-2`
 * parent-converged composition, plus the flow boundary condition. Mirrors
 * `buildTerrainErosionSeedFields`'s per-texel loop; the macro-bilinear leg
 * arrives precomputed (bit-exact CPU fields) because the worker owns the
 * macro export.
 */
function seedWgsl(): string {
  return /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 1)}
${TERRAIN_KERNEL_WGSL}
${terrainUpliftKernelPageBindingWgsl(0, 2)}
${TERRAIN_UPLIFT_KERNEL_WGSL}
${RUNWAY_SDF_WGSL}
${RUNWAY_EARTHWORKS_WGSL}
${seedParamsWgsl(false)}
@group(0) @binding(3) var<storage, read> erosionMaskIn: array<u32>;
// Macro-mode only: the worker's bit-exact bilinear macro height field, staged
// in the height ping-pong's B buffer (dead until the first stream-power pass).
@group(0) @binding(4) var<storage, read> macroHeight: array<f32>;
@group(0) @binding(5) var<storage, read_write> sourceOut: array<f32>;
// Parent mode only: macro mode's flow field is the worker's CPU array, already
// uploaded into this buffer, and must not be recomputed over the top of it.
@group(0) @binding(6) var<storage, read_write> flowOut: array<f32>;
@group(0) @binding(7) var parentHeightAtlas: texture_2d<f32>;
@group(0) @binding(8) var parentFlowAtlas: texture_2d<f32>;

${supersampleTableWgsl()}

const P_MACRO_MIN_WORLD: f32 = ${wgslFloat(TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX)};
const P_MACRO_MAX_WORLD: f32 = ${wgslFloat(TERRAIN_EVOLUTION_MACRO_LAYOUT.maxWorldX)};
const P_MACRO_BLEND_METERS: f32 = ${wgslFloat(EVOLUTION_ANALYTIC_BLEND_METERS)};
const P_HEIGHT_CORE: i32 = ${WORLD_PAGE_HEIGHT_CORE};
const P_CHANNEL_CORE: i32 = ${WORLD_PAGE_CHANNEL_CORE};
const P_GUTTER: i32 = ${WORLD_PAGE_GUTTER};

/** terrainEvolutionMacroBlend's WGSL twin (the D2 rim compatibility blend). */
fn pMacroRimBlend(worldX: f32, worldZ: f32) -> f32 {
  let distanceToRim = min(
    min(worldX - P_MACRO_MIN_WORLD, P_MACRO_MAX_WORLD - worldX),
    min(worldZ - P_MACRO_MIN_WORLD, P_MACRO_MAX_WORLD - worldZ),
  );
  if (distanceToRim <= 0.0) { return 0.0; }
  let t = min(1.0, distanceToRim / P_MACRO_BLEND_METERS);
  return t * t * (3.0 - 2.0 * t);
}

fn pAnalyticAt(localX: f32, localZ: f32) -> f32 {
  let natural = terrainNaturalHeight(localX, localZ);
  return terrainRunwayEarthworksHeight(
    params.earthworks,
    natural,
    params.metrics.y + localX,
    params.metrics.z + localZ,
  );
}

fn pUpliftAt(localX: f32, localZ: f32) -> f32 {
  let uplift = terrainUpliftHeight(localX, localZ);
  return terrainRunwayEarthworksHeight(
    params.earthworks,
    uplift,
    params.metrics.y + localX,
    params.metrics.z + localZ,
  );
}

/** Bilinear parent stored-height tap resolved to the core-owning page. */
fn pParentHeightTap(tapX: i32, tapZ: i32) -> f32 {
  let pageX = i32(floor(f32(tapX) / f32(P_HEIGHT_CORE)));
  let pageZ = i32(floor(f32(tapZ) / f32(P_HEIGHT_CORE)));
  let blockX = clamp(pageX - params.band.z, 0, 1);
  let blockZ = clamp(pageZ - params.band.w, 0, 1);
  let slot = params.parentSlots[blockZ * 2 + blockX];
  let localX = tapX - pageX * P_HEIGHT_CORE;
  let localZ = tapZ - pageZ * P_HEIGHT_CORE;
  return textureLoad(
    parentHeightAtlas,
    vec2i(slot.x + P_GUTTER + localX, slot.y + P_GUTTER + localZ),
    0,
  ).r;
}

/** Decoded flow-area tap (m²) from the parent channel atlas's f16 log field. */
fn pParentFlowAreaTap(tapX: i32, tapZ: i32) -> f32 {
  let pageX = i32(floor(f32(tapX) / f32(P_CHANNEL_CORE)));
  let pageZ = i32(floor(f32(tapZ) / f32(P_CHANNEL_CORE)));
  let blockX = clamp(pageX - params.band.z, 0, 1);
  let blockZ = clamp(pageZ - params.band.w, 0, 1);
  let slot = params.parentSlots[blockZ * 2 + blockX];
  let localX = tapX - pageX * P_CHANNEL_CORE;
  let localZ = tapZ - pageZ * P_CHANNEL_CORE;
  let logArea = textureLoad(
    parentFlowAtlas,
    vec2i(slot.z + P_GUTTER + localX, slot.w + P_GUTTER + localZ),
    0,
  ).r;
  return max(0.0, exp2(logArea) - 1.0);
}

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let edge = params.shape.x;
  // The band base is written once per frame; workgroup_id.z picks this
  // dispatch's band off it, so one write serves every admitted band.
  let row = params.shape.w + id.z * u32(params.band.x) + id.y;
  if (id.x >= edge || id.y >= u32(params.band.x) || row >= edge) { return; }
  let index = row * edge + id.x;
  let texelSize = params.metrics.x;
  let baseX = f32(id.x) * texelSize;
  let baseZ = f32(row) * texelSize;
  let worldX = params.metrics.y + baseX;
  let worldZ = params.metrics.z + baseZ;

  // Child-filter analytic and uplift samples: L0 is one full-bandwidth
  // sample, coarser levels the fixed rotated-grid 4x pattern (page uniform 0).
  kSelectPage(0u);
  var analytic = 0.0;
  var uplift = 0.0;
  let count = params.shape.z;
  if (count <= 1u) {
    analytic = pAnalyticAt(baseX, baseZ);
    uplift = pUpliftAt(baseX, baseZ);
  } else {
    var analyticTotal = 0.0;
    var upliftTotal = 0.0;
    for (var sample = 0u; sample < count; sample = sample + 1u) {
      let offset = P_SUPERSAMPLE[sample];
      let sampleX = baseX + offset.x * texelSize;
      let sampleZ = baseZ + offset.y * texelSize;
      analyticTotal = analyticTotal + pAnalyticAt(sampleX, sampleZ);
      upliftTotal = upliftTotal + pUpliftAt(sampleX, sampleZ);
    }
    analytic = analyticTotal / f32(count);
    uplift = upliftTotal / f32(count);
  }

  var composed = 0.0;
  if (params.shape.y == 0u) {
    // MACRO composition: add the macro's eroded displacement to the page's
    // own band-limited uplift (preserves sub-512 m detail). The bilinear
    // macro leg is the worker's bit-exact CPU field, and so is the flow field
    // already sitting in flowOut — this branch writes neither.
    kSelectPage(1u);
    let macroUplift = terrainUpliftHeight(baseX, baseZ);
    composed = uplift + macroHeight[index] - macroUplift;
  } else {
    // W-2 PARENT composition: bilinear upsample of the parents' stored
    // r32f heights plus the band-limited uplift delta between the child and
    // parent filter widths. Taps resolve to the core-owning parent page, so
    // adjacent children of different parents read identical world data.
    kSelectPage(2u);
    let parentUplift = terrainUpliftHeight(baseX, baseZ);
    let parentCoord = vec2f(worldX, worldZ) / params.metrics.w;
    let tap0 = vec2i(i32(floor(parentCoord.x)), i32(floor(parentCoord.y)));
    let frac = parentCoord - floor(parentCoord);
    let h00 = pParentHeightTap(tap0.x, tap0.y);
    let h10 = pParentHeightTap(tap0.x + 1, tap0.y);
    let h01 = pParentHeightTap(tap0.x, tap0.y + 1);
    let h11 = pParentHeightTap(tap0.x + 1, tap0.y + 1);
    let top = h00 + (h10 - h00) * frac.x;
    let bottom = h01 + (h11 - h01) * frac.x;
    let parentHeight = top + (bottom - top) * frac.y;
    composed = parentHeight + (uplift - parentUplift);

    // Parent flow: bilinear over DECODED areas (mirroring the macro path's
    // linear-area bilinear); the channel atlas's f16 log quantisation is part
    // of this boundary condition by design.
    let channelCoord = vec2f(worldX, worldZ) / params.breach.x - vec2f(0.25, 0.25);
    let ctap0 = vec2i(i32(floor(channelCoord.x)), i32(floor(channelCoord.y)));
    let cfrac = channelCoord - floor(channelCoord);
    let a00 = pParentFlowAreaTap(ctap0.x, ctap0.y);
    let a10 = pParentFlowAreaTap(ctap0.x + 1, ctap0.y);
    let a01 = pParentFlowAreaTap(ctap0.x, ctap0.y + 1);
    let a11 = pParentFlowAreaTap(ctap0.x + 1, ctap0.y + 1);
    let atop = a00 + (a10 - a00) * cfrac.x;
    let abottom = a01 + (a11 - a01) * cfrac.x;
    let area = atop + (abottom - atop) * cfrac.y;
    flowOut[index] = max(1.0, area / (texelSize * texelSize));
  }

  // D2 compatibility blend; protected texels carry the exact analytic bits.
  if (erosionMaskIn[index] != 0u) {
    sourceOut[index] = analytic;
  } else {
    let blend = pMacroRimBlend(worldX, worldZ);
    sourceOut[index] = analytic + (composed - analytic) * blend;
  }
}
`;
}

/** GEOLOGY pass: erodibility/repose from the uplift kernel's geology sampler. */
function geologyWgsl(component: "erodibility" | "repose"): string {
  return /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 15)}
${TERRAIN_KERNEL_WGSL}
${terrainUpliftKernelPageBindingWgsl(0, 2)}
${TERRAIN_UPLIFT_KERNEL_WGSL}
${seedParamsWgsl(true)}
@group(0) @binding(3) var<storage, read_write> geologyOut: array<f32>;

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let edge = params.shape.x;
  let row = params.shape.w + id.z * u32(params.band.x) + id.y;
  if (id.x >= edge || id.y >= u32(params.band.x) || row >= edge) { return; }
  let index = row * edge + id.x;
  let texelSize = params.metrics.x;
  kSelectPage(0u);
  let geology = terrainEvolutionGeologySample(
    f32(id.x) * texelSize,
    f32(row) * texelSize,
  );
  geologyOut[index] = geology.${component === "erodibility" ? "z" : "w"};
}
`;
}

/**
 * BREACH pass A: initialise the orderable-encoded carve surface and resolve
 * each cell's direct receiver (strictly-lowest 8-neighbour, first-visited on
 * ties — the CPU loop's exact visit order). Pure per-cell gather.
 */
function breachDirectWgsl(): string {
  return /* wgsl */ `
${seedParamsWgsl(true)}
@group(0) @binding(1) var<storage, read> sourceHeight: array<f32>;
@group(0) @binding(2) var<storage, read> erosionMaskIn: array<u32>;
@group(0) @binding(3) var<storage, read_write> breachedBits: array<u32>;
@group(0) @binding(4) var<storage, read_write> receivers: array<i32>;

${ORDERABLE_WGSL}

const B_OFFSET_X: array<i32, 8> = array(-1, 0, 1, -1, 1, -1, 0, 1);
const B_OFFSET_Z: array<i32, 8> = array(-1, -1, -1, 0, 0, 1, 1, 1);

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let edge = i32(params.shape.x);
  if (id.x >= params.shape.x || id.y >= params.shape.x) { return; }
  let x = i32(id.x);
  let z = i32(id.y);
  let index = z * edge + x;
  breachedBits[index] = pOrderableEncode(sourceHeight[index]);
  receivers[index] = -1;
  if (x == 0 || z == 0 || x == edge - 1 || z == edge - 1) { return; }
  if (erosionMaskIn[index] != 0u) { return; }
  var directReceiver = -1;
  var directHeight = sourceHeight[index];
  for (var order = 0u; order < 8u; order = order + 1u) {
    let neighbour = (z + B_OFFSET_Z[order]) * edge + (x + B_OFFSET_X[order]);
    if (erosionMaskIn[neighbour] != 0u) { continue; }
    let candidate = sourceHeight[neighbour];
    // Ascending visit order makes "equal and lower index" unreachable after a
    // strict improvement, exactly as the CPU comparison behaves.
    if (candidate < directHeight
      || (candidate == directHeight && directReceiver >= 0 && neighbour < directReceiver)) {
      directHeight = candidate;
      directReceiver = neighbour;
    }
  }
  receivers[index] = directReceiver;
}
`;
}

/**
 * BREACH pass B: per-pit (2r+1)² window search and monotone line carve. The
 * carve is `breached[cell] = min(existing, interp)` — a commutative,
 * associative, idempotent min-combine — so atomicMin over the orderable
 * encoding is deterministic regardless of thread order. Receiver writes touch
 * only the owning pit cell.
 */
function breachPitWgsl(): string {
  return /* wgsl */ `
${seedParamsWgsl(true)}
@group(0) @binding(1) var<storage, read> sourceHeight: array<f32>;
@group(0) @binding(2) var<storage, read> erosionMaskIn: array<u32>;
@group(0) @binding(3) var<storage, read_write> breachedBits: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> receivers: array<i32>;

${ORDERABLE_WGSL}

/** Math.round (half toward +inf), the CPU path's exact rounding. */
fn bRound(value: f32) -> f32 {
  return floor(value + 0.5);
}

fn bPathIndex(startX: i32, startZ: i32, dx: i32, dz: i32, step: i32, steps: i32, edge: i32) -> i32 {
  let px = startX + i32(bRound(f32(dx * step) / f32(steps)));
  let pz = startZ + i32(bRound(f32(dz * step) / f32(steps)));
  return pz * edge + px;
}

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let edge = i32(params.shape.x);
  if (id.x >= params.shape.x || id.y >= params.shape.x) { return; }
  let x = i32(id.x);
  let z = i32(id.y);
  let index = z * edge + x;
  if (x == 0 || z == 0 || x == edge - 1 || z == edge - 1) { return; }
  if (erosionMaskIn[index] != 0u) { return; }
  if (receivers[index] >= 0) { return; }

  let radius = i32(params.breach.z);
  let epsilon = params.breach.y;
  let cellHeight = sourceHeight[index];
  var bestDx = 0;
  var bestDz = 0;
  var bestSteps = 0;
  var bestTarget = -1;
  var bestScore = 0.0;
  var haveBest = false;
  for (var dz = -radius; dz <= radius; dz = dz + 1) {
    for (var dx = -radius; dx <= radius; dx = dx + 1) {
      let steps = max(abs(dx), abs(dz));
      if (steps == 0 || steps > radius) { continue; }
      let tx = x + dx;
      let tz = z + dz;
      if (tx < 0 || tz < 0 || tx >= edge || tz >= edge) { continue; }
      let targetIndex = tz * edge + tx;
      let distance = sqrt(f32(dx * dx + dz * dz));
      let targetHeight = sourceHeight[targetIndex];
      if (!(targetHeight + epsilon * distance < cellHeight)) { continue; }
      var clear = true;
      for (var step = 1; step <= steps; step = step + 1) {
        if (erosionMaskIn[bPathIndex(x, z, dx, dz, step, steps, edge)] != 0u) {
          clear = false;
          break;
        }
      }
      if (!clear) { continue; }
      let score = targetHeight + epsilon * distance;
      if (!haveBest || score < bestScore
        || (score == bestScore && targetIndex < bestTarget)) {
        haveBest = true;
        bestScore = score;
        bestDx = dx;
        bestDz = dz;
        bestSteps = steps;
        bestTarget = targetIndex;
      }
    }
  }
  if (!haveBest) { return; }
  let outletHeight = sourceHeight[bestTarget];
  for (var step = 1; step < bestSteps; step = step + 1) {
    let pathCell = bPathIndex(x, z, bestDx, bestDz, step, bestSteps, edge);
    let descending = cellHeight
      + (outletHeight - cellHeight) * f32(step) / f32(bestSteps);
    atomicMin(&breachedBits[pathCell], pOrderableEncode(descending));
  }
  receivers[index] = bPathIndex(x, z, bestDx, bestDz, 1, bestSteps, edge);
}
`;
}

/** DECODE pass: orderable bits back to f32 for the stream-power input. */
function decodeWgsl(): string {
  return /* wgsl */ `
${seedParamsWgsl(true)}
@group(0) @binding(1) var<storage, read> breachedBits: array<u32>;
@group(0) @binding(2) var<storage, read_write> heightOut: array<f32>;

${ORDERABLE_WGSL}

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.shape.x || id.y >= params.shape.x) { return; }
  let index = id.y * params.shape.x + id.x;
  heightOut[index] = pOrderableDecode(breachedBits[index]);
}
`;
}

/**
 * `W-4` FINE BAND pass: the WGSL twin of `applyTerrainFineBandRelief`.
 *
 * Runs AFTER talus, so the mask reads the eroded surface's own slope,
 * curvature and contributing area rather than the tectonic input's lithology —
 * which is the entire substance of moving the 24 m/9 m bands off the uplift.
 * A pure per-cell gather over a five-tap stencil, so it is bit-reproducible on
 * one device like every other pass here, and it adds exactly 1 to the composed
 * operator reach W-8 audits.
 *
 * The soil proxy is the transliteration of `terrainSoilDepthMeters` +
 * `terrainTopographicWetnessIndex` + `terrainFineBandSurvival`; every constant
 * is INJECTED from the TypeScript authorities, never retyped.
 */
function fineBandWgsl(): string {
  return /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 15)}
${TERRAIN_KERNEL_WGSL}
${terrainUpliftKernelPageBindingWgsl(0, 2)}
${TERRAIN_UPLIFT_KERNEL_WGSL}
${seedParamsWgsl(true)}
${supersampleTableWgsl()}
@group(0) @binding(3) var<storage, read> heightIn: array<f32>;
@group(0) @binding(4) var<storage, read> flowAccumulation: array<f32>;
@group(0) @binding(5) var<storage, read> erosionMaskIn: array<u32>;
@group(0) @binding(6) var<storage, read_write> heightOut: array<f32>;

const F_SOIL_MAX_METERS: f32 = ${wgslFloat(TERRAIN_PAGE_HYDROLOGY_ENCODING.soilDepthMaxMeters)};
const F_TWI_EPSILON: f32 = ${wgslFloat(TERRAIN_TWI_SLOPE_EPSILON)};
const F_TWI_DRY: f32 = ${wgslFloat(TERRAIN_TWI_DRY)};
const F_TWI_WET: f32 = ${wgslFloat(TERRAIN_TWI_WET)};
const F_SOIL_THIN: f32 = ${wgslFloat(TERRAIN_FINE_BAND_SOIL_THIN_METERS)};
const F_SOIL_DEEP: f32 = ${wgslFloat(TERRAIN_FINE_BAND_SOIL_DEEP_METERS)};
const F_CONCAVE: f32 = ${wgslFloat(TERRAIN_FINE_BAND_CONCAVE_CURVATURE)};
const F_CONVEX: f32 = ${wgslFloat(TERRAIN_FINE_BAND_CONVEX_CURVATURE)};

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let edge = params.shape.x;
  let row = params.shape.w + id.z * u32(params.band.x) + id.y;
  if (id.x >= edge || id.y >= u32(params.band.x) || row >= edge) { return; }
  let index = row * edge + id.x;
  let centre = heightIn[index];
  heightOut[index] = centre;
  if (id.x == 0u || row == 0u || id.x + 1u >= edge || row + 1u >= edge) { return; }
  if (erosionMaskIn[index] != 0u) { return; }
  let texelSize = params.metrics.x;
  let west = heightIn[index - 1u];
  let east = heightIn[index + 1u];
  let north = heightIn[index - edge];
  let south = heightIn[index + edge];
  let gradientX = (east - west) / (2.0 * texelSize);
  let gradientZ = (south - north) / (2.0 * texelSize);
  let slopeRadians = atan(sqrt(gradientX * gradientX + gradientZ * gradientZ));
  let curvature = (centre - (west + east + north + south) * 0.25) / texelSize;

  // terrainTopographicWetnessIndex, then terrainSoilDepthMeters.
  let areaM2 = max(0.0, flowAccumulation[index]) * texelSize * texelSize;
  let twi = log((1.0 + areaM2) / (tan(slopeRadians) + F_TWI_EPSILON));
  let wetT = kSaturate((twi - F_TWI_DRY) / (F_TWI_WET - F_TWI_DRY));
  let wetness = wetT * wetT * (3.0 - 2.0 * wetT);
  let slopeRetention = exp(-tan(slopeRadians) / 0.35);
  let depositional = kSaturate(0.5 - curvature * 8.0);
  let soilDepth = kClamp(
    F_SOIL_MAX_METERS * slopeRetention * (0.4 + 0.6 * depositional) * (0.65 + 0.35 * wetness),
    0.0,
    F_SOIL_MAX_METERS,
  );

  // terrainFineBandSurvival.
  let thinSoil = 1.0 - kSmoothstep(F_SOIL_THIN, F_SOIL_DEEP, soilDepth);
  let convex = kSmoothstep(F_CONCAVE, F_CONVEX, curvature);
  let survival = thinSoil * convex;
  if (survival <= 0.0) { return; }

  // The band value uses the same level supersample pattern as the height
  // samples do (one full-bandwidth tap at L0, the fixed rotated 4x above it),
  // so a coarse page's band is the blurred version of the fine one rather than
  // a re-rolled phase. This mirrors the CPU seed loop exactly.
  kSelectPage(0u);
  let baseX = f32(id.x) * texelSize;
  let baseZ = f32(row) * texelSize;
  let count = params.shape.z;
  var relief = 0.0;
  if (count <= 1u) {
    relief = terrainFineBandRelief(baseX, baseZ);
  } else {
    var total = 0.0;
    for (var sample = 0u; sample < count; sample = sample + 1u) {
      let offset = P_SUPERSAMPLE[sample];
      total = total + terrainFineBandRelief(
        baseX + offset.x * texelSize,
        baseZ + offset.y * texelSize,
      );
    }
    relief = total / f32(count);
  }
  heightOut[index] = centre + relief * survival;
}
`;
}

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

/**
 * SIX 384² fields, and the count is load-bearing: `DYNAMIC_ALLOCATIONS`
 * reserves exactly `erosionScratchFieldCount` of them, and tier 0's memory
 * ceiling has ~0.4 MiB of headroom at its largest viewport — a seventh field
 * (0.56 MiB) breaks assertion 19 outright. Four of the six are therefore
 * shared across DAG phases, and every alias below is a phase-disjointness
 * argument, not an optimisation:
 *
 *  - `heightB`  stages the worker's macro height for SEED, holds the
 *               orderable-encoded BREACH surface, then becomes the
 *               stream-power/talus ping-pong's B side (which first writes it
 *               only after the breach fields have been read back).
 *  - `flow`     carries the accumulation boundary condition from SEED through
 *               stream power and on to `W-4`'s FINE BAND pass, which needs
 *               contributing area for its soil-depth mask. Talus reads no flow.
 *  - `receivers` carries the breach and MFD receiver topology through stream
 *               power, then holds the talus delta — talus reads no receivers.
 *  - `erodibility` is written by GEOLOGY, read by stream power only, and then
 *               holds `reposeDegrees` for talus.
 *
 * The consequence is that GEOLOGY runs TWICE per page (erodibility before
 * stream power, repose after it): before stream power there is no free field
 * for repose to live in. At 8 banded dispatches a pass that is ~7% of a page's
 * GPU time, which is the price of the sixth field.
 *
 * `W-4` MOVED REPOSE from `flow` into `erodibility`. Both are free at the same
 * moment — stream power has finished reading erodibility when repose is
 * written — but only one choice leaves the accumulation field alive for the
 * FINE BAND pass, whose soil-depth mask is a function of slope, curvature AND
 * contributing area. No seventh field: the count above is load-bearing against
 * tier 0's memory ceiling.
 */
interface GpuBuffers {
  /** Job-constant params + band cursor + earthworks. */
  readonly params: StorageBuffer;
  /** W-1a-format params for the reused stream-power/talus shaders. */
  readonly macroParams: StorageBuffer;
  readonly kernelPages: StorageBuffer;
  readonly upliftPages: StorageBuffer;
  readonly mask: StorageBuffer;
  /** Seed heights; the ping-pong A surface from DECODE onward. */
  readonly heightA: StorageBuffer;
  /** Macro height (seed) -> orderable breach bits -> ping-pong B. */
  readonly heightB: StorageBuffer;
  /** Flow accumulation -> reposeDegrees after stream power. */
  readonly flow: StorageBuffer;
  readonly erodibility: StorageBuffer;
  /** Breach/MFD receivers -> talus delta after stream power. */
  readonly receivers: StorageBuffer;
}

interface GpuShaders {
  readonly seed: ComputeShader;
  readonly geologyErodibility: ComputeShader;
  readonly geologyRepose: ComputeShader;
  readonly breachDirect: ComputeShader;
  readonly breachPit: ComputeShader;
  readonly decode: ComputeShader;
  readonly streamPowerFromA: ComputeShader;
  readonly streamPowerFromB: ComputeShader;
  readonly talusGatherFromA: ComputeShader;
  readonly talusGatherFromB: ComputeShader;
  readonly talusApplyAtoB: ComputeShader;
  readonly talusApplyBtoA: ComputeShader;
  readonly fineBandAtoB: ComputeShader;
  readonly fineBandBtoA: ComputeShader;
}

type StageCostKey = keyof typeof TERRAIN_EROSION_STAGE_SEED_COST_MS;

interface ShaderCostTracker {
  shader: ComputeShader;
  stage: StageCostKey;
  dispatchesSinceConsume: number;
  lastSampleCount: number;
}

interface ParentBlockBinding {
  readonly basePageX: number;
  readonly basePageZ: number;
  /** (heightU, heightV, channelU, channelV) per 2×2 entry. */
  readonly slots: Int32Array;
  /** Height-slot indices captured for the pre-dispatch re-verify. */
  readonly heightSlotIndices: readonly number[];
  readonly channelSlotIndices: readonly number[];
  readonly addresses: readonly WorldPageAddress[];
}

interface ActiveJob {
  readonly slot: TerrainAtlasSlot;
  readonly token: WorldPageOperationToken;
  readonly address: WorldPageAddress;
  readonly seedMode: TerrainErosionSeedMode;
  readonly stagedJob: TerrainStagedErosionJob;
  readonly resolve: (page: TerrainErodedPage) => void;
  readonly reject: (error: Error) => void;
  stage: TerrainErosionGpuStage;
  /** True while a worker round-trip or readback owns the job. */
  asyncInFlight: boolean;
  cancelled: boolean;
  bandIndex: number;
  breachDirectDone: boolean;
  spIteration: number;
  talusIteration: number;
  talusGatherPending: boolean;
  readFromA: boolean;
  seedDispatched: boolean;
  parentBlock: ParentBlockBinding | null;
  erosionMask: Uint8Array | null;
  startedAtMs: number;
  pumpsUsed: number;
  dispatchesUsed: number;
}

/** The error tag a cancelled job rejects with; callers treat it as silence. */
export class TerrainErosionCancelledError extends Error {
  constructor(reason: string) {
    super(`terrain erosion page cancelled: ${reason}`);
    this.name = "TerrainErosionCancelledError";
  }
}

export interface TerrainPageErosionGpuOptions {
  readonly world: Readonly<WorldDefinition>;
  readonly seedHash: number;
  readonly airport: Readonly<AirportDefinition> | null;
  readonly heightAtlas: TerrainPageAtlas;
  readonly channelAtlas: TerrainPageAtlas | null;
  /** Owned by the page generator, shared with the CPU fallback paths. */
  readonly executor: TerrainPageStagedErosionExecutor;
  /** Test seam; production uses TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL. */
  readonly parentSeededMaxLevel?: number;
}

/**
 * Per-page erosion timing sample for the report/tests (last completed page).
 */
export interface TerrainErosionGpuPageTiming {
  readonly totalMilliseconds: number;
  readonly pumps: number;
  readonly dispatches: number;
}

export class TerrainPageErosionGpu {
  private readonly engine: AbstractEngine;
  private readonly world: Readonly<WorldDefinition>;
  private readonly seedHash: number;
  private readonly airport: Readonly<AirportDefinition> | null;
  private readonly heightAtlas: TerrainPageAtlas;
  private readonly channelAtlas: TerrainPageAtlas | null;
  private readonly executor: TerrainPageStagedErosionExecutor;
  private readonly parentSeededMaxLevel: number;
  private buffers: GpuBuffers | null = null;
  private registeredBufferBytes = 0;
  private shaders: GpuShaders | null = null;
  private job: ActiveJob | null = null;
  private pumping = false;
  private disposed = false;
  private readonly stageEstimatesMs: Record<StageCostKey, number> = {
    ...TERRAIN_EROSION_STAGE_SEED_COST_MS,
  };
  private costTrackers: ShaderCostTracker[] = [];
  private readonly stageSamples: Record<
    StageCostKey,
    { milliseconds: number; dispatches: number }
  > = {
    seed: { milliseconds: 0, dispatches: 0 },
    geology: { milliseconds: 0, dispatches: 0 },
    breach: { milliseconds: 0, dispatches: 0 },
    decode: { milliseconds: 0, dispatches: 0 },
    streamPower: { milliseconds: 0, dispatches: 0 },
    talus: { milliseconds: 0, dispatches: 0 },
    fineBand: { milliseconds: 0, dispatches: 0 },
  };
  private lastPageTiming: TerrainErosionGpuPageTiming | null = null;

  constructor(engine: AbstractEngine, options: TerrainPageErosionGpuOptions) {
    this.engine = engine;
    this.world = options.world;
    this.seedHash = options.seedHash;
    this.airport = options.airport;
    this.heightAtlas = options.heightAtlas;
    this.channelAtlas = options.channelAtlas;
    this.executor = options.executor;
    this.parentSeededMaxLevel =
      options.parentSeededMaxLevel ?? TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL;
  }

  get hasActiveJob(): boolean {
    return this.job !== null;
  }

  get activeStage(): TerrainErosionGpuStage {
    return this.job?.stage ?? "idle";
  }

  get lastCompletedPageTiming(): TerrainErosionGpuPageTiming | null {
    return this.lastPageTiming;
  }

  isActiveKey(keyString: string): boolean {
    return this.job?.slot.keyString === keyString;
  }

  seedModeFor(level: number): TerrainErosionSeedMode {
    return terrainErosionSeedModeForLevel(level, this.parentSeededMaxLevel);
  }

  /** Addresses that must be RESIDENT (height + flow) before a page may start. */
  parentDependencies(address: WorldPageAddress): readonly WorldPageAddress[] {
    if (this.seedModeFor(address.level) === "macro") return [];
    return terrainErosionParentSeedBlock(address);
  }

  /**
   * This frame's admission demand: how many DAG dispatches could usefully run
   * and what one currently costs. Also the per-frame staleness check — a job
   * whose slot was re-admitted or released is cancelled here, releasing the
   * worker's retained stage state.
   */
  demand(pendingPageCount: number): { readonly count: number; readonly costMs: number } {
    this.pruneStale();
    const job = this.job;
    if (!job) {
      return pendingPageCount > 0
        ? { count: 1, costMs: this.stageEstimatesMs.seed }
        : { count: 0, costMs: this.stageEstimatesMs.seed };
    }
    if (job.asyncInFlight) return { count: 0, costMs: this.stageEstimatesMs.streamPower };
    switch (job.stage) {
      case "seed":
        return { count: SEED_BAND_COUNT - job.bandIndex, costMs: this.stageEstimatesMs.seed };
      case "geology":
      case "geology-repose":
        return {
          count: GEOLOGY_BAND_COUNT - job.bandIndex,
          costMs: this.stageEstimatesMs.geology,
        };
      case "breach":
        return {
          count: job.breachDirectDone ? 1 : 2,
          costMs: this.stageEstimatesMs.breach,
        };
      case "decode":
        return { count: 1, costMs: this.stageEstimatesMs.decode };
      case "stream-power":
        return {
          count: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerIterations - job.spIteration,
          costMs: this.stageEstimatesMs.streamPower,
        };
      case "talus":
        return {
          count:
            (TERRAIN_EROSION_PRODUCTION_CONFIG.talusIterations - job.talusIteration) * 2
            - (job.talusGatherPending ? 0 : 1),
          costMs: this.stageEstimatesMs.talus,
        };
      // `W-4`'s fine-band pass, banded exactly like geology (same 48-row slice,
      // same band cursor, its own measured cost row).
      //
      // **This case's absence is what broke Gate F.** W-4 added the stage to
      // the union, to `advance`, to the shaders, to the cost table and to the
      // cost trackers — and not here. The DAG therefore advanced into
      // `fine-band` and then reported ZERO demand forever: the clipmap submits
      // nothing when demand is zero, `ComputeBudget.admitted` returns 0 for a
      // client that never submitted, `dispatchPageGeneration` returns at its
      // `admitted <= 0` guard, and the page is never pumped again. Not one
      // eroded page ever became resident, so the whole world rendered flat,
      // silently, with no error anywhere.
      case "fine-band":
        return {
          count: GEOLOGY_BAND_COUNT - job.bandIndex,
          costMs: this.stageEstimatesMs.fineBand,
        };
      // Stages that legitimately want nothing: the CPU seed inputs, the two
      // readbacks and the MFD step are asynchronous (the `asyncInFlight` guard
      // above normally answers first), and `finish` is terminal.
      // `idle` is the no-job sentinel `activeStage` reports and is unreachable
      // here — the `!job` branch above already answered — but it is named so
      // the exhaustiveness check below stays a real guarantee.
      case "idle":
      case "seed-inputs":
      case "readback":
      case "mfd":
      case "evolved-readback":
      case "finish":
        return { count: 0, costMs: this.stageEstimatesMs.streamPower };
      default: {
        /**
         * Exhaustiveness, so the next stage added to the DAG is a COMPILE
         * error here rather than a silently flat world.
         *
         * The old `default: count 0` failed CLOSED, which is the wrong
         * direction for an admission meter: an unrecognised stage stopped
         * asking for work and the DAG froze. Answering one dispatch fails OPEN
         * instead — `pump` is a no-op for a stage that needs none, so the worst
         * case is a wasted admission rather than a world that never loads.
         */
        const unreachable: never = job.stage;
        void unreachable;
        return { count: 1, costMs: this.stageEstimatesMs.streamPower };
      }
    }
  }

  /**
   * Begin one page's DAG. The returned promise resolves with the finished
   * TerrainErodedPage many frames later (drive {@link pump} each frame), or
   * rejects with {@link TerrainErosionCancelledError} on eviction.
   */
  beginPage(slot: TerrainAtlasSlot, token: WorldPageOperationToken): Promise<TerrainErodedPage> {
    if (this.disposed) return Promise.reject(new Error("TerrainPageErosionGpu is disposed"));
    if (this.job) return Promise.reject(new Error("A terrain erosion page is already in flight"));
    const seedMode = this.seedModeFor(slot.address.level);
    const stagedJob = this.executor.stagedJob(slot.address);
    let resolve!: (page: TerrainErodedPage) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<TerrainErodedPage>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: ActiveJob = {
      slot,
      token,
      address: slot.address,
      seedMode,
      stagedJob,
      resolve,
      reject,
      stage: "seed-inputs",
      asyncInFlight: true,
      cancelled: false,
      bandIndex: 0,
      breachDirectDone: false,
      spIteration: 0,
      talusIteration: 0,
      talusGatherPending: true,
      readFromA: true,
      seedDispatched: false,
      parentBlock: null,
      erosionMask: null,
      startedAtMs: performance.now(),
      pumpsUsed: 0,
      dispatchesUsed: 0,
    };
    this.job = job;
    void stagedJob
      .seedInputs(seedMode)
      .then((inputs) => {
        if (this.disposed || job.cancelled || this.job !== job) return;
        const buffers = this.ensureBuffers();
        job.erosionMask = inputs.erosionMask;
        const mask = new Uint32Array(SCRATCH_COUNT);
        for (let index = 0; index < SCRATCH_COUNT; index += 1) {
          if (inputs.erosionMask[index]! >= 0.5) mask[index] = 1;
        }
        buffers.mask.update(mask);
        // Macro mode: the flow field is a pure CPU product and goes straight
        // into the flow buffer (the seed pass must not write over it), and the
        // macro height is staged in the ping-pong's B side, which no pass
        // touches until the first stream-power iteration.
        if (inputs.macroHeight) buffers.heightB.update(inputs.macroHeight);
        if (inputs.macroFlow) buffers.flow.update(inputs.macroFlow);
        job.stage = "seed";
        job.asyncInFlight = false;
      })
      .catch((error: unknown) => this.failJob(job, error));
    return promise;
  }

  /**
   * Advance the active DAG by up to `admittedDispatches` GPU dispatches.
   *
   * Banded stages issue ONE dispatch per frame, `k` bands deep in z: their
   * band base lives in the shared params buffer, Babylon records the frame
   * into one encoder, and a second cursor write in the same frame would be
   * read by the first dispatch too (the D11 hazard).
   */
  async pump(admittedDispatches: number): Promise<void> {
    this.pruneStale();
    const job = this.job;
    if (!job || job.asyncInFlight || this.disposed || this.pumping) return;
    if (admittedDispatches <= 0) return;
    // Not reentrant: `advance` mutates the stage cursor across awaits, and the
    // clipmap does not await `generate`, so a pump whose first dispatch is
    // still compiling its pipeline can be re-entered by the next frame.
    this.pumping = true;
    try {
      await this.advance(job, Math.max(1, Math.floor(admittedDispatches)));
    } catch (error) {
      // A dispatch that throws must fail THIS page on its own token, not
      // reject out into the clipmap where the whole ranked candidate batch
      // would be released for one bad encode.
      this.failJob(job, error);
    } finally {
      this.pumping = false;
    }
  }

  private async advance(job: ActiveJob, admitted: number): Promise<void> {
    const buffers = this.ensureBuffers();
    const shaders = this.ensureShaders(buffers);
    job.pumpsUsed += 1;
    const fullGroups = SCRATCH_EDGE / WORKGROUP_EDGE;
    let remaining = admitted;

    if (job.stage === "fine-band") {
      // W-4: banded like geology (same 48-row slice, same per-band cost row),
      // because one whole-384² dispatch of the uplift kernel's fine-band
      // sampler sits above every tier's erosionCompute row.
      this.writeBandCursor(job, buffers);
      const bands = Math.min(remaining, GEOLOGY_BAND_COUNT - job.bandIndex);
      const shader = job.readFromA ? shaders.fineBandAtoB : shaders.fineBandBtoA;
      await this.dispatch(
        shader,
        "fineBand",
        fullGroups,
        TERRAIN_EROSION_GEOLOGY_BAND_ROWS / WORKGROUP_EDGE,
        bands,
        job,
        bands,
      );
      job.bandIndex += bands;
      if (job.bandIndex >= GEOLOGY_BAND_COUNT) {
        // Every band wrote the OTHER buffer, so the surface has moved sides.
        job.readFromA = !job.readFromA;
        job.stage = "evolved-readback";
        job.asyncInFlight = true;
        void this.runEvolvedReadbackAndFinish(job, buffers);
      }
      return;
    }

    if (job.stage === "seed" || job.stage === "geology" || job.stage === "geology-repose") {
      const seeding = job.stage === "seed";
      if (seeding && !job.seedDispatched) {
        if (!this.writeJobUniforms(job, buffers)) return;
        job.seedDispatched = true;
      } else {
        this.writeBandCursor(job, buffers);
      }
      if (seeding && job.seedMode === "parent" && !this.verifyParentBlock(job)) {
        this.cancelJob(job, "parent block changed mid-seed");
        return;
      }
      const bandCount = seeding ? SEED_BAND_COUNT : GEOLOGY_BAND_COUNT;
      const bandRows = seeding
        ? TERRAIN_EROSION_SEED_BAND_ROWS
        : TERRAIN_EROSION_GEOLOGY_BAND_ROWS;
      const shader = seeding
        ? shaders.seed
        : job.stage === "geology" ? shaders.geologyErodibility : shaders.geologyRepose;
      // One dispatch, `bands` deep in z: the params write above is the only
      // one this frame, so every band in it reads the same base.
      const bands = Math.min(remaining, bandCount - job.bandIndex);
      await this.dispatch(
        shader,
        seeding ? "seed" : "geology",
        fullGroups,
        bandRows / WORKGROUP_EDGE,
        bands,
        job,
        bands,
      );
      job.bandIndex += bands;
      if (job.bandIndex >= bandCount) {
        job.stage = seeding ? "geology" : job.stage === "geology" ? "breach" : "talus";
        job.bandIndex = 0;
      }
      return;
    }

    if (job.stage === "breach") {
      if (!job.breachDirectDone) {
        await this.dispatch(shaders.breachDirect, "breach", fullGroups, fullGroups, 1, job);
        job.breachDirectDone = true;
        remaining -= 1;
        if (remaining <= 0 || job.cancelled || this.job !== job) return;
      }
      await this.dispatch(shaders.breachPit, "breach", fullGroups, fullGroups, 1, job);
      job.stage = "readback";
      job.asyncInFlight = true;
      void this.runReadbackAndMfd(job, buffers);
      return;
    }

    if (job.stage === "decode") {
      await this.dispatch(shaders.decode, "decode", fullGroups, fullGroups, 1, job);
      job.stage = "stream-power";
      job.readFromA = true;
      remaining -= 1;
      if (remaining <= 0) return;
    }

    if (job.stage === "stream-power") {
      const iterations = TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerIterations;
      while (remaining > 0 && job.spIteration < iterations) {
        const shader = job.readFromA ? shaders.streamPowerFromA : shaders.streamPowerFromB;
        await this.dispatch(shader, "streamPower", fullGroups, fullGroups, 1, job);
        job.readFromA = !job.readFromA;
        job.spIteration += 1;
        remaining -= 1;
        if (job.cancelled || this.job !== job) return;
      }
      if (job.spIteration >= iterations) {
        // Repose has had nowhere to live until now: the flow buffer it lands
        // in was the stream-power accumulation field a dispatch ago.
        job.stage = "geology-repose";
        job.bandIndex = 0;
        return;
      }
      if (remaining <= 0) return;
    }

    if (job.stage === "talus") {
      const iterations = TERRAIN_EROSION_PRODUCTION_CONFIG.talusIterations;
      while (remaining > 0 && job.talusIteration < iterations) {
        if (job.talusGatherPending) {
          const gather = job.readFromA ? shaders.talusGatherFromA : shaders.talusGatherFromB;
          await this.dispatch(gather, "talus", fullGroups, fullGroups, 1, job);
          job.talusGatherPending = false;
        } else {
          const apply = job.readFromA ? shaders.talusApplyAtoB : shaders.talusApplyBtoA;
          await this.dispatch(apply, "talus", fullGroups, fullGroups, 1, job);
          job.readFromA = !job.readFromA;
          job.talusGatherPending = true;
          job.talusIteration += 1;
        }
        remaining -= 1;
        if (job.cancelled || this.job !== job) return;
      }
      if (job.talusIteration >= iterations) {
        job.stage = "fine-band";
        job.bandIndex = 0;
      }
    }
  }

  /** The measured per-dispatch cost of whatever samples resolved, averaged. */
  consumeMeasuredDispatchCostMs(): number | null {
    let totalMs = 0;
    let totalDispatches = 0;
    for (const tracker of this.costTrackers) {
      const sampler = tracker.shader as unknown as {
        gpuTimeInFrame?: { counter: { count: number; current: number } };
      };
      const counter = sampler.gpuTimeInFrame?.counter;
      if (!counter || tracker.dispatchesSinceConsume <= 0) continue;
      if (counter.count === tracker.lastSampleCount) continue;
      const milliseconds = counter.current / 1_000_000;
      tracker.lastSampleCount = counter.count;
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
        tracker.dispatchesSinceConsume = 0;
        continue;
      }
      const perDispatch = milliseconds / tracker.dispatchesSinceConsume;
      const previous = this.stageEstimatesMs[tracker.stage];
      this.stageEstimatesMs[tracker.stage] = previous + (perDispatch - previous) * 0.25;
      const sample = this.stageSamples[tracker.stage];
      sample.milliseconds += milliseconds;
      sample.dispatches += tracker.dispatchesSinceConsume;
      totalMs += milliseconds;
      totalDispatches += tracker.dispatchesSinceConsume;
      tracker.dispatchesSinceConsume = 0;
    }
    if (totalDispatches <= 0) return null;
    return totalMs / totalDispatches;
  }

  /** Current smoothed per-dispatch stage estimates (diagnostics/tests). */
  stageEstimates(): Readonly<Record<StageCostKey, number>> {
    return { ...this.stageEstimatesMs };
  }

  /**
   * RAW accumulated timing per stage since the last call, unsmoothed: the
   * cost test measures with this rather than with the running estimate, whose
   * exponential smoothing would drag a measurement toward the pinned seed it
   * is supposed to falsify.
   */
  consumeStageMeasurements(): Readonly<
    Record<StageCostKey, { readonly milliseconds: number; readonly dispatches: number }>
  > {
    const snapshot = Object.fromEntries(
      Object.entries(this.stageSamples).map(([stage, sample]) => [
        stage,
        { milliseconds: sample.milliseconds, dispatches: sample.dispatches },
      ]),
    ) as Record<StageCostKey, { milliseconds: number; dispatches: number }>;
    for (const sample of Object.values(this.stageSamples)) {
      sample.milliseconds = 0;
      sample.dispatches = 0;
    }
    return snapshot;
  }

  /** Cancel any active job (evicted slots, disposal, atlas reshape). */
  cancelActive(reason: string): void {
    const job = this.job;
    if (job) this.cancelJob(job, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActive("producer disposed");
    this.releaseBuffers();
    this.shaders = null;
    this.costTrackers = [];
  }

  // -- internals ------------------------------------------------------------

  private pruneStale(): void {
    const job = this.job;
    if (!job) return;
    if (
      job.slot.token !== job.token
      || this.heightAtlas.residency.get(job.slot.key) !== job.slot
    ) {
      this.cancelJob(job, "slot re-admitted or released mid-DAG");
    }
  }

  private cancelJob(job: ActiveJob, reason: string): void {
    if (job.cancelled) return;
    job.cancelled = true;
    if (this.job === job) this.job = null;
    job.stagedJob.cancel();
    job.reject(new TerrainErosionCancelledError(reason));
  }

  private failJob(job: ActiveJob, error: unknown): void {
    if (job.cancelled) return;
    job.cancelled = true;
    if (this.job === job) this.job = null;
    job.stagedJob.cancel();
    job.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private async runReadbackAndMfd(job: ActiveJob, buffers: GpuBuffers): Promise<void> {
    try {
      const byteLength = SCRATCH_COUNT * 4;
      const copyOut = (view: ArrayBufferView): ArrayBuffer =>
        view.buffer.slice(view.byteOffset, view.byteOffset + byteLength) as ArrayBuffer;
      // SEQUENTIAL, not Promise.all. Four concurrent `read()`s race Babylon's
      // staging/mapAsync machinery, and a copy that has not been submitted when
      // its map resolves yields ZEROS rather than an error — the recorded
      // readback hazard, whose symptom surfaces two subsystems away as
      // "drainageHeight[0] must be finite". Reading in order costs nothing
      // measurable (one queue, same submits) and removes the race.
      // `noDelay: true` is LOAD-BEARING, not an optimisation. Babylon defers a
      // plain read to the next frame's submit, so in any context without a
      // render loop pumping frames — the GPU cost test, a headless harness —
      // the recorded DAG dispatches are never submitted and every buffer reads
      // back as freshly-allocated ZEROS. The macro producers already carry this
      // for the same reason ("startup has no render loop pumping frames, so the
      // flush must be explicit"); the page DAG omitted it, which is the real
      // cause of the readback fault, with the concurrent reads only widening
      // the window.
      const readScratch = async (
        buffer: StorageBuffer,
      ): Promise<ArrayBuffer> => copyOut(await buffer.read(0, byteLength, undefined, true));
      let sourceHeight = new Float32Array(await readScratch(buffers.heightA));
      let breachedHeightBits = new Uint32Array(await readScratch(buffers.heightB));
      let breachReceivers = new Int32Array(await readScratch(buffers.receivers));
      let flowAccumulation = new Float32Array(await readScratch(buffers.flow));
      if (this.disposed || job.cancelled || this.job !== job) return;
      // A faulted readback is RECOVERABLE: the GPU buffer still holds the
      // result, so re-read once before failing the page. Zero is not a legal
      // orderable encoding, which is what makes the fault detectable at all.
      if (terrainErosionOrderableReadbackFaultIndex(breachedHeightBits) >= 0) {
        sourceHeight = new Float32Array(await readScratch(buffers.heightA));
        breachedHeightBits = new Uint32Array(await readScratch(buffers.heightB));
        breachReceivers = new Int32Array(await readScratch(buffers.receivers));
        flowAccumulation = new Float32Array(await readScratch(buffers.flow));
        if (this.disposed || job.cancelled || this.job !== job) return;
      }
      if (!job.erosionMask) throw new Error("erosion mask missing at MFD stage");
      job.stage = "mfd";
      const receivers = await job.stagedJob.mfd({
        sourceHeight,
        breachedHeightBits,
        breachReceivers,
        flowAccumulation,
        erosionMask: job.erosionMask,
      });
      if (this.disposed || job.cancelled || this.job !== job) return;
      buffers.receivers.update(receivers);
      job.stage = "decode";
      job.asyncInFlight = false;
    } catch (error) {
      this.failJob(job, error);
    }
  }

  private async runEvolvedReadbackAndFinish(job: ActiveJob, buffers: GpuBuffers): Promise<void> {
    try {
      const byteLength = SCRATCH_COUNT * 4;
      // 24 SP iterations, then 32 gather/apply pairs, then W-4's single
      // fine-band ping-pong: `readFromA` has tracked every one of them, so it
      // names the buffer the finished surface is in.
      const finalBuffer = job.readFromA ? buffers.heightA : buffers.heightB;
      // Explicit flush, as above: a deferred read without a frame loop returns
      // zeros rather than the evolved surface.
      const view = await finalBuffer.read(0, byteLength, undefined, true);
      if (this.disposed || job.cancelled || this.job !== job) return;
      const evolvedHeight = new Float32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + byteLength),
      );
      job.stage = "finish";
      const page = await job.stagedJob.finish(evolvedHeight);
      if (this.disposed || job.cancelled || this.job !== job) return;
      this.lastPageTiming = Object.freeze({
        totalMilliseconds: performance.now() - job.startedAtMs,
        pumps: job.pumpsUsed,
        dispatches: job.dispatchesUsed,
      });
      this.job = null;
      job.resolve(page);
    } catch (error) {
      this.failJob(job, error);
    }
  }

  /** Resolve + capture the 2×2 parent block's slot origins. Null on a hole. */
  private resolveParentBlock(address: WorldPageAddress): ParentBlockBinding | null {
    const channelAtlas = this.channelAtlas;
    if (!channelAtlas) return null;
    const addresses = terrainErosionParentSeedBlock(address);
    const slots = new Int32Array(16);
    const heightSlotIndices: number[] = [];
    const channelSlotIndices: number[] = [];
    let basePageX = Number.POSITIVE_INFINITY;
    let basePageZ = Number.POSITIVE_INFINITY;
    for (const parent of addresses) {
      basePageX = Math.min(basePageX, parent.x);
      basePageZ = Math.min(basePageZ, parent.z);
    }
    for (const parent of addresses) {
      const key = invariantKeyOf(parent);
      const heightSlot = this.heightAtlas.residency.get(key);
      const channelSlot = channelAtlas.residency.get(key);
      // `hydrologyReady`, not channel RESIDENCY: the flow field is in the
      // atlas the moment the four aux uploads commit, and a channel slot stays
      // `generating` until its occlusion and splat bakes land — neither of
      // which touches the log-flow texels this seed reads.
      if (
        !heightSlot
        || heightSlot.lifecycle.state !== "resident"
        || !channelSlot
        || !channelSlot.hydrologyReady
      ) return null;
      const heightOrigin = this.heightAtlas.slotOrigin(heightSlot.slotIndex);
      const channelOrigin = channelAtlas.slotOrigin(channelSlot.slotIndex);
      const entry = ((parent.z - basePageZ) * 2 + (parent.x - basePageX)) * 4;
      slots[entry] = heightOrigin.u;
      slots[entry + 1] = heightOrigin.v;
      slots[entry + 2] = channelOrigin.u;
      slots[entry + 3] = channelOrigin.v;
      heightSlotIndices.push(heightSlot.slotIndex);
      channelSlotIndices.push(channelSlot.slotIndex);
    }
    return {
      basePageX,
      basePageZ,
      slots,
      heightSlotIndices,
      channelSlotIndices,
      addresses,
    };
  }

  /**
   * Re-verify (before every seed band encodes) that the captured parent slots
   * still hold the captured pages: an eviction between pumps re-uses a slot
   * for another page, and the queued texture write would land BEFORE this
   * frame's dispatch executes.
   */
  private verifyParentBlock(job: ActiveJob): boolean {
    const captured = job.parentBlock;
    if (!captured) return false;
    const channelAtlas = this.channelAtlas;
    if (!channelAtlas) return false;
    for (let index = 0; index < captured.addresses.length; index += 1) {
      const key = invariantKeyOf(captured.addresses[index]!);
      const heightSlot = this.heightAtlas.residency.get(key);
      const channelSlot = channelAtlas.residency.get(key);
      if (
        !heightSlot
        || heightSlot.lifecycle.state !== "resident"
        || heightSlot.slotIndex !== captured.heightSlotIndices[index]
        || !channelSlot
        || !channelSlot.hydrologyReady
        || channelSlot.slotIndex !== captured.channelSlotIndices[index]
      ) return false;
    }
    return true;
  }

  /** Upload the per-page uniforms. False cancels the job (parent hole). */
  private writeJobUniforms(job: ActiveJob, buffers: GpuBuffers): boolean {
    const address = job.address;
    const level = address.level;
    const texelSize = terrainTexelSizeMeters(level);
    const filterWidth = terrainPageFilterWidthMeters(level);
    const parentFilterWidth = terrainPageFilterWidthMeters(level + 1);
    const bounds = worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS);
    const originX = bounds.minX - EROSION_HALO_TEXELS * texelSize;
    const originZ = bounds.minZ - EROSION_HALO_TEXELS * texelSize;

    let parentBlock: ParentBlockBinding | null = null;
    if (job.seedMode === "parent") {
      parentBlock = this.resolveParentBlock(address);
      if (!parentBlock) {
        this.cancelJob(job, "parent block not resident at seed time");
        return false;
      }
      job.parentBlock = parentBlock;
    }

    // Three page uniforms per kernel: [0] child filter, [1] the 512 m macro
    // filter (macroUplift), [2] the parent filter (`W-2` delta). Both kernels
    // share kPageIndex, so both arrays carry all three entries.
    const kernelPages = new Uint8Array(KERNEL_PAGE_SLOTS * TERRAIN_KERNEL_PAGE_BYTES);
    const upliftPages = new Uint8Array(KERNEL_PAGE_SLOTS * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES);
    const filterWidths = [filterWidth, EVOLUTION_TEXEL_METERS, parentFilterWidth] as const;
    filterWidths.forEach((width, page) => {
      kernelPages.set(
        new Uint8Array(buildTerrainKernelPageUniform({
          seedHash: this.seedHash,
          originX,
          originZ,
          filterWidthMeters: width,
        })),
        page * TERRAIN_KERNEL_PAGE_BYTES,
      );
      upliftPages.set(
        new Uint8Array(buildTerrainUpliftKernelPageUniform({
          seedHash: this.seedHash,
          originX,
          originZ,
          filterWidthMeters: width,
        })),
        page * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
      );
    });
    buffers.kernelPages.update(kernelPages);
    buffers.upliftPages.update(upliftPages);

    const params = new ArrayBuffer(SEED_PARAMS_BYTES);
    const u32 = new Uint32Array(params);
    const i32 = new Int32Array(params);
    const f32 = new Float32Array(params);
    u32[0] = SCRATCH_EDGE;
    u32[1] = job.seedMode === "parent" ? 1 : 0;
    u32[2] = terrainSupersampleOffsets(level).length;
    u32[3] = 0; // band start row
    i32[4] = TERRAIN_EROSION_SEED_BAND_ROWS;
    i32[5] = 0;
    i32[6] = parentBlock?.basePageX ?? 0;
    i32[7] = parentBlock?.basePageZ ?? 0;
    f32[8] = texelSize;
    f32[9] = originX;
    f32[10] = originZ;
    f32[11] = texelSize * 2;
    f32[12] = texelSize * 4;
    f32[13] = TERRAIN_EROSION_PRODUCTION_CONFIG.drainageEpsilonMetersPerTexel;
    f32[14] = TERRAIN_EROSION_PRODUCTION_CONFIG.pitBreachRadiusTexels;
    f32[15] = 0;
    if (parentBlock) i32.set(parentBlock.slots, 16);
    f32.set(
      new Float32Array(packRunwayEarthworksUniform(this.airport, this.seedHash).buffer),
      32,
    );
    buffers.params.update(new Uint8Array(params));

    // W-1a-format params for the reused stream-power/talus shaders. Page
    // stream power has NO sea-level skip: -inf disables the comparison, the
    // CPU operator's exact default.
    const macroParams = new ArrayBuffer(16);
    const macroU32 = new Uint32Array(macroParams);
    const macroF32 = new Float32Array(macroParams);
    macroU32[0] = SCRATCH_EDGE;
    macroU32[1] = SCRATCH_EDGE;
    macroF32[2] = Number.NEGATIVE_INFINITY;
    macroF32[3] = texelSize;
    buffers.macroParams.update(new Uint8Array(macroParams));
    return true;
  }

  /** Rewrite ONLY the band-base words. Exactly one such write per frame. */
  private writeBandCursor(job: ActiveJob, buffers: GpuBuffers): void {
    const bandRows = job.stage === "seed"
      ? TERRAIN_EROSION_SEED_BAND_ROWS
      : TERRAIN_EROSION_GEOLOGY_BAND_ROWS;
    const words = new Int32Array(2);
    words[0] = job.bandIndex * bandRows;
    words[1] = bandRows;
    // Words 3 (bandStartRow, u32) and 4 (bandRows, i32) of the params block.
    buffers.params.update(new Uint8Array(words.buffer), 12);
  }

  private async dispatch(
    shader: ComputeShader,
    stage: StageCostKey,
    groupsX: number,
    groupsY: number,
    groupsZ: number,
    job: ActiveJob,
    costUnits = 1,
  ): Promise<void> {
    job.dispatchesUsed += costUnits;
    const tracker = this.costTrackers.find((entry) => entry.shader === shader);
    if (tracker) tracker.dispatchesSinceConsume += costUnits;
    void stage;
    // `dispatch` returns false only before the effect is ready; the awaited
    // form then compiles it. Both encode into the CURRENT frame's encoder.
    if (!shader.dispatch(groupsX, groupsY, groupsZ)) {
      await shader.dispatchWhenReady(groupsX, groupsY, groupsZ);
    }
  }

  private releaseBuffers(): void {
    const buffers = this.buffers;
    if (!buffers) return;
    this.buffers = null;
    for (const buffer of Object.values(buffers)) buffer.dispose();
    releaseGpuBufferBytes(this.registeredBufferBytes);
    this.registeredBufferBytes = 0;
  }

  private ensureBuffers(): GpuBuffers {
    if (this.buffers) return this.buffers;
    const engine = this.engine as WebGPUEngine;
    const bytes = SCRATCH_COUNT * 4;
    // DEFAULT creation flags on purpose (the recorded StorageBuffer trap:
    // STORAGE|READ drops WRITE and update() silently does nothing).
    this.buffers = Object.freeze({
      params: new StorageBuffer(engine, SEED_PARAMS_BYTES, undefined, "pageErosionParams"),
      macroParams: new StorageBuffer(engine, 16, undefined, "pageErosionMacroParams"),
      kernelPages: new StorageBuffer(
        engine,
        KERNEL_PAGE_SLOTS * TERRAIN_KERNEL_PAGE_BYTES,
        undefined,
        "pageErosionKernelPages",
      ),
      upliftPages: new StorageBuffer(
        engine,
        KERNEL_PAGE_SLOTS * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
        undefined,
        "pageErosionUpliftPages",
      ),
      mask: new StorageBuffer(engine, bytes, undefined, "pageErosionMask"),
      heightA: new StorageBuffer(engine, bytes, undefined, "pageErosionHeightA"),
      heightB: new StorageBuffer(engine, bytes, undefined, "pageErosionHeightB"),
      flow: new StorageBuffer(engine, bytes, undefined, "pageErosionFlow"),
      erodibility: new StorageBuffer(engine, bytes, undefined, "pageErosionErodibility"),
      receivers: new StorageBuffer(engine, bytes, undefined, "pageErosionReceivers"),
    });
    // `FlightRenderer.inventoryGpuMemoryMiB` walks scene textures and mesh
    // geometry and cannot see a StorageBuffer, so the capture's inventoried
    // memory wall would read byte-identical however much scratch this
    // producer took. These are the bytes the erosionScratch
    // DYNAMIC_ALLOCATIONS row reconciles against.
    this.registeredBufferBytes = Object.values(this.buffers)
      .reduce((total, buffer) => total + buffer.getBuffer().capacity, 0);
    registerGpuBufferBytes(this.registeredBufferBytes);
    return this.buffers;
  }

  /** The 384² scratch fields this producer holds; pinned against the budget. */
  static readonly SCRATCH_FIELD_COUNT = 6;
  static readonly SCRATCH_FIELD_BYTES = SCRATCH_COUNT * 4;

  private ensureShaders(buffers: GpuBuffers): GpuShaders {
    if (this.shaders) return this.shaders;
    const engine = this.engine;
    const heightTexture = this.heightAtlas.texture();
    const flowTexture = this.channelAtlas?.hydrologyTextures().flowAccum ?? null;
    if (!heightTexture) throw new Error("Terrain erosion GPU producer needs the height atlas");

    // All shaders here stay TIMED: consumeMeasuredDispatchCostMs feeds the
    // erosionCompute admission estimate (TIMED_ON_PURPOSE names this file).
    const seed = new ComputeShader(
      "terrain-page-erosion-seed",
      engine,
      { computeSource: seedWgsl() },
      {
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          terrainKernelPages: { group: 0, binding: 1 },
          upliftKernelPages: { group: 0, binding: 2 },
          erosionMaskIn: { group: 0, binding: 3 },
          macroHeight: { group: 0, binding: 4 },
          sourceOut: { group: 0, binding: 5 },
          flowOut: { group: 0, binding: 6 },
          parentHeightAtlas: { group: 0, binding: 7 },
          parentFlowAtlas: { group: 0, binding: 8 },
        },
      },
    );
    seed.setStorageBuffer("params", buffers.params);
    seed.setStorageBuffer("terrainKernelPages", buffers.kernelPages);
    seed.setStorageBuffer("upliftKernelPages", buffers.upliftPages);
    seed.setStorageBuffer("erosionMaskIn", buffers.mask);
    seed.setStorageBuffer("macroHeight", buffers.heightB);
    seed.setStorageBuffer("sourceOut", buffers.heightA);
    seed.setStorageBuffer("flowOut", buffers.flow);
    seed.setTexture("parentHeightAtlas", heightTexture, false);
    // Macro-only worlds (no channel atlas) still need a bound texture; the
    // height atlas stands in and the parent branch is unreachable there.
    seed.setTexture(
      "parentFlowAtlas",
      (flowTexture ?? heightTexture) as Parameters<ComputeShader["setTexture"]>[1],
      false,
    );

    const geologyShader = (
      name: string,
      component: "erodibility" | "repose",
      output: StorageBuffer,
    ): ComputeShader => {
      const shader = new ComputeShader(
        name,
        engine,
        { computeSource: geologyWgsl(component) },
        {
          bindingsMapping: {
            // The height-kernel page binding (0, 15) is DEAD here: Tint prunes
            // it (nothing reachable reads it) and it must not be mapped or set.
            params: { group: 0, binding: 0 },
            upliftKernelPages: { group: 0, binding: 2 },
            geologyOut: { group: 0, binding: 3 },
          },
        },
      );
      shader.setStorageBuffer("params", buffers.params);
      shader.setStorageBuffer("upliftKernelPages", buffers.upliftPages);
      shader.setStorageBuffer("geologyOut", output);
      return shader;
    };
    const geologyErodibility = geologyShader(
      "terrain-page-erosion-geology-erodibility",
      "erodibility",
      buffers.erodibility,
    );
    // Repose lands in the erodibility buffer: stream power has finished
    // reading it, and unlike the flow field it is not needed again (W-4's fine
    // band pass reads contributing area). See GpuBuffers for the full argument.
    const geologyRepose = geologyShader(
      "terrain-page-erosion-geology-repose",
      "repose",
      buffers.erodibility,
    );

    const breachDirect = new ComputeShader(
      "terrain-page-erosion-breach-direct",
      engine,
      { computeSource: breachDirectWgsl() },
      {
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          sourceHeight: { group: 0, binding: 1 },
          erosionMaskIn: { group: 0, binding: 2 },
          breachedBits: { group: 0, binding: 3 },
          receivers: { group: 0, binding: 4 },
        },
      },
    );
    breachDirect.setStorageBuffer("params", buffers.params);
    breachDirect.setStorageBuffer("sourceHeight", buffers.heightA);
    breachDirect.setStorageBuffer("erosionMaskIn", buffers.mask);
    breachDirect.setStorageBuffer("breachedBits", buffers.heightB);
    breachDirect.setStorageBuffer("receivers", buffers.receivers);

    const breachPit = new ComputeShader(
      "terrain-page-erosion-breach-pit",
      engine,
      { computeSource: breachPitWgsl() },
      {
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          sourceHeight: { group: 0, binding: 1 },
          erosionMaskIn: { group: 0, binding: 2 },
          breachedBits: { group: 0, binding: 3 },
          receivers: { group: 0, binding: 4 },
        },
      },
    );
    breachPit.setStorageBuffer("params", buffers.params);
    breachPit.setStorageBuffer("sourceHeight", buffers.heightA);
    breachPit.setStorageBuffer("erosionMaskIn", buffers.mask);
    breachPit.setStorageBuffer("breachedBits", buffers.heightB);
    breachPit.setStorageBuffer("receivers", buffers.receivers);

    const decode = new ComputeShader(
      "terrain-page-erosion-decode",
      engine,
      { computeSource: decodeWgsl() },
      {
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          breachedBits: { group: 0, binding: 1 },
          heightOut: { group: 0, binding: 2 },
        },
      },
    );
    decode.setStorageBuffer("params", buffers.params);
    decode.setStorageBuffer("breachedBits", buffers.heightB);
    decode.setStorageBuffer("heightOut", buffers.heightA);

    // W-1a's proven operators, page config injected (coefficient 0.018).
    const spConfig = {
      streamPowerIterations: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerIterations,
      streamPowerCoefficient: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerCoefficient,
      streamPowerAreaExponent: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerAreaExponent,
      streamPowerTimeStep: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerTimeStep,
      talusIterations: TERRAIN_EROSION_PRODUCTION_CONFIG.talusIterations,
      talusTransferFraction: TERRAIN_EROSION_PRODUCTION_CONFIG.talusTransferFraction,
    };
    const streamPowerSource = streamPowerWgsl(spConfig);
    const gatherSource = talusGatherWgsl(spConfig);

    const streamPowerShader = (name: string): ComputeShader =>
      new ComputeShader(name, engine, { computeSource: streamPowerSource }, {
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          heightIn: { group: 0, binding: 1 },
          receivers: { group: 0, binding: 2 },
          flowAccumulation: { group: 0, binding: 3 },
          erodibility: { group: 0, binding: 4 },
          erosionMask: { group: 0, binding: 5 },
          heightOut: { group: 0, binding: 6 },
        },
      });
    const streamPowerFromA = streamPowerShader("terrain-page-erosion-sp-a");
    const streamPowerFromB = streamPowerShader("terrain-page-erosion-sp-b");
    for (const [shader, input, output] of [
      [streamPowerFromA, buffers.heightA, buffers.heightB],
      [streamPowerFromB, buffers.heightB, buffers.heightA],
    ] as const) {
      shader.setStorageBuffer("params", buffers.macroParams);
      shader.setStorageBuffer("heightIn", input);
      shader.setStorageBuffer("receivers", buffers.receivers);
      shader.setStorageBuffer("flowAccumulation", buffers.flow);
      shader.setStorageBuffer("erodibility", buffers.erodibility);
      shader.setStorageBuffer("erosionMask", buffers.mask);
      shader.setStorageBuffer("heightOut", output);
    }

    const gatherShader = (name: string): ComputeShader =>
      new ComputeShader(name, engine, { computeSource: gatherSource }, {
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          heightIn: { group: 0, binding: 1 },
          reposeDegrees: { group: 0, binding: 2 },
          erosionMask: { group: 0, binding: 3 },
          delta: { group: 0, binding: 4 },
        },
      });
    const talusGatherFromA = gatherShader("terrain-page-erosion-talus-gather-a");
    const talusGatherFromB = gatherShader("terrain-page-erosion-talus-gather-b");
    for (const [shader, input] of [
      [talusGatherFromA, buffers.heightA],
      [talusGatherFromB, buffers.heightB],
    ] as const) {
      shader.setStorageBuffer("params", buffers.macroParams);
      shader.setStorageBuffer("heightIn", input);
      shader.setStorageBuffer("reposeDegrees", buffers.erodibility);
      shader.setStorageBuffer("erosionMask", buffers.mask);
      // Receivers are dead once stream power has run; the delta lives there.
      shader.setStorageBuffer("delta", buffers.receivers);
    }

    const applyShader = (name: string): ComputeShader =>
      new ComputeShader(name, engine, { computeSource: TALUS_APPLY_WGSL }, {
        bindingsMapping: {
          params: { group: 0, binding: 0 },
          heightIn: { group: 0, binding: 1 },
          delta: { group: 0, binding: 2 },
          heightOut: { group: 0, binding: 3 },
        },
      });
    const talusApplyAtoB = applyShader("terrain-page-erosion-talus-apply-ab");
    const talusApplyBtoA = applyShader("terrain-page-erosion-talus-apply-ba");
    for (const [shader, input, output] of [
      [talusApplyAtoB, buffers.heightA, buffers.heightB],
      [talusApplyBtoA, buffers.heightB, buffers.heightA],
    ] as const) {
      shader.setStorageBuffer("params", buffers.macroParams);
      shader.setStorageBuffer("heightIn", input);
      shader.setStorageBuffer("delta", buffers.receivers);
      shader.setStorageBuffer("heightOut", output);
    }

    const fineBandSource = fineBandWgsl();
    const fineBandShader = (name: string): ComputeShader =>
      new ComputeShader(name, engine, { computeSource: fineBandSource }, {
        bindingsMapping: {
          // (0, 15) is the DEAD height-kernel page binding — required to
          // compile the included kernel, pruned by Tint, never set.
          params: { group: 0, binding: 0 },
          upliftKernelPages: { group: 0, binding: 2 },
          heightIn: { group: 0, binding: 3 },
          flowAccumulation: { group: 0, binding: 4 },
          erosionMaskIn: { group: 0, binding: 5 },
          heightOut: { group: 0, binding: 6 },
        },
      });
    const fineBandAtoB = fineBandShader("terrain-page-erosion-fine-band-ab");
    const fineBandBtoA = fineBandShader("terrain-page-erosion-fine-band-ba");
    for (const [shader, input, output] of [
      [fineBandAtoB, buffers.heightA, buffers.heightB],
      [fineBandBtoA, buffers.heightB, buffers.heightA],
    ] as const) {
      shader.setStorageBuffer("params", buffers.params);
      shader.setStorageBuffer("upliftKernelPages", buffers.upliftPages);
      shader.setStorageBuffer("heightIn", input);
      shader.setStorageBuffer("flowAccumulation", buffers.flow);
      shader.setStorageBuffer("erosionMaskIn", buffers.mask);
      shader.setStorageBuffer("heightOut", output);
    }

    this.shaders = Object.freeze({
      seed,
      geologyErodibility,
      geologyRepose,
      breachDirect,
      breachPit,
      decode,
      streamPowerFromA,
      streamPowerFromB,
      talusGatherFromA,
      talusGatherFromB,
      talusApplyAtoB,
      talusApplyBtoA,
      fineBandAtoB,
      fineBandBtoA,
    });
    this.costTrackers = [
      { shader: seed, stage: "seed", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      {
        shader: geologyErodibility,
        stage: "geology",
        dispatchesSinceConsume: 0,
        lastSampleCount: -1,
      },
      { shader: geologyRepose, stage: "geology", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: breachDirect, stage: "breach", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: breachPit, stage: "breach", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: decode, stage: "decode", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      {
        shader: streamPowerFromA,
        stage: "streamPower",
        dispatchesSinceConsume: 0,
        lastSampleCount: -1,
      },
      {
        shader: streamPowerFromB,
        stage: "streamPower",
        dispatchesSinceConsume: 0,
        lastSampleCount: -1,
      },
      { shader: talusGatherFromA, stage: "talus", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: talusGatherFromB, stage: "talus", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: talusApplyAtoB, stage: "talus", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: talusApplyBtoA, stage: "talus", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: fineBandAtoB, stage: "fineBand", dispatchesSinceConsume: 0, lastSampleCount: -1 },
      { shader: fineBandBtoA, stage: "fineBand", dispatchesSinceConsume: 0, lastSampleCount: -1 },
    ];
    return this.shaders;
  }
}

/**
 * The season-invariant slot key (variant 0), rebuilt locally rather than
 * imported: TerrainPageAtlas imports THIS module at runtime, and a value
 * import back would close a live ESM cycle through a file that throws at
 * module evaluation.
 */
function invariantKeyOf(address: WorldPageAddress): TerrainSlotKey {
  return { page: createWorldPageKey(address), variant: 0 };
}

// Compile-time coherence: the stored slot edges the WGSL taps assume.
if (TERRAIN_HEIGHT_SLOT_EDGE !== WORLD_PAGE_HEIGHT_CORE + 2 * WORLD_PAGE_GUTTER) {
  throw new Error("Terrain erosion GPU producer height-slot geometry drifted");
}
if (TERRAIN_CHANNEL_SLOT_EDGE !== WORLD_PAGE_CHANNEL_CORE + 2 * WORLD_PAGE_GUTTER) {
  throw new Error("Terrain erosion GPU producer channel-slot geometry drifted");
}
