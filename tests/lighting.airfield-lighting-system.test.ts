import { describe, expect, it } from "vitest";
import { DEFAULT_AIRPORT } from "../src/world/airport";
import {
  AIRFIELD_LAMP_BEAM_COSINE,
  AIRFIELD_LAMP_PHOTOMETRY,
  AIRFIELD_LAMP_RGB,
  AIRFIELD_LAMP_SCENE_SCALE,
  AirfieldLightingSystem,
  airfieldFixtures,
  airfieldLightPoints,
  papiLamps,
  papiOnSlopeAltitudeMeters,
  papiUnitPlacements,
  PAPI_ANGLE_PROFILE,
} from "../src/render/webgpu/lighting/AirfieldLighting";
import { lightPointBeamGain } from "../src/render/webgpu/lighting/LightPoints";

/**
 * `7-5` + `7-7` joined: the airfield actually emits light.
 *
 * WHAT THIS FILE IS FOR, stated plainly because the sibling file says the
 * opposite about itself. `lighting.airfield-fixtures.test.ts` closes with
 * "nothing is drawn ... none of these assertions would notice if every lamp
 * rendered black. This pins the placement, not the light." That was accurate
 * and it was the whole problem: 279 fixtures were placed, pinned, and green,
 * and `FlightRenderer` constructed `new LightPointSystem(scene, [], 1)`, so
 * not one lamp rendered. Two gates of night-lighting work were invisible.
 *
 * So every assertion here is chosen to FAIL for a specific way the airfield
 * could be dark while the rest of the suite stayed green:
 *   - the fixture list reaching the renderer empty,
 *   - intensity resolving to zero,
 *   - a lamp's colour resolving to black,
 *   - the beam gate hiding every direction instead of one,
 *   - the PAPI never leaving its initial state.
 * `PHASE_6_OUTCOME.md` §1's instruction applies: read "landed" as "the code
 * exists and is correct", never as "you can see it".
 */

const FIXTURES = airfieldFixtures(DEFAULT_AIRPORT);
const POINTS = airfieldLightPoints(DEFAULT_AIRPORT);

/** Unit vector along increasing runway `along`, in world space. */
const AXIS: readonly [number, number, number] = [
  Math.sin(DEFAULT_AIRPORT.headingRadians),
  0,
  Math.cos(DEFAULT_AIRPORT.headingRadians),
];

describe("the airfield emits light at all", () => {
  it("produces one light point per LIT direction, and none for an off one", () => {
    // Derived from the fixture data rather than hardcoded, so it tracks a
    // placement change instead of pinning today's count.
    let lit = 0;
    let off = 0;
    for (const fixture of FIXTURES) {
      for (const colour of fixture.colourTowardEnd) {
        if (colour === "off") off += 1;
        else lit += 1;
      }
    }
    expect(POINTS).toHaveLength(lit);
    // Non-vacuity in both directions: there must BE lit directions, and there
    // must be off ones, or the split this design exists for is untested.
    expect(lit, "no lit directions at all").toBeGreaterThan(0);
    expect(off, "no 'off' directions — the unidirectional path is untested")
      .toBeGreaterThan(0);
  });

  it("gives every light point a non-zero intensity", () => {
    // FAILS IF: the candela-to-scene scale, or any per-kind intensity, is zero.
    // That is a whole airfield rendering black with every placement assertion
    // still green.
    expect(POINTS.length).toBeGreaterThan(0);
    for (const point of POINTS) {
      expect(point.intensity, "a light point has no intensity").toBeGreaterThan(0);
      expect(Number.isFinite(point.intensity)).toBe(true);
    }
    expect(AIRFIELD_LAMP_SCENE_SCALE).toBeGreaterThan(0);
  });

  it("gives every light point a non-black colour", () => {
    // FAILS IF: a colour maps to [0,0,0] — additive blending makes a black
    // lamp indistinguishable from an absent one, which is precisely the
    // observation this whole file exists to separate.
    for (const point of POINTS) {
      const sum = point.color[0] + point.color[1] + point.color[2];
      expect(sum, `black lamp at ${point.position.join(",")}`).toBeGreaterThan(0.1);
    }
    for (const [name, rgb] of Object.entries(AIRFIELD_LAMP_RGB)) {
      expect(rgb[0] + rgb[1] + rgb[2], `${name} is black`).toBeGreaterThan(0.1);
    }
  });

  it("keeps every kind's photometry positive", () => {
    for (const [kind, photometry] of Object.entries(AIRFIELD_LAMP_PHOTOMETRY)) {
      expect(photometry.intensityCandela, `${kind} has no intensity`).toBeGreaterThan(0);
      expect(photometry.radiusMeters, `${kind} has no radius`).toBeGreaterThan(0);
    }
  });
});

