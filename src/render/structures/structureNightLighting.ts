import { mixSeed } from "@/src/world/seed";
import type { StructureArchetype, StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The buildings' lights by the clock (structures S5): what share of them has
 * a lamp on, and how bright a lit window and a lamp-lit room are, in the
 * renderer's scene units.
 *
 * WHICH BUILDINGS. Each building has a threshold (`structureLampThreshold`,
 * from its id and its archetype) and is lit while the share is above it, so
 * a building stays lit or dark as the share moves past it and the same
 * buildings light up every evening. The threshold rides the building's
 * vertices (`structureLampCode`) and the light points read the same value,
 * so a house's windows and its light point far off agree.
 *
 * WHEN. The share is the clock's (who is home and awake: most of the evening,
 * fewer as the night goes on, a few before dawn) and the lamps are on only
 * while it is dark: everything fades by day with the airfield lamps' daylight
 * law, which is exactly 1 at or below the horizon. So a dark winter afternoon
 * far north has its lights on and a summer evening at 21:00 does not yet.
 *
 * PHOTOMETRY, in real units first (`SCENE_UNIT_TO_NITS` turns cd/m² into
 * scene units, the sun's own calibration):
 *
 *   A lit window: ~60 cd/m² seen from outside (a room at 100-150 lux behind
 *   curtains and glass). That is thousands of times moonlit ground, which is
 *   what a lit window at night is.
 *   A lamp-lit room: ~120 lux on its walls and floor, so a surface reads its
 *   albedo times 120 / pi cd/m².
 *
 * Both are warm, about 2,700 K.
 */

/** The renderer's scene unit in cd/m² (`EnvironmentDirector.SCENE_UNIT_TO_NITS`; a test pins the two). */
export const STRUCTURE_SCENE_UNIT_TO_NITS = 120_000 / (5.2 * Math.PI);

export const STRUCTURE_WINDOW_NITS = 60;
export const STRUCTURE_LAMP_LUX = 120;

/** A 2,700 K lamp in linear RGB, scaled to unit luminance (Rec. 709 weights). */
export const STRUCTURE_LAMP_RGB: readonly [number, number, number] = (() => {
  const rgb = [1, 0.72, 0.42] as const;
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return Object.freeze([rgb[0] / luminance, rgb[1] / luminance, rgb[2] / luminance] as const);
})();

/**
 * The share of buildings with someone home and a light on once it is dark,
 * by solar hour: most through the evening, fewer as the night goes on, a few
 * again before dawn, about half by day (which only shows when the day is
 * dark). Piecewise linear through these (hour, share) keys, wrapping at
 * midnight.
 */
export const STRUCTURE_LIT_SCHEDULE: readonly (readonly [number, number])[] = Object.freeze([
  [0, 0.18],
  [1, 0.12],
  [4.5, 0.06],
  [5.5, 0.3],
  [7, 0.45],
  [16, 0.5],
  [18.5, 0.85],
  [21, 0.85],
  [23, 0.35],
  [24, 0.18],
] as const);

export function structureLitFraction(solarTimeHours: number): number {
  if (!Number.isFinite(solarTimeHours)) return 0;
  const hour = ((solarTimeHours % 24) + 24) % 24;
  const keys = STRUCTURE_LIT_SCHEDULE;
  for (let index = 1; index < keys.length; index += 1) {
    const [h1, s1] = keys[index]!;
    if (hour <= h1) {
      const [h0, s0] = keys[index - 1]!;
      return s0 + ((s1 - s0) * (hour - h0)) / (h1 - h0);
    }
  }
  return keys[keys.length - 1]![1];
}

export interface StructureNightLighting {
  /** Share of buildings lit, 0..1 (as the GPU sees it: a float32). */
  readonly litFraction: number;
  /** A lit window's glass, scene units (before the lamp colour). */
  readonly windowScene: number;
  /** A lamp-lit room's illuminance over pi, scene units: times the surface's albedo. */
  readonly lampScene: number;
}

export const STRUCTURE_NIGHT_OFF: StructureNightLighting = Object.freeze({ litFraction: 0, windowScene: 0, lampScene: 0 });

/** The lights at a solar hour under a daylight attenuation (`airfieldLampDaylightAttenuation`, 1 at night). */
export function structureNightLighting(solarTimeHours: number, daylightAttenuation: number): StructureNightLighting {
  const litFraction = Math.fround(structureLitFraction(solarTimeHours));
  const daylight = Number.isFinite(daylightAttenuation) ? Math.min(1, Math.max(0, daylightAttenuation)) : 0;
  if (litFraction <= 0 || daylight <= 0) return STRUCTURE_NIGHT_OFF;
  return {
    litFraction,
    windowScene: (STRUCTURE_WINDOW_NITS / STRUCTURE_SCENE_UNIT_TO_NITS) * daylight,
    lampScene: (STRUCTURE_LAMP_LUX / Math.PI / STRUCTURE_SCENE_UNIT_TO_NITS) * daylight,
  };
}

/**
 * How an archetype's lamps behave: `home` buildings light by the schedule,
 * `work` buildings (barns, sheds, the towers) at a quarter of it, `dark` ones
 * (the windmill, the tank, the mast: nobody inside, and the mast's solar
 * panel is glass) never, and the lighthouse's lamp room always, once dark.
 */
export type StructureLampKind = "home" | "work" | "dark" | "beacon";

export const STRUCTURE_LAMP_KIND: Readonly<Record<StructureArchetype, StructureLampKind>> = Object.freeze({
  house: "home",
  cottage: "home",
  cabin: "home",
  sauna: "work",
  barn: "work",
  shed: "work",
  station: "home",
  watchtower: "work",
  lookout: "work",
  lighthouse: "beacon",
  store: "work",
  windmill: "dark",
  tank: "dark",
  mast: "dark",
});

/** A work building's share of the schedule. */
export const STRUCTURE_WORK_LIT_SHARE = 0.25;

/** The threshold's quantum: thresholds are multiples of this, exact in a float32 vertex attribute. */
export const STRUCTURE_LAMP_STEPS = 2048;

/** A threshold no share reaches. */
export const STRUCTURE_LAMP_NEVER = 2;

/**
 * The building is lit while the share is above this. A multiple of
 * 1 / `STRUCTURE_LAMP_STEPS` in [0, `STRUCTURE_LAMP_NEVER`], from the
 * building's id alone (which the record notes the night lights seed from).
 */
export function structureLampThreshold(record: Pick<StructureRecord, "id" | "archetype">): number {
  const kind = STRUCTURE_LAMP_KIND[record.archetype];
  if (kind === "dark") return STRUCTURE_LAMP_NEVER;
  if (kind === "beacon") return 0;
  const unit = (mixSeed(record.id >>> 0, 0x4c41_4d50) >>> 0) / 4_294_967_296;
  const threshold = kind === "work" ? unit / STRUCTURE_WORK_LIT_SHARE : unit;
  return Math.min(STRUCTURE_LAMP_STEPS * STRUCTURE_LAMP_NEVER, Math.floor(threshold * STRUCTURE_LAMP_STEPS)) / STRUCTURE_LAMP_STEPS;
}

/** Whether a building with this threshold is lit at this share: the shader's comparison, in the same float32 values. */
export function structureLampLit(threshold: number, litFraction: number): boolean {
  return threshold < Math.fround(litFraction);
}

/**
 * The surface attribute's stride: a vertex carries its surface id plus this
 * times the threshold's steps (`structureLampCode`); ids are below it. The
 * largest code, 31 + 32 x 4,096, is far inside a float32's exact integers.
 */
export const STRUCTURE_LAMP_CODE_STRIDE = 32;

export function structureLampCode(surfaceId: number, threshold: number): number {
  return surfaceId + STRUCTURE_LAMP_CODE_STRIDE * Math.round(threshold * STRUCTURE_LAMP_STEPS);
}
