import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import {
  KEYBOARD_PITCH_ENGAGE_RATE,
  KEYBOARD_PITCH_RELEASE_RATE,
  KEYBOARD_PITCH_TAP_SECONDS,
  slewAxis,
} from "../src/input";
import {
  aircraftDefinition,
  AIRCRAFT_KINDS,
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FAST_JET,
  FIXED_TIME_STEP,
  FlightSimulator,
  pitchGearingFactor,
  stallSpeed,
  type FlightControls,
  type PitchGearing,
} from "../src/sim";

/**
 * Speed-scheduled pitch gearing (src/sim/pitchGearing.ts), from Jason's F-16
 * report on 2026-10-27: at high speed "a light tap on W makes the plane shoot
 * down and a light tap on S makes it shoot up". The ask was a SLIGHT change,
 * so these pin both directions: the tap gets calmer at speed, and nothing
 * else moves -- not the F-16 below the knee, not the other three aeroplanes,
 * not full-stick authority.
 */

const JET_GEARING = aircraftSpec("jet").pitchGearing!;

interface TapTrace {
  /** Load factor, every step from the tap on. */
  loadFactor: number[];
  /** Body pitch rate, rad/s, every step from the tap on. */
  pitchRate: number[];
  /** Equivalent airspeed at the tap. */
  equivalentAirspeed: number;
}

/**
 * The F-16 in roughly level flight at 1,000 m, given (or not) the lightest pitch
 * tap the keyboard makes: InputManager's own tap hold and slew rates at the
 * default sensitivity. Geared and held by Direct mode's pitch retention exactly
 * as the worker does it, retention reading the pilot's own hand.
 */