describe("the beam shows one colour per side, not both", () => {
  it("lights a fixture toward the end it serves and hides it from behind", () => {
    // THE CORRECTNESS PROPERTY THE SPLIT EXISTS FOR. A threshold lamp is green
    // to an aircraft arriving over it and red to one rolling at it. Without a
    // working beam both light points are visible from both sides and the lamp
    // shows green AND red at once — visible nonsense rather than merely wrong.
    const threshold = POINTS.filter((point) =>
      point.color === AIRFIELD_LAMP_RGB.green || point.color === AIRFIELD_LAMP_RGB.red);
    expect(threshold.length, "no coloured threshold lamps to test").toBeGreaterThan(0);

    for (const point of threshold.slice(0, 40)) {
      // A viewer far beyond the +1 end, looking back: `toViewer` points +axis.
      const towardPlus = point.aim[0] * AXIS[0] + point.aim[2] * AXIS[2];
      const gainPlus = lightPointBeamGain(point.beamCosineCutoff ?? -1, towardPlus);
      const gainMinus = lightPointBeamGain(point.beamCosineCutoff ?? -1, -towardPlus);
      // Exactly one side is lit. Not "mostly" — the two must differ.
      expect(Math.max(gainPlus, gainMinus)).toBeGreaterThan(0.9);
      expect(Math.min(gainPlus, gainMinus)).toBe(0);
    }
  });

  it("leaves an omnidirectional fixture undimmed", () => {
    // FAILS IF: the default flips from -1 to 0. Zero is a HEMISPHERE here, so
    // that default would silently darken the back half of every fixture that
    // never asked for a beam — including the star-field-shaped fixtures the
    // GPU test builds.
    for (const cosine of [-1, -0.5, 0, 0.5, 1]) {
      expect(lightPointBeamGain(-1, cosine)).toBe(1);
    }
  });

  it("is monotonic and bounded across the cutoff", () => {
    let previous = lightPointBeamGain(AIRFIELD_LAMP_BEAM_COSINE, -1);
    for (let axis = -1; axis <= 1; axis += 0.001) {
      const gain = lightPointBeamGain(AIRFIELD_LAMP_BEAM_COSINE, axis);
      expect(gain).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
      previous = gain;
    }
  });
});

