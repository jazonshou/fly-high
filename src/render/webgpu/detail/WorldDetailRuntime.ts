import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateIcoSphere } from "@babylonjs/core/Meshes/Builders/icoSphereBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
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
import { createFoliageAtlas, type FoliageAtlas } from "./FoliageAtlas";
import {
  buildShrubPrototype,
  buildTreePrototype,
  SHRUB_VARIANT_COUNTS,
  TREE_VARIANT_COUNTS,
  type PrototypeGeometry,
} from "./prototypeGeometry";
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
  /** 2-13a: world latitude for the seasonal kernel. Default 45°N. */
  readonly latitudeDegrees?: number;
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
  private readonly pluginByMaterial = new Map<PBRMaterial, DetailInstanceMaterialPlugin>();
  /** 2-12: crown/trunk radius-per-height per species, from the built prototypes. */
  private readonly crownAspects = new Map<TreeSpecies, number>();
  private readonly trunkAspects = new Map<TreeSpecies, number>();
  /** 2-12b: shrub radius-per-height per species, same convention. */
  private readonly shrubAspects = new Map<ShrubSpecies, number>();
  /** 2-12: the atlas (null under NullEngine — no raw 2D-array support). */
  private foliageAtlas: FoliageAtlas | null = null;
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

  /** 2-13: the frame's wind snapshot, forwarded to every instance plugin. */
  setWind(directionX: number, directionZ: number, strength: number, gust: number): void {
    for (const plugin of this.instancePlugins) {
      plugin.setWind(directionX, directionZ, strength, gust);
    }
  }

  get statistics(): WorldDetailStatistics {
    return this.statisticsValue;
  }

  update(
    observer: WorldDetailObserver,
    floatingOrigin: DetailFloatingOrigin,
    profile: WebGpuQualityProfile,
    simulationTimeSeconds?: number,
  ): void {
    if (this.disposed) return;
    this.updateSequence += 1;
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
          dayOfYear: this.dayOfYear,
          latitudeDegrees: this.options.latitudeDegrees ?? 45,
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
        profile.treeVariantCap,
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
          profile.treeVariantCap,
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
    treeVariantCap: number,
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
      // Shrubs are woody plants: they ride the SAME law falloff as trees
      // (the pre-law 60-near/6-mid share admitted 137k icosphere shrubs to
      // 8 km — 11M triangles of sub-pixel blobs, +6-15 ms GPU on every
      // shot), plus a hard cutoff at the mid boundary: understory at 1.4 km
      // subtends under half a pixel. 2-12b re-prices the geometry to cards.
      const shrubsPerHa = resident.cell.shrubs.length / Math.max(cellHectares, 1e-6);
      const shrubBudgetPerHa = 60 * renderedShareAtDistance(densityLaw, resident.distance);
      const shrubShare = resident.distance > densityLaw.mid.outerRadiusMeters
        ? 0
        : Math.min(1, shrubBudgetPerHa / Math.max(shrubsPerHa, 1e-6));

      for (const tree of resident.cell.trees) {
        if (tree.selection > treeShare) continue;
        const localX = tree.x - floatingOrigin.x;
        const localY = tree.y - floatingOrigin.y;
        const localZ = tree.z - floatingOrigin.z;
        // R-21 banding by the LAW's radii (see below) — computed first
        // because the band also caps GEOMETRY variants: every distinct
        // (species, variant, band) mesh is a draw call per chunk, and the
        // measured cost was ~26 µs of GPU per draw — the 2-12 batch topology
        // added ~350-560 draws over the 2B baseline and the Δgpu tracked
        // Δdraws on every shot. Far cards keep ONE variant per species
        // (aspect differences are invisible past 1.4 km; per-instance
        // height/radial scales and tint carry the variety), mid keeps three.
        const band = resident.distance <= densityLaw.near.outerRadiusMeters
          ? "near"
          : resident.distance <= densityLaw.mid.outerRadiusMeters
            ? "mid"
            : "far";
        const bandVariantCap = band === "far" ? 1 : band === "mid" ? 3 : treeVariantCap;
        // 2-12: geometry variant + character modifier from two stable
        // hashes of the stem's selection value. Modifier mix: 55% intact,
        // 15% lean, 12% thinned crown, 10% broken top, 8% dead top.
        const variantCount = clamp(
          Math.min(Math.round(TREE_VARIANT_COUNTS[tree.species]), treeVariantCap, bandVariantCap),
          1,
          32,
        );
        const variantHash = (tree.selection * 71.7) % 1;
        const geometryVariant = Math.min(
          variantCount - 1,
          Math.floor(variantHash * variantCount),
        );
        const modifierHash = (tree.selection * 137.3) % 1;
        const modifierBits = modifierHash < 0.55 ? 0
          : modifierHash < 0.70 ? 1
          : modifierHash < 0.82 ? 3
          : modifierHash < 0.92 ? 2
          : 4;
        const variantByte = geometryVariant + modifierBits * 32;
        // Per-instance lean of 2-8 degrees composed into the quaternion.
        const leanRadians = (0.035 + ((tree.selection * 29.3) % 1) * 0.105);
        const leanAzimuth = ((tree.selection * 53.9) % 1) * 2 * Math.PI;
        const quaternion = WorldDetailRuntime.yawLeanQuaternion(
          tree.yawRadians,
          leanRadians,
          leanAzimuth,
        );
        const windPhase = tree.windPhaseRadians / (2 * Math.PI);
        const crownAspect = this.crownAspects.get(tree.species) ?? 0.3;
        const trunkAspect = this.trunkAspects.get(tree.species) ?? 0.02;
        const crown: DetailInstanceRecord = {
          x: localX,
          y: localY,
          z: localZ,
          quaternion,
          heightScaleMeters: tree.heightMeters,
          radialScale: WorldDetailRuntime.radialMultiplier(
            tree.crownRadiusMeters,
            tree.heightMeters,
            crownAspect,
          ),
          fade: 1,
          variant: variantByte,
          tint: tree.color,
          windPhase,
          windResponse: clamp(tree.windResponse, 0, 1),
        };
        const trunk: DetailInstanceRecord = {
          ...crown,
          radialScale: WorldDetailRuntime.radialMultiplier(
            tree.trunkRadiusMeters,
            tree.heightMeters,
            trunkAspect,
          ),
          windResponse: 0.08,
        };
        // Banding is the law's radii, not the residency lod: the law prices
        // each band's geometry, so the band boundary must be the law's, and
        // a far stem must never draw mid geometry (the first 2-12 capture
        // integrated exactly that mistake to 4.7× budget).
        this.appendInstance(
          this.getBatch(
            `tree-${tree.species}-v${geometryVariant}-crown-${band}`,
            chunk,
            nextBatchKeys,
          ),
          crown,
        );
        // A trunk exists at near and mid — no floating crowns; the far
        // band's crossed cards carry the whole silhouette.
        if (band !== "far") {
          this.appendInstance(
            this.getBatch(
              `tree-${tree.species}-v${geometryVariant}-trunk-${band}`,
              chunk,
              nextBatchKeys,
            ),
            trunk,
          );
        }
        statistics.treeInstances += 1;
      }

      for (const shrub of resident.cell.shrubs) {
        if (shrubShare <= 0 || shrub.selection > shrubShare) continue;
        // 2-12b: card shrubs with the tree pipeline's exact conventions —
        // geometry variant from the selection hash (both variants inside the
        // near band, one at mid: every (species, variant) mesh is a draw per
        // chunk, and mid shrubs are a few pixels), radial aspect from the
        // built prototype through the shared per-material uniform.
        const shrubVariantCount = resident.distance <= densityLaw.near.outerRadiusMeters
          ? SHRUB_VARIANT_COUNTS[shrub.species]
          : 1;
        const shrubVariant = Math.min(
          shrubVariantCount - 1,
          Math.floor(((shrub.selection * 71.7) % 1) * shrubVariantCount),
        );
        const shrubAspect = this.shrubAspects.get(shrub.species) ?? 0.4;
        this.appendInstance(
          this.getBatch(`shrub-${shrub.species}-v${shrubVariant}`, chunk, nextBatchKeys),
          {
            x: shrub.x - floatingOrigin.x,
            y: shrub.y - floatingOrigin.y,
            z: shrub.z - floatingOrigin.z,
            quaternion: yawQuaternion(shrub.yawRadians),
            heightScaleMeters: shrub.heightMeters,
            radialScale: WorldDetailRuntime.radialMultiplier(
              shrub.radiusMeters * (0.92 + shrub.selection * 0.12),
              shrub.heightMeters,
              shrubAspect,
            ),
            fade: 1,
            variant: shrubVariant,
            tint: shrub.color,
            windPhase: shrub.windPhaseRadians / (2 * Math.PI),
            windResponse: clamp(shrub.windResponse, 0, 1),
          },
        );
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

  /** Composes yaw with a small lean about a hashed azimuth (2-12). */
  private static yawLeanQuaternion(
    yawRadians: number,
    leanRadians: number,
    leanAzimuthRadians: number,
  ): [number, number, number, number] {
    const [, yy, , yw] = yawQuaternion(yawRadians);
    const halfLean = leanRadians / 2;
    const sinLean = Math.sin(halfLean);
    const lx = Math.cos(leanAzimuthRadians) * sinLean;
    const lz = Math.sin(leanAzimuthRadians) * sinLean;
    const lw = Math.cos(halfLean);
    // q = lean ∘ yaw (yaw = (0, yy, 0, yw)).
    return [
      lx * yw + lz * yy,
      yy * lw,
      lz * yw - lx * yy,
      lw * yw,
    ];
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
    // 2-12: the foliage atlas's FIRST sampler. Under NullEngine (no raw
    // 2D-array support) the atlas is skipped and materials compile without
    // the atlas define — geometry and instancing stay fully testable.
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (engineFlags.isWebGPU || engineFlags._gl) {
      this.foliageAtlas = createFoliageAtlas(this.scene, this.options.worldSeed);
    }

    // 2-12: card trees from the built prototypes — species-specific trunks
    // (swept generalised cylinders with root flare and forks) and 40-60
    // tilted crown quads, with 16-direction baked sky occlusion in vertex
    // alpha. Prototypes are unit-height with true proportions, so the
    // per-material radial aspect is the prototype's own crown/trunk radius.
    // Bark stays back-face-culled in its own batch while foliage is
    // two-sided: zero extra draw calls per the plan.
    const prototypeSeed = 7;
    for (const species of TREE_SPECIES) {
      const variantCount = clamp(
        Math.round(TREE_VARIANT_COUNTS[species]),
        1,
        32,
      );
      const crownMaterial = this.createMaterial(
        `detail-foliage-${species}`,
        new Color3(0.62, 0.66, 0.58),
        0.87,
        1,
        true,
      );
      crownMaterial.backFaceCulling = false;
      crownMaterial.twoSidedLighting = true;
      // R-2E's mandated mitigation: canopy renders in the alpha-test bucket,
      // AFTER opaque terrain and trunks have filled the depth buffer, so
      // early-Z kills every canopy fragment behind a ridge or a trunk before
      // its two-sided PBR shading runs. The built-in test itself is a no-op
      // here (no albedo texture, material alpha 1) — the plugin's atlas
      // discard is the real test; this move is purely about draw order.
      crownMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
      const barkMaterial = this.createMaterial(
        `detail-bark-${species}`,
        new Color3(0.58, 0.52, 0.46),
        0.93,
        1,
        true,
      );
      for (let variant = 0; variant < variantCount; variant += 1) {
        const prototype = buildTreePrototype(species, variant, prototypeSeed);
        const crownAspect = Math.max(prototype.crown.boundingRadius, 0.05);
        const trunkAspect = Math.max(prototype.trunk.boundingRadius, 0.005);
        if (variant === 0) {
          this.crownAspects.set(species, crownAspect);
          this.trunkAspects.set(species, trunkAspect);
          this.materialPlugin(crownMaterial)?.setRadialAspect(crownAspect);
          this.materialPlugin(barkMaterial)?.setRadialAspect(trunkAspect);
        }
        this.registerBatch(
          `tree-${species}-v${variant}-crown-near`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-crown`, prototype.crown),
          crownMaterial,
          true,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-trunk-near`,
          this.buildPrototypeMesh(`detail-tree-${species}-v${variant}-trunk`, prototype.trunk),
          barkMaterial,
          true,
        );
        // Mid and far bands draw the law-priced standins (≤48 and ≤8
        // triangles per plant): a trunk exists at mid (no floating crowns);
        // far is crossed cards, crown layer only. 2-14 replaces the mid
        // standin with its authored card tier, 2-17 the far one with
        // octahedral impostors.
        const midPrototype = buildTreePrototype(species, variant, prototypeSeed, "mid");
        const farPrototype = buildTreePrototype(species, variant, prototypeSeed, "far");
        this.registerBatch(
          `tree-${species}-v${variant}-crown-mid`,
          this.buildPrototypeMesh(
            `detail-tree-${species}-v${variant}-crown-mid`,
            midPrototype.crown,
          ),
          crownMaterial,
          false,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-trunk-mid`,
          this.buildPrototypeMesh(
            `detail-tree-${species}-v${variant}-trunk-mid`,
            midPrototype.trunk,
          ),
          barkMaterial,
          false,
        );
        this.registerBatch(
          `tree-${species}-v${variant}-crown-far`,
          this.buildPrototypeMesh(
            `detail-tree-${species}-v${variant}-crown-far`,
            farPrototype.crown,
          ),
          crownMaterial,
          false,
        );
      }
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
        1,
        true,
      );
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        const prototype = buildShrubPrototype(species, variant, prototypeSeed);
        if (variant === 0) {
          const aspect = Math.max(prototype.boundingRadius, 0.05);
          this.shrubAspects.set(species, aspect);
          this.materialPlugin(material)?.setRadialAspect(aspect);
        }
        this.registerBatch(
          `shrub-${species}-v${variant}`,
          this.buildPrototypeMesh(`detail-shrub-${species}-v${variant}`, prototype),
          material,
          false,
        );
      }
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
    radialAspect: number,
    samplesFoliageAtlas = false,
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
      material.shadowDepthWrapper = new ShadowDepthWrapper(material, this.scene, {
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
