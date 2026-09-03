import {
  clamp,
  fbm2D,
  filteredValueNoise2D,
  saturate,
  smoothstep,
} from "@/src/world/noise";
import { mixSeed } from "@/src/world/seed";
import { RENDERED_DENSITY_LAWS, crownCoverFromAreas } from "./renderedDensity";

/**
 * The vegetation density field (1B-7) — the single owner of where plants
 * grow. One continuous function, never a switch: clumping expressed as a
 * field has no centre and no radius, therefore nothing circular to see.
 * Terrain-material *reads* this in Phase 6; nothing reimplements it
 * (architecture manifest, boundary-tested).
 *
 * Class P and WGSL-portable by the same rules as the terrain kernel: pure
 * arithmetic over world coordinates, the shared noise lattice, and a uint32
 * seed.
 */

export interface VegetationDensityInput {
  readonly x: number;
  readonly z: number;
  readonly heightMeters: number;
  readonly seaLevelMeters: number;
  /** Normalized steepness (1 − normalY): 0 flat, ~0.21 at the 38° angle of repose. */
  readonly slope: number;
  readonly moisture: number;
  /** Horizontal normal components for the aspect term; omitted reads flat. */
  readonly normalX?: number;
  readonly normalZ?: number;
  /** 0 outside the airport blend, 1 on the graded platform (1B-6). */
  readonly airportInfluence?: number;
  /**
   * `5-13`: signed metres to the nearest exported wetted edge. Values <= 0
   * are water; positive values are dry land. Omitted means hydrology has not
   * provisioned this point and is a neutral factor.
   */
  readonly shoreDistanceMeters?: number;
  /**
   * §1.6 threading rule: part of this signature from the moment the field
   * was first written. Canopy stem positions are deliberately
   * season-invariant — trees must not pop with the calendar — so today the
   * clock drives nothing; the seasonal ground-cover density arriving with
   * 2-16/2-18 consumes it here.
   */
  readonly dayOfYear: number;
  /**
   * `4-6b` (D12): the half-width of the sampling footprint, under the `0-4`
   * convention — the same parameter the terrain kernel has carried since
   * Phase 0.
   *
   * **This field exists because point-sampling this field was the same defect
   * `1B-2` fixed for height, one system over.** The glade channel has a 260 m
   * lattice; sampled onto a level-5 page whose texels are 128 m apart it
   * re-rolls an arbitrary phase per level, and the symptom is canopy cover
   * that CHANGES when a page changes LOD. Collision and per-stem placement
   * keep 0 (the full-bandwidth field) forever; only a page bake passes a
   * width.
   */
  readonly filterWidthMeters: number;
}

export interface VegetationDensitySample {
  /** Canopy stems per square metre (0.03–0.08 in closed forest). */
  readonly treeStemsPerSquareMeter: number;
  readonly shrubStemsPerSquareMeter: number;
  /** 1 in closed forest, tapering to krummholz (~0.12) at the treeline. */
  readonly heightFactor: number;
  /** −1 cool north face … +1 warm south face; shifts the conifer share. */
  readonly aspect: number;
  /**
   * 0 in stand interiors, approaching 1 through the forest-edge margin.
   * Generation uses this to make edge stems shorter and bushier without
   * changing the climatic species/stand decision.
   */
  readonly forestEdge: number;
  /**
   * `4-6b`: ground-cover archetype weights — grass / fern / heather / reed /
   * clutter — summing to 1.
   *
   * `2-16` rolled a flat 15% for ground cover, so a wet hollow and a
   * wind-scoured ridge read as the same ground at different densities. These
   * come from terms the field ALREADY carries (moisture, slope, shade,
   * exposure), so it costs no new noise: what was missing was not information
   * but a place to put it.
   */
  readonly groundCover: GroundCoverWeights;
  /**
   * `6-6`: the riparian bank band at this point (0 away from water). Carried
   * on the sample so generation's archetype choice and the WGSL mirror read
   * ONE corridor shape rather than each re-deriving it from shore distance.
   */
  readonly riparianBand: number;
  /**
   * `6-8`: true crown cover at this point, 0 open ground … ~0.95 closed
   * forest. Carried on the sample so the terrain splat bake and the
   * vegetation path read ONE closure rather than each deriving its own from
   * the stem density — the same rule 6-6 applied to the riparian band.
   */
  readonly canopyClosure: number;
  /** `6-8`: absolute grass-sward cover of the ground, canopy-suppressed. */
  readonly grassCover: number;
}

