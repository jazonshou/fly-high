import { describe, expect, it } from "vitest";
import {
  CAMERA_GROUND_SPEED_HELD_FRAMES,
  CAMERA_GROUND_SPEED_MIN_SIM_DELTA_SECONDS,
  nextObservedGroundSpeed,
  type CameraGroundSpeed,
} from "../src/render/cameraGroundSpeed";
import { cameraTrailMeters } from "../src/render/cameraPresentation";

/**
 * B2: the chase trail's ground speed is the distance flown over the
 * SIMULATION time it took, so a hitch or a late snapshot no longer pulls the
 * camera back or snaps it in, while a steady frame is framed exactly as
 * before.
 */

/** The renderer's clamp on the delta FlightGame hands it (`render`). */
const clampWall = (seconds: number): number => Math.max(1 / 300, Math.min(0.1, seconds));
/** FlightGame's clamp on the real frame interval (its render loop). */
const gameDelta = (seconds: number): number => Math.min(0.1, Math.max(1 / 240, seconds));
/** What the renderer computed before B2. */
const oldFormula = (travelled: number, wall: number): number => travelled / Math.max(1e-4, wall);

interface Frame {
  readonly wall: number;
  readonly sim: number;
  readonly travelled: number;
}

/** Runs frames through the helper as the renderer does, from a settled `start` speed. */
function fly(frames: readonly Frame[], start: number, holdWhenFrozen = true): CameraGroundSpeed[] {
  let state: CameraGroundSpeed = { speed: start, heldFrames: 0 };
  const speeds: CameraGroundSpeed[] = [];
  for (const frame of frames) {
    state = nextObservedGroundSpeed({
      travelled: frame.travelled,
      wallDeltaSeconds: clampWall(frame.wall),
      simDeltaSeconds: frame.sim,
      previous: state.speed,
      heldFrames: state.heldFrames,
      holdWhenFrozen,
    });
    speeds.push(state);
  }
  return speeds;
}

