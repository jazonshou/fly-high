import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import type { AirportDefinition } from "@/src/world/types";
import {
  compareWorldPageCacheEvictionOrder,
  touchWorldPageCacheMetadata,
  WORLD_PAGE_CACHE_METADATA_VERSION,
  type WorldPageCacheMetadata,
} from "@/src/render/webgpu/world/cache";
import {
  WorldPageLifecycle,
  type WorldPageOperationToken,
} from "@/src/render/webgpu/world/lifecycle";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageKey,
  worldPageBounds,
  type WorldPageAddress,
  type WorldPageKey,
} from "@/src/render/webgpu/world/pageKey";
import { WORLD_PAGE_SCHEMA_VERSION } from "@/src/render/webgpu/world/payload";
import {
  RUNWAY_EARTHWORKS_UNIFORM_FLOATS,
  RUNWAY_EARTHWORKS_WGSL,
  packRunwayEarthworksUniform,
} from "./RunwayEarthworks";
import { RUNWAY_SDF_WGSL } from "./RunwaySurface";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "./TerrainKernel";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_SUPERSAMPLE_OFFSETS,
  terrainPageFilterWidthMeters,
  terrainSupersampleOffsets,
  seasonBucketBlend,
  terrainAtlasEdgeTexels,
  terrainSlotKeyString,
  terrainSlotOrigin,
  terrainTexelSizeMeters,
  type TerrainSlotKey,
} from "./TerrainSpineContract";

/**
 * The terrain page atlas (`4-2`).
 *
 * INVARIANT THIS FILE OWNS: one r32float texture per tier holds every resident
 * height page, and the surplus slots ARE the LRU cache — there is no second
 * cache, no second eviction policy, and no second residency map. `4-6`/`4-7`'s
 * channel families ride the same residency through a second instance at the
 * channel slot edge.
 *
 * Residency, streaming order and eviction ordering are `src/render/webgpu/
 * world/`'s, VERBATIM (`0-3`, precondition P5): canonical `WorldPageKey`s, one
 * `WorldPageLifecycle` per slot with epoch-based rejection of stale dispatch
 * results, and `compareWorldPageCacheEvictionOrder`. This item is the first
 * consumer of the lifecycle's ASYNCHRONOUS half — `ARCHITECTURE.md`'s `0-3`
 * entry records it as untested until now.
 *
 * The class is split in two on purpose: `TerrainAtlasResidency` is Class P and
 * runs in Node (it is where every eviction and cancellation property is
 * tested), and `TerrainPageAtlas` is the thin Babylon shell that owns the
 * texture.
 */

/** Per-slot bounds the CDLOD selector needs and the min/max reduction writes. */
export interface TerrainSlotStats {
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
  /**
   * Largest vertical distance between this page's surface and its parent's,
   * in metres. This is the numerator of CDLOD's screen-space error, so it is
   * a MEASURED quantity from the generation pass, never a level heuristic.
   */
  readonly maxDeviationFromParent: number;
}

const UNKNOWN_STATS: TerrainSlotStats = Object.freeze({
  minHeightMeters: 0,
  maxHeightMeters: 0,
  maxDeviationFromParent: 0,
});

export interface TerrainAtlasSlot {
  readonly key: TerrainSlotKey;
  readonly keyString: string;
  readonly address: WorldPageAddress;
  readonly slotIndex: number;
  readonly lifecycle: WorldPageLifecycle;
  metadata: WorldPageCacheMetadata;
  stats: TerrainSlotStats;
  lastRequiredFrame: number;
  /** The in-flight generation token, or null once resident. */
  token: WorldPageOperationToken | null;
  /**
   * `4.5-B1`: the slot's TEXELS are written and it may be drawn, whether or
   * not its bounds/deviation readback has resolved yet. Never true before the
   * generation dispatch is submitted, and cleared when the slot is released.
   */
  texelsResident: boolean;
  /**
   * `4.5-A3(c)`: the season day this slot's season-KEYED families were baked
   * for, or null while none have been.
   *
   * The splat bake keys its slot on `invariantSlotKey` and bakes each slot
   * once, so a season-bucket rollover left stale splat on screen until the
   * page happened to be evicted — snow that does not melt and a snowline that
   * does not descend. The record lives on the slot rather than in a side map
   * so it cannot outlive the slot it describes.
   */
  bakedSeasonDay: number | null;
}

export interface TerrainAtlasResidencyOptions {
  /** Seed plus every generator setting that changes page content. */
  readonly worldRevision: string;
  /** Bytes one slot occupies; feeds the cache metadata's eviction ordering. */
  readonly slotByteLength: number;
}

export interface TerrainAtlasRequest {
  readonly slot: TerrainAtlasSlot;
  /** Null when the slot was already resident and needs no dispatch. */
  readonly token: WorldPageOperationToken | null;
}

/**
 * Slot residency, eviction and the lifecycle state machine. Class P.
 *
 * The frame index is the clock, as it is in `TerrainClipmapSystem`: eviction
 * ordering needs monotonicity, not wall time, and a frame counter cannot make
 * a headless test flaky.
 */
export class TerrainAtlasResidency {
  private readonly slots = new Map<string, TerrainAtlasSlot>();
  private readonly free: number[] = [];
  private frameIndex = 0;

  constructor(
    readonly slotCount: number,
    private readonly options: TerrainAtlasResidencyOptions,
  ) {
    if (!Number.isSafeInteger(slotCount) || slotCount <= 0) {
      throw new RangeError("Terrain atlas slot count must be a positive integer");
    }
    for (let index = slotCount - 1; index >= 0; index -= 1) this.free.push(index);
  }

