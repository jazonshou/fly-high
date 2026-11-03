import { STOREY_HEIGHT } from "@/src/world/structures/kit/kitPlan";
import { KitChannel, KitRandom } from "@/src/world/structures/kit/kitRandom";
import type { StructureArchetype, StructureRecord } from "@/src/world/structures/structureRecord";
import { AIRFIELD_LAMP_SCENE_SCALE } from "../webgpu/lighting/AirfieldLighting";
import type { LightPointFixture } from "../webgpu/lighting/LightPoints";
import { OBSTRUCTION_LIGHT_CANDELA, OBSTRUCTION_LIGHT_RGB } from "../webgpu/lighting/ObstructionLighting";
import {
  STRUCTURE_GLASS_SHARE,
  STRUCTURE_LAMP_KIND,
  STRUCTURE_LAMP_RGB,
  STRUCTURE_SCENE_UNIT_TO_NITS,
  STRUCTURE_WINDOW_NITS,
  structureLampLit,
  structureLampThreshold,
} from "./structureNightLighting";

/**
 * The buildings' lights as light points (structures S5): what a village
 * looks like at night from further off than its windows are drawn.
 *
 * WINDOWS. Within the near radius a building is a shell and its lit windows
 * glow on it (`StructureMaterialPlugin`). Past it the building is a block
 * with no windows, so its windows' light becomes four points, one off each
 * wall at window height facing out (a hemisphere each), carrying that side's
 * glazing's light. They come in exactly as the blocks do across the handoff
 * band and go out with them at the far radius (`structureWindowLampShare`,
 * the far set's own share), so the light handed from the shells' windows to
 * the points is the same light, not a second copy. A building's points are
 * lit when its windows are (`structureLampLit`, the same threshold).
 *
 * The points are PHOTOMETRIC, on purpose unlike the airfield's: a side's
 * windows emit `STRUCTURE_WINDOW_NITS` over its glazed area, and the point
 * carries that flux, at the reference output (1280 px across the camera's
 * 62 degrees), in the same scene units as the windows drawn on the shells.
 * So a house's light does not jump as it crosses the near radius. The
 * airfield's lamps carry `AIRFIELD_LAMP_SCENE_SCALE`, a perceptual boost
 * thousands of times that for signal lights that must read at range; a
 * window is not a signal light.
 *
 * SIGNAL LIGHTS. The weather mast's two red obstruction lights (the kit's red
 * boxes at its top and halfway up) and the lighthouse's lamp ARE signal
 * lights: on at every range the building is drawn at, at the airfield's
 * scale, the mast's steady and the lighthouse's flashing.
 */

/** The output the window points' photometry is matched at: 1280 px across the camera's 62 degree horizontal field. */
export const STRUCTURE_LAMP_REFERENCE_PIXELS_PER_RADIAN = 1280 / ((62 * Math.PI) / 180);

/** A light point's integrated profile over its quad, in units of its rendered radius squared (`exp(-4.5 r^2)` over the unit disc). */
export const LIGHT_POINT_PROFILE_INTEGRAL = (Math.PI * (1 - Math.exp(-4.5))) / 4.5;

/**
 * Candela to a window point's scene intensity: a point's flux on screen is
 * its intensity over distance squared times `LIGHT_POINT_PROFILE_INTEGRAL`
 * (pixels x scene units), and a window's is its radiance in scene units times
 * the pixels it covers, `area x (pixels per radian / distance)^2`.
 */
export const STRUCTURE_WINDOW_POINT_SCALE = STRUCTURE_LAMP_REFERENCE_PIXELS_PER_RADIAN ** 2
  / (STRUCTURE_SCENE_UNIT_TO_NITS * LIGHT_POINT_PROFILE_INTEGRAL);

/**
 * Glazed area over wall area, by archetype: measured over the kit's own
 * shells (every style, two seeds, the usual sizes). The watchtower has none
 * (an open platform); the windmill, tank and mast are never lit.
 */
export const STRUCTURE_GLAZING: Readonly<Record<StructureArchetype, number>> = Object.freeze({
  house: 0.091,
  cottage: 0.114,
  cabin: 0.107,
  sauna: 0.022,
  barn: 0.027,
  shed: 0.049,
  station: 0.101,
  watchtower: 0,
  lookout: 0.082,
  lighthouse: 0.154,
  store: 0.04,
  windmill: 0,
  tank: 0,
  mast: 0,
});

/** How far off its wall a window point stands, metres: clear of the wall's depth test, inside its eaves. */
export const STRUCTURE_WINDOW_LAMP_STANDOFF = 0.3;

/** A side's glazing seen from anywhere in front: the mean of cos over the half-plane (2 / pi), for a hemisphere point of constant intensity. */
const SIDE_MEAN_COSINE = 2 / Math.PI;

/** Window points' emitter radius, metres: a lit window, so it stays a point until close (where the shells take over). */
const WINDOW_LAMP_RADIUS_METERS = 0.5;

/**
 * The lighthouse's lamp: a small harbour light, white, about 10,000 cd in its
 * beam, one flash every `STRUCTURE_BEACON_PERIOD_SECONDS` (the chart's
 * "Fl 10s") lasting about a second as the beam sweeps past.
 */
