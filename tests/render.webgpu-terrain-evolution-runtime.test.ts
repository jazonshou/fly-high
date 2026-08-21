import { describe, expect, it } from "vitest";
import {
  TerrainEvolutionRuntime,
  type TerrainMacroEvolutionClientPort,
} from "../src/render/webgpu/terrain/TerrainEvolutionRuntime";
import type {
  TerrainMacroEvolutionClientResult,
  TerrainMacroEvolutionProgress,
} from "../src/render/webgpu/terrain/TerrainMacroEvolutionClient";
import {
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";

function fixtureEvolution(): TerrainMacroEvolutionExport {
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: "runtime-fixture", deviceFingerprint: "node-worker" },
    seaLevelMeters: 0,
    heightMeters: new Float32Array([11, 10, 9, 8]),
    flowAccumulationAreaM2: new Float32Array([1, 2, 3, 4]),
    lakeMask: new Uint8Array(4),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(),
  };
}

function fixtureGraph(evolution: TerrainMacroEvolutionExport): TerrainChannelGraphExport {
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: evolution.provenance,
    nodes: [],
    edges: [],
    lakePolygons: [],
    lakes: [],
  };
}

function fixtureClientResult(): TerrainMacroEvolutionClientResult {
  const evolution = fixtureEvolution();
  return {
    evolution,
    macroGrid: {
      originX: -256,
      originZ: -256,
      texelSizeMeters: 512,
      width: 2,
      height: 2,
      heights: evolution.heightMeters.slice(),
    },
    elapsedMilliseconds: 900,
    samplingElapsedMilliseconds: 250,
    workerGenerated: true,
  };
}

const ANALYTIC_WORLD = {
  seed: "runtime-fixture",
  seedHash: 71,
  seaLevel: 0,
  worldEvolution: "analytic" as const,
};

const ERODED_WORLD = {
  ...ANALYTIC_WORLD,
  worldEvolution: "eroded" as const,
};

class ImmediateMacroClient implements TerrainMacroEvolutionClientPort {
  disposed = false;

  constructor(private readonly output: TerrainMacroEvolutionClientResult) {}

  initialize(
    _world: typeof ERODED_WORLD,
    onProgress?: (progress: TerrainMacroEvolutionProgress) => void,
  ): Promise<TerrainMacroEvolutionClientResult> {
    onProgress?.({
      phase: "sampling-uplift",
      completed: 256,
      total: 1_024,
      overallFraction: 0.1125,
    });
    return Promise.resolve(this.output);
  }

  dispose(): void {
    this.disposed = true;
  }
}

class DeferredMacroClient implements TerrainMacroEvolutionClientPort {
  disposed = false;
  private reject: ((error: Error) => void) | null = null;

  initialize(): Promise<TerrainMacroEvolutionClientResult> {
    return new Promise((_resolve, reject) => {
      this.reject = reject;
    });
  }

  dispose(): void {
    this.disposed = true;
    const error = new Error("worker disposed");
    error.name = "AbortError";
    this.reject?.(error);
    this.reject = null;
  }
}

