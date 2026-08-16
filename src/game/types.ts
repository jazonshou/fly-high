export interface Vec3State {
  x: number;
  y: number;
  z: number;
}

export interface QuaternionState extends Vec3State {
  w: number;
}

export type CameraMode = "chase" | "cockpit" | "cinematic";
export type FlightMode = "scenic" | "pilot" | "unassisted";
export type QualityLevel = "low" | "medium" | "high";
export type TimeOfDayPreset = "dawn" | "day" | "golden";
export type WeatherPreset = "clear" | "breezy" | "cloudy";
/** WebGPU feature intent. Quality controls asset density; this controls expensive GPU techniques. */
export type RequestedRenderingMode = "performance" | "balanced" | "ultra";
export type RenderBackend = "webgpu";
export type RenderTechnique = "forward-spectral-volumetric";

export interface FlightVisualState {
  position: Vec3State;
  velocity: Vec3State;
  orientation: QuaternionState;
  angularVelocity: Vec3State;
  airspeed: number;
  /** Lowest landing-gear clearance above local terrain, in metres. */
  altitudeAgl: number;
  /** Height above mean sea level, in metres. */
  altitude: number;
  verticalSpeed: number;
  heading: number;
  pitch: number;
  bank: number;
  angleOfAttack: number;
  sideslip: number;
  throttle: number;
  engineRpm: number;
  /** Actual normalized control-surface positions after actuator lag. */
  elevator: number;
  aileron: number;
  rudder: number;
  brake: number;
  trim: number;
  flaps: number;
  /** 0 is retracted and 1 is down-and-locked. Fixed gear always reports 1. */
  gear: number;
  loadFactor: number;
  onGround: boolean;
  stalled: boolean;
  crashed: boolean;
  touchdown: number;
  simulationTime: number;
}

export interface ControlState {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  trim: number;
  flaps: number;
  brake: number;
  /** Requested landing-gear extension, 0..1. */
  gear: number;
}

export interface RenderDiagnostics {
  fps: number;
  frameTime: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  terrainTiles: number;
  /** What the user selected; reported separately from what is actually running. */
  requestedRenderingMode: RequestedRenderingMode;
  renderBackend: RenderBackend;
  renderTechnique: RenderTechnique;
  /** Main render scale before display upsampling. */
  renderScale: number;
  /** CPU time spent encoding the most recent frame. */
  cpuFrameTime: number;
  /** GPU frame duration when timestamp-query is available. */
  gpuFrameTime: number | null;
  visibleInstances: number;
  activeAnimals: number;
  riverCount: number;
  lakeCount: number;
  residentTerrainPages: number;
  cloudResolutionScale: number;
  cloudRaySteps: number;
  oceanFftCascades: number;
  oceanFftResolution: number;
  adapter: string;
  renderingFallbackReason: string | null;
}

export const INITIAL_VISUAL_STATE: FlightVisualState = {
  position: { x: -550, y: 720, z: 0 },
  velocity: { x: 58, y: 0, z: 0 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
  angularVelocity: { x: 0, y: 0, z: 0 },
  airspeed: 58,
  altitudeAgl: 720,
  altitude: 720,
  verticalSpeed: 0,
  heading: 90,
  pitch: 0,
  bank: 0,
  angleOfAttack: 3,
  sideslip: 0,
  throttle: 0.68,
  engineRpm: 2250,
  elevator: 0,
  aileron: 0,
  rudder: 0,
  brake: 0,
  trim: 0,
  flaps: 0,
  gear: 1,
  loadFactor: 1,
  onGround: false,
  stalled: false,
  crashed: false,
  touchdown: 0,
  simulationTime: 0,
};
