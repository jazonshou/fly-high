import type { DetailWorkerHealth } from "@/src/render/webgpu/detail/WorldDetailRuntime";
import type {
  TerrainHeightAuthorityCounters,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import type { AutolandPhase, GoAroundReason } from "@/src/sim";

export interface Vec3State {
  x: number;
  y: number;
  z: number;
}

export interface QuaternionState extends Vec3State {
  w: number;
}

export type CameraMode = "chase" | "cockpit" | "cinematic" | "top" | "front" | "freefly";
export type FlightMode = "scenic" | "pilot" | "unassisted";
export type QualityLevel = "low" | "medium" | "high";
export type TimeOfDayPreset = "dawn" | "day" | "golden" | "night";
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
  /**
   * Ground-spoiler deployment, 0..1, as the SIM decided it
   * (`ActuatorState.groundSpoilers`): the 747's and the Global's panels are
   * drawn from this, never re-derived from the brake and the wheels.
   */
  groundSpoilers: number;
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
  /**
   * `5-2`: worker-side terrain-authority service counters, cumulative from
   * the latest macro publication (the first fully provisioned authority).
   * Optional so recorded fixtures and non-worker simulations remain source
   * compatible; live worker snapshots always include it.
   */
  terrainAuthority?: TerrainHeightAuthorityCounters;
  /**
   * The autoland while it is engaged (`src/sim/autoland.ts`), null otherwise.
   * Optional for the same reason as `terrainAuthority`.
   */
  autoland?: AutolandVisualState | null;
  /**
   * What only a surface vehicle has, null or absent in an aircraft session.
   * The common fields above still describe the hull's pose, speed and engine;
   * the aircraft-only ones (control surfaces, flaps, gear, angle of attack)
   * read neutral.
   */
  vehicle?: VehicleVisualPayload | null;
  /**
   * The walking session a car session carries (the walking plan, 2026-10-27):
   * which of the person and the car is driven, the other one, and the
   * boarding prompt. Absent in aircraft and boat sessions. The common fields
   * above always describe the DRIVEN one: the car's pose while driving, the
   * person's (feet point, yaw-only orientation) while on foot.
   */
  walking?: WalkingVisualState | null;
}

/** Surface-vehicle payloads, discriminated by `kind`. The person is one too, while it is driven. */
export type VehicleVisualPayload = BoatVisualState | CarVisualState | PersonVisualState;

/**
 * What the walker is doing, as the sim classifies it (`src/sim/person/`).
 * `land` is the crouch or roll after a hard landing (never damage: D5);
 * `mantle` climbs out of the water onto a ledge; `board` is getting in or
 * out of the car (see `PersonVisualState.boarding`); `seated` is aboard,
 * while the car is driven.
 */
export type PersonMode =
  | "stand"
  | "walk"
  | "run"
  | "air"
  | "land"
  | "wade"
  | "swim"
  | "dive"
  | "mantle"
  | "board"
  | "seated";

export type CarDoorSide = "right" | "left";

/** Getting in or out of the car: what the figure, the car's door and the camera play. */
export interface PersonBoardingState {
  action: "getIn" | "getOut";
  /** 0 at the start .. 1 seated (getting in) or standing clear (getting out). */
  progress: number;
  /** The door used: the driver's (right, right-hand drive) unless it was blocked. */
  side: CarDoorSide;
}

/**
 * What the HUD, the drawn figure, its sound and the camera read from the
 * walker's sim. Pose in the common fields: `position` is the FEET point (the
 * bottom of the capsule, on the ground when standing), `orientation` turns
 * about world Y only (body +X is the facing direction), `velocity` is world
 * m/s. Depths are positive below the local water surface.
 */
