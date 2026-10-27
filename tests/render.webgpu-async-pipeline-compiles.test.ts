import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AsyncPipelineCompiles,
  missingAsyncPipelineSurface,
  PIPELINE_WARM_UP_FRAME_LIMIT,
} from "../src/render/webgpu/core/AsyncPipelineCompiles";
import { readSource } from "./support/sourceText";

/**
 * The pitch-down freeze's fix: near-ground scenery compiles its render
 * pipelines off the frame (`AsyncPipelineCompiles`).
 *
 * Two halves. The first runs the module against a stand-in for the three
 * private Babylon members it hooks (the engine's `_draw`, the pipeline cache,
 * the device), so what it does with each draw is visible: which draws wait,
 * which compile in the frame, when a warm-up ends. The second reads the
 * installed Babylon's sources for the facts those stand-ins assume, so a
 * Babylon upgrade that moves them fails here instead of silently freezing (or
 * corrupting) frames. The real-device proof is
 * `tests/gpu/async-pipeline-compiles.test.ts`.
 */

interface Token {
  pipeline?: { label: string } | null;
}

interface Pending {
  readonly label: string;
  resolve(): void;
  reject(): void;
}

/** A device whose asynchronous compiles finish when the test says so. */
class FakeDevice {
  readonly synchronous: string[] = [];
  readonly pending: Pending[] = [];

  createRenderPipeline(descriptor: { label: string }): { label: string } {
    this.synchronous.push(descriptor.label);
    return { label: descriptor.label };
  }

  createRenderPipelineAsync(descriptor: { label: string }): Promise<{ label: string }> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        label: descriptor.label,
        resolve: () => resolve({ label: descriptor.label }),
        reject: () => reject(new Error(`refused ${descriptor.label}`)),
      });
    });
  }
}

/** Babylon's pipeline cache as far as the module touches it: one token per state. */
class FakeCache {
  disabled = false;
  _parameter: { token?: Token; pipeline?: { label: string } | null } = {};
  private readonly tokens = new Map<string, Token>();

  constructor(private readonly device: FakeDevice) {}

  getRenderPipeline(fillMode: number, effect: { id: string }, sampleCount: number, textureState = 0) {
    const cached = this._lookupRenderPipeline(fillMode, effect, sampleCount, textureState);
    if (cached) return cached;
    this._parameter.pipeline = this.device.createRenderPipeline(
      this._buildRenderPipelineDescriptor(effect, "triangle-list", sampleCount),
    );
    this._setRenderPipeline(this._parameter);
    return this._parameter.pipeline;
  }

  _lookupRenderPipeline(fillMode: number, effect: { id: string }, sampleCount: number, textureState: number) {
    const key = `${effect.id}|${fillMode}|${sampleCount}|${textureState}`;
    let token = this.tokens.get(key);
    if (!token) {
      token = {};
      this.tokens.set(key, token);
    }
    this._parameter.token = token;
    this._parameter.pipeline = token.pipeline ?? null;
    return this._parameter.pipeline;
  }

  _buildRenderPipelineDescriptor(effect: { id: string }, topology: string, sampleCount: number) {
    return { label: `${effect.id}:${topology}:${sampleCount}` };
  }

  _setRenderPipeline(param: { token?: Token; pipeline?: { label: string } | null }) {
    param.token!.pipeline = param.pipeline ?? null;
  }
}

/**
 * Every mesh "draw" in this file: `_processRendering` stands for Babylon's
 * whole submesh render and calls the engine's draw once, with the effect of
 * the mesh's material. Installed before the module's own hook wraps it.
 */
let drawEngine: { _draw(...args: unknown[]): void } | null = null;
const prototype = Mesh.prototype as unknown as Record<string, unknown>;
prototype["_processRendering"] = function (this: Mesh) {
  drawEngine?._draw(0, 0, 0, 36, 1);
  return this;
};

let engine: NullEngine;
let scene: Scene;
let device: FakeDevice;
let cache: FakeCache;
/** What each `_draw` did: the pipeline it drew with. */
let drawn: string[];
let currentEffect: { id: string };
const effects = new WeakMap<object, { id: string }>();

function graftWebGpu(target: NullEngine): void {
  const engineLike = target as unknown as Record<string, unknown>;
  engineLike["_device"] = device;
  engineLike["_cacheRenderPipeline"] = cache;
  engineLike["_draw"] = function (_drawType: number, fillMode: number) {
    const pipeline = cache.getRenderPipeline(fillMode, currentEffect, 1, 0);
    drawn.push(pipeline.label);
  };
}

function box(name: string, material: StandardMaterial): Mesh {
  const mesh = CreateBox(name, { size: 1 }, scene);
  mesh.material = material;
  return mesh;
}

