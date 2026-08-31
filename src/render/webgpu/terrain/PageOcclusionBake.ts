import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";
import {
  LAND_COVER_CLASSIFIER_WGSL,
  LAND_COVER_SPLAT_BAKE_WGSL,
} from "./LandCoverClassifier";
import {
  TERRAIN_KERNEL_LATTICE_COUNT,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
  terrainKernelPageBytes,
} from "./TerrainKernel";
import {
  VEGETATION_DENSITY_FIELD_WGSL,
  VEGETATION_DENSITY_KERNEL_LATTICES,
} from "../detail/densityFieldWgsl";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  seasonBucketBlend,
  seasonBucketCenterDay,
  TERRAIN_HEIGHT_PYRAMID_EDGE,
  TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
  TERRAIN_HEIGHT_SLOT_EDGE,
  terrainChannelTexelSizeMeters,
  terrainTexelSizeMeters,
} from "./TerrainSpineContract";
import {
  consumeGpuDispatchCostMs,
  readGpuDispatchMs,
  TERRAIN_CHANNEL_TEXTURES,
  type TerrainAtlasSlot,
  type TerrainPageAtlas,
} from "./TerrainPageAtlas";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
} from "@/src/render/webgpu/world/pageGeometry";
import { worldPageBounds } from "@/src/render/webgpu/world/pageKey";
import {
  HORIZON_FIELD_AZIMUTHS_MARCHED,
  HORIZON_FIELD_AZIMUTHS_STORED,
  HORIZON_FIELD_MARCH_STEPS,
  HORIZON_FIELD_MARCH_WGSL,
} from "./HorizonField";
import type { GlobalHeightPyramid } from "./GlobalHeightPyramid";
import type { AirportDefinition } from "@/src/world/types";
import { seasonalTemperatureShift } from "@/src/world/terrain";

/**
 * The page occlusion bake (`4-7`).
 *
 * INVARIANT THIS FILE OWNS: **one bake, one owner, one format.** Four
 * subsystem designs baked this four ways at three resolutions before the
 * audit; sky visibility, the bent normal and the horizon field are now one
 * dispatch writing one set of channel pages that every consumer reads.
 *
 * Sixteen azimuths marched, eight stored. The marched count sets the quality
 * of the visibility integral; the stored count sets the memory. §5.2 rejects a
 * half-resolution 68² horizon page explicitly — 68 is core 60 plus gutter 4,
 * i.e. a SECOND channel geometry, which is the rule §3.3 uses to strike the
 * Ultra 1 m L0 row. If the horizon field proves over-sampled, the saving to
 * take is fewer azimuths at the canonical resolution.
 *
 * The march reads the page's own height texels inside the page and the
 * **global height pyramid** beyond it, so a 3,000 m ridge shadows the valley
 * behind it at 40 km and there is no discontinuity at a page edge.
 */

/**
 * `6-11`: the march's shape now lives in `HorizonField`, which this bake and
 * the global pyramid's horizon layers both compose. These names stay as
 * re-exports because they are this page bake's published vocabulary — the
 * extraction may not change what a caller imports.
 */
export const PAGE_OCCLUSION_AZIMUTHS = HORIZON_FIELD_AZIMUTHS_MARCHED;
/** Azimuths STORED, as the max of each adjacent marched pair (conservative). */
export const PAGE_HORIZON_AZIMUTHS = HORIZON_FIELD_AZIMUTHS_STORED;
/** Steps per azimuth, geometrically spaced from one texel to the far plane. */
export const PAGE_OCCLUSION_STEPS = HORIZON_FIELD_MARCH_STEPS;
/** How far a march reaches. Beyond this the aerial perspective hides the terrain. */
export const PAGE_OCCLUSION_REACH_METERS = 45_000;

const OCCLUSION_WORKGROUP_EDGE = 8;

/**
 * `6-8`: the splat bake's page uniform carries the terrain kernel's own
 * lattices PLUS the vegetation density field's eleven, appended. Every other
 * consumer of the kernel page uniform is untouched — extras land strictly
 * after the kernel's own indices, so `terrainKernelPageBytes(0)` is still
 * `TERRAIN_KERNEL_PAGE_BYTES` byte for byte.
 */
const SPLAT_KERNEL_PAGE_BYTES = terrainKernelPageBytes(
  VEGETATION_DENSITY_KERNEL_LATTICES.length,
);

