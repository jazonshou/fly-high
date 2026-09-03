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
  AIRFIELD_LAMP_SCENE_SCALE,
} from "../src/render/webgpu/lighting/AirfieldLighting";
import {
  towerObstructionFixtures,
  hangarObstructionFixtures,
  hangarFaceFloodlights,
  HANGAR_FLOOD_INTENSITY,
  obstructionFixtureWorldPosition,
  subdivideRingForExtentSpacing,
  OBSTRUCTION_LIGHT_RGB,
  OBSTRUCTION_LIGHT_CANDELA,
  OBSTRUCTION_EXTENT_SPACING_MAX_METERS,
} from "../src/render/webgpu/lighting/ObstructionLighting";
import {
  hangarAttachments,
  hangarPlanFrom,
  hangarFootprint,
  hangarShellGeometry,
  HANGAR_PLAN_LIMITS,
  HANGAR_SITING,
} from "../src/render/webgpu/airfield/AirfieldStructures";
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

describe("hangar obstruction fixtures", () => {
  const plan = hangarPlanFrom(12_345, 0, 1.2);
  const mounts = hangarAttachments(OBLIQUE, 0, plan, OBLIQUE.elevation + 2);

  it("marks the outline no coarser than the ICAO 45 m extent spacing", () => {
    const ring = subdivideRingForExtentSpacing(mounts.roofPerimeter);
    const gaps = ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length]!;
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    });
    expect(Math.max(...gaps)).toBeLessThanOrEqual(OBSTRUCTION_EXTENT_SPACING_MAX_METERS);

    // NON-VACUITY. Without this the assertion above would also pass on a
    // hangar small enough never to need subdividing, and the subdivision could
    // be a no-op — or absent — without any test noticing. The raw corners MUST
    // violate the cap, or this whole describe block is testing nothing.
    const rawGaps = mounts.roofPerimeter.map((a, i) => {
      const b = mounts.roofPerimeter[(i + 1) % mounts.roofPerimeter.length]!;
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    });
    expect(Math.max(...rawGaps)).toBeGreaterThan(OBSTRUCTION_EXTENT_SPACING_MAX_METERS);
    expect(ring.length).toBeGreaterThan(mounts.roofPerimeter.length);
  });

  it("keeps every true corner where the geometry put it", () => {
    // FAILS IF: subdivision resamples the ring at even arc length instead of
    // per edge. That would slide points off the corners and round off the very
    // outline the lights exist to describe, while still satisfying the cap.
    const ring = subdivideRingForExtentSpacing(mounts.roofPerimeter);
    for (const corner of mounts.roofPerimeter) {
      expect(ring.some((p) =>
        Math.hypot(p[0] - corner[0], p[1] - corner[1], p[2] - corner[2]) < 1e-9)).toBe(true);
    }
  });

  it("lights the ridge ends, and they stand above the outline lights", () => {
    const fixtures = hangarObstructionFixtures(OBLIQUE, mounts);
    expect(fixtures).toHaveLength(
      mounts.ridgeEnds.length + subdivideRingForExtentSpacing(mounts.roofPerimeter).length,
    );
    // The ridge is the obstacle's highest part; the outline sits at the eaves.
    const ridge = fixtures.slice(0, mounts.ridgeEnds.length);
    const outline = fixtures.slice(mounts.ridgeEnds.length);
    for (const r of ridge) {
      for (const o of outline) expect(r.position[1]).toBeGreaterThan(o.position[1]);
    }
  });

  it("lands every fixture over its own hangar's footprint", () => {
    // THE SEAM TEST, and it covers ground neither side's own tests reach.
    // `AirfieldStructures` asserts its ATTACHMENTS sit within the footprint;
    // this asserts the FIXTURES do, which additionally exercises the
    // local->world conversion in between. A transposition or a double-applied
    // placement produces finite coordinates on the airfield and would pass
    // every other assertion in this file.
    for (let index = 0; index < 3; index += 1) {
      const plan_ = hangarPlanFrom(7, index, 1.1);
      const mounts_ = hangarAttachments(OBLIQUE, index, plan_, OBLIQUE.elevation + 2);
      const footprint = hangarFootprint(OBLIQUE, index);
      const centre = runwayToWorld(OBLIQUE, footprint.along, footprint.across);
      // Half-diagonal of the plan outline, plus a metre of slack for the
      // fixture stand. Nothing legitimate reaches beyond it.
      const reach = Math.hypot(plan_.widthMeters, plan_.depthMeters) / 2 + 1;
      for (const fixture of hangarObstructionFixtures(OBLIQUE, mounts_)) {
        const away = Math.hypot(
          fixture.position[0] - centre.x,
          fixture.position[2] - centre.z,
        );
        expect(away).toBeLessThanOrEqual(reach);
      }
    }
  });

  /**
   * The top light must clear every point of the hangar it marks — read from the
   * BUILT GEOMETRY, not from a height formula.
   *
   * **This is the one assertion here that anticipates a change nobody has made
   * yet.** 7-10 is adding ridge ventilators that stand above the ridge. My
   * fixtures mount at `ridgeEnds + OBSTRUCTION_ROOF_STAND_METERS`, so a vent
   * taller than that stand puts the highest obstruction light BELOW the highest
   * metal on the building — the one place an obstruction light must never be.
   *
   * **The near-miss that produced this test is why it reads the mesh.** The
   * change was relayed to me as affecting `heightMeters`, and my fixtures do
   * not read `heightMeters` at all. Had I checked only that field I would have
   * concluded I was unaffected and been wrong, because the hazard travels
   * through `ridgeEnds`. **A guard keyed on the field someone told me about
   * would have gone green on the change it exists to catch.** Keyed on the
   * shell's own vertices it cannot: the moment a vent is added to the geometry,
   * this fails, without anyone remembering that 7-14 needed telling.
   */
  it("puts the top light above every vertex of the hangar it marks", () => {
    for (let index = 0; index < 3; index += 1) {
      const plan_ = hangarPlanFrom(7, index, 1.1);
      const mounts_ = hangarAttachments(OBLIQUE, index, plan_, OBLIQUE.elevation + 2);
      const shell = hangarShellGeometry(plan_);

      // Shell positions are hangar-local; the attachments carry the slab and
      // the airport datum. Compare in the shell's own frame: the tallest
      // vertex against the ridge-end mount, both measured from the slab.
      let tallest = -Infinity;
      for (let p = 1; p < shell.positions.length; p += 3) {
        if (shell.positions[p]! > tallest) tallest = shell.positions[p]!;
      }
      expect(Number.isFinite(tallest)).toBe(true);

      const fixtures = hangarObstructionFixtures(OBLIQUE, mounts_);
      const highestLight = Math.max(...fixtures.map((f) => f.position[1]));
      const highestLightAboveSlab = highestLight - (OBLIQUE.elevation + 2 - OBLIQUE.elevation)
        - OBLIQUE.elevation;

      // FAILS IF: any geometry is added that out-tops the ridge by more than
      // the fixture stand. The margin is the stand itself, so this is exactly
      // "the light clears the metal", not a padded approximation.
      expect(highestLightAboveSlab).toBeGreaterThan(tallest);
    }
  });

  /**
   * The negative control for the test above, adopted from 7-10's version of it.
   *
   * **The clearance assertion alone cannot tell a working fix from a lucky
   * one.** Today the structural ridge IS the apex, so mounting at `ridgeEnds`
   * clears everything and the guard passes — and it would go on passing if a
   * raised mount later fixed the vent case for some unrelated reason. What
   * makes it discriminating is showing the clearance goes NEGATIVE at the
   * pre-fix mount height.
   *
   * **This is arithmetic on a hypothetical vent rather than a mutation**, so it
   * survives in the suite. I proved the same thing once by injecting a vertex
   * into `hangarShellGeometry` and deleting it afterwards; a guard whose
   * discrimination was demonstrated once and thrown away is a guard nobody can
   * check later. 7-10 pins the miss as a NUMBER for the same reason — a change
   * to the stand shows up as a changed magnitude, not a flipped boolean.
   */
  it("would go NEGATIVE at the pre-fix mount height, which is what makes it discriminate", () => {
    const plan_ = hangarPlanFrom(7, 0, 1.1);
    const mounts_ = hangarAttachments(OBLIQUE, 0, plan_, OBLIQUE.elevation + 2);

    // The stand is DERIVED from the shipped fixtures, not imported. It is
    // module-private, and reading it out of the artifact means a change to it
    // moves this test's numbers automatically instead of needing the constant
    // re-exported and then kept in step by hand.
    const ridgeLamp = hangarObstructionFixtures(OBLIQUE, mounts_)[0]!;
    const stand = ridgeLamp.position[1] - (OBLIQUE.elevation + mounts_.ridgeEnds[0]![1]);
    expect(stand).toBeGreaterThan(0);

    // 7-10's ventilators stand 0.7 m above the ridge.
    const VENT = 0.7;

    // PRE-FIX: mounts at the structural ridge, vent above it. Lamp sits below.
    const preFixClearance = stand - VENT;
    expect(preFixClearance).toBeLessThan(0);
    // Pinned as a MAGNITUDE, so a change to the stand shows up as a changed
    // number rather than silently keeping the sign.
    expect(preFixClearance).toBeCloseTo(-0.2, 9);

    // POST-FIX: `ridgeEnds` raised to the true apex, so clearance IS the stand.
    expect(stand).toBeGreaterThan(0);
    expect(stand).toBeCloseTo(0.5, 9);
  });

  it("uses ONE intensity, because the whole generator sits below the 45 m band", () => {
    // Not a simplification — Annex 14 grades at 45 m and this generator cannot
    // reach it. If the plan limits ever grow past that, this fails and the
    // grading question becomes real rather than staying silently wrong.
    const worstRidge = HANGAR_PLAN_LIMITS.baseEaveHeightMeters
      + (HANGAR_PLAN_LIMITS.maxBays - HANGAR_PLAN_LIMITS.minBays)
        * HANGAR_PLAN_LIMITS.eaveHeightPerBayMeters
      + HANGAR_SITING.widthMeters
        * Math.max(HANGAR_PLAN_LIMITS.gabledRiseFraction, HANGAR_PLAN_LIMITS.archedRiseFraction);
    expect(worstRidge + 6).toBeLessThan(45);

    const fixtures = hangarObstructionFixtures(OBLIQUE, mounts);
    const intensities = new Set(fixtures.map((f) => f.intensity));
    expect(intensities.size).toBe(1);
    expect([...intensities][0]).toBeCloseTo(
      OBSTRUCTION_LIGHT_CANDELA.extent * AIRFIELD_LAMP_SCENE_SCALE, 6);
  });
});

