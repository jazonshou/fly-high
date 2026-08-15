import { clamp, smoothstep } from "./noise";
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

function roundedRectangleSignedDistance(
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

/** Apply the starter airport platform to an otherwise natural terrain height. */
export function flattenHeightForAirport(
  naturalHeight: number,
  airport: Readonly<AirportDefinition> | null,
  x: number,
  z: number,
): number {
  if (!airport) return naturalHeight;
  const influence = getAirportInfluence(airport, x, z);
  // Clamp guards against tiny floating point overshoots in custom airport values.
  const amount = clamp(influence, 0, 1);
  return naturalHeight + (airport.elevation - naturalHeight) * amount;
}

export function getWorldAirport(world: WorldDefinition): Readonly<AirportDefinition> | null {
  return world.airport;
}
