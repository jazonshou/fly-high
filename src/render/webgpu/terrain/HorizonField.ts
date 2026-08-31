/**
 * The horizon field operator (`6-11`, extracted from `4-7`).
 *
 * INVARIANT THIS FILE OWNS: **there is ONE answer to "how high is the terrain
 * horizon in a given direction", and ONE answer to "does that horizon hide the
 * sun".** Both halves live here, as WGSL text, and every producer and every
 * consumer composes them rather than restating them.
 *
 * Why this file exists at all. `6-8` was asked to give far vegetation the
 * horizon-shadow term the terrain already has, and DECLINED it with an
 * architectural reason worth preserving: the terrain's horizon map is a
 * page-atlas channel addressed through a per-vertex CDLOD slot lane, and the
 * detail path structurally cannot carry that lane, because detail materials are
 * SHARED across presentation chunks by design (the draw-call architecture the
 * `RENDERING_PLAN.md:837` ratchet exists to protect). Both routes it priced —
 * marching the height pyramid live, or giving the pyramid its own horizon
 * layers — were rejected as a SECOND answer to a question that already has an
 * owner, "unless the horizon operator is first extracted into a shared WGSL
 * include so both consumers run one operator". This is that extraction. It is
 * the precondition, not the feature.
 *
 * What "one operator" has to mean here, precisely. Two representations of the
 * same stand must not disagree about whether the sun is up, so the shared part
 * is the WHOLE chain that turns geometry into a visibility scalar: march ->
 * max-of-pairs -> sin(atan) -> pack -> unpack -> azimuth interpolation ->
 * soft band. Anything left un-shared is somewhere the two can drift. What is
 * deliberately NOT shared is the height SOURCE and the texture FETCH, because
 * those are exactly what differ between a page bake and a global one — and
 * neither can move the answer for a given height field.
 *
 * The lit-brightness lesson (wave R's +28%, `D-14`'s 1.53%) applied one level
 * up: calibrate the OPERATOR across representations, not the constants either
 * side of it.
 */

/**
 * Azimuths marched. Sixteen keeps the visibility integral smooth.
 *
 * `4-7`'s numbers, unchanged by the extraction — every value here was already
 * load-bearing for the page bake and moving one silently would move every
 * baked page's bits.
 */
export const HORIZON_FIELD_AZIMUTHS_MARCHED = 16;

/** Azimuths STORED, as the max of each adjacent marched pair (conservative). */
export const HORIZON_FIELD_AZIMUTHS_STORED = 8;

/** Steps per azimuth, geometrically spaced from one texel to the far plane. */
export const HORIZON_FIELD_MARCH_STEPS = 24;

/**
 * The producer half: march a height field into a packed 8-azimuth horizon.
 *
 * COMPOSITION CONTRACT — the composer MUST define, before this text:
 *
 * ```wgsl
 * fn horizonFieldHeightAt(worldX: f32, worldZ: f32) -> f32
 * ```
 *
 * That hole is the whole reason this is text rather than a function taking a
 * sampler: WGSL has no closures and no function pointers, so a height source
 * that differs per composer (the page bake reads its own atlas texels inside
 * the page and the pyramid beyond; the pyramid bake reads only the pyramid)
 * can only be injected textually. The alternative — a mode flag branching
 * inside the march — would put a per-step branch in the hottest loop in the
 * bake and make the two paths share code without sharing behaviour.
 */
