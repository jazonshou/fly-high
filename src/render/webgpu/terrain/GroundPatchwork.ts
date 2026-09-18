import { SurfaceMaterial, surfaceMaterialSpec } from "./surfaceMaterials";

/**
 * `W-1` — the ground patchwork (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: the appearance of open, vegetated ground in the
 * band between one material tile (2.3–4.1 m) and the macro wash (176 m), and
 * the sparse scrub that stands in it. Exactly one file answers "what does a
 * meadow look like from the air"; `TerrainSurfacePlugin` composes it.
 *
 * WHY THIS EXISTS. The surface pipeline is deliberately mean-converging: each
 * material layer is high-passed (`LOW_FREQUENCY_KEEP = 0.32`) and albedo-fitted
 * to `spec.referenceAlbedo`, and the micro fade converges every patterned
 * channel to that reference once the anisotropy-limited footprint passes
 * 1.5–10 m. Both are correct — they are what stops a 2.9 m tile drawing its own
 * repeat across a hillside — and together they mean that from 200 m up, open
 * grassland is ONE colour times a kilometre-scale wash. Fix-pack `T1` put a
 * 71 m and a 23 m octave back; measured, they are ±13% and ±8% of tone with the
 * normal perturbation derated to 0.4x on flat ground, which is the airbrushed
 * clay the flying reports keep describing. This file fills the same band with
 * structure that has EDGES, and with objects that have a lit side.
 *
 * Three terms, each with its own reason to exist:
 *
 *  1. DRYNESS REMAP. The classifier's Grass/DryGrass boundary is a smooth
 *     kilometre blob because its drivers are 850–5,200 m moisture fields. Real
 *     pasture is dry on the convex and lush in the hollows at 30–200 m. The
 *     remap perturbs the fragment's OWN dryness (the house rule: perturb the
 *     driver, not the output) and converts the change to a ratio between the
 *     Grass and DryGrass reference albedos. No categorical id moves, no extra
 *     texture is fetched, and a page boundary cannot show because the driver is
 *     world-locked and continuous.
 *  2. BARE GROUND. Thin, sun-burnt patches at 6–17 m where the sward opens to
 *     soil. The one genuinely albedo-only term.
 *  3. SCRUB. A procedural bush canopy: a HEIGHT FIELD, not a stamp. Its crown
 *     mask, its shading normal, its ambient occlusion and its cast shadow are
 *     all read off the same field, so they cannot disagree about where a bush
 *     is. This is the term that makes open ground read as three dimensional at
 *     the altitudes the complaint is about.
 *
 * WHY A FIELD AND NOT A LATTICE OF STAMPS. A jittered cell lattice has to
 * confine every feature — crown, shadow, occlusion ring, parallax — inside its
 * own cell, or it needs a neighbourhood walk (the far-sea whitecap draft's
 * per-pixel cell walk cost 15 ms/frame, which is the standing reason that is
 * not an option). Confinement forces the jitter span toward zero as features
 * grow, and a lattice with no jitter is a visible grid: the exact artefact this
 * shader has had to remove three times. A thresholded gradient-noise field has
 * no cells to line up, gives the crown an organic outline for free, and — the
 * property that decides it — hands back an ANALYTIC gradient, so the dome
 * shading and the cast-shadow test read the same surface the mask does.
 *
 * FILTERING DOCTRINE (the house rules this file must satisfy):
 *
 *  - World-locked, frame-independent hashes. There is no TAA; a frame index in
 *    a jitter is what made the cloud shadow's iso-lines crawl.
 *  - Integer hashes, never `fract(p * k)`. At 1e5 m of world coordinate the
 *    fract-of-product hash lands where f32 spacing is ~2e-3 and collapses into
 *    bands — the recorded incident behind `groundHash2`.
 *  - Every octave fades on its OWN wavelength against the 3D derivative
 *    footprint, with at most a 4x anisotropy credit: procedural noise gets no
 *    help from the 16x sampler and would shimmer along the grazing axis.
 *  - Every term converges to its EXACT expectation rather than to zero. A bush
 *    smaller than a pixel becomes the mean coverage of its own neighbourhood,
 *    so there is no distance ring and no brightness drift. The constants that
 *    make that exact are measured here and pinned by tests.
 *  - Gradient noise, not value noise. A value-noise lattice puts its extrema ON
 *    the lattice, which is the soft axis-aligned blob field wave Q had to
 *    rotate away and the far sea had to warp away.
 */

/**
 * `W-1b` — the VIGOUR axis: how well the sward is doing, independent of how dry
 * the climate is.
 *
 * The dryness remap answers "grass or straw", and on ground the classifier
 * calls pure Grass it has nothing to say: measured against the base build, a
 * lush meadow at 1,600 ft moved by less than one 8-bit level. But a real
 * meadow is not one green. It is a patchwork of vigour — rich dark green where
 * the soil is deep and wet, pale yellow-green where it is thin, burnt or
 * grazed — and that patchwork has EDGES, which is the whole difference from
 * the macro wash this shader already has: that wash is ±17% of smooth value
 * noise, and smoothness is exactly why it reads as airbrush.
 *
 * So vigour is not another noise sum. It is a stack of soft-THRESHOLDED masks,
 * one per octave, each contributing a patch with a boundary, plus a ridged
 * crease term that lays the lusher lines a drainage net leaves in a field.
 * Every mask is symmetric about its own zero, so its mean is exactly a half
 * whatever the threshold width — which is what makes the stack mean-zero by
 * construction rather than by a correction.
 *
 * The anti-camouflage rules, each learned from a defect in this file's
 * history: the masks read the WARPED position, so boundaries are organic; the
 * octaves are rotated off each other and off the world axes; the threshold
 * SOFTNESS is itself a low-frequency field, so some boundaries are crisp and
 * others dissolve over tens of metres; and the amplitude is carried by
 * luminance and hue together, never by a flat brightness step.
 */
export const GROUND_VIGOUR_FINE_METERS = 18.4;
export const GROUND_VIGOUR_FINE_DEGREES = 83.4;
/** Mask amplitudes, coarse/mid/fine, and the crease's. */
export const GROUND_VIGOUR_COARSE_AMPLITUDE = 0.22;
export const GROUND_VIGOUR_MID_AMPLITUDE = 0.45;
export const GROUND_VIGOUR_FINE_AMPLITUDE = 0.4;
export const GROUND_VIGOUR_CREASE_AMPLITUDE = 0.15;
/**
 * The crease: a ridge along an ISO-LINE of the mid octave, not along its zero
 * set. The zero set is exactly where that octave's own patch mask puts its
 * boundary, so a crease there would outline every patch and read as a cartoon
 * edge; offsetting it by 0.62 sigma decorrelates the two features for free,
 * without a fourth noise evaluation. Mean and variance measured at the offset.
 */
