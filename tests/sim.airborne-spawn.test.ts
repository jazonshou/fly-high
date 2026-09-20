import { describe, expect, it } from "vitest";
import { aircraftDefinition, AIRCRAFT_KINDS, FlightSimulator } from "../src/sim";
import { createSimulationSpawn } from "../src/game/spawn";
import { createWorld } from "../src/world";
import { normalizeAirborneStartAgl } from "../src/workers/protocol";

/**
 * An airborne start must not fly the player into the ground.
 *
 * Every airborne spawn in this game begins 2.4 degrees nose-up and off-trim,
 * which excites a phugoid. On the two small aeroplanes the first swing is
 * upward and nobody notices. The Global 8000's first swing was DOWNWARD and
 * 423 m deep, out of a spawn 183 m above the ground — so choosing "start in
 * the air" in a 40-tonne jet flew it into the terrain roughly forty seconds
 * later, with the pilot holding nothing.
 *
 * It is a per-airframe trap and the next aeroplane will meet it too, so this
 * flies every kind rather than the one that had the bug. The counter-intuitive
 * part, and the reason this is pinned rather than reasoned about: LESS
 * throttle makes the dip deeper, not shallower. Trimming for level flight is
 * the wrong instinct here; the aeroplane has to be given enough energy to
 * carry it through the first trough.
 */

const STEP = 1 / 120;

describe("airborne spawns", () => {
  for (const kind of AIRCRAFT_KINDS) {
    it(`does not fly the ${kind} into the ground unattended`, () => {
      const world = createWorld("open-skies");
      const requestedAgl = normalizeAirborneStartAgl(600);
      const spawn = createSimulationSpawn(world, "airborne", requestedAgl, kind);
      const simulator = new FlightSimulator({ aircraft: aircraftDefinition(kind), spawn });
      const start = simulator.state.position.y;

      // Three minutes, hands off. Long enough for the first full phugoid on
      // every airframe here — the Global's period is around ninety seconds.
      let lowest = 0;
      for (let step = 0; step < Math.round(180 / STEP); step += 1) {
        simulator.step(STEP);
        lowest = Math.min(lowest, simulator.state.position.y - start);
        expect(simulator.state.crashed, `${kind} crashed at ${(step * STEP).toFixed(0)} s`)
          .toBe(false);
      }

      // The spawn is expressed as wheel clearance, so the usable margin is
      // roughly that height. Half of it is the bar: deeper than that and a
      // pilot who picked a lower start height, or a hill under the flight
      // path, arrives at the ground.
      const marginMetres = requestedAgl * 0.3048;
      expect(lowest, `${kind} sank ${(-lowest).toFixed(0)} m from a ${marginMetres.toFixed(0)} m spawn`)
        .toBeGreaterThan(-marginMetres * 0.5);
    });
  }
});
