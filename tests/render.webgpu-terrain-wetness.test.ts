import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_WETNESS_CAPILLARY_RISE_METERS,
  TERRAIN_WETNESS_LAKE_SUBMERGED_DEPTH_METERS,
  TerrainSurfacePlugin,
  terrainBankWetness,
  terrainBeachSlope,
  terrainCapillaryWetness,
  terrainLakeSubmergedFraction,
  terrainSeaSubmergedFraction,
  terrainShoreWetness,
  terrainShoreWetnessReachMeters,
  terrainWetnessField,
  type TerrainWetnessInput,
} from "../src/render/webgpu/terrain/TerrainSurfacePlugin";
import {
  WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  WATER_RUNUP_BEACH_SLOPE_MINIMUM,
  WATER_RUNUP_EXCEEDANCE,
  waterOceanShoreSwell,
  waterShoreRunupHeight,
} from "../src/render/webgpu/water/WaterShaders";
import { SEASONAL_FIELD_FAMILY } from "../src/render/webgpu/owners";
import { TERRAIN_PAGE_HYDROLOGY_ENCODING } from "../src/render/webgpu/terrain/TerrainEvolutionContract";

/**
 * `6-5` — TERRAIN WETNESS: the field.
 *
 * `3-7` shipped the RESPONSE live and verbatim (`roughness = mix(r, r*0.35 +
 * 0.02, wet)`, `albedo *= mix(1.0, 0.62, wet)`) against a uniform lane that
 * carried a constant zero and a setter that never had a caller. This file
 * measures the field that now drives it, from its three sources: ocean/lake
 * proximity, `6-2`'s wet-sand run-up persistence and the capillary rise above a
 * waterline.
 *
 * The evidence standard is D-10/D-11/D-14's: what moves is MEASURED against a
 * reconstruction of the pre-change law, never asserted.
 */

/** The shipped ocean config's sea state — 12 m/s over 120 km of fetch. */
const SHIPPED_SWELL = waterOceanShoreSwell(12, 120_000);
/** A 1:12 beach face: `tan(beta)` for a typical sand shore. */
const BEACH_SLOPE = 1 / 12;
const CLOCK = 137.25;

function field(overrides: Partial<TerrainWetnessInput> = {}): TerrainWetnessInput {
  return {
    freeboardMeters: 0,
    beachSlope: BEACH_SLOPE,
    swashExcursionMeters: SHIPPED_SWELL.excursionMeters,
    radianFrequency: SHIPPED_SWELL.radianFrequency,
    runupClockSeconds: CLOCK,
    lakeDepthMeters: null,
    shoreDistanceMeters: null,
    ...overrides,
  };
}

/**
 * The law as it stood BEFORE 6-5, reconstructed from the shipped fragment:
 * `wetness = max(clamp(uniforms.terrainSurfaceWetness.x, 0, 1), submerged)`
 * with `x` a constant zero, and `submerged` the sea-level ramp. This is the
 * baseline every "what moved" measurement below is taken against.
 */
function preItemWetness(freeboardMeters: number): number {
  return terrainSeaSubmergedFraction(freeboardMeters);
}

const PLUGIN_SOURCE = readFileSync(
  join(__dirname, "..", "src/render/webgpu/terrain/TerrainSurfacePlugin.ts"),
  "utf8",
);

function fragmentSource(): string {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("terrain-wetness-test", scene);
  const plugin = new TerrainSurfacePlugin(material);
  try {
    const code = plugin.getCustomCode("fragment", ShaderLanguage.WGSL);
    expect(code).not.toBeNull();
    return Object.values(code as Record<string, string>).join("\n");
  } finally {
    material.dispose(true, true);
    scene.dispose();
    engine.dispose();
  }
}

function withPlugin<T>(body: (plugin: TerrainSurfacePlugin, scene: Scene) => T): T {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("terrain-wetness-plugin", scene);
  const plugin = new TerrainSurfacePlugin(material);
  try {
    return body(plugin, scene);
  } finally {
    material.dispose(true, true);
    scene.dispose();
    engine.dispose();
  }
}

