import { describe, expect, it } from "vitest";
import type { CarControlState } from "../src/game/types";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { describeSurface } from "../src/sim/ground/surface";
import type { GroundField } from "../src/sim/ground/terrainPatch";
import type { Vec3 } from "../src/sim/types";
import { CalmWaterSurface } from "../src/sim/water/calmWater";
import type { WaterSurfaceAuthority, WaterSurfaceSample } from "../src/sim/water/types";
import { controls, groundOf, headingOf, speedOf, STEP } from "./support/carRig";

/**
 * The car in water (land plan, "Physics tests"): wading, the intake,
 * buoyancy and the cabin flooding, and a river's current.
 */

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** A ford across the car's path: the bed falls to `depth` over z = 5..15, stays to 35 and rises again by 45. */
function fordBed(depth: number): (z: number) => number {
  return (z) => -depth * smoothstep(5, 15, z) * (1 - smoothstep(35, 45, z));
}

function fordGround(depth: number): GroundField {
  const bed = fordBed(depth);
  return groundOf((out) => {
    const z = out.z;
    out.height = bed(z);
    out.dhdx = 0;
    const e = 1e-4;
    out.dhdz = (bed(z + e) - bed(z - e)) / (2 * e);
  });
}

/** A river over the ford: still at height 0 wherever the bed is below it, flowing at `current`. */
class River implements WaterSurfaceAuthority {
  constructor(
    private readonly bed: (z: number) => number,
    private readonly current: Readonly<Vec3>,
  ) {}

  setTime(): void {}

  sample(_x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const bed = this.bed(z);
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    if (bed >= 0) {
      out.kind = "none";
      out.height = bed;
      out.stillHeight = bed;
      out.depth = 0;
      out.velocity.x = 0;
      out.velocity.y = 0;
      out.velocity.z = 0;
      return out;
    }
    out.kind = "river";
    out.height = 0;
    out.stillHeight = 0;
    out.depth = -bed;
    out.velocity.x = this.current.x;
    out.velocity.y = this.current.y;
    out.velocity.z = this.current.z;
    return out;
  }
}

/** Still or flowing water at height 0 everywhere: a lake or a wide river over a level bed. */
class Pool implements WaterSurfaceAuthority {
  constructor(private readonly depth: number, private readonly current = 0) {}

  setTime(): void {}

  sample(_x: number, _z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    out.kind = this.current === 0 ? "lake" : "river";
    out.height = 0;
    out.stillHeight = 0;
    out.depth = this.depth;
    out.velocity.x = this.current;
    out.velocity.y = 0;
    out.velocity.z = 0;
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    return out;
  }
}

/** The car on a gravel ford `depth` deep under a river flowing at `current`. */
function fordCar(depth: number, current: Readonly<Vec3> = { x: 0, y: 0, z: 0 }): GroundVehicleSimulator {
  const sim = new GroundVehicleSimulator(
    { position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false } },
    { ground: fordGround(depth), surface: (_at, out) => { describeSurface(SurfaceMaterial.Gravel, 0, out); } },
  );
  sim.setEnvironment({
    water: new River(fordBed(depth), current),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: (_x, z) => fordBed(depth)(z),
    world: null,
    colliders: null,
    gravity: 9.80665,
  });
  return sim;
}

function hold(sim: GroundVehicleSimulator, seconds: number, input: Partial<CarControlState>): void {
  controls(sim, input);
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) sim.step(STEP);
}

/**
 * In 4L at walking pace (1.4 m/s) straight across, as a driver fords: throttle
 * for the speed lost and more the longer the car is held back, and the wheel
 * against any yaw, so the heading stays square to the bank (heading 0).
 */
function wade(sim: GroundVehicleSimulator, seconds: number, each?: () => void): void {
  let lean = 0;
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
    const error = 1.4 - speedOf(sim);
    lean = Math.max(0, Math.min(1, lean + 0.15 * error * STEP));
    // Positive steer turns right, which lowers the heading: steer by the heading itself to bring it back to 0.
    const steer = Math.max(-1, Math.min(1, 3 * headingOf(sim)));
    controls(sim, { rangePresses: 2, steer, accelerator: Math.max(0, Math.min(1, 0.1 + 0.4 * error + lean)) });
    sim.step(STEP);
    each?.();
  }
}

/** Into 4L at the start. */
function lowRange(sim: GroundVehicleSimulator): void {
  hold(sim, 0.1, { handbrake: 1 });
  hold(sim, 1, { handbrake: 1, rangePresses: 2 });
}

const WEIGHT = 2_300 * 9.80665;

