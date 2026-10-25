import { worldToRunway } from "../../../world/airport";
import type { AirportDefinition } from "../../../world/types";
import {
  airfieldStructureExclusions,
  STRUCTURE_BLEND_METERS,
  STRUCTURE_HARD_CLEARANCE_METERS,
  type WorldBounds,
} from "./StructureExclusion";

/**
 * How far an airport reaches into what the world looks like, so that an airport
 * spawning (or being retired) mid-flight invalidates exactly the cached products
 * it changed and nothing else.
 *
 * **TWO REACHES, BECAUSE TWO THINGS CHANGE.**
 *
 *  - **The ground.** `sampleTerrain` reads the nearest airport's earthworks and
 *    influence, and both are zero once a point is `terrainBlendDistance` past
 *    the graded platform (`getAirportInfluence` smoothsteps to 0 there, and
 *    `runwayEarthworksHeightLocal`'s blend never exceeds it). Outside that
 *    rectangle a world with the airport and a world without it sample
 *    identically.
 *  - **The vegetation.** Everything the ground changes, plus the structures'
 *    hard exclusions (`airfieldStructureExclusions`), which reach further: the
 *    approach rows run ~480 m past each threshold and the hangars stand ~135 m
 *    off the centreline.
 *
 * **Stated in the RUNWAY frame**, as every airfield placement is: a rotated
 * rectangle, tested against a world rectangle with a separating-axis test, so a
 * 512 m detail cell beside a diagonal runway is not invalidated for lying inside
 * the runway's world-axis bounding box.
 */
export interface AirportReach {
  readonly airport: Readonly<AirportDefinition>;
  /** Runway-local extent, metres (along = runway axis, across = perpendicular). */
  readonly minAlong: number;
  readonly maxAlong: number;
  readonly minAcross: number;
  readonly maxAcross: number;
}

/**
 * Where the ground differs because this airport exists: the graded platform
 * plus its whole blend, plus `marginMeters` for samplers whose normals read a
 * stencil around the point.
 */
export function airportTerrainReach(
  airport: Readonly<AirportDefinition>,
  marginMeters = 0,
): AirportReach {
  const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea
    + Math.max(0, airport.terrainBlendDistance) + marginMeters;
  const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth
    + Math.max(0, airport.terrainBlendDistance) + marginMeters;
  return {
    airport,
    minAlong: -halfLength,
    maxAlong: halfLength,
    minAcross: -halfWidth,
    maxAcross: halfWidth,
  };
}

/**
 * Where vegetation differs because this airport exists: the terrain reach
 * united with every structure exclusion grown by its hard clearance and blend.
 * `seedHash` is the hangars' siting seed (`world.seedHash`).
 */
export function airportVegetationReach(
  airport: Readonly<AirportDefinition>,
  seedHash: number,
  marginMeters = 0,
): AirportReach {
  const terrain = airportTerrainReach(airport, marginMeters);
  let { minAlong, maxAlong, minAcross, maxAcross } = terrain;
  const reach = STRUCTURE_HARD_CLEARANCE_METERS + STRUCTURE_BLEND_METERS + marginMeters;
  for (const box of airfieldStructureExclusions(airport, seedHash)) {
    const cos = Math.abs(Math.cos(box.yawRadians));
    const sin = Math.abs(Math.sin(box.yawRadians));
    // Half-extents of the yawed box's runway-local bounding rectangle.
    const halfAlong = box.halfAlongMeters * cos + box.halfAcrossMeters * sin + reach;
    const halfAcross = box.halfAlongMeters * sin + box.halfAcrossMeters * cos + reach;
    minAlong = Math.min(minAlong, box.alongMeters - halfAlong);
    maxAlong = Math.max(maxAlong, box.alongMeters + halfAlong);
    minAcross = Math.min(minAcross, box.acrossMeters - halfAcross);
    maxAcross = Math.max(maxAcross, box.acrossMeters + halfAcross);
  }
  return { airport, minAlong, maxAlong, minAcross, maxAcross };
}

