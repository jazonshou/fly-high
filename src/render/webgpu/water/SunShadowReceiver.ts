import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";

export const SUN_SHADOW_MAX_CASCADES = 4;
export const SUN_SHADOW_SAMPLER = "sunShadowMap";
export const SUN_SHADOW_UNIFORMS = Object.freeze([
  "sunShadowMatrices",
  "sunShadowView",
  "sunShadowSplits",
  "sunShadowBlendStarts",
  "sunShadowCascadeCount",
  "sunShadowDarkness",
  "sunShadowValid",
] as const);

/** Vertex declarations shared by custom water materials. */
export const SUN_SHADOW_VERTEX_DECLARATIONS_WGSL = /* wgsl */ `
uniform sunShadowMatrices: array<mat4x4f, 4>;
uniform sunShadowView: mat4x4f;
varying sunShadowClip0: vec4f;
varying sunShadowClip1: vec4f;
varying sunShadowClip2: vec4f;
varying sunShadowClip3: vec4f;
varying sunShadowViewDepth: f32;
`;

/**
 * Must be inserted after the displaced local-world position has been resolved.
 * `worldPosition` is an expression naming that vec4f.
 */
export function sunShadowVertexAssignmentWgsl(worldPosition: string): string {
  return /* wgsl */ `
  vertexOutputs.sunShadowClip0 = uniforms.sunShadowMatrices[0] * ${worldPosition};
  vertexOutputs.sunShadowClip1 = uniforms.sunShadowMatrices[1] * ${worldPosition};
  vertexOutputs.sunShadowClip2 = uniforms.sunShadowMatrices[2] * ${worldPosition};
  vertexOutputs.sunShadowClip3 = uniforms.sunShadowMatrices[3] * ${worldPosition};
  vertexOutputs.sunShadowViewDepth = max(
    -(uniforms.sunShadowView * ${worldPosition}).z,
    0.0,
  );
`;
}

/**
 * Samples Babylon's existing PCF depth-array with no extra shadow render pass.
 * `textureSampleCompareLevel` avoids derivative-uniformity restrictions when
 * adjacent fragments resolve to different cascades.
 */
export const SUN_SHADOW_FRAGMENT_WGSL = /* wgsl */ `
uniform sunShadowSplits: vec4f;
uniform sunShadowBlendStarts: vec4f;
uniform sunShadowCascadeCount: f32;
uniform sunShadowDarkness: f32;
uniform sunShadowValid: f32;
var sunShadowMapSampler: sampler_comparison;
var sunShadowMap: texture_depth_2d_array;
varying sunShadowClip0: vec4f;
varying sunShadowClip1: vec4f;
varying sunShadowClip2: vec4f;
varying sunShadowClip3: vec4f;
varying sunShadowViewDepth: f32;

fn sunShadowClipForCascade(
  cascade: i32,
  clip0: vec4f,
  clip1: vec4f,
  clip2: vec4f,
  clip3: vec4f,
) -> vec4f {
  if (cascade == 0) { return clip0; }
  if (cascade == 1) { return clip1; }
  if (cascade == 2) { return clip2; }
  return clip3;
}

fn sunShadowVectorValue(values: vec4f, index: i32) -> f32 {
  if (index == 0) { return values.x; }
  if (index == 1) { return values.y; }
  if (index == 2) { return values.z; }
  return values.w;
}

fn sampleSunShadowCascade(
  cascade: i32,
  clip0: vec4f,
  clip1: vec4f,
  clip2: vec4f,
  clip3: vec4f,
) -> f32 {
  let projected = sunShadowClipForCascade(cascade, clip0, clip1, clip2, clip3);
  let clip = projected.xyz / max(abs(projected.w), 0.000001);
  let uv = clip.xy * 0.5 + vec2f(0.5);
  // WebGPU's NDC z range is 0..1. Reversed-Z is already encoded in both the
  // CSM projection and the comparison sampler attached to its depth texture.
  if (
    uv.x <= 0.0 || uv.x >= 1.0
    || uv.y <= 0.0 || uv.y >= 1.0
    || clip.z < 0.0 || clip.z > 1.0
  ) {
    return 1.0;
  }
  let compared = textureSampleCompareLevel(
    sunShadowMap,
    sunShadowMapSampler,
    uv,
    cascade,
    clamp(clip.z, 0.0, 0.99999994),
  );
  return mix(uniforms.sunShadowDarkness, 1.0, compared);
}

fn sampleSunShadowReceiver(
  clip0: vec4f,
  clip1: vec4f,
  clip2: vec4f,
  clip3: vec4f,
  viewDepth: f32,
) -> f32 {
  if (uniforms.sunShadowValid < 0.5) { return 1.0; }
  let cascadeCount = i32(uniforms.sunShadowCascadeCount + 0.5);
  var cascade = 0;
  if (viewDepth > uniforms.sunShadowSplits.x) { cascade = 1; }
  if (viewDepth > uniforms.sunShadowSplits.y) { cascade = 2; }
  if (viewDepth > uniforms.sunShadowSplits.z) { cascade = 3; }
  if (viewDepth > uniforms.sunShadowSplits.w) { cascade = 4; }
  if (cascade >= cascadeCount) { return 1.0; }

  let current = sampleSunShadowCascade(cascade, clip0, clip1, clip2, clip3);
  if (cascade >= cascadeCount - 1) { return current; }
  let blendStart = sunShadowVectorValue(uniforms.sunShadowBlendStarts, cascade);
  let split = sunShadowVectorValue(uniforms.sunShadowSplits, cascade);
  if (viewDepth <= blendStart || split <= blendStart) { return current; }
  let next = sampleSunShadowCascade(cascade + 1, clip0, clip1, clip2, clip3);
  return mix(current, next, clamp((viewDepth - blendStart) / (split - blendStart), 0.0, 1.0));
}
`;

