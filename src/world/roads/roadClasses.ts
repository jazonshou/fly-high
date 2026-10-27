/**
 * The three road classes of the minimal network (the land plan's "Roads and
 * barriers" table), and every number the generator, the earthworks and the
 * drawing read from them.
 *
 * A sparse rural network: no settlements to join, so roads join sites a
 * builder would pick (flat, dry ground on a seeded lattice) and the places a
 * driver would want to reach. One sealed road from the home airport's
 * landside to the nearest gravel node; gravel roads on a 6 km lattice; two-rut
 * tracks on a 1.75 km lattice, pulled towards coasts, ridges and passes.
 *
 * Ids are composition order too: a track is laid first, a gravel road over
 * it, the sealed road over both, so at a crossing the higher class keeps its
 * cross-section and the lower one is pinned to it.
 */

export const ROAD_CLASS = Object.freeze({
  track: 0,
  gravel: 1,
  airport: 2,
} as const);

export type RoadClassId = (typeof ROAD_CLASS)[keyof typeof ROAD_CLASS];

/** What a road is surfaced with: the splat paints it, a tyre reads it. */
export type RoadSurface = "asphalt" | "gravel" | "track";

export interface RoadClassSpec {
  readonly id: RoadClassId;
  readonly name: "track" | "gravel" | "airport";
  /** What the splat paints over the formation, and what a tyre reads. */
  readonly surface: RoadSurface;
  /** Half the running surface (sealed or gravelled width, or the two ruts' span), metres. */
  readonly carriageHalfWidth: number;
  /** Shoulder beyond the running surface, each side, metres. */
  readonly shoulderWidth: number;
  /** Design speed, km/h (sets superelevation and the vertical smoothing length). */
  readonly designSpeedKmh: number;
  /** Steepest grade the vertical profile may take, rise over run. */
  readonly maxGrade: number;
  /** Steepest a short pitch may be where the fill and cut limits leave no gentler line, rise over run. */
  readonly pitchGrade: number;
  /** Smallest horizontal curve radius, metres. */
  readonly minRadius: number;
  /** Radius a switchback may use where `minRadius` will not fit, metres. */
  readonly hairpinRadius: number;
  /** Cross-fall each side of the crown on a straight, rise over run (0: a flat track). */
  readonly crossfall: number;
  /** Largest superelevation on a curve, rise over run (0: none). */
  readonly superelevationMax: number;
  /** Ditch at the foot of a cutting: depth and width, metres. */
  readonly ditchDepth: number;
  readonly ditchWidth: number;
  /**
   * How far beyond the formation the batters may reach, metres: the deepest
   * cut or fill the profile allows, at its batter grade, with room to fade.
   */
  readonly reach: number;
  /** Deepest fill and cut a profile may take, metres: a hard limit (the batters' `reach` is sized on it). */
  readonly maxFill: number;
  readonly maxCut: number;
  /** Lattice cell edge, metres (0: no lattice of its own). */
  readonly nodeSpacing: number;
  /** Longest edge the graph keeps, metres. */
  readonly maxEdgeLength: number;
  /** Fine routing grid, metres; the coarse pass is `coarseFactor` times it. */
  readonly routingGrid: number;
  readonly coarseFactor: number;
  /** Generated within this distance of the observer, metres (0: always). */
  readonly windowMeters: number;
  /** Vertical profile: ground smoothing window, metres. */
  readonly profileSmoothingMeters: number;
  /** Plants stay this far beyond the formation's batters, metres. */
  readonly plantClearance: number;
  /** Composition priority of the road's pieces (lower first). */
  readonly priority: number;
}

/**
 * Below the marina's priorities (10 and up), so a quay apron or a car park
 * pad shapes its own ground over the road that reaches it; crossing patches
 * after every road, so an outranking road's ditch is filled under the road
 * crossing it; junction pads after those, so a node is level whichever roads
 * meet there.
 */
export const ROAD_PRIORITY = Object.freeze({
  track: 4,
  gravel: 5,
  airport: 6,
  crossing: 7,
  junction: 8,
});