describe("6-5 terrain wetness: the field's range and shape", () => {
  it("stays inside [0, 1] across every driver, including absurd ones", () => {
    const freeboards = [-500, -3, -1, -0.2, 0, 0.05, 0.4, 1.2, 4, 40, 4_000];
    const slopes = [0, 1e-6, 0.004, BEACH_SLOPE, 0.35, 1.4, 90];
    const excursions = [0, 0.001, 1, SHIPPED_SWELL.excursionMeters, 400];
    const clocks = [0, 0.37, 3.1, 137.25, 4_095.9];
    const lakes = [null, 0, 0.001, 0.5, 3, 900];
    const shores = [null, -900, -4, 0, 0.5, 12, 8_191.75];
    let samples = 0;
    for (const freeboardMeters of freeboards) {
      for (const beachSlope of slopes) {
        for (const swashExcursionMeters of excursions) {
          for (const runupClockSeconds of clocks) {
            for (const lakeDepthMeters of lakes) {
              for (const shoreDistanceMeters of shores) {
                const result = terrainWetnessField(field({
                  freeboardMeters,
                  beachSlope,
                  swashExcursionMeters,
                  runupClockSeconds,
                  lakeDepthMeters,
                  shoreDistanceMeters,
                }));
                expect(Number.isFinite(result.wetness)).toBe(true);
                expect(result.wetness).toBeGreaterThanOrEqual(0);
                expect(result.wetness).toBeLessThanOrEqual(1);
                expect(result.submerged).toBeGreaterThanOrEqual(0);
                expect(result.submerged).toBeLessThanOrEqual(1);
                // Wetness is a MAXIMUM over terms that include `submerged`, so
                // it can never fall below it — a submerged bed that reads drier
                // than its own water column would be the 3-7 grey-lake defect
                // returning.
                expect(result.wetness).toBeGreaterThanOrEqual(result.submerged - 1e-12);
                samples += 1;
              }
            }
          }
        }
      }
    }
    // The sweep is only worth having if it is actually a sweep.
    expect(samples).toBe(
      freeboards.length * slopes.length * excursions.length
      * clocks.length * lakes.length * shores.length,
    );
  });

  it("adds no discontinuity of its own — the only step is the one 6-2 owns", () => {
    // 6-2 measures exactly one discontinuity per beat in `waterShoreWetness`:
    // the instant the uprush arrives, which is real (dry sand darkens the
    // moment water reaches it) and is the ONLY one it permits. Composition must
    // not add a second, and in particular the capillary and bank terms must not
    // cut a step of their own. Measured, not asserted: the sweep counts the
    // composed field's steps and the run-up's own steps and requires the same
    // number at the same place.
    const runup = waterShoreRunupHeight(SHIPPED_SWELL, BEACH_SLOPE);
    const step = 1e-4;
    const sweep = (
      value: (freeboardMeters: number) => number,
    ): { jumps: number; largest: number; at: number } => {
      let previous = value(-0.5);
      let jumps = 0;
      let largest = 0;
      let at = Number.NaN;
      for (let h = -0.5 + step; h <= runup * WATER_RUNUP_EXCEEDANCE + 0.5; h += step) {
        const current = value(h);
        const delta = Math.abs(current - previous);
        if (delta > largest) {
          largest = delta;
          at = h;
        }
        // A 1e-4 m step cannot move any continuous term here by 0.02: the
        // steepest is the swash front, whose softness is 0.06 R = 6.4 cm.
        if (delta > 0.02) jumps += 1;
        previous = current;
      }
      return { jumps, largest, at };
    };
    for (const phaseSeconds of [0, 1.1, 2.3, 3.7, 5.2, 6.9]) {
      const composed = sweep((h) => terrainWetnessField(field({
        freeboardMeters: h,
        runupClockSeconds: phaseSeconds,
      })).wetness);
      const glassy = sweep((h) => terrainWetnessField(field({
        freeboardMeters: h,
        runupClockSeconds: phaseSeconds,
        swashExcursionMeters: 0,
      })).wetness);
      expect(composed.jumps, `phase ${phaseSeconds}: ${composed.jumps} steps`)
        .toBeLessThanOrEqual(1);
      // Everything 6-5 adds ON TOP of 6-2 is smooth: with the swell removed,
      // the sea ramp, the capillary fringe and their maximum have no step at
      // all, at any phase.
      expect(glassy.jumps, `glassy phase ${phaseSeconds}`).toBe(0);
      expect(glassy.largest).toBeLessThan(1e-3);
      if (composed.jumps === 1) {
        // And the one step is 6-2's uprush arrival, which lands where the
        // dry-time branch switches — inside the swash zone, never at the
        // waterline and never at the top of the capillary fringe.
        expect(composed.largest).toBeGreaterThan(0.02);
        expect(composed.largest).toBeLessThan(0.35);
        expect(composed.at).toBeGreaterThan(0);
        expect(composed.at).toBeLessThan(runup);
      }
    }
  });

  it("is monotone non-increasing in freeboard: a band, never a ring", () => {
    for (const phaseSeconds of [0.4, 2.2, 4.8, 6.1]) {
      let previous = Number.POSITIVE_INFINITY;
      for (let h = -2; h <= 3; h += 0.002) {
        const current = terrainWetnessField(field({
          freeboardMeters: h,
          runupClockSeconds: phaseSeconds,
        })).wetness;
        expect(current).toBeLessThanOrEqual(previous + 1e-9);
        previous = current;
      }
    }
  });

  it("reaches exactly 1 at and below the waterline and exactly 0 well above it", () => {
    expect(terrainWetnessField(field({ freeboardMeters: -0.001 })).wetness).toBe(1);
    expect(terrainWetnessField(field({ freeboardMeters: -80 })).wetness).toBe(1);
    // Above the swash exceedance limit AND above the capillary fringe there is
    // no source left, so the field is exactly zero — which is what makes the
    // 3-7 response a no-op on dry ground rather than a faint permanent stain.
    const runup = waterShoreRunupHeight(SHIPPED_SWELL, BEACH_SLOPE);
    const dry = runup * WATER_RUNUP_EXCEEDANCE + TERRAIN_WETNESS_CAPILLARY_RISE_METERS + 1;
    expect(terrainWetnessField(field({ freeboardMeters: dry })).wetness).toBe(0);
    expect(terrainWetnessField(field({ freeboardMeters: dry })).submerged).toBe(0);
  });
});

