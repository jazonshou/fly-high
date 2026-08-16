import { describe, expect, it } from "vitest";
import {
  applyFlightAssistance,
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FIXED_TIME_STEP,
  FlightSimulator,
  quaternionFromFlightAngles,
  type FlightControls,
  type StabilityAssistMode,
} from "../src/sim";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const RUNWAY = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  friction: 1.15,
} as const;

function advance(
  simulator: FlightSimulator,
  seconds: number,
  controls: (simulator: FlightSimulator) => FlightControls,
): void {
  for (let step = 0; step < Math.round(seconds / FIXED_TIME_STEP); step += 1) {
    simulator.step(FIXED_TIME_STEP, controls(simulator));
  }
}

function assisted(
  simulator: FlightSimulator,
  mode: StabilityAssistMode,
  requested: FlightControls,
): FlightControls {
  return applyFlightAssistance(
    { ...DEFAULT_CONTROLS },
    mode,
    requested,
    simulator.state,
    simulator.telemetry(),
  );
}

describe("rebuilt light-trainer handling", () => {
  it("passes every direct control through without attitude limits or auto-level", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 900, z: 0 },
        pitch: 38 * DEG_TO_RAD,
        bank: 82 * DEG_TO_RAD,
        airspeed: 52,
        angularVelocity: { x: 1.4, y: -0.8, z: 1.1 },
      },
    });
    const requested: FlightControls = {
      throttle: 0.83,
      pitch: 1,
      roll: -1,
      yaw: 0.91,
      trim: -0.24,
      flaps: 0.5,
      brake: 0.37,
    };

    const direct = assisted(simulator, "unassisted", requested);
    const scenic = assisted(simulator, "scenic", requested);

    expect(direct).toEqual(requested);
    expect(direct.pitch).toBe(1);
    expect(direct.roll).toBe(-1);
    expect(scenic.pitch).not.toBe(direct.pitch);
    expect(scenic.roll).not.toBe(direct.roll);
  });

  it("leaves neutral Direct flight raw until the pilot commands and releases pitch", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 1_500, z: 0 },
        pitch: 18 * DEG_TO_RAD,
        airspeed: 54,
        angularVelocity: { x: 0.2, y: -0.1, z: 0.65 },
      },
    });
    const retention = new DirectPitchRetention();
    const neutral = { ...DEFAULT_CONTROLS, throttle: 0.58 };

    expect(retention.apply(
      { ...neutral },
      neutral,
      simulator.state,
      simulator.telemetry(),
    )).toEqual(neutral);
    expect(retention.isArmed).toBe(false);

    const active = {
      ...neutral,
      pitch: -1,
      roll: 0.72,
      yaw: -0.43,
      trim: -0.2,
      flaps: 0.5,
      brake: 0.25,
    };
    expect(retention.apply(
      assisted(simulator, "unassisted", active),
      active,
      simulator.state,
      simulator.telemetry(),
    )).toEqual(active);
    expect(retention.isArmed).toBe(false);

    retention.apply({ ...neutral }, neutral, simulator.state, simulator.telemetry());
    expect(retention.isArmed).toBe(true);
    retention.reset();
    expect(retention.isArmed).toBe(false);
    expect(retention.apply(
      { ...neutral },
      neutral,
      simulator.state,
      simulator.telemetry(),
    )).toEqual(neutral);
  });

  it("allocates retained pitch with the correct sign upright and inverted", () => {
    const retainedCommand = (bank: number): number => {
      const simulator = new FlightSimulator({
        spawn: {
          position: { x: 0, y: 2_500, z: 0 },
          pitch: -20 * DEG_TO_RAD,
          bank,
          airspeed: 56,
          controls: { ...DEFAULT_CONTROLS, throttle: 0.58 },
        },
      });
      const retention = new DirectPitchRetention();
      const neutral = { ...DEFAULT_CONTROLS, throttle: 0.58 };
      const active = { ...neutral, pitch: -0.4 };
      retention.apply({ ...active }, active, simulator.state, simulator.telemetry());
      retention.apply({ ...neutral }, neutral, simulator.state, simulator.telemetry());
      simulator.state.orientation = quaternionFromFlightAngles(
        0,
        -10 * DEG_TO_RAD,
        bank,
      );
      simulator.state.angularVelocity.x = 0;
      simulator.state.angularVelocity.y = 0;
      simulator.state.angularVelocity.z = 0;
      return retention.apply(
        { ...neutral },
        neutral,
        simulator.state,
        simulator.telemetry(),
      ).pitch;
    };

    // The same world-pitch error needs opposite elevator across inversion.
    expect(retainedCommand(0)).toBeLessThan(0);
    expect(retainedCommand(Math.PI)).toBeGreaterThan(0);
  });

  it("stays finite at knife-edge and through the vertical Euler singularity", () => {
    for (const bank of [89.999 * DEG_TO_RAD, -89.999 * DEG_TO_RAD, Math.PI]) {
      for (const pitch of [-90, -89.999, 89.999, 90].map((value) => value * DEG_TO_RAD)) {
        const simulator = new FlightSimulator({
          spawn: {
            position: { x: 0, y: 3_000, z: 0 },
            pitch,
            bank,
            airspeed: 58,
          },
        });
        const retention = new DirectPitchRetention();
        const neutral = { ...DEFAULT_CONTROLS, throttle: 0.6 };
        const active = { ...neutral, pitch: 0.5 };
        retention.apply({ ...active }, active, simulator.state, simulator.telemetry());
        retention.apply({ ...neutral }, neutral, simulator.state, simulator.telemetry());
        simulator.state.angularVelocity.z = 1.4;
        const result = retention.apply(
          { ...neutral },
          neutral,
          simulator.state,
          simulator.telemetry(),
        );
        expect(Number.isFinite(result.pitch)).toBe(true);
        expect(Math.abs(result.pitch)).toBeLessThanOrEqual(0.72);
        expect(result.pitch).toBeLessThan(0);
      }
    }
  });

  it("moves the retained target with trim in the physically signed direction", () => {
    const trimmedTarget = (bank: number): { before: number; after: number; pitch: number } => {
      const simulator = new FlightSimulator({
        spawn: {
          position: { x: 0, y: 2_000, z: 0 },
          pitch: 0,
          bank,
          airspeed: 55,
        },
      });
      const retention = new DirectPitchRetention();
      const neutral = { ...DEFAULT_CONTROLS, throttle: 0.56, trim: 0 };
      const active = { ...neutral, pitch: 0.35 };
      retention.apply({ ...active }, active, simulator.state, simulator.telemetry());
      retention.apply({ ...neutral }, neutral, simulator.state, simulator.telemetry());
      const before = retention.noseVerticalTarget ?? Number.NaN;
      const trimmed = { ...neutral, trim: 0.04 };
      const result = retention.apply(
        { ...trimmed },
        trimmed,
        simulator.state,
        simulator.telemetry(),
      );
      return {
        before,
        after: retention.noseVerticalTarget ?? Number.NaN,
        pitch: result.pitch,
      };
    };

    const upright = trimmedTarget(0);
    const inverted = trimmedTarget(Math.PI);
    expect(upright.after).toBeGreaterThan(upright.before);
    expect(inverted.after).toBeLessThan(inverted.before);
    expect(upright.pitch).toBeGreaterThan(0);
    expect(inverted.pitch).toBeGreaterThan(0);
  });

  it("lets direct pitch authority drive well past the Scenic attitude envelope", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 2_500, z: 0 },
        pitch: 2 * DEG_TO_RAD,
        airspeed: 55,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.55 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.55 },
    });
    let mostNoseDown = Number.POSITIVE_INFINITY;

    for (let step = 0; step < Math.round(5 / FIXED_TIME_STEP); step += 1) {
      const requested = { ...DEFAULT_CONTROLS, throttle: 0.55, pitch: -1 };
      simulator.step(FIXED_TIME_STEP, assisted(simulator, "unassisted", requested));
      mostNoseDown = Math.min(mostNoseDown, simulator.telemetry().pitch);
    }

    // Scenic intentionally targets about -11.5 degrees. Direct control is a
    // surface command, not an attitude command, and can push through a steep
    // dive with no controller-imposed pitch stop.
    expect(mostNoseDown * RAD_TO_DEG).toBeLessThan(-45);
  });

  it("retains the exact nose-down attitude selected in Direct controls", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 3_000, z: 0 },
        pitch: 2 * DEG_TO_RAD,
        airspeed: 56,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.58, trim: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.58, trim: 0 },
    });
    const retention = new DirectPitchRetention();
    const requested = { ...DEFAULT_CONTROLS, throttle: 0.58, trim: 0 };

    advance(simulator, 1.1, (current) => {
      const command = { ...requested, pitch: -0.72 };
      return retention.apply(
        assisted(current, "unassisted", command),
        command,
        current.state,
        current.telemetry(),
      );
    });
    const selectedPitch = simulator.telemetry().pitch;
    expect(selectedPitch * RAD_TO_DEG).toBeLessThan(-12);

    advance(simulator, 5, (current) => retention.apply(
      assisted(current, "unassisted", requested),
      requested,
      current.state,
      current.telemetry(),
    ));
    const retainedPitch = simulator.telemetry().pitch;

    expect(retention.target).not.toBeNull();
    expect((retention.target ?? 0) * RAD_TO_DEG).toBeLessThan(-12);
    expect(retainedPitch * RAD_TO_DEG).toBeLessThan(-10);
    expect(Math.abs(retainedPitch - selectedPitch) * RAD_TO_DEG).toBeLessThan(3.5);
  });

  it("retains a pilot-selected nose-up attitude without a preset climb target", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 3_000, z: 0 },
        pitch: 0,
        airspeed: 58,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.62 },
      },
    });
    const retention = new DirectPitchRetention();
    const neutral = { ...DEFAULT_CONTROLS, throttle: 0.62 };
    advance(simulator, 0.75, (current) => {
      const command = { ...neutral, pitch: 0.5 };
      return retention.apply(
        assisted(current, "unassisted", command),
        command,
        current.state,
        current.telemetry(),
      );
    });
    const selectedPitch = simulator.telemetry().pitch;
    expect(selectedPitch * RAD_TO_DEG).toBeGreaterThan(6);
    advance(simulator, 4, (current) => retention.apply(
      assisted(current, "unassisted", neutral),
      neutral,
      current.state,
      current.telemetry(),
    ));
    expect(simulator.telemetry().pitch * RAD_TO_DEG).toBeGreaterThan(4);
    expect(
      Math.abs(simulator.telemetry().pitch - selectedPitch) * RAD_TO_DEG,
    ).toBeLessThan(4);
  });

  it("snaps a runway spawn onto preloaded tricycle gear and stays parked", () => {
    const simulator = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: 0,
        position: { x: 20, y: 999, z: -30 },
        controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      environment: { terrain: RUNWAY },
    });

    // onGround is a placement request, so the contradictory input Y is ignored.
    expect(simulator.state.position.y).toBeGreaterThan(1.2);
    expect(simulator.state.position.y).toBeLessThan(1.3);
    expect(simulator.telemetry().pitch * RAD_TO_DEG).toBeGreaterThan(-3.2);
    expect(simulator.telemetry().pitch * RAD_TO_DEG).toBeLessThan(-2.2);
    expect(simulator.telemetry().altitudeAgl).toBe(0);

    advance(simulator, 5, () => ({ ...DEFAULT_CONTROLS, throttle: 0 }));
    expect(simulator.state.dynamics.contactCount).toBe(3);
    expect(simulator.telemetry().groundSpeed).toBeLessThan(0.02);
    expect(Math.abs(simulator.state.velocity.y)).toBeLessThan(0.03);
    expect(simulator.telemetry().altitudeAgl).toBe(0);
    expect(simulator.state.crashed).toBe(false);
  });

  it("turns right for a positive roll command and recentres when released", () => {
    const simulator = new FlightSimulator({
      spawn: { heading: 90 * DEG_TO_RAD, pitch: 2 * DEG_TO_RAD, airspeed: 50 },
    });

    advance(simulator, 4, (current) =>
      assisted(current, "scenic", { ...DEFAULT_CONTROLS, roll: 0.7 }),
    );
    const established = simulator.telemetry();
    expect(established.bank * RAD_TO_DEG).toBeGreaterThan(26);
    expect(established.bank * RAD_TO_DEG).toBeLessThan(34);
    expect(established.heading * RAD_TO_DEG).toBeGreaterThan(106);
    expect(established.heading * RAD_TO_DEG).toBeLessThan(119);
    expect(Math.abs(established.sideslip * RAD_TO_DEG)).toBeLessThan(4);
    expect(established.airspeed).toBeGreaterThan(45);

    advance(simulator, 4, (current) =>
      assisted(current, "scenic", { ...DEFAULT_CONTROLS }),
    );
    expect(Math.abs(simulator.telemetry().bank * RAD_TO_DEG)).toBeLessThan(3);
  });

  it("turns pitch input into an obvious, bounded climb", () => {
    const simulator = new FlightSimulator({
      spawn: { heading: 90 * DEG_TO_RAD, pitch: 2 * DEG_TO_RAD, airspeed: 50 },
    });

    advance(simulator, 3, (current) =>
      assisted(current, "scenic", { ...DEFAULT_CONTROLS, pitch: 0.7 }),
    );
    const telemetry = simulator.telemetry();
    expect(telemetry.pitch * RAD_TO_DEG).toBeGreaterThan(9);
    expect(telemetry.pitch * RAD_TO_DEG).toBeLessThan(13);
    expect(telemetry.verticalSpeed).toBeGreaterThan(5);
    expect(telemetry.verticalSpeed).toBeLessThan(10);
    expect(telemetry.airspeed).toBeGreaterThan(43);
    expect(telemetry.isStalled).toBe(false);
  });

  it("takes off under the same scenic controller used by the browser", () => {
    const simulator = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.04, flaps: 0.5 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.04, flaps: 0.5 },
      environment: { terrain: RUNWAY },
    });
    let liftoffTime: number | null = null;
    let liftoffDistance: number | null = null;

    for (let step = 0; step < Math.round(20 / FIXED_TIME_STEP); step += 1) {
      const requested = {
        ...DEFAULT_CONTROLS,
        throttle: 1,
        trim: 0.04,
        flaps: 0.5,
        pitch: simulator.telemetry().groundSpeed > 27 ? 0.42 : 0,
      };
      simulator.step(FIXED_TIME_STEP, assisted(simulator, "scenic", requested));
      if (liftoffTime === null && !simulator.state.onGround) {
        liftoffTime = simulator.state.time;
        liftoffDistance = Math.hypot(simulator.state.position.x, simulator.state.position.z);
      }
    }

    const telemetry = simulator.telemetry();
    expect(liftoffTime).not.toBeNull();
    expect(liftoffTime ?? 99).toBeGreaterThan(11);
    expect(liftoffTime ?? 0).toBeLessThan(17);
    expect(liftoffDistance ?? 999).toBeGreaterThan(170);
    expect(liftoffDistance ?? 0).toBeLessThan(360);
    expect(telemetry.altitudeAgl).toBeGreaterThan(12);
    expect(telemetry.altitudeAgl).toBeLessThan(35);
    expect(telemetry.pitch * RAD_TO_DEG).toBeGreaterThan(5);
    expect(telemetry.pitch * RAD_TO_DEG).toBeLessThan(12);
    expect(telemetry.airspeed).toBeGreaterThan(32);
    expect(telemetry.airspeed).toBeLessThan(45);
    expect(simulator.state.crashed).toBe(false);
  });

  it("holds runway heading in Scenic mode until rudder is commanded", () => {
    const simulator = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: 0,
        heading: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.32 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.32 },
      environment: {
        terrain: RUNWAY,
        wind: { x: 9, y: 0, z: 0 },
      },
    });

    advance(simulator, 8, (current) => applyFlightAssistance(
      { ...DEFAULT_CONTROLS },
      "scenic",
      { ...DEFAULT_CONTROLS, throttle: 0.32 },
      current.state,
      current.telemetry(),
      0,
    ));
    const headingError = Math.atan2(
      Math.sin(simulator.telemetry().heading),
      Math.cos(simulator.telemetry().heading),
    );
    expect(Math.abs(headingError) * RAD_TO_DEG).toBeLessThan(4);
    expect(simulator.telemetry().groundSpeed).toBeGreaterThan(2);

    const commanded = applyFlightAssistance(
      { ...DEFAULT_CONTROLS },
      "scenic",
      { ...DEFAULT_CONTROLS, throttle: 0.32, yaw: 0.45 },
      simulator.state,
      simulator.telemetry(),
      0,
    );
    expect(commanded.yaw).toBe(0.45);
  });

  it("holds a trimmed cruise for one minute without energy divergence", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 1_000, z: 0 },
        airspeed: 50,
        pitch: 2 * DEG_TO_RAD,
      },
    });
    // This test deliberately measures the trainer's known cruise trim. The
    // application/default control contract remains zero-trim and never hides
    // this preset from the pilot.
    advance(simulator, 60, () => ({ ...DEFAULT_CONTROLS, trim: 0.065 }));

    const telemetry = simulator.telemetry();
    expect(simulator.state.position.y - 1_000).toBeGreaterThan(-30);
    expect(simulator.state.position.y - 1_000).toBeLessThan(35);
    expect(telemetry.airspeed).toBeGreaterThan(46);
    expect(telemetry.airspeed).toBeLessThan(55);
    expect(Math.abs(telemetry.bank * RAD_TO_DEG)).toBeLessThan(1);
    expect(Math.hypot(
      simulator.state.angularVelocity.x,
      simulator.state.angularVelocity.y,
      simulator.state.angularVelocity.z,
    )).toBeLessThan(0.08);
  });

  it("provides correctly signed rudder and nose-wheel steering", () => {
    const airborne = new FlightSimulator({
      spawn: { heading: 90 * DEG_TO_RAD, pitch: 2 * DEG_TO_RAD, airspeed: 50 },
    });
    advance(airborne, 1.5, () => ({ ...DEFAULT_CONTROLS, yaw: 0.35 }));
    expect(airborne.telemetry().heading * RAD_TO_DEG).toBeGreaterThan(98);
    expect(airborne.state.angularVelocity.y).toBeGreaterThan(0);

    const taxi = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.2 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.2 },
      environment: { terrain: RUNWAY },
    });
    advance(taxi, 8, () => ({ ...DEFAULT_CONTROLS, throttle: 0.2, yaw: 0.5 }));
    expect(taxi.telemetry().groundSpeed).toBeGreaterThan(1);
    expect(taxi.telemetry().groundSpeed).toBeLessThan(4);
    expect(taxi.telemetry().heading * RAD_TO_DEG).toBeGreaterThan(5);
    expect(taxi.telemetry().heading * RAD_TO_DEG).toBeLessThan(20);
    expect(taxi.state.crashed).toBe(false);
  });

  it("enters a progressive stall and recovers after unloading the wing", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 1_200, z: 0 },
        airspeed: 34,
        pitch: 5 * DEG_TO_RAD,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.25 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.25 },
    });
    let stalledAt: number | null = null;
    for (let step = 0; step < Math.round(6 / FIXED_TIME_STEP); step += 1) {
      simulator.step(FIXED_TIME_STEP, {
        ...DEFAULT_CONTROLS,
        throttle: 0.25,
        pitch: 0.48,
      });
      if (stalledAt === null && simulator.telemetry().isStalled) {
        stalledAt = simulator.state.time;
      }
    }

    expect(stalledAt).not.toBeNull();
    expect(stalledAt ?? 99).toBeLessThan(5.5);
    expect(simulator.telemetry().angleOfAttack * RAD_TO_DEG).toBeGreaterThan(15);
    expect(simulator.state.dynamics.dragCoefficient).toBeGreaterThan(0.08);

    advance(simulator, 7, () => ({
      ...DEFAULT_CONTROLS,
      throttle: 0.65,
      pitch: -0.32,
    }));
    const recovered = simulator.telemetry();
    expect(recovered.isStalled).toBe(false);
    expect(Math.abs(recovered.angleOfAttack * RAD_TO_DEG)).toBeLessThan(8);
    expect(recovered.airspeed).toBeGreaterThan(40);
    expect(recovered.airspeed).toBeLessThan(75);
    expect(simulator.state.crashed).toBe(false);
  });
});
