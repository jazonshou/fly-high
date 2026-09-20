import { describe, expect, it } from "vitest";
import { aircraftDefinition, AIRCRAFT_KINDS, createFlightState } from "../src/sim";
import { aircraftSpec } from "../src/aircraft/catalogue";

/**
 * A requested spawn airspeed must be the airspeed you get.
 *
 * `createFlightState` used to clamp every airborne spawn to a bare,
 * uncommented 180 m/s. Nothing reported it, so an aeroplane whose catalogue
 * asked for more simply started slow and bought the difference back by diving:
 * that, and not its aerodynamics, is why the Global 8000 had a notorious
 * downward phugoid on an airborne start, and why the explanation written into
 * its catalogue entry at the time — that less throttle made the dip worse —
 * described a real measurement of the wrong cause.
 *
 * This is the kind of bug that presents as one aeroplane handling badly and is
 * really a shared constant quietly overriding the catalogue, so it is pinned
 * per airframe rather than in general.
 */

const OLD_CLAMP = 180;

describe("spawn airspeed", () => {
  for (const kind of AIRCRAFT_KINDS) {
    it(`gives the ${kind} exactly the airspeed its catalogue asks for`, () => {
      const requested = aircraftSpec(kind).spawn.airborneAirspeed;
      const state = createFlightState(
        { position: { x: 0, y: 2_000, z: 0 }, heading: 0, pitch: 0, airspeed: requested },
        aircraftDefinition(kind),
      );
      const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
      expect(speed).toBeCloseTo(requested, 6);
    });
  }

  it("records which airframes the old 180 m/s clamp was and was not changing", () => {
    // Stated as data so the blast radius of lifting the clamp is written down
    // rather than reasoned about again later. Anything at or below 180 flew
    // identically before and after; anything above it was being cut short.
    const affected: string[] = [];
    const unaffected: string[] = [];
    for (const kind of AIRCRAFT_KINDS) {
      const requested = aircraftSpec(kind).spawn.airborneAirspeed;
      (requested > OLD_CLAMP ? affected : unaffected).push(kind);
    }

    // The Cessna spawns at 56 m/s and was never near the clamp, so lifting it
    // changes nothing about the aeroplane most players start in.
    expect(unaffected).toContain("trainer");
    expect(aircraftSpec("trainer").spawn.airborneAirspeed).toBeLessThan(OLD_CLAMP);

    // The Global was, and is the reason this was found at all.
    expect(affected).toContain("bizjet");
    expect(aircraftSpec("bizjet").spawn.airborneAirspeed).toBeGreaterThan(OLD_CLAMP);

    // Both fast aeroplanes ask for more than the old cap too.
    expect(affected).toContain("jet");
    expect(affected).toContain("airliner");
  });

  it("still refuses a nonsensical spawn airspeed", () => {
    // Lifting the clamp raised the ceiling to the solver's own translational
    // limit; it did not remove it. Infinity and negatives must not reach the
    // integrator.
    const trainer = aircraftDefinition("trainer");
    const base = { position: { x: 0, y: 2_000, z: 0 }, heading: 0, pitch: 0 };
    for (const airspeed of [Number.POSITIVE_INFINITY, Number.NaN, -40, 1e9]) {
      const state = createFlightState({ ...base, airspeed }, trainer);
      const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
      expect(Number.isFinite(speed), `${airspeed} produced ${speed}`).toBe(true);
      expect(speed).toBeGreaterThanOrEqual(0);
      expect(speed).toBeLessThanOrEqual(750);
    }
  });
});
