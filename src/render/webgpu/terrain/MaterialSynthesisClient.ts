import {
  isMaterialSynthesisEvent,
  type MaterialSynthesisCommand,
  type MaterialSynthesisEvent,
} from "@/src/workers/materialSynthesisProtocol";
import type { WorldSeed } from "@/src/world/types";

/**
 * `4.5-C2b` — the main-thread half of off-thread material synthesis.
 *
 * A batch is requested once; layers arrive one at a time, in request order,
 * and are held here until the frame loop drains them. **Consumption stays
 * frame-loop-driven**, which is the pacing constraint
 * `TerrainClipmapSystem.stepMaterialArrayBuild` records: a `setTimeout` chain
 * looked equivalent and was not (it tripped the volumetric cloud system's
 * pipeline barrier during startup and never completed at all under the capture
 * harness's headless Chromium).
 *
 * The client never throws. If the worker cannot be created — no `Worker` in
 * this environment, a bundler that did not emit it, a security policy — the
 * caller keeps its inline synthesis path, which is the one the Node suite and
 * every headless tool already run.
 */

export interface MaterialSynthesisLayer {
  readonly albedoHeight: Uint8Array;
  readonly normalMaterial: Uint8Array;
}

type WorkerFactory = () => Worker;

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("../../../workers/materialSynthesis.worker.ts", import.meta.url), {
    type: "module",
    name: "aerolith-material-synthesis",
  });

export interface MaterialSynthesisClientOptions {
  readonly workerFactory?: WorkerFactory;
}

export class MaterialSynthesisClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private activeRequestId = 0;
  private activeEdge = 0;
  private readonly ready = new Map<number, MaterialSynthesisLayer>();
  private failed = false;
  private disposed = false;

  constructor(options: MaterialSynthesisClientOptions = {}) {
    try {
      if (typeof Worker === "undefined") {
        this.failed = true;
        return;
      }
      this.worker = (options.workerFactory ?? defaultWorkerFactory)();
      this.worker.addEventListener("message", this.handleMessage);
      this.worker.addEventListener("error", this.handleFailure);
      this.worker.addEventListener("messageerror", this.handleFailure);
    } catch {
      this.failed = true;
      this.worker = null;
    }
  }

  /** False once the worker has died; the caller falls back to inline synthesis. */
  get isAvailable(): boolean {
    return !this.failed && this.worker !== null && !this.disposed;
  }

  /** The edge the in-flight batch is being synthesised at, or 0 when idle. */
  get requestedEdge(): number {
    return this.activeEdge;
  }

  /**
   * Ask for every layer of a batch. A second request supersedes the first:
   * layers from a superseded batch are dropped on arrival by request id, so a
   * quality switch mid-build cannot mix two edges into one upload.
   */
  request(seed: WorldSeed, edge: number, materialIds: readonly number[]): boolean {
    if (!this.isAvailable) return false;
    this.ready.clear();
    this.activeRequestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.activeEdge = edge;
    try {
      this.worker!.postMessage({
        type: "synthesize",
        requestId: this.activeRequestId,
        seed,
        edge,
        materialIds: [...materialIds],
      } satisfies MaterialSynthesisCommand);
      return true;
    } catch {
      this.markUnavailable();
      return false;
    }
  }

  /** Take a layer if it has landed, or null. Frame-loop driven, never polled. */
  take(index: number): MaterialSynthesisLayer | null {
    const layer = this.ready.get(index);
    if (!layer) return null;
    this.ready.delete(index);
    return layer;
  }

  /** Drop the in-flight batch (a profile change superseded it). */
  cancel(): void {
    this.ready.clear();
    this.activeRequestId = 0;
    this.activeEdge = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isMaterialSynthesisEvent(event.data)) return;
    const message = event.data as MaterialSynthesisEvent;
    if (message.requestId !== this.activeRequestId) return;
    if (message.type === "error") {
      this.markUnavailable();
      return;
    }
    this.ready.set(message.index, {
      albedoHeight: message.albedoHeight,
      normalMaterial: message.normalMaterial,
    });
  };

  private readonly handleFailure = (): void => {
    this.markUnavailable();
  };

  private markUnavailable(): void {
    this.failed = true;
    this.ready.clear();
    this.activeRequestId = 0;
    this.activeEdge = 0;
    this.worker?.terminate();
    this.worker = null;
  }
}
