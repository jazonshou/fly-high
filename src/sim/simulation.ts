import {
  calculateDragCoefficient,
  calculateEngineThrust,
  calculateLiftCoefficient,
  LIGHT_TRAINER,
  type AircraftDefinition,
} from "./aircraft";
import {
  clamp,
  crossInto,
  dot3,
  finiteOr,
  inverseRotateVectorInto,
  length3,
  moveToward,
  normalizeInto,
  normalizeQuaternionInto,
  quaternionFromFlightAngles,
  rotateVectorInto,
  sanitizeVec3,
  vec3,
  wrapAngle,
} from "./math";
import type {
  ActuatorState,
  EnvironmentInput,
  FlightControls,
  FlightSnapshot,
  FlightState,
  FlightTelemetry,
  SpawnOptions,
  TerrainSample,
  Vec3,
} from "./types";

export const FIXED_TIME_STEP = 1 / 120;
export const MAX_STEP_DURATION = 0.25;
export const STANDARD_GRAVITY = 9.80665;
export const SEA_LEVEL_DENSITY = 1.225;

const WORLD_UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
// A right-handed x-forward/y-up body frame necessarily has +Z toward port.
// Keeping this explicit prevents pilot-right controls from being confused with
// a positive body-Z component.
const BODY_RIGHT: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: -1 });
const BODY_UP: Readonly<Vec3> = WORLD_UP;
const BODY_FORWARD: Readonly<Vec3> = Object.freeze({ x: 1, y: 0, z: 0 });
const ZERO_VECTOR: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
const MAX_GEAR_COMPRESSION = 0.22;
const GEAR_DOWN_LOCK_THRESHOLD = 0.98;
const CRASH_IMPACT_SPEED = 8.5;
const CRASH_SURFACE_CLEARANCE = 0.006;
// The coefficient model remains valid through a stall, but at very high true
// airspeed in thin air it can otherwise request non-structural frame-to-frame
// accelerations and reach the old numerical safety clamp of 20 rad/s. These
// deliberately generous envelopes limit rate and acceleration only; they never
// target an attitude, so a stalled or tilted aircraft remains fully free to
// depart and must still be recovered by the pilot.
const MAX_AERO_ANGULAR_ACCELERATION: Readonly<Vec3> = Object.freeze({
  x: 4,
  y: 2.4,
  z: 3.1,
});
const MAX_BODY_ANGULAR_RATE: Readonly<Vec3> = Object.freeze({
  x: 4.25,
  y: 2.35,
  z: 3.1,
});

export const DEFAULT_CONTROLS: Readonly<FlightControls> = Object.freeze({
  throttle: 0.46,
  pitch: 0,
  roll: 0,
  yaw: 0,
  trim: 0,
  flaps: 0,
  brake: 0,
  gear: 1,
});

export const DEFAULT_ENVIRONMENT: Readonly<EnvironmentInput> = Object.freeze({
  wind: Object.freeze({ x: 0, y: 0, z: 0 }),
  gravity: STANDARD_GRAVITY,
});

interface Scratch {
  controls: FlightControls;
  relativeWorld: Vec3;
  relativeBody: Vec3;
  velocityDirectionBody: Vec3;
  liftDirectionBody: Vec3;
  aeroForceBody: Vec3;
  forceBody: Vec3;
  forceWorld: Vec3;
  torqueBody: Vec3;
  tempA: Vec3;
  tempB: Vec3;
  tempC: Vec3;
  tempD: Vec3;
  maximumGroundPenetration: number;
  airframeContact: boolean;
  gearBody: Vec3;
}

function createScratch(): Scratch {
  return {
    controls: { ...DEFAULT_CONTROLS },
    relativeWorld: vec3(),
    relativeBody: vec3(),
    velocityDirectionBody: vec3(0, 0, 1),
    liftDirectionBody: vec3(0, 1, 0),
    aeroForceBody: vec3(),
    forceBody: vec3(),
    forceWorld: vec3(),
    torqueBody: vec3(),
    tempA: vec3(),
    tempB: vec3(),
    tempC: vec3(),
    tempD: vec3(),
    maximumGroundPenetration: 0,
    airframeContact: false,
    gearBody: vec3(),
  };
}

function normalizeControlsInto(
  out: FlightControls,
  controls: Partial<FlightControls> | undefined,
): FlightControls {
  out.throttle = clamp(finiteOr(controls?.throttle, DEFAULT_CONTROLS.throttle), 0, 1);
  out.pitch = clamp(finiteOr(controls?.pitch, DEFAULT_CONTROLS.pitch), -1, 1);
  out.roll = clamp(finiteOr(controls?.roll, DEFAULT_CONTROLS.roll), -1, 1);
  out.yaw = clamp(finiteOr(controls?.yaw, DEFAULT_CONTROLS.yaw), -1, 1);
  out.trim = clamp(finiteOr(controls?.trim, DEFAULT_CONTROLS.trim), -1, 1);
  out.flaps = clamp(finiteOr(controls?.flaps, DEFAULT_CONTROLS.flaps), 0, 1);
  out.brake = clamp(finiteOr(controls?.brake, DEFAULT_CONTROLS.brake), 0, 1);
  out.gear = clamp(finiteOr(controls?.gear, DEFAULT_CONTROLS.gear), 0, 1);
  return out;
}

function gearExtensionForAircraft(
  aircraft: AircraftDefinition,
  requestedExtension: number,
): number {
  return aircraft.retractableGear ? clamp(requestedExtension, 0, 1) : 1;
}

function gearDownAndLocked(
  aircraft: AircraftDefinition,
  extension: number,
): boolean {
  return !aircraft.retractableGear || extension >= GEAR_DOWN_LOCK_THRESHOLD;
}

function landingGearPositionInto(
  out: Vec3,
  gear: AircraftDefinition["gear"][number],
  aircraft: AircraftDefinition,
  extension: number,
): Vec3 {
  const stowed = gear.retractedPosition;
  if (!aircraft.retractableGear || !stowed) {
    out.x = gear.position.x;
    out.y = gear.position.y;
    out.z = gear.position.z;
    return out;
  }
  const travel = clamp(extension, 0, 1);
  const eased = travel * travel * (3 - 2 * travel);
  out.x = stowed.x + (gear.position.x - stowed.x) * eased;
  out.y = stowed.y + (gear.position.y - stowed.y) * eased;
  out.z = stowed.z + (gear.position.z - stowed.z) * eased;
  return out;
}

function normalizedControls(controls: Partial<FlightControls> | undefined): FlightControls {
  return normalizeControlsInto({ ...DEFAULT_CONTROLS }, controls);
}

interface GroundSpawnPose {
  pitch: number;
  cgHeight: number;
}

/**
 * Computes the level-runway static attitude from the actual gear geometry and
 * spring rates. The old spawn used the lowest unrotated wheel only, leaving the
 * nose wheel visibly suspended and giving the contact solver no static preload.
 */
