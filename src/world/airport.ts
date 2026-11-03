import { smoothstep } from "./noise";
import type {
  AirportDefinition,
  RunwayCoordinates,
  RunwayPoint,
  WorldDefinition,
} from "./types";

export const DEFAULT_AIRPORT = Object.freeze({
  centerX: 0,
  centerZ: 0,
  elevation: 24,
  headingRadians: Math.PI * 0.14,
  runwayLength: 1_320,
  runwayWidth: 34,
  endSafetyArea: 80,
  shoulderWidth: 14,
  terrainBlendDistance: 240,
} satisfies AirportDefinition);

export function worldToRunway(
  airport: Readonly<AirportDefinition>,
  x: number,
  z: number,
): RunwayCoordinates {
  const dx = x - airport.centerX;
  const dz = z - airport.centerZ;
  const sinHeading = Math.sin(airport.headingRadians);
  const cosHeading = Math.cos(airport.headingRadians);
  return {
    along: dx * sinHeading + dz * cosHeading,
    across: dx * cosHeading - dz * sinHeading,
  };
}

export function runwayToWorld(
  airport: Readonly<AirportDefinition>,
  along: number,
  across: number,
): RunwayPoint {
  const sinHeading = Math.sin(airport.headingRadians);
  const cosHeading = Math.cos(airport.headingRadians);
  return {
    x: airport.centerX + along * sinHeading + across * cosHeading,
    y: airport.elevation,
    z: airport.centerZ + along * cosHeading - across * sinHeading,
  };
}

export function getRunwayEndpoints(
  airport: Readonly<AirportDefinition>,
): readonly [RunwayPoint, RunwayPoint] {
  const halfLength = airport.runwayLength * 0.5;
  return [runwayToWorld(airport, -halfLength, 0), runwayToWorld(airport, halfLength, 0)];
}

/**
 * Signed distance to an axis-aligned rectangle in runway-local coordinates.
 *
 * Exported at `3-9` (C7). `getAirportInfluence`, `3-8`'s earthworks and
 * `3-9`'s WGSL runway painter all key on this one shape; the WGSL is a
 * transliteration held to it by assertion 65, rather than a second
 * implementation of the kind that gave the ocean and the hydrology two
 * different sun discs.
 */
export function roundedRectangleSignedDistance(
  along: number,
  across: number,
  halfLength: number,
  halfWidth: number,
): number {
  const qAlong = Math.abs(along) - halfLength;
  const qAcross = Math.abs(across) - halfWidth;
  const outside = Math.hypot(Math.max(qAlong, 0), Math.max(qAcross, 0));
  return outside + Math.min(Math.max(qAlong, qAcross), 0);
}

/** Influence of the airport's flat terrain platform at a world coordinate. */
export function getAirportInfluence(
  airport: Readonly<AirportDefinition>,
  x: number,
  z: number,
): number {
  const local = worldToRunway(airport, x, z);
  const distance = roundedRectangleSignedDistance(
    local.along,
    local.across,
    airport.runwayLength * 0.5 + airport.endSafetyArea,
    airport.runwayWidth * 0.5 + airport.shoulderWidth,
  );
  if (distance <= 0) return 1;
  // A non-positive blend distance means "no blend", not "blend everywhere".
  // Left unguarded, `smoothstep(0, negative, d)` clamps to 0 and the influence
  // comes back as 1 at EVERY distance — which since `3-8` is not merely a
  // wrong influence but a disagreement between the two height authorities:
  // collision would short-circuit to the platform kilometres out while the
  // render path returned natural terrain (15.3 m apart, measured). `createWorld`
  // rejects a non-positive blend distance, so this is unreachable through the
  // public world API; the guard makes the function total for the hand-built
  // `AirportDefinition`s that tests and `3-9`'s binding pass it.
  if (!(airport.terrainBlendDistance > 0)) return 0;
  return 1 - smoothstep(0, airport.terrainBlendDistance, distance);
}

/**
 * Distance from the world segment a-b to an airport's graded platform (the
 * rectangle the rounded one grows from: runway and end safety areas by runway
 * and shoulders), 0 where they touch. The earthworks and the influence reach
 * exactly `terrainBlendDistance` past it (`roundedRectangleSignedDistance` is
 * this distance outside the platform), and the blend is only ever modulated
 * inward, so nothing past that is graded.
 */
