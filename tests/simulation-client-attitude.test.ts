import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extrapolateFlightState } from "../src/game/SimulationClient";
import { flyAt } from "./support/visualStateFromSimulator";
import { readSource } from "./support/sourceText";

/**
 * The renderer's EXTRAPOLATED state must carry the simulator's attitude, sign for
 * sign.
 *
 * `extrapolateFlightState` bridges a late snapshot (up to 50 ms) and re-derives
 * heading, pitch and bank from the predicted orientation
 * (`updateVisualAnglesFromOrientation`). It did that under a comment that called
 * body +Z PORT, which D-6 corrected on 2026-09-01: +Z is starboard. Its `bank` was
 * therefore the NEGATIVE of the simulator's, while its heading and pitch were
 * right. Nothing read bank from the render state, so it never showed; the moment
 * an instrument does, a late frame flicks the attitude ball to the wrong bank.
 *
 * WHAT A SELF-CONSISTENT TEST WOULD MISS. Feeding the helper a quaternion and
 * asserting the angle it returns against the same formula only proves the formula
 * agrees with itself. This holds it to the SIMULATOR: each case is spawned in a
 * real `FlightSimulator` at a known attitude and the expected angles are the
 * ones its telemetry reports, converted the way the worker converts them.
 * `tests/support/visualStateFromSimulator.ts` is that conversion, and the last
 * test here pins it to the worker's source.
 */

const CASES: readonly (readonly [string, number, number, number])[] = [
  ["level", 0, 0, 0],
  ["right bank, climbing", 30, 5, 20],
  ["left bank, climbing", 30, 5, -20],
  ["right bank, nose down", 300, -8, 20],
  ["left bank, nose down", 120, -8, -35],
  ["steep right bank", 90, 0, 60],
  ["nose up, wings level", 200, 12, 0],
];

/** Difference of two headings in degrees, on the circle. */
function headingDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

describe("an extrapolated frame carries the simulator's attitude", () => {
  it.each(CASES)("%s: heading, pitch and bank equal the simulator's, for zero and for a real extrapolation", (_label, heading, pitch, bank) => {
    const { state } = flyAt(heading, pitch, bank);
    // The cases would prove nothing if the simulator itself did not report the
    // attitude asked for: this is the ground truth the extrapolation is held to.
    expect(state.pitch).toBeCloseTo(pitch, 6);
    expect(state.bank).toBeCloseTo(bank, 6);
    for (const seconds of [0, 0.02, 0.05]) {
      const extrapolated = extrapolateFlightState(state, seconds);
      expect(headingDifference(extrapolated.heading, state.heading), `heading after ${seconds} s`).toBeLessThan(1e-6);
      expect(extrapolated.pitch, `pitch after ${seconds} s`).toBeCloseTo(state.pitch, 6);
      // Zero angular velocity, so the orientation does not move and the answer
      // is exact: any difference here is the helper, not the prediction.
      expect(extrapolated.bank, `bank after ${seconds} s`).toBeCloseTo(state.bank, 6);
    }
  });

  it("is only a test of the sign if the banks it uses are large and of both senses", () => {
    const banks = CASES.map(([, , , bank]) => bank);
    expect(Math.max(...banks)).toBeGreaterThan(30);
    expect(Math.min(...banks)).toBeLessThan(-30);
    // and one case each way round at the same pitch and heading, so that a
    // flipped sign cannot be hidden by a pitch or heading term
    const right = flyAt(30, 5, 20).state;
    const left = flyAt(30, 5, -20).state;
    expect(extrapolateFlightState(right, 0.02).bank).toBeGreaterThan(19);
    expect(extrapolateFlightState(left, 0.02).bank).toBeLessThan(-19);
  });

  it("converts the simulator's numbers the way the worker does (the helper is a copy, and this pins it)", () => {
    const worker = readSource(join(__dirname, "../src/workers/simulation.worker.ts"));
    for (const line of [
      "airspeed: telemetry.indicatedAirspeed,",
      "altitudeAgl: telemetry.altitudeAgl,",
      "altitude: telemetry.altitude,",
      "verticalSpeed: telemetry.verticalSpeed,",
      "heading: (telemetry.heading * 180) / Math.PI,",
      "pitch: (telemetry.pitch * 180) / Math.PI,",
      "bank: (telemetry.bank * 180) / Math.PI,",
      "engineRpm: snapshot.engineRpm,",
    ]) {
      expect(worker, `the worker no longer says ${line}`).toContain(line);
    }
  });
});
