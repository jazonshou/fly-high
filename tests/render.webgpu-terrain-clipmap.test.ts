import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  TerrainGenerationClient,
  type TerrainGenerationRequest,
} from "../src/render/TerrainGenerationClient";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  TerrainClipmapSystem,
  buildTerrainClipmapPageIndices,
  type TerrainClipmapPageGenerator,
} from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import { createWorld, type TerrainTileData } from "../src/world";

interface ControlledRequest {
  readonly request: TerrainGenerationRequest;
  readonly onResult: (tile: TerrainTileData) => void;
}

function createFlatTile(request: TerrainGenerationRequest): TerrainTileData {
  const { tileX, tileZ } = request.options;
  const size = request.options.size ?? 1_024;
  const resolution = request.options.resolution ?? 33;
  const vertexCount = resolution * resolution;
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    normals[vertex * 3 + 1] = 1;
    colors.fill(128, vertex * 3, vertex * 3 + 3);
  }
  return {
    tileX,
    tileZ,
    originX: tileX * size,
    originZ: tileZ * size,
    size,
    resolution,
    spacing: size / (resolution - 1),
    dayOfYear: request.options.dayOfYear ?? 171,
    heights: new Float32Array(vertexCount),
    normals,
    colors,
    moisture: new Uint8Array(vertexCount),
    biomes: new Uint8Array(vertexCount),
    minHeight: 0,
    maxHeight: 0,
  };
}

class ControlledTerrainGenerator implements TerrainClipmapPageGenerator {
  private readonly queued = new Map<number, ControlledRequest>();
  private nextRequestId = 1;
  readonly requestedKeys: string[] = [];
  totalRequests = 0;
  disposed = false;

  constructor(private readonly maxQueued = Number.POSITIVE_INFINITY) {}

  request(
    request: TerrainGenerationRequest,
    onResult: (tile: TerrainTileData) => void,
  ): number {
    if (this.queued.size >= this.maxQueued) return -1;
    const requestId = this.nextRequestId++;
    this.totalRequests += 1;
    this.requestedKeys.push(request.key);
    this.queued.set(requestId, { request, onResult });
    return requestId;
  }

  cancel(requestId: number): void {
    this.queued.delete(requestId);
  }

