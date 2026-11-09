import { describe, expect, it } from "vitest";
import { CarSea } from "../src/sim/ground/carSea";
import { WaterSurfaceComposite } from "../src/sim/water/compositeWater";
import { HydrologyWaterSource } from "../src/sim/water/hydrologyWater";
import type { SeaWorld } from "../src/sim/water/seaState";
import { createSeaTwin } from "../src/sim/water/seaTwin";
import { referenceKernelMilliseconds, referenceSlowdown, warmReferenceKernel } from "./support/referenceKernel";
import { controls, environment, flat, payload, STEP, walker } from "./support/walkerRig";

/**
 * A swimmer's step in a car session's sea, the walker and the twin together:
 * about the twin's own 0.1 ms (W1 brief, "the walker's sea"), in the tuning
 * box's milliseconds (tests/support/referenceKernel.ts) scaled by how much
 * slower this process runs the reference kernel.
 *
 * In a file of its own, over the real `SeaTwin` alone, so CarSea's calls into
 * it stay monomorphic as in the worker (the counting twins of
 * tests/person.walker-sea.test.ts would make them polymorphic).
 */

const BUDGET_MS = 0.1;
const SEA_WORLD: SeaWorld & { readonly seaLevel: number } = Object.freeze({
  sourceSeedHash: 0x4f434541,
  prevailingWindRadians: 4.2243797,
  prevailingWindSpeed: 9.62323060631752,
  seaLevel: 0,
});

describe("walker in the car's sea, budget", () => {
  it(`swims a Cloudy sea in under ${BUDGET_MS * 1000} us a step, the twin included, on the tuning box`, () => {
    const ground = flat(-8);
    const bed = (x: number, z: number) => ground.height(x, z);
    const water = new WaterSurfaceComposite(new CarSea(createSeaTwin(SEA_WORLD, "cloudy"), 0), new HydrologyWaterSource(bed), 0);
    const env = environment(ground, { water });
    const subject = walker({ x: 0, y: -8, z: 0 }, 0, ground);
    // Crawling in a slow circle, so the twin's footprint keeps moving and turning.
    const input = controls({ moveX: 1, run: true });
    const person = input.person!;
    let time = 0;
    const step = (): void => {
      time += STEP;
      person.moveX = Math.cos(0.2 * time);
      person.moveZ = Math.sin(0.2 * time);
      water.setTime(subject.state.time);
      subject.setControls(input);
      subject.setEnvironment(env);
      subject.step(STEP);
    };
    for (let k = 0; k < 1_200; k += 1) step();
    expect(payload(subject).mode).toBe("swim");
    warmReferenceKernel();
    const runs: number[] = [];
    const kernel: number[] = [referenceKernelMilliseconds()];
    for (let lap = 0; lap < 3; lap += 1) {
      const start = performance.now();
      for (let k = 0; k < 2_400; k += 1) step();
      runs.push((performance.now() - start) / 2_400);
      kernel.push(referenceKernelMilliseconds());
    }
    expect(payload(subject).mode).toBe("swim");
    const best = Math.min(...runs);
    const slowdown = referenceSlowdown(kernel);
    expect(
      best,
      `${(best * 1000).toFixed(1)} us a step against ${(BUDGET_MS * slowdown * 1000).toFixed(1)} us `
      + `(this machine ran the reference kernel ${slowdown.toFixed(2)}x slower than the tuning box)`,
    ).toBeLessThan(BUDGET_MS * slowdown);
  });
});
