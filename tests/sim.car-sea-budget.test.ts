import { describe, expect, it } from "vitest";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { CarSea, type CarSeaTwin } from "../src/sim/ground/carSea";
import { WaterSurfaceComposite } from "../src/sim/water/compositeWater";
import { HydrologyWaterSource } from "../src/sim/water/hydrologyWater";
import type { WaterSurfaceSample } from "../src/sim/water/types";
import { controls, STEP } from "./support/carRig";

/**
 * The car's step wading the sea allocates nothing but the two numbers of
 * each call into the water (land plan, "Budgets").
 *
 * In a file of its own: V8's type feedback is per function, so the sea
 * tests' other twins (the real SeaTwin, a counting subclass) would leave the
 * car's and CarSea's call sites polymorphic and boxing here, as they never
 * are in the worker, which builds one CarSea over one SeaTwin per session.
 * Measured on Node 24: alone, every run inside the budget; after the other
 * sea tests, about 800 B a step.
 */

/** The car on a level bed, as in the worker, wading `water`. */
function seaCar(bed: (x: number, z: number) => number, water: CarSea): GroundVehicleSimulator {
  const sim = new GroundVehicleSimulator({
    position: { x: 0, y: bed(0, 0), z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false },
  });
  sim.setEnvironment({
    water: new WaterSurfaceComposite(water, new HydrologyWaterSource(bed), 0),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: bed,
    world: null,
    colliders: null,
    gravity: 9.80665,
  });
  return sim;
}

/** One step as the worker takes it: the water's time first. */
function step(sim: GroundVehicleSimulator, water: CarSea): void {
  water.setTime(sim.state.time);
  sim.step(STEP);
}

describe("car in the sea, budget", () => {
  it("allocates nothing in the step while wading the sea but the two numbers of each call into the water", () => {
    // Parked on a level bed 0.2 m under a swell. The twin's own sums box some of their doubles
    // (about 150 B a step on this path), so the car and its sea are timed here over a single
    // allocation-free wave train in the twin's place.
    class Swell implements CarSeaTwin {
      samples = 0;
      private time = Number.NaN;
      setConfig(): void {}
      setTime(time: number): void {
        this.time = time;
      }
      setFocus(): void {}
      sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
        this.samples += 1;
        const phase = 0.1 * (x + z) - 1.2 * this.time;
        out.kind = "sea";
        out.height = 0.15 * Math.sin(phase);
        out.stillHeight = 0;
        out.depth = 30;
        out.velocity.x = 0;
        out.velocity.y = -0.18 * Math.cos(phase);
        out.velocity.z = 0;
        out.normal.x = 0;
        out.normal.y = 1;
        out.normal.z = 0;
        return out;
      }
    }
    const bed = (): number => -0.2;
    const twin = new Swell();
    const water = new CarSea(twin, 0);
    const sim = seaCar(bed, water);
    controls(sim, { handbrake: 1 });
    for (let k = 0; k < 600; k += 1) step(sim, water);
    expect(sim.visualState().wadingDepth).toBeGreaterThan(0.05);
    const run = (): { grown: number; allowed: number; steps: number; calls: number } => {
      const before = process.memoryUsage().heapUsed;
      const callsBefore = twin.samples;
      for (let k = 0; k < 20_000; k += 1) step(sim, water);
      const calls = twin.samples - callsBefore;
      return { grown: process.memoryUsage().heapUsed - before, allowed: 32 * 1024 + 32 * calls, steps: 20_000, calls };
    };
    const deadline = performance.now() + 30_000;
    let streak = 0;
    let last = { grown: Number.NaN, allowed: 0, steps: 0, calls: 0 };
    while (streak < 3 && performance.now() < deadline) {
      last = run();
      streak = last.grown >= 0 && last.grown < last.allowed ? streak + 1 : 0;
    }
    expect(streak, `last run grew the heap by ${last.grown} B of ${last.allowed}`).toBe(3);
    // One call a step into the water.
    expect(last.calls).toBe(last.steps);
  });
});