export interface PersonVisualState {
  kind: "person";
  mode: PersonMode;
  /**
   * Horizontal speed over what is under the feet (the ground, a pontoon,
   * the current), m/s: what the gait reads.
   */
  speed: number;
  /** The run (or the faster stroke) is being asked for. */
  running: boolean;
  /** Feet on a walkable surface this step. */
  grounded: boolean;
  /** Ground slope along the facing direction, rise over run (positive uphill), for the gait's lean. 0 off the ground. */
  slope: number;
  /** Water surface above the feet, metres; 0 when dry. */
  waterDepth: number;
  /** How much of the body is under the surface, 0 dry .. 1 the head under. */
  submersion: number;
  /** The head (eye) below the local surface, metres; negative above it. */
  headDepth: number;
  /** Body pitch while swimming or diving, radians: 0 prone and level, positive head up, -pi/2 straight down. */
  swimPitch: number;
  /** Speed of the most recent landing, m/s, and seconds since it. */
  landingSpeed: number;
  landingAge: number;
  /**
   * What is under the feet for footsteps: a `SurfaceMaterial` id on the
   * ground, `PERSON_SURFACE_COLLIDER_BASE` + a collider material id on a
   * deck or floor, `PERSON_SURFACE_WATER` in water, -1 in the air.
   */
  surface: number;
  /** Getting in or out of the car, null otherwise. */
  boarding: PersonBoardingState | null;
}

/** `PersonVisualState.surface` for a foot in water. */
export const PERSON_SURFACE_WATER = -2;
/** `PersonVisualState.surface` offset for a collider top (`ColliderMaterial` id added). */
export const PERSON_SURFACE_COLLIDER_BASE = 1_000;

/**
 * The walking session's other half and its prompt, on
 * `FlightVisualState.walking`.
 */
export interface WalkingVisualState {
  driven: "person" | "car";
  /**
   * The parked car, as its own surface visual state, while the person is
   * driven; null while the car is (it is the common state then, with the
   * person seated in it).
   */
  car: FlightVisualState | null;
  /** The car's front doors, 0 shut .. 1 open: right (driver's), then left. */
  doors: [number, number];
  /** The get-in or get-out prompt, when one applies; `ready` false says why not. */
  prompt: WalkingPrompt | null;
}

export interface WalkingPrompt {
  action: "getIn" | "getOut";
  ready: boolean;
  /** Why it cannot happen now: the car is moving, or every door is blocked. */
  reason: "moving" | "blocked" | null;
}

export type BoatGear = "forward" | "neutral" | "reverse";

/** What the HUD, the drawn boat, its wake, spray and sound read from the sim. */
export interface BoatVisualState {
  kind: "boat";
  /** Speed through the water, m/s: what the boat's own log reads. */
  speedThroughWater: number;
  gear: BoatGear;
  /** The binnacle lever as the sim holds it, -1 full astern .. +1 full ahead. */
  lever: number;
  /** Outboard steer angle, radians; positive swings the bow to starboard. */
  steerAngle: number;
  /** Power trim, 0..1 of its range (the HUD's 0-100%), and the engine tilt it gives, radians. */
  trim: number;
  trimAngle: number;
  /** Trim-tab deflection, 0..1 of full, each side. */
  tabPort: number;
  tabStarboard: number;
  /** Water under the keel, metres: the depth sounder. */
  depthUnderKeel: number;
  /** Fraction of the propeller disc under the local surface, 0..1. */
  propellerImmersion: number;
  moored: boolean;
  ventilating: boolean;
  capsized: boolean;
  /** 0 in displacement mode .. 1 fully on the plane; scales wake and spray. */
  planing: number;
  /** Wetted keel length, metres, and how deep the transom's lowest point sits, metres. */
  wettedLength: number;
  transomImmersion: number;
  /**
   * Where spray leaves the hull this step: up to `MAX_BOAT_SPRAY_ROOTS`
   * records of body-frame x, y, z (metres) and the jet's speed (m/s),
   * flattened. `sprayRootCount` says how many are live.
   */
  sprayRoots: number[];
  sprayRootCount: number;
}

export const MAX_BOAT_SPRAY_ROOTS = 16;

/**
 * The boat's controls, carried on `ControlState.boat` by the boat input
 * profile. Trim and tabs are RATE commands, as the rocker switches on a real
 * helm are: the sim holds the positions.
 */
