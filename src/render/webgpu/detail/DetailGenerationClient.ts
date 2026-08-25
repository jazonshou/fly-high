import { BoundedPriorityQueue } from "@/src/workers/boundedPriorityQueue";
import {
  detailWorkerCommandTransferables,
  isDetailWorkerEvent,
  type DetailRetainedCellDescriptor,
  type DetailWorkerCommand,
  type DetailWorkerEvent,
  type DetailWorkerPresentationBuildInput,
  type DetailWorkerPresentationResult,
} from "@/src/workers/detailProtocol";
import type { TerrainMacroGrid, TerrainPagePublication } from "@/src/workers/terrainAuthority";
import type { WorldDefinition, WorldSeed } from "@/src/world";
import type { TerrainAuxPagePublication } from "../terrain/TerrainPageAtlas";
import type { DetailPresentationBuildCatalog } from "./presentationBuild";
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

interface PendingDetailRequestBase extends DetailGenerationRequest {
  readonly requestId: number;
  readonly onError: (error: Error) => void;
}

interface PendingLegacyDetailRequest extends PendingDetailRequestBase {
  readonly resultKind: "cell";
  readonly onResult: (cell: GeneratedDetailCell) => void;
}

interface PendingRetainedDetailRequest extends PendingDetailRequestBase {
  readonly resultKind: "retained";
  readonly onResult: (cell: DetailRetainedCellDescriptor) => void;
}

type PendingDetailRequest = PendingLegacyDetailRequest | PendingRetainedDetailRequest;

interface PendingPresentationRequest {
  readonly buildId: number;
  readonly onResult: (result: DetailWorkerPresentationResult) => void;
  readonly onError: (error: Error) => void;
}

type WorkerFactory = () => Worker;

export interface DetailGenerationClientOptions {
  readonly worldSeed: WorldSeed;
  readonly world?: Readonly<WorldDefinition>;
  readonly cellSizeMeters: number;
  readonly seaLevelMeters: number;
  readonly presentationCatalog?: DetailPresentationBuildCatalog;
  readonly maxQueued?: number;
  readonly workerFactory?: WorkerFactory;
}

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("../../../workers/detail.worker.ts", import.meta.url), {
    type: "module",
    name: "aerolith-detail-generation",
  });

/**
 * Bounded generation scheduler plus retained-cell presentation transport.
 *
 * Generation preserves the original one-in-flight priority queue. Retained
 * results transfer only a token/descriptor; presentation builds refer to
 * those tokens and return exact packed batch buffers from the same pure
 * builder used inline. The legacy full-cell request remains temporarily so a
 * runtime can migrate atomically without weakening the existing fallback.
 */
export class DetailGenerationClient {
  private readonly queue: BoundedPriorityQueue<PendingDetailRequest>;
  private readonly pending = new Map<number, PendingDetailRequest>();
  private readonly pendingPresentation = new Map<number, PendingPresentationRequest>();
  private readonly retainedCellTokens = new Set<number>();
  private worker: Worker | null = null;
  private activeRequestId: number | null = null;
  private nextRequestId = 1;
  private nextBuildId = 1;
  private failed = false;
  private disposed = false;
  private readonly onWorkerUnavailable: () => void;
  private readonly presentationAvailable: boolean;

