/**
 * `7-14` obstruction lighting.
 *
 * The two tests that matter here are the last two, and both exist because the
 * failure they catch is INVISIBLE to the obvious assertion. A transposed
 * coordinate is still finite, and a stale `papiOffset` still leaves the colour
 * array exactly as long as it should be — so "N fixtures at finite positions"
 * and "one colour per fixture" both pass while the lights are in the wrong
 * place or the PAPI is repainting somebody else's lamp.
 */
import { describe, expect, it } from "vitest";
import {
  AirfieldLightingSystem,
  papiLamps,
  AIRFIELD_LAMP_RGB,
} from "../src/render/webgpu/lighting/AirfieldLighting";
import {
  towerObstructionFixtures,
  obstructionFixtureWorldPosition,
  OBSTRUCTION_LIGHT_RGB,
  OBSTRUCTION_LIGHT_CANDELA,
} from "../src/render/webgpu/lighting/ObstructionLighting";
import { buildTowerGeometry } from "../src/render/webgpu/detail/towerGeometry";
import { runwayToWorld, DEFAULT_AIRPORT } from "../src/world/airport";
import type { AirportDefinition } from "../src/world/types";
import { lightPointBeamGain } from "../src/render/webgpu/lighting/LightPoints";
import { SCOTOPIC_WEIGHTS, SCOTOPIC_CHROMA_RETENTION } from "../src/render/webgpu/atmosphere/ScotopicVision";

/**
 * A DELIBERATELY OBLIQUE airport, spread from `DEFAULT_AIRPORT` and NOT cast.
 *
 * OBLIQUE because the heading is 0.7 rad rather than 0 or a right angle: a
 * transposed `[across, along]` on an axis-aligned runway can land on the
 * correct world point, and the transposition test below would then pass
 * straight through the bug it exists to catch. `centerX !== centerZ` for the
 * same reason.
 *
 * SPREAD, NOT CAST, so every field is present and `tsc` enforces that it stays
 * so.
 *
 * The first version of this WAS a cast — six fields written out and
 * `as AirportDefinition` to quiet the compiler — and it was missing
 * `endSafetyArea`, `shoulderWidth` and `terrainBlendDistance`. The cast hid it,
 * `papiUnitPlacements` read the absent fields, and all eight PAPI elevations
 * came back NaN. `NaN >= settingDegrees` is false, so every lamp read "red",
 * `update` reported no change, and the seam test below failed for a reason that
 * had nothing to do with the seam.
 */
const OBLIQUE: AirportDefinition = {
  ...DEFAULT_AIRPORT,
  centerX: 12_000,
  centerZ: 4_000,
  elevation: 310,
  headingRadians: 0.7,
};

const attachments = buildTowerGeometry().attachments;

