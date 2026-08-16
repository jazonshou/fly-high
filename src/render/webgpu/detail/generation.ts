import { TerrainBiome } from "@/src/world";
import {
  DEFAULT_DETAIL_CELL_SIZE_METERS,
  type BuildingStyle,
  type DetailBuildingPlacement,
  type DetailCellGenerationOptions,
  type DetailRockPlacement,
  type DetailTerrainSample,
  type DetailTreePlacement,
  type DetailVillage,
  type GeneratedDetailCell,
  type RockVariant,
  type TreeSpecies,
} from "./types";

const TAU = Math.PI * 2;
const VILLAGE_REGION_CELLS = 4;
const VILLAGE_REGION_CHANCE = 0.42;

type RandomSource = () => number;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function createRandom(seed: string): RandomSource {
  let state = hashText(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function validSample(sample: DetailTerrainSample): boolean {
  return (
    Number.isFinite(sample.height) &&
    Number.isFinite(sample.slope) &&
    Number.isFinite(sample.moisture) &&
    sample.slope >= 0 &&
    sample.slope <= 1 &&
    sample.moisture >= 0 &&
    sample.moisture <= 1
  );
}

function treeProbability(sample: DetailTerrainSample): number {
  const moisture = sample.moisture;
  let probability: number;
  switch (sample.biome) {
    case TerrainBiome.FOREST:
      probability = 0.68 + moisture * 0.25;
      break;
    case TerrainBiome.GRASSLAND:
      probability = 0.035 + moisture * 0.12;
      break;
    case TerrainBiome.HIGHLAND:
      probability = 0.08 + moisture * 0.18;
      break;
    case TerrainBiome.ALPINE:
      probability = 0.015 + moisture * 0.035;
      break;
    default:
      return 0;
  }
  return probability * clamp(1 - sample.slope * 1.15, 0, 1);
}

function rockProbability(sample: DetailTerrainSample): number {
  let probability: number;
  switch (sample.biome) {
    case TerrainBiome.BEACH:
      probability = 0.09;
      break;
    case TerrainBiome.GRASSLAND:
      probability = 0.025;
      break;
    case TerrainBiome.FOREST:
      probability = 0.04;
      break;
    case TerrainBiome.HIGHLAND:
      probability = 0.18;
      break;
    case TerrainBiome.ALPINE:
      probability = 0.28;
      break;
    case TerrainBiome.SNOW:
      probability = 0.14;
      break;
    default:
      return 0;
  }
  return clamp(probability + sample.slope * 0.35, 0, 0.75);
}

function chooseTreeSpecies(sample: DetailTerrainSample, random: RandomSource): TreeSpecies {
  const choice = random();
  if (sample.biome === TerrainBiome.HIGHLAND || sample.biome === TerrainBiome.ALPINE) {
    return choice < 0.72 ? "pine" : "cedar";
  }
  if (sample.moisture > 0.72) {
    if (choice < 0.48) return "birch";
    if (choice < 0.76) return "cedar";
    return "oak";
  }
  if (sample.moisture < 0.35) return choice < 0.68 ? "pine" : "oak";
  if (choice < 0.34) return "oak";
  if (choice < 0.58) return "birch";
  if (choice < 0.82) return "pine";
  return "cedar";
}

function treeDimensions(
  species: TreeSpecies,
  random: RandomSource,
): { height: number; crown: number; trunk: number; wind: number } {
  const variation = random();
  switch (species) {
    case "pine": {
      const height = 12 + variation * 16;
      return { height, crown: height * (0.16 + random() * 0.04), trunk: height * 0.018, wind: 0.62 };
    }
    case "cedar": {
      const height = 14 + variation * 18;
      return { height, crown: height * (0.19 + random() * 0.04), trunk: height * 0.02, wind: 0.52 };
    }
    case "oak": {
      const height = 8 + variation * 12;
      return { height, crown: height * (0.28 + random() * 0.06), trunk: height * 0.026, wind: 0.82 };
    }
    case "birch": {
      const height = 10 + variation * 12;
      return { height, crown: height * (0.2 + random() * 0.04), trunk: height * 0.014, wind: 0.9 };
    }
  }
}

function treeColor(species: TreeSpecies, random: RandomSource): readonly [number, number, number, number] {
  const variation = 0.84 + random() * 0.28;
  switch (species) {
    case "pine": return [0.72 * variation, 0.91 * variation, 0.74 * variation, 1];
    case "cedar": return [0.78 * variation, 0.86 * variation, 0.67 * variation, 1];
    case "oak": return [0.94 * variation, 0.9 * variation, 0.68 * variation, 1];
    case "birch": return [0.88 * variation, 1.02 * variation, 0.75 * variation, 1];
  }
}

function villageSuitability(sample: DetailTerrainSample): boolean {
  return (
    validSample(sample) &&
    (sample.biome === TerrainBiome.GRASSLAND || sample.biome === TerrainBiome.HIGHLAND) &&
    sample.slope <= 0.16 &&
    sample.moisture >= 0.18 &&
    sample.moisture <= 0.88
  );
}

function createVillage(
  seed: string,
  cellX: number,
  cellZ: number,
  cellSize: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
): { village: DetailVillage; buildings: readonly DetailBuildingPlacement[] } | null {
  const regionX = Math.floor(cellX / VILLAGE_REGION_CELLS);
  const regionZ = Math.floor(cellZ / VILLAGE_REGION_CELLS);
  const ownerRandom = createRandom(`${seed}/village-region/${regionX}/${regionZ}`);
  const ownerX = regionX * VILLAGE_REGION_CELLS + Math.floor(ownerRandom() * VILLAGE_REGION_CELLS);
  const ownerZ = regionZ * VILLAGE_REGION_CELLS + Math.floor(ownerRandom() * VILLAGE_REGION_CELLS);
  if (ownerX !== cellX || ownerZ !== cellZ || ownerRandom() >= VILLAGE_REGION_CHANCE) return null;

  const random = createRandom(`${seed}/village/${cellX}/${cellZ}`);
  const minX = cellX * cellSize;
  const minZ = cellZ * cellSize;
  const centerX = minX + cellSize * (0.34 + random() * 0.32);
  const centerZ = minZ + cellSize * (0.34 + random() * 0.32);
  const centerSample = sampleTerrain(centerX, centerZ);
  if (!villageSuitability(centerSample)) return null;

  const heading = random() * Math.PI;
  const village: DetailVillage = {
    id: `${cellX}:${cellZ}/village`,
    centerX,
    centerY: centerSample.height,
    centerZ,
    roadHeadingRadians: heading,
  };
  const forwardX = Math.sin(heading);
  const forwardZ = Math.cos(heading);
  const rightX = forwardZ;
  const rightZ = -forwardX;
  const requestedBuildings = 6 + Math.floor(random() * 7);
  const buildings: DetailBuildingPlacement[] = [];
  for (let index = 0; index < requestedBuildings; index += 1) {
    const along = (index - (requestedBuildings - 1) * 0.5) * (20 + random() * 5);
    const side = (index % 2 === 0 ? -1 : 1) * (17 + random() * 10);
    const x = centerX + forwardX * along + rightX * side;
    const z = centerZ + forwardZ * along + rightZ * side;
    if (x < minX + 8 || x > minX + cellSize - 8 || z < minZ + 8 || z > minZ + cellSize - 8) {
      continue;
    }
    const sample = sampleTerrain(x, z);
    if (!villageSuitability(sample) || sample.slope > 0.2) continue;
    const styleChoice = random();
    const style: BuildingStyle = styleChoice < 0.7 ? "cottage" : styleChoice < 0.92 ? "barn" : "tower";
    const width = style === "tower" ? 8 + random() * 4 : 10 + random() * 8;
    const depth = style === "barn" ? 14 + random() * 8 : 8 + random() * 7;
    const height = style === "tower" ? 14 + random() * 8 : 6 + random() * 4;
    const colorVariation = 0.82 + random() * 0.28;
    buildings.push({
      kind: "building",
      id: `${village.id}/building/${index}`,
      style,
      x,
      y: sample.height,
      z,
      yawRadians: heading + (random() - 0.5) * 0.1,
      widthMeters: width,
      heightMeters: height,
      depthMeters: depth,
      color: [colorVariation, colorVariation * 0.96, colorVariation * 0.86, 1],
    });
  }
  return buildings.length >= 3 ? { village, buildings } : null;
}

function generateTrees(
  seed: string,
  key: string,
  minX: number,
  minZ: number,
  cellSize: number,
  density: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
  village: DetailVillage | null,
): readonly DetailTreePlacement[] {
  if (density <= 0) return [];
  const random = createRandom(`${seed}/trees/${key}`);
  const grid = Math.max(4, Math.min(24, Math.round((cellSize / 29) * Math.sqrt(density))));
  const spacing = cellSize / grid;
  const trees: DetailTreePlacement[] = [];
  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) {
      const x = minX + (column + 0.12 + random() * 0.76) * spacing;
      const z = minZ + (row + 0.12 + random() * 0.76) * spacing;
      const acceptance = random();
      const sample = sampleTerrain(x, z);
      if (!validSample(sample) || acceptance >= treeProbability(sample)) continue;
      if (village && Math.hypot(x - village.centerX, z - village.centerZ) < 82) continue;
      const species = chooseTreeSpecies(sample, random);
      const dimensions = treeDimensions(species, random);
      trees.push({
        kind: "tree",
        id: `${key}/tree/${row * grid + column}`,
        species,
        x,
        y: sample.height,
        z,
        yawRadians: random() * TAU,
        heightMeters: dimensions.height,
        crownRadiusMeters: dimensions.crown,
        trunkRadiusMeters: dimensions.trunk,
        windPhaseRadians: random() * TAU,
        windResponse: dimensions.wind * (0.82 + random() * 0.28),
        color: treeColor(species, random),
        selection: random(),
      });
    }
  }
  return trees;
}

