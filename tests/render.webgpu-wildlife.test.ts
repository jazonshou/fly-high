import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
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

describe("WebGPU wildlife pure simulation", () => {
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
