import type { TerrainEvolutionProvenance, TerrainMacroEvolutionExport } from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  MACRO_EVOLUTION_PRODUCTION_CONFIG,
  computeMfdFlowAccumulation,
  finishMacroEvolutionFromEvolvedHeight,
  priorityFloodOpenRim,
  toTerrainMacroEvolutionExport,
} from "@/src/render/webgpu/terrain/TerrainMacroEvolution";
import type { TerrainMacroEvolutionStage1Fields } from "@/src/workers/terrainMacroEvolutionProtocol";
import {
  sampleTerrainEvolutionGeology,
  sampleTerrainUpliftHeight,
  type TerrainEvolutionGeologySample,
} from "@/src/world/terrain";

export interface TerrainMacroUpliftSamplingInput {
  readonly seedHash: number;
  readonly width: number;
  readonly height: number;
  /** World coordinate of the OUTER grid edge; samples are cell-centred. */
  readonly minWorldX: number;
  readonly minWorldZ: number;
  readonly texelSizeMeters: number;
  readonly progressStrideRows?: number;
}

export type TerrainMacroUpliftSampler = (
  seedHash: number,
  worldX: number,
  worldZ: number,
  filterWidthMeters: number,
) => number;

export type TerrainMacroGeologySampler = (
  seedHash: number,
  worldX: number,
  worldZ: number,
  filterWidthMeters: number,
  target: TerrainEvolutionGeologySample,
) => TerrainEvolutionGeologySample;

export interface TerrainMacroEvolutionInputs {
  readonly heights: Float32Array;
  readonly erodibility: Float32Array;
  readonly reposeDegrees: Float32Array;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Deterministically samples the analytic kernel at cell centres. Kept outside
 * the worker entry module so Node can verify its addressing without defining
 * a fake global `self`.
 */
export function sampleTerrainMacroUplift(
  input: TerrainMacroUpliftSamplingInput,
  onRows?: (completedRows: number, totalRows: number) => void,
  sampler: TerrainMacroUpliftSampler = sampleTerrainUpliftHeight,
): Float32Array {
  const width = requirePositiveInteger(input.width, "Macro uplift width");
  const height = requirePositiveInteger(input.height, "Macro uplift height");
  const stride = requirePositiveInteger(input.progressStrideRows ?? 16, "Progress stride");
  if (!Number.isSafeInteger(input.seedHash)) throw new RangeError("seedHash must be a safe integer");
  if (!Number.isFinite(input.minWorldX) || !Number.isFinite(input.minWorldZ)) {
    throw new RangeError("Macro uplift origin must be finite");
  }
  if (!Number.isFinite(input.texelSizeMeters) || input.texelSizeMeters <= 0) {
    throw new RangeError("Macro uplift texel size must be positive");
  }
  const heights = new Float32Array(width * height);
  const halfTexel = input.texelSizeMeters * 0.5;
  for (let z = 0; z < height; z += 1) {
    const worldZ = input.minWorldZ + halfTexel + z * input.texelSizeMeters;
    for (let x = 0; x < width; x += 1) {
      const worldX = input.minWorldX + halfTexel + x * input.texelSizeMeters;
      heights[z * width + x] = Math.fround(
        sampler(input.seedHash, worldX, worldZ, input.texelSizeMeters),
      );
    }
    const completed = z + 1;
    if (completed === height || completed % stride === 0) onRows?.(completed, height);
  }
  return heights;
}

/**
 * Production macro input sampling. Uplift and lithology are evaluated at the
 * same cell centres and footprint, so macro incision uses the same spatial K
 * and repose authority as fine-page erosion rather than a uniform proxy.
 */
export function sampleTerrainMacroEvolutionInputs(
  input: TerrainMacroUpliftSamplingInput,
  onRows?: (completedRows: number, totalRows: number) => void,
  upliftSampler: TerrainMacroUpliftSampler = sampleTerrainUpliftHeight,
  geologySampler: TerrainMacroGeologySampler = sampleTerrainEvolutionGeology,
): TerrainMacroEvolutionInputs {
  const width = requirePositiveInteger(input.width, "Macro input width");
  const height = requirePositiveInteger(input.height, "Macro input height");
  const stride = requirePositiveInteger(input.progressStrideRows ?? 16, "Progress stride");
  if (!Number.isSafeInteger(input.seedHash)) throw new RangeError("seedHash must be a safe integer");
  if (!Number.isFinite(input.minWorldX) || !Number.isFinite(input.minWorldZ)) {
    throw new RangeError("Macro input origin must be finite");
  }
  if (!Number.isFinite(input.texelSizeMeters) || input.texelSizeMeters <= 0) {
    throw new RangeError("Macro input texel size must be positive");
  }
  const count = width * height;
  const heights = new Float32Array(count);
  const erodibility = new Float32Array(count);
  const reposeDegrees = new Float32Array(count);
  const halfTexel = input.texelSizeMeters * 0.5;
  const geology: TerrainEvolutionGeologySample = {
    fabricCos2: 1,
    fabricSin2: 0,
    erodibility: 1,
    reposeDegrees: 34,
  };
  for (let z = 0; z < height; z += 1) {
    const worldZ = input.minWorldZ + halfTexel + z * input.texelSizeMeters;
    for (let x = 0; x < width; x += 1) {
      const worldX = input.minWorldX + halfTexel + x * input.texelSizeMeters;
      const index = z * width + x;
      heights[index] = Math.fround(
        upliftSampler(input.seedHash, worldX, worldZ, input.texelSizeMeters),
      );
      geologySampler(
        input.seedHash,
        worldX,
        worldZ,
        input.texelSizeMeters,
        geology,
      );
      erodibility[index] = Math.fround(geology.erodibility);
      reposeDegrees[index] = Math.fround(geology.reposeDegrees);
    }
    const completed = z + 1;
    if (completed === height || completed % stride === 0) onRows?.(completed, height);
  }
  return Object.freeze({ heights, erodibility, reposeDegrees });
}

export interface TerrainMacroEvolutionStage1GridOptions {
  readonly width: number;
  readonly height: number;
  readonly seaLevel: number;
}

/**
 * Hybrid stage 1 (`W-1a`): the deterministic CPU head of the macro pipeline —
 * first priority flood and first MFD pass over the sampled uplift, plus the
 * submarine protection mask — producing exactly the inputs the GPU stream
 * power + talus operators consume. Uses the same reference operators and the
 * frozen production config `evolveMacroTerrain` uses, so the drainage graph
 * the GPU erodes against is bit-identical to the single-shot path's.
 */
export function deriveTerrainMacroEvolutionStage1Fields(
  inputs: TerrainMacroEvolutionInputs,
  options: TerrainMacroEvolutionStage1GridOptions,
): TerrainMacroEvolutionStage1Fields {
  const config = MACRO_EVOLUTION_PRODUCTION_CONFIG;
  const flood = priorityFloodOpenRim(
    options.width,
    options.height,
    inputs.heights,
    options.seaLevel,
    config.fillEpsilonMetersPerTexel,
  );
  const flow = computeMfdFlowAccumulation(
    options.width,
    options.height,
    flood.filledHeight,
    flood.floodParent,
    { slopeExponent: config.mfdSlopeExponent },
  );
  const count = options.width * options.height;
  const erosionMask = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    if (inputs.heights[index]! <= options.seaLevel) erosionMask[index] = 1;
  }
  return Object.freeze({
    heights: inputs.heights,
    erodibility: inputs.erodibility,
    reposeDegrees: inputs.reposeDegrees,
    receivers: flow.receivers,
    flowAccumulation: flow.flowAccumulation,
    erosionMask,
  });
}

