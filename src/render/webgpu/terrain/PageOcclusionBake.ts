import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_PYRAMID_EDGE,
  TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
  TERRAIN_HEIGHT_SLOT_EDGE,
  terrainChannelTexelSizeMeters,
  terrainTexelSizeMeters,
} from "./TerrainSpineContract";
import {
  TERRAIN_CHANNEL_TEXTURES,
  type TerrainAtlasSlot,
  type TerrainPageAtlas,
} from "./TerrainPageAtlas";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
} from "@/src/render/webgpu/world/pageGeometry";
import { worldPageBounds } from "@/src/render/webgpu/world/pageKey";
import type { GlobalHeightPyramid } from "./GlobalHeightPyramid";

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

/** Azimuths marched. Sixteen keeps the visibility integral smooth. */
export const PAGE_OCCLUSION_AZIMUTHS = 16;
/** Azimuths STORED, as the max of each adjacent marched pair (conservative). */
export const PAGE_HORIZON_AZIMUTHS = 8;
/** Steps per azimuth, geometrically spaced from one texel to the far plane. */
export const PAGE_OCCLUSION_STEPS = 24;
/** How far a march reaches. Beyond this the aerial perspective hides the terrain. */
export const PAGE_OCCLUSION_REACH_METERS = 45_000;

const OCCLUSION_WORKGROUP_EDGE = 8;

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

@compute @workgroup_size(${OCCLUSION_WORKGROUP_EDGE}, ${OCCLUSION_WORKGROUP_EDGE}, 1)
fn bakeOcclusion(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let job = jobs[group.z];
  let edge = ${TERRAIN_CHANNEL_SLOT_EDGE}u;
  if (id.x >= edge || id.y >= edge) { return; }

  let gutter = f32(${WORLD_PAGE_GUTTER}u);
  let channelTexel = job.placement.w;
  // Channel texel centres, in world metres, gutter included.
  let worldX = job.placement.x + (f32(id.x) - gutter + 0.5) * channelTexel;
  let worldZ = job.placement.y + (f32(id.y) - gutter + 0.5) * channelTexel;
  let centreHeight = occlusionHeightAt(job, worldX, worldZ);

  var horizon: array<f32, ${PAGE_OCCLUSION_AZIMUTHS}>;
  var visibility = 0.0;
  var bentX = 0.0;
  var bentY = 0.0;
  var bentZ = 0.0;

  for (var azimuth = 0u; azimuth < ${PAGE_OCCLUSION_AZIMUTHS}u; azimuth = azimuth + 1u) {
    let angle = (f32(azimuth) + 0.5) * ${(Math.PI * 2) / PAGE_OCCLUSION_AZIMUTHS};
    let dirX = cos(angle);
    let dirZ = sin(angle);
    var maxSlope = 0.0;
    var radius = job.world.w;
    for (var step = 0u; step < ${PAGE_OCCLUSION_STEPS}u; step = step + 1u) {
      let sampleHeight = occlusionHeightAt(job, worldX + dirX * radius, worldZ + dirZ * radius);
      maxSlope = max(maxSlope, (sampleHeight - centreHeight) / radius);
      // Geometric spacing: the near field is where a metre of relief matters,
      // and 24 steps spread uniformly over 45 km would step past every ridge
      // that matters. The ratio is PER JOB, not a constant: it is chosen so
      // the last step lands at the reach, and the first step is one height
      // texel — which is level-dependent, so a baked-in ratio overshoots by
      // four orders of magnitude at coarse levels and every step past the
      // pyramid's edge is wasted on a clamped sample.
      radius = radius * job.world.z;
    }
    horizon[azimuth] = maxSlope;

    // Cosine-weighted sky visibility for this slice. Integrating the
    // unoccluded part of the hemisphere from the horizon angle to the zenith
    // with a cosine weight gives exactly cos^2(theta), so this is the
    // GTAO horizon-arc form rather than a tuned falloff.
    let elevation = atan(maxSlope);
    let open = cos(elevation) * cos(elevation);
    visibility = visibility + open;
    // The bent normal is the average unoccluded direction: the middle of each
    // slice's open arc, weighted by how much of it is open.
    let mid = (elevation + ${Math.PI / 2}) * 0.5;
    bentX = bentX + dirX * cos(mid) * open;
    bentY = bentY + sin(mid) * open;
    bentZ = bentZ + dirZ * cos(mid) * open;
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

  // Eight stored azimuths, each the MAX of a marched pair: a horizon map that
  // over-shadows slightly is a shadow that is a little too long, and one that
  // under-shadows is light leaking through a ridge.
  var packedA = vec4f(0.0);
  var packedB = vec4f(0.0);
  for (var stored = 0u; stored < ${PAGE_HORIZON_AZIMUTHS}u; stored = stored + 1u) {
    let slope = max(horizon[stored * 2u], horizon[stored * 2u + 1u]);
    // sin(atan(s)) is the fraction of the sky column the horizon covers, and
    // it is already in [0, 1) for a positive slope — an exact unorm fit.
    let value = slope / sqrt(1.0 + slope * slope);
    if (stored < 4u) {
      packedA[stored] = value;
    } else {
      packedB[stored - 4u] = value;
    }
  }
  textureStore(horizonTargetA, writeTexel, packedA);
  textureStore(horizonTargetB, writeTexel, packedB);
}
`;

/** Host side of the bake: one dispatch per batch of admitted channel slots. */
export class PageOcclusionBake {
  private shader: ComputeShader | null = null;
  private jobBuffer: StorageBuffer | null = null;
  private capacity = 0;
  private running = false;
  private disposed = false;

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
   * Bake occlusion, bent normal and the horizon map for a batch of pages.
   *
   * A page is only baked once its HEIGHT slot is resident: the march reads the
   * height atlas, and baking against an unwritten slot would produce a page
   * whose shadows are of nothing.
   */
  async bake(slots: readonly TerrainAtlasSlot[]): Promise<number> {
    if (this.disposed || this.running) return 0;
    if (!this.channelAtlas.hasTextures || !this.heightAtlas.hasTextures) return 0;
    const pyramidTexture = this.pyramid.heightTexture;
    if (!pyramidTexture || !this.pyramid.isResident) return 0;

    const bakeable = slots.filter((slot) => {
      const heightSlot = this.heightAtlas.residency.slotIndexOf(slot.key);
      return heightSlot >= 0 && slot.token !== null;
    });
    if (bakeable.length === 0) return 0;
    this.ensureCapacity(bakeable.length, pyramidTexture);
    const shader = this.shader;
    const jobBuffer = this.jobBuffer;
    if (!shader || !jobBuffer) return 0;

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
      for (const slot of bakeable) {
        if (!slot.token) continue;
        this.channelAtlas.residency.complete(slot.key, slot.token, slot.stats);
      }
      return bakeable.length;
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobBuffer?.dispose();
    this.jobBuffer = null;
    this.shader = null;
  }

  private ensureCapacity(count: number, pyramidTexture: unknown): void {
    if (count <= this.capacity && this.shader) return;
    this.jobBuffer?.dispose();
    this.capacity = Math.max(count, 4);
    const engine = this.engine as WebGPUEngine;
    this.jobBuffer = new StorageBuffer(engine, this.capacity * 12 * 4);
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
