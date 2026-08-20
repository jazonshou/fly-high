import { BoundedPriorityQueue } from "@/src/workers/boundedPriorityQueue";
import {
  isDetailWorkerEvent,
  type DetailWorkerCommand,
  type DetailWorkerEvent,
} from "@/src/workers/detailProtocol";
import type { WorldSeed } from "@/src/world";
import type { GeneratedDetailCell } from "./types";

export interface DetailGenerationRequest {
  readonly key: string;
  readonly generation: number;
  readonly priority: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly densityMultiplier: number;
  readonly dayOfYear: number;
}

interface PendingDetailRequest extends DetailGenerationRequest {
  readonly requestId: number;
  readonly onResult: (cell: GeneratedDetailCell) => void;
  readonly onError: (error: Error) => void;
}

type WorkerFactory = () => Worker;

export interface DetailGenerationClientOptions {
  readonly worldSeed: WorldSeed;
  readonly cellSizeMeters: number;
  readonly seaLevelMeters: number;
  readonly maxQueued?: number;
  readonly workerFactory?: WorkerFactory;
}

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("../../../workers/detail.worker.ts", import.meta.url), {
    type: "module",
    name: "aerolith-detail-generation",
  });

/**
 * Bounded-priority scheduler for the detail worker (1B-10), reusing the
 * terrain client's request/response and bounded-queue shape rather than
 * inventing a third scheduler. One worker, one in-flight cell; the queue
 * reorders by streaming priority between dispatches. Unlike the terrain
 * client there is no synchronous fallback — WorldDetailRuntime keeps its own
 * inline generation path and simply never constructs a client when workers
 * are unavailable.
 */
export class DetailGenerationClient {
  private readonly queue: BoundedPriorityQueue<PendingDetailRequest>;
  private readonly pending = new Map<number, PendingDetailRequest>();
  private worker: Worker | null = null;
  private activeRequestId: number | null = null;
  private nextRequestId = 1;
  private failed = false;
  private disposed = false;
  private readonly onWorkerUnavailable: () => void;

  constructor(
    options: DetailGenerationClientOptions,
    onWorkerUnavailable: () => void = () => undefined,
  ) {
    this.queue = new BoundedPriorityQueue(options.maxQueued ?? 96);
    this.onWorkerUnavailable = onWorkerUnavailable;
    try {
      this.worker = (options.workerFactory ?? defaultWorkerFactory)();
      this.worker.addEventListener("message", this.handleMessage);
      this.worker.addEventListener("error", this.handleFailure);
      this.worker.addEventListener("messageerror", this.handleFailure);
      this.worker.postMessage({
        type: "initialize",
        worldSeed: options.worldSeed,
        cellSizeMeters: options.cellSizeMeters,
        seaLevelMeters: options.seaLevelMeters,
      } satisfies DetailWorkerCommand);
    } catch {
      this.markUnavailable();
    }
  }

  get isAvailable(): boolean {
    return !this.failed && !this.disposed;
  }

  get queuedCount(): number {
    return this.queue.size;
  }

  get busy(): boolean {
    return this.activeRequestId !== null;
  }

  /** Rejection contract mirrors the terrain client: -1 alone for the newcomer. */
  request(
    request: DetailGenerationRequest,
    onResult: (cell: GeneratedDetailCell) => void,
    onError: (error: Error) => void = () => undefined,
  ): number {
    if (this.disposed || this.failed) return -1;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const pending: PendingDetailRequest = { ...request, requestId, onResult, onError };
    this.pending.set(requestId, pending);
    const queued = this.queue.enqueue(requestId, request.priority, pending);
    if (queued.dropped) {
      this.pending.delete(queued.dropped.id);
      if (queued.dropped.id !== requestId) {
        queued.dropped.value.onError(new Error("Detail request queue reached its capacity"));
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
    if (this.disposed || this.failed || this.activeRequestId !== null) return;
    const entry = this.queue.take();
    if (!entry) return;
    this.activeRequestId = entry.id;
    try {
      this.worker?.postMessage({
        type: "generate",
        requestId: entry.id,
        generation: entry.value.generation,
        key: entry.value.key,
        cellX: entry.value.cellX,
        cellZ: entry.value.cellZ,
        densityMultiplier: entry.value.densityMultiplier,
        dayOfYear: entry.value.dayOfYear,
      } satisfies DetailWorkerCommand);
    } catch {
      this.activeRequestId = null;
      this.markUnavailable();
    }
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    if (!isDetailWorkerEvent(message.data)) return;
    const event: DetailWorkerEvent = message.data;
    if (this.activeRequestId === event.requestId) this.activeRequestId = null;
    const request = this.pending.get(event.requestId);
    this.pending.delete(event.requestId);
    if (request && request.key === event.key && request.generation === event.generation) {
      if (event.type === "cell") request.onResult(event.cell);
      else request.onError(new Error(event.message));
    }
    this.pump();
  };

  private readonly handleFailure = (event: Event): void => {
    if ("preventDefault" in event) event.preventDefault();
    this.markUnavailable();
  };

  private markUnavailable(): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.detachWorker();
    // Everything queued or in flight is dead; the runtime falls back to its
    // inline generator on the next update.
    const orphaned = [...this.pending.values()];
    this.pending.clear();
    this.queue.clear();
    this.activeRequestId = null;
    for (const request of orphaned) {
      request.onError(new Error("Detail generation worker became unavailable"));
    }
    this.onWorkerUnavailable();
  }

  private detachWorker(): void {
    if (!this.worker) return;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleFailure);
    this.worker.removeEventListener("messageerror", this.handleFailure);
    this.worker.terminate();
    this.worker = null;
  }
}
