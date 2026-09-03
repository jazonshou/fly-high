import { clamp, lerp } from "@/src/world/noise";
import { hashLatticeCoordinates, mixSeed, unitFloatFromHash } from "@/src/world/seed";
import { FOLIAGE_LAYERS } from "./FoliageAtlas";
import {
  detailPrototypeBoundsFromPositions,
  type DetailPrototypeBounds,
} from "./instanceFormat";
import {
  buildTreeSkeleton,
  type SkeletonMeshBudget,
  type TreeSkeleton,
} from "./treeSkeleton";
import type { ClutterKind, RockVariant, ShrubSpecies, TreeSpecies } from "./types";

/**
 * Vegetation prototype geometry builders (2-12, 2-12b, 2-15, 2-16).
 *
 * INVARIANT THIS FILE OWNS: every vegetation, rock, and clutter prototype is
 * pure geometry — plain typed arrays, deterministic per (species, variant,
 * seed), built with no Babylon import so the builders run in Node and in the
 * worker byte-identically. The runtime turns these into meshes; nothing else
 * generates prototype vertices, and per-instance appearance (tint hue, lean,
 * character modifiers) is NOT baked here — vertex colors carry rgb = 1 and
 * A = baked sky occlusion only.
 *
 * Class P: no Math.random, no Date.now.
 */

/**
 * Foliage/bark atlas layer indices. `FoliageAtlas.ts` (2-11) owns the layer
 * list; this alias exists so geometry call sites read as indices rather
 * than layers, and so a rename there is a type error here, not drift.
 */
export const FOLIAGE_LAYER_INDEX = FOLIAGE_LAYERS;

/** Untextured surfaces (rocks, moss) carry this sentinel in `atlasLayer`. */
export const ATLAS_LAYER_UNTEXTURED = -1;

/**
 * Shared prototype output: parallel vertex streams the runtime uploads
 * verbatim. `colors` rgb is a tint multiplier (always 1 here — the runtime
 * applies per-instance tint) and A is baked sky occlusion in [0, 1]
 * (1 = open sky). `atlasLayer` is one float per vertex: a foliage-atlas layer
 * index, or -1 for untextured geometry.
 */
export interface PrototypeGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly tangents: Float32Array;
  readonly colors: Float32Array;
  readonly atlasLayer: Float32Array;
  readonly indices: Uint16Array;
  readonly triangleCount: number;
  /** Furthest vertex from the +y axis. */
  readonly boundingRadius: number;
  /** Highest vertex y (prototype heights are normalized to ~1). */
  readonly boundingHeight: number;
  /** Exact authored xyz envelope used by generator-side instance culling. */
  readonly localBounds: DetailPrototypeBounds;
}

export interface TreePrototype {
  readonly trunk: PrototypeGeometry;
  readonly crown: PrototypeGeometry;
  /**
   * Wave T: the SHARED radial contract for every part of this tree — the
   * skeleton's horizontal envelope including card extents. All tree batches
   * (bark, core, cards) register THIS as their `radialUnits`, so one world
   * scale maps every part and the parts stay exactly aligned.
   */
  readonly envelopeRadius: number;
}

/** 5 variants for the three commonest species, 3 for the rest (2-12). */
export const TREE_VARIANT_COUNTS: Readonly<Record<TreeSpecies, number>> = Object.freeze({
  pine: 5,
  cedar: 3,
  spruce: 3,
  oak: 5,
  maple: 3,
  birch: 5,
  willow: 3,
});

/** Two variants per shrub species (2-12b). */
export const SHRUB_VARIANT_COUNTS: Readonly<Record<ShrubSpecies, number>> = Object.freeze({
  juniper: 2,
  hazel: 2,
  sage: 2,
});

export type { ClutterKind } from "./types";

// ---------------------------------------------------------------------------
// Deterministic streams. hashText/createRandom mirror generation.ts's private
// helpers so both files draw from the same style of named seed stream; the
// streams themselves are independent (different seed strings).
// ---------------------------------------------------------------------------

type RandomSource = () => number;

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function createRandom(seed: string): RandomSource {
  let state = hashText(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function wrapVariant(variant: number, count: number): number {
  if (!Number.isFinite(variant)) throw new RangeError("variant must be finite");
  const truncated = Math.trunc(variant);
  return ((truncated % count) + count) % count;
}

// ---------------------------------------------------------------------------
// Small vector helpers (plain objects; builder-time only).
// ---------------------------------------------------------------------------

interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const TWO_PI = Math.PI * 2;

function norm3(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z);
  if (length < 1e-9) return UP;
  return { x: x / length, y: y / length, z: z / length };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// ---------------------------------------------------------------------------
// Deterministic 3D value noise (rock/log/moss displacement).
// ---------------------------------------------------------------------------

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function latticeValue3(mixedHash: number, ix: number, iy: number, iz: number): number {
  return unitFloatFromHash(hashLatticeCoordinates(mixSeed(mixedHash, iy), ix, iz)) * 2 - 1;
}

function valueNoise3D(mixedHash: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const sx = fade(x - ix);
  const sy = fade(y - iy);
  const sz = fade(z - iz);
  const c000 = latticeValue3(mixedHash, ix, iy, iz);
  const c100 = latticeValue3(mixedHash, ix + 1, iy, iz);
  const c010 = latticeValue3(mixedHash, ix, iy + 1, iz);
  const c110 = latticeValue3(mixedHash, ix + 1, iy + 1, iz);
  const c001 = latticeValue3(mixedHash, ix, iy, iz + 1);
  const c101 = latticeValue3(mixedHash, ix + 1, iy, iz + 1);
  const c011 = latticeValue3(mixedHash, ix, iy + 1, iz + 1);
  const c111 = latticeValue3(mixedHash, ix + 1, iy + 1, iz + 1);
  const x00 = lerp(c000, c100, sx);
  const x10 = lerp(c010, c110, sx);
  const x01 = lerp(c001, c101, sx);
  const x11 = lerp(c011, c111, sx);
  return lerp(lerp(x00, x10, sy), lerp(x01, x11, sy), sz);
}

/** Three-octave fbm in roughly [-1, 1]. */
function fbm3(mixedHash: number, x: number, y: number, z: number): number {
  let total = 0;
  let normalizer = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let octave = 0; octave < 3; octave += 1) {
    total += valueNoise3D(mixSeed(mixedHash, 90 + octave), x * frequency, y * frequency, z * frequency)
      * amplitude;
    normalizer += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return total / normalizer;
}

// ---------------------------------------------------------------------------
// Geometry accumulator.
// ---------------------------------------------------------------------------

interface GeometryAccumulator {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly tangents: number[];
  readonly colors: number[];
  readonly atlasLayer: number[];
  readonly indices: number[];
}

function createAccumulator(): GeometryAccumulator {
  return { positions: [], normals: [], uvs: [], tangents: [], colors: [], atlasLayer: [], indices: [] };
}

function pushVertex(
  acc: GeometryAccumulator,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  u: number, v: number,
  tx: number, ty: number, tz: number, tw: number,
  layer: number,
  alpha: number,
): number {
  const index = acc.positions.length / 3;
  acc.positions.push(px, py, pz);
  acc.normals.push(nx, ny, nz);
  acc.uvs.push(u, v);
  acc.tangents.push(tx, ty, tz, tw);
  acc.colors.push(1, 1, 1, alpha);
  acc.atlasLayer.push(layer);
  return index;
}

function finalizeGeometry(acc: GeometryAccumulator): PrototypeGeometry {
  const vertexCount = acc.positions.length / 3;
  if (vertexCount > 65_535) {
    throw new RangeError(`Prototype exceeds Uint16 indexing (${vertexCount} vertices)`);
  }
  const positions = Float32Array.from(acc.positions);
  let boundingRadius = 0;
  let boundingHeight = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    boundingRadius = Math.max(boundingRadius, Math.hypot(x, z));
    boundingHeight = Math.max(boundingHeight, y);
  }
  return {
    positions,
    normals: Float32Array.from(acc.normals),
    uvs: Float32Array.from(acc.uvs),
    tangents: Float32Array.from(acc.tangents),
    colors: Float32Array.from(acc.colors),
    atlasLayer: Float32Array.from(acc.atlasLayer),
    indices: Uint16Array.from(acc.indices),
    triangleCount: acc.indices.length / 3,
    boundingRadius,
    boundingHeight,
    localBounds: detailPrototypeBoundsFromPositions(positions),
  };
}

/** Concatenate prototype parts into one geometry, offsetting indices. */
export function mergePrototypeGeometry(parts: readonly PrototypeGeometry[]): PrototypeGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  let triangleCount = 0;
  let boundingRadius = 0;
  let boundingHeight = 0;
  for (const part of parts) {
    vertexCount += part.positions.length / 3;
    indexCount += part.indices.length;
    triangleCount += part.triangleCount;
    boundingRadius = Math.max(boundingRadius, part.boundingRadius);
    boundingHeight = Math.max(boundingHeight, part.boundingHeight);
  }
  if (vertexCount > 65_535) {
    throw new RangeError(`Merged prototype exceeds Uint16 indexing (${vertexCount} vertices)`);
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tangents = new Float32Array(vertexCount * 4);
  const colors = new Float32Array(vertexCount * 4);
  const atlasLayer = new Float32Array(vertexCount);
  const indices = new Uint16Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    const partVertices = part.positions.length / 3;
    positions.set(part.positions, vertexOffset * 3);
    normals.set(part.normals, vertexOffset * 3);
    uvs.set(part.uvs, vertexOffset * 2);
    tangents.set(part.tangents, vertexOffset * 4);
    colors.set(part.colors, vertexOffset * 4);
    atlasLayer.set(part.atlasLayer, vertexOffset);
    for (let i = 0; i < part.indices.length; i += 1) {
      indices[indexOffset + i] = part.indices[i]! + vertexOffset;
    }
    vertexOffset += partVertices;
    indexOffset += part.indices.length;
  }
  return {
    positions, normals, uvs, tangents, colors, atlasLayer, indices,
    triangleCount, boundingRadius, boundingHeight,
    localBounds: detailPrototypeBoundsFromPositions(positions),
  };
}

