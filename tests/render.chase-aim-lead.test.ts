import { describe, expect, it } from "vitest";
import {
  cameraTrailMeters,
  chaseRigOffsetsToRef,
  CHASE_AIM_HEIGHT_METERS,
  MINIMUM_CHASE_AIM_AHEAD_METERS,
} from "../src/render/cameraPresentation";
import { aircraftSpec, rampAtSpeed } from "../src/aircraft/catalogue";
import { AIRCRAFT_KINDS } from "../src/sim";

/**
 * The chase camera must always aim AHEAD of the aircraft it is following.
 *
 * The trail term reproduces a camera lag that was calibrated against aeroplanes
 * doing 52 and 140 m/s, and it grows linearly with speed without limit. That
 * was fine while nothing flew much faster. An F-16 in reheat reaches 410 m/s,
 * where the raw trail is 58.6 m against a 30.5 m profile distance and drives
 * the aim point to MINUS 17.6 m — the camera looking at a spot behind the
 * aeroplane. The Global crosses zero too, around 250 m/s.
 *
 * This sweeps every airframe from a standstill past its own ceiling, so the
 * next fast aeroplane cannot reintroduce it.
 */

const FORWARD = { x: 1, y: 0, z: 0 } as const;
const LIFT = { x: 0, y: 1, z: 0 } as const;

describe("chase camera aim lead", () => {
  for (const kind of AIRCRAFT_KINDS) {
    it(`keeps the ${kind}'s aim point ahead of the aircraft at every speed`, () => {
      const chase = aircraftSpec(kind).chase;
      for (let speed = 0; speed <= 500; speed += 5) {
        const camera = { x: 0, y: 0, z: 0 };
        const target = { x: 0, y: 0, z: 0 };
        chaseRigOffsetsToRef(
          FORWARD, LIFT,
          rampAtSpeed(chase.distance, speed), chase.height,
          rampAtSpeed(chase.aimAhead, speed), CHASE_AIM_HEIGHT_METERS,
          cameraTrailMeters("chase", false, speed),
          camera, target,
        );
        expect(target.x, `${kind} at ${speed} m/s aims ${target.x.toFixed(1)} m along the nose`)
          .toBeGreaterThanOrEqual(MINIMUM_CHASE_AIM_AHEAD_METERS - 1e-9);
        // And the camera must stay behind the aeroplane, never in front of it.
        expect(camera.x).toBeLessThan(0);
      }
    });
  }

  it("leaves the slow end of the envelope exactly as it was", () => {
    // The clamp must not become a redesign. Across the speeds an aeroplane
    // can actually fly, nothing may move: the framing players already know is
    // the thing the trail exists to preserve. A Cessna 150 tops out near
    // 66 m/s, and the clamp does not begin to bite on its profile until about
    // 84, so its whole envelope is untouched.
    const chase = aircraftSpec("trainer").chase;
    for (const speed of [0, 30, 56, 66, 80]) {
      const trail = cameraTrailMeters("chase", false, speed);
      const aimAhead = rampAtSpeed(chase.aimAhead, speed);
      const camera = { x: 0, y: 0, z: 0 };
      const target = { x: 0, y: 0, z: 0 };
      chaseRigOffsetsToRef(
        FORWARD, LIFT, rampAtSpeed(chase.distance, speed), chase.height,
        aimAhead, CHASE_AIM_HEIGHT_METERS, trail, camera, target,
      );
      expect(target.x, `trainer at ${speed} m/s`).toBeCloseTo(aimAhead - trail, 9);
    }
  });

  it("only ever shortens the trail, never lengthens it", () => {
    const chase = aircraftSpec("jet").chase;
    for (let speed = 0; speed <= 500; speed += 25) {
      const trail = cameraTrailMeters("chase", false, speed);
      const distance = rampAtSpeed(chase.distance, speed);
      const camera = { x: 0, y: 0, z: 0 };
      const target = { x: 0, y: 0, z: 0 };
      chaseRigOffsetsToRef(
        FORWARD, LIFT, distance, chase.height,
        rampAtSpeed(chase.aimAhead, speed), CHASE_AIM_HEIGHT_METERS,
        trail, camera, target,
      );
      expect(-camera.x).toBeLessThanOrEqual(distance + trail + 1e-9);
      expect(-camera.x).toBeGreaterThanOrEqual(distance - 1e-9);
    }
  });
});
