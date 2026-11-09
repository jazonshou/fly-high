import { describe, expect, it } from "vitest";
import { walkerCourse } from "./support/walkerCourse";

/**
 * The walker's step allocates nothing (the walking build's W1 brief). In a
 * file of its own: feedback from other tests' shapes at the same call sites
 * would box doubles here. The course (tests/support/walkerCourse.ts) walks,
 * runs, jumps, climbs stairs, drops off a platform, threads trunks, wades,
 * swims, dives, mantles onto a bobbing pontoon and plunges off it, so every
 * branch of the step is optimised before the heap is measured.
 */
describe("walker step", () => {
  it("allocates nothing but the two numbers of each call into the water and the terrain", () => {
    const course = walkerCourse();
    const visited = new Set<string>();
    let i = 0;
    // Two laps to warm up, noting what the walker did.
    for (; i < 120 * 240; i += 1) {
      course.step(i);
      visited.add(course.walker.mode);
    }
    expect([...visited].sort()).toEqual(["air", "dive", "land", "mantle", "run", "stand", "swim", "wade", "walk"]);
    // Moving a kinematic collider allocates in the collider world (tests/support/walkerCourse.ts).
    course.pontoonMoves = false;
    // As in the car's wading test: the water authority's `sample(x, z, out)` and the terrain's
    // `bedHeight(x, z)` take two numbers, which V8 boxes (16 B each) whenever it has not inlined the
    // call. The walker asks the water once a step where it can be wet, the terrain once a new
    // lattice node.
    const run = (): { grown: number; allowed: number } => {
      const calls = course.swell.samples + course.bedReads;
      const before = process.memoryUsage().heapUsed;
      for (let k = 0; k < 20_000; k += 1) course.step(i + k);
      i += 20_000;
      return { grown: process.memoryUsage().heapUsed - before, allowed: 32 * 1024 + 32 * (course.swell.samples + course.bedReads - calls) };
    };
    const deadline = performance.now() + 20_000;
    let streak = 0;
    let last = { grown: Number.NaN, allowed: 0 };
    while (streak < 3 && performance.now() < deadline) {
      last = run();
      streak = last.grown >= 0 && last.grown < last.allowed ? streak + 1 : 0;
    }
    expect(streak, `last run of 20,000 steps grew the heap by ${last.grown} B of ${last.allowed}`).toBe(3);
  });
});
