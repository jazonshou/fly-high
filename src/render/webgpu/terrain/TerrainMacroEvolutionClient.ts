import type { TerrainMacroGrid } from "@/src/workers/terrainAuthority";
import {
  isTerrainMacroEvolutionWorkerEvent,
  type TerrainMacroEvolutionPhase,
  type TerrainMacroEvolutionWorkerCommand,
} from "@/src/workers/terrainMacroEvolutionProtocol";
import type { WorldDefinition } from "@/src/world";
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_ANALYTIC_BLEND_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  terrainEvolutionTexelCenter,
  type TerrainMacroEvolutionExport,
} from "./TerrainEvolutionContract";

/**
 * Non-blocking runtime boundary for the eager production macro pass (`5-3`).
 *
 * Phase 5's plan calls for a GPU macro pass. Until that measured pipeline is
 * available, the paired worker executes TerrainMacroEvolution's deterministic
 * CPU reference instead. The main thread only starts/cancels the job, observes
 * coarse progress, and receives transferred canonical arrays; there is no
 * synchronous fallback capable of freezing startup for a 1024² evolution.
 */

export type TerrainMacroEvolutionClientState =
  | "idle"
  | "initializing"
  | "ready"
  | "failed"
  | "disposed";

export interface TerrainMacroEvolutionProgress {
  readonly phase: TerrainMacroEvolutionPhase;
  readonly completed: number;
  readonly total: number;
  readonly overallFraction: number;
}

export interface TerrainMacroEvolutionClientResult {
  readonly evolution: TerrainMacroEvolutionExport;
  /** Independent height copy suitable for transfer to SimulationClient. */
  readonly macroGrid: TerrainMacroGrid;
  readonly elapsedMilliseconds: number;
  readonly samplingElapsedMilliseconds: number;
  readonly workerGenerated: true;
}

export interface TerrainMacroEvolutionWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null;
  postMessage(message: TerrainMacroEvolutionWorkerCommand): void;
  terminate(): void;
}

export type TerrainMacroEvolutionWorkerFactory = () => TerrainMacroEvolutionWorkerLike;

export interface TerrainMacroEvolutionClientOptions {
  readonly workerFactory?: TerrainMacroEvolutionWorkerFactory;
  /** Provenance label; CPU-worker is the honest default for this deviation. */
  readonly deviceFingerprint?: string;
  readonly onProgress?: (progress: TerrainMacroEvolutionProgress) => void;
}

interface PendingInitialization {
  readonly requestId: number;
  readonly resolve: (result: TerrainMacroEvolutionClientResult) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress: ((progress: TerrainMacroEvolutionProgress) => void) | undefined;
}

const defaultWorkerFactory: TerrainMacroEvolutionWorkerFactory = () => {
  if (typeof Worker === "undefined") throw new Error("Terrain macro Worker is unavailable");
  return new Worker(
    new URL("../../../workers/terrainMacroEvolution.worker.ts", import.meta.url),
    { type: "module", name: "aerolith-terrain-macro-evolution" },
  ) as unknown as TerrainMacroEvolutionWorkerLike;
};

function cancellationError(): Error {
  const error = new Error("Terrain macro evolution was cancelled");
  error.name = "AbortError";
  return error;
}

function requireWorld(
  world: Pick<WorldDefinition, "seed" | "seedHash" | "seaLevel">,
): void {
  if (!world.seed) throw new RangeError("Terrain macro world seed must not be empty");
  if (!Number.isSafeInteger(world.seedHash)) {
    throw new RangeError("Terrain macro seed hash must be a safe integer");
  }
  if (!Number.isFinite(world.seaLevel)) {
    throw new RangeError("Terrain macro sea level must be finite");
  }
}

/**
 * Forms the simulation fallback grid at the canonical CELL-CENTRE origin.
 * Copying is the default because SimulationClient transfers its buffer while
 * page erosion and channel generation retain the canonical macro height.
 */
export function terrainMacroGridFromEvolution(
  evolution: TerrainMacroEvolutionExport,
  copyHeights = true,
): TerrainMacroGrid {
  if (evolution.contractVersion !== TERRAIN_EVOLUTION_CONTRACT_VERSION) {
    throw new RangeError("Terrain macro evolution contract version mismatch");
  }
  const expected = EVOLUTION_DOMAIN_TEXELS * EVOLUTION_DOMAIN_TEXELS;
  if (evolution.heightMeters.length !== expected) {
    throw new RangeError(`Terrain macro export requires ${expected} heights`);
  }
  const firstSample = terrainEvolutionTexelCenter({ x: 0, z: 0 });
  return Object.freeze({
    originX: firstSample.worldX,
    originZ: firstSample.worldZ,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    width: EVOLUTION_DOMAIN_TEXELS,
    height: EVOLUTION_DOMAIN_TEXELS,
    heights: copyHeights ? evolution.heightMeters.slice() : evolution.heightMeters,
    analyticBlendTexels: EVOLUTION_ANALYTIC_BLEND_TEXELS,
  });
}

