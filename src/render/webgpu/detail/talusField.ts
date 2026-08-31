import { saturate, smoothstep } from "@/src/world/noise";

/**
 * `6-7` — the talus and scree PLACEMENT law.
 *
 * INVARIANT THIS FILE OWNS: where loose rock debris rests, how much of it
 * rests there, and how big a block is. `2-15` already built everything a
 * scree field needs to be DRAWN — displaced-icosphere prototypes with
 * per-lithology normals, `normalAlignedQuaternion` orientation, the
 * `radius·flattening·(0.12 + 0.25·hash)` sink, and the slope-shedding snow
 * cover that only rocks are steep enough to exercise. What did not exist was
 * a reason for a rock to be anywhere in particular: `rockProbability` was a
 * biome table plus `slope·0.35`, which sprays loose blocks uniformly over
 * every steep surface, INCLUDING the vertical faces that physically cannot
 * hold them. This file is the missing law, and nothing else may grow a second
 * answer to "is there scree here".
 *
 * ## The physics, as three statements
 *
 * 1. **A face steeper than the angle of repose does not hold debris.** It is
 *    a failure face: what it sheds leaves. So the loose-block population is
 *    REMOVED from over-repose ground ({@link talusFailureFraction} feeding
 *    {@link TALUS_FACE_SHED_MAX}) and re-appears below, which is why this item
 *    is a redistribution rather than an addition.
 * 2. **Debris rests at or under repose, below a source.** An apron needs a
 *    failure face ABOVE it — the supply integral — and its density falls with
 *    travel distance from that face, because a cone thins as it spreads. Both
 *    numbers come from one upslope probe along the fall line.
 * 3. **Deep soil means the slope is stable and vegetated.** Soil depth is the
 *    inverse of rock exposure, and it is `5-5`'s channel: the one input this
 *    law shares with `6-6`.
 *
 * ## Grain size: fall sorting, stated and chosen
 *
 * Talus is DOWNSLOPE-COARSENING, and that is the model implemented here. A
 * block leaving a face carries momentum in proportion to its mass; small
 * clasts stop in the first metres of the apron while large blocks bounce and
 * roll to the toe. The observation is old and consistent (fall sorting), and
 * it is the opposite of the "fines wash downhill" intuition that fits
 * water-laid deposits. The visible consequence is the one worth having:
 * a fine, dense, angular skirt directly under the cliff, and isolated
 * boulders standing well out on the lower slope.
 *
 * The mechanism is not modelled per block — {@link talusPlacement} returns
 * the characteristic block radius at a point and the placement RNG spreads
 * around it, so the sorting is a field property rather than a simulation.
 *
 * ## Lithology enters through ONE owned number
 *
 * `sampleTerrainEvolutionGeology` publishes `reposeDegrees` (28°–42° over its
 * hardness field). That single value carries both halves of the lithology
 * coupling, because the angle of repose IS a statement about clast size and
 * angularity: massive, well-jointed rock breaks into coarse angular blocks
 * that stand near 40°, while thinly-bedded weak rock weathers to chips that
 * stand near 30°. So repose sets the resting band directly, and
 * {@link talusBlockiness} reads the SAME number for the density and grain
 * terms. Nothing here inverts the producer's hardness lerp — an unpublished
 * intermediate is not an input.
 *
 * ## Season invariance is deliberate
 *
 * This file is NOT a member of `SEASONAL_FIELD_FAMILY` and must not become
 * one. Rocks may not pop with the calendar any more than stems may, so the
 * permanent-snow burial term is keyed to the world's REFERENCE snowline
 * offset (the midsummer line, i.e. where snow actually persists), never to
 * `FoliageSeason.snowlineMeters`, which descends through the winter.
 *
 * Class P: pure arithmetic over metres, degrees and unit slopes. No noise
 * lattice, no hashing, no world-coordinate arithmetic of its own — which is
 * also why it is exactly as correct 1,000 km from the origin as at it.
 */

/**
 * Normalized steepness (`1 − normalY`, the convention the density field and
 * `DetailTerrainSample` both use) of an angle given in degrees.
 */
