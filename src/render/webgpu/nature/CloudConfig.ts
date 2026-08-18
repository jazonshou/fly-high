import { assertEnvironmentState, type EnvironmentState } from "./EnvironmentState";
import {
  assertFiniteNumber,
  assertPositive,
  assertRange,
  type Vec2,
  type Vec3,
} from "./validation";

export interface VolumetricCloudConfig {
  readonly baseAltitudeMeters: number;
  readonly topAltitudeMeters: number;
  readonly maximumTraceDistanceMeters: number;
  readonly weatherMapWorldSizeMeters: number;
  readonly baseNoiseScaleMeters: number;
  readonly detailNoiseScaleMeters: number;
  readonly detailErosion: number;
  readonly densityMultiplier: number;
  readonly extinctionPerMeter: number;
  readonly powderStrength: number;
  readonly ambientStrength: number;
  readonly forwardPhaseG: number;
  readonly backwardPhaseG: number;
  readonly backwardPhaseBlend: number;
  readonly multipleScatteringFactor: number;
  readonly minimumStepMeters: number;
  readonly maximumStepMeters: number;
  /**
   * 2-5: distance at which the march strides have grown by one extra multiple
   * of themselves (step ×2 at this distance, ×3 at twice it, linear growth).
   * Bounds the sample count of horizon-grazing rays — the slab is 5.7 km
   * thick and a level ray can otherwise spend all 96 steps at near-field
   * resolution inside it.
   */
  readonly stepDoublingDistanceMeters: number;
  readonly maximumViewSteps: number;
  readonly lightSteps: number;
  readonly renderScale: number;
  readonly historyWeight: number;
  readonly historyDepthSigmaMeters: number;
  readonly historyLuminanceClamp: number;
  readonly shadowMapResolution: number;
  readonly shadowWorldSizeMeters: number;
  readonly shadowSteps: number;
  readonly shadowUpdateEveryNFrames: number;
}

export const DEFAULT_VOLUMETRIC_CLOUD_CONFIG: VolumetricCloudConfig = Object.freeze({
  baseAltitudeMeters: 1_500,
  topAltitudeMeters: 7_200,
  // 2-5: the scene far plane is 45 km (1C-4) and aerial perspective is deep
  // into haze well before 90 km — a longer trace buys invisible work. The
  // adopted 180 km default made near-tangent below-base rays (slant-10km's
  // geometry) march ~118 km of slab chord for content the haze swallows.
  maximumTraceDistanceMeters: 90_000,
  weatherMapWorldSizeMeters: 160_000,
  baseNoiseScaleMeters: 18_000,
  detailNoiseScaleMeters: 2_400,
  detailErosion: 0.34,
  densityMultiplier: 1.15,
  extinctionPerMeter: 0.0018,
  powderStrength: 0.65,
  ambientStrength: 0.22,
  forwardPhaseG: 0.72,
  backwardPhaseG: -0.22,
  backwardPhaseBlend: 0.16,
  multipleScatteringFactor: 0.55,
  minimumStepMeters: 70,
  maximumStepMeters: 900,
  // Measured on the 2A rebaseline: without distance growth the sky-heavy
  // shots (slant-10km, ground-2m-lowsun, night) cost 20-32 ms GPU p95 —
  // grazing rays marched the full step budget at near-field stride. 4 km
  // doubling cuts a 60 km traverse from 96 steps to ~55 without touching
  // the near field.
  stepDoublingDistanceMeters: 4_000,
  maximumViewSteps: 96,
  lightSteps: 8,
  renderScale: 0.5,
  historyWeight: 0.92,
  historyDepthSigmaMeters: 700,
  historyLuminanceClamp: 1.35,
  shadowMapResolution: 512,
  // 2-7: 24 km sun-space footprint. 512² over 24 km = 47 m/texel — 3.7×
  // sharper than the old 176 m/texel 90 km planar map, and cheaper: the
  // adopted compute marches from the surface toward the sun, so the old
  // 1/sunDirection.y near-horizon degeneracy does not exist.
  shadowWorldSizeMeters: 24_000,
  shadowSteps: 20,
  shadowUpdateEveryNFrames: 2,
});

