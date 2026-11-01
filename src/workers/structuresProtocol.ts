import type { StructureMeshArrays } from "@/src/render/structures/structureMeshArrays";
import type { StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The structures worker's messages: the main thread asks for one set's
 * arrays (`StructureSystem`'s far, near or open set), the worker answers with
 * them, every typed array transferred.
 */

export type StructuresWorkerSet = "far" | "near" | "open";

export interface StructuresWorkerBuild {
  readonly type: "build";
  readonly id: number;
  readonly set: StructuresWorkerSet;
  readonly records: readonly StructureRecord[];
  readonly originX: number;
  readonly originZ: number;
}

export type StructuresWorkerCommand = StructuresWorkerBuild;

export interface StructuresWorkerBuilt {
  readonly type: "built";
  readonly id: number;
  readonly opaque: StructureMeshArrays;
  readonly glass: StructureMeshArrays | null;
  /** The worker's time on it, milliseconds. */
  readonly milliseconds: number;
}

export interface StructuresWorkerError {
  readonly type: "error";
  readonly id: number;
  readonly message: string;
}

export type StructuresWorkerEvent = StructuresWorkerBuilt | StructuresWorkerError;

/** Every buffer a set's arrays hold, for the transfer list. */
export function structureMeshTransfer(arrays: StructureMeshArrays | null, into: Transferable[] = []): Transferable[] {
  if (!arrays) return into;
  for (const array of [arrays.positions, arrays.normals, arrays.uvs, arrays.surface, arrays.colour, arrays.indoor, arrays.centre, arrays.indices]) {
    if (!into.includes(array.buffer)) into.push(array.buffer);
  }
  return into;
}
