import { describe, expect, it } from "vitest";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { describeSurface } from "../src/sim/ground/surface";
import type { WaterSurfaceAuthority, WaterSurfaceSample } from "../src/sim/water/types";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";
import { car, controls, drive, groundOf, headingOf, speedOf, STEP } from "./support/carRig";

/**
 * Recovery (land plan, "Recovery"): a ring of safe spots, one a second, four
 * wheels down, under 25 degrees off level and never in water; R puts the car
 * on the newest, upright and stopped, in the same drive.
 */

const DEG = Math.PI / 180;
const WEIGHT = LANDCRUISER_76.mass.kerb * 9.80665;

/** The body's up vector's world y: 1 level, 0 on its side. */
function upright(sim: GroundVehicleSimulator): number {
  const q = sim.state.orientation;
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}

function downOnFour(sim: GroundVehicleSimulator): boolean {
  return sim.wheelLoad.every((load) => load > 0.1 * (WEIGHT / 4));
}

/** A plane tilted about the z axis by `angle.degrees`, left side (world +X) up: the tilt table, which the test turns. */
function tiltTable(angle: { degrees: number }) {
  return groundOf((out) => {
    const grade = Math.tan(angle.degrees * DEG);
    out.height = grade * out.x;
    out.dhdx = grade;
    out.dhdz = 0;
  });
}

/** Level to z = 5, then a river bed falling to `depth` by z = 15: still water at height 0 over it. */
function bankBed(depth: number): (z: number) => number {
  return (z) => {
    const t = Math.max(0, Math.min(1, (z - 5) / 10));
    return -depth * t * t * (3 - 2 * t);
  };
}

class River implements WaterSurfaceAuthority {
  constructor(private readonly bed: (z: number) => number) {}

  setTime(): void {}

  sample(_x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const bed = this.bed(z);
    out.kind = bed < 0 ? "river" : "none";
    out.height = bed < 0 ? 0 : bed;
    out.stillHeight = 0;
    out.depth = Math.max(0, -bed);
    out.velocity.x = 0;
    out.velocity.y = 0;
    out.velocity.z = 0;
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    return out;
  }
}

function riverCar(depth: number): GroundVehicleSimulator {
  const bed = bankBed(depth);
  const sim = new GroundVehicleSimulator(
    { position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false } },
    {
      ground: groundOf((out) => {
        out.height = bed(out.z);
        out.dhdx = 0;
        out.dhdz = (bed(out.z + 1e-4) - bed(out.z - 1e-4)) / 2e-4;
      }),
      surface: (_at, out) => {
        describeSurface(SurfaceMaterial.Gravel, 0, out);
      },
    },
  );
  sim.setEnvironment({
    water: new River(bed),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: (_x, z) => bed(z),
    world: null,
    colliders: null,
    gravity: 9.80665,
  });
  return sim;
}

/** In D at `target` m/s straight ahead (heading 0), for `seconds`. */
function cruise(sim: GroundVehicleSimulator, target: number, seconds: number, extra: { rangePresses?: number } = {}): void {
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
    const error = target - speedOf(sim);
    const steer = Math.max(-1, Math.min(1, 3 * headingOf(sim)));
    controls(sim, { ...extra, steer, accelerator: Math.max(0, Math.min(1, 0.15 + 0.5 * error)) });
    sim.step(STEP);
  }
}

