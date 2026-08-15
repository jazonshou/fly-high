/** A seed accepted by the deterministic world generator. */
export type WorldSeed = string | number;

/** World-space vector. Horizontal coordinates are x/z and elevation is y. */
export interface WorldVector3 {
  x: number;
  y: number;
  z: number;
}

export interface AirportDefinition {
  /** Runway centre in world metres. */
  centerX: number;
  centerZ: number;
  /** Runway surface elevation above the world sea level, in metres. */
  elevation: number;
  /** Clockwise from world north (+z), in radians. */
  headingRadians: number;
  runwayLength: number;
  runwayWidth: number;
  /** Extra flat ground beyond each runway end. */
  endSafetyArea: number;
  /** Extra flat ground on each side of the paved runway. */
  shoulderWidth: number;
  /** Distance over which the airport platform is blended into the terrain. */
  terrainBlendDistance: number;
}

export interface WorldOptions {
  seaLevel?: number;
  /** Pass false to generate a world without the starter airport. */
  airport?: false | Partial<AirportDefinition>;
}

export interface WorldDefinition {
  readonly seed: string;
  readonly seedHash: number;
  readonly seaLevel: number;
  readonly airport: Readonly<AirportDefinition> | null;
  /** Prevailing wind direction (towards), clockwise from north. */
  readonly prevailingWindRadians: number;
  /** Prevailing wind magnitude before local gusts, in metres per second. */
  readonly prevailingWindSpeed: number;
}

export const TerrainBiome = {
  WATER: 0,
  BEACH: 1,
  GRASSLAND: 2,
  FOREST: 3,
  HIGHLAND: 4,
  ALPINE: 5,
  SNOW: 6,
  RUNWAY: 7,
} as const;

export type TerrainBiomeId = (typeof TerrainBiome)[keyof typeof TerrainBiome];

export const TERRAIN_BIOME_NAMES = [
  "water",
  "beach",
  "grassland",
  "forest",
  "highland",
  "alpine",
  "snow",
  "runway",
] as const;

export type TerrainBiomeName = (typeof TERRAIN_BIOME_NAMES)[number];

export interface TerrainColor {
  /** Linear-ish color channels in the inclusive range 0..1. */
  r: number;
  g: number;
  b: number;
}

export interface TerrainSample {
  height: number;
  normal: WorldVector3;
  /** 0 for level ground, approaching 1 for a vertical face. */
  slope: number;
  moisture: number;
  temperature: number;
  biome: TerrainBiomeId;
  biomeName: TerrainBiomeName;
  color: TerrainColor;
  /** 0 outside the airport blend, 1 on its flat platform. */
  airportInfluence: number;
  /** True only over the paved runway rectangle. */
  isRunway: boolean;
}

/** Minimal terrain data required by the flight contact solver. */
export interface TerrainCollisionSample {
  height: number;
  normal: WorldVector3;
  isRunway: boolean;
  /** Surface multiplier consumed directly by the tyre model. */
  friction: number;
}

export interface WindSample extends WorldVector3 {
  speed: number;
  /** Signed local variation around the prevailing flow, approximately -1..1. */
  gust: number;
  turbulence: number;
}

export interface TerrainTileOptions {
  /** Integer tile address. Negative addresses are fully supported. */
  tileX: number;
  tileZ: number;
  /** Edge length in world metres. Defaults to 1,024. */
  size?: number;
  /** Vertices along each edge, including both edges. Defaults to 33. */
  resolution?: number;
  /** Generate normals. Defaults to true. */
  includeNormals?: boolean;
  /** Generate vertex colors. Defaults to true. */
  includeColors?: boolean;
  /** Generate moisture and biome classification arrays. Defaults to true. */
  includeClimate?: boolean;
}

export interface TerrainTileData {
  readonly tileX: number;
  readonly tileZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly size: number;
  readonly resolution: number;
  readonly spacing: number;
  readonly heights: Float32Array;
  /** xyz triples, or an empty typed array when normals were not requested. */
  readonly normals: Float32Array;
  /** RGB byte triples, or an empty typed array when colors were not requested. */
  readonly colors: Uint8Array;
  /** One byte per vertex, normalized from the 0..1 moisture value. */
  readonly moisture: Uint8Array;
  /** One TerrainBiome value per vertex. */
  readonly biomes: Uint8Array;
  readonly minHeight: number;
  readonly maxHeight: number;
}

export interface TerrainTileBuffers {
  heights: Float32Array;
  normals?: Float32Array;
  colors?: Uint8Array;
  moisture?: Uint8Array;
  biomes?: Uint8Array;
}

export interface RunwayCoordinates {
  /** Signed distance along the runway from its centre. */
  along: number;
  /** Signed distance right of runway centreline. */
  across: number;
}

export interface RunwayPoint {
  x: number;
  y: number;
  z: number;
}
