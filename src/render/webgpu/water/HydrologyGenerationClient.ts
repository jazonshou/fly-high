import type {
  HydrologyGenerationResult,
  HydrologyTerrainSampler,
} from "./HydrologyGeneration";
import { generateHydrology } from "./HydrologyGeneration";
import {
  isHydrologyWorkerEvent,
  type HydrologyWorkerCommand,
  type HydrologyWorkerEvent,
  type HydrologyWorkerGenerationOptions,
} from "@/src/workers/hydrologyProtocol";
import type { WorldSeed } from "@/src/world";

type WorkerFactory = () => Worker;
type FallbackScheduler = (callback: () => void) => void;

export interface HydrologyRegionGenerationRequest {
  readonly key: string;
  readonly generation: number;
  readonly options: HydrologyWorkerGenerationOptions;
  readonly signal?: AbortSignal;
}

export interface HydrologyRegionGenerationResult {
  readonly hydrology: HydrologyGenerationResult;
  readonly elapsedMilliseconds: number;
  readonly workerGenerated: boolean;
}

export interface HydrologyGenerationClientLike {
  readonly isUsingFallback: boolean;
  readonly queuedCount: number;
  request(
    request: HydrologyRegionGenerationRequest,
    onResult: (result: HydrologyRegionGenerationResult) => void,
    onError?: (error: Error) => void,
  ): number;
  cancel(requestId: number): void;
  dispose(): void;
}

export interface HydrologyGenerationClientOptions {
  readonly worldSeed: WorldSeed;
  readonly terrainSample: HydrologyTerrainSampler;
  /** Enables the real-world worker path. Omit for injected/custom samplers. */
  readonly workerWorldSeed?: WorldSeed;
  readonly workerFactory?: WorkerFactory;
  readonly fallbackScheduler?: FallbackScheduler;
}

interface PendingRequest extends HydrologyRegionGenerationRequest {
  readonly requestId: number;
  readonly onResult: (result: HydrologyRegionGenerationResult) => void;
  readonly onError: (error: Error) => void;
  abortHandler: (() => void) | null;
}

function abortError(): Error {
  const error = new Error("Hydrology generation was cancelled");
  error.name = "AbortError";
  return error;
}

const defaultWorkerFactory: WorkerFactory = () => new Worker(
  new URL("../../../workers/hydrology.worker.ts", import.meta.url),
  { type: "module", name: "aerolith-hydrology-generation" },
);

const defaultFallbackScheduler: FallbackScheduler = (callback) => setTimeout(callback, 0);

/**
 * Last-request-wins scheduler. At most one request is generating and one is
 * queued. Cancelling an active worker request terminates that worker, making
 * high-speed region changes and renderer disposal genuinely cancellable.
 */
export class HydrologyGenerationClient implements HydrologyGenerationClientLike {
  private readonly worldSeed: WorldSeed;
  private readonly terrainSample: HydrologyTerrainSampler;
  private readonly workerWorldSeed: WorldSeed | undefined;
  private readonly workerFactory: WorkerFactory;
  private readonly fallbackScheduler: FallbackScheduler;
  private readonly pending = new Map<number, PendingRequest>();
  private worker: Worker | null = null;
  private queuedRequestId: number | null = null;
  private activeRequestId: number | null = null;
  private nextRequestId = 1;
  private fallbackMode = false;
  private fallbackScheduled = false;
  private disposed = false;

  constructor(options: HydrologyGenerationClientOptions) {
    this.worldSeed = options.worldSeed;
    this.terrainSample = options.terrainSample;
    this.workerWorldSeed = options.workerWorldSeed;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.fallbackScheduler = options.fallbackScheduler ?? defaultFallbackScheduler;
    if (this.workerWorldSeed === undefined) {
      this.fallbackMode = true;
    } else {
      this.startWorker();
    }
  }

  get queuedCount(): number {
    return Number(this.queuedRequestId !== null);
  }

  get isUsingFallback(): boolean {
    return this.fallbackMode;
  }

