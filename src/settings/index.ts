import type {
  FlightMode,
  QualityLevel,
  RequestedRenderingMode,
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";
import {
  DEFAULT_AIRBORNE_START_AGL,
  normalizeAirborneStartAgl,
} from "@/src/workers/protocol";
import type { AircraftKind } from "@/src/sim";

export type UnitSystem = "aviation" | "metric";
export type HudMode = "minimal" | "full" | "off";
export type RenderingMode = RequestedRenderingMode;

export interface GameSettings {
  aircraft: AircraftKind;
  quality: QualityLevel;
  renderingMode: RenderingMode;
  flightMode: FlightMode;
  /** Height above local terrain for explicit airborne starts, in metres. */
  airborneStartAgl: number;
  units: UnitSystem;
  hud: HudMode;
  masterVolume: number;
  engineVolume: number;
  windVolume: number;
  sensitivity: number;
  gamepadDeadZone: number;
  invertPitch: boolean;
  mouseFlight: boolean;
  reducedMotion: boolean;
  /** @deprecated Retained only to migrate older stored preferences. */
  cameraShake: boolean;
  showDiagnostics: boolean;
  /**
   * UI preset label only (§1.6). After 1C-1 the renderer never branches on
   * this name; the two clock scalars below are the rendering inputs. The
   * label survives so preset buttons can highlight and so older stored
   * settings keep meaning.
   */
  timeOfDay: TimeOfDayPreset;
  weather: WeatherPreset;
  /** Environment clock (0-6): day of the year, [0, 365). */
  dayOfYear: number;
  /** Environment clock (0-6): local solar time in hours, [0, 24). */
  solarTimeHours: number;
}

export const SETTINGS_STORAGE_KEY = "aerolith.settings.v3";
export const PREVIOUS_SETTINGS_STORAGE_KEY = "aerolith.settings.v2";
export const LEGACY_SETTINGS_STORAGE_KEY = "aerolith.settings.v1";

/**
 * Migration mapping from the persisted time-of-day labels to plausible
 * environment-clock pairs (0-6). All three sit on the same midsummer day at
 * the default 45°N latitude — the presets were three times of one pleasant
 * flying day: just after sunrise, high midday sun, and evening golden hour.
 * 1C-9's preset buttons write these same pairs.
 */
export const TIME_OF_DAY_PRESET_CLOCKS: Readonly<
  Record<TimeOfDayPreset, { readonly dayOfYear: number; readonly solarTimeHours: number }>
> = Object.freeze({
  dawn: Object.freeze({ dayOfYear: 171, solarTimeHours: 5.5 }),
  day: Object.freeze({ dayOfYear: 171, solarTimeHours: 12.5 }),
  golden: Object.freeze({ dayOfYear: 171, solarTimeHours: 19 }),
});

export const DEFAULT_SETTINGS: GameSettings = {
  aircraft: "trainer",
  quality: "medium",
  renderingMode: "balanced",
  // Full pilot authority is the default. Assistance is an explicit selection.
  flightMode: "unassisted",
  airborneStartAgl: DEFAULT_AIRBORNE_START_AGL,
  units: "aviation",
  hud: "full",
  masterVolume: 0.72,
  engineVolume: 0.7,
  windVolume: 0.55,
  sensitivity: 1,
  gamepadDeadZone: 0.08,
  invertPitch: false,
  mouseFlight: false,
  reducedMotion: false,
  cameraShake: false,
  showDiagnostics: false,
  timeOfDay: "day",
  weather: "breezy",
  dayOfYear: TIME_OF_DAY_PRESET_CLOCKS.day.dayOfYear,
  solarTimeHours: TIME_OF_DAY_PRESET_CLOCKS.day.solarTimeHours,
};

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Reduce a finite number onto a half-open cyclic range [0, period). */
function cyclicNumber(value: unknown, fallback: number, period: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  // Double-mod: a tiny negative would otherwise round `wrapped + period` to
  // exactly `period`, escaping the half-open range.
  return ((value % period) + period) % period;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function renderingMode(value: unknown): RenderingMode {
  if (value === "performance" || value === "balanced" || value === "ultra") return value;
  // Migrate renderer-v1 preferences to the nearest WebGPU resource intent.
  if (value === "ray-traced") return "ultra";
  if (value === "hybrid") return "balanced";
  return DEFAULT_SETTINGS.renderingMode;
}

export function validateSettings(value: unknown): GameSettings {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const timeOfDay = oneOf(
    source.timeOfDay,
    ["dawn", "day", "golden"] as const,
    DEFAULT_SETTINGS.timeOfDay,
  );
  return {
    aircraft: oneOf(source.aircraft, ["trainer", "jet"] as const, DEFAULT_SETTINGS.aircraft),
    quality: oneOf(source.quality, ["low", "medium", "high"] as const, DEFAULT_SETTINGS.quality),
    renderingMode: renderingMode(source.renderingMode),
    flightMode: oneOf(
      source.flightMode,
      ["scenic", "pilot", "unassisted"] as const,
      DEFAULT_SETTINGS.flightMode,
    ),
    airborneStartAgl: normalizeAirborneStartAgl(source.airborneStartAgl),
    units: oneOf(source.units, ["aviation", "metric"] as const, DEFAULT_SETTINGS.units),
    hud: oneOf(source.hud, ["minimal", "full", "off"] as const, DEFAULT_SETTINGS.hud),
    masterVolume: finiteNumber(source.masterVolume, DEFAULT_SETTINGS.masterVolume, 0, 1),
    engineVolume: finiteNumber(source.engineVolume, DEFAULT_SETTINGS.engineVolume, 0, 1),
    windVolume: finiteNumber(source.windVolume, DEFAULT_SETTINGS.windVolume, 0, 1),
    sensitivity: finiteNumber(source.sensitivity, DEFAULT_SETTINGS.sensitivity, 0.35, 2),
    gamepadDeadZone: finiteNumber(
      source.gamepadDeadZone,
      DEFAULT_SETTINGS.gamepadDeadZone,
      0,
      0.35,
    ),
    invertPitch:
      typeof source.invertPitch === "boolean" ? source.invertPitch : DEFAULT_SETTINGS.invertPitch,
    mouseFlight:
      typeof source.mouseFlight === "boolean" ? source.mouseFlight : DEFAULT_SETTINGS.mouseFlight,
    reducedMotion:
      typeof source.reducedMotion === "boolean"
        ? source.reducedMotion
        : DEFAULT_SETTINGS.reducedMotion,
    cameraShake:
      typeof source.cameraShake === "boolean" ? source.cameraShake : DEFAULT_SETTINGS.cameraShake,
    showDiagnostics:
      typeof source.showDiagnostics === "boolean"
        ? source.showDiagnostics
        : DEFAULT_SETTINGS.showDiagnostics,
    timeOfDay,
    weather: oneOf(
      source.weather,
      ["clear", "breezy", "cloudy"] as const,
      DEFAULT_SETTINGS.weather,
    ),
    // Pre-Phase-0 blobs carry only the label; their clock falls back to the
    // label's migration pair rather than to one global default (0-6).
    dayOfYear: cyclicNumber(source.dayOfYear, TIME_OF_DAY_PRESET_CLOCKS[timeOfDay].dayOfYear, 365),
    solarTimeHours: cyclicNumber(
      source.solarTimeHours,
      TIME_OF_DAY_PRESET_CLOCKS[timeOfDay].solarTimeHours,
      24,
    ),
  };
}

export function loadSettings(storage?: Pick<Storage, "getItem">): GameSettings {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!target) return { ...DEFAULT_SETTINGS };
  try {
    const serialized = target.getItem(SETTINGS_STORAGE_KEY);
    if (serialized) return validateSettings(JSON.parse(serialized));

    const previousSerialized = target.getItem(PREVIOUS_SETTINGS_STORAGE_KEY);
    if (previousSerialized) return validateSettings(JSON.parse(previousSerialized));

    const legacySerialized = target.getItem(LEGACY_SETTINGS_STORAGE_KEY);
    if (!legacySerialized) return { ...DEFAULT_SETTINGS };
    const legacy = JSON.parse(legacySerialized) as unknown;
    // Scenic was the implicit v1 default, so carrying it forward would silently
    // re-enable the attitude controller. Preserve every other preference while
    // requiring the user to opt into assistance once under the new model.
    const migrated = legacy && typeof legacy === "object"
      ? {
          ...(legacy as Record<string, unknown>),
          flightMode:
            (legacy as Record<string, unknown>).flightMode === "scenic"
              ? DEFAULT_SETTINGS.flightMode
              : (legacy as Record<string, unknown>).flightMode,
        }
      : legacy;
    return validateSettings(migrated);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(
  settings: GameSettings,
  storage?: Pick<Storage, "setItem">,
): void {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!target) return;
  try {
    target.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validateSettings(settings)));
  } catch {
    // Storage can be blocked in private contexts; gameplay must continue.
  }
}

