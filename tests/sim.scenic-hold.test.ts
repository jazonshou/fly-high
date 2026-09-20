import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_KINDS,
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  SCENIC_HOLD_DEADBAND,
  SCENIC_HOLD_MIN_CLEARANCE,
  ScenicAltitudeHold,
  aircraftDefinition,
  applyFlightAssistance,
  stallSpeed,
  type AircraftKind,
  type EnvironmentInput,
  type FlightControls,
} from "../src/sim";
import { airborneAirspeedForAircraft, airborneThrottleForAircraft } from "../src/game/spawn";

/**
 * Scenic's centred stick holds height.
 *
 * Jason asked for this after the menu flight's climb was traced to the same
 * cause: `applyFlightAssistance` commands `2.5deg + stick * 14deg`, so letting
 * go of the stick in Scenic asked for 2.5 degrees nose-up, forever. His words:
 * *"Yes, hold height"*.
 *
 * Everything here is written KIND-AGNOSTIC over `AIRCRAFT_KINDS`, so the F-16
 * and 747-8 are tested by it the day they merge rather than the day someone
 * remembers. Every threshold is derived from the aeroplane's own numbers —
 * `stallSpeed()` and the catalogue's cruise — for the same reason.
 */

/** Flat ground far below, so nothing here is about terrain. */
const GROUND = 0;
const environment: EnvironmentInput = {
  terrain: () => ({ height: GROUND, friction: 0.86 }),
  terrainHeight: () => GROUND,
  seaLevel: GROUND,
};

interface FlightResult {
  readonly altitude: number;
  readonly verticalSpeed: number;
  readonly equivalentAirspeed: number;
  readonly minimumSpeedMargin: number;
  readonly maximumAltitude: number;
  readonly minimumAltitude: number;
}

/**
 * Flies one aeroplane through Scenic exactly as the worker does: the hold
 * writes the pitch axis, `applyFlightAssistance` flies it, nothing else moves.
 */
function fly(
  kind: AircraftKind,
  seconds: number,
  stickAt: (elapsed: number) => number,
  options: { readonly throttle?: number; readonly startAltitude?: number } = {},
): FlightResult {
  const aircraft = aircraftDefinition(kind);
  const startAltitude = options.startAltitude ?? 1_200;
  const throttle = options.throttle ?? airborneThrottleForAircraft(kind);
  const simulator = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: startAltitude, z: 0 },
      airspeed: airborneAirspeedForAircraft(kind),
    },
    controls: { throttle },
    environment,
  });
  const hold = new ScenicAltitudeHold();
  const requested: FlightControls = { ...DEFAULT_CONTROLS, throttle };
  const assisted: FlightControls = { ...DEFAULT_CONTROLS };
  let minimumSpeedMargin = Infinity;
  let maximumAltitude = -Infinity;
  let minimumAltitude = Infinity;

  const steps = Math.round(seconds / FIXED_TIME_STEP);
  for (let step = 0; step < steps; step += 1) {
    const telemetry = simulator.telemetry();
    const stick = stickAt(step * FIXED_TIME_STEP);
    requested.throttle = throttle;
    requested.pitch = hold.update({
      pitchStick: stick,
      onGround: simulator.state.onGround,
      clearance: telemetry.altitudeAgl,
      altitude: simulator.state.position.y,
      verticalSpeed: telemetry.verticalSpeed,
      equivalentAirspeed: telemetry.indicatedAirspeed,
      stallSpeed: stallSpeed(aircraft, simulator.state.actuators.flaps),
      dt: FIXED_TIME_STEP,
    });
    simulator.setControls(
      applyFlightAssistance(assisted, "scenic", requested, simulator.state, telemetry),
    );
    simulator.step(FIXED_TIME_STEP);
    const after = simulator.telemetry();
    minimumSpeedMargin = Math.min(
      minimumSpeedMargin,
      after.indicatedAirspeed / stallSpeed(aircraft, simulator.state.actuators.flaps),
    );
    maximumAltitude = Math.max(maximumAltitude, simulator.state.position.y);
    minimumAltitude = Math.min(minimumAltitude, simulator.state.position.y);
  }
  const final = simulator.telemetry();
  return {
    altitude: simulator.state.position.y,
    verticalSpeed: final.verticalSpeed,
    equivalentAirspeed: final.indicatedAirspeed,
    minimumSpeedMargin,
    maximumAltitude,
    minimumAltitude,
  };
}