describe("car in water", () => {
  it("wades a 0.6 m ford at walking pace with the engine running, its tyres wet and out of sight", () => {
    const sim = fordCar(0.6);
    lowRange(sim);
    let deepest = 0;
    let submerged = 0;
    wade(sim, 50, () => {
      const state = sim.visualState();
      deepest = Math.max(deepest, state.wadingDepth);
      if (state.wadingDepth > 0.5) {
        submerged += 1;
        // A river, not the sea.
        expect(state.wadingSea).toBe(0);
        expect(state.wheelSurface).toEqual([-1, -1, -1, -1]);
        expect(state.wheelWetness).toEqual([1, 1, 1, 1]);
      }
    });
    expect(deepest).toBeGreaterThan(0.55);
    expect(deepest).toBeLessThan(0.65);
    expect(submerged).toBeGreaterThan(5 / STEP);
    expect(sim.engine.flooded).toBe(false);
    expect(sim.engine.running).toBe(true);
    // Out on the far bank, driving on.
    expect(sim.state.position.z).toBeGreaterThan(48);
    expect(sim.visualState().wheelSurface).toEqual([SurfaceMaterial.Gravel, SurfaceMaterial.Gravel, SurfaceMaterial.Gravel, SurfaceMaterial.Gravel]);
  });

  it("floods the intake in a 0.9 m ford: the engine stops and the car stays in the river", () => {
    const sim = fordCar(0.9);
    lowRange(sim);
    let floodedAt = Number.NaN;
    wade(sim, 50, () => {
      if (Number.isNaN(floodedAt) && sim.engine.flooded) floodedAt = sim.state.position.z;
    });
    expect(sim.engine.flooded).toBe(true);
    expect(sim.engine.running).toBe(false);
    expect(sim.visualState().flooded).toBe(true);
    // It drowned on the way down into the deep part, and went no further than the bed.
    expect(floodedAt).toBeGreaterThan(8);
    expect(floodedAt).toBeLessThan(20);
    expect(sim.state.position.z).toBeLessThan(35);
  });

  it("is pushed measurably downstream by a 1.5 m/s river 0.7 m deep", () => {
    function drift(current: number): number {
      const sim = fordCar(0.7, { x: current, y: 0, z: 0 });
      lowRange(sim);
      wade(sim, 50);
      expect(sim.state.position.z).toBeGreaterThan(48);
      return sim.state.position.x;
    }
    const still = drift(0);
    const flowing = drift(1.5);
    expect(Math.abs(still)).toBeLessThan(0.05);
    // Downstream is +x: held square to the bank, the car crabs about a metre over the 30 m crossing.
    expect(flowing).toBeGreaterThan(0.5);
  });

  it("floats in deep water until the cabin floods, then settles on the bed", () => {
    // The car parked on a bed 1.6 m under a still lake.
    const bed = (): number => -1.6;
    const sim = new GroundVehicleSimulator(
      { position: { x: 0, y: -1.6, z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false } },
      { ground: groundOf((out) => {
        out.height = -1.6;
        out.dhdx = 0;
        out.dhdz = 0;
      }) },
    );
    sim.setEnvironment({
      water: new Pool(1.6),
      wind: { x: 0, y: 0, z: 0 },
      bedHeight: bed,
      world: null,
      colliders: null,
      gravity: 9.80665,
    });
    const load = (): number => sim.wheelLoad.reduce((sum, value) => sum + value, 0);
    hold(sim, 5, {});
    // Afloat: the sealed body holds more than the car's weight of water out.
    expect(load()).toBeLessThan(0.05 * WEIGHT);
    expect(sim.state.position.y).toBeGreaterThan(-1.6 + 0.85);
    hold(sim, 85, {});
    // Flooded: down on its wheels, which carry most of its weight again.
    expect(sim.cabinFlood).toBeGreaterThan(0.6);
    expect(load()).toBeGreaterThan(0.5 * WEIGHT);
  });

  it("reads no sea bed of its own over ground a metre above the sea, and drives as a car that asks every time", () => {
    // A beach falling 2 cm a metre through sea level at z = 100; the car drives down it into a calm sea.
    const beach = (_x: number, z: number): number => 2 - 0.02 * z;
    let bedReads = 0;
    const counted = (x: number, z: number): number => {
      bedReads += 1;
      return beach(x, z);
    };
    const calm = new CalmWaterSurface(0, beach);
    // The same sea without `isDry`: every wheel's turn reads the bed.
    const asking: WaterSurfaceAuthority = { setTime: () => {}, sample: (x, z, out) => calm.sample(x, z, out) };
    // On the car's own lattice over the environment's bed, as in the worker.
    const cars = [new CalmWaterSurface(0, counted), asking].map((water) => {
      const sim = new GroundVehicleSimulator({
        position: { x: 0, y: beach(0, 0), z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false },
      });
      sim.setEnvironment({ water, wind: { x: 0, y: 0, z: 0 }, bedHeight: beach, world: null, colliders: null, gravity: 9.80665 });
      return sim;
    });
    let readsHigh = 0;
    for (let i = 0; i < Math.round(40 / STEP); i += 1) {
      for (const sim of cars) {
        const ashore = sim.state.position.z < 104;
        controls(sim, { accelerator: ashore ? 0.25 : 0, brake: ashore ? 0 : 1 });
        sim.step(STEP);
      }
      // The front tyres a metre over the sea until the body origin is past z = 48.
      if (cars[0]!.state.position.z < 45) readsHigh = bedReads;
    }
    const [lean, full] = cars as [GroundVehicleSimulator, GroundVehicleSimulator];
    expect(readsHigh).toBe(0);
    // Into the sea: the near shore read the bed, and the car is wading.
    expect(bedReads).toBeGreaterThan(0);
    expect(lean.state.position.z).toBeGreaterThan(104);
    expect(lean.visualState().wadingDepth).toBeGreaterThan(0.1);
    expect(lean.visualState().wadingSea).toBe(1);
    // Bit for bit the car that read every bed.
    for (const key of ["x", "y", "z"] as const) {
      expect(lean.state.position[key]).toBe(full.state.position[key]);
      expect(lean.state.velocity[key]).toBe(full.state.velocity[key]);
    }
  });
});
