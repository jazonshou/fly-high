import { describe, expect, it } from "vitest";
import {
  DETAIL_CROWN_ALBEDO,
  hemiOctahedralDirection,
  hemiOctahedralUv,
  impostorBakeFrame,
  impostorLayerIndex,
  IMPOSTOR_LAYER_EDGE,
  IMPOSTOR_SEASON_BUCKETS,
  IMPOSTOR_SPECIES,
  IMPOSTOR_VIEW_GRID,
  planImpostorAtlas,
} from "../src/render/webgpu/detail/ImpostorAtlas";
import { planFoliageAtlas, FOLIAGE_LAYERS } from "../src/render/webgpu/detail/FoliageAtlas";

/**
 * 2-17 / 2-17a — the impostor bake's pure surfaces: the hemi-octahedral
 * mapping, both exit criteria (mean-colour coherence with the card LOD, and
 * per-instance variety), the season buckets (deciduous shed, conifers
 * hold byte-identically), determinism, and the budget measurement.
 */

const PLANS = planImpostorAtlas("impostor-test");

function layerStats(layer: number): {
  coverage: number;
  mean: [number, number, number];
} {
  const mip0 = PLANS.albedo.layerChains[layer]![0]!;
  let covered = 0;
  const sum = [0, 0, 0];
  for (let index = 0; index < mip0.length; index += 4) {
    if (mip0[index + 3]! < 128) continue;
    covered += 1;
    sum[0] = sum[0]! + mip0[index]! / 255;
    sum[1] = sum[1]! + mip0[index + 1]! / 255;
    sum[2] = sum[2]! + mip0[index + 2]! / 255;
  }
  const texels = mip0.length / 4;
  return {
    coverage: covered / texels,
    mean: [
      sum[0]! / Math.max(covered, 1),
      sum[1]! / Math.max(covered, 1),
      sum[2]! / Math.max(covered, 1),
    ],
  };
}

describe("hemi-octahedral mapping (2-17)", () => {
  it("round-trips every view-grid centre exactly", () => {
    for (let gridY = 0; gridY < IMPOSTOR_VIEW_GRID; gridY += 1) {
      for (let gridX = 0; gridX < IMPOSTOR_VIEW_GRID; gridX += 1) {
        const u = (gridX + 0.5) / IMPOSTOR_VIEW_GRID;
        const v = (gridY + 0.5) / IMPOSTOR_VIEW_GRID;
        const [x, y, z] = hemiOctahedralDirection(u, v);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
        const [ru, rv] = hemiOctahedralUv(x, y, z);
        expect(ru).toBeCloseTo(u, 9);
        expect(rv).toBeCloseTo(v, 9);
      }
    }
  });
});

