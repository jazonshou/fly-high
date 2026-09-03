import { describe, expect, it } from "vitest";

import { DEFAULT_AIRPORT } from "../src/world/airport";
import {
  runwayPlatformHalfWidth,
  runwayPlatformHeight,
} from "../src/render/webgpu/terrain/RunwayEarthworks";
import { runwayMarkingProfile } from "../src/render/webgpu/terrain/RunwaySurface";
import {
  AIRFIELD_LIGHTING_PROFILE,
  airfieldApproachFixtures,
  airfieldFixtures,
  airfieldRunwayFixtures,
  airfieldTouchdownZoneFixtures,
  cautionZoneMeters,
  centrelineColourTowardEnd,
  edgeColourTowardEnd,
  touchdownZoneExtentMeters,
  type AirfieldFixture,
} from "../src/render/webgpu/lighting/AirfieldLighting";

/**
 * `7-7`: runway edge, threshold and centreline fixture placement.
 *
 * **What these cover:** where each fixture sits, which rectangle it keys on,
 * where its height comes from, and the direction-dependent colour coding —
 * all of it arithmetic over `AirportDefinition`, so it holds on every seed.
 *
 * **What they do NOT cover:** nothing is drawn. No fixture here has an
 * intensity, a beam, a falloff or a draw call, and none of these assertions
 * would notice if every lamp rendered black. The emission is `7-5`'s and the
 * pins that matter for it — one instanced draw, count under the night shots'
 * ceilings — belong with it. **This pins the placement, not the light.**
 */

const AIRPORT = DEFAULT_AIRPORT;
const FIXTURES = airfieldRunwayFixtures(AIRPORT);
const HALF_LENGTH = AIRPORT.runwayLength * 0.5;
const HALF_WIDTH = AIRPORT.runwayWidth * 0.5;
const of = (kind: AirfieldFixture["kind"]) => FIXTURES.filter((f) => f.kind === kind);

describe("fixtures key on the paved rectangle", () => {
  it("keeps every fixture inside the graded platform, and edges just outside the pavement", () => {
    // Three rectangles are in active use and they differ by 160 m and 508 m of
    // width. Naming the wrong one is silent: the lights simply stand in the
    // grass or in the terrain blend.
    const platformHalfWidth = runwayPlatformHalfWidth(AIRPORT);
    for (const fixture of FIXTURES) {
      expect(Math.abs(fixture.across)).toBeLessThanOrEqual(platformHalfWidth);
      expect(Math.abs(fixture.along)).toBeLessThanOrEqual(HALF_LENGTH);
    }
    for (const edge of of("edge")) {
      expect(Math.abs(edge.across)).toBeCloseTo(
        HALF_WIDTH + AIRFIELD_LIGHTING_PROFILE.edgeLateralMarginMeters,
        9,
      );
      // Outboard of the pavement, not on it.
      expect(Math.abs(edge.across)).toBeGreaterThan(HALF_WIDTH);
    }
  });

  it("takes every off-centreline height from the platform, not the centreline datum", () => {
    // The camber trap. `runwayToWorld` returns `y = airport.elevation`, correct
    // only at across == 0, and a fixture placed there floats above the surface.
    for (const fixture of FIXTURES) {
      const expected =
        runwayPlatformHeight(AIRPORT, fixture.across)
        + (fixture.kind === "centreline"
          ? AIRFIELD_LIGHTING_PROFILE.insetHeightMeters
          : AIRFIELD_LIGHTING_PROFILE.elevatedHeightMeters);
      expect(fixture.y).toBeCloseTo(expected, 9);
    }
    // Non-vacuity: the correction has to actually move something, or this test
    // passes just as well against `airport.elevation`.
    const edges = of("edge");
    const naive = AIRPORT.elevation + AIRFIELD_LIGHTING_PROFILE.elevatedHeightMeters;
    expect(naive - edges[0]!.y).toBeGreaterThan(0.05);
  });

  it("places edge lights symmetrically in pairs", () => {
    const edges = of("edge");
    expect(edges.length % 2).toBe(0);
    const byAlong = new Map<number, number[]>();
    for (const edge of edges) {
      byAlong.set(edge.along, [...(byAlong.get(edge.along) ?? []), edge.across]);
    }
    for (const [along, acrosses] of byAlong) {
      expect(acrosses.length, `along ${along} is not a pair`).toBe(2);
      expect(acrosses[0]! + acrosses[1]!).toBeCloseTo(0, 9);
    }
  });
});

