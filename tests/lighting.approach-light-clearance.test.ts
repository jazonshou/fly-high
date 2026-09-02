import { describe, expect, it } from "vitest";
import { createWorld, sampleTerrain } from "../src/world";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import { DEFAULT_DETAIL_CELL_SIZE_METERS } from "../src/render/webgpu/detail/types";
import { CANOPY_DOMINANT_CROWN_RADIUS_METERS } from "../src/render/webgpu/detail/densityField";
import { airfieldStructureExclusions } from "../src/render/webgpu/airfield/StructureExclusion";
import { airfieldFixtures } from "../src/render/webgpu/lighting/AirfieldLighting";

/**
 * `7-7b`: no tree grows into the approach lights.
 *
 * **Counted, not evaluated.** The obvious test is to sample
 * `structureClearanceFactor` along the row and assert it is zero. That test
 * passes while trees stand in the crossbar: density is sampled on a 32 m block
 * lattice and interpolated to each stem, so a block centre outside the corridor
 * leaks full density back inside it. The sibling hangar work measured stems
 * going 73 -> 3 that way, not 73 -> 0. **The factor is a property of the field;
 * the stems are the product.**
 *
 * **Crowns, not trunks.** A stem 4 m from a lamp is inside nothing, and its
 * 5.8 m crown is over the lamp. Measured before the fix: trunks within 2 m of a
 * lamp counted 2, crowns reaching a lamp counted 6. **The crown is what a pilot
 * sees**, and counting trunks would have understated the defect threefold.
 *
 * **The negative control is part of the test rather than a note about it.**
 * Generating the same cells with no boxes must find vegetation in the lamps, or
 * this file is asserting zero against a world that never had any and would stay
 * green if the exclusion were deleted.
 */

const CROWN = CANOPY_DOMINANT_CROWN_RADIUS_METERS;

/**
 * A stem's own reach. A tree carries `crownRadiusMeters`, a shrub carries
 * `radiusMeters`, and they differ by roughly a factor of six. Falling back to
 * the dominant CROWN radius for a shrub inflated this count from 8 to 56 in an
 * earlier draft of this file — every shrub within 5.8 m of a lamp counted as
 * standing in it, when a shrub's own crown reaches nothing like that far.
 */
interface Stem {
  readonly x: number;
  readonly z: number;
  readonly crownRadiusMeters?: number;
  readonly radiusMeters?: number;
}

describe("7-7b: vegetation is kept out of the approach lighting system", () => {
  it("leaves no tree or shrub crown reaching an approach lamp", () => {
    const world = createWorld("phase1-perf-baseline");
    const airport = world.airport;
    expect(airport, "the capture world has no airport").toBeDefined();

    const sampler = (x: number, z: number) => {
      const t = sampleTerrain(world, x, z);
      return {
        height: t.height,
        slope: t.normal ? 1 - t.normal.y : 0,
        moisture: t.moisture,
        biome: t.biome,
        normal: t.normal,
        airportInfluence: t.airportInfluence,
      };
    };

    const lamps = airfieldFixtures(airport!).filter((f) => f.kind === "approach");
    expect(lamps.length, "no approach lamps to protect").toBe(32);

    const cell = DEFAULT_DETAIL_CELL_SIZE_METERS;
    const xs = lamps.map((l) => l.x);
    const zs = lamps.map((l) => l.z);
    const x0 = Math.floor((Math.min(...xs) - CROWN) / cell);
    const x1 = Math.floor((Math.max(...xs) + CROWN) / cell);
    const z0 = Math.floor((Math.min(...zs) - CROWN) / cell);
    const z1 = Math.floor((Math.max(...zs) + CROWN) / cell);

    const boxes = airfieldStructureExclusions(airport!, world.seedHash);
    const inLamps = (withBoxes: boolean): number => {
      let hits = 0;
      for (let cz = z0; cz <= z1; cz += 1) {
        for (let cx = x0; cx <= x1; cx += 1) {
          const generated = generateDetailCell({
            worldSeed: world.seed,
            cellX: cx,
            cellZ: cz,
            terrainSample: sampler,
            seaLevelMeters: world.seaLevel,
            dayOfYear: 171,
            latitudeDegrees: world.latitudeDegrees,
            ...(withBoxes ? { structureExclusions: boxes, exclusionAirport: airport! } : {}),
          });
          for (const stem of [...generated.trees, ...generated.shrubs] as Stem[]) {
            const reach = stem.crownRadiusMeters ?? stem.radiusMeters ?? CROWN;
            if (lamps.some((l) => Math.hypot(stem.x - l.x, stem.z - l.z) <= reach)) hits += 1;
          }
        }
      }
      return hits;
    };

    // NEGATIVE CONTROL FIRST. Without the boxes this world puts vegetation in
    // the lamps; if it did not, the assertion below would be vacuous and would
    // survive the exclusion being deleted.
    const unprotected = inLamps(false);
    expect(
      unprotected,
      "this world has no vegetation in the approach lamps even with no exclusion, "
      + "so the assertion below proves nothing — pick a seed or cells that do",
    ).toBeGreaterThan(0);

    expect(
      inLamps(true),
      `${inLamps(true)} stems still have a crown over an approach lamp (${unprotected} without `
      + "the exclusion). The approach row runs to 1,080 m and `getAirportInfluence` is spent by "
      + "980 m, so these lamps are protected only by `approachLightExclusionBoxes`.",
    ).toBe(0);
  }, 120_000);
});
