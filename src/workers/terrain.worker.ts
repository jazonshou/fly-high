/// <reference lib="webworker" />

import {
  generateTerrainTile,
  getTerrainTileTransferables,
  type WorldDefinition,
} from "@/src/world";
import type { TerrainWorkerCommand, TerrainWorkerEvent } from "./terrainProtocol";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let world: WorldDefinition | null = null;

function post(event: TerrainWorkerEvent, transferables: Transferable[] = []): void {
  workerScope.postMessage(event, transferables);
}

workerScope.addEventListener("message", (event: MessageEvent<TerrainWorkerCommand>) => {
  const command = event.data;
  if (command.type === "initialize") {
    // Airport resolution belongs to the main thread. The worker receives the
    // exact resolved terrain hash and airport instead of repeating that work.
    world = command.world;
    return;
  }

  try {
    if (!world) throw new Error("Terrain worker has not been initialized");
    const tile = generateTerrainTile(world, command.options);
    post(
      {
        type: "tile",
        requestId: command.requestId,
        generation: command.generation,
        key: command.key,
        tile,
      },
      getTerrainTileTransferables(tile),
    );
  } catch (error) {
    post({
      type: "error",
      requestId: command.requestId,
      generation: command.generation,
      key: command.key,
      message: error instanceof Error ? error.message : "Terrain generation failed",
    });
  }
});