export interface TerrainMacroEvolutionStage2Input {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  readonly seaLevel: number;
  /** The GPU-evolved (stream power + talus) macro surface, f32 bits. */
  readonly evolvedHeightMeters: Float32Array;
  readonly provenance: TerrainEvolutionProvenance;
}

/**
 * Hybrid stage 2 (`W-1a`): the drainage tail — re-flood, re-MFD, lake
 * discovery, base levels and channel seeds over the already-evolved surface.
 *
 * `W-1c` replaced the original `evolveMacroTerrain`-with-zero-iterations
 * spelling with the reference module's own completion entry point. The old
 * spelling ran the flood and the MFD gather TWICE over identical data — the
 * leading pair only ever fed a zero-iteration incision, so its results were
 * discarded (~0.85 s at production shape). `finishMacroEvolutionFromEvolvedHeight`
 * is the same code path with that dead pair removed, and is pinned
 * bit-identical to the zero-iteration spelling by
 * tests/render.webgpu-terrain-evolution.test.ts.
 */
export function completeTerrainMacroEvolutionFromEvolvedHeight(
  input: TerrainMacroEvolutionStage2Input,
): TerrainMacroEvolutionExport {
  const result = finishMacroEvolutionFromEvolvedHeight({
    width: input.width,
    height: input.height,
    texelSizeMeters: input.texelSizeMeters,
    seaLevel: input.seaLevel,
    heights: input.evolvedHeightMeters,
  });
  return toTerrainMacroEvolutionExport(result, input.seaLevel, input.provenance);
}