describe("6-5 terrain wetness: the three sources, measured one at a time", () => {
  it("source 2 (6-2's run-up) reaches higher up a beach than capillarity alone", () => {
    // The swash band is Hunt's R times the Rayleigh exceedance; the capillary
    // fringe is a fixed height. On the shipped sea state at 1:12 the two are
    // separable, which is what makes this an ablation rather than a tautology.
    const runup = waterShoreRunupHeight(SHIPPED_SWELL, BEACH_SLOPE);
    expect(runup * WATER_RUNUP_EXCEEDANCE)
      .toBeGreaterThan(TERRAIN_WETNESS_CAPILLARY_RISE_METERS * 2);
    const probe = runup;
    // With the swell: inside the swash zone.
    const wet = terrainWetnessField(field({ freeboardMeters: probe })).wetness;
    // Glassy sea: source 2 returns exactly 0, so only capillarity is left, and
    // this probe is far above the fringe.
    const glassy = terrainWetnessField(field({
      freeboardMeters: probe,
      swashExcursionMeters: 0,
    })).wetness;
    expect(glassy).toBe(0);
    expect(wet).toBeGreaterThan(0.2);
  });

  it("source 3 (capillary rise) saturates the fringe the 3-7 ramp only grazes", () => {
    // 3-7's sea ramp already reached 1 m above sea level, LINEARLY: 0.45 at
    // 10 cm, where a saturated capillary fringe should read ~0.8. The fringe is
    // therefore not a duplicate of it — it is the term that makes the first
    // decimetre above a waterline read as wet sand instead of as half-wet sand,
    // and it is the same law the lake bank reuses where no sea ramp exists.
    for (const h of [0, 0.05, 0.15, 0.3]) {
      const value = terrainWetnessField(field({
        freeboardMeters: h,
        swashExcursionMeters: 0,
      })).wetness;
      expect(value).toBe(Math.max(
        terrainSeaSubmergedFraction(h),
        terrainCapillaryWetness(h),
      ));
    }
    expect(terrainCapillaryWetness(0.1)).toBeGreaterThan(terrainSeaSubmergedFraction(0.1));
    expect(terrainCapillaryWetness(0.1)).toBeCloseTo(0.802, 3);
    expect(terrainSeaSubmergedFraction(0.1)).toBeCloseTo(0.45, 12);
    expect(terrainCapillaryWetness(0)).toBe(1);
    expect(terrainCapillaryWetness(TERRAIN_WETNESS_CAPILLARY_RISE_METERS)).toBe(0);
    expect(terrainCapillaryWetness(-4)).toBe(1);
    // Strictly falling in between: a fringe, not a second step.
    expect(terrainCapillaryWetness(0.1))
      .toBeGreaterThan(terrainCapillaryWetness(0.2));
  });

  it("source 1 (lake depth) wets a bed the sea-level term cannot reach", () => {
    // A lake at 400 m. The sea-level term reads -400 m of freeboard, so it
    // contributes exactly zero, and before 6-5 this bed rendered as the WATER
    // biome's primary material — DRY SAND, the brightest entry in the table.
    const alpineLake = field({
      freeboardMeters: 400,
      lakeDepthMeters: 3.4,
      shoreDistanceMeters: -18,
    });
    expect(preItemWetness(400)).toBe(0);
    const result = terrainWetnessField(alpineLake);
    expect(result.wetness).toBe(1);
    // And the silt/biofilm tint follows, because there IS a water column here.
    expect(result.submerged).toBe(1);
  });

  it("source 1's bank half carries the same waterline onto dry ground", () => {
    // The signed shore distance is transformed on the SAME wet mask that
    // defines lakeDepth > 0, so the bed and the bank are one field.
    const bankAt = (distanceMeters: number): number => terrainWetnessField(field({
      freeboardMeters: 400,
      lakeDepthMeters: 0,
      shoreDistanceMeters: distanceMeters,
    })).wetness;
    expect(bankAt(-1)).toBe(1);
    expect(bankAt(0)).toBe(1);
    expect(bankAt(0.4)).toBeGreaterThan(0);
    expect(bankAt(0.4)).toBeLessThan(1);
    // The band's width is the capillary rise divided by the local slope, so a
    // marsh is wet across its flat and a cut bank for a hand's width.
    const flatBandMeters = TERRAIN_WETNESS_CAPILLARY_RISE_METERS
      / WATER_RUNUP_BEACH_SLOPE_MINIMUM;
    const steepBandMeters = TERRAIN_WETNESS_CAPILLARY_RISE_METERS
      / WATER_RUNUP_BEACH_SLOPE_MAXIMUM;
    expect(terrainBankWetness(flatBandMeters * 0.5, 0)).toBeGreaterThan(0);
    expect(terrainBankWetness(flatBandMeters + 1, 0)).toBe(0);
    expect(terrainBankWetness(steepBandMeters + 0.01, 10)).toBe(0);
    expect(flatBandMeters / steepBandMeters).toBeCloseTo(43.75, 2);
    // Far from any water — including the no-lake page's 8,191.75 m sentinel —
    // the bank term is exactly zero rather than a faint everywhere-damp.
    const sentinel = 32_767 * TERRAIN_PAGE_HYDROLOGY_ENCODING.shoreDistanceMetersPerUnit;
    expect(terrainBankWetness(sentinel, BEACH_SLOPE)).toBe(0);
  });

  it("the lake ramp is depth-driven, so a margin is not painted as a deep bed", () => {
    expect(terrainLakeSubmergedFraction(0)).toBe(0);
    expect(terrainLakeSubmergedFraction(TERRAIN_WETNESS_LAKE_SUBMERGED_DEPTH_METERS)).toBe(1);
    expect(terrainLakeSubmergedFraction(40)).toBe(1);
    expect(terrainLakeSubmergedFraction(0.25)).toBeCloseTo(0.25, 12);
    // The tint follows the column, which is the physical statement: absorption
    // is Beer-Lambert in depth, so 25 cm of water is not 3 m of water.
    const shallow = terrainWetnessField(field({
      freeboardMeters: 400, lakeDepthMeters: 0.25, shoreDistanceMeters: -0.5,
    }));
    const deep = terrainWetnessField(field({
      freeboardMeters: 400, lakeDepthMeters: 6, shoreDistanceMeters: -40,
    }));
    expect(shallow.submerged).toBeLessThan(deep.submerged);
  });

  it("skips the swash ALU inland through a bound that is EXACT, not a gate", () => {
    // The early-out is an economy, and an economy that changes a pixel is a
    // bug. So it is measured against the unguarded law: at every slope the
    // clamp admits, the true field must already be zero at the bound.
    const reach = terrainShoreWetnessReachMeters(SHIPPED_SWELL.excursionMeters);
    expect(reach).toBeCloseTo(
      SHIPPED_SWELL.excursionMeters
        * WATER_RUNUP_BEACH_SLOPE_MAXIMUM * WATER_RUNUP_EXCEEDANCE,
      12,
    );
    expect(reach).toBeCloseTo(6.063, 3);
    // Every airport is built at sea level + 10 m or higher, so no runway
    // fragment ever enters the term at all.
    expect(reach).toBeLessThan(10);
    for (const beachSlope of [0, 0.004, 0.05, BEACH_SLOPE, 0.2, 0.35, 0.9, 40]) {
      for (const runupClockSeconds of [0, 1.7, 3.4, 5.9]) {
        // At the bound the unguarded law is already zero...
        expect(terrainShoreWetness(
          reach, beachSlope, SHIPPED_SWELL.excursionMeters,
          SHIPPED_SWELL.radianFrequency, runupClockSeconds,
        )).toBe(0);
        // ...and just inside it the term is still live for the steepest face,
        // so the bound is TIGHT rather than merely safe.
        expect(terrainShoreWetness(
          reach - 1e-3, WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
          SHIPPED_SWELL.excursionMeters, SHIPPED_SWELL.radianFrequency,
          runupClockSeconds,
        )).toBeGreaterThan(0);
      }
    }
    // A glassy sea collapses the bound to the capillary rise alone.
    expect(terrainShoreWetnessReachMeters(0)).toBe(TERRAIN_WETNESS_CAPILLARY_RISE_METERS);
    // And the shader carries the same bound, from the same two constants.
    const code = fragmentSource();
    expect(code).toContain(
      "* WATER_RUNUP_BEACH_SLOPE_MAXIMUM * WATER_RUNUP_EXCEEDANCE);",
    );
    expect(code).toContain("if (freeboardMeters > reach) { return 0.0; }");
  });

  it("takes the beach slope from a terrain NORMAL, never from bathymetry", () => {
    // D-12 is explicit: the 16 m bathymetry texel is the resolution floor 6-2's
    // shore band had to go wide to hide, and the terrain fragment already
    // carries the real gradient. `tan(beta) = |grad h|` from a unit normal.
    expect(terrainBeachSlope(1)).toBe(0);
    expect(terrainBeachSlope(Math.SQRT1_2)).toBeCloseTo(1, 12);
    expect(terrainBeachSlope(Math.cos(Math.atan(BEACH_SLOPE)))).toBeCloseTo(BEACH_SLOPE, 12);
    // A vertical face is finite, not a division by zero.
    expect(Number.isFinite(terrainBeachSlope(0))).toBe(true);
    expect(terrainBeachSlope(0)).toBeGreaterThan(1_000);
    // And the shader reads its own geometric normal, not the bathymetry
    // clipmap — which the terrain material does not even bind.
    const code = fragmentSource();
    expect(code).toContain("terrainSurfaceBeachSlope(terrainGeometricNormal.y)");
    // No bathymetry resource is declared or sampled anywhere in this shader —
    // the terrain material does not even bind the clipmap.
    expect(code).not.toMatch(/var\s+\w*[Bb]athymetry\w*\s*:/u);
    expect(code).not.toMatch(/texture\w*\([^)]*[Bb]athymetry/u);
  });
});

