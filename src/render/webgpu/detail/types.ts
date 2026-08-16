import type { TerrainBiomeId, WorldSeed } from "@/src/world";

export const DEFAULT_DETAIL_CELL_SIZE_METERS = 512;

export type DetailLod = "near" | "mid";
export type TreeSpecies =
  | "pine"
  | "cedar"
  | "spruce"
  | "oak"
  | "maple"
  | "birch"
  | "willow";
export type ShrubSpecies = "juniper" | "hazel" | "sage";
export type RockVariant = "granite" | "limestone" | "dark";
export type BuildingStyle = "cottage" | "barn" | "tower";

export interface DetailTerrainSample {
  readonly height: number;
  /** Normalized terrain steepness: zero is flat and one approaches vertical. */
  readonly slope: number;
  readonly moisture: number;
  readonly biome: TerrainBiomeId;
}

export type DetailTerrainSampler = (worldX: number, worldZ: number) => DetailTerrainSample;

export interface DetailCellGenerationOptions {
  readonly worldSeed: WorldSeed;
  readonly cellX: number;
  readonly cellZ: number;
  readonly terrainSample: DetailTerrainSampler;
  readonly cellSizeMeters?: number;
  readonly densityMultiplier?: number;
}

export interface DetailTreePlacement {
  readonly kind: "tree";
  readonly id: string;
  readonly species: TreeSpecies;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawRadians: number;
  readonly heightMeters: number;
  readonly crownRadiusMeters: number;
  readonly trunkRadiusMeters: number;
  readonly windPhaseRadians: number;
  readonly windResponse: number;
  readonly color: readonly [number, number, number, number];
  /** Stable random value used for deterministic distance thinning. */
  readonly selection: number;
}

export interface DetailShrubPlacement {
  readonly kind: "shrub";
  readonly id: string;
  readonly species: ShrubSpecies;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawRadians: number;
  readonly heightMeters: number;
  readonly radiusMeters: number;
  readonly windPhaseRadians: number;
  readonly windResponse: number;
  readonly color: readonly [number, number, number, number];
  readonly selection: number;
}

export interface DetailRockPlacement {
  readonly kind: "rock";
  readonly id: string;
  readonly variant: RockVariant;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawRadians: number;
  readonly radiusMeters: number;
  readonly flattening: number;
  readonly color: readonly [number, number, number, number];
  readonly selection: number;
}

export interface DetailBuildingPlacement {
  readonly kind: "building";
  readonly id: string;
  readonly style: BuildingStyle;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawRadians: number;
  readonly widthMeters: number;
  readonly heightMeters: number;
  readonly depthMeters: number;
  readonly color: readonly [number, number, number, number];
}

export interface DetailVillage {
  readonly id: string;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly roadHeadingRadians: number;
}

export interface GeneratedDetailCell {
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly cellSizeMeters: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly trees: readonly DetailTreePlacement[];
  readonly shrubs: readonly DetailShrubPlacement[];
  readonly rocks: readonly DetailRockPlacement[];
  readonly buildings: readonly DetailBuildingPlacement[];
  readonly village: DetailVillage | null;
}

export interface WorldDetailObserver {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly velocityX?: number;
  readonly velocityZ?: number;
}

/** Absolute CPU-world point represented by Babylon-local zero. */
export interface DetailFloatingOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WorldDetailStatistics {
  readonly residentCells: number;
  readonly nearCells: number;
  readonly midCells: number;
  readonly generatedCells: number;
  readonly treeInstances: number;
  readonly shrubInstances: number;
  readonly rockInstances: number;
  readonly buildingInstances: number;
  /** Main-camera-frustum instances, including separate trunks/crowns and walls/roofs. */
  readonly renderedThinInstances: number;
  /** Spatial prototype/chunk batches selected by the main-camera frustum. */
  readonly activeBatches: number;
}