export function resolveVolumetricCloudConfig(
  input: Partial<VolumetricCloudConfig> = {},
): VolumetricCloudConfig {
  const config = Object.freeze({ ...DEFAULT_VOLUMETRIC_CLOUD_CONFIG, ...input });
  assertVolumetricCloudConfig(config);
  return config;
}

export function assertVolumetricCloudConfig(config: VolumetricCloudConfig): void {
  assertFiniteNumber(config.baseAltitudeMeters, "cloud.baseAltitudeMeters");
  assertPositive(config.topAltitudeMeters, "cloud.topAltitudeMeters");
  if (config.topAltitudeMeters <= config.baseAltitudeMeters) {
    throw new RangeError("cloud.topAltitudeMeters must exceed baseAltitudeMeters");
  }
  assertPositive(config.maximumTraceDistanceMeters, "cloud.maximumTraceDistanceMeters");
  assertPositive(config.weatherMapWorldSizeMeters, "cloud.weatherMapWorldSizeMeters");
  assertPositive(config.baseNoiseScaleMeters, "cloud.baseNoiseScaleMeters");
  assertPositive(config.detailNoiseScaleMeters, "cloud.detailNoiseScaleMeters");
  assertRange(config.detailErosion, 0, 2, "cloud.detailErosion");
  assertRange(config.densityMultiplier, 0, 10, "cloud.densityMultiplier");
  assertPositive(config.extinctionPerMeter, "cloud.extinctionPerMeter");
  assertRange(config.powderStrength, 0, 4, "cloud.powderStrength");
  assertRange(config.ambientStrength, 0, 4, "cloud.ambientStrength");
  assertRange(config.forwardPhaseG, -0.95, 0.95, "cloud.forwardPhaseG");
  assertRange(config.backwardPhaseG, -0.95, 0.95, "cloud.backwardPhaseG");
  assertRange(config.backwardPhaseBlend, 0, 1, "cloud.backwardPhaseBlend");
  assertRange(config.multipleScatteringFactor, 0, 0.99, "cloud.multipleScatteringFactor");
  assertPositive(config.minimumStepMeters, "cloud.minimumStepMeters");
  assertPositive(config.maximumStepMeters, "cloud.maximumStepMeters");
  if (config.maximumStepMeters < config.minimumStepMeters) {
    throw new RangeError("cloud.maximumStepMeters must be at least minimumStepMeters");
  }
  assertPositive(config.stepDoublingDistanceMeters, "cloud.stepDoublingDistanceMeters");
  assertIntegerRange(config.maximumViewSteps, 8, 192, "cloud.maximumViewSteps");
  assertIntegerRange(config.lightSteps, 2, 16, "cloud.lightSteps");
  assertRange(config.renderScale, 0.25, 1, "cloud.renderScale");
  assertRange(config.historyWeight, 0, 0.99, "cloud.historyWeight");
  assertPositive(config.historyDepthSigmaMeters, "cloud.historyDepthSigmaMeters");
  assertRange(config.historyLuminanceClamp, 1, 8, "cloud.historyLuminanceClamp");
  assertIntegerRange(config.shadowMapResolution, 128, 2_048, "cloud.shadowMapResolution");
  if ((config.shadowMapResolution & (config.shadowMapResolution - 1)) !== 0) {
    throw new RangeError("cloud.shadowMapResolution must be a power of two");
  }
  assertPositive(config.shadowWorldSizeMeters, "cloud.shadowWorldSizeMeters");
  assertIntegerRange(config.shadowSteps, 4, 64, "cloud.shadowSteps");
  assertIntegerRange(
    config.shadowUpdateEveryNFrames,
    1,
    16,
    "cloud.shadowUpdateEveryNFrames",
  );
}

