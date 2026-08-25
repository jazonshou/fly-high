/**
 * 2-8a — the shared water shading helpers, extracted from the ocean and
 * hydrology fragment shaders so the §3.6 drift (two textual copies of
 * fresnel/GGX/reflectedSky with silently diverged constants) cannot recur.
 *
 * Owner: water. The extraction gate (assertion 41) pins the composed ocean
 * WGSL by hash in `tests/render.webgpu-water-extraction.test.ts` — the
 * blocks here must reproduce the pre-extraction text character for
 * character. Deliberate shading changes (2-8, 2-9) re-pin the hash in the
 * same commit, which is exactly the explicitness §3.6 asks for.
 *
 * 2-9 completed the unification the extraction staged: both surfaces now
 * light their sun through ONE solid-angle-correct Karis lobe
 * (`WATER_SUN_SPECULAR_WGSL`), foam is lit Lambertian with a shared Worley
 * break-up (`WATER_FOAM_WGSL`), backlit crests glow through
 * `WATER_CREST_SSS_WGSL`, and environment reflections map roughness to the
 * sky probe's mips via `WATER_ENVIRONMENT_MIP_WGSL`. The pre-2-9 GGX
 * assemblies (ocean combined lobe, hydrology split pair) are deleted.
 */

import { RawCubeTexture } from "@babylonjs/core/Materials/Textures/rawCubeTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/** Shared constants block (PI). */
export const WATER_SHADING_CONSTANTS_WGSL = /* wgsl */ `const PI: f32 = 3.14159265359;`;

/** `5-11`: one physical depth model shared by ocean, rivers, and lakes. */
export const WATER_ABSORPTION_PER_METER = Object.freeze([0.45, 0.07, 0.02] as const);
export const WATER_SHORE_FADE_METERS = 0.4;
export const WATER_AIR_INTERFACE_CRITICAL_ANGLE_DEGREES = 48.6;

/** Declarations are separate so ShaderMaterial sampler manifests can mirror them. */
export const WATER_BATHYMETRY_DECLARATIONS_WGSL = /* wgsl */ `
uniform bathymetryNearPlacement: vec4f;
uniform bathymetryFarPlacement: vec4f;
uniform bathymetrySeaLevel: f32;
var bathymetryNearSampler: sampler; var bathymetryNear: texture_2d<f32>;
var bathymetryFarSampler: sampler; var bathymetryFar: texture_2d<f32>;
`;

/**
 * `5-11`: shared Beer-Lambert, analytic bed, turbidity, shoreline, and
 * underwater-interface implementation. The two water materials supply only
 * their surface normal/reflection/foam; neither owns a second depth model.
 */
