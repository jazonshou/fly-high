import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";

/**
 * Planar-reflection RECEIVER contract and plane selection (2-10).
 *
 * The capture system that used to live here — a shared `MirrorTexture`
 * rendered through four private Babylon scene fields on a governor-managed
 * cadence — was retired by `2-10`: with the 1C-6 environment probe live on
 * both water materials and water roughness capped at 0.34, the sky cube
 * covers the reflection the mirror pass existed for, at zero extra cameras.
 *
 * What deliberately SURVIVES (Class T — preserved, not improved):
 * - The receiver WGSL and uniform/sampler contract. `planarReflectionValid`
 *   stays 0 with no capture, so `samplePlanarSceneReflection` falls through
 *   to the environment/analytic fallback; `5-12` re-points a lake capture at
 *   the same contract without touching a water shader.
 * - `selectPlanarReflectionPlane` and its enter/release hysteresis, and
 *   `acceptsInlandPlanarReflection` — RENDERING_PLAN.md is explicit that the
 *   lake-plane logic is correct and non-obvious; `5-12` rebuilds the inland
 *   capture around it.
 */

export const PLANAR_REFLECTION_SAMPLER = "planarReflection";
export const PLANAR_REFLECTION_UNIFORMS = [
  "planarReflectionViewProjection",
  "planarReflectionPlaneHeight",
  "planarReflectionStrength",
  "planarReflectionValid",
  "planarReflectionReceiverEnabled",
] as const;

/** Shared WGSL helper used by both deep-ocean and inland-water materials. */
export const PLANAR_REFLECTION_FRAGMENT_WGSL = /* wgsl */ `
var planarReflectionSampler: sampler;
var planarReflection: texture_2d<f32>;
uniform planarReflectionPlaneHeight: f32;
uniform planarReflectionStrength: f32;
uniform planarReflectionValid: f32;
uniform planarReflectionReceiverEnabled: f32;

fn samplePlanarSceneReflection(
  reflectionClip: vec4f,
  normal: vec3f,
  surfaceHeight: f32,
  atmosphereFallback: vec3f,
) -> vec3f {
  if (
    uniforms.planarReflectionValid < 0.5
    || uniforms.planarReflectionReceiverEnabled < 0.5
    || reflectionClip.w <= 0.0001
  ) {
    return atmosphereFallback;
  }
  let projected = reflectionClip.xy / reflectionClip.w;
  let distortion = vec2f(normal.x, -normal.z) * 0.0075;
  let uv = vec2f(projected.x * 0.5 + 0.5, 0.5 - projected.y * 0.5) + distortion;
  if (any(uv <= vec2f(0.001)) || any(uv >= vec2f(0.999))) {
    return atmosphereFallback;
  }
  let sceneReflection = textureSampleLevel(
    planarReflection,
    planarReflectionSampler,
    uv,
    0.0,
  );
  let edgeDistance = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  let edgeConfidence = smoothstep(0.004, 0.035, edgeDistance);
  // One shared capture can serve the ocean or one nearby lake plane. Other
  // elevations retain the analytic atmosphere/cloud Fresnel response.
  let planeDistance = abs(surfaceHeight - uniforms.planarReflectionPlaneHeight);
  let planeConfidence = 1.0 - smoothstep(3.0, 12.0, planeDistance);
  let confidence = clamp(
    sceneReflection.a * uniforms.planarReflectionStrength
      * edgeConfidence * planeConfidence,
    0.0,
    1.0,
  );
  return mix(atmosphereFallback, sceneReflection.rgb, confidence);
}
`;

export interface PlanarReflectionBinding {
  readonly texture: BaseTexture;
  readonly viewProjection: Matrix;
  readonly planeHeight: number;
  readonly strength: number;
  readonly valid: boolean;
  readonly source: "ocean" | "lake";
}

/** Water materials implement this without owning the shared capture texture. */
export interface PlanarReflectionReceiver {
  setPlanarReflection(binding: PlanarReflectionBinding | null): void;
}