// ---------------------------------------------------------------------------
// Baked sky occlusion (2-12 deliverable 3).
// ---------------------------------------------------------------------------

/**
 * 16 deterministic cosine-weighted hemisphere directions (golden-angle
 * spiral; cos θ = √(1−u) gives the cosine weighting).
 */
const OCCLUSION_DIRECTIONS: readonly Vec3[] = (() => {
  const directions: Vec3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 16; i += 1) {
    const u = (i + 0.5) / 16;
    const cosTheta = Math.sqrt(1 - u);
    const sinTheta = Math.sqrt(u);
    const phi = i * goldenAngle;
    directions.push({ x: Math.cos(phi) * sinTheta, y: cosTheta, z: Math.sin(phi) * sinTheta });
  }
  return directions;
})();

/** Foliage quads act as opaque disks of their half-diagonal radius. */
interface OccluderDisk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly radiusSq: number;
}

/**
 * Writes A = fraction of the 16 hemisphere rays that escape the disk set.
 * `ownerByVertex` maps each vertex to the disk it belongs to (skipped so a
 * quad never occludes itself); omit for geometry outside the quad set.
 */
function bakeSkyOcclusion(
  acc: GeometryAccumulator,
  disks: readonly OccluderDisk[],
  ownerByVertex?: readonly number[],
): void {
  const vertexCount = acc.positions.length / 3;
  for (let i = 0; i < vertexCount; i += 1) {
    const px = acc.positions[i * 3]!;
    const py = acc.positions[i * 3 + 1]!;
    const pz = acc.positions[i * 3 + 2]!;
    const owner = ownerByVertex ? ownerByVertex[i] ?? -1 : -1;
    let unblocked = 0;
    for (const direction of OCCLUSION_DIRECTIONS) {
      let blocked = false;
      for (let d = 0; d < disks.length; d += 1) {
        if (d === owner) continue;
        const disk = disks[d]!;
        const denom = direction.x * disk.nx + direction.y * disk.ny + direction.z * disk.nz;
        if (Math.abs(denom) < 1e-6) continue;
        const t = ((disk.cx - px) * disk.nx + (disk.cy - py) * disk.ny + (disk.cz - pz) * disk.nz)
          / denom;
        if (t < 0.02) continue;
        const hx = px + direction.x * t - disk.cx;
        const hy = py + direction.y * t - disk.cy;
        const hz = pz + direction.z * t - disk.cz;
        if (hx * hx + hy * hy + hz * hz <= disk.radiusSq) {
          blocked = true;
          break;
        }
      }
      if (!blocked) unblocked += 1;
    }
    acc.colors[i * 4 + 3] = unblocked / OCCLUSION_DIRECTIONS.length;
  }
}

// ---------------------------------------------------------------------------
// Quad emission.
// ---------------------------------------------------------------------------

interface FoliageQuad {
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly tangent: Vec3;
  readonly bitangent: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly layer: number;
}

function quadDisk(quad: FoliageQuad): OccluderDisk {
  // Area-equivalent disk (πr² = 4·hw·hh): tighter than the half-diagonal
  // bound, so elongated cards do not over-occlude the crown tips.
  return {
    cx: quad.center.x, cy: quad.center.y, cz: quad.center.z,
    nx: quad.normal.x, ny: quad.normal.y, nz: quad.normal.z,
    radiusSq: (4 * quad.halfWidth * quad.halfHeight) / Math.PI,
  };
}

