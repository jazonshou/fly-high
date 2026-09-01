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
 *
 * ---
 *
 * **Two traps waiting for `AirfieldLightingSystem`.** Neither can bite this
 * file — there is no Babylon object in it — which is exactly why they are
 * written here rather than left in a conversation: they land the moment a
 * shader and a draw wrapper first exist, and that is the moment someone will
 * be reading this docblock.
 *
 * 1. **`isReady()` returns true on a shader with an unresolved symbol.** A
 *    readiness flag is not a compile check. Assert on the compiled artifact.
 * 2. **`subMeshes[0].effect` after a depth pass is the DEPTH effect**, carrying
 *    none of the beauty pass's defines. Reading it reported a clean all-clear
 *    on both arms of a real investigation. Select the wrapper deliberately.
 *
 * Both break the same distinction the tests here are careful to keep: a green
 * suite is not a working feature unless the thing asserted is the thing drawn.
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

// ---------------------------------------------------------------------------
// Runway edge, threshold and centreline fixtures.
// ---------------------------------------------------------------------------

/**
 * `"off"` means **not visible in that direction**, which is a real state rather
 * than a placeholder: touchdown-zone and approach fixtures are unidirectional
 * and show nothing to an aircraft using the other end. Without it the
 * per-direction model would have to pretend they are omnidirectional.
 */
export type AirfieldLightColour = "white" | "amber" | "green" | "red" | "off";
export type AirfieldFixtureKind =
  | "edge"
  | "threshold"
  | "centreline"
  | "touchdownZone"
  | "approach";

/**
 * Fixture geometry and its colour coding.
 *
 * **The colours are per-DIRECTION and that is not a refinement.** This runway
 * is bidirectional: the same lamp at the `+1` end is a green threshold light to
 * an aircraft arriving over it and a red end light to one rolling at it. One
 * colour per fixture cannot express that, and the plan asks for it by name.
 * The distances that drive the coding — the caution zone, the centreline's
 * remaining-distance bands — are measured toward the end being served, so they
 * are direction-dependent for the same reason.
 *
 * `centrelineSpacingMeters` is deliberately its own number rather than
 * `runwayMarkingProfile`'s stripe period. Paint and lights are different
 * fixtures that happen to share a line; tying them together would make a
 * lighting change require a painting change because two numbers looked alike.
 */
export const AIRFIELD_LIGHTING_PROFILE = Object.freeze({
  edgeSpacingMeters: 60,
  /** Outboard of the paved edge, still inside the graded platform. */
  edgeLateralMarginMeters: 3,
  /**
   * Caution-zone cap, metres. The zone is the LESSER of this and a third of
   * the runway — see `cautionZoneMeters`, which is where the rule lives.
   */
  cautionZoneCapMeters: 600,
  /** The other half of the rule: a fraction of runway length. */
  cautionZoneFraction: 1 / 3,
  centrelineSpacingMeters: 30,
  /** Centreline coding bands, in metres of runway REMAINING ahead. */
  centrelineAllRedMeters: 300,
  centrelineAlternatingMeters: 900,
  thresholdLightCount: 12,
  /** Elevated fixtures; the centreline is inset and sits flush. */
  elevatedHeightMeters: 0.35,
  insetHeightMeters: 0,

  // Touchdown zone (ICAO Annex 14): pairs of barrettes about the centreline,
  // innermost 60 m from the threshold, at 60 m longitudinal intervals.
  touchdownZoneStartMeters: 60,
  touchdownZoneSpacingMeters: 60,
  /** Cap on the pattern; the midpoint rule below usually wins on this runway. */
  touchdownZoneCapMeters: 900,
  barretteLightCount: 3,
  barretteSpacingMeters: 1.5,

  // Simple approach lighting system (ICAO Annex 14): a centreline row reaching
  // 420 m out at 60 m spacing, with one crossbar 300 m from the threshold.
  approachLengthMeters: 420,
  approachSpacingMeters: 60,
  approachCrossbarDistanceMeters: 300,
  approachCrossbarLengthMeters: 30,
  approachCrossbarLightCount: 9,
});

