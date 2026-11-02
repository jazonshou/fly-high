import { mixSeed } from "@/src/world/seed";
import { STRUCTURE_STYLE_CLIMATE, type StructureClimate } from "@/src/world/structures/kit/kitWeathering";
import type { StructureArchetype, StructureRecord } from "@/src/world/structures/structureRecord";
import {
  STEAM_CYCLE_PERIOD_SECONDS,
  STEAM_FLOATS_PER_WISP,
  STEAM_SMOKE_SEED_OFFSET,
} from "../webgpu/volcanic/VolcanicSteamSystem";

/**
 * Chimney smoke (structures S5, High and Ultra): the lived-in sign a village
 * gives from the air. A wood stove's thin grey plume from the flue the kit
 * put on the roof (`StructureDrawnModel.chimneys`), bent over by the wind,
 * drawn as wisps of the volcanic steam's own draw and lighting
 * (`VolcanicSteamSystem.setExtraWisps`), greyed as smoke.
 *
 * WHICH. Homes and saunas only (barns and sheds have no stove), and of those
 * a share by climate, the same buildings every visit: most in the cold north,
 * fewer where it is damp, few in the tropics and the desert.
 */

/** Of the homes with a chimney, the share with a stove going, by climate. */
export const STRUCTURE_SMOKE_SHARE: Readonly<Record<StructureClimate, number>> = Object.freeze({
  cold: 0.6,
  damp: 0.4,
  humid: 0.15,
  dry: 0.1,
});

/** The archetypes with a stove. */
export const STRUCTURE_SMOKE_ARCHETYPES: ReadonlySet<StructureArchetype> = new Set<StructureArchetype>([
  "house",
  "cottage",
  "cabin",
  "station",
  "sauna",
]);

/**
 * Wisps a smoking chimney emits. A chimney's wisps share one lifetime and
 * are spaced evenly through it, so a puff leaves the flue every 0.7-1 s and,
 * at the plume's slow start, overlaps the one before: the plume reads as one,
 * not as specks.
 */
export const STRUCTURE_SMOKE_WISPS = 12;

/** Chimneys smoke within this of the camera, metres: past it a plume is a pixel or two. */
export const STRUCTURE_SMOKE_RANGE_METERS = 1_500;

/**
 * How hard a building's stove is going, 0 (none) or 0.5..1: a pure function
 * of its id, archetype and style, so the same chimneys smoke every visit.
 */
export function structureSmokeStrength(record: Pick<StructureRecord, "id" | "archetype" | "style">): number {
  if (!STRUCTURE_SMOKE_ARCHETYPES.has(record.archetype)) return 0;
  const draw = (mixSeed(record.id >>> 0, 0x534d_4f4b) >>> 0) / 4_294_967_296;
  const share = STRUCTURE_SMOKE_SHARE[STRUCTURE_STYLE_CLIMATE[record.style]];
  if (draw >= share) return 0;
  return 0.5 + 0.5 * (draw / share);
}

/** One smoking flue, world metres. */
export interface StructureSmokeFlue {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly strength: number;
  readonly seed: number;
}

/** One uniform draw in [0, 1) per (flue, wisp, lane). */
function unit(seed: number, wisp: number, lane: number): number {
  return (mixSeed(mixSeed(seed, wisp + 1), lane + 101) >>> 0) / 4_294_967_296;
}

/**
 * A flue's `count` wisp records (`writeSteamWisps`' layout), x and z relative
 * to the anchor, flagged as smoke in the noise seed. A stove's plume leaves
 * the flue slowly, a metre or two a second, as puffs a metre or two across;
 * it climbs 3-7 m in calm air and spreads to 5-8 m as it thins out. Wind
 * bends it over, carries it off downwind and breaks it up sooner, so it
 * rises less and lives shorter, which keeps the puffs overlapping however
 * fast they leave. All of a flue's wisps live the same time (8-12 s in calm
 * air) and are spaced evenly through it: lifetimes that differed would
 * drift their ages apart into clumps and gaps.
 */
export function writeStructureSmokeWisps(
  flue: StructureSmokeFlue,
  anchorX: number,
  anchorZ: number,
  windSpeed: number,
  count: number,
  out: Float32Array,
  offset: number,
): void {
  const s = flue.strength;
  const wind = Math.max(0, windSpeed);
  const rise = (4 + 2.5 * s) / (1 + wind / 5);
  const lifetime = (8 + 4 * unit(flue.seed, 0, 1)) / (1 + wind / 5);
  const cycles = Math.max(1, Math.round(STEAM_CYCLE_PERIOD_SECONDS / lifetime));
  for (let wisp = 0; wisp < count; wisp += 1) {
    const at = offset + wisp * STEAM_FLOATS_PER_WISP;
    const size = (1.8 + 0.5 * unit(flue.seed, wisp, 0)) * (0.8 + 0.2 * s);
    out[at] = flue.x - anchorX;
    out[at + 1] = flue.y;
    out[at + 2] = flue.z - anchorZ;
    out[at + 3] = size;
    out[at + 4] = cycles;
    out[at + 5] = (wisp + unit(flue.seed, wisp, 2) * 0.25) / count;
    out[at + 6] = (0.32 + 0.12 * unit(flue.seed, wisp, 3)) * (0.6 + 0.4 * s);
    out[at + 7] = rise * (0.85 + 0.3 * unit(flue.seed, wisp, 4));
    out[at + 8] = STEAM_SMOKE_SEED_OFFSET + unit(flue.seed, wisp, 5);
    out[at + 9] = (unit(flue.seed, wisp, 6) - 0.5) * 1.5;
    out[at + 10] = size * (0.1 + 0.15 * unit(flue.seed, wisp, 7));
    out[at + 11] = 0.6 + 0.3 * unit(flue.seed, wisp, 8);
  }
}

/**
 * A set build's chimneys (`StructureMeshBuild.chimneys`: x and z relative to
 * its origin, y, and the building's index in its records) as the smoking
 * flues, world metres.
 */
export function structureSmokeFlues(
  chimneys: Float32Array,
  records: readonly StructureRecord[],
  originX: number,
  originZ: number,
): StructureSmokeFlue[] {
  const flues: StructureSmokeFlue[] = [];
  for (let at = 0; at + 3 < chimneys.length; at += 4) {
    const record = records[chimneys[at + 3]!];
    if (!record) continue;
    const strength = structureSmokeStrength(record);
    if (strength <= 0) continue;
    flues.push({
      x: chimneys[at]! + originX,
      y: chimneys[at + 1]!,
      z: chimneys[at + 2]! + originZ,
      strength,
      seed: mixSeed(record.id >>> 0, at),
    });
  }
  return flues;
}