  get residentCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.lifecycle.state === "resident") count += 1;
    }
    return count;
  }

  get generatingCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.lifecycle.state === "generating") count += 1;
    }
    return count;
  }

  get freeCount(): number {
    return this.free.length;
  }

  get entries(): readonly TerrainAtlasSlot[] {
    return [...this.slots.values()];
  }

  beginFrame(frameIndex: number): void {
    this.frameIndex = frameIndex;
  }

  /**
   * The slot a page's TEXELS live in, or -1 while there are none.
   *
   * `4.5-B1` split this from "stats resident". Drawing a page needs only its
   * texels, which the generation dispatch writes; the CDLOD split needs its
   * measured deviation, which arrives a GPU readback later. Gating the draw on
   * the readback made a page's arrival cost a full round-trip on top of its
   * dispatch, and a fresh spawn needs about ten sequential rounds of
   * generate → readback → split to descend from the L9 roots.
   */
  slotIndexOf(key: TerrainSlotKey): number {
    const slot = this.slots.get(terrainSlotKeyString(key));
    return slot && (slot.texelsResident || slot.lifecycle.state === "resident")
      ? slot.slotIndex
      : -1;
  }

  /**
   * `4.5-B1`: the page's texels are written and it may be DRAWN, while its
   * bounds and deviation are still in flight.
   *
   * Epoch-checked like every other completion: a slot re-admitted for a
   * different page between the dispatch and this call must not publish the
   * new page's slot as holding the old page's texels.
   */
  publishTexels(key: TerrainSlotKey, token: WorldPageOperationToken): boolean {
    const slot = this.slots.get(terrainSlotKeyString(key));
    if (!slot || slot.token !== token || slot.lifecycle.state !== "generating") return false;
    slot.texelsResident = true;
    return true;
  }

  get(key: TerrainSlotKey): TerrainAtlasSlot | undefined {
    return this.slots.get(terrainSlotKeyString(key));
  }

  /** Mark a slot as wanted this frame, so eviction cannot take it. */
  touch(key: TerrainSlotKey): void {
    const slot = this.slots.get(terrainSlotKeyString(key));
    if (!slot) return;
    slot.lastRequiredFrame = this.frameIndex;
    slot.metadata = touchWorldPageCacheMetadata(slot.metadata, this.frameIndex, true);
  }

  /**
   * Admit a page, evicting the least valuable resident slot if the atlas is
   * full. Returns null only when every slot is either resident-and-required
   * this frame or has a dispatch in flight — the caller defers rather than
   * thrashing.
   */
  request(key: TerrainSlotKey, address: WorldPageAddress): TerrainAtlasRequest | null {
    const keyString = terrainSlotKeyString(key);
    const existing = this.slots.get(keyString);
    if (existing) {
      this.touch(key);
      return { slot: existing, token: null };
    }
    const slotIndex = this.free.pop() ?? this.evictLeastValuable();
    if (slotIndex === null) return null;

    const lifecycle = new WorldPageLifecycle(key.page, () => this.frameIndex);
    const token = lifecycle.queue();
    lifecycle.beginGeneration(token);
    const slot: TerrainAtlasSlot = {
      key,
      keyString,
      address,
      slotIndex,
      lifecycle,
      metadata: {
        metadataVersion: WORLD_PAGE_CACHE_METADATA_VERSION,
        pageSchemaVersion: WORLD_PAGE_SCHEMA_VERSION,
        key: key.page,
        worldRevision: this.options.worldRevision,
        contentRevision: `gpu-page-v${key.variant}`,
        // A GPU-generated page has no CPU payload at all; that is the whole
        // reason the lifecycle needed a second branch.
        cpuByteLength: 0,
        gpuByteLengthEstimate: this.options.slotByteLength,
        createdAtMs: this.frameIndex,
        lastAccessedAtMs: this.frameIndex,
        lastVisibleAtMs: this.frameIndex,
        accessCount: 0,
        pinned: false,
      },
      stats: UNKNOWN_STATS,
      lastRequiredFrame: this.frameIndex,
      token,
      texelsResident: false,
      bakedSeasonDay: null,
    };
    this.slots.set(keyString, slot);
    return { slot, token };
  }

  /** A generation dispatch completed. Stale epochs are rejected harmlessly. */
  complete(
    key: TerrainSlotKey,
    token: WorldPageOperationToken,
    stats: TerrainSlotStats,
  ): boolean {
    const slot = this.slots.get(terrainSlotKeyString(key));
    if (!slot || !slot.lifecycle.markGenerated(token)) return false;
    slot.stats = stats;
    slot.token = null;
    slot.texelsResident = true;
    return true;
  }

  fail(key: TerrainSlotKey, token: WorldPageOperationToken, message: string): boolean {
    const slot = this.slots.get(terrainSlotKeyString(key));
    if (!slot || !slot.lifecycle.markFailed(token, message)) return false;
    slot.token = null;
    this.release(key);
    return true;
  }

  /** Give a slot back, whatever state it is in. */
  release(key: TerrainSlotKey): void {
    const keyString = terrainSlotKeyString(key);
    const slot = this.slots.get(keyString);
    if (!slot) return;
    const state = slot.lifecycle.state;
    if (state === "resident") {
      slot.lifecycle.finishEviction(slot.lifecycle.beginEviction(), false);
    } else if (state === "generating" && slot.token) {
      slot.lifecycle.cancelOperation(slot.token);
    }
    slot.token = null;
    slot.texelsResident = false;
    this.slots.delete(keyString);
    this.free.push(slot.slotIndex);
  }

  /**
   * `4.5-B3`: give back slots stuck in `generating` that nothing has wanted
   * for `maxAgeFrames`, and return how many were reclaimed.
   *
   * `evictionCandidates` considers only `resident` slots, so a request whose
   * dispatch never completed — a failed admission, a producer disposed by a
   * quality switch, a page the aircraft turned away from before it was ever
   * generated — held its slot index forever. Enough of them and `request()`
   * returns null for every new page and streaming deadlocks with an atlas that
   * looks half empty.
   *
   * Slots whose TEXELS are already published are never reclaimed here: those
   * are drawable and merely awaiting their stats.
   */
  reclaimStalledGenerating(maxAgeFrames: number): number {
    const stalled = [...this.slots.values()].filter(
      (slot) => slot.lifecycle.state === "generating"
        && !slot.texelsResident
        && this.frameIndex - slot.lastRequiredFrame > maxAgeFrames,
    );
    for (const slot of stalled) this.release(slot.key);
    return stalled.length;
  }

  /**
   * Resident slots not required this frame, most evictable first. Exposed so
   * the ordering can be asserted directly rather than inferred from which page
   * happened to disappear.
   */
  evictionCandidates(): readonly TerrainAtlasSlot[] {
    const candidates = [...this.slots.values()].filter(
      (slot) => slot.lifecycle.state === "resident" && slot.lastRequiredFrame < this.frameIndex,
    );
    candidates.sort((first, second) =>
      compareWorldPageCacheEvictionOrder(first.metadata, second.metadata));
    return candidates;
  }

  private evictLeastValuable(): number | null {
    const victim = this.evictionCandidates()[0];
    if (!victim) return null;
    this.release(victim.key);
    // release() pushed the slot back onto the free list.
    return this.free.pop() ?? null;
  }
}

