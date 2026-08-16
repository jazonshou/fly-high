import {
  aircraftDefinition,
  DEFAULT_CONTROLS,
  type AircraftDefinition,
  type AircraftKind,
  type SpawnOptions,
} from "@/src/sim";
import {
  runwayToWorld,
  sampleTerrainCollisionHeight,
  type WorldDefinition,
} from "@/src/world";
import {
  normalizeAirborneStartAgl,
  type SpawnKind,
} from "@/src/workers/protocol";

const AIRBORNE_START_PITCH = (2.4 * Math.PI) / 180;

export function airborneAirspeedForAircraft(aircraft: AircraftKind): number {
  return aircraft === "jet" ? 155 : 56;
}

export function airborneThrottleForAircraft(aircraft: AircraftKind): number {
  // Dry thrust is much less speed-limited than trainer propeller thrust. This
  // setting balances jet drag near the 155 m/s airborne spawn instead of
  // turning a neutral Scenic-to-Direct handoff into a zoom climb.
  return aircraft === "jet" ? 0.17 : 0.68;
}

export function runwayTrimForAircraft(aircraft: AircraftKind): number {
  return aircraft === "jet" ? 0.015 : 0.04;
}

/**
 * Settings describe wheel clearance because that is the AGL pilots see in the
 * HUD. The simulator position is the aircraft CG, so include the lowest
 * rotated gear offset when placing an airborne aircraft.
 */
function airborneCgHeight(
  airborneStartAgl: number,
  aircraft: AircraftDefinition,
): number {
  let lowestGearOffset = 0;
  for (const gear of aircraft.gear) {
    const rotatedY =
      Math.sin(AIRBORNE_START_PITCH) * gear.position.x +
      Math.cos(AIRBORNE_START_PITCH) * gear.position.y;
    lowestGearOffset = Math.min(lowestGearOffset, rotatedY);
  }
  return airborneStartAgl - lowestGearOffset;
}

/**
 * Builds deterministic simulator spawn data from a world and the user's chosen
 * airborne height. Keeping this outside the Worker makes the spawn contract
 * directly testable and prevents another hidden fixed-elevation path.
 */
export function createSimulationSpawn(
  world: WorldDefinition,
  kind: SpawnKind,
  requestedAirborneStartAgl: number,
  aircraftKind: AircraftKind = "trainer",
): SpawnOptions {
  const airborneStartAgl = normalizeAirborneStartAgl(requestedAirborneStartAgl);
  const aircraft = aircraftDefinition(aircraftKind);
  const airborneAirspeed = airborneAirspeedForAircraft(aircraftKind);
  const airborneThrottle = airborneThrottleForAircraft(aircraftKind);
  const runwayTrim = runwayTrimForAircraft(aircraftKind);
  const airport = world.airport;

  if (!airport) {
    if (kind === "runway") {
      throw new Error("Runway start unavailable: this world has no safe airport site");
    }
    const x = 0;
    const z = -500;
    const terrainHeight = sampleTerrainCollisionHeight(world, x, z);
    return {
      position: {
        x,
        y: terrainHeight + airborneCgHeight(airborneStartAgl, aircraft),
        z,
      },
      heading: 0,
      pitch: AIRBORNE_START_PITCH,
      airspeed: airborneAirspeed,
      controls: { ...DEFAULT_CONTROLS, throttle: airborneThrottle, trim: 0 },
    };
  }

  if (kind === "runway") {
    const point = runwayToWorld(airport, -airport.runwayLength * 0.36, 0);
    return {
      onGround: true,
      terrainHeight: airport.elevation,
      position: { x: point.x, z: point.z },
      heading: airport.headingRadians,
      airspeed: 0,
      controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: runwayTrim },
    };
  }

  const point = runwayToWorld(airport, -airport.runwayLength * 0.22, 0);
  return {
    position: {
      x: point.x,
      y: airport.elevation + airborneCgHeight(airborneStartAgl, aircraft),
      z: point.z,
    },
    heading: airport.headingRadians,
    pitch: AIRBORNE_START_PITCH,
    airspeed: airborneAirspeed,
    controls: { ...DEFAULT_CONTROLS, throttle: airborneThrottle, trim: 0 },
  };
}
