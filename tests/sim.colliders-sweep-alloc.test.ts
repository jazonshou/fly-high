import { describe, expect, it } from "vitest";
import { ColliderWorld, createColliderSweepHit } from "../src/sim/colliders";

/**
 * `sweepSphere` and `raycast` run in the walker's 120 Hz step and the
 * camera's frame, so they allocate nothing. In a file of its own: feedback
 * from other tests' shapes at the same call sites would box doubles here.
 */
describe("collider sweeps", () => {
  it("allocate nothing", () => {
    const world = new ColliderWorld();
    for (let i = 0; i < 40; i += 1) {
      const x = (i % 8) * 4;
      const z = Math.floor(i / 8) * 4;
      // Every kind in one world: a number read through a shape whose hidden class
      // differs by kind is where V8 boxes.
      if (i % 4 === 0) world.addStatic({ kind: "box", center: { x, y: 0, z }, halfExtents: { x: 1, y: 0.5, z: 1.5 }, orientation: { x: 0, y: 0.38268343236, z: 0, w: 0.92387953251 } });
      else if (i % 4 === 1) world.addStatic({ kind: "capsule", a: { x, y: -1, z }, b: { x, y: 4, z }, radius: 0.3 });
      else if (i % 4 === 2) world.addStatic({ kind: "sphere", center: { x, y: 0.5, z }, radius: 0.7 });
      else world.addStatic({ kind: "polyline", points: [{ x, y: 0.5, z }, { x: x + 2, y: 0.5, z: z + 1 }, { x: x + 3, y: 0.7, z: z - 1 }], radius: 0.1 });
    }
    const pontoon = world.addKinematic({ kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 6, y: 0.3, z: 1 } });
    world.setKinematicPose(pontoon, { x: 14, y: 0.1, z: 22 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0.2, z: 0 });
    const hit = createColliderSweepHit();
    const from = { x: 0, y: 2, z: 0 };
    const to = { x: 0, y: -2, z: 0 };
    let touches = 0;
    const run = (count: number): number => {
      const before = process.memoryUsage().heapUsed;
      for (let k = 0; k < count; k += 1) {
        const phase = k * 0.001;
        from.x = 16 + 15 * Math.sin(phase);
        from.z = 10 + 12 * Math.cos(phase * 1.3);
        to.x = from.x + Math.cos(phase * 7);
        to.z = from.z + Math.sin(phase * 5);
        if (world.sweepSphere(from, to, 0.3, hit)) touches += 1;
        if (world.raycast(from, to, hit)) touches += 1;
      }
      return process.memoryUsage().heapUsed - before;
    };
    run(50_000);
    const deadline = performance.now() + 20_000;
    let streak = 0;
    let last = Number.NaN;
    while (streak < 3 && performance.now() < deadline) {
      last = run(50_000);
      streak = last >= 0 && last < 32 * 1024 ? streak + 1 : 0;
    }
    expect(streak, `last run of 100,000 sweeps grew the heap by ${last} B`).toBe(3);
    expect(touches).toBeGreaterThan(1_000);
  });
});
