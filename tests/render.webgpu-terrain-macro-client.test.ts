import { describe, expect, it } from "vitest";
import {
  TerrainMacroEvolutionClient,
  terrainMacroGridFromEvolution,
  type TerrainMacroEvolutionProgress,
  type TerrainMacroEvolutionWorkerLike,
} from "../src/render/webgpu/terrain/TerrainMacroEvolutionClient";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import type {
  TerrainMacroEvolutionWorkerCommand,
  TerrainMacroEvolutionWorkerEvent,
} from "../src/workers/terrainMacroEvolutionProtocol";
import {
  sampleTerrainMacroEvolutionInputs,
  sampleTerrainMacroUplift,
} from "../src/workers/terrainMacroEvolutionRuntime";

class FakeMacroWorker implements TerrainMacroEvolutionWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => unknown) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null = null;
  readonly commands: TerrainMacroEvolutionWorkerCommand[] = [];
  terminated = false;

  postMessage(message: TerrainMacroEvolutionWorkerCommand): void {
    this.commands.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: TerrainMacroEvolutionWorkerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<unknown>);
  }
}

function canonicalEvolution(): TerrainMacroEvolutionExport {
  const heightMeters = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT);
  heightMeters[0] = 17.5;
  heightMeters[heightMeters.length - 1] = -42;
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: {
      worldSeed: "macro-client-test",
      deviceFingerprint: "test-cpu-worker",
    },
    seaLevelMeters: 0,
    heightMeters,
    flowAccumulationAreaM2: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
    lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array([17, 29]),
  };
}

describe("terrain macro evolution worker boundary", () => {
  it("samples deterministic uplift at cell centres with the texel filter width", () => {
    const calls: Array<readonly [number, number, number, number]> = [];
    const progress: Array<readonly [number, number]> = [];
    const first = sampleTerrainMacroUplift(
      {
        seedHash: 91,
        width: 3,
        height: 2,
        minWorldX: -12,
        minWorldZ: -8,
        texelSizeMeters: 4,
        progressStrideRows: 1,
      },
      (completed, total) => progress.push([completed, total]),
      (seedHash, worldX, worldZ, filterWidth) => {
        calls.push([seedHash, worldX, worldZ, filterWidth]);
        return seedHash + worldX * 2 + worldZ * 3;
      },
    );
    const second = sampleTerrainMacroUplift(
      {
        seedHash: 91,
        width: 3,
        height: 2,
        minWorldX: -12,
        minWorldZ: -8,
        texelSizeMeters: 4,
      },
      undefined,
      (seedHash, worldX, worldZ) => seedHash + worldX * 2 + worldZ * 3,
    );

    expect(calls[0]).toEqual([91, -10, -6, 4]);
    expect(calls.at(-1)).toEqual([91, -2, -2, 4]);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  it("samples macro lithology beside uplift for spatial erosion inputs", () => {
    const geologyCalls: Array<readonly [number, number]> = [];
    const sampled = sampleTerrainMacroEvolutionInputs(
      {
        seedHash: 7,
        width: 2,
        height: 2,
        minWorldX: -2,
        minWorldZ: -2,
        texelSizeMeters: 2,
        progressStrideRows: 1,
      },
      undefined,
      (_seedHash, worldX, worldZ) => worldX + worldZ,
      (_seedHash, worldX, worldZ, _filterWidth, target) => {
        geologyCalls.push([worldX, worldZ]);
        target.erodibility = 0.5 + worldX * 0.1;
        target.reposeDegrees = 30 + worldZ;
        target.fabricCos2 = 1;
        target.fabricSin2 = 0;
        return target;
      },
    );

    expect(geologyCalls).toEqual([[-1, -1], [1, -1], [-1, 1], [1, 1]]);
    expect(Array.from(sampled.heights)).toEqual([-2, 0, 0, 2]);
    expect(Array.from(sampled.erodibility)).toEqual([
      Math.fround(0.4), Math.fround(0.6), Math.fround(0.4), Math.fround(0.6),
    ]);
    expect(Array.from(sampled.reposeDegrees)).toEqual([29, 29, 31, 31]);
  });

  it("transfers one production request, reports progress, and forms a cell-centred sim grid", async () => {
    const worker = new FakeMacroWorker();
    const observed: TerrainMacroEvolutionProgress[] = [];
    const client = new TerrainMacroEvolutionClient({
      workerFactory: () => worker,
      deviceFingerprint: "test-cpu-worker",
      onProgress: (progress) => observed.push(progress),
    });
    const completion = client.initialize({
      seed: "macro-client-test",
      seedHash: 0x1234,
      seaLevel: 3,
    });

    expect(client.state).toBe("initializing");
    expect(worker.commands).toEqual([{
      type: "initialize",
      requestId: 1,
      worldSeed: "macro-client-test",
      seedHash: 0x1234,
      seaLevelMeters: 3,
      deviceFingerprint: "test-cpu-worker",
    }]);
    expect(Object.keys(worker.commands[0]!)).not.toContain("tier");
    worker.emit({
      type: "progress",
      requestId: 1,
      phase: "sampling-uplift",
      completed: 512,
      total: 1_024,
      overallFraction: 0.225,
    });
    expect(client.progress).toMatchObject({ completed: 512, total: 1_024 });

    const evolution = canonicalEvolution();
    worker.emit({
      type: "complete",
      requestId: 1,
      elapsedMilliseconds: 1_200,
      samplingElapsedMilliseconds: 350,
      evolution,
    });
    const result = await completion;

    expect(client.state).toBe("ready");
    expect(client.progress?.overallFraction).toBe(1);
    expect(observed).toHaveLength(2);
    expect(result.workerGenerated).toBe(true);
    expect(result.elapsedMilliseconds).toBe(1_200);
    expect(result.evolution).toBe(evolution);
    expect(result.macroGrid).toMatchObject({
      originX: -261_888,
      originZ: -261_888,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      width: EVOLUTION_DOMAIN_TEXELS,
      height: EVOLUTION_DOMAIN_TEXELS,
    });
    expect(result.macroGrid.heights).not.toBe(evolution.heightMeters);
    expect(result.macroGrid.heights[0]).toBe(17.5);
    expect(worker.terminated).toBe(true);
  });

  it("can expose the canonical height without a copy when ownership permits", () => {
    const evolution = canonicalEvolution();
    const grid = terrainMacroGridFromEvolution(evolution, false);
    expect(grid.heights).toBe(evolution.heightMeters);
    expect(grid.originX).toBe(-261_888);
    expect(grid.originZ).toBe(-261_888);
  });

  it("terminates and rejects an in-flight initialization on disposal", async () => {
    const worker = new FakeMacroWorker();
    const client = new TerrainMacroEvolutionClient({ workerFactory: () => worker });
    const completion = client.initialize({ seed: "dispose", seedHash: 17, seaLevel: 0 });
    client.dispose();

    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(client.state).toBe("disposed");
    expect(worker.terminated).toBe(true);
    await expect(client.initialize({ seed: "late", seedHash: 19, seaLevel: 0 }))
      .rejects.toThrow("disposed");
  });

  it("fails explicitly when no worker can be created instead of blocking inline", async () => {
    const client = new TerrainMacroEvolutionClient({
      workerFactory: () => {
        throw new Error("worker policy denied");
      },
    });
    await expect(client.initialize({ seed: "no-worker", seedHash: 23, seaLevel: 0 }))
      .rejects.toThrow("worker policy denied");
    expect(client.state).toBe("failed");
  });
});
