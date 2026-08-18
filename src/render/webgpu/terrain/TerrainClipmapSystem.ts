import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import {
  TerrainGenerationClient,
  type TerrainGenerationRequest,
} from "@/src/render/TerrainGenerationClient";
import { CloudShadowMaterialPlugin } from "@/src/render/webgpu/clouds/CloudShadowMaterialPlugin";
import type { CloudShadowProjection } from "@/src/render/webgpu/clouds/CloudShadowReceiver";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  compareWorldPageCacheEvictionOrder,
  touchWorldPageCacheMetadata,
  WORLD_PAGE_CACHE_METADATA_VERSION,
  type WorldPageCacheMetadata,
} from "@/src/render/webgpu/world/cache";
import {
  WorldPageLifecycle,
  type WorldPageOperationToken,
} from "@/src/render/webgpu/world/lifecycle";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  createWorldPageKey,
  worldPageBounds,
  worldPageExtentMeters,
  type WorldPageAddress,
  type WorldPageBounds,
  type WorldPageKey,
} from "@/src/render/webgpu/world/pageKey";
import { WORLD_PAGE_SCHEMA_VERSION } from "@/src/render/webgpu/world/payload";
import {
  rankWorldPageStreamingCandidates,
  type WorldPageStreamingObserver,
  type WorldPageStreamingPriorityOptions,
} from "@/src/render/webgpu/world/streamingPriority";
import type { TerrainTileData, WorldDefinition } from "@/src/world";
import { TerrainMaterialPlugin } from "./TerrainMaterialPlugin";

export interface TerrainClipmapBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface TerrainClipmapPageGenerator {
  request(
    request: TerrainGenerationRequest,
    onResult: (tile: TerrainTileData) => void,
    onError?: (error: Error) => void,
  ): number;
  cancel(requestId: number): void;
  dispose(): void;
  /** Workers currently generating (1B-4); absent for synchronous fakes. */
  readonly busyWorkerCount?: number;
}

export interface TerrainClipmapSystemOptions {
  /** Optional deterministic generator injection for headless tools and tests. */
  readonly generator?: TerrainClipmapPageGenerator;
}

interface TerrainPage {
  readonly key: WorldPageKey;
  readonly address: WorldPageAddress;
  readonly bounds: WorldPageBounds;
  readonly resolution: number;
  readonly mesh: Mesh;
  readonly metadata: WorldPageCacheMetadata;
  topologyKey: string;
  lastRequiredFrame: number;
}

interface PendingPage {
  readonly requestId: number;
  readonly token: WorldPageOperationToken;
}

interface DesiredPage {
  readonly key: WorldPageKey;
  readonly address: WorldPageAddress;
  readonly bounds: WorldPageBounds;
  readonly hole: TerrainClipmapBounds | null;
}

export interface TerrainObserver {
  readonly x: number;
  /** Altitude above sea level (1B-3): page priority uses 3D distance. Optional so headless callers stay valid; omitted means 0. */
  readonly y?: number;
  readonly z: number;
  readonly velocityX: number;
  readonly velocityZ: number;
}

export interface TerrainClipmapStatistics {
  readonly residentPages: number;
  readonly pendingPages: number;
  readonly triangles: number;
  /** Generation workers currently busy (1B-4); 0 for synchronous fakes. */
  readonly workersBusy: number;
}

const RING_RADIUS = 2;
/**
 * Pages that leave the desired set stay allocated this many frames for quick
 * reuse. The grace admits pages to eviction; the order among the admitted is
 * compareWorldPageCacheEvictionOrder's.
 */
const EVICTION_GRACE_FRAMES = 90;
// Page boundaries sample the same global height function, so skirts only need
// to cover transient fine/coarse gaps.  Deep 80 m two-sided walls were visible
// as a regular line grid at medium quality, especially on ridge silhouettes.
const TERRAIN_SKIRT_DEPTH_METERS = 24;

/**
 * Tuning of the shared flight-corridor streaming priority for the CPU tile
 * path (0-3). The module defaults carry no level penalty because Phase 4's
 * atlas biases parents explicitly; this path has no parent bias yet, so the
 * penalty preserves the pre-adoption fine-before-coarse ordering at equal
 * corridor cost (the deleted local formula was `distance + level * 400`).
 */
