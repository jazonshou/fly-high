import { describe, expect, it } from "vitest";
import type { GroundVehicleSimulator } from "../src/sim/ground";
import { SPRUNG_CM_OFFSET } from "../src/sim/ground";
import { rotateVectorInto } from "../src/sim/math";
import { LANDCRUISER_76, type HullPart } from "../src/vehicles/landcruiser76";
import { car, drive, groundOf, rampAhead, speedOf, STEP } from "./support/carRig";

/**
 * The LandCruiser 76's chassis against its published numbers (land plan,
 * "Physics tests"): ride height and axle loads at rest, the approach and
 * departure angles out of the hull's geometry, the turning circle and the
 * tilt table.
 */

const CAR = LANDCRUISER_76;
const G = 9.80665;
const DEG = Math.PI / 180;

interface Point {
  x: number;
  y: number;
}

/** The car's hull probes in its side plane (x forward of the origin, y up from the ground), for a car at rest on flat ground. */
function sideProfile(sim: GroundVehicleSimulator, part: string): (Point & { radius: number })[] {
  const record: HullPart = CAR.hull.find((candidate) => candidate.name === part)!;
  const axle = record.axle === undefined ? -1 : record.axle === "front" ? 0 : 1;
  return record.probes.map((probe) => {
    // Axle parts ride on the axle centre: the wheel centres' midpoint.
    const body = axle < 0
      ? { x: probe.x, y: probe.y, z: probe.z }
      : {
        x: (axle === 0 ? CAR.geometry.frontAxleX : CAR.geometry.rearAxleX) + probe.x,
        y: CAR.geometry.wheelCentreY + sim.axleHeave[axle]! + probe.y,
        z: probe.z,
      };
    const world = rotateVectorInto({ x: 0, y: 0, z: 0 }, sim.state.orientation, body);
    return { x: body.x, y: sim.state.position.y + world.y, radius: probe.radius };
  });
}

/** A wheel centre's height above flat ground at rest, metres. */
function wheelCentreHeight(sim: GroundVehicleSimulator, axle: 0 | 1): number {
  const p = {
    x: axle === 0 ? CAR.geometry.frontAxleX : CAR.geometry.rearAxleX,
    y: CAR.geometry.wheelCentreY + sim.axleHeave[axle]!,
    z: 0,
  };
  return sim.state.position.y + rotateVectorInto({ x: 0, y: 0, z: 0 }, sim.state.orientation, p).y;
}

/**
 * SAE J1100's approach (or departure) angle: the steepest plane tangent to
 * the tyre's static loaded radius that passes under every probe ahead of
 * (behind) the axle. `direction` is +1 for the front, -1 for the rear.
 */
function rampAngle(
  centre: Point,
  radius: number,
  probes: readonly (Point & { radius: number })[],
  direction: 1 | -1,
): number {
  const clears = (angle: number): boolean => {
    // The plane's upward normal, leaning back from the slope it climbs.
    const nx = -direction * Math.sin(angle);
    const ny = Math.cos(angle);
    return probes.every((probe) => nx * (probe.x - centre.x) + ny * (probe.y - centre.y) + radius >= probe.radius);
  };
  let low = 0;
  let high = 80 * DEG;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (clears(mid)) low = mid;
    else high = mid;
  }
  return low / DEG;
}

function parkedOnFlat(): GroundVehicleSimulator {
  const sim = car();
  drive(sim, 5, { handbrake: 1 });
  return sim;
}

