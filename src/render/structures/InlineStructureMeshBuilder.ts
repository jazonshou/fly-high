import type { StructureRecord } from "@/src/world/structures/structureRecord";
import type {
  StructureMeshBuild,
  StructureMeshBuilder,
  StructureSetName,
} from "../webgpu/structures/StructureSystem";
import type { StructureTextureEdge } from "@/src/world/structures/kit/kitTextures";
import { structureSetArrays } from "./structureMeshArrays";
import { structureTexturePlans, type StructureTexturePlans } from "./structureTextures";

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
  /** False draws the buildings as new, unweathered (the shots' "before"). */
  weathered?: boolean,
) => StructureMeshBuild;

/** The building kit's levels: blocks far, closed shells near, open buildings with their glass. */
export const KIT_STRUCTURE_ARRAYS: StructureSetArrays = structureSetArrays;

/** The kit's material arrays at an edge, mipped and packed. */
export type StructureTextureMaker = (edge: StructureTextureEdge) => StructureTexturePlans;

export class InlineStructureMeshBuilder implements StructureMeshBuilder {
  private disposed = false;

  constructor(
    private readonly arrays: StructureSetArrays = KIT_STRUCTURE_ARRAYS,
    private readonly makeTextures: StructureTextureMaker = structureTexturePlans,
  ) {}

  textures(edge: StructureTextureEdge): Promise<StructureTexturePlans> {
    return Promise.resolve().then(() => {
      if (this.disposed) throw new Error("structure mesh builder disposed");
      return this.makeTextures(edge);
    });
  }

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
