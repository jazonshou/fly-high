import { describe, expect, it } from "vitest";
import {
  BRIGHT_STARS,
  brightStarPosition,
  brightStars,
  colorForColorIndex,
  equatorialToWorld,
  equatorialToWorldRows,
  equatorialUnitVector,
  extinguishedMagnitude,
  generateBackgroundStars,
  localSiderealTimeHours,
  relativeAirMass,
  starIlluminanceLux,
  starsBrighterThan,
  GALACTIC_CENTER_EQUATORIAL,
  GALACTIC_POLE_EQUATORIAL,
  STAR_FIELD_AUTHORED_MAGNITUDE_LIMIT,
  STAR_FIELD_FAINTEST_MAGNITUDE,
} from "../src/render/webgpu/atmosphere/StarCatalogue";
import {
  daysSinceJ2000,
  julianDayForClock,
  moonApparentMagnitude,
  moonIlluminanceLux,
  moonState,
  solarApparentPosition,
  EPHEMERIS_REFERENCE_JULIAN_DAY,
  FULL_MOON_ILLUMINANCE_LUX,
  MOONLIGHT_TINT,
  SYNODIC_MONTH_DAYS,
} from "../src/render/webgpu/atmosphere/Ephemeris";
import {
  buildStarFieldGeometry,
  starVisibilityForSunElevation,
} from "../src/render/webgpu/atmosphere/StarField";
import {
  rodFractionForAdaptedLuminance,
  shouldRunScotopicPass,
  PHOTOPIC_THRESHOLD_CD_M2,
  SCOTOPIC_THRESHOLD_CD_M2,
  SCOTOPIC_TINT,
  SCOTOPIC_WEIGHTS,
} from "../src/render/webgpu/atmosphere/ScotopicVision";
import {
  adaptLuminance,
  adaptedLuminanceCdM2,
  horizontalIlluminanceLux,
  resolveEnvironmentState,
  solarPosition,
  MOONLESS_NIGHT_ILLUMINANCE_LUX,
  SCENE_UNIT_TO_NITS,
} from "../src/render/webgpu/nature/EnvironmentDirector";
import { createEnvironmentClock } from "../src/world/environmentClock";

/**
 * Gate 7A — night sky and human night vision.
 *
 * The catalogue is hand-authored (see `StarCatalogue`'s deviation note), so
 * the first block is transcription insurance: known angular separations,
 * known alignments and known magnitude order. A typo in a declination sign
 * or an hour of right ascension moves a star by tens of degrees and fails
 * one of these, which is the whole point of choosing checks that a wrong
 * number cannot pass.
 */

const DEGREES = Math.PI / 180;

function angleBetweenDegrees(name: string, other: string): number {
  const a = brightStarPosition(name);
  const b = brightStarPosition(other);
  const va = equatorialUnitVector(a.rightAscensionHours, a.declinationDegrees);
  const vb = equatorialUnitVector(b.rightAscensionHours, b.declinationDegrees);
  const dot = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
  return Math.acos(Math.min(1, Math.max(-1, dot))) / DEGREES;
}

