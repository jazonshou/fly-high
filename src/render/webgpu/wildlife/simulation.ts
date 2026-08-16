import { TerrainBiome } from "@/src/world";
import { SpatialHash3D } from "./SpatialHash";
import type {
  BirdAgent,
  GroundAnimalAgent,
  WildlifeAgent,
  WildlifeObserver,
  WildlifeSpawn,
  WildlifeTerrainSample,
  WildlifeTerrainSampler,
  WildlifeVector3,
} from "./types";

const TAU = Math.PI * 2;
const BIRD_NEIGHBOR_RADIUS = 68;
const BIRD_MAX_NEIGHBORS = 24;
const BIRD_MAX_CANDIDATE_CHECKS = 96;

export interface FixedStepAdvanceResult {
  readonly steps: number;
  readonly interpolationAlpha: number;
  readonly droppedSeconds: number;
}

export class FixedStepClock {
  private accumulator = 0;
  private cumulativeDroppedSeconds = 0;
  private cumulativeStepsValue = 0;

  constructor(
    readonly stepSeconds = 1 / 30,
    readonly maxSubSteps = 6,
    readonly maxFrameSeconds = 0.25,
  ) {
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
      throw new RangeError("Fixed simulation step must be finite and positive");
    }
    if (!Number.isSafeInteger(maxSubSteps) || maxSubSteps < 1) {
      throw new RangeError("Fixed simulation max substeps must be a positive integer");
    }
    if (!Number.isFinite(maxFrameSeconds) || maxFrameSeconds < stepSeconds) {
      throw new RangeError("Fixed simulation frame cap must be at least one fixed step");
    }
  }

  get cumulativeSteps(): number {
    return this.cumulativeStepsValue;
  }

  get droppedSeconds(): number {
    return this.cumulativeDroppedSeconds;
  }

  advance(deltaSeconds: number, step: (stepSeconds: number) => void): FixedStepAdvanceResult {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError("Simulation delta must be finite and non-negative");
    }
    const droppedBefore = this.cumulativeDroppedSeconds;
    if (deltaSeconds > this.maxFrameSeconds) {
      this.cumulativeDroppedSeconds += deltaSeconds - this.maxFrameSeconds;
    }
    this.accumulator += Math.min(deltaSeconds, this.maxFrameSeconds);
    let steps = 0;
    const epsilon = this.stepSeconds * 1e-9;
    while (this.accumulator + epsilon >= this.stepSeconds && steps < this.maxSubSteps) {
      step(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      if (this.accumulator < 0 && this.accumulator > -epsilon) this.accumulator = 0;
      steps += 1;
      this.cumulativeStepsValue += 1;
    }
    if (this.accumulator >= this.stepSeconds) {
      const skippedSteps = Math.floor(this.accumulator / this.stepSeconds);
      const skippedTime = skippedSteps * this.stepSeconds;
      this.accumulator -= skippedTime;
      this.cumulativeDroppedSeconds += skippedTime;
    }
    return {
      steps,
      interpolationAlpha: this.accumulator / this.stepSeconds,
      droppedSeconds: this.cumulativeDroppedSeconds - droppedBefore,
    };
  }

  reset(): void {
    this.accumulator = 0;
    this.cumulativeDroppedSeconds = 0;
    this.cumulativeStepsValue = 0;
  }
}

export interface WildlifeSimulationStepStatistics {
  readonly neighborQueries: number;
  readonly neighborCandidateChecks: number;
  readonly maxNeighborsObserved: number;
}

export interface WildlifeSimulationContext {
  readonly observer: WildlifeObserver;
  readonly terrainSample: WildlifeTerrainSampler;
}

function cloneVector(vector: Readonly<WildlifeVector3>): WildlifeVector3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

