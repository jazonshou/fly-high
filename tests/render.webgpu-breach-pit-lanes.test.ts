import { describe, expect, it } from "vitest";
import { breachLocalPits, TERRAIN_EROSION_PRODUCTION_CONFIG } from "@/src/render/webgpu/terrain/TerrainErosionCompute";
import { buildTerrainErosionSeedFields } from "@/src/render/webgpu/terrain/TerrainPageErosion";
import {
  BREACH_PIT_LANES,
  betterBreachChoice,
  laneReducedBreach,
  laneReducedBreachChoice,
} from "./support/breachPitLanes";
import { BREACH_SURVEY_PAGE_SETS } from "./support/erosionSurveyPages";

/**
 * The breach pit carve, one workgroup per pit: its lanes stride the window and
 * a tree reduction picks the target (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md).
 * What the GPU identity gate cannot show on its own: that the reduction's
 * rule picks exactly the serial search's target, including every tie, on the
 * pages the survey measured and on a surface built to tie.
 */

const RADIUS = TERRAIN_EROSION_PRODUCTION_CONFIG.pitBreachRadiusTexels;
const EPSILON = TERRAIN_EROSION_PRODUCTION_CONFIG.drainageEpsilonMetersPerTexel;

/**
 * The pages compared on every run: five of the survey's sixteen. A page costs 2.5-8 s
 * to seed (`buildTerrainErosionSeedFields`) and under 0.1 s to compare, and the real
 * build's five level 0 and 1 pages carry 16 pits between them. Kept: the fixture's
 * cost-test page and its densest page, and the real build's pages at levels 2, 3 and 4:
 * 1,882 pits of the sixteen pages' 3,640 (measured 2026-11-14). The tie case above, and
 * tests/gpu/breach-pit-parallel-identity.test.ts on the GPU, are unchanged.
 */
const CHECKED_PAGES: Readonly<Record<string, readonly string[]>> = {
  fixture: ["L3 -3,5", "L5 -1,1"],
  real: ["L2 2,2", "L3 1,-2", "L4 0,0"],
};

function sameBits(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let differences = 0;
  for (let index = 0; index < a.length; index += 1) if (!Object.is(a[index], b[index])) differences += 1;
  return differences;
}

describe("breach pit lanes: the reduction picks the serial search's target", () => {
  it("on a surface built to tie across lanes, the lowest index wins", () => {
    // A pit at the centre of a flat rim: every rim target at one distance
    // scores the same, and they fall in different lanes.
    const edge = 41;
    const height = new Float32Array(edge * edge).fill(10);
    const centre = 20 * edge + 20;
    height[centre] = 12;
    const mask = new Uint8Array(edge * edge);
    const choice = laneReducedBreachChoice(edge, height, mask, 20, 20, RADIUS, EPSILON);
    // The serial rule over the same targets, written out directly.
    let serial: ReturnType<typeof laneReducedBreachChoice> = null;
    for (let dz = -RADIUS; dz <= RADIUS; dz += 1) {
      for (let dx = -RADIUS; dx <= RADIUS; dx += 1) {
        const steps = Math.max(Math.abs(dx), Math.abs(dz));
        if (steps === 0) continue;
        const target = (20 + dz) * edge + (20 + dx);
        const distance = Math.hypot(dx, dz);
        if (!(height[target]! + EPSILON * distance < height[centre]!)) continue;
        serial = betterBreachChoice(serial, { dx, dz, steps, target, score: height[target]! + EPSILON * distance });
      }
    }
    expect(choice).not.toBeNull();
    expect(choice).toEqual(serial);
    // The four nearest neighbours tie on score; the lowest index among them is (0, -1).
    expect({ dx: choice!.dx, dz: choice!.dz }).toEqual({ dx: 0, dz: -1 });
    // They are spread over lanes, so the reduction, not a single lane, decided it.
    const lanes = new Set([(-1 + RADIUS) * (RADIUS * 2 + 1) + RADIUS, RADIUS * (RADIUS * 2 + 1) + RADIUS - 1]
      .map((t) => t % BREACH_PIT_LANES));
    expect(lanes.size).toBeGreaterThan(1);
  });

  for (const set of BREACH_SURVEY_PAGE_SETS) {
    it(`carves every pit of the ${set.name} survey pages exactly as breachLocalPits does`, () => {
      const checked = CHECKED_PAGES[set.name] ?? [];
      const pages = set.pages.filter((address) => checked.includes(`L${address.level} ${address.x},${address.z}`));
      // Every kept page is still in the survey, so a renamed or moved page fails here, not silently.
      expect(pages.length, `${set.name}: checked pages found in the survey`).toBe(checked.length);
      const world = set.world();
      const macro = set.macro(world);
      let pits = 0;
      for (const address of pages) {
        const seed = buildTerrainErosionSeedFields(world, macro, address);
        const serial = breachLocalPits(seed.scratchEdge, seed.sourceHeight, RADIUS, EPSILON, { erosionMask: seed.erosionMask });
        const lanes = laneReducedBreach(seed.scratchEdge, seed.sourceHeight, seed.erosionMask, RADIUS, EPSILON);
        const label = `${set.name} L${address.level} ${address.x},${address.z}`;
        expect(sameBits(lanes.breachedHeight, serial.breachedHeight), `${label} heights`).toBe(0);
        expect(sameBits(lanes.breachReceivers, serial.breachReceivers), `${label} receivers`).toBe(0);
        pits += lanes.pits;
      }
      // Non-vacuity: the pages carry pits, or the comparison proved nothing.
      expect(pits).toBeGreaterThan(set.name === "fixture" ? 1_000 : 300);
    }, 300_000);
  }
});