function calculateGroundSpawnPose(
  aircraft: AircraftDefinition,
  gravity: number,
): GroundSpawnPose {
  const gear = aircraft.gear;
  if (gear.length === 0) return { pitch: 0, cgHeight: 0 };

  let forwardX = -Infinity;
  for (const wheel of gear) forwardX = Math.max(forwardX, wheel.position.x);
  const forwardGear = gear.filter((wheel) => Math.abs(wheel.position.x - forwardX) < 0.05);
  const rearGear = gear.filter((wheel) => wheel.position.x < forwardX - 0.05);
  if (forwardGear.length === 0 || rearGear.length === 0) {
    return {
      pitch: 0,
      cgHeight: -Math.min(...gear.map((wheel) => wheel.position.y)),
    };
  }

  const weightedAverage = (
    wheels: readonly (typeof gear)[number][],
    key: "x" | "y",
  ): number => {
    let numerator = 0;
    let denominator = 0;
    for (const wheel of wheels) {
      numerator += wheel.position[key] * wheel.springRate;
      denominator += wheel.springRate;
    }
    return numerator / Math.max(1, denominator);
  };
  const rearX = weightedAverage(rearGear, "x");
  const rearY = weightedAverage(rearGear, "y");
  const frontX = weightedAverage(forwardGear, "x");
  const frontY = weightedAverage(forwardGear, "y");
  const wheelbase = Math.max(0.1, frontX - rearX);
  const weight = aircraft.mass * gravity;
  const frontLoad = clamp((-rearX / wheelbase) * weight, 0, weight);
  const rearLoad = weight - frontLoad;
  const rearStiffness = rearGear.reduce((sum, wheel) => sum + wheel.springRate, 0);
  const frontStiffness = forwardGear.reduce((sum, wheel) => sum + wheel.springRate, 0);
  const rearCompression = rearLoad / Math.max(1, rearStiffness);
  const frontCompression = frontLoad / Math.max(1, frontStiffness);

  // dx*sin(pitch) + dy*cos(pitch) equals the difference between the desired
  // compressed front and rear contact heights.
  const dx = frontX - rearX;
  const dy = frontY - rearY;
  const radius = Math.hypot(dx, dy);
  const desiredDifference = rearCompression - frontCompression;
  const pitch = clamp(
    Math.asin(clamp(desiredDifference / Math.max(radius, 0.1), -1, 1)) -
      Math.atan2(dy, dx),
    (-12 * Math.PI) / 180,
    (12 * Math.PI) / 180,
  );
  const rotatedRearY = Math.sin(pitch) * rearX + Math.cos(pitch) * rearY;
  const cgHeight = -rearCompression - rotatedRearY;
  return { pitch, cgHeight };
}

export function standardAirDensity(altitudeMetres: number): number {
  // A bounded exponential atmosphere is sufficient at the light trainer's envelope.
  return SEA_LEVEL_DENSITY * Math.exp(-clamp(altitudeMetres, -500, 20_000) / 8_500);
}

function terrainAt(
  environment: EnvironmentInput,
  x: number,
  z: number,
): TerrainSample | undefined {
  const terrain = environment.terrain;
  if (!terrain) return undefined;

  if (typeof terrain === "function") {
    const sample = terrain(x, z);
    if (!sample || !Number.isFinite(sample.height)) return undefined;
    return sample;
  }

  if (!Number.isFinite(terrain.height)) return undefined;
  // Return the same object; callers evaluate its tangent plane where required.
  // This avoids per-wheel allocations while the aircraft is on the ground.
  return terrain;
}

function terrainHeightAt(
  environment: EnvironmentInput,
  x: number,
  z: number,
): number | undefined {
  if (environment.terrainHeight) {
    const height = environment.terrainHeight(x, z);
    if (Number.isFinite(height)) return height;
  }
  return terrainAt(environment, x, z)?.height;
}

function couldReachTerrain(
  state: FlightState,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
): boolean {
  if (!environment.terrain) return false;
  if (state.onGround || !environment.terrainHeight) return true;
  const surfaceHeight = terrainHeightAt(environment, state.position.x, state.position.z);
  if (surfaceHeight === undefined) return true;
  let maximumGearRadius = 0;
  for (const gear of aircraft.gear) {
    maximumGearRadius = Math.max(
      maximumGearRadius,
      Math.hypot(gear.position.x, gear.position.y, gear.position.z),
    );
  }
  for (const point of aircraft.airframeContactPoints) {
    maximumGearRadius = Math.max(
      maximumGearRadius,
      Math.hypot(point.x, point.y, point.z),
    );
  }
  // The margin covers one maximum-speed substep and terrain variation between
  // the CG and wheels. It is intentionally conservative; the valuable reject
  // is the normal airborne case hundreds of metres above the surface.
  return (
    state.position.y - surfaceHeight <=
    maximumGearRadius + MAX_GEAR_COMPRESSION + 8
  );
}

function gearClearanceAboveTerrain(
  state: FlightState,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
): number {
  let minimumClearance = Number.POSITIVE_INFINITY;
  const offset = vec3();
  const physicalPoint = vec3();
  const centreHeight = terrainHeightAt(
    environment,
    state.position.x,
    state.position.z,
  );
  const useCentreHeight =
    centreHeight !== undefined && state.position.y - centreHeight > 20;
  const includePoint = (point: Readonly<Vec3>): void => {
    rotateVectorInto(offset, state.orientation, point);
    const pointX = state.position.x + offset.x;
    const pointZ = state.position.z + offset.z;
    const surfaceHeight = useCentreHeight
      ? centreHeight
      : (terrainHeightAt(environment, pointX, pointZ) ?? 0);
    minimumClearance = Math.min(
      minimumClearance,
      state.position.y + offset.y - surfaceHeight,
    );
  };
  for (const point of aircraft.airframeContactPoints) includePoint(point);
  if (!aircraft.retractableGear || state.actuators.gear > 0.015) {
    for (const gear of aircraft.gear) {
      landingGearPositionInto(physicalPoint, gear, aircraft, state.actuators.gear);
      includePoint(physicalPoint);
    }
  }
  if (!Number.isFinite(minimumClearance)) {
    minimumClearance = state.position.y - (centreHeight ?? 0);
  }
  // Suspension compression puts tyre contact points slightly below the ideal
  // terrain plane. AGL is a pilot-facing wheel clearance, so ground contact is
  // exactly zero rather than the aircraft CG height above the runway.
  return Math.max(0, minimumClearance);
}

