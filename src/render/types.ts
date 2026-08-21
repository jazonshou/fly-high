import type {
  CameraMode,
  FlightVisualState,
  QualityLevel,
  RenderDiagnostics,
  WeatherPreset,
} from "@/src/game/types";
import type { EnvironmentClock } from "@/src/world/environmentClock";
import type { RenderingMode } from "@/src/settings";
import type {
  TerrainMacroGrid,
  TerrainPagePublication,
} from "@/src/workers/terrainAuthority";

export interface TerrainAuthorityPublisher {
  publishTerrainPage(page: TerrainPagePublication): void;
  publishTerrainMacro(macro: TerrainMacroGrid): void;
}

export interface FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  setCameraMode(mode: CameraMode): void;
  setQuality(quality: QualityLevel): void;
  setRenderingMode(mode: RenderingMode): void;
  setReducedMotion(reducedMotion: boolean): void;
  /** Attach the worker-owned height authority after renderer startup. */
  setTerrainAuthorityPublisher(publisher: TerrainAuthorityPublisher | null): void;
  /** §1.6: the rendering inputs are the two continuous clock scalars. */
  setAtmosphere(clock: EnvironmentClock, weather: WeatherPreset): void;
  render(state: FlightVisualState, deltaSeconds: number): void;
  getDiagnostics(): RenderDiagnostics;
  /** Starts the 1A-1 GPU budget-probe sweep; returns whether it began. */
  startBudgetProbe(): boolean;
  dispose(): void;
}

/** Fast presence check; adapter/device creation remains authoritative. */
export function supportsFlightWebGPU(): boolean {
  return typeof navigator !== "undefined" && navigator.gpu !== undefined;
}
