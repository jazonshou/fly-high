import { describe, expect, it } from "vitest";
import {
  aircraftDefinition,
  AIRCRAFT_KINDS,
  applyFlightAssistance,
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  NOSEWHEEL_STEERING_LATERAL_LIMIT,
  nosewheelSteeringAngle,
  steeringCommand,
  STANDARD_GRAVITY,
  type AircraftKind,
  type FlightControls,
} from "../src/sim";

/**
 * GROUND HANDLING (Jason, 2026-10-25): "a and d should control the left right
 * steering on the plane when it's on the ground", and "sometimes when I brake
 * on the ground, the plane slows down but still creeps for a while until it
 * finally stops ... make the braking more definitive".
 *
 * Measured before the change, on a flat dry runway: full brakes took a 747 30 s
 * to stop from 10 m/s, 12 of them under 2 m/s, and with the throttle left at
 * 5% the F-16, the Global and the 747 never stopped at all (0.17, 0.37 and
 * 2.5 m/s for ever); A/D did nothing on the ground; and the 747's full
 * steering turned it on a 600 m circle where its geometry gives 120 m. These
 * pin the replacements: friction brakes on the main gear and a brake hold,
 * load-scaled cornering, and a nosewheel that the roll axis steers on the
 * ground, its authority fading with speed below what would tip the
 * aeroplane over.
 */

const DRY = { height: 0, normal: { x: 0, y: 1, z: 0 }, friction: 1 } as const;
const STILL = { x: 0, y: 0, z: 0 } as const;
const DEG = Math.PI / 180;

function rolling(kind: AircraftKind, speed: number): FlightSimulator {
  const controls = { ...DEFAULT_CONTROLS, throttle: 0 };
  return new FlightSimulator({
    aircraft: aircraftDefinition(kind),
    spawn: { onGround: true, terrainHeight: 0, heading: 0, airspeed: speed, controls },
    controls,
    environment: { terrain: DRY, wind: STILL },
  });
}

function groundSpeed(sim: FlightSimulator): number {
  return Math.hypot(sim.state.velocity.x, sim.state.velocity.z);
}