export interface AirfieldFixture {
  readonly kind: AirfieldFixtureKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly along: number;
  readonly across: number;
  /**
   * Colour emitted toward the `-1` end and toward the `+1` end, in that order —
   * what an observer beyond that end, looking back along the runway, sees.
   */
  readonly colourTowardEnd: readonly [AirfieldLightColour, AirfieldLightColour];
}

/** Runway-local `along` positions at an even spacing, both ends included. */
function alongPositions(halfLength: number, spacing: number): number[] {
  const out: number[] = [];
  const steps = Math.floor((2 * halfLength) / spacing);
  for (let index = 0; index <= steps; index += 1) out.push(-halfLength + index * spacing);
  return out;
}

/**
 * The caution zone: **600 m or one third of the runway length, whichever is the
 * less** (ICAO Annex 14, 3.9.7 — the yellow section at the remote end from
 * where the take-off run began).
 *
 * **It is a function of runway length, not a constant, and that is the whole
 * point.** A fixed 600 m on this 1,320 m runway leaves a 120 m white band
 * containing exactly one light station, so the runway reads amber end to end.
 * At one third it is 440 m of zone and 440 m of white — a third of the runway,
 * which is what the coding is meant to look like.
 *
 * **Do not "fix" this back to a half.** That variant is real but it is the
 * FAA's, and it comes paired with 2,000 ft (609.6 m) rather than 600 m; on this
 * runway the FAA rule gives a 100.8 m white band, NARROWER still. Taking 600 m
 * from ICAO and "half" from the FAA is a hybrid belonging to neither, and it
 * was how this constant was first written here.
 * `runwayMarkingProfile` declares this airport "ICAO-ish rather than
 * art-directed", so the ICAO pair is the consistent one.
 */
export function cautionZoneMeters(airport: Readonly<AirportDefinition>): number {
  return Math.min(
    AIRFIELD_LIGHTING_PROFILE.cautionZoneCapMeters,
    airport.runwayLength * AIRFIELD_LIGHTING_PROFILE.cautionZoneFraction,
  );
}

/**
 * Edge-light colour toward one end: amber once an aircraft rolling that way has
 * the caution zone or less of runway left.
 */
export function edgeColourTowardEnd(
  airport: Readonly<AirportDefinition>,
  along: number,
  end: PapiServedEnd,
): AirfieldLightColour {
  const remaining = airport.runwayLength * 0.5 - end * along;
  return remaining <= cautionZoneMeters(airport) ? "amber" : "white";
}

/**
 * Centreline colour toward one end, by runway remaining: white, then
 * alternating red/white, then red. The alternation keys on the fixture's index
 * from that end, so the pattern is a function of position rather than of the
 * order the list happened to be built in.
 */
export function centrelineColourTowardEnd(
  airport: Readonly<AirportDefinition>,
  along: number,
  end: PapiServedEnd,
): AirfieldLightColour {
  const profile = AIRFIELD_LIGHTING_PROFILE;
  const remaining = airport.runwayLength * 0.5 - end * along;
  if (remaining <= profile.centrelineAllRedMeters) return "red";
  if (remaining <= profile.centrelineAlternatingMeters) {
    return Math.round(remaining / profile.centrelineSpacingMeters) % 2 === 0 ? "red" : "white";
  }
  return "white";
}

/**
 * Every runway edge, threshold and centreline fixture, in runway-local order.
 *
 * **Keyed on the PAVED rectangle** (`runwayLength` x `runwayWidth`), not the
 * graded platform and not the influence footprint. Three rectangles are in
 * active use at this airport and they differ by 160 m and 508 m of width;
 * picking the wrong one puts edge lights in the grass or in the blend.
 *
 * **Every height goes through `runwayPlatformHeight`.** `airport.elevation` is
 * the surface only at `across == 0`, and every fixture here except the
 * centreline stands on camber.
 */