function flyTap(airspeed: number, tap: number, gearing: PitchGearing | null): TapTrace {
  const controls: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0.7, gear: 0 };
  const simulator = new FlightSimulator({
    aircraft: FAST_JET,
    spawn: { position: { x: 0, y: 1_000, z: 0 }, heading: 0, pitch: 0, airspeed, controls },
    controls,
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  const retention = new DirectPitchRetention();
  const settle = Math.round(1 / FIXED_TIME_STEP);
  const trace: TapTrace = { loadFactor: [], pitchRate: [], equivalentAirspeed: 0 };
  let stick = 0;
  let tapRemaining = 0;
  for (let step = 0; step < settle + Math.round(3 / FIXED_TIME_STEP); step += 1) {
    if (step === settle) tapRemaining = KEYBOARD_PITCH_TAP_SECONDS;
    const held = tapRemaining > 0 ? tap : 0;
    tapRemaining = Math.max(0, tapRemaining - FIXED_TIME_STEP);
    const telemetry = simulator.telemetry();
    if (step === settle) trace.equivalentAirspeed = telemetry.indicatedAirspeed;
    stick = slewAxis(stick, held, KEYBOARD_PITCH_ENGAGE_RATE, KEYBOARD_PITCH_RELEASE_RATE, FIXED_TIME_STEP);
    const requested: FlightControls = { ...controls, pitch: stick };
    const geared: FlightControls = {
      ...requested,
      pitch: stick * pitchGearingFactor(gearing, telemetry.indicatedAirspeed),
    };
    simulator.step(FIXED_TIME_STEP, retention.apply(geared, requested, simulator.state, telemetry));
    if (step >= settle) {
      trace.loadFactor.push(simulator.telemetry().loadFactor);
      trace.pitchRate.push(simulator.state.angularVelocity.z);
    }
  }
  return trace;
}

/** What the tap adds over hands-off flight from the same start: peak extra g. */
function tapLoadFactor(airspeed: number, gearing: PitchGearing | null): number {
  const base = flyTap(airspeed, 0, gearing);
  const tapped = flyTap(airspeed, 1, gearing);
  let peak = 0;
  for (let index = 0; index < base.loadFactor.length; index += 1) {
    peak = Math.max(peak, Math.abs(tapped.loadFactor[index]! - base.loadFactor[index]!));
  }
  return peak;
}

describe("pitchGearingFactor", () => {
  it("passes the stick through one for one without gearing, at any speed", () => {
    for (const speed of [0, 50, 140, 400, 1_000, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(pitchGearingFactor(null, speed)).toBe(1);
    }
  });

  it("is exactly 1 up to the knee, then knee over airspeed", () => {
    for (const speed of [-5, 0, 60, 120, JET_GEARING.kneeAirspeed]) {
      expect(pitchGearingFactor(JET_GEARING, speed)).toBe(1);
    }
    for (const speed of [160, 210, 280]) {
      expect(pitchGearingFactor(JET_GEARING, speed)).toBeCloseTo(JET_GEARING.kneeAirspeed / speed, 12);
    }
    // Continuous at the knee: no step a pilot could feel crossing it.
    expect(pitchGearingFactor(JET_GEARING, JET_GEARING.kneeAirspeed + 1e-6)).toBeCloseTo(1, 6);
  });

  it("never falls with speed faster than the law, nor below its floor", () => {
    let previous = 1;
    for (let speed = 0; speed <= 2_000; speed += 5) {
      const factor = pitchGearingFactor(JET_GEARING, speed);
      expect(factor).toBeLessThanOrEqual(previous);
      expect(factor).toBeGreaterThanOrEqual(JET_GEARING.floor);
      previous = factor;
    }
    expect(pitchGearingFactor(JET_GEARING, 1e9)).toBe(JET_GEARING.floor);
  });

  it("reads a non-finite airspeed as no gearing rather than poisoning the elevator", () => {
    expect(pitchGearingFactor(JET_GEARING, Number.NaN)).toBe(1);
    expect(pitchGearingFactor(JET_GEARING, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("which aeroplanes are geared", () => {
  it("leaves the trainer, the Global and the 747 with the stick they always had", () => {
    for (const kind of ["trainer", "bizjet", "airliner"] as const) {
      expect(aircraftSpec(kind).pitchGearing, kind).toBeNull();
      // So the worker's multiply is by exactly 1 and every bit of the command survives.
      for (const speed of [30, 80, 150, 200, 260]) {
        const stick = 0.2718281828;
        expect(stick * pitchGearingFactor(aircraftSpec(kind).pitchGearing, speed)).toBe(stick);
      }
    }
    // Every kind is answered: a new airframe cannot arrive without a decision.
    for (const kind of AIRCRAFT_KINDS) expect(aircraftSpec(kind).pitchGearing).not.toBeUndefined();
  });

  it("starts the F-16's gearing well above its low-speed flying", () => {
    // Take-off, the circuit, approach and landing all sit within twice the
    // clean stall speed; none of it should feel any different.
    const cleanStall = stallSpeed(aircraftDefinition("jet"), 0);
    expect(JET_GEARING.kneeAirspeed).toBeGreaterThan(2 * cleanStall);
    // ...but below the airborne start, so the speed a pilot flies at most is
    // the speed that got calmer.
    expect(JET_GEARING.kneeAirspeed).toBeLessThan(aircraftSpec("jet").spawn.airborneAirspeed);
  });
});

describe("the F-16's lightest keyboard tap", () => {
  it("is bit-for-bit unchanged below the knee", () => {
    for (const airspeed of [80, 120]) {
      const plain = flyTap(airspeed, 1, null);
      const geared = flyTap(airspeed, 1, JET_GEARING);
      expect(plain.equivalentAirspeed).toBeLessThan(JET_GEARING.kneeAirspeed);
      expect(geared.loadFactor).toEqual(plain.loadFactor);
      expect(geared.pitchRate).toEqual(plain.pitchRate);
    }
  });

  it("no longer slams the nose at high speed", () => {
    // Measured here: 2.90 g ungeared at 243 m/s EAS, 1.65 geared; 6.11 and
    // 3.09 at 331. The sim is deterministic, so the bars can sit close.
    const fastPlain = tapLoadFactor(250, null);
    const fastGeared = tapLoadFactor(250, JET_GEARING);
    expect(fastPlain).toBeGreaterThan(2.4);
    expect(fastGeared).toBeLessThan(1.8);
    expect(fastGeared).toBeLessThan(fastPlain * 0.65);

    const fasterPlain = tapLoadFactor(350, null);
    const fasterGeared = tapLoadFactor(350, JET_GEARING);
    expect(fasterPlain).toBeGreaterThan(5);
    expect(fasterGeared).toBeLessThan(3.4);
  });

  it("still gets livelier with speed, so the change stays slight", () => {
    // Half the dynamic-pressure growth is kept: a tap at 460 kt is still
    // clearly more than one at 230 kt, and more again at 640.
    const slow = tapLoadFactor(120, JET_GEARING);
    const fast = tapLoadFactor(250, JET_GEARING);
    const faster = tapLoadFactor(350, JET_GEARING);
    expect(fast).toBeGreaterThan(slow * 2.5);
    expect(faster).toBeGreaterThan(fast * 1.5);
  });

  it("keeps full-stick authority: a held pull still reaches the usable angle of attack", () => {
    for (const airspeed of [250, 350]) {
      const controls: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0.7, gear: 0 };
      const simulator = new FlightSimulator({
        aircraft: FAST_JET,
        spawn: { position: { x: 0, y: 3_000, z: 0 }, heading: 0, pitch: 0, airspeed, controls },
        controls,
        environment: { wind: { x: 0, y: 0, z: 0 } },
      });
      let peakAngleOfAttack = 0;
      for (let step = 0; step < Math.round(2 / FIXED_TIME_STEP); step += 1) {
        const factor = pitchGearingFactor(JET_GEARING, simulator.telemetry().indicatedAirspeed);
        simulator.step(FIXED_TIME_STEP, { ...controls, pitch: factor });
        peakAngleOfAttack = Math.max(peakAngleOfAttack, simulator.telemetry().angleOfAttack);
      }
      expect(peakAngleOfAttack, `${airspeed} m/s`).toBeGreaterThan(0.9 * FAST_JET.positiveStallAngle);
    }
  });
});

describe("the worker's wiring", () => {
  const source = readFileSync(new URL("../src/workers/simulation.worker.ts", import.meta.url), "utf8");
  const assisted = source.slice(
    source.indexOf("function assistedControls(): FlightControls {"),
    source.indexOf("function visualState(): FlightVisualState {"),
  );

  it("gears the player's pitch in Direct and Pilot only, never Scenic or the menu flight", () => {
    const scenic = assisted.indexOf('if (!attractMode && selectedMode === "scenic") {');
    const directOrPilot = assisted.indexOf("} else if (!attractMode) {");
    const gearing = assisted.indexOf("pitchGearingFactor(");
    expect(scenic).toBeGreaterThan(-1);
    expect(directOrPilot).toBeGreaterThan(scenic);
    expect(gearing).toBeGreaterThan(directOrPilot);
    expect(assisted.match(/pitchGearingFactor\(/g)).toHaveLength(1);
    expect(assisted).toContain("aircraftSpec(aircraftKind).pitchGearing");
    expect(assisted).toContain("requestedControls = gearedControls;");
  });

  it("lets pitch retention and the dampers read the pilot's own hand, ungeared", () => {
    expect(assisted).toContain("directPitchRetention.apply(\n    selectedControls,\n    controls,");
    expect(assisted).toContain("jetStabilityAugmentation.apply(retained, controls,");
  });
});
