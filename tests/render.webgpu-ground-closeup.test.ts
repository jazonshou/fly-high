import { describe, expect, it } from "vitest";
import {
  gamma2Reduce,
  planMippedTextureArray,
} from "../src/render/webgpu/core/TextureArrayMipPlan";
import {
  GROUND_COVER_BLADE_DRY_SPREAD,
  GROUND_COVER_BLADE_LUSH_SHIFT,
  GROUND_COVER_TUFT_DRY_SPREAD,
} from "../src/render/webgpu/detail/groundCoverLaw";
import { GROUND_COVER_COMPUTE_WGSL } from "../src/render/webgpu/detail/groundCoverWgsl";
import {
  GROUND_COVER_SWARD_COLOUR_GAIN,
  GROUND_COVER_SWARD_DRY_FULL,
  GROUND_COVER_SWARD_DRY_ONSET,
} from "../src/render/webgpu/detail/GroundCoverSystem";
import {
  MID_TREE_MESH_BUDGET,
  NEAR_TREE_MESH_BUDGET,
  TREE_VARIANT_COUNTS,
  buildTreePrototype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import {
  TRUNK_ROOT_FLARE_CONTACT_SHADE,
  TRUNK_ROOT_FLARE_MINIMUM_SIDES,
  TRUNK_ROOT_FLARE_RINGS,
  TRUNK_ROOT_FLARE_TOP_RISE,
  buildTreeSkeleton,
  estimateSkeletonTriangles,
  trunkRootFlared,
  type BranchingTreeSpecies,
} from "../src/render/webgpu/detail/treeSkeleton";
import type { TreeSpecies } from "../src/render/webgpu/detail/types";
import {
  SWARD_FLOOR_OPENNESS,
  SWARD_FLOOR_SHADE,
  synthesizeSurfaceMaterial,
} from "../src/render/webgpu/terrain/MaterialArraySynthesis";
import { SURFACE_ALBEDO_MIP_KERNEL } from "../src/render/webgpu/terrain/MaterialArrayUpload";
import { SURFACE_MATERIALS, SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { TERRAIN_MICRO_DETAIL } from "../src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * The ground up close (2026-11-12, "the floor still looks very blurry,
 * plasticy, and fake ... trees that are glued to this plastic skin").
 *
 * Four things made that look, and each has its pin here: sward layers that
 * were flat paint, a first read stretched two to four times at a walker's
 * feet, blades the colour of everything on the ground but the grass, and a
 * trunk that ended in a flat cut on the surface.
 */

const SEED = "ground-closeup";
const EDGE = 256;
const SWARDS = [SurfaceMaterial.Grass, SurfaceMaterial.DryGrass] as const;

function decode(byte: number): number {
  return (byte / 255) ** 2;
}

function layerStats(albedoHeight: Uint8Array, normalMaterial: Uint8Array): {
  mean: [number, number, number];
  contrast: number;
  cavity: number;
} {
  const texels = albedoHeight.length / 4;
  const mean: [number, number, number] = [0, 0, 0];
  let lum = 0;
  let lumSquared = 0;
  let cavity = 0;
  for (let texel = 0; texel < texels; texel += 1) {
    const r = decode(albedoHeight[texel * 4]!);
    const g = decode(albedoHeight[texel * 4 + 1]!);
    const b = decode(albedoHeight[texel * 4 + 2]!);
    mean[0] += r / texels;
    mean[1] += g / texels;
    mean[2] += b / texels;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum += luminance;
    lumSquared += luminance * luminance;
    cavity += normalMaterial[texel * 4 + 3]! / 255 / texels;
  }
  const average = lum / texels;
  return {
    mean,
    contrast: Math.sqrt(Math.max(0, lumSquared / texels - average * average)) / average,
    cavity,
  };
}

describe("the sward layers are drawn in depth", () => {
  const layers = SWARDS.map((id) => ({ id, ...synthesizeSurfaceMaterial(id, SEED, EDGE) }));

  it("carries lit blades over shaded gaps, not one tone", () => {
    for (const layer of layers) {
      const stats = layerStats(layer.albedoHeight, layer.normalMaterial);
      // 10% (Grass) and 6% (DryGrass) was the flat paint.
      expect(stats.contrast, SURFACE_MATERIALS[layer.id]!.name).toBeGreaterThan(0.35);
      expect(stats.contrast, SURFACE_MATERIALS[layer.id]!.name).toBeLessThan(0.8);
    }
  });

  it("keeps each layer's mean colour and mean openness where the far look and the light rig have them", () => {
    for (const layer of layers) {
      const stats = layerStats(layer.albedoHeight, layer.normalMaterial);
      const reference = SURFACE_MATERIALS[layer.id]!.referenceAlbedo;
      for (let channel = 0; channel < 3; channel += 1) {
        expect(stats.mean[channel]! / reference[channel]!, `${SURFACE_MATERIALS[layer.id]!.name} channel ${channel}`)
          .toBeGreaterThan(0.97);
        expect(stats.mean[channel]! / reference[channel]!, `${SURFACE_MATERIALS[layer.id]!.name} channel ${channel}`)
          .toBeLessThan(1.03);
      }
      expect(stats.cavity, SURFACE_MATERIALS[layer.id]!.name).toBeGreaterThan(0.58);
      expect(stats.cavity, SURFACE_MATERIALS[layer.id]!.name).toBeLessThan(0.72);
    }
  });

  it("shades the floor of the sward without closing it", () => {
    expect(SWARD_FLOOR_SHADE).toBeGreaterThan(0.4);
    expect(SWARD_FLOOR_SHADE).toBeLessThan(0.75);
    expect(SWARD_FLOOR_OPENNESS).toBeGreaterThan(0.5);
    expect(SWARD_FLOOR_OPENNESS).toBeLessThan(1);
  });
});

describe("the albedo array's mips average light", () => {
  it("reduces a black and white checker to half the light, not half the byte", () => {
    const source = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const value = (x + y) % 2 === 0 ? 255 : 0;
        source.set([value, value, value, value], (y * 4 + x) * 4);
      }
    }
    const reduced = gamma2Reduce(source, 4);
    expect(reduced.length).toBe(2 * 2 * 4);
    for (let texel = 0; texel < 4; texel += 1) {
      // sqrt(0.5) of full scale in the gamma-2.0 channels; the height is linear.
      expect(reduced[texel * 4]).toBe(180);
      expect(reduced[texel * 4 + 1]).toBe(180);
      expect(reduced[texel * 4 + 2]).toBe(180);
      expect(Math.abs(reduced[texel * 4 + 3]! - 128)).toBeLessThanOrEqual(1);
    }
  });

  it("holds a sward's albedo from the ground at the camera's feet to the same ground at range", () => {
    const { albedoHeight } = synthesizeSurfaceMaterial(SurfaceMaterial.Grass, SEED, EDGE);
    const meanGreen = (level: Uint8Array): number => {
      let sum = 0;
      for (let texel = 0; texel < level.length / 4; texel += 1) sum += decode(level[texel * 4 + 1]!);
      return sum / (level.length / 4);
    };
    const drift = (kernel: Parameters<typeof planMippedTextureArray>[2]): number => {
      const plan = planMippedTextureArray([albedoHeight], EDGE, kernel);
      const levels = plan.layerChains[0]!;
      return meanGreen(levels[5]!) / meanGreen(levels[0]!);
    };
    // The box over the stored bytes is what darkened a meadow at 30 m.
    expect(drift("box")).toBeLessThan(0.95);
    expect(drift(SURFACE_ALBEDO_MIP_KERNEL)).toBeGreaterThan(0.985);
    expect(drift(SURFACE_ALBEDO_MIP_KERNEL)).toBeLessThan(1.015);
  });
});