export function createFlightState(
  spawn: SpawnOptions = {},
  aircraft: AircraftDefinition = LIGHT_TRAINER,
): FlightState {
  const onGround = spawn.onGround === true;
  const heading = finiteOr(spawn.heading, 0);
  const groundPose = calculateGroundSpawnPose(aircraft, STANDARD_GRAVITY);
  const pitch = finiteOr(spawn.pitch, onGround ? groundPose.pitch : (2 * Math.PI) / 180);
  const bank = finiteOr(spawn.bank, 0);
  const orientation = quaternionFromFlightAngles(heading, pitch, bank);
  const airspeed = clamp(finiteOr(spawn.airspeed, onGround ? 0 : 50), 0, 180);
  const actuators = normalizedControls(spawn.controls);
  actuators.gear = onGround
    ? 1
    : gearExtensionForAircraft(
        aircraft,
        aircraft.retractableGear && spawn.controls?.gear === undefined
          ? 0
          : actuators.gear,
      );
  let gearClearance = groundPose.cgHeight;
  if (!onGround || spawn.pitch !== undefined || bank !== 0) {
    let lowestOffset = Number.POSITIVE_INFINITY;
    const rotated = vec3();
    const physicalPoint = vec3();
    for (const point of aircraft.airframeContactPoints) {
      rotateVectorInto(rotated, orientation, point);
      lowestOffset = Math.min(lowestOffset, rotated.y);
    }
    if (!aircraft.retractableGear || actuators.gear > 0.015) {
      for (const gear of aircraft.gear) {
        landingGearPositionInto(physicalPoint, gear, aircraft, actuators.gear);
        rotateVectorInto(rotated, orientation, physicalPoint);
        lowestOffset = Math.min(lowestOffset, rotated.y);
      }
    }
    gearClearance = -Math.min(0, lowestOffset);
  }
  const defaultPosition = {
    x: 0,
    y: onGround ? finiteOr(spawn.terrainHeight, 0) + gearClearance : 900,
    z: 0,
  };
  const position = sanitizeVec3(spawn.position, defaultPosition);
  if (onGround) {
    // X/Z are honoured, but onGround is a semantic request to place the gear
    // on the supplied surface. An arbitrary position.y must not create a
    // contradictory airborne state with an on-ground flag.
    position.y = finiteOr(spawn.terrainHeight, 0) + gearClearance;
  }
  const trimmedAngleOfAttack = onGround
    ? 0
    : clamp(
        -(
          aircraft.pitchMomentZero +
          aircraft.pitchMomentElevator *
            (actuators.pitch + actuators.trim * 0.5)
        ) / aircraft.pitchMomentAlpha,
        (-8 * Math.PI) / 180,
        (8 * Math.PI) / 180,
      );
  const velocityOrientation = quaternionFromFlightAngles(
    heading,
    onGround ? 0 : pitch - trimmedAngleOfAttack,
    0,
  );
  const velocityDirection = vec3();
  rotateVectorInto(velocityDirection, velocityOrientation, BODY_FORWARD);
  const velocity = spawn.velocity
    ? sanitizeVec3(spawn.velocity, vec3())
    : {
        x: velocityDirection.x * airspeed,
        y: velocityDirection.y * airspeed,
        z: velocityDirection.z * airspeed,
      };
  const initialLiftCoefficient = calculateLiftCoefficient(
    trimmedAngleOfAttack,
    actuators.flaps,
    aircraft,
  );

  return {
    time: 0,
    position,
    velocity,
    orientation,
    angularVelocity: sanitizeVec3(spawn.angularVelocity, ZERO_VECTOR),
    actuators,
    engineRpm:
      aircraft.idleRpm + actuators.throttle * (aircraft.maxRpm - aircraft.idleRpm),
    onGround,
    crashed: false,
    peakImpactSpeed: 0,
    dynamics: {
      angleOfAttack: trimmedAngleOfAttack,
      sideslip: 0,
      airspeed,
      airDensity: standardAirDensity(position.y),
      liftCoefficient: initialLiftCoefficient,
      dragCoefficient: calculateDragCoefficient(
        trimmedAngleOfAttack,
        initialLiftCoefficient,
        actuators.flaps,
        aircraft,
        actuators.gear,
        actuators.brake,
      ),
      liftForce: 0,
      dragForce: 0,
      thrustForce: 0,
      sideForce: 0,
      loadFactor: 1,
      contactCount: onGround ? 3 : 0,
      totalForceWorld: vec3(),
    },
  };
}

export const spawnFlight = createFlightState;

function updateActuators(
  actuators: ActuatorState,
  controls: FlightControls,
  aircraft: AircraftDefinition,
  weightOnWheels: boolean,
  dt: number,
): void {
  actuators.throttle = moveToward(actuators.throttle, controls.throttle, dt * 1.5);
  actuators.pitch = moveToward(actuators.pitch, controls.pitch, dt * 7);
  actuators.roll = moveToward(actuators.roll, controls.roll, dt * 9);
  actuators.yaw = moveToward(actuators.yaw, controls.yaw, dt * 6);
  actuators.trim = moveToward(actuators.trim, controls.trim, dt * 0.45);
  actuators.flaps = moveToward(actuators.flaps, controls.flaps, dt * 0.28);
  actuators.brake = moveToward(actuators.brake, controls.brake, dt * 5);
  actuators.gear = aircraft.retractableGear
    ? moveToward(
        actuators.gear,
        weightOnWheels ? 1 : controls.gear,
        dt * aircraft.gearCycleRate,
      )
    : 1;
}

function sanitizeState(state: FlightState): void {
  state.time = clamp(finiteOr(state.time, 0), 0, 1e9);
  state.position.x = clamp(finiteOr(state.position.x, 0), -1e9, 1e9);
  state.position.y = clamp(finiteOr(state.position.y, 1_000), -10_000, 100_000);
  state.position.z = clamp(finiteOr(state.position.z, 0), -1e9, 1e9);
  state.velocity.x = clamp(finiteOr(state.velocity.x, 0), -350, 350);
  state.velocity.y = clamp(finiteOr(state.velocity.y, 0), -350, 350);
  state.velocity.z = clamp(finiteOr(state.velocity.z, 0), -350, 350);
  state.angularVelocity.x = clamp(
    finiteOr(state.angularVelocity.x, 0),
    -MAX_BODY_ANGULAR_RATE.x,
    MAX_BODY_ANGULAR_RATE.x,
  );
  state.angularVelocity.y = clamp(
    finiteOr(state.angularVelocity.y, 0),
    -MAX_BODY_ANGULAR_RATE.y,
    MAX_BODY_ANGULAR_RATE.y,
  );
  state.angularVelocity.z = clamp(
    finiteOr(state.angularVelocity.z, 0),
    -MAX_BODY_ANGULAR_RATE.z,
    MAX_BODY_ANGULAR_RATE.z,
  );
  normalizeQuaternionInto(state.orientation, state.orientation);
}

