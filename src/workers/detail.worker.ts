/// <reference lib="webworker" />

import { generateDetailCell } from "@/src/render/webgpu/detail/generation";
import {
  DetailInstanceBounds,
  DetailInstanceWriter,
  type DetailBillboardFrameBounds,
  type DetailInstanceRecord,
} from "@/src/render/webgpu/detail/instanceFormat";
import {
  buildPresentationChunk,
  detailTreeCanopyRankOrder,
  type DetailPresentationBuildCatalog,
  type DetailPresentationBuildSink,
  type DetailPresentationChunkStatistics,
} from "@/src/render/webgpu/detail/presentationBuild";
import {
  TerrainConsumerAuthority,
  terrainConsumerSampleFromAuthority,
  type TerrainConsumerSample,
} from "@/src/render/webgpu/terrain/TerrainConsumerAuthority";
import {
  createWorld,
  sampleTerrain,
  withAirports,
  type WorldDefinition,
} from "@/src/world";
import {
  airfieldStructureExclusionSites,
  type StructureExclusionSite,
} from "@/src/render/webgpu/airfield/StructureExclusion";
import {
  spawnedAirportsOf,
  withSpawnedAirportGround,
} from "@/src/render/webgpu/airfield/SpawnedAirportGround";
import {
  detailWorkerEventTransferables,
  type DetailRetainedCellDescriptor,
  type DetailWorkerCommand,
  type DetailWorkerEvent,
  type DetailWorkerPresentationBatch,
} from "./detailProtocol";

type ScheduleMacrotask = (callback: () => void) => void;
type PostWorkerEvent = (event: DetailWorkerEvent, transferables: Transferable[]) => void;

const DETAIL_PRESENTATION_WORKER_SLICE_UNITS = 4_096;
const DETAIL_PRESENTATION_WORKER_SLICE_MILLISECONDS = 4;
const DETAIL_PRESENTATION_WORKER_CLOCK_INTERVAL_UNITS = 64;
/**
 * A build that has not finished posts a `presentationProgress` heartbeat
 * after its first slice and then at most this often, so the main thread's
 * watchdog can tell a slow build from a hung worker. Ten a second costs a
 * few small messages and keeps the longest silence of a working build far
 * inside the watchdog's two-second floor.
 */
export const DETAIL_WORKER_HEARTBEAT_MILLISECONDS = 100;

interface RetainedDetailCell {
  readonly cell: ReturnType<typeof generateDetailCell>;
  readonly treeCanopyRank: Float32Array;
}

interface WorkerPresentationBatchStorage {
  readonly writer: DetailInstanceWriter;
  readonly bounds: DetailInstanceBounds;
}

interface PendingWorkerPresentationBuild {
  readonly buildId: number;
  readonly batches: Map<string, WorkerPresentationBatchStorage>;
  readonly iterator: Generator<void, DetailPresentationChunkStatistics, void>;
  canceled: boolean;
  /** Unfinished slices run, and work units packed, so far. */
  slices: number;
  units: number;
  lastHeartbeatMilliseconds: number;
}

function nowMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function retainedCellDescriptor(
  token: number,
  cell: ReturnType<typeof generateDetailCell>,
): DetailRetainedCellDescriptor {
  return {
    token,
    key: cell.key,
    cellX: cell.cellX,
    cellZ: cell.cellZ,
    cellSizeMeters: cell.cellSizeMeters,
    minX: cell.minX,
    minZ: cell.minZ,
    maxX: cell.maxX,
    maxZ: cell.maxZ,
    counts: {
      trees: cell.trees.length,
      shrubs: cell.shrubs.length,
      rocks: cell.rocks.length,
      clutter: cell.clutter.length,
      groundCover: cell.groundCover.length,
    },
  };
}

/**
 * Testable worker authority. The browser entry point below is deliberately a
 * tiny transport wrapper so token lifetime, cancellation and transfer lists
 * can be proven under Node without constructing a fake WorkerGlobalScope.
 */
