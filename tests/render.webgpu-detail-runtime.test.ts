import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Buffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  canGenerateNextDetailCell,
  detailPresentationChunkCoordinates,
  resolveDetailGenerationBudget,
  WorldDetailRuntime,
} from "../src/render/webgpu/detail";
import { DETAIL_INSTANCE_STRIDE_BYTES } from "../src/render/webgpu/detail/instanceFormat";
import { TerrainBiome } from "../src/world";

const forestTerrain = (x: number, z: number) => ({
  height: 96 + Math.sin(x * 0.002) * 5 + Math.cos(z * 0.0023) * 4,
  slope: 0.05,
  moisture: 0.68,
  biome: TerrainBiome.FOREST,
});

function chunkMeshes(scene: Scene): Mesh[] {
  return scene.meshes.filter(
    (mesh): mesh is Mesh => (
      mesh instanceof Mesh
      && typeof mesh.metadata?.detailChunk === "string"
      && mesh.isEnabled()
      && mesh.forcedInstanceCount > 0
    ),
  );
}

describe("WebGPU world-detail spatial presentation", () => {
  it("bounds streaming by elapsed CPU time while guaranteeing forward progress", () => {
    const low = resolveDetailGenerationBudget({ vegetationDensity: 0.5 });
    const medium = resolveDetailGenerationBudget({ vegetationDensity: 0.8 });
    const high = resolveDetailGenerationBudget({ vegetationDensity: 1 });
    expect(low).toEqual({ maximumCells: 8, maximumMilliseconds: 0.75 });
    expect(medium).toEqual({ maximumCells: 16, maximumMilliseconds: 1.25 });
    expect(high).toEqual({ maximumCells: 24, maximumMilliseconds: 2 });
    expect(canGenerateNextDetailCell(0, 100, high)).toBe(true);
    expect(canGenerateNextDetailCell(1, 2, high)).toBe(false);
    expect(canGenerateNextDetailCell(23, 1.99, high)).toBe(true);
    expect(canGenerateNextDetailCell(24, 0, high)).toBe(false);
    expect(() => canGenerateNextDetailCell(-1, 0, high)).toThrow(RangeError);
  });

  it("maps signed generation cells to deterministic half-open chunks", () => {
    expect(detailPresentationChunkCoordinates(0, 7)).toMatchObject({
      key: "0:0",
      minCellX: 0,
      maxCellX: 8,
      minCellZ: 0,
      maxCellZ: 8,
    });
    expect(detailPresentationChunkCoordinates(-1, -8)).toMatchObject({
      key: "-1:-1",
      minCellX: -8,
      maxCellX: 0,
      minCellZ: -8,
      maxCellZ: 0,
    });
    expect(detailPresentationChunkCoordinates(-9, 8)).toMatchObject({
      key: "-2:1",
      minCellX: -16,
      maxCellX: -8,
    });
    expect(() => detailPresentationChunkCoordinates(0.5, 0)).toThrow(RangeError);
    expect(() => detailPresentationChunkCoordinates(0, 0, 0)).toThrow(RangeError);
  });

  it("frustum-culls chunks, keeps shadow chunks, retains buffers, and rebases", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new FreeCamera("detail-test-camera", new Vector3(0, 120, 0), scene);
    camera.fov = 52 * Math.PI / 180;
    camera.minZ = 0.1;
    camera.maxZ = 5_000;
    camera.setTarget(new Vector3(0, 0, 1_500));
    scene.activeCamera = camera;
    camera.getViewMatrix(true);
    camera.getProjectionMatrix(true);

    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "chunked-detail-runtime",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
    });
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 1_200,
      vegetationDensity: 1,
    };
    for (let pass = 0; pass < 128 && runtime.statistics.residentCells < 128; pass += 1) {
      runtime.update(
        { x: 0, y: 120, z: 0 },
        { x: 0, y: 0, z: 0 },
        profile,
      );
    }
    expect(() => scene.render()).not.toThrow();
    runtime.update(
      { x: 0, y: 120, z: 0 },
      { x: 0, y: 0, z: 0 },
      profile,
    );

    const meshes = chunkMeshes(scene);
    const spatialChunks = new Set(meshes.map((mesh) => mesh.metadata.detailChunk as string));
    expect(spatialChunks.size).toBeGreaterThan(1);
    expect(meshes.every((mesh) => mesh.alwaysSelectAsActiveMesh === false)).toBe(true);
    const batchesByPrototype = Map.groupBy(
      meshes,
      (mesh) => mesh.metadata.detailBatch as string,
    );
    const repeatedPrototype = [...batchesByPrototype.values()].find((batches) => batches.length > 1);
    expect(repeatedPrototype).toBeDefined();
    expect(new Set(repeatedPrototype?.map((mesh) => mesh.geometry?.uniqueId)).size).toBe(
      repeatedPrototype?.length,
    );
    const totalInstances = meshes.reduce((sum, mesh) => sum + mesh.forcedInstanceCount, 0);
    const visibleInstances = meshes.reduce(
      (sum, mesh) => sum + (camera.isInFrustum(mesh) ? mesh.forcedInstanceCount : 0),
      0,
    );
    expect(visibleInstances).toBeGreaterThan(0);
    expect(visibleInstances).toBeLessThan(totalInstances);
    expect(runtime.statistics.renderedThinInstances).toBe(visibleInstances);

    // `4.5-C1`: the tier's `vegetationCastsShadows` datum gates the whole
    // caster list, and it is FALSE at tier 1 — 148 of 347 modelled draws.
    expect(profile.vegetationCastsShadows).toBe(false);
    const suppressed: Mesh[] = [];
    runtime.addShadowCasters((mesh) => suppressed.push(mesh));
    expect(suppressed).toHaveLength(0);

    // A tier that does cast still registers exactly the near band, and the
    // switch takes effect in the same update — in both directions.
    const casting = {
      ...resolveWebGpuQualityProfile("high", "balanced"),
      vegetationDistance: 1_200,
      vegetationDensity: 1,
    };
    expect(casting.vegetationCastsShadows).toBe(true);
    runtime.update({ x: 0, y: 120, z: 0 }, { x: 0, y: 0, z: 0 }, casting);
    const shadowCasters: Mesh[] = [];
    runtime.addShadowCasters((mesh) => shadowCasters.push(mesh));
    expect(shadowCasters.length).toBeGreaterThan(0);
    expect(new Set(shadowCasters)).toEqual(
      new Set(chunkMeshes(scene).filter(
        (mesh) => mesh.metadata.detailCastsShadow === true
          && mesh.isEnabled()
          && mesh.forcedInstanceCount > 0,
      )),
    );
    runtime.update({ x: 0, y: 120, z: 0 }, { x: 0, y: 0, z: 0 }, profile);

    // 2-11a: with the packed record there are no per-instance matrices —
    // retention is buffer identity, rebase is decoded from the record bytes.
    const firstInstanceLocal = (mesh: Mesh | undefined): [number, number, number] => {
      const data = mesh?.getVertexBuffer("instancePosition")?.getData();
      const bytes = data instanceof Uint8Array
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
      if (!bytes) throw new Error("instancePosition buffer missing");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)];
    };
    const retainedMesh = meshes.find((mesh) => mesh.forcedInstanceCount > 1);
    expect(retainedMesh).toBeDefined();
    const retainedBuffer = retainedMesh?.getVertexBuffer("instancePosition");
    runtime.update(
      { x: 0, y: 120, z: 0 },
      { x: 0, y: 0, z: 0 },
      profile,
    );
    expect(retainedMesh?.getVertexBuffer("instancePosition")).toBe(retainedBuffer);

    const beforeRebase = firstInstanceLocal(retainedMesh);
    const beforeWorldByBatch = new Map(meshes.map((batchMesh) => {
      const local = firstInstanceLocal(batchMesh);
      return [
        `${batchMesh.metadata.detailBatch}@${batchMesh.metadata.detailChunk}`,
        [
          local[0] + batchMesh.position.x,
          local[1] + batchMesh.position.y,
          local[2] + batchMesh.position.z,
        ] as const,
      ];
    }));
    const retainedBatch = retainedMesh?.metadata.detailBatch as string;
    const retainedChunk = retainedMesh?.metadata.detailChunk as string;
    // The rebase dirties every chunk; the 2-17 amortized sweep rebuilds
    // one per update. Assertion 67d checks the FIRST update, before draining:
    // every stale batch must already render against the new origin.
    runtime.update(
      { x: 0, y: 120, z: 0 },
      { x: 512, y: 30, z: -256 },
      profile,
    );
    const immediateMeshes = chunkMeshes(scene);
    expect(immediateMeshes.length).toBe(meshes.length);
    for (const batchMesh of immediateMeshes) {
      const key = `${batchMesh.metadata.detailBatch}@${batchMesh.metadata.detailChunk}`;
      const beforeWorld = beforeWorldByBatch.get(key);
      expect(beforeWorld, key).toBeDefined();
      const local = firstInstanceLocal(batchMesh);
      expect(local[0] + batchMesh.position.x, `${key} x`).toBeCloseTo(
        beforeWorld![0] - 512,
        3,
      );
      expect(local[1] + batchMesh.position.y, `${key} y`).toBeCloseTo(
        beforeWorld![1] - 30,
        3,
      );
      expect(local[2] + batchMesh.position.z, `${key} z`).toBeCloseTo(
        beforeWorld![2] + 256,
        3,
      );
    }
    // Drain the remaining chunks before asserting the rewritten record.
    for (let sweep = 1; sweep < 12; sweep += 1) {
      runtime.update(
        { x: 0, y: 120, z: 0 },
        { x: 512, y: 30, z: -256 },
        profile,
      );
    }
    const rebasedMesh = chunkMeshes(scene).find((mesh) => (
      mesh.metadata.detailBatch === retainedBatch
      && mesh.metadata.detailChunk === retainedChunk
    ));
    expect(rebasedMesh).toBeDefined();
    // Perf-debt pass: a rebuild REUSES the batch. It used to publish a whole
    // new mesh (clone + `makeGeometryUnique` + a fresh GPU instance buffer,
    // per prototype per chunk, on every 64 m observer quantum) and retire
    // the previous one; the batch, its unique geometry and its allocation
    // now survive and take new bytes in place. A grown allocation is still
    // retired through the grace window — only growth reallocates.
    expect(rebasedMesh).toBe(retainedMesh);
    expect(retainedMesh?.isEnabled()).toBe(true);
    expect(retainedMesh?.getVertexBuffer("instancePosition")).toBe(retainedBuffer);
    const afterRebase = firstInstanceLocal(rebasedMesh);
    expect(afterRebase[0]).toBeCloseTo(beforeRebase[0] - 512, 3);
    expect(afterRebase[1]).toBeCloseTo(beforeRebase[1] - 30, 3);
    expect(afterRebase[2]).toBeCloseTo(beforeRebase[2] + 256, 3);

    // A batch a chunk stops populating is still retired, and the mesh
    // leaves the scene after the conservative grace window.
    const distantMeshCount = chunkMeshes(scene).length;
    for (let pass = 0; pass < 12; pass += 1) {
      runtime.update(
        { x: 40_000, y: 900, z: 40_000 },
        { x: 512, y: 30, z: -256 },
        profile,
      );
    }
    expect(chunkMeshes(scene).length).toBeLessThan(distantMeshCount);

    runtime.dispose();
    runtime.dispose();
    expect(scene.meshes.some((mesh) => mesh.metadata?.detailChunk)).toBe(false);
    scene.dispose();
    engine.dispose();
  });
});