function applyGroundForces(
  state: FlightState,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
  scratch: Scratch,
): number {
  if (!environment.terrain) return 0;
  if (!gearDownAndLocked(aircraft, state.actuators.gear)) return 0;

  let contacts = 0;
  scratch.maximumGroundPenetration = 0;
  const referenceX = state.position.x;
  const referenceZ = state.position.z;
  const aircraftForward = scratch.tempC;
  rotateVectorInto(aircraftForward, state.orientation, BODY_FORWARD);
  const aircraftRight = scratch.tempD;
  rotateVectorInto(aircraftRight, state.orientation, BODY_RIGHT);

  for (const gear of aircraft.gear) {
    const radiusWorld = scratch.tempA;
    landingGearPositionInto(scratch.gearBody, gear, aircraft, state.actuators.gear);
    rotateVectorInto(radiusWorld, state.orientation, scratch.gearBody);
    const pointX = state.position.x + radiusWorld.x;
    const pointY = state.position.y + radiusWorld.y;
    const pointZ = state.position.z + radiusWorld.z;
    const sample = terrainAt(environment, pointX, pointZ);
    if (!sample) continue;

    const normal = scratch.tempB;
    normal.x = finiteOr(sample.normal?.x, 0);
    normal.y = finiteOr(sample.normal?.y, 1);
    normal.z = finiteOr(sample.normal?.z, 0);
    normalizeInto(normal, normal, WORLD_UP);
    if (normal.y < 0.05) {
      normal.x = 0;
      normal.y = 1;
      normal.z = 0;
    }

    const planeHeight =
      typeof environment.terrain === "function"
        ? sample.height
        : sample.height -
          (normal.x * (pointX - referenceX) + normal.z * (pointZ - referenceZ)) / normal.y;
    const penetration = planeHeight - pointY;
    scratch.maximumGroundPenetration = Math.max(
      scratch.maximumGroundPenetration,
      penetration,
    );
    // A small suspension-reach tolerance keeps the contact flag and damping
    // stable when positional projection leaves a wheel exactly on the surface.
    if (penetration <= -0.025) continue;
    // Contact state includes the tiny rebound gap allowed by the suspension
    // solver; otherwise onGround flickers at the top of every damped cycle.
    contacts += 1;

    // Point velocity: v_cg + R * (omega_body x radius_body).
    crossInto(scratch.relativeBody, state.angularVelocity, scratch.gearBody);
    rotateVectorInto(scratch.relativeWorld, state.orientation, scratch.relativeBody);
    const pointVelocityX = state.velocity.x + scratch.relativeWorld.x;
    const pointVelocityY = state.velocity.y + scratch.relativeWorld.y;
    const pointVelocityZ = state.velocity.z + scratch.relativeWorld.z;
    const normalVelocity =
      pointVelocityX * normal.x + pointVelocityY * normal.y + pointVelocityZ * normal.z;
    state.peakImpactSpeed = Math.max(state.peakImpactSpeed, Math.max(0, -normalVelocity));

    const normalForce = clamp(
      Math.max(0, penetration) * gear.springRate - normalVelocity * gear.dampingRate,
      0,
      aircraft.mass * STANDARD_GRAVITY * 12,
    );
    if (normalForce <= 0) continue;

    let forceX = normal.x * normalForce;
    let forceY = normal.y * normalForce;
    let forceZ = normal.z * normalForce;

    const forwardNormal = dot3(aircraftForward, normal);
    scratch.velocityDirectionBody.x = aircraftForward.x - normal.x * forwardNormal;
    scratch.velocityDirectionBody.y = aircraftForward.y - normal.y * forwardNormal;
    scratch.velocityDirectionBody.z = aircraftForward.z - normal.z * forwardNormal;
    normalizeInto(scratch.velocityDirectionBody, scratch.velocityDirectionBody, BODY_FORWARD);

    const rightNormal = dot3(aircraftRight, normal);
    scratch.liftDirectionBody.x = aircraftRight.x - normal.x * rightNormal;
    scratch.liftDirectionBody.y = aircraftRight.y - normal.y * rightNormal;
    scratch.liftDirectionBody.z = aircraftRight.z - normal.z * rightNormal;
    normalizeInto(scratch.liftDirectionBody, scratch.liftDirectionBody, BODY_RIGHT);

    if (gear.maxSteeringAngle) {
      // The nose wheel follows rudder input at taxi speeds. Rotate the tyre's
      // tangent frame about the runway normal; positive pilot yaw steers right.
      const steering = state.actuators.yaw * gear.maxSteeringAngle;
      const cosine = Math.cos(steering);
      const sine = Math.sin(steering);
      const forwardX = scratch.velocityDirectionBody.x;
      const forwardY = scratch.velocityDirectionBody.y;
      const forwardZ = scratch.velocityDirectionBody.z;
      const rightX = scratch.liftDirectionBody.x;
      const rightY = scratch.liftDirectionBody.y;
      const rightZ = scratch.liftDirectionBody.z;
      scratch.velocityDirectionBody.x = forwardX * cosine + rightX * sine;
      scratch.velocityDirectionBody.y = forwardY * cosine + rightY * sine;
      scratch.velocityDirectionBody.z = forwardZ * cosine + rightZ * sine;
      scratch.liftDirectionBody.x = rightX * cosine - forwardX * sine;
      scratch.liftDirectionBody.y = rightY * cosine - forwardY * sine;
      scratch.liftDirectionBody.z = rightZ * cosine - forwardZ * sine;
    }

    const forwardSpeed =
      pointVelocityX * scratch.velocityDirectionBody.x +
      pointVelocityY * scratch.velocityDirectionBody.y +
      pointVelocityZ * scratch.velocityDirectionBody.z;
    const sideSpeed =
      pointVelocityX * scratch.liftDirectionBody.x +
      pointVelocityY * scratch.liftDirectionBody.y +
      pointVelocityZ * scratch.liftDirectionBody.z;
    const frictionMultiplier = clamp(finiteOr(sample.friction, 1), 0.05, 2);
    const rollingLimit =
      normalForce * (0.012 + state.actuators.brake * 0.68) * frictionMultiplier;
    const rollingForce =
      -Math.sign(forwardSpeed) *
      Math.min(rollingLimit, Math.abs(forwardSpeed) * (450 + 7_000 * state.actuators.brake));
    const lateralLimit = normalForce * 0.78 * frictionMultiplier;
    const lateralForce =
      -Math.sign(sideSpeed) * Math.min(lateralLimit, Math.abs(sideSpeed) * 8_000);
    forceX +=
      scratch.velocityDirectionBody.x * rollingForce + scratch.liftDirectionBody.x * lateralForce;
    forceY +=
      scratch.velocityDirectionBody.y * rollingForce + scratch.liftDirectionBody.y * lateralForce;
    forceZ +=
      scratch.velocityDirectionBody.z * rollingForce + scratch.liftDirectionBody.z * lateralForce;

    scratch.forceWorld.x += forceX;
    scratch.forceWorld.y += forceY;
    scratch.forceWorld.z += forceZ;

    scratch.tempB.x = forceX;
    scratch.tempB.y = forceY;
    scratch.tempB.z = forceZ;
    inverseRotateVectorInto(scratch.tempB, state.orientation, scratch.tempB);
    crossInto(scratch.tempA, scratch.gearBody, scratch.tempB);
    scratch.torqueBody.x += scratch.tempA.x;
    scratch.torqueBody.y += scratch.tempA.y;
    scratch.torqueBody.z += scratch.tempA.z;
  }

  return contacts;
}