// ---------------------------------------------------------------------------
// The GPU half
// ---------------------------------------------------------------------------

export type TerrainAtlasKind = "height" | "channel";

/**
 * Texture indices inside the channel atlas, named once.
 *
 * Seven rgba8 textures per slot: occlusion (sky visibility + bent normal),
 * two horizon textures (eight azimuths), and the season-keyed splat pair for
 * each of the TWO resident buckets. The estimator's channel row is the same
 * accounting from the other direction (12 invariant + 8 per bucket bytes).
 */
export const TERRAIN_CHANNEL_TEXTURES = Object.freeze({
  occlusion: 0,
  horizonA: 1,
  horizonB: 2,
  splatIdLo: 3,
  splatWeightLo: 4,
  splatIdHi: 5,
  splatWeightHi: 6,
});

export const TERRAIN_CHANNEL_TEXTURE_COUNT = 7;

export interface TerrainPageAtlasOptions {
  readonly kind: TerrainAtlasKind;
  readonly worldRevision: string;
  /** Textures the family occupies per slot (splat is two, height is one). */
  readonly textureCount?: number;
  readonly bytesPerTexel?: number;
}

/**
 * One page atlas: residency plus the GPU texture(s) it addresses.
 *
 * The texture is r32float for height and rgba8unorm for channel families, and
 * both are created with the storage flag: a page is WRITTEN by a compute
 * dispatch and READ by the terrain material in the same frame. `R-4B` names
 * the fallback if a driver refuses that combination — a ping-pong pair with a
 * copy, costing one atlas of memory at the tier that needs it.
 */
export class TerrainPageAtlas {
  readonly residency: TerrainAtlasResidency;
  readonly slotEdge: number;
  readonly atlasEdge: number;
  private readonly textures: RawTexture[] = [];
  private disposed = false;

  constructor(
    scene: Scene,
    profile: WebGpuQualityProfile,
    private readonly options: TerrainPageAtlasOptions,
  ) {
    const height = options.kind === "height";
    this.slotEdge = height ? TERRAIN_HEIGHT_SLOT_EDGE : TERRAIN_CHANNEL_SLOT_EDGE;
    const slots = height ? profile.heightAtlasSlots : profile.channelAtlasSlots;
    this.atlasEdge = terrainAtlasEdgeTexels(slots, this.slotEdge);
    this.residency = new TerrainAtlasResidency(slots, {
      worldRevision: options.worldRevision,
      slotByteLength:
        this.slotEdge * this.slotEdge * (options.bytesPerTexel ?? 4) * (options.textureCount ?? 1),
    });

    // NullEngine cannot express a storage texture at all, and the Node suite
    // runs the whole residency half against it — the same guard the material
    // arrays and the foliage atlas use.
    const engineFlags = scene.getEngine() as { isWebGPU?: boolean };
    if (!engineFlags.isWebGPU) return;
    for (let index = 0; index < (options.textureCount ?? 1); index += 1) {
      const texture = height
        // CreateRStorageTexture, not CreateRTexture with a creation flag: the
        // storage variant is the one that adds STORAGE_BINDING usage, and the
        // page is written by a compute dispatch and sampled by the terrain
        // material in the same frame.
        ? RawTexture.CreateRStorageTexture(
          null,
          this.atlasEdge,
          this.atlasEdge,
          scene,
          false,
          false,
          // 4-0: never filtered. The vertex shader takes four textureLoads at
          // snapped lattice positions, which is what geomorph correctness
          // wants; `float32-filterable` is available and deliberately not
          // requested.
          Texture.NEAREST_SAMPLINGMODE,
          Constants.TEXTURETYPE_FLOAT,
        )
        : RawTexture.CreateRGBAStorageTexture(
          null,
          this.atlasEdge,
          this.atlasEdge,
          scene,
          false,
          false,
          // `4.5-A2`: BILINEAR, not NEAREST. This is `3-0`'s design finally
          // taking effect. The channel families are rgba8unorm (filterable),
          // the material axis is ORDERED so a filtered primary id lands
          // between two materials that actually meet, and sky visibility and
          // the horizon field are continuous quantities that were being
          // point-sampled into 2 m blocks. NEAREST here is half of why even a
          // fully resident page rendered as hard-edged single-material blocks.
          //
          // A 1-texel bilinear footprint cannot cross a slot: the fragment
          // clamps its page-local position into [0, 1] and lands inside
          // `[gutter, gutter + core]`, and the bake writes the full 4-texel
          // gutter on every side.
          Texture.BILINEAR_SAMPLINGMODE,
          Constants.TEXTURETYPE_UNSIGNED_BYTE,
        );
      texture.name = `terrain-${options.kind}-atlas-${index}`;
      texture.wrapU = Texture.CLAMP_ADDRESSMODE;
      texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.textures.push(texture);
    }
  }

