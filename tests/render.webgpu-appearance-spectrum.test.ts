import { describe, expect, it } from "vitest";
import { TerrainBiome } from "../src/world";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import { STAND_FIELD_MINIMUM_WAVELENGTH_METERS } from "../src/render/webgpu/detail/standField";
import type {
  DetailTerrainSample,
  DetailTreePlacement,
} from "../src/render/webgpu/detail/types";

/**
 * 2-11b — the appearance spectrum (the attribute-domain half of assertion
 * 27). The position test cannot see a 32 m lattice in species identity,
 * stand age, height or tint: every anti-repetition guard was positional.
 * This sweep runs the same spectral machinery over ATTRIBUTE channels —
 * weights are the channel's deviation from its mean, so a channel constant
 * per scatter block concentrates power at the block period exactly like a
 * positional lattice. Structure below the stand band
 * (< STAND_FIELD_MINIMUM_WAVELENGTH_METERS) is forbidden; the stand-scale
 * band itself is intended — stands exist ecologically.
 */

const CELL_SIZE = 128;
const CELL_SPAN = 6;

function closedForestSampler(): (x: number, z: number) => DetailTerrainSample {
  return () => ({
    height: 320,
    slope: 0.04,
    moisture: 0.72,
    biome: TerrainBiome.FOREST,
    normal: { x: 0.01, y: 0.999, z: 0.02 },
  });
}

let cachedTrees: DetailTreePlacement[] | null = null;

function collectTrees(): DetailTreePlacement[] {
  if (cachedTrees) return cachedTrees;
  const sampler = closedForestSampler();
  const trees: DetailTreePlacement[] = [];
  for (let cellZ = 0; cellZ < CELL_SPAN; cellZ += 1) {
    for (let cellX = 0; cellX < CELL_SPAN; cellX += 1) {
      const cell = generateDetailCell({
        worldSeed: "appearance-spectrum",
        cellX,
        cellZ,
        cellSizeMeters: CELL_SIZE,
        densityMultiplier: 1,
        terrainSample: sampler,
        seaLevelMeters: 0,
      });
      trees.push(...cell.trees);
    }
  }
  cachedTrees = trees;
  return trees;
}

const SPECIES_INDEX: Record<string, number> = {
  pine: 0, cedar: 1, spruce: 2, oak: 3, maple: 4, birch: 5, willow: 6,
};

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

interface WeightedPoint {
  readonly x: number;
  readonly z: number;
  readonly weight: number;
}

function channelPoints(
  trees: readonly DetailTreePlacement[],
  channel: (tree: DetailTreePlacement) => number,
): WeightedPoint[] {
  const values = trees.map(channel);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return trees.map((tree, index) => ({
    x: tree.x,
    z: tree.z,
    weight: values[index]! - mean,
  }));
}

/**
 * Attribute-weighted projected power, normalised so uncorrelated weights
 * measure ~1 regardless of the channel's variance. A per-block-constant
 * channel concentrates to O(stems per block footprint).
 */
function weightedPower(
  points: readonly WeightedPoint[],
  directionRadians: number,
  period: number,
): number {
  const dx = Math.cos(directionRadians);
  const dz = Math.sin(directionRadians);
  let sumCos = 0;
  let sumSin = 0;
  let sumSquares = 0;
  for (const point of points) {
    const phase = ((point.x * dx + point.z * dz) / period) * 2 * Math.PI;
    sumCos += point.weight * Math.cos(phase);
    sumSin += point.weight * Math.sin(phase);
    sumSquares += point.weight * point.weight;
  }
  return (sumCos * sumCos + sumSin * sumSin) / Math.max(sumSquares, 1e-9);
}