function assertIntegerRange(value: number, minimum: number, maximum: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${path} must be an integer in [${minimum}, ${maximum}]`);
  }
}

export interface CloudFrameState {
  /**
   * The shipped 1B-12 ray convention: unit camera basis + view scale
   * (tan half-fov per axis). The raymarch, temporal reprojection and
   * composite all rebuild rays from this one basis — no view-projection
   * matrix exists anywhere in the cloud pipeline (the 1A-4 bug class).
   */
  readonly cameraForward: Vec3;
  readonly cameraRight: Vec3;
  readonly cameraUp: Vec3;
  readonly viewScale: Vec2;
  /** Camera position relative to EnvironmentState.floatingOriginMeters. */
  readonly cameraPositionMeters: Vec3;
  readonly renderSize: readonly [number, number];
  readonly fullResolutionSize: readonly [number, number];
  readonly frameIndex: number;
  /** Accumulated wind offset, kept bounded by the caller to retain f32 precision. */
  readonly windOffsetMeters: Vec2;
  /** Absolute CPU-world x/z origin of the repeating weather map. */
  readonly weatherMapOriginMeters: Vec2;
}

export function assertCloudFrameState(frame: CloudFrameState): void {
  for (const [vector, path] of [
    [frame.cameraForward, "cameraForward"],
    [frame.cameraRight, "cameraRight"],
    [frame.cameraUp, "cameraUp"],
  ] as const) {
    vector.forEach((value, index) => {
      assertFiniteNumber(value, `cloudFrame.${path}[${index}]`);
    });
  }
  frame.viewScale.forEach((value, index) => {
    assertFiniteNumber(value, `cloudFrame.viewScale[${index}]`);
  });
  frame.cameraPositionMeters.forEach((value, index) => {
    assertFiniteNumber(value, `cloudFrame.cameraPositionMeters[${index}]`);
  });
  frame.windOffsetMeters.forEach((value, index) => {
    assertFiniteNumber(value, `cloudFrame.windOffsetMeters[${index}]`);
  });
  frame.weatherMapOriginMeters.forEach((value, index) => {
    assertFiniteNumber(value, `cloudFrame.weatherMapOriginMeters[${index}]`);
  });
  frame.renderSize.forEach((value, index) => {
    assertIntegerRange(value, 1, 32_768, `cloudFrame.renderSize[${index}]`);
  });
  frame.fullResolutionSize.forEach((value, index) => {
    assertIntegerRange(value, 1, 32_768, `cloudFrame.fullResolutionSize[${index}]`);
  });
  if (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0) {
    throw new RangeError("cloudFrame.frameIndex must be a non-negative integer");
  }
}

function setVec4(
  values: Float32Array,
  row: number,
  x: number,
  y: number,
  z: number,
  w: number,
): void {
  values.set([x, y, z, w], row * 4);
}

/**
 * Packs `CloudRaymarchParams`. Counts and frame index are deliberately floats so
 * the entire dynamic block can be uploaded as one Float32Array without aliasing.
 */
export function packCloudRaymarchUniforms(
  config: VolumetricCloudConfig,
  environment: EnvironmentState,
  frame: CloudFrameState,
): Float32Array {
  assertVolumetricCloudConfig(config);
  assertEnvironmentState(environment);
  assertCloudFrameState(frame);
  const values = new Float32Array(68);
  setVec4(values, 0, ...frame.cameraForward, frame.viewScale[0]);
  setVec4(values, 1, ...frame.cameraRight, frame.viewScale[1]);
  // camera_up.w carries the march's per-meter stride growth rate (2-5).
  setVec4(values, 2, ...frame.cameraUp, 1 / config.stepDoublingDistanceMeters);
  setVec4(values, 3, ...frame.cameraPositionMeters, 0);
  setVec4(
    values,
    4,
    environment.atmosphere.planetCenterMeters[0] - environment.floatingOriginMeters[0],
    environment.atmosphere.planetCenterMeters[1] - environment.floatingOriginMeters[1],
    environment.atmosphere.planetCenterMeters[2] - environment.floatingOriginMeters[2],
    environment.atmosphere.planetRadiusMeters,
  );
  setVec4(values, 5, ...environment.sun.direction, environment.sun.angularRadiusRadians);
  setVec4(
    values,
    6,
    environment.sun.color[0],
    environment.sun.color[1],
    environment.sun.color[2],
    environment.sun.illuminanceLux / 100_000,
  );
  setVec4(
    values,
    7,
    frame.renderSize[0],
    frame.renderSize[1],
    1 / frame.renderSize[0],
    1 / frame.renderSize[1],
  );
  setVec4(
    values,
    8,
    frame.fullResolutionSize[0],
    frame.fullResolutionSize[1],
    frame.frameIndex,
    environment.frameDeltaSeconds,
  );
  setVec4(
    values,
    9,
    environment.atmosphere.planetRadiusMeters + config.baseAltitudeMeters,
    environment.atmosphere.planetRadiusMeters + config.topAltitudeMeters,
    config.maximumTraceDistanceMeters,
    config.densityMultiplier,
  );
  setVec4(
    values,
    10,
    config.baseNoiseScaleMeters,
    config.detailNoiseScaleMeters,
    config.weatherMapWorldSizeMeters,
    config.detailErosion,
  );
  setVec4(
    values,
    11,
    frame.windOffsetMeters[0],
    frame.windOffsetMeters[1],
    environment.timeSeconds,
    environment.weather.cloudCoverage,
  );
  setVec4(
    values,
    12,
    config.minimumStepMeters,
    config.maximumStepMeters,
    config.maximumViewSteps,
    config.lightSteps,
  );
  setVec4(
    values,
    13,
    config.extinctionPerMeter,
    config.powderStrength,
    config.multipleScatteringFactor,
    config.ambientStrength,
  );
  setVec4(
    values,
    14,
    config.forwardPhaseG,
    config.backwardPhaseG,
    config.backwardPhaseBlend,
    environment.weather.precipitation,
  );
  setVec4(
    values,
    15,
    frame.weatherMapOriginMeters[0],
    frame.weatherMapOriginMeters[1],
    config.weatherMapWorldSizeMeters,
    environment.weather.cloudType,
  );
  setVec4(values, 16, ...environment.floatingOriginMeters, 0);
  return values;
}

/**
 * Camera ray bases for the temporal resolve's reprojection (1B-12: previous
 * ray basis + absolute camera delta, never a cached view-projection matrix).
 */
export interface CloudTemporalFrameState {
  readonly renderSize: readonly [number, number];
  readonly cameraCut: boolean;
  readonly currentForward: Vec3;
  readonly currentRight: Vec3;
  readonly currentUp: Vec3;
  readonly currentViewScale: Vec2;
  readonly previousForward: Vec3;
  readonly previousRight: Vec3;
  readonly previousUp: Vec3;
  readonly previousViewScale: Vec2;
  /** Current − previous camera position, ABSOLUTE metres. */
  readonly cameraDeltaMeters: Vec3;
}

/** Binary layout matching `CloudTemporalParams` in CloudShaders.ts. */
export function packCloudTemporalUniforms(
  config: VolumetricCloudConfig,
  frame: CloudTemporalFrameState,
): ArrayBuffer {
  assertVolumetricCloudConfig(config);
  frame.renderSize.forEach((value, index) => {
    assertIntegerRange(value, 1, 32_768, `renderSize[${index}]`);
  });
  for (const [vector, path] of [
    [frame.currentForward, "currentForward"],
    [frame.currentRight, "currentRight"],
    [frame.currentUp, "currentUp"],
    [frame.previousForward, "previousForward"],
    [frame.previousRight, "previousRight"],
    [frame.previousUp, "previousUp"],
  ] as const) {
    vector.forEach((value, index) => {
      assertFiniteNumber(value, `cloudTemporalFrame.${path}[${index}]`);
    });
  }
  frame.cameraDeltaMeters.forEach((value, index) => {
    assertFiniteNumber(value, `cloudTemporalFrame.cameraDeltaMeters[${index}]`);
  });
  const buffer = new ArrayBuffer(144);
  const view = new DataView(buffer);
  view.setUint32(0, frame.renderSize[0], true);
  view.setUint32(4, frame.renderSize[1], true);
  view.setUint32(8, frame.cameraCut ? 1 : 0, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, config.historyWeight, true);
  view.setFloat32(20, config.historyDepthSigmaMeters, true);
  view.setFloat32(24, config.historyLuminanceClamp, true);
  view.setFloat32(28, 0.02, true);
  const values = new Float32Array(buffer);
  setVec4(values, 2, ...frame.currentForward, config.maximumTraceDistanceMeters);
  setVec4(values, 3, ...frame.currentRight, frame.currentViewScale[0]);
  setVec4(values, 4, ...frame.currentUp, frame.currentViewScale[1]);
  setVec4(values, 5, ...frame.previousForward, frame.previousViewScale[0]);
  setVec4(values, 6, ...frame.previousRight, frame.previousViewScale[1]);
  setVec4(values, 7, ...frame.previousUp, 0);
  setVec4(values, 8, ...frame.cameraDeltaMeters, 0);
  return buffer;
}

export interface CloudShadowFrameState {
  /** Surface point at the centre of the shadow footprint, in GPU-local metres. */
  readonly shadowCenterMeters: Vec3;
  readonly eastAxis: Vec3;
  readonly northAxis: Vec3;
  readonly windOffsetMeters: Vec2;
  /** Absolute CPU-world x/z origin of the repeating weather map. */
  readonly weatherMapOriginMeters: Vec2;
  readonly frameIndex: number;
}

function assertUnitVector(vector: Vec3, path: string): void {
  vector.forEach((value, index) => assertFiniteNumber(value, `${path}[${index}]`));
  const length = Math.hypot(...vector);
  if (Math.abs(length - 1) > 1e-4) {
    throw new RangeError(`${path} must be normalized`);
  }
}

/** Binary layout matching `CloudShadowParams` in CloudShaders.ts. */
export function packCloudShadowUniforms(
  config: VolumetricCloudConfig,
  environment: EnvironmentState,
  frame: CloudShadowFrameState,
): ArrayBuffer {
  assertVolumetricCloudConfig(config);
  assertEnvironmentState(environment);
  frame.shadowCenterMeters.forEach((value, index) => {
    assertFiniteNumber(value, `cloudShadowFrame.shadowCenterMeters[${index}]`);
  });
  assertUnitVector(frame.eastAxis, "cloudShadowFrame.eastAxis");
  assertUnitVector(frame.northAxis, "cloudShadowFrame.northAxis");
  if (Math.abs(
    frame.eastAxis[0] * frame.northAxis[0]
      + frame.eastAxis[1] * frame.northAxis[1]
      + frame.eastAxis[2] * frame.northAxis[2],
  ) > 1e-3) {
    throw new RangeError("cloudShadowFrame east and north axes must be orthogonal");
  }
  frame.windOffsetMeters.forEach((value, index) => {
    assertFiniteNumber(value, `cloudShadowFrame.windOffsetMeters[${index}]`);
  });
  frame.weatherMapOriginMeters.forEach((value, index) => {
    assertFiniteNumber(value, `cloudShadowFrame.weatherMapOriginMeters[${index}]`);
  });
  if (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0) {
    throw new RangeError("cloudShadowFrame.frameIndex must be a non-negative integer");
  }

  const buffer = new ArrayBuffer(192);
  const values = new Float32Array(buffer);
  setVec4(
    values,
    0,
    environment.atmosphere.planetCenterMeters[0] - environment.floatingOriginMeters[0],
    environment.atmosphere.planetCenterMeters[1] - environment.floatingOriginMeters[1],
    environment.atmosphere.planetCenterMeters[2] - environment.floatingOriginMeters[2],
    environment.atmosphere.planetRadiusMeters,
  );
  setVec4(values, 1, ...frame.shadowCenterMeters, 0);
  setVec4(values, 2, ...frame.eastAxis, config.shadowWorldSizeMeters);
  setVec4(values, 3, ...frame.northAxis, config.shadowWorldSizeMeters);
  setVec4(values, 4, ...environment.sun.direction, config.shadowSteps);
  setVec4(
    values,
    5,
    environment.atmosphere.planetRadiusMeters + config.baseAltitudeMeters,
    environment.atmosphere.planetRadiusMeters + config.topAltitudeMeters,
    config.densityMultiplier,
    0,
  );
  setVec4(
    values,
    6,
    config.baseNoiseScaleMeters,
    config.detailNoiseScaleMeters,
    config.detailErosion,
    0,
  );
  setVec4(
    values,
    7,
    frame.windOffsetMeters[0],
    frame.windOffsetMeters[1],
    environment.timeSeconds,
    environment.weather.cloudCoverage,
  );
  setVec4(
    values,
    8,
    frame.weatherMapOriginMeters[0],
    frame.weatherMapOriginMeters[1],
    config.weatherMapWorldSizeMeters,
    environment.weather.cloudType,
  );
  setVec4(values, 9, config.extinctionPerMeter, frame.frameIndex, 0, 0);
  setVec4(values, 10, ...environment.floatingOriginMeters, 0);
  const integerValues = new Uint32Array(buffer);
  integerValues[44] = config.shadowMapResolution;
  integerValues[45] = config.shadowMapResolution;
  integerValues[46] = 0;
  integerValues[47] = 0;
  return buffer;
}
