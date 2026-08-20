import { saturate, smoothstep } from "@/src/world/noise";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
  type SurfaceMaterialId,
} from "./surfaceMaterials";

/**
 * The land-cover classifier (`4-6`, `4-6b`, `R-27`).
 *
 * INVARIANT THIS FILE OWNS: **one authority classifies the ground, the trees
 * standing on it and the animals living in them.** Before this item there were
 * three independent answers to one question — `classifyBiome`'s threshold
 * cascade, `chooseTreeSpecies`' own rules, and the wildlife habitat table —
 * and nothing made them agree. A treeline could end where the rock started, or
 * 80 m above it, and only a screenshot would say which.
 *
 * **Ten smooth suitability functions, softmaxed and top-4 renormalised**,
 * replacing a cascade of `if (height > x) return BIOME`. The difference is not
 * stylistic: a threshold cascade produces a hard edge at every boundary and a
 * SINGLE answer per point, so a boundary can only ever be a coin flip between
 * two materials — which is exactly what the audit found and what
 * `RENDERING_PLAN.md` calls "material identity is a coin flip between distant
 * vertices". A weight vector has no boundary at all; it has an ecotone.
 *
 * `dayOfYear` is in the signature from the first line, not as a retrofit
 * (§1.6, and the seasonal-family boundary test fails the build otherwise).
 * What it drives is the SNOW weight and nothing else: species mix stays
 * climatic, which `PHASE_2_EXECUTION_PLAN.md` `2-18` requires — flipping
 * forest to grassland with the calendar would delete forests every winter.
 *
 * Class P: pure arithmetic over numbers, WGSL-portable under the `0-4` rules,
 * and emitted as a shared include so the classifier the CPU runs and the one
 * the GPU bakes are the same ten functions.
 */

/** Weights the classifier may assign. Four survive renormalisation. */
export const LAND_COVER_TOP_MATERIALS = 4;

export interface LandCoverInput {
  /** Metres above sea level. */
  readonly elevationMeters: number;
  /** Normalised steepness (1 − normalY): 0 flat, ~0.21 at the angle of repose. */
  readonly slope: number;
  readonly moisture: number;
  /** Normalised temperature from the climate chain, before the seasonal shift. */
  readonly temperature: number;
  /** −1 cool pole-facing … +1 warm equator-facing. */
  readonly aspect: number;
  /** 0 outside the airport blend, 1 on the graded platform. */
  readonly airportInfluence: number;
  /** §1.6: part of this signature from the first line. */
  readonly dayOfYear: number;
  /** Seasonal temperature offset in normalised units; 0 at the reference day. */
  readonly seasonalTemperatureShift: number;
}

export interface LandCoverWeights {
  /** Material ids, most significant first. */
  readonly ids: readonly SurfaceMaterialId[];
  /** Weights summing to 1, aligned with `ids`. */
  readonly weights: readonly number[];
}

/**
 * Softmax temperature. Lower is sharper.
 *
 * **Jittered per point by the drivers themselves** (see
 * `landCoverSoftmaxTemperature`): uniform ecotone sharpness is as much a tell
 * as a straight boundary. Real transitions are abrupt where a soil or drainage
 * break drives them and diffuse where a climate gradient does.
 */
export const LAND_COVER_SOFTMAX_BASE_TEMPERATURE = 0.22;

/** The snowline's reference altitude; the seasonal shift moves it down. */
const SNOWLINE_REFERENCE_METERS = 1_520;
const METERS_PER_NORMALIZED_TEMPERATURE = 2_450;

/**
 * The ten suitabilities, in `SurfaceMaterial` order.
 *
 * Each is a product of smooth factors in [0, 1]. Nothing thresholds; every
 * term is a `smoothstep` whose band is wide enough to be an ecotone rather
 * than an edge, and the WGSL emitter below transliterates these expressions
 * one for one.
 */
