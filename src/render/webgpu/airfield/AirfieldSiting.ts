import { mixSeed, unitFloatFromHash } from "../../../world/seed";
import type { AirportDefinition } from "../../../world/types";

/**
 * Where the airfield's structures stand and how big they are: the hangars'
 * siting and seeded plan, the tower's and the fuel farm's placement. Pure
 * arithmetic over `AirportDefinition` and the world seed, with no renderer in
 * it, so a worker can read it: the simulation worker builds the car's
 * building colliders from exactly these numbers (`src/sim/ground/carColliders.ts`),
 * so a hangar a car hits is the hangar on screen.
 *
 * **Kept apart from the builders on purpose.** `AirfieldStructures` and
 * `AirfieldFurniture` re-export all of it and build the meshes from it, but
 * they import Babylon, and `AirfieldMaterials` brings Babylon's PBR material
 * with it (a module Babylon marks as having side effects, so no bundler drops
 * it): reaching these numbers through them added about 1.6 MB to a worker.
 */

/**
 * Where a hangar stands, in runway-local coordinates.
 *
 * **`acrossOffsetMeters` is inherited, not chosen.** 118 m beyond the runway
 * edge is where the three boxes already sit, and moving them is a siting
 * decision with visual consequences that belongs with the art pass, not with a
 * geometry fix. Recorded as inherited so nobody reads it as derived.
 */
export const HANGAR_SITING = Object.freeze({
  count: 3,
  acrossOffsetMeters: 118,
  /** Spacing between adjacent hangars along the runway. */
  alongPitchMeters: 52,
  /** Group centre, as a fraction of runway length from the midpoint. */
  alongCentreFraction: -0.12,
  widthMeters: 46,
  depthMeters: 34,
});

export interface HangarFootprint {
  readonly along: number;
  readonly across: number;
  readonly widthMeters: number;
  readonly depthMeters: number;
}

/** Runway-local footprint of one hangar. */
export function hangarFootprint(
  airport: Readonly<AirportDefinition>,
  index: number,
): HangarFootprint {
  const siting = HANGAR_SITING;
  return {
    along:
      airport.runwayLength * siting.alongCentreFraction
      + (index - (siting.count - 1) / 2) * siting.alongPitchMeters,
    across: airport.runwayWidth * 0.5 + siting.acrossOffsetMeters,
    widthMeters: siting.widthMeters,
    depthMeters: siting.depthMeters,
  };
}

/**
 * Runway-local sample positions covering a footprint, at `stepMeters`.
 *
 * **The corners are guaranteed present regardless of step.** A stride that
 * divides the span unevenly would otherwise stop short of the edges, and the
 * corners are exactly where the current single-sample seating fails — a sampler
 * that misses them would report a smaller relief than the building sees, which
 * is the reassuring answer.
 */
export function hangarFootprintSamples(
  footprint: HangarFootprint,
  stepMeters: number,
): readonly { readonly along: number; readonly across: number }[] {
  if (!(stepMeters > 0)) throw new RangeError("stepMeters must be positive");
  const axis = (half: number): number[] => {
    const out: number[] = [];
    for (let value = -half; value < half; value += stepMeters) out.push(value);
    out.push(half);
    return out;
  };
  const out: { along: number; across: number }[] = [];
  for (const da of axis(footprint.depthMeters / 2)) {
    for (const dc of axis(footprint.widthMeters / 2)) {
      out.push({ along: footprint.along + da, across: footprint.across + dc });
    }
  }
  return Object.freeze(out);
}

export interface HangarSeating {
  /** Altitude of the finished floor slab. */
  readonly baseAltitudeMeters: number;
  /** How far the concrete skirt must reach below the slab. */
  readonly skirtHeightMeters: number;
  /** Ground relief under the footprint, for reporting. */
  readonly reliefMeters: number;
}

/**
 * Minimum skirt, so a hangar on flat ground still reads as founded rather than
 * resting on the grass. Not derived — an art floor, recorded as one.
 */
export const MINIMUM_SKIRT_METERS = 0.35;

/**
 * Seat a hangar on the ground actually under it.
 *
 * **The rule, and it is the whole item:** the slab sits at the HIGHEST ground
 * under the footprint, and the skirt reaches down to the LOWEST. Then no corner
 * is buried (nothing is above the slab) and none floats (the skirt closes the
 * gap). Seating on a centre sample cannot do either, because a centre is
 * neither bound.
 *
 * **Render-only.** This changes where the building sits, never the ground
 * height. The moment a skirt writes terrain height it becomes Class K:
 * collision short-circuits through the same earthworks profile and assertion 63
 * pins the two to under 1 mm.
 */
