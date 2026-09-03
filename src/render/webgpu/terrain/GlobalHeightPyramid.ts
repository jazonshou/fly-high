import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import {
  TERRAIN_KERNEL_PAGE_BYTES,
  TERRAIN_KERNEL_WGSL,
  buildTerrainKernelPageUniform,
  terrainKernelPageBindingWgsl,
} from "./TerrainKernel";
import {
  TERRAIN_HEIGHT_PYRAMID_EDGE,
  TERRAIN_HEIGHT_PYRAMID_SPAN_METERS,
  TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
  TERRAIN_HORIZON_PYRAMID_EDGE,
  TERRAIN_HORIZON_PYRAMID_TEXEL_METERS,
} from "./TerrainSpineContract";
import {
  HORIZON_FIELD_AZIMUTHS_MARCHED,
  HORIZON_FIELD_MARCH_STEPS,
  HORIZON_FIELD_MARCH_WGSL,
} from "./HorizonField";
import { withoutDispatchTiming } from "../core/GpuTimingPolicy";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";

/**
 * The coarse global height field (`4-7`).
 *
 * INVARIANT THIS FILE OWNS: there is one coarse height field for marching
 * BEYOND a page, at one resolution, with one owner. Without it the occlusion
 * bake can only see inside the page it is baking, and every page edge becomes
 * a shadow discontinuity — a 40 km ridge would stop shadowing the valley
 * behind it exactly where the page ends, which is the failure Gate 4B exists
 * to remove.
 *
 * 256² r32float at 512 m/texel: 131 km across, well beyond the 45 km far
 * plane, for 0.25 MiB. Band-limited at the pyramid's own texel size, so it is
 * a blurred version of the same surface rather than a re-rolled point sample
 * (1B-2's rule, applied one level coarser than any page).
 *
 * Recentred in whole texels, so a moving observer re-bakes at most once per
 * 512 m of travel and the field never slides under the bake that reads it.
 */

const PYRAMID_WORKGROUP_EDGE = 8;

export const GLOBAL_HEIGHT_PYRAMID_WGSL = /* wgsl */ `
${terrainKernelPageBindingWgsl(0, 0)}
${TERRAIN_KERNEL_WGSL}

struct PyramidParams {
  // (world offset of texel 0 from the kernel page origin, x and z, texel size,
  //  unused)
  placement: vec4f,
};

@group(0) @binding(1) var<storage, read> pyramidParams: PyramidParams;
@group(0) @binding(2) var pyramidTarget: texture_storage_2d<r32float, write>;

@compute @workgroup_size(${PYRAMID_WORKGROUP_EDGE}, ${PYRAMID_WORKGROUP_EDGE}, 1)
fn bakePyramid(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${TERRAIN_HEIGHT_PYRAMID_EDGE}u || id.y >= ${TERRAIN_HEIGHT_PYRAMID_EDGE}u) {
    return;
  }
  kSelectPage(0u);
  let texel = pyramidParams.placement.z;
  let height = terrainNaturalHeight(
    pyramidParams.placement.x + f32(id.x) * texel,
    pyramidParams.placement.y + f32(id.y) * texel,
  );
  textureStore(pyramidTarget, vec2i(i32(id.x), i32(id.y)), vec4f(height, 0.0, 0.0, 0.0));
}
`;

/** How far the horizon march reaches. Matches `4-7`'s page march exactly. */
const HORIZON_PYRAMID_REACH_METERS = 45_000;

/** Two `vec4f` lanes: placement, then the height source's origin. */
const HORIZON_PARAMS_BYTES = 32;

/**
 * The GLOBAL horizon bake (`6-11`).
 *
 * Composes the SAME march and the SAME packing the page occlusion bake uses,
 * with the only legitimate difference — the height source — supplied through
 * the composition hole. The page bake reads its own atlas texels inside the
 * page and this pyramid beyond; here there is no page, so the pyramid is the
 * whole source.
 *
 * The first step is one HEIGHT-pyramid texel rather than one horizon texel:
 * the march samples the height field, and a step shorter than its texel would
 * only ever re-find the texel it started on. That is the page bake's rule
 * ("the first march step is one height texel") applied to this source.
 */
