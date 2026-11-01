import { describe, expect, it } from "vitest";
import {
  INDOOR_DAYLIGHT_FACTOR,
  indoorExposureGain,
} from "@/src/render/webgpu/nature/EnvironmentDirector";

/**
 * Indoors by day the eye adapts to a room (`indoorExposureGain`), by the
 * same weak law the one exposure curve adapts to dusk by: outside it is
 * exactly 1, so no outdoor frame moves.
 */
describe("the eye's gain indoors", () => {
  it("is exactly 1 outside and rises smoothly to the room's adaptation well inside", () => {
    expect(indoorExposureGain(0)).toBe(1);
    expect(indoorExposureGain(-1)).toBe(1);
    const inside = indoorExposureGain(1);
    // A room at 3% of the daylight outside, at k = 0.12: about 1.5x, 0.6 of a stop.
    expect(inside).toBeCloseTo(Math.pow(INDOOR_DAYLIGHT_FACTOR, -0.12), 12);
    expect(inside).toBeGreaterThan(1.45);
    expect(inside).toBeLessThan(1.6);
    expect(indoorExposureGain(2)).toBe(inside);
    let previous = 1;
    for (let share = 0.1; share <= 1.0001; share += 0.1) {
      const gain = indoorExposureGain(share);
      expect(gain).toBeGreaterThan(previous);
      previous = gain;
    }
  });
});
