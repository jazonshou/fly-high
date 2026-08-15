import { DEFAULT_AIRPORT } from "./airport";
import { unitFloatFromHash, hashSeed, mixSeed, normalizeSeed } from "./seed";
import { sampleNaturalTerrainHeight } from "./terrain";
import type { AirportDefinition, WorldDefinition, WorldOptions, WorldSeed } from "./types";

export const DEFAULT_WORLD_SEED = "open-skies";

function finiteOrThrow(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positiveOrThrow(value: number, label: string): number {
  finiteOrThrow(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function createAirport(
  seedHash: number,
  seaLevel: number,
  overrides: Partial<AirportDefinition> | undefined,
): Readonly<AirportDefinition> {
  const centerX = finiteOrThrow(overrides?.centerX ?? DEFAULT_AIRPORT.centerX, "airport.centerX");
  const centerZ = finiteOrThrow(overrides?.centerZ ?? DEFAULT_AIRPORT.centerZ, "airport.centerZ");
  const naturalElevation = sampleNaturalTerrainHeight(seedHash, centerX, centerZ);
  // Keeping the starter field close to sea level makes every seed approachable,
  // even when the natural coordinate happens to fall in an ocean or mountain range.
  const generatedElevation = Math.max(seaLevel + 14, Math.min(naturalElevation, seaLevel + 135));
  const airport: AirportDefinition = {
    centerX,
    centerZ,
    elevation: finiteOrThrow(overrides?.elevation ?? generatedElevation, "airport.elevation"),
    headingRadians: finiteOrThrow(
      overrides?.headingRadians ?? DEFAULT_AIRPORT.headingRadians,
      "airport.headingRadians",
    ),
    runwayLength: positiveOrThrow(
      overrides?.runwayLength ?? DEFAULT_AIRPORT.runwayLength,
      "airport.runwayLength",
    ),
    runwayWidth: positiveOrThrow(
      overrides?.runwayWidth ?? DEFAULT_AIRPORT.runwayWidth,
      "airport.runwayWidth",
    ),
    endSafetyArea: positiveOrThrow(
      overrides?.endSafetyArea ?? DEFAULT_AIRPORT.endSafetyArea,
      "airport.endSafetyArea",
    ),
    shoulderWidth: positiveOrThrow(
      overrides?.shoulderWidth ?? DEFAULT_AIRPORT.shoulderWidth,
      "airport.shoulderWidth",
    ),
    terrainBlendDistance: positiveOrThrow(
      overrides?.terrainBlendDistance ?? DEFAULT_AIRPORT.terrainBlendDistance,
      "airport.terrainBlendDistance",
    ),
  };
  return Object.freeze(airport);
}

export function createWorld(
  seed: WorldSeed = DEFAULT_WORLD_SEED,
  options: WorldOptions = {},
): WorldDefinition {
  const normalizedSeed = normalizeSeed(seed);
  const seedHash = hashSeed(normalizedSeed);
  const seaLevel = finiteOrThrow(options.seaLevel ?? 0, "seaLevel");
  const directionHash = mixSeed(seedHash, 301);
  const speedHash = mixSeed(seedHash, 302);
  const airport =
    options.airport === false ? null : createAirport(seedHash, seaLevel, options.airport);

  return Object.freeze({
    seed: normalizedSeed,
    seedHash,
    seaLevel,
    airport,
    prevailingWindRadians: unitFloatFromHash(directionHash) * Math.PI * 2,
    prevailingWindSpeed: 3.5 + unitFloatFromHash(speedHash) * 7.5,
  });
}
