import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { createWorld, hashSeed, TerrainBiome } from "../src/world";
import { DetailGenerationClient } from "../src/render/webgpu/detail/DetailGenerationClient";
import { densityField } from "../src/render/webgpu/detail/densityField";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { DetailWorkerCommand } from "../src/workers/detailProtocol";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";

/**
 * 1B-10 — the detail worker offload. The client mirrors the terrain
 * scheduler's contract (bounded priority queue, -1-alone rejection, stale
 * epoch drop); the fake worker echoes real generateDetailCell output so the
 * async path applies byte-identical cells to the inline path.
 */

class FakeDetailWorker {
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly commands: DetailWorkerCommand[] = [];
  readonly transfers: Transferable[][] = [];

  postMessage(message: DetailWorkerCommand, transfer: Transferable[] = []): void {
    this.commands.push(message);
    this.transfers.push(transfer);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}

  emit(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data } as unknown as Event);
    }
  }
}

const forestSample = (): DetailTerrainSample => ({
  height: 220,
  slope: 0.05,
  moisture: 0.68,
  biome: TerrainBiome.FOREST,
});

/**
 * Gate B deliberately makes world zero capable of being a meadow. Select a
 * deterministic closed-canopy cell so this worker/runtime parity test still
 * exercises non-empty tree buffers instead of depending on an accidental
 * biome at one coordinate.
 */
function selectClosedForestCell(worldSeed: string): {
  readonly cellX: number;
  readonly cellZ: number;
  readonly meanDensity: number;
} {
  const cellSize = 128;
  const seedHash = hashSeed(worldSeed);
  let best = { cellX: 0, cellZ: 0, meanDensity: Number.NEGATIVE_INFINITY };
  for (let cellZ = -64; cellZ <= 64; cellZ += 2) {
    for (let cellX = -64; cellX <= 64; cellX += 2) {
      let total = 0;
      for (const localZ of [32, 96]) {
        for (const localX of [32, 96]) {
          total += densityField(seedHash, {
            filterWidthMeters: 0,
            x: cellX * cellSize + localX,
            z: cellZ * cellSize + localZ,
            heightMeters: 220,
            seaLevelMeters: 0,
            slope: 0.05,
            moisture: 0.68,
            dayOfYear: 171,
          }).treeStemsPerSquareMeter;
        }
      }
      const meanDensity = total / 4;
      if (meanDensity > best.meanDensity) best = { cellX, cellZ, meanDensity };
    }
  }
  return best;
}

