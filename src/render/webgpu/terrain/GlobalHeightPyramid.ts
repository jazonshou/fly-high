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
} from "./TerrainSpineContract";
import { withoutDispatchTiming } from "../core/GpuTimingPolicy";

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

export class GlobalHeightPyramid {
  private texture: RawTexture | null = null;
  private shader: ComputeShader | null = null;
  private paramsBuffer: StorageBuffer | null = null;
  private pageBuffer: StorageBuffer | null = null;
  private centerTexelX = Number.NaN;
  private centerTexelZ = Number.NaN;
  private baking = false;
  private disposed = false;

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
  }

  get heightTexture(): RawTexture | null {
    return this.texture;
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
   * Re-bake if the observer has crossed into a new pyramid texel. Returns true
   * when a dispatch was issued.
   */
  async recenter(observerX: number, observerZ: number): Promise<boolean> {
    if (this.disposed || !this.texture || this.baking) return false;
    const texelX = Math.round(observerX / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
    const texelZ = Math.round(observerZ / TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
    if (texelX === this.centerTexelX && texelZ === this.centerTexelZ) return false;

    const engine = this.engine as WebGPUEngine;
    this.paramsBuffer ??= new StorageBuffer(engine, 16);
    this.pageBuffer ??= new StorageBuffer(engine, TERRAIN_KERNEL_PAGE_BYTES);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.paramsBuffer?.dispose();
    this.pageBuffer?.dispose();
    this.texture?.dispose();
    this.paramsBuffer = null;
    this.pageBuffer = null;
    this.texture = null;
    this.shader = null;
  }
}

/** How far the pyramid reaches from its centre, in metres. */
export const GLOBAL_HEIGHT_PYRAMID_REACH_METERS = TERRAIN_HEIGHT_PYRAMID_SPAN_METERS / 2;