/** The five ground-cover archetypes, in the order the weight vector uses. */
export const GROUND_COVER_ARCHETYPES = [
  "grass",
  "fern",
  "heather",
  "reed",
  "clutter",
] as const;

export type GroundCoverArchetype = (typeof GROUND_COVER_ARCHETYPES)[number];

export type GroundCoverWeights = Readonly<Record<GroundCoverArchetype, number>>;

const OPEN_GRASSLAND_COVER: GroundCoverWeights = Object.freeze({
  grass: 1, fern: 0, heather: 0, reed: 0, clutter: 0,
});

/**
 * `6-6`: how much litter a soil column carries, in [0, 1].
 *
 * The single definition of "deep soil means deep litter", shared by the two
 * consumers the item names — `2-15`'s ground clutter (vegetation side) and the
 * forest-floor splat suitability (terrain side, which reaches this file through
 * the ONE sanctioned terrain -> detail entry point). It lives here rather than
 * in the classifier because litter is a vegetation product; the classifier
 * imports it exactly as the boundary test requires.
 *
 * The window is the MEASURED soil-proxy spread `TerrainPageHydrology`'s
 * `terrainFineBandSurvival` docblock records over the W-7 page spread
 * (p5 0.65 m on ridges to p95 5.16 m on valley floors): 0.9 m puts dry crests
 * and rock faces at zero litter, 4.6 m saturates convergent hollows, and the
 * whole crest-to-floor range lands on the ramp instead of clipping at one end.
 */
export const SOIL_LITTER_THIN_METERS = 0.9;
export const SOIL_LITTER_DEEP_METERS = 4.6;

export function soilLitterFactor(soilDepthMeters: number): number {
  if (!Number.isFinite(soilDepthMeters) || soilDepthMeters < 0) {
    throw new RangeError("soil depth must be finite and non-negative");
  }
  return smoothstep(SOIL_LITTER_THIN_METERS, SOIL_LITTER_DEEP_METERS, soilDepthMeters);
}

// ---------------------------------------------------------------------------
// `6-8` — the canopy/terrain handoff laws.
//
// The ground needs three things from the canopy standing on it: how much of it
// the canopy covers (closure), how much of the *open* part carries a grass
// sward, and — beyond the range where stems are drawn at all — what the canopy
// itself looks like. All three live here, in the density owner, for exactly
// 6-6's reason: terrain reaches vegetation through ONE entry point, and a
// second answer to "how closed is the canopy here?" is the failure mode both
// designs on record name.
// ---------------------------------------------------------------------------

/**
 * The reference rendered-density law: the G-target tier.
 *
 * Closure is deliberately **tier-invariant** — a page bake is shared by every
 * viewer of that world and cannot carry a per-tier answer, and how much canopy
 * *stands* here is not a quality setting. What IS tier-varying (the band radii
 * and the far floor) enters the handoff at the fragment, as uniforms, where the
 * tier is known.
 */
const CANOPY_REFERENCE_LAW = RENDERED_DENSITY_LAWS[1]!;

/**
 * Mean crown radius over the WHOLE authored stem field, and over the dominant
 * stems the near band actually renders.
 *
 * Both numbers are `renderedDensity.ts`'s own measurements, quoted there
 * beside the near cap: "the authored field's mean crown radius is 3.40 m, its
 * 70 widest stems per hectare average 5.80 m, and the difference between them
 * is the difference between 0.26 and 0.55 rendered cover". The gap between the
 * two IS this item: it is the canopy the renderer does not draw, and the
 * ground has to account for it.
 */
export const CANOPY_MEAN_CROWN_RADIUS_METERS = 3.4;
export const CANOPY_DOMINANT_CROWN_RADIUS_METERS = 5.8;

/**
 * Crown area per square metre of ground that the near band can render, as a
 * dimensionless Boolean-model area ratio.
 *
 * `nearStemsPerHectare` of the reference law, each carrying a dominant crown,
 * over a hectare. Rendered cover saturates here however dense the field gets,
 * because the runtime thins by canopy rank.
 */
export const CANOPY_RENDERED_CROWN_AREA_RATIO =
  (CANOPY_REFERENCE_LAW.nearStemsPerHectare
    * Math.PI * CANOPY_DOMINANT_CROWN_RADIUS_METERS ** 2) / 10_000;