/**
 * Floats per `SplatJob`: five `vec4f` lanes.
 *
 * The fifth is the runway frame the rounded-rectangle airport influence needs
 * (`splatAirportInfluence`). Named rather than repeated so the host's stride,
 * the buffer size and the inventoried byte count cannot drift from the WGSL
 * struct — the previous literal `16` appeared in three places.
 */
const SPLAT_JOB_FLOATS = 20;

/**
 * The page-splat bake's composed source — ONE definition.
 *
 * Exported because `tests/gpu/terrain-compute-compile.test.ts` used to restate
 * the module list, so a composition change (6-8 appended the vegetation
 * density include and its lattice base) compiled in the renderer and failed in
 * the test that exists to catch compile failures.
 */
export function terrainPageSplatWgsl(): string {
  return [
    terrainKernelPageBindingWgsl(0, 0, VEGETATION_DENSITY_KERNEL_LATTICES.length),
    TERRAIN_KERNEL_WGSL,
    // 6-8: the appended table's base index, derived from the kernel's own
    // lattice count and never retyped. It is composed here rather than
    // injected inside the classifier because the classifier is reachable
    // from src/world/terrain.ts and may not import the kernel.
    `const SPLAT_VEGETATION_LATTICE_BASE: u32 = ${TERRAIN_KERNEL_LATTICE_COUNT}u;`,
    // 6-8: the FIRST live composer of the vegetation density include. It was
    // emitted in 4-6b and pinned only by string tests until now; composing it
    // here is what makes "one owner for where forest is" true of the ground as
    // well as of the plants.
    VEGETATION_DENSITY_FIELD_WGSL,
    LAND_COVER_CLASSIFIER_WGSL,
    LAND_COVER_SPLAT_BAKE_WGSL,
  ].join("\n");
}

