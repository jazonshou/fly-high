import { describe, expect, it } from "vitest";
import { PersonMotion } from "../src/render/webgpu/person/motion";
import { referenceKernelMilliseconds, referenceSlowdown, warmReferenceKernel } from "./support/referenceKernel";
import { COURSE_FRAMES, PersonMotionCourse } from "./support/personMotionCourse";

/**
 * The walker's animation and IK each frame (`PersonMotion.update`: the
 * gait or the move, the planted feet, the limbs' reaches, the look) inside
 * the walking build's 0.08 ms (W2 brief) over the whole course
 * (tests/support/personMotionCourse.ts). The budget is in the tuning box's
 * milliseconds (tests/support/referenceKernel.ts), scaled by how much slower
 * this process runs the reference kernel.
 */

const BUDGET_MS = 0.08;

describe("the walker's motion", () => {
  it(`animates a frame in under ${BUDGET_MS * 1000} us over the course, on the tuning box`, () => {
    const course = new PersonMotionCourse();
    const motion = new PersonMotion();
    let frame = 0;
    for (; frame < 3 * COURSE_FRAMES; frame += 1) motion.update(course.input(frame), 1 / 60, course.output);
    warmReferenceKernel();
    const laps: number[] = [];
    const kernel: number[] = [referenceKernelMilliseconds()];
    for (let lap = 0; lap < 3; lap += 1) {
      const start = performance.now();
      for (let k = 0; k < COURSE_FRAMES; k += 1) motion.update(course.input(frame + k), 1 / 60, course.output);
      laps.push((performance.now() - start) / COURSE_FRAMES);
      frame += COURSE_FRAMES;
      kernel.push(referenceKernelMilliseconds());
    }
    const update = Math.min(...laps);
    const slowdown = referenceSlowdown(kernel);
    expect(
      update,
      `${(update * 1000).toFixed(1)} us a frame against ${(BUDGET_MS * slowdown * 1000).toFixed(1)} us `
      + `(this machine ran the reference kernel ${slowdown.toFixed(2)}x slower than the tuning box)`,
    ).toBeLessThan(BUDGET_MS * slowdown);
  });
});