export const STRUCTURE_BEACON_CANDELA = 10_000;
export const STRUCTURE_BEACON_PERIOD_SECONDS = 10;
export const STRUCTURE_BEACON_FLASH_SECONDS = 1.2;
const BEACON_RGB: readonly [number, number, number] = Object.freeze([1, 0.94, 0.82] as const);
const BEACON_RADIUS_METERS = 0.45;
/** Each of the lamp's four points lights a quarter turn (cos 45 degrees), so one shows from any bearing. */
const BEACON_BEAM_COSINE = Math.SQRT1_2;
/** The lamp's height over the lamp room's floor (the kit's lens, `kitTowers` "The lamp on its pedestal"). */
const BEACON_LAMP_HEIGHT = 1.45;
/** The kit's lighthouse is at least three levels; its lookout's tower likewise (`buildTower`). */
const TOWER_MIN_LEVELS = 3;
/** The lookout's cab windows' middle, over its tower. */
const LOOKOUT_CAB_WINDOW_HEIGHT = 1.4;

/** The kit's mast (`buildMast`): leg radii at the foot and the top. */
const MAST_FOOT_RADIUS = 0.5;
const MAST_TOP_RADIUS = 0.22;
/** Clear of the kit's red lamp box (0.07 either side of its centre). */
const MAST_LAMP_STANDOFF = 0.12;
const MAST_LAMP_RADIUS_METERS = 0.12;

export type StructureLampRole = "window" | "obstruction" | "beacon";

/** One building's light points. */
export interface StructureLampSite {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly role: StructureLampRole;
  /** Its windows' lamp threshold (`structureLampThreshold`); signal lights ignore it. */
  readonly threshold: number;
  readonly fixtures: readonly LightPointFixture[];
  /** Each fixture's colour when fully on (before the share, the lit test and any flash). */
  readonly colours: readonly (readonly [number, number, number])[];
  /** A beacon's phase in its period, seconds; 0 for the rest. */
  readonly phaseSeconds: number;
}

type Vec3 = readonly [number, number, number];

function worldPoint(record: StructureRecord, lx: number, ly: number, lz: number): Vec3 {
  const c = Math.cos(record.heading);
  const s = Math.sin(record.heading);
  return [record.x + lx * c + lz * s, record.floorY + ly, record.z - lx * s + lz * c];
}

function worldDirection(record: StructureRecord, lx: number, lz: number): Vec3 {
  const c = Math.cos(record.heading);
  const s = Math.sin(record.heading);
  return [lx * c + lz * s, 0, -lx * s + lz * c];
}

/** The building-frame sides: outward normal (x, z), the half extent across them, and the side's length. */
function sides(halfW: number, halfD: number): readonly { nx: number; nz: number; off: number; length: number }[] {
  return [
    { nx: 0, nz: 1, off: halfD, length: 2 * halfW },
    { nx: 0, nz: -1, off: halfD, length: 2 * halfW },
    { nx: 1, nz: 0, off: halfW, length: 2 * halfD },
    { nx: -1, nz: 0, off: halfW, length: 2 * halfD },
  ];
}

/** A window side's intensity, candela: its glazing's light seen from anywhere in front. */
export function structureWindowSideCandela(archetype: StructureArchetype, sideLength: number, storeys: number): number {
  const area = STRUCTURE_GLAZING[archetype] * sideLength * Math.max(1, storeys) * STOREY_HEIGHT;
  return STRUCTURE_WINDOW_NITS * STRUCTURE_GLASS_SHARE * area * SIDE_MEAN_COSINE;
}

/** The kit's mast height for a record (`buildMast`, the same draw from the same seed). */
export function structureMastHeight(record: Pick<StructureRecord, "seed">): number {
  return Math.round(new KitRandom(record.seed).range(KitChannel.mastHeight, 12, 18) * 10) / 10;
}

