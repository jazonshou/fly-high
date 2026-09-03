import { saturate, smoothstep } from "@/src/world/noise";
import {
  SOIL_LITTER_DEEP_METERS,
  SOIL_LITTER_THIN_METERS,
  soilLitterFactor,
} from "../detail/densityField";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
  type SurfaceMaterialId,
} from "./surfaceMaterials";
import { TERRAIN_PAGE_HYDROLOGY_ENCODING } from "./TerrainEvolutionContract";
import {
  TERRAIN_TWI_DRY,
  TERRAIN_TWI_SLOPE_EPSILON,
  TERRAIN_TWI_WET,
  terrainSlopeAngleFromNormalizedSteepness,
  terrainTopographicWetnessIndex,
  terrainTopographicWetnessToUnit,
} from "./TerrainPageHydrology";

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
  /**
   * Real upstream area from the erosion page. When present it supersedes the
   * pre-erosion moisture proxy for wetness; omission preserves analytic parity.
   */
  readonly flowAccumulationAreaM2?: number;
  /**
   * `6-6`: metres of soil from the page's soil-depth channel. Deep soil is
   * deep litter, and litter is what makes a forest floor read as forest floor
   * rather than as bare ground under trees. Omission preserves analytic parity
   * exactly as `flowAccumulationAreaM2`'s does.
   */
  readonly soilDepthMeters?: number;
  /**
   * `6-8`: true crown cover of the canopy standing on this texel, from
   * `densityField`'s `canopyClosure` — the ONE closure, read through the one
   * sanctioned entry point. Omission reads 0, which leaves every suitability
   * at its pre-6-8 value; the CPU ecology callers do not supply it, so the
   * classification the species and wildlife rules read is unmoved and only the
   * page splat bake (which does supply it) changes.
   */
  readonly canopyClosure?: number;
  /** `6-8`: absolute grass-sward cover, canopy-suppressed. Omission reads 0. */
  readonly grassCover?: number;
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
 * `6-6`'s litter seam: how much duff the soil column under this texel carries.
 *
 * The mapping is `densityField`'s — imported, not restated, because litter is
 * a vegetation product and terrain reaches vegetation through exactly one
 * entry point (the boundary test enforces it). Absent soil depth returns the
 * neutral 0, which leaves every suitability at its pre-6-6 value.
 */
export const LAND_COVER_FOREST_FLOOR_LITTER_GAIN = 0.35;

export function landCoverLitter(input: LandCoverInput): number {
  if (input.soilDepthMeters === undefined) return 0;
  return soilLitterFactor(input.soilDepthMeters);
}

/**
 * `6-8`'s two canopy seams.
 *
 * Forest floor was previously inferred from CLIMATE — wet, warm, below the
 * treeline — which is the recipe for where forest *could* grow, not for where
 * it stands. The density field already answers the second question, and its
 * answer includes the glade, windthrow and succession structure that climate
 * alone cannot express, so a clearing inside a wet warm province classified as
 * closed forest floor and now classifies as what it is. The grass seam is the
 * complement: a sward is ground the canopy left open, and `GroundCoverSystem`
 * stops placing blades at 80 m, so past that the terrain material is the only
 * thing that can say a meadow is a meadow.
 */
export const LAND_COVER_CANOPY_CLOSURE_GAIN = 0.55;
export const LAND_COVER_GRASS_COVER_GAIN = 0.45;

