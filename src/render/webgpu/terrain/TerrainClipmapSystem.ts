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
}

export interface TerrainClipmapSystemOptions {
  /** Optional deterministic generator injection for headless tools and tests. */
  readonly generator?: TerrainClipmapPageGenerator;
}

interface TerrainPage {
  readonly key: string;
  readonly level: number;
  readonly tileX: number;
  readonly tileZ: number;
  readonly extent: number;
  readonly resolution: number;
  readonly generation: number;
  readonly mesh: Mesh;
  topologyKey: string;
  lastRequiredFrame: number;
}

interface PendingPage {
  readonly requestId: number;
  readonly generation: number;
}

interface DesiredPage {
  readonly key: string;
  readonly level: number;
  readonly tileX: number;
  readonly tileZ: number;
  readonly extent: number;
  readonly priority: number;
  readonly hole: TerrainClipmapBounds | null;
}

export interface TerrainObserver {
  readonly x: number;
  readonly z: number;
  readonly velocityX: number;
  readonly velocityZ: number;
}

export interface TerrainClipmapStatistics {
  readonly residentPages: number;
  readonly pendingPages: number;
  readonly triangles: number;
}

const BASE_PAGE_EXTENT = 512;
const RING_RADIUS = 2;
const EVICTION_GRACE_FRAMES = 90;
const TERRAIN_SKIRT_DEPTH_METERS = 80;

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

