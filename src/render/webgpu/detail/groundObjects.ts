/**
 * Bushes and boulders: the objects between a tree and the ground's own skin.
 *
 * Why this exists. Open ground with nothing on it between the trees and the
 * terrain texture reads as a painted sheet. Bushes were already authored
 * (`scatterShrubs`) and so were rocks (`generateRocks`), but a bush was a
 * dozen thin leaf cards thinned by the tree law, so it was gone by a couple of
 * hundred metres and threw no shadow, and a rock stopped at the near radius.
 * Neither was there at the range the eye judges open ground from.
 *
 * What changed. Each bush gets a solid body under its cards, a 12-triangle
 * stand-in for that body once its shape cannot be seen, a ground shadow, and
 * a reach set by its own size; each rock gets the reach and the shadow. Both
 * stay on the worker-placed detail path, which already keeps every stem off
 * roads, aprons and buildings exactly and batches one draw per prototype per
 * chunk.
 *
 * This module is the CPU half of that rule and has no Babylon dependency: the
 * reach law the two shaders transliterate, the shares of a bush its body
 * takes, and what the whole thing is booked at.
 */

/** The one batch every bush body draws in, whatever its species. */
export const SHRUB_BODY_PROTOTYPE_KEY = "shrub-body";
/** The batch of its stand-in: the same bush once it is a few pixels tall. */
export const SHRUB_BODY_FAR_PROTOTYPE_KEY = "shrub-body-far";

/**
 * Metres of range per metre of height: an object is drawn while it stands
 * about three pixels tall on a 1080-line frame (one pixel is 0.97 mrad at the
 * 60 degree field of view, so three pixels of a 1 m object is 343 m). Past
 * that it is a flicker, not a bush.
 */
export const GROUND_OBJECT_REACH_METERS_PER_METER = 300;

/**
 * The last share of its reach over which an object grows in. It scales up
 * from the ground rather than dithering, so the opaque path keeps its early-Z
 * and a three pixel object has no frame in which it pops.
 */
export const GROUND_OBJECT_REACH_GROW_SHARE = 0.2;

/** The scale an object starts growing from at the edge of its reach. */
export const GROUND_OBJECT_REACH_START_SCALE = 0.35;

/**
 * A bush's leaf cards reach this far per metre of its height, and never past
 * the near radius: inside it the cards are the bush's surface, past it the
 * body alone is. They grow out of the body over the last share of that range.
 */
export const SHRUB_CARD_REACH_METERS_PER_METER = 90;
export const SHRUB_CARD_REACH_GROW_SHARE = 0.3;
/** Cards start at the body's own size, so they emerge from inside it. */
export const SHRUB_CARD_REACH_START_SCALE = 0.8;

/**
 * At range the body is the bush: these shares of its height and radius, a
 * little inside the tips of the cards it takes over from.
 */
export const SHRUB_BODY_HEIGHT_SHARE = 0.88;
export const SHRUB_BODY_RADIUS_SHARE = 0.86;

/**
 * The body is a clump of three mounds, 60 triangles, and the densest scrub
 * round the default start puts sixteen thousand bushes inside a Medium
 * camera's reach. So it is drawn only while its shape can be seen: out to
 * this many metres per metre of its height, about ten pixels tall on a
 * 1080-line frame. Past that a 12-triangle stand-in draws in its place, out
 * to the bush's reach. The body shrinks away over the last
 * `GROUND_OBJECT_REACH_GROW_SHARE` of its range, as everything on the reach
 * law does, and the stand-in is there from where that starts, so the clump
 * sinks into it and nothing pops.
 */
export const SHRUB_BODY_SWAP_METERS_PER_METER = 110;
/**
 * The stand-in is one mound, and takes this share of the body's radius: about
 * what the clump's three mounds cover between them.
 */
export const SHRUB_BODY_FAR_RADIUS_SHARE = 0.8;