export function landCoverSuitabilities(input: LandCoverInput): number[] {
  const {
    elevationMeters: elevation,
    slope,
    moisture,
    temperature,
    aspect,
    airportInfluence,
  } = input;

  // The snowline descends with the season; the reference day leaves it exactly
  // where Phase 3 tuned it.
  const snowline = SNOWLINE_REFERENCE_METERS
    + input.seasonalTemperatureShift * METERS_PER_NORMALIZED_TEMPERATURE
    // Equator-facing slopes hold less snow, pole-facing more: ±90 m, the same
    // aspect strength the treeline uses.
    + aspect * 90;

  const shore = smoothstep(-1, 9, elevation);
  const dry = 1 - smoothstep(0.28, 0.62, moisture);
  const wet = smoothstep(0.3, 0.64, moisture);
  const warm = smoothstep(0.16, 0.34, temperature);
  const gentle = 1 - smoothstep(0.06, 0.26, slope);
  const steep = smoothstep(0.24, 0.58, slope);
  const alpine = smoothstep(420, 980, elevation);
  const lowland = 1 - smoothstep(320, 900, elevation);
  const airfield = saturate(airportInfluence);

  const suitability = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  // Sand: the shore band, and only where it is not steep.
  suitability[SurfaceMaterial.Sand] = (1 - shore) * gentle * 1.35 + 0.02;
  // Grass: the default lowland cover, and what an airfield is mown to.
  suitability[SurfaceMaterial.Grass] =
    shore * lowland * gentle * warm * (0.35 + wet * 0.65) + airfield * 2.4;
  // Forest floor: wet, warm, below the treeline, off the steepest ground.
  suitability[SurfaceMaterial.ForestFloor] =
    shore * wet * warm * (1 - smoothstep(900, 1_350, elevation)) * (1 - steep * 0.8) * 1.1;
  // Shrub: the highland band — drier, cooler, tolerant of slope.
  suitability[SurfaceMaterial.Shrub] =
    shore * alpine * (1 - smoothstep(1_150, 1_650, elevation)) * (0.4 + dry * 0.6) * 0.95;
  // Rock: slope first, altitude second. A cliff is rock at any height.
  suitability[SurfaceMaterial.Rock] = shore * (steep * 1.25 + alpine * 0.55);
  // Snow: above the seasonal snowline, and shed by steep faces.
  suitability[SurfaceMaterial.Snow] =
    smoothstep(snowline - 90, snowline + 130, elevation)
    * (1 - saturate((slope - 0.5) * 2.2))
    * 1.5;
  // Dry grass: the rain-shadow companion to grass, off the ecotone chain.
  suitability[SurfaceMaterial.DryGrass] = shore * lowland * gentle * dry * warm * 0.8;
  // Gravel: scree below cliffs and the wave-washed band above sand.
  suitability[SurfaceMaterial.Gravel] =
    shore * (steep * 0.35 + (1 - shore) * 0.4 + alpine * 0.2);
  // The paved materials are never climatic: `3-9`'s airport SDF paints them.
  suitability[SurfaceMaterial.Asphalt] = 0;
  suitability[SurfaceMaterial.Concrete] = 0;
  return suitability;
}

/**
 * Per-point softmax temperature.
 *
 * Perturbing the TEMPERATURE rather than the outputs is what makes ecotone
 * SHARPNESS vary: a wet, flat boundary blends over a hundred metres and a
 * steep dry one changes in ten. Perturbing the weights afterwards would only
 * add noise to a boundary whose shape was already uniform.
 */
export function landCoverSoftmaxTemperature(input: LandCoverInput): number {
  const sharpening = saturate(input.slope * 2.4) * 0.6 + (1 - saturate(input.moisture)) * 0.25;
  return LAND_COVER_SOFTMAX_BASE_TEMPERATURE * (1.35 - sharpening);
}

/**
 * Classify a point: softmax the suitabilities, keep the top four, renormalise.
 *
 * Top-4 rather than all ten because that is what the atlas stores and what
 * `heightBlendMaxMaterials` caps the shader at; keeping a tail of 1e-3 weights
 * would cost samples for cover nobody can see.
 */
export function classifyLandCover(input: LandCoverInput): LandCoverWeights {
  const suitability = landCoverSuitabilities(input);
  const temperature = Math.max(0.02, landCoverSoftmaxTemperature(input));
  let peak = -Infinity;
  for (const value of suitability) peak = Math.max(peak, value);
  const exponentials = suitability.map((value) => Math.exp((value - peak) / temperature));

  const order = exponentials
    .map((value, id) => ({ id: id as SurfaceMaterialId, value }))
    .sort((first, second) => second.value - first.value)
    .slice(0, LAND_COVER_TOP_MATERIALS);
  const total = order.reduce((sum, entry) => sum + entry.value, 0);
  return {
    ids: order.map((entry) => entry.id),
    weights: order.map((entry) => (total > 0 ? entry.value / total : 0)),
  };
}

/** The dominant material — the nearest thing this file has to the old biome id. */
export function dominantLandCover(weights: LandCoverWeights): SurfaceMaterialId {
  return weights.ids[0] ?? SurfaceMaterial.Grass;
}

