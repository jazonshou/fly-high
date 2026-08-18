import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { TextureSampler } from "@babylonjs/core/Materials/Textures/textureSampler";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.pure";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Mesh as BabylonMesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import type { AtmosphereGpuResources } from "@/src/render/webgpu/atmosphere/AtmosphereGpuResources";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  packCloudRaymarchUniforms,
  packCloudShadowUniforms,
  packCloudTemporalUniforms,
  resolveVolumetricCloudConfig,
  type VolumetricCloudConfig,
} from "@/src/render/webgpu/nature/CloudConfig";
import {
  CLOUD_RAYMARCH_SHADER,
  CLOUD_SHADOW_SHADER,
  CLOUD_TEMPORAL_RESOLVE_SHADER,
} from "@/src/render/webgpu/nature/CloudShaders";
import {
  DEFAULT_ENVIRONMENT_STATE,
  type EnvironmentState,
} from "@/src/render/webgpu/nature/EnvironmentState";
import type { NatureShaderModule } from "@/src/render/webgpu/nature/ShaderModule";
import { computeDispatch2D } from "@/src/render/webgpu/nature/ShaderModule";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { CloudVolumeBake } from "./CloudVolumeBake";
import { viewScaleFromFov } from "./CloudReprojection";
import type { CloudShadowProjection } from "./CloudShadowReceiver";
import {
  resolveCloudRenderSize,
  resolveCloudShadowSchedule,
  shouldRenderCloudShadow,
  type CloudRenderSize,
  type CloudShadowSchedule,
} from "./runtimePolicy";

/**
 * The volumetric cloud runtime, rebuilt by 2-0 (cloud shader adoption).
 *
 * INVARIANT THIS FILE OWNS: the cloud pipeline runs the three adopted
 * `nature/CloudShaders.ts` modules — raymarch, temporal resolve and shadow,
 * all compute passes on the ocean's proven `ComputeShader` pattern — and no
 * inline cloud WGSL exists here beyond the composite shell that lifts the
 * resolved image into the scene. Rays are built everywhere from the one
 * shipped camera-basis convention (1B-12); no view-projection matrix exists
 * anywhere in the pipeline (the 1A-4 stale-matrix bug class).
 *
 * Adoption deviations (decision log): raymarch converted from an MRT
 * fragment pass to compute (no MRT plumbing needs to exist on this stack);
 * scene depth arrives as the 2-0a DepthRenderer's camera-space Z (one frame
 * of latency — the depth pass renders with the scene, after the dispatch);
 * the shadow map stores rgba16float because receivers filter it.
 */

const CLOUD_COMPOSITE_SHADER_NAME = "aerolithVolumetricCloudComposite";
const CLOUD_SHELL_DIAMETER_METERS = 118_000;
const CLOUD_SHADOW_REFERENCE_ALTITUDE_METERS = 0;
const CLOUD_SHADER_STARTUP_TIMEOUT_MILLISECONDS = 15_000;
const CLOUD_SHADER_READINESS_POLL_MILLISECONDS = 8;
/** Raymarch params: 17 vec4 rows (272 bytes). */
const RAYMARCH_PARAMS_VEC4S = 17;
/** Temporal params: 9 vec4 rows (144 bytes). */
const TEMPORAL_PARAMS_VEC4S = 9;
/** Shadow params: 12 vec4 rows (192 bytes). */
const SHADOW_PARAMS_VEC4S = 12;

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

