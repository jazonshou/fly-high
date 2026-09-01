import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { SharedReceiverRegistry } from "@/src/render/webgpu/core/SharedReceiverRegistry";
import type { EnvironmentState } from "@/src/render/webgpu/nature/EnvironmentState";
import {
  MIE_SCALE_HEIGHT_METERS,
  OZONE_CENTER_METERS,
  OZONE_HALF_WIDTH_METERS,
  RAYLEIGH_SCALE_HEIGHT_METERS,
  evaluateTransmittance,
} from "./AtmosphereLuts";

// Deviation from the plan's "~60 ALU + 2 LUT fetches", recorded: the sun
// transmittance rides as a per-frame uniform evaluated at the camera's
// altitude by the shared CPU model, instead of a per-fragment LUT fetch.
// One fewer sampler in every consumer, exact TS/WGSL agreement, and the
// error (sun transmittance varying along the path) is second-order for the
// path lengths a 45 km far plane allows.

/**
 * The aerial-perspective include (1C-4) — the single definition of haze.
 *
 * INVARIANT THIS FILE OWNS: one closed-form atmospheric integral serves every
 * consumer — terrain (via the material plugin and registry), ocean, rivers
 * and lakes, vegetation, wildlife, aircraft, airport, and the cloud
 * composite. Nobody re-derives it; the sky (1C-5) evaluates the same
 * functions, so haze and sky agree by construction, not by tuning.
 *
 * The integral: for a ray from camera altitude h₀ to fragment altitude h₁
 * over distance d, the optical depth of an exponential species is exactly
 * τ = σ·H/s·(exp(−h₀/H) − exp(−h₁/H)) with s = (h₁−h₀)/d, limit d·exp(−h₀/H)
 * as s → 0; ozone integrates its tent profile in closed form. In-scatter is
 * the single-scatter solution with sun transmittance frozen at the path
 * midpoint, plus the isotropic multiple-scattering ambient — the same
 * Rayleigh and Henyey–Greenstein phases the sky uses.
 *
 * Analytic, not a froxel volume: haze must serve three cameras (main, planar
 * reflection, IBL faces), 32 slices over 45 km are unusable, and Apple
 * Silicon has abundant ALU and constrained bandwidth.
 *
 * TURBIDITY LIVES HERE, expressed once (1C-1's note): weather humidity
 * scales the Mie coefficients. Deviation from the plan's physical-constants
 * claim, recorded: with textbook coefficients the 45 km transmittance is
 * ~44% — real mountains at 45 km are visible — which fails the plan's own
 * ≥95%-opacity exit criterion and the pre-migration fade the audit called
 * correct (saturated by 11.8 km). The game's look *requires* turbid Mie;
 * `mieTurbidityMultiplier` (≈12.7× at clear, more when humid) is that choice
 * made explicit and testable rather than smuggled into the constants —
 * clear-weather luminance transmittance at 45 km is ≈4.6% (τ_green ≈ 3.1).
 */

export interface AerialPerspectiveVec3 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface AerialPerspectiveCoefficients {
  readonly rayleighScattering: [number, number, number];
  readonly mieScattering: [number, number, number];
  readonly mieExtinction: [number, number, number];
  readonly ozoneAbsorption: [number, number, number];
  readonly mieAnisotropy: number;
}

/**
 * Weather turbidity: the one place humidity becomes optical density.
 * Calibrated so clear weather (humidity 0.45, multiplier 12.7) reaches
 * luminance opacity ≥ 95% at the 45 km far plane — the plan's exit
 * criterion, and the point where culling terrain becomes invisible.
 */
export function mieTurbidityMultiplier(relativeHumidity: number): number {
  return 1 + Math.min(Math.max(relativeHumidity, 0), 1) * 26;
}