describe("the bright-star catalogue (7-3)", () => {
  it("holds every row inside its own coordinate ranges", () => {
    expect(BRIGHT_STARS.length).toBeGreaterThan(150);
    const seen = new Set<string>();
    for (const [name, raHours, raMinutes, sign, decDegrees, decMinutes, magnitude, bv]
      of BRIGHT_STARS) {
      expect(seen.has(name), `duplicate ${name}`).toBe(false);
      seen.add(name);
      expect(raHours, name).toBeGreaterThanOrEqual(0);
      expect(raHours, name).toBeLessThan(24);
      expect(raMinutes, name).toBeGreaterThanOrEqual(0);
      expect(raMinutes, name).toBeLessThan(60);
      expect(Math.abs(sign), name).toBe(1);
      expect(decDegrees, name).toBeGreaterThanOrEqual(0);
      expect(decDegrees, name).toBeLessThanOrEqual(90);
      expect(decMinutes, name).toBeGreaterThanOrEqual(0);
      expect(decMinutes, name).toBeLessThan(60);
      expect(magnitude, name).toBeGreaterThan(-2);
      expect(magnitude, name).toBeLessThan(4.5);
      expect(bv, name).toBeGreaterThan(-0.5);
      expect(bv, name).toBeLessThan(2.1);
    }
  });

  it("puts no two authored stars on top of each other", () => {
    const stars = brightStars();
    for (let index = 0; index < stars.length; index += 1) {
      for (let other = index + 1; other < stars.length; other += 1) {
        const a = stars[index]!.equatorial;
        const b = stars[other]!.equatorial;
        const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(dot, `${BRIGHT_STARS[index]![0]} / ${BRIGHT_STARS[other]![0]}`)
          .toBeLessThan(0.9999985);
      }
    }
  });

  it("draws Orion's belt as three collinear stars 2.7° long", () => {
    // The single best transcription check in the sky: three stars within
    // 0.6° of a great circle, evenly spaced, spanning 2.7°.
    expect(angleBetweenDegrees("Mintaka", "Alnilam")).toBeCloseTo(1.36, 1);
    expect(angleBetweenDegrees("Alnilam", "Alnitak")).toBeCloseTo(1.34, 1);
    expect(angleBetweenDegrees("Mintaka", "Alnitak")).toBeCloseTo(2.70, 1);
    // ...and Orion's shoulders and feet at their known separations.
    expect(angleBetweenDegrees("Betelgeuse", "Rigel")).toBeCloseTo(18.6, 0);
    expect(angleBetweenDegrees("Betelgeuse", "Bellatrix")).toBeCloseTo(7.5, 0);
  });

  it("keeps the Dipper's pointers pointing at Polaris", () => {
    // Dubhe→Merak extended ~5× lands on the pole star. This catches a
    // declination error anywhere in the Dipper AND in Polaris itself.
    const dubhe = brightStarPosition("Dubhe");
    const merak = brightStarPosition("Merak");
    const polaris = brightStarPosition("Polaris");
    const vDubhe = equatorialUnitVector(dubhe.rightAscensionHours, dubhe.declinationDegrees);
    const vMerak = equatorialUnitVector(merak.rightAscensionHours, merak.declinationDegrees);
    const vPolaris = equatorialUnitVector(
      polaris.rightAscensionHours,
      polaris.declinationDegrees,
    );
    const pointer: [number, number, number] = [
      vDubhe[0] + (vDubhe[0] - vMerak[0]) * 4.9,
      vDubhe[1] + (vDubhe[1] - vMerak[1]) * 4.9,
      vDubhe[2] + (vDubhe[2] - vMerak[2]) * 4.9,
    ];
    const length = Math.hypot(...pointer);
    const dot =
      (pointer[0] * vPolaris[0] + pointer[1] * vPolaris[1] + pointer[2] * vPolaris[2]) / length;
    const missDegrees = Math.acos(Math.min(1, Math.max(-1, dot))) / DEGREES;
    expect(missDegrees).toBeLessThan(8);
    expect(angleBetweenDegrees("Dubhe", "Merak")).toBeCloseTo(5.4, 0);
    expect(angleBetweenDegrees("Mizar", "Alkaid")).toBeCloseTo(6.7, 0);
  });

  it("closes the Summer Triangle at its known side lengths", () => {
    expect(angleBetweenDegrees("Vega", "Deneb")).toBeCloseTo(23.8, 0);
    expect(angleBetweenDegrees("Vega", "Altair")).toBeCloseTo(34.2, 0);
    expect(angleBetweenDegrees("Deneb", "Altair")).toBeCloseTo(38.0, 0);
  });

  it("closes the Southern Cross at its known side lengths", () => {
    expect(angleBetweenDegrees("Acrux", "Gacrux")).toBeCloseTo(6.0, 0);
    expect(angleBetweenDegrees("Mimosa", "Delta Crucis")).toBeCloseTo(4.2, 0);
    expect(angleBetweenDegrees("Rigil Kentaurus", "Hadar")).toBeCloseTo(4.4, 0);
  });

  it("orders the ten brightest stars correctly", () => {
    const sorted = [...BRIGHT_STARS].sort((a, b) => a[6] - b[6]).slice(0, 10).map((r) => r[0]);
    expect(sorted).toEqual([
      "Sirius", "Canopus", "Rigil Kentaurus", "Arcturus", "Vega",
      "Capella", "Rigel", "Procyon", "Achernar", "Betelgeuse",
    ]);
  });

  it("gives each spectral class a plausible colour, monotone in B−V", () => {
    const hot = colorForColorIndex(-0.24);
    const sun = colorForColorIndex(0.65);
    const cool = colorForColorIndex(1.85);
    // Normalised to luminance 1, so only the ratio moves.
    for (const color of [hot, sun, cool]) {
      const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
      expect(luminance).toBeCloseTo(1, 3);
    }
    expect(hot[2] / hot[0]).toBeGreaterThan(sun[2] / sun[0]);
    expect(sun[2] / sun[0]).toBeGreaterThan(cool[2] / cool[0]);
    expect(cool[0]).toBeGreaterThan(cool[2]);
  });
});

