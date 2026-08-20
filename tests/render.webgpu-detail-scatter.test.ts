import { describe, expect, it } from "vitest";
import { hashSeed, TerrainBiome } from "../src/world";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import { densityField } from "../src/render/webgpu/detail/densityField";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";

/**
 * 1B-8 — the scatter regression test (assertion 27), written BEFORE the
 * 1B-9 scatter it accepts. Written after, it would test whatever scatter was
 * written; written first, it tests the property the audit demands: no
 * constant period anywhere in the image. The pre-1B-9 cluster lattice
 * (176 m stand spacing, 144 m shrub patches) fails the phase-histogram
 * assertion at its own periods — verified before the rewrite landed.
 */

const CELL_SIZE = 512;
/** 5×5 cells = 6.6 km² of constant closed forest — enough glade wavelengths
 * that the aperiodic ecological clumping averages out of the phase bins. */
const CELL_SPAN = 5;
const SCATTER_SEED = "scatter-spectrum";

/**
 * Gate B adds kilometre-scale meadow provinces, so the old origin is no
 * longer entitled to call itself the closed-forest fixture. Select the
 * deterministic 2.56 km window with the strongest authored canopy over a
 * broad domain, then keep the original 300–800/ha and spectrum assertions.
 */
function selectClosedForestWindow(): { cellX: number; cellZ: number } {
  const seedHash = hashSeed(SCATTER_SEED);
  let best = { cellX: 0, cellZ: 0, score: Number.NEGATIVE_INFINITY };
  for (let cellZ = -30; cellZ <= 25; cellZ += CELL_SPAN) {
    for (let cellX = -30; cellX <= 25; cellX += CELL_SPAN) {
      let score = 0;
      let probes = 0;
      for (let z = 128; z < CELL_SIZE * CELL_SPAN; z += 256) {
        for (let x = 128; x < CELL_SIZE * CELL_SPAN; x += 256) {
          score += densityField(seedHash, {
            filterWidthMeters: 0,
            x: cellX * CELL_SIZE + x,
            z: cellZ * CELL_SIZE + z,
            heightMeters: 320,
            seaLevelMeters: 0,
            slope: 0.04,
            moisture: 0.72,
            normalX: 0.01,
            normalZ: 0.02,
            dayOfYear: 171,
          }).treeStemsPerSquareMeter;
          probes += 1;
        }
      }
      const mean = score / probes;
      if (mean > best.score) best = { cellX, cellZ, score: mean };
    }
  }
  expect(best.score, "selected fixture is genuinely closed forest").toBeGreaterThan(0.03);
  return best;
}

const CLOSED_WINDOW = selectClosedForestWindow();

function closedForestSampler(): (x: number, z: number) => DetailTerrainSample {
  return () => ({
    height: 320,
    slope: 0.04,
    moisture: 0.72,
    biome: TerrainBiome.FOREST,
    normal: { x: 0.01, y: 0.999, z: 0.02 },
  });
}

interface Point {
  readonly x: number;
  readonly z: number;
}

const placementCache = new Map<string, Point[]>();

function collectPlacements(kind: "trees" | "shrubs"): Point[] {
  const cached = placementCache.get(kind);
  if (cached) return cached;
  const sampler = closedForestSampler();
  const points: Point[] = [];
  for (let cellZ = 0; cellZ < CELL_SPAN; cellZ += 1) {
    for (let cellX = 0; cellX < CELL_SPAN; cellX += 1) {
      const cell = generateDetailCell({
        worldSeed: SCATTER_SEED,
        cellX: CLOSED_WINDOW.cellX + cellX,
        cellZ: CLOSED_WINDOW.cellZ + cellZ,
        cellSizeMeters: CELL_SIZE,
        densityMultiplier: 1,
        terrainSample: sampler,
        seaLevelMeters: 0,
      });
      for (const placement of cell[kind]) {
        points.push({ x: placement.x, z: placement.z });
      }
    }
  }
  placementCache.set(kind, points);
  return points;
}

/**
 * Projected spectral power |Σ exp(2πi·(p·d)/λ)|² / N along a direction. For
 * uncorrelated positions this is ~Exp(1); a lattice at period λ concentrates
 * to O(N). Blue noise suppresses it below 1 at long wavelengths.
 */
