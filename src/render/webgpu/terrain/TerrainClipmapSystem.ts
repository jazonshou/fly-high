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
import { TERRAIN_REFERENCE_DAY_OF_YEAR, type WorldDefinition } from "@/src/world";
import { GlobalHeightPyramid } from "./GlobalHeightPyramid";
import { synthesizeSurfaceMaterial } from "./MaterialArraySynthesis";
import {
  uploadSurfaceMaterialArrays,
  type SurfaceMaterialArrays,
} from "./MaterialArrayUpload";
import { MaterialSynthesisClient } from "./MaterialSynthesisClient";
import { PageOcclusionBake, PageSplatBake } from "./PageOcclusionBake";
import { SURFACE_MATERIALS } from "./surfaceMaterials";
import { TerrainDebugOverlay, type TerrainDebugOverlayMode } from "./TerrainDebugOverlay";
import {
  TERRAIN_CHANNEL_TEXTURES,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
  type TerrainAuxPagePublisher,
  type TerrainCollisionPagePublisher,
  type TerrainAtlasSlot,
} from "./TerrainPageAtlas";
import { terrainErosionAdmissionDependencies } from "./TerrainPageErosion";
import type { TerrainSlotKey } from "./TerrainSpineContract";
import {
  buildTerrainNodeGrid,
  createTerrainNodeBuffers,
  resolveTerrainResidentCornerMorphs,
  selectTerrainNodes,
  writeTerrainNodeBuffers,
  type TerrainNode,
  type TerrainNodeBuffers,
  type TerrainNodeCornerMorphs,
} from "./TerrainQuadtree";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_PROVISIONAL_AXIS,
  seasonBucketBlend,
  TERRAIN_NODE_ATTRIBUTE_A,
  TERRAIN_NODE_ATTRIBUTE_B,
  TERRAIN_NODE_ATTRIBUTE_STRIDE,
  terrainAtlasGridEdge,
} from "./TerrainSpineContract";
import { TerrainSurfacePlugin } from "./TerrainSurfacePlugin";
// 6-5: the shore sea state travels as 6-2's own published type — one
// definition, forwarded, never restated on the terrain side.
import type { WaterShoreSwell } from "@/src/render/webgpu/water/WaterShaders";
import type { TerrainMacroEvolutionExport } from "./TerrainEvolutionContract";

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
   */
  generate(slots: readonly TerrainAtlasSlot[], admittedDispatches?: number): Promise<void>;
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
  bake(slots: readonly TerrainAtlasSlot[], dayOfYear: number): Promise<number>;
  consumeMeasuredDispatchCostMs(): number | null;
  dispose(): void;
}

