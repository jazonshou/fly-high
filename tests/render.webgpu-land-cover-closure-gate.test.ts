import { describe, expect, it } from "vitest";
import {
  classifyLandCover,
  landCoverSuitabilities,
  LAND_COVER_CANOPY_CLOSURE_GAIN,
  type LandCoverInput,
} from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  SurfaceMaterial,
  type SurfaceMaterialId,
} from "../src/render/webgpu/terrain/surfaceMaterials";

/**
 * `6-13`: the closure gate, and the invariant it must not break.
 *
 * The defect: `ForestFloor` carried closure as a GAIN, `(1 + closure * 0.55)`,
 * which is 1.0 at closure 0 — so it kept its full `1.1` base on ground with no
 * canopy and beat Grass's ceiling of 1.0 by a permanent 0.100 on every wet
 * lowland. Measured, forest litter was the dominant material on 57.7% of land
 * against Grass's 13.3%, in a frame with 0.171% tree pixels.
 *
 * The trap in the fix, which is the reason this file exists: `?? 0` makes
 * "no canopy here" and "nobody told me about canopy" the same value. All three
 * CPU callers omit `canopyClosure` — `GroundCoverSystem`, `detail/generation`,
 * and `world/terrain`, whose result feeds `BIOME_FOR_DOMINANT_MATERIAL`. A
 * plain multiplicative gate would therefore have made the FOREST biome
 * unreachable on the CPU path: a world-classification regression, silent,
 * and much larger than the bug being fixed.
 *
 * Nothing asserted that invariant before. That is why it could have landed.
 */

const WET_WARM_LOWLAND: LandCoverInput = {
  elevationMeters: 60,
  slope: 0.05,
  moisture: 0.8,
  temperature: 0.5,
  aspect: 0,
  airportInfluence: 0,
  dayOfYear: 171,
  seasonalTemperatureShift: 0,
};

function dominant(input: LandCoverInput): SurfaceMaterialId {
  const w = classifyLandCover(input);
  let best = 0;
  for (let i = 1; i < w.ids.length; i += 1) {
    if (w.weights[i]! > w.weights[best]!) best = i;
  }
  return w.ids[best]!;
}

