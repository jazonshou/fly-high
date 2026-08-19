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
