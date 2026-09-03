import { describe, expect, it } from "vitest";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  type TerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  TerrainEvolutionRuntime,
  gpuSampledMacroFingerprint,
  type TerrainMacroErosionGpuPort,
  type TerrainMacroEvolutionStagedWorkerLike,
  type TerrainMacroInputsGpuPort,
  type TerrainMacroInputsGpuSample,
} from "../src/render/webgpu/terrain/TerrainEvolutionRuntime";
import type {
  TerrainMacroErosionGpuRunInputs,
  TerrainMacroErosionGpuRunResult,
  TerrainMacroInputsGpuRequest,
} from "../src/render/webgpu/terrain/TerrainMacroErosionGpu";
import {
  evolveMacroTerrain,
  fingerprintEvolutionFields,
} from "../src/render/webgpu/terrain/TerrainMacroEvolution";
import type {
  TerrainMacroEvolutionProgress,
} from "../src/render/webgpu/terrain/TerrainMacroEvolutionClient";
import { ChannelNetwork } from "../src/render/webgpu/water/ChannelNetwork";
import {
  isTerrainMacroEvolutionStagedWorkerEvent,
  isTerrainMacroEvolutionWorkerEvent,
  type TerrainMacroEvolutionStage1Fields,
  type TerrainMacroEvolutionWorkerCommand,
} from "../src/workers/terrainMacroEvolutionProtocol";
import {
  completeTerrainMacroEvolutionFromEvolvedHeight,
  deriveTerrainMacroEvolutionStage1Fields,
  sampleTerrainMacroEvolutionInputs,
} from "../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../src/world";

/**
 * `W-1a` hybrid macro-erosion orchestration (Node half; the GPU half lives in
 * tests/gpu/terrain-macro-erosion-gpu.test.ts).
 *
 * Three claims:
 * 1. The single-shot CPU reference path is bit-untouched by the staging work
 *    (fingerprints recorded BEFORE the change, pinned here).
 * 2. The staged protocol round-trips: stage-1 fields validate and are the
 *    real drainage head; stage 2 accepts an evolved surface and produces an
 *    export whose non-height-derived invariants hold (every lake has an
 *    outlet, ChannelNetwork.extract succeeds, zero-iteration identity).
 * 3. TerrainEvolutionRuntime orchestrates stage1 -> GPU -> stage2 through the
 *    injected seams, stamping the GPU provenance fingerprint.
 * 4. `W-1b` wiring: with an inputs port the producer samples on device and
 *    stage 1 shrinks to the flood/MFD head; the leg fails OPEN back to the
 *    worker's CPU sampler; and the GPU-sampled landscape carries its own
 *    same-device fingerprint family.
 */

const DOMAIN = EVOLUTION_DOMAIN_SAMPLE_COUNT;

/**
 * Recorded on 2026-08-30 from the PRE-change tree (commit a272d83 work base)
 * via `npx tsx`: sampleTerrainMacroEvolutionInputs + evolveMacroTerrain at a
 * 48² slice of the production layout for the benchmark world (seed 333438,
 * seedHash 2728693428, seaLevel 0). Any drift here means the untouched
 * single-shot CPU reference changed bits — which W-1a must not do.
 *
 * RE-DERIVED 2026-08-30 by `W-4` (Gate W, register C-4), under deviation D-2's
 * sanctioned eroded bit-churn — the ONLY reason this constant may move.
 * `sampleTerrainUpliftHeight` changed twice: convergence is now the
 * Lloyd-relaxed plate model's (`sampleTerrainPlates`, replacing noise channels
 * 150/151), and the 24 m/9 m ridged bands left the uplift input for the
 * post-erosion mask. Both change the macro pass's INPUT heights, hence both
 * fingerprints:
 *
 *     inputs    1,198,027,053 -> 3,180,693,458
 *     evolution 1,087,986,321 ->   371,427,057
 *
 * What did NOT move, measured the same day on a `HEAD` worktree with the same
 * probe: the ANALYTIC surface. `sampleNaturalTerrainHeight` over a 256² near
 * grid fingerprints 1,582,588,410 and `sampleTerrainHeight` over a 64² grid at
 * (1.8e6, -2.4e6) fingerprints 698,264,980 on BOTH trees — bit-identical, as
 * the W-4 brief requires. The uplift authority and the analytic authority are
 * separate functions and only the former moved.
 */
