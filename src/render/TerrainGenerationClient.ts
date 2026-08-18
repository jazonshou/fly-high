import {
  createWorld,
  generateTerrainTile,
  type TerrainTileData,
  type TerrainTileOptions,
  type WorldDefinition,
  type WorldSeed,
} from "@/src/world";
import {
  isTerrainWorkerEvent,
  type TerrainWorkerCommand,
  type TerrainWorkerEvent,
} from "@/src/workers/terrainProtocol";
import { BoundedTerrainQueue } from "@/src/workers/terrainQueue";

export interface TerrainGenerationRequest {
  key: string;
  generation: number;
  priority: number;
  options: TerrainTileOptions;
}

interface PendingTerrainRequest extends TerrainGenerationRequest {
  requestId: number;
  onResult: (tile: TerrainTileData) => void;
  onError: (error: Error) => void;
}

type WorkerFactory = () => Worker;
type FallbackScheduler = (callback: () => void) => void;

export interface TerrainGenerationClientOptions {
  maxQueued?: number;
  workerFactory?: WorkerFactory;
  fallbackScheduler?: FallbackScheduler;
  /** Overrides the hardware-derived worker count; primarily for tests. */
  workerCount?: number;
}

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("../workers/terrain.worker.ts", import.meta.url), {
    type: "module",
    name: "aerolith-terrain-generation",
  });

const defaultFallbackScheduler: FallbackScheduler = (callback) => {
  setTimeout(callback, 0);
};

/**
 * clamp(2, hardwareConcurrency − 4, 6): 6 on the 10-core reference machine,
 * leaving 4 cores for the main thread, the simulation worker, the hydrology
 * worker and the browser itself.
 */
export function resolveTerrainWorkerCount(hardwareConcurrency: number): number {
  if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency < 1) return 2;
  return Math.min(6, Math.max(2, Math.floor(hardwareConcurrency) - 4));
}

interface WorkerSlot {
  readonly index: number;
  readonly worker: Worker;
  readonly detach: () => void;
}

/**
 * Terrain generation scheduler over a small worker pool (1B-4) with a
 * bounded priority queue. `generateTerrainTile` is a pure function of
 * (seed, tile, size, resolution) with no shared state — embarrassingly
 * parallel — so the only scheduling state is a slot map from worker index to
 * the request it is running. The synchronous fallback path (single in-flight)
 * is what keeps the sim alive when worker construction fails.
 *
 * Rejection contract (0-3 review): a request the bounded queue rejects is
 * signalled by the -1 return ALONE; onError fires synchronously only for a
 * previously-queued request evicted in favour of a better newcomer.
 */
export class TerrainGenerationClient {
  private readonly world: WorldDefinition;
  private readonly queue: BoundedTerrainQueue<PendingTerrainRequest>;
  private readonly pending = new Map<number, PendingTerrainRequest>();
  private readonly fallbackScheduler: FallbackScheduler;
  private readonly workers: WorkerSlot[] = [];
  /** Worker index → request id currently running on that worker. */
  private readonly activeByWorker = new Map<number, number>();
  private nextRequestId = 1;
  private fallbackActiveRequestId: number | null = null;
  private fallbackMode = false;
  private fallbackScheduled = false;
  private disposed = false;

