import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_AIRPORT } from "../src/world/airport";
import {
  FENCE_LATERAL_OFFSET_METERS,
  FENCE_POST_SPACING_METERS,
  buildPerimeterFenceGeometry,
  fenceApproachGapHalfWidthMeters,
  perimeterFenceStations,
} from "../src/render/webgpu/detail/AirfieldFurniture";
import {
  AIRFIELD_LIGHTING_PROFILE,
  airfieldFixtures,
} from "../src/render/webgpu/lighting/AirfieldLighting";

/**
 * `7-13` perimeter fence — the properties the sizing decided, pinned so the
 * design cannot be undone without the numbers being re-derived.
 */

describe("the fence is one mesh because it cannot be many", () => {
  it("has enough stations that per-part meshes would be impossible", () => {
    // NOT a performance nicety. 2,422 draw calls against a night ceiling of
    // 157 is impossible by a factor of fifteen, so the merge is forced. This
    // pins the ARITHMETIC that forced it, not the choice — if a future runway
    // is short enough that per-part meshes fit, the reasoning should be
    // re-derived rather than inherited.
    const stations = perimeterFenceStations(DEFAULT_AIRPORT);
    const naiveDrawCalls = stations.length * 2;
    expect(stations.length).toBeGreaterThan(1_000);
    expect(naiveDrawCalls).toBeGreaterThan(157 * 5);
  });

  it("merges every station into a single geometry", () => {
    const geometry = buildPerimeterFenceGeometry(DEFAULT_AIRPORT);
    const stations = perimeterFenceStations(DEFAULT_AIRPORT);
    // 18 verts per post, 14 per rail, two rails per bay.
    expect(geometry.positions.length / 3).toBe(stations.length * (18 + 14 * 2));
    expect(geometry.indices.length).toBeGreaterThan(0);
  });

  it("spaces posts at the ICAO interval, within a bay's rounding", () => {
    const stations = perimeterFenceStations(DEFAULT_AIRPORT);
    let worst = 0;
    for (let index = 0; index + 1 < stations.length; index += 1) {
      const a = stations[index]!;
      const b = stations[index + 1]!;
      const gap = Math.hypot(b.along - a.along, b.across - a.across);
      // Corners jump across the rectangle; only measure within a side.
      if (gap > FENCE_POST_SPACING_METERS * 3) continue;
      worst = Math.max(worst, Math.abs(gap - FENCE_POST_SPACING_METERS));
    }
    expect(worst).toBeLessThan(0.2);
  });

  it("encloses the runway rather than crossing it", () => {
    // The failure this catches is a fence across the tarmac, which a pinned
    // half-width instead of a derived one would produce the first time a seed
    // made a longer strip.
    const stations = perimeterFenceStations(DEFAULT_AIRPORT);
    const halfLength = DEFAULT_AIRPORT.runwayLength / 2 + DEFAULT_AIRPORT.endSafetyArea;
    for (const station of stations) {
      const insideAlong = Math.abs(station.along) < halfLength - 1;
      const clearAcross = Math.abs(station.across) >= FENCE_LATERAL_OFFSET_METERS - 1e-6;
      expect(
        !insideAlong || clearAcross,
        `a post at along ${station.along.toFixed(0)}, across ${station.across.toFixed(0)} `
        + "is inside the runway's length and not clear of it",
      ).toBe(true);
    }
  });

  it("follows the ground it is given, not a flat datum", () => {
    // At 168 m across the perimeter is off the graded platform, so a flat
    // fence floats over falling ground. Asserted against a sloping query.
    const sloped = buildPerimeterFenceGeometry(DEFAULT_AIRPORT, (along) => along * 0.01);
    const flat = buildPerimeterFenceGeometry(DEFAULT_AIRPORT);
    let moved = 0;
    for (let index = 1; index < sloped.positions.length; index += 3) {
      if (Math.abs(sloped.positions[index]! - flat.positions[index]!) > 1e-6) moved += 1;
    }
    expect(moved, "the height callback changed nothing — the fence ignores terrain")
      .toBeGreaterThan(sloped.positions.length / 3 / 2);
  });
});