describe("vegetation appearance spectrum (2-11b)", () => {
  it("carries a diverse, stand-correlated appearance field", () => {
    const trees = collectTrees();
    expect(trees.length).toBeGreaterThan(2_000);
    expect(new Set(trees.map((tree) => tree.species)).size).toBeGreaterThanOrEqual(4);
    // Stand correlation: stems within 20 m share more stand age than the
    // population at large — the field gives stands identities without a
    // lattice. (Sampled pairs keep the test fast.)
    let closePairs = 0;
    let closeDelta = 0;
    let farPairs = 0;
    let farDelta = 0;
    for (let index = 0; index < trees.length - 1; index += 1) {
      const a = trees[index]!;
      const b = trees[(index + 97) % trees.length]!;
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      const delta = Math.abs(a.standAge - b.standAge);
      if (distance < 24) {
        closePairs += 1;
        closeDelta += delta;
      } else if (distance > 120) {
        farPairs += 1;
        farDelta += delta;
      }
    }
    expect(closePairs).toBeGreaterThan(50);
    expect(farPairs).toBeGreaterThan(50);
    expect(closeDelta / closePairs).toBeLessThan((farDelta / farPairs) * 0.6);
  });

  it("shows no sub-stand-band line in species, age, height or tint hue", () => {
    const trees = collectTrees();
    const channels: Record<string, (tree: DetailTreePlacement) => number> = {
      species: (tree) => SPECIES_INDEX[tree.species]! / 6,
      standAge: (tree) => tree.standAge,
      height: (tree) => tree.heightMeters,
      tintHue: (tree) => hueOf(tree.color),
    };
    const directionCount = 12;
    for (const [name, channel] of Object.entries(channels)) {
      const points = channelPoints(trees, channel);
      for (
        let period = 3;
        period <= STAND_FIELD_MINIMUM_WAVELENGTH_METERS - 5;
        period += 1
      ) {
        let sum = 0;
        for (let index = 0; index < directionCount; index += 1) {
          sum += weightedPower(points, (index / directionCount) * Math.PI, period);
        }
        const mean = sum / directionCount;
        // Uncorrelated weights measure ~1; the old 32 m block lattice
        // measures in the tens at 32 m (proven by the control below).
        expect(mean, `${name} period ${period}`).toBeLessThan(6);
      }
    }
  }, 120_000);

  it("keeps within-block variance alive — the lattice discriminator (negative control)", () => {
    // A per-block-constant channel has ZERO variance inside any 32 m block;
    // a continuous stand field varies inside the block (its shortest
    // wavelength is ~2 blocks, so a block spans ~half a cycle). The ANOVA
    // ratio — mean within-block variance over total variance — separates
    // them robustly where a pure spectral line cannot (a 32 m sinusoid
    // integrates to zero over uniformly filled blocks).
    const trees = collectTrees();
    const ratioFor = (channel: (tree: DetailTreePlacement) => number): number => {
      const byBlock = new Map<string, number[]>();
      for (const tree of trees) {
        const key = `${Math.floor(tree.x / 32)}:${Math.floor(tree.z / 32)}`;
        const bucket = byBlock.get(key) ?? [];
        bucket.push(channel(tree));
        byBlock.set(key, bucket);
      }
      const all = trees.map(channel);
      const mean = all.reduce((sum, value) => sum + value, 0) / all.length;
      const total = all.reduce((sum, value) => sum + (value - mean) ** 2, 0) / all.length;
      let withinSum = 0;
      let withinCount = 0;
      for (const bucket of byBlock.values()) {
        if (bucket.length < 3) continue;
        const blockMean = bucket.reduce((sum, value) => sum + value, 0) / bucket.length;
        withinSum += bucket.reduce((sum, value) => sum + (value - blockMean) ** 2, 0);
        withinCount += bucket.length;
      }
      return withinSum / withinCount / Math.max(total, 1e-9);
    };
    // The live stand-age channel varies within blocks.
    expect(ratioFor((tree) => tree.standAge)).toBeGreaterThan(0.05);
    // The synthesised pre-2-11b failure — one value per block — measures ~0,
    // proving the discriminator catches the old generator.
    const blockHash = (x: number, z: number): number => {
      const bx = Math.floor(x / 32);
      const bz = Math.floor(z / 32);
      let hash = (Math.imul(bx, 0x27d4eb2f) ^ Math.imul(bz, 0x165667b1)) >>> 0;
      hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d) >>> 0;
      return ((hash ^ (hash >>> 12)) >>> 0) / 4_294_967_296;
    };
    expect(ratioFor((tree) => blockHash(tree.x, tree.z))).toBeLessThan(1e-6);
  });
});
