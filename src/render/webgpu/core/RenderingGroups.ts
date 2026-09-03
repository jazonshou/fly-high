import type { Scene } from "@babylonjs/core/scene";

/**
 * The renderer's rendering-group order — the ONE place it is written down.
 *
 * Babylon draws groups in ascending id, opaque meshes then alpha-blended ones
 * within each, and by default CLEARS depth before every non-zero group. Two
 * owners depend on the order and on that clear being withheld:
 *
 *   0  the opaque world: terrain, the airframe's skin, detail, the cloud shell.
 *   1  water: the spectral ocean and the inland surfaces. Drawn after every
 *      opaque surface so a transparent sheet can feather against the bed it
 *      covers and be depth-tested away above the waterline (D-12).
 *   2  the translucent airframe: canopy glass, the propeller blur disc and its
 *      fading blades. Those materials self-sort through a depth PRE-PASS, and a
 *      pre-pass writes depth — so anything drawn after them into a shared depth
 *      buffer is cut out behind them. While they lived in group 0 the sea was
 *      exactly that thing: the disc in front of a cockpit camera holed the
 *      ocean out to the horizon and the seabed drawn earlier showed through the
 *      hole. Drawn after the water, the pre-pass can no longer touch it and the
 *      glass composites over the sea in the order the eye expects.
 */
export const OPAQUE_RENDERING_GROUP_ID = 0;
export const WATER_RENDERING_GROUP_ID = 1;
export const AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID = 2;

/**
 * Carry the opaque world's depth into `groupId` instead of Babylon's default
 * clear. The group boundary and its stencil clear are kept; only the depth
 * clear is withheld, so the contract is exactly as broad as occlusion needs
 * (`autoClear = false` would preserve stencil as a side effect). Idempotent:
 * every owner of a non-zero group calls it from its own constructor, so a
 * newly built owner cannot silently restore Babylon's default assumption.
 */
export function keepOpaqueDepthForRenderingGroup(scene: Scene, groupId: number): void {
  if (!Number.isInteger(groupId) || groupId <= 0) {
    throw new RangeError("Only a non-zero rendering group can inherit the opaque depth");
  }
  scene.setRenderingAutoClearDepthStencil(groupId, true, false, true);
}