/**
 * The canopy's top height above ground, for the coarse-LOD silhouette.
 *
 * The dominant stems are the old ones: `generation.ts`'s individual-age curve
 * puts a rank-thinned canopy stem near the top of its species' 25–35 m range,
 * and the seven species' maxima average 28.4 m with broadleaves lower than
 * conifers. 22 m is that population's mean canopy top, and
 * `tests/render.webgpu-canopy-handoff.test.ts` measures it against real
 * generated stems rather than asserting it.
 */
export const CANOPY_DOMINANT_HEIGHT_METERS = 22;

/**
 * The band-limit half-width the closure channel is baked at, in metres —
 * FIXED, not the page's own texel width.
 *
 * This is D12's rule taken to its conclusion rather than an exception to it.
 * D12 band-limits per page so canopy cover cannot change when a page changes
 * LOD; a channel consumed by a *coarse-LOD* silhouette and a far-field
 * appearance ramp is read at two different levels along one continuous
 * surface, so per-page widths would make the same ground disagree with itself
 * across a level boundary — a crack, not a shimmer. 60 m keeps the 260 m glade
 * lattice's first octave whole (the clearings are the whole point) and takes
 * 95% off its 130 m second octave; every other vegetation lattice is 560 m or
 * longer and survives untouched. Stand scale is also the correct scale for
 * every consumer: forest-floor classification, sward suppression, under-canopy
 * shade and the far ramp are all stand properties, not tree properties.
 *
 * **Residual, recorded rather than hidden:** the field's MOISTURE driver comes
 * from the terrain kernel's own lattices, which band-limit per page. Those
 * survive intact through level 5 and start dropping octaves at level 6+, so
 * closure is exactly level-invariant to L5 and drifts by ~0.1 across an L5/L6
 * node boundary. A level-6 node spans 4,096 m, so that boundary is at least
 * ~8 km out and the resulting lift disagreement is ~2 m — under half a pixel.
 * Overriding the moisture lattices instead would move terrain moisture
 * everywhere, which is a far larger change than the one it would prevent.
 */
export const CANOPY_CLOSURE_FILTER_WIDTH_METERS = 60;

/**
 * The impostor band's outer dither fade, in metres.
 *
 * Lives here because it is the ONE number that makes the handoff complementary:
 * `DetailInstanceMaterialPlugin`'s far band dithers out over this window, and
 * the terrain's canopy ramp has to fade in over exactly the same one. It was a
 * literal inside the plugin's WGSL until this item; both halves read it now.
 */
export const DETAIL_FAR_CULL_FADE_METERS = 420;

/**
 * What a canopy LOOKS like, calibrated against the representation it replaces.
 *
 * These four numbers are not art direction: they are the impostor material's
 * own response, transferred so that the terrain's canopy and the impostor band's
 * canopy light the same way across the handoff. Wave R spent a whole wave
 * closing a +28% luminance step at this exact ring; a fourth representation
 * that matched only in ALBEDO would re-open it, which is the lesson the LOD
 * calibration that "passed at 96–98% while lit brightness was off 4–7×" taught.
 *
 * - **Albedo** is the MEASURED coverage-weighted mean of the impostor atlas's
 *   leafed bucket over all seven species and all sixteen hemi-octahedral views
 *   (`tests/render.webgpu-canopy-handoff.test.ts` recomputes it from
 *   `planImpostorAtlas` rather than trusting this line). The atlas is bound as
 *   a linear RGBA8 custom texture and multiplied by an all-white impostor
 *   `albedoColor`, so its raw bytes ARE the shaded albedo. Measured across
 *   three seeds: (0.168–0.171, 0.259–0.264, 0.111–0.114).
 * - **Ambient** is the impostor material's `environmentIntensity` of 0.62
 *   against the terrain material's 1.0. A per-fragment material cannot change
 *   `environmentIntensity`, but AO multiplies exactly the same term, so the
 *   canopy's AO factor IS its probe trim. (RENDERING_PLAN §3.5 guessed
 *   `1 − 0.35·closure` = 0.65 for this; the measured value is 0.62, i.e. the
 *   guess was within 5% — it is replaced by the measurement, not by taste.)
 * - **Roughness** and **specular** are the card shell's 0.94 and its
 *   `specularIntensity` of 0.4, which the impostor material mirrors verbatim
 *   ("this material mirrors the CARD SHELL's response exactly").
 *
 * Residual, recorded: the vegetation materials run `directIntensity` 1.05
 * against terrain's 1.03, so the direct lobe is 1.9% brighter on the
 * vegetation side of the ramp. That is below the 8-bit albedo quantisation of
 * the channel that drives it and is deliberately not compensated.
 */
