/// <reference lib="webworker" />

import { generateDetailCell } from "@/src/render/webgpu/detail/generation";
import {
  TerrainConsumerAuthority,
  terrainConsumerSampleFromAuthority,
  type TerrainConsumerSample,
} from "@/src/render/webgpu/terrain/TerrainConsumerAuthority";
import { createWorld, sampleTerrain, type WorldDefinition } from "@/src/world";
import type { DetailWorkerCommand, DetailWorkerEvent } from "./detailProtocol";

/**
 * Off-main-thread detail cell generation (1B-10). Detail-cell generation ran
 * inline in WorldDetailRuntime.update() at a measured multi-millisecond cost
 * per 512 m cell — the single largest contributor to the CPU p95 that drove
 * the deleted resolution ratchet. generateDetailCell is a pure, deterministic
 * function of (seed, cell address, density), so the worker rebuilds the same
 * world from the seed — the pattern the hydrology worker set — and streams
 * cells back.
 */

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let world: WorldDefinition | null = null;
let terrainSample: TerrainConsumerSample | null = null;
let cellSizeMeters = 512;
let seaLevelMeters = 0;
const terrainAuthority = new TerrainConsumerAuthority();

function post(event: DetailWorkerEvent): void {
  workerScope.postMessage(event);
}

workerScope.addEventListener("message", (event: MessageEvent<DetailWorkerCommand>) => {
  const command = event.data;
  if (command.type === "initialize") {
    terrainAuthority.clear();
    world = command.world ?? createWorld(command.worldSeed);
    const activeWorld = world;
    terrainSample = terrainConsumerSampleFromAuthority(
      activeWorld,
      (x, z) => sampleTerrain(activeWorld, x, z),
      terrainAuthority,
    );
    cellSizeMeters = command.cellSizeMeters;
    seaLevelMeters = command.seaLevelMeters;
    return;
  }
  if (command.type === "terrainMacro") {
    terrainAuthority.publishMacro(command.macro);
    return;
  }
  if (command.type === "terrainPage") {
    terrainAuthority.publish(command.page);
    return;
  }
  if (command.type === "terrainAux") {
    terrainAuthority.publishAuxPage(command.page);
    return;
  }

  try {
    if (!world || !terrainSample) throw new Error("Detail worker has not been initialized");
    const activeWorld = world;
    const cell = generateDetailCell({
      worldSeed: activeWorld.seed,
      cellX: command.cellX,
      cellZ: command.cellZ,
      cellSizeMeters,
      densityMultiplier: command.densityMultiplier,
      terrainSample,
      seaLevelMeters,
      dayOfYear: command.dayOfYear,
      // 2-13a: the worker rebuilt the world from the seed, so the seasonal
      // kernel's latitude comes from it directly — no protocol change.
      latitudeDegrees: activeWorld.latitudeDegrees,
    });
    post({
      type: "cell",
      requestId: command.requestId,
      generation: command.generation,
      key: command.key,
      cell,
    });
  } catch (error) {
    post({
      type: "error",
      requestId: command.requestId,
      generation: command.generation,
      key: command.key,
      message: error instanceof Error ? error.message : "Detail generation failed",
    });
  }
});