export class DetailWorkerRuntime {
  private world: WorldDefinition | null = null;
  private terrainSample: TerrainConsumerSample | null = null;
  /**
   * Every airport's structure exclusions, rebuilt only when the world changes
   * (`initialize`, `airports`) rather than once per generated cell. Built from
   * the world the worker ALREADY HOLDS, so nothing crosses the message boundary
   * that could arrive stale — and with `seedHash`, the terrain authority the
   * hangars' own siting uses, NOT the seed string's hash.
   */
  private structureSites: readonly StructureExclusionSite[] = [];
  private cellSizeMeters = 512;
  private seaLevelMeters = 0;
  private presentationCatalog: DetailPresentationBuildCatalog | null = null;
  private readonly terrainAuthority = new TerrainConsumerAuthority();
  private readonly retainedCells = new Map<number, RetainedDetailCell>();
  private readonly presentationBuilds = new Map<number, PendingWorkerPresentationBuild>();
  private nextCellToken = 1;

  constructor(
    private readonly postWorkerEvent: PostWorkerEvent,
    private readonly scheduleMacrotask: ScheduleMacrotask = (callback) => {
      setTimeout(callback, 0);
    },
    /** Slice and heartbeat clock; a test seam, like the scheduler. */
    private readonly now: () => number = nowMilliseconds,
  ) {}

  get retainedCellCount(): number {
    return this.retainedCells.size;
  }

  get activePresentationBuildCount(): number {
    return this.presentationBuilds.size;
  }

  handleCommand(command: DetailWorkerCommand): void {
    switch (command.type) {
      case "initialize":
        this.initialize(command);
        return;
      case "airports":
        this.setAirports(command.airports);
        return;
      case "terrainMacro":
        this.terrainAuthority.publishMacro(command.macro);
        return;
      case "terrainPage":
        this.terrainAuthority.publish(command.page);
        return;
      case "terrainAux":
        this.terrainAuthority.publishAuxPage(command.page);
        return;
      case "releaseCell":
        this.retainedCells.delete(command.token);
        return;
      case "buildPresentation":
        this.startPresentationBuild(command);
        return;
      case "cancelPresentation":
        this.cancelPresentationBuild(command.buildId);
        return;
      case "generate":
        this.generate(command);
    }
  }

  private initialize(command: Extract<DetailWorkerCommand, { type: "initialize" }>): void {
    this.terrainAuthority.clear();
    this.cancelAllPresentationBuilds();
    this.retainedCells.clear();
    this.adoptWorld(command.world ?? createWorld(command.worldSeed));
    this.cellSizeMeters = command.cellSizeMeters;
    this.seaLevelMeters = command.seaLevelMeters;
    this.presentationCatalog = command.presentationCatalog ?? null;
    // nextCellToken deliberately does not reset: even an accidental second
    // initialize cannot make a stale main-thread descriptor alias a new cell.
  }

  /**
   * The world's airport list changed: an airport spawned or was retired.
   *
   * **Only the world changes here.** Retained cells are the main thread's to
   * invalidate — it knows which cells intersect the changed airports and
   * releases exactly those tokens — so this does not touch them. Message order
   * is the guarantee: every `generate` posted after this command samples the
   * new world, and one posted before it is a result the main thread has already
   * cancelled.
   */
  private setAirports(
    airports: Extract<DetailWorkerCommand, { type: "airports" }>["airports"],
  ): void {
    if (!this.world) return;
    const next = withAirports(this.world, airports);
    if (next === this.world) return;
    this.adoptWorld(next);
  }

  /** Install a world and everything derived from it, in one place. */
  private adoptWorld(world: WorldDefinition): void {
    this.world = world;
    const analytic = (x: number, z: number) => sampleTerrain(world, x, z);
    // A spawned airport's earthworks are authored, like the home field's, so
    // inside its influence the analytic sample answers here too — the
    // consumer authority only bypasses `world.airport`. No spawned airport:
    // the consumer sampler itself, unchanged.
    this.terrainSample = withSpawnedAirportGround(
      spawnedAirportsOf(world),
      terrainConsumerSampleFromAuthority(world, analytic, this.terrainAuthority),
      analytic,
    );
    // `airports` is absent only on a world built by hand before it existed.
    const airports = world.airports ?? (world.airport ? [world.airport] : []);
    this.structureSites = airfieldStructureExclusionSites(airports, world.seedHash);
  }

