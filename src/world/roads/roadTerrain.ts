import { worldToRunway } from "../airport";
import { terrainSnowlineThermalHeight, sampleClimateProvince } from "../climateProvince";
import { sampleLandformCover } from "../landforms";
import { sampleTerrainHeightBeforeEarthworks } from "../terrain";
import type { WorldDefinition } from "../types";
import { createVolcanicGroundSample, sampleVolcanicGround } from "../volcanism";
import { roadLakeWallAt } from "./roadLakes";

/**
 * What the road generator reads of the world: the ground BEFORE every
 * earthwork (`sampleTerrainHeightBeforeEarthworks`, the height infrastructure
 * sources must lay themselves out on, so a road never feeds back into where
 * roads go), and what that ground is made of.
 *
 * Only the home airport counts: a spawned airport depends on where the
 * aircraft flew, and the network must not, so spawned fields keep clear of
 * roads instead (`roadsVetoAirport`).
 */

/** What a road may not, or would rather not, be built on. */
export const RoadGround = Object.freeze({
  /** Ordinary dry land. */
  land: 0,
  /** Below or at the sea's edge, or on a lake or its shore margin (`roadLakes.ts`): never. */
  water: 1,
  /** The home airport's platform and the inner part of its blend: never (the access road is laid out by hand there). */
  airport: 2,
  /** Sand sea (dune bodies and loose sand). */
  sand: 3,
  /** Fresh lava or bare tephra. */
  lava: 4,
  /** Above the snowline. */
  snow: 5,
} as const);

export type RoadGroundId = (typeof RoadGround)[keyof typeof RoadGround];

/** Ground this little above the sea counts as water: a road keeps out of the wave-washed edge. */
export const ROAD_SHORE_CLEARANCE_METERS = 1.5;

/** Snow from here up (thermal height), a little under the classifier's snowline reference (1,520 m). */
const ROAD_SNOWLINE_METERS = 1_450;

/** Beyond the home airport's platform, how far its blend stays out of bounds for roads, metres. */
export const ROAD_AIRPORT_KEEP_OUT_METERS = 120;

/**
 * The home airport's keep-out, in runway-local metres beyond the platform
 * rectangle: the platform, its blend and `ROAD_AIRPORT_KEEP_OUT_METERS` more.
 */
export function roadAirportKeepOut(world: WorldDefinition, x: number, z: number): number {
  const airport = world.airport;
  if (!airport) return Number.POSITIVE_INFINITY;
  const local = worldToRunway(airport, x, z);
  const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea;
  const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth;
  const qa = Math.abs(local.along) - halfLength;
  const qc = Math.abs(local.across) - halfWidth;
  const outside = Math.hypot(Math.max(qa, 0), Math.max(qc, 0)) + Math.min(Math.max(qa, qc), 0);
  return outside - airport.terrainBlendDistance - ROAD_AIRPORT_KEEP_OUT_METERS;
}

const VOLCANIC = createVolcanicGroundSample();
const COVER = { ergWeight: 0, duneHeight: 0, sandCover: 0 };
const PROVINCE = { temperatureOffset: 0, dryness: 0 };

/** The ground class at a point whose pre-earthworks height is `height`. Allocates nothing once the point's lake tile is known. */
export function roadGroundAt(world: WorldDefinition, x: number, z: number, height: number): RoadGroundId {
  if (height < world.seaLevel + ROAD_SHORE_CLEARANCE_METERS) return RoadGround.water;
  if (roadAirportKeepOut(world, x, z) < 0) return RoadGround.airport;
  if (roadLakeWallAt(world, x, z)) return RoadGround.water;
  sampleVolcanicGround(world, x, z, 0, VOLCANIC);
  if (VOLCANIC.lavaCover + VOLCANIC.tephraCover > 0.25 && VOLCANIC.age < 0.6) return RoadGround.lava;
  sampleLandformCover(world, x, z, 0, COVER);
  if (COVER.sandCover > 0.45 || COVER.ergWeight > 0.5) return RoadGround.sand;
  const province = sampleClimateProvince(world, x, z, PROVINCE);
  if (terrainSnowlineThermalHeight(height - world.seaLevel, province.temperatureOffset) > ROAD_SNOWLINE_METERS) {
    return RoadGround.snow;
  }
  return RoadGround.land;
}

/** The pre-earthworks ground height the generator reads. */
export function roadGroundHeight(world: WorldDefinition, x: number, z: number): number {
  return sampleTerrainHeightBeforeEarthworks(world, x, z);
}

/**
 * Cost multiplier per metre for each ground class, on top of the grade and
 * side-slope terms; infinite where no road goes.
 */
export const ROAD_GROUND_COST: Readonly<Record<RoadGroundId, number>> = Object.freeze({
  [RoadGround.land]: 0,
  [RoadGround.water]: Number.POSITIVE_INFINITY,
  [RoadGround.airport]: Number.POSITIVE_INFINITY,
  [RoadGround.sand]: 2,
  [RoadGround.lava]: 3,
  [RoadGround.snow]: 1.5,
});