/** Signed change of the simulator heading, wrapped: NEGATIVE is a right turn (D-6). */
function headingChange(sim: FlightSimulator, from: number): number {
  const delta = sim.telemetry().heading - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

describe("wheel brakes", () => {
  for (const kind of AIRCRAFT_KINDS) {
    it(`stop the ${kind} decisively, and hold it against a lever left open`, () => {
      for (const throttle of [0, 0.05]) {
        const sim = rolling(kind, 30);
        const controls: FlightControls = { ...DEFAULT_CONTROLS, throttle, brake: 1 };
        let time = 0;
        let underTwo = Number.NaN;
        while (time < 30 && groundSpeed(sim) > 0) {
          sim.step(FIXED_TIME_STEP, controls);
          time += FIXED_TIME_STEP;
          if (Number.isNaN(underTwo) && groundSpeed(sim) < 2) underTwo = time;
        }
        const label = `${kind} at throttle ${throttle}`;
        // A friction brake decelerates at about 0.4-0.6 g to the end, so
        // 30 m/s takes under 8 s and the last 2 m/s well under a second.
        expect(time, label).toBeLessThan(8);
        expect(time - underTwo, label).toBeLessThan(0.6);
        // Then it stays stopped: no creep against the open lever.
        for (let step = 0; step < 600; step += 1) sim.step(FIXED_TIME_STEP, controls);
        expect(groundSpeed(sim), label).toBe(0);
        expect(sim.state.crashed, label).toBe(false);
      }
    });
  }

  it("brake on the main gear only, so the nosewheel still steers under full braking", () => {
    // The 747 is the case that failed: braked, its tyres were an isotropic
    // damper and steering barely bent the track (0.3 degrees from 15 m/s).
    const sim = rolling("airliner", 15);
    const start = sim.telemetry().heading;
    const controls = { ...DEFAULT_CONTROLS, throttle: 0, brake: 1, roll: 1 };
    for (let step = 0; step < 4 / FIXED_TIME_STEP && groundSpeed(sim) > 0; step += 1) {
      sim.step(FIXED_TIME_STEP, controls);
    }
    expect(groundSpeed(sim)).toBe(0);
    expect(headingChange(sim, start)).toBeLessThan(-6 * DEG);
  });

  it("let the aeroplane go once released against power", () => {
    const sim = rolling("airliner", 0);
    for (let step = 0; step < 240; step += 1) sim.step(FIXED_TIME_STEP, { ...DEFAULT_CONTROLS, throttle: 0.3, brake: 1 });
    expect(groundSpeed(sim)).toBe(0);
    for (let step = 0; step < 600; step += 1) sim.step(FIXED_TIME_STEP, { ...DEFAULT_CONTROLS, throttle: 0.3, brake: 0 });
    expect(groundSpeed(sim)).toBeGreaterThan(2);
  });
});

describe("ground steering", () => {
  it("adds the roll axis to the pedals as a tiller, clamped to full travel", () => {
    expect(steeringCommand({ ...DEFAULT_CONTROLS, roll: 1 })).toBe(1);
    expect(steeringCommand({ ...DEFAULT_CONTROLS, roll: -0.4, yaw: -0.2 })).toBeCloseTo(-0.6, 12);
    expect(steeringCommand({ ...DEFAULT_CONTROLS, roll: 1, yaw: 1 })).toBe(1);
    expect(steeringCommand({ ...DEFAULT_CONTROLS, roll: 0.5, yaw: -0.5 })).toBe(0);
  });

  it("fades the nosewheel's authority with speed", () => {
    const aircraft = aircraftDefinition("airliner");
    const max = aircraft.gear.find((leg) => leg.maxSteeringAngle)!.maxSteeringAngle!;
    expect(nosewheelSteeringAngle(aircraft, max, 1, 3)).toBe(max);
    expect(nosewheelSteeringAngle(aircraft, max, -1, 3)).toBe(-max);
    const fast = nosewheelSteeringAngle(aircraft, max, 1, 60);
    expect(fast).toBeGreaterThan(0.5 * DEG);
    expect(fast).toBeLessThan(2 * DEG);
    // v^2 tan(angle) / wheelbase: the limit, at 60 m/s on a 25.6 m wheelbase.
    expect((60 * 60 * Math.tan(fast)) / 25.6).toBeCloseTo(NOSEWHEEL_STEERING_LATERAL_LIMIT, 6);
  });

  for (const kind of AIRCRAFT_KINDS) {
    it(`steers the ${kind} with A/D at taxi speed, on the circle its geometry gives`, () => {
      const aircraft = aircraftDefinition(kind);
      const nose = aircraft.gear.find((leg) => leg.maxSteeringAngle)!;
      const mainX = aircraft.gear.filter((leg) => !leg.maxSteeringAngle)
        .reduce((sum, leg, _, legs) => sum + leg.position.x / legs.length, 0);
      const geometric = (nose.position.x - mainX) / Math.tan(nose.maxSteeringAngle!);
      for (const roll of [1, -1]) {
        const sim = rolling(kind, 5);
        const start = sim.telemetry().heading;
        for (let step = 0; step < 3 / FIXED_TIME_STEP; step += 1) {
          sim.step(FIXED_TIME_STEP, { ...DEFAULT_CONTROLS, throttle: 0, roll });
        }
        const turned = headingChange(sim, start);
        const label = `${kind} roll ${roll}`;
        // D steers right (heading falls), A left.
        expect(Math.sign(turned), label).toBe(-roll);
        // The yaw rate at the end against the geometric rate v / R.
        const rate = Math.abs(sim.state.angularVelocity.y);
        expect(rate, label).toBeGreaterThan(0.6 * groundSpeed(sim) / geometric);
        expect(rate, label).toBeLessThan(1.3 * groundSpeed(sim) / geometric);
        expect(sim.state.crashed, label).toBe(false);
      }
    });

    it(`keeps the ${kind}'s full A/D at 40 m/s a gentle turn that cannot tip it`, () => {
      const sim = rolling(kind, 40);
      const start = sim.telemetry().heading;
      let peakLateral = 0;
      let lastTrack = 0;
      let peakBank = 0;
      for (let step = 0; step < 3 / FIXED_TIME_STEP; step += 1) {
        sim.step(FIXED_TIME_STEP, { ...DEFAULT_CONTROLS, throttle: 0, roll: 1 });
        const track = Math.atan2(sim.state.velocity.x, sim.state.velocity.z);
        if (step > 0) peakLateral = Math.max(peakLateral, (Math.abs(track - lastTrack) / FIXED_TIME_STEP) * groundSpeed(sim));
        lastTrack = track;
        peakBank = Math.max(peakBank, Math.abs(sim.telemetry().bank));
      }
      expect(headingChange(sim, start), kind).toBeLessThan(-2 * DEG);
      expect(peakLateral, kind).toBeLessThan(NOSEWHEEL_STEERING_LATERAL_LIMIT + 0.05 * STANDARD_GRAVITY);
      expect(peakBank, kind).toBeLessThan(4 * DEG);
      expect(sim.state.dynamics.contactCount, kind).toBe(sim.aircraft.gear.length);
    });
  }

  it("leaves the roll axis to the ailerons in the air", () => {
    const sim = new FlightSimulator({
      aircraft: aircraftDefinition("trainer"),
      spawn: { position: { x: 0, y: 900, z: 0 }, heading: 0, airspeed: 45 },
      environment: { terrain: DRY, wind: STILL },
    });
    for (let step = 0; step < 60; step += 1) sim.step(FIXED_TIME_STEP, { ...DEFAULT_CONTROLS, roll: 1 });
    // Right wing down, as it always was; nothing here touches a nosewheel.
    expect(sim.telemetry().bank).toBeGreaterThan(3 * DEG);
  });
});

describe("Scenic's runway heading hold", () => {
  it("yields to steering on the roll axis as it does to the rudder", () => {
    const sim = rolling("trainer", 12);
    const telemetry = sim.telemetry();
    // Holding a heading 20 degrees to the left of the nose: the hold steers.
    const target = telemetry.heading + 20 * DEG;
    const out = { ...DEFAULT_CONTROLS };
    const held = applyFlightAssistance(out, "scenic", { ...DEFAULT_CONTROLS, throttle: 0 }, sim.state, telemetry, target);
    expect(held.yaw).toBeLessThan(-0.3);
    for (const steer of [{ roll: 0.6 }, { roll: -0.6 }, { yaw: 0.6 }]) {
      const requested = { ...DEFAULT_CONTROLS, throttle: 0, ...steer };
      const result = applyFlightAssistance({ ...DEFAULT_CONTROLS }, "scenic", requested, sim.state, telemetry, target);
      // The pilot's own input goes through untouched.
      expect(result.yaw, JSON.stringify(steer)).toBe(requested.yaw);
      expect(result.roll, JSON.stringify(steer)).toBe(requested.roll);
    }
  });
});
