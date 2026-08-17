import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture.pure";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { DEFAULT_VOLUMETRIC_CLOUD_CONFIG } from "@/src/render/webgpu/nature/CloudConfig";
import type { CloudShadowProjection } from "./CloudShadowReceiver";
import {
  resolveCloudRenderSize,
  resolveCloudShadowSchedule,
  shouldRenderCloudShadow,
  type CloudRenderSize,
  type CloudShadowSchedule,
} from "./runtimePolicy";

const CLOUD_COMPOSITE_SHADER_NAME = "aerolithVolumetricCloudComposite";
const CLOUD_SHELL_DIAMETER_METERS = 118_000;
const CLOUD_SHADOW_REFERENCE_ALTITUDE_METERS = 0;
const CLOUD_AMBIENT_COLOR = new Color3(0.18, 0.27, 0.42);
const CLOUD_SHADER_STARTUP_TIMEOUT_MILLISECONDS = 15_000;
const CLOUD_SHADER_READINESS_POLL_MILLISECONDS = 8;

interface CloudEffectReadinessState {
  getCompilationError(): string;
}

interface CloudPipelineReadinessTarget {
  readonly label: string;
  isReady(): boolean;
  getEffect(): CloudEffectReadinessState | null | undefined;
  warm?(): void;
}

function cloudStartupAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

