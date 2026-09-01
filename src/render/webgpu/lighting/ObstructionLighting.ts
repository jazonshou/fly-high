/**
 * `7-14` obstruction lighting — the red lights that mark the tower as an
 * obstacle.
 *
 * **These are RED, and red obstruction lights have no intensity ladder.** The
 * day/twilight/night steps that ICAO Annex 14 specifies (20,000 / 2,000 / 2,000
 * cd for medium-intensity Type A, 200,000 / 20,000 / 2,000 for high-intensity)
 * belong to the WHITE lights. Red ones — low-intensity Type A/B and
 * medium-intensity Type B/C — are night-only and steady or flashing at ONE
 * intensity. So the day behaviour here is a switch, not a ladder, and it is
 * already supplied: `LightPointSystem.setDaylightAttenuation` is a single global
 * uniform driven by `airfieldLampDaylightAttenuation`, so these fixtures fade
 * out by day with no code of their own. Nothing in this file reads the clock.
 *
 * **What the height buys, and what it does not.** At 46.7 m the tower sits in
 * Annex 14's 45–150 m band, so the highest point takes a medium-intensity
 * light. Intermediate levels are only required as the obstacle climbs past
 * roughly 105 m, so the cab roof ring here is NOT an intermediate level in the
 * regulatory sense — it is extent marking, which is why it is low-intensity and
 * why treating it as a second beacon tier would be wrong.
 *
 * **On the depth-rejection warning at the top of `AirfieldLighting.ts`: it is
 * stale, and designing around it produces a worse fixture.** That header still
 * says "The lamps are not visible night or day" and "THE DEPTH TEST REJECTS
 * THEM, and that is measured". Both were withdrawn by `5621131`, which found
 * the 79→748 pixel measurement behind the depth claim was the TREE LINE, and
 * that "geometry, positions and rasterization were correct at both clocks the
 * whole time". The real cause was one constant, `AIRFIELD_LAMP_SCENE_SCALE`.
 * The offsets below are therefore sized as PHYSICAL mounting heights — a lamp
 * standing on a roof — and not inflated to defeat a depth test that was never
 * the mechanism.
 */
import type { LightPointFixture } from "./LightPoints";
import { AIRFIELD_LAMP_SCENE_SCALE } from "./AirfieldLighting";
import type { TowerAttachments } from "../detail/towerGeometry";
// The type comes from `world/types` and the function from `world/airport`,
// which is the split every sibling already uses (`AirfieldLighting.ts` imports
// the same type by the same path). `world/airport` declares `AirportDefinition`
// locally without exporting it, so importing it from there fails — that is a
// wrong import, not a boundary that needs widening or a narrower structural
// type invented to route around it.
import { runwayToWorld } from "../../../world/airport";
import type { AirportDefinition } from "../../../world/types";

/**
 * Aviation red, ICAO Annex 14 Appendix 1 chromaticity.
 *
 * Stated here rather than taken from `AIRFIELD_LAMP_RGB.red` so that a re-tune
 * of the airfield's warm palette cannot silently move an obstruction signal —
 * the two serve different jobs and should be free to diverge.
 *
 * **They are nearly IDENTICAL today, and that is the honest description.**
 * `[1, 0.09, 0.06]` against the airfield's `[1, 0.08, 0.06]`. Both are aviation
 * red; there is no second correct answer for what that looks like. The constant
 * exists to decouple, not because the colours differ, and a test asserting
 * merely "these two are not equal" would be reading a 0.01 gap as independence.
 *
 * **On the scotopic blow-out risk, which is real but is not new here.** The
 * night path normalises hue by `SCOTOPIC_WEIGHTS`, whose red term is 0.03, so a
 * red-dominant pixel has its red channel amplified by `r / dot(rgb, W)`.
 * MEASURED against the shipped table: white 1.55x, green 0.15x, **red 10.35x**,
 * and this constant **9.92x**. So the saturated-red case is already in the tree
 * and shipping — this fixture sits slightly BELOW it rather than introducing
 * it. Anything done about that belongs to the airfield red first, and to both
 * together; it is not a reason to detune obstruction lighting on its own.
 */
export const OBSTRUCTION_LIGHT_RGB: readonly [number, number, number] =
  Object.freeze([1.0, 0.09, 0.06] as const);

/**
 * Peak intensities, candela, before the scene scale.
 *
 * `top` is medium-intensity Type C (steady red, 2,000 cd), which is what a
 * 45–150 m obstacle takes at its highest point. `extent` is low-intensity
 * Type B (steady red, 32 cd), the marking grade — nearly two orders down,
 * because a cab roof ring burning at beacon intensity would read as eight
 * beacons rather than as the outline of one cab.
 */