export interface TerrainHeightPyramidProducer {
  recenter(x: number, z: number): Promise<unknown>;
  readonly isResident: boolean;
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

export interface TerrainClipmapStatistics {
  /** Height-atlas slots holding a generated page. */
  readonly residentPages: number;
  /** Slots whose generation dispatch is in flight. */
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
  material.metallic = 0;
  // 3-7 replaces this per fragment from the 3-0 BRDF table. It survives as
  // the value the material compiles with before the arrays are bound (and
  // under NullEngine, which cannot hold a 2D array at all) — never as the
  // shipped answer, which is what the audit's uniform 0.93 was.
  material.roughness = 0.93;
  material.albedoColor = Color3.White();
  // 1C-6: full-strength now that scene.environmentTexture exists — the
  // old 0.64/0.22 were compensating for IBL that did not exist.
  material.environmentIntensity = 1;
  material.directIntensity = 1.03;
  material.specularIntensity = 1;
  // 1B-11: kill specular shimmer on ridge lines under motion. Its partner,
  // anisotropicFilteringLevel = 16, is a per-texture setting and lands on
  // the 3-1 arrays; the two are complementary — one fixes the normal map's
  // lost variance (with the Toksvig reducer), the other the geometric
  // normal's.
  material.enableSpecularAntiAliasing = true;
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
  /** False under NullEngine, where a TEXTURE_2D_ARRAY upload cannot be expressed. */
  private canBuildArrays = false;
  /** The edge the arrays SHOULD have; the build runs until they do. */
  private materialArrayEdge = 0;
  /** One material's synthesis per frame, in flight. */
  private materialArrayBuild: {
    readonly edge: number;
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
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldDefinition,
    profile: WebGpuQualityProfile,
    private readonly options: TerrainClipmapSystemOptions = {},
  ) {
    this.profile = profile;
    this.worldRevision = terrainWorldRevision(world);
    this.material = createTerrainMaterial(scene);
    this.surfacePlugin = attachTerrainSurfacePlugin(this.material, scene);
    this.surfacePlugin.setSamplingProfile(
      profile.terrainTriplanarMode,
      profile.heightBlendMaxMaterials,
    );
    // 6-8: the canopy handoff needs the tier's vegetation band radii. They are
    // the rendered-density law's, carried on the profile since the perf-debt
    // pass, so terrain reads them as data and never re-derives a radius.
    this.surfacePlugin.setCanopyBands(
      profile.renderedDensityLaw.near.outerRadiusMeters,
      profile.renderedDensityLaw.far.outerRadiusMeters,
      profile.renderedDensityLaw.farFloorShare,
    );
    this.surfacePlugin.setSeason(this.seasonDayOfYear, world.latitudeDegrees, world.seaLevel);
    // 3-9: the runway is painted into this material by the analytic airport
    // SDF. Nothing else needs to know — no mesh, no second material.
    this.surfacePlugin.setRunway(world.airport);
    const engineFlags = scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    this.canBuildArrays = Boolean(engineFlags.isWebGPU || engineFlags._gl);
    this.materialArrayEdge = profile.materialArrayEdge;
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

    this.beautyBuffers = createTerrainNodeBuffers(
      options.nodeBudgetOverride ?? profile.cdlodNodeBudget,
    );
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
    if (this.materialArrayBuild === null) {
      if (this.materialArrays?.edge === this.materialArrayEdge) return;
      this.materialArrayBuild = {
        edge: this.materialArrayEdge,
        albedoHeight: [],
        normalMaterial: [],
        index: 0,
      };
      this.requestMaterialSynthesis(this.materialArrayEdge);
    }
    const build = this.materialArrayBuild;
    if (build.edge !== this.materialArrayEdge) {
      // A profile change superseded it; the next frame restarts at the new edge.
      this.materialArrayBuild = null;
      this.synthesisClient?.cancel();
      return;
    }
    const spec = SURFACE_MATERIALS[build.index];
    if (spec) {
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
        if (build.index < SURFACE_MATERIALS.length) return;
      } else {
        // No worker, or its layer has not landed yet. The inline path is the
        // fallback AND the Node/headless path; it stays one layer per frame.
        if (this.synthesisClient?.isAvailable && this.synthesisClient.requestedEdge === build.edge) {
          return;
        }
        const inline = synthesizeSurfaceMaterial(spec.id, this.world.seed, build.edge);
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
    this.surfacePlugin.setArrays(replacement.albedoHeight, replacement.normalMaterial);
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
      pendingPages: this.heightAtlas.residency.generatingCount,
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

  /** 4-2/4-3: the GPU page atlases, for the generator and the surface plugin. */
  get atlases(): { readonly height: TerrainPageAtlas; readonly channel: TerrainPageAtlas } {
    return { height: this.heightAtlas, channel: this.channelAtlas };
  }

  /** The selected node set, so 4-10's capture can assert on it. */
  get selectedNodes(): readonly TerrainNode[] {
    return this.nodes;
  }

  setProfile(profile: WebGpuQualityProfile): void {
    if (profile === this.profile) return;
    const atlasReshaped = profile.heightAtlasSlots !== this.heightAtlas.residency.slotCount
      || profile.channelAtlasSlots !== this.channelAtlas.residency.slotCount;
    const cascadesChanged = profile.shadowCascades !== this.profile.shadowCascades;
    this.profile = profile;
    this.surfacePlugin.setSamplingProfile(
      profile.terrainTriplanarMode,
      profile.heightBlendMaxMaterials,
    );
    this.surfacePlugin.setCanopyBands(
      profile.renderedDensityLaw.near.outerRadiusMeters,
      profile.renderedDensityLaw.far.outerRadiusMeters,
      profile.renderedDensityLaw.farFloorShare,
    );
    this.materialArrayEdge = profile.materialArrayEdge;
    this.computeBudget.setProfile(profile);
    if (atlasReshaped) {
      // A slot index addresses a different texel in a reshaped atlas, so
      // residency cannot survive the change — dropping it is correct, not
      // lazy. Fix-pack T8: the DISPOSAL is deferred like the material-array
      // swap's — a frame that already recorded draws against the old atlas
      // textures must not have them destroyed under its submit.
      const retiredHeightAtlas = this.heightAtlas;
      const retiredChannelAtlas = this.channelAtlas;
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
    const bucketDays = 365 / 24;
    const offset = Math.round((dayOfYear - TERRAIN_REFERENCE_DAY_OF_YEAR) / bucketDays);
    let bucketed = TERRAIN_REFERENCE_DAY_OF_YEAR + offset * bucketDays;
    bucketed = ((bucketed % 365) + 365) % 365;
    this.seasonDayOfYear = bucketed;
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

  /** The direction TOWARD the sun; only 4-7's horizon shadow reads it. */
  setSunDirection(x: number, y: number, z: number): void {
    this.surfacePlugin.setSunDirection(x, y, z);
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

  update(observer: TerrainObserver, frameIndex: number): void {
    if (this.disposed) return;
    this.stepMaterialArrayBuild();
    this.frameIndex = frameIndex;
    this.drainDeferredDisposals();
    this.streamingObserver = {
      positionX: observer.x,
      positionY: observer.y ?? 0,
      positionZ: observer.z,
      velocityX: observer.velocityX,
      velocityZ: observer.velocityZ,
    };
    this.nodes = selectTerrainNodes({
      cameraX: observer.x,
      cameraY: observer.y ?? 0,
      cameraZ: observer.z,
      pixelsPerMeterAtUnitDistance: observer.pixelsPerMeterAtUnitDistance
        ?? DEFAULT_PIXELS_PER_METER_AT_UNIT_DISTANCE,
      pixelThreshold: this.profile.cdlodPixelThreshold,
      nodeBudget: this.options.nodeBudgetOverride ?? this.profile.cdlodNodeBudget,
      finestResidentLevel: this.profile.finestResidentLevel,
      coarsestLevel: COARSEST_NODE_LEVEL,
      farPlaneMeters: 45_000,
      deviationFor: (address) => {
        const slot = this.heightAtlas.residency.get(invariantSlotKey(address));
        return slot && slot.lifecycle.state === "resident"
          ? slot.stats.maxDeviationFromParent
          : null;
      },
      heightRangeFor: (address) => {
        const slot = this.heightAtlas.residency.get(invariantSlotKey(address));
        return slot && slot.lifecycle.state === "resident"
          ? [slot.stats.minHeightMeters, slot.stats.maxHeightMeters]
          : null;
      },
    });
    this.stepCasterReadiness();
    this.updateAtlasResidency();
    this.writeNodeBuffers();
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
    this.debugOverlay.dispose();
    this.heightAtlas.dispose();
    this.channelAtlas.dispose();
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
    this.pyramid = built.pyramid;
    this.pageGenerator?.setCollisionPagePublisher?.(this.collisionPagePublisher);
    this.pageGenerator?.setAuxPagePublisher?.(this.auxPagePublisher);
    this.pageGenerator?.setMacroEvolution?.(this.macroEvolution);
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
    const pyramid = input.existingPyramid
      ?? new GlobalHeightPyramid(this.scene, engine, this.world.seedHash);
    return {
      pageGenerator: new TerrainPageGenerator(
        engine,
        input.heightAtlas,
        this.world.seedHash,
        this.world.airport ?? null,
        { world: this.world, channelAtlas: input.channelAtlas },
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
      await this.splatBake.bake(baked, this.seasonDayOfYear);
      for (const slot of baked) {
        slot.bakedSeasonDay = this.seasonDayOfYear;
        if (slot.token) this.channelAtlas.residency.complete(slot.key, slot.token, slot.stats);
      }
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
  private requestMaterialSynthesis(edge: number): void {
    const client = this.synthesisClient;
    if (!client?.isAvailable) return;
    client.request(this.world.seed, edge, SURFACE_MATERIALS.map((spec) => spec.id));
  }

  private bindAtlasesToPlugin(): void {
    this.surfacePlugin.setHeightAtlas(this.heightAtlas.texture(), {
      atlasEdge: this.heightAtlas.atlasEdge,
      slotEdge: TERRAIN_HEIGHT_SLOT_EDGE,
      gutter: WORLD_PAGE_GUTTER,
      gridEdge: terrainAtlasGridEdge(this.heightAtlas.residency.slotCount),
    });
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
    for (const node of this.nodes) {
      wanted.set(`${node.address.level}:${node.address.x}:${node.address.z}`, node.address);
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
      wanted.set(`${parent.level}:${parent.x}:${parent.z}`, parent);
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
            wanted.set(parentKey, parent);
            next.push(parent);
          }
        }
        frontier = next;
      }
    }
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
    // Resolve streaming fallbacks ONCE from the complete beauty partition.
    // Recomputing on a cascade's distance-filtered subset can omit the evicted
    // edge peer and make its packed boundary differ from beauty (and from the
    // other cascades), even though all passes execute the same vertex shader.
    const resolvedCorners = resolveTerrainResidentCornerMorphs(this.nodes, slotFor);
    const cornersByNode = new Map<TerrainNode, TerrainNodeCornerMorphs>();
    this.nodes.forEach((node, index) => cornersByNode.set(node, resolvedCorners[index]!));
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
        nodes: this.nodes.filter((node) => node.distanceMeters <= outer),
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
    const heightPending = this.pendingHeightGeneration();
    const channelPending = this.pendingChannelBake(observer);
    const splatRebakes = this.pendingSplatRebakes();
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
    } else if (heightPending.length > 0) {
      // The activated worker pass is the Phase-5 erosion client even though
      // its final bytes upload through the height atlas. Booking it as
      // terrainCompute would silently bypass the only tier pacing lever the
      // evolution contract permits (D11 / assertion 105).
      this.computeBudget.submit(heightClient, heightPending.length);
    }
    if (channelPending.length > 0) {
      // A channel slot's TWO bakes are ONE admission: occlusion writes three
      // textures, the splat writes four, both into the same slot, and the slot
      // is published only once both have run — publishing between them puts
      // material 0 at weight 0 (sand) on screen, permanently, because a slot
      // is baked once. So the pair is submitted as one demand at the combined
      // per-page cost, to the LOWER-priority of the two clients: a paired unit
      // of work must not jump the queue on the strength of its cheaper half.
      this.computeBudget.submit(
        "occlusionCompute",
        channelPending.length,
        this.computeBudget.estimatedCostMs("occlusionCompute")
          + this.computeBudget.estimatedCostMs("splatCompute"),
      );
    }
    if (splatRebakes.length > 0) {
      // A season re-bake is the splat dispatch alone; occlusion is
      // geometry-only and never goes stale.
      this.computeBudget.submit("splatCompute", splatRebakes.length);
    }
    this.dispatchPageGeneration(heightPending, erosionDagDemand !== null);
    this.dispatchChannelBake(channelPending);
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

  private dispatchPageGeneration(
    pending: readonly TerrainAtlasSlot[],
    dagProducer: boolean,
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
    if (pending.length === 0 && !dagActive) return;
    const ranked = this.rankForDispatch(pending);
    // The erosion producer takes ONE page at a time and needs the whole ranked
    // set to choose it; the analytic batch is sliced to its admitted count.
    const batch = dagProducer ? ranked : ranked.slice(0, admitted);
    this.generationInFlight = true;
    void generator.generate(batch, admitted)
      .catch(() => {
        // The DAG owns exactly one of these slots and fails it on its own
        // token; releasing the whole ranked candidate set here would evict
        // every queued page because one dispatch went wrong.
        if (!dagProducer) this.releaseBatch(this.heightAtlas, batch, "page generation failed");
      })
      .finally(() => {
        this.generationInFlight = false;
      });
  }

  private pendingChannelBake(observer: TerrainObserver): readonly TerrainAtlasSlot[] {
    const pyramid = this.pyramid;
    if (!this.occlusionBake || !pyramid || this.occlusionInFlight) return [];
    void pyramid.recenter(observer.x, observer.z).catch(() => undefined);
    if (!pyramid.isResident) return [];
    return this.channelAtlas.residency.entries.filter(
      (slot) => slot.lifecycle.state === "generating"
        && slot.token !== null
        && this.heightAtlas.residency.slotIndexOf(slot.key) >= 0,
    );
  }

  private dispatchChannelBake(pending: readonly TerrainAtlasSlot[]): void {
    const bake = this.occlusionBake;
    if (!bake || pending.length === 0) return;
    const admitted = this.computeBudget.admitted("occlusionCompute");
    if (admitted <= 0) return;
    const batch = this.rankForDispatch(pending).slice(0, admitted);
    this.occlusionInFlight = true;
    const seasonDay = this.seasonDayOfYear;
    // BOTH channel bakes, then residency — in that order, and awaited rather
    // than chained past. A channel slot carries occlusion and splat, and
    // publishing it between the two put a zeroed splat on screen: material 0
    // at weight 0, which is sand. The failure is permanent, because a slot is
    // only baked once.
    void (async () => {
      try {
        await this.pageGenerator?.ensureHydrology?.(batch);
        const ready = batch.filter((slot) => slot.hydrologyReady);
        if (ready.length === 0) return;
        const baked = await bake.bake(ready);
        if (baked.length === 0) return;
        await this.splatBake?.bake(baked, seasonDay);
        for (const slot of baked) {
          slot.bakedSeasonDay = seasonDay;
          if (slot.token) this.channelAtlas.residency.complete(slot.key, slot.token, slot.stats);
        }
      } catch {
        this.releaseBatch(this.channelAtlas, batch, "channel bake failed");
      } finally {
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
      .then(() => {
        // The slot never leaves `resident`: its texels are overwritten in
        // place, so there is no window in which it reads as unbaked.
        for (const slot of batch) slot.bakedSeasonDay = seasonDay;
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
