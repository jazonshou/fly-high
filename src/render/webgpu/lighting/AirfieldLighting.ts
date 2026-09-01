/**
 * RETRACTION of `fafb11a`'s headline, recorded here because a commit message
 * cannot be corrected in place.
 *
 * `fafb11a` is titled "Light the airfield" and reported
 * `runway-on-approach` gaining 20.476% of its pixels against a same-tree dark
 * control. THE WIRING LANDED; THE LAMPS ARE NOT VISIBLY LIT IN ANY SHOT.
 *
 * That 20.476% is terrain and ground-cover state differing between captures --
 * the foreground ground is green in one frame and sand in the other, with rows
 * 540-720 showing 66% and 81% of pixels changed at a mean of ~75 bytes. And
 * `runway-on-approach` is a DAYLIGHT shot, so there should have been no lamp
 * signal in it at all. The 12.5x day-versus-night figure came from the same
 * method and is withdrawn with it.
 *
 * WHAT IS ESTABLISHED: the mesh draws where an empty system drew nothing, +1
 * draw call measured uniformly on 30 of 30 shots, one instanced draw for 402
 * light points.
 *
 * ~~The lamps are not visible night or day. It is NOT brightness -- raising~~
 * ~~`AIRFIELD_LAMP_SCENE_SCALE` by 1000x leaves the night frame~~
 * ~~pixel-identical to the eye.~~
 *
 * Also withdrawn, and it was the exact inversion of the truth: it WAS
 * brightness, and only brightness. The 1000x probe that "proved" otherwise was
 * forced to pure red, and `SCOTOPIC_WEIGHTS[0] = 0.03` -- the rod pathway is
 * nearly blind to red BY DESIGN, so the probe was read in the night path's own
 * blind spot. Re-run in white it showed 1,559 pixels at 228 bytes: the lamps
 * had been rendering the whole time.
 *
 * THE DEPTH DIAGNOSIS BELOW IS WITHDRAWN. It is left standing, struck, because
 * it was believed and acted on, and because a reader who finds only the
 * conclusion cannot tell it was ever in doubt.
 *
 * ~~THE DEPTH TEST REJECTS THEM, and that is measured: forcing~~
 * ~~`depthFunction = ALWAYS` takes night-moonlit from 79 to 748 changed pixels~~
 * ~~and approach-500ft from 46 to 1180. `insetHeightMeters: 0` puts centreline~~
 * ~~and touchdown lamps exactly coplanar with the runway they are drawn~~
 * ~~against. A ground-level additive billboard depth-tested against its own~~
 * ~~ground cannot win.~~
 *
 * `5621131` refuted it: the 79-to-748 pixel movement behind that claim was THE
 * TREE LINE, not the lamps, and "geometry, positions and rasterization were
 * correct at both clocks the whole time". The whole defect was one constant,
 * `AIRFIELD_LAMP_SCENE_SCALE`, wrong by four orders. The lamps are lit and have
 * been since `5621131`; the first sentence of this docblock describes `fafb11a`
 * and NOT the current tree.
 *
 * WHY THE STRIKETHROUGH IS WORTH THE LINES. This text outlived its refutation
 * by four commits, and in that window it was read as current and cost real
 * design work: `7-14` sized its obstruction-light mounting offsets to defeat a
 * depth test that had already been shown not to be the mechanism. A retraction
 * notice at the top of a file is only load-bearing if it retracts everything it
 * should, and this one had itself gone stale.
 *
 * CLOSED: the aerial-transmittance route is refuted, not merely unmeasured.
 * `aerialPerspectiveCoefficients` reads only `state.atmosphere` and
 * `state.weather.relativeHumidity` -- no clock term -- so transmittance is
 * identical day and night at matched geometry and cannot produce a
 * time-of-day ratio.
 */
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
import type { LightPointFixture } from "./LightPoints";

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

