import { describe, expect, it } from "vitest";
import {
  aftExtent,
  aircraftDefinition,
  AIRCRAFT_KINDS,
  FlightSimulator,
  stallSpeed,
} from "../src/sim";
import { createSimulationSpawn, runwayFlapsForAircraft, runwayTrimForAircraft } from "../src/game/spawn";
import { createWorld, isPointOnRunway, worldToRunway } from "../src/world";
import { sampleGroundHeight } from "../src/sim/terrainGrid";

/**
 * "Start on the runway" has to put every aeroplane somewhere a pilot would
 * accept: on the centreline, nose-wheel included, wheels on the surface rather
 * than sunk into it or hovering, stopped and staying stopped, and with enough
 * tarmac left in front to get airborne.
 *
 * This is geometry and it is deterministic, so it is measured rather than
 * photographed. The screenshots answer a different question — whether the
 * chase camera ends up inside the hangar line — which pixels are the only
 * honest instrument for.
 *
 * The one convenience worth stating plainly: the aeroplane spawns aligned with
 * the runway, so its body frame and the runway frame coincide. A body offset
 * of (x, y, z) therefore lands at along + x, across + z with no rotation, and
 * the nose-gear check below relies on that rather than re-deriving a yaw.
 */

const STEP = 1 / 120;
const SEED = "runway-spawn";

/*
 * `stallSpeed` and `aftExtent` are imported rather than reimplemented here.
 * Writing `aircraft.stallSpeed` — a field that does not exist — yields
 * undefined, makes every comparison against it false, and produces a rotation
 * that never happens, which reads as an aeroplane that cannot climb rather
 * than as a typo. That is how the first draft of this test "proved" a Cessna
 * 150 needs 1,438 m of runway.
 */