const TERRAIN_STREAMING_PRIORITY_OPTIONS: Partial<WorldPageStreamingPriorityOptions> = {
  basePageExtentMeters: WORLD_PAGE_BASE_EXTENT_METERS,
  levelPenaltyMeters: 400,
};

function assertBounds(bounds: TerrainClipmapBounds, label: string): void {
  if (
    !Number.isFinite(bounds.minX)
    || !Number.isFinite(bounds.minZ)
    || !Number.isFinite(bounds.maxX)
    || !Number.isFinite(bounds.maxZ)
    || bounds.maxX <= bounds.minX
    || bounds.maxZ <= bounds.minZ
  ) {
    throw new RangeError(`${label} must be finite and have positive area`);
  }
}

function boundsKey(bounds: readonly TerrainClipmapBounds[]): string {
  return bounds.length > 0
    ? bounds.map((entry) => (
      `${entry.minX}:${entry.minZ}:${entry.maxX}:${entry.maxZ}`
    )).sort().join("|")
    : "full";
}

/**
 * Builds a regular terrain grid while omitting every coarse cell whose open
 * area intersects finer coverage. Clipmap page extents and odd resolutions
 * align the hole boundary to grid vertices, so no partial coarse triangles
 * remain below the finer ring.
 */
export function buildTerrainClipmapPageIndices(
  resolution: number,
  page: TerrainClipmapBounds,
  finerCoverage:
    | TerrainClipmapBounds
    | readonly TerrainClipmapBounds[]
    | null = null,
): Uint16Array | Uint32Array {
  if (!Number.isSafeInteger(resolution) || resolution < 2 || resolution > 4_097) {
    throw new RangeError("Terrain clipmap resolution must be an integer in [2, 4097]");
  }
  assertBounds(page, "Terrain clipmap page bounds");
  const coverage: readonly TerrainClipmapBounds[] = finerCoverage === null
    ? []
    : Array.isArray(finerCoverage)
      ? finerCoverage
      : [finerCoverage as TerrainClipmapBounds];
  coverage.forEach((entry, index) => {
    assertBounds(entry, `Terrain clipmap finer bounds ${index}`);
  });

  const vertexCount = resolution * resolution;
  const IndexArray = vertexCount > 65_535 ? Uint32Array : Uint16Array;
  const cellCount = (resolution - 1) * (resolution - 1);
  const indices = new IndexArray(cellCount * 6);
  const spacingX = (page.maxX - page.minX) / (resolution - 1);
  const spacingZ = (page.maxZ - page.minZ) / (resolution - 1);
  let offset = 0;

  for (let row = 0; row < resolution - 1; row += 1) {
    const cellMinZ = page.minZ + row * spacingZ;
    const cellMaxZ = cellMinZ + spacingZ;
    for (let column = 0; column < resolution - 1; column += 1) {
      const cellMinX = page.minX + column * spacingX;
      const cellMaxX = cellMinX + spacingX;
      const covered = coverage.some((entry) => (
        cellMaxX > entry.minX
        && cellMinX < entry.maxX
        && cellMaxZ > entry.minZ
        && cellMinZ < entry.maxZ
      ));
      if (covered) continue;

      const topLeft = row * resolution + column;
      const bottomLeft = topLeft + resolution;
      indices[offset++] = topLeft;
      indices[offset++] = topLeft + 1;
      indices[offset++] = bottomLeft;
      indices[offset++] = topLeft + 1;
      indices[offset++] = bottomLeft + 1;
      indices[offset++] = bottomLeft;
    }
  }
  return indices.slice(0, offset);
}

function terrainBoundaryVertexIndices(resolution: number): readonly number[] {
  const boundary: number[] = [];
  for (let column = 0; column < resolution; column += 1) boundary.push(column);
  for (let row = 1; row < resolution; row += 1) {
    boundary.push(row * resolution + resolution - 1);
  }
  for (let column = resolution - 2; column >= 0; column -= 1) {
    boundary.push((resolution - 1) * resolution + column);
  }
  for (let row = resolution - 2; row > 0; row -= 1) {
    boundary.push(row * resolution);
  }
  return boundary;
}

function terrainVertexCountWithSkirt(resolution: number): number {
  return resolution * resolution + terrainBoundaryVertexIndices(resolution).length;
}