describe("6-5 terrain wetness: analytic worlds and what moves in them", () => {
  it("contributes nothing from the unbound channels", () => {
    // The lake and bank terms are the eroded-only half. In an analytic world
    // the channels are not bound at all (the define removes them), which the
    // oracle models as null — and null must be exactly zero, not a small
    // fallback that would drift the shipping default.
    for (const freeboardMeters of [-9, -0.4, 0, 0.3, 2, 900]) {
      const analytic = terrainWetnessField(field({ freeboardMeters }));
      const eroded = terrainWetnessField(field({
        freeboardMeters,
        lakeDepthMeters: 0,
        shoreDistanceMeters: 8_191.75,
      }));
      expect(eroded.wetness).toBe(analytic.wetness);
      expect(eroded.submerged).toBe(analytic.submerged);
    }
  });

  it("measures the analytic movement rather than asserting it away", () => {
    // 6-5's ocean half IS analytic-visible by design (D-12: the swash sheet
    // above the waterline can only be drawn by the ground). What matters is
    // therefore not "nothing moved" but HOW MUCH and WHERE — measured against
    // the reconstructed pre-6-5 law, over an elevation sweep on a 1:12 beach.
    const runup = waterShoreRunupHeight(SHIPPED_SWELL, BEACH_SLOPE);
    const reach = runup * WATER_RUNUP_EXCEEDANCE;
    let moved = 0;
    let unchanged = 0;
    let largest = 0;
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    const total = 200_000;
    // -20 m to +200 m of freeboard: the whole coastal range, sampled evenly.
    for (let index = 0; index < total; index += 1) {
      const freeboardMeters = -20 + (index / (total - 1)) * 220;
      const before = preItemWetness(freeboardMeters);
      const after = terrainWetnessField(field({ freeboardMeters })).wetness;
      const delta = Math.abs(after - before);
      if (delta > 1e-9) {
        moved += 1;
        largest = Math.max(largest, delta);
        highest = Math.max(highest, freeboardMeters);
        lowest = Math.min(lowest, freeboardMeters);
      } else {
        unchanged += 1;
      }
    }
    // The movement is CONFINED. Everything above the swash reach plus the
    // capillary fringe is byte-identical to the pre-6-5 law, and everything
    // below -1 m already read 1.
    expect(highest).toBeLessThanOrEqual(reach + TERRAIN_WETNESS_CAPILLARY_RISE_METERS + 1e-3);
    // MEASURED on the shipped sea state (Hs 2.12 m at 77.5 m) and a 1:12 face:
    // R = 1.069 m, so the swash reach is 1.444 m and nothing above it moves.
    expect(reach).toBeCloseTo(1.4437, 3);
    expect(highest).toBeCloseTo(1.4435, 3);
    // Below the window the old ramp already saturated at 1, so the movement is
    // bounded on BOTH sides: a 2.44 m band of freeboard out of a 220 m sweep.
    expect(lowest).toBeCloseTo(-0.9996, 3);
    const movedShare = moved / total;
    expect(movedShare).toBeCloseTo(0.0111, 4);
    expect(unchanged / total).toBeGreaterThan(0.98);
    // And the largest single change is nearly a full wetting, which is the
    // point: sand the old law read as 8% wet inside the swash zone now reads
    // as the wet sand a bore just ran over.
    expect(largest).toBeCloseTo(0.9245, 3);
    // The runway cannot be caught by this: airports are built at least 10 m
    // above sea level (`buildAirport`'s own floor), an order of magnitude above
    // the window measured here.
    expect(highest).toBeLessThan(10);
  });

  it("leaves the submerged tint below sea level exactly where 3-7 put it", () => {
    // The wetting half moves in the shallow band; the water-column TINT must
    // not, or every existing seabed pixel would shift colour.
    for (let h = -30; h <= 0; h += 0.01) {
      expect(terrainWetnessField(field({ freeboardMeters: h })).submerged)
        .toBeCloseTo(preItemWetness(h), 12);
    }
  });
});