// ---------------------------------------------------------------------------
// `AirfieldLightingSystem` — the third symbol this artifact owns.
//
// It joins 7-7's fixture arithmetic above to 7-5's `LightPointSystem`, which
// owns the billboard path. Until this existed, `FlightRenderer` constructed
// `new LightPointSystem(scene, [], 1)` and NOT ONE LAMP RENDERED: two gates of
// night-lighting work were present, correct, green under 33 assertions, and
// invisible. `PHASE_6_OUTCOME.md` §1 exists because a wave of Phase 6 work
// failed the same way — read "landed" as "the code exists and is correct",
// never as "you can see it".
// ---------------------------------------------------------------------------

/**
 * Lamp chromaticities, scene-linear RGB, each normalised so no lamp is brighter
 * than another merely by being a different colour — brightness is
 * `intensityCandela`'s job and mixing the two makes both untunable.
 *
 * Aviation colours are saturated by regulation (ICAO Annex 14, Appendix 1)
 * because they must stay identifiable through haze and at low intensity, which
 * is why the green and red sit far from white rather than being tinted whites.
 */
export const AIRFIELD_LAMP_RGB: Readonly<
  Record<Exclude<AirfieldLightColour, "off">, readonly [number, number, number]>
> = Object.freeze({
  // WARM, and derived rather than chosen. Runway edge lights are incandescent
  // at roughly 2700 K; the shipped value before this was [1.0, 0.96, 0.90],
  // near-neutral, which Jason reported from the air as "should not all be
  // white -- they should be yellow and stuff".
  //
  // THE NAIVE DERIVATION IS A TRAP, and it fails toward a worse defect than the
  // one it fixes. A 2700 K blackbody on the Planckian locus, referred to D65
  // and max-normalised, is [1.000, 0.417, 0.100] -- MORE saturated than the
  // amber below at [1.000, 0.630, 0.100]. Shipping it would make runway edge
  // lights more orange than the caution zone, destroying the white/amber
  // distinction the coding depends on, and it would read as a bug in the
  // caution zone rather than as a colour choice.
  //
  // The physics is right; the REFERENCE FRAME is what makes it wrong. D65 is
  // not what an observer is adapted to at night -- moonlight is, at roughly
  // 4,100 K (see `Ephemeris.MOONLIGHT_TINT`). Adapting 2700 K to that adapting
  // white is the principled correction and lands here. It is a stated frame
  // with a reason, which a raw blackbody number lacks.
  //
  // THE INVARIANT IS THE SEPARATION, NOT THIS TRIPLE. White and amber must stay
  // distinguishable in TWO channels -- green 0.78 vs 0.63 AND blue 0.52 vs 0.10
  // -- because a single-channel separation collapses under any future tint or
  // rod-retention change. `lighting.airfield-lighting-system.test.ts` pins the
  // separation rather than these values, so retuning either colour is allowed
  // and collapsing the coding is not. NOTE this is a JOINT invariant with
  // `SCOTOPIC_CHROMA_RETENTION`: at a much lower retention the hues compress
  // toward grey and the coding degrades whatever is set here.
  white: Object.freeze([1.0, 0.78, 0.52] as const),
  amber: Object.freeze([1.0, 0.63, 0.10] as const),
  green: Object.freeze([0.10, 1.0, 0.42] as const),
  red: Object.freeze([1.0, 0.08, 0.06] as const),
});

/**
 * Per-kind photometry, in CANDELA, because that is the unit the fixtures are
 * specified in and the shader's inverse-square falloff consumes.
 *
 * These are real orders of magnitude for the fixture classes (ICAO Annex 14
 * Appendix 2 isocandela diagrams): approach and threshold lights are the
 * brightest, inset centreline and touchdown-zone lamps are dimmer than elevated
 * edge lamps.
 *
 * CALIBRATION IS UNMEASURED. The scene-linear value a lamp lands on is
 * `intensity x candela x beam x extinction x transmittance / (distance^2 x
 * renderedRadiusPixels^2)`, and nothing in the tree states what scene-linear
 * value equals one cd/m^2 at night. So these are physically-sourced ratios with
 * one shared scale factor, and the scale factor is the thing to measure on a
 * host — NOT six numbers to art-direct independently. Keeping the ratios
 * physical means a calibration run moves one constant.
 */