export function aerialPerspectiveCoefficients(
  state: EnvironmentState,
): AerialPerspectiveCoefficients {
  const turbidity = mieTurbidityMultiplier(state.weather.relativeHumidity);
  const atmosphere = state.atmosphere;
  return {
    rayleighScattering: [
      atmosphere.rayleighScatteringPerMeter[0]!,
      atmosphere.rayleighScatteringPerMeter[1]!,
      atmosphere.rayleighScatteringPerMeter[2]!,
    ],
    mieScattering: [
      atmosphere.mieScatteringPerMeter[0]! * turbidity,
      atmosphere.mieScatteringPerMeter[1]! * turbidity,
      atmosphere.mieScatteringPerMeter[2]! * turbidity,
    ],
    mieExtinction: [
      atmosphere.mieExtinctionPerMeter[0]! * turbidity,
      atmosphere.mieExtinctionPerMeter[1]! * turbidity,
      atmosphere.mieExtinctionPerMeter[2]! * turbidity,
    ],
    ozoneAbsorption: [
      atmosphere.absorptionExtinctionPerMeter[0]!,
      atmosphere.absorptionExtinctionPerMeter[1]!,
      atmosphere.absorptionExtinctionPerMeter[2]!,
    ],
    mieAnisotropy: atmosphere.miePhaseG,
  };
}

/** Geometric path integral of an exponential density along a straight ray. */
export function exponentialPathIntegral(
  fromAltitudeMeters: number,
  toAltitudeMeters: number,
  distanceMeters: number,
  scaleHeightMeters: number,
): number {
  const h0 = Math.max(fromAltitudeMeters, 0);
  const h1 = Math.max(toAltitudeMeters, 0);
  const dh = h1 - h0;
  if (Math.abs(dh) < 1) {
    return distanceMeters * Math.exp(-h0 / scaleHeightMeters);
  }
  const slope = dh / distanceMeters;
  return (scaleHeightMeters / slope)
    * (Math.exp(-h0 / scaleHeightMeters) - Math.exp(-h1 / scaleHeightMeters));
}

/** ∫₀^h of the ozone tent density, closed form. */
export function ozoneTentIntegral(altitudeMeters: number): number {
  const center = OZONE_CENTER_METERS;
  const halfWidth = OZONE_HALF_WIDTH_METERS;
  const h = Math.min(Math.max(altitudeMeters, 0), center + halfWidth);
  const lower = center - halfWidth;
  if (h <= lower) return 0;
  if (h <= center) {
    const x = h - lower;
    return (x * x) / (2 * halfWidth);
  }
  const x = center + halfWidth - h;
  return halfWidth - (x * x) / (2 * halfWidth);
}

export function ozonePathIntegral(
  fromAltitudeMeters: number,
  toAltitudeMeters: number,
  distanceMeters: number,
): number {
  const h0 = Math.max(fromAltitudeMeters, 0);
  const h1 = Math.max(toAltitudeMeters, 0);
  const dh = h1 - h0;
  if (Math.abs(dh) < 1) {
    const density = Math.max(0, 1 - Math.abs(h0 - OZONE_CENTER_METERS) / OZONE_HALF_WIDTH_METERS);
    return distanceMeters * density;
  }
  return (distanceMeters / Math.abs(dh))
    * Math.abs(ozoneTentIntegral(h1) - ozoneTentIntegral(h0));
}

export function rayleighPhase(viewDotSun: number): number {
  return (3 / (16 * Math.PI)) * (1 + viewDotSun * viewDotSun);
}

export function henyeyGreensteinPhase(viewDotSun: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * viewDotSun, 0.001), 1.5));
}

export interface AerialPerspectiveSample {
  readonly transmittance: [number, number, number];
  readonly inScatter: [number, number, number];
}

/**
 * The TS mirror of the WGSL — same closed forms, same approximations. Used
 * by the IBL bake, exposure reasoning, and the CI agreement tests.
 * `sunRadiance` is the scene-scale sun term (colour × normalized
 * illuminance × the shared radiance scale); `ambient` the multiple-
 * scattering floor.
 */
