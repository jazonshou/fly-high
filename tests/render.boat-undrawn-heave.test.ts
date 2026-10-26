import { describe, expect, it } from "vitest";
import { UndrawnSeaHeave } from "../src/render/webgpu/boat/undrawnSeaHeave";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { createSeaTwin } from "../src/sim/water";
import { createWorld } from "../src/world";
import { homeMarina } from "../src/world/marina";

/**
 * The swell a tier does not draw (src/render/webgpu/boat/undrawnSeaHeave.ts):
 * the drawn boat is lowered by exactly the sea twin's heave of the cascades
 * the tier leaves out, and a tier that draws them all builds nothing.
 */

const WORLD = createWorld("open-skies");
const FOCUS = { halfLength: 3.3, halfBeam: 1.2 };

describe("the undrawn swell", () => {
  it("is nothing, and builds no twin, on a tier that draws every cascade", () => {
    const high = resolveWebGpuQualityProfile("high", "balanced");
    const heave = new UndrawnSeaHeave(WORLD, "cloudy", high.oceanCascades);
    expect(heave.active).toBe(false);
    expect(heave.heaveAt(1_200, -3_400, 0.3, 612.5)).toBe(0);
    expect(heave.built).toBe(false);
  });

  it("is the twin's heave of the cascades the low and medium tiers leave out", () => {
    for (const quality of ["low", "medium"] as const) {
      const drawn = resolveWebGpuQualityProfile(quality, "balanced").oceanCascades;
      const heave = new UndrawnSeaHeave(WORLD, "cloudy", drawn);
      expect(heave.active).toBe(true);
      const reference = createSeaTwin(WORLD, "cloudy");
      reference.setShelter([homeMarina(WORLD).shelter]);
      let largest = 0;
      for (let step = 0; step < 40; step += 1) {
        const time = 600 + step * 1.7;
        const x = 1_200 + step * 15;
        const z = -3_400 - step * 4;
        const lowered = heave.heaveAt(x, z, 0.3, time);
        reference.setTime(time);
        reference.setFocus({ x, z, heading: 0.3, ...FOCUS });
        expect(lowered).toBeCloseTo(reference.undrawnHeave(drawn), 9);
        largest = Math.max(largest, Math.abs(lowered));
      }
      // On the low tier a real swell (Cloudy's leaves out about 18 cm), not a
      // zero that would pass the comparison above. Medium leaves out only the
      // longest cascade, which holds almost nothing of a wind sea.
      if (quality === "low") expect(largest).toBeGreaterThan(0.05);
    }
  });

  it("follows the weather and the tier", () => {
    const heave = new UndrawnSeaHeave(WORLD, "clear", 3);
    const clear = heave.heaveAt(1_500, -3_000, 0, 700);
    heave.setWeather("cloudy");
    const cloudy = heave.heaveAt(1_500, -3_000, 0, 700);
    expect(cloudy).not.toBeCloseTo(clear, 6);
    heave.setDrawnCascades(5);
    expect(heave.heaveAt(1_500, -3_000, 0, 700)).toBe(0);
  });
});
