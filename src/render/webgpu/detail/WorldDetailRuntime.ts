import { prepareMaterialForClusteredLighting } from "../lighting/ClusteredLighting";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { createGuardedShadowDepthWrapper } from "@/src/render/webgpu/core/guardedShadowDepthWrapper";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  RENDERED_DENSITY_LAWS,
  renderedShareAtDistance,
  type RenderedDensityLaw,
} from "./renderedDensity";
import { DetailGenerationClient } from "./DetailGenerationClient";
import {
  DetailInstanceMaterialPlugin,
  type DetailSunShadowSnapshot,
} from "./DetailInstanceMaterialPlugin";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_STRIDE_BYTES,
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailPrototypeBoundKernel,
  type DetailBillboardFrameBounds,
  type DetailPrototypeBoundKernel,
  type DetailPrototypeBounds,
} from "./instanceFormat";
import { createFoliageAtlas, type FoliageAtlas } from "./FoliageAtlas";
import {
  createImpostorAtlas,
  DETAIL_CROWN_ALBEDO,
  impostorBakeFrame,
  impostorLayerIndex,
  IMPOSTOR_SPECIES,
  type ImpostorAtlas,
} from "./ImpostorAtlas";
import { seasonalWinterFraction, type WorldDefinition } from "@/src/world";
import {
  TERRAIN_READBACK_RING_CAPACITY,
  type TerrainMacroGrid,
  type TerrainPagePublication,
} from "@/src/workers/terrainAuthority";
import type {
  DetailRetainedCellDescriptor,
  DetailWorkerPresentationResult,
} from "@/src/workers/detailProtocol";
import type { TerrainAuxPagePublication } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "@/src/render/webgpu/world/pageGeometry";
import {
  buildClutterPrototype,
  buildCrownFringePrototype,
  buildGrassPatchPrototype,
  buildRockPrototype,
  buildShrubPrototype,
  buildTreePrototype,
  SHRUB_VARIANT_COUNTS,
  TREE_VARIANT_COUNTS,
  type PrototypeGeometry,
} from "./prototypeGeometry";
import { detailCellKey, generateDetailCell, GROUND_COVER_GRID } from "./generation";
import {
  canGenerateNextDetailCell,
  resolveDetailGenerationBudget,
  type DetailGenerationBudget,
} from "./generationBudget";
import {
  detailPresentationChunkCoordinates,
  type DetailPresentationChunkCoordinates,
} from "./spatialChunks";
import { treePrototypeSpecies, treeTrunkTint } from "./treePrototypeFamily";
import {
  buildPresentationChunk,
  detailCellMinimumDistanceMeters,
  detailFadeBandMemberships,
  detailTreeCanopyRankOrder,
  DETAIL_CULL_FADE_MARGIN_METERS,
  DETAIL_FADE_MARGIN_METERS,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  GROUND_COVER_EDGE_FADE_METERS,
  TREE_IMPOSTOR_PROTOTYPE_KEY,
  type DetailPresentationBuildCatalog,
  type DetailPresentationChunkStatistics,
} from "./presentationBuild";
import { groundCoverHandoffRadiusMeters } from "./groundCoverLaw";
import {
  airfieldStructureExclusions,
  type StructureExclusionBox,
} from "../airfield/StructureExclusion";
import {
  DEFAULT_DETAIL_CELL_SIZE_METERS,
  type DetailFloatingOrigin,
  type ClutterKind,
  type DetailLod,
  type GroundCoverArchetype,
  type DetailTerrainSampler,
  type GeneratedDetailCell,
  type RockVariant,
  type ShrubSpecies,
  type TreeSpecies,
  type WorldDetailObserver,
  type WorldDetailStatistics,
} from "./types";

export {
  detailCellMinimumDistanceMeters,
  detailTreeCanopyRankOrder as canopyRankOrder,
  groundCoverCandidateRange,
  DETAIL_CULL_FADE_MARGIN_METERS,
  DETAIL_FADE_MARGIN_METERS,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  GROUND_COVER_CANDIDATE_SPACING_METERS,
  GROUND_COVER_EDGE_FADE_METERS,
  GROUND_COVER_FULL_DENSITY_SHARE,
  TREE_IMPOSTOR_PROTOTYPE_KEY,
} from "./presentationBuild";
export type { GroundCoverCandidateRange } from "./presentationBuild";

/**
 * `7-4b` CAPTURE SCAFFOLD — move spherical-harmonic irradiance off the vertex
 * stage for every detail material.
 *
 * **This exists to buy ONE inter-stage slot, and that slot is the whole of
 * `7-4b`.** Babylon evaluates SH irradiance per-vertex by default, which costs
 * the `vEnvironmentIrradiance` varying. The detail material sits at EXACTLY the
 * device's fragment-input maximum — 15 `@location` plus `front_facing` is 16 of
 * 16 — and attaching a `ClusteredLightContainer` adds one more, so the pipeline
 * fails to create and the foliage stops drawing entirely. `forceIrradianceInFragment`
 * deletes that varying (`USESPHERICALINVERTEX = !useSHInFragment`), which is
 * exactly enough. MEASURED both ways: flag on plus container compiles and
 * renders; flag off plus container is 8 limits errors at 17/16.
 *
 * **The plugin's own varyings have no slack left and this is not the place to
 * look for it.** `DetailInstanceMaterialPlugin` already packs four values into
 * `detailAtlasData` to add no location, already excludes `detailFadeByte` from
 * the impostor path because it "cost the 16th input slot", and already forgoes
 * Babylon's CSM varyings on impostors in favour of a hand-packed receiver. The
 * remaining slack is all in BABYLON's varyings, and this flag takes one of them
 * through a supported public property rather than by forking its shadow
 * includes — which is the alternative, and which buys three slots at the price
 * of a fork.
 *
 * **MEASURED, and this is the reason the default is ON.** Two capture arms per
 * configuration, interleaved on one tree and one host, with same-arm controls:
 *
 *   shot                    control floor      effect (two pairings)
 *   grove-forest-2m         0.003% / 0.000%    2.231% / 2.228%
 *   night-moonlit           0.050% / 0.000%    0.372% / 0.380%
 *
 * — an effect about 700x the control floor at grove, reproducing across two
 * independent pairings to within 0.003 points.
 *
 * **The LOCATION of the change is what makes it a mechanism rather than a
 * magnitude.** At grove, 18.19% of pixels differ in the top band of the frame
 * and 0.00% in the bottom four: the change is confined to CANOPY and absent
 * from ground. Mean signed delta is +0.01 / -0.06, so it is a REDISTRIBUTION
 * and not a brightness shift — which is the signature of removing per-vertex
 * interpolation error, and is why this is the more correct rendering rather
 * than merely a different one. Max channel delta 21/255, invisible at 1x.
 *
 * **The COST is BOUNDED, NOT MEASURED, and the distinction is deliberate.**
 * The timing channel failed: `gpuPassMs.mainPass` swung 4.6x on byte-identical
 * geometry (see the note in `tests/perf/perf-capture.test.ts`), so its null
 * carries no information. The bound is arithmetic — roughly nine SH dot
 * products on the ~25% of pixels that are foliage, order 0.01 ms, against an
 * instrument resolving ~0.07 ms at best, so a null was EXPECTED either way.
 * **Do not restate this as "no measurable cost"**: that reads as a measurement
 * and there was not one.
 */
let detailIrradianceInFragment = true;

/**
 * Set BEFORE the renderer is created — it is read when each material is built.
 * Retained after the default flipped so the A/B remains reproducible: pass
 * `false` to capture the pre-`7-4b` arm.
 */
export function setDetailIrradianceInFragmentForCapture(enabled: boolean): void {
  detailIrradianceInFragment = enabled;
}

/**
 * The GPU side of one batch: ONE interleaved 32-byte-stride buffer plus the
 * five typed instanced views onto it. Held across rebuilds — see
 * `uploadBatch`.
 */
interface DetailInstanceGpuBuffers {
  readonly shared: Buffer;
  capacityBytes: number;
}

interface DetailBatch {
  readonly mesh: Mesh;
  readonly castsShadows: boolean;
  readonly prototypeKey: string;
  readonly chunkKey: string;
  /** 2-11a: packed 32-byte records built during generation. */
  writer: DetailInstanceWriter;
  bounds: DetailInstanceBounds;
  readonly prototypeBoundKernel: DetailPrototypeBoundKernel;
  /**
   * Perf-debt pass: the batch's GPU allocation, reused across rebuilds.
   * Null until the first non-empty upload.
   */
  gpu: DetailInstanceGpuBuffers | null;
  /** Chunk revision whose records the writer currently holds. */
  filledRevision: number;
  /** Floating origin encoded into the currently uploaded instance records. */
  builtOrigin: { x: number; y: number; z: number };
}

interface RetiredDetailBatch {
  readonly batch: DetailBatch;
  readonly disposeAfterUpdate: number;
}

/**
 * A released allocation, RECYCLED rather than destroyed. **Nothing is ever
 * destroyed while the runtime is live.**
 *
 * Measured on-adapter, and the measurement is the reason this is a pool and
 * not a grace window. Destroying a vertex buffer that a submitted command
 * buffer still references is a validation error, and WebGPU rejects the
 * WHOLE submit — the symptom is a black frame at a suspiciously high frame
 * rate, not a missing tree. A four-update grace window produced it
 * immediately; a six-hundred-update one (ten seconds) still produced it,
 * with the diagnostic confirming that NO live mesh held the buffer at
 * eviction time. Whatever retains it inside Babylon 9.21.2's WebGPU backend
 * outlives any window worth waiting, so the runtime stops guessing: released
 * allocations go into a pool and are handed to the next batch that fits.
 *
 * Overwriting a pooled buffer is never an error — `writeBuffer` is ordered
 * on the queue after the previous submit — so reuse only has to outlast the
 * previous owner's last DRAW, which the reuse window covers.
 *
 * Memory is bounded by construction: reuse drains the pool, so live +
 * pooled bytes never exceed the peak working set, which is exactly the
 * `detailInstanceBudget` row `PerformanceBudget.ts` already books. The
 * runtime's statistics publish the pooled byte count so it is visible.
 */
interface PooledInstanceBuffers {
  readonly gpu: DetailInstanceGpuBuffers;
  /** Earliest update at which the previous owner's draws have certainly retired. */
  readonly reusableAfterUpdate: number;
}

interface DetailPrototype {
  readonly mesh: Mesh;
  readonly material: PBRMaterial;
  readonly castsShadows: boolean;
  readonly boundKernel: DetailPrototypeBoundKernel;
}

type DetailChunkStatistics = DetailPresentationChunkStatistics;
type MutableDetailChunkStatistics = {
  -readonly [Key in keyof DetailChunkStatistics]: DetailChunkStatistics[Key];
};

interface DetailPresentationChunk {
  readonly coordinates: DetailPresentationChunkCoordinates;
  readonly batchKeys: Set<string>;
  signature: string;
  revision: number;
  statistics: DetailChunkStatistics;
  /** Observer snapshot that authored range memberships and ground cover. */
  observerX: number;
  observerZ: number;
  observerSensitive: boolean;
  /**
   * Fail-closed BACKSTOP only: stale bytes stay allocated but cannot be
   * submitted. Streaming fix-pack: a chunk whose baked observer merely
   * drifted past the membership slack stays VISIBLE while its replacement
   * builds — stale-but-visible beats invisible; the fragment band windows
   * compute fades from the live camera, so staleness only means
   * slightly-off band memberships. Suppression engages only beyond the
   * pathological `DETAIL_SUPPRESSION_BACKSTOP_METERS` envelope.
   */
  validitySuppressed: boolean;
  /** Diagnostic latch: drifted past the slack but deliberately kept live. */
  staleVisible: boolean;
}

/** CPU-only batch assembled while the previously published chunk stays live. */
interface StagedDetailBatch {
  readonly prototypeKey: string;
  readonly writer: DetailInstanceWriter;
  readonly bounds: DetailInstanceBounds;
  readonly prototypeBoundKernel: DetailPrototypeBoundKernel;
}

interface PooledDetailBuildStorage {
  readonly writer: DetailInstanceWriter;
  readonly bounds: DetailInstanceBounds;
}

interface DetailChunkBuildTarget {
  readonly coordinates: DetailPresentationChunkCoordinates;
  readonly residents: readonly ResidentCell[];
  readonly signature: string;
  readonly configurationSignature: string;
  readonly observerSensitive: boolean;
  readonly buildSource: "inline" | "worker" | "blocked";
}

interface PendingDetailChunkBuildBase {
  readonly coordinates: DetailPresentationChunkCoordinates;
  readonly signature: string;
  readonly configurationSignature: string;
  readonly recordOrigin: DetailFloatingOrigin;
  readonly observerX: number;
  readonly observerZ: number;
  readonly observerSensitive: boolean;
  readonly stagedBatches: Map<string, StagedDetailBatch>;
}

interface PendingInlineDetailChunkBuild extends PendingDetailChunkBuildBase {
  readonly source: "inline";
  readonly iterator: Generator<void, DetailChunkStatistics, void>;
}

interface PendingWorkerDetailChunkBuild extends PendingDetailChunkBuildBase {
  readonly source: "worker";
  readonly residentTokens: readonly number[];
  readonly residentLods: readonly DetailLod[];
  buildId: number;
  queuedResult: DetailWorkerPresentationResult | null;
  queuedError: Error | null;
}

type PendingDetailChunkBuild =
  | PendingInlineDetailChunkBuild
  | PendingWorkerDetailChunkBuild;

/**
 * One batch of a completed build on its way to the GPU (streaming fix-pack).
 *
 * `fits`: the live batch's pooled allocation already holds enough capacity —
 * the new bytes are written IN PLACE at the flip (one queue-ordered
 * `writeBuffer`, no rebind, no `resetDrawCache`), which is atomic with the
 * flip frame's submit.
 *
 * `create`/`grow`: a brand-new DISABLED mesh is cloned, bound to a
 * pooled-or-new allocation and `resetDrawCache`d while it has never
 * rendered (the 4.5-0-safe window), then its bytes stream in under the
 * per-update byte budget. The flip enables it; for `grow` the outgrown
 * live batch retires through the ordinary grace/pool path.
 */
interface StagedDetailBatchUpload {
  readonly batchKey: string;
  readonly prototypeKey: string;
  readonly writer: DetailInstanceWriter;
  readonly bounds: DetailInstanceBounds;
  /** The writer's exact packed byte range, captured once at staging. */
  readonly packed: Uint8Array;
  readonly kind: "fits" | "create" | "grow";
  /** The disabled staged batch for `create`/`grow`; null until structural work runs. */
  stagedBatch: DetailBatch | null;
  structuralDone: boolean;
  streamedBytes: number;
}

/**
 * A completed chunk build being published across frames (streaming
 * fix-pack, defect D). Structural work (mesh clone + buffer bind +
 * `resetDrawCache`, all on DISABLED never-rendered meshes) is capped per
 * update; byte uploads into those disabled buffers stream under a per-update
 * budget; then ONE cheap atomic flip enables the staged meshes, performs the
 * in-place `fits` writes, swaps the live batch set and updates counts and
 * bounds. The old batches stay visible until the flip, so a chunk is never
 * half-published and never invisible while publication is in progress.
 *
 * DESIGN CHOICE (recorded per the fix-pack): the runtime updates ONE live
 * mesh per batchKey in place, so staging uses per-batch replacement meshes
 * ONLY where a rebind would otherwise be forced (new batch keys and grown
 * allocations — the clone+resetDrawCache-bearing cases the 18-22 ms
 * publication frames were made of), and defers the in-place `writeBuffer`
 * for same-capacity batches to the flip frame. A whole-replacement-mesh
 * design was rejected because it reintroduces the per-publication
 * clone+`makeGeometryUnique` churn the perf-debt pass measured and removed;
 * an instance-buffer swap-on-flip design was rejected because swapping a
 * live mesh's vertex buffers requires `resetDrawCache` on a rendered mesh —
 * the exact same-frame pipeline/bind-group rebuild (and 4.5-0 hazard) this
 * split exists to avoid. Outgrown and retired allocations always return to
 * the recycle pool after the grace margin; nothing is destroyed in flight.
 */
interface PendingDetailPublication {
  readonly coordinates: DetailPresentationChunkCoordinates;
  readonly signature: string;
  readonly configurationSignature: string;
  readonly recordOrigin: DetailFloatingOrigin;
  readonly observerX: number;
  readonly observerZ: number;
  readonly observerSensitive: boolean;
  readonly source: "inline" | "worker";
  readonly statistics: DetailChunkStatistics;
  readonly uploads: StagedDetailBatchUpload[];
}

export interface DetailPresentationRebuildBudget {
  /**
   * Deterministic hard cap. One unit is a resident, an accepted/expensive
   * candidate, or one bounded block of cheap rank rejects.
   */
  readonly maximumWorkUnits: number;
  /** Wall-time cap, sampled at a bounded interval to avoid a clock call per stem. */
  readonly maximumMilliseconds: number;
}

export interface DetailPresentationRebuildDiagnostics {
  readonly activeChunkKey: string | null;
  readonly activeBuildSource: "inline" | "worker" | null;
  readonly workUnitsLastUpdate: number;
  readonly millisecondsLastUpdate: number;
  readonly stagedRecords: number;
  readonly pooledCpuBatchStorage: number;
  readonly cancellations: number;
  readonly publications: number;
  readonly backloggedChunks: number;
  readonly suppressedChunks: number;
  readonly validityEnvelopeMeters: number;
  readonly pendingObserverDriftMeters: number | null;
  readonly maximumLiveObserverDriftMeters: number;
  readonly lastPublicationObserverDriftMeters: number;
  /** Lifetime totals; capture snapshots deltas, so no per-frame array grows. */
  readonly buildStarts: number;
  readonly buildSlices: number;
  readonly completedSlices: number;
  readonly timeBudgetStops: number;
  readonly workBudgetStops: number;
  readonly workUnitsTotal: number;
  readonly publishedRecords: number;
  readonly observerQuantumChanges: number;
  readonly observerSensitiveBuildStarts: number;
  readonly residentCellsInSensitiveBuilds: number;
  readonly workerRetainedCells: number;
  readonly workerBuildStarts: number;
  readonly workerResultsQueued: number;
  readonly workerBuildPublications: number;
  readonly workerBuildRejections: number;
  readonly workerBuildTimeouts: number;
  readonly workerGenerationTimeouts: number;
  readonly workerFallbacks: number;
}

interface DesiredCell {
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly distance: number;
  readonly lod: DetailLod;
  readonly priority: number;
}

interface ResidentCellBase {
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly cellSizeMeters: number;
  /** Generation-input epoch; a different value means its seasonal appearance is stale. */
  readonly generation: number;
  /** Changes whenever the same cell key receives new generated content. */
  readonly revision: number;
  /** Current presentation LOD/distance, refreshed from the desired-cell plan. */
  lod: DetailLod;
  distance: number;
  /**
   * Streaming fix-pack (defect B): a terrain L0 page publication marks
   * overlapping residents stale instead of deleting them. The stale record
   * keeps protecting the live published chunk (the epoch pattern — a page
   * arrival cannot punch a forest-sized hole) while the ordinary bounded
   * generator regenerates the cell and replaces it in place.
   */
  invalidated: boolean;
}

