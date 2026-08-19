import { describe, expect, it } from "vitest";
import { TerrainBiome } from "../src/world";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type {
  DetailTerrainSample,
  DetailTreePlacement,
} from "../src/render/webgpu/detail/types";

/**
 * 2-12 — tint DISTRIBUTION, not tint storage. The old single-scalar multiply
 * was brightness jitter with zero hue variance (a forest of one green at
 * different exposures — the flight-test complaint). This pins the perceptual
 * spread: real hue variance inside each species, stand-correlated means, and
 * the young-stems-lighter value/age correlation.
 */

function closedForestSampler(): (x: number, z: number) => DetailTerrainSample {
  return () => ({
    height: 320,
    slope: 0.04,
    moisture: 0.72,
    biome: TerrainBiome.FOREST,
    normal: { x: 0.01, y: 0.999, z: 0.02 },
  });
}

function collectTrees(): DetailTreePlacement[] {
  const sampler = closedForestSampler();
  const trees: DetailTreePlacement[] = [];
  for (let cellZ = 0; cellZ < 5; cellZ += 1) {
    for (let cellX = 0; cellX < 5; cellX += 1) {
      const cell = generateDetailCell({
        worldSeed: "tint-distribution",
        cellX,
        cellZ,
        cellSizeMeters: 128,
        densityMultiplier: 1,
        terrainSample: sampler,
        seaLevelMeters: 0,
        // The distribution under measurement is the reference-day (summer)
        // one — at the day-0 default the 2-13a seasonal crown legitimately
        // collapses deciduous hue variance (leaf fall + snow whitening).
        dayOfYear: 171,
      });
      trees.push(...cell.trees);
    }
  }
  return trees;
}

function hueOf(color: readonly [number, number, number, number]): number {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return ((hue / 6) + 1) % 1;
}

function valueOf(color: readonly [number, number, number, number]): number {
  return Math.max(color[0], color[1], color[2]);
}

function standardDeviation(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index]! - meanA;
    const db = b[index]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return cov / Math.max(Math.sqrt(varA * varB), 1e-9);
}

describe("tree tint distribution (2-12)", () => {
  it("carries real hue variance inside every common species", () => {
    const trees = collectTrees();
    const bySpecies = Map.groupBy(trees, (tree) => tree.species);
    let checkedSpecies = 0;
    for (const [species, group] of bySpecies) {
      if (group.length < 60) continue;
      checkedSpecies += 1;
      const hueDegrees = group.map((tree) => hueOf(tree.color) * 360);
      const sigma = standardDeviation(hueDegrees);
      // σ ≈ 6–9° by spec (stand shifts widen the population spread a little);
      // the old brightness-only jitter measures ~0 and fails the floor.
      expect(sigma, `${species} hue sigma`).toBeGreaterThan(3);
      expect(sigma, `${species} hue sigma`).toBeLessThan(16);
    }
    expect(checkedSpecies).toBeGreaterThanOrEqual(3);
  });

  it("correlates tint with the stand, not just the individual", () => {
    const trees = collectTrees();
    // Near pairs share more hue than far pairs — the stand field's tint
    // centre shifts whole stands together.
    let closePairs = 0;
    let closeDelta = 0;
    let farPairs = 0;
    let farDelta = 0;
    for (let index = 0; index < trees.length; index += 1) {
      const a = trees[index]!;
      const b = trees[(index + 89) % trees.length]!;
      if (a.species !== b.species) continue;
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      const delta = Math.abs(hueOf(a.color) - hueOf(b.color));
      const wrapped = Math.min(delta, 1 - delta);
      if (distance < 30) {
        closePairs += 1;
        closeDelta += wrapped;
      } else if (distance > 150) {
        farPairs += 1;
        farDelta += wrapped;
      }
    }
    expect(closePairs).toBeGreaterThan(40);
    expect(farPairs).toBeGreaterThan(40);
    expect(closeDelta / closePairs).toBeLessThan((farDelta / farPairs) * 0.9);
  });

  it("carries real hue variance in the understory too (2-12b)", () => {
    // The shrub tint was the last single-scalar brightness jitter; card
    // shrubs made it visible. Same gate as the canopy: per-species hue
    // sigma in a card-consumer range, not near zero.
    const sampler = closedForestSampler();
    const shrubs = [];
    for (let cellZ = 0; cellZ < 5; cellZ += 1) {
      for (let cellX = 0; cellX < 5; cellX += 1) {
        const cell = generateDetailCell({
          worldSeed: "tint-distribution",
          cellX,
          cellZ,
          cellSizeMeters: 128,
          densityMultiplier: 1,
          terrainSample: sampler,
          seaLevelMeters: 0,
          // Reference-day distribution — see collectTrees.
          dayOfYear: 171,
        });
        shrubs.push(...cell.shrubs);
      }
    }
    const bySpecies = Map.groupBy(shrubs, (shrub) => shrub.species);
    let checked = 0;
    for (const [species, group] of bySpecies) {
      if (group.length < 60) continue;
      checked += 1;
      const sigma = standardDeviation(group.map((shrub) => hueOf(shrub.color) * 360));
      expect(sigma, `${species} hue sigma`).toBeGreaterThan(4);
      expect(sigma, `${species} hue sigma`).toBeLessThan(18);
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("renders young stems lighter (value anti-correlates with height)", () => {
    const trees = collectTrees();
    const bySpecies = Map.groupBy(trees, (tree) => tree.species);
    let checked = 0;
    for (const [species, group] of bySpecies) {
      if (group.length < 120) continue;
      checked += 1;
      const r = correlation(
        group.map((tree) => tree.heightMeters),
        group.map((tree) => valueOf(tree.color)),
      );
      expect(r, `${species} height/value correlation`).toBeLessThan(-0.05);
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
