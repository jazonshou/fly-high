import {
  TerrainBiome,
  hashCoordinates,
  hashSeed,
  mixSeed,
  unitFloatFromHash,
} from "@/src/world";
import {
  DEFAULT_WILDLIFE_CELL_SIZE_METERS,
  type BirdSpawn,
  type GeneratedWildlifeCell,
  type GroundAnimalSpawn,
  type WildlifeCellGenerationOptions,
  type WildlifeSpawn,
  type WildlifeTerrainSample,
  type WildlifeVector3,
} from "./types";

const TAU = Math.PI * 2;

type RandomSource = () => number;

function createRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

function isFiniteSample(sample: WildlifeTerrainSample): boolean {
  return (
    Number.isFinite(sample.height) &&
    Number.isFinite(sample.slope) &&
    sample.slope >= 0 &&
    sample.slope <= 1
  );
}

function groundHabitat(sample: WildlifeTerrainSample): boolean {
  if (!isFiniteSample(sample) || sample.slope > 0.34) return false;
  return (
    sample.biome !== TerrainBiome.WATER &&
    sample.biome !== TerrainBiome.BEACH &&
    sample.biome !== TerrainBiome.SNOW &&
    sample.biome !== TerrainBiome.RUNWAY
  );
}

function spawnSelection(seed: number, channel: number): number {
  return unitFloatFromHash(mixSeed(seed, channel));
}

export function wildlifeCellKey(cellX: number, cellZ: number): string {
  requireSafeInteger(cellX, "Wildlife cell x");
  requireSafeInteger(cellZ, "Wildlife cell z");
  return `${cellX}:${cellZ}`;
}

/** Deterministic spawn descriptors; no renderer or mutable simulation state. */
export function generateWildlifeCell(
  options: WildlifeCellGenerationOptions,
): GeneratedWildlifeCell {
  const cellX = requireSafeInteger(options.cellX, "Wildlife cell x");
  const cellZ = requireSafeInteger(options.cellZ, "Wildlife cell z");
  const cellSize = options.cellSizeMeters ?? DEFAULT_WILDLIFE_CELL_SIZE_METERS;
  if (!Number.isFinite(cellSize) || cellSize < 200 || cellSize > 4_000) {
    throw new RangeError("Wildlife cell size must be between 200 and 4000 metres");
  }
  const key = wildlifeCellKey(cellX, cellZ);
  const seedHash = hashSeed(options.worldSeed);
  const cellSeed = hashCoordinates(seedHash, cellX, cellZ, 0x57494c44);
  const random = createRandom(cellSeed);
  const minX = cellX * cellSize;
  const minZ = cellZ * cellSize;
  const centerSample = options.terrainSample(minX + cellSize * 0.5, minZ + cellSize * 0.5);
  if (!isFiniteSample(centerSample)) {
    throw new RangeError(`Wildlife terrain sampler returned an invalid sample for ${key}`);
  }

  const birdSpawns: BirdSpawn[] = [];
  const flockCount = 1 + (random() < 0.28 ? 1 : 0);
  for (let flockIndex = 0; flockIndex < flockCount; flockIndex += 1) {
    const flockId = `${key}/flock/${flockIndex}`;
    const margin = cellSize * 0.2;
    const homeX = minX + margin + random() * (cellSize - margin * 2);
    const homeZ = minZ + margin + random() * (cellSize - margin * 2);
    const homeTerrain = options.terrainSample(homeX, homeZ);
    if (!isFiniteSample(homeTerrain)) continue;
    const waterBird =
      homeTerrain.biome === TerrainBiome.WATER ||
      homeTerrain.biome === TerrainBiome.BEACH ||
      random() < 0.18;
    const species = waterBird ? "gull" : "hawk";
    const homeY = homeTerrain.height + (species === "gull" ? 55 : 95) + random() * 135;
    const heading = random() * TAU;
    const flockSpeed = (species === "gull" ? 13 : 16) + random() * 6;
    const requestedBirds = 5 + Math.floor(random() * 6);
    for (let member = 0; member < requestedBirds; member += 1) {
      const angle = random() * TAU;
      const radius = 4 + Math.sqrt(random()) * 24;
      const id = `${flockId}/bird/${member}`;
      birdSpawns.push({
        id,
        kind: "bird",
        species,
        flockId,
        position: {
          x: homeX + Math.cos(angle) * radius,
          y: homeY + (random() - 0.5) * 14,
          z: homeZ + Math.sin(angle) * radius,
        },
        home: { x: homeX, y: homeY, z: homeZ },
        velocity: {
          x: Math.cos(heading + (random() - 0.5) * 0.18) * flockSpeed,
          y: (random() - 0.5) * 1.2,
          z: Math.sin(heading + (random() - 0.5) * 0.18) * flockSpeed,
        },
        selection: spawnSelection(cellSeed, 100 + flockIndex * 32 + member),
        animationPhase: random() * TAU,
        updatePhase: Math.floor(random() * 4),
      });
    }
  }

  const groundSpawns: GroundAnimalSpawn[] = [];
  // Ground animals are intentionally sparse: at most one small group per cell.
  if (random() < 0.58) {
    const groupX = minX + cellSize * (0.18 + random() * 0.64);
    const groupZ = minZ + cellSize * (0.18 + random() * 0.64);
    const groupSample = options.terrainSample(groupX, groupZ);
    if (groundHabitat(groupSample)) {
      const species =
        groupSample.biome === TerrainBiome.FOREST && random() < 0.48 ? "boar" : "deer";
      const requestedAnimals = species === "deer" ? 2 + Math.floor(random() * 3) : 1 + Math.floor(random() * 3);
      const baseHeading = random() * TAU;
      for (let member = 0; member < requestedAnimals; member += 1) {
        const angle = random() * TAU;
        const radius = Math.sqrt(random()) * 18;
        const x = groupX + Math.cos(angle) * radius;
        const z = groupZ + Math.sin(angle) * radius;
        const sample = options.terrainSample(x, z);
        if (!groundHabitat(sample)) continue;
        groundSpawns.push({
          id: `${key}/ground/${species}/${member}`,
          kind: "ground",
          species,
          position: { x, y: sample.height, z },
          home: { x: groupX, y: groupSample.height, z: groupZ },
          headingRadians: baseHeading + (random() - 0.5) * 0.5,
          walkingSpeed: species === "deer" ? 1.55 + random() * 0.75 : 0.8 + random() * 0.6,
          selection: spawnSelection(cellSeed, 1_000 + member),
          animationPhase: random() * TAU,
          updatePhase: Math.floor(random() * 8),
        });
      }
    }
  }

  return { key, cellX, cellZ, cellSizeMeters: cellSize, birdSpawns, groundSpawns };
}

