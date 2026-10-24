import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";
import type { WorldDefinition } from "@/src/world/types";
import { VOLCANISM, volcanicActivityFrame } from "@/src/world/volcanism";
import {
  VolcanicSiteIndexBuilder,
  emptyVolcanicSiteIndex,
  volcanicIndexBinRange,
  type VolcanicSiteIndex,
} from "./VolcanicOverlayKernel";

/**
 * The live volcanic site index on the GPU: the `terrainLandformData` buffer
 * every landform consumer binds (page generation, the height pyramid, the
 * sea-depth bake, the ground bake).
 *
 * It follows the observer. When the observer is `rebuildMeters` from the
 * index's centre, a new index is packed around them in slices of at most
 * `budgetMilliseconds` a frame (`VolcanicSiteIndexBuilder`), and uploaded
 * whole, in place, once packed. A build takes a handful of frames, so the
 * 72 km half extent keeps the 131 km pyramid (and every page inside the
 * 45 km far plane) covered while it runs.
 *
 * WHY IN-PLACE UPLOADS ARE SAFE. The origin is the landform core centre, so
 * two indexes pack a site into the same bits and list a bin's sites in the
 * same order: a bake reads the same numbers from either, as long as both
 * cover it. A write lands before the frame's dispatches execute, so the
 * consumers' coverage checks (`covers`) are made against what they will read.
 *
 * COVERAGE IS A GATE. A bake outside the index would draw no volcanoes and be
 * cached that way, so consumers hold any dispatch whose footprint `covers`
 * rejects until the index arrives (after a teleport; `prime` builds the
 * spawn's index synchronously behind the load screen).
 *
 * BUDGETS. Steady state costs one distance check a frame and allocates
 * nothing. A rebuild reuses the builder's arrays; the buffer only grows (by
 * reallocation, which bumps `bufferVersion` so consumers rebind), and starts
 * at a capacity no world measured so far has needed.
 */

export const VOLCANIC_INDEX_STREAM = Object.freeze({
  /** Rebuild once the observer is this far from the index centre. */
  rebuildMeters: 4_000,
  /** Main-thread time a frame may spend packing (the 2 ms rule, with room). */
  budgetMilliseconds: 1,
  /** Initial buffer capacity: forced volcanic starts measured 77-87 KiB. */
  initialCapacityBytes: 256 * 1024,
});

/** The buffer the stream writes, as the consumers bind it. */
export interface VolcanicIndexBuffer {
  update(data: Float32Array, byteOffset?: number, byteLength?: number): void;
  dispose(): void;
}

export interface VolcanicSiteIndexStreamOptions<B extends VolcanicIndexBuffer> {
  /** Creates a buffer of `bytes`; the default is a Babylon StorageBuffer. */
  readonly createBuffer?: (bytes: number) => B;
  readonly now?: () => number;
  readonly budgetMilliseconds?: number;
  readonly initialCapacityBytes?: number;
}

export class VolcanicSiteIndexStream<B extends VolcanicIndexBuffer = StorageBuffer> {
  /** False for a world without volcanism (eroded): the empty index, forever. */
  readonly enabled: boolean;
  private readonly builder: VolcanicSiteIndexBuilder;
  private readonly createBuffer: (bytes: number) => B;
  private readonly now: () => number;
  private readonly budget: number;
  private storage: B;
  private capacityBytes: number;
  private version = 0;
  private uploads = 0;
  // The uploaded index's bin grid, world metres; empty (min > max) until the first upload.
  private gridMinX = Number.POSITIVE_INFINITY;
  private gridMinZ = Number.POSITIVE_INFINITY;
  private gridMaxX = Number.NEGATIVE_INFINITY;
  private gridMaxZ = Number.NEGATIVE_INFINITY;
  private siteCount = 0;
  private disposed = false;

