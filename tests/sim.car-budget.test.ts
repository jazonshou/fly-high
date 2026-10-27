import { describe, expect, it } from "vitest";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { describeSurface } from "../src/sim/ground/surface";
import type { WaterSurfaceAuthority, WaterSurfaceSample } from "../src/sim/water/types";
import { referenceKernelMilliseconds, referenceSlowdown, warmReferenceKernel } from "./support/referenceKernel";
import { car, controls, groundOf, STEP } from "./support/carRig";

/**
 * The LandCruiser's step: bit-identical for identical inputs, free of
 * allocation, and inside the plan's 60 us at 120 Hz (land plan, "Budgets").
 *
 * The route is rolling ground (two crossed sine swells, up to about 12
 * degrees) driven in a slow weave with changes of pedal, gear range and
 * brake, so contact, the suspension, both tyre directions, the converter
 * and the shifts all do work. The budget is in the tuning box's
 * milliseconds (tests/support/referenceKernel.ts), scaled by how much slower
 * this process runs the reference kernel.
 */

const BUDGET_MS = 0.06;

const ROLLING = groundOf((out) => {
  const x = out.x;
  const z = out.z;
  const a = x / 23;
  const b = z / 31;
  const c = (x + z) / 11;
  out.height = 1.5 * Math.sin(a) * Math.cos(b) + 0.4 * Math.sin(c);
  out.dhdx = (1.5 / 23) * Math.cos(a) * Math.cos(b) + (0.4 / 11) * Math.cos(c);
  out.dhdz = (-1.5 / 31) * Math.sin(a) * Math.sin(b) + (0.4 / 11) * Math.cos(c);
});

/** The scripted driver for step `i`: a weave at changing pedals, a stop and a 4H stretch each minute. */
function script(sim: GroundVehicleSimulator, i: number): void {
  const t = i * STEP;
  const minute = t % 60;
  const braking = minute > 50 && minute < 54;
  controls(sim, {
    accelerator: braking ? 0 : 0.35 + 0.25 * Math.sin(t / 7),
    brake: braking ? 0.6 : 0,
    steer: 0.45 * Math.sin(t / 4.3),
    rangePresses: Math.floor(t / 60) % 2 === 1 && minute > 54 ? 1 : 0,
  });
}

function digest(sim: GroundVehicleSimulator): number[] {
  const s = sim.state;
  return [
    s.position.x, s.position.y, s.position.z,
    s.velocity.x, s.velocity.y, s.velocity.z,
    s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w,
    s.angularVelocity.x, s.angularVelocity.y, s.angularVelocity.z,
    ...sim.driveline.omega, sim.windup,
    ...sim.axleHeave, ...sim.axleRoll, ...sim.deflectionX, ...sim.deflectionY,
    sim.engine.boost, sim.transmission.lockup, sim.transmission.gear,
  ];
}

