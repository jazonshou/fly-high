export { generateWildlifeCell, selectActiveWildlife, wildlifeCellKey } from "./generation";
export { SpatialHash3D, type SpatialHashQuery } from "./SpatialHash";
export {
  FixedStepClock,
  WildlifeSimulation,
  assignWildlifeLod,
  createWildlifeAgent,
  type FixedStepAdvanceResult,
  type WildlifeSimulationContext,
  type WildlifeSimulationStepStatistics,
} from "./simulation";
export { WildlifeSystem } from "./WildlifeSystem";
export type {
  BirdAgent,
  BirdSpawn,
  BirdSpecies,
  GeneratedWildlifeCell,
  GroundAnimalAgent,
  GroundAnimalSpawn,
  GroundAnimalSpecies,
  WildlifeAgent,
  WildlifeCellGenerationOptions,
  WildlifeFloatingOrigin,
  WildlifeLod,
  WildlifeObserver,
  WildlifeSpawn,
  WildlifeSpecies,
  WildlifeStatistics,
  WildlifeSystemOptions,
  WildlifeTerrainSample,
  WildlifeTerrainSampler,
  WildlifeVector3,
} from "./types";

