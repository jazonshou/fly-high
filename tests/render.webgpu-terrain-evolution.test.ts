import { describe, expect, it } from "vitest";
import {
  EROSION_FIXED_ITERATION_COUNTS,
  EROSION_HALO_TEXELS,
  EROSION_MAX_OPERATOR_REACH_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TERRAIN_EROSION_PRODUCTION_CONFIG,
  TerrainErosionCompute,
  createErosionProtectionMask,
  erodeTerrainPage,
  erosionOverlapIsBitExact,
  fingerprintTerrainErosion,
} from "../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  MACRO_EVOLUTION_PRODUCTION_CONFIG,
  TerrainMacroEvolution,
  evolveMacroTerrain,
  fingerprintEvolutionFields,
} from "../src/render/webgpu/terrain/TerrainMacroEvolution";

function enclosedBasin(width = 9, height = 9): Float32Array {
  const field = new Float32Array(width * height);
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = z * width + x;
      if (x === 0 || z === 0 || x === width - 1 || z === height - 1) {
        field[index] = 0;
      } else if (x === 1 || z === 1 || x === width - 2 || z === height - 2) {
        // One deterministic low saddle at the north-west side of the rim.
        field[index] = x === 1 && z === 2 ? 10 : 14;
      } else {
        field[index] = 2 + Math.abs(x - 4) * 0.1 + Math.abs(z - 4) * 0.1;
      }
    }
  }
  return field;
}

function followReceiverToOpenRim(
  start: number,
  receivers: ArrayLike<number>,
  width: number,
  height: number,
): boolean {
  const seen = new Set<number>();
  let index = start;
  while (!seen.has(index)) {
    seen.add(index);
    const x = index % width;
    const z = Math.floor(index / width);
    if (x === 0 || z === 0 || x === width - 1 || z === height - 1) return true;
    const receiver = receivers[index] ?? -1;
    if (receiver < 0) return false;
    index = receiver;
  }
  return false;
}

function fixturePage(
  coreSize: number,
  haloTexels: number,
  originX: number,
  originZ: number,
): { heights: Float32Array; parentFlowAccumulation: Float32Array } {
  const edge = coreSize + haloTexels * 2;
  const heights = new Float32Array(edge * edge);
  const parentFlowAccumulation = new Float32Array(edge * edge);
  for (let z = 0; z < edge; z += 1) {
    for (let x = 0; x < edge; x += 1) {
      const worldX = originX + x - haloTexels;
      const worldZ = originZ + z - haloTexels;
      const index = z * edge + x;
      // A globally evaluated, gently sloping field. Talus is deliberately
      // inactive, while stream power remains live for the seam test.
      heights[index] = Math.fround(800 - worldX * 0.08 - worldZ * 0.03);
      parentFlowAccumulation[index] = Math.fround(
        64 + ((worldX * 13 + worldZ * 7) & 15) * 0.125,
      );
    }
  }
  return { heights, parentFlowAccumulation };
}

