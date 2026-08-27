import type { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import type { Scene } from "@babylonjs/core/scene";
import type { WorldSeed } from "@/src/world/types";
import {
  alphaDilate,
  planMippedTextureArray,
  uploadMippedTextureArrayPlan,
  type MippedTextureArrayPlan,
} from "../core/TextureArrayMips";
import { planFoliageAtlas, FOLIAGE_ATLAS_EDGE } from "./FoliageAtlas";
import {
  buildCrownFringePrototype,
  buildTreePrototype,
  type PrototypeGeometry,
} from "./prototypeGeometry";
import type { TreeSpecies } from "./types";

/**
 * 2-17 — the octahedral impostor atlas (owner: vegetation).
 *
 * INVARIANT THIS FILE OWNS: the far-band tree impostor is a CPU bake — a
 * pure function of the world seed, like every other atlas in the renderer —
 * so the bake runs byte-identically in Node, the exit criterion ("impostor
 * and card LOD mean colour match") is a unit test rather than a capture
 * diff, and the upload rides the SAME coverage-preserving mip machinery as
 * the foliage atlas. Each species bakes 16 hemi-octahedral views into a
 * 4×4 grid of 64² tiles on a 256² layer, twice (2-17a's leafed and bare
 * season buckets — conifers bake identical buckets and the cross-fade is a
 * no-op for them). Two arrays: albedo+coverage (rgba8) and world-space
 * normal + normalized depth (rgba8).
 *
 * 64² tiles are a recorded decision against the plan's 128² sketch: the
 * §5.2 headroom the plan itself flags as "does not close" at 128², and a
 * far-band tree subtends ≤ ~20 px (20 m at 1.4 km), so 64² already
 * oversamples every on-screen impostor.
 *
 * Class P: deterministic, no Babylon in the bake path; the single GPU
 * boundary is `createImpostorAtlas`'s upload calls.
 */

export const IMPOSTOR_VIEW_GRID = 4;
export const IMPOSTOR_TILE_EDGE = 64;
export const IMPOSTOR_LAYER_EDGE = IMPOSTOR_VIEW_GRID * IMPOSTOR_TILE_EDGE;
export const IMPOSTOR_SEASON_BUCKETS = 2;
export const IMPOSTOR_ALPHA_TEST_THRESHOLD = 0.5;
/** Leaf fraction baked into the bare bucket for deciduous species. */
export const IMPOSTOR_BARE_LEAF_FRACTION = 0.08;

const DECIDUOUS_IMPOSTORS: ReadonlySet<TreeSpecies> = new Set([
  "oak", "maple", "birch", "willow",
]);

/**
 * The 2-13a leaf-shed DISSOLVE, shared verbatim (in spirit) with the card
 * fragment: a uv-cell hash against the leaf fraction. A threshold lift
 * cannot shed painted leaves — their interiors carry alpha ≈ 1, so lifting
 * 0.5 → 0.86 only removed antialiased edges (measured 17.1% → 16.3%
 * coverage). Quantized to uv cells so leaves drop in leaf-sized clumps.
 */
export function leafDissolveSurvives(u: number, v: number, leafFraction: number): boolean {
  if (leafFraction >= 0.999) return true;
  const cellX = Math.floor(((u % 1) + 1) % 1 * 40);
  const cellY = Math.floor(((v % 1) + 1) % 1 * 40);
  const hash = Math.sin(cellX * 127.1 + cellY * 311.7) * 43758.5453;
  return hash - Math.floor(hash) <= leafFraction;
}

export const IMPOSTOR_SPECIES: readonly TreeSpecies[] = [
  "pine", "cedar", "spruce", "oak", "maple", "birch", "willow",
];

/**
 * Shared material albedos: the bake multiplies card texels by these exactly
 * as the crown/bark materials do, so the impostor's mean colour tracks the
 * card LOD by construction. The runtime reads the same constants.
 */
export const DETAIL_CROWN_ALBEDO: readonly [number, number, number] = [0.92, 0.91, 0.8];
export const DETAIL_BARK_ALBEDO: readonly [number, number, number] = [0.58, 0.52, 0.46];

/** Baked crown occlusion floor — mirrors the plugin's mix(0.42, 1, occlusion). */
const OCCLUSION_FLOOR = 0.42;

export interface ImpostorAtlasPlans {
  readonly albedo: MippedTextureArrayPlan;
  readonly normalDepth: MippedTextureArrayPlan;
  readonly layerCount: number;
}

/** Layer index for a species and season bucket (0 leafed, 1 bare). */
export function impostorLayerIndex(species: TreeSpecies, bucket: 0 | 1): number {
  return IMPOSTOR_SPECIES.indexOf(species) * IMPOSTOR_SEASON_BUCKETS + bucket;
}

// ---------------------------------------------------------------------------
// Hemi-octahedral mapping.
// ---------------------------------------------------------------------------

/**
 * Decode grid coordinates in [0, 1]² to a unit upper-hemisphere direction.
 * Standard hemi-octahedral: the square is the |x|+|z| ≤ 1 diamond rotated
 * 45°, with y = 1 − |x| − |z| ≥ 0.
 */
export function hemiOctahedralDirection(u: number, v: number): [number, number, number] {
  const a = u * 2 - 1;
  const b = v * 2 - 1;
  const x = (a + b) / 2;
  const z = (b - a) / 2;
  const y = 1 - Math.abs(x) - Math.abs(z);
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** Inverse of {@link hemiOctahedralDirection}: direction → [0, 1]² grid uv. */
export function hemiOctahedralUv(
  x: number,
  y: number,
  z: number,
): [number, number] {
  const norm = Math.abs(x) + Math.max(0, y) + Math.abs(z) || 1;
  const px = x / norm;
  const pz = z / norm;
  return [(px - pz) * 0.5 + 0.5, (px + pz) * 0.5 + 0.5];
}

// ---------------------------------------------------------------------------
// The tile rasterizer: orthographic, alpha-tested, textured from the foliage
// atlas exactly as the card fragment shader composes albedo.
// ---------------------------------------------------------------------------

interface TileBuffers {
  /** rgba8: albedo premultiplied against material colour; a = coverage. */
  readonly albedo: Uint8Array;
  /** rgba8: world-space normal ×0.5+0.5; a = normalized depth (0 near). */
  readonly normalDepth: Uint8Array;
  readonly depth: Float32Array;
}

function sampleFoliageLayer(
  foliage: MippedTextureArrayPlan,
  layer: number,
  u: number,
  v: number,
): [number, number, number, number] {
  const mip0 = foliage.layerChains[layer]?.[0];
  if (!mip0) return [1, 1, 1, 1];
  const edge = FOLIAGE_ATLAS_EDGE;
  const x = Math.min(edge - 1, Math.max(0, Math.floor(((u % 1) + 1) % 1 * edge)));
  const y = Math.min(edge - 1, Math.max(0, Math.floor(((v % 1) + 1) % 1 * edge)));
  const at = (y * edge + x) * 4;
  return [
    mip0[at]! / 255,
    mip0[at + 1]! / 255,
    mip0[at + 2]! / 255,
    mip0[at + 3]! / 255,
  ];
}

function rasterizeGeometry(
  geometry: PrototypeGeometry,
  materialAlbedo: readonly [number, number, number],
  foliage: MippedTextureArrayPlan,
  viewDirection: readonly [number, number, number],
  leafFraction: number,
  tile: TileBuffers,
  tileOriginX: number,
  tileOriginY: number,
  layerEdge: number,
  extent: number,
  centerY: number,
): void {
  const [dx, dy, dz] = viewDirection;
  // View basis: right ⟂ dir in the horizontal-ish plane, up completes it.
  let rightX = -dz;
  let rightY = 0;
  let rightZ = dx;
  const rightLength = Math.hypot(rightX, rightY, rightZ);
  if (rightLength < 1e-5) {
    rightX = 1; rightY = 0; rightZ = 0;
  } else {
    rightX /= rightLength; rightZ /= rightLength;
  }
  const upX = rightY * dz - rightZ * dy;
  const upY = rightZ * dx - rightX * dz;
  const upZ = rightX * dy - rightY * dx;

  const positions = geometry.positions;
  const uvs = geometry.uvs;
  const colors = geometry.colors;
  const layers = geometry.atlasLayer;
  const indices = geometry.indices;
  const edge = IMPOSTOR_TILE_EDGE;

  const project = (index: number): [number, number, number] => {
    const px = positions[index * 3]!;
    const py = positions[index * 3 + 1]! - centerY;
    const pz = positions[index * 3 + 2]!;
    const planeX = px * rightX + pz * rightZ;
    const planeY = px * upX + py * upY + pz * upZ;
    const depth = px * dx + py * dy + pz * dz;
    return [
      (planeX / extent) * 0.5 + 0.5,
      (planeY / extent) * 0.5 + 0.5,
      (depth / extent) * 0.5 + 0.5,
    ];
  };

  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const ia = indices[triangle]!;
    const ib = indices[triangle + 1]!;
    const ic = indices[triangle + 2]!;
    const a = project(ia);
    const b = project(ib);
    const c = project(ic);
    // Face normal in world space.
    const abx = positions[ib * 3]! - positions[ia * 3]!;
    const aby = positions[ib * 3 + 1]! - positions[ia * 3 + 1]!;
    const abz = positions[ib * 3 + 2]! - positions[ia * 3 + 2]!;
    const acx = positions[ic * 3]! - positions[ia * 3]!;
    const acy = positions[ic * 3 + 1]! - positions[ia * 3 + 1]!;
    const acz = positions[ic * 3 + 2]! - positions[ia * 3 + 2]!;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const nLength = Math.hypot(nx, ny, nz) || 1;
    nx /= nLength; ny /= nLength; nz /= nLength;
    // Double-sided: flip toward the camera. `d` points TOWARD the bake camera
    // (the depth test at the tile keeps the LARGEST p·d), so a camera-facing
    // normal has POSITIVE dot with it — flip only the negatives. The original
    // `> 0` comparison flipped exactly the normals that were already correct:
    // 0.0% of covered texels faced the camera, the far band's direct-sun term
    // collapsed to ~0 and its sky irradiance to ~0.46 of the hull's, and every
    // distant tree read as a dark shell with a view-locked environment sheen —
    // the reported "dark/reflective" far forest.
    if (nx * dx + ny * dy + nz * dz < 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }

    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * edge));
    const maxX = Math.min(edge - 1, Math.ceil(Math.max(a[0], b[0], c[0]) * edge));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * edge));
    const maxY = Math.min(edge - 1, Math.ceil(Math.max(a[1], b[1], c[1]) * edge));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-12) continue;

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const sx = (px + 0.5) / edge;
        const sy = (py + 0.5) / edge;
        const w0 = ((b[0] - sx) * (c[1] - sy) - (c[0] - sx) * (b[1] - sy)) / area;
        const w1 = ((c[0] - sx) * (a[1] - sy) - (a[0] - sx) * (c[1] - sy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const depth = a[2] * w0 + b[2] * w1 + c[2] * w2;
        const tileIndex = (edge - 1 - py) * edge + px;
        if (depth <= tile.depth[tileIndex]!) continue;
        const layer = layers[ia]!;
        let r = 1; let g = 1; let bch = 1; let alpha = 1;
        if (layer >= 0) {
          const u = uvs[ia * 2]! * w0 + uvs[ib * 2]! * w1 + uvs[ic * 2]! * w2;
          const v = uvs[ia * 2 + 1]! * w0 + uvs[ib * 2 + 1]! * w1 + uvs[ic * 2 + 1]! * w2;
          [r, g, bch, alpha] = sampleFoliageLayer(foliage, Math.round(layer), u, v);
          if (!leafDissolveSurvives(u, v, leafFraction)) continue;
        }
        if (alpha < IMPOSTOR_ALPHA_TEST_THRESHOLD) continue;
        const occlusion = colors[ia * 4 + 3]! * w0 + colors[ib * 4 + 3]! * w1
          + colors[ic * 4 + 3]! * w2;
        const shade = OCCLUSION_FLOOR + (1 - OCCLUSION_FLOOR) * Math.min(1, Math.max(0, occlusion));
        tile.depth[tileIndex] = depth;
        const outX = tileOriginX + px;
        const outY = tileOriginY + (edge - 1 - py);
        const out = (outY * layerEdge + outX) * 4;
        tile.albedo[out] = Math.round(Math.min(1, r * materialAlbedo[0] * shade) * 255);
        tile.albedo[out + 1] = Math.round(Math.min(1, g * materialAlbedo[1] * shade) * 255);
        tile.albedo[out + 2] = Math.round(Math.min(1, bch * materialAlbedo[2] * shade) * 255);
        tile.albedo[out + 3] = 255;
        tile.normalDepth[out] = Math.round((nx * 0.5 + 0.5) * 255);
        tile.normalDepth[out + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        tile.normalDepth[out + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        // COVERAGE, not depth: the runtime reads only .xyz (depth was never
        // sampled), and a coverage alpha is what lets alphaDilate spread real
        // normals into the uncovered texels — un-dilated, box mips blended
        // encoded-black (-1,-1,-1) into every level and distant trees darkened
        // progressively with mip distance.
        tile.normalDepth[out + 3] = 255;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The bake.
// ---------------------------------------------------------------------------

/**
 * The bake's framing for one species, in unit-prototype space — the
 * billboard shader must reconstruct the same square, so the runtime reads
 * THIS function rather than repeating the arithmetic.
 */
export function impostorBakeFrame(species: TreeSpecies, seed = 7): {
  readonly extentUnit: number;
  readonly centerYUnit: number;
} {
  const prototype = buildTreePrototype(species, 0, seed, "near");
  const cards = buildCrownFringePrototype(species, 0, seed, "near");
  const height = Math.max(
    prototype.crown.boundingHeight,
    prototype.trunk.boundingHeight,
    cards.boundingHeight,
  );
  const radius = Math.max(
    prototype.crown.boundingRadius,
    prototype.trunk.boundingRadius,
    cards.boundingRadius,
  );
  return {
    extentUnit: Math.max(radius, height / 2) * 1.08,
    centerYUnit: height / 2,
  };
}

function bakeSpeciesLayer(
  species: TreeSpecies,
  bare: boolean,
  foliage: MippedTextureArrayPlan,
  seed: number,
): { albedo: Uint8Array; normalDepth: Uint8Array } {
  const prototype = buildTreePrototype(species, 0, seed, "near");
  const cards = buildCrownFringePrototype(species, 0, seed, "near");
  const layerEdge = IMPOSTOR_LAYER_EDGE;
  const albedo = new Uint8Array(layerEdge * layerEdge * 4);
  const normalDepth = new Uint8Array(layerEdge * layerEdge * 4);
  const frame = impostorBakeFrame(species, seed);
  const extent = frame.extentUnit;
  const centerY = frame.centerYUnit;

  for (let view = 0; view < IMPOSTOR_VIEW_GRID * IMPOSTOR_VIEW_GRID; view += 1) {
    const gridX = view % IMPOSTOR_VIEW_GRID;
    const gridY = Math.floor(view / IMPOSTOR_VIEW_GRID);
    const direction = hemiOctahedralDirection(
      (gridX + 0.5) / IMPOSTOR_VIEW_GRID,
      (gridY + 0.5) / IMPOSTOR_VIEW_GRID,
    );
    const tile: TileBuffers = {
      albedo,
      normalDepth,
      depth: new Float32Array(IMPOSTOR_TILE_EDGE * IMPOSTOR_TILE_EDGE).fill(
        Number.NEGATIVE_INFINITY,
      ),
    };
    const originX = gridX * IMPOSTOR_TILE_EDGE;
    const originY = gridY * IMPOSTOR_TILE_EDGE;
    // Crown at its bucket's leaf fraction (conifers HOLD — their bare
    // bucket is identical and the season cross-fade is a no-op for them);
    // trunks stand in winter.
    rasterizeGeometry(
      prototype.crown, DETAIL_CROWN_ALBEDO, foliage, direction,
      bare && DECIDUOUS_IMPOSTORS.has(species) ? IMPOSTOR_BARE_LEAF_FRACTION : 1,
      tile, originX, originY, layerEdge, extent, centerY,
    );
    // Wave T: the leaf-cluster card shell is the visible canopy surface —
    // without it the impostor bakes only the dark interior core and the far
    // band reads as a different (and much darker) forest.
    rasterizeGeometry(
      cards, DETAIL_CROWN_ALBEDO, foliage, direction,
      bare && DECIDUOUS_IMPOSTORS.has(species) ? IMPOSTOR_BARE_LEAF_FRACTION : 1,
      tile, originX, originY, layerEdge, extent, centerY,
    );
    rasterizeGeometry(
      prototype.trunk, DETAIL_BARK_ALBEDO, foliage, direction,
      1,
      tile, originX, originY, layerEdge, extent, centerY,
    );
  }
  return {
    albedo: alphaDilate(albedo, layerEdge, 6),
    normalDepth: alphaDilate(normalDepth, layerEdge, 6),
  };
}

/** The pure half: every layer of both arrays, mipped and packed. */
export function planImpostorAtlas(seed: WorldSeed): ImpostorAtlasPlans {
  const foliage = planFoliageAtlas(seed);
  const prototypeSeed = 7;
  const albedoLayers: Uint8Array[] = [];
  const normalDepthLayers: Uint8Array[] = [];
  for (const species of IMPOSTOR_SPECIES) {
    for (let bucket = 0; bucket < IMPOSTOR_SEASON_BUCKETS; bucket += 1) {
      const baked = bakeSpeciesLayer(species, bucket === 1, foliage, prototypeSeed);
      albedoLayers.push(baked.albedo);
      normalDepthLayers.push(baked.normalDepth);
    }
  }
  return {
    albedo: planMippedTextureArray(albedoLayers, IMPOSTOR_LAYER_EDGE, {
      kind: "coverage",
      alphaTestThreshold: IMPOSTOR_ALPHA_TEST_THRESHOLD,
    }),
    normalDepth: planMippedTextureArray(normalDepthLayers, IMPOSTOR_LAYER_EDGE, "box"),
    layerCount: IMPOSTOR_SPECIES.length * IMPOSTOR_SEASON_BUCKETS,
  };
}

export interface ImpostorAtlas {
  readonly albedo: RawTexture2DArray;
  readonly normalDepth: RawTexture2DArray;
  readonly layerCount: number;
  readonly memoryMiB: number;
}

/** The single GPU boundary: upload both planned arrays. */
export function createImpostorAtlas(scene: Scene, seed: WorldSeed): ImpostorAtlas {
  const plans = planImpostorAtlas(seed);
  const albedo = uploadMippedTextureArrayPlan(scene, plans.albedo, {
    name: "detail-impostor-albedo",
  });
  const normalDepth = uploadMippedTextureArrayPlan(scene, plans.normalDepth, {
    name: "detail-impostor-normal-depth",
  });
  const bytes = [plans.albedo, plans.normalDepth].reduce(
    (sum, plan) => sum + plan.packedLevels.reduce((s, level) => s + level.byteLength, 0),
    0,
  );
  return {
    albedo,
    normalDepth,
    layerCount: plans.layerCount,
    memoryMiB: bytes / (1024 * 1024),
  };
}
