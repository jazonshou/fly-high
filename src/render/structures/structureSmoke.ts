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

/** Wisps a smoking chimney emits. */
export const STRUCTURE_SMOKE_WISPS = 6;

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
 * to the anchor: puffs about a metre across at the flue, growing as they
 * climb 10-20 m (less in wind, which bends the plume over and carries it off
 * downwind), each living 7-11 s, flagged as smoke in the noise seed.
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
  const rise = (10 + 10 * s) / (1 + Math.max(0, windSpeed) / 6);
  for (let wisp = 0; wisp < count; wisp += 1) {
    const at = offset + wisp * STEAM_FLOATS_PER_WISP;
    const size = (0.8 + 0.6 * unit(flue.seed, wisp, 0)) * (0.7 + 0.3 * s);
    const lifetime = 7 + 4 * unit(flue.seed, wisp, 1);
    out[at] = flue.x - anchorX;
    out[at + 1] = flue.y;
    out[at + 2] = flue.z - anchorZ;
    out[at + 3] = size;
    out[at + 4] = Math.max(1, Math.round(STEAM_CYCLE_PERIOD_SECONDS / lifetime));
    out[at + 5] = (wisp + unit(flue.seed, wisp, 2) * 0.5) / count;
    out[at + 6] = (0.25 + 0.2 * unit(flue.seed, wisp, 3)) * s;
    out[at + 7] = rise * (0.8 + 0.4 * unit(flue.seed, wisp, 4));
    out[at + 8] = STEAM_SMOKE_SEED_OFFSET + unit(flue.seed, wisp, 5);
    out[at + 9] = (unit(flue.seed, wisp, 6) - 0.5) * 3;
    out[at + 10] = size * (0.3 + 0.5 * unit(flue.seed, wisp, 7));
    out[at + 11] = 0.8 + 0.4 * unit(flue.seed, wisp, 8);
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