/** One classifier seam: real drainage when available, climatic proxy otherwise. */
export function landCoverWetness(input: LandCoverInput): number {
  if (input.flowAccumulationAreaM2 === undefined) return saturate(input.moisture);
  return terrainTopographicWetnessToUnit(terrainTopographicWetnessIndex(
    input.flowAccumulationAreaM2,
    terrainSlopeAngleFromNormalizedSteepness(input.slope),
  ));
}

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
    temperature,
    aspect,
    airportInfluence,
  } = input;
  const wetness = landCoverWetness(input);

  // The snowline descends with the season; the reference day leaves it exactly
  // where Phase 3 tuned it.
  const snowline = SNOWLINE_REFERENCE_METERS
    + input.seasonalTemperatureShift * METERS_PER_NORMALIZED_TEMPERATURE
    // Equator-facing slopes hold less snow, pole-facing more: ±90 m, the same
    // aspect strength the treeline uses.
    + aspect * 90;

  // The beach band is METRES of elevation, not tens of them. At
  // `smoothstep(-1, 9, ...)` every coastal plain up to ~9 m classified as
  // sand — measured against a real seed, a forested plain came out a desert.
  // 3 m matches the density field's own shoreline gate
  // (`smoothstep(1.5, 7, elevation)`), so the ground and the plants agree
  // about where the beach ends.
  const shore = smoothstep(-1, 3, elevation);
  const dry = 1 - smoothstep(0.28, 0.62, wetness);
  const wet = smoothstep(0.3, 0.64, wetness);
  const warm = smoothstep(0.16, 0.34, temperature);
  // `6-13`: ONE partition of the slope axis, hinged on the angle of repose.
  //
  // These two terms describe the SAME physical transition — ground that holds
  // soil versus ground that sheds it — so they must be complementary. They
  // were not: `gentle` reached its half-value at slope 0.16 and `steep` at
  // 0.41, a quarter of the axis apart, and BOTH sat in their flat tails across
  // 0.24-0.26. Measured there: gentle 0.0086, steep 0.0016. Every climatic
  // material collapsed to ~0 in that band and `Sand`'s constant `+0.02` floor
  // won by default — 270 of 13,685 land probes, at exactly 0.02, every one in
  // slope 0.24-0.27.
  //
  // That hole was invisible only because `ForestFloor` was ungated on canopy
  // (see below) and its `1.1 * wet` filled it everywhere, at the cost of
  // painting forest litter across treeless lowland. The two defects are one:
  // fixing either alone trades brown camo for inland sand.
  //
  // The partition is anchored on `steep`, and which term anchors it is the
  // whole decision. Hinging both on the documented angle of repose (~0.21,
  // this file's own `slope` docblock) is tidier in isolation and was tried
  // first — but `Rock` is `steep * 1.25`, a coefficient calibrated against
  // steep's EXISTING window, so recentring that window silently re-tunes Rock.
  // Measured over 13,685 land probes: the repose hinge closed the hole and
  // took Rock from 18.77% to 35.40% of land, trading a camo defect for a grey
  // world. Anchoring on `steep` instead closes the hole just as well
  // (worst-case suitability 0.5217 vs 0.5316) and leaves Rock at 18.93% —
  // a 0.16 pp move.
  //
  // So: `steep` keeps the window its calibrated consumer was tuned against,
  // and `gentle` — which never meant anything but "not steep" — becomes its
  // exact complement instead of a second window free to drift away from it.
  // `gentle + steep === 1` at every slope, so the gap cannot reopen.
  const steep = smoothstep(0.24, 0.58, slope);
  const gentle = 1 - steep;
  const alpine = smoothstep(420, 980, elevation);
  const lowland = 1 - smoothstep(320, 900, elevation);
  const airfield = saturate(airportInfluence);

  const closure = saturate(input.canopyClosure ?? 0);
  /**
   * `6-13`: OMISSION IS NOT ZERO CLOSURE, and the gate below is the first term
   * for which the difference matters.
   *
   * `?? 0` makes "this ground has no canopy" and "nobody told me about canopy"
   * arrive as the same value. That was harmless while closure was a GAIN —
   * `(1 + 0 * GAIN)` is 1.0, which is exactly what preserves the `6-8`
   * invariant this file's own docblock promises: an omitting caller keeps its
   * pre-6-8 classification. As a GATE the two cases diverge completely, and
   * all three CPU callers omit the field — `GroundCoverSystem`,
   * `detail/generation` and `world/terrain`, the last of which feeds
   * `BIOME_FOR_DOMINANT_MATERIAL`. Gating on the merged value would have made
   * the FOREST biome unreachable on the CPU path: a world-classification
   * regression, not a rendering one, and silent.
   *
   * So the gate applies only where closure was actually supplied. The GPU
   * splat bake always supplies it (`input.canopyClosure = canopy.x`), and it
   * is the only consumer that knows where canopy stands, so it is the only
   * one that gets gated.
   */
  const closureGate = input.canopyClosure === undefined
    ? 1
    : closure * (1 + LAND_COVER_CANOPY_CLOSURE_GAIN);
  const sward = saturate(input.grassCover ?? 0);

  const suitability = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  // Sand: the shore band, and only where it is not steep.
  //
  // **~~THE FLOOR MOVED TO GRASS, and that is the whole of Jason's "brown/grey
  // strips" report.~~ STRUCK 2026-09-02 — FALSE OF THE PRODUCT, on two counts,
  // and the second was only found by testing it.**
  //
  // **Count one: it shipped into one of two classifiers.** This file carries a
  // TypeScript law and a WGSL twin, and `0608fed` moved the floor on the CPU
  // side alone; the twin kept `Sand = (1 - shore) * gentle * 1.35 + 0.02` with
  // no floor on Grass. The twin is what paints the ground the player sees, so
  // for that whole period the fix was not in the shipped product at all.
  //
  // **Count two: mirroring the fix into the twin does not move the bake.**
  // Measured, rather than reasoned about:
  //
  // ```
  //   before   bake Sand 1.8%   cpu-vs-bake disagreement 1.26%
  //   after    bake Sand 1.8%   cpu-vs-bake disagreement 1.23%
  // ```
  //
  // With a positive control proving the edit reaches the compiled shader:
  // forcing the Sand term to `0.0` made Sand vanish entirely and took Grass to
  // 53.9%. **So the floor is not what paints the Sand, in either
  // implementation, and this block does not explain the strips.** The cause is
  // open. Do not let this docblock end anyone's search.
  //
  // **THREE SWEEPS AGREED WITH THIS SENTENCE BEFORE ANYONE TESTED IT.** The
  // original validation ran 26,460 synthetic classifier conditions — the INPUT
  // SPACE, not the world. A later sweep took 5 seeds and 173,393 real land
  // probes with a positive control and found zero ground where the floor
  // decides. Both were sound instruments pointed at the CPU law, which was
  // already fixed; neither asked which of the two classifiers it was sampling
  // or which one paints. And a CPU-side sweep cannot reach this regime even in
  // principle: it needs `ForestFloor` out of the way, `ForestFloor` is gated on
  // `canopyClosure`, and **only the bake supplies closure** (see the
  // `closureGate` note below — the CPU ecology callers omit it, the gate reads
  // 1, and ForestFloor claims the ground Sand would otherwise take).
  // Reproducing the twin's additive `+ 0.02` on CPU inputs moves 0.01% of land.
  //
  // The unclaimed-ground regime is separately guarded, **on the CPU law only**,
  // by `tests/render.webgpu-land-cover-unclaimed-ground.test.ts`: cold ground
  // exists (minimum normalised temperature 0.000 in four of five seeds) but
  // never co-occurs with gentle and low. That contingency is real and worth
  // holding. **It is not a guard on the twin, and a guard on one of two
  // implementations is worth exactly the implementation it reads.**
  //
  // The mechanism below stands as a description of the CLASSIFIER, and is why
  // the floor had to move regardless. This term carried a constant `+ 0.02`
  // while every other
  // class is a pure product, so wherever the others all evaluated below 0.02
  // Sand won — **not because the ground is sandy, but because nothing else
  // claimed it.** An unclaimed-ground default has to be the most ordinary
  // cover, and beach is the least ordinary thing on a temperate lowland.
  //
  // `6-13` already fixed one instance of this in the SLOPE axis, by making
  // `gentle + steep === 1` so the two tails cannot both be flat. The hole
  // stayed open in TEMPERATURE: `warm` gates Grass, ForestFloor and DryGrass;
  // `alpine` gates Shrub and most of Rock; `steep` gates the rest. Below the
  // warm threshold, below the alpine onset, on gentle ground, **all three
  // gates shut at once**. Measured at 200 m on gentle ground: temperature
  // <= 0.16 gave Sand at 0.020, temperature >= 0.18 gave Grass at 0.800 — a
  // 0.02-wide step flipping the entire surface.
  //
  // **~~That is why the artifact is a STRIP rather than a patch.~~ STRUCK — this
  // explains why the classifier WOULD band if it ever entered the regime. It is
  // not evidence that it did, and the world sweep above says it does not.**
  // Terrain
  // temperature varies smoothly, so the threshold traces a contour line across
  // the landscape. A defect that produces bands needs a mechanism that
  // produces contours, and a gate crossing does exactly that.
  //
  // Moving the floor rather than widening a gate is the smaller change: it
  // cannot touch the shore band, which is doing real work at the waterline,
  // and it changes only ground that had no claimant at all.
  suitability[SurfaceMaterial.Sand] = (1 - shore) * gentle * 1.35;
  // Grass: the default lowland cover, and what an airfield is mown to. The
  // sward gain rides the CLIMATIC term only — an airfield is mown grass by
  // decree and must not be scaled by whether the wild sward would grow there.
  suitability[SurfaceMaterial.Grass] =
    shore * lowland * gentle * warm * (0.35 + wet * 0.65)
      * (1 + sward * LAND_COVER_GRASS_COVER_GAIN)
    + airfield * 2.4;
  // The unclaimed-ground floor, moved here from Sand. Grass is what a temperate
  // lowland looks like when no stronger signal applies; beach is not.
  //
  // **A FLOOR, NOT A BONUS — and the difference is measurable.** Written as
  // `+ 0.02` it is a universal gain: Grass beats every rival it was within
  // 0.02 of, anywhere, including ground those rivals legitimately claimed.
  // Measured across 26,460 terrain conditions, the additive form moved
  // DryGrass 6.4% -> 5.4% and Rock 61.7% -> 61.4% on top of the Sand
  // correction it was written for. `Math.max` raises only ground that scored
  // below the floor, which is the ground that had no claimant — the case this
  // exists to serve.
  suitability[SurfaceMaterial.Grass] = Math.max(suitability[SurfaceMaterial.Grass]!, 0.02);
  // Forest floor: wet, warm, below the treeline, off the steepest ground —
  // and, since 6-6, carrying the litter its soil column can actually support.
  // A thin-soiled crest under the same climate is duff-free ground and now
  // classifies that way instead of reading as closed forest floor.
  // `6-13`: closure is a GATE, not a gain.
  //
  // It was `(1 + closure * GAIN)`, which is 1.0 at closure 0 — so ForestFloor
  // kept its full `1.1` base on ground with no canopy at all and beat Grass's
  // ceiling of 1.0 by a permanent 0.100 on every wet lowland. Forest litter
  // was painted where there is no forest: measured 57.7% of land dominant,
  // against Grass's 13.3%, in a frame with 0.171% tree pixels.
  //
  // Litter exists BECAUSE a canopy drops it, so the term belongs to closure
  // rather than merely benefiting from it. `(1 + GAIN)` preserves the value a
  // CLOSED canopy sees today, so the `1.1` base and the gain constant carry
  // their existing meaning unchanged — only open ground moves.
  suitability[SurfaceMaterial.ForestFloor] =
    shore * wet * warm * (1 - smoothstep(900, 1_350, elevation)) * (1 - steep * 0.8) * 1.1
    * (1 + landCoverLitter(input) * LAND_COVER_FOREST_FLOOR_LITTER_GAIN)
    * closureGate;
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
  suitability[SurfaceMaterial.DryGrass] =
    shore * lowland * gentle * dry * warm * 0.8 * (1 + sward * LAND_COVER_GRASS_COVER_GAIN);
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
  const sharpening = saturate(input.slope * 2.4) * 0.6
    + (1 - landCoverWetness(input)) * 0.25;
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
 * One categorical material basis shared by the two resident season buckets.
 *
 * The atlas has one id texture and two weight textures. Storing the low
 * season's ids beside the high season's independently ordered weights assigns
 * those weights to the wrong materials as soon as (for example) snow enters
 * winter's top four. Select a joint basis by each material's strongest share
 * in either bucket, then project and renormalise both buckets onto it. The GPU
 * bake below mirrors this function exactly.
 */
