import * as THREE from "three";
import type {
  CameraMode,
  FlightVisualState,
  QualityLevel,
  RenderDiagnostics,
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";
import type { RenderingMode } from "@/src/settings";
import type { AircraftKind } from "@/src/sim";
import type { WorldDefinition } from "@/src/world";
import { createAircraft, type AircraftVisual } from "./createAircraft";
import { CascadedShadowController } from "./CascadedShadowController";
import {
  detectRenderCapabilities,
  HybridRenderPipeline,
  resolveRenderProfile,
} from "./hybrid";
import { preserveDestinationAlpha } from "./PreserveDestinationAlpha";
import { SkySystem } from "./SkySystem";
import {
  TerrainRenderer,
  WATER_RENDER_LEVEL,
  type RenderRunwayDefinition,
  type TerrainSampleFunction,
} from "./TerrainRenderer";
import { requestedRenderingTelemetryKey, type FlightRenderingSystem } from "./types";

const CAMERA_VIEW_CORRECTION = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  -Math.PI / 2,
);

export function qualityPixelRatio(quality: QualityLevel): number {
  if (quality === "low") return 0.85;
  // Most modern laptops expose a 2x backing store. Rendering medium at 1.1x
  // threw away almost half the linear display resolution before terrain
  // shading even ran, so no amount of material detail could look crisp.
  // Hybrid target caps and the adaptive governor still bound pixel cost.
  if (quality === "high") return 1.75;
  return 1.2;
}

/** One bounded adaptive-resolution decision after a complete timing window. */
export function adaptiveResolutionScale(
  currentScale: number,
  averageFrameMilliseconds: number,
): number {
  const scale = THREE.MathUtils.clamp(
    Number.isFinite(currentScale) ? currentScale : 1,
    0.68,
    1,
  );
  if (!Number.isFinite(averageFrameMilliseconds)) return scale;
  if (averageFrameMilliseconds > 18.5 && scale > 0.68) {
    return Math.max(0.68, scale - 0.08);
  }
  if (averageFrameMilliseconds < 14 && scale < 1) {
    return Math.min(1, scale + 0.04);
  }
  return scale;
}

export interface ChaseCameraProfile {
  distance: number;
  height: number;
  fieldOfView: number;
}

/** Stable aircraft-relative composition; speed never turns the jet into a speck. */
export function chaseCameraProfile(
  aircraft: AircraftKind,
  airspeed: number,
  out: ChaseCameraProfile = { distance: 0, height: 0, fieldOfView: 0 },
): ChaseCameraProfile {
  const jet = aircraft === "jet";
  const baseDistance = jet ? 14.3 : 13.5;
  const speedThreshold = jet ? 145 : 45;
  const speedPush = THREE.MathUtils.clamp(
    (airspeed - speedThreshold) * 0.012,
    0,
    2.2,
  );
  out.distance = baseDistance + speedPush;
  out.height = jet ? 5 : 5.1;
  out.fieldOfView =
    62 + THREE.MathUtils.clamp((airspeed - (jet ? 140 : 38)) * 0.035, 0, 3);
  return out;
}

/** Fog begins beyond the detailed mid-field so terrain texture survives. */
export function atmosphereFogNear(weather: WeatherPreset): number {
  if (weather === "cloudy") return 2_200;
  if (weather === "clear") return 4_500;
  return 3_800;
}

/** Suppresses duplicate atmosphere applications from resetting temporal state. */
export class AtmosphereChangeTracker {
  private timeOfDay: TimeOfDayPreset | null = null;
  private weather: WeatherPreset | null = null;

  update(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): boolean {
    if (timeOfDay === this.timeOfDay && weather === this.weather) return false;
    this.timeOfDay = timeOfDay;
    this.weather = weather;
    return true;
  }
}

/**
 * Releases Three.js-owned GPU resources while keeping the canvas context
 * reusable. World/seed changes construct the replacement renderer on the same
 * canvas immediately; forcing a context loss here races that replacement and
 * leaves the new world on an intentionally destroyed graphics device.
 */
export function disposeReusableWebGLRenderer(
  renderer: Pick<THREE.WebGLRenderer, "dispose">,
): void {
  renderer.dispose();
}

interface WebGLContextEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/**
 * Owns the loss/restoration listeners and keeps rendering paused until the
 * caller confirms that its context-bound resources were rebuilt successfully.
 */
export class WebGLContextLifecycle {
  private paused = false;
  private disposed = false;

  constructor(
    private readonly target: WebGLContextEventTarget,
    private readonly onLost: () => void,
    private readonly onRestored: () => boolean,
  ) {
    target.addEventListener("webglcontextlost", this.handleContextLost);
    target.addEventListener("webglcontextrestored", this.handleContextRestored);
  }

  get renderingPaused(): boolean {
    return this.paused;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target.removeEventListener("webglcontextlost", this.handleContextLost);
    this.target.removeEventListener("webglcontextrestored", this.handleContextRestored);
  }