describe("hangar-face floodlights (the clustered half)", () => {
  const mountsFor = (i: number) =>
    hangarAttachments(OBLIQUE, i, hangarPlanFrom(7, i, 1.1), OBLIQUE.elevation + 2);

  it("lights the face that looks at the runway", () => {
    const runwayCentre = runwayToWorld(OBLIQUE, 0, 0);
    for (let index = 0; index < 3; index += 1) {
      const footprint = hangarFootprint(OBLIQUE, index);
      const centre = runwayToWorld(OBLIQUE, footprint.along, footprint.across);
      const centreToRunway = Math.hypot(centre.x - runwayCentre.x, centre.z - runwayCentre.z);
      const floods = hangarFaceFloodlights(OBLIQUE, mountsFor(index), index);
      expect(floods).toHaveLength(2);
      for (const flood of floods) {
        // On the near face: closer to the runway than the hangar's own centre.
        expect(Math.hypot(
          flood.position[0] - runwayCentre.x,
          flood.position[2] - runwayCentre.z,
        )).toBeLessThan(centreToRunway);
      }
    }
  });

  it("picks the face by geometry, so a re-ordered ring cannot move it", () => {
    // FAILS IF: the face is chosen by corner INDEX. `roofPerimeter`'s order is
    // 7-10's to change and its shape is not, so an index rule would follow a
    // re-ordering into the wrong wall — silently, since the floods would still
    // sit on a hangar face, just the one nobody sees on approach.
    const mounts = mountsFor(0);
    const reversed = { roofPerimeter: [...mounts.roofPerimeter].reverse() };
    const rotated = {
      roofPerimeter: [...mounts.roofPerimeter.slice(2), ...mounts.roofPerimeter.slice(0, 2)],
    };
    const key = (defs: readonly { position: readonly [number, number, number] }[]) =>
      defs.map((d) => d.position.map((v) => v.toFixed(6)).join(",")).sort().join(" | ");

    expect(key(hangarFaceFloodlights(OBLIQUE, reversed, 0)))
      .toBe(key(hangarFaceFloodlights(OBLIQUE, mounts, 0)));
    expect(key(hangarFaceFloodlights(OBLIQUE, rotated, 0)))
      .toBe(key(hangarFaceFloodlights(OBLIQUE, mounts, 0)));
  });

  it("stays in Babylon's intensity units and nowhere near the billboard scale", () => {
    // FAILS IF: someone reuses AIRFIELD_LAMP_SCENE_SCALE here, which is the
    // single most destructive available mistake in this file — the billboard
    // path's 5.7e5 into a real PointLight is a five-order error, and both
    // constants are called "intensity" one screen apart.
    const floods = hangarFaceFloodlights(OBLIQUE, mountsFor(0), 0);
    for (const flood of floods) {
      expect(flood.intensity).toBe(HANGAR_FLOOD_INTENSITY);
      // The scene's own directional lights run 1.1 to 5.2; a flood is allowed
      // to be brighter than the sun's multiplier but not by five orders.
      expect(flood.intensity).toBeLessThan(1_000);
      expect(flood.intensity * 1_000).toBeLessThan(AIRFIELD_LAMP_SCENE_SCALE);
      expect(flood.rangeMeters).toBeGreaterThan(0);
    }
  });

  it("names every flood uniquely, because the daylight gate addresses them by name", () => {
    // `setIntensity(name, ...)` returns false for an unknown name and silently
    // does nothing. Two floods sharing a name would leave one permanently lit
    // through the day, and nothing would report it.
    const names = [0, 1, 2].flatMap((i) =>
      hangarFaceFloodlights(OBLIQUE, mountsFor(i), i).map((f) => f.name));
    expect(new Set(names).size).toBe(names.length);
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
