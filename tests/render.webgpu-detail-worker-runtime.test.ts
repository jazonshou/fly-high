import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES,
  DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES,
  WorldDetailRuntime,
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
  origin = ORIGIN,
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

      const beyondEnvelope = { ...observer, x: observer.x + 300 };
      runtime.update(beyondEnvelope, ORIGIN, quality);
      expect(bridge.commands.some((command) => command.type === "cancelPresentation"))
        .toBe(true);
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(oldPublications);
      expect(publishedSnapshot(runtime).batches).toEqual(oldSnapshot.batches);

      // The client has forgotten the canceled build id; delivery after the
      // cancellation is harmless and cannot rehydrate or publish it.
      bridge.releaseHeldPresentations();
      runtime.update(beyondEnvelope, ORIGIN, quality);
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(oldPublications);

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
    const runtime = createRuntime(scene, world, { bridge });

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

      for (let pass = 0; pass < 256 && runtime.pendingWorkItems > 0; pass += 1) {
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

  it("times out held presentation authority across repeated >96 m cancellation and reissue", () => {
    const world = createWorld("detail-runtime-worker-watchdog", { airport: false });
    const quality = profile(170);
    const selected = richCell(world, quality.vegetationDensity);
    const observer = observerForCell(selected.cellX, selected.cellZ);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new RuntimeWorkerBridge();
    const runtime = createRuntime(scene, world, { bridge });

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

      for (let update = 0; update < DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES; update += 1) {
        const movingObserver = {
          ...observer,
          x: observer.x + (update % 2 === 0 ? -64 : 64),
        };
        runtime.update(movingObserver, ORIGIN, quality);
        bridge.flush();
        if (internals(runtime).client === null) break;
        // Drop the transport-held payload without delivering it. The next
        // >96 m observer jump cancels its build id and posts another request.
        bridge.heldPresentationEvents.length = 0;
      }
      expect(internals(runtime).client).toBeNull();
      expect(runtime.presentationRebuildDiagnostics.workerBuildTimeouts).toBe(1);
      expect(runtime.presentationRebuildDiagnostics.workerFallbacks).toBeGreaterThan(0);
      expect(bridge.commands.filter((command) => command.type === "buildPresentation").length)
        .toBeGreaterThan(2);
      expect(bridge.commands.filter((command) => command.type === "cancelPresentation").length)
        .toBeGreaterThan(2);
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
    const runtime = createRuntime(scene, world, { bridge });

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

      for (
        let update = 0;
        update < DETAIL_GENERATION_WORKER_MAX_NO_PROGRESS_UPDATES;
        update += 1
      ) {
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
      for (let update = 0; update < 512 && runtime.pendingWorkItems > 0; update += 1) {
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