describe.each(AIRCRAFT_KINDS)("Scenic hands-off in the %s", (kind) => {
  it("neither climbs nor descends", () => {
    // The whole request, in one assertion: hands off means level.
    const result = fly(kind, 60, () => 0);
    expect(Math.abs(result.verticalSpeed)).toBeLessThan(0.5);
  });

  it("settles quickly and then does not drift over five minutes", () => {
    const settle = fly(kind, 20, () => 0);
    expect(Math.abs(settle.verticalSpeed), "settled within 20 s").toBeLessThan(0.5);
    const long = fly(kind, 300, () => 0);
    // Drift is measured against where it STARTED, over the whole five minutes.
    expect(Math.abs(long.altitude - 1_200), "drift over 5 min").toBeLessThan(15);
    expect(long.maximumAltitude - long.minimumAltitude, "excursion over 5 min")
      .toBeLessThan(40);
  });

  it("levels off where the climb ended, and does not fly back down", () => {
    // Pull for 20 s, release, and let it settle. The aeroplane must stay up
    // where it got to -- "let go" does not mean "undo".
    const climbSeconds = 20;
    const result = fly(kind, climbSeconds + 90, (t) => (t < climbSeconds ? 0.5 : 0));
    expect(result.altitude, "ended above where it started").toBeGreaterThan(1_200 + 20);
    expect(Math.abs(result.verticalSpeed), "levelled off").toBeLessThan(0.6);
    // It may coast up a little after release; it must not sag back toward the
    // height it left. The floor is generous, the point is the DIRECTION.
    expect(result.altitude).toBeGreaterThan(result.maximumAltitude - 120);
    expect(result.minimumAltitude).toBeGreaterThan(1_190);
  });

  it("pushes over and levels off lower, symmetrically", () => {
    const result = fly(kind, 110, (t) => (t < 20 ? -0.5 : 0));
    expect(result.altitude).toBeLessThan(1_200 - 20);
    expect(Math.abs(result.verticalSpeed)).toBeLessThan(0.6);
  });

  it("gives up height rather than airspeed at idle", () => {
    // Hands off with the engine at idle must end in a stable descent, never a
    // mush. The margin is over the aeroplane's OWN stall speed.
    const result = fly(kind, 180, () => 0, { throttle: 0, startAltitude: 3_000 });
    expect(result.minimumSpeedMargin, "never slower than 1.1x stall").toBeGreaterThan(1.1);
    expect(result.altitude, "descended").toBeLessThan(3_000);
    expect(result.verticalSpeed, "descending, not falling").toBeGreaterThan(-25);
  });
});

describe("the hold stays out of the way where it should", () => {
  it("passes the stick through untouched on the ground and through rotation", () => {
    // A runway start must rotate exactly as it did before this existed, so on
    // the ground and below the engagement height the hold is the identity.
    const hold = new ScenicAltitudeHold();
    const base = {
      altitude: 100,
      verticalSpeed: 0,
      equivalentAirspeed: 40,
      stallSpeed: 22,
      dt: FIXED_TIME_STEP,
    };
    for (const stick of [-1, -0.4, 0, 0.4, 1]) {
      expect(hold.update({ ...base, pitchStick: stick, onGround: true, clearance: 0 }))
        .toBe(stick);
      expect(hold.update({
        ...base,
        pitchStick: stick,
        onGround: false,
        clearance: SCENIC_HOLD_MIN_CLEARANCE - 1,
      })).toBe(stick);
      expect(hold.holdingAltitude).toBeNull();
    }
  });

  it("does not step when the stick leaves and returns to centre", () => {
    // Both sides of the deadband are the same expression, learnedTrim + stick,
    // which is what makes this true rather than a tuning coincidence.
    const hold = new ScenicAltitudeHold();
    const base = {
      onGround: false,
      clearance: 1_200,
      altitude: 1_200,
      verticalSpeed: 0,
      equivalentAirspeed: 56,
      stallSpeed: 22,
      dt: FIXED_TIME_STEP,
    };
    // Let it learn a trim against a persistent climb it is trying to cancel.
    for (let step = 0; step < 1_200; step += 1) {
      hold.update({ ...base, pitchStick: 0, verticalSpeed: 1.5 });
    }
    const centred = hold.update({ ...base, pitchStick: 0 });
    const nudged = hold.update({ ...base, pitchStick: SCENIC_HOLD_DEADBAND * 2 });
    // Crossing out of the deadband adds the stick and nothing else.
    expect(nudged - centred).toBeCloseTo(SCENIC_HOLD_DEADBAND * 2, 2);
    const backAgain = hold.update({ ...base, pitchStick: 0 });
    expect(backAgain).toBeCloseTo(centred, 2);
  });

  it("forgets a captured height once the pilot flies again", () => {
    const hold = new ScenicAltitudeHold();
    const base = {
      onGround: false,
      clearance: 1_200,
      altitude: 1_200,
      verticalSpeed: 0,
      equivalentAirspeed: 56,
      stallSpeed: 22,
      dt: FIXED_TIME_STEP,
    };
    for (let step = 0; step < 600; step += 1) hold.update({ ...base, pitchStick: 0 });
    expect(hold.holdingAltitude).not.toBeNull();
    hold.update({ ...base, pitchStick: 0.5 });
    expect(hold.holdingAltitude).toBeNull();
  });
});