  private readonly handleContextLost: EventListener = (event): void => {
    event.preventDefault();
    if (this.disposed || this.paused) return;
    this.paused = true;
    this.onLost();
  };

  private readonly handleContextRestored: EventListener = (): void => {
    if (this.disposed || !this.paused) return;
    try {
      this.paused = !this.onRestored();
    } catch {
      // A failed rebuild must never let the next animation frame touch invalid
      // GPU resources. A later restored event or reload can retry safely.
      this.paused = true;
    }
  };
}

/**
 * Projects a preferred camera-up vector onto the plane perpendicular to the
 * view direction. A body-axis fallback prevents Three.js `lookAt` from choosing
 * an arbitrary roll when world-up becomes parallel to a steep-dive view.
 */
export function setOrthogonalCameraUp(
  out: THREE.Vector3,
  preferredUp: THREE.Vector3,
  viewDirection: THREE.Vector3,
  fallbackUp: THREE.Vector3,
): THREE.Vector3 {
  const viewLengthSquared = viewDirection.lengthSq();
  if (!Number.isFinite(viewLengthSquared) || viewLengthSquared < 1e-12) {
    const fallbackLengthSquared = fallbackUp.lengthSq();
    return Number.isFinite(fallbackLengthSquared) && fallbackLengthSquared > 1e-12
      ? out.copy(fallbackUp).normalize()
      : out.set(0, 1, 0);
  }

  const inverseViewLength = 1 / Math.sqrt(viewLengthSquared);
  const viewX = viewDirection.x * inverseViewLength;
  const viewY = viewDirection.y * inverseViewLength;
  const viewZ = viewDirection.z * inverseViewLength;
  const preferredX = preferredUp.x;
  const preferredY = preferredUp.y;
  const preferredZ = preferredUp.z;
  let projection = preferredX * viewX + preferredY * viewY + preferredZ * viewZ;
  out.set(
    preferredX - viewX * projection,
    preferredY - viewY * projection,
    preferredZ - viewZ * projection,
  );

  let upLengthSquared = out.lengthSq();
  if (!Number.isFinite(upLengthSquared) || upLengthSquared < 1e-8) {
    const fallbackX = fallbackUp.x;
    const fallbackY = fallbackUp.y;
    const fallbackZ = fallbackUp.z;
    projection = fallbackX * viewX + fallbackY * viewY + fallbackZ * viewZ;
    out.set(
      fallbackX - viewX * projection,
      fallbackY - viewY * projection,
      fallbackZ - viewZ * projection,
    );
    upLengthSquared = out.lengthSq();
  }

  if (!Number.isFinite(upLengthSquared) || upLengthSquared < 1e-8) {
    // Pick the world cardinal axis least aligned with the view. This final
    // fallback is deterministic even for malformed or exactly vertical poses.
    const useWorldUp = Math.abs(viewY) < 0.8;
    const axisX = useWorldUp ? 0 : 1;
    const axisY = useWorldUp ? 1 : 0;
    projection = axisX * viewX + axisY * viewY;
    out.set(
      axisX - viewX * projection,
      axisY - viewY * projection,
      -viewZ * projection,
    );
  }

  return out.normalize();
}