  request(
    request: HydrologyRegionGenerationRequest,
    onResult: (result: HydrologyRegionGenerationResult) => void,
    onError: (error: Error) => void = () => undefined,
  ): number {
    if (this.disposed || request.signal?.aborted) {
      queueMicrotask(() => onError(abortError()));
      return -1;
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const pending: PendingRequest = {
      ...request,
      requestId,
      onResult,
      onError,
      abortHandler: null,
    };
    if (request.signal) {
      pending.abortHandler = () => this.cancel(requestId);
      request.signal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    this.pending.set(requestId, pending);
    if (this.queuedRequestId !== null) this.finishError(this.queuedRequestId, abortError());
    this.queuedRequestId = requestId;
    this.pump();
    return requestId;
  }

  cancel(requestId: number): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    const wasActive = this.activeRequestId === requestId;
    if (this.queuedRequestId === requestId) this.queuedRequestId = null;
    if (wasActive) this.activeRequestId = null;
    this.finishError(requestId, abortError());
    if (wasActive && !this.fallbackMode) this.restartWorker();
    this.pump();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cancellation = abortError();
    for (const requestId of [...this.pending.keys()]) this.finishError(requestId, cancellation);
    this.queuedRequestId = null;
    this.activeRequestId = null;
    this.detachWorker();
  }

  private pump(): void {
    if (this.disposed || this.activeRequestId !== null || this.queuedRequestId === null) return;
    // A cancelled fallback task still owns the one scheduled callback until it
    // runs. Leave its successor queued instead of marking it active without a
    // callback; the stale callback will clear the slot and pump the successor.
    if (this.fallbackMode && this.fallbackScheduled) return;
    const requestId = this.queuedRequestId;
    const request = this.pending.get(requestId);
    this.queuedRequestId = null;
    if (!request) {
      this.pump();
      return;
    }
    this.activeRequestId = requestId;
    if (this.fallbackMode) {
      this.fallbackScheduled = true;
      this.fallbackScheduler(() => {
        this.fallbackScheduled = false;
        if (this.disposed || this.activeRequestId !== requestId || !this.pending.has(requestId)) {
          if (this.activeRequestId === requestId) this.activeRequestId = null;
          this.pump();
          return;
        }
        this.runFallback(request);
      });
      return;
    }
    try {
      this.post({
        type: "generate",
        requestId,
        generation: request.generation,
        key: request.key,
        options: request.options,
      });
    } catch {
      this.activeRequestId = null;
      this.queuedRequestId = requestId;
      this.activateFallback();
      this.pump();
    }
  }

  private runFallback(request: PendingRequest): void {
    const startedAt = performance.now();
    try {
      const hydrology = generateHydrology({
        ...request.options,
        worldSeed: this.worldSeed,
        terrainSample: this.terrainSample,
      });
      this.finishResult(request.requestId, {
        hydrology,
        elapsedMilliseconds: performance.now() - startedAt,
        workerGenerated: false,
      });
    } catch (error) {
      this.finishError(
        request.requestId,
        error instanceof Error ? error : new Error("Hydrology generation failed"),
      );
    }
    if (this.activeRequestId === request.requestId) this.activeRequestId = null;
    this.pump();
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    if (!isHydrologyWorkerEvent(message.data)) return;
    const event: HydrologyWorkerEvent = message.data;
    if (this.activeRequestId === event.requestId) this.activeRequestId = null;
    const request = this.pending.get(event.requestId);
    if (request && request.key === event.key && request.generation === event.generation) {
      if (event.type === "region") {
        this.finishResult(event.requestId, {
          hydrology: event.hydrology,
          elapsedMilliseconds: event.elapsedMilliseconds,
          workerGenerated: true,
        });
      } else {
        // A worker-specific failure should not remove water. Retry this one
        // request with the injected sampler on a later main-thread task.
        this.activeRequestId = event.requestId;
        this.fallbackScheduler(() => {
          if (this.pending.has(event.requestId)) this.runFallback(request);
        });
      }
    } else {
      this.removeRequest(event.requestId);
    }
    this.pump();
  };

  private readonly handleWorkerFailure = (event: ErrorEvent): void => {
    event.preventDefault();
    this.activateFallback();
  };

  private readonly handleMessageFailure = (): void => this.activateFallback();

  private startWorker(): void {
    if (this.disposed || this.workerWorldSeed === undefined) return;
    try {
      this.worker = this.workerFactory();
      this.worker.addEventListener("message", this.handleMessage);
      this.worker.addEventListener("error", this.handleWorkerFailure);
      this.worker.addEventListener("messageerror", this.handleMessageFailure);
      this.post({ type: "initialize", worldSeed: this.workerWorldSeed });
    } catch {
      this.activateFallback();
    }
  }

  private restartWorker(): void {
    this.detachWorker();
    this.startWorker();
  }

  private activateFallback(): void {
    if (this.disposed || this.fallbackMode) return;
    this.fallbackMode = true;
    this.detachWorker();
    if (this.activeRequestId !== null) {
      const activeId = this.activeRequestId;
      this.activeRequestId = null;
      if (this.pending.has(activeId)) {
        if (this.queuedRequestId !== null) this.finishError(this.queuedRequestId, abortError());
        this.queuedRequestId = activeId;
      }
    }
    this.pump();
  }

  private finishResult(requestId: number, result: HydrologyRegionGenerationResult): void {
    const request = this.removeRequest(requestId);
    request?.onResult(result);
  }

  private finishError(requestId: number, error: Error): void {
    const request = this.removeRequest(requestId);
    request?.onError(error);
  }

  private removeRequest(requestId: number): PendingRequest | undefined {
    const request = this.pending.get(requestId);
    if (!request) return undefined;
    this.pending.delete(requestId);
    if (request.abortHandler) {
      request.signal?.removeEventListener("abort", request.abortHandler);
      request.abortHandler = null;
    }
    return request;
  }

  private post(command: HydrologyWorkerCommand): void {
    if (!this.worker) throw new Error("Hydrology worker is unavailable");
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
