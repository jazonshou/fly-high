import { describe, expect, it } from "vitest";
import {
  aircraftDefinition,
  FlightSimulator,
  quaternionFromFlightAngles,
  AIRCRAFT_KINDS,
  type AircraftDefinition,
  type AircraftKind,
} from "../src/sim";

/**
 * A wing-low landing must strike the wingtip, and must strike it at the height
 * the wingtip is actually drawn at.
 *
 * This exists because the two were not connected. `airframeContactPoints`
 * carried the wingtips at y = 0.2 while `trainerVisual` built the wing at
 * y = 0.28, so the simulator was testing a point 8 cm below the metal — small,
 * but it meant nothing in the codebase checked the correspondence at all, and
 * the Cessna 150's reshape moved both. The geometric assertions below are
 * about the DEFINITION and are what keep a future airframe honest; the flown
 * case is what proves the definition is wired to anything.
 *
 * The bank angle needed to touch a wingtip before a wheel is a property of the
 * aeroplane worth knowing on its own — it is why a low-wing jet with a narrow
 * track is a harder crosswind landing than a high-wing trainer.
 */

/** The outermost contact point on each side, which is what strikes first. */
function wingtipContact(aircraft: AircraftDefinition) {
  let outermost = aircraft.airframeContactPoints[0]!;
  for (const point of aircraft.airframeContactPoints) {
    if (Math.abs(point.z) > Math.abs(outermost.z)) outermost = point;
  }
  return outermost;
}

/** The lowest wheel, which is what the aeroplane normally rests on. */
function lowestGear(aircraft: AircraftDefinition) {
  let lowest = aircraft.gear[0]!;
  for (const gear of aircraft.gear) {
    if (gear.position.y < lowest.position.y) lowest = gear;
  }
  return lowest;
}

describe("wingtip strikes", () => {
  for (const kind of AIRCRAFT_KINDS) {
    describe(kind, () => {
      const aircraft = aircraftDefinition(kind);

      it("carries a contact point at each wingtip, mirrored, out near the span", () => {
        const tip = wingtipContact(aircraft);
        const semiSpan = aircraft.wingSpan / 2;
        // Within a metre of the tip: closer in and a wing-low landing would
        // drag metal the simulator never notices. Slightly OUTSIDE the nominal
        // semi-span is allowed and correct — a wingtip fairing, a winglet or a
        // navigation light all sit proud of the aerodynamic span, and they are
        // what touches first.
        expect(Math.abs(tip.z)).toBeGreaterThan(semiSpan - 1);
        expect(Math.abs(tip.z)).toBeLessThan(semiSpan + 0.5);
        const mirrored = aircraft.airframeContactPoints.find(
          (point) => Math.abs(point.z + tip.z) < 1e-6 && Math.abs(point.y - tip.y) < 1e-6,
        );
        expect(mirrored, `${aircraft.name} has an unmirrored wingtip contact`).toBeDefined();
      });

      it("puts the wingtip above the wheels, so it is not what lands", () => {
        const tip = wingtipContact(aircraft);
        expect(tip.y).toBeGreaterThan(lowestGear(aircraft).position.y);
      });

      it("would touch a wingtip before a wheel past a sane bank angle", () => {
        const tip = wingtipContact(aircraft);
        const gear = lowestGear(aircraft);
        // tan(bank) = (tipY - gearY) / |tipZ| is the bank at which the wingtip
        // reaches the wheels' contact height. Below it the aeroplane lands on
        // its wheels; past it the wing arrives first.
        const criticalBank = Math.atan((tip.y - gear.position.y) / Math.abs(tip.z));
        const degrees = (criticalBank * 180) / Math.PI;
        // A real light aircraft is somewhere near 15-20 degrees and a big
        // low-wing jet nearer 10. Outside 5-35 the geometry is wrong, not
        // merely unusual: under 5 the aeroplane could not be landed at all,
        // over 35 the wing is implausibly high above its own wheels.
        expect(degrees).toBeGreaterThan(5);
        expect(degrees).toBeLessThan(35);
      });

      it("cannot be set down steeply banked, and can be set down level", () => {
        // Flown rather than computed, because the point is that the SIMULATOR
        // agrees with the geometry above and not merely that the numbers are
        // consistent with each other.
        //
        // Fifty degrees, not "just past critical". Measured: a wingtip that
        // touches a little past the critical angle does not end the landing —
        // the aeroplane scuffs, rolls level and settles on its wheels, which
        // is both realistic and not what this is pinning. The trainer's
        // critical angle is 16.3 degrees and it still survives 30. At 50 all
        // three go over, and the mirrored arm goes over identically, which is
        // the thing an unmirrored contact point would break.
        const ground = 0;

        const setDown = (bankRadians: number) => {
          const simulator = new FlightSimulator({
            aircraft,
            spawn: {
              position: { x: 0, y: ground + 4, z: 0 },
              heading: 0,
              pitch: 0,
              // Slow: this is a contact-geometry test, and a fast arrival
              // crashes on impact speed whatever the wings are doing.
              airspeed: 1,
              controls: {
                throttle: 0,
                pitch: 0,
                roll: 0,
                yaw: 0,
                trim: 0,
                flaps: 0,
                brake: 1,
                gear: 1,
              },
            },
            environment: {
              terrain: { height: ground, normal: { x: 0, y: 1, z: 0 } },
              terrainHeight: () => ground,
            },
          });
          simulator.state.orientation = quaternionFromFlightAngles(0, 0, bankRadians);
          for (let step = 0; step < 900; step += 1) {
            simulator.step(1 / 120, { throttle: 0, gear: 1, brake: 1 });
            if (simulator.state.crashed) return true;
          }
          return false;
        };

        const steep = (50 * Math.PI) / 180;
        expect(setDown(steep)).toBe(true);
        expect(setDown(-steep)).toBe(true);
        // Wings level it settles on its wheels.
        expect(setDown(0)).toBe(false);
      });
    });
  }

  it("agrees with the height the trainer's wing is drawn at", () => {
    // The one hard-coded number in this file, and deliberately so: it is the
    // correspondence that was silently wrong. `trainerVisual` builds the wing
    // chord plane at y = 0.28 and the wingtip contact points must sit on it.
    // If the mesh moves, this fails and someone has to look at both.
    const tip = wingtipContact(aircraftDefinition("trainer" as AircraftKind));
    expect(tip.y).toBeCloseTo(0.28, 6);
  });
});
