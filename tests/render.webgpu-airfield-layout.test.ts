import { describe, expect, it } from "vitest";

import { createWorld } from "../src/world/world";
import { DEFAULT_AIRPORT } from "../src/world/airport";
import {
  FUEL_FARM_LATERAL_OFFSET_METERS,
  airfieldFootprintsOverlap,
  airfieldLateralBand,
} from "../src/render/webgpu/detail/AirfieldFurniture";
import {
  fuelTankPlacements,
  perimeterFenceStations,
  signLateralOffsetMeters,
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

describe("the band describes the objects that exist", () => {
  it("puts the fuel farm where fuelTankPlacements actually puts it", () => {
    // THE DEFECT THIS EXISTS FOR, and it shipped in the commit that added the
    // band. `airfieldLateralBand` placed the fuel farm at
    // `runwayLength * 0.14` — 184.8 m along on the default airport — and added
    // a half-runway-width to its `across`. The tanks are at `along` 0 +/- 9
    // and `across` 135 exactly. The model was 184.8 m and 17 m from the real
    // object, and its footprint contained NONE of the real tanks.
    //
    // The overlap tests below all passed, because a phantom 184.8 m away
    // clears everything a real one does. They were checking an object that
    // does not exist.
    //
    // A MODEL-VERSUS-ARTIFACT ASSERTION IS THE ONLY KIND THAT CATCHES THIS.
    // Every other test in this file compares band entries to each other, so
    // they agree by construction no matter how wrong the band is.
    const band = airfieldLateralBand(DEFAULT_AIRPORT);
    const fuel = band.find((entry) => entry.name === "fuel-farm");
    expect(fuel, "no fuel-farm entry in the band").toBeTruthy();
    expect(fuel!.along, "the fuel farm needs a bounded along span").not.toBeNull();

    const tanks = fuelTankPlacements();
    expect(tanks.length, "no tanks placed — the comparison would be vacuous")
      .toBeGreaterThan(0);
    for (const tank of tanks) {
      expect(
        tank.along >= fuel!.along![0]! && tank.along <= fuel!.along![1]!,
        `a real tank at along ${tank.along} is outside the band's `
        + `${fuel!.along![0]} .. ${fuel!.along![1]}`,
      ).toBe(true);
      expect(
        tank.across >= fuel!.across[0]! && tank.across <= fuel!.across[1]!,
        `a real tank at across ${tank.across} is outside the band's `
        + `${fuel!.across[0]} .. ${fuel!.across[1]}`,
      ).toBe(true);
    }
  });

  it("puts the fence where perimeterFenceStations actually puts it", () => {
    // THE SECOND INSTANCE OF THE SAME MISTAKE, found only because I stopped
    // trusting the first fix and audited every entry. The band read
    // `half + FENCE_LATERAL_OFFSET_METERS`, but `perimeterFenceStations` uses
    // that constant as the half-width DIRECTLY — so the real outermost post is
    // at 168 and the band claimed 184.5.
    //
    // Worse here than for the fuel farm: the fence's `along` is null, so
    // `across` is the ONLY axis that can clear it. The band overstated its
    // clearance of the hangars as 26.5 m when the true figure is 9.5 m.
    const band = airfieldLateralBand(DEFAULT_AIRPORT);
    const fence = band.find((entry) => entry.name === "fence");
    expect(fence, "no fence entry in the band").toBeTruthy();
    expect(fence!.along, "the fence must have a null along — it runs the field")
      .toBeNull();

    const stations = perimeterFenceStations(DEFAULT_AIRPORT);
    expect(stations.length, "no fence stations — the comparison would be vacuous")
      .toBeGreaterThan(0);
    const outermost = Math.max(...stations.map((station) => Math.abs(station.across)));
    expect(
      outermost >= Math.abs(fence!.across[0]!) && outermost <= Math.abs(fence!.across[1]!),
      `the outermost fence post is at |across| ${outermost}, outside the band's `
      + `${fence!.across[0]} .. ${fence!.across[1]}`,
    ).toBe(true);
  });

  it("puts the signage where signLateralOffsetMeters actually puts it", () => {
    const band = airfieldLateralBand(DEFAULT_AIRPORT);
    const signage = band.find((entry) => entry.name === "signage");
    expect(signage, "no signage entry in the band").toBeTruthy();
    const real = signLateralOffsetMeters(DEFAULT_AIRPORT);
    expect(
      real >= signage!.across[0]! && real <= signage!.across[1]!,
      `signage is placed at across ${real}, outside the band's `
      + `${signage!.across[0]} .. ${signage!.across[1]}`,
    ).toBe(true);
  });

  it("covers EVERY band entry, so no entry is unchecked", () => {
    // The generalisation the fuel-farm fix only half-made. I added assertions
    // for the entry that was broken and for the hangars, and stopped — which
    // left the fence unchecked, and the fence was broken the same way. This
    // fails if a new entry appears with no test above naming it, rather than
    // leaving the next omission to be found by luck.
    const CHECKED = ["fuel-farm", "hangar-0", "hangar-1", "hangar-2", "fence", "signage"];
    // Windsock and tower are placed by literals in `AirportSystem` rather than
    // by a placement function, so they have no artifact to execute here. They
    // are named, not silently dropped — the difference between a known gap and
    // an unknown one.
    const SOURCE_ONLY = ["windsock", "tower"];
    const band = airfieldLateralBand(DEFAULT_AIRPORT);
    const unchecked = band
      .map((entry) => entry.name)
      .filter((name) => !CHECKED.includes(name) && !SOURCE_ONLY.includes(name));
    expect(
      unchecked,
      "these band entries are compared to nothing but other band entries, which "
      + "is how the fuel farm sat 184.8 m from the real object with four tests green",
    ).toEqual([]);
  });

  it("puts the hangars where hangarFootprint actually puts them", () => {
    // The hangars were always derived, so this passes today. It is here because
    // the fuel farm was ALSO believed to be derived — the function's docblock
    // says "Nothing here is transcribed" — and it was not. An assertion that
    // only covers the entry known to be broken stops being a guard the moment
    // that one is fixed.
    const band = airfieldLateralBand(DEFAULT_AIRPORT);
    for (let index = 0; index < 3; index += 1) {
      const entry = band.find((candidate) => candidate.name === `hangar-${index}`);
      expect(entry, `no band entry for hangar ${index}`).toBeTruthy();
      const footprint = hangarFootprint(DEFAULT_AIRPORT, index);
      expect(entry!.across[0]!).toBeCloseTo(footprint.across - footprint.widthMeters / 2, 6);
      expect(entry!.across[1]!).toBeCloseTo(footprint.across + footprint.widthMeters / 2, 6);
      expect(entry!.along![0]!).toBeCloseTo(footprint.along - footprint.depthMeters / 2, 6);
      expect(entry!.along![1]!).toBeCloseTo(footprint.along + footprint.depthMeters / 2, 6);
    }
  });
});

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
