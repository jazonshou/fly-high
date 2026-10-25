/// <reference lib="webworker" />

import {
  generateHydrology,
  resolveHydrologyConfig,
} from "@/src/render/webgpu/water/HydrologyGeneration";
import { createWorld, sampleTerrain, type TerrainSample, type WorldDefinition } from "@/src/world";
import type { HydrologyWorkerCommand, HydrologyWorkerEvent } from "./hydrologyProtocol";
import { hydrologyClimateSamplerFor } from "@/src/render/webgpu/water/hydrologyClimate";
import { volcanicHydrologyInputs } from "@/src/render/webgpu/water/hydrologyVolcanism";
import {
  buildAnalyticRegionMeshArrays,
  packedRegionGeometryTransferables,
  packHydrologyMeshArrays,
  type PackedHydrologyRegionGeometry,
} from "@/src/render/webgpu/water/hydrologyMeshArrays";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let world: WorldDefinition | null = null;
const sampleTarget: TerrainSample = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  slope: 0,
  moisture: 0,
  temperature: 0,
  temperatureOffset: 0,
  dryness: 0,
  sandCover: 0,
  ergWeight: 0,
  biome: 0,
  biomeName: "water",
  color: { r: 0, g: 0, b: 0 },
  airportInfluence: 0,
  isRunway: false,
};

function post(event: HydrologyWorkerEvent, transfer: Transferable[] = []): void {
  workerScope.postMessage(event, transfer);
}

workerScope.addEventListener("message", (event: MessageEvent<HydrologyWorkerCommand>) => {
  const command = event.data;
  if (command.type === "initialize") {
    world = createWorld(command.worldSeed, {
      ...(command.climateProvince ? { climateProvince: command.climateProvince } : {}),
      ...(command.landforms ? { landforms: command.landforms } : {}),
    });
    return;
  }
  const startedAt = performance.now();
  try {
    if (!world) throw new Error("Hydrology worker has not been initialized");
    const hydrology = generateHydrology({
      ...command.options,
      // Crater lakes and porous ground, from this worker's own world: data
      // and a predicate, so nothing new crosses the worker boundary.
      ...volcanicHydrologyInputs(world, resolveHydrologyConfig(command.options)),
      worldSeed: world.seed,
      terrainSample: (x, z) => {
        const sample = sampleTerrain(world as WorldDefinition, x, z, sampleTarget);
        return { height: sample.height, moisture: sample.moisture, ergWeight: sample.ergWeight };
      },
    });
    // P2b: the region's vertex arrays, built here and transferred, so the
    // main thread only uploads meshes. The same builders, ground and climate
    // the renderer's main-thread path uses (worker parity test).
    let geometry: PackedHydrologyRegionGeometry | undefined;
    if (command.buildGeometry) {
      const activeWorld = world;
      const arrays = buildAnalyticRegionMeshArrays(
        hydrology,
        (x, z) => sampleTerrain(activeWorld, x, z, sampleTarget).height,
        hydrologyClimateSamplerFor(activeWorld),
        hydrology.config.seaLevel,
      );
      geometry = {
        rivers: packHydrologyMeshArrays(arrays.rivers),
        lakes: packHydrologyMeshArrays(arrays.lakes),
      };
    }
    post({
      type: "region",
      requestId: command.requestId,
      generation: command.generation,
      key: command.key,
      // Generation and, when asked, geometry: all of the worker's time.
      elapsedMilliseconds: performance.now() - startedAt,
      hydrology,
      ...(geometry ? { geometry } : {}),
    }, geometry ? packedRegionGeometryTransferables(geometry) : []);
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