describe("Phase 5 deterministic landscape evolution", () => {
  it("priority-fills an enclosed basin and exports a legal open-rim drainage graph", () => {
    const width = 9;
    const height = 9;
    const result = evolveMacroTerrain({
      width,
      height,
      texelSizeMeters: 10,
      seaLevel: -20,
      heights: enclosedBasin(width, height),
      config: {
        streamPowerIterations: 0,
        streamPowerCoefficient: 0,
        talusIterations: 0,
        minimumLakeDepthMeters: 0.001,
        channelInitiationAreaTexels: 2,
      },
    });

    expect(result.lakes.length).toBeGreaterThan(0);
    for (const lake of result.lakes) {
      expect(lake.spillElevationMeters).toBe(result.filledHeight[lake.outletIndex]);
      expect(lake.maxDepthMeters).toBeGreaterThan(0);
      if (lake.outletReceiverIndex >= 0) {
        expect(result.lakeMask[lake.outletReceiverIndex]).not.toBe(lake.id);
      }
    }
    for (let index = 0; index < width * height; index += 1) {
      expect(followReceiverToOpenRim(index, result.receivers, width, height), `${index}`)
        .toBe(true);
      const receiver = result.receivers[index]!;
      if (receiver >= 0) {
        expect(result.filledHeight[receiver]!, `${index} -> ${receiver}`)
          .toBeLessThan(result.filledHeight[index]!);
      }
    }
    expect(result.baseLevels.length).toBeGreaterThan(0);
    expect(result.channelSeeds.length).toBeGreaterThan(0);
  });

  it("regenerates macro and page fields bit-for-bit", () => {
    const macro = new TerrainMacroEvolution({
      streamPowerIterations: 3,
      talusIterations: 3,
      channelInitiationAreaTexels: 3,
    });
    const input = {
      width: 9,
      height: 9,
      texelSizeMeters: 8,
      seaLevel: -20,
      heights: enclosedBasin(),
    } as const;
    const firstMacro = macro.evolve(input);
    const secondMacro = macro.evolve(input);
    const macroFields = (result: typeof firstMacro) => [
      result.evolvedHeight,
      result.filledHeight,
      result.receivers,
      result.flowAccumulation,
      result.lakeDepth,
      result.lakeMask,
      result.basinIds,
      result.channelSeeds,
    ] as const;
    expect(fingerprintEvolutionFields(macroFields(firstMacro)))
      .toBe(fingerprintEvolutionFields(macroFields(secondMacro)));
    expect(Array.from(firstMacro.evolvedHeight)).toEqual(Array.from(secondMacro.evolvedHeight));

    const coreSize = 8;
    const haloTexels = 4;
    const pageFixture = fixturePage(coreSize, haloTexels, 73, -21);
    const page = new TerrainErosionCompute({
      pitBreachRadiusTexels: 2,
      streamPowerIterations: 3,
      talusIterations: 4,
    });
    const firstPage = page.erode({
      coreSize,
      haloTexels,
      texelSizeMeters: 2,
      ...pageFixture,
    });
    const secondPage = page.erode({
      coreSize,
      haloTexels,
      texelSizeMeters: 2,
      ...pageFixture,
    });
    expect(fingerprintTerrainErosion(firstPage)).toBe(fingerprintTerrainErosion(secondPage));
    expect(Array.from(firstPage.evolvedHeight)).toEqual(Array.from(secondPage.evolvedHeight));
  });

  it("is bit-identical over adjacent stored overlaps with the production halo", () => {
    const coreSize = 8;
    const left = fixturePage(coreSize, EROSION_HALO_TEXELS, 0, 0);
    const right = fixturePage(coreSize, EROSION_HALO_TEXELS, coreSize, 0);
    const below = fixturePage(coreSize, EROSION_HALO_TEXELS, 0, coreSize);
    const first = erodeTerrainPage({
      coreSize,
      texelSizeMeters: 2,
      ...left,
    });
    const second = erodeTerrainPage({
      coreSize,
      texelSizeMeters: 2,
      ...right,
    });
    const third = erodeTerrainPage({
      coreSize,
      texelSizeMeters: 2,
      ...below,
    });
    expect(erosionOverlapIsBitExact(first, second, "horizontal")).toBe(true);
    expect(erosionOverlapIsBitExact(first, third, "vertical")).toBe(true);
  });

  it("keeps iteration/halo configuration world-constant and tier-independent", () => {
    expect(EROSION_HALO_TEXELS).toBe(64);
    expect(EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS).toBe(384);
    expect(EROSION_MAX_OPERATOR_REACH_TEXELS).toBeLessThan(EROSION_HALO_TEXELS);
    expect(EROSION_FIXED_ITERATION_COUNTS).toEqual({
      pitBreachRadiusTexels: 16,
      streamPower: 24,
      talus: 32,
    });
    expect(Object.keys(TERRAIN_EROSION_PRODUCTION_CONFIG)).not.toContain("tier");
    expect(Object.keys(MACRO_EVOLUTION_PRODUCTION_CONFIG)).not.toContain("tier");
    expect(Object.isFrozen(TERRAIN_EROSION_PRODUCTION_CONFIG)).toBe(true);
    expect(Object.isFrozen(MACRO_EVOLUTION_PRODUCTION_CONFIG)).toBe(true);
  });

  it("protects runway earthworks exactly and accepts a perimeter-drain receiver hook", () => {
    const coreSize = 6;
    const haloTexels = 2;
    const edge = coreSize + haloTexels * 2;
    const source = new Float32Array(edge * edge);
    for (let z = 0; z < edge; z += 1) {
      for (let x = 0; x < edge; x += 1) {
        source[z * edge + x] = 120 - x * 2.5 + (z === 5 ? 7 : 0);
      }
    }
    const mask = createErosionProtectionMask({
      edge,
      worldOriginX: -5,
      worldOriginZ: -5,
      texelSizeMeters: 1,
      sourceHeight: source,
      sample: (worldX, worldZ) => Math.abs(worldX) <= 1 && Math.abs(worldZ) <= 1,
    });
    const overrideSource = 2 * edge + 2;
    const overrideTarget = overrideSource + 1;
    const overrides = new Int32Array(edge * edge);
    overrides.fill(-1);
    overrides[overrideSource] = overrideTarget;
    const result = erodeTerrainPage({
      coreSize,
      haloTexels,
      texelSizeMeters: 1,
      heights: source,
      erosionMask: mask,
      receiverOverrides: overrides,
      config: {
        pitBreachRadiusTexels: 1,
        streamPowerIterations: 2,
        streamPowerCoefficient: 0.2,
        talusIterations: 2,
        defaultReposeDegrees: 10,
      },
    });

    let unprotectedChangeCount = 0;
    for (let index = 0; index < source.length; index += 1) {
      if (mask[index]) {
        expect(result.evolvedHeight[index], `protected ${index}`).toBe(source[index]);
      } else if (result.evolvedHeight[index] !== source[index]) {
        unprotectedChangeCount += 1;
      }
      if (!mask[index] && result.receivers[index]! >= 0) {
        expect(mask[result.receivers[index]!], `receiver from ${index} enters earthworks`).toBe(0);
      }
    }
    expect(unprotectedChangeCount).toBeGreaterThan(0);
    expect(result.receivers[overrideSource]).toBe(overrideTarget);
  });
});