export const CANOPY_SURFACE_ALBEDO: readonly [number, number, number] =
  Object.freeze([0.17, 0.261, 0.113]);
export const CANOPY_SURFACE_AMBIENT = 0.62;
export const CANOPY_SURFACE_ROUGHNESS = 0.94;
export const CANOPY_SURFACE_SPECULAR = 0.4;

/**
 * How much direct sun the canopy takes out of the ground it stands over —
 * QR-2's dappled light, as a coefficient rather than a stand-in.
 *
 * A closed canopy transmits 5–15% of direct beam radiation; the ground under
 * it is not black because most of what reaches it is diffuse sky and canopy
 * scatter, which this term does not touch (it multiplies the DIRECT lobe only,
 * at the same hook the horizon shadow uses, for the same reason: doubling it
 * into ambient would darken a valley twice for one occluder). 0.72 keeps 28%
 * of the beam under a full deficit, which is the transmission a broken canopy
 * at the rendered-density law's 78 dominant stems/ha actually has.
 */
export const CANOPY_UNDER_SHADE_STRENGTH = 0.72;

/**
 * True crown cover at a point: the fraction of ground the canopy covers.
 *
 * The Boolean model `renderedDensity.ts` already owns, evaluated over the
 * whole authored field rather than over the rendered subset. In saturated
 * closed forest (0.08 stems/m²) this reads 0.945, which is what a closed
 * canopy is; the near band can only ever draw 0.56 of it.
 */
export function canopyClosure(treeStemsPerSquareMeter: number): number {
  if (!Number.isFinite(treeStemsPerSquareMeter) || treeStemsPerSquareMeter < 0) {
    throw new RangeError("Canopy closure needs a finite, non-negative stem density");
  }
  return crownCoverFromAreas(
    treeStemsPerSquareMeter * 10_000 * Math.PI * CANOPY_MEAN_CROWN_RADIUS_METERS ** 2,
    10_000,
  );
}

/**
 * The Boolean-model crown area ratio behind a closure value.
 *
 * `closure = 1 − exp(−area)`, so this inverts it. The fragment needs it to
 * split one baked scalar into the two halves below without a second channel.
 */
export function canopyCrownAreaRatio(closure: number): number {
  return -Math.log(Math.max(1e-4, 1 - clamp(closure, 0, 1)));
}

/**
 * The share of the canopy's crown area that RENDERED stems supply at a range.
 *
 * Two live mechanisms, multiplied, and nothing invented: the rendered-density
 * law's own inverse-square falloff with its far floor, and
 * `DetailInstanceMaterialPlugin`'s outer dither fade (band code 2). Beyond the
 * impostor radius it is exactly zero, because beyond it nothing is drawn.
 */
export function canopyRenderedShare(
  rangeMeters: number,
  nearRadiusMeters: number,
  farRadiusMeters: number,
  farFloorShare: number,
): number {
  if (!Number.isFinite(rangeMeters) || rangeMeters < 0) {
    throw new RangeError("Canopy handoff range must be finite and non-negative");
  }
  const falloff = rangeMeters <= nearRadiusMeters
    ? 1
    : Math.max((nearRadiusMeters / rangeMeters) ** 2, farFloorShare);
  return clamp(falloff * canopyImpostorCull(rangeMeters, farRadiusMeters), 0, 1);
}

/**
 * The impostor band's own outer dither survival at a range: 1 while the far
 * band draws, 0 once it has dithered fully out.
 *
 * Split out because the GEOMETRY half of the handoff keys on this factor
 * alone, not on the whole rendered share. The appearance half may take over
 * inside the geometry bands — a forest at 400 m reads as canopy between its
 * thinned stems, and that is the picture the rendered-density law's own
 * falloff is asking the ground to complete. The HEIGHT half may not: stems are
 * placed on the unlifted terrain, so lifting ground that still carries drawn
 * trees would sink them into it. The canopy's volume is added exactly where no
 * canopy volume is drawn, over exactly the window the impostors vacate.
 */
export function canopyImpostorCull(rangeMeters: number, farRadiusMeters: number): number {
  if (!Number.isFinite(rangeMeters) || rangeMeters < 0) {
    throw new RangeError("Canopy handoff range must be finite and non-negative");
  }
  return clamp((farRadiusMeters - rangeMeters) / DETAIL_FAR_CULL_FADE_METERS, 0, 1);
}