describe("LandCruiser chassis", () => {
  it("settles to ride height with the kerb weight split 52:48 within 2%", () => {
    const sim = parkedOnFlat();
    const loads = sim.wheelLoad;
    const total = loads[0]! + loads[1]! + loads[2]! + loads[3]!;
    const front = loads[0]! + loads[1]!;
    const rear = loads[2]! + loads[3]!;
    const weight = CAR.mass.kerb * G;
    expect(total).toBeGreaterThan(weight * 0.995);
    expect(total).toBeLessThan(weight * 1.005);
    expect(Math.abs(front - weight * CAR.mass.frontAxleShare)).toBeLessThan(0.02 * weight * CAR.mass.frontAxleShare);
    expect(Math.abs(rear - weight * (1 - CAR.mass.frontAxleShare))).toBeLessThan(0.02 * weight * (1 - CAR.mass.frontAxleShare));
    // Side to side within 1%, and the origin (the CG) at its 0.80 m height within 2 cm.
    expect(Math.abs(loads[0]! - loads[1]!)).toBeLessThan(0.01 * front);
    expect(Math.abs(loads[2]! - loads[3]!)).toBeLessThan(0.01 * rear);
    expect(Math.abs(sim.state.position.y - CAR.mass.cgHeight)).toBeLessThan(0.02);
    expect(Math.abs(sim.state.velocity.y)).toBeLessThan(1e-3);
    // The sprung mass's centre sits where the record says, just above and behind the car's origin.
    expect(SPRUNG_CM_OFFSET.y).toBeGreaterThan(0);
  });

  it("has the published 33 and 23 degree approach and departure angles in its hull geometry", () => {
    const sim = parkedOnFlat();
    const frontCentre = { x: CAR.geometry.frontAxleX, y: wheelCentreHeight(sim, 0) };
    const rearCentre = { x: CAR.geometry.rearAxleX, y: wheelCentreHeight(sim, 1) };
    const ahead = CAR.hull.flatMap((part) => sideProfile(sim, part.name)).filter((p) => p.x > frontCentre.x + 0.2);
    const behind = CAR.hull.flatMap((part) => sideProfile(sim, part.name)).filter((p) => p.x < rearCentre.x - 0.2);
    const approach = rampAngle(frontCentre, frontCentre.y, ahead, 1);
    const departure = rampAngle(rearCentre, rearCentre.y, behind, -1);
    expect(approach).toBeGreaterThan(CAR.body.approachAngle / DEG - 0.5);
    expect(approach).toBeLessThan(CAR.body.approachAngle / DEG + 0.5);
    expect(departure).toBeGreaterThan(CAR.body.departureAngle / DEG - 0.5);
    expect(departure).toBeLessThan(CAR.body.departureAngle / DEG + 0.5);
  });

  it("climbs onto ramps under its approach angle without the bumper touching, and touches on steeper ones", () => {
    const touches = (degrees: number, reverse: boolean): boolean => {
      // The ramp's toe 4 m ahead of (behind) the leading axle; 4L, at idle creep (walking pace) either way.
      const toe = 4 + (reverse ? -CAR.geometry.rearAxleX : CAR.geometry.frontAxleX);
      const sim = car({}, reverse ? rampBehind(toe, degrees) : rampAhead(toe, degrees));
      drive(sim, 1, { handbrake: 1 });
      drive(sim, 0.5, { handbrake: 1, rangePresses: 2 });
      expect(sim.transmission.range).toBe("4L");
      const parts = reverse ? ["rearBumper", "towBar"] : ["frontBumper"];
      let touched = false;
      const watch = (s: GroundVehicleSimulator) => {
        touched ||= parts.some((part) => s.touching(part));
      };
      if (reverse) {
        // A fresh S at a stop selects R (S is then the accelerator).
        drive(sim, 0.5, { brake: 1, rangePresses: 2 }, watch);
        expect(sim.transmission.gear).toBe(-1);
      } else {
        // A fresh W at a stop selects D.
        drive(sim, 0.1, { accelerator: 0.2, rangePresses: 2 }, watch);
        expect(sim.transmission.selector).toBe("D");
      }
      drive(sim, 12, { rangePresses: 2 }, watch);
      return touched;
    };
    // The published angles are static (SAE J1100, the test above). Rolling on, the tyre and springs squash as
    // the axle takes the ramp, so the car first touches at 31 degrees in front and 22 behind, 1 to 2 under
    // them; the band here is wide on purpose, and the hull is not tuned to it.
    expect(touches(29, false)).toBe(false);
    expect(touches(34, false)).toBe(true);
    expect(touches(20, true)).toBe(false);
    expect(touches(25, true)).toBe(true);
  });

  it("turns a 12.6 m kerb-to-kerb circle at full lock at walking pace", () => {
    const sim = car();
    drive(sim, 0.5, { handbrake: 1 });
    // W at a stop selects D; then idle creep with the wheel held at full right lock.
    drive(sim, 0.1, { accelerator: 0.2, steer: 1 });
    expect(sim.transmission.selector).toBe("D");
    drive(sim, 4, { steer: 1 });
    const points: { x: number; z: number }[] = [];
    const halfWidth = CAR.tyre.width / 2;
    drive(sim, 40, { steer: 1 }, (s) => {
      // The outer (front left) tyre's outer sidewall at the ground: its axle, turned with the wheel, points left.
      const angle = s.steering.left;
      const body = {
        x: CAR.geometry.frontAxleX + Math.sin(angle) * halfWidth,
        y: CAR.geometry.wheelCentreY - CAR.tyre.loadedRadius,
        z: -CAR.geometry.frontTrack / 2 - Math.cos(angle) * halfWidth,
      };
      const world = rotateVectorInto({ x: 0, y: 0, z: 0 }, s.state.orientation, body);
      points.push({ x: s.state.position.x + world.x, z: s.state.position.z + world.z });
    });
    expect(Math.abs(speedOf(sim))).toBeGreaterThan(0.5);
    expect(Math.abs(speedOf(sim))).toBeLessThan(2.5);
    let diameter = 0;
    for (let i = 0; i < points.length; i += 4) {
      for (let j = i + 1; j < points.length; j += 4) {
        diameter = Math.max(diameter, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.z - points[j]!.z));
      }
    }
    expect(diameter).toBeGreaterThan(CAR.steering.turningCircle - 0.3);
    expect(diameter).toBeLessThan(CAR.steering.turningCircle + 0.3);
  });

  it("tips on the tilt table at about 40 degrees, its static rollover angle", () => {
    // A table hinged under the right-hand (world -X) tyres, tilting the left side up at 0.5 degrees a second.
    const hinge = -CAR.geometry.frontTrack / 2;
    let grade = Math.tan(30 * DEG);
    const table = groundOf((out) => {
      const x = out.x;
      out.height = grade * (x - hinge);
      out.dhdx = grade;
      out.dhdz = 0;
    });
    const sim = car({}, table);
    drive(sim, 2, { handbrake: 1 });
    let tipped = Number.NaN;
    let angle = 30;
    const weight = CAR.mass.kerb * G;
    while (Number.isNaN(tipped) && angle < 50) {
      angle += 0.5 * STEP;
      grade = Math.tan(angle * DEG);
      drive(sim, STEP, { handbrake: 1 });
      // Tipped: the uphill (left) tyres carry almost nothing.
      if (sim.wheelLoad[0]! + sim.wheelLoad[2]! < 0.01 * weight) tipped = angle;
    }
    expect(tipped).toBeGreaterThan(38);
    expect(tipped).toBeLessThan(42);
  });
});

/** Flat to `toe` behind a car at heading 0 (along -Z), then a ramp rising backwards at `degrees`. */
function rampBehind(toe: number, degrees: number) {
  const grade = Math.tan(degrees * DEG);
  return groundOf((out) => {
    const z = out.z;
    const up = z < -toe;
    out.height = up ? grade * (-toe - z) : 0;
    out.dhdx = 0;
    out.dhdz = up ? -grade : 0;
  });
}
