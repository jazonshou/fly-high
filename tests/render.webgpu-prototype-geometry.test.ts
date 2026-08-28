import { describe, expect, it } from "vitest";
import {
  ATLAS_LAYER_UNTEXTURED,
  FOLIAGE_LAYER_INDEX,
  SHRUB_VARIANT_COUNTS,
  TREE_VARIANT_COUNTS,
  buildClutterPrototype,
  buildCrownFringePrototype,
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
    expect(x, `${name}: local min x covers vertex ${i}`)
      .toBeGreaterThanOrEqual(geometry.localBounds.minimum[0]);
    expect(y, `${name}: local min y covers vertex ${i}`)
      .toBeGreaterThanOrEqual(geometry.localBounds.minimum[1]);
    expect(z, `${name}: local min z covers vertex ${i}`)
      .toBeGreaterThanOrEqual(geometry.localBounds.minimum[2]);
    expect(x, `${name}: local max x covers vertex ${i}`)
      .toBeLessThanOrEqual(geometry.localBounds.maximum[0]);
    expect(y, `${name}: local max y covers vertex ${i}`)
      .toBeLessThanOrEqual(geometry.localBounds.maximum[1]);
    expect(z, `${name}: local max z covers vertex ${i}`)
      .toBeLessThanOrEqual(geometry.localBounds.maximum[2]);
  }
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

function indexedComponents(geometry: PrototypeGeometry): number {
  const vertexCount = geometry.positions.length / 3;
  const neighbours = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let at = 0; at < geometry.indices.length; at += 3) {
    const triangle = [
      geometry.indices[at]!,
      geometry.indices[at + 1]!,
      geometry.indices[at + 2]!,
    ];
    for (let corner = 0; corner < 3; corner += 1) {
      neighbours[triangle[corner]!]!.add(triangle[(corner + 1) % 3]!);
      neighbours[triangle[(corner + 1) % 3]!]!.add(triangle[corner]!);
    }
  }
  const visited = new Set<number>();
  let components = 0;
  for (let start = 0; start < vertexCount; start += 1) {
    if (visited.has(start) || neighbours[start]!.size === 0) continue;
    components += 1;
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbour of neighbours[current]!) pending.push(neighbour);
    }
  }
  return components;
}

