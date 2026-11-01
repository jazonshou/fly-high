import { mixSeed } from "../../seed";
import type { StructureSurface } from "../structureModel";
import type { StructureArchetype, StructureRecord, StructureStyle, SettlementKind } from "../structureRecord";

/**
 * WEATHERING: buildings that have stood in their country for decades, not
 * ones fresh from the paint shop (Jason, 2026-11-01: "they should blend in
 * with the environment ... look more weathered and lived in").
 *
 * Two halves, the same on every thread and tier:
 *
 * - Here, per building, on the CPU: how worn it is (`wear`, from its id,
 *   its kind of place and its archetype: an outpost's shed more than a
 *   hamlet's house) and what its climate does to it, and its parts' colours
 *   aged by both: paint faded and chalky, bare wood silvered, roofs darkened,
 *   and every colour a little off its neighbours'. Baked into the vertex
 *   colours, so Low, which draws vertex colours only, weathers too.
 * - In the structure material's fragment stage, from the same two numbers
 *   carried on the vertices: grime laid out in the face's own metres (so it
 *   never tiles and never swims): rain streaks down walls, dirt splashed up
 *   their foot, mottled stains, moss and lichen on roofs where it is damp,
 *   rust on corrugated iron and steel.
 *
 * The climate is the building's style's (styles match the biome):
 * `damp` temperate, `cold` the boreal, tundra and alpine north (lichen, less
 * moss, frost-greyed wood), `dry` desert and savanna (sun-bleached paint,
 * dust, wood silvered hard, no moss) and `humid` the tropics (mould, moss
 * and rust).
 */

export const STRUCTURE_CLIMATES = Object.freeze(["damp", "cold", "dry", "humid"] as const);
export type StructureClimate = (typeof STRUCTURE_CLIMATES)[number];

export const STRUCTURE_STYLE_CLIMATE: Readonly<Record<StructureStyle, StructureClimate>> = Object.freeze({
  temperate: "damp",
  boreal: "cold",
  tundra: "cold",
  alpine: "cold",
  desert: "dry",
  savanna: "dry",
  tropical: "humid",
});

/** How worn a kind of place leaves its buildings, before each building's own share. */
const PLACE_WEAR: Readonly<Record<SettlementKind, number>> = Object.freeze({
  hamlet: 0.45,
  farmstead: 0.5,
  roadside: 0.45,
  outpost: 0.65,
  cabin: 0.6,
  lookout: 0.55,
  lighthouse: 0.5,
});

/** Working buildings are kept less well than homes. */
const ARCHETYPE_WEAR: Readonly<Record<StructureArchetype, number>> = Object.freeze({
  house: 0,
  cottage: 0.05,
  cabin: 0.1,
  sauna: 0.1,
  barn: 0.2,
  shed: 0.2,
  station: 0.05,
  watchtower: 0.15,
  lookout: 0.1,
  lighthouse: 0.05,
  store: 0.15,
  windmill: 0.2,
  tank: 0.2,
  mast: 0,
});

/** Wear runs 0 to 1 in this many steps (it rides the vertices as an integer). */
export const STRUCTURE_WEAR_STEPS = 15;

export interface StructureWeathering {
  /** 0 (kept like new) to 1 (long neglected), a multiple of 1 / `STRUCTURE_WEAR_STEPS`. */
  readonly wear: number;
  readonly climate: StructureClimate;
  /** The building's own seed for its colours' scatter. */
  readonly seed: number;
}

/** A building as new: what the kit drew before weathering (the shot harness's "before"). */
export const STRUCTURE_UNWEATHERED: StructureWeathering = Object.freeze({ wear: 0, climate: "damp", seed: 0 });

export function structureWeathering(record: Pick<StructureRecord, "id" | "archetype" | "style" | "settlementKind">): StructureWeathering {
  const seed = mixSeed(record.id >>> 0, 0x5745_4152);
  const own = (seed >>> 0) / 4_294_967_296;
  const wear = Math.min(1, Math.max(0.1, PLACE_WEAR[record.settlementKind] + ARCHETYPE_WEAR[record.archetype] + (own - 0.5) * 0.6));
  return {
    wear: Math.round(wear * STRUCTURE_WEAR_STEPS) / STRUCTURE_WEAR_STEPS,
    climate: STRUCTURE_STYLE_CLIMATE[record.style],
    seed,
  };
}

