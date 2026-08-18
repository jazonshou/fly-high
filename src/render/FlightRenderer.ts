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
  QualityLevel,
  RenderDiagnostics,
  WeatherPreset,
} from "@/src/game/types";
import type { EnvironmentClock } from "@/src/world/environmentClock";
import { resolveEnvironmentState } from "./webgpu/nature/EnvironmentDirector";
import {
  DEFAULT_ENVIRONMENT_STATE,
  type EnvironmentState,
} from "./webgpu/nature/EnvironmentState";
import { AerialPerspectiveRegistry } from "./webgpu/atmosphere/AerialPerspective";
import type { RenderingMode } from "@/src/settings";
import type { AircraftKind } from "@/src/sim";
import type { AirportDefinition, TerrainSample, WorldDefinition } from "@/src/world";
import { createWebGpuAircraft, type AircraftVisual } from "./webgpu/aircraft";
import { AtmosphereSystem } from "./webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "./webgpu/clouds/CloudShadowReceiverRegistry";
import { NullTerrainCollisionMirror } from "./webgpu/terrain/TerrainCollisionMirror";
import { VolumetricCloudSystem } from "./webgpu/clouds/VolumetricCloudSystem";
import { inspectWebGpuCapabilities } from "./webgpu/core/Capabilities";
import {
  FrameGraphBudgetProbe,
  PassTimingHistory,
  WebGpuFrameGraph,
} from "./webgpu/core/FrameGraph";
import { assertStartupInvariants } from "./webgpu/core/RenderInvariants";
import {
  cpuWorkSettingsForLevel,
  createGovernorState,
  governorConfigForProfile,
  nextGovernorDecision,
  observeRenderScaleApplication,
  type CpuWorkSettings,
  type GovernorConfig,
  type GovernorSignals,
  type GovernorState,
} from "./webgpu/core/AdaptiveGovernor";
import { estimateGpuMemoryMiB } from "./webgpu/core/PerformanceBudget";
import {
  CAMERA_FAR_PLANE_METERS,
  frameTimingPercentile95,
  freshFrameTiming,
  isUsableFrameTiming,
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "./webgpu/core/QualityProfile";
import { AirportSystem } from "./webgpu/detail/AirportSystem";
import { WorldDetailRuntime } from "./webgpu/detail";
import { TerrainClipmapSystem } from "./webgpu/terrain/TerrainClipmapSystem";
import { WildlifeSystem } from "./webgpu/wildlife";
import { HydrologySystem } from "./webgpu/water/HydrologySystem";
import {
  PlanarWaterReflectionSystem,
  selectPlanarReflectionPlane,
  type PlanarReflectionPlaneSelection,
} from "./webgpu/water/PlanarWaterReflectionSystem";
import { SpectralOceanSystem } from "./webgpu/water/SpectralOceanSystem";
import type { FlightRenderingSystem } from "./types";
import { shouldStabilizeCameraHorizon } from "./cameraPresentation";

const FLOATING_ORIGIN_GRID = 2_048;
const FLOATING_ORIGIN_THRESHOLD = 4_096;
const SCENE_STARTUP_TIMEOUT_MILLISECONDS = 45_000;
const MIN_GPU_TIMING_SAMPLES = 8;
const GPU_TIMING_STALE_AFTER_FRAMES = 30;
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
}

export function chaseCameraProfile(
  aircraft: AircraftKind,
  airspeed: number,
  out: ChaseCameraProfile = { distance: 0, height: 0, fieldOfView: 0 },
): ChaseCameraProfile {
  const jet = aircraft === "jet";
  const baseDistance = jet ? 14.3 : 13.5;
  const speedThreshold = jet ? 145 : 45;
  out.distance = baseDistance + Math.max(0, Math.min(2.2, (airspeed - speedThreshold) * 0.012));
  out.height = jet ? 5 : 5.1;
  out.fieldOfView = 62 + Math.max(0, Math.min(3, (airspeed - (jet ? 140 : 38)) * 0.035));
  return out;
}

