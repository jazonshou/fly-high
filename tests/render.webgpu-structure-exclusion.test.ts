import { describe, expect, it } from "vitest";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  airfieldStructureExclusions,
  structureClearanceFactor,
} from "../src/render/webgpu/airfield/StructureExclusion";
import { hangarFootprint, HANGAR_SITING } from "../src/render/webgpu/airfield/AirfieldStructures";
import { runwayToWorld, worldToRunway } from "../src/world/airport";
import { createWorld } from "../src/world/world";
import { TerrainBiome } from "../src/world";

/**
 * Nothing scattered on the ground may stand inside an airfield structure.
 *
 * **`7b33491` fixed trees and shrubs, shipped NO GUARD, and left clutter and
 * rocks unfixed.** Both halves of that mattered. The unfixed half meant the
 * complaint Jason made by eye — things growing through hangars — read as
 * closed while a fallen log could still stand inside one. The unguarded half
 * meant the part that WAS fixed had nothing stopping it regressing; the only
 * other test touching `StructureExclusion` is the approach-lighting one, which
 * imports it for a different concern.
 *
 * `structureClearanceFactor` was consulted at exactly one call site, the stem
 * loop. Clutter and rocks used `airportClearance` alone, which is
 * `1 - airportInfluence`: a multiplicative thin keyed on the airport's
 * rounded-rectangle influence field, which knows the airport but **not its
 * buildings**. Measured on the shipping capture world, that field reaches only
 * 0.4706-0.7222 on a hangar footprint, so clearance there is 0.28-0.53 — it
 * lowers the odds of a log inside a hangar and **can never reach zero**.
 *
 * **THE CONTROL IS ARMED BY CONSTRUCTION, NOT BY SEARCH.** A test that
 * generated the shipping world and asserted "nothing inside a hangar" would
 * pass on a world that places nothing there — and `phase1-perf-baseline` is
 * exactly such a world, so that test would have been green before the fix and
 * after it. Across 40 random worlds the rate is about **0.6 objects per
 * world**, so a search wide enough to arm reliably costs a minute of suite
 * time. Instead the terrain samples below are stubs that raise density over
 * the REAL hangar footprints of a real airport: the geometry under test is
 * genuine, only the population is lifted until the defect is visible in one
 * cell.
 *
 * Each population's FIRST assertion is its arming one, and it fails if the
 * control ever stops placing that population inside a structure. Verified by
 * deliberate red, one gate at a time — trees 148, shrubs 284, clutter 4,
 * rocks 1 instances surviving when the corresponding gate is neutered.
 */

/**
 * Every scattered population that can stand on the ground inside a building.
 * Ground cover is deliberately absent: it is GPU-placed through
 * `GroundCoverSystem` on a path this generator never touches, so asserting it
 * here would be asserting nothing.
 */
const POPULATIONS = ["trees", "shrubs", "clutter", "rocks"] as const;
type Population = (typeof POPULATIONS)[number];

