import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/imageProcessingPostProcess";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import type {
  CameraMode,
  FlightVisualState,
  GpuPassAttribution,
  PersonVisualState,
  QualityLevel,
  RenderDiagnostics,
  WeatherPreset,
} from "@/src/game/types";
import type { EnvironmentClock } from "@/src/world/environmentClock";
import {
  exposureForState,
  horizontalIlluminanceLux,
  resolveEnvironmentState,
  SCENE_UNIT_TO_NITS,
} from "./webgpu/nature/EnvironmentDirector";
import { StarFieldSystem } from "./webgpu/atmosphere/StarField";
import { LightPointSystem } from "./webgpu/lighting/LightPoints";
import { VolcanicSteamSystem } from "./webgpu/volcanic/VolcanicSteamSystem";
import {
  AirfieldLightingSystem,
  airfieldLampDaylightAttenuation,
} from "./webgpu/lighting/AirfieldLighting";
import {
  AIRCRAFT_CAST_POOLS,
  aircraftWashLights,
  castPoolWorldPosition,
  cockpitInstrumentGlow,
  observerAzimuthDegrees,
  resolveAircraftLights,
} from "./webgpu/lighting/AircraftLighting";
import {
  towerObstructionFixtures,
  hangarObstructionFixtures,
  hangarFaceFloodlights,
  HANGAR_FLOOD_INTENSITY,
} from "./webgpu/lighting/ObstructionLighting";
import { BloomPass } from "./webgpu/lighting/BloomPass";
import { FxaaSharpenPass, SharpenPass } from "./webgpu/lighting/SharpenPass";
import {
  rodFractionForAdaptedLuminance,
  shouldRunScotopicPass,
  ScotopicVisionPass,
} from "./webgpu/atmosphere/ScotopicVision";
import { ClusteredLightingSystem } from "./webgpu/lighting/ClusteredLighting";
import {
  DEFAULT_ENVIRONMENT_STATE,
  type EnvironmentState,
} from "./webgpu/nature/EnvironmentState";
import {
  AerialPerspectiveRegistry,
  type AerialPerspectiveBinding,
} from "./webgpu/atmosphere/AerialPerspective";
import { FULL_MOON_ILLUMINANCE_LUX } from "./webgpu/atmosphere/Ephemeris";
import { AtmosphereGpuResources } from "./webgpu/atmosphere/AtmosphereGpuResources";
import {
  SKY_PROBE_REBAKE_ALTITUDE_METERS,
  SkyEnvironmentProbe,
  skyProbeRefreshAction,
  type SkyRebakeStats,
} from "./webgpu/atmosphere/SkyEnvironmentProbe";
import type { RenderingMode } from "@/src/settings";
import type { AircraftKind } from "@/src/sim";
import { oceanSpectrumSeed, seaSpectrumWindSpeed } from "@/src/sim/water/seaState";
import type { SeaShelterEllipse } from "@/src/sim/water/types";
import { aircraftSpec, rampAtSpeed } from "@/src/aircraft/catalogue";
import { surfaceVehicleSpec, type SurfaceVehicleSpec, type VehicleSpec } from "@/src/vehicles/catalogue";
import { CAR_SEATING, PERSON } from "@/src/vehicles/person";
import { isAircraftKind, isSurfaceVehicleKind, vehicleClass, type VehicleKind } from "@/src/vehicles/kinds";
import {
  infrastructureIndex,
  withAirports,
  type AirportDefinition,
  type TerrainSample,
  type WorldDefinition,
} from "@/src/world";
import { MAX_WIND_SPEED, sampleWind } from "@/src/world";
import { homeMarina } from "@/src/world/marina";
import { infrastructureChangeTouches, infrastructurePlantExclusionsIn } from "@/src/world/infrastructure";
import { RoadStreamRuntime } from "./roads/RoadStreamRuntime";
import { createWebGpuAircraft, type AircraftVisual } from "./webgpu/aircraft";
import { createSurfaceVehicleVisual, type VehicleVisual } from "./webgpu/vehicle";
import { createPersonVisual, type PersonAnimationInput, type PersonVisual } from "./webgpu/person";
import { CharacterCamera, type CameraObstacleBox, type CameraWaterBand, type CharacterCameraWater } from "./characterCamera";
import { LatticeHeightCache } from "./latticeHeightCache";
import type { OceanHullClip } from "./webgpu/boat/oceanHullClip";
import type { UndrawnSeaHeave } from "./webgpu/boat/undrawnSeaHeave";
import { createBoatEffects, type BoatEffects } from "./webgpu/boat/BoatEffects";
import type { CarBowWave } from "./webgpu/ground/CarBowWave";
import { createCarEffects, type CarEffects } from "./webgpu/ground/CarEffects";
import { createCameraWaterSample } from "./webgpu/underwater/cameraWater";
import { UnderwaterView } from "./webgpu/underwater/UnderwaterView";
import type { CarParticleSystem } from "./webgpu/ground/CarParticleSystem";
import type { CarTrackSystem } from "./webgpu/ground/CarTrackSystem";
import type { BoatSpraySystem } from "./webgpu/boat/BoatSpraySystem";
import type { BoatWakeSystem } from "./webgpu/boat/BoatWakeSystem";
import { resolveBoatLights, type BoatWashLight } from "./webgpu/boat/boatLights";
import { CAR_HEADLAMP_POOLS, carLampState, carPoolIntensity } from "./webgpu/ground/carLights";
import { surfaceVehicleWashLights } from "./webgpu/boat/createBoat";
import { AtmosphereSystem } from "./webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "./webgpu/clouds/CloudShadowReceiverRegistry";
import { VolumetricCloudSystem } from "./webgpu/clouds/VolumetricCloudSystem";
import { inspectWebGpuCapabilities } from "./webgpu/core/Capabilities";
import {
  formatGpuUncapturedError,
  GpuUncapturedErrorGuard,
} from "./webgpu/core/GpuUncapturedErrorGuard";
import { installDeferredPassTiming } from "./webgpu/core/DeferredPassTiming";
import { gpuTimingEnabledAtStartup } from "./webgpu/core/GpuTimingPolicy";
import { inventoriedGpuBufferBytes } from "./webgpu/core/GpuBufferInventory";
import {
  FrameGraphBudgetProbe,
  PassTimingHistory,
  WebGpuFrameGraph,
} from "./webgpu/core/FrameGraph";
import { assertStartupInvariants } from "./webgpu/core/RenderInvariants";
import {
  createGovernorState,
  governorConfigForProfile,
  nextGovernorDecision,
  observeRenderScaleApplication,
  workLeverSettingsFor,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
  type WorkLeverSettings,
} from "./webgpu/core/AdaptiveGovernor";
import {
  DISPLAY_RESIZE_REQUEST,
  GOVERNED_SCALE_REQUEST,
  RenderScaleQueue,
  resolveHardwareScalingLevel,
} from "./renderScaleLevel";
import {
  DYNAMIC_ALLOCATIONS,
  estimateGpuMemoryMiB,
  estimateInventoriableGpuMemoryMiB,
  type DynamicAllocationInputs,
} from "./webgpu/core/PerformanceBudget";
import {
  CAMERA_FAR_PLANE_METERS,
  frameTimingPercentile,
  frameTimingPercentile95,
  freshFrameTiming,
  hitchThresholdMilliseconds,
  isUsableFrameTiming,
  resolveWebGpuQualityProfile,
  standaloneSharpen,
  type WebGpuQualityProfile,
} from "./webgpu/core/QualityProfile";
import { AirportSystem } from "./webgpu/detail/AirportSystem";
import { airportRoadFenceOpening } from "@/src/world/roads/roadNodes";
import { MarinaSystem } from "./webgpu/marina/MarinaSystem";
import { RoadSurfaceSystem } from "./webgpu/roads/RoadSurfaceSystem";
import {
  SpawnedAirfieldManager,
  spawnedFloodReserve,
} from "./webgpu/airfield/SpawnedAirfields";
import {
  LiveAirportGround,
  analyticTerrainHeightOf,
  analyticTerrainOf,
} from "./webgpu/airfield/SpawnedAirportGround";
import {
  airportReachWorldBounds,
  airportTerrainReach,
  changedAirports,
} from "./webgpu/airfield/AirportFootprint";
import { windsockHeadingRadians } from "./webgpu/detail/AirfieldFurniture";
import { WorldDetailRuntime } from "./webgpu/detail";
import type { DetailSunShadowSnapshot } from "./webgpu/detail/DetailInstanceMaterialPlugin";
import { GroundCoverSystem } from "./webgpu/detail/GroundCoverSystem";
import {
  AsyncPipelineCompiles,
  type AsyncPipelineCompileStatistics,
} from "./webgpu/core/AsyncPipelineCompiles";
import { meanSeasonalSurfaceAlbedo, type TerrainFarSwardRead } from "./webgpu/terrain/TerrainSurfacePlugin";
import { TerrainClipmapSystem } from "./webgpu/terrain/TerrainClipmapSystem";
import { TerrainEvolutionRuntime } from "./webgpu/terrain/TerrainEvolutionRuntime";
import {
  TerrainMacroErosionGpu,
  TerrainMacroInputsGpu,
} from "./webgpu/terrain/TerrainMacroErosionGpu";
import { terrainMacroGridFromEvolution } from "./webgpu/terrain/TerrainMacroEvolutionClient";
import {
  TerrainConsumerAuthority,
  terrainConsumerHeightFromAuthority,
  terrainConsumerSampleFromAuthority,
} from "./webgpu/terrain/TerrainConsumerAuthority";
import type { TerrainAuxPagePublication } from "./webgpu/terrain/TerrainPageAtlas";
import { WildlifeSystem } from "./webgpu/wildlife";
import { HydrologySystem, type HydrologyWaterPublisher } from "./webgpu/water/HydrologySystem";
import {
  resolveSunShadowCascadeLayout,
  type SunShadowCascadeLayout,
} from "./webgpu/water/SunShadowReceiver";

/** Wave R: the per-frame snapshot is reused, never reallocated. */
type MutableDetailSunShadowSnapshot = {
  -readonly [Key in keyof DetailSunShadowSnapshot]: DetailSunShadowSnapshot[Key];
};
import {
  BATHYMETRY_STORAGE_FORMATS,
  BathymetryClipmap,
  bathymetryErodedPageOverlaySeamFromAtlas,
  bathymetryStorageBytesPerTexel,
  selectBathymetryStorageFormat,
} from "./webgpu/water/BathymetryClipmap";
import { channelGraphToHydrologyGeometry } from "./webgpu/water/ChannelNetwork";
import {
  resolveOceanMipGenerator,
  SpectralOceanSystem,
} from "./webgpu/water/SpectralOceanSystem";
import { WaterEnvironmentField } from "./webgpu/water/WaterEnvironmentField";
import { hydrologyClimateSamplerFor } from "./webgpu/water/hydrologyClimate";
import { volcanicHydrologyInputs } from "./webgpu/water/hydrologyVolcanism";
import type { FlightRenderingSystem, FootstepEvents, ScreenPoint, TerrainAuthorityPublisher } from "./types";
import {
  type TerrainPagePublication,
} from "@/src/workers/terrainAuthority";
import { attributePresentFrame } from "./frameAttribution";
import {
  cameraBankFollow,
  cameraPresentationResponse,
  CHASE_AIM_HEIGHT_METERS,
  cameraRigLiftToRef,
  cameraTrailMeters,
  chaseRigHeightForBank,
  chaseRigOffsetsToRef,
  COCKPIT_AIM_DISTANCE_METERS,
  cockpitEyeForwardUpMetres,
  cockpitEyeRightMeters,
  cockpitRigDrawsAircraft,
  cockpitHorizontalFieldOfViewForAspect,
  type CockpitRigOverride,
  cockpitRigPositionsToRef,
  FRONT_VIEW_FIELD_OF_VIEW_DEGREES,
  frontViewRigOffsetsToRef,
  orthogonalizeCameraUpToRef,
  smoothCameraVectorToRef,
  TOP_VIEW_FIELD_OF_VIEW_DEGREES,
  topViewCameraUpToRef,
  topViewRigOffsetsToRef,
} from "./cameraPresentation";
import { nextObservedGroundSpeed } from "./cameraGroundSpeed";

const FLOATING_ORIGIN_GRID = 2_048;
const FLOATING_ORIGIN_THRESHOLD = 4_096;
const SCENE_STARTUP_TIMEOUT_MILLISECONDS = 45_000;
/** CPU-worker reference path; the future measured GPU pass keeps this boundary. */
const TERRAIN_EVOLUTION_STARTUP_TIMEOUT_MILLISECONDS = 180_000;
const MIN_GPU_TIMING_SAMPLES = 8;
const GPU_TIMING_STALE_AFTER_FRAMES = 30;
/**
 * Z-2: the rolling diagnostics window. Separate from the governor's
 * reset-per-window sample arrays — the governor consumes and clears its
 * window every 120 frames, which is why every committed capture read
 * `gpuFrameMsP95: null` (R-4: the value was discarded before the capture
 * could read it). Diagnostics aggregate over this ring instead.
 */
const DIAGNOSTIC_WINDOW_FRAMES = 600;
/** The present pass cannot be probed off — cutting it blacks the frame. */
const BUDGET_PROBE_EXCLUDED_PASSES: ReadonlySet<string> = new Set([
  "hdr-present",
  // No GPU work of its own; off, the roads would only stop streaming.
  "road-stream",
]);
/**
 * B6: main-thread milliseconds a frame spends sampling a sliced sky rebake
 * (`SkyEnvironmentProbe.advanceRebake`, which always samples one 16-texel
 * row). A rebake is 96 rows and a slice sampled about twenty on the
 * SwiftShader perf host, where the irradiance landed five frames after the
 * rebake began.
 */
const SKY_REBAKE_MILLISECONDS_PER_FRAME = 0.5;

function rendererAbortError(): Error {
  const error = new Error("WebGPU renderer startup was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfRendererStartupAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw rendererAbortError();
}

/**
 * `6-11.3` — the startup-stage split, recorded only when someone asks for it.
 *
 * Consecutive checkpoints name the complete startup critical path, including
 * synchronous constructors and direct async waits that are not routed through
 * `awaitRendererStartup`. This is opt-in and inert otherwise: no allocation,
 * no clock read, and no behaviour change on the shipping path unless a harness
 * calls `beginRendererStartupTrace()` first.
 */
export interface RendererStartupStage {
  readonly label: string;
  readonly kind: "sync" | "async";
  readonly milliseconds: number;
}

interface ActiveRendererStartupTrace {
  readonly stages: RendererStartupStage[];
  lastCheckpointAt: number;
}

let rendererStartupTrace: ActiveRendererStartupTrace | null = null;

/** Start recording startup-stage durations, discarding any previous trace. */
export function beginRendererStartupTrace(): void {
  rendererStartupTrace = {
    stages: [],
    lastCheckpointAt: performance.now(),
  };
}

/** The stages recorded since `beginRendererStartupTrace`, in completion order. */
export function readRendererStartupTrace(): readonly RendererStartupStage[] {
  return rendererStartupTrace?.stages ?? [];
}

/** Stop recording and release the trace. */
export function endRendererStartupTrace(): void {
  rendererStartupTrace = null;
}

/**
 * Close one disjoint interval of the startup critical path.
 *
 * Checkpoints, rather than timers wrapped around selected Promises, are
 * intentional. Calling an async factory can do substantial synchronous work
 * before it returns its Promise, and background work can overlap later main-
 * thread construction. Consecutive checkpoints charge every wall-clock
 * millisecond exactly once and therefore expose both kinds of gap without
 * double-counting an overlapped producer.
 */
function checkpointRendererStartup(label: string, kind: RendererStartupStage["kind"]): void {
  const trace = rendererStartupTrace;
  if (trace === null) return;
  const now = performance.now();
  trace.stages.push({
    label,
    kind,
    milliseconds: now - trace.lastCheckpointAt,
  });
  trace.lastCheckpointAt = now;
}

function awaitRendererStartup<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  label: string,
  timeoutMilliseconds: number,
  disposeLateValue?: (value: T) => void,
): Promise<T> {
  throwIfRendererStartupAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onAbort = () => finish({ error: rendererAbortError() });
    const timeout = setTimeout(() => {
      finish({ error: new Error(`${label} timed out after ${timeoutMilliseconds} ms`) });
    }, timeoutMilliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          disposeLateValue?.(value);
          return;
        }
        finish({ value });
      },
      (error: unknown) => finish({ error }),
    );
  });
}

function releaseRendererResources(
  cleanup: Array<() => void>,
  warningMessage: string,
): void {
  for (let index = cleanup.length - 1; index >= 0; index -= 1) {
    try {
      cleanup[index]?.();
    } catch (error) {
      console.warn(warningMessage, error);
    }
  }
  cleanup.length = 0;
}

export interface ChaseCameraProfile {
  distance: number;
  height: number;
  fieldOfView: number;
  /** Metres ahead of the aircraft the camera aims — speed pushes it forward. */
  aimAhead: number;
}

export function chaseCameraProfile(
  vehicle: VehicleKind,
  airspeed: number,
  out: ChaseCameraProfile = { distance: 0, height: 0, fieldOfView: 0, aimAhead: 0 },
): ChaseCameraProfile {
  const { chase } = isAircraftKind(vehicle) ? aircraftSpec(vehicle) : surfaceVehicleSpec(vehicle);
  out.distance = rampAtSpeed(chase.distance, airspeed);
  out.height = chase.height;
  out.fieldOfView = rampAtSpeed(chase.fieldOfView, airspeed);
  out.aimAhead = rampAtSpeed(chase.aimAhead, airspeed);
  return out;
}

/**
 * The drawn lakes and rivers for the simulation's water, in a car session
 * alone: the car is the only vehicle that reads them (an aircraft has no
 * water, and the boat keeps its sea twin until its own inland water comes),
 * so no other session packs and posts every region for nothing.
 */
export function hydrologyWaterPublisher(
  vehicle: VehicleKind | null | undefined,
  publisher: TerrainAuthorityPublisher | null,
): HydrologyWaterPublisher | null {
  if (!vehicle || vehicleClass(vehicle) !== "car") return null;
  if (!publisher?.publishHydrology || !publisher.evictHydrology) return null;
  return {
    publishHydrology: (key, region) => publisher.publishHydrology?.(key, region),
    evictHydrology: (key) => publisher.evictHydrology?.(key),
  };
}

export function atmosphereFogNear(weather: WeatherPreset): number {
  return weather === "cloudy" ? 2_200 : weather === "clear" ? 4_500 : 3_800;
}

/** Sample counts for the three post-processes that can head the camera chain. */
export interface FirstPassSamples {
  readonly scotopic: number;
  readonly bloom: number;
  readonly toneMap: number;
}

/**
 * Decide which post-process owns the multisampled beauty target.
 *
 * `1B-11`'s rule is that the FIRST post-process owns the offscreen scene target
 * and therefore its sample count. The part that is easy to get wrong is that
 * ownership is DYNAMIC: `ScotopicVision` detaches in photopic daylight, so the
 * head of the chain changes with the time of day, and `7-5` put a third
 * candidate behind it. Chain order is fixed -- rod vision, bloom, tone map --
 * so the owner is simply the first one attached.
 *
 * Pure, and separate from `applyFirstPassOwnership`, because the interesting
 * content here is a three-way policy over eight states and none of it needs a
 * GPU. The test that replaced the old source-string pin exercises all eight.
 */
export function firstPassSampleAssignment(
  msaaSamples: number,
  scotopicAttached: boolean,
  bloomAttached: boolean,
): FirstPassSamples {
  const bloomFirst = !scotopicAttached && bloomAttached;
  const toneMapFirst = !scotopicAttached && !bloomAttached;
  return {
    scotopic: scotopicAttached ? msaaSamples : 1,
    bloom: bloomFirst ? msaaSamples : 1,
    toneMap: toneMapFirst ? msaaSamples : 1,
  };
}

export class AtmosphereChangeTracker {
  private dayOfYear = Number.NaN;
  private solarTimeHours = Number.NaN;
  private weather: WeatherPreset | null = null;

  update(clock: EnvironmentClock, weather: WeatherPreset): boolean {
    if (
      clock.dayOfYear === this.dayOfYear
      && clock.solarTimeHours === this.solarTimeHours
      && weather === this.weather
    ) return false;
    this.dayOfYear = clock.dayOfYear;
    this.solarTimeHours = clock.solarTimeHours;
    this.weather = weather;
    return true;
  }
}

export type TerrainSampleFunction = (x: number, z: number) => TerrainSample;

/** The views the walker shares with the vehicles: the orbit and the top and front framing (`PERSON`). */
const PERSON_VIEW_FRAMING: Pick<VehicleSpec, "cinematic" | "topFront" | "cockpitEye"> = Object.freeze({
  cinematic: PERSON.cinematic,
  topFront: PERSON.topFront,
  cockpitEye: Object.freeze({ forward: 0.12, up: PERSON.eyeHeight, right: 0 }),
});

/** The figure's pose while seated at the wheel: driving, the person is not simulated. */
function seatedPersonState(): PersonVisualState {
  return {
    kind: "person",
    mode: "seated",
    speed: 0,
    running: false,
    grounded: true,
    slope: 0,
    waterDepth: 0,
    submersion: 0,
    headDepth: -PERSON.stature,
    swimPitch: 0,
    landingSpeed: 0,
    landingAge: 60,
    surface: -1,
    boarding: null,
  };
}

export interface FlightRendererOptions {
  canvas: HTMLCanvasElement;
  aircraft: AircraftKind;
  /**
   * What the player will drive, when it is not an aircraft: its visual is
   * built beside the aircraft and takes over whenever the state carries a
   * surface vehicle's payload. The menu's attract flight stays `aircraft`.
   * Unset (or an aircraft kind) builds nothing extra.
   */
  vehicle?: VehicleKind;
  terrainSample: TerrainSampleFunction;
  /**
   * `terrainSample(x, z).height` alone, bit for bit (`sampleTerrainHeight` of
   * the same world), for the consumers that read only the height: it costs
   * none of the normal's four extra heights or the surface classification.
   * Unset, those consumers read the full sample's height, and the
   * ground-cover tile keeps its whole-row bake.
   */
  terrainHeight?: (x: number, z: number) => number;
  world: WorldDefinition;
  seed: number;
  /**
   * The weather the session starts in, so the sea is built for it rather than
   * rebuilt by the first `setAtmosphere` (D2: the sea's spectrum wind is the
   * world's prevailing wind times `weatherWindScale`). Unset is Breezy, the
   * world's own wind.
   */
  weather?: WeatherPreset;
  quality: QualityLevel;
  renderingMode: RenderingMode;
  reducedMotion: boolean;
  runway?: Readonly<AirportDefinition>;
  /**
   * Where the session will start in plan (the spawn the simulation is given:
   * the car on the apron, the boat at its berth, the aircraft on the runway
   * or in the air off it). Startup waits for the streamed roads round it, so
   * the first pages bake with them. Unset: the home airport's centre.
   */
  startPoint?: { readonly x: number; readonly z: number };
  signal?: AbortSignal;
  onDeviceLost?: (reason: string) => void;
  /**
   * A raw WebGPU validation/internal error rejects work asynchronously, so it
   * does not pass through render()'s synchronous try/catch and need not lose
   * the device. Treat the first event as terminal rather than continuing to
   * report rAF FPS over a rejected, black frame.
   */
  onGpuUncapturedError?: (reason: string) => void;
  /**
   * Z-1: pin the render scale and disable both governors. The perf capture
   * pins either the shipping tier scale or an explicit cap-stress scale, and
   * no governor state can rewrite pixels mid-run. Interactive sessions leave
   * it unset.
   */
  pinnedRenderScale?: number;
  /**
   * Capture-only timestamp-query diagnostic. Normal gameplay and captures do
   * not pay Babylon's continuous resolve/submit/map overhead; `true` is
   * accepted only together with `pinnedRenderScale`.
   */
  captureGpuTiming?: boolean;
  /**
   * B6: how the sky probe re-lights the world after the camera's altitude
   * drifts. "sliced" (the default) samples the irradiance over frames and
   * lands it in one; "sync" re-lights in the frame that asks, as every
   * re-light did before slicing, for a capture whose baselines must not move.
   * An environment change re-lights at once either way. Render-scale pinning
   * does not choose this, because perf:flight is pinned and must fly the
   * sliced path; the capture's time pin does (`pinOceanCascadePhaseForCapture`).
   */
  skyRebake?: "sliced" | "sync";
  /**
   * Replace the gameplay cockpit rig — its lens and its lateral eye — with the
   * previous one. Perf capture ONLY: its cockpit-mode shots were placed for a
   * 56 degree lens and have to stay comparable. Interactive sessions leave it
   * unset, and `tests/render.cockpit-rig.test.ts` fails if anything under
   * `src/` other than this file and `cameraPresentation.ts` names it.
   */
  cockpitRigOverride?: CockpitRigOverride;
  /**
   * V-4: the terrain's far-sward read ("off" | "cheap" | "soft"), so one build
   * prices all three. Unset keeps TERRAIN_FAR_SWARD_READ_DEFAULT ("soft").
   * Development only: the game passes `?farSward=`, never a saved setting.
   */
  terrainFarSwardRead?: TerrainFarSwardRead;
}

/**
 * What the `?bench=1` benchmark (`src/bench`) reads after every frame, through
 * `readBenchProbe`. Every field is a number or a reference the renderer
 * already holds. The governor's state and signals are frozen and replaced on
 * every decision, so a changed `governorSignals` reference is one decision.
 */
export interface RendererBenchProbe {
  frameIndex: number;
  governorState: GovernorState;
  governorSignals: GovernorSignals;
  governorConfig: GovernorConfig;
  /** Whole, so the bench never reads a lever field the renderer does not. */
  workLevers: WorkLeverSettings;
  /** The scale the engine's level was last resolved from. */
  appliedRenderScale: number;
  /**
   * The engine's raster size. When the pixel cap binds, a governor step moves
   * `appliedRenderScale` and leaves these alone, so rendered pixels are read
   * here rather than derived from the scale.
   */
  renderWidth: number;
  renderHeight: number;
  pinned: boolean;
  /** GPU milliseconds resolved during this frame; null without timing or a fresh sample. */
  gpuFrameMs: number | null;
}

function finiteState(state: FlightVisualState): boolean {
  return [
    state.position.x,
    state.position.y,
    state.position.z,
    state.orientation.x,
    state.orientation.y,
    state.orientation.z,
    state.orientation.w,
  ].every(Number.isFinite);
}

/** WebGPU-only flight renderer and owner of all device-bound presentation state. */
/**
 * 7-2: the display value a fully saturated rod response maps to, before the
 * one exposure curve and ACES. 0.16 puts a well-adapted night scene at the
 * bottom of the mid-tones — dim, readable, and unmistakably not daylight.
 */
const SCOTOPIC_MID_GREY_TARGET = 0.16;