function indexedEdgeUse(geometry: PrototypeGeometry): readonly number[] {
  const edges = new Map<string, number>();
  for (let at = 0; at < geometry.indices.length; at += 3) {
    const triangle = [
      geometry.indices[at]!,
      geometry.indices[at + 1]!,
      geometry.indices[at + 2]!,
    ];
    for (let edge = 0; edge < 3; edge += 1) {
      const first = triangle[edge]!;
      const second = triangle[(edge + 1) % 3]!;
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()];
}

function areaWeightedNormalDots(geometry: PrototypeGeometry): readonly number[] {
  const vertexCount = geometry.positions.length / 3;
  const sums = new Float64Array(vertexCount * 3);
  for (let at = 0; at < geometry.indices.length; at += 3) {
    const ia = geometry.indices[at]!;
    const ib = geometry.indices[at + 1]!;
    const ic = geometry.indices[at + 2]!;
    const ax = geometry.positions[ia * 3]!;
    const ay = geometry.positions[ia * 3 + 1]!;
    const az = geometry.positions[ia * 3 + 2]!;
    const abx = geometry.positions[ib * 3]! - ax;
    const aby = geometry.positions[ib * 3 + 1]! - ay;
    const abz = geometry.positions[ib * 3 + 2]! - az;
    const acx = geometry.positions[ic * 3]! - ax;
    const acy = geometry.positions[ic * 3 + 1]! - ay;
    const acz = geometry.positions[ic * 3 + 2]! - az;
    const cross = [
      aby * acz - abz * acy,
      abz * acx - abx * acz,
      abx * acy - aby * acx,
    ] as const;
    for (const index of [ia, ib, ic]) {
      sums[index * 3] = sums[index * 3]! + cross[0];
      sums[index * 3 + 1] = sums[index * 3 + 1]! + cross[1];
      sums[index * 3 + 2] = sums[index * 3 + 2]! + cross[2];
    }
  }
  const dots: number[] = [];
  for (let index = 0; index < vertexCount; index += 1) {
    const length = Math.hypot(sums[index * 3]!, sums[index * 3 + 1]!, sums[index * 3 + 2]!);
    dots.push(
      geometry.normals[index * 3]! * sums[index * 3]! / length
      + geometry.normals[index * 3 + 1]! * sums[index * 3 + 1]! / length
      + geometry.normals[index * 3 + 2]! * sums[index * 3 + 2]! / length,
    );
  }
  return dots;
}

describe("vegetation prototype geometry (2-12/2-12b/2-15/2-16)", () => {
  it("holds every triangle budget across species and variants", () => {
    for (const species of TREE_SPECIES) {
      for (let variant = 0; variant < TREE_VARIANT_COUNTS[species]; variant += 1) {
        // Wave T: a tree is bark skeleton + interior core + leaf-card shell,
        // and the law prices the whole near composition at 1,500 triangles
        // (measured 824–1,376 across the species) and mid at 340.
        const { trunk, crown, envelopeRadius } = buildTreePrototype(species, variant, 31);
        const cards = buildCrownFringePrototype(species, variant, 31, "near");
        // The interior core keeps the closed-hull construction and stays on
        // the opaque dense layers.
        expect(crown.triangleCount).toBeGreaterThanOrEqual(60);
        expect(crown.triangleCount).toBeLessThanOrEqual(80);
        expect(crown.atlasLayer.every((layer) => layer >= 16 && layer <= 17)).toBe(true);
        // The bark part carries the trunk and two branch levels now.
        expect(trunk.triangleCount).toBeGreaterThanOrEqual(400);
        expect(trunk.triangleCount).toBeLessThanOrEqual(1_150);
        expect(
          trunk.triangleCount + crown.triangleCount + cards.triangleCount,
          `${species} v${variant} near total`,
        ).toBeLessThanOrEqual(1_500);
        const mid = buildTreePrototype(species, variant, 31, "mid");
        const cardsMid = buildCrownFringePrototype(species, variant, 31, "mid");
        // Mid meshes the SAME skeleton (identical envelope — the shared
        // radial contract) at reduced detail; it is no longer byte-identical
        // to near.
        expect(mid.envelopeRadius).toBe(envelopeRadius);
        expect(
          mid.trunk.triangleCount + mid.crown.triangleCount + cardsMid.triangleCount,
          `${species} v${variant} mid total`,
        ).toBeLessThanOrEqual(340);
        expect(mid.crown.atlasLayer.every((layer) => layer >= 16 && layer <= 17)).toBe(true);
        expect(cards.atlasLayer.every((layer) => layer >= 0 && layer <= 4)).toBe(true);
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

  it("builds each broadleaf as one watertight 80-triangle hull with final normals", () => {
    for (const species of ["oak", "maple", "birch", "willow"] as const) {
      const crown = buildTreePrototype(species, 0, 31).crown;
      expect(crown.triangleCount, species).toBe(80);
      expect(indexedComponents(crown), species).toBe(1);
      expect(indexedEdgeUse(crown).every((uses) => uses === 2), species).toBe(true);
      expect(Math.min(...areaWeightedNormalDots(crown)), species).toBeGreaterThan(0.999);
    }
  });

  it("smooths conifer side normals while keeping bottom caps separate", () => {
    const crown = buildTreePrototype("pine", 0, 31).crown;
    const atPosition = new Map<string, Array<readonly [number, number, number]>>();
    for (let index = 0; index < crown.positions.length / 3; index += 1) {
      const key = `${crown.positions[index * 3]!.toFixed(5)}:`
        + `${crown.positions[index * 3 + 1]!.toFixed(5)}:`
        + `${crown.positions[index * 3 + 2]!.toFixed(5)}`;
      const normals = atPosition.get(key) ?? [];
      normals.push([
        crown.normals[index * 3]!,
        crown.normals[index * 3 + 1]!,
        crown.normals[index * 3 + 2]!,
      ]);
      atPosition.set(key, normals);
    }
    let rimPositions = 0;
    for (const normals of atPosition.values()) {
      const caps = normals.filter((normal) => normal[1] < -0.99);
      const sides = normals.filter((normal) => normal[1] > -0.5);
      if (caps.length === 0 || sides.length < 2) continue;
      rimPositions += 1;
      const first = sides[0]!;
      for (const side of sides.slice(1)) {
        const dot = first[0] * side[0] + first[1] * side[1] + first[2] * side[2];
        expect(dot).toBeGreaterThan(0.9999);
      }
    }
    expect(rimPositions).toBe(32);
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

  it("keeps variants pairwise distinct as full topological re-rolls", () => {
    // Wave T replaced the old per-variant aspect knob with a full skeleton
    // re-roll per variant: branch layout, card placement, and envelope all
    // differ. The guarantee is structural distinctness, not a fixed aspect
    // spread — assert every variant pair differs in bark geometry AND card
    // placement, and that the species' variant set is not silhouette-flat.
    for (const species of TREE_SPECIES) {
      const count = TREE_VARIANT_COUNTS[species];
      const barks: Float32Array[] = [];
      const cards: Float32Array[] = [];
      const envelopes: number[] = [];
      for (let variant = 0; variant < count; variant += 1) {
        const prototype = buildTreePrototype(species, variant, 17);
        barks.push(prototype.trunk.positions);
        cards.push(buildCrownFringePrototype(species, variant, 17, "near").positions);
        envelopes.push(prototype.envelopeRadius);
      }
      for (let a = 0; a < count; a += 1) {
        for (let b = a + 1; b < count; b += 1) {
          expect(
            Array.from(barks[a]!),
            `${species} bark variants ${a}/${b}`,
          ).not.toEqual(Array.from(barks[b]!));
          expect(
            Array.from(cards[a]!),
            `${species} card variants ${a}/${b}`,
          ).not.toEqual(Array.from(cards[b]!));
        }
      }
      const spread = (Math.max(...envelopes) - Math.min(...envelopes)) / Math.max(...envelopes);
      expect(spread, `${species} envelope spread`).toBeGreaterThan(0.01);
    }
  });

  it("bakes restrained directional occlusion into cores and card shells", () => {
    for (const species of TREE_SPECIES) {
      // Wave T: the interior core is DARK by design (it reads as the
      // canopy's shadowed interior behind the card shell) while the cards
      // carry the lit exterior with real baked sky occlusion.
      const { crown } = buildTreePrototype(species, 0, 5);
      const alpha: number[] = [];
      for (let index = 3; index < crown.colors.length; index += 4) alpha.push(crown.colors[index]!);
      expect(Math.min(...alpha), `${species} shaded core vertices`).toBeLessThanOrEqual(0.45);
      expect(Math.max(...alpha), `${species} core stays interior-dark`).toBeLessThanOrEqual(0.75);
      const cards = buildCrownFringePrototype(species, 0, 5, "near");
      const cardAlpha: number[] = [];
      for (let index = 3; index < cards.colors.length; index += 4) {
        cardAlpha.push(cards.colors[index]!);
      }
      expect(Math.max(...cardAlpha), `${species} lit card vertices`).toBeGreaterThanOrEqual(0.7);
      expect(Math.min(...cardAlpha), `${species} occluded card vertices`).toBeLessThan(0.6);
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

  it("keeps the primary trunk smooth across ring transitions and its UV seam", () => {
    for (const species of TREE_SPECIES) {
      const trunk = buildTreePrototype(species, 0, 31).trunk;
      // The primary trunk is five rings of nine seam-duplicated vertices.
      for (let ring = 0; ring < 5; ring += 1) {
        const first = ring * 9;
        const repeated = first + 8;
        for (let component = 0; component < 3; component += 1) {
          expect(
            trunk.positions[first * 3 + component],
            `${species} ring ${ring} seam position component ${component}`,
          ).toBeCloseTo(trunk.positions[repeated * 3 + component]!, 6);
          expect(
            trunk.normals[first * 3 + component],
            `${species} ring ${ring} seam normal component ${component}`,
          ).toBeCloseTo(trunk.normals[repeated * 3 + component]!, 6);
        }
      }
      for (let ring = 0; ring < 4; ring += 1) {
        for (let side = 0; side < 8; side += 1) {
          const first = ring * 9 + side;
          const second = (ring + 1) * 9 + side;
          const dot = Math.min(1, Math.max(-1,
            trunk.normals[first * 3]! * trunk.normals[second * 3]!
            + trunk.normals[first * 3 + 1]! * trunk.normals[second * 3 + 1]!
            + trunk.normals[first * 3 + 2]! * trunk.normals[second * 3 + 2]!,
          ));
          // A hard per-ring shading split approaches a 90° change. The
          // intended root flare is the strongest transition today (<23°),
          // so 30° preserves its shape while permanently rejecting bands.
          expect(
            Math.acos(dot) * 180 / Math.PI,
            `${species} rings ${ring}-${ring + 1} side ${side}`,
          ).toBeLessThan(30);
        }
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
    expect(layerOf(pine.crown)).toBe(FOLIAGE_LAYER_INDEX.crownConiferDense);
    expect(layerOf(spruce.crown)).toBe(FOLIAGE_LAYER_INDEX.crownConiferDense);
    expect(layerOf(oak.crown)).toBe(FOLIAGE_LAYER_INDEX.crownBroadleafDense);
    expect(layerOf(maple.crown)).toBe(FOLIAGE_LAYER_INDEX.crownBroadleafDense);
    expect(layerOf(birch.crown)).toBe(FOLIAGE_LAYER_INDEX.crownBroadleafDense);
    expect(layerOf(buildTreePrototype("pine", 0, 1, "mid").crown))
      .toBe(FOLIAGE_LAYER_INDEX.crownConiferDense);
    expect(layerOf(buildTreePrototype("oak", 0, 1, "mid").crown))
      .toBe(FOLIAGE_LAYER_INDEX.crownBroadleafDense);
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
