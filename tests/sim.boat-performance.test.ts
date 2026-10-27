import { describe, expect, it } from "vitest";
import {
  BOAT_CALIBRATION,
  BOAT_TRIAL_TABLE,
  BoatSimulator,
  KNOT,
  TRIAL_RPM_SCALE,
  fullThrottleAcceleration,
  steadySpeeds,
  throttleChop,
  trialBand,
} from "../src/sim/boat";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";

/**
 * The Runabout 21 against the plan's calibration targets and the two
 * published trials that bracket it (src/sim/boat/trials.ts has the table and
 * why its rpm column is scaled to this boat's drive).
 */

const STEP = 1 / 120;

describe("boat performance", () => {
  it("pins every fitted constant, so a retune is a visible change", () => {
    expect(BOAT_CALIBRATION).toEqual({
      addedMassFactor: 1,
      crossFlowDrag: 1,
      transomReleaseBeams: 0.65,
      lateralAddedMass: 0.8,
      lateralCrossFlowDrag: 1,
      sideslipLift: 1,
      humpDrag: 0.09,
      humpFroude: 0.57,
      humpSharpness: 18,
      humpMoment: 0.012,
      transomAsternDrag: 1,
      roughnessAllowance: 0.0004,
      wakeFraction: 0.04,
      thrustDeduction: 0.05,
      kt: [0.48, -0.3004, -0.0583],
      kq10: [0.85, -0.5382, -0.0331],
      reverseEfficiency: 0.55,
      ventilationFull: 0.5,
      ventilationOnset: 0.82,
      ventilatedLoad: 0.25,
      cavitationLoading: 1,
      cavitationThrustSlope: 0.4,
      cavitationTorqueShare: 0.5,
      propellerWalk: 0.04,
      radiationDamping: 0.08,
    });
  });

  // One sweep, slowest row first, the rpm held off the tachometer as a trial driver holds it.
  const rows = BOAT_TRIAL_TABLE.map((row) => row.trialRpm * TRIAL_RPM_SCALE);
  const sweep = steadySpeeds(rows);

  it("holds every rpm row inside the two trials, 10% either side", () => {
    BOAT_TRIAL_TABLE.forEach((row, i) => {
      const point = sweep[i]!;
      const band = trialBand(row);
      expect(point.rpm, `${row.trialRpm} rpm row held`).toBeCloseTo(rows[i]!, -1);
      expect(point.knots, `${row.trialRpm} rpm row`).toBeGreaterThanOrEqual(band.low);
      expect(point.knots, `${row.trialRpm} rpm row`).toBeLessThanOrEqual(band.high);
    });
  });

  it("sits behind the hump at 7-9 kn on the trials' 2,000 rpm and is on the plane at their 2,500", () => {
    const behind = sweep[BOAT_TRIAL_TABLE.findIndex((row) => row.trialRpm === 2_000)]!;
    expect(behind.knots).toBeGreaterThanOrEqual(7);
    expect(behind.knots).toBeLessThanOrEqual(9);
    expect(behind.dynamicLiftShare).toBeLessThan(0.15);
    const over = sweep[BOAT_TRIAL_TABLE.findIndex((row) => row.trialRpm === 2_500)]!;
    expect(over.dynamicLiftShare).toBeGreaterThan(0.5);
  });

  const run = fullThrottleAcceleration();

  it("gets on the plane in 4-5 s and to 30 mph in 7-8 s from a standing start", () => {
    expect(run.toPlane).toBeGreaterThanOrEqual(4);
    expect(run.toPlane).toBeLessThanOrEqual(5);
    expect(run.toThirtyMph).toBeGreaterThanOrEqual(7);
    expect(run.toThirtyMph).toBeLessThanOrEqual(8);
    // Bow up through the hump, then down onto the plane.
    expect(run.humpTrimDegrees).toBeGreaterThan(6);
    expect(run.humpTrimDegrees).toBeLessThan(10);
  });

  it("tops out at 39-43 kn at 5,600-5,800 rpm with about 15% slip", () => {
    expect(run.topKnots).toBeGreaterThanOrEqual(39);
    expect(run.topKnots).toBeLessThanOrEqual(43);
    expect(run.top.rpm).toBeGreaterThanOrEqual(5_600);
    expect(run.top.rpm).toBeLessThanOrEqual(5_800);
    const propeller = new BoatSimulator().definition.propeller;
    const slip = 1 - run.top.speedThroughWater / ((run.top.rpm / 60 / propeller.gearRatio) * propeller.pitch);
    expect(slip).toBeGreaterThan(0.12);
    expect(slip).toBeLessThan(0.18);
  });

  it("runs at 3-5 degrees of trim on the plane, cruise to full speed", () => {
    expect(run.topTrimDegrees).toBeGreaterThanOrEqual(3);
    expect(run.topTrimDegrees).toBeLessThanOrEqual(5);
    for (const point of sweep.filter((p) => p.knots > 25)) {
      expect(point.trimDegrees, `${point.knots.toFixed(1)} kn`).toBeGreaterThanOrEqual(3);
      expect(point.trimDegrees, `${point.knots.toFixed(1)} kn`).toBeLessThanOrEqual(5);
    }
  });

  it("comes off the plane to displacement speed in 6-10 s when the throttle is chopped at 40 mph", () => {
    const chop = throttleChop({ fromMph: 40, toKnots: 7 });
    expect(chop.seconds).toBeGreaterThanOrEqual(6);
    expect(chop.seconds).toBeLessThanOrEqual(10);
  });

  it("crash-stops from 30 kn on full astern in under 10 s and 80 m, the gear waiting for the revs", () => {
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, speed: 30 * KNOT, gear: "forward", rpm: 4_400 });
    boat.setEnvironment({});
    const controls = { assist: "scenic" as const, boat: { ...NEUTRAL_BOAT_CONTROLS, lever: 0.7 } };
    boat.setControls(controls);
    for (let t = 0; t < 8; t += STEP) boat.step(STEP);
    const start = { x: boat.state.position.x, z: boat.state.position.z };
    controls.boat.lever = -1;
    boat.setControls(controls);
    const telemetry = boat.telemetry();
    let stopped = NaN;
    let shifted = NaN;
    for (let i = 1; i * STEP <= 15 && Number.isNaN(stopped); i += 1) {
      boat.step(STEP);
      boat.telemetry(telemetry);
      if (Number.isNaN(shifted) && telemetry.gear === "reverse") {
        shifted = i * STEP;
        expect(telemetry.rpm).toBeLessThanOrEqual(boat.definition.engine.shiftMaxRpm + 50);
      }
      if (telemetry.speedThroughWater < 0.2) stopped = i * STEP;
    }
    expect(shifted).toBeGreaterThan(1);
    expect(stopped).toBeLessThan(10);
    expect(Math.hypot(boat.state.position.x - start.x, boat.state.position.z - start.z)).toBeLessThan(80);
  });

  it("backs at 4-8 kn on full astern, the throttle only half open, and stays whole", () => {
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false });
    boat.setEnvironment({});
    boat.setControls({ assist: "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS, lever: -1 } });
    const telemetry = boat.telemetry();
    let slowest = 0;
    let fastest = -Infinity;
    for (let i = 1; i * STEP <= 20; i += 1) {
      boat.step(STEP);
      if (i * STEP < 6) continue;
      boat.telemetry(telemetry);
      slowest = Math.min(slowest, telemetry.speedThroughWater);
      fastest = Math.max(fastest, telemetry.speedThroughWater);
    }
    expect(telemetry.gear).toBe("reverse");
    expect(-fastest / KNOT).toBeGreaterThan(4);
    expect(-slowest / KNOT).toBeLessThan(8);
    expect(telemetry.rpm).toBeLessThan(4_000);
    expect(telemetry.crashed).toBe(false);
  });
});
