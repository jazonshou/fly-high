import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import type { AirportDefinition, WorldDefinition } from "@/src/world/types";
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
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
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
import type { TerrainMacroEvolutionExport } from "./TerrainEvolutionContract";
import {
  TerrainPageErosionClient,
  type TerrainPageErosionExecutor,
} from "./TerrainPageErosionClient";
import type { TerrainErodedPage } from "./TerrainPageErosion";
import type {
  TerrainPageHydrologyResult,
  TerrainPageHydrologyUpload,
} from "./TerrainPageHydrology";
import {
  EROSION_HALO_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
} from "./TerrainErosionCompute";

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
   * Phase 5 DAG bookkeeping. A submitted page stays unavailable to every
   * consumer until all generation stages and readbacks complete; this flag
   * only prevents the scheduler from submitting the same token twice.
   */
  generationSubmitted: boolean;
  /** True once every required Phase-5 auxiliary texture has been uploaded. */
  hydrologyReady: boolean;
  /** Prevents duplicate worker requests while a late channel slot catches up. */
  hydrologySubmitted: boolean;
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
  /** Eroded channel slots cannot publish until all four aux fields exist. */
  readonly requireHydrology?: boolean;
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

  /** The slot a fully converged page lives in, or -1 while its DAG is active. */
  slotIndexOf(key: TerrainSlotKey): number {
    const slot = this.slots.get(terrainSlotKeyString(key));
    return slot?.lifecycle.state === "resident" ? slot.slotIndex : -1;
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
      generationSubmitted: false,
      hydrologyReady: !this.options.requireHydrology,
      hydrologySubmitted: false,
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
    if (slot && this.options.requireHydrology && !slot.hydrologyReady) return false;
    if (!slot || !slot.lifecycle.markGenerated(token)) return false;
    slot.stats = stats;
    slot.token = null;
    slot.generationSubmitted = false;
    return true;
  }

  /**
   * Commit the four aux uploads as one residency prerequisite. The uploader
   * calls this only after every queue write succeeds, so a partial texture set
   * is never addressable through `slotIndexOf`.
   */
  markHydrologyReady(
    key: TerrainSlotKey,
    token: WorldPageOperationToken,
  ): boolean {
    const slot = this.slots.get(terrainSlotKeyString(key));
    if (
      !slot
      || slot.token?.epoch !== token.epoch
      || slot.token.key !== token.key
      || slot.lifecycle.state !== "generating"
    ) return false;
    slot.hydrologyReady = true;
    slot.hydrologySubmitted = false;
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
    slot.generationSubmitted = false;
    slot.hydrologySubmitted = false;
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
        && !slot.generationSubmitted
        && !slot.hydrologySubmitted
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
 * Six rgba8 textures hold the Phase-4 shading families. Phase 5 appends four
 * canonical single-channel aux resources without changing their formats:
 * flow/log-area R16F, lake depth R16F, soil R8 UNORM and shore R16 SINT.
 */
export const TERRAIN_CHANNEL_TEXTURES = Object.freeze({
  occlusion: 0,
  horizonA: 1,
  horizonB: 2,
  splatId: 3,
  splatWeightLo: 4,
  splatWeightHi: 5,
  flowAccum: 6,
  lakeDepth: 7,
  soilDepth: 8,
  shoreDistance: 9,
});

export const TERRAIN_CHANNEL_TEXTURE_COUNT = 10;
export const TERRAIN_CHANNEL_BASE_TEXTURE_COUNT = 6;
/** 6 rgba8 + 2 r16f + 1 r8 + 1 r16sint. */
export const TERRAIN_CHANNEL_BYTES_PER_TEXEL = 31;

export interface TerrainPageAtlasOptions {
  readonly kind: TerrainAtlasKind;
  readonly worldRevision: string;
  /** Textures the family occupies per slot (channel atlas is ten, height is one). */
  readonly textureCount?: number;
  readonly bytesPerTexel?: number;
  /** Gate channel residency on a complete Phase-5 aux upload. */
  readonly requiresHydrology?: boolean;
}

export interface TerrainHydrologyAtlasTextures {
  readonly flowAccum: RawTexture | null;
  readonly lakeDepth: RawTexture | null;
  readonly soilDepth: RawTexture | null;
  readonly shoreDistance: RawTexture | null;
}

/**
 * One page atlas: residency plus the GPU texture(s) it addresses.
 *
 * Height uses r32float; the first six channel families use rgba8unorm storage;
 * the four Phase-5 hydrology resources use their canonical sampled formats.
 * Compute-written resources carry the storage flag because a page is WRITTEN
 * by a dispatch and READ by terrain in the same frame. `R-4B` names the
 * fallback if a driver refuses that combination — a ping-pong pair with a copy,
 * costing one atlas of memory at the tier that needs it.
 */
export class TerrainPageAtlas {
  readonly residency: TerrainAtlasResidency;
  readonly slotEdge: number;
  readonly atlasEdge: number;
  private readonly textures: RawTexture[] = [];
  private readonly engine: AbstractEngine;
  private disposed = false;

  constructor(
    scene: Scene,
    profile: WebGpuQualityProfile,
    private readonly options: TerrainPageAtlasOptions,
  ) {
    this.engine = scene.getEngine();
    const height = options.kind === "height";
    const textureCount = options.textureCount ?? 1;
    this.slotEdge = height ? TERRAIN_HEIGHT_SLOT_EDGE : TERRAIN_CHANNEL_SLOT_EDGE;
    const slots = height ? profile.heightAtlasSlots : profile.channelAtlasSlots;
    this.atlasEdge = terrainAtlasEdgeTexels(slots, this.slotEdge);
    this.residency = new TerrainAtlasResidency(slots, {
      worldRevision: options.worldRevision,
      slotByteLength: this.slotEdge * this.slotEdge * (
        options.bytesPerTexel === undefined
          ? (height
            ? 4
            : textureCount === TERRAIN_CHANNEL_TEXTURE_COUNT
              ? TERRAIN_CHANNEL_BYTES_PER_TEXEL
              : 4 * textureCount)
          : options.bytesPerTexel * textureCount
      ),
      requireHydrology: options.requiresHydrology ?? false,
    });

    // NullEngine cannot express a storage texture at all, and the Node suite
    // runs the whole residency half against it — the same guard the material
    // arrays and the foliage atlas use.
    const engineFlags = scene.getEngine() as { isWebGPU?: boolean };
    if (!engineFlags.isWebGPU) return;
    for (let index = 0; index < textureCount; index += 1) {
      let texture: RawTexture;
      if (height) {
        // CreateRStorageTexture, not CreateRTexture with a creation flag: the
        // storage variant is the one that adds STORAGE_BINDING usage, and the
        // page is written by a compute dispatch and sampled by the terrain
        // material in the same frame.
        texture = RawTexture.CreateRStorageTexture(
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
        );
      } else if (index < TERRAIN_CHANNEL_BASE_TEXTURE_COUNT) {
        texture = RawTexture.CreateRGBAStorageTexture(
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
      } else if (
        index === TERRAIN_CHANNEL_TEXTURES.flowAccum
        || index === TERRAIN_CHANNEL_TEXTURES.lakeDepth
      ) {
        // Aux fields are CPU-uploaded and sampled, never compute-written. A
        // non-storage R texture avoids requiring optional storage-format
        // features for r16float while preserving the exact atlas schema.
        texture = RawTexture.CreateRTexture(
          null,
          this.atlasEdge,
          this.atlasEdge,
          scene,
          false,
          false,
          Texture.NEAREST_SAMPLINGMODE,
          Constants.TEXTURETYPE_HALF_FLOAT,
        );
      } else if (index === TERRAIN_CHANNEL_TEXTURES.soilDepth) {
        texture = RawTexture.CreateRTexture(
          null,
          this.atlasEdge,
          this.atlasEdge,
          scene,
          false,
          false,
          Texture.NEAREST_SAMPLINGMODE,
          Constants.TEXTURETYPE_UNSIGNED_BYTE,
        );
      } else if (index === TERRAIN_CHANNEL_TEXTURES.shoreDistance) {
        texture = new RawTexture(
          null,
          this.atlasEdge,
          this.atlasEdge,
          Constants.TEXTUREFORMAT_RED_INTEGER,
          scene,
          false,
          false,
          Texture.NEAREST_SAMPLINGMODE,
          Constants.TEXTURETYPE_SHORT,
        );
      } else {
        throw new RangeError(`Unknown terrain channel texture index ${index}`);
      }
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

  get requiresHydrology(): boolean {
    return this.options.requiresHydrology ?? false;
  }

  /** Typed access to the four canonical aux resources for downstream systems. */
  hydrologyTextures(): TerrainHydrologyAtlasTextures {
    return {
      flowAccum: this.texture(TERRAIN_CHANNEL_TEXTURES.flowAccum),
      lakeDepth: this.texture(TERRAIN_CHANNEL_TEXTURES.lakeDepth),
      soilDepth: this.texture(TERRAIN_CHANNEL_TEXTURES.soilDepth),
      shoreDistance: this.texture(TERRAIN_CHANNEL_TEXTURES.shoreDistance),
    };
  }

  /**
   * Upload all four aux resources and only then satisfy the residency gate.
   * Queue writes may have landed when a later write throws, but the slot stays
   * generating and therefore remains invisible to every atlas consumer.
   */
  uploadHydrology(
    slot: TerrainAtlasSlot,
    token: WorldPageOperationToken,
    page: TerrainPageHydrologyResult,
  ): boolean {
    if (this.disposed || this.kind !== "channel" || !this.requiresHydrology) return false;
    if (
      slot.token?.epoch !== token.epoch
      || slot.token.key !== token.key
      || this.residency.get(slot.key) !== slot
      || page.address.level !== slot.address.level
      || page.address.x !== slot.address.x
      || page.address.z !== slot.address.z
      || page.coreSize !== WORLD_PAGE_CHANNEL_CORE
      || page.gutter !== WORLD_PAGE_GUTTER
      || page.storedEdge !== TERRAIN_CHANNEL_SLOT_EDGE
    ) return false;
    const expected = TERRAIN_CHANNEL_SLOT_EDGE * TERRAIN_CHANNEL_SLOT_EDGE;
    const uploads: readonly [number, ArrayBufferView][] = [
      [TERRAIN_CHANNEL_TEXTURES.flowAccum, page.upload.flowAccumR16Float],
      [TERRAIN_CHANNEL_TEXTURES.lakeDepth, page.upload.lakeDepthR16Float],
      [TERRAIN_CHANNEL_TEXTURES.soilDepth, page.upload.soilDepthR8Unorm],
      [TERRAIN_CHANNEL_TEXTURES.shoreDistance, page.upload.shoreDistanceR16Sint],
    ];
    if (!this.hasTextures || uploads.some(([, values]) => values.byteLength === 0)) return false;
    const lengths: readonly [keyof TerrainPageHydrologyUpload, number][] = [
      ["flowAccumR16Float", page.upload.flowAccumR16Float.length],
      ["lakeDepthR16Float", page.upload.lakeDepthR16Float.length],
      ["soilDepthR8Unorm", page.upload.soilDepthR8Unorm.length],
      ["shoreDistanceR16Sint", page.upload.shoreDistanceR16Sint.length],
    ];
    for (const [name, length] of lengths) {
      if (length !== expected) throw new RangeError(`Terrain hydrology ${name} length mismatch`);
    }
    const origin = this.slotOrigin(slot.slotIndex);
    for (const [index, values] of uploads) {
      const internalTexture = this.texture(index)?.getInternalTexture();
      if (!internalTexture) throw new Error(`Terrain hydrology atlas texture ${index} is unavailable`);
      (this.engine as WebGPUEngine).updateTextureData(
        internalTexture,
        values,
        origin.u,
        origin.v,
        TERRAIN_CHANNEL_SLOT_EDGE,
        TERRAIN_CHANNEL_SLOT_EDGE,
        0,
        0,
        false,
      );
    }
    return this.residency.markHydrologyReady(slot.key, token);
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

export interface TerrainCollisionPagePublication {
  readonly level: 0;
  readonly tileX: number;
  readonly tileZ: number;
  /** Ownership passes to the sink; a Worker sender may transfer the buffer. */
  readonly heights: Float32Array;
}

export type TerrainCollisionPagePublisher = (
  page: TerrainCollisionPagePublication,
) => void;

/** Final render/detail aux product; deliberately separate from simulation. */
export interface TerrainAuxPagePublication {
  readonly level: number;
  readonly tileX: number;
  readonly tileZ: number;
  readonly coreSize: typeof WORLD_PAGE_CHANNEL_CORE;
  readonly gutter: typeof WORLD_PAGE_GUTTER;
  readonly storedEdge: typeof TERRAIN_CHANNEL_SLOT_EDGE;
  readonly texelSizeMeters: number;
  readonly shoreDistanceMetersPerUnit: number;
  /** Row-major core+gutter; ownership passes to the sink for worker transfer. */
  readonly shoreDistanceR16Sint: Int16Array;
}

export type TerrainAuxPagePublisher = (page: TerrainAuxPagePublication) => void;

export interface TerrainPageGeneratorOptions {
  /** Required for the activated eroded authority; omitted preserves analytic compatibility. */
  readonly world?: Readonly<WorldDefinition>;
  /** Owned by the generator after construction. */
  readonly erosionExecutor?: TerrainPageErosionExecutor;
  /** Shared channel atlas receiving the worker's upload-native aux fields. */
  readonly channelAtlas?: TerrainPageAtlas;
}

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
  private collisionPagePublisher: TerrainCollisionPagePublisher | null = null;
  private auxPagePublisher: TerrainAuxPagePublisher | null = null;
  private readonly world: Readonly<WorldDefinition> | null;
  private readonly erosionExecutor: TerrainPageErosionExecutor | null;
  private readonly channelAtlas: TerrainPageAtlas | null;
  private macroEvolution: Readonly<TerrainMacroEvolutionExport> | null = null;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly atlas: TerrainPageAtlas,
    private readonly seedHash: number,
    private readonly airport: Readonly<AirportDefinition> | null = null,
    options: TerrainPageGeneratorOptions = {},
  ) {
    this.world = options.world ?? null;
    if (this.world && this.world.seedHash !== seedHash) {
      throw new RangeError("Terrain page generator world does not match its seed hash");
    }
    this.erosionExecutor = this.world?.worldEvolution === "eroded"
      ? options.erosionExecutor ?? new TerrainPageErosionClient(this.world)
      : null;
    this.channelAtlas = options.channelAtlas ?? null;
    if (this.channelAtlas && this.channelAtlas.kind !== "channel") {
      throw new RangeError("Terrain page generator aux target must be a channel atlas");
    }
  }

  /** Attach the simulation worker sink after renderer and worker construction. */
  setCollisionPagePublisher(publisher: TerrainCollisionPagePublisher | null): void {
    this.collisionPagePublisher = publisher;
  }

  /** Attach the render/detail aux sink; these bytes never enter simulation. */
  setAuxPagePublisher(publisher: TerrainAuxPagePublisher | null): void {
    this.auxPagePublisher = publisher;
  }

  /** Install the eager canonical macro authority before eroded pages schedule. */
  setMacroEvolution(macro: Readonly<TerrainMacroEvolutionExport> | null): void {
    if (macro && this.world && macro.provenance.worldSeed !== this.world.seed) {
      throw new RangeError("Terrain macro evolution belongs to a different world");
    }
    this.macroEvolution = macro;
    this.erosionExecutor?.setMacroEvolution(macro);
  }

  get isReadyForGeneration(): boolean {
    return this.world?.worldEvolution !== "eroded" || this.macroEvolution !== null;
  }

  get dispatchesInFlight(): number {
    return this.inFlight.length + this.readbacksInFlight;
  }

  /**
   * Fill aux fields for channel slots admitted after their height page. The
   * normal path uploads them from the original erosion result; this recovery
   * path recomputes rather than retaining a forbidden second page cache.
   */
  async ensureHydrology(slots: readonly TerrainAtlasSlot[]): Promise<void> {
    if (this.disposed || this.world?.worldEvolution !== "eroded") return;
    const executor = this.erosionExecutor;
    const atlas = this.channelAtlas;
    if (!executor || !atlas || !this.macroEvolution) {
      throw new Error("Terrain hydrology requires the eroded page authority");
    }
    for (const slot of slots) {
      const token = slot.token;
      if (!token || slot.hydrologyReady || slot.hydrologySubmitted) continue;
      slot.hydrologySubmitted = true;
      try {
        const page = await executor.generate(slot.address);
        if (!this.uploadHydrologyForSlot(atlas, slot, token, page, true)) {
          if (atlas.residency.get(slot.key) === slot && slot.token === token) {
            throw new Error("Terrain hydrology upload was rejected");
          }
        }
      } finally {
        if (!slot.hydrologyReady) slot.hydrologySubmitted = false;
      }
    }
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
    if (this.world?.worldEvolution === "eroded") {
      if (!this.macroEvolution || !this.erosionExecutor) return;
      // One worker executes these heavy deterministic passes serially. Do not
      // fill its message queue with stale flight-path decisions; wait for the
      // active page, then let the clipmap re-rank the remaining candidates.
      if (this.readbacksInFlight === 0) this.generateEroded(slots.slice(0, 1));
      return;
    }
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
    for (const slot of slots) slot.generationSubmitted = true;
    try {
      await shader.dispatchWhenReady(
        TERRAIN_PAGE_WORKGROUPS_PER_SLOT_EDGE,
        TERRAIN_PAGE_WORKGROUPS_PER_SLOT_EDGE,
        slots.length,
      );
    } finally {
      this.inFlight = [];
    }

    // NOT awaited: the next batch may dispatch against a different readback
    // ring entry. Unlike the analytic-era fast path, however, this page is not
    // sampleable until collectBounds completes the final publication stage.
    const readback = this.collectBounds(boundsBuffer, slots);
    this.pendingReadbacks.add(readback);
    void readback.finally(() => this.pendingReadbacks.delete(readback));
  }

  /** Queue worker reference passes; each finalizes independently on return. */
  private generateEroded(slots: readonly TerrainAtlasSlot[]): void {
    const executor = this.erosionExecutor;
    if (!executor) return;
    this.lastBatchSize = 0;
    for (const slot of slots) {
      const token = slot.token;
      if (!token || slot.generationSubmitted) continue;
      slot.generationSubmitted = true;
      this.readbacksInFlight += 1;
      const finalization = executor.generate(slot.address)
        .then(async (page) => this.uploadErodedPage(slot, token, page))
        .catch((error: unknown) => {
          if (this.disposed || slot.token !== token) return;
          this.atlas.residency.fail(
            slot.key,
            token,
            error instanceof Error ? error.message : "terrain erosion failed",
          );
        })
        .finally(() => {
          this.readbacksInFlight -= 1;
        });
      this.pendingReadbacks.add(finalization);
      void finalization.finally(() => this.pendingReadbacks.delete(finalization));
    }
  }

  /** Upload transferred final bytes, then reuse the existing L0 readback gate. */
  private async uploadErodedPage(
    slot: TerrainAtlasSlot,
    token: WorldPageOperationToken,
    page: TerrainErodedPage,
  ): Promise<void> {
    if (
      this.disposed
      || slot.token !== token
      || this.atlas.residency.get(slot.key) !== slot
    ) return;
    if (
      page.address.level !== slot.address.level
      || page.address.x !== slot.address.x
      || page.address.z !== slot.address.z
      || page.coreSize !== WORLD_PAGE_HEIGHT_CORE
      || page.haloTexels !== EROSION_HALO_TEXELS
      || page.scratchEdge !== EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS
      || page.storedEdge !== TERRAIN_HEIGHT_SLOT_EDGE
      || page.storedHeight.length !== TERRAIN_HEIGHT_SLOT_EDGE * TERRAIN_HEIGHT_SLOT_EDGE
    ) {
      throw new RangeError("Terrain erosion worker returned incompatible page geometry");
    }
    const texture = this.atlas.texture();
    const internalTexture = texture?.getInternalTexture();
    if (!texture || !internalTexture) throw new Error("Terrain height atlas texture is unavailable");
    const origin = this.atlas.slotOrigin(slot.slotIndex);
    (this.engine as WebGPUEngine).updateTextureData(
      internalTexture,
      page.storedHeight,
      origin.u,
      origin.v,
      TERRAIN_HEIGHT_SLOT_EDGE,
      TERRAIN_HEIGHT_SLOT_EDGE,
      0,
      0,
      false,
    );
    const channelAtlas = this.channelAtlas;
    let hydrologyUploaded = false;
    if (channelAtlas) {
      const channelSlot = channelAtlas.residency.get(invariantSlotKey(page.address));
      const channelToken = channelSlot?.token;
      if (channelSlot && channelToken) {
        hydrologyUploaded = this.uploadHydrologyForSlot(
          channelAtlas,
          channelSlot,
          channelToken,
          page,
          false,
        );
        if (!hydrologyUploaded) {
          throw new Error("Terrain erosion result did not complete its aux upload");
        }
      }
    }
    // publishCompletedSlot performs the final texture readback for L0 when a
    // collision sink is connected, and changes residency only afterwards.
    await this.publishCompletedSlot(slot, page.stats);
    if (hydrologyUploaded && slot.lifecycle.state === "resident") this.publishAuxPage(page);
  }

  private uploadHydrologyForSlot(
    atlas: TerrainPageAtlas,
    slot: TerrainAtlasSlot,
    token: WorldPageOperationToken,
    page: TerrainErodedPage,
    publishImmediately: boolean,
  ): boolean {
    const hydrology = page.hydrology;
    if (!hydrology) throw new Error("Terrain erosion result has no hydrology product");
    if (
      page.address.level !== slot.address.level
      || page.address.x !== slot.address.x
      || page.address.z !== slot.address.z
    ) throw new RangeError("Terrain hydrology result belongs to a different page");
    const uploaded = atlas.uploadHydrology(slot, token, hydrology);
    if (uploaded && publishImmediately) {
      if (this.atlas.residency.slotIndexOf(slot.key) < 0) {
        throw new Error("Terrain aux publication requires resident final height");
      }
      this.publishAuxPage(page);
    }
    return uploaded;
  }

  private publishAuxPage(page: TerrainErodedPage): void {
    const hydrology = page.hydrology;
    if (!hydrology) return;
    this.auxPagePublisher?.({
      level: page.address.level,
      tileX: page.address.x,
      tileZ: page.address.z,
      coreSize: WORLD_PAGE_CHANNEL_CORE,
      gutter: WORLD_PAGE_GUTTER,
      storedEdge: TERRAIN_CHANNEL_SLOT_EDGE,
      texelSizeMeters: hydrology.texelSizeMeters,
      shoreDistanceMetersPerUnit: hydrology.hydrology.shoreDistanceMetersPerUnit,
      shoreDistanceR16Sint: hydrology.upload.shoreDistanceR16Sint,
    });
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
      const publications: Promise<void>[] = [];
      slots.forEach((slot, index) => {
        if (!slot.token) return;
        const base = index * TERRAIN_PAGE_BOUNDS_SLOTS;
        const stats = {
          minHeightMeters: decodeOrderableFloat(read[base]!),
          maxHeightMeters: decodeOrderableFloat(read[base + 1]!),
          maxDeviationFromParent: decodeOrderableFloat(read[base + 2]!),
        };
        publications.push(this.publishCompletedSlot(slot, stats));
      });
      await Promise.all(publications);
    } catch {
      for (const slot of slots) {
        if (!slot.token) continue;
        if (this.collisionPagePublisher && slot.address.level === 0) {
          this.atlas.residency.fail(slot.key, slot.token, "collision readback failed");
        } else {
          this.atlas.residency.complete(slot.key, slot.token, UNKNOWN_STATS);
        }
      }
    } finally {
      this.readbacksInFlight -= 1;
    }
  }

  /**
   * Final DAG publication. L0 bytes are copied before residency changes so
   * simulation and rendering cannot observe different versions of a slot.
   */
  private async publishCompletedSlot(
    slot: TerrainAtlasSlot,
    stats: TerrainSlotStats,
  ): Promise<void> {
    const token = slot.token;
    if (!token) return;
    const publisher = this.collisionPagePublisher;
    if (publisher && slot.address.level === 0) {
      const texture = this.atlas.texture();
      if (!texture) return;
      const origin = this.atlas.slotOrigin(slot.slotIndex);
      const heights = new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE);
      const pixels = await texture.readPixels(
        0,
        0,
        heights,
        false,
        true,
        origin.u + WORLD_PAGE_GUTTER,
        origin.v + WORLD_PAGE_GUTTER,
        WORLD_PAGE_HEIGHT_CORE,
        WORLD_PAGE_HEIGHT_CORE,
      );
      if (!pixels) throw new Error("Collision height readback returned no data");
      if (this.disposed || slot.token !== token) return;
      const published = pixels instanceof Float32Array
        ? pixels
        : new Float32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
      publisher({
        level: 0,
        tileX: slot.address.x,
        tileZ: slot.address.z,
        heights: published,
      });
    }
    this.atlas.residency.complete(slot.key, token, stats);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.erosionExecutor?.dispose();
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