describe("detail generation client (1B-10)", () => {
  it("transfers macro and final L0 authority publications to the worker", () => {
    const worker = new FakeDetailWorker();
    const world = createWorld("detail-evolved-authority", {
      airport: false,
      worldEvolution: "eroded",
    });
    const client = new DetailGenerationClient({
      worldSeed: world.seed,
      world,
      cellSizeMeters: 128,
      seaLevelMeters: world.seaLevel,
      workerFactory: () => worker as unknown as Worker,
    });
    expect(worker.commands[0]).toMatchObject({ type: "initialize", world });
    const macroHeights = new Float32Array([10, 20, 30, 40]);
    const pageHeights = new Float32Array(256 * 256).fill(321);
    const shoreDistance = new Int16Array(136 * 136).fill(24);
    expect(client.publishTerrainMacro({
      originX: 0,
      originZ: 0,
      texelSizeMeters: 512,
      width: 2,
      height: 2,
      heights: macroHeights,
    })).toBe(true);
    expect(client.publishTerrainPage({
      level: 0,
      tileX: 2,
      tileZ: -3,
      heights: pageHeights,
    })).toBe(true);
    expect(client.publishTerrainAuxPage({
      level: 0,
      tileX: 2,
      tileZ: -3,
      coreSize: 128,
      gutter: 4,
      storedEdge: 136,
      texelSizeMeters: 4,
      shoreDistanceMetersPerUnit: 0.25,
      shoreDistanceR16Sint: shoreDistance,
    })).toBe(true);

    expect(worker.commands.slice(1).map((command) => command.type)).toEqual([
      "terrainMacro",
      "terrainPage",
      "terrainAux",
    ]);
    expect(worker.transfers[1]).toEqual([macroHeights.buffer]);
    expect(worker.transfers[2]).toEqual([pageHeights.buffer]);
    expect(worker.transfers[3]).toEqual([shoreDistance.buffer]);
    client.dispose();
  });

  it("dispatches one request at a time by priority and drops stale generations", () => {
    const worker = new FakeDetailWorker();
    const client = new DetailGenerationClient({
      worldSeed: "detail-client",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    });
    expect(worker.commands[0]).toMatchObject({ type: "initialize", worldSeed: "detail-client" });

    const results: string[] = [];
    const request = (key: string, priority: number, generation = 1) => client.request(
      { key, generation, priority, cellX: 0, cellZ: 0, densityMultiplier: 1, dayOfYear: 0 },
      () => { results.push(key); },
    );
    const first = request("cell:a", 5);
    const second = request("cell:b", 1);
    expect(client.busy).toBe(true);
    // First request dispatched immediately; the better-priority newcomer waits.
    expect(worker.commands.filter((c) => c.type === "generate")).toHaveLength(1);
    expect(second).toBeGreaterThan(0);

    // A stale-generation response is dropped without applying.
    worker.emit({ type: "cell", requestId: first, generation: 2, key: "cell:a", cell: {} });
    expect(results).toEqual([]);
    // The slot freed; the queued request dispatched.
    const generates = worker.commands.filter((c) => c.type === "generate");
    expect(generates).toHaveLength(2);
    expect((generates[1] as { key: string }).key).toBe("cell:b");
    worker.emit({ type: "cell", requestId: second, generation: 1, key: "cell:b", cell: {} });
    expect(results).toEqual(["cell:b"]);
    client.dispose();
  });

  it("applies worker cells identically to inline generation through the runtime", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const worker = new FakeDetailWorker();
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "worker-parity",
      terrainSample: forestSample,
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerWorldSeed: "worker-parity",
    });
    // Reach in via the injected factory path: rebuild the client with a fake.
    (runtime as unknown as { client: DetailGenerationClient }).client.dispose();
    (runtime as unknown as { client: DetailGenerationClient }).client =
      new DetailGenerationClient({
        worldSeed: "worker-parity",
        cellSizeMeters: 128,
        seaLevelMeters: 0,
        workerFactory: () => worker as unknown as Worker,
      });

    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
    };
    const closedCell = selectClosedForestCell("worker-parity");
    expect(closedCell.meanDensity, "worker parity fixture is closed forest").toBeGreaterThan(0.03);
    const observer = {
      x: (closedCell.cellX + 0.5) * 128,
      y: 100,
      z: (closedCell.cellZ + 0.5) * 128,
    };
    runtime.update(observer, { x: 0, y: 0, z: 0 }, profile);
    expect(runtime.statistics.residentCells).toBe(0);
    const generates = worker.commands.filter(
      (command) => command.type === "generate",
    ) as Extract<DetailWorkerCommand, { type: "generate" }>[];
    expect(generates.length).toBeGreaterThan(0);

    // Answer every request the way the real worker would, pumping updates so
    // freed slots dispatch the queued remainder.
    for (let round = 0; round < 200 && runtime.statistics.residentCells === 0; round += 1) {
      const all = worker.commands.filter(
        (command) => command.type === "generate",
      ) as Extract<DetailWorkerCommand, { type: "generate" }>[];
      const next = all[all.length - 1]!;
      worker.emit({
        type: "cell",
        requestId: next.requestId,
        generation: next.generation,
        key: next.key,
        cell: generateDetailCell({
          worldSeed: "worker-parity",
          cellX: next.cellX,
          cellZ: next.cellZ,
          cellSizeMeters: 128,
          densityMultiplier: next.densityMultiplier,
          terrainSample: forestSample,
          seaLevelMeters: 0,
          dayOfYear: next.dayOfYear,
        }),
      });
      runtime.update(observer, { x: 0, y: 0, z: 0 }, profile);
    }
    expect(runtime.statistics.residentCells).toBeGreaterThan(0);
    expect(runtime.statistics.treeInstances).toBeGreaterThan(0);

    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("falls back to inline generation when the worker dies", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const worker = new FakeDetailWorker();
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "worker-fallback",
      terrainSample: forestSample,
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerWorldSeed: "worker-fallback",
    });
    (runtime as unknown as { client: DetailGenerationClient }).client.dispose();
    const client = new DetailGenerationClient({
      worldSeed: "worker-fallback",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    }, () => {
      (runtime as unknown as { client: DetailGenerationClient | null }).client = null;
    });
    (runtime as unknown as { client: DetailGenerationClient }).client = client;

    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
    };
    runtime.update({ x: 64, y: 100, z: 64 }, { x: 0, y: 0, z: 0 }, profile);
    // The worker dies; the unavailability callback clears the client and the
    // next updates generate inline.
    for (const listener of worker.listeners.get("error") ?? []) {
      listener({ preventDefault: () => undefined } as unknown as Event);
    }
    for (let round = 0; round < 16 && runtime.statistics.residentCells === 0; round += 1) {
      runtime.update({ x: 64, y: 100, z: 64 }, { x: 0, y: 0, z: 0 }, profile);
    }
    expect(runtime.statistics.residentCells).toBeGreaterThan(0);

    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });
});