export function atmosphereFogNear(weather: WeatherPreset): number {
  return weather === "cloudy" ? 2_200 : weather === "clear" ? 4_500 : 3_800;
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
export class FlightRenderer implements FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  private readonly engine: WebGPUEngine;
  private readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly graph = new WebGpuFrameGraph();
  private readonly aircraft: AircraftVisual;
  private readonly terrain: TerrainClipmapSystem;
  private readonly atmosphere: AtmosphereSystem;
  private readonly clouds: VolumetricCloudSystem;
  private readonly cloudShadowReceivers: CloudShadowReceiverRegistry;
  private readonly aerialReceivers: AerialPerspectiveRegistry;
  private readonly ocean: SpectralOceanSystem;
  private readonly hydrology: HydrologySystem;
  private readonly waterReflection: PlanarWaterReflectionSystem;
  private readonly airport: AirportSystem | null;
  private readonly detail: WorldDetailRuntime;
  private readonly wildlife: WildlifeSystem;
  private readonly toneMap: ImageProcessingPostProcess;
  private readonly fxaa: FxaaPostProcess;
  private readonly resizeObserver: ResizeObserver;
  private readonly atmosphereTracker = new AtmosphereChangeTracker();
  private readonly bodyMatrix = Matrix.Identity();
  private readonly bodyQuaternion = Quaternion.Identity();
  private readonly forward = Vector3.Right();
  private readonly up = Vector3.Up();
  private readonly cameraTarget = Vector3.Zero();
  private readonly desiredCamera = Vector3.Zero();
  private readonly desiredCameraUp = Vector3.Up();
  private readonly cameraWorld = Vector3.Zero();
  private readonly frameIntervalDurations: number[] = [];
  private readonly cpuFrameDurations: number[] = [];
  private readonly gpuFrameDurations: number[] = [];
  private readonly dynamicShadowCasters = new Map<number, Mesh>();
  private readonly adapterLabel: string;
  private readonly seaLevel: number;
  private readonly latitudeDegrees: number;
  private environmentState: EnvironmentState = DEFAULT_ENVIRONMENT_STATE;
  private currentState: FlightVisualState | null = null;
  private currentDeltaSeconds = 1 / 60;
  private profile: WebGpuQualityProfile;
  private quality: QualityLevel;
  private renderingMode: RenderingMode;
  private cameraMode: CameraMode = "chase";
  private reducedMotion: boolean;
  private originX = 0;
  private originZ = 0;
  private reflectionPlaneSelection: PlanarReflectionPlaneSelection | null = null;
  private originShifted = true;
  private cameraCut = true;
  private frameIndex = 0;
  private renderScale: number;
  /** Null until 5-2: physics still samples the analytic kernel directly. */
  private readonly collisionMirror = new NullTerrainCollisionMirror();
  private readonly passTimingHistory = new PassTimingHistory();
  private governorConfig: GovernorConfig;
  private governorState: GovernorState;
  private cpuWorkSettings: CpuWorkSettings = cpuWorkSettingsForLevel(0);
  private governedProfileCache: WebGpuQualityProfile;
  private lastSignals: GovernorSignals = { gpuP95Ms: null, cpuP95Ms: null, intervalP95Ms: null };
  private budgetProbe: FrameGraphBudgetProbe | null = null;
  private budgetProbeReport: RenderDiagnostics["budgetProbeReport"] = null;
  private probeDisabledPass: string | null = null;
  private previousFrameStartedAt: number | null = null;
  private lastFrameIntervalMilliseconds = 0;
  private lastCpuFrameMilliseconds = 0;
  private lastDrawCalls = 0;
  private lastGpuCounterSampleCount = 0;
  private lastGpuFrameMilliseconds: number | null = null;
  private lastGpuTimingFrameIndex = Number.NEGATIVE_INFINITY;
  private deviceLost = false;
  private disposed = false;

  private constructor(
    options: FlightRendererOptions,
    engine: WebGPUEngine,
    scene: Scene,
    camera: UniversalCamera,
    aircraft: AircraftVisual,
    terrain: TerrainClipmapSystem,
    atmosphere: AtmosphereSystem,
    clouds: VolumetricCloudSystem,
    cloudShadowReceivers: CloudShadowReceiverRegistry,
    aerialReceivers: AerialPerspectiveRegistry,
    ocean: SpectralOceanSystem,
    hydrology: HydrologySystem,
    waterReflection: PlanarWaterReflectionSystem,
    airport: AirportSystem | null,
    detail: WorldDetailRuntime,
    wildlife: WildlifeSystem,
    toneMap: ImageProcessingPostProcess,
    fxaa: FxaaPostProcess,
    adapterLabel: string,
  ) {
    this.domElement = options.canvas;
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.aircraft = aircraft;
    this.terrain = terrain;
    this.atmosphere = atmosphere;
    this.clouds = clouds;
    this.cloudShadowReceivers = cloudShadowReceivers;
    this.aerialReceivers = aerialReceivers;
    this.ocean = ocean;
    this.hydrology = hydrology;
    this.waterReflection = waterReflection;
    this.airport = airport;
    this.detail = detail;
    this.wildlife = wildlife;
    this.toneMap = toneMap;
    this.fxaa = fxaa;
    this.adapterLabel = adapterLabel;
    this.seaLevel = options.world.seaLevel;
    this.latitudeDegrees = options.world.latitudeDegrees;
    this.quality = options.quality;
    this.renderingMode = options.renderingMode;
    this.reducedMotion = options.reducedMotion;
    this.profile = resolveWebGpuQualityProfile(this.quality, this.renderingMode);
    this.governorConfig = governorConfigForProfile(this.profile);
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
    this.engine.onContextLostObservable.add(() => {
      if (this.disposed || this.deviceLost) return;
      this.deviceLost = true;
      options.onDeviceLost?.("The WebGPU device was lost. The renderer must be recreated.");
    });
    this.domElement.dataset.rendererMode = "webgpu";
    this.domElement.dataset.renderTechnique = "forward-spectral-volumetric";
  }

  static async create(options: FlightRendererOptions): Promise<FlightRenderer> {
    const capability = await awaitRendererStartup(
      inspectWebGpuCapabilities(),
      options.signal,
      "WebGPU capability discovery",
      15_000,
    );
    if (!capability.supported) throw new Error(capability.reason ?? "WebGPU is unavailable.");
    throwIfRendererStartupAborted(options.signal);
    const timestampQueries = capability.features.has("timestamp-query");
    const requiredFeatures: GPUFeatureName[] = timestampQueries ? ["timestamp-query"] : [];
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
    const cleanup: Array<() => void> = [() => engine.dispose()];
    try {
      throwIfRendererStartupAborted(options.signal);
      engine.compatibilityMode = false;
      engine.useReverseDepthBuffer = true;
      engine.enableGPUTimingMeasurements = timestampQueries;
      assertStartupInvariants({
        timestampQuerySupported: timestampQueries,
        gpuTimingEnabled: engine.enableGPUTimingMeasurements,
        requestedFeatures: requiredFeatures,
        grantedFeatures: engine.enabledExtensions,
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
      const atmosphere = new AtmosphereSystem(
        scene,
        camera,
        profile,
        options.world.prevailingWindRadians,
      );
      cleanup.push(() => atmosphere.dispose());
      const terrain = new TerrainClipmapSystem(scene, options.world, profile);
      cleanup.push(() => terrain.dispose());
      const aircraft = createWebGpuAircraft(scene, options.aircraft);
      cleanup.push(() => aircraft.dispose());
      for (const mesh of aircraft.meshes) {
        if (mesh.metadata?.castsShadow === false) continue;
        atmosphere.shadows.addShadowCaster(mesh, false);
      }
      const airportDefinition = options.runway ?? options.world.airport;
      const airport = airportDefinition ? new AirportSystem(scene, airportDefinition) : null;
      if (airport) cleanup.push(() => airport.dispose());
      if (airport) {
        airport.setFloatingOrigin(0, 0);
        for (const mesh of airport.shadowCasters) atmosphere.addShadowCaster(mesh, false);
      }
      const detail = new WorldDetailRuntime(scene, {
        worldSeed: options.world.seed,
        terrainSample: options.terrainSample,
        seaLevelMeters: options.world.seaLevel,
        workerWorldSeed: options.world.seed,
      });
      cleanup.push(() => detail.dispose());
      const wildlife = new WildlifeSystem(scene, {
        worldSeed: options.world.seed,
        terrainSample: options.terrainSample,
      });
      cleanup.push(() => wildlife.dispose());
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
          windDirectionRadians: options.world.prevailingWindRadians,
        },
        options.signal,
      );
      cleanup.push(() => hydrology.dispose());
      hydrology.setFloatingOrigin(0, 0);
      const clouds = new VolumetricCloudSystem(scene, camera, profile, atmosphere.snapshot);
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
      }, 0, 0);
      const initialAerialBinding = aerialReceivers.currentBinding;
      if (initialAerialBinding) {
        atmosphere.setAerialPerspective(initialAerialBinding);
        ocean.setAerialPerspective(initialAerialBinding);
        hydrology.setAerialPerspective(initialAerialBinding);
        clouds.setAerialPerspective(initialAerialBinding);
      }
      const initialCloudShadow = clouds.cloudShadow;
      terrain.setCloudShadow(initialCloudShadow);
      ocean.setCloudShadow(initialCloudShadow);
      hydrology.setCloudShadow(initialCloudShadow);
      ocean.setSunShadows(atmosphere.shadows);
      hydrology.setSunShadows(atmosphere.shadows);
      cloudShadowReceivers.setProjection(initialCloudShadow, 0, 0);

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
      // 1B-11: the first post-process owns the offscreen scene target (and
      // its depth buffer), so this is where MSAA lives. 4× is genuinely
      // cheap on Apple TBDR — the cost is the resolve, not 4× bandwidth.
      toneMap.samples = profile.msaaSamples;
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
        timestampQuerySupported: timestampQueries,
        gpuTimingEnabled: engine.enableGPUTimingMeasurements,
        requestedFeatures: requiredFeatures,
        grantedFeatures: engine.enabledExtensions,
        imageProcessingAppliedByPostProcess:
          scene.imageProcessingConfiguration.applyByPostProcess,
        sceneFogMode: scene.fogMode,
      });

      await awaitRendererStartup(
        scene.whenReadyAsync(),
        options.signal,
        "WebGPU scene startup",
        SCENE_STARTUP_TIMEOUT_MILLISECONDS,
      );
      throwIfRendererStartupAborted(options.signal);
      // Allocate only after the beauty scene is ready. The manually scheduled
      // target does no reflection draw or render-pass shader work at startup.
      const waterReflection = new PlanarWaterReflectionSystem(
        scene,
        camera,
        options.world.seaLevel,
        profile,
        [ocean, hydrology],
      );
      cleanup.push(() => waterReflection.dispose());
      const info = engine.getInfo();
      const renderer = new FlightRenderer(
        options,
        engine,
        scene,
        camera,
        aircraft,
        terrain,
        atmosphere,
        clouds,
        cloudShadowReceivers,
        aerialReceivers,
        ocean,
        hydrology,
        waterReflection,
        airport,
        detail,
        wildlife,
        toneMap,
        fxaa,
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
    this.atmosphere.applyEnvironment(this.environmentState);
    this.clouds.setAtmosphere(this.atmosphere.snapshot);
    this.ocean.setAtmosphere(this.atmosphere.snapshot);
    this.hydrology.setAtmosphere(this.atmosphere.snapshot);
    this.graph.invalidateHistory("atmosphere changed");
  }

  render(state: FlightVisualState, deltaSeconds: number): void {
    if (this.disposed) return;
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
    const freshGpuSample = this.captureGpuFrameTiming();
    if (this.budgetProbe !== null) {
      // Probe stages deliberately perturb the frame; the governor sits out.
      this.updateBudgetProbe(freshGpuSample);
    } else if (this.frameIntervalDurations.length >= this.governorConfig.windowFrames) {
      this.updateGovernor();
    }
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
    return {
      fps: this.engine.getFps(),
      frameTime: this.lastFrameIntervalMilliseconds,
      cpuFrameTime: this.lastCpuFrameMilliseconds,
      gpuFrameTime,
      drawCalls: this.lastDrawCalls,
      triangles: Math.round(this.scene.getActiveIndices() / 3),
      geometries: this.scene.geometries.length,
      textures: this.scene.textures.length,
      terrainTiles: terrain.residentPages,
      residentTerrainPages: terrain.residentPages,
      collisionSamplesServedByFallback: this.collisionMirror.fallbackSampleCount,
      visibleInstances: this.detail.statistics.renderedThinInstances + wildlife.renderedThinInstances,
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
      activeGovernor: this.governorState.mode,
      gpuP95Ms: this.lastSignals.gpuP95Ms,
      cpuP95Ms: this.lastSignals.cpuP95Ms,
      cpuWorkLevel: this.governorState.cpuWorkLevel,
      cpuWorkLever: this.governorState.lastLever,
      resolutionInsensitive: this.governorState.resolutionInsensitive,
      renderPixels: this.engine.getRenderWidth() * this.engine.getRenderHeight(),
      topPassesByCpuMs: this.passTimingHistory
        .topByP95(4)
        .map((pass) => ({ name: pass.name, p95Ms: pass.p95Ms })),
      pendingTerrainPages: terrain.pendingPages,
      terrainWorkersBusy: terrain.workersBusy,
      estimatedGpuMemoryMiB: estimateGpuMemoryMiB(this.profile, {
        cssWidth: Math.max(1, this.domElement.clientWidth),
        cssHeight: Math.max(1, this.domElement.clientHeight),
        devicePixelRatio: window.devicePixelRatio || 1,
      }),
      budgetProbeActive: this.budgetProbe !== null,
      budgetProbeReport: this.budgetProbeReport,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
      () => this.terrain.dispose(),
      () => this.wildlife.dispose(),
      () => this.detail.dispose(),
      () => this.airport?.dispose(),
      () => this.clouds.dispose(),
      () => this.hydrology.dispose(),
      () => this.ocean.dispose(),
      () => this.cloudShadowReceivers.dispose(),
      () => this.aerialReceivers.dispose(),
      () => this.waterReflection.dispose(),
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
    this.graph.register({
      name: "shared-planar-water-reflection",
      phase: "opaque",
      after: ["world-page-visibility"],
      execute: (frame) => {
        const plane = selectPlanarReflectionPlane(
          this.seaLevel,
          { x: this.cameraWorld.x, y: this.cameraWorld.y, z: this.cameraWorld.z },
          this.hydrology.reflectionLakes,
          this.reflectionPlaneSelection,
        );
        this.reflectionPlaneSelection = plane;
        this.waterReflection.setPlaneHeight(plane.height, plane.source);
        this.waterReflection.update(frame);
      },
      invalidateHistory: () => this.waterReflection.invalidate(),
    });
    this.graph.register({
      name: "spectral-ocean-compute",
      phase: "water",
      after: ["shared-planar-water-reflection"],
      execute: (frame) => {
        this.ocean.update(this.cameraWorld, frame.timeSeconds, frame.deltaSeconds);
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
    this.aircraft.root.position.set(
      state.position.x - this.originX,
      state.position.y,
      state.position.z - this.originZ,
    );
    this.aircraft.root.rotationQuaternion?.copyFrom(this.bodyQuaternion);
    this.aircraft.update(state, this.currentDeltaSeconds);
    this.updateCamera(state);
    this.cameraWorld.set(
      this.camera.position.x + this.originX,
      this.camera.position.y,
      this.camera.position.z + this.originZ,
    );
    this.atmosphere.update(this.camera.position);
    this.updateAerialPerspective();
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
    }, this.originX, this.originZ);
    const binding = this.aerialReceivers.currentBinding;
    if (!binding) return;
    this.atmosphere.setAerialPerspective(binding);
    this.ocean.setAerialPerspective(binding);
    this.hydrology.setAerialPerspective(binding);
    this.clouds.setAerialPerspective(binding);
  }

  private updateCamera(state: FlightVisualState): void {
    const aircraftPosition = this.aircraft.root.position;
    let fieldOfView = 62;
    if (this.cameraMode === "cockpit") {
      this.desiredCamera.copyFrom(aircraftPosition)
        .addInPlace(this.forward.scale(1.15))
        .addInPlace(this.up.scale(1.12));
      this.cameraTarget.copyFrom(this.desiredCamera).addInPlace(this.forward.scale(400));
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
      this.cameraTarget.copyFrom(aircraftPosition).addInPlace(this.up.scale(1.3));
      fieldOfView = 58;
    } else {
      const profile = chaseCameraProfile(this.aircraft.kind, state.airspeed);
      this.desiredCamera.copyFrom(aircraftPosition)
        .subtractInPlace(this.forward.scale(profile.distance))
        .addInPlace(this.up.scale(profile.height));
      this.cameraTarget.copyFrom(aircraftPosition)
        .addInPlace(this.forward.scale(16))
        .addInPlace(this.up.scale(1.25));
      fieldOfView = profile.fieldOfView;
    }
    const response = this.cameraCut
      ? 1
      : 1 - Math.exp(-this.currentDeltaSeconds * (this.reducedMotion ? 12 : 7));
    Vector3.LerpToRef(this.camera.position, this.desiredCamera, response, this.camera.position);
    if (shouldStabilizeCameraHorizon(this.cameraMode, this.reducedMotion)) {
      this.desiredCameraUp.copyFromFloats(0, 1, 0);
      Vector3.LerpToRef(
        this.camera.upVector,
        this.desiredCameraUp,
        response,
        this.camera.upVector,
      );
      this.camera.upVector.normalize();
    } else {
      // Cockpit and non-stabilized views retain the aircraft's physical roll.
      this.camera.upVector.copyFrom(this.up);
    }
    this.camera.setTarget(this.cameraTarget);
    this.camera.fov += (fieldOfView * Math.PI / 180 - this.camera.fov) * response;
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
    }, this.frameIndex);
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
    );
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
    // Governor B lever 6 shortens caster registration reach under CPU load.
    this.terrain.addShadowCasters(collect, this.cpuWorkSettings.shadowCasterDistanceMeters);
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
    this.originX = Math.round(state.position.x / FLOATING_ORIGIN_GRID) * FLOATING_ORIGIN_GRID;
    this.originZ = Math.round(state.position.z / FLOATING_ORIGIN_GRID) * FLOATING_ORIGIN_GRID;
    this.terrain.setFloatingOrigin(this.originX, this.originZ);
    this.ocean.setFloatingOrigin(this.originX, this.originZ);
    this.hydrology.setFloatingOrigin(this.originX, this.originZ);
    this.airport?.setFloatingOrigin(this.originX, this.originZ);
    // The planar reflection pass runs before the cloud update in the frame
    // graph. Re-resolve the shared PBR receiver binding immediately so the
    // reflected scene never combines rebased geometry with the prior origin.
    this.cloudShadowReceivers.setProjection(
      this.clouds.cloudShadow,
      this.originX,
      this.originZ,
    );
    this.cameraCut = true;
    this.graph.invalidateHistory("floating origin shifted");
    return true;
  }

  private applyProfile(): void {
    this.profile = resolveWebGpuQualityProfile(this.quality, this.renderingMode);
    // A profile change resets the governor entirely — including any
    // resolution-insensitive latch, per its re-arm contract.
    this.governorConfig = governorConfigForProfile(this.profile);
    this.governorState = createGovernorState(this.governorConfig);
    this.renderScale = this.governorState.renderScale;
    this.applyCpuWorkLevel(0);
    this.terrain.setProfile(this.profile);
    this.clouds.setProfile(this.profile);
    this.ocean.setProfile(this.profile);
    this.waterReflection.setProfile(this.profile);
    this.atmosphere.shadows.mapSize = this.profile.shadowMapSize;
    this.atmosphere.shadows.numCascades = this.profile.shadowCascades;
    this.atmosphere.shadows.shadowMaxZ = this.profile.shadowDistance;
    if (this.toneMap.samples !== this.profile.msaaSamples) {
      this.toneMap.samples = this.profile.msaaSamples;
      this.camera.detachPostProcess(this.fxaa);
      if (this.profile.msaaSamples === 1) this.camera.attachPostProcess(this.fxaa);
    }
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
    if (state.cpuWorkLevel !== previous.cpuWorkLevel) {
      this.applyCpuWorkLevel(state.cpuWorkLevel);
    }
    this.governorState = state;
  }

  /** Push Governor B's ladder notch into every lever's subsystem seam. */
  private applyCpuWorkLevel(level: number): void {
    const settings = cpuWorkSettingsForLevel(level);
    this.cpuWorkSettings = settings;
    this.terrain.setRequestBudgetPerUpdate(settings.terrainPageRequestsPerUpdate);
    this.detail.setGenerationBudgetCap(
      settings.detailCellBudgetMs >= 2 && settings.detailCellCap >= 24
        ? null
        : {
            maximumCells: settings.detailCellCap,
            maximumMilliseconds: settings.detailCellBudgetMs,
          },
    );
    this.waterReflection.setUpdateIntervalFloor(settings.planarReflectionIntervalFrames);
    this.clouds.setShadowIntervalFloor(settings.cloudShadowIntervalFrames);
    this.governedProfileCache = this.resolveGovernedProfile();
  }

  /** The profile with Governor B's animal and vegetation caps applied. */
  private resolveGovernedProfile(): WebGpuQualityProfile {
    const settings = this.cpuWorkSettings;
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
    if (!isUsableFrameTiming(interval)) {
      // A suspended/background tab must not poison a later active-window p95.
      this.lastFrameIntervalMilliseconds = 0;
      this.resetTimingSamples();
      return;
    }
    this.lastFrameIntervalMilliseconds = interval;
    this.frameIntervalDurations.push(interval);
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
    return milliseconds;
  }

  private resetTimingSamples(): void {
    this.frameIntervalDurations.length = 0;
    this.cpuFrameDurations.length = 0;
    this.gpuFrameDurations.length = 0;
  }

  private resetTimingWindow(): void {
    this.resetTimingSamples();
    this.previousFrameStartedAt = null;
    this.lastFrameIntervalMilliseconds = 0;
    this.lastCpuFrameMilliseconds = 0;
    this.lastGpuFrameMilliseconds = null;
    this.lastGpuTimingFrameIndex = Number.NEGATIVE_INFINITY;
    this.lastGpuCounterSampleCount = this.engine.enableGPUTimingMeasurements
      ? this.engine.getGPUFrameTimeCounter().count
      : 0;
  }
}