describe("the generated background (7-3)", () => {
  const generated = generateBackgroundStars(1);

  it("reproduces the observed magnitude-count law where it is used", () => {
    // The observed naked-eye anchors over the range the GENERATOR fills —
    // the authored table owns everything brighter than 3.6, so the fit is
    // held to 2% from V = 3 down and deliberately not beyond.
    for (const [magnitude, observed] of
      [[3, 171], [4, 513], [5, 1_602], [6, 4_800]] as const) {
      const modelled = starsBrighterThan(magnitude);
      expect(Math.abs(modelled - observed) / observed, `V<=${magnitude}`).toBeLessThan(0.03);
    }
    // ...and the authored table really does cover the bright end it claims.
    const authored = BRIGHT_STARS.filter(
      (row) => row[6] <= STAR_FIELD_AUTHORED_MAGNITUDE_LIMIT,
    ).length;
    expect(authored).toBeGreaterThan(starsBrighterThan(3.0) * 0.9);
  });

  it("fills only below the authored limit, at the right population size", () => {
    const target = starsBrighterThan(STAR_FIELD_FAINTEST_MAGNITUDE)
      - starsBrighterThan(STAR_FIELD_AUTHORED_MAGNITUDE_LIMIT);
    expect(generated.length).toBeGreaterThan(target * 0.9);
    expect(generated.length).toBeLessThanOrEqual(Math.round(target));
    for (const star of generated) {
      expect(star.magnitude).toBeGreaterThanOrEqual(STAR_FIELD_AUTHORED_MAGNITUDE_LIMIT - 1e-6);
      expect(star.magnitude).toBeLessThanOrEqual(STAR_FIELD_FAINTEST_MAGNITUDE + 1e-6);
      expect(Math.hypot(...star.equatorial)).toBeCloseTo(1, 6);
    }
  });

  it("concentrates toward the galactic plane", () => {
    let plane = 0;
    let pole = 0;
    for (const star of generated) {
      const sine = Math.abs(
        star.equatorial[0] * GALACTIC_POLE_EQUATORIAL[0]
        + star.equatorial[1] * GALACTIC_POLE_EQUATORIAL[1]
        + star.equatorial[2] * GALACTIC_POLE_EQUATORIAL[2],
      );
      // Equal solid angle: |sin b| < 0.2 against |sin b| > 0.8.
      if (sine < 0.2) plane += 1;
      if (sine > 0.8) pole += 1;
    }
    expect(plane / Math.max(pole, 1)).toBeGreaterThan(1.6);
  });

  it("is deterministic for a seed and different across seeds", () => {
    const again = generateBackgroundStars(1);
    expect(again.length).toBe(generated.length);
    expect(again[17]!.equatorial).toEqual(generated[17]!.equatorial);
    const other = generateBackgroundStars(2);
    expect(other[17]!.equatorial).not.toEqual(generated[17]!.equatorial);
  });

  it("puts the galactic centre in Sagittarius and the pole in Coma", () => {
    // Sanity on the two frame constants: the centre is at δ ≈ −29° and the
    // pole at δ ≈ +27°, and they are perpendicular.
    expect(GALACTIC_POLE_EQUATORIAL[2]).toBeCloseTo(Math.sin(27.128 * DEGREES), 4);
    expect(GALACTIC_CENTER_EQUATORIAL[2]).toBeCloseTo(Math.sin(-28.936 * DEGREES), 4);
    const dot =
      GALACTIC_POLE_EQUATORIAL[0] * GALACTIC_CENTER_EQUATORIAL[0]
      + GALACTIC_POLE_EQUATORIAL[1] * GALACTIC_CENTER_EQUATORIAL[1]
      + GALACTIC_POLE_EQUATORIAL[2] * GALACTIC_CENTER_EQUATORIAL[2];
    expect(Math.abs(dot)).toBeLessThan(0.01);
  });
});

