import type { AirportDefinition } from "@/src/world/types";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
} from "@/src/render/webgpu/world/pageGeometry";
import { worldPageExtentMeters, type WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import {
  TERRAIN_AIRPORT_SLOTS,
  runwayPlatformHalfLength,
  runwayPlatformHalfWidth,
} from "./RunwayEarthworks";
import { RUNWAY_AIRFIELD_OUTER_METERS } from "./RunwaySurface";
import { terrainChannelTexelSizeMeters } from "./TerrainSpineContract";

/**
 * Where an airport reaches the GPU terrain's BAKED products, and which pages
 * that is (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: one geometric answer to "does this airport touch
 * this page", shared by the two places that ask it — the clipmap, deciding
 * which resident pages an airport spawning or retiring invalidates, and the
 * splat bake, deciding which airport a page's land cover is graded for. If
 * they disagreed, a page could be baked for an airport the clipmap never
 * re-baked it for.
 *
 * An airport's reach is two rounded rectangles about its runway frame — an
 * oriented rectangle grown by a radius, which is exactly the region where
 * `roundedRectangleSignedDistance` (`src/world/airport.ts`) is at most that
 * radius:
 *
 *  - GRADING: the graded platform (runway + end safety areas, runway +
 *    shoulders) grown by `terrainBlendDistance`. The earthworks' hard outer
 *    bound (their blend is only ever modulated INWARD) and exactly the support
 *    of `getAirportInfluence`, which the splat bake's mown-grass and
 *    canopy-clearance terms read. Page heights, normals (derived from heights
 *    in the vertex shader), occlusion, horizon and splat all live inside it.
 *  - AIRFIELD: the paved runway grown by `RUNWAY_AIRFIELD_OUTER_METERS`, the
 *    support of `terrainRunwayAirfieldInfluence`. That field is evaluated per
 *    fragment from uniforms and baked nowhere today, so it never needs a page;
 *    it is part of the reach so that a bake that starts reading it later is
 *    invalidated by construction, and it costs a strip a few metres wide.
 *
 * A page's SAMPLED domain is wider than its bounds: the stored gutter, the
 * generator's apron and the bakes' supersample taps all read past the edge.
 * `terrainPageAirportDomain` grows the bounds by the gutter plus one channel
 * texel (a channel texel is two height texels, so it covers the height
 * page's apron too) and one metre for f32 page-local rounding.
 */

/** An oriented rectangle grown by `radius`: `roundedRectangleSignedDistance <= radius`. */
export interface TerrainAirportReach {
  readonly centerX: number;
  readonly centerZ: number;
  readonly sinHeading: number;
  readonly cosHeading: number;
  readonly halfLength: number;
  readonly halfWidth: number;
  readonly radius: number;
}

/** An axis-aligned world rectangle, metres. */
export interface TerrainWorldRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** Platform + blend: earthworks, airport influence, and every bake that reads them. */
export function terrainAirportGradingReach(
  airport: Readonly<AirportDefinition>,
): TerrainAirportReach {
  return {
    centerX: airport.centerX,
    centerZ: airport.centerZ,
    sinHeading: Math.sin(airport.headingRadians),
    cosHeading: Math.cos(airport.headingRadians),
    halfLength: runwayPlatformHalfLength(airport),
    halfWidth: runwayPlatformHalfWidth(airport),
    radius: Math.max(0, airport.terrainBlendDistance),
  };
}

/** Pavement + the graded airfield surround (`terrainRunwayAirfieldInfluence`). */
export function terrainAirportAirfieldReach(
  airport: Readonly<AirportDefinition>,
): TerrainAirportReach {
  return {
    centerX: airport.centerX,
    centerZ: airport.centerZ,
    sinHeading: Math.sin(airport.headingRadians),
    cosHeading: Math.cos(airport.headingRadians),
    halfLength: airport.runwayLength * 0.5,
    halfWidth: airport.runwayWidth * 0.5,
    radius: RUNWAY_AIRFIELD_OUTER_METERS,
  };
}

/** Both of an airport's reaches; a page inside either one is invalidated. */
export function terrainAirportReaches(
  airport: Readonly<AirportDefinition>,
): readonly TerrainAirportReach[] {
  return [terrainAirportGradingReach(airport), terrainAirportAirfieldReach(airport)];
}

/** A `TerrainWorldRect` a caller reuses, so a per-page query allocates nothing. */
export interface TerrainMutableWorldRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * The world rectangle a page's texels, gutter and taps sample — written into
 * `target` when one is given. `worldPageBounds`' arithmetic, without its
 * result object.
 */
export function terrainPageAirportDomain(
  address: WorldPageAddress,
  target: TerrainMutableWorldRect = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 },
): TerrainWorldRect {
  const extent = worldPageExtentMeters(address.level, WORLD_PAGE_BASE_EXTENT_METERS);
  const margin = (WORLD_PAGE_GUTTER + 1) * terrainChannelTexelSizeMeters(address.level) + 1;
  const minX = address.x * extent;
  const minZ = address.z * extent;
  target.minX = minX - margin;
  target.minZ = minZ - margin;
  target.maxX = minX + extent + margin;
  target.maxZ = minZ + extent + margin;
  return target;
}