export function createWildlifeAgent(spawn: WildlifeSpawn): WildlifeAgent {
  if (spawn.kind === "bird") {
    return {
      id: spawn.id,
      kind: "bird",
      species: spawn.species,
      flockId: spawn.flockId,
      position: cloneVector(spawn.position),
      previousPosition: cloneVector(spawn.position),
      home: cloneVector(spawn.home),
      velocity: cloneVector(spawn.velocity),
      previousVelocity: cloneVector(spawn.velocity),
      selection: spawn.selection,
      animationPhase: spawn.animationPhase,
      previousAnimationPhase: spawn.animationPhase,
      updatePhase: spawn.updatePhase,
      lod: "near",
    };
  }
  return {
    id: spawn.id,
    kind: "ground",
    species: spawn.species,
    position: cloneVector(spawn.position),
    previousPosition: cloneVector(spawn.position),
    home: cloneVector(spawn.home),
    selection: spawn.selection,
    animationPhase: spawn.animationPhase,
    previousAnimationPhase: spawn.animationPhase,
    updatePhase: spawn.updatePhase,
    lod: "near",
    headingRadians: spawn.headingRadians,
    previousHeadingRadians: spawn.headingRadians,
    walkingSpeed: spawn.walkingSpeed,
    gaitPhase: spawn.animationPhase,
    previousGaitPhase: spawn.animationPhase,
  };
}

export function assignWildlifeLod(
  agents: readonly WildlifeAgent[],
  observer: WildlifeVector3,
  birdNearDistance = 720,
  groundNearDistance = 460,
): void {
  const birdThresholdSquared = birdNearDistance * birdNearDistance;
  const groundThresholdSquared = groundNearDistance * groundNearDistance;
  for (const agent of agents) {
    const dx = agent.position.x - observer.x;
    const dy = agent.position.y - observer.y;
    const dz = agent.position.z - observer.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    const threshold = agent.kind === "bird" ? birdThresholdSquared : groundThresholdSquared;
    agent.lod = distanceSquared <= threshold ? "near" : "far";
  }
}

function clampMagnitude(
  x: number,
  y: number,
  z: number,
  maximum: number,
): WildlifeVector3 {
  const magnitude = Math.hypot(x, y, z);
  if (magnitude <= maximum || magnitude <= 1e-9) return { x, y, z };
  const scale = maximum / magnitude;
  return { x: x * scale, y: y * scale, z: z * scale };
}

function normalizeAngle(angle: number): number {
  let result = angle % TAU;
  if (result > Math.PI) result -= TAU;
  if (result < -Math.PI) result += TAU;
  return result;
}

function validGround(sample: WildlifeTerrainSample): boolean {
  return (
    Number.isFinite(sample.height) &&
    Number.isFinite(sample.slope) &&
    sample.slope >= 0 &&
    sample.slope <= 0.4 &&
    sample.biome !== TerrainBiome.WATER &&
    sample.biome !== TerrainBiome.BEACH &&
    sample.biome !== TerrainBiome.SNOW &&
    sample.biome !== TerrainBiome.RUNWAY
  );
}

/** Pure CPU wildlife motion; Babylon is only a presentation consumer. */
export class WildlifeSimulation {
  private readonly spatialHash = new SpatialHash3D(48);
  private stepIndex = 0;

  step(
    agents: readonly WildlifeAgent[],
    context: WildlifeSimulationContext,
    deltaSeconds: number,
  ): WildlifeSimulationStepStatistics {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || deltaSeconds > 0.25) {
      throw new RangeError("Wildlife simulation step must be in the range (0, 0.25]");
    }
    for (const agent of agents) {
      agent.previousPosition.x = agent.position.x;
      agent.previousPosition.y = agent.position.y;
      agent.previousPosition.z = agent.position.z;
      agent.previousAnimationPhase = agent.animationPhase;
      if (agent.kind === "bird") {
        agent.previousVelocity.x = agent.velocity.x;
        agent.previousVelocity.y = agent.velocity.y;
        agent.previousVelocity.z = agent.velocity.z;
      } else {
        agent.previousHeadingRadians = agent.headingRadians;
        agent.previousGaitPhase = agent.gaitPhase;
      }
    }
    const birds = agents.filter((agent): agent is BirdAgent => agent.kind === "bird");
    this.spatialHash.rebuild(birds.map((bird) => bird.position));
    const nextVelocities = birds.map((bird) => cloneVector(bird.velocity));
    let neighborQueries = 0;
    let neighborCandidateChecks = 0;
    let maxNeighborsObserved = 0;