export function createRandomSeed(): number {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
  }
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

export function readSeedFromUrl(url?: string): number {
  const source = url ?? (typeof window !== "undefined" ? window.location.href : "http://local/");
  try {
    const value = new URL(source).searchParams.get("seed");
    if (!value) return createRandomSeed();
    const numeric = Number.parseInt(value, 36);
    return Number.isFinite(numeric) ? numeric >>> 0 : createRandomSeed();
  } catch {
    return createRandomSeed();
  }
}

/**
 * Gate 0-b (Phase 6): opt-in eroded-world access for flight review. The value
 * is read from the URL only and never persisted — absence of `?world=eroded`
 * must always yield the shipped default (`DEFAULT_WORLD_EVOLUTION`), so a
 * shared link opts in exactly one session and nothing sticks.
 */
export function readWorldEvolutionFromUrl(url?: string): "eroded" | undefined {
  const source = url ?? (typeof window !== "undefined" ? window.location.href : "http://local/");
  try {
    return new URL(source).searchParams.get("world") === "eroded" ? "eroded" : undefined;
  } catch {
    return undefined;
  }
}

export function seedToString(seed: number): string {
  return (seed >>> 0).toString(36).toUpperCase().padStart(6, "0");
}

export function urlWithSeed(seed: number, url?: string): string {
  const target = new URL(url ?? (typeof window !== "undefined" ? window.location.href : "http://local/"));
  target.searchParams.set("seed", seedToString(seed).toLowerCase());
  return target.toString();
}
