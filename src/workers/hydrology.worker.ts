/// <reference lib="webworker" />

import { generateHydrology } from "@/src/render/webgpu/water/HydrologyGeneration";
import { createWorld, sampleTerrain, type TerrainSample, type WorldDefinition } from "@/src/world";
import type { HydrologyWorkerCommand, HydrologyWorkerEvent } from "./hydrologyProtocol";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let world: WorldDefinition | null = null;
const sampleTarget: TerrainSample = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  slope: 0,
  moisture: 0,
  temperature: 0,
  biome: 0,
  biomeName: "water",
  color: { r: 0, g: 0, b: 0 },
  airportInfluence: 0,
  isRunway: false,
};

function post(event: HydrologyWorkerEvent): void {
  workerScope.postMessage(event);
}

workerScope.addEventListener("message", (event: MessageEvent<HydrologyWorkerCommand>) => {
  const command = event.data;
  if (command.type === "initialize") {
    world = createWorld(command.worldSeed);
    return;
  }
  const startedAt = performance.now();
  try {
    if (!world) throw new Error("Hydrology worker has not been initialized");
    const hydrology = generateHydrology({
      ...command.options,
      worldSeed: world.seed,
      terrainSample: (x, z) => {
        const sample = sampleTerrain(world as WorldDefinition, x, z, sampleTarget);
        return { height: sample.height, moisture: sample.moisture };
      },
    });
    post({
      type: "region",
      requestId: command.requestId,
      generation: command.generation,
      key: command.key,
      elapsedMilliseconds: performance.now() - startedAt,
      hydrology,
    });
  } catch (error) {
    post({
      type: "error",
      requestId: command.requestId,
      generation: command.generation,
      key: command.key,
      message: error instanceof Error ? error.message : "Hydrology generation failed",
    });
  }
});
