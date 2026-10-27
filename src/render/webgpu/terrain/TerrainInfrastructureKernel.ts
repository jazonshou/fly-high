import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";
import {
  INFRASTRUCTURE_BIN_METERS,
  INFRASTRUCTURE_SURFACE_FEATHER_METERS,
  infrastructureBinKey,
  infrastructureIndex,
  type InfrastructureIndex,
  type InfrastructureSurface,
} from "@/src/world/infrastructure";
import { INFRASTRUCTURE_PROFILES } from "@/src/world/infrastructureProfiles";
import { landformCoreCenter } from "@/src/world/landforms";
import type { WorldDefinition } from "@/src/world/types";
import { SurfaceMaterial, type SurfaceMaterialId } from "./surfaceMaterials";
import { TERRAIN_LANDFORM_CELL_METERS, terrainLandformCell } from "./TerrainKernel";

/**
 * The GPU twin of the infrastructure stage (`src/world/infrastructure.ts`) —
 * Class K.
 *
 * The CPU packs the world's infrastructure index into one `array<vec4u>`
 * (`terrainInfrastructureData`), and `terrainInfrastructure(localX, localZ,
 * height)` applies it at a point LOCAL to the bound kernel page, right after
 * `terrainLandforms`, in every consumer that draws ground: page generation,
 * the bathymetry bake and the splat bake. The bins list the CPU's segments in
 * the CPU's composition order and every profile is a transliteration, so the
 * two sides differ only by f32 rounding (under a millimetre: see
 * tests/gpu/infrastructure-parity.test.ts).
 *
 * COORDINATES (kernel rule 1), the volcanic overlay's scheme. Everything is
 * relative to the landform core centre (the start airport), split in f64
 * into whole `TERRAIN_LANDFORM_CELL_METERS` cells and the f32 remainder; a
 * point arrives as its page's `landformBase` (the same split) plus its small
 * local offset. Cells subtract as i32, so no f32 sum is ever larger than a
 * segment plus a cell, and a fast-math compiler has nothing to reassociate.
 *
 * WHY u32 LANES. The buffer is `array<vec4u>` and floats are bitcast out of
 * it, never the reverse: an integer load is never canonicalised, while an
 * integer routed through an f32 lane may land on a NaN pattern (a negative
 * cell does) that a storage load is free to rewrite.
 *
 * LAYOUT, in vec4u:
 *
 *   [0] segment count, bins x, bins z, first bin vec4
 *   [1] first list vec4, first segment vec4, sea level (f32), bin size (f32)
 *   [2] bin grid corner: cells (i32 x, z), remainder (f32 x, z)
 *   bins:     two per vec4, (first list entry, count) each
 *   lists:    four segment indices per vec4
 *   segments: five vec4s each: (a cell i32 x, z, a remainder f32 x, z),
 *             (dir x, dir z, length, halfWidth + reach) f32,
 *             (length, halfWidth, reach f32,
 *              profile | mode << 16 | (surface material + 1) << 20),
 *             params 0-3, params 4-7 (f32)
 *
 * CONTAINMENT. With no segments (no sources, an eroded world, the
 * placeholder) the header's count is 0 and `terrainInfrastructure` returns
 * `height` itself; outside every listed segment's reach it does the same.
 */

export const INFRASTRUCTURE_HEADER_VEC4S = 3;
export const INFRASTRUCTURE_SEGMENT_VEC4S = 5;
/** The GPU grid is dense over the index's bins; past this it would be a different design. */
export const INFRASTRUCTURE_MAX_GPU_BINS = 128 * 128;

const MODE_CODE = { set: 0, cut: 1, fill: 2 } as const;

/** The splat material each named surface paints. */
export const INFRASTRUCTURE_SURFACE_MATERIAL: Readonly<Record<InfrastructureSurface, SurfaceMaterialId>> =
  Object.freeze({
    concrete: SurfaceMaterial.Concrete,
    asphalt: SurfaceMaterial.Asphalt,
    gravel: SurfaceMaterial.Gravel,
  });

/** The placeholder: three header vec4s of zeros, so no segment is listed. */
export const TERRAIN_INFRASTRUCTURE_PLACEHOLDER_BYTES = INFRASTRUCTURE_HEADER_VEC4S * 16;

