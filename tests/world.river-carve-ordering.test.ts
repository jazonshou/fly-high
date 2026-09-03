import { describe, expect, it } from "vitest";
import { createWorld, sampleTerrain } from "../src/world";
import { sampleTerrainHeight, sampleCarvedTerrainHeight } from "../src/world/terrain";
import { generateHydrology } from "../src/render/webgpu/water/HydrologyGeneration";
import {
  CHANNEL_CARVE_ENABLED,
  NO_CARVED_CHANNELS,
  carveChannels,
  channelCarveDepth,
  markCarvedSampler,
} from "../src/render/webgpu/terrain/RiverChannels";

/**
 * `5-12a` step 1: the ordering, before any shape.
 *
 * **Rivers are traced FROM the heightfield and carving MODIFIES it.** A naive
 * implementation traces its own output and oscillates. Two defences, and this
 * file exists to prove the second one FIRES rather than to describe it:
 *
 * 1. `CarvedChannelSet` has one constructor taking a finished hydrology result,
 *    so carve-before-trace cannot be written. That is compile-time.
 * 2. `generateHydrology` refuses a sampler marked as reading carved ground.
 *    That is runtime, and it covers the paths types do not reach.
 *
 * **Step 1 carves nothing on purpose.** `3-8` put collision and render 15.3 m
 * apart on the runway — the feature this copies — so the wiring lands first
 * against a world that must be byte-identical, where any movement is the wiring
 * being wrong rather than a shape question.
 */

const SEED = "phase1-perf-baseline";

describe("5-12a: carve ordering is enforced, not documented", () => {
  it("refuses to trace over carved ground, and the refusal fires", () => {
    const world = createWorld(SEED);
    const natural = (x: number, z: number) => {
      const sample = sampleTerrain(world, x, z);
      return { height: sample.height, moisture: sample.moisture };
    };

    // The uncarved sampler is accepted. Without this the assertion below could
    // pass because generateHydrology rejects everything.
    expect(() => generateHydrology({
      worldSeed: world.seed, terrainSample: natural, centerX: 0, centerZ: 0,
    })).not.toThrow();

    // NEGATIVE CONTROL: the same sampler, marked as carved, must be refused.
    const carved = markCarvedSampler((x: number, z: number) => {
      const sample = sampleTerrain(world, x, z);
      return { height: sample.height, moisture: sample.moisture };
    });
    expect(() => generateHydrology({
      worldSeed: world.seed, terrainSample: carved, centerX: 0, centerZ: 0,
    })).toThrow(/carved terrain sampler/i);
  }, 120_000);

  it("carves nothing at step 1, so the wiring can be asserted against a still world", () => {
    expect(CHANNEL_CARVE_ENABLED, "step 1 must not change any height").toBe(false);
    const world = createWorld(SEED);
    const hydrology = generateHydrology({
      worldSeed: world.seed,
      terrainSample: (x, z) => {
        const sample = sampleTerrain(world, x, z);
        return { height: sample.height, moisture: sample.moisture };
      },
      centerX: 0,
      centerZ: 0,
    });
    const channels = carveChannels(hydrology);
    // NON-VACUITY: a sampler that agrees because both sides are constant would
    // pass anything. The heights below must actually vary across the points.
    const heights: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const x = (i - 20) * 137.5;
      const z = (i % 7 - 3) * 211.25;
      const plain = sampleTerrainHeight(world, x, z);
      heights.push(plain);
      expect(sampleCarvedTerrainHeight(world, channels, x, z)).toBe(plain);
      expect(channelCarveDepth(channels, x, z)).toBe(0);
    }
    expect(new Set(heights.map((h) => h.toFixed(3))).size,
      "sampled points do not vary, so equality proves nothing").toBeGreaterThan(10);
  }, 120_000);

  it("an empty channel set carves nothing anywhere", () => {
    for (const [x, z] of [[0, 0], [1_000, -4_000], [-25_000, 12_000]] as const) {
      expect(channelCarveDepth(NO_CARVED_CHANNELS, x, z)).toBe(0);
    }
  });
});
