import { describe, expect, it } from "vitest";
import {
  createWorld,
  findSpawnedAirport,
  getRunwayEnds,
  sampleNaturalTerrainHeight,
  sampleTerrainHeight,
  landformGroundAllowsAirport,
  spawnedAirportGroundAllowed,
  spawnedAirportSiteHeight,
  type AirportDefinition,
  type WorldDefinition,
} from "@/src/world";
import { DUNES, SAND_SEA_ERG_WEIGHT } from "@/src/world/dunes";
import { inSandSea, sampleLandformCover } from "@/src/world/landforms";

/** Runs one anchored spawn search to completion, as the spawn worker does. */
function spawnFrom(
  world: WorldDefinition,
  x: number,
  z: number,
  heading: number,
): Readonly<AirportDefinition> | null {
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(world, x, z, heading, attempt);
    if (result === "exhausted") return null;
    if (result) return result;
  }
}

// A natural sand sea 200 km north of the open-skies home field, past the
// landform core, and the forced one the review shots fly over (22 km from the
// phase1-perf-baseline home field).
const NATURAL_ERG = { x: -3_811, z: 215_548 } as const;
const FORCED_ERG = { x: 7_271, z: -50_295 } as const;

function forcedDuneWorld(): WorldDefinition {
  return createWorld("phase1-perf-baseline", {
    climateProvince: "high-desert",
    landforms: { dunes: true },
  });
}

describe("spawned airports on the landforms", () => {
  it("survey the natural kernel inside the landform core, bit for bit", () => {
    // So every spawn within 120 km of the home field is the one the natural
    // kernel gave before the landform stage reached the airport network.
    const world = createWorld("open-skies");
    const home = world.airport!;
    const siteHeight = spawnedAirportSiteHeight(world);
    for (const [dx, dz] of [[0, 9_000], [-30_000, 40_000], [80_000, -60_000], [-110_000, 0]] as const) {
      const x = home.centerX + dx;
      const z = home.centerZ + dz;
      expect(siteHeight(x, z)).toBe(sampleNaturalTerrainHeight(world.seedHash, x, z, 0));
    }
  });

  it("survey the dunes outside it: the ground the world draws and collides with", () => {
    const world = forcedDuneWorld();
    const siteHeight = spawnedAirportSiteHeight(world);
    let largestDuneMeters = 0;
    // Downwind across a few crests, far from every airport's earthworks.
    for (let step = 0; step < 24; step += 1) {
      const x = FORCED_ERG.x + Math.sin(world.prevailingWindRadians) * step * 40;
      const z = FORCED_ERG.z + Math.cos(world.prevailingWindRadians) * step * 40;
      const height = siteHeight(x, z);
      expect(height).toBe(sampleTerrainHeight(world, x, z));
      largestDuneMeters = Math.max(
        largestDuneMeters,
        Math.abs(height - sampleNaturalTerrainHeight(world.seedHash, x, z, 0)),
      );
    }
    // The natural kernel has neither the dunes nor the flattened floor.
    expect(largestDuneMeters).toBeGreaterThan(5);
  });

  it("refuses a sand sea, interdune corridors included, and never sand", () => {
    // The threshold is where the erg's tallest crest starts to read as sand.
    const e = SAND_SEA_ERG_WEIGHT;
    const tallestCrest = e * (DUNES.crestHeightMinMeters
      + (DUNES.crestHeightMaxMeters - DUNES.crestHeightMinMeters) * e);
    expect(tallestCrest).toBeCloseTo(DUNES.sandCoverLowMeters, 12);

    const world = createWorld("open-skies");
    const home = world.airport!;
    // The home field itself stands on neither (the home marina's quay nearby refuses a spawned airport there, not the land).
    expect(landformGroundAllowsAirport(world, home.centerX, home.centerZ)).toBe(true);
    expect(spawnedAirportGroundAllowed(world, NATURAL_ERG.x, NATURAL_ERG.z)).toBe(false);
    expect(spawnedAirportGroundAllowed(forcedDuneWorld(), FORCED_ERG.x, FORCED_ERG.z)).toBe(false);

    // A 3 km square over the natural erg's edge, every 60 m.
    let refused = 0;
    let corridors = 0;
    let allowed = 0;
    for (let row = -25; row <= 25; row += 1) {
      for (let column = -25; column <= 25; column += 1) {
        const x = NATURAL_ERG.x + column * 60;
        const z = NATURAL_ERG.z + row * 60;
        const cover = sampleLandformCover(world, x, z, 0);
        const sandSea = inSandSea(world, x, z);
        expect(sandSea).toBe(cover.ergWeight >= SAND_SEA_ERG_WEIGHT);
        // No runway ever stands on ground that reads as sand.
        if (cover.sandCover > 0) expect(spawnedAirportGroundAllowed(world, x, z)).toBe(false);
        if (sandSea) refused += 1;
        else allowed += 1;
        if (sandSea && cover.sandCover === 0) corridors += 1;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(0);
    expect(corridors).toBeGreaterThan(0);
  });

  it("spawns no runway in a sand sea", () => {
    const world = createWorld("open-skies");
    for (const heading of [0, 2]) {
      const airport = spawnFrom(world, NATURAL_ERG.x, NATURAL_ERG.z, heading);
      expect(airport).not.toBeNull();
      expect(inSandSea(world, airport!.centerX, airport!.centerZ)).toBe(false);
      for (const { threshold } of getRunwayEnds(airport!)) {
        expect(inSandSea(world, threshold.x, threshold.z)).toBe(false);
      }
    }
  });

  it("keeps a forced world's spawn survey apart from the natural world's", () => {
    // The survey is memoised per anchor; a forced world of the same seed
    // reads other ground and refuses other centres (here, all of them).
    const natural = createWorld("open-skies");
    const forced = createWorld("open-skies", { landforms: { dunes: true } });
    const home = natural.airport!;
    const anchor = { x: home.centerX + 15_000, z: home.centerZ };
    const fresh = spawnFrom(natural, anchor.x, anchor.z, 0);
    expect(fresh).not.toBeNull();
    spawnFrom(natural, home.centerX - 15_000, home.centerZ, 0);
    expect(spawnFrom(forced, anchor.x, anchor.z, 0)).toBeNull();
    expect(spawnFrom(natural, anchor.x, anchor.z, 0)).toEqual(fresh);
  });
});