  constructor(
    options: DetailGenerationClientOptions,
    onWorkerUnavailable: () => void = () => undefined,
  ) {
    this.queue = new BoundedPriorityQueue(options.maxQueued ?? 96);
    this.onWorkerUnavailable = onWorkerUnavailable;
    this.presentationAvailable = options.presentationCatalog !== undefined;
    try {
      this.worker = (options.workerFactory ?? defaultWorkerFactory)();
      this.worker.addEventListener("message", this.handleMessage);
      this.worker.addEventListener("error", this.handleFailure);
      this.worker.addEventListener("messageerror", this.handleFailure);
      this.worker.postMessage({
        type: "initialize",
        worldSeed: options.worldSeed,
        ...(options.world ? { world: options.world } : {}),
        cellSizeMeters: options.cellSizeMeters,
        seaLevelMeters: options.seaLevelMeters,
        ...(options.presentationCatalog
          ? { presentationCatalog: options.presentationCatalog }
          : {}),
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

  get presentationBusy(): boolean {
    return this.pendingPresentation.size > 0;
  }

  get retainedCellCount(): number {
    return this.retainedCellTokens.size;
  }

  /** Publish the once-per-world macro fallback; ownership of its buffer transfers. */
  publishTerrainMacro(macro: TerrainMacroGrid): boolean {
    return this.postTerrainAuthority({ type: "terrainMacro", macro });
  }

  /** Publish one final L0 core; ownership of its buffer transfers. */
  publishTerrainPage(page: TerrainPagePublication): boolean {
    return this.postTerrainAuthority({ type: "terrainPage", page });
  }

  /** Publish one committed signed-shore page; ownership of its buffer transfers. */
  publishTerrainAuxPage(page: TerrainAuxPagePublication): boolean {
    return this.postTerrainAuthority({ type: "terrainAux", page });
  }

  /** Compatibility request: returns a cloned full GeneratedDetailCell. */
  request(
    request: DetailGenerationRequest,
    onResult: (cell: GeneratedDetailCell) => void,
    onError: (error: Error) => void = () => undefined,
  ): number {
    const requestId = this.allocateRequestId();
    if (requestId < 0) return -1;
    return this.enqueue({
      ...request,
      requestId,
      resultKind: "cell",
      onResult,
      onError,
    });
  }

  /** Production request: the full generated cell remains owned by the worker. */
  requestRetained(
    request: DetailGenerationRequest,
    onResult: (cell: DetailRetainedCellDescriptor) => void,
    onError: (error: Error) => void = () => undefined,
  ): number {
    const requestId = this.allocateRequestId();
    if (requestId < 0) return -1;
    return this.enqueue({
      ...request,
      requestId,
      resultKind: "retained",
      onResult,
      onError,
    });
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

  /** Releases an accepted retained cell. Returns false for stale/double releases. */
  releaseCell(cell: DetailRetainedCellDescriptor | number): boolean {
    const token = typeof cell === "number" ? cell : cell.token;
    if (!this.retainedCellTokens.delete(token)) return false;
    return this.postReleaseCell(token);
  }

  requestPresentation(
    input: DetailWorkerPresentationBuildInput,
    onResult: (result: DetailWorkerPresentationResult) => void,
    onError: (error: Error) => void = () => undefined,
  ): number {
    if (this.disposed || this.failed || !this.worker || !this.presentationAvailable) return -1;
    if (input.residents.some((resident) => !this.retainedCellTokens.has(resident.token))) {
      onError(new Error("Detail presentation request referenced an unowned cell token"));
      return -1;
    }
    const buildId = this.allocateBuildId();
    if (buildId < 0) return -1;
    const pending: PendingPresentationRequest = { buildId, onResult, onError };
    this.pendingPresentation.set(buildId, pending);
    try {
      this.worker.postMessage({
        type: "buildPresentation",
        buildId,
        input,
      } satisfies DetailWorkerCommand);
      return buildId;
    } catch {
      this.markUnavailable();
      return -1;
    }
  }

  cancelPresentation(buildId: number): void {
    if (buildId < 0) return;
    if (!this.pendingPresentation.delete(buildId)) return;
    try {
      this.worker?.postMessage({ type: "cancelPresentation", buildId } satisfies DetailWorkerCommand);
    } catch {
      this.markUnavailable();
    }
  }

  cancelAllPresentations(): void {
    const buildIds = [...this.pendingPresentation.keys()];
    this.pendingPresentation.clear();
    for (const buildId of buildIds) {
      try {
        this.worker?.postMessage({
          type: "cancelPresentation",
          buildId,
        } satisfies DetailWorkerCommand);
      } catch {
        this.markUnavailable();
        return;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelAll();
    this.cancelAllPresentations();
    for (const token of this.retainedCellTokens) this.postReleaseCell(token);
    this.retainedCellTokens.clear();
    this.disposed = true;
    this.detachWorker();
    this.activeRequestId = null;
  }

  private allocateRequestId(): number {
    if (this.disposed || this.failed || !Number.isSafeInteger(this.nextRequestId)) return -1;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return requestId;
  }

  private allocateBuildId(): number {
    if (!Number.isSafeInteger(this.nextBuildId)) return -1;
    const buildId = this.nextBuildId;
    this.nextBuildId += 1;
    return buildId;
  }

  private enqueue(pending: PendingDetailRequest): number {
    this.pending.set(pending.requestId, pending);
    const queued = this.queue.enqueue(pending.requestId, pending.priority, pending);
    if (queued.dropped) {
      this.pending.delete(queued.dropped.id);
      if (queued.dropped.id !== pending.requestId) {
        queued.dropped.value.onError(new Error("Detail request queue reached its capacity"));
      }
    }
    if (!queued.accepted) return -1;
    this.pump();
    return pending.requestId;
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
        ...(entry.value.resultKind === "retained" ? { retain: true } : {}),
      } satisfies DetailWorkerCommand);
    } catch {
      this.activeRequestId = null;
      this.markUnavailable();
    }
  }

  private postTerrainAuthority(
    command: Extract<
      DetailWorkerCommand,
      { type: "terrainMacro" | "terrainPage" | "terrainAux" }
    >,
  ): boolean {
    if (this.disposed || this.failed || !this.worker) return false;
    try {
      this.worker.postMessage(command, detailWorkerCommandTransferables(command));
      return true;
    } catch {
      this.markUnavailable();
      return false;
    }
  }

  private postReleaseCell(token: number): boolean {
    if (this.failed || !this.worker) return false;
    try {
      this.worker.postMessage({ type: "releaseCell", token } satisfies DetailWorkerCommand);
      return true;
    } catch {
      this.markUnavailable();
      return false;
    }
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    if (!isDetailWorkerEvent(message.data)) {
      // This is a dedicated worker: an invalid event cannot belong to another
      // consumer. Ignoring it would strand the one active generation slot or
      // a presentation callback forever, so fail closed and activate the
      // runtime's existing inline fallback/ownership cleanup path.
      this.markUnavailable();
      return;
    }
    const event: DetailWorkerEvent = message.data;
    if (event.type === "presentation" || event.type === "presentationError") {
      const request = this.pendingPresentation.get(event.buildId);
      this.pendingPresentation.delete(event.buildId);
      if (request) {
        if (event.type === "presentation") {
          request.onResult({
            buildId: event.buildId,
            batches: event.batches,
            statistics: event.statistics,
          });
        } else {
          request.onError(new Error(event.message));
        }
      }
      return;
    }

    const wasActiveRequest = this.activeRequestId === event.requestId;
    if (wasActiveRequest) this.activeRequestId = null;
    const request = this.pending.get(event.requestId);
    if (request && !wasActiveRequest) {
      // A queued request has never crossed the worker boundary, so the
      // dedicated worker cannot legitimately know its id. Accepting a
      // correctly shaped spoof here would install a retained token while the
      // queue still dispatches the same id later with no callback owner.
      this.markUnavailable();
      return;
    }
    const matches = request
      && request.key === event.key
      && request.generation === event.generation;
    if (request && !matches) {
      // Request ids are unique and never reused. A live request carrying the
      // wrong key/epoch is therefore worker-authority corruption, not an
      // ordinary stale result. Keep it pending until markUnavailable so its
      // onError clears the runtime's pending-cell bookkeeping and fallback
      // can take over instead of stranding that key forever.
      this.markUnavailable();
      return;
    }
    if (event.type === "retainedCell" && this.retainedCellTokens.has(event.cell.token)) {
      // Releasing here would also release the already-owned resident that the
      // duplicate aliases. Terminating the worker is the only unambiguous
      // cleanup: it destroys both worker entries, errors the still-pending
      // callback, and clears main-thread ownership atomically.
      this.markUnavailable();
      return;
    }
    if (
      request
      && event.type !== "error"
      && (
        event.type === "cell" && request.resultKind !== "cell"
        || event.type === "retainedCell" && request.resultKind !== "retained"
      )
    ) {
      // A live request has one declared ownership mode. Returning the other
      // shape means the dedicated worker and client disagree about protocol
      // state; continuing could either clone a supposedly retained cell or
      // release a token that another resident owns.
      this.markUnavailable();
      return;
    }
    this.pending.delete(event.requestId);
    if (event.type === "retainedCell" && (!matches || request?.resultKind !== "retained")) {
      // The worker has already retained this token. A canceled/stale/mistyped
      // result must explicitly return ownership or the worker map leaks it.
      this.postReleaseCell(event.cell.token);
    }
    if (matches) {
      if (event.type === "error") request.onError(new Error(event.message));
      else if (event.type === "cell" && request.resultKind === "cell") {
        request.onResult(event.cell);
      } else if (event.type === "retainedCell" && request.resultKind === "retained") {
        this.retainedCellTokens.add(event.cell.token);
        request.onResult(event.cell);
      } else {
        request.onError(new Error("Detail worker returned an unexpected result kind"));
      }
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
    const orphaned = [...this.pending.values()];
    const orphanedPresentation = [...this.pendingPresentation.values()];
    this.pending.clear();
    this.pendingPresentation.clear();
    this.queue.clear();
    this.retainedCellTokens.clear();
    this.activeRequestId = null;
    for (const request of orphaned) {
      request.onError(new Error("Detail generation worker became unavailable"));
    }
    for (const request of orphanedPresentation) {
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