function projectOutOfTerrain(
  state: FlightState,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
  scratch: Scratch,
): void {
  if (!environment.terrain) return;
  if (!gearDownAndLocked(aircraft, state.actuators.gear)) return;
  let maximumPenetration = 0;
  let projectionNormalX = 0;
  let projectionNormalY = 1;
  let projectionNormalZ = 0;

  for (const gear of aircraft.gear) {
    landingGearPositionInto(scratch.gearBody, gear, aircraft, state.actuators.gear);
    rotateVectorInto(scratch.tempA, state.orientation, scratch.gearBody);
    const pointX = state.position.x + scratch.tempA.x;
    const pointY = state.position.y + scratch.tempA.y;
    const pointZ = state.position.z + scratch.tempA.z;
    const sample = terrainAt(
      environment,
      pointX,
      pointZ,
    );
    if (!sample) continue;
    scratch.tempB.x = finiteOr(sample.normal?.x, 0);
    scratch.tempB.y = finiteOr(sample.normal?.y, 1);
    scratch.tempB.z = finiteOr(sample.normal?.z, 0);
    normalizeInto(scratch.tempB, scratch.tempB, WORLD_UP);
    const height =
      typeof environment.terrain === "function"
        ? sample.height
        : sample.height -
          (scratch.tempB.x * (pointX - state.position.x) +
            scratch.tempB.z * (pointZ - state.position.z)) /
            Math.max(0.05, scratch.tempB.y);
    // The spring model needs real geometric compression to support the static
    // aircraft weight. Only project the state when a wheel exceeds suspension
    // travel; projecting every millimetre to the surface creates a perpetual
    // gravity/rebound cycle and leaves the nose gear unloaded.
    const excessPenetration = height - pointY - MAX_GEAR_COMPRESSION;
    if (excessPenetration > maximumPenetration) {
      maximumPenetration = excessPenetration;
      projectionNormalX = scratch.tempB.x;
      projectionNormalY = Math.max(0.05, scratch.tempB.y);
      projectionNormalZ = scratch.tempB.z;
    }
  }

  if (maximumPenetration <= 0) return;
  const correction = Math.min(maximumPenetration / projectionNormalY, 0.35);
  state.position.x += projectionNormalX * correction;
  state.position.y += projectionNormalY * correction;
  state.position.z += projectionNormalZ * correction;
  const inwardVelocity =
    state.velocity.x * projectionNormalX +
    state.velocity.y * projectionNormalY +
    state.velocity.z * projectionNormalZ;
  if (inwardVelocity < 0) {
    const removal = inwardVelocity * 1.04;
    state.velocity.x -= projectionNormalX * removal;
    state.velocity.y -= projectionNormalY * removal;
    state.velocity.z -= projectionNormalZ * removal;
  }
}

function airframeImpactSpeed(
  state: FlightState,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
  scratch: Scratch,
): number {
  if (!environment.terrain) return 0;
  scratch.airframeContact = false;
  let maximumImpactSpeed = 0;
  const referenceX = state.position.x;
  const referenceZ = state.position.z;

  for (const point of aircraft.airframeContactPoints) {
    rotateVectorInto(scratch.tempA, state.orientation, point);
    const pointX = referenceX + scratch.tempA.x;
    const pointY = state.position.y + scratch.tempA.y;
    const pointZ = referenceZ + scratch.tempA.z;
    const sample = terrainAt(environment, pointX, pointZ);
    if (!sample) continue;

    scratch.tempB.x = finiteOr(sample.normal?.x, 0);
    scratch.tempB.y = finiteOr(sample.normal?.y, 1);
    scratch.tempB.z = finiteOr(sample.normal?.z, 0);
    normalizeInto(scratch.tempB, scratch.tempB, WORLD_UP);
    if (scratch.tempB.y < 0.05) {
      scratch.tempB.x = 0;
      scratch.tempB.y = 1;
      scratch.tempB.z = 0;
    }
    const surfaceHeight =
      typeof environment.terrain === "function"
        ? sample.height
        : sample.height -
          (scratch.tempB.x * (pointX - referenceX) +
            scratch.tempB.z * (pointZ - referenceZ)) /
            scratch.tempB.y;
    if (surfaceHeight - pointY <= 0) continue;
    scratch.airframeContact = true;

    crossInto(scratch.relativeBody, state.angularVelocity, point);
    rotateVectorInto(scratch.relativeWorld, state.orientation, scratch.relativeBody);
    const normalVelocity =
      (state.velocity.x + scratch.relativeWorld.x) * scratch.tempB.x +
      (state.velocity.y + scratch.relativeWorld.y) * scratch.tempB.y +
      (state.velocity.z + scratch.relativeWorld.z) * scratch.tempB.z;
    maximumImpactSpeed = Math.max(maximumImpactSpeed, Math.max(0, -normalVelocity));
  }

  return maximumImpactSpeed;
}

function placeCrashedAirframeOnTerrain(
  state: FlightState,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
  scratch: Scratch,
): void {
  if (!environment.terrain) return;
  let requiredCgHeight = Number.NEGATIVE_INFINITY;

  const includePoint = (point: Readonly<Vec3>): void => {
    rotateVectorInto(scratch.tempA, state.orientation, point);
    const pointX = state.position.x + scratch.tempA.x;
    const pointZ = state.position.z + scratch.tempA.z;
    const sample = terrainAt(environment, pointX, pointZ);
    if (!sample) return;
    let surfaceHeight = sample.height;
    if (typeof environment.terrain !== "function") {
      scratch.tempB.x = finiteOr(sample.normal?.x, 0);
      scratch.tempB.y = finiteOr(sample.normal?.y, 1);
      scratch.tempB.z = finiteOr(sample.normal?.z, 0);
      normalizeInto(scratch.tempB, scratch.tempB, WORLD_UP);
      if (scratch.tempB.y < 0.05) {
        scratch.tempB.x = 0;
        scratch.tempB.y = 1;
        scratch.tempB.z = 0;
      }
      surfaceHeight -=
        (scratch.tempB.x * scratch.tempA.x + scratch.tempB.z * scratch.tempA.z) /
        scratch.tempB.y;
    }
    requiredCgHeight = Math.max(
      requiredCgHeight,
      surfaceHeight - scratch.tempA.y + CRASH_SURFACE_CLEARANCE,
    );
  };

  if (!aircraft.retractableGear || state.actuators.gear > 0.015) {
    for (const gear of aircraft.gear) {
      landingGearPositionInto(scratch.gearBody, gear, aircraft, state.actuators.gear);
      includePoint(scratch.gearBody);
    }
  }
  for (const point of aircraft.airframeContactPoints) includePoint(point);
  if (Number.isFinite(requiredCgHeight)) state.position.y = requiredCgHeight;
}

/**
 * A damaging impact is terminal until reset. The ordinary suspension solver is
 * intentionally bypassed so its stored compression cannot launch the wreck
 * back into the air. Orientation and X/Z remain at the impact pose while the
 * lowest visible gear/airframe proxy is placed on sampled terrain once.
 */