describe("the micro read", () => {
  it("is finer by a ratio that never lines its lattice up with the first read's", () => {
    expect(TERRAIN_MICRO_DETAIL.scale).toBeGreaterThan(2.5);
    expect(TERRAIN_MICRO_DETAIL.scale).toBeLessThan(4.5);
    expect(Number.isInteger(TERRAIN_MICRO_DETAIL.scale * 2)).toBe(false);
    expect(TERRAIN_MICRO_DETAIL.rotationDegrees % 45).not.toBe(0);
  });

  it("is skipped wherever the first read resolves the ground by itself", () => {
    // Past one first-read texel a pixel there is nothing to add: the fetches
    // are for the few metres about the camera and nowhere else.
    expect(TERRAIN_MICRO_DETAIL.zeroTexels).toBeGreaterThan(1);
    expect(TERRAIN_MICRO_DETAIL.zeroTexels).toBeLessThanOrEqual(2);
    expect(TERRAIN_MICRO_DETAIL.fullTexels).toBeLessThan(TERRAIN_MICRO_DETAIL.zeroTexels);
  });

  it("is one tap, at a level between the pixel's two axes", () => {
    // Under 1 the tap would be spaced past its own texels along the line of
    // sight; at 1 it is the long axis's mip and the ground blurs across it.
    expect(TERRAIN_MICRO_DETAIL.levelMajorShare).toBeGreaterThanOrEqual(0.5);
    expect(TERRAIN_MICRO_DETAIL.levelMajorShare).toBeLessThan(1);
  });

  it("takes over only once the first read is stretched, and softens it no further than a tuft", () => {
    expect(TERRAIN_MICRO_DETAIL.takeoverZeroTexels).toBeLessThanOrEqual(TERRAIN_MICRO_DETAIL.fullTexels);
    expect(TERRAIN_MICRO_DETAIL.takeoverFullTexels).toBeLessThan(TERRAIN_MICRO_DETAIL.takeoverZeroTexels);
    // At full takeover the micro read is at a texel a pixel or finer.
    expect(TERRAIN_MICRO_DETAIL.takeoverFullTexels * TERRAIN_MICRO_DETAIL.scale).toBeLessThanOrEqual(1);
    expect(TERRAIN_MICRO_DETAIL.softenTexels).toBeGreaterThan(1.5);
    expect(TERRAIN_MICRO_DETAIL.softenTexels).toBeLessThanOrEqual(4);
  });
});

