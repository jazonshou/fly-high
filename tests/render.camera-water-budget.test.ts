import { describe, expect, it } from "vitest";
import { CameraWaterSampler, createCameraWaterSample } from "../src/render/webgpu/underwater/cameraWater";
import { createWorld } from "../src/world";

/**
 * The camera's water allocates nothing per frame on its cheap paths (beyond
 * the waves' reach, on dry ground, and a point carried from the last twin
 * evaluation) but the doubles V8 boxes on the calls into the water and the
 * terrain it does not inline: under 16 B a sample, where one object a
 * sample would be 24 B or more. In a file of its own: V8's type feedback is
 * per function, and the other camera-water tests' samplers would leave these
 * call sites polymorphic. (The twin's own sums box a few doubles on a fresh
 * evaluation, as the boat and car tests note, so those are counted, not
 * weighed: render.camera-water.test.ts.)
 */

const WORLD = createWorld("open-skies");
const SEA = WORLD.seaLevel;

function heapGrowth(run: () => void, allowed: number): { grown: number; ok: boolean } {
  const deadline = performance.now() + 20_000;
  let streak = 0;
  let grown = Number.NaN;
  while (streak < 3 && performance.now() < deadline) {
    const before = process.memoryUsage().heapUsed;
    run();
    grown = process.memoryUsage().heapUsed - before;
    streak = grown >= 0 && grown < allowed ? streak + 1 : 0;
  }
  return { grown, ok: streak === 3 };
}

describe("the camera's water, budget", () => {
  it("allocates nothing beyond the waves' reach, on dry ground, or carried from the last evaluation", () => {
    let ground = SEA - 40;
    const sampler = new CameraWaterSampler(WORLD, "breezy", () => ground, 5);
    const out = createCameraWaterSample();
    sampler.build();
    // One evaluation near the surface, then the same frame's time asks only carry it.
    sampler.sample(400, SEA, 400, 900, out);
    const evaluations = sampler.evaluations;
    const rounds = 20_000;
    const result = heapGrowth(() => {
      for (let k = 0; k < rounds; k += 1) {
        const wobble = (k & 15) * 0.01;
        ground = SEA - 40;
        sampler.sample(400 + wobble, SEA - 0.4, 400, 900, out);
        sampler.sample(400 + wobble, SEA - 30, 400, 900, out);
        ground = SEA + 5;
        sampler.sample(400 + wobble, SEA + 6, 400, 900, out);
      }
    }, 32 * 1024 + 16 * 3 * rounds);
    expect(result.ok, `last run grew the heap by ${result.grown} B`).toBe(true);
    expect(sampler.evaluations).toBe(evaluations);
  });
});
