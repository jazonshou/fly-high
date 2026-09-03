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
import {
  WATER_RENDERING_GROUP_ID,
  keepOpaqueDepthForRenderingGroup,
} from "../core/RenderingGroups";

/**
 * Water is rendered after opaque terrain so its transparent surfaces can be
 * ordered together. Babylon clears depth before every non-zero rendering
 * group by default; leaving that default active makes the ocean ignore the
 * terrain bed it is meant to feather against and turns its camera-centred
 * presentation disk into an overlay on dry land.
 *
 * The group id and the whole draw order live in `core/RenderingGroups.ts`
 * (the translucent airframe has to know it draws AFTER this group). Both
 * water owners call this idempotent scene-level setup from their constructors
 * so a newly constructed owner cannot silently restore Babylon's default.
 */
export { WATER_RENDERING_GROUP_ID };

export function configureDepthAwareWaterRendering(scene: Scene): void {
  keepOpaqueDepthForRenderingGroup(scene, WATER_RENDERING_GROUP_ID);
}

/** Shared constants block (PI). */
export const WATER_SHADING_CONSTANTS_WGSL = /* wgsl */ `const PI: f32 = 3.14159265359;`;

/** `5-11`: one physical depth model shared by ocean, rivers, and lakes. */
export const WATER_ABSORPTION_PER_METER = Object.freeze([0.45, 0.07, 0.02] as const);
export const WATER_SHORE_FADE_METERS = 0.4;
export const WATER_AIR_INTERFACE_CRITICAL_ANGLE_DEGREES = 48.6;
/** Leave a toroidal guard at the near level's edge, as the original selector did. */
export const BATHYMETRY_NEAR_BLEND_END_FRACTION = 0.48;
/** Four far texels make the resolution handoff C1 over 512 m, not one hard line. */
export const BATHYMETRY_NEAR_BLEND_FAR_TEXELS = 4;

/** CPU mirror of the body/in-scatter light envelope composed in both shaders. */
export function waterDiffuseIlluminanceNormalized(
  sunIlluminanceNormalized: number,
  skylightIlluminanceNormalized: number,
): number {
  if (
    !Number.isFinite(sunIlluminanceNormalized)
    || !Number.isFinite(skylightIlluminanceNormalized)
    || sunIlluminanceNormalized < 0
    || skylightIlluminanceNormalized < 0
  ) {
    throw new RangeError("Water illuminance inputs must be finite and non-negative");
  }
  return Math.max(sunIlluminanceNormalized, skylightIlluminanceNormalized);
}

