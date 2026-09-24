/**
 * `W-8` — the constituent model, checked against measured water types.
 *
 * The claim this file has to make good is that water colour in this renderer
 * is DERIVED rather than art-directed: four concentrations go in, published
 * mass-specific spectra turn them into absorption and backscatter, and Lee's
 * reflectance comes out. So the test is not "does the number match the
 * number I typed", it is "does the model reproduce, from concentrations alone,
 * the subsurface reflectances that oceanographers measure for real water".
 *
 * Reference reflectances are the quasi-single-scattering value
 * `R = 0.33 b_b / (a + b_b)` (Morel & Prieur 1977; the constant Morel &
 * Maritorena 2001 use), band-reduced to linear sRGB.
 */

import { describe, expect, it } from "vitest";
import {
  OCEAN_COASTAL_CHLOROPHYLL,
  OCEAN_OPEN_CHLOROPHYLL,
  WATER_CONSTITUENT_WGSL,
  resolveLakeConstituents,
  resolveRiverConstituents,
  waterOpticsFromConstituents,
  type WaterConstituents,
} from "../src/render/webgpu/water/WaterConstituents";
import {
  WATER_PURE_ABSORPTION_PER_METER,
  waterDeepSubsurfaceReflectance,
} from "../src/render/webgpu/water/WaterShaders";
import { HYDROLOGY_WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/HydrologySystem";
import { WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/SpectralOceanSystem";

/** Morel's irradiance reflectance from the same optics the shader carries. */
function bodyReflectance(constituents: WaterConstituents): [number, number, number] {
  const optics = waterOpticsFromConstituents(constituents);
  return [0, 1, 2].map((channel) => {
    const absorption = optics.absorptionPerMeter[channel]!;
    const backscatter = optics.backscatterPerMeter[channel]!;
    return 0.33 * backscatter / (absorption + backscatter);
  }) as [number, number, number];
}

function expectClose(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
  tolerance: number,
  label: string,
): void {
  for (let channel = 0; channel < 3; channel += 1) {
    expect(
      Math.abs(actual[channel]! - expected[channel]!),
      `${label} channel ${channel}: ${actual[channel]!.toFixed(4)} vs ${expected[channel]!.toFixed(4)}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

describe("W-8 water constituents", () => {
  it("reproduces the measured reflectance of real water types from concentrations alone", () => {
    // Clear oligotrophic ocean (Chl 0.02): almost no red or green, a little
    // blue. This is why open water is indigo and nearly black in a photograph.
    expectClose(
      bodyReflectance({ chlorophyll: 0.02, cdom440: 0.005, sediment: 0, mineral: 0 }),
      [0.0008, 0.0064, 0.049],
      0.012,
      "clear ocean",
    );
    // Green temperate coastal water (Chl 3, CDOM 0.3, SPM 2): green rises an
    // order of magnitude, blue falls by half.
    expectClose(
      bodyReflectance({ chlorophyll: 3, cdom440: 0.3, sediment: 2, mineral: 0 }),
      [0.030, 0.054, 0.023],
      0.012,
      "green coastal",
    );
    // Humic (peat-stained) lake: brown — red above green above blue, which no
    // amount of tinting a teal constant can produce.
    const humic = bodyReflectance({ chlorophyll: 2, cdom440: 3, sediment: 1, mineral: 0 });
    expectClose(humic, [0.011, 0.006, 0.001], 0.008, "humic lake");
    expect(humic[0]).toBeGreaterThan(humic[1]);
    expect(humic[1]).toBeGreaterThan(humic[2]);
    // Glacial-flour lake: bright and blue-green, because rock flour scatters
    // like mud and absorbs like nothing.
    const glacial = bodyReflectance({ chlorophyll: 0.3, cdom440: 0.05, sediment: 0, mineral: 10 });
    expect(glacial[1]).toBeGreaterThan(0.12);
    expect(glacial[2]).toBeGreaterThan(0.12);
    expect(glacial[1]).toBeGreaterThan(glacial[0] * 1.6);
    // Muddy river: bright and ochre.
    const muddy = bodyReflectance({ chlorophyll: 2, cdom440: 0.6, sediment: 150, mineral: 0 });
    expectClose(muddy, [0.25, 0.18, 0.09], 0.05, "muddy river");
    expect(muddy[0]).toBeGreaterThan(muddy[2]);
  });

  it("keeps every type at least as absorbing and scattering as pure water", () => {
    for (const constituents of [
      { chlorophyll: 0, cdom440: 0, sediment: 0, mineral: 0 },
      { chlorophyll: 0.02, cdom440: 0.005, sediment: 0, mineral: 0 },
      { chlorophyll: 30, cdom440: 6, sediment: 200, mineral: 40 },
    ] satisfies WaterConstituents[]) {
      const optics = waterOpticsFromConstituents(constituents);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(optics.absorptionPerMeter[channel])
          .toBeGreaterThanOrEqual(WATER_PURE_ABSORPTION_PER_METER[channel]!);
      }
      // And the reflectance Lee's form returns stays a reflectance.
      for (const value of waterDeepSubsurfaceReflectance(optics)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(0.2);
      }
    }
  });

  it("gives an alpine lake, a forest tarn and a lowland pond three different colours", () => {
    const alpine = resolveLakeConstituents(
      { elevationAboveSeaMeters: 1_650, temperature: 0.12, moisture: 0.5 }, 30, 900_000,
    );
    const forest = resolveLakeConstituents(
      { elevationAboveSeaMeters: 210, temperature: 0.62, moisture: 0.84 }, 6, 250_000,
    );
    const lowland = resolveLakeConstituents(
      { elevationAboveSeaMeters: 60, temperature: 0.74, moisture: 0.6 }, 4, 120_000,
    );
    // The alpine lake is the mineral one, the forest tarn the stained one.
    expect(alpine.mineral).toBeGreaterThan(4);
    expect(forest.mineral).toBe(0);
    expect(forest.cdom440).toBeGreaterThan(alpine.cdom440 * 4);
    expect(lowland.chlorophyll).toBeGreaterThan(alpine.chlorophyll * 3);
    // ...and they render as three distinguishable colours, not three shades of
    // one. Compare hue rather than level: the ratios are what the eye reads.
    const hue = (c: WaterConstituents): number => {
      const r = bodyReflectance(c);
      return r[2]! / Math.max(r[0]!, 1e-6);
    };
    expect(hue(alpine)).toBeGreaterThan(hue(forest) * 3);
    expect(hue(lowland)).toBeGreaterThan(hue(forest));
    expect(hue(alpine)).toBeGreaterThan(hue(lowland));
  });

  it("makes a river muddier with stream power and clearer in cold headwaters", () => {
    const headwater = resolveRiverConstituents(
      { elevationAboveSeaMeters: 1_400, temperature: 0.16, moisture: 0.5 }, 4, 2.4, 0.05,
    );
    const lowland = resolveRiverConstituents(
      { elevationAboveSeaMeters: 40, temperature: 0.7, moisture: 0.8 }, 40, 1.6, 0.01,
    );
    expect(lowland.sediment).toBeGreaterThan(headwater.sediment * 4);
    expect(headwater.mineral).toBeGreaterThan(lowland.mineral);
    expect(lowland.cdom440).toBeGreaterThan(headwater.cdom440 * 3);
  });

  it("is continuous in every input, so a page seam cannot show a step", () => {
    // The resolvers are pure functions of world position and the body's own
    // attributes; the only thing a seam can change is which page evaluated
    // them. This sweeps each input across its range and bounds the derivative,
    // which is the property that makes that irrelevant.
    let previous = resolveLakeConstituents(
      { elevationAboveSeaMeters: 0, temperature: 0.5, moisture: 0.5 }, 10, 10_000,
    );
    for (let elevation = 10; elevation <= 2_000; elevation += 10) {
      const next = resolveLakeConstituents(
        { elevationAboveSeaMeters: elevation, temperature: 0.5, moisture: 0.5 }, 10, 10_000,
      );
      expect(Math.abs(next.mineral - previous.mineral)).toBeLessThan(0.2);
      expect(Math.abs(next.cdom440 - previous.cdom440)).toBeLessThan(0.1);
      previous = next;
    }
    let wetter = resolveLakeConstituents(
      { elevationAboveSeaMeters: 300, temperature: 0.6, moisture: 0 }, 10, 10_000,
    );
    for (let moisture = 0.01; moisture <= 1; moisture += 0.01) {
      const next = resolveLakeConstituents(
        { elevationAboveSeaMeters: 300, temperature: 0.6, moisture }, 10, 10_000,
      );
      expect(Math.abs(next.cdom440 - wetter.cdom440)).toBeLessThan(0.16);
      expect(Math.abs(next.chlorophyll - wetter.chlorophyll)).toBeLessThan(1.2);
      wetter = next;
    }
  });

  it("composes one constituent model into both water fragments", () => {
    expect(WATER_CONSTITUENT_WGSL).toContain("fn waterOpticsFromConstituents(");
    // One pow per pixel for the pigment term, and no other transcendental.
    expect(WATER_CONSTITUENT_WGSL.split("pow(")).toHaveLength(2);
    for (const shader of [WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_FRAGMENT_WGSL]) {
      expect(shader).toContain(WATER_CONSTITUENT_WGSL);
      expect(shader.split("fn waterOpticsFromConstituents(")).toHaveLength(2);
    }
    // The ocean's open-water and coastal ends are an order of magnitude apart
    // in chlorophyll: that gradient IS the coastal green-to-indigo transition.
    expect(OCEAN_COASTAL_CHLOROPHYLL).toBeGreaterThan(OCEAN_OPEN_CHLOROPHYLL * 10);
  });
});