describe("the PAPI is analytic and actually changes", () => {
  const SERVED = 1 as const;
  const UNITS = papiUnitPlacements(DEFAULT_AIRPORT, SERVED);

  /** A world point on the reference glidepath, `range` metres before the threshold. */
  function onSlope(range: number): readonly [number, number, number] {
    const altitude = papiOnSlopeAltitudeMeters(DEFAULT_AIRPORT, range);
    // Along the approach, beyond the served threshold.
    const along = SERVED * (DEFAULT_AIRPORT.runwayLength * 0.5 + range);
    return [
      DEFAULT_AIRPORT.centerX + along * Math.sin(DEFAULT_AIRPORT.headingRadians),
      altitude,
      DEFAULT_AIRPORT.centerZ + along * Math.cos(DEFAULT_AIRPORT.headingRadians),
    ];
  }

  it("reads two white and two red on the glidepath", () => {
    // The standard on-slope indication. FAILS IF: the elevation datum, the
    // served end, or the unit ordering is wrong — each of which produces a
    // PAPI that looks plausible and lies to the pilot.
    const system = new AirfieldLightingSystem(DEFAULT_AIRPORT);
    const [x, y, z] = onSlope(1_500);
    system.update(x, y, z);
    const served = system.indication().slice(
      papiLamps(DEFAULT_AIRPORT).findIndex((lamp) => lamp.servedEnd === SERVED),
      papiLamps(DEFAULT_AIRPORT).findIndex((lamp) => lamp.servedEnd === SERVED)
        + PAPI_ANGLE_PROFILE.unitCount,
    );
    expect(served.filter((i) => i === "white")).toHaveLength(2);
    expect(served.filter((i) => i === "red")).toHaveLength(2);
  });

  it("goes all white high and all red low", () => {
    // Non-vacuity for the indication: if `update` never changed anything, the
    // on-slope test above would still pass from the initial all-red state.
    const system = new AirfieldLightingSystem(DEFAULT_AIRPORT);
    const [x, , z] = onSlope(1_500);
    const high = papiOnSlopeAltitudeMeters(DEFAULT_AIRPORT, 1_500) + 400;
    system.update(x, high, z);
    const start = papiLamps(DEFAULT_AIRPORT).findIndex((lamp) => lamp.servedEnd === SERVED);
    expect(
      system.indication().slice(start, start + PAPI_ANGLE_PROFILE.unitCount)
        .every((i) => i === "white"),
      "not all white well above the slope",
    ).toBe(true);

    const low = UNITS[0]!.y - 50;
    system.update(x, low, z);
    expect(
      system.indication().slice(start, start + PAPI_ANGLE_PROFILE.unitCount)
        .every((i) => i === "red"),
      "not all red well below the slope",
    ).toBe(true);
  });

  it("reports a change only when an indication actually flips", () => {
    // The update is a step function of elevation, so a per-frame re-upload of
    // the whole colour buffer would be waste. This is what makes the
    // change-driven path correct rather than merely cheap.
    const system = new AirfieldLightingSystem(DEFAULT_AIRPORT);
    const [x, y, z] = onSlope(1_500);
    expect(system.update(x, y, z), "first resolve reported no change").toBe(true);
    expect(system.update(x, y, z), "an unchanged camera re-uploaded colours").toBe(false);
    const high = papiOnSlopeAltitudeMeters(DEFAULT_AIRPORT, 1_500) + 400;
    expect(system.update(x, high, z), "climbing through the slope changed nothing").toBe(true);
  });

  it("resolves finer than the IES path could", () => {
    // WHY THE PAPI IS NOT DRAWN THROUGH THE BEAM GATE. The IES texture is 180
    // samples over 180 degrees — 1.0 deg/sample — against the 0.1 deg the law
    // is pinned to. Two observers 0.05 deg apart across a unit's setting angle
    // must read differently, which no 1.0 deg/sample lookup can express.
    const system = new AirfieldLightingSystem(DEFAULT_AIRPORT);
    const unit = UNITS[0]!;
    const horizontal = 1_500;
    const start = papiLamps(DEFAULT_AIRPORT).findIndex((lamp) => lamp.servedEnd === SERVED);
    const at = (offsetDegrees: number) => {
      const angle = (unit.settingDegrees + offsetDegrees) * (Math.PI / 180);
      const y = unit.y + Math.tan(angle) * horizontal;
      const bearing = DEFAULT_AIRPORT.headingRadians;
      system.update(
        unit.x + horizontal * Math.sin(bearing),
        y,
        unit.z + horizontal * Math.cos(bearing),
      );
      return system.indication()[start]!;
    };
    expect(at(0.05)).toBe("white");
    expect(at(-0.05)).toBe("red");
  });
});

describe("the colour list matches the fixture list", () => {
  it("has exactly one colour per light point", () => {
    // FAILS IF: the PAPI lamps are appended without extending the colour list.
    // `LightPointSystem.setColors` throws on a mismatch, so this catches it in
    // Node rather than at the first PAPI transition in flight.
    const system = new AirfieldLightingSystem(DEFAULT_AIRPORT);
    expect(system.colourList()).toHaveLength(system.fixtures.length);
    expect(system.fixtures.length).toBe(POINTS.length + papiLamps(DEFAULT_AIRPORT).length);
  });
});
