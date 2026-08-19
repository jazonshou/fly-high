import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
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

    const shadowCasters: Mesh[] = [];
    runtime.addShadowCasters((mesh) => shadowCasters.push(mesh));
    expect(shadowCasters.length).toBeGreaterThan(0);
    expect(new Set(shadowCasters)).toEqual(
      new Set(meshes.filter((mesh) => mesh.metadata.detailCastsShadow === true)),
    );

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
    const retainedBatch = retainedMesh?.metadata.detailBatch as string;
    const retainedChunk = retainedMesh?.metadata.detailChunk as string;
    runtime.update(
      { x: 0, y: 120, z: 0 },
      { x: 512, y: 30, z: -256 },
      profile,
    );
    const rebasedMesh = chunkMeshes(scene).find((mesh) => (
      mesh.metadata.detailBatch === retainedBatch
      && mesh.metadata.detailChunk === retainedChunk
    ));
    expect(rebasedMesh).toBeDefined();
    expect(rebasedMesh).not.toBe(retainedMesh);
    expect(retainedMesh?.isEnabled()).toBe(false);
    const afterRebase = firstInstanceLocal(rebasedMesh);
    expect(afterRebase[0]).toBeCloseTo(beforeRebase[0] - 512, 3);
    expect(afterRebase[1]).toBeCloseTo(beforeRebase[1] - 30, 3);
    expect(afterRebase[2]).toBeCloseTo(beforeRebase[2] + 256, 3);

    for (let pass = 0; pass < 4; pass += 1) {
      runtime.update(
        { x: 0, y: 120, z: 0 },
        { x: 512, y: 30, z: -256 },
        profile,
      );
    }
    expect(scene.meshes).not.toContain(retainedMesh);

    runtime.dispose();
    runtime.dispose();
    expect(scene.meshes.some((mesh) => mesh.metadata?.detailChunk)).toBe(false);
    scene.dispose();
    engine.dispose();
  });
});
