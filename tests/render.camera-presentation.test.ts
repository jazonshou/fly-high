import { describe, expect, it } from "vitest";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import { AIRCRAFT_KINDS } from "../src/sim";
import {
  CHASE_AIM_HEIGHT_METERS,
  chaseRigOffsetsToRef,
  CAMERA_RESPONSE_SECONDS,
  CAMERA_RESPONSE_SECONDS_REDUCED_MOTION,
  cameraBankFollow,
  cameraPresentationResponse,
  cameraRigLiftToRef,
  cameraTrailMeters,
  orthogonalizeCameraUpToRef,
  shouldStabilizeCameraHorizon,
  smoothCameraVectorToRef,
} from "../src/render/cameraPresentation";

describe("camera presentation", () => {
  it("restores restrained exterior bank while keeping cockpit physical", () => {
    expect(cameraBankFollow("chase", false)).toBe(0.18);
    expect(cameraBankFollow("cinematic", false)).toBe(0.3);
    expect(cameraBankFollow("chase", true)).toBe(0);
    expect(cameraBankFollow("cinematic", true)).toBe(0);
    expect(cameraBankFollow("cockpit", false)).toBe(1);
    expect(cameraBankFollow("cockpit", true)).toBe(1);
  });

  it("stabilizes exterior views while preserving cockpit roll", () => {
    expect(shouldStabilizeCameraHorizon("chase", true)).toBe(true);
    expect(shouldStabilizeCameraHorizon("cinematic", true)).toBe(true);
    expect(shouldStabilizeCameraHorizon("cockpit", true)).toBe(false);
  });

  it("retains aircraft roll when stabilization is disabled", () => {
    expect(shouldStabilizeCameraHorizon("chase", false)).toBe(false);
    expect(shouldStabilizeCameraHorizon("cinematic", false)).toBe(false);
  });

  it("67b: bounds exterior target and up deltas with one rig response", () => {
    const current = { x: 0, y: 0, z: 0 };
    const desired = { x: 12, y: 3, z: -6 };
    const currentUp = { x: 0, y: 1, z: 0 };
    const desiredUp = { x: 0.5, y: Math.SQRT1_2, z: -0.5 };
    const response = cameraPresentationResponse("chase", false, 1 / 60, false);
    const targetDeltas: number[] = [];
    const upDeltas: number[] = [];
    for (let frame = 0; frame < 12; frame += 1) {
      const before = { ...current };
      const beforeUp = { ...currentUp };
      smoothCameraVectorToRef(current, desired, response, current);
      smoothCameraVectorToRef(currentUp, desiredUp, response, currentUp);
      targetDeltas.push(Math.hypot(
        current.x - before.x,
        current.y - before.y,
        current.z - before.z,
      ));
      upDeltas.push(Math.hypot(
        currentUp.x - beforeUp.x,
        currentUp.y - beforeUp.y,
        currentUp.z - beforeUp.z,
      ));
    }

    expect(response).toBeGreaterThan(0);
    expect(response).toBeLessThan(1);
    expect(targetDeltas[0]).toBeLessThan(Math.hypot(12, 3, -6));
    expect(upDeltas[0]).toBeLessThan(Math.hypot(0.5, Math.SQRT1_2 - 1, -0.5));
    for (let index = 1; index < targetDeltas.length; index += 1) {
      expect(targetDeltas[index]!).toBeLessThan(targetDeltas[index - 1]!);
      expect(upDeltas[index]!).toBeLessThan(upDeltas[index - 1]!);
    }
  });

  it("67b: keeps cockpit exact and snaps every rig vector on a camera cut", () => {
    expect(cameraPresentationResponse("cockpit", false, 1 / 60, false)).toBe(1);
    expect(cameraPresentationResponse("chase", true, 1 / 60, false)).toBe(1);
    const current = { x: 1, y: 2, z: 3 };
    const desired = { x: -4, y: 5, z: 8 };
    smoothCameraVectorToRef(current, desired, 1, current);
    expect(current).toEqual(desired);
  });

  it("keeps camera up normalized and orthogonal to a changing view", () => {
    const up = { x: 0.2, y: 0.95, z: 0.4 };
    const view = { x: 4, y: 1, z: -7 };
    orthogonalizeCameraUpToRef(up, view, { x: 1, y: 0, z: 0 }, up);

    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 12);
    expect(up.x * view.x + up.y * view.y + up.z * view.z).toBeCloseTo(0, 12);

    // Both preferred vectors may be parallel to the view during a degenerate
    // cut. The helper still chooses a deterministic perpendicular basis.
    const degenerate = { x: 0, y: 0, z: 3 };
    orthogonalizeCameraUpToRef(
      degenerate,
      { x: 0, y: 0, z: -5 },
      { x: 0, y: 0, z: 1 },
      degenerate,
    );
    expect(Math.hypot(degenerate.x, degenerate.y, degenerate.z)).toBeCloseTo(1, 12);
    expect(degenerate.z).toBeCloseTo(0, 12);
  });

  it("attenuates variable-delta aircraft-up noise in chase presentation", () => {
    const simulate = (bankFollow: number): number[] => {
      const current = { x: 0, y: 1, z: 0 };
      const view = { x: 0, y: 0, z: -1 };
      const rolls: number[] = [];
      let elapsed = 0;
      const deltas = [1 / 30, 1 / 120, 1 / 60, 1 / 90, 1 / 45, 1 / 120];
      for (let frame = 0; frame < 90; frame += 1) {
        const delta = deltas[frame % deltas.length]!;
        elapsed += delta;
        const physicalRoll = 0.38 * Math.sin(elapsed * 1.2) + (frame % 2 === 0 ? 0.018 : -0.018);
        const physicalUp = { x: Math.sin(physicalRoll), y: Math.cos(physicalRoll), z: 0 };
        const desired = {
          x: physicalUp.x * bankFollow,
          y: 1 + (physicalUp.y - 1) * bankFollow,
          z: 0,
        };
        const desiredLength = Math.hypot(desired.x, desired.y, desired.z);
        desired.x /= desiredLength;
        desired.y /= desiredLength;
        const response = cameraPresentationResponse("chase", false, delta, false);
        smoothCameraVectorToRef(current, desired, response, current);
        orthogonalizeCameraUpToRef(current, view, physicalUp, current);
        rolls.push(Math.atan2(current.x, current.y));
      }
      return rolls;
    };

    const chase = simulate(cameraBankFollow("chase", false));
    const fullPhysical = simulate(1);
    const highFrequencyEnergy = (values: number[]): number => {
      let energy = 0;
      for (let index = 2; index < values.length; index += 1) {
        energy += Math.abs(values[index]! - 2 * values[index - 1]! + values[index - 2]!);
      }
      return energy;
    };

    expect(Math.max(...chase.map(Math.abs))).toBeLessThan(0.08);
    expect(highFrequencyEnergy(chase)).toBeLessThan(highFrequencyEnergy(fullPhysical) * 0.25);
  });

  describe("rig lift", () => {
    const lift = (
      forward: [number, number, number],
      up: [number, number, number],
      follow: number,
    ) => {
      const result = { x: 0, y: 0, z: 0 };
      cameraRigLiftToRef(
        { x: forward[0], y: forward[1], z: forward[2] },
        { x: up[0], y: up[1], z: up[2] },
        follow,
        result,
      );
      return result;
    };
    /** Body axes at a given pitch and bank, nose along world +X (D-6). */
    const attitude = (pitch: number, bank: number) => {
      const forward: [number, number, number] = [Math.cos(pitch), Math.sin(pitch), 0];
      // Up at zero bank, then rolled about the nose.
      const up0: [number, number, number] = [-Math.sin(pitch), Math.cos(pitch), 0];
      const starboard: [number, number, number] = [0, 0, 1];
      const up: [number, number, number] = [
        up0[0] * Math.cos(bank) - starboard[0] * Math.sin(bank),
        up0[1] * Math.cos(bank) - starboard[1] * Math.sin(bank),
        up0[2] * Math.cos(bank) - starboard[2] * Math.sin(bank),
      ];
      return { forward, up, up0 };
    };

    it("leaves a wings-level rig untouched at any pitch or heading", () => {
      // The whole point of blending from wings-level rather than from world
      // up: every unbanked frame is bit-identical to lifting along the
      // aircraft's own up.
      //
      // THIS COMMENT USED TO SAY "which is every perf-capture shot", AND THAT
      // IS NOT TRUE. Two of the thirty-nine are banked on purpose —
      // `motion-banked-turn` at 45 degrees and `page-thrash-turn` at 60 — so
      // this proof covers thirty-seven of them and not those two. The claim
      // mattered because it is what a promotion leans on when it asks whether
      // a rig change can move a baseline: for those two shots the answer is
      // "yes, by design", and the case that covers them is the next test
      // down, `adopts exactly the bank the view adopts`.
      for (const pitch of [0, 0.1, -0.25, 0.6]) {
        for (const heading of [0, 1.2, -2.7, Math.PI]) {
          const { forward, up } = attitude(pitch, 0);
          const rotated: [number, number, number] = [
            forward[0] * Math.cos(heading) - forward[2] * Math.sin(heading),
            forward[1],
            forward[0] * Math.sin(heading) + forward[2] * Math.cos(heading),
          ];
          const rotatedUp: [number, number, number] = [
            up[0] * Math.cos(heading) - up[2] * Math.sin(heading),
            up[1],
            up[0] * Math.sin(heading) + up[2] * Math.cos(heading),
          ];
          const result = lift(rotated, rotatedUp, cameraBankFollow("chase", false));
          expect(result.x).toBeCloseTo(rotatedUp[0], 10);
          expect(result.y).toBeCloseTo(rotatedUp[1], 10);
          expect(result.z).toBeCloseTo(rotatedUp[2], 10);
        }
      }
    });

    it("adopts exactly the bank the view adopts", () => {
      // The defect was that the rig lifted along the aircraft's up at full
      // strength while the view rolled only 18% of the way there. Both now
      // sit at the same roll angle, which is what keeps the airframe centred.
      const bank = 0.35;
      const { forward, up, up0 } = attitude(0.08, bank);
      for (const follow of [0, 0.18, 0.3, 1]) {
        const result = lift(forward, up, follow);
        const expected = {
          x: up0[0] + (up[0] - up0[0]) * follow,
          y: up0[1] + (up[1] - up0[1]) * follow,
          z: up0[2] + (up[2] - up0[2]) * follow,
        };
        const length = Math.hypot(expected.x, expected.y, expected.z);
        expect(result.x).toBeCloseTo(expected.x / length, 10);
        expect(result.y).toBeCloseTo(expected.y / length, 10);
        expect(result.z).toBeCloseTo(expected.z / length, 10);
      }
    });

    it("reproduces the aircraft's own up when the view follows bank fully", () => {
      const { forward, up } = attitude(0.12, -0.4);
      const result = lift(forward, up, cameraBankFollow("cockpit", false));
      expect(result.x).toBeCloseTo(up[0], 10);
      expect(result.y).toBeCloseTo(up[1], 10);
      expect(result.z).toBeCloseTo(up[2], 10);
    });

    it("holds the wings-level vertical under reduced motion", () => {
      const { forward, up, up0 } = attitude(0.05, 0.5);
      const result = lift(forward, up, cameraBankFollow("chase", true));
      expect(result.x).toBeCloseTo(up0[0], 10);
      expect(result.y).toBeCloseTo(up0[1], 10);
      expect(result.z).toBeCloseTo(up0[2], 10);
    });

    it("falls back to the aircraft's up when the nose is vertical", () => {
      // "Wings level" has no meaning straight up; the rig must not divide by a
      // vanishing horizontal component.
      const up = { x: -1, y: 0, z: 0 };
      const result = { x: 0, y: 0, z: 0 };
      cameraRigLiftToRef({ x: 0, y: 1, z: 0 }, up, 0.18, result);
      expect(result).toEqual(up);
    });
  });

  describe("trail", () => {
    it("is zero for an aeroplane that is not moving", () => {
      // The lag this replaces was produced by MOTION, so a stationary
      // aeroplane never had one. Deriving the trail from the airspeed field
      // instead pushed the camera tens of metres back in every chase shot of
      // the perf set, where the position is held fixed while an airspeed is
      // declared: 30% to 99% of pixels moved against a same-arm noise floor
      // under 1%. That is the whole reason this argument is a ground speed.
      expect(cameraTrailMeters("chase", false, 0)).toBe(0);
      expect(cameraTrailMeters("cinematic", false, 0)).toBe(0);
    });

    it("matches the steady-state error the old absolute smoothing produced", () => {
      // A first-order lag chasing a target moving at constant speed settles
      // speed*tau behind it. Measured in-game before the fix: 7.1 m of lag at
      // roughly 50 m/s, and 16 m at 140.
      expect(cameraTrailMeters("chase", false, 50)).toBeCloseTo(50 * CAMERA_RESPONSE_SECONDS, 10);
      expect(cameraTrailMeters("chase", false, 140)).toBeCloseTo(140 * CAMERA_RESPONSE_SECONDS, 10);
      expect(cameraTrailMeters("chase", false, 50)).toBeGreaterThan(7);
      expect(cameraTrailMeters("chase", false, 50)).toBeLessThan(7.5);
    });

    it("shortens with the faster reduced-motion response", () => {
      expect(cameraTrailMeters("chase", true, 50))
        .toBeCloseTo(50 * CAMERA_RESPONSE_SECONDS_REDUCED_MOTION, 10);
      expect(cameraTrailMeters("chase", true, 50))
        .toBeLessThan(cameraTrailMeters("chase", false, 50));
    });

    it("applies only to the rigs that trail the aircraft", () => {
      expect(cameraTrailMeters("cockpit", false, 140)).toBe(0);
      expect(cameraTrailMeters("freefly", false, 140)).toBe(0);
      expect(cameraTrailMeters("cinematic", false, 50))
        .toBeCloseTo(50 * CAMERA_RESPONSE_SECONDS, 10);
    });

    it("refuses to trail on a negative or non-finite speed", () => {
      expect(cameraTrailMeters("chase", false, -20)).toBe(0);
      expect(cameraTrailMeters("chase", false, Number.NaN)).toBe(0);
    });
  });

  describe("the composed chase rig", () => {
    /** The rig exactly as it stood before the tilt fix. */
    function legacyOffsets(
      forward: { x: number; y: number; z: number },
      up: { x: number; y: number; z: number },
      distance: number,
      height: number,
      aimAhead: number,
    ) {
      return {
        camera: {
          x: -forward.x * distance + up.x * height,
          y: -forward.y * distance + up.y * height,
          z: -forward.z * distance + up.z * height,
        },
        target: {
          x: forward.x * aimAhead + up.x * CHASE_AIM_HEIGHT_METERS,
          y: forward.y * aimAhead + up.y * CHASE_AIM_HEIGHT_METERS,
          z: forward.z * aimAhead + up.z * CHASE_AIM_HEIGHT_METERS,
        },
      };
    }

    /** Body axes at a heading, pitch and bank, nose along world +X at zero. */
    function attitude(heading: number, pitch: number, bank: number) {
      const nose = { x: Math.cos(pitch), y: Math.sin(pitch), z: 0 };
      const level = { x: -Math.sin(pitch), y: Math.cos(pitch), z: 0 };
      const starboard = { x: 0, y: 0, z: 1 };
      const rolled = {
        x: level.x * Math.cos(bank) - starboard.x * Math.sin(bank),
        y: level.y * Math.cos(bank) - starboard.y * Math.sin(bank),
        z: level.z * Math.cos(bank) - starboard.z * Math.sin(bank),
      };
      const yaw = (v: { x: number; y: number; z: number }) => ({
        x: v.x * Math.cos(heading) - v.z * Math.sin(heading),
        y: v.y,
        z: v.x * Math.sin(heading) + v.z * Math.cos(heading),
      });
      return { forward: yaw(nose), up: yaw(rolled) };
    }

    function rig(
      forward: { x: number; y: number; z: number },
      up: { x: number; y: number; z: number },
      follow: number,
      distance: number,
      height: number,
      aimAhead: number,
      trail: number,
    ) {
      const lift = { x: 0, y: 0, z: 0 };
      cameraRigLiftToRef(forward, up, follow, lift);
      const camera = { x: 0, y: 0, z: 0 };
      const target = { x: 0, y: 0, z: 0 };
      chaseRigOffsetsToRef(
        forward, lift, distance, height, aimAhead, CHASE_AIM_HEIGHT_METERS, trail, camera, target,
      );
      return { camera, target };
    }

    it("is bit-for-bit the old rig on an unbanked, stationary aeroplane", () => {
      // The claim the perf captures could not settle: at zero bank and zero
      // motion this rig IS the pre-fix rig. Two identical capture runs on this
      // machine moved 30% of a frame at maxima of 170/255, which is far too
      // blunt to clear a camera change; the arithmetic is not.
      //
      // Every perf-capture shot is unbanked by construction —
      // `orientationFromYawPitchBank(yaw, pitch, 0)` — and holds a fixed
      // position, so this is the statement that they cannot move.
      for (const heading of [0, 0.7, -2.1, Math.PI]) {
        for (const pitch of [0, 0.12, -0.3, 0.45]) {
          const { forward, up } = attitude(heading, pitch, 0);
          const fixed = rig(forward, up, cameraBankFollow("chase", false), 13.5, 5.1, 16, 0);
          const legacy = legacyOffsets(forward, up, 13.5, 5.1, 16);
          for (const axis of ["x", "y", "z"] as const) {
            expect(fixed.camera[axis]).toBeCloseTo(legacy.camera[axis], 12);
            expect(fixed.target[axis]).toBeCloseTo(legacy.target[axis], 12);
          }
        }
      }
    });

    it("is the old rig at every airframe, attitude and DECLARED airspeed", () => {
      // The declared-airspeed-with-zero-motion case explicitly, because that
      // is the one that bit: a perf shot holds a fixed position while naming
      // an airspeed, and a trail keyed on the declared speed rather than on
      // observed travel pushed the camera tens of metres back in every chase
      // shot. `cameraTrailMeters` is fed the OBSERVED speed, which is zero
      // there however fast the aeroplane claims to be going.
      for (const kind of AIRCRAFT_KINDS) {
        for (const airspeed of [0, 40, 56, 120, 155, 210, 260]) {
          const profile = chaseCameraProfile(kind, airspeed);
          const trail = cameraTrailMeters("chase", false, 0);
          expect(trail).toBe(0);
          for (const heading of [0, 1.9, -0.8]) {
            for (const pitch of [0, 0.2, -0.15]) {
              const { forward, up } = attitude(heading, pitch, 0);
              const fixed = rig(
                forward, up, cameraBankFollow("chase", false),
                profile.distance, profile.height, profile.aimAhead, trail,
              );
              const legacy = legacyOffsets(
                forward, up, profile.distance, profile.height, profile.aimAhead,
              );
              for (const axis of ["x", "y", "z"] as const) {
                expect(fixed.camera[axis]).toBeCloseTo(legacy.camera[axis], 12);
                expect(fixed.target[axis]).toBeCloseTo(legacy.target[axis], 12);
              }
            }
          }
        }
      }
    });

    it("lands a camera cut on the settled pose in one frame", () => {
      // The offsets are persistent state, so a cut has to seed them or the
      // first frames of every shot would be a convergence transient rather
      // than the rig. `cameraPresentationResponse` returns exactly 1 on a cut
      // and the smoother then writes the desired value through untouched —
      // which is what makes the first rendered frame the settled one.
      for (const mode of ["chase", "cinematic"] as const) {
        expect(cameraPresentationResponse(mode, true, 1 / 60, false)).toBe(1);
      }
      const settled = { x: -13.5, y: 5.1, z: 0 };
      const stale = { x: 900, y: -40, z: 17 };
      const result = { x: 0, y: 0, z: 0 };
      smoothCameraVectorToRef(stale, settled, 1, result);
      // Close, not equal: the smoother is `a + (b - a) * amount`, and at
      // amount 1 that is b only to within rounding — 5.100000000000001 here,
      // from a stale value of -40. A nanometre of camera, and worth pinning
      // as closeness rather than pretending it is exact.
      for (const axis of ["x", "y", "z"] as const) {
        expect(result[axis]).toBeCloseTo(settled[axis], 12);
      }
    });

    it("carries the trail on both offsets, so the view direction is unchanged", () => {
      const { forward, up } = attitude(0.4, 0.1, 0);
      const follow = cameraBankFollow("chase", false);
      const without = rig(forward, up, follow, 13.5, 5.1, 16, 0);
      // 10 m of trail against a 16 m aim. This used to read 20, which the aim
      // clamp now shortens to 12 — 20 m of trail on a 16 m aim is the very
      // case the clamp exists for, since it aims the camera 4 m BEHIND the
      // aeroplane. The invariant under test is unchanged: whatever trail is
      // actually applied goes on both offsets, so the view direction is the
      // same. The clamped case is covered below.
      const with20 = rig(forward, up, follow, 13.5, 5.1, 16, 10);
      const direction = (r: typeof without) => ({
        x: r.target.x - r.camera.x,
        y: r.target.y - r.camera.y,
        z: r.target.z - r.camera.z,
      });
      const a = direction(without);
      const b = direction(with20);
      for (const axis of ["x", "y", "z"] as const) expect(b[axis]).toBeCloseTo(a[axis], 12);
      // And the camera really did move back by the trail, along the NOSE.
      const back = Math.hypot(
        with20.camera.x - without.camera.x,
        with20.camera.y - without.camera.y,
        with20.camera.z - without.camera.z,
      );
      expect(back).toBeCloseTo(10, 10);
    });

    it("keeps the view direction unchanged even when the aim clamp shortens the trail", () => {
      // The clamp must shorten the trail, not tilt the camera. Both offsets
      // have to use the SAME shortened value or the rig would swing as an
      // aeroplane accelerated through the clamp point, which is exactly the
      // sort of thing a player notices and nobody can describe.
      const { forward, up } = attitude(0.4, 0.1, 0);
      const follow = cameraBankFollow("chase", false);
      const unclamped = rig(forward, up, follow, 13.5, 5.1, 16, 0);
      const clamped = rig(forward, up, follow, 13.5, 5.1, 16, 40);
      const direction = (r: typeof unclamped) => ({
        x: r.target.x - r.camera.x,
        y: r.target.y - r.camera.y,
        z: r.target.z - r.camera.z,
      });
      const a = direction(unclamped);
      const b = direction(clamped);
      for (const axis of ["x", "y", "z"] as const) expect(b[axis]).toBeCloseTo(a[axis], 12);
      // 40 m of trail on a 16 m aim is shortened to 12, not applied whole.
      const back = Math.hypot(
        clamped.camera.x - unclamped.camera.x,
        clamped.camera.y - unclamped.camera.y,
        clamped.camera.z - unclamped.camera.z,
      );
      expect(back).toBeCloseTo(12, 10);
    });

    it("does move a banked frame, which is the whole point", () => {
      // The two shots in the canonical perf set that bank — page-thrash-turn
      // at 60 degrees and motion-banked-turn at 45 — are expected to move, and
      // measured at 99.99% of pixels. If this ever stops differing, the fix
      // has been reverted.
      const follow = cameraBankFollow("chase", false);
      for (const bank of [(45 * Math.PI) / 180, (60 * Math.PI) / 180]) {
        const { forward, up } = attitude(0, 0, bank);
        const fixed = rig(forward, up, follow, 13.5, 5.1, 16, 0);
        const legacy = legacyOffsets(forward, up, 13.5, 5.1, 16);
        const moved = Math.hypot(
          fixed.camera.x - legacy.camera.x,
          fixed.camera.y - legacy.camera.y,
          fixed.camera.z - legacy.camera.z,
        );
        // Metres, not millimetres: at these angles the old rig hung the camera
        // right out to one side of the aeroplane.
        expect(moved).toBeGreaterThan(1.5);
      }
    });
  });
});
