/// <reference lib="webworker" />

import { generateTerrainErodedPage } from "@/src/render/webgpu/terrain/TerrainPageErosion";
import {
  buildTerrainMacroLakeField,
  type TerrainMacroLakeField,
} from "@/src/render/webgpu/terrain/TerrainPageHydrology";
import type { TerrainMacroEvolutionExport } from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
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
  try {
    if (!world) throw new Error("Terrain erosion worker has not been initialized");
    if (!macro) throw new Error("Terrain erosion worker has no macro evolution authority");
    if (!macroLakes) throw new Error("Terrain erosion worker has no macro lake authority");
    const result: TerrainErosionWorkerEvent = {
      type: "page",
      requestId: command.requestId,
      page: generateTerrainErodedPage(world, macro, command.address, macroLakes),
    };
    workerScope.postMessage(result, terrainErosionWorkerTransferables(result));
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      requestId: command.requestId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies TerrainErosionWorkerEvent);
  }
});