export const AIRFIELD_LAMP_PHOTOMETRY: Readonly<
  Record<AirfieldFixtureKind | "papi", { readonly intensityCandela: number; readonly radiusMeters: number }>
> = Object.freeze({
  edge: Object.freeze({ intensityCandela: 10_000, radiusMeters: 0.12 }),
  threshold: Object.freeze({ intensityCandela: 10_000, radiusMeters: 0.12 }),
  centreline: Object.freeze({ intensityCandela: 5_000, radiusMeters: 0.10 }),
  touchdownZone: Object.freeze({ intensityCandela: 5_000, radiusMeters: 0.10 }),
  approach: Object.freeze({ intensityCandela: 20_000, radiusMeters: 0.14 }),
  papi: Object.freeze({ intensityCandela: 20_000, radiusMeters: 0.16 }),
});

/**
 * The one scale factor between candela and scene-linear radiance.
 *
 * Separated from the photometry above so a calibration change moves THIS and
 * nothing else, leaving the six physical ratios untouched.
 *
 * DERIVED IN TWO STEPS, because the first step alone was wrong by four orders
 * of magnitude and looked reasonable.
 *
 * **Step 1 — the unit bridge.** `StarFieldSystem` fixes a magnitude-0 star at
 * `STAR_ZERO_MAGNITUDE_SCENE_VALUE = 0.5` at its PSF centre, using the same
 * `1/psf^2` normaliser and the same 1.7 px PSF as a light point. Equating a
 * 10,000 cd lamp at 500 m to that star gives
 *
 *   0.5 = BRIDGE x 10000 / (500^2 x 1.7^2)  =>  BRIDGE = 36.1
 *
 * That correctly ties scene units to stellar illuminance. **It is not the
 * answer**, because equating a runway lamp to a mag-0 star is a statement
 * about brightness that happens to be false.
 *
 * **Step 2 — the physics the first step assumed away.** Illuminance at the eye
 * is `E = I / d^2`. A 10,000 cd lamp at 500 m delivers **0.04 lux**; a
 * magnitude-0 star delivers **2.54e-6 lux**. The lamp is **~15,750x** the star
 * — magnitude -10.5, between Venus and the full moon, which is what a real
 * runway edge light at half a kilometre looks like. So
 *
 *   SCALE = 36.1 x (0.04 / 2.54e-6) ~= 5.7e5
 *
 * MEASURED, not assumed: at 5.7e5 the `night-moonlit` capture lights 1,763
 * pixels peaking at **232 display bytes** at the runway, against 175 pixels at
 * 21 bytes under the old constant. As a cross-check, a deliberately bright
 * constant fragment (bypassing photometry entirely) peaks at 228 bytes in the
 * same frame — so the calibration now lands where "a bright lamp" independently
 * lands, rather than where a docblock guessed.
 *
 * **THE HISTORY IS THE WARNING.** This constant has been wrong three times:
 * 3.6e-2 (the step-1 expression evaluated a thousandfold out), then 36.1 (the
 * expression right, the anchor physically false by 10.5 magnitudes). Both
 * survived review because a scale factor is exactly what a reader trusts
 * without recomputing. `7-4a`'s `log2` highlight term is what keeps decades of
 * source brightness ORDERED at this magnitude instead of clipping - it was
 * built for sources this bright.
 *
 * **RED FIXTURES DEPEND ON THIS CONSTANT, and nothing would flag a regression.**
 * Rods are near-blind to red (`SCOTOPIC_WEIGHTS[0] = 0.03` against 0.928 for a
 * white lamp -- a 31x deficit) AND `7-4a`'s highlight term reads `sharpNits`
 * through the same weights, so red loses both the response and its highlight
 * preservation. What saves it is that the highlight term is `log2`, which
 * crushes a 31x input gap into a small output one -- but only while lamps are
 * bright enough to be in it. MEASURED red/white at the rod image:
 *
 *   peak ~300 scene units (this constant):  0.828  -- red reads 230 bytes
 *                                                     against white's 232
 *   peak ~3:                                 0.735
 *   peak ~0.02 (the old 36.1 constant):      0.327  -- and below sigma the
 *                                                     highlight term is
 *                                                     IDENTICALLY ZERO
 *
 * So at the previous calibration the PAPI's red half, the red threshold lights
 * and the obstruction lights would have faded out at night while their white
 * neighbours stayed lit -- a safety instrument lying by omission. **Lowering
 * this constant re-opens that**, silently, and no test in the tree would catch
 * it: the failure is perceptual and lives one pass downstream. A residue
 * survives even now, and the right word for it is SPARSER rather than dimmer --
 * red cores match white, but faint red lamps drop below threshold (1,473 lit
 * pixels against white's 2,221).
 */