export function talusReposeSteepness(reposeDegrees: number): number {
  if (!Number.isFinite(reposeDegrees) || reposeDegrees <= 0 || reposeDegrees >= 90) {
    throw new RangeError("Talus repose angle must be a finite angle in (0, 90) degrees");
  }
  return 1 - Math.cos((reposeDegrees * Math.PI) / 180);
}

/**
 * Width, in normalized steepness, of the band above repose over which a
 * surface stops being a slope and becomes a failure face. 0.075 is ~7.5° at
 * the 34° median repose and ~6.4° at 42°: a real break-of-slope is a metre-
 * scale transition, not a knife edge, but it is not 20° wide either.
 */
export const TALUS_FAILURE_BAND_STEEPNESS = 0.075;

/**
 * The apron's LOWER shoulder, as fractions of the local repose steepness.
 * Below ~12° a debris sheet is alluvium or colluvium, not talus; by ~25° the
 * runout apron is fully expressed. Expressed as fractions rather than
 * absolute slopes so a soft-rock (28°) apron runs out onto correspondingly
 * gentler ground than a hard-rock (42°) one.
 */
export const TALUS_TOE_LOW_FRACTION = 0.12;
export const TALUS_TOE_HIGH_FRACTION = 0.55;

/**
 * The supply window, in metres of above-repose face found upslope. A 6 m
 * crag contributes almost nothing; 40 m of cliff saturates the apron below
 * it. Beyond saturation the extra height goes into travel distance, not into
 * density, which is why the apron under a 600 m wall is not 15× denser than
 * the one under a 40 m wall — it is LONGER.
 */
export const TALUS_SUPPLY_MIN_RELIEF_METERS = 6;
export const TALUS_SUPPLY_FULL_RELIEF_METERS = 40;

/**
 * Runout attenuation window, in metres of travel from the supplying face.
 * Talus cones in this relief class are tens of metres long; 115 m is the
 * outer limit at which a rockfall apron is still recognisably an apron.
 * The probe that feeds this reaches 96 m, so the far end is deliberately
 * just outside the instrument: the law degrades to "faint" rather than to a
 * cliff-edged disc at the probe's last step.
 */
export const TALUS_RUNOUT_NEAR_METERS = 35;
export const TALUS_RUNOUT_FAR_METERS = 115;

/**
 * Soil burial window, in metres — MEASURED, and deliberately not
 * `soilLitterFactor`'s [0.9, 4.6].
 *
 * The litter window spans the whole-page crest-to-floor spread, because
 * litter accumulates wherever there is any soil at all. An apron only exists
 * on ground steep enough that the soil proxy's `exp(−tan S / 0.35)` retention
 * term has already collapsed, so the apron-site distribution is a different,
 * much thinner population — and reusing the litter window would put every
 * apron at the fully-exposed end, leaving `5-5`'s channel decorative here.
 *
 * Measured 2026-08-31 over 5,546 apron-capable sites (positive rest weight
 * AND positive upslope supply) across five 4×4 km windows spanning mountain,
 * foothill and rolling terrain, at 32 m spacing:
 *
 *   soil source              p5    p25   p50   p75   p95   p99.9   metres
 *   analytic fallback        0.27  0.39  0.62  0.99  1.62  1.94
 *   eroded channel fixture   0.32  0.50  0.79  1.27  2.16  3.24
 *
 * [0.45, 1.9] therefore lands the ramp ON both distributions rather than past
 * them: bare rock and thin crest soils sit at full exposure, the upper
 * quartile of either population is substantially buried, and the eroded
 * channel — which carries the curvature and contributing-area terms the
 * analytic fallback cannot — sits systematically deeper, which is the
 * difference the channel exists to make.
 */
export const TALUS_SOIL_BARE_METERS = 0.45;
export const TALUS_SOIL_BURIED_METERS = 1.9;

/**
 * Repose window over which debris changes character from chips to blocks.
 * These are PHYSICAL angles for fine-angular versus coarse-blocky scree, not
 * a copy of the producer's 28°–42° hardness range: if that range is ever
 * re-pinned this window still means the same thing.
 */
export const TALUS_FINE_REPOSE_DEGREES = 30;
export const TALUS_BLOCKY_REPOSE_DEGREES = 40;

