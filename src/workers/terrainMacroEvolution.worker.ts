/// <reference lib="webworker" />

import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import { TerrainMacroEvolution } from "@/src/render/webgpu/terrain/TerrainMacroEvolution";
import { ChannelNetwork } from "@/src/render/webgpu/water/ChannelNetwork";
import type {
  TerrainMacroEvolutionInitializeCommand,
  TerrainMacroEvolutionStage1Command,
  TerrainMacroEvolutionStage1PresampledCommand,
  TerrainMacroEvolutionStage2Command,
  TerrainMacroEvolutionStage1Fields,
  TerrainMacroEvolutionStagedWorkerEvent,
  TerrainMacroEvolutionWorkerCommand,
} from "./terrainMacroEvolutionProtocol";
import {
  completeTerrainMacroEvolutionFromEvolvedHeight,
  deriveTerrainMacroEvolutionStage1Fields,
  sampleTerrainMacroEvolutionInputs,
  type TerrainMacroEvolutionInputs,
} from "./terrainMacroEvolutionRuntime";

/**
 * Production macro evolution orchestration (`5-3`, staged for Gate W's `W-1a`).
 *
 * The execution plan specifies a GPU multigrid pass. The current renderer has
 * no worker-owned WebGPU device or macro compute pipeline, so this integration
 * deliberately runs the deterministic CPU oracle in a dedicated Worker. It
 * preserves non-blocking startup, Class-K content and the canonical transfer
 * contract.
 *
 * Two execution shapes share this worker:
 * - `initialize` — the untouched single-shot CPU reference, still the bit
 *   oracle and the fallback when no GPU is available.
 * - `evolve-stage1-presampled` — the same hybrid split with the ~1.0 s macro
 *   input sampling ALSO moved to the GPU (`W-1b` wiring): the producer hands
 *   the three sampled fields in and the worker runs only the sequential
 *   flood/MFD head it cannot parallelise.
 * - `evolve-stage1` / `evolve-stage2` — the hybrid split: the worker runs the
 *   sequential head (sampling, flood, MFD) and the drainage tail, while the
 *   embarrassingly parallel stream-power/talus middle runs on the main
 *   thread's GPU between the two commands. `W-1e` also gives stage 2 the
 *   channel-graph extraction, posted as a second event after `complete` so it
 *   overlaps the consumer's device-resource construction rather than blocking
 *   the main thread. The single-shot path keeps the consumer-side extractor.
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function post(event: TerrainMacroEvolutionStagedWorkerEvent, transfer: Transferable[] = []): void {
  workerScope.postMessage(event, transfer);
}

function postError(requestId: number, error: unknown): void {
  post({
    type: "error",
    requestId,
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Shared sampling leg; progress is weighted 0..0.45 of the whole job. */
function sampleProductionInputs(
  command: TerrainMacroEvolutionInitializeCommand | TerrainMacroEvolutionStage1Command,
): TerrainMacroEvolutionInputs {
  return sampleTerrainMacroEvolutionInputs(
    {
      seedHash: command.seedHash,
      width: EVOLUTION_DOMAIN_TEXELS,
      height: EVOLUTION_DOMAIN_TEXELS,
      minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
      minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
    },
    (completed, total) => post({
      type: "progress",
      requestId: command.requestId,
      phase: "sampling-uplift",
      completed,
      total,
      overallFraction: completed / total * 0.45,
    }),
  );
}