describe("land-cover closure gate (6-13)", () => {
  it("keeps ForestFloor reachable for a CPU caller that omits closure", () => {
    // THE guard. `world/terrain.ts` classifies without `canopyClosure` and
    // hands the winner to `BIOME_FOR_DOMINANT_MATERIAL`; if ForestFloor cannot
    // win there, the FOREST biome does not exist for species or wildlife.
    expect(WET_WARM_LOWLAND.canopyClosure).toBeUndefined();
    expect(
      dominant(WET_WARM_LOWLAND),
      "a CPU caller that omits canopyClosure can no longer reach ForestFloor — "
      + "the FOREST biome is unreachable and BIOME_FOR_DOMINANT_MATERIAL is broken",
    ).toBe(SurfaceMaterial.ForestFloor);
  });

  it("leaves an omitting caller's suitability at its pre-gate value", () => {
    // The `6-8` docblock invariant, stated exactly: omission "leaves every
    // suitability at its pre-6-8 value". Gate or gain, the omitted case must
    // multiply by 1.0 — so omission and an explicit closure of 1/(1+GAIN)
    // cannot be distinguished by ForestFloor's suitability.
    const omitted = landCoverSuitabilities(WET_WARM_LOWLAND)[SurfaceMaterial.ForestFloor]!;
    const neutral = landCoverSuitabilities({
      ...WET_WARM_LOWLAND,
      canopyClosure: 1 / (1 + LAND_COVER_CANOPY_CLOSURE_GAIN),
    })[SurfaceMaterial.ForestFloor]!;
    expect(omitted).toBeCloseTo(neutral, 10);
    expect(omitted).toBeGreaterThan(0);
  });

  it("DOES gate a caller that supplies a genuine zero closure", () => {
    // The fix itself. Treeless ground that the bake has measured must not be
    // painted as forest litter — and this is what the frame with 0.171% tree
    // pixels was showing.
    const open = { ...WET_WARM_LOWLAND, canopyClosure: 0 };
    expect(landCoverSuitabilities(open)[SurfaceMaterial.ForestFloor]).toBe(0);
    expect(
      dominant(open),
      "open, treeless, wet lowland still classifies as forest floor",
    ).not.toBe(SurfaceMaterial.ForestFloor);
  });

  it("leaves a CLOSED canopy exactly where it was", () => {
    // The gate is `closure * (1 + GAIN)`, which is `(1 + GAIN)` at closure 1 —
    // identical to the old gain's value there. A closed canopy must not move,
    // or the fix is a retune of forest appearance rather than a correction of
    // open ground.
    const closed = { ...WET_WARM_LOWLAND, canopyClosure: 1 };
    const suit = landCoverSuitabilities(closed)[SurfaceMaterial.ForestFloor]!;
    const withoutGate = suit / (1 + LAND_COVER_CANOPY_CLOSURE_GAIN);
    expect(suit / withoutGate).toBeCloseTo(1 + LAND_COVER_CANOPY_CLOSURE_GAIN, 10);
    expect(dominant(closed)).toBe(SurfaceMaterial.ForestFloor);
  });

  it("leaves no slope where every climatic material collapses to Sand's floor", () => {
    // The other half of `6-13`. `gentle` and `steep` describe one physical
    // transition but their half-values sat at slope 0.16 and 0.41, and both
    // were in their flat tails across 0.24-0.26 — every climatic suitability
    // fell to ~0 there and `Sand`'s constant `+0.02` won by default (measured:
    // 270 of 13,685 land probes, at exactly 0.02, all in slope 0.24-0.27).
    //
    // They are now one partition hinged on the documented angle of repose
    // (~0.21), so `gentle + steep === 1` and the gap cannot reopen.
    for (let slope = 0; slope <= 0.6; slope += 0.005) {
      const suit = landCoverSuitabilities({
        ...WET_WARM_LOWLAND,
        slope,
        moisture: 0.55,
        canopyClosure: 0,
      });
      const best = Math.max(...suit);
      expect(
        best,
        `slope ${slope.toFixed(3)}: every climatic material collapsed to `
        + `${best.toFixed(4)} — Sand's 0.02 floor wins by default and the hole is back`,
      ).toBeGreaterThan(0.05);
    }
  });

  it("never paints unclaimed ground as SAND, at any temperature", () => {
    // The same hole as the sweep above, one axis over — and the reason that
    // sweep could not see it is that it varies `slope` while pinning climate
    // at `WET_WARM_LOWLAND`. **A guard that fixes the axes it is not sweeping
    // is blind to the identical defect one axis away.**
    //
    // `warm` gates Grass, ForestFloor and DryGrass; `alpine` gates Shrub and
    // most of Rock; `steep` gates the rest. Below the warm threshold, below
    // the alpine onset, on gentle ground, all three shut at once. Measured
    // before the fix at 200 m: temperature <= 0.16 gave Sand at exactly 0.020,
    // temperature >= 0.18 gave Grass at 0.800 — a 0.02-wide step flipping the
    // whole surface, tracing a CONTOUR because terrain temperature varies
    // smoothly. That is why Jason saw strips rather than patches.
    //
    // **THIS ASSERTS THE INVARIANT, NOT THE SCORE, AND THE DIFFERENCE IS
    // HONEST.** The floor moved from Sand to Grass, so unclaimed ground is now
    // painted the ordinary lowland cover instead of beach. It is still a
    // DEFAULT rather than a claim: the winning score there is 0.02, and a
    // `best > 0.05` assertion would still fail. The structural hole — no
    // climatic class genuinely claiming cold gentle lowland — is NOT closed by
    // this change and is recorded as open. What is closed is that the default
    // can no longer be the one material whose appearance contradicts every
    // neighbour.
    //
    // **THE HOLE THAT REMAINS, stated so nobody reads this green as more than
    // it is.** Cold gentle lowland below the alpine onset has no climatic
    // class that genuinely claims it: Grass wins there on a floor of 0.02,
    // which is a DEFAULT masquerading as a claim. The right repair is a class
    // that covers cold open ground on its own terms — tundra, or a
    // cold-tolerant Grass term — and that is a look decision nobody has taken.
    // **Until then this guard proves only that the default is plausible, not
    // that the ground is classified.**
    for (let temperature = 0; temperature <= 0.6; temperature += 0.01) {
      for (const elevationMeters of [5, 50, 200, 380, 500]) {
        const suit = landCoverSuitabilities({
          ...WET_WARM_LOWLAND,
          elevationMeters,
          temperature,
          slope: 0.05,
          moisture: 0.55,
          canopyClosure: 0,
        });
        let dominantIndex = 0;
        for (let i = 1; i < suit.length; i += 1) {
          if (suit[i]! > suit[dominantIndex]!) dominantIndex = i;
        }
        expect(
          dominantIndex,
          `temperature ${temperature.toFixed(2)} at ${elevationMeters} m: gentle `
          + "inland ground classified as Sand. A constant term is deciding what "
          + "unclaimed ground looks like, and beach is the least ordinary answer.",
        ).not.toBe(SurfaceMaterial.Sand);
      }
    }
  });
});