export const GROUND_VIGOUR_CREASE_SHARPNESS = 2.2;
export const GROUND_VIGOUR_CREASE_OFFSET = 0.62;
export const GROUND_VIGOUR_CREASE_MEAN = 0.1452;
/** Threshold width in field units, from crisp to dissolved. */
export const GROUND_VIGOUR_EDGE_MIN = 0.12;
export const GROUND_VIGOUR_EDGE_MAX = 0.85;
/**
 * A vigour boundary is never thinner than this on the ground. Without it a
 * 60 m AGL pass reads the fine octave's edge as a painted line on the grass;
 * with it the same boundary is a few metres of transition, which is what a
 * change of sward actually looks like from a low pass.
 */
export const GROUND_VIGOUR_EDGE_FLOOR_METERS = 3.5;
/**
 * Variance of the whole stack, for the mean-one correction: the amplitudes
 * above against a measured 0.2125 per centred mask and 0.0915 for the crease.
 * One standard deviation is about a fifth of a stop of luminance, which is the
 * swing a meadow shows from the air; two is the rare patch that reads as a
 * different field.
 */
/**
 * Vigour's gain on PURE LUSH ground.
 *
 * The dryness axis carries the mosaic wherever the classifier has both covers
 * to work with, but on ground it calls pure Grass that axis has nothing to say
 * and vigour is the only structure there is. So vigour is scaled up exactly
 * where dryness runs out: the sites already tuned against the mosaic do not
 * move, and a lush meadow stops being one smooth green.
 */
export const GROUND_VIGOUR_LUSH_GAIN = 2.3;

export const GROUND_VIGOUR_STACK_VARIANCE = 0.089;
/**
 * The axis itself, in log space: rich dark green to pale yellow-green.
 *
 * The endpoints are chosen the way stressed grass actually changes — red up
 * hard, green up a little, blue DOWN — so the pale end is yellow rather than
 * merely bright. A first draft raised blue with red and the ground marbled
 * green against tan: two materials interleaved, which reads as camouflage,
 * not as one sward doing better in some places than others.
 *
 * Scaled so one standard deviation of the stack is about 12% of luminance and
 * two is about 26%. A first draft at 18% and 40% was, in a word, paint.
 */
export const GROUND_VIGOUR_AXIS_SCALE = 0.8;
export const GROUND_VIGOUR_RICH: readonly [number, number, number] = [0.09, 0.15, 0.05];
export const GROUND_VIGOUR_PALE: readonly [number, number, number] = [0.19, 0.21, 0.065];

/** Gradient-noise scales, metres. Distinct, non-harmonic, none near the 35° fabric. */
export const GROUND_PATCH_COARSE_METERS = 163;
export const GROUND_PATCH_MID_METERS = 53;
export const GROUND_BARE_COARSE_METERS = 17.3;
export const GROUND_BARE_FINE_METERS = 6.1;

/** Per-octave rotations, degrees. Each is off the world axes and off the others. */
export const GROUND_PATCH_COARSE_DEGREES = 23.3;
export const GROUND_PATCH_MID_DEGREES = 71.9;
export const GROUND_BARE_COARSE_DEGREES = 47.1;
export const GROUND_BARE_FINE_DEGREES = 104.7;
export const GROUND_SCRUB_SMALL_DEGREES = 17.9;
export const GROUND_SCRUB_LARGE_DEGREES = 52.6;

/**
 * Measured standard deviation of `terrainGroundNoise` before gain.
 *
 * The primitive is Perlin gradient noise whose gradients are the hash's two
 * 16-bit halves mapped to [-1, 1]² — a square distribution rather than a unit
 * circle, which is cheaper and, at these amplitudes, indistinguishable. Its
 * sigma is therefore not a textbook constant and is measured instead: 0.17593
 * over 4e5 samples. The shader multiplies by the reciprocal, so every amplitude
 * below is written in standard deviations of a unit-variance field, which is
 * what makes the expectation constants transferable between octaves.
 */
export const GROUND_NOISE_SIGMA = 0.17593;
export const GROUND_NOISE_GAIN = 1 / GROUND_NOISE_SIGMA;

/**
 * Dryness shaping: `s / (|s| + c)`, an odd function, so a symmetric driver
 * keeps its zero mean exactly rather than approximately. `c = 0.75` puts most
 * of the range in the shoulder — patches with edges — while staying C1 at the
 * origin. Its variance under a unit-variance driver is measured because the
 * albedo ratio is exponential in the shift and needs the second moment to stay
 * mean-one.
 */
export const GROUND_DRYNESS_SHAPE = 1;
export const GROUND_DRYNESS_SHAPE_VARIANCE = 0.183;
/** Maximum dryness excursion, in units of the Grass→DryGrass axis. */
export const GROUND_DRYNESS_AMPLITUDE = 0.26;

/**
 * Bare-ground threshold and its exact expected coverage.
 *
 * `smoothstep(0.7, 1.5, n17 + 0.5 * n6)` over unit-variance octaves covers
 * 0.1654 of the plane (2e6 samples). The shader fades toward that number
 * rather than toward zero as the octaves pass their Nyquist, so the mean
 * albedo of a dry sward does not drift with range.
 */
export const GROUND_BARE_THRESHOLD_LOW = 1.05;
export const GROUND_BARE_THRESHOLD_HIGH = 1.85;
export const GROUND_BARE_EXPECTED_COVERAGE = 0.1002;

/**
 * The scrub canopy: two populations, both thresholded from the same primitive.
 *
 * Small is knee-to-waist scrub and tussock — the thing that covers a dry
 * pasture and that no vegetation instance draws (ground cover is gated off by
 * 80 m AGL, and the detail system's shrubs are a forest-biome population).
 * Large is the standing bush a savanna scatters at tens of metres, the feature
 * the reference photograph is full of.
 */
export const GROUND_SCRUB_SMALL_WAVELENGTH_METERS = 5.3;
export const GROUND_SCRUB_SMALL_HEIGHT_METERS = 1.6;
export const GROUND_SCRUB_SMALL_THRESHOLD_DENSE = 1.35;
export const GROUND_SCRUB_SMALL_THRESHOLD_SPARSE = 2.75;
export const GROUND_SCRUB_LARGE_WAVELENGTH_METERS = 15.7;
export const GROUND_SCRUB_LARGE_HEIGHT_METERS = 2.9;
export const GROUND_SCRUB_LARGE_THRESHOLD_DENSE = 1.75;
export const GROUND_SCRUB_LARGE_THRESHOLD_SPARSE = 3.05;