    for (let index = 0; index < birds.length; index += 1) {
      const bird = birds[index]!;
      const stride = bird.lod === "near" ? 1 : 4;
      if ((this.stepIndex + bird.updatePhase) % stride !== 0) continue;
      const query = this.spatialHash.query(
        bird.position,
        BIRD_NEIGHBOR_RADIUS,
        BIRD_MAX_NEIGHBORS,
        index,
        BIRD_MAX_CANDIDATE_CHECKS,
      );
      neighborQueries += 1;
      neighborCandidateChecks += query.candidateChecks;
      maxNeighborsObserved = Math.max(maxNeighborsObserved, query.indices.length);

      let separationX = 0;
      let separationY = 0;
      let separationZ = 0;
      let alignmentX = 0;
      let alignmentY = 0;
      let alignmentZ = 0;
      let cohesionX = 0;
      let cohesionY = 0;
      let cohesionZ = 0;
      let flockNeighbors = 0;
      for (const neighborIndex of query.indices) {
        const neighbor = birds[neighborIndex];
        if (!neighbor) continue;
        const dx = neighbor.position.x - bird.position.x;
        const dy = neighbor.position.y - bird.position.y;
        const dz = neighbor.position.z - bird.position.z;
        const distanceSquared = Math.max(0.25, dx * dx + dy * dy + dz * dz);
        if (distanceSquared < 15 * 15) {
          separationX -= dx / distanceSquared;
          separationY -= dy / distanceSquared;
          separationZ -= dz / distanceSquared;
        }
        if (neighbor.flockId !== bird.flockId) continue;
        alignmentX += neighbor.velocity.x;
        alignmentY += neighbor.velocity.y;
        alignmentZ += neighbor.velocity.z;
        cohesionX += neighbor.position.x;
        cohesionY += neighbor.position.y;
        cohesionZ += neighbor.position.z;
        flockNeighbors += 1;
      }

      let accelerationX = separationX * 54;
      let accelerationY = separationY * 36;
      let accelerationZ = separationZ * 54;
      if (flockNeighbors > 0) {
        const inverseCount = 1 / flockNeighbors;
        accelerationX += (alignmentX * inverseCount - bird.velocity.x) * 0.24;
        accelerationY += (alignmentY * inverseCount - bird.velocity.y) * 0.18;
        accelerationZ += (alignmentZ * inverseCount - bird.velocity.z) * 0.24;
        accelerationX += (cohesionX * inverseCount - bird.position.x) * 0.018;
        accelerationY += (cohesionY * inverseCount - bird.position.y) * 0.012;
        accelerationZ += (cohesionZ * inverseCount - bird.position.z) * 0.018;
      }

      const homeDx = bird.home.x - bird.position.x;
      const homeDy = bird.home.y - bird.position.y;
      const homeDz = bird.home.z - bird.position.z;
      const homeDistance = Math.hypot(homeDx, homeDy, homeDz);
      const tether = homeDistance > 130 ? Math.min(0.038, (homeDistance - 130) * 0.00012) : 0.002;
      accelerationX += homeDx * tether;
      accelerationY += homeDy * Math.max(0.012, tether);
      accelerationZ += homeDz * tether;

      const observerDx = bird.position.x - context.observer.x;
      const observerDy = bird.position.y - context.observer.y;
      const observerDz = bird.position.z - context.observer.z;
      const observerDistanceSquared =
        observerDx * observerDx + observerDy * observerDy + observerDz * observerDz;
      if (observerDistanceSquared < 95 * 95) {
        const inverseDistance = 1 / Math.max(4, Math.sqrt(observerDistanceSquared));
        const avoidance = (95 - Math.sqrt(observerDistanceSquared)) * 0.22;
        accelerationX += observerDx * inverseDistance * avoidance;
        accelerationY += (observerDy * inverseDistance + 0.35) * avoidance;
        accelerationZ += observerDz * inverseDistance * avoidance;
      }

      const terrain = context.terrainSample(bird.position.x, bird.position.z);
      if (Number.isFinite(terrain.height)) {
        const minimumHeight = terrain.height + 24;
        if (bird.position.y < minimumHeight) {
          accelerationY += Math.min(12, (minimumHeight - bird.position.y) * 0.3);
        }
      }
      const time = this.stepIndex * deltaSeconds;
      accelerationX += Math.sin(time * 0.83 + bird.animationPhase) * 0.36;
      accelerationZ += Math.cos(time * 0.71 + bird.animationPhase) * 0.36;

      const boundedAcceleration = clampMagnitude(
        accelerationX,
        accelerationY,
        accelerationZ,
        bird.lod === "near" ? 11 : 7,
      );
      const aiDelta = deltaSeconds * stride;
      let velocityX = bird.velocity.x + boundedAcceleration.x * aiDelta;
      let velocityY = bird.velocity.y + boundedAcceleration.y * aiDelta;
      let velocityZ = bird.velocity.z + boundedAcceleration.z * aiDelta;
      const maximumSpeed = bird.species === "hawk" ? 29 : 24;
      const minimumSpeed = bird.species === "hawk" ? 11 : 8;
      const speed = Math.hypot(velocityX, velocityY, velocityZ);
      if (speed > maximumSpeed) {
        const scale = maximumSpeed / speed;
        velocityX *= scale;
        velocityY *= scale;
        velocityZ *= scale;
      } else if (speed < minimumSpeed && speed > 1e-6) {
        const scale = minimumSpeed / speed;
        velocityX *= scale;
        velocityY *= scale;
        velocityZ *= scale;
      }
      nextVelocities[index] = { x: velocityX, y: velocityY, z: velocityZ };
    }