/**
 * Up close the body is the bush's core: the wood and shaded inner leaves its
 * cards stand out from. A dozen leaf cards carry a bush only once their
 * leaves are resolved, so the body stays the lit surface until the bush
 * stands about fifty pixels tall on a 1080-line frame (20 m of range per
 * metre of its height), and over the nearer half of that range it shrinks to
 * this share of itself and darkens to this share of its colour. Left lit and
 * full size it hid two cards in three and a bush at arm's length was a mossy
 * boulder with leaves stuck on; shrunk across the cards' whole reach, a bush
 * thirty metres off was a pebble with a few leaves floating round it.
 */
export const SHRUB_BODY_CORE_REACH_METERS_PER_METER = 20;
export const SHRUB_BODY_CORE_GROW_SHARE = 0.5;
export const SHRUB_BODY_CORE_SCALE = 0.72;
export const SHRUB_BODY_CORE_SHADE = 0.55;

/**
 * The body's surface grain (`DetailInstanceMaterialPlugin.setClusterGrain`).
 * It is lit as a tree's dense crown is, by a field of leaf clumps, and a
 * crown's clumps (0.74 m and 0.27 m) are as big as a bush's own lumps: at 15
 * to 60 m a thicket was a field of smooth green boulders. A bush's clumps are
 * this many times finer (16 cm and 6 cm), with deeper crevices between them
 * and a stronger normal, so the body reads as a mass of leaves for as long as
 * a clump covers a pixel or two. Past that it converges to the same mean
 * tone: floor + span / 2 is 1, as a crown's is.
 */
export const SHRUB_BODY_GRAIN_FREQUENCY = 4.5;
export const SHRUB_BODY_GRAIN_TONE_FLOOR = 0.5;
export const SHRUB_BODY_GRAIN_TONE_SPAN = 1;
export const SHRUB_BODY_GRAIN_NORMAL = 1.5;

/**
 * Bushes drawn per hectare of a cell under closed canopy, the understory's
 * budget before this change (`60 * renderedShareAtDistance` at the near cap).
 * Understory is only ever seen from inside the stand, so it keeps that.
 */
export const SHRUB_UNDERSTORY_DRAWN_PER_HECTARE = 60;

/**
 * Bushes drawn per hectare of a cell on open ground. Open scrub authors up to
 * about 250 per hectare at full density; this only stops a cell that is one
 * solid thicket from drawing its whole 600.
 */
export const SHRUB_OPEN_DRAWN_PER_HECTARE = 260;

/**
 * The open-ground cap a tier draws: its share of the cap above, by the same
 * density scale its cells are authored at, so the cap stops the same cells
 * (the solid thickets) on every tier.
 */
export function shrubOpenDrawnPerHectare(vegetationDensity: number): number {
  if (!(vegetationDensity > 0)) return 0;
  return SHRUB_OPEN_DRAWN_PER_HECTARE * Math.min(1, vegetationDensity);
}

/** A bush under at least this much canopy is understory. */
export const SHRUB_UNDERSTORY_CANOPY_CLOSURE = 0.5;

/** How much direct sun a bush in leaf stops, and what its bare twigs still stop. */
export const SHRUB_GROUND_SHADOW_OPACITY = 0.82;
export const SHRUB_GROUND_SHADOW_BARE_SHARE = 0.3;

/**
 * How far an object of this height is drawn: its reach, capped by the tier's
 * range for ground objects. The detail plugin's `DETAIL_SIZE_RANGE` block and
 * the ground shadow's vertex stage compute exactly this from the record's own
 * height lane, so a body and its shadow agree to the metre.
 */
export function groundObjectReachMeters(
  heightMeters: number,
  capMeters: number,
  metersPerMeter = GROUND_OBJECT_REACH_METERS_PER_METER,
): number {
  if (!(heightMeters > 0) || !(capMeters > 0)) return 0;
  return Math.min(heightMeters * metersPerMeter, capMeters);
}

/**
 * How large an object is drawn at a range, as a share of its full size: 0
 * past its reach, growing to 1 over the last `growShare` of it.
 */
export function groundObjectDrawnScale(
  distanceMeters: number,
  reachMeters: number,
  growShare = GROUND_OBJECT_REACH_GROW_SHARE,
  startScale = GROUND_OBJECT_REACH_START_SCALE,
): number {
  if (!(reachMeters > 0) || !(distanceMeters < reachMeters)) return 0;
  const grow = Math.min(1, (reachMeters - distanceMeters) / Math.max(reachMeters * growShare, 1));
  return startScale + (1 - startScale) * grow;
}