const CLOUD_SHELL_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
  // Babylon's reversed-Z target clears to zero. A tiny positive NDC depth
  // passes even on strict-greater pipelines, while remaining behind every
  // practical terrain/aircraft depth so the composite stays in sky pixels.
  vertexOutputs.position.z = vertexOutputs.position.w * 0.0000001;
}
`;

const CLOUD_RUNTIME_DENSITY_WGSL = /* wgsl */ `
fn hash31(point: vec3f) -> f32 {
  var p = fract(point * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

fn valueNoise(point: vec3f) -> f32 {
  let cell = floor(point);
  let fraction = fract(point);
  let blend = fraction * fraction * (3.0 - 2.0 * fraction);
  let n000 = hash31(cell + vec3f(0.0, 0.0, 0.0));
  let n100 = hash31(cell + vec3f(1.0, 0.0, 0.0));
  let n010 = hash31(cell + vec3f(0.0, 1.0, 0.0));
  let n110 = hash31(cell + vec3f(1.0, 1.0, 0.0));
  let n001 = hash31(cell + vec3f(0.0, 0.0, 1.0));
  let n101 = hash31(cell + vec3f(1.0, 0.0, 1.0));
  let n011 = hash31(cell + vec3f(0.0, 1.0, 1.0));
  let n111 = hash31(cell + vec3f(1.0, 1.0, 1.0));
  let x00 = mix(n000, n100, blend.x);
  let x10 = mix(n010, n110, blend.x);
  let x01 = mix(n001, n101, blend.x);
  let x11 = mix(n011, n111, blend.x);
  return mix(mix(x00, x10, blend.y), mix(x01, x11, blend.y), blend.z);
}

fn baseFbm(point: vec3f) -> f32 {
  var p = point;
  var value = 0.0;
  var amplitude = 0.58;
  for (var octave = 0; octave < 3; octave += 1) {
    value += valueNoise(p) * amplitude;
    p = p * 2.07 + vec3f(11.7, 5.3, 17.1);
    amplitude *= 0.47;
  }
  return value;
}

fn cloudDensity(worldPoint: vec3f) -> f32 {
  let baseUndulation = (
    valueNoise(vec3f(worldPoint.x * 0.000035, 4.7, worldPoint.z * 0.000035)) - 0.5
  ) * 760.0;
  let localBaseAltitude = uniforms.baseAltitude + baseUndulation;
  let height = clamp(
    (worldPoint.y - localBaseAltitude) / max(uniforms.topAltitude - localBaseAltitude, 1.0),
    0.0,
    1.0,
  );
  let vertical = smoothstep(0.0, 0.12, height)
    * (1.0 - smoothstep(0.62, 1.0, height));
  if (vertical <= 0.0001) { return 0.0; }

  let advected = worldPoint + uniforms.wind * uniforms.time;
  let weatherPoint = vec3f(
    advected.x / uniforms.baseNoiseScale,
    1.7 + advected.y / (uniforms.baseNoiseScale * 2.3),
    advected.z / uniforms.baseNoiseScale,
  );
  let weather = baseFbm(weatherPoint);
  let threshold = 1.04 - uniforms.coverage * 0.78 - uniforms.humidity * 0.1;
  if (weather < threshold - 0.24) { return 0.0; }

  let shape = baseFbm(advected / (uniforms.baseNoiseScale * 0.38) + vec3f(7.1, 0.0, 13.7));
  var body = smoothstep(threshold, threshold + 0.3, weather * 0.68 + shape * 0.54);
  if (body <= 0.001) { return 0.0; }
  let erosion = valueNoise(advected / uniforms.detailNoiseScale + vec3f(31.0));
  body -= (1.0 - erosion) * uniforms.detailErosion * 0.42 * (1.0 - body);
  return clamp(body * vertical * uniforms.densityMultiplier, 0.0, 1.5);
}
`;

export const CLOUD_INTEGRATION_FRAGMENT_WGSL = /* wgsl */ `
varying vUV: vec2f;
uniform cameraLocal: vec3f;
uniform cameraWorld: vec3f;
uniform cameraForward: vec3f;
uniform cameraRight: vec3f;
uniform cameraUp: vec3f;
uniform viewScale: vec2f;
uniform sunDirection: vec3f;
uniform wind: vec3f;
uniform time: f32;
uniform coverage: f32;
uniform humidity: f32;
uniform raySteps: f32;
uniform lightSteps: f32;
uniform frameIndex: f32;
uniform baseAltitude: f32;
uniform topAltitude: f32;
uniform maximumTraceDistance: f32;
uniform baseNoiseScale: f32;
uniform detailNoiseScale: f32;
uniform detailErosion: f32;
uniform densityMultiplier: f32;
uniform extinctionPerMeter: f32;

${CLOUD_RUNTIME_DENSITY_WGSL}

fn viewRay(uv: vec2f) -> vec3f {
  // Build the ray from the camera basis. This avoids projection-matrix Y and
  // half-Z conventions leaking into an offscreen ProceduralTexture pass.
  let ndc = uv * 2.0 - 1.0;
  return normalize(
    uniforms.cameraForward
      + uniforms.cameraRight * ndc.x * uniforms.viewScale.x
      + uniforms.cameraUp * ndc.y * uniforms.viewScale.y
  );
}

fn layerInterval(direction: vec3f) -> vec2f {
  if (abs(direction.y) < 0.0001) { return vec2f(1e30, -1e30); }
  let first = (uniforms.baseAltitude - uniforms.cameraWorld.y) / direction.y;
  let second = (uniforms.topAltitude - uniforms.cameraWorld.y) / direction.y;
  return vec2f(
    max(0.0, min(first, second)),
    min(uniforms.maximumTraceDistance, max(first, second)),
  );
}

fn lightTransmittance(point: vec3f) -> f32 {
  var opticalDepth = 0.0;
  var samplePoint = point;
  var stepLength = (uniforms.topAltitude - uniforms.baseAltitude)
    / max(uniforms.lightSteps, 1.0) * 0.55;
  for (var sampleIndex = 0; sampleIndex < 16; sampleIndex += 1) {
    if (f32(sampleIndex) >= uniforms.lightSteps) { break; }
    samplePoint += normalize(uniforms.sunDirection) * stepLength;
    opticalDepth += cloudDensity(samplePoint) * stepLength;
    stepLength *= 1.18;
  }
  return exp(-opticalDepth * uniforms.extinctionPerMeter);
}

fn hg(cosTheta: f32, asymmetry: f32) -> f32 {
  let g2 = asymmetry * asymmetry;
  return (1.0 - g2)
    / max(12.56637 * pow(1.0 + g2 - 2.0 * asymmetry * cosTheta, 1.5), 0.001);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let direction = viewRay(input.vUV);
  let interval = layerInterval(direction);
  if (interval.y <= interval.x) {
    fragmentOutputs.color = vec4f(0.0);
    return fragmentOutputs;
  }

  let steps = clamp(uniforms.raySteps, 8.0, 192.0);
  let stepLength = (interval.y - interval.x) / steps;
  let jitter = hash31(vec3f(input.position.xy, uniforms.frameIndex)) - 0.5;
  var distance = interval.x + stepLength * (0.5 + jitter * 0.72);
  var transmittance = 1.0;
  var directCoefficient = 0.0;
  var ambientCoefficient = 0.0;
  var weightedDistance = 0.0;
  var distanceWeight = 0.0;
  let sunDirection = normalize(uniforms.sunDirection);
  let cosine = dot(direction, sunDirection);
  let phase = 0.72 * hg(cosine, 0.72) + 0.28 * hg(cosine, -0.22);

  for (var stepIndex = 0; stepIndex < 192; stepIndex += 1) {
    if (f32(stepIndex) >= steps || distance >= interval.y || transmittance < 0.012) { break; }
    let point = uniforms.cameraWorld + direction * distance;
    let density = cloudDensity(point);
    if (density > 0.006) {
      let extinction = density * stepLength * uniforms.extinctionPerMeter;
      let segmentTransmittance = exp(-extinction);
      let segmentWeight = transmittance * (1.0 - segmentTransmittance);
      let sunlight = lightTransmittance(point);
      let powder = 1.0 - exp(-density * stepLength * uniforms.extinctionPerMeter * 1.65);
      directCoefficient += segmentWeight * sunlight
        * (0.48 + phase * 5.5) * (0.7 + powder * 0.5);
      // Sky illumination and unresolved multiple scattering keep cloud bodies
      // readable under overcast lighting instead of turning into black slabs.
      ambientCoefficient += segmentWeight * (1.02 + point.y / 11000.0);
      weightedDistance += distance * segmentWeight;
      distanceWeight += segmentWeight;
      transmittance *= segmentTransmittance;
    }
    distance += stepLength;
  }

  let opacity = 1.0 - transmittance;
  let representativeDistance = select(
    0.0,
    weightedDistance / max(distanceWeight, 0.000001),
    distanceWeight > 0.000001,
  );
  // r/g are premultiplied direct/ambient lighting coefficients, b is opacity,
  // and a is representative distance. This preserves HDR color plus depth in
  // one filterable RGBA16F target.
  fragmentOutputs.color = vec4f(
    directCoefficient,
    ambientCoefficient,
    opacity,
    representativeDistance / uniforms.maximumTraceDistance,
  );
}
`;

export const CLOUD_TEMPORAL_FRAGMENT_WGSL = /* wgsl */ `
varying vUV: vec2f;
var currentSamplerSampler: sampler;
var currentSampler: texture_2d<f32>;
var historySamplerSampler: sampler;
var historySampler: texture_2d<f32>;
uniform previousViewProjection: mat4x4f;
uniform cameraLocal: vec3f;
uniform cameraForward: vec3f;
uniform cameraRight: vec3f;
uniform cameraUp: vec3f;
uniform viewScale: vec2f;
uniform inverseOutputSize: vec2f;
uniform maximumTraceDistance: f32;
uniform historyDepthSigma: f32;
uniform historyWeight: f32;
uniform historyValid: f32;

fn temporalViewRay(uv: vec2f) -> vec3f {
  let ndc = uv * 2.0 - 1.0;
  return normalize(
    uniforms.cameraForward
      + uniforms.cameraRight * ndc.x * uniforms.viewScale.x
      + uniforms.cameraUp * ndc.y * uniforms.viewScale.y
  );
}

// No vertical flip belongs here. Babylon already compensates for WebGPU's
// top-left render-target convention: every non-pure WGSL vertex shader is
// patched with a yFactor multiply, and yFactor is -1 for every render target,
// so a ProceduralTexture's interpolated vUV.y already equals the texture v it
// will be sampled back with. The old flip helper re-flipped on top of that
// compensation, mirroring the temporal output vertically — which is what made
// clouds counter-rotate against the aircraft (1A-4).

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let currentUv = input.vUV;
  let current = textureSampleLevel(currentSampler, currentSamplerSampler, currentUv, 0.0);
  if (uniforms.historyValid < 0.5 || current.b < 0.001 || current.a <= 0.0) {
    fragmentOutputs.color = current;
    return fragmentOutputs;
  }

  let distance = current.a * uniforms.maximumTraceDistance;
  let localPoint = uniforms.cameraLocal + temporalViewRay(input.vUV) * distance;
  let previousClip = uniforms.previousViewProjection * vec4f(localPoint, 1.0);
  let previousNdc = previousClip.xy / max(previousClip.w, 0.000001);
  let previousUv = previousNdc * 0.5 + 0.5;
  if (any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0))) {
    fragmentOutputs.color = current;
    return fragmentOutputs;
  }

  let history = textureSampleLevel(
    historySampler,
    historySamplerSampler,
    previousUv,
    0.0,
  );
  var neighborhoodMinimum = current;
  var neighborhoodMaximum = current;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let offset = vec2f(f32(x), f32(y)) * uniforms.inverseOutputSize;
      let sampleValue = textureSampleLevel(
        currentSampler,
        currentSamplerSampler,
        currentUv + offset,
        0.0,
      );
      neighborhoodMinimum = min(neighborhoodMinimum, sampleValue);
      neighborhoodMaximum = max(neighborhoodMaximum, sampleValue);
    }
  }

  let clampedHistory = vec4f(
    clamp(history.rg, neighborhoodMinimum.rg, neighborhoodMaximum.rg),
    clamp(history.b, neighborhoodMinimum.b, neighborhoodMaximum.b),
    history.a,
  );
  let depthDifference = abs(history.a - current.a) * uniforms.maximumTraceDistance;
  let depthConfidence = exp(-depthDifference / max(uniforms.historyDepthSigma, 1.0));
  let motionPixels = length((previousUv - input.vUV) / uniforms.inverseOutputSize);
  let motionConfidence = exp(-motionPixels * 0.045);
  let occupancyConfidence = smoothstep(0.004, 0.08, min(current.b, history.b));
  let blendWeight = uniforms.historyWeight
    * depthConfidence * motionConfidence * occupancyConfidence;
  let resolved = mix(current, clampedHistory, blendWeight);
  fragmentOutputs.color = vec4f(
    resolved.rgb,
    mix(current.a, history.a, blendWeight * 0.65),
  );
}
`;

export const CLOUD_COMPOSITE_FRAGMENT_WGSL = /* wgsl */ `
var cloudSamplerSampler: sampler;
var cloudSampler: texture_2d<f32>;
uniform fullResolution: vec2f;
uniform sunColor: vec3f;
uniform ambientColor: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // LATENT FRAGILITY (recorded by 1A-4, removed by composite-postprocess): this
  // fragCoord-derived uv is only correct because the beauty pass renders into an
  // offscreen target (the tone-map/FXAA post-process chain forces one), where
  // Babylon's yFactor geometry flip cancels the top-left fragCoord convention.
  // Detach every post-process and this composite inverts vertically.
  let uv = vec2f(
    input.position.x / uniforms.fullResolution.x,
    input.position.y / uniforms.fullResolution.y,
  );
  let cloud = textureSampleLevel(cloudSampler, cloudSamplerSampler, uv, 0.0);
  if (cloud.b < 0.001 || cloud.a <= 0.0) { discard; }

  // The shell vertex is fixed at reversed-Z far depth. Opaque terrain and the
  // aircraft therefore win naturally, while clouds remain confined to sky
  // pixels. A single representative scattering depth cannot describe a whole
  // volume ray; writing it here caused entire cloud columns to alternately pass
  // and fail against distant terrain, creating horizontal bands at the horizon.
  let radiance = uniforms.sunColor * cloud.r
    + uniforms.ambientColor * (cloud.g + cloud.b * 0.55);
  fragmentOutputs.color = vec4f(max(radiance, vec3f(0.0)), cloud.b);
}
`;

/** Raster specialization of the shared cloud-shadow compute foundation. */
export const CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL = /* wgsl */ `
varying vUV: vec2f;
uniform shadowCenter: vec2f;
uniform shadowWorldSize: f32;
uniform groundAltitude: f32;
uniform sunDirection: vec3f;
uniform wind: vec3f;
uniform time: f32;
uniform coverage: f32;
uniform humidity: f32;
uniform shadowSteps: f32;
uniform frameIndex: f32;
uniform baseAltitude: f32;
uniform topAltitude: f32;
uniform baseNoiseScale: f32;
uniform detailNoiseScale: f32;
uniform detailErosion: f32;
uniform densityMultiplier: f32;
uniform extinctionPerMeter: f32;

