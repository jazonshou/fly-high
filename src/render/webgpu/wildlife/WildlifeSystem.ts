import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  createWildlifePrototypeGeometry,
  type WildlifePrototypeKey,
} from "./appearance";
import { generateWildlifeCell, selectActiveWildlife } from "./generation";
import {
  FixedStepClock,
  WildlifeSimulation,
  assignWildlifeLod,
  createWildlifeAgent,
} from "./simulation";
import {
  DEFAULT_WILDLIFE_CELL_SIZE_METERS,
  type BirdAgent,
  type GroundAnimalAgent,
  type WildlifeAgent,
  type WildlifeFloatingOrigin,
  type WildlifeObserver,
  type WildlifeStatistics,
  type WildlifeSystemOptions,
  type WildlifeVector3,
} from "./types";

const DEFAULT_ACTIVE_RADIUS_METERS = 2_000;
const MAX_ACTIVE_ANIMALS = 512;
const TAU = Math.PI * 2;

interface WildlifeBatch {
  readonly mesh: Mesh;
  readonly matrices: number[];
  readonly castsShadows: boolean;
  readonly matrixData: Float32Array;
}

type WildlifeSurfaceKind = "feather" | "fur" | "keratin";

interface WildlifeMaterialOptions {
  readonly roughness: number;
  readonly surface: WildlifeSurfaceKind;
  readonly sheenIntensity?: number;
  readonly translucencyIntensity?: number;
  readonly clearCoatIntensity?: number;
  readonly doubleSided?: boolean;
}

interface ThinInstanceMatrixCacheOwner {
  readonly _thinInstanceDataStorage: {
    worldMatrices: Matrix[] | null;
  };
}

const ZERO_STATISTICS: WildlifeStatistics = Object.freeze({
  activeAnimals: 0,
  birdCount: 0,
  groundAnimalCount: 0,
  nearAiAgents: 0,
  farAiAgents: 0,
  renderedThinInstances: 0,
  activeBatches: 0,
  fixedStepsThisFrame: 0,
  cumulativeFixedSteps: 0,
  populationRebuilds: 0,
  neighborQueries: 0,
  neighborCandidateChecks: 0,
  maxNeighborsObserved: 0,
  droppedSimulationSeconds: 0,
});

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function distanceToCell(
  x: number,
  z: number,
  cellX: number,
  cellZ: number,
  cellSize: number,
): number {
  const minimumX = cellX * cellSize;
  const minimumZ = cellZ * cellSize;
  const maximumX = minimumX + cellSize;
  const maximumZ = minimumZ + cellSize;
  return Math.hypot(
    Math.max(minimumX - x, 0, x - maximumX),
    Math.max(minimumZ - z, 0, z - maximumZ),
  );
}