/**
 * The vegetation perf-debt pass's "instance-buffer reuse" rung, pinned by
 * the property that actually bit: a GPU buffer destroyed while a submitted
 * command buffer still references it is a WebGPU validation error, and the
 * whole submit is rejected — one stale instance buffer renders the entire
 * frame black. (Measured exactly that way: the first capture after the reuse
 * change came back with a black `approach-500ft` and twenty
 * `used in submit while destroyed` errors at frame 44.)
 *
 * Babylon 9.21.2 makes the trap easy to fall into. A `VertexBuffer` built
 * over an existing `Buffer` does not own it, and `Buffer._increaseReferences`
 * is never called from anywhere in the shipped source — so five typed views
 * over one interleaved allocation leave its reference count at ONE, and a
 * single `dispose()` destroys the GPU buffer immediately. The runtime
 * therefore RECYCLES released allocations through a pool instead of
 * destroying them; a write into a pooled buffer is queue-ordered after the
 * previous submit and can never be a validation error.
 */
describe("detail instance-buffer lifetime (perf-debt pass)", () => {
  it("never destroys an allocation while the runtime is live, and reuses them", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("buffers", new Vector3(0, 120, 0), scene);
    camera.setTarget(new Vector3(0, 0, 1_000));
    scene.activeCamera = camera;
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "detail-buffer-pool",
      terrainSample: forestTerrain,
      seaLevelMeters: 0,
    });
    const originalDispose = Buffer.prototype.dispose;
    let destroyedWhileLive = 0;
    let created = 0;
    const originalCreate = engine.createDynamicVertexBuffer.bind(engine);
    engine.createDynamicVertexBuffer = ((data: never) => {
      created += 1;
      return originalCreate(data);
    }) as typeof engine.createDynamicVertexBuffer;
    Buffer.prototype.dispose = function patched(this: Buffer) {
      // Only the 32-byte-stride INSTANCE allocations: a retired batch also
      // disposes its own cloned prototype geometry, which is correct and
      // has always been safe (the mesh is disabled four updates earlier).
      if (this.byteStride === DETAIL_INSTANCE_STRIDE_BYTES) destroyedWhileLive += 1;
      originalDispose.call(this);
    };
    try {
      // A long traverse plus a teleport plus a return: chunks fill (growth),
      // rebuild (reuse), retire (recycle) and are recreated (pool hit).
      for (let step = 0; step < 20; step += 1) {
        runtime.update(
          { x: step * 140, y: 120, z: step * 140 },
          { x: 0, y: 0, z: 0 },
          profile,
        );
      }
      const afterTraverse = created;
      expect(afterTraverse).toBeGreaterThan(0);
      for (let step = 0; step < 20; step += 1) {
        runtime.update({ x: 90_000, y: 900, z: 90_000 }, { x: 0, y: 0, z: 0 }, profile);
      }
      const afterTeleport = created;
      for (let step = 0; step < 20; step += 1) {
        runtime.update(
          { x: step * 140, y: 120, z: step * 140 },
          { x: 0, y: 0, z: 0 },
          profile,
        );
      }
      // The pass's contract: nothing is destroyed in flight.
      expect(destroyedWhileLive).toBe(0);
      // ...and the identical return leg allocates far less than the first
      // traverse did, because the teleport's retired allocations came back
      // through the pool instead of being freed and remade.
      const returnLegAllocations = created - afterTeleport;
      expect(returnLegAllocations).toBeLessThan(afterTraverse * 0.75);
    } finally {
      Buffer.prototype.dispose = originalDispose;
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