/**
 * Metres of canopy the terrain surface carries at a range — the coarse-LOD
 * silhouette, before the Nyquist gate on the consuming node's own level.
 *
 * Zero everywhere the impostor band still draws, `CANOPY_DOMINANT_HEIGHT_METERS`
 * times closure once it has stopped, and complementary to the impostor dither
 * in between: canopy volume is drawn exactly once at every range.
 */
export function canopyLiftMeters(
  closure: number,
  rangeMeters: number,
  farRadiusMeters: number,
): number {
  return CANOPY_DOMINANT_HEIGHT_METERS
    * saturate(closure)
    * (1 - canopyImpostorCull(rangeMeters, farRadiusMeters));
}

export interface CanopyHandoff {
  /** Crown cover the drawn stems supply at this range. */
  readonly renderedCover: number;
  /** Crown cover they do not: `closure − renderedCover`, never negative. */
  readonly deficit: number;
  /** The deficit you are standing UNDER — QR-2's dappled shade. */
  readonly shade: number;
  /** The deficit you are LOOKING AT — the far-field canopy surface. */
  readonly surface: number;
}

/**
 * Split the canopy between the two representations at a range.
 *
 * **Coverage is conserved identically, not approximately:**
 * `renderedCover + deficit = closure` at every range, by construction, because
 * `deficit` is defined as the residual rather than tuned to meet it. And
 * `shade + surface = deficit`, because the same canopy cannot be both the
 * thing shading you and the thing you are looking at — the rendered share is
 * exactly the fraction of the time you are inside the stand rather than
 * outside it.
 *
 * At range 0 the drawn near band supplies everything it can, so `surface` is
 * zero and the whole residual is shade: that residual is QR-2, and it is not a
 * tuning constant — it is the measured gap between a 3.4 m mean crown over the
 * whole field and a 5.8 m crown over the 78 stems/ha the law renders.
 * Beyond the impostor radius nothing is drawn, so `shade` is zero and the
 * ground carries the entire canopy. There is no seam anywhere between, because
 * `canopyRenderedShare` is continuous and both halves are affine in it.
 */
export function canopyHandoff(closure: number, renderedShare: number): CanopyHandoff {
  const cover = clamp(closure, 0, 1);
  const share = clamp(renderedShare, 0, 1);
  const areaAll = canopyCrownAreaRatio(cover);
  const areaRendered = Math.min(areaAll, CANOPY_RENDERED_CROWN_AREA_RATIO);
  const renderedCover = 1 - Math.exp(-areaRendered * share);
  const deficit = Math.max(0, cover - renderedCover);
  return {
    renderedCover,
    deficit,
    shade: deficit * share,
    surface: deficit * (1 - share),
  };
}

/**
 * `6-8`'s grass-cover input: how much of the ground carries a grass sward.
 *
 * The archetype weight is a MIX (it says grass rather than fern); this is the
 * absolute cover, which is what the ground material needs. Closed canopy is
 * the term that was missing — a closed stand's floor is needle duff and moss,
 * not sward, and `GroundCoverSystem`'s blades stop at 80 m anyway, so past
 * that the terrain material is the only thing that can say so.
 */
export function canopyGrassCover(grassArchetypeWeight: number, closure: number): number {
  return saturate(grassArchetypeWeight) * (1 - saturate(closure));
}

/**
 * Archetype mix from the drivers the density field already has.
 *
 * Ferns need shade and moisture, heather takes the dry exposed ridge, reeds
 * want wet flat ground near the water table, and clutter (fallen wood, stones)
 * follows slope and disturbance. Normalised, so it is a mix rather than five
 * independent probabilities.
 *
 * `6-6` adds the SPECIES half of the shore-distance channel: the riparian bank
 * band (0 away from water, 1 on the exported bank) is what actually puts reeds
 * and streamside ferns where they belong. Before it, both archetypes keyed on
 * the climatic moisture proxy alone, so a reed bed appeared on any wet flat
 * ground and never along a river. Defaulting the band to 0 keeps analytic
 * worlds — where no shore distance exists — bit-identical.
 */
