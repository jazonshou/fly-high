import type { WorldDefinition } from "@/src/world";
import { sampleClimateProvince } from "@/src/world/climateProvince";
import {
  sampleTerrainClimate,
  sampleTerrainMoisture,
  terrainTemperatureFromClimate,
} from "@/src/world/terrain";
import type { HydrologyClimateSampler } from "./hydrologyMeshArrays";

/**
 * `W-8`: the climate at an inland water surface, which is what its chemistry
 * is made of. A pure function of world position and elevation, so two pages
 * sharing a river derive the same colour.
 *
 * One definition for BOTH builders of a region's water geometry: the renderer
 * (main-thread fallback) and the hydrology worker (P2b), which must produce
 * the same arrays from the same world. Class P: no Babylon, no DOM.
 */
export function hydrologyClimateSamplerFor(world: WorldDefinition): HydrologyClimateSampler {
  return (x, z, elevation) => {
    // Climate provinces: the temperature carries the province's offset, and
    // the raw offset rides along for the cold biomes' chemistry. Both are
    // exactly the temperate values in the core (`+ 0`).
    const province = sampleClimateProvince(world, x, z);
    return {
      temperature: terrainTemperatureFromClimate(
        world,
        sampleTerrainClimate(world, x, z),
        elevation,
        province.temperatureOffset,
      ),
      // Point-sampled: a lake or a station is a point, not a footprint.
      moisture: sampleTerrainMoisture(world, x, z, 0),
      temperatureOffset: province.temperatureOffset,
    };
  };
}