interface ScoredSpawn {
  readonly spawn: WildlifeSpawn;
  readonly score: number;
}

function scoreSpawn(spawn: WildlifeSpawn, observer: WildlifeVector3): ScoredSpawn {
  const dx = spawn.position.x - observer.x;
  const dz = spawn.position.z - observer.z;
  return {
    spawn,
    // Selection prevents visibly rigid distance rings while remaining stable.
    score: dx * dx + dz * dz + spawn.selection * 12_000,
  };
}

function compareSpawn(first: ScoredSpawn, second: ScoredSpawn): number {
  return first.score - second.score || first.spawn.id.localeCompare(second.spawn.id);
}

/**
 * Applies the quality-profile animal budget while reserving a small share for
 * recognizable terrestrial life. The result is stable for identical inputs.
 */
export function selectActiveWildlife(
  cells: readonly GeneratedWildlifeCell[],
  observer: WildlifeVector3,
  budget: number,
): readonly WildlifeSpawn[] {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError("Active wildlife budget must be a non-negative safe integer");
  }
  if (budget === 0) return [];
  const birds = cells.flatMap((cell) => cell.birdSpawns).map((spawn) => scoreSpawn(spawn, observer));
  const ground = cells.flatMap((cell) => cell.groundSpawns).map((spawn) => scoreSpawn(spawn, observer));
  birds.sort(compareSpawn);
  ground.sort(compareSpawn);

  const groundReservation = Math.min(
    ground.length,
    Math.max(budget >= 8 ? 1 : 0, Math.floor(budget * 0.22)),
  );
  const selected: WildlifeSpawn[] = ground
    .slice(0, groundReservation)
    .map((entry) => entry.spawn);
  selected.push(...birds.slice(0, budget - selected.length).map((entry) => entry.spawn));
  if (selected.length < budget) {
    selected.push(
      ...ground
        .slice(groundReservation, groundReservation + budget - selected.length)
        .map((entry) => entry.spawn),
    );
  }
  return selected;
}