/** Weight of one material in a classification, or 0 if it did not survive. */
export function landCoverWeightOf(
  weights: LandCoverWeights,
  material: SurfaceMaterialId,
): number {
  const index = weights.ids.indexOf(material);
  return index >= 0 ? (weights.weights[index] ?? 0) : 0;
}

/**
 * `R-27`'s consumers contract, as data.
 *
 * `chooseTreeSpecies`, `chooseShrubSpecies` and the wildlife habitat rules all
 * read THIS — the classifier's weight vector — rather than each deciding for
 * itself what "forest" means. The canopy share is the forest-floor weight; the
 * open share is grass plus dry grass; the barren share is rock plus gravel
 * plus snow. One number each, and they sum with the shrub weight to 1.
 */
export interface LandCoverHabitat {
  readonly canopy: number;
  readonly open: number;
  readonly scrub: number;
  readonly barren: number;
  readonly shore: number;
}

export function landCoverHabitat(weights: LandCoverWeights): LandCoverHabitat {
  return {
    canopy: landCoverWeightOf(weights, SurfaceMaterial.ForestFloor),
    open: landCoverWeightOf(weights, SurfaceMaterial.Grass)
      + landCoverWeightOf(weights, SurfaceMaterial.DryGrass),
    scrub: landCoverWeightOf(weights, SurfaceMaterial.Shrub),
    barren: landCoverWeightOf(weights, SurfaceMaterial.Rock)
      + landCoverWeightOf(weights, SurfaceMaterial.Gravel)
      + landCoverWeightOf(weights, SurfaceMaterial.Snow),
    shore: landCoverWeightOf(weights, SurfaceMaterial.Sand),
  };
}

// ---------------------------------------------------------------------------
// The WGSL half
// ---------------------------------------------------------------------------

/**
 * The same ten functions, transliterated.
 *
 * Emitted from this file so a change to a suitability moves both halves at
 * once. The parity test compares them point for point on a real adapter, which
 * is the only thing that makes "one authority" true rather than aspirational.
 *
 * Requires `kSaturate` and `kSmoothstep` from the terrain kernel include.
 */