/** Distance from a point to an axis-aligned rectangle (0 inside). */
function pointToRectDistance(x: number, z: number, rect: TerrainWorldRect): number {
  const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
  const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
  return Math.hypot(dx, dz);
}

/** Distance from a point to the reach's (un-grown) oriented rectangle (0 inside). */
function pointToOrientedRectDistance(x: number, z: number, reach: TerrainAirportReach): number {
  const dx = x - reach.centerX;
  const dz = z - reach.centerZ;
  // worldToRunway's frame.
  const along = dx * reach.sinHeading + dz * reach.cosHeading;
  const across = dx * reach.cosHeading - dz * reach.sinHeading;
  return Math.hypot(
    Math.max(Math.abs(along) - reach.halfLength, 0),
    Math.max(Math.abs(across) - reach.halfWidth, 0),
  );
}

/**
 * Whether a rectangle meets a reach, EXACTLY: the distance between the
 * rectangle and the reach's oriented rectangle is at most its radius.
 *
 * Both are convex polygons. When the separating-axis test finds no gap on
 * their four edge normals they overlap; otherwise the closest pair of two
 * disjoint convex polygons always includes a vertex of one of them, so the
 * distance is the least of the eight vertex-to-polygon distances. A bounding
 * box of the rotated runway would have been simpler and would have rebuilt
 * the pages off a diagonal runway's corners for nothing.
 */
export function terrainRectIntersectsAirportReach(
  rect: TerrainWorldRect,
  reach: TerrainAirportReach,
): boolean {
  const alongX = reach.sinHeading;
  const alongZ = reach.cosHeading;
  const acrossX = reach.cosHeading;
  const acrossZ = -reach.sinHeading;
  // Unrolled rather than looped over literal axis and corner arrays: the
  // clipmap asks this of every resident page when an airport spawns, and the
  // splat bake of every page it bakes, so it allocates nothing.
  const overlaps = !separatedOnAxis(rect, reach, 1, 0)
    && !separatedOnAxis(rect, reach, 0, 1)
    && !separatedOnAxis(rect, reach, alongX, alongZ)
    && !separatedOnAxis(rect, reach, acrossX, acrossZ);
  if (overlaps) return true;

  let distance = Number.POSITIVE_INFINITY;
  for (let corner = 0; corner < 4; corner += 1) {
    const along = (corner & 1 ? 1 : -1) * reach.halfLength;
    const across = (corner & 2 ? 1 : -1) * reach.halfWidth;
    // runwayToWorld's inverse of the frame above.
    const x = reach.centerX + along * alongX + across * acrossX;
    const z = reach.centerZ + along * alongZ + across * acrossZ;
    distance = Math.min(distance, pointToRectDistance(x, z, rect));
    distance = Math.min(distance, pointToOrientedRectDistance(
      corner & 1 ? rect.maxX : rect.minX,
      corner & 2 ? rect.maxZ : rect.minZ,
      reach,
    ));
  }
  return distance <= reach.radius;
}

/** The separating-axis test on one axis: true when the projections leave a gap. */
function separatedOnAxis(
  rect: TerrainWorldRect,
  reach: TerrainAirportReach,
  axisX: number,
  axisZ: number,
): boolean {
  const rectCentre = (rect.minX + rect.maxX) * 0.5 * axisX + (rect.minZ + rect.maxZ) * 0.5 * axisZ;
  const rectExtent = (rect.maxX - rect.minX) * 0.5 * Math.abs(axisX)
    + (rect.maxZ - rect.minZ) * 0.5 * Math.abs(axisZ);
  const reachCentre = reach.centerX * axisX + reach.centerZ * axisZ;
  const reachExtent = reach.halfLength * Math.abs(reach.sinHeading * axisX + reach.cosHeading * axisZ)
    + reach.halfWidth * Math.abs(reach.cosHeading * axisX - reach.sinHeading * axisZ);
  return Math.abs(rectCentre - reachCentre) > rectExtent + reachExtent;
}

/** One domain, reused by the per-page queries below: they run one at a time. */
const pageDomainScratch: TerrainMutableWorldRect = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

/** Whether any of `reaches` meets the page's sampled domain. Allocates nothing. */
export function terrainPageInAirportReach(
  address: WorldPageAddress,
  reaches: readonly TerrainAirportReach[],
): boolean {
  if (reaches.length === 0) return false;
  const domain = terrainPageAirportDomain(address, pageDomainScratch);
  for (let index = 0; index < reaches.length; index += 1) {
    if (terrainRectIntersectsAirportReach(domain, reaches[index]!)) return true;
  }
  return false;
}