/** Crown edge width in field units, before the screen-space widening. */
export const GROUND_SCRUB_CROWN_WIDTH = 0.12;
/** Crowns are dense but not opaque: a little sward shows through every bush. */
export const GROUND_SCRUB_CROWN_OPACITY = 0.85;
/** Cap on the mean-preserving gain applied to a widened crown edge. */
export const GROUND_SCRUB_CROWN_GAIN_CAP = 2.5;
/** Dome slopes are clamped: a crown may tilt the normal, never invert it. */
export const GROUND_SCRUB_SLOPE_LIMIT = 1.3;
/** Ambient occlusion: the field ramp below the crown, and its strength. */
export const GROUND_SCRUB_OCCLUSION_BELOW = 1;
export const GROUND_SCRUB_OCCLUSION_SPAN = 1.3;
export const GROUND_SCRUB_OCCLUSION_STRENGTH = 0.26;
/** Cast shadow: two taps toward the sun, as fractions of the wavelength. */
export const GROUND_SCRUB_SHADOW_TAP_NEAR = 0.36;
export const GROUND_SCRUB_SHADOW_TAP_FAR = 0.85;
export const GROUND_SCRUB_SHADOW_STRENGTH = 0.8;
/** Above this solar tangent the shadow is shorter than a crown; skip the taps. */
export const GROUND_SCRUB_SHADOW_SUN_TANGENT = 1.2;

/**
 * Expectation coefficients, `exp(c0 + c1 t + c2 t²)`, fitted to 1.2e6 samples
 * per threshold over t ∈ [0.9, 2.4] with residuals under 2%.
 *
 *  - COVERAGE: P(field > t), the resolved crown's own area.
 *  - HEIGHT: E[(max(0, field − t))²] — the SQUARED profile, because the crown
 *    is the square of the clearance (see the scrub function): squaring pulls
 *    the near-threshold filaments in and leaves rounded crowns where the field
 *    has real maxima, which is the difference between a bush and a worm.
 *  - OCCLUSION: E of the ambient ramp, so the far field's cavity matches the
 *    near field's rather than brightening into it.
 */
export const GROUND_SCRUB_COVERAGE_FIT: readonly [number, number, number] = [
  -1.21618, -0.01472, -0.62451,
];
export const GROUND_SCRUB_HEIGHT_FIT: readonly [number, number, number] = [
  -1.09905, -0.85589, -0.63783,
];
export const GROUND_SCRUB_OCCLUSION_FIT: readonly [number, number, number] = [
  -0.6039, -0.34015, -0.37104,
];

/**
 * The widened-edge coverage model: `E[clamp(H / W)] ≈ coverage · h̄ / (h̄ +
 * 0.66 W)`, where h̄ = E[H] / coverage is the mean crown height. Checked
 * against Monte Carlo over t ∈ [0.9, 2.3] × W ∈ [0.1, 2]: within 10% wherever
 * the coverage is above 1%, and the absolute error never exceeds 0.005 of area.
 * It is what lets the crown keep its mean as its edge widens with range.
 */
export const GROUND_SCRUB_EDGE_MODEL = 0.75;
/**
 * The model overestimates by a near-constant fifth across the whole grid
 * (t ∈ [1.2, 2.2] × W ∈ [0.05, 1]), because the clamp bites hardest exactly
 * where the quadratic profile is steepest. One prefactor takes it to within 7%,
 * and the residual is a few thousandths of coverage.
 */
export const GROUND_SCRUB_EDGE_PREFACTOR = 0.82;

/**
 * The near edge of the scrub band, in metres of ground per pixel.
 *
 * A painted crown is a mask on the ground plane: shade it as well as you like,
 * at close range it is still flat, and the eye reads flat the moment a crown
 * spans more than about ten pixels. So the band is keyed on the FOOTPRINT, not
 * on altitude — the same discipline as every other fade in this shader, and it
 * gets the near-bottom of a high oblique frame right, which an altitude gate
 * cannot. Below 0.3 m/px there is no painted scrub at all; ground cover owns
 * that range (blades to 80 m AGL) and the material tile carries the rest.
 */
export const GROUND_SCRUB_NEAR_FOOTPRINT = 0.3;
export const GROUND_SCRUB_FULL_FOOTPRINT = 0.6;
/** Crown parallax, capped in wavelengths so a crown cannot swim off its base. */
export const GROUND_SCRUB_PARALLAX_MAX = 0.45;

function wgslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function rotationWgsl(degrees: number): string {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians).toFixed(6);
  const sin = Math.sin(radians).toFixed(6);
  return `mat2x2f(${cos}, ${sin}, -${sin}, ${cos})`;
}

/** The two scrub lattices' rotations, as WGSL matrices the plugin composes. */
export const GROUND_SCRUB_SMALL_AXIS_WGSL = rotationWgsl(GROUND_SCRUB_SMALL_DEGREES);
export const GROUND_SCRUB_LARGE_AXIS_WGSL = rotationWgsl(GROUND_SCRUB_LARGE_DEGREES);

/** A linear albedo triple as a WGSL vec3f literal. */
export function groundAlbedoWgsl(albedo: readonly [number, number, number]): string {
  return `vec3f(${albedo.map((channel) => wgslFloat(channel)).join(", ")})`;
}

const GRASS = surfaceMaterialSpec(SurfaceMaterial.Grass).referenceAlbedo;
const DRY_GRASS = surfaceMaterialSpec(SurfaceMaterial.DryGrass).referenceAlbedo;

/**
 * The dryness axis, in LOG space.
 *
 * Interpolating albedo geometrically rather than linearly is what lets the
 * remap run past both ends of the axis — a hollow can be lusher than the Grass
 * reference and a burnt crest drier than the DryGrass one — without a clamp at
 * either end. That clamp is not a cosmetic detail: it rectifies the driver, and
 * a rectified zero-mean driver moves the material's integrated albedo, which is
 * what `R-26`'s ground bounce and the light rig read.
 */
export const GROUND_DRYNESS_LOG_RATIO: readonly [number, number, number] = [
  Math.log(DRY_GRASS[0] / GRASS[0]),
  Math.log(DRY_GRASS[1] / GRASS[1]),
  Math.log(DRY_GRASS[2] / GRASS[2]),
];

/**
 * Bare soil under a sward: greyer than dry grass and close to it in luminance,
 * so the patches read as a change of material rather than as stains.
 */
export const GROUND_BARE_ALBEDO: readonly [number, number, number] = [0.205, 0.17, 0.128];