/** The reach's four corners in world x/z. */
function reachCorners(reach: AirportReach): readonly (readonly [number, number])[] {
  const { airport } = reach;
  const sinHeading = Math.sin(airport.headingRadians);
  const cosHeading = Math.cos(airport.headingRadians);
  const corner = (along: number, across: number): readonly [number, number] => [
    airport.centerX + along * sinHeading + across * cosHeading,
    airport.centerZ + along * cosHeading - across * sinHeading,
  ];
  return [
    corner(reach.minAlong, reach.minAcross),
    corner(reach.minAlong, reach.maxAcross),
    corner(reach.maxAlong, reach.minAcross),
    corner(reach.maxAlong, reach.maxAcross),
  ];
}

/** The world-axis rectangle around a reach (looser than the reach itself). */
export function airportReachWorldBounds(reach: AirportReach): WorldBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const [x, z] of reachCorners(reach)) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

/** Whether a world point lies inside the reach (boundary included). */
export function airportReachContains(reach: AirportReach, x: number, z: number): boolean {
  const local = worldToRunway(reach.airport, x, z);
  return local.along >= reach.minAlong && local.along <= reach.maxAlong
    && local.across >= reach.minAcross && local.across <= reach.maxAcross;
}

/**
 * Whether the reach and a world rectangle share any point — the separating-axis
 * test for two rectangles, so exact rather than a bounding-box approximation.
 * Two convex quadrilaterals are disjoint exactly when one of their four edge
 * normals separates them: the world axes, then the runway's.
 */
export function airportReachIntersectsBounds(reach: AirportReach, bounds: WorldBounds): boolean {
  const world = airportReachWorldBounds(reach);
  if (
    world.maxX < bounds.minX || world.minX > bounds.maxX
    || world.maxZ < bounds.minZ || world.minZ > bounds.maxZ
  ) return false;
  let minAlong = Number.POSITIVE_INFINITY;
  let maxAlong = Number.NEGATIVE_INFINITY;
  let minAcross = Number.POSITIVE_INFINITY;
  let maxAcross = Number.NEGATIVE_INFINITY;
  for (const [x, z] of [
    [bounds.minX, bounds.minZ],
    [bounds.minX, bounds.maxZ],
    [bounds.maxX, bounds.minZ],
    [bounds.maxX, bounds.maxZ],
  ] as const) {
    const local = worldToRunway(reach.airport, x, z);
    minAlong = Math.min(minAlong, local.along);
    maxAlong = Math.max(maxAlong, local.along);
    minAcross = Math.min(minAcross, local.across);
    maxAcross = Math.max(maxAcross, local.across);
  }
  return !(
    maxAlong < reach.minAlong || minAlong > reach.maxAlong
    || maxAcross < reach.minAcross || minAcross > reach.maxAcross
  );
}

/** Field-for-field equality, as `withAirports` compares airports. */
export function sameAirport(
  left: Readonly<AirportDefinition>,
  right: Readonly<AirportDefinition>,
): boolean {
  return left.centerX === right.centerX
    && left.centerZ === right.centerZ
    && left.headingRadians === right.headingRadians
    && left.elevation === right.elevation
    && left.runwayLength === right.runwayLength
    && left.runwayWidth === right.runwayWidth
    && left.endSafetyArea === right.endSafetyArea
    && left.shoulderWidth === right.shoulderWidth
    && left.terrainBlendDistance === right.terrainBlendDistance;
}

/**
 * The airports in one list and not the other — spawned since `previous`, or
 * retired from it. Order: `next`'s new airports, then `previous`'s removed ones.
 * Compared by value, because `withAirports` copies spawned airports.
 */
export function changedAirports(
  previous: readonly Readonly<AirportDefinition>[],
  next: readonly Readonly<AirportDefinition>[],
): readonly Readonly<AirportDefinition>[] {
  const added = next.filter((airport) => !previous.some((other) => sameAirport(airport, other)));
  const removed = previous.filter((airport) => !next.some((other) => sameAirport(airport, other)));
  return [...added, ...removed];
}