export const PAGE_OCCLUSION_WGSL = /* wgsl */ `
struct OcclusionJob {
  // (height slot texel u, height slot texel v, channel slot texel u,
  //  channel slot texel v)
  slots: vec4f,
  // (page min X, page min Z, height texel size, channel texel size)
  placement: vec4f,
  // (pyramid origin X, pyramid origin Z, march growth ratio, first march radius)
  world: vec4f,
};

@group(0) @binding(0) var<storage, read> jobs: array<OcclusionJob>;
@group(0) @binding(1) var heightAtlas: texture_2d<f32>;
@group(0) @binding(2) var heightPyramid: texture_2d<f32>;
@group(0) @binding(3) var occlusionTarget: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var horizonTargetA: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var horizonTargetB: texture_storage_2d<rgba8unorm, write>;

/** Height at a world position: the page's own texels inside it, the pyramid beyond. */
fn occlusionHeightAt(job: OcclusionJob, worldX: f32, worldZ: f32) -> f32 {
  let localX = (worldX - job.placement.x) / job.placement.z;
  let localZ = (worldZ - job.placement.y) / job.placement.z;
  let core = f32(${TERRAIN_HEIGHT_SLOT_EDGE - 2 * WORLD_PAGE_GUTTER}u);
  let gutter = f32(${WORLD_PAGE_GUTTER}u);
  if (localX >= -gutter && localX < core + gutter
    && localZ >= -gutter && localZ < core + gutter) {
    let texel = vec2i(
      i32(job.slots.x) + i32(floor(localX + gutter)),
      i32(job.slots.y) + i32(floor(localZ + gutter)),
    );
    // textureLoad only: r32float is not filterable, and ComputeShader creates
    // its pipeline with layout "auto", so a textureSample here would be a
    // validation error at pipeline creation rather than a blurry result.
    return textureLoad(heightAtlas, texel, 0).r;
  }
  let pyramidX = (worldX - job.world.x) / ${TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS}.0;
  let pyramidZ = (worldZ - job.world.y) / ${TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS}.0;
  let clamped = clamp(
    vec2i(i32(floor(pyramidX)), i32(floor(pyramidZ))),
    vec2i(0, 0),
    vec2i(${TERRAIN_HEIGHT_PYRAMID_EDGE - 1}, ${TERRAIN_HEIGHT_PYRAMID_EDGE - 1}),
  );
  return textureLoad(heightPyramid, clamped, 0).r;
}

/**
 * '6-11': the composition hole 'HORIZON_FIELD_MARCH_WGSL' requires.
 *
 * The job index travels in a private var rather than as a parameter because
 * WGSL has no closures: the shared march cannot take this bake's per-job
 * height source any other way, and threading an 'OcclusionJob' through the
 * shared signature would make the operator know about pages — which is exactly
 * what stops the pyramid from composing it.
 */
var<private> occlusionJobIndex: u32;

fn horizonFieldHeightAt(worldX: f32, worldZ: f32) -> f32 {
  return occlusionHeightAt(jobs[occlusionJobIndex], worldX, worldZ);
}

${HORIZON_FIELD_MARCH_WGSL}

@compute @workgroup_size(${OCCLUSION_WORKGROUP_EDGE}, ${OCCLUSION_WORKGROUP_EDGE}, 1)
fn bakeOcclusion(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let job = jobs[group.z];
  // Set BEFORE the early-out is irrelevant but before the march is not: the
  // shared operator reads the world through this index.
  occlusionJobIndex = group.z;
  let edge = ${TERRAIN_CHANNEL_SLOT_EDGE}u;
  if (id.x >= edge || id.y >= edge) { return; }

  let gutter = f32(${WORLD_PAGE_GUTTER}u);
  let channelTexel = job.placement.w;
  // Channel texel centres, in world metres, gutter included.
  let worldX = job.placement.x + (f32(id.x) - gutter + 0.5) * channelTexel;
  let worldZ = job.placement.y + (f32(id.y) - gutter + 0.5) * channelTexel;
  let centreHeight = occlusionHeightAt(job, worldX, worldZ);

  // '6-11': the march is the shared operator's, so this bake and the global
  // pyramid's horizon layers cannot drift. The per-job geometric spacing
  // travels as the two parameters it always was.
  var horizon: array<f32, ${PAGE_OCCLUSION_AZIMUTHS}>;
  horizonFieldMarch(worldX, worldZ, centreHeight, job.world.w, job.world.z, &horizon);

  var visibility = 0.0;
  var bentX = 0.0;
  var bentY = 0.0;
  var bentZ = 0.0;
  // The sky-visibility integral and the bent normal stay HERE: they are the
  // occlusion channel's business, read the marched slopes rather than
  // producing them, and no second consumer of the horizon field wants them.
  for (var azimuth = 0u; azimuth < ${PAGE_OCCLUSION_AZIMUTHS}u; azimuth = azimuth + 1u) {
    let dir = horizonFieldAzimuthDirection(azimuth);
    // Cosine-weighted sky visibility for this slice. Integrating the
    // unoccluded part of the hemisphere from the horizon angle to the zenith
    // with a cosine weight gives exactly cos^2(theta), so this is the
    // GTAO horizon-arc form rather than a tuned falloff.
    let elevation = atan(horizon[azimuth]);
    let open = cos(elevation) * cos(elevation);
    visibility = visibility + open;
    // The bent normal is the average unoccluded direction: the middle of each
    // slice's open arc, weighted by how much of it is open.
    let mid = (elevation + ${Math.PI / 2}) * 0.5;
    bentX = bentX + dir.x * cos(mid) * open;
    bentY = bentY + sin(mid) * open;
    bentZ = bentZ + dir.y * cos(mid) * open;
  }

  visibility = visibility / ${PAGE_OCCLUSION_AZIMUTHS}.0;
  let bentLength = max(1e-5, sqrt(bentX * bentX + bentY * bentY + bentZ * bentZ));
  let bent = vec3f(bentX, bentY, bentZ) / bentLength;

  // 'target' is a WGSL reserved keyword; every identifier here is prefixed or
  // renamed for that reason rather than by convention.
  let writeTexel = vec2i(i32(job.slots.z) + i32(id.x), i32(job.slots.w) + i32(id.y));
  textureStore(occlusionTarget, writeTexel, vec4f(
    visibility,
    bent.x * 0.5 + 0.5,
    bent.z * 0.5 + 0.5,
    // Alpha carries the bent normal's vertical sign so a fully enclosed texel
    // is distinguishable from an unbaked one.
    bent.y * 0.5 + 0.5,
  ));

  // '6-11': the max-of-pairs packing is the shared operator's too. The stored
  // format IS the interoperability contract — a consumer that unpacks it must
  // see the same bytes whichever producer wrote them.
  let packed = horizonFieldPack(&horizon);
  textureStore(horizonTargetA, writeTexel, packed.a);
  textureStore(horizonTargetB, writeTexel, packed.b);
}
`;

