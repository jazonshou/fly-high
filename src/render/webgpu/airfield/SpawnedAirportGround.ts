import {
  getAirportInfluence,
  sampleTerrain,
  sampleTerrainHeight,
  type AirportDefinition,
  type WorldDefinition,
} from "@/src/world";
import { airportReachWorldBounds, airportTerrainReach } from "./AirportFootprint";

/**
 * The ground under an airport spawned in flight, for every CPU consumer of the
 * terrain: vegetation, ground cover, wildlife, the camera clamp and the
 * spawned airfield's own structures.
 *
 * **WHY A CONSUMER NEEDS THIS.** Every terrain sampler on the main thread was
 * built once, from the world the flight started in, and that world has one
 * airport. A spawned runway is a NEW world (`withAirports`), so without this a
 * hangar would seat itself on the ungraded hillside, a deer would graze the
 * runway and the camera would clamp to a ridge that is no longer there.
 *
 * **THE SAME RULE THE HOME FIELD ALREADY HAS.** `terrainConsumerSampleFromAuthority`
 * returns the analytic sample wherever `getAirportInfluence(world.airport) > 0`,
 * because the earthworks there are authored, not eroded. A spawned airport's
 * earthworks are just as authored, so inside ITS influence the answer is
 * `sampleTerrain(liveWorld)` — which reads the nearest airport's earthworks —
 * and everywhere else the consumer's own answer is returned unchanged. With no
 * spawned airport the consumer sampler is returned as-is: the home-only world
 * samples bit for bit what it did before.
 *
 * **O(1) PER SAMPLE, NOT A SEARCH OVER ALL AIRPORTS.** Samplers run thousands of
 * times a frame, so the spawned airports' influence rectangles are bucketed
 * once per airport-list change into a 2 km grid and a sample reads one bucket.
 */

const BUCKET_METERS = 2_048;
/** Bucket key; unique while |cell z| < 2^19 cells (about a million km). */
const bucketKey = (cellX: number, cellZ: number): number => cellX * 0x100000 + cellZ;

type Sampler<S> = (x: number, z: number) => S;

function bucketAirports(
  airports: readonly Readonly<AirportDefinition>[],
): Map<number, Readonly<AirportDefinition>[]> {
  const buckets = new Map<number, Readonly<AirportDefinition>[]>();
  for (const airport of airports) {
    const bounds = airportReachWorldBounds(airportTerrainReach(airport));
    const minX = Math.floor(bounds.minX / BUCKET_METERS);
    const maxX = Math.floor(bounds.maxX / BUCKET_METERS);
    const minZ = Math.floor(bounds.minZ / BUCKET_METERS);
    const maxZ = Math.floor(bounds.maxZ / BUCKET_METERS);
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ += 1) {
        const key = bucketKey(cellX, cellZ);
        const list = buckets.get(key);
        if (list) list.push(airport);
        else buckets.set(key, [airport]);
      }
    }
  }
  return buckets;
}

/**
 * `sample`, except inside a spawned airport's influence, where
 * `airportSample` answers. Returns `sample` ITSELF when `spawned` is empty.
 */
export function withSpawnedAirportGround<S>(
  spawned: readonly Readonly<AirportDefinition>[],
  sample: Sampler<S>,
  airportSample: Sampler<S>,
): Sampler<S> {
  if (spawned.length === 0) return sample;
  const buckets = bucketAirports(spawned);
  return (x, z) => {
    const list = buckets.get(
      bucketKey(Math.floor(x / BUCKET_METERS), Math.floor(z / BUCKET_METERS)),
    );
    if (list) {
      for (let index = 0; index < list.length; index += 1) {
        if (getAirportInfluence(list[index]!, x, z) > 0) return airportSample(x, z);
      }
    }
    return sample(x, z);
  };
}

/** A world's spawned airports: everything after the home field. */
export function spawnedAirportsOf(
  world: Readonly<WorldDefinition>,
): readonly Readonly<AirportDefinition>[] {
  return (world.airports ?? []).slice(1);
}

/**
 * The main thread's live version: ONE stable sampler function, handed to every
 * consumer at construction, whose answer follows `setWorld`. The consumers
 * hold the function, so swapping what it delegates to is the only way to move
 * all of them at once.
 */
export class LiveAirportGround<S> {
  private current: Sampler<S>;

  constructor(
    private readonly base: Sampler<S>,
    private readonly analytic: (world: Readonly<WorldDefinition>) => Sampler<S>,
  ) {
    this.current = base;
  }

  /** Stable: pass this, not `current`, to a consumer. */
  readonly sample: Sampler<S> = (x, z) => this.current(x, z);

  /** The world whose spawned airports the sampler honours (home field first). */
  setWorld(world: Readonly<WorldDefinition>): void {
    const spawned = spawnedAirportsOf(world);
    this.current = withSpawnedAirportGround(spawned, this.base, this.analytic(world));
  }
}

/** `sampleTerrain` against a given world, as `LiveAirportGround`'s analytic source. */
export function analyticTerrainOf(
  world: Readonly<WorldDefinition>,
): Sampler<ReturnType<typeof sampleTerrain>> {
  return (x, z) => sampleTerrain(world, x, z);
}

/**
 * `sampleTerrainHeight` against a given world: `analyticTerrainOf`'s height
 * alone, bit for bit, as the analytic source of a `LiveAirportGround<number>`.
 */
export function analyticTerrainHeightOf(world: Readonly<WorldDefinition>): Sampler<number> {
  return (x, z) => sampleTerrainHeight(world, x, z);
}