export interface PlanarReflectionLake {
  readonly centerX: number;
  readonly centerZ: number;
  readonly surfaceHeight: number;
  readonly radiusMeters: number;
}

export interface PlanarReflectionObserver {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PlanarReflectionPlaneSelection {
  readonly height: number;
  readonly source: "ocean" | "lake";
  readonly lakeIndex: number | null;
}

const MINIMUM_LAKE_ANGULAR_RADIUS_RADIANS = 0.025;
const LAKE_RELEASE_DISTANCE_MULTIPLIER = 1.15;
const LAKE_RELEASE_ANGULAR_RADIUS_MULTIPLIER = 0.8;

export interface InlandPlanarReflectionReceiverInput {
  readonly source: "ocean" | "lake";
  readonly planeHeight: number;
  readonly isLakeMesh: boolean;
  readonly isCurrentRegion: boolean;
  readonly lakes: readonly Pick<PlanarReflectionLake, "surfaceHeight">[];
}

/** Prevents rivers and paging-retired lake geometry from consuming a lake capture. */
export function acceptsInlandPlanarReflection(
  input: InlandPlanarReflectionReceiverInput,
): boolean {
  return input.source === "lake"
    && input.isLakeMesh
    && input.isCurrentRegion
    && input.lakes.some(
      (lake) => Math.abs(lake.surfaceHeight - input.planeHeight) < 0.05,
    );
}

/**
 * Selects at most one horizontal plane for a shared capture. Lakes only win
 * while close enough to matter; every other water surface uses its analytic
 * sky/cloud fallback rather than sampling a geometrically incorrect plane.
 */
export function selectPlanarReflectionPlane(
  seaLevel: number,
  observer: PlanarReflectionObserver,
  lakes: readonly PlanarReflectionLake[],
  previousSelection: PlanarReflectionPlaneSelection | null = null,
  activationDistanceMeters = 900,
): PlanarReflectionPlaneSelection {
  if (!Number.isFinite(seaLevel)) throw new RangeError("Reflection sea level must be finite");
  if (![observer.x, observer.y, observer.z].every(Number.isFinite)) {
    throw new RangeError("Reflection observer must be finite");
  }
  const activationDistance = Math.max(
    0,
    Number.isFinite(activationDistanceMeters) ? activationDistanceMeters : 0,
  );
  let nearestIndex: number | null = null;
  let nearestEdgeDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < lakes.length; index += 1) {
    const lake = lakes[index];
    if (!lake || ![
      lake.centerX,
      lake.centerZ,
      lake.surfaceHeight,
      lake.radiusMeters,
    ].every(Number.isFinite)) continue;
    const centerDistance = Math.hypot(
      observer.x - lake.centerX,
      observer.z - lake.centerZ,
    );
    const radius = Math.max(0, lake.radiusMeters);
    const edgeDistance = Math.max(0, centerDistance - radius);
    const angularRadius = Math.atan2(
      radius,
      Math.hypot(centerDistance, observer.y - lake.surfaceHeight),
    );
    const retainsPreviousPlane = previousSelection?.source === "lake"
      && Math.abs(previousSelection.height - lake.surfaceHeight) < 0.05;
    const distanceLimit = activationDistance * (
      retainsPreviousPlane ? LAKE_RELEASE_DISTANCE_MULTIPLIER : 1
    );
    const angularLimit = MINIMUM_LAKE_ANGULAR_RADIUS_RADIANS * (
      retainsPreviousPlane ? LAKE_RELEASE_ANGULAR_RADIUS_MULTIPLIER : 1
    );
    if (
      edgeDistance > distanceLimit
      || angularRadius < angularLimit
      || edgeDistance >= nearestEdgeDistance
    ) continue;
    nearestIndex = index;
    nearestEdgeDistance = edgeDistance;
  }
  const nearest = nearestIndex === null ? null : lakes[nearestIndex];
  return nearest
    ? { height: nearest.surfaceHeight, source: "lake", lakeIndex: nearestIndex }
    : { height: seaLevel, source: "ocean", lakeIndex: null };
}
