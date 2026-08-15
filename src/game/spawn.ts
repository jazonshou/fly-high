import {
  DEFAULT_CONTROLS,
  LIGHT_TRAINER,
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

/**
 * Settings describe wheel clearance because that is the AGL pilots see in the
 * HUD. The simulator position is the aircraft CG, so include the lowest
 * rotated gear offset when placing an airborne aircraft.
 */
function airborneCgHeight(airborneStartAgl: number): number {
  let lowestGearOffset = 0;
  for (const gear of LIGHT_TRAINER.gear) {
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
): SpawnOptions {
  const airborneStartAgl = normalizeAirborneStartAgl(requestedAirborneStartAgl);
  const airport = world.airport;

  if (!airport) {
    if (kind === "runway") {
      const terrainHeight = sampleTerrainCollisionHeight(world, 0, 0);
      return {
        onGround: true,
        terrainHeight,
        position: { x: 0, z: 0 },
        heading: 0,
        airspeed: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.04 },
      };
    }
    const x = 0;
    const z = -500;
    const terrainHeight = sampleTerrainCollisionHeight(world, x, z);
    return {
      position: { x, y: terrainHeight + airborneCgHeight(airborneStartAgl), z },
      heading: 0,
      pitch: AIRBORNE_START_PITCH,
      airspeed: 56,
      controls: { ...DEFAULT_CONTROLS, throttle: 0.68, trim: 0.065 },
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
      controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.04 },
    };
  }

  const point = runwayToWorld(airport, -airport.runwayLength * 0.22, 0);
  return {
    position: {
      x: point.x,
      y: airport.elevation + airborneCgHeight(airborneStartAgl),
      z: point.z,
    },
    heading: airport.headingRadians,
    pitch: AIRBORNE_START_PITCH,
    airspeed: 56,
    controls: { ...DEFAULT_CONTROLS, throttle: 0.68, trim: 0.065 },
  };
}
