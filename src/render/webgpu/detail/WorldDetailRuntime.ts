import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure";
import { CreateIcoSphere } from "@babylonjs/core/Meshes/Builders/icoSphereBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { DetailWindMaterialPlugin } from "./DetailWindMaterialPlugin";
import { detailCellKey, generateDetailCell } from "./generation";
import {
  canGenerateNextDetailCell,
  resolveDetailGenerationBudget,
} from "./generationBudget";
import {
  detailPresentationChunkCoordinates,
  type DetailPresentationChunkCoordinates,
} from "./spatialChunks";
import {
  DEFAULT_DETAIL_CELL_SIZE_METERS,
  type BuildingStyle,
  type DetailFloatingOrigin,
  type DetailLod,
  type DetailTerrainSampler,
  type GeneratedDetailCell,
  type RockVariant,
  type ShrubSpecies,
  type TreeSpecies,
  type WorldDetailObserver,
  type WorldDetailStatistics,
} from "./types";

interface DetailBatch {
  readonly mesh: Mesh;
  readonly castsShadows: boolean;
  readonly prototypeKey: string;
  readonly chunkKey: string;
  readonly matrices: number[];
  readonly colors: number[];
  readonly wind: number[];
}

interface RetiredDetailBatch {
  readonly batch: DetailBatch;
  readonly disposeAfterUpdate: number;
}

interface DetailPrototype {
  readonly mesh: Mesh;
  readonly material: PBRMaterial;
  readonly castsShadows: boolean;
}

interface DetailChunkStatistics {
  readonly nearCells: number;
  readonly midCells: number;
  readonly treeInstances: number;
  readonly shrubInstances: number;
  readonly rockInstances: number;
  readonly buildingInstances: number;
}

interface DetailPresentationChunk {
  readonly coordinates: DetailPresentationChunkCoordinates;
  readonly batchKeys: Set<string>;
  signature: string;
  revision: number;
  statistics: DetailChunkStatistics;
}

interface MutableDetailChunkStatistics {
  nearCells: number;
  midCells: number;
  treeInstances: number;
  shrubInstances: number;
  rockInstances: number;
  buildingInstances: number;
}

interface ThinInstanceMeshWithCache {
  readonly _thinInstanceDataStorage: {
    worldMatrices: unknown;
  };
}

interface DesiredCell {
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly distance: number;
  readonly lod: DetailLod;
  readonly priority: number;
}

interface ResidentCell {
  readonly cell: GeneratedDetailCell;
  lod: DetailLod;
  distance: number;
}

export interface WorldDetailRuntimeOptions {
  readonly worldSeed: string | number;
  readonly terrainSample: DetailTerrainSampler;
  readonly cellSizeMeters?: number;
}

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
const BUILDING_STYLES: readonly BuildingStyle[] = ["cottage", "barn", "tower"];

