import type {
  CameraMode,
  FlightVisualState,
  QualityLevel,
  RenderDiagnostics,
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";

export interface FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  setCameraMode(mode: CameraMode): void;
  setQuality(quality: QualityLevel): void;
  setReducedMotion(reducedMotion: boolean): void;
  setAtmosphere(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): void;
  render(state: FlightVisualState, deltaSeconds: number): void;
  getDiagnostics(): RenderDiagnostics;
  dispose(): void;
}

export function supportsFlightWebGL(): boolean {
  // Do not create disposable probe contexts here. Some browsers virtualize or
  // ration WebGL contexts, so probing and immediately losing multiple contexts
  // can produce a false negative even though Three.js can render normally.
  // FlightGame still catches a real WebGLRenderer construction failure and
  // selects the Canvas renderer when hardware acceleration is genuinely absent.
  return typeof window !== "undefined" && typeof window.WebGL2RenderingContext !== "undefined";
}
