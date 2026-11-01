import { structureIndoorLight } from "@/src/world/structures/kit/kitIndoorLight";
import { StructureMeshBuilder, type StructureMeshArrays } from "@/src/world/structures/kit/kitMesh";
import { STRUCTURE_KIT } from "@/src/world/structures/kit/structureKit";
import type { StructureDrawnLevel } from "@/src/world/structures/structureModel";
import type { StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * What the structure renderer uploads for one of its meshes: many buildings
 * merged by the building kit's `StructureMeshBuilder`, flat shaded, relative
 * to a world origin (the build's; the mesh is placed at it less the floating
 * origin), every vertex carrying its building's footprint centre.
 *
 * WINDING. The kit winds each face counter-clockwise seen from the side it
 * shows (the right-hand rule); this right-handed scene's front faces are the
 * other way round (as `boatMeshData`'s note says), so every triangle is
 * stored reversed here, once, for the GPU. Drawn as the kit gives them, the
 * blocks vanish and a shell shows its inside from above.
 */
export type { StructureMeshArrays };

/** Each triangle's last two corners swapped, in place: the kit's winding to this scene's front faces. */
export function reverseStructureWinding(arrays: StructureMeshArrays): StructureMeshArrays {
  const indices = arrays.indices;
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const second = indices[corner + 1]!;
    indices[corner + 1] = indices[corner + 2]!;
    indices[corner + 2] = second;
  }
  return arrays;
}

/** Which of the kit's drawn levels each of the renderer's sets is. */
export const STRUCTURE_SET_LEVEL = Object.freeze({
  far: "block",
  near: "closed",
  open: "open",
} as const satisfies Record<string, StructureDrawnLevel>);

export type StructureSetLevelName = keyof typeof STRUCTURE_SET_LEVEL;

/** One set's arrays: the opaque mesh and, for the open set, its glass (with the rooms' indoor light per vertex). */
export function structureSetArrays(
  set: StructureSetLevelName,
  records: readonly StructureRecord[],
  originX: number,
  originZ: number,
): { readonly opaque: StructureMeshArrays; readonly glass: StructureMeshArrays | null } {
  const level = STRUCTURE_SET_LEVEL[set];
  const open = level === "open";
  const origin = { x: originX, y: 0, z: originZ };
  const opaque = new StructureMeshBuilder(open ? 16_384 : 4_096);
  const glass = open ? new StructureMeshBuilder(1_024) : null;
  for (const record of records) {
    const model = STRUCTURE_KIT.drawn(record, level);
    const light = open ? structureIndoorLight(STRUCTURE_KIT.layout(record)) : undefined;
    opaque.append(record, model.parts, origin, light);
    if (glass && model.glass.length > 0) glass.append(record, model.glass, origin);
  }
  const glassArrays = glass?.finish();
  return {
    opaque: reverseStructureWinding(opaque.finish()),
    glass: glassArrays ? reverseStructureWinding(glassArrays) : null,
  };
}