function chooseRockVariant(sample: DetailTerrainSample, random: RandomSource): RockVariant {
  if (sample.biome === TerrainBiome.ALPINE || sample.biome === TerrainBiome.SNOW) {
    return random() < 0.72 ? "granite" : "dark";
  }
  return random() < 0.55 ? "limestone" : random() < 0.82 ? "granite" : "dark";
}

function generateRocks(
  seed: string,
  key: string,
  minX: number,
  minZ: number,
  cellSize: number,
  density: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
  village: DetailVillage | null,
): readonly DetailRockPlacement[] {
  if (density <= 0) return [];
  const random = createRandom(`${seed}/rocks/${key}`);
  const candidates = Math.min(96, Math.max(12, Math.round((cellSize * cellSize / 2_800) * density)));
  const rocks: DetailRockPlacement[] = [];
  for (let index = 0; index < candidates; index += 1) {
    const x = minX + random() * cellSize;
    const z = minZ + random() * cellSize;
    const acceptance = random();
    const sample = sampleTerrain(x, z);
    if (!validSample(sample) || acceptance >= rockProbability(sample)) continue;
    if (village && Math.hypot(x - village.centerX, z - village.centerZ) < 45) continue;
    const variant = chooseRockVariant(sample, random);
    const radius = 0.5 + (0.25 + sample.slope * 0.75) * random() * 4.2;
    const tint = 0.78 + random() * 0.3;
    rocks.push({
      kind: "rock",
      id: `${key}/rock/${index}`,
      variant,
      x,
      y: sample.height - radius * 0.12,
      z,
      yawRadians: random() * TAU,
      radiusMeters: radius,
      flattening: 0.45 + random() * 0.45,
      color: [tint, tint * (variant === "limestone" ? 1.03 : 0.92), tint * 0.86, 1],
      selection: random(),
    });
  }
  return rocks;
}

