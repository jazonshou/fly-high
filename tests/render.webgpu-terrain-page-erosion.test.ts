import { describe, expect, it } from "vitest";
import {
  buildTerrainErodedPage,
  buildTerrainPerimeterDrainReceiverOverrides,
  extractTerrainErodedCollisionCore,
  isTerrainErosionProtected,
  sampleTerrainErosionSourceHeight,
  sampleTerrainMacroEvolution,
} from "../src/render/webgpu/terrain/TerrainPageErosion";
import { TerrainPageErosionClient } from "../src/render/webgpu/terrain/TerrainPageErosionClient";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import { createWorldPageAddress } from "../src/render/webgpu/world/pageKey";
import {
  createWorld,
  sampleFilteredTerrainHeight,
  sampleFilteredTerrainUpliftHeight,
} from "../src/world";
import { terrainErosionWorkerTransferables } from "../src/workers/terrainErosionProtocol";

function macroFixture(seed: string): TerrainMacroEvolutionExport {
  const heightMeters = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT);
  const flowAccumulationAreaM2 = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT);
  flowAccumulationAreaM2.fill(262_144);
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: seed, deviceFingerprint: "node-fixture" },
    seaLevelMeters: 0,
    heightMeters,
    flowAccumulationAreaM2,
    lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(0),
  };
}