/**
 * Soft-rock density floor. Weak rock produces MORE debris by volume than hard
 * rock, but it weathers to chips and grus, which belong to the ground layer's
 * texture and not to an instanced 320-triangle block. So the instanced
 * population still exists on shale, at ~a third of a granite apron's count.
 */
export const TALUS_SOFT_ROCK_BLOCK_FLOOR = 0.35;

/** Characteristic block radius at the apex and at the toe, before lithology. */
export const TALUS_APEX_BLOCK_RADIUS_METERS = 0.34;
export const TALUS_TOE_BLOCK_RADIUS_METERS = 2.5;

/** Grain scale at the fine and blocky ends of the repose window. */
export const TALUS_FINE_GRAIN_SCALE = 0.72;
export const TALUS_BLOCKY_GRAIN_SCALE = 1.28;

/**
 * Fraction of a face's loose-block population that a fully-developed failure
 * face sheds. Not 1: benches, ledges and in-situ knobs survive on any real
 * cliff, and the `2-15` prototype reads as both a perched block and an
 * outcrop knob.
 */
export const TALUS_FACE_SHED_MAX = 0.55;

/**
 * Metres above the world's REFERENCE (midsummer) snowline over which a talus
 * apron is buried by permanent snow and ice. 300 m puts the whole alpine
 * scree belt below the band and takes the aprons only off the permanent
 * snowfields, where a bare boulder field would be wrong all year.
 */
export const TALUS_PERMANENT_SNOW_BURIAL_BAND_METERS = 300;

/**
 * How far above repose this surface is, in [0, 1]. Zero at and below the
 * angle of repose; one on a developed failure face. Read twice, for the two
 * halves of statement 1: it removes loose blocks from the face and it closes
 * the apron's upper edge.
 */
export function talusFailureFraction(slope: number, reposeDegrees: number): number {
  if (!Number.isFinite(slope) || slope < 0 || slope > 1) {
    throw new RangeError("Talus slope must be a finite normalized steepness in [0, 1]");
  }
  const repose = talusReposeSteepness(reposeDegrees);
  return smoothstep(repose, repose + TALUS_FAILURE_BAND_STEEPNESS, slope);
}

/**
 * The resting band: debris holds at or under repose, on ground steep enough
 * to be a slope at all. Zero on the valley floor, zero on the cliff, one on
 * the apron between them.
 */
export function talusRestWeight(slope: number, reposeDegrees: number): number {
  const repose = talusReposeSteepness(reposeDegrees);
  const holds = smoothstep(
    repose * TALUS_TOE_LOW_FRACTION,
    repose * TALUS_TOE_HIGH_FRACTION,
    slope,
  );
  return holds * (1 - talusFailureFraction(slope, reposeDegrees));
}

/** 0 for fine chippy scree, 1 for coarse blocky talus. One owned input. */
export function talusBlockiness(reposeDegrees: number): number {
  if (!Number.isFinite(reposeDegrees) || reposeDegrees <= 0 || reposeDegrees >= 90) {
    throw new RangeError("Talus repose angle must be a finite angle in (0, 90) degrees");
  }
  return smoothstep(TALUS_FINE_REPOSE_DEGREES, TALUS_BLOCKY_REPOSE_DEGREES, reposeDegrees);
}

/**
 * The upslope supply integral, as the two numbers the law needs. Produced by
 * walking the fall line (see `probeTalusSupply` in generation.ts); kept as a
 * named type so the law can be exercised on fixtures without a terrain
 * sampler.
 */
export interface TalusSupplyProbe {
  /**
   * Metres of ABOVE-REPOSE face found upslope inside the probe's reach. This
   * is a supply, not a relief: a 90 m rise at 20° contributes nothing because
   * a 20° hillside does not shed blocks.
   */
  readonly failureReliefMeters: number;
  /**
   * Supply-weighted path distance to that face, metres. Zero when there is no
   * supply. Drives BOTH the runout attenuation and the fall-sorting grain
   * size, which is what keeps "sparse" and "coarse" the same statement about
   * the toe rather than two independent knobs.
   */
  readonly travelMeters: number;
}