export function evaluateAerialPerspective(
  coefficients: AerialPerspectiveCoefficients,
  fromAltitudeMeters: number,
  toAltitudeMeters: number,
  distanceMeters: number,
  viewDotSun: number,
  sunRadiance: [number, number, number],
  ambient: [number, number, number],
  sunTransmittance: [number, number, number],
): AerialPerspectiveSample {
  if (distanceMeters <= 0) {
    return { transmittance: [1, 1, 1], inScatter: [0, 0, 0] };
  }
  const rayleighPath = exponentialPathIntegral(
    fromAltitudeMeters,
    toAltitudeMeters,
    distanceMeters,
    RAYLEIGH_SCALE_HEIGHT_METERS,
  );
  const miePath = exponentialPathIntegral(
    fromAltitudeMeters,
    toAltitudeMeters,
    distanceMeters,
    MIE_SCALE_HEIGHT_METERS,
  );
  const ozonePath = ozonePathIntegral(fromAltitudeMeters, toAltitudeMeters, distanceMeters);

  const phaseR = rayleighPhase(viewDotSun);
  const phaseM = henyeyGreensteinPhase(viewDotSun, coefficients.mieAnisotropy);

  const transmittance: [number, number, number] = [0, 0, 0];
  const inScatter: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const tauRayleigh = coefficients.rayleighScattering[channel]! * rayleighPath;
    const tauMieScatter = coefficients.mieScattering[channel]! * miePath;
    const tauMieExtinction = coefficients.mieExtinction[channel]! * miePath;
    const tauOzone = coefficients.ozoneAbsorption[channel]! * ozonePath;
    const tauTotal = tauRayleigh + tauMieExtinction + tauOzone;
    const t = Math.exp(-tauTotal);
    transmittance[channel] = t;
    const scatterWeight =
      (phaseR * tauRayleigh + phaseM * tauMieScatter) / Math.max(tauTotal, 1e-6);
    inScatter[channel] =
      (sunRadiance[channel]! * sunTransmittance[channel]! * scatterWeight
        + ambient[channel]!)
      * (1 - t);
  }
  return { transmittance, inScatter };
}

/** Top of the useful atmosphere for the sky integral (both species ~0 past it). */
export const AERIAL_SKY_SHELL_METERS = 60_000;

/**
 * The sky, as the same integral (1C-5) — the TS mirror of WGSL skyRadiance.
 * Used by the IBL bake (1C-6) and the sky/haze agreement tests.
 */
export function evaluateSkyRadiance(
  binding: AerialPerspectiveBinding,
  direction: [number, number, number],
): [number, number, number] {
  const up = Math.max(direction[1], 0.0025);
  const cameraAltitude = Math.min(
    Math.max(binding.cameraAltitudeMeters, 0),
    AERIAL_SKY_SHELL_METERS - 1,
  );
  const distanceToShell = (AERIAL_SKY_SHELL_METERS - cameraAltitude) / up;
  const mu = direction[0] * binding.sunDirection[0]
    + direction[1] * binding.sunDirection[1]
    + direction[2] * binding.sunDirection[2];
  return evaluateAerialPerspective(
    binding.coefficients,
    binding.cameraAltitudeMeters,
    AERIAL_SKY_SHELL_METERS,
    distanceToShell,
    mu,
    binding.sunRadiance,
    binding.ambient,
    binding.sunTransmittance,
  ).inScatter;
}

/**
 * The shared WGSL — uniform declarations plus the functions, matching the
 * mirror line for line. Consumers (ShaderMaterial fragments and the PBR
 * plugin UBO alike) declare these exact names; nothing re-derives haze.
 */