/** Host side of the bake: one dispatch per batch of admitted channel slots. */
export class PageOcclusionBake {
  private shader: ComputeShader | null = null;
  private jobBuffer: StorageBuffer | null = null;
  /** Bytes reported to the renderer's memory-inventory floor (Gate 0-c). */
  private registeredBufferBytes = 0;
  private capacity = 0;
  private running = false;
  private disposed = false;
  private lastBatchSize = 0;
  private lastCostSampleCount = -1;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly heightAtlas: TerrainPageAtlas,
    private readonly channelAtlas: TerrainPageAtlas,
    private readonly pyramid: GlobalHeightPyramid,
  ) {}

  get isBaking(): boolean {
    return this.running;
  }

  /** `4.5-B2(a)`: the measured per-page cost of the last resolved batch. */
  consumeMeasuredDispatchCostMs(): number | null {
    const sample = consumeGpuDispatchCostMs(
      this.shader, this.lastBatchSize, this.lastCostSampleCount);
    this.lastCostSampleCount = sample.sampleCount;
    return sample.milliseconds;
  }

  /** `4.5-C3`: this shader's whole-dispatch GPU time, unconsumed. */
  gpuMillisecondsInFrame(): number | null {
    return readGpuDispatchMs(this.shader);
  }

  /**
   * Bake occlusion, bent normal and the horizon map for a batch of pages.
   *
   * A page is only baked once its HEIGHT slot is resident: the march reads the
   * height atlas, and baking against an unwritten slot would produce a page
   * whose shadows are of nothing.
   */
  async bake(slots: readonly TerrainAtlasSlot[]): Promise<readonly TerrainAtlasSlot[]> {
    if (this.disposed || this.running) return [];
    if (!this.channelAtlas.hasTextures || !this.heightAtlas.hasTextures) return [];
    const pyramidTexture = this.pyramid.heightTexture;
    if (!pyramidTexture || !this.pyramid.isResident) return [];

    const bakeable = slots.filter((slot) => {
      const heightSlot = this.heightAtlas.residency.slotIndexOf(slot.key);
      return heightSlot >= 0 && slot.token !== null;
    });
    if (bakeable.length === 0) return [];
    this.ensureCapacity(bakeable.length, pyramidTexture);
    const shader = this.shader;
    const jobBuffer = this.jobBuffer;
    if (!shader || !jobBuffer) return [];

    const jobs = new Float32Array(bakeable.length * 12);
    bakeable.forEach((slot, index) => {
      const level = slot.address.level;
      const bounds = worldPageBounds(slot.address, WORLD_PAGE_BASE_EXTENT_METERS);
      const heightIndex = this.heightAtlas.residency.slotIndexOf(slot.key);
      const heightOrigin = this.heightAtlas.slotOrigin(heightIndex);
      const channelOrigin = this.channelAtlas.slotOrigin(slot.slotIndex);
      const base = index * 12;
      jobs[base] = heightOrigin.u;
      jobs[base + 1] = heightOrigin.v;
      jobs[base + 2] = channelOrigin.u;
      jobs[base + 3] = channelOrigin.v;
      jobs[base + 4] = bounds.minX;
      jobs[base + 5] = bounds.minZ;
      jobs[base + 6] = terrainTexelSizeMeters(level);
      jobs[base + 7] = terrainChannelTexelSizeMeters(level);
      jobs[base + 8] = this.pyramid.originX;
      jobs[base + 9] = this.pyramid.originZ;
      // The first march step is one height texel: closer than that and the
      // march would only ever find the texel it started on.
      const firstRadius = terrainTexelSizeMeters(level);
      jobs[base + 10] = Math.pow(
        PAGE_OCCLUSION_REACH_METERS / firstRadius,
        1 / (PAGE_OCCLUSION_STEPS - 1),
      );
      jobs[base + 11] = firstRadius;
    });
    jobBuffer.update(new Uint8Array(jobs.buffer));

    this.running = true;
    this.lastBatchSize = bakeable.length;
    try {
      const groups = Math.ceil(TERRAIN_CHANNEL_SLOT_EDGE / OCCLUSION_WORKGROUP_EDGE);
      await shader.dispatchWhenReady(groups, groups, bakeable.length);
      // Deliberately does NOT mark the slots resident. A channel slot carries
      // occlusion AND splat, and the splat bake runs after this one; marking
      // residency here published a page whose splat texels were still zero —
      // which decodes to material 0 at weight 0, and material 0 is SAND. The
      // caller completes the slots once both bakes have written.
      return bakeable;
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobBuffer?.dispose();
    releaseGpuBufferBytes(this.registeredBufferBytes);
    this.registeredBufferBytes = 0;
    this.jobBuffer = null;
    this.shader = null;
  }

  private ensureCapacity(count: number, pyramidTexture: unknown): void {
    if (count <= this.capacity && this.shader) return;
    this.jobBuffer?.dispose();
    // Gate 0-c: storage buffers are invisible to the renderer's inventory.
    releaseGpuBufferBytes(this.registeredBufferBytes);
    this.capacity = Math.max(count, 4);
    const engine = this.engine as WebGPUEngine;
    this.jobBuffer = new StorageBuffer(engine, this.capacity * 12 * 4);
    this.registeredBufferBytes = this.capacity * 12 * 4;
    registerGpuBufferBytes(this.registeredBufferBytes);
    this.shader ??= new ComputeShader(
      "terrain-page-occlusion",
      engine,
      { computeSource: PAGE_OCCLUSION_WGSL },
      {
        entryPoint: "bakeOcclusion",
        bindingsMapping: {
          jobs: { group: 0, binding: 0 },
          heightAtlas: { group: 0, binding: 1 },
          heightPyramid: { group: 0, binding: 2 },
          occlusionTarget: { group: 0, binding: 3 },
          horizonTargetA: { group: 0, binding: 4 },
          horizonTargetB: { group: 0, binding: 5 },
        },
      },
    );
    this.shader.setStorageBuffer("jobs", this.jobBuffer);
    const height = this.heightAtlas.texture();
    if (height) this.shader.setTexture("heightAtlas", height, false);
    this.shader.setTexture(
      "heightPyramid",
      pyramidTexture as Parameters<ComputeShader["setTexture"]>[1],
      false,
    );
    const occlusion = this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.occlusion);
    const horizonA = this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.horizonA);
    const horizonB = this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.horizonB);
    if (occlusion) this.shader.setStorageTexture("occlusionTarget", occlusion);
    if (horizonA) this.shader.setStorageTexture("horizonTargetA", horizonA);
    if (horizonB) this.shader.setStorageTexture("horizonTargetB", horizonB);
  }
}

