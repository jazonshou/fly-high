import { describe, expect, it } from "vitest";
import { landCoverSuitabilities } from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import { createWorld } from "../src/world/world";
import { sampleTerrain, TERRAIN_REFERENCE_DAY_OF_YEAR } from "../src/world/terrain";

/**
 * **UNCLAIMED GROUND: the hole the "brown/grey strips" fix moved rather than
 * closed, and the contingency that keeps it shut.**
 *
 * `landCoverSuitabilities` is a set of gated products plus one constant floor.
 * Where every gate shuts at once, no climatic material scores at all and the
 * floor alone decides the surface. That ground is *unclaimed* — its cover is
 * not a statement about the terrain, it is whatever constant happens to sit
 * lowest in the file.
 *
 * The fix for Jason's report moved that floor from `Sand` to `Grass`, so
 * unclaimed ground now reads as ordinary lowland instead of inland beach. That
 * is the right default and it is why the artifact is no longer alarming. **It
 * did not close the hole**, and this file exists because the difference
 * matters: a future gate retune, or terrain generation that puts cold ground
 * on a gentle lowland, walks straight back into it and the only visible
 * symptom is a colour.
 *
 * **Why the hole stays shut is a measured contingency, not an identity.** Cold
 * ground is real — minimum normalised temperature reaches 0.000 in four of
 * five seeds. What never happens is the CO-OCCURRENCE of cold, gentle and low.
 * Cold ground in this world is always steep or high, so the temperature gate
 * never shuts at the same time as the slope and altitude ones. Nothing
 * enforces that; it is a property of the terrain functions as they stand. If
 * anything ever flattens or lowers cold terrain, the conjunction breaks.
 *
 * **This guard reads the classifier rather than modelling it.** It hardcodes
 * no gate threshold — not the `warm` window, not the `alpine` onset, not the
 * angle of repose. It asks each real world sample what the classifier actually
 * scored there, and fails when any land probe is decided by the floor. A gate
 * that is retuned moves the answer without moving this test's meaning, and a
 * hole opened by a NEW axis (moisture, aspect, canopy) is caught just as well
 * as the temperature one that was found first.
 */

/** The unclaimed-ground floor, read off the classifier rather than restated. */
const FLOOR = 0.02;

function maxSuitability(suitability: readonly number[]): number {
  let best = 0;
  for (let i = 0; i < SURFACE_MATERIAL_COUNT; i += 1) {
    const value = suitability[i] ?? 0;
    if (value > best) best = value;
  }
  return best;
}

/**
 * A point is unclaimed when nothing outscores the floor: the winning material
 * is the constant, not a climatic product.
 */
function isUnclaimed(suitability: readonly number[]): boolean {
  return maxSuitability(suitability) <= FLOOR + 1e-12;
}

describe("land cover: no ground is left for the floor to decide", () => {
  /**
   * **POSITIVE CONTROL, FIRST — a sweep that has never returned a hit is not
   * evidence.** Every assertion below is a negative result over the world, and
   * a negative result is worth exactly as much as the demonstration that the
   * instrument could have said yes. This synthetic point is cold, gentle and
   * low all at once — the conjunction the world never produces — and the
   * detector must fire on it.
   */
  it("detects unclaimed ground when the three gates do shut together", () => {
    const collapsed = landCoverSuitabilities({
      elevationMeters: 200,
      slope: 0.10,
      moisture: 0.5,
      temperature: 0.10,
      aspect: 0,
      airportInfluence: 0,
      dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
      seasonalTemperatureShift: 0,
    });

    expect(
      isUnclaimed(collapsed),
      "the unclaimed-ground detector did not fire on cold, gentle, low ground — "
        + "every world sweep in this file is a negative result and none of them "
        + "mean anything until this point proves the detector can say yes",
    ).toBe(true);

    // And the floor is what carried it: the winner is the constant itself.
    expect(maxSuitability(collapsed)).toBeCloseTo(FLOOR, 12);
    // Grass holds the floor. If this moves back to Sand the artifact is inland
    // beach again, which is the report this whole line of work started from.
    expect(collapsed[SurfaceMaterial.Grass]).toBeCloseTo(FLOOR, 12);
  });

  /**
   * The world side. Every land probe must be claimed by a real climatic
   * product, with the floor never reached — and the margin is reported so that
   * drift TOWARD the hole is visible before a crossing rather than after.
   */
  it("leaves no land in the world unclaimed, across seeds", () => {
    const seeds = ["phase1-perf-baseline", "alpha", "bravo"];
    let totalLand = 0;
    let worstMargin = Infinity;
    let worst = "";
    const unclaimed: string[] = [];

    for (const seed of seeds) {
      const world = createWorld(seed, { worldEvolution: "analytic" });
      const airport = world.airport;
      expect(airport, `seed ${seed} produced no airport to anchor the sweep`)
        .toBeDefined();

      for (let dx = -25_000; dx <= 25_000; dx += 500) {
        for (let dz = -25_000; dz <= 25_000; dz += 500) {
          const x = airport!.centerX + dx;
          const z = airport!.centerZ + dz;
          const sample = sampleTerrain(world, x, z);
          if (sample.height <= world.seaLevel) continue;
          totalLand += 1;

          const suitability = landCoverSuitabilities({
            elevationMeters: sample.height - world.seaLevel,
            slope: sample.slope,
            moisture: sample.moisture,
            temperature: sample.temperature,
            aspect: 0,
            airportInfluence: sample.airportInfluence,
            dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
            seasonalTemperatureShift: 0,
          });

          const margin = maxSuitability(suitability) - FLOOR;
          if (margin < worstMargin) {
            worstMargin = margin;
            worst = `${seed} (${x.toFixed(0)}, ${z.toFixed(0)}) `
              + `elev ${(sample.height - world.seaLevel).toFixed(0)} m, `
              + `slope ${sample.slope.toFixed(3)}, temp ${sample.temperature.toFixed(3)}`;
          }
          if (isUnclaimed(suitability)) unclaimed.push(worst);
        }
      }
    }

    // The sweep has to have looked at something. An empty population is the
    // best-looking false pass there is.
    expect(totalLand, "the sweep found no land at all — it is not measuring the world")
      .toBeGreaterThan(10_000);

    expect(
      unclaimed.length,
      `${unclaimed.length} of ${totalLand} land probes are unclaimed: no climatic `
        + "material outscores the floor, so their surface is decided by a constant "
        + `rather than by the terrain. Worst: ${unclaimed[0] ?? worst}. This is the `
        + "regime behind the strip artifact — cold, gentle and low have come back "
        + "into alignment somewhere.",
    ).toBe(0);

    // The margin itself — a tripwire that trips while there is still room,
    // rather than at the crossing.
    //
    // The bound is not derived from the measurement and must not be retuned to
    // whatever the sweep currently reports; that would make it a restatement of
    // the world instead of a constraint on it. For scale, at the time of
    // writing the closest land sat 0.2415 above the floor (620 m, slope 0.155,
    // temperature 0.435), so 0.05 leaves the world free to lose most of its
    // headroom before anyone is woken. If this ever fires, the question is what
    // moved the terrain — not whether the number should be smaller.
    expect(
      worstMargin,
      `the closest land in the world sits ${worstMargin.toFixed(4)} above the `
        + `unclaimed-ground floor, at ${worst}. Nothing is unclaimed yet, but the `
        + "conjunction that keeps this hole shut is contingent, and it is closing.",
    ).toBeGreaterThan(0.05);
  });
});
