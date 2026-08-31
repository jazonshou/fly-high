import type { WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import type { WorldDefinition } from "@/src/world";
import {
  isTerrainErosionWorkerEvent,
  terrainErosionCommandTransferables,
  type TerrainErosionWorkerCommand,
  type TerrainErosionWorkerEvent,
} from "@/src/workers/terrainErosionProtocol";
import {
  finishTerrainErodedPageStage,
  generateTerrainErodedPage,
  prepareTerrainErosionSeedInputsStage,
  runTerrainErosionMfdStage,
  type TerrainErodedPage,
  type TerrainErosionMfdStagePayload,
  type TerrainErosionSeedInputsStage,
  type TerrainErosionSeedMode,
} from "./TerrainPageErosion";
import type { TerrainMacroEvolutionExport } from "./TerrainEvolutionContract";
import {
  buildTerrainMacroLakeField,
  type TerrainMacroLakeField,
} from "./TerrainPageHydrology";

export interface TerrainPageErosionExecutor {
  setMacroEvolution(macro: Readonly<TerrainMacroEvolutionExport> | null): void;
  generate(address: WorldPageAddress): Promise<TerrainErodedPage>;
  dispose(): void;
}

/**
 * One staged page's worker conversation (`W-1d`). The MFD stage retains state
 * (worker-side, or on this handle in the inline fallback) that the FINISH
 * stage consumes; `cancel()` releases it if the page is evicted mid-DAG.
 */
export interface TerrainStagedErosionJob {
  seedInputs(seedMode: TerrainErosionSeedMode): Promise<TerrainErosionSeedInputsStage>;
  /** Returns the deterministic MFD receiver topology for the GPU passes. */
  mfd(payload: Omit<TerrainErosionMfdStagePayload, "address">): Promise<Int32Array>;
  finish(evolvedHeight: Float32Array): Promise<TerrainErodedPage>;
  cancel(): void;
}

/** The staged extension the multi-frame GPU page producer drives. */
export interface TerrainPageStagedErosionExecutor extends TerrainPageErosionExecutor {
  stagedJob(address: WorldPageAddress): TerrainStagedErosionJob;
}

type WorkerFactory = () => Worker;
type TerrainErosionReplyEvent = Exclude<TerrainErosionWorkerEvent, { type: "error" }>;
type PendingRequest = {
  readonly resolve: (event: TerrainErosionReplyEvent) => void;
  readonly reject: (error: Error) => void;
};

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("../../../workers/terrainErosion.worker.ts", import.meta.url), {
    type: "module",
    name: "aerolith-terrain-page-erosion",
  });

export interface TerrainPageErosionClientOptions {
  readonly workerFactory?: WorkerFactory;
  /** Test/recovery seam; production uses the same pure function in the worker. */
  readonly inlineGenerate?: (
    world: Readonly<WorldDefinition>,
    macro: Readonly<TerrainMacroEvolutionExport>,
    address: WorldPageAddress,
    macroLakes?: TerrainMacroLakeField,
  ) => TerrainErodedPage;
}

/**
 * One ordered worker for the deterministic CPU-reference page pass. If worker
 * construction is unavailable, correctness is retained through the same pure
 * inline function; that fallback is intentionally slow and is not the normal
 * browser path.
 */
export class TerrainPageErosionClient implements TerrainPageStagedErosionExecutor {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private disposed = false;
  private macro: Readonly<TerrainMacroEvolutionExport> | null = null;
  private macroLakes: TerrainMacroLakeField | null = null;
  private readonly inlineGenerate: NonNullable<TerrainPageErosionClientOptions["inlineGenerate"]>;

  constructor(
    private readonly world: Readonly<WorldDefinition>,
    options: TerrainPageErosionClientOptions = {},
  ) {
    this.inlineGenerate = options.inlineGenerate ?? generateTerrainErodedPage;
    try {
      if (typeof Worker === "undefined") return;
      this.worker = (options.workerFactory ?? defaultWorkerFactory)();
      this.worker.addEventListener("message", this.handleMessage);
      this.worker.addEventListener("error", this.handleFailure);
      this.worker.addEventListener("messageerror", this.handleFailure);
      this.worker.postMessage({ type: "initialize", world } satisfies TerrainErosionWorkerCommand);
    } catch {
      this.worker = null;
    }
  }

  get usesWorker(): boolean {
    return this.worker !== null && !this.disposed;
  }

  setMacroEvolution(macro: Readonly<TerrainMacroEvolutionExport> | null): void {
    if (this.disposed) return;
    this.macro = macro;
    this.macroLakes = null;
    try {
      this.worker?.postMessage({
        type: "set-macro-evolution",
        macro,
      } satisfies TerrainErosionWorkerCommand);
    } catch {
      // Retain the macro for the correctness-first inline recovery path.
      this.handleFailure();
    }
  }

