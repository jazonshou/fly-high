import { describe, expect, it } from "vitest";
import { aircraftDefinition, AIRCRAFT_KINDS, FlightSimulator } from "../src/sim";
import { createSimulationSpawn } from "../src/game/spawn";
import { createWorld, sampleWind } from "../src/world";
import { normalizeAirborneStartAgl } from "../src/workers/protocol";
import { sampleGroundHeight } from "../src/sim/terrainGrid";

/**
 * An airborne start must not fly the player into the ground.
 *
 * Every airborne spawn begins 2.4 degrees nose-up and off-trim, which excites
 * a phugoid. This test exists because the Global 8000's first swing was
 * DOWNWARD and 423 m deep out of a 183 m spawn, so choosing "start in the air"
 * in a 40-tonne jet flew it into the terrain about forty seconds later with
 * the pilot holding nothing.
 *
 * The cause turned out not to be aerodynamic. `createFlightState` clamped
 * every spawn airspeed to a bare, uncommented 180 m/s, so an aeroplane asking
 * for 210 started 30 m/s slow and bought the difference back by diving. With
 * the clamp lifted to the solver's own speed ceiling, all three jets dip 0 m
 * at any throttle.
 *
 * It is kept, and kept flying EVERY kind, because it is what caught that: the
 * bug presented as one aeroplane's bad handling and was really a shared
 * constant quietly overriding the catalogue. The next such override should
 * fail here too.
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
      //
      // `airborneStartAgl` is METRES — `protocol.ts` says so and the spawn
      // uses it as metres — so it needs no conversion. This multiplied by
      // 0.3048 as though it were feet, which quietly made the bar 3.3 times
      // more lenient than it reads: a 600 m spawn was being held to a 91 m
      // dip instead of a 300 m one.
      const marginMetres = requestedAgl;
      expect(lowest, `${kind} sank ${(-lowest).toFixed(0)} m from a ${marginMetres.toFixed(0)} m spawn`)
        .toBeGreaterThan(-marginMetres * 0.5);
    });
  }

  /*
   * The start height is a PLAYER SETTING running to 3,000 m, and the
   * catalogue stores one speed and one throttle. Uncorrected, the same
   * numbers that hold level at 450 m do not hold at all at 3,000: measured in
   * the app, the 747 sank 1,634 ft hands-off, the Global 1,518 and the F-16
   * 1,243.
   *
   * `createSimulationSpawn` now reads the catalogue figure as an EQUIVALENT
   * airspeed and converts: TAS = EAS / sqrt(sigma), and for a JET, throttle =
   * throttle0 / sigma, because jet thrust in this model lapses with density
   * and so thrust-required over thrust-available scales exactly that way.
   *
   * The propeller is deliberately NOT corrected — its thrust is power-limited
   * rather than density-limited — so the Cessna is expected to sink at the top
   * of the range, and does. That is a real aeroplane near its ceiling, not a
   * defect; it is asserted loosely here so it cannot become a dive unnoticed.
   *
   * Wind is passed, because the first version of this measurement did not and
   * reported that everything held level while the running game disagreed.
   */
  for (const kind of AIRCRAFT_KINDS) {
    it(`holds the ${kind} within its margin across the whole start-height range`, () => {
      const jet = aircraftDefinition(kind).propulsion === "jet";
      for (const requested of [450, 1500, 3000]) {
        const world = createWorld(`altitude-${requested}`);
        const agl = normalizeAirborneStartAgl(requested);
        const spawn = createSimulationSpawn(world, "airborne", agl, kind);
        const simulator = new FlightSimulator({ aircraft: aircraftDefinition(kind), spawn });
        const wind = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
        const start = simulator.state.position.y;
        let lowest = start;
        for (let step = 0; step < Math.round(180 / STEP); step += 1) {
          sampleWind(
            world,
            simulator.state.position.x,
            simulator.state.position.y,
            simulator.state.position.z,
            simulator.state.time,
            wind,
          );
          simulator.step(STEP, undefined, {
            wind: { x: wind.x, y: wind.y, z: wind.z },
            terrainHeight: (x, z) => sampleGroundHeight(world, x, z),
          });
          lowest = Math.min(lowest, simulator.state.position.y);
          expect(simulator.state.crashed, `${kind} crashed from ${requested} m`).toBe(false);
        }
        const drop = start - lowest;
        // A jet must not sink at all now; the Cessna may, but nowhere near the
        // half-the-spawn-height bar the tests above hold every airframe to.
        expect(drop, `${kind} sank ${drop.toFixed(0)} m from ${requested} m`)
          .toBeLessThan(jet ? 40 : agl * 0.2);
      }
    });
  }
});
