import { runwayToWorld } from "../../../world/airport";
import { runwayPlatformHeight } from "../terrain/RunwayEarthworks";
import type { AirportDefinition } from "../../../world/types";

/**
 * `7-13` airfield furniture — the windsock's siting and its wind response.
 *
 * **This increment is the arithmetic only**, deliberately, for the same reason
 * `7-7` split its PAPI law out from its billboard: everything here is a pure
 * function of `AirportDefinition` and a wind sample, so it is testable without
 * a host and it is the part that has to be numerically right rather than merely
 * plausible. Meshes and animation follow; they cannot be wrong in a way a
 * number can.
 *
 * ---------------------------------------------------------------------------
 * **THE SOCK NEEDS ITS OWN WIND SAMPLE, AND THE RENDERER DOES NOT TAKE ONE.**
 *
 * `sampleWind(world, x, y, z, t)` is positional, but its only consumer samples
 * at the AIRCRAFT and forwards four scalars to `detail.setWind`
 * (`FlightRenderer`, verified by symbol rather than by line — the citations in
 * the plan for this have gone stale twice). A windsock driven by that snapshot
 * points the way the wind blows *where the aeroplane is*, which on final
 * approach is kilometres from the sock.
 *
 * **Why that is a trap rather than an approximation:** the sock would still
 * point plausibly, still swing, still respond to gusts. Nothing in a frame
 * distinguishes it. `windsockWorldPosition` exists so the sample can be taken
 * where the sock actually stands, and the test asserts the two samples DIFFER
 * rather than asserting the angle looks right — see the note on validation
 * below, because asserting the angle is exactly the check that passes anyway.
 */

/**
 * Wind speed at which a standard windsock is fully extended, m/s.
 *
 * ICAO Annex 14 specifies a sock that is fully extended at **15 kt** and
 * indicates direction down to about **3 kt**. 15 kt = 7.72 m/s. These are the
 * real numbers rather than art-directed ones, so a sock reads as an instrument
 * a pilot could take a speed off, which is what it is for.
 */
export const WINDSOCK_FULL_EXTENSION_MPS = 7.72;

/** Below this the sock hangs and shows no usable direction. 3 kt = 1.54 m/s. */
export const WINDSOCK_MINIMUM_INDICATION_MPS = 1.54;

/**
 * Droop of a slack sock below horizontal, radians. A limp sock hangs close to
 * vertical against the pole; 75 degrees is the visual read of "no wind" without
 * clipping the geometry into the mast.
 */
export const WINDSOCK_SLACK_DROOP_RADIANS = (75 * Math.PI) / 180;

/**
 * How far the sock stands from the runway centreline, metres.
 *
 * Outside the graded shoulder so it is never inside the runway strip, and on
 * the opposite side from the PAPI so the two do not occlude each other on
 * approach — `papiUnitPlacements` sites its units at negative `across` for the
 * `+1` end, so the sock takes positive.
 */
export const WINDSOCK_LATERAL_OFFSET_METERS = 55;

/** Mast height, metres. ICAO calls for the sock to be visible from the air. */
export const WINDSOCK_MAST_HEIGHT_METERS = 6;

/**
 * Where the sock stands, in world metres.
 *
 * Runway midpoint laterally offset — the midpoint rather than a threshold
 * because a sock serves both directions and a pilot on either approach must be
 * able to see it. Height comes through `runwayPlatformHeight`, never
 * `runwayToWorld`'s `y`: that field is `airport.elevation`, which is the
 * surface only on the centreline, and the sock is 55 m off it.
 */
export function windsockWorldPosition(
  airport: Readonly<AirportDefinition>,
): { x: number; y: number; z: number } {
  const across = WINDSOCK_LATERAL_OFFSET_METERS;
  const point = runwayToWorld(airport, 0, across);
  return {
    x: point.x,
    y: runwayPlatformHeight(airport, across) + WINDSOCK_MAST_HEIGHT_METERS,
    z: point.z,
  };
}

/**
 * The heading the sock points, radians clockwise from world north (+z).
 *
 * A windsock streams AWAY from the wind source: it points the direction the air
 * is travelling toward, which is the same convention `sampleWind` returns its
 * vector in and the same one `AirportDefinition.headingRadians` uses, so the
 * two are directly comparable without a sign fix. That comparability is the
 * whole reason to state the convention here rather than leave it implied — a
 * sock reading 180 degrees out still looks like a windsock.
 */
export function windsockHeadingRadians(windX: number, windZ: number): number {
  return Math.atan2(windX, windZ);
}

/**
 * How inflated the sock is, 0 (limp) to 1 (fully extended horizontal).
 *
 * Linear in speed between the indication minimum and full extension, because
 * that is what the instrument is calibrated to: a pilot reads speed off the
 * number of inflated segments, and a curve here would make that reading wrong.
 */
export function windsockInflation(speedMetersPerSecond: number): number {
  const span = WINDSOCK_FULL_EXTENSION_MPS - WINDSOCK_MINIMUM_INDICATION_MPS;
  const above = speedMetersPerSecond - WINDSOCK_MINIMUM_INDICATION_MPS;
  return Math.min(Math.max(above / span, 0), 1);
}

/**
 * Angle below horizontal, radians. 0 is fully extended; the slack droop at
 * zero inflation.
 */
export function windsockDroopRadians(speedMetersPerSecond: number): number {
  return (1 - windsockInflation(speedMetersPerSecond)) * WINDSOCK_SLACK_DROOP_RADIANS;
}

/**
 * Smallest angle between two headings, radians, in [0, pi].
 *
 * Exported because the windsock TEST needs it to assert its own premise — that
 * its validation seed really is a crosswind seed — and a test that computed
 * this itself could drift from what the code means by an angle.
 */
export function headingDifferenceRadians(a: number, b: number): number {
  const raw = Math.abs(a - b) % (2 * Math.PI);
  return raw > Math.PI ? 2 * Math.PI - raw : raw;
}

/**
 * Smallest angle between a runway AXIS and a wind DIRECTION, radians, in
 * [0, pi/2]. 0 is along the runway; pi/2 is a pure crosswind.
 *
 * **A runway is bidirectional and the wind is not**, so this is not
 * `headingDifferenceRadians`. Runway 09 and runway 27 are the same strip of
 * tarmac, so a wind blowing along it at 180 degrees to the stated heading is
 * still a headwind-or-tailwind, not a crosswind — the comparison folds at 90.
 *
 * FOUND BY THIS FILE'S OWN NON-VACUITY TEST, which is why it is a separate
 * function rather than a note. The windsock premise check first used the
 * heading difference and measured `sock-1` at **177.3 degrees**, apparently the
 * most crosswind seed in the set. Folded, it is **2.7 degrees** — the most
 * ALIGNED seed, and exactly what `SWE II 2` measured. The unfolded number is
 * not merely imprecise: it inverts the ordering, so a premise check built on it
 * would have selected the blind seed and called it the validation one.
 */
export function runwayAxisDifferenceRadians(
  runwayHeadingRadians: number,
  windHeadingRadians: number,
): number {
  const heading = headingDifferenceRadians(runwayHeadingRadians, windHeadingRadians);
  return heading > Math.PI / 2 ? Math.PI - heading : heading;
}