export interface SeasonalLandCoverWeights {
  readonly ids: readonly SurfaceMaterialId[];
  readonly lowWeights: readonly number[];
  readonly highWeights: readonly number[];
}

export function alignSeasonalLandCoverWeights(
  low: LandCoverWeights,
  high: LandCoverWeights,
): SeasonalLandCoverWeights {
  const lowByMaterial = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  const highByMaterial = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  for (let slot = 0; slot < LAND_COVER_TOP_MATERIALS; slot += 1) {
    const lowId = low.ids[slot];
    const highId = high.ids[slot];
    if (lowId !== undefined) {
      lowByMaterial[lowId] = lowByMaterial[lowId]! + (low.weights[slot] ?? 0);
    }
    if (highId !== undefined) {
      highByMaterial[highId] = highByMaterial[highId]! + (high.weights[slot] ?? 0);
    }
  }

  const scores = lowByMaterial.map((weight, id) => Math.max(weight, highByMaterial[id]!));
  const ids: SurfaceMaterialId[] = [];
  for (let slot = 0; slot < LAND_COVER_TOP_MATERIALS; slot += 1) {
    let bestIndex = 0;
    let bestValue = -1;
    for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
      if (scores[id]! > bestValue) {
        bestIndex = id;
        bestValue = scores[id]!;
      }
    }
    scores[bestIndex] = -1;
    ids.push(bestIndex as SurfaceMaterialId);
  }

  const project = (source: readonly number[]): number[] => {
    const projected = ids.map((id) => source[id] ?? 0);
    const total = projected.reduce((sum, weight) => sum + weight, 0);
    return total > 0 ? projected.map((weight) => weight / total) : projected;
  };
  return {
    ids,
    lowWeights: project(lowByMaterial),
    highWeights: project(highByMaterial),
  };
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
 * An injected constant that is a valid WGSL float literal for every value.
 *
 * `${8}.0` is fine and `${8.5}.0` is `8.5.0`, which is a compile error found
 * only on a real adapter. Every constant this include injects goes through
 * here so a future retune of one of them cannot break the shader silently.
 */
