import { describe, expect, it } from "vitest";
import {
  ATLAS_LAYER_UNTEXTURED,
  FOLIAGE_LAYER_INDEX,
  SHRUB_VARIANT_COUNTS,
  TREE_VARIANT_COUNTS,
  buildClutterPrototype,
  buildGrassPatchPrototype,
  buildRockPrototype,
  buildShrubPrototype,
  buildTreePrototype,
  mergePrototypeGeometry,
  type ClutterKind,
  type PrototypeGeometry,
} from "../src/render/webgpu/detail/prototypeGeometry";
import type {
  RockVariant,
  ShrubSpecies,
  TreeSpecies,
} from "../src/render/webgpu/detail/types";

const TREE_SPECIES = Object.keys(TREE_VARIANT_COUNTS) as TreeSpecies[];
const SHRUB_SPECIES = Object.keys(SHRUB_VARIANT_COUNTS) as ShrubSpecies[];
const ROCK_VARIANTS: RockVariant[] = ["granite", "limestone", "dark"];
const CLUTTER_KINDS: ClutterKind[] = ["log", "stump", "branchLitter", "mossCushion"];

function expectInternallyConsistent(name: string, geometry: PrototypeGeometry): void {
  const vertexCount = geometry.positions.length / 3;
  expect(Number.isInteger(vertexCount), `${name}: whole vertices`).toBe(true);
  expect(geometry.normals.length, `${name}: normals length`).toBe(vertexCount * 3);
  expect(geometry.uvs.length, `${name}: uvs length`).toBe(vertexCount * 2);
  expect(geometry.tangents.length, `${name}: tangents length`).toBe(vertexCount * 4);
  expect(geometry.colors.length, `${name}: colors length`).toBe(vertexCount * 4);
  expect(geometry.atlasLayer.length, `${name}: atlasLayer length`).toBe(vertexCount);
  expect(geometry.indices.length, `${name}: indices length`).toBe(geometry.triangleCount * 3);
  expect(geometry.triangleCount, `${name}: has triangles`).toBeGreaterThan(0);
  for (let i = 0; i < geometry.indices.length; i += 1) {
    const index = geometry.indices[i]!;
    expect(index, `${name}: index ${i} in range`).toBeLessThan(vertexCount);
  }
  for (let i = 0; i < vertexCount; i += 1) {
    const x = geometry.positions[i * 3]!;
    const y = geometry.positions[i * 3 + 1]!;
    const z = geometry.positions[i * 3 + 2]!;
    expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `${name}: finite position`)
      .toBe(true);
    const normalLength = Math.hypot(
      geometry.normals[i * 3]!,
      geometry.normals[i * 3 + 1]!,
      geometry.normals[i * 3 + 2]!,
    );
    expect(normalLength, `${name}: unit normal at ${i}`).toBeGreaterThan(0.98);
    expect(normalLength, `${name}: unit normal at ${i}`).toBeLessThan(1.02);
    expect(Math.abs(geometry.tangents[i * 4 + 3]!), `${name}: tangent w`).toBe(1);
    const alpha = geometry.colors[i * 4 + 3]!;
    expect(alpha, `${name}: occlusion A low bound`).toBeGreaterThanOrEqual(0);
    expect(alpha, `${name}: occlusion A high bound`).toBeLessThanOrEqual(1);
    expect(geometry.colors[i * 4]!, `${name}: rgb tint stays 1`).toBe(1);
    expect(Math.hypot(x, z), `${name}: bounding radius covers vertex ${i}`)
      .toBeLessThanOrEqual(geometry.boundingRadius + 1e-3);
    expect(y, `${name}: bounding height covers vertex ${i}`)
      .toBeLessThanOrEqual(geometry.boundingHeight + 1e-3);
  }
}

/**
 * Crown envelope aspect: RMS radial over RMS vertical spread of the QUAD
 * CENTRES (crowns are emitted as sequential 4-vertex quads, so centres are
 * consecutive-vertex averages). Centres measure the envelope silhouette
 * without per-quad corner extents diluting the signal.
 */