describe("the sky's frame (7-3)", () => {
  it("agrees with the director's own sun to the ephemeris's precision", () => {
    // Two solar models exist by necessity — EnvironmentDirector owns the
    // rendered DIRECTION (NOAA elevation/azimuth), Ephemeris owns the
    // EQUATORIAL position the sidereal frame needs. They must not drift.
    for (const day of [0, 80, 171, 264, 355]) {
      for (const hour of [3, 9, 12.5, 18, 22]) {
        const clock = createEnvironmentClock(day, hour);
        const noaa = solarPosition(clock, 45);
        const ephemeris = solarApparentPosition(clock);
        const noaaDeclination = (noaa.declinationRadians / DEGREES);
        expect(
          Math.abs(noaaDeclination - ephemeris.declinationDegrees),
          `day ${day} hour ${hour}`,
        ).toBeLessThan(0.6);
      }
    }
  });

  it("carries a star through the sky at the sidereal rate", () => {
    // A star's altitude must repeat one SIDEREAL day later, which is 3m56s
    // short of a solar day — the single fact that makes constellations
    // arrive earlier each night.
    const latitude = 45;
    const vega = brightStarPosition("Vega");
    const direction = equatorialUnitVector(
      vega.rightAscensionHours,
      vega.declinationDegrees,
    );
    const altitude = (day: number, hour: number): number => {
      const clock = createEnvironmentClock(day, hour);
      const rows = equatorialToWorldRows(localSiderealTimeHours(clock), latitude);
      return equatorialToWorld(direction, rows)[1];
    };
    const base = altitude(171, 22);
    // One solar day later at the same clock time: ~1° of extra rotation.
    expect(Math.abs(altitude(172, 22) - base)).toBeLessThan(0.03);
    // Six hours later it has swung a quarter turn — a big change.
    expect(Math.abs(altitude(171, 16) - base)).toBeGreaterThan(0.15);
    // Half a year later at the same hour the sky is on the other side.
    expect(Math.abs(altitude(354, 22) - base)).toBeGreaterThan(0.3);
  });

  it("keeps the frame orthonormal at every latitude and hour", () => {
    for (const latitude of [-60, -20, 0, 45, 70]) {
      for (const hour of [0, 6, 13.5, 21]) {
        const rows = equatorialToWorldRows(
          localSiderealTimeHours(createEnvironmentClock(171, hour)),
          latitude,
        );
        for (const row of rows) expect(Math.hypot(...row)).toBeCloseTo(1, 9);
        const dot = (a: readonly number[], b: readonly number[]) =>
          a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
        expect(dot(rows[0], rows[1])).toBeCloseTo(0, 9);
        expect(dot(rows[1], rows[2])).toBeCloseTo(0, 9);
        expect(dot(rows[0], rows[2])).toBeCloseTo(0, 9);
      }
    }
  });

  it("puts the celestial pole at the observer's latitude", () => {
    // The single geometric fact every planetarium is judged on.
    for (const latitude of [10, 45, 70]) {
      const rows = equatorialToWorldRows(
        localSiderealTimeHours(createEnvironmentClock(171, 3)),
        latitude,
      );
      const pole = equatorialToWorld([0, 0, 1], rows);
      expect(Math.asin(pole[1]) / DEGREES, `latitude ${latitude}`)
        .toBeCloseTo(latitude, 6);
    }
  });
});