export const GLOBAL_HORIZON_PYRAMID_WGSL = /* wgsl */ `
@group(0) @binding(0) var horizonHeightPyramid: texture_2d<f32>;

struct HorizonPyramidParams {
  // (world X of horizon texel 0 centre, world Z of same, horizon texel size,
  //  march growth ratio)
  placement: vec4f,
  // (height pyramid origin X, height pyramid origin Z, unused, unused)
  source: vec4f,
};

@group(0) @binding(1) var<storage, read> horizonParams: HorizonPyramidParams;
@group(0) @binding(2) var horizonPyramidA: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var horizonPyramidB: texture_storage_2d<rgba8unorm, write>;

/**
 * The composition hole the shared march requires.
 *
 * It reads the module-scope params binding directly rather than taking the
 * origin as a parameter, because the shared march deliberately passes no
 * context through — that is what lets a page bake and this one compose the
 * same text. Clamped rather than wrapped: past the pyramid's edge the nearest
 * edge height is the honest answer, and it is exactly what the page bake's own
 * out-of-page path returns.
 */
fn horizonFieldHeightAt(worldX: f32, worldZ: f32) -> f32 {
  let texelX = (worldX - horizonParams.source.x) / ${TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS}.0;
  let texelZ = (worldZ - horizonParams.source.y) / ${TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS}.0;
  let clamped = clamp(
    vec2i(i32(floor(texelX)), i32(floor(texelZ))),
    vec2i(0, 0),
    vec2i(${TERRAIN_HEIGHT_PYRAMID_EDGE - 1}, ${TERRAIN_HEIGHT_PYRAMID_EDGE - 1}),
  );
  return textureLoad(horizonHeightPyramid, clamped, 0).r;
}

${HORIZON_FIELD_MARCH_WGSL}

@compute @workgroup_size(${PYRAMID_WORKGROUP_EDGE}, ${PYRAMID_WORKGROUP_EDGE}, 1)
fn bakeHorizon(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${TERRAIN_HORIZON_PYRAMID_EDGE}u || id.y >= ${TERRAIN_HORIZON_PYRAMID_EDGE}u) {
    return;
  }
  // Texel 0's CENTRE is what the host publishes, so the consumer's
  // world -> texel mapping and this one are the same arithmetic read backwards.
  let texel = horizonParams.placement.z;
  let worldX = horizonParams.placement.x + f32(id.x) * texel;
  let worldZ = horizonParams.placement.y + f32(id.y) * texel;

  let centreHeight = horizonFieldHeightAt(worldX, worldZ);
  var slopes: array<f32, ${HORIZON_FIELD_AZIMUTHS_MARCHED}>;
  horizonFieldMarch(
    worldX,
    worldZ,
    centreHeight,
    ${TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS}.0,
    horizonParams.placement.w,
    &slopes,
  );
  let packed = horizonFieldPack(&slopes);
  let writeTexel = vec2i(i32(id.x), i32(id.y));
  textureStore(horizonPyramidA, writeTexel, packed.a);
  textureStore(horizonPyramidB, writeTexel, packed.b);
}
`;

