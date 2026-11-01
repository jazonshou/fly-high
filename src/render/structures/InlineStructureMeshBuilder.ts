import type { StructureRecord } from "@/src/world/structures/structureRecord";
import type {
  StructureMeshBuild,
  StructureMeshBuilder,
  StructureSetName,
} from "../webgpu/structures/StructureSystem";
import { structureSetArrays } from "./structureMeshArrays";

/**
 * A set's arrays made on the calling thread, answered on a later microtask so
 * the system sees the same order of events as with the worker: the
 * renderer's fallback when no worker can be made, and the tests' builder.
 */
export type StructureSetArrays = (
  set: StructureSetName,
  records: readonly StructureRecord[],
  originX: number,
  originZ: number,
) => StructureMeshBuild;

/** The building kit's levels: blocks far, closed shells near, open buildings with their glass. */
export const KIT_STRUCTURE_ARRAYS: StructureSetArrays = structureSetArrays;

export class InlineStructureMeshBuilder implements StructureMeshBuilder {
  private disposed = false;

  constructor(private readonly arrays: StructureSetArrays = KIT_STRUCTURE_ARRAYS) {}

  build(set: StructureSetName, records: readonly StructureRecord[], originX: number, originZ: number): Promise<StructureMeshBuild> {
    return Promise.resolve().then(() => {
      if (this.disposed) throw new Error("structure mesh builder disposed");
      return this.arrays(set, records, originX, originZ);
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}
