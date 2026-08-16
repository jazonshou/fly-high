import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";

const MINIMUM_SUN_ELEVATION = 1e-4;

/** World-space description of the cloud transmittance map produced by the cloud pass. */
export interface CloudShadowProjection {
  readonly texture: BaseTexture;
  /** Absolute CPU-world x/z at the center of the projection. */
  readonly centerX: number;
  readonly centerZ: number;
  readonly worldSizeMeters: number;
  /** Absolute altitude of the plane on which the cloud map was generated. */
  readonly referenceAltitudeMeters: number;
  /** Normalized direction from a receiver toward the sun. */
  readonly sunDirectionX: number;
  readonly sunDirectionY: number;
  readonly sunDirectionZ: number;
  /** False until the procedural texture has completed at least one render. */
  readonly valid: boolean;
}

/** GPU-ready values after converting an absolute projection into a floating-origin space. */
export interface CloudShadowReceiverBinding {
  readonly centerLocalX: number;
  readonly centerLocalZ: number;
  readonly worldSizeMeters: number;
  readonly referenceAltitudeMeters: number;
  readonly sunDirectionX: number;
  readonly sunDirectionY: number;
  readonly sunDirectionZ: number;
  readonly strength: number;
  readonly valid: boolean;
}

export interface CloudShadowUv {
  readonly u: number;
  readonly v: number;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

/**
 * Converts the absolute shadow-map metadata to the same local x/z space used by
 * rebased render meshes. The source projection is never mutated.
 */
export function resolveCloudShadowReceiverBinding(
  projection: CloudShadowProjection,
  floatingOriginX: number,
  floatingOriginZ: number,
  strength = 1,
): CloudShadowReceiverBinding {
  assertFinite(projection.centerX, "Cloud-shadow centerX");
  assertFinite(projection.centerZ, "Cloud-shadow centerZ");
  assertFinite(projection.worldSizeMeters, "Cloud-shadow worldSizeMeters");
  assertFinite(projection.referenceAltitudeMeters, "Cloud-shadow reference altitude");
  assertFinite(projection.sunDirectionX, "Cloud-shadow sunDirectionX");
  assertFinite(projection.sunDirectionY, "Cloud-shadow sunDirectionY");
  assertFinite(projection.sunDirectionZ, "Cloud-shadow sunDirectionZ");
  assertFinite(floatingOriginX, "Cloud-shadow floatingOriginX");
  assertFinite(floatingOriginZ, "Cloud-shadow floatingOriginZ");
  assertFinite(strength, "Cloud-shadow strength");
  if (projection.worldSizeMeters <= 0) {
    throw new RangeError("Cloud-shadow worldSizeMeters must be positive");
  }
  if (strength < 0 || strength > 1) {
    throw new RangeError("Cloud-shadow strength must be in [0, 1]");
  }

  const directionLength = Math.hypot(
    projection.sunDirectionX,
    projection.sunDirectionY,
    projection.sunDirectionZ,
  );
  const hasDirection = directionLength > Number.EPSILON;
  const inverseDirectionLength = hasDirection ? 1 / directionLength : 0;
  const sunDirectionX = projection.sunDirectionX * inverseDirectionLength;
  const sunDirectionY = projection.sunDirectionY * inverseDirectionLength;
  const sunDirectionZ = projection.sunDirectionZ * inverseDirectionLength;

  return Object.freeze({
    centerLocalX: projection.centerX - floatingOriginX,
    centerLocalZ: projection.centerZ - floatingOriginZ,
    worldSizeMeters: projection.worldSizeMeters,
    referenceAltitudeMeters: projection.referenceAltitudeMeters,
    sunDirectionX,
    sunDirectionY,
    sunDirectionZ,
    strength,
    valid: projection.valid && hasDirection && sunDirectionY > MINIMUM_SUN_ELEVATION,
  });
}

/**
 * Projects an actual receiver point back onto the cloud map's reference plane
 * along the inverse sun ray. Unlike a y=0 screen-space veil, mountains, waves,
 * and elevated water therefore receive the shadow at the correct x/z offset.
 */
export function projectCloudShadowUv(
  localX: number,
  localY: number,
  localZ: number,
  binding: CloudShadowReceiverBinding,
): CloudShadowUv | null {
  assertFinite(localX, "Cloud-shadow receiver x");
  assertFinite(localY, "Cloud-shadow receiver y");
  assertFinite(localZ, "Cloud-shadow receiver z");
  if (!binding.valid) return null;

  const heightAboveReference = localY - binding.referenceAltitudeMeters;
  const inverseSunHeight = heightAboveReference / binding.sunDirectionY;
  const referenceX = localX - binding.sunDirectionX * inverseSunHeight;
  const referenceZ = localZ - binding.sunDirectionZ * inverseSunHeight;
  return Object.freeze({
    u: (referenceX - binding.centerLocalX) / binding.worldSizeMeters + 0.5,
    v: (referenceZ - binding.centerLocalZ) / binding.worldSizeMeters + 0.5,
  });
}

export function isCloudShadowUvInside(uv: CloudShadowUv): boolean {
  return uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1;
}

/** Uniform names shared by ShaderMaterial receivers and the terrain PBR plugin. */
export const CLOUD_SHADOW_RECEIVER_UNIFORMS = Object.freeze([
  "cloudShadowCenterLocal",
  "cloudShadowWorldSize",
  "cloudShadowReferenceAltitude",
  "cloudShadowSunDirection",
  "cloudShadowReceiverValid",
  "cloudShadowStrength",
] as const);

export const CLOUD_SHADOW_RECEIVER_SAMPLER = "cloudShadowSampler";

/** Function/declarations used when Babylon injects the uniforms through a material UBO. */
export const CLOUD_SHADOW_RECEIVER_FUNCTION_WGSL = /* wgsl */ `
var cloudShadowSamplerSampler: sampler;
var cloudShadowSampler: texture_2d<f32>;

fn sampleCloudShadowReceiver(localWorldPosition: vec3f) -> f32 {
  if (
    uniforms.cloudShadowReceiverValid < 0.5
    || uniforms.cloudShadowSunDirection.y <= 0.0001
  ) {
    return 1.0;
  }
  let heightAboveReference = localWorldPosition.y - uniforms.cloudShadowReferenceAltitude;
  let inverseSunHeight = heightAboveReference / uniforms.cloudShadowSunDirection.y;
  let referencePosition = localWorldPosition.xz
    - uniforms.cloudShadowSunDirection.xz * inverseSunHeight;
  let shadowUv = (referencePosition - uniforms.cloudShadowCenterLocal)
    / uniforms.cloudShadowWorldSize + vec2f(0.5);
  if (any(shadowUv < vec2f(0.0)) || any(shadowUv > vec2f(1.0))) {
    return 1.0;
  }
  let edgeDistance = min(min(shadowUv.x, shadowUv.y), min(1.0 - shadowUv.x, 1.0 - shadowUv.y));
  let edgeWeight = smoothstep(0.0, 0.025, edgeDistance);
  let transmittance = textureSampleLevel(
    cloudShadowSampler,
    cloudShadowSamplerSampler,
    shadowUv,
    0.0,
  ).r;
  return mix(1.0, clamp(transmittance, 0.0, 1.0), uniforms.cloudShadowStrength * edgeWeight);
}
`;

/** Complete declaration block for custom WGSL ShaderMaterial receivers. */
export const CLOUD_SHADOW_RECEIVER_WGSL = /* wgsl */ `
uniform cloudShadowCenterLocal: vec2f;
uniform cloudShadowWorldSize: f32;
uniform cloudShadowReferenceAltitude: f32;
uniform cloudShadowSunDirection: vec3f;
uniform cloudShadowReceiverValid: f32;
uniform cloudShadowStrength: f32;
${CLOUD_SHADOW_RECEIVER_FUNCTION_WGSL}
`;