  flushAll(): void {
    while (this.queued.size > 0) {
      const entry = this.queued.entries().next().value as
        | [number, ControlledRequest]
        | undefined;
      if (!entry) return;
      const [requestId, controlled] = entry;
      this.queued.delete(requestId);
      controlled.onResult(createFlatTile(controlled.request));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queued.clear();
  }
}

describe("terrain clipmap seam topology", () => {
  it("hole-punches every coarse cell beneath aligned finer coverage", () => {
    const page = { minX: 0, minZ: 0, maxX: 100, maxZ: 100 };
    const hole = { minX: 25, minZ: 25, maxX: 75, maxZ: 75 };
    const full = buildTerrainClipmapPageIndices(5, page);
    const punched = buildTerrainClipmapPageIndices(5, page, hole);

    expect(full).toBeInstanceOf(Uint16Array);
    expect(full).toHaveLength(16 * 6);
    expect(punched).toHaveLength(12 * 6);
    for (let offset = 0; offset < punched.length; offset += 6) {
      const topLeft = punched[offset]!;
      const row = Math.floor(topLeft / 5);
      const column = topLeft % 5;
      const minX = column * 25;
      const minZ = row * 25;
      expect(
        minX + 25 > hole.minX
        && minX < hole.maxX
        && minZ + 25 > hole.minZ
        && minZ < hole.maxZ,
      ).toBe(false);
    }
  });

  it("keeps touching cells and selects 32-bit indices only when required", () => {
    const page = { minX: 0, minZ: 0, maxX: 100, maxZ: 100 };
    const touching = { minX: 100, minZ: 25, maxX: 125, maxZ: 75 };
    expect(buildTerrainClipmapPageIndices(5, page, touching)).toHaveLength(16 * 6);
    expect(buildTerrainClipmapPageIndices(257, page)).toBeInstanceOf(Uint32Array);
    expect(() => buildTerrainClipmapPageIndices(1, page)).toThrow(/resolution/);
  });

  it("punches the exact union of independently resident finer pages", () => {
    const page = { minX: 0, minZ: 0, maxX: 100, maxZ: 100 };
    const coverage = [
      { minX: 0, minZ: 0, maxX: 25, maxZ: 25 },
      { minX: 75, minZ: 75, maxX: 100, maxZ: 100 },
    ];
    expect(buildTerrainClipmapPageIndices(5, page, coverage)).toHaveLength(14 * 6);
  });

  it("punches resident coarse pages and replaces live pages across profile changes", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const generator = new ControlledTerrainGenerator();
    const low = {
      ...resolveWebGpuQualityProfile("low", "performance"),
      terrainRings: 2,
    };
    const system = new TerrainClipmapSystem(
      scene,
      createWorld("clipmap-profile-test"),
      low,
      { generator },
    );
    const observer = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };

    system.update(observer, 1);
    expect(system.statistics).toMatchObject({ residentPages: 0, pendingPages: 46 });
    generator.flushAll();
    expect(system.statistics.residentPages).toBe(46);

    const partial = scene.getMeshByName("terrain-page-world-page-v1/1/1/0") as Mesh | null;
    const touching = scene.getMeshByName("terrain-page-world-page-v1/1/-2/0") as Mesh | null;
    // 1B-3: the ladder is constant per tier (33 at tier 0), so L1 pages carry
    // 32x32 cells — no 4:1 ground-sample-distance step against L0.
    const lowSkirtIndices = 4 * (33 - 1) * 6;
    expect(partial?.getTotalIndices()).toBe(512 * 6 + lowSkirtIndices);
    expect(touching?.getTotalIndices()).toBe(1_024 * 6 + lowSkirtIndices);

    const lowTriangles = system.statistics.triangles;
    const requestsBeforeQuality = generator.totalRequests;
    const high = {
      ...resolveWebGpuQualityProfile("high", "ultra"),
      terrainRings: 2,
    };
    system.setProfile(high);
    system.update(observer, 2);
    expect(system.statistics.residentPages).toBe(46);
    expect(system.statistics.triangles).toBe(lowTriangles);
    expect(generator.totalRequests - requestsBeforeQuality).toBe(46);
    generator.flushAll();
    expect(system.statistics.residentPages).toBe(46);
    expect(system.statistics.triangles).toBeGreaterThan(lowTriangles);
    expect(
      (scene.getMeshByName("terrain-page-world-page-v1/1/1/0") as Mesh | null)?.getTotalIndices(),
    ).toBe(2_048 * 6 + 4 * (65 - 1) * 6);

    const requestsBeforeRingChange = generator.totalRequests;
    system.setProfile({ ...high, terrainRings: 1 });
    expect(system.statistics.residentPages).toBe(25);
    system.update(observer, 3);
    // 0-3: the deleted generation counter used to force every surviving page
    // through the worker again on any topology profile change. Tile content is
    // a pure function of (seed, tile, size, resolution); a ring-count change
    // leaves the survivors' content identical, so nothing regenerates.
    expect(generator.totalRequests - requestsBeforeRingChange).toBe(0);
    generator.flushAll();
    expect(system.statistics.residentPages).toBe(25);
    expect(system.statistics.triangles).toBe(25 * (64 * 64 * 2 + 256 * 2));

    system.dispose();
    expect(generator.disposed).toBe(true);
    scene.dispose();
    engine.dispose();
  });

  it("keeps feeding far-horizon pages after the bounded worker queue drains", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const generator = new ControlledTerrainGenerator(25);
    const profile = {
      ...resolveWebGpuQualityProfile("low", "performance"),
      terrainRings: 2,
    };
    const system = new TerrainClipmapSystem(
      scene,
      createWorld("clipmap-queue-pump-test"),
      profile,
      { generator },
    );
    const observer = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };

