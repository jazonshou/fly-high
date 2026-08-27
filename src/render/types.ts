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
  /**
   * Beta terrain viewer: hides the aircraft and switches to the free-fly
   * camera rig. The caller keeps feeding `render()` a synthetic
   * `FlightVisualState` whose position IS the camera, so streaming, the
   * floating origin, and shading all follow the viewer without new seams.
   */
  setViewerMode(enabled: boolean): void;
  /**
   * Rendered-surface height at (x, z) from the same consumer authority the
   * chase-camera ground clamp reads — for the viewer's own ground clamp.
   */
  sampleGroundHeight(x: number, z: number): number;
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
