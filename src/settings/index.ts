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
  timeOfDay: TimeOfDayPreset;
  weather: WeatherPreset;
}

export const SETTINGS_STORAGE_KEY = "aerolith.settings.v3";
export const PREVIOUS_SETTINGS_STORAGE_KEY = "aerolith.settings.v2";
export const LEGACY_SETTINGS_STORAGE_KEY = "aerolith.settings.v1";

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
};

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
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
    timeOfDay: oneOf(
      source.timeOfDay,
      ["dawn", "day", "golden"] as const,
      DEFAULT_SETTINGS.timeOfDay,
    ),
    weather: oneOf(
      source.weather,
      ["clear", "breezy", "cloudy"] as const,
      DEFAULT_SETTINGS.weather,
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

export function seedToString(seed: number): string {
  return (seed >>> 0).toString(36).toUpperCase().padStart(6, "0");
}

export function urlWithSeed(seed: number, url?: string): string {
  const target = new URL(url ?? (typeof window !== "undefined" ? window.location.href : "http://local/"));
  target.searchParams.set("seed", seedToString(seed).toLowerCase());
  return target.toString();
}
