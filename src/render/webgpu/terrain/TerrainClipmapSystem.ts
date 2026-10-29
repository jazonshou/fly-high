import { prepareMaterialForClusteredLighting } from "../lighting/ClusteredLighting";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
// Side-effect import: Babylon 9 tree-shakes the thin-instance API, and
// `Mesh.prototype.thinInstanceSetBuffer` / `thinInstanceCount` do not exist
// without it. Missing, they are `undefined` rather than an error — the mesh
// simply draws nothing, silently.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { CloudShadowMaterialPlugin } from "@/src/render/webgpu/clouds/CloudShadowMaterialPlugin";
import type { CloudShadowProjection } from "@/src/render/webgpu/clouds/CloudShadowReceiver";
import { ComputeBudget } from "@/src/render/webgpu/core/ComputeBudget";
import { createGuardedShadowDepthWrapper } from "@/src/render/webgpu/core/guardedShadowDepthWrapper";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  type WorldPageAddress,
} from "@/src/render/webgpu/world/pageKey";
import { WORLD_PAGE_SCHEMA_VERSION } from "@/src/render/webgpu/world/payload";
import {
  rankWorldPageStreamingCandidates,
  type WorldPageStreamingObserver,
  type WorldPageStreamingPriorityOptions,
} from "@/src/render/webgpu/world/streamingPriority";
import {
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  type AirportDefinition,
  type WorldDefinition,
} from "@/src/world";
import {
  infrastructureChangeTouches,
  type InfrastructureChange,
} from "@/src/world/infrastructure";
import { sampleErgFarWeight } from "@/src/world/landforms";
import {
  diffTerrainAirports,
  sameTerrainAirports,
  terrainAirportReaches,
  terrainPageAirportDomain,
  terrainPageInAirportReach,
  type TerrainMutableWorldRect,
} from "./AirportReach";
import { GlobalHeightPyramid } from "./GlobalHeightPyramid";
import {
  GROUND_GRAIN_LAYER,
  surfaceArrayLayerIds,
  synthesizeSurfaceArrayLayer,
} from "./GroundGrainSynthesis";
import {
  uploadSurfaceMaterialArrays,
  type SurfaceMaterialArrays,
} from "./MaterialArrayUpload";
import { MaterialSynthesisClient } from "./MaterialSynthesisClient";
import { SurfaceMaterial } from "./surfaceMaterials";
import { PageOcclusionBake, PageSplatBake } from "./PageOcclusionBake";
import { ClimateProvinceField } from "./ClimateProvinceField";
import { TERRAIN_AIRPORT_SLOTS } from "./RunwayEarthworks";
import { terrainClimateProvinceInput, terrainLandformInput } from "./TerrainKernel";
import type { TerrainLandformDataSource } from "./TerrainLandformKernel";
import { TerrainDebugOverlay, type TerrainDebugOverlayMode } from "./TerrainDebugOverlay";
import {
  TERRAIN_CHANNEL_TEXTURES,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  createResidentInvariantPageLookup,
  invariantSlotKey,
  terrainPageLandformMargin,
  type TerrainAuxPagePublisher,
  type TerrainCollisionPagePublisher,
  type TerrainAtlasSlot,
} from "./TerrainPageAtlas";
import { terrainErosionAdmissionDependencies } from "./TerrainPageErosion";
import {
  TerrainDrawnHeight,
  terrainDrawnWindowCells,
  type TerrainDrawnAtlasShape,
} from "./TerrainDrawnHeight";
import type { TerrainSlotKey } from "./TerrainSpineContract";
import {
  buildTerrainNodeGrid,
  createTerrainNodeBuffers,
  resolveTerrainResidentCornerMorphs,
  selectTerrainNodeSets,
  terrainNearFloorNodeAllowance,
  writeTerrainNodeBuffers,
  type TerrainNode,
  type TerrainNodeBuffers,
  type TerrainNodeCornerMorphs,
  type TerrainNodeSelectionInput,
} from "./TerrainQuadtree";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_PROVISIONAL_AXIS,
  seasonBakeDayOfYear,
  seasonBucketBlend,
  TERRAIN_NODE_ATTRIBUTE_A,
  TERRAIN_NODE_ATTRIBUTE_B,
  TERRAIN_NODE_ATTRIBUTE_STRIDE,
  TERRAIN_HORIZON_PYRAMID_SPAN_METERS,
  terrainAtlasGridEdge,
} from "./TerrainSpineContract";
import { TERRAIN_MATERIAL_LIGHTING, TerrainSurfacePlugin, type TerrainFarSwardRead } from "./TerrainSurfacePlugin";
// 6-5: the shore sea state travels as 6-2's own published type — one
// definition, forwarded, never restated on the terrain side.
import type { WaterShoreSwell } from "@/src/render/webgpu/water/WaterShaders";
import type { TerrainMacroEvolutionExport } from "./TerrainEvolutionContract";
import { VolcanicSiteIndexStream } from "./VolcanicSiteIndexStream";

/**
 * The four terrain compute producers, as the clipmap uses them (`4.5-B4`).
 *
 * Structural interfaces rather than the concrete classes, because the whole
 * defect they exist to close is invisible to the NullEngine suite: under
 * NullEngine the atlases hold no textures, so the system NEVER CONSTRUCTS a
 * generator, and a `setProfile` that leaves the generator pointing at a
 * disposed atlas cannot be observed. `computeFactory` is the seam assertion
 * 116 drives them through.
 */
export interface TerrainPageProducer {
  /** `4.5-C3`: this producer's whole-dispatch GPU time, unconsumed. */
  gpuMillisecondsInFrame?(): number | null;
  /**
   * `admittedDispatches` is what the meter allowed this frame. The analytic
   * batch is already sliced to it and ignores the argument; the `W-1d` GPU
   * erosion DAG spends it on DAG stages instead of pages.
   *
   * A RESIDENT slot in an analytic batch is an in-place regeneration
   * (`TerrainAtlasSlot.airportRebuildOwed`). The producer marks every slot it
   * actually dispatched `generationSubmitted`, resident ones included; the
   * clipmap reads that once the promise settles to tell a recorded
   * regeneration from a declined one, and re-queues the latter.
   */
  generate(slots: readonly TerrainAtlasSlot[], admittedDispatches?: number): Promise<void>;
  /**
   * Re-bake resident pages in place against the landform data as it is now,
   * returning the slots dispatched (`TerrainPageGenerator.refresh`).
   */
  refresh?(slots: readonly TerrainAtlasSlot[]): Promise<readonly TerrainAtlasSlot[]>;
  /** Grade these airports (home field first) from the next dispatch on. */
  setAirports?(airports: readonly Readonly<AirportDefinition>[]): void;
  /** Bring the stage's GPU copy to the streamed regions now (`TerrainPageGenerator.syncInfrastructure`). */
  syncInfrastructure?(): void;
  /** Fill Phase-5 aux fields for channel slots admitted after height. */
  ensureHydrology?(slots: readonly TerrainAtlasSlot[]): Promise<void>;
  setCollisionPagePublisher?(publisher: TerrainCollisionPagePublisher | null): void;
  setAuxPagePublisher?(publisher: TerrainAuxPagePublisher | null): void;
  setMacroEvolution?(macro: Readonly<TerrainMacroEvolutionExport> | null): void;
  consumeMeasuredDispatchCostMs(): number | null;
  /**
   * `W-1d`: the multi-frame erosion DAG's demand for this frame, in dispatches
   * at the CURRENT stage's measured price. Null (or absent) means this
   * producer erodes on the CPU worker and the historical one-demand-per-page
   * shape applies.
   */
  erosionDagDemand?(
    pendingPageCount: number,
  ): { readonly count: number; readonly costMs: number } | null;
  /** `W-1d`: true while a page's DAG holds the producer across frames. */
  hasActiveErosionDag?(): boolean;
  /** `4.5-B2(a)` for `erosionCompute`; the DAG's measured per-dispatch cost. */
  consumeMeasuredErosionDispatchCostMs?(): number | null;
  /** `W-2`: whether this page's parent seed block has fully converged. */
  erosionDependenciesResident?(address: WorldPageAddress): boolean;
  dispose(): void;
}

export interface TerrainChannelProducer {
  /** `4.5-C3`: this producer's whole-dispatch GPU time, unconsumed. */
  gpuMillisecondsInFrame?(): number | null;
  bake(slots: readonly TerrainAtlasSlot[]): Promise<readonly TerrainAtlasSlot[]>;
  consumeMeasuredDispatchCostMs(): number | null;
  dispose(): void;
}

/**
 * Content revision shared by both terrain atlases. Evolution mode belongs in
 * the key because analytic parity worlds and activated eroded worlds may have
 * the same public seed but never the same page bytes.
 */
export function terrainWorldRevision(
  world: Pick<WorldDefinition, "seed" | "worldEvolution">,
): string {
  return `terrain-gpu-page-v${WORLD_PAGE_SCHEMA_VERSION}/${world.worldEvolution}/${world.seed}`;
}

export interface TerrainSplatProducer {
  /** `4.5-C3`: this producer's whole-dispatch GPU time, unconsumed. */
  gpuMillisecondsInFrame?(): number | null;
  /** The slots actually baked: the caller publishes these and releases the rest. */
  bake(slots: readonly TerrainAtlasSlot[], dayOfYear: number): Promise<readonly TerrainAtlasSlot[]>;
  /** Classify the airfield of these airports (home field first) from the next bake on. */
  setAirports?(airports: readonly Readonly<AirportDefinition>[]): void;
  consumeMeasuredDispatchCostMs(): number | null;
  /**
   * Volcanic land: `WebGpuQualityProfile.volcanicMaterials`, from the next
   * bake on. Where it is false the bake paints Basalt and Tephra as Rock and
   * Gravel, so arrays without those layers never meet their ids.
   */
  setVolcanicMaterials?(enabled: boolean): void;
  dispose(): void;
}

/**
 * Pages owed an in-place rebuild because the airport list changed over them
 * (`TerrainClipmapSystem.setAirports`). Observation only.
 */
export interface TerrainAirportRebuildBacklog {
  /** Airport-list changes whose reach is still being tested against the slots. */
  readonly changesBeingScanned: number;
  /** Height slots whose regeneration has not been dispatched yet. */
  readonly heightPagesOwed: number;
  /** Height slots whose regeneration is batched but not yet known recorded. */
  readonly heightPagesInFlight: number;
  /** Channel slots whose occlusion and splat re-bake has not been dispatched. */
  readonly channelPagesOwed: number;
}

export interface TerrainHeightPyramidProducer {
  recenter(x: number, z: number): Promise<unknown>;
  readonly isResident: boolean;
  /**
   * `6-11`: the global horizon field's bake, admitted separately from the
   * height recentre because it is ~25x the work and recurs on every 512 m of
   * travel — the one part of the pyramid a frame may legitimately defer.
   */
  readonly needsHorizonBake?: boolean;
  bakeHorizon?(): Promise<boolean>;
  dispose(): void;
}

export interface TerrainComputeProducers {
  readonly pageGenerator: TerrainPageProducer | null;
  readonly occlusionBake: TerrainChannelProducer | null;
  readonly splatBake: TerrainSplatProducer | null;
  /**
   * Created once and REUSED across an atlas reshape: the pyramid is a global
   * height field that holds no atlas reference, so disposing it would throw
   * away a recentre for nothing.
   */
  readonly pyramid: TerrainHeightPyramidProducer | null;
}

export interface TerrainComputeFactoryInput {
  readonly heightAtlas: TerrainPageAtlas;
  readonly channelAtlas: TerrainPageAtlas;
  /** Non-null on a rebuild; the factory should hand it straight back. */
  readonly existingPyramid: TerrainHeightPyramidProducer | null;
}

export type TerrainComputeFactory = (
  input: TerrainComputeFactoryInput,
) => TerrainComputeProducers;

export interface TerrainClipmapSystemOptions {
  /** Injection point for headless tools and tests; omitted uses the real one. */
  readonly nodeBudgetOverride?: number;
  /** `4.5-B4`'s seam. Omitted builds the real WebGPU producers. */
  readonly computeFactory?: TerrainComputeFactory;
  /**
   * `4.5-C2b`'s seam. Omitted constructs the real worker-backed client, which
   * falls back to inline synthesis wherever no `Worker` exists.
   */
  readonly materialSynthesisClient?: MaterialSynthesisClient;
  /**
   * The landform data the bakes bind, as the clipmap drives it (prime at
   * warm-up, follow the observer, refresh what it only partly covered).
   * Omitted, the real producers build a `VolcanicSiteIndexStream`; tests that
   * inject `computeFactory` pass one here to drive the refresh.
   */
  readonly landformIndex?: TerrainLandformIndex;
  /**
   * A car session: the observer is the car, and the tier's
   * `vehicleNearTerrainL0RadiusMeters` drops the terrain's floor to L0 round
   * it (`TerrainNodeSelectionInput.nearFloor`).
   */
  readonly vehicleNearField?: boolean;
}

/** The disc a car session draws L0 in, or undefined: no car, or a tier whose floor is L0. */
function vehicleNearFloor(
  profile: WebGpuQualityProfile,
  options: TerrainClipmapSystemOptions,
): TerrainNodeSelectionInput["nearFloor"] {
  if (!options.vehicleNearField || !(profile.vehicleNearTerrainL0RadiusMeters > 0)) return undefined;
  return {
    level: 0,
    radiusMeters: profile.vehicleNearTerrainL0RadiusMeters,
    bandMeters: profile.vehicleNearTerrainL0BandMeters,
  };
}

/** Instances the beauty node buffer holds: the budget, plus the near floor's own nodes. */
function terrainNodeCapacity(profile: WebGpuQualityProfile, options: TerrainClipmapSystemOptions): number {
  return (options.nodeBudgetOverride ?? profile.cdlodNodeBudget)
    + terrainNearFloorNodeAllowance(vehicleNearFloor(profile, options), profile.finestResidentLevel);
}

/** `VolcanicSiteIndexStream` as the clipmap uses it. */
export interface TerrainLandformIndex extends TerrainLandformDataSource {
  /** False without volcanism: nothing is ever partial, so nothing is refreshed. */
  readonly enabled: boolean;
  /** Bumped on every upload. */
  readonly uploadCount: number;
  prime(x: number, z: number): void;
  update(observerX: number, observerZ: number): void;
  dispose(): void;
}

/**
 * Frames a rebuilt caster mesh is asked whether it is ready (`4.5-B4(b)`).
 *
 * A `ShadowDepthWrapper` learns about a submesh only through the FORWARD
 * effect's `onEffectCreatedObservable`, and the caster meshes render at
 * `layerMask 0` — no camera ever creates that effect for them. The one sweep
 * that does is `scene.whenReadyAsync()` at startup, which a runtime
 * cascade-count change happens long after: `rebuildCasterMeshes` then produced
 * submeshes with no registration at all, which silently never cast. Asking
 * `isReady(true)` is that sweep, re-run for the new meshes; it is polled
 * rather than called once because effect compilation is asynchronous.
 */
const CASTER_READINESS_SWEEP_FRAMES = 120;

/**
 * Frames a slot may sit in `generating`, un-wanted and undispatched, before
 * the atlas takes it back (`4.5-B3`). Two seconds at 60 Hz: long enough that a
 * page the aircraft is still flying toward is never reclaimed out from under
 * an in-flight dispatch, short enough that a banked turn's abandoned corridor
 * does not hold the atlas hostage.
 */
const STALLED_SLOT_RECLAIM_FRAMES = 120;

/**
 * Volcanic land: the season day a resident splat is marked with when the
 * profile's `volcanicMaterials` datum flips under it. It is no day at all, so
 * `pendingSplatRebakes` reads the slot as owed and re-bakes it in place under
 * the new datum, exactly as it does across a season-bucket rollover.
 */
const VOLCANIC_DATUM_REBAKE_DAY = -1;

/** The airport pumps' answer on a frame with nothing owed: shared, never allocated. */
const NO_SLOTS: readonly TerrainAtlasSlot[] = Object.freeze([]);

/**
 * Slots, of both atlases together, an airport change's invalidation tests per
 * frame. A test is a handful of rectangle projections; this many keeps the
 * per-frame share far under the 2 ms main-thread bound on any tier, and the
 * largest atlas pair (2 x 256 slots) is through in eight frames — while the
 * rebuild it feeds is paced at a page or two per frame by the meter anyway.
 */
export const AIRPORT_INVALIDATION_SLOTS_PER_FRAME = 64;