export const CLOUD_COMPOSITE_FRAGMENT_WGSL = /* wgsl */ `
var cloudSamplerSampler: sampler;
var cloudSampler: texture_2d<f32>;
var cloudAuxSamplerSampler: sampler;
var cloudAuxSampler: texture_2d<f32>;
uniform fullResolution: vec2f;
uniform cameraForward: vec3f;
uniform cameraRight: vec3f;
uniform cameraUp: vec3f;
uniform viewScale: vec2f;

${AERIAL_PERSPECTIVE_WGSL}

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
  // Adopted payload: rgb premultiplied scene-linear radiance (lit inside the
  // march by sun, sky-ambient LUT and multiple scattering), a transmittance.
  let cloud = textureSampleLevel(cloudSampler, cloudSamplerSampler, uv, 0.0);
  let aux = textureSampleLevel(cloudAuxSampler, cloudAuxSamplerSampler, uv, 0.0);
  let opacity = 1.0 - cloud.a;
  if (opacity < 0.001) { discard; }

  // The shell vertex is fixed at reversed-Z far depth. Opaque terrain and the
  // aircraft therefore win naturally, while clouds remain confined to sky
  // pixels (no fragDepth write — a representative depth caused horizon bands).
  var radiance = cloud.rgb;
  // 1C-4: haze the cloud at its representative scattering depth, on the same
  // shared curve as everything else. The ray is rebuilt with the exact basis
  // formula the raymarch used for this texel. Premultiplied blending:
  // transmittance scales the cloud's own radiance, while in-scatter enters
  // premultiplied by the cloud's coverage of the pixel. Shadow-through-haze
  // stays STRUCTURAL (D-7/R-19): no strength × transmittance term exists.
  let ndc = uv * 2.0 - 1.0;
  let direction = normalize(
    uniforms.cameraForward
      + uniforms.cameraRight * ndc.x * uniforms.viewScale.x
      + uniforms.cameraUp * ndc.y * uniforms.viewScale.y
  );
  let cloudDistance = max(aux.x, 0.0);
  let aerial = aerialPerspective(
    uniforms.aerialCameraAltitude + direction.y * cloudDistance,
    cloudDistance,
    dot(direction, uniforms.aerialSunDirection),
  );
  radiance = radiance * aerial.transmittance + aerial.inScatter * opacity;
  fragmentOutputs.color = vec4f(max(radiance, vec3f(0.0)), opacity);
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${CLOUD_COMPOSITE_SHADER_NAME}VertexShader`] =
    CLOUD_SHELL_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${CLOUD_COMPOSITE_SHADER_NAME}PixelShader`] =
    CLOUD_COMPOSITE_FRAGMENT_WGSL;
}

function configurePremultipliedMaterial(material: ShaderMaterial): void {
  // 1A-4 step 3, resolved by measurement (tests/gpu/cloud-shell-culling.test.ts):
  // the camera-centered BACKSIDE shell rasterises exactly once per pixel.
  // Culling stays enabled as insurance against double-cover.
  material.backFaceCulling = true;
  material.disableDepthWrite = true;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
}

/** Storage texture that computes write and materials/other computes sample. */
function storageTexture(
  scene: Scene,
  name: string,
  width: number,
  height: number,
): RawTexture {
  const texture = RawTexture.CreateRGBAStorageTexture(
    null,
    width,
    height,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_HALF_FLOAT,
  );
  texture.name = name;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

/** ComputeShader from an adopted module's own binding metadata. */
function computeFromModule(scene: Scene, module: NatureShaderModule): ComputeShader {
  const entryPoint = module.entryPoints[0];
  if (!entryPoint || entryPoint.stage !== "compute") {
    throw new RangeError(`${module.label} does not declare a compute entry point`);
  }
  const shader = new ComputeShader(
    module.label,
    scene.getEngine(),
    { computeSource: module.code },
    {
      entryPoint: entryPoint.name,
      bindingsMapping: Object.fromEntries(
        module.bindings.map((binding) => [
          binding.name,
          { group: binding.group, binding: binding.binding },
        ]),
      ),
    },
  );
  shader.onError = (_effect, errors) => {
    throw new Error(`${module.label} failed to compile: ${errors}`);
  };
  return shader;
}

/** A params UBO treated as an opaque vec4-array blob (byte-packed by CloudConfig). */
function paramsBuffer(scene: Scene, name: string, vec4Count: number): UniformBuffer {
  const buffer = new UniformBuffer(scene.getEngine(), undefined, true, name);
  buffer.addUniform("data", 4, vec4Count);
  buffer.create();
  return buffer;
}

function uploadParams(buffer: UniformBuffer, bytes: ArrayBufferLike, vec4Count: number): void {
  // Bit-exact copy: small u32 lanes (sizes, flags) are denormal floats, which
  // Float32Array copies preserve. (Only NaN payloads would be at risk, and
  // none of the packed integers reach the NaN range.)
  buffer.updateUniform("data", new Float32Array(bytes), vec4Count * 4);
  buffer.update();
}

export interface CloudRuntimeStatistics {
  readonly frameIndex: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly renderScale: number;
  readonly raySteps: number;
  readonly lightSteps: number;
  readonly shadowResolution: number;
  readonly shadowWorldSize: number;
  readonly shadowUpdateEveryNFrames: number;
  readonly raymarchDispatchCount: number;
  readonly temporalResolveDispatchCount: number;
  readonly shadowDispatchCount: number;
  readonly historyGeneration: number;
  readonly historyValid: boolean;
  readonly shadowReady: boolean;
  readonly computeSupported: boolean;
}

/** Every compute-side resource, created only where compute exists (not NullEngine). */
interface CloudComputePipeline {
  readonly raymarchCompute: ComputeShader;
  readonly temporalCompute: ComputeShader;
  readonly shadowCompute: ComputeShader;
  readonly raymarchParams: UniformBuffer;
  readonly temporalParams: UniformBuffer;
  readonly shadowParams: UniformBuffer;
  readonly linearSampler: TextureSampler;
  /** 2-1: the GPU-baked noise volumes and weather map. */
  readonly bake: CloudVolumeBake;
  raymarchCloud: RawTexture;
  raymarchAux: RawTexture;
  resolvedCloud: [RawTexture, RawTexture];
  resolvedAux: [RawTexture, RawTexture];
  shadowMap: RawTexture;
}

/** WebGPU volumetric clouds: three adopted compute passes + a composite shell. */
export class VolumetricCloudSystem {
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly shell: Mesh;
  private readonly material: ShaderMaterial;
  private readonly resources: AtmosphereGpuResources;
  /** Null exactly when the engine has no compute support (NullEngine). */
  private readonly pipeline: CloudComputePipeline | null;
  /** 1×1 full-transmittance stand-in when no compute pipeline exists. */
  private readonly shadowFallback: RawTexture;
  private config: VolumetricCloudConfig;
  private profile: WebGpuQualityProfile;
  private environment: EnvironmentState = DEFAULT_ENVIRONMENT_STATE;
  private readonly computeSupported: boolean;
  private readonly cameraWorld = Vector3.Zero();
  private readonly cameraForward = Vector3.Forward();
  private readonly cameraRight = Vector3.Right();
  private readonly cameraUp = Vector3.Up();
  private readonly cameraLocalForward: Vector3;
  private readonly viewScale = new Vector2(1, 1);
  private readonly previousCameraWorld = Vector3.Zero();
  private readonly previousCameraForward = Vector3.Forward();
  private readonly previousCameraRight = Vector3.Right();
  private readonly previousCameraUp = Vector3.Up();
  private readonly previousViewScale = new Vector2(1, 1);
  private previousStateValid = false;
  private readonly fullResolution = new Vector2(1, 1);
  private readonly shadowCenter = new Vector2(0, 0);
  private readonly sunDirection = Vector3.Up();
  private readonly windVector = new Vector2(0, 0);
  private readonly lifetimeController = new AbortController();
  private cloudRenderSize: CloudRenderSize;
  private shadowSchedule: CloudShadowSchedule;
  private historyReadIndex: 0 | 1 = 0;
  private historyValid = false;
  private shadowDirty = true;
  private shadowReady = false;
  /** Governor lever (1A-6b / R-11): a floor on frames between shadow renders. */
  private shadowIntervalFloor: number | null = null;
  private frameIndex = 0;
  private lastShadowFrame = -1;
  private raymarchDispatchCount = 0;
  private temporalResolveDispatchCount = 0;
  private shadowDispatchCount = 0;
  private historyGeneration = 0;
  private disposed = false;

  constructor(
    scene: Scene,
    camera: Camera,
    profile: WebGpuQualityProfile,
    atmosphere: AtmosphereSnapshot,
    resources: AtmosphereGpuResources,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.profile = profile;
    this.resources = resources;
    this.cameraLocalForward = Vector3.Forward(scene.useRightHandedSystem);
    const engine = scene.getEngine();
    this.computeSupported = engine.getCaps().supportComputeShaders === true;
    this.shadowSchedule = resolveCloudShadowSchedule(profile);
    this.config = this.resolveConfig(profile);
    this.cloudRenderSize = resolveCloudRenderSize(
      Math.max(engine.getRenderWidth(), 8),
      Math.max(engine.getRenderHeight(), 8),
      profile.cloudResolutionScale,
    );

    this.shadowFallback = new RawTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    this.shadowFallback.name = "cloud-shadow-fallback-map";
    this.pipeline = this.computeSupported ? this.createPipeline() : null;

    registerShaders();
    this.material = new ShaderMaterial(
      "volumetric-cloud-composite-material",
      scene,
      CLOUD_COMPOSITE_SHADER_NAME,
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "fullResolution",
          "cameraForward",
          "cameraRight",
          "cameraUp",
          "viewScale",
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: ["cloudSampler", "cloudAuxSampler"],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    configurePremultipliedMaterial(this.material);
    this.shell = CreateSphere(
      "volumetric-cloud-shell",
      { diameter: CLOUD_SHELL_DIAMETER_METERS, segments: 24, sideOrientation: BabylonMesh.BACKSIDE },
      scene,
    );
    this.shell.material = this.material;
    this.shell.isPickable = false;
    this.shell.applyFog = false;
    this.shell.alwaysSelectAsActiveMesh = true;
    this.shell.renderingGroupId = 0;
    this.shell.alphaIndex = 1;
    this.shell.setEnabled(false);
    if (this.pipeline) {
      this.material.setTexture("cloudSampler", this.pipeline.resolvedCloud[0]);
      this.material.setTexture("cloudAuxSampler", this.pipeline.resolvedAux[0]);
    }
    this.setAtmosphere(atmosphere);
  }

  /** Config truth (assertion 35): tier values enter through overrides, once. */
  private resolveConfig(profile: WebGpuQualityProfile): VolumetricCloudConfig {
    return resolveVolumetricCloudConfig({
      maximumViewSteps: Math.max(8, Math.min(192, profile.cloudPrimarySteps)),
      lightSteps: Math.max(2, Math.min(16, profile.cloudLightSteps)),
      renderScale: profile.cloudResolutionScale,
      historyWeight: this.shadowSchedule.historyWeight,
      shadowMapResolution: this.shadowSchedule.resolution,
      shadowSteps: this.shadowSchedule.steps,
      shadowUpdateEveryNFrames: this.shadowSchedule.updateEveryNFrames,
    });
  }

  private createPipeline(): CloudComputePipeline {
    const scene = this.scene;
    const bake = new CloudVolumeBake(scene);
    bake.setWeather(
      this.environment.weather.cloudCoverage,
      this.environment.weather.cloudType,
      this.environment.weather.convection,
    );
    const { width, height } = this.cloudRenderSize;
    const linearSampler = new TextureSampler();
    linearSampler.setParameters(
      Texture.WRAP_ADDRESSMODE,
      Texture.WRAP_ADDRESSMODE,
      Texture.WRAP_ADDRESSMODE,
      1,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    const pipeline: CloudComputePipeline = {
      raymarchCompute: computeFromModule(scene, CLOUD_RAYMARCH_SHADER),
      temporalCompute: computeFromModule(scene, CLOUD_TEMPORAL_RESOLVE_SHADER),
      shadowCompute: computeFromModule(scene, CLOUD_SHADOW_SHADER),
      raymarchParams: paramsBuffer(scene, "cloud-raymarch-params", RAYMARCH_PARAMS_VEC4S),
      temporalParams: paramsBuffer(scene, "cloud-temporal-params", TEMPORAL_PARAMS_VEC4S),
      shadowParams: paramsBuffer(scene, "cloud-shadow-params", SHADOW_PARAMS_VEC4S),
      linearSampler,
      bake,
      raymarchCloud: storageTexture(scene, "cloud-raymarch-cloud", width, height),
      raymarchAux: storageTexture(scene, "cloud-raymarch-aux", width, height),
      resolvedCloud: [
        storageTexture(scene, "cloud-resolved-cloud-a", width, height),
        storageTexture(scene, "cloud-resolved-cloud-b", width, height),
      ],
      resolvedAux: [
        storageTexture(scene, "cloud-resolved-aux-a", width, height),
        storageTexture(scene, "cloud-resolved-aux-b", width, height),
      ],
      shadowMap: storageTexture(
        scene,
        "cloud-shadow-map",
        this.shadowSchedule.resolution,
        this.shadowSchedule.resolution,
      ),
    };
    this.bindStaticComputeResources(pipeline);
    this.bindSizedComputeResources(pipeline);
    return pipeline;
  }

  private bindStaticComputeResources(pipeline: CloudComputePipeline): void {
    pipeline.raymarchCompute.setUniformBuffer("params", pipeline.raymarchParams);
    pipeline.raymarchCompute.setTextureSampler("linear_sampler", pipeline.linearSampler);
    pipeline.raymarchCompute.setTexture("scene_depth", this.resources.sceneDepth, false);
    pipeline.raymarchCompute.setTexture("weather_texture", pipeline.bake.weatherMap, false);
    pipeline.raymarchCompute.setTexture("base_noise_texture", pipeline.bake.baseVolume, false);
    pipeline.raymarchCompute.setTexture(
      "detail_noise_texture",
      pipeline.bake.detailVolume,
      false,
    );
    pipeline.raymarchCompute.setTexture("blue_noise_texture", this.resources.blueNoise, false);
    pipeline.raymarchCompute.setTexture("sky_view_lut", this.resources.skyAmbientLut, false);
    pipeline.raymarchCompute.setTexture(
      "atmosphere_transmittance_lut",
      this.resources.transmittanceLut,
      false,
    );
    pipeline.temporalCompute.setUniformBuffer("params", pipeline.temporalParams);
    pipeline.shadowCompute.setUniformBuffer("params", pipeline.shadowParams);
    pipeline.shadowCompute.setTextureSampler("linear_sampler", pipeline.linearSampler);
    pipeline.shadowCompute.setTexture("weather_texture", pipeline.bake.weatherMap, false);
    pipeline.shadowCompute.setTexture("base_noise_texture", pipeline.bake.baseVolume, false);
  }

  private bindSizedComputeResources(pipeline: CloudComputePipeline): void {
    pipeline.raymarchCompute.setStorageTexture("raymarch_cloud", pipeline.raymarchCloud);
    pipeline.raymarchCompute.setStorageTexture("raymarch_aux", pipeline.raymarchAux);
    pipeline.temporalCompute.setTexture("current_cloud", pipeline.raymarchCloud, false);
    pipeline.temporalCompute.setTexture("current_aux", pipeline.raymarchAux, false);
    // Initial ping-pong bindings: update() rebinds per frame, but isReady()
    // requires every declared binding to hold a resource from the start.
    pipeline.temporalCompute.setTexture("history_cloud", pipeline.resolvedCloud[0], false);
    pipeline.temporalCompute.setTexture("history_aux", pipeline.resolvedAux[0], false);
    pipeline.temporalCompute.setStorageTexture("resolved_cloud", pipeline.resolvedCloud[1]);
    pipeline.temporalCompute.setStorageTexture("resolved_aux", pipeline.resolvedAux[1]);
    pipeline.shadowCompute.setStorageTexture("cloud_shadow", pipeline.shadowMap);
  }

  get statistics(): CloudRuntimeStatistics {
    return {
      frameIndex: this.frameIndex,
      renderWidth: this.cloudRenderSize.width,
      renderHeight: this.cloudRenderSize.height,
      renderScale: this.cloudRenderSize.scale,
      raySteps: this.config.maximumViewSteps,
      lightSteps: this.config.lightSteps,
      shadowResolution: this.shadowSchedule.resolution,
      shadowWorldSize: this.config.shadowWorldSizeMeters,
      shadowUpdateEveryNFrames: this.shadowSchedule.updateEveryNFrames,
      raymarchDispatchCount: this.raymarchDispatchCount,
      temporalResolveDispatchCount: this.temporalResolveDispatchCount,
      shadowDispatchCount: this.shadowDispatchCount,
      historyGeneration: this.historyGeneration,
      historyValid: this.historyValid,
      shadowReady: this.shadowReady,
      computeSupported: this.computeSupported,
    };
  }

  get cloudShadow(): CloudShadowProjection {
    return {
      texture: this.pipeline?.shadowMap ?? this.shadowFallback,
      centerX: this.shadowCenter.x,
      centerZ: this.shadowCenter.y,
      worldSizeMeters: this.config.shadowWorldSizeMeters,
      referenceAltitudeMeters: CLOUD_SHADOW_REFERENCE_ALTITUDE_METERS,
      sunDirectionX: this.sunDirection.x,
      sunDirectionY: this.sunDirection.y,
      sunDirectionZ: this.sunDirection.z,
      valid: this.shadowReady,
    };
  }

  /**
   * Startup barrier: resolves when the three compute pipelines and the
   * composite material can execute (NullEngine reports no compute support and
   * the barrier reduces to the material alone — that is what lets the Node
   * tests run the lifecycle without a GPU).
   */
  whenReadyAsync(
    signal?: AbortSignal,
    timeoutMilliseconds = CLOUD_SHADER_STARTUP_TIMEOUT_MILLISECONDS,
  ): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const poll = (): void => {
        if (this.disposed || this.lifetimeController.signal.aborted) {
          reject(cloudStartupAbortError("Cloud system was disposed during startup"));
          return;
        }
        if (signal?.aborted) {
          reject(cloudStartupAbortError("Cloud startup was aborted"));
          return;
        }
        const pipeline = this.pipeline;
        // The sky-ambient LUT allocates lazily on first render; nothing
        // renders the scene during startup, so the barrier warms it (the old
        // pipeline warmed its procedural textures the same way).
        if (pipeline !== null) {
          this.resources.warm();
          pipeline.bake.bakeWhenReady();
        }
        if (Date.now() - startedAt > timeoutMilliseconds) {
          const detail = pipeline === null
            ? "no compute pipeline"
            : `raymarch=${pipeline.raymarchCompute.isReady()} `
              + `temporal=${pipeline.temporalCompute.isReady()} `
              + `shadow=${pipeline.shadowCompute.isReady()} `
              + `material=${this.material.isReady(this.shell)} `
              + `skyLut=${this.resources.skyAmbientLut.isReady()} `
              + `depth=${this.resources.sceneDepth.isReady()} `
              + `transmittance=${this.resources.transmittanceLut.isReady()} `
              + `blueNoise=${this.resources.blueNoise.isReady()}`;
          reject(new Error(
            `Cloud pipelines were not ready after ${timeoutMilliseconds} ms (${detail})`,
          ));
          return;
        }
        const computesReady = pipeline === null || (
          pipeline.raymarchCompute.isReady()
          && pipeline.temporalCompute.isReady()
          && pipeline.shadowCompute.isReady()
          && pipeline.bake.ready
        );
        const materialReady = this.material.isReady(this.shell);
        if (computesReady && materialReady) {
          resolve();
          return;
        }
        setTimeout(poll, CLOUD_SHADER_READINESS_POLL_MILLISECONDS);
      };
      poll();
    });
  }

  /** Governor lever (R-11 GPU ladder): a floor on frames between shadow renders. */
  setShadowIntervalFloor(intervalFrames: number | null): void {
    this.shadowIntervalFloor = intervalFrames;
  }

  setProfile(profile: WebGpuQualityProfile): void {
    if (profile === this.profile) return;
    this.profile = profile;
    const schedule = resolveCloudShadowSchedule(profile);
    const shadowResolutionChanged = schedule.resolution !== this.shadowSchedule.resolution;
    this.shadowSchedule = schedule;
    this.config = this.resolveConfig(profile);
    if (shadowResolutionChanged && this.pipeline) {
      this.pipeline.shadowMap.dispose();
      this.pipeline.shadowMap = storageTexture(
        this.scene,
        "cloud-shadow-map",
        schedule.resolution,
        schedule.resolution,
      );
      this.pipeline.shadowCompute.setStorageTexture("cloud_shadow", this.pipeline.shadowMap);
      this.shadowDirty = true;
      this.shadowReady = false;
    }
    this.ensureCloudResolution();
    this.invalidateHistory();
  }

  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    applyAerialPerspectiveToShaderMaterial(
      this.material,
      binding,
      (name, x, y, z) => this.material.setVector3(name, new Vector3(x, y, z)),
      (name, x, y, z, w) => {
        this.material.setVector4(name, new Vector4(x, y, z, w));
      },
    );
  }

  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    this.sunDirection.copyFrom(atmosphere.sunDirection).normalize();
    this.windVector.set(
      atmosphere.windDirection.x * atmosphere.windSpeed,
      atmosphere.windDirection.y * atmosphere.windSpeed,
    );
    this.shadowDirty = true;
    this.invalidateHistory();
  }

  /**
   * R-13/2-0: the full environment state the adopted packers consume (sun,
   * weather scalars, atmosphere constants). The renderer forwards its
   * resolved state whenever the clock or weather changes.
   */
  setEnvironment(state: EnvironmentState): void {
    this.environment = state;
    this.pipeline?.bake.setWeather(
      state.weather.cloudCoverage,
      state.weather.cloudType,
      state.weather.convection,
    );
  }

  update(cameraWorld: Vector3, timeSeconds: number): void {
    if (this.disposed) return;
    this.frameIndex += 1;
    this.cameraWorld.copyFrom(cameraWorld);
    this.shell.position.copyFrom(this.camera.position);
    this.ensureCloudResolution();
    this.refreshCameraBasis();
    const engine = this.scene.getEngine();
    this.fullResolution.set(engine.getRenderWidth(), engine.getRenderHeight());
    this.material.setVector2("fullResolution", this.fullResolution);
    this.material.setVector3("cameraForward", this.cameraForward);
    this.material.setVector3("cameraRight", this.cameraRight);
    this.material.setVector3("cameraUp", this.cameraUp);
    this.material.setVector2("viewScale", this.viewScale);

    const pipeline = this.pipeline;
    if (!pipeline) return;
    if (
      !pipeline.raymarchCompute.isReady()
      || !pipeline.temporalCompute.isReady()
      || !pipeline.shadowCompute.isReady()
    ) {
      return;
    }
    // The LUTs and the depth map allocate lazily (ProceduralTexture creates
    // its target on first render; the depth RTT renders with the scene). A
    // compute dispatch with a null hardware texture is a crash, not an error.
    if (
      this.resources.skyAmbientLut.getInternalTexture() == null
      || this.resources.sceneDepth.getInternalTexture() == null
      || !this.resources.transmittanceLut.isReady()
      || !this.resources.blueNoise.isReady()
    ) {
      return;
    }
    // 2-1: the noise volumes bake once and the weather map re-bakes on
    // environment change; the march waits for both.
    if (!pipeline.bake.bakeWhenReady()) return;

    const originX = this.cameraWorld.x - this.camera.position.x;
    const originZ = this.cameraWorld.z - this.camera.position.z;
    const environment: EnvironmentState = {
      ...this.environment,
      timeSeconds,
      frameDeltaSeconds: 1 / 60,
      floatingOriginMeters: [originX, 0, originZ],
    };
    const weatherSize = this.config.weatherMapWorldSizeMeters;
    const windOffset: [number, number] = [
      ((this.windVector.x * timeSeconds) % weatherSize + weatherSize) % weatherSize,
      ((this.windVector.y * timeSeconds) % weatherSize + weatherSize) % weatherSize,
    ];

    // 1. Raymarch.
    uploadParams(pipeline.raymarchParams, packCloudRaymarchUniforms(this.config, environment, {
      cameraForward: [this.cameraForward.x, this.cameraForward.y, this.cameraForward.z],
      cameraRight: [this.cameraRight.x, this.cameraRight.y, this.cameraRight.z],
      cameraUp: [this.cameraUp.x, this.cameraUp.y, this.cameraUp.z],
      viewScale: [this.viewScale.x, this.viewScale.y],
      cameraPositionMeters: [
        this.camera.position.x,
        this.camera.position.y,
        this.camera.position.z,
      ],
      renderSize: [this.cloudRenderSize.width, this.cloudRenderSize.height],
      fullResolutionSize: [
        Math.max(1, Math.round(this.fullResolution.x)),
        Math.max(1, Math.round(this.fullResolution.y)),
      ],
      frameIndex: this.frameIndex % 4_096,
      windOffsetMeters: windOffset,
      weatherMapOriginMeters: [0, 0],
    }).buffer as ArrayBuffer, RAYMARCH_PARAMS_VEC4S);
    const [groupsX, groupsY] = computeDispatch2D(
      this.cloudRenderSize.width,
      this.cloudRenderSize.height,
      [8, 8, 1],
    );
    pipeline.raymarchCompute.dispatch(groupsX, groupsY, 1);
    this.raymarchDispatchCount += 1;

    // 2. Temporal resolve into the write half of the ping-pong.
    const writeIndex = (1 - this.historyReadIndex) as 0 | 1;
    const cameraCut = !this.historyValid || !this.previousStateValid;
    uploadParams(pipeline.temporalParams, packCloudTemporalUniforms(this.config, {
      renderSize: [this.cloudRenderSize.width, this.cloudRenderSize.height],
      cameraCut,
      currentForward: [this.cameraForward.x, this.cameraForward.y, this.cameraForward.z],
      currentRight: [this.cameraRight.x, this.cameraRight.y, this.cameraRight.z],
      currentUp: [this.cameraUp.x, this.cameraUp.y, this.cameraUp.z],
      currentViewScale: [this.viewScale.x, this.viewScale.y],
      previousForward: [
        this.previousCameraForward.x,
        this.previousCameraForward.y,
        this.previousCameraForward.z,
      ],
      previousRight: [
        this.previousCameraRight.x,
        this.previousCameraRight.y,
        this.previousCameraRight.z,
      ],
      previousUp: [
        this.previousCameraUp.x,
        this.previousCameraUp.y,
        this.previousCameraUp.z,
      ],
      previousViewScale: [this.previousViewScale.x, this.previousViewScale.y],
      cameraDeltaMeters: [
        this.cameraWorld.x - this.previousCameraWorld.x,
        this.cameraWorld.y - this.previousCameraWorld.y,
        this.cameraWorld.z - this.previousCameraWorld.z,
      ],
    }), TEMPORAL_PARAMS_VEC4S);
    pipeline.temporalCompute.setTexture(
      "history_cloud",
      pipeline.resolvedCloud[this.historyReadIndex],
      false,
    );
    pipeline.temporalCompute.setTexture(
      "history_aux",
      pipeline.resolvedAux[this.historyReadIndex],
      false,
    );
    pipeline.temporalCompute.setStorageTexture(
      "resolved_cloud",
      pipeline.resolvedCloud[writeIndex],
    );
    pipeline.temporalCompute.setStorageTexture(
      "resolved_aux",
      pipeline.resolvedAux[writeIndex],
    );
    pipeline.temporalCompute.dispatch(groupsX, groupsY, 1);
    this.temporalResolveDispatchCount += 1;
    this.historyReadIndex = writeIndex;
    this.historyValid = true;
    this.material.setTexture("cloudSampler", pipeline.resolvedCloud[writeIndex]);
    this.material.setTexture("cloudAuxSampler", pipeline.resolvedAux[writeIndex]);
    if (!this.shell.isEnabled()) this.shell.setEnabled(true);

    // 3. Shadow, on its cadence.
    this.updateShadowPass(environment, windOffset);

    this.previousCameraWorld.copyFrom(this.cameraWorld);
    this.previousCameraForward.copyFrom(this.cameraForward);
    this.previousCameraRight.copyFrom(this.cameraRight);
    this.previousCameraUp.copyFrom(this.cameraUp);
    this.previousViewScale.copyFrom(this.viewScale);
    this.previousStateValid = true;
  }

  private updateShadowPass(
    environment: EnvironmentState,
    windOffset: readonly [number, number],
  ): void {
    const worldSize = this.config.shadowWorldSizeMeters;
    const texelWorldSize = worldSize / this.shadowSchedule.resolution;
    const centerX = Math.round(this.cameraWorld.x / texelWorldSize) * texelWorldSize;
    const centerZ = Math.round(this.cameraWorld.z / texelWorldSize) * texelWorldSize;
    if (centerX !== this.shadowCenter.x || centerZ !== this.shadowCenter.y) {
      this.shadowCenter.set(centerX, centerZ);
      this.shadowDirty = true;
      this.shadowReady = false;
    }
    if (!shouldRenderCloudShadow(
      this.frameIndex,
      this.lastShadowFrame,
      Math.max(this.shadowSchedule.updateEveryNFrames, this.shadowIntervalFloor ?? 1),
      this.shadowDirty,
    )) return;
    if (this.sunDirection.y <= 1e-4) return;
    const originX = environment.floatingOriginMeters[0];
    const originZ = environment.floatingOriginMeters[2];
    const pipeline = this.pipeline;
    if (!pipeline) return;
    uploadParams(pipeline.shadowParams, packCloudShadowUniforms(this.config, environment, {
      shadowCenterMeters: [
        this.shadowCenter.x - originX,
        CLOUD_SHADOW_REFERENCE_ALTITUDE_METERS,
        this.shadowCenter.y - originZ,
      ],
      eastAxis: [1, 0, 0],
      northAxis: [0, 0, 1],
      windOffsetMeters: [windOffset[0], windOffset[1]],
      weatherMapOriginMeters: [0, 0],
      frameIndex: this.frameIndex % 4_096,
    }), SHADOW_PARAMS_VEC4S);
    const [groupsX, groupsY] = computeDispatch2D(
      this.shadowSchedule.resolution,
      this.shadowSchedule.resolution,
      [8, 8, 1],
    );
    pipeline.shadowCompute.dispatch(groupsX, groupsY, 1);
    this.shadowDispatchCount += 1;
    this.lastShadowFrame = this.frameIndex;
    this.shadowDirty = false;
    this.shadowReady = true;
  }

  private refreshCameraBasis(): void {
    this.camera.getDirectionToRef(this.cameraLocalForward, this.cameraForward);
    this.camera.getDirectionToRef(Vector3.Right(), this.cameraRight);
    this.camera.getDirectionToRef(Vector3.Up(), this.cameraUp);
    const scale = viewScaleFromFov(
      this.camera.fov,
      this.scene.getEngine().getAspectRatio(this.camera),
      this.camera.fovMode === BabylonCamera.FOVMODE_HORIZONTAL_FIXED,
    );
    this.viewScale.set(scale.x, scale.y);
  }

  private ensureCloudResolution(): boolean {
    const engine = this.scene.getEngine();
    const next = resolveCloudRenderSize(
      Math.max(engine.getRenderWidth(), 8),
      Math.max(engine.getRenderHeight(), 8),
      this.profile.cloudResolutionScale,
    );
    if (
      next.width === this.cloudRenderSize.width
      && next.height === this.cloudRenderSize.height
    ) {
      this.cloudRenderSize = next;
      return false;
    }
    this.cloudRenderSize = next;
    const pipeline = this.pipeline;
    if (pipeline) {
      for (const texture of [
        pipeline.raymarchCloud,
        pipeline.raymarchAux,
        ...pipeline.resolvedCloud,
        ...pipeline.resolvedAux,
      ]) {
        texture.dispose();
      }
      pipeline.raymarchCloud = storageTexture(
        this.scene, "cloud-raymarch-cloud", next.width, next.height,
      );
      pipeline.raymarchAux = storageTexture(
        this.scene, "cloud-raymarch-aux", next.width, next.height,
      );
      pipeline.resolvedCloud = [
        storageTexture(this.scene, "cloud-resolved-cloud-a", next.width, next.height),
        storageTexture(this.scene, "cloud-resolved-cloud-b", next.width, next.height),
      ];
      pipeline.resolvedAux = [
        storageTexture(this.scene, "cloud-resolved-aux-a", next.width, next.height),
        storageTexture(this.scene, "cloud-resolved-aux-b", next.width, next.height),
      ];
      this.bindSizedComputeResources(pipeline);
      this.material.setTexture("cloudSampler", pipeline.resolvedCloud[0]);
      this.material.setTexture("cloudAuxSampler", pipeline.resolvedAux[0]);
    }
    this.invalidateHistory();
    return true;
  }

  invalidateHistory(): void {
    this.historyValid = false;
    this.historyReadIndex = 0;
    this.shell.setEnabled(false);
    this.historyGeneration += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetimeController.abort();
    this.shell.dispose();
    this.material.dispose();
    this.shadowFallback.dispose();
    const pipeline = this.pipeline;
    if (pipeline) {
      pipeline.raymarchParams.dispose();
      pipeline.temporalParams.dispose();
      pipeline.shadowParams.dispose();
      pipeline.bake.dispose();
      pipeline.raymarchCloud.dispose();
      pipeline.raymarchAux.dispose();
      for (const texture of [...pipeline.resolvedCloud, ...pipeline.resolvedAux]) {
        texture.dispose();
      }
      pipeline.shadowMap.dispose();
    }
  }
}