export const AERIAL_PERSPECTIVE_WGSL = /* wgsl */ `
uniform aerialCameraAltitude: f32;
uniform aerialSunDirection: vec3f;
uniform aerialRayleigh: vec3f;
uniform aerialMieScatter: vec3f;
uniform aerialMieExtinction: vec3f;
uniform aerialOzone: vec3f;
uniform aerialSunRadiance: vec3f;
uniform aerialAmbient: vec3f;
uniform aerialSunTransmittance: vec3f;
uniform aerialParams: vec4f; // x rayleighH, y mieH, z mieAnisotropy, w strength

const AERIAL_PI: f32 = 3.14159265359;
const AERIAL_OZONE_CENTER: f32 = 25000.0;
const AERIAL_OZONE_HALF_WIDTH: f32 = 15000.0;

fn aerialExponentialPathIntegral(h0in: f32, h1in: f32, d: f32, scaleHeight: f32) -> f32 {
  let h0 = max(h0in, 0.0);
  let h1 = max(h1in, 0.0);
  let dh = h1 - h0;
  if (abs(dh) < 1.0) {
    return d * exp(-h0 / scaleHeight);
  }
  let slope = dh / d;
  return (scaleHeight / slope) * (exp(-h0 / scaleHeight) - exp(-h1 / scaleHeight));
}

fn aerialOzoneTentIntegral(altitude: f32) -> f32 {
  let h = clamp(altitude, 0.0, AERIAL_OZONE_CENTER + AERIAL_OZONE_HALF_WIDTH);
  let lower = AERIAL_OZONE_CENTER - AERIAL_OZONE_HALF_WIDTH;
  if (h <= lower) { return 0.0; }
  if (h <= AERIAL_OZONE_CENTER) {
    let x = h - lower;
    return (x * x) / (2.0 * AERIAL_OZONE_HALF_WIDTH);
  }
  let x = AERIAL_OZONE_CENTER + AERIAL_OZONE_HALF_WIDTH - h;
  return AERIAL_OZONE_HALF_WIDTH - (x * x) / (2.0 * AERIAL_OZONE_HALF_WIDTH);
}

fn aerialOzonePathIntegral(h0in: f32, h1in: f32, d: f32) -> f32 {
  let h0 = max(h0in, 0.0);
  let h1 = max(h1in, 0.0);
  let dh = h1 - h0;
  if (abs(dh) < 1.0) {
    let density = max(0.0, 1.0 - abs(h0 - AERIAL_OZONE_CENTER) / AERIAL_OZONE_HALF_WIDTH);
    return d * density;
  }
  return (d / abs(dh)) * abs(aerialOzoneTentIntegral(h1) - aerialOzoneTentIntegral(h0));
}

fn aerialRayleighPhase(mu: f32) -> f32 {
  return (3.0 / (16.0 * AERIAL_PI)) * (1.0 + mu * mu);
}

fn aerialMiePhase(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * AERIAL_PI * pow(max(1.0 + g2 - 2.0 * g * mu, 0.001), 1.5));
}

struct AerialPerspectiveResult {
  transmittance: vec3f,
  inScatter: vec3f,
};

fn aerialPerspective(fragmentAltitude: f32, distanceMeters: f32, viewDotSun: f32) -> AerialPerspectiveResult {
  var result: AerialPerspectiveResult;
  if (distanceMeters <= 0.0 || uniforms.aerialParams.w <= 0.0) {
    result.transmittance = vec3f(1.0);
    result.inScatter = vec3f(0.0);
    return result;
  }
  let h0 = uniforms.aerialCameraAltitude;
  let h1 = fragmentAltitude;
  let rayleighPath = aerialExponentialPathIntegral(h0, h1, distanceMeters, uniforms.aerialParams.x);
  let miePath = aerialExponentialPathIntegral(h0, h1, distanceMeters, uniforms.aerialParams.y);
  let ozonePath = aerialOzonePathIntegral(h0, h1, distanceMeters);

  let phaseR = aerialRayleighPhase(viewDotSun);
  let phaseM = aerialMiePhase(viewDotSun, uniforms.aerialParams.z);

  let tauRayleigh = uniforms.aerialRayleigh * rayleighPath;
  let tauMieScatter = uniforms.aerialMieScatter * miePath;
  let tauMieExtinction = uniforms.aerialMieExtinction * miePath;
  let tauOzone = uniforms.aerialOzone * ozonePath;
  let tauTotal = tauRayleigh + tauMieExtinction + tauOzone;
  let transmittance = exp(-tauTotal);
  let scatterWeight = (phaseR * tauRayleigh + phaseM * tauMieScatter)
    / max(tauTotal, vec3f(0.000001));
  result.transmittance = transmittance;
  result.inScatter = (uniforms.aerialSunRadiance * uniforms.aerialSunTransmittance * scatterWeight
    + uniforms.aerialAmbient) * (vec3f(1.0) - transmittance);
  return result;
}

fn applyAerialPerspective(color: vec3f, fragmentAltitude: f32, distanceMeters: f32, viewDirection: vec3f) -> vec3f {
  let mu = dot(viewDirection, uniforms.aerialSunDirection);
  let aerial = aerialPerspective(fragmentAltitude, distanceMeters, mu);
  return color * aerial.transmittance + aerial.inScatter;
}

const AERIAL_SKY_SHELL: f32 = 60000.0;

fn skyRadiance(direction: vec3f) -> vec3f {
  // 1C-5: the sky IS this same integral, run out to the top of the useful
  // atmosphere (both species are negligible past 60 km). Plane-parallel:
  // below-horizon rays clamp to the horizon path, so the sky sphere's lower
  // half shows the haze limit — terrain and ocean draw over it, and where
  // they end the sky already matches their fade by construction.
  let up = max(direction.y, 0.0025);
  let cameraAltitude = clamp(uniforms.aerialCameraAltitude, 0.0, AERIAL_SKY_SHELL - 1.0);
  let distanceToShell = (AERIAL_SKY_SHELL - cameraAltitude) / up;
  let aerial = aerialPerspective(
    AERIAL_SKY_SHELL,
    distanceToShell,
    dot(direction, uniforms.aerialSunDirection),
  );
  return aerial.inScatter;
}
`;

