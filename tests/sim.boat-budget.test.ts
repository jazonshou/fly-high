import { describe, expect, it } from "vitest";
import { BoatSimulator, KNOT } from "../src/sim/boat";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";
import { createSeaTwin } from "../src/sim/water/seaTwin";
import type { HullWaterSampler, WaterSurfaceSample, WaveFieldFocus } from "../src/sim/water/types";
import { referenceKernelMilliseconds, referenceSlowdown, warmReferenceKernel } from "./support/referenceKernel";

/**
 * What one 120 Hz boat step costs in Node, on the game's own sea: the
 * Runabout 21 at cruise on the sea twin under the default (breezy) weather.
 *
 * Per step the hull asks the water for 171 points (145 hull-mesh vertices
 * for the hydrostatics, 20 keel strips, and the propeller hub, gearcase,
 * two tabs, transom and CG), focuses the sampler once, and never reads the
 * depth under it. The two 240 Hz substeps reuse those samples.
 *
 * The budget is in the tuning box's milliseconds (tests/support/
 * referenceKernel.ts) and scales by how much slower this process runs the
 * reference kernel. There a step costs about 0.24 ms, 1.8 to 2.1 kernels
 * idle or with three other suites running, so 0.3 ms (2.5 kernels) leaves
 * the margin a busy runner needs and still catches the 3.2 ms step the
 * fitted wave focus replaced.
 */

const STEP = 1 / 120;
const BUDGET_MS = 0.3;

class CountingSampler implements HullWaterSampler {
  samples = 0;
  focuses = 0;
  times = 0;

  constructor(private readonly inner: HullWaterSampler) {}

  setTime(time: number): void {
    this.times += 1;
    this.inner.setTime(time);
  }

  setFocus(focus: Readonly<WaveFieldFocus>): void {
    this.focuses += 1;
    this.inner.setFocus(focus);
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    this.samples += 1;
    return this.inner.sample(x, z, out);
  }
}

/** 30 kn in Scenic (the game's default assist), straight across the breezy sea. */
function cruising(water: HullWaterSampler): BoatSimulator {
  const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, speed: 30 * KNOT, gear: "forward", rpm: 4_400 });
  boat.setEnvironment({ water, wind: { x: 0, y: 0, z: 0 }, bedHeight: () => -100, gravity: 9.80665 });
  boat.setControls({ assist: "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS, lever: 0.75 } });
  return boat;
}

const twin = () =>
  createSeaTwin({ sourceSeedHash: 0x4f434541, prevailingWindRadians: 4.2243797, prevailingWindSpeed: 9.62323060631752, seaLevel: 0 }, "breezy");

describe("boat step budget", () => {
  it("samples the water at 171 points once a step, with one focus", () => {
    const water = new CountingSampler(twin());
    const boat = cruising(water);
    for (let i = 0; i < 120; i += 1) boat.step(STEP);
    expect(water.samples).toBe(171 * 120);
    expect(water.focuses).toBe(120);
    expect(water.times).toBe(120);
  });

  it(`steps in under ${BUDGET_MS} ms at cruise on the game's sea, on the tuning box`, () => {
    const boat = cruising(twin());
    // Warm the JIT, the sampler's expansions and the yardstick.
    for (let i = 0; i < 2_400; i += 1) boat.step(STEP);
    warmReferenceKernel();
    // The quickest of ten 2 s batches: the step's own cost, without the
    // machine's other work in it. The kernel is timed around every batch.
    const batches: number[] = [];
    const kernel: number[] = [referenceKernelMilliseconds()];
    for (let k = 0; k < 10; k += 1) {
      const start = performance.now();
      for (let i = 0; i < 240; i += 1) boat.step(STEP);
      batches.push((performance.now() - start) / 240);
      kernel.push(referenceKernelMilliseconds());
    }
    const step = Math.min(...batches);
    const slowdown = referenceSlowdown(kernel);
    expect(
      step,
      `${(step * 1000).toFixed(0)} us a step against ${(BUDGET_MS * slowdown * 1000).toFixed(0)} us `
      + `(this machine ran the reference kernel ${slowdown.toFixed(2)}x slower than the tuning box)`,
    ).toBeLessThan(BUDGET_MS * slowdown);
    expect(boat.state.crashed).toBe(false);
  });
});