/**
 * The bush the record estimate below is taken at. The count inside a reach
 * goes with the square of the height, so this is about the root mean square
 * of the heights in the densest scrub measured (2026-11-12, default world,
 * 9,000 to 16,000 bushes inside a Medium camera's reach: medians 1.15 to
 * 1.65 m, ninth deciles 2.0 to 2.35 m).
 */
export const GROUND_OBJECT_BUDGET_BUSH_HEIGHT_METERS = 1.6;

export interface BushRecordEstimateInput {
  /** The law's near radius: the cap on a bush's leaf cards. */
  readonly nearRadiusMeters: number;
  /** The tier's cap on a ground object's reach. */
  readonly groundObjectRangeMeters: number;
  /** How far a ground shadow record is kept (the tree shadow reach). */
  readonly groundShadowReachMeters: number;
  /** Bushes drawn per hectare: the tier's open cap, or the understory's. */
  readonly drawnPerHectare: number;
  /** Under closed canopy a bush's solid goes only as far as its cards. */
  readonly understory: boolean;
  /** How far past its reach a record stays resident (the membership slack). */
  readonly membershipSlackMeters: number;
  readonly bushHeightMeters?: number;
}

export interface BushRecordEstimate {
  /** Bushes with any record at all. */
  readonly bushes: number;
  readonly cardRecords: number;
  readonly bodyRecords: number;
  readonly standInRecords: number;
  readonly shadowRecords: number;
  readonly records: number;
  /** How far out those records lie. */
  readonly radiusMeters: number;
}

/**
 * Bush records resident where every cell inside reach draws its whole cap:
 * the landscape the instance budget books bushes at. It follows
 * `buildPresentationChunk` record for record, for one bush height.
 *
 * It is a saturation, not a bound: scrub of taller bushes than the reference,
 * out to their whole reach, would hold more.
 */
export function estimateBushRecords(input: BushRecordEstimateInput): BushRecordEstimate {
  const height = input.bushHeightMeters ?? GROUND_OBJECT_BUDGET_BUSH_HEIGHT_METERS;
  const cap = input.groundObjectRangeMeters;
  const perHectare = Math.max(0, input.drawnPerHectare);
  const slack = Math.max(0, input.membershipSlackMeters);
  const bodyHeight = height * SHRUB_BODY_HEIGHT_SHARE;
  const cardReach = groundObjectReachMeters(
    height, input.nearRadiusMeters, SHRUB_CARD_REACH_METERS_PER_METER);
  const fullReach = groundObjectReachMeters(bodyHeight, cap);
  const reach = input.understory ? Math.min(fullReach, cardReach) : fullReach;
  if (!(reach > 0) || !(perHectare > 0)) {
    return Object.freeze({
      bushes: 0,
      cardRecords: 0,
      bodyRecords: 0,
      standInRecords: 0,
      shadowRecords: 0,
      records: 0,
      radiusMeters: 0,
    });
  }
  const inside = (radiusMeters: number): number =>
    (Math.PI * Math.max(0, radiusMeters) ** 2 / 10_000) * perHectare;
  const swap = groundObjectReachMeters(bodyHeight, cap, SHRUB_BODY_SWAP_METERS_PER_METER);
  const clumpReach = Math.min(reach, swap);
  const standInStart = swap * (1 - GROUND_OBJECT_REACH_GROW_SHARE);
  const radiusMeters = Math.max(cardReach, reach) + slack;
  const cardRecords = inside(cardReach + slack);
  const bodyRecords = inside(clumpReach + slack);
  const standInRecords = reach > standInStart
    ? inside(reach + slack) - inside(standInStart - slack)
    : 0;
  const shadowRecords = inside(Math.min(reach + slack, input.groundShadowReachMeters));
  return Object.freeze({
    bushes: inside(radiusMeters),
    cardRecords,
    bodyRecords,
    standInRecords,
    shadowRecords,
    records: cardRecords + bodyRecords + standInRecords + shadowRecords,
    radiusMeters,
  });
}