describe("a blade is its sward's colour", () => {
  it("takes the sward's colour as soon as the ground has much of one", () => {
    expect(GROUND_COVER_SWARD_COLOUR_GAIN).toBeGreaterThanOrEqual(2);
    expect(GROUND_COVER_SWARD_DRY_ONSET).toBeGreaterThan(0.1);
    expect(GROUND_COVER_SWARD_DRY_ONSET).toBeLessThan(GROUND_COVER_SWARD_DRY_FULL);
  });

  it("moves through the ground's own lush and dry patches, blade by blade and tuft by tuft", () => {
    expect(GROUND_COVER_COMPUTE_WGSL).toContain("fn terrainGroundPatchwork(");
    expect(GROUND_COVER_COMPUTE_WGSL).toContain("groundPatch.albedoScale");
    expect(GROUND_COVER_BLADE_DRY_SPREAD).toBeGreaterThan(0);
    expect(GROUND_COVER_TUFT_DRY_SPREAD).toBeGreaterThan(0);
    // The spread is about the sward's mean and is not a second meadow.
    expect(GROUND_COVER_BLADE_DRY_SPREAD + GROUND_COVER_TUFT_DRY_SPREAD).toBeLessThan(1);
  });

  it("stands greener than a green sward's mean, and not at all greener than straw", () => {
    expect(GROUND_COVER_BLADE_LUSH_SHIFT).toBeGreaterThan(0.15);
    expect(GROUND_COVER_BLADE_LUSH_SHIFT).toBeLessThan(0.6);
    expect(GROUND_COVER_COMPUTE_WGSL).toMatch(/\* \(1\.0 - swardDryness\)/);
  });
});

