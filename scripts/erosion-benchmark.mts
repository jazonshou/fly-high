/**
 * W-1 (Phase 6, Gate W): the committed production-shape macro-erosion
 * benchmark. The 3,174 + 4,323 = 7,497 ms figures the plans quote were a
 * local run with no committed harness; this script is that harness, so
 * before/after evidence for the GPU port is reproducible.
 *
 * Run with tsx, never vitest — the vitest SSR transform runs the kernel
 * ~4.5x slower than the app (see MEMORY: vitest-ssr-transform-4x-slower):
 *
 *   npx tsx scripts/erosion-benchmark.mts [seed]
 *
 * Per-operator timings reproduce evolveMacroTerrain's exact sequence by
 * calling the exported operators directly, then run the real entry point
 * end-to-end and assert the composed result fingerprints match, so the
 * breakdown can never drift from the shipped pipeline.
 */
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  MACRO_EVOLUTION_PRODUCTION_CONFIG,
  applyStreamPowerIncision,
  applyThermalTalusRelaxation,
  computeMfdFlowAccumulation,
  evolveMacroTerrain,
  fingerprintEvolutionFields,
  priorityFloodOpenRim,
} from "../src/render/webgpu/terrain/TerrainMacroEvolution";
import { sampleTerrainMacroEvolutionInputs } from "../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../src/world";

const seed = Number.parseInt(process.argv[2] ?? "333438", 10) >>> 0;
const world = createWorld(seed, { worldEvolution: "eroded" });
const width = EVOLUTION_DOMAIN_TEXELS;
const height = EVOLUTION_DOMAIN_TEXELS;

function time<T>(label: string, run: () => T): T {
  const start = performance.now();
  const value = run();
  const elapsed = performance.now() - start;
  console.log(`${label.padEnd(28)} ${elapsed.toFixed(0).padStart(7)} ms`);
  return value;
}

console.log(`seed ${seed} (seedHash ${world.seedHash}), domain ${width}x${height} @ ${EVOLUTION_TEXEL_METERS} m`);

const inputs = time("sampling (uplift+geology)", () =>
  sampleTerrainMacroEvolutionInputs({
    width,
    height,
    minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
    minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seedHash: world.seedHash,
  }));

const config = MACRO_EVOLUTION_PRODUCTION_CONFIG;
const seaLevel = world.seaLevel;
const count = width * height;

const flood1 = time("priority flood #1", () =>
  priorityFloodOpenRim(width, height, inputs.heights, seaLevel, config.fillEpsilonMetersPerTexel));
const flow1 = time("MFD accumulation #1", () =>
  computeMfdFlowAccumulation(width, height, flood1.filledHeight, flood1.floodParent, {
    slopeExponent: config.mfdSlopeExponent,
  }));
const protectedMask = new Uint8Array(count);
for (let index = 0; index < count; index += 1) {
  if (inputs.heights[index]! <= seaLevel) protectedMask[index] = 1;
}
const incised = time("stream power (24 iters)", () =>
  applyStreamPowerIncision(inputs.heights, flow1.receivers, flow1.flowAccumulation, {
    iterations: config.streamPowerIterations,
    coefficient: config.streamPowerCoefficient,
    areaExponent: config.streamPowerAreaExponent,
    timeStep: config.streamPowerTimeStep,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seaLevel,
    erodibility: inputs.erodibility,
    erosionMask: protectedMask,
  }));
const relaxed = time("thermal talus (32 iters)", () =>
  applyThermalTalusRelaxation(incised, {
    width,
    height,
    iterations: config.talusIterations,
    defaultReposeDegrees: config.defaultReposeDegrees,
    transferFraction: config.talusTransferFraction,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    reposeDegrees: inputs.reposeDegrees,
    erosionMask: protectedMask,
  }));
const flood2 = time("priority flood #2", () =>
  priorityFloodOpenRim(width, height, relaxed, seaLevel, config.fillEpsilonMetersPerTexel));
time("MFD accumulation #2", () =>
  computeMfdFlowAccumulation(width, height, flood2.filledHeight, flood2.floodParent, {
    slopeExponent: config.mfdSlopeExponent,
  }));

const composed = time("evolveMacroTerrain (e2e)", () =>
  evolveMacroTerrain({
    width,
    height,
    heights: inputs.heights,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    seaLevel,
    erodibility: inputs.erodibility,
    reposeDegrees: inputs.reposeDegrees,
  }));

// The breakdown must reproduce the shipped pipeline's evolved surface — the
// per-operator legs above only measure honestly if they compose to the same
// bits the entry point produces.
const breakdownPrint = fingerprintEvolutionFields([relaxed]);
const composedPrint = fingerprintEvolutionFields([composed.evolvedHeight]);
if (breakdownPrint !== composedPrint) {
  throw new Error(
    `breakdown diverged from evolveMacroTerrain (${breakdownPrint} != ${composedPrint}) — the per-operator sequence no longer matches the entry point`,
  );
}
console.log(`lakes ${composed.lakes.length}, channel seeds ${composed.channelSeeds.length}, fingerprint ${composedPrint}`);