export const AIRFIELD_LAMP_SCENE_SCALE = 5.7e5;

/**
 * Horizontal illuminance, lux, at or below which the lamps are at full effect.
 *
 * Anchored on deep civil twilight — the textbook figure for the sun at −6° is
 * ~3.4 lux, and this world's own model reads **2.672 lux at −6.12°**
 * (`dusk-mesopic`'s clock), so the two agree. That is the light level at which
 * runway lighting genuinely takes over from daylight.
 */
export const AIRFIELD_LAMP_FULL_EFFECT_LUX = 3.4;

/**
 * How much daylight suppresses the airfield lamps.
 *
 * **Why this exists.** `AIRFIELD_LAMP_SCENE_SCALE` is applied unconditionally
 * at both emission sites, and nothing else in this file references the sun. So
 * the lamps burn at their full NIGHT calibration at solar noon: measured on
 * `runway-on-approach`, **10,019 pixels above luminance 245 against 56 in the
 * committed baseline — 179×, and 1.09% of a daylight frame clipped.** The
 * runway rendered as a chequerboard of blown-out blocks.
 *
 * **Why it is a separate term and not a change to the scale.** That constant
 * has had three wrong values, and the frame its current value produces carries
 * Jason's approval. Moving it would put an approved night frame at risk to fix
 * a day defect. A multiplier that is *exactly* 1 below the horizon cannot
 * disturb any night shot at all — the night calibration is preserved **by
 * construction rather than by measurement**, which is a much stronger promise
 * than a re-measured one.
 *
 * **The horizon gate is syntactic on purpose.** It is an early return, not an
 * arithmetic edge case, so no illuminance value — a moon, a future sky model,
 * a bug — can reach through it and perturb a night frame. `night`,
 * `night-moonlit` and `dusk-mesopic` all sit at sun elevations of −21.46°,
 * −21.65° and −6.12°, so all three are untouched.
 *
 * **Above the horizon it is physical rather than tuned.** A lamp of fixed
 * intensity contributes in proportion to how much it adds over the ambient, so
 * the term is the ratio of the full-effect illuminance to the actual one. At
 * solar noon the model reads 1.11e5 lux against 1.5e-3 at night, and the
 * resulting attenuation is ~3e-5. No coefficient here was chosen by looking at
 * the clipped-pixel count it produced.
 *
 * @param sunElevationSine `state.sun.direction[1]` — the sine of the sun's
 *   elevation. At or below zero the lamps are at full effect.
 * @param horizontalLux the scene's horizontal illuminance from the sun.
 */
export function airfieldLampDaylightAttenuation(
  sunElevationSine: number,
  horizontalLux: number,
): number {
  // Not `sunElevationSine <= 0`: NaN must take this branch too. A NaN sun would
  // otherwise fall through and produce a NaN intensity, which reaches the GPU
  // as a lamp that is either invisible or infinite depending on the hardware.
  if (!(sunElevationSine > 0)) return 1;
  if (!Number.isFinite(horizontalLux)) return 1;
  const effective = Math.max(horizontalLux, AIRFIELD_LAMP_FULL_EFFECT_LUX);
  return Math.min(1, AIRFIELD_LAMP_FULL_EFFECT_LUX / effective);
}