/**
 * Pack an index for the GPU, relative to `origin` (the landform core centre).
 * Allocates; done once per world, not per frame.
 */
export function packTerrainInfrastructure(
  index: InfrastructureIndex,
  seaLevel: number,
  origin: { readonly x: number; readonly z: number },
): Uint32Array {
  const segments = index.segments;
  const empty = segments.length === 0;
  const binsX = empty ? 0 : index.binMaxX - index.binMinX + 1;
  const binsZ = empty ? 0 : index.binMaxZ - index.binMinZ + 1;
  const binCount = binsX * binsZ;
  if (binCount > INFRASTRUCTURE_MAX_GPU_BINS) {
    throw new RangeError(`Infrastructure spans ${binsX} x ${binsZ} bins, more than the GPU grid holds`);
  }
  let entries = 0;
  for (const list of index.bins.values()) entries += list.length;
  const binBase = INFRASTRUCTURE_HEADER_VEC4S;
  const listBase = binBase + Math.ceil(binCount / 2);
  const segmentBase = listBase + Math.ceil(entries / 4);
  const vec4s = segmentBase + segments.length * INFRASTRUCTURE_SEGMENT_VEC4S;
  const words = new Uint32Array(vec4s * 4);
  const floats = new Float32Array(words.buffer);
  const ints = new Int32Array(words.buffer);

  words[0] = segments.length;
  words[1] = binsX;
  words[2] = binsZ;
  words[3] = binBase;
  words[4] = listBase;
  words[5] = segmentBase;
  floats[6] = seaLevel;
  floats[7] = INFRASTRUCTURE_BIN_METERS;
  const writeSplit = (word: number, x: number, z: number) => {
    const relX = x - origin.x;
    const relZ = z - origin.z;
    const cellX = terrainLandformCell(relX);
    const cellZ = terrainLandformCell(relZ);
    ints[word] = cellX;
    ints[word + 1] = cellZ;
    floats[word + 2] = relX - cellX * TERRAIN_LANDFORM_CELL_METERS;
    floats[word + 3] = relZ - cellZ * TERRAIN_LANDFORM_CELL_METERS;
  };
  if (!empty) {
    writeSplit(8, index.binMinX * INFRASTRUCTURE_BIN_METERS, index.binMinZ * INFRASTRUCTURE_BIN_METERS);
  }

  let cursor = 0;
  for (let binZ = 0; binZ < binsZ; binZ += 1) {
    for (let binX = 0; binX < binsX; binX += 1) {
      const list = index.bins.get(infrastructureBinKey(index.binMinX + binX, index.binMinZ + binZ));
      const bin = binZ * binsX + binX;
      const word = binBase * 4 + bin * 2;
      words[word] = cursor;
      words[word + 1] = list?.length ?? 0;
      if (!list) continue;
      for (let i = 0; i < list.length; i += 1) words[listBase * 4 + cursor + i] = list[i]!;
      cursor += list.length;
    }
  }

  segments.forEach((packed, i) => {
    const word = (segmentBase + i * INFRASTRUCTURE_SEGMENT_VEC4S) * 4;
    const { segment } = packed;
    writeSplit(word, packed.ax, packed.az);
    floats[word + 4] = packed.dirX;
    floats[word + 5] = packed.dirZ;
    floats[word + 6] = packed.length;
    floats[word + 7] = packed.radius;
    floats[word + 8] = packed.length;
    floats[word + 9] = segment.halfWidth;
    floats[word + 10] = segment.reach;
    const surface = segment.surface === undefined ? 0 : INFRASTRUCTURE_SURFACE_MATERIAL[segment.surface] + 1;
    words[word + 11] = ((segment.profile & 0xffff) | (MODE_CODE[segment.mode] << 16) | (surface << 20)) >>> 0;
    for (let p = 0; p < 8; p += 1) floats[word + 12 + p] = segment.params[p] ?? 0;
  });
  return words;
}

/** The index a world's consumers bind, packed. */
export function packWorldTerrainInfrastructure(world: WorldDefinition): Uint32Array {
  return packTerrainInfrastructure(infrastructureIndex(world), world.seaLevel, landformCoreCenter(world));
}

