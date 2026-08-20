// Side-effect import: Babylon 9 tree-shakes the thin-instance API, and
// `Mesh.prototype.thinInstanceSetBuffer` / `thinInstanceCount` do not exist
// without it. Missing, they are `undefined` rather than an error — the mesh
// simply draws nothing, silently.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { CloudShadowMaterialPlugin } from "@/src/render/webgpu/clouds/CloudShadowMaterialPlugin";
import type { CloudShadowProjection } from "@/src/render/webgpu/clouds/CloudShadowReceiver";
import { ComputeBudget } from "@/src/render/webgpu/core/ComputeBudget";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  worldPageBounds,
  type WorldPageAddress,
} from "@/src/render/webgpu/world/pageKey";
import {
  rankWorldPageStreamingCandidates,
  type WorldPageStreamingObserver,
  type WorldPageStreamingPriorityOptions,
} from "@/src/render/webgpu/world/streamingPriority";
import { TERRAIN_REFERENCE_DAY_OF_YEAR, type WorldDefinition } from "@/src/world";
import { GlobalHeightPyramid } from "./GlobalHeightPyramid";
import {
  synthesizeSurfaceMaterial,
  uploadSurfaceMaterialArrays,
  type SurfaceMaterialArrays,
} from "./MaterialArraySynthesis";
import { PageOcclusionBake } from "./PageOcclusionBake";
import { SURFACE_MATERIALS } from "./surfaceMaterials";
import { TerrainDebugOverlay, type TerrainDebugOverlayMode } from "./TerrainDebugOverlay";
import {
  TERRAIN_CHANNEL_TEXTURES,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
  type TerrainAtlasSlot,
} from "./TerrainPageAtlas";
import {
  buildTerrainNodeGrid,
  packTerrainNodeSplat,
  selectTerrainNodes,
  writeTerrainNodeBuffers,
  type TerrainNode,
} from "./TerrainQuadtree";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_NODE_ATTRIBUTE_A,
  TERRAIN_NODE_ATTRIBUTE_B,
  TERRAIN_NODE_ATTRIBUTE_STRIDE,
  terrainAtlasGridEdge,
} from "./TerrainSpineContract";
import { TerrainSurfacePlugin } from "./TerrainSurfacePlugin";