  constructor(worldOrSeed: WorldDefinition | WorldSeed, options: TerrainGenerationClientOptions = {}) {
    this.world = typeof worldOrSeed === "object" ? worldOrSeed : createWorld(worldOrSeed);
    this.queue = new BoundedTerrainQueue(options.maxQueued ?? 64);
    this.fallbackScheduler = options.fallbackScheduler ?? defaultFallbackScheduler;
    const workerCount = options.workerCount
      ?? resolveTerrainWorkerCount(
        typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 4 : 4,
      );
    try {
      const factory = options.workerFactory ?? defaultWorkerFactory;
      for (let index = 0; index < workerCount; index += 1) {
        const worker = factory();
        const onMessage = (message: MessageEvent<unknown>) => this.handleMessage(index, message);
        const onFailure = (event: ErrorEvent) => {
          event.preventDefault();
          this.activateFallback();
        };
        const onMessageFailure = () => this.activateFallback();
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onFailure);
        worker.addEventListener("messageerror", onMessageFailure);
        this.workers.push({
          index,
          worker,
          detach: () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onFailure);
            worker.removeEventListener("messageerror", onMessageFailure);
            worker.terminate();
          },
        });
        worker.postMessage({ type: "initialize", world: this.world } satisfies TerrainWorkerCommand);
      }
      if (this.workers.length === 0) this.activateFallback();
    } catch {
      this.activateFallback();
    }
  }

  get queuedCount(): number {
    return this.queue.size;
  }

  get isUsingFallback(): boolean {
    return this.fallbackMode;
  }

  get workerCount(): number {
    return this.fallbackMode ? 0 : this.workers.length;
  }

  get busyWorkerCount(): number {
    if (this.fallbackMode) return this.fallbackActiveRequestId !== null ? 1 : 0;
    return this.activeByWorker.size;
  }

  request(
    request: TerrainGenerationRequest,
    onResult: (tile: TerrainTileData) => void,
    onError: (error: Error) => void = () => undefined,
  ): number {
    if (this.disposed) return -1;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const pending: PendingTerrainRequest = { ...request, requestId, onResult, onError };
    this.pending.set(requestId, pending);
    const queued = this.queue.enqueue(requestId, request.priority, pending);

    if (queued.dropped) {
      this.pending.delete(queued.dropped.id);
      // A previously-queued request evicted in favour of a better newcomer is
      // told it failed. The newcomer's own rejection is signalled by the -1
      // return alone — invoking its onError before request() has even
      // returned would hand callers a re-entrant failure for a request they
      // do not know exists yet.
      if (queued.dropped.id !== requestId) {
        queued.dropped.value.onError(new Error("Terrain request queue reached its capacity"));
      }
    }
    if (!queued.accepted) return -1;
    this.pump();
    return requestId;
  }

  cancel(requestId: number): void {
    if (requestId < 0) return;
    this.pending.delete(requestId);
    this.queue.remove(requestId);
  }

  cancelAll(): void {
    this.pending.clear();
    this.queue.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.detachWorkers();
    this.activeByWorker.clear();
    this.fallbackActiveRequestId = null;
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.fallbackMode) {
      this.pumpFallback();
      return;
    }
    for (const slot of this.workers) {
      if (this.activeByWorker.has(slot.index)) continue;
      const entry = this.queue.take();
      if (!entry) return;
      this.activeByWorker.set(slot.index, entry.id);
      try {
        slot.worker.postMessage({
          type: "generate",
          requestId: entry.id,
          generation: entry.value.generation,
          key: entry.value.key,
          options: entry.value.options,
        } satisfies TerrainWorkerCommand);
      } catch {
        this.activeByWorker.delete(slot.index);
        const requeued = this.queue.enqueue(entry.id, entry.priority, entry.value);
        if (!requeued.accepted) this.failRequest(entry.value, "Terrain fallback queue is full");
        this.activateFallback();
        this.pump();
        return;
      }
    }
  }

  private pumpFallback(): void {
    if (this.fallbackScheduled || this.fallbackActiveRequestId !== null) return;
    if (this.queue.size === 0) return;
    this.fallbackScheduled = true;
    this.fallbackScheduler(() => {
      this.fallbackScheduled = false;
      if (this.disposed) return;
      const entry = this.queue.take();
      if (!entry) return;
      this.fallbackActiveRequestId = entry.id;
      this.runFallback(entry.value);
    });
  }

  private runFallback(request: PendingTerrainRequest): void {
    try {
      const tile = generateTerrainTile(this.world, request.options);
      if (this.pending.delete(request.requestId)) request.onResult(tile);
    } catch (error) {
      if (this.pending.delete(request.requestId)) {
        request.onError(error instanceof Error ? error : new Error("Terrain generation failed"));
      }
    } finally {
      if (this.fallbackActiveRequestId === request.requestId) this.fallbackActiveRequestId = null;
      this.pump();
    }
  }

  private handleMessage(workerIndex: number, message: MessageEvent<unknown>): void {
    if (!isTerrainWorkerEvent(message.data)) return;
    const event: TerrainWorkerEvent = message.data;
    if (this.activeByWorker.get(workerIndex) === event.requestId) {
      this.activeByWorker.delete(workerIndex);
    }
    const request = this.pending.get(event.requestId);
    this.pending.delete(event.requestId);

    if (request && request.key === event.key && request.generation === event.generation) {
      if (event.type === "tile") request.onResult(event.tile);
      else this.runSingleRequestFallback(request, event.message);
    }
    this.pump();
  }

  private runSingleRequestFallback(request: PendingTerrainRequest, workerMessage: string): void {
    try {
      request.onResult(generateTerrainTile(this.world, request.options));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "fallback failed";
      request.onError(new Error(`${workerMessage}; ${detail}`));
    }
  }

  private activateFallback(): void {
    if (this.disposed || this.fallbackMode) return;
    this.fallbackMode = true;
    this.detachWorkers();
    // Requests that were in flight on workers go back into the queue; the
    // synchronous fallback drains them one at a time.
    for (const requestId of this.activeByWorker.values()) {
      const active = this.pending.get(requestId);
      if (!active) continue;
      const requeued = this.queue.enqueue(active.requestId, active.priority, active);
      if (!requeued.accepted) this.failRequest(active, "Terrain fallback queue is full");
      if (requeued.dropped && requeued.dropped.id !== active.requestId) {
        this.pending.delete(requeued.dropped.id);
        requeued.dropped.value.onError(new Error("Terrain fallback queue is full"));
      }
    }
    this.activeByWorker.clear();
    this.pump();
  }

  private failRequest(request: PendingTerrainRequest, message: string): void {
    if (this.pending.delete(request.requestId)) request.onError(new Error(message));
  }

  private detachWorkers(): void {
    for (const slot of this.workers) slot.detach();
    this.workers.length = 0;
  }
}
