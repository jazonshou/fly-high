import type {
  ControlState,
  FlightMode,
  FlightVisualState,
  WeatherPreset,
} from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";
import type { WorldDefinition } from "@/src/world";
import type { TerrainMacroGrid, TerrainPagePublication } from "./terrainAuthority";

export type SpawnKind = "airborne" | "runway";

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
      mode: FlightMode;
      spawn: SpawnKind;
      airborneStartAgl: number;
      attractMode: boolean;
      weather: WeatherPreset;
    }
  | { type: "controls"; controls: ControlState }
  | { type: "mode"; mode: FlightMode }
  | { type: "weather"; weather: WeatherPreset }
  | { type: "attract"; enabled: boolean }
  | { type: "handoff"; mode: FlightMode }
  | { type: "returnToAttract"; airborneStartAgl: number }
  | { type: "pause"; paused: boolean }
  | { type: "reset"; spawn: SpawnKind; airborneStartAgl: number }
  | { type: "restartAfterCrash"; airborneStartAgl: number }
  /** Final L0 core from the render atlas; its ArrayBuffer is transferred. */
  | { type: "terrainPage"; page: TerrainPagePublication }
  /** Once-per-world macro fallback; its ArrayBuffer is transferred. */
  | { type: "terrainMacro"; macro: TerrainMacroGrid };

export type SimulationEvent =
  | { type: "ready"; state: FlightVisualState }
  | { type: "snapshot"; state: FlightVisualState }
  | { type: "error"; message: string };