/** `terrainPageGradingAirport`: no airport's grading reach meets the page. */
export const TERRAIN_PAGE_GRADED_BY_NONE = -1;
/** `terrainPageGradingAirport`: two or more airports' grading reaches meet it. */
export const TERRAIN_PAGE_GRADED_BY_SEVERAL = -2;

/**
 * Which airport GRADES a page — whose influence can be non-zero anywhere the
 * page samples: its index in `gradingReaches` (one `terrainAirportGradingReach`
 * per airport, in list order) when exactly one does,
 * `TERRAIN_PAGE_GRADED_BY_NONE` or `TERRAIN_PAGE_GRADED_BY_SEVERAL` otherwise.
 * The splat bake grades a page for that one airport and switches to a
 * per-texel choice only for several. Allocates nothing, so a bake can ask it
 * of every page in a batch.
 */
export function terrainPageGradingAirport(
  gradingReaches: readonly TerrainAirportReach[],
  address: WorldPageAddress,
): number {
  const domain = terrainPageAirportDomain(address, pageDomainScratch);
  let found = TERRAIN_PAGE_GRADED_BY_NONE;
  for (let index = 0; index < gradingReaches.length; index += 1) {
    if (!terrainRectIntersectsAirportReach(domain, gradingReaches[index]!)) continue;
    if (found !== TERRAIN_PAGE_GRADED_BY_NONE) return TERRAIN_PAGE_GRADED_BY_SEVERAL;
    found = index;
  }
  return found;
}

/** Whether two airports agree on every field the GPU terrain reads. */
function sameTerrainAirport(
  a: Readonly<AirportDefinition>,
  b: Readonly<AirportDefinition>,
): boolean {
  return a === b || (
    a.centerX === b.centerX
    && a.centerZ === b.centerZ
    && a.headingRadians === b.headingRadians
    && a.elevation === b.elevation
    && a.runwayLength === b.runwayLength
    && a.runwayWidth === b.runwayWidth
    && a.endSafetyArea === b.endSafetyArea
    && a.shoulderWidth === b.shoulderWidth
    && a.terrainBlendDistance === b.terrainBlendDistance
  );
}

/**
 * Whether `incoming`, truncated to the slot count, is `current` slot for slot
 * by value — the per-frame "nothing changed" answer, so it allocates nothing.
 * Order counts: a reordered list moves airports between uniform slots.
 */
export function sameTerrainAirports(
  current: readonly Readonly<AirportDefinition>[],
  incoming: readonly Readonly<AirportDefinition>[],
): boolean {
  if (current === incoming) return true;
  if (current.length !== Math.min(incoming.length, TERRAIN_AIRPORT_SLOTS)) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (!sameTerrainAirport(current[index]!, incoming[index]!)) return false;
  }
  return true;
}

/** The fields the GPU terrain reads from an airport, as an identity. */
function terrainAirportKey(airport: Readonly<AirportDefinition>): string {
  return [
    airport.centerX,
    airport.centerZ,
    airport.headingRadians,
    airport.elevation,
    airport.runwayLength,
    airport.runwayWidth,
    airport.endSafetyArea,
    airport.shoulderWidth,
    airport.terrainBlendDistance,
  ].join(":");
}

/**
 * The airports that entered and left between two lists, by VALUE.
 *
 * Not by identity: `withAirports` re-freezes every spawned airport on each
 * call, so the same runway arrives as a new object every time the list
 * changes. An airport that changed any field the terrain reads is one
 * retired and one added, which invalidates its ground under both.
 */
export function diffTerrainAirports(
  previous: readonly Readonly<AirportDefinition>[],
  next: readonly Readonly<AirportDefinition>[],
): {
  readonly added: readonly Readonly<AirportDefinition>[];
  readonly removed: readonly Readonly<AirportDefinition>[];
} {
  const unmatched = new Map<string, number>();
  for (const airport of previous) {
    const key = terrainAirportKey(airport);
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  const added: Readonly<AirportDefinition>[] = [];
  for (const airport of next) {
    const key = terrainAirportKey(airport);
    const count = unmatched.get(key) ?? 0;
    if (count > 0) unmatched.set(key, count - 1);
    else added.push(airport);
  }
  const removed: Readonly<AirportDefinition>[] = [];
  const stillUnmatched = new Map(unmatched);
  for (const airport of previous) {
    const key = terrainAirportKey(airport);
    const count = stillUnmatched.get(key) ?? 0;
    if (count > 0) {
      stillUnmatched.set(key, count - 1);
      removed.push(airport);
    }
  }
  return { added, removed };
}