export const ROAD_CLASSES: readonly RoadClassSpec[] = Object.freeze([
  Object.freeze({
    id: ROAD_CLASS.track,
    name: "track",
    surface: "track",
    carriageHalfWidth: 1.5,
    shoulderWidth: 0.25,
    designSpeedKmh: 40,
    maxGrade: 0.3,
    pitchGrade: 0.36,
    minRadius: 12,
    hairpinRadius: 8,
    crossfall: 0,
    superelevationMax: 0,
    ditchDepth: 0,
    ditchWidth: 0,
    reach: 12,
    maxFill: 3,
    maxCut: 3.5,
    nodeSpacing: 1_750,
    maxEdgeLength: 2_900,
    routingGrid: 12.5,
    coarseFactor: 4,
    windowMeters: 5_000,
    profileSmoothingMeters: 30,
    plantClearance: 1.5,
    priority: ROAD_PRIORITY.track,
  } satisfies RoadClassSpec),
  Object.freeze({
    id: ROAD_CLASS.gravel,
    name: "gravel",
    surface: "gravel",
    carriageHalfWidth: 3,
    shoulderWidth: 0.5,
    designSpeedKmh: 60,
    maxGrade: 0.12,
    pitchGrade: 0.16,
    minRadius: 60,
    hairpinRadius: 15,
    crossfall: 0.04,
    superelevationMax: 0,
    ditchDepth: 0.5,
    ditchWidth: 1.5,
    reach: 34,
    maxFill: 12,
    maxCut: 14,
    nodeSpacing: 6_000,
    maxEdgeLength: 9_600,
    routingGrid: 25,
    coarseFactor: 4,
    windowMeters: 12_000,
    profileSmoothingMeters: 90,
    plantClearance: 2,
    priority: ROAD_PRIORITY.gravel,
  } satisfies RoadClassSpec),
  Object.freeze({
    id: ROAD_CLASS.airport,
    name: "airport",
    surface: "asphalt",
    carriageHalfWidth: 3.5,
    shoulderWidth: 1.5,
    designSpeedKmh: 80,
    maxGrade: 0.08,
    pitchGrade: 0.1,
    minRadius: 200,
    hairpinRadius: 200,
    crossfall: 0.025,
    superelevationMax: 0.06,
    ditchDepth: 0.6,
    ditchWidth: 1.8,
    reach: 34,
    maxFill: 12,
    maxCut: 14,
    nodeSpacing: 0,
    maxEdgeLength: 12_000,
    routingGrid: 25,
    coarseFactor: 4,
    windowMeters: 0,
    profileSmoothingMeters: 160,
    plantClearance: 2,
    priority: ROAD_PRIORITY.airport,
  } satisfies RoadClassSpec),
]);

export function roadClass(id: RoadClassId): RoadClassSpec {
  return ROAD_CLASSES[id]!;
}

/** Half the formation: running surface plus shoulder, metres. */
export function roadFormationHalfWidth(spec: RoadClassSpec): number {
  return spec.carriageHalfWidth + spec.shoulderWidth;
}

/** Batter grades, run per metre of rise: 1:1.5 in cut, 1:2 in fill. */
export const ROAD_CUT_RUN = 1.5;
export const ROAD_FILL_RUN = 2;

/**
 * Superelevation on a curve of `radius` metres: e = V^2 / (127 R) less the
 * side friction the class's design speed allows, capped at the class's
 * maximum, and 0 below the cross-fall (the crown stays).
 */
export function roadSuperelevation(spec: RoadClassSpec, radius: number): number {
  if (spec.superelevationMax <= 0 || !(radius > 0) || !Number.isFinite(radius)) return 0;
  const v = spec.designSpeedKmh;
  const sideFriction = 0.14;
  const e = Math.min(spec.superelevationMax, (v * v) / (127 * radius) - sideFriction * 0.5);
  return e > spec.crossfall ? e : 0;
}
