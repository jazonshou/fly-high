import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PipelineWarmUp } from "@/src/render/webgpu/core/AsyncPipelineCompiles";

/** The part of `AsyncPipelineCompiles` the car's effects use. */
export interface CarPipelineCompiles extends PipelineWarmUp {
  defer(material: object): void;
}

/**
 * A car effect's first dust, print or ford without a pipeline compile in its
 * frame.
 *
 * Each effect's mesh is hidden until it has something to show, and WebGPU
 * builds a mesh's render pipeline at its first draw, inside that frame. So
 * from spawn each effect draws while it is still empty (every record, or the
 * whole skirt, collapses in its vertex stage, so nothing rasterises) until its
 * pipeline exists. With the renderer's off-frame compiles the material is
 * deferred and the prime lasts until their warm-up reports it built, which
 * compiles it on the browser's worker thread; a capture's synchronous mode
 * declines the warm-up, and the effect then compiles at its first draw as it
 * always has. Without them the prime is one frame, which compiles at spawn.
 */
export class CarPipelinePrime {
  private readonly compiles: CarPipelineCompiles | null;
  private primed = false;

  constructor(compiles: CarPipelineCompiles | null) {
    this.compiles = compiles;
  }

  /** A new mesh and material (a new budget): deferred with the compiles, and primed again. */
  adopt(material: object): void {
    this.compiles?.defer(material);
    this.primed = false;
  }

  /** Whether `mesh` draws empty this frame. */
  wanted(mesh: Mesh): boolean {
    if (this.primed) return false;
    if (!this.compiles) {
      this.primed = true;
      return true;
    }
    const status = this.compiles.warmUp(mesh, false);
    if (status === "warm" || status === "declined") {
      this.primed = true;
      return false;
    }
    return true;
  }
}