interface InlineResidentCell extends ResidentCellBase {
  readonly source: "inline";
  readonly cell: GeneratedDetailCell;
  /** Canopy rank of each stem in `cell.trees`, in [0, 1). */
  readonly treeCanopyRank: Float32Array;
}

interface WorkerResidentCell extends ResidentCellBase {
  readonly source: "worker";
  readonly descriptor: DetailRetainedCellDescriptor;
  /** False after release; the descriptor may remain only to protect old GPU chunks. */
  tokenOwned: boolean;
}

type ResidentCell = InlineResidentCell | WorkerResidentCell;

/**
 * Rendered-share thinning selects THE CANOPY, not a random sample of the
 * forest (perf-debt pass).
 *
 * The ecological field authors closed forest across every age class —
 * measured mean crown radius 3.5 m, median 3.3 m, **p10 1.8 m, p90 5.6 m**:
 * mostly saplings, as a real stand is.
 *
 * **The p-value was mislabelled and the label mattered.** This read
 * "p90 1.78 m" from 2026-08-19 until it was re-measured: a 90th percentile
 * BELOW the median is arithmetically impossible, so the three numbers never
 * described one sample. **1.78 was the tenth percentile.** Re-measured
 * through the shipping generator (`scripts/crown-radius-distribution.mts`,
 * `generateDetailCell` over 105-419 ha of closed forest): p10 1.80-1.91,
 * p90 5.53-5.92, mean 3.47-3.71, median 3.21-3.42.
 *
 * **Quantiles are density-independent and the ranges above are why.** Crown
 * radius is a per-tree draw, so sweeping `densityMultiplier` over 1.7x
 * (160-279 stems/ha) moves p10 by 0.02 m and p90 by 0.26 m. The spread is
 * fixture, not uncertainty about the distribution.
 *
 * **The stems/ha figure is NOT reproduced and is left unstated rather than
 * repeated.** The original said ~400/ha; this fixture plateaus near 290/ha
 * and moisture does not move it. That may be drift since August or a
 * condition not recorded at the time — either way it is the kind of number
 * that should not be restated without a measurement behind it. The
 * conclusion below does not rest on it. Thinning that to the law's ~70
 * rendered stems/ha by a UNIFORM key keeps saplings and dominants in equal
 * proportion, and the drawn stand's crown cover comes out at 0.26 against
 * Gate 2C's 0.55 criterion — the criterion was never automated, so this went
 * unseen through the whole of Phase 2. Ranking by crown radius instead draws
 * the 70/ha widest crowns (measured mean radius 5.80 m, cover 0.53-0.56),
 * which is exactly the "60-80 stems/ha with 6-7 m crowns" the law's own
 * comment was priced against, and it is what a canopy IS: from the air you
 * see the dominant stems, not the understory beneath them.
 *
 * The key keeps every property D-2 requires of `selection`: deterministic,
 * uniform on [0, 1) by construction (it is a rank quotient), and NESTING —
 * raising the share only ever adds stems, so a band boundary can never make
 * a tree disappear and reappear. `selection` itself is untouched and stays
 * the appearance hash (character modifier, lean, geometry variant, view
 * phase), so nothing about how a drawn tree LOOKS moves with this.
 */
export interface WorldDetailRuntimeOptions {
  readonly worldSeed: string | number;
  readonly terrainSample: DetailTerrainSampler;
  readonly cellSizeMeters?: number;
  /** Sea level anchoring the density field's shoreline/treeline (1B-7). */
  readonly seaLevelMeters?: number;
  /** 2-13a: world latitude for the seasonal kernel. Default 45°N. */
  readonly latitudeDegrees?: number;
  /**
   * Enables off-main-thread generation (1B-10): the worker rebuilds the same
   * world from this seed and streams cells back. Omit it (tests, headless
   * tools) and generation stays inline and synchronous.
   */
  readonly workerWorldSeed?: string | number;
  /** Full live world preserves explicit evolution mode and authored airports in the worker. */
  readonly workerWorld?: Readonly<WorldDefinition>;
  /** Injectable worker transport for deterministic runtime integration tests. */
  readonly detailWorkerFactory?: () => Worker;
  /**
   * CPU presentation synthesis slice. Primarily a deterministic test seam;
   * production uses the measured defaults below.
   */
  readonly presentationRebuildBudget?: DetailPresentationRebuildBudget;
  /** Injectable monotonic clock for the presentation-budget contract. */
  readonly presentationNowMilliseconds?: () => number;
}

/**
 * Updates a released instance allocation must sit before another batch may
 * write into it — long enough for the previous owner's last submitted draw
 * to have retired, at ~60 Hz.
 */
export const DETAIL_INSTANCE_BUFFER_REUSE_GRACE_UPDATES = 8;

/**
 * 2-17 close: one chunk is rebuilt at a time, now across bounded update
 * slices. The sweep takes proportionally longer to converge, which the
 * membership slack absorbs. Ground-cover work is counted per candidate after
 * `groundCoverCandidateRange` bounds the scan; cheap canopy-rank misses are
 * charged in fixed blocks so their rejection scan remains bounded without
 * consuming the same budget as multi-band record synthesis.
 */
export const DETAIL_PRESENTATION_REBUILD_MAX_WORK_UNITS_PER_UPDATE = 65_536;
export const DETAIL_PRESENTATION_REBUILD_MAX_MILLISECONDS_PER_UPDATE = 3;
const DETAIL_PRESENTATION_REBUILD_CLOCK_INTERVAL_UNITS = 64;
/** Must remain below the validity envelope used by the membership masks. */
export const DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS = 64;
/**
 * Streaming fix-pack (defect A): the fail-closed suppression BACKSTOP. A
 * chunk whose baked observer drifts past the 96 m membership slack stays
 * visible (stale-but-visible beats invisible — the shader band windows read
 * the live camera, so staleness is only slightly-off band memberships);
 * only past this pathological envelope is the whole chunk hidden.
 */
export const DETAIL_SUPPRESSION_BACKSTOP_METERS = 768;
/**
 * Streaming fix-pack (defect D): per-update byte budget for streaming packed
 * instance records into DISABLED staged buffers ahead of a publication flip.
 */
export const DETAIL_PUBLICATION_STREAM_BYTES_PER_UPDATE = 262_144;
/**
 * Streaming fix-pack (defect D): at most this many clone+resetDrawCache-
 * bearing staged mesh creations per update — the structural work that made
 * unbudgeted publication frames cost 18-22 ms.
 */
export const DETAIL_PUBLICATION_STRUCTURAL_CREATIONS_PER_UPDATE = 1;
/**
 * Streaming fix-pack (defect C): a newly created batch mesh reveals its
 * instances stochastically over this window after its first flip, so a fresh
 * chunk inside the cull-fade radius grows in rather than popping at full
 * density. Re-publication of an existing mesh never restarts the ramp.
 */
export const DETAIL_REVEAL_RAMP_SECONDS = 0.7;
/** Update-count fallback for the reveal clock (~0.7 s at 60 Hz), so a stalled simulation clock cannot pin a chunk invisible. */
const DETAIL_REVEAL_RAMP_UPDATES = 42;
/**
 * Streaming fix-pack (defect C): look-ahead distance cap. 2,400 m keeps
 * high-speed residency requests landing beyond the 3,000 m − 420 m cull-fade
 * start, so newly resident cells appear through the existing range dither.
 */
const DETAIL_LOOK_AHEAD_DISTANCE_METERS = 2_400;

/**
 * How far a cell's rendered tree share may drift before its distance is
 * refreshed — expressed in SHARE, not in metres, and that is the whole point.
 *
 * A metre threshold spends its refreshes where they cannot be seen: past
 * `farFloorShare` the share is constant, so a distant cell can move hundreds of
 * metres and change nothing. **Bounding the share instead makes the check
 * self-throttling in the right direction** — silent for the many far cells,
 * responsive for the few near ones where a step is visible.
 *
 * 0.02 caps a single step at 2% of the near cap. The defect this replaces
 * stepped **7.33x at tier 1 and 11.07x at tier 0**.
 */
const DETAIL_DENSITY_SHARE_REFRESH_EPSILON = 0.02;
/** Authority-level deadline; cancellation/reissue deliberately does not reset it. */
export const DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES = 240;
/** Low-frame-rate watchdog companion; update-count remains the deterministic authority. */
export const DETAIL_PRESENTATION_WORKER_MAX_PENDING_MILLISECONDS = 8_000;
/** Retained-cell authority must make accepted-cell progress inside the same envelope. */
export const DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES = 240;
export const DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_MILLISECONDS = 8_000;

const TREE_SPECIES: readonly TreeSpecies[] = [
  "pine",
  "cedar",
  "spruce",
  "oak",
  "maple",
  "birch",
  "willow",
];
const SHRUB_SPECIES: readonly ShrubSpecies[] = ["juniper", "hazel", "sage"];
const ROCK_VARIANTS: readonly RockVariant[] = ["granite", "limestone", "dark"];