export class FlightRenderer implements FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  private readonly engine: WebGPUEngine;
  private readonly gpuUncapturedErrorGuard: GpuUncapturedErrorGuard;
  /** 2-13: the world definition, kept for per-frame wind-field sampling. */
  private readonly worldDefinition: WorldDefinition;
  private readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly graph = new WebGpuFrameGraph();
  private readonly aircraft: AircraftVisual;
  /** The surface vehicle the session can drive, or null when it is aircraft only. */
  private readonly surfaceVehicle: VehicleVisual | null;
  private readonly surfaceVehicleSpec: SurfaceVehicleSpec | null;
  /** The surface vehicle's lamp washes, riding the aircraft's nav-wash slots. */
  private readonly surfaceVehicleWashes: readonly BoatWashLight[];
  /** The spray a boat throws and the wake it leaves; null outside a boat session. */
  private readonly boatSpray: BoatSpraySystem | null;
  private readonly boatWake: BoatWakeSystem | null;
  /** The sea kept out of the boat's hull, posed with it. */
  private readonly boatHullClip: OceanHullClip | null;
  /** The swell this tier does not draw, which the drawn boat is lowered by. */
  private readonly boatHeave: UndrawnSeaHeave | null;
  /** What the car throws into the air, the prints it leaves and its bow wave; null outside a car session. */
  private readonly carParticles: CarParticleSystem | null;
  private readonly carTracks: CarTrackSystem | null;
  private readonly carBowWave: CarBowWave | null;
  /** The view from under the water, where the walker can dive; null outside a car session. */
  private readonly underwater: UnderwaterView | null;
  /** Whether the surface vehicle, not the aircraft, is the one on screen. */
  private surfaceActive = false;
  /** The surface follow's level frame: the bow's heading and world up. */
  private readonly surfaceRigForward = new Vector3(1, 0, 0);
  private readonly surfaceRigUp = new Vector3(0, 1, 0);
  private readonly terrain: TerrainClipmapSystem;
  private readonly terrainEvolution: TerrainEvolutionRuntime;
  /** Main-thread copy serving wildlife and inline detail placement. */
  private readonly terrainConsumerAuthority: TerrainConsumerAuthority | null;
  private readonly atmosphere: AtmosphereSystem;
  private readonly detailSunShadowMatrices = new Float32Array(64);
  private readonly detailSunShadowView = new Float32Array(16);
  private detailSunShadowLayoutKey = "";
  private detailSunShadowLayout: SunShadowCascadeLayout | null = null;
  private readonly detailSunShadowSnapshot: MutableDetailSunShadowSnapshot = {
    matrices: this.detailSunShadowMatrices,
    view: this.detailSunShadowView,
    splits: [0, 0, 0, 0],
    blendStarts: [0, 0, 0, 0],
    cascadeCount: 0,
    darkness: 0,
    bias: 0,
    shadowMaxZ: 0,
    valid: false,
    map: null,
  };
  private readonly clouds: VolumetricCloudSystem;
  private readonly cloudShadowReceivers: CloudShadowReceiverRegistry;
  private readonly aerialReceivers: AerialPerspectiveRegistry;
  private readonly skyProbe: SkyEnvironmentProbe;
  private readonly ocean: SpectralOceanSystem;
  /** `W-8`: the sea's climate provinces, baked per 50 km of flight. */
  private readonly waterEnvironment: WaterEnvironmentField;
  /** `W-8`: skip the first frame's bake — see the frame-graph node. */
  private waterEnvironmentBakeDeferred = true;
  private readonly hydrology: HydrologySystem;
  private readonly bathymetry: BathymetryClipmap;
  /**
   * The estimator's allocation inputs with the bathymetry row at the LIVE
   * storage format: `DYNAMIC_ALLOCATIONS` itself on a tier1 adapter, and the
   * rgba16float bytes-per-texel on the core-only fallback, so the reported
   * estimate is the allocated figure on both.
   */
  private readonly dynamicAllocations: DynamicAllocationInputs;
  private readonly airport: AirportSystem | null;
  private readonly detail: WorldDetailRuntime;
  private readonly groundCover: GroundCoverSystem;
  /** The streamed roads (null in an eroded world, which has no stage). */
  private readonly roads: RoadStreamRuntime | null;
  /** The roads' ribbons and guardrails near the camera, on the ground as drawn; with the streamed roads. */
  private readonly roadSurface: RoadSurfaceSystem | null;
  private readonly wildlife: WildlifeSystem;
  private readonly toneMap: ImageProcessingPostProcess;
  /** FXAA with the final sharpen fused in; attached only where MSAA is off. */
  private readonly fxaa: FxaaSharpenPass;
  /** 7-3: the catalogue star field, one additive draw. */
  private readonly stars: StarFieldSystem;
  /**
   * `7-5`: the lights you SEE, one additive instanced draw.
   *
   * POPULATED from `AirfieldLightingSystem`. It was constructed EMPTY until
   * that system existed, and the comment here previously said the fixtures
   * were `7-7`'s. That was wrong and it is worth recording why, because the
   * error is what kept the airfield dark: `owners.ts` states plainly that
   * `AirfieldLightingSystem` "lands with 7-5, which owns the billboard path a
   * PAPI is drawn through". The scope boundary was taken from the `plannedBy`
   * rows rather than from the note that states it, so two gates of
   * night-lighting work shipped correct, green, and invisible.
   */
  private readonly lightPoints: LightPointSystem;
  /**
   * Volcanic phase 5: steam over vents, one instanced draw while a vent is
   * within 15 km and a disabled mesh otherwise. Tier 0 builds nothing.
   */
  private readonly steam: VolcanicSteamSystem;
  /**
   * The home marina, world content in every session like the airfield: its
   * meshes (near, silhouette, culled by camera distance) and its lamps, which
   * are home fixtures of `lightPoints` from `marinaLampStart` on.
   */
  private readonly marina: MarinaSystem;
  private readonly marinaLampStart: number;
  private readonly clusteredLighting: ClusteredLightingSystem;
  /**
   * Names of `7-14`'s hangar-face floods, for the per-frame daylight gate.
   *
   * Held as names rather than as definitions because `setIntensity` addresses
   * by name and returns false for anything the container REFUSED at
   * construction — so a rejected flood cannot silently accept intensity writes
   * every frame, and this list stays the caller's record of what it asked for.
   */
  private readonly hangarFloodNames: readonly string[];
  /**
   * `7-8`: last frame's daylight attenuation, so the aircraft cast pools take
   * the SAME value the floods and billboards did rather than recomputing it a
   * third time and drifting.
   */
  private lastDaylightAttenuation = 1;
  /** One-shot latch: a refused cast pool is worth saying once, not per frame. */
  private castPoolWarned = false;
  /**
   * `7-7`'s fixtures, expanded into `7-5`'s light points, plus the PAPI's
   * analytic indication. Null when the world has no airport.
   */
  private readonly airfieldLighting: AirfieldLightingSystem | null;
  /**
   * `7-2`: rod vision. First in the chain WHENEVER IT IS ATTACHED -- which is
   * not always, so it is not unconditionally MSAA's owner. See
   * `applyFirstPassOwnership`.
   */
  private readonly scotopic: ScotopicVisionPass;
  /**
   * `7-5`: bloom, between rod vision and the tone map.
   *
   * Constructed at every tier and gated by ATTACHMENT, not by construction --
   * the chain's order is fixed when its members are built, so a pass that only
   * exists at some tiers could never be inserted in the right place later.
   */
  private readonly bloom: BloomPass;
  /**
   * The final contrast-adaptive sharpen as a pass of its own, LAST in the
   * chain, where FXAA does not run to carry it; detached otherwise and at a
   * zero `sharpenAmount`. See `SharpenPass` for why every tier presents softer
   * than its raster.
   */
  private readonly sharpen: SharpenPass;
  private readonly resizeObserver: ResizeObserver;
  /** B1: owns the hardware scaling level; see `RenderScaleQueue`. */
  private readonly renderScaleQueue: RenderScaleQueue;
  private readonly atmosphereTracker = new AtmosphereChangeTracker();
  private readonly bodyMatrix = Matrix.Identity();
  private readonly bodyQuaternion = Quaternion.Identity();
  private readonly forward = Vector3.Right();
  private readonly up = Vector3.Up();
  private readonly cameraTarget = Vector3.Zero();
  private readonly desiredCameraTarget = Vector3.Zero();
  private readonly desiredCamera = Vector3.Zero();
  private readonly desiredCameraUp = Vector3.Up();
  /** The bank-blended vertical the exterior rigs build their offsets on. */
  private readonly cameraRigLift = Vector3.Up();
  /** Camera and aim point relative to the aircraft, which is what is smoothed. */
  private readonly cameraOffset = Vector3.Zero();
  private readonly cameraTargetOffset = Vector3.Zero();
  /**
   * The walker's figure, in a car session (the walking plan): on foot it
   * follows the person's pose, driving it sits at the wheel of the drawn car.
   * Null in aircraft and boat sessions, which never build one.
   */
  private person: PersonVisual | null = null;
  private personEnabled = false;
  /** The car's cockpit view as last applied: on foot the car is seen from outside in every view. */
  private carCockpitView = false;
  private readonly characterCamera = new CharacterCamera();
  /** The figure's foot strikes since the last `consumeFootsteps`. */
  private readonly footsteps: FootstepEvents = { count: 0, strength: 0 };
  private readonly characterLook = { yaw: 0, pitch: 0, zoom: 0 };
  private walkerGround: LatticeHeightCache | null = null;
  private lastWalkingDriven: "car" | "person" | null = null;
  /** The parked car's pose while the walker is on foot, beside `bodyQuaternion`'s person. */
  private readonly vehicleQuaternion = new Quaternion();
  private readonly vehicleMatrix = new Matrix();
  private readonly seatedPerson = seatedPersonState();
  private readonly seatPosition = Vector3.Zero();
  private readonly seatScratch = Vector3.Zero();
  /** Where the walker last stood on foot, world, for the figure's walk to the door. */
  private readonly lastFootPose = { x: 0, y: 0, z: 0, heading: 0, valid: false };
  private boardingFrom: { forward: number; up: number; right: number; facing: number } | null = null;
  /**
   * The water the character camera keeps a side of (the underwater view's
   * camera sampler), and the side: the walker's head's, changed only once the
   * head is past the surface's band on the other side.
   */
  private readonly characterWaterSample = createCameraWaterSample();
  private characterWaterTime = 0;
  private readonly characterWater: CharacterCameraWater = {
    below: false,
    at: (x: number, y: number, z: number, out: CameraWaterBand): boolean => {
      const underwater = this.underwater;
      if (!underwater) return false;
      const sample = underwater.cameraWater.sample(
        x + this.originX,
        y,
        z + this.originZ,
        this.characterWaterTime,
        this.characterWaterSample,
      );
      if (sample.kind === "none") return false;
      out.surface = sample.surfaceHeight;
      out.clearance = sample.clearance;
      return true;
    },
  };
  private readonly parkedCarObstacle: CameraObstacleBox = {
    centerX: 0, centerY: 0, centerZ: 0, halfX: 1, halfY: 1, halfZ: 1, qx: 0, qy: 0, qz: 0, qw: 1,
  };
  private readonly personAnimation: {
    person: PersonVisualState;
    velocityX: number;
    velocityY: number;
    velocityZ: number;
    turnRate: number;
    steeringWheel: number;
    lookYaw: number;
    lookPitch: number;
    boardingFrom: { forward: number; up: number; right: number; facing: number } | null;
    boardingDoor: number;
    groundOffset(forward: number, right: number): number;
  } = {
    person: seatedPersonState(),
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    turnRate: 0,
    steeringWheel: 0,
    lookYaw: 0,
    lookPitch: 0,
    boardingFrom: null,
    boardingDoor: 0,
    groundOffset: () => 0,
  };
  /** Last frame's aircraft position, for the observed ground speed. */
  private readonly previousAircraftPosition = Vector3.Zero();
  private previousAircraftPositionValid = false;
  /** B2: that position's simulation time, which the distance is flown over. */
  private previousSimulationTime = 0;
  /** Observed ground speed in m/s, which is what sets the chase trail. */
  private observedGroundSpeed = 0;
  /** Frames a frozen simulation clock has held it (`nextObservedGroundSpeed`). */
  private observedGroundSpeedHeldFrames = 0;
  private readonly cameraViewDirection = Vector3.Right();
  private readonly cameraWorld = Vector3.Zero();
  /** The camera's view-projection and frustum this frame, for the marina's caster gate. */
  private readonly marinaViewProjection = Matrix.Identity();
  private readonly marinaFrustum = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
  private readonly frameIntervalDurations: number[] = [];
  private readonly cpuFrameDurations: number[] = [];
  private readonly gpuFrameDurations: number[] = [];
  /** Z-2: rolling rings the governor never resets (see DIAGNOSTIC_WINDOW_FRAMES). */
  private readonly diagnosticIntervalDurations: number[] = [];
  private readonly diagnosticCpuDurations: number[] = [];
  private readonly diagnosticGpuDurations: number[] = [];
  /** B-0: residuals computed only from three measurements of the same frame. */
  private readonly diagnosticPresentWaitDurations: number[] = [];
  private readonly dynamicShadowCasters = new Map<number, Mesh>();
  private readonly adapterLabel: string;
  private readonly seaLevel: number;
  /** `7-15`: which lamp geometry the wash lights follow. Both airframes ship. */
  private readonly aircraftKind: AircraftKind;
  private readonly latitudeDegrees: number;
  /**
   * The chase rig's ground clamp, and the free-fly viewer's: the live
   * consumer height. It must track the terrain the player SEES: in eroded
   * worlds that is the consumer authority's surface, not the analytic
   * pre-erosion kernel — clamping against an invisible ridge shoved the
   * chase camera upward with no visual justification.
   */
  private readonly cameraTerrainHeight: (x: number, z: number) => number;
  private environmentState: EnvironmentState = DEFAULT_ENVIRONMENT_STATE;
  private skyProbeStale = false;
  private skyProbeAltitudeMeters = 0;
  /** B6: re-light in one frame (`FlightRendererOptions.skyRebake`). */
  private skyRebakeSynchronous: boolean;
  /** A sliced rebake has sampled every texel; it lands on the next frame. */
  private skyRebakeSampled = false;
  /** A sliced rebake landed last frame; its specular cube re-renders on this one. */
  private skyProbeRearmPending = false;
  /**
   * The snapshot a sliced rebake's irradiance was sampled from, for the
   * cloud ambient LUT, which re-bakes from it on the frame after the cube's
   * re-arm.
   */
  private skyAmbientLutPending: AerialPerspectiveBinding | null = null;
  /** The camera altitude the probe's refresh saw last frame, to tell a teleport from a climb. */
  private skyProbeCameraAltitudeMeters = Number.NaN;
  /** What the probe's refresh cost on the main thread, for the perf probe. */
  private skyRefreshLastMilliseconds = 0;
  private skyRefreshMaxMilliseconds = 0;
  private skyRefreshFrameIndex = -1;
  private currentState: FlightVisualState | null = null;
  private currentDeltaSeconds = 1 / 60;
  private profile: WebGpuQualityProfile;
  private quality: QualityLevel;
  private renderingMode: RenderingMode;
  private cameraMode: CameraMode = "chase";
  /** Beta terrain viewer: aircraft hidden, free-fly camera rig active. */
  private viewerMode = false;
  private reducedMotion: boolean;
  private originX = 0;
  private originZ = 0;
  /**
   * The world as it stands now: the starting world with every airport spawned
   * since (`withAirports`). Only its airport list ever differs from
   * `worldDefinition`.
   */
  private liveWorld: WorldDefinition;
  /**
   * The ground every CPU terrain consumer reads (vegetation, ground cover,
   * wildlife, the camera clamp, spawned airfields): the consumer sampler, with
   * spawned airports' authored earthworks inside their influence.
   */
  private readonly airportGround: LiveAirportGround<TerrainSample>;
  /**
   * `airportGround`'s height alone, bit for bit, for the consumers that read
   * nothing else: the camera clamp, the spawned airfields, the ground-cover
   * tile and the birds.
   */
  private readonly airportHeight: LiveAirportGround<number>;
  /**
   * Airfields for airports spawned in flight — structures, lamps and floods,
   * built incrementally on the home field's materials. Null without a home
   * field, which a world that cannot gain airports never has.
   */
  private readonly spawnedAirfields: SpawnedAirfieldManager | null;
  private originShifted = true;
  private cameraCut = true;
  private frameIndex = 0;
  private renderScale: number;
  /**
   * B1: the `renderScale` the engine's level was last resolved from, which
   * diagnostics report. A governor step that moves the level waits for the
   * next frame's start, and until then a snapshot's scale still pairs with
   * the pixels it rendered. Every application sets it; 1 is a placeholder.
   */
  private appliedRenderScale = 1;
  private terrainAuthorityPublisher: TerrainAuthorityPublisher | null = null;
  private readonly atmosphereResources: AtmosphereGpuResources;
  /** The near-ground scenery's off-frame pipeline compiles; null when Babylon's surface moved. */
  private readonly pipelineCompiles: AsyncPipelineCompiles | null;
  private readonly passTimingHistory = new PassTimingHistory();
  private governorConfig: GovernorConfig;
  private governorState: GovernorState;
  private pinnedRenderScale: number | null;
  /** Perf capture only; null for every player. See `FlightRendererOptions`. */
  private readonly cockpitRigOverride: CockpitRigOverride | null;
  private workLeverSettings: WorkLeverSettings = workLeverSettingsFor(0, 0);
  private governedProfileCache: WebGpuQualityProfile;
  private lastSignals: GovernorSignals = { gpuP95Ms: null, cpuP95Ms: null, intervalP95Ms: null };
  private budgetProbe: FrameGraphBudgetProbe | null = null;
  private budgetProbeReport: RenderDiagnostics["budgetProbeReport"] = null;
  private probeDisabledPass: string | null = null;
  private previousFrameStartedAt: number | null = null;
  private lastFrameIntervalMilliseconds = 0;
  private lastCpuFrameMilliseconds = 0;
  private lastPresentWaitMilliseconds: number | null = null;
  private lastDrawCalls = 0;
  private lastGpuCounterSampleCount = 0;
  private lastGpuFrameMilliseconds: number | null = null;
  private lastGpuTimingFrameIndex = Number.NEGATIVE_INFINITY;
  /** Monotonic label for metrics cleared together by resetTimingWindow(). */
  private timingWindowEpoch = 0;
  private deviceLost = false;
  private disposed = false;

  private constructor(
    options: FlightRendererOptions,
    engine: WebGPUEngine,
    gpuUncapturedErrorGuard: GpuUncapturedErrorGuard,
    scene: Scene,
    camera: UniversalCamera,
    aircraft: AircraftVisual,
    surfaceVehicle: VehicleVisual | null,
    boatEffects: BoatEffects | null,
    carEffects: CarEffects | null,
    underwater: UnderwaterView | null,
    terrain: TerrainClipmapSystem,
    terrainEvolution: TerrainEvolutionRuntime,
    terrainConsumerAuthority: TerrainConsumerAuthority | null,
    atmosphere: AtmosphereSystem,
    clouds: VolumetricCloudSystem,
    cloudShadowReceivers: CloudShadowReceiverRegistry,
    aerialReceivers: AerialPerspectiveRegistry,
    skyProbe: SkyEnvironmentProbe,
    ocean: SpectralOceanSystem,
    waterEnvironment: WaterEnvironmentField,
    hydrology: HydrologySystem,
    bathymetry: BathymetryClipmap,
    airport: AirportSystem | null,
    detail: WorldDetailRuntime,
    groundCover: GroundCoverSystem,
    roads: RoadStreamRuntime | null,
    roadSurface: RoadSurfaceSystem | null,
    wildlife: WildlifeSystem,
    toneMap: ImageProcessingPostProcess,
    fxaa: FxaaSharpenPass,
    stars: StarFieldSystem,
    lightPoints: LightPointSystem,
    steam: VolcanicSteamSystem,
    marina: MarinaSystem,
    marinaLampStart: number,
    clusteredLighting: ClusteredLightingSystem,
    hangarFloodNames: readonly string[],
    airfieldLighting: AirfieldLightingSystem | null,
    airportGround: LiveAirportGround<TerrainSample>,
    airportHeight: LiveAirportGround<number>,
    spawnedAirfields: SpawnedAirfieldManager | null,
    scotopic: ScotopicVisionPass,
    bloom: BloomPass,
    sharpen: SharpenPass,
    atmosphereResources: AtmosphereGpuResources,
    pipelineCompiles: AsyncPipelineCompiles | null,
    adapterLabel: string,
  ) {
    this.atmosphereResources = atmosphereResources;
    this.pipelineCompiles = pipelineCompiles;
    this.domElement = options.canvas;
    this.engine = engine;
    this.gpuUncapturedErrorGuard = gpuUncapturedErrorGuard;
    this.scene = scene;
    this.camera = camera;
    this.aircraft = aircraft;
    this.surfaceVehicle = surfaceVehicle;
    this.surfaceVehicleSpec = surfaceVehicle && isSurfaceVehicleKind(surfaceVehicle.kind)
      ? surfaceVehicleSpec(surfaceVehicle.kind)
      : null;
    this.surfaceVehicleWashes = surfaceVehicle && isSurfaceVehicleKind(surfaceVehicle.kind)
      ? surfaceVehicleWashLights(surfaceVehicle.kind)
      : [];
    this.boatSpray = boatEffects?.spray ?? null;
    this.boatWake = boatEffects?.wake ?? null;
    this.boatHullClip = boatEffects?.hullClip ?? null;
    this.boatHeave = boatEffects?.heave ?? null;
    this.carParticles = carEffects?.particles ?? null;
    this.carTracks = carEffects?.tracks ?? null;
    this.carBowWave = carEffects?.bowWave ?? null;
    this.underwater = underwater;
    this.terrain = terrain;
    this.terrainEvolution = terrainEvolution;
    this.terrainConsumerAuthority = terrainConsumerAuthority;
    this.atmosphere = atmosphere;
    this.clouds = clouds;
    this.cloudShadowReceivers = cloudShadowReceivers;
    this.aerialReceivers = aerialReceivers;
    this.skyProbe = skyProbe;
    this.ocean = ocean;
    this.waterEnvironment = waterEnvironment;
    this.hydrology = hydrology;
    // The drawn lakes and rivers for the camera's water, before any worker's.
    if (underwater) hydrology.setWaterPublisher(underwater.hydrologyPublisher(null));
    this.bathymetry = bathymetry;
    this.dynamicAllocations = bathymetry.storageFormat === "r16float"
      ? DYNAMIC_ALLOCATIONS
      : Object.freeze({
        ...DYNAMIC_ALLOCATIONS,
        bathymetryClipmapBytesPerTexel: bathymetryStorageBytesPerTexel(bathymetry.storageFormat),
      });
    this.airport = airport;
    this.detail = detail;
    this.groundCover = groundCover;
    this.roads = roads;
    this.roadSurface = roadSurface;
    // Every change to the streamed roads, in the order that keeps each copy
    // of the ground true (`RoadStreamRuntime`): the workers first, on the
    // ports their ground arrives on, then the CPU and GPU consumers here.
    roads?.setConsumers({
      publishInfrastructure: (update) => this.terrainAuthorityPublisher?.publishInfrastructure?.(update),
      detailInfrastructureChanged: (update, change) => {
        this.detail.infrastructureChanged(update, change);
      },
      groundCoverInfrastructureChanged: (change) => {
        this.groundCover.invalidateWhere((minX, minZ, maxX, maxZ) =>
          infrastructureChangeTouches(change, { minX, minZ, maxX, maxZ }));
      },
      infrastructureChanged: (change) => this.terrain.infrastructureChanged(change),
      roadSurfaceChanged: (install, remove) => this.roadSurface?.apply(install, remove),
    });
    this.wildlife = wildlife;
    this.toneMap = toneMap;
    this.fxaa = fxaa;
    this.stars = stars;
    this.lightPoints = lightPoints;
    this.steam = steam;
    this.marina = marina;
    this.marinaLampStart = marinaLampStart;
    this.clusteredLighting = clusteredLighting;
    this.hangarFloodNames = hangarFloodNames;
    this.airfieldLighting = airfieldLighting;
    this.airportGround = airportGround;
    this.airportHeight = airportHeight;
    this.spawnedAirfields = spawnedAirfields;
    this.scotopic = scotopic;
    this.bloom = bloom;
    this.sharpen = sharpen;
    this.adapterLabel = adapterLabel;
    this.seaLevel = options.world.seaLevel;
    this.aircraftKind = options.aircraft;
    this.latitudeDegrees = options.world.latitudeDegrees;
    this.cameraTerrainHeight = airportHeight.sample;
    this.worldDefinition = options.world;
    this.liveWorld = options.world;
    this.quality = options.quality;
    this.renderingMode = options.renderingMode;
    this.reducedMotion = options.reducedMotion;
    this.profile = resolveWebGpuQualityProfile(this.quality, this.renderingMode);
    this.pinnedRenderScale = options.pinnedRenderScale ?? null;
    this.skyRebakeSynchronous = options.skyRebake === "sync";
    this.cockpitRigOverride = options.cockpitRigOverride ?? null;
    this.governorConfig = this.resolveGovernorConfig();
    this.governorState = createGovernorState(this.governorConfig);
    this.governedProfileCache = this.profile;
    this.renderScale = this.governorState.renderScale;
    this.renderScaleQueue = new RenderScaleQueue(
      this.engine,
      () => this.resolveRenderScaleLevel(),
    );
    this.applyRenderScale();
    this.installFrameGraph();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      // Re-derive the capped scale: the pixel budget depends on the CSS size.
      // B1: in flight that waits for the next frame's start, because this
      // fires after rAF has drawn and a resize now would discard the frame.
      // Pinned renderers (perf capture, VITE_PERF_RESIZE_WOBBLE) keep the
      // immediate path.
      if (this.pinnedRenderScale === null) {
        this.renderScaleQueue.defer(DISPLAY_RESIZE_REQUEST);
        return;
      }
      this.applyRenderScale();
      this.resetTimingWindow();
      this.graph.invalidateHistory("display resize");
    });
    this.resizeObserver.observe(this.domElement);
    // 4-3: RENDERING_PLAN.md mandates a false-colour overlay before the items
    // that consume it. Backquote is unused by the flight input map.
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.handleDebugKey);
    }
    this.engine.onContextLostObservable.add(() => {
      if (this.disposed || this.deviceLost) return;
      this.deviceLost = true;
      options.onDeviceLost?.("The WebGPU device was lost. The renderer must be recreated.");
    });
    // Ecology is a terrain-authority consumer in its own right. Do not make
    // its final-page feed depend on the simulation publisher being attached.
    if (this.terrainConsumerAuthority) {
      this.terrain.setCollisionPagePublisher(
        (page) => this.publishTerrainConsumerPage(page),
      );
      this.terrain.setAuxPagePublisher(
        (page) => this.publishTerrainConsumerAuxPage(page),
      );
    }
    this.domElement.dataset.rendererMode = "webgpu";
    this.domElement.dataset.renderTechnique = "forward-spectral-volumetric";
    // Which bathymetry storage path the device took, readable from the DOM so
    // a browser without tier1 (Firefox) can be told apart from the reference.
    this.domElement.dataset.bathymetryStorageFormat = bathymetry.storageFormat;
  }

  private readonly handleDebugKey = (event: KeyboardEvent): void => {
    if (this.disposed || event.code !== "Backquote" || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    this.terrain.cycleDebugOverlay();
  };

  static async create(options: FlightRendererOptions): Promise<FlightRenderer> {
    const capability = await awaitRendererStartup(
      inspectWebGpuCapabilities(),
      options.signal,
      "WebGPU capability discovery",
      15_000,
    );
    checkpointRendererStartup("WebGPU capability discovery", "async");
    if (!capability.supported) throw new Error(capability.reason ?? "WebGPU is unavailable.");
    throwIfRendererStartupAborted(options.signal);
    // Opting out at device creation is load-bearing. Babylon records the next
    // frame's timestamp into a command encoder as `endFrame()` returns, so
    // disabling its timer later destroys a query set still referenced by that
    // unsent encoder. A controlled no-observer capture must never create it.
    const timestampQuerySupported = capability.features.has("timestamp-query");
    const gpuTimingEnabled = gpuTimingEnabledAtStartup({
      timestampQuerySupported,
      captureGpuTiming: options.captureGpuTiming,
      pinnedCapture: options.pinnedRenderScale !== undefined,
    });
    // The bathymetry clipmap's designed r16float storage target needs the
    // OPTIONAL `texture-formats-tier1` feature. Chrome's adapter exposes it;
    // Firefox 155's does not, and this used to be a hard refusal ("This GPU
    // does not expose texture-formats-tier1"). The format is chosen from the
    // ADAPTER's features here, the feature is requested only when that
    // choice needs it, and a core-only device gets the rgba16float fallback
    // (see `BathymetryStorageFormat`).
    const bathymetryStorageFormat = selectBathymetryStorageFormat(capability.features);
    const bathymetryStorageFeature =
      BATHYMETRY_STORAGE_FORMATS[bathymetryStorageFormat].requiredFeature;
    const requiredFeatures: GPUFeatureName[] = [
      ...(bathymetryStorageFeature ? [bathymetryStorageFeature as GPUFeatureName] : []),
      ...(gpuTimingEnabled ? ["timestamp-query" as const] : []),
    ];
    const engine = await awaitRendererStartup(
      WebGPUEngine.CreateAsync(options.canvas, {
        // 1B-11: the hand-built post chain forces an offscreen target, so
        // MSAA is requested on the first post-process below; the context
        // itself stays single-sampled.
        antialias: false,
        adaptToDeviceRatio: false,
        premultipliedAlpha: false,
        powerPreference: "high-performance",
        enableAllFeatures: false,
        setMaximumLimits: false,
        enableGPUDebugMarkers: process.env.NODE_ENV !== "production",
        deviceDescriptor: { requiredFeatures },
      }),
      options.signal,
      "WebGPU engine creation",
      30_000,
      (lateEngine) => lateEngine.dispose(),
    );
    checkpointRendererStartup("WebGPU engine creation", "async");
    // Install the authoritative raw-device channel before constructing any
    // scene resource or compiling any pipeline. Babylon only logs these
    // asynchronous failures; without this guard a rejected whole-frame submit
    // can leave the canvas black while the rAF/FPS counter stays healthy.
    const gpuUncapturedErrorGuard = new GpuUncapturedErrorGuard(
      engine._device,
      (failure) => options.onGpuUncapturedError?.(
        formatGpuUncapturedError(failure),
      ),
    );
    const cleanup: Array<() => void> = [
      () => engine.dispose(),
      () => gpuUncapturedErrorGuard.dispose(),
    ];
    try {
      throwIfRendererStartupAborted(options.signal);
      engine.compatibilityMode = false;
      engine.useReverseDepthBuffer = true;
      engine.enableGPUTimingMeasurements = gpuTimingEnabled;
      // Babylon's own per-pass read reports the slot's previous occupant
      // (DeferredPassTiming.ts). A diagnostic capture that times passes must
      // read each pass's own time, or it measures nothing it can name.
      if (engine.enableGPUTimingMeasurements && !installDeferredPassTiming(engine)) {
        throw new Error("GPU timing is on but per-pass timing could not be installed on this engine");
      }
      assertStartupInvariants({
        timestampQuerySupported,
        gpuTimingEnabled: engine.enableGPUTimingMeasurements,
        gpuTimingRequired: gpuTimingEnabled,
        requestedFeatures: requiredFeatures,
        grantedFeatures: engine.enabledExtensions,
        // 4-0: assert the limits the renderer DECLARES, not the ones it hopes
        // for. `setMaximumLimits: false` above means the device runs at spec
        // defaults regardless of how generous the adapter is.
        reportedLimits: capability.limits,
      });
      const scene = new Scene(engine);
      cleanup.push(() => scene.dispose());
      // The pitch-down freeze: the near-ground scenery (detail and blades,
      // registered below) compiles its render pipelines off the frame instead
      // of in the frame it first comes into view. Null when the Babylon
      // surface it hooks has moved, which leaves Babylon's synchronous path.
      const pipelineCompiles = AsyncPipelineCompiles.install(scene);
      if (pipelineCompiles) cleanup.push(() => pipelineCompiles.dispose());
      scene.useRightHandedSystem = true;
      scene.clearColor = new Color4(0.09, 0.19, 0.34, 1);
      scene.performancePriority = ScenePerformancePriority.Intermediate;
      const camera = new UniversalCamera("flight-camera", new Vector3(0, 8, -18), scene);
      camera.minZ = 0.08;
      // 1C-4: beyond 45 km the shared aerial perspective leaves under 5%
      // luminance transmittance in clear weather — geometry past it is paint
      // the haze already covered. 120 km existed to feed fog that no longer
      // exists.
      camera.maxZ = CAMERA_FAR_PLANE_METERS;
      // 1B-11: the old 64° VERTICAL fov was ≈96° horizontal at 16:9 — a
      // wide-angle lens that shrank every mountain. Horizontal-fixed ~62°
      // is a natural perspective, and tightens the shadow cascades free.
      camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
      camera.fov = 62 * Math.PI / 180;
      camera.inertia = 0;
      camera.inputs.clear();
      scene.activeCamera = camera;

      const profile = resolveWebGpuQualityProfile(options.quality, options.renderingMode);
      // W-1a hybrid macro erosion: the engine is already initialized here, so
      // the eroded path may run its one-shot stream-power/talus GPU leg
      // between the worker's two CPU stages. Analytic worlds construct no
      // producer and take the byte-identical single-shot path.
      const gpuMacroErosion = options.world.worldEvolution === "eroded"
        ? new TerrainMacroErosionGpu(engine)
        : null;
      if (gpuMacroErosion) cleanup.push(() => gpuMacroErosion.dispose());
      // W-1b: the macro INPUT sampling also runs on this device. The trade is
      // measured, not assumed — moving sampling here serialises it behind the
      // synchronous construction below instead of overlapping it in the
      // worker, so it only wins while that construction is shorter than the
      // ~1.03 s of worker sampling it would otherwise hide. Instrumented on
      // the reference host (2026-08-30): the construction below is 13.9 ms,
      // 74x under the crossover — the "eager start" overlaps essentially
      // nothing and the worker's ~1,011 ms CPU sampling was serial latency in
      // all but name. On device that sampling costs ~29 ms and leaves the
      // worker only its ~344 ms flood/MFD head, turning a ~1,355 ms stage 1
      // into ~373 ms. Sampling fails open to the worker's CPU pass.
      const gpuMacroInputs = options.world.worldEvolution === "eroded"
        ? new TerrainMacroInputsGpu(engine)
        : null;
      if (gpuMacroInputs) cleanup.push(() => gpuMacroInputs.dispose());
      const terrainEvolution = new TerrainEvolutionRuntime(
        gpuMacroErosion
          ? { gpuMacroErosion, ...(gpuMacroInputs ? { gpuMacroInputs } : {}) }
          : {},
      );
      cleanup.push(() => terrainEvolution.dispose());
      // Start the eager macro pass as early as possible. It runs in its own
      // worker while the main thread constructs the first device resources,
      // but eroded pages, water and graph hydrology do not become visible
      // until this one canonical result is ready.
      const terrainEvolutionPromise = terrainEvolution.initialize(options.world);
      const atmosphere = new AtmosphereSystem(
        scene,
        camera,
        profile,
        options.world.prevailingWindRadians,
      );
      cleanup.push(() => atmosphere.dispose());
      const terrain = new TerrainClipmapSystem(scene, options.world, profile, {
        // A car's ground: the observer is the car, and Low draws L0 round it.
        vehicleNearField: options.vehicle !== undefined
          && isSurfaceVehicleKind(options.vehicle)
          && vehicleClass(options.vehicle) === "car",
      });
      cleanup.push(() => terrain.dispose());
      if (options.terrainFarSwardRead) terrain.setFarSwardRead(options.terrainFarSwardRead);
      // The streamed roads: their worker starts on the regions round the
      // session's start now, beside the rest of startup, and the first bake
      // waits for them (`roadsPrimed`, before the terrain pre-warm), so the
      // first pages are built with their roads rather than rebuilt under the
      // car. An eroded world has no stage.
      const roads = options.world.worldEvolution === "eroded" ? null : new RoadStreamRuntime(options.world);
      if (roads) cleanup.push(() => roads.dispose());
      const roadsPrimed = roads?.prime(
        options.startPoint?.x ?? options.world.airport?.centerX ?? 0,
        options.startPoint?.z ?? options.world.airport?.centerZ ?? 0,
      ) ?? Promise.resolve();
      checkpointRendererStartup("core scene and terrain construction", "sync");
      const evolutionResult = await awaitRendererStartup(
        terrainEvolutionPromise,
        options.signal,
        "terrain macro evolution",
        TERRAIN_EVOLUTION_STARTUP_TIMEOUT_MILLISECONDS,
      );
      checkpointRendererStartup("terrain macro evolution wait", "async");
      // The macro pass ran once; return its ~36 MiB of 1024² erosion scratch
      // and ~12 MiB of sampling scratch before page atlases allocate (dispose
      // is idempotent under cleanup).
      gpuMacroErosion?.dispose();
      gpuMacroInputs?.dispose();
      terrain.setMacroEvolution(evolutionResult.evolution);
      let terrainConsumerAuthority: TerrainConsumerAuthority | null = null;
      let consumerTerrainSample = options.terrainSample;
      // The same surface's height alone, for the consumers that read nothing
      // else. Without the game's height function it is the full sample's.
      const analyticTerrainHeight = options.terrainHeight
        ?? ((x: number, z: number) => options.terrainSample(x, z).height);
      let consumerTerrainHeight = analyticTerrainHeight;
      if (evolutionResult.mode === "eroded") {
        terrainConsumerAuthority = new TerrainConsumerAuthority();
        // This view is retained on the main thread. Simulation and detail
        // receive separate copies because both worker posts detach them.
        terrainConsumerAuthority.publishMacro(
          terrainMacroGridFromEvolution(evolutionResult.evolution, false),
        );
        consumerTerrainSample = terrainConsumerSampleFromAuthority(
          options.world,
          options.terrainSample,
          terrainConsumerAuthority,
        );
        consumerTerrainHeight = terrainConsumerHeightFromAuthority(
          options.world,
          analyticTerrainHeight,
          terrainConsumerAuthority,
        );
      }
      // Airports spawned in flight: every CPU consumer below reads ONE stable
      // sampler whose answer follows `setAirports`. Until an airport spawns it
      // delegates straight to `consumerTerrainSample`, so the home-only world
      // samples exactly what it did.
      const airportGround = new LiveAirportGround<TerrainSample>(
        consumerTerrainSample,
        analyticTerrainOf,
      );
      airportGround.setWorld(options.world);
      const liveTerrainSample = airportGround.sample;
      // Its height alone, `liveTerrainSample(x, z).height` bit for bit
      // (tests/render.live-terrain-height.test.ts), for the camera clamp, the
      // spawned airfields, the ground-cover tile and the birds.
      const airportHeight = new LiveAirportGround<number>(
        consumerTerrainHeight,
        analyticTerrainHeightOf,
      );
      airportHeight.setWorld(options.world);
      const liveTerrainHeight = airportHeight.sample;
      // W-6 (C-6): eroded bathymetry overlays resident L0 eroded pages inside
      // its own update dispatch (ARCHITECTURE 5-10 row — water consumers may
      // not implement this independently). The seam is read-only, resolved
      // through callbacks because setQuality can rebuild the height atlas,
      // and wired only in eroded mode so analytic worlds keep the inert
      // empty-table sentinel.
      const bathymetry = new BathymetryClipmap(
        scene,
        options.world,
        evolutionResult.mode === "eroded"
          ? bathymetryErodedPageOverlaySeamFromAtlas(() => terrain.atlases.height)
          : null,
        { storageFormat: bathymetryStorageFormat, landformData: terrain.landformData },
      );
      cleanup.push(() => bathymetry.dispose());
      bathymetry.setMacroEvolution(evolutionResult.evolution);
      checkpointRendererStartup("terrain authority and bathymetry construction", "sync");
      await awaitRendererStartup(
        bathymetry.initialize(
          options.world.airport?.centerX ?? 0,
          options.world.airport?.centerZ ?? 0,
          options.signal,
        ),
        options.signal,
        "bathymetry clipmap",
        SCENE_STARTUP_TIMEOUT_MILLISECONDS,
      );
      checkpointRendererStartup("bathymetry clipmap startup", "async");
      const aircraft = createWebGpuAircraft(scene, options.aircraft);
      cleanup.push(() => aircraft.dispose());
      for (const mesh of aircraft.meshes) {
        if (mesh.metadata?.castsShadow === false) continue;
        atmosphere.shadows.addShadowCaster(mesh, false);
      }
      const surfaceVehicle = options.vehicle && isSurfaceVehicleKind(options.vehicle)
        ? createSurfaceVehicleVisual(scene, options.vehicle)
        : null;
      if (surfaceVehicle) {
        cleanup.push(() => surfaceVehicle.dispose());
        // Built hidden: the menu's attract flight is an aircraft, and the boat
        // appears only once the state carries its payload.
        surfaceVehicle.root.setEnabled(false);
        for (const mesh of surfaceVehicle.meshes) {
          if (mesh.metadata?.castsShadow === false) continue;
          atmosphere.shadows.addShadowCaster(mesh, false);
        }
      }
      // The walker lives in car sessions only (the walking plan, D3): built
      // hidden, it appears once the state carries a walking session.
      const person = surfaceVehicle && vehicleClass(surfaceVehicle.kind) === "car"
        ? createPersonVisual(scene, { profile, pipelineCompiles })
        : null;
      if (person) {
        cleanup.push(() => person.dispose());
        person.root.setEnabled(false);
        for (const mesh of person.meshes) {
          if (mesh.metadata?.castsShadow === false) continue;
          atmosphere.shadows.addShadowCaster(mesh, false);
        }
      }
      checkpointRendererStartup("aircraft construction", "sync");
      const airportDefinition = options.runway ?? options.world.airport;
      // The access road leaves the home field through its fence.
      const fenceOpening = roads && airportDefinition === options.world.airport
        ? airportRoadFenceOpening(options.world)
        : null;
      // 3-9: the hangars are the only airport meshes left, and the apron they
      // stood on is gone — they read the ground the earthworks made.
      const airport = airportDefinition
        ? new AirportSystem(
          scene,
          airportDefinition,
          (x, z) => options.terrainSample(x, z).height,
          options.world.seedHash,
          fenceOpening ? [fenceOpening] : [],
        )
        : null;
      if (airport) cleanup.push(() => airport.dispose());
      if (airport) {
        airport.setFloatingOrigin(0, 0);
        for (const mesh of airport.shadowCasters) atmosphere.addShadowCaster(mesh, false);
      }
      checkpointRendererStartup("airport construction", "sync");
      // The home marina: world content in every session, so aircraft see it
      // and the boat starts in it. Built here, enabled, so its effects compile
      // inside the readiness gate below with everything else.
      const marina = new MarinaSystem(scene, homeMarina(options.world), {
        castsShadows: profile.marinaCastsShadows,
      });
      cleanup.push(() => marina.dispose());
      checkpointRendererStartup("marina construction", "sync");
      // The roads' ribbons and rails: two meshes, enabled once something is
      // in reach and the terrain's lookup and material arrays exist. Their
      // pipelines compile off the frame, warmed as the first roads install:
      // a ribbon a frame late shows the splat's paint under it.
      const roadSurface = roads ? new RoadSurfaceSystem(scene, terrain, profile, pipelineCompiles) : null;
      if (roadSurface) {
        cleanup.push(() => roadSurface.dispose());
        if (pipelineCompiles) for (const material of roadSurface.materials) pipelineCompiles.defer(material);
      }
      const detail = new WorldDetailRuntime(scene, {
        worldSeed: options.world.seed,
        terrainSample: liveTerrainSample,
        seaLevelMeters: options.world.seaLevel,
        latitudeDegrees: options.world.latitudeDegrees,
        workerWorldSeed: options.world.seed,
        workerWorld: options.world,
        pipelineWarmUp: pipelineCompiles,
      });
      cleanup.push(() => detail.dispose());
      checkpointRendererStartup("detail runtime construction", "sync");
      // Wave G: the blade system reads the SAME consumer sampler as detail
      // and the camera clamp, so blades stand on the rendered surface.
      const groundCover = new GroundCoverSystem(scene, {
        terrainSample: liveTerrainSample,
        // The tile's height rows and the altitude gate read only the height,
        // and with a height-only sampler the tile bakes in 32 m steps under
        // its frame budget. Without one (the perf harness) a column would cost
        // a full sample, which the step's pace floor is not sized for, so the
        // tile keeps its whole-row bake, as before.
        ...(options.terrainHeight ? { terrainHeight: liveTerrainHeight } : {}),
        // `6-9` debt 1: the per-frame field is admitted through the SAME
        // amortised-compute meter as every other GPU compute producer, which
        // is what `owners.ts` has claimed since `4-0b` and wave G left false.
        computeBudget: terrain.computeBudgetMeter,
        // The detail scatter hashes `String(world.seed)`, which is exactly
        // `sourceSeedHash` — the field and the cards must key the SAME
        // realisation or the handoff at the field radius swaps species.
        seedHash: options.world.sourceSeedHash,
        seaLevelMeters: options.world.seaLevel,
        // Built ground (infrastructure segments with a plant clearance): no
        // blades, the detail scatter's own gate, from the stage as it is when
        // each row slice bakes. None in a world without it.
        plantExclusionsIn: (minX, minZ, maxX, maxZ) => infrastructurePlantExclusionsIn(
          infrastructureIndex(options.world),
          minX,
          minZ,
          maxX,
          maxZ,
        ),
        pipelineWarmUp: pipelineCompiles,
      });
      cleanup.push(() => groundCover.dispose());
      checkpointRendererStartup("ground-cover construction", "sync");
      // Their draws may wait for a pipeline: a stump or a tuft of grass a
      // frame late is invisible, a frame stopped for its compile is not.
      if (pipelineCompiles) {
        detail.addPbrMaterials((material) => pipelineCompiles.defer(material));
        groundCover.addPbrMaterials((material) => pipelineCompiles.defer(material));
      }
      if (evolutionResult.mode === "eroded") {
        detail.publishTerrainMacro(
          terrainMacroGridFromEvolution(evolutionResult.evolution),
        );
      }
      const wildlife = new WildlifeSystem(scene, {
        worldSeed: options.world.seed,
        terrainSample: liveTerrainSample,
        terrainHeight: liveTerrainHeight,
        // A cell crossing generates only the cells it brings into range. The
        // cells read `liveTerrainSample`, so every change to it forgets them
        // (`setAirports`, `publishTerrainConsumerPage`/`AuxPage`).
        wildlifeCellCacheCapacity: 64,
      });
      cleanup.push(() => wildlife.dispose());
      checkpointRendererStartup("wildlife construction", "sync");
      // W-1e: the channel graph is awaited HERE — immediately before its only
      // consumer — rather than inside the evolution runtime's initialize. The
      // staged producer extracts it in its worker, so everything constructed
      // since the macro export landed (bathymetry, aircraft, airport, detail,
      // ground cover, wildlife) overlapped ~250 ms of extraction that used to
      // block this thread. Renderer-ready semantics are unchanged: hydrology
      // is still fully built before startup resolves.
      const channelGraph = evolutionResult.mode === "eroded"
        ? await awaitRendererStartup(
          evolutionResult.channelGraph,
          options.signal,
          "terrain channel graph",
          TERRAIN_EVOLUTION_STARTUP_TIMEOUT_MILLISECONDS,
        )
        : null;
      if (evolutionResult.mode === "eroded") {
        checkpointRendererStartup("terrain channel graph wait", "async");
      }
      const hydrology = await HydrologySystem.create(
        scene,
        camera,
        {
          worldSeed: options.world.seed,
          terrainSample: options.terrainSample,
          workerWorldSeed: options.world.seed,
          workerClimateProvince: options.world.climateProvince ?? null,
          workerLandforms: options.world.landforms ?? null,
          seaLevel: options.world.seaLevel,
          centerX: airportDefinition?.centerX ?? 0,
          centerZ: airportDefinition?.centerZ ?? 0,
          atmosphere: atmosphere.snapshot,
          bathymetry,
          windDirectionRadians: options.world.prevailingWindRadians,
          // wave R fix 8: the world definition owns the wind for BOTH water
          // surfaces. Inland water took its direction from here and its speed
          // from the atmosphere's cloud-layer wind, which can disagree 3x.
          windSpeedMetersPerSecond: options.world.prevailingWindSpeed,
          // W-8: the climate at an inland water surface, which is what its
          // chemistry is made of. A pure function of world position and
          // elevation, so two pages sharing a river derive the same colour.
          // (Shared with the hydrology worker, which builds the same arrays.)
          climateSample: hydrologyClimateSamplerFor(options.world),
          // Crater lakes and porous ground, for regions the main thread
          // generates (fallback only; the worker derives its own).
          worldInputs: (config) => volcanicHydrologyInputs(options.world, config),
          ...(channelGraph
            ? { graphHydrology: channelGraphToHydrologyGeometry(channelGraph) }
            : {}),
        },
        options.signal,
      );
      checkpointRendererStartup("hydrology startup", "async");
      cleanup.push(() => hydrology.dispose());
      hydrology.setFloatingOrigin(0, 0);
      // 2-0a: the atmosphere-owned GPU resources the adopted cloud pipeline
      // binds (transmittance LUT, sky ambient LUT, blue noise, scene depth).
      const atmosphereResources = new AtmosphereGpuResources(
        scene,
        camera,
      );
      cleanup.push(() => atmosphereResources.dispose());
      const clouds = new VolumetricCloudSystem(
        scene,
        camera,
        profile,
        atmosphere.snapshot,
        atmosphereResources,
      );
      cleanup.push(() => clouds.dispose());
      checkpointRendererStartup("atmosphere and cloud construction", "sync");
      await clouds.whenReadyAsync(options.signal);
      checkpointRendererStartup("cloud pipeline startup", "async");
      // The sea's seed and wind come from the world and the weather alone,
      // the same inputs the sim's sea twin is built from, so a hull floats on
      // the waves drawn under it.
      const ocean = await SpectralOceanSystem.create(
        scene,
        camera,
        options.world.seaLevel,
        profile,
        oceanSpectrumSeed(options.world),
        atmosphere.snapshot,
        options.world.prevailingWindRadians,
        seaSpectrumWindSpeed(options.world, options.weather ?? "breezy"),
        options.signal,
        bathymetry,
      );
      checkpointRendererStartup("spectral ocean startup", "async");
      cleanup.push(() => ocean.dispose());
      // The home marina's calm basin, the one the worker's sea twin floats a
      // hull on, so the drawn waves inside are the waves the boat rides.
      ocean.setShelter([homeMarina(options.world).shelter]);
      const waterEnvironment = new WaterEnvironmentField(scene, options.world);
      cleanup.push(() => waterEnvironment.dispose());
      const cloudShadowReceivers = new CloudShadowReceiverRegistry();
      cleanup.push(() => cloudShadowReceivers.dispose());
      // Register each shared PBR material once. Detail and wildlife can render
      // thousands of thin instances without creating receiver-side state.
      cloudShadowReceivers.registerMeshes(aircraft.meshes);
      if (surfaceVehicle) cloudShadowReceivers.registerMeshes(surfaceVehicle.meshes);
      if (person) cloudShadowReceivers.registerMeshes(person.meshes);
      if (airport) cloudShadowReceivers.registerMeshes(airport.root.getChildMeshes(false));
      cloudShadowReceivers.registerMeshes(marina.meshes);
      if (roadSurface) cloudShadowReceivers.registerMeshes(roadSurface.meshes);
      detail.addPbrMaterials((material) => {
        cloudShadowReceivers.registerMaterial(material);
      });
      groundCover.addPbrMaterials((material) => {
        cloudShadowReceivers.registerMaterial(material);
      });
      wildlife.addPbrMaterials((material) => {
        cloudShadowReceivers.registerMaterial(material);
      });
      // 1C-4: one haze registry over the small fixed PBR material set. The
      // terrain material receives the same plugin through the same door.
      const aerialReceivers = new AerialPerspectiveRegistry();
      cleanup.push(() => aerialReceivers.dispose());
      aerialReceivers.registerMaterial(terrain.pbrMaterial);
      aerialReceivers.registerMeshes(aircraft.meshes);
      if (surfaceVehicle) aerialReceivers.registerMeshes(surfaceVehicle.meshes);
      if (person) aerialReceivers.registerMeshes(person.meshes);
      if (airport) aerialReceivers.registerMeshes(airport.root.getChildMeshes(false));
      aerialReceivers.registerMeshes(marina.meshes);
      if (roadSurface) aerialReceivers.registerMeshes(roadSurface.meshes);
      detail.addPbrMaterials((material) => {
        aerialReceivers.registerMaterial(material);
      });
      groundCover.addPbrMaterials((material) => {
        aerialReceivers.registerMaterial(material);
      });
      wildlife.addPbrMaterials((material) => {
        aerialReceivers.registerMaterial(material);
      });
      const initialSnapshot = atmosphere.snapshot;
      aerialReceivers.setProjection({
        state: DEFAULT_ENVIRONMENT_STATE,
        cameraAltitudeMeters: camera.position.y,
        sunColor: [
          initialSnapshot.sunColor.r,
          initialSnapshot.sunColor.g,
          initialSnapshot.sunColor.b,
        ],
        skyHorizonColor: [
          initialSnapshot.skyHorizon.r,
          initialSnapshot.skyHorizon.g,
          initialSnapshot.skyHorizon.b,
        ],
        sunIlluminanceNormalized: initialSnapshot.sunIlluminanceNormalized,
        moonDirection: [
          initialSnapshot.moonDirection.x,
          initialSnapshot.moonDirection.y,
          initialSnapshot.moonDirection.z,
        ],
        moonIlluminanceNormalizedToFull:
          initialSnapshot.moonIlluminanceLux / FULL_MOON_ILLUMINANCE_LUX,
      }, 0, 0);
      const initialAerialBinding = aerialReceivers.currentBinding;
      if (initialAerialBinding) {
        atmosphere.setAerialPerspective(initialAerialBinding);
        ocean.setAerialPerspective(initialAerialBinding);
        hydrology.setAerialPerspective(initialAerialBinding);
        clouds.setAerialPerspective(initialAerialBinding);
      }
      // 1C-6: image-based lighting from the one sky. Assigned BEFORE
      // whenReadyAsync so every PBR material compiles its REFLECTION variant
      // during startup instead of stalling the first frame.
      const skyProbe = new SkyEnvironmentProbe(scene, atmosphere.skyMesh);
      cleanup.push(() => skyProbe.dispose());
      if (initialAerialBinding) {
        skyProbe.update(initialAerialBinding, atmosphere.surfaceAlbedoLuminance);
      }
      scene.environmentTexture = skyProbe.texture;
      // 2-9: the same probe feeds the water materials' environment
      // reflections (they are raw ShaderMaterials — scene.environmentTexture
      // only reaches PBR). The RTT object is stable across probe re-renders,
      // so one binding suffices.
      ocean.setEnvironmentReflection(skyProbe.texture);
      hydrology.setEnvironmentReflection(skyProbe.texture);
      const initialCloudShadow = clouds.cloudShadow;
      terrain.setCloudShadow(initialCloudShadow);
      ocean.setCloudShadow(initialCloudShadow);
      hydrology.setCloudShadow(initialCloudShadow);
      ocean.setSunShadows(atmosphere.shadows);
      hydrology.setSunShadows(atmosphere.shadows);
      // Terrain occlusion of the reflected sky: the ground bounce's albedo,
      // forwarded again with every atmosphere change (see setAtmosphere).
      hydrology.setGroundBounceAlbedo(atmosphere.surfaceAlbedoLuminance);
      ocean.setGroundBounceAlbedo(atmosphere.surfaceAlbedoLuminance);
      cloudShadowReceivers.setProjection(initialCloudShadow, 0, 0);

      // 7-3: the star field. Built before the post-process chain so its
      // shader is compiled inside the whenReadyAsync gate with everything
      // else, and drawn additively at the sky's own depth.
      const stars = new StarFieldSystem(scene, 1);
      cleanup.push(() => stars.dispose());

      // `7-5`: empty until `7-7` authors the fixtures. See the field docblock.
      // 7-5 + 7-7 joined. `airportDefinition` is resolved far above (line ~857),
      // so the fixtures exist by the time the billboard system is built —
      // which matters, because `LightPointSystem` takes its fixtures in the
      // constructor and the vertex buffer is built once.
      // `7-14`'s obstruction lights go THROUGH `AirfieldLightingSystem` rather
      // than being concatenated into the `LightPointSystem` constructor below.
      // That is not a style choice: `setColors` demands one colour per fixture
      // against a `fixtureCount` frozen at construction, and the only colour
      // source in the tree is `colourList()`. Adding fixtures here and colours
      // nowhere throws inside the frame graph on the first PAPI transition.
      //
      // They need the structures, so they are empty whenever `airport` is null
      // — it owns the attachment points and folds each structure's placement
      // into them, so nothing here applies a placement of its own.
      const obstructionFixtures = airportDefinition && airport
        ? [
          ...towerObstructionFixtures(airportDefinition, airport.towerAttachments),
          ...airport.hangarAttachments.flatMap((mounts) =>
            hangarObstructionFixtures(airportDefinition, mounts)),
        ]
        : [];
      const airfieldLighting = airportDefinition
        ? new AirfieldLightingSystem(airportDefinition, obstructionFixtures)
        : null;
      // The marina's lamps and beacons follow the airfield's in the same one
      // draw, so they cost none; `setColorRange` writes each block's colours.
      const marinaLampStart = airfieldLighting?.fixtures.length ?? 0;
      const lightPoints = new LightPointSystem(
        scene,
        [...(airfieldLighting?.fixtures ?? []), ...marina.lampFixtures],
        1,
      );
      lightPoints.setColorRange(marinaLampStart, marina.lampColours);
      cleanup.push(() => lightPoints.dispose());
      // Volcanic phase 5: steam over vents. Built before the whenReadyAsync
      // gate below, like the star field, so its effect compiles at load; its
      // first frame then draws one collapsed instance so the render pipeline
      // exists before the first vent comes into range. The ground under a
      // vent is the consumer surface the player sees, never below the sea.
      // A vent query waits until the terrain's site index covers it: building
      // the index is what builds the vents' site cells, in 1 ms slices.
      const steamSiteIndex = terrain.landformData;
      const steam = new VolcanicSteamSystem(scene, options.world, {
        maxWisps: profile.volcanicSteamMaxWisps,
        groundHeight: (x, z) => consumerTerrainSample(x, z).height,
        sceneDepth: atmosphereResources.sceneDepth,
        ...(steamSiteIndex
          ? { ventsReady: (minX, minZ, maxX, maxZ) => steamSiteIndex.covers(minX, minZ, maxX, maxZ) }
          : {}),
      });
      cleanup.push(() => steam.dispose());
      // Only with a boat, so an aircraft or car session builds and compiles
      // none of it. Before the readiness gate, as the steam is.
      const boatEffects = surfaceVehicle && vehicleClass(surfaceVehicle.kind) === "boat"
        ? createBoatEffects(scene, {
          profile,
          world: options.world,
          ocean,
          atmosphere: atmosphere.snapshot,
          sea: { world: options.world, weather: options.weather ?? "breezy" },
        })
        : null;
      if (boatEffects) {
        cleanup.push(() => boatEffects.spray.dispose());
        cleanup.push(() => boatEffects.wake.dispose());
      }
      // Only with a car, as the boat's are.
      const carEffects = surfaceVehicle && vehicleClass(surfaceVehicle.kind) === "car"
        ? createCarEffects(scene, {
          profile,
          world: options.world,
          atmosphere: atmosphere.snapshot,
          groundHeight: liveTerrainHeight,
          sea: { ocean, seaLevel: options.world.seaLevel },
          pipelineCompiles,
        })
        : null;
      if (carEffects) {
        cleanup.push(() => carEffects.particles.dispose());
        cleanup.push(() => carEffects.tracks.dispose());
        cleanup.push(() => carEffects.bowWave.dispose());
      }
      // Only with a car, where the walker can dive.
      const underwater = surfaceVehicle && vehicleClass(surfaceVehicle.kind) === "car"
        ? new UnderwaterView({
          world: options.world,
          weather: options.weather ?? "breezy",
          terrainHeight: liveTerrainHeight,
          drawnCascades: profile.oceanCascades,
        })
        : null;
      if (underwater) cleanup.push(() => underwater.dispose());
      // 7-4b: the clustered ILLUMINATION surface, beside the billboards that
      // are the lamps you SEE. Constructed with no definitions on purpose —
      // `ClusteredLightingSystem` then builds NO container, which costs
      // nothing, because Babylon gates `vViewDepth` on `CLUSTLIGHT_BATCH > 0`
      // rather than on whether a material has a clustered light: the moment a
      // container exists EVERY light-loop material pays one inter-stage slot,
      // and terrain and detail have exactly one each.
      //
      // It exists here so `7-8`'s landing/taxi lights and `7-14`'s obstruction
      // lights have a surface to add to, and so the tier row reaches it: the
      // tile and slice geometry must come from the profile, because changing it
      // after construction reallocates the tile-mask texture, the storage
      // buffer and the thin-instance matrix buffer.
      // `7-14`'s hangar-face floods. They go in HERE rather than being added
      // later because `ClusteredLightingSystem` builds its lights in the
      // constructor and exposes no `add` — `setPosition` and `setIntensity`
      // address existing lights by name. `7-8`'s lamps append to this same
      // array; there is exactly ONE container in the scene and
      // `render.scene-light-slots` pins that at 1.
      const hangarFloods = airportDefinition && airport
        ? airport.hangarAttachments.flatMap((mounts, index) =>
          hangarFaceFloodlights(airportDefinition, mounts, index))
        : [];
      // `7-8`: the aircraft's landing and taxi cast pools APPEND to `7-14`'s
      // array rather than constructing a second system. The container takes its
      // definitions at construction and exposes no `add`, and
      // `render.scene-light-slots.test.ts` pins `ClusteredLighting: 1` — a
      // second construction fails with a map diff. Positions are placeholders;
      // `setPosition` moves them onto the airframe every frame.
      const clusteredDefinitions = [
          ...hangarFloods,
          ...AIRCRAFT_CAST_POOLS.map((pool) => ({
            name: pool.name,
            position: [0, 0, 0] as readonly [number, number, number],
            color: pool.color,
            intensity: 0,
            rangeMeters: pool.rangeMeters,
          })),
          // `7-15`: the lamps' own spill onto the airframe. Appended HERE for
          // the same reason the pools are: the container takes its definitions
          // at construction and exposes no `add`. Separate table, separate
          // names, so "the pools light the ground" and "the lamps light the
          // aircraft" stay independently measurable.
          ...aircraftWashLights(options.aircraft).map((wash) => ({
            name: wash.name,
            position: [0, 0, 0] as readonly [number, number, number],
            color: wash.color,
            intensity: 0,
            rangeMeters: wash.rangeMeters,
          })),
      ];
      // Spawned airports' hangar floods: PARKED lights reserved now, because the
      // container cannot add one later and constructing a light in flight would
      // mark every mesh light-dirty. Sized to what the one clustered batch has
      // free (13 used -> 3 fields of 6), so the container's buffers and per-pixel
      // loop are exactly what they were; a parked light sets no tile bit and
      // costs no pixel anything. Only with a home field (no home, no spawns),
      // and only when the starting tier lights spawned floods: low reserves
      // none, so its container is exactly the home field's.
      const spawnedFloodSlots = airport && profile.spawnedAirfields.floodFields > 0
        ? spawnedFloodReserve(clusteredDefinitions.length)
        : [];
      const clusteredLighting = new ClusteredLightingSystem(
        scene,
        [...clusteredDefinitions, ...spawnedFloodSlots.flat()],
        profile.clusteredLighting,
      );
      // `IsLightSupported` refuses silently and `addLight` only warns, so a
      // refused flood would be absent with no error. This is the only place
      // that can tell.
      if (clusteredLighting.rejected.length > 0) {
        console.warn(
          `clustered lighting refused ${clusteredLighting.rejected.length} `
          + `definition(s): ${clusteredLighting.rejected.join(", ")}`,
        );
      }
      cleanup.push(() => clusteredLighting.dispose());
      // 7-4b: SHEEN MATERIALS MUST NOT BE REACHED BY THE CONTAINER. Babylon
      // 9.21.2 emits its clustered sheen call inside
      // `computeClusteredLighting{X}` -- a separate WGSL function -- while the
      // `normalW` it passes is local to `main`, so the shader fails to parse
      // and NO frames are written. ONE clustered light is enough; it is not a
      // count threshold. Excluded by the PROPERTY rather than by material name,
      // so a future sheen material cannot walk back into it.
      //
      // Placed after every system above has built its materials, because a mesh
      // takes its material AFTER construction and an earlier sweep would see no
      // sheen at all.
      clusteredLighting.excludeSheenReceivers(scene);
      // Bound here rather than in the fan-out above, which runs before this
      // system exists. The per-frame fan-out carries it from the next frame on;
      // this is the one that lands before the first.
      if (initialAerialBinding) lightPoints.setAerialPerspective(initialAerialBinding);
      // Airports spawned in flight. Constructed empty: `setAirports` queues a
      // field, `update` builds it a slice per frame on the home field's
      // materials, so nothing here or there compiles or allocates a pipeline.
      const spawnedAirfields = airport
        ? new SpawnedAirfieldManager({
          scene,
          world: options.world,
          materials: airport.materials,
          seedHash: options.world.seedHash,
          groundHeight: liveTerrainHeight,
          lamps: lightPoints,
          floods: clusteredLighting,
          floodSlots: spawnedFloodSlots.map((slot) => slot.map((light) => light.name)),
          limits: profile.spawnedAirfields,
          // Their materials are the home field's, already in both registries,
          // so this registers nothing — and says so if that ever stops being
          // true, rather than leaving a spawned hangar unhazed.
          onStructuresBuilt: (meshes) => {
            const added = cloudShadowReceivers.registerMeshes(meshes)
              + aerialReceivers.registerMeshes(meshes);
            if (added > 0) {
              console.warn(`spawned airfield registered ${added} new material(s) in flight`);
            }
          },
        })
        : null;
      if (spawnedAirfields) cleanup.push(() => spawnedAirfields.dispose());
      spawnedAirfields?.setAirports(options.world.airports);

      // 7-2: rod vision, FIRST in the chain — it must see scene-referred
      // linear radiance, because the tone map is where exposure and ACES
      // live and a perceptual model applied after them would be operating on
      // display values. Being first also makes it the owner of the offscreen
      // beauty target, so 1B-11's MSAA moves here with it.
      const scotopic = new ScotopicVisionPass(camera, engine, profile.msaaSamples);
      cleanup.push(() => scotopic.dispose(camera));

      // 7-5: bloom, constructed here so it lands BETWEEN rod vision and the
      // tone map -- Babylon orders a camera's chain by attachment order, and
      // attachment happens in the PostProcess constructor. Built at every tier
      // and detached where it is not funded; see `BloomPass.setEnabled`.
      const bloom = new BloomPass(camera, engine, 1);
      cleanup.push(() => bloom.dispose(camera));
      if (!profile.bloomEnabled) bloom.setEnabled(camera, false, 1);

      scene.imageProcessingConfiguration.toneMappingEnabled = true;
      scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
      scene.imageProcessingConfiguration.exposure = 1.08;
      scene.imageProcessingConfiguration.contrast = 1.04;
      scene.imageProcessingConfiguration.isEnabled = true;
      const toneMap = new ImageProcessingPostProcess(
        "aces-tone-map",
        1,
        camera,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        engine,
        false,
        Constants.TEXTURETYPE_HALF_FLOAT,
        scene.imageProcessingConfiguration,
      );
      // 1B-11: the FIRST post-process owns the offscreen scene target (and
      // its depth buffer), so that is where MSAA lives — which is the
      // scotopic pass since 7-2, above. Leaving it declared here too would
      // request a second multisampled target for no benefit.
      toneMap.samples = 1;
      cleanup.push(() => toneMap.dispose(camera));
      // FXAA, with the final sharpen fused into it: one full-screen pass where
      // two ran, and no target between them (see `SharpenPass`).
      const fxaa = new FxaaSharpenPass(camera, engine, profile.sharpenAmount);
      cleanup.push(() => fxaa.dispose(camera));
      // FXAA is the no-MSAA fallback only; running both softens the image.
      if (profile.msaaSamples > 1) fxaa.setEnabled(camera, false);
      // The multisampled tiers' sharpen has no FXAA to ride in, so it is a pass
      // of its own, constructed last so it is last: it sharpens the display
      // image.
      const sharpen = new SharpenPass(camera, engine, profile.sharpenAmount);
      cleanup.push(() => sharpen.dispose(camera));
      if (!standaloneSharpen(profile)) sharpen.setEnabled(camera, false);

      checkpointRendererStartup("presentation systems construction", "sync");

      // 1C-4's two load-bearing guards, re-asserted now that the scene and
      // the post-process chain exist: the aerial hook needs linear HDR at
      // CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR, and Babylon fog must never join it.
      assertStartupInvariants({
        timestampQuerySupported,
        gpuTimingEnabled: engine.enableGPUTimingMeasurements,
        gpuTimingRequired: gpuTimingEnabled,
        requestedFeatures: requiredFeatures,
        grantedFeatures: engine.enabledExtensions,
        imageProcessingAppliedByPostProcess:
          scene.imageProcessingConfiguration.applyByPostProcess,
        sceneFogMode: scene.fogMode,
        // 2-8: the ocean's storage-texture mip chain rides Babylon's private
        // render-based generator — a Babylon bump that removes it must fail
        // here, not as silently unfiltered distant water.
        oceanMipGenerationAvailable: resolveOceanMipGenerator(engine) !== null,
      });

      await awaitRendererStartup(
        scene.whenReadyAsync(),
        options.signal,
        "WebGPU scene startup",
        SCENE_STARTUP_TIMEOUT_MILLISECONDS,
      );
      checkpointRendererStartup("scene shader readiness", "async");
      gpuUncapturedErrorGuard.throwIfFailed();
      throwIfRendererStartupAborted(options.signal);
      // The streamed roads round the start, primed beside everything above:
      // the pre-warm below bakes the first real page, and every page, cell
      // and tile after it bakes with them. The detail worker, started above,
      // is caught up when the renderer attaches the stream's consumers.
      await awaitRendererStartup(roadsPrimed, options.signal, "road priming", SCENE_STARTUP_TIMEOUT_MILLISECONDS);
      checkpointRendererStartup("road priming", "async");
      // `4.5-C2(a)`: pay for the four terrain compute pipelines here, behind
      // the load screen. Babylon 9.21 calls `createComputePipeline`
      // synchronously on first dispatch and three of these shaders inline the
      // ~750-line height kernel, so unwarmed they land as multi-hundred-
      // millisecond in-frame stalls during the first second of flight — most
      // of the `maxFrameMs` the capture reports in its warmup window. It warms
      // them against the coarsest real page under the spawn, so the aircraft
      // also starts over ground that already exists.
      await awaitRendererStartup(
        terrain.warmUpComputePipelines(
          options.world.airport?.centerX ?? 0,
          options.world.airport?.centerZ ?? 0,
        ),
        options.signal,
        "terrain compute pre-warm",
        SCENE_STARTUP_TIMEOUT_MILLISECONDS,
      );
      checkpointRendererStartup("terrain compute pre-warm", "async");
      gpuUncapturedErrorGuard.throwIfFailed();
      throwIfRendererStartupAborted(options.signal);
      // 2-10: the planar-reflection capture is retired — the environment
      // probe covers water reflections; the receiver contract stays bound to
      // a zero-confidence fallback texel inside each water material.
      const info = engine.getInfo();
      const renderer = new FlightRenderer(
        options,
        engine,
        gpuUncapturedErrorGuard,
        scene,
        camera,
        aircraft,
        surfaceVehicle,
        boatEffects,
        carEffects,
        underwater,
        terrain,
        terrainEvolution,
        terrainConsumerAuthority,
        atmosphere,
        clouds,
        cloudShadowReceivers,
        aerialReceivers,
        skyProbe,
        ocean,
        waterEnvironment,
        hydrology,
        bathymetry,
        airport,
        detail,
        groundCover,
        roads,
        roadSurface,
        wildlife,
        toneMap,
        fxaa,
        stars,
        lightPoints,
        steam,
        marina,
        marinaLampStart,
        clusteredLighting,
        hangarFloods.map((flood) => flood.name),
        airfieldLighting,
        airportGround,
        airportHeight,
        spawnedAirfields,
        scotopic,
        bloom,
        sharpen,
        atmosphereResources,
        pipelineCompiles,
        `${info.vendor} ${info.renderer}`.trim(),
      );
      if (person) renderer.installWalker(person);
      checkpointRendererStartup("renderer finalization", "sync");
      cleanup.length = 0;
      return renderer;
    } catch (error) {
      releaseRendererResources(
        cleanup,
        "Unable to completely release a partial WebGPU renderer",
      );
      throw error;
    }
  }

  private installWalker(person: PersonVisual): void {
    this.person = person;
    this.walkerGround = new LatticeHeightCache(this.cameraTerrainHeight);
  }

  /**
   * The walker's look and zoom the input gathered since the last frame
   * (radians right and up, wheel notches out), for the character camera.
   * Ignored outside a walking session.
   */
  applyCharacterLook(look: { readonly yaw: number; readonly pitch: number; readonly zoom: number }): void {
    // Spelled out: the WGSL swizzle lint reads `.yaw +=` as a swizzle.
    const gathered = this.characterLook;
    gathered.yaw = gathered.yaw + look.yaw;
    gathered.pitch = gathered.pitch + look.pitch;
    gathered.zoom = gathered.zoom + look.zoom;
  }

  /** The character camera's heading and pitch, radians: the walker moves and swims relative to them. */
  consumeFootsteps(out: FootstepEvents): FootstepEvents {
    out.count = this.footsteps.count;
    out.strength = this.footsteps.strength;
    this.footsteps.count = 0;
    this.footsteps.strength = 0;
    return out;
  }

  characterView(): { readonly heading: number; readonly pitch: number } {
    return this.characterCamera;
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    this.cameraCut = true;
    const cockpit = mode === "cockpit";
    this.aircraft.setCockpitView(cockpit);
    this.surfaceVehicle?.setCockpitView(cockpit);
    this.carCockpitView = cockpit;
    // A WORLD-ONLY RIG (perf capture) draws no part of the aeroplane in cockpit view. Disabling the
    // visual's ROOT is what does it, rather than walking the meshes: `setCockpitView` and
    // `configureCockpitOnlyParts` both own per-mesh `isVisible`, and a second writer would fight
    // them on the way back out. A disabled root draws nothing beneath it whatever those flags say,
    // and restoring it hands every mesh back in the state its own owner left it in.
    if (!cockpitRigDrawsAircraft(this.cockpitRigOverride)) {
      this.aircraft.root.setEnabled(!cockpit && !this.surfaceActive);
    }
    this.graph.invalidateHistory("camera mode changed");
  }

  /**
   * Snap the exterior rig onto its settled pose on the next frame.
   *
   * `setCameraMode` cannot do this — it early-returns when the mode has not
   * changed — and a spawn needs it even though the mode is the same. Two
   * things go wrong across a teleport without it. The frame graph's temporal
   * history is about somewhere else, and more sharply, the chase trail is
   * derived from how far the aircraft moved since the last frame: across a
   * jump to the runway that difference is kilometres, which would read as a
   * ground speed in the thousands and throw the camera far behind the
   * aeroplane on its first frame. Forgetting the previous position is what
   * makes the trail zero until the aircraft has actually moved again.
   */
  cutCamera(): void {
    this.cameraCut = true;
    this.previousAircraftPositionValid = false;
    this.observedGroundSpeed = 0;
    this.observedGroundSpeedHeldFrames = 0;
    this.graph.invalidateHistory("camera cut");
  }

  setViewerMode(enabled: boolean): void {
    if (enabled === this.viewerMode) return;
    this.viewerMode = enabled;
    // Disabling the root disables every aircraft mesh, which removes them
    // from the beauty pass and the shadow render lists alike; the visual and
    // its registrations are otherwise untouched so leaving the viewer is a
    // pure re-enable.
    this.aircraft.root.setEnabled(!enabled && !this.surfaceActive);
    this.surfaceVehicle?.root.setEnabled(!enabled && this.surfaceActive);
    this.setCameraMode(enabled ? "freefly" : "chase");
  }

  sampleGroundHeight(x: number, z: number): number {
    return this.cameraTerrainHeight(x, z);
  }

  /**
   * The world's airport list changed: an airport spawned ahead of the aircraft,
   * or the oldest spawned one was retired. Home field first.
   *
   * CHEAP AND SYNCHRONOUS ON PURPOSE: every owner below only records the
   * change and invalidates what it reaches. The work — regenerating the
   * vegetation cells over the new runway, rebaking a ground-cover tile, building
   * the airfield — happens in their own budgeted per-frame paths.
   */
  setAirports(airports: readonly Readonly<AirportDefinition>[]): void {
    if (this.disposed) return;
    const previous = this.liveWorld;
    const next = withAirports(previous, airports);
    if (next === previous) return;
    this.liveWorld = next;
    // 1. Terrain: the GPU grading and runway paint go first, so every consumer
    //    below reads ground the terrain also draws. Pages rebuild in place
    //    over later frames.
    this.terrain.setAirports(next.airports);
    // 2. The CPU ground: vegetation, ground cover, wildlife, the camera clamp
    //    and the spawned structures all read this one sampler, or its height.
    //    The wildlife's cached cells were generated from the old one.
    this.airportGround.setWorld(next);
    this.airportHeight.setWorld(next);
    this.roads?.setWorld(next);
    this.wildlife.invalidateCellCache();
    // 3. Vegetation: off the new platform and out of its structures; only the
    //    cells the change reaches regenerate.
    this.detail.setAirports(next.airports);
    // 4. Ground cover: a baked tile under a changed airport rebakes.
    for (const airport of changedAirports(previous.airports ?? [], next.airports)) {
      const bounds = airportReachWorldBounds(airportTerrainReach(airport));
      this.groundCover.invalidateArea(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ);
    }
    // 5. The airfield: hangars, tower, windsock, furniture, lamps and floods.
    this.spawnedAirfields?.setAirports(next.airports);
  }

  projectWorldPointToRef(x: number, y: number, z: number, result: ScreenPoint): boolean {
    const canvas = this.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return false;
    // Row-vector convention: clip = (local, 1) * view * projection.
    const m = this.camera.getTransformationMatrix().m;
    const lx = x - this.originX;
    const lz = z - this.originZ;
    const clipX = lx * m[0]! + y * m[4]! + lz * m[8]! + m[12]!;
    const clipY = lx * m[1]! + y * m[5]! + lz * m[9]! + m[13]!;
    const clipW = lx * m[3]! + y * m[7]! + lz * m[11]! + m[15]!;
    const inFront = clipW > 1e-6;
    // Behind the camera the divide mirrors the point; dividing by |w| keeps
    // the direction to turn toward instead.
    const w = Math.max(Math.abs(clipW), 1e-6);
    result.x = (clipX / w * 0.5 + 0.5) * width;
    result.y = (0.5 - clipY / w * 0.5) * height;
    result.inFront = inFront;
    result.width = width;
    result.height = height;
    return true;
  }

  setTerrainAuthorityPublisher(publisher: TerrainAuthorityPublisher | null): void {
    this.terrainAuthorityPublisher = publisher;
    if (publisher) this.terrainEvolution.publishMacroOnce(publisher);
    // The drawn lakes and rivers, for the car's water.
    const workerWater = hydrologyWaterPublisher(this.surfaceVehicle?.kind, publisher);
    this.hydrology.setWaterPublisher(this.underwater ? this.underwater.hydrologyPublisher(workerWater) : workerWater);
    const needsEvolvedConsumers = this.terrainConsumerAuthority !== null;
    this.terrain.setCollisionPagePublisher(
      publisher || needsEvolvedConsumers
        ? (page) => this.publishTerrainConsumerPage(page)
        : null,
    );
  }

  /** Copy before either worker detaches its transfer-owned publication. */
  private publishTerrainConsumerPage(page: TerrainPagePublication): void {
    // Baked before a road change that reached it: the workers dropped their
    // copies at the change, and the terrain is rebuilding it.
    if (this.roads?.holdsBack(page)) return;
    const authority = this.terrainConsumerAuthority;
    if (authority) {
      authority.publish({ ...page, heights: page.heights.slice() });
      this.detail.publishTerrainPage({ ...page, heights: page.heights.slice() });
      // The consumer surface moved under the wildlife's cached cells.
      this.wildlife.invalidateCellCache();
    }
    // Keep the original for the simulation worker and transfer it last.
    this.terrainAuthorityPublisher?.publishTerrainPage(page);
  }

  /** Aux hydrology remains render/detail-only; simulation receives no copy. */
  private publishTerrainConsumerAuxPage(page: TerrainAuxPagePublication): void {
    const authority = this.terrainConsumerAuthority;
    if (!authority) return;
    authority.publishAuxPage({
      ...page,
      shoreDistanceR16Sint: page.shoreDistanceR16Sint.slice(),
      soilDepthR8Unorm: page.soilDepthR8Unorm.slice(),
    });
    this.wildlife.invalidateCellCache();
    // Transfer the producer-owned buffer only after retaining the main-thread copy.
    this.detail.publishTerrainAuxPage(page);
  }

  setQuality(quality: QualityLevel): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.applyProfile();
  }

  setRenderingMode(mode: RenderingMode): void {
    if (mode === this.renderingMode) return;
    this.renderingMode = mode;
    this.applyProfile();
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  /**
   * The marina's calm basins (boats): the drawn waves inside are scaled down
   * exactly as the sea twin scales the waves a hull floats on. Pass the world's
   * marina shelter ellipses; none is the open sea.
   */
  setSeaShelter(ellipses: readonly SeaShelterEllipse[]): void {
    this.ocean.setShelter(ellipses);
  }

  setAtmosphere(clock: EnvironmentClock, weather: WeatherPreset): void {
    if (!this.atmosphereTracker.update(clock, weather)) return;
    this.environmentState = resolveEnvironmentState({
      clock,
      latitudeDegrees: this.latitudeDegrees,
      weather,
    });
    // R-26: publish the surface albedo BEFORE the light rig reads it.
    this.atmosphere.setSurfaceAlbedo(
      meanSeasonalSurfaceAlbedo(clock.dayOfYear, this.latitudeDegrees),
    );
    // Gate 7A: the moon's ephemeris and 7-2's adaptation ride the same clock
    // the sun does. A scrub snaps the adaptation (deltaSeconds 0) — the
    // 1C-6 probe's "the sun is static between scrubs" invariant, applied to
    // the eye, and what keeps a captured shot a function of pinned inputs.
    this.atmosphere.applyEnvironment(this.environmentState, clock, this.latitudeDegrees, 0);
    // 7-3: the star field's frame, and the galactic frame the sky's Milky
    // Way band reads — one sidereal matrix, two consumers.
    this.stars.setClock(clock, this.latitudeDegrees, this.environmentState.sun.direction[1]);
    const galactic = this.stars.galacticFrame(clock, this.latitudeDegrees);
    this.atmosphere.setGalacticFrame(galactic.pole, galactic.center);
    this.applyScotopicState();
    // R-13: the terrain's baked snow blanket and the detail generator follow
    // the same clock the sky does.
    this.terrain.setSeasonalDayOfYear(clock.dayOfYear);
    this.detail.setDayOfYear(clock.dayOfYear);
    this.skyProbeStale = true;
    this.clouds.setEnvironment(this.environmentState);
    this.clouds.setAtmosphere(this.atmosphere.snapshot);
    this.ocean.setAtmosphere(this.atmosphere.snapshot);
    this.ocean.setWindSpeed(seaSpectrumWindSpeed(this.worldDefinition, weather));
    this.boatWake?.setAtmosphere(this.atmosphere.snapshot);
    this.boatSpray?.setAtmosphere(this.atmosphere.snapshot);
    this.boatHeave?.setWeather(weather);
    this.underwater?.setWeather(weather);
    this.carParticles?.setAtmosphere(this.atmosphere.snapshot);
    this.carBowWave?.setAtmosphere(this.atmosphere.snapshot);
    this.hydrology.setAtmosphere(this.atmosphere.snapshot);
    // The snapshot carries no albedo; the occluded lake reflection's ground
    // bounce is the same `skyHorizon * albedo * 1.15` the light rig built
    // above, so it rides the same publish.
    this.hydrology.setGroundBounceAlbedo(this.atmosphere.surfaceAlbedoLuminance);
    this.ocean.setGroundBounceAlbedo(this.atmosphere.surfaceAlbedoLuminance);
    this.graph.invalidateHistory("atmosphere changed");
  }

  render(state: FlightVisualState, deltaSeconds: number): void {
    if (this.disposed) return;
    this.gpuUncapturedErrorGuard.throwIfFailed();
    if (this.deviceLost) {
      throw new Error("The WebGPU device was lost; rendering cannot continue");
    }
    if (!finiteState(state)) throw new Error("The simulation produced a non-finite render state");
    // B1: a governor step or display resize waiting since the last frame is
    // applied before anything draws. Ahead of `started`, so its cost and its
    // timing reset land where the old out-of-frame resize put them.
    this.applyPendingRenderScale();
    const started = performance.now();
    this.captureFrameInterval(started);
    this.currentState = this.presentedState(state);
    this.currentDeltaSeconds = Math.max(1 / 300, Math.min(0.1, deltaSeconds));
    this.frameIndex += 1;
    this.originShifted = this.updateFloatingOrigin(state);
    // Babylon increments this counter for every submitted draw but does not
    // advance it unless instrumentation is installed. Reset it explicitly so
    // diagnostics represent this frame instead of the renderer's lifetime.
    this.engine._drawCalls.fetchNewFrame();
    this.engine.beginFrame();
    try {
      this.graph.execute({
        frameIndex: this.frameIndex,
        timeSeconds: state.simulationTime,
        deltaSeconds: this.currentDeltaSeconds,
        cameraCut: this.cameraCut,
        originShifted: this.originShifted,
      });
    } finally {
      this.engine.endFrame();
    }
    this.cameraCut = false;
    this.passTimingHistory.record(this.graph.passTimings);
    this.lastCpuFrameMilliseconds = performance.now() - started;
    this.lastDrawCalls = Math.max(0, Math.round(this.engine._drawCalls.current));
    if (isUsableFrameTiming(this.lastCpuFrameMilliseconds)) {
      this.cpuFrameDurations.push(this.lastCpuFrameMilliseconds);
    }
    if (isUsableFrameTiming(this.lastCpuFrameMilliseconds)) {
      this.pushDiagnosticSample(this.diagnosticCpuDurations, this.lastCpuFrameMilliseconds);
    }
    const freshGpuSample = this.captureGpuFrameTiming();
    if (this.budgetProbe !== null) {
      // Probe stages deliberately perturb the frame; the governor sits out.
      this.updateBudgetProbe(freshGpuSample);
    } else if (
      this.pinnedRenderScale === null
      && this.frameIntervalDurations.length >= this.governorConfig.windowFrames
    ) {
      this.updateGovernor();
    }
  }

  /** Z-1: governor config, with the scale range collapsed when pinned. */
  /**
   * Wave Q: one frame's CSM state for the detail system's far-band shadow
   * receiver — documented Babylon reads only, mirroring the water adapter
   * (bindSunShadowReceiver), reusing its public split formula.
   */
  private buildDetailSunShadowSnapshot(): DetailSunShadowSnapshot | null {
    const shadows = this.atmosphere.shadows;
    const shadowMap = shadows.getShadowMap();
    const cascadeCount = Math.min(4, shadows.numCascades);
    if (
      !this.scene.shadowsEnabled
      || !shadows.getLight().shadowEnabled
      || shadowMap === null
      || cascadeCount <= 0
    ) {
      return null;
    }
    const matrices = this.detailSunShadowMatrices;
    let lastMatrix: Matrix | null = null;
    for (let cascade = 0; cascade < 4; cascade += 1) {
      const matrix: Matrix | null = cascade < cascadeCount
        ? shadows.getCascadeTransformMatrix(cascade) ?? lastMatrix
        : lastMatrix;
      if (matrix) {
        matrix.copyToArray(matrices, cascade * 16);
        lastMatrix = matrix;
      }
    }
    this.camera.getViewMatrix().copyToArray(this.detailSunShadowView);
    // Steady-frame path allocates nothing: the split formula's inputs are
    // constant between quality/governor changes, so the layout is memoized
    // on them and the snapshot object itself is reused (its array fields
    // are the persistent scratch buffers above).
    const layoutKey = `${cascadeCount}:${shadows.lambda}:${shadows.minDistance}:`
      + `${shadows.maxDistance}:${shadows.shadowMaxZ}:`
      + `${shadows.cascadeBlendPercentage}:${this.camera.minZ}:${this.camera.maxZ}`;
    if (this.detailSunShadowLayoutKey !== layoutKey) {
      this.detailSunShadowLayoutKey = layoutKey;
      this.detailSunShadowLayout = resolveSunShadowCascadeLayout({
        cameraMinZ: this.camera.minZ,
        cameraMaxZ: this.camera.maxZ,
        cascadeCount,
        lambda: shadows.lambda,
        minDistance: shadows.minDistance,
        maxDistance: shadows.maxDistance,
        shadowMaxZ: shadows.shadowMaxZ,
        cascadeBlendPercentage: shadows.cascadeBlendPercentage,
      });
    }
    const layout = this.detailSunShadowLayout!;
    const snapshot = this.detailSunShadowSnapshot;
    snapshot.splits = layout.splits;
    snapshot.blendStarts = layout.blendStarts;
    snapshot.cascadeCount = layout.cascadeCount;
    snapshot.darkness = shadows.getDarkness();
    snapshot.bias = shadows.bias;
    snapshot.shadowMaxZ = shadows.shadowMaxZ;
    snapshot.valid = true;
    snapshot.map = shadowMap;
    return snapshot;
  }

  private resolveGovernorConfig(): GovernorConfig {
    const config = governorConfigForProfile(this.profile);
    if (this.pinnedRenderScale === null) return config;
    return Object.freeze({
      ...config,
      // Wave R: pinning freezes every lever, not just the scale — see the
      // GovernorConfig.frozen contract.
      frozen: true,
      scaleCeiling: this.pinnedRenderScale,
      scaleFloor: this.pinnedRenderScale,
    });
  }

  private pushDiagnosticSample(ring: number[], value: number): void {
    ring.push(value);
    if (ring.length > DIAGNOSTIC_WINDOW_FRAMES) ring.shift();
  }

  /**
   * Kick off the budget-probe sweep (1A-1): cycles each frame-graph pass off
   * for a stage of frames and attributes the whole-frame GPU p95 delta.
   * HUD-triggered; refuses to start while one is already running.
   */
  startBudgetProbe(): boolean {
    if (this.disposed || this.deviceLost || this.budgetProbe !== null) return false;
    const passes = this.graph.passNames.filter(
      (name) => !BUDGET_PROBE_EXCLUDED_PASSES.has(name),
    );
    if (passes.length === 0) return false;
    this.budgetProbe = new FrameGraphBudgetProbe(passes);
    this.budgetProbeReport = null;
    this.resetTimingWindow();
    return true;
  }

  private updateBudgetProbe(freshGpuSample: number | null): void {
    const probe = this.budgetProbe;
    if (!probe) return;
    probe.recordFrame(freshGpuSample);
    const desired = probe.running ? probe.currentlyDisabled : null;
    if (desired !== this.probeDisabledPass) {
      if (this.probeDisabledPass !== null) {
        this.graph.setPassDisabled(this.probeDisabledPass, false);
      }
      if (desired !== null) this.graph.setPassDisabled(desired, true);
      this.probeDisabledPass = desired;
      // Re-enabled passes must not composite month-old history.
      this.graph.invalidateHistory("budget probe stage");
    }
    if (!probe.running) {
      this.budgetProbeReport = probe.report;
      this.budgetProbe = null;
      this.graph.clearDisabledPasses();
      this.resetTimingWindow();
    }
  }

  /**
   * Z-2: clear every timing window (governor and diagnostics). The perf
   * capture calls this at the start of its rAF-paced measurement phase so
   * hitch metrics describe paced frames only — the tight-loop streaming
   * phase renders as fast as the CPU allows and would read as a hitch storm.
   */
  resetPerformanceWindow(): void {
    this.resetTimingWindow();
  }

  /**
   * Capture-only synchronization point. Tight deterministic warm-up loops can
   * submit far faster than the adapter consumes work; resetting counters does
   * not drain that queue, so the first measured rAF previously inherited up
   * to seconds of old GPU work. Production never calls this blocking fence.
   */
  async waitForGpuIdleForCapture(): Promise<void> {
    if (this.disposed || this.deviceLost) return;
    await this.pipelineCompiles?.whenIdle();
    await this.engine._device.queue.onSubmittedWorkDone();
  }

  /**
   * Capture-only: restarts the ocean's cascade cadence at the harness's
   * per-shot time pin. Without it, which frame the every-4th-frame wave
   * cascade last evolved on depends on how many frames every EARLIER shot
   * streamed, which is wall-clock paced, so a water shot's waves differ
   * between runs of identical code. See `OceanCascadeClock`. Production never
   * calls this; mid-flight it would dispatch the slow cascades out of turn.
   *
   * It also makes every later sky re-light synchronous, for the renderer's
   * lifetime (`FlightRendererOptions.skyRebake`): a flight on this renderer
   * after a capture's settle no longer takes the sliced path.
   */
  pinOceanCascadePhaseForCapture(): void {
    if (this.disposed) return;
    this.ocean.pinCascadePhaseForCapture();
    // The time pin is where a capture's frames stop being a flight: from
    // here on the sky probe re-lights in the frame that asks, as it did when
    // the shots' baselines were made (`FlightRendererOptions.skyRebake`). The
    // A/B agent's renderer flies perf:flight too, so it cannot say so at
    // construction.
    this.skyRebakeSynchronous = true;
    // Likewise every pipeline is built in the frame that draws it, so a
    // shot's frames draw every mesh, as the baselines' did.
    this.pipelineCompiles?.setSynchronous(true);
  }

  /**
   * The perf probe's read of the off-frame pipeline compiles
   * (`AsyncPipelineCompiles`): counters since startup, or null when they are
   * not installed.
   */
  getPipelineCompileStatsForCapture(): AsyncPipelineCompileStatistics | null {
    return this.pipelineCompiles?.statistics ?? null;
  }

  /**
   * The perf probe's read of the two bakes that spread over frames, in
   * constant time. `sky` is this renderer's own timing of its probe refresh
   * on frame `frameIndex` (a one-frame re-light, a rebake's slice, its
   * landing, the specular cube's re-arm or the cloud ambient LUT; the cube
   * itself renders inside the frame's scene render). `skyRebake` and
   * `groundCover` are the systems' own counters
   * (`SkyEnvironmentProbe.rebakeStats`, `GroundCoverSystem.bakeStats`).
   */
  getBakeStatsForCapture(): {
    readonly sky: {
      readonly frameIndex: number;
      readonly lastMilliseconds: number;
      readonly maxMilliseconds: number;
    };
    readonly skyRebake: SkyRebakeStats;
    readonly groundCover: GroundCoverSystem["bakeStats"];
  } {
    return {
      sky: {
        frameIndex: this.skyRefreshFrameIndex,
        lastMilliseconds: this.skyRefreshLastMilliseconds,
        maxMilliseconds: this.skyRefreshMaxMilliseconds,
      },
      skyRebake: this.skyProbe.rebakeStats,
      groundCover: this.groundCover.bakeStats,
    };
  }

  /**
   * Capture-only: respawns the wildlife from its seed and restarts its clocks
   * at the harness's per-shot time pin. Without it the birds in a shot are
   * wherever every EARLIER shot's frames flew them, so identical code puts
   * them in different places run to run. See `WildlifeSystem.respawnForCapture`.
   * Production never calls this; mid-flight it would teleport every animal.
   */
  pinWildlifeForCapture(): void {
    if (this.disposed) return;
    this.wildlife.respawnForCapture();
  }

  /**
   * Capture-only snapshot of the bounded detail builder. Counters are
   * cumulative so the harness can take two cheap snapshots outside the timed
   * loop instead of sampling diagnostics on every frame and perturbing p95.
   */
  getDetailPresentationDiagnosticsForCapture() {
    return this.detail.presentationRebuildDiagnostics;
  }

  /** Constant-time frame correlation companion to the full detail snapshot. */
  getDetailPresentationMarkerForCapture() {
    return this.detail.presentationCaptureMarker;
  }

  /**
   * Installs the capture harness's authoritative WebGPU validation-error
   * channel. Browser-native `uncapturederror` events are not guaranteed to
   * call the page's patched `console.error`, so relying on console/Babylon
   * logging alone can let a rejected whole-frame submit look like a fast black
   * frame. The returned cleanup is idempotent and keeps the private device
   * itself out of the capture driver.
   */
  addGpuUncapturedErrorListenerForCapture(
    listener: (event: GPUUncapturedErrorEvent) => void,
  ): () => void {
    if (this.disposed) throw new Error("Cannot observe GPU errors on a disposed renderer");
    const device = this.engine._device;
    device.addEventListener("uncapturederror", listener);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      device.removeEventListener("uncapturederror", listener);
    };
  }

  /**
   * Provenance for the current timing window. A GPU percentile without its
   * resolved-sample count is not comparable to a 240-frame wall-clock window:
   * Babylon permits only one whole-frame timestamp readback in flight, so the
   * two sample counts are intentionally not assumed to match.
   */
  getGpuTimingStatusForCapture(): {
    readonly enabled: boolean;
    readonly epoch: number;
    readonly sampleCount: number;
    readonly latestSampleAgeFrames: number | null;
  } {
    return {
      enabled: this.engine.enableGPUTimingMeasurements,
      epoch: this.timingWindowEpoch,
      sampleCount: this.diagnosticGpuDurations.length,
      latestSampleAgeFrames: Number.isFinite(this.lastGpuTimingFrameIndex)
        ? Math.max(0, this.frameIndex - this.lastGpuTimingFrameIndex)
        : null,
    };
  }

  /** Internal raster size used when the capture driver resolves to CSS pixels. */
  getCaptureRenderSize(): { readonly width: number; readonly height: number } {
    return {
      width: this.engine.getRenderWidth(),
      height: this.engine.getRenderHeight(),
    };
  }

  /**
   * `?bench=1` only: `src/bench` calls this after every frame and nothing in
   * the game does. Constant time, allocation-free and read-only; it writes
   * `into` and nothing else. The streaming counters stay in `getDiagnostics`,
   * because pending detail work walks every desired cell and the terrain's
   * statistics getter allocates.
   */
  readBenchProbe(into: RendererBenchProbe): void {
    into.frameIndex = this.frameIndex;
    into.governorState = this.governorState;
    into.governorSignals = this.lastSignals;
    into.governorConfig = this.governorConfig;
    into.workLevers = this.workLeverSettings;
    into.appliedRenderScale = this.appliedRenderScale;
    into.renderWidth = this.engine.getRenderWidth();
    into.renderHeight = this.engine.getRenderHeight();
    into.pinned = this.pinnedRenderScale !== null;
    // `captureGpuFrameTiming` stamps a sample with the frame it resolved on,
    // after `frameIndex` has advanced, so equality means "resolved this frame".
    into.gpuFrameMs = this.lastGpuTimingFrameIndex === this.frameIndex
      ? this.lastGpuFrameMilliseconds
      : null;
  }

  /**
   * Capture-only switch between the shipping DPR-1 workload and the
   * high-DPR/cap-equivalent reference workload. It is intentionally refused
   * for interactive renderers, where the adaptive governor owns this state.
   */
  /**
   * `6-12` / P0 seam work — hide every vegetation mesh for one capture, so a
   * second capture can be differenced against it to yield a true VEGETATION
   * MASK.
   *
   * Capture-only, and it exists because every cheap post-hoc mask is
   * confounded with the quantity under test. Measured on the seam frame: a
   * COLOUR mask cannot work — far trees read `rgb(86,107,86)` against open
   * ground `rgb(81,104,78)`, indistinguishable in hue and saturation. A
   * DARKNESS mask biases toward the dark mode, and a SPATIAL-FREQUENCY mask
   * biases toward the alpha-tested band — both of which are exactly what a
   * band-handoff comparison is trying to measure. Differencing against a
   * vegetation-free render is the only mask that is independent of the thing
   * being measured.
   *
   * Every vegetation mesh is named with the `detail-` prefix (`detail-tree-*`,
   * `detail-foliage-*`, `detail-bark-*`, `detail-shrub-*`, `detail-clutter-*`,
   * `detail-ground-*`, `detail-rock-*`, `detail-impostor`), which is the whole
   * selector. Terrain, water, sky and aircraft are untouched.
   */
  setVegetationVisibleForCapture(visible: boolean): number {
    let toggled = 0;
    for (const mesh of this.scene.meshes) {
      if (!mesh.name.startsWith("detail-")) continue;
      if (mesh.isVisible === visible) continue;
      mesh.isVisible = visible;
      toggled += 1;
    }
    // The `detail-` walk above cannot reach the compute ground-cover field:
    // its meshes are named `ground-cover-ring-N`, and — more to the point —
    // `GroundCoverSystem` re-asserts `setEnabled()` on them every update, so
    // an `isVisible` written from out here is overwritten on the next frame.
    // Only the owner can stop re-asserting, so it owns the flag and this adds
    // its count to ours. Before this, blades survived into every
    // "vegetation-hidden" capture and were therefore differenced to ~0 and
    // classified as TERRAIN by the very instrument built to isolate them.
    toggled += this.groundCover.setVisibleForCapture(visible);
    return toggled;
  }

  setPinnedRenderScaleForCapture(scale: number): void {
    if (this.pinnedRenderScale === null) {
      throw new Error("Capture render scale can only change on a pinned renderer");
    }
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
      throw new RangeError("Capture render scale must be finite and in [0.1, 2]");
    }
    if (Math.abs(scale - this.pinnedRenderScale) <= 1e-6) return;
    this.pinnedRenderScale = scale;
    this.governorConfig = this.resolveGovernorConfig();
    this.governorState = createGovernorState(this.governorConfig);
    this.renderScale = this.governorState.renderScale;
    this.applyRenderScale();
    this.resetTimingWindow();
    this.graph.invalidateHistory("capture render-scale change");
  }

