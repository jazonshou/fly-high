import { describe, expect, it } from "vitest";
import {
  DUNES,
  duneProfileMeanMeters,
  duneProfileMeters,
} from "../src/world/dunes";
import { landformCoreCenter, sampleLandformCover } from "../src/world/landforms";
import {
  sampleFilteredTerrainHeight,
  sampleNaturalTerrainHeight,
  sampleTerrainHeight,
} from "../src/world/terrain";
import { createWorld } from "../src/world/world";
import type { WorldDefinition } from "../src/world/types";

/**
 * Sand seas (src/world/dunes.ts): where they grow, what they are shaped like,
 * and that the rest of the world does not notice them.
 */

const SPACING = DUNES.spacingMeters;

function forcedDesert(seed: string): WorldDefinition {
  return createWorld(seed, { landforms: { dunes: true }, climateProvince: "high-desert" });
}

/** The first point of a coarse spiral, 12-40 km out, where a forced world has a full erg. */
function findFullErg(world: WorldDefinition): { x: number; z: number } {
  const center = landformCoreCenter(world);
  for (let index = 0; index < 4_000; index += 1) {
    const angle = index * 2.399963;
    const radius = 12_000 + 28_000 * ((index * 0.618034) % 1);
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    if (sampleLandformCover(world, x, z, 0).ergWeight > 0.97) return { x, z };
  }
  throw new Error(`no full erg in ${world.seed}`);
}

describe("dune profile", () => {
  it("is continuous across the period boundary for any crest height", () => {
    for (const crest of [0, 3, 9, 16, 22]) {
      expect(duneProfileMeters(0, crest)).toBe(0);
      expect(duneProfileMeters(SPACING - 1e-9, crest)).toBeCloseTo(0, 6);
    }
  });

  it("has the analytic mean it fades toward, within 1%", () => {
    for (const crest of [4, 10, 18, 22]) {
      let sum = 0;
      const steps = 200_000;
      for (let index = 0; index < steps; index += 1) {
        sum += duneProfileMeters(((index + 0.5) / steps) * SPACING, crest);
      }
      const numeric = sum / steps;
      expect(Math.abs(duneProfileMeanMeters(crest) - numeric) / numeric).toBeLessThan(0.01);
    }
  });

  it("puts the slipface on the downwind side, at the design angle", () => {
    const crest = 18;
    const slipStart = SPACING - crest / Math.tan(DUNES.slipDegrees * Math.PI / 180);
    const drop = duneProfileMeters(slipStart + 5, crest) - duneProfileMeters(slipStart + 10, crest);
    expect(Math.atan(drop / 5) * 180 / Math.PI).toBeCloseTo(DUNES.slipDegrees, 3);
  });
});

