import { Camera } from "@babylonjs/core/Cameras/camera";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Matrix, Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import {
  CLOUD_SHADOW_RECEIVER_SAMPLER,
  CLOUD_SHADOW_RECEIVER_UNIFORMS,
  CLOUD_SHADOW_RECEIVER_WGSL,
  resolveCloudShadowReceiverBinding,
  type CloudShadowProjection,
} from "@/src/render/webgpu/clouds/CloudShadowReceiver";
import { viewScaleFromFov } from "@/src/render/webgpu/clouds/CloudReprojection";
import {
  buildOceanFftDispatches,
  resolveSpectralOceanConfig,
  type SpectralOceanConfig,
} from "@/src/render/webgpu/nature/OceanConfig";
import {
  OCEAN_SPATIAL_DERIVATION_WGSL,
  OCEAN_SPECTRUM_EVOLUTION_WGSL,
  OCEAN_SPECTRUM_INITIALIZATION_WGSL,
  OCEAN_STOCKHAM_IFFT_WGSL,
} from "@/src/render/webgpu/nature/OceanShaders";
import {
  PLANAR_REFLECTION_FRAGMENT_WGSL,
  PLANAR_REFLECTION_SAMPLER,
  PLANAR_REFLECTION_UNIFORMS,
  type PlanarReflectionBinding,
  type PlanarReflectionReceiver,
} from "./PlanarWaterReflectionSystem";
import {
  bindSunShadowReceiver,
  SUN_SHADOW_FRAGMENT_WGSL,
  SUN_SHADOW_SAMPLER,
  SUN_SHADOW_UNIFORMS,
  SUN_SHADOW_VERTEX_DECLARATIONS_WGSL,
  sunShadowVertexAssignmentWgsl,
  type SunShadowReceiverBinding,
} from "./SunShadowReceiver";
import {
  fallbackWaterEnvironmentCube,
  fallbackWaterPlanarTexture,
  WATER_BATHYMETRY_DECLARATIONS_WGSL,
  WATER_CREST_SSS_WGSL,
  WATER_DEPTH_OPTICS_WGSL,
  WATER_ENVIRONMENT_MIP_WGSL,
  WATER_FOAM_WGSL,
  WATER_FRESNEL_SCHLICK_WGSL,
  WATER_SHADING_CONSTANTS_WGSL,
  WATER_SUN_SPECULAR_WGSL,
  waterReflectedSkyWgsl,
  type WaterReflectedSkyParameters,
} from "./WaterShaders";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { BathymetryClipmap } from "./BathymetryClipmap";
import { withoutDispatchTiming } from "../core/GpuTimingPolicy";

const WATER_SHADER_NAME = "aerolithSpectralWater";
const MAX_RENDER_CASCADES = 5;
const OCEAN_PRESENTATION_RADIUS_METERS = 40_000;
const COMPUTE_PIPELINE_TIMEOUT_MILLISECONDS = 30_000;

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError("Spectral-ocean startup was cancelled");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Babylon's dispatchWhenReady retries forever and cannot be cancelled. Renderer
 * startup and quality swaps need a finite, abortable compilation boundary so a
 * bad WGSL pipeline cannot leak resources or leave the game permanently hung.
 */
function waitForComputeReady(
  shader: ComputeShader,
  signal?: AbortSignal,
  timeoutMilliseconds = COMPUTE_PIPELINE_TIMEOUT_MILLISECONDS,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const previousCompiled = shader.onCompiled;
    const previousError = shader.onError;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (shader.onCompiled === onCompiled) shader.onCompiled = previousCompiled;
      if (shader.onError === onError) shader.onError = previousError;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError(`Compilation of ${shader.name} was cancelled`));
    const onCompiled: NonNullable<ComputeShader["onCompiled"]> = (effect) => {
      previousCompiled?.(effect);
      finish();
    };
    const onError: NonNullable<ComputeShader["onError"]> = (effect, errors) => {
      previousError?.(effect, errors);
      finish(new Error(`Unable to compile ${shader.name}: ${errors || "unknown WGSL error"}`));
    };
    const poll = () => {
      if (settled) return;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        if (shader.isReady()) {
          finish();
          return;
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (performance.now() - started >= timeoutMilliseconds) {
        finish(new Error(`Timed out compiling ${shader.name} after ${timeoutMilliseconds} ms`));
        return;
      }
      timer = setTimeout(poll, 16);
    };

    shader.onCompiled = onCompiled;
    shader.onError = onError;
    signal?.addEventListener("abort", onAbort, { once: true });
    poll();
  });
}

export interface OceanPresentationTopology {
  readonly radialRings: number;
  readonly angularSegments: number;
  readonly nearStepMeters: number;
}

/**
 * A camera-centred radial grid spends vertices where wave displacement is
 * visible and lets cells grow smoothly toward the hazed horizon. This avoids
 * wasting a uniform 80 km grid while retaining one crack-free water surface.
 * The 40 km presentation radius is reconciled with the 45 km far plane
 * (1C-4): a disk wider than the far plane is clipped and loses its horizon.
 */
export function oceanPresentationTopology(
  profile: Pick<WebGpuQualityProfile, "tier">,
): OceanPresentationTopology {
  if (profile.tier === 0) {
    return { radialRings: 96, angularSegments: 128, nearStepMeters: 1 };
  }
  if (profile.tier === 1) {
    return { radialRings: 144, angularSegments: 192, nearStepMeters: 0.75 };
  }
  return { radialRings: 192, angularSegments: 256, nearStepMeters: 0.5 };
}

