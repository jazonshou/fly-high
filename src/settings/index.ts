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
import { AIRCRAFT_KINDS, type AircraftKind } from "@/src/sim";
import { VEHICLE_KINDS, type VehicleKind } from "@/src/vehicles/kinds";
import type { LandformsOption } from "@/src/world";

export type UnitSystem = "aviation" | "metric";
/**
 * PR B's frame-rate setting: "60" draws every Nth display refresh so frames
 * stay evenly spaced near 60 fps, "display" draws every refresh, "30" every
 * Nth near 30 fps (src/game/framePacer.ts).
 */
export type FrameRateSetting = "60" | "display" | "30";
export const FRAME_RATE_SETTINGS = ["60", "display", "30"] as const satisfies readonly FrameRateSetting[];
export type HudMode = "minimal" | "full" | "off";
export type RenderingMode = RequestedRenderingMode;

export interface GameSettings {
  /**
   * The aeroplane: what an aircraft session flies, and what the menu's
   * attract flight always shows, whatever is selected to drive.
   */
  aircraft: AircraftKind;
  /**
   * What Start drives: one of the aircraft (then equal to `aircraft`) or a
   * surface vehicle. Saved settings from before vehicles existed carry only
   * `aircraft`, and migrate to driving it.
   */
  vehicle: VehicleKind;
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
   * PR B: how often the frame loop draws. "60" at every tier by default;
   * stored blobs from before it load with the default.
   */
  frameRate: FrameRateSetting;
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
  // `7-0-c`: a flyable night, so the night-approach flights do not start with
  // dragging a slider. Solar 23.75 matches every night CAPTURE shot, so the
  // preset and the harness describe the same hour.
  //
  // Day 356 rather than the 171 the other three presets share, and the reason
  // is measured rather than aesthetic: at day 171 / 23.75 the moon sits at
  // roughly 0.6 degrees altitude and delivers about a thousandth of full-moon
  // illuminance, so that clock is a STARLIT night, not a moonlit one. Day 356
  // puts the moon near 72 degrees at ~100% lit. The moonless clock is kept in
  // the capture set as the adversarial case; the front door gets the lit one.
  // `tests/render.night-clock-moonlight.test.ts` pins both and carries the
  // altitude calculation, which is not reachable from `moonState` alone.
  night: Object.freeze({ dayOfYear: 356, solarTimeHours: 23.75 }),
});