export interface BoatControlState {
  /** Single-lever binnacle control: -1 full astern, 0 neutral idle, +1 full ahead. */
  lever: number;
  /** Wheel, -1 hard to port .. +1 hard to starboard. */
  steer: number;
  /** Power trim rocker: +1 trims out (bow up), -1 trims in. */
  trim: number;
  /** Tab rocker: +1 lowers the tabs (bow down), -1 raises them. */
  tabs: number;
  /**
   * Counts moor / cast-off presses, so a press survives a coalesced message.
   * Only a CHANGE is a press: a simulator adopts the first count it sees as
   * its baseline, whatever it is.
   */
  moorPresses: number;
}

/** The LandCruiser 76's gearbox, chosen on its card in the picker (land decision 1). */
export type CarGearbox = "automatic" | "manual";
/** The part-time transfer case: rear drive, locked 4WD high, locked 4WD low. */
export type CarTransferRange = "2H" | "4H" | "4L";
/** The diff locks, in Toyota's order: the rear engages first, then the front. */
export type CarDiffLocks = "off" | "rear" | "both";
export type CarHeadlights = "off" | "dipped" | "main";
/** The tyre pressure preset, set while stopped: road 2.4 bar, sand 1.2 bar. */
export type CarTyrePressure = "road" | "sand";

/** How a car session is set up, from settings, before its first step. */
export interface CarSetup {
  gearbox: CarGearbox;
  /** The player works the clutch pedal (Q). Off, an auto-clutch launches and shifts. */
  manualClutch: boolean;
}

/** The order of every per-wheel array in `CarVisualState`. */
export const CAR_WHEELS = ["frontLeft", "frontRight", "rearLeft", "rearRight"] as const;
export type CarWheel = (typeof CAR_WHEELS)[number];

/**
 * What the HUD, the drawn car, its effects and its sound read from the sim.
 * Body frame as everywhere: +X forward, +Y up, +Z right (the driver's side
 * on the right-hand-drive 76). Per-wheel arrays have four entries in
 * `CAR_WHEELS` order; per-axle arrays have two, front then rear.
 */
export interface CarVisualState {
  kind: "car";
  /** Signed speed along the body's forward axis, m/s: what the speedometer reads. */
  speed: number;
  gearbox: CarGearbox;
  /**
   * The automatic's selector: P, R, N, D, or M in its sequential mode. Null
   * with the manual, whose position is `gear`.
   */
  selector: "P" | "R" | "N" | "D" | "M" | null;
  /** The gear engaged: -1 reverse, 0 neutral, 1..6 (automatic) or 1..5 (manual). */
  gear: number;
  range: CarTransferRange;
  locks: CarDiffLocks;
  /** Downhill assist armed (B), and holding the car's speed right now. */
  downhillAssist: boolean;
  downhillAssistActive: boolean;
  tractionControlActive: boolean;
  absActive: boolean;
  /** How much torque the clutch passes: 0 open .. 1 fully engaged. */
  clutch: number;
  engineRunning: boolean;
  stalled: boolean;
  /** Water reached the air intake and the engine hydrolocked: the HUD's FLOODED. */
  flooded: boolean;
  /** The roof or a side is on the ground: the HUD's ROLLED. */
  rolled: boolean;
  /** Turbo boost, 0..1 of full, for the whistle. */
  boost: number;
  headlights: CarHeadlights;
  brakeLights: boolean;
  reversing: boolean;
  tyrePressure: CarTyrePressure;
  /** What the tyres hold now, bar; they take a while to reach the preset. */
  tyrePressureBar: number;
  /** Water above the ground at the car, metres; 0 when dry. The wading bar. */
  wadingDepth: number;
  /**
   * Of the tyres in water, the share in the sea rather than a lake or river,
   * 0..1 (0 when dry): the water the wading depth is in. The sea's surface
   * carries its waves, so its level alone cannot say.
   */
  wadingSea: number;
  /**
   * The car is waiting at its start for the terrain under it to stream in,
   * held still and not simulated (at most `GROUND_WAIT_SECONDS`).
   */
  settling: boolean;
  /** Road-wheel steer angle, radians; positive turns the wheel's front to the right. */
  wheelSteer: number[];
  /** Rolling angle, radians, wrapped to [0, 2 pi), and spin rate, rad/s. */
  wheelSpin: number[];
  wheelSpinRate: number[];
  /** Vertical tyre load, newtons; 0 in the air. */
  wheelLoad: number[];
  /** Combined slip magnitude, 0 rolling .. 1 sliding or spinning: dust, spray, sound. */
  wheelSlip: number[];
  /** How deep the tyre sits in soft ground, metres: track width and darkness. */
  wheelSinkage: number[];
  /** The `SurfaceMaterial` id under each tyre, or -1 in water or the air. */
  wheelSurface: number[];
  /**
   * The soil's wetness under each tyre, 0 dry .. 1 soaked, raised when the
   * weather rains; 0 in the air, 1 in water. Mud spray rather than dust, and
   * darker tracks.
   */
  wheelWetness: number[];
  /**
   * Each solid axle's travel against the frame: heave in metres, positive into
   * bump (the axle closer to the body), zero at the static kerb ride height,
   * and roll in radians, positive with the axle's right end higher than its
   * left. Wheels sit at the axle's ends: a wheel centre is at body
   * y = -0.43 + heave + side x track / 2 x sin(roll), side -1 left, +1 right.
   */
  axleHeave: number[];
  axleRoll: number[];
  /** The steering wheel's angle, radians, for the cockpit. */
  steeringWheel: number;
  /** Peaks since the last snapshot, 0..1, for sound and effects. */
  bumpStop: number;
  scrape: number;
  splash: number;
}