describe("the fence does not cast shadows, deliberately", () => {
  it("is absent from the shadow-caster set", () => {
    // A CALL-SITE guard, because this is a decision that only exists at the
    // registration site: casting would cost 1 beauty + 2 cascades = 3 draws
    // per shot instead of 1, to render the shadow of a 1.2 m post 168 m off
    // the centreline. Someone will ask why; the answer is here and at the site.
    const source = readFileSync("src/render/webgpu/detail/AirportSystem.ts", "utf8");
    const casters = /this\.shadowCasters = Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
    expect(casters, "could not find the shadow-caster registration").not.toBeNull();
    expect(
      casters![1]!.includes("fence"),
      "the fence has been added to shadowCasters. That is 2 extra draws on "
      + "EVERY shot, including ones where the airfield is not in frame, for a "
      + "shadow nobody can resolve. If it is deliberate, re-derive the cost.",
    ).toBe(false);
    // Non-vacuity: the set must contain something, or this passes on an empty one.
    //
    // Asserted on the CONTRIBUTORS, not on one variable's spelling. This arm
    // read `toContain("hangars")` and broke when `7-10` renamed that local to
    // `hangarCasters` — a correct catch (the list did change shape) reported as
    // a fence regression, which is the wrong place to look. What the arm needs
    // to know is that the list is populated and that the hangars are in it;
    // neither fact depends on the identifier.
    expect(
      casters![1]!,
      "the hangars are not in the shadow-caster set, so a fence absent from an "
      + "empty set proves nothing",
    ).toMatch(/hangar/i);
    expect(
      casters![1]!.match(/\.\.\./g)?.length ?? 0,
      "the caster set has almost nothing in it — this test would pass on a "
      + "registration that had been gutted",
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("the fence does not stand a post in the approach corridor", () => {
  it("leaves a gap where its end run crosses the extended centreline", () => {
    // THE DEFECT THIS FIXES was emergent rather than authored: the fence's end
    // runs derive from `runwayLength / 2 + endSafetyArea` (740 m here) and the
    // approach array derives from its own length, and the two correct
    // derivations intersect at `across = 0`. Nobody chose a post on the
    // approach centreline; it fell out.
    //
    // It lands on short final, which is the most-viewed camera in the
    // simulator, and a rigid obstacle on the approach surface is the one
    // arrangement that is neither realistic nor deliberate.
    const gap = fenceApproachGapHalfWidthMeters();
    const stations = perimeterFenceStations(DEFAULT_AIRPORT);
    const halfLength = DEFAULT_AIRPORT.runwayLength / 2 + DEFAULT_AIRPORT.endSafetyArea;
    const inCorridor = stations.filter(
      (s) => Math.abs(Math.abs(s.along) - halfLength) < 1 && Math.abs(s.across) < gap,
    );
    expect(
      inCorridor,
      "a fence post stands inside the approach corridor at across "
      + inCorridor.map((s) => s.across.toFixed(1)).join(", "),
    ).toEqual([]);
  });

  it("gaps ONLY the corridor — the rest of the end run is still fenced", () => {
    // Non-vacuity, and the thing that separates a gap from a shorter fence:
    // the end runs must still exist outside the corridor. An implementation
    // that dropped the end runs entirely would pass the assertion above.
    const gap = fenceApproachGapHalfWidthMeters();
    const halfLength = DEFAULT_AIRPORT.runwayLength / 2 + DEFAULT_AIRPORT.endSafetyArea;
    const onEndRuns = perimeterFenceStations(DEFAULT_AIRPORT).filter(
      (s) => Math.abs(Math.abs(s.along) - halfLength) < 1,
    );
    expect(onEndRuns.length, "the end runs have vanished, not been gapped")
      .toBeGreaterThan(20);
    expect(onEndRuns.some((s) => Math.abs(s.across) > gap * 2)).toBe(true);
  });

  it("derives the gap from the approach lighting, not from a pinned width", () => {
    // The collision was two constants that never met. A pinned gap would drift
    // from the corridor the same way, so this pins the RELATIONSHIP: the gap
    // must widen if the crossbar does.
    expect(fenceApproachGapHalfWidthMeters())
      .toBeGreaterThan(AIRFIELD_LIGHTING_PROFILE.approachCrossbarLengthMeters / 2);
  });

  it("clears every approach fixture that sits near the fence line", () => {
    // The end-to-end check, against the real fixtures rather than the model:
    // no approach light may be within a post's reach of a fence station.
    const halfLength = DEFAULT_AIRPORT.runwayLength / 2 + DEFAULT_AIRPORT.endSafetyArea;
    const approach = airfieldFixtures(DEFAULT_AIRPORT).filter((f) => f.kind === "approach");
    expect(approach.length, "no approach fixtures to check against").toBeGreaterThan(0);
    const stations = perimeterFenceStations(DEFAULT_AIRPORT).filter(
      (s) => Math.abs(Math.abs(s.along) - halfLength) < 1,
    );
    for (const fixture of approach) {
      for (const station of stations) {
        const distance = Math.hypot(fixture.along - station.along, fixture.across - station.across);
        expect(
          distance,
          `approach fixture at along ${fixture.along.toFixed(0)}, across `
          + `${fixture.across.toFixed(1)} is ${distance.toFixed(1)} m from a fence post`,
        ).toBeGreaterThan(3);
      }
    }
  });
});
