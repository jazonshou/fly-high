import { describe, expect, it } from "vitest";

import { createWorld } from "../src/world/world";
import { DEFAULT_AIRPORT } from "../src/world/airport";
import {
  FUEL_FARM_LATERAL_OFFSET_METERS,
  airfieldFootprintsOverlap,
  airfieldLateralBand,
} from "../src/render/webgpu/detail/AirfieldFurniture";
import { hangarFootprint } from "../src/render/webgpu/airfield/AirfieldStructures";

/**
 * The airfield's structures do not occupy the same ground.
 *
 * **This replaces a comment that was endorsed and wrong.** The lateral band
 * used to be a list of one number per structure. It recorded LINES for objects
 * with WIDTH, mixed two `across` conventions without saying which row used
 * which, and answered a one-dimensional question about a two-dimensional
 * problem — the tower's `across` is exactly the hangars' inboard edge and is
 * clear only because `along` separates them, an axis the list could not show.
 *
 * It read as authoritative because it was tidy, which is the third record of
 * that shape found today.
 *
 * **So the band is derived and this asserts it.** A collision is now arithmetic
 * that fails a build, which is what the comment always said it wanted to be.
 */

const WORLDS = ["hangar-a", "phase1-perf-baseline", "1s9phln"].map((seed) => ({
  seed,
  world: createWorld(seed),
}));

describe("the airfield lateral band", () => {
  it("has no two structures overlapping in both axes", () => {
    for (const { seed, world } of WORLDS) {
      const airport = world.airport;
      if (!airport) continue;
      const band = airfieldLateralBand(airport);
      const collisions: string[] = [];
      for (let i = 0; i < band.length; i += 1) {
        for (let j = i + 1; j < band.length; j += 1) {
          if (airfieldFootprintsOverlap(band[i]!, band[j]!)) {
            collisions.push(`${band[i]!.name} x ${band[j]!.name}`);
          }
        }
      }
      expect(
        collisions,
        `${seed}: these structures occupy the same ground. A lateral offset alone `
          + "does not clear anything with width — check the along span too.",
      ).toEqual([]);
    }
  });

  it("is load-bearing: the fuel farm still overlaps the hangars on ACROSS alone", () => {
    // NON-VACUITY, and the reason both axes are recorded. If the farm were also
    // clear laterally, the two-axis check would be ceremony and a future edit
    // could drop the `along` half without any test noticing.
    const airport = DEFAULT_AIRPORT;
    const fuelAcross = airport.runwayWidth / 2 + FUEL_FARM_LATERAL_OFFSET_METERS;
    const hangar = hangarFootprint(airport, 0);
    expect(fuelAcross).toBeGreaterThan(hangar.across - hangar.widthMeters / 2);
    expect(fuelAcross).toBeLessThan(hangar.across + hangar.widthMeters / 2);
  });

  it("keeps the fence outside everything, since it cannot be cleared by along", () => {
    // The fence runs the length of the field, so its `along` span is null and it
    // overlaps everything on that axis by construction. Its clearance is
    // therefore entirely lateral — which is why it is the outermost row.
    const band = airfieldLateralBand(DEFAULT_AIRPORT);
    const fence = band.find((entry) => entry.name === "fence");
    expect(fence, "no fence in the band").toBeTruthy();
    expect(fence!.along, "the fence should span the whole field").toBeNull();
    for (const entry of band) {
      if (entry.name === "fence" || entry.along === null) continue;
      expect(
        entry.across[1],
        `${entry.name} reaches past the fence`,
      ).toBeLessThanOrEqual(fence!.across[0]);
    }
  });

  it("records a span for everything with width, not a centre", () => {
    // The specific fault of the record this replaces. A zero-width entry is a
    // line, and a line cannot collide with anything — which is how the hangars
    // were listed as "118 m" while spanning 46.
    for (const entry of airfieldLateralBand(DEFAULT_AIRPORT)) {
      expect(entry.across[1], `${entry.name} has no across span`)
        .toBeGreaterThan(entry.across[0]);
    }
  });
});
