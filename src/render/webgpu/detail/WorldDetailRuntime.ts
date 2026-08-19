import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure";
import { CreateIcoSphere } from "@babylonjs/core/Meshes/Builders/icoSphereBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  renderedShareAtDistance,
  type RenderedDensityLaw,
} from "./renderedDensity";
import { DetailGenerationClient } from "./DetailGenerationClient";
import { DetailInstanceMaterialPlugin } from "./DetailInstanceMaterialPlugin";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_RADIAL_MAX,
  DETAIL_INSTANCE_RADIAL_MIN,
  DETAIL_INSTANCE_STRIDE_BYTES,
  DetailInstanceBounds,
  DetailInstanceWriter,
  yawQuaternion,
  type DetailInstanceRecord,
} from "./instanceFormat";
import { detailCellKey, generateDetailCell } from "./generation";
import {
  canGenerateNextDetailCell,
  resolveDetailGenerationBudget,
  type DetailGenerationBudget,
} from "./generationBudget";
import {
  detailPresentationChunkCoordinates,
  type DetailPresentationChunkCoordinates,
} from "./spatialChunks";
import {
  DEFAULT_DETAIL_CELL_SIZE_METERS,
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
  /** 2-11a: packed 32-byte records built during generation. */
  readonly writer: DetailInstanceWriter;
  readonly bounds: DetailInstanceBounds;
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
  /** Sea level anchoring the density field's shoreline/treeline (1B-7). */
  readonly seaLevelMeters?: number;
  /**
   * Enables off-main-thread generation (1B-10): the worker rebuilds the same
   * world from this seed and streams cells back. Omit it (tests, headless
   * tools) and generation stays inline and synchronous.
   */
  readonly workerWorldSeed?: string | number;
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

const ZERO_STATISTICS: WorldDetailStatistics = Object.freeze({
  residentCells: 0,
  nearCells: 0,
  midCells: 0,
  generatedCells: 0,
  treeInstances: 0,
  shrubInstances: 0,
  rockInstances: 0,
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
  private readonly instancePlugins = new Set<DetailInstanceMaterialPlugin>();
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
  /** R-13: the environment clock's day, forwarded to cell generation. */
  private dayOfYear = 0;
  /** Governor B lever 2 (1A-6b): tightens the per-frame generation slice. */
  private generationBudgetCap: DetailGenerationBudget | null = null;
  /** Null when generation is inline; the 1B-10 worker client otherwise. */
  private client: DetailGenerationClient | null = null;
  /** Desired keys with a request in flight, mapped to their request ids. */
  private readonly pendingCells = new Map<string, number>();
  /** Bumped whenever resident cells reset; stale worker results are dropped. */
  private cellEpoch = 0;
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
    if (options.workerWorldSeed !== undefined) {
      this.client = new DetailGenerationClient(
        {
          worldSeed: options.workerWorldSeed,
          cellSizeMeters: this.cellSizeMeters,
          seaLevelMeters: options.seaLevelMeters ?? 0,
        },
        () => {
          // Worker died: fall back to inline generation on the next update.
          this.client = null;
          this.pendingCells.clear();
        },
      );
    }
  }

  /**
   * Governor B lever 2: cap the per-frame generation slice below the
   * profile's own budget. Null restores the profile default.
   */
  setGenerationBudgetCap(cap: DetailGenerationBudget | null): void {
    this.generationBudgetCap = cap;
  }

  /**
   * R-13: the environment clock's day, forwarded to cell generation. The
   * density field is deliberately season-invariant today (stems do not move
   * with the calendar), so a change does not invalidate resident cells —
   * `2-13a`'s appearance field is the first consumer that reads it.
   */
  setDayOfYear(dayOfYear: number): void {
    this.dayOfYear = dayOfYear;
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
      for (const plugin of this.instancePlugins) plugin.setTimeSeconds(this.windTimeSeconds);
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

    if (this.client !== null) {
      // 1B-10: generation happens on the worker; the main thread only files
      // requests (streaming-priority ordered by the bounded queue) and
      // applies results as they arrive. The Governor B budget cap survives
      // as the request-admission bound.
      const requestCap = this.generationBudgetCap?.maximumCells ?? Number.POSITIVE_INFINITY;
      let admitted = 0;
      for (const desired of this.desiredCells) {
        if (admitted >= requestCap) break;
        if (this.cells.has(desired.key) || this.pendingCells.has(desired.key)) continue;
        const epoch = this.cellEpoch;
        const requestId = this.client.request(
          {
            key: desired.key,
            generation: epoch,
            priority: desired.priority,
            cellX: desired.cellX,
            cellZ: desired.cellZ,
            densityMultiplier: profile.vegetationDensity,
            dayOfYear: this.dayOfYear,
          },
          (cell) => this.onCellGenerated(desired.key, epoch, cell),
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
          seaLevelMeters: this.options.seaLevelMeters ?? 0,
        });
        this.cells.set(desired.key, { cell, lod: desired.lod, distance: desired.distance });
        this.cumulativeGeneratedCells += 1;
        generated += 1;
        this.batchesDirty = true;
      }
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
    this.client?.dispose();
    this.client = null;
    this.pendingCells.clear();
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
    this.instancePlugins.clear();
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
    for (const [key, requestId] of this.pendingCells) {
      if (this.desiredKeys.has(key)) continue;
      this.client?.cancel(requestId);
      this.pendingCells.delete(key);
    }
  }

  /** Applies one worker-generated cell; stale epochs and keys are dropped. */
  private onCellGenerated(key: string, epoch: number, cell: GeneratedDetailCell): void {
    this.pendingCells.delete(key);
    if (this.disposed || epoch !== this.cellEpoch || !this.desiredKeys.has(key)) return;
    const desired = this.desiredCells.find((candidate) => candidate.key === key);
    this.cells.set(key, {
      cell,
      lod: desired?.lod ?? "mid",
      distance: desired?.distance ?? Number.POSITIVE_INFINITY,
    });
    this.cumulativeGeneratedCells += 1;
    this.batchesDirty = true;
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
    const totals: MutableDetailChunkStatistics = {
      nearCells: 0,
      midCells: 0,
      treeInstances: 0,
      shrubInstances: 0,
      rockInstances: 0,
        };

    for (const group of grouped.values()) {
      group.residents.sort((first, second) => first.cell.key.localeCompare(second.cell.key));
      const signature = [
        floatingOrigin.x,
        floatingOrigin.y,
        floatingOrigin.z,
        densityLaw.nearStemsPerHectare,
        densityLaw.near.outerRadiusMeters,
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
                    },
        };
        this.presentationChunks.set(group.coordinates.key, chunk);
      }
      if (chunk.signature !== signature) {
        chunk.statistics = this.rebuildPresentationChunk(
          chunk,
          group.residents,
          floatingOrigin,
          densityLaw,
        );
        chunk.signature = signature;
      }
      totals.nearCells += chunk.statistics.nearCells;
      totals.midCells += chunk.statistics.midCells;
      totals.treeInstances += chunk.statistics.treeInstances;
      totals.shrubInstances += chunk.statistics.shrubInstances;
      totals.rockInstances += chunk.statistics.rockInstances;
    }

    this.statisticsValue = {
      residentCells: this.cells.size,
      nearCells: totals.nearCells,
      midCells: totals.midCells,
      generatedCells: this.cumulativeGeneratedCells,
      treeInstances: totals.treeInstances,
      shrubInstances: totals.shrubInstances,
      rockInstances: totals.rockInstances,
      renderedThinInstances: 0,
      activeBatches: 0,
    };
    this.refreshVisibilityStatistics();
  }

  private rebuildPresentationChunk(
    chunk: DetailPresentationChunk,
    residents: readonly ResidentCell[],
    floatingOrigin: DetailFloatingOrigin,
    densityLaw: RenderedDensityLaw,
  ): DetailChunkStatistics {
    chunk.revision += 1;
    const nextBatchKeys = new Set<string>();
    const statistics: MutableDetailChunkStatistics = {
      nearCells: 0,
      midCells: 0,
      treeInstances: 0,
      shrubInstances: 0,
      rockInstances: 0,
        };

    for (const resident of residents) {
      if (resident.lod === "near") statistics.nearCells += 1;
      else statistics.midCells += 1;

      const cellHectares = (resident.cell.cellSizeMeters * resident.cell.cellSizeMeters) / 10_000;
      const stemsPerHa = resident.cell.trees.length / Math.max(cellHectares, 1e-6);
      // R-21: the law's share curve, keyed on real cell distance. Until 2-14
      // and 2-17 land their card/impostor bands, mid- and far-band stems draw
      // with today's mid geometry — the density is final, the geometry per
      // band arrives with its item.
      const treeBudgetPerHa = densityLaw.nearStemsPerHectare
        * renderedShareAtDistance(densityLaw, resident.distance);
      const treeShare = Math.min(1, treeBudgetPerHa / Math.max(stemsPerHa, 1e-6));
      const shrubsPerHa = resident.cell.shrubs.length / Math.max(cellHectares, 1e-6);
      const shrubShare = Math.min(
        1,
        (resident.lod === "near" ? 60 : 6) / Math.max(shrubsPerHa, 1e-6),
      );

      for (const tree of resident.cell.trees) {
        if (tree.selection > treeShare) continue;
        const localX = tree.x - floatingOrigin.x;
        const localY = tree.y - floatingOrigin.y;
        const localZ = tree.z - floatingOrigin.z;
        const quaternion = yawQuaternion(tree.yawRadians);
        const windPhase = tree.windPhaseRadians / (2 * Math.PI);
        const crown: DetailInstanceRecord = {
          x: localX,
          y: localY,
          z: localZ,
          quaternion,
          heightScaleMeters: tree.heightMeters,
          radialScale: WorldDetailRuntime.radialMultiplier(
            tree.crownRadiusMeters,
            tree.heightMeters,
            0.3,
          ),
          fade: 1,
          variant: 0,
          tint: tree.color,
          windPhase,
          windResponse: clamp(tree.windResponse, 0, 1),
        };
        if (resident.lod === "near") {
          this.appendInstance(this.getBatch("tree-trunk-near", chunk, nextBatchKeys), {
            ...crown,
            radialScale: WorldDetailRuntime.radialMultiplier(
              tree.trunkRadiusMeters,
              tree.heightMeters,
              0.02,
            ),
            tint: [0.82, 0.74, 0.62, 1],
            windResponse: 0.08,
          });
          this.appendInstance(
            this.getBatch(`tree-${tree.species}-near`, chunk, nextBatchKeys),
            crown,
          );
          statistics.treeInstances += 1;
        } else {
          this.appendInstance(
            this.getBatch(`tree-${tree.species}-mid`, chunk, nextBatchKeys),
            crown,
          );
          statistics.treeInstances += 1;
        }
      }

      for (const shrub of resident.cell.shrubs) {
        if (shrub.selection > shrubShare) continue;
        // 2-11a: the format carries ONE radial — the old elliptic XZ hack
        // (scaleZ = radius x (0.84 + selection x 0.24)) folds into the mean;
        // footprint variety returns as 2-12/2-15 variant geometry.
        this.appendInstance(this.getBatch(`shrub-${shrub.species}`, chunk, nextBatchKeys), {
          x: shrub.x - floatingOrigin.x,
          y: shrub.y - floatingOrigin.y,
          z: shrub.z - floatingOrigin.z,
          quaternion: yawQuaternion(shrub.yawRadians),
          heightScaleMeters: shrub.heightMeters,
          radialScale: WorldDetailRuntime.radialMultiplier(
            shrub.radiusMeters * (0.92 + shrub.selection * 0.12),
            shrub.heightMeters,
            1.1,
          ),
          fade: 1,
          variant: 0,
          tint: shrub.color,
          windPhase: shrub.windPhaseRadians / (2 * Math.PI),
          windResponse: clamp(shrub.windResponse, 0, 1),
        });
        statistics.shrubInstances += 1;
      }

      for (const rock of resident.cell.rocks) {
        if (resident.lod === "mid" && (rock.radiusMeters < 2.2 || rock.selection > 0.22)) continue;
        this.appendInstance(
          this.getBatch(`rock-${rock.variant}`, chunk, nextBatchKeys),
          {
            x: rock.x - floatingOrigin.x,
            y: rock.y - floatingOrigin.y,
            z: rock.z - floatingOrigin.z,
            quaternion: yawQuaternion(rock.yawRadians),
            heightScaleMeters: rock.radiusMeters * rock.flattening,
            radialScale: WorldDetailRuntime.radialMultiplier(
              rock.radiusMeters * (0.89 + rock.selection * 0.2),
              rock.radiusMeters * rock.flattening,
              1.6,
            ),
            fade: 1,
            variant: 0,
            tint: rock.color,
            windPhase: 0,
            windResponse: 0,
          },
        );
        statistics.rockInstances += 1;
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
    const count = batch.writer.count;
    batch.mesh.forcedInstanceCount = 0;
    if (count === 0) {
      batch.mesh.setEnabled(false);
      return;
    }
    batch.mesh.setEnabled(true);
    // 2-11a: one interleaved immutable 32-byte-stride buffer per batch (the
    // pooled writer's exact byte range), exposed as five typed instanced
    // vertex buffers. A changed chunk receives new buffers; unchanged chunks
    // keep their GPU allocations while neighboring cells stream in.
    const packed = batch.writer.finish();
    const engine = this.scene.getEngine();
    const shared = new Buffer(
      engine,
      packed,
      false,
      DETAIL_INSTANCE_STRIDE_BYTES,
      false,
      true,
      true,
    );
    const typeFor = (name: string): number =>
      name === "float" ? VertexBuffer.FLOAT
      : name === "snorm16" ? VertexBuffer.SHORT
      : name === "unorm16" ? VertexBuffer.UNSIGNED_SHORT
      : VertexBuffer.UNSIGNED_BYTE;
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      batch.mesh.setVerticesBuffer(
        new VertexBuffer(engine, shared, attribute.kind, {
          updatable: false,
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
    batch.mesh.forcedInstanceCount = count;
    // Generator-computed bounds — thinInstanceRefreshBoundingInfo has no
    // matrix buffer to walk anymore, and the wind extent is already an
    // explicit term in the accumulator.
    batch.mesh.setBoundingInfo(new BoundingInfo(
      Vector3.FromArray(batch.bounds.minimum()),
      Vector3.FromArray(batch.bounds.maximum()),
    ));
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

  private appendInstance(
    batch: DetailBatch,
    record: DetailInstanceRecord,
  ): void {
    batch.writer.push(record);
    // The wind extent is an explicit bounds term now, not a scale fudge.
    batch.bounds.add(record, record.windResponse * record.heightScaleMeters * 0.11);
  }

  /** Maps a desired world radius onto the [0.5, 1.6] slenderness multiplier. */
  private static radialMultiplier(
    radiusMeters: number,
    heightMeters: number,
    aspect: number,
  ): number {
    return clamp(
      radiusMeters / Math.max(heightMeters * aspect, 1e-4),
      DETAIL_INSTANCE_RADIAL_MIN,
      DETAIL_INSTANCE_RADIAL_MAX,
    );
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
    };
    const batch: DetailBatch = {
      mesh,
      castsShadows: prototype.castsShadows,
      prototypeKey,
      chunkKey: coordinates.key,
      writer: new DetailInstanceWriter(),
      bounds: new DetailInstanceBounds(),
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
    // Aspect = the prototype's authored radius-per-height at multiplier 1;
    // the appenders divide desired radii by it, so the quantised multiplier
    // stays near 1 inside its [0.5, 1.6] band.
    const trunkMaterial = this.createMaterial(
      "detail-trunk",
      new Color3(0.26, 0.14, 0.065),
      0.93,
      0.02,
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
        0.3,
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
        1.1,
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
        this.createMaterial(`detail-rock-material-${variant}`, rockColors[variant], 0.94, 1.6),
        false,
      );
    }

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
    radialAspect: number,
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
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
    plugin.setRadialAspect(radialAspect);
    this.instancePlugins.add(plugin);
    // 0-9 incantation, verbatim: the wrapper is assigned AFTER the vertex-
    // participating plugin attaches and BEFORE the material's first effect
    // compiles — attached later it silently falls back to the undisplaced
    // depth pass, which with no matrix buffer would collapse every shadow
    // instance onto the batch origin. No remappedVariables.
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (engineFlags.isWebGPU || engineFlags._gl) {
      material.shadowDepthWrapper = new ShadowDepthWrapper(material, this.scene);
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
    mesh.metadata = { detailPrototype: key };
    this.prototypes.set(key, {
      mesh,
      material,
      castsShadows,
    });
  }
}