function wgslConstant(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

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
  flowAccumulationAreaM2: f32,
  flowAccumulationValid: f32,
  // 6-6: metres of soil, plus its own zero-sentinel companion. Soil depth is
  // strictly positive wherever hydrology ran but quantises to 0 on the very
  // steepest faces, so the value alone cannot carry validity — the flag does.
  soilDepthMeters: f32,
  soilDepthValid: f32,
  // 6-8: the canopy seams. Both exist in ANALYTIC worlds too — a canopy is a
  // vegetation property, not an erosion product — so neither carries a
  // zero-sentinel companion. Zero is a real answer here (open ground), and the
  // bake always supplies a real value.
  canopyClosure: f32,
  grassCover: f32,
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
const LAND_COVER_SOIL_LITTER_THIN: f32 = ${wgslConstant(SOIL_LITTER_THIN_METERS)};
const LAND_COVER_SOIL_LITTER_DEEP: f32 = ${wgslConstant(SOIL_LITTER_DEEP_METERS)};
const LAND_COVER_FLOOR_LITTER_GAIN: f32 = ${
  wgslConstant(LAND_COVER_FOREST_FLOOR_LITTER_GAIN)
};
const LAND_COVER_CLOSURE_GAIN: f32 = ${wgslConstant(LAND_COVER_CANOPY_CLOSURE_GAIN)};
const LAND_COVER_SWARD_GAIN: f32 = ${wgslConstant(LAND_COVER_GRASS_COVER_GAIN)};

/** Transliteration of densityField.ts's soilLitterFactor, injected constants. */
fn landCoverLitter(input: LandCoverInput) -> f32 {
  if (input.soilDepthValid < 0.5) { return 0.0; }
  return kSmoothstep(
    LAND_COVER_SOIL_LITTER_THIN,
    LAND_COVER_SOIL_LITTER_DEEP,
    input.soilDepthMeters,
  );
}

fn landCoverWetness(input: LandCoverInput) -> f32 {
  if (input.flowAccumulationValid < 0.5) { return kSaturate(input.moisture); }
  let normalY = max(0.000001, 1.0 - input.slope);
  let tanSlope = sqrt(max(0.0, 1.0 / (normalY * normalY) - 1.0));
  let twi = log(
    (1.0 + max(0.0, input.flowAccumulationAreaM2))
      / (tanSlope + ${TERRAIN_TWI_SLOPE_EPSILON}),
  );
  let mapped = kSaturate((twi - ${TERRAIN_TWI_DRY}.0) / ${TERRAIN_TWI_WET - TERRAIN_TWI_DRY}.0);
  return mapped * mapped * (3.0 - 2.0 * mapped);
}

fn landCoverSuitabilities(input: LandCoverInput) -> array<f32, ${SURFACE_MATERIAL_COUNT}> {
  let elevation = input.elevationMeters;
  let slope = input.slope;
  let wetness = landCoverWetness(input);
  let snowline = LAND_COVER_SNOWLINE_REFERENCE
    + input.seasonalTemperatureShift * LAND_COVER_METERS_PER_TEMPERATURE
    + input.aspect * 90.0;
  let shore = kSmoothstep(-1.0, 3.0, elevation);
  let dry = 1.0 - kSmoothstep(0.28, 0.62, wetness);
  let wet = kSmoothstep(0.3, 0.64, wetness);
  let warm = kSmoothstep(0.16, 0.34, input.temperature);
  // 6-13: one partition, anchored on steep's calibrated window — see TS twin.
  let steep = kSmoothstep(0.24, 0.58, slope);
  let gentle = 1.0 - steep;
  let alpine = kSmoothstep(420.0, 980.0, elevation);
  let lowland = 1.0 - kSmoothstep(320.0, 900.0, elevation);
  let airfield = kSaturate(input.airportInfluence);
  let closure = kSaturate(input.canopyClosure);
  let sward = kSaturate(input.grassCover);

  var suitability: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  // \`0608fed\` moved the unclaimed-ground floor off Sand and onto Grass in the
  // CPU law above and **was not mirrored here**, leaving the two laws skewed.
  // This repairs that. The CPU side is the reference implementation.
  //
  // **HYGIENE, NOT A CURE — and the distinction is measured.** This changes no
  // pixel today: the bake paints Sand on 1.8% of texels before and after, and
  // the parity disagreement moves 1.26% -> 1.23%. A positive control confirms
  // the edit does reach the compiled shader — forcing this term to 0.0 makes
  // Sand vanish and Grass rise to 53.9% — so the floor genuinely is not what
  // paints it. The floor is inert on real terrain besides: the regime it
  // repairs, every material scoring under 0.02, occurs on 0 of 50,971 land
  // probes across two shipping seeds.
  //
  // It is repaired anyway because the next edit to this region would inherit
  // the skew, and because two laws that are meant to be identical were not.
  // **Do not read this as the fix for the grey-tan strips.** That report is
  // still open, and \`3e4bf32\` strikes the sentence in \`0608fed\` that claimed
  // otherwise.
  suitability[${SurfaceMaterial.Sand}] = (1.0 - shore) * gentle * 1.35;
  suitability[${SurfaceMaterial.Grass}] =
    shore * lowland * gentle * warm * (0.35 + wet * 0.65)
      * (1.0 + sward * LAND_COVER_SWARD_GAIN)
    + airfield * 2.4;
  // A FLOOR, not a bonus: \`max\`, not \`+\`, so it raises only ground that had no
  // claimant instead of giving Grass a universal gain over its rivals.
  suitability[${SurfaceMaterial.Grass}] = max(suitability[${SurfaceMaterial.Grass}], 0.02);
  suitability[${SurfaceMaterial.ForestFloor}] =
    shore * wet * warm * (1.0 - kSmoothstep(900.0, 1350.0, elevation))
      * (1.0 - steep * 0.8) * 1.1
      * (1.0 + landCoverLitter(input) * LAND_COVER_FLOOR_LITTER_GAIN)
      // 6-13: closure GATES the litter rather than gaining it — see TS twin.
      * (closure * (1.0 + LAND_COVER_CLOSURE_GAIN));
  suitability[${SurfaceMaterial.Shrub}] =
    shore * alpine * (1.0 - kSmoothstep(1150.0, 1650.0, elevation))
      * (0.4 + dry * 0.6) * 0.95;
  suitability[${SurfaceMaterial.Rock}] = shore * (steep * 1.25 + alpine * 0.55);
  suitability[${SurfaceMaterial.Snow}] =
    kSmoothstep(snowline - 90.0, snowline + 130.0, elevation)
      * (1.0 - kSaturate((slope - 0.5) * 2.2)) * 1.5;
  suitability[${SurfaceMaterial.DryGrass}] =
    shore * lowland * gentle * dry * warm * 0.8 * (1.0 + sward * LAND_COVER_SWARD_GAIN);
  suitability[${SurfaceMaterial.Gravel}] =
    shore * (steep * 0.35 + (1.0 - shore) * 0.4 + alpine * 0.2);
  suitability[${SurfaceMaterial.Asphalt}] = 0.0;
  suitability[${SurfaceMaterial.Concrete}] = 0.0;
  return suitability;
}

fn landCoverSoftmaxTemperature(input: LandCoverInput) -> f32 {
  let sharpening = kSaturate(input.slope * 2.4) * 0.6
    + (1.0 - landCoverWetness(input)) * 0.25;
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
  // (sin heading, cos heading, half length + end safety area,
  //  half width + shoulder) — the runway frame and the graded platform's own
  //  half-extents, so the bake can evaluate the SAME rounded-rectangle field
  //  getAirportInfluence does instead of a circle about the centre.
  runway: vec4f,
};

@group(0) @binding(1) var<storage, read> splatJobs: array<SplatJob>;
@group(0) @binding(2) var splatHeightAtlas: texture_2d<f32>;
@group(0) @binding(3) var splatId: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var splatWeightLo: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var splatWeightHi: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var splatFlowAccumAtlas: texture_2d<f32>;
// 6-6: the soil-depth channel, r8unorm over [0, SOIL_MAX]. Bound in the BAKE,
// not in the surface fragment: litter is a per-page property of the ground, so
// it belongs where the splat is decided rather than costing every fragment a
// sampler slot the 16-per-stage budget has to find.
@group(0) @binding(7) var splatSoilDepthAtlas: texture_2d<f32>;
const SPLAT_SOIL_MAX_METERS: f32 = ${
  wgslConstant(TERRAIN_PAGE_HYDROLOGY_ENCODING.soilDepthMaxMeters)
};
// 6-8: SPLAT_VEGETATION_LATTICE_BASE is supplied by the COMPOSER, exactly as
// kSaturate and kSmoothstep are. It cannot be injected from here: this file is
// reached from src/world/terrain.ts, so importing the kernel's lattice count
// would close a module cycle (world/terrain -> classifier -> kernel ->
// world/terrain) and every kernel constant would read undefined at load.

/**
 * Slope and ASPECT from the page's own texel grid — never a fixed 2 m
 * difference. Lane x is normalised steepness, lane y is the density field's
 * aspect term (-1 pole-facing ... +1 equator-facing, faded in with slope).
 *
 * 6-8 needs the aspect lane because the treeline wanders ±120 m with it, and a
 * canopy closure that ignored aspect would put forest on the ground the
 * vegetation path leaves bare. The classifier's own aspect input is
 * deliberately left at 0 - moving it is a separate change with its own pixels.
 */
fn splatSlopeAspect(job: SplatJob, heightTexel: vec2f) -> vec2f {
  // **CENTRAL difference. The forward one it replaces was wrong twice over.**
  //
  // It read \`here\`, \`east\`, \`south\` and divided by one texel: an O(h)
  // estimator where a central difference is O(h^2), with \`h\` the page's own
  // texel — 2 m at L0 but **512 m at L8** — so its error grew with every level.
  // Measured over identical points, the fraction of land it reported at slope
  // >= 0.40 was 1.00x a central difference at 2 m, 1.06x at 8 m, 1.25x at 32 m
  // and **1.95x at 128 m.** At coarse levels it invented nearly twice the steep
  // ground, and steep ground is Rock.
  //
  // **And it was asymmetric.** A forward difference estimates the gradient at
  // \`here + (0.5, 0.5)\` texels, so slope was assigned half a texel toward
  // +x/+z from the texel it painted — **256 m at L8**. That is the same family
  // as the gutter defect fixed below, and this was the second consumer of the
  // convention. Central differencing is centred on the texel by construction.
  //
  // \`WORLD_PAGE_GUTTER\` is 4 texels on every side of a slot, so the -1 reads
  // this adds stay inside stored data for every core texel. One extra tap per
  // axis.
  let base = vec2i(job.slots.zw) + vec2i(heightTexel);
  let west = textureLoad(splatHeightAtlas, base + vec2i(-1, 0), 0).r;
  let east = textureLoad(splatHeightAtlas, base + vec2i(1, 0), 0).r;
  let north = textureLoad(splatHeightAtlas, base + vec2i(0, -1), 0).r;
  let south = textureLoad(splatHeightAtlas, base + vec2i(0, 1), 0).r;
  let gradient = vec2f(east - west, south - north) / (2.0 * job.shape.y);
  let normalY = 1.0 / sqrt(1.0 + dot(gradient, gradient));
  let slope = 1.0 - normalY;
  let horizontal = length(gradient);
  var aspect = 0.0;
  if (horizontal > 1e-6) {
    aspect = (gradient.y / horizontal) * kSmoothstep(0.015, 0.07, slope);
  }
  return vec2f(slope, aspect);
}

fn splatSlopeAt(job: SplatJob, heightTexel: vec2f) -> f32 {
  return splatSlopeAspect(job, heightTexel).x;
}

/**
 * The airport's graded platform, as the ROUNDED RECTANGLE every other consumer
 * keys on: airport.ts's worldToRunway + roundedRectangleSignedDistance +
 * getAirportInfluence, transliterated.
 *
 * It used to be "1 - length(p - centre) / blend": a 240 m DISC about the
 * runway centre, under a comment that already claimed the rounded rectangle.
 * A 1,320 m runway is five times longer than that disc, so the bake read
 * influence 0 over most of its own airfield - measured 0.000 against a true
 * 0.807 at the ground-2m-lowsun camera. That cost the classifier its
 * "airfield * 2.4" mown-grass decree AND left splatCanopy's clearance at 1,
 * so the ground believed a closed stand (0.81 closure, ~590 stems/ha) grew on
 * an apron where the renderer plants ~90/ha. The ground material and the
 * ground SHAPE now read one field.
 *
 * smoothstep(0, blend, d) is exactly smoothstep(0, 1, d/blend), so the job's
 * inverse blend radius carries the whole band and no second constant is
 * needed. With no airport the host writes a centre 1e9 away and a 1 m blend,
 * so the smoothstep saturates and this returns 0. The previous form returned
 * 1 for that case - the whole world as mown airfield - because its inverse
 * blend radius was 0 and the radial term vanished with it.
 */
fn splatAirportInfluence(job: SplatJob, localX: f32, localZ: f32) -> f32 {
  let delta = vec2f(localX, localZ) - job.airport.xy;
  let along = delta.x * job.runway.x + delta.y * job.runway.y;
  let across = delta.x * job.runway.y - delta.y * job.runway.x;
  let q = vec2f(abs(along) - job.runway.z, abs(across) - job.runway.w);
  let platformDistance = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
  return 1.0 - kSmoothstep(0.0, 1.0, platformDistance * job.airport.z);
}

fn splatClassify(
  job: SplatJob,
  localX: f32,
  localZ: f32,
  shift: f32,
  canopy: vec2f,
) -> LandCoverWeights {
  // **The gutter offset is packed in CHANNEL texels and this reads HEIGHT
  // texels.** \`job.placement.xy\` is \`-GUTTER * channelTexel\`, so dividing it by
  // \`shape.y\` over-shifts by \`GUTTER * (channelTexel / heightTexel - 1)\`. The
  // channel texel is twice the height texel, so the read landed a full GUTTER
  // of height texels past the texel being painted: 8 m at L0, **128 m per axis
  // at L4**. Height AND slope both come from this index, so the classification
  // was sampled off the ground it paints, further the coarser the page.
  //
  // Recovering the gutter in texels from the job keeps this correct if the
  // channel/height ratio ever changes: \`GUTTER = -placement.x / channelTexel\`.
  let gutterTexels = -job.placement.x / job.shape.x;
  let heightTexel = vec2f(
    localX / job.shape.y + gutterTexels,
    localZ / job.shape.y + gutterTexels,
  );
  let elevation = textureLoad(
    splatHeightAtlas,
    vec2i(job.slots.zw) + vec2i(heightTexel),
    0,
  ).r - job.shape.w;
  var input: LandCoverInput;
  input.elevationMeters = elevation;
  input.slope = splatSlopeAt(job, heightTexel);
  let channelTexel = vec2i(job.slots.xy) + vec2i(vec2f(
    (localX - job.placement.x) / job.shape.x,
    (localZ - job.placement.y) / job.shape.x,
  ));
  let flowLog2 = max(0.0, textureLoad(splatFlowAccumAtlas, channelTexel, 0).r);
  input.flowAccumulationAreaM2 = max(0.0, exp2(flowLog2) - 1.0);
  // A null-created analytic atlas is zero-initialised. Erosion flow starts at
  // one contributing source cell, so zero is an unambiguous parity sentinel.
  input.flowAccumulationValid = select(0.0, 1.0, flowLog2 > 0.0);
  // 6-6: soil rides the SAME sentinel, and that is a fact about the producer,
  // not a convenience — uploadHydrology writes all four aux resources before
  // it marks the slot ready, so a page with flow has soil and a page without
  // flow has neither. Soil's own value cannot carry validity: it quantises to
  // 0 on near-vertical faces, where 0 is a real answer.
  input.soilDepthMeters =
    textureLoad(splatSoilDepthAtlas, channelTexel, 0).r * SPLAT_SOIL_MAX_METERS;
  input.soilDepthValid = input.flowAccumulationValid;
  input.canopyClosure = canopy.x;
  input.grassCover = canopy.y;
  input.moisture = terrainMoisture(localX, localZ);
  input.temperature = terrainTemperatureFromClimate(terrainClimate(localX, localZ), elevation);
  input.aspect = 0.0;
  // The airport's graded platform is mown grass (1B-6), and its influence is
  // the same rounded-rectangle field the earthworks key on.
  input.airportInfluence = kSaturate(splatAirportInfluence(job, localX, localZ));
  input.dayOfYear = job.airport.w;
  input.seasonalTemperatureShift = shift;
  return classifyLandCover(input);
}

/**
 * 6-8: the canopy the ground carries here - (true closure, grass cover).
 *
 * Evaluated ONCE per channel texel rather than per supersample, and that is a
 * property of the channel rather than a saving: the vegetation lattices are
 * band-limited at a FIXED 60 m (CANOPY_CLOSURE_FILTER_WIDTH_METERS), so four
 * samples 0.5-32 m apart inside one texel would return four copies of the same
 * number. The shore-distance driver is left at its neutral out-of-domain value
 * because the riparian corridor is 6-50 m wide - an order of magnitude below
 * this channel's own band limit, so it could not survive into it anyway.
 */
fn splatCanopy(job: SplatJob, localX: f32, localZ: f32) -> vec2f {
  // **The gutter offset is packed in CHANNEL texels and this reads HEIGHT
  // texels.** \`job.placement.xy\` is \`-GUTTER * channelTexel\`, so dividing it by
  // \`shape.y\` over-shifts by \`GUTTER * (channelTexel / heightTexel - 1)\`. The
  // channel texel is twice the height texel, so the read landed a full GUTTER
  // of height texels past the texel being painted: 8 m at L0, **128 m per axis
  // at L4**. Height AND slope both come from this index, so the classification
  // was sampled off the ground it paints, further the coarser the page.
  //
  // Recovering the gutter in texels from the job keeps this correct if the
  // channel/height ratio ever changes: \`GUTTER = -placement.x / channelTexel\`.
  let gutterTexels = -job.placement.x / job.shape.x;
  let heightTexel = vec2f(
    localX / job.shape.y + gutterTexels,
    localZ / job.shape.y + gutterTexels,
  );
  let elevation = textureLoad(
    splatHeightAtlas,
    vec2i(job.slots.zw) + vec2i(heightTexel),
    0,
  ).r - job.shape.w;
  let slopeAspect = splatSlopeAspect(job, heightTexel);
  var drivers: VegetationDensityDrivers;
  drivers.elevationAboveSeaLevel = elevation;
  drivers.slope = slopeAspect.x;
  drivers.moisture = terrainMoisture(localX, localZ);
  drivers.aspect = slopeAspect.y;
  // The SAME field the classifier reads, and the same one generation.ts feeds
  // the density field: the airfield's woody-stem clearance is what keeps the
  // baked closure equal to the canopy actually planted on the apron.
  drivers.airportInfluence = kSaturate(splatAirportInfluence(job, localX, localZ));
  drivers.shoreDistanceMeters = 1e9;
  // The band limit is hoisted into the appended lattice table's own weights,
  // so this driver is inert here — the include never reads it.
  drivers.filterWidthMeters = 0.0;
  let sample = vegetationDensity(SPLAT_VEGETATION_LATTICE_BASE, localX, localZ, drivers);
  return vec2f(sample.canopyClosure, sample.grassCover);
}

/** Average the WEIGHT VECTORS of a 2x2 supersample, not their argmax. */
fn splatSupersample(
  job: SplatJob,
  localX: f32,
  localZ: f32,
  shift: f32,
  canopy: vec2f,
) -> LandCoverWeights {
  var accumulated: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    accumulated[index] = 0.0;
  }
  let step = job.shape.x * 0.25;
  for (var sample = 0u; sample < 4u; sample = sample + 1u) {
    let dx = select(-step, step, (sample & 1u) == 1u);
    let dz = select(-step, step, (sample & 2u) == 2u);
    let weights = splatClassify(job, localX + dx, localZ + dz, shift, canopy);
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

struct SeasonalLandCoverWeights {
  ids: vec4f,
  weightsLo: vec4f,
  weightsHi: vec4f,
};

/** Give both season buckets one categorical id basis before storing them. */
fn splatAlignSeasonalWeights(
  lo: LandCoverWeights,
  hi: LandCoverWeights,
) -> SeasonalLandCoverWeights {
  var loByMaterial: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  var hiByMaterial: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  var scores: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    loByMaterial[index] = 0.0;
    hiByMaterial[index] = 0.0;
  }
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    let loId = u32(lo.ids[slot]);
    let hiId = u32(hi.ids[slot]);
    loByMaterial[loId] = loByMaterial[loId] + lo.weights[slot];
    hiByMaterial[hiId] = hiByMaterial[hiId] + hi.weights[slot];
  }
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    scores[index] = max(loByMaterial[index], hiByMaterial[index]);
  }

  var result: SeasonalLandCoverWeights;
  var totalLo = 0.0;
  var totalHi = 0.0;
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    var bestIndex = 0u;
    var bestValue = -1.0;
    for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
      if (scores[index] > bestValue) {
        bestIndex = index;
        bestValue = scores[index];
      }
    }
    scores[bestIndex] = -1.0;
    result.ids[slot] = f32(bestIndex);
    result.weightsLo[slot] = loByMaterial[bestIndex];
    result.weightsHi[slot] = hiByMaterial[bestIndex];
    totalLo = totalLo + result.weightsLo[slot];
    totalHi = totalHi + result.weightsHi[slot];
  }
  if (totalLo > 0.0) { result.weightsLo = result.weightsLo / totalLo; }
  if (totalHi > 0.0) { result.weightsHi = result.weightsHi / totalHi; }
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

  // Ids are categorical values encoded as unorm over the ten-material axis.
  // The surface shader loads them exactly; it never filters between ids.
  // Both seasonal weight textures must share this same per-texel basis.
  let scale = 1.0 / f32(LAND_COVER_COUNT - 1u);
  let canopy = splatCanopy(job, localX, localZ);
  let lo = splatSupersample(job, localX, localZ, job.placement.z, canopy);
  let hi = splatSupersample(job, localX, localZ, job.placement.w, canopy);
  let aligned = splatAlignSeasonalWeights(lo, hi);
  textureStore(splatId, texel, aligned.ids * scale);
  // 6-8: the canopy-closure channel rides the weight textures' ALPHA lane, in
  // BOTH season buckets, and costs nothing.
  //
  // The fourth material weight is REDUNDANT: splatAlignSeasonalWeights
  // normalises each bucket, so w3 == 1 − w0 − w1 − w2 exactly and the fragment
  // reconstructs it (terrainSurfaceSparseSplat). That buys a full 8-bit
  // continuous channel for zero bytes of atlas — which matters, because the
  // channel atlas is 107 MiB at tier 1 and the inventoried memory wall is
  // already breached — and zero new fragment samplers against the
  // 16-per-stage limit section 1.2 reserves for this item. Closure is
  // season-INVARIANT, so writing the same value into both buckets survives the
  // fragment's seasonal mix() unchanged.
  //
  // Reconstruction is not lossier than storing w3 was: w0..w2 quantise to
  // 1/255 each, so the reconstructed w3 carries at most 3 half-ULPs of error
  // against the stored value's 1, and the reconstructed vector now sums to
  // exactly 1 where the stored one only did up to quantisation.
  textureStore(splatWeightLo, texel, vec4f(aligned.weightsLo.xyz, canopy.x));
  textureStore(splatWeightHi, texel, vec4f(aligned.weightsHi.xyz, canopy.x));
}
`;