const ZERO_STATISTICS: WorldDetailStatistics = Object.freeze({
  residentCells: 0,
  nearCells: 0,
  midCells: 0,
  generatedCells: 0,
  treeInstances: 0,
  shrubInstances: 0,
  rockInstances: 0,
  clutterInstances: 0,
  groundCoverInstances: 0,
  renderedThinInstances: 0,
  activeBatches: 0,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

/** Saturating diagnostic counter: bounded storage even in a days-long session. */
function addDiagnosticCount(current: number, increment = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function profileCellBudget(profile: WebGpuQualityProfile): number {
  if (profile.vegetationDistance <= 2_500 || profile.vegetationDensity <= 0.5) return 128;
  if (profile.vegetationDistance <= 5_000 || profile.vegetationDensity <= 0.8) return 384;
  return 896;
}

/**
 * Paged natural/settlement detail built entirely from Babylon meshes and thin
 * instances. Generation is incremental; normal per-frame updates become no-ops
 * until the observer crosses a paging/LOD boundary or the floating origin moves.
 */
export class WorldDetailRuntime {
  private readonly batches = new Map<string, DetailBatch>();
  private readonly retiredBatches: RetiredDetailBatch[] = [];
  private readonly instanceBufferPool: PooledInstanceBuffers[] = [];
  private readonly prototypes = new Map<string, DetailPrototype>();
  private readonly presentationChunks = new Map<string, DetailPresentationChunk>();
  /**
   * One detached CPU writer/bounds pair per prototype at most. A staged build
   * consumes it; commit returns the displaced live pair. This restores the
   * pre-staging growable-buffer reuse without sharing storage with live data.
   */
  private readonly detailBuildStoragePool = new Map<string, PooledDetailBuildStorage>();
  private readonly materials = new Set<PBRMaterial>();
  private readonly instancePlugins = new Set<DetailInstanceMaterialPlugin>();
  private readonly pluginByMaterial = new Map<PBRMaterial, DetailInstanceMaterialPlugin>();
  /**
   * Authored X/Z bound for every concrete prototype batch. Instance records
   * divide their desired world radius by this exact value, including geometry
   * variant and LOD band; the shader applies the resulting multiplier once.
   */
  private readonly prototypeRadialUnits = new Map<string, number>();
  /**
   * Wave G: when the compute blade system is live (WebGPU), the presentation
   * build stops emitting grass-archetype card patches — blades carry that
   * archetype. Engine-static, so chunk signatures need no new term.
   */
  private readonly groundCoverBladesActive: boolean;
  /**
   * `6-9`: metres inside which the GPU field carries EVERY archetype, so the
   * card path skips them there. 0 whenever the field is inactive, which is
   * every CPU-only host — CI's hosted runner included.
   *
   * Refreshed from the profile rather than fixed at construction because it
   * is the tier's ground-cover law that decides it, and it joins both build
   * signatures so a tier change rebuilds the chunks the handoff moved.
   */
  private groundCoverFieldRadiusMeters = 0;
  /** Far impostors are baked from species variant 0 near geometry. */
  private readonly impostorRadialUnits = new Map<TreeSpecies, number>();
  /** Per-species shader frame for the one shared camera-facing impostor quad. */
  private readonly impostorFrames = new Map<TreeSpecies, DetailBillboardFrameBounds>();
  /** Cloneable metadata consumed by both inline synthesis and the worker-packing seam. */
  private readonly presentationBuildCatalog: DetailPresentationBuildCatalog;
  /** 2-12: the atlas (null under NullEngine — no raw 2D-array support). */
  private foliageAtlas: FoliageAtlas | null = null;
  /** 2-17: the impostor atlas (same NullEngine guard). */
  private impostorAtlas: ImpostorAtlas | null = null;
  /** 2-17 close: plugins whose tree bands use fragment-computed fades. */
  private readonly bandFadePlugins = new Set<DetailInstanceMaterialPlugin>();
  /** 2-17 close: law/grass radii last used, for frontier classification. */
  private lastDensityLaw: RenderedDensityLaw = RENDERED_DENSITY_LAWS[1]!;
  private lastGrassRadius = 150;
  private readonly cells = new Map<string, ResidentCell>();
  private desiredCells: readonly DesiredCell[] = [];
  private desiredKeys = new Set<string>();
  private signature = "";
  private density = Number.NaN;
  private cumulativeGeneratedCells = 0;
  private cellRevision = 0;
  private statisticsValue = ZERO_STATISTICS;
  private batchesDirty = true;
  /**
   * Exactly one CPU-only chunk build may exist. Keeping the queue singular
   * bounds staging memory and preserves the old one-chunk-at-a-time ordering.
   */
  private pendingPresentationBuild: PendingDetailChunkBuild | null = null;
  /**
   * At most one completed build being published across frames (defect D).
   * Serial with the build: no new build starts while a publication streams,
   * which bounds staged GPU memory to one chunk's working set.
   */
  private pendingPublication: PendingDetailPublication | null = null;
  /** Meshes whose reveal value is ramping 0 -> 1 after their first flip. */
  private readonly revealRamps = new Map<
    Mesh,
    { readonly startSeconds: number; readonly startUpdate: number }
  >();
  /** Capture-marker cumulative counters (constant-time integer increments). */
  private capturePublishedBytes = 0;
  private captureCreatedBatches = 0;
  private captureReboundBatches = 0;
  private captureRevealRampsStarted = 0;
  private captureSuppressedChunks = 0;
  private captureStaleVisibleChunks = 0;
  private readonly presentationRebuildBudget: DetailPresentationRebuildBudget;
  private readonly presentationNowMilliseconds: () => number;
  private presentationWorkUnitsLastUpdate = 0;
  private presentationMillisecondsLastUpdate = 0;
  private presentationBuildCancellations = 0;
  private presentationBuildPublications = 0;
  private presentationBacklogChunks = 0;
  private presentationBuildStarts = 0;
  private presentationBuildSlices = 0;
  private presentationCompletedSlices = 0;
  private presentationTimeBudgetStops = 0;
  private presentationWorkBudgetStops = 0;
  private presentationWorkUnitsTotal = 0;
  private presentationPublishedRecords = 0;
  private presentationObserverQuantumChanges = 0;
  private presentationObserverSensitiveBuildStarts = 0;
  private presentationResidentCellsInSensitiveBuilds = 0;
  private presentationWorkerBuildStarts = 0;
  private presentationWorkerResultsQueued = 0;
  private presentationWorkerBuildPublications = 0;
  private presentationWorkerBuildRejections = 0;
  private presentationWorkerBuildTimeouts = 0;
  private presentationWorkerGenerationTimeouts = 0;
  private presentationWorkerFallbacks = 0;
  /**
   * Worker-authority progress epochs. Request cancellation/reissue never
   * changes them; only accepted useful output (or no remaining demand) does.
   */
  private workerPresentationProgressUpdate: number | null = null;
  private workerPresentationProgressMilliseconds: number | null = null;
  private workerGenerationProgressUpdate: number | null = null;
  private workerGenerationProgressMilliseconds: number | null = null;
  private lastPublicationObserverDriftMeters = 0;
  private windTimeSeconds = 0;
  private updateSequence = 0;
  /** 2-14: observer position at the last rebuild, for per-stem fade radii. */
  private observerX = 0;
  private observerZ = 0;
  /** Forces frontier target evaluation at the same cadence its signatures promise. */
  private presentationObserverSignature = "";
  /** R-13: normalized environment-clock day forwarded to cell generation. */
  private dayOfYear = 0;

  /**
   * Airfield structures vegetation must not grow through, built ONCE from the
   * world this runtime was given. Uses `seedHash` — the terrain authority the
   * hangars' own siting reads — not the seed string's hash, which is a
   * different number on any guaranteed-airport world.
   */
  private readonly structureExclusions: readonly StructureExclusionBox[];
  /** Governor B lever 2 (1A-6b): tightens the per-frame generation slice. */
  private generationBudgetCap: DetailGenerationBudget | null = null;
  /** Null when generation is inline; the 1B-10 worker client otherwise. */
  private client: DetailGenerationClient | null = null;
  /** Mirrors the consumer authority's bounded L0 ring for aux-arrival gating. */
  private readonly terrainPageAddresses: string[] = [];
  /** Desired keys with a request in flight, mapped to their request ids. */
  private readonly pendingCells = new Map<string, number>();
  /** Bumped whenever generation inputs change; stale worker results are dropped. */
  private cellEpoch = 0;
  /** `4.5-C1`: the tier datum, refreshed from the profile every update. */
  private vegetationCastsShadows = true;
  private disposed = false;

  readonly cellSizeMeters: number;

  constructor(
    private readonly scene: Scene,
    private readonly options: WorldDetailRuntimeOptions,
  ) {
    this.groundCoverBladesActive =
      (scene.getEngine().getCaps() as { supportComputeShaders?: boolean })
        .supportComputeShaders === true;
    this.structureExclusions = options.workerWorld?.airport
      ? airfieldStructureExclusions(options.workerWorld.airport, options.workerWorld.seedHash)
      : [];
    this.cellSizeMeters = options.cellSizeMeters ?? DEFAULT_DETAIL_CELL_SIZE_METERS;
    if (
      !Number.isFinite(this.cellSizeMeters) ||
      this.cellSizeMeters < 64 ||
      this.cellSizeMeters > 4_096
    ) {
      throw new RangeError("Detail runtime cell size must be between 64 and 4096 metres");
    }
    const presentationRebuildBudget = options.presentationRebuildBudget ?? {
      maximumWorkUnits: DETAIL_PRESENTATION_REBUILD_MAX_WORK_UNITS_PER_UPDATE,
      maximumMilliseconds: DETAIL_PRESENTATION_REBUILD_MAX_MILLISECONDS_PER_UPDATE,
    };
    if (
      !Number.isSafeInteger(presentationRebuildBudget.maximumWorkUnits)
      || presentationRebuildBudget.maximumWorkUnits <= 0
    ) {
      throw new RangeError("Detail presentation maximumWorkUnits must be a positive integer");
    }
    if (
      !Number.isFinite(presentationRebuildBudget.maximumMilliseconds)
      || presentationRebuildBudget.maximumMilliseconds <= 0
    ) {
      throw new RangeError("Detail presentation maximumMilliseconds must be finite and positive");
    }
    this.presentationRebuildBudget = presentationRebuildBudget;
    this.presentationNowMilliseconds = options.presentationNowMilliseconds
      ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
    this.createBatches();
    this.presentationBuildCatalog = this.createPresentationBuildCatalog();
    if (options.workerWorldSeed !== undefined) {
      const client = new DetailGenerationClient(
        {
          worldSeed: options.workerWorldSeed,
          ...(options.workerWorld ? { world: options.workerWorld } : {}),
          cellSizeMeters: this.cellSizeMeters,
          seaLevelMeters: options.seaLevelMeters ?? 0,
          presentationCatalog: this.presentationBuildCatalog,
          ...(options.detailWorkerFactory
            ? { workerFactory: options.detailWorkerFactory }
            : {}),
        },
        () => this.handleWorkerUnavailable(),
      );
      // Construction can fail synchronously before assignment. Never retain
      // an unavailable client over the fallback state established above.
      this.client = client.isAvailable ? client : null;
    }
  }

  private handleWorkerUnavailable(): void {
    if (this.disposed) return;
    this.activateInlineWorkerFallback(false);
  }

  private activateInlineWorkerFallback(disposeClient: boolean): void {
    const client = this.client;
    this.client = null;
    if (this.pendingPresentationBuild?.source === "worker") {
      this.releaseStagedBuildStorage(this.pendingPresentationBuild);
      this.pendingPresentationBuild = null;
      this.presentationBuildCancellations = addDiagnosticCount(
        this.presentationBuildCancellations,
      );
    }
    if (disposeClient) client?.dispose();
    this.pendingCells.clear();
    // The failed client has terminated the worker and cleared its token set.
    // Keep descriptors only as topology placeholders so complete live chunks
    // remain submitted while desired cells regenerate incrementally inline.
    for (const resident of this.cells.values()) {
      if (resident.source === "worker") resident.tokenOwned = false;
    }
    this.presentationWorkerFallbacks = addDiagnosticCount(
      this.presentationWorkerFallbacks,
    );
    this.resetWorkerPresentationProgress();
    this.resetWorkerGenerationProgress();
    this.batchesDirty = true;
  }

  private beginWorkerPresentationProgress(): void {
    if (this.workerPresentationProgressUpdate !== null) return;
    this.workerPresentationProgressUpdate = this.updateSequence;
    this.workerPresentationProgressMilliseconds = this.presentationNowMilliseconds();
  }

  private resetWorkerPresentationProgress(): void {
    this.workerPresentationProgressUpdate = null;
    this.workerPresentationProgressMilliseconds = null;
  }

  private beginWorkerGenerationProgress(): void {
    if (this.workerGenerationProgressUpdate !== null) return;
    this.workerGenerationProgressUpdate = this.updateSequence;
    this.workerGenerationProgressMilliseconds = this.presentationNowMilliseconds();
  }

  /** An accepted, current descriptor is the only worker-generation progress signal. */
  private recordWorkerGenerationProgress(): void {
    this.workerGenerationProgressUpdate = this.updateSequence;
    this.workerGenerationProgressMilliseconds = this.presentationNowMilliseconds();
  }

  private resetWorkerGenerationProgress(): void {
    this.workerGenerationProgressUpdate = null;
    this.workerGenerationProgressMilliseconds = null;
  }

  private workerPresentationProgressExpired(): boolean {
    return this.workerPresentationProgressUpdate !== null
      && this.workerPresentationProgressMilliseconds !== null
      && (
        this.updateSequence - this.workerPresentationProgressUpdate
          >= DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES
        || Math.max(
          0,
          this.presentationNowMilliseconds() - this.workerPresentationProgressMilliseconds,
        ) >= DETAIL_PRESENTATION_WORKER_MAX_PENDING_MILLISECONDS
      );
  }

  private workerGenerationProgressExpired(): boolean {
    return this.workerGenerationProgressUpdate !== null
      && this.workerGenerationProgressMilliseconds !== null
      && (
        this.updateSequence - this.workerGenerationProgressUpdate
          >= DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES
        || Math.max(
          0,
          this.presentationNowMilliseconds() - this.workerGenerationProgressMilliseconds,
        ) >= DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_MILLISECONDS
      );
  }

  private failClosedWorkerAuthorityTimeout(
    authority: "presentation" | "generation",
  ): void {
    if (authority === "presentation") {
      if (this.pendingPresentationBuild?.source === "worker") {
        this.client?.cancelPresentation(this.pendingPresentationBuild.buildId);
      }
      this.presentationWorkerBuildRejections = addDiagnosticCount(
        this.presentationWorkerBuildRejections,
      );
      this.presentationWorkerBuildTimeouts = addDiagnosticCount(
        this.presentationWorkerBuildTimeouts,
      );
    } else {
      this.presentationWorkerGenerationTimeouts = addDiagnosticCount(
        this.presentationWorkerGenerationTimeouts,
      );
    }
    this.activateInlineWorkerFallback(true);
  }

  private residentIsCurrentAndAccessible(resident: ResidentCell | undefined): boolean {
    if (!resident || resident.invalidated || resident.generation !== this.cellEpoch) {
      return false;
    }
    return resident.source === "inline"
      || (resident.tokenOwned && this.client !== null);
  }

  private releaseResidentToken(resident: ResidentCell | undefined): void {
    if (resident?.source !== "worker" || !resident.tokenOwned) return;
    // A presentation command that references this token was posted before
    // any retirement discovered here. Worker message FIFO guarantees the
    // builder captures its cell reference before the following releaseCell.
    this.client?.releaseCell(resident.descriptor);
    resident.tokenOwned = false;
  }

  private releaseAllResidentTokens(): void {
    for (const resident of this.cells.values()) this.releaseResidentToken(resident);
  }

  private replaceResident(key: string, resident: ResidentCell): void {
    const previous = this.cells.get(key);
    if (previous !== resident) this.releaseResidentToken(previous);
    this.cells.set(key, resident);
  }

  /**
   * Governor B lever 2: cap the per-frame generation slice below the
   * profile's own budget. Null restores the profile default.
   */
  setGenerationBudgetCap(cap: DetailGenerationBudget | null): void {
    this.generationBudgetCap = cap;
  }

  /** Transfer the canonical macro fallback into the off-thread placement authority. */
  publishTerrainMacro(macro: TerrainMacroGrid): boolean {
    return this.client?.publishTerrainMacro(macro) ?? false;
  }

  /** Transfer one final L0 page into the off-thread placement authority. */
  publishTerrainPage(page: TerrainPagePublication): boolean {
    const published = this.client?.publishTerrainPage(page) ?? false;
    if (page.level !== 0) return published;

    const address = `${page.tileX}:${page.tileZ}`;
    const previousIndex = this.terrainPageAddresses.indexOf(address);
    if (previousIndex >= 0) this.terrainPageAddresses.splice(previousIndex, 1);
    this.terrainPageAddresses.push(address);
    if (this.terrainPageAddresses.length > TERRAIN_READBACK_RING_CAPACITY) {
      this.terrainPageAddresses.shift();
    }
    this.invalidateTerrainPage(page.tileX, page.tileZ);
    return published;
  }

  /**
   * Transfer one committed signed-shore page. An early aux-only arrival is
   * retained by the worker authority but cannot invalidate/cache a cell until
   * its matching final height page has arrived.
   */
  publishTerrainAuxPage(page: TerrainAuxPagePublication): boolean {
    const published = this.client?.publishTerrainAuxPage(page) ?? false;
    if (
      page.level === 0
      && this.terrainPageAddresses.includes(`${page.tileX}:${page.tileZ}`)
    ) {
      this.invalidateTerrainPage(page.tileX, page.tileZ);
    }
    return published;
  }

  private invalidateTerrainPage(tileX: number, tileZ: number): void {

    // Macro-authored cells are already evolved, but the final L0 page owns
    // local incision/detail and signed shoreline. Mark only overlapping
    // cells stale and cancel their in-flight requests so their next
    // generation uses the complete product.
    const minimumX = tileX * WORLD_PAGE_BASE_EXTENT_METERS;
    const minimumZ = tileZ * WORLD_PAGE_BASE_EXTENT_METERS;
    const maximumX = minimumX + WORLD_PAGE_BASE_EXTENT_METERS;
    const maximumZ = minimumZ + WORLD_PAGE_BASE_EXTENT_METERS;
    const overlapsPage = (cellX: number, cellZ: number): boolean => {
      const cellMinimumX = cellX * this.cellSizeMeters;
      const cellMinimumZ = cellZ * this.cellSizeMeters;
      return cellMinimumX < maximumX
        && cellMinimumX + this.cellSizeMeters > minimumX
        && cellMinimumZ < maximumZ
        && cellMinimumZ + this.cellSizeMeters > minimumZ;
    };
    let invalidated = false;
    for (const resident of this.cells.values()) {
      if (!overlapsPage(resident.cellX, resident.cellZ)) continue;
      if (resident.invalidated) continue;
      // Defect B fix — the epoch pattern (`setDayOfYear`), page-scoped:
      // release the worker token (exactly once; `replaceResident` and every
      // later release path no-op on `tokenOwned === false`) but KEEP the
      // stale record resident. The live published chunk keeps drawing the
      // old trees; `residentIsCurrentAndAccessible` reports the cell as
      // missing so the ordinary bounded generator regenerates it, and the
      // replacement swaps in via `replaceResident` with a new revision. The
      // old code deleted the record here, so the next chunk publication
      // omitted a 512 m block of trees for the whole regeneration latency.
      this.releaseResidentToken(resident);
      resident.invalidated = true;
      invalidated = true;
    }
    for (const desired of this.desiredCells) {
      if (!overlapsPage(desired.cellX, desired.cellZ)) continue;
      const requestId = this.pendingCells.get(desired.key);
      if (requestId === undefined) continue;
      this.client?.cancel(requestId);
      this.pendingCells.delete(desired.key);
      invalidated = true;
    }
    if (invalidated) this.batchesDirty = true;
  }

  /**
   * R-13: refreshes season-baked appearance without removing live detail.
   * Placement is season-invariant, but crown/shrub/ground-cover colour and
   * deciduous coverage are authored into each generated cell. Keeping those
   * cells forever made near/mid foliage retain the old season while the far
   * impostor changed immediately. A new epoch cancels stale work and lets the
   * ordinary bounded generator replace residents in place; old cells remain
   * visible until their replacement arrives, so a clock edit cannot punch a
   * forest-sized hole or create a one-frame generation spike.
   */
  setDayOfYear(dayOfYear: number): void {
    if (!Number.isFinite(dayOfYear)) throw new RangeError("Detail dayOfYear must be finite");
    const normalizedDay = ((dayOfYear % 365) + 365) % 365;
    if (normalizedDay !== this.dayOfYear) {
      this.releaseAllResidentTokens();
      this.dayOfYear = normalizedDay;
      this.cellEpoch += 1;
      this.pendingCells.clear();
      this.client?.cancelAll();
    }
    // 2-17a: the impostor buckets cross-fade on the same shed window as the
    // card dissolve (applyFoliageSeason's 0.34–0.7 winterFraction ramp).
    const winter = seasonalWinterFraction(normalizedDay, this.options.latitudeDegrees ?? 45);
    const t = Math.min(1, Math.max(0, (winter - 0.34) / 0.36));
    const mix = t * t * (3 - 2 * t);
    for (const plugin of this.instancePlugins) plugin.setImpostorSeason(mix);
  }

  /** Marks a material's plugin as tree-band shader-faded (2-17 close). */
  private registerBandFadeMaterial(material: PBRMaterial): void {
    const plugin = this.materialPlugin(material);
    if (!plugin) return;
    this.bandFadePlugins.add(plugin);
    // Placeholder radii until the first update supplies the profile's law.
    plugin.setBandFades(400, 1_400, 8_000);
  }

  /** 2-13: the frame's wind snapshot, forwarded to every instance plugin. */
  setWind(directionX: number, directionZ: number, strength: number, gust: number): void {
    for (const plugin of this.instancePlugins) {
      plugin.setWind(directionX, directionZ, strength, gust);
    }
  }

  /**
   * 2-12's translucency term (the recorded gap the perf-debt pass closes):
   * the frame's key light, forwarded from `AtmosphereSystem`'s snapshot on
   * exactly the wind field's pattern. Vegetation consumes the lighting
   * owner's published direction and radiance; it does not define a sun.
   */
  setKeyLight(
    directionX: number,
    directionY: number,
    directionZ: number,
    radiance: readonly [number, number, number],
    strength: number,
  ): void {
    for (const plugin of this.instancePlugins) {
      plugin.setKeyLight(directionX, directionY, directionZ, radiance, strength);
    }
  }

  /** Wave Q: forward the frame's CSM snapshot to the far-band receiver. */
  setSunShadow(snapshot: DetailSunShadowSnapshot | null): void {
    for (const plugin of this.instancePlugins) {
      plugin.setSunShadow(snapshot);
    }
  }

  /**
   * `6-11`: forward the terrain's global horizon field to the far-band
   * receiver, on the same snapshot pattern.
   *
   * One field for every plugin, because the field is world-anchored rather
   * than chunk-anchored — which is exactly the property that lets it reach a
   * material shared across presentation chunks at all.
   */
  setHorizonField(
    layerA: BaseTexture | null,
    layerB: BaseTexture | null,
    originX: number,
    originZ: number,
    spanMeters: number,
  ): void {
    for (const plugin of this.instancePlugins) {
      plugin.setHorizonField(layerA, layerB, originX, originZ, spanMeters);
    }
  }

  get statistics(): WorldDetailStatistics {
    return this.statisticsValue;
  }

  /** Instrumentation for the bounded CPU-only presentation builder. */
  get presentationRebuildDiagnostics(): DetailPresentationRebuildDiagnostics {
    let stagedRecords = 0;
    if (this.pendingPresentationBuild) {
      for (const batch of this.pendingPresentationBuild.stagedBatches.values()) {
        stagedRecords += batch.writer.count;
      }
    }
    const pendingObserverDriftMeters = this.pendingPresentationBuild
      && (
        this.pendingPresentationBuild.source === "worker"
        || this.pendingPresentationBuild.observerSensitive
      )
      ? Math.hypot(
          this.observerX - this.pendingPresentationBuild.observerX,
          this.observerZ - this.pendingPresentationBuild.observerZ,
        )
      : null;
    let maximumLiveObserverDriftMeters = 0;
    let suppressedChunks = 0;
    for (const chunk of this.presentationChunks.values()) {
      if (chunk.validitySuppressed) suppressedChunks += 1;
      if (
        chunk.revision === 0
        || !chunk.observerSensitive
        || chunk.validitySuppressed
      ) continue;
      maximumLiveObserverDriftMeters = Math.max(
        maximumLiveObserverDriftMeters,
        Math.hypot(this.observerX - chunk.observerX, this.observerZ - chunk.observerZ),
      );
    }
    let workerRetainedCells = 0;
    for (const resident of this.cells.values()) {
      if (resident.source === "worker" && resident.tokenOwned) workerRetainedCells += 1;
    }
    return {
      activeChunkKey: this.pendingPresentationBuild?.coordinates.key ?? null,
      activeBuildSource: this.pendingPresentationBuild?.source ?? null,
      workUnitsLastUpdate: this.presentationWorkUnitsLastUpdate,
      millisecondsLastUpdate: this.presentationMillisecondsLastUpdate,
      stagedRecords,
      pooledCpuBatchStorage: this.detailBuildStoragePool.size,
      cancellations: this.presentationBuildCancellations,
      publications: this.presentationBuildPublications,
      backloggedChunks: this.presentationBacklogChunks,
      suppressedChunks,
      validityEnvelopeMeters: DETAIL_MEMBERSHIP_SLACK_METERS,
      pendingObserverDriftMeters,
      maximumLiveObserverDriftMeters,
      lastPublicationObserverDriftMeters: this.lastPublicationObserverDriftMeters,
      buildStarts: this.presentationBuildStarts,
      buildSlices: this.presentationBuildSlices,
      completedSlices: this.presentationCompletedSlices,
      timeBudgetStops: this.presentationTimeBudgetStops,
      workBudgetStops: this.presentationWorkBudgetStops,
      workUnitsTotal: this.presentationWorkUnitsTotal,
      publishedRecords: this.presentationPublishedRecords,
      observerQuantumChanges: this.presentationObserverQuantumChanges,
      observerSensitiveBuildStarts: this.presentationObserverSensitiveBuildStarts,
      residentCellsInSensitiveBuilds: this.presentationResidentCellsInSensitiveBuilds,
      workerRetainedCells,
      workerBuildStarts: this.presentationWorkerBuildStarts,
      workerResultsQueued: this.presentationWorkerResultsQueued,
      workerBuildPublications: this.presentationWorkerBuildPublications,
      workerBuildRejections: this.presentationWorkerBuildRejections,
      workerBuildTimeouts: this.presentationWorkerBuildTimeouts,
      workerGenerationTimeouts: this.presentationWorkerGenerationTimeouts,
      workerFallbacks: this.presentationWorkerFallbacks,
    };
  }

  /**
   * Capture-only constant-time marker for correlating asynchronous worker
   * delivery and synchronous publication with frame intervals. Keep this
   * separate from the full diagnostic snapshot, which intentionally walks
   * resident/chunk state and would perturb the timing loop if sampled every
   * frame.
   */
  get presentationCaptureMarker(): Readonly<{
    workerResultsQueued: number;
    publications: number;
    publishedBytes: number;
    createdBatches: number;
    reboundBatches: number;
    revealRampsStarted: number;
    suppressedChunks: number;
    staleVisibleChunks: number;
  }> {
    return {
      workerResultsQueued: this.presentationWorkerResultsQueued,
      publications: this.presentationBuildPublications,
      // Streaming fix-pack (defect E): cumulative counters, all bumped by
      // constant-time integer increments on the paths they measure.
      publishedBytes: this.capturePublishedBytes,
      createdBatches: this.captureCreatedBatches,
      reboundBatches: this.captureReboundBatches,
      revealRampsStarted: this.captureRevealRampsStarted,
      suppressedChunks: this.captureSuppressedChunks,
      staleVisibleChunks: this.captureStaleVisibleChunks,
    };
  }

  /**
   * Generation plus presentation work that can still change a rendered shot.
   * Capture settling consumes this instead of mistaking a temporarily stable
   * instance count for a complete world.
   */
  get pendingWorkItems(): number {
    let missingCells = 0;
    for (const desired of this.desiredCells) {
      if (!this.residentIsCurrentAndAccessible(this.cells.get(desired.key))) missingCells += 1;
    }
    const presentationWork = this.batchesDirty
      || this.pendingPresentationBuild !== null
      || this.pendingPublication !== null
      ? Math.max(1, this.presentationBacklogChunks)
      : 0;
    return missingCells + presentationWork;
  }

  update(
    observer: WorldDetailObserver,
    floatingOrigin: DetailFloatingOrigin,
    profile: WebGpuQualityProfile,
    simulationTimeSeconds?: number,
  ): void {
    if (this.disposed) return;
    this.updateSequence += 1;
    this.vegetationCastsShadows = profile.vegetationCastsShadows;
    this.disposeExpiredBatches();
    // Wind phase rides the caller's SIMULATION clock when provided (Z-1):
    // a wall-clock accumulator made every tree's sway phase depend on how
    // long streaming took on that particular run — the perf capture pins
    // simulationTime exactly so reruns are pixel-comparable, and the sway
    // must be a function of it. The wall-clock fallback serves callers with
    // no simulation clock (dev harnesses).
    if (simulationTimeSeconds !== undefined && Number.isFinite(simulationTimeSeconds)) {
      this.windTimeSeconds = Math.max(0, simulationTimeSeconds);
      for (const plugin of this.instancePlugins) plugin.setTimeSeconds(this.windTimeSeconds);
    } else {
      const deltaMilliseconds = this.scene.getEngine().getDeltaTime();
      if (Number.isFinite(deltaMilliseconds)) {
        this.windTimeSeconds += clamp(deltaMilliseconds, 0, 100) / 1_000;
        for (const plugin of this.instancePlugins) plugin.setTimeSeconds(this.windTimeSeconds);
      }
    }
    this.advanceRevealRamps();
    requireFinite(observer.x, "Detail observer x");
    requireFinite(observer.y, "Detail observer y");
    requireFinite(observer.z, "Detail observer z");
    const velocityX = requireFinite(observer.velocityX ?? 0, "Detail observer x velocity");
    const velocityZ = requireFinite(observer.velocityZ ?? 0, "Detail observer z velocity");
    requireFinite(floatingOrigin.x, "Detail floating-origin x");
    requireFinite(floatingOrigin.y, "Detail floating-origin y");
    requireFinite(floatingOrigin.z, "Detail floating-origin z");
    // 67d: origin changes are corrected for every live batch immediately.
    // The amortized rebuild may still rewrite only one chunk this update;
    // stale records remain valid because their mesh carries the uniform
    // built-origin -> current-origin translation in the meantime.
    this.compensateBatchOrigins(floatingOrigin);
    // Fix-pack F1: the crown cluster field samples world space through this
    // offset — without it the shading pattern popped on every origin rebase.
    for (const plugin of this.instancePlugins) {
      plugin.setWorldOrigin(floatingOrigin.x, floatingOrigin.z);
    }
    if (!Number.isFinite(profile.vegetationDistance) || profile.vegetationDistance <= 0) {
      throw new RangeError("Vegetation distance must be finite and greater than zero");
    }
    if (
      !Number.isFinite(profile.vegetationDensity) ||
      profile.vegetationDensity < 0 ||
      profile.vegetationDensity > 2
    ) {
      throw new RangeError("Vegetation density must be between zero and two");
    }

    // `chunkObserverTerm` promises a 64 m frontier cadence. The old global
    // paging signature only changed every half-cell (256 m in production),
    // so the term was never evaluated at its documented cadence and a live
    // snapshot could outrun its 96 m membership envelope while appearing
    // clean. Track the actual observer on every update and independently
    // dirty the cheap target scan at the frontier quantum.
    this.observerX = observer.x;
    this.observerZ = observer.z;
    const nextPresentationObserverSignature = [
      Math.round(observer.x / DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS),
      Math.round(observer.z / DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS),
    ].join(":");
    if (nextPresentationObserverSignature !== this.presentationObserverSignature) {
      this.presentationObserverSignature = nextPresentationObserverSignature;
      this.presentationObserverQuantumChanges = addDiagnosticCount(
        this.presentationObserverQuantumChanges,
      );
      this.batchesDirty = true;
    }
    if (this.suppressInvalidPresentationChunks()) this.batchesDirty = true;

    const speed = Math.hypot(velocityX, velocityZ);
    const lookAheadSeconds = speed > 1
      ? Math.min(6, DETAIL_LOOK_AHEAD_DISTANCE_METERS / speed)
      : 0;
    const predictionX = observer.x + velocityX * lookAheadSeconds;
    const predictionZ = observer.z + velocityZ * lookAheadSeconds;
    const quantization = this.cellSizeMeters * 0.5;
    const nextSignature = [
      Math.floor(observer.x / quantization),
      Math.floor(observer.z / quantization),
      Math.floor(predictionX / this.cellSizeMeters),
      Math.floor(predictionZ / this.cellSizeMeters),
      floatingOrigin.x,
      floatingOrigin.y,
      floatingOrigin.z,
      profile.vegetationDistance,
      profile.vegetationDensity,
    ].join(":");

    if (profile.vegetationDensity !== this.density) {
      this.density = profile.vegetationDensity;
      this.releaseAllResidentTokens();
      this.cells.clear();
      this.cellEpoch += 1;
      this.pendingCells.clear();
      this.client?.cancelAll();
      this.batchesDirty = true;
    }
    if (nextSignature !== this.signature) {
      this.signature = nextSignature;
      this.planCells(observer, predictionX, predictionZ, profile);
      this.batchesDirty = true;
    }

    for (const desired of this.desiredCells) {
      const resident = this.cells.get(desired.key);
      if (resident) {
        if (resident.lod !== desired.lod || resident.distance !== desired.distance) {
          resident.lod = desired.lod;
          resident.distance = desired.distance;
          this.batchesDirty = true;
        }
      }
    }

    // TREES POPPING IN CLOSE UP. The loop above refreshes `distance` only from
    // `desiredCells`, and that plan is rebuilt only when `nextSignature`
    // changes — which quantises the observer to `cellSizeMeters * 0.5`, i.e.
    // **256 m of travel, 4.1 s at cruise**. `presentationBuild` feeds that
    // distance straight into `renderedShareAtDistance`, so a cell's tree budget
    // could be up to 256 m out of date.
    //
    // **The error is negligible far out and enormous close in**, because the
    // share curve is flat past `farFloorShare` and steep inside the near
    // radius. Measured against the shipping law: a tier-1 cell 150 m away
    // rendered **13.6%** of its trees and jumped to 100% at the next crossing —
    // a **7.33x** step, 11.07x at tier 0 — with a hard binary admission
    // (`treeCanopyRank[i] > treeShare`) and no fade to soften it. It read as
    // "sometimes", because whether you see it depends on where the 256 m
    // lattice falls relative to the wood, not on the wood.
    //
    // **The quantisation is a rebuild throttle, not an oversight**, so this
    // does not refresh per frame. It bounds the quantity that is actually
    // VISIBLE — the share — instead of the one that was convenient, the
    // distance. That is self-throttling in the right direction: beyond the
    // floor the share is constant, so distant cells (the overwhelming majority)
    // never trigger a rebuild at all, and the traffic is confined to the
    // handful of near cells where the difference can be seen.
    //
    // **No radius, band boundary or law constant moves here.** The share simply
    // matches the distance the cell is at, which is what the law always said.
    const densityLaw = profile.renderedDensityLaw;
    for (const resident of this.cells.values()) {
      const liveDistance = detailCellMinimumDistanceMeters(
        observer.x,
        observer.z,
        resident.cellX,
        resident.cellZ,
        resident.cellSizeMeters,
      );
      const drift = Math.abs(
        renderedShareAtDistance(densityLaw, liveDistance)
        - renderedShareAtDistance(densityLaw, resident.distance),
      );
      if (drift > DETAIL_DENSITY_SHARE_REFRESH_EPSILON) {
        resident.distance = liveDistance;
        this.batchesDirty = true;
      }
    }

    if (this.client !== null) {
      const missingWorkerCells = this.desiredCells.reduce(
        (count, desired) => count
          + (this.residentIsCurrentAndAccessible(this.cells.get(desired.key)) ? 0 : 1),
        0,
      );
      if (missingWorkerCells === 0) {
        this.resetWorkerGenerationProgress();
      } else {
        this.beginWorkerGenerationProgress();
        if (this.workerGenerationProgressExpired()) {
          this.failClosedWorkerAuthorityTimeout("generation");
        }
      }
    }

    if (this.client !== null) {
      // 1B-10: generation happens on the worker; the main thread only files
      // requests (streaming-priority ordered by the bounded queue) and
      // applies results as they arrive. The Governor B budget cap survives
      // as the request-admission bound.
      const requestCap = this.generationBudgetCap?.maximumCells ?? Number.POSITIVE_INFINITY;
      let admitted = 0;
      for (const desired of this.desiredCells) {
        if (admitted >= requestCap) break;
        const resident = this.cells.get(desired.key);
        if (
          this.residentIsCurrentAndAccessible(resident)
          || this.pendingCells.has(desired.key)
        ) continue;
        const epoch = this.cellEpoch;
        const requestId = this.client.requestRetained(
          {
            key: desired.key,
            generation: epoch,
            priority: desired.priority,
            cellX: desired.cellX,
            cellZ: desired.cellZ,
            densityMultiplier: profile.vegetationDensity,
            dayOfYear: this.dayOfYear,
          },
          (descriptor) => this.onRetainedCellGenerated(desired.key, epoch, descriptor),
          () => this.pendingCells.delete(desired.key),
        );
        if (requestId < 0) break;
        this.pendingCells.set(desired.key, requestId);
        admitted += 1;
      }
    } else {
      const resolvedBudget = resolveDetailGenerationBudget(profile);
      const cap = this.generationBudgetCap;
      // The governor cap can only shrink the profile's own slice, never grow it.
      const generationBudget = cap === null ? resolvedBudget : {
        maximumCells: Math.min(resolvedBudget.maximumCells, cap.maximumCells),
        maximumMilliseconds: Math.min(resolvedBudget.maximumMilliseconds, cap.maximumMilliseconds),
      };
      const generationStartedAt = this.nowMilliseconds();
      let generated = 0;
      for (const desired of this.desiredCells) {
        const current = this.cells.get(desired.key);
        if (
          current?.source === "inline"
          && current.generation === this.cellEpoch
          && !current.invalidated
        ) continue;
        const elapsedMilliseconds = generated === 0
          ? 0
          : Math.max(0, this.nowMilliseconds() - generationStartedAt);
        if (!canGenerateNextDetailCell(generated, elapsedMilliseconds, generationBudget)) break;
        const cell = generateDetailCell({
          worldSeed: this.options.worldSeed,
          cellX: desired.cellX,
          cellZ: desired.cellZ,
          cellSizeMeters: this.cellSizeMeters,
          densityMultiplier: profile.vegetationDensity,
          terrainSample: this.options.terrainSample,
          seaLevelMeters: this.options.seaLevelMeters ?? 0,
          dayOfYear: this.dayOfYear,
          latitudeDegrees: this.options.latitudeDegrees ?? 45,
          // The inline path needs the same exclusions as the worker path, or
          // the fix is only present on whichever one happens to run.
          ...(this.options.workerWorld?.airport
            ? {
              structureExclusions: this.structureExclusions,
              exclusionAirport: this.options.workerWorld.airport,
            }
            : {}),
        });
        this.replaceResident(desired.key, {
          source: "inline",
          key: cell.key,
          cellX: cell.cellX,
          cellZ: cell.cellZ,
          cellSizeMeters: cell.cellSizeMeters,
          cell,
          generation: this.cellEpoch,
          revision: ++this.cellRevision,
          treeCanopyRank: detailTreeCanopyRankOrder(cell.trees),
          lod: desired.lod,
          distance: desired.distance,
          invalidated: false,
        });
        this.cumulativeGeneratedCells += 1;
        generated += 1;
        this.batchesDirty = true;
      }
    }

    for (const plugin of this.bandFadePlugins) {
      plugin.setBandFades(
        profile.renderedDensityLaw.near.outerRadiusMeters,
        profile.renderedDensityLaw.mid.outerRadiusMeters,
        profile.renderedDensityLaw.far.outerRadiusMeters,
      );
    }
    if (this.batchesDirty) {
      // Stays dirty while the amortized sweep has a backlog.
      this.batchesDirty = this.rebuildBatches(floatingOrigin, profile);
    } else {
      // Camera rotation does not affect paging signatures, but it does change
      // which spatial chunks Babylon submits to the main view.
      this.refreshVisibilityStatistics();
    }
  }

  /**
   * Supplies active, deliberately bounded shadow batches to a CSM or shadow
   * generator.
   *
   * `4.5-C1`: the tier's `vegetationCastsShadows` datum gates the whole list.
   * The near band submits every (species, variant, crown/trunk) mesh once per
   * cascade, which is 148 of tier 1's 347 modelled draws and 3.85 of its 9.02
   * modelled milliseconds — the largest single term, and the only one no lever
   * §5.3 governs can move. Read from the profile each update rather than
   * baked into the prototypes so a runtime quality switch takes effect in the
   * same frame, in both directions.
   */
  addShadowCasters(add: (mesh: Mesh) => void): void {
    if (this.disposed || !this.vegetationCastsShadows) return;
    for (const batch of this.batches.values()) {
      if (batch.castsShadows && batch.mesh.isEnabled() && batch.mesh.forcedInstanceCount > 0) {
        add(batch.mesh);
      }
    }
  }

  /** Visits the fixed shared PBR material set; thin-instance chunks add none. */
  addPbrMaterials(add: (material: PBRMaterial) => void): void {
    if (this.disposed) return;
    for (const material of this.materials) add(material);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingPresentationBuild) this.cancelPendingPresentationBuild();
    if (this.pendingPublication) this.cancelPendingPublication();
    this.revealRamps.clear();
    this.releaseAllResidentTokens();
    this.client?.dispose();
    this.client = null;
    this.pendingCells.clear();
    this.cells.clear();
    this.desiredCells = [];
    this.desiredKeys.clear();
    this.detailBuildStoragePool.clear();
    for (const batch of this.batches.values()) {
      batch.mesh.dispose(false, false);
      batch.gpu?.shared.dispose();
      batch.gpu = null;
    }
    this.batches.clear();
    for (const retired of this.retiredBatches) {
      retired.batch.mesh.dispose(false, false);
      retired.batch.gpu?.shared.dispose();
      retired.batch.gpu = null;
    }
    this.retiredBatches.length = 0;
    for (const pooled of this.instanceBufferPool) pooled.gpu.shared.dispose();
    this.instanceBufferPool.length = 0;
    this.presentationChunks.clear();
    this.presentationBacklogChunks = 0;
    for (const prototype of this.prototypes.values()) prototype.mesh.dispose(false, false);
    this.prototypes.clear();
    this.instancePlugins.clear();
    this.pluginByMaterial.clear();
    this.foliageAtlas?.texture.dispose();
    this.foliageAtlas = null;
    for (const material of this.materials) material.dispose(true, true);
    this.materials.clear();
    this.statisticsValue = ZERO_STATISTICS;
  }

  private planCells(
    observer: WorldDetailObserver,
    predictionX: number,
    predictionZ: number,
    profile: WebGpuQualityProfile,
  ): void {
    const radius = profile.vegetationDistance;
    const minCellX = Math.floor((Math.min(observer.x, predictionX) - radius) / this.cellSizeMeters);
    const maxCellX = Math.floor((Math.max(observer.x, predictionX) + radius) / this.cellSizeMeters);
    const minCellZ = Math.floor((Math.min(observer.z, predictionZ) - radius) / this.cellSizeMeters);
    const maxCellZ = Math.floor((Math.max(observer.z, predictionZ) + radius) / this.cellSizeMeters);
    // R-21: the near residency boundary is the law's full-geometry band.
    const nearDistance = Math.min(
      profile.renderedDensityLaw.near.outerRadiusMeters,
      radius * 0.34,
    );
    const candidates: DesiredCell[] = [];
    const travelDistance = Math.hypot(predictionX - observer.x, predictionZ - observer.z);

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const distance = detailCellMinimumDistanceMeters(
          observer.x,
          observer.z,
          cellX,
          cellZ,
          this.cellSizeMeters,
        );
        const predictedDistance = detailCellMinimumDistanceMeters(
          predictionX,
          predictionZ,
          cellX,
          cellZ,
          this.cellSizeMeters,
        );
        if (distance > radius && predictedDistance > radius * 0.72) continue;
        candidates.push({
          key: detailCellKey(cellX, cellZ),
          cellX,
          cellZ,
          distance,
          lod: distance <= nearDistance ? "near" : "mid",
          priority: Math.min(distance, predictedDistance * 0.78 + travelDistance * 0.08),
        });
      }
    }
    candidates.sort((first, second) => first.priority - second.priority || first.key.localeCompare(second.key));
    this.desiredCells = candidates.slice(0, profileCellBudget(profile));
    this.desiredKeys = new Set(this.desiredCells.map((candidate) => candidate.key));
    for (const [key, resident] of this.cells) {
      if (this.desiredKeys.has(key)) continue;
      this.releaseResidentToken(resident);
      this.cells.delete(key);
    }
    for (const [key, requestId] of this.pendingCells) {
      if (this.desiredKeys.has(key)) continue;
      this.client?.cancel(requestId);
      this.pendingCells.delete(key);
    }
  }

  /** Accepts only the lightweight worker descriptor; placement arrays never cross to main. */
  private onRetainedCellGenerated(
    key: string,
    epoch: number,
    descriptor: DetailRetainedCellDescriptor,
  ): void {
    this.pendingCells.delete(key);
    const desired = this.desiredCells.find((candidate) => candidate.key === key);
    if (
      this.disposed
      || epoch !== this.cellEpoch
      || !desired
      || descriptor.key !== key
      || descriptor.cellX !== desired.cellX
      || descriptor.cellZ !== desired.cellZ
      || descriptor.cellSizeMeters !== this.cellSizeMeters
    ) {
      this.client?.releaseCell(descriptor);
      return;
    }
    this.replaceResident(key, {
      source: "worker",
      key: descriptor.key,
      cellX: descriptor.cellX,
      cellZ: descriptor.cellZ,
      cellSizeMeters: descriptor.cellSizeMeters,
      descriptor,
      tokenOwned: true,
      generation: epoch,
      revision: ++this.cellRevision,
      lod: desired.lod,
      distance: desired.distance,
      invalidated: false,
    });
    this.recordWorkerGenerationProgress();
    this.cumulativeGeneratedCells += 1;
    this.batchesDirty = true;
  }

  private rebuildBatches(
    floatingOrigin: DetailFloatingOrigin,
    profile: WebGpuQualityProfile,
  ): boolean {
    this.presentationWorkUnitsLastUpdate = 0;
    this.presentationMillisecondsLastUpdate = 0;
    this.lastDensityLaw = profile.renderedDensityLaw;
    this.lastGrassRadius = profile.grassRadiusMeters;
    this.groundCoverFieldRadiusMeters = this.groundCoverBladesActive
      ? groundCoverHandoffRadiusMeters(profile.groundCoverLaw)
      : 0;
    this.suppressInvalidPresentationChunks();
    const grouped = new Map<
      string,
      { coordinates: DetailPresentationChunkCoordinates; residents: ResidentCell[] }
    >();
    for (const resident of this.cells.values()) {
      const coordinates = detailPresentationChunkCoordinates(
        resident.cellX,
        resident.cellZ,
      );
      const group = grouped.get(coordinates.key);
      if (group) group.residents.push(resident);
      else grouped.set(coordinates.key, { coordinates, residents: [resident] });
    }

    for (const [chunkKey, chunk] of this.presentationChunks) {
      if (grouped.has(chunkKey)) continue;
      if (this.pendingPresentationBuild?.coordinates.key === chunkKey) {
        this.cancelPendingPresentationBuild();
      }
      if (this.pendingPublication?.coordinates.key === chunkKey) {
        this.cancelPendingPublication();
      }
      this.disposePresentationChunk(chunk);
    }

    // Rendered-share thinning: the density field carries the ECOLOGICAL stem
    // density (300–800/ha closed forest); the R-21 rendered-density LAW
    // (renderedDensity.ts, the one authority 2-12/2-14/2-17 also read)
    // decides what fraction is drawn at each range. The near cap IS the
    // crown-closure density, so closed-forest cells keep their interiors
    // while open cells render everything they authored (they sit under the
    // cap) — the per-cell cap, not a global scalar, is what preserves
    // clumps. Selection is a stable per-stem uniform, so shares nest:
    // raising the budget only ever ADDS stems.
    const densityLaw = profile.renderedDensityLaw;
    const configurationSignature = [
      densityLaw.nearStemsPerHectare,
      densityLaw.near.outerRadiusMeters,
      densityLaw.mid.outerRadiusMeters,
      densityLaw.far.outerRadiusMeters,
      densityLaw.farFloorShare,
      profile.treeVariantCap,
      profile.treePrototypeMode,
      profile.grassRadiusMeters,
      this.groundCoverFieldRadiusMeters,
    ].join(":");
    const targets = new Map<string, DetailChunkBuildTarget>();

    for (const group of grouped.values()) {
      group.residents.sort((first, second) => first.key.localeCompare(second.key));
      const observerTerm = this.chunkObserverTerm(group.coordinates);
      const signature = [
        floatingOrigin.x,
        floatingOrigin.y,
        floatingOrigin.z,
        densityLaw.nearStemsPerHectare,
        densityLaw.near.outerRadiusMeters,
        densityLaw.mid.outerRadiusMeters,
        densityLaw.far.outerRadiusMeters,
        densityLaw.farFloorShare,
        profile.treeVariantCap,
        profile.treePrototypeMode,
        profile.grassRadiusMeters,
        this.groundCoverFieldRadiusMeters,
        // 2-17 close: the observer term applies ONLY to FRONTIER chunks —
        // those straddling a band or population edge, where memberships and
        // single-edge baked fades actually change with camera range. An
        // interior chunk (the bulk of the field) rebuilds only when its
        // residents change, restoring the zero-steady-state-rebuild design;
        // a naive global observer term rebuilt EVERY chunk each quantum and
        // the capture measured it as a saturated hitch train.
        observerTerm,
        ...group.residents.map(
          (resident) => `${resident.key}/${resident.lod}/${resident.revision}`,
        ),
      ].join(":");
      const buildSource = group.residents.every((resident) => resident.source === "inline")
        ? "inline"
        : this.client !== null && group.residents.every(
            (resident) => resident.source === "worker" && resident.tokenOwned,
          )
          ? "worker"
          : "blocked";
      let chunk = this.presentationChunks.get(group.coordinates.key);
      if (!chunk) {
        chunk = {
          coordinates: group.coordinates,
          batchKeys: new Set<string>(),
          signature: "",
          revision: 0,
          observerX: 0,
          observerZ: 0,
          observerSensitive: false,
          validitySuppressed: false,
          staleVisible: false,
          statistics: {
            nearCells: 0,
            midCells: 0,
            treeInstances: 0,
            shrubInstances: 0,
            rockInstances: 0,
            clutterInstances: 0,
            groundCoverInstances: 0,
          },
        };
        this.presentationChunks.set(group.coordinates.key, chunk);
      }
      targets.set(group.coordinates.key, {
        coordinates: group.coordinates,
        residents: group.residents,
        signature,
        configurationSignature,
        observerSensitive: observerTerm !== "interior",
        buildSource,
      });
      if (observerTerm !== "interior" && chunk.revision > 0 && !chunk.observerSensitive) {
        // Entering the deliberately padded frontier does not invalidate the
        // old interior bytes yet. Anchor their newly relevant validity clock
        // now so the live-snapshot diagnostic covers the transition while a
        // frontier replacement stages.
        chunk.observerX = this.observerX;
        chunk.observerZ = this.observerZ;
        chunk.observerSensitive = true;
      }
    }

    const workerPresentationDemand = this.pendingPresentationBuild?.source === "worker"
      || [...targets.values()].some((target) => (
        target.buildSource === "worker"
        && this.presentationChunks.get(target.coordinates.key)?.signature !== target.signature
      ));
    if (workerPresentationDemand) {
      this.beginWorkerPresentationProgress();
      const queuedWorkerCompletion = this.pendingPresentationBuild?.source === "worker"
        && (
          this.pendingPresentationBuild.queuedResult !== null
          || this.pendingPresentationBuild.queuedError !== null
        );
      if (!queuedWorkerCompletion && this.workerPresentationProgressExpired()) {
        this.failClosedWorkerAuthorityTimeout("presentation");
      }
    } else {
      this.resetWorkerPresentationProgress();
    }

    // A staged build is a snapshot. Structural representation changes cancel
    // CPU staging, while ordinary observer/resident supersession completes
    // the immutable snapshot and immediately leaves a newer target queued.
    // Defect A fix: observer drift alone NEVER cancels an in-flight build —
    // at speed the old >96 m cancel/reissue cycle livelocked with the chunk
    // suppressed throughout. A drifted build finishes, publishes (it is
    // fresher than what is live), and the chunk's changed observer term
    // re-dirties it so the sweep converges instead of thrashing. Cancels
    // remain for disposal, profile/configuration, frontier-classification,
    // build-source and floating-origin changes.
    if (this.pendingPresentationBuild) {
      const pendingBuild = this.pendingPresentationBuild;
      const currentTarget = targets.get(pendingBuild.coordinates.key);
      if (
        !currentTarget
        || currentTarget.configurationSignature
          !== pendingBuild.configurationSignature
        || currentTarget.observerSensitive
          !== pendingBuild.observerSensitive
        || (
          currentTarget.buildSource !== "blocked"
          && currentTarget.buildSource !== pendingBuild.source
        )
        || pendingBuild.recordOrigin.x !== floatingOrigin.x
        || pendingBuild.recordOrigin.y !== floatingOrigin.y
        || pendingBuild.recordOrigin.z !== floatingOrigin.z
      ) {
        this.cancelPendingPresentationBuild();
      }
    }
    // The same structural guards protect a publication mid-stream; its
    // content is already main-thread-owned, so worker state and observer
    // drift are deliberately not conditions here.
    if (this.pendingPublication) {
      const currentTarget = targets.get(this.pendingPublication.coordinates.key);
      if (
        !currentTarget
        || currentTarget.configurationSignature
          !== this.pendingPublication.configurationSignature
      ) {
        this.cancelPendingPublication();
      }
    }

    if (!this.pendingPresentationBuild && !this.pendingPublication) {
      // Defect A fix: rebuild target selection is nearest-observer-first
      // (it was Map insertion order), so the most visible chunk is always
      // the freshest one. Ties break on the stable chunk key so the sweep
      // stays deterministic.
      const dirtyTargets: DetailChunkBuildTarget[] = [];
      for (const target of targets.values()) {
        const chunk = this.presentationChunks.get(target.coordinates.key)!;
        if (chunk.signature === target.signature || target.buildSource === "blocked") continue;
        dirtyTargets.push(target);
      }
      dirtyTargets.sort((first, second) =>
        this.chunkMinimumDistanceMeters(first.coordinates)
          - this.chunkMinimumDistanceMeters(second.coordinates)
        || first.coordinates.key.localeCompare(second.coordinates.key));
      for (const target of dirtyTargets) {
        const pending = this.createPendingPresentationBuild(
          target,
          floatingOrigin,
          densityLaw,
          profile.treeVariantCap,
          profile.treePrototypeMode,
          profile.grassRadiusMeters,
        );
        if (pending) {
          this.pendingPresentationBuild = pending;
          break;
        }
        // Worker backpressure: wait for the nearest chunk's slot to free
        // rather than spending it on a farther, less visible one.
        if (target.buildSource === "worker") break;
      }
    }

    if (this.pendingPresentationBuild) {
      const completed = this.advancePendingPresentationBuild();
      if (completed) {
        const completedBuild = this.pendingPresentationBuild;
        const target = targets.get(completedBuild.coordinates.key);
        // No asynchronous callback can run inside update(). The structural
        // guard remains so a future scheduler cannot publish an incompatible
        // representation; ordinary newer content stays queued after commit.
        // Defect A fix: the old >96 m observer-drift rejection is gone — a
        // completed drifted snapshot is fresher than whatever is live, so it
        // proceeds to publication and the chunk's changed observer term
        // leaves it dirty for the converging sweep.
        if (
          target?.configurationSignature
            === completedBuild.configurationSignature
        ) {
          if (completedBuild.source === "worker") {
            // The worker produced accepted useful output; the publication
            // streaming that follows is main-thread work and must not be
            // chargeable to the worker authority watchdog.
            this.resetWorkerPresentationProgress();
          }
          this.createPendingPublication(completedBuild, completed);
          this.pendingPresentationBuild = null;
        } else {
          // Keep the pending owner installed while cancel releases every
          // staged CPU pair back to the bounded pool.
          this.cancelPendingPresentationBuild();
        }
      }
    }

    // Defect D fix: advance (and possibly flip) the staged publication in
    // the same update, so a publication with no structural or streaming work
    // — the steady-state in-place rebuild — still commits synchronously.
    if (this.pendingPublication) this.advancePendingPublication(floatingOrigin);

    const totals: MutableDetailChunkStatistics = {
      nearCells: 0,
      midCells: 0,
      treeInstances: 0,
      shrubInstances: 0,
      rockInstances: 0,
      clutterInstances: 0,
      groundCoverInstances: 0,
    };
    let rebuildBacklogChunks = 0;
    for (const target of targets.values()) {
      const chunk = this.presentationChunks.get(target.coordinates.key)!;
      if (chunk.signature !== target.signature) rebuildBacklogChunks += 1;
      if (!chunk.validitySuppressed) {
        totals.nearCells += chunk.statistics.nearCells;
        totals.midCells += chunk.statistics.midCells;
        totals.treeInstances += chunk.statistics.treeInstances;
        totals.shrubInstances += chunk.statistics.shrubInstances;
        totals.rockInstances += chunk.statistics.rockInstances;
        totals.clutterInstances += chunk.statistics.clutterInstances;
        totals.groundCoverInstances += chunk.statistics.groundCoverInstances;
      }
    }

    this.statisticsValue = {
      residentCells: this.cells.size,
      nearCells: totals.nearCells,
      midCells: totals.midCells,
      generatedCells: this.cumulativeGeneratedCells,
      treeInstances: totals.treeInstances,
      shrubInstances: totals.shrubInstances,
      rockInstances: totals.rockInstances,
      clutterInstances: totals.clutterInstances,
      groundCoverInstances: totals.groundCoverInstances,
      renderedThinInstances: 0,
      activeBatches: 0,
    };
    this.presentationBacklogChunks = rebuildBacklogChunks;
    this.refreshVisibilityStatistics();
    return rebuildBacklogChunks > 0
      || this.pendingPresentationBuild !== null
      || this.pendingPublication !== null;
  }

  private createPendingPresentationBuild(
    target: DetailChunkBuildTarget,
    floatingOrigin: DetailFloatingOrigin,
    densityLaw: RenderedDensityLaw,
    treeVariantCap: number,
    treePrototypeMode: WebGpuQualityProfile["treePrototypeMode"],
    grassRadiusMeters: number,
  ): PendingDetailChunkBuild | null {
    if (target.buildSource === "blocked") return null;
    const recordOrigin: DetailFloatingOrigin = {
      x: floatingOrigin.x,
      y: floatingOrigin.y,
      z: floatingOrigin.z,
    };
    const stagedBatches = new Map<string, StagedDetailBatch>();
    const common = {
      coordinates: target.coordinates,
      signature: target.signature,
      configurationSignature: target.configurationSignature,
      recordOrigin,
      observerX: this.observerX,
      observerZ: this.observerZ,
      observerSensitive: target.observerSensitive,
      stagedBatches,
    } satisfies PendingDetailChunkBuildBase;

    if (target.buildSource === "worker") {
      const client = this.client;
      if (!client) return null;
      const residents = target.residents.map((resident) => {
        if (resident.source !== "worker" || !resident.tokenOwned) {
          throw new Error("Worker detail build mixed inaccessible resident sources");
        }
        return {
          token: resident.descriptor.token,
          lod: resident.lod,
          distance: resident.distance,
        };
      });
      const build: PendingWorkerDetailChunkBuild = {
        ...common,
        source: "worker",
        residentTokens: residents.map((resident) => resident.token),
        residentLods: residents.map((resident) => resident.lod),
        buildId: -1,
        queuedResult: null,
        queuedError: null,
      };
      const buildId = client.requestPresentation(
        {
          residents,
          floatingOrigin: recordOrigin,
          densityLaw,
          treeVariantCap,
          treePrototypeMode,
          grassRadiusMeters,
          groundCoverBladesActive: this.groundCoverBladesActive,
          groundCoverFieldRadiusMeters: this.groundCoverFieldRadiusMeters,
          observerX: this.observerX,
          observerZ: this.observerZ,
        },
        (result) => {
          if (build.queuedResult || build.queuedError) {
            this.presentationWorkerBuildRejections = addDiagnosticCount(
              this.presentationWorkerBuildRejections,
            );
            return;
          }
          build.queuedResult = result;
          this.presentationWorkerResultsQueued = addDiagnosticCount(
            this.presentationWorkerResultsQueued,
          );
          this.batchesDirty = true;
        },
        (error) => {
          build.queuedError = error;
          this.batchesDirty = true;
        },
      );
      if (buildId < 0) {
        this.presentationWorkerBuildRejections = addDiagnosticCount(
          this.presentationWorkerBuildRejections,
        );
        return null;
      }
      build.buildId = buildId;
      this.presentationWorkerBuildStarts = addDiagnosticCount(
        this.presentationWorkerBuildStarts,
      );
      this.recordPresentationBuildStart(target);
      return build;
    }

    const residents = target.residents.map((resident) => {
      if (resident.source !== "inline") {
        throw new Error("Inline detail build mixed inaccessible resident sources");
      }
      return {
        cell: resident.cell,
        treeCanopyRank: resident.treeCanopyRank,
        lod: resident.lod,
        distance: resident.distance,
      };
    });
    this.recordPresentationBuildStart(target);
    return {
      ...common,
      source: "inline",
      iterator: buildPresentationChunk(
        {
          residents,
          floatingOrigin: recordOrigin,
          densityLaw,
          treeVariantCap,
          treePrototypeMode,
          grassRadiusMeters,
          groundCoverBladesActive: this.groundCoverBladesActive,
          groundCoverFieldRadiusMeters: this.groundCoverFieldRadiusMeters,
          observerX: this.observerX,
          observerZ: this.observerZ,
        },
        this.presentationBuildCatalog,
        {
          appendInstance: (prototypeKey, record, billboardFrame) => {
            const batch = this.getStagedBatch(prototypeKey, stagedBatches);
            batch.writer.pushBounded(
              record,
              batch.bounds,
              batch.prototypeBoundKernel,
              billboardFrame,
            );
          },
        },
      ),
    };
  }

  private recordPresentationBuildStart(target: DetailChunkBuildTarget): void {
    this.presentationBuildStarts = addDiagnosticCount(this.presentationBuildStarts);
    if (!target.observerSensitive) return;
    this.presentationObserverSensitiveBuildStarts = addDiagnosticCount(
      this.presentationObserverSensitiveBuildStarts,
    );
    this.presentationResidentCellsInSensitiveBuilds = addDiagnosticCount(
      this.presentationResidentCellsInSensitiveBuilds,
      target.residents.length,
    );
  }
  /**
   * Snapshot the prototype metadata once, after prototype registration. The
   * result contains data only, so phase 2 can structured-clone this exact
   * catalog into a worker instead of defining a second packing schema.
   */
  private createPresentationBuildCatalog(): DetailPresentationBuildCatalog {
    const prototypes: Record<
      string,
      DetailPresentationBuildCatalog["prototypes"][string]
    > = {};
    for (const [prototypeKey, prototype] of this.prototypes) {
      const radialUnits = this.prototypeRadialUnits.get(prototypeKey);
      prototypes[prototypeKey] = radialUnits === undefined
        ? { boundKernel: prototype.boundKernel }
        : { radialUnits, boundKernel: prototype.boundKernel };
    }
    const impostors: Partial<Record<
      TreeSpecies,
      NonNullable<DetailPresentationBuildCatalog["impostors"][TreeSpecies]>
    >> = {};
    for (const species of TREE_SPECIES) {
      const radialUnits = this.impostorRadialUnits.get(species);
      const frame = this.impostorFrames.get(species);
      if (radialUnits !== undefined && frame) impostors[species] = { radialUnits, frame };
    }
    const trees = Object.fromEntries(TREE_SPECIES.map((species) => [
      species,
      {
        prototypeFamily: treePrototypeSpecies(species, "families"),
        variantCount: TREE_VARIANT_COUNTS[species],
        trunkTint: treeTrunkTint(species),
      },
    ])) as DetailPresentationBuildCatalog["trees"];
    const shrubs = Object.fromEntries(SHRUB_SPECIES.map((species) => [
      species,
      { variantCount: SHRUB_VARIANT_COUNTS[species] },
    ])) as DetailPresentationBuildCatalog["shrubs"];
    return {
      prototypes,
      impostors,
      trees,
      shrubs,
      groundCoverGrid: GROUND_COVER_GRID,
      useImpostors: this.impostorAtlas !== null,
    };
  }

  /** Advances inline synthesis or consumes one completed worker snapshot. */
  private advancePendingPresentationBuild(): DetailChunkStatistics | null {
    const build = this.pendingPresentationBuild;
    if (!build) return null;
    const startedAt = this.presentationNowMilliseconds();
    if (build.source === "worker") {
      this.presentationWorkUnitsLastUpdate = 0;
      this.presentationMillisecondsLastUpdate = 0;
      if (build.queuedError) {
        this.failClosedWorkerPresentation(build);
        return null;
      }
      const result = build.queuedResult;
      if (!result) return null;
      try {
        const statistics = this.rehydrateWorkerPresentationResult(build, result);
        this.presentationBuildSlices = addDiagnosticCount(this.presentationBuildSlices);
        this.presentationCompletedSlices = addDiagnosticCount(
          this.presentationCompletedSlices,
        );
        this.presentationMillisecondsLastUpdate = Math.max(
          0,
          this.presentationNowMilliseconds() - startedAt,
        );
        return statistics;
      } catch {
        this.failClosedWorkerPresentation(build);
        return null;
      }
    }

    let workUnits = 0;
    let completed: DetailChunkStatistics | null = null;
    let stoppedForTime = false;
    while (workUnits < this.presentationRebuildBudget.maximumWorkUnits) {
      const result = build.iterator.next();
      workUnits += 1;
      if (result.done) {
        completed = result.value;
        break;
      }
      if (
        workUnits % DETAIL_PRESENTATION_REBUILD_CLOCK_INTERVAL_UNITS === 0
        && this.presentationNowMilliseconds() - startedAt
          >= this.presentationRebuildBudget.maximumMilliseconds
      ) {
        stoppedForTime = true;
        break;
      }
    }
    this.presentationBuildSlices = addDiagnosticCount(this.presentationBuildSlices);
    this.presentationWorkUnitsTotal = addDiagnosticCount(
      this.presentationWorkUnitsTotal,
      workUnits,
    );
    if (completed) {
      this.presentationCompletedSlices = addDiagnosticCount(this.presentationCompletedSlices);
    } else if (stoppedForTime) {
      this.presentationTimeBudgetStops = addDiagnosticCount(
        this.presentationTimeBudgetStops,
      );
    } else {
      this.presentationWorkBudgetStops = addDiagnosticCount(
        this.presentationWorkBudgetStops,
      );
    }
    this.presentationWorkUnitsLastUpdate = workUnits;
    this.presentationMillisecondsLastUpdate = Math.max(
      0,
      this.presentationNowMilliseconds() - startedAt,
    );
    return completed;
  }

  /**
   * Rehydrates transferred ownership into the same staging abstraction used
   * by inline synthesis. Validation is deliberately repeated here even though
   * the client guards the wire shape: this is the last authority before an
   * atomic live-GPU publication.
   */
  private rehydrateWorkerPresentationResult(
    build: PendingWorkerDetailChunkBuild,
    result: DetailWorkerPresentationResult,
  ): DetailChunkStatistics {
    if (
      this.pendingPresentationBuild !== build
      || result.buildId !== build.buildId
      || build.signature.length === 0
      || build.configurationSignature.length === 0
      || build.residentTokens.length !== build.residentLods.length
      || new Set(build.residentTokens).size !== build.residentTokens.length
      || build.residentTokens.some((token) => !Number.isSafeInteger(token) || token <= 0)
      // Defect A fix: observer drift is deliberately NOT validated here. At
      // speed a result routinely arrives >96 m stale; that is ordinary
      // supersession (publish, then converge), not a malformed worker.
      || build.stagedBatches.size !== 0
    ) {
      throw new Error("Detail worker presentation result no longer matches its build snapshot");
    }

    const statistics = result.statistics;
    for (const value of Object.values(statistics)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Detail worker presentation statistics must be non-negative integers");
      }
    }
    let nearCells = 0;
    let midCells = 0;
    for (const lod of build.residentLods) {
      if (lod === "near") nearCells += 1;
      else if (lod === "mid") midCells += 1;
      else throw new Error("Detail worker presentation resident has an invalid LOD");
    }
    if (statistics.nearCells !== nearCells || statistics.midCells !== midCells) {
      throw new Error("Detail worker presentation statistics do not match the resident snapshot");
    }
    const authoredInstances = statistics.treeInstances
      + statistics.shrubInstances
      + statistics.rockInstances
      + statistics.clutterInstances
      + statistics.groundCoverInstances;
    const maximumPackedRecords = statistics.treeInstances * 6
      + statistics.shrubInstances
      + statistics.rockInstances
      + statistics.clutterInstances
      + statistics.groundCoverInstances;
    let packedRecords = 0;
    for (const batch of result.batches) {
      packedRecords += batch.count;
    }
    if (
      !Number.isSafeInteger(authoredInstances)
      || !Number.isSafeInteger(maximumPackedRecords)
      || !Number.isSafeInteger(packedRecords)
      || packedRecords < authoredInstances
      || packedRecords > maximumPackedRecords
    ) {
      throw new Error("Detail worker presentation record count does not match authored instances");
    }
    if ((authoredInstances === 0) !== (result.batches.length === 0)) {
      throw new Error("Detail worker presentation batches do not match authored instance statistics");
    }
    const transferredBuffers = new Set<ArrayBuffer>();
    for (const batch of result.batches) {
      if (
        !(batch.bytes.buffer instanceof ArrayBuffer)
        || transferredBuffers.has(batch.bytes.buffer)
      ) {
        throw new Error("Detail worker presentation batches must own unique transferred buffers");
      }
      transferredBuffers.add(batch.bytes.buffer);
    }

    const stagedBatches = new Map<string, StagedDetailBatch>();
    try {
      for (const batch of result.batches) {
        if (batch.prototypeKey.length === 0 || stagedBatches.has(batch.prototypeKey)) {
          throw new Error("Detail worker presentation contains an invalid or duplicate batch key");
        }
        const prototype = this.prototypes.get(batch.prototypeKey);
        if (!prototype) {
          throw new Error(`Detail worker presentation referenced unknown prototype ${batch.prototypeKey}`);
        }
        stagedBatches.set(batch.prototypeKey, {
          prototypeKey: batch.prototypeKey,
          writer: DetailInstanceWriter.fromTransferredBytes(batch.bytes, batch.count),
          bounds: DetailInstanceBounds.fromExtents(batch.minimum, batch.maximum),
          prototypeBoundKernel: prototype.boundKernel,
        });
      }
    } catch (error) {
      for (const staged of stagedBatches.values()) {
        this.releaseDetailBuildStorage(
          staged.prototypeKey,
          staged.writer,
          staged.bounds,
        );
      }
      throw error;
    }
    for (const [prototypeKey, staged] of stagedBatches) {
      build.stagedBatches.set(prototypeKey, staged);
    }
    return statistics;
  }

  /**
   * A semantically malformed worker result is not retried on the same path:
   * keep every complete live chunk, terminate the untrusted authority, and
   * let bounded inline generation replace descriptors cell by cell.
   */
  private failClosedWorkerPresentation(build: PendingWorkerDetailChunkBuild): void {
    if (this.pendingPresentationBuild !== build) return;
    this.client?.cancelPresentation(build.buildId);
    this.presentationWorkerBuildRejections = addDiagnosticCount(
      this.presentationWorkerBuildRejections,
    );
    this.activateInlineWorkerFallback(true);
  }

  private cancelPendingPresentationBuild(): void {
    const build = this.pendingPresentationBuild;
    if (!build) return;
    if (build.source === "worker") this.client?.cancelPresentation(build.buildId);
    // Staging has no Mesh, VertexBuffer or Buffer. Cancellation is therefore
    // incapable of shortening the grace period that protects submitted draws.
    this.releaseStagedBuildStorage(build);
    this.pendingPresentationBuild = null;
    this.presentationBuildCancellations = addDiagnosticCount(
      this.presentationBuildCancellations,
    );
  }

  /**
   * Turns a completed build into a cross-frame staged publication (defect D
   * fix). Ownership of the staged CPU writers moves from the build to the
   * publication; the build's staged map is cleared so cancellation of either
   * owner can never double-release a writer.
   */
  private createPendingPublication(
    build: PendingDetailChunkBuild,
    statistics: DetailChunkStatistics,
  ): void {
    const chunk = this.presentationChunks.get(build.coordinates.key);
    if (!chunk) {
      this.releaseStagedBuildStorage(build);
      return;
    }
    const uploads: StagedDetailBatchUpload[] = [];
    for (const staged of build.stagedBatches.values()) {
      const batchKey = `${staged.prototypeKey}@${build.coordinates.key}`;
      const live = this.batches.get(batchKey);
      const packed = staged.writer.finish();
      const kind: StagedDetailBatchUpload["kind"] = !live
        ? "create"
        : live.gpu !== null && packed.byteLength <= live.gpu.capacityBytes
          ? "fits"
          : "grow";
      uploads.push({
        batchKey,
        prototypeKey: staged.prototypeKey,
        writer: staged.writer,
        bounds: staged.bounds,
        packed,
        kind,
        stagedBatch: null,
        // `fits` batches carry no structural work: their bytes land in one
        // queue-ordered in-place write at the flip.
        structuralDone: kind === "fits",
        streamedBytes: 0,
      });
    }
    build.stagedBatches.clear();
    this.pendingPublication = {
      coordinates: build.coordinates,
      signature: build.signature,
      configurationSignature: build.configurationSignature,
      recordOrigin: build.recordOrigin,
      observerX: build.observerX,
      observerZ: build.observerZ,
      observerSensitive: build.observerSensitive,
      source: build.source,
      statistics,
      uploads,
    };
  }

  /**
   * One bounded slice of publication work: capped structural creation, then
   * budget-limited byte streaming into disabled buffers, then — only once
   * both are complete — the atomic flip.
   */
  private advancePendingPublication(currentOrigin: DetailFloatingOrigin): void {
    const publication = this.pendingPublication;
    if (!publication) return;

    // Structural phase: clone+bind+resetDrawCache, on DISABLED meshes that
    // have never rendered (the 4.5-0-safe window), at most
    // DETAIL_PUBLICATION_STRUCTURAL_CREATIONS_PER_UPDATE per update.
    let creations = 0;
    for (const upload of publication.uploads) {
      if (upload.structuralDone) continue;
      if (creations >= DETAIL_PUBLICATION_STRUCTURAL_CREATIONS_PER_UPDATE) break;
      const staged = this.createDetailBatchMesh(
        upload.prototypeKey,
        publication.coordinates,
      );
      if (upload.packed.byteLength > 0) {
        staged.gpu = this.acquireInstanceCapacity(upload.packed.byteLength);
        this.bindInstanceBuffers(staged);
      }
      upload.stagedBatch = staged;
      upload.structuralDone = true;
      creations += 1;
    }

    // Streaming phase: packed records flow into the disabled staged buffers
    // under the per-update byte budget. Nothing here is visible — the staged
    // meshes stay disabled until the flip.
    let budget = DETAIL_PUBLICATION_STREAM_BYTES_PER_UPDATE;
    for (const upload of publication.uploads) {
      if (upload.kind === "fits" || !upload.structuralDone) continue;
      const gpu = upload.stagedBatch?.gpu;
      if (!gpu) continue;
      while (upload.streamedBytes < upload.packed.byteLength && budget > 0) {
        const sliceLength = Math.min(
          budget,
          upload.packed.byteLength - upload.streamedBytes,
        );
        gpu.shared.updateDirectly(
          upload.packed.subarray(
            upload.streamedBytes,
            upload.streamedBytes + sliceLength,
          ),
          upload.streamedBytes,
          undefined,
          true,
        );
        upload.streamedBytes += sliceLength;
        budget -= sliceLength;
        this.capturePublishedBytes = addDiagnosticCount(
          this.capturePublishedBytes,
          sliceLength,
        );
      }
      if (budget <= 0) break;
    }

    const ready = publication.uploads.every((upload) =>
      upload.structuralDone
      && (upload.kind === "fits" || upload.streamedBytes >= upload.packed.byteLength));
    if (ready) this.flipPendingPublication(publication, currentOrigin);
  }

  /**
   * The atomic flip: enable the staged meshes, perform the queue-ordered
   * in-place `fits` writes, swap the live batch set, update counts and
   * bounding info. The chunk is never half-published — everything above is
   * observable in this one synchronous commit, exactly as the old
   * single-frame publication was.
   */
  private flipPendingPublication(
    publication: PendingDetailPublication,
    currentOrigin: DetailFloatingOrigin,
  ): void {
    const chunk = this.presentationChunks.get(publication.coordinates.key);
    if (!chunk) {
      this.cancelPendingPublication();
      return;
    }
    const nextRevision = chunk.revision + 1;
    const nextBatchKeys = new Set<string>();
    let publishedRecords = 0;
    for (const upload of publication.uploads) {
      publishedRecords += upload.writer.count;
      nextBatchKeys.add(upload.batchKey);
      if (upload.kind === "fits") {
        const batch = this.batches.get(upload.batchKey);
        if (!batch) {
          // Defensive: `fits` implies a live batch existed at staging and
          // nothing removes one mid-publication; if that ever changes, the
          // staged writer must still return to the bounded pool.
          this.releaseDetailBuildStorage(upload.prototypeKey, upload.writer, upload.bounds);
          continue;
        }
        const displacedWriter = batch.writer;
        const displacedBounds = batch.bounds;
        batch.writer = upload.writer;
        batch.bounds = upload.bounds;
        batch.filledRevision = nextRevision;
        this.uploadBatch(batch, publication.recordOrigin, currentOrigin);
        this.releaseDetailBuildStorage(
          upload.prototypeKey,
          displacedWriter,
          displacedBounds,
        );
      } else {
        const staged = upload.stagedBatch;
        if (!staged) continue;
        if (upload.kind === "grow") {
          // The outgrown live batch retires through the ordinary grace/pool
          // path — RECYCLED, never destroyed in flight (the pool law).
          this.retireBatch(upload.batchKey);
        }
        staged.writer = upload.writer;
        staged.bounds = upload.bounds;
        staged.filledRevision = nextRevision;
        this.batches.set(upload.batchKey, staged);
        this.finalizeStreamedBatch(staged, publication.recordOrigin, currentOrigin);
        if (upload.kind === "create" && staged.mesh.isEnabled()) {
          // Defect C fix: only a mesh created BY this publication ramps —
          // a `grow` replacement re-publishes existing content and must not
          // blink the chunk by restarting a reveal.
          this.startRevealRamp(staged.mesh);
        }
      }
    }

    // Only now is it safe to remove batches absent from the completed target.
    // Their existing allocations keep the unchanged retirement/pool path.
    for (const batchKey of chunk.batchKeys) {
      if (!nextBatchKeys.has(batchKey)) this.retireBatch(batchKey);
    }
    chunk.batchKeys.clear();
    for (const batchKey of nextBatchKeys) chunk.batchKeys.add(batchKey);
    chunk.revision = nextRevision;
    chunk.statistics = publication.statistics;
    chunk.signature = publication.signature;
    chunk.observerX = publication.observerX;
    chunk.observerZ = publication.observerZ;
    chunk.observerSensitive = publication.observerSensitive;
    chunk.validitySuppressed = false;
    chunk.staleVisible = false;
    publication.uploads.length = 0;
    this.pendingPublication = null;
    this.lastPublicationObserverDriftMeters = publication.observerSensitive
      ? Math.hypot(
          this.observerX - publication.observerX,
          this.observerZ - publication.observerZ,
        )
      : 0;
    this.presentationBuildPublications += 1;
    if (publication.source === "worker") {
      this.presentationWorkerBuildPublications = addDiagnosticCount(
        this.presentationWorkerBuildPublications,
      );
    }
    this.presentationPublishedRecords = addDiagnosticCount(
      this.presentationPublishedRecords,
      publishedRecords,
    );
    // Backstop, applied atomically with the flip: if the published snapshot
    // is already pathologically stale, it must not be enabled for even one
    // frame; the sweep keeps the chunk dirty and rebuilds it.
    this.suppressInvalidPresentationChunks();
  }

  /**
   * Releases a staged publication. Staged meshes have never rendered, so
   * disposing them is safe; their allocations still return through the pool
   * (an unreferenced buffer waits out the grace window harmlessly).
   */
  private cancelPendingPublication(): void {
    const publication = this.pendingPublication;
    if (!publication) return;
    for (const upload of publication.uploads) {
      const staged = upload.stagedBatch;
      if (staged) {
        staged.mesh.dispose(false, false);
        if (staged.gpu) this.recycleInstanceBuffers(staged.gpu);
        staged.gpu = null;
        this.revealRamps.delete(staged.mesh);
      }
      this.releaseDetailBuildStorage(
        upload.prototypeKey,
        upload.writer,
        upload.bounds,
      );
    }
    publication.uploads.length = 0;
    this.pendingPublication = null;
    this.presentationBuildCancellations = addDiagnosticCount(
      this.presentationBuildCancellations,
    );
  }

  /**
   * Finalizes a batch whose bytes were already streamed into its allocation:
   * everything `uploadBatch` does except the byte upload itself.
   */
  private finalizeStreamedBatch(
    batch: DetailBatch,
    recordOrigin: DetailFloatingOrigin,
    currentOrigin: DetailFloatingOrigin,
  ): void {
    const count = batch.writer.count;
    batch.mesh.forcedInstanceCount = 0;
    if (count === 0 || batch.gpu === null) {
      batch.mesh.setEnabled(false);
      return;
    }
    // Restore the cached CPU mirror a whole-range `updateDirectly` would
    // have kept: partial-range streamed writes null Babylon's `Buffer._data`,
    // and `getVertexBuffer(...).getData()` readbacks rely on it.
    (batch.gpu.shared as unknown as { _data: unknown })._data = batch.writer.finish();
    batch.mesh.setEnabled(true);
    batch.mesh.forcedInstanceCount = count;
    batch.mesh.setBoundingInfo(new BoundingInfo(
      Vector3.FromArray(batch.bounds.minimum()),
      Vector3.FromArray(batch.bounds.maximum()),
    ));
    batch.builtOrigin.x = recordOrigin.x;
    batch.builtOrigin.y = recordOrigin.y;
    batch.builtOrigin.z = recordOrigin.z;
    batch.mesh.position.set(
      recordOrigin.x - currentOrigin.x,
      recordOrigin.y - currentOrigin.y,
      recordOrigin.z - currentOrigin.z,
    );
  }

  /** Starts a newly created mesh's stochastic vertex-stage reveal (defect C). */
  private startRevealRamp(mesh: Mesh): void {
    const metadata = (mesh.metadata ?? (mesh.metadata = {})) as Record<string, unknown>;
    metadata["detailReveal"] = 0;
    this.revealRamps.set(mesh, {
      startSeconds: this.windTimeSeconds,
      startUpdate: this.updateSequence,
    });
    this.captureRevealRampsStarted = addDiagnosticCount(this.captureRevealRampsStarted);
  }

  /**
   * Ramps every revealing mesh's `detailReveal` 0 -> 1. The simulation clock
   * drives it (capture reruns stay pixel-comparable); the update-count term
   * is a fallback so a stalled clock cannot pin a chunk invisible.
   */
  private advanceRevealRamps(): void {
    if (this.revealRamps.size === 0) return;
    for (const [mesh, start] of this.revealRamps) {
      const timeShare =
        (this.windTimeSeconds - start.startSeconds) / DETAIL_REVEAL_RAMP_SECONDS;
      const updateShare =
        (this.updateSequence - start.startUpdate) / DETAIL_REVEAL_RAMP_UPDATES;
      const reveal = Math.max(timeShare, updateShare);
      const metadata = mesh.metadata as Record<string, unknown> | null;
      if (reveal >= 1 || mesh.isDisposed() || !metadata) {
        if (!mesh.isDisposed() && metadata) metadata["detailReveal"] = 1;
        this.revealRamps.delete(mesh);
      } else {
        metadata["detailReveal"] = Math.max(0, reveal);
      }
    }
  }

  /**
   * Fail-closed BACKSTOP for a pathologically stale observer snapshot
   * (defect A fix: the policy is stale-but-visible). A chunk whose baked
   * observer merely drifted past the 96 m membership slack stays enabled
   * and RENDERING while its replacement build is pending or queued — the
   * fragment band windows already compute fades from the LIVE camera
   * position, and near/mid share identical hull geometry, so the visible
   * error of a stale snapshot is minor; the old whole-chunk suppression at
   * 96 m was the "trees jump in and out" defect. Only past
   * `DETAIL_SUPPRESSION_BACKSTOP_METERS` is the chunk hidden. Suppression
   * remains deliberately not retirement: meshes, CPU writers and WebGPU
   * buffers keep their existing owners and lifetimes until a valid atomic
   * publication overwrites them, and the dirty/backlog path remains active.
   */
  private suppressInvalidPresentationChunks(): boolean {
    let suppressed = false;
    for (const chunk of this.presentationChunks.values()) {
      if (
        chunk.revision === 0
        || !chunk.observerSensitive
        || chunk.validitySuppressed
      ) continue;
      const drift = Math.hypot(
        this.observerX - chunk.observerX,
        this.observerZ - chunk.observerZ,
      );
      if (drift > DETAIL_SUPPRESSION_BACKSTOP_METERS) {
        chunk.validitySuppressed = true;
        chunk.staleVisible = false;
        this.captureSuppressedChunks = addDiagnosticCount(this.captureSuppressedChunks);
        for (const batchKey of chunk.batchKeys) {
          this.batches.get(batchKey)?.mesh.setEnabled(false);
        }
        suppressed = true;
      } else if (drift > DETAIL_MEMBERSHIP_SLACK_METERS) {
        if (!chunk.staleVisible) {
          chunk.staleVisible = true;
          this.captureStaleVisibleChunks = addDiagnosticCount(
            this.captureStaleVisibleChunks,
          );
        }
      } else if (chunk.staleVisible) {
        chunk.staleVisible = false;
      }
    }
    return suppressed;
  }

  private getStagedBatch(
    prototypeKey: string,
    stagedBatches: Map<string, StagedDetailBatch>,
  ): StagedDetailBatch {
    const existing = stagedBatches.get(prototypeKey);
    if (existing) return existing;
    const prototype = this.prototypes.get(prototypeKey);
    if (!prototype) throw new Error(`Missing detail prototype ${prototypeKey}`);
    const storage = this.acquireDetailBuildStorage(prototypeKey);
    const staged: StagedDetailBatch = {
      prototypeKey,
      writer: storage.writer,
      bounds: storage.bounds,
      prototypeBoundKernel: prototype.boundKernel,
    };
    stagedBatches.set(prototypeKey, staged);
    return staged;
  }

  private acquireDetailBuildStorage(prototypeKey: string): PooledDetailBuildStorage {
    const pooled = this.detailBuildStoragePool.get(prototypeKey);
    if (pooled) {
      this.detailBuildStoragePool.delete(prototypeKey);
      pooled.writer.reset();
      pooled.bounds.reset();
      return pooled;
    }
    return {
      writer: new DetailInstanceWriter(),
      bounds: new DetailInstanceBounds(),
    };
  }

  private releaseDetailBuildStorage(
    prototypeKey: string,
    writer: DetailInstanceWriter,
    bounds: DetailInstanceBounds,
  ): void {
    // One active staged chunk means one spare per prototype is sufficient.
    // Refuse a second entry explicitly rather than letting structural churn
    // turn this CPU-only pool into an unbounded cache.
    if (this.detailBuildStoragePool.has(prototypeKey)) return;
    writer.reset();
    bounds.reset();
    this.detailBuildStoragePool.set(prototypeKey, { writer, bounds });
  }

  private releaseStagedBuildStorage(build: PendingDetailChunkBuild): void {
    for (const staged of build.stagedBatches.values()) {
      this.releaseDetailBuildStorage(
        staged.prototypeKey,
        staged.writer,
        staged.bounds,
      );
    }
    build.stagedBatches.clear();
  }

  /**
   * 2-11a: one interleaved 32-byte-stride buffer per batch (the pooled
   * writer's exact byte range), exposed as five typed instanced vertex
   * buffers.
   *
   * Perf-debt pass — the named "instance-buffer reuse" rung. A rebuild that
   * fits inside the existing allocation now writes into it (`writeBuffer`,
   * queue-ordered after the previous submit) and touches nothing else: no
   * `Buffer`, no `VertexBuffer`, no `resetDrawCache` — which is the
   * expensive half, because it invalidates the mesh's draw wrappers and
   * forces Babylon to rebuild pipeline and bind groups for every pass the
   * mesh appears in. Only GROWTH allocates, and the outgrown allocation
   * waits out the same conservative grace window a retired batch does.
   */
  private uploadBatch(
    batch: DetailBatch,
    recordOrigin: DetailFloatingOrigin,
    currentOrigin: DetailFloatingOrigin,
  ): void {
    const count = batch.writer.count;
    batch.mesh.forcedInstanceCount = 0;
    if (count === 0) {
      batch.mesh.setEnabled(false);
      return;
    }
    batch.mesh.setEnabled(true);
    const packed = batch.writer.finish();
    if (batch.gpu !== null && packed.byteLength <= batch.gpu.capacityBytes) {
      // vertexCount stays undefined on purpose: Babylon drops its cached
      // `_data` reference whenever a partial range is written, and that
      // reference is what `getVertexBuffer(...).getData()` reads back.
      batch.gpu.shared.updateDirectly(packed, 0, undefined, true);
      this.capturePublishedBytes = addDiagnosticCount(
        this.capturePublishedBytes,
        packed.byteLength,
      );
    } else {
      if (batch.gpu !== null) this.recycleInstanceBuffers(batch.gpu);
      batch.gpu = this.acquireInstanceBuffers(packed);
      this.bindInstanceBuffers(batch);
    }
    batch.mesh.forcedInstanceCount = count;
    // Generator-computed bounds — thinInstanceRefreshBoundingInfo has no
    // matrix buffer to walk anymore, and the wind extent is already an
    // explicit term in the accumulator.
    batch.mesh.setBoundingInfo(new BoundingInfo(
      Vector3.FromArray(batch.bounds.minimum()),
      Vector3.FromArray(batch.bounds.maximum()),
    ));
    batch.builtOrigin.x = recordOrigin.x;
    batch.builtOrigin.y = recordOrigin.y;
    batch.builtOrigin.z = recordOrigin.z;
    batch.mesh.position.set(
      recordOrigin.x - currentOrigin.x,
      recordOrigin.y - currentOrigin.y,
      recordOrigin.z - currentOrigin.z,
    );
  }

  /** Keeps stale, origin-relative records world-stable during the rebuild sweep. */
  private compensateBatchOrigins(floatingOrigin: DetailFloatingOrigin): void {
    for (const batch of this.batches.values()) {
      batch.mesh.position.set(
        batch.builtOrigin.x - floatingOrigin.x,
        batch.builtOrigin.y - floatingOrigin.y,
        batch.builtOrigin.z - floatingOrigin.z,
      );
    }
  }

  /**
   * Takes a pooled allocation big enough for `packed`, or makes one. Pooled
   * entries are searched smallest-fit-first so a large buffer is not spent
   * on a small batch and then unavailable to the batch that needs it.
   */
  private acquireInstanceBuffers(packed: Uint8Array): DetailInstanceGpuBuffers {
    const gpu = this.acquireInstanceCapacity(packed.byteLength);
    gpu.shared.updateDirectly(packed, 0, undefined, true);
    this.capturePublishedBytes = addDiagnosticCount(
      this.capturePublishedBytes,
      packed.byteLength,
    );
    return gpu;
  }

  /**
   * Takes a pooled allocation of at least `byteLength`, or makes one, WITHOUT
   * writing content — the streamed-publication path fills it slice by slice
   * under the per-update byte budget while its owner mesh stays disabled.
   */
  private acquireInstanceCapacity(byteLength: number): DetailInstanceGpuBuffers {
    let bestIndex = -1;
    for (let index = 0; index < this.instanceBufferPool.length; index += 1) {
      const entry = this.instanceBufferPool[index]!;
      if (entry.reusableAfterUpdate > this.updateSequence) continue;
      if (entry.gpu.capacityBytes < byteLength) continue;
      if (
        bestIndex < 0
        || entry.gpu.capacityBytes < this.instanceBufferPool[bestIndex]!.gpu.capacityBytes
      ) {
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      const [entry] = this.instanceBufferPool.splice(bestIndex, 1);
      return entry!.gpu;
    }
    // Grow with headroom so a slowly filling chunk does not reallocate on
    // every rebuild; the record is 32 bytes, so the slack is cheap.
    const capacityBytes = Math.max(
      DETAIL_INSTANCE_STRIDE_BYTES,
      Math.ceil((byteLength * 1.5) / DETAIL_INSTANCE_STRIDE_BYTES)
        * DETAIL_INSTANCE_STRIDE_BYTES,
    );
    const backing = new Uint8Array(capacityBytes);
    return {
      shared: new Buffer(
        this.scene.getEngine(),
        backing,
        true,
        DETAIL_INSTANCE_STRIDE_BYTES,
        false,
        true,
        true,
      ),
      capacityBytes,
    };
  }

  /** Exposes one allocation to a mesh as the five typed instanced streams. */
  private bindInstanceBuffers(batch: DetailBatch): void {
    const gpu = batch.gpu;
    if (!gpu) return;
    const engine = this.scene.getEngine();
    const typeFor = (name: string): number =>
      name === "float" ? VertexBuffer.FLOAT
      : name === "snorm16" ? VertexBuffer.SHORT
      : name === "unorm16" ? VertexBuffer.UNSIGNED_SHORT
      : VertexBuffer.UNSIGNED_BYTE;
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      batch.mesh.setVerticesBuffer(
        new VertexBuffer(engine, gpu.shared, attribute.kind, {
          updatable: true,
          instanced: true,
          size: attribute.size,
          offset: attribute.byteOffset,
          stride: DETAIL_INSTANCE_STRIDE_BYTES,
          useBytes: true,
          type: typeFor(attribute.type),
          normalized: attribute.normalized,
        }),
        false,
      );
    }
    batch.mesh.resetDrawCache(undefined, true);
    this.captureReboundBatches = addDiagnosticCount(this.captureReboundBatches);
  }

  /** Returns an allocation to the pool; nothing is destroyed in flight. */
  private recycleInstanceBuffers(gpu: DetailInstanceGpuBuffers): void {
    this.instanceBufferPool.push({
      gpu,
      reusableAfterUpdate:
        this.updateSequence + DETAIL_INSTANCE_BUFFER_REUSE_GRACE_UPDATES,
    });
  }

  /** Bytes held by pooled allocations — the memory the pool is trading. */
  get pooledInstanceBytes(): number {
    let bytes = 0;
    for (const pooled of this.instanceBufferPool) bytes += pooled.gpu.capacityBytes;
    return bytes;
  }

  private refreshVisibilityStatistics(): void {
    let renderedThinInstances = 0;
    let activeBatches = 0;
    const camera = this.scene.activeCamera;
    for (const batch of this.batches.values()) {
      if (!batch.mesh.isEnabled() || batch.mesh.forcedInstanceCount <= 0) continue;
      if (camera && !camera.isInFrustum(batch.mesh)) continue;
      renderedThinInstances += batch.mesh.forcedInstanceCount;
      activeBatches += 1;
    }
    this.statisticsValue = {
      ...this.statisticsValue,
      renderedThinInstances,
      activeBatches,
    };
  }

  /**
   * 2-14: which render bands a stem at this range belongs to, with the
   * dither-crossfade fades. Inside a margin the stem carries TWO
   * memberships whose fade bytes are exact complements (outgoing
   * `fade = t`, incoming `fade = 1 - t` with the incoming comparison
   * flipped in the fragment); at the cull radius the far band fades out
   * against nothing. Margins clear the 128 m generation cell so a
   * boundary sweeps smoothly across rebuilds.
   */
  static fadeBandMemberships(
    distanceMeters: number,
    law: RenderedDensityLaw,
  ) {
    return detailFadeBandMemberships(distanceMeters, law);
  }

  /**
   * 2-17 close: the chunk's observer signature term. Frontier chunks (any
   * band/population edge within the chunk's padded distance envelope) carry
   * the 64 m-quantized observer so memberships and baked edge fades
   * re-bake as the frontier sweeps; interior chunks carry a constant.
   */
  /** Distance from the live observer to the chunk's XZ rectangle (0 inside). */
  private chunkMinimumDistanceMeters(
    coordinates: DetailPresentationChunkCoordinates,
  ): number {
    const minX = coordinates.minCellX * this.cellSizeMeters;
    const minZ = coordinates.minCellZ * this.cellSizeMeters;
    const maxX = coordinates.maxCellX * this.cellSizeMeters;
    const maxZ = coordinates.maxCellZ * this.cellSizeMeters;
    const nearestX = clamp(this.observerX, minX, maxX);
    const nearestZ = clamp(this.observerZ, minZ, maxZ);
    return Math.hypot(nearestX - this.observerX, nearestZ - this.observerZ);
  }

  private chunkObserverTerm(coordinates: DetailPresentationChunkCoordinates): string {
    const law = this.lastDensityLaw;
    const minX = coordinates.minCellX * this.cellSizeMeters;
    const minZ = coordinates.minCellZ * this.cellSizeMeters;
    // `maxCell*` is already exclusive (spatialChunks.ts); adding one here
    // widened every frontier test by a whole cell and scheduled needless
    // observer rebuilds, especially for negative chunks.
    const maxX = coordinates.maxCellX * this.cellSizeMeters;
    const maxZ = coordinates.maxCellZ * this.cellSizeMeters;
    const nearestX = clamp(this.observerX, minX, maxX);
    const nearestZ = clamp(this.observerZ, minZ, maxZ);
    const minDistance = Math.hypot(nearestX - this.observerX, nearestZ - this.observerZ);
    const cornerDistance = Math.max(
      Math.hypot(minX - this.observerX, minZ - this.observerZ),
      Math.hypot(maxX - this.observerX, minZ - this.observerZ),
      Math.hypot(minX - this.observerX, maxZ - this.observerZ),
      Math.hypot(maxX - this.observerX, maxZ - this.observerZ),
    );
    const pad = DETAIL_FADE_MARGIN_METERS + DETAIL_MEMBERSHIP_SLACK_METERS
      + DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS;
    const cullPad = DETAIL_CULL_FADE_MARGIN_METERS + DETAIL_MEMBERSHIP_SLACK_METERS
      + DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS;
    const edges: readonly (readonly [number, number])[] = [
      [law.near.outerRadiusMeters, pad],
      [law.mid.outerRadiusMeters, pad],
      [law.far.outerRadiusMeters, cullPad],
      [
        this.lastGrassRadius,
        GROUND_COVER_EDGE_FADE_METERS + DETAIL_MEMBERSHIP_SLACK_METERS
          + DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS,
      ],
    ];
    for (const [edge, padding] of edges) {
      if (minDistance - padding <= edge && cornerDistance + padding >= edge) {
        return `f${Math.round(this.observerX / DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS)}`
          + `:${Math.round(this.observerZ / DETAIL_PRESENTATION_OBSERVER_QUANTUM_METERS)}`;
      }
    }
    return "interior";
  }

  /**
   * Builds a DISABLED batch mesh for a staged publication. Deliberately NOT
   * registered in `this.batches` — the staged mesh joins the live set only
   * at the publication flip, so shadow-caster enumeration, visibility
   * statistics and origin compensation never see a half-published batch.
   */
  private createDetailBatchMesh(
    prototypeKey: string,
    coordinates: DetailPresentationChunkCoordinates,
  ): DetailBatch {
    // Perf-debt pass: the key no longer carries the chunk revision. It used
    // to, so every rebuild published a whole new set of meshes — a clone, a
    // `makeGeometryUnique` copy of the prototype geometry and a fresh GPU
    // instance buffer per (prototype, chunk) on every 64 m observer quantum,
    // with the previous set kept alive for four more updates. The immutable
    // publication was there because destroying a buffer a render bundle may
    // still reference is a validation error; reusing one is not — a
    // `writeBuffer` is ordered on the queue against the previous submit — so
    // the batch survives and `uploadBatch` writes into it in place.
    const batchKey = `${prototypeKey}@${coordinates.key}`;
    const prototype = this.prototypes.get(prototypeKey);
    if (!prototype) throw new Error(`Missing detail prototype ${prototypeKey}`);
    const mesh = prototype.mesh.clone(
      `detail-${prototypeKey}-chunk-${coordinates.key}`,
      null,
      true,
    );
    if (!mesh) throw new Error(`Unable to create detail batch ${batchKey}`);
    // Mesh clones normally share one Geometry. Thin-instance vertex buffers
    // live on that Geometry in Babylon, so sharing it would make one spatial
    // chunk overwrite (and destroy) another chunk's matrix/color/wind buffers.
    // Prototypes are deliberately low-poly; a unique lightweight Geometry per
    // batch keeps those instance streams independent while materials remain
    // shared across every chunk.
    mesh.makeGeometryUnique();
    mesh.material = prototype.material;
    mesh.isPickable = false;
    mesh.useVertexColors = true;
    // INHERITED, never forced: the impostor prototype opts out — with
    // front_facing and the three blend varyings, 4-cascade shadow inputs
    // push its fragment past the 16-input limit (measured 17: nine CSM
    // lanes + tint + A/B/C + a wasted fade lane), and one invalid pipeline
    // poisons the whole render bundle to a black frame.
    mesh.receiveShadows = prototype.mesh.receiveShadows;
    mesh.alwaysSelectAsActiveMesh = false;
    mesh.setEnabled(false);
    mesh.metadata = {
      detailBatch: prototypeKey,
      detailChunk: coordinates.key,
      detailChunkX: coordinates.x,
      detailChunkZ: coordinates.z,
      detailChunkMinCellX: coordinates.minCellX,
      detailChunkMinCellZ: coordinates.minCellZ,
      detailChunkMaxCellX: coordinates.maxCellX,
      detailChunkMaxCellZ: coordinates.maxCellZ,
      detailCastsShadow: prototype.castsShadows,
      // Defect C: 1 = fully revealed. Only a flip that first creates the
      // mesh sets 0 and ramps; every other binding site is unaffected.
      detailReveal: 1,
    };
    this.captureCreatedBatches = addDiagnosticCount(this.captureCreatedBatches);
    return {
      mesh,
      castsShadows: prototype.castsShadows,
      prototypeKey,
      chunkKey: coordinates.key,
      writer: new DetailInstanceWriter(),
      bounds: new DetailInstanceBounds(),
      prototypeBoundKernel: prototype.boundKernel,
      gpu: null,
      filledRevision: 0,
      builtOrigin: { x: 0, y: 0, z: 0 },
    };
  }

  private retireBatch(batchKey: string): void {
    const batch = this.batches.get(batchKey);
    if (!batch) return;
    batch.mesh.setEnabled(false);
    this.revealRamps.delete(batch.mesh);
    this.batches.delete(batchKey);
    this.retiredBatches.push({
      batch,
      disposeAfterUpdate: this.updateSequence + 4,
    });
  }

  private disposeExpiredBatches(): void {
    let writeIndex = 0;
    for (const retired of this.retiredBatches) {
      if (retired.disposeAfterUpdate <= this.updateSequence) {
        retired.batch.mesh.dispose(false, false);
        // A VertexBuffer built over an existing Buffer does NOT own it (and
        // Babylon 9.21.2 never increments the shared Buffer's reference
        // count either), so disposing the mesh releases nothing. The
        // allocation goes to the pool instead of being destroyed — see
        // PooledInstanceBuffers.
        if (retired.batch.gpu) this.recycleInstanceBuffers(retired.batch.gpu);
        retired.batch.gpu = null;
        continue;
      }
      this.retiredBatches[writeIndex] = retired;
      writeIndex += 1;
    }
    this.retiredBatches.length = writeIndex;

  }

  private disposePresentationChunk(chunk: DetailPresentationChunk): void {
    for (const batchKey of chunk.batchKeys) this.retireBatch(batchKey);
    chunk.batchKeys.clear();
    this.presentationChunks.delete(chunk.coordinates.key);
  }

  private nowMilliseconds(): number {
    return typeof performance === "undefined" ? Date.now() : performance.now();
  }

  private createBatches(): void {
    // 2-12: the foliage atlas's FIRST sampler. Under NullEngine (no raw
    // 2D-array support) the atlas is skipped and materials compile without
    // the atlas define — geometry and instancing stay fully testable.
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (engineFlags.isWebGPU || engineFlags._gl) {
      this.foliageAtlas = createFoliageAtlas(this.scene, this.options.worldSeed);
      // 2-17: the far band's octahedral impostors, baked on the CPU from
      // the same seed (byte-deterministic; ~0.4 s once at startup).
      this.impostorAtlas = createImpostorAtlas(this.scene, this.options.worldSeed);
    }

    // Near trees use species-specific closed crown lobes/whorls and mid trees
    // use one family-shaped closed hull; far trees retain the impostor.
    // Prototypes are unit-height with true proportions, so the
    // instance's radial multiplier is solved against the exact concrete
    // prototype bound (species, variant and band).
    // Bark stays back-face-culled in its own batch while foliage is
    // two-sided: zero extra draw calls per the plan.
    const prototypeSeed = 7;
    for (const species of TREE_SPECIES) {
      const variantCount = clamp(
        Math.round(TREE_VARIANT_COUNTS[species]),
        1,
        32,
      );
      this.impostorFrames.set(species, impostorBakeFrame(species, prototypeSeed));
      const crownMaterial = this.createMaterial(
        `detail-foliage-${species}`,
        new Color3(...DETAIL_CROWN_ALBEDO),
        0.94,
        true,
      );
      this.registerBandFadeMaterial(crownMaterial);
      crownMaterial.backFaceCulling = false;
      crownMaterial.twoSidedLighting = true;
      // Wave T: the card shell is now the whole visible canopy, and its
      // dome-blended top cards face the sky — at full specular they mirrored
      // the sky probe as a teal sheen across every crown top in the noon
      // captures. Leaves are rough dielectrics; kill the sheen.
      crownMaterial.specularIntensity = 0.4;
      // Wave P: the shaded card faces are ambient-dominated, and full-strength
      // sky irradiance lifted their blue channel to ~0.8×green (terrain sits
      // at ~0.64) — the residual cold cast after the specular cut. Real
      // canopies self-shadow far more than a card shell can; trim the probe
      // and let the sun carry the tone.
      crownMaterial.environmentIntensity = 0.62;
      // R-2E's mandated mitigation: canopy renders in the alpha-test bucket,
      // AFTER opaque terrain and trunks have filled the depth buffer, so
      // early-Z kills every canopy fragment behind a ridge or a trunk before
      // its two-sided PBR shading runs. The built-in test itself is a no-op
      // here (no albedo texture, material alpha 1) — the plugin's atlas
      // discard is the real test; this move is purely about draw order.
      crownMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
      const opaqueCrownMaterial = this.createMaterial(
        `detail-foliage-${species}-opaque-crown`,
        new Color3(...DETAIL_CROWN_ALBEDO),
        0.9,
        true,
      );
      // This is a distinct compiled material, not merely alpha=1 card art:
      // it contains no fragment discard, is in the opaque queue and is
      // one-sided, allowing early-Z/back-face rejection to remove the
      // vegetation fill bottleneck measured in the forest captures.
      this.materialPlugin(opaqueCrownMaterial)?.setOpaqueCrown(true);
      this.registerBandFadeMaterial(opaqueCrownMaterial);
      opaqueCrownMaterial.backFaceCulling = true;
      opaqueCrownMaterial.twoSidedLighting = false;
      opaqueCrownMaterial.transparencyMode = Material.MATERIAL_OPAQUE;
      // Wave P: same probe trim as the card shell — the interior core peeks
      // through card gaps and must not read bluer than the cards over it.
      opaqueCrownMaterial.environmentIntensity = 0.62;
      // Wave Q: specular parity too — this hull kept createMaterial's 1.0
      // while the cards and impostor run 0.4, so at a grazing dusk sun the
      // mid band's interior flared against both neighbours at the handoffs.
      opaqueCrownMaterial.specularIntensity = 0.4;
      const barkMaterial = this.createMaterial(
        `detail-bark-${species}`,
        new Color3(0.58, 0.52, 0.46),
        0.93,
        true,
      );
      this.registerBandFadeMaterial(barkMaterial);
      for (let variant = 0; variant < variantCount; variant += 1) {
        const prototype = buildTreePrototype(species, variant, prototypeSeed);
        // Wave T: EVERY part of a tree (bark skeleton, interior core, card
        // shell) registers the shared skeleton envelope as its radial
        // contract, so the presentation build maps all parts with one world
        // scale and they stay exactly aligned.
        const envelopeUnit = Math.max(prototype.envelopeRadius, 0.05);
        if (variant === 0) {
          // The far atlas is baked from this exact source geometry.
          this.impostorRadialUnits.set(species, envelopeUnit);
        }
        this.prototypeRadialUnits.set(
          `tree-${species}-v${variant}-crown-near`,
          envelopeUnit,
        );
        this.prototypeRadialUnits.set(
          `tree-${species}-v${variant}-trunk-near`,
          envelopeUnit,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-crown-near`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-crown`, prototype.crown),
          opaqueCrownMaterial,
          true,
          {
            ...prototype.crown.localBounds,
            // DETAIL_OPAQUE_CROWN contracts xz toward zero and y toward
            // 0.42h for winter thinning.
            contractionPivotYUnit: 0.42,
          },
        );
        this.registerBatch(
          `tree-${species}-v${variant}-trunk-near`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-trunk`, prototype.trunk),
          barkMaterial,
          true,
          prototype.trunk.localBounds,
        );
        // Wave T: the leaf-cluster card shell is the visible canopy at both
        // geometry bands (the interior core pre-fills depth behind it, so the
        // early-Z keystone survives the cards carrying the look).
        const fringe = buildCrownFringePrototype(species, variant, prototypeSeed, "near");
        this.prototypeRadialUnits.set(
          `tree-${species}-v${variant}-fringe-near`,
          envelopeUnit,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-fringe-near`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-fringe`, fringe),
          crownMaterial,
          true,
          fringe.localBounds,
        );
        const fringeMid = buildCrownFringePrototype(species, variant, prototypeSeed, "mid");
        this.prototypeRadialUnits.set(
          `tree-${species}-v${variant}-fringe-mid`,
          envelopeUnit,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-fringe-mid`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-fringe-mid`, fringeMid),
          crownMaterial,
          false,
          fringeMid.localBounds,
        );
        // Mid meshes the SAME skeleton at reduced detail, so the near/mid
        // handoff keeps the silhouette. Far is the impostor crown only.
        const midPrototype = buildTreePrototype(species, variant, prototypeSeed, "mid");
        const farPrototype = buildTreePrototype(species, variant, prototypeSeed, "far");
        this.prototypeRadialUnits.set(
          `tree-${species}-v${variant}-crown-mid`,
          envelopeUnit,
        );
        this.prototypeRadialUnits.set(
          `tree-${species}-v${variant}-trunk-mid`,
          envelopeUnit,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-crown-mid`,
          this.buildPrototypeMesh(
            `detail-tree-${species}-v${variant}-crown-mid`,
            midPrototype.crown,
          ),
          opaqueCrownMaterial,
          false,
          {
            ...midPrototype.crown.localBounds,
            contractionPivotYUnit: 0.42,
          },
        );
        this.registerBatch(
          `tree-${species}-v${variant}-trunk-mid`,
          this.buildPrototypeMesh(
            `detail-tree-${species}-v${variant}-trunk-mid`,
            midPrototype.trunk,
          ),
          barkMaterial,
          false,
          midPrototype.trunk.localBounds,
        );
        if (variant === 0 && !this.impostorAtlas) {
          // No atlas (NullEngine): the far band keeps 2-12's law-priced
          // crossed cards, one mesh per species.
          this.prototypeRadialUnits.set(
            `tree-${species}-v${variant}-crown-far`,
            Math.max(farPrototype.crown.boundingRadius, 0.05),
          );
          this.registerBatch(
            `tree-${species}-v${variant}-crown-far`,
            this.buildPrototypeMesh(
              `detail-tree-${species}-v${variant}-crown-far`,
              farPrototype.crown,
            ),
            crownMaterial,
            false,
            farPrototype.crown.localBounds,
          );
        }
      }
    }

    if (this.impostorAtlas) {
      // 2-17: the far band is a billboard impostor — one quad, the
      // three-view blend, the two season buckets. Impostors neither cast nor
      // receive shadows (which frees the cascade varyings the blend lanes
      // consume).
      //
      // Perf-debt pass: ONE mesh and ONE material for all seven species.
      // The quad geometry never differed between them; only the bake frame
      // did, and that is a per-species uniform ROW indexed by the instance's
      // variant byte now. The far band spans more presentation chunks than
      // near and mid combined, so this is the pass's single largest
      // draw-call cut — seven draws per far chunk became one.
      // The mid->far handoff is a hard per-stem swap, and any lighting-
      // response difference between the two representations reads as a
      // per-tree material change at the ring — so this material mirrors the
      // CARD SHELL's response exactly (roughness 0.94, specular 0.4, probe
      // 0.62), since wave T made the cards the dominant visible surface.
      const impostorMaterial = this.createMaterial(
        "detail-impostor",
        new Color3(1, 1, 1),
        0.94,
        false,
      );
      impostorMaterial.backFaceCulling = false;
      impostorMaterial.twoSidedLighting = true;
      impostorMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
      impostorMaterial.specularIntensity = 0.4;
      impostorMaterial.environmentIntensity = 0.62;
      this.registerBandFadeMaterial(impostorMaterial);
      this.materialPlugin(impostorMaterial)?.setImpostorAtlas(
        this.impostorAtlas.albedo,
        this.impostorAtlas.normalDepth,
        IMPOSTOR_SPECIES.map((species) => {
          const frame = impostorBakeFrame(species, prototypeSeed);
          return {
            extentUnit: frame.extentUnit,
            centerYUnit: frame.centerYUnit,
            leafedLayer: impostorLayerIndex(species, 0),
            bareLayer: impostorLayerIndex(species, 1),
          };
        }),
      );
      const quad = new Mesh("detail-impostor", this.scene);
      const quadData = new VertexData();
      quadData.positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
      quadData.normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
      quadData.uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
      quadData.indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
      quadData.applyToMesh(quad, false);
      quad.setEnabled(false);
      this.registerBatch(
        TREE_IMPOSTOR_PROTOTYPE_KEY,
        quad,
        impostorMaterial,
        false,
        {
          minimum: [-1, -1, 0],
          maximum: [1, 1, 0],
        },
      );
      // AFTER registerBatch (which forces receive on): impostors must NOT
      // receive shadows — with front_facing (two-sided) and the three blend
      // varyings, the 4-cascade CSM inputs push the fragment past the
      // 16-input limit (17 measured), and one invalid pipeline poisons the
      // whole render bundle to a black frame.
      quad.receiveShadows = false;
    }

    // 2-12b: card shrubs — the flat-shaded icospheres are gone. 12-18
    // alpha-tested foliage quads on a short multi-stem skeleton from the
    // 2-11 atlas layers (hazel broadleaf, juniper scale, sage grey-leaf),
    // with the same atlas sampling, occlusion bake and alpha-test-bucket
    // treatment as tree crowns. Two variants per species; the albedo tint
    // brightens toward white because the perceptual tint distribution now
    // arrives per instance, exactly as it does for trees.
    const shrubColors: Readonly<Record<ShrubSpecies, Color3>> = {
      juniper: new Color3(0.5, 0.56, 0.5),
      hazel: new Color3(0.55, 0.6, 0.48),
      sage: new Color3(0.56, 0.58, 0.53),
    };
    for (const species of SHRUB_SPECIES) {
      const material = this.createMaterial(
        `detail-shrub-${species}-material`,
        shrubColors[species],
        0.91,
        true,
      );
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        const prototype = buildShrubPrototype(species, variant, prototypeSeed);
        this.prototypeRadialUnits.set(
          `shrub-${species}-v${variant}`,
          Math.max(prototype.boundingRadius, 0.05),
        );
        this.registerBatch(
          `shrub-${species}-v${variant}`,
          this.buildPrototypeMesh(`detail-shrub-${species}-v${variant}`, prototype),
          material,
          false,
          prototype.localBounds,
        );
      }
    }

    // 2-15: displaced-icosphere rocks — per-lithology normals live in the
    // prototype (limestone smooth, granite/dark flat: the shading-model
    // difference reads as lithology more strongly than colour does).
    const rockColors: Readonly<Record<RockVariant, Color3>> = {
      granite: new Color3(0.38, 0.39, 0.4),
      limestone: new Color3(0.5, 0.48, 0.41),
      dark: new Color3(0.22, 0.24, 0.25),
    };
    for (const variant of ROCK_VARIANTS) {
      const prototype = buildRockPrototype(variant, prototypeSeed);
      this.prototypeRadialUnits.set(
        `rock-${variant}`,
        Math.max(prototype.boundingRadius, 0.05),
      );
      this.registerBatch(
        `rock-${variant}`,
        this.buildPrototypeMesh(`detail-rock-${variant}`, prototype),
        this.createMaterial(`detail-rock-material-${variant}`, rockColors[variant], 0.94),
        false,
        prototype.localBounds,
      );
    }

    // 2-15: ground clutter — logs, stumps, branch litter, moss cushions.
    // Litter is alpha-tested cards from the 2-11 twig layer, so its material
    // rides the atlas path double-sided; logs and stumps sample bark layers
    // through the same path but stay culled; moss is untextured (−1).
    const clutterKinds: readonly ClutterKind[] = ["log", "stump", "branchLitter", "mossCushion"];
    for (const kind of clutterKinds) {
      const prototype = buildClutterPrototype(kind, prototypeSeed);
      const material = this.createMaterial(
        `detail-clutter-${kind}-material`,
        kind === "mossCushion" ? new Color3(0.62, 0.68, 0.56) : new Color3(0.64, 0.6, 0.55),
        0.95,
        true,
      );
      if (kind === "branchLitter") {
        material.backFaceCulling = false;
        material.twoSidedLighting = true;
        material.transparencyMode = Material.MATERIAL_ALPHATEST;
      }
      this.registerBatch(
        `clutter-${kind}`,
        this.buildPrototypeMesh(`detail-clutter-${kind}`, prototype),
        material,
        false,
        prototype.localBounds,
      );
    }

    // 2-16: ground cover — four habitat archetypes on one blade-patch
    // builder, all riding the atlas path double-sided (blades are
    // alpha-tested textured quads) in the alpha-test bucket.
    const groundCoverArchetypes: readonly GroundCoverArchetype[] = [
      "grass", "fern", "heather", "reed",
    ];
    for (const archetype of groundCoverArchetypes) {
      const prototype = buildGrassPatchPrototype(prototypeSeed, archetype);
      const material = this.createMaterial(
        `detail-ground-${archetype}-material`,
        new Color3(0.85, 0.88, 0.8),
        0.92,
        true,
      );
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      this.registerBatch(
        `ground-${archetype}`,
        this.buildPrototypeMesh(`detail-ground-${archetype}`, prototype),
        material,
        false,
        prototype.localBounds,
      );
    }

  }


  private materialPlugin(material: PBRMaterial): DetailInstanceMaterialPlugin | null {
    return this.pluginByMaterial.get(material) ?? null;
  }

  /** 2-12: a Babylon mesh from a pure PrototypeGeometry (typed arrays). */
  private buildPrototypeMesh(name: string, geometry: PrototypeGeometry): Mesh {
    const mesh = new Mesh(name, this.scene);
    const data = new VertexData();
    data.positions = geometry.positions;
    data.normals = geometry.normals;
    data.uvs = geometry.uvs;
    data.tangents = geometry.tangents;
    data.colors = geometry.colors;
    data.indices = geometry.indices;
    data.applyToMesh(mesh, false);
    // The per-vertex atlas layer (−1 = untextured) rides its own buffer.
    mesh.setVerticesBuffer(new VertexBuffer(
      this.scene.getEngine(),
      geometry.atlasLayer,
      "atlasLayer",
      { updatable: false, instanced: false, size: 1 },
    ));
    mesh.setEnabled(false);
    return mesh;
  }

  private createMaterial(
    name: string,
    albedo: Color3,
    roughness: number,
    samplesFoliageAtlas = false,
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    prepareMaterialForClusteredLighting(material);
    // 7-4b: read at CREATION, before the first effect compiles, so the
    // permutation is built with the varying already absent rather than
    // recompiled out of it later.
    material.forceIrradianceInFragment = detailIrradianceInFragment;
    material.albedoColor = albedo;
    material.metallic = 0;
    material.roughness = roughness;
    // 1C-6: full-strength now that scene.environmentTexture exists.
    material.environmentIntensity = 1;
    material.directIntensity = 1.05;
    material.specularIntensity = 1;
    // 2-11a: the transform lives in the plugin now — every detail material
    // carries it (rocks included; their wind response is simply zero).
    const plugin = new DetailInstanceMaterialPlugin(material);
    plugin.setTimeSeconds(this.windTimeSeconds);
    if (samplesFoliageAtlas && this.foliageAtlas) {
      plugin.setFoliageAtlas(this.foliageAtlas.texture);
    }
    this.instancePlugins.add(plugin);
    this.pluginByMaterial.set(material, plugin);
    // 0-9 incantation, verbatim: the wrapper is assigned AFTER the vertex-
    // participating plugin attaches and BEFORE the material's first effect
    // compiles — attached later it silently falls back to the undisplaced
    // depth pass, which with no matrix buffer would collapse every shadow
    // instance onto the batch origin.
    //
    // remappedVariables amendment (2-12): with the CSM's normalBias > 0 the
    // wrapper injects `shadowMapVertexNormalBias`, whose WGSL references the
    // varying by its bare GLSL name — unresolved after migration. The remap
    // rewrites it inside the include only; `vertexOutputs.vNormalW` is
    // already assigned by the injection anchor. The 0-9 spike missed this
    // because its generator kept the default normalBias of 0, which compiles
    // the include away (tests/gpu/foliage-material-compile.test.ts pins it).
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (engineFlags.isWebGPU || engineFlags._gl) {
      // 4.5-0: guarded — bindInstanceBuffers resets a growing batch's draw
      // cache in the same frame the CSM pass renders it, and an unguarded
      // wrapper turns that into the createBindGroup fatal stop.
      material.shadowDepthWrapper = createGuardedShadowDepthWrapper(material, this.scene, {
        remappedVariables: ["vNormalW", "vertexOutputs.vNormalW"],
      });
    }
    this.materials.add(material);
    return material;
  }

  private registerBatch(
    key: string,
    mesh: Mesh,
    material: PBRMaterial,
    castsShadows: boolean,
    bounds: DetailPrototypeBounds,
  ): void {
    mesh.material = material;
    mesh.isPickable = false;
    mesh.useVertexColors = true;
    mesh.receiveShadows = true;
    mesh.setEnabled(false);
    mesh.metadata = { detailPrototype: key };
    this.prototypes.set(key, {
      mesh,
      material,
      castsShadows,
      boundKernel: detailPrototypeBoundKernel(bounds),
    });
  }
}
