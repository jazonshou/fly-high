import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  FixedStepClock,
  SpatialHash3D,
  WildlifeSimulation,
  WildlifeSystem,
  createWildlifeAgent,
  generateWildlifeCell,
  selectActiveWildlife,
} from "../src/render/webgpu/wildlife";
import type {
  BirdAgent,
  GeneratedWildlifeCell,
  WildlifeTerrainSampler,
  WildlifeVector3,
} from "../src/render/webgpu/wildlife";
import {
  WILDLIFE_PROTOTYPE_KEYS,
  WILDLIFE_SILHOUETTE_CONTRACT,
  createWildlifePrototypeGeometry,
} from "../src/render/webgpu/wildlife/appearance";
import { TerrainBiome } from "../src/world";

const forestTerrain: WildlifeTerrainSampler = (x, z) => ({
  height: 112 + Math.sin(x * 0.002) * 4 + Math.cos(z * 0.0017) * 3,
  slope: 0.07,
  biome: TerrainBiome.FOREST,
});

function generatedNeighborhood(seed: string): GeneratedWildlifeCell[] {
  const cells: GeneratedWildlifeCell[] = [];
  for (let cellZ = -2; cellZ <= 2; cellZ += 1) {
    for (let cellX = -2; cellX <= 2; cellX += 1) {
      cells.push(generateWildlifeCell({
        worldSeed: seed,
        cellX,
        cellZ,
        cellSizeMeters: 500,
        terrainSample: forestTerrain,
      }));
    }
  }
  return cells;
}

function geometryBounds(positions: readonly number[]) {
  const bounds = {
    minimumX: Number.POSITIVE_INFINITY,
    minimumY: Number.POSITIVE_INFINITY,
    minimumZ: Number.POSITIVE_INFINITY,
    maximumX: Number.NEGATIVE_INFINITY,
    maximumY: Number.NEGATIVE_INFINITY,
    maximumZ: Number.NEGATIVE_INFINITY,
  };
  for (let index = 0; index < positions.length; index += 3) {
    bounds.minimumX = Math.min(bounds.minimumX, positions[index]!);
    bounds.minimumY = Math.min(bounds.minimumY, positions[index + 1]!);
    bounds.minimumZ = Math.min(bounds.minimumZ, positions[index + 2]!);
    bounds.maximumX = Math.max(bounds.maximumX, positions[index]!);
    bounds.maximumY = Math.max(bounds.maximumY, positions[index + 1]!);
    bounds.maximumZ = Math.max(bounds.maximumZ, positions[index + 2]!);
  }
  return bounds;
}

function signedVolume(
  positions: readonly number[],
  indices: readonly number[],
): number {
  let sixTimesVolume = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3;
    const b = indices[index + 1]! * 3;
    const c = indices[index + 2]! * 3;
    const ax = positions[a]!;
    const ay = positions[a + 1]!;
    const az = positions[a + 2]!;
    const bx = positions[b]!;
    const by = positions[b + 1]!;
    const bz = positions[b + 2]!;
    const cx = positions[c]!;
    const cy = positions[c + 1]!;
    const cz = positions[c + 2]!;
    sixTimesVolume += ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx);
  }
  return sixTimesVolume / 6;
}