function interpolateAngle(previous: number, current: number, alpha: number): number {
  const delta = ((current - previous + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return previous + delta * alpha;
}

/**
 * Deterministic, budgeted wildlife for the Babylon WebGPU renderer. CPU agents
 * remain in absolute world space; only thin-instance matrices are origin-relative.
 */
export class WildlifeSystem {
  private readonly batches = new Map<string, WildlifeBatch>();
  private readonly materials = new Set<PBRMaterial>();
  private readonly simulation = new WildlifeSimulation();
  private readonly clock = new FixedStepClock();
  private agents: WildlifeAgent[] = [];
  private populationSignature = "";
  private populationRebuilds = 0;
  private statisticsValue = ZERO_STATISTICS;
  private disposed = false;

  private readonly bodyRotation = new Quaternion();
  private readonly localRotation = new Quaternion();
  private readonly combinedRotation = new Quaternion();
  private readonly localOffset = new Vector3();
  private readonly rotatedOffset = new Vector3();
  private readonly worldPosition = new Vector3();
  private readonly scale = new Vector3();
  private readonly matrix = new Matrix();

  readonly cellSizeMeters: number;
  readonly activeRadiusMeters: number;

  constructor(
    private readonly scene: Scene,
    private readonly options: WildlifeSystemOptions,
  ) {
    this.cellSizeMeters = options.cellSizeMeters ?? DEFAULT_WILDLIFE_CELL_SIZE_METERS;
    this.activeRadiusMeters = options.activeRadiusMeters ?? DEFAULT_ACTIVE_RADIUS_METERS;
    if (
      !Number.isFinite(this.cellSizeMeters) ||
      this.cellSizeMeters < 200 ||
      this.cellSizeMeters > 4_000
    ) {
      throw new RangeError("Wildlife cell size must be between 200 and 4000 metres");
    }
    if (
      !Number.isFinite(this.activeRadiusMeters) ||
      this.activeRadiusMeters < this.cellSizeMeters ||
      this.activeRadiusMeters > 12_000
    ) {
      throw new RangeError("Wildlife active radius must be between one cell and 12000 metres");
    }
    this.createBatches();
  }

  get statistics(): WildlifeStatistics {
    return this.statisticsValue;
  }

  update(
    observer: WildlifeObserver,
    floatingOrigin: WildlifeFloatingOrigin,
    profile: WebGpuQualityProfile,
    deltaSeconds: number,
  ): void {
    if (this.disposed) return;
    requireFinite(observer.x, "Wildlife observer x");
    requireFinite(observer.y, "Wildlife observer y");
    requireFinite(observer.z, "Wildlife observer z");
    const velocityX = requireFinite(observer.velocityX ?? 0, "Wildlife observer x velocity");
    const velocityY = requireFinite(observer.velocityY ?? 0, "Wildlife observer y velocity");
    const velocityZ = requireFinite(observer.velocityZ ?? 0, "Wildlife observer z velocity");
    requireFinite(floatingOrigin.x, "Wildlife floating-origin x");
    requireFinite(floatingOrigin.y, "Wildlife floating-origin y");
    requireFinite(floatingOrigin.z, "Wildlife floating-origin z");
    requireFinite(deltaSeconds, "Wildlife update delta");
    if (deltaSeconds < 0) throw new RangeError("Wildlife update delta must be non-negative");
    if (
      !Number.isFinite(profile.activeAnimalBudget) ||
      profile.activeAnimalBudget < 0
    ) {
      throw new RangeError("Active animal budget must be finite and non-negative");
    }
    const budget = Math.min(MAX_ACTIVE_ANIMALS, Math.floor(profile.activeAnimalBudget));
    const speed = Math.hypot(velocityX, velocityY, velocityZ);
    const lookAheadSeconds = speed > 1 ? Math.min(4, this.cellSizeMeters / speed) : 0;
    const predictedX = observer.x + velocityX * lookAheadSeconds;
    const predictedZ = observer.z + velocityZ * lookAheadSeconds;
    const observerCellX = Math.floor(observer.x / this.cellSizeMeters);
    const observerCellZ = Math.floor(observer.z / this.cellSizeMeters);
    const predictedCellX = Math.floor(predictedX / this.cellSizeMeters);
    const predictedCellZ = Math.floor(predictedZ / this.cellSizeMeters);
    const nextSignature = [
      observerCellX,
      observerCellZ,
      predictedCellX,
      predictedCellZ,
      budget,
    ].join(":");
    if (nextSignature !== this.populationSignature) {
      this.populationSignature = nextSignature;
      this.reconcilePopulation(observer, predictedX, predictedZ, budget);
    }

    assignWildlifeLod(this.agents, observer);
    let neighborQueries = 0;
    let neighborCandidateChecks = 0;
    let maxNeighborsObserved = 0;
    const advance = this.clock.advance(deltaSeconds, (stepSeconds) => {
      const step = this.simulation.step(
        this.agents,
        { observer, terrainSample: this.options.terrainSample },
        stepSeconds,
      );
      neighborQueries += step.neighborQueries;
      neighborCandidateChecks += step.neighborCandidateChecks;
      maxNeighborsObserved = Math.max(maxNeighborsObserved, step.maxNeighborsObserved);
    });
    this.rebuildPresentation(floatingOrigin, advance.interpolationAlpha);
    this.updateStatistics(
      advance.steps,
      neighborQueries,
      neighborCandidateChecks,
      maxNeighborsObserved,
    );
  }

  /** Supplies only enabled, populated thin-instance sources to a CSM/shadow generator. */
  addShadowCasters(add: (mesh: Mesh) => void): void {
    if (this.disposed) return;
    for (const batch of this.batches.values()) {
      if (
        batch.castsShadows &&
        batch.mesh.isEnabled() &&
        batch.mesh.thinInstanceCount > 0
      ) {
        add(batch.mesh);
      }
    }
  }

  /** Visits the fixed shared PBR material set; agents add only matrix data. */
  addPbrMaterials(add: (material: PBRMaterial) => void): void {
    if (this.disposed) return;
    for (const material of this.materials) add(material);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.agents = [];
    for (const batch of this.batches.values()) batch.mesh.dispose(false, false);
    this.batches.clear();
    for (const material of this.materials) material.dispose(false, false);
    this.materials.clear();
    this.statisticsValue = ZERO_STATISTICS;
  }

  private reconcilePopulation(
    observer: WildlifeObserver,
    predictedX: number,
    predictedZ: number,
    budget: number,
  ): void {
    if (budget === 0) {
      this.agents = [];
      this.populationRebuilds += 1;
      return;
    }
    const minimumCellX = Math.floor(
      (Math.min(observer.x, predictedX) - this.activeRadiusMeters) / this.cellSizeMeters,
    );
    const maximumCellX = Math.floor(
      (Math.max(observer.x, predictedX) + this.activeRadiusMeters) / this.cellSizeMeters,
    );
    const minimumCellZ = Math.floor(
      (Math.min(observer.z, predictedZ) - this.activeRadiusMeters) / this.cellSizeMeters,
    );
    const maximumCellZ = Math.floor(
      (Math.max(observer.z, predictedZ) + this.activeRadiusMeters) / this.cellSizeMeters,
    );
    const cells = [];
    for (let cellZ = minimumCellZ; cellZ <= maximumCellZ; cellZ += 1) {
      for (let cellX = minimumCellX; cellX <= maximumCellX; cellX += 1) {
        const currentDistance = distanceToCell(
          observer.x,
          observer.z,
          cellX,
          cellZ,
          this.cellSizeMeters,
        );
        const predictedDistance = distanceToCell(
          predictedX,
          predictedZ,
          cellX,
          cellZ,
          this.cellSizeMeters,
        );
        if (
          currentDistance > this.activeRadiusMeters &&
          predictedDistance > this.activeRadiusMeters * 0.8
        ) continue;
        cells.push(generateWildlifeCell({
          worldSeed: this.options.worldSeed,
          cellX,
          cellZ,
          cellSizeMeters: this.cellSizeMeters,
          terrainSample: this.options.terrainSample,
        }));
      }
    }

    const desired = selectActiveWildlife(cells, observer, budget);
    const existingById = new Map(this.agents.map((agent) => [agent.id, agent]));
    this.agents = desired.map((spawn) => {
      const existing = existingById.get(spawn.id);
      return existing && existing.kind === spawn.kind ? existing : createWildlifeAgent(spawn);
    });
    this.populationRebuilds += 1;
  }

  private rebuildPresentation(
    floatingOrigin: WildlifeFloatingOrigin,
    interpolationAlpha: number,
  ): void {
    for (const batch of this.batches.values()) batch.matrices.length = 0;
    for (const agent of this.agents) {
      if (agent.kind === "bird") {
        this.renderBird(agent, floatingOrigin, interpolationAlpha);
      } else {
        this.renderGroundAnimal(agent, floatingOrigin, interpolationAlpha);
      }
    }
    for (const batch of this.batches.values()) {
      const count = batch.matrices.length / 16;
      batch.matrixData.set(batch.matrices, 0);
      batch.mesh.thinInstanceCount = count;
      if (count === 0) {
        batch.mesh.setEnabled(false);
        continue;
      }
      batch.mesh.setEnabled(true);
      batch.mesh.thinInstanceBufferUpdated("matrix");
      // Babylon caches the CPU matrices returned by
      // thinInstanceGetWorldMatrices() but does not invalidate that cache when
      // an updatable buffer changes. Keep readback/debug consumers coherent.
      (batch.mesh as unknown as ThinInstanceMatrixCacheOwner)
        ._thinInstanceDataStorage.worldMatrices = null;
      batch.mesh.thinInstanceRefreshBoundingInfo(true);
    }
  }

  private renderBird(
    agent: BirdAgent,
    origin: WildlifeFloatingOrigin,
    alpha: number,
  ): void {
    const velocityX = agent.previousVelocity.x
      + (agent.velocity.x - agent.previousVelocity.x) * alpha;
    const velocityY = agent.previousVelocity.y
      + (agent.velocity.y - agent.previousVelocity.y) * alpha;
    const velocityZ = agent.previousVelocity.z
      + (agent.velocity.z - agent.previousVelocity.z) * alpha;
    const horizontalSpeed = Math.hypot(velocityX, velocityZ);
    const yaw = Math.atan2(velocityX, velocityZ);
    const pitch = -Math.atan2(velocityY, Math.max(0.01, horizontalSpeed));
    Quaternion.RotationYawPitchRollToRef(yaw, pitch, 0, this.bodyRotation);
    const position = {
      x: agent.previousPosition.x
        + (agent.position.x - agent.previousPosition.x) * alpha - origin.x,
      y: agent.previousPosition.y
        + (agent.position.y - agent.previousPosition.y) * alpha - origin.y,
      z: agent.previousPosition.z
        + (agent.position.z - agent.previousPosition.z) * alpha - origin.z,
    };
    const size = agent.species === "gull" ? 1 : 0.92;
    const bodyBatch = `bird-${agent.species}-body`;
    const wingBatch = `bird-${agent.species}-wing`;
    this.appendPart(
      bodyBatch,
      position,
      this.bodyRotation,
      0,
      0,
      0,
      size,
      size,
      size,
    );
    const phase = interpolateAngle(
      agent.previousAnimationPhase,
      agent.animationPhase,
      alpha,
    );
    const flap = Math.sin(phase) * (agent.lod === "near" ? 0.62 : 0.34);
    // Both shared wing prototypes extend from a shoulder along local +X.
    // Rotate the port copy through PI instead of mirroring its matrix, keeping
    // the determinant positive for PBR normal and shadow evaluation.
    this.appendPart(
      wingBatch,
      position,
      this.bodyRotation,
      -0.1 * size,
      0,
      0,
      size,
      size,
      size,
      0,
      0,
      Math.PI - flap,
    );
    this.appendPart(
      wingBatch,
      position,
      this.bodyRotation,
      0.1 * size,
      0,
      0,
      size,
      size,
      size,
      0,
      0,
      flap,
    );
  }

  private renderGroundAnimal(
    agent: GroundAnimalAgent,
    origin: WildlifeFloatingOrigin,
    alpha: number,
  ): void {
    const heading = interpolateAngle(
      agent.previousHeadingRadians,
      agent.headingRadians,
      alpha,
    );
    Quaternion.RotationYawPitchRollToRef(heading, 0, 0, this.bodyRotation);
    const position = {
      x: agent.previousPosition.x
        + (agent.position.x - agent.previousPosition.x) * alpha - origin.x,
      y: agent.previousPosition.y
        + (agent.position.y - agent.previousPosition.y) * alpha - origin.y,
      z: agent.previousPosition.z
        + (agent.position.z - agent.previousPosition.z) * alpha - origin.z,
    };
    const gaitPhase = interpolateAngle(agent.previousGaitPhase, agent.gaitPhase, alpha);
    if (agent.species === "deer") this.renderDeer(agent, position, gaitPhase);
    else this.renderBoar(agent, position, gaitPhase);
  }

  private renderDeer(
    agent: GroundAnimalAgent,
    position: WildlifeVector3,
    gaitPhase: number,
  ): void {
    const body = "deer-coat";
    this.appendPart(body, position, this.bodyRotation, 0, 0, 0, 1, 1, 1);
    if (agent.lod === "far") return;
    const gait = Math.sin(gaitPhase) * 0.28;
    const legs: readonly [number, number, number, number][] = [
      [-0.28, 0.56, 0.58, gait],
      [0.28, 0.56, 0.58, -gait],
      [-0.28, 0.56, -0.58, -gait],
      [0.28, 0.56, -0.58, gait],
    ];
    for (const [x, y, z, swing] of legs) {
      this.appendPart("deer-leg", position, this.bodyRotation, x, y, z, 1, 1, 1, 0, swing, 0);
    }
    this.appendPart("deer-antler", position, this.bodyRotation, 0, 2.15, 1.04, 1, 1, 1);
  }

  private renderBoar(
    agent: GroundAnimalAgent,
    position: WildlifeVector3,
    gaitPhase: number,
  ): void {
    const body = "boar-hide";
    this.appendPart(body, position, this.bodyRotation, 0, 0, 0, 1, 1, 1);
    if (agent.lod === "far") return;
    const gait = Math.sin(gaitPhase) * 0.18;
    const legs: readonly [number, number, number, number][] = [
      [-0.34, 0.575, 0.54, gait],
      [0.34, 0.575, 0.54, -gait],
      [-0.34, 0.575, -0.54, -gait],
      [0.34, 0.575, -0.54, gait],
    ];
    for (const [x, y, z, swing] of legs) {
      this.appendPart("boar-leg", position, this.bodyRotation, x, y, z, 1, 1, 1, 0, swing, 0);
    }
    this.appendPart("boar-tusk", position, this.bodyRotation, 0, 0.58, 1.3, 1, 1, 1);
  }

  private appendPart(
    key: string,
    basePosition: WildlifeVector3,
    baseRotation: Quaternion,
    offsetX: number,
    offsetY: number,
    offsetZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    localYaw = 0,
    localPitch = 0,
    localRoll = 0,
  ): void {
    const batch = this.batches.get(key);
    if (!batch) throw new Error(`Missing wildlife batch ${key}`);
    this.localOffset.set(offsetX, offsetY, offsetZ);
    this.localOffset.rotateByQuaternionToRef(baseRotation, this.rotatedOffset);
    this.worldPosition.set(
      basePosition.x + this.rotatedOffset.x,
      basePosition.y + this.rotatedOffset.y,
      basePosition.z + this.rotatedOffset.z,
    );
    Quaternion.RotationYawPitchRollToRef(
      localYaw,
      localPitch,
      localRoll,
      this.localRotation,
    );
    baseRotation.multiplyToRef(this.localRotation, this.combinedRotation);
    this.scale.set(scaleX, scaleY, scaleZ);
    Matrix.ComposeToRef(
      this.scale,
      this.combinedRotation,
      this.worldPosition,
      this.matrix,
    );
    batch.matrices.push(...this.matrix.asArray());
  }

  private updateStatistics(
    fixedStepsThisFrame: number,
    neighborQueries: number,
    neighborCandidateChecks: number,
    maxNeighborsObserved: number,
  ): void {
    let birdCount = 0;
    let nearAiAgents = 0;
    let renderedThinInstances = 0;
    let activeBatches = 0;
    for (const agent of this.agents) {
      if (agent.kind === "bird") birdCount += 1;
      if (agent.lod === "near") nearAiAgents += 1;
    }
    for (const batch of this.batches.values()) {
      if (!batch.mesh.isEnabled()) continue;
      renderedThinInstances += batch.mesh.thinInstanceCount;
      activeBatches += 1;
    }
    this.statisticsValue = {
      activeAnimals: this.agents.length,
      birdCount,
      groundAnimalCount: this.agents.length - birdCount,
      nearAiAgents,
      farAiAgents: this.agents.length - nearAiAgents,
      renderedThinInstances,
      activeBatches,
      fixedStepsThisFrame,
      cumulativeFixedSteps: this.clock.cumulativeSteps,
      populationRebuilds: this.populationRebuilds,
      neighborQueries,
      neighborCandidateChecks,
      maxNeighborsObserved,
      droppedSimulationSeconds: this.clock.droppedSeconds,
    };
  }

  private createBatches(): void {
    const gull = this.material("wildlife-gull", new Color3(0.78, 0.8, 0.78), {
      roughness: 0.83,
      surface: "feather",
      sheenIntensity: 0.16,
      translucencyIntensity: 0.025,
    });
    const gullWing = this.material(
      "wildlife-gull-wing",
      new Color3(0.58, 0.62, 0.64),
      {
        roughness: 0.88,
        surface: "feather",
        sheenIntensity: 0.2,
        translucencyIntensity: 0.11,
        doubleSided: true,
      },
    );
    const hawk = this.material("wildlife-hawk", new Color3(0.3, 0.18, 0.08), {
      roughness: 0.9,
      surface: "feather",
      sheenIntensity: 0.14,
      translucencyIntensity: 0.02,
    });
    const hawkWing = this.material(
      "wildlife-hawk-wing",
      new Color3(0.18, 0.095, 0.035),
      {
        roughness: 0.93,
        surface: "feather",
        sheenIntensity: 0.17,
        translucencyIntensity: 0.085,
        doubleSided: true,
      },
    );
    const deer = this.material("wildlife-deer", new Color3(0.43, 0.24, 0.1), {
      roughness: 0.93,
      surface: "fur",
      sheenIntensity: 0.12,
    });
    const deerLeg = this.material("wildlife-deer-leg", new Color3(0.19, 0.095, 0.04), {
      roughness: 0.97,
      surface: "fur",
      sheenIntensity: 0.07,
    });
    const antler = this.material("wildlife-antler", new Color3(0.47, 0.34, 0.2), {
      roughness: 0.9,
      surface: "keratin",
      clearCoatIntensity: 0.035,
    });
    const boar = this.material("wildlife-boar", new Color3(0.13, 0.085, 0.055), {
      roughness: 0.98,
      surface: "fur",
      sheenIntensity: 0.14,
    });
    const boarLeg = this.material("wildlife-boar-leg", new Color3(0.075, 0.055, 0.04), {
      roughness: 1,
      surface: "fur",
      sheenIntensity: 0.06,
    });
    const tusk = this.material("wildlife-tusk", new Color3(0.83, 0.76, 0.59), {
      roughness: 0.58,
      surface: "keratin",
      clearCoatIntensity: 0.16,
    });

    this.registerPrototype("bird-gull-body", gull, true);
    this.registerPrototype("bird-gull-wing", gullWing, true);
    this.registerPrototype("bird-hawk-body", hawk, true);
    this.registerPrototype("bird-hawk-wing", hawkWing, true);
    this.registerPrototype("deer-coat", deer, true);
    this.registerPrototype("deer-leg", deerLeg, true);
    this.registerPrototype("deer-antler", antler, true);
    this.registerPrototype("boar-hide", boar, true);
    this.registerPrototype("boar-leg", boarLeg, true);
    this.registerPrototype("boar-tusk", tusk, true);
  }

  private material(
    name: string,
    color: Color3,
    options: WildlifeMaterialOptions,
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    material.albedoColor = color;
    material.roughness = options.roughness;
    material.metallic = 0;
    material.backFaceCulling = options.doubleSided !== true;
    if (options.sheenIntensity !== undefined) {
      material.sheen.isEnabled = true;
      material.sheen.linkSheenWithAlbedo = true;
      material.sheen.intensity = options.sheenIntensity;
      material.sheen.roughness = Math.min(1, options.roughness + 0.02);
    }
    if (options.translucencyIntensity !== undefined) {
      material.subSurface.isTranslucencyEnabled = true;
      material.subSurface.translucencyIntensity = options.translucencyIntensity;
      material.subSurface.tintColor.copyFrom(color);
    }
    if (options.clearCoatIntensity !== undefined) {
      material.clearCoat.isEnabled = true;
      material.clearCoat.intensity = options.clearCoatIntensity;
      material.clearCoat.roughness = Math.min(0.72, options.roughness);
      material.clearCoat.indexOfRefraction = 1.5;
    }
    material.metadata = {
      wildlifeMaterial: true,
      wildlifeSurface: options.surface,
      wildlifeSurfaceFeatures: options.surface === "feather"
        ? ["barb-sheen", "thin-edge-translucency"]
        : options.surface === "fur"
          ? ["broad-matte-lobe", "grazing-fibre-sheen"]
          : ["dielectric-keratin", "subtle-clearcoat"],
    };
    this.materials.add(material);
    return material;
  }

  private registerPrototype(
    key: WildlifePrototypeKey,
    material: PBRMaterial,
    castsShadows: boolean,
  ): void {
    const prototype = createWildlifePrototypeGeometry(key);
    const positions = [...prototype.positions];
    const indices = [...prototype.indices];
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    const mesh = new Mesh(`wildlife-${key}`, this.scene);
    vertexData.applyToMesh(mesh, false);
    mesh.refreshBoundingInfo();
    mesh.metadata = {
      wildlifePrototype: true,
      wildlifePrototypeKey: key,
      wildlifeSpecies: prototype.species,
      wildlifeSilhouetteFeatures: [...prototype.silhouetteFeatures],
      wildlifePrototypeGeometryBytes: prototype.sourceByteLength + normals.length * 4,
    };
    this.registerBatch(key, mesh, material, castsShadows);
  }

  private registerBatch(
    key: string,
    mesh: Mesh,
    material: PBRMaterial,
    castsShadows: boolean,
  ): void {
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.metadata = {
      ...(mesh.metadata as Record<string, unknown> | null),
      wildlife: true,
      castsShadow: castsShadows,
    };
    const matrixCapacity = MAX_ACTIVE_ANIMALS * 4;
    const matrixData = new Float32Array(matrixCapacity * 16);
    mesh.thinInstanceSetBuffer("matrix", matrixData, 16, false);
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
    this.batches.set(key, {
      mesh,
      matrices: [],
      castsShadows,
      matrixData,
    });
  }
}