const PRE_CHANGE_SMALL_DOMAIN_FINGERPRINTS = Object.freeze({
  seedHash: 2_728_693_428,
  seaLevel: 0,
  inputs: 3_180_693_458,
  evolution: 371_427_057,
});

function graphFixture(evolution: TerrainMacroEvolutionExport): TerrainChannelGraphExport {
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: evolution.provenance,
    nodes: [],
    edges: [],
    lakePolygons: [],
    lakes: [],
  };
}

function stage1Fixture(): TerrainMacroEvolutionStage1Fields {
  const heights = new Float32Array(DOMAIN);
  heights[0] = 321.5;
  return {
    heights,
    erodibility: new Float32Array(DOMAIN).fill(1),
    reposeDegrees: new Float32Array(DOMAIN).fill(34),
    receivers: new Int32Array(DOMAIN).fill(-1),
    flowAccumulation: new Float32Array(DOMAIN).fill(1),
    erosionMask: new Uint8Array(DOMAIN),
  };
}

function evolutionFixture(deviceFingerprint: string): TerrainMacroEvolutionExport {
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: "hybrid-orchestration", deviceFingerprint },
    seaLevelMeters: 0,
    heightMeters: new Float32Array(DOMAIN),
    flowAccumulationAreaM2: new Float32Array(DOMAIN),
    lakeMask: new Uint8Array(DOMAIN),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(),
  };
}

/**
 * `W-1e`: what stage 2 does after it completes. "none" is the pre-W-1e
 * producer (and any worker that does not extract), which leaves extraction to
 * the consumer; "graph" posts the extracted graph as a follow-up event;
 * "failure" advertises a graph and then fails, which must fall back.
 */
type FakeChannelGraphMode = "none" | "graph" | "failure";