export function groundCoverWeights(
  moisture: number,
  slope: number,
  canopyShade: number,
  elevationAboveSeaLevel: number,
  riparianBand = 0,
): GroundCoverWeights {
  const wet = smoothstep(0.42, 0.78, moisture);
  const dry = 1 - smoothstep(0.24, 0.55, moisture);
  const flat = 1 - smoothstep(0.04, 0.18, slope);
  const steep = smoothstep(0.12, 0.42, slope);
  const shade = saturate(canopyShade);
  const lowland = 1 - smoothstep(180, 700, elevationAboveSeaLevel);
  const bank = saturate(riparianBand);
  const raw = {
    grass: 0.35 + flat * 0.4 * (1 - shade),
    // Streamside ferns do not need a closed canopy: the bank supplies the
    // humidity the shade term stands in for everywhere else.
    fern: shade * (0.25 + wet * 0.75) + bank * (0.2 + shade * 0.45),
    heather: dry * (0.2 + steep * 0.5) * (1 - lowland * 0.4),
    // Reeds are a WATER-EDGE species, not a wet-ground species. The bank band
    // reaches them on any flat lowland, climatic moisture or not.
    reed: (wet + bank * 1.6) * flat * lowland * 0.9,
    clutter: steep * 0.35 + shade * 0.2,
  };
  const total = raw.grass + raw.fern + raw.heather + raw.reed + raw.clutter;
  if (!(total > 0)) return OPEN_GRASSLAND_COVER;
  return Object.freeze({
    grass: raw.grass / total,
    fern: raw.fern / total,
    heather: raw.heather / total,
    reed: raw.reed / total,
    clutter: raw.clutter / total,
  });
}

/** Base canopy density: ~800 stems/ha before habitat factors. */
const BASE_TREE_STEMS = 0.08;
const BASE_SHRUB_STEMS = 0.045;
/** Treeline base above sea level; the ragged offsets ride on top. */
const TREELINE_BASE_METERS = 1_350;

const ZERO_DENSITY: VegetationDensitySample = Object.freeze({
  treeStemsPerSquareMeter: 0,
  shrubStemsPerSquareMeter: 0,
  heightFactor: 1,
  aspect: 0,
  forestEdge: 0,
  groundCover: OPEN_GRASSLAND_COVER,
  riparianBand: 0,
  canopyClosure: 0,
  grassCover: 1,
});

interface ForestPatternSample {
  readonly glade: number;
  readonly disturbance: number;
  readonly forestFraction: number;
  readonly forestEdge: number;
}

export interface RiparianVegetationFactors {
  readonly clearance: number;
  readonly treeDensityGain: number;
  readonly shrubDensityGain: number;
  /**
   * `6-6`: the bank band itself, 0 away from water and 1 on the exported bank.
   *
   * It was always computed here and only ever consumed as two density gains.
   * The species half needs the raw band — reed and fern archetype weight, and
   * the splat's wet-litter darkening — so it is now a named output rather than
   * a local, which is what keeps the corridor shape single-owned.
   */
  readonly bankBand: number;
}

/**
 * The riparian corridor's shape, as four named metre distances.
 *
 * `6-6` gave the band three consumers outside this file (archetype weighting,
 * the WGSL mirror, and the terrain fragment's wet-litter darkening), so the
 * numbers stop being literals inside one function: every consumer injects
 * THESE, and a retune moves the corridor everywhere at once instead of leaving
 * the ground and the plants disagreeing about where the bank is.
 */
export const RIPARIAN_BANK_NEAR_METERS = 1.5;
export const RIPARIAN_BANK_FULL_METERS = 6;
export const RIPARIAN_BANK_FADE_START_METERS = 28;
export const RIPARIAN_BANK_FADE_END_METERS = 50;

const NEUTRAL_RIPARIAN_FACTORS: RiparianVegetationFactors = Object.freeze({
  clearance: 1,
  treeDensityGain: 1,
  shrubDensityGain: 1,
  bankBand: 0,
});

/**
 * One multiplicative channel exclusion. It adds no placement lattice: the
 * shape comes entirely from the authoritative shore-distance export.
 */
export function riparianVegetationFactors(
  shoreDistanceMeters: number | undefined,
): RiparianVegetationFactors {
  if (shoreDistanceMeters === undefined) return NEUTRAL_RIPARIAN_FACTORS;
  if (!Number.isFinite(shoreDistanceMeters)) {
    throw new RangeError("shore distance must be finite when supplied");
  }
  if (shoreDistanceMeters <= 0) {
    return { clearance: 0, treeDensityGain: 1, shrubDensityGain: 1, bankBand: 0 };
  }
  const clearance = smoothstep(0, 2, shoreDistanceMeters);
  const bankBand = smoothstep(
    RIPARIAN_BANK_NEAR_METERS,
    RIPARIAN_BANK_FULL_METERS,
    shoreDistanceMeters,
  ) * (1 - smoothstep(
    RIPARIAN_BANK_FADE_START_METERS,
    RIPARIAN_BANK_FADE_END_METERS,
    shoreDistanceMeters,
  ));
  return {
    clearance,
    treeDensityGain: 1 + bankBand * 0.2,
    shrubDensityGain: 1 + bankBand * 0.65,
    bankBand,
  };
}

