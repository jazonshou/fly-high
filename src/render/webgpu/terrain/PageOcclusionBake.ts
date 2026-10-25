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
  type TerrainKernelLandformInput,
  type TerrainKernelProvinceInput,
} from "./TerrainKernel";
import {
  TERRAIN_LANDFORM_WGSL,
  TerrainLandformDataBinding,
  terrainLandformDataBindingWgsl,
  type TerrainLandformDataSource,
} from "./TerrainLandformKernel";
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
import { PassCostTape, passTimingSinkOf } from "@/src/render/webgpu/core/DeferredPassTiming";
import {
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
import {
  TERRAIN_PAGE_GRADED_BY_NONE,
  TERRAIN_PAGE_GRADED_BY_SEVERAL,
  terrainAirportGradingReach,
  terrainPageGradingAirport,
  type TerrainAirportReach,
} from "./AirportReach";
import { TERRAIN_AIRPORT_SLOTS } from "./RunwayEarthworks";
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
 * Floats per `SplatJob`: six `vec4f` lanes.
 *
 * The fifth is the runway frame the rounded-rectangle airport influence needs
 * (`splatAirportInfluence`); the sixth says how many airports reach the page
 * and where the page sits, for the per-texel path a page two airports reach
 * takes. Named rather than repeated so the host's stride, the buffer size and
 * the inventoried byte count cannot drift from the WGSL struct — the previous
 * literal `16` appeared in three places.
 */
const SPLAT_JOB_FLOATS = 24;

/** Floats per `SplatAirport` (two `vec4f`), and the table they fill. */
const SPLAT_AIRPORT_FLOATS = 8;
const SPLAT_AIRPORT_TABLE_FLOATS = SPLAT_AIRPORT_FLOATS * TERRAIN_AIRPORT_SLOTS;

/**
 * Every airport's influence frame in WORLD metres, for `splatAirports`: the
 * same numbers the job's page-local `airport` and `runway` lanes carry,
 * before the page origin is subtracted. Packed IN PLACE, unused slots zeroed.
 */
function packSplatAirportTable(
  airports: readonly Readonly<AirportDefinition>[],
  table: Float32Array,
): void {
  table.fill(0);
  const count = Math.min(airports.length, TERRAIN_AIRPORT_SLOTS);
  for (let slot = 0; slot < count; slot += 1) {
    const airport = airports[slot]!;
    const base = slot * SPLAT_AIRPORT_FLOATS;
    table[base] = airport.centerX;
    table[base + 1] = airport.centerZ;
    table[base + 2] = 1 / Math.max(1, airport.terrainBlendDistance);
    table[base + 4] = Math.sin(airport.headingRadians);
    table[base + 5] = Math.cos(airport.headingRadians);
    table[base + 6] = airport.runwayLength * 0.5 + airport.endSafetyArea;
    table[base + 7] = airport.runwayWidth * 0.5 + airport.shoulderWidth;
  }
}

/** The landform data binding's slot in the splat bake's bind group. */
const SPLAT_LANDFORM_DATA_BINDING = 9;

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
    terrainLandformDataBindingWgsl(0, SPLAT_LANDFORM_DATA_BINDING),
    TERRAIN_KERNEL_WGSL,
    // The landform include, for the ground the landform stages lay down (sand
    // cover, lava rock). Today the bake reads only its activity hook, which
    // keeps the data binding in the pipeline's layout; see bakeSplat.
    TERRAIN_LANDFORM_WGSL,
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
  /** This shader's passes, each paired with its own delivered duration (DeferredPassTiming.ts). */
  private costTape: PassCostTape | null = null;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly heightAtlas: TerrainPageAtlas,
    private readonly channelAtlas: TerrainPageAtlas,
    private readonly pyramid: GlobalHeightPyramid,
  ) {}

  get isBaking(): boolean {
    return this.running;
  }

  /**
   * `4.5-B2(a)`: the measured per-page cost of the batches whose timing was
   * delivered since the last call, each priced by its OWN page count.
   */
  consumeMeasuredDispatchCostMs(): number | null {
    const reading = this.costTape?.take();
    return reading && reading.units > 0 ? reading.milliseconds / reading.units : null;
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
   *
   * A slot is bakeable while it is being generated (it holds a token) or, for
   * an in-place re-bake after the airport list changed over it, while it is
   * resident: its texels are overwritten where they stand, as a season
   * re-bake overwrites a splat, so there is no frame in which it reads as
   * unbaked.
   */
  async bake(slots: readonly TerrainAtlasSlot[]): Promise<readonly TerrainAtlasSlot[]> {
    if (this.disposed || this.running) return [];
    if (!this.channelAtlas.hasTextures || !this.heightAtlas.hasTextures) return [];
    const pyramidTexture = this.pyramid.heightTexture;
    if (!pyramidTexture || !this.pyramid.isResident) return [];

    const bakeable = slots.filter((slot) => {
      const heightSlot = this.heightAtlas.residency.slotIndexOf(slot.key);
      return heightSlot >= 0
        && (slot.token !== null || slot.lifecycle.state === "resident");
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
    try {
      const groups = Math.ceil(TERRAIN_CHANNEL_SLOT_EDGE / OCCLUSION_WORKGROUP_EDGE);
      await shader.dispatchWhenReady(groups, groups, bakeable.length);
      // After the pass exists: it carries the frame its timing is delivered under.
      this.costTape?.dispatched(bakeable.length);
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
    this.costTape?.dispose();
    this.costTape = null;
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
    this.costTape ??= new PassCostTape(this.engine, passTimingSinkOf(this.shader));
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
  /**
   * `splatAirports`. Uploaded by the first batch after the list changes, with
   * that batch's jobs, so a batch can never pair one list's jobs with
   * another's table (one batch is recorded per frame; see `recordedFrame`).
   */
  private airportTableBuffer: StorageBuffer | null = null;
  /**
   * Every airport the bake classifies the airfield of, home field first. The
   * constructor's `airport` seeds it; `setAirports` replaces it.
   */
  private airports: readonly Readonly<AirportDefinition>[];
  /** `airports`' grading reaches, in list order, for `terrainPageGradingAirport`. */
  private gradingReaches: readonly TerrainAirportReach[];
  /** `splatAirports`' contents, packed in place by `setAirports`. */
  private readonly airportTable = new Float32Array(SPLAT_AIRPORT_TABLE_FLOATS);
  private readonly airportTableBytes = new Uint8Array(this.airportTable.buffer);
  private airportTableDirty = true;
  private capacity = 0;
  private running = false;
  /** Serialises `bake`: a second request waits for the first, it is never dropped. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * The frame the last dispatch was RECORDED in. A dispatch goes into the
   * frame's command encoder and is submitted at the end of the frame, but a
   * storage-buffer update is written to the device queue at once: a second
   * bake in the same frame would overwrite this bake's jobs before its
   * dispatch ran, and both dispatches would bake the second batch's pages.
   */
  private recordedFrame = -1;
  private frameWaiters: (() => void)[] = [];
  private disposed = false;
  /** This shader's passes, each paired with its own delivered duration (DeferredPassTiming.ts). */
  private costTape: PassCostTape | null = null;
  /** `terrainLandformData`: the one place it is held and bound, before each bake. */
  private readonly landformBinding: TerrainLandformDataBinding;

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
    airport: Readonly<AirportDefinition> | null,
    /**
     * The world's climate provinces (`terrainClimateProvinceInput`). Null
     * bakes the shipped climate everywhere: offsets of exactly 0.
     */
    private readonly climateProvince: TerrainKernelProvinceInput | null = null,
    /**
     * The world's landform core and wind (`terrainLandformInput`), carried on
     * the page uniform like the provinces. Null is gain 0.
     */
    private readonly landform: TerrainKernelLandformInput | null = null,
    /**
     * What `terrainLandformData` binds: the volcanic site index, or (null) a
     * zeroed placeholder the bake owns. Swappable with `setLandformDataSource`.
     */
    landformData: TerrainLandformDataSource | null = null,
  ) {
    this.landformBinding = new TerrainLandformDataBinding(landformData);
    this.airports = [];
    this.gradingReaches = [];
    this.setAirports(airport ? [airport] : []);
  }

  /**
   * Bind a different landform data source (null: the placeholder). Takes
   * effect at the next bake; the pipeline is not recreated.
   *
   * The splat bake does not defer a slot the source does not cover: a first
   * bake that skips a slot releases its channel slot, so the occlusion bake
   * would be repeated every frame until the index arrived. Nothing it writes
   * reads the data yet; when something does, the deferral belongs in the
   * clipmap's channel-bake admission, before the occlusion bake.
   */
  setLandformDataSource(source: TerrainLandformDataSource | null): void {
    this.landformBinding.setSource(source);
  }

  get isBaking(): boolean {
    return this.running;
  }

  /**
   * Classify the airfield of every airport in `airports` (home field first)
   * from the next batch on. Host state only — the table is packed here and
   * uploaded by the next batch, with its jobs — and nothing recompiles.
   */
  setAirports(airports: readonly Readonly<AirportDefinition>[]): void {
    this.airports = airports.slice(0, TERRAIN_AIRPORT_SLOTS);
    this.gradingReaches = this.airports.map(terrainAirportGradingReach);
    packSplatAirportTable(this.airports, this.airportTable);
    this.airportTableDirty = true;
  }

  /**
   * `4.5-B2(a)`: the measured per-page cost of the batches whose timing was
   * delivered since the last call, each priced by its OWN page count.
   */
  consumeMeasuredDispatchCostMs(): number | null {
    const reading = this.costTape?.take();
    return reading && reading.units > 0 ? reading.milliseconds / reading.units : null;
  }

  /** `4.5-C3`: this shader's whole-dispatch GPU time, unconsumed. */
  gpuMillisecondsInFrame(): number | null {
    return readGpuDispatchMs(this.shader);
  }

  /**
   * Bake both resident season buckets for a batch of channel slots, and
   * return the slots it actually wrote.
   *
   * QUEUED, never dropped. Two clients share this bake: a new page's first
   * bake (after its occlusion bake) and the in-place season re-bake. It used
   * to return 0 while another bake was running, and neither caller read the
   * count, so a page admitted during a season re-bake was published with its
   * splat texels never written: material 0 at weight 0, which is sand. It was
   * also marked baked for the current season, so no re-bake ever repaired it.
   * A filtered capture of `winter-noon` then `canopy-1200ft` drew that forest
   * as flat sand on 42 % of the frame. The caller publishes what is returned
   * and releases the rest; a slot with no height slot is not baked.
   */
  bake(slots: readonly TerrainAtlasSlot[], dayOfYear: number): Promise<readonly TerrainAtlasSlot[]> {
    const run = this.queue.then(async () => {
      await this.previousDispatchSubmitted();
      return this.bakeNow(slots, dayOfYear);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once the frame that recorded the last dispatch has been submitted. */
  private previousDispatchSubmitted(): Promise<void> {
    if (this.disposed || this.recordedFrame < 0 || this.engine.frameId > this.recordedFrame) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.frameWaiters.push(resolve);
      // `endFrame` submits, then advances `frameId`, then notifies.
      this.engine.onEndFrameObservable.addOnce(() => {
        this.frameWaiters = this.frameWaiters.filter((waiter) => waiter !== resolve);
        resolve();
      });
    });
  }

  private async bakeNow(
    slots: readonly TerrainAtlasSlot[],
    dayOfYear: number,
  ): Promise<readonly TerrainAtlasSlot[]> {
    if (this.disposed) return [];
    if (!this.channelAtlas.hasTextures || !this.heightAtlas.hasTextures) return [];
    const bakeable = slots.filter(
      (slot) => this.heightAtlas.residency.slotIndexOf(slot.key) >= 0,
    );
    if (bakeable.length === 0) return [];
    this.ensureCapacity(bakeable.length);
    const shader = this.shader;
    const jobBuffer = this.jobBuffer;
    const pageBuffer = this.pageBuffer;
    const airportTableBuffer = this.airportTableBuffer;
    if (!shader || !jobBuffer || !pageBuffer || !airportTableBuffer) return [];

    const airports = this.airports;
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
      // WHICH airport grades this page: the one whose influence reaches it
      // (AirportReach.ts). Footprints never touch, so that one is the nearest
      // centre wherever its influence is non-zero, and an airport whose
      // influence cannot reach the page contributes exactly 0 to every texel
      // of it — so a page no airport reaches keeps the home field, which is
      // precisely what every page of a one-airport world was baked with
      // before airports could spawn. Two or more reaching it (a coarse page
      // spanning two airports) switches the shader to its per-texel nearest
      // choice over `splatAirports`; per page is what keeps every other page
      // at its old cost.
      const graded = airports.length > 1
        ? terrainPageGradingAirport(this.gradingReaches, slot.address)
        : TERRAIN_PAGE_GRADED_BY_NONE;
      const airport = graded >= 0 ? airports[graded] ?? null : airports[0] ?? null;
      // Airport influence, page-local, so the graded platform is mown grass.
      jobs[base + 12] = airport ? airport.centerX - bounds.minX : 1e9;
      jobs[base + 13] = airport ? airport.centerZ - bounds.minZ : 1e9;
      // A 1 m blend with no airport: the platform half-extents below are 0 and
      // the centre is 1e9 away, so the shader's smoothstep saturates and the
      // influence is 0. Writing 0 here (the old value) made the influence 1
      // EVERYWHERE in an airport-less world, because the term it scaled
      // vanished with it.
      jobs[base + 14] = airport ? 1 / Math.max(1, airport.terrainBlendDistance) : 1;
      jobs[base + 15] = dayOfYear;
      // The runway frame and the graded platform's half-extents, so the bake
      // evaluates `getAirportInfluence`'s rounded rectangle rather than a disc
      // about the centre. Half-extents match that function's arguments exactly.
      jobs[base + 16] = airport ? Math.sin(airport.headingRadians) : 0;
      jobs[base + 17] = airport ? Math.cos(airport.headingRadians) : 1;
      jobs[base + 18] = airport
        ? airport.runwayLength * 0.5 + airport.endSafetyArea
        : 0;
      jobs[base + 19] = airport
        ? airport.runwayWidth * 0.5 + airport.shoulderWidth
        : 0;
      // (page origin, airports reaching the page — 0, 1, or 2 for two or
      // more — and airports in the table).
      jobs[base + 20] = bounds.minX;
      jobs[base + 21] = bounds.minZ;
      jobs[base + 22] = graded === TERRAIN_PAGE_GRADED_BY_SEVERAL
        ? 2
        : graded === TERRAIN_PAGE_GRADED_BY_NONE ? 0 : 1;
      jobs[base + 23] = Math.min(airports.length, TERRAIN_AIRPORT_SLOTS);
      pages.set(
        new Uint8Array(buildTerrainKernelPageUniform({
          seedHash: this.seedHash,
          extraSeedHash: this.vegetationSeedHash,
          originX: bounds.minX,
          originZ: bounds.minZ,
          filterWidthMeters: channelTexel,
          ...(this.climateProvince ? { climateProvince: this.climateProvince } : {}),
          landform: this.landform,
        }, VEGETATION_DENSITY_KERNEL_LATTICES)),
        index * SPLAT_KERNEL_PAGE_BYTES,
      );
    });
    jobBuffer.update(new Uint8Array(jobs.buffer));
    pageBuffer.update(pages);
    this.landformBinding.bind(this.engine as WebGPUEngine, shader);
    // Only after the list changed: the table was packed by setAirports from
    // the same `airports` these jobs index.
    if (this.airportTableDirty) {
      airportTableBuffer.update(this.airportTableBytes);
      this.airportTableDirty = false;
    }

    this.running = true;
    try {
      const groups = Math.ceil(TERRAIN_CHANNEL_SLOT_EDGE / OCCLUSION_WORKGROUP_EDGE);
      await shader.dispatchWhenReady(groups, groups, bakeable.length);
      // After the pass exists: it carries the frame its timing is delivered under.
      this.costTape?.dispatched(bakeable.length);
      this.recordedFrame = this.engine.frameId;
      return bakeable;
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.frameWaiters.splice(0)) waiter();
    this.jobBuffer?.dispose();
    this.pageBuffer?.dispose();
    this.airportTableBuffer?.dispose();
    releaseGpuBufferBytes(this.registeredBufferBytes);
    if (this.airportTableBuffer) releaseGpuBufferBytes(SPLAT_AIRPORT_TABLE_FLOATS * 4);
    this.registeredBufferBytes = 0;
    this.landformBinding.dispose();
    this.jobBuffer = null;
    this.pageBuffer = null;
    this.airportTableBuffer = null;
    this.shader = null;
    this.costTape?.dispose();
    this.costTape = null;
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
          terrainLandformData: { group: 0, binding: SPLAT_LANDFORM_DATA_BINDING },
          splatAirports: { group: 0, binding: 8 },
        },
      },
    );
    this.costTape ??= new PassCostTape(this.engine, passTimingSinkOf(this.shader));
    this.shader.setStorageBuffer("terrainKernelPages", this.pageBuffer);
    this.shader.setStorageBuffer("splatJobs", this.jobBuffer);
    if (!this.airportTableBuffer) {
      // Fixed size, created once: the slot count is the shader's, not the batch's.
      this.airportTableBuffer = new StorageBuffer(engine, SPLAT_AIRPORT_TABLE_FLOATS * 4);
      this.airportTableDirty = true;
      registerGpuBufferBytes(SPLAT_AIRPORT_TABLE_FLOATS * 4);
    }
    this.shader.setStorageBuffer("splatAirports", this.airportTableBuffer);
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
