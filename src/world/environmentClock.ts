/**
 * The environment clock (0-6): the two continuous scalars that replace the
 * time-of-day preset enum as rendering inputs (§1.6).
 *
 * The threading rule this type exists to enforce: `dayOfYear` (or the whole
 * clock) is a parameter of every seasonal field function's signature from the
 * moment that function is first written — the land-cover classifier (4-6),
 * the vegetation density and appearance fields (1B-7, 2-18), the surface
 * palette (3-10) — never an addition to it. The architecture manifest lists
 * the seasonal family; its boundary test checks members as they appear.
 *
 * Class P, pure, Node-testable, no Babylon import. The NOAA solar-position
 * formula and the EnvironmentDirector stay in 1C-1; this module carries only
 * the type, its validation, and the small astronomical helpers that give the
 * scalars meaning.
 */

export const DAYS_PER_YEAR = 365;
export const HOURS_PER_DAY = 24;

/** Maximum solar declination: the axial tilt, in degrees. */
const AXIAL_TILT_DEGREES = 23.44;
const DEGREES_TO_RADIANS = Math.PI / 180;

export interface EnvironmentClock {
  /** [0, 365) — day 0 is January 1st. Drives declination and the biosphere. */
  readonly dayOfYear: number;
  /** [0, 24) — local solar time; 12 is solar noon. Drives the hour angle. */
  readonly solarTimeHours: number;
}

function requireInRange(value: number, low: number, highExclusive: number, label: string): number {
  if (!Number.isFinite(value) || value < low || value >= highExclusive) {
    throw new RangeError(`${label} must be in [${low}, ${highExclusive})`);
  }
  return value;
}

export function createEnvironmentClock(
  dayOfYear: number,
  solarTimeHours: number,
): EnvironmentClock {
  return Object.freeze({
    dayOfYear: requireInRange(dayOfYear, 0, DAYS_PER_YEAR, "dayOfYear"),
    solarTimeHours: requireInRange(solarTimeHours, 0, HOURS_PER_DAY, "solarTimeHours"),
  });
}

export function isEnvironmentClock(value: unknown): value is EnvironmentClock {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.dayOfYear === "number" &&
    Number.isFinite(candidate.dayOfYear) &&
    candidate.dayOfYear >= 0 &&
    candidate.dayOfYear < DAYS_PER_YEAR &&
    typeof candidate.solarTimeHours === "number" &&
    Number.isFinite(candidate.solarTimeHours) &&
    candidate.solarTimeHours >= 0 &&
    candidate.solarTimeHours < HOURS_PER_DAY
  );
}

/** Reduce any finite value onto the clock's cyclic ranges. */
export function wrapEnvironmentClock(
  dayOfYear: number,
  solarTimeHours: number,
): EnvironmentClock {
  if (!Number.isFinite(dayOfYear) || !Number.isFinite(solarTimeHours)) {
    throw new RangeError("Environment clock inputs must be finite");
  }
  const wrappedDay = ((dayOfYear % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  const wrappedHours = ((solarTimeHours % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
  return createEnvironmentClock(wrappedDay, wrappedHours);
}

/**
 * Solar declination for a day of the year, in radians. The cosine
 * approximation is within ~0.3° of the true value — ample for seasonal sun
 * paths; 1C-1's NOAA formula owns per-minute solar position.
 */
export function solarDeclinationRadians(dayOfYear: number): number {
  requireInRange(dayOfYear, 0, DAYS_PER_YEAR, "dayOfYear");
  return (
    -AXIAL_TILT_DEGREES *
    DEGREES_TO_RADIANS *
    Math.cos(((2 * Math.PI) / DAYS_PER_YEAR) * (dayOfYear + 10))
  );
}

/**
 * Hours of daylight at a latitude on a day of the year, from the sunrise
 * equation, clamped to polar day and polar night.
 */
export function dayLengthHours(dayOfYear: number, latitudeDegrees: number): number {
  if (
    !Number.isFinite(latitudeDegrees) ||
    latitudeDegrees < -90 ||
    latitudeDegrees > 90
  ) {
    throw new RangeError("latitudeDegrees must be in [-90, 90]");
  }
  const declination = solarDeclinationRadians(dayOfYear);
  const latitude = latitudeDegrees * DEGREES_TO_RADIANS;
  const cosHourAngle = -Math.tan(latitude) * Math.tan(declination);
  if (cosHourAngle <= -1) return HOURS_PER_DAY; // polar day
  if (cosHourAngle >= 1) return 0; // polar night
  return (2 * Math.acos(cosHourAngle) * HOURS_PER_DAY) / (2 * Math.PI);
}