function settleCrashedState(
  state: FlightState,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
  scratch: Scratch,
  dt: number,
  placeOnTerrain: boolean,
): void {
  if (placeOnTerrain) {
    placeCrashedAirframeOnTerrain(state, environment, aircraft, scratch);
  }
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.velocity.z = 0;
  state.angularVelocity.x = 0;
  state.angularVelocity.y = 0;
  state.angularVelocity.z = 0;
  state.actuators.throttle = 0;
  state.actuators.pitch = 0;
  state.actuators.roll = 0;
  state.actuators.yaw = 0;
  state.actuators.trim = 0;
  state.actuators.brake = 1;
  state.engineRpm = 0;
  state.onGround = true;
  state.crashed = true;
  state.dynamics.angleOfAttack = 0;
  state.dynamics.sideslip = 0;
  state.dynamics.airspeed = 0;
  state.dynamics.airDensity = standardAirDensity(state.position.y);
  state.dynamics.liftCoefficient = 0;
  state.dynamics.dragCoefficient = 0;
  state.dynamics.liftForce = 0;
  state.dynamics.dragForce = 0;
  state.dynamics.thrustForce = 0;
  state.dynamics.sideForce = 0;
  state.dynamics.loadFactor = 0;
  state.dynamics.contactCount = aircraft.gear.length;
  state.dynamics.totalForceWorld.x = 0;
  state.dynamics.totalForceWorld.y = 0;
  state.dynamics.totalForceWorld.z = 0;
  state.time += dt;
  sanitizeState(state);
}

