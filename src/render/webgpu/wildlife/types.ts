import type { TerrainBiomeId, WorldSeed } from "@/src/world";

export const DEFAULT_WILDLIFE_CELL_SIZE_METERS = 800;

export type BirdSpecies = "gull" | "hawk";
export type GroundAnimalSpecies = "deer" | "boar";
export type WildlifeSpecies = BirdSpecies | GroundAnimalSpecies;
export type WildlifeLod = "near" | "far";

export interface WildlifeVector3 {
  x: number;
  y: number;
  z: number;
}

export interface WildlifeTerrainSample {
  readonly height: number;
  /** Zero is flat and one approaches a vertical face. */
  readonly slope: number;
  readonly biome: TerrainBiomeId;
}

export type WildlifeTerrainSampler = (
  worldX: number,
  worldZ: number,
) => WildlifeTerrainSample;

export interface WildlifeObserver extends WildlifeVector3 {
  readonly velocityX?: number;
  readonly velocityY?: number;
  readonly velocityZ?: number;
}

/** Absolute CPU-world point represented by Babylon-local zero. */
export type WildlifeFloatingOrigin = WildlifeVector3;

interface WildlifeSpawnBase {
  readonly id: string;
  readonly position: Readonly<WildlifeVector3>;
  readonly home: Readonly<WildlifeVector3>;
  readonly selection: number;
  readonly animationPhase: number;
  readonly updatePhase: number;
}

export interface BirdSpawn extends WildlifeSpawnBase {
  readonly kind: "bird";
  readonly species: BirdSpecies;
  readonly flockId: string;
  readonly velocity: Readonly<WildlifeVector3>;
}

export interface GroundAnimalSpawn extends WildlifeSpawnBase {
  readonly kind: "ground";
  readonly species: GroundAnimalSpecies;
  readonly headingRadians: number;
  readonly walkingSpeed: number;
}

export type WildlifeSpawn = BirdSpawn | GroundAnimalSpawn;

export interface GeneratedWildlifeCell {
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly cellSizeMeters: number;
  readonly birdSpawns: readonly BirdSpawn[];
  readonly groundSpawns: readonly GroundAnimalSpawn[];
}

export interface WildlifeCellGenerationOptions {
  readonly worldSeed: WorldSeed;
  readonly cellX: number;
  readonly cellZ: number;
  readonly terrainSample: WildlifeTerrainSampler;
  readonly cellSizeMeters?: number;
}

interface WildlifeAgentBase {
  readonly id: string;
  readonly home: WildlifeVector3;
  readonly selection: number;
  readonly updatePhase: number;
  readonly position: WildlifeVector3;
  readonly previousPosition: WildlifeVector3;
  lod: WildlifeLod;
  animationPhase: number;
  previousAnimationPhase: number;
}

export interface BirdAgent extends WildlifeAgentBase {
  readonly kind: "bird";
  readonly species: BirdSpecies;
  readonly flockId: string;
  readonly velocity: WildlifeVector3;
  readonly previousVelocity: WildlifeVector3;
}

export interface GroundAnimalAgent extends WildlifeAgentBase {
  readonly kind: "ground";
  readonly species: GroundAnimalSpecies;
  headingRadians: number;
  previousHeadingRadians: number;
  walkingSpeed: number;
  gaitPhase: number;
  previousGaitPhase: number;
}

export type WildlifeAgent = BirdAgent | GroundAnimalAgent;

export interface WildlifeStatistics {
  readonly activeAnimals: number;
  readonly birdCount: number;
  readonly groundAnimalCount: number;
  readonly nearAiAgents: number;
  readonly farAiAgents: number;
  readonly renderedThinInstances: number;
  readonly activeBatches: number;
  readonly fixedStepsThisFrame: number;
  readonly cumulativeFixedSteps: number;
  readonly populationRebuilds: number;
  readonly neighborQueries: number;
  readonly neighborCandidateChecks: number;
  readonly maxNeighborsObserved: number;
  readonly droppedSimulationSeconds: number;
}

export interface WildlifeSystemOptions {
  readonly worldSeed: WorldSeed;
  readonly terrainSample: WildlifeTerrainSampler;
  readonly cellSizeMeters?: number;
  /** Radius used to gather deterministic spawn cells around the observer. */
  readonly activeRadiusMeters?: number;
}