export function createContactShadow(): THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial> {
  const geometry = new THREE.CircleGeometry(1, 40);
  // CircleGeometry faces +Z. Put it on the local X/Z plane so its normal is +Y.
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      shadowOpacity: { value: 0.28 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float shadowOpacity;
      void main() {
        vec2 centered = (vUv - 0.5) * 2.0;
        float radius = length(centered);
        float core = 1.0 - smoothstep(0.12, 0.98, radius);
        float irregularity = 0.965 + 0.035 * sin(centered.x * 13.0 + centered.y * 9.0);
        gl_FragColor = vec4(vec3(0.035, 0.05, 0.045), core * irregularity * shadowOpacity);
      }
    `,
  });
  preserveDestinationAlpha(material);
  const shadow = new THREE.Mesh(geometry, material);
  shadow.name = "aircraft-contact-shadow";
  shadow.renderOrder = 8;
  shadow.frustumCulled = false;
  return shadow;
}

function createFlightWebGLContext(
  canvas: HTMLCanvasElement,
  antialias: boolean,
): WebGL2RenderingContext {
  const requestedAttributes: WebGLContextAttributes = {
    alpha: false,
    antialias,
    depth: true,
    desynchronized: false,
    failIfMajorPerformanceCaveat: false,
    powerPreference: "high-performance",
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    stencil: false,
  };
  const context = canvas.getContext("webgl2", requestedAttributes);
  if (!context) throw new Error("WebGL 2 is unavailable or hardware acceleration is disabled.");

  // A few virtualized Chromium surfaces expose a functioning WebGL 2 context
  // but incorrectly return null for shader precision queries. Three.js assumes
  // the spec-compliant object is always present and otherwise aborts startup.
  // Patch only that broken query on the individual context; real browsers keep
  // their native implementation untouched.
  const nativePrecisionQuery = context.getShaderPrecisionFormat.bind(context);
  if (nativePrecisionQuery(context.VERTEX_SHADER, context.HIGH_FLOAT) === null) {
    const supportedHighPrecision = {
      rangeMin: 127,
      rangeMax: 127,
      precision: 23,
    } as WebGLShaderPrecisionFormat;
    Object.defineProperty(context, "getShaderPrecisionFormat", {
      configurable: true,
      value: (shaderType: number, precisionType: number) =>
        nativePrecisionQuery(shaderType, precisionType) ?? supportedHighPrecision,
    });
  }

  const nativeAttributesQuery = context.getContextAttributes.bind(context);
  if (nativeAttributesQuery() === null) {
    Object.defineProperty(context, "getContextAttributes", {
      configurable: true,
      value: () => requestedAttributes,
    });
  }

  const nativeParameterQuery = context.getParameter.bind(context);
  if (nativeParameterQuery(context.VERSION) === null) {
    const fallbackParameter = (parameter: number): unknown => {
      if (parameter === context.VERSION) return "WebGL 2.0";
      if (parameter === context.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 32;
      if (parameter === context.MAX_TEXTURE_IMAGE_UNITS) return 16;
      if (parameter === context.MAX_VERTEX_TEXTURE_IMAGE_UNITS) return 16;
      if (parameter === context.MAX_TEXTURE_SIZE) return 8_192;
      if (parameter === context.MAX_CUBE_MAP_TEXTURE_SIZE) return 8_192;
      if (parameter === context.MAX_VERTEX_ATTRIBS) return 16;
      if (parameter === context.MAX_VERTEX_UNIFORM_VECTORS) return 1_024;
      if (parameter === context.MAX_VARYING_VECTORS) return 16;
      if (parameter === context.MAX_FRAGMENT_UNIFORM_VECTORS) return 1_024;
      if (parameter === context.MAX_UNIFORM_BLOCK_SIZE) return 16_384;
      if (parameter === context.MAX_UNIFORM_BUFFER_BINDINGS) return 24;
      if (parameter === context.MAX_SAMPLES) return 4;
      if (parameter === context.SAMPLES) return antialias ? 4 : 0;
      if (parameter === context.SCISSOR_BOX || parameter === context.VIEWPORT) {
        return new Int32Array([0, 0, context.drawingBufferWidth, context.drawingBufferHeight]);
      }
      if (parameter === context.IMPLEMENTATION_COLOR_READ_FORMAT) return context.RGBA;
      if (parameter === context.IMPLEMENTATION_COLOR_READ_TYPE) return context.UNSIGNED_BYTE;
      if (
        parameter === context.UNPACK_ROW_LENGTH ||
        parameter === context.UNPACK_IMAGE_HEIGHT ||
        parameter === context.UNPACK_SKIP_PIXELS ||
        parameter === context.UNPACK_SKIP_ROWS ||
        parameter === context.UNPACK_SKIP_IMAGES
      ) {
        return 0;
      }
      // Do not invent a value/type for a query Three does not currently use.
      // Returning null matches WebGL's unsupported-query behavior and makes a
      // future capability requirement fail explicitly instead of misdetecting.
      return null;
    };
    Object.defineProperty(context, "getParameter", {
      configurable: true,
      value: (parameter: number) => nativeParameterQuery(parameter) ?? fallbackParameter(parameter),
    });
  }
  return context;
}

export interface FlightRendererOptions {
  canvas: HTMLCanvasElement;
  aircraft?: AircraftKind;
  terrainSample: TerrainSampleFunction;
  /** Main-thread resolved world; workers must not repeat airport selection. */
  world: WorldDefinition;
  seed: number;
  quality: QualityLevel;
  renderingMode: RenderingMode;
  reducedMotion: boolean;
  runway?: RenderRunwayDefinition;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export class FlightRenderer implements FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.08, 32_000);
  private readonly aircraft: AircraftVisual;
  private readonly terrain: TerrainRenderer;
  private readonly sky: SkySystem;
  private readonly cascadedShadows: CascadedShadowController;
  private readonly hybridPipeline: HybridRenderPipeline;
  private readonly terrainSample: TerrainSampleFunction;
  private readonly aircraftKind: AircraftKind;
  private readonly contactShadow = createContactShadow();
  private readonly contactNormal = new THREE.Vector3(0, 1, 0);
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly resizeObserver: ResizeObserver;
  private readonly contextLifecycle: WebGLContextLifecycle;
  private readonly atmosphereChanges = new AtmosphereChangeTracker();
  private readonly aircraftQuaternion = new THREE.Quaternion();
  private readonly aircraftPosition = new THREE.Vector3();
  private readonly desiredCameraPosition = new THREE.Vector3();
  private readonly desiredLookTarget = new THREE.Vector3();
  private readonly smoothedLookTarget = new THREE.Vector3();
  private readonly cameraOffset = new THREE.Vector3();
  private readonly chaseProfile: ChaseCameraProfile = {
    distance: 13.5,
    height: 5.1,
    fieldOfView: 62,
  };
  private readonly forward = new THREE.Vector3(1, 0, 0);
  private readonly localUp = new THREE.Vector3(0, 1, 0);
  private readonly localSide = new THREE.Vector3(0, 0, 1);
  private readonly cameraViewDirection = new THREE.Vector3(1, 0, 0);
  private readonly desiredCameraUp = new THREE.Vector3(0, 1, 0);
  private readonly smoothedCameraUp = new THREE.Vector3(0, 1, 0);
  private readonly drawingBufferSize = new THREE.Vector2();
  private readonly renderWorldOrigin = { x: 0, z: 0 };
  private readonly frameSamples = new Float32Array(120);
  private frameSampleIndex = 0;
  private frameSampleCount = 0;
  private originX = 0;
  private originZ = 0;
  private cameraMode: CameraMode = "chase";
  private cameraTrackingInitialized = false;
  private cameraCutPending = true;
  private terrainSceneRevision = -1;
  private quality: QualityLevel;
  private requestedRenderingMode: RenderingMode;
  private renderingMode: RenderingMode;
  private reducedMotion: boolean;
  private dynamicScale = 1;
  private diagnostics: RenderDiagnostics = {
    fps: 0,
    frameTime: 0,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    terrainTiles: 0,
    requestedRenderingMode: "hybrid",
    renderBackend: "webgl2",
    renderTechnique: "planar-screen-space",
    hardwareRayTracing: false,
    renderingFallbackReason: null,
  };

  constructor(options: FlightRendererOptions) {
    this.domElement = options.canvas;
    this.quality = options.quality;
    this.requestedRenderingMode = options.renderingMode;
    this.renderingMode = options.renderingMode;
    this.reducedMotion = options.reducedMotion;
    this.aircraftKind = options.aircraft ?? "trainer";
    this.terrainSample = options.terrainSample;
    const context = createFlightWebGLContext(options.canvas, options.quality !== "low");
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      context,
      antialias: options.quality !== "low",
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    // Hybrid rendering performs several renderer.render() calls per displayed
    // frame. Accumulate their diagnostics and reset explicitly at frame start.
    this.renderer.info.autoReset = false;
    // Medium is the default preset. Disabling both the renderer and the sun at
    // medium meant most players could never see a shadow, so only low opts out.
    this.renderer.shadowMap.enabled = options.quality !== "low";
    // Three r185 maps the removed PCFSoft path back to PCF with a warning.
    // Select the supported filtered shadow implementation explicitly.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x9db4bd, 1);
    this.scene.background = new THREE.Color(0x94b4c1);
    this.scene.fog = new THREE.Fog(0x91a9ac, 2_900, options.quality === "low" ? 8_200 : 11_800);

    this.aircraft = createAircraft(this.aircraftKind);
    this.terrain = new TerrainRenderer(
      options.terrainSample,
      options.seed,
      1_600,
      options.quality,
      options.runway,
      options.world,
    );
    this.sky = new SkySystem(options.seed);
    this.sky.setQuality(options.quality);
    this.sky.sunLight.target = this.aircraft.group;
    this.scene.add(
      this.terrain.group,
      this.contactShadow,
      this.aircraft.group,
      this.sky.group,
    );

    this.camera.position.set(-13, 6, 0);
    this.camera.lookAt(10, 0, 0);
    this.smoothedLookTarget.set(10, 0, 0);
    this.scene.add(this.camera);

    this.resize();
    this.applyPixelRatio();

    this.cascadedShadows = new CascadedShadowController({
      scene: this.scene,
      camera: this.camera,
      sunSource: this.sky.sunLight,
      quality: this.quality,
      renderingMode: this.renderingMode,
      shadowCastingEnabled: this.quality !== "low",
      autoRegisterScene: false,
    });
    this.cascadedShadows.register(this.terrain.group);
    this.cascadedShadows.register(this.aircraft.group);
    this.cascadedShadows.register(this.sky.group);
    this.terrainSceneRevision = this.terrain.sceneRevision;

    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const capabilities = detectRenderCapabilities(context);
    const profile = resolveRenderProfile(
      {
        renderingMode: this.renderingMode,
        quality: this.quality,
        outputWidth: this.drawingBufferSize.x,
        outputHeight: this.drawingBufferSize.y,
      },
      capabilities,
    );
    this.hybridPipeline = new HybridRenderPipeline({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      capabilities,
      profile,
      waterReflection: {
        waterLevel: WATER_RENDER_LEVEL,
        withWaterHidden: (renderReflection) =>
          this.terrain.withWaterSurfaceHidden(renderReflection),
        setReflection: (texture, textureMatrix, strength) =>
          this.terrain.setWaterReflection(texture, textureMatrix, strength),
      },
      waterBathymetry: this.terrain.waterBathymetry,
      prepareReflectionCamera: (reflectionCamera) =>
        this.cascadedShadows.enableLayer(reflectionCamera),
      releaseReflectionCamera: (reflectionCamera) =>
        this.cascadedShadows.restoreCameraLayers(reflectionCamera),
    });
    this.terrain.setHybridWaterCompositeActive(
      this.hybridPipeline.usesHybridComposite(),
    );
    // Register observation only after fallible pipeline construction. A
    // constructor that throws cannot be disposed by its caller, so it must not
    // leave a live observer retaining the half-built renderer.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.canvas);
    this.updateRenderingDataset();
    // Three registered its own restoration hook in WebGLRenderer's constructor,
    // so it restores renderer internals before this later listener rebuilds the
    // simulator-owned targets and permits another frame.
    this.contextLifecycle = new WebGLContextLifecycle(
      options.canvas,
      () => {
        this.hybridPipeline.invalidateHistory("webgl-context-lost");
        options.onContextLost?.();
      },
      () => {
        const rebuilt = this.hybridPipeline.rebuildAfterContextRestore();
        if (rebuilt) {
          this.terrain.setHybridWaterCompositeActive(
            this.hybridPipeline.usesHybridComposite(),
          );
          this.cameraCutPending = true;
          this.renderer.info.reset();
          this.resetFrameTimingHistory();
        }
        this.updateRenderingDataset();
        if (rebuilt) options.onContextRestored?.();
        return rebuilt;
      },
    );
  }

  setCameraMode(mode: CameraMode): void {
    if (mode !== this.cameraMode) {
      this.cameraTrackingInitialized = false;
      this.cameraCutPending = true;
    }
    this.cameraMode = mode;
    this.aircraft.setCockpitView(mode === "cockpit");
    this.camera.fov = mode === "cockpit" ? 69 : mode === "cinematic" ? 54 : 62;
    this.camera.updateProjectionMatrix();
  }

  setQuality(quality: QualityLevel): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.dynamicScale = 1;
    this.resetFrameTimingHistory();
    this.renderer.shadowMap.enabled = quality !== "low";
    this.sky.setQuality(quality);
    this.terrain.setQuality(quality);
    this.cascadedShadows.configure(quality, this.renderingMode);
    this.cascadedShadows.setShadowCastingEnabled(quality !== "low");
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.far = quality === "low" ? 8_200 : quality === "high" ? 13_500 : 11_800;
    }
    this.applyPixelRatio();
    this.updateRenderingDataset();
  }

  setRenderingMode(mode: RenderingMode): void {
    this.requestedRenderingMode = mode;
    const modeChanged = mode !== this.renderingMode;
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const applied = this.hybridPipeline.setProfileRequest({
      renderingMode: mode,
      quality: this.quality,
      outputWidth: this.drawingBufferSize.x,
      outputHeight: this.drawingBufferSize.y,
    });
    if (!applied) {
      // The pipeline retained its known-good profile/resources and exposes the
      // failure in diagnostics. Keep future resizes on that same working mode.
      this.updateRenderingDataset();
      return;
    }
    this.renderingMode = mode;
    this.terrain.setHybridWaterCompositeActive(
      this.hybridPipeline.usesHybridComposite(),
    );
    if (modeChanged) {
      this.resetFrameTimingHistory();
      this.cascadedShadows.configure(this.quality, mode);
      this.cascadedShadows.setShadowCastingEnabled(this.quality !== "low");
      this.cameraCutPending = true;
    }
    this.updateRenderingDataset();
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  setAtmosphere(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): void {
    this.sky.setAtmosphere(timeOfDay, weather);
    this.terrain.setAtmosphere(timeOfDay, weather);
    if (this.scene.fog instanceof THREE.Fog) {
      const qualityFar = this.quality === "low" ? 8_200 : this.quality === "high" ? 13_500 : 11_800;
      const weatherScale = weather === "cloudy" ? 0.68 : weather === "clear" ? 1.12 : 1;
      this.scene.fog.far = qualityFar * weatherScale;
      // Keep nearby and mid-distance geology out of the fog blend. The old
      // 2.9 km start bleached rock/snow variation long before a ridge reached
      // the atmospheric horizon, leaving otherwise detailed mountains pale.
      this.scene.fog.near = atmosphereFogNear(weather);
      this.scene.fog.color.set(
        timeOfDay === "dawn" ? 0x8b9298 : timeOfDay === "golden" ? 0xb5a389 : 0x91a9ac,
      );
    }
    this.renderer.toneMappingExposure =
      timeOfDay === "dawn" ? 0.88 : timeOfDay === "golden" ? 1 : 1.08;
    if (this.atmosphereChanges.update(timeOfDay, weather)) {
      // Sky/fog/color changes invalidate both temporal color reuse and the
      // cached planar reflection, but repeated React/settings echoes do not.
      this.hybridPipeline.invalidateHistory("atmosphere-change");
    }
  }

  render(state: FlightVisualState, deltaSeconds: number): void {
    if (this.contextLifecycle.renderingPaused) return;
    const safeDelta = THREE.MathUtils.clamp(deltaSeconds, 1 / 240, 0.1);
    this.renderer.info.reset();
    const originShifted = this.updateOrigin(state);

    this.aircraftPosition.set(
      state.position.x - this.originX,
      state.position.y,
      state.position.z - this.originZ,
    );
    this.aircraftQuaternion.set(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
      state.orientation.w,
    ).normalize();
    this.aircraft.group.position.copy(this.aircraftPosition);
    this.aircraft.group.quaternion.copy(this.aircraftQuaternion);
    this.aircraft.update(state, safeDelta);

    this.terrain.update(state.position.x, state.position.z, this.originX, this.originZ);
    if (this.terrain.sceneRevision !== this.terrainSceneRevision) {
      this.terrainSceneRevision = this.terrain.sceneRevision;
      this.cascadedShadows.refresh(this.terrain.group);
    }
    this.updateContactShadow(state);
    this.updateCamera(state, safeDelta);
    this.sky.update(this.camera.position, safeDelta, this.originX, this.originZ);
    this.cascadedShadows.update();
    this.hybridPipeline.render({
      cameraCut: this.cameraCutPending,
      originShifted,
      worldOrigin: this.renderWorldOrigin,
    });
    this.cameraCutPending = false;
    this.updateDiagnostics(safeDelta);
  }

  getDiagnostics(): RenderDiagnostics {
    return this.diagnostics;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.contextLifecycle.dispose();
    this.hybridPipeline.dispose();
    this.cascadedShadows.dispose();
    this.aircraft.dispose();
    this.contactShadow.geometry.dispose();
    this.contactShadow.material.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    disposeReusableWebGLRenderer(this.renderer);
  }

  private updateOrigin(state: FlightVisualState): boolean {
    const nextOriginX = Math.round(state.position.x / 4_000) * 4_000;
    const nextOriginZ = Math.round(state.position.z / 4_000) * 4_000;
    if (nextOriginX === this.originX && nextOriginZ === this.originZ) return false;
    const shiftX = nextOriginX - this.originX;
    const shiftZ = nextOriginZ - this.originZ;
    this.camera.position.x -= shiftX;
    this.camera.position.z -= shiftZ;
    this.smoothedLookTarget.x -= shiftX;
    this.smoothedLookTarget.z -= shiftZ;
    this.originX = nextOriginX;
    this.originZ = nextOriginZ;
    this.renderWorldOrigin.x = nextOriginX;
    this.renderWorldOrigin.z = nextOriginZ;
    return true;
  }

  private updateCamera(state: FlightVisualState, deltaSeconds: number): void {
    if (this.cameraMode === "cockpit") {
      this.updateCameraFov(69, deltaSeconds);
      this.cameraOffset.set(1.15, 0.72, 0).applyQuaternion(this.aircraftQuaternion);
      this.camera.position.copy(this.aircraftPosition).add(this.cameraOffset);
      this.camera.quaternion.copy(this.aircraftQuaternion).multiply(CAMERA_VIEW_CORRECTION);
      return;
    }

    const chaseProfile = this.cameraMode === "cinematic"
      ? null
      : chaseCameraProfile(this.aircraftKind, state.airspeed, this.chaseProfile);
    if (this.cameraMode === "cinematic") {
      const angle = state.simulationTime * 0.075;
      this.cameraOffset
        .set(Math.cos(angle) * 15 - 3, 5.2 + Math.sin(angle * 0.7) * 2, Math.sin(angle) * 15)
        .applyQuaternion(this.aircraftQuaternion);
    } else {
      // A jet should not become a distant speck simply because its normal IAS
      // is several times the trainer's. Keep a stable airframe-relative chase
      // distance; the moving terrain and subtle FOV change still convey speed.
      this.cameraOffset
        .set(-(chaseProfile?.distance ?? 13.5), chaseProfile?.height ?? 5.1, 0)
        .applyQuaternion(this.aircraftQuaternion);
    }

    const targetFov = this.cameraMode === "cinematic"
      ? 54
      : (chaseProfile?.fieldOfView ?? 62);
    this.updateCameraFov(targetFov, deltaSeconds);

    this.desiredCameraPosition.copy(this.aircraftPosition).add(this.cameraOffset);
    this.forward.set(1, 0, 0).applyQuaternion(this.aircraftQuaternion);
    this.localUp.set(0, 1, 0).applyQuaternion(this.aircraftQuaternion);
    this.localSide.set(0, 0, 1).applyQuaternion(this.aircraftQuaternion);
    this.desiredLookTarget.copy(this.aircraftPosition);
    if (this.cameraMode === "cinematic") {
      this.desiredLookTarget
        .addScaledVector(this.forward, 4)
        .addScaledVector(this.localUp, 0.4);
    }

    // Spawn changes and resets teleport the simulation state. Smoothing from
    // the previous airborne camera down to a runway spawn makes the aircraft
    // appear to begin in mid-air for nearly a second, so discontinuities snap
    // as one coherent camera cut instead of being treated as ordinary motion.
    const cameraDiscontinuity =
      !this.cameraTrackingInitialized ||
      this.camera.position.distanceToSquared(this.desiredCameraPosition) > 140 * 140;
    if (cameraDiscontinuity) {
      this.cameraCutPending = true;
      const bankFollow = this.reducedMotion ? 0 : this.cameraMode === "cinematic" ? 0.3 : 0.18;
      this.desiredCameraUp.set(0, 1, 0).lerp(this.localUp, bankFollow).normalize();
      this.camera.position.copy(this.desiredCameraPosition);
      this.smoothedLookTarget.copy(this.desiredLookTarget);
      this.cameraViewDirection.subVectors(this.smoothedLookTarget, this.camera.position);
      setOrthogonalCameraUp(
        this.smoothedCameraUp,
        this.desiredCameraUp,
        this.cameraViewDirection,
        this.localUp.lengthSq() > 1e-8 ? this.localUp : this.localSide,
      );
      this.camera.up.copy(this.smoothedCameraUp);
      this.camera.lookAt(this.smoothedLookTarget);
      this.cameraTrackingInitialized = true;
      return;
    }

    const positionRate = this.reducedMotion ? 7.5 : 4.2;
    const lookRate = this.reducedMotion ? 9 : 5.5;
    const positionAlpha = 1 - Math.exp(-positionRate * deltaSeconds);
    const lookAlpha = 1 - Math.exp(-lookRate * deltaSeconds);
    this.camera.position.lerp(this.desiredCameraPosition, positionAlpha);
    if (this.cameraMode === "chase") {
      // The central HUD reticle represents the aircraft flight path. Pointing
      // the camera thirteen metres ahead placed the actual model below it and
      // made control response look disconnected. Chase view now keeps the
      // aircraft origin on the optical centre every frame; cinematic view keeps
      // its deliberately led composition.
      this.smoothedLookTarget.copy(this.desiredLookTarget);
    } else {
      this.smoothedLookTarget.lerp(this.desiredLookTarget, lookAlpha);
    }

    // Follow a small fraction of aircraft bank. A fully stabilized horizon
    // hides control response, while full roll is disorienting in a chase view.
    // This blend keeps terrain readable but makes turns immediately visible.
    const bankFollow = this.reducedMotion ? 0 : this.cameraMode === "cinematic" ? 0.3 : 0.18;
    this.desiredCameraUp.set(0, 1, 0).lerp(this.localUp, bankFollow).normalize();
    this.smoothedCameraUp.lerp(this.desiredCameraUp, lookAlpha);
    this.cameraViewDirection.subVectors(this.smoothedLookTarget, this.camera.position);
    setOrthogonalCameraUp(
      this.smoothedCameraUp,
      this.smoothedCameraUp,
      this.cameraViewDirection,
      this.localUp.lengthSq() > 1e-8 ? this.localUp : this.localSide,
    );
    this.camera.up.copy(this.smoothedCameraUp);
    this.camera.lookAt(this.smoothedLookTarget);
  }

  private updateContactShadow(state: FlightVisualState): void {
    const altitudeAgl = Math.max(0, state.altitudeAgl);
    if (!Number.isFinite(altitudeAgl) || altitudeAgl > 38) {
      this.contactShadow.visible = false;
      return;
    }

    const worldX = state.position.x;
    const worldZ = state.position.z;
    const sampleRadius = 1.6;
    const centerSample = this.terrainSample(worldX, worldZ);
    const centerHeight = centerSample.height;
    const suppliedNormal = centerSample.normal;
    if (
      suppliedNormal &&
      Number.isFinite(suppliedNormal.x) &&
      Number.isFinite(suppliedNormal.y) &&
      Number.isFinite(suppliedNormal.z) &&
      Math.hypot(suppliedNormal.x, suppliedNormal.y, suppliedNormal.z) > 0.1
    ) {
      this.contactNormal
        .set(suppliedNormal.x, suppliedNormal.y, suppliedNormal.z)
        .normalize();
    } else {
      // Lightweight/custom terrain providers may only expose height. Keep a
      // finite-difference fallback for those callers, but the game world takes
      // the one-sample path because its visual sample already contains normal.
      const left = this.terrainSample(worldX - sampleRadius, worldZ).height;
      const right = this.terrainSample(worldX + sampleRadius, worldZ).height;
      const back = this.terrainSample(worldX, worldZ - sampleRadius).height;
      const front = this.terrainSample(worldX, worldZ + sampleRadius).height;
      this.contactNormal
        .set(left - right, sampleRadius * 2, back - front)
        .normalize();
    }

    this.contactShadow.visible = true;
    this.contactShadow.position.set(
      worldX - this.originX,
      centerHeight + 0.055,
      worldZ - this.originZ,
    );
    this.contactShadow.quaternion.setFromUnitVectors(this.worldUp, this.contactNormal);
    const spread = 1 + THREE.MathUtils.smoothstep(altitudeAgl, 0, 38) * 0.62;
    this.contactShadow.scale.set(4.5 * spread, 1, 5.65 * spread);
    // A tight, dark cue at wheel contact gives way to the physically cast sun
    // shadow as altitude increases. This remains available on low quality too.
    this.contactShadow.material.uniforms.shadowOpacity!.value =
      0.285 * Math.exp(-altitudeAgl / 7.5) + (state.onGround ? 0.035 : 0);
  }

  private updateCameraFov(targetFov: number, deltaSeconds: number): void {
    const alpha = 1 - Math.exp(-(this.reducedMotion ? 9 : 3.2) * deltaSeconds);
    const nextFov = THREE.MathUtils.lerp(this.camera.fov, targetFov, alpha);
    if (Math.abs(nextFov - this.camera.fov) < 0.005) return;
    this.camera.fov = nextFov;
    this.camera.updateProjectionMatrix();
  }

  private updateDiagnostics(deltaSeconds: number): void {
    const milliseconds = deltaSeconds * 1_000;
    this.frameSamples[this.frameSampleIndex] = milliseconds;
    this.frameSampleIndex = (this.frameSampleIndex + 1) % this.frameSamples.length;
    this.frameSampleCount = Math.min(this.frameSampleCount + 1, this.frameSamples.length);

    if (this.frameSampleIndex % 30 !== 0) return;
    let total = 0;
    for (let index = 0; index < this.frameSampleCount; index += 1) {
      total += this.frameSamples[index] ?? 0;
    }
    const average = total / Math.max(this.frameSampleCount, 1);
    this.diagnostics = {
      ...this.diagnostics,
      fps: average > 0 ? 1_000 / average : 0,
      frameTime: average,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      terrainTiles: this.terrain.tileCount,
    };

    if (this.frameSampleCount < this.frameSamples.length) return;
    const nextScale = adaptiveResolutionScale(this.dynamicScale, average);
    if (nextScale !== this.dynamicScale) {
      this.dynamicScale = nextScale;
      // A resize changes every render attachment and its workload. Reusing the
      // old 120-frame average immediately scheduled three or four more resizes,
      // producing a visible periodic pulse. Warm a fresh window before another
      // bounded decision.
      this.resetFrameTimingHistory();
      this.applyPixelRatio();
    }
  }

  private resetFrameTimingHistory(): void {
    this.frameSamples.fill(0);
    this.frameSampleIndex = 0;
    this.frameSampleCount = 0;
  }

  private applyPixelRatio(): void {
    const target = qualityPixelRatio(this.quality) * this.dynamicScale;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, target));
    this.resize();
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.hybridPipeline) {
      this.renderer.getDrawingBufferSize(this.drawingBufferSize);
      const previousProfileRevision = this.hybridPipeline.getProfileRevision();
      // Resolve from FlightRenderer's current settings. Using the pipeline's
      // previous profile here left AO/SSR/reflection budgets stuck at the old
      // quality tier after a live Graphics change.
      const applied = this.hybridPipeline.setProfileRequest({
        renderingMode: this.renderingMode,
        quality: this.quality,
        outputWidth: this.drawingBufferSize.x,
        outputHeight: this.drawingBufferSize.y,
      });
      if (applied) {
        this.terrain.setHybridWaterCompositeActive(
          this.hybridPipeline.usesHybridComposite(),
        );
      }
      if (
        applied &&
        this.hybridPipeline.getProfileRevision() !== previousProfileRevision
      ) {
        this.cameraCutPending = true;
      }
      this.updateRenderingDataset();
    }
  }

  private updateRenderingDataset(): void {
    if (!this.hybridPipeline) return;
    const rendering = this.hybridPipeline.getDiagnostics();
    const fallbackReason = rendering.downgradeReasons.join(" ") || null;
    this.diagnostics = {
      ...this.diagnostics,
      requestedRenderingMode: this.requestedRenderingMode,
      renderBackend: "webgl2",
      renderTechnique: rendering.technique,
      hardwareRayTracing: false,
      renderingFallbackReason: fallbackReason,
    };

    // The legacy setting value is a request, not evidence of the technique or
    // backend that is actually running. Keep each axis explicit for automated
    // QA and never publish the ambiguous `data-rendering-mode` attribute.
    delete this.domElement.dataset.renderingMode;
    delete this.domElement.dataset.renderingTechnique;
    this.domElement.dataset.requestedRenderingMode = requestedRenderingTelemetryKey(
      this.requestedRenderingMode,
    );
    this.domElement.dataset.persistedRenderingModeKey = this.requestedRenderingMode;
    this.domElement.dataset.renderingBackend = "webgl2";
    this.domElement.dataset.effectiveRenderingTechnique = rendering.technique;
    this.domElement.dataset.hardwareRayTracing = "false";
    this.domElement.dataset.renderingFallback = fallbackReason ?? "none";
  }
}