export const LAND_COVER_CLASSIFIER_WGSL = /* wgsl */ `
struct LandCoverInput {
  elevationMeters: f32,
  slope: f32,
  moisture: f32,
  temperature: f32,
  aspect: f32,
  airportInfluence: f32,
  dayOfYear: f32,
  seasonalTemperatureShift: f32,
};

const LAND_COVER_COUNT: u32 = ${SURFACE_MATERIAL_COUNT}u;
const LAND_COVER_TOP: u32 = ${LAND_COVER_TOP_MATERIALS}u;
const LAND_COVER_SOFTMAX_BASE: f32 = ${LAND_COVER_SOFTMAX_BASE_TEMPERATURE};
const LAND_COVER_SNOWLINE_REFERENCE: f32 = ${SNOWLINE_REFERENCE_METERS}.0;
const LAND_COVER_METERS_PER_TEMPERATURE: f32 = ${METERS_PER_NORMALIZED_TEMPERATURE}.0;

fn landCoverSuitabilities(input: LandCoverInput) -> array<f32, ${SURFACE_MATERIAL_COUNT}> {
  let elevation = input.elevationMeters;
  let slope = input.slope;
  let snowline = LAND_COVER_SNOWLINE_REFERENCE
    + input.seasonalTemperatureShift * LAND_COVER_METERS_PER_TEMPERATURE
    + input.aspect * 90.0;
  let shore = kSmoothstep(-1.0, 9.0, elevation);
  let dry = 1.0 - kSmoothstep(0.28, 0.62, input.moisture);
  let wet = kSmoothstep(0.3, 0.64, input.moisture);
  let warm = kSmoothstep(0.16, 0.34, input.temperature);
  let gentle = 1.0 - kSmoothstep(0.06, 0.26, slope);
  let steep = kSmoothstep(0.24, 0.58, slope);
  let alpine = kSmoothstep(420.0, 980.0, elevation);
  let lowland = 1.0 - kSmoothstep(320.0, 900.0, elevation);
  let airfield = kSaturate(input.airportInfluence);

  var suitability: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  suitability[${SurfaceMaterial.Sand}] = (1.0 - shore) * gentle * 1.35 + 0.02;
  suitability[${SurfaceMaterial.Grass}] =
    shore * lowland * gentle * warm * (0.35 + wet * 0.65) + airfield * 2.4;
  suitability[${SurfaceMaterial.ForestFloor}] =
    shore * wet * warm * (1.0 - kSmoothstep(900.0, 1350.0, elevation))
      * (1.0 - steep * 0.8) * 1.1;
  suitability[${SurfaceMaterial.Shrub}] =
    shore * alpine * (1.0 - kSmoothstep(1150.0, 1650.0, elevation))
      * (0.4 + dry * 0.6) * 0.95;
  suitability[${SurfaceMaterial.Rock}] = shore * (steep * 1.25 + alpine * 0.55);
  suitability[${SurfaceMaterial.Snow}] =
    kSmoothstep(snowline - 90.0, snowline + 130.0, elevation)
      * (1.0 - kSaturate((slope - 0.5) * 2.2)) * 1.5;
  suitability[${SurfaceMaterial.DryGrass}] = shore * lowland * gentle * dry * warm * 0.8;
  suitability[${SurfaceMaterial.Gravel}] =
    shore * (steep * 0.35 + (1.0 - shore) * 0.4 + alpine * 0.2);
  suitability[${SurfaceMaterial.Asphalt}] = 0.0;
  suitability[${SurfaceMaterial.Concrete}] = 0.0;
  return suitability;
}

fn landCoverSoftmaxTemperature(input: LandCoverInput) -> f32 {
  let sharpening = kSaturate(input.slope * 2.4) * 0.6
    + (1.0 - kSaturate(input.moisture)) * 0.25;
  return LAND_COVER_SOFTMAX_BASE * (1.35 - sharpening);
}

struct LandCoverWeights {
  ids: vec4f,
  weights: vec4f,
};

/** Softmax, top-4 by selection sort, renormalised. */
fn classifyLandCover(input: LandCoverInput) -> LandCoverWeights {
  var suitability = landCoverSuitabilities(input);
  let temperature = max(0.02, landCoverSoftmaxTemperature(input));
  var peak = -1e30;
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    peak = max(peak, suitability[index]);
  }
  var exponentials: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    exponentials[index] = exp((suitability[index] - peak) / temperature);
  }
  var ids = vec4f(0.0);
  var weights = vec4f(0.0);
  var total = 0.0;
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    var bestIndex = 0u;
    var bestValue = -1.0;
    for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
      if (exponentials[index] > bestValue) {
        bestValue = exponentials[index];
        bestIndex = index;
      }
    }
    exponentials[bestIndex] = -1.0;
    ids[slot] = f32(bestIndex);
    weights[slot] = max(0.0, bestValue);
    total = total + max(0.0, bestValue);
  }
  if (total > 0.0) { weights = weights / total; }
  var result: LandCoverWeights;
  result.ids = ids;
  result.weights = weights;
  return result;
}
`;

// ---------------------------------------------------------------------------
// The page splat bake
// ---------------------------------------------------------------------------

/** Texels a splat bake supersamples per channel texel, per axis. */
export const LAND_COVER_SUPERSAMPLE_EDGE = 2;

/**
 * The splat bake (`4-6`).
 *
 * **Supersample 2x2 and average the WEIGHT VECTORS, not the argmax.** This is
 * the prefiltering that per-vertex point classification structurally cannot
 * do, and it is the albedo analogue of band-limiting: averaging four ids and
 * rounding gives you the id nearest their mean, which at a three-way junction
 * is a material none of the four samples chose. Averaging the vectors gives a
 * mixture, which is what a 2 m texel over a 1 m ecotone actually contains.
 *
 * The season enters HERE and nowhere else: two buckets are baked into the two
 * resident splat slot pairs and cross-faded by `seasonBucketBlend().t`. The
 * classification the ecology reads stays at the reference day.
 *
 * Requires the terrain kernel include (for the moisture and climate chains and
 * `kSmoothstep`/`kSaturate`) and `LAND_COVER_CLASSIFIER_WGSL`.
 */