describe("star photometry (7-3)", () => {
  it("extinguishes faint stars near the horizon before bright ones", () => {
    // Kasten–Young: ~1 air mass at the zenith, ~2 at 30°, ~5.6 at 10°.
    expect(relativeAirMass(90)).toBeCloseTo(1, 2);
    expect(relativeAirMass(30)).toBeCloseTo(2.0, 1);
    expect(relativeAirMass(10)).toBeGreaterThan(5);
    expect(relativeAirMass(10)).toBeLessThan(6.5);
    // A first-magnitude star at 5° is still brighter than a fourth-magnitude
    // one at the zenith — the reason extinction is per star and not a fade.
    expect(extinguishedMagnitude(1.0, 5)).toBeLessThan(extinguishedMagnitude(4.0, 90));
    expect(extinguishedMagnitude(1.0, -2)).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps magnitude a real logarithmic scale", () => {
    expect(starIlluminanceLux(0) / starIlluminanceLux(5)).toBeCloseTo(100, 3);
    expect(starIlluminanceLux(-1.46) / starIlluminanceLux(0))
      .toBeCloseTo(10 ** (0.4 * 1.46), 6);
  });

  it("brings stars out in magnitude order through twilight", () => {
    // Sun above the horizon: nothing. Civil twilight: the fade starts.
    // Astronomical twilight: full.
    expect(starVisibilityForSunElevation(Math.sin(2 * DEGREES))).toBe(0);
    expect(starVisibilityForSunElevation(Math.sin(-6 * DEGREES))).toBeCloseTo(0, 3);
    const nautical = starVisibilityForSunElevation(Math.sin(-11 * DEGREES));
    expect(nautical).toBeGreaterThan(0.2);
    expect(nautical).toBeLessThan(0.95);
    expect(starVisibilityForSunElevation(Math.sin(-18 * DEGREES))).toBe(1);
  });

  it("packs one quad per star with a shared direction", () => {
    const stars = brightStars().slice(0, 5);
    const geometry = buildStarFieldGeometry(stars);
    expect(geometry.starCount).toBe(5);
    expect(geometry.positions.length).toBe(5 * 4 * 3);
    expect(geometry.indices.length).toBe(5 * 6);
    // All four corners of a star share its direction; only the corner
    // attribute differs, which is what makes the sprite screen-space.
    for (let corner = 1; corner < 4; corner += 1) {
      expect(geometry.positions[corner * 3]).toBe(geometry.positions[0]);
      expect(geometry.positions[corner * 3 + 1]).toBe(geometry.positions[1]);
    }
    const corners = new Set<string>();
    for (let corner = 0; corner < 4; corner += 1) {
      corners.add(`${geometry.corners[corner * 2]},${geometry.corners[corner * 2 + 1]}`);
    }
    expect(corners.size).toBe(4);
    expect(geometry.params[3]).toBeCloseTo(stars[0]!.magnitude, 6);
  });
});

