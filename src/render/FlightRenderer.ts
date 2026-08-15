import * as THREE from "three";
import type {
  CameraMode,
  FlightVisualState,
  QualityLevel,
  RenderDiagnostics,
  TimeOfDayPreset,
  WeatherPreset,
} from "@/src/game/types";
import { createAircraft, type AircraftVisual } from "./createAircraft";
import { SkySystem } from "./SkySystem";
import {
  TerrainRenderer,
  type RenderRunwayDefinition,
  type TerrainSampleFunction,
} from "./TerrainRenderer";
import type { FlightRenderingSystem } from "./types";

const CAMERA_VIEW_CORRECTION = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  -Math.PI / 2,
);

function qualityPixelRatio(quality: QualityLevel): number {
  if (quality === "low") return 0.85;
  if (quality === "high") return 1.5;
  return 1.1;
}

function createContactShadow(): THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial> {
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
  terrainSample: TerrainSampleFunction;
  seed: number;
  quality: QualityLevel;
  reducedMotion: boolean;
  runway?: RenderRunwayDefinition;
  onContextLost?: () => void;
}

export class FlightRenderer implements FlightRenderingSystem {
  readonly domElement: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.08, 32_000);
  private readonly aircraft: AircraftVisual;
  private readonly terrain: TerrainRenderer;
  private readonly sky: SkySystem;
  private readonly terrainSample: TerrainSampleFunction;
  private readonly contactShadow = createContactShadow();
  private readonly contactNormal = new THREE.Vector3(0, 1, 0);
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly resizeObserver: ResizeObserver;
  private readonly aircraftQuaternion = new THREE.Quaternion();
  private readonly aircraftPosition = new THREE.Vector3();
  private readonly desiredCameraPosition = new THREE.Vector3();
  private readonly desiredLookTarget = new THREE.Vector3();
  private readonly smoothedLookTarget = new THREE.Vector3();
  private readonly cameraOffset = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(1, 0, 0);
  private readonly localUp = new THREE.Vector3(0, 1, 0);
  private readonly desiredCameraUp = new THREE.Vector3(0, 1, 0);
  private readonly smoothedCameraUp = new THREE.Vector3(0, 1, 0);
  private readonly frameSamples = new Float32Array(120);
  private frameSampleIndex = 0;
  private frameSampleCount = 0;
  private originX = 0;
  private originZ = 0;
  private cameraMode: CameraMode = "chase";
  private cameraTrackingInitialized = false;
  private quality: QualityLevel;
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
  };

  constructor(options: FlightRendererOptions) {
    this.domElement = options.canvas;
    this.quality = options.quality;
    this.reducedMotion = options.reducedMotion;
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
    // Medium is the default preset. Disabling both the renderer and the sun at
    // medium meant most players could never see a shadow, so only low opts out.
    this.renderer.shadowMap.enabled = options.quality !== "low";
    // Three r185 maps the removed PCFSoft path back to PCF with a warning.
    // Select the supported filtered shadow implementation explicitly.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x9db4bd, 1);
    options.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.contextLostListener = options.onContextLost ?? null;

    this.scene.background = new THREE.Color(0x94b4c1);
    this.scene.fog = new THREE.Fog(0x91a9ac, 2_900, options.quality === "low" ? 8_200 : 11_800);

    this.aircraft = createAircraft();
    this.terrain = new TerrainRenderer(
      options.terrainSample,
      options.seed,
      1_600,
      options.quality,
      options.runway,
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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.canvas);
    this.resize();
    this.applyPixelRatio();
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.aircraft.setCockpitView(mode === "cockpit");
    this.camera.fov = mode === "cockpit" ? 69 : mode === "cinematic" ? 54 : 62;
    this.camera.updateProjectionMatrix();
  }

  setQuality(quality: QualityLevel): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.dynamicScale = 1;
    this.renderer.shadowMap.enabled = quality !== "low";
    this.sky.setQuality(quality);
    this.terrain.setQuality(quality);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.far = quality === "low" ? 8_200 : quality === "high" ? 13_500 : 11_800;
    }
    this.applyPixelRatio();
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  setAtmosphere(timeOfDay: TimeOfDayPreset, weather: WeatherPreset): void {
    this.sky.setAtmosphere(timeOfDay, weather);
    if (this.scene.fog instanceof THREE.Fog) {
      const qualityFar = this.quality === "low" ? 8_200 : this.quality === "high" ? 13_500 : 11_800;
      const weatherScale = weather === "cloudy" ? 0.68 : weather === "clear" ? 1.12 : 1;
      this.scene.fog.far = qualityFar * weatherScale;
      this.scene.fog.near = weather === "cloudy" ? 1_800 : 2_900;
      this.scene.fog.color.set(
        timeOfDay === "dawn" ? 0x8b9298 : timeOfDay === "golden" ? 0xb5a389 : 0x91a9ac,
      );
    }
    this.renderer.toneMappingExposure =
      timeOfDay === "dawn" ? 0.88 : timeOfDay === "golden" ? 1 : 1.08;
  }

  render(state: FlightVisualState, deltaSeconds: number): void {
    const safeDelta = THREE.MathUtils.clamp(deltaSeconds, 1 / 240, 0.1);
    this.updateOrigin(state);

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
    this.updateContactShadow(state);
    this.updateCamera(state, safeDelta);
    this.sky.update(this.camera.position, safeDelta, this.originX, this.originZ);
    this.renderer.render(this.scene, this.camera);
    this.updateDiagnostics(safeDelta);
  }

  getDiagnostics(): RenderDiagnostics {
    return this.diagnostics;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.aircraft.dispose();
    this.contactShadow.geometry.dispose();
    this.contactShadow.material.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private contextLostListener: (() => void) | null = null;

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLostListener?.();
  };

  private updateOrigin(state: FlightVisualState): void {
    const nextOriginX = Math.round(state.position.x / 4_000) * 4_000;
    const nextOriginZ = Math.round(state.position.z / 4_000) * 4_000;
    if (nextOriginX === this.originX && nextOriginZ === this.originZ) return;
    const shiftX = nextOriginX - this.originX;
    const shiftZ = nextOriginZ - this.originZ;
    this.camera.position.x -= shiftX;
    this.camera.position.z -= shiftZ;
    this.smoothedLookTarget.x -= shiftX;
    this.smoothedLookTarget.z -= shiftZ;
    this.originX = nextOriginX;
    this.originZ = nextOriginZ;
  }

  private updateCamera(state: FlightVisualState, deltaSeconds: number): void {
    if (this.cameraMode === "cockpit") {
      this.updateCameraFov(69, deltaSeconds);
      this.cameraOffset.set(1.15, 0.72, 0).applyQuaternion(this.aircraftQuaternion);
      this.camera.position.copy(this.aircraftPosition).add(this.cameraOffset);
      this.camera.quaternion.copy(this.aircraftQuaternion).multiply(CAMERA_VIEW_CORRECTION);
      return;
    }

    if (this.cameraMode === "cinematic") {
      const angle = state.simulationTime * 0.075;
      this.cameraOffset
        .set(Math.cos(angle) * 15 - 3, 5.2 + Math.sin(angle * 0.7) * 2, Math.sin(angle) * 15)
        .applyQuaternion(this.aircraftQuaternion);
    } else {
      const speedPush = THREE.MathUtils.clamp((state.airspeed - 45) * 0.035, 0, 4.5);
      this.cameraOffset
        .set(-13.5 - speedPush, 5.1, 0)
        .applyQuaternion(this.aircraftQuaternion);
    }

    const targetFov = this.cameraMode === "cinematic"
      ? 54
      : 62 + THREE.MathUtils.clamp((state.airspeed - 38) * 0.075, 0, 6);
    this.updateCameraFov(targetFov, deltaSeconds);

    this.desiredCameraPosition.copy(this.aircraftPosition).add(this.cameraOffset);
    this.forward.set(1, 0, 0).applyQuaternion(this.aircraftQuaternion);
    this.localUp.set(0, 1, 0).applyQuaternion(this.aircraftQuaternion);
    this.desiredLookTarget
      .copy(this.aircraftPosition)
      .addScaledVector(this.forward, this.cameraMode === "cinematic" ? 4 : 13)
      .addScaledVector(this.localUp, 0.4);

    // Spawn changes and resets teleport the simulation state. Smoothing from
    // the previous airborne camera down to a runway spawn makes the aircraft
    // appear to begin in mid-air for nearly a second, so discontinuities snap
    // as one coherent camera cut instead of being treated as ordinary motion.
    const cameraDiscontinuity =
      !this.cameraTrackingInitialized ||
      this.camera.position.distanceToSquared(this.desiredCameraPosition) > 140 * 140;
    if (cameraDiscontinuity) {
      const bankFollow = this.reducedMotion ? 0 : this.cameraMode === "cinematic" ? 0.3 : 0.18;
      this.desiredCameraUp.set(0, 1, 0).lerp(this.localUp, bankFollow).normalize();
      this.smoothedCameraUp.copy(this.desiredCameraUp);
      this.camera.position.copy(this.desiredCameraPosition);
      this.smoothedLookTarget.copy(this.desiredLookTarget);
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
    this.smoothedLookTarget.lerp(this.desiredLookTarget, lookAlpha);

    const airborneStall = state.stalled && !state.onGround;
    if (!this.reducedMotion && (airborneStall || Math.abs(state.loadFactor - 1) > 1.15)) {
      const buffet = airborneStall ? 0.075 : 0.025;
      this.camera.position.y += Math.sin(state.simulationTime * 41) * buffet;
      this.camera.position.z += Math.sin(state.simulationTime * 37) * buffet * 0.6;
    }
    // Follow a small fraction of aircraft bank. A fully stabilized horizon
    // hides control response, while full roll is disorienting in a chase view.
    // This blend keeps terrain readable but makes turns immediately visible.
    const bankFollow = this.reducedMotion ? 0 : this.cameraMode === "cinematic" ? 0.3 : 0.18;
    this.desiredCameraUp.set(0, 1, 0).lerp(this.localUp, bankFollow).normalize();
    this.smoothedCameraUp.lerp(this.desiredCameraUp, lookAlpha).normalize();
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
      fps: average > 0 ? 1_000 / average : 0,
      frameTime: average,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      terrainTiles: this.terrain.tileCount,
    };

    if (this.frameSampleCount < this.frameSamples.length) return;
    if (average > 23 && this.dynamicScale > 0.68) {
      this.dynamicScale = Math.max(0.68, this.dynamicScale - 0.08);
      this.applyPixelRatio();
    } else if (average < 14.8 && this.dynamicScale < 1) {
      this.dynamicScale = Math.min(1, this.dynamicScale + 0.04);
      this.applyPixelRatio();
    }
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
  }
}
