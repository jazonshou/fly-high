import { describe, expect, it } from "vitest";
import {
  BENCH_CLEARANCE,
  BENCH_CRUISE_SPEED,
  BENCH_ROLL_SPEED,
  BENCH_SETTLE_CREEP,
  benchPathDistance,
  benchPathSpeed,
  benchPathSummary,
  createBenchPath,
  createBenchVisualState,
  pathFingerprint,
  writeFlightState,
  writeSettleState,
  type BenchPath,
} from "../src/bench/path";
import { BENCH_SEED, benchTimings, expectedPathFingerprint } from "../src/bench/plan";
import { createSimulationSpawn } from "../src/game/spawn";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { aircraftDefinition, createFlightState, quaternionFromFlightAngles } from "../src/sim";
import { rotateVectorInto } from "../src/sim/math";
import { createWorld, type WorldDefinition } from "../src/world";

const world = createWorld(BENCH_SEED);
const standard = benchTimings(false);
const path = createBenchPath(world, standard);
const PROFILE_DT = 1 / 20;

function snapshot(state: FlightVisualState): string {
  return JSON.stringify(state);
}

function stateAt(route: BenchPath, t: number): FlightVisualState {
  return writeFlightState(route, t, createBenchVisualState());
}

describe("bench route", () => {
  it("starts where the game's runway start puts the trainer", () => {
    const spawn = createSimulationSpawn(world, "runway", 450, "trainer");
    expect(path.route).toBe("runway");
    expect(path.startX).toBe(spawn.position?.x);
    expect(path.startZ).toBe(spawn.position?.z);
    expect(path.headingRadians).toBe(world.airport?.headingRadians);
    const onRunway = createFlightState(spawn, aircraftDefinition("trainer"));
    expect(path.runwayY).toBe(onRunway.position.y);
    const start = stateAt(path, 0);
    expect(start.position).toEqual({ x: path.startX, y: path.runwayY, z: path.startZ });
    expect(start.onGround).toBe(true);
    expect(start.airspeed).toBe(0);
  });

  it("is a pure function of t: order and history never change a state", () => {
    const times = [0, 0.01, 7.3, 15, 15.02, 29.99, 30, 44.444, 74.999, 75];
    const forward = times.map((t) => snapshot(stateAt(path, t)));
    const shared = createBenchVisualState();
    const backward = [...times].reverse().map((t) => snapshot(writeFlightState(path, t, shared))).reverse();
    expect(backward).toEqual(forward);
    expect(snapshot(stateAt(createBenchPath(world, standard), 44.444))).toBe(forward[7]);
  });

  it("a 30 Hz and a 144 Hz device see identical states at the instants they share", () => {
    const at30 = new Map<number, string>();
    const reused = createBenchVisualState();
    for (let frame = 0; frame <= 75 * 30; frame += 1) {
      if (frame % 5 === 0) at30.set(frame / 5, snapshot(writeFlightState(path, frame / 30, reused)));
      else writeFlightState(path, frame / 30, reused);
    }
    let compared = 0;
    for (let frame = 0; frame <= 75 * 144; frame += 1) {
      const state = snapshot(writeFlightState(path, frame / 144, reused));
      // Both rates land on every sixth of a second.
      if (frame % 24 === 0) {
        expect(state).toBe(at30.get(frame / 24));
        compared += 1;
      }
    }
    expect(compared).toBe(75 * 6 + 1);
  });

  it("rolls 0 to 60 m/s on the runway, climbs out to 120, then cruises at 120", () => {
    expect(benchPathSpeed(path, 0)).toBe(0);
    expect(benchPathSpeed(path, 7.5)).toBeCloseTo(BENCH_ROLL_SPEED / 2, 9);
    expect(benchPathSpeed(path, standard.rollEndS)).toBeCloseTo(BENCH_ROLL_SPEED, 9);
    expect(benchPathSpeed(path, 22.5)).toBeCloseTo((BENCH_ROLL_SPEED + BENCH_CRUISE_SPEED) / 2, 9);
    expect(benchPathSpeed(path, standard.climbEndS)).toBe(BENCH_CRUISE_SPEED);
    expect(benchPathSpeed(path, 60)).toBe(BENCH_CRUISE_SPEED);
    expect(benchPathDistance(path, standard.rollEndS)).toBeCloseTo(450, 9);
    expect(benchPathDistance(path, standard.climbEndS)).toBeCloseTo(450 + 1_350, 9);
    expect(benchPathDistance(path, standard.flightS)).toBeCloseTo(7_200, 9);
    // Distance is the integral of speed: compare against a fine numeric sum.
    let integral = 0;
    for (let step = 0; step < 40_000; step += 1) integral += benchPathSpeed(path, (step + 0.5) / 1_000) / 1_000;
    expect(integral).toBeCloseTo(benchPathDistance(path, 40), 2);
    for (let t = 0; t < standard.rollEndS; t += 0.5) {
      const state = stateAt(path, t);
      expect(state.onGround).toBe(true);
      expect(state.position.y).toBe(path.runwayY);
      expect(state.velocity.y).toBe(0);
      expect(state.altitudeAgl).toBeLessThan(0.5);
    }
    expect(stateAt(path, standard.rollEndS + 0.01).onGround).toBe(false);
  });

  it("holds the climb and descent limits, the floors and the cruise height", () => {
    const k0 = Math.round(standard.rollEndS / PROFILE_DT);
    const kCruise = Math.round(standard.climbEndS / PROFILE_DT);
    for (let k = 1; k < path.altitude.length; k += 1) {
      const step = path.altitude[k]! - path.altitude[k - 1]!;
      const ground = path.ground[k]!;
      const t = k * PROFILE_DT;
      expect(Number.isFinite(path.altitude[k]!)).toBe(true);
      expect(ground).toBeGreaterThanOrEqual(world.seaLevel);
      if (k <= k0) {
        expect(step).toBe(0);
        continue;
      }
      const climbingOut = t < standard.climbEndS;
      const floor = ground + (climbingOut ? path.cgHeight : 30);
      expect(path.altitude[k]!).toBeGreaterThanOrEqual(floor - 1e-9);
      // A step past a limit is only ever the floor lifting the aircraft.
      const limit = (climbingOut ? 10 : 25) * PROFILE_DT;
      if (step > limit + 1e-9) expect(path.altitude[k]!).toBeCloseTo(floor, 9);
      expect(step).toBeGreaterThanOrEqual(-10 * PROFILE_DT - 1e-9);
      if (k >= kCruise) expect(path.altitude[k]!).toBeGreaterThanOrEqual(world.seaLevel + 30);
    }
    // The cruise settles on the clearance it follows.
    const late = stateAt(path, 70);
    expect(late.altitudeAgl).toBeGreaterThan(BENCH_CLEARANCE * 0.8);
    expect(late.altitudeAgl).toBeLessThan(BENCH_CLEARANCE * 1.5);
  });

  it("every field is finite and the forward axis points down the runway", () => {
    const forward = { x: 0, y: 0, z: 0 };
    for (let t = 0; t <= standard.flightS; t += 0.37) {
      const state = stateAt(path, t);
      for (const [name, value] of Object.entries(state)) {
        if (typeof value === "number") expect(Number.isFinite(value), `${name} at ${t}`).toBe(true);
        else if (typeof value === "object" && value !== null) {
          for (const part of Object.values(value)) expect(Number.isFinite(part), `${name} at ${t}`).toBe(true);
        }
      }
      const expected = quaternionFromFlightAngles(path.headingRadians, (state.pitch * Math.PI) / 180, 0);
      expect(state.orientation.x).toBeCloseTo(expected.x, 12);
      expect(state.orientation.y).toBeCloseTo(expected.y, 12);
      expect(state.orientation.z).toBeCloseTo(expected.z, 12);
      expect(state.orientation.w).toBeCloseTo(expected.w, 12);
      rotateVectorInto(forward, state.orientation, { x: 1, y: 0, z: 0 });
      const pitch = (state.pitch * Math.PI) / 180;
      expect(forward.x).toBeCloseTo(Math.sin(path.headingRadians) * Math.cos(pitch), 9);
      expect(forward.y).toBeCloseTo(Math.sin(pitch), 9);
      expect(forward.z).toBeCloseTo(Math.cos(path.headingRadians) * Math.cos(pitch), 9);
      expect(state.velocity.x).toBeCloseTo(Math.sin(path.headingRadians) * state.airspeed, 9);
      expect(state.velocity.z).toBeCloseTo(Math.cos(path.headingRadians) * state.airspeed, 9);
      expect(state.simulationTime).toBeCloseTo(t, 12);
    }
    // Level in the cruise: exactly (sin h, 0, cos h).
    rotateVectorInto(forward, stateAt(path, 50).orientation, { x: 1, y: 0, z: 0 });
    expect(forward.y).toBeCloseTo(0, 12);
    expect(stateAt(path, 50).pitch).toBe(0);
    expect(stateAt(path, 20).pitch).toBeCloseTo(8, 9);
  });

  it("the settle holds the start, stopped, with its velocity down the runway", () => {
    const settle = writeSettleState(path, createBenchVisualState());
    const start = stateAt(path, 0);
    expect(settle.position).toEqual(start.position);
    expect(settle.orientation).toEqual(start.orientation);
    expect(settle.airspeed).toBe(0);
    expect(settle.simulationTime).toBe(0);
    expect(Math.hypot(settle.velocity.x, settle.velocity.z)).toBeCloseTo(BENCH_SETTLE_CREEP, 12);
    expect(settle.velocity.x).toBeCloseTo(Math.sin(path.headingRadians) * BENCH_SETTLE_CREEP, 12);
  });

  it("never touches the shared INITIAL_VISUAL_STATE (critique S5)", () => {
    const before = JSON.stringify(INITIAL_VISUAL_STATE);
    const state = createBenchVisualState();
    for (const key of ["position", "velocity", "orientation", "angularVelocity"] as const) {
      expect(state[key]).not.toBe(INITIAL_VISUAL_STATE[key]);
    }
    writeFlightState(path, 40, state);
    writeSettleState(path, state);
    expect(JSON.stringify(INITIAL_VISUAL_STATE)).toBe(before);
    // The same object comes back, nested objects and all: nothing is allocated.
    const position = state.position;
    expect(writeFlightState(path, 12, state)).toBe(state);
    expect(state.position).toBe(position);
  });

  it("clamps t to the profile and stays finite past the flight's end", () => {
    expect(snapshot(stateAt(path, -5))).toBe(snapshot(stateAt(path, 0)));
    const late = stateAt(path, 10_000);
    expect(Number.isFinite(late.position.y)).toBe(true);
    expect(late.simulationTime).toBeLessThanOrEqual(standard.flightS + 1.1);
  });

  it("pins its fingerprint, and the fingerprint sees the profile", () => {
    expect(path.fingerprint).toBe(expectedPathFingerprint(false));
    expect(createBenchPath(world, benchTimings(true)).fingerprint).toBe(expectedPathFingerprint(true));
    const nudged = new Float64Array(path.altitude);
    nudged[400] = nudged[400]! + 0.2;
    expect(pathFingerprint({ ...path, altitude: nudged }, world.seed)).not.toBe(path.fingerprint);
    expect(pathFingerprint(path, `${world.seed}x`)).not.toBe(path.fingerprint);
    const summary = benchPathSummary(path, expectedPathFingerprint(false));
    expect(summary).toMatchObject({
      route: "runway",
      rollEndS: 15,
      climbEndS: 30,
      rollSpeed: 60,
      cruiseSpeed: 120,
      clearance: 150,
      matchesExpected: true,
    });
    expect(summary.distanceM).toBeCloseTo(7_200, 6);
    expect(benchPathSummary(path, "ffffffff").matchesExpected).toBe(false);
  });

  it("a world with no airport cruises from the airborne spawn instead", () => {
    const noAirport: WorldDefinition = { ...world, airport: null, airports: [] };
    const airborne = createBenchPath(noAirport, standard);
    const spawn = createSimulationSpawn(noAirport, "airborne", 450, "trainer");
    expect(airborne.route).toBe("airborne");
    expect(airborne.startX).toBe(spawn.position?.x);
    expect(airborne.startZ).toBe(spawn.position?.z);
    expect(benchPathSpeed(airborne, 0)).toBe(BENCH_CRUISE_SPEED);
    const start = stateAt(airborne, 0);
    expect(start.onGround).toBe(false);
    expect(start.altitudeAgl).toBeGreaterThan(30);
    const settle = writeSettleState(airborne, createBenchVisualState());
    expect(settle.airspeed).toBe(BENCH_CRUISE_SPEED);
    expect(airborne.fingerprint).not.toBe(path.fingerprint);
  });
});