class FakeStagedWorker implements TerrainMacroEvolutionStagedWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => unknown) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null = null;
  readonly commands: TerrainMacroEvolutionWorkerCommand[] = [];
  readonly transfers: Array<Transferable[] | undefined> = [];
  terminated = false;
  readonly stage1 = stage1Fixture();
  /** What the presampled branch actually derived, for the round-trip claims. */
  derivedStage1: TerrainMacroEvolutionStage1Fields | null = null;
  workerGraph: TerrainChannelGraphExport | null = null;

  constructor(private readonly graphMode: FakeChannelGraphMode = "none") {}

  postMessage(message: TerrainMacroEvolutionWorkerCommand, transfer?: Transferable[]): void {
    this.commands.push(message);
    this.transfers.push(transfer);
    queueMicrotask(() => {
      if (message.type === "evolve-stage1") {
        this.emit({
          type: "progress",
          requestId: message.requestId,
          phase: "sampling-uplift",
          completed: 512,
          total: 1_024,
          overallFraction: 0.225,
        });
        this.emit({
          type: "stage1",
          requestId: message.requestId,
          elapsedMilliseconds: 12,
          samplingElapsedMilliseconds: 8,
          stage1: this.stage1,
        });
      } else if (message.type === "evolve-stage1-presampled") {
        // Emulates handleStage1Presampled: no sampling progress phase, the
        // supplied fields used verbatim, and the SAME reference head the CPU
        // branch runs — so this asserts the real derivation, not a stub.
        const derived = deriveTerrainMacroEvolutionStage1Fields(
          {
            heights: message.heights,
            erodibility: message.erodibility,
            reposeDegrees: message.reposeDegrees,
          },
          {
            width: EVOLUTION_DOMAIN_TEXELS,
            height: EVOLUTION_DOMAIN_TEXELS,
            seaLevel: message.seaLevelMeters,
          },
        );
        this.derivedStage1 = derived;
        this.emit({
          type: "progress",
          requestId: message.requestId,
          phase: "evolving-landscape",
          completed: 0,
          total: 1,
          overallFraction: 0.45,
        });
        this.emit({
          type: "stage1",
          requestId: message.requestId,
          elapsedMilliseconds: 9,
          samplingElapsedMilliseconds: 0,
          stage1: derived,
        });
      } else if (message.type === "evolve-stage2") {
        const evolution = evolutionFixture(message.deviceFingerprint);
        this.emit({
          type: "complete",
          requestId: message.requestId,
          elapsedMilliseconds: 4,
          samplingElapsedMilliseconds: 0,
          evolution,
          ...(this.graphMode === "none" ? {} : { channelGraphFollows: true }),
        });
        // A macrotask, not a microtask: the graph must be able to land
        // strictly AFTER the consumer has resumed from `initialize`, which is
        // exactly the overlap W-1e buys.
        if (this.graphMode === "graph") {
          const graph = graphFixture(evolution);
          this.workerGraph = graph;
          setTimeout(() => this.emit({
            type: "channel-graph",
            requestId: message.requestId,
            elapsedMilliseconds: 7,
            graph,
          }), 0);
        } else if (this.graphMode === "failure") {
          setTimeout(() => this.emit({
            type: "error",
            requestId: message.requestId,
            message: "worker extraction failed",
          }), 0);
        }
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(event: unknown): void {
    this.onmessage?.({ data: event } as MessageEvent<unknown>);
  }
}

class FakeGpuPort implements TerrainMacroErosionGpuPort {
  readonly deviceFingerprint = "gpu-macro-v1/fake-adapter";
  received: TerrainMacroErosionGpuRunInputs | null = null;

  run(inputs: TerrainMacroErosionGpuRunInputs): Promise<TerrainMacroErosionGpuRunResult> {
    this.received = inputs;
    const evolvedHeight = new Float32Array(inputs.heights.length);
    evolvedHeight[0] = 42.5;
    return Promise.resolve({
      evolvedHeight,
      timings: {
        streamPowerMilliseconds: 1,
        talusMilliseconds: 2,
        readbackMilliseconds: 0.5,
        totalMilliseconds: 3.5,
      },
    });
  }
}

/**
 * `W-1b` wiring: the on-device macro input sampler. The height pattern is
 * deliberately mixed above/below sea level so the submarine mask the worker
 * derives is non-degenerate, and the fields are plain f32 — exactly what the
 * real sampler reads back, and what the CPU sampler's `Math.fround` stamps
 * guarantee.
 */
class FakeMacroInputsPort implements TerrainMacroInputsGpuPort {
  received: TerrainMacroInputsGpuRequest | null = null;
  calls = 0;
  readonly sample: TerrainMacroInputsGpuSample;

  constructor() {
    const heights = new Float32Array(DOMAIN);
    const erodibility = new Float32Array(DOMAIN);
    const reposeDegrees = new Float32Array(DOMAIN);
    for (let index = 0; index < DOMAIN; index += 1) {
      heights[index] = index % 3 === 0 ? -12.5 : 40 + (index % 7);
      erodibility[index] = 0.75;
      reposeDegrees[index] = 34;
    }
    this.sample = { heights, erodibility, reposeDegrees };
  }

  async sampleMacroInputs(
    request: TerrainMacroInputsGpuRequest,
  ): Promise<TerrainMacroInputsGpuSample> {
    this.received = request;
    this.calls += 1;
    // A real device leg takes measurable time; this makes the reported
    // sampling metric distinguishable from the worker's zero.
    await new Promise((resolve) => setTimeout(resolve, 2));
    return this.sample;
  }
}

describe("terrain macro hybrid staging (W-1a)", () => {
  it("keeps the untouched single-shot CPU reference bit-identical to its pre-change fingerprints", () => {
    const world = createWorld(333438, { worldEvolution: "eroded" });
    expect(world.seedHash).toBe(PRE_CHANGE_SMALL_DOMAIN_FINGERPRINTS.seedHash);
    expect(world.seaLevel).toBe(PRE_CHANGE_SMALL_DOMAIN_FINGERPRINTS.seaLevel);
    const edge = 48;
    const inputs = sampleTerrainMacroEvolutionInputs({
      seedHash: world.seedHash,
      width: edge,
      height: edge,
      minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
      minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
    });
    expect(fingerprintEvolutionFields([
      inputs.heights,
      inputs.erodibility,
      inputs.reposeDegrees,
    ])).toBe(PRE_CHANGE_SMALL_DOMAIN_FINGERPRINTS.inputs);
    const result = evolveMacroTerrain({
      width: edge,
      height: edge,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      seaLevel: world.seaLevel,
      heights: inputs.heights,
      erodibility: inputs.erodibility,
      reposeDegrees: inputs.reposeDegrees,
    });
    expect(fingerprintEvolutionFields([
      result.evolvedHeight,
      result.filledHeight,
      result.receivers,
      result.flowAccumulation,
      result.lakeDepth,
      result.lakeMask,
      result.basinIds,
      result.channelSeeds,
    ])).toBe(PRE_CHANGE_SMALL_DOMAIN_FINGERPRINTS.evolution);
  }, 120_000);

  it("round-trips the staged protocol at production shape and completes a valid export", () => {
    const world = createWorld(333438, { worldEvolution: "eroded" });
    const width = EVOLUTION_DOMAIN_TEXELS;
    const height = EVOLUTION_DOMAIN_TEXELS;
    const sampled = sampleTerrainMacroEvolutionInputs({
      seedHash: world.seedHash,
      width,
      height,
      minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
      minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
    });
    const stage1 = deriveTerrainMacroEvolutionStage1Fields(sampled, {
      width,
      height,
      seaLevel: world.seaLevel,
    });

    // Stage-1 event shape: accepted by the staged validator, and — critical
    // for the untouched client — still REJECTED by the single-shot one.
    const stage1Event = {
      type: "stage1",
      requestId: 1,
      elapsedMilliseconds: 10,
      samplingElapsedMilliseconds: 5,
      stage1,
    };
    expect(isTerrainMacroEvolutionStagedWorkerEvent(stage1Event)).toBe(true);
    expect(isTerrainMacroEvolutionWorkerEvent(stage1Event)).toBe(false);
    expect(isTerrainMacroEvolutionStagedWorkerEvent({
      ...stage1Event,
      stage1: { ...stage1, receivers: new Int32Array(4) },
    })).toBe(false);

    // Stage-1 semantics: same sampled arrays, submarine mask, live drainage.
    expect(stage1.heights).toBe(sampled.heights);
    let maskedCells = 0;
    for (let index = 0; index < stage1.erosionMask.length; index += 1) {
      const expected = sampled.heights[index]! <= world.seaLevel ? 1 : 0;
      if (stage1.erosionMask[index] !== expected) {
        expect.fail(`erosion mask mismatch at ${index}`);
      }
      maskedCells += expected;
    }
    expect(maskedCells).toBeGreaterThan(0);
    expect(maskedCells).toBeLessThan(stage1.erosionMask.length);

    // Stage 2 on a stand-in evolved surface (the raw uplift): the drainage
    // tail must produce an internally consistent export.
    const provenance = {
      worldSeed: world.seed,
      deviceFingerprint: "gpu-macro-v1/node-test",
    };
    const exported = completeTerrainMacroEvolutionFromEvolvedHeight({
      width,
      height,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      seaLevel: world.seaLevel,
      evolvedHeightMeters: stage1.heights,
      provenance,
    });
    expect(exported.provenance).toEqual(provenance);

    // Zero-iteration identity: the export's height is the supplied evolved
    // surface bit-for-bit (stream power and talus at 0 iterations are exact
    // f32 -> f64 -> f32 round trips).
    const exportBits = new Uint32Array(exported.heightMeters.buffer);
    const inputBits = new Uint32Array(stage1.heights.buffer);
    expect(exportBits.length).toBe(inputBits.length);
    for (let index = 0; index < exportBits.length; index += 1) {
      if (exportBits[index] !== inputBits[index]) {
        expect.fail(`stage-2 height diverged from the evolved input at ${index}`);
      }
    }

    // Every lake has an outlet inside the domain, on its own mask.
    expect(exported.lakes.length).toBeGreaterThan(0);
    for (const lake of exported.lakes) {
      expect(Number.isInteger(lake.outletTexel.x)).toBe(true);
      expect(Number.isInteger(lake.outletTexel.z)).toBe(true);
      expect(lake.outletTexel.x).toBeGreaterThanOrEqual(0);
      expect(lake.outletTexel.x).toBeLessThan(width);
      expect(lake.outletTexel.z).toBeGreaterThanOrEqual(0);
      expect(lake.outletTexel.z).toBeLessThan(height);
      expect(exported.lakeMask[lake.outletTexel.z * width + lake.outletTexel.x]).toBe(1);
      expect(Number.isFinite(lake.spillElevationMeters)).toBe(true);
    }

    // The graph extractor is the strictest consumer of the export's
    // topological invariants; it must accept the staged product.
    const graph = new ChannelNetwork().extract(exported);
    expect(graph.nodes.length).toBeGreaterThan(0);

    // The stage-2 completion event is the normal 'complete' event.
    expect(isTerrainMacroEvolutionWorkerEvent({
      type: "complete",
      requestId: 2,
      elapsedMilliseconds: 10,
      samplingElapsedMilliseconds: 0,
      evolution: exported,
    })).toBe(true);
  }, 300_000);

  it("orchestrates stage1 -> GPU -> stage2 through the runtime's hybrid seam", async () => {
    const worker = new FakeStagedWorker();
    const gpu = new FakeGpuPort();
    let extracted: TerrainMacroEvolutionExport | null = null;
    const runtime = new TerrainEvolutionRuntime({
      gpuMacroErosion: gpu,
      hybridWorkerFactory: () => worker,
      channelExtractor: {
        extract: (evolution) => {
          extracted = evolution;
          return graphFixture(evolution);
        },
      },
    });

    const result = await runtime.initialize({
      seed: "hybrid-orchestration",
      seedHash: 77,
      seaLevel: 0,
      worldEvolution: "eroded",
    });
    expect(result.mode).toBe("eroded");
    if (result.mode !== "eroded") throw new Error("Expected eroded result");

    // Stage 1 command carried the GPU provenance fingerprint.
    expect(worker.commands).toHaveLength(2);
    const [stage1Command, stage2Command] = worker.commands;
    expect(stage1Command?.type).toBe("evolve-stage1");
    if (stage1Command?.type !== "evolve-stage1") {
      throw new Error("Expected the CPU-sampling stage-1 command");
    }
    expect(stage1Command.deviceFingerprint).toBe("gpu-macro-v1/fake-adapter");

    // The GPU received exactly the stage-1 transferables at the macro domain.
    expect(gpu.received?.heights).toBe(worker.stage1.heights);
    expect(gpu.received?.receivers).toBe(worker.stage1.receivers);
    expect(gpu.received?.flowAccumulation).toBe(worker.stage1.flowAccumulation);
    expect(gpu.received?.erodibility).toBe(worker.stage1.erodibility);
    expect(gpu.received?.reposeDegrees).toBe(worker.stage1.reposeDegrees);
    expect(gpu.received?.erosionMask).toBe(worker.stage1.erosionMask);
    expect(gpu.received?.width).toBe(EVOLUTION_DOMAIN_TEXELS);
    expect(gpu.received?.height).toBe(EVOLUTION_DOMAIN_TEXELS);
    expect(gpu.received?.texelSizeMeters).toBe(EVOLUTION_TEXEL_METERS);

    // Stage 2 carried the GPU-evolved surface back, transferring its buffer.
    expect(stage2Command?.type).toBe("evolve-stage2");
    if (stage2Command?.type !== "evolve-stage2") throw new Error("Expected stage-2 command");
    expect(stage2Command.evolvedHeightMeters[0]).toBe(42.5);
    expect(worker.transfers[1]).toEqual([stage2Command.evolvedHeightMeters.buffer]);

    // The completed export flows through the normal runtime products with the
    // hybrid fingerprint stamped as provenance.
    expect(result.evolution.provenance.deviceFingerprint).toBe("gpu-macro-v1/fake-adapter");
    expect(extracted).toBe(result.evolution);
    expect(result.macroGrid.width).toBe(EVOLUTION_DOMAIN_TEXELS);
    expect(result.macroGrid.texelSizeMeters).toBe(EVOLUTION_TEXEL_METERS);
    expect(runtime.state).toBe("ready");
    expect(runtime.progress?.overallFraction).toBe(1);
    expect(worker.terminated).toBe(true);
    expect(runtime.publishMacroOnce({ publishTerrainMacro: () => undefined })).toBe(true);
  });

  it("W-1e: takes the worker's channel graph without extracting on this thread", async () => {
    const worker = new FakeStagedWorker("graph");
    let extractorCalls = 0;
    const runtime = new TerrainEvolutionRuntime({
      gpuMacroErosion: new FakeGpuPort(),
      hybridWorkerFactory: () => worker,
      channelExtractor: {
        extract: (evolution) => {
          extractorCalls += 1;
          return graphFixture(evolution);
        },
      },
    });

    const result = await runtime.initialize({
      seed: "hybrid-orchestration",
      seedHash: 77,
      seaLevel: 0,
      worldEvolution: "eroded",
    });
    if (result.mode !== "eroded") throw new Error("Expected eroded result");

    // The macro product resolved BEFORE the graph did: that is the whole
    // point — the consumer builds device resources while extraction runs.
    expect(runtime.state).toBe("ready");
    expect(extractorCalls).toBe(0);
    expect(worker.terminated).toBe(false);

    await expect(result.channelGraph).resolves.toBe(worker.workerGraph);
    // The producer's worker is released once the graph has landed, and the
    // consumer thread never ran the extractor.
    expect(extractorCalls).toBe(0);
    expect(worker.terminated).toBe(true);
  });

  it("W-1e: falls back to this thread's extractor when the worker graph fails", async () => {
    const worker = new FakeStagedWorker("failure");
    let extracted: TerrainMacroEvolutionExport | null = null;
    const runtime = new TerrainEvolutionRuntime({
      gpuMacroErosion: new FakeGpuPort(),
      hybridWorkerFactory: () => worker,
      channelExtractor: {
        extract: (evolution) => {
          extracted = evolution;
          return graphFixture(evolution);
        },
      },
    });

    const result = await runtime.initialize({
      seed: "hybrid-orchestration",
      seedHash: 77,
      seaLevel: 0,
      worldEvolution: "eroded",
    });
    if (result.mode !== "eroded") throw new Error("Expected eroded result");
    // A producer graph that never arrives must not strand startup: the
    // in-process extractor still yields a graph, just without the overlap.
    const graph = await result.channelGraph;
    expect(graph.contractVersion).toBe(TERRAIN_EVOLUTION_CONTRACT_VERSION);
    expect(extracted).toBe(result.evolution);
    expect(worker.terminated).toBe(true);
  });

  it("W-1e: validates the channel-graph event and keeps it off the single-shot union", () => {
    const graphEvent = {
      type: "channel-graph",
      requestId: 3,
      elapsedMilliseconds: 12,
      graph: graphFixture(evolutionFixture("gpu-macro-v1/node-test")),
    };
    expect(isTerrainMacroEvolutionStagedWorkerEvent(graphEvent)).toBe(true);
    // The untouched single-shot client must never narrow onto it.
    expect(isTerrainMacroEvolutionWorkerEvent(graphEvent)).toBe(false);
    expect(isTerrainMacroEvolutionStagedWorkerEvent({
      ...graphEvent,
      graph: { ...graphEvent.graph, nodes: undefined },
    })).toBe(false);
    expect(isTerrainMacroEvolutionStagedWorkerEvent({
      ...graphEvent,
      graph: { ...graphEvent.graph, contractVersion: 999 },
    })).toBe(false);
    // `channelGraphFollows` is an optional flag on the ordinary completion,
    // so the single-shot validator still accepts a staged completion.
    expect(isTerrainMacroEvolutionWorkerEvent({
      type: "complete",
      requestId: 3,
      elapsedMilliseconds: 4,
      samplingElapsedMilliseconds: 0,
      evolution: evolutionFixture("gpu-macro-v1/node-test"),
      channelGraphFollows: true,
    })).toBe(true);
  });

  it("W-1b: GPU-samples the macro inputs and reduces stage 1 to the flood/MFD head", async () => {
    const worker = new FakeStagedWorker("graph");
    const gpu = new FakeGpuPort();
    const inputs = new FakeMacroInputsPort();
    const progress: TerrainMacroEvolutionProgress[] = [];
    let extractorCalls = 0;
    const runtime = new TerrainEvolutionRuntime({
      gpuMacroErosion: gpu,
      gpuMacroInputs: inputs,
      hybridWorkerFactory: () => worker,
      channelExtractor: {
        extract: (evolution) => {
          extractorCalls += 1;
          return graphFixture(evolution);
        },
      },
    });

    const world = createWorld(333438, { worldEvolution: "eroded" });
    const result = await runtime.initialize(world, (entry) => progress.push(entry));
    if (result.mode !== "eroded") throw new Error("Expected eroded result");

    // The sampler was asked for exactly the production macro grid — same
    // cell-centred layout and filter width the CPU sampler uses.
    expect(inputs.calls).toBe(1);
    expect(inputs.received).toEqual({
      seedHash: world.seedHash,
      width: EVOLUTION_DOMAIN_TEXELS,
      height: EVOLUTION_DOMAIN_TEXELS,
      minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
      minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
    });

    // Stage 1 is the presampled variant, carrying the sampled fields by
    // identity and transferring exactly their three buffers.
    expect(worker.commands).toHaveLength(2);
    const [stage1Command, stage2Command] = worker.commands;
    expect(stage1Command?.type).toBe("evolve-stage1-presampled");
    if (stage1Command?.type !== "evolve-stage1-presampled") {
      throw new Error("Expected a presampled stage-1 command");
    }
    expect(stage1Command.seaLevelMeters).toBe(world.seaLevel);
    expect(stage1Command.heights).toBe(inputs.sample.heights);
    expect(stage1Command.erodibility).toBe(inputs.sample.erodibility);
    expect(stage1Command.reposeDegrees).toBe(inputs.sample.reposeDegrees);
    expect(worker.transfers[0]).toEqual([
      inputs.sample.heights.buffer,
      inputs.sample.erodibility.buffer,
      inputs.sample.reposeDegrees.buffer,
    ]);

    // The worker derived the real flood/MFD head over those fields verbatim:
    // the sampled arrays pass through untouched and the submarine mask is
    // exactly `height <= seaLevel`.
    const derived = worker.derivedStage1;
    if (!derived) throw new Error("Expected the worker to derive stage-1 fields");
    expect(derived.heights).toBe(inputs.sample.heights);
    expect(derived.erodibility).toBe(inputs.sample.erodibility);
    expect(derived.reposeDegrees).toBe(inputs.sample.reposeDegrees);
    let maskedCells = 0;
    for (let index = 0; index < derived.erosionMask.length; index += 1) {
      const expected = inputs.sample.heights[index]! <= world.seaLevel ? 1 : 0;
      if (derived.erosionMask[index] !== expected) {
        expect.fail(`erosion mask mismatch at ${index}`);
      }
      maskedCells += expected;
    }
    expect(maskedCells).toBeGreaterThan(0);
    expect(maskedCells).toBeLessThan(derived.erosionMask.length);

    // The GPU erosion leg consumes the derived head, unchanged by the switch.
    expect(gpu.received?.heights).toBe(inputs.sample.heights);
    expect(gpu.received?.receivers).toBe(derived.receivers);
    expect(gpu.received?.flowAccumulation).toBe(derived.flowAccumulation);
    expect(gpu.received?.erosionMask).toBe(derived.erosionMask);

    // The landscape is GPU-sampled, so it is a different same-device family.
    if (stage2Command?.type !== "evolve-stage2") {
      throw new Error("Expected the stage-2 command");
    }
    expect(stage2Command.deviceFingerprint).toBe("gpu-macro-v2/fake-adapter");
    expect(result.evolution.provenance.deviceFingerprint).toBe("gpu-macro-v2/fake-adapter");

    // The reported sampling metric is the DEVICE leg this client timed, not
    // the worker's zero.
    expect(result.samplingElapsedMilliseconds).toBeGreaterThan(0);
    expect(result.samplingElapsedMilliseconds).not.toBe(8);
    // The sampling phase is closed out for observers even though the worker
    // never reports one on this path.
    expect(progress.some((entry) => entry.phase === "sampling-uplift"
      && entry.completed === EVOLUTION_DOMAIN_TEXELS
      && entry.total === EVOLUTION_DOMAIN_TEXELS)).toBe(true);
    expect(progress.some((entry) => entry.phase === "evolving-landscape")).toBe(true);

    // W-1e is unaffected: the worker still posts the graph after `complete`.
    expect(runtime.state).toBe("ready");
    expect(extractorCalls).toBe(0);
    expect(worker.terminated).toBe(false);
    await expect(result.channelGraph).resolves.toBe(worker.workerGraph);
    expect(extractorCalls).toBe(0);
    expect(worker.terminated).toBe(true);
  }, 120_000);

  it("W-1b: falls back to the worker's CPU sampling when the device leg fails", async () => {
    const worker = new FakeStagedWorker();
    const failingInputs: TerrainMacroInputsGpuPort = {
      sampleMacroInputs: () => Promise.reject(new Error("macro input sampling failed")),
    };
    const runtime = new TerrainEvolutionRuntime({
      gpuMacroErosion: new FakeGpuPort(),
      gpuMacroInputs: failingInputs,
      hybridWorkerFactory: () => worker,
      channelExtractor: { extract: graphFixture },
    });

    const result = await runtime.initialize({
      seed: "hybrid-orchestration",
      seedHash: 77,
      seaLevel: 0,
      worldEvolution: "eroded",
    });
    // Fail-OPEN: sampling has a bit-equivalent twin one command away, so a
    // device failure costs latency, never the load.
    if (result.mode !== "eroded") throw new Error("Expected eroded result");
    expect(runtime.state).toBe("ready");

    const [stage1Command, stage2Command] = worker.commands;
    expect(stage1Command?.type).toBe("evolve-stage1");
    if (stage1Command?.type !== "evolve-stage1") {
      throw new Error("Expected the CPU-sampling stage-1 command");
    }
    expect(stage1Command.seedHash).toBe(77);
    // The landscape is the CPU-sampled one again, and the fingerprint says so.
    expect(stage1Command.deviceFingerprint).toBe("gpu-macro-v1/fake-adapter");
    if (stage2Command?.type !== "evolve-stage2") {
      throw new Error("Expected the stage-2 command");
    }
    expect(stage2Command.deviceFingerprint).toBe("gpu-macro-v1/fake-adapter");
    expect(result.evolution.provenance.deviceFingerprint).toBe("gpu-macro-v1/fake-adapter");
    // And the sampling metric is the worker's own again.
    expect(result.samplingElapsedMilliseconds).toBe(8);
  });

  it("W-1b: keeps the GPU-sampled landscape in its own fingerprint family", () => {
    expect(gpuSampledMacroFingerprint("gpu-macro-v1/Apple M3 Pro"))
      .toBe("gpu-macro-v2/Apple M3 Pro");
    expect(gpuSampledMacroFingerprint("gpu-macro-v1")).toBe("gpu-macro-v2");
    // The whole point: one device, two landscapes, two labels.
    expect(gpuSampledMacroFingerprint("gpu-macro-v1/Apple M3 Pro"))
      .not.toBe("gpu-macro-v1/Apple M3 Pro");
    // A label from some other producer keeps its identity behind the family.
    expect(gpuSampledMacroFingerprint("cpu-reference")).toBe("gpu-macro-v2/cpu-reference");
    // Idempotent, so a re-familied label never compounds.
    expect(gpuSampledMacroFingerprint("gpu-macro-v2/Apple M3 Pro"))
      .toBe("gpu-macro-v2/Apple M3 Pro");
    expect(gpuSampledMacroFingerprint("gpu-macro-v2")).toBe("gpu-macro-v2");
  });

  it("fails closed when the GPU leg rejects, and terminates the staged worker", async () => {
    const worker = new FakeStagedWorker();
    const failingGpu: TerrainMacroErosionGpuPort = {
      deviceFingerprint: "gpu-macro-v1/fake-adapter",
      run: () => Promise.reject(new Error("device lost")),
    };
    const runtime = new TerrainEvolutionRuntime({
      gpuMacroErosion: failingGpu,
      hybridWorkerFactory: () => worker,
      channelExtractor: { extract: graphFixture },
    });
    await expect(runtime.initialize({
      seed: "hybrid-orchestration",
      seedHash: 77,
      seaLevel: 0,
      worldEvolution: "eroded",
    })).rejects.toThrow("device lost");
    expect(runtime.state).toBe("failed");
    expect(worker.terminated).toBe(true);
  });
});