/** Full-tile uv quad; owners records the quad id for each emitted vertex. */
function emitFoliageQuad(
  acc: GeometryAccumulator,
  quad: FoliageQuad,
  owners: number[],
  ownerId: number,
): void {
  const { center: c, normal: n, tangent: t, bitangent: b, halfWidth: hw, halfHeight: hh } = quad;
  const corners: ReadonlyArray<readonly [number, number, number, number]> = [
    [-hw, -hh, 0, 0],
    [hw, -hh, 1, 0],
    [hw, hh, 1, 1],
    [-hw, hh, 0, 1],
  ];
  const base = acc.positions.length / 3;
  for (const [du, dv, u, v] of corners) {
    pushVertex(
      acc,
      c.x + t.x * du + b.x * dv, c.y + t.y * du + b.y * dv, c.z + t.z * du + b.z * dv,
      n.x, n.y, n.z,
      u, v,
      t.x, t.y, t.z, 1,
      quad.layer,
      1,
    );
    owners.push(ownerId);
  }
  acc.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// ---------------------------------------------------------------------------
// Swept generalized cylinder (trunks, forks, logs, stumps).
// ---------------------------------------------------------------------------

interface TubeRing {
  readonly center: Vec3;
  /** Unit local axis direction at this ring. */
  readonly axis: Vec3;
  readonly radius: number;
  /** uv v coordinate at this ring. */
  readonly v: number;
}

/**
 * Sweeps a tube along parallel-transported frames. Emits sides+1 vertices per
 * ring (seam duplicated for the u wrap). Normals fold in the taper slope and
 * stay exactly orthogonal to the circumferential tangents. Returns the first
 * vertex index of each ring.
 */
function sweepTube(
  acc: GeometryAccumulator,
  rings: readonly TubeRing[],
  sides: number,
  uWrap: number,
  layer: number,
): number[] {
  const frames: Array<{ u1: Vec3; u2: Vec3 }> = [];
  for (let i = 0; i < rings.length; i += 1) {
    const axis = rings[i]!.axis;
    let u1: Vec3;
    if (i === 0) {
      const ref = Math.abs(axis.y) < 0.9 ? UP : { x: 1, y: 0, z: 0 };
      const c = cross3(ref, axis);
      u1 = norm3(c.x, c.y, c.z);
    } else {
      const previous = frames[i - 1]!.u1;
      const d = dot3(previous, axis);
      u1 = norm3(previous.x - axis.x * d, previous.y - axis.y * d, previous.z - axis.z * d);
    }
    frames.push({ u1, u2: cross3(axis, u1) });
  }
  const ringStarts: number[] = [];
  for (let i = 0; i < rings.length; i += 1) {
    const ring = rings[i]!;
    const { u1, u2 } = frames[i]!;
    const before = rings[Math.max(0, i - 1)]!;
    const after = rings[Math.min(rings.length - 1, i + 1)]!;
    const run = Math.hypot(
      after.center.x - before.center.x,
      after.center.y - before.center.y,
      after.center.z - before.center.z,
    );
    const slope = run > 1e-9 ? (after.radius - before.radius) / run : 0;
    ringStarts.push(acc.positions.length / 3);
    for (let s = 0; s <= sides; s += 1) {
      const theta = (s / sides) * TWO_PI;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const rx = u1.x * cosT + u2.x * sinT;
      const ry = u1.y * cosT + u2.y * sinT;
      const rz = u1.z * cosT + u2.z * sinT;
      const n = norm3(rx - ring.axis.x * slope, ry - ring.axis.y * slope, rz - ring.axis.z * slope);
      const t = norm3(
        -u1.x * sinT + u2.x * cosT,
        -u1.y * sinT + u2.y * cosT,
        -u1.z * sinT + u2.z * cosT,
      );
      pushVertex(
        acc,
        ring.center.x + rx * ring.radius,
        ring.center.y + ry * ring.radius,
        ring.center.z + rz * ring.radius,
        n.x, n.y, n.z,
        (s / sides) * uWrap, ring.v,
        t.x, t.y, t.z, 1,
        layer,
        1,
      );
    }
  }
  for (let i = 0; i < rings.length - 1; i += 1) {
    const a = ringStarts[i]!;
    const b = ringStarts[i + 1]!;
    for (let s = 0; s < sides; s += 1) {
      acc.indices.push(a + s, b + s, b + s + 1, a + s, b + s + 1, a + s + 1);
    }
  }
  return ringStarts;
}

/** Radial displacement along existing normals; normals are kept approximate. */
function displaceAlongNormals(
  acc: GeometryAccumulator,
  noiseSeed: number,
  frequency: number,
  amplitude: number,
): void {
  const vertexCount = acc.positions.length / 3;
  for (let i = 0; i < vertexCount; i += 1) {
    const px = acc.positions[i * 3]!;
    const py = acc.positions[i * 3 + 1]!;
    const pz = acc.positions[i * 3 + 2]!;
    const offset = fbm3(noiseSeed, px * frequency, py * frequency, pz * frequency) * amplitude;
    acc.positions[i * 3] = px + acc.normals[i * 3]! * offset;
    acc.positions[i * 3 + 1] = py + acc.normals[i * 3 + 1]! * offset;
    acc.positions[i * 3 + 2] = pz + acc.normals[i * 3 + 2]! * offset;
  }
}

// ---------------------------------------------------------------------------
// Trees (2-12).
// ---------------------------------------------------------------------------

interface TreeSpeciesSpec {
  readonly conifer: boolean;
  /** Trunk base radius r0 as a fraction of the unit height. */
  readonly trunkRadius: number;
  /** Taper exponent k in r(t) = r0·(1−t)^k. */
  readonly taper: number;
  readonly crownBase: number;
  readonly crownTop: number;
  readonly crownRadius: number;
  readonly crownLayer: number;
  readonly nearCrownLayer: number;
  readonly barkLayer: number;
  readonly fork: boolean;
}

/**
 * Willow shares the birch narrow-leaf tile and cedar the pine needle tile —
 * the 2-11 atlas carries three broadleaf and two needle shapes for seven
 * species.
 */
const TREE_SPECIES_SPECS: Readonly<Record<TreeSpecies, TreeSpeciesSpec>> = Object.freeze({
  pine: {
    conifer: true, trunkRadius: 0.10, taper: 0.70, crownBase: 0.25, crownTop: 1,
    crownRadius: 0.34, crownLayer: FOLIAGE_LAYER_INDEX.needlePine,
    nearCrownLayer: FOLIAGE_LAYER_INDEX.crownConiferDense,
    barkLayer: FOLIAGE_LAYER_INDEX.barkConifer, fork: false,
  },
  cedar: {
    conifer: true, trunkRadius: 0.12, taper: 0.74, crownBase: 0.25, crownTop: 1,
    crownRadius: 0.38, crownLayer: FOLIAGE_LAYER_INDEX.needlePine,
    nearCrownLayer: FOLIAGE_LAYER_INDEX.crownConiferDense,
    barkLayer: FOLIAGE_LAYER_INDEX.barkConifer, fork: false,
  },
  spruce: {
    conifer: true, trunkRadius: 0.11, taper: 0.70, crownBase: 0.25, crownTop: 1,
    crownRadius: 0.30, crownLayer: FOLIAGE_LAYER_INDEX.needleSpruce,
    nearCrownLayer: FOLIAGE_LAYER_INDEX.crownConiferDense,
    barkLayer: FOLIAGE_LAYER_INDEX.barkConifer, fork: false,
  },
  oak: {
    conifer: false, trunkRadius: 0.20, taper: 1.10, crownBase: 0.45, crownTop: 1.05,
    crownRadius: 0.50, crownLayer: FOLIAGE_LAYER_INDEX.broadleafOak,
    nearCrownLayer: FOLIAGE_LAYER_INDEX.crownBroadleafDense,
    barkLayer: FOLIAGE_LAYER_INDEX.barkBroadleaf, fork: true,
  },
  maple: {
    conifer: false, trunkRadius: 0.18, taper: 1.05, crownBase: 0.45, crownTop: 1.05,
    crownRadius: 0.48, crownLayer: FOLIAGE_LAYER_INDEX.broadleafMaple,
    nearCrownLayer: FOLIAGE_LAYER_INDEX.crownBroadleafDense,
    barkLayer: FOLIAGE_LAYER_INDEX.barkBroadleaf, fork: true,
  },
  birch: {
    conifer: false, trunkRadius: 0.10, taper: 0.95, crownBase: 0.45, crownTop: 1.05,
    crownRadius: 0.36, crownLayer: FOLIAGE_LAYER_INDEX.broadleafBirch,
    nearCrownLayer: FOLIAGE_LAYER_INDEX.crownBroadleafDense,
    barkLayer: FOLIAGE_LAYER_INDEX.barkBirch, fork: false,
  },
  willow: {
    conifer: false, trunkRadius: 0.22, taper: 1.10, crownBase: 0.45, crownTop: 1.05,
    crownRadius: 0.55, crownLayer: FOLIAGE_LAYER_INDEX.broadleafBirch,
    // Willow deliberately shares the fine narrow-leaf colour family but
    // receives its own hanging multi-lobe silhouette below.
    nearCrownLayer: FOLIAGE_LAYER_INDEX.crownBroadleafDense,
    barkLayer: FOLIAGE_LAYER_INDEX.barkBroadleaf, fork: true,
  },
});

// ---------------------------------------------------------------------------
// Wave T: skeletal trees. ONE skeleton per (species, variant, seed) feeds
// both mesh detail levels and the leaf-card shell, so near and mid agree on
// silhouette by construction and the card shell sits exactly on the branch
// tips it grew from. All RNG lives in treeSkeleton.ts; everything below is a
// pure function of the skeleton plus a detail budget.
// ---------------------------------------------------------------------------

const TREE_SKELETON_CACHE = new Map<string, TreeSkeleton>();

function treeSkeletonFor(species: TreeSpecies, variant: number, seed: number): TreeSkeleton {
  const key = `${species}/${variant}/${seed}`;
  const cached = TREE_SKELETON_CACHE.get(key);
  if (cached) return cached;
  if (TREE_SKELETON_CACHE.size > 96) TREE_SKELETON_CACHE.clear();
  const skeleton = buildTreeSkeleton(species, variant, seed);
  TREE_SKELETON_CACHE.set(key, skeleton);
  return skeleton;
}

/** Near: the full skeleton. Mid: primaries only, halved rings, 1-in-5 cards. */
export const NEAR_TREE_MESH_BUDGET: SkeletonMeshBudget = Object.freeze({
  trunkSides: 8, branchSides: 5, twigSides: 3,
  minimumMeshRadius: 0.0008, ringStride: 1, twigShare: 1,
  cardStride: 1, cardScale: 1,
});
export const MID_TREE_MESH_BUDGET: SkeletonMeshBudget = Object.freeze({
  trunkSides: 5, branchSides: 3, twigSides: 3,
  minimumMeshRadius: 0.004, ringStride: 2, twigShare: 0,
  cardStride: 4, cardScale: 2.2,
});

/**
 * Bark tubes for every skeleton stem the budget admits. A child stem's base
 * ring sits ON its parent's centre line (the skeleton grows children from the
 * parent axis), so the junction is hidden inside the parent tube; the first
 * interior ring carries a 1.28× collar so limbs read as swelling out of the
 * bole rather than poked into it.
 */
function sweepSkeletonBark(
  acc: GeometryAccumulator,
  skeleton: TreeSkeleton,
  budget: SkeletonMeshBudget,
  barkLayer: number,
): void {
  let twigCounter = 0;
  for (const stem of skeleton.stems) {
    if (stem.radii[0]! < budget.minimumMeshRadius) continue;
    if (stem.level >= 2) {
      if (budget.twigShare <= 0) continue;
      twigCounter += 1;
      if ((twigCounter * budget.twigShare) % 1 >= budget.twigShare) continue;
    }
    const sides = stem.level === 0
      ? budget.trunkSides
      : stem.level === 1 ? budget.branchSides : budget.twigSides;
    const last = stem.points.length - 1;
    const rings: TubeRing[] = [];
    let arc = 0;
    for (let index = 0; index <= last; index += 1) {
      if (index > 0) {
        const a = stem.points[index - 1]!;
        const b = stem.points[index]!;
        arc += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      }
      if (index !== 0 && index !== last && (index - 1) % budget.ringStride !== 0) continue;
      const collar = stem.level > 0 && index === 0 ? 1.28 : 1;
      rings.push({
        center: stem.points[index]!,
        axis: stem.axes[index]!,
        radius: stem.radii[index]! * collar,
        v: (stem.vStart + arc) * 3,
      });
    }
    if (rings.length < 2) continue;
    sweepTube(acc, rings, sides, stem.level === 0 ? 2 : 1, barkLayer);
  }
  // Cheap canopy shading for bark: limbs inside the crown envelope darken
  // toward the interior (the plugin maps A through mix(0.42, 1, A)).
  const span = Math.max(skeleton.crownTopY - skeleton.crownBaseY, 1e-3);
  const vertexCount = acc.positions.length / 3;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const px = acc.positions[vertex * 3]!;
    const py = acc.positions[vertex * 3 + 1]!;
    const pz = acc.positions[vertex * 3 + 2]!;
    const inCanopy = clamp((py - skeleton.crownBaseY) / (span * 0.4), 0, 1);
    const interior = 1 - clamp(
      Math.hypot(px - skeleton.crownCenter.x, pz - skeleton.crownCenter.z)
        / Math.max(skeleton.envelopeRadius, 1e-3),
      0,
      1,
    );
    acc.colors[vertex * 4 + 3] = clamp(0.9 - inCanopy * interior * 0.42, 0.45, 0.92);
  }
}

