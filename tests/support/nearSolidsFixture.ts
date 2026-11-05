import { TerrainBiome } from "../../src/world";
import { generateDetailCell } from "../../src/render/webgpu/detail/generation";
import {
  detailPrototypeBoundKernel,
  type DetailBillboardFrameBounds,
} from "../../src/render/webgpu/detail/instanceFormat";
import { DETAIL_PROTOTYPE_SEED } from "../../src/render/webgpu/detail/nearSolidsSelection";
import {
  detailTreeCanopyRankOrder,
  type DetailPresentationBuildCatalog,
} from "../../src/render/webgpu/detail/presentationBuild";
import {
  buildRockPrototype,
  buildTreePrototype,
  TREE_VARIANT_COUNTS,
} from "../../src/render/webgpu/detail/prototypeGeometry";
import { treePrototypeSpecies } from "../../src/render/webgpu/detail/treePrototypeFamily";
import type {
  ClutterKind,
  GeneratedDetailCell,
  GroundCoverArchetype,
  RockVariant,
  ShrubSpecies,
  TreeSpecies,
} from "../../src/render/webgpu/detail/types";

/**
 * Fixtures for the near-solids tests: a presentation catalog whose trees and
 * rocks carry the real prototypes' radial contracts (as `WorldDetailRuntime`
 * registers them), and a generated forest cell.
 */

export const TREE_SPECIES: readonly TreeSpecies[] = [
  "pine", "cedar", "spruce", "oak", "maple", "birch", "willow", "palm",
];
const SHRUB_SPECIES: readonly ShrubSpecies[] = ["juniper", "hazel", "sage"];
export const ROCK_VARIANTS: readonly RockVariant[] = ["granite", "limestone", "dark"];
const CLUTTER_KINDS: readonly ClutterKind[] = ["log", "stump", "branchLitter", "mossCushion"];
const GROUND_ARCHETYPES: readonly GroundCoverArchetype[] = ["grass", "fern", "heather", "reed"];

const UNIT_BOUND_KERNEL = detailPrototypeBoundKernel({ minimum: [-1, 0, -1], maximum: [1, 1, 1] });
const IMPOSTOR_FRAME: DetailBillboardFrameBounds = { extentUnit: 1, centerYUnit: 0.5 };

export function realDetailCatalog(): DetailPresentationBuildCatalog {
  const prototypes: Record<string, DetailPresentationBuildCatalog["prototypes"][string]> = {};
  const add = (key: string, radialUnits?: number): void => {
    prototypes[key] = radialUnits === undefined
      ? { boundKernel: UNIT_BOUND_KERNEL }
      : { radialUnits, boundKernel: UNIT_BOUND_KERNEL };
  };
  const impostors: Partial<Record<TreeSpecies, NonNullable<DetailPresentationBuildCatalog["impostors"][TreeSpecies]>>> = {};
  for (const species of TREE_SPECIES) {
    for (let variant = 0; variant < TREE_VARIANT_COUNTS[species]; variant += 1) {
      const envelope = Math.max(buildTreePrototype(species, variant, DETAIL_PROTOTYPE_SEED).envelopeRadius, 0.05);
      if (variant === 0) impostors[species] = { radialUnits: envelope, frame: IMPOSTOR_FRAME };
      for (const band of ["near", "mid"] as const) {
        add(`tree-${species}-v${variant}-crown-${band}`, envelope);
        add(`tree-${species}-v${variant}-fringe-${band}`, envelope);
        add(`tree-${species}-v${variant}-trunk-${band}`, envelope);
      }
      add(`tree-${species}-v${variant}-crown-far`, envelope);
    }
  }
  add("tree-impostor");
  for (const species of SHRUB_SPECIES) {
    for (let variant = 0; variant < 2; variant += 1) add(`shrub-${species}-v${variant}`, 0.5);
  }
  for (const variant of ROCK_VARIANTS) {
    add(`rock-${variant}`, Math.max(buildRockPrototype(variant, DETAIL_PROTOTYPE_SEED).boundingRadius, 0.05));
  }
  for (const kind of CLUTTER_KINDS) add(`clutter-${kind}`);
  for (const archetype of GROUND_ARCHETYPES) add(`ground-${archetype}`);
  const trees = Object.fromEntries(TREE_SPECIES.map((species) => [
    species,
    {
      prototypeFamily: treePrototypeSpecies(species, "families"),
      variantCount: TREE_VARIANT_COUNTS[species],
      trunkTint: [1, 1, 1, 1] as const,
    },
  ])) as DetailPresentationBuildCatalog["trees"];
  const shrubs = Object.fromEntries(SHRUB_SPECIES.map((species) => [species, { variantCount: 2 }])) as DetailPresentationBuildCatalog["shrubs"];
  return { prototypes, impostors, trees, shrubs, groundCoverGrid: 8, useImpostors: true };
}