const ZERO_STATISTICS: WorldDetailStatistics = Object.freeze({
  residentCells: 0,
  nearCells: 0,
  midCells: 0,
  generatedCells: 0,
  treeInstances: 0,
  shrubInstances: 0,
  rockInstances: 0,
  buildingInstances: 0,
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

function distanceToCell(
  x: number,
  z: number,
  cellX: number,
  cellZ: number,
  cellSize: number,
): number {
  const minX = cellX * cellSize;
  const minZ = cellZ * cellSize;
  const maxX = minX + cellSize;
  const maxZ = minZ + cellSize;
  return Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
}

function profileCellBudget(profile: WebGpuQualityProfile): number {
  if (profile.vegetationDistance <= 2_500 || profile.vegetationDensity <= 0.5) return 128;
  if (profile.vegetationDistance <= 5_000 || profile.vegetationDensity <= 0.8) return 384;
  return 896;
}

function bakePrototype(mesh: Mesh, y: number, scaleX = 1, scaleY = 1, scaleZ = 1): Mesh {
  mesh.position.set(0, y, 0);
  mesh.scaling.set(scaleX, scaleY, scaleZ);
  mesh.bakeCurrentTransformIntoVertices();
  mesh.position.set(0, 0, 0);
  mesh.scaling.set(1, 1, 1);
  return mesh;
}

function appendYawMatrix(
  target: number[],
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  yaw: number,
): void {
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  target.push(
    cosine * scaleX, 0, -sine * scaleX, 0,
    0, scaleY, 0, 0,
    sine * scaleZ, 0, cosine * scaleZ, 0,
    x, y, z, 1,
  );
}

function createGabledRoof(name: string, scene: Scene): Mesh {
  const positions = [
    -0.5, 0, -0.5,
    0.5, 0, -0.5,
    0, 0.5, -0.5,
    -0.5, 0, 0.5,
    0.5, 0, 0.5,
    0, 0.5, 0.5,
  ];
  const indices = [
    0, 1, 2,
    5, 4, 3,
    0, 2, 5, 0, 5, 3,
    1, 4, 5, 1, 5, 2,
    0, 3, 4, 0, 4, 1,
  ];
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh, false);
  return mesh;
}

/**
 * Paged natural/settlement detail built entirely from Babylon meshes and thin
 * instances. Generation is incremental; normal per-frame updates become no-ops
 * until the observer crosses a paging/LOD boundary or the floating origin moves.
 */
export class WorldDetailRuntime {
  private readonly batches = new Map<string, DetailBatch>();
  private readonly retiredBatches: RetiredDetailBatch[] = [];
  private readonly prototypes = new Map<string, DetailPrototype>();
  private readonly presentationChunks = new Map<string, DetailPresentationChunk>();
  private readonly materials = new Set<PBRMaterial>();
  private readonly windPlugins = new Set<DetailWindMaterialPlugin>();
  private readonly cells = new Map<string, ResidentCell>();
  private desiredCells: readonly DesiredCell[] = [];
  private desiredKeys = new Set<string>();
  private signature = "";
  private density = Number.NaN;
  private cumulativeGeneratedCells = 0;
  private statisticsValue = ZERO_STATISTICS;
  private batchesDirty = true;
  private windTimeSeconds = 0;
  private updateSequence = 0;
  private disposed = false;

  readonly cellSizeMeters: number;

  constructor(
    private readonly scene: Scene,
    private readonly options: WorldDetailRuntimeOptions,
  ) {
    this.cellSizeMeters = options.cellSizeMeters ?? DEFAULT_DETAIL_CELL_SIZE_METERS;
    if (
      !Number.isFinite(this.cellSizeMeters) ||
      this.cellSizeMeters < 64 ||
      this.cellSizeMeters > 4_096
    ) {
      throw new RangeError("Detail runtime cell size must be between 64 and 4096 metres");
    }
    this.createBatches();
  }

  get statistics(): WorldDetailStatistics {
    return this.statisticsValue;
  }

  update(
    observer: WorldDetailObserver,
    floatingOrigin: DetailFloatingOrigin,
    profile: WebGpuQualityProfile,
  ): void {
    if (this.disposed) return;
    this.updateSequence += 1;
    this.disposeExpiredBatches();
    const deltaMilliseconds = this.scene.getEngine().getDeltaTime();
    if (Number.isFinite(deltaMilliseconds)) {
      this.windTimeSeconds += clamp(deltaMilliseconds, 0, 100) / 1_000;
      for (const plugin of this.windPlugins) plugin.setTimeSeconds(this.windTimeSeconds);
    }
    requireFinite(observer.x, "Detail observer x");
    requireFinite(observer.y, "Detail observer y");
    requireFinite(observer.z, "Detail observer z");
    const velocityX = requireFinite(observer.velocityX ?? 0, "Detail observer x velocity");
    const velocityZ = requireFinite(observer.velocityZ ?? 0, "Detail observer z velocity");
    requireFinite(floatingOrigin.x, "Detail floating-origin x");
    requireFinite(floatingOrigin.y, "Detail floating-origin y");
    requireFinite(floatingOrigin.z, "Detail floating-origin z");
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

    const speed = Math.hypot(velocityX, velocityZ);
    const lookAheadSeconds = speed > 1 ? Math.min(6, 1_200 / speed) : 0;
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
      this.cells.clear();
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

    const generationBudget = resolveDetailGenerationBudget(profile);
    const generationStartedAt = this.nowMilliseconds();
    let generated = 0;
    for (const desired of this.desiredCells) {
      if (this.cells.has(desired.key)) continue;
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
      });
      this.cells.set(desired.key, { cell, lod: desired.lod, distance: desired.distance });
      this.cumulativeGeneratedCells += 1;
      generated += 1;
      this.batchesDirty = true;
    }

    if (this.batchesDirty) {
      this.rebuildBatches(floatingOrigin, profile);
      this.batchesDirty = false;
    } else {
      // Camera rotation does not affect paging signatures, but it does change
      // which spatial chunks Babylon submits to the main view.
      this.refreshVisibilityStatistics();
    }
  }

  /** Supplies active, deliberately bounded shadow batches to a CSM or shadow generator. */
  addShadowCasters(add: (mesh: Mesh) => void): void {
    if (this.disposed) return;
    for (const batch of this.batches.values()) {
      if (batch.castsShadows && batch.mesh.isEnabled() && batch.mesh.thinInstanceCount > 0) {
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
    this.cells.clear();
    this.desiredCells = [];
    this.desiredKeys.clear();
    for (const batch of this.batches.values()) batch.mesh.dispose(false, false);
    this.batches.clear();
    for (const retired of this.retiredBatches) retired.batch.mesh.dispose(false, false);
    this.retiredBatches.length = 0;
    this.presentationChunks.clear();
    for (const prototype of this.prototypes.values()) prototype.mesh.dispose(false, false);
    this.prototypes.clear();
    this.windPlugins.clear();
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
    const nearDistance = Math.min(1_400, radius * 0.34);
    const candidates: DesiredCell[] = [];
    const travelDistance = Math.hypot(predictionX - observer.x, predictionZ - observer.z);

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const distance = distanceToCell(
          observer.x,
          observer.z,
          cellX,
          cellZ,
          this.cellSizeMeters,
        );
        const predictedDistance = distanceToCell(
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
    for (const key of this.cells.keys()) {
      if (!this.desiredKeys.has(key)) this.cells.delete(key);
    }
  }

  private rebuildBatches(
    floatingOrigin: DetailFloatingOrigin,
    profile: WebGpuQualityProfile,
  ): void {
    const grouped = new Map<
      string,
      { coordinates: DetailPresentationChunkCoordinates; residents: ResidentCell[] }
    >();
    for (const resident of this.cells.values()) {
      const coordinates = detailPresentationChunkCoordinates(
        resident.cell.cellX,
        resident.cell.cellZ,
      );
      const group = grouped.get(coordinates.key);
      if (group) group.residents.push(resident);
      else grouped.set(coordinates.key, { coordinates, residents: [resident] });
    }

    for (const [chunkKey, chunk] of this.presentationChunks) {
      if (!grouped.has(chunkKey)) this.disposePresentationChunk(chunk);
    }

    const midTreeRetention = clamp(0.2 + profile.vegetationDensity * 0.42, 0.2, 0.66);
    const totals: MutableDetailChunkStatistics = {
      nearCells: 0,
      midCells: 0,
      treeInstances: 0,
      shrubInstances: 0,
      rockInstances: 0,
      buildingInstances: 0,
    };

    for (const group of grouped.values()) {
      group.residents.sort((first, second) => first.cell.key.localeCompare(second.cell.key));
      const signature = [
        floatingOrigin.x,
        floatingOrigin.y,
        floatingOrigin.z,
        profile.vegetationDensity,
        ...group.residents.map((resident) => `${resident.cell.key}/${resident.lod}`),
      ].join(":");
      let chunk = this.presentationChunks.get(group.coordinates.key);
      if (!chunk) {
        chunk = {
          coordinates: group.coordinates,
          batchKeys: new Set<string>(),
          signature: "",
          revision: 0,
          statistics: {
            nearCells: 0,
            midCells: 0,
            treeInstances: 0,
            shrubInstances: 0,
            rockInstances: 0,
            buildingInstances: 0,
          },
        };
        this.presentationChunks.set(group.coordinates.key, chunk);
      }
      if (chunk.signature !== signature) {
        chunk.statistics = this.rebuildPresentationChunk(
          chunk,
          group.residents,
          floatingOrigin,
          midTreeRetention,
        );
        chunk.signature = signature;
      }
      totals.nearCells += chunk.statistics.nearCells;
      totals.midCells += chunk.statistics.midCells;
      totals.treeInstances += chunk.statistics.treeInstances;
      totals.shrubInstances += chunk.statistics.shrubInstances;
      totals.rockInstances += chunk.statistics.rockInstances;
      totals.buildingInstances += chunk.statistics.buildingInstances;
    }

    this.statisticsValue = {
      residentCells: this.cells.size,
      nearCells: totals.nearCells,
      midCells: totals.midCells,
      generatedCells: this.cumulativeGeneratedCells,
      treeInstances: totals.treeInstances,
      shrubInstances: totals.shrubInstances,
      rockInstances: totals.rockInstances,
      buildingInstances: totals.buildingInstances,
      renderedThinInstances: 0,
      activeBatches: 0,
    };
    this.refreshVisibilityStatistics();
  }

  private rebuildPresentationChunk(
    chunk: DetailPresentationChunk,
    residents: readonly ResidentCell[],
    floatingOrigin: DetailFloatingOrigin,
    midTreeRetention: number,
  ): DetailChunkStatistics {
    chunk.revision += 1;
    const nextBatchKeys = new Set<string>();
    const statistics: MutableDetailChunkStatistics = {
      nearCells: 0,
      midCells: 0,
      treeInstances: 0,
      shrubInstances: 0,
      rockInstances: 0,
      buildingInstances: 0,
    };

    for (const resident of residents) {
      if (resident.lod === "near") statistics.nearCells += 1;
      else statistics.midCells += 1;

      for (const tree of resident.cell.trees) {
        const localX = tree.x - floatingOrigin.x;
        const localY = tree.y - floatingOrigin.y;
        const localZ = tree.z - floatingOrigin.z;
        const wind: readonly [number, number, number, number] = [
          tree.windPhaseRadians,
          tree.windResponse,
          tree.heightMeters,
          tree.selection,
        ];
        if (resident.lod === "near") {
          this.appendInstance(
            this.getBatch("tree-trunk-near", chunk, nextBatchKeys),
            localX,
            localY,
            localZ,
            tree.trunkRadiusMeters,
            tree.heightMeters,
            tree.trunkRadiusMeters,
            tree.yawRadians,
            [0.82, 0.74, 0.62, 1],
            [tree.windPhaseRadians, 0.08, tree.heightMeters, tree.selection],
          );
          this.appendInstance(
            this.getBatch(`tree-${tree.species}-near`, chunk, nextBatchKeys),
            localX,
            localY,
            localZ,
            tree.crownRadiusMeters,
            tree.heightMeters,
            tree.crownRadiusMeters,
            tree.yawRadians,
            tree.color,
            wind,
          );
          statistics.treeInstances += 1;
        } else if (tree.selection <= midTreeRetention) {
          this.appendInstance(
            this.getBatch(`tree-${tree.species}-mid`, chunk, nextBatchKeys),
            localX,
            localY,
            localZ,
            tree.crownRadiusMeters,
            tree.heightMeters,
            tree.crownRadiusMeters,
            tree.yawRadians,
            tree.color,
            wind,
          );
          statistics.treeInstances += 1;
        }
      }

      for (const shrub of resident.cell.shrubs) {
        if (resident.lod === "mid" && shrub.selection > 0.2) continue;
        this.appendInstance(
          this.getBatch(`shrub-${shrub.species}`, chunk, nextBatchKeys),
          shrub.x - floatingOrigin.x,
          shrub.y - floatingOrigin.y,
          shrub.z - floatingOrigin.z,
          shrub.radiusMeters,
          shrub.heightMeters,
          shrub.radiusMeters * (0.84 + shrub.selection * 0.24),
          shrub.yawRadians,
          shrub.color,
          [
            shrub.windPhaseRadians,
            shrub.windResponse,
            shrub.heightMeters,
            shrub.selection,
          ],
        );
        statistics.shrubInstances += 1;
      }

      for (const rock of resident.cell.rocks) {
        if (resident.lod === "mid" && (rock.radiusMeters < 2.2 || rock.selection > 0.22)) continue;
        this.appendInstance(
          this.getBatch(`rock-${rock.variant}`, chunk, nextBatchKeys),
          rock.x - floatingOrigin.x,
          rock.y - floatingOrigin.y,
          rock.z - floatingOrigin.z,
          rock.radiusMeters,
          rock.radiusMeters * rock.flattening,
          rock.radiusMeters * (0.78 + rock.selection * 0.4),
          rock.yawRadians,
          rock.color,
          [0, 0, 0, rock.selection],
        );
        statistics.rockInstances += 1;
      }

      for (const building of resident.cell.buildings) {
        const bodyHeight = building.heightMeters * 0.72;
        const roofHeight = building.heightMeters - bodyHeight;
        const localX = building.x - floatingOrigin.x;
        const localY = building.y - floatingOrigin.y;
        const localZ = building.z - floatingOrigin.z;
        this.appendInstance(
          this.getBatch(`building-${building.style}-wall`, chunk, nextBatchKeys),
          localX,
          localY,
          localZ,
          building.widthMeters,
          bodyHeight,
          building.depthMeters,
          building.yawRadians,
          building.color,
          [0, 0, 0, 0],
        );
        this.appendInstance(
          this.getBatch(`building-${building.style}-roof`, chunk, nextBatchKeys),
          localX,
          localY + bodyHeight,
          localZ,
          building.widthMeters * 1.12,
          roofHeight * 2,
          building.depthMeters * 1.16,
          building.yawRadians,
          [0.92, 0.82, 0.76, 1],
          [0, 0, 0, 0],
        );
        if (resident.lod === "near") {
          const facadeX = localX + Math.sin(building.yawRadians) * (building.depthMeters * 0.5 + 0.06);
          const facadeZ = localZ + Math.cos(building.yawRadians) * (building.depthMeters * 0.5 + 0.06);
          this.appendInstance(
            this.getBatch("building-window", chunk, nextBatchKeys),
            facadeX,
            localY + bodyHeight * 0.58,
            facadeZ,
            building.widthMeters * 0.48,
            Math.max(1.1, bodyHeight * 0.24),
            0.08,
            building.yawRadians,
            [0.48, 0.58, 0.62, 1],
            [0, 0, 0, 0],
          );
          this.appendInstance(
            this.getBatch("building-door", chunk, nextBatchKeys),
            facadeX,
            localY + bodyHeight * 0.2,
            facadeZ + 0.01,
            Math.min(2.2, building.widthMeters * 0.18),
            Math.min(3.2, bodyHeight * 0.42),
            0.09,
            building.yawRadians,
            [0.62, 0.5, 0.38, 1],
            [0, 0, 0, 0],
          );
        }
        statistics.buildingInstances += 1;
      }

      const village = resident.cell.village;
      if (village) {
        this.appendInstance(
          this.getBatch("village-road", chunk, nextBatchKeys),
          village.centerX - floatingOrigin.x,
          village.centerY - floatingOrigin.y + 0.035,
          village.centerZ - floatingOrigin.z,
          6.5,
          0.07,
          resident.cell.cellSizeMeters * 0.62,
          village.roadHeadingRadians,
          [0.84, 0.79, 0.68, 1],
          [0, 0, 0, 0],
        );
      }
    }

    // Never replace thin-instance buffers in place. WebGPU render bundles can
    // still reference the previous allocation until the current frame submits;
    // destroying it synchronously produces a validation error. Changed chunks
    // publish new immutable meshes and retire the previous revision after a
    // conservative multi-update grace window.
    for (const batchKey of chunk.batchKeys) this.retireBatch(batchKey);
    chunk.batchKeys.clear();
    for (const batchKey of nextBatchKeys) chunk.batchKeys.add(batchKey);
    for (const batchKey of chunk.batchKeys) {
      const batch = this.batches.get(batchKey);
      if (batch) this.uploadBatch(batch);
    }
    return statistics;
  }

  private uploadBatch(batch: DetailBatch): void {
    const count = batch.matrices.length / 16;
    batch.mesh.thinInstanceCount = 0;
    if (count === 0) {
      batch.mesh.setEnabled(false);
      return;
    }
    batch.mesh.setEnabled(true);
    // A changed chunk receives new immutable buffers. Unchanged chunks keep
    // their GPU allocations while neighboring cells stream in.
    const instanceMatrices = Float32Array.from(batch.matrices);
    batch.mesh.thinInstanceSetBuffer("matrix", instanceMatrices, 16, true);
    batch.mesh.thinInstanceSetBuffer("color", Float32Array.from(batch.colors), 4, true);
    batch.mesh.thinInstanceSetBuffer(
      "instanceWind",
      Float32Array.from(batch.wind),
      4,
      true,
    );
    batch.mesh.resetDrawCache(undefined, true);
    batch.mesh.thinInstanceCount = count;
    (batch.mesh as unknown as ThinInstanceMeshWithCache)
      ._thinInstanceDataStorage.worldMatrices = null;
    batch.mesh.thinInstanceRefreshBoundingInfo(true);
    // Vertex wind can move branch tips slightly outside their static bounds.
    // A small conservative expansion avoids edge-of-frustum popping.
    batch.mesh.getBoundingInfo().scale(1.01);
  }

  private refreshVisibilityStatistics(): void {
    let renderedThinInstances = 0;
    let activeBatches = 0;
    const camera = this.scene.activeCamera;
    for (const batch of this.batches.values()) {
      if (!batch.mesh.isEnabled() || batch.mesh.thinInstanceCount <= 0) continue;
      if (camera && !camera.isInFrustum(batch.mesh)) continue;
      renderedThinInstances += batch.mesh.thinInstanceCount;
      activeBatches += 1;
    }
    this.statisticsValue = {
      ...this.statisticsValue,
      renderedThinInstances,
      activeBatches,
    };
  }

  private appendInstance(
    batch: DetailBatch,
    x: number,
    y: number,
    z: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    yaw: number,
    color: readonly [number, number, number, number],
    wind: readonly [number, number, number, number],
  ): void {
    appendYawMatrix(batch.matrices, x, y, z, scaleX, scaleY, scaleZ, yaw);
    batch.colors.push(...color);
    batch.wind.push(...wind);
  }

  private getBatch(
    prototypeKey: string,
    chunk: DetailPresentationChunk,
    usedBatchKeys: Set<string>,
  ): DetailBatch {
    const coordinates = chunk.coordinates;
    const batchKey = `${prototypeKey}@${coordinates.key}#${chunk.revision}`;
    usedBatchKeys.add(batchKey);
    const existing = this.batches.get(batchKey);
    if (existing) return existing;
    const prototype = this.prototypes.get(prototypeKey);
    if (!prototype) throw new Error(`Missing detail prototype ${prototypeKey}`);
    const mesh = prototype.mesh.clone(
      `detail-${prototypeKey}-chunk-${coordinates.key}-revision-${chunk.revision}`,
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
    mesh.receiveShadows = true;
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
      detailChunkRevision: chunk.revision,
      detailCastsShadow: prototype.castsShadows,
      windAttribute: "instanceWind",
    };
    const batch: DetailBatch = {
      mesh,
      castsShadows: prototype.castsShadows,
      prototypeKey,
      chunkKey: coordinates.key,
      matrices: [],
      colors: [],
      wind: [],
    };
    this.batches.set(batchKey, batch);
    return batch;
  }

  private retireBatch(batchKey: string): void {
    const batch = this.batches.get(batchKey);
    if (!batch) return;
    batch.mesh.setEnabled(false);
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
    const trunkMaterial = this.createMaterial(
      "detail-trunk",
      new Color3(0.26, 0.14, 0.065),
      0.93,
      true,
    );
    const trunk = bakePrototype(CreateCylinder(
      "detail-tree-trunk-near",
      { height: 1, diameterTop: 1.3, diameterBottom: 2, tessellation: 7 },
      this.scene,
    ), 0.5);
    this.registerBatch("tree-trunk-near", trunk, trunkMaterial, true);

    const foliageColors: Readonly<Record<TreeSpecies, Color3>> = {
      pine: new Color3(0.09, 0.28, 0.14),
      cedar: new Color3(0.16, 0.3, 0.12),
      spruce: new Color3(0.075, 0.235, 0.16),
      oak: new Color3(0.24, 0.42, 0.12),
      maple: new Color3(0.3, 0.46, 0.13),
      birch: new Color3(0.29, 0.5, 0.16),
      willow: new Color3(0.31, 0.48, 0.19),
    };
    for (const species of TREE_SPECIES) {
      const material = this.createMaterial(
        `detail-foliage-${species}`,
        foliageColors[species],
        0.87,
        true,
      );
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      this.registerBatch(
        `tree-${species}-near`,
        this.createTreeCrown(species, "near"),
        material,
        true,
      );
      this.registerBatch(
        `tree-${species}-mid`,
        this.createTreeCrown(species, "mid"),
        material,
        false,
      );
    }

    const shrubColors: Readonly<Record<ShrubSpecies, Color3>> = {
      juniper: new Color3(0.16, 0.31, 0.19),
      hazel: new Color3(0.31, 0.46, 0.14),
      sage: new Color3(0.35, 0.41, 0.31),
    };
    for (const species of SHRUB_SPECIES) {
      const material = this.createMaterial(
        `detail-shrub-${species}-material`,
        shrubColors[species],
        0.91,
        true,
      );
      material.backFaceCulling = false;
      const mesh = CreateIcoSphere(
        `detail-shrub-${species}`,
        {
          radius: 1,
          radiusX: species === "sage" ? 1.18 : species === "hazel" ? 0.92 : 1.05,
          radiusY: species === "sage" ? 0.48 : species === "hazel" ? 0.78 : 0.62,
          radiusZ: species === "sage" ? 0.88 : 1,
          subdivisions: 1,
          flat: true,
        },
        this.scene,
      );
      const verticalRadius = species === "sage" ? 0.48 : species === "hazel" ? 0.78 : 0.62;
      this.registerBatch(
        `shrub-${species}`,
        bakePrototype(mesh, verticalRadius),
        material,
        false,
      );
    }

    const rockColors: Readonly<Record<RockVariant, Color3>> = {
      granite: new Color3(0.38, 0.39, 0.4),
      limestone: new Color3(0.5, 0.48, 0.41),
      dark: new Color3(0.22, 0.24, 0.25),
    };
    for (const variant of ROCK_VARIANTS) {
      const mesh = CreateIcoSphere(
        `detail-rock-${variant}`,
        { radius: 1, subdivisions: 1, flat: true },
        this.scene,
      );
      this.registerBatch(
        `rock-${variant}`,
        mesh,
        this.createMaterial(`detail-rock-material-${variant}`, rockColors[variant], 0.94),
        false,
      );
    }

    const wallColors: Readonly<Record<BuildingStyle, Color3>> = {
      cottage: new Color3(0.55, 0.42, 0.27),
      barn: new Color3(0.38, 0.15, 0.09),
      tower: new Color3(0.42, 0.42, 0.38),
    };
    const roofColors: Readonly<Record<BuildingStyle, Color3>> = {
      cottage: new Color3(0.28, 0.13, 0.08),
      barn: new Color3(0.18, 0.07, 0.045),
      tower: new Color3(0.22, 0.23, 0.24),
    };
    for (const style of BUILDING_STYLES) {
      const wall = bakePrototype(
        CreateBox(`detail-building-${style}-wall`, { size: 1 }, this.scene),
        0.5,
      );
      this.registerBatch(
        `building-${style}-wall`,
        wall,
        this.createMaterial(`detail-building-${style}-wall-material`, wallColors[style], 0.82),
        true,
      );
      this.registerBatch(
        `building-${style}-roof`,
        createGabledRoof(`detail-building-${style}-roof`, this.scene),
        this.createMaterial(`detail-building-${style}-roof-material`, roofColors[style], 0.76),
        true,
      );
    }
    const facadePrototype = bakePrototype(
      CreateBox("detail-building-facade-feature", { size: 1 }, this.scene),
      0.5,
    );
    this.registerBatch(
      "building-window",
      facadePrototype,
      this.createMaterial("detail-building-window-material", new Color3(0.12, 0.2, 0.23), 0.18),
      false,
    );
    const doorPrototype = bakePrototype(
      CreateBox("detail-building-door", { size: 1 }, this.scene),
      0.5,
    );
    this.registerBatch(
      "building-door",
      doorPrototype,
      this.createMaterial("detail-building-door-material", new Color3(0.24, 0.15, 0.08), 0.82),
      false,
    );
    const roadPrototype = bakePrototype(
      CreateBox("detail-village-road", { size: 1 }, this.scene),
      0.5,
    );
    this.registerBatch(
      "village-road",
      roadPrototype,
      this.createMaterial("detail-village-road-material", new Color3(0.24, 0.2, 0.14), 1),
      false,
    );
  }

  private createTreeCrown(species: TreeSpecies, lod: DetailLod): Mesh {
    const suffix = `${species}-${lod}`;
    if (species === "pine" || species === "cedar" || species === "spruce") {
      const height = species === "cedar" ? 0.84 : species === "spruce" ? 0.9 : 0.78;
      const mesh = CreateCylinder(
        `detail-tree-${suffix}`,
        {
          height,
          diameterTop: species === "cedar" ? 0.12 : 0,
          diameterBottom: species === "spruce" ? 1.68 : 2,
          tessellation: lod === "near" ? 9 : 5,
        },
        this.scene,
      );
      return bakePrototype(mesh, species === "pine" ? 0.59 : species === "spruce" ? 0.55 : 0.57);
    }
    const mesh = CreateIcoSphere(
      `detail-tree-${suffix}`,
      {
        radius: 1,
        radiusX: species === "birch" ? 0.72 : species === "willow" ? 1.12 : 1,
        radiusY: species === "birch" ? 0.3 : species === "willow" ? 0.25 : 0.34,
        radiusZ: species === "birch" ? 0.72 : species === "willow" ? 1.08 : 0.95,
        subdivisions: lod === "near" ? 2 : 1,
        flat: lod === "mid",
      },
      this.scene,
    );
    return bakePrototype(mesh, species === "birch" ? 0.72 : species === "willow" ? 0.7 : 0.67);
  }

  private createMaterial(
    name: string,
    albedo: Color3,
    roughness: number,
    windDeformation = false,
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    material.albedoColor = albedo;
    material.metallic = 0;
    material.roughness = roughness;
    material.environmentIntensity = 0.7;
    material.directIntensity = 1.05;
    material.specularIntensity = 0.25;
    if (windDeformation) {
      const plugin = new DetailWindMaterialPlugin(material);
      plugin.setTimeSeconds(this.windTimeSeconds);
      this.windPlugins.add(plugin);
    }
    this.materials.add(material);
    return material;
  }

  private registerBatch(
    key: string,
    mesh: Mesh,
    material: PBRMaterial,
    castsShadows: boolean,
  ): void {
    mesh.material = material;
    mesh.isPickable = false;
    mesh.useVertexColors = true;
    mesh.receiveShadows = true;
    mesh.setEnabled(false);
    mesh.metadata = { detailPrototype: key, windAttribute: "instanceWind" };
    this.prototypes.set(key, {
      mesh,
      material,
      castsShadows,
    });
  }
}