/** Deterministically regenerate one cell without reading or mutating global state. */
export function generateDetailCell(options: DetailCellGenerationOptions): GeneratedDetailCell {
  const cellX = requireSafeInteger(options.cellX, "Detail cell x");
  const cellZ = requireSafeInteger(options.cellZ, "Detail cell z");
  const cellSizeMeters = options.cellSizeMeters ?? DEFAULT_DETAIL_CELL_SIZE_METERS;
  const densityMultiplier = options.densityMultiplier ?? 1;
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters < 64 || cellSizeMeters > 4_096) {
    throw new RangeError("Detail cell size must be between 64 and 4096 metres");
  }
  if (!Number.isFinite(densityMultiplier) || densityMultiplier < 0 || densityMultiplier > 2) {
    throw new RangeError("Detail density multiplier must be between 0 and 2");
  }

  const seed = String(options.worldSeed);
  const key = detailCellKey(cellX, cellZ);
  const minX = cellX * cellSizeMeters;
  const minZ = cellZ * cellSizeMeters;
  const settlement = createVillage(
    seed,
    cellX,
    cellZ,
    cellSizeMeters,
    options.terrainSample,
  );
  const village = settlement?.village ?? null;
  return {
    key,
    cellX,
    cellZ,
    cellSizeMeters,
    minX,
    minZ,
    maxX: minX + cellSizeMeters,
    maxZ: minZ + cellSizeMeters,
    trees: generateTrees(
      seed,
      key,
      minX,
      minZ,
      cellSizeMeters,
      densityMultiplier,
      options.terrainSample,
      village,
    ),
    rocks: generateRocks(
      seed,
      key,
      minX,
      minZ,
      cellSizeMeters,
      densityMultiplier,
      options.terrainSample,
      village,
    ),
    buildings: settlement?.buildings ?? [],
    village,
  };
}

export function detailCellKey(cellX: number, cellZ: number): string {
  requireSafeInteger(cellX, "Detail cell x");
  requireSafeInteger(cellZ, "Detail cell z");
  return `${cellX}:${cellZ}`;
}
