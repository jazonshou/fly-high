import {
  RUNWAY_AIRFIELD_OUTER_METERS,
} from "@/src/render/webgpu/terrain/RunwaySurface";
import { terrainPageAirportDomain, type TerrainWorldRect } from "@/src/render/webgpu/terrain/AirportReach";
import type { WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import {
  createWorld,
  findSpawnedAirport,
  roundedRectangleSignedDistance,
  withAirports,
  worldToRunway,
  type AirportDefinition,
  type WorldDefinition,
} from "@/src/world";

/**
 * Shared by the airport-terrain tests: a real two-airport world (the airport
 * network's own spawn, run to completion) and an independent oracle for
 * "does this airport reach this rectangle".
 */

/** Runs one anchored spawn search to completion, as the game loop does over frames. */
export function spawnFrom(
  world: WorldDefinition,
  x: number,
  z: number,
  heading: number,
): Readonly<AirportDefinition> | null {
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(world, x, z, heading, attempt);
    if (result === "exhausted") return null;
    if (result) return result;
  }
}

export interface TwoAirportWorld {
  readonly world: WorldDefinition;
  readonly next: WorldDefinition;
  readonly home: Readonly<AirportDefinition>;
  readonly spawned: Readonly<AirportDefinition>;
  /** Where the spawn search ran from: where the aircraft is when it spawns. */
  readonly origin: { readonly x: number; readonly z: number };
}

let cachedTwoAirportWorld: TwoAirportWorld | null = null;

/** The airport-network test's spawn: 15 km east of home, flying east. */
export function twoAirportWorld(): TwoAirportWorld {
  if (cachedTwoAirportWorld) return cachedTwoAirportWorld;
  const world = createWorld("alpha", { worldEvolution: "analytic" });
  const home = world.airport!;
  const origin = { x: home.centerX + 15_000, z: home.centerZ };
  const found = spawnFrom(world, origin.x, origin.z, Math.PI / 2);
  if (!found) throw new Error("the alpha spawn search found no airport");
  const next = withAirports(world, [...world.airports, found]);
  // withAirports re-freezes spawned airports: use the world's own object.
  const spawned = next.airports[1]!;
  cachedTwoAirportWorld = { world, next, home, spawned, origin };
  return cachedTwoAirportWorld;
}

// ---------------------------------------------------------------------------
// Reach oracle: the least signed distance over a rectangle, by nested ternary
// search. The rectangle's signed distance is convex, and so is its partial
// minimum over z, so the search is exact to rounding — and it shares nothing
// with AirportReach.ts's separating-axis code but `roundedRectangleSignedDistance`
// and `worldToRunway`, which are the CPU authority's own.
// ---------------------------------------------------------------------------

function ternaryMin(evaluate: (value: number) => number, lo: number, hi: number, iterations = 64): number {
  let low = lo;
  let high = hi;
  for (let step = 0; step < iterations; step += 1) {
    const third = (high - low) / 3;
    if (evaluate(low + third) <= evaluate(high - third)) high -= third;
    else low += third;
  }
  return evaluate((low + high) * 0.5);
}

function minSignedDistanceOver(
  rect: TerrainWorldRect,
  airport: Readonly<AirportDefinition>,
  halfLength: number,
  halfWidth: number,
): number {
  const at = (x: number, z: number): number => {
    const local = worldToRunway(airport, x, z);
    return roundedRectangleSignedDistance(local.along, local.across, halfLength, halfWidth);
  };
  return ternaryMin(
    (x) => ternaryMin((z) => at(x, z), rect.minZ, rect.maxZ),
    rect.minX,
    rect.maxX,
  );
}

export type ReachKind = "grading" | "airfield";

/** The oracle's answer, or null when it is within rounding of the radius. */
export function oracleReaches(
  rect: TerrainWorldRect,
  airport: Readonly<AirportDefinition>,
  kind: ReachKind,
): boolean | null {
  const halfLength = kind === "grading"
    ? airport.runwayLength * 0.5 + airport.endSafetyArea
    : airport.runwayLength * 0.5;
  const halfWidth = kind === "grading"
    ? airport.runwayWidth * 0.5 + airport.shoulderWidth
    : airport.runwayWidth * 0.5;
  const radius = kind === "grading" ? airport.terrainBlendDistance : RUNWAY_AIRFIELD_OUTER_METERS;
  const least = minSignedDistanceOver(rect, airport, halfLength, halfWidth);
  if (Math.abs(least - radius) < 1e-3) return null;
  return least <= radius;
}

export function oraclePageReached(address: WorldPageAddress, airport: Readonly<AirportDefinition>): boolean | null {
  const domain = terrainPageAirportDomain(address);
  const answers = (["grading", "airfield"] as const).map((kind) => oracleReaches(domain, airport, kind));
  if (answers.includes(true)) return true;
  if (answers.includes(null)) return null;
  return false;
}

export const pageKeyOf = (address: WorldPageAddress): string => `${address.level}:${address.x}:${address.z}`;