/**
 * Leaf-cluster cards at the skeleton's anchors. Normals are dome-blended
 * toward a sphere whose origin sits at the canopy BOTTOM (a centroid origin
 * gives every card below it a downward normal — the black-underside bug), so
 * a cloud of flat cards shades like one volume. Each card's four vertices
 * carry the blended normal individually.
 */
function emitSkeletonCards(
  acc: GeometryAccumulator,
  skeleton: TreeSkeleton,
  budget: SkeletonMeshBudget,
  layer: number,
  owners: number[],
  disks: OccluderDisk[],
): void {
  const domeOrigin: Vec3 = {
    x: skeleton.crownCenter.x,
    y: skeleton.crownBaseY - (skeleton.crownTopY - skeleton.crownBaseY) * 0.45,
    z: skeleton.crownCenter.z,
  };
  const share = 1 / budget.cardStride;
  let ownerId = 0;
  for (const anchor of skeleton.anchors) {
    if (budget.cardStride > 1 && anchor.pick >= share) continue;
    const normal = norm3(anchor.nx, anchor.ny, anchor.nz);
    let tangent = cross3(UP, normal);
    if (Math.hypot(tangent.x, tangent.y, tangent.z) < 1e-4) tangent = { x: 1, y: 0, z: 0 };
    tangent = norm3(tangent.x, tangent.y, tangent.z);
    const bitangent = cross3(tangent, normal);
    const halfWidth = skeleton.cardHalfWidth * anchor.size * budget.cardScale;
    const elongation = 0.72 + ((anchor.pick * 7.13) % 1) * 0.5;
    const halfHeight = halfWidth * elongation;
    const center: Vec3 = { x: anchor.x, y: anchor.y, z: anchor.z };
    const quad: FoliageQuad = {
      center, normal, tangent, bitangent, halfWidth, halfHeight, layer,
    };
    const base = acc.positions.length / 3;
    emitFoliageQuad(acc, quad, owners, ownerId);
    disks.push(quadDisk(quad));
    // Dome-blend the four vertex normals in place (emitFoliageQuad wrote the
    // flat card normal); tangents stay the card frame.
    for (let corner = 0; corner < 4; corner += 1) {
      const vertex = base + corner;
      const dome = norm3(
        acc.positions[vertex * 3]! - domeOrigin.x,
        acc.positions[vertex * 3 + 1]! - domeOrigin.y,
        acc.positions[vertex * 3 + 2]! - domeOrigin.z,
      );
      const blended = norm3(
        lerp(normal.x, dome.x, 0.65),
        lerp(normal.y, dome.y, 0.65),
        lerp(normal.z, dome.z, 0.65),
      );
      acc.normals[vertex * 3] = blended.x;
      acc.normals[vertex * 3 + 1] = blended.y;
      acc.normals[vertex * 3 + 2] = blended.z;
    }
    ownerId += 1;
  }
}

/**
 * The interior canopy core: the pre-overhaul opaque hull, shrunk inside the
 * card shell and darkened. It pre-fills depth behind the cards (the early-Z
 * keystone the 60fps push established) and reads as the canopy's own
 * shadowed interior wherever the card shell opens.
 */
function buildCanopyCoreFromSkeleton(
  skeleton: TreeSkeleton,
  spec: TreeSpeciesSpec,
  species: TreeSpecies,
  rng: RandomSource,
): PrototypeGeometry {
  const span = skeleton.crownTopY - skeleton.crownBaseY;
  const coreSpec: TreeSpeciesSpec = {
    ...spec,
    crownBase: skeleton.crownBaseY + span * 0.1,
    crownTop: skeleton.crownTopY - span * 0.08,
    crownRadius: Math.max(skeleton.envelopeRadius * 0.62, 0.05),
  };
  const core = buildClosedNearCrown(coreSpec, species, rng, 1, 1);
  // Darken: the core is interior foliage by definition. 0.78 rather than a
  // deeper cut — the first capture showed the canopy reading near-black when
  // the interior showed through sparse card coverage.
  const colors = core.colors;
  for (let vertex = 0; vertex < colors.length / 4; vertex += 1) {
    colors[vertex * 4 + 3] = colors[vertex * 4 + 3]! * 0.78;
  }
  return core;
}