export function airportPlatformDistanceToSegment(
  airport: Readonly<AirportDefinition>,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const a = worldToRunway(airport, ax, az);
  const b = worldToRunway(airport, bx, bz);
  const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea;
  const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth;
  const outside = (along: number, across: number) =>
    Math.hypot(Math.max(Math.abs(along) - halfLength, 0), Math.max(Math.abs(across) - halfWidth, 0));
  // A segment and a convex box are apart by an endpoint's distance to the
  // box or a corner's to the segment, unless they cross (0).
  let best = Math.min(outside(a.along, a.across), outside(b.along, b.across));
  if (best === 0) return 0;
  const dAlong = b.along - a.along;
  const dAcross = b.across - a.across;
  const lengthSquared = dAlong * dAlong + dAcross * dAcross;
  // Clip the segment's parameter to the box's slab in each axis (Liang-Barsky).
  let enter = 0;
  let exit = 1;
  const slab = (start: number, delta: number, half: number): boolean => {
    if (delta === 0) return Math.abs(start) <= half;
    let t0 = (-half - start) / delta;
    let t1 = (half - start) / delta;
    if (t0 > t1) [t0, t1] = [t1, t0];
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
    return enter <= exit;
  };
  if (slab(a.along, dAlong, halfLength) && slab(a.across, dAcross, halfWidth)) return 0;
  for (const along of [-halfLength, halfLength]) {
    for (const across of [-halfWidth, halfWidth]) {
      const t = lengthSquared > 0
        ? Math.min(1, Math.max(0, ((along - a.along) * dAlong + (across - a.across) * dAcross) / lengthSquared))
        : 0;
      best = Math.min(best, Math.hypot(along - (a.along + dAlong * t), across - (a.across + dAcross * t)));
    }
  }
  return best;
}

/**
 * Whether a capsule (the segment a-b grown by `radius`, as an infrastructure
 * segment's halfWidth + reach) reaches into an airport's earthworks: the
 * platform grown by `terrainBlendDistance`, the support of
 * `getAirportInfluence`.
 */
export function segmentReachesAirportEarthworks(
  airport: Readonly<AirportDefinition>,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  radius = 0,
): boolean {
  return airportPlatformDistanceToSegment(airport, ax, az, bx, bz) < Math.max(0, airport.terrainBlendDistance) + radius;
}

export function isPointOnRunway(
  airport: Readonly<AirportDefinition>,
  x: number,
  z: number,
  margin = 0,
): boolean {
  const local = worldToRunway(airport, x, z);
  return (
    Math.abs(local.along) <= airport.runwayLength * 0.5 + margin &&
    Math.abs(local.across) <= airport.runwayWidth * 0.5 + margin
  );
}

/**
 * `3-8` deleted `flattenHeightForAirport`, which lerped the natural height
 * toward a flat disc at `airport.elevation` and produced the circular plateau
 * the audit names. The replacement is `runwayEarthworksHeightLocal` in
 * `src/render/webgpu/terrain/RunwayEarthworks.ts` (terrain-material owns it),
 * called from `src/world/terrain.ts` for the render path and from the
 * collision fast path for physics — one profile, two authorities, pinned to
 * within 1 mm by assertion 63.
 */

export function getWorldAirport(world: WorldDefinition): Readonly<AirportDefinition> | null {
  return world.airport;
}

/**
 * The one airport that can shape the ground at a world coordinate: the
 * airport whose centre is nearest.
 *
 * Every terrain and collision consumer that used to read `world.airport`
 * reads this instead. Airports are kept `AIRPORT_SPAWN_POLICY.
 * minSeparationMeters` apart, several times the reach of any one airport's
 * earthworks (half a runway, the safety area and the blend distance), so the
 * nearest centre is the only airport whose influence can be non-zero at the
 * point and the earthworks never need blending between two sites. A world
 * with only its home field returns that field everywhere, exactly as before
 * airports could spawn, so the single-airport terrain stays bit-identical.
 */
export function worldAirportAt(
  world: WorldDefinition,
  x: number,
  z: number,
): Readonly<AirportDefinition> | null {
  const airports = world.airports;
  // `airports` is absent only on a world built by hand before it existed.
  if (!airports || airports.length <= 1) return world.airport;
  let nearest: Readonly<AirportDefinition> | null = null;
  let nearestDistanceSquared = Infinity;
  for (const airport of airports) {
    const dx = x - airport.centerX;
    const dz = z - airport.centerZ;
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared < nearestDistanceSquared) {
      nearest = airport;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest;
}