function pageBounds(tileX: number, tileZ: number, extent: number): TerrainClipmapBounds {
  return {
    minX: tileX * extent,
    minZ: tileZ * extent,
    maxX: (tileX + 1) * extent,
    maxZ: (tileZ + 1) * extent,
  };
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

function pageKey(level: number, tileX: number, tileZ: number): string {
  return `${level}:${tileX}:${tileZ}`;
}

function tileResolution(profile: WebGpuQualityProfile, level: number): number {
  if (profile.tier === 0) return level === 0 ? 33 : 17;
  if (profile.tier === 1) return level < 2 ? 65 : 33;
  return level < 3 ? 65 : 33;
}

/**
 * Worker-fed, camera-relative terrain page renderer.
 *
 * Each level doubles its world extent while retaining a regular GPU mesh. The
 * coarser levels are hollowed beneath the finer coverage, producing geometry-
 * clipmap style rings without keeping a world-sized mesh or world-sized batch.
 */
export class TerrainClipmapSystem {
  private readonly material: PBRMaterial;
  private readonly materialDetail: TerrainMaterialPlugin;
  private readonly cloudShadowPlugin: CloudShadowMaterialPlugin;
  private readonly generator: TerrainClipmapPageGenerator;
  private readonly pages = new Map<string, TerrainPage>();
  private readonly pending = new Map<string, PendingPage>();
  private desired = new Map<string, DesiredPage>();
  private profile: WebGpuQualityProfile;
  private generation = 1;
  private frameIndex = 0;
  private originX = 0;
  private originZ = 0;
  private cloudShadowProjection: CloudShadowProjection | null = null;
  private lastAnchor = "";
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldDefinition,
    profile: WebGpuQualityProfile,
    options: TerrainClipmapSystemOptions = {},
  ) {
    this.profile = profile;
    this.generator = options.generator ?? new TerrainGenerationClient(world, { maxQueued: 128 });
    this.material = new PBRMaterial("terrain-pbr", scene);
    this.material.metallic = 0;
    this.material.roughness = 0.88;
    this.material.albedoColor = Color3.White();
    this.material.environmentIntensity = 0.72;
    this.material.directIntensity = 1.05;
    this.material.specularIntensity = 0.34;
    this.materialDetail = new TerrainMaterialPlugin(this.material);
    // Skirts are crack guards, so accept either winding on their vertical faces.
    this.material.backFaceCulling = false;
    this.cloudShadowPlugin = new CloudShadowMaterialPlugin(this.material);
  }

  get statistics(): TerrainClipmapStatistics {
    let triangles = 0;
    for (const page of this.pages.values()) triangles += page.mesh.getTotalIndices() / 3;
    return {
      residentPages: this.pages.size,
      pendingPages: this.pending.size,
      triangles,
    };
  }

  setProfile(profile: WebGpuQualityProfile): void {
    if (profile === this.profile) return;
    const topologyChanged = profile.tier !== this.profile.tier
      || profile.terrainRings !== this.profile.terrainRings;
    this.profile = profile;
    if (!topologyChanged) return;
    this.generation += 1;
    this.lastAnchor = "";
    for (const pending of this.pending.values()) this.generator.cancel(pending.requestId);
    this.pending.clear();
    for (const [key, page] of this.pages) {
      if (page.level < profile.terrainRings) continue;
      page.mesh.dispose(false, false);
      this.pages.delete(key);
    }
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
    const fineX = Math.floor(observer.x / BASE_PAGE_EXTENT);
    const fineZ = Math.floor(observer.z / BASE_PAGE_EXTENT);
    const speed = Math.hypot(observer.velocityX, observer.velocityZ);
    const lookAhead = Math.min(8, 1_800 / Math.max(speed, 1));
    const predictionX = observer.x + observer.velocityX * lookAhead;
    const predictionZ = observer.z + observer.velocityZ * lookAhead;
    const predictedFineX = Math.floor(predictionX / BASE_PAGE_EXTENT);
    const predictedFineZ = Math.floor(predictionZ / BASE_PAGE_EXTENT);
    const anchor = [
      fineX,
      fineZ,
      predictedFineX,
      predictedFineZ,
      this.profile.terrainRings,
      this.profile.tier,
    ].join(":");
    if (anchor !== this.lastAnchor) {
      this.lastAnchor = anchor;
      this.rebuildDesired(observer, predictionX, predictionZ);
    }

    for (const key of this.desired.keys()) {
      const page = this.pages.get(key);
      if (page) page.lastRequiredFrame = frameIndex;
    }
    let evicted = false;
    for (const [key, page] of this.pages) {
      if (this.desired.has(key)) continue;
      if (frameIndex - page.lastRequiredFrame < EVICTION_GRACE_FRAMES) continue;
      page.mesh.dispose(false, false);
      this.pages.delete(key);
      evicted = true;
    }
    if (evicted) this.refreshPageTopologies();
    // The worker queue is deliberately bounded. Keep feeding any desired pages
    // that did not fit during the anchor rebuild as earlier requests complete;
    // otherwise the cheapest far-horizon rings could remain permanently absent.
    this.pumpDesiredRequests();
  }

  addShadowCasters(add: (mesh: Mesh) => void): void {
    for (const page of this.pages.values()) add(page.mesh);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generator.dispose();
    for (const page of this.pages.values()) page.mesh.dispose(false, false);
    this.pages.clear();
    this.pending.clear();
    // Cloud transmittance is owned by VolumetricCloudSystem.
    this.material.dispose(true, false);
  }

  private rebuildDesired(
    observer: TerrainObserver,
    predictionX: number,
    predictionZ: number,
  ): void {
    const desired = new Map<string, DesiredPage>();
    let innerBounds: TerrainClipmapBounds | null = null;

    for (let level = 0; level < this.profile.terrainRings; level += 1) {
      const extent = BASE_PAGE_EXTENT * 2 ** level;
      const centerX = Math.floor((level === 0 ? predictionX : observer.x) / extent);
      const centerZ = Math.floor((level === 0 ? predictionZ : observer.z) / extent);
      const levelMinX = (centerX - RING_RADIUS) * extent;
      const levelMinZ = (centerZ - RING_RADIUS) * extent;
      const levelMaxX = (centerX + RING_RADIUS + 1) * extent;
      const levelMaxZ = (centerZ + RING_RADIUS + 1) * extent;

      for (let dz = -RING_RADIUS; dz <= RING_RADIUS; dz += 1) {
        for (let dx = -RING_RADIUS; dx <= RING_RADIUS; dx += 1) {
          const tileX = centerX + dx;
          const tileZ = centerZ + dz;
          const bounds = pageBounds(tileX, tileZ, extent);
          const hiddenByFineLevel = innerBounds !== null
            && bounds.minX >= innerBounds.minX
            && bounds.minZ >= innerBounds.minZ
            && bounds.maxX <= innerBounds.maxX
            && bounds.maxZ <= innerBounds.maxZ;
          if (hiddenByFineLevel) continue;
          const key = pageKey(level, tileX, tileZ);
          const distance = Math.hypot(
            bounds.minX + extent * 0.5 - predictionX,
            bounds.minZ + extent * 0.5 - predictionZ,
          );
          desired.set(key, {
            key,
            level,
            tileX,
            tileZ,
            extent,
            priority: distance + level * 400,
            hole: innerBounds,
          });
        }
      }
      innerBounds = { minX: levelMinX, minZ: levelMinZ, maxX: levelMaxX, maxZ: levelMaxZ };
    }
    this.desired = desired;
    this.refreshPageTopologies();
    this.pumpDesiredRequests();
  }

  private pumpDesiredRequests(): void {
    const missing = [...this.desired.values()].filter((candidate) => {
      const page = this.pages.get(candidate.key);
      const requiredResolution = tileResolution(this.profile, candidate.level);
      return (page === undefined
        || page.generation !== this.generation
        || page.resolution !== requiredResolution)
        && !this.pending.has(candidate.key);
    }).sort((left, right) => left.priority - right.priority);
    for (const candidate of missing) {
      if (!this.requestPage(candidate)) break;
    }
  }

  private requestPage(candidate: DesiredPage): boolean {
    const generation = this.generation;
    const requestId = this.generator.request(
      {
        key: candidate.key,
        generation,
        priority: candidate.priority,
        options: {
          tileX: candidate.tileX,
          tileZ: candidate.tileZ,
          size: candidate.extent,
          resolution: tileResolution(this.profile, candidate.level),
          includeNormals: true,
          includeColors: true,
          includeClimate: true,
        },
      },
      (tile) => {
        const pending = this.pending.get(candidate.key);
        this.pending.delete(candidate.key);
        const desired = this.desired.get(candidate.key);
        if (
          this.disposed
          || pending?.generation !== generation
          || generation !== this.generation
          || desired === undefined
        ) return;
        this.uploadPage(desired, generation, tile);
      },
      () => {
        this.pending.delete(candidate.key);
        this.lastAnchor = "";
      },
    );
    if (requestId < 0) return false;
    this.pending.set(candidate.key, { requestId, generation });
    return true;
  }

  private uploadPage(
    desired: DesiredPage,
    generation: number,
    tile: TerrainTileData,
  ): void {
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
    for (let index = 0; index < boundary.length; index += 1) {
      const sourceVertex = boundary[index] ?? 0;
      const destinationVertex = surfaceVertexCount + index;
      const sourcePosition = sourceVertex * 3;
      const destinationPosition = destinationVertex * 3;
      positions[destinationPosition] = positions[sourcePosition] ?? 0;
      positions[destinationPosition + 1] = (positions[sourcePosition + 1] ?? 0)
        - TERRAIN_SKIRT_DEPTH_METERS;
      positions[destinationPosition + 2] = positions[sourcePosition + 2] ?? 0;
      normals[destinationPosition] = normals[sourcePosition] ?? 0;
      normals[destinationPosition + 1] = normals[sourcePosition + 1] ?? 1;
      normals[destinationPosition + 2] = normals[sourcePosition + 2] ?? 0;
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
      pageBounds(desired.tileX, desired.tileZ, desired.extent),
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
    mesh.alwaysSelectAsActiveMesh = desired.level === 0;
    const page: TerrainPage = {
      key: desired.key,
      level: desired.level,
      tileX: desired.tileX,
      tileZ: desired.tileZ,
      extent: desired.extent,
      resolution: tile.resolution,
      generation,
      mesh,
      topologyKey: boundsKey(effectiveCoverage),
      lastRequiredFrame: this.frameIndex,
    };
    this.positionPage(page);
    const previous = this.pages.get(desired.key);
    this.pages.set(desired.key, page);
    previous?.mesh.dispose(false, false);
    this.refreshPageTopologies();
  }

  /** Remove only cells already covered by resident finer geometry. */
  private effectiveCoverage(desired: DesiredPage): readonly TerrainClipmapBounds[] {
    if (!desired.hole) return [];
    const target = pageBounds(desired.tileX, desired.tileZ, desired.extent);
    const coverage: TerrainClipmapBounds[] = [];
    for (const page of this.pages.values()) {
      if (page.level >= desired.level) continue;
      const bounds = pageBounds(page.tileX, page.tileZ, page.extent);
      if (
        bounds.maxX <= target.minX
        || bounds.minX >= target.maxX
        || bounds.maxZ <= target.minZ
        || bounds.minZ >= target.maxZ
      ) continue;
      coverage.push(bounds);
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
        buildTerrainIndicesWithSkirt(
          page.resolution,
          pageBounds(page.tileX, page.tileZ, page.extent),
          coverage,
        ),
        terrainVertexCountWithSkirt(page.resolution),
        false,
      );
      page.topologyKey = topologyKey;
    }
  }

  private positionPage(page: TerrainPage): void {
    page.mesh.position.set(
      page.tileX * page.extent - this.originX,
      0,
      page.tileZ * page.extent - this.originZ,
    );
  }
}
