import { describe, expect, it } from "vitest";
import {
  linearLuminance,
  meanSurfaceAlbedo,
  SURFACE_ARRAY_A_CHANNELS,
  SURFACE_ARRAY_B_CHANNELS,
  SURFACE_MATERIAL_ARRAY_COUNT,
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SURFACE_MATERIALS_BY_BIOME,
  SurfaceMaterial,
  surfaceMaterialSpec,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import { TerrainBiome, type TerrainBiomeId } from "../src/world";

/**
 * 3-0 — the surface contract. Assertion 52 lives here, plus the structural
 * pins seven later consumers depend on.
 */

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

describe("surface material contract (3-0)", () => {
  it("assertion 52: tiling periods are pairwise co-prime", () => {
    // The plan asks for periods that never repeat in phase. On a decimetre
    // grid that is exactly integer co-primality, and it is checkable — which
    // is why it is an assertion rather than the comment it was.
    const decimetres = SURFACE_MATERIALS.map((spec) => {
      const value = Math.round(spec.tilingPeriodMeters * 10);
      expect(
        Math.abs(spec.tilingPeriodMeters * 10 - value),
        `${spec.name} period ${spec.tilingPeriodMeters} m is not on the decimetre grid`,
      ).toBeLessThan(1e-9);
      return value;
    });

    let worstRealignmentMeters = Number.POSITIVE_INFINITY;
    for (let a = 0; a < decimetres.length; a += 1) {
      for (let b = a + 1; b < decimetres.length; b += 1) {
        const first = decimetres[a]!;
        const second = decimetres[b]!;
        expect(
          greatestCommonDivisor(first, second),
          `${SURFACE_MATERIALS[a]!.name} (${first} dm) and ${SURFACE_MATERIALS[b]!.name} `
          + `(${second} dm) share a factor — the two layers repeat in phase every `
          + `${(first * second) / greatestCommonDivisor(first, second) / 10} m`,
        ).toBe(1);
        worstRealignmentMeters = Math.min(worstRealignmentMeters, (first * second) / 10);
      }
    }
    // Co-primality alone permits a short realignment (2 dm and 3 dm are
    // co-prime and realign at 0.6 m). Pin the actual worst case too.
    expect(worstRealignmentMeters).toBeGreaterThan(60);
  });

  it("keeps ten materials, in the order both texture arrays index by", () => {
    expect(SURFACE_MATERIALS).toHaveLength(SURFACE_MATERIAL_COUNT);
    expect(SURFACE_MATERIAL_ARRAY_COUNT).toBe(2);
    expect(SURFACE_ARRAY_A_CHANNELS).toHaveLength(4);
    expect(SURFACE_ARRAY_B_CHANNELS).toHaveLength(4);
    SURFACE_MATERIALS.forEach((spec, index) => {
      expect(spec.id, `${spec.name} is at index ${index} but declares id ${spec.id}`).toBe(index);
      expect(surfaceMaterialSpec(spec.id)).toBe(spec);
    });
    // The first six indices ARE the ecotone chain, in climatic order; the
    // three off-chain materials and the two paved ones follow.
    expect([
      SurfaceMaterial.Sand,
      SurfaceMaterial.Grass,
      SurfaceMaterial.ForestFloor,
      SurfaceMaterial.Shrub,
      SurfaceMaterial.Rock,
      SurfaceMaterial.Snow,
    ]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(SurfaceMaterial.Concrete).toBe(SURFACE_MATERIAL_COUNT - 1);
    expect(() => surfaceMaterialSpec(SURFACE_MATERIAL_COUNT as 0)).toThrow(RangeError);
  });

  it("assertion 61 (contract half): ten distinct, physically ordered roughness values", () => {
    // The shader half of assertion 61 is a GPU test; this is the half that
    // can fail in Node, and it is the one that would let the uniform-0.93
    // failure return by another route — ten materials that all round to the
    // same number reach the shader "distinctly" and look identical.
    const midpoints = SURFACE_MATERIALS.map((spec) => (spec.roughness[0] + spec.roughness[1]) / 2);
    for (const spec of SURFACE_MATERIALS) {
      expect(spec.roughness[0]).toBeGreaterThan(0);
      expect(spec.roughness[0]).toBeLessThan(spec.roughness[1]);
      expect(spec.roughness[1]).toBeLessThanOrEqual(1);
      expect(spec.diffuseRoughness).toBeGreaterThan(0);
      expect(spec.diffuseRoughness).toBeLessThanOrEqual(1);
      // Every material is a dielectric; F0 outside this band is a data entry
      // error, not a look choice.
      expect(spec.f0).toBeGreaterThanOrEqual(0.015);
      expect(spec.f0).toBeLessThanOrEqual(0.08);
    }
    for (let a = 0; a < midpoints.length; a += 1) {
      for (let b = a + 1; b < midpoints.length; b += 1) {
        expect(
          Math.abs(midpoints[a]! - midpoints[b]!),
          `${SURFACE_MATERIALS[a]!.name} and ${SURFACE_MATERIALS[b]!.name} share a roughness`,
        ).toBeGreaterThanOrEqual(0.02);
      }
    }
    // Snow is the glossiest surface in the world and grass the mattest; if
    // that inverts, the table has been edited without looking at it.
    expect(Math.min(...midpoints)).toBe(midpoints[SurfaceMaterial.Snow]);
    expect(Math.max(...midpoints)).toBe(midpoints[SurfaceMaterial.Grass]);
  });

  it("keeps 3-10's seasonal flag off rock, asphalt and concrete", () => {
    for (const id of [SurfaceMaterial.Rock, SurfaceMaterial.Asphalt, SurfaceMaterial.Concrete]) {
      expect(surfaceMaterialSpec(id).seasonal, `${surfaceMaterialSpec(id).name}`).toBe(false);
    }
    for (const id of [SurfaceMaterial.Grass, SurfaceMaterial.Shrub]) {
      expect(surfaceMaterialSpec(id).seasonal).toBe(true);
    }
    // 3-5: rock and gravel are the projected materials.
    expect(SURFACE_MATERIALS.filter((spec) => spec.triplanar).map((spec) => spec.name).sort())
      .toEqual(["Gravel", "Rock"]);
  });

  it("maps every biome to an adjacent pair on the material axis", () => {
    // THE assertion the ordering exists for. 3-2 interpolates the primary id
    // across a triangle and brackets the two integers it lands between, so a
    // climatic neighbour pair more than one step apart puts a THIRD material
    // in the boundary band — which is how the first ordering rang every
    // mountain with a bright sand contour. One step, exactly, for every pair
    // of biomes that can share an edge.
    const biomes = Object.values(TerrainBiome) as TerrainBiomeId[];
    for (const biome of biomes) {
      const mix = SURFACE_MATERIALS_BY_BIOME[biome];
      expect(mix, `biome ${biome} has no material mix`).toBeDefined();
      expect(mix.secondaryWeight).toBeGreaterThanOrEqual(0);
      expect(mix.secondaryWeight).toBeLessThan(0.5);
      // Never the two paved materials: 3-9 paints those from the airport SDF,
      // so the vertex splat around the apron must stay ordinary ground.
      expect(mix.primary).toBeLessThan(SurfaceMaterial.Asphalt);
      expect(mix.secondary).toBeLessThan(SurfaceMaterial.Asphalt);
    }
    const climaticNeighbours: readonly (readonly [TerrainBiomeId, TerrainBiomeId])[] = [
      [TerrainBiome.WATER, TerrainBiome.BEACH],
      [TerrainBiome.BEACH, TerrainBiome.GRASSLAND],
      [TerrainBiome.GRASSLAND, TerrainBiome.FOREST],
      [TerrainBiome.FOREST, TerrainBiome.HIGHLAND],
      [TerrainBiome.HIGHLAND, TerrainBiome.ALPINE],
      [TerrainBiome.ALPINE, TerrainBiome.SNOW],
      // The runway's graded surround meets grassland everywhere.
      [TerrainBiome.RUNWAY, TerrainBiome.GRASSLAND],
    ];
    for (const [first, second] of climaticNeighbours) {
      const distance = Math.abs(
        SURFACE_MATERIALS_BY_BIOME[first].primary - SURFACE_MATERIALS_BY_BIOME[second].primary,
      );
      expect(
        distance,
        `biomes ${first} and ${second} are climatic neighbours but sit ${distance} steps `
        + "apart — the boundary band would blend a material that meets neither",
      ).toBeLessThanOrEqual(1);
    }
  });

  it("R-26: the mean surface albedo is seasonal and lands near the tuned ground albedo", () => {
    const summer = meanSurfaceAlbedo(0);
    const winter = meanSurfaceAlbedo(1);
    // Midsummer must sit close to the 0.18 atmospheric ground albedo the
    // exposure curve was tuned against, or retiring D-6's 0.25 floor would
    // move daylight.
    expect(linearLuminance(summer)).toBeGreaterThan(0.14);
    expect(linearLuminance(summer)).toBeLessThan(0.2);
    // And it must genuinely move with the season — that is the whole reason
    // D-6's hardcoded floor had to go.
    expect(linearLuminance(winter)).toBeGreaterThan(0.3);
    expect(linearLuminance(winter)).toBeGreaterThan(linearLuminance(summer) * 1.8);
    for (const albedo of [summer, winter, meanSurfaceAlbedo(0.5)]) {
      for (const channel of albedo) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThan(1);
      }
    }
    // Out-of-range winter fractions clamp rather than extrapolate.
    expect(meanSurfaceAlbedo(-3)).toEqual(summer);
    expect(meanSurfaceAlbedo(7)).toEqual(winter);
  });
});
