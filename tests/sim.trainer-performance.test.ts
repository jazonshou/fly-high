import { describe, expect, it } from "vitest";
import {
  aircraftDefinition,
  FlightSimulator,
  LIGHT_TRAINER,
  type AircraftDefinition,
  type FlightControls,
} from "../src/sim";

/**
 * The Cessna 150's climb, and the reason it is allowed to be unfaithful.
 *
 * The real aeroplane climbs at 670 ft/min. This one climbs at about 1,050,
 * because against this world's 1,750-1,900 m mountains the faithful figure
 * made crossing a range a chore — the aeroplane read as getting worse rather
 * than the terrain getting better. Jason chose the deviation knowing the book
 * value; `LIGHT_TRAINER.maxStaticThrust` carries both numbers.
 *
 * **What makes that trade safe is the second test here, not the first.** The
 * argument for moving one number was that it moves ONLY the climb: stall,
 * approach and cruise come from the wing and the weights, and the propeller is
 * power-limited at high speed so the static-thrust cap never binds there. That
 * is an argument, and arguments rot. Flying it is what keeps it true — if
 * someone later raises the thrust to make the aeroplane climb better and the
 * approach speed moves with it, this fails and they find out at the moment
 * they still know why.
 */

const STEP = 1 / 120;
const environment = {
  terrain: { height: 0, normal: { x: 0, y: 1, z: 0 } },
  terrainHeight: () => 0,
  wind: { x: 0, y: 0, z: 0 },
};

function controls(overrides: Partial<FlightControls> = {}): FlightControls {
  return {
    throttle: 1,
    pitch: 0,
    roll: 0,
    yaw: 0,
    trim: 0,
    flaps: 0,
    brake: 0,
    gear: 1,
    ...overrides,
  };
}

function fly(
  aircraft: AircraftDefinition,
  altitude: number,
  airspeed: number,
  extra: Partial<FlightControls> = {},
): FlightSimulator {
  return new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: altitude, z: 0 },
      heading: 0,
      pitch: 0,
      airspeed,
      controls: controls(extra),
    },
    environment,
  });
}

/** Hold a pitch attitude, which is stable across every airframe and thrust. */
function holdAttitude(simulator: FlightSimulator, targetRadians: number): number {
  const error = targetRadians - simulator.telemetry().pitch;
  return Math.max(-1, Math.min(1, error * 3.2 - simulator.state.angularVelocity.z * 0.9));
}

/** Settled rate of climb at full power holding a pitch attitude. */
function climbAt(aircraft: AircraftDefinition, altitude: number, degrees: number): number {
  const simulator = fly(aircraft, altitude, 34);
  const target = (degrees * Math.PI) / 180;
  let total = 0;
  const steps = Math.round(90 / STEP);
  const settle = Math.round(60 / STEP);
  for (let step = 0; step < steps; step += 1) {
    simulator.setControls({ throttle: 1, pitch: holdAttitude(simulator, target) });
    simulator.step(STEP);
    if (step >= settle) total += simulator.telemetry().verticalSpeed;
  }
  return total / (steps - settle);
}

function bestClimb(aircraft: AircraftDefinition, altitude: number): number {
  let best = -Infinity;
  for (let degrees = 0; degrees <= 25; degrees += 2.5) {
    best = Math.max(best, climbAt(aircraft, altitude, degrees));
  }
  return best;
}

/** Speed at which the wing lets go, decelerating at idle from just above it. */
function stallSpeed(aircraft: AircraftDefinition, flaps: number): number {
  const simulator = fly(aircraft, 1_500, 30, { throttle: 0, flaps });
  let last = simulator.telemetry().airspeed;
  const settle = Math.round(4 / STEP);
  for (let step = 0; step < Math.round(240 / STEP); step += 1) {
    const pitch = Math.max(-0.6, Math.min(0.6, -simulator.telemetry().verticalSpeed * 0.25));
    simulator.setControls({ throttle: 0, flaps, pitch });
    simulator.step(STEP);
    if (step > settle && simulator.telemetry().isStalled) return last;
    last = simulator.telemetry().airspeed;
  }
  return Number.NaN;
}