function handleInitialize(command: TerrainMacroEvolutionInitializeCommand): void {
  const startedAt = performance.now();
  try {
    const samplingStartedAt = performance.now();
    const inputs = sampleProductionInputs(command);
    const samplingElapsedMilliseconds = performance.now() - samplingStartedAt;
    post({
      type: "progress",
      requestId: command.requestId,
      phase: "evolving-landscape",
      completed: 0,
      total: 1,
      overallFraction: 0.45,
    });
    const evolution = new TerrainMacroEvolution().evolveExport(
      {
        width: EVOLUTION_DOMAIN_TEXELS,
        height: EVOLUTION_DOMAIN_TEXELS,
        texelSizeMeters: EVOLUTION_TEXEL_METERS,
        seaLevel: command.seaLevelMeters,
        heights: inputs.heights,
        erodibility: inputs.erodibility,
        reposeDegrees: inputs.reposeDegrees,
      },
      {
        worldSeed: command.worldSeed,
        deviceFingerprint: command.deviceFingerprint,
      },
    );
    post({
      type: "complete",
      requestId: command.requestId,
      elapsedMilliseconds: performance.now() - startedAt,
      samplingElapsedMilliseconds,
      evolution,
    }, [
      evolution.heightMeters.buffer as ArrayBuffer,
      evolution.flowAccumulationAreaM2.buffer as ArrayBuffer,
      evolution.lakeMask.buffer as ArrayBuffer,
      evolution.channelSeedTexelIndices.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    postError(command.requestId, error);
  }
}

/**
 * The drainage head both stage-1 shapes share: flood + MFD + submarine mask,
 * posted with every field transferred out to the GPU erosion leg.
 */
function postStage1(
  requestId: number,
  startedAt: number,
  samplingElapsedMilliseconds: number,
  inputs: TerrainMacroEvolutionInputs,
  seaLevelMeters: number,
): void {
  post({
    type: "progress",
    requestId,
    phase: "evolving-landscape",
    completed: 0,
    total: 1,
    overallFraction: 0.45,
  });
  const stage1: TerrainMacroEvolutionStage1Fields = deriveTerrainMacroEvolutionStage1Fields(
    inputs,
    {
      width: EVOLUTION_DOMAIN_TEXELS,
      height: EVOLUTION_DOMAIN_TEXELS,
      seaLevel: seaLevelMeters,
    },
  );
  post({
    type: "stage1",
    requestId,
    elapsedMilliseconds: performance.now() - startedAt,
    samplingElapsedMilliseconds,
    stage1,
  }, [
    stage1.heights.buffer as ArrayBuffer,
    stage1.erodibility.buffer as ArrayBuffer,
    stage1.reposeDegrees.buffer as ArrayBuffer,
    stage1.receivers.buffer as ArrayBuffer,
    stage1.flowAccumulation.buffer as ArrayBuffer,
    stage1.erosionMask.buffer as ArrayBuffer,
  ]);
}

function handleStage1(command: TerrainMacroEvolutionStage1Command): void {
  const startedAt = performance.now();
  try {
    const samplingStartedAt = performance.now();
    const inputs = sampleProductionInputs(command);
    postStage1(
      command.requestId,
      startedAt,
      performance.now() - samplingStartedAt,
      inputs,
      command.seaLevelMeters,
    );
  } catch (error) {
    postError(command.requestId, error);
  }
}

/**
 * Stage 1 over GPU-sampled inputs: the ~1.0 s CPU sampling leg is gone and
 * only the sequential flood/MFD head remains. The supplied arrays are used
 * VERBATIM — they are already f32 (they arrived as Float32Arrays), which is
 * precisely the invariant `sampleTerrainMacroEvolutionInputs` establishes
 * with its per-cell `Math.fround`, so no restamping is needed or wanted.
 * `samplingElapsedMilliseconds` is 0 here: the sampling happened on the
 * producer's thread, and the hybrid client reports its own measurement.
 */
function handleStage1Presampled(command: TerrainMacroEvolutionStage1PresampledCommand): void {
  const startedAt = performance.now();
  try {
    for (const [label, field] of [
      ["heights", command.heights],
      ["erodibility", command.erodibility],
      ["reposeDegrees", command.reposeDegrees],
    ] as const) {
      if (!(field instanceof Float32Array) || field.length !== EVOLUTION_DOMAIN_SAMPLE_COUNT) {
        throw new RangeError(
          `Presampled macro ${label} must be ${EVOLUTION_DOMAIN_SAMPLE_COUNT} f32 values`,
        );
      }
    }
    postStage1(
      command.requestId,
      startedAt,
      0,
      {
        heights: command.heights,
        erodibility: command.erodibility,
        reposeDegrees: command.reposeDegrees,
      },
      command.seaLevelMeters,
    );
  } catch (error) {
    postError(command.requestId, error);
  }
}

function handleStage2(command: TerrainMacroEvolutionStage2Command): void {
  const startedAt = performance.now();
  try {
    const evolution = completeTerrainMacroEvolutionFromEvolvedHeight({
      width: EVOLUTION_DOMAIN_TEXELS,
      height: EVOLUTION_DOMAIN_TEXELS,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      seaLevel: command.seaLevelMeters,
      evolvedHeightMeters: command.evolvedHeightMeters,
      provenance: {
        worldSeed: command.worldSeed,
        deviceFingerprint: command.deviceFingerprint,
      },
    });
    // W-1e: the staged tail also extracts the channel graph, and `complete`
    // goes out FIRST so the consumer can build device resources while the
    // extractor runs here instead of blocking its main thread. The macro
    // fields are therefore COPIED rather than transferred — transferring
    // would detach the very arrays the extractor is about to read, and the
    // structured-clone copy of the four fields costs ~25 ms against the
    // ~250 ms of main-thread extraction it moves off the critical path.
    post({
      type: "complete",
      requestId: command.requestId,
      elapsedMilliseconds: performance.now() - startedAt,
      samplingElapsedMilliseconds: 0,
      evolution,
      channelGraphFollows: true,
    });
    const graphStartedAt = performance.now();
    const network = new ChannelNetwork();
    // The default production layout — byte-identical to the graph the
    // consumer's own `ChannelNetwork` fallback would extract.
    const serialized = network.serializeForWorker(network.extract(evolution));
    post({
      type: "channel-graph",
      requestId: command.requestId,
      elapsedMilliseconds: performance.now() - graphStartedAt,
      graph: serialized.graph,
    }, [...serialized.transferables]);
  } catch (error) {
    // Reaching here after `complete` means extraction failed; the consumer
    // reads a post-completion error as "no worker graph" and falls back to
    // extracting on its own thread, so a graph failure never strands startup.
    postError(command.requestId, error);
  }
}

workerScope.addEventListener(
  "message",
  (message: MessageEvent<TerrainMacroEvolutionWorkerCommand>) => {
    const command = message.data;
    if (command.type === "initialize") handleInitialize(command);
    else if (command.type === "evolve-stage1") handleStage1(command);
    else if (command.type === "evolve-stage1-presampled") handleStage1Presampled(command);
    else if (command.type === "evolve-stage2") handleStage2(command);
  },
);