/** Area-weighted smooth normals for a final, already-deformed indexed hull. */
function smoothIndexedNormals(
  positions: readonly Vec3[],
  faces: readonly number[],
): readonly Vec3[] {
  const sums = new Float64Array(positions.length * 3);
  for (let face = 0; face < faces.length; face += 3) {
    const ia = faces[face]!;
    const ib = faces[face + 1]!;
    const ic = faces[face + 2]!;
    const a = positions[ia]!;
    const b = positions[ib]!;
    const c = positions[ic]!;
    const weighted = cross3(
      { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
      { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z },
    );
    for (const index of [ia, ib, ic]) {
      sums[index * 3] = sums[index * 3]! + weighted.x;
      sums[index * 3 + 1] = sums[index * 3 + 1]! + weighted.y;
      sums[index * 3 + 2] = sums[index * 3 + 2]! + weighted.z;
    }
  }
  return positions.map((_, index) => norm3(
    sums[index * 3]!,
    sums[index * 3 + 1]!,
    sums[index * 3 + 2]!,
  ));
}

/**
 * One connected 80-triangle broadleaf hull. Four independent 20-triangle
 * balls had the same cost but exposed four coarse polygon silhouettes — the
 * repeated "broccoli" shape visible from both the ground and the air. A
 * subdivision-one icosphere spends those triangles on one coherent outline;
 * restrained low-frequency deformation supplies lobing without splitting the
 * crown into intersecting shells.
 */
function emitBroadleafCrownHull(
  acc: GeometryAccumulator,
  spec: TreeSpeciesSpec,
  species: TreeSpecies,
  radialScale: number,
  heightScale: number,
  layer: number,
  rng: RandomSource,
): void {
  const { vertices, faces } = buildIcosphere(1);
  const base = acc.positions.length / 3;
  const rotation = rng() * TWO_PI;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const lobePhase = rng() * TWO_PI;
  const detailPhase = rng() * TWO_PI;
  const willow = species === "willow";
  const span = (spec.crownTop - spec.crownBase) * heightScale;
  const centre: Vec3 = {
    x: (rng() - 0.5) * spec.crownRadius * radialScale * 0.08,
    y: spec.crownBase + span * (willow ? 0.49 : 0.54),
    z: (rng() - 0.5) * spec.crownRadius * radialScale * 0.08,
  };
  const radiusX = spec.crownRadius * radialScale * (0.91 + rng() * 0.1);
  const radiusY = span * (willow ? 0.51 : 0.49) * (0.95 + rng() * 0.08);
  const radiusZ = spec.crownRadius * radialScale * (0.91 + rng() * 0.1);
  // Fix-pack F2: per-vertex radial jitter on top of the lobe waves. The
  // 42-vertex hull is unique-vertex indexed, so independent per-vertex noise
  // stays watertight; without it the deformation was band-limited to the two
  // harmonics and every crown read as the same smooth pebble.
  const vertexJitter = vertices.map(() => 0.96 + rng() * 0.08);
  const deformed: Vec3[] = vertices.map((source, vertexIndex) => {
    const direction = {
      x: source.x * cosine - source.z * sine,
      y: source.y,
      z: source.x * sine + source.z * cosine,
    };
    const azimuth = Math.atan2(direction.z, direction.x);
    const equatorWeight = Math.max(0, 1 - direction.y * direction.y);
    const lobeCount = willow ? 5 : 4;
    const lobeWave = Math.sin(azimuth * lobeCount + lobePhase) * (willow ? 0.11 : 0.09)
      + Math.sin(azimuth * (lobeCount + 2) + detailPhase) * 0.05;
    const radialDeformation =
      (1 + equatorWeight * lobeWave) * vertexJitter[vertexIndex]!;
    const droop = willow
      ? -span * equatorWeight
        * (0.055 + 0.025 * Math.sin(azimuth * 3 + lobePhase))
      : 0;
    return {
      x: centre.x + direction.x * radiusX * radialDeformation,
      y: centre.y + direction.y * radiusY + droop,
      z: centre.z + direction.z * radiusZ * radialDeformation,
    };
  });
  const normals = smoothIndexedNormals(deformed, faces);
  for (let index = 0; index < vertices.length; index += 1) {
    const source = vertices[index]!;
    const direction = {
      x: source.x * cosine - source.z * sine,
      y: source.y,
      z: source.x * sine + source.z * cosine,
    };
    const position = deformed[index]!;
    const normal = normals[index]!;
    const [u, v] = sphericalUv(direction);
    const tangent = sphericalTangent(direction, normal);
    const occlusion = clamp(0.65 + direction.y * 0.25, 0.46, 0.9);
    pushVertex(
      acc,
      position.x, position.y, position.z,
      normal.x, normal.y, normal.z,
      u, v,
      tangent.x, tangent.y, tangent.z, 1,
      layer,
      occlusion,
    );
  }
  // Winding: emitted REVERSED so the triangle order matches Babylon's
  // convention (its own primitives measure agreement -1.000 between
  // cross(b-a, c-a) and the outward normal). Only the INDEX order moves;
  // the normals above are already outward and must not be re-derived from
  // the reversed order, which would flip them back and leave the surface
  // self-consistently inside-out.
  for (let f = 0; f < faces.length; f += 3) {
    acc.indices.push(base + faces[f]!, base + faces[f + 2]!, base + faces[f + 1]!);
  }
}

/** One closed eight-sided conifer skirt: opaque sides plus a bottom cap. */
function emitConiferWhorl(
  acc: GeometryAccumulator,
  centerX: number,
  centerZ: number,
  baseY: number,
  apexY: number,
  radiusX: number,
  radiusZ: number,
  rotation: number,
  layer: number,
): void {
  const sides = 8;
  // Fix-pack F2: per-corner radius and droop, as integer harmonics of the
  // corner ANGLE so adjacent sides (and the bottom cap, which reuses the same
  // corner objects) agree exactly — an even 8-gon skirt read as machined.
  const skirtRadius = (angle: number): number => 1
    + 0.11 * Math.sin(angle * 3 + rotation * 5.1)
    + 0.07 * Math.sin(angle * 5 + rotation * 9.7);
  const skirtDroop = (angle: number): number => (apexY - baseY)
    * 0.055 * (0.5 + 0.5 * Math.sin(angle * 3 + rotation * 7.3));
  for (let side = 0; side < sides; side += 1) {
    const angleA = rotation + (side / sides) * TWO_PI;
    const angleB = rotation + ((side + 1) / sides) * TWO_PI;
    const a: Vec3 = {
      x: centerX + Math.cos(angleA) * radiusX * skirtRadius(angleA),
      y: baseY - skirtDroop(angleA),
      z: centerZ + Math.sin(angleA) * radiusZ * skirtRadius(angleA),
    };
    const b: Vec3 = {
      x: centerX + Math.cos(angleB) * radiusX * skirtRadius(angleB),
      y: baseY - skirtDroop(angleB),
      z: centerZ + Math.sin(angleB) * radiusZ * skirtRadius(angleB),
    };
    const apex: Vec3 = { x: centerX, y: apexY, z: centerZ };
    const height = Math.max(apexY - baseY, 1e-5);
    const smoothSideNormal = (angle: number): Vec3 => norm3(
      Math.cos(angle) / Math.max(radiusX, 1e-5),
      1 / height,
      Math.sin(angle) / Math.max(radiusZ, 1e-5),
    );
    const tangentAt = (angle: number): Vec3 => norm3(
      -Math.sin(angle) * radiusX,
      0,
      Math.cos(angle) * radiusZ,
    );
    const sideBase = acc.positions.length / 3;
    for (const [point, normal, tangent, u, v] of [
      [a, smoothSideNormal(angleA), tangentAt(angleA), side / sides, 1],
      [apex, UP, tangentAt((angleA + angleB) * 0.5), (side + 0.5) / sides, 0],
      [b, smoothSideNormal(angleB), tangentAt(angleB), (side + 1) / sides, 1],
    ] as const) {
      pushVertex(
        acc,
        point.x, point.y, point.z,
        normal.x, normal.y, normal.z,
        u, v,
        tangent.x, tangent.y, tangent.z, 1,
        layer,
        0.68 + 0.2 * (1 - v),
      );
    }
    acc.indices.push(sideBase, sideBase + 2, sideBase + 1);

    const capBase = acc.positions.length / 3;
    const capTangent = { x: 1, y: 0, z: 0 };
    for (const [point, u, v] of [
      [{ x: centerX, y: baseY, z: centerZ }, 0.5, 0.5],
      [a, Math.cos(angleA) * 0.5 + 0.5, Math.sin(angleA) * 0.5 + 0.5],
      [b, Math.cos(angleB) * 0.5 + 0.5, Math.sin(angleB) * 0.5 + 0.5],
    ] as const) {
      pushVertex(
        acc,
        point.x, point.y, point.z,
        0, -1, 0,
        u, v,
        capTangent.x, capTangent.y, capTangent.z, 1,
        layer,
        0.5,
      );
    }
    acc.indices.push(capBase, capBase + 2, capBase + 1);
  }
}

/**
 * Near trees use closed species-shaped foliage, not intersecting alpha
 * cards. That restores coherent close silhouettes and lets the GPU use an
 * opaque, back-face-culled early-Z pipeline.
 */
function buildClosedNearCrown(
  spec: TreeSpeciesSpec,
  species: TreeSpecies,
  rng: RandomSource,
  radialScale: number,
  heightScale: number,
): PrototypeGeometry {
  const acc = createAccumulator();
  const span = (spec.crownTop - spec.crownBase) * heightScale;
  if (spec.conifer) {
    const radiusFactors = [1, 0.82, 0.62, 0.4] as const;
    const baseFactors = [0, 0.22, 0.44, 0.64] as const;
    const heightFactors = [0.43, 0.4, 0.37, 0.34] as const;
    for (let whorl = 0; whorl < radiusFactors.length; whorl += 1) {
      const baseY = spec.crownBase + span * baseFactors[whorl]!;
      const radius = spec.crownRadius * radialScale * radiusFactors[whorl]!
        * (0.94 + rng() * 0.12);
      emitConiferWhorl(
        acc,
        (rng() - 0.5) * radius * 0.1,
        (rng() - 0.5) * radius * 0.1,
        baseY,
        Math.min(spec.crownBase + span, baseY + span * heightFactors[whorl]!),
        radius,
        radius * (0.9 + rng() * 0.2),
        rng() * TWO_PI,
        spec.nearCrownLayer,
      );
    }
    return finalizeGeometry(acc);
  }

  emitBroadleafCrownHull(
    acc,
    spec,
    species,
    radialScale,
    heightScale,
    spec.nearCrownLayer,
    rng,
  );
  return finalizeGeometry(acc);
}

/**
 * R-21's per-plant triangle allowances, made geometry (2-12): the density
 * law prices both near and mid plants at 180 triangles and
 * a far-band plant at 8 — and the first 2-12 capture proved the price list
 * is not advisory (every band drawing near geometry integrated to 4.7× the
 * budget and the frame went from 13 ms to 29 ms of GPU). Each band gets its
 * own prototype; near/mid share the exact same opaque crown geometry so their
 * hard range handoff cannot shrink, overlap or reshape the silhouette. Far
 * uses an octahedral impostor.
 */
export type TreePrototypeBand = "near" | "mid" | "far";

/**
 * Wave T: a real skeletal tree. The bark part carries the trunk and every
 * meshable branch as swept tubes (opaque, back-face-culled — early-Z
 * friendly); the crown part is the shrunken interior core; the visible
 * canopy surface is the leaf-cluster card shell from
 * `buildCrownFringePrototype`, grown from the SAME skeleton.
 *
 * `band` selects the density law's cost tier: near meshes the full skeleton,
 * mid meshes trunk + primaries with halved ring counts (same skeleton, so the
 * silhouettes agree across the switch). Far is three crossed vertical cards
 * (the NullEngine fallback; the live far band is the octahedral impostor).
 */
export function buildTreePrototype(
  species: TreeSpecies,
  variant: number,
  seed: number,
  band: TreePrototypeBand = "near",
): TreePrototype {
  const spec = TREE_SPECIES_SPECS[species];
  const variantCount = TREE_VARIANT_COUNTS[species];
  const variantIndex = wrapVariant(variant, variantCount);
  const knobRng = createRandom(`tree/${species}/variant/${variantIndex}/${seed}`);
  const placementRng = createRandom(`tree/${species}/placement/${seed}`);
  const aspect = lerp(0.82, 1.18, variantCount > 1 ? variantIndex / (variantCount - 1) : 0.5)
    * (1 + (knobRng() - 0.5) * 0.01);
  const radialScale = aspect;

  if (band === "far") {
    // Three crossed vertical cards spanning the whole silhouette, crown
    // layer only. The variant aspect knob still shapes the card, so far
    // stands keep silhouette variety. Occlusion stays 1 — at this range the
    // interior/tip contrast is beneath the tonal resolution of a few pixels.
    const farAcc = createAccumulator();
    const farOwners: number[] = [];
    const cardTop = spec.crownTop * (1 / Math.sqrt(aspect));
    const halfHeight = (cardTop - 0.02) / 2;
    const centerVertical = 0.02 + halfHeight;
    const halfWidth = spec.crownRadius * radialScale * 1.05;
    for (let card = 0; card < 3; card += 1) {
      const angle = (card / 3) * Math.PI + (knobRng() - 0.5) * 0.2;
      const normal = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
      const tangent = { x: -Math.sin(angle), y: 0, z: Math.cos(angle) };
      emitFoliageQuad(
        farAcc,
        {
          center: { x: 0, y: centerVertical, z: 0 },
          normal,
          tangent,
          bitangent: UP,
          halfWidth,
          halfHeight,
          layer: spec.crownLayer,
        },
        farOwners,
        card,
      );
    }
    const farCrown = finalizeGeometry(farAcc);
    return {
      trunk: finalizeGeometry(createAccumulator()),
      crown: farCrown,
      envelopeRadius: Math.max(farCrown.boundingRadius, 0.05),
    };
  }

  const skeleton = treeSkeletonFor(species, variantIndex, seed);
  const budget = band === "near" ? NEAR_TREE_MESH_BUDGET : MID_TREE_MESH_BUDGET;
  const barkAcc = createAccumulator();
  sweepSkeletonBark(barkAcc, skeleton, budget, spec.barkLayer);
  return {
    trunk: finalizeGeometry(barkAcc),
    crown: buildCanopyCoreFromSkeleton(skeleton, spec, species, placementRng),
    envelopeRadius: Math.max(skeleton.envelopeRadius, 0.05),
  };
}

// ---------------------------------------------------------------------------
// Shrubs (2-12b).
// ---------------------------------------------------------------------------

interface ShrubSpeciesSpec {
  readonly layer: number;
  readonly height: number;
  readonly stemsMin: number;
  readonly stemsMax: number;
  readonly tiltMin: number;
  readonly tiltMax: number;
  readonly quadSize: number;
}

const SHRUB_SPECIES_SPECS: Readonly<Record<ShrubSpecies, ShrubSpeciesSpec>> = Object.freeze({
  juniper: {
    layer: FOLIAGE_LAYER_INDEX.juniperScale, height: 0.85,
    stemsMin: 4, stemsMax: 5, tiltMin: 0.5, tiltMax: 0.95, quadSize: 0.30,
  },
  hazel: {
    layer: FOLIAGE_LAYER_INDEX.hazelLeaf, height: 1.0,
    stemsMin: 3, stemsMax: 4, tiltMin: 0.5, tiltMax: 0.95, quadSize: 0.34,
  },
  sage: {
    layer: FOLIAGE_LAYER_INDEX.sageLeaf, height: 0.55,
    stemsMin: 3, stemsMax: 5, tiltMin: 0.45, tiltMax: 0.9, quadSize: 0.26,
  },
});

/**
 * Wave T: the leaf-cluster card shell — now the tree's VISIBLE canopy. Cards
 * grow from the shared skeleton's terminal-stem anchors (same skeleton as the
 * bark and core, so the shell sits exactly on the branch tips), with
 * dome-blended normals, per-card sky occlusion baked against the whole card
 * set, and the interior-core tone ramp multiplied in so cards and core read
 * as one canopy. `band` selects card density: near keeps every anchor, mid
 * keeps ~1 in 5 at 1.9x size (deliberately under the sqrt(5) coverage
 * compensation — full compensation reads as balloon leaves at range).
 */
export function buildCrownFringePrototype(
  species: TreeSpecies,
  variant: number,
  seed: number,
  band: "near" | "mid" = "near",
): PrototypeGeometry {
  const spec = TREE_SPECIES_SPECS[species];
  const variantIndex = wrapVariant(variant, TREE_VARIANT_COUNTS[species]);
  const skeleton = treeSkeletonFor(species, variantIndex, seed);
  const budget = band === "near" ? NEAR_TREE_MESH_BUDGET : MID_TREE_MESH_BUDGET;
  const acc = createAccumulator();
  const owners: number[] = [];
  const disks: OccluderDisk[] = [];
  emitSkeletonCards(acc, skeleton, budget, spec.crownLayer, owners, disks);
  bakeSkyOcclusion(acc, disks, owners);
  // A SOFTENED version of the core's vertical ramp so shell and core still
  // shade as one canopy without compounding into near-black: the cards
  // already carry real baked occlusion, and the first capture measured the
  // full ramp × bake product reading as a black canopy. Range [0.78, 1.0].
  const span = Math.max(skeleton.crownTopY - skeleton.crownBaseY, 1e-3);
  const crownMid = skeleton.crownBaseY + span * 0.5;
  const crownHalf = Math.max(span * 0.5, 1e-4);
  const vertexCount = acc.positions.length / 3;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const directionY = clamp(
      (acc.positions[vertex * 3 + 1]! - crownMid) / crownHalf,
      -1,
      1,
    );
    const hullRamp = clamp(0.89 + directionY * 0.11, 0.78, 1);
    acc.colors[vertex * 4 + 3] = acc.colors[vertex * 4 + 3]! * hullRamp;
  }
  return finalizeGeometry(acc);
}

