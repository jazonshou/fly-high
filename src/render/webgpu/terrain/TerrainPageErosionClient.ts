import type { WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import type { WorldDefinition } from "@/src/world";
import {
  isTerrainErosionWorkerEvent,
  type TerrainErosionWorkerCommand,
  type TerrainErosionWorkerEvent,
} from "@/src/workers/terrainErosionProtocol";
import {
  generateTerrainErodedPage,
  type TerrainErodedPage,
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

type WorkerFactory = () => Worker;
type PendingRequest = {
  readonly resolve: (page: TerrainErodedPage) => void;
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
export class TerrainPageErosionClient implements TerrainPageErosionExecutor {
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
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<TerrainErodedPage>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        worker.postMessage({ type: "erode", requestId, address } satisfies TerrainErosionWorkerCommand);
      } catch (error) {
        this.pending.delete(requestId);
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
      request.resolve(message.page);
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