export function hangarSeatingFrom(groundSamples: readonly number[]): HangarSeating {
  if (groundSamples.length === 0) throw new RangeError("no ground samples");
  for (const sample of groundSamples) {
    if (!Number.isFinite(sample)) {
      // A non-finite sample means the ground query failed. Seating on it would
      // put the hangar at NaN and Babylon would silently not draw it, which
      // looks like "the hangar is missing" rather than "the query broke".
      throw new RangeError("ground sample is not finite — the height query failed");
    }
  }
  const highest = Math.max(...groundSamples);
  const lowest = Math.min(...groundSamples);
  return {
    baseAltitudeMeters: highest,
    skirtHeightMeters: Math.max(highest - lowest, MINIMUM_SKIRT_METERS),
    reliefMeters: highest - lowest,
  };
}

// ---------------------------------------------------------------------------
// The parametric plan (the shell it produces is `AirfieldStructures`').
// ---------------------------------------------------------------------------

export type HangarRoofProfile = "gabled" | "arched";

export interface HangarPlan {
  readonly bays: number;
  readonly roof: HangarRoofProfile;
  readonly widthMeters: number;
  readonly depthMeters: number;
  readonly eaveHeightMeters: number;
  /**
   * The structural ridge — **NOT the top of the building.**
   *
   * `7-10`'s ventilators stand `HANGAR_DETAIL.ventHeightMeters` above this, so
   * anything asking "how tall is the hangar" wants
   * `hangarAttachments().heightMeters`, which is asserted against the built
   * geometry's own y extent and moves on its own if a part ever grows taller.
   *
   * **TWO SESSIONS READ THIS FIELD AS THE TOP ON THE SAME EVENING**, in
   * different files, through different consumers. `hangarAttachments` returned
   * `ridge + skirt` and would have mounted `7-14`'s top obstruction lamp BELOW
   * the highest metal on the building; a frustum guard projected to the ridge
   * and would have passed a frame that cropped the vents. Neither author was
   * missing knowledge — both knew the vents existed. **"Ridge height" simply
   * READS like the top, so the wrong answer is available without anyone ever
   * forming a belief about it.** Hence this comment at the point of use, where
   * an editor shows it, rather than in a docblock nobody opens.
   */
  readonly ridgeHeightMeters: number;
  /**
   * Depth of the concrete skirt below the slab. `max(relief, MINIMUM_SKIRT)` —
   * it has a FLOOR, so it is not the raw terrain relief and a hand-rolled
   * min/max over ground samples will disagree with it on flat ground.
   */
  readonly skirtHeightMeters: number;
  /** Segments across the span for an arched roof; ignored when gabled. */
  readonly archSegments: number;
  /**
   * Where the roof's high point sits across the span, as a fraction of the
   * half-width from centre. **Non-zero on purpose.**
   *
   * A ridge exactly on the centreline is the strongest single cue that a
   * building is a primitive rather than a structure — it makes the silhouette
   * mirror-symmetric, which nothing built by people ever is. Jason's note on
   * the first apron close-up was that the hangar "looks like it was thrown
   * together with a semi circle and a square"; symmetry is half of why.
   */
  readonly crownOffset: number;
  /**
   * Superellipse exponent for the arched profile: `(1 - u^p)^(1/p)`.
   *
   * p = 2 is a circle — the dome read. **p > 2 flattens the crown and
   * straightens the haunch**, which is the segmental barrel vault a real
   * arch-roof hangar has. Seeded per hangar so three on one field do not share
   * a curve.
   */
  readonly archExponent: number;
}

/**
 * Bay count and roof profile are hash-driven, so three hangars on one field
 * read as different buildings and two fields differ from each other.
 *
 * **Two distinct channels, each mixed with the index.** Deriving one value and
 * varying it by index would make the three hangars a sequence (4, 5, 6) rather
 * than three independent draws, which reads as deliberate rather than
 * incidental — and it would tie the roof profile to the bay count.
 *
 * **This takes `world.seedHash`, never `sourceSeedHash`.** The airfield is
 * earthworks-coupled and therefore terrain-authority: it has to agree with the
 * ground it stands on. On a guaranteed-airport world the two differ — the exact
 * collision that caught two Phase 6 items — so the choice is load-bearing, and
 * the test asserts the sweep exercises worlds where they differ.
 */