function crownAspect(crown: PrototypeGeometry): number {
  // Every crown carries at least 40 quads and variants of one (species,
  // seed) share their placement-stream prefix, so measuring the first 40
  // isolates the envelope-aspect knob from tail-sampling noise.
  const quadCount = Math.min(crown.positions.length / 12, 40);
  const centers: Array<readonly [number, number, number]> = [];
  for (let q = 0; q < quadCount; q += 1) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let corner = 0; corner < 4; corner += 1) {
      const i = q * 4 + corner;
      cx += crown.positions[i * 3]!;
      cy += crown.positions[i * 3 + 1]!;
      cz += crown.positions[i * 3 + 2]!;
    }
    centers.push([cx / 4, cy / 4, cz / 4]);
  }
  let meanY = 0;
  for (const [, y] of centers) meanY += y;
  meanY /= centers.length;
  let radial = 0;
  let vertical = 0;
  for (const [x, y, z] of centers) {
    radial += x * x + z * z;
    vertical += (y - meanY) * (y - meanY);
  }
  return Math.sqrt(radial / centers.length) / Math.sqrt(vertical / centers.length);
}

/**
 * Inner/outer thirds by SHAPE-NORMALIZED distance from the crown centroid
 * (radial and vertical offsets each divided by their own RMS extent), so
 * "interior" means interior for wide and tall crowns alike.
 */
function occlusionByCrownThirds(crown: PrototypeGeometry): { inner: number; outer: number } {
  const vertexCount = crown.positions.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    cx += crown.positions[i * 3]!;
    cy += crown.positions[i * 3 + 1]!;
    cz += crown.positions[i * 3 + 2]!;
  }
  cx /= vertexCount;
  cy /= vertexCount;
  cz /= vertexCount;
  let radialSq = 0;
  let verticalSq = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const dx = crown.positions[i * 3]! - cx;
    const dy = crown.positions[i * 3 + 1]! - cy;
    const dz = crown.positions[i * 3 + 2]! - cz;
    radialSq += dx * dx + dz * dz;
    verticalSq += dy * dy;
  }
  const radialRms = Math.sqrt(radialSq / vertexCount);
  const verticalRms = Math.sqrt(verticalSq / vertexCount);
  const distances: number[] = [];
  for (let i = 0; i < vertexCount; i += 1) {
    const dx = crown.positions[i * 3]! - cx;
    const dy = crown.positions[i * 3 + 1]! - cy;
    const dz = crown.positions[i * 3 + 2]! - cz;
    distances.push(Math.hypot(Math.hypot(dx, dz) / radialRms, dy / verticalRms));
  }
  const sorted = [...distances].sort((a, b) => a - b);
  const innerCut = sorted[Math.floor(sorted.length / 3)]!;
  const outerCut = sorted[Math.floor((sorted.length * 2) / 3)]!;
  let innerSum = 0;
  let innerCount = 0;
  let outerSum = 0;
  let outerCount = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const alpha = crown.colors[i * 4 + 3]!;
    if (distances[i]! <= innerCut) {
      innerSum += alpha;
      innerCount += 1;
    } else if (distances[i]! >= outerCut) {
      outerSum += alpha;
      outerCount += 1;
    }
  }
  return { inner: innerSum / innerCount, outer: outerSum / outerCount };
}

function uniqueNormalCount(geometry: PrototypeGeometry): number {
  const seen = new Set<string>();
  for (let i = 0; i < geometry.normals.length; i += 3) {
    seen.add(
      `${geometry.normals[i]!.toFixed(4)}:${geometry.normals[i + 1]!.toFixed(4)}:`
      + `${geometry.normals[i + 2]!.toFixed(4)}`,
    );
  }
  return seen.size;
}