export const LAND_COVER_SPLAT_BAKE_WGSL = /* wgsl */ `
struct SplatJob {
  // (channel slot texel u, channel slot texel v, height slot texel u,
  //  height slot texel v)
  slots: vec4f,
  // (channel texel size, height texel size, kernel page index, sea level)
  shape: vec4f,
  // (world offset of stored channel texel 0 from the kernel page origin, same
  //  for z, seasonal shift of the LOW bucket, of the HIGH bucket)
  placement: vec4f,
  // (airport influence centre x, centre z, inverse blend radius, day of year)
  airport: vec4f,
};

@group(0) @binding(1) var<storage, read> splatJobs: array<SplatJob>;
@group(0) @binding(2) var splatHeightAtlas: texture_2d<f32>;
@group(0) @binding(3) var splatIdLo: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var splatWeightLo: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var splatIdHi: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var splatWeightHi: texture_storage_2d<rgba8unorm, write>;

/** Slope from the page's own texel grid — never a fixed 2 m difference. */
fn splatSlopeAt(job: SplatJob, heightTexel: vec2f) -> f32 {
  let base = vec2i(job.slots.zw) + vec2i(heightTexel);
  let here = textureLoad(splatHeightAtlas, base, 0).r;
  let east = textureLoad(splatHeightAtlas, base + vec2i(1, 0), 0).r;
  let south = textureLoad(splatHeightAtlas, base + vec2i(0, 1), 0).r;
  let gradient = vec2f(east - here, south - here) / job.shape.y;
  let normalY = 1.0 / sqrt(1.0 + dot(gradient, gradient));
  return 1.0 - normalY;
}

fn splatClassify(job: SplatJob, localX: f32, localZ: f32, shift: f32) -> LandCoverWeights {
  let heightTexel = vec2f(
    (localX - job.placement.x) / job.shape.y,
    (localZ - job.placement.y) / job.shape.y,
  );
  let elevation = textureLoad(
    splatHeightAtlas,
    vec2i(job.slots.zw) + vec2i(heightTexel),
    0,
  ).r - job.shape.w;
  var input: LandCoverInput;
  input.elevationMeters = elevation;
  input.slope = splatSlopeAt(job, heightTexel);
  input.moisture = terrainMoisture(localX, localZ);
  input.temperature = terrainTemperatureFromClimate(terrainClimate(localX, localZ), elevation);
  input.aspect = 0.0;
  // The airport's graded platform is mown grass (1B-6), and its influence is
  // the same rounded-rectangle field the earthworks key on.
  input.airportInfluence = kSaturate(
    1.0 - length(vec2f(localX, localZ) - job.airport.xy) * job.airport.z,
  );
  input.dayOfYear = job.airport.w;
  input.seasonalTemperatureShift = shift;
  return classifyLandCover(input);
}

/** Average the WEIGHT VECTORS of a 2x2 supersample, not their argmax. */
fn splatSupersample(job: SplatJob, localX: f32, localZ: f32, shift: f32) -> LandCoverWeights {
  var accumulated: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    accumulated[index] = 0.0;
  }
  let step = job.shape.x * 0.25;
  for (var sample = 0u; sample < 4u; sample = sample + 1u) {
    let dx = select(-step, step, (sample & 1u) == 1u);
    let dz = select(-step, step, (sample & 2u) == 2u);
    let weights = splatClassify(job, localX + dx, localZ + dz, shift);
    for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
      accumulated[u32(weights.ids[slot])] =
        accumulated[u32(weights.ids[slot])] + weights.weights[slot] * 0.25;
    }
  }
  // Re-select the top four from the AVERAGED vector.
  var result: LandCoverWeights;
  var total = 0.0;
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    var bestIndex = 0u;
    var bestValue = -1.0;
    for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
      if (accumulated[index] > bestValue) {
        bestValue = accumulated[index];
        bestIndex = index;
      }
    }
    accumulated[bestIndex] = -1.0;
    result.ids[slot] = f32(bestIndex);
    result.weights[slot] = max(0.0, bestValue);
    total = total + max(0.0, bestValue);
  }
  if (total > 0.0) { result.weights = result.weights / total; }
  return result;
}

@compute @workgroup_size(8, 8, 1)
fn bakeSplat(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let job = splatJobs[group.z];
  let edge = ${136}u;
  if (id.x >= edge || id.y >= edge) { return; }
  kSelectPage(u32(job.shape.z));

  let localX = job.placement.x + (f32(id.x) + 0.5) * job.shape.x;
  let localZ = job.placement.y + (f32(id.y) + 0.5) * job.shape.x;
  let texel = vec2i(job.slots.xy) + vec2i(i32(id.x), i32(id.y));

  // Ids are stored as unorm over the ten-material axis, so a filtered fetch
  // between two texels lands between two ADJACENT materials on the ecotone
  // axis — which is exactly what the axis was ordered for.
  let scale = 1.0 / f32(LAND_COVER_COUNT - 1u);
  let lo = splatSupersample(job, localX, localZ, job.placement.z);
  textureStore(splatIdLo, texel, lo.ids * scale);
  textureStore(splatWeightLo, texel, lo.weights);
  let hi = splatSupersample(job, localX, localZ, job.placement.w);
  textureStore(splatIdHi, texel, hi.ids * scale);
  textureStore(splatWeightHi, texel, hi.weights);
}
`;