/** CPU mirror of the near/far clipmap handoff used by source and sweep tests. */
export function bathymetryNearBlendWeight(
  chebyshevDistanceMeters: number,
  nearSpanMeters: number,
  farTexelMeters: number,
): number {
  if (
    !Number.isFinite(chebyshevDistanceMeters)
    || !Number.isFinite(nearSpanMeters)
    || !Number.isFinite(farTexelMeters)
    || chebyshevDistanceMeters < 0
    || nearSpanMeters <= 0
    || farTexelMeters <= 0
  ) {
    throw new RangeError("Bathymetry blend inputs must be finite and positive");
  }
  const end = nearSpanMeters * BATHYMETRY_NEAR_BLEND_END_FRACTION;
  const start = end - farTexelMeters * BATHYMETRY_NEAR_BLEND_FAR_TEXELS;
  if (start <= 0) {
    throw new RangeError("Bathymetry blend band must fit inside the near level");
  }
  const t = Math.min(1, Math.max(0, (chebyshevDistanceMeters - start) / (end - start)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * `6-4` caustics — the constants, in one place, from which both the WGSL and
 * the TypeScript parity oracle below are generated. Nothing here may be
 * re-typed as a literal in either language: `WATER_CAUSTIC_WGSL` interpolates
 * these values, so a retune moves the shader and the oracle together.
 */

/**
 * Beyond this depth the caustic term is not evaluated at all — the early-out
 * in `waterRefractedSunBeam` returns a zero beam and every downstream block is
 * branch-skipped.
 *
 * 24 m, not 6-3's 60 m shoaling gate. Three independent bounds land in the
 * same place. (a) Extinction: the bed's own Beer-Lambert transmittance
 * (0.45/0.07/0.02 per metre) is 2e-5 / 0.18 / 0.62 at 24 m — the red channel
 * is gone and the surviving blue-green bed radiance is already dominated by
 * the one-scatter turbidity glow, which caustics do not modulate. (b) Sun-disc
 * penumbra: the sun subtends 0.0093 rad, narrowed to ~0.0070 rad by refraction
 * into water, so the beam's own blur at the bed is ~0.17 m at 24 m — comparable
 * to the filament spacing of every band that still carries contrast there, so
 * the pattern is washing out on its own. (c) The measured field: cascade 0's
 * representative 2 m band reaches its focal depth at ~24 m
 * (`oceanCausticCurvatureScale` x the spectrum's measured Jacobian sigma), and
 * past focus a single-sheet model has no light left to place.
 */
export const WATER_CAUSTIC_GATE_METERS = 24;
/**
 * The gate is a WIDE fade, deliberately, for the same reason wave R's shore
 * foam band is wide: the bathymetry texel is 16 m, so a tight depth key steps
 * in 16 m blocks. 13 m of fade spans most of a texel, and depth enters the
 * focal term linearly everywhere else, so nothing in this term has a
 * derivative sharp enough to print the clipmap grid.
 */
export const WATER_CAUSTIC_FADE_START_METERS = 11;
/** Sine of the sun elevation at which caustics start / reach full strength. */
export const WATER_CAUSTIC_SUN_FADE_LOW = 0.03;
export const WATER_CAUSTIC_SUN_FADE_HIGH = 0.2;
/** Fresh-water index of refraction, shared with the 5-11 refraction terms. */
export const WATER_REFRACTIVE_INDEX = 1.333;
/**
 * Softening of the caustic sheet's singularity: the first-order area ratio
 * passes through zero at the focus, where a single-sheet model diverges.
 * `sqrt(areaRatio^2 + s^2)` is the smooth (C-infinity, no shimmer-inducing
 * kink) bound; s = 0.35 caps the sheet at 3.03x, inside the 2-4x contrast
 * measured on sunlit seabeds.
 */
export const WATER_CAUSTIC_PEAK_SOFTENING = 0.35;
/**
 * Fraction of the bed's downwelling irradiance that arrives as the collimated
 * solar beam; the rest is diffuse skylight, which no surface lens focuses.
 * 0.8 is the clear-sky, high-sun value — the term is a lerp toward 1, so this
 * doubles as the strength dial without disturbing the mean.
 */
export const WATER_CAUSTIC_DIRECT_SUN_FRACTION = 0.8;
/**
 * `WATER_DETAIL_NOISE_WGSL`'s value lattice, measured over 490,000 samples at
 * a world-scale origin (scratch harness, 2026-08-30): RMS of the centred value
 * 0.21403, RMS of its lattice Laplacian 1.9727 per cell^2, so the effective
 * k^2 is 9.2168 (k_eff = 3.036, i.e. the lattice's dominant wavelength is ~2
 * cells, as expected). The correlation between -(value - 0.5) and the true
 * Laplacian is 0.70: for a band-limited height field the two are the same
 * quantity up to k^2, which is why the octave's own noise value can serve as
 * its own curvature for the cost of nothing.
 */
export const WATER_CAUSTIC_NOISE_LAPLACIAN = 9.2168;
export const WATER_CAUSTIC_NOISE_RMS = 0.214;
/**
 * The 3:1 across-wind stretch of capillary octaves C and D splits the
 * Laplacian unevenly between the two lattice axes: (1 + 1/9)/2 of the
 * isotropic value.
 */
export const WATER_CAUSTIC_STRETCH_3_LAPLACIAN = WATER_CAUSTIC_NOISE_LAPLACIAN * (1 + 1 / 9) / 2;
/**
 * Standard deviation of one cascade's stored horizontal-displacement Jacobian.
 * Measured by the CPU harness that reproduces the whole GPU chain and quoted
 * in `DEFAULT_SPECTRAL_OCEAN_CONFIG`'s `foamThreshold` docblock: 0.048-0.075
 * per cascade once the spectrum carries its cell measure. 0.06 is the middle
 * of that range; it sets only the per-band focal weighting and the
 * mean-neutrality estimate, never the pattern itself.
 */
export const WATER_CAUSTIC_JACOBIAN_SIGMA = 0.06;
/**
 * Mean-neutrality. A caustic redistributes light, it does not create it, but
 * the first-order single-sheet formula keeps only the first fold and so drifts
 * bright as the field's focus variance rises. Measured over five octave/cascade
 * regimes x ten depths (0.3-24 m): the sheet's spatial mean tracks
 * `1 + 0.26 * min(1, 3.19 * focusVariance)` with an RMS residual of 0.0084 and
 * a worst-case normalized-mean error of 2.2%. Dividing by that estimate makes
 * the term mean-neutral at every depth AND exactly inert (gain 1.000) wherever
 * the field is quiet.
 */
export const WATER_CAUSTIC_MEAN_EXCESS = 0.26;
export const WATER_CAUSTIC_MEAN_KNEE = 3.19;

/**
 * Ray deflection per unit surface slope for a vertical beam entering water:
 * the transmitted ray tilts toward the inward normal by `slope * (1 - 1/n)`,
 * so a horizontal displacement of `depth * (1 - 1/n) * grad(eta)` accumulates
 * on the way to the bed. This single factor is the whole optics of the caustic.
 */
export const WATER_CAUSTIC_REFRACTION_FACTOR = 1 - 1 / WATER_REFRACTIVE_INDEX;
/** Snell's `1/n^2`, for the refracted sun ray's vertical cosine. */
export const WATER_CAUSTIC_INVERSE_IOR_SQUARED = 1 / (WATER_REFRACTIVE_INDEX ** 2);
/** Renormalises the softened sheet so an unfocused beam returns exactly 1. */
export const WATER_CAUSTIC_SHEET_NORMALIZATION = Math.sqrt(
  1 + WATER_CAUSTIC_PEAK_SOFTENING ** 2,
);

/** The refracted solar beam at one fragment; `weight` 0 means fully gated off. */
export interface WaterCausticBeam {
  readonly slantMeters: number;
  readonly weight: number;
}

/** One fragment's accumulated surface curvature and its focus variance. */
export interface WaterCausticAccumulator {
  readonly curvature: number;
  readonly varianceSum: number;
}

/** The zero accumulator — the identity of `waterCausticBand`. */
export const WATER_CAUSTIC_ZERO: WaterCausticAccumulator = Object.freeze({
  curvature: 0,
  varianceSum: 0,
});

/**
 * TypeScript oracle for `WATER_CAUSTIC_WGSL`, statement for statement. The
 * GPU test (`tests/gpu/water-caustics.test.ts`) runs the shader block through
 * a real adapter and compares it against these three functions; the Node
 * suite uses them for the physical-property assertions a GPU test would be too
 * heavy to sweep. This is the TS/WGSL parity idiom the phase plan asks of
 * every new water term.
 */
export function waterRefractedSunBeam(
  depthMeters: number,
  sunElevationSine: number,
): WaterCausticBeam {
  if (depthMeters >= WATER_CAUSTIC_GATE_METERS || sunElevationSine <= WATER_CAUSTIC_SUN_FADE_LOW) {
    return { slantMeters: 0, weight: 0 };
  }
  const sinIncidentSquared = clamp01(1 - sunElevationSine * sunElevationSine);
  const cosTransmitted = Math.sqrt(
    Math.max(1 - sinIncidentSquared * WATER_CAUSTIC_INVERSE_IOR_SQUARED, 0),
  );
  const gate = 1 - smoothstepUnit(
    WATER_CAUSTIC_FADE_START_METERS,
    WATER_CAUSTIC_GATE_METERS,
    depthMeters,
  );
  const sunUp = smoothstepUnit(
    WATER_CAUSTIC_SUN_FADE_LOW,
    WATER_CAUSTIC_SUN_FADE_HIGH,
    sunElevationSine,
  );
  return {
    slantMeters: depthMeters / Math.max(cosTransmitted, 0.5),
    weight: gate * sunUp,
  };
}

/** Folds one band's curvature in, weighted down once it is past its focus. */
export function waterCausticBand(
  accumulated: WaterCausticAccumulator,
  curvature: number,
  curvatureRms: number,
  beam: WaterCausticBeam,
): WaterCausticAccumulator {
  const focusRms = beam.slantMeters * WATER_CAUSTIC_REFRACTION_FACTOR * curvatureRms;
  const weight = 1 / (1 + focusRms * focusRms);
  const weightedRms = weight * curvatureRms;
  return {
    curvature: accumulated.curvature + weight * curvature,
    varianceSum: accumulated.varianceSum + weightedRms * weightedRms,
  };
}

/** A sinusoidal surface band read as its own curvature; see the WGSL twin. */
export function waterCausticSinusoidBand(
  accumulated: WaterCausticAccumulator,
  phase: number,
  curvatureAmplitude: number,
  beam: WaterCausticBeam,
): WaterCausticAccumulator {
  return waterCausticBand(
    accumulated,
    -Math.sin(phase) * curvatureAmplitude,
    curvatureAmplitude * Math.SQRT1_2,
    beam,
  );
}

/** The spectral cascades' folds, one lane each; see the WGSL twin. */
export function waterCausticCascadeBands(
  accumulated: WaterCausticAccumulator,
  jacobians: readonly [number, number, number, number],
  jacobian4: number,
  scales: readonly [number, number, number, number],
  scale4: number,
  beam: WaterCausticBeam,
): WaterCausticAccumulator {
  let caustic = accumulated;
  for (let lane = 0; lane < 4; lane += 1) {
    caustic = waterCausticBand(
      caustic,
      (jacobians[lane]! - 1) * scales[lane]!,
      Math.abs(scales[lane]!) * WATER_CAUSTIC_JACOBIAN_SIGMA,
      beam,
    );
  }
  return waterCausticBand(
    caustic,
    (jacobian4 - 1) * scale4,
    Math.abs(scale4) * WATER_CAUSTIC_JACOBIAN_SIGMA,
    beam,
  );
}

/** A value-lattice octave read as its own curvature; see the WGSL twin. */
export function waterCausticNoiseBand(
  accumulated: WaterCausticAccumulator,
  noiseValue: number,
  curvatureScale: number,
  beam: WaterCausticBeam,
): WaterCausticAccumulator {
  return waterCausticBand(
    accumulated,
    -(noiseValue - 0.5) * curvatureScale,
    curvatureScale * WATER_CAUSTIC_NOISE_RMS,
    beam,
  );
}

/** The multiplier on the bed's direct-sun radiance. 1.0 means fully inert. */
export function waterCausticBedGain(
  caustic: WaterCausticAccumulator,
  beam: WaterCausticBeam,
  sunVisibility: number,
): number {
  if (beam.weight <= 0) return 1;
  const focalScale = beam.slantMeters * WATER_CAUSTIC_REFRACTION_FACTOR;
  const areaRatio = 1 + focalScale * caustic.curvature;
  const softening = WATER_CAUSTIC_PEAK_SOFTENING * WATER_CAUSTIC_PEAK_SOFTENING;
  const sheet = WATER_CAUSTIC_SHEET_NORMALIZATION
    / Math.sqrt(areaRatio * areaRatio + softening);
  const focusVariance = focalScale * focalScale * caustic.varianceSum;
  const meanSheet = 1
    + WATER_CAUSTIC_MEAN_EXCESS * Math.min(1, focusVariance * WATER_CAUSTIC_MEAN_KNEE);
  return 1 + beam.weight * sunVisibility * WATER_CAUSTIC_DIRECT_SUN_FRACTION
    * (sheet / meanSheet - 1);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function smoothstepUnit(low: number, high: number, value: number): number {
  const t = clamp01((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

/**
 * `6-4` — Jacobian-driven caustics on the submerged bed.
 *
 * WHY THE STORED JACOBIAN IS THE SIGNAL. The spectrum already writes a
 * horizontal-displacement Jacobian per cascade (`slope_foam.a` /
 * `displacement_jacobian.a`, OceanShaders.ts) and the foam term already reads
 * it: where the surface's differential area contracts, waves break. Caustics
 * are the same convergence one order of magnitude earlier. For a narrow band
 * at wavenumber k with choppiness lambda, the choppy displacement is
 * `D = (lambda/k) grad(eta)`, so `J - 1 = tr(dD/dx) = (lambda/k) lap(eta)` and
 * the stored Jacobian IS the surface Laplacian in disguise — the one quantity
 * that bends the refracted sun beam. (`oceanCausticCurvatureScale` owns the
 * k/lambda conversion, per cascade, from the config's own band-pass limits.)
 *
 * THE OPTICS. A vertical sun ray entering at surface point x is deflected
 * horizontally by `(1 - 1/n) grad(eta)` per unit depth, so the bed point it
 * reaches is `X = x + s (1 - 1/n) grad(eta)` for a slant path s, and the beam's
 * differential area at the bed is `dX/dx = 1 + s (1 - 1/n) lap(eta)`.
 * Irradiance is the reciprocal. This is a real focal length: the term peaks
 * where `s (1-1/n) lap(eta)` reaches -1, so each surface scale lights up at
 * its OWN depth (2 m swell near 24 m, the 0.42 m capillary octave near 6 m,
 * the 4 cm octave near 1.2 m). Crests focus, troughs spread — the classic
 * bright web on a dark ground, out of the physics rather than a texture.
 *
 * WHY THE BANDS ARE WEIGHTED. Past its focal depth a band's caustic breaks
 * into multiple sheets that this first-order model cannot carry, so each band
 * is faded by `1/(1 + focusRms^2)` — the same "hand the unresolvable band's
 * energy to a statistic" discipline the capillary block uses for roughness.
 * The measured consequence is that the composed focus RMS self-normalises to
 * 0.55-0.90 at EVERY depth from 0.3 m to 24 m: the contrast stays constant
 * while the pattern's scale grows with the water column, which is exactly how
 * a real seabed reads.
 *
 * WHAT IT IS NOT. The convergence is sampled at the fragment's own surface
 * point, not at the point where the sun ray entered — a rigid lateral shift of
 * a statistically homogeneous field, invisible in the pattern, and worth far
 * more than a second set of cascade fetches. It also means the web's parallax
 * is surface-locked rather than bed-locked; inside the 24 m gate, with the
 * beam already blurred by the solar disc, that is not a visible error.
 *
 * This block is self-contained pure arithmetic on purpose: it declares no
 * uniform, samples no texture, and therefore compiles standalone in the GPU
 * parity test.
 */
export const WATER_CAUSTIC_WGSL = /* wgsl */ `
const WATER_CAUSTIC_GATE_METERS: f32 = ${toWgslFloat(WATER_CAUSTIC_GATE_METERS)};
const WATER_CAUSTIC_FADE_START_METERS: f32 = ${toWgslFloat(WATER_CAUSTIC_FADE_START_METERS)};
const WATER_CAUSTIC_SUN_FADE_LOW: f32 = ${toWgslFloat(WATER_CAUSTIC_SUN_FADE_LOW)};
const WATER_CAUSTIC_SUN_FADE_HIGH: f32 = ${toWgslFloat(WATER_CAUSTIC_SUN_FADE_HIGH)};
const WATER_CAUSTIC_REFRACTION: f32 = ${toWgslFloat(WATER_CAUSTIC_REFRACTION_FACTOR)};
const WATER_CAUSTIC_INVERSE_IOR_SQUARED: f32 = ${toWgslFloat(WATER_CAUSTIC_INVERSE_IOR_SQUARED)};
const WATER_CAUSTIC_PEAK_SOFTENING: f32 = ${toWgslFloat(WATER_CAUSTIC_PEAK_SOFTENING)};
const WATER_CAUSTIC_SHEET_NORMALIZATION: f32 = ${toWgslFloat(WATER_CAUSTIC_SHEET_NORMALIZATION)};
const WATER_CAUSTIC_MEAN_EXCESS: f32 = ${toWgslFloat(WATER_CAUSTIC_MEAN_EXCESS)};
const WATER_CAUSTIC_MEAN_KNEE: f32 = ${toWgslFloat(WATER_CAUSTIC_MEAN_KNEE)};
const WATER_CAUSTIC_DIRECT_SUN_FRACTION: f32 = ${toWgslFloat(WATER_CAUSTIC_DIRECT_SUN_FRACTION)};
const WATER_CAUSTIC_NOISE_LAPLACIAN: f32 = ${toWgslFloat(WATER_CAUSTIC_NOISE_LAPLACIAN)};
const WATER_CAUSTIC_NOISE_RMS: f32 = ${toWgslFloat(WATER_CAUSTIC_NOISE_RMS)};
const WATER_CAUSTIC_STRETCH_3_LAPLACIAN: f32 = ${toWgslFloat(WATER_CAUSTIC_STRETCH_3_LAPLACIAN)};
const WATER_CAUSTIC_JACOBIAN_SIGMA: f32 = ${toWgslFloat(WATER_CAUSTIC_JACOBIAN_SIGMA)};

struct WaterCausticBeam {
  slantMeters: f32,
  weight: f32,
}

struct WaterCaustic {
  curvature: f32,
  varianceSum: f32,
}

// THE GATE. Returns a zero beam beyond it, which makes every downstream block
// a single predicted branch: no band is accumulated, no sheet is evaluated,
// and waterCausticBedGain returns exactly 1.0. Deep water and night pay two
// comparisons.
fn waterRefractedSunBeam(depth: f32, sunElevationSine: f32) -> WaterCausticBeam {
  if (depth >= WATER_CAUSTIC_GATE_METERS || sunElevationSine <= WATER_CAUSTIC_SUN_FADE_LOW) {
    return WaterCausticBeam(0.0, 0.0);
  }
  // Snell into water: the beam's vertical cosine never drops below 0.661, so
  // the slant path is at most 1.51x the depth even with the sun on the horizon.
  let sinIncidentSquared = clamp(1.0 - sunElevationSine * sunElevationSine, 0.0, 1.0);
  let cosTransmitted = sqrt(
    max(1.0 - sinIncidentSquared * WATER_CAUSTIC_INVERSE_IOR_SQUARED, 0.0),
  );
  let gate = 1.0 - smoothstep(WATER_CAUSTIC_FADE_START_METERS, WATER_CAUSTIC_GATE_METERS, depth);
  let sunUp = smoothstep(WATER_CAUSTIC_SUN_FADE_LOW, WATER_CAUSTIC_SUN_FADE_HIGH, sunElevationSine);
  return WaterCausticBeam(depth / max(cosTransmitted, 0.5), gate * sunUp);
}

// One band of surface curvature, faded by how far past its own focal depth
// this water column is. curvatureRms must be the band's non-negative RMS.
fn waterCausticBand(
  accumulated: WaterCaustic,
  curvature: f32,
  curvatureRms: f32,
  beam: WaterCausticBeam,
) -> WaterCaustic {
  let focusRms = beam.slantMeters * WATER_CAUSTIC_REFRACTION * curvatureRms;
  let weight = 1.0 / (1.0 + focusRms * focusRms);
  let weightedRms = weight * curvatureRms;
  return WaterCaustic(
    accumulated.curvature + weight * curvature,
    accumulated.varianceSum + weightedRms * weightedRms,
  );
}

// An analytic sinusoidal band — the inland surface's own wave terms, whose
// Laplacian is exact rather than approximated: lap(A sin(k.x)) = -A |k|^2
// sin(k.x). The RMS of a sinusoid is its amplitude over sqrt(2).
fn waterCausticSinusoidBand(
  accumulated: WaterCaustic,
  phase: f32,
  curvatureAmplitude: f32,
  beam: WaterCausticBeam,
) -> WaterCaustic {
  return waterCausticBand(
    accumulated,
    -sin(phase) * curvatureAmplitude,
    curvatureAmplitude * 0.70710678,
    beam,
  );
}

// The spectrum's folds, one lane per cascade. scales is each cascade's
// k/choppiness (oceanCausticCurvatureScale) already multiplied by that
// cascade's own texture fade, so a band the pixel cannot resolve contributes
// nothing. A cascade the profile does not run carries the stored Jacobian's
// identity 1.0 AND a zero scale, so it is inert twice over.
fn waterCausticCascadeBands(
  accumulated: WaterCaustic,
  jacobians: vec4f,
  jacobian4: f32,
  scales: vec4f,
  scale4: f32,
  beam: WaterCausticBeam,
) -> WaterCaustic {
  let folds = (jacobians - vec4f(1.0)) * scales;
  let foldRms = abs(scales) * WATER_CAUSTIC_JACOBIAN_SIGMA;
  var caustic = waterCausticBand(accumulated, folds.x, foldRms.x, beam);
  caustic = waterCausticBand(caustic, folds.y, foldRms.y, beam);
  caustic = waterCausticBand(caustic, folds.z, foldRms.z, beam);
  caustic = waterCausticBand(caustic, folds.w, foldRms.w, beam);
  return waterCausticBand(
    caustic,
    (jacobian4 - 1.0) * scale4,
    abs(scale4) * WATER_CAUSTIC_JACOBIAN_SIGMA,
    beam,
  );
}

// A value-lattice octave IS its own curvature: for a band-limited height field
// lap(h) = -k_eff^2 (h - mean), and WATER_CAUSTIC_NOISE_LAPLACIAN is the
// measured k_eff^2 of this lattice. curvatureScale is the octave's world slope
// scale times its cells/metre times that constant.
fn waterCausticNoiseBand(
  accumulated: WaterCaustic,
  noiseValue: f32,
  curvatureScale: f32,
  beam: WaterCausticBeam,
) -> WaterCaustic {
  return waterCausticBand(
    accumulated,
    -(noiseValue - 0.5) * curvatureScale,
    curvatureScale * WATER_CAUSTIC_NOISE_RMS,
    beam,
  );
}

// The multiplier on the bed's direct-sun radiance. Exactly 1.0 outside the
// gate, at night, in shadow, and wherever the surface is flat.
fn waterCausticBedGain(caustic: WaterCaustic, beam: WaterCausticBeam, sunVisibility: f32) -> f32 {
  if (beam.weight <= 0.0) { return 1.0; }
  let focalScale = beam.slantMeters * WATER_CAUSTIC_REFRACTION;
  // Differential area of the refracted beam at the bed. < 1 converging.
  let areaRatio = 1.0 + focalScale * caustic.curvature;
  let softening = WATER_CAUSTIC_PEAK_SOFTENING * WATER_CAUSTIC_PEAK_SOFTENING;
  let sheet = WATER_CAUSTIC_SHEET_NORMALIZATION
    * inverseSqrt(areaRatio * areaRatio + softening);
  // Mean-neutrality: a caustic moves light, it does not add any.
  let focusVariance = focalScale * focalScale * caustic.varianceSum;
  let meanSheet = 1.0
    + WATER_CAUSTIC_MEAN_EXCESS * min(1.0, focusVariance * WATER_CAUSTIC_MEAN_KNEE);
  return 1.0 + beam.weight * sunVisibility * WATER_CAUSTIC_DIRECT_SUN_FRACTION
    * (sheet / meanSheet - 1.0);
}
`;

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
 *
 * `6-4` composed the caustic block into this same include rather than into
 * either material: the bed's direct-sun radiance is modulated inside
 * `waterVolumeRadiance` below, which is the ONE place either surface can get a
 * refracted bed from. A second copy in one material is the drift this file
 * exists to prevent, and `tests/render.webgpu-water-depth.test.ts` pins that
 * both materials compose this text verbatim.
 */
export const WATER_DEPTH_OPTICS_WGSL = /* wgsl */ `
const WATER_ABSORPTION_PER_METER = vec3f(0.45, 0.07, 0.02);
const WATER_SHORE_FADE_METERS: f32 = 0.4;
const WATER_CRITICAL_ANGLE_DEGREES: f32 = 48.6;
${WATER_CAUSTIC_WGSL}

fn bathymetryWrappedUv(worldXZ: vec2f, placement: vec4f) -> vec2f {
  let worldTexel = worldXZ / placement.z;
  let wrapped = worldTexel - floor(worldTexel / placement.w) * placement.w;
  return (wrapped + vec2f(0.5)) / placement.w;
}

fn sampleBathymetryBedDelta(worldXZ: vec2f) -> f32 {
  let nearCenter = (uniforms.bathymetryNearPlacement.xy
    + vec2f(uniforms.bathymetryNearPlacement.w * 0.5))
    * uniforms.bathymetryNearPlacement.z;
  let nearDistance = max(
    abs(worldXZ.x - nearCenter.x),
    abs(worldXZ.y - nearCenter.y),
  );
  let nearBlendEnd = uniforms.bathymetryNearPlacement.z
    * uniforms.bathymetryNearPlacement.w * ${BATHYMETRY_NEAR_BLEND_END_FRACTION};
  let nearBlendStart = nearBlendEnd
    - uniforms.bathymetryFarPlacement.z * ${BATHYMETRY_NEAR_BLEND_FAR_TEXELS}.0;
  if (nearDistance <= nearBlendStart) {
    return textureSampleLevel(
      bathymetryNear,
      bathymetryNearSampler,
      bathymetryWrappedUv(worldXZ, uniforms.bathymetryNearPlacement),
      0.0,
    ).r;
  }
  let farDelta = textureSampleLevel(
    bathymetryFar,
    bathymetryFarSampler,
    bathymetryWrappedUv(worldXZ, uniforms.bathymetryFarPlacement),
    0.0,
  ).r;
  if (nearDistance >= nearBlendEnd) {
    return farDelta;
  }
  let nearDelta = textureSampleLevel(
    bathymetryNear,
    bathymetryNearSampler,
    bathymetryWrappedUv(worldXZ, uniforms.bathymetryNearPlacement),
    0.0,
  ).r;
  let nearWeight = 1.0 - smoothstep(nearBlendStart, nearBlendEnd, nearDistance);
  return mix(farDelta, nearDelta, nearWeight);
}

fn waterDepthFromBathymetry(surfaceElevation: f32, worldXZ: vec2f) -> f32 {
  let bedElevation = uniforms.bathymetrySeaLevel + sampleBathymetryBedDelta(worldXZ);
  return max(surfaceElevation - bedElevation, 0.0);
}

// 6-2: the bed's own slope, from the UNCLAMPED delta. It has to be the raw
// delta rather than a difference of depths: the shoreward tap of a surf-zone
// fragment is above water, where waterDepthFromBathymetry clamps to zero and
// the measured slope collapses to a fraction of the true one exactly where the
// run-up needs it most. Three taps rather than a centred five, and forward
// rather than centred, because the estimate is only ever used as a DIRECTION
// and a magnitude: the half-step bias shifts the streak field ~12 m along the
// beach, which nothing can see. Each tap is a bilinear sample, so the returned
// slope is C0 in world position — creased at texel edges, never stepped.
fn waterBathymetryBedSlope(worldXZ: vec2f, stepMeters: f32) -> vec2f {
  let here = sampleBathymetryBedDelta(worldXZ);
  return vec2f(
    sampleBathymetryBedDelta(worldXZ + vec2f(stepMeters, 0.0)) - here,
    sampleBathymetryBedDelta(worldXZ + vec2f(0.0, stepMeters)) - here,
  ) / stepMeters;
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
  diffuseIlluminanceNormalized: f32,
  normal: vec3f,
  view: vec3f,
  cameraBelow: bool,
  sunVisibility: f32,
  caustic: WaterCaustic,
  causticBeam: WaterCausticBeam,
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
  // 6-4: the ONE place either water surface composes caustics. The sheet
  // multiplies the bed's DIRECT solar radiance before the same Beer-Lambert
  // extinction the bed already pays, so a deep bed shows none of it — no
  // separate depth falloff was invented for the term. The one-scatter
  // turbidity below is volume-averaged light along the whole path, which no
  // surface lens focuses, so it is deliberately left flat.
  let causticGain = waterCausticBedGain(caustic, causticBeam, sunVisibility);
  // One-scatter turbidity: energy removed from the direct bed path is
  // returned directionally as the familiar shallow turquoise glow.
  let turbidity = vec3f(0.018, 0.115, 0.105)
    * (vec3f(1.0) - transmittance)
    * (0.38 + 0.62 * sunVisibility);
  // The body terms are diffuse radiance calibrated at the atmosphere's
  // reference daylight. Carry the stronger of its raw sun/skylight scales so
  // they do not become self-emissive under scotopic exposure.
  return (bed * causticGain * transmittance + turbidity)
    * diffuseIlluminanceNormalized;
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

fn applyUnderwaterBeerLambert(
  color: vec3f,
  pathMeters: f32,
  sunVisibility: f32,
  diffuseIlluminanceNormalized: f32,
) -> vec3f {
  let path = clamp(pathMeters, 0.0, 80.0);
  let transmittance = exp(-WATER_ABSORPTION_PER_METER * path);
  let inScatter = vec3f(0.012, 0.085, 0.09)
    * (vec3f(1.0) - transmittance)
    * (0.3 + 0.7 * sunVisibility)
    * diffuseIlluminanceNormalized;
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
 * Fix-pack W1/W2, extended by wave R: the near-field capillary lattices and
 * the world-locked gust field, shared by every water surface AND by the
 * ocean's VERTEX stage.
 *
 * This block is derivative-free on purpose. `waterCapillaryDetail` below needs
 * `dpdx`/`dpdy` and is fragment-only; the ripple lattices themselves are
 * ordinary functions of world position, so the ocean vertex shader can
 * displace with the very same noise the fragment shades with and the two
 * cannot disagree (wave R fix 3).
 *
 * Hash choice, wave R: `waterDetailGrad` is fed ABSOLUTE world metres, and a
 * fract-of-product hash degenerates there — at 1e5 m the product lands where
 * f32 spacing is ~2e-3 and the lattice collapses into bands (the recorded
 * incident behind `detail/groundCoverWgsl.ts`'s `groundHash2`). Every hash
 * here is therefore the integer hash that file uses. The remaining bound is
 * f32 integer exactness on the cell index itself: the finest octave runs 50
 * cells/m, so cells stay exact out to ~3e5 m of world coordinate.
 */
export const WATER_DETAIL_NOISE_WGSL = /* wgsl */ `fn waterDetailHash(cell: vec2f, salt: f32) -> f32 {
  var h = (u32(i32(cell.x)) * 0x27d4eb2du)
    ^ (u32(i32(cell.y)) * 0x165667b1u)
    ^ (u32(i32(salt * 8.0)) * 0x9e3779b9u);
  h = h ^ (h >> 15u);
  h = h * 0x2c1b3c6du;
  h = h ^ (h >> 12u);
  h = h * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return f32(h) * 2.3283064365386963e-10;
}

fn waterDetailValue(point: vec2f, salt: f32) -> f32 {
  let cell = floor(point);
  let local = point - cell;
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  return mix(
    mix(waterDetailHash(cell, salt), waterDetailHash(cell + vec2f(1.0, 0.0), salt), blend.x),
    mix(waterDetailHash(cell + vec2f(0.0, 1.0), salt), waterDetailHash(cell + vec2f(1.0), salt), blend.x),
    blend.y,
  );
}

fn waterDetailGrad(point: vec2f) -> vec3f {
  let cell = floor(point);
  let local = point - cell;
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  let slope = 6.0 * local * (vec2f(1.0) - local);
  let a = waterDetailHash(cell, 0.0);
  let b = waterDetailHash(cell + vec2f(1.0, 0.0), 0.0);
  let c = waterDetailHash(cell + vec2f(0.0, 1.0), 0.0);
  let d = waterDetailHash(cell + vec2f(1.0), 0.0);
  return vec3f(
    mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y),
    mix(b - a, d - c, blend.y) * slope.x,
    mix(c - a, d - b, blend.x) * slope.y,
  );
}

// wave R: cat's paws. One prevailing wind driving every square metre
// identically is what pinned ocean roughness to a constant and read as
// plastic. Two world-locked octaves (57 m and 23 m) modulate the LOCAL wind
// instead, so gusted lanes and calm lanes coexist in one frame. Both octaves
// fade toward the mean on the pixel footprint — an unfiltered 23 m field
// aliases past ~10 m/pixel, and a gust field is not worth a shimmer.
fn waterGustField(worldXZ: vec2f, footprint: f32) -> f32 {
  let coarseWeight = 1.15 * (1.0 - smoothstep(10.0, 34.0, footprint));
  let fineWeight = 0.5 * (1.0 - smoothstep(4.0, 14.0, footprint));
  let coarse = waterDetailValue(worldXZ * 0.017544, 1.0) - 0.5;
  let fine = waterDetailValue(worldXZ * 0.043478 + vec2f(19.0, 7.0), 2.0) - 0.5;
  return clamp(1.0 + coarseWeight * coarse + fineWeight * fine, 0.35, 1.55);
}

// Wrapped so the advected noise coordinate cannot grow into f32
// quantization over a long session; the once-per-~68-min phase snap is a
// single-frame ripple reseed, invisible against wave motion.
fn waterRippleDrift(windVelocity: vec2f, time: f32) -> vec2f {
  return windVelocity * (time - floor(time / 4096.0) * 4096.0);
}

// Floor 0.06, not the pre-wave-R 0.1: a calm gust lane must be able to reach
// roughness ~0.11 so the surface has somewhere to vary TO. The unresolved-tail
// fold scales with this, and so does every ripple octave's amplitude.
fn waterRippleWind(windVelocity: vec2f, worldXZ: vec2f, footprint: f32) -> f32 {
  return clamp(
    length(windVelocity) * 0.09 * waterGustField(worldXZ, footprint),
    0.06,
    1.0,
  );
}

// Drift factors are far below 1: capillary PHASE speed is ~0.3-0.5 m/s
// regardless of the wind that raised the ripples, and advecting the fine
// lattice at full wind moved it more than half a noise cell per 60 fps
// frame above ~5 m/s of wind — temporal aliasing shimmer, not motion.
fn waterRippleGradA(worldXZ: vec2f, drift: vec2f) -> vec3f {
  return waterDetailGrad((worldXZ - drift * 0.22) * 2.4);
}

fn waterRippleGradB(worldXZ: vec2f, drift: vec2f) -> vec3f {
  let rotated = mat2x2f(0.848, 0.53, -0.53, 0.848) * (worldXZ - drift * 0.11);
  return waterDetailGrad(rotated * 6.1 + vec2f(13.7, 41.3));
}

// wave R: the two finest octaves are STRETCHED across the wind. Real
// capillary ripples are ridges perpendicular to the breeze; the isotropic
// lattice octaves A and B use reads as blobs once a pixel covers only a few
// centimetres. Returns the world-axis slope of one anisotropic octave, chain
// rule included, in the caller's amplitude convention, plus (6-4) the octave's
// own lattice VALUE in z — its height, and therefore its curvature.
fn waterCapillaryOctave(
  worldXZ: vec2f,
  drift: vec2f,
  windAxis: vec2f,
  cellsPerMeter: f32,
  stretch: f32,
  offset: vec2f,
) -> vec3f {
  let across = vec2f(-windAxis.y, windAxis.x);
  let advected = worldXZ - drift;
  let lattice = vec2f(dot(advected, windAxis), dot(advected, across) / stretch)
    * cellsPerMeter + offset;
  let grad = waterDetailGrad(lattice);
  return vec3f(windAxis * grad.y + across * (grad.z / stretch), grad.x);
}`;

/**
 * Fix-pack W1/W2 (extended by wave R): the near-field capillary band and the
 * sub-grid spectrum tail, shared by every water FRAGMENT.
 *
 * Below the finest cascade's Nyquist (1.0 m at tier 1) the rendered spectrum
 * simply ended: near pixels magnified 0.5 m slope texels into playdough, and
 * because the moment texture holds exactly `s²` at mip 0 the Toksvig variance
 * was identically ZERO up close — roughness collapsed to the floor and the
 * probe reflected at mip 0. Glass. This block supplies (a) four wind-advected
 * procedural ripple octaves (~0.42 m, ~0.16 m, ~0.06 m and ~0.02 m),
 * world-locked so descending toward the surface produces real optical flow —
 * the altitude cue — (b) the unresolved mean-square slope of everything the
 * pixel cannot carry, for the caller to fold into GGX roughness exactly like
 * a faded cascade, and (c) a glint-only normal jitter. Octaves fade on their
 * own pixel-footprint Nyquist and hand their energy to the roughness term as
 * they go, the 2-8 discipline.
 *
 * Slopes are in the `normalize(vec3f(slope.x, 1, slope.y))` convention both
 * call sites use.
 *
 * 6-4 added (d): the same four octaves' CURVATURE, which is what focuses the
 * refracted sun beam onto the bed. It is free — every octave's lattice value
 * is already computed alongside the gradient the slope uses — and it is the
 * only convergence signal inland water has, since a river's surface carries no
 * spectral Jacobian. The whole accumulation is skipped when the caller passes
 * a zero-weight beam, i.e. everywhere past the caustic depth gate.
 */
export const WATER_CAPILLARY_DETAIL_WGSL = /* wgsl */ `struct WaterSurfaceDetail {
  slope: vec2f,
  unresolvedMeanSquareSlope: f32,
  glintSlope: vec2f,
  caustic: WaterCaustic,
}

fn waterCapillaryDetail(
  worldXZ: vec2f,
  windVelocity: vec2f,
  time: f32,
  resolvedSlope: f32,
  causticBeam: WaterCausticBeam,
) -> WaterSurfaceDetail {
  let derivativeX = dpdx(worldXZ);
  let derivativeY = dpdy(worldXZ);
  let footprintMajor = max(length(derivativeX), length(derivativeY));
  let footprintMinor = min(length(derivativeX), length(derivativeY));
  // wave R, mirroring terrain's Fix-pack T2 (TerrainSurfacePlugin.ts): fade on
  // the footprint the 16x anisotropic sampler actually resolves — the MINOR
  // axis, floored at major/16 — not the raw major axis. From a 2-4 m eye the
  // major axis crosses both octaves' thresholds within 10-20 m while the minor
  // axis (the direction the eye resolves) stays small for hundreds of metres,
  // so the ripples died exactly where the reported plastic tubes appear. This
  // was the single largest term in the near-field defect.
  let footprint = max(footprintMinor, footprintMajor * ${(1 / 16).toFixed(6)});
  let wind01 = waterRippleWind(windVelocity, worldXZ, footprint);
  let drift = waterRippleDrift(windVelocity, time);
  let windAxis = normalize(windVelocity + vec2f(0.00001, 0.0));
  var slope = vec2f(0.0);
  var glint = vec2f(0.0);
  // 6-4: each octave's lattice value, i.e. its height, and therefore (up to
  // the band's k_eff^2) its curvature. 0.5 is the lattice mean, so an octave
  // that never runs contributes exactly zero.
  var noiseA = 0.5;
  var noiseB = 0.5;
  var noiseC = 0.5;
  var noiseD = 0.5;
  // wave R: the never-resolved tail is a FIELD, not a constant. It scales with
  // the locally RESOLVED wave slope — a steep flank carries more sub-pixel
  // structure than a trough — and with the gusted wind, so roughness varies
  // across the surface instead of pinning every ocean pixel to 0.33-0.34,
  // which is the definition of plastic. The faded-octave handoffs below keep
  // the 2-8 energy discipline unchanged: only this base term is a field.
  let slopeGain = 0.4 + 1.2 * min(resolvedSlope, 1.5);
  var unresolved = 0.006 * wind01 * slopeGain;
  let fadeA = 1.0 - smoothstep(0.05, 0.21, footprint);
  if (fadeA > 0.001) {
    let gradA = waterRippleGradA(worldXZ, drift);
    slope += vec2f(gradA.y, gradA.z) * 0.14 * wind01 * fadeA;
    noiseA = gradA.x;
  }
  unresolved += 0.020 * wind01 * (1.0 - fadeA * fadeA);
  let fadeB = 1.0 - smoothstep(0.02, 0.08, footprint);
  if (fadeB > 0.001) {
    let gradB = waterRippleGradB(worldXZ, drift);
    slope += vec2f(gradB.y, gradB.z) * 0.10 * wind01 * fadeB;
    noiseB = gradB.x;
  }
  unresolved += 0.016 * wind01 * (1.0 - fadeB * fadeB);
  // wave R: two more octaves below B, stretched 3:1 across the wind. Drift
  // factors stay <= 0.1 for the same temporal-aliasing reason as A and B.
  let fadeC = 1.0 - smoothstep(0.008, 0.03, footprint);
  if (fadeC > 0.001) {
    let octaveC = waterCapillaryOctave(worldXZ, drift * 0.07, windAxis, 16.667, 3.0, vec2f(5.1, 27.9));
    slope += octaveC.xy * 0.085 * wind01 * fadeC;
    noiseC = octaveC.z;
  }
  unresolved += 0.010 * wind01 * (1.0 - fadeC * fadeC);
  let fadeD = 1.0 - smoothstep(0.003, 0.012, footprint);
  if (fadeD > 0.001) {
    let octaveD = waterCapillaryOctave(worldXZ, drift * 0.04, windAxis, 50.0, 3.0, vec2f(71.3, 9.7));
    slope += octaveD.xy * 0.06 * wind01 * fadeD;
    noiseD = octaveD.z;
    // wave R: the glint jitter. A ~0.045 m perturbation that reaches the SUN
    // lobe only — folding it into the environment reflection would boil the
    // reflected sky, but the sun is a 0.0047 rad disc and this is what breaks
    // its smeared streak back into discrete twinkling points. Tied to the
    // finest octave's fade, so it costs nothing past ~20 m.
    let gradGlint = waterDetailGrad((worldXZ - drift * 0.03) * 22.0 + vec2f(61.7, 5.3));
    glint = vec2f(gradGlint.y, gradGlint.z) * 0.05 * wind01 * fadeD;
  }
  unresolved += 0.006 * wind01 * (1.0 - fadeD * fadeD);
  // 6-4: the capillary band's contribution to the bed caustic. Each octave's
  // curvature scale is its OWN slope scale above times its cells/metre times
  // the lattice's measured k_eff^2 — constant-folded, and written as that
  // product so a retune of an octave's amplitude cannot silently desync its
  // caustic. Octaves C and D carry the 3:1 stretch's Laplacian split. The
  // per-band focal weighting inside waterCausticBand is what makes the visible
  // pattern coarsen with depth: the 4 cm octave focuses near 1.2 m, the 0.42 m
  // octave near 6 m, and cascade 0's 2 m band out at the gate.
  var caustic = WaterCaustic(0.0, 0.0);
  if (causticBeam.weight > 0.0) {
    caustic = waterCausticNoiseBand(
      caustic, noiseA, 0.14 * 2.4 * WATER_CAUSTIC_NOISE_LAPLACIAN * wind01 * fadeA, causticBeam);
    caustic = waterCausticNoiseBand(
      caustic, noiseB, 0.10 * 6.1 * WATER_CAUSTIC_NOISE_LAPLACIAN * wind01 * fadeB, causticBeam);
    caustic = waterCausticNoiseBand(
      caustic, noiseC, 0.085 * 16.667 * WATER_CAUSTIC_STRETCH_3_LAPLACIAN * wind01 * fadeC, causticBeam);
    caustic = waterCausticNoiseBand(
      caustic, noiseD, 0.06 * 50.0 * WATER_CAUSTIC_STRETCH_3_LAPLACIAN * wind01 * fadeD, causticBeam);
  }
  return WaterSurfaceDetail(slope, unresolved, glint, caustic);
}`;

/*
 * ===========================================================================
 * `6-1` — channel flow: advection, standing waves and fetch-limited chop.
 *
 * INLAND WATER ONLY. This block is composed into the hydrology fragment and
 * NOT into the ocean: every term below is driven by the channel graph's
 * exported hydraulics, which no ocean fragment has. The shared blocks above
 * are untouched — 6-1 adds a consumer of `waterDetailGrad`,
 * `waterCapillaryOctave`, `waterGustField` and `waterDetailValue`, not a new
 * definition of anything the ocean composes.
 *
 * THE SENTINEL. `waterData.w` is zero on every analytic-mode vertex
 * (`appendRiver`/`appendLake` push a literal 0 and the W-5 analytic byte pin
 * holds them there) and `1 + payload` on every graph-mode vertex. The whole
 * block early-outs on `channelPayload <= 0`, and the fragment guards its
 * accumulators with the same test, so an analytic world executes one compare
 * and nothing else. That is the §1.2 parity-sentinel pattern with the added
 * property that the sentinel is a vertex ATTRIBUTE lane the analytic builders
 * already wrote — no new binding, no new uniform, no new texture.
 * ===========================================================================
 */

/** Graph-mode vertices carry `BASE + payload`; analytic vertices carry 0. */
export const WATER_CHANNEL_SENTINEL_BASE = 1;

/**
 * Channel grade (rise/run) at which the river payload saturates.
 *
 * 6% is a genuinely steep reach: lowland trunk channels run 1e-4 to 1e-3,
 * upland streams 1e-2, and the boulder-garden reaches that actually stand
 * waves up sit at 2e-2 to 6e-2. Above that the exported channel is a
 * waterfall and the standing-wave model (a free-surface gravity wave riding a
 * steady current) has stopped applying anyway.
 */
export const WATER_CHANNEL_GRADE_REFERENCE = 0.06;

/**
 * Fetch at which the lake payload saturates, metres.
 *
 * 20 km of fetch at 6 m/s of wind is a 0.43 m significant height — real chop,
 * and about where fetch-limited growth stops being the binding constraint
 * (beyond it a lake breeze is duration-limited long before it is
 * fetch-limited). Larger lakes clamp here rather than growing ocean swell on
 * an inland surface.
 */
export const WATER_LAKE_FETCH_REFERENCE_METERS = 20_000;

/**
 * Effective fetch from the nearest-shore distance a lake vertex already
 * carries.
 *
 * True fetch is directional — the upwind distance to land — and computing it
 * per vertex means a second O(ring) ray cast against the shoreline on a cold
 * path that D-5 already measured at its budget. The Shore Protection Manual's
 * effective-fetch construction averages the fetch over ±45° about the wind,
 * where the short rays dominate the average, so a multiple of the
 * omnidirectional nearest-shore distance is the standard cheap surrogate for
 * exactly that average. The floor keeps the shoreline itself from reading as
 * a glassy rim: a lee shore has the whole lake upwind of it.
 */
export const WATER_LAKE_EFFECTIVE_FETCH_FACTOR = 4;
export const WATER_LAKE_FETCH_FLOOR_METERS = 60;

export const WATER_FLOW_GRAVITY = 9.81;
const TWO_PI = 2 * Math.PI;

/**
 * Dual-phase (Vlachos 2010) advection cycle bounds, seconds.
 *
 * WHY A BOUNDED AGE IS NOT OPTIONAL. A fragment shader has no memory, so the
 * only way to advect a static lattice is to look it up at the position the
 * parcel came from, `p - v(p)·t`. Three things then diverge with `t`:
 * (a) the strain `t·∂v/∂x` shears the lattice without bound — a 1 m/s change
 * over 100 m of reach destroys the pattern inside ten minutes of flight;
 * (b) the offset `v·t` grows the lattice coordinate past f32 integer
 * exactness (the recorded world-scale hash failure, one scale up);
 * (c) any reset of `t` pops. Vlachos's construction fixes all three at once:
 * hold two copies whose ages are half a cycle apart and cross-fade each to
 * zero weight at the instant it wraps. Age is then bounded by the cycle, so
 * the strain, the coordinate growth and the pop all are.
 */
export const WATER_FLOW_CYCLE_MINIMUM_SECONDS = 0.7;
export const WATER_FLOW_CYCLE_MAXIMUM_SECONDS = 14;
/** Drift below this is treated as this, so a still pool cannot divide by zero. */
export const WATER_FLOW_MINIMUM_DRIFT_METERS_PER_SECOND = 0.2;

/**
 * The three advected scales, metres, and the fraction of the exported surface
 * velocity each is carried at.
 *
 * The scales are the three bands a river surface actually shows: boils and
 * eddies shed off the bed at roughly the channel depth (9 m), the riffle
 * wavelets they break into (1.6 m), and the fine ripple texture riding on top
 * (0.36 m). The speeds are independent and DESCEND with scale for a physical
 * reason: the large structures are material — they are the water — and move
 * at the surface velocity, while the small ones are capillary-gravity waves
 * with their own phase velocity relative to that water, which is on average
 * directed upstream for the wind- and turbulence-raised component. Their
 * ground-frame convection speed is therefore below the surface speed. The
 * same reduction is what the wave-R capillary octaves already apply (their
 * 0.22/0.11/0.07/0.04 drift factors) for the additional, measured reason that
 * a fine lattice advected at full speed moves more than half a cell per frame
 * and shimmers.
 */
export const WATER_FLOW_SCALE_METERS = Object.freeze([9, 1.6, 0.36] as const);
export const WATER_FLOW_DRIFT_FRACTION = Object.freeze([1, 0.85, 0.7] as const);
/** Slope amplitude per scale, in the shared `vec3f(slope.x, 1, slope.y)` convention. */
export const WATER_FLOW_SLOPE_AMPLITUDE = Object.freeze([0.03, 0.055, 0.045] as const);
/**
 * Streaks are elongated ALONG the flow, so the lattice axis handed to
 * `waterCapillaryOctave` (which elongates ACROSS its axis) is the
 * cross-stream one.
 */
export const WATER_FLOW_STRETCH = 2.2;
/** Octave fade window, in multiples of the octave's own scale. */
export const WATER_FLOW_FADE_LOW = 0.16;
export const WATER_FLOW_FADE_HIGH = 0.45;

/**
 * Amplitude scaling from the exported flow speed: `base + slope·min(v, cap)`.
 *
 * Linear in the mean velocity because the surface roughness of an open
 * channel scales with the friction velocity, which for a given roughness
 * height is proportional to the depth-averaged velocity. The base is a floor
 * so a backwater still carries some texture instead of turning to glass.
 */
export const WATER_FLOW_SPEED_GAIN_BASE = 0.1;
export const WATER_FLOW_SPEED_GAIN_SLOPE = 0.3;
export const WATER_FLOW_SPEED_GAIN_CAP = 4.5;
/**
 * Mean-square slope handed to roughness as an octave fades out — the 2-8
 * energy discipline the capillary block uses, applied to these octaves with
 * one factor instead of four hand-tuned constants because their amplitudes
 * are already a field.
 */
export const WATER_FLOW_UNRESOLVED_FACTOR = 0.35;
/** Lattice offset between the two Vlachos phases; decorrelates the copies. */
export const WATER_FLOW_PHASE_LATTICE_OFFSET = Object.freeze([53.7, 17.3] as const);

/**
 * Standing waves — the term the whole item exists for.
 *
 * A wave is stationary in the ground frame exactly when its phase velocity
 * cancels the current: `c = v`. For a deep-water gravity wave
 * `c = sqrt(gλ/2π)`, so `λ = 2π v²/g` — the standing wavelength is a
 * function of the EXPORTED flow speed and nothing else. A 2 m/s reach stands
 * 2.6 m waves, a 3 m/s reach 5.8 m, a 5 m/s reach 16 m, which is the observed
 * ordering of haystack spacing with reach velocity.
 *
 * The two exported hydraulics then control the two properties they physically
 * control, and neither controls the other's: **speed sets the wavelength,
 * grade sets the STEEPNESS.** Steepness `ka` is dimensionless and grade is the
 * energy slope, so keying one to the other is dimensionally the right
 * statement; it also means the amplitude comes out as `a = (ka)·v²/g`, i.e.
 * still rising steeply with the exported speed, without the steepness falling
 * as it does under a speed-linear amplitude (which made a torrent break LESS
 * than a riffle — measured, and the reason this law is written this way).
 *
 * The steepness ceiling is the Stokes limit `ka = 0.443` — past it the crest
 * breaks, which is why the same number drives the crest-foam weight rather
 * than a second tuning knob. With the coefficient at 0.55 the ceiling binds
 * above a normalised grade of 0.73 (about 4.4%) and the breaking window spans
 * 2.7% to 4.6% — the class II to class IV band.
 *
 * The phase argument is `k · arcLength` with the arc length W-5 exports on
 * `uv.x`, plus a world-locked lattice wander and a lane-dependent bow. It
 * contains NO time term, which is the world-locking proof: the pattern is a
 * pure function of the mesh's world-anchored parameterisation, so it cannot
 * translate when the camera moves or the floating origin rebases.
 */
export const WATER_STANDING_STEEPNESS_COEFFICIENT = 0.55;
/** Stokes limiting steepness for a deep-water wave is ka = 0.443. */
export const WATER_STANDING_MAXIMUM_SLOPE = 0.4;
export const WATER_STANDING_MINIMUM_WAVELENGTH_METERS = 1.2;
export const WATER_STANDING_MAXIMUM_WAVELENGTH_METERS = 40;
export const WATER_STANDING_BREAK_LOW = 0.25;
export const WATER_STANDING_BREAK_HIGH = 0.42;
export const WATER_STANDING_CREST_SHARPNESS = 6;
export const WATER_STANDING_WANDER_CELLS_PER_METER = 0.045;
export const WATER_STANDING_WANDER_WAVELENGTHS = 0.45;
export const WATER_STANDING_WANDER_SALT = 3;
export const WATER_STANDING_BOW_RADIANS = -2;
export const WATER_STANDING_LANE_FALLOFF = 0.55;
export const WATER_STANDING_FADE_LOW = 0.1;
export const WATER_STANDING_FADE_HIGH = 0.32;

/**
 * Fetch-limited lake chop, from the standard fetch-limited growth laws
 * (SPM/CEM form, JONSWAP coefficients):
 *
 *   g·Hs / U²  = 0.0016 · (g·F / U²)^(1/2)
 *   g·Tp / U   = 0.286  · (g·F / U²)^(1/3)
 *
 * The first collapses to `Hs = 0.0016 · U · sqrt(F/g)`, i.e. LINEAR in
 * `sqrt(F)` — which is why the vertex payload stores `sqrt(F/Fref)` rather
 * than the fetch: the quantity the rasteriser interpolates across a lake
 * triangle is then the wave height itself, not something the shader has to
 * square first. The second gives the peak period, hence the wavelength
 * `λ = g·Tp²/2π`, hence the phase speed the pattern drifts at, hence the
 * dual-phase cycle (one wave period — exactly the correlation time of a chop
 * field, and the bound that keeps the spatially varying drift from shearing
 * the lattice apart the way an unbounded `c(x)·t` would).
 *
 * The numbers this produces: a 60 m pond at 6 m/s gets 2.4 cm at 0.31 m —
 * glassy from anywhere, and below the pixel footprint from the air. A 20 km
 * lake at the same wind gets 43 cm at 14.8 m. That factor of eighteen in
 * height is the plan row's "a pond stays glassy and a big lake gets real
 * chop", produced by the growth law rather than by a size threshold.
 */
/**
 * The two SPM/CEM fetch-limited growth coefficients themselves, named once.
 *
 * 6-1 consumes them in the 20 km-reference form below (a lake's payload is
 * `sqrt(F/Fref)`); 6-2's `waterOceanShoreSwell` consumes them raw, because the
 * open sea's fetch is a config field in kilometres rather than a vertex
 * payload. One definition, two normalisations — the values below are
 * unchanged by the extraction, and `render.webgpu-water-flow.test.ts` pins
 * that.
 */
export const WATER_FETCH_SIGNIFICANT_HEIGHT_COEFFICIENT = 0.0016;
export const WATER_FETCH_PEAK_PERIOD_COEFFICIENT = 0.286;
export const WATER_LAKE_CHOP_HEIGHT_COEFFICIENT
  = WATER_FETCH_SIGNIFICANT_HEIGHT_COEFFICIENT
    * Math.sqrt(WATER_LAKE_FETCH_REFERENCE_METERS / WATER_FLOW_GRAVITY);
export const WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT
  = (WATER_FETCH_PEAK_PERIOD_COEFFICIENT ** 2 / TWO_PI) * WATER_FLOW_GRAVITY ** (-1 / 3);
/** Hs = 4σ and σ = a/√2 for a sinusoid, so a = Hs/(2√2). */
export const WATER_LAKE_CHOP_SINUSOID_AMPLITUDE = 1 / (2 * Math.SQRT2);
export const WATER_LAKE_CHOP_MAXIMUM_SLOPE = 0.3;
export const WATER_LAKE_CHOP_MINIMUM_WAVELENGTH_METERS = 0.12;
export const WATER_LAKE_CHOP_MAXIMUM_WAVELENGTH_METERS = 60;
/** Chop crests run perpendicular to the wind, so the lattice elongates across it. */
export const WATER_LAKE_CHOP_STRETCH = 2.5;
export const WATER_LAKE_CHOP_FADE_LOW = 0.1;
export const WATER_LAKE_CHOP_FADE_HIGH = 0.3;

/** One Vlachos phase pair: two bounded Lagrangian ages and their weights. */
export interface WaterFlowPhase {
  readonly ageA: number;
  readonly ageB: number;
  readonly weightA: number;
  readonly weightB: number;
}

/** The standing-wave train at one fragment; see the WGSL twin. */
export interface WaterStandingWave {
  readonly wavelengthMeters: number;
  readonly wavenumber: number;
  readonly slopeAmplitude: number;
  readonly curvatureAmplitude: number;
  readonly breaking: number;
}

/** The fetch-limited chop spectrum at one lake fragment; see the WGSL twin. */
export interface WaterLakeChop {
  readonly wavelengthMeters: number;
  readonly significantHeightMeters: number;
  readonly slopeAmplitude: number;
  readonly driftSpeed: number;
  readonly cycleSeconds: number;
}

/**
 * TypeScript oracle for `WATER_CHANNEL_FLOW_WGSL`'s pure-arithmetic half,
 * statement for statement. `tests/gpu/water-channel-flow.test.ts` pins these
 * against the shipped WGSL on a real adapter; the Node suite sweeps the
 * physical properties through them. Same split as 6-4's caustic oracle.
 */
export function waterFlowSpeedGain(flowSpeed: number): number {
  return WATER_FLOW_SPEED_GAIN_BASE
    + WATER_FLOW_SPEED_GAIN_SLOPE * Math.min(flowSpeed, WATER_FLOW_SPEED_GAIN_CAP);
}

export function waterFlowCycleSeconds(scaleMeters: number, driftSpeed: number): number {
  return Math.min(
    WATER_FLOW_CYCLE_MAXIMUM_SECONDS,
    Math.max(
      WATER_FLOW_CYCLE_MINIMUM_SECONDS,
      scaleMeters / Math.max(driftSpeed, WATER_FLOW_MINIMUM_DRIFT_METERS_PER_SECOND),
    ),
  );
}

/**
 * The dual-phase weights. `weightA` reaches zero exactly when copy A's age
 * wraps, and the pair is energy-normalised (the two copies read decorrelated
 * lattice offsets, so their variances add) — without that the field would
 * pulse by 30% twice a cycle, which is the artefact a naive cross-fade of two
 * uncorrelated noise samples always shows.
 */
export function waterFlowPhase(time: number, cycleSeconds: number): WaterFlowPhase {
  const cycles = time / cycleSeconds;
  const phaseA = cycles - Math.floor(cycles);
  const shifted = cycles + 0.5;
  const phaseB = shifted - Math.floor(shifted);
  const blend = Math.abs(2 * phaseA - 1);
  const weightA = 1 - blend;
  const energy = 1 / Math.sqrt(Math.max(weightA * weightA + blend * blend, 0.25));
  return {
    ageA: phaseA * cycleSeconds,
    ageB: phaseB * cycleSeconds,
    weightA: weightA * energy,
    weightB: blend * energy,
  };
}

/** The stationary wave train a reach of this speed and grade stands up. */
export function waterStandingWave(
  flowSpeed: number,
  gradeNormalized: number,
): WaterStandingWave {
  const wavelengthMeters = Math.min(
    WATER_STANDING_MAXIMUM_WAVELENGTH_METERS,
    Math.max(
      WATER_STANDING_MINIMUM_WAVELENGTH_METERS,
      (TWO_PI * flowSpeed * flowSpeed) / WATER_FLOW_GRAVITY,
    ),
  );
  const wavenumber = TWO_PI / wavelengthMeters;
  // The slope amplitude IS the steepness ka, so no amplitude is ever formed:
  // the shader only needs ka and k·(ka).
  const rawSlope = WATER_STANDING_STEEPNESS_COEFFICIENT * gradeNormalized;
  const slopeAmplitude = Math.min(rawSlope, WATER_STANDING_MAXIMUM_SLOPE);
  return {
    wavelengthMeters,
    wavenumber,
    slopeAmplitude,
    curvatureAmplitude: slopeAmplitude * wavenumber,
    breaking: smoothstepUnit(WATER_STANDING_BREAK_LOW, WATER_STANDING_BREAK_HIGH, rawSlope),
  };
}

/** The fetch-limited chop a lake of this fetch raises under this wind. */
export function waterLakeChop(windSpeed: number, fetchFactor: number): WaterLakeChop {
  const fetchMeters = fetchFactor * fetchFactor * WATER_LAKE_FETCH_REFERENCE_METERS;
  const significantHeightMeters
    = WATER_LAKE_CHOP_HEIGHT_COEFFICIENT * windSpeed * fetchFactor;
  const wavelengthMeters = Math.min(
    WATER_LAKE_CHOP_MAXIMUM_WAVELENGTH_METERS,
    Math.max(
      WATER_LAKE_CHOP_MINIMUM_WAVELENGTH_METERS,
      WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT
        * Math.max(windSpeed * fetchMeters, 0.0001) ** (2 / 3),
    ),
  );
  const amplitude = significantHeightMeters * WATER_LAKE_CHOP_SINUSOID_AMPLITUDE;
  const slopeAmplitude = Math.min(
    (TWO_PI * amplitude) / wavelengthMeters,
    WATER_LAKE_CHOP_MAXIMUM_SLOPE,
  );
  const driftSpeed = Math.sqrt((WATER_FLOW_GRAVITY * wavelengthMeters) / TWO_PI);
  return {
    wavelengthMeters,
    significantHeightMeters,
    slopeAmplitude,
    driftSpeed,
    cycleSeconds: wavelengthMeters / Math.max(driftSpeed, 0.05),
  };
}

/**
 * The river payload written into `waterData.w` by the graph-mode builder.
 * Analytic builders keep pushing a literal 0 and MUST NOT call this.
 */
export function waterChannelGradePayload(grade: number): number {
  const normalized = Number.isFinite(grade)
    ? Math.min(Math.max(grade / WATER_CHANNEL_GRADE_REFERENCE, 0), 1)
    : 0;
  return WATER_CHANNEL_SENTINEL_BASE + normalized;
}

/**
 * The effective fetch at a lake vertex, from the nearest-shore distance the
 * builder has already memoised and the lake's own span.
 */
export function waterLakeEffectiveFetchMeters(
  shoreDistanceMeters: number,
  lakeSpanMeters: number,
): number {
  const shore = Number.isFinite(shoreDistanceMeters) ? Math.max(shoreDistanceMeters, 0) : 0;
  const span = Number.isFinite(lakeSpanMeters) ? Math.max(lakeSpanMeters, 0) : 0;
  return Math.min(
    Math.max(span, WATER_LAKE_FETCH_FLOOR_METERS),
    WATER_LAKE_EFFECTIVE_FETCH_FACTOR * shore + WATER_LAKE_FETCH_FLOOR_METERS,
  );
}

/**
 * The lake payload written into `waterData.w`. Stored as `sqrt(F/Fref)` so
 * the interpolated quantity is the significant height (linear in it by the
 * growth law), not the fetch.
 */
export function waterLakeFetchPayload(fetchMeters: number): number {
  const normalized = Number.isFinite(fetchMeters)
    ? Math.min(Math.max(fetchMeters / WATER_LAKE_FETCH_REFERENCE_METERS, 0), 1)
    : 0;
  return WATER_CHANNEL_SENTINEL_BASE + Math.sqrt(normalized);
}

/*
 * ===========================================================================
 * `6-2` — shoreline run-up, shore-normal streaking, and the `6-5` wetness
 * field. The constants, the TypeScript oracle and the shared WGSL block, in
 * that order, from ONE set of numbers (nothing below is re-typed as a literal
 * in either language).
 *
 * WHAT ALREADY SHIPPED. Wave R's depth-keyed shore-foam band and reachable
 * whitecaps. This item is the DELTA: the band stops being static.
 *
 * THE BINDING RULE — the run-up phase comes from the same cascade the visible
 * swell comes from, or the surf beats out of time with the arriving waves.
 * The lock is expressed as one number, `WaterShoreSwell.radianFrequency`,
 * which is the ONLY temporal frequency anywhere in the term. The ocean derives
 * it from the cascade that actually dominates the visible swell at that pixel
 * (`waterShoreBandSwell` on the argmax of fade-weighted band amplitude); a
 * river bank derives it from the boil train drifting past; a lake shore from
 * its own fetch-limited chop. Three drivers, ONE run-up law.
 *
 * THE PHASE IS A FUNCTION OF DEPTH, NOT OF DISTANCE. On a plane beach of slope
 * `tan(beta)` the shallow-water celerity is `sqrt(g h)` and `h = tan(beta) X`,
 * so the travel time from the waterline out to depth `h` integrates in closed
 * form to `2 sqrt(h) / (tan(beta) sqrt(g))`. The eikonal phase is therefore
 * `omega (t + tau(h))` — a pure function of the depth this fragment already
 * sampled and the local beach slope. Three consequences, all of them the
 * reason the construction was chosen:
 *   (a) its spatial gradient is exactly `omega / sqrt(g h)`, the correct
 *       shallow-water wavenumber, so the crest spacing narrows shoreward on
 *       its own and the bands run PARALLEL to the depth contours — which is
 *       what refraction does to real surf, for no extra work;
 *   (b) it never reveals the 16 m bathymetry texel. `depth` is a bilinear
 *       sample (C0 in world position) and `tan(beta)` is a difference of two
 *       bilinear samples (also C0), so the phase is C0 and the foam bands are
 *       continuous. Only the band SPACING creases at texel edges, which is
 *       the same class of artefact wave R's shore band already ships with —
 *       and the deliberate reason both stay keyed on depth rather than on a
 *       depth threshold;
 *   (c) it costs one sqrt and one divide. There is no ray march, no second
 *       distance field and no shore-distance texture.
 *
 * WHY NO DUAL-PHASE ADVECTION ON THE OPEN COAST. 6-1's Vlachos pair exists to
 * bound an unbounded Lagrangian age. Swash advection is OSCILLATORY — its
 * offset is `excursion * front(phase)`, bounded by the swash excursion itself
 * — so the strain, the coordinate growth and the pop the dual phase exists to
 * prevent cannot occur, and one lattice sample suffices. Inland the bank does
 * ride a net current, so the bank streaks DO use 6-1's pair
 * (`waterFlowOctaveValue`), which is why that helper lives in 6-1's block.
 *
 * WHAT 6-5 CONSUMES. `waterShoreWetness` is the field, and it is the only
 * function here with no water-side caller: the run-up above the still
 * waterline is drawn by the TERRAIN, because the ocean disk sits at sea level
 * and is depth-tested away by any beach above it. See the function's own
 * docblock for the consumption contract.
 * ===========================================================================
 */

/**
 * Beach-slope clamps for Hunt's law, `tan(beta)`.
 *
 * 0.008 is a very flat dissipative beach (a 125 m surf zone per metre of
 * depth); 0.35 is a steep reflective shingle face. Outside those the Iribarren
 * number leaves the range the run-up formula was regressed on. The clamp is
 * NOT an aliasing lever: the phase's spatial gradient is
 * `omega * (true slope) / (clamped slope * sqrt(g h))`, so clamping a flatter
 * true slope UP makes the crest spacing coarser, never finer.
 */
export const WATER_RUNUP_BEACH_SLOPE_MINIMUM = 0.008;
export const WATER_RUNUP_BEACH_SLOPE_MAXIMUM = 0.35;
/**
 * Finite-difference step for the bed gradient, metres. 1.5 bathymetry texels:
 * wide enough that the estimate spans a texel rather than reading one texel's
 * bilinear interior, narrow enough to keep a 40 m-wide surf zone's own slope.
 */
export const WATER_RUNUP_GRADIENT_STEP_METERS = 24;
/** The surf term's depth gate — it fades out before wave R's band does. */
export const WATER_RUNUP_DEPTH_FADE_START_METERS = 4.5;
export const WATER_RUNUP_DEPTH_GATE_METERS = 9;
/** Streaks are an inner-surf phenomenon; past this depth there is no swash. */
export const WATER_RUNUP_STREAK_DEPTH_LOW_METERS = 1;
export const WATER_RUNUP_STREAK_DEPTH_HIGH_METERS = 3.4;
/**
 * The bore: a surf-zone wave is a sharp front with a long flat back, so the
 * modulation is `max(sin, 0)^3` — and it is written as a MEAN-PRESERVING
 * modulation about 1 (`1 + gain (bore - mean)`) because the shore band's
 * time-averaged coverage is a pinned quantity. The mean is exact:
 * `(1/2pi) integral_0^pi sin^3 = 2/(3 pi)`.
 */
export const WATER_RUNUP_BORE_SHARPNESS = 3;
export const WATER_RUNUP_BORE_MEAN = 2 / (3 * Math.PI);
/** 1.6 puts the modulation in [0.66, 2.26] — a bright front, never negative. */
export const WATER_RUNUP_BORE_GAIN = 1.6;
/**
 * Shore-normal streaking. Run-up and backwash rake foam into filaments that
 * point UP THE BEACH — along the shore normal — not downwind, which is what
 * every other foam lattice in this file is advected by. The lattice is
 * therefore stretched 4:1 along the shore normal (handed the along-shore axis,
 * because `waterCapillaryOctave` elongates ACROSS the axis it is given) and
 * offset by the swash excursion, so a filament visibly runs up and drains back
 * rather than translating along the beach.
 */
export const WATER_RUNUP_STREAK_CELLS_PER_METER = 0.17;
export const WATER_RUNUP_STREAK_STRETCH = 4;
export const WATER_RUNUP_STREAK_GAIN = 0.5;
export const WATER_RUNUP_STREAK_LATTICE_OFFSET = Object.freeze([37.1, 91.7] as const);
/** Streak fade window, in multiples of the streak lattice's own cell size. */
export const WATER_RUNUP_STREAK_FADE_LOW = 0.16;
export const WATER_RUNUP_STREAK_FADE_HIGH = 0.45;
/** Bore fade window, in multiples of the LOCAL shallow-water crest spacing. */
export const WATER_RUNUP_NYQUIST_FADE_LOW = 0.12;
export const WATER_RUNUP_NYQUIST_FADE_HIGH = 0.35;
/**
 * Wet-sand persistence, seconds.
 *
 * A fragment shader has no memory (6-1's lesson), so persistence is analytic:
 * the swash is periodic, so the time since the front last left a given level
 * is a closed-form function of the phase, and the darkening decays from it.
 * 15 s is the drain-and-evaporate time of the surface film on medium sand —
 * long enough against a 5-12 s swash period that the whole swash zone reads
 * wet with a gradient, short enough that the high-water mark stays a mark.
 */
export const WATER_RUNUP_DRYING_SECONDS = 15;
/**
 * Individual run-ups are Rayleigh distributed about the significant value, so
 * a few of every set reach past `R`. The wet band therefore does not end at
 * `R` — it tails out by 35%, which is what makes a high-water mark diffuse
 * instead of a drawn line.
 */
export const WATER_RUNUP_EXCEEDANCE = 1.35;
/** Softness of the swash front itself, in units of `R`. */
export const WATER_RUNUP_FRONT_SOFTNESS = 0.06;
/** Guards: a wavelength and a frequency the laws below can divide by. */
export const WATER_RUNUP_MINIMUM_WAVELENGTH_METERS = 0.25;
export const WATER_RUNUP_MINIMUM_RADIAN_FREQUENCY = 0.02;
/**
 * The run-up clock is wrapped, the same idiom (and the same 4096 s) as
 * `waterRippleDrift`: `omega * t` is the one place this term accumulates the
 * session clock, and a once-per-68-minute single-frame phase reseed is
 * invisible against surf while an unwrapped product is not.
 */
export const WATER_RUNUP_CLOCK_WRAP_SECONDS = 4096;
/**
 * Inland: the bank band this run-up rides. 0.76 is `shoreFoam`'s own ramp
 * start, deliberately — 6-2 GENERALISES that term on W-5's banks rather than
 * replacing it, and analytic worlds keep the pre-6-2 ramp untouched.
 */
export const WATER_RUNUP_BANK_LOW = 0.76;
export const WATER_RUNUP_BANK_STRENGTH = 0.34;
/**
 * Inland: the swash excursion at which a bank's run-up reaches full strength.
 *
 * Unlike the ocean's band — which is mean-preserving on purpose, because wave
 * R's shore foam is a pinned quantity — the inland bank term is ADDITIVE over
 * the analytic ramp, so it needs a driver-strength weight or a glassy pond
 * would foam like a lee shore. 1.5 m of excursion is where a shoreline starts
 * to read as lapping rather than as a rim: it leaves a 60 m pond at 1% of the
 * weight, a 20 km lake at 100%, a backwater reach at 15% and a torrent at 79%.
 */
export const WATER_RUNUP_BANK_EXCURSION_REFERENCE_METERS = 1.5;
/** Ocean sea-state clamps for the CPU twin, metres. */
export const WATER_OCEAN_SWELL_MINIMUM_WAVELENGTH_METERS = 1;
export const WATER_OCEAN_SWELL_MAXIMUM_WAVELENGTH_METERS = 600;

/** One swell train at a shoreline; see the WGSL twin. */
export interface WaterShoreSwell {
  readonly waveHeightMeters: number;
  readonly wavelengthMeters: number;
  /** The ONE temporal frequency in the whole run-up term — the phase lock. */
  readonly radianFrequency: number;
  /** Hunt's horizontal swash excursion, `sqrt(H L)`, metres. */
  readonly excursionMeters: number;
}

/**
 * TypeScript oracle for `WATER_SHORE_RUNUP_WGSL`, statement for statement.
 * `tests/gpu/water-shore-runup.test.ts` pins these against the shipped WGSL on
 * a real adapter; the Node suite sweeps the physics through them. Same split
 * as 6-4's caustic oracle and 6-1's flow oracle.
 */
export function waterShoreSwell(
  waveHeightMeters: number,
  wavelengthMeters: number,
  celerityMetersPerSecond: number,
): WaterShoreSwell {
  const wavelength = Math.max(wavelengthMeters, WATER_RUNUP_MINIMUM_WAVELENGTH_METERS);
  const height = Math.max(waveHeightMeters, 0);
  return {
    waveHeightMeters: height,
    wavelengthMeters: wavelength,
    radianFrequency: Math.max(
      (TWO_PI * Math.max(celerityMetersPerSecond, 0)) / wavelength,
      WATER_RUNUP_MINIMUM_RADIAN_FREQUENCY,
    ),
    excursionMeters: Math.sqrt(height * wavelength),
  };
}

/**
 * A spectral cascade read as a swell train. For a narrow band the mean square
 * slope summed over both components is `a² k²`, so `a = sqrt(mss)/k` — but the
 * stored moments are per-component second moments of a directional band, whose
 * sum for a sinusoid of amplitude `a` is `a² k² / 2 · 2 = a² k²`... written as
 * the sinusoid form the rest of this file uses: `a = sqrt(2 mss)/k` for the
 * one-component convention, hence `H = 2a = sqrt(2 mss) λ / π`. Deep-water
 * celerity, because every band the cascade set carries is deep-water anywhere
 * the ocean actually samples the spectrum.
 */
export function waterShoreBandSwell(
  wavelengthMeters: number,
  meanSquareSlope: number,
): WaterShoreSwell {
  const wavelength = Math.max(wavelengthMeters, WATER_RUNUP_MINIMUM_WAVELENGTH_METERS);
  const height = (Math.sqrt(2 * Math.max(meanSquareSlope, 0)) * wavelength) / Math.PI;
  return waterShoreSwell(
    height,
    wavelength,
    Math.sqrt((WATER_FLOW_GRAVITY * wavelength) / TWO_PI),
  );
}

/**
 * THE BINDING RULE, as one function: the run-up's phase must come from the
 * same cascade the visible swell comes from, or the surf beats out of time
 * with the waves arriving.
 *
 * "Dominant" is measured as VISIBLE AMPLITUDE, not visible slope. A band's
 * amplitude is `a = sqrt(2 mss) / k = sqrt(2 mss) λ / 2π`, and the cascade's
 * own texture fade is exactly how much of it this pixel can see, so the winner
 * is the argmax of `mss (λ fade)²` — the square roots and the 2π cancel out of
 * an argmax, which is why none are taken. Amplitude rather than slope matters
 * because slope is dominated by the shortest band at every wind speed while
 * run-up is driven by the longest one that is still visible; keying on slope
 * would beat the surf at the capillary rate.
 *
 * A cascade the profile does not run publishes wavelength 0, so it scores 0
 * and can never win — the rule needs no cascade-count test.
 */
export function waterDominantShoreSwell(
  wavelengths: readonly [number, number, number, number, number],
  meanSquareSlopes: readonly [number, number, number, number, number],
  fades: readonly [number, number, number, number, number],
): WaterShoreSwell {
  let bestWeight = -1;
  let bestWavelength = wavelengths[0];
  let bestMss = meanSquareSlopes[0];
  for (let lane = 0; lane < 5; lane += 1) {
    const visible = wavelengths[lane]! * fades[lane]!;
    const weight = meanSquareSlopes[lane]! * visible * visible;
    // Strictly greater, so ties go to the SHORTER band's index order exactly
    // as the shader's chain of comparisons does.
    if (lane === 0 || weight > bestWeight) {
      bestWeight = weight;
      bestWavelength = wavelengths[lane]!;
      bestMss = meanSquareSlopes[lane]!;
    }
  }
  return waterShoreBandSwell(bestWavelength!, bestMss!);
}

/**
 * The CPU twin of the sea state, from the SAME two fetch-limited growth laws
 * 6-1 uses for lake chop — this is what `SpectralOceanSystem.shoreRunupSwell()`
 * publishes for 6-5, which has no cascade textures to read.
 *
 * For the shipped config (12 m/s over 120 km of fetch) it returns Hs = 2.12 m
 * at a 77.5 m peak wavelength. Both numbers are checked against the rendered
 * spectrum rather than asserted: the fp16 harness measures the shipped
 * spectrum's Hs between 1 and 5 m, and 77.5 m falls inside cascade 2's
 * [32, 128] m band — i.e. inside the band the GPU's own dominant-cascade rule
 * selects. `render.webgpu-water-runup.test.ts` pins that agreement.
 */
export function waterOceanShoreSwell(
  windSpeedMetersPerSecond: number,
  fetchLengthMeters: number,
): WaterShoreSwell {
  const wind = Math.max(windSpeedMetersPerSecond, 0);
  const fetch = Math.max(fetchLengthMeters, 0);
  const waveHeightMeters = WATER_FETCH_SIGNIFICANT_HEIGHT_COEFFICIENT
    * wind * Math.sqrt(fetch / WATER_FLOW_GRAVITY);
  const wavelengthMeters = Math.min(
    WATER_OCEAN_SWELL_MAXIMUM_WAVELENGTH_METERS,
    Math.max(
      WATER_OCEAN_SWELL_MINIMUM_WAVELENGTH_METERS,
      WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT * Math.max(wind * fetch, 0.0001) ** (2 / 3),
    ),
  );
  return waterShoreSwell(
    waveHeightMeters,
    wavelengthMeters,
    Math.sqrt((WATER_FLOW_GRAVITY * wavelengthMeters) / TWO_PI),
  );
}

/**
 * Hunt (1959). The Iribarren number is `xi = tan(beta) / sqrt(H/L0)`, and
 * `R = xi H` on a plane beach, so `R = tan(beta) sqrt(H L0)` — the vertical
 * run-up is the beach slope times the horizontal excursion, and the excursion
 * itself is slope-independent. A 2 m sea at 78 m runs 12.5 m up the beach face
 * and 1.0 m up in elevation on a 1:12 slope.
 */
export function waterShoreRunupHeight(swell: WaterShoreSwell, beachSlope: number): number {
  return clampRange(
    beachSlope,
    WATER_RUNUP_BEACH_SLOPE_MINIMUM,
    WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  ) * swell.excursionMeters;
}

/** The wrapped session clock the phase runs on. */
export function waterRunupClock(time: number): number {
  return time - Math.floor(time / WATER_RUNUP_CLOCK_WRAP_SECONDS) * WATER_RUNUP_CLOCK_WRAP_SECONDS;
}

/** The shallow-water eikonal phase; see the section docblock for the derivation. */
export function waterShoreRunupPhase(
  depthMeters: number,
  beachSlope: number,
  radianFrequency: number,
  time: number,
): number {
  const slope = clampRange(
    beachSlope,
    WATER_RUNUP_BEACH_SLOPE_MINIMUM,
    WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  );
  const travelSeconds = (2 * Math.sqrt(Math.max(depthMeters, 0)))
    / (slope * Math.sqrt(WATER_FLOW_GRAVITY));
  return radianFrequency * (waterRunupClock(time) + travelSeconds);
}

/** The swash front's elevation as a fraction of `R`; zero for half the cycle. */
export function waterSwashFront(phase: number): number {
  return Math.max(Math.sin(phase), 0);
}

/** The mean-preserving bore modulation of a foam band. */
export function waterShoreBore(phase: number): number {
  return 1 + WATER_RUNUP_BORE_GAIN
    * (waterSwashFront(phase) ** WATER_RUNUP_BORE_SHARPNESS - WATER_RUNUP_BORE_MEAN);
}

/**
 * `6-5`'s WETNESS FIELD. Produced here (6-2), consumed there.
 *
 * WHY THE RUN-UP'S WET HALF IS TERRAIN-SIDE AT ALL. The ocean disk is a plane
 * at sea level, alpha-blended with depth write off — so on any beach ABOVE the
 * waterline the terrain fragment is nearer the camera and the disk is depth-
 * tested away. The water surface therefore physically cannot draw the sheet
 * that runs up the beach face, and wave R's shore band is written to rise from
 * zero AT the waterline for exactly that reason. Everything the run-up does
 * above the still-water line has to be a TERRAIN response, which is why 6-2
 * ends at a field definition rather than keeping a private term: the surf
 * below the waterline is 6-2's, the wet sand above it is 6-5's, and this
 * function is the seam between them.
 *
 * THE ARGUMENTS, and where 6-5 gets each:
 *  - `freeboardMeters` — ground elevation MINUS still-water level, positive
 *    above the waterline. The terrain fragment already forms exactly this:
 *    `terrainAbsolutePosition.y - uniforms.terrainSurfaceWetness.y`.
 *  - `swashHeightMeters` — `waterShoreRunupHeight(swell, beachSlope)`. The
 *    beach slope is the terrain's OWN surface gradient, which the terrain
 *    shader carries at full resolution; it must not be re-derived from
 *    bathymetry there.
 *  - `phase` — `waterShoreRunupPhase(-freeboard, beachSlope, omega, time)`
 *    above the waterline the still-water "depth" is negative, so the phase
 *    clamps to `omega * t` and the whole swash zone beats together, which is
 *    correct: a bore that has crossed the waterline is a single sheet.
 *  - `radianFrequency` — the swell's, from the vec4 the ocean system publishes
 *    (`SpectralOceanSystem.shoreRunupSwell()`), or from a lake's own chop.
 *
 * THE SHAPE. Normalise the height into the swash zone, `u = freeboard / R`.
 * The front is above `u` for the cycle window `[asin(u), pi - asin(u)]`, so
 * the elapsed dry time is zero inside that window and the time since its end
 * outside it — wrapping to the PREVIOUS cycle's end while the next uprush is
 * still climbing. The darkening decays exponentially from that age. The field
 * is continuous everywhere except the instant the uprush arrives, which is a
 * real discontinuity (dry sand darkens the moment water reaches it) and the
 * only one; `render.webgpu-water-runup.test.ts` measures that there is exactly
 * one per beat. Above `u = 1` the Rayleigh tail carries the field to zero by
 * `u = 1.35`, and the whole result is monotone non-increasing in `u` at every
 * instant — 6-5 gets a band, never a ring.
 *
 * RANGE. Exactly [0, 1]. 1 at or below still water, 0 for a glassy sea
 * (`R = 0`) and 0 above the exceedance limit — so an analytic world with no
 * published swell gets today's behaviour with no branch of its own.
 */
export function waterShoreWetness(
  freeboardMeters: number,
  swashHeightMeters: number,
  phase: number,
  radianFrequency: number,
): number {
  if (swashHeightMeters <= 0) return 0;
  if (freeboardMeters <= 0) return 1;
  const u = freeboardMeters / swashHeightMeters;
  const covered = smoothstepUnit(
    -WATER_RUNUP_FRONT_SOFTNESS,
    WATER_RUNUP_FRONT_SOFTNESS,
    waterSwashFront(phase) - u,
  );
  // The window the front spends above level u, in cycle fractions: it rises
  // through u at asin(u) and descends through it at pi - asin(u).
  const riseAngle = Math.asin(Math.min(u, 1));
  const startCycles = riseAngle / TWO_PI;
  const endCycles = (Math.PI - riseAngle) / TWO_PI;
  const cycle = fractUnit(phase / TWO_PI);
  // Zero while the level is covered, then the time since the front descended
  // through it — wrapping to the PREVIOUS cycle's descent while the next
  // uprush is still climbing. Written as a branch on the uprush rather than a
  // fract of (phase - endPhase) because the latter wraps exactly at the
  // descending crossing, where the field must be continuous.
  const dryCycles = cycle >= startCycles
    ? Math.max(cycle - endCycles, 0)
    : cycle + 1 - endCycles;
  const periodSeconds = TWO_PI / Math.max(radianFrequency, WATER_RUNUP_MINIMUM_RADIAN_FREQUENCY);
  const dried = Math.exp(-(dryCycles * periodSeconds) / WATER_RUNUP_DRYING_SECONDS);
  const exceedance = 1 - smoothstepUnit(1, WATER_RUNUP_EXCEEDANCE, u);
  return clamp01(Math.max(covered, dried) * exceedance);
}

function clampRange(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function fractUnit(value: number): number {
  return value - Math.floor(value);
}

/**
 * The shared run-up model, composed into BOTH water fragments and (from `6-5`)
 * into the terrain surface plugin. Self-contained pure arithmetic on purpose:
 * it declares no uniform, samples no texture, takes no derivative and calls
 * nothing outside itself, so it compiles standalone in the GPU parity test and
 * 6-5 can compose it into a shader that has never heard of the water noise
 * lattice.
 */
export const WATER_SHORE_RUNUP_WGSL = /* wgsl */ `
const WATER_RUNUP_PI: f32 = ${toWgslFloat(Math.PI)};
const WATER_RUNUP_TWO_PI: f32 = ${toWgslFloat(TWO_PI)};
const WATER_RUNUP_GRAVITY: f32 = ${toWgslFloat(WATER_FLOW_GRAVITY)};
const WATER_RUNUP_BEACH_SLOPE_MINIMUM: f32 = ${toWgslFloat(WATER_RUNUP_BEACH_SLOPE_MINIMUM)};
const WATER_RUNUP_BEACH_SLOPE_MAXIMUM: f32 = ${toWgslFloat(WATER_RUNUP_BEACH_SLOPE_MAXIMUM)};
const WATER_RUNUP_GRADIENT_STEP_METERS: f32 = ${toWgslFloat(WATER_RUNUP_GRADIENT_STEP_METERS)};
const WATER_RUNUP_DEPTH_FADE_START_METERS: f32 = ${toWgslFloat(WATER_RUNUP_DEPTH_FADE_START_METERS)};
const WATER_RUNUP_DEPTH_GATE_METERS: f32 = ${toWgslFloat(WATER_RUNUP_DEPTH_GATE_METERS)};
const WATER_RUNUP_STREAK_DEPTH_LOW_METERS: f32 = ${toWgslFloat(WATER_RUNUP_STREAK_DEPTH_LOW_METERS)};
const WATER_RUNUP_STREAK_DEPTH_HIGH_METERS: f32 = ${toWgslFloat(WATER_RUNUP_STREAK_DEPTH_HIGH_METERS)};
const WATER_RUNUP_BORE_SHARPNESS: f32 = ${toWgslFloat(WATER_RUNUP_BORE_SHARPNESS)};
const WATER_RUNUP_BORE_MEAN: f32 = ${toWgslFloat(WATER_RUNUP_BORE_MEAN)};
const WATER_RUNUP_BORE_GAIN: f32 = ${toWgslFloat(WATER_RUNUP_BORE_GAIN)};
const WATER_RUNUP_STREAK_CELLS_PER_METER: f32 = ${toWgslFloat(WATER_RUNUP_STREAK_CELLS_PER_METER)};
const WATER_RUNUP_STREAK_SCALE_METERS: f32 = ${toWgslFloat(1 / WATER_RUNUP_STREAK_CELLS_PER_METER)};
const WATER_RUNUP_STREAK_STRETCH: f32 = ${toWgslFloat(WATER_RUNUP_STREAK_STRETCH)};
const WATER_RUNUP_STREAK_GAIN: f32 = ${toWgslFloat(WATER_RUNUP_STREAK_GAIN)};
const WATER_RUNUP_STREAK_LATTICE_OFFSET = vec2f(${WATER_RUNUP_STREAK_LATTICE_OFFSET.map(toWgslFloat).join(", ")});
const WATER_RUNUP_STREAK_FADE_LOW: f32 = ${toWgslFloat(WATER_RUNUP_STREAK_FADE_LOW)};
const WATER_RUNUP_STREAK_FADE_HIGH: f32 = ${toWgslFloat(WATER_RUNUP_STREAK_FADE_HIGH)};
const WATER_RUNUP_NYQUIST_FADE_LOW: f32 = ${toWgslFloat(WATER_RUNUP_NYQUIST_FADE_LOW)};
const WATER_RUNUP_NYQUIST_FADE_HIGH: f32 = ${toWgslFloat(WATER_RUNUP_NYQUIST_FADE_HIGH)};
const WATER_RUNUP_DRYING_SECONDS: f32 = ${toWgslFloat(WATER_RUNUP_DRYING_SECONDS)};
const WATER_RUNUP_EXCEEDANCE: f32 = ${toWgslFloat(WATER_RUNUP_EXCEEDANCE)};
const WATER_RUNUP_FRONT_SOFTNESS: f32 = ${toWgslFloat(WATER_RUNUP_FRONT_SOFTNESS)};
const WATER_RUNUP_MINIMUM_WAVELENGTH: f32 = ${toWgslFloat(WATER_RUNUP_MINIMUM_WAVELENGTH_METERS)};
const WATER_RUNUP_MINIMUM_RADIAN_FREQUENCY: f32 = ${toWgslFloat(WATER_RUNUP_MINIMUM_RADIAN_FREQUENCY)};
const WATER_RUNUP_CLOCK_WRAP_SECONDS: f32 = ${toWgslFloat(WATER_RUNUP_CLOCK_WRAP_SECONDS)};
const WATER_RUNUP_BANK_LOW: f32 = ${toWgslFloat(WATER_RUNUP_BANK_LOW)};
const WATER_RUNUP_BANK_STRENGTH: f32 = ${toWgslFloat(WATER_RUNUP_BANK_STRENGTH)};
const WATER_RUNUP_BANK_EXCURSION_REFERENCE: f32 = ${toWgslFloat(WATER_RUNUP_BANK_EXCURSION_REFERENCE_METERS)};

struct WaterShoreSwell {
  waveHeightMeters: f32,
  wavelengthMeters: f32,
  radianFrequency: f32,
  excursionMeters: f32,
}

// The ONE temporal frequency in the term is built here, from a celerity the
// caller supplies: deep-water for an ocean band, the chop's own phase speed
// for a lake, the surface velocity for a river's boil train.
fn waterShoreSwell(waveHeightMeters: f32, wavelengthMeters: f32, celerity: f32) -> WaterShoreSwell {
  let wavelength = max(wavelengthMeters, WATER_RUNUP_MINIMUM_WAVELENGTH);
  let height = max(waveHeightMeters, 0.0);
  return WaterShoreSwell(
    height,
    wavelength,
    max(
      WATER_RUNUP_TWO_PI * max(celerity, 0.0) / wavelength,
      WATER_RUNUP_MINIMUM_RADIAN_FREQUENCY,
    ),
    sqrt(height * wavelength),
  );
}

// A spectral cascade read as a swell train: a = sqrt(2 mss)/k, H = 2a.
fn waterShoreBandSwell(wavelengthMeters: f32, meanSquareSlope: f32) -> WaterShoreSwell {
  let wavelength = max(wavelengthMeters, WATER_RUNUP_MINIMUM_WAVELENGTH);
  let height = sqrt(2.0 * max(meanSquareSlope, 0.0)) * wavelength / WATER_RUNUP_PI;
  return waterShoreSwell(
    height,
    wavelength,
    sqrt(WATER_RUNUP_GRAVITY * wavelength / WATER_RUNUP_TWO_PI),
  );
}

// THE BINDING RULE, as one function. The winner is the argmax of the band's
// VISIBLE AMPLITUDE squared, mss (lambda fade)^2 — amplitude and not slope,
// because slope is dominated by the shortest band at every wind speed while
// run-up is driven by the longest one still visible. A cascade the profile
// does not run publishes wavelength 0 and can never win.
fn waterDominantShoreSwell(
  wavelengths0: vec4f,
  wavelength4: f32,
  meanSquareSlopes0: vec4f,
  meanSquareSlope4: f32,
  fades0: vec4f,
  fade4: f32,
) -> WaterShoreSwell {
  let visible0 = wavelengths0 * fades0;
  let weights0 = meanSquareSlopes0 * visible0 * visible0;
  let visible4 = wavelength4 * fade4;
  let weight4 = meanSquareSlope4 * visible4 * visible4;
  var bestWeight = weights0.x;
  var bestWavelength = wavelengths0.x;
  var bestMss = meanSquareSlopes0.x;
  if (weights0.y > bestWeight) {
    bestWeight = weights0.y;
    bestWavelength = wavelengths0.y;
    bestMss = meanSquareSlopes0.y;
  }
  if (weights0.z > bestWeight) {
    bestWeight = weights0.z;
    bestWavelength = wavelengths0.z;
    bestMss = meanSquareSlopes0.z;
  }
  if (weights0.w > bestWeight) {
    bestWeight = weights0.w;
    bestWavelength = wavelengths0.w;
    bestMss = meanSquareSlopes0.w;
  }
  if (weight4 > bestWeight) {
    bestWeight = weight4;
    bestWavelength = wavelength4;
    bestMss = meanSquareSlope4;
  }
  return waterShoreBandSwell(bestWavelength, bestMss);
}

// Hunt: R = tan(beta) sqrt(H L0). The excursion is slope-free; the slope only
// converts it to an elevation.
fn waterShoreRunupHeight(swell: WaterShoreSwell, beachSlope: f32) -> f32 {
  return clamp(beachSlope, WATER_RUNUP_BEACH_SLOPE_MINIMUM, WATER_RUNUP_BEACH_SLOPE_MAXIMUM)
    * swell.excursionMeters;
}

// The wrapped session clock — the one place this term accumulates it.
fn waterRunupClock(time: f32) -> f32 {
  return time - floor(time / WATER_RUNUP_CLOCK_WRAP_SECONDS) * WATER_RUNUP_CLOCK_WRAP_SECONDS;
}

// The shallow-water eikonal on a plane beach. Its spatial gradient is exactly
// omega/sqrt(g h) — the correct local wavenumber — and it is a function of the
// DEPTH this fragment already sampled, so it cannot print the bathymetry grid.
fn waterShoreRunupPhase(
  depthMeters: f32,
  beachSlope: f32,
  radianFrequency: f32,
  time: f32,
) -> f32 {
  let slope = clamp(beachSlope, WATER_RUNUP_BEACH_SLOPE_MINIMUM, WATER_RUNUP_BEACH_SLOPE_MAXIMUM);
  let travelSeconds = 2.0 * sqrt(max(depthMeters, 0.0)) / (slope * sqrt(WATER_RUNUP_GRAVITY));
  return radianFrequency * (waterRunupClock(time) + travelSeconds);
}

// The swash front's elevation as a fraction of R. Above still water for half
// the cycle; the beach face drains for the other half.
fn waterSwashFront(phase: f32) -> f32 {
  return max(sin(phase), 0.0);
}

// A mean-preserving bore: sharp front, long back, unit cycle mean.
fn waterShoreBore(phase: f32) -> f32 {
  return 1.0 + WATER_RUNUP_BORE_GAIN
    * (pow(waterSwashFront(phase), WATER_RUNUP_BORE_SHARPNESS) - WATER_RUNUP_BORE_MEAN);
}

// Mean-preserving shore-normal streaking from a mean-0.5 lattice value.
fn waterShoreStreak(latticeValue: f32, weight: f32) -> f32 {
  return 1.0 + WATER_RUNUP_STREAK_GAIN * (2.0 * latticeValue - 1.0) * weight;
}

// 6-5's WETNESS FIELD. Produced here, consumed by the terrain surface plugin;
// see the TypeScript twin for the argument contract. Exactly [0, 1], 1 at or
// below still water, 0 for a glassy sea.
fn waterShoreWetness(
  freeboardMeters: f32,
  swashHeightMeters: f32,
  phase: f32,
  radianFrequency: f32,
) -> f32 {
  if (swashHeightMeters <= 0.0) { return 0.0; }
  if (freeboardMeters <= 0.0) { return 1.0; }
  let u = freeboardMeters / swashHeightMeters;
  let covered = smoothstep(
    -WATER_RUNUP_FRONT_SOFTNESS,
    WATER_RUNUP_FRONT_SOFTNESS,
    waterSwashFront(phase) - u,
  );
  // The window the front spends above level u, in cycle fractions: it rises
  // through u at asin(u) and descends through it at pi - asin(u).
  let riseAngle = asin(min(u, 1.0));
  let startCycles = riseAngle / WATER_RUNUP_TWO_PI;
  let endCycles = (WATER_RUNUP_PI - riseAngle) / WATER_RUNUP_TWO_PI;
  let cycle = fract(phase / WATER_RUNUP_TWO_PI);
  // Zero while the level is covered, then the time since the front descended
  // through it, wrapping to the previous cycle's descent while the next
  // uprush is still climbing. A fract of (phase - endPhase) would wrap exactly
  // AT the descending crossing, which is where the field has to be continuous.
  let dryCycles = select(
    cycle + 1.0 - endCycles,
    max(cycle - endCycles, 0.0),
    cycle >= startCycles,
  );
  let periodSeconds = WATER_RUNUP_TWO_PI
    / max(radianFrequency, WATER_RUNUP_MINIMUM_RADIAN_FREQUENCY);
  let dried = exp(-(dryCycles * periodSeconds) / WATER_RUNUP_DRYING_SECONDS);
  let exceedance = 1.0 - smoothstep(1.0, WATER_RUNUP_EXCEEDANCE, u);
  return clamp(max(covered, dried) * exceedance, 0.0, 1.0);
}`;

/**
 * `6-2`: the open-coast streak lattice, split out of the block above because
 * it is the one part of the run-up that needs `WATER_DETAIL_NOISE_WGSL` — and
 * the block above has to stay self-contained so `6-5` can compose it into a
 * terrain shader that has never heard of the water lattice.
 *
 * Ocean-only, the same way `WATER_CREST_SSS_WGSL` is: a river or lake BANK
 * rides a net current, so its streaks advect on 6-1's dual phase
 * (`waterFlowOctaveValue`) rather than on a bounded swash offset. One
 * definition each, neither duplicated.
 *
 * ORIENTATION. `waterCapillaryOctave` elongates ACROSS the axis it is given,
 * so the axis handed in is the ALONG-shore tangent and the filaments run along
 * the shore NORMAL — up and down the beach face, which is the direction swash
 * and backwash actually rake foam, and deliberately not the wind direction
 * every other foam lattice in this file is advected by. The offset is likewise
 * along the normal, so a filament visibly runs up and drains back instead of
 * translating along the beach.
 */
export const WATER_SHORE_STREAK_WGSL = /* wgsl */ `
fn waterShoreStreakLattice(
  worldXZ: vec2f,
  shoreNormal: vec2f,
  swashOffsetMeters: f32,
) -> f32 {
  let alongShore = vec2f(-shoreNormal.y, shoreNormal.x);
  return waterCapillaryOctave(
    worldXZ,
    shoreNormal * swashOffsetMeters,
    alongShore,
    WATER_RUNUP_STREAK_CELLS_PER_METER,
    WATER_RUNUP_STREAK_STRETCH,
    WATER_RUNUP_STREAK_LATTICE_OFFSET,
  ).z;
}`;

/*
 * ===========================================================================
 * `6-3` — shallow-water dispersion: shelf SHOALING and DEPTH-LIMITED BREAKING.
 * The constants, the TypeScript oracle and the shared WGSL block, in that
 * order, from ONE set of numbers, exactly as 6-2 above.
 *
 * WHAT THE SHELF DOES TO A WAVE TRAIN, in one paragraph. A swell generated in
 * deep water arrives at a coast carrying an energy flux `E c_g`. Crossing onto
 * the shelf its celerity falls (`c = omega/k` with `k` from the full linear
 * relation `omega^2 = g k tanh(k h)`) and its group speed falls FASTER — from
 * `c/2` in deep water to `c` in shallow — so conserving the flux forces the
 * height up: `H/H0 = sqrt(c_g0/c_g)`, whose shallow limit is Green's law
 * `H ~ h^(-1/4)`. Meanwhile `k` rises, so the train also SHORTENS. Height up
 * and length down is steepening, and it happens well before anything breaks.
 * Then the depth limit bites: a wave cannot stand taller than roughly
 * `H/h = 0.78` over its own water column (McCowan's solitary-wave limit), and
 * past that it breaks and the excess becomes whitewater.
 *
 * WHY THE DISPERSION IS SOLVED RATHER THAN APPROXIMATED IN THE SHALLOW LIMIT.
 * At the plan's binding 60 m gate the shipped 64 m swell is still essentially
 * deep-water (`k0 h = 5.9`), while a 256 m swell is already transitional
 * (`k0 h = 1.5`) — Green's law alone would be wrong by tens of percent at the
 * gate and would miss the shoaling DIP entirely (the full coefficient falls to
 * 0.913 near `k0 h = 1.2` before it rises, which is why a swell visibly
 * flattens once before it stacks up). So `y tanh(y) = k0 h` is solved: Eckart's
 * 1952 explicit seed `y0 = x/sqrt(tanh x)` — exact in both limits, ~5% in the
 * middle — plus ONE Newton step, which drives the residual under 1e-3
 * relative everywhere. The plan's pin ("dispersion-relation spot checks vs
 * `tanh(k*depth)`") is measured directly against that residual.
 *
 * THE ONE ALGEBRAIC SIMPLIFICATION WORTH NAMING. Because a band's deep-water
 * frequency satisfies `omega^2 = g k0`, the dispersion argument `omega^2 h/g`
 * IS `k0 h`, and the shoaling coefficient collapses to a pure function of it:
 *   `Ks^2 = c_g0/c_g = (g/(2 omega)) / (n c) = kh / (2 n k0h)`.
 * No frequency, no period, no celerity is ever formed. Likewise
 * `n = 0.5 (1 + 2kh/sinh 2kh)` is rewritten through `t = tanh(kh)` as
 * `0.5 (1 + kh (1 - t^2)/t)` — algebraically identical, and it cannot overflow
 * at the `kh = 1500` the finest cascade reaches at 60 m, where a literal
 * `sinh(2 kh)` is `inf` and the ratio is `NaN`.
 *
 * FRAGMENT-SIDE, DELIBERATELY. Shoaling SHORTENS wavelengths, which is exactly
 * the band the mesh-Nyquist fade (wave R fix 4) refuses to carry: a lattice
 * that cannot draw a 64 m wave certainly cannot draw the 20 m wave it becomes
 * at 1 m of depth. The plan's instruction is to shade rather than fight it, so
 * nothing here touches displacement, a varying, or the vertex stage — the
 * ocean VERTEX hash is deliberately unchanged, the same evidence 6-2 left. The
 * shortened crest spacing is nonetheless VISIBLE, because 6-2's eikonal bore
 * phase already has gradient `omega/sqrt(g h)`, which is the shallow limit of
 * the very `k(h)` solved here — the two items draw the same shortening from
 * the same relation, one as foam bands and one as surface slope.
 *
 * HOW 6-3 AND 6-2 ARE KEPT CONSISTENT ABOUT THE SAME WAVE. Three couplings,
 * all structural rather than tuned:
 *   (a) ONE swell. The band heights are `waterShoreBandSwell`'s — 6-2's law,
 *       called, not re-derived — and the aggregation weight is 6-2's own
 *       visible-amplitude-squared `mss (lambda fade)^2`, the identical
 *       expression `waterDominantShoreSwell` takes the argmax of. 6-2 asks
 *       which band wins; 6-3 asks how much of the same weighted energy is
 *       breaking.
 *   (b) ONE beach slope. The breaker index clamps `tan(beta)` to the SAME
 *       `WATER_RUNUP_BEACH_SLOPE_*` range Hunt's law is regressed on, from the
 *       same `waterBathymetryBedSlope` 3-tap the run-up uses.
 *   (c) 6-2's SURF IS GATED BY 6-3's BREAKING. The bore modulation and the
 *       swash streaks are both multiplied by the breaking fraction, so a wave
 *       6-3 says is unbroken at 3 m of depth CANNOT be drawn as a bore there.
 *       Both factors are mean-preserving for any weight — `mix(1, bore, w)`
 *       has cycle mean 1 for every `w` because `bore` does — so gating them
 *       leaves 6-2's pinned time-averaged foam coverage exactly where it was.
 * ===========================================================================
 */

/**
 * The plan's binding gate: shoaling runs only where `depth < 60 m`, always
 * inside the finely-tessellated inner rings. The fade below it exists because
 * the coefficient is NOT 1 at the gate for the longest bands (0.93 for a 256 m
 * swell at 60 m), so a hard edge would step; over 12 m of depth on any real
 * shelf that is hundreds of metres of horizontal distance.
 */
export const WATER_SHOAL_DEPTH_FADE_START_METERS = 48;
export const WATER_SHOAL_DEPTH_GATE_METERS = 60;
/**
 * Floors for the two divisions the dispersion solve makes. `k0 h` floors the
 * Newton denominator and the `Ks^2` denominator; `tanh(kh)` floors the group
 * ratio's. At the smallest admitted `k0 h` the corresponding `tanh(kh)` is
 * ~0.01, a hundredfold above its own floor, so neither is ever the binding
 * constraint in practice — they exist so a degenerate uniform cannot make NaN.
 */
export const WATER_SHOAL_MINIMUM_RELATIVE_DEPTH = 0.0001;
export const WATER_SHOAL_MINIMUM_TANH = 0.0001;
/**
 * Ceiling on every `tanh` argument, and it is NOT cosmetic — this is a real
 * hardware defect the GPU parity test caught on its first run.
 *
 * WGSL's `tanh` is commonly lowered to `(e^(2x) - 1)/(e^(2x) + 1)`, which
 * overflows f32 for `x > 44` and returns `inf/inf = NaN`. The finest cascade's
 * relative depth passes 44 at 14 m of depth — well inside the 60 m gate — so
 * the shipped shader produced a NaN slope gain over most of the shelf, and
 * `min(NaN, WATER_SHOAL_MAXIMUM_SLOPE_GAIN)` silently returned the GUARD:
 * every short band got a 6x slope gain instead of the 1.0 it should have had.
 * It was invisible to the oracle, which runs f64 `Math.tanh`, and it was
 * caught only because the GPU test compares them on real hardware.
 *
 * 20 is the fix and it is EXACT where it binds, in BOTH precisions:
 * `tanh(20) = 1 - 8.6e-18` rounds to exactly 1.0 in f64 as well as f32, so
 * clamping changes no representable value in either language and the oracle
 * and the shader agree bit-for-bit in the deep-water limit rather than
 * approximately. It also sits comfortably under both known lowerings' overflow
 * points — 44 for the `e^(2x)` form and 89 for `sinh/cosh` — with 2.2x margin
 * on the tighter one.
 */
export const WATER_SHOAL_MAXIMUM_TANH_ARGUMENT = 20;
/**
 * The breaker index `gamma = H_b/h_b`, as a power law in the deep-water
 * Iribarren number `xi0 = tan(beta)/sqrt(H0/L0)`.
 *
 * McCowan's (1894) solitary-wave limit 0.78 is the ANCHOR, placed at `xi0 = 1`
 * — the spilling/plunging boundary, which is where the solitary-wave
 * idealisation is closest to true. The exponent is in the Kaminsky-Kraus
 * (1993) family (`gamma = 1.12 xi0^0.21` from their regression), lowered to
 * 0.17 so that the whole reachable slope range lands inside the envelope with
 * only the flattest beaches on the floor.
 *
 * Measured, against the shipped 2 m / 64 m sea (`H0/L0 = 0.0285`): a 1:17 sand
 * beach gives 0.654 (spilling, a wide dissipative surf zone), a 1:10 gives
 * 0.714, and a 1:5 shingle face gives 0.803 (reflective, plunging, breaking
 * close in). The MINIMUM clamp binds below `tan(beta) = 0.036` and that is
 * deliberate rather than incidental: on a 1:100 dissipative flat the power law
 * would run to 0.45, well under the modern envelope, and 0.6 is where the
 * measured indices actually saturate. The MAXIMUM is not reached at all — 6-2's
 * own `WATER_RUNUP_BEACH_SLOPE_MAXIMUM` of 0.35 caps the index at 0.883 first
 * — so it is a pure guard.
 *
 * Monotone non-decreasing in slope, which is the property the tests pin: a
 * steeper beach must break its waves higher and nearer, never the reverse.
 */
export const WATER_SHOAL_BREAKER_INDEX_REFERENCE = 0.78;
export const WATER_SHOAL_BREAKER_INDEX_EXPONENT = 0.17;
export const WATER_SHOAL_BREAKER_INDEX_MINIMUM = 0.6;
export const WATER_SHOAL_BREAKER_INDEX_MAXIMUM = 0.9;
/** Steepness floor for the Iribarren number — a glassy sea has no steepness. */
export const WATER_SHOAL_MINIMUM_STEEPNESS = 0.0002;
/**
 * Numerical guard on the surface-slope gain.
 *
 * The gain is 1 in deep water and driven to 0 at the waterline by the breaking
 * clip, and in between it peaks where the depth limit first bites, `h ~ H0/gamma`.
 * Substituting the shallow-water `k` there gives a closed-form peak of
 * `sqrt(gamma lambda / (2 pi H0))`, and with the band height `H0 = sqrt(2 mss) lambda/pi`
 * the wavelength cancels: the peak is `sqrt(gamma / (2 sqrt(2 mss)))`. So the
 * gain grows without limit as a band's ENERGY falls — a glassy 1024 m swell
 * would shoal 27-fold before anything clipped it. What it multiplies falls
 * faster: that band's slope CONTRIBUTION is `sqrt(gamma sqrt(2 mss)/2)`, which
 * goes to zero with it. The term is therefore self-limiting where it matters,
 * and 6.0 exists only so an empty band cannot amplify spectral noise into a
 * mirror-finish spike. The shipped sea's real peaks are 1.63 (the 64 m swell,
 * at 3 m of depth) and 4.31 (the 256 m swell, at 2.2 m); nothing carrying
 * visible slope reaches the guard.
 */
export const WATER_SHOAL_MAXIMUM_SLOPE_GAIN = 6;
/**
 * Whitewater coverage at full depth-limited breaking, as a foam fraction.
 *
 * This is the ONE art constant in 6-3 and it is deliberately the only one: the
 * breaking FRACTION is physics, and this converts it into the coverage the
 * existing foam composite consumes. 0.7 puts a fully-broken inner surf zone at
 * `0.7 * 1.18 = 0.83` before wave R's Worley break-up and the `mix(0.35, 1)`
 * drift mask, i.e. white but not paint.
 */
export const WATER_SHOAL_WHITEWATER_COVERAGE = 0.7;

/** The linear dispersion relation, solved at one relative depth. */
export interface WaterLinearDispersion {
  /** `k(h) h`, the root of `y tanh(y) = k0 h`. */
  readonly relativeDepth: number;
  /** `tanh(k h)` at that root — carried so nothing recomputes it. */
  readonly tanhRelativeDepth: number;
  /** `n = c_g/c`, from 1 in shallow water to 1/2 in deep. */
  readonly groupSpeedRatio: number;
}

/** What the shelf does to one spectral band at one depth. */
export interface WaterShoalingBand {
  /** `gamma = H_b/h_b` for this band on this beach. */
  readonly breakerIndex: number;
  /** `k(h)/k0` — above 1 everywhere, the SHORTENING. */
  readonly wavenumberGain: number;
  /** `Ks = sqrt(c_g0/c_g)` — the unbroken shoaling coefficient. */
  readonly shoalingCoefficient: number;
  /** The fraction of the band's energy the depth limit removes, `[0, 1]`. */
  readonly whitewater: number;
  /** `Ks sqrt(1 - Q)` — the height the band actually keeps. */
  readonly heightGain: number;
  /** `heightGain * wavenumberGain` — the SLOPE gain, which is what shades. */
  readonly slopeGain: number;
}

/** The shelf's whole effect at one fragment, summed over the cascade set. */
export interface WaterShelfShoaling {
  /** Added to the fade-weighted cascade slope sum. */
  readonly slopeDelta: readonly [number, number];
  /** Visible-energy-weighted breaking fraction — the whitewater, `[0, 1]`. */
  readonly whitewater: number;
  /** The weight the whitewater was normalised by; 0 for a glassy sea. */
  readonly weight: number;
}

/**
 * TypeScript oracle for `WATER_SHOALING_WGSL`, statement for statement.
 * `tests/gpu/water-shelf-shoaling.test.ts` pins these against the shipped WGSL
 * on a real adapter; the Node suite sweeps the physics through them. Same
 * split as 6-2's run-up oracle, 6-4's caustic oracle and 6-1's flow oracle.
 */
export function waterShoalDepthGate(depthMeters: number): number {
  return 1 - smoothstepUnit(
    WATER_SHOAL_DEPTH_FADE_START_METERS,
    WATER_SHOAL_DEPTH_GATE_METERS,
    depthMeters,
  );
}

/**
 * Solve `y tanh(y) = k0 h` for `y = k(h) h`.
 *
 * Eckart (1952) gives the explicit seed `y0 = x/sqrt(tanh x)`, which is exact
 * in both limits and off by at most ~5% around `x = 1`; one Newton step on
 * `f(y) = y tanh(y) - x` (whose derivative `tanh y + y sech^2 y` is positive
 * for every `y > 0`, so the step can never divide by zero) takes that to
 * ~1e-4. `tanh` at the corrected root is then obtained by ONE linearisation
 * rather than a third `tanh` call: the step is under 5% of `y`, so the
 * first-order update is accurate to `O(step^2)` — measured at 1e-3 relative,
 * which is below the 1e-2 the group ratio needs.
 */
export function waterLinearDispersion(relativeDeepDepth: number): WaterLinearDispersion {
  const x = Math.max(relativeDeepDepth, WATER_SHOAL_MINIMUM_RELATIVE_DEPTH);
  // Both `tanh` arguments are capped — see WATER_SHOAL_MAXIMUM_TANH_ARGUMENT
  // for the hardware defect this exists to avoid. The cap is exact in f32.
  const seedTanh = Math.max(
    Math.tanh(Math.min(x, WATER_SHOAL_MAXIMUM_TANH_ARGUMENT)),
    WATER_SHOAL_MINIMUM_TANH,
  );
  const seed = x / Math.sqrt(seedTanh);
  const seedTanhAtSeed = Math.tanh(Math.min(seed, WATER_SHOAL_MAXIMUM_TANH_ARGUMENT));
  const residual = seed * seedTanhAtSeed - x;
  const derivative = seedTanhAtSeed + seed * (1 - seedTanhAtSeed * seedTanhAtSeed);
  const relativeDepth = seed - residual / derivative;
  const tanhRelativeDepth = clampRange(
    seedTanhAtSeed + (1 - seedTanhAtSeed * seedTanhAtSeed) * (relativeDepth - seed),
    WATER_SHOAL_MINIMUM_TANH,
    1,
  );
  // n = 0.5 (1 + 2y/sinh 2y), through tanh so it cannot overflow:
  // sinh(2y) = 2t/(1 - t^2), hence 2y/sinh(2y) = y (1 - t^2)/t. Deep water
  // drives t to exactly 1 in f32 and the term to exactly 0, which is the
  // correct limit rather than a NaN.
  const groupSpeedRatio = clampRange(
    0.5 * (1 + (relativeDepth * (1 - tanhRelativeDepth * tanhRelativeDepth)) / tanhRelativeDepth),
    0.5,
    1,
  );
  return { relativeDepth, tanhRelativeDepth, groupSpeedRatio };
}

/**
 * Green's law with the full shoaling coefficient. Energy flux `E c_g` is
 * conserved, so `H/H0 = sqrt(c_g0/c_g)`; with `omega^2 = g k0` the deep-water
 * group speed is `g/(2 omega)` and the whole ratio reduces to `kh/(2 n k0h)`.
 * Exactly 1 in deep water, `~h^(-1/4)` in shallow, with the real dip to 0.913
 * near `k0 h = 1.2` in between.
 */
export function waterShoalingCoefficient(
  dispersion: WaterLinearDispersion,
  relativeDeepDepth: number,
): number {
  return Math.sqrt(dispersion.relativeDepth / (2 * dispersion.groupSpeedRatio
    * Math.max(relativeDeepDepth, WATER_SHOAL_MINIMUM_RELATIVE_DEPTH)));
}

/**
 * The breaker index, from the beach slope and the wave's own deep-water
 * steepness through the Iribarren (surf-similarity) number. See the constants'
 * docblock for the anchor and the exponent; the slope clamps are 6-2's, which
 * is the whole point — one beach-slope range, used by Hunt's run-up and by the
 * breaker index alike.
 */
export function waterBreakerIndex(beachSlope: number, deepWaterSteepness: number): number {
  const iribarren = clampRange(
    beachSlope,
    WATER_RUNUP_BEACH_SLOPE_MINIMUM,
    WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  ) / Math.sqrt(Math.max(deepWaterSteepness, WATER_SHOAL_MINIMUM_STEEPNESS));
  return clampRange(
    WATER_SHOAL_BREAKER_INDEX_REFERENCE * iribarren ** WATER_SHOAL_BREAKER_INDEX_EXPONENT,
    WATER_SHOAL_BREAKER_INDEX_MINIMUM,
    WATER_SHOAL_BREAKER_INDEX_MAXIMUM,
  );
}

/**
 * Depth-limited breaking, as the CLIPPED RAYLEIGH sea it physically is.
 *
 * A single wave cannot exceed `H = gamma h`. A real sea is not a single wave:
 * heights are Rayleigh distributed about the band's characteristic height, so
 * the fraction of individual waves that exceed the limit is
 * `Q = exp(-(gamma h/H)^2)` and the clipped second moment gives the surviving
 * characteristic height exactly, `H sqrt(1 - Q)`.
 *
 * Three properties, all of them the reason this form was chosen over a `min`:
 *  - THE CAP IS EXACT. `1 - e^(-R^2) <= R^2` for every `R`, so the surviving
 *    height never exceeds `gamma h` — the depth limit is enforced identically,
 *    not approximately, and it is approached from below as `h -> 0`.
 *  - IT IS SMOOTH. A hard `min(H, gamma h)` draws the break point as a line
 *    across the sea; a random sea starts breaking as scattered crests and
 *    becomes continuous whitewater shoreward, which is what this produces.
 *  - `Q` IS THE WHITEWATER, for free and by definition: the share of the
 *    band's energy the depth limit removes has to go somewhere, and it goes
 *    into foam. No second law, no tuned onset.
 *
 * A band with no height (an absent cascade, or a glassy sea) breaks nothing
 * and keeps ALL of its zero height — gain 1, not 0 — so the slope gain of an
 * unrun cascade is the identity rather than a silent erasure.
 */
export function waterDepthLimitedBreaking(
  shoaledHeightMeters: number,
  depthMeters: number,
  breakerIndex: number,
): { readonly whitewater: number; readonly heightGain: number } {
  if (shoaledHeightMeters <= 0) return { whitewater: 0, heightGain: 1 };
  const ratio = (breakerIndex * Math.max(depthMeters, 0)) / shoaledHeightMeters;
  const whitewater = Math.exp(-ratio * ratio);
  return { whitewater, heightGain: Math.sqrt(Math.max(1 - whitewater, 0)) };
}

/**
 * One spectral band, shoaled and broken. The swell descriptor is 6-2's — this
 * takes `WaterShoreSwell` rather than a wavelength and a mean-square slope
 * precisely so the height law cannot drift between the two items.
 */
export function waterShoalingBand(
  swell: WaterShoreSwell,
  depthMeters: number,
  beachSlope: number,
): WaterShoalingBand {
  const wavelength = Math.max(swell.wavelengthMeters, WATER_RUNUP_MINIMUM_WAVELENGTH_METERS);
  // k0 h, and it is the ONLY argument the dispersion needs: omega^2 = g k0 in
  // deep water makes the relation's own omega^2 h/g exactly this number.
  const relativeDeepDepth = (TWO_PI * Math.max(depthMeters, 0)) / wavelength;
  const dispersion = waterLinearDispersion(relativeDeepDepth);
  const shoalingCoefficient = waterShoalingCoefficient(dispersion, relativeDeepDepth);
  const wavenumberGain = dispersion.relativeDepth
    / Math.max(relativeDeepDepth, WATER_SHOAL_MINIMUM_RELATIVE_DEPTH);
  const breakerIndex = waterBreakerIndex(beachSlope, swell.waveHeightMeters / wavelength);
  const breaking = waterDepthLimitedBreaking(
    swell.waveHeightMeters * shoalingCoefficient,
    depthMeters,
    breakerIndex,
  );
  const heightGain = shoalingCoefficient * breaking.heightGain;
  return {
    breakerIndex,
    wavenumberGain,
    shoalingCoefficient,
    whitewater: breaking.whitewater,
    heightGain,
    // Slope is amplitude times wavenumber, so the SLOPE gain is the product of
    // the two — and it is the only one of the three that shades anything,
    // because a fragment cannot move a crest but can absolutely tilt one.
    slopeGain: Math.min(heightGain * wavenumberGain, WATER_SHOAL_MAXIMUM_SLOPE_GAIN),
  };
}

/** The zero accumulator; every lane folds into it. */
export const WATER_SHELF_SHOALING_ZERO: WaterShelfShoaling = Object.freeze({
  slopeDelta: Object.freeze([0, 0] as const),
  whitewater: 0,
  weight: 0,
});

/**
 * Fold one cascade into the shelf accumulator.
 *
 * The weight is `mss (lambda fade)^2` — 6-2's visible-amplitude-squared,
 * character for character the expression `waterDominantShoreSwell` takes the
 * argmax of. That is the consistency: 6-2 asks which band wins, 6-3 asks what
 * share of the same weighted energy is breaking, and neither can drift from
 * the other's idea of what this pixel can see.
 */
export function waterShoalingAccumulate(
  accumulated: WaterShelfShoaling,
  wavelengthMeters: number,
  meanSquareSlope: number,
  fade: number,
  bandSlope: readonly [number, number],
  depthMeters: number,
  beachSlope: number,
): WaterShelfShoaling {
  const band = waterShoalingBand(
    waterShoreBandSwell(wavelengthMeters, meanSquareSlope),
    depthMeters,
    beachSlope,
  );
  const visible = wavelengthMeters * fade;
  const weight = meanSquareSlope * visible * visible;
  return {
    slopeDelta: [
      accumulated.slopeDelta[0] + (band.slopeGain - 1) * bandSlope[0],
      accumulated.slopeDelta[1] + (band.slopeGain - 1) * bandSlope[1],
    ],
    whitewater: accumulated.whitewater + weight * band.whitewater,
    weight: accumulated.weight + weight,
  };
}

/**
 * The whole shelf response at one fragment: the slope delta the geometric
 * normal takes, and the whitewater the foam composite takes. Both are faded
 * out by the 60 m gate, so open water is untouched by construction.
 */
export function waterShelfShoaling(
  wavelengths: readonly [number, number, number, number, number],
  meanSquareSlopes: readonly [number, number, number, number, number],
  fades: readonly [number, number, number, number, number],
  cascadeSlopes: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ],
  depthMeters: number,
  beachSlope: number,
): WaterShelfShoaling {
  let accumulated = WATER_SHELF_SHOALING_ZERO;
  for (let lane = 0; lane < 5; lane += 1) {
    accumulated = waterShoalingAccumulate(
      accumulated,
      wavelengths[lane]!,
      meanSquareSlopes[lane]!,
      fades[lane]!,
      cascadeSlopes[lane]!,
      depthMeters,
      beachSlope,
    );
  }
  const gate = waterShoalDepthGate(depthMeters);
  return {
    slopeDelta: [accumulated.slopeDelta[0] * gate, accumulated.slopeDelta[1] * gate],
    whitewater: accumulated.weight > 0
      ? clamp01((accumulated.whitewater / accumulated.weight) * gate)
      : 0,
    weight: accumulated.weight,
  };
}

/**
 * `6-3`'s shared model. Self-contained pure arithmetic over 6-2's swell
 * descriptor — it declares no uniform, samples no texture and takes no
 * derivative, so it runs as a compute kernel in the GPU parity test; the ONE
 * external name it uses is `waterShoreBandSwell`, and using 6-2's height law
 * rather than a second copy of it is the point. Composed after
 * `WATER_SHORE_RUNUP_WGSL`, whose `WATER_RUNUP_TWO_PI` /
 * `WATER_RUNUP_MINIMUM_WAVELENGTH` / `WATER_RUNUP_BEACH_SLOPE_*` constants it
 * also reuses rather than redeclaring.
 *
 * Ocean-only, the way `WATER_SHORE_STREAK_WGSL` is: an inland lake or river
 * has no continental shelf to shoal across, and a bank's foam is 6-1/6-2's
 * bank run-up. One definition either way, neither duplicated.
 */
export const WATER_SHOALING_WGSL = /* wgsl */ `
const WATER_SHOAL_DEPTH_FADE_START_METERS: f32 = ${toWgslFloat(WATER_SHOAL_DEPTH_FADE_START_METERS)};
const WATER_SHOAL_DEPTH_GATE_METERS: f32 = ${toWgslFloat(WATER_SHOAL_DEPTH_GATE_METERS)};
const WATER_SHOAL_MINIMUM_RELATIVE_DEPTH: f32 = ${toWgslFloat(WATER_SHOAL_MINIMUM_RELATIVE_DEPTH)};
const WATER_SHOAL_MINIMUM_TANH: f32 = ${toWgslFloat(WATER_SHOAL_MINIMUM_TANH)};
const WATER_SHOAL_MAXIMUM_TANH_ARGUMENT: f32 = ${toWgslFloat(WATER_SHOAL_MAXIMUM_TANH_ARGUMENT)};
const WATER_SHOAL_BREAKER_INDEX_REFERENCE: f32 = ${toWgslFloat(WATER_SHOAL_BREAKER_INDEX_REFERENCE)};
const WATER_SHOAL_BREAKER_INDEX_EXPONENT: f32 = ${toWgslFloat(WATER_SHOAL_BREAKER_INDEX_EXPONENT)};
const WATER_SHOAL_BREAKER_INDEX_MINIMUM: f32 = ${toWgslFloat(WATER_SHOAL_BREAKER_INDEX_MINIMUM)};
const WATER_SHOAL_BREAKER_INDEX_MAXIMUM: f32 = ${toWgslFloat(WATER_SHOAL_BREAKER_INDEX_MAXIMUM)};
const WATER_SHOAL_MINIMUM_STEEPNESS: f32 = ${toWgslFloat(WATER_SHOAL_MINIMUM_STEEPNESS)};
const WATER_SHOAL_MAXIMUM_SLOPE_GAIN: f32 = ${toWgslFloat(WATER_SHOAL_MAXIMUM_SLOPE_GAIN)};
const WATER_SHOAL_WHITEWATER_COVERAGE: f32 = ${toWgslFloat(WATER_SHOAL_WHITEWATER_COVERAGE)};

struct WaterLinearDispersion {
  relativeDepth: f32,
  tanhRelativeDepth: f32,
  groupSpeedRatio: f32,
}

struct WaterShoalingBand {
  breakerIndex: f32,
  wavenumberGain: f32,
  shoalingCoefficient: f32,
  whitewater: f32,
  heightGain: f32,
  slopeGain: f32,
}

struct WaterShelfShoaling {
  slopeDelta: vec2f,
  whitewater: f32,
  weight: f32,
}

// The plan's binding gate, faded so the longest bands cannot step out of it.
fn waterShoalDepthGate(depthMeters: f32) -> f32 {
  return 1.0 - smoothstep(
    WATER_SHOAL_DEPTH_FADE_START_METERS,
    WATER_SHOAL_DEPTH_GATE_METERS,
    depthMeters,
  );
}

// Solve y tanh(y) = k0 h. Eckart's explicit seed plus ONE Newton step; the
// derivative tanh y + y sech^2 y is positive for every y > 0, so the step can
// never divide by zero. tanh at the corrected root comes from one
// linearisation rather than a third tanh call.
fn waterLinearDispersion(relativeDeepDepth: f32) -> WaterLinearDispersion {
  let x = max(relativeDeepDepth, WATER_SHOAL_MINIMUM_RELATIVE_DEPTH);
  // BOTH tanh arguments are capped at 20. WGSL's tanh is commonly lowered to
  // (e^(2x) - 1)/(e^(2x) + 1), which overflows f32 above x = 44 and returns
  // NaN — the finest cascade crosses that at 15 m of depth, inside the gate,
  // and min(NaN, guard) then silently returned the GUARD, giving every short
  // band a 6x slope gain over most of the shelf. Measured on hardware by
  // tests/gpu/water-shelf-shoaling.test.ts, not reasoned about. The cap is
  // exact in both precisions: tanh(20) rounds to 1.0 in f64 as well as f32,
  // as does tanh of anything larger.
  let seedTanh = max(tanh(min(x, WATER_SHOAL_MAXIMUM_TANH_ARGUMENT)), WATER_SHOAL_MINIMUM_TANH);
  let seed = x * inverseSqrt(seedTanh);
  let seedTanhAtSeed = tanh(min(seed, WATER_SHOAL_MAXIMUM_TANH_ARGUMENT));
  let residual = seed * seedTanhAtSeed - x;
  let derivative = seedTanhAtSeed + seed * (1.0 - seedTanhAtSeed * seedTanhAtSeed);
  let relativeDepth = seed - residual / derivative;
  let tanhRelativeDepth = clamp(
    seedTanhAtSeed + (1.0 - seedTanhAtSeed * seedTanhAtSeed) * (relativeDepth - seed),
    WATER_SHOAL_MINIMUM_TANH,
    1.0,
  );
  // n = 0.5 (1 + 2y/sinh 2y) rewritten through t = tanh(y) as
  // 0.5 (1 + y (1 - t^2)/t): algebraically identical, and it cannot overflow
  // at the kh ~ 1500 the finest cascade reaches at 60 m, where sinh(2 kh) is
  // inf and the literal ratio is NaN.
  let groupSpeedRatio = clamp(
    0.5 * (1.0 + relativeDepth * (1.0 - tanhRelativeDepth * tanhRelativeDepth) / tanhRelativeDepth),
    0.5,
    1.0,
  );
  return WaterLinearDispersion(relativeDepth, tanhRelativeDepth, groupSpeedRatio);
}

// Ks = sqrt(c_g0/c_g) = sqrt(kh / (2 n k0h)). No frequency is ever formed.
fn waterShoalingCoefficient(dispersion: WaterLinearDispersion, relativeDeepDepth: f32) -> f32 {
  return sqrt(dispersion.relativeDepth / (2.0 * dispersion.groupSpeedRatio
    * max(relativeDeepDepth, WATER_SHOAL_MINIMUM_RELATIVE_DEPTH)));
}

// gamma = H_b/h_b, a power law in the deep-water Iribarren number anchored at
// McCowan's 0.78. The slope clamps are 6-2's Hunt range — one beach-slope
// range for both items.
fn waterBreakerIndex(beachSlope: f32, deepWaterSteepness: f32) -> f32 {
  let iribarren = clamp(beachSlope, WATER_RUNUP_BEACH_SLOPE_MINIMUM, WATER_RUNUP_BEACH_SLOPE_MAXIMUM)
    * inverseSqrt(max(deepWaterSteepness, WATER_SHOAL_MINIMUM_STEEPNESS));
  return clamp(
    WATER_SHOAL_BREAKER_INDEX_REFERENCE * pow(iribarren, WATER_SHOAL_BREAKER_INDEX_EXPONENT),
    WATER_SHOAL_BREAKER_INDEX_MINIMUM,
    WATER_SHOAL_BREAKER_INDEX_MAXIMUM,
  );
}

// Depth-limited breaking as a clipped Rayleigh sea: Q = exp(-(gamma h/H)^2) is
// both the fraction of waves past the limit and the energy share the limit
// removes, and H sqrt(1 - Q) <= gamma h identically, so the cap is exact. A
// band with no height keeps all of its zero height (gain 1, not 0).
fn waterDepthLimitedBreaking(shoaledHeightMeters: f32, depthMeters: f32, breakerIndex: f32) -> vec2f {
  if (shoaledHeightMeters <= 0.0) { return vec2f(0.0, 1.0); }
  let ratio = breakerIndex * max(depthMeters, 0.0) / shoaledHeightMeters;
  let whitewater = exp(-ratio * ratio);
  return vec2f(whitewater, sqrt(max(1.0 - whitewater, 0.0)));
}

// One spectral band, shoaled and broken. Takes 6-2's swell descriptor so the
// height law cannot drift between the two items.
fn waterShoalingBand(swell: WaterShoreSwell, depthMeters: f32, beachSlope: f32) -> WaterShoalingBand {
  let wavelength = max(swell.wavelengthMeters, WATER_RUNUP_MINIMUM_WAVELENGTH);
  let relativeDeepDepth = WATER_RUNUP_TWO_PI * max(depthMeters, 0.0) / wavelength;
  let dispersion = waterLinearDispersion(relativeDeepDepth);
  let shoalingCoefficient = waterShoalingCoefficient(dispersion, relativeDeepDepth);
  let wavenumberGain = dispersion.relativeDepth
    / max(relativeDeepDepth, WATER_SHOAL_MINIMUM_RELATIVE_DEPTH);
  let breakerIndex = waterBreakerIndex(beachSlope, swell.waveHeightMeters / wavelength);
  let breaking = waterDepthLimitedBreaking(
    swell.waveHeightMeters * shoalingCoefficient,
    depthMeters,
    breakerIndex,
  );
  let heightGain = shoalingCoefficient * breaking.y;
  return WaterShoalingBand(
    breakerIndex,
    wavenumberGain,
    shoalingCoefficient,
    breaking.x,
    heightGain,
    // Slope is amplitude times wavenumber, so the SLOPE gain is their product
    // — the one of the three that shades anything, because a fragment cannot
    // move a crest but can absolutely tilt one.
    min(heightGain * wavenumberGain, WATER_SHOAL_MAXIMUM_SLOPE_GAIN),
  );
}

// Fold one cascade in. The weight is mss (lambda fade)^2 — 6-2's own
// visible-amplitude-squared, the expression waterDominantShoreSwell takes the
// argmax of.
fn waterShoalingAccumulate(
  accumulated: WaterShelfShoaling,
  wavelengthMeters: f32,
  meanSquareSlope: f32,
  fade: f32,
  bandSlope: vec2f,
  depthMeters: f32,
  beachSlope: f32,
) -> WaterShelfShoaling {
  let band = waterShoalingBand(
    waterShoreBandSwell(wavelengthMeters, meanSquareSlope),
    depthMeters,
    beachSlope,
  );
  let visible = wavelengthMeters * fade;
  let weight = meanSquareSlope * visible * visible;
  return WaterShelfShoaling(
    accumulated.slopeDelta + (band.slopeGain - 1.0) * bandSlope,
    accumulated.whitewater + weight * band.whitewater,
    accumulated.weight + weight,
  );
}

// The whole shelf response at one fragment. Both outputs are faded by the
// 60 m gate, so open water is untouched by construction.
fn waterShelfShoaling(
  wavelengths0: vec4f,
  wavelength4: f32,
  meanSquareSlopes0: vec4f,
  meanSquareSlope4: f32,
  fades0: vec4f,
  fade4: f32,
  cascadeSlopesX: vec4f,
  cascadeSlopesZ: vec4f,
  cascadeSlope4: vec2f,
  depthMeters: f32,
  beachSlope: f32,
) -> WaterShelfShoaling {
  var accumulated = WaterShelfShoaling(vec2f(0.0), 0.0, 0.0);
  accumulated = waterShoalingAccumulate(accumulated, wavelengths0.x, meanSquareSlopes0.x, fades0.x, vec2f(cascadeSlopesX.x, cascadeSlopesZ.x), depthMeters, beachSlope);
  accumulated = waterShoalingAccumulate(accumulated, wavelengths0.y, meanSquareSlopes0.y, fades0.y, vec2f(cascadeSlopesX.y, cascadeSlopesZ.y), depthMeters, beachSlope);
  accumulated = waterShoalingAccumulate(accumulated, wavelengths0.z, meanSquareSlopes0.z, fades0.z, vec2f(cascadeSlopesX.z, cascadeSlopesZ.z), depthMeters, beachSlope);
  accumulated = waterShoalingAccumulate(accumulated, wavelengths0.w, meanSquareSlopes0.w, fades0.w, vec2f(cascadeSlopesX.w, cascadeSlopesZ.w), depthMeters, beachSlope);
  accumulated = waterShoalingAccumulate(accumulated, wavelength4, meanSquareSlope4, fade4, cascadeSlope4, depthMeters, beachSlope);
  let gate = waterShoalDepthGate(depthMeters);
  var whitewater = 0.0;
  if (accumulated.weight > 0.0) {
    whitewater = clamp(accumulated.whitewater / accumulated.weight * gate, 0.0, 1.0);
  }
  return WaterShelfShoaling(accumulated.slopeDelta * gate, whitewater, accumulated.weight);
}`;

/**
 * `6-1` — river/lake flow advection, world-locked standing waves and
 * fetch-limited lake chop.
 *
 * WHAT IS ADVECTED AND HOW. Three lattice octaves ride the exported flow
 * through a dual-phase (Vlachos) construction: two copies of the same
 * octave whose Lagrangian ages are half a cycle apart, cross-faded so each
 * carries zero weight at the instant its age wraps. The advected sample
 * coordinate is `worldXZ − v·age` with `age` bounded by the cycle, so the
 * whole term is a pure function of `(absolute world position, flow vector,
 * flow speed, time)` and carries no per-vertex, per-lane, per-mesh, per-page
 * or per-reach state. Two fragments at the same world point with the same
 * exported hydraulics therefore produce the same value whichever lane, mesh
 * row, page or reach they were rasterised from — which is what makes the
 * advected phase continuous across every seam W-5 can produce, including a
 * confluence, without any seam handling at all.
 *
 * WHY NOT JUST `worldXZ − v·t`. See `WATER_FLOW_CYCLE_MINIMUM_SECONDS`:
 * unbounded age shears, overflows and pops. The cycle is chosen per octave as
 * the time the pattern needs to translate one correlation length, so an
 * octave is renewed exactly when it has moved its own feature size.
 *
 * WHAT IS NOT ADVECTED. The standing-wave train. Its phase is
 * `k · arcLength` — W-5's world-anchored arc-length parameter — with a
 * world-locked lattice wander and a lane bow, and no time term anywhere. The
 * water flows through it; it does not move. That is the whole physical point
 * of the rapids term, and it is why the crest that drives rapids foam is
 * blended toward this world-locked mask exactly in proportion to how close
 * the train is to the Stokes breaking limit, while the foam BREAKUP mask
 * stays advected: on a real standing wave the foam streams through a crest
 * that stays put.
 *
 * WHY THE OCEAN DOES NOT COMPOSE THIS. Every input is channel-graph
 * hydraulics. The block is nonetheless written as self-contained arithmetic
 * over the shared noise block so its pure half compiles and runs standalone
 * in the GPU parity test, exactly like 6-4's caustic block.
 */
export const WATER_CHANNEL_FLOW_WGSL = /* wgsl */ `
const WATER_CHANNEL_SENTINEL_BASE: f32 = ${toWgslFloat(WATER_CHANNEL_SENTINEL_BASE)};
const WATER_FLOW_GRAVITY: f32 = ${toWgslFloat(WATER_FLOW_GRAVITY)};
const WATER_FLOW_TWO_PI: f32 = ${toWgslFloat(TWO_PI)};
const WATER_FLOW_CYCLE_MINIMUM_SECONDS: f32 = ${toWgslFloat(WATER_FLOW_CYCLE_MINIMUM_SECONDS)};
const WATER_FLOW_CYCLE_MAXIMUM_SECONDS: f32 = ${toWgslFloat(WATER_FLOW_CYCLE_MAXIMUM_SECONDS)};
const WATER_FLOW_MINIMUM_DRIFT: f32 = ${toWgslFloat(WATER_FLOW_MINIMUM_DRIFT_METERS_PER_SECOND)};
const WATER_FLOW_PHASE_LATTICE_OFFSET = vec2f(${WATER_FLOW_PHASE_LATTICE_OFFSET.map(toWgslFloat).join(", ")});
const WATER_FLOW_SPEED_GAIN_BASE: f32 = ${toWgslFloat(WATER_FLOW_SPEED_GAIN_BASE)};
const WATER_FLOW_SPEED_GAIN_SLOPE: f32 = ${toWgslFloat(WATER_FLOW_SPEED_GAIN_SLOPE)};
const WATER_FLOW_SPEED_GAIN_CAP: f32 = ${toWgslFloat(WATER_FLOW_SPEED_GAIN_CAP)};
const WATER_FLOW_UNRESOLVED_FACTOR: f32 = ${toWgslFloat(WATER_FLOW_UNRESOLVED_FACTOR)};
const WATER_FLOW_STRETCH: f32 = ${toWgslFloat(WATER_FLOW_STRETCH)};
const WATER_FLOW_FADE_LOW: f32 = ${toWgslFloat(WATER_FLOW_FADE_LOW)};
const WATER_FLOW_FADE_HIGH: f32 = ${toWgslFloat(WATER_FLOW_FADE_HIGH)};
const WATER_STANDING_STEEPNESS_COEFFICIENT: f32 = ${toWgslFloat(WATER_STANDING_STEEPNESS_COEFFICIENT)};
const WATER_STANDING_MAXIMUM_SLOPE: f32 = ${toWgslFloat(WATER_STANDING_MAXIMUM_SLOPE)};
const WATER_STANDING_MINIMUM_WAVELENGTH: f32 = ${toWgslFloat(WATER_STANDING_MINIMUM_WAVELENGTH_METERS)};
const WATER_STANDING_MAXIMUM_WAVELENGTH: f32 = ${toWgslFloat(WATER_STANDING_MAXIMUM_WAVELENGTH_METERS)};
const WATER_STANDING_BREAK_LOW: f32 = ${toWgslFloat(WATER_STANDING_BREAK_LOW)};
const WATER_STANDING_BREAK_HIGH: f32 = ${toWgslFloat(WATER_STANDING_BREAK_HIGH)};
const WATER_STANDING_CREST_SHARPNESS: f32 = ${toWgslFloat(WATER_STANDING_CREST_SHARPNESS)};
const WATER_STANDING_WANDER_CELLS: f32 = ${toWgslFloat(WATER_STANDING_WANDER_CELLS_PER_METER)};
const WATER_STANDING_WANDER_WAVELENGTHS: f32 = ${toWgslFloat(WATER_STANDING_WANDER_WAVELENGTHS)};
const WATER_STANDING_WANDER_SALT: f32 = ${toWgslFloat(WATER_STANDING_WANDER_SALT)};
const WATER_STANDING_BOW_RADIANS: f32 = ${toWgslFloat(WATER_STANDING_BOW_RADIANS)};
const WATER_STANDING_LANE_FALLOFF: f32 = ${toWgslFloat(WATER_STANDING_LANE_FALLOFF)};
const WATER_STANDING_FADE_LOW: f32 = ${toWgslFloat(WATER_STANDING_FADE_LOW)};
const WATER_STANDING_FADE_HIGH: f32 = ${toWgslFloat(WATER_STANDING_FADE_HIGH)};
const WATER_LAKE_FETCH_REFERENCE_METERS: f32 = ${toWgslFloat(WATER_LAKE_FETCH_REFERENCE_METERS)};
const WATER_LAKE_CHOP_HEIGHT_COEFFICIENT: f32 = ${toWgslFloat(WATER_LAKE_CHOP_HEIGHT_COEFFICIENT)};
const WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT: f32 = ${toWgslFloat(WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT)};
const WATER_LAKE_CHOP_SINUSOID_AMPLITUDE: f32 = ${toWgslFloat(WATER_LAKE_CHOP_SINUSOID_AMPLITUDE)};
const WATER_LAKE_CHOP_MAXIMUM_SLOPE: f32 = ${toWgslFloat(WATER_LAKE_CHOP_MAXIMUM_SLOPE)};
const WATER_LAKE_CHOP_MINIMUM_WAVELENGTH: f32 = ${toWgslFloat(WATER_LAKE_CHOP_MINIMUM_WAVELENGTH_METERS)};
const WATER_LAKE_CHOP_MAXIMUM_WAVELENGTH: f32 = ${toWgslFloat(WATER_LAKE_CHOP_MAXIMUM_WAVELENGTH_METERS)};
const WATER_LAKE_CHOP_STRETCH: f32 = ${toWgslFloat(WATER_LAKE_CHOP_STRETCH)};
const WATER_LAKE_CHOP_FADE_LOW: f32 = ${toWgslFloat(WATER_LAKE_CHOP_FADE_LOW)};
const WATER_LAKE_CHOP_FADE_HIGH: f32 = ${toWgslFloat(WATER_LAKE_CHOP_FADE_HIGH)};
const WATER_FLOW_SCALE_BOIL: f32 = ${toWgslFloat(WATER_FLOW_SCALE_METERS[0])};
const WATER_FLOW_SCALE_WAVELET: f32 = ${toWgslFloat(WATER_FLOW_SCALE_METERS[1])};
const WATER_FLOW_SCALE_RIPPLE: f32 = ${toWgslFloat(WATER_FLOW_SCALE_METERS[2])};
const WATER_FLOW_DRIFT_BOIL: f32 = ${toWgslFloat(WATER_FLOW_DRIFT_FRACTION[0])};
const WATER_FLOW_DRIFT_WAVELET: f32 = ${toWgslFloat(WATER_FLOW_DRIFT_FRACTION[1])};
const WATER_FLOW_DRIFT_RIPPLE: f32 = ${toWgslFloat(WATER_FLOW_DRIFT_FRACTION[2])};
const WATER_FLOW_SLOPE_BOIL: f32 = ${toWgslFloat(WATER_FLOW_SLOPE_AMPLITUDE[0])};
const WATER_FLOW_SLOPE_WAVELET: f32 = ${toWgslFloat(WATER_FLOW_SLOPE_AMPLITUDE[1])};
const WATER_FLOW_SLOPE_RIPPLE: f32 = ${toWgslFloat(WATER_FLOW_SLOPE_AMPLITUDE[2])};

struct WaterFlowPhase {
  ageA: f32,
  ageB: f32,
  weightA: f32,
  weightB: f32,
}

struct WaterStandingWave {
  wavelengthMeters: f32,
  wavenumber: f32,
  slopeAmplitude: f32,
  curvatureAmplitude: f32,
  breaking: f32,
}

struct WaterLakeChop {
  wavelengthMeters: f32,
  significantHeightMeters: f32,
  slopeAmplitude: f32,
  driftSpeed: f32,
  cycleSeconds: f32,
}

struct WaterChannelFlow {
  slope: vec2f,
  unresolvedMeanSquareSlope: f32,
  crest: f32,
  crestWeight: f32,
  standingPhase: f32,
  standingCurvature: f32,
  // 6-2: the bank run-up's foam weight. Exactly 0 under the sentinel, so the
  // analytic shoreFoam ramp is never touched.
  bankRunup: f32,
}

// The plan row's "amplitude scaled by the exported flow speed", as one
// named function: linear in the mean velocity because open-channel surface
// roughness scales with the friction velocity, floored so a backwater keeps
// some texture instead of turning to glass.
fn waterFlowSpeedGain(flowSpeed: f32) -> f32 {
  return WATER_FLOW_SPEED_GAIN_BASE
    + WATER_FLOW_SPEED_GAIN_SLOPE * min(flowSpeed, WATER_FLOW_SPEED_GAIN_CAP);
}

// Renew an octave once it has translated one correlation length: the drift
// distance per cycle is then its own feature size, which bounds the strain
// the spatially varying flow can put into the lattice.
fn waterFlowCycleSeconds(scaleMeters: f32, driftSpeed: f32) -> f32 {
  return clamp(
    scaleMeters / max(driftSpeed, WATER_FLOW_MINIMUM_DRIFT),
    WATER_FLOW_CYCLE_MINIMUM_SECONDS,
    WATER_FLOW_CYCLE_MAXIMUM_SECONDS,
  );
}

// Vlachos's two out-of-phase copies. weightA reaches zero exactly where copy
// A's age wraps and vice versa; the pair is energy-normalised because the two
// copies read decorrelated lattice offsets, so their variances add rather
// than their amplitudes.
fn waterFlowPhase(time: f32, cycleSeconds: f32) -> WaterFlowPhase {
  let cycles = time / cycleSeconds;
  let phaseA = cycles - floor(cycles);
  let shifted = cycles + 0.5;
  let phaseB = shifted - floor(shifted);
  let blend = abs(2.0 * phaseA - 1.0);
  let weightA = 1.0 - blend;
  let energy = 1.0 / sqrt(max(weightA * weightA + blend * blend, 0.25));
  return WaterFlowPhase(
    phaseA * cycleSeconds,
    phaseB * cycleSeconds,
    weightA * energy,
    blend * energy,
  );
}

// One dual-phase advected octave of the shared anisotropic lattice. Returns
// the world-axis slope in the caller's amplitude convention.
fn waterFlowOctave(
  worldXZ: vec2f,
  driftDirection: vec2f,
  driftSpeed: f32,
  latticeAxis: vec2f,
  cellsPerMeter: f32,
  stretch: f32,
  cycleSeconds: f32,
  time: f32,
  offset: vec2f,
) -> vec2f {
  let phase = waterFlowPhase(time, cycleSeconds);
  let copyA = waterCapillaryOctave(
    worldXZ,
    driftDirection * (driftSpeed * phase.ageA),
    latticeAxis,
    cellsPerMeter,
    stretch,
    offset,
  );
  let copyB = waterCapillaryOctave(
    worldXZ,
    driftDirection * (driftSpeed * phase.ageB),
    latticeAxis,
    cellsPerMeter,
    stretch,
    offset + WATER_FLOW_PHASE_LATTICE_OFFSET,
  );
  return copyA.xy * phase.weightA + copyB.xy * phase.weightB;
}

// 6-2: the SAME dual-phase construction, returning the lattice VALUE instead
// of its slope — the advected, mean-0.5 mask the bank run-up streaks with.
// Written here, against 6-1's own phase pair, so 6-2 never invents a second
// dual-phase; the copies are blended CENTRED so the pair's variance adds (the
// energy normalisation) while the mean stays exactly 0.5, which is what makes
// the streak modulation 1 + g(2v - 1) mean-preserving by construction.
fn waterFlowOctaveValue(
  worldXZ: vec2f,
  driftDirection: vec2f,
  driftSpeed: f32,
  latticeAxis: vec2f,
  cellsPerMeter: f32,
  stretch: f32,
  cycleSeconds: f32,
  time: f32,
  offset: vec2f,
) -> f32 {
  let phase = waterFlowPhase(time, cycleSeconds);
  let copyA = waterCapillaryOctave(
    worldXZ,
    driftDirection * (driftSpeed * phase.ageA),
    latticeAxis,
    cellsPerMeter,
    stretch,
    offset,
  );
  let copyB = waterCapillaryOctave(
    worldXZ,
    driftDirection * (driftSpeed * phase.ageB),
    latticeAxis,
    cellsPerMeter,
    stretch,
    offset + WATER_FLOW_PHASE_LATTICE_OFFSET,
  );
  return 0.5 + (copyA.z - 0.5) * phase.weightA + (copyB.z - 0.5) * phase.weightB;
}

// A wave stands still exactly when its phase speed cancels the current, so
// lambda = 2 pi v^2 / g: SPEED sets the wavelength. GRADE sets the steepness
// ka, which is dimensionless like the energy slope it comes from, is
// ceilinged at the Stokes limit, and is also what drives the breaking weight.
fn waterStandingWave(flowSpeed: f32, gradeNormalized: f32) -> WaterStandingWave {
  let wavelength = clamp(
    WATER_FLOW_TWO_PI * flowSpeed * flowSpeed / WATER_FLOW_GRAVITY,
    WATER_STANDING_MINIMUM_WAVELENGTH,
    WATER_STANDING_MAXIMUM_WAVELENGTH,
  );
  let wavenumber = WATER_FLOW_TWO_PI / wavelength;
  let rawSlope = WATER_STANDING_STEEPNESS_COEFFICIENT * gradeNormalized;
  let slopeAmplitude = min(rawSlope, WATER_STANDING_MAXIMUM_SLOPE);
  return WaterStandingWave(
    wavelength,
    wavenumber,
    slopeAmplitude,
    slopeAmplitude * wavenumber,
    smoothstep(WATER_STANDING_BREAK_LOW, WATER_STANDING_BREAK_HIGH, rawSlope),
  );
}

// Fetch-limited growth: Hs from the 0.0016 sqrt law, the peak period from the
// 0.286 cube-root law, and the wavelength, phase speed and renewal cycle that
// follow from it.
fn waterLakeChop(windSpeed: f32, fetchFactor: f32) -> WaterLakeChop {
  let fetchMeters = fetchFactor * fetchFactor * WATER_LAKE_FETCH_REFERENCE_METERS;
  let significantHeight = WATER_LAKE_CHOP_HEIGHT_COEFFICIENT * windSpeed * fetchFactor;
  let wavelength = clamp(
    WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT
      * pow(max(windSpeed * fetchMeters, 0.0001), 2.0 / 3.0),
    WATER_LAKE_CHOP_MINIMUM_WAVELENGTH,
    WATER_LAKE_CHOP_MAXIMUM_WAVELENGTH,
  );
  let amplitude = significantHeight * WATER_LAKE_CHOP_SINUSOID_AMPLITUDE;
  let slopeAmplitude = min(
    WATER_FLOW_TWO_PI * amplitude / wavelength,
    WATER_LAKE_CHOP_MAXIMUM_SLOPE,
  );
  let driftSpeed = sqrt(WATER_FLOW_GRAVITY * wavelength / WATER_FLOW_TWO_PI);
  return WaterLakeChop(
    wavelength,
    significantHeight,
    slopeAmplitude,
    driftSpeed,
    wavelength / max(driftSpeed, 0.05),
  );
}

fn waterChannelFlowZero() -> WaterChannelFlow {
  return WaterChannelFlow(vec2f(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
}

// 6-2: the bank run-up, shared by the river and the lake branches because the
// LAW is shared and only its driver differs. Streaks elongate along the bank
// NORMAL (waterCapillaryOctave elongates across the axis it is given, so the
// axis handed in is the along-bank tangent) and advect on 6-1's dual phase,
// because a bank — unlike an open coast — rides a net current.
fn waterChannelBankRunup(
  swell: WaterShoreSwell,
  bankBand: f32,
  phase: f32,
  worldXZ: vec2f,
  bankNormal: vec2f,
  driftDirection: vec2f,
  driftSpeed: f32,
  time: f32,
  footprint: f32,
) -> f32 {
  let streakFade = 1.0 - smoothstep(
    WATER_RUNUP_STREAK_SCALE_METERS * WATER_RUNUP_STREAK_FADE_LOW,
    WATER_RUNUP_STREAK_SCALE_METERS * WATER_RUNUP_STREAK_FADE_HIGH,
    footprint,
  );
  var streak = 1.0;
  if (streakFade > 0.001) {
    let alongBank = vec2f(-bankNormal.y, bankNormal.x);
    let latticeValue = waterFlowOctaveValue(
      worldXZ,
      driftDirection,
      driftSpeed,
      alongBank,
      WATER_RUNUP_STREAK_CELLS_PER_METER,
      WATER_RUNUP_STREAK_STRETCH,
      waterFlowCycleSeconds(WATER_RUNUP_STREAK_SCALE_METERS, driftSpeed),
      time,
      WATER_RUNUP_STREAK_LATTICE_OFFSET,
    );
    streak = waterShoreStreak(latticeValue, streakFade);
  }
  // The driver's own strength: a glassy pond's rim must not foam like a lee
  // shore, and a backwater's bank must not foam like a torrent's.
  let swashWeight = smoothstep(0.0, WATER_RUNUP_BANK_EXCURSION_REFERENCE, swell.excursionMeters);
  return clamp(
    bankBand * swashWeight * waterShoreBore(phase) * streak * WATER_RUNUP_BANK_STRENGTH,
    0.0,
    1.0,
  );
}

// The composed term. THE SENTINEL IS THE FIRST STATEMENT: an analytic world
// carries waterData.w == 0 on every vertex and leaves here having executed one
// compare.
fn waterChannelFlow(
  channelPayload: f32,
  lakeFactor: f32,
  worldXZ: vec2f,
  flowDirection: vec2f,
  flowSpeed: f32,
  arcLengthMeters: f32,
  laneCoordinate: f32,
  windVelocity: vec2f,
  time: f32,
  footprint: f32,
  // 6-2: the bank run-up's two extra inputs. shoreProximity is W-5's own
  // waterData.z (0 mid-channel, 1 at the bank); bankNormal is the unit
  // direction from the water toward the bank, which the caller already knows
  // exactly (cross-stream for a lane, radial for a lake ring) and which no
  // derivative here could recover as cleanly.
  shoreProximity: f32,
  bankNormal: vec2f,
) -> WaterChannelFlow {
  var result = waterChannelFlowZero();
  if (channelPayload <= 0.0) {
    return result;
  }
  let field = clamp(channelPayload - WATER_CHANNEL_SENTINEL_BASE, 0.0, 1.0);
  if (lakeFactor < 0.5) {
    let speedGain = waterFlowSpeedGain(flowSpeed);
    // waterCapillaryOctave elongates ACROSS the axis it is given, and river
    // structure is elongated ALONG the flow, so the axis is the cross-stream
    // one.
    let crossStream = vec2f(-flowDirection.y, flowDirection.x);
    var slope = vec2f(0.0);
    var unresolved = 0.0;

    let fadeBoil = 1.0 - smoothstep(
      WATER_FLOW_SCALE_BOIL * WATER_FLOW_FADE_LOW,
      WATER_FLOW_SCALE_BOIL * WATER_FLOW_FADE_HIGH,
      footprint,
    );
    if (fadeBoil > 0.001) {
      let drift = flowSpeed * WATER_FLOW_DRIFT_BOIL;
      slope += waterFlowOctave(
        worldXZ, flowDirection, drift, crossStream,
        1.0 / WATER_FLOW_SCALE_BOIL, WATER_FLOW_STRETCH,
        waterFlowCycleSeconds(WATER_FLOW_SCALE_BOIL, drift),
        time, vec2f(3.1, 47.9),
      ) * (WATER_FLOW_SLOPE_BOIL * speedGain * fadeBoil);
    }
    unresolved += WATER_FLOW_SLOPE_BOIL * WATER_FLOW_SLOPE_BOIL * speedGain * speedGain
      * WATER_FLOW_UNRESOLVED_FACTOR * (1.0 - fadeBoil * fadeBoil);

    let fadeWavelet = 1.0 - smoothstep(
      WATER_FLOW_SCALE_WAVELET * WATER_FLOW_FADE_LOW,
      WATER_FLOW_SCALE_WAVELET * WATER_FLOW_FADE_HIGH,
      footprint,
    );
    if (fadeWavelet > 0.001) {
      let drift = flowSpeed * WATER_FLOW_DRIFT_WAVELET;
      slope += waterFlowOctave(
        worldXZ, flowDirection, drift, crossStream,
        1.0 / WATER_FLOW_SCALE_WAVELET, WATER_FLOW_STRETCH,
        waterFlowCycleSeconds(WATER_FLOW_SCALE_WAVELET, drift),
        time, vec2f(29.3, 8.7),
      ) * (WATER_FLOW_SLOPE_WAVELET * speedGain * fadeWavelet);
    }
    unresolved += WATER_FLOW_SLOPE_WAVELET * WATER_FLOW_SLOPE_WAVELET * speedGain * speedGain
      * WATER_FLOW_UNRESOLVED_FACTOR * (1.0 - fadeWavelet * fadeWavelet);

    let fadeRipple = 1.0 - smoothstep(
      WATER_FLOW_SCALE_RIPPLE * WATER_FLOW_FADE_LOW,
      WATER_FLOW_SCALE_RIPPLE * WATER_FLOW_FADE_HIGH,
      footprint,
    );
    if (fadeRipple > 0.001) {
      let drift = flowSpeed * WATER_FLOW_DRIFT_RIPPLE;
      slope += waterFlowOctave(
        worldXZ, flowDirection, drift, crossStream,
        1.0 / WATER_FLOW_SCALE_RIPPLE, WATER_FLOW_STRETCH,
        waterFlowCycleSeconds(WATER_FLOW_SCALE_RIPPLE, drift),
        time, vec2f(71.9, 33.5),
      ) * (WATER_FLOW_SLOPE_RIPPLE * speedGain * fadeRipple);
    }
    unresolved += WATER_FLOW_SLOPE_RIPPLE * WATER_FLOW_SLOPE_RIPPLE * speedGain * speedGain
      * WATER_FLOW_UNRESOLVED_FACTOR * (1.0 - fadeRipple * fadeRipple);

    // The world-locked half. No time term reaches this phase.
    let standing = waterStandingWave(flowSpeed, field);
    let standingFade = 1.0 - smoothstep(
      standing.wavelengthMeters * WATER_STANDING_FADE_LOW,
      standing.wavelengthMeters * WATER_STANDING_FADE_HIGH,
      footprint,
    );
    let thalweg = max(
      1.0 - WATER_STANDING_LANE_FALLOFF * abs(laneCoordinate - 0.5) * 2.0,
      0.0,
    );
    let standingWeight = standingFade * thalweg;
    if (standingWeight > 0.001) {
      let wander = waterDetailValue(
        worldXZ * WATER_STANDING_WANDER_CELLS, WATER_STANDING_WANDER_SALT) - 0.5;
      let phase = standing.wavenumber * (arcLengthMeters
          + WATER_STANDING_WANDER_WAVELENGTHS * standing.wavelengthMeters * wander)
        + WATER_STANDING_BOW_RADIANS * (laneCoordinate - 0.5) * (laneCoordinate - 0.5);
      // eta = a sin(phase); the shared convention wants the NEGATIVE gradient.
      slope += flowDirection * (-standing.slopeAmplitude * cos(phase) * standingWeight);
      result.crest = pow(max(sin(phase), 0.0), WATER_STANDING_CREST_SHARPNESS);
      result.crestWeight = standing.breaking * standingWeight;
      result.standingPhase = phase;
      result.standingCurvature = standing.curvatureAmplitude * standingWeight;
    }
    unresolved += standing.slopeAmplitude * standing.slopeAmplitude
      * WATER_FLOW_UNRESOLVED_FACTOR * (1.0 - standingFade * standingFade);

    // 6-2: BANK RUN-UP on a lane. The swash on a river bank is raised by the
    // boil train drifting past, so THAT is the driver swell: its wavelength is
    // the boil scale, its celerity the exported surface velocity (a boil is
    // material — it IS the water), and its height the boil octave's own slope
    // amplitude read through the same slope-to-height relation the ocean's
    // band swell uses. The phase then travels DOWNSTREAM along the arc length
    // W-5 exports, so the bank swash arrives with the boils instead of beating
    // on a clock of its own — the same statement the ocean's phase lock makes,
    // against this surface's own visible driver.
    let bankBand = smoothstep(WATER_RUNUP_BANK_LOW, 1.0, shoreProximity);
    if (bankBand > 0.001) {
      let boilHeight = WATER_FLOW_SLOPE_BOIL * speedGain
        * WATER_FLOW_SCALE_BOIL / WATER_RUNUP_PI;
      let swell = waterShoreSwell(boilHeight, WATER_FLOW_SCALE_BOIL, flowSpeed);
      let bankPhase = swell.radianFrequency * waterRunupClock(time)
        - WATER_FLOW_TWO_PI * arcLengthMeters / WATER_FLOW_SCALE_BOIL;
      result.bankRunup = waterChannelBankRunup(
        swell,
        bankBand,
        bankPhase,
        worldXZ,
        bankNormal,
        flowDirection,
        flowSpeed * WATER_FLOW_DRIFT_BOIL,
        time,
        footprint,
      );
    }

    result.slope = slope;
    result.unresolvedMeanSquareSlope = unresolved;
  } else {
    let windSpeed = length(windVelocity);
    let chop = waterLakeChop(windSpeed, field);
    // wave R's cat's paws gust the chop, so a big lake shows gusted lanes
    // rather than one uniform sea state.
    let amplitude = chop.slopeAmplitude * waterGustField(worldXZ, footprint);
    let fade = 1.0 - smoothstep(
      chop.wavelengthMeters * WATER_LAKE_CHOP_FADE_LOW,
      chop.wavelengthMeters * WATER_LAKE_CHOP_FADE_HIGH,
      footprint,
    );
    if (fade > 0.001) {
      let windAxis = normalize(windVelocity + vec2f(0.00001, 0.0));
      result.slope = waterFlowOctave(
        worldXZ, windAxis, chop.driftSpeed, windAxis,
        1.0 / chop.wavelengthMeters, WATER_LAKE_CHOP_STRETCH,
        chop.cycleSeconds, time, vec2f(17.3, 61.1),
      ) * (amplitude * fade);
    }
    result.unresolvedMeanSquareSlope = amplitude * amplitude
      * WATER_FLOW_UNRESOLVED_FACTOR * (1.0 - fade * fade);
    // 6-2: BANK RUN-UP on a lake shore, driven by the lake's OWN fetch-limited
    // chop — the exact inland analogue of the ocean's dominant-cascade lock,
    // because the chop is the only wave train a lake has. The phase travels
    // WITH the wind, so a lee shore's swash beats at the chop period and a
    // weather shore's does not run at all (its fetch, and therefore its chop,
    // is small).
    let bankBand = smoothstep(WATER_RUNUP_BANK_LOW, 1.0, shoreProximity);
    if (bankBand > 0.001) {
      let windAxis = normalize(windVelocity + vec2f(0.00001, 0.0));
      let swell = waterShoreSwell(
        chop.significantHeightMeters,
        chop.wavelengthMeters,
        chop.driftSpeed,
      );
      let bankPhase = swell.radianFrequency * waterRunupClock(time)
        - WATER_FLOW_TWO_PI * dot(worldXZ, windAxis) / chop.wavelengthMeters;
      result.bankRunup = waterChannelBankRunup(
        swell,
        bankBand,
        bankPhase,
        worldXZ,
        bankNormal,
        windAxis,
        chop.driftSpeed,
        time,
        footprint,
      );
    }
  }
  return result;
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

fn litFoamColor(
  albedo: vec3f,
  normal: vec3f,
  light: vec3f,
  sunColor: vec3f,
  skyZenith: vec3f,
  skyHorizon: vec3f,
  skylightIlluminanceNormalized: f32,
  sunVisibility: f32,
) -> vec3f {
  let nDotL = max(dot(normal, light), 0.0);
  let skyAmbient = (skyZenith + skyHorizon) * 0.5;
  return albedo * (
    skyAmbient * 0.55 * skylightIlluminanceNormalized
    + sunColor * nDotL * sunVisibility
  );
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
 * roughness floor (0.075) lands at mip 0 and the cap at mip 2 — water
 * roughness never exceeds the cap, so the probe's box mip chain suffices and
 * no GGX prefilter convolution is needed.
 *
 * wave R re-calibrated the span 0.265 -> 0.425. The ocean cap moved 0.34 ->
 * 0.5 (a fully unresolved sea at 11 m/s has a mean-square slope near 0.06 by
 * Cox-Munk, i.e. GGX roughness ~0.49 — 0.34 was a truncation, not a physical
 * ceiling), and leaving the old span would have flattened every roughness
 * above 0.34 onto the same mip.
 */
export const WATER_ENVIRONMENT_MIP_WGSL = /* wgsl */ `fn environmentRoughnessToMip(roughness: f32) -> f32 {
  return clamp((roughness - 0.075) * (2.0 / 0.425), 0.0, 2.0);
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
