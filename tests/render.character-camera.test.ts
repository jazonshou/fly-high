import { describe, expect, it } from "vitest";
import {
  CharacterCamera,
  rayBoxDistance,
  type CameraObstacleBox,
  type CharacterCameraFrame,
  type CharacterCameraWater,
} from "../src/render/characterCamera";
import { LatticeHeightCache } from "../src/render/latticeHeightCache";
import { PERSON } from "../src/vehicles/person";

/**
 * The walker's character camera (the walking plan, "Camera"): the orbit's
 * framing, the boom pulled in by the ground and the parked car and eased
 * back out, the look, the fade, and first person.
 */

function frame(overrides: Partial<CharacterCameraFrame> = {}): CharacterCameraFrame {
  return {
    feetX: 0,
    feetY: 0,
    feetZ: 0,
    facing: 0,
    lookYaw: 0,
    lookPitch: 0,
    zoom: 0,
    deltaSeconds: 1 / 60,
    firstPerson: false,
    groundHeight: () => 0,
    water: null,
    obstacles: [],
    sweep: null,
    ...overrides,
  };
}

describe("character camera", () => {
  it("orbits behind the walker's right shoulder at the default boom", () => {
    const camera = new CharacterCamera();
    camera.reset(0);
    camera.pitch = 0;
    const pose = camera.update(frame());
    // Facing north (+Z): behind is -Z, the right shoulder is -X.
    expect(pose.eyeZ).toBeCloseTo(-PERSON.camera.distance, 6);
    expect(pose.eyeX).toBeCloseTo(-PERSON.camera.shoulderOffset, 6);
    expect(pose.eyeY).toBeCloseTo(PERSON.camera.pivotHeight, 6);
    expect(pose.targetZ).toBeGreaterThan(5);
    expect(pose.fade).toBe(0);
  });

  it("turns right on a rightward look, and holds the pitch limits", () => {
    const camera = new CharacterCamera();
    camera.reset(0);
    camera.update(frame({ lookYaw: Math.PI / 2, lookPitch: 10 }));
    // A right turn from north faces -X, the heading less 90 degrees.
    expect(camera.heading).toBeCloseTo(-Math.PI / 2, 6);
    expect(camera.pitch).toBe(PERSON.camera.maxPitch);
    camera.update(frame({ lookPitch: -10 }));
    expect(camera.pitch).toBe(PERSON.camera.minPitch);
  });

  it("pulls the boom in at once against rising ground, and eases back out", () => {
    const camera = new CharacterCamera();
    camera.reset(0);
    camera.pitch = -0.3;
    // A wall of ground two metres behind the walker.
    const wall = (_x: number, z: number) => (z < -2 ? 10 : 0);
    const pulled = camera.update(frame({ groundHeight: wall }));
    expect(pulled.eyeZ).toBeGreaterThan(-2);
    const free = frame();
    const next = camera.update(free);
    expect(next.eyeZ).toBeGreaterThan(-PERSON.camera.distance * Math.cos(0.3) + 0.1);
    for (let i = 0; i < 60; i += 1) camera.update(free);
    expect(camera.pose.eyeZ).toBeCloseTo(-PERSON.camera.distance * Math.cos(0.3), 2);
  });

  it("stops short of the parked car, and fades the figure when pushed close", () => {
    const camera = new CharacterCamera();
    camera.reset(0);
    camera.pitch = 0;
    const car: CameraObstacleBox = {
      centerX: 0, centerY: 1, centerZ: -1.6, halfX: 2.4, halfY: 0.9, halfZ: 0.9,
      qx: 0, qy: 0, qz: 0, qw: 1,
    };
    const pose = camera.update(frame({ obstacles: [car] }));
    expect(pose.eyeZ).toBeGreaterThan(-0.7 + PERSON.camera.probeRadius - 0.01);
    expect(pose.fade).toBeGreaterThan(0);
  });

  it("stops short of what the static colliders' sweep meets", () => {
    const camera = new CharacterCamera();
    camera.reset(0);
    camera.pitch = 0;
    let asked: number[] = [];
    const wall = (fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, radius: number) => {
      asked = [fx, fy, fz, tx, ty, tz, radius];
      // A wall across z = -1.5: the probe touches it radius short of it.
      const touch = (fz - (-1.5 + radius)) / (fz - tz);
      return Math.min(1, Math.max(0, touch));
    };
    const pose = camera.update(frame({ sweep: wall }));
    expect(asked[6]).toBe(PERSON.camera.probeRadius);
    expect(pose.eyeZ).toBeCloseTo(-1.5 + PERSON.camera.probeRadius, 6);
  });

  it("puts the first-person eye in the head", () => {
    const camera = new CharacterCamera();
    camera.reset(0);
    const pose = camera.update(frame({ firstPerson: true, feetY: 5 }));
    expect(pose.eyeY).toBeCloseTo(5 + PERSON.eyeHeight, 6);
    expect(pose.fade).toBe(0);
  });

  it("keeps the eye on the head's side of the water, clear of the surface's band", () => {
    const camera = new CharacterCamera();
    camera.reset(0);
    camera.pitch = 0.6;
    // A sea whose surface rises toward the camera, with a 0.2 m band.
    const sea = (below: boolean): CharacterCameraWater => ({
      at(x, _y, z, out) {
        out.surface = 0.05 * z - 0.02 * x;
        out.clearance = 0.2;
        return true;
      },
      below,
    });
    // Swimming: the head is above, so the eye is above the band.
    const swimming = camera.update(frame({ feetY: -1.3, water: sea(false), groundHeight: () => -5 }));
    expect(swimming.eyeY).toBeGreaterThanOrEqual(0.05 * swimming.eyeZ - 0.02 * swimming.eyeX + 0.2 - 1e-9);
    // Diving, looking up from under: the eye stays under the band.
    camera.pitch = -0.6;
    const diving = camera.update(frame({ feetY: -0.9, water: sea(true), groundHeight: () => -5 }));
    expect(diving.eyeY).toBeLessThanOrEqual(0.05 * diving.eyeZ - 0.02 * diving.eyeX - 0.2 + 1e-9);
    // Dry ground asks nothing of the eye.
    camera.pitch = 0;
    const dry = camera.update(frame({ water: { at: () => false, below: false } }));
    expect(dry.eyeY).toBeCloseTo(PERSON.camera.pivotHeight, 6);
  });
});

