import type {
  CameraMode,
  FlightVisualState,
  QualityLevel,
  RenderDiagnostics,
  WeatherPreset,
} from "@/src/game/types";
import type { EnvironmentClock } from "@/src/world/environmentClock";
import type { AirportDefinition } from "@/src/world/types";
import type { RenderingMode } from "@/src/settings";
import type { PresentationCadence } from "@/src/render/webgpu/core/presentationCadence";
import type {
  TerrainMacroGrid,
  TerrainPagePublication,
} from "@/src/workers/terrainAuthority";

export interface TerrainAuthorityPublisher {
  publishTerrainPage(page: TerrainPagePublication): void;
  publishTerrainMacro(macro: TerrainMacroGrid): void;
}

/** A world point on the canvas, written in place by `projectWorldPointToRef`. */
export interface ScreenPoint {
  x: number;
  y: number;
  inFront: boolean;
  /** Canvas size the point was projected into, CSS pixels. */
  width: number;
  height: number;
}

export interface FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  setCameraMode(mode: CameraMode): void;
  /**
   * Snap the exterior camera rig onto its settled pose on the next frame.
   *
   * Needed when the aeroplane TELEPORTS — a spawn or a crash recovery — where
   * the mode has not changed, so `setCameraMode` early-returns and cannot do
   * it. Without a cut the rig carries a temporal history about somewhere else
   * and, because the chase trail is derived from how far the aircraft moved
   * since the last frame, a ground speed in the thousands.
   */
  cutCamera(): void;
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
  /**
   * The world's airport list changed (an airport spawned or retired), home
   * field first. Every airport in it is graded, painted and lit; work for a
   * new one streams in over the following frames rather than in this call.
   */
  setAirports(airports: readonly Readonly<AirportDefinition>[]): void;
  /**
   * Writes where a world point lands on the canvas this frame into
   * `result`, in CSS pixels from its top-left corner; false (and `result`
   * untouched) while the canvas has no size. `inFront` is false for a point
   * behind the camera; `x`/`y` then point the way to turn. Allocation-free,
   * for the per-frame HUD overlay.
   */
  projectWorldPointToRef(x: number, y: number, z: number, result: ScreenPoint): boolean;
  /** Attach the worker-owned height authority after renderer startup. */
  setTerrainAuthorityPublisher(publisher: TerrainAuthorityPublisher | null): void;
  /** §1.6: the rendering inputs are the two continuous clock scalars. */
  setAtmosphere(clock: EnvironmentClock, weather: WeatherPreset): void;
  /**
   * The frame pacer's cadence (PR B), on the first rendered frame after it
   * changes. Null, which captures and perf:ab never change, is today's
   * behaviour: every refresh, judged against the tier's own target.
   */
  setPresentationCadence(cadence: PresentationCadence | null): void;
  /**
   * True while the flight is paused (PR B): the governor judges no window
   * of the static scene, so a pause neither sheds nor gives back work.
   */
  setGovernorHold(held: boolean): void;
  /**
   * The next frame follows ticks the frame loop skipped on purpose (the
   * pacer's re-probe on pause): its interval is left out of diagnostics and
   * the governor's window.
   */
  discardNextFrameInterval(): void;
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