/**
 * 12–18 foliage quads on a short multi-stem skeleton (3–5 stems), with the
 * same baked sky occlusion as tree crowns.
 */
export function buildShrubPrototype(
  species: ShrubSpecies,
  variant: number,
  seed: number,
): PrototypeGeometry {
  const spec = SHRUB_SPECIES_SPECS[species];
  const variantIndex = wrapVariant(variant, SHRUB_VARIANT_COUNTS[species]);
  const rng = createRandom(`shrub/${species}/${variantIndex}/${seed}`);

  const stemCount = spec.stemsMin + Math.floor(rng() * (spec.stemsMax - spec.stemsMin + 1));
  const quadTotal = 12 + Math.floor(rng() * 7);
  const acc = createAccumulator();
  const quads: FoliageQuad[] = [];
  const owners: number[] = [];

  for (let q = 0; q < quadTotal; q += 1) {
    const stem = q % stemCount;
    const azimuth = (stem / stemCount) * TWO_PI + (rng() - 0.5) * 0.8;
    const tilt = spec.tiltMin + rng() * (spec.tiltMax - spec.tiltMin);
    const direction = norm3(
      Math.sin(tilt) * Math.cos(azimuth),
      Math.cos(tilt),
      Math.sin(tilt) * Math.sin(azimuth),
    );
    const baseX = (rng() - 0.5) * 0.12;
    const baseZ = (rng() - 0.5) * 0.12;
    const length = spec.height * (0.75 + rng() * 0.25);
    const along = (0.3 + rng() * 0.65) * length;
    const center: Vec3 = {
      x: baseX + direction.x * along,
      y: direction.y * along,
      z: baseZ + direction.z * along,
    };
    const outward = norm3(center.x, center.y - spec.height * 0.35, center.z);
    const normal = norm3(
      outward.x * 0.4 + (rng() - 0.5) * 0.24,
      outward.y * 0.4 + 0.6 + (rng() - 0.5) * 0.24,
      outward.z * 0.4 + (rng() - 0.5) * 0.24,
    );
    let tangent = cross3(UP, normal);
    const tangentLength = Math.hypot(tangent.x, tangent.y, tangent.z);
    tangent = tangentLength > 1e-4
      ? norm3(tangent.x, tangent.y, tangent.z)
      : { x: 1, y: 0, z: 0 };
    const bitangent = cross3(tangent, normal);
    const size = spec.quadSize * (0.8 + rng() * 0.5);
    quads.push({
      center, normal, tangent, bitangent,
      halfWidth: size * 0.5, halfHeight: size * 0.5,
      layer: spec.layer,
    });
  }
  for (let i = 0; i < quads.length; i += 1) {
    emitFoliageQuad(acc, quads[i]!, owners, i);
  }
  bakeSkyOcclusion(acc, quads.map(quadDisk), owners);
  let shrubTopY = 0;
  for (let i = 1; i < acc.positions.length; i += 3) {
    shrubTopY = Math.max(shrubTopY, acc.positions[i]!);
  }
  if (shrubTopY > 1e-4) {
    const k = 1 / shrubTopY;
    for (let i = 0; i < acc.positions.length; i += 1) acc.positions[i]! *= k;
  }
  return finalizeGeometry(acc);
}

// ---------------------------------------------------------------------------
// Rocks (2-15): displaced icospheres; the shading model reads as lithology.
// ---------------------------------------------------------------------------