  get kind(): TerrainAtlasKind {
    return this.options.kind;
  }

  /** Null under NullEngine, where no storage texture exists. */
  texture(index = 0): RawTexture | null {
    return this.textures[index] ?? null;
  }

  get hasTextures(): boolean {
    return this.textures.length > 0;
  }

  /** Texel origin of a slot inside the atlas. */
  slotOrigin(slotIndex: number): { readonly u: number; readonly v: number } {
    return terrainSlotOrigin(slotIndex, this.residency.slotCount, this.slotEdge);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
  }
}

// ---------------------------------------------------------------------------
// The indirection tables the shaders read
// ---------------------------------------------------------------------------

/** Floats per slot in each of the two indirection arrays. */
export const TERRAIN_INDIRECTION_STRIDE = 4;

/**
 * `(slotU, slotV, originX, originZ)` and `(texelSize, minH, maxH,
 * maxDeviationFromParent)` per slot, as two `array<vec4f>`s.
 *
 * A CDLOD node passes its slot index as a thin-instance attribute, so the
 * vertex shader needs no indirection FETCH to find its page — these tables
 * exist for the fragment stage and the CPU-tile fallback path, which only
 * know a page key.
 */
export function writeTerrainIndirection(
  atlas: TerrainPageAtlas,
  originX: number,
  originZ: number,
  addressing: Float32Array,
  bounds: Float32Array,
): void {
  addressing.fill(0);
  bounds.fill(0);
  for (const slot of atlas.residency.entries) {
    if (slot.lifecycle.state !== "resident") continue;
    const texel = atlas.slotOrigin(slot.slotIndex);
    const pageBounds = worldPageBounds(slot.address, WORLD_PAGE_BASE_EXTENT_METERS);
    const base = slot.slotIndex * TERRAIN_INDIRECTION_STRIDE;
    addressing[base] = texel.u;
    addressing[base + 1] = texel.v;
    // Camera-relative, like every other world position the shaders see.
    addressing[base + 2] = pageBounds.minX - originX;
    addressing[base + 3] = pageBounds.minZ - originZ;
    bounds[base] = terrainTexelSizeMeters(slot.address.level);
    bounds[base + 1] = slot.stats.minHeightMeters;
    bounds[base + 2] = slot.stats.maxHeightMeters;
    bounds[base + 3] = slot.stats.maxDeviationFromParent;
  }
}

/** The two slot keys a page needs resident for a season-keyed family. */
export function seasonSlotKeys(
  page: WorldPageKey,
  dayOfYear: number,
): { readonly lo: TerrainSlotKey; readonly hi: TerrainSlotKey; readonly t: number } {
  const blend = seasonBucketBlend(dayOfYear);
  return {
    lo: { page, variant: blend.lo },
    hi: { page, variant: blend.hi },
    t: blend.t,
  };
}

/** The season-invariant slot key for a page (variant 0). */
export function invariantSlotKey(address: WorldPageAddress): TerrainSlotKey {
  return { page: createWorldPageKey(address), variant: 0 };
}

// ---------------------------------------------------------------------------
// `4-3` — GPU height generation
// ---------------------------------------------------------------------------

/**
 * `4.5-B1`: whether a page's texels are FINAL the moment its generation
 * dispatch is submitted.
 *
 * True in the analytic-kernel era: one dispatch writes the whole page and
 * nothing revisits it. `5-4`'s erosion makes a page the output of a multi-pass
 * DAG, and D12's convergence rule is explicit that a slot is never sampled
 * mid-erosion and that publish is the DAG's LAST stage — so this flag exists
 * to make the fast path a deletion rather than an argument when that lands.
 */
const PAGES_ARE_FINAL_AT_DISPATCH = true;

/**
 * Bounds buffers in flight at once (`4.5-B1`).
 *
 * **One buffer is not enough, and the failure is silent.** `generate()` awaits
 * `dispatchWhenReady` before issuing the readback, so the
 * `copyBufferToBuffer` that snapshots the bounds is encoded a MICROTASK later
 * — after `scene.render()` has returned, i.e. into the NEXT frame's command
 * encoder. The next frame's `generate()` has by then already issued
 * `boundsBuffer.update()` to seed the atomics for its own batch, so the copy
 * reads the identities: min `+Infinity`, max `-Infinity`, deviation `0`. A
 * page completes with a deviation of zero, the CDLOD selector reads zero
 * error, and the whole world converges at the root ring with nothing to split.
 * Measured exactly that way: 27 nodes, 9 pages, every slot but one reporting
 * `min = Infinity`.
 *
 * Four is comfortably more than the two-to-three frames a readback takes, and
 * the pump defers rather than reusing a buffer whose read has not landed.
 */
const BOUNDS_BUFFER_RING = 4;

/** Workgroup edge; 264 / 8 = 33 workgroups per slot edge, exactly. */
const PAGE_WORKGROUP_EDGE = 8;
/** The apron the second-difference deviation needs: one texel on every side. */
const PAGE_APRON_EDGE = PAGE_WORKGROUP_EDGE + 2;
/** Three atomics per job: min, max and max second difference. */
export const TERRAIN_PAGE_BOUNDS_SLOTS = 4;

/**
 * The page-generation compute shader.
 *
 * One dispatch resolves a BATCH of pages (`workgroup_id.z` selects the job),
 * because Babylon records a frame's passes into one command encoder and
 * submits once — a `writeBuffer` between per-page dispatches would land before
 * any of them executed and every dispatch would read the last job (§4 D11's
 * hazard, in the generation path rather than the shadow path).
 */