/**
 * The car's controls, carried on `ControlState.car` by the car input profile.
 * Pedals and wheel are positions; everything a key toggles is a press COUNT,
 * so a press survives a coalesced message. Only a change is a press: a
 * simulator adopts the first counts it sees as its baseline.
 */
export interface CarControlState {
  /** Accelerator pedal, 0..1 (W, right trigger). */
  accelerator: number;
  /** Service brake, 0..1 (S, left trigger). At a stop the sim turns a held S into reverse. */
  brake: number;
  /** Steering, -1 full left .. +1 full right, eased by the input profile. */
  steer: number;
  /** Handbrake, 0..1 (Space, A button): the transmission drum. */
  handbrake: number;
  /** Clutch pedal, 0 up .. 1 down (Q, X button); read only with `CarSetup.manualClutch`. */
  clutch: number;
  /** Shift and Ctrl, the bumpers. */
  shiftUpPresses: number;
  shiftDownPresses: number;
  /** M: the automatic back from its sequential mode to D. */
  autoModePresses: number;
  /** T: 2H, 4H, 4L (4L needs a stop). */
  rangePresses: number;
  /** K: off, rear, rear and front (4L only). */
  lockPresses: number;
  /** B: downhill assist. */
  downhillAssistPresses: number;
  /** L: off, dipped, main. */
  headlightPresses: number;
  /** The preset asked for in the pause menu's vehicle panel; the sim inflates only while stopped. */
  tyrePressure: CarTyrePressure;
}

/** What the HUD shows of an engaged autoland. */
export interface AutolandVisualState {
  phase: Exclude<AutolandPhase, "off">;
  /** Approach number, from 1; each go-around starts the next. */
  attempt: number;
  /** Track distance still to fly to the touchdown point, metres. */
  distanceToTouchdown: number;
  /** Landing direction, degrees true (0..360). */
  runwayHeading: number;
  /** Airspeed being held, m/s indicated. */
  targetAirspeed: number;
  goAroundReason: GoAroundReason | null;
  /** Centre of the runway being landed on, world metres. */
  runwayX: number;
  runwayZ: number;
  /**
   * The levers the autoland is commanding, which the pilot's input takes over
   * on hand-back (`InputManager.adoptConfiguration`). Commands rather than the
   * actuators, because gear or flaps in transit are going where these say.
   */
  throttle: number;
  flaps: number;
  gear: number;
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
  /** Present only while driving a boat; aircraft never send it. */
  boat?: BoatControlState;
  /** Present only while driving the car; aircraft and boats never send it. */
  car?: CarControlState;
  /** Present only while on foot in a car session's walking mode. */
  person?: PersonControlState;
  /**
   * Get in or out of the car (X, pad Y), as a press COUNT like the car's
   * toggles: on foot a press at the door; in the car the input profile counts
   * one only after X is HELD 0.4 s, so a stray tap never throws you out.
   * Car sessions only.
   */
  interactPresses?: number;
}