describe("the colour coding is per-direction", () => {
  it("shows green outward and red inward at BOTH ends", () => {
    // A sign error here is the same class as inverting the PAPI bar: it reads
    // as a valid picture and means the opposite thing. Checked at both ends
    // precisely because getting one right by luck is easy.
    const thresholds = of("threshold");
    expect(thresholds.length).toBe(2 * AIRFIELD_LIGHTING_PROFILE.thresholdLightCount);
    for (const fixture of thresholds) {
      const [towardMinus, towardPlus] = fixture.colourTowardEnd;
      if (fixture.along > 0) {
        expect(towardPlus, "arrivals over the +1 end must see green").toBe("green");
        expect(towardMinus, "departures rolling at the +1 end must see red").toBe("red");
      } else {
        expect(towardMinus, "arrivals over the -1 end must see green").toBe("green");
        expect(towardPlus, "departures rolling at the -1 end must see red").toBe("red");
      }
    }
  });

  it("applies 600 m or a third of the runway, whichever is the less", () => {
    // ICAO Annex 14, 3.9.7. Both arms are exercised, because a `min` whose
    // second argument never wins is an expensive way to write a constant — and
    // this one's second argument is exactly what was missing when the rule was
    // first written here as a flat 600 m.
    expect(cautionZoneMeters(AIRPORT)).toBeCloseTo(440, 9); // a third of 1,320 wins
    expect(cautionZoneMeters({ ...AIRPORT, runwayLength: 2_400 })).toBeCloseTo(600, 9); // cap wins
    expect(cautionZoneMeters({ ...AIRPORT, runwayLength: 900 })).toBeCloseTo(300, 9);
    // And the rule must scale, or it is a constant with extra steps.
    expect(cautionZoneMeters({ ...AIRPORT, runwayLength: 900 })).not.toBeCloseTo(
      cautionZoneMeters(AIRPORT),
      9,
    );
  });

  it("leaves one white band between the two amber caution zones", () => {
    // A DERIVED consequence, not a tuned constant: two 440 m caution zones on a
    // 1,320 m runway leave 440 m white in the middle — a third of the runway,
    // which is what the coding is meant to look like. If either the runway
    // length or the rule changes, this states what the change did.
    const white = of("edge").filter(
      (f) => f.colourTowardEnd[0] === "white" && f.colourTowardEnd[1] === "white",
    );
    const alongs = [...new Set(white.map((f) => f.along))].sort((a, b) => a - b);
    const expectedHalfBand = HALF_LENGTH - cautionZoneMeters(AIRPORT);
    // 1,320 m runway: a third (440 m) beats the 600 m cap, so 440 m of white.
    expect(cautionZoneMeters(AIRPORT)).toBeCloseTo(440, 9);
    expect(expectedHalfBand).toBeCloseTo(220, 9);
    for (const along of alongs) expect(Math.abs(along)).toBeLessThan(expectedHalfBand);
  });

  it("makes the caution zone direction-dependent rather than symmetric", () => {
    // Non-vacuity for the whole per-direction design: if some fixture does not
    // differ by direction, the two-colour model is decoration.
    const differing = FIXTURES.filter((f) => f.colourTowardEnd[0] !== f.colourTowardEnd[1]);
    expect(differing.length).toBeGreaterThan(0);
    // And specifically for edges, which are the ones the caution zone codes.
    expect(of("edge").some((f) => f.colourTowardEnd[0] !== f.colourTowardEnd[1])).toBe(true);
  });

  it("codes the centreline by runway remaining, red over the last 300 m", () => {
    for (const end of [-1, 1] as const) {
      for (const fixture of of("centreline")) {
        const remaining = HALF_LENGTH - end * fixture.along;
        const colour = centrelineColourTowardEnd(AIRPORT, fixture.along, end);
        if (remaining <= AIRFIELD_LIGHTING_PROFILE.centrelineAllRedMeters) {
          expect(colour).toBe("red");
        } else if (remaining > AIRFIELD_LIGHTING_PROFILE.centrelineAlternatingMeters) {
          expect(colour).toBe("white");
        } else {
          expect(["red", "white"]).toContain(colour);
        }
      }
    }
  });

  it("actually alternates in the middle band rather than collapsing to one colour", () => {
    // The band is the only place the coding is non-trivial, so it is the only
    // place a wrong implementation still looks plausible.
    const band = of("centreline").filter((f) => {
      const remaining = HALF_LENGTH - f.along;
      return (
        remaining > AIRFIELD_LIGHTING_PROFILE.centrelineAllRedMeters
        && remaining <= AIRFIELD_LIGHTING_PROFILE.centrelineAlternatingMeters
      );
    });
    const colours = band.map((f) => centrelineColourTowardEnd(AIRPORT, f.along, 1));
    expect(new Set(colours).size, "the alternating band is one colour").toBe(2);
    for (let i = 1; i < colours.length; i += 1) {
      expect(colours[i], "neighbours in the band must differ").not.toBe(colours[i - 1]);
    }
  });
});

