import { FlightSimulator } from "../../src/sim/simulation";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../../src/game/types";

/**
 * A `FlightVisualState` built from a REAL simulator the way the simulation
 * worker builds it (`visualState()` in `src/workers/simulation.worker.ts`).
 *
 * WHY THIS IS A COPY, AND HOW IT IS KEPT HONEST. The worker's function cannot be
 * imported (it is module-private in a file that installs `onmessage`), and the
 * point of a ground-truth test is to hold a number to the simulator, not to a
 * re-derivation of it. So the conversions live here once, with the worker's own
 * lines quoted, and `tests/simulation-client-attitude.test.ts` scans the worker's
 * source for each of them: if the worker changes a unit, that test fails and
 * this file has to be updated with it. The units, as the code states them:
 *
 *  - airspeed: m/s, EQUIVALENT airspeed (`telemetry.indicatedAirspeed`)
 *  - altitude: metres above the world's sea level (`telemetry.altitude`)
 *  - altitudeAgl: metres, lowest gear contact above the surface
 *  - verticalSpeed: m/s, +up
 *  - heading, pitch, bank: DEGREES here, radians in the telemetry;
 *    pitch +nose up, bank +right wing down
 *  - engineRpm: prop RPM on the trainer, percent on the jets
 */
export function visualStateFromSimulator(simulator: FlightSimulator): FlightVisualState {
  const snapshot = simulator.snapshot();
  const telemetry = snapshot.telemetry;
  return {
    ...INITIAL_VISUAL_STATE,
    position: { ...snapshot.position },
    velocity: { ...snapshot.velocity },
    orientation: { ...snapshot.orientation },
    angularVelocity: { ...snapshot.angularVelocity },
    airspeed: telemetry.indicatedAirspeed,
    altitudeAgl: telemetry.altitudeAgl,
    altitude: telemetry.altitude,
    verticalSpeed: telemetry.verticalSpeed,
    heading: (telemetry.heading * 180) / Math.PI,
    pitch: (telemetry.pitch * 180) / Math.PI,
    bank: (telemetry.bank * 180) / Math.PI,
    angleOfAttack: (telemetry.angleOfAttack * 180) / Math.PI,
    sideslip: (telemetry.sideslip * 180) / Math.PI,
    throttle: snapshot.actuators.throttle,
    engineRpm: snapshot.engineRpm,
    elevator: snapshot.actuators.pitch,
    aileron: snapshot.actuators.roll,
    rudder: snapshot.actuators.yaw,
    brake: snapshot.actuators.brake,
    trim: snapshot.actuators.trim,
    flaps: snapshot.actuators.flaps,
    gear: snapshot.actuators.gear,
    loadFactor: telemetry.loadFactor,
    onGround: snapshot.onGround,
    stalled: telemetry.isStalled,
    crashed: snapshot.crashed,
    simulationTime: snapshot.time,
  };
}

/** A simulator spawned at the given attitude, in DEGREES, high above flat ground, and its visual state. */
export function flyAt(
  headingDegrees: number,
  pitchDegrees: number,
  bankDegrees: number,
  extra: { airspeed?: number; altitude?: number } = {},
): { simulator: FlightSimulator; state: FlightVisualState } {
  const simulator = new FlightSimulator({
    spawn: {
      position: { x: 0, y: extra.altitude ?? 1_500, z: 0 },
      heading: (headingDegrees * Math.PI) / 180,
      pitch: (pitchDegrees * Math.PI) / 180,
      bank: (bankDegrees * Math.PI) / 180,
      airspeed: extra.airspeed ?? 60,
    },
  });
  return { simulator, state: visualStateFromSimulator(simulator) };
}