  constructor(
    engine: WebGPUEngine | null,
    world: WorldDefinition,
    options: VolcanicSiteIndexStreamOptions<B> = {},
  ) {
    this.enabled = volcanicActivityFrame(world).mode !== 0;
    this.builder = new VolcanicSiteIndexBuilder(world);
    this.createBuffer = options.createBuffer
      ?? ((bytes) => new StorageBuffer(engine as WebGPUEngine, bytes, undefined, "volcanic-site-index") as unknown as B);
    this.now = options.now ?? (() => performance.now());
    this.budget = options.budgetMilliseconds ?? VOLCANIC_INDEX_STREAM.budgetMilliseconds;
    const empty = emptyVolcanicSiteIndex(world);
    this.capacityBytes = this.enabled
      ? Math.max(empty.data.byteLength, options.initialCapacityBytes ?? VOLCANIC_INDEX_STREAM.initialCapacityBytes)
      : empty.data.byteLength;
    this.storage = this.createBuffer(this.capacityBytes);
    registerGpuBufferBytes(this.capacityBytes);
    // Until the first index, the world's empty one: activity is right, no bins are listed.
    this.storage.update(empty.data);
  }

  /** The buffer to bind as `terrainLandformData`. Rebind when `bufferVersion` changes. */
  get buffer(): B {
    return this.storage;
  }

  /** Bumped when the buffer object is replaced (growth). */
  get bufferVersion(): number {
    return this.version;
  }

  /** Bumped on every upload (diagnostics, tests). */
  get uploadCount(): number {
    return this.uploads;
  }

  /** Sites in the uploaded index. */
  get uploadedSiteCount(): number {
    return this.siteCount;
  }

  get building(): boolean {
    return this.builder.building;
  }

  /**
   * Does the uploaded index list every bin a box touches (world metres)?
   * Always true without volcanism: the empty index is the right answer there.
   */
  covers(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    if (!this.enabled) return true;
    return minX >= this.gridMinX && minZ >= this.gridMinZ && maxX <= this.gridMaxX && maxZ <= this.gridMaxZ;
  }

  /** Build and upload the index round (x, z) now (load time: spawn, teleport behind a screen). */
  prime(x: number, z: number): void {
    if (!this.enabled || this.disposed) return;
    this.builder.begin(x, z);
    this.builder.step(Number.POSITIVE_INFINITY, this.now);
    this.upload(this.builder.index!);
  }

  /**
   * Per frame: start a rebuild if the observer has drifted, and pack for at
   * most the budget. Allocation-free unless a build starts or finishes.
   */
  update(observerX: number, observerZ: number): void {
    if (!this.enabled || this.disposed) return;
    // The centre built last, or being built (NaN before the first): a build
    // already under way for somewhere near is left to finish, and one for
    // somewhere far (a teleport mid-build) starts over.
    const targetX = this.builder.targetX;
    const drift = targetX === targetX
      ? Math.hypot(observerX - targetX, observerZ - this.builder.targetZ)
      : Number.POSITIVE_INFINITY;
    if (drift >= VOLCANIC_INDEX_STREAM.rebuildMeters) this.builder.begin(observerX, observerZ);
    else if (!this.builder.building) return;
    if (this.builder.step(this.now() + this.budget, this.now)) this.upload(this.builder.index!);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.storage.dispose();
    releaseGpuBufferBytes(this.capacityBytes);
  }

  private upload(index: VolcanicSiteIndex): void {
    const bytes = index.data.byteLength;
    if (bytes > this.capacityBytes) {
      this.storage.dispose();
      releaseGpuBufferBytes(this.capacityBytes);
      this.capacityBytes = Math.max(bytes, this.capacityBytes * 2);
      this.storage = this.createBuffer(this.capacityBytes);
      registerGpuBufferBytes(this.capacityBytes);
      this.version += 1;
    }
    this.storage.update(index.data);
    this.uploads += 1;
    this.siteCount = index.siteCount;
    // The bin grid the index lists, in world metres.
    const range = volcanicIndexBinRange(index.centerX, index.centerZ);
    const size = VOLCANISM.binMeters;
    this.gridMinX = range.bi0 * size;
    this.gridMinZ = range.bj0 * size;
    this.gridMaxX = (range.bi0 + range.binsX) * size;
    this.gridMaxZ = (range.bj0 + range.binsZ) * size;
  }
}
