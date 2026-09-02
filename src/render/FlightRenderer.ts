import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { FxaaPostProcess } from "@babylonjs/core/PostProcesses/fxaaPostProcess";
import { ImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/imageProcessingPostProcess";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import type {
  CameraMode,
  FlightVisualState,
  GpuPassAttribution,
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
import {
  AirfieldLightingSystem,
  airfieldLampDaylightAttenuation,
} from "./webgpu/lighting/AirfieldLighting";
import {
  AIRCRAFT_CAST_POOLS,
  aircraftWashLights,
  castPoolWorldPosition,
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
import { AerialPerspectiveRegistry } from "./webgpu/atmosphere/AerialPerspective";
import { FULL_MOON_ILLUMINANCE_LUX } from "./webgpu/atmosphere/Ephemeris";
import { AtmosphereGpuResources } from "./webgpu/atmosphere/AtmosphereGpuResources";
import { SkyEnvironmentProbe } from "./webgpu/atmosphere/SkyEnvironmentProbe";
import type { RenderingMode } from "@/src/settings";
import type { AircraftKind } from "@/src/sim";
import type { AirportDefinition, TerrainSample, WorldDefinition } from "@/src/world";
import { MAX_WIND_SPEED, sampleWind } from "@/src/world";
import { createWebGpuAircraft, type AircraftVisual } from "./webgpu/aircraft";
import { AtmosphereSystem } from "./webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "./webgpu/clouds/CloudShadowReceiverRegistry";
import { VolumetricCloudSystem } from "./webgpu/clouds/VolumetricCloudSystem";
import { inspectWebGpuCapabilities } from "./webgpu/core/Capabilities";
import {
  formatGpuUncapturedError,
  GpuUncapturedErrorGuard,
} from "./webgpu/core/GpuUncapturedErrorGuard";
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
import { estimateGpuMemoryMiB } from "./webgpu/core/PerformanceBudget";
import {
  CAMERA_FAR_PLANE_METERS,
  frameTimingPercentile,
  frameTimingPercentile95,
  freshFrameTiming,
  hitchThresholdMilliseconds,
  isUsableFrameTiming,
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "./webgpu/core/QualityProfile";
import { AirportSystem } from "./webgpu/detail/AirportSystem";
import { windsockHeadingRadians } from "./webgpu/detail/AirfieldFurniture";
import { WorldDetailRuntime } from "./webgpu/detail";
import type { DetailSunShadowSnapshot } from "./webgpu/detail/DetailInstanceMaterialPlugin";
import { GroundCoverSystem } from "./webgpu/detail/GroundCoverSystem";
import { meanSeasonalSurfaceAlbedo } from "./webgpu/terrain/TerrainSurfacePlugin";
import { TerrainClipmapSystem } from "./webgpu/terrain/TerrainClipmapSystem";
import { TerrainEvolutionRuntime } from "./webgpu/terrain/TerrainEvolutionRuntime";
import {
  TerrainMacroErosionGpu,
  TerrainMacroInputsGpu,
} from "./webgpu/terrain/TerrainMacroErosionGpu";
import { terrainMacroGridFromEvolution } from "./webgpu/terrain/TerrainMacroEvolutionClient";
import {
  TerrainConsumerAuthority,
  terrainConsumerSampleFromAuthority,
} from "./webgpu/terrain/TerrainConsumerAuthority";
import type { TerrainAuxPagePublication } from "./webgpu/terrain/TerrainPageAtlas";
import { WildlifeSystem } from "./webgpu/wildlife";
import { HydrologySystem } from "./webgpu/water/HydrologySystem";
import {
  resolveSunShadowCascadeLayout,
  type SunShadowCascadeLayout,
} from "./webgpu/water/SunShadowReceiver";

/** Wave R: the per-frame snapshot is reused, never reallocated. */
type MutableDetailSunShadowSnapshot = {
  -readonly [Key in keyof DetailSunShadowSnapshot]: DetailSunShadowSnapshot[Key];
};
import {
  BathymetryClipmap,
  bathymetryErodedPageOverlaySeamFromAtlas,
} from "./webgpu/water/BathymetryClipmap";
import { channelGraphToHydrologyGeometry } from "./webgpu/water/ChannelNetwork";
import {
  resolveOceanMipGenerator,
  SpectralOceanSystem,
} from "./webgpu/water/SpectralOceanSystem";
import type { FlightRenderingSystem, TerrainAuthorityPublisher } from "./types";
import {
  type TerrainPagePublication,
} from "@/src/workers/terrainAuthority";
import { attributePresentFrame } from "./frameAttribution";
import {
  cameraBankFollow,
  cameraPresentationResponse,
  orthogonalizeCameraUpToRef,
  smoothCameraVectorToRef,
} from "./cameraPresentation";

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
const BUDGET_PROBE_EXCLUDED_PASSES: ReadonlySet<string> = new Set(["hdr-present"]);

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
 * `awaitRendererStartup` already names and bounds every startup stage; it just
 * never said how long any of them took, so "time to ready" was a single opaque
 * number with no way to attribute a regression. This is opt-in and inert
 * otherwise: no allocation, no timing, and no behaviour change on the shipping
 * path unless a harness calls `beginRendererStartupTrace()` first.
 */
let rendererStartupTrace: { label: string; milliseconds: number }[] | null = null;

/** Start recording startup-stage durations, discarding any previous trace. */
export function beginRendererStartupTrace(): void {
  rendererStartupTrace = [];
}

/** The stages recorded since `beginRendererStartupTrace`, in completion order. */
export function readRendererStartupTrace(): readonly {
  readonly label: string;
  readonly milliseconds: number;
}[] {
  return rendererStartupTrace ?? [];
}

/** Stop recording and release the trace. */
export function endRendererStartupTrace(): void {
  rendererStartupTrace = null;
}

function awaitRendererStartup<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  label: string,
  timeoutMilliseconds: number,
  disposeLateValue?: (value: T) => void,
): Promise<T> {
  throwIfRendererStartupAborted(signal);
  const traceStartedAt = rendererStartupTrace === null ? 0 : performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      rendererStartupTrace?.push({
        label,
        milliseconds: performance.now() - traceStartedAt,
      });
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
  aircraft: AircraftKind,
  airspeed: number,
  out: ChaseCameraProfile = { distance: 0, height: 0, fieldOfView: 0, aimAhead: 0 },
): ChaseCameraProfile {
  const jet = aircraft === "jet";
  if (jet) {
    // The speed response is the point: the "jet should sit further ahead at
    // speed" report is answered by pulling the rig back AND pushing the aim
    // point forward, so the aircraft slides forward in frame and the world
    // streams past it. The old fixed +2.2 m cap read as a static rig.
    //
    // Sized for the ~11 m Vesper J-45 (not the 19 m airframe the fix-pack
    // briefly flew): the base rig is the original 14.3 m / 5.0 m, and the
    // response opens above 145 m/s — the J-45's ~260 m/s ceiling gives a
    // 115 m/s working band, so the slopes are set to reach their caps right
    // at the top of the envelope (0.07·115 = 8.05 ≥ 8; 0.12·115 = 13.8 ≈ 14;
    // 0.05·120 = 6.0 = 6 measured from the 140 m/s FOV knee).
    const speedExcess = Math.max(0, airspeed - 145);
    out.distance = 14.3 + Math.min(8, speedExcess * 0.07);
    out.height = 5;
    out.fieldOfView = 62 + Math.max(0, Math.min(6, (airspeed - 140) * 0.05));
    out.aimAhead = 16 + Math.min(14, speedExcess * 0.12);
    return out;
  }
  out.distance = 13.5 + Math.max(0, Math.min(2.2, (airspeed - 45) * 0.012));
  out.height = 5.1;
  out.fieldOfView = 62 + Math.max(0, Math.min(3, (airspeed - 38) * 0.035));
  out.aimAhead = 16;
  return out;
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

export interface FlightRendererOptions {
  canvas: HTMLCanvasElement;
  aircraft: AircraftKind;
  terrainSample: TerrainSampleFunction;
  world: WorldDefinition;
  seed: number;
  quality: QualityLevel;
  renderingMode: RenderingMode;
  reducedMotion: boolean;
  runway?: Readonly<AirportDefinition>;
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
  private readonly hydrology: HydrologySystem;
  private readonly bathymetry: BathymetryClipmap;
  private readonly airport: AirportSystem | null;
  private readonly detail: WorldDetailRuntime;
  private readonly groundCover: GroundCoverSystem;
  private readonly wildlife: WildlifeSystem;
  private readonly toneMap: ImageProcessingPostProcess;
  private readonly fxaa: FxaaPostProcess;
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
  private readonly resizeObserver: ResizeObserver;
  private readonly atmosphereTracker = new AtmosphereChangeTracker();
  private readonly bodyMatrix = Matrix.Identity();
  private readonly bodyQuaternion = Quaternion.Identity();
  private readonly forward = Vector3.Right();
  private readonly up = Vector3.Up();
  private readonly cameraTarget = Vector3.Zero();
  private readonly desiredCameraTarget = Vector3.Zero();
  private readonly desiredCamera = Vector3.Zero();
  private readonly desiredCameraUp = Vector3.Up();
  private readonly cameraViewDirection = Vector3.Right();
  private readonly cameraWorld = Vector3.Zero();
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
  /** The chase rig's ground clamp samples the terrain directly. */
  private readonly cameraTerrainSample: TerrainSampleFunction;
  private environmentState: EnvironmentState = DEFAULT_ENVIRONMENT_STATE;
  private skyProbeStale = false;
  private skyProbeAltitudeMeters = 0;
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
  private originShifted = true;
  private cameraCut = true;
  private frameIndex = 0;
  private renderScale: number;
  private terrainAuthorityPublisher: TerrainAuthorityPublisher | null = null;
  private readonly atmosphereResources: AtmosphereGpuResources;
  private readonly passTimingHistory = new PassTimingHistory();
  private governorConfig: GovernorConfig;
  private governorState: GovernorState;
  private pinnedRenderScale: number | null;
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
    terrain: TerrainClipmapSystem,
    terrainEvolution: TerrainEvolutionRuntime,
    terrainConsumerAuthority: TerrainConsumerAuthority | null,
    atmosphere: AtmosphereSystem,
    clouds: VolumetricCloudSystem,
    cloudShadowReceivers: CloudShadowReceiverRegistry,
    aerialReceivers: AerialPerspectiveRegistry,
    skyProbe: SkyEnvironmentProbe,
    ocean: SpectralOceanSystem,
    hydrology: HydrologySystem,
    bathymetry: BathymetryClipmap,
    airport: AirportSystem | null,
    detail: WorldDetailRuntime,
    groundCover: GroundCoverSystem,
    wildlife: WildlifeSystem,
    toneMap: ImageProcessingPostProcess,
    fxaa: FxaaPostProcess,
    stars: StarFieldSystem,
    lightPoints: LightPointSystem,
    clusteredLighting: ClusteredLightingSystem,
    hangarFloodNames: readonly string[],
    airfieldLighting: AirfieldLightingSystem | null,
    scotopic: ScotopicVisionPass,
    bloom: BloomPass,
    atmosphereResources: AtmosphereGpuResources,
    adapterLabel: string,
  ) {
    this.atmosphereResources = atmosphereResources;
    this.domElement = options.canvas;
    this.engine = engine;
    this.gpuUncapturedErrorGuard = gpuUncapturedErrorGuard;
    this.scene = scene;
    this.camera = camera;
    this.aircraft = aircraft;
    this.terrain = terrain;
    this.terrainEvolution = terrainEvolution;
    this.terrainConsumerAuthority = terrainConsumerAuthority;
    this.atmosphere = atmosphere;
    this.clouds = clouds;
    this.cloudShadowReceivers = cloudShadowReceivers;
    this.aerialReceivers = aerialReceivers;
    this.skyProbe = skyProbe;
    this.ocean = ocean;
    this.hydrology = hydrology;
    this.bathymetry = bathymetry;
    this.airport = airport;
    this.detail = detail;
    this.groundCover = groundCover;
    this.wildlife = wildlife;
    this.toneMap = toneMap;
    this.fxaa = fxaa;
    this.stars = stars;
    this.lightPoints = lightPoints;
    this.clusteredLighting = clusteredLighting;
    this.hangarFloodNames = hangarFloodNames;
    this.airfieldLighting = airfieldLighting;
    this.scotopic = scotopic;
    this.bloom = bloom;
    this.adapterLabel = adapterLabel;
    this.seaLevel = options.world.seaLevel;
    this.aircraftKind = options.aircraft;
    this.latitudeDegrees = options.world.latitudeDegrees;
    this.cameraTerrainSample = options.terrainSample;
    this.worldDefinition = options.world;
    this.quality = options.quality;
    this.renderingMode = options.renderingMode;
    this.reducedMotion = options.reducedMotion;
    this.profile = resolveWebGpuQualityProfile(this.quality, this.renderingMode);
    this.pinnedRenderScale = options.pinnedRenderScale ?? null;
    this.governorConfig = this.resolveGovernorConfig();
    this.governorState = createGovernorState(this.governorConfig);
    this.governedProfileCache = this.profile;
    this.renderScale = this.governorState.renderScale;
    this.applyRenderScale();
    this.installFrameGraph();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      // Re-derive the capped scale: the pixel budget depends on the CSS size.
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
    if (!capability.features.has("texture-formats-tier1")) {
      throw new Error(
        "This GPU does not expose texture-formats-tier1, required by the R16F bathymetry clipmap.",
      );
    }
    const requiredFeatures: GPUFeatureName[] = [
      "texture-formats-tier1",
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
      const terrain = new TerrainClipmapSystem(scene, options.world, profile);
      cleanup.push(() => terrain.dispose());
      const evolutionResult = await awaitRendererStartup(
        terrainEvolutionPromise,
        options.signal,
        "terrain macro evolution",
        TERRAIN_EVOLUTION_STARTUP_TIMEOUT_MILLISECONDS,
      );
      // The macro pass ran once; return its ~36 MiB of 1024² erosion scratch
      // and ~12 MiB of sampling scratch before page atlases allocate (dispose
      // is idempotent under cleanup).
      gpuMacroErosion?.dispose();
      gpuMacroInputs?.dispose();
      terrain.setMacroEvolution(evolutionResult.evolution);
      let terrainConsumerAuthority: TerrainConsumerAuthority | null = null;
      let consumerTerrainSample = options.terrainSample;
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
      }
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
      );
      cleanup.push(() => bathymetry.dispose());
      bathymetry.setMacroEvolution(evolutionResult.evolution);
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
      const aircraft = createWebGpuAircraft(scene, options.aircraft);
      cleanup.push(() => aircraft.dispose());
      for (const mesh of aircraft.meshes) {
        if (mesh.metadata?.castsShadow === false) continue;
        atmosphere.shadows.addShadowCaster(mesh, false);
      }
      const airportDefinition = options.runway ?? options.world.airport;
      // 3-9: the hangars are the only airport meshes left, and the apron they
      // stood on is gone — they read the ground the earthworks made.
      const airport = airportDefinition
        ? new AirportSystem(
          scene,
          airportDefinition,
          (x, z) => options.terrainSample(x, z).height,
          options.world.seedHash,
        )
        : null;
      if (airport) cleanup.push(() => airport.dispose());
      if (airport) {
        airport.setFloatingOrigin(0, 0);
        for (const mesh of airport.shadowCasters) atmosphere.addShadowCaster(mesh, false);
      }
      const detail = new WorldDetailRuntime(scene, {
        worldSeed: options.world.seed,
        terrainSample: consumerTerrainSample,
        seaLevelMeters: options.world.seaLevel,
        latitudeDegrees: options.world.latitudeDegrees,
        workerWorldSeed: options.world.seed,
        workerWorld: options.world,
      });
      cleanup.push(() => detail.dispose());
      // Wave G: the blade system reads the SAME consumer sampler as detail
      // and the camera clamp, so blades stand on the rendered surface.
      const groundCover = new GroundCoverSystem(scene, {
        terrainSample: consumerTerrainSample,
        // `6-9` debt 1: the per-frame field is admitted through the SAME
        // amortised-compute meter as every other GPU compute producer, which
        // is what `owners.ts` has claimed since `4-0b` and wave G left false.
        computeBudget: terrain.computeBudgetMeter,
        // The detail scatter hashes `String(world.seed)`, which is exactly
        // `sourceSeedHash` — the field and the cards must key the SAME
        // realisation or the handoff at the field radius swaps species.
        seedHash: options.world.sourceSeedHash,
        seaLevelMeters: options.world.seaLevel,
      });
      cleanup.push(() => groundCover.dispose());
      if (evolutionResult.mode === "eroded") {
        detail.publishTerrainMacro(
          terrainMacroGridFromEvolution(evolutionResult.evolution),
        );
      }
      const wildlife = new WildlifeSystem(scene, {
        worldSeed: options.world.seed,
        terrainSample: consumerTerrainSample,
      });
      cleanup.push(() => wildlife.dispose());
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
      const hydrology = await HydrologySystem.create(
        scene,
        camera,
        {
          worldSeed: options.world.seed,
          terrainSample: options.terrainSample,
          workerWorldSeed: options.world.seed,
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
          ...(channelGraph
            ? { graphHydrology: channelGraphToHydrologyGeometry(channelGraph) }
            : {}),
        },
        options.signal,
      );
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
      await clouds.whenReadyAsync(options.signal);
      const ocean = await SpectralOceanSystem.create(
        scene,
        camera,
        options.world.seaLevel,
        profile,
        options.seed,
        atmosphere.snapshot,
        options.world.prevailingWindRadians,
        options.world.prevailingWindSpeed,
        options.signal,
        bathymetry,
      );
      cleanup.push(() => ocean.dispose());
      const cloudShadowReceivers = new CloudShadowReceiverRegistry();
      cleanup.push(() => cloudShadowReceivers.dispose());
      // Register each shared PBR material once. Detail and wildlife can render
      // thousands of thin instances without creating receiver-side state.
      cloudShadowReceivers.registerMeshes(aircraft.meshes);
      if (airport) cloudShadowReceivers.registerMeshes(airport.root.getChildMeshes(false));
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
      if (airport) aerialReceivers.registerMeshes(airport.root.getChildMeshes(false));
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
      const lightPoints = new LightPointSystem(
        scene,
        airfieldLighting?.fixtures ?? [],
        1,
      );
      cleanup.push(() => lightPoints.dispose());
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
      const clusteredLighting = new ClusteredLightingSystem(
        scene,
        [
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
        ],
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
      const fxaa = new FxaaPostProcess(
        "final-fxaa",
        1,
        camera,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        engine,
        false,
        Constants.TEXTURETYPE_UNSIGNED_BYTE,
      );
      cleanup.push(() => fxaa.dispose(camera));
      // FXAA is the no-MSAA fallback only; running both softens the image.
      if (profile.msaaSamples > 1) camera.detachPostProcess(fxaa);

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
      gpuUncapturedErrorGuard.throwIfFailed();
      throwIfRendererStartupAborted(options.signal);
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
      gpuUncapturedErrorGuard.throwIfFailed();
      throwIfRendererStartupAborted(options.signal);
      // 2-10: the planar-reflection capture is retired — the environment
      // probe covers water reflections; the receiver contract stays bound to
      // a zero-confidence fallback texel inside each water material.
      const info = engine.getInfo();
      const renderer = new FlightRenderer(
        // The camera's ground clamp must track the terrain the player SEES:
        // in eroded worlds that is the consumer authority's surface, not the
        // analytic pre-erosion kernel — clamping against an invisible ridge
        // shoved the chase camera upward with no visual justification.
        { ...options, terrainSample: consumerTerrainSample },
        engine,
        gpuUncapturedErrorGuard,
        scene,
        camera,
        aircraft,
        terrain,
        terrainEvolution,
        terrainConsumerAuthority,
        atmosphere,
        clouds,
        cloudShadowReceivers,
        aerialReceivers,
        skyProbe,
        ocean,
        hydrology,
        bathymetry,
        airport,
        detail,
        groundCover,
        wildlife,
        toneMap,
        fxaa,
        stars,
        lightPoints,
        clusteredLighting,
        hangarFloods.map((flood) => flood.name),
        airfieldLighting,
        scotopic,
        bloom,
        atmosphereResources,
        `${info.vendor} ${info.renderer}`.trim(),
      );
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

  setCameraMode(mode: CameraMode): void {
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    this.cameraCut = true;
    this.aircraft.setCockpitView(mode === "cockpit");
    this.graph.invalidateHistory("camera mode changed");
  }

  setViewerMode(enabled: boolean): void {
    if (enabled === this.viewerMode) return;
    this.viewerMode = enabled;
    // Disabling the root disables every aircraft mesh, which removes them
    // from the beauty pass and the shadow render lists alike; the visual and
    // its registrations are otherwise untouched so leaving the viewer is a
    // pure re-enable.
    this.aircraft.root.setEnabled(!enabled);
    this.setCameraMode(enabled ? "freefly" : "chase");
  }

  sampleGroundHeight(x: number, z: number): number {
    return this.cameraTerrainSample(x, z).height;
  }

  setTerrainAuthorityPublisher(publisher: TerrainAuthorityPublisher | null): void {
    this.terrainAuthorityPublisher = publisher;
    if (publisher) this.terrainEvolution.publishMacroOnce(publisher);
    const needsEvolvedConsumers = this.terrainConsumerAuthority !== null;
    this.terrain.setCollisionPagePublisher(
      publisher || needsEvolvedConsumers
        ? (page) => this.publishTerrainConsumerPage(page)
        : null,
    );
  }

  /** Copy before either worker detaches its transfer-owned publication. */
  private publishTerrainConsumerPage(page: TerrainPagePublication): void {
    const authority = this.terrainConsumerAuthority;
    if (authority) {
      authority.publish({ ...page, heights: page.heights.slice() });
      this.detail.publishTerrainPage({ ...page, heights: page.heights.slice() });
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
    this.hydrology.setAtmosphere(this.atmosphere.snapshot);
    this.graph.invalidateHistory("atmosphere changed");
  }

  render(state: FlightVisualState, deltaSeconds: number): void {
    if (this.disposed) return;
    this.gpuUncapturedErrorGuard.throwIfFailed();
    if (this.deviceLost) {
      throw new Error("The WebGPU device was lost; rendering cannot continue");
    }
    if (!finiteState(state)) throw new Error("The simulation produced a non-finite render state");
    const started = performance.now();
    this.captureFrameInterval(started);
    this.currentState = state;
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
    await this.engine._device.queue.onSubmittedWorkDone();
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
        } | null;
      })._texture;
      if (!internal || seenTextures.has(internal)) continue;
      seenTextures.add(internal);
      const width = internal.width ?? 0;
      const height = internal.height ?? 0;
      const depth = Math.max(1, internal.depth ?? 1);
      const bytesPerTexel = this.texelBytes(internal.type, internal.format);
      const mipFactor = internal.generateMipMaps ? 4 / 3 : 1;
      bytes += width * height * depth * bytesPerTexel * mipFactor;
    }
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
    // Storage buffers appear in neither list, and every allocation Phase 6
    // adds is one. Without this the wall reads byte-identical no matter how
    // much compute scratch an item allocates.
    bytes += inventoriedGpuBufferBytes();
    return bytes / 1_048_576;
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
      collisionSamplesServedByFallback:
        this.currentState?.terrainAuthority?.analyticServed ?? 0,
      visibleInstances: this.detail.statistics.renderedThinInstances + wildlife.renderedThinInstances,
      vegetationBatches: this.detail.statistics.activeBatches,
      activeAnimals: wildlife.activeAnimals,
      riverCount: hydrology.riverCount,
      lakeCount: hydrology.lakeCount,
      requestedRenderingMode: this.renderingMode,
      renderBackend: "webgpu",
      renderTechnique: "forward-spectral-volumetric",
      renderScale: this.renderScale,
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
      pendingTerrainPages: terrain.pendingPages + terrain.slotsGenerating,
      pendingDetailWork: this.detail.pendingWorkItems + this.groundCover.pendingTileRows,
      terrainComputeDispatches: terrain.workersBusy,
      estimatedGpuMemoryMiB: estimateGpuMemoryMiB(this.profile, {
        cssWidth: Math.max(1, this.domElement.clientWidth),
        cssHeight: Math.max(1, this.domElement.clientHeight),
        devicePixelRatio: window.devicePixelRatio || 1,
      }),
      inventoriedGpuMemoryMiB: this.inventoryGpuMemoryMiB(),
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
      },
      () => this.engine.dispose(),
      () => this.scene.dispose(),
      () => this.atmosphere.dispose(),
      () => this.aircraft.dispose(),
      () => {
        if (typeof window !== "undefined") {
          window.removeEventListener("keydown", this.handleDebugKey);
        }
      },
      () => this.terrain.dispose(),
      () => this.terrainEvolution.dispose(),
      () => this.bathymetry.dispose(),
      () => this.wildlife.dispose(),
      () => this.detail.dispose(),
      () => this.airport?.dispose(),
      () => this.clouds.dispose(),
      () => this.hydrology.dispose(),
      () => this.ocean.dispose(),
      () => this.cloudShadowReceivers.dispose(),
      () => this.aerialReceivers.dispose(),
      () => this.skyProbe.dispose(),
      () => this.atmosphereResources.dispose(),
      () => this.toneMap.dispose(this.camera),
      () => this.fxaa.dispose(this.camera),
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
    this.graph.register({
      name: "world-page-visibility",
      phase: "visibility",
      after: ["flight-presentation"],
      execute: () => this.updateWorldVisibility(),
    });
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
        this.ocean.update(this.cameraWorld, frame.timeSeconds, frame.deltaSeconds);
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
    if (!this.viewerMode) {
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
      this.lightPoints.setColors(this.airfieldLighting.colourList());
    }
    // OUTPUT size, for the reason on `LightPointSystem.setOutputSize`. The CSS
    // size is what `applyRenderScale` already reads for its own pixel cap, so
    // this is the same authority rather than a second one.
    this.lightPoints.setOutputSize(
      this.domElement.clientWidth,
      this.domElement.clientHeight,
    );
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
    // The probe re-lights the world when the environment changes or when the
    // camera's altitude has drifted enough to matter (the sky itself dims
    // and clears with height); everything else leaves it untouched.
    if (
      this.skyProbeStale
      || Math.abs(binding.cameraAltitudeMeters - this.skyProbeAltitudeMeters) > 500
    ) {
      // R-26: the below-horizon half of the SH bake is the ground's own
      // albedo now, not a hardcoded 0.25 floor.
      this.skyProbe.update(binding, this.atmosphere.surfaceAlbedoLuminance);
      // 2-0a: the cloud ambient LUT re-bakes on the same cadence, from the
      // same binding, so cloud ambient cannot drift from the sky/IBL pair.
      this.atmosphereResources.update(binding);
      this.skyProbeStale = false;
      this.skyProbeAltitudeMeters = binding.cameraAltitudeMeters;
    }
  }

  private updateCamera(state: FlightVisualState): void {
    const aircraftPosition = this.aircraft.root.position;
    let fieldOfView = 62;
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
      // Both airframes seat the pilot at the same offsets from the CG: the
      // J-45's tandem canopy and the trainer's cabin both sit 1.15 m forward
      // and 1.12 m up, so no per-kind eye point is warranted here.
      this.desiredCamera.copyFrom(aircraftPosition)
        .addInPlace(this.forward.scale(1.15))
        .addInPlace(this.up.scale(1.12));
      this.desiredCameraTarget.copyFrom(this.desiredCamera)
        .addInPlace(this.forward.scale(400));
      // Narrower than chase, as a cockpit must be — the old 72° (vertical!)
      // was the widest view in the game, which is backwards.
      fieldOfView = 56;
    } else if (this.cameraMode === "cinematic") {
      const angle = state.simulationTime * 0.075;
      this.desiredCamera.copyFrom(aircraftPosition).addInPlaceFromFloats(
        Math.cos(angle) * 24,
        8.5 + Math.sin(angle * 0.7) * 2,
        Math.sin(angle) * 24,
      );
      this.desiredCameraTarget.copyFrom(aircraftPosition).addInPlace(this.up.scale(1.3));
      fieldOfView = 58;
    } else {
      const profile = chaseCameraProfile(this.aircraft.kind, state.airspeed);
      this.desiredCamera.copyFrom(aircraftPosition)
        .subtractInPlace(this.forward.scale(profile.distance))
        .addInPlace(this.up.scale(profile.height));
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
        this.cameraTerrainSample(cameraWorldX, cameraWorldZ).height,
        this.cameraTerrainSample(
          cameraWorldX + this.forward.x * aheadMeters,
          cameraWorldZ + this.forward.z * aheadMeters,
        ).height,
      );
      if (this.desiredCamera.y < cameraGround + 2.5) {
        this.desiredCamera.y = cameraGround + 2.5;
      }
      this.desiredCameraTarget.copyFrom(aircraftPosition)
        .addInPlace(this.forward.scale(profile.aimAhead))
        .addInPlace(this.up.scale(1.25));
      fieldOfView = profile.fieldOfView;
    }
    const response = cameraPresentationResponse(
      this.cameraMode,
      this.cameraCut,
      this.currentDeltaSeconds,
      this.reducedMotion,
    );
    smoothCameraVectorToRef(
      this.camera.position,
      this.desiredCamera,
      response,
      this.camera.position,
    );
    smoothCameraVectorToRef(
      this.cameraTarget,
      this.desiredCameraTarget,
      response,
      this.cameraTarget,
    );
    // Exterior views communicate a turn without attaching the horizon to
    // every physics/interpolation correction. This restores the restrained
    // 18% chase / 30% cinematic bank used by the playable renderer; cockpit
    // remains physically attached and reduced-motion exterior views stay level.
    Vector3.LerpToRef(
      Vector3.UpReadOnly,
      this.up,
      cameraBankFollow(this.cameraMode, this.reducedMotion),
      this.desiredCameraUp,
    );
    this.desiredCameraUp.normalize();
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
      this.up,
      this.camera.upVector,
    );
    this.camera.setTarget(this.cameraTarget);
    this.camera.fov += (fieldOfView * Math.PI / 180 - this.camera.fov) * response;
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
    this.lightPoints.setFloatingOrigin(this.originX, this.originZ);
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
    this.atmosphere.shadows.mapSize = this.profile.shadowMapSize;
    this.atmosphere.shadows.numCascades = this.profile.shadowCascades;
    this.atmosphere.shadows.shadowMaxZ = this.profile.shadowDistance;
    // Bloom's funding is a per-tier decision, so a profile change can add or
    // remove it. Re-gate BEFORE deriving ownership: which pass is first
    // depends on what is attached.
    this.bloom.setEnabled(this.camera, this.profile.bloomEnabled, this.scotopic.enabled ? 1 : 0);
    this.applyFirstPassOwnership();
    this.camera.detachPostProcess(this.fxaa);
    if (this.profile.msaaSamples === 1) this.camera.attachPostProcess(this.fxaa);
    this.resetTimingWindow();
    this.applyRenderScale();
    this.graph.invalidateHistory("quality profile changed");
  }

  /** Applies the capped scale product; returns whether it actually changed. */
  private applyRenderScale(): boolean {
    // 1A-6a: the device pixel ratio is a per-tier ceiling, not a multiplier the
    // display gets to raise for free, and the total scale product is clamped by
    // an absolute pixel budget. The previous code multiplied DPR into the scale
    // uncapped, so a Retina panel rendered 5.94 Mpx at tier 2 before any work.
    const pixelRatio = Math.min(
      this.profile.maxDevicePixelRatio,
      window.devicePixelRatio || 1,
    );
    const requestedScale = Math.max(0.1, pixelRatio * this.renderScale);
    const cssPixels = Math.max(
      1,
      this.domElement.clientWidth * this.domElement.clientHeight,
    );
    // Rendered pixels = cssPixels × totalScale², so the absolute cap on pixels
    // is a cap of sqrt(maxRenderPixels / cssPixels) on the total scale product.
    const pixelCapScale = Math.sqrt(this.profile.maxRenderPixels / cssPixels);
    const level = 1 / Math.min(requestedScale, pixelCapScale);
    const changed = Math.abs(level - this.engine.getHardwareScalingLevel()) > 1e-4;
    if (changed) this.engine.setHardwareScalingLevel(level);
    this.engine.resize(true);
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
      // step leaves the effective scale unchanged — no history reset, and the
      // anti-ratchet latch learns about it immediately.
      const changed = this.applyRenderScale();
      if (changed) this.graph.invalidateHistory("dynamic resolution changed");
      if (lowered) {
        state = observeRenderScaleApplication(state, changed, this.governorConfig);
        if (Math.abs(state.renderScale - this.renderScale) > 1e-6) {
          this.renderScale = state.renderScale;
          if (this.applyRenderScale()) {
            this.graph.invalidateHistory("dynamic resolution changed");
          }
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