/** Scene-scale factor turning normalized sun illuminance into haze radiance. */
export const AERIAL_SUN_RADIANCE_SCALE = 1.15;
/**
 * Ambient in-scatter as a fraction of the sky's horizon radiance. At full
 * optical depth the haze must fade INTO the horizon sky, not to a dark
 * slate — single scattering alone leaves the horizon several times too dim
 * (real horizon brightness is mostly multiple scattering), so the ambient
 * term carries the sky's own horizon colour at just under full strength;
 * the directional single-scatter sun term rides on top.
 */
export const AERIAL_AMBIENT_SCALE = 0.9;

export const AERIAL_PERSPECTIVE_UNIFORMS: readonly string[] = Object.freeze([
  "aerialCameraAltitude",
  "aerialSunDirection",
  "aerialRayleigh",
  "aerialMieScatter",
  "aerialMieExtinction",
  "aerialOzone",
  "aerialSunRadiance",
  "aerialAmbient",
  "aerialSunTransmittance",
  "aerialParams",
]);

/** Everything a consumer needs to fill the shared uniforms for one frame. */
export interface AerialPerspectiveBinding {
  readonly cameraAltitudeMeters: number;
  readonly sunDirection: [number, number, number];
  readonly coefficients: AerialPerspectiveCoefficients;
  readonly sunRadiance: [number, number, number];
  readonly ambient: [number, number, number];
  readonly sunTransmittance: [number, number, number];
  readonly strength: number;
}

/**
 * Resolves the per-frame binding from the environment. `sunColor` and
 * `skyHorizonColor` are the palette colours the sky itself draws with, and
 * `sunIlluminanceNormalized` the shared normalizer — so haze fades into the
 * same horizon the sky renders and sits on the scene's own light scale.
 * (1C-5 replaces the palette with skyRadiance() from this include; then the
 * agreement is by construction rather than by shared inputs.)
 */
/**
 * NIGHT_LOOK_ARCHITECTURE §2.1 — how much of the aerial integral's source is
 * the MOON rather than the sun, from the sun's elevation sine alone. 0 by
 * day and through civil twilight (sun above −4°), 1 below −8°: the moonlit
 * sky IS Rayleigh-scattered moonlight, so at night the same shared integral
 * that builds the day sky runs on the moon — the deep-blue gradient, the
 * horizon falloff and the blue depth-haze on night terrain then agree with
 * each other by construction (1C-5's property, extended to night).
 */
export function aerialNightness(sunDirectionY: number): number {
  const t = Math.min(1, Math.max(0, (-0.07 - sunDirectionY) / 0.07));
  return t * t * (3 - 2 * t);
}

/**
 * The full-moon night sky's radiance as a fraction of the noon sun's, for
 * the aerial integral. ART-DIRECTED ABSOLUTE, PHYSICAL RELATIVE — the same
 * doctrine as `MOON_PEAK_LIGHT_INTENSITY` and for the same arithmetic
 * reason: the physical ratio is ~2 × 10⁻⁶ (0.25 lux against 120,000), which
 * the display chain cannot show. Everything relative still rides
 * `moonIlluminanceNormalizedToFull` (phase, altitude, distance), so a half
 * moon's sky is genuinely dimmer than a full moon's. Tuned by capture
 * against `skyBlueDominance` targeting ~[0.04, 0.12] (day reads 0.147);
 * Jason's sanction: "more blue in the sky than expected" is okay.
 */
export const NIGHT_SKY_MOON_STRENGTH = 0.045;
// ART DIRECTION 2026-09-01, Jason on the option-(c) frames, verbatim: "could
// you incorporate more blue (dark blue) into the night sky to light up
// surroundings a bit more?" — raised 0.02 -> 0.045. This is the honest lever
// for exactly that sentence: the same in-scatter deepens the sky's blue AND
// lifts the terrain, and it replaces the blue the tint-withdrawal correctly
// stopped painting over the sky (skyBlueDominance 0.0347 -> 0.0179 under
// option (c); this restores it radiance-borne).

/** The moonlit sky's source colour: cool daylight, slightly blue-shifted. */
export const NIGHT_SKY_MOON_TINT: readonly [number, number, number] = [0.62, 0.78, 1.0];