describe("tower obstruction fixtures", () => {
  it("puts one medium-intensity light at the top and marks the cab extent", () => {
    const fixtures = towerObstructionFixtures(OBLIQUE, attachments);
    expect(fixtures).toHaveLength(1 + attachments.cabRoofRing.length);

    const [top, ...ring] = fixtures;
    expect(top!.intensity).toBeGreaterThan(ring[0]!.intensity);
    // The extent markers are the low-intensity grade, ~62x down, not a second
    // tier of beacons. Asserted as a ratio so the scene scale can move without
    // rewriting the test.
    expect(top!.intensity / ring[0]!.intensity).toBeCloseTo(
      OBSTRUCTION_LIGHT_CANDELA.top / OBSTRUCTION_LIGHT_CANDELA.extent,
      6,
    );
    expect(top!.position[1]).toBeGreaterThan(ring[0]!.position[1]);
  });

  it("is omnidirectional at every angle, which is the point of an obstruction light", () => {
    // FAILS IF: a beam cutoff is ever set on these. An obstruction light must
    // be seen from any azimuth an aircraft can approach from, so a cutoff here
    // is a defect that only appears on the one heading nobody captured.
    for (const fixture of towerObstructionFixtures(OBLIQUE, attachments)) {
      expect(fixture.beamCosineCutoff ?? -1).toBeLessThanOrEqual(-1);
      for (const axisCosine of [-1, -0.5, 0, 0.5, 1]) {
        expect(lightPointBeamGain(fixture.beamCosineCutoff ?? -1, axisCosine)).toBe(1);
      }
    }
  });

  it("is aviation red, and no worse than the shipped red under the rod pathway", () => {
    for (const fixture of towerObstructionFixtures(OBLIQUE, attachments)) {
      expect(fixture.color).toEqual(OBSTRUCTION_LIGHT_RGB);
    }

    // THE OBVIOUS ASSERTION HERE WOULD BE DECORATIVE. `expect(OBSTRUCTION_
    // LIGHT_RGB).not.toEqual(AIRFIELD_LAMP_RGB.red)` passes on a 0.01 gap in
    // one channel, so it would read as "these were chosen independently" while
    // proving only that somebody typed a different number. The two ARE nearly
    // identical, deliberately — both are aviation red.
    //
    // What is worth pinning is the property that actually has consequences:
    // the night path divides by `dot(rgb, SCOTOPIC_WEIGHTS)`, whose red term
    // is 0.03, so a saturated red is amplified hard. This fixes that this
    // fixture is no more extreme than the red already shipping — the guard
    // that would catch someone "making it redder" for legibility.
    const amplification = (c: readonly [number, number, number]) =>
      c[0] / (c[0] * SCOTOPIC_WEIGHTS[0] + c[1] * SCOTOPIC_WEIGHTS[1] + c[2] * SCOTOPIC_WEIGHTS[2]);

    expect(amplification(OBSTRUCTION_LIGHT_RGB))
      .toBeLessThanOrEqual(amplification(AIRFIELD_LAMP_RGB.red));
    // And it is a real amplification, not a safe near-neutral: if this ever
    // drops to white's ~1.5x the fixture has stopped being red.
    expect(amplification(OBSTRUCTION_LIGHT_RGB)).toBeGreaterThan(5);
  });

  /**
   * The amplification of EVERY shipped lamp colour, computed rather than
   * transcribed.
   *
   * WHY THIS IS A TEST AND NOT A COMMENT. The finding it records — that the
   * shipped `red` is by far the most exposed input to the rod-hue
   * normalisation — was established across three sessions and lived only in
   * conversation. Writing the figure into a docblock would have made it stale
   * the moment `SCOTOPIC_WEIGHTS`, `SCOTOPIC_CHROMA_RETENTION` or a colour
   * moved, which is the exact failure this file's neighbour spent four commits
   * demonstrating. Computed from the live constants it cannot drift, and
   * iterating `Object.keys` means a colour added later is covered without
   * anyone remembering to come back.
   *
   * AND THE FIGURE ITSELF WAS MISQUOTED TWICE WHILE THIS TEST WAS BEING
   * WRITTEN, in both directions, which is the argument for printing a regime
   * rather than a number. First as a flat 10.35x with no mention that a
   * retention mix follows it; then as a flat 7.08x, applying the 0.65 floor to
   * a lamp — but `chromaKeep` is `max(0.65, pixelCone)` and a lamp drives
   * `pixelCone` to 1, so the floor never binds on the very fixtures the number
   * was being quoted about. Both readings took a regime-dependent quantity for
   * a constant.
   */
  it("records how hard the rod pathway amplifies each shipped lamp colour", () => {
    const weightsSum = SCOTOPIC_WEIGHTS[0] + SCOTOPIC_WEIGHTS[1] + SCOTOPIC_WEIGHTS[2];
    // A neutral input must stay neutral, which is only true while the weights
    // sum to one — the premise the whole hue-retention argument rests on.
    expect(weightsSum).toBeCloseTo(1, 9);

    /**
     * THERE IS NO SINGLE "AMPLIFICATION" NUMBER, and reporting one is how this
     * gets misread. The shader ends at
     *
     *   chromaKeep = max(SCOTOPIC_CHROMA_RETENTION, pixelCone)
     *   rodImage   = mix(L, L * hue, chromaKeep)
     *
     * so the factor reaching the red channel is `(1 - keep) + keep * hue`, and
     * `keep` is REGIME-DEPENDENT. `pixelCone` is a smoothstep over
     * `log(sharpNits / sigma)` across 4x..64x, so:
     *
     *   dim, rod-dominated pixel   pixelCone -> 0   keep = 0.65 (the floor)
     *   bright point source        pixelCone -> 1   keep = 1.00 (full hue)
     *
     * **A LAMP IS THE SECOND CASE**, which is the whole point of the cone term:
     * "a lamp bright enough to see is bright enough to see IN COLOUR". So the
     * floor is a floor for diffuse ground and NOT a ceiling for fixtures — an
     * obstruction light gets the full ratio, not the retained fraction.
     * Quoting 0.65 for a lamp reads the constant out of its regime.
     */
    const retention = SCOTOPIC_CHROMA_RETENTION;
    const table = Object.entries(AIRFIELD_LAMP_RGB).map(([name, c]) => {
      const hueRatio =
        c[0] / (c[0] * SCOTOPIC_WEIGHTS[0] + c[1] * SCOTOPIC_WEIGHTS[1] + c[2] * SCOTOPIC_WEIGHTS[2]);
      return {
        name,
        hueRatio,
        // pixelCone -> 0: the retention floor, what diffuse ground gets.
        appliedRodRegime: 1 - retention + retention * hueRatio,
        // pixelCone -> 1: keep = 1, so the applied factor IS the ratio.
        appliedLampRegime: hueRatio,
      };
    });
    // Printed so a run of this file surfaces the current numbers, rather than
    // the numbers someone believed when they wrote the comment.
    for (const row of table) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${row.name.padEnd(6)} hue ratio ${row.hueRatio.toFixed(2).padStart(5)}x`
        + `   applied: rod-regime ${row.appliedRodRegime.toFixed(2).padStart(5)}x`
        + `   lamp-regime ${row.appliedLampRegime.toFixed(2).padStart(5)}x`,
      );
    }

    // The floor only ever pulls TOWARD neutral, so a colour amplified above 1x
    // is always amplified less in the rod regime than in the lamp regime. This
    // is the relation that makes "0.65 caps it" wrong for a fixture.
    for (const row of table) {
      if (row.hueRatio > 1) expect(row.appliedRodRegime).toBeLessThan(row.appliedLampRegime);
      expect(row.appliedLampRegime).toBeCloseTo(row.hueRatio, 12);
    }

    // FAILS IF: a new lamp colour is introduced that is more red-dominant than
    // the shipped red. That colour would be the most exposed input to the night
    // path's hue retention, and it should be a deliberate decision rather than
    // a thing discovered in a capture.
    // Retention is a monotone map, so the most red-dominant colour by the raw
    // ratio is also the most amplified in either regime — the ordering does not
    // depend on which of the two numbers above you pick.
    const reddest = table.reduce((a, b) => (b.hueRatio > a.hueRatio ? b : a));
    expect(reddest.name).toBe("red");
    const reddestApplied = table.reduce((a, b) =>
      (b.appliedRodRegime > a.appliedRodRegime ? b : a));
    expect(reddestApplied.name).toBe("red");
  });
});

describe("the runway-local to world conversion", () => {
  it("reads [across, y, along] and NOT [along, y, across]", () => {
    // FAILS IF: the conversion passes an attachment straight into
    // `runwayToWorld`, whose argument order is (along, across). Both orders
    // produce a finite point on an oblique runway, so this asserts the VALUE
    // against an independent computation rather than asserting finiteness.
    const local = [37, 12, -410] as const;
    const [across, y, along] = local;

    const expected = runwayToWorld(OBLIQUE, along, across);
    const actual = obstructionFixtureWorldPosition(OBLIQUE, local);

    expect(actual[0]).toBeCloseTo(expected.x, 9);
    expect(actual[2]).toBeCloseTo(expected.z, 9);
    expect(actual[1]).toBeCloseTo(OBLIQUE.elevation + y, 9);

    // And the transposition really is reachable — if this produced the same
    // point, the test above would be vacuous on this airport.
    const transposed = runwayToWorld(OBLIQUE, across, along);
    expect(Math.hypot(transposed.x - expected.x, transposed.z - expected.z))
      .toBeGreaterThan(100);
  });

  it("does not re-apply the tower placement already folded into the attachments", () => {
    // AN EARLIER VERSION OF THIS TEST WAS VACUOUS and is recorded because the
    // shape recurs: it asserted `obstructionFixtureWorldPosition(a, p)` equals
    // `runwayToWorld(a, p[2], p[0])`, which is that function's own body. It
    // could not fail for any implementation of the thing it was testing.
    //
    // What follows measures a DISTANCE against an independently computed one.
    // `AirportSystem` folds the tower's placement into the attachments before
    // publishing them, so a conversion that adds the placement again lands the
    // lights at twice the offset — still finite, still on the airfield.
    const towerAcross = OBLIQUE.runwayWidth * 0.5 + 95;
    const towerAlong = OBLIQUE.runwayLength * 0.06;
    // Exactly what `AirportSystem` publishes, reproduced here.
    const published = [
      attachments.mastTip[0] + towerAcross,
      attachments.mastTip[1],
      attachments.mastTip[2] + towerAlong,
    ] as const;

    const world = obstructionFixtureWorldPosition(OBLIQUE, published);
    const fromCentre = Math.hypot(world[0] - OBLIQUE.centerX, world[2] - OBLIQUE.centerZ);

    expect(fromCentre).toBeCloseTo(Math.hypot(towerAcross, towerAlong), 6);
    // The doubled case is a genuinely different number, so the assertion above
    // discriminates rather than merely holding.
    const doubled = Math.hypot(towerAcross * 2, towerAlong * 2);
    expect(Math.abs(doubled - fromCentre)).toBeGreaterThan(100);
  });
});

describe("the light-point colour seam", () => {
  const obstruction = towerObstructionFixtures(OBLIQUE, attachments);

  it("keeps one colour per fixture once obstruction lights are carried", () => {
    // FAILS IF: extra fixtures reach the light-point system without their
    // colours. `LightPointSystem.setColors` throws on a length mismatch and the
    // only caller feeds it `colourList()`, so this is the Node-side stand-in
    // for a throw that otherwise fires inside the frame graph.
    const system = new AirfieldLightingSystem(OBLIQUE, obstruction);
    expect(system.colourList()).toHaveLength(system.fixtures.length);

    const bare = new AirfieldLightingSystem(OBLIQUE);
    expect(system.fixtures.length).toBe(bare.fixtures.length + obstruction.length);
  });

  it("makes the PAPI repaint ITS OWN lamps, not the obstruction lights", () => {
    // FAILS IF: `papiOffset` is derived from the static points alone rather
    // than from everything preceding the PAPI. That bug leaves the colour array
    // exactly the right LENGTH — so the guard above passes — while every
    // indication change repaints an obstruction light instead of a PAPI lamp.
    // This asserts IDENTITY: which entries moved, not how many exist.
    const system = new AirfieldLightingSystem(OBLIQUE, obstruction);
    const before = system.colourList().map((c) => [...c]);

    // High above the threshold: every PAPI reads white, so all of them flip.
    const end = runwayToWorld(OBLIQUE, -OBLIQUE.runwayLength * 0.5, 0);
    expect(system.update(end.x, end.y + 8_000, end.z)).toBe(true);

    const after = system.colourList();
    const moved = before
      .map((c, i) => (c.every((v, k) => v === after[i]![k]) ? -1 : i))
      .filter((i) => i >= 0);

    expect(moved.length).toBeGreaterThan(0);
    // Every fixture that changed is a PAPI lamp: it lies in the final block.
    const papiCount = papiLamps(OBLIQUE).length;
    const firstPapi = system.fixtures.length - papiCount;
    for (const index of moved) expect(index).toBeGreaterThanOrEqual(firstPapi);

    // And the obstruction lights specifically are untouched and still red.
    const firstObstruction = firstPapi - obstruction.length;
    for (let i = firstObstruction; i < firstPapi; i += 1) {
      expect(after[i]).toEqual(OBSTRUCTION_LIGHT_RGB);
    }
  });
});
