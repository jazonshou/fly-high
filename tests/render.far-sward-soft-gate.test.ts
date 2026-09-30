import { describe, expect, it } from "vitest";
import { createWorld, sampleTerrain, type TerrainSample } from "../src/world";
import { classifyLandCover } from "../src/render/webgpu/terrain/LandCoverClassifier";
import { LAND_COVER_SPLAT_BAKE_WGSL } from "../src/render/webgpu/terrain/LandCoverClassifier";
import {
  FAR_SWARD_GRASS_BASE,
  FAR_SWARD_SOFT_READ_WGSL,
  farSwardCheapSplat,
  farSwardGateCode,
  farSwardGateDecode,
  farSwardGateStored,
  farSwardPairEligible,
  farSwardPairOf,
  farSwardDecodedWeights,
  farSwardSoftSplat,
  farSwardTowardGrass,
  type FarSwardCorner,
  type FarSwardSplat,
} from "../src/render/webgpu/terrain/FarSwardGate";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
  surfaceMaterialSpec,
  type SurfaceMaterialId,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  TERRAIN_FAR_SWARD_READ_DEFAULT,
  terrainFarSwardEligible,
} from "../src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * V-4: the far-sward gate's soft read (`FarSwardGate.ts`).
 *
 * On zero-trust pages (level 5 and coarser, 128 m texels and up) the CHEAP read
 * took the nearest texel's pair and gated it all or nothing, so a coast or a
 * treeline drew a straight 128 m texel line between the pair's mixture and the
 * Grass base, about 2 km out (world V4HYQQ, 2026-09-30: a lake-shore "patch"
 * with edges on x = -8576 and -8448, to 3-6 m).
 *
 * These pins run the CPU twins. The texels at V4HYQQ come from the bake's CPU
 * twin: four taps at a quarter texel, the classifier's weight vectors averaged
 * and cut to the top four, from `sampleTerrain`'s drivers. The GPU bake reads
 * the page's own channels, so a texel on a class boundary can differ; the
 * frame's two edges lined up with these texels to 3-6 m.
 */

const LEVEL5_TEXEL_METERS = 128;
/** The level-5 page holding the patch: x [-16384, 0), z [0, 16384). */
const PAGE_MIN = { x: -16_384, z: 0 };
const V4HYQQ_SEED = Number.parseInt("v4hyqq", 36) >>> 0;

const world = createWorld(V4HYQQ_SEED);
const sampleTarget: TerrainSample = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  slope: 0,
  moisture: 0,
  temperature: 0,
  biome: 0,
  biomeName: "water",
  color: { r: 0, g: 0, b: 0 },
  airportInfluence: 0,
  isRunway: false,
};