describe("scattered vegetation obeys the structure exclusion", () => {
  it("removes every object standing inside a structure, and strips no surround", () => {
    const world = createWorld("clutter-structure-exclusion");
    const airport = world.airport;
    expect(airport, "the seed must produce an airport for this test to mean anything").toBeTruthy();
    const boxes = airfieldStructureExclusions(airport!, world.seedHash);
    expect(boxes.length, "no exclusion boxes — the gate would be trivially satisfied")
      .toBeGreaterThan(0);

    // **TWO GROUND STUBS, BECAUSE ONE CANNOT ARM ALL FOUR.** Woody plants and
    // clutter want closed, damp, flat forest; rocks want relief and a stony
    // biome — `rockLagProbability` reads 0.04 for FOREST against 0.18 for
    // HIGHLAND and adds `slope * 0.35`. On the flat forest stub alone, rocks
    // expected inside a footprint work out below one per cell, and the arming
    // assertion below caught exactly that rather than passing on an empty
    // scan. Each population is therefore asserted on ground where it actually
    // occurs. The hangar geometry and the exclusion boxes are the world's own
    // in both.
    const GROUNDS = [
      {
        name: "closed damp forest",
        arms: ["trees", "shrubs", "clutter"] as const,
        sample: () => ({
          height: 40, slope: 0.02, moisture: 0.8,
          biome: TerrainBiome.FOREST, airportInfluence: 0,
        }),
      },
      {
        name: "stony highland relief",
        arms: ["rocks"] as const,
        sample: () => ({
          height: 900, slope: 0.5, moisture: 0.4,
          biome: TerrainBiome.HIGHLAND, airportInfluence: 0,
        }),
      },
    ];

    const centre = runwayToWorld(
      airport!,
      hangarFootprint(airport!, 1).along,
      hangarFootprint(airport!, 1).across,
    );
    const CELL = 256;

    type Cell = Record<Population, readonly { readonly x: number; readonly z: number }[]>;
    const generate = (gated: boolean, sample: () => unknown): Cell => generateDetailCell({
      worldSeed: world.seed,
      cellX: Math.floor(centre.x / CELL),
      cellZ: Math.floor(centre.z / CELL),
      cellSizeMeters: CELL,
      terrainSample: sample as never,
      seaLevelMeters: world.seaLevel,
      ...(gated ? { structureExclusions: boxes, exclusionAirport: airport! } : {}),
    } as never) as unknown as Cell;

    /** Instances standing where the exclusion is hard-zero — the population the gate owns. */
    const insideStructures = (cell: Cell, population: Population): number => {
      let n = 0;
      for (const p of cell[population]) {
        if (structureClearanceFactor(airport!, boxes, p.x, p.z) <= 0) n += 1;
      }
      return n;
    };

    // **ALL FOUR POPULATIONS, ASSERTED SEPARATELY.** `7b33491` fixed trees and
    // shrubs and shipped no guard at all; this file was then written for the
    // clutter and rocks it had missed. Covering only the new half would leave
    // the half Jason can actually see — trees growing through hangars —
    // exactly as unguarded as it was before. A per-population assertion also
    // names which one regressed, which a summed count cannot.
    for (const ground of GROUNDS) {
      const control = generate(false, ground.sample);
      const gated = generate(true, ground.sample);

      for (const population of ground.arms) {
        const controlInside = insideStructures(control, population);

        // ARMING, per population. Without it the next assertion passes on an
        // empty scan, which is how a guard for a rare event stays green
        // through its own regression.
        expect(
          controlInside,
          `on ${ground.name}, the ungated control placed NO ${population} inside a structure, `
          + "so the gated arm's zero would prove nothing for this population. Either the "
          + `stub has stopped producing ${population}, or its placement moved. Fix the arming `
          + "before trusting the result.",
        ).toBeGreaterThan(0);

        expect(
          insideStructures(gated, population),
          `${insideStructures(gated, population)} ${population} instances stand inside a hangar `
          + `footprint on ${ground.name}, where the control placed ${controlInside}. `
          + "`airportClearance` is a multiplicative thin and cannot reach zero; only the hard "
          + "structure gate can empty a building.",
        ).toBe(0);
      }

      // The surround must survive: this is an exclusion, not a cull. The blend
      // band thins, so some loss is expected and a total wipe is the failure.
      const total = (cell: Cell): number =>
        POPULATIONS.reduce((sum, p) => sum + cell[p].length, 0);
      const controlTotal = total(control);
      expect(controlTotal, `${ground.name} generated nothing at all`).toBeGreaterThan(0);
      expect(
        total(gated) / controlTotal,
        `on ${ground.name} the gate removed ${controlTotal - total(gated)} of ${controlTotal} `
        + "instances across the whole cell. It is meant to empty the buildings and thin their "
        + "blend band, not the airfield.",
      ).toBeGreaterThan(0.5);
    }
  });

  it("keeps the exclusion hard-zero over every hangar footprint", () => {
    const world = createWorld("clutter-structure-exclusion");
    const airport = world.airport!;
    const boxes = airfieldStructureExclusions(airport, world.seedHash);
    for (let i = 0; i < HANGAR_SITING.count; i += 1) {
      const fp = hangarFootprint(airport, i);
      const centre = runwayToWorld(airport, fp.along, fp.across);
      expect(
        structureClearanceFactor(airport, boxes, centre.x, centre.z),
        `hangar-${i}'s own centre is not hard-excluded, so nothing above can be relied on`,
      ).toBe(0);
      // And a point well outside must NOT be excluded, or the factor is just
      // returning zero everywhere and the test above is vacuous.
      const outside = runwayToWorld(airport, fp.along, fp.across + 400);
      expect(
        structureClearanceFactor(airport, boxes, outside.x, outside.z),
        "a point 400 m across from the hangar is excluded too — the factor is zero everywhere "
        + "and every exclusion assertion in this file is vacuous",
      ).toBe(1);
      // Frame check: the footprint is runway-local, so a world-space mistake
      // would put these points somewhere else entirely.
      const back = worldToRunway(airport, centre.x, centre.z);
      expect(back.along).toBeCloseTo(fp.along, 3);
      expect(back.across).toBeCloseTo(fp.across, 3);
    }
  });
});
