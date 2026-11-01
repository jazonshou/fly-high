import { structureIndoorLight } from "@/src/world/structures/kit/kitIndoorLight";
import { StructureMeshBuilder, type StructureMeshArrays } from "@/src/world/structures/kit/kitMesh";
import { STRUCTURE_KIT } from "@/src/world/structures/kit/structureKit";
import type { StructureDrawnLevel } from "@/src/world/structures/structureModel";
import type { StructureArchetype, StructureRecord } from "@/src/world/structures/structureRecord";
import { structureWeatherCode, structureWeathering } from "@/src/world/structures/kit/kitWeathering";
import { structureLampThreshold } from "./structureNightLighting";
import { structureBuildingCodeOffset } from "./structureSurfaceCode";

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

/**
 * The archetypes built of thin members: the windmill's and mast's 4-5 cm
 * rods and the towers' 8-12 cm braces fall under a pixel well inside the
 * near radius, where a lattice shimmers as dotted lines, so these hand over
 * to their blocks (a solid silhouette) sooner than a house does, at
 * `STRUCTURE_THIN_NEAR_METERS` (the kit thread's note, measured on its
 * shots: at 150 m the lattice still reads, at 250 m it is speckle).
 */
export const STRUCTURE_THIN_ARCHETYPES: ReadonlySet<StructureArchetype> = new Set(["windmill", "mast", "watchtower", "lookout"]);

/**
 * Where a thin-member building's closed shell hands over to its block: the
 * profile's near radius, or this if nearer.
 */
export const STRUCTURE_THIN_NEAR_METERS = 250;

/**
 * The indoor value a far or near vertex of a thin-member building carries:
 * those levels have no rooms (their indoor is 0 everywhere), so a negative
 * value is free to tell the vertex stage which handoff radius is the
 * building's. It reads as outdoors everywhere else.
 */
export const STRUCTURE_THIN_INDOOR = -1;

/**
 * One set's arrays: the opaque mesh and, for the open set, its glass (with
 * the rooms' indoor light per vertex). Every building is weathered
 * (`structureWeathering`: its outdoor colours aged here, its grime in the
 * shader), and every opaque vertex's surface is its code
 * (`structureSurfaceCode`): the surface id, its building's lamp threshold
 * (which the vertex stage compares with the night's lit share) and its
 * weather. The glass never lights or weathers and keeps bare ids.
 * `weathered` false draws the buildings as new (the shots' "before").
 */
export function structureSetArrays(
  set: StructureSetLevelName,
  records: readonly StructureRecord[],
  originX: number,
  originZ: number,
  weathered = true,
): { readonly opaque: StructureMeshArrays; readonly glass: StructureMeshArrays | null } {
  const level = STRUCTURE_SET_LEVEL[set];
  const open = level === "open";
  const origin = { x: originX, y: 0, z: originZ };
  const opaque = new StructureMeshBuilder(open ? 16_384 : 4_096);
  const glass = open ? new StructureMeshBuilder(1_024) : null;
  const thin: [number, number][] = [];
  // Each building's vertex range and its code offset (lamp threshold and weather).
  const codes: [number, number, number][] = [];
  for (const record of records) {
    const model = STRUCTURE_KIT.drawn(record, level);
    const light = open ? structureIndoorLight(STRUCTURE_KIT.layout(record)) : undefined;
    const first = opaque.vertices;
    const weathering = weathered ? structureWeathering(record) : undefined;
    opaque.append(record, model.parts, origin, light, weathering);
    if (!open && STRUCTURE_THIN_ARCHETYPES.has(record.archetype)) thin.push([first, opaque.vertices]);
    const offset = structureBuildingCodeOffset(structureLampThreshold(record), weathering ? structureWeatherCode(weathering) : 0);
    if (offset > 0) codes.push([first, opaque.vertices, offset]);
    if (glass && model.glass.length > 0) glass.append(record, model.glass, origin);
  }
  const glassArrays = glass?.finish();
  const opaqueArrays = opaque.finish();
  for (const [first, end] of thin) opaqueArrays.indoor.fill(STRUCTURE_THIN_INDOOR, first, end);
  const surface = opaqueArrays.surface;
  for (const [first, end, offset] of codes) {
    for (let vertex = first; vertex < end; vertex += 1) surface[vertex] = surface[vertex]! + offset;
  }
  return {
    opaque: reverseStructureWinding(opaqueArrays),
    glass: glassArrays ? reverseStructureWinding(glassArrays) : null,
  };
}
