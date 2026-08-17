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
}

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("../workers/terrain.worker.ts", import.meta.url), {
    type: "module",
    name: "aerolith-terrain-generation",
  });

const defaultFallbackScheduler: FallbackScheduler = (callback) => {
  setTimeout(callback, 0);
};

/** One-worker, one-in-flight terrain scheduler with a bounded priority queue. */
export class TerrainGenerationClient {
  private readonly world: WorldDefinition;
  private readonly queue: BoundedTerrainQueue<PendingTerrainRequest>;
  private readonly pending = new Map<number, PendingTerrainRequest>();
  private readonly fallbackScheduler: FallbackScheduler;
  private worker: Worker | null = null;
  private activeRequestId: number | null = null;
  private nextRequestId = 1;
  private fallbackMode = false;
  private fallbackScheduled = false;
  private disposed = false;

  constructor(worldOrSeed: WorldDefinition | WorldSeed, options: TerrainGenerationClientOptions = {}) {
    this.world = typeof worldOrSeed === "object" ? worldOrSeed : createWorld(worldOrSeed);
    this.queue = new BoundedTerrainQueue(options.maxQueued ?? 64);
    this.fallbackScheduler = options.fallbackScheduler ?? defaultFallbackScheduler;
    try {
      this.worker = (options.workerFactory ?? defaultWorkerFactory)();
      this.worker.addEventListener("message", this.handleMessage);
      this.worker.addEventListener("error", this.handleWorkerFailure);
      this.worker.addEventListener("messageerror", this.handleMessageFailure);
      this.post({ type: "initialize", world: this.world });
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
    this.detachWorker();
    this.activeRequestId = null;
  }

  private pump(): void {
    if (this.disposed || this.activeRequestId !== null) return;
    if (this.fallbackMode) {
      if (this.fallbackScheduled || this.queue.size === 0) return;
      this.fallbackScheduled = true;
      this.fallbackScheduler(() => {
        this.fallbackScheduled = false;
        if (this.disposed) return;
        const entry = this.queue.take();
        if (!entry) return;
        this.activeRequestId = entry.id;
        this.runFallback(entry.value);
      });
      return;
    }

    const entry = this.queue.take();
    if (!entry) return;
    this.activeRequestId = entry.id;
    try {
      this.post({
        type: "generate",
        requestId: entry.id,
        generation: entry.value.generation,
        key: entry.value.key,
        options: entry.value.options,
      });
    } catch {
      this.activeRequestId = null;
      const requeued = this.queue.enqueue(entry.id, entry.priority, entry.value);
      if (!requeued.accepted) this.failRequest(entry.value, "Terrain fallback queue is full");
      this.activateFallback();
      this.pump();
    }
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
      if (this.activeRequestId === request.requestId) this.activeRequestId = null;
      this.pump();
    }
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    if (!isTerrainWorkerEvent(message.data)) return;
    const event: TerrainWorkerEvent = message.data;
    if (this.activeRequestId === event.requestId) this.activeRequestId = null;
    const request = this.pending.get(event.requestId);
    this.pending.delete(event.requestId);

    if (request && request.key === event.key && request.generation === event.generation) {
      if (event.type === "tile") request.onResult(event.tile);
      else this.runSingleRequestFallback(request, event.message);
    }
    this.pump();
  };

  private runSingleRequestFallback(request: PendingTerrainRequest, workerMessage: string): void {
    try {
      request.onResult(generateTerrainTile(this.world, request.options));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "fallback failed";
      request.onError(new Error(`${workerMessage}; ${detail}`));
    }
  }

  private readonly handleWorkerFailure = (event: ErrorEvent): void => {
    event.preventDefault();
    this.activateFallback();
  };

  private readonly handleMessageFailure = (): void => {
    this.activateFallback();
  };

  private activateFallback(): void {
    if (this.disposed || this.fallbackMode) return;
    this.fallbackMode = true;
    this.detachWorker();
    if (this.activeRequestId !== null) {
      const active = this.pending.get(this.activeRequestId);
      this.activeRequestId = null;
      if (active) {
        const requeued = this.queue.enqueue(active.requestId, active.priority, active);
        if (!requeued.accepted) this.failRequest(active, "Terrain fallback queue is full");
        if (requeued.dropped && requeued.dropped.id !== active.requestId) {
          this.pending.delete(requeued.dropped.id);
          requeued.dropped.value.onError(new Error("Terrain fallback queue is full"));
        }
      }
    }
    this.pump();
  }

  private failRequest(request: PendingTerrainRequest, message: string): void {
    if (this.pending.delete(request.requestId)) request.onError(new Error(message));
  }

  private post(command: TerrainWorkerCommand): void {
    if (!this.worker) throw new Error("Terrain worker is unavailable");
    this.worker.postMessage(command);
  }

  private detachWorker(): void {
    if (!this.worker) return;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerFailure);
    this.worker.removeEventListener("messageerror", this.handleMessageFailure);
    this.worker.terminate();
    this.worker = null;
  }
}