function integrateSubstep(
  state: FlightState,
  controls: FlightControls,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
  dt: number,
  scratch: Scratch,
): void {
  sanitizeState(state);
  if (state.crashed) {
    settleCrashedState(state, environment, aircraft, scratch, dt, false);
    return;
  }
  updateActuators(state.actuators, controls, aircraft, state.onGround, dt);

  const gravity = clamp(finiteOr(environment.gravity, STANDARD_GRAVITY), 0, 30);
  scratch.relativeWorld.x = state.velocity.x - finiteOr(environment.wind?.x, 0);
  scratch.relativeWorld.y = state.velocity.y - finiteOr(environment.wind?.y, 0);
  scratch.relativeWorld.z = state.velocity.z - finiteOr(environment.wind?.z, 0);
  inverseRotateVectorInto(scratch.relativeBody, state.orientation, scratch.relativeWorld);
  const airspeed = clamp(length3(scratch.relativeBody), 0, 350);
  normalizeInto(
    scratch.velocityDirectionBody,
    scratch.relativeBody,
    BODY_FORWARD,
  );

  const angleOfAttack =
    airspeed > 0.25
      ? clamp(Math.atan2(-scratch.relativeBody.y, scratch.relativeBody.x), -Math.PI / 2, Math.PI / 2)
      : 0;
  const sideslip =
    airspeed > 0.25
      ? clamp(
          Math.atan2(-scratch.relativeBody.z, Math.max(0.1, scratch.relativeBody.x)),
          -1.2,
          1.2,
        )
      : 0;
  const airDensity = clamp(
    // Atmosphere follows altitude above mean sea level, not clearance over the
    // terrain currently below the aircraft.
    finiteOr(environment.airDensity, standardAirDensity(state.position.y)),
    0.05,
    1.5,
  );
  const dynamicPressure = 0.5 * airDensity * airspeed * airspeed;
  const baseLiftCoefficient = calculateLiftCoefficient(
    angleOfAttack,
    state.actuators.flaps,
    aircraft,
  );
  // The jet's brake command drives its speed-brake panels in flight and its
  // lift-dump/spoiler function once weight is on the wheels. Wheel braking is
  // still applied exclusively by loaded gear contacts below.
  const speedBrakeLiftDump = aircraft.speedBrakeDrag > 0
    ? state.actuators.brake * (state.onGround ? 0.62 : 0.12)
    : 0;
  const liftCoefficient = baseLiftCoefficient * (1 - speedBrakeLiftDump);
  const dragCoefficient = calculateDragCoefficient(
    angleOfAttack,
    liftCoefficient,
    state.actuators.flaps,
    aircraft,
    state.actuators.gear,
    state.actuators.brake,
  );
  const liftForce = dynamicPressure * aircraft.wingArea * liftCoefficient;
  const dragForce = dynamicPressure * aircraft.wingArea * dragCoefficient;

  // Lift is perpendicular to relative motion and the starboard span direction,
  // pointing body-up in normal flight. BODY_RIGHT is -Z in this right-handed
  // coordinate frame.
  crossInto(scratch.liftDirectionBody, scratch.velocityDirectionBody, BODY_RIGHT);
  normalizeInto(scratch.liftDirectionBody, scratch.liftDirectionBody, BODY_UP);
  const sideForce =
    -dynamicPressure *
    aircraft.wingArea *
    (aircraft.sideForceBeta * sideslip +
      aircraft.sideForceRudder * state.actuators.yaw);
  scratch.aeroForceBody.x =
    -scratch.velocityDirectionBody.x * dragForce +
    scratch.liftDirectionBody.x * liftForce +
    BODY_RIGHT.x * sideForce;
  scratch.aeroForceBody.y =
    -scratch.velocityDirectionBody.y * dragForce +
    scratch.liftDirectionBody.y * liftForce +
    BODY_RIGHT.y * sideForce;
  scratch.aeroForceBody.z =
    -scratch.velocityDirectionBody.z * dragForce +
    scratch.liftDirectionBody.z * liftForce +
    BODY_RIGHT.z * sideForce;

  const forwardAirspeed = Math.max(0, scratch.relativeBody.x);
  const thrustForce = calculateEngineThrust(
    aircraft,
    state.actuators.throttle,
    airDensity,
    forwardAirspeed,
  );
  scratch.forceBody.x = scratch.aeroForceBody.x + thrustForce;
  scratch.forceBody.y = scratch.aeroForceBody.y;
  scratch.forceBody.z = scratch.aeroForceBody.z;
  rotateVectorInto(scratch.forceWorld, state.orientation, scratch.forceBody);
  scratch.forceWorld.y -= aircraft.mass * gravity;

  const safeAirspeed = Math.max(airspeed, 8);
  const pitchRate = state.angularVelocity.z;
  const yawRate = state.angularVelocity.y;
  const rollRate = state.angularVelocity.x;
  const elevator = state.actuators.pitch + state.actuators.trim * 0.5;
  const stallExcess = Math.max(
    0,
    angleOfAttack - aircraft.positiveStallAngle,
    aircraft.negativeStallAngle - angleOfAttack,
  );
  const postStallAuthority = 1 -
    0.58 * clamp(stallExcess / ((28 * Math.PI) / 180), 0, 1);
  const pitchCoefficient =
    aircraft.pitchMomentZero +
    aircraft.pitchMomentAlpha * angleOfAttack +
    aircraft.pitchMomentElevator * elevator * postStallAuthority +
    aircraft.pitchDamping * ((pitchRate * aircraft.meanChord) / (2 * safeAirspeed));
  const rollCoefficient =
    -aircraft.rollMomentAileron * state.actuators.roll * postStallAuthority +
    aircraft.rollMomentBeta * sideslip +
    aircraft.rollDamping * ((rollRate * aircraft.wingSpan) / (2 * safeAirspeed));
  const yawCoefficient =
    aircraft.yawMomentRudder * state.actuators.yaw * postStallAuthority +
    aircraft.yawMomentBeta * sideslip +
    aircraft.yawDamping * ((yawRate * aircraft.wingSpan) / (2 * safeAirspeed));
  const pitchMoment = dynamicPressure * aircraft.wingArea * aircraft.meanChord * pitchCoefficient;
  const rollMoment = dynamicPressure * aircraft.wingArea * aircraft.wingSpan * rollCoefficient;
  const yawMoment = dynamicPressure * aircraft.wingArea * aircraft.wingSpan * yawCoefficient;
  scratch.torqueBody.x = clamp(
    rollMoment,
    -aircraft.inertia.x * MAX_AERO_ANGULAR_ACCELERATION.x,
    aircraft.inertia.x * MAX_AERO_ANGULAR_ACCELERATION.x,
  );
  scratch.torqueBody.y = clamp(
    yawMoment,
    -aircraft.inertia.y * MAX_AERO_ANGULAR_ACCELERATION.y,
    aircraft.inertia.y * MAX_AERO_ANGULAR_ACCELERATION.y,
  );
  scratch.torqueBody.z = clamp(
    pitchMoment,
    -aircraft.inertia.z * MAX_AERO_ANGULAR_ACCELERATION.z,
    aircraft.inertia.z * MAX_AERO_ANGULAR_ACCELERATION.z,
  );

  const wasOnGround = state.onGround;
  const contactPossible = couldReachTerrain(state, environment, aircraft);
  if (contactPossible) {
    const currentAirframeImpact = airframeImpactSpeed(
      state,
      environment,
      aircraft,
      scratch,
    );
    state.peakImpactSpeed = Math.max(state.peakImpactSpeed, currentAirframeImpact);
    const unsupportedRetractableGearContact =
      aircraft.retractableGear &&
      !gearDownAndLocked(aircraft, state.actuators.gear) &&
      scratch.airframeContact;
    if (unsupportedRetractableGearContact || state.peakImpactSpeed > CRASH_IMPACT_SPEED) {
      settleCrashedState(state, environment, aircraft, scratch, dt, true);
      return;
    }
  }
  const contactCount = contactPossible
    ? applyGroundForces(state, environment, aircraft, scratch)
    : 0;
  state.onGround = contactCount > 0;
  const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
  if (contactCount >= 2) {
    // Tyres provide considerable static resistance to weathercocking. Purely
    // velocity-based friction lets a parked aircraft rotate in a crosswind
    // before the contact model can react, so blend in low-speed yaw grip.
    const yawGrip = clamp(1 - groundSpeed / 18, 0, 1);
    if (groundSpeed < 1.2 && Math.abs(state.actuators.yaw) < 0.05) {
      scratch.torqueBody.y = 0;
    } else {
      scratch.torqueBody.y *= 1 - yawGrip * 0.86;
    }
    scratch.torqueBody.y -=
      state.angularVelocity.y * aircraft.inertia.y * (3.5 + yawGrip * 8.5);
  }
  const parked =
    (contactCount > 0 || wasOnGround) &&
    groundSpeed < 0.65 &&
    state.actuators.throttle < 0.02 &&
    Math.abs(state.actuators.pitch) < 0.05 &&
    Math.abs(state.actuators.roll) < 0.05 &&
    Math.abs(state.actuators.yaw) < 0.05;
  if (parked) {
    // Static tyre friction cancels modest wind loads until the pilot adds
    // power or steering. Keep the lock across a one-step suspension gap so a
    // gust cannot turn spring jitter into an artificial parked tip-over.
    state.onGround = true;
    state.velocity.x = 0;
    state.velocity.z = 0;
    state.angularVelocity.x *= 0.82;
    state.angularVelocity.y *= 0.82;
    state.angularVelocity.z *= 0.82;
    scratch.forceWorld.x = 0;
    scratch.forceWorld.z = 0;
    scratch.torqueBody.x = 0;
    scratch.torqueBody.y = 0;
    scratch.torqueBody.z = 0;
  }
  if (state.peakImpactSpeed > CRASH_IMPACT_SPEED) {
    settleCrashedState(state, environment, aircraft, scratch, dt, true);
    return;
  }

  const inverseMass = 1 / aircraft.mass;
  state.velocity.x += scratch.forceWorld.x * inverseMass * dt;
  state.velocity.y += scratch.forceWorld.y * inverseMass * dt;
  state.velocity.z += scratch.forceWorld.z * inverseMass * dt;
  state.position.x += state.velocity.x * dt;
  state.position.y += state.velocity.y * dt;
  state.position.z += state.velocity.z * dt;

  // Euler's rigid-body equation for diagonal body inertia.
  const omega = state.angularVelocity;
  const angularMomentumX = aircraft.inertia.x * omega.x;
  const angularMomentumY = aircraft.inertia.y * omega.y;
  const angularMomentumZ = aircraft.inertia.z * omega.z;
  const gyroscopicX = omega.y * angularMomentumZ - omega.z * angularMomentumY;
  const gyroscopicY = omega.z * angularMomentumX - omega.x * angularMomentumZ;
  const gyroscopicZ = omega.x * angularMomentumY - omega.y * angularMomentumX;
  omega.x += ((scratch.torqueBody.x - gyroscopicX) / aircraft.inertia.x) * dt;
  omega.y += ((scratch.torqueBody.y - gyroscopicY) / aircraft.inertia.y) * dt;
  omega.z += ((scratch.torqueBody.z - gyroscopicZ) / aircraft.inertia.z) * dt;

  // q_dot = 1/2 * q * omega_body.
  const orientation = state.orientation;
  const halfDt = 0.5 * dt;
  const qx = orientation.x;
  const qy = orientation.y;
  const qz = orientation.z;
  const qw = orientation.w;
  orientation.x += halfDt * (qw * omega.x + qy * omega.z - qz * omega.y);
  orientation.y += halfDt * (qw * omega.y - qx * omega.z + qz * omega.x);
  orientation.z += halfDt * (qw * omega.z + qx * omega.y - qy * omega.x);
  orientation.w += halfDt * (-qx * omega.x - qy * omega.y - qz * omega.z);
  normalizeQuaternionInto(orientation, orientation);
  if (
    contactPossible &&
    scratch.maximumGroundPenetration > MAX_GEAR_COMPRESSION
  ) {
    projectOutOfTerrain(state, environment, aircraft, scratch);
  }

  const targetRpm =
    aircraft.idleRpm + state.actuators.throttle * (aircraft.maxRpm - aircraft.idleRpm);
  state.engineRpm = moveToward(state.engineRpm, targetRpm, dt * 1_500);
  state.time += dt;
  state.dynamics.angleOfAttack = angleOfAttack;
  state.dynamics.sideslip = sideslip;
  state.dynamics.airspeed = airspeed;
  state.dynamics.airDensity = airDensity;
  state.dynamics.liftCoefficient = liftCoefficient;
  state.dynamics.dragCoefficient = dragCoefficient;
  state.dynamics.liftForce = liftForce;
  state.dynamics.dragForce = dragForce;
  state.dynamics.thrustForce = thrustForce;
  state.dynamics.sideForce = sideForce;
  state.dynamics.loadFactor = liftForce / Math.max(1, aircraft.mass * gravity);
  state.dynamics.contactCount = contactCount;
  state.dynamics.totalForceWorld.x = scratch.forceWorld.x;
  state.dynamics.totalForceWorld.y = scratch.forceWorld.y;
  state.dynamics.totalForceWorld.z = scratch.forceWorld.z;
  sanitizeState(state);
}