describe("runtime terrain page erosion (5D)", () => {
  it("sources eroded pages from uplift rather than the analytic carve proxies", () => {
    const world = createWorld("uplift-page-source", {
      airport: false,
      worldEvolution: "eroded",
    });
    const address = createWorldPageAddress(0, 3, -2);
    const worldX = 1_723.5;
    const worldZ = -941.25;
    const source = sampleTerrainErosionSourceHeight(world, address, worldX, worldZ);
    expect(source).toBe(Math.fround(
      sampleFilteredTerrainUpliftHeight(world, worldX, worldZ, 0),
    ));
    expect(source).not.toBe(Math.fround(
      sampleFilteredTerrainHeight(world, worldX, worldZ, 0),
    ));
  });

  it("bilinearly samples the canonical cell-centred macro authority", () => {
    const macro = macroFixture("macro-sample");
    const topLeft = 511 * EVOLUTION_DOMAIN_TEXELS + 511;
    macro.heightMeters[topLeft] = 10;
    macro.heightMeters[topLeft + 1] = 20;
    macro.heightMeters[topLeft + EVOLUTION_DOMAIN_TEXELS] = 30;
    macro.heightMeters[topLeft + EVOLUTION_DOMAIN_TEXELS + 1] = 40;

    expect(sampleTerrainMacroEvolution(macro, 0, 0).heightMeters).toBe(25);
  });

  it("produces deterministic stored bytes, measured stats, and an exact protected mask", () => {
    const coreSize = 8;
    const haloTexels = 5;
    const edge = coreSize + haloTexels * 2;
    const sourceHeight = new Float32Array(edge * edge);
    const erosionMask = new Uint8Array(edge * edge);
    for (let row = 0; row < edge; row += 1) {
      for (let column = 0; column < edge; column += 1) {
        const index = row * edge + column;
        sourceHeight[index] = Math.fround(
          300 - column * 0.7 - row * 0.35 + ((column * 7 + row * 11) % 5) * 0.2,
        );
        if (column >= 7 && column <= 9 && row >= 7 && row <= 9) erosionMask[index] = 1;
      }
    }
    const input = {
      address: createWorldPageAddress(0, 0, 0),
      coreSize,
      haloTexels,
      texelSizeMeters: 2,
      sourceHeight,
      erosionMask,
      config: {
        pitBreachRadiusTexels: 2,
        streamPowerIterations: 2,
        talusIterations: 2,
      },
    } as const;
    const first = buildTerrainErodedPage(input);
    const second = buildTerrainErodedPage(input);

    expect(first.scratchEdge).toBe(18);
    expect(first.storedEdge).toBe(16);
    expect(first.storedHeight).toEqual(second.storedHeight);
    expect(first.stats).toEqual(second.stats);
    expect(first.stats.minHeightMeters).toBeLessThan(first.stats.maxHeightMeters);
    expect(first.stats.maxDeviationFromParent).toBeGreaterThan(0);
    expect(first.protectedSampleCount).toBe(9);

    let changedStoredSamples = 0;
    for (let row = -4; row < coreSize + 4; row += 1) {
      for (let column = -4; column < coreSize + 4; column += 1) {
        const sourceIndex = (row + haloTexels) * edge + column + haloTexels;
        const storedIndex = (row + 4) * first.storedEdge + column + 4;
        if (first.storedHeight[storedIndex] !== sourceHeight[sourceIndex]) {
          changedStoredSamples += 1;
        }
      }
    }
    expect(changedStoredSamples).toBeGreaterThan(0);

    const collisionCore = extractTerrainErodedCollisionCore(first);
    expect(collisionCore).toHaveLength(coreSize * coreSize);
    // The protected centre is copied through Float32 bit-for-bit.
    const sourceProtected = 8 * edge + 8;
    const coreProtected = (8 - haloTexels) * coreSize + (8 - haloTexels);
    expect(collisionCore[coreProtected]).toBe(sourceHeight[sourceProtected]);
    expect(first.storedHeight.some((height, index) => height !== second.storedHeight[index]))
      .toBe(false);
  });

  it("protects the complete authored airport earthworks footprint", () => {
    const world = createWorld("erosion-airport", {
      worldEvolution: "eroded",
      airport: {
        centerX: 0,
        centerZ: 0,
        headingRadians: 0,
      },
    });
    const airport = world.airport!;
    expect(isTerrainErosionProtected(world, 0, 0)).toBe(true);
    expect(isTerrainErosionProtected(
      world,
      airport.runwayWidth + airport.terrainBlendDistance + 10,
      0,
    )).toBe(false);
  });

  it("routes the production perimeter ditch through adjacent downhill cells without cycles", () => {
    const edge = 9;
    const mask = new Uint8Array(edge * edge);
    const heights = new Float32Array(edge * edge);
    for (let z = 0; z < edge; z += 1) {
      for (let x = 0; x < edge; x += 1) {
        const index = z * edge + x;
        heights[index] = 200 - x * 2 - z * 0.25;
        if (x >= 3 && x <= 5 && z >= 3 && z <= 5) mask[index] = 1;
      }
    }
    const overrides = buildTerrainPerimeterDrainReceiverOverrides(mask, heights, edge);
    const routed = [...overrides.entries()].filter(([, receiver]) => receiver >= 0);
    expect(routed.length).toBeGreaterThan(0);
    for (const [source, receiver] of routed) {
      expect(mask[source]).toBe(0);
      expect(mask[receiver]).toBe(0);
      const sourceX = source % edge;
      const sourceZ = Math.floor(source / edge);
      const receiverX = receiver % edge;
      const receiverZ = Math.floor(receiver / edge);
      expect(Math.abs(receiverX - sourceX)).toBeLessThanOrEqual(1);
      expect(Math.abs(receiverZ - sourceZ)).toBeLessThanOrEqual(1);
      expect(heights[receiver]).toBeLessThan(heights[source]!);
      // Strict descent is the acyclicity proof; walk it as a regression gate.
      const visited = new Set<number>([source]);
      let cursor = receiver;
      while (cursor >= 0) {
        expect(visited.has(cursor)).toBe(false);
        visited.add(cursor);
        cursor = overrides[cursor]!;
      }
    }
  });

  it("requires macro authority before scheduling and transfers final page ownership", async () => {
    const world = createWorld("erosion-client", {
      airport: false,
      worldEvolution: "eroded",
    });
    const macro = macroFixture(world.seed);
    const address = createWorldPageAddress(0, 2, -3);
    let inlineCalls = 0;
    const page = buildTerrainErodedPage({
      address,
      coreSize: 8,
      haloTexels: 5,
      texelSizeMeters: 2,
      sourceHeight: new Float32Array(18 * 18).fill(25),
      config: {
        pitBreachRadiusTexels: 0,
        streamPowerIterations: 0,
        talusIterations: 0,
      },
    });
    const client = new TerrainPageErosionClient(world, {
      inlineGenerate: (_world, suppliedMacro, suppliedAddress) => {
        inlineCalls += 1;
        expect(suppliedMacro).toBe(macro);
        expect(suppliedAddress).toEqual(address);
        return page;
      },
    });
    await expect(client.generate(address)).rejects.toThrow(/macro evolution/i);
    client.setMacroEvolution(macro);
    await expect(client.generate(address)).resolves.toBe(page);
    expect(inlineCalls).toBe(1);

    const event = { type: "page", requestId: 1, page } as const;
    expect(terrainErosionWorkerTransferables(event)).toEqual([page.storedHeight.buffer]);
    client.dispose();
  });
});
