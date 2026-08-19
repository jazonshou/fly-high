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
export type ClutterKind = "log" | "stump" | "branchLitter" | "mossCushion";
export type RockVariant = "granite" | "limestone" | "dark";

export interface DetailTerrainSample {
  readonly height: number;
  /** Normalized terrain steepness: zero is flat and one approaches vertical. */
  readonly slope: number;
  readonly moisture: number;
  readonly biome: TerrainBiomeId;
  /**
   * 0 outside the airport blend, 1 on its graded platform (1B-6). Optional so
   * simple samplers stay valid; omitted means 0. The world-layer TerrainSample
   * carries it, so the live sampler provides it for free.
   */
  readonly airportInfluence?: number;
  /**
   * Surface normal for the density field's aspect term (1B-7). Optional; the
   * world-layer TerrainSample carries it. Omitted reads as flat ground.
   */
  readonly normal?: { readonly x: number; readonly y: number; readonly z: number };
}

export type DetailTerrainSampler = (worldX: number, worldZ: number) => DetailTerrainSample;

export interface DetailCellGenerationOptions {
  readonly worldSeed: WorldSeed;
  readonly cellX: number;
  readonly cellZ: number;
  readonly terrainSample: DetailTerrainSampler;
  readonly cellSizeMeters?: number;
  readonly densityMultiplier?: number;
  /** Sea level in metres; anchors the density field's shoreline and treeline (1B-7). */
  readonly seaLevelMeters?: number;
  /** Environment clock day (§1.6), threaded to the density field. Default 0. */
  readonly dayOfYear?: number;
  /**
   * 2-13a: world latitude in degrees for R-13's seasonal kernel (autumn
   * turn, leaf fall, canopy snowline). Default 45°N, the world default.
   */
  readonly latitudeDegrees?: number;
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
  /** 2-11b: continuous stand age at this stem (0..1) — 2-12/2-13a consume it. */
  readonly standAge: number;
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
  /** 2-15: terrain normal at the placement, for ~60% alignment. */
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
}

/** 2-15: ground clutter — logs, stumps, branch litter, moss cushions. */
export interface DetailClutterPlacement {
  readonly kind: "clutter";
  readonly id: string;
  readonly clutterKind: ClutterKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawRadians: number;
  /** Prototype scale (prototypes are unit-ish; this is heightScaleMeters). */
  readonly sizeMeters: number;
  readonly color: readonly [number, number, number, number];
  readonly selection: number;
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
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
  readonly clutter: readonly DetailClutterPlacement[];
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
  readonly clutterInstances: number;
  /** Main-camera-frustum instances, including separate trunks/crowns and walls/roofs. */
  readonly renderedThinInstances: number;
  /** Spatial prototype/chunk batches selected by the main-camera frustum. */
  readonly activeBatches: number;
}