${CLOUD_RUNTIME_DENSITY_WGSL}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let sunDirection = normalize(uniforms.sunDirection);
  if (sunDirection.y <= 0.001) {
    fragmentOutputs.color = vec4f(1.0);
    return fragmentOutputs;
  }
  let surface = vec3f(
    uniforms.shadowCenter.x + (input.vUV.x - 0.5) * uniforms.shadowWorldSize,
    uniforms.groundAltitude,
    uniforms.shadowCenter.y + (input.vUV.y - 0.5) * uniforms.shadowWorldSize,
  );
  let nearDistance = max(0.0, (uniforms.baseAltitude - surface.y) / sunDirection.y);
  let farDistance = max(nearDistance, (uniforms.topAltitude - surface.y) / sunDirection.y);
  let steps = clamp(uniforms.shadowSteps, 4.0, 32.0);
  let stepLength = (farDistance - nearDistance) / steps;
  let jitter = hash31(vec3f(input.position.xy, uniforms.frameIndex));
  var opticalDepth = 0.0;
  for (var stepIndex = 0; stepIndex < 32; stepIndex += 1) {
    if (f32(stepIndex) >= steps) { break; }
    let distance = nearDistance + (f32(stepIndex) + jitter) * stepLength;
    opticalDepth += cloudDensity(surface + sunDirection * distance) * stepLength;
  }
  let transmittance = exp(-opticalDepth * uniforms.extinctionPerMeter);
  fragmentOutputs.color = vec4f(transmittance, transmittance, transmittance, 1.0);
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${CLOUD_COMPOSITE_SHADER_NAME}VertexShader`] =
    CLOUD_SHELL_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${CLOUD_COMPOSITE_SHADER_NAME}PixelShader`] =
    CLOUD_COMPOSITE_FRAGMENT_WGSL;
}