export const WATER_DEPTH_OPTICS_WGSL = /* wgsl */ `
const WATER_ABSORPTION_PER_METER = vec3f(0.45, 0.07, 0.02);
const WATER_SHORE_FADE_METERS: f32 = 0.4;
const WATER_CRITICAL_ANGLE_DEGREES: f32 = 48.6;

fn bathymetryWrappedUv(worldXZ: vec2f, placement: vec4f) -> vec2f {
  let worldTexel = worldXZ / placement.z;
  let wrapped = worldTexel - floor(worldTexel / placement.w) * placement.w;
  return (wrapped + vec2f(0.5)) / placement.w;
}

fn sampleBathymetryBedDelta(worldXZ: vec2f) -> f32 {
  let nearCenter = (uniforms.bathymetryNearPlacement.xy
    + vec2f(uniforms.bathymetryNearPlacement.w * 0.5))
    * uniforms.bathymetryNearPlacement.z;
  let nearHalfSpan = uniforms.bathymetryNearPlacement.z
    * uniforms.bathymetryNearPlacement.w * 0.48;
  let insideNear = max(
    abs(worldXZ.x - nearCenter.x),
    abs(worldXZ.y - nearCenter.y),
  ) <= nearHalfSpan;
  if (insideNear) {
    return textureSampleLevel(
      bathymetryNear,
      bathymetryNearSampler,
      bathymetryWrappedUv(worldXZ, uniforms.bathymetryNearPlacement),
      0.0,
    ).r;
  }
  return textureSampleLevel(
    bathymetryFar,
    bathymetryFarSampler,
    bathymetryWrappedUv(worldXZ, uniforms.bathymetryFarPlacement),
    0.0,
  ).r;
}

fn waterDepthFromBathymetry(surfaceElevation: f32, worldXZ: vec2f) -> f32 {
  let bedElevation = uniforms.bathymetrySeaLevel + sampleBathymetryBedDelta(worldXZ);
  return max(surfaceElevation - bedElevation, 0.0);
}

fn analyticWaterBedAlbedo(worldXZ: vec2f, bedElevation: f32) -> vec3f {
  let mineral = 0.5 + 0.5 * sin(dot(worldXZ, vec2f(0.021, 0.017)) + bedElevation * 0.08);
  let sand = vec3f(0.31, 0.285, 0.205);
  let rock = vec3f(0.075, 0.105, 0.095);
  let deepSilt = vec3f(0.028, 0.055, 0.052);
  let substrate = mix(rock, sand, mineral * 0.32);
  return mix(substrate, deepSilt, smoothstep(8.0, 45.0, -bedElevation));
}

fn waterVolumeRadiance(
  worldXZ: vec2f,
  surfaceElevation: f32,
  depth: f32,
  normal: vec3f,
  view: vec3f,
  cameraBelow: bool,
  sunVisibility: f32,
) -> vec3f {
  let bedElevation = surfaceElevation - depth;
  var bedXZ = worldXZ;
  if (!cameraBelow && depth > 0.0) {
    // Trace the view ray through the air-to-water interface before evaluating
    // the stable analytic bed. Without this offset the substrate is painted
    // directly below the fragment and appears glued to the water surface as
    // the camera moves. WGSL refract returns the transmitted direction travelling
    // from the interface toward the bed (eta = n_air / n_water).
    let transmittedDirection = refract(-view, normal, 1.0 / 1.333);
    let verticalTravel = max(-transmittedDirection.y, 0.02);
    bedXZ = worldXZ + transmittedDirection.xz * (depth / verticalTravel);
  }
  let bed = analyticWaterBedAlbedo(bedXZ, bedElevation);
  let transmittance = exp(-WATER_ABSORPTION_PER_METER * depth);
  // One-scatter turbidity: energy removed from the direct bed path is
  // returned directionally as the familiar shallow turquoise glow.
  let turbidity = vec3f(0.018, 0.115, 0.105)
    * (vec3f(1.0) - transmittance)
    * (0.38 + 0.62 * sunVisibility);
  return bed * transmittance + turbidity;
}

fn waterShorelineAlpha(depth: f32) -> f32 {
  return smoothstep(0.0, WATER_SHORE_FADE_METERS, depth);
}

fn waterInterfaceFresnel(normal: vec3f, view: vec3f, cameraBelow: bool) -> vec3f {
  let f0 = vec3f(0.0204);
  if (!cameraBelow) {
    return fresnelSchlick(max(dot(normal, view), 0.0), f0);
  }
  let incidentCos = clamp(dot(-normal, view), 0.0, 1.0);
  let incidentSin2 = max(1.0 - incidentCos * incidentCos, 0.0);
  let transmittedSin2 = 1.333 * 1.333 * incidentSin2;
  // 48.6 degrees: water-to-air critical angle. Above it there is no
  // transmitted ray and the underside is a total internal reflection.
  if (transmittedSin2 >= 1.0) { return vec3f(1.0); }
  let transmittedCos = sqrt(max(1.0 - transmittedSin2, 0.0));
  return fresnelSchlick(transmittedCos, f0);
}

fn applyUnderwaterBeerLambert(color: vec3f, pathMeters: f32, sunVisibility: f32) -> vec3f {
  let path = clamp(pathMeters, 0.0, 80.0);
  let transmittance = exp(-WATER_ABSORPTION_PER_METER * path);
  let inScatter = vec3f(0.012, 0.085, 0.09)
    * (vec3f(1.0) - transmittance)
    * (0.3 + 0.7 * sunVisibility);
  return color * transmittance + inScatter;
}
`;

const FALLBACK_ENVIRONMENT_CUBES = new WeakMap<Scene, RawCubeTexture>();
const FALLBACK_PLANAR_TEXTURES = new WeakMap<Scene, RawTexture>();

/**
 * 2-10: with the capture system retired, nothing binds the planar-reflection
 * sampler the receiver WGSL still declares — an unbound sampler keeps a
 * WebGPU material un-ready forever. A 1×1 transparent texel keeps the
 * contract alive at zero confidence (`sceneReflection.a = 0` falls through
 * to the environment/analytic sky) until `5-12` re-points a lake capture.
 */
export function fallbackWaterPlanarTexture(scene: Scene): RawTexture {
  const existing = FALLBACK_PLANAR_TEXTURES.get(scene);
  if (existing) return existing;
  const texture = RawTexture.CreateRGBATexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  texture.name = "water-planar-fallback";
  FALLBACK_PLANAR_TEXTURES.set(scene, texture);
  scene.onDisposeObservable.addOnce(() => {
    FALLBACK_PLANAR_TEXTURES.get(scene)?.dispose();
    FALLBACK_PLANAR_TEXTURES.delete(scene);
  });
  return texture;
}

