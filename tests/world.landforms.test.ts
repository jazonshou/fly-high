import { describe, expect, it } from "vitest";
import {
  LANDFORM_CORE,
  landformCoreCenter,
  landformCoreMask,
  resolveLandformsOption,
} from "../src/world/landforms";
import { sampleFilteredTerrainHeight, sampleNaturalTerrainHeight, sampleTerrainHeight } from "../src/world/terrain";
import { createWorld } from "../src/world/world";
import type { WorldDefinition } from "../src/world/types";

/**
 * The landform stage's containment: inside the 120 km core every world height
 * is the natural kernel plus the earthworks, bit for bit, so no baseline, no
 * airport and no horizon bake near the start can move.
 */

function withoutLandforms(world: WorldDefinition): WorldDefinition {
  // An eroded world skips the stage entirely: the same kernel, the same
  // earthworks, no landforms — the reference the analytic world must match.
  return { ...world, worldEvolution: "eroded" };
}

describe("landform core", () => {
  const seeds = ["open-skies", "terra1", "kilo77", "dune-lab"];

  it("is exactly 0 inside 120 km of the start airport and 1 past 150 km", () => {
    for (const seed of seeds) {
      const world = createWorld(seed);
      const center = landformCoreCenter(world);
      expect(landformCoreMask(world, center.x + LANDFORM_CORE.innerRadiusMeters - 1, center.z)).toBe(0);
      expect(landformCoreMask(world, center.x, center.z - 150_001)).toBe(1);
    }
  });

  it("returns the natural height plus earthworks BIT FOR BIT inside the core", () => {
    let probes = 0;
    for (const seed of seeds) {
      const world = createWorld(seed);
      const reference = withoutLandforms(world);
      const center = landformCoreCenter(world);
      for (let index = 0; index < 400; index += 1) {
        const angle = index * 2.399963;
        const radius = 119_000 * Math.sqrt((index + 0.5) / 400);
        const x = center.x + Math.cos(angle) * radius;
        const z = center.z + Math.sin(angle) * radius;
        expect(Object.is(sampleTerrainHeight(world, x, z), sampleTerrainHeight(reference, x, z))).toBe(true);
        for (const width of [0, 128, 512]) {
          expect(Object.is(
            sampleFilteredTerrainHeight(world, x, z, width),
            sampleFilteredTerrainHeight(reference, x, z, width),
          )).toBe(true);
        }
        probes += 1;
      }
    }
    expect(probes).toBe(1_600);
  });

  it("leaves the natural kernel itself untouched (the airport search reads it)", () => {
    const world = createWorld("dune-lab", { landforms: { dunes: true } });
    const before = createWorld("dune-lab");
    expect(world.airport).toEqual(before.airport);
    expect(world.seedHash).toBe(before.seedHash);
    expect(sampleNaturalTerrainHeight(world.seedHash, 30_000, -20_000, 0))
      .toBe(sampleNaturalTerrainHeight(before.seedHash, 30_000, -20_000, 0));
  });
});

describe("forced landforms option", () => {
  it("resolves to null when nothing is forced", () => {
    expect(resolveLandformsOption(undefined)).toBeNull();
    expect(resolveLandformsOption({})).toBeNull();
    expect(resolveLandformsOption({ dunes: false, volcanic: false })).toBeNull();
    expect(createWorld("open-skies").landforms).toBeNull();
  });

  it("resolves each landform to a frozen flag pair", () => {
    expect(resolveLandformsOption({ dunes: true })).toEqual({ dunes: true, volcanic: false });
    expect(resolveLandformsOption({ volcanic: true })).toEqual({ dunes: false, volcanic: true });
    expect(Object.isFrozen(createWorld("open-skies", { landforms: { dunes: true } }).landforms)).toBe(true);
  });

  it("rejects unknown landforms and non-boolean flags", () => {
    expect(() => resolveLandformsOption({ mesas: true } as never)).toThrow(RangeError);
    expect(() => resolveLandformsOption({ dunes: 1 } as never)).toThrow(RangeError);
  });

  it("shrinks the core to a runway clearance in a forced world", () => {
    const world = createWorld("open-skies", { landforms: { dunes: true } });
    const center = landformCoreCenter(world);
    expect(landformCoreMask(world, center.x + LANDFORM_CORE.forcedClearanceMeters - 1, center.z)).toBe(0);
    expect(landformCoreMask(world, center.x + 8_001, center.z)).toBe(1);
  });
});