describe("runway spawns", () => {
  const world = createWorld(SEED);
  const airport = world.airport;

  it("has an airport to start from", () => {
    expect(airport).not.toBeNull();
  });

  for (const kind of AIRCRAFT_KINDS) {
    const aircraft = aircraftDefinition(kind);

    it(`puts the ${kind} on the centreline with its nose wheel`, () => {
      if (!airport) throw new Error("no airport");
      const spawn = createSimulationSpawn(world, "runway", 600, kind);
      const { x, z } = spawn.position as { x: number; z: number };
      const cg = worldToRunway(airport, x, z);
      const halfWidth = airport.runwayWidth * 0.5;

      expect(Math.abs(cg.across)).toBeLessThan(0.01);
      expect(isPointOnRunway(airport, x, z, 0)).toBe(true);

      // Every wheel, not just the CG. The nose wheel is the one that sits
      // metres ahead of the spawn point, and on a swept-back main gear it is
      // the wheel most likely to hang off the far end or off the edge.
      for (const leg of aircraft.gear) {
        const along = cg.along + leg.position.x;
        const across = cg.across + leg.position.z;
        expect(Math.abs(across), `${kind} wheel ${across.toFixed(2)} m off centre`)
          .toBeLessThan(halfWidth - 1);
        expect(Math.abs(along), `${kind} wheel ${along.toFixed(0)} m along`)
          .toBeLessThan(airport.runwayLength * 0.5);
      }

      // The tail is the reason the line-up point is per-airframe at all, so it
      // is asserted directly: behind the threshold and it is over the grass.
      const tail = cg.along - aftExtent(aircraft);
      const threshold = -airport.runwayLength * 0.5;
      expect(tail, `${kind} tail ${(tail - threshold).toFixed(1)} m past the threshold`)
        .toBeGreaterThan(threshold);
      // ...and not so far forward that runway is being given away. The old
      // fixed 36% line-up wasted 185 m; anything over 30 m here is drifting
      // back towards that.
      expect(tail - threshold).toBeLessThan(30);
    });

    it(`rests the ${kind} on the graded surface, not in it or above it`, () => {
      if (!airport) throw new Error("no airport");
      const spawn = createSimulationSpawn(world, "runway", 600, kind);
      const { x, z } = spawn.position as { x: number; z: number };

      // The platform the spawn trusts is the platform the terrain generates:
      // if airport grading ever stops reaching the spawn point, this fails
      // here rather than as an aeroplane half-buried in a screenshot.
      expect(sampleGroundHeight(world, x, z)).toBeCloseTo(airport.elevation, 1);

      const simulator = new FlightSimulator({ aircraft, spawn });
      const environment = {
        terrain: { height: airport.elevation },
        terrainHeight: () => airport.elevation,
      };
      simulator.step(STEP, undefined, environment);

      expect(simulator.state.onGround).toBe(true);
      expect(simulator.state.crashed).toBe(false);
      // Suspension compresses under weight, so AGL is measured at the tyre and
      // wants to be a few centimetres at most, in either direction.
      expect(Math.abs(simulator.telemetry().altitudeAgl)).toBeLessThan(0.25);
    });

    it(`leaves the ${kind} stopped with take-off trim and flaps`, () => {
      if (!airport) throw new Error("no airport");
      const spawn = createSimulationSpawn(world, "runway", 600, kind);
      const { x, z } = spawn.position as { x: number; z: number };
      const simulator = new FlightSimulator({ aircraft, spawn });
      const environment = {
        terrain: { height: airport.elevation },
        terrainHeight: () => airport.elevation,
      };

      expect(spawn.controls?.throttle).toBe(0);
      expect(spawn.controls?.gear).toBe(1);
      expect(spawn.controls?.trim).toBe(runwayTrimForAircraft(kind));
      expect(spawn.airspeed).toBe(0);

      // Thirty seconds with nobody touching anything. An idling jet still
      // makes residual thrust, so "stopped" has to be proven, not assumed:
      // a Global that creeps half a metre a second leaves the threshold
      // before the player has finished reading the HUD.
      for (let step = 0; step < Math.round(30 / STEP); step += 1) {
        simulator.step(STEP, undefined, environment);
      }
      const moved = Math.hypot(
        simulator.state.position.x - x,
        simulator.state.position.z - z,
      );
      expect(simulator.telemetry().groundSpeed, `${kind} crept`).toBeLessThan(0.5);
      expect(moved, `${kind} rolled ${moved.toFixed(1)} m unattended`).toBeLessThan(1);
      expect(simulator.state.crashed).toBe(false);
    });

    it(`gets the ${kind} airborne before the far end of the runway`, () => {
      if (!airport) throw new Error("no airport");
      const spawn = createSimulationSpawn(world, "runway", 600, kind);
      const { x, z } = spawn.position as { x: number; z: number };
      const start = worldToRunway(airport, x, z);
      const available = airport.runwayLength * 0.5 - start.along;
      const simulator = new FlightSimulator({ aircraft, spawn });
      const environment = {
        terrain: { height: airport.elevation },
        terrainHeight: () => airport.elevation,
      };
      const controls = {
        throttle: 1,
        flaps: runwayFlapsForAircraft(kind),
        trim: runwayTrimForAircraft(kind),
      };

      // Flown the way a take-off actually goes: full power, rotate at 1.1x the
      // flaps-down stall speed and hold a firm but not full back-stick. The
      // technique matters more than it looks — a lazy 0.35 pull lets the
      // Global accelerate 130 kt past its rotation speed and eats 1,273 m,
      // while this one has it climbing through 5 m at 1,008 m.
      // Vr from the stall speed AT THE FLAP SETTING BEING FLOWN. Taking it from
      // a different configuration - full-flap stall while rolling at flaps 0.5
      // - understates Vr and flatters the distance.
      const rotateSpeed = stallSpeed(aircraft, controls.flaps) * 1.1;
      let rolled = 0;
      let airborne = false;
      for (let step = 0; step < Math.round(120 / STEP) && !airborne; step += 1) {
        const speed = simulator.telemetry().indicatedAirspeed;
        simulator.step(STEP, {
          ...controls,
          pitch: speed > rotateSpeed ? 0.7 : 0,
        }, environment);
        const here = worldToRunway(
          airport,
          simulator.state.position.x,
          simulator.state.position.z,
        );
        rolled = here.along - start.along;
        airborne = !simulator.state.onGround && simulator.telemetry().altitudeAgl > 5;
        expect(simulator.state.crashed, `${kind} crashed on the take-off roll`).toBe(false);
      }

      expect(airborne, `${kind} never got airborne`).toBe(true);
      expect(rolled, `${kind} used ${rolled.toFixed(0)} m of ${available.toFixed(0)} m`)
        .toBeLessThan(available);
      // Printed because the margin is the interesting part, and the next
      // airframe added to the game will want to see it shrink.
      console.log(
        `${kind}: 5 m AGL at ${rolled.toFixed(0)} m of ${available.toFixed(0)} m available `
        + `(${((1 - rolled / available) * 100).toFixed(0)}% spare)`,
      );
    });
  }
});
