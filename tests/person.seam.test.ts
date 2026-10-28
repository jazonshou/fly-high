import { describe, expect, it } from "vitest";
import type { PersonControlState, PersonVisualState } from "../src/game/types";
import { inputProfileForSpawn } from "../src/input";
import { ColliderWorld } from "../src/sim/colliders";
import { createPersonSimulator } from "../src/sim/person";
import {
  NEUTRAL_BOAT_CONTROLS,
  NEUTRAL_PERSON_CONTROLS,
  surfaceVisualState,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
} from "../src/sim/surface";
import { CalmWaterSurface } from "../src/sim/water";
import { PERSON, personJumpSpeed, toblerFactor } from "../src/vehicles/person";
import { isCarSpawn, isSurfaceSpawn } from "../src/workers/protocol";

/**
 * The walker's side of the shared vehicle seam (the walking build's
 * interface step): the spec's published numbers, the person payload through
 * `surfaceVisualState`, and the stand-in walker the session is built on
 * until the real controller replaces it.
 */

const STEP = 1 / 120;

function flatEnvironment(groundHeight: number, seaLevel = -50, colliders: ColliderWorld | null = null): SurfaceVehicleEnvironment {
  const bed = () => groundHeight;
  return {
    water: new CalmWaterSurface(seaLevel, bed),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: bed,
    groundContact: (_x, _z, target) => {
      target.height = groundHeight;
      target.normal.x = 0;
      target.normal.y = 1;
      target.normal.z = 0;
      target.isRunway = false;
      target.friction = 1;
      return target;
    },
    colliders,
    gravity: 9.80665,
  };
}

function controls(person: Partial<PersonControlState>): SurfaceVehicleControls {
  return { assist: "scenic", boat: NEUTRAL_BOAT_CONTROLS, person: { ...NEUTRAL_PERSON_CONTROLS, ...person } };
}

function payload(walker: ReturnType<typeof createPersonSimulator>): PersonVisualState {
  const value = walker.snapshot().payload;
  if (value.kind !== "person") throw new Error("expected a person payload");
  return value;
}

describe("person spec", () => {
  it("walks at Tobler's flat speed and switches gait under Froude 0.5", () => {
    expect(PERSON.walkSpeed).toBeCloseTo(5.04 / 3.6, 2);
    const legLength = 0.53 * PERSON.stature;
    const froude = PERSON.walkRunSpeed ** 2 / (9.80665 * legLength);
    expect(froude).toBeGreaterThan(0.4);
    expect(froude).toBeLessThan(0.5);
    expect(personJumpSpeed()).toBeCloseTo(2.97, 2);
  });

  it("is fastest on a gentle descent and as slow on a 40% descent as on a 30% climb", () => {
    expect(toblerFactor(0)).toBeCloseTo(1, 12);
    expect(toblerFactor(-0.05)).toBeCloseTo(Math.exp(0.175), 6);
    expect(toblerFactor(-0.4)).toBeCloseTo(toblerFactor(0.3), 6);
    expect(toblerFactor(0.3)).toBeLessThan(0.36);
  });
});

describe("foot spawn", () => {
  it("is a car start", () => {
    expect(isSurfaceSpawn("foot")).toBe(true);
    expect(isCarSpawn("foot")).toBe(true);
    expect(isCarSpawn("airfield")).toBe(true);
    expect(isCarSpawn("dock")).toBe(false);
    expect(inputProfileForSpawn("foot")).toBe("person");
  });
});

describe("stand-in walker", () => {
  it("walks where the move vector points at the walk speed, turned to face it", () => {
    const walker = createPersonSimulator({ position: { x: 0, y: 10, z: 0 }, heading: 0 });
    walker.setEnvironment(flatEnvironment(10));
    walker.setControls(controls({ moveX: 1, moveZ: 0 }));
    for (let i = 0; i < 240; i += 1) walker.step(STEP);
    const state = surfaceVisualState(walker.snapshot(), undefined);
    expect(state.velocity.x).toBeCloseTo(PERSON.walkSpeed, 2);
    expect(state.position.y).toBe(10);
    // Heading +X is 90 degrees in the flight convention.
    expect(state.heading).toBeCloseTo(90, 1);
    expect(state.airspeed).toBeCloseTo(PERSON.walkSpeed, 2);
    expect(payload(walker).mode).toBe("walk");
    walker.setControls(controls({ moveX: 1, run: true }));
    for (let i = 0; i < 240; i += 1) walker.step(STEP);
    expect(payload(walker).mode).toBe("run");
    expect(payload(walker).speed).toBeCloseTo(PERSON.runSpeed, 2);
  });

  it("jumps the spec's height on a press, and lands", () => {
    const walker = createPersonSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0 });
    walker.setEnvironment(flatEnvironment(0));
    walker.setControls(controls({ jumpPresses: 0 }));
    walker.step(STEP);
    walker.setControls(controls({ jumpPresses: 1 }));
    let peak = 0;
    for (let i = 0; i < 120; i += 1) {
      walker.step(STEP);
      peak = Math.max(peak, walker.state.position.y);
    }
    expect(peak).toBeGreaterThan(PERSON.jumpHeight - 0.02);
    expect(peak).toBeLessThan(PERSON.jumpHeight + 0.02);
    expect(walker.state.position.y).toBe(0);
    expect(payload(walker).grounded).toBe(true);
  });

  it("floats with the mouth at the surface in water deeper than the swim depth", () => {
    const walker = createPersonSimulator({ position: { x: 0, y: -3, z: 0 }, heading: 0 });
    walker.setEnvironment(flatEnvironment(-3, 0));
    walker.setControls(controls({}));
    for (let i = 0; i < 600; i += 1) walker.step(STEP);
    const person = payload(walker);
    expect(person.mode).toBe("swim");
    expect(walker.state.position.y).toBeCloseTo(-PERSON.swimDepthFraction * PERSON.stature, 2);
    expect(person.waterDepth).toBeGreaterThan(1);
  });

  it("is held out of a box collider, and recovers to its newest safe spot", () => {
    const world = new ColliderWorld();
    world.addStatic({ kind: "box", center: { x: 3, y: 1, z: 0 }, halfExtents: { x: 1, y: 1, z: 2 } });
    const walker = createPersonSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 90 * Math.PI / 180 });
    walker.setEnvironment(flatEnvironment(0, -50, world));
    walker.setControls(controls({ moveX: 1 }));
    for (let i = 0; i < 480; i += 1) walker.step(STEP);
    expect(walker.state.position.x).toBeLessThan(2 - PERSON.capsuleRadius + 0.02);
    expect(walker.state.position.x).toBeGreaterThan(1.5);
    walker.placeAt({ x: -20, y: 0, z: 0 }, 0);
    walker.setControls(controls({}));
    walker.step(STEP);
    walker.recover();
    expect(walker.state.position.x).toBeCloseTo(-20, 6);
    expect(walker.state.velocity.x).toBe(0);
  });
});