describe("the chase camera's observed ground speed", () => {
  it("is the old wall-clock division, bit for bit, on a steady frame", () => {
    const speeds = [0, 12.5, 60, 251.3];
    for (const wall of [1 / 60, 1 / 120, 1 / 144, 0.0213]) {
      // As the perf harness steps it: simulation time accumulated in sixtieths,
      // so the difference is the delta to within a rounding error.
      const time = 500 + 37 / 60;
      const sim = (time + wall) - time;
      for (const speed of speeds) {
        const travelled = speed * wall;
        for (const holdWhenFrozen of [true, false]) {
          const next = nextObservedGroundSpeed({
            travelled, wallDeltaSeconds: wall, simDeltaSeconds: sim, previous: 7, heldFrames: 0, holdWhenFrozen,
          });
          expect(Object.is(next.speed, oldFormula(travelled, wall)), `${wall} s at ${speed} m/s`).toBe(true);
          expect(next.heldFrames).toBe(0);
        }
      }
    }
    // Jitter inside half a millisecond is still a steady frame.
    const jittered = nextObservedGroundSpeed({
      travelled: 1, wallDeltaSeconds: 1 / 120, simDeltaSeconds: 1 / 120 + 0.0004, previous: 0, heldFrames: 0,
      holdWhenFrozen: true,
    });
    expect(Object.is(jittered.speed, oldFormula(1, 1 / 120))).toBe(true);
  });

  it("reads a 150 ms hitch at the true speed, where the 0.1 s clamp read it 1.5x", () => {
    const [hitch] = fly([{ wall: 0.15, sim: 0.15, travelled: 60 * 0.15 }], 60);
    expect(hitch!.speed).toBeCloseTo(60, 9);
    expect(oldFormula(60 * 0.15, clampWall(0.15))).toBeCloseTo(90, 9);
    // So the trail holds where it was instead of pulling back by half again.
    expect(cameraTrailMeters("chase", false, hitch!.speed))
      .toBeCloseTo(cameraTrailMeters("chase", false, 60), 9);
  });

  it("holds the speed through a frozen snapshot for three frames, then reads a pause as a stop", () => {
    // A late simulation snapshot: the pose's clock stands at the extrapolation
    // cap while the frames go on, so the pose does not move either.
    const frozen = { wall: 1 / 120, sim: 0, travelled: 0 };
    const speeds = fly(Array.from({ length: 6 }, () => frozen), 60);
    expect(CAMERA_GROUND_SPEED_HELD_FRAMES).toBe(3);
    expect(speeds.map((state) => state.speed)).toEqual([60, 60, 60, 0, 0, 0]);
    // A pinned (perf capture) renderer re-renders a shot's last state with no
    // simulation time passing: the old division at once, as before.
    const pinned = fly([{ wall: 1 / 60, sim: 0, travelled: 0 }], 60, false);
    expect(pinned[0]!.speed).toBe(0);
    expect(Object.is(
      fly([{ wall: 1 / 60, sim: 0, travelled: 0.3 }], 60, false)[0]!.speed,
      oldFormula(0.3, 1 / 60),
    )).toBe(true);
  });

  it("reads the catch-up frame after a freeze at the true speed", () => {
    // Two frozen frames, then the snapshot lands and the pose catches up the
    // three frames' worth of flight in one.
    const step = 1 / 120;
    const speeds = fly([
      { wall: step, sim: 0, travelled: 0 },
      { wall: step, sim: 0, travelled: 0 },
      { wall: step, sim: 3 * step, travelled: 80 * 3 * step },
      { wall: step, sim: step, travelled: 80 * step },
    ], 80);
    for (const state of speeds) expect(state.speed).toBeCloseTo(80, 9);
    // The old division read that frame at three times the speed.
    expect(oldFormula(80 * 3 * step, step)).toBeCloseTo(240, 9);
    expect(speeds[3]!.heldFrames).toBe(0);
  });

  it("keeps the old division where the simulation clock moved less than FlightGame's shortest frame", () => {
    expect(CAMERA_GROUND_SPEED_MIN_SIM_DELTA_SECONDS).toBe(1 / 240);
    // A new snapshot corrects an extrapolated pose half a metre in a frame
    // whose simulation clock moved a tenth of a millisecond: 5000 m/s over
    // the sliver, the old division's 60 m/s over the frame.
    for (const holdWhenFrozen of [true, false]) {
      const corrected = nextObservedGroundSpeed({
        travelled: 0.5, wallDeltaSeconds: 1 / 120, simDeltaSeconds: 1e-4, previous: 60, heldFrames: 2,
        holdWhenFrozen,
      });
      expect(Object.is(corrected.speed, oldFormula(0.5, 1 / 120))).toBe(true);
      expect(corrected.heldFrames).toBe(0);
    }
    // A 360 Hz display: FlightGame raises the frame delta to 1/240 s while
    // the simulation clock moves by the real 1/360 s, so a steady frame is
    // framed exactly as before.
    for (const hertz of [270, 360, 500]) {
      const real = 1 / hertz;
      const wall = clampWall(gameDelta(real));
      const travelled = 60 * real;
      const [steady] = fly([{ wall: gameDelta(real), sim: real, travelled }], 60);
      expect(Object.is(steady!.speed, oldFormula(travelled, wall)), `${hertz} Hz`).toBe(true);
    }
    // From FlightGame's shortest frame up, the clock's delta is the divisor:
    // the pose's clock reaches the extrapolation cap half way through a
    // 120 Hz frame, which the old division read at half the speed.
    const [capped] = fly([{ wall: 1 / 120, sim: 1 / 240, travelled: 70 / 240 }], 70);
    expect(capped!.speed).toBeCloseTo(70, 9);
    expect(oldFormula(70 / 240, 1 / 120)).toBeCloseTo(35, 9);
  });

  it("keeps the held count spent until the clock moves again", () => {
    const frozen = { wall: 1 / 60, sim: 0, travelled: 0 };
    const speeds = fly([...Array.from({ length: 5 }, () => frozen), { wall: 1 / 60, sim: 1 / 60, travelled: 1 }], 40);
    expect(speeds.map((state) => state.heldFrames)).toEqual([1, 2, 3, 3, 3, 0]);
    expect(speeds[5]!.speed).toBe(oldFormula(1, 1 / 60));
  });
});
