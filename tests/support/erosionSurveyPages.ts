import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  type TerrainMacroEvolutionExport,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import { evolveMacroTerrain, toTerrainMacroEvolutionExport } from "../../src/render/webgpu/terrain/TerrainMacroEvolution";
import { createWorldPageAddress, type WorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { sampleTerrainMacroEvolutionInputs } from "../../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../../src/world";
import type { WorldDefinition } from "../../src/world/types";

/**
 * The pages the breach pit survey of 2026-09-22 measured
 * (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md): the synthetic macro the
 * GPU erosion harness uses, around the page its cost test measures, and a real
 * macro build with an airport, across levels.
 */

/** The GPU erosion harness's synthetic macro (tests/gpu/terrainPageErosionGpuHarness.ts), copied for Node. */
export function erosionMacroFixture(seed: string): TerrainMacroEvolutionExport {
  const heightMeters = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT);
  const flowAccumulationAreaM2 = new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT);
  const edge = EVOLUTION_DOMAIN_TEXELS;
  for (let z = 0; z < edge; z += 1) {
    const worldZ = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + (z + 0.5) * EVOLUTION_TEXEL_METERS;
    for (let x = 0; x < edge; x += 1) {
      const worldX = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + (x + 0.5) * EVOLUTION_TEXEL_METERS;
      const index = z * edge + x;
      const ridge = Math.sin(worldX * 1.7e-5) * Math.cos(worldZ * 1.3e-5);
      const detail = Math.sin(worldX * 9.1e-5 + 1.7) * Math.sin(worldZ * 7.3e-5 - 0.4);
      heightMeters[index] = Math.fround(420 * ridge + 130 * detail + 60);
      flowAccumulationAreaM2[index] = Math.fround(
        EVOLUTION_TEXEL_METERS * EVOLUTION_TEXEL_METERS
        * (1 + 900 * Math.abs(Math.sin(worldX * 4.3e-5) * Math.cos(worldZ * 3.1e-5))),
      );
    }
  }
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: seed, deviceFingerprint: "gpu-page-fixture" },
    seaLevelMeters: 0,
    heightMeters,
    flowAccumulationAreaM2,
    lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(0),
  };
}

/** A real macro evolution for `world`, as the evolution-statistics test builds it (~6-7 s). */
export function evolvedMacro(world: Readonly<WorldDefinition>): TerrainMacroEvolutionExport {
  const inputs = sampleTerrainMacroEvolutionInputs({
    width: EVOLUTION_DOMAIN_TEXELS,
    height: EVOLUTION_DOMAIN_TEXELS,
    minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
    minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seedHash: world.seedHash,
  });
  const result = evolveMacroTerrain({
    width: EVOLUTION_DOMAIN_TEXELS,
    height: EVOLUTION_DOMAIN_TEXELS,
    heights: inputs.heights,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seaLevel: world.seaLevel,
    erodibility: inputs.erodibility,
    reposeDegrees: inputs.reposeDegrees,
  });
  return toTerrainMacroEvolutionExport(result, world.seaLevel, {
    worldSeed: world.seed,
    deviceFingerprint: "breach-pit-survey",
  });
}

export interface SurveyPageSet {
  readonly name: string;
  readonly world: () => Readonly<WorldDefinition>;
  readonly macro: (world: Readonly<WorldDefinition>) => TerrainMacroEvolutionExport;
  readonly pages: readonly WorldPageAddress[];
}

/** The survey's sixteen pages: six on the fixture macro, ten on a real build. */
export const BREACH_SURVEY_PAGE_SETS: readonly SurveyPageSet[] = [
  {
    name: "fixture",
    world: () => createWorld("w1d-page-erosion-gpu", { airport: false, worldEvolution: "eroded" }),
    macro: (world) => erosionMacroFixture(world.seed),
    pages: ([[3, -3, 5], [3, -2, 5], [3, -3, 4], [2, -5, 9], [4, -2, 2], [5, -1, 1]] as const)
      .map(([level, x, z]) => createWorldPageAddress(level, x, z)),
  },
  {
    name: "real",
    world: () => createWorld("breach-pit-survey", { worldEvolution: "eroded" }),
    macro: evolvedMacro,
    pages: ([
      [0, 0, 0], [0, 3, -2], [0, -4, 5], [1, 1, 1], [1, -2, 3], [2, 0, -1], [2, 2, 2], [3, -1, 1], [3, 1, -2], [4, 0, 0],
    ] as const).map(([level, x, z]) => createWorldPageAddress(level, x, z)),
  },
];