function createProceduralTexture(
  scene: Scene,
  name: string,
  size: { readonly width: number; readonly height: number },
  fragmentSource: string,
  textureType: number,
  format = Constants.TEXTUREFORMAT_RGBA,
): ProceduralTexture {
  const texture = new ProceduralTexture(
    name,
    size,
    { fragmentSource },
    scene,
    {
      shaderLanguage: ShaderLanguage.WGSL,
      type: textureType,
      format,
      samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      generateDepthBuffer: false,
      generateStencilBuffer: false,
      generateMipMaps: false,
      gammaSpace: false,
      skipSceneRegistration: true,
    },
    false,
    false,
    textureType,
  );
  texture.refreshRate = -1;
  texture.autoClear = false;
  texture.gammaSpace = false;
  texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  return texture;
}

function configurePremultipliedMaterial(material: ShaderMaterial): void {
  // 1A-4 step 3, resolved by measurement (tests/gpu/cloud-shell-culling.test.ts):
  // the camera-centered BACKSIDE shell rasterises exactly once per pixel, so
  // the hypothesised per-pixel double blend does not occur on this stack.
  // Culling is enabled anyway — it is visually a no-op today (the GPU test
  // pins that a culled BACKSIDE shell stays fully visible in the offscreen
  // pass) and it protects the premultiplied blend from ever double-covering
  // if the shell stops being camera-centered. Babylon's render-target winding
  // flip and frontFace inversion cancel, so no sideOrientation change is
  // needed. Keep the warmed pipeline descriptor in whenReadyAsync in step.
  material.backFaceCulling = true;
  material.disableDepthWrite = true;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
}

export interface CloudRuntimeStatistics {
  readonly frameIndex: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly resolutionScale: number;
  readonly integrationRenders: number;
  readonly temporalResolveRenders: number;
  readonly historyValid: boolean;
  readonly historyGeneration: number;
  readonly shadowResolution: number;
  readonly shadowSteps: number;
  readonly shadowUpdateEveryNFrames: number;
  readonly shadowRenders: number;
  readonly shadowCenterX: number;
  readonly shadowCenterZ: number;
  readonly shadowWorldSize: number;
}