export const HORIZON_FIELD_MARCH_WGSL = /* wgsl */ `
/** The packed field: eight stored azimuths across two rgba8 texels. */
struct HorizonFieldPacked {
  a: vec4f,
  b: vec4f,
};

/**
 * Azimuth s is marched at angle (s + 0.5) * 2pi/16.
 *
 * The half-step is what the consumer's lookup subtracts back off, so this
 * function and 'horizonFieldShadow''s index arithmetic are a matched pair:
 * stored bin s covers marched pair (2s, 2s+1), whose centre is s*pi/4 + pi/8.
 */
fn horizonFieldAzimuthDirection(azimuth: u32) -> vec2f {
  let angle = (f32(azimuth) + 0.5) * ${(Math.PI * 2) / HORIZON_FIELD_AZIMUTHS_MARCHED};
  return vec2f(cos(angle), sin(angle));
}

/**
 * March every azimuth and record the maximum slope seen along each.
 *
 * 'growth' and 'firstRadius' are PER JOB, not constants: the ratio is chosen
 * so the last step lands at the reach and the first step is one texel of the
 * source being marched — which is level-dependent for a page, so a baked-in
 * ratio overshoots by four orders of magnitude at coarse levels and every step
 * past the field's edge is wasted on a clamped sample.
 *
 * Geometric spacing rather than uniform: the near field is where a metre of
 * relief matters, and 24 steps spread uniformly over 45 km would step past
 * every ridge that matters.
 */
fn horizonFieldMarch(
  worldX: f32,
  worldZ: f32,
  centreHeight: f32,
  firstRadius: f32,
  growth: f32,
  slopes: ptr<function, array<f32, ${HORIZON_FIELD_AZIMUTHS_MARCHED}>>,
) {
  for (var azimuth = 0u; azimuth < ${HORIZON_FIELD_AZIMUTHS_MARCHED}u; azimuth = azimuth + 1u) {
    let dir = horizonFieldAzimuthDirection(azimuth);
    var maxSlope = 0.0;
    var radius = firstRadius;
    for (var step = 0u; step < ${HORIZON_FIELD_MARCH_STEPS}u; step = step + 1u) {
      let sampleHeight = horizonFieldHeightAt(worldX + dir.x * radius, worldZ + dir.y * radius);
      maxSlope = max(maxSlope, (sampleHeight - centreHeight) / radius);
      radius = radius * growth;
    }
    (*slopes)[azimuth] = maxSlope;
  }
}

/**
 * Eight stored azimuths, each the MAX of a marched pair.
 *
 * A horizon map that over-shadows slightly is a shadow that is a little too
 * long; one that under-shadows is light leaking through a ridge. The max is
 * the conservative direction, chosen deliberately.
 */
fn horizonFieldPack(
  slopes: ptr<function, array<f32, ${HORIZON_FIELD_AZIMUTHS_MARCHED}>>,
) -> HorizonFieldPacked {
  var packed = HorizonFieldPacked(vec4f(0.0), vec4f(0.0));
  for (var stored = 0u; stored < ${HORIZON_FIELD_AZIMUTHS_STORED}u; stored = stored + 1u) {
    let slope = max((*slopes)[stored * 2u], (*slopes)[stored * 2u + 1u]);
    // sin(atan(s)) is the fraction of the sky column the horizon covers, and
    // it is already in [0, 1) for a positive slope — an exact unorm fit.
    let value = slope / sqrt(1.0 + slope * slope);
    if (stored < 4u) {
      packed.a[stored] = value;
    } else {
      packed.b[stored - 4u] = value;
    }
  }
  return packed;
}
`;

/**
 * The consumer half: packed horizon + sun direction -> direct-light visibility.
 *
 * Takes the two packed texels as VALUES rather than sampling them itself,
 * because the fetch is what legitimately differs between consumers — the
 * terrain surface reads a page-atlas slot through its CDLOD lane, and the
 * detail path reads a global texture through a world-space mapping. Everything
 * downstream of the fetch is here, so the two cannot drift.
 *
 * The stored value is sin(horizonElevation) and the sun direction is a unit
 * vector toward the sun, so 'sunDirection.y' is sin(sunElevation) and the
 * comparison is one subtraction — no trigonometry per fragment.
 *
 * Fix-pack T8's shape is preserved exactly: the soft band is floored by the
 * caller and the compared elevation carries a per-fragment spatial jitter,
 * because a narrow fixed band drew the coarse horizon field's iso-contours as
 * stripes on close slopes at low sun. A COARSER field wants a WIDER band, which
 * is why the band is a parameter here rather than a constant — the pyramid
 * consumer is four orders of magnitude coarser than the L0 page consumer and
 * would draw exactly that artifact at the terrain's own band.
 *
 * Residency is deliberately NOT checked here. A consumer whose field is absent
 * must decide for itself what absent means, and both of today's consumers
 * answer "fully lit" through their own fallback — see the sentinel note in
 * 'GlobalHeightPyramid'.
 */
export const HORIZON_FIELD_LOOKUP_WGSL = /* wgsl */ `
fn horizonFieldShadow(
  packedA: vec4f,
  packedB: vec4f,
  sunDirection: vec3f,
  band: f32,
  jitter: f32,
) -> f32 {
  if (sunDirection.y <= 0.0) { return 1.0; }
  let horizontal = max(1e-5, length(sunDirection.xz));
  // The bake marches azimuth s with direction angle (s + 0.5) * pi/4 in stored
  // units, so the lookup index is the angle in those units minus the half-step.
  let angle = atan2(sunDirection.z / horizontal, sunDirection.x / horizontal);
  let index = angle * ${(4 / Math.PI).toFixed(9)} - 0.5;
  let wrapped = index - floor(index * 0.125) * 8.0;
  let low = floor(wrapped);
  let blend = wrapped - low;
  var slots = array<f32, ${HORIZON_FIELD_AZIMUTHS_STORED}>(
    packedA.x, packedA.y, packedA.z, packedA.w,
    packedB.x, packedB.y, packedB.z, packedB.w,
  );
  let lowIndex = u32(low);
  let highIndex = u32(low + 1.0) % ${HORIZON_FIELD_AZIMUTHS_STORED}u;
  let horizonSin = mix(slots[lowIndex], slots[highIndex], blend);
  // The jitter breaks the terminator's iso-contour into unstructured penumbra
  // instead of stripes. It is a spatial hash, not a temporal one: a per-frame
  // jitter would crawl.
  let jitteredSun = sunDirection.y + (jitter - 0.5) * band * 0.9;
  // Never reversed: 'band' is floored positive by every caller, and a reversed
  // pair would turn this soft terminator into a hard step (the recorded
  // degeneracy). The source scan in tests asserts the property.
  return smoothstep(horizonSin - band, horizonSin + band, jitteredSun);
}
`;
