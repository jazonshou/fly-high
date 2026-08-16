import { TerrainBiome } from "@/src/world";
import {
  DEFAULT_DETAIL_CELL_SIZE_METERS,
  type BuildingStyle,
  type DetailBuildingPlacement,
  type DetailCellGenerationOptions,
  type DetailRockPlacement,
  type DetailShrubPlacement,
  type DetailTerrainSample,
  type DetailTreePlacement,
  type DetailVillage,
  type GeneratedDetailCell,
  type RockVariant,
  type ShrubSpecies,
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

function chooseTreeSpecies(sample: DetailTerrainSample, choice: number): TreeSpecies {
  if (sample.biome === TerrainBiome.HIGHLAND || sample.biome === TerrainBiome.ALPINE) {
    if (choice < 0.44) return "spruce";
    if (choice < 0.79) return "pine";
    return "cedar";
  }
  if (sample.moisture > 0.78) {
    if (choice < 0.25) return "willow";
    if (choice < 0.49) return "birch";
    if (choice < 0.68) return "cedar";
    if (choice < 0.84) return "maple";
    return "oak";
  }
  if (sample.moisture < 0.35) {
    if (choice < 0.58) return "pine";
    if (choice < 0.78) return "spruce";
    return "oak";
  }
  if (choice < 0.24) return "oak";
  if (choice < 0.43) return "maple";
  if (choice < 0.59) return "birch";
  if (choice < 0.76) return "pine";
  if (choice < 0.9) return "spruce";
  return "cedar";
}

function treeDimensions(
  species: TreeSpecies,
  random: RandomSource,
  standAge: number,
): { height: number; crown: number; trunk: number; wind: number } {
  // A stand has an age signature, but individual trees still follow a
  // strongly skewed distribution.  This creates saplings, mature canopy, and
  // occasional emergent trees instead of uniformly scaled copies.
  const individualAge = random() > 0.955
    ? 1
    : clamp(0.04 + standAge * 0.4 + Math.pow(random(), 2.15) * 0.68, 0.04, 1);
  const dimensions = (
    minimumHeight: number,
    maximumHeight: number,
    crownRatio: number,
    trunkRatio: number,
    wind: number,
  ) => {
    const height = minimumHeight + (maximumHeight - minimumHeight) * individualAge;
    return {
      height,
      crown: height * crownRatio * (0.88 + random() * 0.24),
      trunk: Math.max(0.055, height * trunkRatio * (0.86 + random() * 0.24)),
      wind: wind * (1.12 - individualAge * 0.22),
    };
  };
  switch (species) {
    case "pine": return dimensions(4.5, 31, 0.18, 0.018, 0.62);
    case "cedar": return dimensions(5.5, 35, 0.21, 0.02, 0.52);
    case "spruce": return dimensions(4, 33, 0.16, 0.019, 0.58);
    case "oak": return dimensions(3.5, 25, 0.32, 0.026, 0.82);
    case "maple": return dimensions(3.2, 26, 0.3, 0.023, 0.88);
    case "birch": return dimensions(3.4, 24, 0.22, 0.014, 0.9);
    case "willow": return dimensions(2.8, 21, 0.37, 0.023, 0.94);
  }
}

function treeColor(species: TreeSpecies, random: RandomSource): readonly [number, number, number, number] {
  const variation = 0.84 + random() * 0.28;
  switch (species) {
    case "pine": return [0.72 * variation, 0.91 * variation, 0.74 * variation, 1];
    case "cedar": return [0.78 * variation, 0.86 * variation, 0.67 * variation, 1];
    case "spruce": return [0.67 * variation, 0.84 * variation, 0.78 * variation, 1];
    case "oak": return [0.94 * variation, 0.9 * variation, 0.68 * variation, 1];
    case "maple": return [0.98 * variation, 0.94 * variation, 0.63 * variation, 1];
    case "birch": return [0.88 * variation, 1.02 * variation, 0.75 * variation, 1];
    case "willow": return [0.88 * variation, 0.98 * variation, 0.7 * variation, 1];
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
  minX: number,
  minZ: number,
  cellSize: number,
  density: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
  village: DetailVillage | null,
): readonly DetailTreePlacement[] {
  if (density <= 0) return [];
  const clusterSpacing = 176;
  const maximumClusterRadius = 132;
  const maximumClusterReach = maximumClusterRadius * 1.5;
  const poissonHalo = 14;
  const minimumClusterX = Math.floor((minX - maximumClusterReach - poissonHalo) / clusterSpacing);
  const maximumClusterX = Math.floor(
    (minX + cellSize + maximumClusterReach + poissonHalo) / clusterSpacing,
  );
  const minimumClusterZ = Math.floor((minZ - maximumClusterReach - poissonHalo) / clusterSpacing);
  const maximumClusterZ = Math.floor(
    (minZ + cellSize + maximumClusterReach + poissonHalo) / clusterSpacing,
  );
  interface Candidate {
    readonly tree: DetailTreePlacement;
    readonly priority: number;
    readonly spacing: number;
  }
  const candidates: Candidate[] = [];
  const densityThreshold = clamp(density * 0.78, 0, 1);

  // Clusters are owned by a global lattice, not by a detail page.  Neighboring
  // pages therefore see the same stand centres and candidate identities.  A
  // wide jitter plus lobed offspring distribution hides the underlying lattice
  // while retaining deterministic, bounded work.
  for (let clusterZ = minimumClusterZ; clusterZ <= maximumClusterZ; clusterZ += 1) {
    for (let clusterX = minimumClusterX; clusterX <= maximumClusterX; clusterX += 1) {
      const random = createRandom(`${seed}/tree-stand/${clusterX}/${clusterZ}`);
      if (random() > 0.72) continue;
      const centerX = (clusterX + 0.08 + random() * 0.84) * clusterSpacing;
      const centerZ = (clusterZ + 0.08 + random() * 0.84) * clusterSpacing;
      const radius = 58 + random() * (maximumClusterRadius - 58);
      const richness = 0.72 + random() * 0.48;
      const standAge = random();
      const dominantSpeciesChoice = random();
      const lobeCount = 1 + Math.floor(random() * 3);
      const lobes: Array<readonly [number, number]> = [[centerX, centerZ]];
      for (let lobe = 1; lobe < lobeCount; lobe += 1) {
        const angle = random() * TAU;
        const offset = radius * (0.18 + random() * 0.28);
        lobes.push([
          centerX + Math.cos(angle) * offset,
          centerZ + Math.sin(angle) * offset,
        ]);
      }
      const potentialTrees = 14 + Math.floor(random() * 16);
      for (let index = 0; index < potentialTrees; index += 1) {
        const densitySelection = random();
        const lobe = lobes[Math.floor(random() * lobes.length)] ?? lobes[0]!;
        const angle = random() * TAU;
        const radialDistance = radius * Math.pow(random(), 0.92);
        const x = lobe[0] + Math.cos(angle) * radialDistance;
        const z = lobe[1] + Math.sin(angle) * radialDistance;
        if (
          densitySelection > densityThreshold
          || x < minX - poissonHalo
          || x >= minX + cellSize + poissonHalo
          || z < minZ - poissonHalo
          || z >= minZ + cellSize + poissonHalo
        ) continue;
        const ecologyAcceptance = random();
        const sample = sampleTerrain(x, z);
        if (
          !validSample(sample)
          || ecologyAcceptance >= clamp(treeProbability(sample) * richness, 0, 0.97)
        ) continue;
        if (village && Math.hypot(x - village.centerX, z - village.centerZ) < 82) continue;
        const speciesChoice = random() < 0.62 ? dominantSpeciesChoice : random();
        const species = chooseTreeSpecies(sample, speciesChoice);
        const dimensions = treeDimensions(species, random, standAge);
        const priority = random();
        candidates.push({
          tree: {
            kind: "tree",
            id: `stand:${clusterX}:${clusterZ}/tree/${index}`,
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
          },
          priority,
          spacing: clamp(dimensions.crown * 0.82, 3.5, poissonHalo),
        });
      }
    }
  }

  // Deterministic priority filtering is a bounded Poisson-like pass.  The halo
  // lets candidates just across a page edge participate, preventing paired
  // trees or density seams at paging boundaries.
  return candidates.filter((candidate) => {
    const { tree } = candidate;
    if (
      tree.x < minX
      || tree.x >= minX + cellSize
      || tree.z < minZ
      || tree.z >= minZ + cellSize
    ) return false;
    return !candidates.some((other) => {
      if (other === candidate) return false;
      if (
        other.priority < candidate.priority
        || (other.priority === candidate.priority && other.tree.id >= candidate.tree.id)
      ) return false;
      const requiredSpacing = Math.max(candidate.spacing, other.spacing);
      return Math.abs(other.tree.x - tree.x) < requiredSpacing
        && Math.abs(other.tree.z - tree.z) < requiredSpacing
        && Math.hypot(other.tree.x - tree.x, other.tree.z - tree.z) < requiredSpacing;
    });
  }).map((candidate) => candidate.tree);
}

function shrubProbability(sample: DetailTerrainSample): number {
  let probability: number;
  switch (sample.biome) {
    case TerrainBiome.FOREST:
      probability = 0.52 + sample.moisture * 0.22;
      break;
    case TerrainBiome.GRASSLAND:
      probability = 0.12 + sample.moisture * 0.16;
      break;
    case TerrainBiome.HIGHLAND:
      probability = 0.2 + sample.moisture * 0.13;
      break;
    case TerrainBiome.ALPINE:
      probability = 0.06;
      break;
    case TerrainBiome.BEACH:
      probability = 0.025;
      break;
    default:
      return 0;
  }
  return probability * clamp(1 - sample.slope * 1.3, 0, 1);
}

function chooseShrubSpecies(sample: DetailTerrainSample, choice: number): ShrubSpecies {
  if (sample.moisture > 0.64) return choice < 0.68 ? "hazel" : "juniper";
  if (sample.biome === TerrainBiome.HIGHLAND || sample.biome === TerrainBiome.ALPINE) {
    return choice < 0.72 ? "juniper" : "sage";
  }
  if (choice < 0.34) return "hazel";
  if (choice < 0.66) return "juniper";
  return "sage";
}

function shrubColor(
  species: ShrubSpecies,
  random: RandomSource,
): readonly [number, number, number, number] {
  const variation = 0.82 + random() * 0.3;
  switch (species) {
    case "juniper": return [0.67 * variation, 0.84 * variation, 0.7 * variation, 1];
    case "hazel": return [0.88 * variation, 0.96 * variation, 0.62 * variation, 1];
    case "sage": return [0.78 * variation, 0.84 * variation, 0.74 * variation, 1];
  }
}

function generateShrubs(
  seed: string,
  minX: number,
  minZ: number,
  cellSize: number,
  density: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
  village: DetailVillage | null,
): readonly DetailShrubPlacement[] {
  if (density <= 0) return [];
  const patchSpacing = 144;
  const maximumRadius = 66;
  const minimumPatchX = Math.floor((minX - maximumRadius) / patchSpacing);
  const maximumPatchX = Math.floor((minX + cellSize + maximumRadius) / patchSpacing);
  const minimumPatchZ = Math.floor((minZ - maximumRadius) / patchSpacing);
  const maximumPatchZ = Math.floor((minZ + cellSize + maximumRadius) / patchSpacing);
  const densityThreshold = clamp(density * 0.72, 0, 1);
  const shrubs: DetailShrubPlacement[] = [];
  for (let patchZ = minimumPatchZ; patchZ <= maximumPatchZ; patchZ += 1) {
    for (let patchX = minimumPatchX; patchX <= maximumPatchX; patchX += 1) {
      const random = createRandom(`${seed}/shrub-patch/${patchX}/${patchZ}`);
      if (random() > 0.64) continue;
      const centerX = (patchX + 0.1 + random() * 0.8) * patchSpacing;
      const centerZ = (patchZ + 0.1 + random() * 0.8) * patchSpacing;
      const radius = 20 + random() * (maximumRadius - 20);
      const richness = 0.78 + random() * 0.35;
      const dominantChoice = random();
      const candidates = 7 + Math.floor(random() * 12);
      for (let index = 0; index < candidates; index += 1) {
        const selection = random();
        const angle = random() * TAU;
        const distance = radius * Math.pow(random(), 1.18);
        const x = centerX + Math.cos(angle) * distance;
        const z = centerZ + Math.sin(angle) * distance;
        if (
          selection > densityThreshold
          || x < minX
          || x >= minX + cellSize
          || z < minZ
          || z >= minZ + cellSize
        ) continue;
        const sample = sampleTerrain(x, z);
        if (
          !validSample(sample)
          || random() >= clamp(shrubProbability(sample) * richness, 0, 0.94)
        ) continue;
        if (village && Math.hypot(x - village.centerX, z - village.centerZ) < 68) continue;
        const species = chooseShrubSpecies(sample, random() < 0.7 ? dominantChoice : random());
        const maturity = 0.2 + Math.pow(random(), 1.45) * 0.8;
        const height = species === "sage"
          ? 0.35 + maturity * 1.05
          : 0.55 + maturity * (species === "hazel" ? 2.8 : 2.1);
        shrubs.push({
          kind: "shrub",
          id: `shrub:${patchX}:${patchZ}/${index}`,
          species,
          x,
          y: sample.height,
          z,
          yawRadians: random() * TAU,
          heightMeters: height,
          radiusMeters: height * (species === "hazel" ? 0.72 : 0.62) * (0.82 + random() * 0.3),
          windPhaseRadians: random() * TAU,
          windResponse: 0.78 + random() * 0.38,
          color: shrubColor(species, random),
          selection,
        });
      }
    }
  }
  return shrubs;
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
      minX,
      minZ,
      cellSizeMeters,
      densityMultiplier,
      options.terrainSample,
      village,
    ),
    shrubs: generateShrubs(
      seed,
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