describe("LandCruiser step", () => {
  it("is bit-identical after ten minutes of identical inputs", () => {
    const run = () => {
      const sim = car({}, ROLLING);
      for (let i = 0; i < 600 * 120; i += 1) {
        script(sim, i);
        sim.step(STEP);
      }
      return { digest: digest(sim), crashed: sim.state.crashed, travelled: Math.hypot(sim.state.position.x, sim.state.position.z) };
    };
    const first = run();
    const second = run();
    expect(first.crashed).toBe(false);
    expect(first.travelled).toBeGreaterThan(50);
    expect(first.digest.every(Number.isFinite)).toBe(true);
    expect(second.digest.length).toBe(first.digest.length);
    for (let k = 0; k < first.digest.length; k += 1) expect(Object.is(second.digest[k], first.digest[k]), `state ${k}`).toBe(true);
  });

  it("allocates nothing in the step while wading", () => {
    // A wide river 0.5 m deep over a level bed, flowing across the car's path. The only water class
    // this file uses, so the car's call into it is monomorphic, as the worker's one authority is.
    class River implements WaterSurfaceAuthority {
      setTime(): void {}
      sample(_x: number, _z: number, out: WaterSurfaceSample): WaterSurfaceSample {
        out.kind = "river";
        out.height = 0;
        out.stillHeight = 0;
        out.depth = 0.5;
        out.velocity.x = 0.8;
        out.velocity.y = 0;
        out.velocity.z = 0;
        return out;
      }
    }
    const sim = new GroundVehicleSimulator(
      { position: { x: 0, y: -0.5, z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false } },
      {
        ground: groundOf((out) => {
          out.height = -0.5;
          out.dhdx = 0;
          out.dhdz = 0;
        }),
        surface: (_at, out) => { describeSurface(SurfaceMaterial.Grass, 0, out); },
      },
    );
    sim.setEnvironment({ water: new River(), wind: { x: 0, y: 0, z: 0 }, bedHeight: () => -0.5, world: null, colliders: null, gravity: 9.80665 });
    controls(sim, { handbrake: 1 });
    for (let i = 0; i < 240; i += 1) sim.step(STEP);
    controls(sim, { rangePresses: 2, accelerator: 0.15, steer: 0.1 });
    for (let i = 0; i < 2_400; i += 1) sim.step(STEP);
    expect(sim.visualState().wadingDepth).toBeGreaterThan(0.45);
    const run = (): number => {
      const before = process.memoryUsage().heapUsed;
      for (let k = 0; k < 20_000; k += 1) sim.step(STEP);
      return process.memoryUsage().heapUsed - before;
    };
    const deadline = performance.now() + 20_000;
    let streak = 0;
    let last = Number.NaN;
    while (streak < 3 && performance.now() < deadline) {
      last = run();
      streak = last >= 0 && last < 32 * 1024 ? streak + 1 : 0;
    }
    expect(streak, `last run grew the heap by ${last} B`).toBe(3);
    expect(sim.engine.running).toBe(true);
  });

  it("allocates nothing in the step", () => {
    const sim = car({}, ROLLING);
    let i = 0;
    for (; i < 2_400; i += 1) {
      script(sim, i);
      sim.step(STEP);
    }
    // The script's setControls builds an object per call, so set the controls once and run the step alone.
    const steps = 20_000;
    const run = (): number => {
      script(sim, i);
      const before = process.memoryUsage().heapUsed;
      for (let k = 0; k < steps; k += 1) sim.step(STEP);
      i += steps;
      return process.memoryUsage().heapUsed - before;
    };
    // As in the volcanic steam test: until the optimised code shows, boxed doubles grow the heap a
    // little; clean is under 32 KB a run (1.6 B a step) three runs in a row, which one 12-byte object a
    // step (240 KB a run) cannot pass.
    const clean = (grown: number): boolean => grown >= 0 && grown < 32 * 1024;
    const deadline = performance.now() + 20_000;
    let streak = 0;
    let last = Number.NaN;
    while (streak < 3 && performance.now() < deadline) {
      last = run();
      streak = clean(last) ? streak + 1 : 0;
    }
    expect(streak, `last run grew the heap by ${last} B`).toBe(3);
  });

  it(`steps in under ${BUDGET_MS * 1000} us on rolling ground, on the tuning box`, () => {
    const sim = car({}, ROLLING);
    let i = 0;
    for (; i < 2_400; i += 1) {
      script(sim, i);
      sim.step(STEP);
    }
    warmReferenceKernel();
    const batches: number[] = [];
    const kernel: number[] = [referenceKernelMilliseconds()];
    for (let k = 0; k < 10; k += 1) {
      script(sim, i);
      const start = performance.now();
      for (let s = 0; s < 240; s += 1) sim.step(STEP);
      batches.push((performance.now() - start) / 240);
      i += 240;
      kernel.push(referenceKernelMilliseconds());
    }
    const step = Math.min(...batches);
    const slowdown = referenceSlowdown(kernel);
    expect(
      step,
      `${(step * 1000).toFixed(1)} us a step against ${(BUDGET_MS * slowdown * 1000).toFixed(1)} us `
      + `(this machine ran the reference kernel ${slowdown.toFixed(2)}x slower than the tuning box)`,
    ).toBeLessThan(BUDGET_MS * slowdown);
  });
});
