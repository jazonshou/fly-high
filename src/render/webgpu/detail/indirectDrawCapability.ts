import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { WebGPUDataBuffer } from "@babylonjs/core/Meshes/WebGPU/webgpuDataBuffer";
import type { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { DataBuffer } from "@babylonjs/core/Buffers/dataBuffer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { withoutDispatchTiming } from "../core/GpuTimingPolicy";
import { GROUND_COVER_INDIRECT_PUBLISH_WGSL } from "./groundCoverWgsl";

/**
 * `6-9` / `RENDERING_PLAN.md` §7 **R4** — the private Babylon surface a
 * GPU-written instance count depends on, behind one loud assertion.
 *
 * R4, verbatim in its consequences:
 *
 * - `_currentDrawContext.indirectDrawBuffer` and `setIndirectData`'s
 *   instance-count early-return are **verified present in 9.21.2 and are not
 *   public API**. `@babylonjs/core` is therefore pinned to an exact version
 *   (`package.json`), and `tests/render.webgpu-ground-cover-cull.test.ts`
 *   reads the shipped Babylon sources so a version bump fails in CI rather
 *   than silently in the renderer.
 * - `indirectDrawBuffer` lives on a **per-DrawWrapper, per-render-pass-id**
 *   `WebGPUDrawContext`. A mesh drawn in the main pass, N shadow cascades and
 *   a reflection pass has a DIFFERENT indirect buffer per pass, each with its
 *   own `_currentInstanceCount`, so writing one from compute fixes exactly
 *   ONE pass. This module therefore resolves the MAIN pass's draw context and
 *   nothing else; every other pass keeps the mesh's `forcedInstanceCount`,
 *   which is the conservative count R4 prescribes.
 * - **The CPU-readback count is the default path**, not this. Indirect is an
 *   optimisation that removes the readback's two-frame latency and its
 *   safety margin; it is opt-in, and when it is asked for and the private
 *   surface has moved, `assertIndirectInstanceCountSupported` throws with the
 *   names of the fields that went missing instead of degrading quietly.
 *
 * The early-return is what makes the whole trick work and is worth stating
 * plainly: `setIndirectData` returns without touching the buffer when the
 * instance count it is handed equals `_currentInstanceCount`. Keeping the
 * mesh's `forcedInstanceCount` PINNED at capacity therefore means Babylon
 * writes the indirect buffer exactly once and never overwrites the count the
 * compute pass put there.
 */

/**
 * Babylon's DEFAULT render pass id (`Constants.RENDERPASS_MAIN`).
 *
 * **It is not the id the main pass draws under, and finding that out on the
 * device is the sharpest thing `6-9` learned about R4.** `Camera` allocates
 * its own pass id in its constructor (`engine.createRenderPassId`), and
 * `Scene.render` sets `engine.currentRenderPassId =
 * activeCamera.outputRenderTarget?.renderPassId ?? activeCamera.renderPassId`
 * before drawing. Probed on a real adapter, a blade mesh carried TWO draw
 * wrappers — id 0 with `useInstancing: false` and id 1 (the camera's) with
 * `useInstancing: true` — and both had an `indirectDrawBuffer`. Writing id
 * 0's from compute therefore "succeeds" completely: a real buffer gets a
 * real count, and the pass that actually draws never reads it. R4's warning
 * that a per-pass indirect buffer fixes exactly ONE pass has a sharper edge
 * than it looks — it can fix a pass that does not exist. This constant is
 * kept only as the fallback for a scene with no active camera.
 */
export const MAIN_RENDER_PASS_ID = 0;

/** u32 words in a WebGPU indexed indirect draw: the buffer is 20 bytes. */
export const INDIRECT_DRAW_WORDS = 5;
export const INDIRECT_DRAW_BYTES = INDIRECT_DRAW_WORDS * 4;

/** The one word a GPU-driven cull writes. */
export const INDIRECT_INSTANCE_COUNT_WORD = 1;

interface DrawContextLike {
  enableIndirectDraw?: boolean;
  indirectDrawBuffer?: GPUBuffer;
  setIndirectData?: (
    indexOrVertexCount: number,
    instanceCount: number,
    firstIndexOrVertex: number,
    forceUpdate?: boolean,
  ) => void;
}

interface DrawWrapperLike {
  drawContext?: DrawContextLike;
}

interface SubMeshLike {
  _getDrawWrapper?: (passId?: number, createIfNotExisting?: boolean) => DrawWrapperLike | undefined;
}

interface CameraLike {
  renderPassId?: number;
  outputRenderTarget?: { renderPassId?: number } | null;
}

/**
 * The render-pass id the scene's beauty pass actually draws under.
 *
 * Mirrors `Scene.render`'s own expression, deliberately including the
 * `outputRenderTarget` branch: the shipping renderer draws the beauty pass
 * into an RTT for its hand-built post chain, and that target carries a pass
 * id of its own.
 */
export function mainRenderPassId(
  scene: { activeCamera?: CameraLike | null } | null | undefined,
): number {
  const camera = scene?.activeCamera;
  if (!camera) return MAIN_RENDER_PASS_ID;
  return camera.outputRenderTarget?.renderPassId
    ?? camera.renderPassId
    ?? MAIN_RENDER_PASS_ID;
}

export interface IndirectDrawProbe {
  readonly supported: boolean;
  /** Names of the private members that are missing, in probe order. */
  readonly missing: readonly string[];
}

/**
 * Probe the private surface WITHOUT a live draw context.
 *
 * Called at construction so the failure is a startup failure, not a
 * first-frame one. It cannot see whether a particular mesh has a main-pass
 * wrapper yet — nothing has rendered — so it checks the class contract:
 * `WebGPUDrawContext` must still declare the two members, and Babylon's
 * `WebGPUDataBuffer` must still be constructible around a raw `GPUBuffer`,
 * which is how the indirect buffer is bound as a compute storage target.
 */
export function probeIndirectInstanceCountSupport(
  drawContextPrototype: object | null | undefined,
): IndirectDrawProbe {
  const missing: string[] = [];
  const proto = drawContextPrototype as Record<string, unknown> | null | undefined;
  if (!proto) {
    missing.push("WebGPUDrawContext");
  } else {
    if (typeof (proto as { setIndirectData?: unknown }).setIndirectData !== "function") {
      missing.push("WebGPUDrawContext.prototype.setIndirectData");
    }
    // `indirectDrawBuffer` is an instance field, so the prototype cannot
    // carry it. Its LIFECYCLE is the `enableIndirectDraw` accessor, which is
    // on the prototype and is what allocates the buffer.
    const descriptor = Object.getOwnPropertyDescriptor(proto, "enableIndirectDraw");
    if (!descriptor || typeof descriptor.set !== "function") {
      missing.push("WebGPUDrawContext.prototype.enableIndirectDraw (setter)");
    }
  }
  if (typeof WebGPUDataBuffer !== "function") {
    missing.push("WebGPUDataBuffer");
  }
  return Object.freeze({ supported: missing.length === 0, missing: Object.freeze(missing) });
}

/**
 * The loud half. Throws naming exactly what moved, so a Babylon bump reads as
 * "these two private members are gone" rather than as a black field.
 */
export function assertIndirectInstanceCountSupported(probe: IndirectDrawProbe): void {
  if (probe.supported) return;
  throw new Error(
    "GPU-driven indirect instance counts are unavailable: @babylonjs/core no longer exposes "
    + probe.missing.join(", ")
    + ". §7 R4 makes indirect an OPTIMISATION over the CPU-readback count — turn "
    + "`indirectInstanceCount` off to fall back to the readback path, or update the private-API "
    + "adapter in src/render/webgpu/detail/indirectDrawCapability.ts for the new Babylon version.",
  );
}

/**
 * The MAIN pass's indirect buffer for a mesh, as a bindable `DataBuffer`.
 *
 * Returns null until the mesh has been drawn once (Babylon creates the draw
 * wrapper lazily, on the first render of the pass) — the caller keeps the
 * readback count until then, which is the same degradation the whole feature
 * is designed around. Shadow and reflection passes are deliberately NOT
 * touched: their draw contexts keep `forcedInstanceCount`, and that count is
 * conservative by construction because it is the capacity or the
 * margin-widened readback, never the frustum-culled figure.
 */
export function mainPassIndirectBuffer(
  mesh: Mesh,
  indexCount: number,
  passId: number,
): DataBuffer | null {
  const subMeshes = mesh.subMeshes;
  if (!subMeshes || subMeshes.length !== 1) return null;
  const subMesh = subMeshes[0] as unknown as SubMeshLike;
  // `createIfNotExisting: false` on purpose: a wrapper that does not exist
  // yet means the pass has not drawn this mesh, and fabricating one would
  // bind a buffer the renderer never reaches.
  const wrapper = subMesh._getDrawWrapper?.(passId, false);
  const context = wrapper?.drawContext;
  if (!context || typeof context.setIndirectData !== "function") return null;
  context.enableIndirectDraw = true;
  const raw = context.indirectDrawBuffer;
  if (!raw) return null;
  // Seed the three words the GPU never writes, and pin the instance count at
  // a value Babylon will keep re-supplying so its early-return holds: the
  // engine calls setIndirectData(count, instancesCount || 1, start) every
  // draw, and only a CHANGE in instance count rewrites the buffer.
  context.setIndirectData(indexCount, mesh.forcedInstanceCount, 0, true);
  return new WebGPUDataBuffer(raw, INDIRECT_DRAW_BYTES) as unknown as DataBuffer;
}

/**
 * The one-lane publish pass that copies a compaction counter into the main
 * pass's indirect record.
 *
 * It lives here rather than in `GroundCoverSystem` for one concrete reason:
 * `tests/render.gpu-timing-policy.test.ts` lists the ground-cover placement
 * shader as TIMED ON PURPOSE (its counter feeds `ComputeBudget`), and that
 * list is per FILE. This dispatch has no cost consumer — it is one thread —
 * so it must be untimed, and keeping the two in separate files is what lets
 * both rules be true at once instead of weakening the scan.
 */
export function createIndirectPublishShader(
  engine: AbstractEngine,
  name: string,
  params: UniformBuffer,
  counters: StorageBuffer,
): ComputeShader {
  const shader = withoutDispatchTiming(new ComputeShader(
    name,
    engine as never,
    { computeSource: GROUND_COVER_INDIRECT_PUBLISH_WGSL },
    {
      entryPoint: "publishGroundCoverIndirect",
      bindingsMapping: {
        params: { group: 0, binding: 0 },
        groundCounters: { group: 0, binding: 1 },
        groundIndirect: { group: 0, binding: 2 },
      },
    },
  ));
  shader.setUniformBuffer("params", params);
  shader.setStorageBuffer("groundCounters", counters);
  return shader;
}
