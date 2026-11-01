import type { StructureArchetype, StructureRecord, StructureStyle } from "./structureRecord";

/**
 * The shared numbers between the settlement layout and the building kit:
 * each archetype's body, its porch and its steps, and the envelope that
 * holds every part the kit makes. The layout sizes pads, clearings and the
 * gaps between buildings from the envelope; the kit is tested to stay
 * inside it. Building-frame metres (`structureRecord.ts`).
 */

/** The walker's stair (the plan's contract): riser and tread, metres. */
export const STRUCTURE_STAIR_RISE = 0.18;
export const STRUCTURE_STAIR_TREAD = 0.28;
/** Narrowest a stair or a door's clear opening may be, metres. */
export const STRUCTURE_STAIR_MIN_WIDTH = 0.9;
export const STRUCTURE_DOOR_WIDTH = 0.9;
export const STRUCTURE_DOOR_HEIGHT = 2.0;
/** Lowest ceiling over any room, metres. */
export const STRUCTURE_MIN_CEILING = 2.4;
/** Railings' height above the floor they guard, metres. */
export const STRUCTURE_RAILING_HEIGHT = 1.0;

/** How far the roof's eaves overhang the walls, metres. */
export const STRUCTURE_EAVE_OVERHANG = 0.6;

/** A front porch's depth, metres (0: none). */
export function structurePorchDepth(archetype: StructureArchetype, style: StructureStyle): number {
  switch (archetype) {
    case "house":
      return style === "savanna" || style === "tropical" || style === "desert" ? 2.6 : 2.2;
    case "cottage":
    case "station":
      return 1.8;
    case "cabin":
      return style === "tundra" ? 0 : 1.6;
    default:
      return 0;
  }
}

/**
 * A body's default size across the front and front to back, metres, for
 * archetypes whose size is not the style's house (`SettlementStyleRule.house`).
 */
export const STRUCTURE_BODY: Readonly<Record<Exclude<StructureArchetype, "house">, readonly [number, number]>> = Object.freeze({
  cottage: [8, 6],
  cabin: [6.5, 5],
  sauna: [4, 3.5],
  barn: [15, 10],
  shed: [6, 4.5],
  station: [11, 7],
  store: [6, 5],
  watchtower: [4, 4],
  lookout: [5, 5],
  lighthouse: [5, 5],
  windmill: [3, 3],
  tank: [3, 3],
  mast: [2.5, 2.5],
});

/**
 * Where the front steps start, out from the body's front wall, metres: the
 * porch's edge, or the wall itself.
 */
export function structureStepsStart(record: Pick<StructureRecord, "archetype" | "style" | "depth">): number {
  return record.depth * 0.5 + structurePorchDepth(record.archetype, record.style);
}

/** How many risers the front steps take from the floor down to `entryY`. */
export function structureStepCount(record: Pick<StructureRecord, "floorY" | "entryY">): number {
  return Math.max(0, Math.round((record.floorY - record.entryY) / STRUCTURE_STAIR_RISE));
}

/** How far the front steps run out from where they start, metres (the last riser lands on the ground). */
export function structureStepsRun(record: Pick<StructureRecord, "floorY" | "entryY">): number {
  return structureStepCount(record) * STRUCTURE_STAIR_TREAD;
}

/** A building's envelope in its own frame: every part the kit makes lies inside it. */
export interface StructureEnvelope {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * The envelope: the body, the eaves all round, the porch and the front
 * steps out of the front, and the outside stairs a tower climbs by.
 */
export function structureEnvelope(
  record: Pick<StructureRecord, "archetype" | "style" | "width" | "depth" | "floorY" | "entryY">,
): StructureEnvelope {
  const halfW = record.width * 0.5 + STRUCTURE_EAVE_OVERHANG;
  const halfD = record.depth * 0.5 + STRUCTURE_EAVE_OVERHANG;
  const front = Math.max(halfD, structureStepsStart(record) + structureStepsRun(record));
  switch (record.archetype) {
    case "watchtower":
    case "lookout":
      // Flights wind round the tower's legs: a stair's width out on every side.
      return { minX: -halfW - 1.6, maxX: halfW + 1.6, minZ: -halfD - 1.6, maxZ: Math.max(front, halfD + 1.6) };
    case "windmill":
    case "tank":
    case "mast":
      return { minX: -halfW, maxX: halfW, minZ: -halfD, maxZ: halfD };
    default:
      return { minX: -halfW, maxX: halfW, minZ: -halfD, maxZ: front };
  }
}