describe("the helpers agree with the emitted fixtures", () => {
  it("edge colours match edgeColourTowardEnd at every position", () => {
    // The list and the law must not be two implementations; this is the guard
    // that keeps the generator from drifting from the function it documents.
    for (const edge of of("edge")) {
      expect(edge.colourTowardEnd[0]).toBe(edgeColourTowardEnd(AIRPORT, edge.along, -1));
      expect(edge.colourTowardEnd[1]).toBe(edgeColourTowardEnd(AIRPORT, edge.along, 1));
    }
  });

  it("spaces edge and centreline fixtures at the declared pitch", () => {
    for (const [kind, spacing] of [
      ["edge", AIRFIELD_LIGHTING_PROFILE.edgeSpacingMeters],
      ["centreline", AIRFIELD_LIGHTING_PROFILE.centrelineSpacingMeters],
    ] as const) {
      const alongs = [...new Set(of(kind).map((f) => f.along))].sort((a, b) => a - b);
      expect(alongs[0]).toBeCloseTo(-HALF_LENGTH, 9);
      for (let i = 1; i < alongs.length; i += 1) {
        expect(alongs[i]! - alongs[i - 1]!).toBeCloseTo(spacing, 9);
      }
    }
  });
});

describe("touchdown zone and approach lighting", () => {
  const tdz = airfieldTouchdownZoneFixtures(AIRPORT, 1);
  const approach = airfieldApproachFixtures(AIRPORT, 1);

  it("extends 900 m or to the midpoint, whichever is the shorter", () => {
    // Both arms, same reasoning as the caution zone: on this runway the
    // midpoint wins, so a bare 900 would never have been caught here.
    expect(touchdownZoneExtentMeters(AIRPORT)).toBeCloseTo(660, 9); // midpoint wins
    expect(touchdownZoneExtentMeters({ ...AIRPORT, runwayLength: 2_400 })).toBeCloseTo(900, 9);
    expect(touchdownZoneExtentMeters({ ...AIRPORT, runwayLength: 900 })).toBeCloseTo(450, 9);
  });

  it("meets the opposite direction's pattern exactly at the midpoint", () => {
    // The midpoint rule exists to stop the two patterns overlapping. At exactly
    // the midpoint they touch — so the innermost barrette of each direction
    // lands on along == 0, and neither crosses it.
    const other = airfieldTouchdownZoneFixtures(AIRPORT, -1);
    expect(Math.min(...tdz.map((f) => f.along))).toBeCloseTo(0, 9);
    expect(Math.max(...other.map((f) => f.along))).toBeCloseTo(0, 9);
    for (const fixture of tdz) expect(fixture.along).toBeGreaterThanOrEqual(-1e-9);
    for (const fixture of other) expect(fixture.along).toBeLessThanOrEqual(1e-9);
  });

  it.each([
    ["touchdown zone", () => tdz],
    ["approach", () => approach],
  ])("%s fixtures are unidirectional", (_label, get) => {
    // Exactly one face lit. If both were lit these would show to an aircraft
    // using the other end, which is the failure the "off" state exists to
    // represent rather than paper over.
    for (const fixture of get()) {
      const lit = fixture.colourTowardEnd.filter((c) => c !== "off");
      expect(lit.length, "a unidirectional fixture must light exactly one face").toBe(1);
      expect(lit[0]).toBe("white");
    }
  });

  it("lays barrettes on the touchdown marking's lateral spacing, mirrored", () => {
    const profile = AIRFIELD_LIGHTING_PROFILE;
    const inner = runwayMarkingProfile.touchdownHalfWidthMeters;
    const acrosses = [...new Set(tdz.map((f) => f.across))].sort((a, b) => a - b);
    expect(acrosses.length).toBe(2 * profile.barretteLightCount);
    // Innermost light of each barrette sits on the marking's edge, and the rest
    // step outward at the barrette pitch.
    for (let index = 0; index < profile.barretteLightCount; index += 1) {
      const offset = inner + index * profile.barretteSpacingMeters;
      expect(acrosses).toContain(offset);
      expect(acrosses).toContain(-offset);
    }
  });

  it("puts the approach system beyond the threshold, in one level plane", () => {
    // Everything here is outside the graded platform, so a ground-following
    // height would need a seed. The plane is what makes it seed-independent.
    for (const fixture of approach) {
      expect(Math.abs(fixture.along)).toBeGreaterThan(HALF_LENGTH);
    }
    expect(new Set(approach.map((f) => f.y)).size, "the approach plane is not level").toBe(1);
    // Non-vacuity: the crossbar spans 30 m of `across`, so a version that took
    // each fixture's own platform height would NOT be level. The assertion is
    // therefore about the design, not about a degenerate all-zero case.
    expect(new Set(approach.map((f) => f.across)).size).toBeGreaterThan(1);
  });

  it("places the centreline row and one crossbar at the declared distances", () => {
    const profile = AIRFIELD_LIGHTING_PROFILE;
    const centre = approach.filter((f) => f.across === 0);
    const beyond = centre.map((f) => f.along - HALF_LENGTH).sort((a, b) => a - b);
    expect(beyond[0]).toBeCloseTo(profile.approachSpacingMeters, 9);
    expect(beyond[beyond.length - 1]).toBeCloseTo(profile.approachLengthMeters, 9);

    const crossbar = approach.filter(
      (f) => Math.abs(f.along - HALF_LENGTH - profile.approachCrossbarDistanceMeters) < 1e-9,
    );
    // The crossbar row includes the centreline light at that station, so it is
    // the ACROSS span that identifies it.
    const span = Math.max(...crossbar.map((f) => f.across))
      - Math.min(...crossbar.map((f) => f.across));
    expect(span).toBeCloseTo(profile.approachCrossbarLengthMeters, 9);
  });

  it("lights BOTH approaches by default, so neither end ships dark", () => {
    // A recorded decision, not an accident of a default argument. Serving one
    // end is the cheaper-looking option and adds zero draw calls to reverse, so
    // the pin exists to make a silent flip to one end fail rather than ship.
    const byDefault = airfieldFixtures(AIRPORT);
    for (const end of [-1, 1] as const) {
      const index = end === 1 ? 1 : 0;
      for (const kind of ["touchdownZone", "approach"] as const) {
        const lit = byDefault.filter(
          (f) => f.kind === kind && f.colourTowardEnd[index] !== "off",
        );
        expect(lit.length, `${kind} guidance is dark for the ${end} approach`).toBeGreaterThan(0);
      }
    }
    expect(byDefault.length).toBe(airfieldFixtures(AIRPORT, [-1, 1]).length);
  });

  it("serves the ends the caller asks for, and no more", () => {
    // The served-end choice is a real cost, so it must be a parameter that
    // actually changes the output rather than a decorative argument.
    const one = airfieldFixtures(AIRPORT, [1]);
    const both = airfieldFixtures(AIRPORT, [-1, 1]);
    const directional = (list: readonly AirfieldFixture[]) =>
      list.filter((f) => f.kind === "touchdownZone" || f.kind === "approach");
    expect(directional(one).length).toBeGreaterThan(0);
    expect(directional(both).length).toBe(2 * directional(one).length);
    // And the omnidirectional runway set is unaffected by the choice.
    expect(both.length - directional(both).length).toBe(one.length - directional(one).length);
  });
});
