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

/** Which governor acted (or held) in the most recent decision window (1A-6b). */
export type RenderGovernorMode =
  | "gpu-resolution"
  | "cpu-work"
  | "gpu-work"
  | "balanced"
  | "holding"
  | "no-gpu-timing"
  | "pinned";

/** One frame-graph pass's aggregated CPU cost (1A-1). */
export interface PassCpuTiming {
  readonly name: string;
  readonly p95Ms: number;
}

/** One budget-probe attribution row (1A-1). */
export interface BudgetProbeResultRow {
  readonly pass: string;
  readonly gpuP95DeltaMs: number | null;
}

export interface RenderDiagnostics {
  fps: number;
  /** Wall-clock interval between the two most recent presented frames. */
  frameTime: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** 4-5: CDLOD nodes drawn this frame (was CPU tile meshes). */
  terrainTiles: number;
  /** What the user selected; reported separately from what is actually running. */
  requestedRenderingMode: RequestedRenderingMode;
  renderBackend: RenderBackend;
  renderTechnique: RenderTechnique;
  /** Main render scale before display upsampling. */
  renderScale: number;
  /** CPU time spent updating and submitting the most recent frame. */
  cpuFrameTime: number;
  /** GPU frame duration when timestamp-query is available. */
  gpuFrameTime: number | null;
  /** Present/compositor residual for the most recent fully correlated interval. */
  presentWaitTime: number | null;
  visibleInstances: number;
  /**
   * Frustum-surviving vegetation batches — one draw per (prototype, chunk)
   * per pass. Vegetation is a DRAW-CALL workload (2-12 measured ~26 µs each,
   * with `Δgpu` tracking `Δdraws` linearly and triangle deltas at ~0), so
   * this is the number its frame row is actually spent on; without it in the
   * capture report the vegetation row was unmeasurable (the R-22 shape).
   */
  vegetationBatches: number;
  activeAnimals: number;
  riverCount: number;
  lakeCount: number;
  residentTerrainPages: number;
  /**
   * Physics collision samples served by the coarse analytic fallback instead
   * of the authoritative terrain grid (§1.3). Hard-wired 0 until 5-2's
   * readback lands; any non-zero value below 500 m AGL is a bug.
   */
  collisionSamplesServedByFallback: number;
  cloudResolutionScale: number;
  cloudRaySteps: number;
  oceanFftCascades: number;
  oceanFftResolution: number;
  adapter: string;
  renderingFallbackReason: string | null;
  /** The user must be able to see why the picture changed (1A-6b). */
  activeGovernor: RenderGovernorMode;
  gpuP95Ms: number | null;
  cpuP95Ms: number | null;
  /** Present-to-present p95 over the same rolling diagnostics window. */
  frameIntervalP95Ms: number | null;
  /** p95 of fully correlated per-frame residuals; never marginal-p95 subtraction. */
  presentWaitP95Ms: number | null;
  /**
   * Z-2 hitch metrics over the rolling diagnostics window. The p95 streams
   * deliberately ignore >250 ms samples (suspended tabs must not poison a
   * governor decision); these three deliberately do not — a 400 ms stall is
   * exactly what "no flicker, no lag" (G-C) is about.
   */
  maxFrameMs: number | null;
  p999FrameMs: number | null;
  /** Frames in the rolling window slower than 2× the tier's frame target. */
  hitchCount: number;
  /** Governor B ladder index and the lever that moved most recently. */
  cpuWorkLevel: number;
  cpuWorkLever: string | null;
  /** R-11: GPU-cost lever ladder index (shed when Governor A has no lever). */
  gpuWorkLevel: number;
  resolutionInsensitive: boolean;
  /** Pixels actually rasterised after the DPR ceiling, scale, and pixel cap. */
  renderPixels: number;
  topPassesByCpuMs: readonly PassCpuTiming[];
  pendingTerrainPages: number;
  /** Terrain generation workers currently busy (1B-4). */
  /** 4-4: the CPU worker pool is gone; this is GPU compute dispatches in flight. */
  terrainComputeDispatches: number;
  estimatedGpuMemoryMiB: number;
  /**
   * Z-4: best-effort walk of actual texture/geometry allocations — a floor
   * reading the estimate's fudge factor is sanity-checked against.
   */
  inventoriedGpuMemoryMiB: number;
  budgetProbeActive: boolean;
  budgetProbeReport: readonly BudgetProbeResultRow[] | null;
  /**
   * `4.5-C3` — per-pass GPU milliseconds, summed from Babylon's own
   * `gpuTimeInFrame` counters. The honest fraction of assertion 67, which has
   * been carried open through two phases and is owned by nobody.
   *
   * **UNCORRELATED AGGREGATES, and the label is load-bearing.** These counters
   * carry no submitted-frame id, so they say what each pass costs the GPU;
   * they do NOT say how much of a given frame's present-to-present interval
   * any pass explains. `B-0`'s rule stands — no present-wait inference without
   * a frame-correlatable timestamp source. What this buys is that the
   * 39-53 ms interval against a 15 ms GPU p95 becomes INSPECTABLE rather than
   * a gap nobody can name, and that every tuning decision in Gate 4.5-C stops
   * being made against a single counter that under-reports the frame 2-4x.
   *
   * Null members mean the adapter granted no `timestamp-query`, or that pass
   * has not run yet.
   */
  gpuPassMs: GpuPassAttribution;
}

/** `4.5-C3`'s uncorrelated per-pass GPU aggregates, in milliseconds. */
export interface GpuPassAttribution {
  /** The beauty pass, as Babylon's main-pass counter reports it. */
  readonly mainPass: number | null;
  /** Every cascade of the sun's cascaded shadow map, as one render target. */
  readonly shadows: number | null;
  /** Terrain page generation + the occlusion and splat bakes. */
  readonly terrainCompute: number | null;
  /** The sum of whatever is non-null above. */
  readonly total: number | null;
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