describe("a near tree's bole is rooted", () => {
  const BRANCHING = (Object.keys(TREE_VARIANT_COUNTS) as TreeSpecies[])
    .filter((species): species is BranchingTreeSpecies => species !== "palm");

  it("flares the near model and leaves the mid model the plain tube", () => {
    for (const species of BRANCHING) {
      const skeleton = buildTreeSkeleton(species, 0, 31);
      expect(trunkRootFlared(skeleton, NEAR_TREE_MESH_BUDGET), species).toBe(true);
      expect(trunkRootFlared(skeleton, MID_TREE_MESH_BUDGET), species).toBe(false);
    }
    expect(MID_TREE_MESH_BUDGET.trunkSides).toBeLessThan(TRUNK_ROOT_FLARE_MINIMUM_SIDES);
    expect(trunkRootFlared(buildTreeSkeleton("palm" as never, 0, 31), NEAR_TREE_MESH_BUDGET)).toBe(false);
  });

  it("swells into the ground, goes on below it and is shaded where it meets it", () => {
    for (const species of BRANCHING) {
      const near = buildTreePrototype(species, 0, 31, "near").trunk;
      const mid = buildTreePrototype(species, 0, 31, "mid").trunk;
      const foot = (geometry: typeof near): { minY: number; reach: number; shade: number } => {
        let minY = Infinity;
        let reach = 0;
        let shade = 1;
        for (let vertex = 0; vertex < geometry.positions.length / 3; vertex += 1) {
          const y = geometry.positions[vertex * 3 + 1]!;
          minY = Math.min(minY, y);
          if (y > 0.02) continue;
          reach = Math.max(reach, Math.hypot(geometry.positions[vertex * 3]!, geometry.positions[vertex * 3 + 2]!));
          shade = Math.min(shade, geometry.colors[vertex * 4 + 3]!);
        }
        return { minY, reach, shade };
      };
      const flared = foot(near);
      const plain = foot(mid);
      expect(flared.minY, `${species} below the ground`).toBeLessThan(-0.01);
      expect(flared.reach / plain.reach, `${species} foot`).toBeGreaterThan(1.25);
      expect(flared.shade, `${species} contact shade`).toBeLessThan(plain.shade * (TRUNK_ROOT_FLARE_CONTACT_SHADE + 0.2));
    }
  });

  it("runs out into the bole it belongs to", () => {
    const last = TRUNK_ROOT_FLARE_RINGS[TRUNK_ROOT_FLARE_RINGS.length - 1]!;
    expect(last[0]).toBe(TRUNK_ROOT_FLARE_TOP_RISE);
    expect(last[1]).toBe(1);
    expect(last[2]).toBe(0);
    for (let ring = 1; ring < TRUNK_ROOT_FLARE_RINGS.length; ring += 1) {
      expect(TRUNK_ROOT_FLARE_RINGS[ring]![0]).toBeGreaterThan(TRUNK_ROOT_FLARE_RINGS[ring - 1]![0]);
      expect(TRUNK_ROOT_FLARE_RINGS[ring]![1]).toBeLessThan(TRUNK_ROOT_FLARE_RINGS[ring - 1]![1]);
    }
  });

  it("is counted by the estimator ring for ring", () => {
    for (const species of BRANCHING) {
      const skeleton = buildTreeSkeleton(species, 0, 31);
      const flared = estimateSkeletonTriangles(skeleton, NEAR_TREE_MESH_BUDGET);
      const plain = estimateSkeletonTriangles({ ...skeleton, rootFlare: 0 }, NEAR_TREE_MESH_BUDGET);
      expect(flared - plain, species)
        .toBe(2 * NEAR_TREE_MESH_BUDGET.trunkSides * (TRUNK_ROOT_FLARE_RINGS.length - 1));
      // And it is the near model's alone.
      expect(estimateSkeletonTriangles(skeleton, MID_TREE_MESH_BUDGET), species)
        .toBe(estimateSkeletonTriangles({ ...skeleton, rootFlare: 0 }, MID_TREE_MESH_BUDGET));
    }
  });
});
