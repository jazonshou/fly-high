import { Buffer as NodeBuffer } from "node:buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  DETAIL_CPU_WRITER_POOL_BYTES_PER_CELL,
  DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_MILLISECONDS,
  DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES,
  WorldDetailRuntime,
  type DetailPresentationRebuildDiagnostics,
} from "../src/render/webgpu/detail/WorldDetailRuntime";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type {
  DetailInstanceBounds,
  DetailInstanceWriter,
} from "../src/render/webgpu/detail/instanceFormat";
import type {
  DetailRetainedCellDescriptor,
  DetailWorkerPresentationResult,
} from "../src/workers/detailProtocol";
import {
  type DetailWorkerCommand,
  type DetailWorkerEvent,
} from "../src/workers/detailProtocol";
import { DetailWorkerRuntime } from "../src/workers/detail.worker";
import { createWorld, sampleTerrain, type WorldDefinition } from "../src/world";

type Listener = EventListenerOrEventListenerObject;

function invokeListener(listener: Listener, event: Event): void {
  if (typeof listener === "function") listener(event);
  else listener.handleEvent(event);
}

/** Browser-worker transport whose scheduler and deliveries are test-controlled. */
class RuntimeWorkerBridge {
  readonly commands: DetailWorkerCommand[] = [];
  readonly transfers: Transferable[][] = [];
  readonly heldPresentationEvents: DetailWorkerEvent[] = [];
  /** Heartbeats are held with the answers, so a held build stays silent. */
  readonly heldProgressEvents: DetailWorkerEvent[] = [];
  readonly heldGenerationEvents: DetailWorkerEvent[] = [];
  holdPresentations = false;
  holdGeneration = false;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tasks: Array<() => void> = [];
  private readonly outbound: DetailWorkerEvent[] = [];
  private readonly workerRuntime = new DetailWorkerRuntime(
    (event) => this.outbound.push(event),
    (callback) => this.tasks.push(callback),
  );
  private terminated = false;

  postMessage(command: DetailWorkerCommand, transfer: Transferable[] = []): void {
    if (this.terminated) throw new Error("Worker bridge is terminated");
    this.commands.push(command);
    this.transfers.push(transfer);
    this.workerRuntime.handleCommand(command);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Runs worker slices and delivers every event not deliberately held. */
  flush(limit = 200_000): void {
    let work = 0;
    while (this.tasks.length > 0 || this.outbound.length > 0) {
      while (this.tasks.length > 0) {
        if (work >= limit) throw new Error("Detail worker bridge did not settle");
        this.tasks.shift()!();
        work += 1;
      }
      const outbound = this.outbound.splice(0);
      for (const event of outbound) {
        if (this.holdPresentations && event.type === "presentation") {
          this.heldPresentationEvents.push(event);
        } else if (this.holdPresentations && event.type === "presentationProgress") {
          this.heldProgressEvents.push(event);
        } else if (this.holdGeneration && event.type === "retainedCell") {
          this.heldGenerationEvents.push(event);
        } else {
          this.emitMessage(event);
        }
      }
    }
  }

  releaseHeldPresentations(
    transform: (event: DetailWorkerEvent) => DetailWorkerEvent = (event) => event,
  ): void {
    const held = this.heldPresentationEvents.splice(0);
    for (const event of held) this.emitMessage(transform(event));
  }

  releaseHeldGeneration(): void {
    const held = this.heldGenerationEvents.splice(0);
    for (const event of held) this.emitMessage(event);
  }

  fail(): void {
    const event = { preventDefault: () => undefined } as unknown as Event;
    for (const listener of [...(this.listeners.get("error") ?? [])]) {
      invokeListener(listener, event);
    }
  }

  private emitMessage(data: unknown): void {
    const event = { data } as unknown as Event;
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      invokeListener(listener, event);
    }
  }
}

/** Minimal controllable worker for exact command-order/token-lifecycle tests. */
class ManualRuntimeWorker {
  readonly commands: DetailWorkerCommand[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  postMessage(command: DetailWorkerCommand): void {
    this.commands.push(command);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}

  emit(data: unknown): void {
    const event = { data } as unknown as Event;
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      invokeListener(listener, event);
    }
  }
}

interface InlineResidentSnapshot {
  readonly source: "inline";
  readonly generation: number;
}

interface WorkerResidentSnapshot {
  readonly source: "worker";
  readonly generation: number;
  readonly descriptor: DetailRetainedCellDescriptor;
  readonly tokenOwned: boolean;
  readonly cell?: never;
}

interface RuntimeInternals {
  readonly cells: Map<string, InlineResidentSnapshot | WorkerResidentSnapshot>;
  readonly batches: Map<string, {
    readonly prototypeKey: string;
    readonly chunkKey: string;
    readonly writer: DetailInstanceWriter;
    readonly bounds: DetailInstanceBounds;
    readonly cullBlocks: Float64Array;
    readonly mesh: { readonly position: { readonly x: number; readonly y: number; readonly z: number } };
  }>;
  readonly presentationChunks: Map<string, {
    readonly batchKeys: Set<string>;
    readonly signature: string;
    readonly revision: number;
    readonly statistics: unknown;
  }>;
  readonly client: unknown | null;
}

