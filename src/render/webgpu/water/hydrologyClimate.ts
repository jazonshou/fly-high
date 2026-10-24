import type { WorldDefinition } from "@/src/world";
import {
  sampleClimateProvince,
  type ClimateProvinceSample,
} from "@/src/world/climateProvince";
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
  // One scratch per sampler: region builds call this per water vertex.
  const province: ClimateProvinceSample = { temperatureOffset: 0, dryness: 0 };
  return (x, z, elevation) => {
    // Climate provinces, sampled once: the temperature carries the offset and
    // the moisture the dryness, and the raw offsets ride along for the water
    // chemistry (peat-stained taiga, clear tundra, muddy dry-country rivers).
    // All are exactly the temperate values in the core (`+ 0`).
    sampleClimateProvince(world, x, z, province);
    return {
      temperature: terrainTemperatureFromClimate(
        world,
        sampleTerrainClimate(world, x, z),
        elevation,
        province.temperatureOffset,
      ),
      // Point-sampled: a lake or a station is a point, not a footprint.
      moisture: sampleTerrainMoisture(world, x, z, 0, province.dryness),
      temperatureOffset: province.temperatureOffset,
      dryness: province.dryness,
    };
  };
}