describe("ray against a box", () => {
  it("hits a rotated box's grown face, and misses past it", () => {
    const half = Math.SQRT1_2;
    const box: CameraObstacleBox = {
      centerX: 0, centerY: 0, centerZ: 5, halfX: 1, halfY: 1, halfZ: 1,
      // 90 degrees about Y: a cube, so the face is still at z = 4.
      qx: 0, qy: half, qz: 0, qw: half,
    };
    expect(rayBoxDistance(0, 0, 0, 0, 0, 1, box, 0.2)).toBeCloseTo(3.8, 9);
    expect(rayBoxDistance(0, 3, 0, 0, 0, 1, box, 0.2)).toBe(Infinity);
    expect(rayBoxDistance(0, 0, 0, 0, 0, -1, box, 0.2)).toBe(Infinity);
  });
});

describe("lattice height cache", () => {
  it("is exact on a plane and asks its source once per node", () => {
    let asked = 0;
    const plane = (x: number, z: number) => {
      asked += 1;
      return 0.1 * x - 0.3 * z + 2;
    };
    const cache = new LatticeHeightCache(plane, 1, 64);
    expect(cache.sample(0.25, 0.75)).toBeCloseTo(plane(0.25, 0.75), 12);
    asked = 0;
    for (let i = 0; i < 10; i += 1) cache.sample(0.5, 0.5);
    expect(asked).toBe(0);
    for (let i = 0; i < 100; i += 1) cache.sample(i * 3, 0);
    expect(cache.size).toBeLessThanOrEqual(64);
  });
});
