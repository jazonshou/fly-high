import type { AirportDefinition, WorldDefinition } from "@/src/world";

/**
 * One anchored spawn search (`findSpawnedAirport`), run off the main thread:
 * a passing site's certified assessment samples the terrain kernel tens of
 * thousands of times (60-300 ms), which would be a visible hitch on the
 * render thread and a stalled step on the simulation's.
 */
export interface AirportSpawnRequest {
  readonly requestId: number;
  readonly world: WorldDefinition;
  readonly x: number;
  readonly z: number;
  readonly headingRadians: number;
}

export interface AirportSpawnResult {
  readonly requestId: number;
  /** Null when no surveyed site passed; the caller re-anchors further on. */
  readonly airport: Readonly<AirportDefinition> | null;
}
