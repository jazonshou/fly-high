import { describe, expect, it } from "vitest";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  TerrainConsumerAuthority,
  terrainConsumerSampleFromAuthority,
} from "../src/render/webgpu/terrain/TerrainConsumerAuthority";
import {
  createWildlifeAgent,
  generateWildlifeCell,
  WildlifeSimulation,
  type GroundAnimalAgent,
  type GroundAnimalSpawn,
} from "../src/render/webgpu/wildlife";
import { TerrainAuthority } from "../src/workers/terrainAuthority";
import {
  createWorld,
  TerrainBiome,
  type TerrainSample,
} from "../src/world";

function analyticForestSample(height = -50): TerrainSample {
  return {
    height,
    normal: { x: 0, y: 1, z: 0 },
    slope: 0,
    moisture: 0.68,
    temperature: 286,
    biome: TerrainBiome.FOREST,
    biomeName: "forest",
    color: { r: 0.2, g: 0.4, b: 0.16 },
    airportInfluence: 0,
    isRunway: false,
  };
}

describe("Phase 5 evolved-height consumers", () => {
  it("selects L0 before macro and derives consumer normals from evolved heights", () => {
    const world = createWorld("consumer-authority", {
      airport: false,
      worldEvolution: "eroded",
    });
    const authority = new TerrainAuthority();
    authority.publishMacro({
      originX: 0,
      originZ: 0,
      texelSizeMeters: 512,
      width: 2,
      height: 2,
      heights: new Float32Array(4).fill(400),
    });
    const sampler = terrainConsumerSampleFromAuthority(
      world,
      () => analyticForestSample(),
      authority,
    );
    expect(sampler(100, 100).height).toBe(400);

    const page = new Float32Array(256 * 256);
    for (let row = 0; row < 256; row += 1) {
      for (let column = 0; column < 256; column += 1) {
        page[row * 256 + column] = 900 + column * 2 + row * 4;
      }
    }
    authority.publishPage(0, 0, 0, page);
    const evolved = sampler(100, 100);
    expect(evolved.height).toBeCloseTo(1_200, 8);
    expect(evolved.normal.x).toBeLessThan(0);
    expect(evolved.normal.z).toBeLessThan(0);
    expect(evolved.slope).toBeGreaterThan(0);
  });

  it("keeps explicit analytic mode on the supplied sampler", () => {
    const world = createWorld("analytic-consumer", {
      airport: false,
      worldEvolution: "analytic",
    });
    const expected = analyticForestSample(123);
    let authorityCalls = 0;
    const supplied = () => expected;
    const sampler = terrainConsumerSampleFromAuthority(world, supplied, {
      sampleHeight: () => {
        authorityCalls += 1;
        return 999;
      },
    });
    expect(sampler).toBe(supplied);
    expect(sampler(5, 7)).toBe(expected);
    expect(authorityCalls).toBe(0);
  });

  it("retains signed shore distance but exposes it only after final L0 height", () => {
    const world = createWorld("shore-consumer-authority", {
      airport: false,
      worldEvolution: "eroded",
    });
    const authority = new TerrainConsumerAuthority();
    authority.publishMacro({
      originX: 0,
      originZ: 0,
      texelSizeMeters: 512,
      width: 2,
      height: 2,
      heights: new Float32Array(4).fill(360),
    });
    const shoreDistanceR16Sint = new Int16Array(136 * 136).fill(-8);
    shoreDistanceR16Sint[4 * 136 + 4] = 0;
    shoreDistanceR16Sint[4 * 136 + 5] = 4;
    shoreDistanceR16Sint[5 * 136 + 4] = 8;
    shoreDistanceR16Sint[5 * 136 + 5] = 12;
    authority.publishAuxPage({
      level: 0,
      tileX: 0,
      tileZ: 0,
      coreSize: 128,
      gutter: 4,
      storedEdge: 136,
      texelSizeMeters: 4,
      shoreDistanceMetersPerUnit: 0.25,
      shoreDistanceR16Sint,
    });
    expect(authority.sampleShoreDistance(100, 100)).toBeNull();

    authority.publishPage(0, 0, 0, new Float32Array(256 * 256).fill(360));
    expect(authority.sampleShoreDistance(100, 100)).toBe(-2);
    // (3 m, 3 m) is halfway between the first four core samples: the decoded
    // 0, 1, 2, 3 metre corners must interpolate to 1.5 m.
    expect(authority.sampleShoreDistance(3, 3)).toBe(1.5);
    const sampler = terrainConsumerSampleFromAuthority(
      world,
      () => analyticForestSample(-120),
      authority,
    );
    expect(sampler(100, 100)).toMatchObject({
      height: 360,
      shoreDistanceMeters: -2,
    });

    // This is the live detail generation path, not a pure density-law test:
    // the decoded authority sample reaches every vegetation scatter pass.
    let exercisedVegetatedCell = false;
    const neutralSampler = terrainConsumerSampleFromAuthority(
      world,
      () => analyticForestSample(-120),
      { sampleHeight: () => 360 },
    );
    for (const cellX of [1, 2]) {
      for (const cellZ of [1, 2]) {
        const options = {
          worldSeed: world.seed,
          cellX,
          cellZ,
          cellSizeMeters: 128,
          densityMultiplier: 1,
          seaLevelMeters: world.seaLevel,
        } as const;
        const neutral = generateDetailCell({ ...options, terrainSample: neutralSampler });
        const neutralVegetation = neutral.trees.length
          + neutral.shrubs.length
          + neutral.clutter.length;
        if (neutralVegetation === 0) continue;
        const wet = generateDetailCell({ ...options, terrainSample: sampler });
        expect(wet.trees).toHaveLength(0);
        expect(wet.shrubs).toHaveLength(0);
        expect(wet.clutter).toHaveLength(0);
        expect(wet.groundCover.every((node) => node.coverage === 0)).toBe(true);
        exercisedVegetatedCell = true;
      }
    }
    expect(exercisedVegetatedCell).toBe(true);
  });

  it("places detail cells and wildlife spawns on supplied evolved height", () => {
    const world = createWorld("evolved-placement", {
      airport: false,
      worldEvolution: "eroded",
    });
    let evolvedHeight = 480;
    const sampler = terrainConsumerSampleFromAuthority(
      world,
      () => analyticForestSample(-120),
      { sampleHeight: () => evolvedHeight },
    );
    const detail = generateDetailCell({
      worldSeed: world.seed,
      cellX: 0,
      cellZ: 0,
      cellSizeMeters: 128,
      densityMultiplier: 1,
      terrainSample: sampler,
      seaLevelMeters: world.seaLevel,
    });
    expect(detail.groundCover).toHaveLength(64);
    expect(detail.groundCover.every((node) => node.heightMeters === evolvedHeight)).toBe(true);
    expect(detail.trees.every((placement) => placement.y === evolvedHeight)).toBe(true);
    expect(detail.shrubs.every((placement) => placement.y === evolvedHeight)).toBe(true);
    expect(detail.clutter.every((placement) => placement.y === evolvedHeight)).toBe(true);

    let groundSpawn: GroundAnimalSpawn | undefined;
    for (let cellX = -12; cellX <= 12 && !groundSpawn; cellX += 1) {
      groundSpawn = generateWildlifeCell({
        worldSeed: world.seed,
        cellX,
        cellZ: 0,
        cellSizeMeters: 800,
        terrainSample: sampler,
      }).groundSpawns[0];
    }
    expect(groundSpawn).toBeDefined();
    expect(groundSpawn?.position.y).toBe(evolvedHeight);
    expect(groundSpawn?.home.y).toBe(evolvedHeight);

    // Live contacts sample again each fixed step; they do not retain spawn Y.
    evolvedHeight = 612;
    const agent = createWildlifeAgent(groundSpawn!) as GroundAnimalAgent;
    new WildlifeSimulation().step(
      [agent],
      {
        observer: { x: 50_000, y: 1_000, z: 50_000 },
        terrainSample: sampler,
      },
      1 / 30,
    );
    expect(agent.position.y).toBe(612);
  });
});