  private generate(command: Extract<DetailWorkerCommand, { type: "generate" }>): void {
    let retainedToken: number | null = null;
    try {
      if (!this.world || !this.terrainSample) {
        throw new Error("Detail worker has not been initialized");
      }
      const activeWorld = this.world;
      const cell = generateDetailCell({
        worldSeed: activeWorld.seed,
        cellX: command.cellX,
        cellZ: command.cellZ,
        cellSizeMeters: this.cellSizeMeters,
        densityMultiplier: command.densityMultiplier,
        terrainSample: this.terrainSample,
        seaLevelMeters: this.seaLevelMeters,
        dayOfYear: command.dayOfYear,
        latitudeDegrees: activeWorld.latitudeDegrees,
        // Structures the vegetation must not grow through, every airport's.
        // `generateDetailCell` keeps only the sites whose reach touches this
        // cell, so a cell far from every airport runs no box test at all.
        ...(this.structureSites.length > 0
          ? { structureExclusionSites: this.structureSites }
          : {}),
      });
      if (cell.key !== command.key) {
        throw new Error(`Detail worker generated ${cell.key} for request ${command.key}`);
      }
      if (command.retain) {
        retainedToken = this.allocateCellToken();
        this.retainedCells.set(retainedToken, {
          cell,
          treeCanopyRank: detailTreeCanopyRankOrder(cell.trees),
        });
        this.post({
          type: "retainedCell",
          requestId: command.requestId,
          generation: command.generation,
          key: command.key,
          cell: retainedCellDescriptor(retainedToken, cell),
        });
      } else {
        this.post({
          type: "cell",
          requestId: command.requestId,
          generation: command.generation,
          key: command.key,
          cell,
        });
      }
    } catch (error) {
      if (retainedToken !== null) this.retainedCells.delete(retainedToken);
      this.post({
        type: "error",
        requestId: command.requestId,
        generation: command.generation,
        key: command.key,
        message: error instanceof Error ? error.message : "Detail generation failed",
      });
    }
  }

  private allocateCellToken(): number {
    if (!Number.isSafeInteger(this.nextCellToken)) {
      throw new Error("Detail worker exhausted retained-cell tokens");
    }
    const token = this.nextCellToken;
    this.nextCellToken += 1;
    return token;
  }

  private startPresentationBuild(
    command: Extract<DetailWorkerCommand, { type: "buildPresentation" }>,
  ): void {
    if (this.presentationBuilds.has(command.buildId)) {
      this.post({
        type: "presentationError",
        buildId: command.buildId,
        message: `Detail presentation build ${command.buildId} already exists`,
      });
      return;
    }
    try {
      const catalog = this.presentationCatalog;
      if (!catalog) throw new Error("Detail presentation catalog has not been initialized");
      const residents = command.input.residents.map((resident) => {
        const retained = this.retainedCells.get(resident.token);
        if (!retained) throw new Error(`Missing retained detail cell ${resident.token}`);
        return {
          cell: retained.cell,
          treeCanopyRank: retained.treeCanopyRank,
          lod: resident.lod,
          distance: resident.distance,
        };
      });
      const batches = new Map<string, WorkerPresentationBatchStorage>();
      const sink: DetailPresentationBuildSink = {
        appendInstance: (
          prototypeKey: string,
          record: DetailInstanceRecord,
          billboardFrame?: DetailBillboardFrameBounds,
        ): void => {
          const prototype = catalog.prototypes[prototypeKey];
          if (!prototype) throw new Error(`Missing detail prototype ${prototypeKey}`);
          let batch = batches.get(prototypeKey);
          if (!batch) {
            batch = {
              writer: new DetailInstanceWriter(),
              bounds: new DetailInstanceBounds(),
            };
            batches.set(prototypeKey, batch);
          }
          batch.writer.pushBounded(
            record,
            batch.bounds,
            prototype.boundKernel,
            billboardFrame,
          );
        },
      };
      const task: PendingWorkerPresentationBuild = {
        buildId: command.buildId,
        batches,
        iterator: buildPresentationChunk(
          { ...command.input, residents },
          catalog,
          sink,
        ),
        canceled: false,
        slices: 0,
        units: 0,
        lastHeartbeatMilliseconds: 0,
      };
      this.presentationBuilds.set(command.buildId, task);
      this.schedulePresentationSlice(task);
    } catch (error) {
      this.post({
        type: "presentationError",
        buildId: command.buildId,
        message: error instanceof Error ? error.message : "Detail presentation build failed",
      });
    }
  }