export function terrainInfrastructureDataBindingWgsl(group: number, binding: number): string {
  return /* wgsl */ `
@group(${group}) @binding(${binding}) var<storage, read> terrainInfrastructureData: array<vec4u>;
`;
}

function profileDispatchWgsl(): string {
  const cases = INFRASTRUCTURE_PROFILES.map((profile) =>
    `    case ${profile.id}u: { return terrainInfra_${profile.name}(along, across, seg, ground, seaLevel); }`,
  ).join("\n");
  return /* wgsl */ `
fn terrainInfraProfile(
  profile: u32,
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  switch (profile) {
${cases}
    default: { return vec2f(ground, 0.0); }
  }
}
`;
}

/**
 * The stage. Requires, before it: `terrainKernelPageBindingWgsl(...)`,
 * `terrainInfrastructureDataBindingWgsl(...)` and `TERRAIN_KERNEL_WGSL`
 * (`kSmoothstep`, `kSaturate`, `kClamp`, `kLerp`, `kPageIndex`).
 */
export const TERRAIN_INFRASTRUCTURE_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Infrastructure — TRANSLITERATION of src/world/infrastructure.ts and the
// profiles in src/world/infrastructureProfiles.ts. Generated by
// src/render/webgpu/terrain/TerrainInfrastructureKernel.ts.
// ---------------------------------------------------------------------------

const K_INFRA_CELL: f32 = ${TERRAIN_LANDFORM_CELL_METERS}.0;
const K_INFRA_SURFACE_FEATHER: f32 = ${INFRASTRUCTURE_SURFACE_FEATHER_METERS}.0;

/** What a profile reads of a segment (frame, shape, params). */
struct TerrainInfrastructureSegment {
  // (dir x, dir z, length, halfWidth + reach)
  frame: vec4f,
  // (length, halfWidth, reach, profile | mode << 16 | surface << 20 as bits)
  shape: vec4f,
  p0: vec4f,
  p1: vec4f,
};

/** infrastructureCapsuleDistance. */
fn terrainInfraCapsuleDistance(along: f32, across: f32, segmentLength: f32) -> f32 {
  if (along < 0.0) { return length(vec2f(along, across)); }
  if (along > segmentLength) { return length(vec2f(along - segmentLength, across)); }
  return abs(across);
}

${INFRASTRUCTURE_PROFILES.map((profile) => profile.wgsl).join("\n")}
${profileDispatchWgsl()}

fn terrainInfraFloats(index: u32) -> vec4f {
  return bitcast<vec4f>(terrainInfrastructureData[index]);
}

/** A split position's offset to the point (base cells, base remainder + local). */
fn terrainInfraOffset(cell: vec2<i32>, within: vec2f, base: vec4f, local: vec2f) -> vec2f {
  return vec2f(vec2<i32>(base.xy) - cell) * K_INFRA_CELL + ((base.zw - within) + local);
}

/** The bin a split point falls in: (first list entry, count), (0, 0) outside the grid. */
fn terrainInfraBin(base: vec4f, local: vec2f) -> vec2u {
  let header = terrainInfrastructureData[0u];
  let header1 = terrainInfrastructureData[1u];
  let corner = terrainInfrastructureData[2u];
  let binSize = bitcast<f32>(header1.w);
  let fromCorner = terrainInfraOffset(
    bitcast<vec2<i32>>(corner.xy), bitcast<vec2f>(corner.zw), base, local);
  let binXZ = floor(fromCorner / binSize);
  if (binXZ.x < 0.0 || binXZ.y < 0.0 || binXZ.x >= f32(header.y) || binXZ.y >= f32(header.z)) {
    return vec2u(0u, 0u);
  }
  let bin = u32(binXZ.y) * header.y + u32(binXZ.x);
  let packed = terrainInfrastructureData[header.w + bin / 2u];
  if ((bin & 1u) == 1u) { return packed.zw; }
  return packed.xy;
}

