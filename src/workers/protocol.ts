import type {
  CarSetup,
  ControlState,
  FlightMode,
  FlightVisualState,
  WeatherPreset,
} from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";
import { vehicleClass, type SurfaceVehicleKind } from "@/src/vehicles/kinds";
import type { AirportDefinition, WorldDefinition } from "@/src/world";
import type { InfrastructureRegionsUpdate } from "@/src/world/infrastructureSync";
import type { TerrainMacroGrid, TerrainPagePublication } from "./terrainAuthority";

/** Where an aeroplane starts. */
export type AircraftSpawnKind = "airborne" | "runway";

/**
 * Where a surface vehicle starts. A boat always starts moored at the home
 * marina's start berth, `"dock"` (decision D4, 2026-10-26); the car starts on
 * the home airport's apron, `"airfield"`, beside its access road.
 */
export type SurfaceSpawnKind = "dock" | "airfield";

/** Where a flight starts: an aircraft's or a surface vehicle's. */
export type SpawnKind = AircraftSpawnKind | SurfaceSpawnKind;

export function isAircraftSpawn(kind: SpawnKind): kind is AircraftSpawnKind {
  return kind === "airborne" || kind === "runway";
}

export function isSurfaceSpawn(kind: SpawnKind): kind is SurfaceSpawnKind {
  return kind === "dock" || kind === "airfield";
}

/** The one start a surface vehicle has. */
export function surfaceSpawnKind(kind: SurfaceVehicleKind): SurfaceSpawnKind {
  return vehicleClass(kind) === "car" ? "airfield" : "dock";
}

/** Airborne starts are configured in metres above the terrain/runway datum. */
export const DEFAULT_AIRBORNE_START_AGL = 450;
export const MIN_AIRBORNE_START_AGL = 120;
export const MAX_AIRBORNE_START_AGL = 3_000;

export function normalizeAirborneStartAgl(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AIRBORNE_START_AGL;
  return Math.min(MAX_AIRBORNE_START_AGL, Math.max(MIN_AIRBORNE_START_AGL, value));
}

export type SimulationCommand =
  | {
      type: "initialize";
      world: WorldDefinition;
      aircraft: AircraftKind;
      /**
       * The session's surface vehicle, or null in an aircraft session. The
       * menu's attract flight is always `aircraft`; a `"dock"` spawn drives
       * this one.
       */
      surfaceVehicle: SurfaceVehicleKind | null;
      /** The car's gearbox and clutch choice, from settings; read only for a car. */
      carSetup: CarSetup;
      mode: FlightMode;
      spawn: SpawnKind;
      airborneStartAgl: number;
      attractMode: boolean;
      weather: WeatherPreset;
      /**
       * The streamed infrastructure regions (roads) the main thread holds now,
       * as a reset: installed before the spawn is placed, so a car starting on
       * a road fill stands on it.
       */
      infrastructure: InfrastructureRegionsUpdate;
    }
  | { type: "controls"; controls: ControlState }
  | { type: "mode"; mode: FlightMode }
  | { type: "weather"; weather: WeatherPreset }
  /** The car's gearbox and clutch, taken at its next start. */
  | { type: "carSetup"; carSetup: CarSetup }
  | { type: "attract"; enabled: boolean }
  /**
   * `trimSeed` is the player's trim in `controls.trim` units, decided on the
   * main thread because the input controller owns trim and re-sends it. Zero
   * for Scenic, whose own height hold carries the trim across instead.
   */
  | { type: "handoff"; mode: FlightMode; trimSeed: number }
  | { type: "returnToAttract"; airborneStartAgl: number }
  | { type: "pause"; paused: boolean }
  | { type: "reset"; spawn: SpawnKind; airborneStartAgl: number }
  | { type: "restartAfterCrash"; airborneStartAgl: number }
  /** Final L0 core from the render atlas; its ArrayBuffer is transferred. */
  | { type: "terrainPage"; page: TerrainPagePublication }
  /** Once-per-world macro fallback; its ArrayBuffer is transferred. */
  | { type: "terrainMacro"; macro: TerrainMacroGrid }
  /**
   * The world's whole airport list, home field first, sent whenever an
   * airport spawns (`src/world/airportNetwork.ts`). The worker installs it
   * with `withAirports`, so collision, `nearestAirport` and anything else
   * reading `world.airports` sees the new runway from the next step.
   */
  | { type: "airports"; airports: readonly AirportDefinition[] }
  /**
   * One change to the main thread's streamed infrastructure regions, posted
   * the moment it is made (`InfrastructureRegionsForwarder`), so it arrives
   * before any page baked against it. The worker installs the same regions
   * and drops the L0 pages the change touches; its analytic fallback answers
   * there from the new regions until the rebuilt pages arrive.
   */
  | { type: "infrastructure"; update: InfrastructureRegionsUpdate }
  /**
   * Engage the autoland on the nearest airport's runway, or hand back. The
   * worker refuses to engage on the ground and in the menu flight, and drops
   * out by itself on a crash, a firm stick input, or a reset.
   */
  | { type: "autoland"; enabled: boolean };

export type SimulationEvent =
  | { type: "ready"; state: FlightVisualState }
  | { type: "snapshot"; state: FlightVisualState }
  | { type: "error"; message: string };