function advanceState(
  state: FlightState,
  dt: number,
  requestedControls: Partial<FlightControls> | undefined,
  environment: EnvironmentInput,
  aircraft: AircraftDefinition,
  scratch: Scratch,
): FlightState {
  if (!Number.isFinite(dt) || dt <= 0) return state;
  const duration = Math.min(dt, MAX_STEP_DURATION);
  const controls = normalizeControlsInto(scratch.controls, requestedControls);
  let remaining = duration;
  while (remaining > 1e-10) {
    const substep = Math.min(FIXED_TIME_STEP, remaining);
    integrateSubstep(state, controls, environment, aircraft, substep, scratch);
    remaining -= substep;
  }
  return state;
}

/**
 * Advances a state in place. Long frame durations are capped and subdivided at
 * 120 Hz so results do not depend on render cadence.
 */
export function stepFlight(
  state: FlightState,
  dt = FIXED_TIME_STEP,
  controls: Partial<FlightControls> = DEFAULT_CONTROLS,
  environment: EnvironmentInput = DEFAULT_ENVIRONMENT,
  aircraft: AircraftDefinition = LIGHT_TRAINER,
): FlightState {
  return advanceState(state, dt, controls, environment, aircraft, createScratch());
}

export function getFlightTelemetry(
  state: FlightState,
  environment: EnvironmentInput = DEFAULT_ENVIRONMENT,
  aircraft: AircraftDefinition = LIGHT_TRAINER,
): FlightTelemetry {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  rotateVectorInto(forward, state.orientation, BODY_FORWARD);
  rotateVectorInto(right, state.orientation, BODY_RIGHT);
  rotateVectorInto(up, state.orientation, BODY_UP);
  const altitudeAgl = state.crashed
    ? 0
    : gearClearanceAboveTerrain(state, environment, aircraft);
  const airDensity = Math.max(0.001, state.dynamics.airDensity);
  const equivalentAirspeed = state.dynamics.airspeed * Math.sqrt(airDensity / SEA_LEVEL_DENSITY);
  // Angle of attack and sideslip are undefined when the relative airflow is
  // only a few knots. Suppress wind/turbulence-driven 90-degree instrument
  // readings while parked; the force model still uses the full velocity.
  const hasReliableAirflow = state.dynamics.airspeed >= 8;
  const displayedAngleOfAttack = hasReliableAirflow ? state.dynamics.angleOfAttack : 0;
  const displayedSideslip = hasReliableAirflow ? state.dynamics.sideslip : 0;
  const stallAngle =
    displayedAngleOfAttack >= 0
      ? aircraft.positiveStallAngle
      : Math.abs(aircraft.negativeStallAngle);
  const angleMagnitude = Math.abs(displayedAngleOfAttack);

  return {
    airspeed: state.dynamics.airspeed,
    indicatedAirspeed: equivalentAirspeed,
    groundSpeed: Math.hypot(state.velocity.x, state.velocity.z),
    verticalSpeed: state.velocity.y,
    altitude: state.position.y,
    altitudeAgl,
    heading: wrapAngle(Math.atan2(forward.x, forward.z)),
    pitch: Math.asin(clamp(forward.y, -1, 1)),
    bank: Math.atan2(-right.y, up.y),
    angleOfAttack: displayedAngleOfAttack,
    sideslip: displayedSideslip,
    loadFactor: state.dynamics.loadFactor,
    stallMargin: stallAngle - angleMagnitude,
    isStalled: hasReliableAirflow && angleMagnitude >= stallAngle,
    onGround: state.onGround,
    crashed: state.crashed,
    engineRpm: state.engineRpm,
  };
}

export function getFlightSnapshot(
  state: FlightState,
  environment: EnvironmentInput = DEFAULT_ENVIRONMENT,
  aircraft: AircraftDefinition = LIGHT_TRAINER,
): FlightSnapshot {
  return {
    time: state.time,
    position: { ...state.position },
    velocity: { ...state.velocity },
    orientation: { ...state.orientation },
    angularVelocity: { ...state.angularVelocity },
    actuators: { ...state.actuators },
    engineRpm: state.engineRpm,
    onGround: state.onGround,
    crashed: state.crashed,
    telemetry: getFlightTelemetry(state, environment, aircraft),
  };
}

export interface FlightSimulatorOptions {
  aircraft?: AircraftDefinition;
  spawn?: SpawnOptions;
  controls?: Partial<FlightControls>;
  environment?: EnvironmentInput;
}

/** Stateful, allocation-light facade intended for a simulation worker. */
export class FlightSimulator {
  readonly aircraft: AircraftDefinition;
  state: FlightState;
  controls: FlightControls;
  environment: EnvironmentInput;
  readonly #scratch = createScratch();

  constructor(options: FlightSimulatorOptions = {}) {
    this.aircraft = options.aircraft ?? LIGHT_TRAINER;
    const initialControls = options.controls ?? options.spawn?.controls;
    this.controls = normalizedControls(initialControls);
    if (
      this.aircraft.retractableGear &&
      options.spawn?.onGround !== true &&
      initialControls?.gear === undefined
    ) {
      this.controls.gear = 0;
    }
    this.environment = options.environment ?? DEFAULT_ENVIRONMENT;
    this.state = createFlightState(
      { ...options.spawn, controls: this.controls },
      this.aircraft,
    );
  }

  reset(spawn: SpawnOptions = {}): FlightState {
    this.controls = normalizedControls(spawn.controls ?? this.controls);
    this.state = createFlightState({ ...spawn, controls: this.controls }, this.aircraft);
    return this.state;
  }

  setControls(controls: Partial<FlightControls>): void {
    this.controls = normalizedControls({ ...this.controls, ...controls });
  }

  setEnvironment(environment: EnvironmentInput): void {
    this.environment = environment;
  }

  step(
    dt = FIXED_TIME_STEP,
    controls?: Partial<FlightControls>,
    environment?: EnvironmentInput,
  ): FlightState {
    if (controls) this.setControls(controls);
    if (environment) this.environment = environment;
    return advanceState(
      this.state,
      dt,
      this.controls,
      this.environment,
      this.aircraft,
      this.#scratch,
    );
  }

  telemetry(): FlightTelemetry {
    return getFlightTelemetry(this.state, this.environment, this.aircraft);
  }

  snapshot(): FlightSnapshot {
    return getFlightSnapshot(this.state, this.environment, this.aircraft);
  }
}
