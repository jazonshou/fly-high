import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { GLOBAL_FLOOR_Y, GLOBAL_SEAT, globalSeatPlacement } from "../src/render/webgpu/aircraft/bizjetSeats";

/**
 * The Global's crew seats stand where the pilots' eye says (phase 3c, part 2):
 * the cushion 0.80 m under `catalogue.cockpitEye`, so re-solving the eye moves
 * the seats with it. They were at fixed coordinates, the old box's top about
 * 0.60 -- above a seated eye at 0.55.
 */

let engine: NullEngine;
let scene: Scene;
let visual: AircraftVisual;
const eye = aircraftSpec("bizjet").cockpitEye;

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  visual = createWebGpuAircraft(scene, "bizjet");
});

afterAll(() => {
  visual.dispose();
  scene.dispose();
  engine.dispose();
});

const box = (name: string) => {
  const mesh = scene.getMeshByName(name) as Mesh;
  expect(mesh, name).toBeTruthy();
  mesh.computeWorldMatrix(true);
  mesh.refreshBoundingInfo();
  const { minimumWorld: min, maximumWorld: max, centerWorld: centre } = mesh.getBoundingInfo().boundingBox;
  return { min, max, centre };
};

describe("the Global's crew seats", () => {
  it("put the cushion 0.80 m under the catalogue's eye, the base on the floor, under each pilot", () => {
    for (const [name, side] of [["bizjet-first-officer", -1], ["bizjet-captain", 1]] as const) {
      const seat = box(`${name}-seat`);
      expect(seat.max.y, `${name}: cushion top`).toBeCloseTo(eye.up - GLOBAL_SEAT.cushionBelowEye, 5);
      expect(seat.min.y, `${name}: base`).toBeCloseTo(GLOBAL_FLOOR_Y, 5);
      expect(seat.centre.z).toBeCloseTo(side * Math.abs(eye.right), 5);
      expect(seat.centre.x).toBeCloseTo(eye.forward - GLOBAL_SEAT.behindEye, 5);
    }
  });

  it("stop the seat back at the shoulders and let only the headrest reach past the eye", () => {
    for (const name of ["bizjet-first-officer", "bizjet-captain"]) {
      const back = box(`${name}-seat-back`);
      const headrest = box(`${name}-headrest`);
      expect(back.max.y, `${name}: the back's top`).toBeLessThan(eye.up - 0.15);
      expect(headrest.max.y, `${name}: the headrest's top`).toBeGreaterThan(eye.up);
      expect(headrest.min.y, `${name}: the headrest's foot`).toBeLessThan(eye.up);
      // Behind the head, not in it: the headrest's front face is 0.2 m or more aft of the eye.
      expect(eye.forward - headrest.max.x).toBeGreaterThan(0.2);
      // Nothing of the seat itself stands above the eye.
      expect(box(`${name}-seat`).max.y).toBeLessThan(eye.up);
    }
  });

  it("move with the eye: the same placement under a seated eye at 0.55 puts the cushion at -0.25", () => {
    const built = globalSeatPlacement();
    expect(built.cushionTop).toBeCloseTo(eye.up - 0.8, 9);
    // CONTROL: the placement is a function of the eye, not of fixed coordinates.
    const seated = globalSeatPlacement({ ...eye, up: 0.55 });
    expect(seated.cushionTop).toBeCloseTo(-0.25, 9);
    expect(seated.base.height).toBeCloseTo(-0.25 - GLOBAL_FLOOR_Y, 9);
    expect(seated.headrest.y - built.headrest.y).toBeCloseTo(0.55 - eye.up, 9);
    expect(() => globalSeatPlacement({ ...eye, up: -0.2 })).toThrow(RangeError);
  });
});