/**
 * Bytes per texel from a texture's TYPE **and** its FORMAT.
 *
 * **The format half was missing and it cost 156 MiB of fiction.** This read
 * `type` alone and mapped `TEXTURETYPE_FLOAT` to 16 bytes — correct for
 * RGBA32F and **four times too large for R32F**. The terrain height atlas is
 * `RawTexture.CreateRStorageTexture(..., TEXTURETYPE_FLOAT)` — one channel,
 * 3696² — so the inventory reported it at 208.44 MiB against a true 52.11,
 * and the whole-renderer total read 488 MiB against a true ~332 with a 495 MiB
 * ceiling. **Headroom was reported as −0.9 MiB when it was +163.**
 *
 * Two things that made the error survive. It is a CONSTANT factor on one term,
 * so `inventoried / estimated` held a stable ratio — and that stability was
 * read for months as evidence the ESTIMATE was missing a category, when it was
 * evidence this function had a constant-factor bug. The same observation, the
 * opposite conclusion. And nothing compared the arithmetic against any
 * texture's real format, which is what
 * `tests/render.gpu-memory-inventory-format.test.ts` now does.
 *
 * Integer formats carry the same channel counts as their float siblings; the
 * component width comes from the type, so they need no separate row.
 */
private texelBytes(type: number | undefined, format: number | undefined): number {
  // Component width by TYPE. `SHORT` is here because the audit of every
  // single-channel site found `shoreDistance` created as
  // `TEXTUREFORMAT_RED_INTEGER` + `TEXTURETYPE_SHORT` — two bytes, which the
  // first version of this fix counted as one. **The fix for a 4x over-count
  // shipped with a 2x under-count in it**, on the one type nobody was looking
  // at, and only enumerating the sites found it.
  const componentBytes = type === Constants.TEXTURETYPE_FLOAT
    || type === Constants.TEXTURETYPE_INT
    || type === Constants.TEXTURETYPE_UNSIGNED_INTEGER
    ? 4
    : type === Constants.TEXTURETYPE_HALF_FLOAT
      || type === Constants.TEXTURETYPE_SHORT
      || type === Constants.TEXTURETYPE_UNSIGNED_SHORT
      ? 2
      // UNSIGNED_BYTE and BYTE, and the default for an undeclared type.
      : 1;
  const channels = format === Constants.TEXTUREFORMAT_R
    || format === Constants.TEXTUREFORMAT_R_INTEGER
    ? 1
    : format === Constants.TEXTUREFORMAT_RG
      || format === Constants.TEXTUREFORMAT_RG_INTEGER
      ? 2
      : format === Constants.TEXTUREFORMAT_RGB
        || format === Constants.TEXTUREFORMAT_RGB_INTEGER
        ? 3
        // Undefined format means the texture never declared one; Babylon's
        // default is RGBA and four channels is also the SAFE direction for a
        // figure used as a ceiling check.
        : 4;
  return channels * componentBytes;
}

  /**
   * Z-4: a best-effort inventory of what is actually allocated — textures by
   * size×format, geometry by vertex stride and indices. It cannot see MSAA
   * resolve targets, pipelines or driver overhead, so it is a FLOOR, used to
   * sanity-check `estimateGpuMemoryMiB`'s arithmetic (whose fudge factor had
   * never been compared against a real reading).
   */
  private inventoryGpuMemoryMiB(): number {
    return this.inventoryGpuMemoryBreakdown().totalMiB;
  }

  /**
   * The same walk, reporting WHAT IT SAW rather than one scalar.
   *
   * **The single scalar is why the estimate's re-pin trigger could fire and
   * not be actionable.** `|estimate - inventory|` was 47.3% at tier 1 after
   * the format fix, and the only two numbers in the report were the two ends
   * of that subtraction — so the divergence could be measured and could not be
   * ATTRIBUTED. Splitting `MISC_ALLOWANCE_MIB` into the part the walk can see
   * and the part it cannot was blocked on exactly this: without a breakdown,
   * any split is someone deciding which MiB are invisible and calling the
   * result measured.
   *
   * The three lanes are the walk's three sources, and they are not
   * interchangeable:
   * - `textureMiB` — `scene.textures`, by size x format.
   * - `geometryMiB` — `scene.meshes` vertex strides and indices. **This is the
   *   lane that bounds the mesh half of `MISC_ALLOWANCE_MIB`**, whose docblock
   *   claims "aircraft/airport meshes, sky dome" among things the estimate
   *   allows 40 MiB for. Those meshes are in `scene.meshes`, so they are
   *   MEASURED here and must not also be counted as invisible.
   * - `bufferMiB` — storage buffers, which appear in neither Babylon list.
   *
   * Still a FLOOR, and the reason is unchanged: pipelines, shader cache, MSAA
   * resolve targets and driver overhead are invisible to all three lanes. The
   * point of the split is that "invisible" is now a named residual instead of
   * a property of the whole number.
   */
  private inventoryGpuMemoryBreakdown(): {
    textureMiB: number;
    geometryMiB: number;
    bufferMiB: number;
    totalMiB: number;
  } {
    let bytes = 0;
    const seenTextures = new Set<unknown>();
    for (const texture of this.scene.textures) {
      const internal = (texture as unknown as {
        _texture?: {
          width?: number;
          height?: number;
          depth?: number;
          type?: number;
          format?: number;
          generateMipMaps?: boolean;
          mipLevelCount?: number;
        } | null;
      })._texture;
      if (!internal || seenTextures.has(internal)) continue;
      seenTextures.add(internal);
      const width = internal.width ?? 0;
      const height = internal.height ?? 0;
      const depth = Math.max(1, internal.depth ?? 1);
      const bytesPerTexel = this.texelBytes(internal.type, internal.format);
      // A chain is a chain whoever built it. The hand-built ones (aircraft and
      // airfield paint, the livery, the terrain/foliage/impostor arrays) carry
      // their levels with Babylon's generation OFF (`MipChainUpload.ts`, FI-5),
      // so the flag alone would drop a third of their bytes from a gated number.
      const mipFactor = internal.generateMipMaps || (internal.mipLevelCount ?? 1) > 1 ? 4 / 3 : 1;
      bytes += width * height * depth * bytesPerTexel * mipFactor;
    }
    const textureBytes = bytes;
    const seenGeometries = new Set<unknown>();
    for (const mesh of this.scene.meshes) {
      const geometry = (mesh as Mesh).geometry;
      if (!geometry || seenGeometries.has(geometry)) continue;
      seenGeometries.add(geometry);
      let strideBytes = 0;
      const buffers = geometry.getVertexBuffers();
      if (buffers) {
        for (const kind of Object.keys(buffers)) {
          strideBytes += buffers[kind]?.byteStride ?? 0;
        }
      }
      bytes += geometry.getTotalVertices() * strideBytes;
      bytes += geometry.getTotalIndices() * 4;
    }
    const geometryBytes = bytes - textureBytes;
    // Storage buffers appear in neither list, and every allocation Phase 6
    // adds is one. Without this the wall reads byte-identical no matter how
    // much compute scratch an item allocates.
    const bufferBytes = inventoriedGpuBufferBytes();
    bytes += bufferBytes;
    const MIB = 1_048_576;
    // The total is the SUM OF THE LANES, never a separately accumulated
    // figure: two additions of the same quantity are two things that can
    // disagree, and a breakdown that does not reconcile to its own total is
    // worth less than the scalar it replaced.
    return {
      textureMiB: textureBytes / MIB,
      geometryMiB: geometryBytes / MIB,
      bufferMiB: bufferBytes / MIB,
      totalMiB: bytes / MIB,
    };
  }

  getDiagnostics(): RenderDiagnostics {
    const terrain = this.terrain.statistics;
    const wildlife = this.wildlife.statistics;
    const hydrology = this.hydrology.getStatistics();
    const gpuFrameTime = freshFrameTiming(
      this.lastGpuFrameMilliseconds,
      this.lastGpuTimingFrameIndex,
      this.frameIndex,
      GPU_TIMING_STALE_AFTER_FRAMES,
    );
    // Z-2: aggregate over the rolling rings, not the governor's consumable
    // window (R-4 — the old path read null whenever the window had just been
    // consumed, which was every committed capture).
    // The threshold is a product contract, not something a slower workload
    // may redefine until its own misses disappear. A tier-1 frame above
    // 27.4 ms is a visible missed delivery and must remain visible here.
    const inventoryLanes = this.inventoryGpuMemoryBreakdown();
    // One viewport for both estimates. Two reads of `clientWidth` could differ
    // across a resize and make the restricted figure incomparable to the one
    // it is a subset of.
    const estimateViewport = {
      cssWidth: Math.max(1, this.domElement.clientWidth),
      cssHeight: Math.max(1, this.domElement.clientHeight),
      devicePixelRatio: window.devicePixelRatio || 1,
    };
    const hitchThresholdMs = hitchThresholdMilliseconds(this.profile);
    let hitchCount = 0;
    let maxFrameMs: number | null = null;
    for (const interval of this.diagnosticIntervalDurations) {
      if (interval > hitchThresholdMs) hitchCount += 1;
      if (maxFrameMs === null || interval > maxFrameMs) maxFrameMs = interval;
    }
    const p999FrameMs = frameTimingPercentile(this.diagnosticIntervalDurations, 0.999);
    const gpuP95Ms = this.diagnosticGpuDurations.length >= MIN_GPU_TIMING_SAMPLES
      ? frameTimingPercentile95(this.diagnosticGpuDurations)
      : this.lastSignals.gpuP95Ms;
    const cpuP95Ms =
      frameTimingPercentile95(this.diagnosticCpuDurations) ?? this.lastSignals.cpuP95Ms;
    const frameIntervalP95Ms =
      frameTimingPercentile95(this.diagnosticIntervalDurations)
      ?? this.lastSignals.intervalP95Ms;
    return {
      fps: this.engine.getFps(),
      frameTime: this.lastFrameIntervalMilliseconds,
      cpuFrameTime: this.lastCpuFrameMilliseconds,
      gpuFrameTime,
      presentWaitTime: this.lastPresentWaitMilliseconds,
      drawCalls: this.lastDrawCalls,
      triangles: Math.round(this.scene.getActiveIndices() / 3),
      geometries: this.scene.geometries.length,
      textures: this.scene.textures.length,
      terrainTiles: terrain.nodes,
      // 4-2/4-5: the GPU atlas's residency. The CPU tile path is gone, and
      // these fields kept their names because their MEANING survived it —
      // resident pages are resident pages.
      residentTerrainPages: terrain.residentSlots,
      // The TOTAL above cannot distinguish terrain nobody can see from terrain
      // physics, morphing and generation require. `residentTerrainPages` was
      // read as the former and is the sum of both.
      residencyReasons: terrain.residencyReasons,
      collisionSamplesServedByFallback:
        this.currentState?.terrainAuthority?.analyticServed ?? 0,
      visibleInstances: this.detail.statistics.renderedThinInstances + wildlife.renderedThinInstances,
      vegetationBatches: this.detail.statistics.activeBatches,
      activeAnimals: wildlife.activeAnimals,
      riverCount: hydrology.riverCount,
      lakeCount: hydrology.lakeCount,
      hydrologyMainThreadFallback: hydrology.usingMainThreadFallback,
      hydrologyLastGenerationUsedWorker: hydrology.lastGenerationUsedWorker,
      // Counters only: the perf probe reads diagnostics every frame, and
      // `presentationRebuildDiagnostics` walks every cell.
      detailWorker: this.detail.workerHealth,
      requestedRenderingMode: this.renderingMode,
      renderBackend: "webgpu",
      renderTechnique: "forward-spectral-volumetric",
      renderScale: this.appliedRenderScale,
      cloudResolutionScale: this.profile.cloudResolutionScale,
      cloudRaySteps: this.profile.cloudPrimarySteps,
      oceanFftCascades: this.ocean.cascadeCount,
      oceanFftResolution: this.ocean.fftResolution,
      adapter: this.adapterLabel,
      renderingFallbackReason: null,
      activeGovernor: this.pinnedRenderScale !== null ? "pinned" : this.governorState.mode,
      gpuP95Ms,
      cpuP95Ms,
      frameIntervalP95Ms,
      // A percentile of per-frame residuals, never a subtraction of three
      // independently ranked marginal percentiles.
      presentWaitP95Ms: frameTimingPercentile95(this.diagnosticPresentWaitDurations),
      maxFrameMs,
      p999FrameMs,
      hitchCount,
      cpuWorkLevel: this.governorState.cpuWorkLevel,
      cpuWorkLever: this.governorState.lastLever,
      gpuWorkLevel: this.governorState.gpuWorkLevel,
      resolutionInsensitive: this.governorState.resolutionInsensitive,
      renderPixels: this.engine.getRenderWidth() * this.engine.getRenderHeight(),
      topPassesByCpuMs: this.passTimingHistory
        .topByP95(4)
        .map((pass) => ({ name: pass.name, p95Ms: pass.p95Ms })),
      // Road regions still coming bring page rebuilds with them: a capture waits.
      pendingTerrainPages: terrain.pendingPages + terrain.slotsGenerating + (this.roads?.pendingRegions ?? 0),
      // Road changes and chunks still to draw (a frame's budget at a time): a capture waits.
      pendingDetailWork: this.detail.pendingWorkItems + this.groundCover.pendingTileRows
        + (this.roadSurface?.pendingWork ?? 0),
      terrainComputeDispatches: terrain.workersBusy,
      estimatedGpuMemoryMiB: estimateGpuMemoryMiB(
        this.profile,
        estimateViewport,
        this.dynamicAllocations,
      ),
      // The subset the inventory walk can actually see, for the re-pin trigger.
      // The unrestricted figure above stays the budgeting number — four owners
      // budget through it — and this one exists ONLY to be compared against a
      // measurement, which the unrestricted figure cannot honestly be.
      estimatedInventoriableGpuMemoryMiB: estimateInventoriableGpuMemoryMiB(
        this.profile,
        estimateViewport,
        { worldEvolution: this.worldDefinition.worldEvolution },
        this.dynamicAllocations,
      ),
      // ONE walk, both readings. Calling `inventoryGpuMemoryMiB()` here as
      // well would walk the scene twice and let the total disagree with the
      // lanes it is supposed to be the sum of.
      inventoriedGpuMemoryMiB: inventoryLanes.totalMiB,
      inventoriedGpuMemoryLanes: {
        textureMiB: inventoryLanes.textureMiB,
        geometryMiB: inventoryLanes.geometryMiB,
        bufferMiB: inventoryLanes.bufferMiB,
      },
      budgetProbeActive: this.budgetProbe !== null,
      budgetProbeReport: this.budgetProbeReport,
      gpuPassMs: this.collectGpuPassAttribution(),
    };
  }

  /**
   * `4.5-C3` — sum Babylon's per-pass GPU counters.
   *
   * Assertion 67 has been carried open through two phases with no owner. This
   * is its cheap, honest fraction: the counters exist whenever the adapter
   * granted `timestamp-query`, and reading them costs nothing. They are
   * UNCORRELATED — no submitted-frame id — so `B-0`'s rule stands and nothing
   * here infers a present wait. What it buys is that the frame's 39-53 ms
   * interval against a ~15 ms GPU p95 becomes inspectable instead of being a
   * gap nobody can name.
   */
  private collectGpuPassAttribution(): GpuPassAttribution {
    if (!this.engine.enableGPUTimingMeasurements) {
      return { mainPass: null, shadows: null, terrainCompute: null, total: null };
    }
    const nanoseconds = (value: number | undefined): number | null =>
      value === undefined || !Number.isFinite(value) ? null : value / 1_000_000;
    const mainPass = nanoseconds(this.engine.gpuTimeInFrameForMainPass?.counter.current);
    const shadowTarget = this.atmosphere.shadows.getShadowMap()?.renderTarget as
      { gpuTimeInFrame?: { counter: { current: number } } } | null | undefined;
    const shadows = nanoseconds(shadowTarget?.gpuTimeInFrame?.counter.current);
    const terrainCompute = this.terrain.gpuComputeMillisecondsInFrame;
    const parts = [mainPass, shadows, terrainCompute]
      .filter((value): value is number => value !== null);
    return {
      mainPass,
      shadows,
      terrainCompute,
      total: parts.length === 0
        ? null
        : parts.reduce((sum, value) => sum + value, 0),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Detach before any GPU owner is torn down. Disposal-time validation
    // noise must not terminalize an already disposed renderer or its next
    // replacement in React development lifecycles.
    this.gpuUncapturedErrorGuard.dispose();
    // Dispose every resource even if a device-loss edge case makes one GPU
    // owner throw. The array is intentionally listed in reverse execution
    // order because releaseRendererResources unwinds from the end.
    releaseRendererResources([
      () => {
        delete this.domElement.dataset.rendererMode;
        delete this.domElement.dataset.renderTechnique;
        delete this.domElement.dataset.bathymetryStorageFormat;
      },
      () => this.engine.dispose(),
      () => this.scene.dispose(),
      () => this.atmosphere.dispose(),
      () => this.aircraft.dispose(),
      () => this.surfaceVehicle?.dispose(),
      () => this.person?.dispose(),
      () => {
        if (typeof window !== "undefined") {
          window.removeEventListener("keydown", this.handleDebugKey);
        }
      },
      () => this.terrain.dispose(),
      () => this.roads?.dispose(),
      () => this.roadSurface?.dispose(),
      () => this.terrainEvolution.dispose(),
      () => this.bathymetry.dispose(),
      () => this.wildlife.dispose(),
      () => this.detail.dispose(),
      () => this.pipelineCompiles?.dispose(),
      () => this.airport?.dispose(),
      () => this.marina.dispose(),
      () => this.spawnedAirfields?.dispose(),
      () => this.clouds.dispose(),
      () => this.steam.dispose(),
      () => this.boatSpray?.dispose(),
      () => this.boatWake?.dispose(),
      () => this.carParticles?.dispose(),
      () => this.carTracks?.dispose(),
      () => this.carBowWave?.dispose(),
      () => this.underwater?.dispose(),
      () => this.hydrology.dispose(),
      () => this.ocean.dispose(),
      () => this.cloudShadowReceivers.dispose(),
      () => this.aerialReceivers.dispose(),
      () => this.skyProbe.dispose(),
      () => this.atmosphereResources.dispose(),
      () => this.toneMap.dispose(this.camera),
      () => this.fxaa.dispose(this.camera),
      () => this.sharpen.dispose(this.camera),
      () => this.graph.dispose(),
      () => this.resizeObserver.disconnect(),
    ], "Unable to completely release the WebGPU renderer");
  }

  private installFrameGraph(): void {
    this.graph.register({
      name: "flight-presentation",
      phase: "simulation",
      execute: () => this.updatePresentation(),
    });
    // Its own pass, so a frame's install, composition and GPU pack of the
    // streamed roads read as one number (perf:flight's `passMs`).
    if (this.roads) {
      this.graph.register({
        name: "road-stream",
        phase: "visibility",
        after: ["flight-presentation"],
        execute: () => this.updateRoadStream(),
      });
    }
    this.graph.register({
      name: "world-page-visibility",
      phase: "visibility",
      after: this.roads ? ["flight-presentation", "road-stream"] : ["flight-presentation"],
      execute: () => this.updateWorldVisibility(),
    });
    // After the terrain wrote this frame's node records: the ribbons and
    // rails in reach, and the drawn ground they lie on.
    if (this.roadSurface) {
      this.graph.register({
        name: "road-surface",
        phase: "visibility",
        after: ["world-page-visibility"],
        execute: () => this.roadSurface?.update(this.cameraWorld.x, this.cameraWorld.z),
      });
    }
    // 2-10: the shared-planar-water-reflection node is retired with its
    // capture system — the environment probe carries water reflections, and
    // 5-12 rebuilds the lake capture around the preserved plane-selection
    // hysteresis.
    this.graph.register({
      name: "spectral-ocean-compute",
      phase: "water",
      after: ["world-page-visibility"],
      execute: (frame) => {
        void this.bathymetry.recenter(this.cameraWorld.x, this.cameraWorld.z);
        // W-8: the sea's environment field. A bake is ~9k terrain-climate
        // samples and happens only when the aircraft has flown 50 km from the
        // last window centre, so this is a compare per frame and a few
        // milliseconds twice an hour of flying.
        //
        // The FIRST bake is deferred past the first frame. Cold start's
        // time-to-ready includes the first GPU-complete frame, so anything
        // done there lands on a path gated in milliseconds; the field is the
        // one piece of this wave that does real CPU work, and it does not have
        // to be done then. The cost of waiting is one frame rendered against
        // the neutral mid-province fallback, which is exactly the province
        // where the field's own contrast curve is the identity — i.e. nothing
        // a frame could show.
        if (this.waterEnvironmentBakeDeferred) {
          this.waterEnvironmentBakeDeferred = false;
        } else if (this.waterEnvironment.update(this.cameraWorld.x, this.cameraWorld.z)) {
          this.ocean.setWaterEnvironmentField(this.waterEnvironment);
        }
        this.ocean.update(this.cameraWorld, frame.timeSeconds, frame.deltaSeconds);
        // The wake and the car's bow wave lie on the waves this frame's sea is drawn with.
        this.boatWake?.bindOcean();
        this.carBowWave?.bindOcean();
        // Which side of the drawn water the camera is on, at the time the sea is drawn at.
        this.underwater?.update(this.cameraWorld.x, this.cameraWorld.y, this.cameraWorld.z, frame.timeSeconds);
        // 6-5: the wet-sand half of 6-2's run-up is drawn by the TERRAIN (the
        // ocean disk is depth-tested away above the waterline), so the sea
        // state and the WATER's own clock cross here — same node, same frame,
        // same `timeSeconds` the spectrum is stepped with, or the sand would
        // dry out of time with the surf that wetted it.
        this.terrain.setShoreWetness(this.ocean.shoreRunupSwell(), frame.timeSeconds);
        const state = this.currentState;
        this.hydrology.update(
          frame.timeSeconds,
          this.camera.position,
          state ? {
            x: state.position.x,
            z: state.position.z,
            velocityX: state.velocity.x,
            velocityZ: state.velocity.z,
          } : undefined,
        );
      },
    });
    this.graph.register({
      name: "volumetric-cloud-integration",
      phase: "volumetrics",
      after: ["spectral-ocean-compute"],
      execute: (frame) => {
        this.clouds.update(this.cameraWorld, frame.timeSeconds);
        const cloudShadow = this.clouds.cloudShadow;
        this.terrain.setCloudShadow(cloudShadow);
        this.ocean.setCloudShadow(cloudShadow);
        this.hydrology.setCloudShadow(cloudShadow);
        this.cloudShadowReceivers.setProjection(
          cloudShadow,
          this.originX,
          this.originZ,
        );
      },
      invalidateHistory: (reason) => {
        // 1B-12: cloud reprojection runs on absolute camera positions, so a
        // floating-origin rebase is exactly a no-op for it — the history
        // survives the frames it used to be thrown away on.
        if (reason !== "floating origin shifted") this.clouds.invalidateHistory();
      },
    });
    this.graph.register({
      name: "hdr-present",
      phase: "post",
      after: ["volumetric-cloud-integration"],
      execute: () => this.scene.render(false, false),
    });
  }

  private updatePresentation(): void {
    const state = this.currentState;
    if (!state) return;
    this.bodyQuaternion.set(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
      state.orientation.w,
    ).normalize();
    Matrix.FromQuaternionToRef(this.bodyQuaternion, this.bodyMatrix);
    Vector3.TransformNormalToRef(Vector3.Right(), this.bodyMatrix, this.forward);
    Vector3.TransformNormalToRef(Vector3.Up(), this.bodyMatrix, this.up);
    this.forward.normalize();
    this.up.normalize();
    this.syncActiveVehicle(state);
    const parkedCar = state.walking?.driven === "person" ? state.walking.car : null;
    const carCockpit = this.cameraMode === "cockpit" && !parkedCar;
    if (this.surfaceVehicle && carCockpit !== this.carCockpitView) {
      this.carCockpitView = carCockpit;
      this.surfaceVehicle.setCockpitView(carCockpit);
    }
    if (!this.viewerMode && this.surfaceActive && this.surfaceVehicle) {
      if (parkedCar) {
        // On foot: the common state is the walker's; the car keeps its own pose.
        this.vehicleQuaternion.set(
          parkedCar.orientation.x,
          parkedCar.orientation.y,
          parkedCar.orientation.z,
          parkedCar.orientation.w,
        ).normalize();
        Matrix.FromQuaternionToRef(this.vehicleQuaternion, this.vehicleMatrix);
        this.poseSurfaceVehicle(parkedCar, this.surfaceVehicle, this.vehicleQuaternion, this.vehicleMatrix);
      } else {
        this.poseSurfaceVehicle(state, this.surfaceVehicle, this.bodyQuaternion, this.bodyMatrix);
      }
      const doors = state.walking?.doors;
      this.surfaceVehicle.setDoors?.(doors?.[0] ?? 0, doors?.[1] ?? 0);
      this.posePerson(state);
    } else if (!this.viewerMode) {
      this.aircraft.root.position.set(
        state.position.x - this.originX,
        state.position.y,
        state.position.z - this.originZ,
      );
      this.aircraft.root.rotationQuaternion?.copyFrom(this.bodyQuaternion);
      this.aircraft.update(state, this.currentDeltaSeconds);
      // `7-8`: the lamp law needs the OBSERVER's bearing, which is the
      // renderer's knowledge and not the aircraft's. Body-frame components, so
      // no world convention leaks in: `D-6` settled forward +X, starboard +Z.
      const toCamera = this.camera.position.subtract(this.aircraft.root.position);
      const bodyForward = Vector3.TransformNormal(Vector3.Right(), this.bodyMatrix);
      const bodyStarboard = Vector3.TransformNormal(Vector3.Forward(true), this.bodyMatrix);
      const lights = resolveAircraftLights({
        simulationTimeSeconds: state.simulationTime,
        observerAzimuthDegrees: observerAzimuthDegrees(
          Vector3.Dot(toCamera, bodyForward),
          Vector3.Dot(toCamera, bodyStarboard),
        ),
        altitudeAglMeters: state.altitudeAgl,
        gear: state.gear ?? 1,
        landingSwitchOn: false,
        // The cockpit glow rides the same environment the airfield lamps do,
        // in the opposite direction: panel lighting comes UP as the sun sets.
        sunElevationSine: this.environmentState.sun.direction[1],
        horizontalLux: horizontalIlluminanceLux(this.environmentState),
      });
      this.aircraft.setLightState(lights);

      // `7-8`: the landing and taxi CAST POOLS — separate objects from the
      // lamps and governed by a different rule. The lamps are exempt from
      // daylight attenuation because anti-collision lights are required lit by
      // day; a pool of light on the ground at solar noon is invisible in life.
      // Same law as `7-14`'s floods, not an aircraft variant of it.
      //
      // `setPosition` takes WORLD coordinates and rebases itself, so the
      // floating origin is deliberately NOT applied: `state.position` is
      // already world and subtracting the origin would double-correct.
      const poolStarboard = Vector3.TransformNormal(Vector3.Forward(true), this.bodyMatrix);
      const poolUp = Vector3.TransformNormal(Vector3.Up(), this.bodyMatrix);
      for (const pool of AIRCRAFT_CAST_POOLS) {
        const at = castPoolWorldPosition(
          [state.position.x, state.position.y, state.position.z],
          [bodyForward.x, bodyForward.y, bodyForward.z],
          [poolUp.x, poolUp.y, poolUp.z],
          [poolStarboard.x, poolStarboard.y, poolStarboard.z],
          pool.offset,
        );
        // BOTH returns are checked. False means the name is unknown — which
        // includes a definition `IsLightSupported` refused at construction, and
        // that refusal is silent. A pool that never moves and never brightens
        // looks exactly like a pool correctly gated off, so an unchecked call
        // would hide the failure for the whole life of the renderer.
        const moved = this.clusteredLighting.setPosition(pool.name, at[0], at[1], at[2]);
        const lit = this.clusteredLighting.setIntensity(
          pool.name,
          pool.intensity * lights.landing * this.lastDaylightAttenuation,
        );
        if ((!moved || !lit) && !this.castPoolWarned) {
          this.castPoolWarned = true;
          console.warn(
            `aircraft cast pool "${pool.name}" is not in the clustered container `
            + "— it was refused at construction and will never light anything",
          );
        }
      }

      // `7-15`: the wash lights ride the same body axes as the pools and the
      // same daylight law — a wash on the airframe at solar noon is invisible
      // in life, and attenuating it is what keeps every daylight capture
      // unchanged by this feature.
      //
      // Each wash is driven by ITS OWN lamp's scalar, so the beacon wash
      // flashes with the beacon and the nav washes are steady. A wash that
      // outlived its lamp would be a light with no source.
      for (const wash of aircraftWashLights(this.aircraftKind)) {
        const at = castPoolWorldPosition(
          [state.position.x, state.position.y, state.position.z],
          [bodyForward.x, bodyForward.y, bodyForward.z],
          [poolUp.x, poolUp.y, poolUp.z],
          [poolStarboard.x, poolStarboard.y, poolStarboard.z],
          wash.offset,
        );
        const washMoved = this.clusteredLighting.setPosition(wash.name, at[0], at[1], at[2]);
        const washLit = this.clusteredLighting.setIntensity(
          wash.name,
          wash.intensity * lights[wash.driver] * this.lastDaylightAttenuation,
        );
        // Both returns checked, for the reason the pools check theirs: a
        // silent `IsLightSupported` refusal at construction is indistinguishable
        // from a wash correctly gated dark.
        if ((!washMoved || !washLit) && !this.castPoolWarned) {
          this.castPoolWarned = true;
          console.warn(
            `aircraft wash light "${wash.name}" is not in the clustered container `
            + "— it was refused at construction and will never light anything",
          );
        }
      }
    }
    this.updateCamera(state);
    this.cameraWorld.set(
      this.camera.position.x + this.originX,
      this.camera.position.y,
      this.camera.position.z + this.originZ,
    );
    this.atmosphere.update(this.camera.position);
    this.stars.update(this.camera.position);
    // OUTPUT size, not `getRenderWidth()`. See `StarFieldSystem.setOutputSize`:
    // the raster is scaled and then stretched to the canvas, so feeding the
    // raster made every sprite wider than its stated pixel count.
    this.stars.setOutputSize(this.domElement.clientWidth, this.domElement.clientHeight);
    this.lightPoints.setCameraPosition(this.camera.position);
    // Daylight suppression. The lamps carry a NIGHT calibration
    // (`AIRFIELD_LAMP_SCENE_SCALE`) applied unconditionally, so without this
    // they burn at full strength at solar noon — measured at 10,019 clipped
    // pixels on `runway-on-approach` against 56 in its baseline. The term is
    // exactly 1 at or below the horizon, so every night frame is unchanged by
    // construction rather than by measurement.
    const daylightAttenuation = airfieldLampDaylightAttenuation(
      this.environmentState.sun.direction[1],
      horizontalIlluminanceLux(this.environmentState),
    );
    this.lastDaylightAttenuation = daylightAttenuation;
    this.lightPoints.setDaylightAttenuation(daylightAttenuation);
    // `7-14`'s floods take the SAME law rather than a second one. They are a
    // different emission path — real point lights, not billboards — but "is the
    // airfield lit" is one question and two implementations of it would drift,
    // which is the failure the sun disc and the ocean already demonstrated.
    //
    // Through `setIntensity` and NOT `setEnabled`: `ClusteredLightContainer`
    // never reads `isEnabled`, so a disabled child stays in the cluster data and
    // keeps illuminating. Intensity is the only channel that reaches the shader.
    for (const name of this.hangarFloodNames) {
      this.clusteredLighting.setIntensity(name, HANGAR_FLOOD_INTENSITY * daylightAttenuation);
    }
    // The PAPI's indication, resolved analytically against the camera's WORLD
    // position — `camera.position` is origin-relative, and an elevation angle
    // taken against a rebased origin would swing by the origin every 4,096 m.
    // Only re-uploads when an indication actually flips: it is a step function
    // of elevation, so there is nothing between the states to interpolate.
    if (this.airfieldLighting?.update(
      this.camera.position.x + this.originX,
      this.camera.position.y,
      this.camera.position.z + this.originZ,
    )) {
      this.lightPoints.setColorRange(0, this.airfieldLighting.colourList());
    }
    // The home marina: its level of detail from the camera's world distance,
    // and its beacons on the simulation clock (capture-deterministic, as the
    // steam is). Its lamps take the airfield's daylight law with the draw.
    this.camera.getViewMatrix().multiplyToRef(this.camera.getProjectionMatrix(), this.marinaViewProjection);
    Frustum.GetPlanesToRef(this.marinaViewProjection, this.marinaFrustum);
    if (this.marina.update(
      this.camera.position.x + this.originX,
      this.camera.position.y,
      this.camera.position.z + this.originZ,
      state.simulationTime,
      this.marinaFrustum,
    )) {
      this.lightPoints.setColorRange(this.marinaLampStart, this.marina.lampColours);
    }
    // Spawned airfields: the same daylight law for their floods, their PAPIs
    // against the same world camera, and their construction inside its own
    // per-frame budget.
    this.spawnedAirfields?.setDaylightAttenuation(daylightAttenuation);
    this.spawnedAirfields?.update(
      this.camera.position.x + this.originX,
      this.camera.position.y,
      this.camera.position.z + this.originZ,
    );
    // OUTPUT size, for the reason on `LightPointSystem.setOutputSize`. The CSS
    // size is what `applyRenderScale` already reads for its own pixel cap, so
    // this is the same authority rather than a second one.
    this.lightPoints.setOutputSize(
      this.domElement.clientWidth,
      this.domElement.clientHeight,
    );
    // Volcanic steam follows the CAMERA: a cell check, a range check and a
    // clock write per frame; the vent query runs only on a 2 km cell change.
    // simulationTime keeps the plume capture-deterministic (Z-1).
    this.steam.update(this.cameraWorld.x, this.cameraWorld.z, state.simulationTime);
    this.boatSpray?.update(state);
    this.boatWake?.update(state);
    // On foot the car's effects read the parked car, not the walker.
    const carState = state.walking?.driven === "person" && state.walking.car ? state.walking.car : state;
    this.carParticles?.update(carState);
    this.carTracks?.update(carState);
    this.carBowWave?.update(carState);
    this.updateAerialPerspective();
  }

  /**
   * 7-2: the frame's rod/cone state. Every term is a pure function of the
   * environment the clock resolved — no framebuffer readback, so a captured
   * shot is reproducible (the 1A-4 rule that any animated state the capture
   * gates must be a function of pinned inputs).
   */
  /**
   * Give MSAA to whichever post-process is currently FIRST, and make every
   * pass behind it a single-sample consumer.
   *
   * `1B-11`'s rule is that the first post-process owns the offscreen scene
   * target and therefore its sample count. What is easy to miss -- and what
   * this method exists to stop anyone having to remember -- is that ownership
   * is DYNAMIC. `applyScotopicState` detaches rod vision in photopic daylight,
   * so the head of the chain changes with the time of day, and `7-5` added a
   * third candidate behind it. Written out by hand this was two branches in
   * two methods that had to agree; a third holder would have made it six.
   *
   * Derived from one place instead, so the invariant is stated once and the
   * next pass inserted into the chain extends this method rather than
   * discovering the rule from whichever site it happens to read.
   */
  private applyFirstPassOwnership(): void {
    const samples = firstPassSampleAssignment(
      this.profile.msaaSamples,
      this.scotopic.enabled,
      this.bloom.enabled,
    );
    this.scotopic.setSamples(samples.scotopic);
    this.bloom.setSamples(samples.bloom);
    this.toneMap.samples = samples.toneMap;
    // The chain HEAD hosts the scene render, so only the head's input RTT
    // carries a depth-stencil. Babylon re-establishes that invariant on
    // PostProcess.dispose() (its head-change branch calls markTextureDirty)
    // but NOT on camera.attach/detachPostProcess — the calls the runtime
    // scotopic/bloom toggles use — so across a head flip the engine's open
    // pass and its render bundles desync from the rebuilt RTTs. Measured on
    // the deterministic wobble repro (dusk crossing × a resolution step,
    // stock tier 1): "Attachment state of renderBundles[0] is not
    // compatible" kills the frame and GpuUncapturedErrorGuard then fails
    // every later render(); the format-COMPATIBLE variant of the same
    // desync composites one stale intermediate silently — the in-flight
    // "random colors slash through the terrain" report. Invalidate every
    // chain pass whenever membership or samples change, so the next frame
    // rebuilds all input RTTs against the new chain shape. Reached only
    // from real chain changes (toggle edges and profile application), never
    // per-frame.
    for (const pass of [
      this.scotopic.postProcess,
      this.bloom.bright,
      this.bloom.blurHorizontal,
      this.bloom.blurVertical,
      this.bloom.composite,
      this.toneMap,
      this.fxaa.postProcess,
      this.sharpen.postProcess,
    ]) {
      pass.markTextureDirty();
    }
  }

  private applyScotopicState(): void {
    const snapshot = this.atmosphere.snapshot;
    const adapted = snapshot.adaptedLuminanceCdM2;
    const rodFraction = rodFractionForAdaptedLuminance(adapted);
    const scotopicActive = shouldRunScotopicPass(rodFraction);
    if (scotopicActive !== this.scotopic.enabled) {
      // Toggle first, then derive ownership from the resulting chain. The
      // order matters: `applyFirstPassOwnership` reads `scotopic.enabled`.
      this.scotopic.setEnabled(this.camera, scotopicActive);
      this.applyFirstPassOwnership();
    }
    // The rod pathway's saturated response has to land somewhere sensible
    // AFTER the one exposure curve, so its display gain is that curve's
    // reciprocal times a mid-grey target. Computed here, on the CPU, so the
    // shader never multiplies an exposure (assertion 29).
    const exposure = exposureForState(this.environmentState, snapshot.moonIlluminanceLux);
    this.scotopic.setState({
      rodFraction,
      // σ is the SCENE's key, not the physical adapted luminance — see
      // ScotopicState. `adapted` still decides the rod FRACTION above, so
      // the perceptual call stays physical.
      adaptedLuminanceCdM2: snapshot.sceneKeyLuminanceCdM2,
      sceneToNits: SCENE_UNIT_TO_NITS,
      displayGain: SCOTOPIC_MID_GREY_TARGET / Math.max(exposure, 1e-3),
    });
  }

  /**
   * 1C-4: resolve the one haze binding for this frame (absolute camera
   * altitude, current environment) and fan it out — the PBR registry covers
   * terrain, vegetation, wildlife, aircraft and airport; the three
   * ShaderMaterial consumers receive the same binding by hand.
   */
  private updateAerialPerspective(): void {
    const snapshot = this.atmosphere.snapshot;
    this.aerialReceivers.setProjection({
      state: this.environmentState,
      cameraAltitudeMeters: this.cameraWorld.y,
      sunColor: [snapshot.sunColor.r, snapshot.sunColor.g, snapshot.sunColor.b],
      skyHorizonColor: [snapshot.skyHorizon.r, snapshot.skyHorizon.g, snapshot.skyHorizon.b],
      sunIlluminanceNormalized: snapshot.sunIlluminanceNormalized,
      // NIGHT_LOOK_ARCHITECTURE 2.1: below twilight the aerial integral runs
      // on the moon, so sky and night haze stay one system (1C-5 at night).
      moonDirection: [
        snapshot.moonDirection.x,
        snapshot.moonDirection.y,
        snapshot.moonDirection.z,
      ],
      moonIlluminanceNormalizedToFull:
        snapshot.moonIlluminanceLux / FULL_MOON_ILLUMINANCE_LUX,
    }, this.originX, this.originZ);
    const binding = this.aerialReceivers.currentBinding;
    if (!binding) return;
    this.atmosphere.setAerialPerspective(binding);
    this.ocean.setAerialPerspective(binding);
    this.hydrology.setAerialPerspective(binding);
    this.clouds.setAerialPerspective(binding);
    this.lightPoints.setAerialPerspective(binding);
    this.steam.setAerialPerspective(binding);
    this.boatSpray?.setAerialPerspective(binding);
    this.boatWake?.setAerialPerspective(binding);
    this.carParticles?.setAerialPerspective(binding);
    this.carBowWave?.setAerialPerspective(binding);
    this.refreshSkyProbe(binding);
  }

  /**
   * The probe re-lights the world when the environment changes or when the
   * camera's altitude has drifted enough to matter (the sky itself dims and
   * clears with height); everything else leaves it untouched.
   *
   * B6: in one frame, the whole irradiance bake (6 x 16 x 16 sky-radiance
   * evaluations and Babylon's converter), the cloud ambient LUT and the six
   * specular faces with their mips made every 500 m of a climb a single-frame
   * spike. A drift re-light is now sampled at most
   * `SKY_REBAKE_MILLISECONDS_PER_FRAME` a frame from a snapshot of the
   * binding it began on, and lands one output a frame: the irradiance on the
   * frame after the last sample, the specular cube's re-render on the next,
   * and the cloud ambient LUT, from the same snapshot, on the one after. The
   * landing frame still runs Babylon's converter in one call (1.5 ms on the
   * SwiftShader perf host), which is the floor on that frame. An environment
   * change, and every re-light of a synchronous renderer, still runs in the
   * frame that asks (`skyProbeRefreshAction`), and a landing's LUT still to
   * come is dropped.
   *
   * A teleport re-lights in the frame that asks too: a spawn reset or a crash
   * restart moves the camera past the drift threshold between two frames,
   * which no flight can. Sliced, the new place would keep the old altitude's
   * lighting for the frames the rebake takes and then step, after the camera
   * cut has cleared the history that would have hidden it. cutCamera cannot
   * ask for it: the simulation's reset reaches the renderer frames after the
   * cut.
   */
  private refreshSkyProbe(binding: AerialPerspectiveBinding): void {
    const altitude = binding.cameraAltitudeMeters;
    const teleported = Math.abs(altitude - this.skyProbeCameraAltitudeMeters)
      > SKY_PROBE_REBAKE_ALTITUDE_METERS;
    this.skyProbeCameraAltitudeMeters = altitude;
    const action = skyProbeRefreshAction({
      stale: this.skyProbeStale,
      altitudeDeltaMeters: altitude - this.skyProbeAltitudeMeters,
      inProgress: this.skyProbe.rebakeInProgress,
      synchronous: this.skyRebakeSynchronous || teleported,
    });
    if (
      action === "none"
      && !this.skyProbeRearmPending
      && this.skyAmbientLutPending === null
    ) return;
    const started = performance.now();
    if (this.skyProbeRearmPending) {
      this.skyProbeRearmPending = false;
      this.skyProbe.rearmSpecular();
    } else if (this.skyAmbientLutPending !== null && action !== "sync") {
      this.atmosphereResources.update(this.skyAmbientLutPending);
      this.skyAmbientLutPending = null;
    }
    if (action === "sync") {
      // R-26: the below-horizon half of the SH bake is the ground's own
      // albedo now, not a hardcoded 0.25 floor. A rebake in flight is
      // dropped: it sampled an older environment.
      this.skyProbe.update(binding, this.atmosphere.surfaceAlbedoLuminance);
      // 2-0a: the cloud ambient LUT re-bakes on the same cadence, from the
      // same binding, so cloud ambient cannot drift from the sky/IBL pair.
      // A landing's LUT still to come is older: it must not follow this one.
      this.atmosphereResources.update(binding);
      this.skyAmbientLutPending = null;
      this.skyProbeStale = false;
      this.skyProbeAltitudeMeters = binding.cameraAltitudeMeters;
      this.skyRebakeSampled = false;
    } else if (action === "begin") {
      this.skyProbe.beginRebake(binding, this.atmosphere.surfaceAlbedoLuminance);
      this.skyRebakeSampled = this.skyProbe.advanceRebake(SKY_REBAKE_MILLISECONDS_PER_FRAME);
    } else if (action === "advance" && !this.skyRebakeSampled) {
      this.skyRebakeSampled = this.skyProbe.advanceRebake(SKY_REBAKE_MILLISECONDS_PER_FRAME);
    } else if (action === "advance") {
      // The snapshot the rebake sampled, read before the next begin replaces
      // it: the LUT and the drift threshold take the environment the
      // irradiance has, as they took the binding in one frame.
      const baked = this.skyProbe.rebakeBinding!;
      this.skyProbe.applyRebakeIrradiance();
      this.skyProbeAltitudeMeters = baked.cameraAltitudeMeters;
      this.skyRebakeSampled = false;
      this.skyProbeRearmPending = true;
      this.skyAmbientLutPending = baked;
    }
    const spent = performance.now() - started;
    this.skyRefreshLastMilliseconds = spent;
    this.skyRefreshMaxMilliseconds = Math.max(this.skyRefreshMaxMilliseconds, spent);
    this.skyRefreshFrameIndex = this.frameIndex;
  }

  /**
   * Swap which visual is on screen when the state's class changes: a surface
   * vehicle's payload puts the boat up and the aircraft away, and its absence
   * the reverse. A session without a surface vehicle never gets past the
   * first comparison, so every aircraft frame is exactly what it was.
   */
  private syncActiveVehicle(state: FlightVisualState): void {
    const active = this.surfaceVehicle !== null && state.vehicle != null;
    if (active === this.surfaceActive) return;
    this.surfaceActive = active;
    const cockpit = this.cameraMode === "cockpit";
    this.aircraft.root.setEnabled(
      !active
      && !this.viewerMode
      && !(cockpit && !cockpitRigDrawsAircraft(this.cockpitRigOverride)),
    );
    this.surfaceVehicle?.root.setEnabled(active && !this.viewerMode);
    this.surfaceVehicle?.setCockpitView(cockpit);
    this.carCockpitView = cockpit;
    // The sea fills the hull's footprint again while the boat is away.
    if (!active) this.boatHullClip?.clearPose();
    // A different vehicle somewhere else: the rig's offsets and the frame
    // graph's history both belong to the one that was there before.
    this.cutCamera();
  }

  /**
   * The surface vehicle's pose and lamps, and the aircraft's own lights put
   * out: its cast pools and washes live in the clustered container whoever
   * is on screen, and a boat at the dock must not be lit by an aeroplane that
   * is not there. The boat's sidelight washes take over the aircraft's two
   * nav-wash slots (`boatWashLights` has why); every other slot goes dark.
   */
  /**
   * The state everything that presents the frame reads. A boat rides the sea
   * twin's every cascade; on a tier that draws fewer it is drawn lowered by
   * the swell the tier leaves out (`UndrawnSeaHeave`), so its hull, spray,
   * hull clip and the camera that follows it sit on the sea on screen.
   */
  private presentedState(state: FlightVisualState): FlightVisualState {
    const heave = this.boatHeave;
    if (!heave?.active || state.vehicle?.kind !== "boat") return state;
    const { x, y, z, w } = state.orientation;
    // The bow's heading, forward = (sin h, cos h): body +X turned by the orientation.
    const heading = Math.atan2(1 - 2 * (y * y + z * z), 2 * (x * z - w * y));
    const lowered = heave.heaveAt(state.position.x, state.position.z, heading, state.simulationTime);
    if (lowered === 0) return state;
    return { ...state, position: { x: state.position.x, y: state.position.y - lowered, z: state.position.z } };
  }

  private poseSurfaceVehicle(
    state: FlightVisualState,
    visual: VehicleVisual,
    bodyQuaternion: Quaternion,
    bodyMatrix: Matrix,
  ): void {
    visual.root.position.set(
      state.position.x - this.originX,
      state.position.y,
      state.position.z - this.originZ,
    );
    visual.root.rotationQuaternion?.copyFrom(bodyQuaternion);
    this.boatHullClip?.setPose(visual.root.position, bodyQuaternion);
    visual.update(state, this.currentDeltaSeconds);
    if (state.vehicle?.kind !== "boat") {
      this.poseCarLights(state, bodyMatrix);
      return;
    }
    // The boat's lamp law, from the observer's bearing as the aircraft's is.
    const toCamera = this.camera.position.subtract(visual.root.position);
    const bodyForward = Vector3.TransformNormal(Vector3.Right(), this.bodyMatrix);
    const bodyUp = Vector3.TransformNormal(Vector3.Up(), this.bodyMatrix);
    const bodyStarboard = Vector3.TransformNormal(Vector3.Forward(true), this.bodyMatrix);
    const lights = resolveBoatLights({
      observerAzimuthDegrees: observerAzimuthDegrees(
        Vector3.Dot(toCamera, bodyForward),
        Vector3.Dot(toCamera, bodyStarboard),
      ),
      sunElevationSine: this.environmentState.sun.direction[1],
      horizontalLux: horizontalIlluminanceLux(this.environmentState),
    });
    visual.setLightState(lights);
    for (const pool of AIRCRAFT_CAST_POOLS) this.clusteredLighting.setIntensity(pool.name, 0);
    for (const slot of aircraftWashLights(this.aircraftKind)) {
      const wash = this.surfaceVehicleWashes.find((candidate) => candidate.driver === slot.driver);
      if (!wash) {
        this.clusteredLighting.setIntensity(slot.name, 0);
        continue;
      }
      const at = castPoolWorldPosition(
        [state.position.x, state.position.y, state.position.z],
        [bodyForward.x, bodyForward.y, bodyForward.z],
        [bodyUp.x, bodyUp.y, bodyUp.z],
        [bodyStarboard.x, bodyStarboard.y, bodyStarboard.z],
        wash.offset,
      );
      this.clusteredLighting.setPosition(slot.name, at[0], at[1], at[2]);
      this.clusteredLighting.setIntensity(
        slot.name,
        wash.intensity * lights[wash.driver] * this.lastDaylightAttenuation,
      );
    }
  }

  /**
   * The car's lamps follow its own switches (the visual reads them from the
   * payload); the scene gives only the panel glow. Its headlamp pools take
   * over the aircraft's two cast-pool slots, dipped on the taxi pool's and
   * main beam on the landing pool's (`CAR_HEADLAMP_POOLS` has why), under the
   * daylight attenuation every pool takes; the washes go dark.
   */
  private poseCarLights(state: FlightVisualState, bodyMatrix: Matrix): void {
    const car = state.vehicle?.kind === "car" ? state.vehicle : null;
    this.surfaceVehicle?.setLightState({
      portNav: 0,
      starboardNav: 0,
      tailNav: 0,
      beacon: 0,
      strobe: 0,
      landing: 0,
      cockpitGlow: cockpitInstrumentGlow(this.environmentState.sun.direction[1], horizontalIlluminanceLux(this.environmentState)),
    });
    const lamps = carLampState(car);
    const bodyForward = Vector3.TransformNormal(Vector3.Right(), bodyMatrix);
    const bodyUp = Vector3.TransformNormal(Vector3.Up(), bodyMatrix);
    const bodyStarboard = Vector3.TransformNormal(Vector3.Forward(true), bodyMatrix);
    for (const pool of AIRCRAFT_CAST_POOLS) {
      const beam = CAR_HEADLAMP_POOLS.find((candidate) => candidate.slot === pool.name);
      const intensity = beam ? carPoolIntensity(beam, lamps, this.lastDaylightAttenuation) : 0;
      if (beam && intensity > 0) {
        const at = castPoolWorldPosition(
          [state.position.x, state.position.y, state.position.z],
          [bodyForward.x, bodyForward.y, bodyForward.z],
          [bodyUp.x, bodyUp.y, bodyUp.z],
          [bodyStarboard.x, bodyStarboard.y, bodyStarboard.z],
          beam.offset,
        );
        this.clusteredLighting.setPosition(pool.name, at[0], at[1], at[2]);
      }
      this.clusteredLighting.setIntensity(pool.name, intensity);
    }
    for (const slot of aircraftWashLights(this.aircraftKind)) this.clusteredLighting.setIntensity(slot.name, 0);
  }

  /**
   * The walker's figure: on foot at the person's pose, while getting in or
   * out and while driving at the driver's seat of the drawn car (the figure
   * plays door to seat from the boarding progress). Hidden outside a walking
   * session, in the viewer, and from the driver's own eye.
   */
  private posePerson(state: FlightVisualState): void {
    const person = this.person;
    if (!person) return;
    const walking = state.walking ?? null;
    const onFoot = state.vehicle?.kind === "person" ? state.vehicle : null;
    const seated = walking?.driven === "car" && state.vehicle?.kind === "car";
    const driven = walking?.driven ?? null;
    if (driven !== this.lastWalkingDriven) {
      // Getting in or out changes what the camera follows: cut, and stand behind the walker.
      if (this.lastWalkingDriven !== null) this.cutCamera();
      if (onFoot) this.characterCamera.reset((state.heading * Math.PI) / 180);
      this.lastWalkingDriven = driven;
    }
    const cockpit = this.cameraMode === "cockpit";
    const visible = !this.viewerMode && walking !== null && (onFoot !== null || seated) && !(seated && cockpit);
    if (visible !== this.personEnabled) {
      this.personEnabled = visible;
      person.root.setEnabled(visible);
    }
    if (!visible) {
      this.lastFootPose.valid = false;
      return;
    }
    const ground = this.walkerGround;
    if (ground && Math.floor(state.simulationTime / 4) !== Math.floor((state.simulationTime - this.currentDeltaSeconds) / 4)) {
      // The analytic ground follows the streamed roads' earthworks: refresh now and then.
      ground.clear();
    }
    const animation = this.personAnimation;
    const heading = (state.heading * Math.PI) / 180;
    const carRoot = this.surfaceVehicle?.root ?? null;
    const boarding = onFoot?.mode === "board" ? onFoot.boarding : null;
    if (onFoot && !boarding) {
      person.root.position.set(state.position.x - this.originX, state.position.y, state.position.z - this.originZ);
      person.root.rotationQuaternion?.copyFrom(this.bodyQuaternion);
      animation.person = onFoot;
      animation.velocityX = state.velocity.x;
      animation.velocityY = state.velocity.y;
      animation.velocityZ = state.velocity.z;
      // The sim's yaw rate is about body +Y, positive turning left.
      animation.turnRate = -state.angularVelocity.y;
      animation.steeringWheel = 0;
      animation.boardingFrom = null;
      animation.boardingDoor = 0;
      this.boardingFrom = null;
      const feetX = state.position.x;
      const feetY = state.position.y;
      const feetZ = state.position.z;
      const sine = Math.sin(heading);
      const cosine = Math.cos(heading);
      animation.groundOffset = ground
        ? (forward, right) => ground.sample(feetX + forward * sine - right * cosine, feetZ + forward * cosine + right * sine) - feetY
        : () => 0;
      this.lastFootPose.x = feetX;
      this.lastFootPose.y = feetY;
      this.lastFootPose.z = feetZ;
      this.lastFootPose.heading = heading;
      this.lastFootPose.valid = true;
    } else if (carRoot?.rotationQuaternion) {
      const carQuaternion = carRoot.rotationQuaternion;
      const hip = CAR_SEATING.driverHip;
      this.seatScratch.set(hip.forward, hip.up, hip.right);
      this.seatScratch.rotateByQuaternionToRef(carQuaternion, this.seatPosition);
      person.root.position.copyFrom(carRoot.position).addInPlace(this.seatPosition);
      person.root.rotationQuaternion?.copyFrom(carQuaternion);
      if (boarding && boarding.action === "getIn" && !this.boardingFrom && this.lastFootPose.valid) {
        // Where the walker stood, in the seat frame: the figure walks from there to the door.
        this.seatScratch.set(
          this.lastFootPose.x - this.originX - person.root.position.x,
          this.lastFootPose.y - person.root.position.y,
          this.lastFootPose.z - this.originZ - person.root.position.z,
        );
        const inverse = Quaternion.Inverse(carQuaternion);
        this.seatScratch.rotateByQuaternionToRef(inverse, this.seatPosition);
        const carHeading = Math.atan2(
          1 - 2 * (carQuaternion.y * carQuaternion.y + carQuaternion.z * carQuaternion.z),
          2 * (carQuaternion.x * carQuaternion.z - carQuaternion.w * carQuaternion.y),
        );
        this.boardingFrom = {
          forward: this.seatPosition.x,
          up: this.seatPosition.y,
          right: this.seatPosition.z,
          // Positive turned right: headings grow turning left.
          facing: Math.atan2(Math.sin(carHeading - this.lastFootPose.heading), Math.cos(carHeading - this.lastFootPose.heading)),
        };
      }
      if (!boarding) this.boardingFrom = null;
      animation.person = onFoot ?? this.seatedPerson;
      animation.velocityX = 0;
      animation.velocityY = 0;
      animation.velocityZ = 0;
      animation.turnRate = 0;
      animation.steeringWheel = state.vehicle?.kind === "car" ? state.vehicle.steeringWheel : 0;
      animation.boardingFrom = this.boardingFrom;
      // The door the walker uses, as open as the car draws it.
      const doors = state.walking?.doors;
      animation.boardingDoor = boarding && doors ? doors[boarding.side === "right" ? 0 : 1] : 0;
      animation.groundOffset = () => 0;
      this.lastFootPose.valid = false;
    }
    animation.lookYaw = onFoot
      ? Math.atan2(Math.sin(heading - this.characterCamera.heading), Math.cos(heading - this.characterCamera.heading))
      : 0;
    animation.lookPitch = onFoot ? this.characterCamera.pitch : 0;
    person.setFirstPersonView(cockpit);
    const output = person.update(animation as PersonAnimationInput, this.currentDeltaSeconds);
    if (output.footStrikes > 0) {
      this.footsteps.count += output.footStrikes;
      this.footsteps.strength = Math.max(this.footsteps.strength, output.strikeStrength);
    }
  }

  /**
   * The character camera, on foot in the chase and cockpit views: the orbit
   * and first person, driven directly (no rig lag) so mouse look never trails.
   * The exterior rig's offsets are kept in step for the next view.
   */
  private updateCharacterCamera(state: FlightVisualState): void {
    const ground = this.walkerGround;
    const obstacles: CameraObstacleBox[] = [];
    const parked = state.walking?.car;
    if (parked) {
      const box = CAR_SEATING.bodyBox;
      const q = parked.orientation;
      this.seatScratch.set(box.center.x, box.center.y, box.center.z);
      this.vehicleQuaternion.set(q.x, q.y, q.z, q.w);
      this.seatScratch.rotateByQuaternionToRef(this.vehicleQuaternion, this.seatPosition);
      const obstacle = this.parkedCarObstacle;
      obstacle.centerX = parked.position.x - this.originX + this.seatPosition.x;
      obstacle.centerY = parked.position.y + this.seatPosition.y;
      obstacle.centerZ = parked.position.z - this.originZ + this.seatPosition.z;
      obstacle.halfX = box.halfExtents.x;
      obstacle.halfY = box.halfExtents.y;
      obstacle.halfZ = box.halfExtents.z;
      obstacle.qx = q.x;
      obstacle.qy = q.y;
      obstacle.qz = q.z;
      obstacle.qw = q.w;
      obstacles.push(obstacle);
    }
    const originX = this.originX;
    const originZ = this.originZ;
    const look = this.characterLook;
    const underwater = this.underwater;
    const water = underwater ? this.characterWater : null;
    if (underwater && water) {
      this.characterWaterTime = state.simulationTime;
      const head = underwater.cameraWater.sample(
        state.position.x,
        state.position.y + PERSON.eyeHeight,
        state.position.z,
        state.simulationTime,
        this.characterWaterSample,
      );
      if (head.kind === "none") water.below = false;
      else if (head.depth > head.clearance) water.below = true;
      else if (head.depth < -head.clearance) water.below = false;
    }
    const pose = this.characterCamera.update({
      feetX: state.position.x - originX,
      feetY: state.position.y,
      feetZ: state.position.z - originZ,
      facing: (state.heading * Math.PI) / 180,
      lookYaw: look.yaw,
      lookPitch: look.pitch,
      zoom: look.zoom,
      deltaSeconds: this.currentDeltaSeconds,
      firstPerson: this.cameraMode === "cockpit",
      groundHeight: ground
        ? (x, z) => ground.sample(x + originX, z + originZ)
        : (x, z) => this.cameraTerrainHeight(x + originX, z + originZ),
      water,
      obstacles,
    });
    look.yaw = 0;
    look.pitch = 0;
    look.zoom = 0;
    this.camera.position.set(pose.eyeX, pose.eyeY, pose.eyeZ);
    this.cameraTarget.set(pose.targetX, pose.targetY, pose.targetZ);
    this.camera.upVector.set(0, 1, 0);
    this.camera.setTarget(this.cameraTarget);
    this.camera.fov = (pose.fieldOfView * Math.PI) / 180;
    const followed = this.person?.root.position;
    if (followed) {
      this.cameraOffset.copyFrom(this.camera.position).subtractInPlace(followed);
      this.cameraTargetOffset.copyFrom(this.cameraTarget).subtractInPlace(followed);
    }
    this.person?.setFade(this.cameraMode === "cockpit" ? 0 : pose.fade);
    this.previousAircraftPositionValid = false;
  }

  private updateCamera(state: FlightVisualState): void {
    const walker = this.person !== null && state.vehicle?.kind === "person" ? state.vehicle : null;
    if (walker && (this.cameraMode === "chase" || this.cameraMode === "cockpit")) {
      this.updateCharacterCamera(state);
      return;
    }
    this.person?.setFade(0);
    const followed = this.surfaceActive && this.surfaceVehicle ? this.surfaceVehicle : this.aircraft;
    // On foot the cinematic, top and front views frame the walker.
    const aircraftPosition = walker && this.person ? this.person.root.position : followed.root.position;
    const framing: Pick<VehicleSpec, "cinematic" | "topFront" | "cockpitEye"> = walker
      ? PERSON_VIEW_FRAMING
      : this.surfaceActive && this.surfaceVehicleSpec
        ? this.surfaceVehicleSpec
        : aircraftSpec(this.aircraft.kind);
    // A boat's exterior views follow its HEADING: the hull pitches several
    // degrees over the hump and rolls in every wave, and a rig that took either
    // would bob the whole frame with it. The helm view stays attached. For an
    // aircraft both are the body axes, the very same vectors as before.
    const levelFollow = this.surfaceActive && this.cameraMode !== "cockpit";
    let rigForward = this.forward;
    let rigUp = this.up;
    if (levelFollow) {
      const horizontal = Math.hypot(this.forward.x, this.forward.z);
      if (horizontal > 1e-4) {
        this.surfaceRigForward.set(this.forward.x / horizontal, 0, this.forward.z / horizontal);
      }
      rigForward = this.surfaceRigForward;
      rigUp = this.surfaceRigUp;
    }
    let fieldOfView = 62;
    // One vertical reference for the whole rig. The exterior views adopt only
    // part of the aircraft's bank (`cameraBankFollow`), and the camera's own
    // up vector already honoured that while its POSITION and aim point did
    // not — which slid the airframe sideways in frame by 0.155% of the width
    // per degree of bank. Building every offset on the same blended vertical
    // removes that exactly, and because the blend starts from wings-level
    // rather than from world up, an unbanked frame is untouched at any pitch.
    cameraRigLiftToRef(
      rigForward,
      rigUp,
      cameraBankFollow(this.cameraMode, this.reducedMotion),
      this.cameraRigLift,
    );
    // How fast the aeroplane is ACTUALLY moving through the scene, which is
    // what the chase trail is derived from. A rebase frame moves every
    // coordinate at once, so the delta across it is meaningless and the
    // previous value is held instead. B2: the distance is between two
    // simulation poses, so it is divided by the simulation time between them
    // where that is not the frame's own delta (a hitch past the 0.1 s clamp,
    // a late snapshot); a steady frame divides as it always did.
    if (this.previousAircraftPositionValid && !this.originShifted) {
      const next = nextObservedGroundSpeed({
        travelled: Vector3.Distance(aircraftPosition, this.previousAircraftPosition),
        wallDeltaSeconds: this.currentDeltaSeconds,
        simDeltaSeconds: state.simulationTime - this.previousSimulationTime,
        previous: this.observedGroundSpeed,
        heldFrames: this.observedGroundSpeedHeldFrames,
        // A pinned (perf) renderer re-renders a shot's last state with no
        // simulation time passing; that frame must read as it always did.
        holdWhenFrozen: this.pinnedRenderScale === null,
      });
      this.observedGroundSpeed = next.speed;
      this.observedGroundSpeedHeldFrames = next.heldFrames;
    } else if (!this.previousAircraftPositionValid) {
      this.observedGroundSpeed = 0;
      this.observedGroundSpeedHeldFrames = 0;
    }
    this.previousAircraftPosition.copyFrom(aircraftPosition);
    this.previousSimulationTime = state.simulationTime;
    this.previousAircraftPositionValid = true;
    if (this.cameraMode === "freefly") {
      // The synthetic viewer state's position IS the camera; its orientation
      // already produced this.forward/this.up in updatePresentation. The rig
      // is direct (response 1, bank follow 0) so mouse-look never lags.
      this.desiredCamera.set(
        state.position.x - this.originX,
        state.position.y,
        state.position.z - this.originZ,
      );
      this.desiredCameraTarget.copyFrom(this.desiredCamera)
        .addInPlace(this.forward.scale(200));
    } else if (this.cameraMode === "cockpit") {
      const eye = framing.cockpitEye;
      // The eye is where the pilot's head is — in the LEFT seat where there
      // are two — and the aim point carries the same offset, so the view stays
      // parallel to the body axis. Both are built by one pure function so a
      // test can hold them to it (`cockpitRigPositionsToRef`).
      cockpitRigPositionsToRef(
        aircraftPosition,
        this.forward,
        this.up,
        cockpitEyeForwardUpMetres(eye, this.cockpitRigOverride),
        cockpitEyeRightMeters(eye, this.cockpitRigOverride),
        COCKPIT_AIM_DISTANCE_METERS,
        this.desiredCamera,
        this.desiredCameraTarget,
      );
      // 75 degrees horizontal, wider than chase. The lens is a property of
      // WHAT IS BEING LOOKED THROUGH: a cockpit is close enough to its own
      // frame, panel and sill that a 56 degree telephoto (the old value, and
      // "narrower than chase, as a cockpit must be") could not fit any of
      // them in view. Perf capture keeps 56 through the override. Wider
      // than 16:9 the gameplay lens holds its 16:9 vertical field instead,
      // so a wide window adds width rather than cropping the panel.
      fieldOfView = cockpitHorizontalFieldOfViewForAspect(
        this.cockpitRigOverride,
        this.windowAspectRatio(),
      );
    } else if (this.cameraMode === "cinematic") {
      const angle = state.simulationTime * 0.075;
      const orbit = framing.cinematic;
      this.desiredCamera.copyFrom(aircraftPosition).addInPlaceFromFloats(
        Math.cos(angle) * orbit.radiusMeters,
        orbit.heightMeters + Math.sin(angle * 0.7) * orbit.heightDriftMeters,
        Math.sin(angle) * orbit.radiusMeters,
      );
      this.desiredCameraTarget.copyFrom(aircraftPosition)
        .addInPlace(this.cameraRigLift.scale(1.3));
      if (this.surfaceActive) {
        // The orbit circles a boat at the dock as readily as one at sea, so
        // it keeps clear of the quay, the shore and the water.
        const orbitFloor = Math.max(
          this.seaLevel,
          this.cameraTerrainHeight(
            this.desiredCamera.x + this.originX,
            this.desiredCamera.z + this.originZ,
          ),
        ) + 1.5;
        if (this.desiredCamera.y < orbitFloor) this.desiredCamera.y = orbitFloor;
      }
      fieldOfView = 58;
    } else if (this.cameraMode === "top" || this.cameraMode === "front") {
      // Both aim at the built airframe's centre from a measured distance
      // (`TopFrontViewSpec`): straight down on its plan, or back at its nose.
      // Neither can sit below the aeroplane, so neither samples the terrain;
      // both write into the rig's own vectors, so neither allocates.
      const topFront = framing.topFront;
      if (this.cameraMode === "top") {
        topViewRigOffsetsToRef(
          rigForward,
          rigUp,
          this.cameraRigLift,
          topFront,
          this.desiredCamera,
          this.desiredCameraTarget,
        );
        fieldOfView = TOP_VIEW_FIELD_OF_VIEW_DEGREES;
      } else {
        frontViewRigOffsetsToRef(
          rigForward,
          rigUp,
          this.cameraRigLift,
          topFront,
          this.desiredCamera,
          this.desiredCameraTarget,
        );
        fieldOfView = FRONT_VIEW_FIELD_OF_VIEW_DEGREES;
      }
      this.desiredCamera.addInPlace(aircraftPosition);
      this.desiredCameraTarget.addInPlace(aircraftPosition);
    } else {
      const profile = chaseCameraProfile(followed.kind, state.airspeed);
      // The trail the old absolute-position smoothing used to produce as a
      // lag, now asked for explicitly and along the NOSE rather than along the
      // ground track: the settled framing players know is preserved, without
      // a crosswind pushing the airframe sideways out of frame. See
      // `cameraTrailMeters`.
      const trail = cameraTrailMeters(
        this.cameraMode,
        this.reducedMotion,
        this.observedGroundSpeed,
      );
      // The height drops toward the aircraft's level in a bank, and only in a
      // bank: wings level it is `profile.height` exactly. The blended lift above
      // keeps a banked airframe centred; this keeps it from sinking in frame.
      // See `CHASE_BANK_HEIGHT_DROP`.
      chaseRigOffsetsToRef(
        rigForward,
        this.cameraRigLift,
        profile.distance,
        chaseRigHeightForBank(profile.height, rigForward, rigUp),
        profile.aimAhead,
        CHASE_AIM_HEIGHT_METERS,
        trail,
        this.desiredCamera,
        this.desiredCameraTarget,
      );
      this.desiredCamera.addInPlace(aircraftPosition);
      // The chase rig trails the aircraft by up to 22 m and is not collided,
      // so a pitched-up pass near the ground can otherwise place the camera
      // under the terrain. Clamp the desired position above the surface for
      // both aircraft; the shared response smooths the ride over it.
      // Ground clamp, de-kinked: sample under the camera AND along its path
      // ~0.35 s ahead, clamping against the higher of the two. The single
      // instantaneous max produced a rate discontinuity at every sharp ridge
      // — the camera surged up at the face and dropped off the crest — which
      // at speed read as a vertical jerk. The look-ahead starts the rise
      // early and releases it gradually; the shared exponential response
      // does the rest.
      const cameraWorldX = this.desiredCamera.x + this.originX;
      const cameraWorldZ = this.desiredCamera.z + this.originZ;
      const aheadMeters = Math.min(120, state.airspeed * 0.35);
      const cameraGround = Math.max(
        this.cameraTerrainHeight(cameraWorldX, cameraWorldZ),
        this.cameraTerrainHeight(
          cameraWorldX + rigForward.x * aheadMeters,
          cameraWorldZ + rigForward.z * aheadMeters,
        ),
      );
      // A boat's rig floats over the sea, which the terrain sample (the
      // seabed) knows nothing about.
      const cameraFloor = this.surfaceActive ? Math.max(cameraGround, this.seaLevel) : cameraGround;
      if (this.desiredCamera.y < cameraFloor + 2.5) {
        this.desiredCamera.y = cameraFloor + 2.5;
      }
      // Both offsets were produced together above, so the aim point already
      // carries the same trail the camera does and the view direction is
      // exactly what it was before the trail became explicit.
      this.desiredCameraTarget.addInPlace(aircraftPosition);
      fieldOfView = profile.fieldOfView;
    }
    const response = cameraPresentationResponse(
      this.cameraMode,
      this.cameraCut,
      this.currentDeltaSeconds,
      this.reducedMotion,
    );
    // Smoothed in the AIRCRAFT's frame, not the world's. A first-order lag
    // chasing an absolute position that is itself translating at flight speed
    // never converges — it settles `speed * tau` behind, which measured 7.1 m
    // on the trainer and 16 m on the jet, and left the airframe off-centre for
    // seconds after every turn. Smoothing the offset instead has no such
    // steady-state error, so the rig damps ROTATION and manoeuvre (which is
    // the life in the view) without dragging on straight flight.
    //
    // The offsets are STATE, deliberately. Re-deriving them from the camera's
    // absolute position each frame reintroduces exactly the error this
    // removes: the stored position is a frame behind the aircraft, so the
    // implied offset arrives already short by one frame of travel and the
    // filter settles `((1-r)/r) * speed * dt` — the same `speed * tau` — away
    // from the offset asked for. Measured at 29.4 m instead of 20.9 m before
    // this was made persistent.
    this.desiredCamera.subtractInPlace(aircraftPosition);
    this.desiredCameraTarget.subtractInPlace(aircraftPosition);
    smoothCameraVectorToRef(
      this.cameraOffset,
      this.desiredCamera,
      response,
      this.cameraOffset,
    );
    smoothCameraVectorToRef(
      this.cameraTargetOffset,
      this.desiredCameraTarget,
      response,
      this.cameraTargetOffset,
    );
    this.camera.position.copyFrom(aircraftPosition).addInPlace(this.cameraOffset);
    this.cameraTarget.copyFrom(aircraftPosition).addInPlace(this.cameraTargetOffset);
    // Exterior views communicate a turn without attaching the horizon to
    // every physics/interpolation correction. This restores the restrained
    // 18% chase / 30% cinematic bank used by the playable renderer; cockpit
    // remains physically attached and reduced-motion exterior views stay level.
    if (this.cameraMode === "top") {
      // The top view looks along world up, so it asks for the nose instead:
      // the aeroplane points up the screen.
      topViewCameraUpToRef(rigForward, this.desiredCameraUp);
    } else {
      Vector3.LerpToRef(
        Vector3.UpReadOnly,
        rigUp,
        cameraBankFollow(this.cameraMode, this.reducedMotion),
        this.desiredCameraUp,
      );
      this.desiredCameraUp.normalize();
    }
    smoothCameraVectorToRef(
      this.camera.upVector,
      this.desiredCameraUp,
      response,
      this.camera.upVector,
    );
    this.cameraTarget.subtractToRef(this.camera.position, this.cameraViewDirection);
    orthogonalizeCameraUpToRef(
      this.camera.upVector,
      this.cameraViewDirection,
      rigUp,
      this.camera.upVector,
    );
    this.camera.setTarget(this.cameraTarget);
    this.camera.fov += (fieldOfView * Math.PI / 180 - this.camera.fov) * response;
  }

  /**
   * The window's shape as the player sees it: the canvas's CSS size, which is
   * what the HUD's stylesheet reads too. Not the render raster: its rounding
   * under a fractional render scale put a 2560 x 1080 window a hair wider than
   * that (the cockpit lens measured 91.325 degrees against 91.309), and it could
   * equally put a 16:9 window past 16:9 and move the 75 degree lens there.
   */
  private windowAspectRatio(): number {
    const canvas = this.engine.getRenderingCanvas();
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      return canvas.clientWidth / canvas.clientHeight;
    }
    return this.engine.getAspectRatio(this.camera);
  }

  /**
   * `viewportHeightPixels / (2 * tan(verticalFov / 2))`.
   *
   * Recomputed per frame rather than cached: it moves with the render scale,
   * the display, and the camera's own field-of-view response to airspeed, and
   * a stale value would make the quadtree split against a viewport that is no
   * longer on screen.
   */
  private terrainPixelsPerMeter(): number {
    const height = Math.max(1, this.engine.getRenderHeight());
    const width = Math.max(1, this.engine.getRenderWidth());
    const verticalFov = this.camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
      ? 2 * Math.atan(Math.tan(this.camera.fov / 2) * (height / width))
      : this.camera.fov;
    return height / (2 * Math.tan(Math.max(0.05, verticalFov) / 2));
  }

  /** Before the terrain updates: a change installed now reaches every bake this frame batches. */
  private updateRoadStream(): void {
    const state = this.currentState;
    if (!state || !this.roads) return;
    this.roads.update({
      x: state.position.x,
      z: state.position.z,
      velocityX: state.velocity.x,
      velocityZ: state.velocity.z,
    }, performance.now());
  }

  private updateWorldVisibility(): void {
    const state = this.currentState;
    if (!state) return;
    this.terrain.update({
      x: state.position.x,
      y: state.position.y,
      z: state.position.z,
      velocityX: state.velocity.x,
      velocityZ: state.velocity.z,
      // 4-5: the one camera datum CDLOD's screen-space error needs. The
      // camera is FOVMODE_HORIZONTAL_FIXED, so the VERTICAL half-angle it
      // implies is what a pixel of ground error is measured against.
      pixelsPerMeterAtUnitDistance: this.terrainPixelsPerMeter(),
    }, this.frameIndex);
    // 2-13: one shared-field wind sample per frame at the observer — the
    // plan's three bands all read this snapshot; per-instance bytes carry
    // the spatial variation. simulationTime keeps it capture-deterministic.
    const wind = sampleWind(
      this.worldDefinition,
      state.position.x,
      state.position.y,
      state.position.z,
      state.simulationTime,
    );
    this.detail.setWind(
      wind.x,
      wind.z,
      wind.speed / MAX_WIND_SPEED,
      Math.abs(wind.gust) * 0.5 + wind.turbulence * 0.5,
    );
    // 7-13: a SECOND wind sample, at the windsock. The snapshot above is taken
    // at the aircraft and is right for the detail field, whose per-instance
    // bytes carry the spatial variation — but a windsock is one object at one
    // fixed place, kilometres from the aeroplane on approach, and a sock driven
    // by the aircraft's wind still points, swings and gusts convincingly.
    // Nothing in a frame distinguishes it, which is why
    // `lighting.windsock.test.ts` asserts the two samples DIFFER in heading and
    // speed rather than asserting the sock's angle looks right.
    if (this.airport) {
      const at = this.airport.windsockSamplePoint;
      const sockWind = sampleWind(
        this.worldDefinition,
        at.x,
        at.y,
        at.z,
        state.simulationTime,
      );
      this.airport.setWindsockState(
        windsockHeadingRadians(sockWind.x, sockWind.z),
        sockWind.speed,
      );
    }
    // Each nearby spawned field's sock takes ITS OWN sample, at its own mast.
    this.spawnedAirfields?.updateWindsocks(state.simulationTime);
    // 2-12's translucency term: the atmosphere system's own key light, on
    // the same forward-the-snapshot pattern the wind field uses. The
    // strength is the relative illuminance, so a backlit canopy glows in
    // daylight, dims through dusk and goes out with the sun.
    const keySnapshot = this.atmosphere.snapshot;
    // 4-7: the horizon map's sun. The snapshot's direction points TOWARD the
    // sun (Babylon's directional light points the other way), which is the
    // convention the plugin's uniform documents.
    this.terrain.setSunDirection(
      keySnapshot.sunDirection.x,
      keySnapshot.sunDirection.y,
      keySnapshot.sunDirection.z,
    );
    this.detail.setKeyLight(
      keySnapshot.sunDirection.x,
      keySnapshot.sunDirection.y,
      keySnapshot.sunDirection.z,
      [keySnapshot.sunColor.r, keySnapshot.sunColor.g, keySnapshot.sunColor.b],
      keySnapshot.sunIlluminanceNormalized,
    );
    // Wave Q: the far band's hand-packed CSM receiver, on the same
    // forward-the-snapshot pattern. Impostors start inside the cascade
    // reach at every tier but cannot take Babylon's shadow varyings
    // (16-fragment-input limit), so the detail plugin samples the
    // atmosphere's own depth map from these matrices instead.
    this.detail.setSunShadow(this.buildDetailSunShadowSnapshot());
    // `6-11`: the far-field half of the same trade. The CSM above reaches
    // `shadowDistance`; this reaches 45 km, which is where the impostors the
    // cascades stopped covering actually are. Re-read every frame because the
    // field re-bakes on observer travel and publishes a new origin with it.
    const horizonField = this.terrain.globalHorizonField;
    this.detail.setHorizonField(
      horizonField?.layerA ?? null,
      horizonField?.layerB ?? null,
      horizonField?.originX ?? 0,
      horizonField?.originZ ?? 0,
      horizonField?.spanMeters ?? 0,
    );
    // Terrain occlusion of the reflected sky: inland water asks the same
    // field whether its REFLECTION direction clears the terrain — the one
    // snapshot, the same frame, the same origin as the detail consumer.
    this.hydrology.setHorizonField(
      horizonField?.layerA ?? null,
      horizonField?.layerB ?? null,
      horizonField?.originX ?? 0,
      horizonField?.originZ ?? 0,
      horizonField?.spanMeters ?? 0,
    );
    // W-10: and so does the sea, which had no terrain occlusion at all — a
    // bay reflecting bright sky where a dark headland stands is the strongest
    // "pasted on" cue a coast has.
    this.ocean.setHorizonField(
      horizonField?.layerA ?? null,
      horizonField?.layerB ?? null,
      horizonField?.originX ?? 0,
      horizonField?.originZ ?? 0,
      horizonField?.spanMeters ?? 0,
    );
    this.detail.update(
      {
        x: state.position.x,
        y: state.position.y,
        z: state.position.z,
        velocityX: state.velocity.x,
        velocityZ: state.velocity.z,
      },
      { x: this.originX, y: 0, z: this.originZ },
      this.governedProfileCache,
      // Wind sway phase must be a function of the simulation clock (Z-1):
      // the capture pins simulationTime so reruns are pixel-comparable.
      state.simulationTime,
    );
    // Wave G: blades follow the CAMERA (they exist for the near-ground eye),
    // not the aircraft observer — in the terrain viewer the two coincide.
    this.groundCover.update({
      cameraWorldX: this.cameraWorld.x,
      cameraWorldY: this.cameraWorld.y,
      cameraWorldZ: this.cameraWorld.z,
      floatingOriginX: this.originX,
      floatingOriginZ: this.originZ,
      law: this.governedProfileCache.groundCoverLaw,
      windDirectionX: wind.x,
      windDirectionZ: wind.z,
      windStrength01: wind.speed / MAX_WIND_SPEED,
      windGust01: Math.abs(wind.gust) * 0.5 + wind.turbulence * 0.5,
      simulationTimeSeconds: state.simulationTime,
      // `6-9`/`P-5`: the GPU ladder's ground-cover rung, the last one on it.
      gateScale: this.workLeverSettings.groundCoverGateScale,
    });
    this.wildlife.update(
      {
        x: state.position.x,
        y: state.position.y,
        z: state.position.z,
        velocityX: state.velocity.x,
        velocityY: state.velocity.y,
        velocityZ: state.velocity.z,
      },
      { x: this.originX, y: 0, z: this.originZ },
      this.governedProfileCache,
      this.currentDeltaSeconds,
    );
    this.syncDynamicShadowCasters();
  }

  private syncDynamicShadowCasters(): void {
    const active = new Map<number, Mesh>();
    const collect = (mesh: Mesh) => active.set(mesh.uniqueId, mesh);
    // The shadow-caster-distance lever (GPU ladder since R-11) shortens reach.
    this.terrain.addShadowCasters(collect, this.workLeverSettings.shadowCasterDistanceMeters);
    this.detail.addShadowCasters(collect);
    this.wildlife.addShadowCasters(collect);
    this.spawnedAirfields?.addShadowCasters(collect);
    this.marina.addShadowCasters(collect);
    for (const [id, mesh] of this.dynamicShadowCasters) {
      if (!active.has(id)) this.atmosphere.shadows.removeShadowCaster(mesh, false);
    }
    for (const [id, mesh] of active) {
      if (!this.dynamicShadowCasters.has(id)) this.atmosphere.addShadowCaster(mesh, false);
    }
    this.dynamicShadowCasters.clear();
    for (const [id, mesh] of active) this.dynamicShadowCasters.set(id, mesh);
  }

  private updateFloatingOrigin(state: FlightVisualState): boolean {
    if (
      Math.abs(state.position.x - this.originX) < FLOATING_ORIGIN_THRESHOLD
      && Math.abs(state.position.z - this.originZ) < FLOATING_ORIGIN_THRESHOLD
    ) return false;
    const previousOriginX = this.originX;
    const previousOriginZ = this.originZ;
    this.originX = Math.round(state.position.x / FLOATING_ORIGIN_GRID) * FLOATING_ORIGIN_GRID;
    this.originZ = Math.round(state.position.z / FLOATING_ORIGIN_GRID) * FLOATING_ORIGIN_GRID;
    this.terrain.setFloatingOrigin(this.originX, this.originZ);
    this.ocean.setFloatingOrigin(this.originX, this.originZ);
    this.hydrology.setFloatingOrigin(this.originX, this.originZ);
    this.airport?.setFloatingOrigin(this.originX, this.originZ);
    this.spawnedAirfields?.setFloatingOrigin(this.originX, this.originZ);
    this.lightPoints.setFloatingOrigin(this.originX, this.originZ);
    this.steam.setFloatingOrigin(this.originX, this.originZ);
    this.marina.setFloatingOrigin(this.originX, this.originZ);
    this.roadSurface?.setFloatingOrigin(this.originX, this.originZ);
    this.boatSpray?.setFloatingOrigin(this.originX, this.originZ);
    this.boatWake?.setFloatingOrigin(this.originX, this.originZ);
    this.carParticles?.setFloatingOrigin(this.originX, this.originZ);
    this.carTracks?.setFloatingOrigin(this.originX, this.originZ);
    this.carBowWave?.setFloatingOrigin(this.originX, this.originZ);
    // 7-4b: the clustered ILLUMINATION rebases with the billboards it sits
    // under. A clustered light gets an unrebased origin worse than a billboard
    // does — the inverse-square falloff reads the position too, so it would not
    // merely draw in the wrong place, it would light the wrong place.
    this.clusteredLighting.setFloatingOrigin(this.originX, this.originZ);
    // The planar reflection pass runs before the cloud update in the frame
    // graph. Re-resolve the shared PBR receiver binding immediately so the
    // reflected scene never combines rebased geometry with the prior origin.
    this.cloudShadowReceivers.setProjection(
      this.clouds.cloudShadow,
      this.originX,
      this.originZ,
    );
    // Fix-pack polish: NO camera cut. The cut existed only because the
    // camera's smoothed position and target are stored origin-relative and
    // were never carried across the rebase — cutting snapped the smoother's
    // steady-state tracking lag (~v/7 ≈ 28 m at 200 m/s) in ONE frame, a
    // camera teleport every 4,096 m flown that the user felt as "sudden
    // jerks out of nowhere" at a perfect frame rate. Translating the rig by
    // the origin delta keeps the smoother's state exactly continuous; the
    // cloud history invalidation below is unchanged.
    const originDeltaX = previousOriginX - this.originX;
    const originDeltaZ = previousOriginZ - this.originZ;
    this.camera.position.x += originDeltaX;
    this.camera.position.z += originDeltaZ;
    this.cameraTarget.x += originDeltaX;
    this.cameraTarget.z += originDeltaZ;
    this.graph.invalidateHistory("floating origin shifted");
    return true;
  }

  private applyProfile(): void {
    this.profile = resolveWebGpuQualityProfile(this.quality, this.renderingMode);
    // A profile change resets the governor entirely — including any
    // resolution-insensitive latch, per its re-arm contract.
    this.governorConfig = this.resolveGovernorConfig();
    this.governorState = createGovernorState(this.governorConfig);
    this.renderScale = this.governorState.renderScale;
    this.applyWorkLevels(0, 0);
    this.terrain.setProfile(this.profile);
    this.clouds.setProfile(this.profile);
    this.ocean.setProfile(this.profile);
    // 0 on tier 0 tears the steam's mesh down; a cap above it builds one,
    // compiling at the switch rather than at load.
    this.steam.setMaxWisps(this.profile.volcanicSteamMaxWisps);
    this.boatSpray?.setCap(this.profile.boatSprayParticleCap);
    this.boatWake?.setTrailSeconds(this.profile.boatWakeTrailSeconds);
    this.boatHeave?.setDrawnCascades(this.profile.oceanCascades);
    this.underwater?.setDrawnCascades(this.profile.oceanCascades);
    this.carParticles?.setCap(this.profile.vehicleParticleBudget);
    this.carTracks?.setCap(this.profile.tyreTrackSegments);
    this.roadSurface?.setRanges(this.profile);
    this.spawnedAirfields?.setLimits(this.profile.spawnedAirfields);
    this.atmosphere.shadows.mapSize = this.profile.shadowMapSize;
    this.atmosphere.shadows.numCascades = this.profile.shadowCascades;
    this.atmosphere.shadows.shadowMaxZ = this.profile.shadowDistance;
    // Bloom's funding is a per-tier decision, so a profile change can add or
    // remove it. Re-gate BEFORE deriving ownership: which pass is first
    // depends on what is attached.
    this.bloom.setEnabled(this.camera, this.profile.bloomEnabled, this.scotopic.enabled ? 1 : 0);
    this.applyFirstPassOwnership();
    // Babylon APPENDS on attach, so both final passes come off and the
    // profile's one goes back on: it must be the last pass in the chain.
    this.sharpen.setEnabled(this.camera, false);
    this.fxaa.setEnabled(this.camera, false);
    this.fxaa.setAmount(this.profile.sharpenAmount);
    this.fxaa.setEnabled(this.camera, this.profile.msaaSamples === 1);
    this.sharpen.setAmount(this.profile.sharpenAmount);
    this.sharpen.setEnabled(this.camera, standaloneSharpen(this.profile));
    this.resetTimingWindow();
    this.applyRenderScale();
    this.graph.invalidateHistory("quality profile changed");
  }

  /** The capped scale product as a hardware scaling level (1A-6a). */
  private resolveRenderScaleLevel(): number {
    return resolveHardwareScalingLevel({
      maxDevicePixelRatio: this.profile.maxDevicePixelRatio,
      devicePixelRatio: window.devicePixelRatio,
      renderScale: this.renderScale,
      cssWidth: this.domElement.clientWidth,
      cssHeight: this.domElement.clientHeight,
      maxRenderPixels: this.profile.maxRenderPixels,
    });
  }

  /**
   * Applies the capped scale product now, with a forced resize; returns
   * whether it actually changed. Construction, a profile change and a
   * capture pin take this path.
   */
  private applyRenderScale(): boolean {
    const changed = this.renderScaleQueue.applyNow();
    this.appliedRenderScale = this.renderScale;
    return changed;
  }

  /** B1: the frame-start half of a deferred governor step or display resize. */
  private applyPendingRenderScale(): void {
    const applied = this.renderScaleQueue.applyPending();
    if (applied === null) return;
    this.appliedRenderScale = this.renderScale;
    if (applied.resetTimingWindow) this.resetTimingWindow();
    if (applied.changed || applied.force) this.graph.invalidateHistory(applied.reason);
  }

  /**
   * B1: queues a governor step for the next frame's start and returns whether
   * it moves the level, which the anti-ratchet latch needs now. A step the
   * pixel cap absorbs leaves the level as it is, so it counts as applied.
   */
  private deferGovernedRenderScale(): boolean {
    const changed = this.renderScaleQueue.levelWouldChange();
    if (changed) {
      this.renderScaleQueue.defer(GOVERNED_SCALE_REQUEST);
    } else {
      this.appliedRenderScale = this.renderScale;
    }
    return changed;
  }

  /**
   * One governor decision per completed sample window (1A-6b). Resolution
   * moves only for GPU-bound frames; CPU-bound frames move the work ladder;
   * a resolution step that buys nothing is undone and latched against.
   */
  private updateGovernor(): void {
    const gpuTimingIsFresh = freshFrameTiming(
      this.lastGpuFrameMilliseconds,
      this.lastGpuTimingFrameIndex,
      this.frameIndex,
      GPU_TIMING_STALE_AFTER_FRAMES,
    ) !== null;
    const gpuP95Ms = gpuTimingIsFresh && this.gpuFrameDurations.length >= MIN_GPU_TIMING_SAMPLES
      ? frameTimingPercentile95(this.gpuFrameDurations)
      : null;
    const cpuP95Ms = frameTimingPercentile95(this.cpuFrameDurations);
    const intervalP95Ms = frameTimingPercentile95(this.frameIntervalDurations);
    this.resetTimingSamples();
    this.lastSignals = { gpuP95Ms, cpuP95Ms, intervalP95Ms };

    const previous = this.governorState;
    let state = nextGovernorDecision(previous, this.lastSignals, this.governorConfig);
    if (Math.abs(state.renderScale - this.renderScale) > 1e-6) {
      const lowered = state.renderScale < this.renderScale;
      this.renderScale = state.renderScale;
      // When the absolute pixel cap is the binding constraint, a governor
      // step leaves the effective scale unchanged — no resize, no history
      // reset, and the anti-ratchet latch learns about it immediately. B1: a
      // step that does change it resizes at the next frame's start, never
      // here, after this frame has drawn.
      const changed = this.deferGovernedRenderScale();
      if (lowered) {
        state = observeRenderScaleApplication(state, changed, this.governorConfig);
        if (Math.abs(state.renderScale - this.renderScale) > 1e-6) {
          this.renderScale = state.renderScale;
          this.deferGovernedRenderScale();
        }
      }
    }
    if (
      state.cpuWorkLevel !== previous.cpuWorkLevel
      || state.gpuWorkLevel !== previous.gpuWorkLevel
    ) {
      this.applyWorkLevels(state.cpuWorkLevel, state.gpuWorkLevel);
    }
    this.governorState = state;
  }

  /** Push both ladders' notches into every lever's subsystem seam (R-11). */
  private applyWorkLevels(cpuLevel: number, gpuLevel: number): void {
    const settings = workLeverSettingsFor(cpuLevel, gpuLevel);
    this.workLeverSettings = settings;
    this.terrain.setRequestBudgetPerUpdate(settings.terrainPageRequestsPerUpdate);
    // 4-0b rung 0: the shared compute cap moves before any visible lever.
    this.terrain.setComputeBudgetScale(settings.computeBudgetScale);
    this.detail.setGenerationBudgetCap(
      settings.detailCellBudgetMs >= 2 && settings.detailCellCap >= 24
        ? null
        : {
            maximumCells: settings.detailCellCap,
            maximumMilliseconds: settings.detailCellBudgetMs,
          },
    );
    this.clouds.setShadowIntervalFloor(settings.cloudShadowIntervalFrames);
    this.governedProfileCache = this.resolveGovernedProfile();
  }

  /** The profile with the governed animal and vegetation caps applied. */
  private resolveGovernedProfile(): WebGpuQualityProfile {
    const settings = this.workLeverSettings;
    if (
      settings.activeAnimalBudgetCap === Number.POSITIVE_INFINITY
      && settings.vegetationDistanceScale === 1
    ) {
      return this.profile;
    }
    return {
      ...this.profile,
      activeAnimalBudget: Math.min(
        this.profile.activeAnimalBudget,
        settings.activeAnimalBudgetCap,
      ),
      vegetationDistance: this.profile.vegetationDistance * settings.vegetationDistanceScale,
    };
  }

  private captureFrameInterval(started: number): void {
    const previous = this.previousFrameStartedAt;
    this.previousFrameStartedAt = started;
    if (previous === null) return;
    const interval = started - previous;
    // Z-2: the diagnostics ring keeps every finite interval — including the
    // >250 ms stalls the governor's p95 deliberately excludes. Dropping them
    // made the metric blind to the single most user-visible failure mode.
    if (Number.isFinite(interval) && interval > 0) {
      this.pushDiagnosticSample(this.diagnosticIntervalDurations, interval);
    }
    if (!isUsableFrameTiming(interval)) {
      // A suspended/background tab must not poison a later active-window p95.
      this.lastFrameIntervalMilliseconds = 0;
      this.lastPresentWaitMilliseconds = null;
      this.resetTimingSamples();
      return;
    }
    this.lastFrameIntervalMilliseconds = interval;
    this.frameIntervalDurations.push(interval);
    // The interval ending at this frame start belongs to the CPU work saved
    // from the preceding render. Babylon's WebGPU PerfCounter does not expose
    // the submitted frame id for its asynchronous timestamp result, so that
    // independent GPU aggregate must not be spliced into this frame. Keep the
    // residual unavailable until the engine exposes a correlatable sample.
    this.recordPresentAttribution(interval, this.lastCpuFrameMilliseconds, null);
  }

  private recordPresentAttribution(
    intervalMilliseconds: number,
    cpuMilliseconds: number,
    correlatedGpuMilliseconds: number | null,
  ): void {
    const attribution = attributePresentFrame(
      intervalMilliseconds,
      cpuMilliseconds,
      correlatedGpuMilliseconds,
    );
    this.lastPresentWaitMilliseconds = attribution.presentWaitMs;
    if (attribution.presentWaitMs !== null) {
      this.pushDiagnosticSample(
        this.diagnosticPresentWaitDurations,
        attribution.presentWaitMs,
      );
    }
  }

  /** Returns this frame's freshly resolved GPU sample, or null. */
  private captureGpuFrameTiming(): number | null {
    if (!this.engine.enableGPUTimingMeasurements) {
      this.lastGpuFrameMilliseconds = null;
      return null;
    }
    const counter = this.engine.getGPUFrameTimeCounter();
    // WebGPU timestamp readback is asynchronous. `current` remains unchanged
    // until another query resolves, so consume each counter result only once.
    // The counter carries no submitted frame id; it is valid as an independent
    // GPU distribution but deliberately not used for present attribution.
    if (counter.count === this.lastGpuCounterSampleCount) return null;
    this.lastGpuCounterSampleCount = counter.count;
    const milliseconds = counter.current / 1_000_000;
    if (!isUsableFrameTiming(milliseconds)) {
      this.lastGpuFrameMilliseconds = null;
      return null;
    }
    this.lastGpuFrameMilliseconds = milliseconds;
    this.lastGpuTimingFrameIndex = this.frameIndex;
    this.gpuFrameDurations.push(milliseconds);
    this.pushDiagnosticSample(this.diagnosticGpuDurations, milliseconds);
    return milliseconds;
  }

  private resetTimingSamples(): void {
    this.frameIntervalDurations.length = 0;
    this.cpuFrameDurations.length = 0;
    this.gpuFrameDurations.length = 0;
  }

  private resetTimingWindow(): void {
    this.timingWindowEpoch += 1;
    this.resetTimingSamples();
    this.diagnosticIntervalDurations.length = 0;
    this.diagnosticCpuDurations.length = 0;
    this.diagnosticGpuDurations.length = 0;
    this.diagnosticPresentWaitDurations.length = 0;
    this.previousFrameStartedAt = null;
    this.lastFrameIntervalMilliseconds = 0;
    this.lastCpuFrameMilliseconds = 0;
    this.lastPresentWaitMilliseconds = null;
    this.lastGpuFrameMilliseconds = null;
    this.lastGpuTimingFrameIndex = Number.NEGATIVE_INFINITY;
    this.lastGpuCounterSampleCount = this.engine.enableGPUTimingMeasurements
      ? this.engine.getGPUFrameTimeCounter().count
      : 0;
  }
}