  private schedulePresentationSlice(task: PendingWorkerPresentationBuild): void {
    this.scheduleMacrotask(() => this.runPresentationSlice(task));
  }

  private runPresentationSlice(task: PendingWorkerPresentationBuild): void {
    if (task.canceled || this.presentationBuilds.get(task.buildId) !== task) return;
    const startedAt = this.now();
    let workUnits = 0;
    try {
      while (workUnits < DETAIL_PRESENTATION_WORKER_SLICE_UNITS) {
        const result = task.iterator.next();
        workUnits += 1;
        if (result.done) {
          this.presentationBuilds.delete(task.buildId);
          this.publishPresentationBuild(task, result.value);
          return;
        }
        if (
          workUnits % DETAIL_PRESENTATION_WORKER_CLOCK_INTERVAL_UNITS === 0
          && this.now() - startedAt >= DETAIL_PRESENTATION_WORKER_SLICE_MILLISECONDS
        ) break;
      }
      task.slices += 1;
      task.units += workUnits;
      this.postPresentationHeartbeat(task);
      this.schedulePresentationSlice(task);
    } catch (error) {
      this.presentationBuilds.delete(task.buildId);
      this.post({
        type: "presentationError",
        buildId: task.buildId,
        message: error instanceof Error ? error.message : "Detail presentation build failed",
      });
    }
  }

  /**
   * Only an unfinished slice reaches here: the answer and a cancel both
   * remove the build first, so a build never heartbeats after either, and a
   * result lost in transport still ends in silence the main thread times.
   */
  private postPresentationHeartbeat(task: PendingWorkerPresentationBuild): void {
    const now = this.now();
    if (
      task.slices > 1
      && now - task.lastHeartbeatMilliseconds < DETAIL_WORKER_HEARTBEAT_MILLISECONDS
    ) return;
    task.lastHeartbeatMilliseconds = now;
    this.post({
      type: "presentationProgress",
      buildId: task.buildId,
      slices: task.slices,
      units: task.units,
    });
  }

  private publishPresentationBuild(
    task: PendingWorkerPresentationBuild,
    statistics: DetailPresentationChunkStatistics,
  ): void {
    const batches: DetailWorkerPresentationBatch[] = [];
    for (const [prototypeKey, batch] of task.batches) {
      // `finish()` is a view into power-of-two pooled capacity. Copy once in
      // the worker so the transferred backing store is exactly count*32 and
      // never carries unused capacity across the boundary.
      const bytes = Uint8Array.from(batch.writer.finish());
      batches.push({
        prototypeKey,
        count: batch.writer.count,
        bytes,
        minimum: batch.bounds.minimum(),
        maximum: batch.bounds.maximum(),
      });
    }
    this.post({
      type: "presentation",
      buildId: task.buildId,
      batches,
      statistics,
    });
  }

  private cancelPresentationBuild(buildId: number): void {
    const task = this.presentationBuilds.get(buildId);
    if (!task) return;
    task.canceled = true;
    this.presentationBuilds.delete(buildId);
  }

  private cancelAllPresentationBuilds(): void {
    for (const task of this.presentationBuilds.values()) task.canceled = true;
    this.presentationBuilds.clear();
  }

  private post(event: DetailWorkerEvent): void {
    this.postWorkerEvent(event, detailWorkerEventTransferables(event));
  }
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const workerScope = self as unknown as DedicatedWorkerGlobalScope;
  const runtime = new DetailWorkerRuntime(
    (event, transferables) => workerScope.postMessage(event, transferables),
  );
  workerScope.addEventListener("message", (event: MessageEvent<DetailWorkerCommand>) => {
    runtime.handleCommand(event.data);
  });
}