function buildIcosphere(subdivisions: number): { vertices: Vec3[]; faces: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: ReadonlyArray<readonly [number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const vertices: Vec3[] = raw.map(([x, y, z]) => norm3(x, y, z));
  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  for (let level = 0; level < subdivisions; level += 1) {
    const midpoints = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 65_536 + b : b * 65_536 + a;
      const existing = midpoints.get(key);
      if (existing !== undefined) return existing;
      const va = vertices[a]!;
      const vb = vertices[b]!;
      vertices.push(norm3(va.x + vb.x, va.y + vb.y, va.z + vb.z));
      const index = vertices.length - 1;
      midpoints.set(key, index);
      return index;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f]!;
      const b = faces[f + 1]!;
      const c = faces[f + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  return { vertices, faces };
}

function sphericalUv(direction: Vec3): readonly [number, number] {
  return [
    Math.atan2(direction.z, direction.x) / TWO_PI + 0.5,
    Math.acos(clamp(direction.y, -1, 1)) / Math.PI,
  ];
}

function sphericalTangent(direction: Vec3, normal: Vec3): Vec3 {
  const east = Math.abs(direction.y) > 0.99
    ? { x: 1, y: 0, z: 0 }
    : norm3(-direction.z, 0, direction.x);
  const d = dot3(east, normal);
  return norm3(east.x - normal.x * d, east.y - normal.y * d, east.z - normal.z * d);
}

/**
 * Icosphere (2 subdivisions, 320 triangles) displaced by 3-octave value
 * noise (~0.25R). Granite and dark carry FLAT per-face normals (vertices
 * duplicated per face); limestone carries SMOOTH shared normals — the
 * shading-model difference reads as lithology (2-15). Untextured
 * (atlasLayer −1), occlusion A = 1.
 */
export function buildRockPrototype(variant: RockVariant, seed: number): PrototypeGeometry {
  const noiseSeed = hashText(`rock/${variant}/${seed}`);
  const { vertices, faces } = buildIcosphere(2);
  const displaced: Vec3[] = vertices.map((direction) => {
    const radius = 1 + 0.25 * fbm3(
      noiseSeed,
      direction.x * 1.9 + 11.31,
      direction.y * 1.9 - 7.77,
      direction.z * 1.9 + 3.13,
    );
    return { x: direction.x * radius, y: direction.y * radius, z: direction.z * radius };
  });
  const acc = createAccumulator();

  if (variant === "limestone") {
    const normalSums = new Float64Array(vertices.length * 3);
    for (let f = 0; f < faces.length; f += 3) {
      const ia = faces[f]!;
      const ib = faces[f + 1]!;
      const ic = faces[f + 2]!;
      const a = displaced[ia]!;
      const b = displaced[ib]!;
      const c = displaced[ic]!;
      const faceNormal = cross3(
        { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
        { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z },
      );
      for (const index of [ia, ib, ic]) {
        normalSums[index * 3] = normalSums[index * 3]! + faceNormal.x;
        normalSums[index * 3 + 1] = normalSums[index * 3 + 1]! + faceNormal.y;
        normalSums[index * 3 + 2] = normalSums[index * 3 + 2]! + faceNormal.z;
      }
    }
    for (let i = 0; i < vertices.length; i += 1) {
      const direction = vertices[i]!;
      const position = displaced[i]!;
      const normal = norm3(normalSums[i * 3]!, normalSums[i * 3 + 1]!, normalSums[i * 3 + 2]!);
      const [u, v] = sphericalUv(direction);
      const tangent = sphericalTangent(direction, normal);
      pushVertex(
        acc,
        position.x, position.y, position.z,
        normal.x, normal.y, normal.z,
        u, v,
        tangent.x, tangent.y, tangent.z, 1,
        ATLAS_LAYER_UNTEXTURED,
        1,
      );
    }
    for (let f = 0; f < faces.length; f += 3) {
      acc.indices.push(faces[f]!, faces[f + 2]!, faces[f + 1]!);
    }
  } else {
    for (let f = 0; f < faces.length; f += 3) {
      const corners = [faces[f]!, faces[f + 1]!, faces[f + 2]!];
      const a = displaced[corners[0]!]!;
      const b = displaced[corners[1]!]!;
      const c = displaced[corners[2]!]!;
      const faceNormal = norm3(
        (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y),
        (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z),
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x),
      );
      const base = acc.positions.length / 3;
      for (const cornerIndex of corners) {
        const direction = vertices[cornerIndex]!;
        const position = displaced[cornerIndex]!;
        const [u, v] = sphericalUv(direction);
        const tangent = sphericalTangent(direction, faceNormal);
        pushVertex(
          acc,
          position.x, position.y, position.z,
          faceNormal.x, faceNormal.y, faceNormal.z,
          u, v,
          tangent.x, tangent.y, tangent.z, 1,
          ATLAS_LAYER_UNTEXTURED,
          1,
        );
      }
      acc.indices.push(base, base + 2, base + 1);
    }
  }
  return finalizeGeometry(acc);
}

// ---------------------------------------------------------------------------
// Ground clutter (2-15).
// ---------------------------------------------------------------------------

function buildLog(rng: RandomSource, noiseSeed: number, acc: GeometryAccumulator): void {
  const rings: TubeRing[] = [];
  for (let i = 0; i <= 4; i += 1) {
    const s = i / 4;
    rings.push({
      center: { x: s - 0.5, y: 0.115, z: (rng() - 0.5) * 0.02 },
      axis: { x: 1, y: 0, z: 0 },
      radius: lerp(0.13, 0.085, s) * (0.95 + rng() * 0.1),
      v: s * 3,
    });
  }
  sweepTube(acc, rings, 8, 2, FOLIAGE_LAYER_INDEX.barkConifer);
  displaceAlongNormals(acc, noiseSeed, 6, 0.018);
}

function buildStump(rng: RandomSource, acc: GeometryAccumulator): void {
  const height = 0.32;
  const rings: TubeRing[] = [0, 0.5, 1].map((t) => ({
    center: { x: 0, y: t * height, z: 0 },
    axis: UP,
    radius: 0.17 * (1 + 0.9 * Math.exp(-(t * height) / 0.05)),
    v: t,
  }));
  const ringStarts = sweepTube(acc, rings, 8, 2, FOLIAGE_LAYER_INDEX.barkConifer);
  // Splintered top: jitter the top ring, then fan a jagged cap over it.
  const topStart = ringStarts[ringStarts.length - 1]!;
  const topCount = 9;
  for (let s = 0; s < topCount; s += 1) {
    const jag = (rng() - 0.5) * 0.09;
    // Seam vertex (s === 8) must copy the s === 0 jag to stay welded; the
    // stream still advances so draws stay positionally stable.
    const applied = s === topCount - 1 ? acc.positions[topStart * 3 + 1]! - rings[2]!.center.y : jag;
    acc.positions[(topStart + s) * 3 + 1] = rings[2]!.center.y + applied;
  }
  const capBase = acc.positions.length / 3;
  for (let s = 0; s < topCount; s += 1) {
    const px = acc.positions[(topStart + s) * 3]!;
    const py = acc.positions[(topStart + s) * 3 + 1]!;
    const pz = acc.positions[(topStart + s) * 3 + 2]!;
    pushVertex(
      acc, px, py, pz, 0, 1, 0,
      px * 2 + 0.5, pz * 2 + 0.5,
      1, 0, 0, 1,
      FOLIAGE_LAYER_INDEX.barkConifer, 1,
    );
  }
  const centerIndex = pushVertex(
    acc, 0, height - 0.03, 0, 0, 1, 0, 0.5, 0.5, 1, 0, 0, 1,
    FOLIAGE_LAYER_INDEX.barkConifer, 1,
  );
  for (let s = 0; s < topCount - 1; s += 1) {
    acc.indices.push(centerIndex, capBase + s, capBase + s + 1);
  }
}

function buildBranchLitter(rng: RandomSource, acc: GeometryAccumulator): void {
  const owners: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const azimuth = i * (TWO_PI / 3) + (rng() - 0.5) * 0.5;
    const tilt = 0.1 + rng() * 0.15;
    const tangent = norm3(
      Math.cos(azimuth) * Math.cos(tilt),
      Math.sin(tilt),
      Math.sin(azimuth) * Math.cos(tilt),
    );
    const bitangent = norm3(-Math.sin(azimuth), 0, Math.cos(azimuth));
    const normal = cross3(bitangent, tangent);
    emitFoliageQuad(acc, {
      center: { x: (rng() - 0.5) * 0.15, y: 0.025 + i * 0.012, z: (rng() - 0.5) * 0.15 },
      normal: normal.y < 0 ? norm3(-normal.x, -normal.y, -normal.z) : normal,
      tangent,
      bitangent,
      halfWidth: 0.45,
      halfHeight: 0.1,
      layer: FOLIAGE_LAYER_INDEX.litterTwig,
    }, owners, i);
  }
}

function buildMossCushion(rng: RandomSource, noiseSeed: number, acc: GeometryAccumulator): void {
  const flatten = 0.35;
  const sides = 8;
  const latitudes = [0, Math.PI / 4];
  const ringStarts: number[] = [];
  for (const latitude of latitudes) {
    ringStarts.push(acc.positions.length / 3);
    for (let s = 0; s < sides; s += 1) {
      const theta = (s / sides) * TWO_PI;
      const horizontal = Math.cos(latitude);
      const jitter = 1 + 0.18 * fbm3(noiseSeed, Math.cos(theta) * 2.3, latitude, Math.sin(theta) * 2.3);
      const px = Math.cos(theta) * horizontal * jitter;
      const py = Math.sin(latitude) * flatten;
      const pz = Math.sin(theta) * horizontal * jitter;
      const normal = norm3(px, py / (flatten * flatten), pz);
      const east = norm3(-pz, 0, px);
      const d = dot3(east, normal);
      const tangent = norm3(east.x - normal.x * d, east.y - normal.y * d, east.z - normal.z * d);
      pushVertex(
        acc, px, py, pz, normal.x, normal.y, normal.z,
        px * 0.5 + 0.5, pz * 0.5 + 0.5,
        tangent.x, tangent.y, tangent.z, 1,
        ATLAS_LAYER_UNTEXTURED, 1,
      );
    }
  }
  const apex = pushVertex(
    acc, 0, flatten * (1 + 0.1 * (rng() - 0.5)), 0, 0, 1, 0, 0.5, 0.5, 1, 0, 0, 1,
    ATLAS_LAYER_UNTEXTURED, 1,
  );
  const ring0 = ringStarts[0]!;
  const ring1 = ringStarts[1]!;
  for (let s = 0; s < sides; s += 1) {
    const next = (s + 1) % sides;
    acc.indices.push(ring0 + s, ring1 + next, ring1 + s, ring0 + s, ring0 + next, ring1 + next);
    acc.indices.push(ring1 + s, ring1 + next, apex);
  }
}

/**
 * Ground-clutter archetypes on the rock instancing path (2-15): fallen log
 * (tapered displaced cylinder along +x), stump (flared cylinder, splintered
 * top), branch litter (3 crossed alpha-tested twig cards), moss cushion (low
 * displaced dome, untextured — the runtime tints it green).
 */
export function buildClutterPrototype(kind: ClutterKind, seed: number): PrototypeGeometry {
  const rng = createRandom(`clutter/${kind}/${seed}`);
  const noiseSeed = hashText(`clutter-noise/${kind}/${seed}`);
  const acc = createAccumulator();
  switch (kind) {
    case "log":
      buildLog(rng, noiseSeed, acc);
      break;
    case "stump":
      buildStump(rng, acc);
      break;
    case "branchLitter":
      buildBranchLitter(rng, acc);
      break;
    case "mossCushion":
      buildMossCushion(rng, noiseSeed, acc);
      break;
  }
  return finalizeGeometry(acc);
}

// ---------------------------------------------------------------------------
// Grass patch (2-16).
// ---------------------------------------------------------------------------

/**
 * 12–14 crossed tapered blades — each blade two quads bent outward, 48–56
 * triangles per patch — over a ~1 unit radius footprint (the runtime scales
 * to ~2.5 m²). Occlusion A ramps 0.75 at the base to 1 at the tip.
 */
export type GroundCoverArchetype = "grass" | "fern" | "heather" | "reed";

/** 2-16: per-archetype blade proportions and atlas layer. */
const GROUND_COVER_SPECS: Readonly<Record<GroundCoverArchetype, {
  readonly layer: number;
  readonly blades: number;
  readonly lengthBase: number;
  readonly lengthSpread: number;
  readonly leanBase: number;
  readonly widthMultiplier: number;
}>> = Object.freeze({
  grass: {
    layer: FOLIAGE_LAYER_INDEX.grassBlade,
    blades: 12, lengthBase: 0.5, lengthSpread: 0.3, leanBase: 0.12, widthMultiplier: 1,
  },
  // Fern: fewer, wider, more-arched fronds.
  fern: {
    layer: FOLIAGE_LAYER_INDEX.fernFrond,
    blades: 8, lengthBase: 0.55, lengthSpread: 0.25, leanBase: 0.35, widthMultiplier: 3.2,
  },
  // Heather: a dense low cushion of short sprigs.
  heather: {
    layer: FOLIAGE_LAYER_INDEX.heather,
    blades: 11, lengthBase: 0.3, lengthSpread: 0.15, leanBase: 0.3, widthMultiplier: 2.6,
  },
  // Reed: tall, straight, narrow.
  reed: {
    layer: FOLIAGE_LAYER_INDEX.reed,
    blades: 10, lengthBase: 0.85, lengthSpread: 0.3, leanBase: 0.04, widthMultiplier: 0.9,
  },
});

export function buildGrassPatchPrototype(
  seed: number,
  archetype: GroundCoverArchetype = "grass",
): PrototypeGeometry {
  const spec = GROUND_COVER_SPECS[archetype];
  const rng = createRandom(`grass/${archetype}/${seed}`);
  const acc = createAccumulator();
  // Blades × 4 triangles ≤ the plan's ~48-triangle patch price.
  const bladeCount = Math.min(12, spec.blades + Math.floor(rng() * 3));

  const emitBladeQuad = (
    lowMinus: Vec3, lowPlus: Vec3, highPlus: Vec3, highMinus: Vec3,
    normal: Vec3, tangent: Vec3,
    v0: number, v1: number,
  ): void => {
    const base = acc.positions.length / 3;
    const alpha0 = 0.75 + 0.25 * v0;
    const alpha1 = 0.75 + 0.25 * v1;
    pushVertex(acc, lowMinus.x, lowMinus.y, lowMinus.z, normal.x, normal.y, normal.z,
      0, v0, tangent.x, tangent.y, tangent.z, 1, spec.layer, alpha0);
    pushVertex(acc, lowPlus.x, lowPlus.y, lowPlus.z, normal.x, normal.y, normal.z,
      1, v0, tangent.x, tangent.y, tangent.z, 1, spec.layer, alpha0);
    pushVertex(acc, highPlus.x, highPlus.y, highPlus.z, normal.x, normal.y, normal.z,
      1, v1, tangent.x, tangent.y, tangent.z, 1, spec.layer, alpha1);
    pushVertex(acc, highMinus.x, highMinus.y, highMinus.z, normal.x, normal.y, normal.z,
      0, v1, tangent.x, tangent.y, tangent.z, 1, spec.layer, alpha1);
    acc.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };

  for (let i = 0; i < bladeCount; i += 1) {
    const positionAzimuth = rng() * TWO_PI;
    const baseRadius = Math.sqrt(rng()) * 0.7;
    const baseX = Math.cos(positionAzimuth) * baseRadius;
    const baseZ = Math.sin(positionAzimuth) * baseRadius;
    // Blades lean outward from the patch centre, with per-blade jitter.
    const leanAzimuth = (baseRadius > 0.05 ? Math.atan2(baseZ, baseX) : rng() * TWO_PI)
      + (rng() - 0.5) * 1.2;
    const lean = spec.leanBase + rng() * 0.33;
    const length = spec.lengthBase + rng() * spec.lengthSpread;
    const widthScale = (0.8 + rng() * 0.4) * spec.widthMultiplier;
    const widths = [0.045 * widthScale, 0.028 * widthScale, 0.004 * widthScale] as const;

    const widthAxis: Vec3 = { x: -Math.sin(leanAzimuth), y: 0, z: Math.cos(leanAzimuth) };
    const lower = norm3(
      Math.sin(lean) * Math.cos(leanAzimuth), Math.cos(lean), Math.sin(lean) * Math.sin(leanAzimuth),
    );
    const upperLean = Math.min(lean * 2.1, 1.25);
    const upper = norm3(
      Math.sin(upperLean) * Math.cos(leanAzimuth),
      Math.cos(upperLean),
      Math.sin(upperLean) * Math.sin(leanAzimuth),
    );
    const base: Vec3 = { x: baseX, y: 0, z: baseZ };
    const mid: Vec3 = {
      x: base.x + lower.x * length * 0.55,
      y: base.y + lower.y * length * 0.55,
      z: base.z + lower.z * length * 0.55,
    };
    const tip: Vec3 = {
      x: mid.x + upper.x * length * 0.45,
      y: mid.y + upper.y * length * 0.45,
      z: mid.z + upper.z * length * 0.45,
    };
    const offset = (point: Vec3, width: number, sign: number): Vec3 => ({
      x: point.x + widthAxis.x * width * sign,
      y: point.y + widthAxis.y * width * sign,
      z: point.z + widthAxis.z * width * sign,
    });
    const lowerNormal = cross3(widthAxis, lower);
    const upperNormal = cross3(widthAxis, upper);
    emitBladeQuad(
      offset(base, widths[0], -1), offset(base, widths[0], 1),
      offset(mid, widths[1], 1), offset(mid, widths[1], -1),
      lowerNormal, widthAxis, 0, 0.55,
    );
    emitBladeQuad(
      offset(mid, widths[1], -1), offset(mid, widths[1], 1),
      offset(tip, widths[2], 1), offset(tip, widths[2], -1),
      upperNormal, widthAxis, 0.55, 1,
    );
  }
  return finalizeGeometry(acc);
}
