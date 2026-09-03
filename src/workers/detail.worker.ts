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
import { createWorld, sampleTerrain, type WorldDefinition } from "@/src/world";
import { airfieldStructureExclusions } from "@/src/render/webgpu/airfield/StructureExclusion";
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
    this.world = command.world ?? createWorld(command.worldSeed);
    const activeWorld = this.world;
    this.terrainSample = terrainConsumerSampleFromAuthority(
      activeWorld,
      (x, z) => sampleTerrain(activeWorld, x, z),
      this.terrainAuthority,
    );
    this.cellSizeMeters = command.cellSizeMeters;
    this.seaLevelMeters = command.seaLevelMeters;
    this.presentationCatalog = command.presentationCatalog ?? null;
    // nextCellToken deliberately does not reset: even an accidental second
    // initialize cannot make a stale main-thread descriptor alias a new cell.
  }

  private generate(command: Extract<DetailWorkerCommand, { type: "generate" }>): void {
    let retainedToken: number | null = null;
    try {
      if (!this.world || !this.terrainSample) {
        throw new Error("Detail worker has not been initialized");
      }
      const activeWorld = this.world;
      // Structures the vegetation must not grow through. Built from the world
      // the worker ALREADY HOLDS, so nothing crosses the message boundary and
      // nothing can arrive stale — and built with `seedHash`, the terrain
      // authority the hangars' own siting uses, NOT the seed string's hash.
      const structureExclusions = activeWorld.airport
        ? airfieldStructureExclusions(activeWorld.airport, activeWorld.seedHash)
        : [];
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
        ...(activeWorld.airport
          ? { structureExclusions, exclusionAirport: activeWorld.airport }
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
    const startedAt = nowMilliseconds();
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
          && nowMilliseconds() - startedAt >= DETAIL_PRESENTATION_WORKER_SLICE_MILLISECONDS
        ) break;
      }
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