function buildTerrainIndicesWithSkirt(
  resolution: number,
  page: TerrainClipmapBounds,
  finerCoverage: readonly TerrainClipmapBounds[],
): Uint16Array | Uint32Array {
  const surface = buildTerrainClipmapPageIndices(resolution, page, finerCoverage);
  const boundary = terrainBoundaryVertexIndices(resolution);
  const vertexCount = resolution * resolution + boundary.length;
  const IndexArray = vertexCount > 65_535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(surface.length + boundary.length * 6);
  indices.set(surface, 0);
  let offset = surface.length;
  const skirtStart = resolution * resolution;
  for (let index = 0; index < boundary.length; index += 1) {
    const next = (index + 1) % boundary.length;
    const topA = boundary[index] ?? 0;
    const topB = boundary[next] ?? 0;
    const bottomA = skirtStart + index;
    const bottomB = skirtStart + next;
    indices[offset++] = topA;
    indices[offset++] = topB;
    indices[offset++] = bottomA;
    indices[offset++] = topB;
    indices[offset++] = bottomB;
    indices[offset++] = bottomA;
  }
  return indices;
}

/**
 * Worker-fed, camera-relative terrain page renderer.
 *
 * Each level doubles its world extent while retaining a regular GPU mesh. The
 * coarser levels are hollowed beneath the finer coverage, producing geometry-
 * clipmap style rings without keeping a world-sized mesh or world-sized batch.
 *
 * Page identity, streaming order, residency, and eviction ordering come from
 * `src/render/webgpu/world/` (0-3): canonical `WorldPageKey`s, the swept
 * flight-corridor priority, one `WorldPageLifecycle` per page with epoch-based
 * rejection of stale worker results, and `compareWorldPageCacheEvictionOrder`.
 * This class is the thin CPU-tile adapter over those modules; Phase 4's page
 * atlas (4-2) reuses them and deletes this path's mesh building.
 */