/** Multi-kilometre canopy gate: 0 is meadow, 1 is closed-forest province. */
export function forestFraction(
  seedHash: number,
  x: number,
  z: number,
  moisture: number,
  filterWidthMeters = 0,
): number {
  const provinceRaw = fbm2D(
    mixSeed(seedHash, 75),
    (x + z * 0.21) / 7_200,
    (z - x * 0.21) / 5_400,
    3,
    2,
    0.5,
    // The SMALLER period of an anisotropic channel keys its fade, exactly as
    // the terrain kernel's fracture channels do.
    5_400,
    filterWidthMeters,
  );
  return smoothstep(-0.22, 0.2, provinceRaw + (moisture - 0.55) * 0.7);
}

/**
 * Gate B's authored forest pattern. This stays in the density owner so no
 * renderer, material, or future classifier can grow a second answer to
 * "where is forest?".
 *
 * Three scales have deliberately different jobs:
 * - a multi-kilometre province gate makes meadow valleys and unbroken forest;
 * - a sharpened 260 m glade field can fall below the rendered-stem cap;
 * - disturbances include both a soft succession field and a rare hard edge.
 */
function sampleForestPattern(
  seedHash: number,
  x: number,
  z: number,
  moisture: number,
  filterWidthMeters: number,
): ForestPatternSample {
  // Moist climates are more likely to carry forest, but never force every
  // valley closed. The smooth gate is wide enough to form a real ecotone.
  const province = forestFraction(seedHash, x, z, moisture, filterWidthMeters);

  const gladeRaw = fbm2D(mixSeed(seedHash, 73), x / 260, z / 260, 2, 2, 0.5, 260, filterWidthMeters);
  // The previous 0.30 floor authored at least 240 stems/ha in a nominal
  // 800-stem stand, still far above the ~78/ha rendered cap. A 0.02 floor
  // lets a clearing actually expose ground after rendered-share thinning.
  const glade = 0.02 + 0.98 * smoothstep(-0.24, 0.02, gladeRaw);

  const successionRaw = fbm2D(
    mixSeed(seedHash, 74),
    x / 1_400,
    z / 1_400,
    2,
    2,
    0.5,
    1_400,
    filterWidthMeters,
  );
  // Full amplitude: the disturbed end reaches zero rather than retaining a
  // permanent 15% canopy floor.
  const succession = 1 - smoothstep(0.3, 0.48, successionRaw);

  // One genuinely hard-edged class (windthrow): an elongated, low-frequency
  // field is thresholded rather than eased. Real burns/cuts/windthrow do not
  // all dissolve through the same procedural softness.
  const windthrowRaw = filteredValueNoise2D(
    mixSeed(seedHash, 76),
    (x + z * 0.46) / 3_600,
    (z - x * 0.46) / 1_700,
    1_700,
    filterWidthMeters,
  );
  const windthrow = windthrowRaw > 0.61 ? 0 : 1;
  const disturbance = succession * windthrow;

  // Edge margins are keyed to the transition bands themselves, not a second
  // placement noise. The hard-edge term is intentionally narrow.
  const provinceEdge = 1 - smoothstep(0.05, 0.22, Math.abs(province - 0.5));
  const gladeEdge = 1 - smoothstep(0.025, 0.14, Math.abs(gladeRaw + 0.11));
  const windthrowEdge = 1 - smoothstep(0.008, 0.045, Math.abs(windthrowRaw - 0.61));
  const forestEdge = saturate(Math.max(provinceEdge, gladeEdge * 0.7, windthrowEdge));

  return { glade, disturbance, forestFraction: province, forestEdge };
}

