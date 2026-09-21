/**
 * What each instrument reads, from the `FlightVisualState` fields the 2D HUD
 * reads, in the units the HUD shows. Pure arithmetic: no Babylon, no meshes.
 *
 * THE UNITS ARE THE CODE'S, AND EVERY ONE WAS CHECKED AGAINST THE SIMULATOR
 * (docs/findings/COCKPIT_VIEW_2026_09_20.md; the step I1 table):
 *
 *  - `airspeed`: m/s, EQUIVALENT airspeed. The HUD's IAS tape is this x 1.94384 knots.
 *  - `altitude`: metres above the world's sea level (position.y). The HUD does NOT
 *    show it (its tape is `altitudeAgl`, height above the ground); an altimeter
 *    shows this one.
 *  - `verticalSpeed`: m/s, +up. The HUD's V/S is this x 196.85 feet a minute.
 *  - `engineRpm`: prop RPM on the trainer (700 idle, 2,750 max).
 *  - `pitch`, `bank`: DEGREES; +nose up, +right wing down.
 *
 * The dials are in fixed AVIATION units whatever the HUD's units setting: knots,
 * feet, feet a minute, RPM. The three factors below are the HUD's own inline
 * literals (`src/ui/Hud.tsx`); `tests/render.cockpit-instruments.test.ts` holds a
 * needle's reading to the number the HUD renders for the same state, so a factor
 * that drifts from the HUD's fails there rather than here.
 *
 * ANGLES are DEGREES CLOCKWISE FROM 12 O'CLOCK AS THE PILOT SEES THE DIAL:
 * 12 o'clock is 0, 3 o'clock +90, 6 o'clock +-180, 9 o'clock -90. That is a
 * statement about the picture, and it is NOT the sign of a rotation: a dial's
 * normal points TOWARD the pilot, and a positive right-handed rotation about an
 * axis pointing at the viewer appears ANTI-clockwise to that viewer. The code
 * that turns a needle owns that inversion, and a test that projects the needle
 * through the cockpit camera holds it to what is on screen.
 */

export const KNOTS_PER_METRE_PER_SECOND = 1.94384;
export const FEET_PER_METRE = 3.28084;
export const FEET_PER_MINUTE_PER_METRE_PER_SECOND = 196.85;

/** Vertical speed dial: full deflection either way, feet a minute. */
export const VERTICAL_SPEED_FULL_SCALE_FPM = 2_000;
/** An altimeter's needle makes one turn per this many feet. */
export const ALTIMETER_FEET_PER_TURN = 1_000;
/** Attitude bar: millimetres of slide per degree of pitch, and the clamp, degrees. */
export const PITCH_BAR_METRES_PER_DEGREE = 0.001;
export const PITCH_BAR_LIMIT_DEGREES = 25;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A number the dial can use: a non-finite reading holds the needle at its zero instead of poisoning the transform. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Airspeed needle: -150 degrees at 0 knots sweeping clockwise to +150 at `fullScaleKnots`, clamped. */
export function airspeedNeedleDegrees(metresPerSecond: number, fullScaleKnots: number): number {
  const knots = finiteOr(metresPerSecond, 0) * KNOTS_PER_METRE_PER_SECOND;
  return -150 + 300 * clamp(knots / fullScaleKnots, 0, 1);
}

/** Altimeter: one needle, 360 degrees per 1,000 feet of altitude ABOVE SEA LEVEL, unclamped (it wraps). */
export function altimeterNeedleDegrees(metresAboveSeaLevel: number): number {
  const feet = finiteOr(metresAboveSeaLevel, 0) * FEET_PER_METRE;
  const turn = ((feet % ALTIMETER_FEET_PER_TURN) + ALTIMETER_FEET_PER_TURN) % ALTIMETER_FEET_PER_TURN;
  return (turn / ALTIMETER_FEET_PER_TURN) * 360;
}

/**
 * Vertical speed: zero at 9 o'clock (-90), +2,000 ft/min at 12 o'clock (0)
 * clockwise from there, -2,000 at 6 o'clock (-180) anticlockwise from 9; clamped.
 */
export function verticalSpeedNeedleDegrees(metresPerSecond: number): number {
  const feetPerMinute = finiteOr(metresPerSecond, 0) * FEET_PER_MINUTE_PER_METRE_PER_SECOND;
  return -90 + 90 * clamp(feetPerMinute / VERTICAL_SPEED_FULL_SCALE_FPM, -1, 1);
}

/** Engine: -135 degrees at 0 to +135 at `fullScaleRpm`, clamped. */
export function engineNeedleDegrees(rpm: number, fullScaleRpm: number): number {
  return -135 + 270 * clamp(finiteOr(rpm, 0) / fullScaleRpm, 0, 1);
}

/**
 * The attitude ball's horizon turns by MINUS the bank, as seen by the pilot: in a
 * right bank (bank > 0, right wing down) the real horizon in the windscreen
 * tilts anticlockwise, and so does the ball's. Returned as degrees CLOCKWISE AS
 * THE PILOT SEES IT, so -bank; the caller converts that to a rotation.
 */
export function attitudeHorizonDegrees(bankDegrees: number): number {
  return -finiteOr(bankDegrees, 0);
}

/**
 * The radius of the ball the bar's 1 mm a degree is quoted against: the Global's
 * (0.048 m). A smaller ball, the Cessna's, scales the slide with its radius, so
 * the bar reaches the same fraction of the disc at the clamp and stays inside it.
 */
export const PITCH_BAR_REFERENCE_RADIUS_METRES = 0.048;

/**
 * How far the pitch bar sits above the ball's horizon line, metres, along the
 * ball's own up: it slides DOWN (negative) for nose-up, 1 mm a degree on the
 * reference ball (`ballRadiusMetres` in proportion on another), clamped at +-25
 * degrees.
 */
export function pitchBarOffsetMetres(pitchDegrees: number, ballRadiusMetres: number = PITCH_BAR_REFERENCE_RADIUS_METRES): number {
  const scale = ballRadiusMetres / PITCH_BAR_REFERENCE_RADIUS_METRES;
  return -clamp(finiteOr(pitchDegrees, 0), -PITCH_BAR_LIMIT_DEGREES, PITCH_BAR_LIMIT_DEGREES) * PITCH_BAR_METRES_PER_DEGREE * scale;
}

/** The reading a needle angle stands for: the inverse of the mapping, for tests that measure a needle and ask what it says. */
export const readingFromAngle = Object.freeze({
  airspeedKnots: (degrees: number, fullScaleKnots: number): number => ((degrees + 150) / 300) * fullScaleKnots,
  altimeterFeetModulo: (degrees: number): number => (((degrees % 360) + 360) % 360 / 360) * ALTIMETER_FEET_PER_TURN,
  verticalSpeedFeetPerMinute: (degrees: number): number => ((degrees + 90) / 90) * VERTICAL_SPEED_FULL_SCALE_FPM,
  engineRpm: (degrees: number, fullScaleRpm: number): number => ((degrees + 135) / 270) * fullScaleRpm,
});