export const HANGAR_PLAN_LIMITS = Object.freeze({
  minBays: 3,
  maxBays: 7,
  baseEaveHeightMeters: 11,
  eaveHeightPerBayMeters: 0.9,
  gabledRiseFraction: 0.18,
  /**
   * **0.32 -> 0.22 (2026-09-02).** At 0.32 the rise was 14.7 m over a 23 m
   * half-span — ratio 0.64, meeting the wall at 45 degrees — which renders as
   * a dome sitting on a box. A real barrel-vault hangar is a SEGMENTAL arc:
   * shallower, springing nearer the vertical. This is the single change with
   * the most effect on that read and it costs no triangles.
   */
  archedRiseFraction: 0.22,
  archSegments: 12,
  /** Distinct channels so bay count and profile are independent draws. */
  bayChannel: 8_101,
  profileChannel: 8_102,
  /**
   * `7-10` organic pass. Four MORE independent channels, not one reused with
   * an index: variance drawn from a single stream would correlate the eave
   * with the crown and read as one dial being turned, which is the failure the
   * bay/profile split already avoids.
   */
  eaveJitterChannel: 8_103,
  riseJitterChannel: 8_104,
  crownChannel: 8_105,
  exponentChannel: 8_106,
  yawChannel: 8_107,
  /** Per-hangar eave variation, +/- this fraction. */
  eaveJitterFraction: 0.055,
  /** Per-hangar rise variation, +/- this fraction. */
  riseJitterFraction: 0.11,
  /**
   * Crown offset magnitude range, as a fraction of the half-width.
   *
   * **There is a FLOOR because a uniform draw includes zero.** The first
   * version drew uniformly in [-max, max] and a hangar landed at 0.0034 —
   * a crown 8 cm off the centreline, which at apron range is about two pixels
   * and is simply a symmetric roof. Variance that is allowed to vanish does
   * not deliver the property on the instances where it vanishes; the sign
   * carries the variety, the magnitude has to stay visible.
   */
  minCrownOffset: 0.035,
  maxCrownOffset: 0.085,
  /**
   * Superellipse exponent range for the arched profile, bracketing the TRUE
   * segmental circular arc.
   *
   * **The first attempt at this used 2.3-3.2 and was wrong in the direction of
   * the complaint.** A superellipse with p > 2 flattens the crown toward a
   * ROUNDED RECTANGLE: at p = 2.8 the roof stands at 0.95 of its rise halfway
   * out the span, so it is nearly flat across the middle and then falls off a
   * shoulder. Jason's note was that the building reads as "a semi circle and a
   * square", and p > 2 makes it more square.
   *
   * Measured against real profiles, height at half-span as a fraction of rise:
   *
   *     true segmental circular arc   0.782   <- what a barrel hangar is
   *     parabola                      0.750
   *     ellipse (p = 2)               0.866
   *     the old cosine                0.707
   *     p = 2.8                       0.946   <- the wrong answer
   *
   * So the range brackets 0.782 from both sides rather than sitting above it.
   * **The rise reduction is what fixes the dome; the exponent only supplies
   * per-hangar variance**, and it should not be asked to do more.
   */
  minArchExponent: 1.75,
  maxArchExponent: 2.2,
});

export function hangarPlanFrom(
  seedHash: number,
  index: number,
  skirtHeightMeters: number,
): HangarPlan {
  const limits = HANGAR_PLAN_LIMITS;
  const siting = HANGAR_SITING;
  const span = limits.maxBays - limits.minBays + 1;
  const bayHash = mixSeed(mixSeed(seedHash, limits.bayChannel), index);
  const profileHash = mixSeed(mixSeed(seedHash, limits.profileChannel), index);
  const bays = limits.minBays + Math.min(span - 1, Math.floor(unitFloatFromHash(bayHash) * span));
  const roof: HangarRoofProfile = unitFloatFromHash(profileHash) < 0.5 ? "gabled" : "arched";
  // Signed unit draws in [-1, 1] from four independent channels.
  const signed = (channel: number): number =>
    unitFloatFromHash(mixSeed(mixSeed(seedHash, channel), index)) * 2 - 1;

  // **THE HEIGHTS VARY PER HANGAR AND THE STEP RULE STILL SETS THE BASE.**
  // Bay count already drove the eave in fixed 0.9 m steps, which is why three
  // hangars read as one building at three scales: the heights formed an
  // arithmetic sequence. The jitter breaks the sequence without discarding the
  // rule that taller buildings have more bays.
  const eave = (limits.baseEaveHeightMeters
    + (bays - limits.minBays) * limits.eaveHeightPerBayMeters)
    * (1 + signed(limits.eaveJitterChannel) * limits.eaveJitterFraction);
  const rise = siting.widthMeters
    * (roof === "gabled" ? limits.gabledRiseFraction : limits.archedRiseFraction)
    * (1 + signed(limits.riseJitterChannel) * limits.riseJitterFraction);
  return {
    bays,
    roof,
    widthMeters: siting.widthMeters,
    depthMeters: siting.depthMeters,
    eaveHeightMeters: eave,
    ridgeHeightMeters: eave + rise,
    skirtHeightMeters,
    archSegments: limits.archSegments,
    // One draw supplies both sign and magnitude: the sign is its own, and
    // |draw| is uniform on [0, 1] so the magnitude spans [min, max] evenly.
    crownOffset: Math.sign(signed(limits.crownChannel) || 1)
      * (limits.minCrownOffset
        + Math.abs(signed(limits.crownChannel))
          * (limits.maxCrownOffset - limits.minCrownOffset)),
    archExponent: limits.minArchExponent
      + unitFloatFromHash(mixSeed(mixSeed(seedHash, limits.exponentChannel), index))
        * (limits.maxArchExponent - limits.minArchExponent),
  };
}