function createOceanPresentationMesh(
  scene: Scene,
  profile: WebGpuQualityProfile,
): Mesh {
  const topology = oceanPresentationTopology(profile);
  const vertexCount = 1 + topology.radialRings * topology.angularSegments;
  const positions = new Float32Array(vertexCount * 3);

  let vertex = 1;
  const curvedRadius = Math.max(
    0,
    OCEAN_PRESENTATION_RADIUS_METERS
      - topology.nearStepMeters * topology.radialRings,
  );
  for (let ring = 1; ring <= topology.radialRings; ring += 1) {
    const normalized = ring / topology.radialRings;
    const radius = topology.nearStepMeters * ring
      + curvedRadius * normalized ** 5;
    for (let segment = 0; segment < topology.angularSegments; segment += 1) {
      const angle = segment / topology.angularSegments * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const positionOffset = vertex * 3;
      positions[positionOffset] = x;
      positions[positionOffset + 2] = z;
      vertex += 1;
    }
  }

  const triangleCount = topology.angularSegments
    + (topology.radialRings - 1) * topology.angularSegments * 2;
  const IndexArray = vertexCount > 65_535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(triangleCount * 3);
  let write = 0;
  for (let segment = 0; segment < topology.angularSegments; segment += 1) {
    const next = (segment + 1) % topology.angularSegments;
    indices[write++] = 0;
    indices[write++] = 1 + next;
    indices[write++] = 1 + segment;
  }
  for (let ring = 2; ring <= topology.radialRings; ring += 1) {
    const inner = 1 + (ring - 2) * topology.angularSegments;
    const outer = inner + topology.angularSegments;
    for (let segment = 0; segment < topology.angularSegments; segment += 1) {
      const next = (segment + 1) % topology.angularSegments;
      indices[write++] = inner + segment;
      indices[write++] = outer + next;
      indices[write++] = outer + segment;
      indices[write++] = inner + segment;
      indices[write++] = inner + next;
      indices[write++] = outer + next;
    }
  }

  const mesh = new Mesh("spectral-ocean", scene);
  const data = new VertexData();
  // 2-8: the dead uv lane is gone — the per-vertex cascade fades the plan
  // earmarked it for are a pure function of ring radius on this
  // camera-centred disk, so the vertex shader computes them from position.
  data.positions = positions;
  data.indices = indices;
  data.applyToMesh(mesh, false);
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

/** Resolves Nyquist-safe bands for the profile before selecting its cascades. */
export function resolveProfileSpectralOceanConfig(
  profile: Pick<WebGpuQualityProfile, "oceanCascades" | "oceanResolution">,
  seed: number,
  windDirectionRadians?: number,
  windSpeedMetersPerSecond?: number,
): SpectralOceanConfig {
  const profileDefaults = resolveSpectralOceanConfig({
    resolution: profile.oceanResolution,
  });
  const windDirection = windDirectionRadians === undefined
    ? profileDefaults.windDirection
    : [Math.sin(windDirectionRadians), Math.cos(windDirectionRadians)] as const;
  return resolveSpectralOceanConfig({
    resolution: profile.oceanResolution,
    seed: seed >>> 0,
    windDirection,
    windSpeedMetersPerSecond:
      windSpeedMetersPerSecond ?? profileDefaults.windSpeedMetersPerSecond,
    cascades: profileDefaults.cascades.slice(0, profile.oceanCascades),
  });
}

export const WATER_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform oceanWorldOrigin: vec2f;
uniform patchLengths0: vec4f;
uniform patchLength4: f32;
uniform cascadeCount: f32;
uniform cascadeFadeRadii0: vec4f;
uniform cascadeFadeRadius4: f32;
uniform cascadeFadeCameraHeight: f32;
uniform planarReflectionViewProjection: mat4x4f;
var displacement0Sampler: sampler; var displacement0: texture_2d<f32>;
var displacement1Sampler: sampler; var displacement1: texture_2d<f32>;
var displacement2Sampler: sampler; var displacement2: texture_2d<f32>;
var displacement3Sampler: sampler; var displacement3: texture_2d<f32>;
var displacement4Sampler: sampler; var displacement4: texture_2d<f32>;
varying worldPosition: vec3f;
varying oceanCoordinate: vec2f;
varying cascadeFades: vec4f;
varying cascadeFade4: f32;
varying waveCrest: f32;
varying planarReflectionClip: vec4f;
${SUN_SHADOW_VERTEX_DECLARATIONS_WGSL}

fn sampleDisplacement(worldXZ: vec2f, patchLength: f32, displacementTexture: texture_2d<f32>, displacementSampler: sampler) -> vec3f {
  let coordinate = fract(worldXZ / patchLength);
  return textureSampleLevel(displacementTexture, displacementSampler, coordinate, 0.0).xyz;
}

// 2-8: each cascade fades out where its band's longest wavelength falls
// below two rendered pixels (the distance is computed by the CPU from the
// camera's fovMode-aware pixel angle). This replaces the hardcoded
// 0.62/0.82/0.74/0.52/0.36 blend weights, and fading the DISPLACEMENT too
// removes the vertex-level shimmer where ring spacing exceeds the band's
// wavelengths. The fade keys on SLANT RANGE — the disk is camera-centred in
// xz only, and from altitude the sea straight below is already distant.
fn cascadeFade(slantRange: f32, fadeEndDistance: f32) -> f32 {
  return 1.0 - smoothstep(fadeEndDistance * 0.3, fadeEndDistance, slantRange);
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let worldXZ = uniforms.oceanWorldOrigin + vertexInputs.position.xz;
  let vertexRadius = length(vertexInputs.position.xz);
  let slantRange = sqrt(
    vertexRadius * vertexRadius
      + uniforms.cascadeFadeCameraHeight * uniforms.cascadeFadeCameraHeight,
  );
  let fades = vec4f(
    cascadeFade(slantRange, uniforms.cascadeFadeRadii0.x),
    cascadeFade(slantRange, uniforms.cascadeFadeRadii0.y),
    cascadeFade(slantRange, uniforms.cascadeFadeRadii0.z),
    cascadeFade(slantRange, uniforms.cascadeFadeRadii0.w),
  );
  let fade4 = cascadeFade(slantRange, uniforms.cascadeFadeRadius4);
  var displacement = vec3f(0.0);
  displacement += sampleDisplacement(worldXZ, uniforms.patchLengths0.x, displacement0, displacement0Sampler) * fades.x;
  if (uniforms.cascadeCount > 1.5) { displacement += sampleDisplacement(worldXZ, uniforms.patchLengths0.y, displacement1, displacement1Sampler) * fades.y; }
  if (uniforms.cascadeCount > 2.5) { displacement += sampleDisplacement(worldXZ, uniforms.patchLengths0.z, displacement2, displacement2Sampler) * fades.z; }
  if (uniforms.cascadeCount > 3.5) { displacement += sampleDisplacement(worldXZ, uniforms.patchLengths0.w, displacement3, displacement3Sampler) * fades.w; }
  if (uniforms.cascadeCount > 4.5) { displacement += sampleDisplacement(worldXZ, uniforms.patchLength4, displacement4, displacement4Sampler) * fade4; }
  var displaced = vec4f(vertexInputs.position + displacement, 1.0);
  // 1C-7: drop the surface with the Earth's curvature (camera-centred local
  // frame, R = 6371 km). Without this the flat disk's vanishing line sits at
  // eye level and the sea reads as a plate instead of a horizon.
  displaced.y -= dot(vertexInputs.position.xz, vertexInputs.position.xz) / (2.0 * 6371000.0);
  let world = uniforms.world * displaced;
  vertexOutputs.position = uniforms.viewProjection * world;
  vertexOutputs.worldPosition = world.xyz;
  vertexOutputs.oceanCoordinate = worldXZ + displacement.xz;
  vertexOutputs.cascadeFades = fades;
  vertexOutputs.cascadeFade4 = fade4;
  vertexOutputs.waveCrest = displacement.y;
  vertexOutputs.planarReflectionClip = uniforms.planarReflectionViewProjection * world;
${sunShadowVertexAssignmentWgsl("world")}
}
`;

/**
 * 2-8a/2-9 — the ocean's analytic-sky fallback constants, named at the call
 * site. 2-9's call on the old sun-disc divergence: DELETED on both surfaces —
 * the sun's reflection comes solely from the shared Karis lobe. What
 * survives is the slightly brighter open-sea overcast palette against the
 * hydrology's darker one.
 */
const OCEAN_REFLECTED_SKY_PARAMETERS: WaterReflectedSkyParameters = {
  horizonFalloffExponent: 2.5,
  overcastZenithColor: [0.34, 0.39, 0.45],
  overcastHorizonColor: [0.58, 0.63, 0.68],
};

/** 2-9: open-sea foam albedo (the inland surface runs a brighter one). */
const OCEAN_FOAM_ALBEDO_WGSL = "vec3f(0.69, 0.75, 0.73)";
/** 2-9: Gate 2B's declared crest-SSS tuning knob. */
const OCEAN_CREST_SSS_INTENSITY_WGSL = "0.55";

export const WATER_FRAGMENT_WGSL = /* wgsl */ `
varying worldPosition: vec3f;
varying oceanCoordinate: vec2f;
varying cascadeFades: vec4f;
varying cascadeFade4: f32;
varying waveCrest: f32;
varying planarReflectionClip: vec4f;
uniform cameraPosition: vec3f;
uniform sunDirection: vec3f;
uniform sunColor: vec3f;
uniform sunAngularRadius: f32;
uniform skyZenith: vec3f;
uniform skyHorizon: vec3f;
uniform cloudCoverage: f32;
uniform cloudWind: vec2f;
uniform time: f32;
uniform patchLengths0: vec4f;
uniform patchLength4: f32;
uniform cascadeCount: f32;
uniform environmentValid: f32;
var environmentCubeSampler: sampler; var environmentCube: texture_cube<f32>;
${WATER_BATHYMETRY_DECLARATIONS_WGSL}
var slopeFoam0Sampler: sampler; var slopeFoam0: texture_2d<f32>;
var slopeFoam1Sampler: sampler; var slopeFoam1: texture_2d<f32>;
var slopeFoam2Sampler: sampler; var slopeFoam2: texture_2d<f32>;
var slopeFoam3Sampler: sampler; var slopeFoam3: texture_2d<f32>;
var slopeFoam4Sampler: sampler; var slopeFoam4: texture_2d<f32>;
var slopeMoment0Sampler: sampler; var slopeMoment0: texture_2d<f32>;
var slopeMoment1Sampler: sampler; var slopeMoment1: texture_2d<f32>;
var slopeMoment2Sampler: sampler; var slopeMoment2: texture_2d<f32>;
var slopeMoment3Sampler: sampler; var slopeMoment3: texture_2d<f32>;
var slopeMoment4Sampler: sampler; var slopeMoment4: texture_2d<f32>;

${CLOUD_SHADOW_RECEIVER_WGSL}
${PLANAR_REFLECTION_FRAGMENT_WGSL}
${SUN_SHADOW_FRAGMENT_WGSL}
${AERIAL_PERSPECTIVE_WGSL}

${WATER_SHADING_CONSTANTS_WGSL}

${WATER_FRESNEL_SCHLICK_WGSL}

${WATER_DEPTH_OPTICS_WGSL}

${WATER_SUN_SPECULAR_WGSL}

${WATER_FOAM_WGSL}

${WATER_CREST_SSS_WGSL}

${WATER_ENVIRONMENT_MIP_WGSL}

${waterReflectedSkyWgsl(OCEAN_REFLECTED_SKY_PARAMETERS)}

// 2-8: derivatives come from the UNWRAPPED coordinate — fract() has a
// derivative discontinuity at every patch seam that would spike the
// selected mip there. Slopes filter linearly, so the mip chain is correct
// by construction (a box-filtered normal is not).
fn sampleSlopeTexture(worldXZ: vec2f, patchLength: f32, source: texture_2d<f32>, sourceSampler: sampler) -> vec4f {
  let unwrapped = worldXZ / patchLength;
  return textureSampleGrad(source, sourceSampler, fract(unwrapped), dpdx(unwrapped), dpdy(unwrapped));
}

// 2-8: the variance folded into roughness is the band's MISSING energy —
// what the true sea carries (the moment mips' E[s²]) minus what the rendered
// surface keeps (the fade-scaled mean, squared). At fade 1 this is the
// classic Toksvig footprint variance; at fade 0 it is the band's whole
// mean-square slope, so a faded-out cascade lives on as roughness instead of
// vanishing from the BRDF (multiplying Var(s) by fade² deleted exactly the
// energy this term exists to preserve).
fn cascadeSlopeVariance(sample: vec4f, moment: vec4f, fade: f32) -> f32 {
  return max(moment.x - fade * fade * sample.x * sample.x, 0.0)
    + max(moment.y - fade * fade * sample.y * sample.y, 0.0);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // 2-8: heights add across cascades, so slopes add — the fade-weighted SUM
  // replaces the old weighted average of normal-recovered slopes and its
  // clamped-denominator recovery.
  let baseSample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.x, slopeFoam0, slopeFoam0Sampler);
  let baseMoment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.x, slopeMoment0, slopeMoment0Sampler);
  var slopeSum = baseSample.xy * input.cascadeFades.x;
  var foamAmount = baseSample.z * input.cascadeFades.x;
  var slopeVariance = cascadeSlopeVariance(baseSample, baseMoment, input.cascadeFades.x);
  if (uniforms.cascadeCount > 1.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.y, slopeFoam1, slopeFoam1Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.y, slopeMoment1, slopeMoment1Sampler); slopeSum += sample.xy * input.cascadeFades.y; foamAmount = max(foamAmount, sample.z * input.cascadeFades.y); slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFades.y); }
  if (uniforms.cascadeCount > 2.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.z, slopeFoam2, slopeFoam2Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.z, slopeMoment2, slopeMoment2Sampler); slopeSum += sample.xy * input.cascadeFades.z; foamAmount = max(foamAmount, sample.z * input.cascadeFades.z); slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFades.z); }
  if (uniforms.cascadeCount > 3.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.w, slopeFoam3, slopeFoam3Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLengths0.w, slopeMoment3, slopeMoment3Sampler); slopeSum += sample.xy * input.cascadeFades.w; foamAmount = max(foamAmount, sample.z * input.cascadeFades.w); slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFades.w); }
  if (uniforms.cascadeCount > 4.5) { let sample = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLength4, slopeFoam4, slopeFoam4Sampler); let moment = sampleSlopeTexture(input.oceanCoordinate, uniforms.patchLength4, slopeMoment4, slopeMoment4Sampler); slopeSum += sample.xy * input.cascadeFade4; foamAmount = max(foamAmount, sample.z * input.cascadeFade4); slopeVariance += cascadeSlopeVariance(sample, moment, input.cascadeFade4); }
  let geometricNormal = normalize(vec3f(slopeSum.x, 1.0, slopeSum.y));
  let view = normalize(uniforms.cameraPosition - input.worldPosition);
  let cameraBelow = uniforms.cameraPosition.y < input.worldPosition.y;
  let normal = select(geometricNormal, -geometricNormal, cameraBelow);
  let light = normalize(uniforms.sunDirection);
  let nDotV = max(dot(normal, view), 0.0);
  let nDotL = max(dot(normal, light), 0.0);
  let cameraDistance = distance(uniforms.cameraPosition, input.worldPosition);
  let reflectionDirection = reflect(-view, normal);
  let fresnel = waterInterfaceFresnel(normal, view, cameraBelow);
  let cloudShadow = sampleCloudShadowReceiver(input.worldPosition);
  let sunShadow = sampleSunShadowReceiver(
    input.sunShadowClip0,
    input.sunShadowClip1,
    input.sunShadowClip2,
    input.sunShadowClip3,
    input.sunShadowViewDepth,
  );
  let directSunVisibility = cloudShadow * sunShadow;
  let depth = waterDepthFromBathymetry(input.worldPosition.y, input.oceanCoordinate);
  let baseRoughness = 0.075 + foamAmount * 0.2;
  let microAlpha = baseRoughness * baseRoughness;
  let alphaSquared = microAlpha * microAlpha + min(slopeVariance, 0.25);
  let roughness = clamp(sqrt(sqrt(alphaSquared)), 0.065, 0.34);
  // 2-9: the sky reflection comes from the shared environment probe (the
  // rendered sky, clouds and haze included), roughness-mapped to its mips;
  // the analytic zenith/horizon mix remains only as the not-yet-valid
  // fallback, and no fake sun disc is painted into either — the sun's
  // reflection is solely the physical lobe below.
  let analyticSky = reflectedSky(reflectionDirection);
  let environmentSky = textureSampleLevel(
    environmentCube,
    environmentCubeSampler,
    reflectionDirection,
    environmentRoughnessToMip(roughness),
  ).rgb;
  let skyReflection = mix(analyticSky, environmentSky, uniforms.environmentValid);
  let reflected = samplePlanarSceneReflection(
    input.planarReflectionClip,
    normal,
    input.worldPosition.y,
    skyReflection,
  );
  // 5-11: the body is now the same real bed + Beer-Lambert + one-scatter
  // model used by inland water, rather than an additive deep-blue constant.
  let transmitted = waterVolumeRadiance(
    input.oceanCoordinate,
    input.worldPosition.y,
    depth,
    normal,
    view,
    cameraBelow,
    directSunVisibility,
  );
  let subsurfaceScatter = vec3f(0.012, 0.13, 0.115)
    * nDotL * (0.1 + 0.12 * directSunVisibility);
  let horizonScatter = vec3f(0.008, 0.055, 0.064) * pow(1.0 - nDotV, 2.0);
  // 2-9: backlit crests transmit sunlight — driven by the summed
  // displacement height the vertex shader computes (previously discarded).
  let crestGlow = crestSubsurface(
    input.waveCrest,
    view,
    light,
    uniforms.sunColor,
    directSunVisibility,
    ${OCEAN_CREST_SSS_INTENSITY_WGSL},
  );
  let bodyColor = transmitted + subsurfaceScatter + horizonScatter + crestGlow;
  // 2-9: the one solid-angle-correct sun lobe (Karis), shared with inland
  // water — the sun's angular radius replaced the 2.6 gain.
  let sunGlitter = sunSpecular(normal, view, light, roughness, uniforms.sunAngularRadius, vec3f(0.0204))
    * uniforms.sunColor * directSunVisibility;
  var water = mix(bodyColor, reflected, fresnel);
  water += sunGlitter;
  // 2-9: lit foam with an advected Worley break-up — foam is a Lambertian
  // surface, not paint, and it drifts downwind.
  let foamMask = foamBreakup(input.oceanCoordinate, uniforms.cloudWind * uniforms.time * 0.6);
  let foam = clamp(foamAmount * 1.18, 0.0, 1.0) * mix(0.35, 1.0, foamMask);
  let foamColor = litFoamColor(
    ${OCEAN_FOAM_ALBEDO_WGSL},
    normal,
    light,
    uniforms.sunColor,
    uniforms.skyZenith,
    uniforms.skyHorizon,
    directSunVisibility,
  );
  water = mix(water, foamColor, foam);
  if (cameraBelow) {
    water = applyUnderwaterBeerLambert(water, cameraDistance, directSunVisibility);
  }
  // 1C-4: the shared aerial perspective — the ocean fades on the same curve
  // as terrain, closing the audit's hard tear at every distant coastline.
  water = applyAerialPerspective(water, input.worldPosition.y, cameraDistance, -view);
  let shorelineAlpha = max(waterShorelineAlpha(depth), foam);
  fragmentOutputs.color = vec4f(max(water, vec3f(0.0)), shorelineAlpha);
}
`;

function registerWaterShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${WATER_SHADER_NAME}VertexShader`] = WATER_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${WATER_SHADER_NAME}PixelShader`] = WATER_FRAGMENT_WGSL;
}

function rgbaStorage(
  scene: Scene,
  resolution: number,
  type: number,
  name: string,
  samplingMode?: number,
  generateMipMaps = false,
): RawTexture {
  const texture = RawTexture.CreateRGBAStorageTexture(
    null,
    resolution,
    resolution,
    scene,
    // 2-8: mipped outputs get real mip storage. Babylon's WebGPU texture
    // manager force-adds RENDER_ATTACHMENT usage for every non-compressed 2D
    // format (rgba16float is renderable), which is exactly what the
    // render-based mip generator needs.
    generateMipMaps,
    false,
    samplingMode ?? (type === Constants.TEXTURETYPE_HALF_FLOAT
      ? Texture.BILINEAR_SAMPLINGMODE
      : Texture.NEAREST_SAMPLINGMODE),
    type,
  );
  texture.name = name;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

/**
 * 2-8: the private Babylon surface that regenerates a storage texture's mip
 * chain. Storage textures can only be written at mip 0 (`webgpuHardwareTexture`
 * creates the write view with `mipLevelCount = 1` and `setStorageTexture`
 * takes no mip index), so a compute reduce is not expressible — the
 * render-based generator is the only path. `engine._generateMipmaps` defaults
 * to the engine's `_renderEncoder`, so the blit passes record into the SAME
 * command encoder as the derivation's compute pass, after it — no stale-mip
 * frame — and it closes any open render pass first. `RenderInvariants`
 * asserts this shape at startup so a Babylon bump fails loudly, not silently
 * unfiltered.
 */
export function resolveOceanMipGenerator(
  engine: AbstractEngine,
): ((texture: RawTexture) => void) | null {
  const candidate = engine as unknown as {
    _generateMipmaps?: (texture: unknown, commandEncoder?: unknown) => void;
  };
  if (typeof candidate._generateMipmaps !== "function") return null;
  return (texture) => {
    const internal = texture.getInternalTexture();
    if (internal) candidate._generateMipmaps!(internal);
  };
}

function createCompute(
  name: string,
  engine: AbstractEngine,
  source: string,
  entryPoint: string,
  names: readonly string[],
): ComputeShader {
  return withoutDispatchTiming(new ComputeShader(name, engine, { computeSource: source }, {
    entryPoint,
    bindingsMapping: Object.fromEntries(names.map((bindingName, binding) => [
      bindingName,
      { group: 0, binding },
    ])),
  }));
}

function createInitializationUniforms(
  engine: AbstractEngine,
  config: SpectralOceanConfig,
  cascadeIndex: number,
): UniformBuffer {
  const cascade = config.cascades[cascadeIndex];
  if (!cascade) throw new RangeError("Missing ocean cascade");
  const buffer = new UniformBuffer(engine, undefined, false, `ocean-init-${cascadeIndex}`);
  for (const name of ["resolution", "seed", "cascadeIndex", "padding0"]) buffer.addUniform(name, 1);
  for (const name of ["patchLength", "gravity", "windSpeed", "fetchLength"]) buffer.addUniform(name, 1);
  buffer.addUniform("windDirection", 2);
  for (const name of ["spectrumScale", "directionalSpread", "depth", "surfaceTension", "minWavelength", "maxWavelength"]) buffer.addUniform(name, 1);
  buffer.create();
  buffer.updateUInt("resolution", config.resolution);
  buffer.updateUInt("seed", config.seed);
  buffer.updateUInt("cascadeIndex", cascadeIndex);
  buffer.updateUInt("padding0", 0);
  buffer.updateFloat("patchLength", cascade.patchLengthMeters);
  buffer.updateFloat("gravity", config.gravityMetersPerSecondSquared);
  buffer.updateFloat("windSpeed", config.windSpeedMetersPerSecond);
  buffer.updateFloat("fetchLength", config.fetchLengthMeters);
  buffer.updateFloat2("windDirection", config.windDirection[0], config.windDirection[1]);
  buffer.updateFloat("spectrumScale", cascade.spectrumScale);
  buffer.updateFloat("directionalSpread", config.directionalSpread);
  buffer.updateFloat("depth", config.representativeDepthMeters);
  buffer.updateFloat("surfaceTension", config.surfaceTensionOverDensity);
  buffer.updateFloat("minWavelength", cascade.minimumWavelengthMeters);
  buffer.updateFloat("maxWavelength", cascade.maximumWavelengthMeters);
  buffer.update();
  return buffer;
}

function createEvolutionUniforms(
  engine: AbstractEngine,
  config: SpectralOceanConfig,
  cascadeIndex: number,
): UniformBuffer {
  const buffer = new UniformBuffer(engine, undefined, true, `ocean-evolve-${cascadeIndex}`);
  buffer.addUniform("header", 4);
  buffer.addUniform("time", 1);
  buffer.addUniform("gravity", 1);
  buffer.addUniform("depth", 1);
  buffer.addUniform("choppiness", 1);
  buffer.create();
  buffer.updateUInt4("header", config.resolution, cascadeIndex, 0, 0);
  buffer.updateFloat("gravity", config.gravityMetersPerSecondSquared);
  buffer.updateFloat("depth", config.representativeDepthMeters);
  buffer.updateFloat("choppiness", config.choppiness);
  buffer.update();
  return buffer;
}

function createFftUniforms(
  engine: AbstractEngine,
  resolution: number,
  stage: number,
  axis: "horizontal" | "vertical",
  normalize: boolean,
): UniformBuffer {
  const buffer = new UniformBuffer(engine, undefined, false, `ocean-fft-${axis}-${stage}`);
  buffer.addUniform("params", 4);
  buffer.create();
  buffer.updateUInt4("params", resolution, stage, axis === "horizontal" ? 0 : 1, normalize ? 1 : 0);
  buffer.update();
  return buffer;
}

function createDerivationUniforms(
  engine: AbstractEngine,
  config: SpectralOceanConfig,
  cascadeIndex: number,
): UniformBuffer {
  const cascade = config.cascades[cascadeIndex];
  if (!cascade) throw new RangeError("Missing ocean cascade");
  const buffer = new UniformBuffer(engine, undefined, true, `ocean-derive-${cascadeIndex}`);
  buffer.addUniform("header", 4);
  buffer.addUniform("texelLength", 1);
  buffer.addUniform("foamThreshold", 1);
  buffer.addUniform("foamGain", 1);
  buffer.addUniform("foamDecay", 1);
  buffer.create();
  buffer.updateUInt4("header", config.resolution, 0, 0, 0);
  buffer.updateFloat("texelLength", cascade.patchLengthMeters / config.resolution);
  buffer.updateFloat("foamThreshold", config.foamThreshold);
  buffer.updateFloat("foamGain", config.foamGain);
  buffer.updateFloat("foamDecay", 1);
  buffer.update();
  return buffer;
}

interface FftPass {
  readonly shader: ComputeShader;
  readonly uniform: UniformBuffer;
  readonly dispatch: readonly [number, number, number];
  readonly outputIndex: 0 | 1;
}

interface OceanCascadeRuntime {
  readonly initialSpectrum: RawTexture;
  readonly waveData: RawTexture;
  readonly transformA: readonly [RawTexture, RawTexture];
  readonly transformB: readonly [RawTexture, RawTexture];
  readonly displacement: RawTexture;
  readonly slopeFoam: readonly [RawTexture, RawTexture];
  readonly slopeMoment: RawTexture;
  readonly initialization: ComputeShader;
  readonly initializationUniform: UniformBuffer;
  readonly evolution: ComputeShader;
  readonly evolutionUniform: UniformBuffer;
  readonly fftPasses: readonly FftPass[];
  readonly derivation: readonly [ComputeShader, ComputeShader];
  readonly derivationUniform: UniformBuffer;
  finalTransformIndex: 0 | 1;
  normalIndex: 0 | 1;
  elapsedSecondsSinceDerivation: number;
}

/** Native WebGPU compute implementation of band-limited JONSWAP/Stockham ocean cascades. */
class SpectralOceanCompute {
  readonly config: SpectralOceanConfig;
  readonly cascades: readonly OceanCascadeRuntime[];
  private readonly generateMips: ((texture: RawTexture) => void) | null;
  private frameIndex = 0;

  constructor(
    scene: Scene,
    profile: WebGpuQualityProfile,
    seed: number,
    windDirectionRadians?: number,
    windSpeedMetersPerSecond?: number,
  ) {
    this.config = resolveProfileSpectralOceanConfig(
      profile,
      seed,
      windDirectionRadians,
      windSpeedMetersPerSecond,
    );
    const engine = scene.getEngine();
    this.generateMips = resolveOceanMipGenerator(engine);
    this.cascades = this.config.cascades.map((_, cascadeIndex) => {
      const resolution = this.config.resolution;
      const initialSpectrum = rgbaStorage(scene, resolution, Constants.TEXTURETYPE_FLOAT, `ocean-h0-${cascadeIndex}`);
      const waveData = rgbaStorage(scene, resolution, Constants.TEXTURETYPE_FLOAT, `ocean-wave-${cascadeIndex}`);
      // 1B-13: the FFT ping-pong works in rgba16float (half the bandwidth of
      // the previous rgba32float); per-axis normalisation keeps the signal
      // band inside fp16's normal range. NEAREST explicitly — these are
      // textureLoad-only compute intermediates, not presentation textures.
      const transformA = [0, 1].map((index) => rgbaStorage(scene, resolution, Constants.TEXTURETYPE_HALF_FLOAT, `ocean-a${index}-${cascadeIndex}`, Texture.NEAREST_SAMPLINGMODE)) as [RawTexture, RawTexture];
      const transformB = [0, 1].map((index) => rgbaStorage(scene, resolution, Constants.TEXTURETYPE_HALF_FLOAT, `ocean-b${index}-${cascadeIndex}`, Texture.NEAREST_SAMPLINGMODE)) as [RawTexture, RawTexture];
      const displacement = rgbaStorage(scene, resolution, Constants.TEXTURETYPE_HALF_FLOAT, `ocean-displacement-${cascadeIndex}`);
      // 2-8: slope + second-moment outputs carry mip chains (trilinear) so the
      // fragment's textureSampleGrad picks a correctly filtered footprint and
      // the moment mips recover slope variance for Toksvig roughness.
      const slopeFoam = [0, 1].map((index) => rgbaStorage(scene, resolution, Constants.TEXTURETYPE_HALF_FLOAT, `ocean-slope-foam${index}-${cascadeIndex}`, Texture.TRILINEAR_SAMPLINGMODE, true)) as [RawTexture, RawTexture];
      const slopeMoment = rgbaStorage(scene, resolution, Constants.TEXTURETYPE_HALF_FLOAT, `ocean-slope-moment-${cascadeIndex}`, Texture.TRILINEAR_SAMPLINGMODE, true);

      const initializationUniform = createInitializationUniforms(engine, this.config, cascadeIndex);
      const initialization = createCompute(
        `ocean-initialize-${cascadeIndex}`,
        engine,
        OCEAN_SPECTRUM_INITIALIZATION_WGSL,
        "initializeOceanSpectrum",
        ["params", "initial_spectrum", "wave_data"],
      );
      initialization.setUniformBuffer("params", initializationUniform);
      initialization.setStorageTexture("initial_spectrum", initialSpectrum);
      initialization.setStorageTexture("wave_data", waveData);

      const evolutionUniform = createEvolutionUniforms(engine, this.config, cascadeIndex);
      const evolution = createCompute(
        `ocean-evolve-${cascadeIndex}`,
        engine,
        OCEAN_SPECTRUM_EVOLUTION_WGSL,
        "evolveOceanSpectrum",
        ["params", "initial_spectrum", "wave_data", "height_displacement_x", "displacement_z_aux"],
      );
      evolution.setUniformBuffer("params", evolutionUniform);
      evolution.setTexture("initial_spectrum", initialSpectrum, false);
      evolution.setTexture("wave_data", waveData, false);
      evolution.setStorageTexture("height_displacement_x", transformA[0]);
      evolution.setStorageTexture("displacement_z_aux", transformB[0]);

      let sourceIndex: 0 | 1 = 0;
      const fftPasses = buildOceanFftDispatches(resolution).map((pass): FftPass => {
        const outputIndex = (1 - sourceIndex) as 0 | 1;
        const uniform = createFftUniforms(engine, resolution, pass.stage, pass.axis, pass.normalize);
        const shader = createCompute(
          `ocean-fft-${cascadeIndex}-${pass.axis}-${pass.stage}`,
          engine,
          OCEAN_STOCKHAM_IFFT_WGSL,
          "stockhamInverseFft",
          ["params", "source_a", "source_b", "destination_a", "destination_b"],
        );
        shader.setUniformBuffer("params", uniform);
        shader.setTexture("source_a", transformA[sourceIndex], false);
        shader.setTexture("source_b", transformB[sourceIndex], false);
        shader.setStorageTexture("destination_a", transformA[outputIndex]);
        shader.setStorageTexture("destination_b", transformB[outputIndex]);
        sourceIndex = outputIndex;
        return { shader, uniform, dispatch: pass.dispatch, outputIndex };
      });

      const derivationUniform = createDerivationUniforms(engine, this.config, cascadeIndex);
      const derivation = ([0, 1] as const).map((previousIndex) => {
        const outputIndex = (1 - previousIndex) as 0 | 1;
        const shader = createCompute(
          `ocean-derive-${cascadeIndex}-${previousIndex}`,
          engine,
          OCEAN_SPATIAL_DERIVATION_WGSL,
          "deriveOceanSurface",
          ["params", "spatial_height_displacement_x", "spatial_displacement_z_aux", "previous_slope_foam", "displacement_jacobian", "slope_foam", "slope_moment"],
        );
        shader.setUniformBuffer("params", derivationUniform);
        shader.setTexture("spatial_height_displacement_x", transformA[sourceIndex], false);
        shader.setTexture("spatial_displacement_z_aux", transformB[sourceIndex], false);
        shader.setTexture("previous_slope_foam", slopeFoam[previousIndex], false);
        shader.setStorageTexture("displacement_jacobian", displacement);
        shader.setStorageTexture("slope_foam", slopeFoam[outputIndex]);
        shader.setStorageTexture("slope_moment", slopeMoment);
        return shader;
      }) as [ComputeShader, ComputeShader];

      return {
        initialSpectrum,
        waveData,
        transformA,
        transformB,
        displacement,
        slopeFoam,
        slopeMoment,
        initialization,
        initializationUniform,
        evolution,
        evolutionUniform,
        fftPasses,
        derivation,
        derivationUniform,
        finalTransformIndex: sourceIndex,
        normalIndex: 0,
        elapsedSecondsSinceDerivation: 0,
      };
    });
  }

  async initialize(signal?: AbortSignal, timeSeconds = 0): Promise<void> {
    throwIfAborted(signal);
    const groups = Math.ceil(this.config.resolution / 8);
    const shaders = this.cascades.flatMap((cascade) => [
      cascade.initialization,
      cascade.evolution,
      ...cascade.fftPasses.map((pass) => pass.shader),
      ...cascade.derivation,
    ]);
    const compilationAbort = new AbortController();
    const forwardAbort = () => compilationAbort.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      await Promise.all(
        shaders.map((shader) => waitForComputeReady(shader, compilationAbort.signal)),
      );
      throwIfAborted(signal);
      for (const shader of shaders) shader.fastMode = true;
    } catch (error) {
      compilationAbort.abort();
      if (signal?.aborted) throw abortError("Spectral-ocean startup was cancelled");
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }

    for (const cascade of this.cascades) {
      if (!cascade.initialization.dispatch(groups, groups, 1)) {
        throw new Error(`Unable to initialize ${cascade.initialization.name}`);
      }
    }
    // Produce a complete displacement/normal/foam set before publishing this
    // compute runtime. Live quality changes therefore swap moving waves, never
    // a flat H0-only surface that fills in over several cadence frames.
    this.cascades.forEach((cascade, cascadeIndex) => {
      if (!this.dispatchCascade(cascade, cascadeIndex, timeSeconds, 1)) {
        throw new Error(`Unable to warm spectral-ocean cascade ${cascadeIndex}`);
      }
    });
  }

  update(timeSeconds: number, deltaSeconds: number): void {
    this.frameIndex += 1;
    this.cascades.forEach((cascade, cascadeIndex) => {
      cascade.elapsedSecondsSinceDerivation += deltaSeconds;
      const cascadeConfig = this.config.cascades[cascadeIndex];
      if (!cascadeConfig || this.frameIndex % cascadeConfig.updateEveryNFrames !== 0) return;
      const foamDecay = Math.exp(
        -Math.LN2 * cascade.elapsedSecondsSinceDerivation
          / this.config.foamHalfLifeSeconds,
      );
      this.dispatchCascade(cascade, cascadeIndex, timeSeconds, foamDecay);
    });
  }

  dispose(): void {
    for (const cascade of this.cascades) {
      cascade.initializationUniform.dispose();
      cascade.evolutionUniform.dispose();
      cascade.derivationUniform.dispose();
      for (const pass of cascade.fftPasses) pass.uniform.dispose();
      cascade.initialSpectrum.dispose();
      cascade.waveData.dispose();
      cascade.transformA.forEach((texture) => texture.dispose());
      cascade.transformB.forEach((texture) => texture.dispose());
      cascade.displacement.dispose();
      cascade.slopeFoam.forEach((texture) => texture.dispose());
      cascade.slopeMoment.dispose();
    }
  }

  private dispatchCascade(
    cascade: OceanCascadeRuntime,
    cascadeIndex: number,
    timeSeconds: number,
    foamDecay: number,
  ): boolean {
    const groups = Math.ceil(this.config.resolution / 8);
    cascade.evolutionUniform.updateFloat("time", timeSeconds);
    cascade.evolutionUniform.update();
    if (!cascade.evolution.dispatch(groups, groups, 1)) return false;
    for (const pass of cascade.fftPasses) {
      if (!pass.shader.dispatch(...pass.dispatch)) return false;
    }
    const nextNormal = (1 - cascade.normalIndex) as 0 | 1;
    cascade.derivationUniform.updateFloat("foamDecay", foamDecay);
    cascade.derivationUniform.update();
    if (!cascade.derivation[cascade.normalIndex].dispatch(groups, groups, 1)) return false;
    // 2-8: the derivation wrote mip 0; rebuild the chains so the fragment's
    // gradient sampling filters correctly. The generator records into the
    // same command encoder as the compute pass, after it.
    if (this.generateMips) {
      this.generateMips(cascade.slopeFoam[nextNormal]);
      this.generateMips(cascade.slopeMoment);
    }
    cascade.normalIndex = nextNormal;
    cascade.elapsedSecondsSinceDerivation = 0;
    return true;
  }
}

/** FFT-displaced, camera-centered deep ocean with dielectric Fresnel and GGX sun glint. */
export class SpectralOceanSystem implements PlanarReflectionReceiver {
  private compute: SpectralOceanCompute;
  private mesh: Mesh;
  private readonly material: ShaderMaterial;
  private profile: WebGpuQualityProfile;
  private rebuildAbortController: AbortController | null = null;
  private rebuildGeneration = 0;
  private disposed = false;
  private lastTimeSeconds = 0;
  private originX = 0;
  private originZ = 0;
  private cameraWorld = Vector3.Zero();
  private readonly cloudShadowCenterLocal = Vector2.Zero();
  private readonly cloudShadowSunDirection = Vector3.Up();
  private cloudShadowProjection: CloudShadowProjection | null = null;
  private sunShadowBinding: SunShadowReceiverBinding | null = null;

  private constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly seaLevel: number,
    profile: WebGpuQualityProfile,
    seed: number,
    atmosphere: AtmosphereSnapshot,
    windDirectionRadians?: number,
    windSpeedMetersPerSecond?: number,
    private readonly bathymetry: BathymetryClipmap | null = null,
  ) {
    registerWaterShaders();
    this.profile = profile;
    this.compute = new SpectralOceanCompute(
      scene,
      profile,
      seed,
      windDirectionRadians,
      windSpeedMetersPerSecond,
    );
    this.mesh = createOceanPresentationMesh(scene, profile);
    this.material = new ShaderMaterial(
      "spectral-ocean-material",
      scene,
      WATER_SHADER_NAME,
      {
        attributes: ["position"],
        uniforms: [
          "world",
          "viewProjection",
          "oceanWorldOrigin",
          "patchLengths0",
          "patchLength4",
          "cascadeCount",
          "cascadeFadeRadii0",
          "cascadeFadeRadius4",
          "cascadeFadeCameraHeight",
          "cameraPosition",
          "sunDirection",
          "sunColor",
          "sunAngularRadius",
          "skyZenith",
          "skyHorizon",
          "cloudCoverage",
          "cloudWind",
          "time",
          "environmentValid",
          "bathymetryNearPlacement",
          "bathymetryFarPlacement",
          "bathymetrySeaLevel",
          ...CLOUD_SHADOW_RECEIVER_UNIFORMS,
          ...PLANAR_REFLECTION_UNIFORMS,
          ...SUN_SHADOW_UNIFORMS,
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: [
          ...Array.from({ length: MAX_RENDER_CASCADES }, (_, index) => [
            `displacement${index}`,
            `slopeFoam${index}`,
            `slopeMoment${index}`,
          ]).flat(),
          CLOUD_SHADOW_RECEIVER_SAMPLER,
          PLANAR_REFLECTION_SAMPLER,
          SUN_SHADOW_SAMPLER,
          "environmentCube",
          "bathymetryNear",
          "bathymetryFar",
        ],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    // 2-9: the environment sampler must be bound from construction (an
    // unbound declared sampler keeps the WebGPU material un-ready forever);
    // the renderer upgrades it to the sky probe once that exists.
    const fallbackCube = fallbackWaterEnvironmentCube(scene);
    if (fallbackCube) this.material.setTexture("environmentCube", fallbackCube);
    this.material.setFloat("environmentValid", 0);
    this.bathymetry?.bind(this.material);
    // 2-10: the planar capture is retired; the receiver sampler stays bound
    // to a zero-confidence texel until 5-12 re-points a lake capture.
    this.material.setTexture(
      PLANAR_REFLECTION_SAMPLER,
      fallbackWaterPlanarTexture(scene),
    );
    this.material.backFaceCulling = false;
    this.material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.material.alphaMode = Constants.ALPHA_COMBINE;
    this.material.disableDepthWrite = true;
    this.material.setMatrix("planarReflectionViewProjection", Matrix.Identity());
    this.material.setFloat("planarReflectionPlaneHeight", seaLevel);
    this.material.setFloat("planarReflectionStrength", 0);
    this.material.setFloat("planarReflectionValid", 0);
    this.material.setFloat("planarReflectionReceiverEnabled", 1);
    this.configureMesh(this.mesh);
    this.updateMaterialTopology();
    this.setAtmosphere(atmosphere);
    this.bindOutputs();
  }

  static async create(
    scene: Scene,
    camera: Camera,
    seaLevel: number,
    profile: WebGpuQualityProfile,
    seed: number,
    atmosphere: AtmosphereSnapshot,
    windDirectionRadians?: number,
    windSpeedMetersPerSecond?: number,
    signal?: AbortSignal,
    bathymetry?: BathymetryClipmap,
  ): Promise<SpectralOceanSystem> {
    const ocean = new SpectralOceanSystem(
      scene,
      camera,
      seaLevel,
      profile,
      seed,
      atmosphere,
      windDirectionRadians,
      windSpeedMetersPerSecond,
      bathymetry ?? null,
    );
    try {
      await ocean.compute.initialize(signal, 0);
      throwIfAborted(signal);
      return ocean;
    } catch (error) {
      ocean.dispose();
      throw error;
    }
  }

  get cascadeCount(): number {
    return this.compute.cascades.length;
  }

  get fftResolution(): number {
    return this.compute.config.resolution;
  }

  setFloatingOrigin(x: number, z: number): void {
    this.originX = x;
    this.originZ = z;
    this.applyCloudShadowProjection();
  }

  setCloudShadow(projection: CloudShadowProjection): void {
    this.cloudShadowProjection = projection;
    this.applyCloudShadowProjection();
  }

  setSunShadows(shadows: CascadedShadowGenerator): void {
    this.sunShadowBinding?.dispose();
    this.sunShadowBinding = bindSunShadowReceiver(this.material, this.camera, shadows);
  }

  setPlanarReflection(binding: PlanarReflectionBinding | null): void {
    if (!binding) {
      this.material.setFloat("planarReflectionValid", 0);
      const fallbackPlanar = fallbackWaterPlanarTexture(this.scene);
      if (fallbackPlanar) this.material.setTexture(PLANAR_REFLECTION_SAMPLER, fallbackPlanar);
      return;
    }
    this.material.setTexture(PLANAR_REFLECTION_SAMPLER, binding.texture);
    this.material.setMatrix("planarReflectionViewProjection", binding.viewProjection);
    this.material.setFloat("planarReflectionPlaneHeight", binding.planeHeight);
    this.material.setFloat("planarReflectionStrength", binding.strength);
    this.material.setFloat("planarReflectionValid", binding.valid ? 1 : 0);
    this.material.setFloat(
      "planarReflectionReceiverEnabled",
      binding.source === "ocean" ? 1 : 0,
    );
  }

  /** Per-frame haze binding, resolved once by the renderer for all consumers. */
  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    applyAerialPerspectiveToShaderMaterial(
      this.material,
      binding,
      (name, x, y, z) => this.material.setVector3(name, new Vector3(x, y, z)),
      (name, x, y, z, w) => this.material.setVector4(name, new Vector4(x, y, z, w)),
    );
  }

  /**
   * 2-9: environment reflections from the shared sky probe (1C-6). Pass null
   * to fall back to the analytic zenith/horizon sky.
   */
  setEnvironmentReflection(texture: BaseTexture | null): void {
    if (!texture) {
      const fallbackCube = fallbackWaterEnvironmentCube(this.scene);
      if (fallbackCube) this.material.setTexture("environmentCube", fallbackCube);
      this.material.setFloat("environmentValid", 0);
      return;
    }
    this.material.setTexture("environmentCube", texture);
    this.material.setFloat("environmentValid", 1);
  }

  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    this.material.setVector3("sunDirection", atmosphere.sunDirection);
    this.material.setColor3(
      "sunColor",
      atmosphere.sunColor.scale(atmosphere.sunIlluminanceNormalized),
    );
    this.material.setFloat("sunAngularRadius", atmosphere.sunAngularRadiusRadians);
    this.material.setFloat("cloudCoverage", atmosphere.cloudCoverage);
    this.material.setVector2(
      "cloudWind",
      atmosphere.windDirection.scale(atmosphere.windSpeed),
    );
    this.material.setColor3("skyZenith", atmosphere.skyZenith);
    this.material.setColor3("skyHorizon", atmosphere.skyHorizon);
  }

  /**
   * Rebuilds compute resources off the active path, then swaps atomically once
   * the new pipelines and initial spectra are ready. Rapid settings changes
   * invalidate older rebuilds instead of exposing partially initialized waves.
   */
  setProfile(profile: WebGpuQualityProfile): void {
    if (this.disposed) return;
    this.rebuildAbortController?.abort();
    this.rebuildAbortController = null;
    // Compare against the published runtime, not the previous requested
    // profile. Settings apply quality and rendering mode back-to-back; using
    // the requested profile could abort the first rebuild and then incorrectly
    // conclude that no replacement is needed.
    const topologyChanged = profile.oceanResolution !== this.compute.config.resolution
      || profile.oceanCascades !== this.compute.cascades.length;
    const previousTopology = oceanPresentationTopology(this.profile);
    const nextTopology = oceanPresentationTopology(profile);
    const meshChanged = previousTopology.radialRings !== nextTopology.radialRings
      || previousTopology.angularSegments !== nextTopology.angularSegments;
    this.profile = profile;
    if (meshChanged) {
      const nextMesh = createOceanPresentationMesh(this.scene, profile);
      this.configureMesh(nextMesh);
      nextMesh.position.copyFrom(this.mesh.position);
      this.mesh.dispose(false, false);
      this.mesh = nextMesh;
    }
    if (!topologyChanged) return;
    const generation = ++this.rebuildGeneration;
    const controller = new AbortController();
    this.rebuildAbortController = controller;
    const nextCompute = new SpectralOceanCompute(
      this.scene,
      profile,
      this.compute.config.seed,
      Math.atan2(
        this.compute.config.windDirection[0],
        this.compute.config.windDirection[1],
      ),
      this.compute.config.windSpeedMetersPerSecond,
    );
    void nextCompute.initialize(controller.signal, this.lastTimeSeconds).then(() => {
      if (this.disposed || generation !== this.rebuildGeneration) {
        nextCompute.dispose();
        return;
      }
      const previous = this.compute;
      this.compute = nextCompute;
      this.updateMaterialTopology();
      this.bindOutputs();
      previous.dispose();
    }).catch((error: unknown) => {
      nextCompute.dispose();
      if (!isAbortError(error)) {
        console.error("Unable to rebuild the spectral-ocean quality profile", error);
      }
    }).finally(() => {
      if (this.rebuildAbortController === controller) this.rebuildAbortController = null;
    });
  }

  update(cameraWorld: Vector3, timeSeconds: number, deltaSeconds: number): void {
    this.cameraWorld.copyFrom(cameraWorld);
    this.lastTimeSeconds = timeSeconds;
    this.compute.update(timeSeconds, deltaSeconds);
    this.bindOutputs();
    this.bathymetry?.bind(this.material);
    this.mesh.position.set(
      cameraWorld.x - this.originX,
      this.seaLevel,
      cameraWorld.z - this.originZ,
    );
    this.material.setVector2(
      "oceanWorldOrigin",
      new Vector2(cameraWorld.x, cameraWorld.z),
    );
    this.material.setFloat("time", timeSeconds);
    this.material.setVector3("cameraPosition", this.camera.position);
    this.updateCascadeFadeRadii();
  }

  /**
   * 2-8: per-cascade fade-end distances — the range at which a cascade's
   * longest wavelength spans two rendered pixels. Beyond it the whole band is
   * sub-Nyquist and its energy lives on in the Toksvig roughness instead.
   * Uses the shared fovMode-aware helper (1B-11: `camera.fov` is HORIZONTAL
   * under the renderer's pinned FOVMODE_HORIZONTAL_FIXED — the vertical-fixed
   * formula shrinks every radius by the aspect ratio). The shader fades on
   * slant range (√(ringRadius² + cameraHeight²)), not ring radius, so a high
   * camera correctly fades bands that are sub-pixel straight down.
   */
  private updateCascadeFadeRadii(): void {
    const engine = this.scene.getEngine();
    const renderWidth = Math.max(1, engine.getRenderWidth(true));
    const renderHeight = Math.max(1, engine.getRenderHeight(true));
    const viewScale = viewScaleFromFov(
      this.camera.fov,
      renderWidth / renderHeight,
      this.camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED,
    );
    const pixelAngleRadians = (2 * viewScale.x) / renderWidth;
    const fadeEnd = (cascadeIndex: number): number => {
      const cascade = this.compute.config.cascades[cascadeIndex]
        ?? this.compute.config.cascades[this.compute.config.cascades.length - 1];
      if (!cascade) return OCEAN_PRESENTATION_RADIUS_METERS;
      return cascade.maximumWavelengthMeters / (2 * Math.max(pixelAngleRadians, 1e-6));
    };
    this.material.setVector4("cascadeFadeRadii0", new Vector4(
      fadeEnd(0),
      fadeEnd(1),
      fadeEnd(2),
      fadeEnd(3),
    ));
    this.material.setFloat("cascadeFadeRadius4", fadeEnd(4));
    this.material.setFloat(
      "cascadeFadeCameraHeight",
      Math.max(0, this.camera.globalPosition.y - this.seaLevel),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rebuildAbortController?.abort();
    this.rebuildAbortController = null;
    this.rebuildGeneration += 1;
    this.sunShadowBinding?.dispose();
    this.sunShadowBinding = null;
    this.compute.dispose();
    this.mesh.dispose(false, false);
    // Compute outputs and cloud transmittance are owned by their source systems.
    this.material.dispose(true, false);
  }

  private bindOutputs(): void {
    const fallback = this.compute.cascades[0];
    if (!fallback) return;
    for (let index = 0; index < MAX_RENDER_CASCADES; index += 1) {
      const cascade = this.compute.cascades[index] ?? fallback;
      this.material.setTexture(`displacement${index}`, cascade.displacement);
      this.material.setTexture(`slopeFoam${index}`, cascade.slopeFoam[cascade.normalIndex]);
      this.material.setTexture(`slopeMoment${index}`, cascade.slopeMoment);
    }
  }

  private configureMesh(mesh: Mesh): void {
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    // Depth-aware ocean first, graph-fed inland water second. Both remain in
    // one transparent group so the terrain bed is already present and shallow
    // pixels can feather instead of punching an opaque coastline silhouette.
    mesh.renderingGroupId = 1;
    mesh.alphaIndex = 0;
    mesh.metadata = {
      ...(mesh.metadata as Record<string, unknown> | null),
      waterSurface: true,
      excludePlanarReflection: true,
    };
    mesh.material = this.material;
  }

  private applyCloudShadowProjection(): void {
    const projection = this.cloudShadowProjection;
    if (!projection) return;
    const binding = resolveCloudShadowReceiverBinding(
      projection,
      this.originX,
      this.originZ,
    );
    this.cloudShadowCenterLocal.set(binding.centerLocalX, binding.centerLocalZ);
    this.cloudShadowSunDirection.set(
      binding.sunDirectionX,
      binding.sunDirectionY,
      binding.sunDirectionZ,
    );
    this.material.setTexture(CLOUD_SHADOW_RECEIVER_SAMPLER, projection.texture);
    this.material.setVector2("cloudShadowCenterLocal", this.cloudShadowCenterLocal);
    this.material.setFloat("cloudShadowWorldSize", binding.worldSizeMeters);
    this.material.setFloat(
      "cloudShadowReferenceAltitude",
      binding.referenceAltitudeMeters,
    );
    this.material.setVector3("cloudShadowSunDirection", this.cloudShadowSunDirection);
    this.material.setFloat("cloudShadowReceiverValid", binding.valid ? 1 : 0);
    this.material.setFloat("cloudShadowStrength", binding.strength);
  }

  private updateMaterialTopology(): void {
    const lengths = this.compute.config.cascades.map(
      (cascade) => cascade.patchLengthMeters,
    );
    this.material.setVector4("patchLengths0", {
      x: lengths[0] ?? 64,
      y: lengths[1] ?? lengths[0] ?? 64,
      z: lengths[2] ?? lengths[0] ?? 64,
      w: lengths[3] ?? lengths[0] ?? 64,
    });
    this.material.setFloat("patchLength4", lengths[4] ?? lengths.at(-1) ?? 64);
    this.material.setFloat("cascadeCount", this.compute.cascades.length);
    this.updateCascadeFadeRadii();
  }
}
