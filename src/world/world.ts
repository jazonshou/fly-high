import { DEFAULT_AIRPORT } from "./airport";
import { findGeneratedAirportSite } from "./airportSite";
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
  preferredHeading: number,
  overrides: Partial<AirportDefinition> | undefined,
): Readonly<AirportDefinition> | null {
  const footprint = {
    runwayLength: positiveOrThrow(overrides?.runwayLength ?? DEFAULT_AIRPORT.runwayLength, "airport.runwayLength"),
    runwayWidth: positiveOrThrow(overrides?.runwayWidth ?? DEFAULT_AIRPORT.runwayWidth, "airport.runwayWidth"),
    endSafetyArea: positiveOrThrow(overrides?.endSafetyArea ?? DEFAULT_AIRPORT.endSafetyArea, "airport.endSafetyArea"),
    shoulderWidth: positiveOrThrow(overrides?.shoulderWidth ?? DEFAULT_AIRPORT.shoulderWidth, "airport.shoulderWidth"),
    terrainBlendDistance: positiveOrThrow(
      overrides?.terrainBlendDistance ?? DEFAULT_AIRPORT.terrainBlendDistance,
      "airport.terrainBlendDistance",
    ),
  };
  const hasManualSite =
    overrides?.centerX !== undefined ||
    overrides?.centerZ !== undefined ||
    overrides?.headingRadians !== undefined;
  const generatedSite = hasManualSite
    ? null
    : findGeneratedAirportSite(seedHash, seaLevel, footprint, preferredHeading);
  // Never turn the search's airport-less safety fallback back into the old
  // origin runway, and never accept a future selector regression that returns
  // a scored-but-unsafe candidate.
  if (!hasManualSite && (!generatedSite || !generatedSite.assessment.suitable)) return null;
  const centerX = finiteOrThrow(
    overrides?.centerX ?? generatedSite?.centerX ?? DEFAULT_AIRPORT.centerX,
    "airport.centerX",
  );
  const centerZ = finiteOrThrow(
    overrides?.centerZ ?? generatedSite?.centerZ ?? DEFAULT_AIRPORT.centerZ,
    "airport.centerZ",
  );
  const headingRadians = finiteOrThrow(
    overrides?.headingRadians ?? generatedSite?.headingRadians ?? DEFAULT_AIRPORT.headingRadians,
    "airport.headingRadians",
  );
  const naturalElevation = sampleNaturalTerrainHeight(seedHash, centerX, centerZ);
  const generatedElevation = generatedSite
    ? Math.max(seaLevel + 10, Math.round(generatedSite.assessment.elevation * 4) / 4)
    : Math.max(seaLevel + 14, Math.min(naturalElevation, seaLevel + 135));
  const airport: AirportDefinition = {
    centerX,
    centerZ,
    elevation: finiteOrThrow(overrides?.elevation ?? generatedElevation, "airport.elevation"),
    headingRadians,
    ...footprint,
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
  const prevailingWindRadians = unitFloatFromHash(directionHash) * Math.PI * 2;
  const airport =
    options.airport === false
      ? null
      : createAirport(seedHash, seaLevel, prevailingWindRadians, options.airport);

  return Object.freeze({
    seed: normalizedSeed,
    seedHash,
    seaLevel,
    airport,
    prevailingWindRadians,
    prevailingWindSpeed: 3.5 + unitFloatFromHash(speedHash) * 7.5,
  });
}