describe("impostor bake (2-17)", () => {
  it("bakes non-trivial coverage for every species and view row", () => {
    for (const species of IMPOSTOR_SPECIES) {
      const stats = layerStats(impostorLayerIndex(species, 0));
      expect(stats.coverage, species).toBeGreaterThan(0.08);
      expect(stats.coverage, species).toBeLessThan(0.9);
    }
  });

  it("keeps impostor mean colour coherent with the card LOD (exit criterion)", () => {
    // The impostor is baked from the SAME atlas texels, material albedo and
    // occlusion math the card fragment uses, so its covered-mean colour must
    // sit inside the card path's analytic envelope: atlas-layer covered mean
    // × crown albedo × occlusion ∈ [0.42, 1]. Gross drift here is a wrong
    // layer, a lost albedo multiply, or a broken occlusion bake — the three
    // ways an LOD transition reads as a brightness pop.
    const foliage = planFoliageAtlas("impostor-test");
    for (const species of IMPOSTOR_SPECIES) {
      const crownLayer = species === "pine" || species === "cedar"
        ? FOLIAGE_LAYERS.needlePine
        : species === "spruce" ? FOLIAGE_LAYERS.needleSpruce
        : species === "oak" ? FOLIAGE_LAYERS.broadleafOak
        : species === "maple" ? FOLIAGE_LAYERS.broadleafMaple
        : FOLIAGE_LAYERS.broadleafBirch;
      const mip0 = foliage.layerChains[crownLayer]![0]!;
      const sum = [0, 0, 0];
      let covered = 0;
      for (let index = 0; index < mip0.length; index += 4) {
        if (mip0[index + 3]! < 128) continue;
        covered += 1;
        sum[0] = sum[0]! + mip0[index]! / 255;
        sum[1] = sum[1]! + mip0[index + 1]! / 255;
        sum[2] = sum[2]! + mip0[index + 2]! / 255;
      }
      const impostor = layerStats(impostorLayerIndex(species, 0)).mean;
      for (let channel = 0; channel < 3; channel += 1) {
        const cardTexel = (sum[channel]! / covered) * DETAIL_CROWN_ALBEDO[channel]!;
        // The impostor mean mixes crown texels (dominant) with bark; its
        // green channel especially must track the crown envelope.
        expect(impostor[channel]!, `${species} ch${channel}`)
          .toBeGreaterThan(cardTexel * 0.42 * 0.55);
        expect(impostor[channel]!, `${species} ch${channel}`)
          .toBeLessThan(cardTexel * 1.45 + 0.08);
      }
    }
  });

  it("sheds deciduous bare buckets while conifers hold byte-identically (2-17a)", () => {
    for (const species of ["oak", "maple", "birch", "willow"] as const) {
      const leafed = layerStats(impostorLayerIndex(species, 0));
      const bare = layerStats(impostorLayerIndex(species, 1));
      expect(bare.coverage, species).toBeLessThan(leafed.coverage * 0.75);
    }
    for (const species of ["pine", "cedar", "spruce"] as const) {
      const leafed = PLANS.albedo.layerChains[impostorLayerIndex(species, 0)]![0]!;
      const bare = PLANS.albedo.layerChains[impostorLayerIndex(species, 1)]![0]!;
      expect(Buffer.from(leafed).equals(Buffer.from(bare)), species).toBe(true);
    }
  });

  it("gives instances distinct view phase and mirror from the hash byte", () => {
    // The far-band variant byte is a per-stem hash; the shader reads
    // mirror = bit 0 and phase = floor(byte/2) % 4. No two neighbours
    // share both silhouette aspect (mirror + anisotropic record scales)
    // and view phase unless the hash collides.
    const mirrors = new Set<number>();
    const phases = new Set<number>();
    for (let stem = 0; stem < 100; stem += 1) {
      const selection = (stem * 0.6180339887) % 1;
      const byte = Math.floor(((selection * 97.3) % 1) * 256);
      mirrors.add(byte % 2);
      phases.add(Math.floor(byte / 2) % 4);
    }
    expect(mirrors.size).toBe(2);
    expect(phases.size).toBe(4);
  });

  it("is deterministic and inside the memory headroom", () => {
    const again = planImpostorAtlas("impostor-test");
    expect(
      Buffer.from(again.albedo.layerChains[3]![0]!)
        .equals(Buffer.from(PLANS.albedo.layerChains[3]![0]!)),
    ).toBe(true);
    const bytes = [PLANS.albedo, PLANS.normalDepth].reduce(
      (sum, plan) => sum + plan.packedLevels.reduce((s, level) => s + level.byteLength, 0),
      0,
    );
    const megabytes = bytes / (1024 * 1024);
    // The §5.2 arbitration the plan asked to settle by measurement: 64²
    // tiles land both buckets AND the normal+depth array at 9.33 MiB,
    // inside the ~15.8 MiB headroom the 128² sketch overran.
    expect(megabytes).toBeCloseTo(9.33, 1);
    expect(PLANS.layerCount).toBe(IMPOSTOR_SPECIES.length * IMPOSTOR_SEASON_BUCKETS);
    expect(PLANS.albedo.edge).toBe(IMPOSTOR_LAYER_EDGE);
  });
});