/** The fixture forest's ground, as its sampler gives it. */
export function forestHeight(x: number, z: number): number {
  return 140 + Math.sin(x * 0.01) * 4 + Math.cos(z * 0.013) * 3;
}

function forestNormal(x: number, z: number): { x: number; y: number; z: number } {
  const dhdx = 0.04 * Math.cos(x * 0.01);
  const dhdz = -0.039 * Math.sin(z * 0.013);
  const length = Math.hypot(dhdx, 1, dhdz);
  return { x: -dhdx / length, y: 1 / length, z: -dhdz / length };
}

/**
 * A generated cell of gently sloping mixed forest (6,700 stems), with rocks,
 * logs, stumps, branch litter and moss strewn within 20 m of
 * (`minX + 240`, `minZ + 270`): the generator places too few of them for a
 * test to find near one point.
 */
export function forestCell(cellX = 3, cellZ = -2): { cell: GeneratedDetailCell; treeCanopyRank: Float32Array } {
  const generated = generateDetailCell({
    worldSeed: "ecology-seed-a",
    cellX,
    cellZ,
    terrainSample: (x, z) => ({
      height: forestHeight(x, z),
      slope: 0.12,
      moisture: 0.6,
      biome: TerrainBiome.FOREST,
      normal: forestNormal(x, z),
    }),
  });
  const centerX = generated.minX + 240;
  const centerZ = generated.minZ + 270;
  const rocks = [...generated.rocks];
  const clutter = [...generated.clutter];
  for (let i = 0; i < 12; i += 1) {
    const angle = i * 2.39996;
    const distance = 3 + (i * 7.3) % 17;
    const x = centerX + Math.cos(angle) * distance;
    const z = centerZ + Math.sin(angle) * distance;
    const radius = 0.5 + ((i * 0.37) % 1) * 2.6;
    const flattening = 0.45 + ((i * 0.61) % 1) * 0.45;
    rocks.push({
      kind: "rock",
      id: `strewn/rock/${i}`,
      variant: ROCK_VARIANTS[i % 3]!,
      x,
      y: forestHeight(x, z) - radius * flattening * (0.12 + 0.02 * i),
      z,
      yawRadians: i * 0.9,
      radiusMeters: radius,
      flattening,
      color: [0.4, 0.4, 0.4, 1],
      selection: (i * 0.23) % 1,
      normal: i % 2 === 0 ? forestNormal(x, z) : { x: 0.17, y: 0.97, z: -0.17 },
    });
  }
  const kinds: readonly ClutterKind[] = ["log", "stump", "log", "stump", "branchLitter", "mossCushion"];
  for (let i = 0; i < 18; i += 1) {
    const angle = i * 1.7 + 0.4;
    const distance = 2 + (i * 5.9) % 18;
    const x = centerX + Math.cos(angle) * distance;
    const z = centerZ + Math.sin(angle) * distance;
    const clutterKind = kinds[i % kinds.length]!;
    clutter.push({
      kind: "clutter",
      id: `strewn/clutter/${i}`,
      clutterKind,
      x,
      y: forestHeight(x, z),
      z,
      yawRadians: i * 1.3,
      sizeMeters: clutterKind === "log" ? 2.4 + ((i * 0.41) % 1) * 2.2 : 0.8 + ((i * 0.41) % 1) * 0.8,
      color: [0.6, 0.55, 0.5, 1],
      selection: (i * 0.29) % 1,
      normal: i % 3 === 0 ? { x: -0.2, y: 0.96, z: 0.2 } : forestNormal(x, z),
    });
  }
  const cell: GeneratedDetailCell = { ...generated, rocks, clutter };
  return { cell, treeCanopyRank: detailTreeCanopyRankOrder(cell.trees) };
}
