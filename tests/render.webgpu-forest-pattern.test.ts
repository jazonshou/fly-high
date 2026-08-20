import { describe, expect, it } from "vitest";
import {
  densityField,
  forestFraction,
} from "../src/render/webgpu/detail/densityField";
import { hashSeed } from "../src/world";

const SEED = hashSeed("gate-b-forest-pattern");
const MOISTURE = 0.7;

function sample(x: number, z: number) {
  return densityField(SEED, {
            filterWidthMeters: 0,
    x,
    z,
    heightMeters: 320,
    seaLevelMeters: 0,
    slope: 0.04,
    moisture: MOISTURE,
    normalX: 0.01,
    normalZ: 0.02,
    dayOfYear: 171,
  });
}

describe("Gate B forest-pattern variance (assertions 67e/67f)", () => {
  it("authors kilometre-scale meadow and closed-forest provinces", () => {
    let meadowWindow = false;
    let forestWindow = false;
    for (let originZ = -30_000; originZ <= 27_000; originZ += 3_000) {
      for (let originX = -30_000; originX <= 27_000; originX += 3_000) {
        const values: number[] = [];
        for (let dz = 0; dz <= 2_000; dz += 1_000) {
          for (let dx = 0; dx <= 2_000; dx += 1_000) {
            values.push(forestFraction(SEED, originX + dx, originZ + dz, MOISTURE));
          }
        }
        meadowWindow ||= Math.max(...values) < 0.08;
        forestWindow ||= Math.min(...values) > 0.92;
      }
    }
    expect(meadowWindow, "a whole multi-kilometre meadow province").toBe(true);
    expect(forestWindow, "a whole multi-kilometre closed-forest province").toBe(true);
  });

  it("opens below the rendered cap and retains dense stand interiors", () => {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = 0;
    let sum = 0;
    let count = 0;
    for (let z = -12_000; z <= 12_000; z += 160) {
      for (let x = -12_000; x <= 12_000; x += 160) {
        const stems = sample(x, z).treeStemsPerSquareMeter;
        minimum = Math.min(minimum, stems);
        maximum = Math.max(maximum, stems);
        sum += stems;
        count += 1;
      }
    }
    // 78 rendered stems/ha = 0.0078/m². Openings must author less than
    // that or rendered-share thinning fills them back in.
    expect(minimum).toBeLessThan(0.001);
    expect(maximum).toBeGreaterThan(0.035);
    // The new province/glade/disturbance stack lowers net authored stems;
    // it must not quietly return to a near-uniform closed forest.
    expect(sum / count).toBeLessThan(0.025);
  });

  it("contains hard disturbance boundaries and shorter edge margins", () => {
    let hardBoundary = false;
    const edgeHeights: number[] = [];
    const interiorHeights: number[] = [];
    for (let z = -18_000; z <= 18_000; z += 80) {
      let previous = sample(-18_000, z);
      for (let x = -17_920; x <= 18_000; x += 80) {
        const current = sample(x, z);
        if (
          (previous.treeStemsPerSquareMeter === 0 && current.treeStemsPerSquareMeter > 0.012)
          || (current.treeStemsPerSquareMeter === 0 && previous.treeStemsPerSquareMeter > 0.012)
        ) {
          hardBoundary = true;
        }
        if (current.forestEdge > 0.72) edgeHeights.push(current.heightFactor);
        if (current.forestEdge < 0.08 && current.treeStemsPerSquareMeter > 0.025) {
          interiorHeights.push(current.heightFactor);
        }
        previous = current;
      }
    }
    expect(hardBoundary, "a zero-width windthrow boundary").toBe(true);
    expect(edgeHeights.length).toBeGreaterThan(50);
    expect(interiorHeights.length).toBeGreaterThan(50);
    const mean = (values: readonly number[]) =>
      values.reduce((total, value) => total + value, 0) / values.length;
    expect(mean(edgeHeights)).toBeLessThan(mean(interiorHeights) * 0.82);
  });
});