export function densityField(
  seedHash: number,
  input: VegetationDensityInput,
): VegetationDensitySample {
  const elevation = input.heightMeters - input.seaLevelMeters;
  // Continuous shoreline: underwater and wave-washed sand carry nothing.
  const shoreline = smoothstep(1.5, 7, elevation);
  if (shoreline <= 0) return ZERO_DENSITY;
  const riparian = riparianVegetationFactors(input.shoreDistanceMeters);
  if (riparian.clearance <= 0) return ZERO_DENSITY;

  // Aspect from the horizontal normal: equator-facing (south, −z at 45°N)
  // slopes are warm. Flat ground has no aspect, faded in with steepness.
  const normalX = input.normalX ?? 0;
  const normalZ = input.normalZ ?? 0;
  const horizontal = Math.hypot(normalX, normalZ);
  const aspectStrength = smoothstep(0.015, 0.07, input.slope);
  const aspect = horizontal > 1e-6 ? (-normalZ / horizontal) * aspectStrength : 0;

  // The ragged treeline: base + aspect + shelter + a 2.4 km wander. Trees do
  // not stop at a contour line; they thin, shrink, and give up unevenly.
  const shelter = filteredValueNoise2D(
    mixSeed(seedHash, 72), input.x / 560, input.z / 560, 560, input.filterWidthMeters,
  );
  const treelineWander = fbm2D(
    mixSeed(seedHash, 71), input.x / 2_400, input.z / 2_400, 2, 2, 0.5,
    2_400, input.filterWidthMeters,
  );
  const treeline = TREELINE_BASE_METERS + aspect * 120 + shelter * 80 + treelineWander * 90;
  const treelineFactor = 1 - smoothstep(treeline - 220, treeline + 40, elevation);
  // Height taper begins below the density taper: trees become 2 m krummholz
  // before they disappear.
  const heightFactor = clamp(
    1 - smoothstep(treeline - 320, treeline - 30, elevation) * 0.88,
    0.12,
    1,
  );

  // Moisture is the closed-forest gate (sharpened so wet forest carries an
  // order of magnitude more stems than dry grassland), slope is a
  // soil-retention proxy falling to zero by ~38°, and the lapse term thins
  // growth with altitude below the treeline.
  const moistureFactor = Math.pow(smoothstep(0.3, 0.62, input.moisture), 1.6);
  const slopeFactor = 1 - smoothstep(0.05, 0.212, input.slope);
  const lapse = 1 - smoothstep(500, Math.max(501, treeline), elevation) * 0.45;
  const aspectFactor = 1 - aspect * 0.25;

  const forest = sampleForestPattern(
    seedHash,
    input.x,
    input.z,
    input.moisture,
    input.filterWidthMeters,
  );
  // Airfields are mown grass (1B-6): woody stems fade multiplicatively.
  const clearance = 1 - clamp(input.airportInfluence ?? 0, 0, 1);

  const habitat =
    shoreline * slopeFactor * lapse * treelineFactor * aspectFactor
    * forest.glade * forest.disturbance * forest.forestFraction * clearance
    * riparian.clearance * riparian.treeDensityGain;
  const treeStems = BASE_TREE_STEMS * moistureFactor * habitat;

  // Shrubs tolerate drier and steeper ground, prefer open glades and edges,
  // and persist a little above the canopy treeline.
  const shrubMoisture = smoothstep(0.2, 0.5, input.moisture);
  const shrubSlope = 1 - smoothstep(0.09, 0.26, input.slope);
  const shrubTreeline = 1 - smoothstep(treeline - 80, treeline + 140, elevation);
  const openness = 0.45 + 0.55 * (1 - forest.glade * 0.7);
  const shrubForestGate = 0.28 + forest.forestFraction * 0.72;
  const edgeShrubGain = 1 + forest.forestEdge * 0.45;
  const shrubStems =
    BASE_SHRUB_STEMS * shrubMoisture * shrubSlope * shrubTreeline * openness * shoreline
    * forest.disturbance * shrubForestGate * edgeShrubGain * clearance
    * riparian.clearance * riparian.shrubDensityGain;

  const groundCover = groundCoverWeights(
    input.moisture,
    input.slope,
    // Canopy closure IS the shade term: the field already knows how much
    // canopy stands here, so shade needs no field of its own.
    saturate(treeStems / BASE_TREE_STEMS),
    elevation,
    riparian.bankBand,
  );
  const closure = canopyClosure(saturate(treeStems));
  return {
    treeStemsPerSquareMeter: saturate(treeStems),
    shrubStemsPerSquareMeter: saturate(shrubStems),
    // Edge stems trade height for lateral mass in generation. Keeping the
    // scalar here makes the margin a property of the density authority.
    heightFactor: heightFactor * (1 - forest.forestEdge * 0.34),
    aspect,
    forestEdge: forest.forestEdge,
    groundCover,
    riparianBand: riparian.bankBand,
    canopyClosure: closure,
    grassCover: canopyGrassCover(groundCover.grass, closure),
  };
}