export function resolveAerialPerspectiveBinding(
  state: EnvironmentState,
  cameraAltitudeMeters: number,
  sunColor: [number, number, number],
  skyHorizonColor: [number, number, number],
  sunIlluminanceNormalized: number,
  moonDirection: [number, number, number] = [0, -1, 0],
  moonIlluminanceNormalizedToFull = 0,
): AerialPerspectiveBinding {
  const coefficients = aerialPerspectiveCoefficients(state);
  // A moonless night never swaps: the sun stays the source with its own
  // near-zero radiance, and the sky is honestly dark.
  const nightness = moonIlluminanceNormalizedToFull > 0
    ? aerialNightness(state.sun.direction[1])
    : 0;
  // Blend the SOURCE the integral runs on. Direction is a normalized lerp —
  // both endpoints are unit vectors and the blend window is narrow, so the
  // path never degenerates; radiance and transmittance blend per source.
  const sunTransmittance = evaluateTransmittance(
    state.atmosphere,
    Math.max(cameraAltitudeMeters, 0),
    state.sun.direction[1],
    12,
  );
  const sunScale = sunIlluminanceNormalized * AERIAL_SUN_RADIANCE_SCALE;
  const daylight = Math.min(1, Math.max(0, (state.sun.direction[1] + 0.08) / 0.4));
  let sourceDirection: [number, number, number] = [
    state.sun.direction[0],
    state.sun.direction[1],
    state.sun.direction[2],
  ];
  let sourceRadiance: [number, number, number] = [
    sunColor[0] * sunScale,
    sunColor[1] * sunScale,
    sunColor[2] * sunScale,
  ];
  let sourceTransmittance: [number, number, number] = [
    sunTransmittance[0],
    sunTransmittance[1],
    sunTransmittance[2],
  ];
  if (nightness > 0) {
    const moonScale = moonIlluminanceNormalizedToFull
      * NIGHT_SKY_MOON_STRENGTH * AERIAL_SUN_RADIANCE_SCALE;
    const moonTransmittance = evaluateTransmittance(
      state.atmosphere,
      Math.max(cameraAltitudeMeters, 0),
      moonDirection[1],
      12,
    );
    const blended: [number, number, number] = [
      sourceDirection[0] * (1 - nightness) + moonDirection[0] * nightness,
      sourceDirection[1] * (1 - nightness) + moonDirection[1] * nightness,
      sourceDirection[2] * (1 - nightness) + moonDirection[2] * nightness,
    ];
    const length = Math.hypot(blended[0], blended[1], blended[2]) || 1;
    sourceDirection = [blended[0] / length, blended[1] / length, blended[2] / length];
    sourceRadiance = [
      sourceRadiance[0] * (1 - nightness) + NIGHT_SKY_MOON_TINT[0] * moonScale * nightness,
      sourceRadiance[1] * (1 - nightness) + NIGHT_SKY_MOON_TINT[1] * moonScale * nightness,
      sourceRadiance[2] * (1 - nightness) + NIGHT_SKY_MOON_TINT[2] * moonScale * nightness,
    ];
    sourceTransmittance = [
      sourceTransmittance[0] * (1 - nightness) + moonTransmittance[0] * nightness,
      sourceTransmittance[1] * (1 - nightness) + moonTransmittance[1] * nightness,
      sourceTransmittance[2] * (1 - nightness) + moonTransmittance[2] * nightness,
    ];
  }
  const ambient: [number, number, number] = [
    skyHorizonColor[0] * AERIAL_AMBIENT_SCALE * daylight,
    skyHorizonColor[1] * AERIAL_AMBIENT_SCALE * daylight,
    skyHorizonColor[2] * AERIAL_AMBIENT_SCALE * daylight,
  ];
  return {
    cameraAltitudeMeters,
    sunDirection: sourceDirection,
    coefficients,
    sunRadiance: sourceRadiance,
    ambient,
    sunTransmittance: sourceTransmittance,
    strength: 1,
  };
}

export const AERIAL_PERSPECTIVE_PLUGIN_NAME = "aerial-perspective-receiver";

/**
 * The include's functions without the uniform declarations — for contexts
 * that provide the `uniforms` struct themselves: the PBR plugin (via its
 * UBO) and the CI agreement kernel (via an explicit struct).
 */
