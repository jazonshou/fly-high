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
  detailCellMinimumDistanceMeters,
  detailPresentationChunkCoordinates,
  generateDetailCell,
  groundCoverCandidateRange,
  resolveDetailGenerationBudget,
  WorldDetailRuntime,
} from "../src/render/webgpu/detail";
import {
  canopyRankOrder,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  DETAIL_PRESENTATION_REBUILD_MAX_WORK_UNITS_PER_UPDATE,
  GROUND_COVER_EDGE_FADE_METERS,
} from "../src/render/webgpu/detail/WorldDetailRuntime";
import { DETAIL_INSTANCE_STRIDE_BYTES } from "../src/render/webgpu/detail/instanceFormat";
import {
  TREE_BARK_LAYER_MIN,
  TREE_BARK_LAYER_SPAN,
  treeBarkAtlasLayer,
} from "../src/render/webgpu/detail/treePrototypeFamily";
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

  it("bounds grass rebuild work without changing any hash-selected candidate", () => {
    const cellSize = 512;
    const spacing = 2;
    const radius = 150;
    const columns = cellSize / spacing;
    const hash = (x: number, z: number, lane: number): number => {
      let value = (Math.imul(Math.round(x * 8), 0x27d4_eb2d)
        ^ Math.imul(Math.round(z * 8), 0x1656_67b1)
        ^ Math.imul(lane + 1, 0x9e37_79b9)) >>> 0;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
    const selected = (
      cellMinimumX: number,
      cellMinimumZ: number,
      observerX: number,
      observerZ: number,
      bounded: boolean,
    ): Set<string> => {
      const range = bounded
        ? groundCoverCandidateRange(
            cellMinimumX,
            cellMinimumZ,
            cellSize,
            observerX,
            observerZ,
            radius,
            spacing,
          )
        : {
            minimumColumn: 0,
            maximumColumnExclusive: columns,
            minimumRow: 0,
            maximumRowExclusive: columns,
          };
      const result = new Set<string>();
      for (let row = range.minimumRow; row < range.maximumRowExclusive; row += 1) {
        for (
          let column = range.minimumColumn;
          column < range.maximumColumnExclusive;
          column += 1
        ) {
          const baseX = cellMinimumX + (column + 0.5) * spacing;
          const baseZ = cellMinimumZ + (row + 0.5) * spacing;
          const x = baseX + (hash(baseX, baseZ, 0) - 0.5) * spacing;
          const z = baseZ + (hash(baseX, baseZ, 1) - 0.5) * spacing;
          const distance = Math.hypot(x - observerX, z - observerZ);
          if (distance >= radius) continue;
          const ramp = Math.min(1, radius * 0.2 / Math.max(distance, 1));
          // A fixed habitat coverage exercises the downstream selection hash;
          // equal keys mean the optimization changes neither placement nor
          // density, including when the disc crosses a signed cell boundary.
          if (hash(x, z, 2) < ramp * 0.73) result.add(`${row}:${column}`);
        }
      }
      return result;
    };

    const observers = [
      { x: 0, z: 0 },
      { x: 256, z: 256 },
      { x: 511.999_999, z: 0.000_001 },
      { x: -0.000_001, z: -512 },
    ];
    for (const observer of observers) {
      const centerCellX = Math.floor(observer.x / cellSize);
      const centerCellZ = Math.floor(observer.z / cellSize);
      for (let cellZ = centerCellZ - 1; cellZ <= centerCellZ + 1; cellZ += 1) {
        for (let cellX = centerCellX - 1; cellX <= centerCellX + 1; cellX += 1) {
          const minimumX = cellX * cellSize;
          const minimumZ = cellZ * cellSize;
          expect(
            selected(minimumX, minimumZ, observer.x, observer.z, true),
            `observer ${observer.x}:${observer.z}, cell ${cellX}:${cellZ}`,
          ).toEqual(selected(minimumX, minimumZ, observer.x, observer.z, false));
        }
      }
    }

    // Across every cell boundary, the axis-aligned superset of a 150 m disc
    // can touch at most 151 grid intervals per axis. This is the permanent
    // work-bound regression guard: never return to 65,536 iterations per
    // qualifying cell.
    const observer = { x: 127.37, z: -255.11 };
    let boundedCandidates = 0;
    for (let cellZ = -3; cellZ <= 3; cellZ += 1) {
      for (let cellX = -3; cellX <= 3; cellX += 1) {
        const range = groundCoverCandidateRange(
          cellX * cellSize,
          cellZ * cellSize,
          cellSize,
          observer.x,
          observer.z,
          radius,
          spacing,
        );
        boundedCandidates += (range.maximumColumnExclusive - range.minimumColumn)
          * (range.maximumRowExclusive - range.minimumRow);
      }
    }
    expect(boundedCandidates).toBeGreaterThan(0);
    expect(boundedCandidates).toBeLessThanOrEqual(151 * 151);
    expect(() => groundCoverCandidateRange(0, 0, 512, 0, 0, -1)).toThrow(RangeError);
  });

  it("keeps cell early rejection equivalent to per-item edge filtering", () => {
    const cellSize = 512;
    const cellX = -3;
    const cellZ = -2;
    const minX = cellX * cellSize;
    const minZ = cellZ * cellSize;
    const maxX = minX + cellSize;
    const maxZ = minZ + cellSize;
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const edges = [
      ["near", profile.renderedDensityLaw.near.outerRadiusMeters],
      ["mid", profile.renderedDensityLaw.mid.outerRadiusMeters],
      ["grass", profile.grassRadiusMeters],
      [
        "cull",
        profile.renderedDensityLaw.far.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS,
      ],
    ] as const;
    const compare = (
      label: string,
      observerX: number,
      observerZ: number,
      radius: number,
      placements: readonly { readonly x: number; readonly z: number }[],
    ): void => {
      const legacy = placements.filter(
        (placement) => Math.hypot(placement.x - observerX, placement.z - observerZ) < radius,
      );
      const minimumDistance = detailCellMinimumDistanceMeters(
        observerX,
        observerZ,
        cellX,
        cellZ,
        cellSize,
      );
      const optimized = minimumDistance < radius ? legacy : [];
      expect(optimized, label).toEqual(legacy);
      if (minimumDistance >= radius) expect(legacy, `${label} rejected cell`).toEqual([]);
    };

    for (const [edgeName, radius] of edges) {
      for (const offset of [-0.5, 0, 0.5]) {
        const axisObserverX = maxX + radius + offset;
        const axisObserverZ = (minZ + maxZ) / 2;
        compare(
          `${edgeName}/axis/${offset}`,
          axisObserverX,
          axisObserverZ,
          radius,
          [
            { x: maxX - 0.01, z: axisObserverZ },
            { x: maxX - 64, z: axisObserverZ + 47 },
            { x: minX + 16, z: minZ + 16 },
          ],
        );

        // Approach the same negative-coordinate cell diagonally. The
        // rectangle corner is the exact lower bound, so an axis-only helper
        // or a sign error would disagree with the legacy radial predicate.
        const diagonalDistance = radius + offset;
        const component = diagonalDistance / Math.SQRT2;
        const diagonalObserverX = maxX + component;
        const diagonalObserverZ = maxZ + component;
        compare(
          `${edgeName}/diagonal/${offset}`,
          diagonalObserverX,
          diagonalObserverZ,
          radius,
          [
            { x: maxX - 0.01, z: maxZ - 0.01 },
            { x: maxX - 64, z: maxZ - 47 },
            { x: minX + 16, z: minZ + 16 },
          ],
        );
      }
    }
  });

  it("refreshes season-baked cells in place and does no work for the same day", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "detail-season-refresh",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
      latitudeDegrees: 45,
    });
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
    };
    const observer = { x: 64, y: 100, z: 64 };
    const origin = { x: 0, y: 0, z: 0 };
    const internals = runtime as unknown as {
      readonly cells: Map<string, { readonly generation: number }>;
      readonly desiredKeys: Set<string>;
      readonly cellEpoch: number;
    };

    try {
      for (let pass = 0; pass < 128; pass += 1) {
        runtime.update(observer, origin, profile);
        if (
          internals.desiredKeys.size > 0
          && internals.cells.size === internals.desiredKeys.size
          && [...internals.cells.values()].every(
            (resident) => resident.generation === internals.cellEpoch,
          )
        ) break;
      }
      expect(internals.cells.size).toBeGreaterThan(0);
      expect(internals.cells.size).toBe(internals.desiredKeys.size);
      const residentCount = internals.cells.size;
      const generatedBefore = runtime.statistics.generatedCells;

      // Equivalent days normalize to the same appearance input and must not
      // churn cells or buffers.
      runtime.setDayOfYear(365);
      for (let pass = 0; pass < 4; pass += 1) runtime.update(observer, origin, profile);
      expect(runtime.statistics.generatedCells).toBe(generatedBefore);

      runtime.setDayOfYear(355);
      expect(internals.cells.size).toBe(residentCount);
      expect([...internals.cells.values()].some(
        (resident) => resident.generation !== internals.cellEpoch,
      )).toBe(true);

      for (let pass = 0; pass < 128; pass += 1) {
        runtime.update(observer, origin, profile);
        // The old season remains drawable until each replacement arrives.
        expect(internals.cells.size).toBe(residentCount);
        if ([...internals.cells.values()].every(
          (resident) => resident.generation === internals.cellEpoch,
        )) break;
      }
      expect([...internals.cells.values()].every(
        (resident) => resident.generation === internals.cellEpoch,
      )).toBe(true);
      expect(runtime.statistics.generatedCells).toBe(generatedBefore + residentCount);

      const generatedAfterRefresh = runtime.statistics.generatedCells;
      runtime.setDayOfYear(355);
      for (let pass = 0; pass < 4; pass += 1) runtime.update(observer, origin, profile);
      expect(runtime.statistics.generatedCells).toBe(generatedAfterRefresh);
      expect(() => runtime.setDayOfYear(Number.NaN)).toThrow(RangeError);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
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
      // This case isolates chunk culling/rebase identity; staged publication
      // is exercised separately below with a one-unit budget.
      presentationRebuildBudget: {
        maximumWorkUnits: 1_000_000,
        maximumMilliseconds: 1_000_000,
      },
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
    // Family geometry must not erase species surfaces. Inspect the real
    // runtime writers: every trunk is neutral RGB, alpha decodes to its
    // generated species' bark layer, and birch still rides an oak-family
    // batch without adding another prototype/draw.
    const internals = runtime as unknown as {
      cells: Map<string, {
        cell: {
          trees: readonly {
            x: number;
            z: number;
            species: "pine" | "cedar" | "spruce" | "oak" | "maple" | "birch" | "willow";
          }[];
        };
      }>;
      batches: Map<string, {
        prototypeKey: string;
        writer: { finish(): Uint8Array };
      }>;
    };
    const positionKey = (x: number, z: number) => `${Math.fround(x)}:${Math.fround(z)}`;
    const speciesAt = new Map<string, Parameters<typeof treeBarkAtlasLayer>[0]>();
    for (const resident of internals.cells.values()) {
      for (const tree of resident.cell.trees) {
        speciesAt.set(positionKey(tree.x, tree.z), tree.species);
      }
    }
    const seenBarkLayers = new Set<number>();
    let birchInOakFamily = 0;
    let checkedTrunks = 0;
    for (const batch of internals.batches.values()) {
      if (!batch.prototypeKey.includes("-trunk-")) continue;
      const bytes = batch.writer.finish();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 0; offset < bytes.byteLength; offset += DETAIL_INSTANCE_STRIDE_BYTES) {
        const species = speciesAt.get(positionKey(
          view.getFloat32(offset, true),
          view.getFloat32(offset + 8, true),
        ));
        expect(species, `${batch.prototypeKey} trunk has no generated tree`).toBeDefined();
        expect(bytes[offset + 24], `${species} trunk red`).toBe(255);
        expect(bytes[offset + 25], `${species} trunk green`).toBe(255);
        expect(bytes[offset + 26], `${species} trunk blue`).toBe(255);
        const selector = (bytes[offset + 27] ?? 0) / 255;
        const decodedLayer = TREE_BARK_LAYER_MIN
          + Math.floor(selector * TREE_BARK_LAYER_SPAN + 0.5);
        expect(decodedLayer, `${species} bark selector`).toBe(treeBarkAtlasLayer(species!));
        seenBarkLayers.add(decodedLayer);
        if (species === "birch" && batch.prototypeKey.startsWith("tree-oak-")) {
          birchInOakFamily += 1;
        }
        checkedTrunks += 1;
      }
    }
    expect(checkedTrunks).toBeGreaterThan(100);
    expect(seenBarkLayers).toEqual(new Set([5, 6, 7]));
    expect(birchInOakFamily).toBeGreaterThan(0);

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

  it("bounds staged synthesis and atomically preserves the old chunk through cancellation", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("staged-detail", new Vector3(64, 120, 64), scene);
    camera.setTarget(new Vector3(64, 0, 1_000));
    scene.activeCamera = camera;
    // Mutable only so the test can establish a complete old publication
    // quickly, then exercise the production scheduler at one unit/update.
    const rebuildBudget = {
      maximumWorkUnits: 1_000_000,
      maximumMilliseconds: 1_000_000,
    };
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "staged-detail-atomic",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
      presentationRebuildBudget: rebuildBudget,
    });
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
      // This test is about the scheduler, not the already-covered grass-disc
      // cardinality. Keeping a tiny disc makes the fixture quick to settle.
      grassRadiusMeters: 1,
    };
    const observer = { x: 64, y: 120, z: 64 };
    const internals = runtime as unknown as {
      readonly batches: Map<string, {
        readonly mesh: Mesh;
        readonly chunkKey: string;
        readonly prototypeKey: string;
        readonly writer: { finish(): Uint8Array };
        readonly gpu: { readonly shared: Buffer } | null;
      }>;
      readonly pendingPresentationBuild: {
        readonly stagedBatches: Map<string, { readonly writer: object }>;
      } | null;
      readonly detailBuildStoragePool: Map<string, { readonly writer: object }>;
      readonly presentationChunks: Map<string, { readonly signature: string }>;
      readonly retiredBatches: readonly unknown[];
      readonly instanceBufferPool: readonly unknown[];
      readonly cells: Map<string, { readonly generation: number }>;
      readonly desiredKeys: Set<string>;
      readonly cellEpoch: number;
      readonly batchesDirty: boolean;
    };

    try {
      for (let pass = 0; pass < 256; pass += 1) {
        runtime.update(observer, { x: 0, y: 0, z: 0 }, profile);
        if (
          !internals.batchesDirty
          && internals.cells.size === internals.desiredKeys.size
          && [...internals.cells.values()].every(
            (resident) => resident.generation === internals.cellEpoch,
          )
        ) break;
      }
      expect(internals.batchesDirty).toBe(false);
      expect(internals.batches.size).toBeGreaterThan(0);
      expect(runtime.pendingWorkItems).toBe(0);

      rebuildBudget.maximumWorkUnits = 4;
      const publicationsBefore = runtime.presentationRebuildDiagnostics.publications;
      const cancellationsBefore = runtime.presentationRebuildDiagnostics.cancellations;
      const statisticsBefore = runtime.statistics;
      const retiredBefore = internals.retiredBatches.length;
      const pooledBefore = internals.instanceBufferPool.length;

      // A rebase dirties every chunk. A tiny slice can enter the generator,
      // but no staged byte may become live yet.
      runtime.update(observer, { x: 512, y: 0, z: 0 }, profile);
      const firstSlice = runtime.presentationRebuildDiagnostics;
      expect(firstSlice.workUnitsLastUpdate).toBeGreaterThan(0);
      expect(firstSlice.workUnitsLastUpdate).toBeLessThanOrEqual(4);
      expect(firstSlice.activeChunkKey).not.toBeNull();
      expect(firstSlice.publications).toBe(publicationsBefore);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);
      const activeChunkKey = firstSlice.activeChunkKey!;
      for (let pass = 0; pass < 32; pass += 1) {
        if ((internals.pendingPresentationBuild?.stagedBatches.size ?? 0) > 0) break;
        runtime.update(observer, { x: 512, y: 0, z: 0 }, profile);
        expect(runtime.presentationRebuildDiagnostics.workUnitsLastUpdate)
          .toBeLessThanOrEqual(4);
        expect(runtime.presentationRebuildDiagnostics.publications).toBe(publicationsBefore);
      }
      const [stagedPrototypeKey, stagedBeforeCancel] = [
        ...(internals.pendingPresentationBuild?.stagedBatches ?? new Map()),
      ][0]!;
      expect(stagedPrototypeKey).toBeDefined();
      const liveBatch = internals.batches.get(`${stagedPrototypeKey}@${activeChunkKey}`);
      expect(liveBatch).toBeDefined();
      const stagedWriterBeforeCancel = stagedBeforeCancel.writer;
      const oldLiveWriter = liveBatch!.writer;
      const meshIdentity = liveBatch!.mesh;
      const gpuIdentity = liveBatch!.gpu?.shared;
      const oldBytes = Uint8Array.from(liveBatch!.writer.finish());
      const oldSignature = internals.presentationChunks.get(activeChunkKey)!.signature;
      const oldFirstX = new DataView(
        oldBytes.buffer,
        oldBytes.byteOffset,
        oldBytes.byteLength,
      ).getFloat32(0, true);
      expect(liveBatch!.mesh.position.x).toBe(-512);
      expect(runtime.statistics).toEqual(statisticsBefore);
      expect(internals.retiredBatches).toHaveLength(retiredBefore);
      expect(internals.instanceBufferPool).toHaveLength(pooledBefore);

      // Changing origin again cancels CPU staging only. The old complete
      // chunk remains byte-identical and receives immediate mesh compensation.
      runtime.update(observer, { x: 1_024, y: 0, z: 0 }, profile);
      expect(runtime.presentationRebuildDiagnostics.cancellations)
        .toBe(cancellationsBefore + 1);
      expect(runtime.presentationRebuildDiagnostics.publications).toBe(publicationsBefore);
      expect(internals.presentationChunks.get(activeChunkKey)!.signature).toBe(oldSignature);
      expect(liveBatch!.writer.finish()).toEqual(oldBytes);
      expect(liveBatch!.mesh).toBe(meshIdentity);
      expect(liveBatch!.gpu?.shared).toBe(gpuIdentity);
      expect(liveBatch!.mesh.position.x).toBe(-1_024);
      expect(internals.retiredBatches).toHaveLength(retiredBefore);
      expect(internals.instanceBufferPool).toHaveLength(pooledBefore);
      expect(
        internals.detailBuildStoragePool.get(stagedPrototypeKey)?.writer
          === stagedWriterBeforeCancel
        || internals.pendingPresentationBuild?.stagedBatches.get(stagedPrototypeKey)?.writer
          === stagedWriterBeforeCancel,
        "canceled CPU writer was neither pooled nor immediately reused",
      ).toBe(true);

      // Drain the replacement. Publication rewrites every batch in one
      // synchronous update; the same mesh/buffer survives and its records are
      // now relative to the latest origin.
      rebuildBudget.maximumWorkUnits = 1_000_000;
      for (let pass = 0; pass < 32; pass += 1) {
        runtime.update(observer, { x: 1_024, y: 0, z: 0 }, profile);
        if (runtime.presentationRebuildDiagnostics.publications > publicationsBefore) break;
      }
      expect(runtime.presentationRebuildDiagnostics.publications)
        .toBeGreaterThan(publicationsBefore);
      expect(liveBatch!.mesh).toBe(meshIdentity);
      expect(liveBatch!.gpu?.shared).toBe(gpuIdentity);
      expect(liveBatch!.mesh.position.x).toBe(0);
      expect(liveBatch!.writer).toBe(stagedWriterBeforeCancel);
      expect(internals.detailBuildStoragePool.get(stagedPrototypeKey)?.writer)
        .toBe(oldLiveWriter);
      const newBytes = liveBatch!.writer.finish();
      const newFirstX = new DataView(
        newBytes.buffer,
        newBytes.byteOffset,
        newBytes.byteLength,
      ).getFloat32(0, true);
      expect(newFirstX).toBeCloseTo(oldFirstX - 1_024, 3);

      // The next publication must consume the displaced old live writer, then
      // return the first publication's writer. Pool cardinality stays one per
      // prototype and no large packed ArrayBuffer becomes rebuild garbage.
      const publicationsAfterFirstCommit = runtime.presentationRebuildDiagnostics.publications;
      const firstPublishedWriter = liveBatch!.writer;
      const pooledWriter = internals.detailBuildStoragePool.get(stagedPrototypeKey)!.writer;
      rebuildBudget.maximumWorkUnits = 4;
      for (let pass = 0; pass < 64; pass += 1) {
        runtime.update(observer, { x: 1_536, y: 0, z: 0 }, profile);
        if (internals.pendingPresentationBuild?.stagedBatches.has(stagedPrototypeKey)) break;
      }
      expect(internals.pendingPresentationBuild?.stagedBatches.get(stagedPrototypeKey)?.writer)
        .toBe(pooledWriter);
      rebuildBudget.maximumWorkUnits = 1_000_000;
      for (let pass = 0; pass < 32; pass += 1) {
        runtime.update(observer, { x: 1_536, y: 0, z: 0 }, profile);
        if (
          runtime.presentationRebuildDiagnostics.publications
            > publicationsAfterFirstCommit
        ) break;
      }
      expect(runtime.presentationRebuildDiagnostics.publications)
        .toBeGreaterThan(publicationsAfterFirstCommit);
      expect(liveBatch!.writer).toBe(pooledWriter);
      expect(internals.detailBuildStoragePool.get(stagedPrototypeKey)?.writer)
        .toBe(firstPublishedWriter);
      expect(runtime.presentationRebuildDiagnostics.pooledCpuBatchStorage)
        .toBe(internals.detailBuildStoragePool.size);
      expect(liveBatch!.gpu?.shared).toBe(gpuIdentity);
      const secondPublishBytes = liveBatch!.writer.finish();
      expect(new DataView(
        secondPublishBytes.buffer,
        secondPublishBytes.byteOffset,
        secondPublishBytes.byteLength,
      ).getFloat32(0, true)).toBeCloseTo(oldFirstX - 1_536, 3);
      runtime.dispose();
      expect(internals.pendingPresentationBuild).toBeNull();
      expect(internals.detailBuildStoragePool.size).toBe(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("honors the sampled wall-time cap while guaranteeing forward progress", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    let clock = 0;
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "staged-detail-time-budget",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
      presentationRebuildBudget: {
        maximumWorkUnits: 1_000,
        maximumMilliseconds: 1,
      },
      // start=0, the first sampled boundary=1, final diagnostic=2.
      presentationNowMilliseconds: () => clock++,
    });
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
    };
    try {
      runtime.update({ x: 64, y: 120, z: 64 }, { x: 0, y: 0, z: 0 }, profile);
      const first = runtime.presentationRebuildDiagnostics;
      expect(first.workUnitsLastUpdate).toBe(64);
      expect(first.millisecondsLastUpdate).toBe(2);
      expect(first.activeChunkKey).not.toBeNull();
      expect(first.publications).toBe(0);
      expect(first.buildStarts).toBe(1);
      expect(first.buildSlices).toBe(1);
      expect(first.completedSlices).toBe(0);
      expect(first.timeBudgetStops).toBe(1);
      expect(first.workBudgetStops).toBe(0);
      expect(first.workUnitsTotal).toBe(64);
      expect(first.observerQuantumChanges).toBe(1);

      const recordsBefore = first.stagedRecords;
      runtime.update({ x: 64, y: 120, z: 64 }, { x: 0, y: 0, z: 0 }, profile);
      const second = runtime.presentationRebuildDiagnostics;
      expect(second.workUnitsLastUpdate).toBe(64);
      expect(second.millisecondsLastUpdate).toBe(2);
      expect(second.stagedRecords).toBeGreaterThanOrEqual(recordsBefore);
      expect(second.buildStarts).toBe(1);
      expect(second.buildSlices).toBe(2);
      expect(second.completedSlices).toBe(0);
      expect(second.timeBudgetStops).toBe(2);
      expect(second.workBudgetStops).toBe(0);
      expect(second.workUnitsTotal).toBe(128);
      expect(second.observerQuantumChanges).toBe(1);
      expect(clock).toBe(6);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("keeps a dense production span-8 snapshot valid during diagonal 92 m/s motion", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("dense-moving-detail", new Vector3(2_048, 120, 2_048), scene);
    camera.setTarget(new Vector3(2_048, 0, 3_048));
    scene.activeCamera = camera;
    let clock = 0;
    let clockCostPerSample = 0;
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "audit-production-staging",
      terrainSample: forestTerrain,
      cellSizeMeters: 512,
      // The first slice holds the clock still to hit the deterministic hard
      // cap. Subsequent slices charge every sampled 64-unit block, so the
      // independent 3 ms branch—not just the 65,536-unit branch—must carry
      // the continuously moving production-density build.
      presentationNowMilliseconds: () => {
        clock += clockCostPerSample;
        return clock;
      },
    });
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const sourceCell = generateDetailCell({
      worldSeed: "audit-production-staging",
      cellX: 0,
      cellZ: 0,
      cellSizeMeters: 512,
      densityMultiplier: profile.vegetationDensity,
      terrainSample: forestTerrain,
    });
    // These are the generator's real authored production counts, not a tiny
    // synthetic placement fixture. Pinning them prevents a future density
    // increase from silently invalidating the scheduler proof.
    expect({
      trees: sourceCell.trees.length,
      shrubs: sourceCell.shrubs.length,
      rocks: sourceCell.rocks.length,
      clutter: sourceCell.clutter.length,
      groundCoverNodes: sourceCell.groundCover.length,
    }).toEqual({
      trees: 4_196,
      shrubs: 6_752,
      rocks: 8,
      clutter: 26,
      groundCoverNodes: 64,
    });

    type InjectedResident = {
      readonly source: "inline";
      readonly key: string;
      readonly cellX: number;
      readonly cellZ: number;
      readonly cellSizeMeters: number;
      readonly cell: typeof sourceCell;
      readonly generation: number;
      readonly revision: number;
      readonly treeCanopyRank: Float32Array;
      lod: "near" | "mid";
      distance: number;
    };
    const internals = runtime as unknown as {
      readonly cells: Map<string, InjectedResident>;
      readonly batches: Map<string, {
        readonly prototypeKey: string;
        readonly writer: { finish(): Uint8Array };
      }>;
      observerX: number;
      observerZ: number;
      rebuildBatches(
        origin: { readonly x: number; readonly y: number; readonly z: number },
        quality: typeof profile,
      ): boolean;
    };
    const canopyRanks = canopyRankOrder(sourceCell.trees);
    const translatePlacement = <Placement extends { readonly x: number; readonly z: number }>(
      placement: Placement,
      offsetX: number,
      offsetZ: number,
    ): Placement => ({
      ...placement,
      x: placement.x + offsetX,
      z: placement.z + offsetZ,
    });
    for (let cellZ = 0; cellZ < 8; cellZ += 1) {
      for (let cellX = 0; cellX < 8; cellX += 1) {
        const offsetX = cellX * 512;
        const offsetZ = cellZ * 512;
        const key = `${cellX}:${cellZ}`;
        const cell = {
          ...sourceCell,
          key,
          cellX,
          cellZ,
          minX: offsetX,
          minZ: offsetZ,
          maxX: offsetX + 512,
          maxZ: offsetZ + 512,
          trees: sourceCell.trees.map((placement) =>
            translatePlacement(placement, offsetX, offsetZ)),
          shrubs: sourceCell.shrubs.map((placement) =>
            translatePlacement(placement, offsetX, offsetZ)),
          rocks: sourceCell.rocks.map((placement) =>
            translatePlacement(placement, offsetX, offsetZ)),
          clutter: sourceCell.clutter.map((placement) =>
            translatePlacement(placement, offsetX, offsetZ)),
        } satisfies typeof sourceCell;
        const distance = Math.hypot(
          Math.max(cell.minX - 2_048, 0, 2_048 - cell.maxX),
          Math.max(cell.minZ - 2_048, 0, 2_048 - cell.maxZ),
        );
        internals.cells.set(key, {
          source: "inline",
          key,
          cellX,
          cellZ,
          cellSizeMeters: cell.cellSizeMeters,
          cell,
          generation: 0,
          revision: cellZ * 8 + cellX + 1,
          treeCanopyRank: canopyRanks,
          lod: distance <= profile.renderedDensityLaw.near.outerRadiusMeters ? "near" : "mid",
          distance,
        });
      }
    }

    try {
      const origin = { x: 0, y: 0, z: 0 };
      internals.observerX = 2_048;
      internals.observerZ = 2_048;
      internals.rebuildBatches(origin, profile);
      expect(runtime.presentationRebuildDiagnostics.workUnitsLastUpdate)
        .toBe(DETAIL_PRESENTATION_REBUILD_MAX_WORK_UNITS_PER_UPDATE);

      // 0.0075 ms per 64 generator steps pessimistically charges the sampled
      // clock while still giving a span-8 chunk enough bounded slices to
      // replace its predecessor before the aircraft can travel 96 m.
      clockCostPerSample = 0.0075;
      const metersPerAxisPerFrame = 92 / Math.SQRT2 / 60;
      let observedTimeBudget = false;
      let representedFrames = 0;
      let maximumObservedLiveDrift = 0;
      let maximumObservedPublicationDrift = 0;
      let firstPublicationFrame: number | null = null;
      for (let frame = 1; frame <= 180; frame += 1) {
        internals.observerX = 2_048 + frame * metersPerAxisPerFrame;
        internals.observerZ = 2_048 + frame * metersPerAxisPerFrame;
        internals.rebuildBatches(origin, profile);
        const diagnostics = runtime.presentationRebuildDiagnostics;
        maximumObservedLiveDrift = Math.max(
          maximumObservedLiveDrift,
          diagnostics.maximumLiveObserverDriftMeters,
        );
        maximumObservedPublicationDrift = Math.max(
          maximumObservedPublicationDrift,
          diagnostics.lastPublicationObserverDriftMeters,
        );
        observedTimeBudget ||= diagnostics.millisecondsLastUpdate >= 3
          && diagnostics.workUnitsLastUpdate
            < DETAIL_PRESENTATION_REBUILD_MAX_WORK_UNITS_PER_UPDATE;
        expect(diagnostics.pendingObserverDriftMeters ?? 0)
          .toBeLessThanOrEqual(DETAIL_MEMBERSHIP_SLACK_METERS);
        expect(diagnostics.maximumLiveObserverDriftMeters)
          .toBeLessThanOrEqual(DETAIL_MEMBERSHIP_SLACK_METERS);
        expect(diagnostics.lastPublicationObserverDriftMeters)
          .toBeLessThanOrEqual(DETAIL_MEMBERSHIP_SLACK_METERS);
        expect(diagnostics.suppressedChunks).toBe(0);
        if (diagnostics.publications > 0) {
          firstPublicationFrame ??= frame;
          // Both authored membership and the independently observer-bounded
          // grass frontier remain live; a retirement hole cannot satisfy the
          // drift assertions by making the offending chunk disappear.
          expect(runtime.statistics.treeInstances).toBeGreaterThan(0);
          expect(runtime.statistics.groundCoverInstances).toBeGreaterThan(0);
          let groundCoverInCurrentFrontier = 0;
          for (const batch of internals.batches.values()) {
            if (!batch.prototypeKey.startsWith("ground-")) continue;
            const bytes = batch.writer.finish();
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let offset = 0; offset < bytes.byteLength; offset += DETAIL_INSTANCE_STRIDE_BYTES) {
              const distance = Math.hypot(
                view.getFloat32(offset, true) - internals.observerX,
                view.getFloat32(offset + 8, true) - internals.observerZ,
              );
              // A snapshot can trail inside the documented 96 m envelope,
              // but it may neither lose the current fade frontier entirely
              // nor contain a patch outside radius + envelope.
              expect(distance).toBeLessThanOrEqual(
                profile.grassRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS + 0.01,
              );
              if (
                distance >= profile.grassRadiusMeters - GROUND_COVER_EDGE_FADE_METERS
                && distance < profile.grassRadiusMeters
              ) groundCoverInCurrentFrontier += 1;
            }
          }
          expect(groundCoverInCurrentFrontier).toBeGreaterThan(0);
          representedFrames += 1;
        }
      }
      expect(observedTimeBudget).toBe(true);
      expect(runtime.presentationRebuildDiagnostics.publications).toBeGreaterThanOrEqual(3);
      expect(runtime.presentationRebuildDiagnostics.cancellations).toBe(0);
      const cumulative = runtime.presentationRebuildDiagnostics;
      expect(cumulative.buildSlices).toBe(
        cumulative.completedSlices + cumulative.timeBudgetStops + cumulative.workBudgetStops,
      );
      expect(cumulative.observerSensitiveBuildStarts).toBeGreaterThan(0);
      expect(cumulative.residentCellsInSensitiveBuilds)
        .toBeGreaterThanOrEqual(cumulative.observerSensitiveBuildStarts);
      expect(representedFrames).toBeGreaterThan(100);
      expect(firstPublicationFrame).not.toBeNull();
      expect(maximumObservedLiveDrift).toBeLessThanOrEqual(DETAIL_MEMBERSHIP_SLACK_METERS);
      expect(maximumObservedPublicationDrift)
        .toBeLessThanOrEqual(DETAIL_MEMBERSHIP_SLACK_METERS);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("fail-closes stale live chunks when a deliberately starved rebuild crosses 96 m", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("starved-detail", new Vector3(64, 120, 64), scene);
    camera.setTarget(new Vector3(64, 0, 1_000));
    scene.activeCamera = camera;
    const budget = {
      maximumWorkUnits: 1_000_000,
      maximumMilliseconds: 1_000_000,
    };
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "staged-detail-expiry",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
      presentationRebuildBudget: budget,
    });
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
      grassRadiusMeters: 1,
    };
    const origin = { x: 0, y: 0, z: 0 };
    const initialObserver = { x: 64, y: 120, z: 64 };
    const internals = runtime as unknown as {
      readonly batches: Map<string, {
        readonly mesh: Mesh;
        readonly writer: object;
        readonly gpu: { readonly shared: Buffer } | null;
      }>;
      readonly presentationChunks: Map<string, {
        readonly batchKeys: Set<string>;
        readonly revision: number;
        readonly observerX: number;
        readonly observerZ: number;
        readonly observerSensitive: boolean;
        readonly validitySuppressed: boolean;
      }>;
      readonly batchesDirty: boolean;
      readonly cells: Map<string, { readonly generation: number }>;
      readonly desiredKeys: Set<string>;
      readonly cellEpoch: number;
    };

    try {
      for (let pass = 0; pass < 256; pass += 1) {
        runtime.update(initialObserver, origin, profile);
        if (
          !internals.batchesDirty
          && internals.cells.size === internals.desiredKeys.size
          && [...internals.cells.values()].every(
            (resident) => resident.generation === internals.cellEpoch,
          )
        ) break;
      }
      expect(runtime.pendingWorkItems).toBe(0);
      const chunk = internals.presentationChunks.get("0:0")
        ?? [...internals.presentationChunks.values()].find(
          (candidate) => candidate.observerSensitive && candidate.batchKeys.size > 0,
        );
      expect(chunk).toBeDefined();
      expect(chunk!.revision).toBeGreaterThan(0);
      expect(chunk!.observerSensitive).toBe(true);
      expect(chunk!.validitySuppressed).toBe(false);
      const liveOwners = [...chunk!.batchKeys].map((batchKey) => {
        const batch = internals.batches.get(batchKey)!;
        expect(batch.mesh.isEnabled()).toBe(true);
        return {
          batchKey,
          mesh: batch.mesh,
          writer: batch.writer,
          gpu: batch.gpu?.shared,
        };
      });
      expect(liveOwners.length).toBeGreaterThan(0);

      // One unit per update is intentionally too slow. Crossing the hard
      // envelope must hide the old complete snapshot rather than drawing it
      // stale or destroying any allocation it may still own.
      budget.maximumWorkUnits = 1;
      const staleObserver = {
        x: chunk!.observerX + DETAIL_MEMBERSHIP_SLACK_METERS + 1,
        y: 120,
        z: chunk!.observerZ,
      };
      runtime.update(staleObserver, origin, profile);
      expect(chunk!.validitySuppressed).toBe(true);
      expect(runtime.presentationRebuildDiagnostics.suppressedChunks).toBeGreaterThan(0);
      expect(runtime.presentationRebuildDiagnostics.maximumLiveObserverDriftMeters)
        .toBeLessThanOrEqual(DETAIL_MEMBERSHIP_SLACK_METERS);
      expect(runtime.pendingWorkItems).toBeGreaterThan(0);
      for (const owner of liveOwners) {
        const batch = internals.batches.get(owner.batchKey)!;
        expect(batch.mesh.isEnabled()).toBe(false);
        expect(batch.mesh).toBe(owner.mesh);
        expect(batch.writer).toBe(owner.writer);
        expect(batch.gpu?.shared).toBe(owner.gpu);
      }
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("finishes an immutable snapshot under observer supersession, then catches up", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const budget = {
      maximumWorkUnits: 1_000_000,
      maximumMilliseconds: 1_000_000,
    };
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "staged-detail-supersession",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
      presentationRebuildBudget: budget,
    });
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
      grassRadiusMeters: 1,
    };
    const origin = { x: 0, y: 0, z: 0 };
    const internals = runtime as unknown as {
      readonly batchesDirty: boolean;
      readonly cells: Map<string, { readonly generation: number }>;
      readonly desiredKeys: Set<string>;
      readonly cellEpoch: number;
      readonly signature: string;
      readonly pendingPresentationBuild: {
        readonly signature: string;
        readonly coordinates: { readonly key: string };
      } | null;
      readonly presentationChunks: Map<string, { readonly signature: string }>;
    };

    try {
      const initialObserver = { x: 64, y: 120, z: 64 };
      for (let pass = 0; pass < 256; pass += 1) {
        runtime.update(initialObserver, origin, profile);
        if (
          !internals.batchesDirty
          && internals.cells.size === internals.desiredKeys.size
          && [...internals.cells.values()].every(
            (resident) => resident.generation === internals.cellEpoch,
          )
        ) break;
      }
      expect(internals.batchesDirty).toBe(false);

      budget.maximumWorkUnits = 64;
      const publicationsBefore = runtime.presentationRebuildDiagnostics.publications;
      const cancellationsBefore = runtime.presentationRebuildDiagnostics.cancellations;
      runtime.update({ x: 129, y: 120, z: 64 }, origin, profile);
      const immutableSignature = internals.pendingPresentationBuild!.signature;
      const activeChunkKey = internals.pendingPresentationBuild!.coordinates.key;
      const targetSignatures = new Set<string>([internals.signature]);
      for (let pass = 0; pass < 512; pass += 1) {
        const x = pass % 2 === 0 ? 64 : 129;
        runtime.update({ x, y: 120, z: 64 }, origin, profile);
        targetSignatures.add(internals.signature);
        expect(runtime.presentationRebuildDiagnostics.cancellations)
          .toBe(cancellationsBefore);
        if (runtime.presentationRebuildDiagnostics.publications > publicationsBefore) break;
      }
      expect(targetSignatures.size).toBeGreaterThan(1);
      expect(runtime.presentationRebuildDiagnostics.publications)
        .toBeGreaterThan(publicationsBefore);
      expect(internals.presentationChunks.get(activeChunkKey)!.signature)
        .toBe(immutableSignature);

      // Stop changing the target and drain every superseded chunk. The last
      // publication must no longer carry the older immutable signature.
      budget.maximumWorkUnits = 1_000_000;
      const finalObserver = { x: 129, y: 120, z: 64 };
      for (let pass = 0; pass < 256; pass += 1) {
        runtime.update(finalObserver, origin, profile);
        if (!internals.batchesDirty) break;
      }
      expect(internals.batchesDirty).toBe(false);
      expect(internals.pendingPresentationBuild).toBeNull();
      expect(internals.presentationChunks.get(activeChunkKey)!.signature)
        .not.toBe(immutableSignature);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("publishes byte-identical records and bounds regardless of slice width", () => {
    const engine = new NullEngine();
    const slicedScene = new Scene(engine);
    const drainedScene = new Scene(engine);
    const observer = { x: 64, y: 120, z: 64 };
    const origin = { x: 1_024, y: 30, z: -512 };
    for (const [name, scene] of [
      ["sliced", slicedScene],
      ["drained", drainedScene],
    ] as const) {
      const camera = new FreeCamera(name, new Vector3(64, 120, 64), scene);
      camera.setTarget(new Vector3(64, 0, 1_000));
      scene.activeCamera = camera;
    }
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
      grassRadiusMeters: 1,
    };
    const sliced = new WorldDetailRuntime(slicedScene, {
      worldSeed: "staged-detail-byte-equivalence",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
      presentationRebuildBudget: {
        maximumWorkUnits: 257,
        maximumMilliseconds: 1_000_000,
      },
    });
    const drained = new WorldDetailRuntime(drainedScene, {
      worldSeed: "staged-detail-byte-equivalence",
      terrainSample: forestTerrain,
      cellSizeMeters: 128,
      presentationRebuildBudget: {
        maximumWorkUnits: 1_000_000,
        maximumMilliseconds: 1_000_000,
      },
    });
    type ComparableInternals = {
      readonly batchesDirty: boolean;
      readonly cells: Map<string, { readonly generation: number }>;
      readonly desiredKeys: Set<string>;
      readonly cellEpoch: number;
      readonly batches: Map<string, {
        readonly writer: { finish(): Uint8Array };
        readonly bounds: { minimum(): number[]; maximum(): number[] };
      }>;
    };
    const slicedInternals = sliced as unknown as ComparableInternals;
    const drainedInternals = drained as unknown as ComparableInternals;
    const settled = (runtime: WorldDetailRuntime, state: ComparableInternals): boolean => (
      !state.batchesDirty
      && runtime.presentationRebuildDiagnostics.activeChunkKey === null
      && state.cells.size === state.desiredKeys.size
      && [...state.cells.values()].every(
        (resident) => resident.generation === state.cellEpoch,
      )
    );

    try {
      for (let pass = 0; pass < 1_024; pass += 1) {
        if (!settled(sliced, slicedInternals)) sliced.update(observer, origin, profile);
        if (!settled(drained, drainedInternals)) drained.update(observer, origin, profile);
        if (settled(sliced, slicedInternals) && settled(drained, drainedInternals)) break;
      }
      expect(settled(sliced, slicedInternals)).toBe(true);
      expect(settled(drained, drainedInternals)).toBe(true);
      expect(sliced.statistics).toEqual(drained.statistics);
      const slicedKeys = [...slicedInternals.batches.keys()].sort();
      const drainedKeys = [...drainedInternals.batches.keys()].sort();
      expect(slicedKeys).toEqual(drainedKeys);
      for (const key of slicedKeys) {
        const slicedBatch = slicedInternals.batches.get(key)!;
        const drainedBatch = drainedInternals.batches.get(key)!;
        expect(slicedBatch.writer.finish(), `${key} packed bytes`)
          .toEqual(drainedBatch.writer.finish());
        expect(slicedBatch.bounds.minimum(), `${key} minimum bound`)
          .toEqual(drainedBatch.bounds.minimum());
        expect(slicedBatch.bounds.maximum(), `${key} maximum bound`)
          .toEqual(drainedBatch.bounds.maximum());
      }
    } finally {
      sliced.dispose();
      drained.dispose();
      slicedScene.dispose();
      drainedScene.dispose();
      engine.dispose();
    }
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
      // Preserve this test's traverse/teleport cadence so it measures only
      // GPU allocation recycling, not the independent synthesis scheduler.
      presentationRebuildBudget: {
        maximumWorkUnits: 1_000_000,
        maximumMilliseconds: 1_000_000,
      },
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
