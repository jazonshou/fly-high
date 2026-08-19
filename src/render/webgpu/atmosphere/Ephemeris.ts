/**
 * `7-1` — celestial positions (owner: lighting).
 *
 * INVARIANT THIS FILE OWNS: the sun's right ascension, the moon's position,
 * phase and illuminance, and the Julian date the environment clock maps to.
 * `EnvironmentDirector` keeps owning the sun's rendered DIRECTION (the NOAA
 * elevation/azimuth pair every lighting consumer already reads); this module
 * adds the equatorial quantities that direction cannot express — the frame
 * the star field rotates in, and where the moon is. The two solar models are
 * held to agreement by test (`tests/render.webgpu-night-sky.test.ts` asserts
 * declination within 0.4°, which is the low-precision series' own error).
 *
 * **The reference epoch is a decision, not an oversight.** `EnvironmentClock`
 * carries `{dayOfYear, solarTimeHours}` and no year, because §1.6 chose two
 * continuous scalars. The moon needs a year: its phase repeats every 29.53
 * days, not every 365. So the clock is anchored to a fixed reference year —
 * moon phase is then a deterministic function of `dayOfYear`, which is
 * exactly what the plan asks for ("phase from `dayOfYear`"), and the
 * capture's pinned clock produces a pinned moon. Changing the anchor changes
 * every night's moon, so it is a constant with a name and a test, not a
 * literal buried in a formula.
 *
 * Accuracy: Meeus's low-precision lunar series (the four leading periodic
 * terms) is good to ~10 arcminutes in longitude and ~0.3° overall — a third
 * of the moon's own diameter. For a flight simulator's sky that is far
 * inside "the moon is where it should be tonight", and it costs four sine
 * terms instead of the ELP-2000 table's hundreds.
 *
 * Class P: pure arithmetic, no Babylon import, Node-tested.
 */

import { DAYS_PER_YEAR, type EnvironmentClock } from "@/src/world/environmentClock";

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * The anchor year. 2026-01-01 00:00 UT is JD 2461041.5 — 9,497 days after
 * J2000.0 (26 years, of which 2000, 2004, 2008, 2012, 2016, 2020 and 2024
 * were leap years).
 */
export const EPHEMERIS_REFERENCE_YEAR = 2026;
export const EPHEMERIS_REFERENCE_JULIAN_DAY = 2_461_041.5;

/** Obliquity of the ecliptic at the reference epoch, degrees. */
const OBLIQUITY_DEGREES = 23.4373;

/**
 * Julian date for a clock instant. Solar time is treated as universal time
 * at the world's meridian — the world has a latitude and no longitude, and
 * a longitude would only rotate the whole sky rigidly, which the sidereal
 * term already does.
 */
export function julianDayForClock(clock: EnvironmentClock): number {
  return EPHEMERIS_REFERENCE_JULIAN_DAY
    + clock.dayOfYear
    + clock.solarTimeHours / 24;
}

/** Days since J2000.0 (JD 2451545.0). */
export function daysSinceJ2000(clock: EnvironmentClock): number {
  return julianDayForClock(clock) - 2_451_545.0;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export interface EquatorialPosition {
  readonly rightAscensionHours: number;
  readonly declinationDegrees: number;
  /** Ecliptic longitude, degrees — the phase geometry needs it directly. */
  readonly eclipticLongitudeDegrees: number;
  readonly eclipticLatitudeDegrees: number;
  /** Distance in kilometres; `Infinity` for the sun's own scale. */
  readonly distanceKilometers: number;
}

function eclipticToEquatorial(
  longitudeDegrees: number,
  latitudeDegrees: number,
  distanceKilometers: number,
): EquatorialPosition {
  const lambda = longitudeDegrees * DEGREES_TO_RADIANS;
  const beta = latitudeDegrees * DEGREES_TO_RADIANS;
  const epsilon = OBLIQUITY_DEGREES * DEGREES_TO_RADIANS;
  const sinDec =
    Math.sin(beta) * Math.cos(epsilon)
    + Math.cos(beta) * Math.sin(epsilon) * Math.sin(lambda);
  const declination = Math.asin(Math.min(1, Math.max(-1, sinDec)));
  const y =
    Math.sin(lambda) * Math.cos(epsilon)
    - Math.tan(beta) * Math.sin(epsilon);
  const x = Math.cos(lambda);
  const rightAscension = Math.atan2(y, x);
  return Object.freeze({
    rightAscensionHours: (((rightAscension / Math.PI) * 12) % 24 + 24) % 24,
    declinationDegrees: declination / DEGREES_TO_RADIANS,
    eclipticLongitudeDegrees: normalizeDegrees(longitudeDegrees),
    eclipticLatitudeDegrees: latitudeDegrees,
    distanceKilometers,
  });
}

/**
 * The sun's apparent equatorial position. The standard low-precision series
 * (USNO's Astronomical Almanac "Approximate Solar Coordinates", good to
 * ~0.01°): mean longitude, mean anomaly, and the equation of centre's two
 * leading terms.
 */
export function solarApparentPosition(clock: EnvironmentClock): EquatorialPosition {
  const n = daysSinceJ2000(clock);
  const meanLongitude = normalizeDegrees(280.460 + 0.9856474 * n);
  const meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * n) * DEGREES_TO_RADIANS;
  const eclipticLongitude =
    meanLongitude
    + 1.915 * Math.sin(meanAnomaly)
    + 0.020 * Math.sin(2 * meanAnomaly);
  return eclipticToEquatorial(eclipticLongitude, 0, 1.496e8);
}