export interface SunShadowCascadeParameters {
  readonly cameraMinZ: number;
  readonly cameraMaxZ: number;
  readonly cascadeCount: number;
  readonly lambda: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly shadowMaxZ: number;
  readonly cascadeBlendPercentage: number;
}

export interface SunShadowCascadeLayout {
  readonly cascadeCount: number;
  readonly splits: readonly [number, number, number, number];
  readonly blendStarts: readonly [number, number, number, number];
}

/** Mirrors Babylon's public CSM split formula without reading private arrays. */
export function resolveSunShadowCascadeLayout(
  parameters: SunShadowCascadeParameters,
): SunShadowCascadeLayout {
  const cascadeCount = Math.max(
    1,
    Math.min(SUN_SHADOW_MAX_CASCADES, Math.floor(parameters.cascadeCount)),
  );
  const near = parameters.cameraMinZ;
  const far = parameters.cameraMaxZ || parameters.shadowMaxZ;
  const cameraRange = Math.max(far - near, 0.000001);
  const maximumDistance = parameters.shadowMaxZ < far && parameters.shadowMaxZ >= near
    ? Math.min((parameters.shadowMaxZ - near) / cameraRange, parameters.maxDistance)
    : parameters.maxDistance;
  const minimumZ = near + parameters.minDistance * cameraRange;
  const maximumZ = near + maximumDistance * cameraRange;
  const range = maximumZ - minimumZ;
  const ratio = maximumZ / Math.max(minimumZ, 0.000001);
  const splits: [number, number, number, number] = [1e30, 1e30, 1e30, 1e30];
  const blendStarts: [number, number, number, number] = [...splits];
  let previousSplit = minimumZ;
  for (let cascade = 0; cascade < cascadeCount; cascade += 1) {
    const fraction = (cascade + 1) / cascadeCount;
    const logarithmic = minimumZ * ratio ** fraction;
    const uniform = minimumZ + range * fraction;
    const split = parameters.lambda * (logarithmic - uniform) + uniform;
    const length = split - previousSplit;
    splits[cascade] = split;
    blendStarts[cascade] = split
      - length * Math.max(0, Math.min(1, parameters.cascadeBlendPercentage));
    previousSplit = split;
  }
  return {
    cascadeCount,
    splits,
    blendStarts,
  };
}

export interface SunShadowReceiverBinding {
  dispose(): void;
}

/**
 * Binds only documented Babylon APIs. The adapter follows map/cascade changes
 * on every material bind, so quality switches do not retain a stale depth view.
 */
export function bindSunShadowReceiver(
  material: ShaderMaterial,
  camera: Camera,
  shadows: CascadedShadowGenerator,
): SunShadowReceiverBinding {
  const matrices = new Float32Array(SUN_SHADOW_MAX_CASCADES * 16);
  const identity = Matrix.Identity();
  let disposed = false;
  const observer = material.onBindObservable.add(() => {
    if (disposed) return;
    const effect = material.getEffect();
    if (!effect) return;
    const shadowMap = shadows.getShadowMap();
    const cascadeCount = Math.min(SUN_SHADOW_MAX_CASCADES, shadows.numCascades);
    const valid = material.getScene().shadowsEnabled
      && shadows.getLight().shadowEnabled
      && shadowMap !== null
      && cascadeCount > 0;
    effect.setFloat("sunShadowValid", valid ? 1 : 0);
    if (!valid || !shadowMap) return;

    let lastMatrix = identity;
    for (let cascade = 0; cascade < SUN_SHADOW_MAX_CASCADES; cascade += 1) {
      const matrix = cascade < cascadeCount
        ? shadows.getCascadeTransformMatrix(cascade) ?? lastMatrix
        : lastMatrix;
      matrix.copyToArray(matrices, cascade * 16);
      lastMatrix = matrix;
    }
    const layout = resolveSunShadowCascadeLayout({
      cameraMinZ: camera.minZ,
      cameraMaxZ: camera.maxZ,
      cascadeCount,
      lambda: shadows.lambda,
      minDistance: shadows.minDistance,
      maxDistance: shadows.maxDistance,
      shadowMaxZ: shadows.shadowMaxZ,
      cascadeBlendPercentage: shadows.cascadeBlendPercentage,
    });
    effect.setMatrices("sunShadowMatrices", matrices);
    effect.setMatrix("sunShadowView", camera.getViewMatrix());
    effect.setFloat4("sunShadowSplits", ...layout.splits);
    effect.setFloat4("sunShadowBlendStarts", ...layout.blendStarts);
    effect.setFloat("sunShadowCascadeCount", layout.cascadeCount);
    effect.setFloat("sunShadowDarkness", shadows.getDarkness());
    effect.setDepthStencilTexture(SUN_SHADOW_SAMPLER, shadowMap);
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      material.onBindObservable.remove(observer);
    },
  };
}
