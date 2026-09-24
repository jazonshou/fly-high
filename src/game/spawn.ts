import {
  aftExtent,
  aircraftDefinition,
  standardAirDensity,
  DEFAULT_CONTROLS,
  type AircraftDefinition,
  type AircraftKind,
  type SpawnOptions,
} from "@/src/sim";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import {
  runwayToWorld,
  type AirportDefinition,
  type WorldDefinition,
} from "@/src/world";
import { sampleGroundHeight } from "@/src/sim/terrainGrid";
import {
  normalizeAirborneStartAgl,
  type SpawnKind,
} from "@/src/workers/protocol";

const AIRBORNE_START_PITCH = (2.4 * Math.PI) / 180;

const SEA_LEVEL_DENSITY = 1.225;

/**
 * Corrects an airborne spawn for the air it actually starts in.
 *
 * The catalogue's `airborneAirspeed` and `airborneThrottle` are one speed and
 * one throttle, measured level at one altitude. But the start height is a
 * PLAYER SETTING that runs to 3,000 m, and at the top of it the same numbers
 * do not hold level at all: measured hands-off in the app for 90 s, the 747
 * sank 1,634 ft, the Global 1,518 and the F-16 1,243. Even at the 450 m
 * default the 747 drifted down 700 ft.
 *
 * So the catalogue figure is read as an EQUIVALENT airspeed at sea level and
 * converted. Two standard relations, both exact in this model:
 *
 *   TAS = EAS / sqrt(sigma)   — same dynamic pressure, so the same angle of
 *                               attack and the same lift at any altitude.
 *   throttle = throttle0 / sigma  — for a JET only. `calculateEngineThrust`
 *                               lapses jet thrust with density, so thrust
 *                               required over thrust available scales exactly
 *                               this way.
 *
 * The propeller branch is power-limited rather than density-limited, so it is
 * deliberately left alone: the Cessna already holds level within 50 ft across
 * the range, and applying a jet's correction to it would be a guess dressed
 * as physics.
 */
function altitudeCorrectedSpawn(
  aircraft: AircraftDefinition,
  equivalentAirspeed: number,
  seaLevelThrottle: number,
  spawnAltitude: number,
): { airspeed: number; throttle: number } {
  const sigma = Math.max(
    0.05,
    standardAirDensity(spawnAltitude) / SEA_LEVEL_DENSITY,
  );
  return {
    airspeed: equivalentAirspeed / Math.sqrt(sigma),
    throttle: aircraft.propulsion === "jet"
      ? Math.min(1, seaLevelThrottle / sigma)
      : seaLevelThrottle,
  };
}

/** Tarmac left behind the tail when lined up. Enough to be clearly on, not wasted. */
const RUNWAY_THRESHOLD_MARGIN = 10;

/**
 * Where along the runway an aeroplane lines up, measured from the centre.
 *
 * Placed off the airframe's own aft extent rather than a shared fraction of
 * the runway: a take-off starts at the threshold, and "far enough forward that
 * the tail is on pavement" is a different distance for a 7 m Cessna than for a
 * 76 m airliner. The previous constant — 36% back from the midpoint — threw
 * away 185 m of a 1,320 m strip and would still have hung a big tail over the
 * grass, because it was one number measured against a small aeroplane.
 */
export function runwayStartAlong(
  airport: Readonly<AirportDefinition>,
  aircraft: AircraftDefinition,
): number {
  return -airport.runwayLength * 0.5 + aftExtent(aircraft) + RUNWAY_THRESHOLD_MARGIN;
}
const RECOVERY_TERRAIN_RADII = [180, 420, 720] as const;

export function airborneAirspeedForAircraft(aircraft: AircraftKind): number {
  return aircraftSpec(aircraft).spawn.airborneAirspeed;
}

export function airborneThrottleForAircraft(aircraft: AircraftKind): number {
  return aircraftSpec(aircraft).spawn.airborneThrottle;
}

export function runwayTrimForAircraft(aircraft: AircraftKind): number {
  return aircraftSpec(aircraft).spawn.runwayTrim;
}

export function airborneGearForAircraft(aircraft: AircraftKind): number {
  return aircraftSpec(aircraft).spawn.airborneGear;
}

export function runwayFlapsForAircraft(aircraft: AircraftKind): number {
  return aircraftSpec(aircraft).spawn.runwayFlaps;
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
    const y = terrainHeight + airborneCgHeight(airborneStartAgl, aircraft, airborneGear);
    const corrected = altitudeCorrectedSpawn(aircraft, airborneAirspeed, airborneThrottle, y);
    return {
      position: { x, y, z },
      heading: 0,
      pitch: AIRBORNE_START_PITCH,
      airspeed: corrected.airspeed,
      controls: {
        ...DEFAULT_CONTROLS, throttle: corrected.throttle, trim: 0, gear: airborneGear,
      },
    };
  }

  if (kind === "runway") {
    const point = runwayToWorld(airport, runwayStartAlong(airport, aircraft), 0);
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
  const y = airport.elevation + airborneCgHeight(airborneStartAgl, aircraft, airborneGear);
  const corrected = altitudeCorrectedSpawn(aircraft, airborneAirspeed, airborneThrottle, y);
  return {
    position: { x: point.x, y, z: point.z },
    heading: airport.headingRadians,
    pitch: AIRBORNE_START_PITCH,
    airspeed: corrected.airspeed,
    controls: {
      ...DEFAULT_CONTROLS, throttle: corrected.throttle, trim: 0, gear: airborneGear,
    },
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

  const y = surfaceHeight + airborneCgHeight(airborneStartAgl, aircraft, airborneGear);
  // Corrected for density altitude like every other airborne start. A crash
  // recovery in the mountains is exactly where an uncorrected spawn hurts
  // most: high ground, thin air, and a pilot who has just lost control once.
  const corrected = altitudeCorrectedSpawn(
    aircraft,
    airborneAirspeedForAircraft(aircraftKind),
    airborneThrottleForAircraft(aircraftKind),
    y,
  );

  return {
    position: { x, y, z },
    heading: Number.isFinite(headingRadians) ? headingRadians : fallbackHeading,
    pitch: AIRBORNE_START_PITCH,
    airspeed: corrected.airspeed,
    controls: {
      ...DEFAULT_CONTROLS,
      throttle: corrected.throttle,
      trim: 0,
      gear: airborneGear,
    },
  };
}