/**
 * 2-9: a 1×1 mid-grey cube bound wherever a water material declares the
 * environment sampler before the sky probe publishes (WebGPU materials with
 * an unbound declared sampler never become ready). `environmentValid` stays
 * 0 while this is bound, so the analytic sky fallback is what renders.
 * Returns null under NullEngine (no raw-cube support; those tests never
 * compile the material) — the nullable-pipeline pattern the clouds use.
 */
export function fallbackWaterEnvironmentCube(scene: Scene): RawCubeTexture | null {
  const engine = scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
  if (!engine.isWebGPU && !engine._gl) return null;
  const existing = FALLBACK_ENVIRONMENT_CUBES.get(scene);
  if (existing) return existing;
  const face = new Uint8Array([96, 108, 122, 255]);
  const cube = new RawCubeTexture(
    scene,
    [face, face, face, face, face, face],
    1,
    undefined,
    undefined,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  cube.name = "water-environment-fallback";
  FALLBACK_ENVIRONMENT_CUBES.set(scene, cube);
  scene.onDisposeObservable.addOnce(() => {
    FALLBACK_ENVIRONMENT_CUBES.get(scene)?.dispose();
    FALLBACK_ENVIRONMENT_CUBES.delete(scene);
  });
  return cube;
}

/** Schlick Fresnel — identical on both water surfaces (F0 stays at the call site). */
export const WATER_FRESNEL_SCHLICK_WGSL = /* wgsl */ `fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
}`;

/**
 * Fix-pack W1/W2: the near-field capillary band and the sub-grid spectrum
 * tail, shared by every water surface.
 *
 * Below the finest cascade's Nyquist (1.0 m at tier 1) the rendered spectrum
 * simply ended: near pixels magnified 0.5 m slope texels into playdough, and
 * because the moment texture holds exactly `s²` at mip 0 the Toksvig variance
 * was identically ZERO up close — roughness collapsed to the floor and the
 * probe reflected at mip 0. Glass. This block supplies (a) two wind-advected
 * procedural ripple octaves (~0.42 m and ~0.16 m), world-locked so descending
 * toward the surface produces real optical flow — the altitude cue — and
 * (b) the unresolved mean-square slope of everything the pixel cannot carry,
 * for the caller to fold into GGX roughness exactly like a faded cascade.
 * Octaves fade on their own pixel-footprint Nyquist and hand their energy to
 * the roughness term as they go, the 2-8 discipline.
 *
 * Returns (slope.x, slope.z, unresolvedMeanSquareSlope), slopes in the
 * `normalize(vec3f(slope.x, 1, slope.y))` convention both call sites use.
 */
export const WATER_CAPILLARY_DETAIL_WGSL = /* wgsl */ `fn waterDetailHash(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

fn waterDetailGrad(point: vec2f) -> vec3f {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  let slope = 6.0 * local * (vec2f(1.0) - local);
  let a = waterDetailHash(cell);
  let b = waterDetailHash(cell + vec2f(1.0, 0.0));
  let c = waterDetailHash(cell + vec2f(0.0, 1.0));
  let d = waterDetailHash(cell + vec2f(1.0));
  return vec3f(
    mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y),
    mix(b - a, d - c, blend.y) * slope.x,
    mix(c - a, d - b, blend.x) * slope.y,
  );
}

fn waterCapillaryDetail(worldXZ: vec2f, windVelocity: vec2f, time: f32) -> vec3f {
  let footprint = max(length(dpdx(worldXZ)), length(dpdy(worldXZ)));
  // Floor 0.1, not higher: a calm lake should stay glassier than a windy sea
  // — the unresolved-tail fold scales with this.
  let wind01 = clamp(length(windVelocity) * 0.09, 0.1, 1.0);
  // Wrapped so the advected noise coordinate cannot grow into f32
  // quantization over a long session; the once-per-~68-min phase snap is a
  // single-frame ripple reseed, invisible against wave motion.
  let drift = windVelocity * (time - floor(time / 4096.0) * 4096.0);
  var slope = vec2f(0.0);
  // The tail below the finest octave here is NEVER resolved at any range.
  var unresolved = 0.014 * wind01;
  // Drift factors are far below 1: capillary PHASE speed is ~0.3-0.5 m/s
  // regardless of the wind that raised the ripples, and advecting the fine
  // lattice at full wind moved it more than half a noise cell per 60 fps
  // frame above ~5 m/s of wind — temporal aliasing shimmer, not motion.
  let fadeA = 1.0 - smoothstep(0.05, 0.21, footprint);
  if (fadeA > 0.001) {
    let gradA = waterDetailGrad((worldXZ - drift * 0.22) * 2.4);
    slope += vec2f(gradA.y, gradA.z) * 0.14 * wind01 * fadeA;
  }
  unresolved += 0.020 * wind01 * (1.0 - fadeA * fadeA);
  let fadeB = 1.0 - smoothstep(0.02, 0.08, footprint);
  if (fadeB > 0.001) {
    let rotated = mat2x2f(0.848, 0.53, -0.53, 0.848) * (worldXZ - drift * 0.11);
    let gradB = waterDetailGrad(rotated * 6.1 + vec2f(13.7, 41.3));
    slope += vec2f(gradB.y, gradB.z) * 0.10 * wind01 * fadeB;
  }
  unresolved += 0.016 * wind01 * (1.0 - fadeB * fadeB);
  return vec3f(slope, unresolved);
}`;

/**
 * 2-9: the ONE sun specular lobe for every water surface — solid-angle
 * correct via Karis's representative-point method. The sun is a disc of
 * angular radius θ, not a delta light: the GGX alpha widens by θ/2 and the
 * peak renormalises by (α/α′)², which is what keeps the glitter path's
 * total energy right as roughness varies. This deleted `pow(·, 3200)·16`,
 * `pow(·, 1800)·11`, `×2.6` and `×nDotL·4.0` — four magic constants
 * replaced by the sun's physical 0.004675 rad radius (1C-1).
 *
 * Returns BRDF × nDotL; the caller multiplies sun radiance (`sunColor`,
 * illuminance-normalised) and `directSunVisibility`.
 */
export const WATER_SUN_SPECULAR_WGSL = /* wgsl */ `fn sunSpecular(normal: vec3f, view: vec3f, light: vec3f, roughness: f32, sunAngularRadius: f32, f0: vec3f) -> vec3f {
  let halfVector = normalize(view + light);
  let nDotH = max(dot(normal, halfVector), 0.0);
  let nDotV = max(dot(normal, view), 0.001);
  let nDotL = max(dot(normal, light), 0.001);
  let vDotH = max(dot(view, halfVector), 0.001);
  let alpha = roughness * roughness;
  let alphaPrime = clamp(alpha + sunAngularRadius * 0.5, alpha, 1.0);
  let energy = (alpha / alphaPrime) * (alpha / alphaPrime);
  let alphaPrime2 = alphaPrime * alphaPrime;
  let denominator = nDotH * nDotH * (alphaPrime2 - 1.0) + 1.0;
  let distribution = alphaPrime2 / max(PI * denominator * denominator, 0.00001);
  let k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  let geometryV = nDotV / (nDotV * (1.0 - k) + k);
  let geometryL = nDotL / (nDotL * (1.0 - k) + k);
  let fresnel = fresnelSchlick(vDotH, f0);
  return distribution * energy * geometryV * geometryL * fresnel
    / max(4.0 * nDotV, 0.001);
}`;

/**
 * 2-9: lit foam. Foam is a Lambertian scatterer, not an unlit paint layer —
 * it responds to the sun and the sky like everything else. The Worley
 * break-up mask (advected by the caller) keeps sheets of foam from reading
 * as flat decals. Albedo stays a call-site value per surface.
 */
export const WATER_FOAM_WGSL = /* wgsl */ `fn foamCellHash(cell: vec2i) -> vec2f {
  let hashed = vec2u(cell) * vec2u(1664525u, 22695477u) + vec2u(1013904223u, 1u);
  let mixed = (hashed.x ^ (hashed.y << 8u)) * 2654435761u;
  return vec2f(
    f32(mixed & 65535u) / 65535.0,
    f32((mixed >> 16u) & 65535u) / 65535.0,
  );
}

fn foamWorley(position: vec2f) -> f32 {
  let base = vec2i(floor(position));
  var nearest = 8.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let cell = base + vec2i(x, y);
      let feature = vec2f(cell) + foamCellHash(cell);
      let delta = feature - position;
      nearest = min(nearest, dot(delta, delta));
    }
  }
  return clamp(sqrt(nearest), 0.0, 1.0);
}

fn foamBreakup(worldXZ: vec2f, advection: vec2f) -> f32 {
  let coarse = foamWorley((worldXZ - advection) * 0.21);
  let fine = foamWorley((worldXZ - advection * 1.35) * 0.83 + vec2f(37.0, 11.0));
  return smoothstep(0.12, 0.66, coarse * 0.62 + fine * 0.38);
}

fn litFoamColor(albedo: vec3f, normal: vec3f, light: vec3f, sunColor: vec3f, skyZenith: vec3f, skyHorizon: vec3f, sunVisibility: f32) -> vec3f {
  let nDotL = max(dot(normal, light), 0.0);
  let skyAmbient = (skyZenith + skyHorizon) * 0.5;
  return albedo * (skyAmbient * 0.55 + sunColor * nDotL * sunVisibility);
}`;

/**
 * 2-9: wave-crest subsurface scattering — backlit crests transmit sunlight
 * as a teal glow. Driven by the summed displacement height the vertex shader
 * already computes; `intensity` is one of Gate 2B's two declared tuning
 * knobs and lives at the call site.
 */
export const WATER_CREST_SSS_WGSL = /* wgsl */ `fn crestSubsurface(crestHeight: f32, view: vec3f, light: vec3f, sunColor: vec3f, sunVisibility: f32, intensity: f32) -> vec3f {
  let crest = max(crestHeight, 0.0);
  let towardSun = pow(max(dot(view, -light), 0.0), 4.0);
  // view is SURFACE-TO-CAMERA: steep look-down views (view.y -> 1) see no
  // transmission, grazing and below-crest look-up views (view.y <= 0) see it
  // fully — the backlit-crest hero shot. (The review caught the mirrored
  // form, which was inert aloft and dimmed exactly that shot.)
  let grazing = 1.0 - max(view.y, 0.0);
  return vec3f(0.06, 0.50, 0.42) * sunColor
    * (crest * towardSun * grazing * (0.2 + 0.8 * sunVisibility) * intensity);
}`;

/**
 * 2-9: environment-cube LOD from water roughness. Calibrated so the
 * roughness floor (0.075) lands at mip 0 and the cap (0.34) at mip 2 —
 * water roughness never exceeds ~0.34, so the probe's box mip chain
 * suffices and no GGX prefilter convolution is needed.
 */
export const WATER_ENVIRONMENT_MIP_WGSL = /* wgsl */ `fn environmentRoughnessToMip(roughness: f32) -> f32 {
  return clamp((roughness - 0.075) * (2.0 / 0.265), 0.0, 2.0);
}`;

/**
 * The constants on which the two water surfaces' analytic sky reflections
 * genuinely diverge. Each call site owns a named value with a comment — the
 * difference is deliberate and visible, not two literals that drifted.
 */
export interface WaterReflectedSkyParameters {
  /** Exponent shaping the zenith→horizon blend (higher = tighter horizon band). */
  readonly horizonFalloffExponent: number;
  /** Overcast replacement palette at the zenith. */
  readonly overcastZenithColor: readonly [number, number, number];
  /** Overcast replacement palette at the horizon. */
  readonly overcastHorizonColor: readonly [number, number, number];
}

/** Formats a number as a WGSL f32 literal (integers gain a trailing `.0`). */
function toWgslFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`WGSL float literal must be finite, got ${value}`);
  }
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