export const AERIAL_PERSPECTIVE_FUNCTIONS_WGSL = AERIAL_PERSPECTIVE_WGSL
  .replace(/uniform aerial[A-Za-z]+:[^\n]+\n/g, "");

const PLUGIN_WGSL = Object.freeze({
  CUSTOM_FRAGMENT_DEFINITIONS: AERIAL_PERSPECTIVE_FUNCTIONS_WGSL,
  CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: /* wgsl */ `
let aerialViewVector = fragmentInputs.vPositionW.xyz - scene.vEyePosition.xyz;
let aerialDistance = length(aerialViewVector);
if (aerialDistance > 1.0) {
  finalColor = vec4f(
    applyAerialPerspective(
      finalColor.rgb,
      fragmentInputs.vPositionW.y,
      aerialDistance,
      aerialViewVector / aerialDistance,
    ),
    finalColor.a,
  );
}
`,
});

/**
 * The PBR receiver plugin. Hook: CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR,
 * immediately after pbrBlockImageProcessing — which under
 * IMAGEPROCESSINGPOSTPROCESS (applyByPostProcess true) is only a clamp, so
 * finalColor is still linear HDR here. Both load-bearing preconditions
 * (applyByPostProcess, FOGMODE_NONE) are asserted at startup in
 * RenderInvariants.
 */
export class AerialPerspectiveMaterialPlugin extends MaterialPluginBase {
  private binding: AerialPerspectiveBinding | null = null;

  constructor(material: PBRMaterial) {
    super(material, AERIAL_PERSPECTIVE_PLUGIN_NAME, 205, undefined, true, true);
    this.doNotSerialize = true;
  }

