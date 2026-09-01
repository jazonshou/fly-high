/**
 * `7-7` airfield lighting — the PAPI's angular law.
 *
 * **This increment is the geometry only.** `AirfieldLightingSystem`, the third
 * symbol this artifact owns, lands with `7-5`'s light points: a PAPI is drawn
 * as an emissive billboard and `7-5` owns that path. Everything here is pure
 * arithmetic over `AirportDefinition`, so it is testable without a host, which
 * is why it is first — it is also the only part of `7-7` that has to be
 * numerically right rather than merely plausible.
 *
 * **Why the law is analytic and not IES (D-3).** Babylon's `LoadIESData`
 * returns a one-dimensional profile indexed by polar angle about a single
 * axis. A PAPI is azimuthally asymmetric with a sharp vertical transition, so
 * it is not a function of that angle and cannot be carried by that format. IES
 * carries the rotationally-symmetric fixtures; this one is authored.
 */

import { runwayPlatformHeight } from "../terrain/RunwayEarthworks";
import { runwayMarkingProfile } from "../terrain/RunwaySurface";
import { runwayToWorld } from "../../../world/airport";
import type { AirportDefinition } from "../../../world/types";

/** Which runway end the wing bar serves. `+1` is the `along > 0` threshold. */
export type PapiServedEnd = -1 | 1;

/** One unit's indication. The bar reads outward from the runway. */
export type PapiIndication = "red" | "white";

const DEGREES_PER_RADIAN = 180 / Math.PI;

/**
 * The wing bar's geometry and its angular law.
 *
 * **`unitStepDegrees` is the whole law.** Four units, settings spaced evenly
 * about the glidepath at ±0.5° and ±1/6° — 30 and 10 arc-minutes, the ICAO
 * spacing — with the HIGHEST setting nearest the runway. On slope that reads
 * two red inboard and two white outboard, and the standard indications fall
 * out of it rather than being enumerated: 4 white too high, 3 white slightly
 * high, 2/2 on slope, 1 white slightly low, 4 red too low.
 *
 * **Siting is derived, not chosen, except where the tree is silent.**
 * `alongFromThresholdMeters` is `runwayMarkingProfile.touchdownFromThreshold-
 * Meters`, so the bar sits at the touchdown zone it is meant to indicate, and
 * the threshold crossing height is then a CONSEQUENCE of the glidepath rather
 * than a second number that can disagree with it.
 *
 * **The lateral siting deviates from ICAO deliberately, and the reason is
 * seed-independence rather than taste.** ICAO sites the bar ~15 m beyond the
 * runway edge at a 9 m unit pitch — here that is 32 m to 59 m from the
 * centreline, entirely outside the 31 m graded platform. Off the platform the
 * only height available is `runwayEarthworksHeightLocal`, which takes
 * `naturalHeight` and a `seedHash`: fixture height would become **seed
 * dependent**, which contradicts this item's requirement that the fixtures are
 * generated from `AirportDefinition` and survive a seed change, and would make
 * the height untestable without sampling terrain.
 *
 * So the bar is brought inboard to fit between the paved edge and the platform
 * edge, which costs the ICAO pitch: `innerOffsetMeters` 20 m (3 m clear of the
 * 17 m paved edge) and a 3.5 m pitch put the outermost unit at 30.5 m, inside
 * the platform with 0.5 m to spare. **The pitch is not optical** — each unit's
 * transition angle is independent of where it stands — it only sets how far
 * apart the four lights appear, and 3.5 m subtends 0.2° at 1 km, an order of
 * magnitude above the eye's resolution.
 */
export const PAPI_ANGLE_PROFILE = Object.freeze({
  glidepathDegrees: 3,
  unitCount: 4,
  /** Setting-angle step between adjacent units: 20 arc-minutes. */
  unitStepDegrees: 1 / 3,
  /** Distance from the served threshold, into the runway. */
  alongFromThresholdMeters: runwayMarkingProfile.touchdownFromThresholdMeters,
  /** Innermost unit's distance from the centreline. */
  innerOffsetMeters: 20,
  /** Lateral pitch between adjacent units. Not the ICAO 9 m — see above. */
  unitPitchMeters: 3.5,
  /** Lamp centre above the platform surface at `innerOffsetMeters`. */
  fixtureHeightMeters: 0.9,
});

/**
 * The setting angle of one unit, degrees above horizontal.
 *
 * `index` runs 0 (nearest the runway) to `unitCount - 1` (farthest). The
 * nearest unit takes the HIGHEST setting: an observer on slope is below it and
 * sees red, which is why the on-slope picture is red inboard, white outboard.
 */
export function papiUnitSettingDegrees(index: number): number {
  const { glidepathDegrees, unitCount, unitStepDegrees } = PAPI_ANGLE_PROFILE;
  const middle = (unitCount - 1) / 2;
  return glidepathDegrees + (middle - index) * unitStepDegrees;
}

/**
 * The bar's indication at an observed elevation angle, in degrees above
 * horizontal as measured AT THE UNITS.
 *
 * A unit shows white when the observer is above its setting angle. The
 * boundary is assigned to white so the function is total and the transition
 * has one unambiguous side; at exactly the setting angle a real unit shows the
 * pink transition, which is not represented and is narrower than the 0.1°
 * this is pinned to.
 */