describe("WebGPU wildlife pure simulation", () => {
  it("builds pairwise diagnostic procedural silhouettes rather than unit primitives", () => {
    const geometry = new Map(
      WILDLIFE_PROTOTYPE_KEYS.map((key) => [key, createWildlifePrototypeGeometry(key)]),
    );
    for (const [key, prototype] of geometry) {
      expect(prototype.positions.length, key).toBeGreaterThan(24);
      expect(prototype.indices.length, key).toBeGreaterThan(18);
      expect(prototype.indices.length % 3, key).toBe(0);
      expect(prototype.sourceByteLength, key).toBeGreaterThan(0);
      expect(prototype.silhouetteFeatures).toEqual(
        WILDLIFE_SILHOUETTE_CONTRACT[prototype.species].features,
      );
      // Babylon's right-handed front-face/normal convention is clockwise.
      // Every closed anatomical component is authored consistently, so its
      // aggregate signed volume must have the corresponding negative sign.
      expect(signedVolume(prototype.positions, prototype.indices), key).toBeLessThan(0);
    }

    // Pin the visually dominant surfaces too: signed volume catches winding,
    // while these generated normals prove the coat/wing exterior is lit from
    // the outside rather than from inside the animal.
    for (const key of [
      "bird-gull-body",
      "bird-gull-wing",
      "bird-hawk-body",
      "bird-hawk-wing",
      "deer-coat",
      "boar-hide",
    ] as const) {
      const prototype = geometry.get(key)!;
      const normals: number[] = [];
      VertexData.ComputeNormals(prototype.positions, prototype.indices, normals);
      expect(normals[1], key).toBeGreaterThan(0.2);
    }

    const gullWing = geometryBounds(geometry.get("bird-gull-wing")!.positions);
    const hawkWing = geometryBounds(geometry.get("bird-hawk-wing")!.positions);
    const gullAspect = (gullWing.maximumX - gullWing.minimumX)
      / (gullWing.maximumZ - gullWing.minimumZ);
    const hawkAspect = (hawkWing.maximumX - hawkWing.minimumX)
      / (hawkWing.maximumZ - hawkWing.minimumZ);
    expect(gullAspect).toBeGreaterThan(hawkAspect * 1.5);

    const deer = geometryBounds(geometry.get("deer-coat")!.positions);
    const boar = geometryBounds(geometry.get("boar-hide")!.positions);
    const deerHeight = deer.maximumY - deer.minimumY;
    const boarHeight = boar.maximumY - boar.minimumY;
    const deerLength = deer.maximumZ - deer.minimumZ;
    const boarLength = boar.maximumZ - boar.minimumZ;
    expect(deerHeight).toBeGreaterThan(boarHeight * 1.25);
    expect(boarLength / boarHeight).toBeGreaterThan(deerLength / deerHeight * 1.2);

    const antlers = geometryBounds(geometry.get("deer-antler")!.positions);
    expect(antlers.minimumX).toBeLessThan(-0.45);
    expect(antlers.maximumX).toBeGreaterThan(0.45);
    expect(antlers.maximumY).toBeGreaterThan(0.7);
    const tusks = geometryBounds(geometry.get("boar-tusk")!.positions);
    expect(tusks.minimumX).toBeLessThan(-0.3);
    expect(tusks.maximumX).toBeGreaterThan(0.3);
    expect(tusks.maximumY - tusks.minimumY).toBeGreaterThan(0.2);

    const featureSignatures = Object.values(WILDLIFE_SILHOUETTE_CONTRACT)
      .map((contract) => [...contract.features].sort().join(":"));
    expect(new Set(featureSignatures).size).toBe(featureSignatures.length);
  });

  it("generates deterministic flocks and sparse habitat-aware ground animals", () => {
    const first = generatedNeighborhood("wildlife-seed-a");
    const repeated = generatedNeighborhood("wildlife-seed-a");
    const changed = generatedNeighborhood("wildlife-seed-b");

    expect(repeated).toEqual(first);
    expect(changed).not.toEqual(first);
    const birdCount = first.reduce((sum, cell) => sum + cell.birdSpawns.length, 0);
    const groundCount = first.reduce((sum, cell) => sum + cell.groundSpawns.length, 0);
    expect(birdCount).toBeGreaterThan(100);
    expect(groundCount).toBeGreaterThan(0);
    expect(groundCount).toBeLessThan(birdCount / 2);
    for (const cell of first) {
      const minimumX = cell.cellX * cell.cellSizeMeters;
      const minimumZ = cell.cellZ * cell.cellSizeMeters;
      for (const ground of cell.groundSpawns) {
        expect(ground.position.x).toBeGreaterThanOrEqual(minimumX);
        expect(ground.position.x).toBeLessThan(minimumX + cell.cellSizeMeters);
        expect(ground.position.z).toBeGreaterThanOrEqual(minimumZ);
        expect(ground.position.z).toBeLessThan(minimumZ + cell.cellSizeMeters);
      }
    }

    const water = generateWildlifeCell({
      worldSeed: "water-cell",
      cellX: 0,
      cellZ: 0,
      terrainSample: () => ({ height: 0, slope: 0, biome: TerrainBiome.WATER }),
    });
    expect(water.groundSpawns).toEqual([]);
    expect(new Set(water.birdSpawns.map((spawn) => spawn.species))).toEqual(new Set(["gull"]));
  });

  it("enforces the active-animal budget with a deterministic ground-life reserve", () => {
    const cells = generatedNeighborhood("budgeted-wildlife");
    const observer = { x: 0, y: 180, z: 0 };
    const selected = selectActiveWildlife(cells, observer, 16);
    expect(selected).toHaveLength(16);
    expect(selectActiveWildlife(cells, observer, 16)).toEqual(selected);
    expect(selected.some((spawn) => spawn.kind === "ground")).toBe(true);
    expect(selectActiveWildlife(cells, observer, 0)).toEqual([]);
  });

  it("bounds spatial-hash work independently of a large remote population", () => {
    const points: WildlifeVector3[] = [
      { x: 0, y: 100, z: 0 },
      { x: 2, y: 101, z: 1 },
      { x: -3, y: 99, z: 2 },
      { x: 4, y: 100, z: -2 },
    ];
    for (let index = 0; index < 10_000; index += 1) {
      points.push({ x: 10_000 + index * 90, y: 100, z: 10_000 });
    }
    const hash = new SpatialHash3D(16);
    hash.rebuild(points);
    const query = hash.query(points[0]!, 12, 8, 0, 32);

    expect(query.indices).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(query.candidateChecks).toBeLessThanOrEqual(32);
    expect(query.candidateChecks).toBeLessThan(points.length / 100);
    expect(hash.size).toBe(points.length);
    expect(hash.occupiedCellCount).toBeGreaterThan(9_000);
  });

  it("keeps fixed-step flock motion deterministic, finite, and neighbor-capped", () => {
    const spawns = generatedNeighborhood("flock-simulation")
      .flatMap((cell) => cell.birdSpawns)
      .slice(0, 64);
    const first = spawns.map((spawn) => createWildlifeAgent(spawn) as BirdAgent);
    const second = spawns.map((spawn) => createWildlifeAgent(spawn) as BirdAgent);
    const firstSimulation = new WildlifeSimulation();
    const secondSimulation = new WildlifeSimulation();
    const context = {
      observer: { x: 50_000, y: 2_000, z: 50_000 },
      terrainSample: forestTerrain,
    };
    for (let step = 0; step < 40; step += 1) {
      const firstStats = firstSimulation.step(first, context, 1 / 30);
      const secondStats = secondSimulation.step(second, context, 1 / 30);
      expect(secondStats).toEqual(firstStats);
      expect(firstStats.maxNeighborsObserved).toBeLessThanOrEqual(24);
      expect(firstStats.neighborCandidateChecks).toBeLessThanOrEqual(
        firstStats.neighborQueries * 96,
      );
    }
    expect(second).toEqual(first);
    for (const bird of first) {
      expect(Object.values(bird.position).every(Number.isFinite)).toBe(true);
      expect(Object.values(bird.velocity).every(Number.isFinite)).toBe(true);
      const speed = Math.hypot(bird.velocity.x, bird.velocity.y, bird.velocity.z);
      expect(speed).toBeGreaterThanOrEqual(8 - 1e-8);
      expect(speed).toBeLessThanOrEqual(29 + 1e-8);
    }
  });

  it("advances equal elapsed time identically and drops runaway backlog", () => {
    const fine = new FixedStepClock();
    const coarse = new FixedStepClock();
    let fineSteps = 0;
    let coarseSteps = 0;
    for (let index = 0; index < 10; index += 1) {
      fine.advance(1 / 60, () => { fineSteps += 1; });
    }
    for (let index = 0; index < 5; index += 1) {
      coarse.advance(1 / 30, () => { coarseSteps += 1; });
    }
    expect(fineSteps).toBe(5);
    expect(coarseSteps).toBe(fineSteps);
    expect(fine.cumulativeSteps).toBe(coarse.cumulativeSteps);

    const overloaded = new FixedStepClock();
    const result = overloaded.advance(1, () => undefined);
    expect(result.steps).toBe(6);
    expect(overloaded.droppedSeconds).toBeGreaterThan(0.7);
    expect(result.interpolationAlpha).toBeGreaterThanOrEqual(0);
    expect(result.interpolationAlpha).toBeLessThan(1);
  });
});