/**
 * The land-cover splat bake (`4-6`), hosted alongside the occlusion bake.
 *
 * They share a host because they write into the same channel slot and are
 * admitted by the same meter: a page whose occlusion exists but whose splat
 * does not is a page the shader has to guard against, and one dispatch pair
 * per admitted slot removes the state entirely.
 */
export class PageSplatBake {
  private shader: ComputeShader | null = null;
  private jobBuffer: StorageBuffer | null = null;
  /** Bytes reported to the renderer's memory-inventory floor (Gate 0-c). */
  private registeredBufferBytes = 0;
  private pageBuffer: StorageBuffer | null = null;
  private capacity = 0;
  private running = false;
  private disposed = false;
  private lastBatchSize = 0;
  private lastCostSampleCount = -1;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly heightAtlas: TerrainPageAtlas,
    private readonly channelAtlas: TerrainPageAtlas,
    private readonly seedHash: number,
    /**
     * The VEGETATION realisation's seed — `world.sourceSeedHash`, not
     * `world.seedHash`.
     *
     * `6-8` appended the vegetation density field's lattices to the terrain
     * kernel's page uniform and let them inherit the terrain seed. Those are
     * different numbers whenever `createWorld`'s guaranteed-airport search
     * re-seeds the terrain, so the canopy-closure channel this bake writes
     * described a forest that is not the one `WorldDetailRuntime` plants:
     * measured at the `grove-forest-2m` site, 0.008 closure baked against
     * 0.90 standing (2 stems/ha against 630/ha). Splitting the two seeds is
     * what makes "one closure, read through one entry point" true of the same
     * WORLD as well as of the same code.
     */
    private readonly vegetationSeedHash: number,
    private readonly seaLevelMeters: number,
    private readonly latitudeDegrees: number,
    private readonly airport: Readonly<AirportDefinition> | null,
  ) {}

  get isBaking(): boolean {
    return this.running;
  }

  /** `4.5-B2(a)`: the measured per-page cost of the last resolved batch. */
  consumeMeasuredDispatchCostMs(): number | null {
    const sample = consumeGpuDispatchCostMs(
      this.shader, this.lastBatchSize, this.lastCostSampleCount);
    this.lastCostSampleCount = sample.sampleCount;
    return sample.milliseconds;
  }

  /** `4.5-C3`: this shader's whole-dispatch GPU time, unconsumed. */
  gpuMillisecondsInFrame(): number | null {
    return readGpuDispatchMs(this.shader);
  }

  /** Bake both resident season buckets for a batch of channel slots. */
  async bake(slots: readonly TerrainAtlasSlot[], dayOfYear: number): Promise<number> {
    if (this.disposed || this.running) return 0;
    if (!this.channelAtlas.hasTextures || !this.heightAtlas.hasTextures) return 0;
    const bakeable = slots.filter(
      (slot) => this.heightAtlas.residency.slotIndexOf(slot.key) >= 0,
    );
    if (bakeable.length === 0) return 0;
    this.ensureCapacity(bakeable.length);
    const shader = this.shader;
    const jobBuffer = this.jobBuffer;
    const pageBuffer = this.pageBuffer;
    if (!shader || !jobBuffer || !pageBuffer) return 0;

    const blend = seasonBucketBlend(dayOfYear);
    const jobs = new Float32Array(bakeable.length * SPLAT_JOB_FLOATS);
    const pages = new Uint8Array(bakeable.length * SPLAT_KERNEL_PAGE_BYTES);
    bakeable.forEach((slot, index) => {
      const level = slot.address.level;
      const bounds = worldPageBounds(slot.address, WORLD_PAGE_BASE_EXTENT_METERS);
      const channelOrigin = this.channelAtlas.slotOrigin(slot.slotIndex);
      const heightOrigin = this.heightAtlas.slotOrigin(
        this.heightAtlas.residency.slotIndexOf(slot.key),
      );
      const channelTexel = terrainChannelTexelSizeMeters(level);
      const heightTexel = terrainTexelSizeMeters(level);
      const base = index * SPLAT_JOB_FLOATS;
      jobs[base] = channelOrigin.u;
      jobs[base + 1] = channelOrigin.v;
      jobs[base + 2] = heightOrigin.u;
      jobs[base + 3] = heightOrigin.v;
      jobs[base + 4] = channelTexel;
      jobs[base + 5] = heightTexel;
      jobs[base + 6] = index;
      jobs[base + 7] = this.seaLevelMeters;
      // The page's own gutter offset, in the kernel page's local frame.
      jobs[base + 8] = -WORLD_PAGE_GUTTER * channelTexel;
      jobs[base + 9] = -WORLD_PAGE_GUTTER * channelTexel;
      jobs[base + 10] = seasonalTemperatureShift(
        seasonBucketCenterDay(blend.lo),
        this.latitudeDegrees,
      );
      jobs[base + 11] = seasonalTemperatureShift(
        seasonBucketCenterDay(blend.hi),
        this.latitudeDegrees,
      );
      // Airport influence, page-local, so the graded platform is mown grass.
      jobs[base + 12] = this.airport ? this.airport.centerX - bounds.minX : 1e9;
      jobs[base + 13] = this.airport ? this.airport.centerZ - bounds.minZ : 1e9;
      // A 1 m blend with no airport: the platform half-extents below are 0 and
      // the centre is 1e9 away, so the shader's smoothstep saturates and the
      // influence is 0. Writing 0 here (the old value) made the influence 1
      // EVERYWHERE in an airport-less world, because the term it scaled
      // vanished with it.
      jobs[base + 14] = this.airport ? 1 / Math.max(1, this.airport.terrainBlendDistance) : 1;
      jobs[base + 15] = dayOfYear;
      // The runway frame and the graded platform's half-extents, so the bake
      // evaluates `getAirportInfluence`'s rounded rectangle rather than a disc
      // about the centre. Half-extents match that function's arguments exactly.
      jobs[base + 16] = this.airport ? Math.sin(this.airport.headingRadians) : 0;
      jobs[base + 17] = this.airport ? Math.cos(this.airport.headingRadians) : 1;
      jobs[base + 18] = this.airport
        ? this.airport.runwayLength * 0.5 + this.airport.endSafetyArea
        : 0;
      jobs[base + 19] = this.airport
        ? this.airport.runwayWidth * 0.5 + this.airport.shoulderWidth
        : 0;
      pages.set(
        new Uint8Array(buildTerrainKernelPageUniform({
          seedHash: this.seedHash,
          extraSeedHash: this.vegetationSeedHash,
          originX: bounds.minX,
          originZ: bounds.minZ,
          filterWidthMeters: channelTexel,
        }, VEGETATION_DENSITY_KERNEL_LATTICES)),
        index * SPLAT_KERNEL_PAGE_BYTES,
      );
    });
    jobBuffer.update(new Uint8Array(jobs.buffer));
    pageBuffer.update(pages);

    this.running = true;
    this.lastBatchSize = bakeable.length;
    try {
      const groups = Math.ceil(TERRAIN_CHANNEL_SLOT_EDGE / OCCLUSION_WORKGROUP_EDGE);
      await shader.dispatchWhenReady(groups, groups, bakeable.length);
      return bakeable.length;
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobBuffer?.dispose();
    this.pageBuffer?.dispose();
    releaseGpuBufferBytes(this.registeredBufferBytes);
    this.registeredBufferBytes = 0;
    this.jobBuffer = null;
    this.pageBuffer = null;
    this.shader = null;
  }

  private ensureCapacity(count: number): void {
    if (count <= this.capacity && this.shader) return;
    this.jobBuffer?.dispose();
    this.pageBuffer?.dispose();
    // Gate 0-c: storage buffers are invisible to the renderer's inventory.
    releaseGpuBufferBytes(this.registeredBufferBytes);
    this.capacity = Math.max(count, 4);
    const engine = this.engine as WebGPUEngine;
    this.jobBuffer = new StorageBuffer(engine, this.capacity * SPLAT_JOB_FLOATS * 4);
    this.pageBuffer = new StorageBuffer(engine, this.capacity * SPLAT_KERNEL_PAGE_BYTES);
    this.registeredBufferBytes = this.capacity * SPLAT_JOB_FLOATS * 4
      + this.capacity * SPLAT_KERNEL_PAGE_BYTES;
    registerGpuBufferBytes(this.registeredBufferBytes);
    this.shader ??= new ComputeShader(
      "terrain-page-splat",
      engine,
      {
        computeSource: terrainPageSplatWgsl(),
      },
      {
        entryPoint: "bakeSplat",
        bindingsMapping: {
          terrainKernelPages: { group: 0, binding: 0 },
          splatJobs: { group: 0, binding: 1 },
          splatHeightAtlas: { group: 0, binding: 2 },
          splatId: { group: 0, binding: 3 },
          splatWeightLo: { group: 0, binding: 4 },
          splatWeightHi: { group: 0, binding: 5 },
          splatFlowAccumAtlas: { group: 0, binding: 6 },
          // 6-6: the soil-depth channel's first GPU consumer.
          splatSoilDepthAtlas: { group: 0, binding: 7 },
        },
      },
    );
    this.shader.setStorageBuffer("terrainKernelPages", this.pageBuffer);
    this.shader.setStorageBuffer("splatJobs", this.jobBuffer);
    const height = this.heightAtlas.texture();
    if (height) this.shader.setTexture("splatHeightAtlas", height, false);
    const flowAccum = this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.flowAccum);
    if (flowAccum) this.shader.setTexture("splatFlowAccumAtlas", flowAccum, false);
    // The aux resources are created for every world; an analytic one is simply
    // zero-initialised and the bake's sentinel neutralises the litter term.
    const soilDepth = this.channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.soilDepth);
    if (soilDepth) this.shader.setTexture("splatSoilDepthAtlas", soilDepth, false);
    for (const [name, index] of [
      ["splatId", TERRAIN_CHANNEL_TEXTURES.splatId],
      ["splatWeightLo", TERRAIN_CHANNEL_TEXTURES.splatWeightLo],
      ["splatWeightHi", TERRAIN_CHANNEL_TEXTURES.splatWeightHi],
    ] as const) {
      const texture = this.channelAtlas.texture(index);
      if (texture) this.shader.setStorageTexture(name, texture);
    }
  }
}