/**
 * Beam cutoff for a directional lamp: a hemisphere.
 *
 * `0` is the cosine of 90 degrees. A lamp emitted toward one runway end must be
 * dark toward the other, or a threshold lamp shows green AND red from both
 * sides — the per-direction colouring above would be visible nonsense rather
 * than merely wrong.
 */
export const AIRFIELD_LAMP_BEAM_COSINE = 0;

/** World-space unit vector along increasing runway `along`. */
function runwayAxis(airport: Readonly<AirportDefinition>): readonly [number, number, number] {
  return [Math.sin(airport.headingRadians), 0, Math.cos(airport.headingRadians)];
}

/**
 * Expand 7-7's fixtures into light points, splitting each into up to two —
 * one per direction it is visible in.
 *
 * The split is forced by the data: `colourTowardEnd` carries a colour toward
 * each runway end, `LightPointFixture` carries one colour, and `"off"` means
 * not visible that way. One light point per lit direction, each with a
 * hemispherical beam facing the end it serves, expresses all three states
 * without a second material.
 */
export function airfieldLightPoints(
  airport: Readonly<AirportDefinition>,
): LightPointFixture[] {
  const axis = runwayAxis(airport);
  const out: LightPointFixture[] = [];
  for (const fixture of airfieldFixtures(airport)) {
    const photometry = AIRFIELD_LAMP_PHOTOMETRY[fixture.kind];
    // Index 0 is the colour shown toward the -1 end, index 1 toward +1.
    for (const end of [-1, 1] as const) {
      const colour = fixture.colourTowardEnd[end === -1 ? 0 : 1];
      if (colour === "off") continue;
      out.push({
        position: [fixture.x, fixture.y, fixture.z],
        aim: [axis[0] * end, 0, axis[2] * end],
        intensity: photometry.intensityCandela * AIRFIELD_LAMP_SCENE_SCALE,
        profileRow: 0,
        radiusMeters: photometry.radiusMeters,
        color: AIRFIELD_LAMP_RGB[colour],
        beamCosineCutoff: AIRFIELD_LAMP_BEAM_COSINE,
      });
    }
  }
  return out;
}

/** A PAPI lamp's placement plus the aim it is seen along. */
interface PapiLamp {
  readonly placement: PapiUnitPlacement;
  readonly servedEnd: PapiServedEnd;
}

/**
 * Every PAPI lamp, both served ends, in the order they are appended to the
 * light-point list.
 */
export function papiLamps(airport: Readonly<AirportDefinition>): readonly PapiLamp[] {
  const out: PapiLamp[] = [];
  for (const servedEnd of [-1, 1] as const) {
    for (const placement of papiUnitPlacements(airport, servedEnd)) {
      out.push({ placement, servedEnd });
    }
  }
  return out;
}

/**
 * The airfield's lighting, as one instanced draw.
 *
 * Owns the fixture -> light-point expansion and the PAPI's per-frame
 * indication. It does NOT own the billboard path, the PSF, the extinction model
 * or the aerial binding — those are `LightPointSystem`'s, and a second one of
 * any of them is the drift this arrangement exists to prevent.
 */
export class AirfieldLightingSystem {
  /** Every light point, static fixtures first, then the PAPI lamps. */
  readonly fixtures: readonly LightPointFixture[];
  private readonly lamps: readonly PapiLamp[];
  private readonly papiOffset: number;
  private readonly colours: (readonly [number, number, number])[];
  /** Last indication applied, one entry per PAPI lamp; drives the update. */
  private applied: PapiIndication[];

