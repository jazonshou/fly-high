/**
 * One generated building, as plain data: what the settlement layout
 * (`src/world/settlements/`) writes and every consumer reads. The renderer
 * draws it, the simulation makes it solid, the night lights light it; each
 * expands the same record through the same building kit, so what is drawn is
 * what is hit.
 *
 * A record is a pure function of its site (the road network, the ground
 * before earthworks and the climate), so the same seed gives the same house
 * whichever way the observer arrives and on every quality tier. It crosses to
 * the workers by structured clone inside its streamed infrastructure region
 * (`InfrastructureRegion.structures`), so it holds numbers and strings only.
 *
 * THE BUILDING FRAME. Every part the kit makes is written in the building's
 * own frame: origin at the footprint's centre on the ground floor's level
 * (`floorY`), +y up, +z out of the front (the side with the main door), +x to
 * the right of someone standing inside looking out of the front. A point
 * (lx, ly, lz) in it is, in the world,
 *
 *   x = record.x + lx cos(heading) + lz sin(heading)
 *   y = record.floorY + ly
 *   z = record.z - lx sin(heading) + lz cos(heading)
 *
 * which is a rotation by `heading` clockwise about +y seen from above (the
 * airports' convention): heading 0 faces world north (+z), pi / 2 east (+x).
 */

/** The regional accents of the one building family (the plan's "Styles per biome"). */
export const STRUCTURE_STYLES = Object.freeze([
  "temperate",
  "boreal",
  "tundra",
  "alpine",
  "desert",
  "savanna",
  "tropical",
] as const);

export type StructureStyle = (typeof STRUCTURE_STYLES)[number];

/**
 * What a building is: the kit's type, which picks its floor plans, storeys
 * and parts. The first eleven are buildings a person can walk into; the last
 * three are yard and station props (solid, not enterable).
 */
export const STRUCTURE_ARCHETYPES = Object.freeze([
  /** Two storeys (one in the high desert): kitchen and living room below, bedrooms above, a stair. */
  "house",
  /** One storey, two or three rooms: the keeper's cottage, a tundra house. */
  "cottage",
  /** One or two rooms: stove, bunk, table. */
  "cabin",
  /** One room with a stove and benches, by water. */
  "sauna",
  /** One open hall with stalls; the big doors stand open. */
  "barn",
  /** One room with a workbench. */
  "shed",
  /** An outpost's main building: office and bunk room. */
  "station",
  /** An outpost's tower: outside stairs to a roofed platform. */
  "watchtower",
  /** A fire lookout: outside flights with landings up a tower to a cab with windows all round. */
  "lookout",
  /** Straight flights round a square shaft to the lamp room and its gallery. */
  "lighthouse",
  /** A ranch's store or an outpost's store room: one room. */
  "store",
  /** A ranch's windmill pump. */
  "windmill",
  /** A steel water tank on a stand. */
  "tank",
  /** A weather station's lattice mast, with red obstruction lights. */
  "mast",
] as const);

export type StructureArchetype = (typeof STRUCTURE_ARCHETYPES)[number];

/** Archetypes a person can walk into. */
export const ENTERABLE_STRUCTURE_ARCHETYPES: ReadonlySet<StructureArchetype> = new Set<StructureArchetype>([
  "house",
  "cottage",
  "cabin",
  "sauna",
  "barn",
  "shed",
  "station",
  "watchtower",
  "lookout",
  "lighthouse",
  "store",
]);

/**
 * What carries the ground floor. A `plinth` building stands on a graded pad
 * (the infrastructure stage levels its footprint at the pad's level), so its
 * plinth or piers are the same height all round. A `posts` building sits on
 * the ground as it lies, on posts or piles long enough to reach it under
 * every corner.
 */
export type StructureFoundation = "plinth" | "posts";

/** The kinds of site a settlement grows from (the plan's "Where structures go"). */
export const SETTLEMENT_KINDS = Object.freeze([
  "hamlet",
  "farmstead",
  "roadside",
  "outpost",
  "cabin",
  "lookout",
  "lighthouse",
] as const);

export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

export interface StructureRecord {
  /**
   * Stable id, unique across the world: a hash of the settlement's site key
   * and the building's place in it. What the renderer keys meshes by and the
   * night lights seed flicker from.
   */
  readonly id: number;
  readonly archetype: StructureArchetype;
  readonly style: StructureStyle;
  /** Footprint centre, world metres. */
  readonly x: number;
  readonly z: number;
  /** The way the front faces, clockwise from world north (+z), radians (see the building frame above). */
  readonly heading: number;
  /** The main body's footprint across the front (x) and front to back (z), metres; porches and eaves extra. */
  readonly width: number;
  readonly depth: number;
  /** Floors above ground (towers count their levels); the kit's type bounds it. */
  readonly storeys: number;
  /** The ground floor's level, world Y metres: the building frame's origin. */
  readonly floorY: number;
  /**
   * Where foundations stop, world Y metres: the pad's level less a little for
   * a `plinth`; under the lowest ground beneath the footprint for `posts`.
   * Foundations run from here up to `floorY`, so they always meet the ground.
   */
  readonly baseY: number;
  /**
   * The ground where the front steps land, world Y metres: the pad's level
   * for a `plinth`, the ground in front of the door for `posts`. The kit
   * steps down from `floorY` to it (`structureStepCount`).
   */
  readonly entryY: number;
  readonly foundation: StructureFoundation;
  /** Variation seed: floor plan, mirroring, colours, details. */
  readonly seed: number;
  /** The settlement's id, shared by all its buildings. */
  readonly settlement: number;
  readonly settlementKind: SettlementKind;
  /** Basalt plinth, walls and field walls: the local stone on volcanic ground. */
  readonly basalt: boolean;
}

/**
 * A building-frame point to the world: x and z of the point (lx, lz) and the
 * world Y of a building-frame height `ly`. `out` is returned.
 */
export function structureToWorld(
  record: Pick<StructureRecord, "x" | "z" | "heading" | "floorY">,
  lx: number,
  ly: number,
  lz: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const c = Math.cos(record.heading);
  const s = Math.sin(record.heading);
  out.x = record.x + lx * c + lz * s;
  out.y = record.floorY + ly;
  out.z = record.z - lx * s + lz * c;
  return out;
}

/** A world point to the building frame (the inverse of `structureToWorld`). `out` is returned. */
export function worldToStructure(
  record: Pick<StructureRecord, "x" | "z" | "heading" | "floorY">,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const c = Math.cos(record.heading);
  const s = Math.sin(record.heading);
  const dx = x - record.x;
  const dz = z - record.z;
  out.x = dx * c - dz * s;
  out.y = y - record.floorY;
  out.z = dx * s + dz * c;
  return out;
}