function toWgslVec3(value: readonly [number, number, number]): string {
  return `vec3f(${value.map(toWgslFloat).join(", ")})`;
}

/**
 * The analytic sky reflection shared by both water surfaces — the FALLBACK
 * when the environment probe is not yet valid. Expects `uniforms.skyZenith` /
 * `uniforms.skyHorizon` / `uniforms.cloudCoverage` in the enclosing material.
 * 2-9 deleted the fake specular sun disc: the sun's reflection now comes
 * solely from the physical `sunSpecular` lobe, never painted into the sky.
 */
export function waterReflectedSkyWgsl(parameters: WaterReflectedSkyParameters): string {
  return /* wgsl */ `fn reflectedSky(direction: vec3f) -> vec3f {
  let horizon = pow(1.0 - clamp(direction.y, 0.0, 1.0), ${toWgslFloat(parameters.horizonFalloffExponent)});
  var sky = mix(uniforms.skyZenith, uniforms.skyHorizon, horizon);
  // The former fallback invented a second, unrelated 2D cloud field. It could
  // never line up with the volumetric sky and made the surface look painted.
  // Preserve the shared atmosphere hue and use coverage only as broad overcast
  // energy until the real volumetric radiance is available as a reflection LUT.
  let overcast = smoothstep(0.18, 0.92, uniforms.cloudCoverage);
  let overcastSky = mix(${toWgslVec3(parameters.overcastZenithColor)}, ${toWgslVec3(parameters.overcastHorizonColor)}, horizon);
  return mix(sky, overcastSky, overcast * 0.52);
}`;
}