function material(name: string): StandardMaterial {
  const created = new StandardMaterial(name, scene);
  effects.set(created, { id: name });
  return created;
}

/** One mesh draw in one pass, as the scene, a shadow map or a render target would issue it. */
function draw(mesh: Mesh): void {
  currentEffect = effects.get(mesh.material!)!;
  (mesh as unknown as { _processRendering(): void })._processRendering();
}

function endFrame(): void {
  scene.onAfterRenderObservable.notifyObservers(scene);
}

/** Lets resolved compiles' callbacks run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  device = new FakeDevice();
  cache = new FakeCache(device);
  drawn = [];
  graftWebGpu(engine);
  drawEngine = engine as unknown as { _draw(...args: unknown[]): void };
});

afterEach(() => {
  drawEngine = null;
  scene.dispose();
  engine.dispose();
});

describe("AsyncPipelineCompiles against Babylon's private surface", () => {
  it("declines, leaving Babylon untouched, when the surface it hooks is missing", () => {
    const bare = new NullEngine();
    const bareScene = new Scene(bare);
    try {
      expect(missingAsyncPipelineSurface(bare)).toEqual(expect.arrayContaining([
        "_device.createRenderPipelineAsync",
        "_cacheRenderPipeline",
      ]));
      expect(AsyncPipelineCompiles.install(bareScene)).toBeNull();
    } finally {
      bareScene.dispose();
      bare.dispose();
    }
    expect(missingAsyncPipelineSurface(engine)).toEqual([]);
  });

  it("compiles a registered material's pipeline off the frame and skips only the draws that need it", async () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const stump = material("stump");
    compiles.defer(stump);
    const mesh = box("detail-stump", stump);

    draw(mesh);
    // No compile in the frame: one asynchronous compile, and the draw waits.
    expect(device.synchronous).toEqual([]);
    expect(device.pending.map((compile) => compile.label)).toEqual(["stump:triangle-list:1"]);
    expect(drawn).toEqual([]);
    // Drawn again (another pass, the next frame) while it compiles: the same
    // compile serves it, and that draw waits too.
    draw(mesh);
    expect(device.pending).toHaveLength(1);
    expect(compiles.statistics).toMatchObject({ compilesStarted: 1, compilesPending: 1, deferredDraws: 2 });

    device.pending[0]!.resolve();
    await settle();
    draw(mesh);
    expect(drawn).toEqual(["stump:triangle-list:1"]);
    expect(device.synchronous).toEqual([]);
    expect(compiles.statistics).toMatchObject({ compilesFinished: 1, compilesPending: 0, deferredDraws: 2 });
    compiles.dispose();
  });

  it("keeps the synchronous path for unregistered materials and for draws outside a mesh draw", () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const terrain = box("terrain", material("terrain"));
    draw(terrain);
    expect(device.synchronous).toEqual(["terrain:triangle-list:1"]);
    // A post-process or a bake draws through the engine directly.
    currentEffect = { id: "post" };
    (engine as unknown as { _draw(...args: unknown[]): void })._draw(1, 0, 0, 3, 1);
    expect(device.synchronous).toEqual(["terrain:triangle-list:1", "post:triangle-list:1"]);
    expect(device.pending).toEqual([]);
    expect(drawn).toHaveLength(2);
    compiles.dispose();
  });

  it("builds a pipeline the device refused asynchronously in the frame, so its error surfaces as before", async () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const rock = material("rock");
    compiles.defer(rock);
    const mesh = box("detail-rock", rock);
    draw(mesh);
    device.pending[0]!.reject();
    await settle();
    draw(mesh);
    expect(device.synchronous).toEqual(["rock:triangle-list:1"]);
    expect(drawn).toEqual(["rock:triangle-list:1"]);
    expect(compiles.statistics).toMatchObject({ compilesFailed: 1, compilesPending: 0 });
    compiles.dispose();
  });

  it("keeps a pipeline a synchronous draw built while the compile ran", async () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const moss = material("moss");
    compiles.defer(moss);
    const mesh = box("detail-moss", moss);
    draw(mesh);
    compiles.setSynchronous(true);
    draw(mesh);
    expect(device.synchronous).toEqual(["moss:triangle-list:1"]);
    const built = cache._parameter.token!.pipeline;
    device.pending[0]!.resolve();
    await settle();
    expect(cache._parameter.token!.pipeline).toBe(built);
    compiles.dispose();
  });

  it("builds in the frame in capture mode, as the baselines were made, and waits for compiles in flight", async () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const litter = material("litter");
    const log = material("log");
    compiles.defer(litter);
    compiles.defer(log);
    draw(box("detail-litter", litter));
    let idle = false;
    const whenIdle = compiles.whenIdle().then(() => {
      idle = true;
    });
    compiles.setSynchronous(true);
    const logMesh = box("detail-log", log);
    expect(compiles.warmUp(logMesh, false)).toBe("declined");
    draw(logMesh);
    expect(device.synchronous).toEqual(["log:triangle-list:1"]);
    expect(drawn).toEqual(["log:triangle-list:1"]);
    await settle();
    expect(idle).toBe(false);
    device.pending[0]!.resolve();
    await whenIdle;
    expect(idle).toBe(true);
    compiles.dispose();
  });

  it("restores Babylon's own methods on dispose", () => {
    const originalDraw = (engine as unknown as { _draw: unknown })._draw;
    const originalLookup = cache.getRenderPipeline;
    const compiles = AsyncPipelineCompiles.install(scene)!;
    expect((engine as unknown as { _draw: unknown })._draw).not.toBe(originalDraw);
    const shrub = material("shrub");
    compiles.defer(shrub);
    compiles.dispose();
    expect((engine as unknown as { _draw: unknown })._draw).toBe(originalDraw);
    expect(cache.getRenderPipeline).toBe(originalLookup);
    draw(box("detail-shrub", shrub));
    expect(device.synchronous).toEqual(["shrub:triangle-list:1"]);
  });
});

describe("pipeline warm-up", () => {
  it("draws the mesh out of view until a frame draws it with its pipelines ready, then restores it", async () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const stump = material("stump");
    compiles.defer(stump);
    const mesh = box("detail-stump-batch", stump);
    mesh.alwaysSelectAsActiveMesh = false;

    expect(compiles.warmUp(mesh, true)).toBe("started");
    expect(mesh.alwaysSelectAsActiveMesh).toBe(true);
    expect(compiles.warmUp(mesh, true)).toBe("warming");
    // The frame starts the compile and the draw waits: still warming.
    draw(mesh);
    endFrame();
    expect(mesh.alwaysSelectAsActiveMesh).toBe(true);
    device.pending[0]!.resolve();
    await settle();
    // The first frame that draws it with nothing waiting completes it.
    draw(mesh);
    endFrame();
    expect(mesh.alwaysSelectAsActiveMesh).toBe(false);
    expect(compiles.warmUp(mesh, true)).toBe("warm");
    expect(compiles.statistics).toMatchObject({ warmUpsStarted: 1, warmUpsCompleted: 1, warmUpsAbandoned: 0 });
    expect(device.synchronous).toEqual([]);
    compiles.dispose();
  });

  it("shares a warm key across meshes of one material, vertex layout and shadow casting", async () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const rock = material("rock");
    compiles.defer(rock);
    const first = box("detail-rock-a", rock);
    const second = box("detail-rock-b", rock);
    expect(compiles.warmUp(first, false)).toBe("started");
    expect(compiles.warmUp(second, false)).toBe("warming");
    draw(first);
    device.pending[0]!.resolve();
    await settle();
    endFrame();
    draw(first);
    endFrame();
    expect(compiles.warmUp(second, false)).toBe("warm");
    // Casting shadows needs the shadow pass's pipeline too: its own key.
    expect(compiles.warmUp(second, true)).toBe("started");
    compiles.dispose();
  });

  it("abandons a warm-up its mesh is never drawn for, restores it, and lets the key try again", () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const moss = material("moss");
    compiles.defer(moss);
    const hidden = box("detail-moss-hidden", moss);
    expect(compiles.warmUp(hidden, false)).toBe("started");
    for (let frame = 0; frame < PIPELINE_WARM_UP_FRAME_LIMIT; frame += 1) endFrame();
    expect(hidden.alwaysSelectAsActiveMesh).toBe(false);
    expect(compiles.statistics).toMatchObject({ warmUpsAbandoned: 1, warmUpsCompleted: 0 });
    expect(compiles.warmUp(box("detail-moss-next", moss), false)).toBe("started");
    compiles.dispose();
  });

  it("ends a disposed mesh's warm-up and declines unregistered materials", () => {
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const log = material("log");
    compiles.defer(log);
    const mesh = box("detail-log", log);
    expect(compiles.warmUp(mesh, false)).toBe("started");
    mesh.dispose();
    endFrame();
    expect(compiles.statistics).toMatchObject({ warmUpsAbandoned: 1 });
    expect(compiles.warmUp(box("terrain", material("terrain")), false)).toBe("declined");
    compiles.dispose();
  });
});

describe("the Babylon facts the module stands on (installed @babylonjs/core)", () => {
  const require = createRequire(import.meta.url);
  const read = (path: string) => readFileSync(require.resolve(`@babylonjs/core/${path}`), "utf8");
  const methodBody = (source: string, signature: string) => {
    const start = source.indexOf(signature);
    expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
    // The next method at the class's indentation ends this one.
    const end = source.slice(start + signature.length).search(/\n {4}[A-Za-z_]\w*\(/);
    return source.slice(start, end < 0 ? undefined : start + signature.length + end);
  };

  it("draws build the pipeline before recording anything, so a draw abandoned at the lookup leaves no state", () => {
    const draw = methodBody(read("Engines/webgpuEngine.pure.js"), "_draw(drawType, fillMode, start, count, instancesCount) {");
    const lookup = draw.indexOf("this._cacheRenderPipeline.getRenderPipeline(fillMode, this._currentEffect, this.currentSampleCount, textureState)");
    expect(lookup).toBeGreaterThan(0);
    for (const later of [
      "this._cacheBindGroups.getBindGroups(",
      "this._device.createRenderBundleEncoder(",
      "renderPass2.setPipeline(pipeline)",
      "bundleList.addBundle(this._currentDrawContext.fastBundle)",
    ]) {
      expect(draw.lastIndexOf(later), later).toBeGreaterThan(lookup);
    }
    // The fast path (a bundle already recorded) returns before the lookup,
    // with the pipeline it was recorded with.
    expect(draw.indexOf("if (useFastPath || this._snapshotRendering.record)")).toBeLessThan(lookup);
    expect(draw).not.toContain("finally");
  });

  it("the cache's lookup leaves the token a miss is filed under, as its own async pre-warm relies on", () => {
    const cacheSource = read("Engines/WebGPU/webgpuCacheRenderPipeline.js");
    const getRenderPipeline = methodBody(cacheSource, "getRenderPipeline(fillMode, effect, sampleCount, textureState = 0) {");
    expect(getRenderPipeline).toContain("sampleCount = WebGPUTextureHelper.GetSample(sampleCount);");
    expect(getRenderPipeline).toContain("const cached = this._lookupRenderPipeline(fillMode, effect, sampleCount, textureState);");
    expect(getRenderPipeline).toContain("const topology = WebGPUCacheRenderPipeline._GetTopology(fillMode);");
    expect(getRenderPipeline).toContain("this._parameter.pipeline = this._createRenderPipeline(effect, topology, sampleCount);");
    expect(getRenderPipeline).toContain("this._setRenderPipeline(this._parameter);");
    expect(methodBody(cacheSource, "_createRenderPipeline(effect, topology, sampleCount) {"))
      .toContain("this._device.createRenderPipeline(this._buildRenderPipelineDescriptor(effect, topology, sampleCount))");
    const preWarm = methodBody(cacheSource, "preWarmPipeline(fillMode, effect, sampleCount, textureState = 0) {");
    expect(preWarm).toContain("const capturedParam = { token: this._parameter.token, pipeline: null };");
    expect(preWarm).toContain("this._device.createRenderPipelineAsync(this._buildRenderPipelineDescriptor(effect, topology, sampleCount))");

    const tree = read("Engines/WebGPU/webgpuCacheRenderPipelineTree.js");
    expect(tree).toContain("param.token = node;");
    expect(methodBody(tree, "_setRenderPipeline(param) {")).toContain("param.token.pipeline = param.pipeline;");
  });

  it("every pass that draws a mesh goes through _processRendering", () => {
    const mesh = read("Meshes/mesh.pure.js");
    expect(mesh).toMatch(/\n {4}_processRendering\(/);
    expect(read("Lights/Shadows/shadowGenerator.js")).toContain("renderingMesh._processRendering(");
    expect(read("Rendering/depthRenderer.pure.js")).toContain("renderingMesh._processRendering(");
  });
});

describe("the renderer's wiring", () => {
  const renderer = readSource("src/render/FlightRenderer.ts");
  const method = (signature: string) => renderer.slice(renderer.indexOf(signature)).slice(0, 900);

  it("defers the detail and blade materials, and warms both systems' meshes", () => {
    expect(renderer).toContain("const pipelineCompiles = AsyncPipelineCompiles.install(scene);");
    expect(renderer).toContain("detail.addPbrMaterials((material) => pipelineCompiles.defer(material));");
    expect(renderer).toContain("groundCover.addPbrMaterials((material) => pipelineCompiles.defer(material));");
    expect(renderer.match(/pipelineWarmUp: pipelineCompiles,/g)).toHaveLength(2);
  });

  it("builds in the frame from the capture's time pin on, and drains compiles at the capture fence", () => {
    expect(method("pinOceanCascadePhaseForCapture(): void {")).toContain("this.pipelineCompiles?.setSynchronous(true);");
    expect(method("async waitForGpuIdleForCapture(): Promise<void> {")).toContain("await this.pipelineCompiles?.whenIdle();");
  });
});