describe("Babylon wildlife presentation", () => {
  it("keeps ten shared prototypes and assigns feather, fur, and keratin PBR character", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const system = new WildlifeSystem(scene, {
      worldSeed: "wildlife-appearance",
      terrainSample: forestTerrain,
      cellSizeMeters: 500,
      activeRadiusMeters: 1_000,
    });

    const prototypes = scene.meshes.filter((mesh) => mesh.metadata?.wildlife === true) as Mesh[];
    expect(prototypes).toHaveLength(WILDLIFE_PROTOTYPE_KEYS.length);
    expect(new Set(prototypes.map((mesh) => mesh.metadata?.wildlifePrototypeKey))).toEqual(
      new Set(WILDLIFE_PROTOTYPE_KEYS),
    );
    for (const prototype of prototypes) {
      expect(prototype.metadata?.wildlifePrototype).toBe(true);
      expect(prototype.metadata?.castsShadow).toBe(true);
      expect(prototype.getTotalVertices()).toBeGreaterThan(8);
      expect(prototype.getTotalIndices()).toBeGreaterThan(12);
      expect(prototype.thinInstanceCount).toBe(0);
    }
    const geometryBytes = prototypes.reduce(
      (sum, mesh) => sum + Number(mesh.metadata?.wildlifePrototypeGeometryBytes ?? 0),
      0,
    );
    expect(geometryBytes).toBeGreaterThan(0);
    expect(geometryBytes).toBeLessThan(256 * 1_024);

    const materials = scene.materials.filter(
      (material) => material.metadata?.wildlifeMaterial === true,
    ) as PBRMaterial[];
    expect(materials).toHaveLength(10);
    expect(new Set(materials.map((material) => material.metadata?.wildlifeSurface))).toEqual(
      new Set(["feather", "fur", "keratin"]),
    );
    const gullWing = scene.getMaterialByName("wildlife-gull-wing") as PBRMaterial;
    expect(gullWing.sheen.isEnabled).toBe(true);
    expect(gullWing.subSurface.isTranslucencyEnabled).toBe(true);
    expect(gullWing.backFaceCulling).toBe(false);
    const deer = scene.getMaterialByName("wildlife-deer") as PBRMaterial;
    expect(deer.sheen.isEnabled).toBe(true);
    expect(deer.roughness).toBeGreaterThanOrEqual(0.9);
    const tusk = scene.getMaterialByName("wildlife-tusk") as PBRMaterial;
    expect(tusk.clearCoat.isEnabled).toBe(true);
    expect(tusk.clearCoat.intensity).toBeGreaterThan(0.1);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("honors the profile budget, exposes shadow batches, rebases, and disposes", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const system = new WildlifeSystem(scene, {
      worldSeed: "null-engine-wildlife",
      terrainSample: forestTerrain,
      cellSizeMeters: 500,
      activeRadiusMeters: 1_000,
    });
    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      activeAnimalBudget: 12,
    };
    system.update(
      { x: 0, y: 180, z: 0, velocityX: 32 },
      { x: 0, y: 0, z: 0 },
      profile,
      1 / 30,
    );

    expect(system.statistics.activeAnimals).toBe(12);
    expect(system.statistics.fixedStepsThisFrame).toBe(1);
    expect(system.statistics.renderedThinInstances).toBeGreaterThan(12);
    expect(system.statistics.activeBatches).toBeGreaterThan(0);
    expect(system.statistics.neighborCandidateChecks).toBeLessThanOrEqual(
      system.statistics.neighborQueries * 96,
    );
    const sharedPrototypes = scene.meshes.filter(
      (mesh) => mesh.metadata?.wildlife === true,
    ) as Mesh[];
    expect(sharedPrototypes).toHaveLength(WILDLIFE_PROTOTYPE_KEYS.length);
    expect(
      sharedPrototypes.reduce((sum, mesh) => sum + mesh.thinInstanceCount, 0),
    ).toBe(system.statistics.renderedThinInstances);
    expect(sharedPrototypes.some((mesh) => mesh.thinInstanceCount > 1)).toBe(true);
    const shadowCasters: string[] = [];
    system.addShadowCasters((mesh) => shadowCasters.push(mesh.name));
    expect(shadowCasters.length).toBeGreaterThan(0);
    expect(new Set(shadowCasters).size).toBe(shadowCasters.length);
    const populatedMesh = scene.meshes.find(
      (mesh) => mesh.metadata?.wildlife === true && (mesh as Mesh).thinInstanceCount > 0,
    ) as Mesh | undefined;
    expect(populatedMesh).toBeDefined();
    const beforeRebase = populatedMesh?.thinInstanceGetWorldMatrices()[0]?.getTranslation();

    system.update(
      { x: 0, y: 180, z: 0 },
      { x: 4_000, y: 100, z: -3_000 },
      profile,
      0,
    );
    expect(system.statistics.activeAnimals).toBe(12);
    const afterRebase = populatedMesh?.thinInstanceGetWorldMatrices()[0]?.getTranslation();
    expect(afterRebase?.x).toBeCloseTo((beforeRebase?.x ?? 0) - 4_000, 3);
    expect(afterRebase?.y).toBeCloseTo((beforeRebase?.y ?? 0) - 100, 3);
    expect(afterRebase?.z).toBeCloseTo((beforeRebase?.z ?? 0) + 3_000, 3);

    system.update(
      { x: 0, y: 180, z: 0 },
      { x: 0, y: 0, z: 0 },
      { ...profile, activeAnimalBudget: 0 },
      0,
    );
    expect(system.statistics.activeAnimals).toBe(0);
    const emptyCasters: string[] = [];
    system.addShadowCasters((mesh) => emptyCasters.push(mesh.name));
    expect(emptyCasters).toEqual([]);

    system.dispose();
    system.dispose();
    expect(system.statistics).toMatchObject({ activeAnimals: 0, activeBatches: 0 });
    expect(scene.meshes.some((mesh) => mesh.metadata?.wildlife === true)).toBe(false);
    scene.dispose();
    engine.dispose();
  });
});
