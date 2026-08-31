/// <reference lib="webworker" />

import {
  finishTerrainErodedPageStage,
  generateTerrainErodedPage,
  prepareTerrainErosionSeedInputsStage,
  runTerrainErosionMfdStage,
} from "@/src/render/webgpu/terrain/TerrainPageErosion";
import {
  buildTerrainMacroLakeField,
  type TerrainMacroLakeField,
} from "@/src/render/webgpu/terrain/TerrainPageHydrology";
import type { TerrainMacroEvolutionExport } from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import type { WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import type { WorldDefinition } from "@/src/world";
import {
  terrainErosionWorkerTransferables,
  type TerrainErosionWorkerCommand,
  type TerrainErosionWorkerEvent,
} from "./terrainErosionProtocol";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let world: Readonly<WorldDefinition> | null = null;
let macro: Readonly<TerrainMacroEvolutionExport> | null = null;
let macroLakes: TerrainMacroLakeField | null = null;

/**
 * `W-1d` staged-DAG state retained between the MFD and FINISH stages of ONE
 * in-flight GPU page. The producer keeps one page in flight, so this map holds
 * at most one live entry; the cap exists to fail loudly on a leak rather than
 * accumulate multi-megabyte scratch invisibly.
 */
interface RetainedMfdStage {
  readonly address: WorldPageAddress;
  readonly sourceHeight: Float32Array;
  readonly breachedHeight: Float32Array;
  readonly receivers: Int32Array;
  readonly flowAccumulation: Float32Array;
  readonly erosionMask: Uint8Array;
}
const retainedStages = new Map<number, RetainedMfdStage>();
const RETAINED_STAGE_CAP = 4;

function post(event: TerrainErosionWorkerEvent): void {
  workerScope.postMessage(event, terrainErosionWorkerTransferables(event));
}

workerScope.addEventListener("message", (event: MessageEvent<TerrainErosionWorkerCommand>) => {
  const command = event.data;
  if (command.type === "initialize") {
    world = command.world;
    return;
  }
  if (command.type === "set-macro-evolution") {
    macro = command.macro;
    macroLakes = command.macro ? buildTerrainMacroLakeField(command.macro) : null;
    return;
  }
  if (command.type === "erode-cancel") {
    retainedStages.delete(command.requestId);
    return;
  }
  try {
    if (!world) throw new Error("Terrain erosion worker has not been initialized");
    if (command.type === "erode-stage-seed-inputs") {
      const stage = prepareTerrainErosionSeedInputsStage(
        world,
        macro,
        command.address,
        command.seedMode,
      );
      post({
        type: "stage-seed-inputs",
        requestId: command.requestId,
        erosionMask: stage.erosionMask,
        macroHeight: stage.macroHeight,
        macroFlow: stage.macroFlow,
      });
      return;
    }
    if (command.type === "erode-stage-mfd") {
      if (retainedStages.size >= RETAINED_STAGE_CAP) {
        throw new Error("Terrain erosion staged state leaked past its cap");
      }
      const stage = runTerrainErosionMfdStage(world, command);
      retainedStages.set(command.requestId, {
        address: command.address,
        sourceHeight: command.sourceHeight,
        breachedHeight: stage.breachedHeight,
        receivers: stage.receivers,
        flowAccumulation: command.flowAccumulation,
        erosionMask: command.erosionMask,
      });
      // The receiver topology crosses back as a COPY: the retained original
      // must survive for the FINISH stage after this buffer is transferred.
      post({
        type: "stage-mfd",
        requestId: command.requestId,
        receivers: Int32Array.from(stage.receivers),
      });
      return;
    }
    if (command.type === "erode-stage-finish") {
      const retained = retainedStages.get(command.requestId);
      if (!retained) {
        throw new Error("Terrain erosion finish stage has no retained MFD state");
      }
      retainedStages.delete(command.requestId);
      const page = finishTerrainErodedPageStage({
        address: retained.address,
        sourceHeight: retained.sourceHeight,
        breachedHeight: retained.breachedHeight,
        receivers: retained.receivers,
        flowAccumulation: retained.flowAccumulation,
        erosionMask: retained.erosionMask,
        evolvedHeight: command.evolvedHeight,
        macroLakes,
      });
      post({ type: "page", requestId: command.requestId, page });
      return;
    }
    if (!macro) throw new Error("Terrain erosion worker has no macro evolution authority");
    if (!macroLakes) throw new Error("Terrain erosion worker has no macro lake authority");
    post({
      type: "page",
      requestId: command.requestId,
      page: generateTerrainErodedPage(world, macro, command.address, macroLakes),
    });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      requestId: command.requestId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies TerrainErosionWorkerEvent);
  }
});