/** The first vec4 of the segment a bin list entry names. */
fn terrainInfraSegmentFirst(entryIndex: u32) -> u32 {
  let header1 = terrainInfrastructureData[1u];
  let refs = terrainInfrastructureData[header1.x + entryIndex / 4u];
  let lane = entryIndex & 3u;
  var segIndex = refs.x;
  if (lane == 1u) { segIndex = refs.y; }
  if (lane == 2u) { segIndex = refs.z; }
  if (lane == 3u) { segIndex = refs.w; }
  return header1.y + segIndex * ${INFRASTRUCTURE_SEGMENT_VEC4S}u;
}

/** (along, across) of a split point on the segment whose first vec4 is \`first\`. */
fn terrainInfraLocal(first: u32, base: vec4f, local: vec2f) -> vec2f {
  let origin = terrainInfrastructureData[first];
  let rel = terrainInfraOffset(bitcast<vec2<i32>>(origin.xy), bitcast<vec2f>(origin.zw), base, local);
  let frame = terrainInfraFloats(first + 1u);
  // Right of a->b seen from above: (dirZ, -dirX).
  return vec2f(rel.x * frame.x + rel.y * frame.y, rel.x * frame.y - rel.y * frame.x);
}

/**
 * applyInfrastructure at a split point: \`base\` is the page's landformBase
 * (whole cells .xy, remainder .zw, from the core centre), \`local\` the offset
 * from it. Returns \`height\` itself wherever no segment reaches.
 */
fn terrainInfrastructureSplit(base: vec4f, local: vec2f, height: f32) -> f32 {
  if (terrainInfrastructureData[0u].x == 0u) { return height; }
  let entry = terrainInfraBin(base, local);
  let seaLevel = bitcast<f32>(terrainInfrastructureData[1u].z);
  var h = height;
  for (var i = 0u; i < entry.y; i = i + 1u) {
    let first = terrainInfraSegmentFirst(entry.x + i);
    let frame = terrainInfraFloats(first + 1u);
    let position = terrainInfraLocal(first, base, local);
    let along = position.x;
    let across = position.y;
    if (terrainInfraCapsuleDistance(along, across, frame.z) >= frame.w) { continue; }
    let shape = terrainInfraFloats(first + 2u);
    let seg = TerrainInfrastructureSegment(
      frame, shape, terrainInfraFloats(first + 3u), terrainInfraFloats(first + 4u));
    let code = terrainInfrastructureData[first + 2u].w;
    let sample = terrainInfraProfile(code & 0xffffu, along, across, seg, h, seaLevel);
    let weight = sample.y;
    if (!(weight > 0.0)) { continue; }
    let mode = (code >> 16u) & 0xfu;
    var applies = true;
    if (mode == 1u) { applies = sample.x < h; }
    if (mode == 2u) { applies = sample.x > h; }
    if (applies) {
      if (weight >= 1.0) { h = sample.x; } else { h = h + (sample.x - h) * weight; }
    }
  }
  return h;
}

/** The stage at a point LOCAL to the bound kernel page. */
fn terrainInfrastructure(localX: f32, localZ: f32, height: f32) -> f32 {
  return terrainInfrastructureSplit(
    terrainKernelPages[kPageIndex].landformBase, vec2f(localX, localZ), height);
}

/**
 * sampleInfrastructureSurface at a point LOCAL to the bound kernel page:
 * (splat material id, coverage), or (-1, 0) where nothing is painted. The
 * most coverage wins, the later segment on a tie.
 */