export class GlobalHeightPyramid {
  private texture: RawTexture | null = null;
  private shader: ComputeShader | null = null;
  private paramsBuffer: StorageBuffer | null = null;
  private pageBuffer: StorageBuffer | null = null;
  private centerTexelX = Number.NaN;
  private centerTexelZ = Number.NaN;
  private baking = false;
  private disposed = false;
  /** `6-11`: the global horizon field's two packed layers. */
  private horizonA: RawTexture | null = null;
  private horizonB: RawTexture | null = null;
  private horizonShader: ComputeShader | null = null;
  private horizonParamsBuffer: StorageBuffer | null = null;
  private horizonBaking = false;
  /**
   * The centre the RESIDENT horizon field was baked for — published only when
   * a bake completes, and therefore allowed to LAG the height pyramid's own
   * centre by one recentre.
   *
   * Lagging is what makes a single-buffered field safe. The alternative is to
   * clear residency the moment the height field moves, which would drop far
   * vegetation to fully lit for the frames between recentre and re-bake —
   * a visible flicker every 512 m of travel, to avoid an error of half a
   * horizon texel in a 131 km field.
   */
  private horizonCenterTexelX = Number.NaN;
  private horizonCenterTexelZ = Number.NaN;

  constructor(
    scene: Scene,
    private readonly engine: AbstractEngine,
    private readonly seedHash: number,
  ) {
    const engineFlags = scene.getEngine() as { isWebGPU?: boolean };
    if (!engineFlags.isWebGPU) return;
    this.texture = RawTexture.CreateRStorageTexture(
      null,
      TERRAIN_HEIGHT_PYRAMID_EDGE,
      TERRAIN_HEIGHT_PYRAMID_EDGE,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT,
    );
    this.texture.name = "terrain-global-height-pyramid";
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    // `6-11`: BILINEAR, for `4.5-A2`'s reason applied one scale coarser. The
    // horizon field is a continuous quantity and this one is 1,024 m/texel —
    // point-sampling it would draw the terminator as kilometre-wide blocks
    // across a forest, which is precisely the artifact fix-pack T8 removed
    // from the page field at 4 m.
    for (const layer of ["A", "B"] as const) {
      const texture = RawTexture.CreateRGBAStorageTexture(
        null,
        TERRAIN_HORIZON_PYRAMID_EDGE,
        TERRAIN_HORIZON_PYRAMID_EDGE,
        scene,
        false,
        false,
        Texture.BILINEAR_SAMPLINGMODE,
      );
      texture.name = `terrain-global-horizon-${layer.toLowerCase()}`;
      texture.wrapU = Texture.CLAMP_ADDRESSMODE;
      texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      if (layer === "A") this.horizonA = texture;
      else this.horizonB = texture;
    }
  }

  get heightTexture(): RawTexture | null {
    return this.texture;
  }

  /** `6-11`: the packed global horizon layers, or null off WebGPU. */
  get horizonTextureA(): RawTexture | null {
    return this.horizonA;
  }

  get horizonTextureB(): RawTexture | null {
    return this.horizonB;
  }