    for (let index = 0; index < birds.length; index += 1) {
      const bird = birds[index]!;
      const velocity = nextVelocities[index]!;
      bird.velocity.x = velocity.x;
      bird.velocity.y = velocity.y;
      bird.velocity.z = velocity.z;
      bird.position.x += velocity.x * deltaSeconds;
      bird.position.y += velocity.y * deltaSeconds;
      bird.position.z += velocity.z * deltaSeconds;
      bird.animationPhase = (bird.animationPhase + deltaSeconds * (7.5 + Math.hypot(
        velocity.x,
        velocity.y,
        velocity.z,
      ) * 0.12)) % TAU;
    }

    for (const agent of agents) {
      if (agent.kind === "ground") this.stepGroundAnimal(agent, context, deltaSeconds);
    }
    this.stepIndex += 1;
    return { neighborQueries, neighborCandidateChecks, maxNeighborsObserved };
  }

  private stepGroundAnimal(
    agent: GroundAnimalAgent,
    context: WildlifeSimulationContext,
    deltaSeconds: number,
  ): void {
    const stride = agent.lod === "near" ? 3 : 12;
    const updatesAi = (this.stepIndex + agent.updatePhase) % stride === 0;
    if (updatesAi) {
      const aiDelta = deltaSeconds * stride;
      const homeDx = agent.home.x - agent.position.x;
      const homeDz = agent.home.z - agent.position.z;
      const homeDistance = Math.hypot(homeDx, homeDz);
      const wander = Math.sin(this.stepIndex * 0.047 + agent.animationPhase) * 0.34;
      agent.headingRadians = normalizeAngle(agent.headingRadians + wander * aiDelta);
      if (homeDistance > 52) {
        const homeHeading = Math.atan2(homeDx, homeDz);
        agent.headingRadians = normalizeAngle(
          agent.headingRadians + normalizeAngle(homeHeading - agent.headingRadians) * Math.min(1, aiDelta * 0.9),
        );
      }
    }

    const distance = agent.walkingSpeed * deltaSeconds;
    const nextX = agent.position.x + Math.sin(agent.headingRadians) * distance;
    const nextZ = agent.position.z + Math.cos(agent.headingRadians) * distance;
    const terrain = context.terrainSample(nextX, nextZ);
    if (validGround(terrain)) {
      agent.position.x = nextX;
      agent.position.y = terrain.height;
      agent.position.z = nextZ;
    } else if (updatesAi) {
      agent.headingRadians = normalizeAngle(agent.headingRadians + Math.PI * 0.72);
    }
    agent.gaitPhase = (agent.gaitPhase + distance * (agent.species === "deer" ? 4.8 : 5.6)) % TAU;
    agent.animationPhase = (agent.animationPhase + deltaSeconds * 0.45) % TAU;
  }
}