fn terrainInfrastructureSurface(localX: f32, localZ: f32) -> vec2f {
  var best = vec2f(-1.0, 0.0);
  if (terrainInfrastructureData[0u].x == 0u) { return best; }
  let base = terrainKernelPages[kPageIndex].landformBase;
  let local = vec2f(localX, localZ);
  let entry = terrainInfraBin(base, local);
  for (var i = 0u; i < entry.y; i = i + 1u) {
    let first = terrainInfraSegmentFirst(entry.x + i);
    let surface = (terrainInfrastructureData[first + 2u].w >> 20u) & 0xffu;
    if (surface == 0u) { continue; }
    let position = terrainInfraLocal(first, base, local);
    let shape = terrainInfraFloats(first + 2u);
    let distance = terrainInfraCapsuleDistance(position.x, position.y, shape.x);
    let coverage = kSaturate(0.5 + (shape.y - distance) / K_INFRA_SURFACE_FEATHER);
    if (coverage > 0.0 && coverage >= best.y) { best = vec2f(f32(surface - 1u), coverage); }
  }
  return best;
}
`;

/**
 * A world's packed index on the GPU. `setWorld` repacks only when the world's
 * index object changes (a spawned airport makes a new world, and its index is
 * rebuilt from the same sources), so steady state is one identity check.
 */
export class TerrainInfrastructureData {
  private storage: StorageBuffer;
  private capacityBytes: number;
  private version = 0;
  private index: InfrastructureIndex | null;
  private disposed = false;

  /** Without a world, the empty index: a header that lists nothing. */
  constructor(private readonly engine: WebGPUEngine, world: WorldDefinition | null) {
    const words = world
      ? packWorldTerrainInfrastructure(world)
      : new Uint32Array(INFRASTRUCTURE_HEADER_VEC4S * 4);
    this.capacityBytes = Math.max(words.byteLength, TERRAIN_INFRASTRUCTURE_PLACEHOLDER_BYTES);
    this.storage = new StorageBuffer(engine, this.capacityBytes, undefined, "terrain-infrastructure");
    registerGpuBufferBytes(this.capacityBytes);
    this.storage.update(words);
    this.index = world ? infrastructureIndex(world) : null;
  }

  get buffer(): StorageBuffer {
    return this.storage;
  }

  /** Bumped whenever `buffer` is replaced or rewritten. */
  get bufferVersion(): number {
    return this.version;
  }

  setWorld(world: WorldDefinition): void {
    if (this.disposed) return;
    const index = infrastructureIndex(world);
    if (index === this.index) return;
    this.index = index;
    const words = packWorldTerrainInfrastructure(world);
    if (words.byteLength > this.capacityBytes) {
      this.storage.dispose();
      releaseGpuBufferBytes(this.capacityBytes);
      this.capacityBytes = words.byteLength;
      this.storage = new StorageBuffer(this.engine, this.capacityBytes, undefined, "terrain-infrastructure");
      registerGpuBufferBytes(this.capacityBytes);
    }
    this.storage.update(words);
    this.version += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.storage.dispose();
    releaseGpuBufferBytes(this.capacityBytes);
  }
}

/**
 * One consumer's `terrainInfrastructureData` binding. It packs the world it
 * is given on its first bind (the consumer's constructor runs before the
 * engine is known to be WebGPU, and in Node tests with no engine at all) and
 * owns that buffer; without a world it binds an empty index. Rebinding
 * compares a buffer and a number, as `TerrainLandformDataBinding` does.
 *
 * Each consumer packs its own copy: a few kilobytes, once, against threading
 * one more source through the renderer.
 */
export class TerrainInfrastructureDataBinding {
  private data: TerrainInfrastructureData | null = null;
  private boundShader: ComputeShader | null = null;
  private boundBuffer: StorageBuffer | null = null;
  private boundVersion = -1;

  constructor(private world: WorldDefinition | null) {}

  /** The world the stage reads (a spawned airport's new world repacks only if its index changed). */
  setWorld(world: WorldDefinition | null): void {
    this.world = world;
    if (world && this.data) this.data.setWorld(world);
  }

  bind(engine: WebGPUEngine, shader: ComputeShader): void {
    const data = this.ensureData(engine);
    if (
      shader === this.boundShader
      && data.buffer === this.boundBuffer
      && data.bufferVersion === this.boundVersion
    ) return;
    shader.setStorageBuffer("terrainInfrastructureData", data.buffer);
    this.boundShader = shader;
    this.boundBuffer = data.buffer;
    this.boundVersion = data.bufferVersion;
  }

  dispose(): void {
    this.data?.dispose();
    this.data = null;
    this.boundShader = null;
    this.boundBuffer = null;
    this.boundVersion = -1;
  }

  private ensureData(engine: WebGPUEngine): TerrainInfrastructureData {
    this.data ??= new TerrainInfrastructureData(engine, this.world);
    return this.data;
  }
}