  /** World position of texel (0, 0). NaN until the first bake. */
  get originX(): number {
    return (this.centerTexelX - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
  }

  get originZ(): number {
    return (this.centerTexelZ - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
  }

  get isResident(): boolean {
    return Number.isFinite(this.centerTexelX) && Number.isFinite(this.centerTexelZ);
  }

  /**
   * `6-11`: world position of horizon texel (0, 0)'s CORNER, for the resident
   * field — which may lag the height pyramid by one recentre.
   *
   * The height pyramid and the horizon field are pinned to the same span
   * (`TerrainSpineContract`), so a shared centre texel maps to the same world
   * corner through either texel size. NaN until the first horizon bake.
   */
  get horizonOriginX(): number {
    return (this.horizonCenterTexelX - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
  }

  get horizonOriginZ(): number {
    return (this.horizonCenterTexelZ - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
  }

  get isHorizonResident(): boolean {
    return Number.isFinite(this.horizonCenterTexelX)
      && Number.isFinite(this.horizonCenterTexelZ);
  }

  /**
   * Whether a horizon bake is owed — the height field has moved under the
   * resident horizon field, or nothing has been baked yet.
   *
   * Read by the terrain pump so the dispatch can be ADMITTED rather than
   * issued: this is 25x the height bake's work and it recurs on every 512 m of
   * travel, so it is the one part of the pyramid that a frame can legitimately
   * defer (§1.3, and the reason the whole design fits at all).
   */
  get needsHorizonBake(): boolean {
    if (this.disposed || !this.isResident || this.horizonBaking) return false;
    return this.centerTexelX !== this.horizonCenterTexelX
      || this.centerTexelZ !== this.horizonCenterTexelZ;
  }

  /**
   * Re-bake if the observer has crossed into a new pyramid texel. Returns true
   * when a dispatch was issued.
   */
  async recenter(observerX: number, observerZ: number): Promise<boolean> {
    if (this.disposed || !this.texture || this.baking) return false;
    const texelX = Math.round(observerX / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
    const texelZ = Math.round(observerZ / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
    if (texelX === this.centerTexelX && texelZ === this.centerTexelZ) return false;

    const engine = this.engine as WebGPUEngine;
    // Gate 0-c: storage buffers are invisible to the renderer's inventory.
    if (!this.paramsBuffer) {
      this.paramsBuffer = new StorageBuffer(engine, 16);
      registerGpuBufferBytes(16);
    }
    if (!this.pageBuffer) {
      this.pageBuffer = new StorageBuffer(engine, TERRAIN_KERNEL_PAGE_BYTES);
      registerGpuBufferBytes(TERRAIN_KERNEL_PAGE_BYTES);
    }
    this.shader ??= withoutDispatchTiming(new ComputeShader(
      "terrain-global-height-pyramid",
      engine,
      { computeSource: GLOBAL_HEIGHT_PYRAMID_WGSL },
      {
        entryPoint: "bakePyramid",
        bindingsMapping: {
          terrainKernelPages: { group: 0, binding: 0 },
          pyramidParams: { group: 0, binding: 1 },
          pyramidTarget: { group: 0, binding: 2 },
        },
      },
    ));
    const originX = (texelX - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
    const originZ = (texelZ - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
    // The kernel page origin IS the pyramid origin, so the local offsets the
    // shader forms stay inside one span and the split-origin guarantee holds
    // at the pyramid's scale exactly as it does at a page's.
    this.pageBuffer.update(new Uint8Array(buildTerrainKernelPageUniform({
      seedHash: this.seedHash,
      originX,
      originZ,
      // Band-limited at the pyramid's own texel size.
      filterWidthMeters: TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
    })));
    this.paramsBuffer.update(new Uint8Array(
      new Float32Array([0, 0, TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS, 0]).buffer,
    ));
    this.shader.setStorageBuffer("terrainKernelPages", this.pageBuffer);
    this.shader.setStorageBuffer("pyramidParams", this.paramsBuffer);
    this.shader.setStorageTexture("pyramidTarget", this.texture);

    this.baking = true;
    try {
      const groups = TERRAIN_HEIGHT_PYRAMID_EDGE / PYRAMID_WORKGROUP_EDGE;
      await this.shader.dispatchWhenReady(groups, groups, 1);
      this.centerTexelX = texelX;
      this.centerTexelZ = texelZ;
      return true;
    } finally {
      this.baking = false;
    }
  }

  /**
   * `6-11`: bake the global horizon field for the height pyramid's CURRENT
   * centre. Returns true when a dispatch was issued.
   *
   * ONE dispatch, whole-field, rather than a tiled cross-frame bake. That is
   * what keeps the field single-buffered: a partial rewrite would be visible
   * as a torn terminator, so tiling would force a second 128 KiB copy to read
   * from while the first is written. Whole-field means the only state a
   * consumer ever sees is "the last completed bake", and the cost question
   * moves to the admission meter, where it belongs — a frame that cannot
   * afford this simply keeps last position's field, which is correct to
   * within one recentre.
   *
   * The caller is responsible for admitting the dispatch (`needsHorizonBake`).
   */
  async bakeHorizon(): Promise<boolean> {
    if (!this.needsHorizonBake) return false;
    const heightTexture = this.texture;
    const horizonA = this.horizonA;
    const horizonB = this.horizonB;
    if (!heightTexture || !horizonA || !horizonB) return false;
    const texelX = this.centerTexelX;
    const texelZ = this.centerTexelZ;

    const engine = this.engine as WebGPUEngine;
    // Gate 0-c: storage buffers are invisible to the renderer's inventory.
    if (!this.horizonParamsBuffer) {
      this.horizonParamsBuffer = new StorageBuffer(engine, HORIZON_PARAMS_BYTES);
      registerGpuBufferBytes(HORIZON_PARAMS_BYTES);
    }
    this.horizonShader ??= withoutDispatchTiming(new ComputeShader(
      "terrain-global-horizon-pyramid",
      engine,
      { computeSource: GLOBAL_HORIZON_PYRAMID_WGSL },
      {
        entryPoint: "bakeHorizon",
        bindingsMapping: {
          horizonHeightPyramid: { group: 0, binding: 0 },
          horizonParams: { group: 0, binding: 1 },
          horizonPyramidA: { group: 0, binding: 2 },
          horizonPyramidB: { group: 0, binding: 3 },
        },
      },
    ));

    const originX = (texelX - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
    const originZ = (texelZ - TERRAIN_HEIGHT_PYRAMID_EDGE / 2)
      * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS;
    this.horizonParamsBuffer.update(new Uint8Array(new Float32Array([
      // Horizon texel 0's CENTRE, which is what the march samples about.
      originX + TERRAIN_HORIZON_PYRAMID_TEXEL_METERS * 0.5,
      originZ + TERRAIN_HORIZON_PYRAMID_TEXEL_METERS * 0.5,
      TERRAIN_HORIZON_PYRAMID_TEXEL_METERS,
      // The geometric ratio that lands the last step exactly at the reach,
      // from a first step of one HEIGHT texel — the page bake's rule, applied
      // to this bake's own source.
      Math.pow(
        HORIZON_PYRAMID_REACH_METERS / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
        1 / (HORIZON_FIELD_MARCH_STEPS - 1),
      ),
      // The height pyramid's own origin, so the composition hole's
      // world -> texel mapping needs no second source of truth.
      originX,
      originZ,
      0,
      0,
    ]).buffer));
    this.horizonShader.setTexture("horizonHeightPyramid", heightTexture, false);
    this.horizonShader.setStorageBuffer("horizonParams", this.horizonParamsBuffer);
    this.horizonShader.setStorageTexture("horizonPyramidA", horizonA);
    this.horizonShader.setStorageTexture("horizonPyramidB", horizonB);

    this.horizonBaking = true;
    try {
      const groups = TERRAIN_HORIZON_PYRAMID_EDGE / PYRAMID_WORKGROUP_EDGE;
      await this.horizonShader.dispatchWhenReady(groups, groups, 1);
      // Published only now: until this line the resident field is the previous
      // centre's, and its origin still describes it correctly.
      this.horizonCenterTexelX = texelX;
      this.horizonCenterTexelZ = texelZ;
      return true;
    } finally {
      this.horizonBaking = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.paramsBuffer) releaseGpuBufferBytes(16);
    this.paramsBuffer?.dispose();
    if (this.pageBuffer) releaseGpuBufferBytes(TERRAIN_KERNEL_PAGE_BYTES);
    this.pageBuffer?.dispose();
    if (this.horizonParamsBuffer) releaseGpuBufferBytes(HORIZON_PARAMS_BYTES);
    this.horizonParamsBuffer?.dispose();
    this.texture?.dispose();
    this.horizonA?.dispose();
    this.horizonB?.dispose();
    this.paramsBuffer = null;
    this.pageBuffer = null;
    this.horizonParamsBuffer = null;
    this.texture = null;
    this.horizonA = null;
    this.horizonB = null;
    this.shader = null;
    this.horizonShader = null;
  }
}

/** How far the pyramid reaches from its centre, in metres. */
export const GLOBAL_HEIGHT_PYRAMID_REACH_METERS = TERRAIN_HEIGHT_PYRAMID_SPAN_METERS / 2;
