import type { StructureRecord } from "@/src/world/structures/structureRecord";
import type { StructuresWorkerCommand, StructuresWorkerEvent } from "@/src/workers/structuresProtocol";
import type { StructureTextureEdge } from "@/src/world/structures/kit/kitTextures";
import type {
  StructureMeshBuild,
  StructureMeshBuilder,
  StructureSetName,
} from "../webgpu/structures/StructureSystem";
import { InlineStructureMeshBuilder, type StructureSetArrays, type StructureTextureMaker } from "./InlineStructureMeshBuilder";
import { structureTexturePlans, type StructureTexturePlans } from "./structureTextures";

/**
 * The structure renderer's builder: each set's arrays from the structures
 * worker (the building kit, off the main thread), and on the main thread
 * through the same function if no worker can be made or one fails, so the
 * buildings are drawn either way. The kit's material arrays come from a
 * worker of their own, made for the one message and ended when it answers,
 * so their second or so of synthesis never holds a set's build up.
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
  private readonly textureWorkers = new Set<{ readonly worker: StructuresWorker; readonly reject: (error: Error) => void }>();
  /** Builds answered by the worker, and on the main thread (no worker, or it failed). */
  readonly answered = { worker: 0, inline: 0 };
  /** Material arrays made by a worker, and on the main thread. */
  readonly texturesAnswered = { worker: 0, inline: 0 };

  constructor(
    arrays: StructureSetArrays,
    private readonly createWorker: StructuresWorkerFactory = defaultWorkerFactory,
    makeTextures: StructureTextureMaker = structureTexturePlans,
  ) {
    this.inline = new InlineStructureMeshBuilder(arrays, makeTextures);
  }

  textures(edge: StructureTextureEdge): Promise<StructureTexturePlans> {
    if (this.disposed) return Promise.reject(new Error("structure mesh builder disposed"));
    let worker: StructuresWorker | null = null;
    try {
      worker = this.createWorker();
    } catch {
      worker = null;
    }
    if (!worker) return this.texturesInline(edge);
    const made = worker;
    return new Promise((resolve, reject) => {
      const entry = { worker: made, reject };
      this.textureWorkers.add(entry);
      let settled = false;
      const settle = (plans: StructureTexturePlans | null) => {
        if (settled) return;
        settled = true;
        this.textureWorkers.delete(entry);
        made.terminate();
        if (plans) {
          this.texturesAnswered.worker += 1;
          resolve(plans);
          return;
        }
        // The worker could not make them: the main thread does, once.
        this.texturesInline(edge).then(resolve, reject);
      };
      made.addEventListener("message", (event: MessageEvent<StructuresWorkerEvent>) => {
        settle(event.data.type === "textures" ? event.data.plans : null);
      });
      made.addEventListener("error", () => settle(null));
      made.postMessage({ type: "textures", id: 0, edge });
    });
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
    for (const { worker, reject } of this.textureWorkers) {
      worker.terminate();
      reject(new Error("structure mesh builder disposed"));
    }
    this.textureWorkers.clear();
    for (const pending of this.pending.values()) pending.reject(new Error("structure mesh builder disposed"));
    this.pending.clear();
    this.inline.dispose();
  }

  private texturesInline(edge: StructureTextureEdge): Promise<StructureTexturePlans> {
    if (this.disposed) return Promise.reject(new Error("structure mesh builder disposed"));
    this.texturesAnswered.inline += 1;
    return this.inline.textures(edge);
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
    if (event.type === "textures") return;
    const pending = this.pending.get(event.id);
    if (!pending) return;
    this.pending.delete(event.id);
    if (event.type === "built") {
      this.answered.worker += 1;
      pending.resolve({ opaque: event.opaque, glass: event.glass, chimneys: event.chimneys });
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