export function terrainPageGenerationWgsl(
  kernelWgsl: string,
  bindingWgsl: string,
  airportWgsl: string,
): string {
  return /* wgsl */ `
${bindingWgsl}
${kernelWgsl}
${airportWgsl}

struct PageJob {
  // (atlas texel u, atlas texel v, world offset of stored texel 0 from the
  //  kernel page origin, same for z)
  placement: vec4f,
  // (texelSize, kernel page index, supersample count, level)
  shape: vec4f,
  // (page origin world x, page origin world z, 0, 0) — the ABSOLUTE origin,
  // needed only by the airport earthworks, which are a local feature. The
  // height kernel itself never sees an absolute coordinate.
  world: vec4f,
};

@group(0) @binding(1) var<storage, read> jobs: array<PageJob>;
@group(0) @binding(2) var heightAtlas: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<storage, read_write> pageBounds: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> supersample: array<vec4f>;
@group(0) @binding(5) var<storage, read> earthworks: RunwayEarthworks;

/**
 * A monotonic u32 encoding of an f32, so atomicMin/atomicMax reduce floats.
 * Positive floats keep their bit order once the sign bit is set; negative ones
 * reverse, so they are complemented.
 */
fn kOrderable(value: f32) -> u32 {
  let bits = bitcast<u32>(value);
  if ((bits & 0x80000000u) != 0u) { return ~bits; }
  return bits | 0x80000000u;
}

var<workgroup> tile: array<f32, ${PAGE_APRON_EDGE * PAGE_APRON_EDGE}>;
var<workgroup> groupMin: atomic<u32>;
var<workgroup> groupMax: atomic<u32>;
var<workgroup> groupDeviation: atomic<u32>;

/**
 * Height at a stored texel of a job's page.
 *
 * **L0 takes exactly one sample and every coarser level takes four.** Measured
 * justification, recorded so nobody re-enables it as a quality improvement:
 * 2x2 supersampling at L0 puts up to 0.98 m between the wheels and the screen
 * (>1 mm at 33.3% of 55,296 texels, >10 mm at 7.0%, >100 mm at 0.43%). The
 * cause is the C0 crease in ridgedFbm2D, so the residual scales LINEARLY with
 * texel size rather than quadratically.
 */
fn pageHeightAt(job: PageJob, localX: f32, localZ: f32) -> f32 {
  let natural = terrainNaturalHeight(localX, localZ);
  // 4-3/4-9: the page stores the AIRPORT-FLATTENED height. The CDLOD min/max
  // AABB has to be correct over the airport, the collision fast path returns
  // the crowned platform, and after 4-4 there is no CPU tile path left to
  // apply the earthworks anywhere else.
  return terrainRunwayEarthworksHeight(
    earthworks,
    natural,
    job.world.x + localX - job.placement.z,
    job.world.y + localZ - job.placement.w,
  );
}

fn samplePageTexel(job: PageJob, texelX: f32, texelZ: f32) -> f32 {
  let texelSize = job.shape.x;
  let baseX = job.placement.z + texelX * texelSize;
  let baseZ = job.placement.w + texelZ * texelSize;
  let count = u32(job.shape.z);
  if (count <= 1u) {
    return pageHeightAt(job, baseX, baseZ);
  }
  var total = 0.0;
  for (var index = 0u; index < count; index = index + 1u) {
    let offset = supersample[index];
    total = total + pageHeightAt(
      job,
      baseX + offset.x * texelSize,
      baseZ + offset.y * texelSize,
    );
  }
  return total / f32(count);
}

@compute @workgroup_size(${PAGE_WORKGROUP_EDGE}, ${PAGE_WORKGROUP_EDGE}, 1)
fn generatePage(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let job = jobs[group.z];
  kSelectPage(u32(job.shape.y));

  if (localIndex == 0u) {
    atomicStore(&groupMin, kOrderable(K_MAX_TERRAIN_HEIGHT));
    atomicStore(&groupMax, kOrderable(K_MIN_TERRAIN_HEIGHT));
    atomicStore(&groupDeviation, kOrderable(0.0));
  }
  workgroupBarrier();

  // The apron ring is one sample per texel: it only feeds the second
  // difference, where supersampling would buy nothing.
  let apronOriginX = f32(group.x * ${PAGE_WORKGROUP_EDGE}u) - 1.0;
  let apronOriginZ = f32(group.y * ${PAGE_WORKGROUP_EDGE}u) - 1.0;
  let apronCount = ${PAGE_APRON_EDGE * PAGE_APRON_EDGE}u;
  var cursor = localIndex;
  loop {
    if (cursor >= apronCount) { break; }
    let localX = f32(cursor % ${PAGE_APRON_EDGE}u);
    let localZ = f32(cursor / ${PAGE_APRON_EDGE}u);
    let interior = localX >= 1.0 && localX <= ${PAGE_WORKGROUP_EDGE}.0
      && localZ >= 1.0 && localZ <= ${PAGE_WORKGROUP_EDGE}.0;
    let texelX = apronOriginX + localX;
    let texelZ = apronOriginZ + localZ;
    if (interior) {
      tile[cursor] = samplePageTexel(job, texelX, texelZ);
    } else {
      tile[cursor] = pageHeightAt(
        job,
        job.placement.z + texelX * job.shape.x,
        job.placement.w + texelZ * job.shape.x,
      );
    }
    cursor = cursor + ${PAGE_WORKGROUP_EDGE * PAGE_WORKGROUP_EDGE}u;
  }
  workgroupBarrier();

  let local = vec2u(localIndex % ${PAGE_WORKGROUP_EDGE}u, localIndex / ${PAGE_WORKGROUP_EDGE}u);
  let centre = (local.y + 1u) * ${PAGE_APRON_EDGE}u + (local.x + 1u);
  let height = tile[centre];

  textureStore(
    heightAtlas,
    vec2i(i32(job.placement.x) + i32(id.x), i32(job.placement.y) + i32(id.y)),
    vec4f(height, 0.0, 0.0, 0.0),
  );

  // maxDeviationFromParent, as the largest SECOND DIFFERENCE over the page.
  // That is exactly the vertical error a parent's half-rate sampling makes at
  // this texel, which is the numerator CDLOD's screen-space error needs — and
  // it costs an apron rather than a second full kernel evaluation at the
  // parent's filter width.
  let dx = abs(height - 0.5 * (tile[centre - 1u] + tile[centre + 1u]));
  let dz = abs(height
    - 0.5 * (tile[centre - ${PAGE_APRON_EDGE}u] + tile[centre + ${PAGE_APRON_EDGE}u]));
  atomicMin(&groupMin, kOrderable(height));
  atomicMax(&groupMax, kOrderable(height));
  atomicMax(&groupDeviation, kOrderable(max(dx, dz)));
  workgroupBarrier();

  if (localIndex == 0u) {
    let base = group.z * ${TERRAIN_PAGE_BOUNDS_SLOTS}u;
    atomicMin(&pageBounds[base], atomicLoad(&groupMin));
    atomicMax(&pageBounds[base + 1u], atomicLoad(&groupMax));
    atomicMax(&pageBounds[base + 2u], atomicLoad(&groupDeviation));
  }
}
`;
}