describe("terrain evolution runtime orchestration", () => {
  it("resolves analytic worlds without constructing or starting a macro worker", async () => {
    let factoryCalls = 0;
    const runtime = new TerrainEvolutionRuntime({
      macroClientFactory: () => {
        factoryCalls += 1;
        return new ImmediateMacroClient(fixtureClientResult());
      },
    });

    const result = await runtime.initialize(ANALYTIC_WORLD);
    expect(factoryCalls).toBe(0);
    expect(runtime.state).toBe("ready");
    expect(runtime.progress).toBeNull();
    expect(runtime.result).toBe(result);
    expect(result).toEqual({
      mode: "analytic",
      evolution: null,
      channelGraph: null,
      macroGrid: null,
    });
    expect(runtime.publishMacroOnce({ publishTerrainMacro: () => undefined })).toBe(false);
  });

  it("initializes eroded macro content, extracts channels, and exposes progress", async () => {
    const clientResult = fixtureClientResult();
    const client = new ImmediateMacroClient(clientResult);
    const reported: TerrainMacroEvolutionProgress[] = [];
    let extracted: TerrainMacroEvolutionExport | null = null;
    const graph = fixtureGraph(clientResult.evolution);
    const runtime = new TerrainEvolutionRuntime({
      deviceFingerprint: "node-worker",
      macroClientFactory: () => client,
      channelExtractor: {
        extract: (evolution) => {
          extracted = evolution;
          return graph;
        },
      },
      onProgress: (progress) => reported.push(progress),
    });

    const result = await runtime.initialize(ERODED_WORLD);
    expect(result.mode).toBe("eroded");
    if (result.mode !== "eroded") throw new Error("Expected eroded result");
    expect(extracted).toBe(clientResult.evolution);
    expect(result.evolution).toBe(clientResult.evolution);
    expect(result.channelGraph).toBe(graph);
    expect(result.macroGrid).toBe(clientResult.macroGrid);
    expect(result.elapsedMilliseconds).toBe(900);
    expect(reported).toHaveLength(1);
    expect(runtime.progress?.overallFraction).toBe(1);
    expect(runtime.state).toBe("ready");
    expect(client.disposed).toBe(true);
  });

  it("publishes the transfer-owned macro grid exactly once without detaching canonical height", async () => {
    const clientResult = fixtureClientResult();
    const runtime = new TerrainEvolutionRuntime({
      macroClientFactory: () => new ImmediateMacroClient(clientResult),
      channelExtractor: { extract: fixtureGraph },
    });
    const result = await runtime.initialize(ERODED_WORLD);
    if (result.mode !== "eroded") throw new Error("Expected eroded result");
    const canonicalBuffer = result.evolution.heightMeters.buffer;
    let calls = 0;
    const publisher = {
      publishTerrainMacro: (macro: typeof result.macroGrid): void => {
        calls += 1;
        structuredClone(macro.heights, {
          transfer: macro.heights.buffer instanceof ArrayBuffer ? [macro.heights.buffer] : [],
        });
      },
    };

    expect(runtime.publishMacroOnce(publisher)).toBe(true);
    expect(runtime.publishMacroOnce(publisher)).toBe(false);
    expect(calls).toBe(1);
    expect(runtime.hasPublishedMacro).toBe(true);
    expect(result.macroGrid.heights.byteLength).toBe(0);
    expect(result.evolution.heightMeters.buffer).toBe(canonicalBuffer);
    expect(result.evolution.heightMeters.byteLength).toBeGreaterThan(0);
    expect(Array.from(result.evolution.heightMeters)).toEqual([11, 10, 9, 8]);
  });

  it("surfaces channel-extraction failure and disposes its completed client", async () => {
    const client = new ImmediateMacroClient(fixtureClientResult());
    const runtime = new TerrainEvolutionRuntime({
      macroClientFactory: () => client,
      channelExtractor: {
        extract: () => {
          throw new Error("invalid channel topology");
        },
      },
    });
    await expect(runtime.initialize(ERODED_WORLD)).rejects.toThrow("invalid channel topology");
    expect(runtime.state).toBe("failed");
    expect(runtime.error?.message).toBe("invalid channel topology");
    expect(runtime.result).toBeNull();
    expect(client.disposed).toBe(true);
  });

  it("surfaces worker construction failure without remaining stuck initializing", async () => {
    const runtime = new TerrainEvolutionRuntime({
      macroClientFactory: () => {
        throw new Error("worker unavailable");
      },
    });
    await expect(runtime.initialize(ERODED_WORLD)).rejects.toThrow("worker unavailable");
    expect(runtime.state).toBe("failed");
    expect(runtime.progress).toBeNull();
    expect(runtime.error?.message).toBe("worker unavailable");
  });

  it("cancels pending work and releases retained results on disposal", async () => {
    const client = new DeferredMacroClient();
    const runtime = new TerrainEvolutionRuntime({ macroClientFactory: () => client });
    const pending = runtime.initialize(ERODED_WORLD);
    runtime.dispose();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(client.disposed).toBe(true);
    expect(runtime.state).toBe("disposed");
    expect(runtime.progress).toBeNull();
    expect(runtime.result).toBeNull();
    await expect(runtime.initialize(ANALYTIC_WORLD)).rejects.toThrow("disposed");
  });
});