export function airfieldRunwayFixtures(
  airport: Readonly<AirportDefinition>,
): readonly AirfieldFixture[] {
  const profile = AIRFIELD_LIGHTING_PROFILE;
  const halfLength = airport.runwayLength * 0.5;
  const halfWidth = airport.runwayWidth * 0.5;
  const out: AirfieldFixture[] = [];

  const push = (
    kind: AirfieldFixtureKind,
    along: number,
    across: number,
    colourTowardEnd: readonly [AirfieldLightColour, AirfieldLightColour],
    heightMeters: number,
  ) => {
    const point = runwayToWorld(airport, along, across);
    out.push({
      kind,
      along,
      across,
      x: point.x,
      z: point.z,
      y: runwayPlatformHeight(airport, across) + heightMeters,
      colourTowardEnd,
    });
  };

  for (const along of alongPositions(halfLength, profile.edgeSpacingMeters)) {
    const colours = [
      edgeColourTowardEnd(airport, along, -1),
      edgeColourTowardEnd(airport, along, 1),
    ] as const;
    for (const side of [-1, 1] as const) {
      push(
        "edge",
        along,
        side * (halfWidth + profile.edgeLateralMarginMeters),
        colours,
        profile.elevatedHeightMeters,
      );
    }
  }

  // Green outward to arrivals, red inward to departures, at BOTH ends.
  for (const end of [-1, 1] as const) {
    const spanCount: number = profile.thresholdLightCount;
    const colours: readonly [AirfieldLightColour, AirfieldLightColour] =
      end === 1 ? ["red", "green"] : ["green", "red"];
    for (let index = 0; index < spanCount; index += 1) {
      const fraction = spanCount === 1 ? 0.5 : index / (spanCount - 1);
      const across = -halfWidth + fraction * airport.runwayWidth;
      push("threshold", end * halfLength, across, colours, profile.elevatedHeightMeters);
    }
  }

  for (const along of alongPositions(halfLength, profile.centrelineSpacingMeters)) {
    push(
      "centreline",
      along,
      0,
      [
        centrelineColourTowardEnd(airport, along, -1),
        centrelineColourTowardEnd(airport, along, 1),
      ] as const,
      profile.insetHeightMeters,
    );
  }

  return Object.freeze(out);
}

/**
 * Touchdown-zone pattern length: **900 m from the threshold, or the runway
 * midpoint, whichever is the shorter** (ICAO Annex 14). The midpoint rule is
 * what stops the two directions' patterns overlapping on a short runway; at
 * exactly the midpoint they meet, which is why the innermost barrette of each
 * direction lands on `along == 0`.
 *
 * Same shape as `cautionZoneMeters` and written the same way for the same
 * reason: a length rule expressed as a bare constant silently stops being the
 * rule the moment the runway changes.
 */
export function touchdownZoneExtentMeters(airport: Readonly<AirportDefinition>): number {
  return Math.min(AIRFIELD_LIGHTING_PROFILE.touchdownZoneCapMeters, airport.runwayLength * 0.5);
}

/**
 * Touchdown-zone barrettes for one approach direction. Unidirectional: an
 * aircraft using the other end sees nothing.
 *
 * **The barrette's inner offset DOES come from `runwayMarkingProfile`,** unlike
 * the centreline spacing which deliberately does not. The standard couples
 * these two — the barrettes sit on the touchdown-zone marking's lateral spacing
 * so the lights line up with the paint. Coupling where the standard couples,
 * and not where two numbers merely look alike, is the distinction; there is no
 * general rule here against sharing a constant.
 */
export function airfieldTouchdownZoneFixtures(
  airport: Readonly<AirportDefinition>,
  servedEnd: PapiServedEnd,
): readonly AirfieldFixture[] {
  const profile = AIRFIELD_LIGHTING_PROFILE;
  const threshold = servedEnd * airport.runwayLength * 0.5;
  const extent = touchdownZoneExtentMeters(airport);
  const colours: readonly [AirfieldLightColour, AirfieldLightColour] =
    servedEnd === 1 ? ["off", "white"] : ["white", "off"];
  const out: AirfieldFixture[] = [];
  for (
    let distance = profile.touchdownZoneStartMeters;
    distance <= extent + 1e-9;
    distance += profile.touchdownZoneSpacingMeters
  ) {
    const along = threshold - servedEnd * distance;
    for (const side of [-1, 1] as const) {
      for (let index = 0; index < profile.barretteLightCount; index += 1) {
        const across =
          side
          * (runwayMarkingProfile.touchdownHalfWidthMeters
            + index * profile.barretteSpacingMeters);
        const point = runwayToWorld(airport, along, across);
        out.push({
          kind: "touchdownZone",
          along,
          across,
          x: point.x,
          z: point.z,
          y: runwayPlatformHeight(airport, across) + profile.insetHeightMeters,
          colourTowardEnd: colours,
        });
      }
    }
  }
  return Object.freeze(out);
}