describe("car recovery", () => {
  it("keeps a spot a second once it has moved 3 m, and each R steps one spot further back", () => {
    const sim = car();
    drive(sim, 1.5, { handbrake: 1 });
    // The start, at rest.
    expect(sim.safeSpotsHeld).toBe(1);
    cruise(sim, 5, 8);
    const held = sim.safeSpotsHeld;
    // About one a second, 5 m apart.
    expect(held).toBeGreaterThanOrEqual(8);
    expect(held).toBeLessThanOrEqual(10);
    drive(sim, 4, { brake: 1 });
    const stoppedAt = sim.state.position.z;
    // Parked, it records its stop once (5 m on from the last spot) and then nothing more.
    drive(sim, 4, { brake: 1 });
    expect(sim.safeSpotsHeld).toBeLessThanOrEqual(held + 1);
    const parked = sim.safeSpotsHeld;

    sim.recover();
    drive(sim, 2, {});
    const first = sim.state.position.z;
    // The spot under it is passed over, for the one before: 3 to about 8 m back.
    expect(first).toBeLessThan(stoppedAt - 2);
    expect(first).toBeGreaterThan(stoppedAt - 12);
    expect(Math.abs(sim.state.position.x)).toBeLessThan(0.3);
    expect(Math.abs(speedOf(sim))).toBeLessThan(0.05);
    expect(upright(sim)).toBeGreaterThan(0.999);
    expect(downOnFour(sim)).toBe(true);
    expect(sim.transmission.selector).toBe("P");
    expect(sim.engine.running).toBe(true);

    sim.recover();
    drive(sim, 2, {});
    expect(sim.state.position.z).toBeLessThan(first - 2.9);
    expect(sim.safeSpotsHeld).toBeLessThan(parked);

    // Pressed and pressed again, it ends on the oldest spot, the start, and stays there.
    for (let i = 0; i < 2 * parked; i += 1) {
      sim.recover();
      drive(sim, 0.5, {});
    }
    expect(sim.safeSpotsHeld).toBe(1);
    expect(Math.abs(sim.state.position.z)).toBeLessThan(0.3);
    expect(Math.abs(headingOf(sim))).toBeLessThan(0.01);
  });

  it("keeps no spot steeper than 25 degrees off level", () => {
    const angle = { degrees: 20 };
    const sim = car({}, tiltTable(angle));
    drive(sim, 3, { brake: 1 });
    expect(upright(sim)).toBeGreaterThan(Math.cos(25 * DEG));
    expect(sim.safeSpotsHeld).toBe(1);

    angle.degrees = 30;
    const steep = car({}, tiltTable(angle));
    drive(steep, 3, { brake: 1 });
    expect(steep.wheelLoad.every((load) => load > 500)).toBe(true);
    expect(steep.safeSpotsHeld).toBe(0);
    // With no spot, R puts it upright where it lies, on the slope's own plane
    // (its tyres take up their side slip again, a few centimetres down the slope).
    const at = { ...steep.state.position };
    steep.recover();
    drive(steep, 2, { brake: 1 });
    expect(Math.abs(steep.state.position.x - at.x)).toBeLessThan(0.3);
    expect(Math.abs(steep.state.position.z - at.z)).toBeLessThan(0.1);
    expect(downOnFour(steep)).toBe(true);
  });

  it("rights a car the tilt table rolled, back on the spot it was level at", () => {
    const angle = { degrees: 0 };
    const sim = car({}, tiltTable(angle));
    drive(sim, 2, { handbrake: 1 });
    expect(sim.safeSpotsHeld).toBe(1);
    // Past its 40 degree rollover angle at 4 degrees a second: it goes over.
    for (let i = 0; i < 20 / STEP && !sim.rolled; i += 1) {
      angle.degrees = Math.min(70, angle.degrees + 4 * STEP);
      drive(sim, STEP, { handbrake: 1 });
    }
    drive(sim, 3, {});
    expect(sim.rolled).toBe(true);
    expect(upright(sim)).toBeLessThan(0.5);
    // Rolled, it keeps no spot.
    expect(sim.safeSpotsHeld).toBe(1);

    angle.degrees = 0;
    sim.recover();
    expect(sim.rolled).toBe(false);
    expect(sim.state.crashed).toBe(false);
    drive(sim, 2, {});
    expect(sim.rolled).toBe(false);
    expect(Math.abs(sim.state.position.x)).toBeLessThan(0.1);
    expect(Math.abs(sim.state.position.z)).toBeLessThan(0.1);
    expect(upright(sim)).toBeGreaterThan(0.999);
    expect(downOnFour(sim)).toBe(true);
    expect(Math.abs(speedOf(sim))).toBeLessThan(0.05);
  });

  it("brings a drowned car out of the river onto the bank it drove in from, engine running dry, still in 4L", () => {
    const sim = riverCar(1.2);
    drive(sim, 0.1, { handbrake: 1 });
    drive(sim, 1, { handbrake: 1, rangePresses: 2 });
    expect(sim.transmission.range).toBe("4L");
    cruise(sim, 1.4, 30, { rangePresses: 2 });
    expect(sim.engine.flooded).toBe(true);
    expect(sim.visualState().wadingDepth).toBeGreaterThan(0.5);

    sim.recover();
    drive(sim, 2, { rangePresses: 2 });
    const state = sim.visualState();
    // On the bank: every spot had all four tyres clear of the water, which starts at z = 5.
    expect(sim.state.position.z + LANDCRUISER_76.geometry.frontAxleX).toBeLessThan(5);
    expect(state.wadingDepth).toBe(0);
    expect(state.flooded).toBe(false);
    expect(sim.engine.running).toBe(true);
    expect(sim.cabinFlood).toBe(0);
    expect(state.range).toBe("4L");
    expect(Math.abs(headingOf(sim))).toBeLessThan(0.01);
    expect(downOnFour(sim)).toBe(true);

    // And it drives on: the accelerator at a stop takes it out of P into D, as at a start.
    const from = sim.state.position.z;
    cruise(sim, 1.4, 3, { rangePresses: 2 });
    expect(sim.state.position.z).toBeGreaterThan(from + 1);
  });
});