/** A building's light points, or null for one with none (the windmill, the tank, the open watchtower). */
export function structureLampSite(record: StructureRecord): StructureLampSite | null {
  const kind = STRUCTURE_LAMP_KIND[record.archetype];
  const base = { id: record.id, x: record.x, z: record.z, threshold: structureLampThreshold(record) };
  if (record.archetype === "mast") {
    const height = structureMastHeight(record);
    const fixtures = [height + 0.12, height * 0.5].map((y): LightPointFixture => {
      const r = MAST_FOOT_RADIUS + (MAST_TOP_RADIUS - MAST_FOOT_RADIUS) * (Math.min(height, y) / height) + 0.08;
      return {
        position: worldPoint(record, r + MAST_LAMP_STANDOFF, y, 0),
        aim: [0, 1, 0],
        intensity: OBSTRUCTION_LIGHT_CANDELA.extent * AIRFIELD_LAMP_SCENE_SCALE,
        profileRow: 0,
        radiusMeters: MAST_LAMP_RADIUS_METERS,
        color: OBSTRUCTION_LIGHT_RGB,
      };
    });
    return { ...base, role: "obstruction", fixtures, colours: fixtures.map(() => OBSTRUCTION_LIGHT_RGB), phaseSeconds: 0 };
  }
  if (kind === "beacon") {
    const half = Math.min(record.width, record.depth) * 0.5;
    const y = Math.max(TOWER_MIN_LEVELS, record.storeys) * STOREY_HEIGHT + BEACON_LAMP_HEIGHT;
    const fixtures = sides(half, half).map((side): LightPointFixture => ({
      position: worldPoint(record, side.nx * (side.off + 0.2), y, side.nz * (side.off + 0.2)),
      aim: worldDirection(record, side.nx, side.nz),
      intensity: STRUCTURE_BEACON_CANDELA * AIRFIELD_LAMP_SCENE_SCALE,
      profileRow: 0,
      radiusMeters: BEACON_RADIUS_METERS,
      color: BEACON_RGB,
      beamCosineCutoff: BEACON_BEAM_COSINE,
    }));
    const phaseSeconds = ((record.id >>> 0) % 1000) / 1000 * STRUCTURE_BEACON_PERIOD_SECONDS;
    return { ...base, role: "beacon", fixtures, colours: fixtures.map(() => BEACON_RGB), phaseSeconds };
  }
  if (kind === "dark" || STRUCTURE_GLAZING[record.archetype] <= 0) return null;
  // The glazing ratio is over the walls of all its storeys (a lookout's
  // tower too, though its cab at the top holds all its windows).
  const storeys = Math.max(1, record.storeys);
  const y = record.archetype === "lookout"
    ? Math.max(TOWER_MIN_LEVELS, record.storeys) * STOREY_HEIGHT + LOOKOUT_CAB_WINDOW_HEIGHT
    : (storeys * STOREY_HEIGHT) * 0.5;
  const fixtures = sides(record.width * 0.5, record.depth * 0.5).map((side): LightPointFixture => ({
    position: worldPoint(
      record,
      side.nx * (side.off + STRUCTURE_WINDOW_LAMP_STANDOFF),
      y,
      side.nz * (side.off + STRUCTURE_WINDOW_LAMP_STANDOFF),
    ),
    aim: worldDirection(record, side.nx, side.nz),
    intensity: structureWindowSideCandela(record.archetype, side.length, storeys) * STRUCTURE_WINDOW_POINT_SCALE,
    profileRow: 0,
    radiusMeters: WINDOW_LAMP_RADIUS_METERS,
    color: STRUCTURE_LAMP_RGB,
    beamCosineCutoff: 0,
  }));
  return { ...base, role: "window", fixtures, colours: fixtures.map(() => STRUCTURE_LAMP_RGB), phaseSeconds: 0 };
}

/** The far set's share at a distance: in across the band past the near radius, out across the band inside the far one (`StructureMaterialPlugin`). */
export function structureWindowLampShare(distance: number, nearRadius: number, bandMeters: number, farRadius: number): number {
  const band = Math.max(bandMeters, 1e-3);
  return Math.min(1, Math.max(0, (distance - nearRadius) / band)) * Math.min(1, Math.max(0, (farRadius - distance) / band));
}

/** A beacon's flash, 0..1, at a time: a raised cosine `STRUCTURE_BEACON_FLASH_SECONDS` wide once a period. */
export function structureBeaconFlash(timeSeconds: number, phaseSeconds: number): number {
  const period = STRUCTURE_BEACON_PERIOD_SECONDS;
  const t = ((((timeSeconds + phaseSeconds) % period) + period) % period) - period * 0.5;
  const half = STRUCTURE_BEACON_FLASH_SECONDS * 0.5;
  if (Math.abs(t) >= half) return 0;
  return 0.5 + 0.5 * Math.cos((Math.PI * t) / half);
}

/** Seconds from a time to a beacon's next flash starting (0 when one starts now). */
export function structureBeaconUntilFlash(timeSeconds: number, phaseSeconds: number): number {
  const period = STRUCTURE_BEACON_PERIOD_SECONDS;
  const start = period * 0.5 - STRUCTURE_BEACON_FLASH_SECONDS * 0.5;
  const into = (((timeSeconds + phaseSeconds) % period) + period) % period;
  return (((start - into) % period) + period) % period;
}

/** Where a site's lights stand with the camera: the scale on its fixtures' colours now. */
export function structureLampSiteGain(
  site: StructureLampSite,
  distance: number,
  ranges: { readonly nearRadiusMeters: number; readonly bandMeters: number; readonly farRadiusMeters: number },
  litFraction: number,
  timeSeconds: number,
): number {
  const band = Math.max(ranges.bandMeters, 1e-3);
  const drawn = Math.min(1, Math.max(0, (ranges.farRadiusMeters - distance) / band));
  if (site.role === "obstruction") return drawn;
  if (site.role === "beacon") return litFraction > 0 ? drawn * structureBeaconFlash(timeSeconds, site.phaseSeconds) : 0;
  if (!structureLampLit(site.threshold, litFraction)) return 0;
  return structureWindowLampShare(distance, ranges.nearRadiusMeters, ranges.bandMeters, ranges.farRadiusMeters);
}