/**
 * Simple approach lighting system for one direction: a centreline row reaching
 * `approachLengthMeters` beyond the threshold at `approachSpacingMeters`, plus
 * one crossbar at `approachCrossbarDistanceMeters` (ICAO Annex 14).
 *
 * **Held in the threshold's horizontal plane, and that is what keeps it
 * seed-independent.** These fixtures sit up to 420 m beyond the threshold, far
 * outside the graded platform, where the only ground height available is
 * `runwayEarthworksHeightLocal` — which needs `naturalHeight` and a `seedHash`.
 * Real installations mount approach lights on masts precisely so the lamps lie
 * in a plane rather than following the ground, so taking the threshold's plane
 * is both the physically correct choice and the one that survives a seed
 * change. **Mast length is what absorbs the terrain and is not modelled here:**
 * a consumer that wants to draw the structure has to sample terrain itself.
 */
export function airfieldApproachFixtures(
  airport: Readonly<AirportDefinition>,
  servedEnd: PapiServedEnd,
): readonly AirfieldFixture[] {
  const profile = AIRFIELD_LIGHTING_PROFILE;
  const threshold = servedEnd * airport.runwayLength * 0.5;
  const planeY = runwayPlatformHeight(airport, 0) + profile.elevatedHeightMeters;
  const colours: readonly [AirfieldLightColour, AirfieldLightColour] =
    servedEnd === 1 ? ["off", "white"] : ["white", "off"];
  const out: AirfieldFixture[] = [];
  const push = (along: number, across: number) => {
    const point = runwayToWorld(airport, along, across);
    out.push({
      kind: "approach",
      along,
      across,
      x: point.x,
      z: point.z,
      y: planeY,
      colourTowardEnd: colours,
    });
  };
  for (
    let distance = profile.approachSpacingMeters;
    distance <= profile.approachLengthMeters + 1e-9;
    distance += profile.approachSpacingMeters
  ) {
    push(threshold + servedEnd * distance, 0);
  }
  const half = profile.approachCrossbarLengthMeters * 0.5;
  const count = profile.approachCrossbarLightCount;
  for (let index = 0; index < count; index += 1) {
    const across = -half + (index / (count - 1)) * profile.approachCrossbarLengthMeters;
    push(threshold + servedEnd * profile.approachCrossbarDistanceMeters, across);
  }
  return Object.freeze(out);
}

/**
 * Every airfield fixture, for the approach directions actually served.
 *
 * **Both ends by default, and the reason is recorded because the opposite looks
 * like an easy win.** Serving one end drops 283 fixtures to 201 and appears to
 * fit `7-5`'s "~200 light points" — but that figure is a plan SIZING ESTIMATE,
 * not a measured budget, and landing exactly on an estimate is not evidence the
 * estimate was right.
 *
 * What has actually been measured is that **draw calls bind**, and light points
 * are one instanced draw whatever the count: 283 against 201 adds **zero** draw
 * calls, and at 32 B of instance data apiece the difference is about 2.6 KB.
 * The count is not on the binding axis. What it could cost is **fill rate**,
 * which is measurable, tunable and reversible — whereas an unlit approach is
 * not, and would be found by someone flying a night approach onto the dark end.
 *
 * `servedEnds` stays a parameter so that lever exists if `7-5`'s measurement
 * ever shows fill rate binding. Changing the default is a one-value decision;
 * make it against a measurement rather than against this estimate.
 */
export function airfieldFixtures(
  airport: Readonly<AirportDefinition>,
  servedEnds: readonly PapiServedEnd[] = [-1, 1],
): readonly AirfieldFixture[] {
  const out: AirfieldFixture[] = [...airfieldRunwayFixtures(airport)];
  for (const end of servedEnds) {
    out.push(...airfieldTouchdownZoneFixtures(airport, end));
    out.push(...airfieldApproachFixtures(airport, end));
  }
  return Object.freeze(out);
}
