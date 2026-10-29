import { describe, expect, it } from "vitest";
import { BoatSimulator, KNOT } from "../src/sim/boat";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";
import { WaterSurfaceComposite } from "../src/sim/water/compositeWater";
import { HydrologyWaterSource, packHydrologyWater, type HydrologyWaterLake } from "../src/sim/water/hydrologyWater";
import { createSeaTwin } from "../src/sim/water/seaTwin";
import type { HullWaterSampler } from "../src/sim/water/types";
import { referenceKernelMilliseconds, referenceSlowdown, warmReferenceKernel } from "./support/referenceKernel";

/**
 * The boat's 171 water samples a step through the composite (the boats
 * lead's condition for the one water authority): the Runabout 21 at cruise
 * on the game's sea, once on the bare twin and once on the twin inside the
 * composite with a coast's rivers and lakes resident around its track, a
 * river 30 m off it so the track's bins hold segments the lookup has to
 * reject. No inland water is under the boat, so its steps are the same bit
 * for bit, and they cost at most about 10% more.
 *
 * Both are timed in the same process, batch for batch, so the ratio needs
 * no yardstick; the reference kernel (tests/support/referenceKernel.ts)
 * scales the small absolute allowance on top of it.
 */

const STEP = 1 / 120;
/** The composite's allowance over the bare twin: 10%, and 5 us on the tuning box for timer noise. */
const EXTRA_FRACTION = 0.1;
const EXTRA_FLOOR_MS = 0.005;

function cruising(water: HullWaterSampler): BoatSimulator {
  const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, speed: 30 * KNOT, gear: "forward", rpm: 4_400 });
  boat.setEnvironment({ water, wind: { x: 0, y: 0, z: 0 }, bedHeight: () => -100, gravity: 9.80665 });
  boat.setControls({ assist: "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS, lever: 0.75 } });
  return boat;
}

const twin = () =>
  createSeaTwin({ sourceSeedHash: 0x4f434541, prevailingWindRadians: 4.2243797, prevailingWindSpeed: 9.62323060631752, seaLevel: 0 }, "breezy");

/** Rivers alongside the boat's track up +z (one 30 m off it) and lakes past them, on land 2 m above the sea. */
function coast(): HydrologyWaterSource {
  const rivers = [-150, 30, 160].map((x) => {
    const points = [];
    for (let z = -500; z <= 2_500; z += 45) {
      points.push({ x: x + 6 * Math.sin(z / 200), y: 2.16, z, widthMeters: 14, flowSpeedMetersPerSecond: 1.2 });
    }
    return { points };
  });
  const lakes: HydrologyWaterLake[] = [];
  for (let k = 0; k < 6; k += 1) {
    for (const side of [-1, 1]) {
      const cx = side * 450;
      const cz = k * 400;
      const boundary = [];
      for (let i = 0; i < 32; i += 1) {
        const angle = (i / 32) * 2 * Math.PI;
        boundary.push({ x: cx + 120 * Math.cos(angle), z: cz + 120 * Math.sin(angle) });
      }
      lakes.push({ surfaceHeight: 2.16, boundary });
    }
  }
  const source = new HydrologyWaterSource(() => 2);
  source.setRegion("coast", packHydrologyWater(rivers, lakes));
  return source;
}

function digest(boat: BoatSimulator): number[] {
  const s = boat.state;
  return [
    s.position.x, s.position.y, s.position.z,
    s.velocity.x, s.velocity.y, s.velocity.z,
    s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w,
    s.angularVelocity.x, s.angularVelocity.y, s.angularVelocity.z,
  ];
}

describe("the boat on the water composite", () => {
  it("steps the same, bit for bit, where no lake or river is under it", () => {
    const bare = cruising(twin());
    const composite = cruising(new WaterSurfaceComposite(twin(), coast(), 0));
    for (let i = 0; i < 1_200; i += 1) {
      bare.step(STEP);
      composite.step(STEP);
    }
    // It ran 10 s up the track, past the river's bins.
    expect(bare.state.position.z).toBeGreaterThan(100);
    expect(digest(composite)).toEqual(digest(bare));
  });

  it("costs at most about 10% more a step through the composite than on the bare twin", () => {
    const bare = cruising(twin());
    const composite = cruising(new WaterSurfaceComposite(twin(), coast(), 0));
    // Warm the JIT, both samplers' expansions and the yardstick.
    for (let i = 0; i < 2_400; i += 1) {
      bare.step(STEP);
      composite.step(STEP);
    }
    warmReferenceKernel();
    // The quickest of twelve 240-step batches each, interleaved, so a busy machine slows both.
    const bareBatches: number[] = [];
    const compositeBatches: number[] = [];
    const kernel: number[] = [referenceKernelMilliseconds()];
    for (let k = 0; k < 12; k += 1) {
      for (const [boat, batches] of k % 2 === 0
        ? [[bare, bareBatches], [composite, compositeBatches]] as const
        : [[composite, compositeBatches], [bare, bareBatches]] as const) {
        const start = performance.now();
        for (let i = 0; i < 240; i += 1) boat.step(STEP);
        batches.push((performance.now() - start) / 240);
      }
      kernel.push(referenceKernelMilliseconds());
    }
    const bareStep = Math.min(...bareBatches);
    const compositeStep = Math.min(...compositeBatches);
    const allowance = EXTRA_FRACTION * bareStep + EXTRA_FLOOR_MS * referenceSlowdown(kernel);
    expect(
      compositeStep - bareStep,
      `${(compositeStep * 1000).toFixed(1)} us a step through the composite against ${(bareStep * 1000).toFixed(1)} us bare`,
    ).toBeLessThan(allowance);
  });
});