export interface TerrainClipmapSystemOptions {
  /** Injection point for headless tools and tests; omitted uses the real one. */
  readonly nodeBudgetOverride?: number;
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
  material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene);
  return plugin;
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
  private pageGenerator: TerrainPageGenerator | null = null;
  private pyramid: GlobalHeightPyramid | null = null;
  private occlusionBake: PageOcclusionBake | null = null;
  private readonly computeBudget: ComputeBudget;
  private debugOverlay: TerrainDebugOverlay;
  private generationInFlight = false;
  private occlusionInFlight = false;

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
    this.worldRevision = `terrain-gpu-page/${world.seed}`;
    this.material = createTerrainMaterial(scene);
    this.surfacePlugin = attachTerrainSurfacePlugin(this.material, scene);
    this.surfacePlugin.setSamplingProfile(
      profile.terrainTriplanarMode,
      profile.heightBlendMaxMaterials,
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
    });
    this.computeBudget = new ComputeBudget(profile);
    this.debugOverlay = new TerrainDebugOverlay(scene, profile.heightAtlasSlots);
    if (this.heightAtlas.hasTextures) {
      this.pageGenerator = new TerrainPageGenerator(
        scene.getEngine(),
        this.heightAtlas,
        world.seedHash,
      );
      this.pyramid = new GlobalHeightPyramid(scene, scene.getEngine(), world.seedHash);
      this.occlusionBake = new PageOcclusionBake(
        scene.getEngine(),
        this.heightAtlas,
        this.channelAtlas,
        this.pyramid,
      );
    }

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
   * The terrain renders untextured for those ten frames, which the plugin
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
    }
    const build = this.materialArrayBuild;
    if (build.edge !== this.materialArrayEdge) {
      // A profile change superseded it; the next frame restarts at the new edge.
      this.materialArrayBuild = null;
      return;
    }
    const spec = SURFACE_MATERIALS[build.index];
    if (spec) {
      const layer = synthesizeSurfaceMaterial(spec.id, this.world.seed, build.edge);
      build.albedoHeight.push(layer.albedoHeight);
      build.normalMaterial.push(layer.normalMaterial);
      build.index += 1;
      return;
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
    // afterwards was textured. There is one beauty mesh now, and one caster
    // mesh per cascade, and all of them have to drop their caches.
    this.beautyMesh.resetDrawCache();
    for (const mesh of this.casterMeshes) mesh.resetDrawCache();
    previous?.albedoHeight.dispose();
    previous?.normalMaterial.dispose();
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
    this.materialArrayEdge = profile.materialArrayEdge;
    this.computeBudget.setProfile(profile);
    if (atlasReshaped) {
      // A slot index addresses a different texel in a reshaped atlas, so
      // residency cannot survive the change — dropping it is correct, not
      // lazy.
      this.heightAtlas.dispose();
      this.channelAtlas.dispose();
      this.heightAtlas = new TerrainPageAtlas(this.scene, profile, {
        kind: "height",
        worldRevision: this.worldRevision,
      });
      this.channelAtlas = new TerrainPageAtlas(this.scene, profile, {
        kind: "channel",
        worldRevision: this.worldRevision,
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      });
      this.debugOverlay.dispose();
      this.debugOverlay = new TerrainDebugOverlay(this.scene, profile.heightAtlasSlots);
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

  /** The direction TOWARD the sun; only 4-7's horizon shadow reads it. */
  setSunDirection(x: number, y: number, z: number): void {
    this.surfacePlugin.setSunDirection(x, y, z);
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

  update(observer: TerrainObserver, frameIndex: number): void {
    if (this.disposed) return;
    this.stepMaterialArrayBuild();
    this.frameIndex = frameIndex;
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
    });
    this.updateAtlasResidency();
    this.writeNodeBuffers();
    this.pumpPageGeneration();
    this.pumpOcclusionBake(observer);
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
    this.materialArrayBuild = null;
    this.pageGenerator?.dispose();
    this.occlusionBake?.dispose();
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
    }
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
    const wanted = new Map<string, WorldPageAddress>();
    for (const node of this.nodes) {
      wanted.set(`${node.address.level}:${node.address.x}:${node.address.z}`, node.address);
      if (node.level >= 30) continue;
      const parent = createWorldPageAddress(
        node.level + 1,
        Math.floor(node.address.x / 2),
        Math.floor(node.address.z / 2),
      );
      wanted.set(`${parent.level}:${parent.x}:${parent.z}`, parent);
    }
    const missing: { address: WorldPageAddress }[] = [];
    for (const address of wanted.values()) {
      const key = invariantSlotKey(address);
      if (this.heightAtlas.residency.slotIndexOf(key) >= 0) {
        this.heightAtlas.residency.touch(key);
        this.channelAtlas.residency.touch(key);
        continue;
      }
      missing.push({ address });
    }
    if (missing.length === 0) return;
    // The shared swept flight-corridor priority (0-3), verbatim: soonest
    // needed first, so a banked turn admits what it is turning into.
    const ranked = rankWorldPageStreamingCandidates(
      missing,
      this.streamingObserver,
      TERRAIN_STREAMING_PRIORITY_OPTIONS,
    );
    let admitted = 0;
    for (const entry of ranked) {
      if (admitted >= this.requestBudgetPerPump) break;
      const key = invariantSlotKey(entry.candidate.address);
      if (this.heightAtlas.residency.request(key, entry.candidate.address) === null) break;
      this.channelAtlas.residency.request(key, entry.candidate.address);
      admitted += 1;
    }
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
    const buffers = writeTerrainNodeBuffers({
      nodes: this.nodes,
      originX: this.originX,
      originZ: this.originZ,
      slotFor,
      splatFor: (node) => this.provisionalSplatFor(node),
    });
    applyTerrainNodeBuffers(this.beautyMesh, buffers.matrices, buffers.laneA, buffers.laneB);

    for (let cascade = 0; cascade < this.casterMeshes.length; cascade += 1) {
      const reach = Math.min(this.profile.shadowDistance, this.shadowCasterDistanceMeters)
        * ((cascade + 1) / this.casterMeshes.length);
      const inCascade = this.nodes.filter((node) => node.distanceMeters <= reach);
      const cascadeBuffers = writeTerrainNodeBuffers({
        nodes: inCascade,
        originX: this.originX,
        originZ: this.originZ,
        slotFor,
        splatFor: (node) => this.provisionalSplatFor(node),
      });
      applyTerrainNodeBuffers(
        this.casterMeshes[cascade]!,
        cascadeBuffers.matrices,
        cascadeBuffers.laneA,
        cascadeBuffers.laneB,
      );
    }
  }

  /**
   * The provisional two-material blend a node carries until `4-6` lands.
   *
   * Derived from the page's own MEASURED height band rather than from a biome
   * byte: the CPU tile path's classifier is gone with the worker, and this is
   * a carry-forward, not a second classifier. `4-6`'s page splat replaces it
   * and these lanes go away.
   */
  private provisionalSplatFor(node: TerrainNode): number {
    const slot = this.heightAtlas.residency.get(invariantSlotKey(node.address));
    const mid = slot
      ? (slot.stats.minHeightMeters + slot.stats.maxHeightMeters) * 0.5
      : this.world.seaLevel;
    const above = mid - this.world.seaLevel;
    const relief = slot ? slot.stats.maxHeightMeters - slot.stats.minHeightMeters : 0;
    // The SurfaceMaterial axis is ordered so bracketed neighbours plausibly
    // grade into one another; walking it by altitude is the cheapest honest
    // provisional answer.
    const axis = above <= 2
      ? 0
      : Math.min(SURFACE_MATERIALS.length - 1, 1 + above / 380);
    const primary = Math.floor(axis);
    const secondary = Math.min(SURFACE_MATERIALS.length - 1, primary + 1);
    const weight = Math.min(1, Math.max(0, axis - primary) + relief / 4_000);
    return packTerrainNodeSplat(primary, secondary, weight);
  }

  private pumpPageGeneration(): void {
    const generator = this.pageGenerator;
    if (!generator || this.generationInFlight) return;
    const pending = this.heightAtlas.residency.entries.filter(
      (slot) => slot.lifecycle.state === "generating" && slot.token !== null,
    );
    if (pending.length === 0) return;
    this.computeBudget.beginFrame();
    this.computeBudget.submit("terrainCompute", pending.length);
    const admitted = this.computeBudget.admitted("terrainCompute");
    if (admitted <= 0) return;
    const batch = pending.slice(0, admitted);
    this.generationInFlight = true;
    void generator.generate(batch)
      .catch(() => this.releaseBatch(this.heightAtlas, batch, "page generation failed"))
      .finally(() => {
        this.generationInFlight = false;
      });
  }

  private pumpOcclusionBake(observer: TerrainObserver): void {
    const bake = this.occlusionBake;
    const pyramid = this.pyramid;
    if (!bake || !pyramid || this.occlusionInFlight) return;
    void pyramid.recenter(observer.x, observer.z).catch(() => undefined);
    if (!pyramid.isResident) return;
    const pending = this.channelAtlas.residency.entries.filter(
      (slot) => slot.lifecycle.state === "generating"
        && slot.token !== null
        && this.heightAtlas.residency.slotIndexOf(slot.key) >= 0,
    );
    if (pending.length === 0) return;
    this.computeBudget.beginFrame();
    this.computeBudget.submit("occlusionCompute", pending.length);
    const admitted = this.computeBudget.admitted("occlusionCompute");
    if (admitted <= 0) return;
    const batch = pending.slice(0, admitted);
    this.occlusionInFlight = true;
    void bake.bake(batch)
      .catch(() => this.releaseBatch(this.channelAtlas, batch, "occlusion bake failed"))
      .finally(() => {
        this.occlusionInFlight = false;
      });
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
 * Write one node set onto a mesh.
 *
 * The matrix buffer FIRST: it is the only kind that sets `instancesCount`,
 * so setting the custom lanes before it would leave them describing zero
 * instances.
 */
function applyTerrainNodeBuffers(
  mesh: Mesh,
  matrices: Float32Array,
  laneA: Float32Array,
  laneB: Float32Array,
): void {
  if (matrices.length === 0) {
    mesh.thinInstanceCount = 0;
    return;
  }
  mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
  mesh.thinInstanceSetBuffer(TERRAIN_NODE_ATTRIBUTE_A, laneA, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
  mesh.thinInstanceSetBuffer(TERRAIN_NODE_ATTRIBUTE_B, laneB, TERRAIN_NODE_ATTRIBUTE_STRIDE, false);
}