/**
 * Bare ground is not only a dry-climate feature. A lush meadow still opens to
 * soil where the ground is steep, convex or worn, just less of it, so the
 * coverage has a floor everywhere and rises with dryness and slope.
 */
export const GROUND_BARE_LUSH_SHARE = 0.3;

/** The vigour axis as a log ratio, scaled. */
export const GROUND_VIGOUR_LOG_AXIS: readonly [number, number, number] = [
  Math.log(GROUND_VIGOUR_PALE[0] / GROUND_VIGOUR_RICH[0]) * GROUND_VIGOUR_AXIS_SCALE,
  Math.log(GROUND_VIGOUR_PALE[1] / GROUND_VIGOUR_RICH[1]) * GROUND_VIGOUR_AXIS_SCALE,
  Math.log(GROUND_VIGOUR_PALE[2] / GROUND_VIGOUR_RICH[2]) * GROUND_VIGOUR_AXIS_SCALE,
];

/** Scrub crowns, linear albedo: lush green through grey-olive when dry. */
export const GROUND_SCRUB_ALBEDO_LUSH: readonly [number, number, number] = [0.062, 0.088, 0.042];
export const GROUND_SCRUB_ALBEDO_DRY: readonly [number, number, number] = [0.14, 0.128, 0.076];
/**
 * Crown shape tone: cap versus flank. The mean over a crown is one within a
 * few percent, so the far field's expectation is the same number and the
 * handover cannot brighten.
 */
export const GROUND_SCRUB_TONE_CAP = 1.18;
export const GROUND_SCRUB_TONE_FLANK = 0.42;
export const GROUND_SCRUB_TONE_MEAN = 0.97;

/**
 * The range band over which real shrub instances thin out, metres.
 *
 * The vegetation system budgets drawn shrubs at 60 per hectare inside its near
 * radius, falling to a floor by about 700 m and cut outright at the mid band.
 * Painted scrub ramps in across the same band so the two populations hand over
 * rather than double up, and stays full past it.
 */
export const GROUND_SCRUB_RENDERED_NEAR_METERS = 150;
export const GROUND_SCRUB_RENDERED_FAR_METERS = 700;

/** Crowns are rougher than the sward they stand in. */
export const GROUND_SCRUB_ROUGHNESS = 0.94;

/** `3-0`'s materials, reduced to (is this vegetated, how dry is it). */
export function groundCoverOf(materialIndex: number): readonly [number, number] {
  switch (materialIndex) {
    case SurfaceMaterial.Grass:
      return [1, 0];
    case SurfaceMaterial.DryGrass:
      return [1, 1];
    case SurfaceMaterial.Shrub:
      return [0.9, 0.45];
    case SurfaceMaterial.ForestFloor:
      return [0.55, 0.2];
    case SurfaceMaterial.Gravel:
      return [0.15, 0.7];
    default:
      return [0, 0];
  }
}

/**
 * The CPU twin of the shader's gradient noise and its analytic derivative, for
 * the mean-preservation tests. Identical arithmetic: same integer hash, same
 * quintic, same gain. Returns (value, d/dx, d/dy) in the SCALED coordinates.
 */
