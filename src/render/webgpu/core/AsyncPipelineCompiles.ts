import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import { WebGPUTextureHelper } from "@babylonjs/core/Engines/WebGPU/webgpuTextureHelper";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Render pipelines for the near-ground scenery, compiled OFF the frame.
 *
 * THE FREEZE (measured 2026-10-27, `perf:flight --pitch-down`). Babylon
 * 9.21.2 builds a render pipeline the first time a draw needs it, inside the
 * draw, with the synchronous `GPUDevice.createRenderPipeline`. The GPU process
 * then compiles the whole shader (a detail PBR is ~120 KiB of WGSL) before it
 * runs anything else, so that frame waits for the compile. Every detail
 * material gets a pipeline of its own, and the near-ground ones (stumps, logs,
 * moss, litter, rocks, shrubs, the grass blades) stand inside the near band,
 * which in level flight at a few hundred feet is below the bottom of the
 * chase camera's view. So the first time the pilot points the nose at the
 * ground, the first stump in view compiles in that frame: on the macOS
 * runner's GPU (Metal, draws on, a fence every frame) that frame took 0.7 to
 * 1.7 s against a 30-60 ms median: the stump at 13 degrees nose-down from
 * 150 m, a limestone rock at 45 degrees from 60 m, moss and the blades level
 * at 60 m, granite in the far east. Once per material per session, hence
 * "sometimes".
 *
 * THE FIX, in two halves:
 *  1. A draw of a registered material whose pipeline is not built yet does
 *     not build it. It starts `createRenderPipelineAsync` with the exact
 *     descriptor Babylon would have used (the browser compiles it on a
 *     worker thread) and skips that one draw; the pipeline joins Babylon's
 *     own cache when it resolves, and the next draw finds it there. The
 *     object appears a moment late instead of the frame stopping, and only
 *     once per pipeline.
 *  2. `warmUp` draws a mesh wherever it is, in view or not, until a frame
 *     draws it with every pipeline it needs, so the compile in (1) starts
 *     when the scenery streams in around the aircraft rather than when it
 *     first scrolls into view. A draw outside the view is clipped; it costs
 *     its vertex work once. One mesh per material and vertex layout warms up:
 *     the others share its pipelines.
 *
 * Only draws whose skip is harmless go through (1): materials registered with
 * `defer`. A bake that draws once, a post-process or the terrain keep
 * Babylon's synchronous path. A pipeline the device refuses asynchronously is
 * built the synchronous way at its next draw, so the error reaches the
 * uncaptured-error guard exactly as before.
 *
 * Captures: `setSynchronous(true)` restores the synchronous path (the
 * capture's time pin calls it, so its frames compile as the baselines did),
 * and `whenIdle()` resolves when no compile is pending.
 *
 * The private Babylon surface used here is pinned by
 * `tests/render.webgpu-async-pipeline-compiles.test.ts`, which reads the
 * shipped sources; `AsyncPipelineCompiles.install` returns null, leaving
 * Babylon untouched, when any of it is missing.
 */

/** Thrown from the pipeline lookup to abandon the draw that asked; never escapes `_draw`. */
const DEFERRED_DRAW: unique symbol = Symbol("fly-high: draw deferred until its pipeline compiles");

/** Rendered frames a warm-up may wait to be drawn before it gives up (the mesh was hidden or culled away). */
export const PIPELINE_WARM_UP_FRAME_LIMIT = 120;

/** A node of Babylon's pipeline cache tree: the token of one pipeline state. */
interface PipelineToken {
  pipeline?: GPURenderPipeline | null;
}

interface CacheParameter {
  token?: PipelineToken;
  pipeline?: GPURenderPipeline | null;
}

/** `WebGPUCacheRenderPipeline`'s members this module calls (9.21.2). */
interface RenderPipelineCacheLike {
  disabled: boolean;
  _parameter: CacheParameter;
  getRenderPipeline(fillMode: number, effect: unknown, sampleCount: number, textureState?: number): GPURenderPipeline;
  _lookupRenderPipeline(fillMode: number, effect: unknown, sampleCount: number, textureState: number): GPURenderPipeline | null;
  _buildRenderPipelineDescriptor(effect: unknown, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor;
  _setRenderPipeline(param: CacheParameter): void;
}

interface EngineLike {
  _device?: GPUDevice;
  _cacheRenderPipeline?: RenderPipelineCacheLike;
  _draw?: (...args: unknown[]) => void;
}

/** Why `install` declined: the members of Babylon's private surface that are missing. */
export function missingAsyncPipelineSurface(engine: unknown): string[] {
  const candidate = engine as EngineLike | null | undefined;
  const missing: string[] = [];
  const cache = candidate?._cacheRenderPipeline;
  if (typeof candidate?._device?.createRenderPipelineAsync !== "function") missing.push("_device.createRenderPipelineAsync");
  if (typeof candidate?._draw !== "function") missing.push("_draw");
  if (!cache) {
    missing.push("_cacheRenderPipeline");
  } else {
    for (const name of [
      "getRenderPipeline",
      "_lookupRenderPipeline",
      "_buildRenderPipelineDescriptor",
      "_setRenderPipeline",
    ] as const) {
      if (typeof cache[name] !== "function") missing.push(`_cacheRenderPipeline.${name}`);
    }
    if (typeof cache._parameter !== "object" || cache._parameter === null) missing.push("_cacheRenderPipeline._parameter");
  }
  if (typeof (Mesh.prototype as unknown as Record<string, unknown>)["_processRendering"] !== "function") {
    missing.push("Mesh.prototype._processRendering");
  }
  if (typeof (WebGPUCacheRenderPipeline as unknown as Record<string, unknown>)["_GetTopology"] !== "function") {
    missing.push("WebGPUCacheRenderPipeline._GetTopology");
  }
  return missing;
}

export interface AsyncPipelineCompileStatistics {
  /** Pipelines compiled with `createRenderPipelineAsync` instead of in a frame. */
  readonly compilesStarted: number;
  readonly compilesFinished: number;
  /** Refused asynchronously; each is built synchronously at its next draw. */
  readonly compilesFailed: number;
  readonly compilesPending: number;
  /** Draws skipped because their pipeline was still compiling. */
  readonly deferredDraws: number;
  /** The longest compile, request to resolution, in ms of this page's clock. */
  readonly maxCompileMilliseconds: number;
  /** Warm-ups asked for, completed (drawn with every pipeline ready) and abandoned (not drawn in time). */
  readonly warmUpsStarted: number;
  readonly warmUpsCompleted: number;
  readonly warmUpsAbandoned: number;
}

/**
 * What `warmUp` did: "warm" (pipelines for this material and vertex layout
 * already proved ready), "started", "warming" (another mesh of the same key
 * is warming), "declined" (not a registered material, or capture mode).
 */
export type PipelineWarmUpStatus = "warm" | "started" | "warming" | "declined";

/** The part of `AsyncPipelineCompiles` a scenery system needs. */
export interface PipelineWarmUp {
  warmUp(mesh: Mesh, castsShadows: boolean): PipelineWarmUpStatus;
}

interface WarmUp {
  readonly mesh: Mesh;
  readonly key: string;
  readonly alwaysSelectBefore: boolean;
  framesLeft: number;
  drawn: boolean;
  deferred: boolean;
}

/** Each registered material's owner, for the mesh hook (one hook serves every engine). */
const ownerByMaterial = new WeakMap<object, AsyncPipelineCompiles>();
let meshHookInstalled = false;

function installMeshHook(): void {
  if (meshHookInstalled) return;
  meshHookInstalled = true;
  const prototype = Mesh.prototype as unknown as Record<string, unknown>;
  const original = prototype["_processRendering"] as (this: Mesh, ...args: unknown[]) => unknown;
  // Every draw of a mesh, in every pass (the scene, shadow maps, render
  // targets), runs through here; a registered material's draw is marked so
  // the pipeline lookup below knows it may wait.
  prototype["_processRendering"] = function (this: Mesh, ...args: unknown[]) {
    const material = this.material;
    const owner = material ? ownerByMaterial.get(material) : undefined;
    if (!owner) return original.apply(this, args);
    return owner.drawDeferrable(this, () => original.apply(this, args));
  };
}

/** A mesh's vertex streams, which with its material decide its pipelines. */
function vertexLayoutKey(mesh: Mesh): string {
  const kinds = mesh.getVerticesDataKinds().slice().sort();
  return kinds.map((kind) => {
    const buffer = mesh.getVertexBuffer(kind);
    return buffer
      ? `${kind}:${buffer.type}:${buffer.getSize()}:${buffer.byteStride}:${buffer.byteOffset}:${buffer.getIsInstanced() ? 1 : 0}:${buffer.normalized ? 1 : 0}`
      : kind;
  }).join(",");
}

export class AsyncPipelineCompiles implements PipelineWarmUp {
  private readonly device: GPUDevice;
  private readonly cache: RenderPipelineCacheLike;
  private readonly engine: EngineLike;
  private readonly originalGetRenderPipeline: RenderPipelineCacheLike["getRenderPipeline"];
  private readonly originalDraw: (...args: unknown[]) => void;
  private readonly now: () => number;
  private readonly frameObserver: Observer<Scene> | null;
  private readonly scene: Scene;
  private readonly materials = new Set<object>();
  private readonly pending = new Map<PipelineToken, Promise<void>>();
  private readonly failed = new WeakSet<PipelineToken>();
  private readonly warmUps = new Map<AbstractMesh, WarmUp>();
  /** Material x vertex layout x shadow casting: warm, or a warm-up under way. */
  private readonly warmKeys = new Set<string>();
  private readonly warmingKeys = new Set<string>();
  /** The registered mesh whose draw is being encoded; null outside one. */
  private drawing: AbstractMesh | null = null;
  private synchronous = false;
  private disposed = false;
  private stats = {
    compilesStarted: 0,
    compilesFinished: 0,
    compilesFailed: 0,
    deferredDraws: 0,
    maxCompileMilliseconds: 0,
    warmUpsStarted: 0,
    warmUpsCompleted: 0,
    warmUpsAbandoned: 0,
  };

  /**
   * Hooks `engine`'s draws, or returns null (Babylon untouched) when the
   * private surface this needs is missing (`missingAsyncPipelineSurface`).
   */
  static install(scene: Scene, now: () => number = () => performance.now()): AsyncPipelineCompiles | null {
    const engine = scene.getEngine() as unknown as EngineLike;
    if (missingAsyncPipelineSurface(engine).length > 0) return null;
    return new AsyncPipelineCompiles(scene, engine, now);
  }

  private constructor(scene: Scene, engine: EngineLike, now: () => number) {
    this.scene = scene;
    this.engine = engine;
    this.device = engine._device!;
    this.cache = engine._cacheRenderPipeline!;
    this.now = now;
    installMeshHook();
    const cache = this.cache;
    this.originalGetRenderPipeline = cache.getRenderPipeline;
    cache.getRenderPipeline = (fillMode, effect, sampleCount, textureState = 0) => {
      if (this.drawing === null || this.synchronous || cache.disabled) {
        return this.originalGetRenderPipeline.call(cache, fillMode, effect, sampleCount, textureState);
      }
      return this.lookUpOrCompile(fillMode, effect, sampleCount, textureState);
    };
    this.originalDraw = engine._draw!;
    engine._draw = (...args: unknown[]) => {
      if (this.drawing === null) return this.originalDraw.apply(engine, args);
      try {
        return this.originalDraw.apply(engine, args);
      } catch (error) {
        // Thrown by the lookup before the draw recorded anything: no pipeline,
        // bind group or bundle was made, so the next draw starts clean.
        if (error !== DEFERRED_DRAW) throw error;
        this.stats.deferredDraws += 1;
        const warmUp = this.warmUps.get(this.drawing);
        if (warmUp) warmUp.deferred = true;
      }
    };
    this.frameObserver = scene.onAfterRenderObservable.add(() => this.advanceWarmUps());
  }

  /** Draws of meshes with this material may wait for their pipeline instead of compiling it in the frame. */
  defer(material: object): void {
    if (this.disposed) return;
    this.materials.add(material);
    ownerByMaterial.set(material, this);
  }

  /**
   * Draws `mesh` wherever it is until a frame draws it with every pipeline it
   * needs (outside the view the draw is clipped), then restores its
   * `alwaysSelectAsActiveMesh`. A mesh whose material and vertex layout are
   * already warm, or warming, is left alone. `castsShadows` keys the warm-up
   * apart from a mesh of the same material that draws in no shadow map. A
   * warm-up the mesh is not drawn for within `PIPELINE_WARM_UP_FRAME_LIMIT`
   * frames (hidden, culled away, disposed) is abandoned, and the next mesh of
   * its key may try.
   */
  warmUp(mesh: Mesh, castsShadows: boolean): PipelineWarmUpStatus {
    if (this.disposed || this.synchronous || !mesh.material || !this.materials.has(mesh.material)) return "declined";
    if (this.warmUps.has(mesh)) return "warming";
    const key = `${mesh.material.uniqueId}|${castsShadows ? 1 : 0}|${mesh.receiveShadows ? 1 : 0}|${vertexLayoutKey(mesh)}`;
    if (this.warmKeys.has(key)) return "warm";
    if (this.warmingKeys.has(key)) return "warming";
    this.warmingKeys.add(key);
    this.warmUps.set(mesh, {
      mesh,
      key,
      alwaysSelectBefore: mesh.alwaysSelectAsActiveMesh,
      framesLeft: PIPELINE_WARM_UP_FRAME_LIMIT,
      drawn: false,
      deferred: false,
    });
    mesh.alwaysSelectAsActiveMesh = true;
    this.stats.warmUpsStarted += 1;
    return "started";
  }

  /**
   * Capture mode: every pipeline is built in the frame that asks, as before
   * this module (the capture's baselines were made that way). Warm-ups end.
   */
  setSynchronous(synchronous: boolean): void {
    this.synchronous = synchronous;
    if (synchronous) for (const warmUp of [...this.warmUps.values()]) this.endWarmUp(warmUp, false);
  }

  /** Resolves once no compile is pending (one started meanwhile is waited for too). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending.values());
  }

  get statistics(): AsyncPipelineCompileStatistics {
    return { ...this.stats, compilesPending: this.pending.size };
  }

  /** Runs one registered mesh's draw with the deferral armed (`installMeshHook`). */
  drawDeferrable(mesh: AbstractMesh, draw: () => unknown): unknown {
    if (this.disposed) return draw();
    const outer = this.drawing;
    this.drawing = mesh;
    const warmUp = this.warmUps.get(mesh);
    if (warmUp) warmUp.drawn = true;
    try {
      return draw();
    } finally {
      this.drawing = outer;
    }
  }

  private lookUpOrCompile(fillMode: number, effect: unknown, sampleCount: number, textureState: number): GPURenderPipeline {
    const cache = this.cache;
    // As `getRenderPipeline`: the cache keys the sample count WebGPU allows.
    const samples = WebGPUTextureHelper.GetSample(sampleCount);
    const cached = cache._lookupRenderPipeline(fillMode, effect, samples, textureState);
    if (cached) return cached;
    const token = cache._parameter.token;
    if (!token || this.failed.has(token)) {
      // No token to file it under, or the device refused it asynchronously:
      // the synchronous path, whose error the uncaptured-error guard sees.
      return this.originalGetRenderPipeline.call(cache, fillMode, effect, sampleCount, textureState);
    }
    if (!this.pending.has(token)) this.compile(token, fillMode, effect, samples);
    throw DEFERRED_DRAW;
  }

  private compile(token: PipelineToken, fillMode: number, effect: unknown, samples: number): void {
    const topology = (WebGPUCacheRenderPipeline as unknown as {
      _GetTopology(fillMode: number): GPUPrimitiveTopology;
    })._GetTopology(fillMode);
    // Built now, from the cache's state for this draw: the same descriptor
    // the synchronous path would have built.
    const descriptor = this.cache._buildRenderPipelineDescriptor(effect, topology, samples);
    const started = this.now();
    this.stats.compilesStarted += 1;
    const promise = this.device.createRenderPipelineAsync(descriptor).then(
      (pipeline) => {
        this.pending.delete(token);
        if (this.disposed) return;
        // A capture's synchronous draw may have built it meanwhile.
        if (!token.pipeline) this.cache._setRenderPipeline({ token, pipeline });
        this.stats.compilesFinished += 1;
        this.stats.maxCompileMilliseconds = Math.max(this.stats.maxCompileMilliseconds, this.now() - started);
      },
      () => {
        this.pending.delete(token);
        this.failed.add(token);
        this.stats.compilesFailed += 1;
      },
    );
    this.pending.set(token, promise);
  }

  /** After each render: a warm-up drawn with no draw deferred is done; one not drawn runs down its frames. */
  private advanceWarmUps(): void {
    for (const warmUp of [...this.warmUps.values()]) {
      if (warmUp.mesh.isDisposed()) {
        this.endWarmUp(warmUp, false);
      } else if (warmUp.drawn && !warmUp.deferred) {
        this.endWarmUp(warmUp, true);
      } else if (!warmUp.drawn && --warmUp.framesLeft <= 0) {
        this.endWarmUp(warmUp, false);
      } else {
        warmUp.drawn = false;
        warmUp.deferred = false;
      }
    }
  }

  private endWarmUp(warmUp: WarmUp, ready: boolean): void {
    this.warmUps.delete(warmUp.mesh);
    this.warmingKeys.delete(warmUp.key);
    if (ready) {
      this.warmKeys.add(warmUp.key);
      this.stats.warmUpsCompleted += 1;
    } else {
      this.stats.warmUpsAbandoned += 1;
    }
    if (!warmUp.mesh.isDisposed()) warmUp.mesh.alwaysSelectAsActiveMesh = warmUp.alwaysSelectBefore;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const warmUp of [...this.warmUps.values()]) this.endWarmUp(warmUp, false);
    this.disposed = true;
    this.cache.getRenderPipeline = this.originalGetRenderPipeline;
    this.engine._draw = this.originalDraw;
    if (this.frameObserver) this.scene.onAfterRenderObservable.remove(this.frameObserver);
    for (const material of this.materials) {
      if (ownerByMaterial.get(material) === this) ownerByMaterial.delete(material);
    }
    this.materials.clear();
  }
}

/** `ComputeShader`'s and `WebGPUComputePipelineContext`'s members `precompileComputePipeline` reads (9.21.2). */
interface ComputeShaderLike {
  _engine?: { _device?: GPUDevice };
  _effect?: {
    _useExplicitComputePipelineLayout?: boolean;
    getPipelineContext(): { stage?: GPUProgrammableStage; computePipeline?: GPUComputePipeline } | null;
  };
}

/** Pipeline contexts with an asynchronous compile under way, or refused. */
const computeCompiles = new WeakMap<object, "pending" | "failed">();

/**
 * Builds a compute shader's pipeline with `createComputePipelineAsync` ahead
 * of its first dispatch, which in Babylon 9.21.2 builds it synchronously
 * (`_computeDispatch`) and stops that frame for the compile exactly as a
 * render pipeline did: the blades' placement kernel took 0.4-0.7 s on the
 * macOS runner's GPU the first time the aircraft came down to the grass. The
 * descriptor is the one the dispatch would build (the effect's stage, the
 * "auto" layout), and the pipeline goes in the slot the dispatch reads.
 *
 * "pending" while the effect or the compile is under way (call again),
 * "ready" once the pipeline is in place, "unsupported" when it cannot help:
 * an explicit layout (built from the bindings at the dispatch), a refused
 * compile, or a Babylon surface that has moved. A dispatch before the
 * compile lands builds the pipeline itself, as before.
 */
export function precompileComputePipeline(shader: ComputeShader): "ready" | "pending" | "unsupported" {
  // Compiles the shader module the first time; the pipeline is the slow part.
  if (!shader.isReady()) return "pending";
  const internals = shader as unknown as ComputeShaderLike;
  const effect = internals._effect;
  const device = internals._engine?._device;
  const context = typeof effect?.getPipelineContext === "function" ? effect.getPipelineContext() : null;
  if (!context?.stage || typeof device?.createComputePipelineAsync !== "function" || effect?._useExplicitComputePipelineLayout) {
    return "unsupported";
  }
  if (context.computePipeline) return "ready";
  const state = computeCompiles.get(context);
  if (state) return state === "pending" ? "pending" : "unsupported";
  computeCompiles.set(context, "pending");
  device.createComputePipelineAsync({ layout: "auto", compute: context.stage }).then(
    (pipeline) => {
      computeCompiles.delete(context);
      // A dispatch may have built it meanwhile; its bind groups are made
      // against that one.
      if (!context.computePipeline) context.computePipeline = pipeline;
    },
    () => computeCompiles.set(context, "failed"),
  );
  return "pending";
}
