import { DEFAULT_AIRPORT } from "./airport";
import { resolveGuaranteedAirportRegion } from "./airportSite";
import { unitFloatFromHash, hashSeed, mixSeed, normalizeSeed } from "./seed";
import { sampleNaturalTerrainHeight } from "./terrain";
import type { AirportFootprint, GeneratedAirportSite } from "./airportSite";
import type { AirportDefinition, WorldDefinition, WorldOptions, WorldSeed } from "./types";

export const DEFAULT_WORLD_SEED = "open-skies";

/**
 * Mid-latitude default (0-6): temperate seasons and sun paths that match the
 * biome mix the generator already produces. Existing worlds inherit it.
 */
export const DEFAULT_WORLD_LATITUDE_DEGREES = 45;

function finiteOrThrow(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positiveOrThrow(value: number, label: string): number {
  finiteOrThrow(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function createAirportFootprint(
  overrides: Partial<AirportDefinition> | undefined,
): Readonly<AirportFootprint> {
  return Object.freeze({
    runwayLength: positiveOrThrow(overrides?.runwayLength ?? DEFAULT_AIRPORT.runwayLength, "airport.runwayLength"),
    runwayWidth: positiveOrThrow(overrides?.runwayWidth ?? DEFAULT_AIRPORT.runwayWidth, "airport.runwayWidth"),
    endSafetyArea: positiveOrThrow(overrides?.endSafetyArea ?? DEFAULT_AIRPORT.endSafetyArea, "airport.endSafetyArea"),
    shoulderWidth: positiveOrThrow(overrides?.shoulderWidth ?? DEFAULT_AIRPORT.shoulderWidth, "airport.shoulderWidth"),
    terrainBlendDistance: positiveOrThrow(
      overrides?.terrainBlendDistance ?? DEFAULT_AIRPORT.terrainBlendDistance,
      "airport.terrainBlendDistance",
    ),
  });
}

function hasManualAirportSite(overrides: Partial<AirportDefinition> | undefined): boolean {
  return (
    overrides?.centerX !== undefined ||
    overrides?.centerZ !== undefined ||
    overrides?.headingRadians !== undefined
  );
}

function buildAirport(
  seedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
  overrides: Partial<AirportDefinition> | undefined,
  generatedSite: GeneratedAirportSite | null,
): Readonly<AirportDefinition> | null {
  const hasManualSite = hasManualAirportSite(overrides);
  if (!hasManualSite && (!generatedSite || !generatedSite.assessment.suitable)) {
    throw new Error("Generated airport construction requires a validated site");
  }
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
  const naturalElevation = sampleNaturalTerrainHeight(seedHash, centerX, centerZ, 0);
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
  const sourceSeedHash = hashSeed(normalizedSeed);
  const seaLevel = finiteOrThrow(options.seaLevel ?? 0, "seaLevel");
  const latitudeDegrees = finiteOrThrow(
    options.latitudeDegrees ?? DEFAULT_WORLD_LATITUDE_DEGREES,
    "latitudeDegrees",
  );
  if (latitudeDegrees < -90 || latitudeDegrees > 90) {
    throw new RangeError("latitudeDegrees must be in [-90, 90]");
  }
  let seedHash = sourceSeedHash;
  let airport: Readonly<AirportDefinition> | null = null;

  if (options.airport !== false) {
    const overrides = options.airport;
    const footprint = createAirportFootprint(overrides);
    if (hasManualAirportSite(overrides)) {
      airport = buildAirport(seedHash, seaLevel, footprint, overrides, null);
    } else {
      const region = resolveGuaranteedAirportRegion(sourceSeedHash, seaLevel, footprint);
      seedHash = region.seedHash;
      airport = buildAirport(seedHash, seaLevel, footprint, overrides, region.site);
    }
  }

  const directionHash = mixSeed(seedHash, 301);
  const speedHash = mixSeed(seedHash, 302);
  const prevailingWindRadians = unitFloatFromHash(directionHash) * Math.PI * 2;

  return Object.freeze({
    seed: normalizedSeed,
    sourceSeedHash,
    seedHash,
    seaLevel,
    airport,
    prevailingWindRadians,
    prevailingWindSpeed: 3.5 + unitFloatFromHash(speedHash) * 7.5,
    latitudeDegrees,
  });
}
