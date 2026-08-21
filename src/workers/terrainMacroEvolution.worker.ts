/// <reference lib="webworker" />

import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import { TerrainMacroEvolution } from "@/src/render/webgpu/terrain/TerrainMacroEvolution";
import type {
  TerrainMacroEvolutionWorkerCommand,
  TerrainMacroEvolutionWorkerEvent,
} from "./terrainMacroEvolutionProtocol";
import { sampleTerrainMacroEvolutionInputs } from "./terrainMacroEvolutionRuntime";

/**
 * Production macro evolution orchestration (`5-3`).
 *
 * The execution plan specifies a GPU multigrid pass. The current renderer has
 * no worker-owned WebGPU device or macro compute pipeline, so this integration
 * deliberately runs the deterministic CPU oracle in a dedicated Worker. It
 * preserves non-blocking startup, Class-K content and the canonical transfer
 * contract, but it does NOT claim the plan's 1.5 s GPU cost target. Replacing
 * this worker body with the measured GPU pass must leave the protocol intact.
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function post(event: TerrainMacroEvolutionWorkerEvent, transfer: Transferable[] = []): void {
  workerScope.postMessage(event, transfer);
}

workerScope.addEventListener(
  "message",
  (message: MessageEvent<TerrainMacroEvolutionWorkerCommand>) => {
    const command = message.data;
    if (command.type !== "initialize") return;
    const startedAt = performance.now();
    try {
      const samplingStartedAt = performance.now();
      const inputs = sampleTerrainMacroEvolutionInputs(
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
      post({
        type: "error",
        requestId: command.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
