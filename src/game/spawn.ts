import {
  aircraftDefinition,
  DEFAULT_CONTROLS,
  type AircraftDefinition,
  type AircraftKind,
  type SpawnOptions,
} from "@/src/sim";
import {
  runwayToWorld,
  type WorldDefinition,
} from "@/src/world";
import { sampleGroundHeight } from "@/src/sim/terrainGrid";
import {
  normalizeAirborneStartAgl,
  type SpawnKind,
} from "@/src/workers/protocol";

const AIRBORNE_START_PITCH = (2.4 * Math.PI) / 180;
const RECOVERY_TERRAIN_RADII = [180, 420, 720] as const;

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

export function airborneGearForAircraft(aircraft: AircraftKind): number {
  return aircraft === "jet" ? 0 : 1;
}

/**
 * Settings describe wheel clearance because that is the AGL pilots see in the
 * HUD. The simulator position is the aircraft CG, so include the lowest
 * rotated gear offset when placing an airborne aircraft.
 */
function airborneCgHeight(
  airborneStartAgl: number,
  aircraft: AircraftDefinition,
  gearExtension: number,
): number {
  let lowestPhysicalOffset = 0;
  for (const point of aircraft.airframeContactPoints) {
    const rotatedY =
      Math.sin(AIRBORNE_START_PITCH) * point.x +
      Math.cos(AIRBORNE_START_PITCH) * point.y;
    lowestPhysicalOffset = Math.min(lowestPhysicalOffset, rotatedY);
  }
  if (!aircraft.retractableGear || gearExtension > 0.015) {
    for (const gear of aircraft.gear) {
      const stowed = gear.retractedPosition ?? gear.position;
      const travel = aircraft.retractableGear ? gearExtension : 1;
      const eased = travel * travel * (3 - 2 * travel);
      const x = stowed.x + (gear.position.x - stowed.x) * eased;
      const y = stowed.y + (gear.position.y - stowed.y) * eased;
      const rotatedY =
        Math.sin(AIRBORNE_START_PITCH) * x +
        Math.cos(AIRBORNE_START_PITCH) * y;
      lowestPhysicalOffset = Math.min(lowestPhysicalOffset, rotatedY);
    }
  }
  return airborneStartAgl - lowestPhysicalOffset;
}

/**
 * Uses a compact deterministic safety envelope instead of trusting one terrain
 * texel. A crash in a valley or against a steep face then recovers above the
 * surrounding relief, while keeping the requested crash X/Z unchanged.
 */
function crashRecoverySurfaceHeight(
  world: WorldDefinition,
  worldX: number,
  worldZ: number,
): number {
  let maximum = Math.max(
    world.seaLevel,
    sampleGroundHeight(world, worldX, worldZ),
  );
  for (const radius of RECOVERY_TERRAIN_RADII) {
    for (let direction = 0; direction < 8; direction += 1) {
      const angle = (direction * Math.PI) / 4;
      maximum = Math.max(
        maximum,
        sampleGroundHeight(
          world,
          worldX + Math.cos(angle) * radius,
          worldZ + Math.sin(angle) * radius,
        ),
      );
    }
  }
  return maximum;
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
  const airborneGear = airborneGearForAircraft(aircraftKind);
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
    const terrainHeight = sampleGroundHeight(world, x, z);
    return {
      position: {
        x,
        y: terrainHeight + airborneCgHeight(airborneStartAgl, aircraft, airborneGear),
        z,
      },
      heading: 0,
      pitch: AIRBORNE_START_PITCH,
      airspeed: airborneAirspeed,
      controls: { ...DEFAULT_CONTROLS, throttle: airborneThrottle, trim: 0, gear: airborneGear },
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
      controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: runwayTrim, gear: 1 },
    };
  }

  const point = runwayToWorld(airport, -airport.runwayLength * 0.22, 0);
  return {
    position: {
      x: point.x,
      y: airport.elevation + airborneCgHeight(airborneStartAgl, aircraft, airborneGear),
      z: point.z,
    },
    heading: airport.headingRadians,
    pitch: AIRBORNE_START_PITCH,
    airspeed: airborneAirspeed,
    controls: { ...DEFAULT_CONTROLS, throttle: airborneThrottle, trim: 0, gear: airborneGear },
  };
}

/**
 * Builds an airborne recovery at an authoritative absolute world position.
 * Renderer floating-origin rebases never enter this contract: the Worker and
 * terrain sampler both use the same unshifted world X/Z coordinates.
 *
 * Water is visualised at `seaLevel` while submerged terrain can be far below
 * it. A bounded surrounding-relief scan also prevents a valley-side recovery
 * from spawning directly into an adjacent slope. The configured AGL therefore
 * remains a minimum safe clearance, not a hidden fixed world elevation.
 */
export function createCrashRecoverySpawn(
  world: WorldDefinition,
  worldX: number,
  worldZ: number,
  headingRadians: number,
  requestedAirborneStartAgl: number,
  aircraftKind: AircraftKind = "trainer",
): SpawnOptions {
  const fallback = createSimulationSpawn(
    world,
    "airborne",
    requestedAirborneStartAgl,
    aircraftKind,
  );
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) return fallback;

  const x = Math.min(1e9, Math.max(-1e9, worldX));
  const z = Math.min(1e9, Math.max(-1e9, worldZ));
  const airborneStartAgl = normalizeAirborneStartAgl(requestedAirborneStartAgl);
  const aircraft = aircraftDefinition(aircraftKind);
  const airborneGear = airborneGearForAircraft(aircraftKind);
  const surfaceHeight = crashRecoverySurfaceHeight(world, x, z);
  const fallbackHeading = fallback.heading ?? 0;

  return {
    position: {
      x,
      y: surfaceHeight + airborneCgHeight(airborneStartAgl, aircraft, airborneGear),
      z,
    },
    heading: Number.isFinite(headingRadians) ? headingRadians : fallbackHeading,
    pitch: AIRBORNE_START_PITCH,
    airspeed: airborneAirspeedForAircraft(aircraftKind),
    controls: {
      ...DEFAULT_CONTROLS,
      throttle: airborneThrottleForAircraft(aircraftKind),
      trim: 0,
      gear: airborneGear,
    },
  };
}