describe("the moon (7-1)", () => {
  it("anchors the clock to a stated epoch", () => {
    const midnight = createEnvironmentClock(0, 0);
    expect(julianDayForClock(midnight)).toBe(EPHEMERIS_REFERENCE_JULIAN_DAY);
    // 2026-01-01 is 9,497 days after J2000.0 (26 years, 7 of them leap).
    expect(daysSinceJ2000(midnight)).toBeCloseTo(9_496.5, 6);
  });

  it("completes a synodic month and no other period", () => {
    const fractionAt = (day: number): number =>
      moonState(createEnvironmentClock(day % 365, 0)).illuminatedFraction;
    // Sample a full year at one-day resolution and count full moons.
    const fractions: number[] = [];
    for (let day = 0; day < 365; day += 1) fractions.push(fractionAt(day));
    let maxima = 0;
    for (let day = 1; day < 364; day += 1) {
      if (fractions[day]! > fractions[day - 1]! && fractions[day]! > fractions[day + 1]!) {
        maxima += 1;
      }
    }
    // 365 / 29.53 = 12.36 lunations.
    expect(maxima).toBeGreaterThanOrEqual(11);
    expect(maxima).toBeLessThanOrEqual(13);
    expect(365 / maxima).toBeGreaterThan(SYNODIC_MONTH_DAYS - 2);
    expect(365 / maxima).toBeLessThan(SYNODIC_MONTH_DAYS + 3.5);
  });

  it("ties phase to the sun–moon elongation, not to a free parameter", () => {
    for (let day = 0; day < 60; day += 3) {
      const clock = createEnvironmentClock(day, 6);
      const moon = moonState(clock);
      const elongation = moon.elongationDegrees > 180
        ? 360 - moon.elongationDegrees
        : moon.elongationDegrees;
      expect(moon.phaseAngleDegrees).toBeCloseTo(180 - elongation, 6);
      expect(moon.illuminatedFraction).toBeCloseTo(
        (1 + Math.cos(moon.phaseAngleDegrees * DEGREES)) / 2,
        6,
      );
      expect(moon.illuminatedFraction).toBeGreaterThanOrEqual(0);
      expect(moon.illuminatedFraction).toBeLessThanOrEqual(1);
    }
  });

  it("stays inside the moon's real distance and angular-size range", () => {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = 0;
    for (let day = 0; day < 365; day += 1) {
      const moon = moonState(createEnvironmentClock(day, 12));
      minimum = Math.min(minimum, moon.distanceKilometers);
      maximum = Math.max(maximum, moon.distanceKilometers);
      // 0.24°–0.28° angular radius — a "supermoon" is a 14% difference.
      expect(moon.angularRadiusRadians).toBeGreaterThan(0.0040);
      expect(moon.angularRadiusRadians).toBeLessThan(0.0051);
      expect(Math.abs(moon.eclipticLatitudeDegrees)).toBeLessThanOrEqual(5.2);
    }
    expect(minimum).toBeGreaterThan(360_000);
    expect(maximum).toBeLessThan(407_000);
  });

  it("carries the opposition surge instead of a lit-fraction fake", () => {
    // Allen's law: full moon −12.73, and a quarter moon is ~10× fainter
    // than half its lit fraction would suggest. Faking the phase with the
    // lit fraction alone makes every gibbous night far too bright.
    expect(moonApparentMagnitude(0)).toBeCloseTo(-12.73, 2);
    const full = 10 ** (-0.4 * moonApparentMagnitude(0));
    const quarter = 10 ** (-0.4 * moonApparentMagnitude(90));
    expect(quarter / full).toBeLessThan(0.16);
    expect(quarter / full).toBeGreaterThan(0.06);
  });

  it("lands full-moon illuminance on the accepted 0.25 lux", () => {
    const fullMoon = {
      phaseAngleDegrees: 0,
      distanceKilometers: 385_001,
    } as ReturnType<typeof moonState>;
    expect(moonIlluminanceLux(fullMoon, 1)).toBeCloseTo(FULL_MOON_ILLUMINANCE_LUX, 2);
    expect(moonIlluminanceLux(fullMoon, 0)).toBe(0);
    expect(moonIlluminanceLux(fullMoon, -0.5)).toBe(0);
    // Perigee is brighter than apogee by ~30%.
    const perigee = { ...fullMoon, distanceKilometers: 363_300 };
    const apogee = { ...fullMoon, distanceKilometers: 405_500 };
    expect(moonIlluminanceLux(perigee, 1) / moonIlluminanceLux(apogee, 1))
      .toBeCloseTo(1.25, 1);
  });

  it("keeps moonlight WARM — the blue belongs to the viewer's rods", () => {
    // ~4,100 K reflected sunlight. A blue moonlight tint is the classic
    // mistake the plan names; this is the assertion that forbids it.
    expect(MOONLIGHT_TINT[0]).toBeGreaterThan(MOONLIGHT_TINT[2]);
    expect(MOONLIGHT_TINT[0] / MOONLIGHT_TINT[2]).toBeGreaterThan(1.2);
    // ...while the rod tint, which is a perceptual effect, IS blue.
    expect(SCOTOPIC_TINT[2]).toBeGreaterThan(SCOTOPIC_TINT[0]);
  });
});

