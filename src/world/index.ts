export {
  DEFAULT_AIRPORT,
  getAirportInfluence,
  getRunwayEndpoints,
  getWorldAirport,
  isPointOnRunway,
  roundedRectangleSignedDistance,
  runwayToWorld,
  worldToRunway,
} from "./airport";
export {
  assessAirportSite,
  DETAILED_PRIMARY_COUNT,
  findGeneratedAirportSite,
  HEADINGS_PER_DETAILED_CANDIDATE,
  readAirportSiteEvaluationCount,
  resetAirportSiteEvaluationCount,
  resolveGuaranteedAirportRegion,
} from "./airportSite";
export type {
  AirportFootprint,
  AirportSiteAssessment,
  GeneratedAirportSite,
  ResolvedAirportRegion,
} from "./airportSite";
export { hashCoordinates, hashSeed, mixSeed, normalizeSeed, unitFloatFromHash } from "./seed";
export {
  MAX_TERRAIN_HEIGHT,
  MIN_TERRAIN_HEIGHT,
  TERRAIN_NORMAL_SAMPLE_DISTANCE,
  sampleNaturalTerrainHeight,
  sampleTerrainEvolutionGeology,
  sampleTerrainFineBandRelief,
  sampleTerrainUpliftHeight,
  TERRAIN_FINE_BAND_24M_AMPLITUDE_METERS,
  TERRAIN_FINE_BAND_9M_AMPLITUDE_METERS,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  sampleTerrain,
  sampleFilteredTerrainHeight,
  sampleFilteredTerrainUpliftHeight,
  sampleTerrainHeight,
  sampleTerrainMoisture,
  sampleTerrainNormal,
  sampleTerrainTemperature,
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS,
  seasonalHumidityMultiplier,
  seasonalSnowlineDescentMeters,
  seasonalTemperatureOffsetK,
  seasonalTemperatureShift,
  seasonalWinterFraction,
} from "./terrain";
export type { TerrainEvolutionGeologySample } from "./terrain";
// 4-9: `src/world/tile.ts` is deleted. `generateTerrainTile` lost its last
// production consumer at `4-4` when the CPU terrain worker went, and a render
// path nothing renders is exactly what the §1.3 invariant test would have kept
// passing against — so it goes with the test's old form, in one commit.
export { TERRAIN_BIOME_NAMES, TerrainBiome } from "./types";
export type {
  AirportDefinition,
  RunwayCoordinates,
  RunwayPoint,
  TerrainBiomeId,
  TerrainBiomeName,
  TerrainCollisionSample,
  TerrainColor,
  TerrainSample,
  TerrainTileBuffers,
  TerrainTileData,
  TerrainTileOptions,
  WindSample,
  WorldDefinition,
  WorldEvolution,
  WorldOptions,
  WorldSeed,
  WorldVector3,
} from "./types";
export { MAX_WIND_SPEED, sampleWind } from "./wind";
export {
  createEnvironmentClock,
  DAYS_PER_YEAR,
  dayLengthHours,
  HOURS_PER_DAY,
  isEnvironmentClock,
  solarDeclinationRadians,
  wrapEnvironmentClock,
  type EnvironmentClock,
} from "./environmentClock";
export {
  DEFAULT_WORLD_EVOLUTION,
  DEFAULT_WORLD_LATITUDE_DEGREES,
  DEFAULT_WORLD_SEED,
  createWorld,
} from "./world";
