import type { StructureMeshArrays } from "@/src/render/structures/structureMeshArrays";
import type { StructureTexturePlans } from "@/src/render/structures/structureTextures";
import type { StructureTextureEdge } from "@/src/world/structures/kit/kitTextures";
import type { StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The structures worker's messages: the main thread asks for one set's
 * arrays (`StructureSystem`'s far, near or open set), or for the kit's
 * material arrays at an edge, and the worker answers with them, every typed
 * array transferred.
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

/** The kit's material arrays, mipped and packed (`structureTexturePlans`). */
export interface StructuresWorkerTextures {
  readonly type: "textures";
  readonly id: number;
  readonly edge: StructureTextureEdge;
}

export type StructuresWorkerCommand = StructuresWorkerBuild | StructuresWorkerTextures;

export interface StructuresWorkerBuilt {
  readonly type: "built";
  readonly id: number;
  readonly opaque: StructureMeshArrays;
  readonly glass: StructureMeshArrays | null;
  /** The worker's time on it, milliseconds. */
  readonly milliseconds: number;
}

export interface StructuresWorkerTexturesMade {
  readonly type: "textures";
  readonly id: number;
  readonly plans: StructureTexturePlans;
  readonly milliseconds: number;
}

export interface StructuresWorkerError {
  readonly type: "error";
  readonly id: number;
  readonly message: string;
}

export type StructuresWorkerEvent = StructuresWorkerBuilt | StructuresWorkerTexturesMade | StructuresWorkerError;

/** Every buffer a set's arrays hold, for the transfer list. */
export function structureMeshTransfer(arrays: StructureMeshArrays | null, into: Transferable[] = []): Transferable[] {
  if (!arrays) return into;
  for (const array of [arrays.positions, arrays.normals, arrays.uvs, arrays.surface, arrays.colour, arrays.indoor, arrays.centre, arrays.indices]) {
    if (!into.includes(array.buffer)) into.push(array.buffer);
  }
  return into;
}