describe("where sand seas grow", () => {
  it("covers a few per cent of land past 150 km, mostly inside arid provinces, none inside 120 km", () => {
    for (const seed of ["open-skies", "terra1", "kilo77"]) {
      const world = createWorld(seed);
      const center = landformCoreCenter(world);
      let land = 0;
      let erg = 0;
      let inner = 0;
      for (let gx = -600_000; gx <= 600_000; gx += 6_000) {
        for (let gz = -600_000; gz <= 600_000; gz += 6_000) {
          const x = center.x + gx;
          const z = center.z + gz;
          const radius = Math.hypot(gx, gz);
          const cover = sampleLandformCover(world, x, z, 0);
          if (radius < 120_000) {
            if (cover.ergWeight !== 0) inner += 1;
            continue;
          }
          if (radius < 150_000 || sampleNaturalTerrainHeight(world.seedHash, x, z, 0) <= 0) continue;
          land += 1;
          if (cover.ergWeight > 0) erg += 1;
        }
      }
      expect(inner).toBe(0);
      expect(erg / land).toBeGreaterThan(0.025);
      expect(erg / land).toBeLessThan(0.15);
    }
  });

  it("returns the height it was given wherever the erg weight is 0, outside the core too", () => {
    const world = createWorld("terra1");
    const reference = { ...world, worldEvolution: "eroded" as const };
    const center = landformCoreCenter(world);
    let checked = 0;
    for (let index = 0; index < 3_000 && checked < 400; index += 1) {
      const angle = index * 2.399963;
      const radius = 160_000 + (index % 50) * 6_000;
      const x = center.x + Math.cos(angle) * radius;
      const z = center.z + Math.sin(angle) * radius;
      if (sampleLandformCover(world, x, z, 0).ergWeight !== 0) continue;
      expect(Object.is(sampleTerrainHeight(world, x, z), sampleTerrainHeight(reference, x, z))).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(400);
  });
});

describe("a forced sand sea", () => {
  const seeds = ["open-skies", "terra1", "dune-lab", "alps22"];

  it("moves the ground and never sinks land below sea level", () => {
    for (const seed of seeds) {
      const world = forcedDesert(seed);
      const reference = { ...world, worldEvolution: "eroded" as const };
      const site = findFullErg(world);
      let moved = 0;
      for (let index = 0; index < 2_000; index += 1) {
        const x = site.x + ((index * 0.754877) % 1 - 0.5) * 3_000;
        const z = site.z + ((index * 0.569840) % 1 - 0.5) * 3_000;
        const before = sampleTerrainHeight(reference, x, z);
        const after = sampleTerrainHeight(world, x, z);
        if (Math.abs(after - before) > 0.5) moved += 1;
        if (before > world.seaLevel) expect(after).toBeGreaterThan(world.seaLevel);
      }
      expect(moved / 2_000).toBeGreaterThan(0.5);
    }
  });

  it("has ~29-34 degree slipfaces facing downwind and gentle windward slopes (2 m grid)", () => {
    for (const seed of seeds) {
      const world = forcedDesert(seed);
      const site = findFullErg(world);
      const windX = Math.sin(world.prevailingWindRadians);
      const windZ = Math.cos(world.prevailingWindRadians);
      const lee: number[] = [];
      const stoss: number[] = [];
      const step = 2;
      for (let j = 0; j < 300; j += 1) {
        for (let i = 0; i < 300; i += 1) {
          const x = site.x + (i - 150) * step;
          const z = site.z + (j - 150) * step;
          if (sampleLandformCover(world, x, z, 0).ergWeight < 0.9) continue;
          const gx = (sampleTerrainHeight(world, x + 1, z) - sampleTerrainHeight(world, x - 1, z)) / 2;
          const gz = (sampleTerrainHeight(world, x, z + 1) - sampleTerrainHeight(world, x, z - 1)) / 2;
          const slope = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
          const along = gx * windX + gz * windZ;
          if (along < -0.3) lee.push(slope);
          else if (along > 0.02) stoss.push(slope);
        }
      }
      lee.sort((a, b) => a - b);
      stoss.sort((a, b) => a - b);
      expect(lee.length).toBeGreaterThan(1_000);
      expect(lee[Math.floor(lee.length * 0.5)]).toBeGreaterThan(24);
      // The design angle is 29 degrees; the meander, crescent and horn warps
      // compress the phase by up to ~20%, which is what the margin is for.
      expect(lee[Math.floor(lee.length * 0.95)]).toBeLessThan(35);
      expect(lee[lee.length - 1]).toBeLessThan(36);
      const stossMedian = stoss[Math.floor(stoss.length * 0.5)]!;
      expect(stossMedian).toBeGreaterThan(4);
      expect(stossMedian).toBeLessThan(12);
    }
  });

  it("keeps a coarse page's mean ground equal to a fine page's (the profile fades to its mean)", () => {
    const world = forcedDesert("dune-lab");
    const site = findFullErg(world);
    let fine = 0;
    let coarse = 0;
    let count = 0;
    for (let index = 0; index < 20_000; index += 1) {
      const x = site.x + ((index * 0.754877) % 1 - 0.5) * 2_000;
      const z = site.z + ((index * 0.569840) % 1 - 0.5) * 2_000;
      if (sampleLandformCover(world, x, z, 0).ergWeight < 0.95) continue;
      const dune = sampleLandformCover(world, x, z, 0).duneHeight;
      // At a 128 m filter width the 260 m profile is fully faded (band
      // weight 0); the dune field is then its per-point mean.
      const faded = sampleLandformCover(world, x, z, 128).duneHeight;
      fine += dune;
      coarse += faded;
      count += 1;
    }
    expect(count).toBeGreaterThan(5_000);
    expect(Math.abs(fine / count - coarse / count)).toBeLessThan(0.35);
  });

  it("keeps the forced world's runway clearance flat-natural", () => {
    const world = forcedDesert("open-skies");
    const reference = { ...world, worldEvolution: "eroded" as const };
    const center = landformCoreCenter(world);
    for (let index = 0; index < 200; index += 1) {
      const angle = index * 2.399963;
      const radius = 4_900 * Math.sqrt((index + 0.5) / 200);
      const x = center.x + Math.cos(angle) * radius;
      const z = center.z + Math.sin(angle) * radius;
      expect(Object.is(
        sampleFilteredTerrainHeight(world, x, z, 0),
        sampleFilteredTerrainHeight(reference, x, z, 0),
      )).toBe(true);
    }
  });
});

describe("the arid factor", () => {
  it("reads exactly the unmasked province dryness", async () => {
    const { sampleClimateProvinceUnmasked } = await import("../src/world/climateProvince");
    const { unmaskedProvinceDryness } = await import("../src/world/dunes");
    const world = createWorld("terra1");
    for (let index = 0; index < 500; index += 1) {
      const x = (index * 7_919) % 900_000 - 450_000;
      const z = (index * 104_729) % 900_000 - 450_000;
      expect(unmaskedProvinceDryness(world.seedHash, x, z))
        .toBe(sampleClimateProvinceUnmasked(world.seedHash, x, z).dryness);
    }
  });
});