describe("scotopic vision (7-2)", () => {
  it("blends rods and cones across the mesopic range", () => {
    expect(rodFractionForAdaptedLuminance(SCOTOPIC_THRESHOLD_CD_M2 * 0.5)).toBe(1);
    expect(rodFractionForAdaptedLuminance(SCOTOPIC_THRESHOLD_CD_M2)).toBeCloseTo(1, 3);
    expect(rodFractionForAdaptedLuminance(PHOTOPIC_THRESHOLD_CD_M2)).toBeCloseTo(0, 3);
    expect(rodFractionForAdaptedLuminance(3_000)).toBe(0);
    const mid = rodFractionForAdaptedLuminance(
      Math.sqrt(SCOTOPIC_THRESHOLD_CD_M2 * PHOTOPIC_THRESHOLD_CD_M2),
    );
    expect(mid).toBeCloseTo(0.5, 1);
    expect(shouldRunScotopicPass(0)).toBe(false);
    expect(shouldRunScotopicPass(0.001)).toBe(false);
    expect(shouldRunScotopicPass(0.001_001)).toBe(true);
  });

  it("weights the rod response toward the blue-green, away from red", () => {
    // V'(λ) peaks at 507 nm — that is why red preserves dark adaptation.
    expect(SCOTOPIC_WEIGHTS[0]).toBeLessThan(0.08);
    expect(SCOTOPIC_WEIGHTS[2]).toBeGreaterThan(SCOTOPIC_WEIGHTS[0] * 5);
    const sum = SCOTOPIC_WEIGHTS[0] + SCOTOPIC_WEIGHTS[1] + SCOTOPIC_WEIGHTS[2];
    expect(sum).toBeCloseTo(1, 6);
  });

  it("bounds adaptation, slower into the dark than out of it", () => {
    // A 5-second step from daylight toward starlight must move a long way
    // less than the same step in the other direction.
    const darkening = adaptLuminance(3_000, 0.003, 5);
    const brightening = adaptLuminance(0.003, 3_000, 5);
    expect(darkening).toBeLessThan(3_000);
    expect(darkening).toBeGreaterThan(0.003);
    const darkDecades = Math.log10(3_000 / darkening);
    const brightDecades = Math.log10(brightening / 0.003);
    expect(brightDecades).toBeGreaterThan(darkDecades * 4);
    // It converges, and a zero step is a no-op.
    expect(adaptLuminance(3_000, 0.003, 10_000)).toBeCloseTo(0.003, 5);
    expect(adaptLuminance(12, 0.5, 0)).toBe(12);
  });

  it("puts day, twilight and a moonless night in the right vision regime", () => {
    const clear = (hour: number) => resolveEnvironmentState({
      clock: createEnvironmentClock(171, hour),
      latitudeDegrees: 45,
      weather: "clear",
    });
    const noon = adaptedLuminanceCdM2(clear(12.5));
    const dusk = adaptedLuminanceCdM2(clear(20.5));
    const night = adaptedLuminanceCdM2(clear(0));
    expect(rodFractionForAdaptedLuminance(noon)).toBe(0);
    expect(rodFractionForAdaptedLuminance(dusk)).toBeGreaterThan(0);
    expect(rodFractionForAdaptedLuminance(night)).toBe(1);
    // ...and a full moon lifts a moonless night measurably without leaving
    // the rod regime, which is exactly what a moonlit night is.
    const moonlit = adaptedLuminanceCdM2(clear(0), 0.25);
    expect(moonlit / night).toBeGreaterThan(50);
    expect(rodFractionForAdaptedLuminance(moonlit)).toBeGreaterThan(0.9);
  });

  it("replaces 1C-10's 40-lux night floor with the real sky", () => {
    // The realignment's "at 22:00 the ground is black" had one cause: the
    // diffuse-skylight proxy floored at 40 lux, which is a lit car park —
    // no moon could ever show above it.
    const midnight = resolveEnvironmentState({
      clock: createEnvironmentClock(171, 0),
      latitudeDegrees: 45,
      weather: "clear",
    });
    const moonless = horizontalIlluminanceLux(midnight);
    expect(moonless).toBeLessThan(0.05);
    expect(moonless).toBeGreaterThanOrEqual(MOONLESS_NIGHT_ILLUMINANCE_LUX);
    expect(horizontalIlluminanceLux(midnight, 0.25)).toBeGreaterThan(moonless * 20);
    // Noon is unchanged to the last significant figure that matters.
    const noon = resolveEnvironmentState({
      clock: createEnvironmentClock(171, 12.5),
      latitudeDegrees: 45,
      weather: "clear",
    });
    expect(horizontalIlluminanceLux(noon)).toBeGreaterThan(90_000);
  });

  it("calibrates scene units to nits from the sun's own definition", () => {
    // 5.2 scene units IS 120,000 lux, so one unit is 120000/(5.2·π) cd/m²
    // off a white Lambertian surface. The rod response is evaluated in real
    // units, so this cannot be a free parameter.
    expect(SCENE_UNIT_TO_NITS).toBeCloseTo(120_000 / (5.2 * Math.PI), 6);
    // A noon scene sits far above the photopic threshold in those units.
    const noonSceneValue = 0.18 * 5.2 / Math.PI;
    expect(noonSceneValue * SCENE_UNIT_TO_NITS).toBeGreaterThan(1_000);
  });
});