describe("6-5 terrain wetness: it is NOT a seasonal field", () => {
  it("is absent from SEASONAL_FIELD_FAMILY and takes no clock in any signature", () => {
    // §1.8: a seasonal field takes `dayOfYear`/`EnvironmentClock` in a TYPE
    // position from its first write, never as a retrofit. This field is not
    // seasonal — no precipitation model exists in the project, and every source
    // is a water-body proximity term driven by a water level and a sea state,
    // not by a calendar. Recording that decision executably is what stops it
    // from being quietly retrofitted (which the rule forbids) later.
    expect(SEASONAL_FIELD_FAMILY.map((member) => member.artifact))
      .not.toContain("terrain-wetness-field");
    const signature = PLUGIN_SOURCE.slice(
      PLUGIN_SOURCE.indexOf("export function terrainWetnessField("),
      PLUGIN_SOURCE.indexOf("/** Height-gradient scales from atlas-texel space"),
    );
    expect(signature.length).toBeGreaterThan(200);
    expect(signature).not.toMatch(/dayOfYear|EnvironmentClock|FoliageSeason/u);
    const inputBlock = PLUGIN_SOURCE.slice(
      PLUGIN_SOURCE.indexOf("export interface TerrainWetnessInput {"),
      PLUGIN_SOURCE.indexOf("export interface TerrainWetnessField {"),
    );
    expect(inputBlock.length).toBeGreaterThan(200);
    expect(inputBlock).not.toMatch(/dayOfYear|EnvironmentClock|FoliageSeason/u);
    // The decision itself is recorded beside the field, not only here.
    expect(PLUGIN_SOURCE).toContain("NOT SEASONAL");
    // And the WGSL half reads no seasonal uniform either — the season lanes are
    // one block above it in the same shader, so this is a real risk.
    const code = fragmentSource();
    const start = code.indexOf("fn terrainSurfaceShoreWetness(");
    const end = code.indexOf("fn terrainSurfaceLakeWetness(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(code.slice(start, end)).not.toContain("terrainMaterialSeason");
  });
});

describe("6-5 terrain wetness: the shader, the bindings and the house traps", () => {
  it("composes 6-2's block instead of restating its laws", () => {
    const code = fragmentSource();
    // One definition of the run-up, and it is the water module's.
    expect(code).toContain("fn waterShoreWetness(");
    expect(code).toContain("fn waterShoreRunupHeight(");
    expect(code).toContain("fn waterShoreRunupPhase(");
    // The terrain half calls them; it does not re-derive Hunt's law, the
    // exceedance tail or the drying decay.
    expect(code).toContain("waterShoreWetness(freeboardMeters, swashHeight, phase, radianFrequency)");
    expect(code).not.toContain("WATER_RUNUP_DRYING_SECONDS: f32 = 15.0;\nconst WATER_RUNUP_DRYING");
    // And the TypeScript oracle imports the same functions rather than copying
    // their bodies — the D-13 discipline, as a source scan.
    expect(PLUGIN_SOURCE).toContain("waterShoreWetness,");
    expect(PLUGIN_SOURCE).toContain("waterShoreRunupHeight,");
    expect(PLUGIN_SOURCE).toContain("waterShoreRunupPhase,");
    expect(PLUGIN_SOURCE).not.toMatch(/const\s+WATER_RUNUP_EXCEEDANCE\s*=/u);
  });

  it("keeps every house trap shut in the new WGSL", () => {
    const code = fragmentSource();
    const start = code.indexOf("fn terrainSurfaceBeachSlope(");
    expect(start).toBeGreaterThan(-1);
    const block = code.slice(start);
    // No reversed smoothstep: a falling edge is `1 - smoothstep(low, high, x)`.
    const stripped = block.replace(/\/\/.*$/gm, "");
    const reversed: string[] = [];
    for (const match of stripped.matchAll(/smoothstep\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,/g)) {
      if (Number(match[2]) <= Number(match[1])) reversed.push(match[0]);
    }
    expect(reversed, `reversed smoothstep: ${reversed.join(", ")}`).toEqual([]);
    // No sin-fract hashes: they collapse to rows at world-anchored ids.
    expect(stripped).not.toMatch(/fract\s*\(\s*sin\s*\(/u);
    // No backticks anywhere in a WGSL template literal — the JS parser reads
    // them as the end of the literal, and the failure is a syntax error many
    // lines away from the cause.
    expect(code).not.toContain("`");
    // And the CPU oracle's own smoothstep throws on a reversed pair rather
    // than silently returning a hard step.
    expect(PLUGIN_SOURCE).toContain("smoothstep bounds must satisfy high > low");
  });

  it("declares the lake-depth channel with no companion sampler", () => {
    const code = fragmentSource();
    const guard = code.indexOf("#ifdef TERRAIN_SURFACE_HYDROLOGY_CHANNELS");
    expect(guard).toBeGreaterThan(-1);
    expect(code.indexOf("var terrainLakeDepthAtlas: texture_2d<f32>;"))
      .toBeGreaterThan(guard);
    // The sampler budget is the scarce one. An f32 texture read only by
    // textureLoad needs no sampler binding, exactly as 6-6's r16sint channel
    // and 4-4's r32float height atlas need none.
    expect(code).not.toContain("terrainLakeDepthAtlasSampler");
    expect(code).toContain("textureLoad(terrainLakeDepthAtlas, texel, 0).r");
    expect(code).not.toContain("textureSample(terrainLakeDepthAtlas");
    expect(code).not.toContain("textureSampleLevel(terrainLakeDepthAtlas");
    // The arithmetic, pinned: 8 sampled textures analytic, 10 eroded, against
    // WebGPU's 16-per-stage base limit, and 8 samplers in both.
    const arrays = code.match(/^var\s+terrain\w+:\s*texture_2d_array/gmu) ?? [];
    const planar = code.match(/^var\s+terrain\w+:\s*texture_2d</gmu) ?? [];
    const samplers = code.match(/^var\s+terrain\w+Sampler:\s*sampler;/gmu) ?? [];
    // The emitted source carries every permutation's text, so this counts the
    // ERODED maximum: 2 material arrays + 8 planar = 10 sampled textures, of
    // which the two behind the hydrology guard are absent from the shipping
    // analytic build (8 there). Samplers stay at 8 in both, because the two
    // hydrology channels declare none.
    expect(arrays.length).toBe(2);
    expect(planar.length).toBe(8);
    expect(arrays.length + planar.length).toBe(10);
    expect(samplers.length).toBe(8);
    const guarded = code.slice(guard, code.indexOf("fn terrainSurfacePageSplat("));
    expect(guarded.match(/^var\s+terrain\w+:\s*texture_2d</gmu)?.length).toBe(2);
    expect(guarded).not.toMatch(/^var\s+terrain\w+Sampler:\s*sampler;/mu);
  });

  it("turns the lake half on only when BOTH hydrology channels are bound", () => {
    withPlugin((plugin, scene) => {
      const shape = {
        atlasEdge: 272, slotEdge: 136, core: 128, gutter: 4, gridEdge: 2,
        basePageExtentMeters: 512,
      };
      const page = (): RawTexture => RawTexture.CreateRGBATexture(
        new Uint8Array(4), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE,
      );
      const defines: Record<string, boolean> = {};
      const base = [page(), page(), page(), [page(), page(), page()]] as const;
      // Shore distance without lake depth: the two describe one waterline and
      // must not be read from different frames, so the define stays off.
      plugin.setChannelAtlas(base[0], base[1], base[2], base[3], page(), null, shape);
      plugin.prepareDefines(defines as never);
      expect(defines["TERRAIN_SURFACE_HYDROLOGY_CHANNELS"]).toBe(false);
      plugin.setChannelAtlas(base[0], base[1], base[2], base[3], null, page(), shape);
      plugin.prepareDefines(defines as never);
      expect(defines["TERRAIN_SURFACE_HYDROLOGY_CHANNELS"]).toBe(false);
      plugin.setChannelAtlas(base[0], base[1], base[2], base[3], page(), page(), shape);
      plugin.prepareDefines(defines as never);
      expect(defines["TERRAIN_SURFACE_HYDROLOGY_CHANNELS"]).toBe(true);
    });
  });

  it("declares the define in the CONSTRUCTOR's map, or the #ifdef reads false", () => {
    // 6-6 lost time to exactly this: a define a MaterialPluginBase constructor
    // does not list is never registered with the material, so its `#ifdef`
    // reads false in silence and the block vanishes from a shader that was
    // supposed to have it. `prepareDefines` alone cannot catch it — which is
    // why the GPU suite asserts the COMPILED fragment source as well.
    const constructorBlock = PLUGIN_SOURCE.slice(
      PLUGIN_SOURCE.indexOf("        TERRAIN_SURFACE_TRIPLANAR: false,"),
      PLUGIN_SOURCE.indexOf("        TERRAIN_SURFACE_CDLOD: false,"),
    );
    expect(constructorBlock).toContain("TERRAIN_SURFACE_HYDROLOGY_CHANNELS: false,");
  });

  it("drives the two 3-7 response instructions from the field, verbatim", () => {
    const code = fragmentSource();
    // The response is 3-7's, character for character; only its driver changed.
    expect(code).toContain(
      "terrainRoughness = mix(terrainRoughness, terrainRoughness * 0.35 + 0.02, terrainWetness);",
    );
    expect(code).toContain("terrainAlbedo *= mix(1.0, 0.62, terrainWetness);");
    // And the driver is no longer the constant lane.
    expect(code).not.toContain("max(clamp(uniforms.terrainSurfaceWetness.x, 0.0, 1.0)");
    expect(code).toContain("uniforms.terrainSurfaceShoreClock.x");
    expect(PLUGIN_SOURCE).not.toContain("setWetness(");
  });

  it("publishes the sea state through 6-2's own type, wrapping the clock in f64", () => {
    withPlugin((plugin) => {
      // The wrap is 6-2's `waterRunupClock`, applied on the CPU where the clock
      // is still f64: an unwrapped session clock loses phase resolution in an
      // f32 uniform long before the 4096 s wrap would be visible against surf.
      expect(() => plugin.setShoreWetness(SHIPPED_SWELL, 1e9)).not.toThrow();
      expect(() => plugin.setShoreWetness(SHIPPED_SWELL, Number.NaN)).not.toThrow();
      expect(PLUGIN_SOURCE).toContain("waterRunupClock(timeSeconds)");
    });
  });
});