export interface TalusPlacementInput {
  /** Normalized steepness at the site (`1 − normalY`). */
  readonly slope: number;
  /** `sampleTerrainEvolutionGeology`'s published repose angle. */
  readonly reposeDegrees: number;
  /**
   * Metres of soil. `5-5`'s channel where a hydrology page has provisioned
   * the point; the owned `terrainSoilDepthMeters` law evaluated on slope
   * alone where one has not. Never a second soil model.
   */
  readonly soilDepthMeters: number;
  readonly probe: TalusSupplyProbe;
  /**
   * Metres above the REFERENCE (midsummer) snowline. Negative below it.
   * Season-invariant by construction — see the file docblock.
   */
  readonly metersAbovePermanentSnowline: number;
}

export interface TalusPlacementSample {
  /** Apron occupancy in [0, 1]; the acceptance gain, not a probability. */
  readonly density: number;
  /** Characteristic block radius at this point, metres. */
  readonly grainRadiusMeters: number;
}

/**
 * The empty answer: no apron here. Named and exported so a caller that has
 * already decided an apron is impossible does not have to invent its own
 * zero — the same reason `densityField` exports its own `ZERO_DENSITY` shape.
 */
export const TALUS_NO_PLACEMENT: TalusPlacementSample = Object.freeze({
  density: 0,
  grainRadiusMeters: TALUS_APEX_BLOCK_RADIUS_METERS,
});

/** The neutral probe: no failure face upslope, therefore no apron. */
export const TALUS_NO_SUPPLY: TalusSupplyProbe = Object.freeze({
  failureReliefMeters: 0,
  travelMeters: 0,
});

export function talusPlacement(input: TalusPlacementInput): TalusPlacementSample {
  if (!Number.isFinite(input.soilDepthMeters) || input.soilDepthMeters < 0) {
    throw new RangeError("Talus soil depth must be finite and non-negative");
  }
  if (
    !Number.isFinite(input.probe.failureReliefMeters)
    || input.probe.failureReliefMeters < 0
    || !Number.isFinite(input.probe.travelMeters)
    || input.probe.travelMeters < 0
  ) {
    throw new RangeError("Talus supply probe must be finite and non-negative");
  }
  if (!Number.isFinite(input.metersAbovePermanentSnowline)) {
    throw new RangeError("Talus snowline offset must be finite");
  }
  const rest = talusRestWeight(input.slope, input.reposeDegrees);
  const blockiness = talusBlockiness(input.reposeDegrees);
  // Sorting is read even where the apron is empty, so the grain a caller
  // blends toward is always defined; density decides whether it matters.
  const sorting = smoothstep(0, TALUS_RUNOUT_FAR_METERS, input.probe.travelMeters);
  const grainRadiusMeters = (
    TALUS_APEX_BLOCK_RADIUS_METERS
    + (TALUS_TOE_BLOCK_RADIUS_METERS - TALUS_APEX_BLOCK_RADIUS_METERS) * sorting
  ) * (
    TALUS_FINE_GRAIN_SCALE
    + (TALUS_BLOCKY_GRAIN_SCALE - TALUS_FINE_GRAIN_SCALE) * blockiness
  );
  if (rest <= 0) return { ...TALUS_NO_PLACEMENT, grainRadiusMeters };

  const supply = smoothstep(
    TALUS_SUPPLY_MIN_RELIEF_METERS,
    TALUS_SUPPLY_FULL_RELIEF_METERS,
    input.probe.failureReliefMeters,
  );
  const runout = 1 - smoothstep(
    TALUS_RUNOUT_NEAR_METERS,
    TALUS_RUNOUT_FAR_METERS,
    input.probe.travelMeters,
  );
  const exposed = 1 - smoothstep(
    TALUS_SOIL_BARE_METERS,
    TALUS_SOIL_BURIED_METERS,
    input.soilDepthMeters,
  );
  const instancedShare = TALUS_SOFT_ROCK_BLOCK_FLOOR
    + (1 - TALUS_SOFT_ROCK_BLOCK_FLOOR) * blockiness;
  const snowBuried = smoothstep(
    0,
    TALUS_PERMANENT_SNOW_BURIAL_BAND_METERS,
    input.metersAbovePermanentSnowline,
  );
  return {
    density: saturate(
      rest * supply * runout * exposed * instancedShare * (1 - snowBuried),
    ),
    grainRadiusMeters,
  };
}
