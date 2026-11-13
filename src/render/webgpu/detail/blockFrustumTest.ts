import type { Plane } from "@babylonjs/core/Maths/math.plane";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { detailCullBlocksIntersectFrustum } from "./instanceFormat";

/** A batch with no block list: its whole box decides alone. */
export const DETAIL_NO_CULL_BLOCKS = new Float64Array(0);

/** What the test reads each time it runs; a publication swaps the list. */
export interface DetailBlockCullSource {
  cullBlocks: Float64Array;
}

/**
 * Gives a detail batch mesh a frustum test in two steps: Babylon's own, on
 * the one box over every instance, and then the batch's culling blocks.
 *
 * A batch is a prototype's instances over a whole 4,096 m presentation chunk,
 * and its box is the chunk's width and the terrain's height. The chunk the
 * camera stands in contains the eye, so every batch in it passed the box test
 * whichever way the camera looked, and a batch strung along a ridge passed
 * with every instance off screen. At the mountain close-up 39 batches were
 * drawn and seven had an instance in view; a draw call is the unit of cost on
 * every adapter measured (docs/PERFORMANCE.md, "Culling a batch by blocks").
 *
 * The second step can only turn a yes into a no, and only when no block's box
 * touches the frustum. Every instance's own bound lies inside one block
 * (`DetailInstanceBounds`), so a batch it rejects had nothing to rasterise:
 * the picture is the same and the draw is not submitted. It is installed on
 * the instance, not by a subclass, because the scene's active-mesh pass and
 * `Camera.isInFrustum` both call `mesh.isInFrustum(planes)` and each hands
 * over the planes it means; render-target lists (the shadow casters) do not
 * frustum-test their meshes at all, so a caster behind the camera still
 * casts.
 */
export function installDetailBlockFrustumTest(
  mesh: Pick<Mesh, "isInFrustum" | "getWorldMatrix">,
  source: DetailBlockCullSource,
): void {
  const wholeBoxInFrustum = mesh.isInFrustum.bind(mesh);
  mesh.isInFrustum = (frustumPlanes: Plane[]): boolean => {
    if (!wholeBoxInFrustum(frustumPlanes)) return false;
    const blocks = source.cullBlocks;
    if (blocks.length === 0) return true;
    const world = mesh.getWorldMatrix().m;
    // Records are placed by a translation alone (the floating-origin
    // compensation), which is all the blocks are moved by. Anything else and
    // the block boxes are not where the instances are: leave the box's yes.
    if (
      world[0] !== 1 || world[1] !== 0 || world[2] !== 0
      || world[4] !== 0 || world[5] !== 1 || world[6] !== 0
      || world[8] !== 0 || world[9] !== 0 || world[10] !== 1
    ) {
      return true;
    }
    return detailCullBlocksIntersectFrustum(
      blocks,
      frustumPlanes,
      world[12]!,
      world[13]!,
      world[14]!,
    );
  };
}