/**
 * The coarsest pages wait for road changes while the observer flies on
 * (`infrastructureChanged`). A page from this level up spans 16 km or more
 * and paints a 7 m gravel road over 5% of a 128 m texel, yet nearly every
 * region the road stream installs or drops lies inside one, so at jet speed
 * they were rebuilt again and again: on a 90 s leg at 250 m/s from the home
 * field, levels 5-9 were rebuilt 405 times, twice the 209 fresh pages of
 * every level (fake producers, so every rebuild finished at once).
 * Their rebuild is pooled while the observer is faster than
 * `ROAD_DEFERRED_MIN_SPEED` and moved since the last frame, and goes ahead
 * once it slows or stops, or has travelled `ROAD_DEFERRED_MAX_TRAVEL` since
 * the oldest change waiting. Finer pages rebuild as before; so does every
 * page under a car or a boat, and under a capture's aircraft, which holds
 * still at its pose's speed.
 */
export const ROAD_DEFERRED_MIN_LEVEL = 5;
/** Ground speed above which coarse rebuilds for roads wait, m/s: past a car's top speed. */
export const ROAD_DEFERRED_MIN_SPEED = 50;
/** Travel after which the waiting coarse rebuilds go ahead anyway, metres. */
export const ROAD_DEFERRED_MAX_TRAVEL = 8_000;
/** An observer that moved less than this since the last frame is holding still (a capture's), metres. */
const ROAD_DEFERRED_STILL_METERS = 0.01;

/** Road changes' coarse rebuilds waiting while the observer flies on: their bins together, and the latest version. */
interface DeferredRoadRebuild {
  readonly bins: Set<number>;
  version: number;
  readonly fromX: number;
  readonly fromZ: number;
}

const NO_PLANT_BINS: ReadonlySet<number> = new Set();

/**
 * One change to the ground the pages bake, still being tested against the
 * slots: an airport-list change (`setAirports`), or a change to the streamed
 * infrastructure regions (`infrastructureChanged`), which share the airport
 * machinery and its names.
 */
interface AirportInvalidation {
  /** The version the change produced: slots batched at or after it are current. */
  readonly version: number;
  /** Whether the change reaches what a page samples. */
  readonly reaches: (address: WorldPageAddress) => boolean;
  /** Snapshots taken when the scan starts; slots requested later are current. */
  heightSlots: readonly TerrainAtlasSlot[] | null;
  channelSlots: readonly TerrainAtlasSlot[] | null;
  /** Index into heightSlots, then channelSlots. */
  cursor: number;
}

export interface TerrainObserver {
  readonly x: number;
  /** Altitude above sea level (1B-3): node selection uses 3D distance. */
  readonly y?: number;
  readonly z: number;
  readonly velocityX: number;
  readonly velocityZ: number;
  /**
   * `viewportHeightPixels / (2 * tan(verticalFov / 2))` — the one camera datum
   * CDLOD's screen-space error needs. Omitted falls back to a 1080p/60-degree
   * camera, which keeps headless callers valid without letting the selector
   * reach for a camera object.
   */
  readonly pixelsPerMeterAtUnitDistance?: number;
}

/**
 * Why the same page is resident, counted per reason.
 *
 * **`residentPages` is a TOTAL over a MIXED POPULATION, and it was read as
 * "terrain being drawn".** It is not: `updateAtlasResidency` builds its wanted
 * set from four sources with different rights, and only the first is a
 * candidate for any visibility test.
 *
 *  - `drawn` — CDLOD-selected nodes. The ONLY set a frustum test could touch.
 *  - `parent` — every node's parent, added unconditionally because morphing
 *    reads it. Culling one pops the child it morphs into.
 *  - `collision` — a 5x5 L0 ring around the observer, tier-invariant and
 *    explicitly never added to the draw list. It is CORRECTLY indifferent to
 *    where the camera looks; physics does not have a frustum.
 *  - `seed` — `W-2` erosion dependencies, the transitive parent closure a page
 *    needs converged before it can be admitted. Eroded worlds only.
 *
 * **`drawnBeyondShadowDistance` is the number a frustum cull would be sized
 * from**, and it is the only one of these that a fix could reduce: terrain
 * inside `shadowDistance` casts into view from any direction and must stay
 * resident whether or not it is on screen.
 *
 * **SIZING A CULL FROM IT — the bound, and the way to misread it.**
 *
 *     ceiling on any frustum cull  =  drawnBeyondShadowDistance x >0.828
 *
 * The 0.828 is `1 - fov/360` at the shipped horizontal FOV of 62 degrees
 * (`FlightRenderer.ts:799-800`, `FOVMODE_HORIZONTAL_FIXED`). **It is a LOWER
 * BOUND on the out-of-frustum share, NOT the share.** The wedge is an AZIMUTH
 * fraction and a frustum also has top and bottom planes, so near-field ground
 * below the bottom plane is inside the wedge and outside the frustum: the true
 * out-of-frustum share is strictly larger, and a cull sized on 0.828 will
 * under-claim rather than over-claim.
 *
 * **And it holds for a narrower reason than the obvious one.** It is NOT that
 * selection is rotation-invariant so the selected set is radially symmetric —
 * that premise is false, because `deviationFor` and `heightRangeFor` are
 * strongly anisotropic and the node lattice is world-anchored rather than
 * camera-anchored. It holds because **heading is not an input to selection at
 * all** (`TerrainNodeSelectionInput` carries `cameraX/Y/Z` and scalars, no
 * direction), so for any fixed selected set under uniform heading the expected
 * wedge share is exactly `theta / 2pi`. The symmetry argument reaches the same
 * number and does not survive contact with the code.
 *
 * Published because the totals could not answer the question they were being
 * asked. `collisionOnly` was already computed and discarded one line after it
 * was built; this keeps it.
 */
export interface TerrainResidencyReasons {
  readonly drawn: number;
  readonly parent: number;
  readonly collision: number;
  readonly seed: number;
  /** Drawn nodes further from the observer than the shadow-caster distance. */
  readonly drawnBeyondShadowDistance: number;
}

export interface TerrainClipmapStatistics {
  /** Height-atlas slots holding a generated page. */
  readonly residentPages: number;
  /**
   * Why those pages are wanted, by reason. See `TerrainResidencyReasons` —
   * the total alone cannot distinguish terrain nobody can see from terrain
   * physics and morphing require.
   */
  readonly residencyReasons: TerrainResidencyReasons;
  /**
   * Slots whose generation dispatch is in flight, plus one while the climate
   * province window still has stale texels: the far ground's tones are part
   * of what "streamed" means, so a capture never settles on a half-baked field.
   */
  readonly pendingPages: number;
  readonly triangles: number;
  /** 4-4: the CPU worker pool is gone; this is compute dispatches in flight. */
  readonly workersBusy: number;
  readonly residentSlots: number;
  readonly slotsGenerating: number;
  readonly residentChannelSlots: number;
  /** CDLOD nodes drawn this frame. */
  readonly nodes: number;
  /** Draw calls the terrain submits: the beauty mesh plus the caster meshes. */
  readonly drawCalls: number;
}

/** Default camera datum: 1080p at a 60-degree vertical field of view. */
const DEFAULT_PIXELS_PER_METER_AT_UNIT_DISTANCE = 1_080 / (2 * Math.tan((60 * Math.PI) / 360));

/**
 * The coarsest level the quadtree roots at.
 *
 * Level 9 nodes span 32,768 m, so the 45 km far plane is covered by a ring of
 * about 25 roots. That matters more than it looks: the root ring is the
 * quadtree's FLOOR COST, paid before a single node is split, and at level 7
 * (8,192 m spans) it is ~121 nodes — three quarters of the Low tier's whole
 * 160-node budget spent on ground at the horizon.
 */
const COARSEST_NODE_LEVEL = 9;

/**
 * Refreshing pages baked with only part of the landform data (the volcanic
 * site index, `VolcanicSiteIndexStream`).
 *
 * The index is 144 km across and follows the observer; a level-6 page is
 * 33 km and a root 262 km, so the coarse pages are baked with whatever part
 * the index covered (`TerrainAtlasSlot.landformCoverage`). Their texels near
 * the observer are what gets drawn, and those were inside the index when the
 * page was baked; fly 20-odd km and they no longer are, so a volcano that was
 * beyond the index then would be missing from the far ground now. A page is
 * refreshed in place, height then occlusion and splat, once its part within
 * `reachMeters` of the observer leaves the coverage it was baked with. That
 * is about once per page per 23 km of travel, a page or two at a time.
 */
export const TERRAIN_LANDFORM_REFRESH = Object.freeze({
  /** The 45 km far plane, the index's 4 km rebuild distance, and a margin. */
  reachMeters: 50_000,
  /** Resident pages are scanned again after this much travel, or a new index. */
  scanMeters: 1_000,
  /** Pages refreshed in one frame, height or channel. */
  maxPagesPerFrame: 2,
});

/**
 * Whether a page baked against `baked` coverage is due a refresh for an
 * observer at (x, z): its part within `TERRAIN_LANDFORM_REFRESH.reachMeters`
 * (plus the margin its bake samples) is outside `baked` and inside `current`.
 * Allocation-free.
 */
export function terrainLandformRefreshDue(
  address: WorldPageAddress,
  baked: Readonly<Float64Array>,
  current: Readonly<Float64Array>,
  x: number,
  z: number,
): boolean {
  const extent = WORLD_PAGE_BASE_EXTENT_METERS * 2 ** address.level;
  const margin = terrainPageLandformMargin(address.level);
  const reach = TERRAIN_LANDFORM_REFRESH.reachMeters;
  const minX = Math.max(address.x * extent - margin, x - reach);
  const minZ = Math.max(address.z * extent - margin, z - reach);
  const maxX = Math.min((address.x + 1) * extent + margin, x + reach);
  const maxZ = Math.min((address.z + 1) * extent + margin, z + reach);
  if (minX >= maxX || minZ >= maxZ) return false;
  const stale = minX < baked[0]! || minZ < baked[1]! || maxX > baked[2]! || maxZ > baked[3]!;
  return stale && minX >= current[0]! && minZ >= current[1]! && maxX <= current[2]! && maxZ <= current[3]!;
}

/**
 * Tuning of the shared flight-corridor streaming priority (0-3). The module
 * defaults carry no level penalty; the atlas biases parents explicitly through
 * the selector, so this path keeps the fine-before-coarse ordering.
 */
const TERRAIN_STREAMING_PRIORITY_OPTIONS: Partial<WorldPageStreamingPriorityOptions> = {
  basePageExtentMeters: WORLD_PAGE_BASE_EXTENT_METERS,
  levelPenaltyMeters: 400,
};

/**
 * The ONE terrain material factory (`P4`, `4-4` D7).
 *
 * Phase 3 left this inline in the clipmap constructor, which was fine while
 * the material had no depth pass of its own. `4-4` introduces vertex
 * displacement, and `ARCHITECTURE.md`'s `0-9` entry records the failure mode
 * exactly: a `ShadowDepthWrapper` attached to an already-rendering material
 * SILENTLY falls back to the undisplaced default depth pass — the terrain
 * casts the shadow of a flat plane, which is visually plausible and invisible
 * to every CPU test. So construction and wrapper attachment are one named
 * function, in one place, with a GPU assertion against the REAL material.
 */
export function createTerrainMaterial(scene: Scene): PBRMaterial {
  const material = new PBRMaterial("terrain-pbr", scene);
  prepareMaterialForClusteredLighting(material);
  material.metallic = 0;
  // 3-7 replaces this per fragment from the 3-0 BRDF table. It survives as
  // the value the material compiles with before the arrays are bound (and
  // under NullEngine, which cannot hold a 2D array at all) — never as the
  // shipped answer, which is what the audit's uniform 0.93 was.
  material.roughness = 0.93;
  material.albedoColor = Color3.White();
  material.environmentIntensity = TERRAIN_MATERIAL_LIGHTING.environmentIntensity;
  material.directIntensity = TERRAIN_MATERIAL_LIGHTING.directIntensity;
  material.specularIntensity = TERRAIN_MATERIAL_LIGHTING.specularIntensity;
  material.enableSpecularAntiAliasing = TERRAIN_MATERIAL_LIGHTING.enableSpecularAntiAliasing;
  // 4-5: skirts are gone — the geomorph closes cracks analytically — so the
  // surface is a closed manifold and back faces are wasted fragments.
  material.backFaceCulling = true;
  return material;
}

/**
 * Attach the surface plugin and, in the same breath, the shadow depth wrapper.
 *
 * The order is the whole point: every vertex-participating plugin must be on
 * the material BEFORE the wrapper, and the wrapper before the material's first
 * effect compiles. The wrapper learns about base-material effects only through
 * `onEffectCreatedObservable`.
 */
export function attachTerrainSurfacePlugin(
  material: PBRMaterial,
  scene: Scene,
): TerrainSurfacePlugin {
  const plugin = new TerrainSurfacePlugin(material);
  material.shadowDepthWrapper = createGuardedShadowDepthWrapper(material, scene, {
    // `2-12`'s amendment, which `0-9`'s "no remappedVariables needed" predates
    // — that spike ran at `normalBias = 0`, where the include compiles away.
    // The atmosphere's CSM runs at 0.035, so the wrapper injects
    // `shadowMapVertexNormalBias`, whose WGSL references the varying by its
    // bare GLSL name `vNormalW` — unresolved after the WGSL migration. Without
    // this the terrain's whole SHADOW vertex module fails to compile, which
    // invalidates the shadow render bundle, which invalidates the frame's
    // command buffer: the screen goes black and nothing in the Node suite
    // notices. Found by running the app.
    remappedVariables: ["vNormalW", "vertexOutputs.vNormalW"],
  });
  return plugin;
}

/** The retired categorical lane now carries one compatibility-safe value. */
export function terrainFallbackMaterialAxis(): number {
  return TERRAIN_PROVISIONAL_AXIS.fallbackAxis;
}

/**
 * The terrain quadtree host (`4-5`).
 *
 * INVARIANT THIS FILE OWNS: one mesh draws the ground.
 *
 * Until this item the renderer built 151-172 CPU tile meshes from a worker
 * pool, each with its own vertex buffer, skirt walls and hole-punched index
 * buffer, and picked between them with hand-placed rings. All of it is gone:
 * one 33x33 unit grid is thin-instanced over a CDLOD node set selected by
 * MEASURED screen-space error, displaced in the vertex shader from the page
 * atlas, and geomorphed into its parent's lattice before it is replaced. That
 * closes audit root cause #7, and it is what deletes root cause #10 outright —
 * the CPU generation path does not exist any more.
 *
 * Page identity, streaming order and residency still come from
 * `src/render/webgpu/world/` (0-3). The atlas is the cache; the quadtree is
 * the selector; neither re-derives the other's numbers.
 */
export class TerrainClipmapSystem {
  private readonly material: PBRMaterial;
  private readonly surfacePlugin: TerrainSurfacePlugin;
  private readonly cloudShadowPlugin: CloudShadowMaterialPlugin;
  private materialArrays: SurfaceMaterialArrays | null = null;
  /**
   * Fix-pack T8: GPU resources retired while a submitted command buffer (or a
   * recorded render bundle) may still reference them. Destroying one in the
   * same frame invalidates the whole submit — a black frame at a suspiciously
   * high frame rate, the class this repo has now recorded four times. Entries
   * drain a few frames later, when nothing in flight can hold them.
   */
  private deferredDisposals: Array<{ retiredAtFrame: number; dispose: () => void }> = [];
  /**
   * The climate province window the far fallback reads, when the tier has it
   * (`terrainProvinceField`). Null compiles the province terms out.
   */
  private provinceField: ClimateProvinceField | null = null;
  /** False under NullEngine, where a TEXTURE_2D_ARRAY upload cannot be expressed. */
  private canBuildArrays = false;
  /** The edge the arrays SHOULD have; the build runs until they do. */
  private materialArrayEdge = 0;
  /**
   * Whether the arrays SHOULD carry the ground grain after the ten materials:
   * exactly where the patchwork runs, so tier 0 pays neither its memory nor
   * its fetches.
   */
  private materialArrayGrain = false;
  /**
   * Volcanic land: whether the arrays carry Basalt and Tephra. The profile's
   * `volcanicMaterials`, read as data; `surfaceArrayLayerIds` keeps them
   * wherever the grain is built.
   */
  private materialArrayVolcanic = true;
  /** One material's synthesis per frame, in flight. */
  private materialArrayBuild: {
    readonly edge: number;
    /** Layer ids in array order (`surfaceArrayLayerIds`). */
    readonly layerIds: readonly number[];
    readonly albedoHeight: Uint8Array[];
    readonly normalMaterial: Uint8Array[];
    index: number;
  } | null = null;