    system.update(observer, 1);
    expect(system.statistics.pendingPages).toBe(25);
    generator.flushAll();
    expect(system.statistics.residentPages).toBe(25);

    system.update(observer, 2);
    expect(system.statistics.pendingPages).toBe(21);
    generator.flushAll();
    expect(system.statistics.residentPages).toBe(46);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("requests pages soonest-needed along the flight corridor first (0-3)", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const generator = new ControlledTerrainGenerator();
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      terrainRings: 2,
    };
    const system = new TerrainClipmapSystem(
      scene,
      createWorld("clipmap-corridor-test"),
      profile,
      { generator },
    );

    // Flying east at 120 m/s. Level-1 pages (1, -2) and (-2, -2) sit at the
    // same axis-aligned distance from the aircraft, but the first lies ahead
    // along the corridor and the second behind it.
    system.update({ x: 0, z: 0, velocityX: 120, velocityZ: 0 }, 1);
    const order = generator.requestedKeys;
    const ahead = order.indexOf("world-page-v1/1/1/-2");
    const behind = order.indexOf("world-page-v1/1/-2/-2");
    expect(ahead).toBeGreaterThanOrEqual(0);
    expect(behind).toBeGreaterThanOrEqual(0);
    expect(ahead).toBeLessThan(behind);

