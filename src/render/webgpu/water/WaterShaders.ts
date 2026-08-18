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
 * The two GGX assemblies are exported separately on purpose: the ocean
 * shipped a combined D·G·denominator term with an inlined scalar
 * quasi-Fresnel, the hydrology a split distribution/geometry pair with a
 * true `fresnelSchlick(vDotH)` at the call site. They are different BRDF
 * assemblies, not one function with different constants — `2-9` replaces
 * both with the solid-angle-correct Karis lobe and this file is where that
 * replacement happens once.
 */

/** Shared constants block (PI). */
export const WATER_SHADING_CONSTANTS_WGSL = /* wgsl */ `const PI: f32 = 3.14159265359;`;

/** Schlick Fresnel — identical on both water surfaces (F0 stays at the call site). */
export const WATER_FRESNEL_SCHLICK_WGSL = /* wgsl */ `fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
}`;

/**
 * The ocean's combined GGX: D·G over the 4·nV·nL denominator with an inlined
 * scalar quasi-Fresnel. Superseded by the Karis lobe in `2-9`.
 */
export const WATER_GGX_COMBINED_SPECULAR_WGSL = /* wgsl */ `fn ggxSpecular(normal: vec3f, view: vec3f, light: vec3f, roughness: f32) -> f32 {
  let halfVector = normalize(view + light);
  let nDotH = max(dot(normal, halfVector), 0.0);
  let nDotV = max(dot(normal, view), 0.001);
  let nDotL = max(dot(normal, light), 0.001);
  let vDotH = max(dot(view, halfVector), 0.001);
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  let distribution = alpha2 / max(PI * denominator * denominator, 0.00001);
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let geometryV = nDotV / (nDotV * (1.0 - k) + k);
  let geometryL = nDotL / (nDotL * (1.0 - k) + k);
  return distribution * geometryV * geometryL / max(4.0 * nDotV * nDotL, 0.001) * (0.02 + 0.98 * pow(1.0 - vDotH, 5.0));
}`;

/**
 * The hydrology's split GGX: distribution and Smith-Schlick geometry as
 * separate functions, assembled with an explicit `fresnelSchlick(vDotH)` at
 * the call site. Superseded by the Karis lobe in `2-9`.
 */
export const WATER_GGX_SPLIT_WGSL = /* wgsl */ `fn distributionGgx(normal: vec3f, halfVector: vec3f, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let nDotH = max(dot(normal, halfVector), 0.0);
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / max(PI * denominator * denominator, 0.000001);
}

fn geometrySchlickGgx(nDotDirection: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  return nDotDirection / max(nDotDirection * (1.0 - k) + k, 0.0001);
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
  /** Specular sun-disc power (deleted by `2-9`'s solid-angle lobe). */
  readonly sunDiscExponent: number;
  /** Specular sun-disc gain (deleted by `2-9`'s solid-angle lobe). */
  readonly sunDiscGain: number;
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
 * The analytic sky reflection shared by both water surfaces. Expects
 * `uniforms.skyZenith` / `uniforms.skyHorizon` / `uniforms.cloudCoverage` /
 * `uniforms.sunDirection` / `uniforms.sunColor` in the enclosing material.
 * The `worldXZ` parameter is unused (kept for the pre-extraction call-site
 * signature; it leaves with `2-9`'s rewrite).
 */
export function waterReflectedSkyWgsl(parameters: WaterReflectedSkyParameters): string {
  return /* wgsl */ `fn reflectedSky(direction: vec3f, worldXZ: vec2f, directSunVisibility: f32) -> vec3f {
  let horizon = pow(1.0 - clamp(direction.y, 0.0, 1.0), ${toWgslFloat(parameters.horizonFalloffExponent)});
  var sky = mix(uniforms.skyZenith, uniforms.skyHorizon, horizon);
  // The former fallback invented a second, unrelated 2D cloud field. It could
  // never line up with the volumetric sky and made the surface look painted.
  // Preserve the shared atmosphere hue and use coverage only as broad overcast
  // energy until the real volumetric radiance is available as a reflection LUT.
  let overcast = smoothstep(0.18, 0.92, uniforms.cloudCoverage);
  let overcastSky = mix(${toWgslVec3(parameters.overcastZenithColor)}, ${toWgslVec3(parameters.overcastHorizonColor)}, horizon);
  sky = mix(sky, overcastSky, overcast * 0.52);
  let sun = pow(max(dot(direction, normalize(uniforms.sunDirection)), 0.0), ${toWgslFloat(parameters.sunDiscExponent)});
  return sky + uniforms.sunColor * sun * ${toWgslFloat(parameters.sunDiscGain)} * directSunVisibility
    * (1.0 - overcast * 0.88);
}`;
}
