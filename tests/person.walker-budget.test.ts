import { describe, expect, it } from "vitest";
import { referenceKernelMilliseconds, referenceSlowdown, warmReferenceKernel } from "./support/referenceKernel";
import { walkerCourse, type WalkerCourse } from "./support/walkerCourse";
import { payload } from "./support/walkerRig";

/**
 * The walker's step: bit-identical for identical inputs, and inside the
 * walking build's 20 us at 120 Hz (W1 brief) over the whole course
 * (tests/support/walkerCourse.ts: walking, running, stairs, trunks, wading,
 * swimming, diving and mantling). The budget is in the tuning box's
 * milliseconds (tests/support/referenceKernel.ts), scaled by how much slower
 * this process runs the reference kernel.
 */

const BUDGET_MS = 0.02;
/** One lap of the course, steps (about 100 s). */
const LAP = 12_000;

function digest(course: WalkerCourse): number[] {
  const s = course.walker.state;
  const person = payload(course.walker);
  return [
    s.time,
    s.position.x, s.position.y, s.position.z,
    s.velocity.x, s.velocity.y, s.velocity.z,
    s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w,
    s.angularVelocity.y,
    person.speed, person.slope, person.waterDepth, person.submersion, person.headDepth, person.swimPitch,
    person.landingSpeed, person.landingAge, person.surface,
  ];
}

describe("walker step", () => {
  it("is bit-identical after five minutes of identical inputs", () => {
    const run = () => {
      const course = walkerCourse();
      for (let i = 0; i < 300 * 120; i += 1) course.step(i);
      return { digest: digest(course), mode: course.walker.mode };
    };
    const first = run();
    const second = run();
    expect(first.digest.every(Number.isFinite)).toBe(true);
    expect(second.mode).toBe(first.mode);
    for (let k = 0; k < first.digest.length; k += 1) expect(Object.is(second.digest[k], first.digest[k]), `state ${k}`).toBe(true);
  });

  it(`steps in under ${BUDGET_MS * 1000} us over a lap of the course, on the tuning box`, () => {
    const course = walkerCourse();
    let i = 0;
    for (; i < 2 * LAP; i += 1) course.step(i);
    warmReferenceKernel();
    const laps: number[] = [];
    const kernel: number[] = [referenceKernelMilliseconds()];
    for (let lap = 0; lap < 3; lap += 1) {
      const start = performance.now();
      for (let k = 0; k < LAP; k += 1) course.step(i + k);
      laps.push((performance.now() - start) / LAP);
      i += LAP;
      kernel.push(referenceKernelMilliseconds());
    }
    const step = Math.min(...laps);
    const slowdown = referenceSlowdown(kernel);
    expect(
      step,
      `${(step * 1000).toFixed(1)} us a step against ${(BUDGET_MS * slowdown * 1000).toFixed(1)} us `
      + `(this machine ran the reference kernel ${slowdown.toFixed(2)}x slower than the tuning box)`,
    ).toBeLessThan(BUDGET_MS * slowdown);
  });
});