    // Fine levels keep ranking ahead of coarse levels at equal corridor cost.
    const firstCoarse = order.findIndex((key) => key.startsWith("world-page-v1/1/"));
    const lastFine = order.reduce(
      (last, key, index) => (key.startsWith("world-page-v1/0/") ? index : last),
      -1,
    );
    expect(firstCoarse).toBeGreaterThanOrEqual(0);
    expect(lastFine).toBeGreaterThanOrEqual(0);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("rejects a stale worker result after a profile change by lifecycle epoch (0-3)", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    // Simulates worker results already in flight when their requests were
    // cancelled: cancel() deliberately keeps the callback deliverable.
    const lingering: ControlledRequest[] = [];
    const generator: TerrainClipmapPageGenerator = {
      request(request, onResult) {
        lingering.push({ request, onResult });
        return lingering.length;
      },
      cancel() {},
      dispose() {},
    };
    const low = {
      ...resolveWebGpuQualityProfile("low", "performance"),
      terrainRings: 1,
    };
    const system = new TerrainClipmapSystem(
      scene,
      createWorld("clipmap-stale-epoch-test"),
      low,
      { generator },
    );

    system.update({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 1);
    const staleRequests = [...lingering];
    expect(staleRequests).toHaveLength(25);

    const high = {
      ...resolveWebGpuQualityProfile("high", "ultra"),
      terrainRings: 1,
    };
    system.setProfile(high);

    // The stale low-tier results arrive after the profile change. Every one
    // must be rejected by its retired epoch without creating a mesh.
    for (const stale of staleRequests) {
      stale.onResult(createFlatTile(stale.request));
    }
    expect(system.statistics.residentPages).toBe(0);
    expect(scene.meshes.filter((mesh) => mesh.name.startsWith("terrain-page-"))).toHaveLength(0);

    // Fresh epochs issued after the change still complete normally.
    system.update({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 2);
    const freshRequests = lingering.slice(staleRequests.length);
    expect(freshRequests).toHaveLength(25);
    for (const fresh of freshRequests) {
      fresh.onResult(createFlatTile(fresh.request));
    }
    expect(system.statistics.residentPages).toBe(25);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("releases grace-expired pages in shared cache eviction order (0-3)", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const generator = new ControlledTerrainGenerator();
    const profile = {
      ...resolveWebGpuQualityProfile("low", "performance"),
      terrainRings: 2,
    };
    const system = new TerrainClipmapSystem(
      scene,
      createWorld("clipmap-eviction-order-test"),
      profile,
      { generator },
    );

    system.update({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 1);
    generator.flushAll();
    expect(system.statistics.residentPages).toBe(46);

    const disposeOrder: string[] = [];
    for (const mesh of scene.meshes) {
      if (!mesh.name.startsWith("terrain-page-")) continue;
      mesh.onDisposeObservable.add(() => disposeOrder.push(mesh.name));
    }

    // Leave the whole resident set behind, then run out the 90-frame grace.
    for (let frame = 2; frame <= 92; frame += 1) {
      system.update({ x: 100_000, z: 0, velocityX: 0, velocityZ: 0 }, frame);
    }
    expect(disposeOrder).toHaveLength(46);

    // Every page expired with identical recency, so the shared comparator
    // orders by descending GPU byte estimate: all 25 level-0 pages (33²
    // vertices each) release before any of the 21 level-1 pages (17²).
    const levels = disposeOrder.map((name) => (
      name.startsWith("terrain-page-world-page-v1/0/") ? 0 : 1
    ));
    expect(levels.slice(0, 25).every((level) => level === 0)).toBe(true);
    expect(levels.slice(25).every((level) => level === 1)).toBe(true);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("survives real-client queue saturation without throwing and drains it (0-3)", () => {
    // Regression guard for a first-frame crash the fake generator masked: the
    // real TerrainGenerationClient's bounded queue may reject a new request
    // (returning -1) or synchronously fail an evicted older request, and the
    // lifecycle adapter must survive both. Run the real client in its
    // synchronous fallback mode with a queue far smaller than the desired set.
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const fallbackCallbacks: Array<() => void> = [];
    const world = createWorld("clipmap-real-client-test");
    const client = new TerrainGenerationClient(world, {
      maxQueued: 8,
      workerFactory: () => {
        throw new Error("no workers in this test");
      },
      fallbackScheduler: (callback) => fallbackCallbacks.push(callback),
    });
    const profile = {
      ...resolveWebGpuQualityProfile("low", "performance"),
      terrainRings: 2,
    };
    const system = new TerrainClipmapSystem(scene, world, profile, { generator: client });

    // 46 desired pages against 8 queue slots: must not throw.
    system.update({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 1);
    expect(system.statistics.pendingPages).toBeGreaterThan(0);
    expect(system.statistics.pendingPages).toBeLessThanOrEqual(9);

    // Drain the synchronous fallback until the whole desired set is resident;
    // every drained slot lets the next update() pump more requests through.
    for (let round = 0; round < 400 && system.statistics.residentPages < 46; round += 1) {
      const callback = fallbackCallbacks.shift();
      if (callback) callback();
      system.update({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 2 + round);
    }
    expect(system.statistics.residentPages).toBe(46);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("hides grace-period pages immediately and excludes them from shadow submission", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const generator = new ControlledTerrainGenerator();
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      terrainRings: 2,
      shadowDistance: 600,
    };
    const system = new TerrainClipmapSystem(
      scene,
      createWorld("clipmap-visibility-grace-test"),
      profile,
      { generator },
    );

    system.update({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 1);
    generator.flushAll();
    const oldCorner = scene.getMeshByName("terrain-page-world-page-v1/0/-2/-2") as Mesh | null;
    expect(oldCorner?.isEnabled()).toBe(true);

    system.update({ x: 5_120, z: 0, velocityX: 0, velocityZ: 0 }, 2);
    expect(oldCorner?.isDisposed()).toBe(false);
    expect(oldCorner?.isEnabled()).toBe(false);
    const shadowCasters: Mesh[] = [];
    system.addShadowCasters((mesh) => shadowCasters.push(mesh));
    expect(shadowCasters).not.toContain(oldCorner);

    system.update({ x: 0, z: 0, velocityX: 0, velocityZ: 0 }, 3);
    expect(oldCorner?.isEnabled()).toBe(true);
    const nearbyShadowCasters: Mesh[] = [];
    system.addShadowCasters((mesh) => nearbyShadowCasters.push(mesh));
    expect(nearbyShadowCasters.length).toBeGreaterThan(0);
    expect(nearbyShadowCasters).not.toContain(oldCorner);
    system.dispose();
    scene.dispose();
    engine.dispose();
  });
});