export function groundNoiseHash(cellX: number, cellY: number, salt: number): number {
  let h = (Math.imul(cellX >>> 0, 0x27d4eb2d)
    ^ Math.imul(cellY >>> 0, 0x165667b1)
    ^ Math.imul(salt >>> 0, 0x9e3779b9)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

export function groundNoiseGradient(
  x: number,
  y: number,
  salt: number,
): readonly [number, number, number] {
  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  const fx = x - baseX;
  const fy = y - baseY;
  const quintic = (f: number): number => f * f * f * (f * (f * 6 - 15) + 10);
  const quinticSlope = (f: number): number => 30 * f * f * (f * (f - 2) + 1);
  const gradient = (cx: number, cy: number): readonly [number, number] => {
    const h = groundNoiseHash(cx, cy, salt);
    return [(h & 0xffff) * (2 / 65535) - 1, (h >>> 16) * (2 / 65535) - 1];
  };
  const ga = gradient(baseX, baseY);
  const gb = gradient(baseX + 1, baseY);
  const gc = gradient(baseX, baseY + 1);
  const gd = gradient(baseX + 1, baseY + 1);
  const va = ga[0] * fx + ga[1] * fy;
  const vb = gb[0] * (fx - 1) + gb[1] * fy;
  const vc = gc[0] * fx + gc[1] * (fy - 1);
  const vd = gd[0] * (fx - 1) + gd[1] * (fy - 1);
  const ux = quintic(fx);
  const uy = quintic(fy);
  const dux = quinticSlope(fx);
  const duy = quinticSlope(fy);
  const corner = va - vb - vc + vd;
  return [
    (va + ux * (vb - va) + uy * (vc - va) + ux * uy * corner) * GROUND_NOISE_GAIN,
    (ga[0] + ux * (gb[0] - ga[0]) + uy * (gc[0] - ga[0])
      + ux * uy * (ga[0] - gb[0] - gc[0] + gd[0])
      + dux * (uy * corner + vb - va)) * GROUND_NOISE_GAIN,
    (ga[1] + ux * (gb[1] - ga[1]) + uy * (gc[1] - ga[1])
      + ux * uy * (ga[1] - gb[1] - gc[1] + gd[1])
      + duy * (ux * corner + vc - va)) * GROUND_NOISE_GAIN,
  ];
}

export function groundNoise(x: number, y: number, salt: number): number {
  return groundNoiseGradient(x, y, salt)[0];
}

/** `exp(c0 + c1 t + c2 t²)` — the fitted expectations, CPU side. */
export function groundScrubExpectation(
  fit: readonly [number, number, number],
  threshold: number,
): number {
  return Math.exp(fit[0] + fit[1] * threshold + fit[2] * threshold * threshold);
}

/** The widened-edge crown mean, CPU side. */
export function groundScrubCrownMean(threshold: number, width: number): number {
  const coverage = groundScrubExpectation(GROUND_SCRUB_COVERAGE_FIT, threshold);
  const height = groundScrubExpectation(GROUND_SCRUB_HEIGHT_FIT, threshold);
  const mean = height / Math.max(coverage, 1e-5);
  return coverage * mean / (mean + GROUND_SCRUB_EDGE_MODEL * width);
}

const COVER_WGSL = [
  SurfaceMaterial.Grass,
  SurfaceMaterial.DryGrass,
  SurfaceMaterial.Shrub,
  SurfaceMaterial.ForestFloor,
  SurfaceMaterial.Gravel,
]
  .map((id) => {
    const [vegetation, dryness] = groundCoverOf(id);
    return `  if (materialIndex == ${id}) { return vec2f(${wgslFloat(vegetation)}, `
      + `${wgslFloat(vegetation * dryness)}); }`;
  })
  .join("\n");

function fitWgsl(fit: readonly [number, number, number]): string {
  return `vec3f(${wgslFloat(fit[0])}, ${wgslFloat(fit[1])}, ${wgslFloat(fit[2])})`;
}

/**
 * The WGSL half. Composed by `TerrainSurfacePlugin`'s fragment definitions;
 * every identifier carries the `terrainGround` prefix, which is `R-3F`'s
 * collision rule satisfied the same way `waterShoreRunup` and
 * `vegetationCanopyHandoff` satisfy it.
 */
export const TERRAIN_GROUND_PATCHWORK_WGSL = /* wgsl */ `
// The integer hash the water far field and the ground cover use, for the same
// reason: these coordinates are absolute world metres.
fn terrainGroundHash(cell: vec2i, salt: u32) -> u32 {
  var h = (bitcast<u32>(cell.x) * 0x27d4eb2du)
    ^ (bitcast<u32>(cell.y) * 0x165667b1u)
    ^ (salt * 0x9e3779b9u);
  h = h ^ (h >> 15u);
  h = h * 0x2c1b3c6du;
  h = h ^ (h >> 12u);
  h = h * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return h;
}

fn terrainGroundGradient(cell: vec2i, salt: u32) -> vec2f {
  let h = terrainGroundHash(cell, salt);
  return vec2f(
    f32(h & 0xffffu) * ${wgslFloat(2 / 65535)} - 1.0,
    f32(h >> 16u) * ${wgslFloat(2 / 65535)} - 1.0,
  );
}

/**
 * Perlin gradient noise with its analytic derivative, scaled to unit variance.
 * Returns (value, d/dx, d/dy) in the SCALED coordinates — the caller divides
 * the derivative by its own wavelength to get world slope, exactly as the meso
 * band does with its value-noise gradient.
 */
fn terrainGroundNoiseGrad(point: vec2f, salt: u32) -> vec3f {
  let base = floor(point);
  let local = point - base;
  let cell = vec2i(base);
  let blend = local * local * local * (local * (local * 6.0 - vec2f(15.0)) + vec2f(10.0));
  let blendSlope = 30.0 * local * local * (local * (local - vec2f(2.0)) + vec2f(1.0));
  let ga = terrainGroundGradient(cell, salt);
  let gb = terrainGroundGradient(cell + vec2i(1, 0), salt);
  let gc = terrainGroundGradient(cell + vec2i(0, 1), salt);
  let gd = terrainGroundGradient(cell + vec2i(1, 1), salt);
  let va = dot(ga, local);
  let vb = dot(gb, local - vec2f(1.0, 0.0));
  let vc = dot(gc, local - vec2f(0.0, 1.0));
  let vd = dot(gd, local - vec2f(1.0, 1.0));
  let corner = va - vb - vc + vd;
  let value = va + blend.x * (vb - va) + blend.y * (vc - va) + blend.x * blend.y * corner;
  let derivative = ga
    + blend.x * (gb - ga)
    + blend.y * (gc - ga)
    + blend.x * blend.y * (ga - gb - gc + gd)
    + blendSlope * (blend.yx * corner + vec2f(vb - va, vc - va));
  return vec3f(value, derivative) * ${wgslFloat(GROUND_NOISE_GAIN)};
}

fn terrainGroundNoise(point: vec2f, salt: u32) -> f32 {
  return terrainGroundNoiseGrad(point, salt).x;
}

/** (vegetated share, vegetated share x dryness) for one material id. */
fn terrainGroundCoverOf(materialIndex: i32) -> vec2f {
${COVER_WGSL}
  return vec2f(0.0, 0.0);
}

/**
 * An octave's weight: full until the footprint reaches an eighth of its
 * wavelength, gone by a third. Procedural noise is band-limited by this fade
 * alone — there is no mip chain under it — so each octave converges well before
 * one period per pixel.
 */
fn terrainGroundOctaveWeight(wavelengthMeters: f32, footprintMeters: f32) -> f32 {
  return 1.0 - smoothstep(wavelengthMeters * 0.125, wavelengthMeters * 0.34, footprintMeters);
}

/**
 * A patch mask with an EDGE, centred on zero.
 *
 * smoothstep across the field's own zero, so the mean is exactly a half for
 * any width and the centred mask is exactly mean-zero — which is what lets the
 * stack keep the scene mean without a correction. The width is the largest of
 * three claims: the softness the caller asked for, a world-space floor so a
 * boundary is never a painted line under a low pass, and twice the screen
 * derivative of the field, so the edge antialiases itself.
 */
fn terrainGroundPatchMask(
  field: vec3f,
  wavelength: f32,
  axis: mat2x2f,
  softness: f32,
  worldDdx: vec2f,
  worldDdy: vec2f,
) -> f32 {
  let worldGradient = (transpose(axis) * field.yz) * (1.0 / wavelength);
  let gradientLength = max(length(worldGradient), 1e-5);
  let screenWidth = length(vec2f(
    dot(worldGradient, worldDdx),
    dot(worldGradient, worldDdy)));
  let width = max(
    max(softness, gradientLength * ${wgslFloat(GROUND_VIGOUR_EDGE_FLOOR_METERS)}),
    2.0 * screenWidth);
  return smoothstep(-width, width, field.x) - 0.5;
}

/** exp(c0 + c1 t + c2 t^2), the fitted scrub expectations. */
fn terrainGroundExpectation(fit: vec3f, threshold: f32) -> f32 {
  return exp(fit.x + fit.y * threshold + fit.z * threshold * threshold);
}

struct TerrainGroundPatch {
  /** Multiplies surface albedo; mean one over the plane by construction. */
  albedoScale: vec3f,
  /** Bare-ground coverage, already faded to its expectation at range. */
  bare: f32,
  /** The fragment's shaped dryness, for the scrub palette and density. */
  dryness: f32,
  /** The patch octaves, reused as the scrub's clustering driver. */
  cluster: f32,
  /** The vigour stack, for terms that want lush ground to differ from pale. */
  vigour: f32,
};

/**
 * Terms 1 and 2: the dryness remap and the bare-ground patches.
 *
 * 'drynessBase' is the classifier's own answer for this fragment (0 = Grass,
 * 1 = DryGrass). Everything here perturbs THAT driver and then converts the
 * change to a ratio between the two reference albedos, so a page-splat
 * boundary, a residency-level change and the coarse fallback all keep the same
 * continuous field over them.
 */
fn terrainGroundPatchwork(
  worldXz: vec2f,
  warpedXz: vec2f,
  drynessBase: f32,
  topographic: f32,
  classified: f32,
  vigourBias: f32,
  worldDdx: vec2f,
  worldDdy: vec2f,
  footprintMeters: f32,
) -> TerrainGroundPatch {
  let coarseWeight = terrainGroundOctaveWeight(
    ${wgslFloat(GROUND_PATCH_COARSE_METERS)}, footprintMeters);
  let midWeight = terrainGroundOctaveWeight(
    ${wgslFloat(GROUND_PATCH_MID_METERS)}, footprintMeters);
  // Both octaves read the UNWARPED position. A first draft ran the coarse one
  // through the de-tile warp, on the theory that a curl-free displacement buys
  // organic outlines for free; what it actually buys is MARBLING — that warp is
  // a smooth ~40 m displacement, and pushing a smooth field through it turns
  // compact patches into long swirled bands, which is the camouflage read this
  // whole design is trying to avoid. The noise's own shapes are organic enough;
  // the octaves are decorrelated by rotation and salt instead.
  // Both octaves are read WITH their gradients: the value drives dryness, the
  // gradient antialiases the vigour masks below, and the gradient costs
  // nothing extra — this primitive computes it either way.
  let coarseField = terrainGroundNoiseGrad(
    ${rotationWgsl(GROUND_PATCH_COARSE_DEGREES)} * worldXz
      * ${wgslFloat(1 / GROUND_PATCH_COARSE_METERS)}, 0x4d1u);
  let midField = terrainGroundNoiseGrad(
    ${rotationWgsl(GROUND_PATCH_MID_DEGREES)} * worldXz
      * ${wgslFloat(1 / GROUND_PATCH_MID_METERS)}, 0x91f3u);
  let coarse = coarseField.x * coarseWeight;
  let mid = midField.x * midWeight;
  let driver = coarse * 0.78 + mid * 0.62;
  // Odd shaping: patches with shoulders instead of a haze, and a zero mean that
  // survives the shaping exactly.
  let shaped = driver / (abs(driver) + ${wgslFloat(GROUND_DRYNESS_SHAPE)});
  // The LUSH half of the excursion is spent only where the classifier has
  // actually resolved this ground. Coarse and unresident pages fall back to a
  // continuous Grass base — an assumption, not a measurement — and a remap
  // free to run lusher than Grass on top of that assumption turns a whole
  // streaming frame green before the pages land (seen, twice). Drying is
  // always allowed: it cannot manufacture a meadow.
  let raw = clamp(
    shaped * ${wgslFloat(GROUND_DRYNESS_AMPLITUDE)} + topographic,
    -0.65,
    0.65);
  let shift = mix(max(raw, 0.0), raw, clamp(classified, 0.0, 1.0));
  let dryness = clamp(drynessBase + shift, -0.45, 1.45);
  let axis = vec3f(
    ${wgslFloat(GROUND_DRYNESS_LOG_RATIO[0])},
    ${wgslFloat(GROUND_DRYNESS_LOG_RATIO[1])},
    ${wgslFloat(GROUND_DRYNESS_LOG_RATIO[2])});
  // exp(k x) has mean exp(k^2 var / 2) for a zero-mean x, so the ratio is
  // divided by exactly that: the field is mean-one per channel, not mean-one in
  // log space, and the linear mean is the one the light rig integrates.
  let variance = ${wgslFloat(
    GROUND_DRYNESS_SHAPE_VARIANCE * GROUND_DRYNESS_AMPLITUDE * GROUND_DRYNESS_AMPLITUDE,
  )};
  let bias = exp(axis * axis * (0.5 * variance));
  let albedoScale = exp(axis * (dryness - drynessBase)) / bias;

  // ---- vigour: the patchwork a meadow actually has ------------------------
  //
  // Threshold softness is itself a field, so some boundaries are crisp and
  // others dissolve: uniform edge hardness at a uniform scale is what reads as
  // camouflage, and real land cover mixes both.
  // Each mask's softness is driven by the OTHER octave: a mask whose softness
  // reads its own field gets the same width at every boundary it draws, since
  // a boundary is where that field is zero, and uniform edge hardness is the
  // camouflage tell this is here to avoid.
  let vigourSoftnessCoarse = mix(
    ${wgslFloat(GROUND_VIGOUR_EDGE_MIN)},
    ${wgslFloat(GROUND_VIGOUR_EDGE_MAX)},
    clamp(midField.x * 0.5 + 0.5, 0.0, 1.0));
  let vigourSoftnessFine = mix(
    ${wgslFloat(GROUND_VIGOUR_EDGE_MIN)},
    ${wgslFloat(GROUND_VIGOUR_EDGE_MAX)},
    clamp(coarseField.x * 0.5 + 0.5, 0.0, 1.0));
  let fineWeight = terrainGroundOctaveWeight(
    ${wgslFloat(GROUND_VIGOUR_FINE_METERS)}, footprintMeters);
  var vigour = 0.0;
  vigour += terrainGroundPatchMask(
    coarseField,
    ${wgslFloat(GROUND_PATCH_COARSE_METERS)},
    ${rotationWgsl(GROUND_PATCH_COARSE_DEGREES)},
    vigourSoftnessCoarse,
    worldDdx,
    worldDdy) * ${wgslFloat(GROUND_VIGOUR_COARSE_AMPLITUDE)} * coarseWeight;
  vigour += terrainGroundPatchMask(
    midField,
    ${wgslFloat(GROUND_PATCH_MID_METERS)},
    ${rotationWgsl(GROUND_PATCH_MID_DEGREES)},
    vigourSoftnessFine,
    worldDdx,
    worldDdy) * ${wgslFloat(GROUND_VIGOUR_MID_AMPLITUDE)} * midWeight;
  if (fineWeight > 0.002) {
    let fineField = terrainGroundNoiseGrad(
      ${rotationWgsl(GROUND_VIGOUR_FINE_DEGREES)} * worldXz
        * ${wgslFloat(1 / GROUND_VIGOUR_FINE_METERS)}, 0x6b27u);
    vigour += terrainGroundPatchMask(
      fineField,
      ${wgslFloat(GROUND_VIGOUR_FINE_METERS)},
      ${rotationWgsl(GROUND_VIGOUR_FINE_DEGREES)},
      vigourSoftnessFine,
      worldDdx,
      worldDdy) * ${wgslFloat(GROUND_VIGOUR_FINE_AMPLITUDE)} * fineWeight;
  }
  // The crease: a ridge along an ISO-LINE of the mid octave, which has a
  // drainage net's shape. Offset from that octave's zero set on purpose — the
  // zero set is where its own patch mask puts a boundary, and a crease there
  // would outline every patch. Read from the UNWEIGHTED value and faded as a
  // whole, because a ridge of a field faded toward zero is a ridge everywhere.
  let crease = max(0.0, 1.0 - abs(midField.x - ${wgslFloat(GROUND_VIGOUR_CREASE_OFFSET)})
    * ${wgslFloat(GROUND_VIGOUR_CREASE_SHARPNESS)});
  vigour -= (crease - ${wgslFloat(GROUND_VIGOUR_CREASE_MEAN)})
    * ${wgslFloat(GROUND_VIGOUR_CREASE_AMPLITUDE)} * midWeight;
  // Landform: hollows and shaded ground are richer, crests and steep ground
  // paler. Same bounded authority as the dryness term's.
  //
  // The gain rises as the dryness mosaic runs out. On pure Grass the remap
  // above can only push toward straw and has no structure of its own, so
  // without this a lush meadow keeps the single smooth green this whole file
  // exists to break up; on mixed ground the gain is one and nothing that was
  // tuned against the mosaic moves.
  let vigourGain = mix(
    ${wgslFloat(GROUND_VIGOUR_LUSH_GAIN)},
    1.0,
    clamp(drynessBase * 1.6, 0.0, 1.0));
  vigour = clamp((vigour + vigourBias) * vigourGain, -1.6, 1.6);
  let vigourAxis = vec3f(
    ${wgslFloat(GROUND_VIGOUR_LOG_AXIS[0])},
    ${wgslFloat(GROUND_VIGOUR_LOG_AXIS[1])},
    ${wgslFloat(GROUND_VIGOUR_LOG_AXIS[2])});
  // The correction is the stack's variance AT THIS GAIN: exp(k x) has mean
  // exp(k^2 var / 2), and scaling x by g scales that variance by g squared. A
  // fixed correction would brighten exactly the lush ground the gain exists
  // for, which is the opposite of mean-preserving.
  let vigourBiasCorrection = exp(
    vigourAxis * vigourAxis
      * (0.5 * ${wgslFloat(GROUND_VIGOUR_STACK_VARIANCE)} * vigourGain * vigourGain));
  let vigourScale = exp(vigourAxis * vigour) / vigourBiasCorrection;

  // One octave for the bare patches, plus the MID octave this function already
  // holds as its fine detail. A fourth evaluation bought a 6 m ripple that the
  // material tile carries anyway at the range it is resolved, and this shader
  // pays for every hash on every pixel of the screen.
  let bareCoarseWeight = terrainGroundOctaveWeight(
    ${wgslFloat(GROUND_BARE_COARSE_METERS)}, footprintMeters);
  let bareFineWeight = midWeight;
  let bareField = terrainGroundNoise(
      ${rotationWgsl(GROUND_BARE_COARSE_DEGREES)} * worldXz
        * ${wgslFloat(1 / GROUND_BARE_COARSE_METERS)}, 0x2ab7u) * bareCoarseWeight
    + mid * 0.5;
  let bareResolved = smoothstep(
    ${wgslFloat(GROUND_BARE_THRESHOLD_LOW)},
    ${wgslFloat(GROUND_BARE_THRESHOLD_HIGH)},
    bareField);
  // Fade to the measured expectation, not to zero: a term that vanishes with
  // range takes its own mean out of the far field and draws the ring it was
  // trying to avoid.
  let bareResolve = max(bareCoarseWeight, bareFineWeight);
  let bare = mix(${wgslFloat(GROUND_BARE_EXPECTED_COVERAGE)}, bareResolved, bareResolve);

  var composed: TerrainGroundPatch;
  composed.albedoScale = albedoScale * vigourScale;
  composed.bare = bare;
  composed.dryness = dryness;
  // Both octaves, so the scrub's clustering follows the same hundred-metre
  // structure the colour does — a thicket in a patch the eye already reads as
  // rough ground, rather than an independent field fighting it.
  composed.cluster = coarse * 0.62 + mid * 0.5;
  composed.vigour = vigour;
  return composed;
}

struct TerrainGroundScrub {
  /** Crown coverage, antialiased and mean-preserving. */
  crown: f32,
  /** Crown height above the sward, metres — drives tone and the shadow test. */
  height: f32,
  /** Shape tone: a crown's flanks are darker than the cap it presents up. */
  tone: f32,
  /** Direct-light occlusion from crowns up-sun of this fragment. */
  shade: f32,
  /** Ambient occlusion under and around the crowns. */
  occlusion: f32,
  /** World xz slope of the crown surface, for the dome shading. */
  slope: vec2f,
};

/**
 * One scrub population.
 *
 * The field is 'height = max(0, noise - threshold)', so a bush is where the
 * noise clears the threshold and its profile is the noise itself. Everything
 * else is read off that one evaluation:
 *
 *   crown      clamp(height / edge), with 'edge' widened to the screen-space
 *              derivative of the height — an exact one-pixel antialias, then
 *              scaled by the measured edge model so the crown keeps its mean as
 *              it blurs with range.
 *   slope      the analytic gradient, which is the same surface the mask is.
 *   occlusion  a ramp that starts BELOW the threshold, so the ground darkens
 *              as it approaches a crown rather than at its rim.
 *   shade      two taps up-sun: a crown occludes this fragment when it stands
 *              higher than the sun ray does at that distance.
 *
 * 'parallax' offsets the crown along the ground-projected view ray by its own
 * height, which is what makes a crown read as standing UP rather than as a
 * stain: the ground texel it covers is the one behind it. The occlusion and the
 * shadow stay at the stem.
 */
fn terrainGroundScrub(
  worldXz: vec2f,
  axis: mat2x2f,
  wavelength: f32,
  threshold: f32,
  heightMeters: f32,
  parallax: vec2f,
  sunStep: vec2f,
  sunTangent: f32,
  worldDdx: vec2f,
  worldDdy: vec2f,
  footprintMeters: f32,
  salt: u32,
) -> TerrainGroundScrub {
  var result: TerrainGroundScrub;
  let inverse = 1.0 / wavelength;
  let coverage = terrainGroundExpectation(
    ${fitWgsl(GROUND_SCRUB_COVERAGE_FIT)}, threshold);
  let meanHeight = terrainGroundExpectation(
    ${fitWgsl(GROUND_SCRUB_HEIGHT_FIT)}, threshold);
  let crownMean = meanHeight / max(coverage, 1e-5);
  let expectedCrown = ${wgslFloat(GROUND_SCRUB_EDGE_PREFACTOR)} * coverage * crownMean
    / (crownMean + ${wgslFloat(GROUND_SCRUB_EDGE_MODEL * GROUND_SCRUB_CROWN_WIDTH)});
  let expectedOcclusion = terrainGroundExpectation(
    ${fitWgsl(GROUND_SCRUB_OCCLUSION_FIT)}, threshold)
    * ${wgslFloat(GROUND_SCRUB_OCCLUSION_STRENGTH)};
  // A shadow is visible in proportion to how far it reaches past the crown that
  // casts it; at a high sun it is under the bush and there is nothing to see.
  let reach = heightMeters * crownMean / max(sunTangent, 0.05);
  let expectedShade = expectedCrown
    * clamp(reach / (reach + wavelength * 0.5), 0.0, 1.0)
    * ${wgslFloat(GROUND_SCRUB_SHADOW_STRENGTH)};

  result.crown = expectedCrown;
  result.height = heightMeters * meanHeight;
  result.tone = ${wgslFloat(GROUND_SCRUB_TONE_MEAN)};
  result.shade = expectedShade;
  result.occlusion = expectedOcclusion;
  result.slope = vec2f(0.0, 0.0);

  let resolve = terrainGroundOctaveWeight(wavelength, footprintMeters);
  if (resolve <= 0.002) { return result; }

  let rotated = axis * worldXz;
  let crownPoint = (rotated + axis * parallax) * inverse;
  let field = terrainGroundNoiseGrad(crownPoint, salt);
  // SQUARED clearance. A Perlin field thresholded flat gives worms: long
  // filaments wherever it runs just above the threshold. Squaring drops those
  // to nothing and keeps the true maxima, so a crown is a crown; the profile
  // also gives the dome its curvature for free, since d(h^2) = 2 h dh.
  let clearance = max(0.0, field.x - threshold);
  let height = clearance * clearance;
  let worldGradient = (transpose(axis) * field.yz) * inverse;
  // The crown edge, widened to whatever this pixel actually covers. The
  // derivative is analytic — no fwidth, which would spike where the field is
  // clamped at the rim — and the gain puts the mean back where the near field
  // had it, capped so a deep-subpixel crown cannot turn into speckle. The
  // widening is evaluated at the clearance where the mask crosses one half,
  // which is where its own screen derivative decides the edge.
  let screenWidth = length(vec2f(dot(worldGradient, worldDdx), dot(worldGradient, worldDdy)));
  let edge = max(
    ${wgslFloat(GROUND_SCRUB_CROWN_WIDTH)},
    ${wgslFloat(2 * Math.sqrt(GROUND_SCRUB_CROWN_WIDTH))} * screenWidth);
  let gain = min(
    (crownMean + ${wgslFloat(GROUND_SCRUB_EDGE_MODEL)} * edge)
      / (crownMean + ${wgslFloat(GROUND_SCRUB_EDGE_MODEL * GROUND_SCRUB_CROWN_WIDTH)}),
    ${wgslFloat(GROUND_SCRUB_CROWN_GAIN_CAP)});
  let crown = min(clamp(height / edge, 0.0, 1.0) * gain, 1.0);

  // Ambient: the ground starts to darken before the crown begins, which is what
  // a bush actually does to the sky above the grass at its foot.
  let occlusion = clamp(
    (field.x - (threshold - ${wgslFloat(GROUND_SCRUB_OCCLUSION_BELOW)}))
      * ${wgslFloat(1 / GROUND_SCRUB_OCCLUSION_SPAN)},
    0.0,
    1.0) * ${wgslFloat(GROUND_SCRUB_OCCLUSION_STRENGTH)};

  // Direct: the sun ray rises by (distance * tangent); a crown shades this
  // fragment when it stands above that line. Skipped outright when the sun is
  // high enough that a crown's shadow is shorter than the crown is wide.
  var shade = 0.0;
  if (sunTangent < ${wgslFloat(GROUND_SCRUB_SHADOW_SUN_TANGENT)}) {
    let nearClear = max(0.0, terrainGroundNoise(
      crownPoint + axis * sunStep * ${wgslFloat(GROUND_SCRUB_SHADOW_TAP_NEAR)}, salt) - threshold);
    let farClear = max(0.0, terrainGroundNoise(
      crownPoint + axis * sunStep * ${wgslFloat(GROUND_SCRUB_SHADOW_TAP_FAR)}, salt) - threshold);
    let nearTap = nearClear * nearClear;
    let farTap = farClear * farClear;
    let nearRise = wavelength * ${wgslFloat(GROUND_SCRUB_SHADOW_TAP_NEAR)} * sunTangent;
    let farRise = wavelength * ${wgslFloat(GROUND_SCRUB_SHADOW_TAP_FAR)} * sunTangent;
    let own = height * heightMeters;
    shade = clamp(
      max(
        (nearTap * heightMeters - nearRise - own) * 1.6,
        (farTap * heightMeters - farRise - own) * 1.2),
      0.0,
      1.0) * ${wgslFloat(GROUND_SCRUB_SHADOW_STRENGTH)} * (1.0 - crown);
  }

  result.crown = mix(expectedCrown, crown, resolve);
  result.height = mix(heightMeters * meanHeight, height * heightMeters, resolve);
  result.shade = mix(expectedShade, shade, resolve);
  result.occlusion = mix(expectedOcclusion, occlusion, resolve);
  // A paraboloid crown would need a second evaluation to find its axis; the
  // field's own gradient already is the crown surface, so the dome shading is
  // free. Weighted by coverage so the rim does not tilt bare ground.
  // d(h^2)/dx = 2 h dh/dx: the crown surface's own slope, in metres per metre.
  // Clamped because a steep crown flank may tilt the shading normal but must
  // never push it through the geometric horizon, which reads as a black rim.
  let domeSlope = worldGradient * (2.0 * clearance * heightMeters) * crown;
  let domeLength = length(domeSlope);
  result.slope = domeSlope
    * (min(domeLength, ${wgslFloat(GROUND_SCRUB_SLOPE_LIMIT)}) / max(domeLength, 1e-4))
    * resolve;
  // Shape tone. The flank of a crown is turned away from the sky and shaded by
  // the foliage above it; its cap is not. This is the same slope the dome
  // shading uses, so a crown cannot be lit as a mound and toned as a disc.
  result.tone = mix(
    ${wgslFloat(GROUND_SCRUB_TONE_MEAN)},
    ${wgslFloat(GROUND_SCRUB_TONE_CAP)} - ${wgslFloat(GROUND_SCRUB_TONE_FLANK)}
      * clamp(domeLength, 0.0, 1.0),
    resolve);
  return result;
}
`;
