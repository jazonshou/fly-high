import type { StructureRecord } from "@/src/world/structures/structureRecord";
import type { StructuresWorkerCommand, StructuresWorkerEvent } from "@/src/workers/structuresProtocol";
import type {
  StructureMeshBuild,
  StructureMeshBuilder,
  StructureSetName,
} from "../webgpu/structures/StructureSystem";
import { InlineStructureMeshBuilder, type StructureSetArrays } from "./InlineStructureMeshBuilder";

/**
 * The structure renderer's builder: each set's arrays from the structures
 * worker (the building kit, off the main thread), and on the main thread
 * through the same function if no worker can be made or one fails, so the
 * buildings are drawn either way.
 */

/** The part of a `Worker` the builder uses (a fake in tests). */
export interface StructuresWorker {
  postMessage(command: StructuresWorkerCommand): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<StructuresWorkerEvent>) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
}

export type StructuresWorkerFactory = () => StructuresWorker | null;

const defaultWorkerFactory: StructuresWorkerFactory = () => {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("../../workers/structures.worker.ts", import.meta.url), {
    type: "module",
    name: "fly-high-structures",
  }) as unknown as StructuresWorker;
};

interface Pending {
  readonly resolve: (build: StructureMeshBuild) => void;
  readonly reject: (error: Error) => void;
  readonly set: StructureSetName;
  readonly records: readonly StructureRecord[];
  readonly originX: number;
  readonly originZ: number;
}

export class WorkerStructureMeshBuilder implements StructureMeshBuilder {
  private worker: StructuresWorker | null = null;
  private failed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly inline: InlineStructureMeshBuilder;
  private disposed = false;
  /** Builds answered by the worker, and on the main thread (no worker, or it failed). */
  readonly answered = { worker: 0, inline: 0 };

  constructor(arrays: StructureSetArrays, private readonly createWorker: StructuresWorkerFactory = defaultWorkerFactory) {
    this.inline = new InlineStructureMeshBuilder(arrays);
  }

  build(set: StructureSetName, records: readonly StructureRecord[], originX: number, originZ: number): Promise<StructureMeshBuild> {
    if (this.disposed) return Promise.reject(new Error("structure mesh builder disposed"));
    const worker = this.ensureWorker();
    if (!worker) return this.buildInline(set, records, originX, originZ);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, set, records, originX, originZ });
      worker.postMessage({ type: "build", id, set, records, originX, originZ });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error("structure mesh builder disposed"));
    this.pending.clear();
    this.inline.dispose();
  }

  private buildInline(set: StructureSetName, records: readonly StructureRecord[], originX: number, originZ: number): Promise<StructureMeshBuild> {
    this.answered.inline += 1;
    return this.inline.build(set, records, originX, originZ);
  }

  private ensureWorker(): StructuresWorker | null {
    if (this.worker || this.failed) return this.worker;
    let worker: StructuresWorker | null = null;
    try {
      worker = this.createWorker();
    } catch {
      worker = null;
    }
    if (!worker) {
      this.failed = true;
      return null;
    }
    worker.addEventListener("message", (event: MessageEvent<StructuresWorkerEvent>) => this.receive(event.data));
    worker.addEventListener("error", () => this.fail());
    this.worker = worker;
    return worker;
  }

  private receive(event: StructuresWorkerEvent): void {
    const pending = this.pending.get(event.id);
    if (!pending) return;
    this.pending.delete(event.id);
    if (event.type === "built") {
      this.answered.worker += 1;
      pending.resolve({ opaque: event.opaque, glass: event.glass });
      return;
    }
    // One build the kit could not make: the main thread tries the same records.
    this.buildInline(pending.set, pending.records, pending.originX, pending.originZ).then(pending.resolve, pending.reject);
  }

  /** The worker died: everything it held, and everything after, is built here. */
  private fail(): void {
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
    const held = [...this.pending.values()];
    this.pending.clear();
    for (const pending of held) {
      this.buildInline(pending.set, pending.records, pending.originX, pending.originZ).then(pending.resolve, pending.reject);
    }
  }
}