export const OBSTRUCTION_LIGHT_CANDELA = Object.freeze({
  top: 2_000,
  extent: 32,
} as const);

/** Emitter radius, metres — a lamp head, not a runway inset fitting. */
const OBSTRUCTION_LIGHT_RADIUS_METERS = 0.18;

/**
 * How far a lamp stands proud of the surface it is bolted to, metres.
 *
 * A real obstruction light sits on a short stand so its own mount does not
 * shadow it toward the horizontal. These are mounting heights, not depth-test
 * fudge factors — see the header note on why that distinction matters.
 */
const OBSTRUCTION_MAST_TIP_RISE_METERS = 0.35;
const OBSTRUCTION_ROOF_STAND_METERS = 0.5;

/**
 * Fixtures for one tower.
 *
 * TWO TRAPS MEET HERE, and they fail in opposite directions, so getting one
 * right and the other wrong still lands the lights somewhere plausible.
 *
 * 1. ORDER. Attachments are `[across, y, along]` — the tower node's axis order.
 *    `runwayToWorld` takes `(airport, along, across)`. Passing an attachment
 *    straight through TRANSPOSES it, and because the runway is not axis-aligned
 *    the result is a finite coordinate somewhere else on the airfield rather
 *    than an obvious NaN.
 *
 * 2. DOUBLE COUNTING. `AirportSystem.towerAttachments` has ALREADY had the
 *    tower's own placement folded in (`AirportSystem.ts`, the `offset` helper),
 *    and its `y` is relative to the airport datum, not to the tower base. So
 *    the correct conversion adds NOTHING but `airport.elevation`. An API that
 *    also accepted the tower's across/along — which this one did until the
 *    offsetting was checked rather than assumed — applies the placement twice
 *    and puts the lights ~190 m off across the runway.
 *
 * Neither is visible to a test that asserts "N fixtures exist at finite
 * positions", which is why the conversion is one exported function with its own
 * test rather than three call sites doing arithmetic inline.
 */
export function obstructionFixtureWorldPosition(
  airport: Readonly<AirportDefinition>,
  local: readonly [number, number, number],
): readonly [number, number, number] {
  const [across, y, along] = local;
  const world = runwayToWorld(airport, along, across);
  return [world.x, airport.elevation + y, world.z] as const;
}

/**
 * Every obstruction light on the tower, top light first.
 *
 * Omnidirectional by construction: `beamCosineCutoff` is left unset, and
 * `lightPointBeamGain` returns 1 for the `<= -1` default at every angle. That
 * is required rather than convenient — an obstruction light exists to be seen
 * from any azimuth an aircraft can approach from, so a beam cutoff here would
 * be a defect that only shows up on the one heading nobody captured.
 */
export function towerObstructionFixtures(
  airport: Readonly<AirportDefinition>,
  attachments: TowerAttachments,
): readonly LightPointFixture[] {
  const place = (local: readonly [number, number, number]) =>
    obstructionFixtureWorldPosition(airport, local);

  const fixtures: LightPointFixture[] = [];

  const [mastAcross, mastY, mastAlong] = attachments.mastTip;
  fixtures.push({
    position: place([mastAcross, mastY + OBSTRUCTION_MAST_TIP_RISE_METERS, mastAlong]),
    // Straight up. The aim only feeds the IES lookup and the beam gain, and
    // this fixture is omnidirectional, so it is the honest value rather than a
    // load-bearing one.
    aim: [0, 1, 0] as const,
    intensity: OBSTRUCTION_LIGHT_CANDELA.top * AIRFIELD_LAMP_SCENE_SCALE,
    profileRow: 0,
    radiusMeters: OBSTRUCTION_LIGHT_RADIUS_METERS,
    color: OBSTRUCTION_LIGHT_RGB,
  });

  for (const point of attachments.cabRoofRing) {
    const [across, y, along] = point;
    fixtures.push({
      position: place([across, y + OBSTRUCTION_ROOF_STAND_METERS, along]),
      aim: [0, 1, 0] as const,
      intensity: OBSTRUCTION_LIGHT_CANDELA.extent * AIRFIELD_LAMP_SCENE_SCALE,
      profileRow: 0,
      radiusMeters: OBSTRUCTION_LIGHT_RADIUS_METERS,
      color: OBSTRUCTION_LIGHT_RGB,
    });
  }

  return fixtures;
}