  /**
   * `extraFixtures` are light points this system does not generate but must
   * OWN, and ownership here is the whole point rather than a convenience.
   *
   * `LightPointSystem.setColors` throws unless it is handed exactly one colour
   * per fixture, its `fixtureCount` is frozen at construction, and the single
   * caller in the tree feeds it `colourList()`. So a caller that concatenates
   * its own fixtures into the `LightPointSystem` constructor and leaves this
   * class generating the colours ships a guaranteed throw — 402 colours against
   * 402+N fixtures — which fires inside the frame graph on the first PAPI
   * transition. That is not hypothetical: it was detonated during `7-12`'s lamp
   * measurement, and it killed the capture before the report was written, in a
   * way a harness reusing a stale artifact reads as a clean null result.
   *
   * Routing the fixtures through here instead makes the colour list a MAP over
   * the fixture list, so the lengths cannot disagree.
   *
   * These land between the static points and the PAPI lamps, and `papiOffset`
   * is taken from the array that actually precedes the lamps rather than from
   * `staticPoints` alone. Deriving it from the concatenation is what keeps the
   * PAPI writing its own colours: computed the old way it would be short by
   * `extraFixtures.length` and every indication change would repaint an
   * obstruction light instead — a corruption the existing length-only guard
   * cannot see, because the array stays exactly as long as it should be.
   */
  constructor(
    airport: Readonly<AirportDefinition>,
    extraFixtures: readonly LightPointFixture[] = [],
  ) {
    const staticPoints = airfieldLightPoints(airport);
    const beforePapi = [...staticPoints, ...extraFixtures];
    this.papiOffset = beforePapi.length;
    this.lamps = papiLamps(airport);
    const axis = runwayAxis(airport);
    const papiPhotometry = AIRFIELD_LAMP_PHOTOMETRY.papi;
    const papiPoints: LightPointFixture[] = this.lamps.map((lamp) => ({
      position: [lamp.placement.x, lamp.placement.y, lamp.placement.z] as const,
      // A PAPI is seen from the approach, which lies BEYOND the served end, so
      // the lamp faces outward along the axis toward that end.
      aim: [axis[0] * lamp.servedEnd, 0, axis[2] * lamp.servedEnd] as const,
      intensity: papiPhotometry.intensityCandela * AIRFIELD_LAMP_SCENE_SCALE,
      profileRow: 0,
      radiusMeters: papiPhotometry.radiusMeters,
      // Starts red; the first `update` call resolves it from the real camera.
      color: AIRFIELD_LAMP_RGB.red,
      beamCosineCutoff: AIRFIELD_LAMP_BEAM_COSINE,
    }));
    this.fixtures = [...beforePapi, ...papiPoints];
    this.colours = this.fixtures.map((fixture) => fixture.color);
    this.applied = this.lamps.map(() => "red");
  }

  /**
   * Resolve the PAPI indication for an observer and report whether it changed.
   *
   * ANALYTIC, and that is a requirement rather than a preference (D-3): the IES
   * texture carries 180 samples over 180 degrees — 1.0 deg/sample — against the
   * 0.1 deg the angular law is pinned to, ten times too coarse, and
   * interpolating across the step would render the transition as a 1 degree
   * ramp instead of an edge. Each unit is evaluated at its OWN elevation rather
   * than one shared angle, because the units are metres apart across the runway
   * and `papiElevationDegrees` is defined at the unit.
   *
   * Returns true only when an indication actually flipped, so the caller
   * re-uploads colours on a transition rather than every frame. The indication
   * is a step function of elevation, so there is nothing between the states to
   * interpolate and nothing is lost by not updating continuously.
   */
  update(cameraWorldX: number, cameraWorldY: number, cameraWorldZ: number): boolean {
    let changed = false;
    for (let index = 0; index < this.lamps.length; index += 1) {
      const { placement } = this.lamps[index]!;
      const elevation = papiElevationDegrees(
        placement,
        cameraWorldX,
        cameraWorldY,
        cameraWorldZ,
      );
      const indication: PapiIndication =
        elevation >= placement.settingDegrees ? "white" : "red";
      if (indication === this.applied[index]) continue;
      this.applied[index] = indication;
      this.colours[this.papiOffset + index] = AIRFIELD_LAMP_RGB[indication];
      changed = true;
    }
    return changed;
  }

  /** The colour of every light point, for `LightPointSystem.setColors`. */
  colourList(): readonly (readonly [number, number, number])[] {
    return this.colours;
  }

  /** The current indication per PAPI lamp, in `papiLamps` order. */
  indication(): readonly PapiIndication[] {
    return this.applied;
  }
}
