import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";
import {
  INFRASTRUCTURE_BIN_METERS,
  INFRASTRUCTURE_SURFACE_BOX_HALF_METERS,
  INFRASTRUCTURE_SURFACE_FEATHER_METERS,
  infrastructureBin,
  infrastructureBinKeyX,
  infrastructureBinKeyZ,
  infrastructureIndex,
  infrastructureIndexChanges,
  infrastructureIndexStreamed,
  infrastructureTerrainKey,
  type PackedInfrastructureSegment,
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
 *   [0] segment count, bin table mask, first bin-table vec4, longest probe
 *   [1] first list vec4, first segment vec4, sea level (f32), bin size (f32)
 *   [2] the anchor bin's corner: cells (i32 x, z), remainder (f32 x, z)
 *   segments: five vec4s each, by slot: (a cell i32 x, z, a remainder f32
 *             x, z), (dir x, dir z, length, halfWidth + reach) f32,
 *             (length, halfWidth, reach f32,
 *              profile | mode << 16 | (surface material + 1) << 20),
 *             params 0-3, params 4-7 (f32)
 *   bin table: one vec4 a slot, (bin x, bin z (i32, from the anchor bin),
 *             first list entry, count + 1); 0 in the last lane is a slot
 *             never used, and a bin emptied since keeps its key with count 0
 *   lists:    four segment slots per vec4
 *
 * IN PLACE. Streamed regions come and go a few times a second while flying,
 * so the GPU's copy (`TerrainInfrastructureData`) is packed with room to
 * spare (`TerrainInfrastructurePack`) and then kept by ranged writes: a
 * change rewrites the segment slots it changed (the CPU index keeps every
 * segment in a stable slot), the table entries of the bins it re-merged,
 * those bins' new lists, written past the last list, and the header. It
 * packs afresh only when the slots, the table or the list space run out.
 *
 * WHY A HASHED BIN TABLE. Streamed regions (the roads) follow the observer
 * while the static sources stay at home, so the occupied bins can sit a
 * hundred kilometres apart: a dense grid over their rectangle would grow
 * without bound. The table holds only occupied bins, open-addressed at a
 * load of at most one half, keyed by the bin's offset from the anchor bin
 * (the one holding the landform core centre); `terrainInfraBinHash` is the
 * CPU's `infrastructureGpuBinHash` to the bit, and the header carries the
 * longest probe the CPU needed, so a lookup is bounded.
 *
 * CONTAINMENT. With no segments (no sources, an eroded world, the
 * placeholder) the header's count is 0 and `terrainInfrastructure` returns
 * `height` itself; outside every listed segment's reach it does the same.
 */

export const INFRASTRUCTURE_HEADER_VEC4S = 3;
export const INFRASTRUCTURE_SEGMENT_VEC4S = 5;

/**
 * The bin table's hash of a bin's offset from the anchor bin: a multiply-xor
 * on the two's-complement bits, so WGSL's wrapping u32 arithmetic
 * (`terrainInfraBinHash`) gives the same 32 bits.
 */
export function infrastructureGpuBinHash(binX: number, binZ: number): number {
  const h = (Math.imul(binX, 0x9e37_79b1) ^ Math.imul(binZ, 0x85eb_ca77)) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

const MODE_CODE = { set: 0, cut: 1, fill: 2 } as const;

/** The splat material each named surface paints. */
export const INFRASTRUCTURE_SURFACE_MATERIAL: Readonly<Record<InfrastructureSurface, SurfaceMaterialId>> =
  Object.freeze({
    concrete: SurfaceMaterial.Concrete,
    asphalt: SurfaceMaterial.Asphalt,
    gravel: SurfaceMaterial.Gravel,
    // Two worn ruts: loose stone at the coverage the track's own paint gives it.
    track: SurfaceMaterial.Gravel,
  });

/** The placeholder: three header vec4s of zeros, so no segment is listed. */
export const TERRAIN_INFRASTRUCTURE_PLACEHOLDER_BYTES = INFRASTRUCTURE_HEADER_VEC4S * 16;

/**
 * The room a pack for the GPU's own copy leaves (`TerrainInfrastructurePack`
 * with headroom): segment slots for half as many again and 64 more, a bin
 * table at a load of a quarter that takes new bins up to a half, and list
 * space for three times the entries and 4,096 more.
 */
const SEGMENT_HEADROOM = 1.5;
const SEGMENT_SLACK = 64;
const LIST_HEADROOM = 3;
const LIST_SLACK = 4_096;

/**
 * At least this much once streamed regions are in, so the roads' whole
 * window round a jet streams in after the first pack, made while priming
 * round the spawn, without another, and its table is rarely rehashed:
 * about 2.7 MB. Measured on a 300 s leg at 250 m/s from the home field
 * (7271, -37795, heading 135): the window grows to 13,941 segments in 4,125
 * bins, which the old 16,384 segments and 8,192 slots (a table full at
 * 4,096 bins) took with one fresh pack (18 ms) and a rehash every 20 s
 * (2 to 9 ms each, 13 of them) as dropped bins filled the table.
 */
const STREAMED_MIN_SEGMENTS = 24_576;
const STREAMED_MIN_TABLE_SLOTS = 16_384;
const STREAMED_MIN_LIST_ENTRIES = 131_072;

/** Dirty vec4 ranges closer than this are written as one. */
const DIRTY_MERGE_VEC4S = 16;

/** A bin as the pack holds it: its table slot, and the block of list space it writes its list into. */
interface PackedBin {
  readonly slot: number;
  first: number;
  capacity: number;
  /** Segments listed now; 0 for a bin emptied since it was packed. */
  count: number;
}

/**
 * An index packed for the GPU (the LAYOUT above), and what it takes to keep
 * it current in place: `update` applies a change to `words` and returns the
 * vec4 ranges it wrote.
 *
 * With headroom, each bin owns a block of list space a power of two long, so
 * a re-merged list that still fits is rewritten where it is, and a longer one
 * takes a fresh block past the last. When the list space runs out the blocks
 * are laid out again, packed, and when the table fills with bins the observer
 * has left it is rehashed with the bins still listed; only running out of
 * segment slots takes a fresh pack.
 */
export class TerrainInfrastructurePack {
  readonly words: Uint32Array;
  private readonly floats: Float32Array;
  private readonly ints: Int32Array;
  private readonly segmentCapacity: number;
  private readonly tableSlots: number;
  private readonly tableBase: number;
  private readonly listBase: number;
  /** List entries the space holds. */
  private readonly listCapacity: number;
  private listCursor = 0;
  private longestProbe = 0;
  /** Bin key -> how it is packed, emptied bins' included until the table is rehashed. */
  private bins = new Map<number, PackedBin>();
  private readonly anchorX: number;
  private readonly anchorZ: number;
  private dirty: number[] = [];
  /** Layouts of the list space and rehashes of the table since the pack, for tests and probes. */
  readonly relayouts = { lists: 0, table: 0 };

  /**
   * Pack `index` relative to `origin` (the landform core centre). With
   * `headroom`, leave the room above for ranged updates, and with
   * `streamedMinimum` too, at least the streamed minimum for an index with
   * regions in; without, the smallest pack.
   */
  constructor(
    index: InfrastructureIndex,
    seaLevel: number,
    private readonly origin: { readonly x: number; readonly z: number },
    private readonly headroom: boolean,
    streamedMinimum = headroom,
  ) {
    const count = index.segments.length;
    // The occupied bins, in key order, so a pack is a function of the index alone.
    const keys = [...index.bins.keys()].sort((left, right) => left - right);
    let entries = 0;
    for (const key of keys) entries += this.blockSize(index.bins.get(key)!.length);
    const streamed = headroom && streamedMinimum && infrastructureIndexStreamed(index);
    this.segmentCapacity = headroom
      ? Math.max(Math.ceil(count * SEGMENT_HEADROOM) + SEGMENT_SLACK, streamed ? STREAMED_MIN_SEGMENTS : 0)
      : count;
    let slots = streamed ? STREAMED_MIN_TABLE_SLOTS : 1;
    while (slots < (headroom ? 4 : 2) * keys.length) slots *= 2;
    this.tableSlots = slots;
    const listEntries = headroom
      ? Math.max(entries * LIST_HEADROOM + LIST_SLACK, streamed ? STREAMED_MIN_LIST_ENTRIES : 0)
      : entries;
    this.listCapacity = 4 * Math.ceil(listEntries / 4);
    this.tableBase = INFRASTRUCTURE_HEADER_VEC4S + this.segmentCapacity * INFRASTRUCTURE_SEGMENT_VEC4S;
    this.listBase = this.tableBase + slots;
    this.words = new Uint32Array((this.listBase + this.listCapacity / 4) * 4);
    this.floats = new Float32Array(this.words.buffer);
    this.ints = new Int32Array(this.words.buffer);
    this.anchorX = infrastructureBin(origin.x);
    this.anchorZ = infrastructureBin(origin.z);

    const words = this.words;
    words[1] = slots - 1;
    words[2] = this.tableBase;
    words[4] = this.listBase;
    words[5] = INFRASTRUCTURE_HEADER_VEC4S;
    this.floats[6] = seaLevel;
    this.floats[7] = INFRASTRUCTURE_BIN_METERS;
    this.writeSplit(8, this.anchorX * INFRASTRUCTURE_BIN_METERS, this.anchorZ * INFRASTRUCTURE_BIN_METERS);
    for (let slot = 0; slot < count; slot += 1) this.writeSegment(slot, index.segments[slot]!);
    for (const key of keys) this.writeBin(index, key);
    this.writeCount(count);
    this.dirty = [];
  }

  /**
   * Rewrite what changed between the index this holds and `index`
   * (`infrastructureIndexChanges`). Returns the vec4 ranges written, as
   * [start, end) pairs, or null when the change does not fit (pack afresh);
   * `words` is then part-written and no longer to be used.
   */
  update(
    index: InfrastructureIndex,
    changes: { readonly slots: ArrayLike<number>; readonly bins: ArrayLike<number> },
  ): number[] | null {
    const count = index.segments.length;
    if (count > this.segmentCapacity) return null;
    for (let i = 0; i < changes.slots.length; i += 1) {
      const slot = changes.slots[i]!;
      if (slot < count) this.writeSegment(slot, index.segments[slot]!);
    }
    for (let i = 0; i < changes.bins.length; i += 1) {
      if (!this.writeBin(index, changes.bins[i]!)) return null;
    }
    this.writeCount(count);
    return this.takeDirty();
  }

  /** List space a bin of `count` segments takes: a power of two with headroom, else exactly. */
  private blockSize(count: number): number {
    if (!this.headroom) return count;
    let size = 4;
    while (size < count) size *= 2;
    return size;
  }

  private writeCount(count: number): void {
    this.words[0] = count;
    this.words[3] = this.longestProbe;
    this.markDirty(0, 1);
  }

  private writeSplit(word: number, x: number, z: number): void {
    const relX = x - this.origin.x;
    const relZ = z - this.origin.z;
    const cellX = terrainLandformCell(relX);
    const cellZ = terrainLandformCell(relZ);
    this.ints[word] = cellX;
    this.ints[word + 1] = cellZ;
    this.floats[word + 2] = relX - cellX * TERRAIN_LANDFORM_CELL_METERS;
    this.floats[word + 3] = relZ - cellZ * TERRAIN_LANDFORM_CELL_METERS;
  }

  private writeSegment(slot: number, packed: PackedInfrastructureSegment): void {
    const first = INFRASTRUCTURE_HEADER_VEC4S + slot * INFRASTRUCTURE_SEGMENT_VEC4S;
    const word = first * 4;
    const floats = this.floats;
    const { segment } = packed;
    this.writeSplit(word, packed.ax, packed.az);
    floats[word + 4] = packed.dirX;
    floats[word + 5] = packed.dirZ;
    floats[word + 6] = packed.length;
    floats[word + 7] = packed.radius;
    floats[word + 8] = packed.length;
    floats[word + 9] = segment.halfWidth;
    floats[word + 10] = segment.reach;
    const surface = segment.surface === undefined ? 0 : INFRASTRUCTURE_SURFACE_MATERIAL[segment.surface] + 1;
    this.words[word + 11] = ((segment.profile & 0xffff) | (MODE_CODE[segment.mode] << 16) | (surface << 20)) >>> 0;
    for (let p = 0; p < 8; p += 1) floats[word + 12 + p] = segment.params[p] ?? 0;
    this.markDirty(first, first + INFRASTRUCTURE_SEGMENT_VEC4S);
  }

  /** A bin's list as `index` has it now; false when the table or the list space cannot hold it. */
  private writeBin(index: InfrastructureIndex, key: number): boolean {
    const list = index.bins.get(key);
    let bin = this.bins.get(key);
    if (!bin) {
      if (!list) return true;
      if ((this.bins.size + 1) * 2 > this.tableSlots && !this.rehashTable()) return false;
      bin = { slot: this.insertKey(key), first: 0, capacity: 0, count: 0 };
      this.bins.set(key, bin);
    }
    const count = list?.length ?? 0;
    if (count > bin.capacity) {
      const size = this.blockSize(count);
      if (this.listCursor + size > this.listCapacity) return this.layOutLists(index);
      bin.first = this.listCursor;
      bin.capacity = size;
      this.listCursor += size;
    }
    bin.count = count;
    this.writeEntry(bin);
    if (list) {
      this.words.set(list, this.listBase * 4 + bin.first);
      this.markDirty(this.listBase + Math.floor(bin.first / 4), this.listBase + Math.ceil((bin.first + count) / 4));
    }
    return true;
  }

  /** A new key's table slot, probed from its hash. */
  private insertKey(key: number): number {
    const words = this.words;
    const keyX = infrastructureBinKeyX(key) - this.anchorX;
    const keyZ = infrastructureBinKeyZ(key) - this.anchorZ;
    const mask = this.tableSlots - 1;
    let slot = infrastructureGpuBinHash(keyX, keyZ) & mask;
    let probe = 1;
    while (words[(this.tableBase + slot) * 4 + 3] !== 0) {
      slot = (slot + 1) & mask;
      probe += 1;
    }
    this.longestProbe = Math.max(this.longestProbe, probe);
    this.ints[(this.tableBase + slot) * 4] = keyX;
    this.ints[(this.tableBase + slot) * 4 + 1] = keyZ;
    return slot;
  }

  /**
   * A bin's table entry; an emptied bin keeps its key, so the probes that
   * pass it still find what lies beyond. A caller rewriting every entry
   * marks the whole table once instead (`mark` false).
   */
  private writeEntry(bin: PackedBin, mark = true): void {
    const word = (this.tableBase + bin.slot) * 4;
    this.words[word + 2] = bin.count > 0 ? bin.first : 0;
    this.words[word + 3] = bin.count + 1;
    if (mark) this.markDirty(this.tableBase + bin.slot, this.tableBase + bin.slot + 1);
  }

  /** The table again with only the bins listing something: emptied bins' keys go. */
  private rehashTable(): boolean {
    const live = [...this.bins].filter(([, bin]) => bin.count > 0);
    if ((live.length + 1) * 2 > this.tableSlots) return false;
    this.words.fill(0, this.tableBase * 4, this.listBase * 4);
    this.longestProbe = 0;
    this.bins = new Map();
    // Key order, so the table is a function of the bins held.
    live.sort(([left], [right]) => left - right);
    for (const [key, bin] of live) {
      const moved: PackedBin = { slot: this.insertKey(key), first: bin.first, capacity: bin.capacity, count: bin.count };
      this.bins.set(key, moved);
      this.writeEntry(moved, false);
    }
    this.markDirty(this.tableBase, this.listBase);
    this.relayouts.table += 1;
    return true;
  }

  /** Every bin's list into a fresh block, packed from the start of the list space, as `index` has them. */
  private layOutLists(index: InfrastructureIndex): boolean {
    let cursor = 0;
    for (const [key, bin] of this.bins) {
      const list = index.bins.get(key);
      bin.count = list?.length ?? 0;
      bin.capacity = bin.count > 0 ? this.blockSize(bin.count) : 0;
      bin.first = cursor;
      cursor += bin.capacity;
    }
    if (cursor > this.listCapacity) return false;
    this.listCursor = cursor;
    for (const [key, bin] of this.bins) {
      this.writeEntry(bin, false);
      const list = index.bins.get(key);
      if (list) this.words.set(list, this.listBase * 4 + bin.first);
    }
    this.markDirty(this.tableBase, this.listBase + Math.ceil(cursor / 4));
    this.relayouts.lists += 1;
    return true;
  }

  private markDirty(start: number, end: number): void {
    this.dirty.push(start, end);
  }

  /** The dirty ranges, sorted and merged, and a clean slate. */
  private takeDirty(): number[] {
    const pairs: [number, number][] = [];
    for (let i = 0; i < this.dirty.length; i += 2) pairs.push([this.dirty[i]!, this.dirty[i + 1]!]);
    this.dirty = [];
    pairs.sort((left, right) => left[0] - right[0]);
    const merged: number[] = [];
    for (const [start, end] of pairs) {
      const last = merged.length - 1;
      if (last > 0 && start <= merged[last]! + DIRTY_MERGE_VEC4S) merged[last] = Math.max(merged[last]!, end);
      else merged.push(start, end);
    }
    return merged;
  }
}

/**
 * Pack an index for the GPU, relative to `origin` (the landform core centre),
 * in the smallest layout. Allocates.
 */
export function packTerrainInfrastructure(
  index: InfrastructureIndex,
  seaLevel: number,
  origin: { readonly x: number; readonly z: number },
): Uint32Array {
  return new TerrainInfrastructurePack(index, seaLevel, origin, false).words;
}

/** A world's index packed in the smallest layout (tests and tools; the GPU keeps its own, `TerrainInfrastructureData`). */
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
const K_INFRA_SURFACE_BOX_HALF: f32 = ${INFRASTRUCTURE_SURFACE_BOX_HALF_METERS}.0;

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

/** infrastructureGpuBinHash: the bin table's hash of a bin's offset from the anchor bin. */
fn terrainInfraBinHash(binX: i32, binZ: i32) -> u32 {
  let h = (bitcast<u32>(binX) * 0x9e3779b1u) ^ (bitcast<u32>(binZ) * 0x85ebca77u);
  return h ^ (h >> 15u);
}

/** A split point's offset from the anchor bin's corner. */
fn terrainInfraFromCorner(base: vec4f, local: vec2f) -> vec2f {
  let corner = terrainInfrastructureData[2u];
  return terrainInfraOffset(bitcast<vec2<i32>>(corner.xy), bitcast<vec2f>(corner.zw), base, local);
}

/** The bin an offset from the anchor bin's corner falls in, as an offset from the anchor bin. */
fn terrainInfraBinOf(fromCorner: vec2f) -> vec2<i32> {
  return vec2<i32>(floor(fromCorner / bitcast<f32>(terrainInfrastructureData[1u].w)));
}

/** The bin a split point falls in: (first list entry, count), (0, 0) where no segment is listed. */
fn terrainInfraBin(base: vec4f, local: vec2f) -> vec2u {
  return terrainInfraBinList(terrainInfraBinOf(terrainInfraFromCorner(base, local)));
}

/** A bin's list (an offset from the anchor bin): (first list entry, count), (0, 0) where no segment is listed. */
fn terrainInfraBinList(bin: vec2<i32>) -> vec2u {
  let header = terrainInfrastructureData[0u];
  var slot = terrainInfraBinHash(bin.x, bin.y) & header.y;
  for (var probe = 0u; probe < header.w; probe = probe + 1u) {
    let entry = terrainInfrastructureData[header.z + slot];
    if (entry.w == 0u) { break; }
    if (bitcast<i32>(entry.x) == bin.x && bitcast<i32>(entry.y) == bin.y) { return vec2u(entry.z, entry.w - 1u); }
    slot = (slot + 1u) & header.y;
  }
  return vec2u(0u, 0u);
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
 * sampleInfrastructureSurface at a point LOCAL to the bound kernel page, for
 * a ground \`texelMeters\` wide (0: the point; the splat bake's texel): (splat
 * material id, coverage), or (-1, 0) where nothing is painted. The most
 * coverage wins, the later segment on a tie. A segment narrower than the
 * texel paints the share of a box the texel's width (at most a bin) it
 * covers; the box's other bins add their narrow segments, winning only on
 * more coverage.
 */
fn terrainInfrastructureSurfaceOver(localX: f32, localZ: f32, texelMeters: f32) -> vec2f {
  var best = vec2f(-1.0, 0.0);
  if (terrainInfrastructureData[0u].x == 0u) { return best; }
  let base = terrainKernelPages[kPageIndex].landformBase;
  let local = vec2f(localX, localZ);
  let half = min(0.5 * texelMeters, K_INFRA_SURFACE_BOX_HALF);
  let fromCorner = terrainInfraFromCorner(base, local);
  let own = terrainInfraBinOf(fromCorner);
  best = terrainInfraSurfaceBin(terrainInfraBinList(own), base, local, texelMeters, half, true, best);
  if (half > 0.0) {
    let low = terrainInfraBinOf(fromCorner - vec2f(half));
    let high = terrainInfraBinOf(fromCorner + vec2f(half));
    for (var boxX = low.x; boxX <= high.x; boxX = boxX + 1) {
      for (var boxZ = low.y; boxZ <= high.y; boxZ = boxZ + 1) {
        if (boxX == own.x && boxZ == own.y) { continue; }
        best = terrainInfraSurfaceBin(
          terrainInfraBinList(vec2<i32>(boxX, boxZ)), base, local, texelMeters, half, false, best);
      }
    }
  }
  return best;
}

/** sampleInfrastructureSurface's surfaceInBin: every painted segment of the point's \`own\` bin, the narrow ones elsewhere. */
fn terrainInfraSurfaceBin(
  entry: vec2u, base: vec4f, local: vec2f, texelMeters: f32, half: f32, own: bool, best: vec2f,
) -> vec2f {
  var result = best;
  for (var i = 0u; i < entry.y; i = i + 1u) {
    let first = terrainInfraSegmentFirst(entry.x + i);
    let surface = (terrainInfrastructureData[first + 2u].w >> 20u) & 0xffu;
    if (surface == 0u) { continue; }
    let shape = terrainInfraFloats(first + 2u);
    let narrow = 2.0 * shape.y < texelMeters;
    if (!own && !narrow) { continue; }
    let position = terrainInfraLocal(first, base, local);
    let distance = terrainInfraCapsuleDistance(position.x, position.y, shape.x);
    var coverage: f32;
    if (narrow) {
      coverage = max(0.0, min(shape.y, distance + half) - max(-shape.y, distance - half)) / (2.0 * half);
    } else {
      coverage = kSaturate(0.5 + (shape.y - distance) / K_INFRA_SURFACE_FEATHER);
    }
    let wins = select(coverage > result.y, coverage >= result.y, own);
    if (coverage > 0.0 && wins) { result = vec2f(f32(surface - 1u), coverage); }
  }
  return result;
}

/** terrainInfrastructureSurfaceOver at the point itself. */
fn terrainInfrastructureSurface(localX: f32, localZ: f32) -> vec2f {
  return terrainInfrastructureSurfaceOver(localX, localZ, 0.0);
}
`;

/**
 * A terrain's packed index on the GPU, shared by every consumer on one engine
 * (`TerrainInfrastructureData.acquire`): page generation, the bathymetry bake
 * and the splat bake bind the same buffer. `setWorld` brings it to the
 * world's current index: nothing when the index object is the one it holds
 * (steady state is one identity check), ranged writes of what changed when
 * it can (`TerrainInfrastructurePack.update`), a fresh pack otherwise, into
 * a new buffer only when the old one is too small.
 */
export class TerrainInfrastructureData {
  private storage: StorageBuffer;
  private capacityBytes: number;
  private version = 0;
  private index: InfrastructureIndex | null;
  private pack: TerrainInfrastructurePack | null;
  private seaLevel: number;
  private originX: number;
  private originZ: number;
  private users = 0;
  private disposed = false;
  /** Writes so far, for tests and probes: fresh packs and ranged updates, and the bytes they sent. */
  readonly writes = { packs: 0, updates: 0, bytes: 0 };

  /**
   * The engine's shared copy for the world's terrain, made on first use;
   * `release` it when done. Without a world, a header that lists nothing.
   */
  static acquire(engine: WebGPUEngine, world: WorldDefinition | null): TerrainInfrastructureData {
    let byTerrain = sharedData.get(engine);
    if (!byTerrain) sharedData.set(engine, (byTerrain = new Map()));
    const key = world ? infrastructureTerrainKey(world) : "";
    let data = byTerrain.get(key);
    if (!data || data.disposed) {
      data = new TerrainInfrastructureData(engine, world);
      byTerrain.set(key, data);
    }
    data.users += 1;
    if (world) data.setWorld(world);
    return data;
  }

  /** Without a world, the empty index: a header that lists nothing. */
  constructor(private readonly engine: WebGPUEngine, world: WorldDefinition | null) {
    const origin = world ? landformCoreCenter(world) : { x: 0, z: 0 };
    this.seaLevel = world?.seaLevel ?? 0;
    this.originX = origin.x;
    this.originZ = origin.z;
    this.index = world ? infrastructureIndex(world) : null;
    this.pack = this.index ? new TerrainInfrastructurePack(this.index, this.seaLevel, origin, true) : null;
    const words = this.pack?.words ?? new Uint32Array(INFRASTRUCTURE_HEADER_VEC4S * 4);
    this.capacityBytes = Math.max(words.byteLength, TERRAIN_INFRASTRUCTURE_PLACEHOLDER_BYTES);
    this.storage = new StorageBuffer(engine, this.capacityBytes, undefined, "terrain-infrastructure");
    registerGpuBufferBytes(this.capacityBytes);
    this.storage.update(words);
    this.writes.packs += 1;
    this.writes.bytes += words.byteLength;
  }

  get buffer(): StorageBuffer {
    return this.storage;
  }

  /** Bumped whenever `buffer` is replaced (ranged writes keep it, and its bindings). */
  get bufferVersion(): number {
    return this.version;
  }

  setWorld(world: WorldDefinition): void {
    if (this.disposed) return;
    const index = infrastructureIndex(world);
    if (index === this.index) return;
    const origin = landformCoreCenter(world);
    const samePlace = world.seaLevel === this.seaLevel && origin.x === this.originX && origin.z === this.originZ;
    const previous = this.index;
    this.index = index;
    const changes = samePlace && previous && this.pack ? infrastructureIndexChanges(previous, index) : null;
    const ranges = changes ? this.pack!.update(index, changes) : null;
    if (ranges) {
      const words = this.pack!.words;
      for (let i = 0; i < ranges.length; i += 2) {
        const start = ranges[i]! * 4;
        const end = ranges[i + 1]! * 4;
        this.storage.update(words.subarray(start, end), start * 4, (end - start) * 4);
        this.writes.bytes += (end - start) * 4;
      }
      this.writes.updates += 1;
      return;
    }
    this.seaLevel = world.seaLevel;
    this.originX = origin.x;
    this.originZ = origin.z;
    this.pack = new TerrainInfrastructurePack(index, world.seaLevel, origin, true);
    const words = this.pack.words;
    if (words.byteLength > this.capacityBytes) {
      this.storage.dispose();
      releaseGpuBufferBytes(this.capacityBytes);
      this.capacityBytes = words.byteLength;
      this.storage = new StorageBuffer(this.engine, this.capacityBytes, undefined, "terrain-infrastructure");
      registerGpuBufferBytes(this.capacityBytes);
      this.version += 1;
    }
    this.storage.update(words);
    this.writes.packs += 1;
    this.writes.bytes += words.byteLength;
  }

  /** Give back a reference from `acquire`; the last one frees the buffer. */
  release(): void {
    this.users -= 1;
    if (this.users <= 0) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.storage.dispose();
    releaseGpuBufferBytes(this.capacityBytes);
  }
}

/** Engine -> terrain key ("" for none) -> its shared copy. */
const sharedData = new WeakMap<WebGPUEngine, Map<string, TerrainInfrastructureData>>();

/**
 * One consumer's `terrainInfrastructureData` binding. It takes the engine's
 * shared copy for its world on its first bind (the consumer's constructor
 * runs before the engine is known to be WebGPU, and in Node tests with no
 * engine at all); without a world it binds an empty index. Every bind first
 * brings that copy to the world's current index, so a bake dispatched after
 * streamed regions changed reads them; rebinding then compares a buffer and
 * a number, as `TerrainLandformDataBinding` does.
 */
export class TerrainInfrastructureDataBinding {
  private data: TerrainInfrastructureData | null = null;
  private dataTerrain = "";
  private boundShader: ComputeShader | null = null;
  private boundBuffer: StorageBuffer | null = null;
  private boundVersion = -1;

  constructor(private world: WorldDefinition | null) {}

  /** The world the stage reads: a spawned airport's new world shares its terrain, so its copy. */
  setWorld(world: WorldDefinition | null): void {
    this.world = world;
  }

  /**
   * Bring the shared copy to the world's index now, where a change is
   * installed (`RoadStreamRuntime`), rather than in the next bake's `bind`:
   * the same ranged writes, timed with the change. Nothing before the first
   * bind, which packs afresh anyway.
   */
  sync(): void {
    if (this.data && this.world) this.data.setWorld(this.world);
  }

  bind(engine: WebGPUEngine, shader: ComputeShader): void {
    const data = this.ensureData(engine);
    if (this.world) data.setWorld(this.world);
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
    this.data?.release();
    this.data = null;
    this.boundShader = null;
    this.boundBuffer = null;
    this.boundVersion = -1;
  }

  private ensureData(engine: WebGPUEngine): TerrainInfrastructureData {
    const terrain = this.world ? infrastructureTerrainKey(this.world) : "";
    if (this.data && this.dataTerrain !== terrain) {
      this.data.release();
      this.data = null;
    }
    if (!this.data) {
      this.data = TerrainInfrastructureData.acquire(engine, this.world);
      this.dataTerrain = terrain;
    }
    return this.data;
  }
}