/**
 * Largest per-hangar yaw, radians. Three buildings on exactly parallel axes is
 * a placement no airfield has, and it is the cue that survives every change to
 * the buildings themselves — vary the roofs all you like and a perfectly
 * parallel row still reads as instanced.
 *
 * **Deliberately tiny.** At 1.4 degrees a 46 x 34 m hangar's corners move by
 * about 0.7 m, which is inside the 18 m the siting already leaves between
 * footprints, so it cannot introduce a collision. Larger would start to look
 * like a mistake rather than a building that was set out by eye.
 */
export const HANGAR_MAX_YAW_RADIANS = 0.024;

/** Seeded yaw for one hangar. Its own channel, per the plan's variance rule. */
export function hangarYawRadians(seedHash: number, index: number): number {
  const draw = unitFloatFromHash(
    mixSeed(mixSeed(seedHash, HANGAR_PLAN_LIMITS.yawChannel), index),
  );
  return (draw * 2 - 1) * HANGAR_MAX_YAW_RADIANS;
}

/** The ATC tower's placement, exported so the band can derive rather than restate. */
export const TOWER_LATERAL_OFFSET_METERS = 95;
export const TOWER_ALONG_FRACTION = 0.06;
/** Plan radius of the tower's widest element, for the band's across span. */
export const TOWER_PLAN_RADIUS_METERS = 7;

/** A bulk avgas tank: 12 m long, 2.5 m diameter, horizontal on saddles. */
export const FUEL_TANK_LENGTH_METERS = 12;
export const FUEL_TANK_RADIUS_METERS = 1.25;
export const FUEL_FARM_LATERAL_OFFSET_METERS = 135;

/**
 * Height of the tower's concrete base, the octagonal frustum its shaft
 * stands on (`towerGeometry`): what a car at the tower's foot meets.
 */
export const TOWER_BASE_HEIGHT_METERS = 6;

/** Runway-local centre of the tower's footprint (`AirfieldPlacement.towerSite`). */
export function towerPlanPosition(airport: Readonly<AirportDefinition>): { along: number; across: number } {
  return {
    along: airport.runwayLength * TOWER_ALONG_FRACTION,
    across: airport.runwayWidth * 0.5 + TOWER_LATERAL_OFFSET_METERS,
  };
}

/** Two tanks: avgas and jet A, which is what a field this size carries. */
export const FUEL_TANK_COUNT = 2;
/** Along-runway gap between tank centres, metres. */
export const FUEL_TANK_PITCH_METERS = 18;
/** Saddles per tank, at a quarter and three-quarters of its length. */
export const FUEL_TANK_SADDLE_FRACTIONS: readonly number[] = Object.freeze([0.25, 0.75]);

/**
 * Runway-local centres of each tank.
 *
 * On the POSITIVE `across` side, with the hangars — a fuel farm belongs beside
 * the apron, and the negative side carries the PAPI, which must not be occluded
 * from the approach.
 */
export function fuelTankPlacements(): readonly { along: number; across: number }[] {
  const out: { along: number; across: number }[] = [];
  const span = (FUEL_TANK_COUNT - 1) * FUEL_TANK_PITCH_METERS;
  for (let index = 0; index < FUEL_TANK_COUNT; index += 1) {
    out.push({
      along: -span / 2 + index * FUEL_TANK_PITCH_METERS,
      across: FUEL_FARM_LATERAL_OFFSET_METERS,
    });
  }
  return out;
}