export function papiColourForAngle(
  observedElevationDegrees: number,
): readonly PapiIndication[] {
  const out: PapiIndication[] = [];
  for (let index = 0; index < PAPI_ANGLE_PROFILE.unitCount; index += 1) {
    out.push(observedElevationDegrees >= papiUnitSettingDegrees(index) ? "white" : "red");
  }
  return Object.freeze(out);
}

/** Runway-local `along` of the served threshold. */
export function papiThresholdAlong(
  airport: Readonly<AirportDefinition>,
  servedEnd: PapiServedEnd,
): number {
  return servedEnd * airport.runwayLength * 0.5;
}

/** Runway-local `along` of the wing bar. */
export function papiBarAlong(
  airport: Readonly<AirportDefinition>,
  servedEnd: PapiServedEnd,
): number {
  return (
    papiThresholdAlong(airport, servedEnd)
    - servedEnd * PAPI_ANGLE_PROFILE.alongFromThresholdMeters
  );
}

export interface PapiUnitPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly settingDegrees: number;
}

/**
 * The altitude every lamp in the bar shares.
 *
 * **The bar is LEVELLED, and that is not a simplification.** The four units
 * stand at different `across`, where the camber puts the platform at four
 * different heights — 0.146 m apart across this bar. Letting each lamp follow
 * its own ground would give the four units four slightly different glidepaths,
 * which is precisely the error the wing bar exists to avoid. Real installations
 * level the bar on legs; this levels it to the innermost unit's ground.
 *
 * **Height comes through `runwayPlatformHeight`, never `runwayToWorld`'s `y`.**
 * That field is `airport.elevation`, which is the surface only on the
 * centreline.
 */
export function papiLampAltitudeMeters(airport: Readonly<AirportDefinition>): number {
  return (
    runwayPlatformHeight(airport, PAPI_ANGLE_PROFILE.innerOffsetMeters)
    + PAPI_ANGLE_PROFILE.fixtureHeightMeters
  );
}

/** World placement of the four units, innermost first. */
export function papiUnitPlacements(
  airport: Readonly<AirportDefinition>,
  servedEnd: PapiServedEnd,
): readonly PapiUnitPlacement[] {
  const along = papiBarAlong(airport, servedEnd);
  const y = papiLampAltitudeMeters(airport);
  const out: PapiUnitPlacement[] = [];
  for (let index = 0; index < PAPI_ANGLE_PROFILE.unitCount; index += 1) {
    const across =
      -servedEnd
      * (PAPI_ANGLE_PROFILE.innerOffsetMeters + index * PAPI_ANGLE_PROFILE.unitPitchMeters);
    const point = runwayToWorld(airport, along, across);
    out.push({ x: point.x, z: point.z, y, settingDegrees: papiUnitSettingDegrees(index) });
  }
  return Object.freeze(out);
}

/**
 * Elevation angle of a world point above one unit, degrees.
 *
 * Measured at the UNIT, which is the only datum a PAPI has. Referencing the
 * angle to the threshold instead moves the hinge by
 * `alongFromThresholdMeters`, and that disagreement is larger than the 0.1°
 * the law is pinned to at every approach range this airport can be flown at —
 * see `tests/lighting.papi-angular-law.test.ts`.
 */
export function papiElevationDegrees(
  unit: PapiUnitPlacement,
  x: number,
  y: number,
  z: number,
): number {
  const horizontal = Math.hypot(x - unit.x, z - unit.z);
  if (horizontal === 0) return y >= unit.y ? 90 : -90;
  return Math.atan((y - unit.y) / horizontal) * DEGREES_PER_RADIAN;
}

/**
 * The reference glidepath, as an ABSOLUTE altitude.
 *
 * **Returning an altitude rather than a height is the point.** A "height" here
 * needs a datum, and this shot has four candidates that differ by more than the
 * law's own tolerance — the lamp, the platform under the lamp, the centreline
 * datum, and the threshold. Handing back a world Y removes the choice from the
 * caller. `papiElevationDegrees` of a point on this path returns the glidepath
 * angle by construction, which is what the pin checks.
 *
 * `distanceBeforeThresholdMeters` is measured from the served threshold,
 * outward along the approach.
 */
export function papiOnSlopeAltitudeMeters(
  airport: Readonly<AirportDefinition>,
  distanceBeforeThresholdMeters: number,
): number {
  const range = distanceBeforeThresholdMeters + PAPI_ANGLE_PROFILE.alongFromThresholdMeters;
  return (
    papiLampAltitudeMeters(airport)
    + range * Math.tan(PAPI_ANGLE_PROFILE.glidepathDegrees / DEGREES_PER_RADIAN)
  );
}

/**
 * Height of the on-slope path above the centreline surface as it crosses the
 * served threshold — the figure a plate would call the threshold crossing
 * height. A CONSEQUENCE of `alongFromThresholdMeters` and the glidepath, not a
 * second number that can disagree with them.
 */
export function papiThresholdCrossingHeightMeters(
  airport: Readonly<AirportDefinition>,
): number {
  return papiOnSlopeAltitudeMeters(airport, 0) - runwayPlatformHeight(airport, 0);
}