function internals(runtime: WorldDetailRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

function profile(vegetationDistance = 60, vegetationDensity = 0.55) {
  return {
    ...resolveWebGpuQualityProfile("medium", "balanced"),
    vegetationDistance,
    vegetationDensity,
    grassRadiusMeters: 36,
  };
}

function richCell(world: WorldDefinition, densityMultiplier: number): {
  readonly cellX: number;
  readonly cellZ: number;
} {
  let best = { cellX: 2, cellZ: 2, count: -1 };
  for (let cellZ = -8; cellZ <= 8; cellZ += 1) {
    for (let cellX = -8; cellX <= 8; cellX += 1) {
      const cell = generateDetailCell({
        worldSeed: world.seed,
        cellX,
        cellZ,
        cellSizeMeters: 128,
        densityMultiplier,
        terrainSample: (x, z) => sampleTerrain(world, x, z),
        seaLevelMeters: world.seaLevel,
        dayOfYear: 0,
        latitudeDegrees: world.latitudeDegrees,
      });
      const count = cell.trees.length + cell.shrubs.length + cell.rocks.length
        + cell.clutter.length + cell.groundCover.length;
      if (count > best.count) best = { cellX, cellZ, count };
      if (cell.trees.length >= 8 && count >= 24) return { cellX, cellZ };
    }
  }
  if (best.count <= 0) throw new Error("Unable to select a populated detail cell");
  return best;
}

function observerForCell(cellX: number, cellZ: number) {
  return {
    x: (cellX + 0.5) * 128,
    y: 140,
    z: (cellZ + 0.5) * 128,
  };
}

const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

function createRuntime(
  scene: Scene,
  world: WorldDefinition,
  options: {
    readonly bridge?: RuntimeWorkerBridge;
    readonly vegetationBudget?: number;
    readonly now?: () => number;
    /** 0 pins today's fallback: a failed worker is not replaced. */
    readonly respawnLimit?: number;
  } = {},
): WorldDetailRuntime {
  const runtime = new WorldDetailRuntime(scene, {
    worldSeed: world.seed,
    terrainSample: (x, z) => sampleTerrain(world, x, z),
    cellSizeMeters: 128,
    seaLevelMeters: world.seaLevel,
    latitudeDegrees: world.latitudeDegrees,
    ...(options.bridge
      ? {
          workerWorldSeed: world.seed,
          workerWorld: world,
          detailWorkerFactory: () => options.bridge as unknown as Worker,
        }
      : {}),
    presentationRebuildBudget: {
      maximumWorkUnits: 1_000_000,
      maximumMilliseconds: 1_000_000,
    },
    ...(options.now ? { presentationNowMilliseconds: options.now } : {}),
    ...(options.respawnLimit !== undefined
      ? { detailWorkerRespawnLimit: options.respawnLimit }
      : {}),
  });
  if (options.vegetationBudget !== undefined) {
    runtime.setGenerationBudgetCap({
      maximumCells: options.vegetationBudget,
      maximumMilliseconds: 1_000_000,
    });
  }
  return runtime;
}

function settleInline(
  runtime: WorldDetailRuntime,
  observer: ReturnType<typeof observerForCell>,
  quality: ReturnType<typeof profile>,
  limit = 128,
): void {
  for (let pass = 0; pass < limit; pass += 1) {
    runtime.update(observer, ORIGIN, quality);
    if (runtime.pendingWorkItems === 0) return;
  }
  throw new Error("Inline detail runtime did not settle");
}

function settleWorker(
  runtime: WorldDetailRuntime,
  bridge: RuntimeWorkerBridge,
  observer: ReturnType<typeof observerForCell>,
  quality: ReturnType<typeof profile>,
  origin: Readonly<{ x: number; y: number; z: number }> = ORIGIN,
  limit = 128,
): void {
  for (let pass = 0; pass < limit; pass += 1) {
    runtime.update(observer, origin, quality);
    bridge.flush();
    if (runtime.pendingWorkItems === 0) return;
  }
  throw new Error("Worker detail runtime did not settle");
}

function publishedSnapshot(runtime: WorldDetailRuntime) {
  const state = internals(runtime);
  return {
    batchOrder: [...state.batches.keys()],
    batches: [...state.batches].map(([key, batch]) => ({
      key,
      prototypeKey: batch.prototypeKey,
      chunkKey: batch.chunkKey,
      count: batch.writer.count,
      bytes: Uint8Array.from(batch.writer.finish()),
      minimum: batch.bounds.minimum(),
      maximum: batch.bounds.maximum(),
      cullBlocks: Array.from(batch.cullBlocks),
    })),
    chunks: [...state.presentationChunks].map(([key, chunk]) => ({
      key,
      batchKeys: [...chunk.batchKeys],
      revision: chunk.revision,
      statistics: chunk.statistics,
    })),
    statistics: runtime.statistics,
  };
}

function latestGenerate(worker: ManualRuntimeWorker) {
  const command = worker.commands.findLast(
    (candidate): candidate is Extract<DetailWorkerCommand, { type: "generate" }> => (
      candidate.type === "generate"
    ),
  );
  if (!command) throw new Error("Missing detail generation command");
  return command;
}

function emitRetained(
  worker: ManualRuntimeWorker,
  command: Extract<DetailWorkerCommand, { type: "generate" }>,
  token: number,
): void {
  worker.emit({
    type: "retainedCell",
    requestId: command.requestId,
    generation: command.generation,
    key: command.key,
    cell: {
      token,
      key: command.key,
      cellX: command.cellX,
      cellZ: command.cellZ,
      cellSizeMeters: 128,
      minX: command.cellX * 128,
      minZ: command.cellZ * 128,
      maxX: (command.cellX + 1) * 128,
      maxZ: (command.cellZ + 1) * 128,
      counts: { trees: 0, shrubs: 0, rocks: 0, clutter: 0, groundCover: 0 },
    },
  });
}

function releaseCommands(worker: ManualRuntimeWorker, token: number): DetailWorkerCommand[] {
  return worker.commands.filter(
    (command) => command.type === "releaseCell" && command.token === token,
  );
}

describe("WorldDetailRuntime retained-worker presentation integration", () => {
  it("owns zero main-thread placements and publishes exact inline-equivalent bytes atomically", () => {
    const world = createWorld("detail-runtime-retained-parity", { airport: false });
    const quality = profile();
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const workerEngine = new NullEngine();
    const workerScene = new Scene(workerEngine);
    const inlineEngine = new NullEngine();
    const inlineScene = new Scene(inlineEngine);
    const bridge = new RuntimeWorkerBridge();
    const workerRuntime = createRuntime(workerScene, world, { bridge });
    const inlineRuntime = createRuntime(inlineScene, world);

    try {
      workerRuntime.update(observer, ORIGIN, quality);
      bridge.flush();
      const workerResidents = [...internals(workerRuntime).cells.values()];
      expect(workerResidents.length).toBeGreaterThan(0);
      expect(workerResidents.every((resident) => (
        resident.source === "worker"
        && resident.tokenOwned
        && !("cell" in resident)
      ))).toBe(true);
      expect(workerRuntime.presentationRebuildDiagnostics.workerRetainedCells)
        .toBe(workerResidents.length);

      // The next update posts one immutable token snapshot. Completion may
      // queue asynchronously, but no live batch changes until a later update.
      workerRuntime.update(observer, ORIGIN, quality);
      const publicationsBeforeResult = workerRuntime.presentationRebuildDiagnostics.publications;
      bridge.flush();
      expect(workerRuntime.presentationRebuildDiagnostics.workerResultsQueued).toBeGreaterThan(0);
      expect(workerRuntime.presentationRebuildDiagnostics.publications)
        .toBe(publicationsBeforeResult);
      expect(internals(workerRuntime).batches.size).toBe(0);
      expect(workerRuntime.pendingWorkItems).toBeGreaterThan(0);

      settleWorker(workerRuntime, bridge, observer, quality);
      settleInline(inlineRuntime, observer, quality);
      const workerSnapshot = publishedSnapshot(workerRuntime);
      const inlineSnapshot = publishedSnapshot(inlineRuntime);
      expect(workerSnapshot.batchOrder).toEqual(inlineSnapshot.batchOrder);
      expect(workerSnapshot.batches).toEqual(inlineSnapshot.batches);
      // Every published batch carries its culling blocks, whichever side
      // accumulated them.
      expect(workerSnapshot.batches.length).toBeGreaterThan(0);
      for (const batch of workerSnapshot.batches) {
        expect(batch.cullBlocks.length).toBeGreaterThan(0);
        expect(batch.cullBlocks.length % 6).toBe(0);
      }
      expect(workerSnapshot.chunks).toEqual(inlineSnapshot.chunks);
      expect(workerSnapshot.statistics).toEqual(inlineSnapshot.statistics);
      expect(workerSnapshot.statistics.treeInstances
        + workerSnapshot.statistics.shrubInstances
        + workerSnapshot.statistics.rockInstances
        + workerSnapshot.statistics.clutterInstances
        + workerSnapshot.statistics.groundCoverInstances).toBeGreaterThan(0);
      expect(workerRuntime.presentationRebuildDiagnostics.workerBuildPublications)
        .toBeGreaterThan(0);
    } finally {
      workerRuntime.dispose();
      inlineRuntime.dispose();
      workerScene.dispose();
      inlineScene.dispose();
      workerEngine.dispose();
      inlineEngine.dispose();
    }
  });

  it("rejects over-envelope, late, and semantically malformed results without partial publication", () => {
    const world = createWorld("detail-runtime-worker-rejection", { airport: false });
    const quality = profile();
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    const runtime = createRuntime(scene, world, { bridge });

    try {
      settleWorker(runtime, bridge, observer, quality);
      const initialPublications = runtime.presentationRebuildDiagnostics.publications;

      bridge.holdPresentations = true;
      const firstBuildObserver = { ...observer, x: observer.x + 64 };
      runtime.update(firstBuildObserver, ORIGIN, quality);
      bridge.flush();
      expect(bridge.heldPresentationEvents).toHaveLength(1);
      expect(runtime.presentationRebuildDiagnostics.activeBuildSource).toBe("worker");

      // Ordinary supersession stays inside the validity envelope. It may
      // finish its immutable older signature once, preventing starvation;
      // the newer target remains backlogged and follows immediately.
      const ordinarySupersession = { ...observer, x: observer.x + 96 };
      runtime.update(ordinarySupersession, ORIGIN, quality);
      bridge.releaseHeldPresentations();
      runtime.update(ordinarySupersession, ORIGIN, quality);
      expect(runtime.presentationRebuildDiagnostics.publications)
        .toBe(initialPublications + 1);
      bridge.holdPresentations = false;
      settleWorker(runtime, bridge, ordinarySupersession, quality);
      const oldSnapshot = publishedSnapshot(runtime);
      const oldPublications = runtime.presentationRebuildDiagnostics.publications;

      bridge.holdPresentations = true;
      const overEnvelopeBuildObserver = { ...observer, x: observer.x + 160 };
      runtime.update(overEnvelopeBuildObserver, ORIGIN, quality);
      bridge.flush();
      expect(bridge.heldPresentationEvents).toHaveLength(1);

      // Defect A fix: drifting >96 m past the in-flight build NO LONGER
      // cancels it — the old cancel/reissue cycle livelocked at speed with
      // the chunk suppressed throughout. The build survives untouched and
      // nothing publishes until its delivery arrives.
      const beyondEnvelope = { ...observer, x: observer.x + 300 };
      runtime.update(beyondEnvelope, ORIGIN, quality);
      expect(bridge.commands.some((command) => command.type === "cancelPresentation"))
        .toBe(false);
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(oldPublications);
      expect(publishedSnapshot(runtime).batches).toEqual(oldSnapshot.batches);

      // Delivery of the drifted result PUBLISHES it — fresher than what is
      // live — records the >96 m publication drift truthfully, and leaves
      // the chunk dirty so the sweep converges on the current observer.
      bridge.releaseHeldPresentations();
      for (
        let pass = 0;
        pass < 64
          && runtime.presentationRebuildDiagnostics.publications === oldPublications;
        pass += 1
      ) {
        runtime.update(beyondEnvelope, ORIGIN, quality);
      }
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(oldPublications + 1);
      expect(runtime.presentationRebuildDiagnostics.lastPublicationObserverDriftMeters)
        .toBeGreaterThan(DETAIL_MEMBERSHIP_SLACK_METERS);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);

      // Settle the current observer, then inject a wire-valid result whose
      // packed records are truncated relative to its authored statistics.
      // The client accepts the shape; the runtime semantic authority must
      // terminate that worker path before adopting any transferred writer.
      bridge.holdPresentations = false;
      settleWorker(runtime, bridge, beyondEnvelope, quality);
      const completeSnapshot = publishedSnapshot(runtime);
      const completePublications = runtime.presentationRebuildDiagnostics.publications;
      bridge.holdPresentations = true;
      const malformedObserver = { ...beyondEnvelope, z: beyondEnvelope.z + 64 };
      runtime.update(malformedObserver, ORIGIN, quality);
      bridge.flush();
      expect(bridge.heldPresentationEvents).toHaveLength(1);
      const heldResult = bridge.heldPresentationEvents[0];
      if (heldResult?.type !== "presentation" || heldResult.batches.length < 2) {
        throw new Error("Alias guard fixture requires two worker presentation batches");
      }
      const sharedBytes = new Uint8Array(32);
      const aliasedResult: DetailWorkerPresentationResult = {
        buildId: heldResult.buildId,
        batches: heldResult.batches.slice(0, 2).map((batch) => ({
          ...batch,
          count: 1,
          bytes: sharedBytes,
        })),
        statistics: {
          ...heldResult.statistics,
          treeInstances: 0,
          shrubInstances: 0,
          rockInstances: 0,
          clutterInstances: 0,
          groundCoverInstances: 2,
        },
      };
      const privateRuntime = runtime as unknown as {
        readonly pendingPresentationBuild: {
          readonly stagedBatches: Map<string, unknown>;
        };
        rehydrateWorkerPresentationResult(
          build: unknown,
          result: DetailWorkerPresentationResult,
        ): unknown;
      };
      expect(() => privateRuntime.rehydrateWorkerPresentationResult(
        privateRuntime.pendingPresentationBuild,
        aliasedResult,
      )).toThrow("unique transferred buffers");
      expect(privateRuntime.pendingPresentationBuild.stagedBatches.size).toBe(0);

      // Records that are not one exact packed buffer are refused before any
      // CPU writer is taken from the pool or made.
      const before = runtime.presentationRebuildDiagnostics;
      const [firstBatch, ...otherBatches] = heldResult.batches;
      const padded = new Uint8Array(new ArrayBuffer(firstBatch!.bytes.byteLength + 32), 32);
      padded.set(firstBatch!.bytes);
      expect(() => privateRuntime.rehydrateWorkerPresentationResult(
        privateRuntime.pendingPresentationBuild,
        { ...heldResult, batches: [{ ...firstBatch!, bytes: padded }, ...otherBatches] },
      )).toThrow("exact packed buffer");
      expect(runtime.presentationRebuildDiagnostics.cpuWriterAllocations)
        .toBe(before.cpuWriterAllocations);
      expect(runtime.presentationRebuildDiagnostics.cpuWriterPoolHits)
        .toBe(before.cpuWriterPoolHits);

      // A batch that fails after storage was taken for it (here, its bounds)
      // hands back every pair the result took: nothing staged, nothing lost.
      expect(() => privateRuntime.rehydrateWorkerPresentationResult(
        privateRuntime.pendingPresentationBuild,
        {
          ...heldResult,
          batches: heldResult.batches.map((batch, index) => (
            index === 1 ? { ...batch, minimum: [Number.NaN, 0, 0] as const } : batch
          )),
        },
      )).toThrow("finite and ordered");
      expect(privateRuntime.pendingPresentationBuild.stagedBatches.size).toBe(0);
      const after = runtime.presentationRebuildDiagnostics;
      expect(after.cpuWriterPoolHits + after.cpuWriterAllocations)
        .toBe(before.cpuWriterPoolHits + before.cpuWriterAllocations + 2);
      expect(after.pooledCpuBatchStorage).toBe(
        before.pooledCpuBatchStorage + after.cpuWriterAllocations - before.cpuWriterAllocations,
      );

      bridge.releaseHeldPresentations((event) => {
        if (event.type !== "presentation" || event.batches.length === 0) return event;
        const originalRecords = event.batches.reduce((sum, batch) => sum + batch.count, 0);
        return {
          ...event,
          batches: event.batches.map((batch) => ({
            ...batch,
            count: 1,
            bytes: batch.bytes.slice(0, 32),
          })),
          statistics: {
            ...event.statistics,
            groundCoverInstances:
              event.statistics.groundCoverInstances + originalRecords + 1,
          },
        };
      });
      runtime.update(malformedObserver, ORIGIN, quality);
      expect(runtime.presentationRebuildDiagnostics.workerBuildRejections).toBeGreaterThan(0);
      expect(runtime.presentationRebuildDiagnostics.workerFallbacks).toBeGreaterThan(0);
      expect(internals(runtime).client).toBeNull();
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(completePublications);
      expect(publishedSnapshot(runtime).batches).toEqual(completeSnapshot.batches);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("preserves complete worker chunks through failure and replaces mixed groups only when complete", () => {
    const world = createWorld("detail-runtime-worker-fallback", { airport: false });
    const quality = profile(170);
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    const runtime = createRuntime(scene, world, { bridge, respawnLimit: 0 });

    try {
      settleWorker(runtime, bridge, observer, quality);
      const state = internals(runtime);
      const residentsByChunk = Map.groupBy(
        [...state.cells.entries()],
        ([key]) => {
          const [cellX, cellZ] = key.split(":").map(Number);
          return `${Math.floor(cellX! / 8)}:${Math.floor(cellZ! / 8)}`;
        },
      );
      const target = [...residentsByChunk.entries()]
        .sort((first, second) => second[1].length - first[1].length)[0];
      expect(target?.[1].length).toBeGreaterThan(1);
      const [targetChunkKey, targetResidents] = target!;
      const oldChunk = state.presentationChunks.get(targetChunkKey)!;
      const oldRevision = oldChunk.revision;
      const oldBatches = publishedSnapshot(runtime).batches.filter(
        (batch) => batch.chunkKey === targetChunkKey,
      );

      runtime.setGenerationBudgetCap({ maximumCells: 1, maximumMilliseconds: 1_000_000 });
      bridge.fail();
      expect(internals(runtime).client).toBeNull();
      expect([...state.cells.values()].every((resident) => (
        resident.source === "worker" && !resident.tokenOwned
      ))).toBe(true);

      runtime.update(observer, ORIGIN, quality);
      const inlineKeysAfterOne = new Set(
        [...state.cells].filter(([, resident]) => resident.source === "inline").map(([key]) => key),
      );
      const targetInlineAfterOne = targetResidents.filter(([key]) => inlineKeysAfterOne.has(key));
      expect(targetInlineAfterOne.length).toBeGreaterThan(0);
      expect(targetInlineAfterOne.length).toBeLessThan(targetResidents.length);
      expect(state.presentationChunks.get(targetChunkKey)!.revision).toBe(oldRevision);
      expect(publishedSnapshot(runtime).batches.filter(
        (batch) => batch.chunkKey === targetChunkKey,
      )).toEqual(oldBatches);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);

      // After a worker failure inline cells run on credit, a few updates apart.
      for (let pass = 0; pass < 8_192 && runtime.pendingWorkItems > 0; pass += 1) {
        runtime.update(observer, ORIGIN, quality);
      }
      expect(runtime.pendingWorkItems).toBe(0);
      expect([...state.cells.values()].every((resident) => resident.source === "inline"))
        .toBe(true);
      expect(state.presentationChunks.get(targetChunkKey)!.revision).toBeGreaterThan(oldRevision);
      expect(publishedSnapshot(runtime).batches.filter(
        (batch) => batch.chunkKey === targetChunkKey,
      )).toEqual(oldBatches);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("times out held presentation authority under >96 m motion without drift-cancel churn", () => {
    const world = createWorld("detail-runtime-worker-watchdog", { airport: false });
    const quality = profile(170);
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    let now = 0;
    const runtime = createRuntime(scene, world, { bridge, now: () => now, respawnLimit: 0 });

    try {
      settleWorker(runtime, bridge, observer, quality);
      const state = internals(runtime);
      const targetChunkKey = `${Math.floor(selected.cellX / 8)}:${Math.floor(selected.cellZ / 8)}`;
      const oldRevision = state.presentationChunks.get(targetChunkKey)!.revision;
      const oldBatches = publishedSnapshot(runtime).batches.filter(
        (batch) => batch.chunkKey === targetChunkKey,
      );
      expect(oldBatches.length).toBeGreaterThan(0);
      const oldPublications = runtime.presentationRebuildDiagnostics.publications;
      runtime.setGenerationBudgetCap({ maximumCells: 1, maximumMilliseconds: 1_000_000 });
      bridge.holdPresentations = true;
      const movedObserver = { ...observer, x: observer.x + 64 };
      runtime.update(movedObserver, ORIGIN, quality);
      bridge.flush();
      expect(bridge.heldPresentationEvents).toHaveLength(1);
      expect(runtime.presentationRebuildDiagnostics.activeBuildSource).toBe("worker");
      bridge.heldPresentationEvents.length = 0;

      // 100 Hz: the update count expires together with its two-second floor.
      for (let update = 0; update < DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES; update += 1) {
        const movingObserver = {
          ...observer,
          x: observer.x + (update % 2 === 0 ? -64 : 64),
        };
        now += 10;
        runtime.update(movingObserver, ORIGIN, quality);
        bridge.flush();
        if (internals(runtime).client === null) break;
        // Drop any transport-held payload without delivering it. Defect A
        // fix: the >96 m observer motion no longer cancels/reissues — the
        // one held build stays pending until the authority watchdog expires.
        bridge.heldPresentationEvents.length = 0;
      }
      expect(internals(runtime).client).toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerBuildTimeouts).toBe(1);
      expect(runtime.presentationRebuildDiagnostics.workerFallbacks).toBeGreaterThan(0);
      // Exactly ONE cancel: the watchdog's fail-close. Motion contributed
      // zero cancel/reissue churn (the old policy posted a pair per >96 m
      // swing, which is what livelocked real flights).
      expect(bridge.commands.filter((command) => command.type === "cancelPresentation").length)
        .toBe(1);
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(oldPublications);
      expect(state.presentationChunks.get(targetChunkKey)!.revision).toBe(oldRevision);
      expect(publishedSnapshot(runtime).batches.filter(
        (batch) => batch.chunkKey === targetChunkKey,
      )).toEqual(oldBatches);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("times out held retained-cell generation and regenerates boundedly inline", () => {
    const world = createWorld("detail-runtime-generation-watchdog", { airport: false });
    const quality = profile(170);
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    let now = 0;
    const runtime = createRuntime(scene, world, { bridge, now: () => now, respawnLimit: 0 });

    try {
      settleWorker(runtime, bridge, observer, quality);
      const state = internals(runtime);
      const residentsByChunk = Map.groupBy(
        [...state.cells.entries()],
        ([key]) => {
          const [cellX, cellZ] = key.split(":").map(Number);
          return `${Math.floor(cellX! / 8)}:${Math.floor(cellZ! / 8)}`;
        },
      );
      const target = [...residentsByChunk.entries()]
        .sort((first, second) => second[1].length - first[1].length)[0];
      expect(target?.[1].length).toBeGreaterThan(1);
      const [targetChunkKey] = target!;
      const oldRevision = state.presentationChunks.get(targetChunkKey)!.revision;
      const oldBatches = publishedSnapshot(runtime).batches.filter(
        (batch) => batch.chunkKey === targetChunkKey,
      );
      runtime.setGenerationBudgetCap({ maximumCells: 1, maximumMilliseconds: 1_000_000 });
      bridge.holdGeneration = true;
      runtime.setDayOfYear(40);
      runtime.update(observer, ORIGIN, quality);
      bridge.flush();
      expect(bridge.heldGenerationEvents).toHaveLength(1);
      expect([...state.cells.values()].every((resident) => (
        resident.source === "worker" && !resident.tokenOwned
      ))).toBe(true);

      // The deadline runs from the first update that finds the request
      // outstanding: the one after the update that filed it. At 100 Hz the
      // update count expires together with its two-second floor.
      for (
        let update = 0;
        update <= DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES;
        update += 1
      ) {
        now += 10;
        runtime.update(observer, ORIGIN, quality);
        bridge.flush();
        if (internals(runtime).client === null) break;
      }
      expect(internals(runtime).client).toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerGenerationTimeouts).toBe(1);
      expect(runtime.presentationRebuildDiagnostics.workerFallbacks).toBeGreaterThan(0);
      expect([...state.cells.values()].filter((resident) => resident.source === "inline"))
        .toHaveLength(1);
      expect(state.presentationChunks.get(targetChunkKey)!.revision).toBe(oldRevision);
      expect(publishedSnapshot(runtime).batches.filter(
        (batch) => batch.chunkKey === targetChunkKey,
      )).toEqual(oldBatches);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);

      // Delivery after client teardown has no listener and cannot resurrect
      // worker ownership or reset the already-entered inline fallback.
      bridge.releaseHeldGeneration();
      expect(internals(runtime).client).toBeNull();
      // After a worker failure inline cells run on credit, a few updates apart.
      for (let update = 0; update < 8_192 && runtime.pendingWorkItems > 0; update += 1) {
        runtime.update(observer, ORIGIN, quality);
      }
      expect(runtime.pendingWorkItems).toBe(0);
      expect([...state.cells.values()].every((resident) => resident.source === "inline"))
        .toBe(true);
      expect(state.presentationChunks.get(targetChunkKey)!.revision).toBeGreaterThan(oldRevision);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("does not charge a span without updates (a hidden tab) to the generation worker", () => {
    const world = createWorld("detail-runtime-generation-hidden-tab", { airport: false });
    const quality = profile(170);
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    let now = 0;
    const runtime = createRuntime(scene, world, { bridge, now: () => now });

    try {
      settleWorker(runtime, bridge, observer, quality);
      runtime.setGenerationBudgetCap({ maximumCells: 1, maximumMilliseconds: 1_000_000 });
      bridge.holdGeneration = true;
      runtime.setDayOfYear(40);
      runtime.update(observer, ORIGIN, quality);
      bridge.flush();
      expect(bridge.heldGenerationEvents).toHaveLength(1);

      // A minute in another tab: no updates, so no frame could have taken
      // the worker's answer.
      now += 60_000;
      runtime.update(observer, ORIGIN, quality);
      bridge.flush();
      expect(internals(runtime).client).not.toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerGenerationTimeouts).toBe(0);

      // A worker that answers keeps the authority.
      bridge.releaseHeldGeneration();
      bridge.holdGeneration = false;
      settleWorker(runtime, bridge, observer, quality);
      expect(internals(runtime).client).not.toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerFallbacks).toBe(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("still falls back when the worker stops answering while frames run", () => {
    const world = createWorld("detail-runtime-generation-hidden-tab", { airport: false });
    const quality = profile(170);
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    let now = 0;
    const runtime = createRuntime(scene, world, { bridge, now: () => now, respawnLimit: 0 });

    try {
      settleWorker(runtime, bridge, observer, quality);
      runtime.setGenerationBudgetCap({ maximumCells: 1, maximumMilliseconds: 1_000_000 });
      bridge.holdGeneration = true;
      runtime.setDayOfYear(40);
      runtime.update(observer, ORIGIN, quality);
      bridge.flush();
      // 50 ms frames (inside the gap allowance): the clock deadline, well
      // before the update count, finds the hung worker.
      let updates = 0;
      while (internals(runtime).client !== null && updates < 1_000) {
        now += 50;
        runtime.update(observer, ORIGIN, quality);
        bridge.flush();
        updates += 1;
      }
      expect(internals(runtime).client).toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerGenerationTimeouts).toBe(1);
      expect(updates).toBeLessThan(DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES);
      expect(updates * 50).toBeGreaterThanOrEqual(DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_MILLISECONDS);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("times a worker that has not answered yet (still building its world) by the clock, not by updates", () => {
    const world = createWorld("detail-runtime-generation-initializing", { airport: false });
    const quality = profile(170);
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    bridge.holdGeneration = true;
    let now = 0;
    const runtime = createRuntime(scene, world, { bridge, now: () => now });

    try {
      // Two seconds of a 120 Hz display: more updates than the count allows.
      for (let update = 0; update < DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES + 16; update += 1) {
        now += 1_000 / 120;
        runtime.update(observer, ORIGIN, quality);
        bridge.flush();
      }
      expect(bridge.heldGenerationEvents.length).toBeGreaterThan(0);
      expect(internals(runtime).client).not.toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerGenerationTimeouts).toBe(0);

      bridge.releaseHeldGeneration();
      bridge.holdGeneration = false;
      settleWorker(runtime, bridge, observer, quality, ORIGIN, 512);
      expect(internals(runtime).client).not.toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerFallbacks).toBe(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("compensates old worker bytes immediately across origin changes and republishes at the new origin", () => {
    const world = createWorld("detail-runtime-worker-origin", { airport: false });
    const quality = profile();
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    const runtime = createRuntime(scene, world, { bridge });

    try {
      settleWorker(runtime, bridge, observer, quality);
      const state = internals(runtime);
      const batchEntries = [...state.batches.entries()];
      expect(batchEntries.length).toBeGreaterThan(0);
      const batchObjects = batchEntries.map(([, batch]) => batch);
      const oldBytes = batchEntries.map(([, batch]) => Uint8Array.from(batch.writer.finish()));
      const oldPublications = runtime.presentationRebuildDiagnostics.publications;
      const rebasedOrigin = { x: 512, y: 30, z: -256 };

      bridge.holdPresentations = true;
      runtime.update(observer, rebasedOrigin, quality);
      expect([...state.batches.values()]).toEqual(batchObjects);
      for (const [index, [, batch]] of batchEntries.entries()) {
        expect(batch.writer.finish()).toEqual(oldBytes[index]);
        expect(batch.mesh.position).toMatchObject({ x: -512, y: -30, z: 256 });
      }
      bridge.flush();
      expect(bridge.heldPresentationEvents).toHaveLength(1);
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(oldPublications);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);

      bridge.holdPresentations = false;
      bridge.releaseHeldPresentations();
      runtime.update(observer, rebasedOrigin, quality);
      expect(runtime.presentationRebuildDiagnostics.publications).toBeGreaterThan(oldPublications);
      for (const batch of state.batches.values()) {
        expect(batch.mesh.position).toMatchObject({ x: 0, y: 0, z: 0 });
      }
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("copies transferred batches into pooled writers: exact bytes, one owner each, no allocation once warm", () => {
    const world = createWorld("detail-runtime-worker-copy", { airport: false });
    const quality = profile();
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    const runtime = createRuntime(scene, world, { bridge });
    type Writer = DetailInstanceWriter;
    const state = runtime as unknown as {
      readonly batches: Map<string, {
        readonly writer: Writer;
        readonly mesh: { getVertexBuffer(kind: string): { getData(): unknown } | null };
      }>;
      readonly retiredBatches: readonly { readonly batch: { readonly writer: Writer } }[];
      readonly detailBuildStoragePool: readonly { readonly writer: Writer }[];
      readonly pendingPresentationBuild: {
        readonly stagedBatches: Map<string, { readonly writer: Writer }>;
      } | null;
      readonly pendingPublication: { readonly uploads: readonly { readonly writer: Writer }[] } | null;
      readonly instanceBufferPool: readonly { readonly gpu: { readonly shared: { getData(): unknown } } }[];
      readonly presentationChunks: Map<string, unknown>;
    };
    // Every writer has exactly one owner, so none is overwritten while read.
    const ownedWriters = (): Writer[] => {
      const owned = [
        ...[...state.batches.values()].map((batch) => batch.writer),
        ...state.retiredBatches.map((retired) => retired.batch.writer),
        ...state.detailBuildStoragePool.map((entry) => entry.writer),
        ...[...(state.pendingPresentationBuild?.stagedBatches.values() ?? [])]
          .map((staged) => staged.writer),
        ...(state.pendingPublication?.uploads ?? []).map((upload) => upload.writer),
      ];
      expect(new Set(owned).size, "a CPU writer has two owners").toBe(owned.length);
      return owned;
    };

    try {
      settleWorker(runtime, bridge, observer, quality);
      expect(state.presentationChunks.size).toBe(1);
      const chunkKey = [...state.presentationChunks.keys()][0]!;
      // Each rebase republishes the same footprint with every record moved.
      const origins = [{ x: 512, y: 30, z: -256 }, ORIGIN];
      let warm: DetailPresentationRebuildDiagnostics | null = null;
      let batchCount = 0;
      for (let republish = 0; republish < 24; republish += 1) {
        const origin = origins[republish % 2]!;
        const publicationsBefore = runtime.presentationRebuildDiagnostics.publications;
        bridge.holdPresentations = true;
        runtime.update(observer, origin, quality);
        bridge.flush();
        expect(bridge.heldPresentationEvents).toHaveLength(1);
        const event = bridge.heldPresentationEvents[0]!;
        if (event.type !== "presentation") throw new Error("expected a presentation");
        bridge.holdPresentations = false;
        bridge.releaseHeldPresentations();
        settleWorker(runtime, bridge, observer, quality, origin);
        expect(runtime.presentationRebuildDiagnostics.publications).toBe(publicationsBefore + 1);

        batchCount = event.batches.length;
        expect(batchCount).toBeGreaterThan(1);
        for (const transferred of event.batches) {
          const live = state.batches.get(`${transferred.prototypeKey}@${chunkKey}`)!;
          // The GPU-bound bytes are the transferred bytes, byte for byte,
          // held in the runtime's own buffer rather than the transferred one.
          expect(live.writer.finish()).toEqual(transferred.bytes);
          expect(live.writer.finish().buffer).not.toBe(transferred.bytes.buffer);
          expect(live.mesh.getVertexBuffer("instancePosition")?.getData())
            .toEqual(transferred.bytes);
        }
        ownedWriters();
        if (republish === 3) warm = runtime.presentationRebuildDiagnostics;
      }

      const diagnostics = runtime.presentationRebuildDiagnostics;
      expect(warm).not.toBeNull();
      expect(diagnostics.cpuWriterAllocations).toBe(warm!.cpuWriterAllocations);
      expect(diagnostics.cpuWriterPoolHits - warm!.cpuWriterPoolHits).toBe(20 * batchCount);
      expect(diagnostics.cpuWriterPoolDrops).toBe(0);
      expect(diagnostics.pooledCpuBatchStorageBytes).toBe(
        state.detailBuildStoragePool.reduce((bytes, entry) => bytes + entry.writer.capacityBytes, 0),
      );
      expect(diagnostics.pooledCpuBatchStorageBytes)
        .toBeLessThanOrEqual(128 * DETAIL_CPU_WRITER_POOL_BYTES_PER_CELL);

      // Leaving retires the chunk. After the grace window its allocations
      // recycle with no CPU mirror left, and its writers come back to the
      // pool (or straight into new work): owned once, never dropped.
      const departed = [...state.batches.values()].map((batch) => batch.writer);
      const away = observerForCell(selected.cellX + 40, selected.cellZ + 40);
      for (let pass = 0; pass < 16; pass += 1) {
        runtime.update(away, ORIGIN, quality);
        bridge.flush();
      }
      expect(state.retiredBatches).toHaveLength(0);
      expect(state.instanceBufferPool.length).toBeGreaterThan(0);
      expect(state.instanceBufferPool.every((pooled) => pooled.gpu.shared.getData() === null))
        .toBe(true);
      const owned = new Set(ownedWriters());
      expect(departed.every((writer) => owned.has(writer))).toBe(true);
      expect(runtime.presentationRebuildDiagnostics.cpuWriterPoolDrops).toBe(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("hands the GPU the built bytes while pooled writers are reused mid-flight, worker and inline", () => {
    // The device's view: a shadow of every dynamic vertex buffer, written
    // exactly as WebGPU's writeBuffer would be (offset, then the whole view
    // or byteLength). `getData()` is only Babylon's CPU mirror, so it cannot
    // tell what the GPU received.
    const engine = new NullEngine();
    const device = engine as unknown as {
      createDynamicVertexBuffer(data: ArrayBufferView | number, label?: string): object;
      updateDynamicVertexBuffer(
        buffer: object,
        data: ArrayBufferView,
        byteOffset?: number,
        byteLength?: number,
      ): void;
    };
    const shadows = new Map<object, Uint8Array>();
    const createBuffer = device.createDynamicVertexBuffer.bind(engine);
    device.createDynamicVertexBuffer = (data, label) => {
      const buffer = createBuffer(data, label);
      shadows.set(buffer, typeof data === "number"
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
      return buffer;
    };
    device.updateDynamicVertexBuffer = (buffer, data, byteOffset = 0, byteLength) => {
      const shadow = shadows.get(buffer);
      const length = byteLength ?? data.byteLength;
      if (!shadow || byteOffset + length > shadow.byteLength) throw new Error("write outside a GPU buffer");
      shadow.set(new Uint8Array(data.buffer, data.byteOffset, length), byteOffset);
    };

    const world = createWorld("detail-runtime-worker-gpu-shadow", { airport: false });
    const quality = profile();
    const selected = richCell(world, quality.vegetationDensity);
    const start = observerForCell(selected.cellX, selected.cellZ);
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    // No respawn: failing the worker below hands every build to the inline
    // builder, whose writers are sized before their records are known.
    const runtime = createRuntime(scene, world, { bridge, respawnLimit: 0 });
    type Writer = DetailInstanceWriter;
    type Allocation = { readonly shared: { getBuffer(): object | null; getData(): unknown } };
    type Batch = {
      readonly prototypeKey: string;
      readonly writer: Writer;
      readonly gpu: Allocation | null;
      readonly mesh: { isEnabled(): boolean; readonly forcedInstanceCount: number };
    };
    const state = runtime as unknown as {
      publicationStreamBytesPerUpdate: number;
      readonly batches: Map<string, Batch>;
      readonly retiredBatches: readonly { readonly batch: Batch }[];
      readonly detailBuildStoragePool: readonly { readonly writer: Writer }[];
      readonly instanceBufferPool: readonly { readonly gpu: Allocation }[];
      readonly pendingPresentationBuild: {
        readonly buildId: number;
        readonly coordinates: { readonly key: string };
        readonly stagedBatches: Map<string, { readonly writer: Writer }>;
      } | null;
      readonly pendingPublication: {
        readonly uploads: readonly {
          readonly kind: "fits" | "create" | "grow";
          readonly writer: Writer;
          readonly packed: Uint8Array;
          readonly streamedBytes: number;
          readonly stagedBatch: Batch | null;
        }[];
      } | null;
      readonly presentationChunks: Map<string, {
        readonly revision: number;
        readonly batchKeys: Set<string>;
      }>;
    };
    // 4 KiB per update streams a chunk's create and grow uploads over many
    // updates, so ownership and GPU bytes are checked mid-stream too.
    state.publicationStreamBytesPerUpdate = 4_096;

    // What the worker transferred for each chunk's latest build, copied as
    // it arrives (the runtime keeps no reference to these bytes).
    const transferred = new Map<string, Map<string, Uint8Array>>();
    bridge.addEventListener("message", (event) => {
      const data = (event as MessageEvent<DetailWorkerEvent>).data;
      const build = state.pendingPresentationBuild;
      if (data.type !== "presentation" || build?.buildId !== data.buildId) return;
      transferred.set(build.coordinates.key, new Map(
        data.batches.map((batch) => [batch.prototypeKey, batch.bytes.slice()]),
      ));
    });

    const same = (first: Uint8Array, second: Uint8Array): boolean =>
      NodeBuffer.from(first.buffer, first.byteOffset, first.byteLength)
        .equals(NodeBuffer.from(second.buffer, second.byteOffset, second.byteLength));
    const shadowOf = (allocation: Allocation, byteLength: number): Uint8Array | null => {
      const buffer = allocation.shared.getBuffer();
      return buffer ? shadows.get(buffer)?.subarray(0, byteLength) ?? null : null;
    };
    const failures: string[] = [];
    const fail = (message: string) => {
      if (failures.length < 8) failures.push(message);
    };
    const everLive = new WeakSet<Writer>();
    const seen = { create: 0, grow: 0, fits: 0, midStream: 0, midStreamReused: 0, flips: 0, checks: 0 };

    const check = (update: number) => {
      const live = [...state.batches.values()];
      const uploads = state.pendingPublication?.uploads ?? [];
      // One owner per writer, the pending publication's streaming uploads
      // included; a pooled writer shares no storage with an owned one.
      const owned = [
        ...live.map((batch) => batch.writer),
        ...state.retiredBatches.map((retired) => retired.batch.writer),
        ...[...(state.pendingPresentationBuild?.stagedBatches.values() ?? [])]
          .map((staged) => staged.writer),
        ...uploads.map((upload) => upload.writer),
      ];
      if (new Set(owned).size !== owned.length) fail(`update ${update}: a writer has two owners`);
      const ownedStorage = new Set(owned.map((writer) => writer.finish().buffer));
      const pooledStorage = new Set(
        state.detailBuildStoragePool.map((entry) => entry.writer.finish().buffer),
      );
      for (const storage of pooledStorage) {
        if (ownedStorage.has(storage)) fail(`update ${update}: a pooled writer is still owned`);
      }
      // Babylon's mirror of any allocation never points into a pooled writer,
      // and a recycled allocation keeps none.
      const allocations = [
        ...live,
        ...state.retiredBatches.map((retired) => retired.batch),
        ...uploads.flatMap((upload) => (upload.stagedBatch ? [upload.stagedBatch] : [])),
      ].flatMap((batch) => (batch.gpu ? [batch.gpu] : []));
      for (const allocation of allocations) {
        const mirror = allocation.shared.getData() as Uint8Array | null;
        if (mirror && pooledStorage.has(mirror.buffer)) {
          fail(`update ${update}: _data aliases a pooled writer`);
        }
      }
      if (state.instanceBufferPool.some((pooled) => pooled.gpu.shared.getData() !== null)) {
        fail(`update ${update}: a recycled allocation kept its _data`);
      }

      // Every drawn batch's GPU bytes are its writer's records.
      for (const batch of live) {
        everLive.add(batch.writer);
        if (!batch.gpu || !batch.mesh.isEnabled() || batch.mesh.forcedInstanceCount === 0) continue;
        const records = batch.writer.finish();
        const gpu = shadowOf(batch.gpu, records.byteLength);
        seen.checks += 1;
        if (!gpu || !same(gpu, records)) fail(`update ${update}: GPU bytes differ from the live writer`);
        const mirror = batch.gpu.shared.getData() as Uint8Array | null;
        if (mirror && !same(mirror, records)) fail(`update ${update}: _data differs from the live writer`);
      }
      // Mid-stream, the slices already sent are what the writer still holds.
      for (const upload of uploads) {
        seen[upload.kind] += 1;
        const records = upload.writer.finish();
        if (upload.packed.buffer !== records.buffer || !same(upload.packed, records)) {
          fail(`update ${update}: a streaming writer changed under its upload`);
        }
        const gpu = upload.stagedBatch?.gpu;
        if (!gpu || upload.streamedBytes === 0) continue;
        const sent = shadowOf(gpu, upload.streamedBytes);
        if (!sent || !same(sent, records.subarray(0, upload.streamedBytes))) {
          fail(`update ${update}: streamed GPU slices differ from the writer`);
        }
        if (upload.streamedBytes < upload.packed.byteLength) {
          seen.midStream += 1;
          if (everLive.has(upload.writer)) seen.midStreamReused += 1;
        }
      }
    };
    // A flipped chunk's GPU bytes are, batch for batch, what was transferred.
    const checkFlips = (update: number, revisions: ReadonlyMap<string, number>) => {
      for (const [chunkKey, chunk] of state.presentationChunks) {
        // A chunk first seen this update starts unpublished, at revision 0.
        if (chunk.revision === (revisions.get(chunkKey) ?? 0)) continue;
        const expected = transferred.get(chunkKey);
        if (!expected) continue;
        seen.flips += 1;
        if (chunk.batchKeys.size !== expected.size) fail(`update ${update}: published batch set differs`);
        for (const batchKey of chunk.batchKeys) {
          const batch = state.batches.get(batchKey)!;
          const bytes = expected.get(batch.prototypeKey);
          const gpu = batch.gpu && bytes ? shadowOf(batch.gpu, bytes.byteLength) : null;
          if (!bytes || !gpu || !same(gpu, bytes)) fail(`update ${update}: GPU bytes differ from the transfer`);
        }
        transferred.delete(chunkKey);
      }
    };

    try {
      // Settle, then fly three chunks east and back: chunks are created,
      // grow as they come near, rebuild in place and retire, so retired
      // writers return to the pool and are taken again while uploads stream.
      let update = 0;
      const step = (observer: { x: number; y: number; z: number }, velocityX: number) => {
        const revisions = new Map(
          [...state.presentationChunks].map(([key, chunk]) => [key, chunk.revision]),
        );
        runtime.update({ ...observer, velocityX, velocityZ: 0 }, ORIGIN, quality);
        bridge.flush();
        check(update);
        checkFlips(update, revisions);
        update += 1;
      };
      const fly = () => {
        for (let pass = 0; pass < 600 && (pass < 8 || runtime.pendingWorkItems > 0); pass += 1) {
          step(start, 0);
        }
        for (const direction of [1, -1]) {
          for (let pass = 0; pass < 320; pass += 1) {
            const along = direction > 0 ? pass * 10 : (320 - pass) * 10;
            step({ ...start, x: start.x + along }, direction * 600);
          }
        }
        for (let pass = 0; pass < 600 && runtime.pendingWorkItems > 0; pass += 1) step(start, 0);
      };

      fly();
      expect(failures).toEqual([]);
      // The flight exercised what the bytes must survive.
      expect(seen.create).toBeGreaterThan(0);
      expect(seen.grow).toBeGreaterThan(0);
      expect(seen.fits).toBeGreaterThan(0);
      expect(seen.midStream).toBeGreaterThan(0);
      expect(seen.midStreamReused).toBeGreaterThan(0);
      expect(seen.flips).toBeGreaterThan(4);
      expect(seen.checks).toBeGreaterThan(100);
      const worker = runtime.presentationRebuildDiagnostics;
      expect(worker.cpuWriterPoolHits).toBeGreaterThan(0);
      expect(worker.workerFallbacks).toBe(0);

      // The same flight on the inline builder: its staged writers grow and
      // are refit through the pool while the checks above run every update.
      bridge.fail();
      expect(internals(runtime).client).toBeNull();
      const checksBefore = seen.checks;
      fly();
      expect(failures).toEqual([]);
      const inline = runtime.presentationRebuildDiagnostics;
      expect(inline.workerFallbacks).toBe(1);
      expect(inline.publications - inline.workerBuildPublications).toBeGreaterThan(4);
      expect(seen.checks - checksBefore).toBeGreaterThan(100);
      expect(inline.cpuWriterGrowths).toBeGreaterThan(0);
      expect(inline.cpuWriterRefits).toBeGreaterThan(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("releases stale, season, density, terrain, disposal, and eviction tokens exactly once", () => {
    const quality = profile();
    const observer = { x: 64, y: 100, z: 64 };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const worker = new ManualRuntimeWorker();
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "detail-runtime-token-lifecycle",
      terrainSample: () => ({ height: 100, slope: 0.05, moisture: 0.7, biome: 3 }),
      cellSizeMeters: 128,
      workerWorldSeed: "detail-runtime-token-lifecycle",
      detailWorkerFactory: () => worker as unknown as Worker,
      presentationRebuildBudget: {
        maximumWorkUnits: 1_000_000,
        maximumMilliseconds: 1_000_000,
      },
    });

    try {
      // Canceled/stale retained delivery is auto-released by the client and
      // never becomes a main-thread resident.
      runtime.update(observer, ORIGIN, quality);
      const stale = latestGenerate(worker);
      runtime.setDayOfYear(10);
      emitRetained(worker, stale, 101);
      expect(releaseCommands(worker, 101)).toHaveLength(1);
      expect(internals(runtime).cells.size).toBe(0);

      runtime.update(observer, ORIGIN, quality);
      const seasonal = latestGenerate(worker);
      emitRetained(worker, seasonal, 102);
      runtime.update(observer, ORIGIN, quality);
      const seasonalBuildIndex = worker.commands.findIndex(
        (command) => command.type === "buildPresentation",
      );
      runtime.setDayOfYear(20);
      const seasonalReleaseIndex = worker.commands.findIndex(
        (command) => command.type === "releaseCell" && command.token === 102,
      );
      expect(seasonalBuildIndex).toBeGreaterThanOrEqual(0);
      expect(seasonalReleaseIndex).toBeGreaterThan(seasonalBuildIndex);
      expect(releaseCommands(worker, 102)).toHaveLength(1);

      runtime.update(observer, ORIGIN, quality);
      const density = latestGenerate(worker);
      emitRetained(worker, density, 103);
      runtime.update(observer, ORIGIN, { ...quality, vegetationDensity: 0.45 });
      expect(releaseCommands(worker, 103)).toHaveLength(1);

      const terrain = latestGenerate(worker);
      emitRetained(worker, terrain, 104);
      runtime.update(observer, ORIGIN, { ...quality, vegetationDensity: 0.45 });
      runtime.publishTerrainPage({
        level: 0,
        tileX: 0,
        tileZ: 0,
        heights: new Float32Array(256 * 256),
      });
      expect(releaseCommands(worker, 104)).toHaveLength(1);

      runtime.update(observer, ORIGIN, { ...quality, vegetationDensity: 0.45 });
      const disposal = latestGenerate(worker);
      emitRetained(worker, disposal, 105);
      runtime.update(observer, ORIGIN, { ...quality, vegetationDensity: 0.45 });
      runtime.dispose();
      expect(releaseCommands(worker, 105)).toHaveLength(1);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }

    // Eviction has its own runtime because moving the single-cell observer
    // starts a replacement request; the retiring token still releases once.
    const evictionEngine = new NullEngine();
    const evictionScene = new Scene(evictionEngine);
    const evictionWorker = new ManualRuntimeWorker();
    const evictionRuntime = new WorldDetailRuntime(evictionScene, {
      worldSeed: "detail-runtime-token-eviction",
      terrainSample: () => ({ height: 100, slope: 0.05, moisture: 0.7, biome: 3 }),
      cellSizeMeters: 128,
      workerWorldSeed: "detail-runtime-token-eviction",
      detailWorkerFactory: () => evictionWorker as unknown as Worker,
      presentationRebuildBudget: {
        maximumWorkUnits: 1_000_000,
        maximumMilliseconds: 1_000_000,
      },
    });
    try {
      evictionRuntime.update(observer, ORIGIN, quality);
      emitRetained(evictionWorker, latestGenerate(evictionWorker), 201);
      evictionRuntime.update(observer, ORIGIN, quality);
      const buildIndex = evictionWorker.commands.findIndex(
        (command) => command.type === "buildPresentation",
      );
      evictionRuntime.update({ x: 10_064, y: 100, z: 10_064 }, ORIGIN, quality);
      const releaseIndex = evictionWorker.commands.findIndex(
        (command) => command.type === "releaseCell" && command.token === 201,
      );
      expect(releaseIndex).toBeGreaterThan(buildIndex);
      expect(releaseCommands(evictionWorker, 201)).toHaveLength(1);
    } finally {
      evictionRuntime.dispose();
      evictionScene.dispose();
      evictionEngine.dispose();
    }
  });
});