/**
 * The walker's controls, carried on `ControlState.person` by the person input
 * profile. The move vector is already in world axes, turned by the camera's
 * yaw on the main thread, so the worker never needs the camera; its pitch
 * comes along for swimming where the camera points.
 */
export interface PersonControlState {
  /** World-axis move, |(moveX, moveZ)| <= 1: keys give 1, a stick anything between. */
  moveX: number;
  moveZ: number;
  /** The camera's pitch, radians, positive looking up: under water you swim where it points. */
  lookPitch: number;
  /** Shift held (or toggled in settings), right trigger: run, or the faster stroke. */
  run: boolean;
  /** Space, pad A, held: rise in the water. */
  rise: boolean;
  /** Ctrl, pad B, held: dive, or swim down. */
  dive: boolean;
  /** Space, pad A: jumps, as a press count. */
  jumpPresses: number;
}

/** Which governor acted (or held) in the most recent decision window (1A-6b). */
export type RenderGovernorMode =
  | "gpu-resolution"
  | "cpu-work"
  | "gpu-work"
  | "frame-pacing"
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
  /**
   * Inland water generation has fallen back to the MAIN thread for good (the
   * worker could not be built, or crashed past its restart budget). Every new
   * region is then a long main-thread task: ~80 ms at 1x, 317 ms at 4x.
   */
  hydrologyMainThreadFallback: boolean;
  /** The last completed hydrology region came from the worker. */
  hydrologyLastGenerationUsedWorker: boolean;
  /**
   * The vegetation worker's health: whether cells still generate on it, and
   * how often it was restarted or given up on. A fallback puts every new
   * vegetation cell on the main thread for the rest of the session.
   * Optional so a fixture without it stays valid.
   */
  detailWorker?: DetailWorkerHealth;
  residentTerrainPages: number;
  /**
   * Why those pages are resident, counted per reason.
   *
   * `residentTerrainPages` is a TOTAL over a MIXED POPULATION and was read as
   * "terrain being drawn". Only `drawn` is a candidate for a visibility test:
   * the collision ring is deliberately omnidirectional because physics has no
   * frustum, morph parents pop the children that read them, and erosion seed
   * blocks gate admission. `drawnBeyondShadowDistance` is the only figure a
   * frustum cull could be sized from — terrain inside the shadow distance
   * casts into view from any direction and must stay whether or not it is on
   * screen.
   */
  residencyReasons: {
    drawn: number;
    parent: number;
    collision: number;
    seed: number;
    drawnBeyondShadowDistance: number;
  };
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
  /** Detail cells or atomic presentation chunks that can still change the frame. */
  pendingDetailWork: number;
  /** Terrain generation workers currently busy (1B-4). */
  /** 4-4: the CPU worker pool is gone; this is GPU compute dispatches in flight. */
  terrainComputeDispatches: number;
  estimatedGpuMemoryMiB: number;
  /**
   * The estimate restricted to allocations the inventory walk can see — the
   * only figure it is honest to compare against a measurement. The
   * unrestricted number above remains the budgeting one.
   */
  estimatedInventoriableGpuMemoryMiB: number;
  /**
   * Z-4: best-effort walk of actual texture/geometry allocations — a floor
   * reading the estimate's fudge factor is sanity-checked against.
   */
  inventoriedGpuMemoryMiB: number;
  /**
   * The same walk's three lanes, so a divergence can be ATTRIBUTED and not
   * merely measured. Sums to `inventoriedGpuMemoryMiB` by construction.
   *
   * Required rather than optional deliberately: an absent breakdown would let
   * a gate that reads it pass on nothing, which is the failure mode this whole
   * area already has one of.
   */
  inventoriedGpuMemoryLanes: {
    readonly textureMiB: number;
    readonly geometryMiB: number;
    readonly bufferMiB: number;
  };
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
  groundSpoilers: 0,
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