/** Fastest it will fly level at full power, held on altitude rather than rate. */
function maximumLevelSpeed(aircraft: AircraftDefinition): number {
  const altitude = 1_000;
  const simulator = fly(aircraft, altitude, 50);
  for (let step = 0; step < Math.round(300 / STEP); step += 1) {
    const telemetry = simulator.telemetry();
    const error = simulator.state.position.y - altitude;
    const pitch = Math.max(-0.8, Math.min(0.8, -error * 0.004 - telemetry.verticalSpeed * 0.08));
    simulator.setControls({ throttle: 1, pitch });
    simulator.step(STEP);
  }
  return simulator.telemetry().airspeed;
}

describe("Cessna 150 performance", () => {
  it("ships the climb Jason chose, not the book one", () => {
    // 4.82 m/s by THIS method — an attitude sweep at 500 m, which reads a
    // little under the 5.34 m/s the airspeed-swept measurement gave when the
    // value was chosen, because a 2.5-degree attitude grid does not land
    // exactly on best-climb speed. The band is what matters: book-faithful
    // 1,200 N measures about 3.0 here and 2,000 N about 5.5, so this
    // distinguishes the choice that was made from both of its neighbours.
    const climb = bestClimb(LIGHT_TRAINER, 500);
    expect(climb).toBeGreaterThan(4.3);
    expect(climb).toBeLessThan(5.3);
  });

  it("still climbs usefully at mountain height", () => {
    // The whole reason for the deviation: a range at 1,750-1,900 m with cols
    // at 1,200-1,500 has to be crossable without circling.
    expect(bestClimb(LIGHT_TRAINER, 1_500)).toBeGreaterThan(3.2);
  });

  it("keeps stall and cruise independent of the thrust that sets the climb", () => {
    // The argument that let one number be changed in isolation, flown rather
    // than asserted. The propeller is power-limited at maximum speed
    // (74,600 W x 0.8 / 58.7 m/s = 1,017 N), which is below every cap here, so
    // the cap cannot reach the top end; and the stall is flown at idle, where
    // thrust is not in the problem at all.
    const book = { ...LIGHT_TRAINER, maxStaticThrust: 1_200 } as AircraftDefinition;
    const shipped = aircraftDefinition("trainer");
    const overpowered = { ...LIGHT_TRAINER, maxStaticThrust: 2_000 } as AircraftDefinition;

    for (const flaps of [0, 1]) {
      const reference = stallSpeed(shipped, flaps);
      expect(reference).toBeGreaterThan(0);
      expect(stallSpeed(book, flaps)).toBeCloseTo(reference, 6);
      expect(stallSpeed(overpowered, flaps)).toBeCloseTo(reference, 6);
    }

    const reference = maximumLevelSpeed(shipped);
    expect(maximumLevelSpeed(book)).toBeCloseTo(reference, 6);
    expect(maximumLevelSpeed(overpowered)).toBeCloseTo(reference, 6);

    // And the climb DOES move, or the test above is measuring nothing.
    expect(bestClimb(book, 500)).toBeLessThan(bestClimb(shipped, 500) - 1);
  });

  it("stalls where the type does", () => {
    // 48 kt clean and 42 flapped on the real aeroplane; 24.7 and 21.6 m/s.
    expect(stallSpeed(aircraftDefinition("trainer"), 0)).toBeGreaterThan(22);
    expect(stallSpeed(aircraftDefinition("trainer"), 0)).toBeLessThan(27);
    expect(stallSpeed(aircraftDefinition("trainer"), 1)).toBeGreaterThan(18.5);
    expect(stallSpeed(aircraftDefinition("trainer"), 1)).toBeLessThan(23);
  });
});
