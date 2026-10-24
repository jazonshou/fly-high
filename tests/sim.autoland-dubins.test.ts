import { describe, expect, it } from "vitest";
import {
  appendStraight,
  dubinsEndPose,
  sampleDubinsPath,
  shortestDubinsPath,
  wrapAngle,
  type PlanarPose,
} from "../src/sim/dubins";

/**
 * The autoland's lateral plan is a Dubins path, so a transcription slip in
 * one of the six closed forms is a path that ends somewhere other than the
 * final approach course. `shortestDubinsPath` already refuses any candidate
 * whose integrated end misses the goal; these tests hold it to that over a
 * spread of poses, and pin the conventions that cost the most to get wrong:
 * heading is the simulator's (increasing to the pilot's LEFT), and an L arc
 * is a left turn.
 */

/** Deterministic poses: a small LCG rather than Math.random. */
function poses(count: number, seed = 7): PlanarPose[] {
  let state = seed;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, () => ({
    x: (next() - 0.5) * 20_000,
    z: (next() - 0.5) * 20_000,
    heading: (next() - 0.5) * Math.PI * 2,
  }));
}

describe("Dubins paths for the autoland", () => {
  it("wraps angles into (-pi, pi]", () => {
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-0.25)).toBeCloseTo(-0.25, 12);
    expect(wrapAngle(7)).toBeCloseTo(7 - 2 * Math.PI, 12);
  });

  it("ends exactly on the goal pose for every start and goal", () => {
    const starts = poses(60, 11);
    const goals = poses(60, 23);
    for (let i = 0; i < starts.length; i += 1) {
      for (const radius of [150, 1_200, 4_000]) {
        const path = shortestDubinsPath(starts[i]!, goals[i]!, radius);
        expect(path, `pair ${i} radius ${radius}`).not.toBeNull();
        const end = dubinsEndPose(path!);
        expect(Math.hypot(end.x - goals[i]!.x, end.z - goals[i]!.z)).toBeLessThan(Math.max(0.5, radius * 1e-4));
        expect(Math.abs(wrapAngle(end.heading - goals[i]!.heading))).toBeLessThan(1e-3);
        // Never shorter than the straight line between the two points.
        const chord = Math.hypot(goals[i]!.x - starts[i]!.x, goals[i]!.z - starts[i]!.z);
        expect(path!.length).toBeGreaterThanOrEqual(chord - 1e-6);
      }
    }
  });

  it("is a straight line when the goal is dead ahead on the same heading", () => {
    const heading = 0.6;
    const start = { x: 100, z: -50, heading };
    const goal = { x: 100 + Math.sin(heading) * 5_000, z: -50 + Math.cos(heading) * 5_000, heading };
    const path = shortestDubinsPath(start, goal, 800)!;
    expect(path.length).toBeCloseTo(5_000, 6);
    expect(path.lengths[0]).toBeLessThan(1e-6);
    expect(path.lengths[2]).toBeLessThan(1e-6);
  });

  it("turns LEFT on an L arc: the simulator's heading grows", () => {
    // A goal 90 degrees to the left at one radius' offset is a quarter L arc.
    const radius = 1_000;
    const start = { x: 0, z: 0, heading: 0 };
    // Heading 0 points down +Z; with heading = atan2(x, z) growing to the
    // left, the pilot's left is +X.
    const goal = { x: radius, z: radius, heading: Math.PI / 2 };
    const path = shortestDubinsPath(start, goal, radius)!;
    // Ties between words are settled by rounding, so read the segment that
    // actually turns rather than the word's first letter.
    const turning = path.kinds.filter((_, index) => path.lengths[index]! > 1e-6);
    expect(turning).toEqual(["L"]);
    expect(path.length).toBeCloseTo((Math.PI / 2) * radius, 3);
    const samples = sampleDubinsPath(path, 10);
    expect(samples.every((sample) => sample.turn <= 0)).toBe(true);
    expect(samples.at(-1)!.heading).toBeCloseTo(Math.PI / 2, 6);
  });

  it("samples no further apart than asked, with curvature 1/R on the arcs", () => {
    const radius = 900;
    const path = shortestDubinsPath({ x: 0, z: 0, heading: 2 }, { x: -3_000, z: 4_000, heading: -1 }, radius)!;
    const samples = sampleDubinsPath(path, 10);
    appendStraight(samples, -1, 2_000, 10);
    for (let i = 1; i < samples.length; i += 1) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      const step = b.s - a.s;
      expect(step).toBeLessThanOrEqual(10 + 1e-9);
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThanOrEqual(step + 1e-6);
      if (b.turn !== 0) {
        expect(Math.abs(wrapAngle(b.heading - a.heading)) / step).toBeCloseTo(1 / radius, 9);
      }
    }
    expect(samples.at(-1)!.s).toBeCloseTo(path.length + 2_000, 6);
  });

  it("refuses degenerate input instead of returning a wrong path", () => {
    expect(shortestDubinsPath({ x: 0, z: 0, heading: 0 }, { x: 1, z: 1, heading: 0 }, 0)).toBeNull();
    expect(shortestDubinsPath({ x: Number.NaN, z: 0, heading: 0 }, { x: 1, z: 1, heading: 0 }, 100)).toBeNull();
  });
});