  async generate(address: WorldPageAddress): Promise<TerrainErodedPage> {
    if (this.disposed) throw new Error("Terrain page erosion client is disposed");
    const macro = this.macro;
    if (!macro) throw new Error("Terrain page erosion requires macro evolution before scheduling");
    const worker = this.worker;
    if (!worker) {
      // Yield first so callers never execute the expensive reference pass in
      // their own synchronous generation stack.
      await Promise.resolve();
      this.macroLakes ??= buildTerrainMacroLakeField(macro);
      return this.inlineGenerate(this.world, macro, address, this.macroLakes);
    }
    const event = await this.request({
      type: "erode",
      requestId: this.claimRequestId(),
      address,
    });
    if (event.type !== "page") throw new Error("Terrain erosion worker sent a mismatched reply");
    return event.page;
  }

  /**
   * Open one staged page conversation (`W-1d`). Worker path round-trips the
   * staged protocol commands; the no-Worker path runs the SAME shared stage
   * functions inline, retaining the MFD state on this handle.
   */
  stagedJob(address: WorldPageAddress): TerrainStagedErosionJob {
    const jobId = this.claimRequestId();
    let inlineRetained: {
      readonly sourceHeight: Float32Array;
      readonly breachedHeight: Float32Array;
      readonly receivers: Int32Array;
      readonly flowAccumulation: Float32Array;
      readonly erosionMask: Uint8Array;
    } | null = null;
    const job: TerrainStagedErosionJob = {
      seedInputs: async (seedMode) => {
        this.requireLive();
        if (!this.worker) {
          await Promise.resolve();
          return prepareTerrainErosionSeedInputsStage(this.world, this.macro, address, seedMode);
        }
        const event = await this.request({
          type: "erode-stage-seed-inputs",
          requestId: this.claimRequestId(),
          address,
          seedMode,
        });
        if (event.type !== "stage-seed-inputs") {
          throw new Error("Terrain erosion worker sent a mismatched seed-inputs reply");
        }
        return {
          erosionMask: event.erosionMask,
          macroHeight: event.macroHeight,
          macroFlow: event.macroFlow,
        };
      },
      mfd: async (payload) => {
        this.requireLive();
        if (!this.worker) {
          await Promise.resolve();
          const stage = runTerrainErosionMfdStage(this.world, { ...payload, address });
          inlineRetained = {
            sourceHeight: payload.sourceHeight,
            breachedHeight: stage.breachedHeight,
            receivers: stage.receivers,
            flowAccumulation: payload.flowAccumulation,
            erosionMask: payload.erosionMask,
          };
          return Int32Array.from(stage.receivers);
        }
        const event = await this.request({
          type: "erode-stage-mfd",
          requestId: jobId,
          address,
          ...payload,
        });
        if (event.type !== "stage-mfd") {
          throw new Error("Terrain erosion worker sent a mismatched MFD reply");
        }
        return event.receivers;
      },
      finish: async (evolvedHeight) => {
        this.requireLive();
        if (!this.worker) {
          await Promise.resolve();
          const retained = inlineRetained;
          if (!retained) throw new Error("Terrain erosion finish stage has no retained MFD state");
          inlineRetained = null;
          const macro = this.macro;
          if (macro) this.macroLakes ??= buildTerrainMacroLakeField(macro);
          return finishTerrainErodedPageStage({
            address,
            ...retained,
            evolvedHeight,
            macroLakes: this.macroLakes,
          });
        }
        const event = await this.request({
          type: "erode-stage-finish",
          requestId: jobId,
          evolvedHeight,
        });
        if (event.type !== "page") {
          throw new Error("Terrain erosion worker sent a mismatched finish reply");
        }
        return event.page;
      },
      cancel: () => {
        inlineRetained = null;
        if (this.disposed || !this.worker) return;
        try {
          this.worker.postMessage({
            type: "erode-cancel",
            requestId: jobId,
          } satisfies TerrainErosionWorkerCommand);
        } catch {
          this.handleFailure();
        }
      },
    };
    return job;
  }

  private requireLive(): void {
    if (this.disposed) throw new Error("Terrain page erosion client is disposed");
  }

  private claimRequestId(): number {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return requestId;
  }

  private request(
    command: Extract<TerrainErosionWorkerCommand, { requestId: number }>,
  ): Promise<TerrainErosionReplyEvent> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Terrain page erosion worker is unavailable"));
    return new Promise<TerrainErosionReplyEvent>((resolve, reject) => {
      this.pending.set(command.requestId, { resolve, reject });
      try {
        worker.postMessage(command, terrainErosionCommandTransferables(command));
      } catch (error) {
        this.pending.delete(command.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    const error = new Error("Terrain page erosion client was disposed");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isTerrainErosionWorkerEvent(event.data)) return;
    const message: TerrainErosionWorkerEvent = event.data;
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId);
    if (message.type === "error") {
      request.reject(new Error(message.message));
    } else {
      request.resolve(message);
    }
  };

  private readonly handleFailure = (): void => {
    this.worker?.terminate();
    this.worker = null;
    const error = new Error("Terrain page erosion worker became unavailable");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  };
}