/** Wear and climate as one integer, 0..63: `wear step * 4 + climate`. */
export function structureWeatherCode(weathering: StructureWeathering): number {
  return Math.round(weathering.wear * STRUCTURE_WEAR_STEPS) * 4 + STRUCTURE_CLIMATES.indexOf(weathering.climate);
}

/** How a surface ages. */
type Ageing = "paint" | "wood" | "stone" | "roof" | "none";

const SURFACE_AGEING: Readonly<Record<StructureSurface, Ageing>> = Object.freeze({
  clapboard: "paint",
  boards: "wood",
  logs: "wood",
  render: "paint",
  stone: "stone",
  basalt: "stone",
  metal: "roof",
  shingle: "roof",
  tile: "roof",
  slate: "roof",
  timber: "wood",
  trim: "paint",
  plaster: "none",
  floor: "none",
  concrete: "stone",
  steel: "paint",
  window: "none",
  doorway: "none",
  fabric: "none",
  glass: "none",
});

/** Per climate: paint fading, wood silvering, overall grime. */
const CLIMATE_AGEING: Readonly<Record<StructureClimate, { fade: number; silver: number; grime: number }>> = Object.freeze({
  damp: { fade: 0.4, silver: 0.45, grime: 0.2 },
  cold: { fade: 0.35, silver: 0.55, grime: 0.16 },
  dry: { fade: 0.6, silver: 0.7, grime: 0.12 },
  humid: { fade: 0.5, silver: 0.5, grime: 0.25 },
});

/** Old white paint, linear: dull and a little yellow. */
const DULL_WHITE: readonly [number, number, number] = [0.47, 0.45, 0.39];

/** Silvered wood's grey, linear, a touch cool. */
const SILVER: readonly [number, number, number] = [0.92, 0.95, 1.0];

/**
 * A part's outdoor colour (linear RGB, written into `out`) aged by its
 * building's weathering. Parts of one colour on one building age alike, so
 * a wall cut round its windows stays one wall; a colour's scatter across
 * buildings is the building's seed's. Indoor parts and glazing are left as
 * they are (rooms are lived in, not weathered).
 */
export function weatherColour(
  r: number,
  g: number,
  b: number,
  surface: StructureSurface,
  sourceColour: number,
  weathering: StructureWeathering,
  out: [number, number, number],
): [number, number, number] {
  const ageing = SURFACE_AGEING[surface];
  const w = weathering.wear;
  if (ageing === "none" || w <= 0) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }
  const climate = CLIMATE_AGEING[weathering.climate];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let target0 = r;
  let target1 = g;
  let target2 = b;
  let amount = 0;
  let darken = climate.grime * w;
  switch (ageing) {
    case "paint": {
      // Faded and chalky: towards a lighter grey of its own tone. White
      // paint does not get whiter: it goes a dull, yellowed off-white.
      const chalk = Math.min(luminance * 1.08 + 0.03, DULL_WHITE[1]);
      const dull = Math.min(1, Math.max(0, (luminance - 0.35) / 0.3));
      target0 = chalk + (DULL_WHITE[0] - chalk) * dull;
      target1 = chalk + (DULL_WHITE[1] - chalk) * dull;
      target2 = chalk + (DULL_WHITE[2] - chalk) * dull;
      amount = climate.fade * w;
      break;
    }
    case "wood": {
      // Bare (or long-unpainted) wood silvers.
      const grey = luminance * 0.9 + 0.035;
      target0 = grey * SILVER[0];
      target1 = grey * SILVER[1];
      target2 = grey * SILVER[2];
      amount = climate.silver * w;
      break;
    }
    case "stone":
      darken += 0.06 * w;
      break;
    case "roof": {
      // Roofs darken and lose colour.
      target0 = luminance;
      target1 = luminance;
      target2 = luminance;
      amount = 0.3 * w;
      darken += 0.1 * w;
      break;
    }
  }
  // Each colour on this building a little off: the same colour elsewhere is not the same paint.
  const scatter = ((mixSeed(weathering.seed, sourceColour & 0xff_ffff) >>> 0) / 4_294_967_296 - 0.5) * (0.06 + 0.1 * w);
  const k = (1 - darken) * (1 + scatter);
  out[0] = (r + (target0 - r) * amount) * k;
  out[1] = (g + (target1 - g) * amount) * k;
  out[2] = (b + (target2 - b) * amount) * k;
  return out;
}
