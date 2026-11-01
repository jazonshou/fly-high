import type { StructureRecord } from "./structureRecord";

/**
 * What the building kit makes of a `StructureRecord`: plain parts in the
 * building frame (`structureRecord.ts`), which the renderer merges into its
 * meshes and the simulation turns into colliders. The kit is a pure
 * function of the record, so every consumer that expands the same record
 * gets the same building; nothing here depends on Babylon.
 *
 * THREE DRAWN LEVELS (the plan's "Drawing it" and "Inside the buildings"):
 *
 *   closed  the near set's shell: walls, roof, porch, steps, foundations and
 *           trims, windows as flush dark glazing (`window`, which glows at
 *           night) and doorways as dark panels (`doorway`). No inside.
 *   open    the same shell with real openings, plus every room: floors,
 *           ceilings, partitions, stairs, railings, furniture, door leaves
 *           swung open; and, apart, the window glass. Drawn only within
 *           about 40 m of the camera.
 *   block   the far set's 20-60 triangles: walls, roof, chimney.
 *
 * Colliders, rooms and portals always come from the open building: world
 * content is the same at every distance and on every tier.
 */

/**
 * What a face shows: the pattern and the colour family the structure
 * material paints. Order is the id the mesh carries (`structureSurfaceId`):
 * append, never reorder.
 */
export const STRUCTURE_SURFACES = Object.freeze([
  /** Painted horizontal lap boards. */
  "clapboard",
  /** Vertical board-and-batten. */
  "boards",
  "logs",
  /** Stucco or render, outside. */
  "render",
  "stone",
  "basalt",
  /** Corrugated sheet. */
  "metal",
  "shingle",
  "tile",
  "slate",
  /** Beams, posts, decks, frames, ladders: bare or dark-stained wood. */
  "timber",
  /** Painted window and door frames, fascias, barge boards. */
  "trim",
  /** Inside walls and ceilings. */
  "plaster",
  /** Floorboards. */
  "floor",
  "concrete",
  /** Painted steel: lattice towers, tanks, windmill vanes. */
  "steel",
  /** A closed shell's glazing: dark glass, lit at night by the building's glow. */
  "window",
  /** A closed shell's open doorway: the dark inside. */
  "doorway",
  /** Bedding, cushions, curtains. */
  "fabric",
  /** Window glass (the open building's glass mesh only). */
  "glass",
] as const);

export type StructureSurface = (typeof STRUCTURE_SURFACES)[number];

const SURFACE_IDS = new Map<StructureSurface, number>(STRUCTURE_SURFACES.map((surface, id) => [surface, id]));

export function structureSurfaceId(surface: StructureSurface): number {
  return SURFACE_IDS.get(surface)!;
}

/**
 * A box: centre and three half-extent vectors (orthogonal, building frame),
 * so a pitched roof slab or a door leaf swung open is a box too.
 */
export interface StructureBoxPart {
  readonly kind: "box";
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Half-extent vectors: u (local x), v (local y), w (local z). */
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
  readonly surface: StructureSurface;
  /** Albedo, 0xRRGGBB in sRGB. */
  readonly colour: number;
  /**
   * Faces drawn: +u 1, -u 2, +v 4, -v 8, +w 16, -w 32 (all 63). A face the
   * kit knows is hidden (against a wall, in the ground) is left out.
   */
  readonly faces: number;
  /**
   * 0 for an outside face; inside, the share of the sky its room sees
   * through the windows and doors (the baked indoor light, which also
   * switches the sun off), in (0, 1].
   */
  readonly indoor: number;
}

/** A flat convex polygon, one-sided: a gable, a hip roof's face, a roof's underside. */
export interface StructurePolygonPart {
  readonly kind: "polygon";
  /** Corners as x, y, z triples, counter-clockwise seen from the side that is drawn. */
  readonly points: readonly number[];
  readonly surface: StructureSurface;
  readonly colour: number;
  readonly indoor: number;
}

export type StructurePart = StructureBoxPart | StructurePolygonPart;

/** What a collider's contact reports, so a car's hull and a walker's feet can tell them apart. */
export type StructureColliderMaterial = "timber" | "stone" | "metal" | "fence" | "glass";

/** A solid box, building frame; half extents as in `StructureBoxPart`. */
export interface StructureColliderBox {
  readonly kind: "box";
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
  readonly material: StructureColliderMaterial;
}

/** Posts, railings, ladder rails: a segment swept by a radius, building frame. */
export interface StructureColliderCapsule {
  readonly kind: "capsule";
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly radius: number;
  readonly material: StructureColliderMaterial;
}

export type StructureCollider = StructureColliderBox | StructureColliderCapsule;

/**
 * A room's extent for the walker: a box, axis-aligned in the building
 * frame, from its storey's floor to its ceiling (one over a stairwell, so a
 * camera on the stairs counts as indoors). The walker caps its camera boom at
 * 2 m inside one and gives footsteps and sound a room.
 */
export interface StructureInteriorVolume {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly room: string;
}

/**
 * A doorway, building frame: the centre of its sill, the way out (the
 * outward normal, horizontal), its clear width and height. Doors stand open
 * from the first version; closing them waits for walking-mode interactions.
 */
export interface StructurePortal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
  readonly width: number;
  readonly height: number;
  readonly open: boolean;
  /** An outside door, or a door between two rooms. */
  readonly outside: boolean;
}

/** A window that glows at night: its centre and outward normal, building frame, and its size, metres. */
export interface StructureWindowLight {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
  readonly width: number;
  readonly height: number;
}

/** Everything about one building that is not drawn: what is solid, where its rooms and doors are, which windows glow. */
export interface StructureLayoutModel {
  readonly colliders: readonly StructureCollider[];
  readonly volumes: readonly StructureInteriorVolume[];
  readonly portals: readonly StructurePortal[];
  readonly windows: readonly StructureWindowLight[];
}

/** A chimney's flue: the top centre of its stack or stovepipe, building frame, where its smoke leaves. */
export interface StructureChimney {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** One drawn level of a building. */
export interface StructureDrawnModel {
  readonly parts: readonly StructurePart[];
  /** The open level's window glass, drawn in its own transparent mesh; empty for the others. */
  readonly glass: readonly StructurePart[];
  /** Its chimneys' flues, the same at every level. */
  readonly chimneys: readonly StructureChimney[];
}

export type StructureDrawnLevel = "closed" | "open" | "block";

/**
 * The building kit's entry points (`src/world/structures/kit/`): pure
 * functions of the record, the same on every thread.
 */
export interface StructureKit {
  drawn(record: StructureRecord, level: StructureDrawnLevel): StructureDrawnModel;
  layout(record: StructureRecord): StructureLayoutModel;
}