  private heightAtlas: TerrainPageAtlas;
  private channelAtlas: TerrainPageAtlas;
  private pageGenerator: TerrainPageProducer | null = null;
  private pyramid: TerrainHeightPyramidProducer | null = null;
  private occlusionBake: TerrainChannelProducer | null = null;
  private splatBake: TerrainSplatProducer | null = null;
  private casterReadinessSweeps = 0;
  private readonly computeBudget: ComputeBudget;
  /** `4.5-C2b`: off-thread layer synthesis, or null where no worker exists. */
  private synthesisClient: MaterialSynthesisClient | null = null;
  private debugOverlay: TerrainDebugOverlay;
  private generationInFlight = false;
  private occlusionInFlight = false;
  private splatRebakeInFlight = false;
  private collisionPagePublisher: TerrainCollisionPagePublisher | null = null;
  private auxPagePublisher: TerrainAuxPagePublisher | null = null;
  private macroEvolution: Readonly<TerrainMacroEvolutionExport> | null = null;

  private readonly beautyMesh: Mesh;
  /**
   * One caster mesh PER CASCADE, each sharing the beauty geometry.
   *
   * Not one mesh mutated per pass: Babylon records every cascade into one
   * `_renderEncoder` and submits the whole frame once, so a `queue.writeBuffer`
   * issued between cascade passes lands BEFORE that command buffer executes
   * and every cascade reads whatever was written last. The failure mode is one
   * cascade's node subset rendered into all of them — plausible enough to
   * survive review. Each mesh here is written exactly once per frame.
   *
   * `layerMask = 0` so no camera draws them, and `metadata.excludePlanarReflection`
   * so the water mirror does not. Standing them up per cascade is also what
   * preserves Governor B's shadow-caster-distance lever, which the 151-to-1
   * mesh collapse would otherwise have deleted.
   */
  private casterMeshes: Mesh[] = [];
  /** Persistent instance storage, one set per mesh; see TerrainNodeBuffers. */
  private beautyBuffers: TerrainNodeBuffers;
  private casterBuffers: TerrainNodeBuffers[] = [];
  private instanceBuffersBound = false;
  private nodes: readonly TerrainNode[] = [];
  /**
   * What the casters draw: the tier's own selection, without the near floor's
   * patch. The patch's relief is centimetres (L0 against L1, measured p90
   * 1-10 cm), and drawing it into both cascades cost more GPU time on Low than
   * drawing it on screen. The same array as `nodes` without a near floor.
   */
  private casterNodes: readonly TerrainNode[] = [];
  /** The drawn-surface lookup, made on a consumer's first ask (`drawnHeight`). */
  private drawnHeightLookup: TerrainDrawnHeight | null = null;
  private profile: WebGpuQualityProfile;
  private frameIndex = 0;
  private originX = 0;
  private originZ = 0;
  private streamingObserver: WorldPageStreamingObserver = {
    positionX: 0,
    positionY: 0,
    positionZ: 0,
    velocityX: 0,
    velocityZ: 0,
  };
  private cloudShadowProjection: CloudShadowProjection | null = null;
  /** Governor B lever 1 (1A-6b): page admissions per pump. */
  private requestBudgetPerPump = Number.POSITIVE_INFINITY;
  private shadowCasterDistanceMeters = Number.POSITIVE_INFINITY;
  private seasonDayOfYear: number = TERRAIN_REFERENCE_DAY_OF_YEAR;
  private readonly worldRevision: string;
  /**
   * The volcanic site index every landform consumer binds as
   * `terrainLandformData` (null off WebGPU and under an injected factory).
   * Built with the first real producers and kept across quality switches,
   * like the pyramid; it follows the terrain observer.
   */
  private landformStream: TerrainLandformIndex | null;
  /** Resident height pages due a landform refresh, from the last scan. */
  private readonly landformRefreshes: TerrainAtlasSlot[] = [];
  /** Resident channel pages whose height page was refreshed under them. */
  private readonly landformChannelRebakes: TerrainAtlasSlot[] = [];
  private landformScanX = Number.NaN;
  private landformScanZ = Number.NaN;
  private landformScanUploads = -1;
  private disposed = false;
  /**
   * Every airport the terrain grades, paints and classifies, home field first
   * and at most `TERRAIN_AIRPORT_SLOTS`. `world` is the world the flight
   * started in and never changes; spawned airports arrive through
   * `setAirports`.
   */
  private airports: readonly Readonly<AirportDefinition>[];
  /**
   * Height slots owed an airport regeneration or with one in flight, and
   * channel slots owed an airport re-bake — the only slots the airport pumps
   * look at. Pruned lazily; emptied when the atlases are rebuilt.
   */
  private readonly heightAirportRebuilds = new Set<TerrainAtlasSlot>();
  private readonly channelAirportRebuilds = new Set<TerrainAtlasSlot>();
  /** The airport pumps' per-frame candidate lists, reused, never reallocated. */
  private readonly heightRegenerationScratch: TerrainAtlasSlot[] = [];
  private readonly channelRebakeScratch: TerrainAtlasSlot[] = [];
  /** Bumped by every airport-list and infrastructure change; slots record it when batched. */
  private airportListVersion = 0;
  /** `infrastructureChanged`'s page-domain scratch. */
  private readonly infrastructureDomain: TerrainMutableWorldRect = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  /** Changes whose invalidation scan has not finished, oldest first. */
  private readonly airportInvalidations: AirportInvalidation[] = [];
  /** Road changes' rebuilds of levels from `ROAD_DEFERRED_MIN_LEVEL`, waiting while the observer flies on. */
  private deferredRoadRebuild: DeferredRoadRebuild | null = null;
  /** Whether the last update's observer had moved since the one before. */
  private observerMoved = false;

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldDefinition,
    profile: WebGpuQualityProfile,
    private readonly options: TerrainClipmapSystemOptions = {},
  ) {
    // `airports` is absent only on a world built by hand before it existed.
    this.airports = (world.airports ?? (world.airport ? [world.airport] : []))
      .slice(0, TERRAIN_AIRPORT_SLOTS);
    this.profile = profile;
    this.worldRevision = terrainWorldRevision(world);
    this.landformStream = options.landformIndex ?? null;
    this.material = createTerrainMaterial(scene);
    this.surfacePlugin = attachTerrainSurfacePlugin(this.material, scene);
    this.surfacePlugin.setSamplingProfile(
      profile.terrainTriplanarMode,
      profile.heightBlendMaxMaterials,
    );
    this.surfacePlugin.setGroundPatchwork(profile.terrainGroundPatchwork);
    this.applyProvinceField(profile);
    // The gather follows the layers the arrays will carry (setArrays keeps it
    // there); set now so the load-time compile is the one the arrays need.
    this.surfacePlugin.setVolcanicMaterials(surfaceArrayLayerIds(
      profile.terrainGroundPatchwork, profile.volcanicMaterials,
    ).includes(SurfaceMaterial.Basalt));
    // 6-8: the canopy handoff needs the tier's vegetation band radii. They are
    // the rendered-density law's, carried on the profile since the perf-debt
    // pass, so terrain reads them as data and never re-derives a radius. The
    // floor is the DRAWN share's (2026-09-13): impostors fill the mid band
    // from the crossover outward, and the ground carries only what no
    // representation draws.
    this.surfacePlugin.setCanopyBands(
      profile.renderedDensityLaw.near.outerRadiusMeters,
      profile.renderedDensityLaw.far.outerRadiusMeters,
      Math.max(
        profile.renderedDensityLaw.farFloorShare,
        profile.renderedDensityLaw.impostorFloorShare,
      ),
    );
    this.surfacePlugin.setSeason(this.seasonDayOfYear, world.latitudeDegrees, world.seaLevel);
    // 3-9: the runway is painted into this material by the analytic airport
    // SDF. Nothing else needs to know — no mesh, no second material.
    this.surfacePlugin.setRunways(this.airports);
    const engineFlags = scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    this.canBuildArrays = Boolean(engineFlags.isWebGPU || engineFlags._gl);
    this.materialArrayEdge = profile.materialArrayEdge;
    this.materialArrayGrain = profile.terrainGroundPatchwork;
    this.materialArrayVolcanic = profile.volcanicMaterials;
    this.cloudShadowPlugin = new CloudShadowMaterialPlugin(this.material);

    this.heightAtlas = new TerrainPageAtlas(scene, profile, {
      kind: "height",
      worldRevision: this.worldRevision,
    });
    this.channelAtlas = new TerrainPageAtlas(scene, profile, {
      kind: "channel",
      worldRevision: this.worldRevision,
      textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      requiresHydrology: world.worldEvolution === "eroded",
    });
    this.computeBudget = new ComputeBudget(profile);
    this.debugOverlay = new TerrainDebugOverlay(scene, profile.heightAtlasSlots);
    this.buildComputeProducers();
    if (this.canBuildArrays) {
      this.synthesisClient = options.materialSynthesisClient
        ?? new MaterialSynthesisClient();
    }

    this.beautyBuffers = createTerrainNodeBuffers(terrainNodeCapacity(profile, options));
    this.beautyMesh = new Mesh("terrain-cdlod", scene);
    buildTerrainNodeGrid().applyToMesh(this.beautyMesh, false);
    this.beautyMesh.material = this.material;
    this.beautyMesh.receiveShadows = true;
    this.beautyMesh.isPickable = false;
    // One mesh for the whole world: it must never be frustum-culled by its own
    // (unit-sized) bounding box, and its instances span the horizon.
    this.beautyMesh.alwaysSelectAsActiveMesh = true;
    this.beautyMesh.doNotSyncBoundingInfo = true;
    this.rebuildCasterMeshes();
    this.bindAtlasesToPlugin();
  }

  /**
   * Synthesise the ten material layers ONE PER FRAME, from the frame loop, and
   * upload once at the end.
   *
   * Three properties, each learned by breaking the app rather than by
   * reasoning about it:
   *
   * - **After startup, not during it.** Building the arrays in the constructor
   *   put ~1 s of unbroken main-thread work inside `FlightRenderer.create()`,
   *   and the first frame then died: a foliage draw reached `createBindGroup`
   *   with an entirely unbound material context — no textures, no `Light0..2`
   *   — and the renderer stopped with "Unable to continue flight". Bisected to
   *   the STALL, not the textures: the same two arrays built at an 8x8 edge
   *   (microseconds) start cleanly, and so does the pre-Phase-3 tree.
   *   `4.5-0` amendment: the stall was the WINDOW, not the mechanism. The
   *   death mode is the ShadowDepthWrapper's orphaned-defines cache — a
   *   rendered submesh whose draw cache is reset before its first depth
   *   render (see `core/guardedShadowDepthWrapper.ts`). The startup stall
   *   batched the detail worker's results so growth rebinds landed together
   *   in the first frames, holding that window open; removing the stall
   *   narrowed it, and streaming loads kept crashing through it until the
   *   guard closed it. This bullet's pacing rationale still stands on its
   *   own (a 1 s frozen main thread is a defect regardless).
   * - **Driven by `update()`, not by a timer.** `update()` runs only from the
   *   `world-page-visibility` pass, which runs only inside `render()`, which
   *   happens only once `create()` has resolved — so the frame loop is both
   *   the "startup is over" signal and the pacing. A `setTimeout` chain looked
   *   equivalent and was not: spread over timer tasks the build tripped the
   *   volumetric cloud system's 15 s pipeline barrier during startup, and
   *   under the capture harness's headless Chromium it never completed at all
   *   — `perf:capture` came back with white untextured terrain at SSIM 0.67.
   * - **One material per frame.** ~25 ms at the Low tier's 256² and ~110 ms at
   *   512², so the build costs ten dropped frames once rather than a second of
   *   frozen main thread.
   *
   * `4.5-C2b` deletes the ten dropped frames themselves: `synthesizeSurface
   * Material` is pure CPU pixel maths with no Babylon dependency, so a worker
   * runs it and this loop only DRAINS what has landed. Both properties above
   * survive — consumption is still driven by `update()`, and the upload still
   * happens once at the end. Where no worker exists (the Node suite, headless
   * tools, a bundler that did not emit one) the inline path below is unchanged
   * and still paces itself at one layer per frame.
   *
   * The terrain renders untextured until the arrays land, which the plugin
   * already supports because it is constructed disabled.
   */
  private stepMaterialArrayBuild(): void {
    if (!this.canBuildArrays) return;
    const wantedLayerIds = surfaceArrayLayerIds(
      this.materialArrayGrain, this.materialArrayVolcanic);
    if (this.materialArrayBuild === null) {
      if (
        this.materialArrays?.edge === this.materialArrayEdge
        && this.materialArrays.layerCount === wantedLayerIds.length
      ) return;
      this.materialArrayBuild = {
        edge: this.materialArrayEdge,
        layerIds: wantedLayerIds,
        albedoHeight: [],
        normalMaterial: [],
        index: 0,
      };
      this.requestMaterialSynthesis(this.materialArrayEdge, wantedLayerIds);
    }
    const build = this.materialArrayBuild;
    if (build.edge !== this.materialArrayEdge || build.layerIds.length !== wantedLayerIds.length) {
      // A profile change superseded it; the next frame restarts at the new
      // edge and layer list.
      this.materialArrayBuild = null;
      this.synthesisClient?.cancel();
      return;
    }
    const layerId = build.layerIds[build.index];
    if (layerId !== undefined) {
      const offThread = this.synthesisClient?.requestedEdge === build.edge
        ? this.synthesisClient.take(build.index)
        : null;
      // Drain as many worker-produced layers as have landed: they arrive
      // faster than one per frame, and holding them back would reintroduce
      // exactly the ten-frame window this item removes.
      if (offThread) {
        let layer: { albedoHeight: Uint8Array; normalMaterial: Uint8Array } | null = offThread;
        while (layer) {
          build.albedoHeight.push(layer.albedoHeight);
          build.normalMaterial.push(layer.normalMaterial);
          build.index += 1;
          layer = this.synthesisClient?.take(build.index) ?? null;
        }
        if (build.index < build.layerIds.length) return;
      } else {
        // No worker, or its layer has not landed yet. The inline path is the
        // fallback AND the Node/headless path; it stays one layer per frame.
        if (this.synthesisClient?.isAvailable && this.synthesisClient.requestedEdge === build.edge) {
          return;
        }
        const inline = synthesizeSurfaceArrayLayer(layerId, this.world.seed, build.edge);
        build.albedoHeight.push(inline.albedoHeight);
        build.normalMaterial.push(inline.normalMaterial);
        build.index += 1;
        return;
      }
    }
    const replacement = uploadSurfaceMaterialArrays(
      this.scene,
      { albedoHeight: build.albedoHeight, normalMaterial: build.normalMaterial },
      this.world.seed,
      build.edge,
    );
    const previous = this.materialArrays;
    this.materialArrays = replacement;
    this.materialArrayBuild = null;
    this.surfacePlugin.setArrays(
      replacement.albedoHeight,
      replacement.normalMaterial,
      build.layerIds.includes(GROUND_GRAIN_LAYER),
    );
    // Volcanic land: the gather's material count follows the layers BOUND, not the
    // profile, so a quality change never reads a volcanic id from arrays that
    // do not carry it yet. Unchanged ids leave the defines alone.
    this.surfacePlugin.setVolcanicMaterials(build.layerIds.includes(SurfaceMaterial.Basalt));
    // Enabling the plugin recompiles the shared material, but a mesh that has
    // already been drawn holds its own cached draw wrapper and render bundle
    // against the OLD effect — and keeps using it. The first capture after
    // the build moved off the startup path showed exactly that: pages created
    // in the first ten frames stayed white while everything streamed in
    // afterwards was textured. Only the beauty mesh drops its cache.
    //
    // The caster meshes deliberately do NOT (4.5-0). They never render in the
    // main pass (layerMask 0), so their forward draw wrappers exist only from
    // the startup readiness sweep and are never recreated; the shadow path
    // reads them solely as the defines source when the ShadowDepthWrapper
    // first builds a (subMesh, generator) depth params entry. Resetting them
    // therefore refreshes nothing the shadow pass uses while destroying the
    // defines that entry needs — a caster whose first cascade appearance came
    // after this reset either died in createBindGroup with an unbound
    // material context (the "Unable to continue flight" stop) or, once the
    // orphaned effect was released, silently never cast again. The depth pass
    // does not consume the fragment texturing this recompile changes, so the
    // casters have nothing to gain from the reset either.
    this.beautyMesh.resetDrawCache();
    if (previous) {
      // Deferred, not same-frame: the frame that swapped the arrays may have
      // already recorded draws against the old pair (see deferredDisposals).
      this.deferredDisposals.push({
        retiredAtFrame: this.frameIndex,
        dispose: () => {
          previous.albedoHeight.dispose();
          previous.normalMaterial.dispose();
        },
      });
    }
  }

  /**
   * Create or retire the province window to match the tier. The plugin's
   * define follows it, so the swap recompiles with the tier's other defines.
   */
  private applyProvinceField(profile: WebGpuQualityProfile): void {
    if (profile.terrainProvinceField && !this.provinceField) {
      // A sand sea's far ground is Sand whatever province surrounds it, which
      // no province offset predicts: the sand lane carries its erg weight, and
      // its early outs (the landform core, wet country) cost nothing.
      const world = this.world;
      this.provinceField = new ClimateProvinceField(this.scene, world, {
        sand: (x, z) => sampleErgFarWeight(world, x, z),
      });
      this.surfacePlugin.setClimateProvinceField(this.provinceField.binding);
    } else if (!profile.terrainProvinceField && this.provinceField) {
      const retired = this.provinceField;
      this.provinceField = null;
      this.surfacePlugin.setClimateProvinceField(null);
      this.deferredDisposals.push({
        retiredAtFrame: this.frameIndex,
        dispose: () => retired.dispose(),
      });
    }
  }

  /** True while the province window still has stale texels near the camera. */
  get provinceFieldPending(): boolean {
    return this.provinceField?.pending ?? false;
  }

  /** Drain retirements that are safely past any in-flight frame. */
  private drainDeferredDisposals(): void {
    if (this.deferredDisposals.length === 0) return;
    const safe = this.frameIndex - 4;
    let index = 0;
    while (index < this.deferredDisposals.length) {
      const entry = this.deferredDisposals[index]!;
      if (entry.retiredAtFrame <= safe) {
        entry.dispose();
        this.deferredDisposals.splice(index, 1);
      } else {
        index += 1;
      }
    }
  }

  /**
   * The one shared terrain PBR material, exposed so the renderer can register
   * it with shared receiver registries (1C-4's aerial perspective; cloud
   * shadows install their plugin directly in the constructor above).
   */
  get pbrMaterial(): PBRMaterial {
    return this.material;
  }

  /** Bytes the 3-1 arrays actually occupy, for the 1A-1 numeric report. */
  get materialArrayMemoryMiB(): number {
    return this.materialArrays?.memoryMiB ?? 0;
  }

  get statistics(): TerrainClipmapStatistics {
    const trianglesPerNode = this.beautyMesh.getTotalIndices() / 3;
    return {
      residentPages: this.heightAtlas.residency.residentCount,
      residencyReasons: this.residencyReasons,
      // Pages owed an in-place rebuild (an airport or a road changed under
      // them) are pending too: a capture waits for the ground it shows. The
      // coarse pages a fast observer's road changes left waiting are not:
      // nothing settles at that speed anyway, and they are queued the frame
      // it slows.
      pendingPages: this.heightAtlas.residency.generatingCount
        + (this.provinceField?.pending ? 1 : 0)
        + this.airportInvalidations.length
        + this.heightAirportRebuilds.size
        + this.channelAirportRebuilds.size,
      triangles: trianglesPerNode * this.nodes.length,
      workersBusy: (this.generationInFlight ? 1 : 0) + (this.occlusionInFlight ? 1 : 0),
      residentSlots: this.heightAtlas.residency.residentCount,
      slotsGenerating: this.heightAtlas.residency.generatingCount,
      residentChannelSlots: this.channelAtlas.residency.residentCount,
      nodes: this.nodes.length,
      drawCalls: 1 + this.casterMeshes.length,
    };
  }

  /**
   * `4.5-C3`: GPU milliseconds this frame's terrain COMPUTE counters are
   * holding, summed. An uncorrelated aggregate — Babylon's counters carry no
   * frame id, so this says how much GPU terrain compute is costing, never how
   * much of THIS frame's interval it explains. Null when the adapter granted
   * no `timestamp-query`.
   */
  get gpuComputeMillisecondsInFrame(): number | null {
    const parts = [
      this.pageGenerator?.gpuMillisecondsInFrame?.() ?? null,
      this.occlusionBake?.gpuMillisecondsInFrame?.() ?? null,
      this.splatBake?.gpuMillisecondsInFrame?.() ?? null,
    ].filter((value): value is number => value !== null);
    return parts.length === 0 ? null : parts.reduce((total, value) => total + value, 0);
  }

  /**
   * The volcanic site index the terrain bakes bind (`terrainLandformData`),
   * for the other landform consumers (the sea-depth bake) and the steam's
   * vent gate. Null until the WebGPU producers exist.
   */
  get landformData(): TerrainLandformDataSource | null {
    return this.landformStream;
  }

  /** 4-2/4-3: the GPU page atlases, for the generator and the surface plugin. */
  get atlases(): { readonly height: TerrainPageAtlas; readonly channel: TerrainPageAtlas } {
    return { height: this.heightAtlas, channel: this.channelAtlas };
  }

  /** The selected node set, so 4-10's capture can assert on it. */
  get selectedNodes(): readonly TerrainNode[] {
    return this.nodes;
  }

  /** The node set the shadow casters draw: `selectedNodes` without a near floor's patch. */
  get selectedCasterNodes(): readonly TerrainNode[] {
    return this.casterNodes;
  }

  /**
   * The ground as this terrain draws it (`TerrainDrawnHeight`), for a
   * consumer lying on it within `reachMeters` of the camera: made on the
   * first ask, and made again, larger, for a reach its window cannot hold.
   * Nothing here touches what the terrain itself draws: the lookup only reads
   * the node records `writeNodeBuffers` wrote, and only when
   * `refreshDrawnHeight` asks.
   */
  drawnHeight(reachMeters: number): TerrainDrawnHeight {
    const current = this.drawnHeightLookup;
    if (current && current.windowCells >= terrainDrawnWindowCells(reachMeters)) return current;
    if (current) {
      this.deferredDisposals.push({ retiredAtFrame: this.frameIndex, dispose: () => current.dispose() });
    }
    const engine = this.scene.getEngine() as { isWebGPU?: boolean };
    this.drawnHeightLookup = new TerrainDrawnHeight(engine.isWebGPU ? this.scene : null, reachMeters);
    return this.drawnHeightLookup;
  }

  /**
   * Write the lookup round (x, z) from this frame's beauty records. A
   * consumer calls it after the terrain's `update` and only on a frame it has
   * something within reach.
   */
  refreshDrawnHeight(x: number, z: number, radiusMeters: number): void {
    this.drawnHeightLookup?.refresh({
      nodes: this.nodes,
      laneA: this.beautyBuffers.laneA,
      laneB: this.beautyBuffers.laneB,
      count: this.beautyBuffers.count,
    }, x, z, radiusMeters);
  }

  /** The height atlas the lookup's records index, and its shape, as the surface plugin binds them. */
  get drawnHeightAtlas(): { readonly texture: BaseTexture | null; readonly shape: TerrainDrawnAtlasShape } {
    return { texture: this.heightAtlas.texture(), shape: this.heightAtlasShape() };
  }

  /** The surface material arrays the ground samples, once built (null before, and under NullEngine). */
  get surfaceMaterialArrays(): { readonly albedoHeight: BaseTexture; readonly normalMaterial: BaseTexture } | null {
    return this.materialArrays;
  }

  setProfile(profile: WebGpuQualityProfile): void {
    if (profile === this.profile) return;
    const atlasReshaped = profile.heightAtlasSlots !== this.heightAtlas.residency.slotCount
      || profile.channelAtlasSlots !== this.channelAtlas.residency.slotCount;
    const cascadesChanged = profile.shadowCascades !== this.profile.shadowCascades;
    const volcanicChanged = profile.volcanicMaterials !== this.profile.volcanicMaterials;
    this.profile = profile;
    this.surfacePlugin.setSamplingProfile(
      profile.terrainTriplanarMode,
      profile.heightBlendMaxMaterials,
    );
    this.surfacePlugin.setGroundPatchwork(profile.terrainGroundPatchwork);
    this.applyProvinceField(profile);
    // Volcanic land: the gather's define follows the arrays when they land
    // (stepMaterialArrayBuild); only the bake changes now.
    this.surfacePlugin.setCanopyBands(
      profile.renderedDensityLaw.near.outerRadiusMeters,
      profile.renderedDensityLaw.far.outerRadiusMeters,
      Math.max(
        profile.renderedDensityLaw.farFloorShare,
        profile.renderedDensityLaw.impostorFloorShare,
      ),
    );
    this.materialArrayEdge = profile.materialArrayEdge;
    this.materialArrayGrain = profile.terrainGroundPatchwork;
    this.materialArrayVolcanic = profile.volcanicMaterials;
    this.computeBudget.setProfile(profile);
    if (volcanicChanged) {
      this.splatBake?.setVolcanicMaterials?.(profile.volcanicMaterials);
      // Every resident splat was baked under the other datum: mark it owed,
      // and the season re-bake path repaints it in place. No season day is
      // negative, so this never reads as current.
      for (const slot of this.channelAtlas.residency.entries) {
        if (slot.bakedSeasonDay !== null) slot.bakedSeasonDay = VOLCANIC_DATUM_REBAKE_DAY;
      }
    }
    if (atlasReshaped) {
      // A slot index addresses a different texel in a reshaped atlas, so
      // residency cannot survive the change — dropping it is correct, not
      // lazy. Fix-pack T8: the DISPOSAL is deferred like the material-array
      // swap's — a frame that already recorded draws against the old atlas
      // textures must not have them destroyed under its submit.
      const retiredHeightAtlas = this.heightAtlas;
      const retiredChannelAtlas = this.channelAtlas;
      // The rebuild queues hold the retired atlases' slots, which never leave
      // `resident` on their own; every page of the new atlases is generated
      // against the current airport list, so nothing is owed any more.
      this.heightAirportRebuilds.clear();
      this.channelAirportRebuilds.clear();
      this.airportInvalidations.length = 0;
      this.deferredDisposals.push({
        retiredAtFrame: this.frameIndex,
        dispose: () => {
          retiredHeightAtlas.dispose();
          retiredChannelAtlas.dispose();
        },
      });
      this.heightAtlas = new TerrainPageAtlas(this.scene, profile, {
        kind: "height",
        worldRevision: this.worldRevision,
      });
      this.channelAtlas = new TerrainPageAtlas(this.scene, profile, {
        kind: "channel",
        worldRevision: this.worldRevision,
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
        requiresHydrology: this.world.worldEvolution === "eroded",
      });
      this.debugOverlay.dispose();
      this.debugOverlay = new TerrainDebugOverlay(this.scene, profile.heightAtlasSlots);
      this.debugOverlay.setEvolutionSource(this.macroEvolution
        ? { macro: this.macroEvolution, seedHash: this.world.seedHash }
        : null);
      // `4.5-B4(a)`: the generator and both bakes hold the atlases they were
      // constructed with. Recreating the atlases without recreating them left
      // terrain streaming silently dead for the rest of the session.
      this.buildComputeProducers();
      this.bindAtlasesToPlugin();
    }
    if (cascadesChanged) this.rebuildCasterMeshes();
  }

  /**
   * R-13: seasonal day for the land-cover bake, quantised to ~15-day buckets
   * ANCHORED at the reference day. `4-0`'s season key is what makes this a
   * slot variant rather than a page rebuild.
   */
  setSeasonalDayOfYear(dayOfYear: number): void {
    this.surfacePlugin.setSeason(dayOfYear, this.world.latitudeDegrees, this.world.seaLevel);
    // 4-0's cyclic blend: the two resident buckets are cross-faded at ALL
    // times rather than snapped when the clock is static. Snapping saves no
    // memory (the atlas is sized for two either way) and quantises the
    // snowline to 15-day steps exactly when the user is looking at it.
    this.surfacePlugin.setSeasonBlend(seasonBucketBlend(dayOfYear).t);
    this.seasonDayOfYear = seasonBakeDayOfYear(dayOfYear);
  }

  /** Caps page admissions per pump. Governor B lowers it under CPU pressure. */
  setRequestBudgetPerUpdate(count: number): void {
    this.requestBudgetPerPump = count >= Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(count));
  }

  /** 4-0b: Governor B rung 0 scales the shared compute cap. */
  setComputeBudgetScale(scale: number): void {
    this.computeBudget.setBudgetScale(scale);
  }

  /**
   * `6-9`: the SHARED meter, for the producers that live outside this system.
   *
   * `owners.ts` says "every GPU compute producer admits through it", and this
   * system happens to be where the one instance is constructed — a location,
   * not an ownership claim. The per-frame ground-cover field is admitted
   * through this same object rather than through a second meter, because two
   * meters would be two caps and the whole point of `4-0b` is that there is
   * one. Its demand is declared after this system has already read its own
   * admissions, which is safe because the meter settles a client when its
   * admission is read rather than because of any ordering luck.
   */
  get computeBudgetMeter(): ComputeBudget {
    return this.computeBudget;
  }

  /** The direction TOWARD the sun; 4-7's horizon shadow and the grain's crunch read it. */
  setSunDirection(x: number, y: number, z: number): void {
    this.surfacePlugin.setSunDirection(x, y, z);
  }

  /** The unit direction toward the sun the ground is shaded by, for the roads' ribbon. */
  get sunDirection(): readonly [number, number, number] {
    return this.surfacePlugin.sunDirection;
  }

  /**
   * `6-11`: the global horizon field, for consumers outside terrain.
   *
   * Null until the first horizon bake completes, and null on a non-WebGPU
   * engine — a consumer that gets null must fall back to fully lit, which is
   * today's behaviour and therefore the parity sentinel.
   */
  get globalHorizonField(): {
    readonly layerA: BaseTexture;
    readonly layerB: BaseTexture;
    readonly originX: number;
    readonly originZ: number;
    readonly spanMeters: number;
  } | null {
    const pyramid = this.pyramid as GlobalHeightPyramid | null;
    if (!pyramid?.isHorizonResident) return null;
    const layerA = pyramid.horizonTextureA;
    const layerB = pyramid.horizonTextureB;
    if (!layerA || !layerB) return null;
    return {
      layerA,
      layerB,
      originX: pyramid.horizonOriginX,
      originZ: pyramid.horizonOriginZ,
      spanMeters: TERRAIN_HORIZON_PYRAMID_SPAN_METERS,
    };
  }

  /**
   * `6-5`: the shore sea state and the water's own clock, forwarded from the
   * ocean system on the same snapshot pattern the sun and the cloud shadow
   * use. The terrain has no cascade textures to run the shader's dominant-band
   * rule against, which is exactly why 6-2 publishes a CPU twin.
   */
  setShoreWetness(swell: Readonly<WaterShoreSwell>, timeSeconds: number): void {
    this.surfacePlugin.setShoreWetness(swell, timeSeconds);
  }

  cycleDebugOverlay(): TerrainDebugOverlayMode {
    return this.debugOverlay.cycleMode();
  }

  /** V-4: which far-sward read the surface compiles (TerrainFarSwardRead). */
  setFarSwardRead(read: TerrainFarSwardRead): void {
    this.surfacePlugin.setFarSwardRead(read);
  }

  setDebugOverlay(mode: TerrainDebugOverlayMode): void {
    this.debugOverlay.setMode(mode);
  }

  setFloatingOrigin(x: number, z: number): void {
    if (x === this.originX && z === this.originZ) return;
    this.originX = x;
    this.originZ = z;
    this.surfacePlugin.setWorldOrigin(x, z);
    if (this.cloudShadowProjection) {
      this.cloudShadowPlugin.setProjection(this.cloudShadowProjection, x, z);
    }
  }

  setCloudShadow(projection: CloudShadowProjection): void {
    this.cloudShadowProjection = projection;
    this.cloudShadowPlugin.setProjection(projection, this.originX, this.originZ);
  }

  /** Connect final L0 page publication to the simulation worker. */
  setCollisionPagePublisher(publisher: TerrainCollisionPagePublisher | null): void {
    this.collisionPagePublisher = publisher;
    this.pageGenerator?.setCollisionPagePublisher?.(publisher);
  }

  /** Connect final signed-shore pages to render/detail consumers, never sim. */
  setAuxPagePublisher(publisher: TerrainAuxPagePublisher | null): void {
    this.auxPagePublisher = publisher;
    this.pageGenerator?.setAuxPagePublisher?.(publisher);
  }

  /**
   * Install the eager world-level erosion authority. Eroded page admissions
   * remain queued and unsubmitted until this arrives; analytic worlds ignore
   * it and retain the existing GPU generator byte-for-byte.
   */
  setMacroEvolution(macro: Readonly<TerrainMacroEvolutionExport> | null): void {
    if (macro && macro.provenance.worldSeed !== this.world.seed) {
      throw new RangeError("Terrain macro evolution belongs to a different world");
    }
    this.macroEvolution = macro;
    this.pageGenerator?.setMacroEvolution?.(macro);
    this.debugOverlay.setEvolutionSource(macro
      ? { macro, seedHash: this.world.seedHash }
      : null);
  }

  /**
   * Grade, paint and classify every airport in `airports` — home field first,
   * at most `TERRAIN_AIRPORT_SLOTS` — and bring the pages an airport entered
   * or left up to date, with no hitch.
   *
   * What a spawn costs on the frame it lands is a few uniform writes; the rest
   * rides the frames after it, through the existing queues and meter:
   *
   *  1. UNIFORMS, never pipelines. The page generator's earthworks set, the
   *     splat bake's airport table and the painter's per-slot frames are all
   *     compiled at the full slot count; this rewrites their values. Pages
   *     batched from here on are built for the new list.
   *  2. INVALIDATION by value, not by identity (`diffTerrainAirports`): only
   *     the reach of an airport that was ADDED or REMOVED can have changed
   *     (`AirportReach.ts` — platform + blend, and the airfield surround).
   *     The change is queued and its reach tested against every slot of both
   *     atlases at `AIRPORT_INVALIDATION_SLOTS_PER_FRAME` slots a frame
   *     (`stepAirportInvalidation`). A slot is marked `airportRebuildOwed`
   *     when it meets the reach AND was built against an older list — its
   *     `airportListVersion` predates the change — so a page batched after
   *     the change is never rebuilt for it, however late the scan reaches
   *     it. Pages the change does not reach are bit-identical before and
   *     after, because every texel outside an airport's reach evaluates to
   *     the same height and influence whichever airports exist.
   *  3. REBUILT IN PLACE through the existing pumps: owed height pages join
   *     the `terrainCompute` demand after fresh pages and are overwritten
   *     where they stand (no eviction, so no LOD pop and no hole in the
   *     physics ring); an L0 page is re-published to the simulation worker
   *     and the detail runtime through the same publisher its first
   *     generation used. Owed channel pages join the occlusion/splat pair's
   *     demand once their height page's regeneration is recorded, so they
   *     bake the new ground.
   *
   * An eroded world (opt-in) regrades heights for its home field only: its
   * earthworks are inputs to a multi-frame erosion DAG and to the erosion
   * worker's airport mask, and re-eroding every page under a spawned runway
   * is not a uniform write. Its painter and splat bake follow the list.
   *
   * Cheap to call every frame: an unchanged list — the same array, or the
   * same airports by value — returns before touching anything, allocating
   * nothing. It never scans, dispatches or bakes.
   */
  setAirports(airports: readonly Readonly<AirportDefinition>[]): void {
    if (this.disposed || sameTerrainAirports(this.airports, airports)) return;
    const next = airports.slice(0, TERRAIN_AIRPORT_SLOTS);
    const { added, removed } = diffTerrainAirports(this.airports, next);
    this.airports = next;
    this.surfacePlugin.setRunways(next);
    this.pageGenerator?.setAirports?.(next);
    this.splatBake?.setAirports?.(next);
    if (added.length === 0 && removed.length === 0) return;
    const reaches = [...added, ...removed].flatMap(terrainAirportReaches);
    this.airportListVersion += 1;
    this.airportInvalidations.push({
      version: this.airportListVersion,
      reaches: (address) => terrainPageInAirportReach(address, reaches),
      heightSlots: null,
      channelSlots: null,
      cursor: 0,
    });
  }

  /**
   * The streamed infrastructure regions changed (roads came or went:
   * `changeInfrastructureRegions`): bring every page whose sampled domain the
   * change touches up to date, exactly as `setAirports` does for a spawned
   * airport (its steps 2 and 3) — scanned over frames, rebuilt in place
   * through the pumps and meter, an L0 page published again.
   *
   * The stage's GPU copy is written here, with the change (every bake's
   * bind would bring it to the current regions anyway, so a page batched
   * after the change reads them either way). A page the change does not
   * touch is bit-identical either way, because outside the change's bins the
   * stage's answer is the same. Cheap: one queued test per slot, spread like
   * an airport change's.
   *
   * While the observer flies faster than `ROAD_DEFERRED_MIN_SPEED`, pages
   * from `ROAD_DEFERRED_MIN_LEVEL` up are left out of the scan and pooled,
   * every change's bins together, until it slows or has travelled
   * `ROAD_DEFERRED_MAX_TRAVEL`; then they are scanned as one change.
   */
  infrastructureChanged(change: InfrastructureChange): void {
    if (this.disposed) return;
    this.pageGenerator?.syncInfrastructure?.();
    if (change.bins.size === 0) return;
    const domain = this.infrastructureDomain;
    this.airportListVersion += 1;
    const version = this.airportListVersion;
    if (!this.deferringRoadRebuilds()) {
      this.flushDeferredRoadRebuild();
      this.airportInvalidations.push({
        version,
        reaches: (address) => infrastructureChangeTouches(change, terrainPageAirportDomain(address, domain)),
        heightSlots: null,
        channelSlots: null,
        cursor: 0,
      });
      return;
    }
    this.airportInvalidations.push({
      version,
      reaches: (address) => address.level < ROAD_DEFERRED_MIN_LEVEL
        && infrastructureChangeTouches(change, terrainPageAirportDomain(address, domain)),
      heightSlots: null,
      channelSlots: null,
      cursor: 0,
    });
    const deferred = this.deferredRoadRebuild ??= {
      bins: new Set(),
      version,
      fromX: this.streamingObserver.positionX,
      fromZ: this.streamingObserver.positionZ,
    };
    for (const key of change.bins) deferred.bins.add(key);
    deferred.version = version;
  }

  /**
   * Whether the observer is flying fast enough that coarse pages wait for
   * road changes (`ROAD_DEFERRED_MIN_LEVEL`): its speed, and moving at all,
   * since a capture holds an aircraft still at its pose's speed and must
   * wait for every page its roads reach.
   */
  private deferringRoadRebuilds(): boolean {
    const observer = this.streamingObserver;
    return this.observerMoved && Math.hypot(observer.velocityX, observer.velocityZ) > ROAD_DEFERRED_MIN_SPEED;
  }

  /**
   * Queue the coarse rebuilds the road changes left waiting, as one change
   * (their bins together, the latest version), once the observer has slowed
   * or come `ROAD_DEFERRED_MAX_TRAVEL` from where the oldest was made.
   */
  private stepDeferredRoadRebuild(): void {
    const deferred = this.deferredRoadRebuild;
    if (!deferred) return;
    const observer = this.streamingObserver;
    const travelled = Math.hypot(observer.positionX - deferred.fromX, observer.positionZ - deferred.fromZ);
    if (this.deferringRoadRebuilds() && travelled < ROAD_DEFERRED_MAX_TRAVEL) return;
    this.flushDeferredRoadRebuild();
  }

  private flushDeferredRoadRebuild(): void {
    const deferred = this.deferredRoadRebuild;
    if (!deferred) return;
    this.deferredRoadRebuild = null;
    // Never added to again, as infrastructureChangeTouches' box cache needs.
    const change: InfrastructureChange = {
      version: deferred.version,
      rects: [],
      bins: deferred.bins,
      plantBins: NO_PLANT_BINS,
    };
    const domain = this.infrastructureDomain;
    this.airportInvalidations.push({
      version: deferred.version,
      reaches: (address) => address.level >= ROAD_DEFERRED_MIN_LEVEL
        && infrastructureChangeTouches(change, terrainPageAirportDomain(address, domain)),
      heightSlots: null,
      channelSlots: null,
      cursor: 0,
    });
  }

  /** What `setAirports` has queued and not yet dispatched. Observation only. */
  get airportRebuildBacklog(): TerrainAirportRebuildBacklog {
    let heightPagesOwed = 0;
    let heightPagesInFlight = 0;
    for (const slot of this.heightAtlas.residency.entries) {
      if (slot.airportRebuildOwed) heightPagesOwed += 1;
      if (slot.airportRebuildInFlight) heightPagesInFlight += 1;
    }
    let channelPagesOwed = 0;
    for (const slot of this.channelAtlas.residency.entries) {
      if (slot.airportRebuildOwed) channelPagesOwed += 1;
    }
    return {
      changesBeingScanned: this.airportInvalidations.length,
      heightPagesOwed,
      heightPagesInFlight,
      channelPagesOwed,
    };
  }

  /**
   * Step 2 of `setAirports`, a frame's share of it: test up to
   * `AIRPORT_INVALIDATION_SLOTS_PER_FRAME` slots against the oldest queued
   * change's reach, and mark and queue the ones it invalidates. The rebuild
   * queues are what the pumps read, so a frame with nothing owed scans and
   * allocates nothing, and one with pages owed walks only those pages.
   */
  private stepAirportInvalidation(): void {
    let budget = AIRPORT_INVALIDATION_SLOTS_PER_FRAME;
    while (budget > 0 && this.airportInvalidations.length > 0) {
      const change = this.airportInvalidations[0]!;
      if (!change.heightSlots || !change.channelSlots) {
        // A slot requested after this snapshot is batched against the new
        // list, so it is current by construction. Eroded heights stay graded
        // for the home field (see setAirports).
        change.heightSlots = this.world.worldEvolution === "eroded"
          ? NO_SLOTS
          : this.heightAtlas.residency.entries;
        change.channelSlots = this.channelAtlas.residency.entries;
      }
      const heights = change.heightSlots;
      const channels = change.channelSlots;
      const total = heights.length + channels.length;
      while (budget > 0 && change.cursor < total) {
        const index = change.cursor;
        change.cursor += 1;
        budget -= 1;
        if (index < heights.length) this.invalidateHeightSlot(heights[index]!, change);
        else this.invalidateChannelSlot(channels[index - heights.length]!, change);
      }
      if (change.cursor >= total) this.airportInvalidations.shift();
    }
  }

  private invalidateHeightSlot(slot: TerrainAtlasSlot, change: AirportInvalidation): void {
    const state = slot.lifecycle.state;
    // Built (or being built) against the old list. A slot waiting for its
    // first dispatch needs nothing: it will read the new list.
    const recorded = state === "resident" || (state === "generating" && slot.generationSubmitted);
    if (!recorded || slot.airportListVersion >= change.version) return;
    if (!change.reaches(slot.address)) return;
    slot.airportRebuildOwed = true;
    this.heightAirportRebuilds.add(slot);
    // Its channel page bakes FROM these heights, so it is re-baked after
    // them — even one baked since the change, while this scan had not yet
    // reached its height page.
    const channel = this.channelAtlas.residency.get(slot.key);
    const channelState = channel?.lifecycle.state;
    if (channel && (channelState === "resident" || channelState === "generating")) {
      channel.airportRebuildOwed = true;
      this.channelAirportRebuilds.add(channel);
    }
  }

  private invalidateChannelSlot(slot: TerrainAtlasSlot, change: AirportInvalidation): void {
    const state = slot.lifecycle.state;
    // Never batched yet: its first bake reads the new list.
    if (state !== "resident" && state !== "generating") return;
    if (slot.airportListVersion < 0 || slot.airportListVersion >= change.version) return;
    if (!change.reaches(slot.address)) return;
    slot.airportRebuildOwed = true;
    this.channelAirportRebuilds.add(slot);
  }

  update(observer: TerrainObserver, frameIndex: number): void {
    if (this.disposed) return;
    this.stepMaterialArrayBuild();
    this.frameIndex = frameIndex;
    this.drainDeferredDisposals();
    this.observerMoved = Math.hypot(
      observer.x - this.streamingObserver.positionX,
      observer.z - this.streamingObserver.positionZ,
    ) > ROAD_DEFERRED_STILL_METERS;
    this.streamingObserver = {
      positionX: observer.x,
      positionY: observer.y ?? 0,
      positionZ: observer.z,
      velocityX: observer.velocityX,
      velocityZ: observer.velocityZ,
    };
    this.stepDeferredRoadRebuild();
    this.provinceField?.update(observer.x, observer.z);
    const residentPage = createResidentInvariantPageLookup(this.heightAtlas.residency);
    const selection = selectTerrainNodeSets({
      cameraX: observer.x,
      cameraY: observer.y ?? 0,
      cameraZ: observer.z,
      pixelsPerMeterAtUnitDistance: observer.pixelsPerMeterAtUnitDistance
        ?? DEFAULT_PIXELS_PER_METER_AT_UNIT_DISTANCE,
      pixelThreshold: this.profile.cdlodPixelThreshold,
      nodeBudget: this.options.nodeBudgetOverride ?? this.profile.cdlodNodeBudget,
      finestResidentLevel: this.profile.finestResidentLevel,
      nearFloor: vehicleNearFloor(this.profile, this.options),
      coarsestLevel: COARSEST_NODE_LEVEL,
      farPlaneMeters: 45_000,
      deviationFor: (address) => residentPage(address)?.stats.maxDeviationFromParent ?? null,
      heightRangeFor: (address) => {
        const slot = residentPage(address);
        return slot ? [slot.stats.minHeightMeters, slot.stats.maxHeightMeters] : null;
      },
    });
    this.nodes = selection.nodes;
    this.casterNodes = selection.tierNodes;
    this.stepCasterReadiness();
    this.updateAtlasResidency();
    this.writeNodeBuffers();
    // Before the pump, so this frame's coverage checks see this frame's upload.
    this.landformStream?.update(observer.x, observer.z);
    this.scanLandformRefreshes(observer);
    this.pumpComputeClients(observer);
    this.debugOverlay.update(this.heightAtlas);
  }

  /**
   * Register the per-cascade caster meshes.
   *
   * Terrain leaves the FAR field, not the caster list: inside the shortened
   * cascades it still casts, and beyond `shadowDistance` `4-7`'s horizon map
   * is the authority and there is nothing to cast into.
   */
  addShadowCasters(
    add: (mesh: Mesh) => void,
    maxDistanceMeters = this.profile.shadowDistance,
  ): void {
    this.shadowCasterDistanceMeters = Math.min(this.profile.shadowDistance, maxDistanceMeters);
    for (const mesh of this.casterMeshes) {
      if (mesh.thinInstanceCount > 0) add(mesh);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.deferredDisposals) entry.dispose();
    this.deferredDisposals = [];
    this.materialArrayBuild = null;
    this.synthesisClient?.dispose();
    this.synthesisClient = null;
    this.pageGenerator?.dispose();
    this.occlusionBake?.dispose();
    this.splatBake?.dispose();
    this.pyramid?.dispose();
    this.provinceField?.dispose();
    this.provinceField = null;
    this.drawnHeightLookup?.dispose();
    this.drawnHeightLookup = null;
    this.landformStream?.dispose();
    this.debugOverlay.dispose();
    this.heightAtlas.dispose();
    this.channelAtlas.dispose();
    this.heightAirportRebuilds.clear();
    this.channelAirportRebuilds.clear();
    this.airportInvalidations.length = 0;
    this.deferredRoadRebuild = null;
    for (const mesh of this.casterMeshes) mesh.dispose(false, false);
    this.casterMeshes = [];
    this.beautyMesh.dispose(false, false);
    // Cloud transmittance is owned by VolumetricCloudSystem.
    this.material.dispose(true, false);
    this.materialArrays?.albedoHeight.dispose();
    this.materialArrays?.normalMaterial.dispose();
  }

  // -------------------------------------------------------------------------

  /**
   * Build (or rebuild) the four compute producers against the CURRENT atlases.
   *
   * `4.5-B4(a)`: an atlas-reshaping quality switch disposed and recreated both
   * atlases and left the generator and both bakes holding the disposed ones.
   * `generate()` then early-returns forever on `!atlas.hasTextures`, slots pile
   * up un-evictable in `generating`, and terrain streaming is permanently and
   * silently dead for the session — with no error, because every guard on the
   * way down is a well-behaved early return. The old producers are disposed
   * FIRST (their `disposed` flag makes any late readback inert) and all three
   * reconstructed; the pyramid holds no atlas reference and is handed back.
   */
  private buildComputeProducers(): void {
    this.pageGenerator?.dispose();
    this.occlusionBake?.dispose();
    this.splatBake?.dispose();
    const built = (this.options.computeFactory ?? this.defaultComputeFactory)({
      heightAtlas: this.heightAtlas,
      channelAtlas: this.channelAtlas,
      existingPyramid: this.pyramid,
    });
    this.pageGenerator = built.pageGenerator;
    this.occlusionBake = built.occlusionBake;
    this.splatBake = built.splatBake;
    this.splatBake?.setVolcanicMaterials?.(this.profile.volcanicMaterials);
    this.pyramid = built.pyramid;
    this.pageGenerator?.setCollisionPagePublisher?.(this.collisionPagePublisher);
    this.pageGenerator?.setAuxPagePublisher?.(this.auxPagePublisher);
    this.pageGenerator?.setMacroEvolution?.(this.macroEvolution);
    this.pageGenerator?.setAirports?.(this.airports);
    this.splatBake?.setAirports?.(this.airports);
    // A dispatch that was in flight against the disposed atlas can never
    // complete into the new one; clear the gates so the next pump admits.
    this.generationInFlight = false;
    this.occlusionInFlight = false;
    this.splatRebakeInFlight = false;
  }

  private readonly defaultComputeFactory: TerrainComputeFactory = (input) => {
    if (!input.heightAtlas.hasTextures) {
      return { pageGenerator: null, occlusionBake: null, splatBake: null, pyramid: null };
    }
    const engine = this.scene.getEngine();
    // The landform stage reaches every height a page bake reads: the pages
    // (through the world the generator is given), the pyramid beyond them,
    // and the splat bake's page uniform. All of them read the volcanic site
    // index; the page generator holds back a page the index does not cover.
    const landform = terrainLandformInput(this.world);
    this.landformStream ??= new VolcanicSiteIndexStream(engine as WebGPUEngine, this.world);
    const landformData = this.landformStream;
    const pyramid = input.existingPyramid
      ?? new GlobalHeightPyramid(this.scene, engine, this.world.seedHash, { landform, landformData });
    return {
      pageGenerator: new TerrainPageGenerator(
        engine,
        input.heightAtlas,
        this.world.seedHash,
        this.world.airport ?? null,
        { world: this.world, channelAtlas: input.channelAtlas, landformData },
      ),
      pyramid,
      occlusionBake: new PageOcclusionBake(
        engine,
        input.heightAtlas,
        input.channelAtlas,
        pyramid as GlobalHeightPyramid,
      ),
      splatBake: new PageSplatBake(
        engine,
        input.heightAtlas,
        input.channelAtlas,
        this.world.seedHash,
        // The vegetation lattices `6-8` appends belong to the DETAIL
        // realisation, which keys on `hashSeed(String(world.seed))` — see
        // `FlightRenderer`'s GroundCoverSystem construction, which says so in
        // as many words. A guaranteed-airport world has `seedHash !==
        // sourceSeedHash`, and passing the terrain seed here baked a
        // different world's canopy into the closure channel.
        this.world.sourceSeedHash,
        this.world.seaLevel,
        this.world.latitudeDegrees,
        this.world.airport ?? null,
        terrainClimateProvinceInput(this.world),
        landform,
        landformData,
        this.world,
      ),
    };
  };

  /**
   * `4.5-C2(a)` — pay for the four terrain compute pipelines BEHIND the load
   * screen, not in the first second of flight.
   *
   * Babylon 9.21 has no async compute-pipeline path: `createComputePipeline`
   * is called synchronously on the first dispatch. Three of these shaders
   * inline the ~750-line height kernel (page generation, the global pyramid,
   * the splat bake) and the fourth is large in its own right, so the first
   * dispatch of each is a multi-hundred-millisecond in-frame stall — which is
   * most of the `maxFrameMs` 298-971 ms the capture reports during warmup. The
   * ocean's `waitForComputeReady` idiom exists for exactly this, and `5-4`/D12
   * already mandates it for erosion; this applies it to the Phase 4 shaders.
   *
   * It warms them with REAL work rather than a dummy dispatch: the coarsest
   * page under the spawn is the root the quadtree needs first anyway, so every
   * shader is compiled against valid job data and the aircraft spawns over
   * ground that already exists.
   *
   * Never throws. A pre-warm that fails is a hitch, not a broken renderer.
   */
  async warmUpComputePipelines(observerX = 0, observerZ = 0): Promise<void> {
    if (this.disposed) return;
    const generator = this.pageGenerator;
    const pyramid = this.pyramid;
    if (!generator || !pyramid) return;
    // The spawn's site index, built now rather than in 1 ms slices: the
    // page generator would hold back every page it does not cover.
    this.landformStream?.prime(observerX, observerZ);
    try {
      await pyramid.recenter(observerX, observerZ);
      const extent = WORLD_PAGE_BASE_EXTENT_METERS * 2 ** COARSEST_NODE_LEVEL;
      const address = createWorldPageAddress(
        COARSEST_NODE_LEVEL,
        Math.floor(observerX / extent),
        Math.floor(observerZ / extent),
      );
      const key = invariantSlotKey(address);
      this.heightAtlas.residency.beginFrame(0);
      this.channelAtlas.residency.beginFrame(0);
      const height = this.heightAtlas.residency.request(key, address);
      if (!height) return;
      // Eroded generation returns height and aux together. Admit both slots
      // before starting it so neither product needs a second cache.
      const channel = this.channelAtlas.residency.request(key, address);
      if (!channel) return;
      await generator.generate([height.slot]);
      await generator.ensureHydrology?.([channel.slot]);
      if (!this.occlusionBake) return;
      const baked = await this.occlusionBake.bake([channel.slot]);
      if (baked.length === 0 || !this.splatBake) return;
      const splatted = await this.splatBake.bake(baked, this.seasonDayOfYear);
      for (const slot of splatted) {
        slot.bakedSeasonDay = this.seasonDayOfYear;
        if (slot.token) this.channelAtlas.residency.complete(slot.key, slot.token, slot.stats);
      }
      this.releaseBatch(
        this.channelAtlas, baked.filter((slot) => !splatted.includes(slot)), "splat bake did not run");
    } catch {
      // Nothing to recover: the pipelines will compile on their first real
      // dispatch, which is exactly the behaviour this method improves on.
    }
  }

  /**
   * Hand the whole batch to the worker at once (`4.5-C2b`).
   *
   * One message, ten layers streaming back with their buffers transferred —
   * rather than a request per layer, which would put a message round-trip
   * between every 110 ms of work and lose most of the win.
   */
  private requestMaterialSynthesis(edge: number, layerIds: readonly number[]): void {
    const client = this.synthesisClient;
    if (!client?.isAvailable) return;
    client.request(this.world.seed, edge, layerIds);
  }

  private heightAtlasShape(): TerrainDrawnAtlasShape {
    return {
      atlasEdge: this.heightAtlas.atlasEdge,
      slotEdge: TERRAIN_HEIGHT_SLOT_EDGE,
      gutter: WORLD_PAGE_GUTTER,
      gridEdge: terrainAtlasGridEdge(this.heightAtlas.residency.slotCount),
    };
  }

  private bindAtlasesToPlugin(): void {
    this.surfacePlugin.setHeightAtlas(this.heightAtlas.texture(), this.heightAtlasShape());
    this.surfacePlugin.setChannelAtlas(
      this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.occlusion),
      this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.horizonA),
      this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.horizonB),
      [
        this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.splatId),
        this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.splatWeightLo),
        this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.splatWeightHi),
      ],
      // 6-6: the first caller of hydrologyTextures(). Only an eroded world's
      // channel atlas requires hydrology, so an analytic world passes null and
      // the fragment's wet-litter block never enters the compiled shader.
      this.channelAtlas.requiresHydrology
        ? this.channelAtlas.hydrologyTextures().shoreDistance
        : null,
      // 6-5: `lakeDepth` on the same gate, from the same accessor. C-9's last
      // dark channel gets its first named consumer here.
      this.channelAtlas.requiresHydrology
        ? this.channelAtlas.hydrologyTextures().lakeDepth
        : null,
      {
        atlasEdge: this.channelAtlas.atlasEdge,
        slotEdge: TERRAIN_CHANNEL_SLOT_EDGE,
        core: WORLD_PAGE_CHANNEL_CORE,
        gutter: WORLD_PAGE_GUTTER,
        gridEdge: terrainAtlasGridEdge(this.channelAtlas.residency.slotCount),
        basePageExtentMeters: WORLD_PAGE_BASE_EXTENT_METERS,
      },
    );
  }

  private rebuildCasterMeshes(): void {
    for (const mesh of this.casterMeshes) mesh.dispose(false, false);
    this.casterMeshes = [];
    this.casterBuffers = [];
    this.instanceBuffersBound = false;
    for (let cascade = 0; cascade < this.profile.shadowCascades; cascade += 1) {
      const mesh = new Mesh(`terrain-cdlod-caster-${cascade}`, this.scene);
      buildTerrainNodeGrid().applyToMesh(mesh, false);
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.doNotSyncBoundingInfo = true;
      // No camera draws these, and the water mirror does not either.
      mesh.layerMask = 0;
      mesh.metadata = { ...(mesh.metadata ?? {}), excludePlanarReflection: true };
      this.casterMeshes.push(mesh);
      this.casterBuffers.push(createTerrainNodeBuffers(
        this.options.nodeBudgetOverride ?? this.profile.cdlodNodeBudget,
      ));
    }
    // `4.5-B4(b)`: new caster submeshes have no ShadowDepthWrapper
    // registration until something creates their FORWARD effect, and nothing
    // ever does at layerMask 0. Re-run the startup readiness sweep for them.
    this.casterReadinessSweeps = CASTER_READINESS_SWEEP_FRAMES;
  }

  /**
   * One frame of the rebuilt-caster readiness sweep. See
   * `CASTER_READINESS_SWEEP_FRAMES`.
   */
  private stepCasterReadiness(): void {
    if (this.casterReadinessSweeps <= 0) return;
    this.casterReadinessSweeps -= 1;
    let ready = true;
    for (const mesh of this.casterMeshes) {
      if (!mesh.isReady(true)) ready = false;
    }
    if (ready) this.casterReadinessSweeps = 0;
  }

  /**
   * Admit the pages the selected nodes need, plus their parents.
   *
   * A node's PARENT page must be resident too: the geomorph samples it, and a
   * node whose parent is missing is forced to `morphK = 0` — correct, but it
   * means the transition it exists to smooth does not happen.
   */
  /**
   * Last frame's residency breakdown. OBSERVATION ONLY — nothing here feeds a
   * selection, an admission or an eviction, so publishing it cannot change
   * what it measures.
   */
  private residencyReasons: TerrainResidencyReasons = {
    drawn: 0, parent: 0, collision: 0, seed: 0, drawnBeyondShadowDistance: 0,
  };

  private updateAtlasResidency(): void {
    this.heightAtlas.residency.beginFrame(this.frameIndex);
    this.channelAtlas.residency.beginFrame(this.frameIndex);
    // `4.5-B3`: a request whose dispatch never completed used to hold its slot
    // index forever, because `evictionCandidates` considers only `resident`
    // slots. Give those back before admitting anything new.
    this.heightAtlas.residency.reclaimStalledGenerating(STALLED_SLOT_RECLAIM_FRAMES);
    this.channelAtlas.residency.reclaimStalledGenerating(STALLED_SLOT_RECLAIM_FRAMES);
    const wanted = new Map<string, WorldPageAddress>();
    const collisionOnly = new Set<string>();
    // Record WHY each page is wanted, in the order the sources are consulted, so
    // the first source to claim a key owns it. That ordering is the code's own
    // precedence, not a new rule: a page that is both drawn and in the collision
    // ring is drawn, and culling it would still break the draw.
    const reasonFor = new Map<string, "drawn" | "parent" | "collision" | "seed">();
    const pageHasNearNode = new Map<string, boolean>();
    const shadowRadius = this.shadowCasterDistanceMeters;
    // The casters' tier-only nodes sit on the pages of the patch's parents
    // nearly always, but a patch that splits all four children of a forced
    // split leaves a grandparent page only the casters draw.
    const drawnNodes = this.casterNodes === this.nodes ? this.nodes : [...this.nodes, ...this.casterNodes];
    for (const node of drawnNodes) {
      const nodeKey = `${node.address.level}:${node.address.x}:${node.address.z}`;
      if (!reasonFor.has(nodeKey)) reasonFor.set(nodeKey, "drawn");
      // PAGES, not nodes — the same unit as `drawn`. Up to
      // TERRAIN_NODES_PER_SLOT_EDGE^2 nodes share one page address, so counting
      // nodes here produced 251 against a `drawn` of 14: two different units
      // presented side by side as if they were comparable, which is the exact
      // defect this whole breakdown exists to prevent.
      //
      // A page is beyond the shadow distance only if EVERY node on it is. One
      // node inside the radius casts into view, so the page must stay resident
      // whatever the others do — the cullable set is the intersection, not the
      // union.
      const near = node.distanceMeters <= shadowRadius;
      const prior = pageHasNearNode.get(nodeKey);
      if (prior === undefined || near) pageHasNearNode.set(nodeKey, near);
      wanted.set(nodeKey, node.address);
      // `4.5-B1`: no parent above the ROOT level. A node at the coarsest level
      // has `morphK = 0` by construction (there is nothing to morph into), so
      // an L10 page is streamed, generated at ~1.9 ms and given an atlas slot
      // purely to be never sampled — four of them, measured, on every spawn.
      if (node.level >= COARSEST_NODE_LEVEL) continue;
      const parent = createWorldPageAddress(
        node.level + 1,
        Math.floor(node.address.x / 2),
        Math.floor(node.address.z / 2),
      );
      const parentKey = `${parent.level}:${parent.x}:${parent.z}`;
      if (!reasonFor.has(parentKey)) reasonFor.set(parentKey, "parent");
      wanted.set(parentKey, parent);
    }
    // Collision authority is tier-invariant. Low renders no L0 nodes, but it
    // still generates the same 5x5 L0 ring used by every other tier; those
    // pages consume no channel slots and are never added to the draw list.
    if (this.collisionPagePublisher) {
      const collisionTileX = Math.floor(
        this.streamingObserver.positionX / WORLD_PAGE_BASE_EXTENT_METERS,
      );
      const collisionTileZ = Math.floor(
        this.streamingObserver.positionZ / WORLD_PAGE_BASE_EXTENT_METERS,
      );
      for (let dz = -2; dz <= 2; dz += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const address = createWorldPageAddress(0, collisionTileX + dx, collisionTileZ + dz);
          const addressKey = `0:${address.x}:${address.z}`;
          if (!wanted.has(addressKey)) collisionOnly.add(addressKey);
          if (!reasonFor.has(addressKey)) reasonFor.set(addressKey, "collision");
          wanted.set(addressKey, address);
        }
      }
    }
    // `W-2`: a page that seeds from converged parents needs its whole 2x2
    // parent seed block RESIDENT (height and hydrology both — the GPU seed
    // pass reads the parents' stored r32f heights and the channel atlas's f16
    // log-flow field). Two consequences, in this order:
    //
    //  1. the block members join `wanted`, so they are streamed and touched
    //     (an untouched parent is an eviction candidate the moment its child
    //     stops needing it, and evicting a parent mid-DAG cancels the child);
    //  2. the child is not ADMITTED until they have converged.
    //
    // No deadlock: the dependency set is a pure function of the address and
    // always names STRICTLY COARSER levels, and the chain terminates at the
    // first macro-seeded level, whose pages are never gated. The L0 collision
    // ring is exempted from nothing — it simply waits for level 1, which is
    // admitted by exactly the same ladder and ranks ahead of it by distance.
    if (this.world.worldEvolution === "eroded") {
      // Transitive closure, so raising the chain depth needs no change here.
      // It terminates because every step strictly increases the level and the
      // rule stops naming dependencies above its max level.
      let frontier = [...wanted.values()];
      while (frontier.length > 0) {
        const next: WorldPageAddress[] = [];
        for (const address of frontier) {
          for (const parent of terrainErosionAdmissionDependencies(address)) {
            const parentKey = `${parent.level}:${parent.x}:${parent.z}`;
            // A seed-block member always needs its channel slot for the flow
            // field, even where the same page was wanted collision-only.
            collisionOnly.delete(parentKey);
            if (wanted.has(parentKey)) continue;
            if (!reasonFor.has(parentKey)) reasonFor.set(parentKey, "seed");
            wanted.set(parentKey, parent);
            next.push(parent);
          }
        }
        frontier = next;
      }
    }
    // `wanted` is final here: every source has been consulted and the erosion
    // closure has run. Counted from `reasonFor` rather than from the atlas so
    // the split sums to the WANTED set; the atlas holds a subset of it while
    // admission catches up, and mixing the two would produce a breakdown that
    // does not add up to anything.
    let drawnBeyondShadow = 0;
    for (const [key, hasNear] of pageHasNearNode) {
      if (!hasNear && reasonFor.get(key) === "drawn") drawnBeyondShadow += 1;
    }
    let drawn = 0, parents = 0, collision = 0, seed = 0;
    for (const reason of reasonFor.values()) {
      if (reason === "drawn") drawn += 1;
      else if (reason === "parent") parents += 1;
      else if (reason === "collision") collision += 1;
      else seed += 1;
    }
    this.residencyReasons = {
      drawn, parent: parents, collision, seed, drawnBeyondShadowDistance: drawnBeyondShadow,
    };
    const missingHeight: { address: WorldPageAddress }[] = [];
    const missingCollision: { address: WorldPageAddress }[] = [];
    const missingChannel: { address: WorldPageAddress }[] = [];
    for (const address of wanted.values()) {
      const key = invariantSlotKey(address);
      if (this.heightAtlas.residency.slotIndexOf(key) >= 0) {
        this.heightAtlas.residency.touch(key);
        this.channelAtlas.residency.touch(key);
        // `4.5-A3(b)`: the never-retry hole. `touch()` no-ops on a key the
        // channel atlas does not hold, and this branch used to `continue`
        // straight past it — so one refused or failed channel admission left
        // the page shading the provisional fallback FOREVER, until the height
        // page itself was evicted. Ask again.
        const addressKey = `${address.level}:${address.x}:${address.z}`;
        if (!collisionOnly.has(addressKey)
          && this.channelAtlas.residency.get(key) === undefined) {
          missingChannel.push({ address });
        }
        continue;
      }
      const addressKey = `${address.level}:${address.x}:${address.z}`;
      (collisionOnly.has(addressKey) ? missingCollision : missingHeight).push({ address });
    }
    // The shared swept flight-corridor priority (0-3), verbatim: soonest
    // needed first, so a banked turn admits what it is turning into. Height
    // first and channel second: ground before the shading of ground.
    let admitted = 0;
    const admit = (
      candidates: readonly { readonly address: WorldPageAddress }[],
      request: (key: TerrainSlotKey, address: WorldPageAddress) => unknown,
    ): void => {
      if (candidates.length === 0) return;
      const ranked = rankWorldPageStreamingCandidates(
        candidates,
        this.streamingObserver,
        TERRAIN_STREAMING_PRIORITY_OPTIONS,
      );
      for (const entry of ranked) {
        if (admitted >= this.requestBudgetPerPump) return;
        // `W-2`'s gate. `continue`, never `return`: a child waiting on its
        // parents must not hold the ladder shut behind it, and the parents it
        // waits on are candidates in this very ranking.
        if (!this.erosionSeedBlockConverged(entry.candidate.address)) continue;
        const key = invariantSlotKey(entry.candidate.address);
        if (request(key, entry.candidate.address) === null) return;
        admitted += 1;
      }
    };
    admit(missingHeight, (key, address) => {
      const height = this.heightAtlas.residency.request(key, address);
      if (height === null) return null;
      const addressKey = `${address.level}:${address.x}:${address.z}`;
      if (!collisionOnly.has(addressKey)) this.channelAtlas.residency.request(key, address);
      return height;
    });
    admit(missingCollision, (key, address) => this.heightAtlas.residency.request(key, address));
    admit(missingChannel, (key, address) => this.channelAtlas.residency.request(key, address));
  }

  /**
   * `W-2`'s admission gate, as a predicate so a residency fixture can assert
   * the ordering directly. True for every page in an analytic world, for every
   * macro-seeded level, and for a parent-seeded page whose 2x2 block has
   * converged in BOTH atlases.
   */
  private erosionSeedBlockConverged(address: WorldPageAddress): boolean {
    if (this.world.worldEvolution !== "eroded") return true;
    const dependencies = terrainErosionAdmissionDependencies(address);
    if (dependencies.length === 0) return true;
    return dependencies.every((parent) => {
      const key = invariantSlotKey(parent);
      // The parent's log-flow texels land with `markHydrologyReady`, which is
      // strictly earlier than channel residency (the occlusion and splat bakes
      // still have to run, and neither writes the flow field). Waiting for
      // full channel residency here would gate the chain on shading.
      return this.heightAtlas.residency.slotIndexOf(key) >= 0
        && this.channelAtlas.residency.get(key)?.hydrologyReady === true;
    });
  }

  /**
   * One thin-instance write per mesh per frame.
   *
   * `thinInstanceSetBuffer` updates `instancesCount` only for kind "matrix"
   * and "splatIndex" — the generic branch sets no count at all, and the
   * `thinInstanceCount` setter clamps to `matrixData.length / 16`. So the
   * matrix buffer goes first and the two custom lanes follow it.
   */
  private writeNodeBuffers(): void {
    const slotFor = (address: WorldPageAddress): number =>
      this.heightAtlas.residency.slotIndexOf(invariantSlotKey(address));
    const channelSlotFor = (address: WorldPageAddress): number =>
      this.channelAtlas.residency.slotIndexOf(invariantSlotKey(address));
    const provisionalAxisFor = (): number => terrainFallbackMaterialAxis();
    // Resolve streaming fallbacks ONCE per complete partition: the beauty
    // one, and the casters' when a near floor's patch makes it a different
    // one. Recomputing on a cascade's distance-filtered subset can omit the
    // evicted edge peer and make its packed boundary differ from the other
    // cascades, even though all passes execute the same vertex shader.
    const cornersByNode = new Map<TerrainNode, TerrainNodeCornerMorphs>();
    const resolvePartition = (nodes: readonly TerrainNode[]): void => {
      const resolvedCorners = resolveTerrainResidentCornerMorphs(nodes, slotFor);
      nodes.forEach((node, index) => cornersByNode.set(node, resolvedCorners[index]!));
    };
    resolvePartition(this.nodes);
    if (this.casterNodes !== this.nodes) resolvePartition(this.casterNodes);
    const cornerMorphsFor = (node: TerrainNode): TerrainNodeCornerMorphs =>
      cornersByNode.get(node) ?? node.cornerMorphK;
    writeTerrainNodeBuffers({
      nodes: this.nodes,
      originX: this.originX,
      originZ: this.originZ,
      slotFor,
      channelSlotFor,
      provisionalAxisFor,
      cornerMorphsFor,
    }, this.beautyBuffers);

    const cascades = this.casterMeshes.length;
    const shadowReach = Math.min(this.profile.shadowDistance, this.shadowCasterDistanceMeters);
    for (let cascade = 0; cascade < cascades; cascade += 1) {
      // Every cascade is handed [0, outer], so cascade N redraws what
      // cascades 0..N-1 already drew. `4.5-C1` measured the alternative —
      // giving each cascade its own depth slice plus half a slice of margin —
      // and it removed 2% of terrain triangles at the reference viewport and
      // none at all at `cdlod-transition`, because `distanceMeters` is 3D and
      // an airborne camera puts the whole near field inside the first slice
      // anyway. Not taken: a real risk of losing a low-sun shadow, for a
      // saving that does not measure.
      const outer = shadowReach * ((cascade + 1) / cascades);
      writeTerrainNodeBuffers({
        nodes: this.casterNodes.filter((node) => node.distanceMeters <= outer),
        originX: this.originX,
        originZ: this.originZ,
        slotFor,
        channelSlotFor,
        provisionalAxisFor,
        cornerMorphsFor,
      }, this.casterBuffers[cascade]!);
    }

    // The GPU buffers are created ONCE, at capacity, and updated in place from
    // then on. Re-creating them per frame destroys buffers a recorded render
    // bundle still references, which invalidates the frame's whole command
    // buffer — a black screen, sky included.
    if (!this.instanceBuffersBound) {
      bindTerrainNodeBuffers(this.beautyMesh, this.beautyBuffers);
      for (let cascade = 0; cascade < this.casterMeshes.length; cascade += 1) {
        bindTerrainNodeBuffers(this.casterMeshes[cascade]!, this.casterBuffers[cascade]!);
      }
      this.instanceBuffersBound = true;
    }
    updateTerrainNodeBuffers(this.beautyMesh, this.beautyBuffers);
    for (let cascade = 0; cascade < this.casterMeshes.length; cascade += 1) {
      updateTerrainNodeBuffers(this.casterMeshes[cascade]!, this.casterBuffers[cascade]!);
    }
  }
  /**
   * Every terrain compute client, admitted through ONE plan (`4.5-B2(c)`).
   *
   * Both pumps used to call `ComputeBudget.beginFrame()` themselves, so each
   * wiped the other's plan and spent a fresh cap — the `4-0b` "one cap per
   * frame" invariant broken in the owner's own call sites, and invisible
   * because no test submitted two clients in one frame (assertion 112 does
   * now). The splat bake was never priced at all: it ran attached to the
   * occlusion bake's admission and spent `splatCompute`'s row silently.
   *
   * Order matters twice over: every demand is declared before any admission is
   * read (the meter resolves lazily and a late `submit` invalidates the plan),
   * and the declaration order is the priority order the budget publishes.
   */
  private pumpComputeClients(observer: TerrainObserver): void {
    this.observeDispatchCosts();
    this.computeBudget.beginFrame();
    this.stepAirportInvalidation();
    const heightPending = this.pendingHeightGeneration();
    const heightRegenerations = this.pendingHeightRegenerations();
    const channelPending = this.pendingChannelBake(observer);
    const channelRebakes = this.pendingChannelAirportRebakes();
    const splatRebakes = this.pendingSplatRebakes();
    // Landform refreshes take what new pages and airport rebuilds leave: none
    // while any wait.
    const heightRefreshes = heightPending.length + heightRegenerations.length === 0
      ? this.pendingLandformRefreshes()
      : NO_SLOTS;
    const channelLandformRebakes = channelPending.length + channelRebakes.length === 0
      ? this.pendingLandformChannelRebakes()
      : NO_SLOTS;
    const heightClient = this.world.worldEvolution === "eroded"
      ? "erosionCompute"
      : "terrainCompute";
    // `W-1d`: the GPU page DAG prices DISPATCHES, not pages. One page's DAG is
    // ~80 dispatches spread over many frames, so a page-shaped demand at a
    // page-shaped cost would either ride the floor-of-one at 80x the cap or
    // stall on the first frame. The producer answers with what its CURRENT
    // stage would spend; a null answer is the historical CPU-worker shape.
    const erosionDagDemand = this.world.worldEvolution === "eroded"
      ? this.pageGenerator?.erosionDagDemand?.(heightPending.length) ?? null
      : null;
    if (erosionDagDemand) {
      if (erosionDagDemand.count > 0) {
        this.computeBudget.submit(
          "erosionCompute",
          erosionDagDemand.count,
          erosionDagDemand.costMs,
        );
      }
    } else if (heightPending.length + heightRegenerations.length + heightRefreshes.length > 0) {
      // The activated worker pass is the Phase-5 erosion client even though
      // its final bytes upload through the height atlas. Booking it as
      // terrainCompute would silently bypass the only tier pacing lever the
      // evolution contract permits (D11 / assertion 105). An airport
      // regeneration or a landform refresh is the same dispatch at the same
      // per-page price, so it is the same demand — never a second meter.
      this.computeBudget.submit(
        heightClient,
        heightPending.length + heightRegenerations.length
          + Math.min(heightRefreshes.length, TERRAIN_LANDFORM_REFRESH.maxPagesPerFrame),
      );
    }
    // `6-11`: the global horizon bake shares the OCCLUSION row rather than
    // taking one of its own, and the reason is a wall the row table records
    // rather than a preference: `SubsystemBudgetMs.groundCoverCompute` notes
    // that tier 2 sums to 13.65 ms against a 13.7 ms target, leaving 0.05 ms
    // of slack, and that "the next row addition finds the wall". This is that
    // addition. Sharing costs the table nothing, and the two are honestly the
    // same family — the same operator over a coarser field.
    //
    // It is priced at the channel PAIR's cost, not its own (~0.27 ms scaled
    // from the occlusion seed's measured 0.301 ms/page at 136² over this
    // bake's 128²). Over-pricing only ever admits it LESS often, which is the
    // safe direction for a term that degrades to "last position's field".
    const horizonOwed = this.pyramid?.needsHorizonBake ?? false;
    const channelPairCostMs = this.computeBudget.estimatedCostMs("occlusionCompute")
      + this.computeBudget.estimatedCostMs("splatCompute");
    const channelDemand = channelPending.length + channelRebakes.length
      + Math.min(channelLandformRebakes.length, TERRAIN_LANDFORM_REFRESH.maxPagesPerFrame);
    if (channelDemand > 0 || horizonOwed) {
      // A channel slot's TWO bakes are ONE admission: occlusion writes three
      // textures, the splat writes four, both into the same slot, and the slot
      // is published only once both have run — publishing between them puts
      // material 0 at weight 0 (sand) on screen, permanently, because a slot
      // is baked once. So the pair is submitted as one demand at the combined
      // per-page cost, to the LOWER-priority of the two clients: a paired unit
      // of work must not jump the queue on the strength of its cheaper half.
      this.computeBudget.submit(
        "occlusionCompute",
        channelDemand + (horizonOwed ? 1 : 0),
        channelPairCostMs,
      );
    }
    if (splatRebakes.length > 0) {
      // A season re-bake is the splat dispatch alone; occlusion is
      // geometry-only and never goes stale.
      this.computeBudget.submit("splatCompute", splatRebakes.length);
    }
    this.dispatchPageGeneration(
      heightPending, heightRegenerations, erosionDagDemand !== null, heightRefreshes);
    // Read ONCE — `admitted` settles the client, so a second read would report
    // a plan this frame has already dispatched against (`6-9`'s rule).
    let occlusionAdmitted = this.computeBudget.admitted("occlusionCompute");
    if (horizonOwed && occlusionAdmitted > 0) {
      // The horizon bake takes the first admission when one is owed. Deferring
      // a PAGE bake by a frame is invisible by design; deferring the horizon
      // bake leaves the far field lit for another 512 m of travel.
      occlusionAdmitted -= 1;
      void this.pyramid?.bakeHorizon?.().catch(() => undefined);
    }
    if (channelPending.length + channelRebakes.length > 0) {
      this.dispatchChannelBake(channelPending, channelRebakes, occlusionAdmitted);
    } else {
      this.dispatchLandformChannelRebake(channelLandformRebakes, occlusionAdmitted);
    }
    this.dispatchSplatRebake(splatRebakes);
  }

  /**
   * `4.5-B2(a)`: feed the meter what its dispatches actually cost.
   *
   * `ComputeBudget.observeDispatchCostMs` shipped with ZERO call sites, so
   * every estimate sat at its seed forever and the admission plan was a
   * statement about the budget table rather than about the GPU. Babylon
   * publishes a per-compute-shader `gpuTimeInFrame` counter whenever the
   * adapter granted `timestamp-query`; the producers divide it by their batch
   * size and hand back a per-page number.
   *
   * Sampled at the TOP of the pump, before this frame's plan is built, because
   * timestamp readback lands one or more frames after the dispatch it timed.
   */
  private observeDispatchCosts(): void {
    const terrain = this.pageGenerator?.consumeMeasuredDispatchCostMs();
    if (terrain !== null && terrain !== undefined) {
      this.computeBudget.observeDispatchCostMs("terrainCompute", terrain);
    }
    const occlusion = this.occlusionBake?.consumeMeasuredDispatchCostMs();
    if (occlusion !== null && occlusion !== undefined) {
      this.computeBudget.observeDispatchCostMs("occlusionCompute", occlusion);
    }
    const splat = this.splatBake?.consumeMeasuredDispatchCostMs();
    if (splat !== null && splat !== undefined) {
      this.computeBudget.observeDispatchCostMs("splatCompute", splat);
    }
    // `W-1d`: `erosionCompute` shipped with NO cost observation at all, so its
    // estimate sat on the placeholder seed forever while the page DAG became
    // the heaviest compute client in eroded mode. The producer averages every
    // stage counter that resolved this frame; the meter's own smoothing then
    // tracks whichever stage mix is running.
    const erosion = this.pageGenerator?.consumeMeasuredErosionDispatchCostMs?.();
    if (erosion !== null && erosion !== undefined) {
      this.computeBudget.observeDispatchCostMs("erosionCompute", erosion);
    }
  }

  private pendingHeightGeneration(): readonly TerrainAtlasSlot[] {
    if (!this.pageGenerator || this.generationInFlight) return [];
    if (this.world.worldEvolution === "eroded" && !this.macroEvolution) return [];
    return this.heightAtlas.residency.entries.filter(
      (slot) => slot.lifecycle.state === "generating"
        && slot.token !== null
        // Phase 5 keeps the slot private until the whole generation DAG and
        // collision readback finish. Submission state prevents duplicate work
        // without making partially generated texels visible.
        && !slot.generationSubmitted,
    );
  }

  /**
   * `setAirports`' owed height pages: resident and analytic. Empty while a
   * generation is in flight, like the fresh pages. Walks the rebuild queue
   * only — nothing at all on a frame with no airport backlog — into a reused
   * list, pruning slots that were evicted or are done.
   */
  private pendingHeightRegenerations(): readonly TerrainAtlasSlot[] {
    const queue = this.heightAirportRebuilds;
    if (queue.size === 0 || !this.pageGenerator || this.generationInFlight) return NO_SLOTS;
    const pending = this.heightRegenerationScratch;
    pending.length = 0;
    for (const slot of queue) {
      const state = slot.lifecycle.state;
      // A released slot is never resident or generating again: its object is
      // dropped, and a re-request of the page builds a new one.
      const live = state === "resident" || state === "generating";
      if (!live || (!slot.airportRebuildOwed && !slot.airportRebuildInFlight)) {
        queue.delete(slot);
        continue;
      }
      if (slot.airportRebuildOwed && state === "resident") pending.push(slot);
    }
    return pending;
  }

  private dispatchPageGeneration(
    pending: readonly TerrainAtlasSlot[],
    regenerations: readonly TerrainAtlasSlot[],
    dagProducer: boolean,
    refreshes: readonly TerrainAtlasSlot[] = NO_SLOTS,
  ): void {
    const generator = this.pageGenerator;
    if (!generator) return;
    const eroded = this.world.worldEvolution === "eroded";
    const admitted = this.computeBudget.admitted(eroded ? "erosionCompute" : "terrainCompute");
    if (admitted <= 0) return;
    // `W-1d`: a DAG already holding a page must be pumped even on a frame with
    // no pending admissions left — otherwise the page that is 90% eroded stops
    // the moment the atlas runs out of new work and the slot never converges.
    const dagActive = dagProducer && (generator.hasActiveErosionDag?.() ?? false);
    const regenerating = dagProducer ? [] : regenerations;
    if (pending.length === 0 && regenerating.length === 0 && !dagActive) {
      if (!dagProducer) this.dispatchLandformRefresh(refreshes, admitted);
      return;
    }
    const ranked = this.rankForDispatch(pending);
    // The erosion producer takes ONE page at a time and needs the whole ranked
    // set to choose it; the analytic batch is sliced to its admitted count.
    // Fresh pages first: a missing page is a hole, an owed one is ground that
    // is merely out of date, and it keeps drawing until its turn.
    const batch = dagProducer
      ? ranked
      : regenerating.length === 0
        ? ranked.slice(0, admitted)
        : [...ranked, ...this.rankForDispatch(regenerating)].slice(0, admitted);
    // Built against the CURRENT list from here (see stepAirportInvalidation).
    if (!dagProducer) {
      for (const slot of batch) slot.airportListVersion = this.airportListVersion;
    }
    const inPlace = regenerating.length === 0
      ? NO_SLOTS
      : batch.filter((slot) => slot.lifecycle.state === "resident");
    for (const slot of inPlace) {
      slot.airportRebuildOwed = false;
      slot.airportRebuildInFlight = true;
      slot.generationSubmitted = false;
    }
    this.generationInFlight = true;
    void generator.generate(batch, admitted)
      .catch(() => {
        // The DAG owns exactly one of these slots and fails it on its own
        // token; releasing the whole ranked candidate set here would evict
        // every queued page because one dispatch went wrong. Resident slots
        // hold no token, so this never releases one.
        if (!dagProducer) this.releaseBatch(this.heightAtlas, batch, "page generation failed");
      })
      .finally(() => {
        this.generationInFlight = false;
        // The producer marks what it dispatched. A regeneration it declined
        // (readback ring full, buffers not ready) or that threw is owed again;
        // a setAirports landing meanwhile has already re-marked it.
        for (const slot of inPlace) {
          if (!slot.generationSubmitted) slot.airportRebuildOwed = true;
          slot.generationSubmitted = false;
          slot.airportRebuildInFlight = false;
        }
      });
  }

  /**
   * Queue the resident height pages due a landform refresh
   * (`TERRAIN_LANDFORM_REFRESH`). Runs after a kilometre of travel or a new
   * index, and only while the index is settled: a page refreshed against an
   * index still being built would only need it again.
   */
  private scanLandformRefreshes(observer: TerrainObserver): void {
    const stream = this.landformStream;
    if (!stream || !stream.enabled || stream.building) return;
    const moved = Math.hypot(observer.x - this.landformScanX, observer.z - this.landformScanZ);
    if (moved < TERRAIN_LANDFORM_REFRESH.scanMeters && stream.uploadCount === this.landformScanUploads) return;
    this.landformScanX = observer.x;
    this.landformScanZ = observer.z;
    this.landformScanUploads = stream.uploadCount;
    const queue = this.landformRefreshes;
    queue.length = 0;
    for (const slot of this.heightAtlas.residency.entries) {
      if (this.landformRefreshPending(slot)) queue.push(slot);
    }
  }

  /** Whether a height slot is resident, idle, and due a refresh for the last scan's observer. */
  private landformRefreshPending(slot: TerrainAtlasSlot): boolean {
    const stream = this.landformStream;
    return stream !== null
      && slot.landformCoverage !== null
      && slot.lifecycle.state === "resident"
      && slot.address.level > 0
      && !slot.generationSubmitted
      && terrainLandformRefreshDue(
        slot.address, slot.landformCoverage, stream.coverage, this.landformScanX, this.landformScanZ);
  }

  /** The queued refreshes still due, compacted in place (no allocation). */
  private pendingLandformRefreshes(): readonly TerrainAtlasSlot[] {
    const queue = this.landformRefreshes;
    if (queue.length === 0 || this.generationInFlight || !this.pageGenerator?.refresh) return NO_SLOTS;
    if (this.landformStream?.building) return NO_SLOTS;
    let kept = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const slot = queue[index]!;
      if (this.landformRefreshPending(slot)) queue[kept++] = slot;
    }
    queue.length = kept;
    return queue;
  }

  private dispatchLandformRefresh(pending: readonly TerrainAtlasSlot[], admitted: number): void {
    const generator = this.pageGenerator;
    if (!generator?.refresh || pending.length === 0) return;
    const batch = this.rankForDispatch(pending)
      .slice(0, Math.min(admitted, TERRAIN_LANDFORM_REFRESH.maxPagesPerFrame));
    this.generationInFlight = true;
    void generator.refresh(batch)
      .then((refreshed) => {
        // The height texels changed under the channel page's occlusion,
        // horizon and splat (which reads the volcanic ground too).
        for (const slot of refreshed) {
          const channel = this.channelAtlas.residency.get(slot.key);
          if (channel?.lifecycle.state === "resident" && !this.landformChannelRebakes.includes(channel)) {
            this.landformChannelRebakes.push(channel);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.generationInFlight = false;
      });
  }

  /** Channel pages owed a re-bake whose height page is resident and settled, compacted in place. */
  private pendingLandformChannelRebakes(): readonly TerrainAtlasSlot[] {
    const queue = this.landformChannelRebakes;
    if (queue.length === 0 || this.occlusionInFlight || !this.occlusionBake) return NO_SLOTS;
    let kept = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const slot = queue[index]!;
      if (slot.lifecycle.state !== "resident") continue;
      const height = this.heightAtlas.residency.get(slot.key);
      if (!height || height.lifecycle.state !== "resident") continue;
      queue[kept++] = slot;
    }
    queue.length = kept;
    // Wait out a height refresh still in flight; its rebake follows it.
    for (const slot of queue) {
      if (this.heightAtlas.residency.get(slot.key)?.generationSubmitted) return NO_SLOTS;
    }
    return queue;
  }

  /**
   * Re-bake channel pages in place after their height page was refreshed:
   * occlusion then splat, the pair a new page gets, without the slot ever
   * leaving residency (as the season splat re-bake does).
   */
  private dispatchLandformChannelRebake(pending: readonly TerrainAtlasSlot[], admitted: number): void {
    const bake = this.occlusionBake;
    if (!bake || pending.length === 0 || admitted <= 0) return;
    const batch = this.rankForDispatch(pending)
      .slice(0, Math.min(admitted, TERRAIN_LANDFORM_REFRESH.maxPagesPerFrame));
    const queue = this.landformChannelRebakes;
    let kept = 0;
    for (let index = 0; index < queue.length; index += 1) {
      if (!batch.includes(queue[index]!)) queue[kept++] = queue[index]!;
    }
    queue.length = kept;
    this.occlusionInFlight = true;
    const seasonDay = this.seasonDayOfYear;
    void (async () => {
      try {
        const baked = await bake.bake(batch);
        const splatted = this.splatBake && baked.length > 0
          ? await this.splatBake.bake(baked, seasonDay)
          : baked;
        for (const slot of splatted) slot.bakedSeasonDay = seasonDay;
        // Whatever did not run is owed still.
        for (const slot of batch) {
          if (!splatted.includes(slot) && !queue.includes(slot)) queue.push(slot);
        }
      } catch {
        // Owed still; the next frame offers it again.
        for (const slot of batch) {
          if (!queue.includes(slot)) queue.push(slot);
        }
      } finally {
        this.occlusionInFlight = false;
      }
    })();
  }

  private pendingChannelBake(observer: TerrainObserver): readonly TerrainAtlasSlot[] {
    const pyramid = this.pyramid;
    if (!this.occlusionBake || !pyramid || this.occlusionInFlight) return [];
    void pyramid.recenter(observer.x, observer.z).catch(() => undefined);
    if (!pyramid.isResident) return [];
    return this.channelAtlas.residency.entries.filter(
      (slot) => slot.lifecycle.state === "generating"
        && slot.token !== null
        && this.heightSlotCurrentForBake(slot),
    );
  }

  /**
   * A channel bake reads its height slot's texels, so it waits for that slot
   * to be resident AND for any airport regeneration of it to be recorded:
   * baked first, it would describe the ground the new runway replaced.
   */
  private heightSlotCurrentForBake(channelSlot: TerrainAtlasSlot): boolean {
    // ONE lookup, as the `slotIndexOf(...) >= 0` this replaces made.
    const height = this.heightAtlas.residency.get(channelSlot.key);
    return height?.lifecycle.state === "resident"
      && !height.airportRebuildOwed
      && !height.airportRebuildInFlight;
  }

  /**
   * `setAirports`' owed channel pages: resident, with their heights current.
   * Walks the rebuild queue only, into a reused list, like the height pump.
   */
  private pendingChannelAirportRebakes(): readonly TerrainAtlasSlot[] {
    const queue = this.channelAirportRebuilds;
    if (queue.size === 0) return NO_SLOTS;
    if (!this.occlusionBake || !this.pyramid?.isResident || this.occlusionInFlight) return NO_SLOTS;
    const pending = this.channelRebakeScratch;
    pending.length = 0;
    for (const slot of queue) {
      const state = slot.lifecycle.state;
      // Not owed any more: batched as a fresh page or re-baked. An in-flight
      // re-bake that fails is queued again by `dispatchChannelBake`.
      if (!slot.airportRebuildOwed || (state !== "resident" && state !== "generating")) {
        queue.delete(slot);
        continue;
      }
      if (state === "resident" && this.heightSlotCurrentForBake(slot)) pending.push(slot);
    }
    return pending;
  }

  private dispatchChannelBake(
    pending: readonly TerrainAtlasSlot[],
    rebakes: readonly TerrainAtlasSlot[],
    admitted: number,
  ): void {
    const bake = this.occlusionBake;
    if (!bake || pending.length + rebakes.length === 0) return;
    if (admitted <= 0) return;
    // Fresh pages first, as in the height pump: an unbaked page shades the
    // provisional fallback, an owed one only the ground before the change.
    const batch = rebakes.length === 0
      ? this.rankForDispatch(pending).slice(0, admitted)
      : [...this.rankForDispatch(pending), ...this.rankForDispatch(rebakes)].slice(0, admitted);
    // Batched now, so each bakes the CURRENT airport list and heights; a
    // setAirports landing before its bakes record marks it again.
    for (const slot of batch) {
      slot.airportRebuildOwed = false;
      slot.airportListVersion = this.airportListVersion;
    }
    const inPlace = rebakes.length === 0 ? NO_SLOTS : batch.filter((slot) => slot.token === null);
    const channelAtlas = this.channelAtlas;
    this.occlusionInFlight = true;
    const seasonDay = this.seasonDayOfYear;
    // BOTH channel bakes, then residency — in that order, and awaited rather
    // than chained past. A channel slot carries occlusion and splat, and
    // publishing it between the two put a zeroed splat on screen: material 0
    // at weight 0, which is sand. The failure is permanent, because a slot is
    // only baked once.
    void (async () => {
      let written: readonly TerrainAtlasSlot[] = [];
      try {
        await this.pageGenerator?.ensureHydrology?.(batch);
        const ready = batch.filter((slot) => slot.hydrologyReady);
        if (ready.length === 0) return;
        const baked = await bake.bake(ready);
        if (baked.length === 0) return;
        // Publish ONLY what the splat bake wrote. A slot it did not write reads
        // as sand, permanently, because it is marked baked for this season.
        const splatted = this.splatBake ? await this.splatBake.bake(baked, seasonDay) : baked;
        written = splatted;
        for (const slot of splatted) {
          slot.bakedSeasonDay = seasonDay;
          if (slot.token) this.channelAtlas.residency.complete(slot.key, slot.token, slot.stats);
        }
        this.releaseBatch(
          this.channelAtlas, baked.filter((slot) => !splatted.includes(slot)), "splat bake did not run");
      } catch {
        this.releaseBatch(this.channelAtlas, batch, "channel bake failed");
      } finally {
        // An in-place re-bake is never released — the slot keeps drawing what
        // it had — so one that did not get both bakes is simply owed again,
        // unless the atlas it lived in was rebuilt meanwhile.
        if (this.channelAtlas === channelAtlas) {
          for (const slot of inPlace) {
            if (written.includes(slot)) continue;
            slot.airportRebuildOwed = true;
            this.channelAirportRebuilds.add(slot);
          }
        }
        this.occlusionInFlight = false;
      }
    })();
  }

  /**
   * `4.5-A3(c)`: resident channel slots whose splat was baked for a season
   * bucket the clock has left behind.
   *
   * The splat bake keys its slot on `invariantSlotKey` and bakes once, so
   * before this the snowline froze at whatever day the page happened to stream
   * in on — and with `4.5-A2` taking the ids from the LOW bucket rather than
   * mixing them, a rollover moves the ids too. Occlusion and the horizon field
   * are geometry-only and never need this.
   */
  private pendingSplatRebakes(): readonly TerrainAtlasSlot[] {
    if (!this.splatBake || this.splatRebakeInFlight) return [];
    return this.channelAtlas.residency.entries.filter(
      (slot) => slot.lifecycle.state === "resident"
        && slot.bakedSeasonDay !== null
        && slot.bakedSeasonDay !== this.seasonDayOfYear
        && this.heightAtlas.residency.slotIndexOf(slot.key) >= 0,
    );
  }

  private dispatchSplatRebake(pending: readonly TerrainAtlasSlot[]): void {
    const splatBake = this.splatBake;
    if (!splatBake || pending.length === 0) return;
    const admitted = this.computeBudget.admitted("splatCompute");
    if (admitted <= 0) return;
    const batch = this.rankForDispatch(pending).slice(0, admitted);
    this.splatRebakeInFlight = true;
    const seasonDay = this.seasonDayOfYear;
    void splatBake.bake(batch, seasonDay)
      .then((splatted) => {
        // The slot never leaves `resident`: its texels are overwritten in
        // place, so there is no window in which it reads as unbaked. Only the
        // slots actually re-baked move to the new season; the rest stay owed.
        for (const slot of splatted) slot.bakedSeasonDay = seasonDay;
      })
      .catch(() => undefined)
      .finally(() => {
        this.splatRebakeInFlight = false;
      });
  }

  /**
   * `4.5-B3`: rank a pending set against the CURRENT corridor before slicing
   * it to the admitted count.
   *
   * `residency.entries` is Map insertion order, i.e. the order pages were
   * first requested — so a banked turn appended the newly urgent pages behind
   * tens of stale ones and the pump drained them FIFO. Re-ranking costs one
   * sort of a set that is at most the atlas slot count.
   */
  private rankForDispatch(pending: readonly TerrainAtlasSlot[]): readonly TerrainAtlasSlot[] {
    if (pending.length <= 1) return pending;
    const ranked = rankWorldPageStreamingCandidates(
      pending.map((slot) => ({ address: slot.address, slot })),
      this.streamingObserver,
      TERRAIN_STREAMING_PRIORITY_OPTIONS,
    );
    return ranked.map((entry) => entry.candidate.slot);
  }


  private releaseBatch(
    atlas: TerrainPageAtlas,
    batch: readonly TerrainAtlasSlot[],
    message: string,
  ): void {
    for (const slot of batch) {
      if (slot.token) atlas.residency.fail(slot.key, slot.token, message);
    }
  }
}

/**
 * Create the mesh's instance buffers once, at capacity.
 *
 * The matrix buffer FIRST: it is the only kind that sets `instancesCount`, so
 * setting the custom lanes before it would leave them describing zero
 * instances.
 */
function bindTerrainNodeBuffers(mesh: Mesh, buffers: TerrainNodeBuffers): void {
  mesh.thinInstanceSetBuffer("matrix", buffers.matrices, 16, false);
  mesh.thinInstanceSetBuffer(
    TERRAIN_NODE_ATTRIBUTE_A, buffers.laneA, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
  mesh.thinInstanceSetBuffer(
    TERRAIN_NODE_ATTRIBUTE_B, buffers.laneB, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
}

/** Push this frame's writes into the existing buffers, and set the count. */
function updateTerrainNodeBuffers(mesh: Mesh, buffers: TerrainNodeBuffers): void {
  mesh.thinInstanceBufferUpdated("matrix");
  mesh.thinInstanceBufferUpdated(TERRAIN_NODE_ATTRIBUTE_A);
  mesh.thinInstanceBufferUpdated(TERRAIN_NODE_ATTRIBUTE_B);
  mesh.thinInstanceCount = buffers.count;
}