/** Low-resolution, temporally resolved clouds with reversed-Z depth composition. */
export class VolumetricCloudSystem {
  private readonly shell: Mesh;
  private readonly material: ShaderMaterial;
  private readonly integrationTexture: ProceduralTexture;
  private readonly historyTextures: readonly [ProceduralTexture, ProceduralTexture];
  private readonly shadowTextureValue: ProceduralTexture;
  private readonly currentViewProjection = Matrix.Identity();
  private readonly previousViewProjection = Matrix.Identity();
  private readonly cameraWorld = Vector3.Zero();
  private readonly cameraForward = Vector3.Forward();
  private readonly cameraRight = Vector3.Right();
  private readonly cameraUp = Vector3.Up();
  private readonly cameraLocalForward: Vector3;
  private readonly viewScale = Vector2.One();
  private readonly shadowCenter = Vector2.Zero();
  private readonly inverseOutputSize = Vector2.One();
  private readonly fullResolution = Vector2.One();
  private readonly sunDirection = Vector3.Up();
  private readonly wind = Vector3.Zero();
  private readonly lifetimeController = new AbortController();
  private cloudRenderSize: CloudRenderSize;
  private shadowSchedule: CloudShadowSchedule;
  private historyReadIndex: 0 | 1 = 0;
  private historyValid = false;
  private atmosphereInitialized = false;
  private shadowDirty = true;
  private shadowReady = false;
  private frameIndex = 0;
  private lastShadowFrame = -1;
  private integrationRenderCount = 0;
  private temporalResolveRenderCount = 0;
  private shadowRenderCount = 0;
  private historyGeneration = 0;
  private coverage = 0;
  private humidity = 0;
  private pipelinesWarmed = false;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private profile: WebGpuQualityProfile,
    atmosphere: AtmosphereSnapshot,
  ) {
    registerShaders();
    this.cameraLocalForward = Vector3.Forward(scene.useRightHandedSystem);
    const engine = scene.getEngine();
    this.cloudRenderSize = resolveCloudRenderSize(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
      profile.cloudResolutionScale,
    );
    this.shadowSchedule = resolveCloudShadowSchedule(profile);
    const hdrTextureType = engine.getCaps().textureHalfFloatRender
      ? Constants.TEXTURETYPE_HALF_FLOAT
      : Constants.TEXTURETYPE_UNSIGNED_BYTE;

    this.integrationTexture = createProceduralTexture(
      scene,
      "volumetric-cloud-integration",
      this.cloudRenderSize,
      CLOUD_INTEGRATION_FRAGMENT_WGSL,
      hdrTextureType,
    );
    this.historyTextures = [
      createProceduralTexture(scene, "volumetric-cloud-history-a", this.cloudRenderSize,
        CLOUD_TEMPORAL_FRAGMENT_WGSL, hdrTextureType),
      createProceduralTexture(scene, "volumetric-cloud-history-b", this.cloudRenderSize,
        CLOUD_TEMPORAL_FRAGMENT_WGSL, hdrTextureType),
    ];
    this.shadowTextureValue = createProceduralTexture(
      scene,
      "volumetric-cloud-shadow",
      { width: this.shadowSchedule.resolution, height: this.shadowSchedule.resolution },
      CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL,
      hdrTextureType,
      Constants.TEXTUREFORMAT_R,
    );

    this.shell = CreateSphere("volumetric-cloud-shell", {
      diameter: CLOUD_SHELL_DIAMETER_METERS,
      segments: 24,
      sideOrientation: Mesh.BACKSIDE,
    }, scene);
    this.shell.isPickable = false;
    this.shell.applyFog = false;
    this.shell.alwaysSelectAsActiveMesh = true;
    this.shell.renderingGroupId = 0;
    this.shell.alphaIndex = 1;
    this.material = new ShaderMaterial(
      "volumetric-cloud-composite-material",
      scene,
      CLOUD_COMPOSITE_SHADER_NAME,
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection", "fullResolution", "sunColor", "ambientColor",
        ],
        samplers: ["cloudSampler"],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    configurePremultipliedMaterial(this.material);
    this.material.depthFunction = Constants.GEQUAL;
    this.material.setTexture("cloudSampler", this.integrationTexture);
    this.shell.material = this.material;
    this.shell.setEnabled(false);

    this.configureStaticUniforms();
    this.configureTemporalBindings();
    this.applyProfileUniforms();
    this.setAtmosphere(atmosphere);
  }

  get statistics(): CloudRuntimeStatistics {
    return {
      frameIndex: this.frameIndex,
      renderWidth: this.cloudRenderSize.width,
      renderHeight: this.cloudRenderSize.height,
      resolutionScale: this.cloudRenderSize.scale,
      integrationRenders: this.integrationRenderCount,
      temporalResolveRenders: this.temporalResolveRenderCount,
      historyValid: this.historyValid,
      historyGeneration: this.historyGeneration,
      shadowResolution: this.shadowSchedule.resolution,
      shadowSteps: this.shadowSchedule.steps,
      shadowUpdateEveryNFrames: this.shadowSchedule.updateEveryNFrames,
      shadowRenders: this.shadowRenderCount,
      shadowCenterX: this.shadowCenter.x,
      shadowCenterZ: this.shadowCenter.y,
      shadowWorldSize: DEFAULT_VOLUMETRIC_CLOUD_CONFIG.shadowWorldSizeMeters,
    };
  }

  /** Bindable world-space transmittance projection for terrain/water materials. */
  get cloudShadow(): CloudShadowProjection {
    return {
      texture: this.shadowTextureValue,
      centerX: this.shadowCenter.x,
      centerZ: this.shadowCenter.y,
      worldSizeMeters: DEFAULT_VOLUMETRIC_CLOUD_CONFIG.shadowWorldSizeMeters,
      referenceAltitudeMeters: CLOUD_SHADOW_REFERENCE_ALTITUDE_METERS,
      sunDirectionX: this.sunDirection.x,
      sunDirectionY: this.sunDirection.y,
      sunDirectionZ: this.sunDirection.z,
      valid: this.shadowReady,
    };
  }

  /**
   * Compiles every cloud shader variant and warms each offscreen render pipeline.
   * Startup must await this finite barrier because ProceduralTexture.isReady()
   * otherwise permits a failed or indefinitely compiling effect to be skipped
   * silently by the per-frame update path.
   */
  async whenReadyAsync(
    signal?: AbortSignal,
    timeoutMilliseconds = CLOUD_SHADER_STARTUP_TIMEOUT_MILLISECONDS,
  ): Promise<void> {
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      throw new RangeError("Cloud shader startup timeout must be a positive finite number");
    }
    if (this.disposed) {
      throw cloudStartupAbortError("Volumetric cloud system was disposed during shader startup");
    }
    if (signal?.aborted) {
      throw cloudStartupAbortError("Volumetric cloud shader startup was cancelled");
    }
    if (this.pipelinesWarmed) return;

    this.prepareStartupUniforms();
    const compositeSubMesh = this.shell.subMeshes[0];
    const getCompositeEffect = () => compositeSubMesh?.effect ?? this.material.getEffect();
    const targets: readonly CloudPipelineReadinessTarget[] = [
      {
        label: "integration",
        isReady: () => this.integrationTexture.isReady(),
        getEffect: () => this.integrationTexture.getEffect(),
        warm: () => this.integrationTexture.render(),
      },
      {
        label: "temporal history A",
        isReady: () => this.historyTextures[0].isReady(),
        getEffect: () => this.historyTextures[0].getEffect(),
        warm: () => this.historyTextures[0].render(),
      },
      {
        label: "temporal history B",
        isReady: () => this.historyTextures[1].isReady(),
        getEffect: () => this.historyTextures[1].getEffect(),
        warm: () => this.historyTextures[1].render(),
      },
      {
        label: "shadow",
        isReady: () => this.shadowTextureValue.isReady(),
        getEffect: () => this.shadowTextureValue.getEffect(),
        warm: () => this.shadowTextureValue.render(),
      },
      {
        label: "composite",
        isReady: () => {
          const materialReady = this.material.isReady(this.shell);
          return materialReady && (compositeSubMesh
            ? this.material.isReadyForSubMesh(this.shell, compositeSubMesh, false)
            : true);
        },
        getEffect: getCompositeEffect,
      },
    ];

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const lifetimeSignal = this.lifetimeController.signal;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", onExternalAbort);
        lifetimeSignal.removeEventListener("abort", onDisposed);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onExternalAbort = () => {
        finish(cloudStartupAbortError("Volumetric cloud shader startup was cancelled"));
      };
      const onDisposed = () => {
        finish(cloudStartupAbortError(
          "Volumetric cloud system was disposed during shader startup",
        ));
      };
      const checkReadiness = () => {
        if (settled) return;
        try {
          let allReady = true;
          for (const target of targets) {
            const ready = target.isReady();
            const compilationError = target.getEffect()?.getCompilationError().trim();
            if (compilationError) {
              finish(new Error(
                `Volumetric cloud ${target.label} shader failed to compile: ${compilationError}`,
              ));
              return;
            }
            allReady = allReady && ready;
          }
          if (allReady) {
            for (const target of targets) target.warm?.();
            const engine = this.scene.getEngine();
            const webGpuEngine = engine as WebGPUEngine;
            if (typeof webGpuEngine.createRenderPipelineAsync !== "function") {
              // NullEngine deliberately has no native render-pipeline API.
              this.pipelinesWarmed = true;
              finish();
              return;
            }
            const effect = getCompositeEffect();
            if (!effect) {
              finish(new Error(
                "Volumetric cloud composite shader became unavailable during startup",
              ));
              return;
            }
            const pipelinePromises = webGpuEngine.createRenderPipelineAsync({
                effect,
                mesh: this.shell,
                fillMode: Constants.MATERIAL_TriangleFillMode,
                sampleCount: 1,
                colorFormat: "rgba16float",
                depthStencilFormat: engine.isStencilEnable
                  ? "depth24plus-stencil8"
                  : "depth32float",
                alphaMode: Constants.ALPHA_PREMULTIPLIED_PORTERDUFF,
                depthWrite: false,
                depthTest: true,
                depthCompare: Constants.GEQUAL,
                cullEnabled: true,
                // The shell draws with reverseSide in this right-handed scene
                // into a Y-flipped offscreen target, so the runtime pipeline
                // keys frontFace 1 — Babylon's warm default of 2 would compile
                // a pipeline the composite never uses.
                frontFace: 1,
              });
            // Native WebGPU pipeline validation is asynchronous. Keep the same
            // abort/dispose/timeout barrier alive until it completes; NullEngine
            // tests intentionally have no render-pipeline creation API.
            void Promise.all(pipelinePromises).then(
              () => {
                if (settled) return;
                this.pipelinesWarmed = true;
                finish();
              },
              (error: unknown) => finish(error),
            );
            return;
          }
        } catch (error) {
          finish(error);
          return;
        }
        pollTimer = setTimeout(
          checkReadiness,
          CLOUD_SHADER_READINESS_POLL_MILLISECONDS,
        );
      };

      signal?.addEventListener("abort", onExternalAbort, { once: true });
      lifetimeSignal.addEventListener("abort", onDisposed, { once: true });
      const timeoutTimer = setTimeout(() => {
        finish(new Error(
          `Volumetric cloud shader startup timed out after ${timeoutMilliseconds} ms`,
        ));
      }, timeoutMilliseconds);
      checkReadiness();
    });
  }

  setProfile(profile: WebGpuQualityProfile): void {
    const nextSchedule = resolveCloudShadowSchedule(profile);
    resolveCloudRenderSize(
      this.scene.getEngine().getRenderWidth(),
      this.scene.getEngine().getRenderHeight(),
      profile.cloudResolutionScale,
    );
    const samplingChanged = profile.cloudPrimarySteps !== this.profile.cloudPrimarySteps
      || profile.cloudLightSteps !== this.profile.cloudLightSteps
      || profile.cloudResolutionScale !== this.profile.cloudResolutionScale;
    const shadowResolutionChanged = nextSchedule.resolution !== this.shadowSchedule.resolution;
    const shadowScheduleChanged = shadowResolutionChanged
      || nextSchedule.steps !== this.shadowSchedule.steps
      || nextSchedule.updateEveryNFrames !== this.shadowSchedule.updateEveryNFrames;
    this.profile = profile;
    this.shadowSchedule = nextSchedule;
    const resized = this.ensureCloudResolution();
    if (shadowResolutionChanged) {
      this.shadowTextureValue.resize({
        width: nextSchedule.resolution,
        height: nextSchedule.resolution,
      }, false);
      this.shadowReady = false;
    }
    if (shadowScheduleChanged) this.shadowDirty = true;
    this.applyProfileUniforms();
    if (samplingChanged && !resized) this.resetTemporalHistory();
  }

  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    const nextWindX = atmosphere.windDirection.x * atmosphere.windSpeed;
    const nextWindZ = atmosphere.windDirection.y * atmosphere.windSpeed;
    const densityOrLightingChanged = this.atmosphereInitialized && (
      Math.abs(this.coverage - atmosphere.cloudCoverage) > 0.0001
      || Math.abs(this.humidity - atmosphere.humidity) > 0.0001
      || Math.abs(this.wind.x - nextWindX) > 0.0001
      || Math.abs(this.wind.z - nextWindZ) > 0.0001
      || Vector3.DistanceSquared(this.sunDirection, atmosphere.sunDirection) > 0.000001
    );
    this.coverage = atmosphere.cloudCoverage;
    this.humidity = atmosphere.humidity;
    this.wind.set(nextWindX, 0, nextWindZ);
    this.sunDirection.copyFrom(atmosphere.sunDirection);

    this.integrationTexture.setVector3("sunDirection", this.sunDirection);
    this.integrationTexture.setVector3("wind", this.wind);
    this.integrationTexture.setFloat("coverage", this.coverage);
    this.integrationTexture.setFloat("humidity", this.humidity);
    this.shadowTextureValue.setVector3("sunDirection", this.sunDirection);
    this.shadowTextureValue.setVector3("wind", this.wind);
    this.shadowTextureValue.setFloat("coverage", this.coverage);
    this.shadowTextureValue.setFloat("humidity", this.humidity);
    this.material.setColor3(
      "sunColor",
      atmosphere.sunColor.scale(atmosphere.sunIntensity / 5.2),
    );
    this.material.setColor3(
      "ambientColor",
      atmosphere.ambientColor.scale(atmosphere.exposure),
    );
    this.shadowDirty = true;
    this.shadowReady = false;
    if (densityOrLightingChanged) this.resetTemporalHistory();
    this.atmosphereInitialized = true;
  }

  update(cameraWorld: Vector3, timeSeconds: number): void {
    this.frameIndex += 1;
    this.cameraWorld.copyFrom(cameraWorld);
    this.ensureCloudResolution();
    // This pass runs in the frame graph's volumetrics phase, before
    // scene.render() recomputes camera matrices — and the renderer lerps FOV
    // every frame, so the cached transformation matrix is guaranteed stale.
    // Force a view-matrix refresh before reading the view-projection (1A-4).
    this.camera.getViewMatrix(true);
    this.currentViewProjection.copyFrom(this.camera.getTransformationMatrix());
    if (!this.historyValid) this.previousViewProjection.copyFrom(this.currentViewProjection);

    const engine = this.scene.getEngine();
    this.fullResolution.set(engine.getRenderWidth(), engine.getRenderHeight());
    this.inverseOutputSize.set(1 / this.cloudRenderSize.width, 1 / this.cloudRenderSize.height);
    this.shell.position.copyFrom(this.camera.position);
    this.updateViewUniforms();
    this.updateIntegrationUniforms(timeSeconds);

    let cloudOutput: ProceduralTexture | null = null;
    if (this.integrationTexture.isReady()) {
      this.integrationTexture.render();
      this.integrationRenderCount += 1;
      cloudOutput = this.integrationTexture;
      const writeIndex: 0 | 1 = this.historyReadIndex === 0 ? 1 : 0;
      const historyWrite = this.historyTextures[writeIndex];
      historyWrite.setFloat("historyValid", this.historyValid ? 1 : 0);
      historyWrite.setMatrix("previousViewProjection", this.previousViewProjection);
      this.updateCameraRayUniforms(historyWrite);
      historyWrite.setVector2("inverseOutputSize", this.inverseOutputSize);
      if (historyWrite.isReady()) {
        historyWrite.render();
        this.temporalResolveRenderCount += 1;
        this.historyReadIndex = writeIndex;
        this.historyValid = true;
        cloudOutput = historyWrite;
      }
    }
    if (cloudOutput) {
      this.material.setTexture("cloudSampler", cloudOutput);
      this.shell.setEnabled(true);
    }
    this.previousViewProjection.copyFrom(this.currentViewProjection);
    this.updateShadowPass(timeSeconds);
  }

  invalidateHistory(): void {
    this.frameIndex = 0;
    this.lastShadowFrame = -1;
    this.shadowDirty = true;
    this.resetTemporalHistory();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetimeController.abort();
    this.shell.dispose(false, false);
    this.material.dispose(true, false);
    this.integrationTexture.dispose();
    this.historyTextures[0].dispose();
    this.historyTextures[1].dispose();
    this.shadowTextureValue.dispose();
  }

  private prepareStartupUniforms(): void {
    this.currentViewProjection.copyFrom(this.camera.getTransformationMatrix());
    this.cameraWorld.copyFrom(this.camera.position);
    const engine = this.scene.getEngine();
    this.fullResolution.set(engine.getRenderWidth(), engine.getRenderHeight());
    this.inverseOutputSize.set(1 / this.cloudRenderSize.width, 1 / this.cloudRenderSize.height);
    this.updateViewUniforms();
    this.updateIntegrationUniforms(0);
    for (const history of this.historyTextures) {
      history.setFloat("historyValid", 0);
      history.setMatrix("previousViewProjection", this.currentViewProjection);
      this.updateCameraRayUniforms(history);
      history.setVector2("inverseOutputSize", this.inverseOutputSize);
    }
    this.shadowTextureValue.setVector2("shadowCenter", this.shadowCenter);
    this.shadowTextureValue.setFloat("time", 0);
    this.shadowTextureValue.setFloat("frameIndex", 0);
  }

  private configureStaticUniforms(): void {
    const config = DEFAULT_VOLUMETRIC_CLOUD_CONFIG;
    this.integrationTexture.setFloat("baseAltitude", config.baseAltitudeMeters);
    this.integrationTexture.setFloat("topAltitude", config.topAltitudeMeters);
    this.integrationTexture.setFloat("maximumTraceDistance", config.maximumTraceDistanceMeters);
    this.integrationTexture.setFloat("baseNoiseScale", config.baseNoiseScaleMeters);
    this.integrationTexture.setFloat("detailNoiseScale", config.detailNoiseScaleMeters);
    this.integrationTexture.setFloat("detailErosion", config.detailErosion);
    this.integrationTexture.setFloat("densityMultiplier", config.densityMultiplier);
    this.integrationTexture.setFloat("extinctionPerMeter", config.extinctionPerMeter);
    for (const history of this.historyTextures) {
      history.setFloat("maximumTraceDistance", config.maximumTraceDistanceMeters);
      history.setFloat("historyDepthSigma", config.historyDepthSigmaMeters);
    }
    this.shadowTextureValue.setFloat("shadowWorldSize", config.shadowWorldSizeMeters);
    this.shadowTextureValue.setFloat(
      "groundAltitude",
      CLOUD_SHADOW_REFERENCE_ALTITUDE_METERS,
    );
    this.shadowTextureValue.setFloat("baseAltitude", config.baseAltitudeMeters);
    this.shadowTextureValue.setFloat("topAltitude", config.topAltitudeMeters);
    this.shadowTextureValue.setFloat("baseNoiseScale", config.baseNoiseScaleMeters);
    this.shadowTextureValue.setFloat("detailNoiseScale", config.detailNoiseScaleMeters);
    this.shadowTextureValue.setFloat("detailErosion", config.detailErosion);
    this.shadowTextureValue.setFloat("densityMultiplier", config.densityMultiplier);
    this.shadowTextureValue.setFloat("extinctionPerMeter", config.extinctionPerMeter);
    this.material.setColor3("ambientColor", CLOUD_AMBIENT_COLOR);
  }

  private configureTemporalBindings(): void {
    this.historyTextures[0].setTexture("currentSampler", this.integrationTexture);
    this.historyTextures[0].setTexture("historySampler", this.historyTextures[1]);
    this.historyTextures[1].setTexture("currentSampler", this.integrationTexture);
    this.historyTextures[1].setTexture("historySampler", this.historyTextures[0]);
  }

  private applyProfileUniforms(): void {
    this.integrationTexture.setFloat(
      "raySteps", Math.max(8, Math.min(192, this.profile.cloudPrimarySteps)),
    );
    this.integrationTexture.setFloat(
      "lightSteps", Math.max(2, Math.min(16, this.profile.cloudLightSteps)),
    );
    for (const history of this.historyTextures) {
      history.setFloat("historyWeight", this.shadowSchedule.historyWeight);
    }
    this.shadowTextureValue.setFloat("shadowSteps", this.shadowSchedule.steps);
  }

  private ensureCloudResolution(): boolean {
    const engine = this.scene.getEngine();
    const next = resolveCloudRenderSize(
      engine.getRenderWidth(), engine.getRenderHeight(), this.profile.cloudResolutionScale,
    );
    if (next.width === this.cloudRenderSize.width && next.height === this.cloudRenderSize.height) {
      return false;
    }
    this.integrationTexture.resize(next, false);
    this.historyTextures[0].resize(next, false);
    this.historyTextures[1].resize(next, false);
    this.cloudRenderSize = next;
    this.resetTemporalHistory();
    return true;
  }

  private resetTemporalHistory(): void {
    this.historyValid = false;
    this.shell.setEnabled(false);
    this.historyGeneration += 1;
  }

  private updateViewUniforms(): void {
    this.material.setVector2("fullResolution", this.fullResolution);
  }

  private updateIntegrationUniforms(timeSeconds: number): void {
    this.updateCameraRayUniforms(this.integrationTexture);
    this.integrationTexture.setVector3("cameraWorld", this.cameraWorld);
    this.integrationTexture.setFloat("time", timeSeconds);
    this.integrationTexture.setFloat("frameIndex", this.frameIndex % 4096);
  }

  private updateCameraRayUniforms(target: ProceduralTexture): void {
    this.camera.getDirectionToRef(this.cameraLocalForward, this.cameraForward);
    this.camera.getDirectionToRef(Vector3.Right(), this.cameraRight);
    this.camera.getDirectionToRef(Vector3.Up(), this.cameraUp);
    const tanHalfFov = Math.tan(this.camera.fov * 0.5);
    this.viewScale.set(
      tanHalfFov * this.scene.getEngine().getAspectRatio(this.camera),
      tanHalfFov,
    );
    target.setVector3("cameraLocal", this.camera.position);
    target.setVector3("cameraForward", this.cameraForward);
    target.setVector3("cameraRight", this.cameraRight);
    target.setVector3("cameraUp", this.cameraUp);
    target.setVector2("viewScale", this.viewScale);
  }

  private updateShadowPass(timeSeconds: number): void {
    const worldSize = DEFAULT_VOLUMETRIC_CLOUD_CONFIG.shadowWorldSizeMeters;
    const texelWorldSize = worldSize / this.shadowSchedule.resolution;
    const centerX = Math.round(this.cameraWorld.x / texelWorldSize) * texelWorldSize;
    const centerZ = Math.round(this.cameraWorld.z / texelWorldSize) * texelWorldSize;
    if (centerX !== this.shadowCenter.x || centerZ !== this.shadowCenter.y) {
      this.shadowCenter.set(centerX, centerZ);
      this.shadowDirty = true;
      this.shadowReady = false;
    }
    this.shadowTextureValue.setVector2("shadowCenter", this.shadowCenter);
    this.shadowTextureValue.setFloat("time", timeSeconds);
    this.shadowTextureValue.setFloat("frameIndex", this.frameIndex % 4096);

    if (!shouldRenderCloudShadow(
      this.frameIndex,
      this.lastShadowFrame,
      this.shadowSchedule.updateEveryNFrames,
      this.shadowDirty,
    )) return;
    if (!this.shadowTextureValue.isReady()) return;
    this.shadowTextureValue.render();
    this.shadowRenderCount += 1;
    this.lastShadowFrame = this.frameIndex;
    this.shadowDirty = false;
    this.shadowReady = true;
  }
}