/** The bake's twin at one level-5 texel: the corner the soft read loads. */
function bakedCorner(column: number, row: number): FarSwardCorner {
  const centreX = PAGE_MIN.x + (column + 0.5) * LEVEL5_TEXEL_METERS;
  const centreZ = PAGE_MIN.z + (row + 0.5) * LEVEL5_TEXEL_METERS;
  const byMaterial = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  const tap = LEVEL5_TEXEL_METERS * 0.25;
  for (const [dx, dz] of [[-tap, -tap], [tap, -tap], [-tap, tap], [tap, tap]] as const) {
    const sample = sampleTerrain(world, centreX + dx, centreZ + dz, sampleTarget);
    const weights = classifyLandCover({
      elevationMeters: sample.height - world.seaLevel,
      slope: sample.slope,
      moisture: sample.moisture,
      temperature: sample.temperature,
      aspect: 0,
      airportInfluence: sample.airportInfluence,
      dayOfYear: 172,
      seasonalTemperatureShift: 0,
    });
    weights.ids.forEach((id, lane) => {
      byMaterial[id] = byMaterial[id]! + weights.weights[lane]! / 4;
    });
  }
  const top = byMaterial
    .map((weight, id) => ({ id, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);
  const total = top.reduce((sum, entry) => sum + entry.weight, 0);
  const ids = top.map((entry) => entry.id);
  const weights = top.map((entry) => entry.weight / total);
  const code = farSwardGateCode(ids, weights, weights);
  return {
    gate: farSwardGateDecode(farSwardGateStored(code), 0),
    pair: farSwardPairOf(ids, farSwardDecodedWeights(weights)),
  };
}

const cornerCache = new Map<string, FarSwardCorner>();
function corner(column: number, row: number): FarSwardCorner {
  const key = `${column}:${row}`;
  let value = cornerCache.get(key);
  if (!value) {
    value = bakedCorner(column, row);
    cornerCache.set(key, value);
  }
  return value;
}

type Read = (corners: readonly FarSwardCorner[], fraction: { x: number; y: number }) => FarSwardSplat;

/** What the fragment draws at a world point on the level-5 page: the splat, as the fragment gates it. */
function drawnAt(read: Read, x: number, z: number): FarSwardSplat {
  const ax = (x - PAGE_MIN.x) / LEVEL5_TEXEL_METERS - 0.5;
  const az = (z - PAGE_MIN.z) / LEVEL5_TEXEL_METERS - 0.5;
  const column = Math.floor(ax);
  const row = Math.floor(az);
  return read(
    [corner(column, row), corner(column + 1, row), corner(column, row + 1), corner(column + 1, row + 1)],
    { x: ax - column, y: az - row },
  );
}

/** The drawn material mixture's reference albedo in 8-bit sRGB levels (unrounded). */
function drawnLevels(splat: FarSwardSplat): number[] {
  const reference = (id: number) => surfaceMaterialSpec(id as SurfaceMaterialId).referenceAlbedo;
  const farSward = splat.w < -0.5 && farSwardPairEligible(splat);
  const linear = farSward
    ? [0, 1, 2].map((channel) => (1 - splat.share) * reference(splat.primary)[channel]!
      + splat.share * reference(splat.secondary)[channel]!)
    : [...reference(SurfaceMaterial.Grass)];
  return linear.map((value) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
}

/** The largest change, in 8-bit levels, between neighbouring samples 0.5 m apart along a line. */
function largestStep(read: Read, from: { x: number; z: number }, to: { x: number; z: number }): number {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const count = Math.round(length / 0.5);
  let previous = drawnLevels(drawnAt(read, from.x, from.z));
  let largest = 0;
  for (let step = 1; step <= count; step += 1) {
    const t = step / count;
    const current = drawnLevels(drawnAt(read, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t));
    for (let channel = 0; channel < 3; channel += 1) {
      largest = Math.max(largest, Math.abs(current[channel]! - previous[channel]!));
    }
    previous = current;
  }
  return largest;
}

describe("V-4: the far-sward gate is soft at V4HYQQ's shore", () => {
  // The frame's two edges, crossed from just inside the texel line on one side
  // to just inside the next on the other: the whole of the soft read's band
  // (texel centre to texel centre) and no other texel line. The next lines out
  // are between two ELIGIBLE texels, whose pairs CHEAP and SOFT both switch at
  // the nearest texel (up to 3.9 levels here): the pair read's own limit, not
  // the gate's, and not changed by V-4.
  const crossings = [
    { name: "x = -8576 at z 15000", from: { x: -8576 - 120, z: 15_000 }, to: { x: -8576 + 120, z: 15_000 } },
    { name: "x = -8448 at z 16240", from: { x: -8448 - 120, z: 16_240 }, to: { x: -8448 + 120, z: 16_240 } },
  ];

  it.each(crossings)("CHEAP steps at $name, where the gate flips (the positive control)", ({ from, to }) => {
    const step = largestStep(farSwardCheapSplat, from, to);
    console.log(`cheap: largest step ${step.toFixed(2)} levels`);
    expect(step).toBeGreaterThan(4);
  });

  it.each(crossings)("SOFT draws no step above one 8-bit level across $name", ({ from, to }) => {
    const step = largestStep(farSwardSoftSplat, from, to);
    console.log(`soft: largest step ${step.toFixed(3)} levels`);
    expect(step).toBeLessThanOrEqual(1);
  });

  it("finds the frame's texels as the frame drew them: refused west of x = -8576 at z 15000, eligible east", () => {
    const column = (x: number) => Math.floor((x - PAGE_MIN.x) / LEVEL5_TEXEL_METERS);
    const row = Math.floor((15_000 - PAGE_MIN.z) / LEVEL5_TEXEL_METERS);
    expect(corner(column(-8600), row).gate).toBe(0);
    expect(corner(column(-8550), row).gate).toBe(1);
  });
});

describe("V-4: the soft read changes nothing inside a region", () => {
  const dry = SurfaceMaterial.DryGrass;
  const grass = SurfaceMaterial.Grass;
  const shrub = SurfaceMaterial.Shrub;
  const sand = SurfaceMaterial.Sand;
  const forest = SurfaceMaterial.ForestFloor;
  const fractions = [0, 0.1, 0.25, 0.4999, 0.5, 0.73, 0.99].flatMap((x) =>
    [0, 0.3, 0.5, 0.8].map((y) => ({ x, y })));

  it("is bit-identical to CHEAP where all four texels are eligible (the LIVERY dry pairs)", () => {
    const corners: FarSwardCorner[] = [
      { gate: 1, pair: { primary: dry, secondary: grass, share: 0.41 } },
      { gate: 1, pair: { primary: grass, secondary: dry, share: 0.47 } },
      { gate: 1, pair: { primary: dry, secondary: shrub, share: 0.22 } },
      { gate: 1, pair: { primary: dry, secondary: sand, share: 0.013 } },
    ];
    for (const fraction of fractions) {
      expect(farSwardSoftSplat(corners, fraction)).toEqual(farSwardCheapSplat(corners, fraction));
    }
  });

  it("is bit-identical to CHEAP where all four texels are refused", () => {
    const corners: FarSwardCorner[] = [
      { gate: 0, pair: { primary: sand, secondary: dry, share: 0.4 } },
      { gate: 0, pair: { primary: forest, secondary: grass, share: 0.3 } },
      { gate: 0, pair: { primary: sand, secondary: grass, share: 0.2 } },
      { gate: 0, pair: { primary: grass, secondary: forest, share: 0.45 } },
    ];
    for (const fraction of fractions) {
      expect(farSwardSoftSplat(corners, fraction)).toEqual(farSwardCheapSplat(corners, fraction));
    }
  });

  it("hands the fragment a refused pair at zero trust for the Grass base, as CHEAP does for a refused texel", () => {
    expect(FAR_SWARD_GRASS_BASE.w).toBe(-1);
    expect(farSwardPairEligible(FAR_SWARD_GRASS_BASE)).toBe(false);
    expect(terrainFarSwardEligible(sand, sand, 0)).toBe(false);
  });

  it("moves a pair toward Grass continuously and reaches it at 0, holding Grass or not", () => {
    for (const pair of [
      { primary: grass, secondary: dry, share: 0.3 },
      { primary: dry, secondary: grass, share: 0.45 },
      { primary: dry, secondary: shrub, share: 0.35 },
    ]) {
      const grassShare = (gate: number) => {
        const moved = farSwardTowardGrass(pair, gate);
        return (moved.primary === grass ? 1 - moved.share : 0) + (moved.secondary === grass ? moved.share : 0);
      };
      expect(farSwardTowardGrass(pair, 1).share).toBeCloseTo(pair.share, 12);
      expect(grassShare(0)).toBeCloseTo(1, 12);
      // The upper id may change only where its weight is zero.
      for (let gate = 0; gate < 1; gate += 0.001) {
        const a = farSwardTowardGrass(pair, gate);
        const b = farSwardTowardGrass(pair, gate + 0.001);
        if (a.secondary !== b.secondary) expect(Math.min(a.share, b.share)).toBeLessThan(0.003);
        expect(Math.abs(grassShare(gate + 0.001) - grassShare(gate))).toBeLessThan(0.0021);
      }
    }
  });
});

describe("V-4: the stored gate", () => {
  it("carries each season bucket's gate in its own bit and decodes it exactly where they agree", () => {
    const ids = [SurfaceMaterial.DryGrass, SurfaceMaterial.Grass, SurfaceMaterial.Snow, SurfaceMaterial.Rock];
    const lush = [0.55, 0.4, 0.03, 0.02];
    const snowy = [0.3, 0.2, 0.45, 0.05];
    expect(farSwardGateCode(ids, lush, lush)).toBe(3);
    expect(farSwardGateCode(ids, lush, snowy)).toBe(1);
    expect(farSwardGateCode(ids, snowy, lush)).toBe(2);
    expect(farSwardGateCode(ids, snowy, snowy)).toBe(0);
    expect(farSwardGateDecode(farSwardGateStored(1), 0)).toBe(1);
    expect(farSwardGateDecode(farSwardGateStored(1), 1)).toBe(0);
    expect(farSwardGateDecode(farSwardGateStored(2), 0)).toBe(0);
    expect(farSwardGateDecode(farSwardGateStored(2), 0.25)).toBeCloseTo(0.25, 12);
    for (const code of [0, 3]) {
      for (const blend of [0, 0.37, 1]) expect(farSwardGateDecode(farSwardGateStored(code), blend)).toBe(code / 3);
    }
  });

  it("gates the weights the fragment decodes, not the bake's own", () => {
    // Sand and DryGrass a quarter of an 8-bit step apart quantise to a tie,
    // and the fragment's lane order then makes Sand the secondary.
    const ids = [SurfaceMaterial.Sand, SurfaceMaterial.DryGrass, SurfaceMaterial.Grass, SurfaceMaterial.Rock];
    const weights = [0.3, 0.301, 0.399, 0];
    // The control: on the bake's own weights the pair is Grass/DryGrass, two swards.
    expect(farSwardPairEligible(farSwardPairOf(ids, weights))).toBe(true);
    // As the fragment decodes them it is Grass/Sand, refused, in both buckets.
    expect(farSwardPairEligible(farSwardPairOf(ids, farSwardDecodedWeights(weights)))).toBe(false);
    expect(farSwardGateCode(ids, weights, weights)).toBe(0);
  });
});

describe("V-4: the soft read in the shaders", () => {
  it("is compiled only when asked for, CHEAP staying the default", () => {
    expect(TERRAIN_FAR_SWARD_READ_DEFAULT).toBe("cheap");
  });

  it("stores the gate in the high bucket's alpha from the bake", () => {
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("fn splatFarSwardGateStored(aligned: SeasonalLandCoverWeights) -> f32 {");
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      "textureStore(splatWeightHi, texel, vec4f(aligned.weightsHi.xyz, splatFarSwardGateStored(aligned)));");
  });

  it("returns CHEAP's read where the four gates agree, and loads a second pair only for a refused nearest texel", () => {
    expect(FAR_SWARD_SOFT_READ_WGSL).toContain(
      "if (all(gates == vec4f(1.0)) || all(gates == vec4f(0.0))) { return cheap; }");
    const soft = FAR_SWARD_SOFT_READ_WGSL.slice(FAR_SWARD_SOFT_READ_WGSL.indexOf("fn terrainSurfaceSoftSplat("));
    // The four gates in ONE gather at the corners' shared point, mapped out of
    // WGSL's (umin, vmax), (umax, vmax), (umax, vmin), (umin, vmin) order.
    expect([...soft.matchAll(/terrainFarSwardGatesAt\(/gu)]).toHaveLength(1);
    expect(FAR_SWARD_SOFT_READ_WGSL).toContain(
      "textureGather(3, terrainSplatWeightHi, terrainSplatWeightHiSampler,\n    (vec2f(corner) + vec2f(1.0)) / uniforms.terrainPageAtlas.x);");
    expect(FAR_SWARD_SOFT_READ_WGSL).toMatch(
      /terrainFarSwardGateDecode\(stored\.w, blend\),\s+terrainFarSwardGateDecode\(stored\.z, blend\),\s+terrainFarSwardGateDecode\(stored\.x, blend\),\s+terrainFarSwardGateDecode\(stored\.y, blend\)\)/u);
    expect([...soft.matchAll(/terrainSurfaceSplatAt\(/gu)]).toHaveLength(1);
    expect(soft.indexOf("terrainSurfaceSplatAt(")).toBeGreaterThan(soft.indexOf("if (!terrainFarSwardEligible(pair)) {"));
  });
});