export interface MoonState extends EquatorialPosition {
  /**
   * Sun–moon elongation as seen from Earth, degrees. 0 is new, 180 is full;
   * this is the quantity the phase is drawn from.
   */
  readonly elongationDegrees: number;
  /** Phase angle (sun–moon–Earth), degrees. Complement of the elongation. */
  readonly phaseAngleDegrees: number;
  /** Illuminated fraction of the visible disc, 0…1. */
  readonly illuminatedFraction: number;
  /**
   * Waxing when the moon leads the sun in ecliptic longitude. The lit limb
   * is on the leading side; the disc shader needs the sign, not just the
   * fraction.
   */
  readonly waxing: boolean;
  /** Angular radius of the disc as seen from Earth, radians. */
  readonly angularRadiusRadians: number;
}

/** Mean lunar radius, kilometres. */
const MOON_RADIUS_KM = 1_737.4;

/**
 * Moon position, phase and apparent size. Meeus's low-precision series
 * (Astronomical Algorithms ch. 47's abridged form): mean longitude, mean
 * anomaly and argument of latitude, with the leading evection-free periodic
 * terms. ~0.3° — a third of the moon's diameter.
 */
export function moonState(clock: EnvironmentClock): MoonState {
  const n = daysSinceJ2000(clock);
  const meanLongitude = normalizeDegrees(218.316 + 13.176396 * n);
  const meanAnomaly = normalizeDegrees(134.963 + 13.064993 * n) * DEGREES_TO_RADIANS;
  const argumentOfLatitude = normalizeDegrees(93.272 + 13.229350 * n) * DEGREES_TO_RADIANS;
  const eclipticLongitude = meanLongitude + 6.289 * Math.sin(meanAnomaly);
  const eclipticLatitude = 5.128 * Math.sin(argumentOfLatitude);
  const distance = 385_001 - 20_905 * Math.cos(meanAnomaly);
  const equatorial = eclipticToEquatorial(eclipticLongitude, eclipticLatitude, distance);

  const sun = solarApparentPosition(clock);
  const elongation = normalizeDegrees(
    equatorial.eclipticLongitudeDegrees - sun.eclipticLongitudeDegrees,
  );
  // Phase angle is the supplement of the elongation for a distant sun.
  const phaseAngle = 180 - (elongation > 180 ? 360 - elongation : elongation);
  const illuminatedFraction = (1 + Math.cos(phaseAngle * DEGREES_TO_RADIANS)) / 2;
  return Object.freeze({
    ...equatorial,
    elongationDegrees: elongation,
    phaseAngleDegrees: phaseAngle,
    illuminatedFraction,
    waxing: elongation < 180,
    angularRadiusRadians: Math.atan(MOON_RADIUS_KM / distance),
  });
}

/**
 * Full-moon horizontal illuminance at the zenith, lux. The accepted value
 * for a mean full moon is ~0.25 lx; it follows from the moon's V magnitude
 * of −12.74 through `E = 10^(−0.4(m + 14.18))`, which is the same
 * magnitude→lux relation the star field uses.
 */
export const FULL_MOON_ILLUMINANCE_LUX = 0.267;

/**
 * Apparent V magnitude of the moon at a phase angle. Allen's empirical law,
 * `m = −12.73 + 0.026|φ| + 4×10⁻⁹ φ⁴`: the quartic is the opposition surge,
 * and it is why a full moon is more than twice as bright as a moon two days
 * either side of full rather than the 4% the lit fraction suggests. Faking
 * the phase with the lit fraction alone is the classic error and it makes
 * every gibbous night far too bright.
 */
export function moonApparentMagnitude(phaseAngleDegrees: number): number {
  const phi = Math.min(180, Math.abs(phaseAngleDegrees));
  return -12.73 + 0.026 * phi + 4.0e-9 * phi ** 4;
}

/**
 * Moonlight illuminance on a horizontal surface, lux, before atmospheric
 * extinction. `altitudeSine` is the sine of the moon's elevation; below the
 * horizon it is zero.
 */
export function moonIlluminanceLux(moon: MoonState, altitudeSine: number): number {
  if (altitudeSine <= 0) return 0;
  const magnitude = moonApparentMagnitude(moon.phaseAngleDegrees);
  const normal = 10 ** (-0.4 * (magnitude + 14.18));
  // Inverse-square on the actual distance: perigee full moons are ~30%
  // brighter than apogee ones, which is a visible difference on the ground.
  const distanceScale = (385_001 / moon.distanceKilometers) ** 2;
  return normal * distanceScale * altitudeSine;
}

/**
 * Linear-RGB tint of moonlight, normalised to luminance 1.
 *
 * Moonlight is REFLECTED SUNLIGHT off a regolith whose albedo falls toward
 * the blue, so its effective colour temperature is ~4,100 K — slightly warm,
 * not blue. The blue of a moonlit night is the Purkinje shift in the
 * viewer's rods (`7-2`), and putting it in the light colour instead is the
 * classic mistake the plan calls out by name. This constant exists so that
 * mistake cannot be made by accident.
 */
export const MOONLIGHT_TINT: readonly [number, number, number] = Object.freeze([
  1.14,
  0.99,
  0.78,
]);

/** Synodic month, days — the period `moonState`'s phase must reproduce. */
export const SYNODIC_MONTH_DAYS = 29.530589;

/** Days in the ephemeris year, mirrored so callers do not re-derive it. */
export const EPHEMERIS_DAYS_PER_YEAR = DAYS_PER_YEAR;