export const DEFAULT_SETTINGS: GameSettings = {
  aircraft: "trainer",
  vehicle: "trainer",
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
  frameRate: "60",
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
    ["dawn", "day", "golden", "night"] as const,
    DEFAULT_SETTINGS.timeOfDay,
  );
  // Reads the catalogue rather than a second hand-written list: a saved
  // preference naming an airframe this build does not have falls back to the
  // default, which is what makes adding or removing one safe.
  const aircraft = oneOf(source.aircraft, AIRCRAFT_KINDS, DEFAULT_SETTINGS.aircraft);
  return {
    aircraft,
    vehicle: oneOf(source.vehicle, VEHICLE_KINDS, aircraft),
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
    frameRate: oneOf(source.frameRate, FRAME_RATE_SETTINGS, DEFAULT_SETTINGS.frameRate),
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

/**
 * V-4: the terrain's far-sward read for one review session (`?farSward=off`,
 * `cheap` or `soft`). URL only and never persisted, like `?world=`: absence
 * keeps the shipped read.
 */
export function readTerrainFarSwardFromUrl(url?: string): "off" | "cheap" | "soft" | undefined {
  const source = url ?? (typeof window !== "undefined" ? window.location.href : "http://local/");
  try {
    const value = new URL(source).searchParams.get("farSward");
    return value === "off" || value === "cheap" || value === "soft" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Landforms forced for one review session (`?landforms=dunes`, `volcanic`, or
 * `dunes,volcanic`): sand seas or volcanic fields everywhere outside a small
 * clearance round the start runway, instead of 150 km out where the natural
 * world grows them. URL only and never persisted, like `?world=`: absence, or
 * a list naming no landform, keeps the natural world.
 */
export function readLandformsFromUrl(url?: string): LandformsOption | undefined {
  const source = url ?? (typeof window !== "undefined" ? window.location.href : "http://local/");
  try {
    const value = new URL(source).searchParams.get("landforms");
    if (!value) return undefined;
    const names = value.split(",").map((name) => name.trim());
    const dunes = names.includes("dunes");
    const volcanic = names.includes("volcanic");
    if (!dunes && !volcanic) return undefined;
    return { ...(dunes ? { dunes } : {}), ...(volcanic ? { volcanic } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The in-game benchmark's page request (`?bench=1`, src/bench). It flies one
 * tier per page load and reloads between them, so the URL says which page
 * this is: the intro (no `run`), step `k` of a run, or the run's report.
 */
export interface BenchUrlRequest {
  /** 1 to 8 quality tiers (0 Low ... 3 Ultra), in flying order. */
  readonly tiers: readonly number[];
  readonly mode: "shipped" | "pinned";
  /** False only for `hud=0`. */
  readonly hud: boolean;
  /** `quick=1`: short timings for development; the report says non-standard. */
  readonly quick: boolean;
  /** `fps=60|display|30`: the frame-rate setting every flight uses; the mode's default without one. */
  readonly frameRate: FrameRateSetting;
  readonly run: string | null;
  readonly step: number | "report" | null;
}

/**
 * The bench's frame rate without `fps=`. Shipped mode flies what players
 * get. Pinned mode measures the GPU's capacity, which a 60 fps cap would
 * hide on a fast display, so it draws every refresh.
 */
export function defaultBenchFrameRate(mode: BenchUrlRequest["mode"]): FrameRateSetting {
  return mode === "pinned" ? "display" : DEFAULT_SETTINGS.frameRate;
}

/** Medium first and last, so a run can check itself for drift. */
export const DEFAULT_BENCH_TIERS: readonly number[] = Object.freeze([1, 0, 2, 1]);
const MAX_BENCH_TIERS = 8;

/**
 * A `tiers` list: 1 to 8 entries, each 0 to 3, separated by commas. Null when
 * it breaks the rule. The bench intro's Advanced field reads its text with
 * this too, so it never starts a run that `readBenchFromUrl` would replace
 * with the default.
 */
export function parseBenchTiers(text: string): number[] | null {
  const names = text.split(",").map((name) => name.trim());
  return names.length <= MAX_BENCH_TIERS && names.every((name) => /^[0-3]$/.test(name)) ? names.map(Number) : null;
}

/**
 * `?bench=1` only. URL only and never persisted, like `?world=`: the bench
 * keeps its progress in its own tab-scoped store (src/bench/store.ts), never
 * in the settings. Anything but exactly `bench=1` is the normal game. A bad
 * `tiers` list or `fps` falls back to the default; a bad `run` or `step`
 * reads as null, which means the intro page.
 */
export function readBenchFromUrl(url?: string): BenchUrlRequest | undefined {
  const source = url ?? (typeof window !== "undefined" ? window.location.href : "http://local/");
  try {
    const params = new URL(source).searchParams;
    if (params.get("bench") !== "1") return undefined;
    const tiers = parseBenchTiers(params.get("tiers") ?? "");
    const run = params.get("run");
    const step = params.get("step");
    const mode = params.get("mode") === "pinned" ? "pinned" : "shipped";
    return {
      tiers: tiers ?? [...DEFAULT_BENCH_TIERS],
      mode,
      hud: params.get("hud") !== "0",
      quick: params.get("quick") === "1",
      frameRate: oneOf(params.get("fps"), FRAME_RATE_SETTINGS, defaultBenchFrameRate(mode)),
      run: run !== null && /^[a-z0-9]{6,16}$/.test(run) ? run : null,
      step: step === "report" ? "report" : step !== null && /^\d{1,2}$/.test(step) ? Number(step) : null,
    };
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
