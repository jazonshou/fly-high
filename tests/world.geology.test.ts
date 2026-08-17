import { describe, expect, it } from "vitest";
import { sampleGeologicalRelief } from "../src/world/geology";
import {
  createWorld,
  sampleTerrainCollisionHeight,
  sampleTerrainHeight,
} from "../src/world";

describe("short-wavelength geological relief", () => {
  it("is deterministic, continuous, finite, and absent off land", () => {
    const seed = 0x8a1f27;
    expect(sampleGeologicalRelief(seed, 120, -830, 0, 0, 1, 1)).toBe(0);
    const first = sampleGeologicalRelief(seed, 1_234.5, -8_765.25, 0, 1, 0.8, 0.65);
    const repeated = sampleGeologicalRelief(seed, 1_234.5, -8_765.25, 0, 1, 0.8, 0.65);
    const adjacent = sampleGeologicalRelief(seed, 1_234.501, -8_765.25, 0, 1, 0.8, 0.65);
    expect(Number.isFinite(first)).toBe(true);
    expect(repeated).toBe(first);
    expect(Math.abs(adjacent - first)).toBeLessThan(0.02);
  });

  it("creates broken outcrop-and-ravine relief without unbounded displacement", () => {
    const heights: number[] = [];
    for (let z = -2_400; z <= 2_400; z += 80) {
      for (let x = -2_400; x <= 2_400; x += 80) {
        heights.push(sampleGeologicalRelief(9_812_771, x, z, 0, 1, 1, 0.82));
      }
    }
    const minimum = Math.min(...heights);
    const maximum = Math.max(...heights);
    expect(minimum).toBeLessThan(-1);
    expect(maximum).toBeGreaterThan(35);
    expect(maximum - minimum).toBeGreaterThan(55);
    expect(minimum).toBeGreaterThan(-70);
    expect(maximum).toBeLessThan(110);
  });

  it("uses the same geological height for rendering and flight contact", () => {
    const world = createWorld("shared-geological-contact", { airport: false });
    const points = [
      [-7_315.25, 2_841.5],
      [1_957.75, -4_202.125],
      [8_611.5, 9_217.25],
    ] as const;
    for (const [x, z] of points) {
      expect(sampleTerrainCollisionHeight(world, x, z)).toBe(sampleTerrainHeight(world, x, z));
    }
  });
});