  override getClassName(): string {
    return "AerialPerspectiveMaterialPlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setBinding(binding: AerialPerspectiveBinding | null): void {
    this.binding = binding;
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
  } {
    return {
      ubo: [
        { name: "aerialCameraAltitude", size: 1, type: "float" },
        { name: "aerialSunDirection", size: 3, type: "vec3" },
        { name: "aerialRayleigh", size: 3, type: "vec3" },
        { name: "aerialMieScatter", size: 3, type: "vec3" },
        { name: "aerialMieExtinction", size: 3, type: "vec3" },
        { name: "aerialOzone", size: 3, type: "vec3" },
        { name: "aerialSunRadiance", size: 3, type: "vec3" },
        { name: "aerialAmbient", size: 3, type: "vec3" },
        { name: "aerialSunTransmittance", size: 3, type: "vec3" },
        { name: "aerialParams", size: 4, type: "vec4" },
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const binding = this.binding;
    if (!binding) {
      uniformBuffer.updateFloat4("aerialParams", 0, 0, 0, 0);
      return;
    }
    uniformBuffer.updateFloat("aerialCameraAltitude", binding.cameraAltitudeMeters);
    uniformBuffer.updateFloat3(
      "aerialSunDirection",
      binding.sunDirection[0],
      binding.sunDirection[1],
      binding.sunDirection[2],
    );
    uniformBuffer.updateFloat3(
      "aerialRayleigh",
      binding.coefficients.rayleighScattering[0],
      binding.coefficients.rayleighScattering[1],
      binding.coefficients.rayleighScattering[2],
    );
    uniformBuffer.updateFloat3(
      "aerialMieScatter",
      binding.coefficients.mieScattering[0],
      binding.coefficients.mieScattering[1],
      binding.coefficients.mieScattering[2],
    );
    uniformBuffer.updateFloat3(
      "aerialMieExtinction",
      binding.coefficients.mieExtinction[0],
      binding.coefficients.mieExtinction[1],
      binding.coefficients.mieExtinction[2],
    );
    uniformBuffer.updateFloat3(
      "aerialOzone",
      binding.coefficients.ozoneAbsorption[0],
      binding.coefficients.ozoneAbsorption[1],
      binding.coefficients.ozoneAbsorption[2],
    );
    uniformBuffer.updateFloat3(
      "aerialSunRadiance",
      binding.sunRadiance[0],
      binding.sunRadiance[1],
      binding.sunRadiance[2],
    );
    uniformBuffer.updateFloat3(
      "aerialAmbient",
      binding.ambient[0],
      binding.ambient[1],
      binding.ambient[2],
    );
    uniformBuffer.updateFloat3(
      "aerialSunTransmittance",
      binding.sunTransmittance[0],
      binding.sunTransmittance[1],
      binding.sunTransmittance[2],
    );
    uniformBuffer.updateFloat4(
      "aerialParams",
      RAYLEIGH_SCALE_HEIGHT_METERS,
      MIE_SCALE_HEIGHT_METERS,
      binding.coefficients.mieAnisotropy,
      binding.strength,
    );
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    if (shaderType !== "fragment") return null;
    if (shaderLanguage !== ShaderLanguage.WGSL) return null;
    return { ...PLUGIN_WGSL };
  }
}

export interface AerialPerspectiveProjection {
  readonly state: EnvironmentState;
  readonly cameraAltitudeMeters: number;
  readonly sunColor: [number, number, number];
  readonly skyHorizonColor: [number, number, number];
  readonly sunIlluminanceNormalized: number;
  /** §2.1 night sky: the moon as the integral's night source. */
  readonly moonDirection: [number, number, number];
  /** Moon illuminance / full-moon illuminance — phase, altitude, distance. */
  readonly moonIlluminanceNormalizedToFull: number;
}

function isOpaqueAerialReceiver(material: PBRMaterial): boolean {
  if (material.unlit) return false;
  if (material.alpha < 1 - 1e-4) return false;
  if (
    material.transparencyMode !== null
    && material.transparencyMode !== 0
  ) return false;
  return true;
}

/**
 * One registry over the small fixed PBR material set (vegetation, wildlife,
 * aircraft, airport, terrain) — the third subclass of the Phase 0 receiver
 * plumbing, exactly as the manifest prescribes.
 */
export class AerialPerspectiveRegistry extends SharedReceiverRegistry<
  AerialPerspectiveProjection,
  AerialPerspectiveBinding,
  AerialPerspectiveMaterialPlugin
> {
  protected get pluginName(): string {
    return AERIAL_PERSPECTIVE_PLUGIN_NAME;
  }

  protected isEligibleMaterial(material: PBRMaterial): boolean {
    return isOpaqueAerialReceiver(material);
  }

  protected createPlugin(material: PBRMaterial): AerialPerspectiveMaterialPlugin {
    return new AerialPerspectiveMaterialPlugin(material);
  }

  protected resolveBinding(
    projection: AerialPerspectiveProjection,
  ): AerialPerspectiveBinding {
    return resolveAerialPerspectiveBinding(
      projection.state,
      projection.cameraAltitudeMeters,
      projection.sunColor,
      projection.skyHorizonColor,
      projection.sunIlluminanceNormalized,
      projection.moonDirection,
      projection.moonIlluminanceNormalizedToFull,
    );
  }

  protected applyProjection(
    plugin: AerialPerspectiveMaterialPlugin,
    _projection: AerialPerspectiveProjection,
    binding: AerialPerspectiveBinding,
  ): void {
    plugin.setBinding(binding);
  }

  protected clearPlugin(plugin: AerialPerspectiveMaterialPlugin): void {
    plugin.setBinding(null);
  }
}

/** Helper for ShaderMaterial consumers (ocean, rivers, cloud composite). */
export function applyAerialPerspectiveToShaderMaterial(
  material: {
    setFloat(name: string, value: number): void;
    setVector3?(name: string, value: unknown): void;
    setFloats?(name: string, value: number[]): void;
  },
  binding: AerialPerspectiveBinding,
  setVector3: (name: string, x: number, y: number, z: number) => void,
  setVector4: (name: string, x: number, y: number, z: number, w: number) => void,
): void {
  material.setFloat("aerialCameraAltitude", binding.cameraAltitudeMeters);
  setVector3("aerialSunDirection", ...binding.sunDirection);
  setVector3("aerialRayleigh", ...binding.coefficients.rayleighScattering);
  setVector3("aerialMieScatter", ...binding.coefficients.mieScattering);
  setVector3("aerialMieExtinction", ...binding.coefficients.mieExtinction);
  setVector3("aerialOzone", ...binding.coefficients.ozoneAbsorption);
  setVector3("aerialSunRadiance", ...binding.sunRadiance);
  setVector3("aerialAmbient", ...binding.ambient);
  setVector3("aerialSunTransmittance", ...binding.sunTransmittance);
  setVector4(
    "aerialParams",
    RAYLEIGH_SCALE_HEIGHT_METERS,
    MIE_SCALE_HEIGHT_METERS,
    binding.coefficients.mieAnisotropy,
    binding.strength,
  );
}