export class TerrainClipmapSystem {
  private readonly material: PBRMaterial;
  private readonly materialDetail: TerrainMaterialPlugin;
  private readonly cloudShadowPlugin: CloudShadowMaterialPlugin;
  private readonly generator: TerrainClipmapPageGenerator;
  private readonly pages = new Map<WorldPageKey, TerrainPage>();
  private readonly pending = new Map<WorldPageKey, PendingPage>();
  /** One lifecycle per known page; entries leave when the page fully unloads. */
  private readonly lifecycles = new Map<WorldPageKey, WorldPageLifecycle>();
  private readonly worldRevision: string;
  private desired = new Map<WorldPageKey, DesiredPage>();
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
  /** Governor B lever 1 (1A-6b): page requests admitted per pump. */
  private requestBudgetPerPump = Number.POSITIVE_INFINITY;
  private lastAnchor = "";
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldDefinition,
    profile: WebGpuQualityProfile,
    options: TerrainClipmapSystemOptions = {},
  ) {
    this.profile = profile;
    this.worldRevision = `terrain-cpu-tile/${world.seed}`;
    this.generator = options.generator ?? new TerrainGenerationClient(world, { maxQueued: 128 });
    this.material = new PBRMaterial("terrain-pbr", scene);
    this.material.metallic = 0;
    // Soil, grass, and exposed rock should retain broad diffuse highlights.
    // The previous environment/specular balance made every biome look like the
    // same polished plastic sheet, especially after rain or at low sun angles.
    this.material.roughness = 0.93;
    this.material.albedoColor = Color3.White();
    this.material.environmentIntensity = 0.64;
    this.material.directIntensity = 1.03;
    this.material.specularIntensity = 0.22;
    // 1B-11: kill specular shimmer on ridge lines under motion. (The plan's
    // anisotropicFilteringLevel = 16 is a per-texture setting; terrain has no
    // textures until 3-2 — it applies there.)
    this.material.enableSpecularAntiAliasing = true;
    this.materialDetail = new TerrainMaterialPlugin(this.material);
    // Skirts are crack guards, so accept either winding on their vertical faces.
    this.material.backFaceCulling = false;
    this.cloudShadowPlugin = new CloudShadowMaterialPlugin(this.material);
  }

  /**
   * The one shared terrain PBR material, exposed so the renderer can register
   * it with shared receiver registries (1C-4's aerial perspective; cloud
   * shadows install their plugin directly in the constructor above).
   */
  get pbrMaterial(): PBRMaterial {
    return this.material;
  }

  get statistics(): TerrainClipmapStatistics {
    let triangles = 0;
    for (const page of this.pages.values()) triangles += page.mesh.getTotalIndices() / 3;
    return {
      residentPages: this.pages.size,
      pendingPages: this.pending.size,
      triangles,
      workersBusy: this.generator.busyWorkerCount ?? 0,
    };
  }

  setProfile(profile: WebGpuQualityProfile): void {
    if (profile === this.profile) return;
    // 1B-3: the resolution ladder is a profile datum, so the topology-change
    // question is exactly "did the datum or the ring count change" — the last
    // tier read left this file, shrinking the boundary test's grandfather
    // allowlist.
    const topologyChanged = profile.terrainTileResolution !== this.profile.terrainTileResolution
      || profile.terrainRings !== this.profile.terrainRings;
    this.profile = profile;
    if (!topologyChanged) return;
    this.lastAnchor = "";
    // Cancel every in-flight request. Cancelling bumps the lifecycle epoch, so
    // a worker result that was already on its way back is rejected as stale
    // instead of creating a mesh for the retired profile.
    for (const [key, pendingPage] of this.pending) {
      this.generator.cancel(pendingPage.requestId);
      const lifecycle = this.lifecycles.get(key);
      if (lifecycle?.isCurrent(pendingPage.token)) {
        lifecycle.cancelOperation(pendingPage.token);
      }
      this.lifecycles.delete(key);
    }
    this.pending.clear();
    for (const [key, page] of this.pages) {
      if (page.address.level < profile.terrainRings) continue;
      this.disposePage(key, page);
    }
  }

  /**
   * Caps how many missing pages one pump may hand the generator. Infinity
   * restores the default (bounded only by the generator queue); Governor B
   * lowers it to 8/4/2 when frames are CPU-bound.
   */
  setRequestBudgetPerUpdate(count: number): void {
    this.requestBudgetPerPump = count >= Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(count));
  }

  setFloatingOrigin(x: number, z: number): void {
    if (x === this.originX && z === this.originZ) return;
    this.originX = x;
    this.originZ = z;
    this.materialDetail.setWorldOrigin(x, z);
    if (this.cloudShadowProjection) {
      this.cloudShadowPlugin.setProjection(this.cloudShadowProjection, x, z);
    }
    for (const page of this.pages.values()) this.positionPage(page);
  }

  setCloudShadow(projection: CloudShadowProjection): void {
    this.cloudShadowProjection = projection;
    this.cloudShadowPlugin.setProjection(projection, this.originX, this.originZ);
  }

  update(observer: TerrainObserver, frameIndex: number): void {
    if (this.disposed) return;
    this.frameIndex = frameIndex;
    this.streamingObserver = {
      positionX: observer.x,
      positionY: observer.y ?? 0,
      positionZ: observer.z,
      velocityX: observer.velocityX,
      velocityZ: observer.velocityZ,
    };
    const fineX = Math.floor(observer.x / WORLD_PAGE_BASE_EXTENT_METERS);
    const fineZ = Math.floor(observer.z / WORLD_PAGE_BASE_EXTENT_METERS);
    const speed = Math.hypot(observer.velocityX, observer.velocityZ);
    const lookAhead = Math.min(8, 1_800 / Math.max(speed, 1));
    const predictionX = observer.x + observer.velocityX * lookAhead;
    const predictionZ = observer.z + observer.velocityZ * lookAhead;
    const predictedFineX = Math.floor(predictionX / WORLD_PAGE_BASE_EXTENT_METERS);
    const predictedFineZ = Math.floor(predictionZ / WORLD_PAGE_BASE_EXTENT_METERS);
    const anchor = [
      fineX,
      fineZ,
      predictedFineX,
      predictedFineZ,
      this.profile.terrainRings,
      this.profile.terrainTileResolution,
    ].join(":");
    if (anchor !== this.lastAnchor) {
      this.lastAnchor = anchor;
      this.rebuildDesired(observer, predictionX, predictionZ);
    }

    for (const key of this.desired.keys()) {
      const page = this.pages.get(key);
      if (page) {
        page.mesh.setEnabled(true);
        page.lastRequiredFrame = frameIndex;
      }
    }
    this.evictExpiredPages(frameIndex);
    // The worker queue is deliberately bounded. Keep feeding any desired pages
    // that did not fit during the anchor rebuild as earlier requests complete;
    // otherwise the cheapest far-horizon rings could remain permanently absent.
    this.pumpDesiredRequests();
  }

  addShadowCasters(
    add: (mesh: Mesh) => void,
    maxDistanceMeters = this.profile.shadowDistance,
  ): void {
    const reach = Math.min(this.profile.shadowDistance, maxDistanceMeters);
    for (const page of this.pages.values()) {
      if (!page.mesh.isEnabled()) continue;
      // Hollow coarse-ring meshes retain page-sized bounding boxes, so relying
      // on cascade frustum culling alone submits distant rings repeatedly.
      // Filter against the configured shadow reach before registering casters.
      const distanceX = Math.max(
        page.bounds.minX - this.streamingObserver.positionX,
        0,
        this.streamingObserver.positionX - page.bounds.maxX,
      );
      const distanceZ = Math.max(
        page.bounds.minZ - this.streamingObserver.positionZ,
        0,
        this.streamingObserver.positionZ - page.bounds.maxZ,
      );
      if (Math.hypot(distanceX, distanceZ) > reach) continue;
      add(page.mesh);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generator.dispose();
    for (const page of this.pages.values()) page.mesh.dispose(false, false);
    this.pages.clear();
    this.pending.clear();
    this.lifecycles.clear();
    // Cloud transmittance is owned by VolumetricCloudSystem.
    this.material.dispose(true, false);
  }

  private rebuildDesired(
    observer: TerrainObserver,
    predictionX: number,
    predictionZ: number,
  ): void {
    const desired = new Map<WorldPageKey, DesiredPage>();
    let innerBounds: TerrainClipmapBounds | null = null;

    for (let level = 0; level < this.profile.terrainRings; level += 1) {
      const extent = worldPageExtentMeters(level, WORLD_PAGE_BASE_EXTENT_METERS);
      const centerX = Math.floor((level === 0 ? predictionX : observer.x) / extent);
      const centerZ = Math.floor((level === 0 ? predictionZ : observer.z) / extent);
      const levelMinX = (centerX - RING_RADIUS) * extent;
      const levelMinZ = (centerZ - RING_RADIUS) * extent;
      const levelMaxX = (centerX + RING_RADIUS + 1) * extent;
      const levelMaxZ = (centerZ + RING_RADIUS + 1) * extent;

      for (let dz = -RING_RADIUS; dz <= RING_RADIUS; dz += 1) {
        for (let dx = -RING_RADIUS; dx <= RING_RADIUS; dx += 1) {
          const address = createWorldPageAddress(level, centerX + dx, centerZ + dz);
          const bounds = worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS);
          const hiddenByFineLevel = innerBounds !== null
            && bounds.minX >= innerBounds.minX
            && bounds.minZ >= innerBounds.minZ
            && bounds.maxX <= innerBounds.maxX
            && bounds.maxZ <= innerBounds.maxZ;
          if (hiddenByFineLevel) continue;
          const key = createWorldPageKey(address);
          desired.set(key, { key, address, bounds, hole: innerBounds });
        }
      }
      innerBounds = { minX: levelMinX, minZ: levelMinZ, maxX: levelMaxX, maxZ: levelMaxZ };
    }
    this.desired = desired;
    // Grace-period pages remain allocated for quick reuse, but rendering them
    // over the new clipmap anchor causes coplanar LOD z-fighting and submits
    // them again to shadow/reflection passes.  Visibility follows desired state
    // immediately; allocation lifetime remains governed by the frame grace.
    for (const [key, page] of this.pages) page.mesh.setEnabled(desired.has(key));
    this.refreshPageTopologies();
    this.pumpDesiredRequests();
  }

  private pumpDesiredRequests(): void {
    const missing: Array<{ address: WorldPageAddress; desired: DesiredPage }> = [];
    for (const desired of this.desired.values()) {
      if (this.pending.has(desired.key)) continue;
      const page = this.pages.get(desired.key);
      if (page !== undefined && page.resolution === this.profile.terrainTileResolution) continue;
      missing.push({ address: desired.address, desired });
    }
    if (missing.length === 0) return;
    const ranked = rankWorldPageStreamingCandidates(
      missing,
      this.streamingObserver,
      TERRAIN_STREAMING_PRIORITY_OPTIONS,
    );
    let admitted = 0;
    for (const entry of ranked) {
      if (admitted >= this.requestBudgetPerPump) break;
      if (!this.requestPage(entry.candidate.desired, entry.priority.score)) break;
      admitted += 1;
    }
  }

  private lifecycleFor(key: WorldPageKey): WorldPageLifecycle {
    const existing = this.lifecycles.get(key);
    if (existing) return existing;
    const lifecycle = new WorldPageLifecycle(key, () => this.frameIndex);
    this.lifecycles.set(key, lifecycle);
    return lifecycle;
  }

  private requestPage(desired: DesiredPage, priorityScore: number): boolean {
    const lifecycle = this.lifecycleFor(desired.key);
    if (lifecycle.state === "resident") {
      // A resident page needs different content (the profile's resolution
      // changed). Its replacement is a fresh load of the same key: retire the
      // resident content in the state machine while the stale mesh keeps
      // rendering until the new tile arrives.
      lifecycle.finishEviction(lifecycle.beginEviction(), false);
    }
    const token = lifecycle.queue();
    const requestId = this.generator.request(
      {
        key: desired.key,
        generation: token.epoch,
        priority: priorityScore,
        options: {
          tileX: desired.address.x,
          tileZ: desired.address.z,
          size: desired.bounds.extentMeters,
          resolution: this.profile.terrainTileResolution,
          includeNormals: true,
          includeColors: true,
          // 1B-1: no clipmap path reads moisture or biomes. Colours stay —
          // vertex colour is the only surface appearance terrain has until 3-2.
          includeClimate: false,
        },
      },
      (tile) => this.onPageGenerated(desired.key, token, tile),
      (error) => this.onPageFailed(desired.key, token, error),
    );
    if (requestId < 0) {
      // The bounded queue is full; roll the lifecycle back so the next pump
      // can queue it again. Guarded, because a generator is allowed to have
      // failed the request synchronously (state "failed" retries via queue()).
      if (lifecycle.isCurrent(token) && lifecycle.state === "queued") {
        lifecycle.cancelOperation(token);
      }
      if (!this.pages.has(desired.key) && lifecycle.state === "unloaded") {
        this.lifecycles.delete(desired.key);
      }
      return false;
    }
    lifecycle.beginLoading(token);
    this.pending.set(desired.key, { requestId, token });
    return true;
  }

  private onPageGenerated(
    key: WorldPageKey,
    token: WorldPageOperationToken,
    tile: TerrainTileData,
  ): void {
    this.pending.delete(key);
    if (this.disposed) return;
    const lifecycle = this.lifecycles.get(key);
    // A stale epoch (profile change, cancellation) is rejected here without a
    // mesh ever being created. This is the check the old `generation` counter
    // hand-rolled.
    if (!lifecycle || !lifecycle.markCpuReady(token)) return;
    const desired = this.desired.get(key);
    if (!desired) {
      lifecycle.dropCpuPayload();
      if (!this.pages.has(key)) this.lifecycles.delete(key);
      return;
    }
    const uploadToken = lifecycle.beginUpload();
    this.uploadPage(desired, tile);
    lifecycle.markResident(uploadToken);
  }

  private onPageFailed(
    key: WorldPageKey,
    token: WorldPageOperationToken,
    error: Error,
  ): void {
    this.pending.delete(key);
    if (this.disposed) return;
    const lifecycle = this.lifecycles.get(key);
    if (!lifecycle || !lifecycle.isCurrent(token)) return;
    lifecycle.markFailed(token, error.message.trim() || "terrain generation failed");
    // A failure for a page nobody wants anymore (evicted from the generator
    // queue after the desired set moved on) would otherwise pin its failed
    // lifecycle forever — pumpDesiredRequests only revisits desired keys.
    if (!this.desired.has(key) && !this.pages.has(key)) {
      this.lifecycles.delete(key);
      return;
    }
    // Force the next update to rebuild and re-pump; queue() accepts a retry
    // directly from the failed state.
    this.lastAnchor = "";
  }

  private uploadPage(desired: DesiredPage, tile: TerrainTileData): void {
    const surfaceVertexCount = tile.resolution * tile.resolution;
    const boundary = terrainBoundaryVertexIndices(tile.resolution);
    const vertexCount = surfaceVertexCount + boundary.length;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 4);
    for (let row = 0; row < tile.resolution; row += 1) {
      for (let column = 0; column < tile.resolution; column += 1) {
        const vertex = row * tile.resolution + column;
        const positionOffset = vertex * 3;
        positions[positionOffset] = column * tile.spacing;
        positions[positionOffset + 1] = tile.heights[vertex] ?? 0;
        positions[positionOffset + 2] = row * tile.spacing;
        const sourceColorOffset = vertex * 3;
        const colorOffset = vertex * 4;
        colors[colorOffset] = (tile.colors[sourceColorOffset] ?? 128) / 255;
        colors[colorOffset + 1] = (tile.colors[sourceColorOffset + 1] ?? 128) / 255;
        colors[colorOffset + 2] = (tile.colors[sourceColorOffset + 2] ?? 128) / 255;
        colors[colorOffset + 3] = 1;
      }
    }
    normals.set(tile.normals, 0);
    const extentMeters = desired.bounds.extentMeters;
    for (let index = 0; index < boundary.length; index += 1) {
      const sourceVertex = boundary[index] ?? 0;
      const destinationVertex = surfaceVertexCount + index;
      const sourcePosition = sourceVertex * 3;
      const destinationPosition = destinationVertex * 3;
      positions[destinationPosition] = positions[sourcePosition] ?? 0;
      positions[destinationPosition + 1] = (positions[sourcePosition + 1] ?? 0)
        - TERRAIN_SKIRT_DEPTH_METERS;
      positions[destinationPosition + 2] = positions[sourcePosition + 2] ?? 0;
      const localX = positions[sourcePosition] ?? 0;
      const localZ = positions[sourcePosition + 2] ?? 0;
      const edgeDistance = Math.min(
        localX,
        extentMeters - localX,
        localZ,
        extentMeters - localZ,
      );
      // Give the vertical crack guard a side-facing normal.  Copying the top
      // normal made the wall receive ground lighting and read as a bright seam.
      if (edgeDistance === localX) {
        normals[destinationPosition] = -1;
        normals[destinationPosition + 1] = 0;
        normals[destinationPosition + 2] = 0;
      } else if (edgeDistance === extentMeters - localX) {
        normals[destinationPosition] = 1;
        normals[destinationPosition + 1] = 0;
        normals[destinationPosition + 2] = 0;
      } else if (edgeDistance === localZ) {
        normals[destinationPosition] = 0;
        normals[destinationPosition + 1] = 0;
        normals[destinationPosition + 2] = -1;
      } else {
        normals[destinationPosition] = 0;
        normals[destinationPosition + 1] = 0;
        normals[destinationPosition + 2] = 1;
      }
      const sourceColor = sourceVertex * 4;
      const destinationColor = destinationVertex * 4;
      colors[destinationColor] = colors[sourceColor] ?? 0.5;
      colors[destinationColor + 1] = colors[sourceColor + 1] ?? 0.5;
      colors[destinationColor + 2] = colors[sourceColor + 2] ?? 0.5;
      colors[destinationColor + 3] = 1;
    }

    const effectiveCoverage = this.effectiveCoverage(desired);
    const indices = buildTerrainIndicesWithSkirt(
      tile.resolution,
      desired.bounds,
      effectiveCoverage,
    );

    const mesh = new Mesh(`terrain-page-${desired.key}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.normals = normals;
    vertexData.colors = colors;
    vertexData.indices = indices;
    vertexData.applyToMesh(mesh, false);
    mesh.material = this.material;
    mesh.useVertexColors = true;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = desired.address.level === 0;
    const page: TerrainPage = {
      key: desired.key,
      address: desired.address,
      bounds: desired.bounds,
      resolution: tile.resolution,
      mesh,
      // Cache metadata timestamps use the frame index as the clock; eviction
      // ordering only needs monotonicity, not wall time.
      metadata: {
        metadataVersion: WORLD_PAGE_CACHE_METADATA_VERSION,
        pageSchemaVersion: WORLD_PAGE_SCHEMA_VERSION,
        key: desired.key,
        worldRevision: this.worldRevision,
        contentRevision: `cpu-tile-r${tile.resolution}`,
        cpuByteLength: tile.heights.byteLength
          + tile.normals.byteLength
          + tile.colors.byteLength
          + tile.moisture.byteLength
          + tile.biomes.byteLength,
        gpuByteLengthEstimate: positions.byteLength
          + normals.byteLength
          + colors.byteLength
          + indices.byteLength,
        createdAtMs: this.frameIndex,
        lastAccessedAtMs: this.frameIndex,
        lastVisibleAtMs: this.frameIndex,
        accessCount: 0,
        pinned: false,
      },
      topologyKey: boundsKey(effectiveCoverage),
      lastRequiredFrame: this.frameIndex,
    };
    this.positionPage(page);
    const previous = this.pages.get(desired.key);
    this.pages.set(desired.key, page);
    previous?.mesh.dispose(false, false);
    this.refreshPageTopologies();
  }

  private evictExpiredPages(frameIndex: number): void {
    let expired: TerrainPage[] | null = null;
    for (const page of this.pages.values()) {
      if (this.desired.has(page.key)) continue;
      if (frameIndex - page.lastRequiredFrame < EVICTION_GRACE_FRAMES) continue;
      (expired ??= []).push(page);
    }
    if (!expired) return;
    // All grace-expired pages release this frame; the shared comparator fixes
    // the order so the release sequence matches what a byte-budgeted cache
    // (4-2) would choose first. Recency is refreshed from lastRequiredFrame —
    // the hot path tracks frames on the page record instead of re-allocating
    // metadata every frame.
    const candidates = expired.map((page) => ({
      page,
      metadata: touchWorldPageCacheMetadata(page.metadata, page.lastRequiredFrame, true),
    }));
    candidates.sort((first, second) => compareWorldPageCacheEvictionOrder(
      first.metadata,
      second.metadata,
    ));
    for (const candidate of candidates) this.disposePage(candidate.page.key, candidate.page);
    this.refreshPageTopologies();
  }

  private disposePage(key: WorldPageKey, page: TerrainPage): void {
    const lifecycle = this.lifecycles.get(key);
    if (lifecycle?.state === "resident") {
      lifecycle.finishEviction(lifecycle.beginEviction(), false);
    }
    // A pending replacement keeps its lifecycle: it describes the in-flight
    // load, not the mesh being released here.
    if (!this.pending.has(key)) this.lifecycles.delete(key);
    page.mesh.dispose(false, false);
    this.pages.delete(key);
  }

  /** Remove only cells already covered by resident finer geometry. */
  private effectiveCoverage(desired: DesiredPage): readonly TerrainClipmapBounds[] {
    if (!desired.hole) return [];
    const coverage: TerrainClipmapBounds[] = [];
    for (const page of this.pages.values()) {
      if (page.address.level >= desired.address.level) continue;
      if (!page.mesh.isEnabled() || !this.desired.has(page.key)) continue;
      if (
        page.bounds.maxX <= desired.bounds.minX
        || page.bounds.minX >= desired.bounds.maxX
        || page.bounds.maxZ <= desired.bounds.minZ
        || page.bounds.minZ >= desired.bounds.maxZ
      ) continue;
      coverage.push(page.bounds);
    }
    return coverage;
  }

  private refreshPageTopologies(): void {
    for (const [key, page] of this.pages) {
      const desired = this.desired.get(key);
      if (!desired) continue;
      const coverage = this.effectiveCoverage(desired);
      const topologyKey = boundsKey(coverage);
      if (topologyKey === page.topologyKey) continue;
      page.mesh.setIndices(
        buildTerrainIndicesWithSkirt(page.resolution, page.bounds, coverage),
        terrainVertexCountWithSkirt(page.resolution),
        false,
      );
      page.topologyKey = topologyKey;
    }
  }

  private positionPage(page: TerrainPage): void {
    page.mesh.position.set(
      page.bounds.minX - this.originX,
      0,
      page.bounds.minZ - this.originZ,
    );
  }
}