/**
 * `4.5-B2(a)` — consume a resolved GPU timing sample for a batched dispatch,
 * ONCE, and price it per dispatch.
 *
 * Two properties the call sites must not re-derive:
 *
 * - **Divide by the batch size.** Babylon's counter times the whole batched
 *   dispatch (`workgroup_id.z` selects the job) and the meter prices per page.
 * - **Consume each result once.** WebGPU timestamp readback is asynchronous;
 *   `counter.current` holds its value until another query resolves, so a
 *   per-frame poll without the count check feeds the same measurement into
 *   the smoother over and over and pins the estimate to one batch.
 *
 * `null` when the adapter has no `timestamp-query`, when no dispatch has run,
 * or when the last sample has already been consumed.
 */
export interface GpuDispatchCostSampler {
  readonly gpuTimeInFrame?: { readonly counter: { readonly count: number; readonly current: number } };
}

/**
 * `4.5-C3`: the raw per-frame GPU milliseconds this shader's counter is
 * holding, WITHOUT consuming it. An uncorrelated aggregate — the counter
 * carries no frame id, so it is a distribution reading, never an attribution
 * of this frame's interval.
 */
export function readGpuDispatchMs(sampler: GpuDispatchCostSampler | null): number | null {
  const counter = sampler?.gpuTimeInFrame?.counter;
  if (!counter) return null;
  const milliseconds = counter.current / 1_000_000;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function consumeGpuDispatchCostMs(
  sampler: GpuDispatchCostSampler | null,
  batchSize: number,
  lastConsumedCount: number,
): { readonly milliseconds: number | null; readonly sampleCount: number } {
  const counter = sampler?.gpuTimeInFrame?.counter;
  if (!counter || batchSize <= 0) return { milliseconds: null, sampleCount: lastConsumedCount };
  if (counter.count === lastConsumedCount) {
    return { milliseconds: null, sampleCount: lastConsumedCount };
  }
  const milliseconds = counter.current / 1_000_000 / batchSize;
  return {
    milliseconds: Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null,
    sampleCount: counter.count,
  };
}

/** Inverse of the shader's monotonic float encoding. */
export function decodeOrderableFloat(order: number): number {
  const view = new DataView(new ArrayBuffer(4));
  const bits = (order & 0x8000_0000) !== 0 ? order & 0x7fff_ffff : ~order >>> 0;
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
}

/** The identity the shader's atomics reduce against. */
export function encodeOrderableFloat(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  const bits = view.getUint32(0, true);
  return ((bits & 0x8000_0000) !== 0 ? ~bits : bits | 0x8000_0000) >>> 0;
}

export const TERRAIN_PAGE_WORKGROUPS_PER_SLOT_EDGE =
  TERRAIN_HEIGHT_SLOT_EDGE / PAGE_WORKGROUP_EDGE;

/**
 * The host half of `4-3`: one `ComputeShader` created ONCE, with the page
 * uniforms and the job table rebound per batch.
 *
 * Admission goes through `ComputeBudget` (`4-0b`), so a banked turn that wants
 * forty pages at once spends one millisecond cap rather than three.
 */
export class TerrainPageGenerator {
  private shader: ComputeShader | null = null;
  private jobBuffer: StorageBuffer | null = null;
  private pageBuffer: StorageBuffer | null = null;
  private boundsRing: StorageBuffer[] = [];
  private boundsRingIndex = 0;
  private offsetBuffer: StorageBuffer | null = null;
  private earthworksBuffer: StorageBuffer | null = null;
  private capacity = 0;
  private inFlight: readonly TerrainAtlasSlot[] = [];
  private readbacksInFlight = 0;
  private readonly pendingReadbacks = new Set<Promise<void>>();
  private disposed = false;
  private lastBatchSize = 0;
  private lastCostSampleCount = -1;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly atlas: TerrainPageAtlas,
    private readonly seedHash: number,
    private readonly airport: Readonly<AirportDefinition> | null = null,
  ) {}

  get dispatchesInFlight(): number {
    return this.inFlight.length + this.readbacksInFlight;
  }

  /** `4.5-B2(a)`: the measured per-page cost of the last resolved batch. */
  consumeMeasuredDispatchCostMs(): number | null {
    const sample = consumeGpuDispatchCostMs(this.shader, this.lastBatchSize, this.lastCostSampleCount);
    this.lastCostSampleCount = sample.sampleCount;
    return sample.milliseconds;
  }

  /** `4.5-C3`: this shader's whole-dispatch GPU time, unconsumed. */
  gpuMillisecondsInFrame(): number | null {
    return readGpuDispatchMs(this.shader);
  }

  /**
   * Generate a batch of admitted pages in ONE dispatch, then complete them
   * from the bounds readback.
   *
   * The page becomes resident only when its readback resolves, which is what
   * exercises the asynchronous half of `WorldPageLifecycle` for real: a page
   * whose slot is re-admitted meanwhile is rejected on its epoch instead of
   * writing bounds into a slot that now holds a different page.
   */
  async generate(slots: readonly TerrainAtlasSlot[]): Promise<void> {
    if (this.disposed || slots.length === 0 || !this.atlas.hasTextures) return;
    // Never overwrite a bounds buffer whose read has not landed: that is what
    // silently completes a page at zero deviation. See BOUNDS_BUFFER_RING.
    if (this.readbacksInFlight >= BOUNDS_BUFFER_RING) return;
    this.ensureCapacity(slots.length);
    const shader = this.shader;
    const jobBuffer = this.jobBuffer;
    const pageBuffer = this.pageBuffer;
    const boundsBuffer = this.boundsRing[this.boundsRingIndex];
    if (!shader || !jobBuffer || !pageBuffer || !boundsBuffer) return;
    this.boundsRingIndex = (this.boundsRingIndex + 1) % BOUNDS_BUFFER_RING;

    const jobs = new Float32Array(slots.length * 12);
    const pages = new Uint8Array(slots.length * TERRAIN_KERNEL_PAGE_BYTES);
    const bounds = new Uint32Array(slots.length * TERRAIN_PAGE_BOUNDS_SLOTS);
    slots.forEach((slot, index) => {
      const level = slot.address.level;
      const texelSize = terrainTexelSizeMeters(level);
      const pageBounds = worldPageBounds(slot.address, WORLD_PAGE_BASE_EXTENT_METERS);
      const texel = this.atlas.slotOrigin(slot.slotIndex);
      const gutterOffset = -WORLD_PAGE_GUTTER * texelSize;
      jobs[index * 12] = texel.u;
      jobs[index * 12 + 1] = texel.v;
      jobs[index * 12 + 2] = gutterOffset;
      jobs[index * 12 + 3] = gutterOffset;
      jobs[index * 12 + 4] = texelSize;
      jobs[index * 12 + 5] = index;
      jobs[index * 12 + 6] = terrainSupersampleOffsets(level).length;
      jobs[index * 12 + 7] = level;
      jobs[index * 12 + 8] = pageBounds.minX;
      jobs[index * 12 + 9] = pageBounds.minZ;
      pages.set(
        new Uint8Array(buildTerrainKernelPageUniform({
          seedHash: this.seedHash,
          originX: pageBounds.minX,
          originZ: pageBounds.minZ,
          filterWidthMeters: terrainPageFilterWidthMeters(level),
        })),
        index * TERRAIN_KERNEL_PAGE_BYTES,
      );
      // atomicMin/atomicMax reduce against these identities.
      bounds[index * TERRAIN_PAGE_BOUNDS_SLOTS] = encodeOrderableFloat(Number.POSITIVE_INFINITY);
      bounds[index * TERRAIN_PAGE_BOUNDS_SLOTS + 1] =
        encodeOrderableFloat(Number.NEGATIVE_INFINITY);
      bounds[index * TERRAIN_PAGE_BOUNDS_SLOTS + 2] = encodeOrderableFloat(0);
    });

    jobBuffer.update(new Uint8Array(jobs.buffer));
    pageBuffer.update(pages);
    boundsBuffer.update(new Uint8Array(bounds.buffer));
    // Rebind: the ring hands each in-flight batch its own buffer, and the
    // bind group is recorded per dispatch, so this cannot disturb a batch
    // already encoded.
    shader.setStorageBuffer("pageBounds", boundsBuffer);
    this.inFlight = slots;
    this.lastBatchSize = slots.length;
    try {
      await shader.dispatchWhenReady(
        TERRAIN_PAGE_WORKGROUPS_PER_SLOT_EDGE,
        TERRAIN_PAGE_WORKGROUPS_PER_SLOT_EDGE,
        slots.length,
      );
    } finally {
      this.inFlight = [];
    }

    // ---------------------------------------------------------------------
    // `4.5-B1` — publish the TEXELS now; let the stats arrive a round-trip
    // later.
    //
    // This method used to await the bounds readback before anything became
    // drawable, so a page's arrival cost a full GPU round-trip on top of its
    // dispatch and the NEXT batch could not start until it landed. The vertex
    // shader needs only texels, which the dispatch just wrote; the CDLOD split
    // needs the deviation, and the never-split-unmeasured rule already
    // tolerates it arriving late.
    //
    // **This fast path is analytic-era only.** It is legal exactly while a
    // page is FINAL at dispatch. `5-4`/D12's convergence rule says a slot is
    // never sampled mid-erosion and that publish is the DAG's last stage — so
    // when erosion lands, `PAGES_ARE_FINAL_AT_DISPATCH` goes false and this
    // branch is DELETED rather than fought.
    // ---------------------------------------------------------------------
    if (PAGES_ARE_FINAL_AT_DISPATCH) {
      for (const slot of slots) {
        if (slot.token) this.atlas.residency.publishTexels(slot.key, slot.token);
      }
    }
    // NOT awaited: this batch is drawable now, and the next batch must not
    // wait a round-trip for numbers only the CDLOD split reads. The copy into
    // the readback staging buffer is encoded at THIS point in the frame's
    // command encoder, so a later `update()` of the bounds buffer cannot
    // overwrite what is being read.
    const readback = this.collectBounds(boundsBuffer, slots);
    this.pendingReadbacks.add(readback);
    void readback.finally(() => this.pendingReadbacks.delete(readback));
  }

  /**
   * Resolve once every readback issued so far has landed.
   *
   * The renderer never waits for this — that is the whole point of `4.5-B1`.
   * It exists so tests and headless tools can observe the SECOND stage of a
   * page's arrival (its bounds and deviation) without polling.
   */
  async settle(): Promise<void> {
    while (this.pendingReadbacks.size > 0) {
      await Promise.all([...this.pendingReadbacks]);
    }
  }

  /**
   * Resolve a submitted batch's bounds and deviation, a round-trip later.
   *
   * A failed readback completes the slots at ZERO stats rather than leaving
   * them `generating` forever: a page with no measurement is drawn coarse and
   * never split, which is exactly the never-split-unmeasured rule, whereas a
   * stuck `generating` slot is un-evictable and would be re-dispatched every
   * frame.
   */
  private async collectBounds(
    boundsBuffer: StorageBuffer,
    slots: readonly TerrainAtlasSlot[],
  ): Promise<void> {
    this.readbacksInFlight += 1;
    const byteLength = slots.length * TERRAIN_PAGE_BOUNDS_SLOTS * 4;
    try {
      const view = await boundsBuffer.read(0, byteLength);
      if (this.disposed) return;
      const read = new Uint32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + byteLength),
      );
      slots.forEach((slot, index) => {
        if (!slot.token) return;
        const base = index * TERRAIN_PAGE_BOUNDS_SLOTS;
        this.atlas.residency.complete(slot.key, slot.token, {
          minHeightMeters: decodeOrderableFloat(read[base]!),
          maxHeightMeters: decodeOrderableFloat(read[base + 1]!),
          maxDeviationFromParent: decodeOrderableFloat(read[base + 2]!),
        });
      });
    } catch {
      for (const slot of slots) {
        if (slot.token) this.atlas.residency.complete(slot.key, slot.token, UNKNOWN_STATS);
      }
    } finally {
      this.readbacksInFlight -= 1;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobBuffer?.dispose();
    this.pageBuffer?.dispose();
    for (const buffer of this.boundsRing) buffer.dispose();
    this.boundsRing = [];
    this.offsetBuffer?.dispose();
    this.earthworksBuffer?.dispose();
    this.earthworksBuffer = null;
    this.jobBuffer = null;
    this.pageBuffer = null;
    this.offsetBuffer = null;
    this.shader = null;
  }

  private ensureCapacity(count: number): void {
    if (count <= this.capacity && this.shader) return;
    this.jobBuffer?.dispose();
    this.pageBuffer?.dispose();
    for (const buffer of this.boundsRing) buffer.dispose();
    this.capacity = Math.max(count, 8);
    const engine = this.engine as WebGPUEngine;
    this.jobBuffer = new StorageBuffer(engine, this.capacity * 12 * 4);
    this.pageBuffer = new StorageBuffer(engine, this.capacity * TERRAIN_KERNEL_PAGE_BYTES);
    // Default creation flags (READWRITE): passing STORAGE|READ drops WRITE,
    // and then `update()` silently does nothing — the atomics reduce against a
    // zeroed buffer, whose min slot decodes to NaN. Found by measurement.
    this.boundsRing = [];
    for (let index = 0; index < BOUNDS_BUFFER_RING; index += 1) {
      this.boundsRing.push(new StorageBuffer(
        engine,
        this.capacity * TERRAIN_PAGE_BOUNDS_SLOTS * 4,
      ));
    }
    this.boundsRingIndex = 0;
    if (!this.offsetBuffer) {
      const offsets = new Float32Array(TERRAIN_SUPERSAMPLE_OFFSETS.length * 4);
      TERRAIN_SUPERSAMPLE_OFFSETS.forEach(([x, z], index) => {
        offsets[index * 4] = x;
        offsets[index * 4 + 1] = z;
      });
      this.offsetBuffer = new StorageBuffer(engine, offsets.byteLength);
      this.offsetBuffer.update(new Uint8Array(offsets.buffer));
    }
    // Created ONCE with uniforms rebound per batch, per 4-3: a ComputeShader
    // per page would recompile the pipeline on every admission.
    this.shader ??= new ComputeShader(
      "terrain-page-generate",
      this.engine,
      {
        computeSource: terrainPageGenerationWgsl(
          TERRAIN_KERNEL_WGSL,
          terrainKernelPageBindingWgsl(0, 0),
          `${RUNWAY_SDF_WGSL}\n${RUNWAY_EARTHWORKS_WGSL}`,
        ),
      },
      {
        entryPoint: "generatePage",
        bindingsMapping: {
          terrainKernelPages: { group: 0, binding: 0 },
          jobs: { group: 0, binding: 1 },
          heightAtlas: { group: 0, binding: 2 },
          pageBounds: { group: 0, binding: 3 },
          supersample: { group: 0, binding: 4 },
          earthworks: { group: 0, binding: 5 },
        },
      },
    );
    const texture = this.atlas.texture();
    if (texture) this.shader.setStorageTexture("heightAtlas", texture);
    this.shader.setStorageBuffer("terrainKernelPages", this.pageBuffer);
    this.shader.setStorageBuffer("jobs", this.jobBuffer);
    this.shader.setStorageBuffer("pageBounds", this.boundsRing[0]!);
    this.shader.setStorageBuffer("supersample", this.offsetBuffer);
    this.earthworksBuffer ??= new StorageBuffer(engine, RUNWAY_EARTHWORKS_UNIFORM_FLOATS * 4);
    this.earthworksBuffer.update(new Uint8Array(
      packRunwayEarthworksUniform(this.airport, this.seedHash).buffer,
    ));
    this.shader.setStorageBuffer("earthworks", this.earthworksBuffer);
  }
}