export class TerrainMacroEvolutionClient {
  private readonly workerFactory: TerrainMacroEvolutionWorkerFactory;
  private readonly deviceFingerprint: string;
  private readonly onProgress: ((progress: TerrainMacroEvolutionProgress) => void) | undefined;
  private worker: TerrainMacroEvolutionWorkerLike | null = null;
  private pending: PendingInitialization | null = null;
  private nextRequestId = 1;
  private currentState: TerrainMacroEvolutionClientState = "idle";
  private currentProgress: TerrainMacroEvolutionProgress | null = null;

  constructor(options: TerrainMacroEvolutionClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.deviceFingerprint = options.deviceFingerprint ?? "cpu-worker-reference";
    this.onProgress = options.onProgress;
    if (!this.deviceFingerprint) throw new RangeError("deviceFingerprint must not be empty");
  }

  get state(): TerrainMacroEvolutionClientState {
    return this.currentState;
  }

  get progress(): TerrainMacroEvolutionProgress | null {
    return this.currentProgress;
  }

  initialize(
    world: Pick<WorldDefinition, "seed" | "seedHash" | "seaLevel">,
    onProgress?: (progress: TerrainMacroEvolutionProgress) => void,
  ): Promise<TerrainMacroEvolutionClientResult> {
    if (this.currentState === "disposed") {
      return Promise.reject(new Error("TerrainMacroEvolutionClient is disposed"));
    }
    try {
      requireWorld(world);
    } catch (error) {
      return Promise.reject(error);
    }
    this.cancelPending();
    this.detachWorker();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.currentState = "initializing";
    this.currentProgress = Object.freeze({
      phase: "sampling-uplift",
      completed: 0,
      total: EVOLUTION_DOMAIN_TEXELS,
      overallFraction: 0,
    });

    return new Promise<TerrainMacroEvolutionClientResult>((resolve, reject) => {
      this.pending = { requestId, resolve, reject, onProgress };
      try {
        const worker = this.workerFactory();
        this.worker = worker;
        worker.onmessage = this.handleMessage;
        worker.onerror = this.handleWorkerError;
        worker.onmessageerror = this.handleMessageError;
        worker.postMessage({
          type: "initialize",
          requestId,
          worldSeed: world.seed,
          seedHash: world.seedHash,
          seaLevelMeters: world.seaLevel,
          deviceFingerprint: this.deviceFingerprint,
        });
      } catch (error) {
        this.finishError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.cancelPending();
    this.detachWorker();
    this.currentProgress = null;
    this.currentState = "disposed";
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    if (!isTerrainMacroEvolutionWorkerEvent(message.data)) {
      const candidate = message.data as { readonly requestId?: unknown } | null;
      if (candidate?.requestId === this.pending?.requestId) {
        this.finishError(new Error("Terrain macro evolution Worker returned an invalid payload"));
      }
      return;
    }
    const event = message.data;
    const pending = this.pending;
    if (!pending || event.requestId !== pending.requestId) return;
    if (event.type === "progress") {
      const progress = Object.freeze({
        phase: event.phase,
        completed: event.completed,
        total: event.total,
        overallFraction: event.overallFraction,
      });
      this.currentProgress = progress;
      try {
        this.onProgress?.(progress);
        pending.onProgress?.(progress);
      } catch {
        // Observer errors never corrupt a Class-K generation already running.
      }
      return;
    }
    if (event.type === "error") {
      this.finishError(new Error(event.message));
      return;
    }
    const progress = Object.freeze({
      phase: "evolving-landscape" as const,
      completed: 1,
      total: 1,
      overallFraction: 1,
    });
    this.currentProgress = progress;
    try {
      this.onProgress?.(progress);
      pending.onProgress?.(progress);
    } catch {
      // See the progress-event path above.
    }
    let result: TerrainMacroEvolutionClientResult;
    try {
      result = Object.freeze({
        evolution: event.evolution,
        macroGrid: terrainMacroGridFromEvolution(event.evolution),
        elapsedMilliseconds: event.elapsedMilliseconds,
        samplingElapsedMilliseconds: event.samplingElapsedMilliseconds,
        workerGenerated: true as const,
      });
    } catch (error) {
      this.finishError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.pending = null;
    this.currentState = "ready";
    this.detachWorker();
    pending.resolve(result);
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    event.preventDefault();
    this.finishError(new Error(event.message || "Terrain macro evolution Worker failed"));
  };

  private readonly handleMessageError = (): void => {
    this.finishError(new Error("Terrain macro evolution result could not be deserialized"));
  };

  private finishError(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    this.currentProgress = null;
    if (this.currentState !== "disposed") this.currentState = "failed";
    this.detachWorker();
    pending?.reject(error);
  }

  private cancelPending(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(cancellationError());
  }

  private detachWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    this.worker = null;
  }
}