function projectedPower(points: readonly Point[], directionRadians: number, period: number): number {
  const dx = Math.cos(directionRadians);
  const dz = Math.sin(directionRadians);
  let sumCos = 0;
  let sumSin = 0;
  for (const point of points) {
    const phase = ((point.x * dx + point.z * dz) / period) * 2 * Math.PI;
    sumCos += Math.cos(phase);
    sumSin += Math.sin(phase);
  }
  return (sumCos * sumCos + sumSin * sumSin) / points.length;
}

/** Max deviation of the 16-bin phase histogram from uniform, as a ratio. */
function phaseHistogramExtremes(
  points: readonly Point[],
  axis: "x" | "z",
  period: number,
): { low: number; high: number } {
  const bins = new Array<number>(16).fill(0);
  for (const point of points) {
    const value = axis === "x" ? point.x : point.z;
    const phase = ((value % period) + period) % period;
    bins[Math.min(15, Math.floor((phase / period) * 16))]! += 1;
  }
  const expected = points.length / 16;
  let low = Number.POSITIVE_INFINITY;
  let high = 0;
  for (const count of bins) {
    low = Math.min(low, count / expected);
    high = Math.max(high, count / expected);
  }
  return { low, high };
}

describe("vegetation scatter spectrum (1B-8, assertion 27)", () => {
  it("keeps closed-forest stem density in the ecological band", () => {
    const trees = collectPlacements("trees");
    const hectares = (CELL_SIZE * CELL_SPAN) ** 2 / 10_000;
    const stemsPerHectare = trees.length / hectares;
    expect(stemsPerHectare).toBeGreaterThanOrEqual(300);
    expect(stemsPerHectare).toBeLessThanOrEqual(800);
  });

  it("shows no constant period between 3 and 200 m in either axis", () => {
    // [0.92, 1.08] where lattice periods would live; the window still leaks
    // a few percent of the INTENDED aperiodic clumping band (glades at
    // ~260 m, and 2-11b's 137 m stand field coupling weakly into survivor
    // positions through crown-size spacing) into periods above ~120 m, so
    // the bound there is [0.88, 1.12] — the old 176 m stand lattice
    // measured 0.78/1.17+ and fails either bound.
    for (const kind of ["trees", "shrubs"] as const) {
      const points = collectPlacements(kind);
      expect(points.length).toBeGreaterThan(500);
      for (let period = 3; period <= 200; period += 1) {
        const bound = period <= 120 ? 0.09 : 0.13;
        for (const axis of ["x", "z"] as const) {
          const { low, high } = phaseHistogramExtremes(points, axis, period);
          expect(low, `${kind} ${axis} period ${period}`).toBeGreaterThanOrEqual(1 - bound);
          expect(high, `${kind} ${axis} period ${period}`).toBeLessThanOrEqual(1 + bound);
        }
      }
    }
    // Spectral sweeps are CPU-heavy by design (~3-4 s locally); shared CI
    // runners need the same explicit headroom as world.test.ts's audits.
  }, 120_000);

  it("concentrates no lattice-line power between 10 and 200 m", () => {
    // A phase-coherent lattice concentrates projected power proportional to
    // the stem count — the old 176 m lattice measured >12 with a tenth of
    // these stems, and scales to 50–100 here — while this scatter's radial
    // power stays at or below ~5 everywhere outside the sub-crown
    // stratification knee (which the plan calls physically hidden). The
    // plan's 1.15× local-radial-mean phrasing assumes full 2D annulus
    // averaging; with a directional sweep the same lattices are caught, far
    // more robustly, by this absolute bound.
    const points = collectPlacements("trees");
    const directionCount = 24;
    for (let period = 10; period <= 200; period += 2) {
      let sum = 0;
      for (let index = 0; index < directionCount; index += 1) {
        sum += projectedPower(points, (index / directionCount) * Math.PI, period);
      }
      // The intended clumping band (glade field at 260 m and its 130 m
      // octave) legitimately carries continuum power above the blue floor;
      // a lattice line there would still measure in the hundreds.
      const bound = period > 110 ? 30 : 9;
      expect(sum / directionCount, `period ${period}`).toBeLessThan(bound);
    }
    // ~12 s locally: the next test in line to breach the 30 s default on a
    // 2-3x slower CI runner, so it carries the explicit timeout too.
  }, 120_000);
});