describe("vegetation prototype geometry (2-12/2-12b/2-15/2-16)", () => {
  it("holds every triangle budget across species and variants", () => {
    for (const species of TREE_SPECIES) {
      for (let variant = 0; variant < TREE_VARIANT_COUNTS[species]; variant += 1) {
        const { trunk, crown } = buildTreePrototype(species, variant, 31);
        // 40–60 alpha-tested quads, two triangles each.
        expect(crown.triangleCount).toBeGreaterThanOrEqual(80);
        expect(crown.triangleCount).toBeLessThanOrEqual(120);
        expect(crown.triangleCount % 2).toBe(0);
        expect(trunk.triangleCount).toBeGreaterThanOrEqual(48);
        expect(trunk.triangleCount).toBeLessThanOrEqual(140);
      }
    }
    for (const species of SHRUB_SPECIES) {
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        const shrub = buildShrubPrototype(species, variant, 12);
        const quads = shrub.triangleCount / 2;
        expect(quads).toBeGreaterThanOrEqual(12);
        expect(quads).toBeLessThanOrEqual(18);
      }
    }
    for (const variant of ROCK_VARIANTS) {
      expect(buildRockPrototype(variant, 5).triangleCount).toBeLessThanOrEqual(400);
    }
    expect(buildClutterPrototype("log", 9).triangleCount).toBeLessThanOrEqual(80);
    expect(buildClutterPrototype("stump", 9).triangleCount).toBeLessThanOrEqual(60);
    expect(buildClutterPrototype("branchLitter", 9).triangleCount).toBeLessThanOrEqual(12);
    expect(buildClutterPrototype("mossCushion", 9).triangleCount).toBeLessThanOrEqual(36);
    const grass = buildGrassPatchPrototype(3);
    expect(grass.triangleCount).toBeGreaterThanOrEqual(40);
    expect(grass.triangleCount).toBeLessThanOrEqual(56);
  });

  it("rebuilds identically from the same inputs while seeds diverge", () => {
    expect(buildTreePrototype("oak", 1, 7)).toEqual(buildTreePrototype("oak", 1, 7));
    expect(buildShrubPrototype("hazel", 0, 4)).toEqual(buildShrubPrototype("hazel", 0, 4));
    expect(buildRockPrototype("granite", 11)).toEqual(buildRockPrototype("granite", 11));
    expect(buildClutterPrototype("log", 2)).toEqual(buildClutterPrototype("log", 2));
    expect(buildGrassPatchPrototype(8)).toEqual(buildGrassPatchPrototype(8));

    const seedA = buildTreePrototype("oak", 1, 7).crown.positions;
    const seedB = buildTreePrototype("oak", 1, 8).crown.positions;
    expect(Array.from(seedA)).not.toEqual(Array.from(seedB));
    expect(Array.from(buildRockPrototype("granite", 1).positions))
      .not.toEqual(Array.from(buildRockPrototype("dark", 1).positions));
  });

  it("keeps crown silhouettes pairwise distinct across variants (aspect ≥ 5%)", () => {
    for (const species of TREE_SPECIES) {
      const count = TREE_VARIANT_COUNTS[species];
      const aspects: number[] = [];
      for (let variant = 0; variant < count; variant += 1) {
        aspects.push(crownAspect(buildTreePrototype(species, variant, 17).crown));
      }
      for (let a = 0; a < aspects.length; a += 1) {
        for (let b = a + 1; b < aspects.length; b += 1) {
          const relative = Math.abs(aspects[a]! - aspects[b]!) / Math.max(aspects[a]!, aspects[b]!);
          expect(relative, `${species} variants ${a}/${b}`).toBeGreaterThanOrEqual(0.05);
        }
      }
    }
  });

  it("bakes darker occlusion into crown interiors than outer tips", () => {
    for (const species of TREE_SPECIES) {
      const { crown } = buildTreePrototype(species, 0, 5);
      const { inner, outer } = occlusionByCrownThirds(crown);
      expect(inner, `${species} interior vs tips`).toBeLessThanOrEqual(outer * 0.75);
    }
    // Shrubs get the same bake; require some interior darkening.
    for (const species of SHRUB_SPECIES) {
      const shrub = buildShrubPrototype(species, 0, 5);
      let minAlpha = 1;
      for (let i = 3; i < shrub.colors.length; i += 4) {
        minAlpha = Math.min(minAlpha, shrub.colors[i]!);
      }
      expect(minAlpha, `${species} has occluded vertices`).toBeLessThan(0.9);
    }
  });

  it("separates flat granite/dark shading from smooth limestone shading", () => {
    const granite = buildRockPrototype("granite", 21);
    const limestone = buildRockPrototype("limestone", 21);
    const dark = buildRockPrototype("dark", 21);
    // Flat: one normal per face, vertices duplicated (320 faces at 2
    // subdivisions). Smooth: one normal per shared vertex (162). The
    // per-face/per-vertex structure is the lithology signal; the achievable
    // unique-normal ratio at this tessellation is 320/162 ≈ 2×.
    expect(uniqueNormalCount(granite)).toBeGreaterThanOrEqual(0.95 * granite.triangleCount);
    expect(uniqueNormalCount(dark)).toBeGreaterThanOrEqual(0.95 * dark.triangleCount);
    const limestoneVertices = limestone.positions.length / 3;
    expect(uniqueNormalCount(limestone)).toBeLessThanOrEqual(limestoneVertices);
    expect(limestoneVertices * 3).toBeLessThanOrEqual(granite.positions.length / 3 * 1.01 * 3);
    expect(uniqueNormalCount(granite) / uniqueNormalCount(limestone)).toBeGreaterThanOrEqual(1.8);
    // Flat variants duplicate vertices per face; smooth shares them.
    expect(granite.positions.length / 3).toBe(granite.triangleCount * 3);
    expect(limestoneVertices).toBeLessThan(granite.positions.length / 3 / 2);
  });

  it("keeps every produced geometry internally consistent", () => {
    const all: Array<readonly [string, PrototypeGeometry]> = [];
    for (const species of TREE_SPECIES) {
      for (let variant = 0; variant < TREE_VARIANT_COUNTS[species]; variant += 1) {
        const { trunk, crown } = buildTreePrototype(species, variant, 41);
        all.push([`${species}/${variant}/trunk`, trunk], [`${species}/${variant}/crown`, crown]);
      }
    }
    for (const species of SHRUB_SPECIES) {
      for (let variant = 0; variant < SHRUB_VARIANT_COUNTS[species]; variant += 1) {
        all.push([`shrub/${species}/${variant}`, buildShrubPrototype(species, variant, 41)]);
      }
    }
    for (const variant of ROCK_VARIANTS) {
      all.push([`rock/${variant}`, buildRockPrototype(variant, 41)]);
    }
    for (const kind of CLUTTER_KINDS) {
      all.push([`clutter/${kind}`, buildClutterPrototype(kind, 41)]);
    }
    all.push(["grass", buildGrassPatchPrototype(41)]);
    for (const [name, geometry] of all) {
      expectInternallyConsistent(name, geometry);
    }
  });

  it("keeps tangents orthogonal to normals on textured geometry", () => {
    const textured: PrototypeGeometry[] = [
      buildTreePrototype("pine", 0, 3).trunk,
      buildTreePrototype("pine", 0, 3).crown,
      buildTreePrototype("willow", 2, 3).trunk,
      buildTreePrototype("willow", 2, 3).crown,
      buildShrubPrototype("sage", 1, 3),
      buildClutterPrototype("log", 3),
      buildClutterPrototype("stump", 3),
      buildClutterPrototype("branchLitter", 3),
      buildGrassPatchPrototype(3),
    ];
    for (const geometry of textured) {
      const vertexCount = geometry.positions.length / 3;
      for (let i = 0; i < vertexCount; i += 1) {
        if (geometry.atlasLayer[i]! < 0) continue;
        const dot = geometry.normals[i * 3]! * geometry.tangents[i * 4]!
          + geometry.normals[i * 3 + 1]! * geometry.tangents[i * 4 + 1]!
          + geometry.normals[i * 3 + 2]! * geometry.tangents[i * 4 + 2]!;
        expect(Math.abs(dot)).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it("assigns the reconciled foliage-atlas layers per species", () => {
    const layerOf = (geometry: PrototypeGeometry): number => geometry.atlasLayer[0]!;
    const uniformLayer = (geometry: PrototypeGeometry): void => {
      for (let i = 0; i < geometry.atlasLayer.length; i += 1) {
        expect(geometry.atlasLayer[i]).toBe(geometry.atlasLayer[0]);
      }
    };
    const pine = buildTreePrototype("pine", 0, 1);
    const spruce = buildTreePrototype("spruce", 0, 1);
    const oak = buildTreePrototype("oak", 0, 1);
    const maple = buildTreePrototype("maple", 0, 1);
    const birch = buildTreePrototype("birch", 0, 1);
    expect(layerOf(pine.crown)).toBe(FOLIAGE_LAYER_INDEX.needlePine);
    expect(layerOf(spruce.crown)).toBe(FOLIAGE_LAYER_INDEX.needleSpruce);
    expect(layerOf(oak.crown)).toBe(FOLIAGE_LAYER_INDEX.broadleafOak);
    expect(layerOf(maple.crown)).toBe(FOLIAGE_LAYER_INDEX.broadleafMaple);
    expect(layerOf(birch.crown)).toBe(FOLIAGE_LAYER_INDEX.broadleafBirch);
    expect(layerOf(pine.trunk)).toBe(FOLIAGE_LAYER_INDEX.barkConifer);
    expect(layerOf(oak.trunk)).toBe(FOLIAGE_LAYER_INDEX.barkBroadleaf);
    expect(layerOf(birch.trunk)).toBe(FOLIAGE_LAYER_INDEX.barkBirch);
    for (const geometry of [pine.crown, oak.trunk]) uniformLayer(geometry);
    expect(layerOf(buildShrubPrototype("juniper", 0, 1))).toBe(FOLIAGE_LAYER_INDEX.juniperScale);
    expect(layerOf(buildShrubPrototype("hazel", 0, 1))).toBe(FOLIAGE_LAYER_INDEX.hazelLeaf);
    expect(layerOf(buildShrubPrototype("sage", 0, 1))).toBe(FOLIAGE_LAYER_INDEX.sageLeaf);
    expect(layerOf(buildRockPrototype("granite", 1))).toBe(ATLAS_LAYER_UNTEXTURED);
    expect(layerOf(buildClutterPrototype("mossCushion", 1))).toBe(ATLAS_LAYER_UNTEXTURED);
    expect(layerOf(buildClutterPrototype("branchLitter", 1))).toBe(FOLIAGE_LAYER_INDEX.litterTwig);
    expect(layerOf(buildClutterPrototype("log", 1))).toBe(FOLIAGE_LAYER_INDEX.barkConifer);
    expect(layerOf(buildGrassPatchPrototype(1))).toBe(FOLIAGE_LAYER_INDEX.grassBlade);
    expect(TREE_VARIANT_COUNTS).toEqual({
      pine: 5, cedar: 3, spruce: 3, oak: 5, maple: 3, birch: 5, willow: 3,
    });
    expect(SHRUB_VARIANT_COUNTS).toEqual({ juniper: 2, hazel: 2, sage: 2 });
  });

  it("ramps grass occlusion 0.75 at the base to 1 at the tip", () => {
    const grass = buildGrassPatchPrototype(6);
    const vertexCount = grass.positions.length / 3;
    let sawBase = false;
    let sawTip = false;
    for (let i = 0; i < vertexCount; i += 1) {
      const v = grass.uvs[i * 2 + 1]!;
      const alpha = grass.colors[i * 4 + 3]!;
      if (v === 0) {
        expect(alpha).toBeCloseTo(0.75, 5);
        sawBase = true;
      }
      if (v === 1) {
        expect(alpha).toBeCloseTo(1, 5);
        sawTip = true;
      }
    }
    expect(sawBase).toBe(true);
    expect(sawTip).toBe(true);
  });

  it("merges parts with offset indices and combined bounds", () => {
    const { trunk, crown } = buildTreePrototype("maple", 1, 13);
    const merged = mergePrototypeGeometry([trunk, crown]);
    const trunkVertices = trunk.positions.length / 3;
    expect(merged.positions.length).toBe(trunk.positions.length + crown.positions.length);
    expect(merged.triangleCount).toBe(trunk.triangleCount + crown.triangleCount);
    expect(merged.boundingRadius).toBe(Math.max(trunk.boundingRadius, crown.boundingRadius));
    expect(merged.boundingHeight).toBe(Math.max(trunk.boundingHeight, crown.boundingHeight));
    // The second part's indices are offset by the first part's vertex count.
    expect(merged.indices[trunk.indices.length]).toBe(crown.indices[0]! + trunkVertices);
    // Merged vertex data round-trips.
    expect(merged.atlasLayer[trunkVertices]).toBe(crown.atlasLayer[0]);
    expectInternallyConsistent("merged maple", merged);
    const empty = mergePrototypeGeometry([]);
    expect(empty.triangleCount).toBe(0);
    expect(empty.positions.length).toBe(0);
  });
});
