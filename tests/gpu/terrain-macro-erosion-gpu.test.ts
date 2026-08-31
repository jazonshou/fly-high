import { describe, expect, it } from "vitest";
// Side-effect import: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  TERRAIN_MACRO_EROSION_GPU_PARITY_CRITERIA,
  TERRAIN_MACRO_EROSION_GPU_PRODUCTION_CONFIG,
  TerrainMacroErosionGpu,
  type TerrainMacroErosionGpuRunInputs,
} from "../../src/render/webgpu/terrain/TerrainMacroErosionGpu";
import {
  MACRO_EVOLUTION_PRODUCTION_CONFIG,
  applyStreamPowerIncision,
  applyThermalTalusRelaxation,
  computeMfdFlowAccumulation,
  priorityFloodOpenRim,
} from "../../src/render/webgpu/terrain/TerrainMacroEvolution";
import { sampleTerrainMacroEvolutionInputs } from "../../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../../src/world";

/**
 * `W-1a` (Gate W): the GPU stream-power + talus port against its CPU oracle.
 *
 * Doctrine (PHASE_6 §11 D-3): GPU-vs-GPU bit determinism is the authority —
 * the operators are pure gathers with fixed iteration counts, so two runs on
 * one adapter must produce identical bytes. CPU parity is TOLERANCE-tier with
 * the frozen measured-criteria contract in
 * TERRAIN_MACRO_EROSION_GPU_PARITY_CRITERIA (the point count is part of the
 * criterion; the achieved bound is console.logged as a recorded measurement).
 * Masked cells are the one bit-exact CPU claim: both sides restore them to
 * the exact input bits.
 */

const CRITERIA = TERRAIN_MACRO_EROSION_GPU_PARITY_CRITERIA;

async function withEngine<T>(run: (engine: WebGPUEngine) => Promise<T>): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    const result = await run(engine);
    engine.stopRenderLoop();
    return result;
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

/**
 * Deterministic synthetic macro fixture anchored kilometres out from the
 * origin with negative world coordinates (the sin-hash world-scale rule:
 * never validate only near the origin). Heights dip below sea level so the
 * submarine protection mask is non-trivial; receivers/flow come from the real
 * flood + MFD operators so the incision drive has genuine drainage topology.
 */
function buildFixtureInputs(
  edge: number,
  requireMaskedCells = true,
): TerrainMacroErosionGpuRunInputs {
  const texelSizeMeters = EVOLUTION_TEXEL_METERS;
  const originX = -191_744; // 512-lattice aligned, ~192 km out
  const originZ = -83_968;
  const seaLevel = 0;
  const count = edge * edge;
  const heights = new Float32Array(count);
  const erodibility = new Float32Array(count);
  const reposeDegrees = new Float32Array(count);
  for (let z = 0; z < edge; z += 1) {
    const worldZ = originZ + (z + 0.5) * texelSizeMeters;
    for (let x = 0; x < edge; x += 1) {
      const worldX = originX + (x + 0.5) * texelSizeMeters;
      const index = z * edge + x;
      heights[index] = Math.fround(
        340
        + 300 * Math.sin(worldX * 1.9e-4) * Math.cos(worldZ * 1.6e-4)
        + 120 * Math.sin(worldX * 7.7e-4) * Math.sin(worldZ * 6.3e-4)
        + 40 * Math.sin(worldX * 2.9e-3 + worldZ * 1.7e-3),
      );
      erodibility[index] = Math.fround(
        0.32 + 1.13 * (0.5 + 0.5 * Math.sin(worldX * 3.1e-4 + worldZ * 2.3e-4)),
      );
      reposeDegrees[index] = Math.fround(
        28 + 14 * (0.5 + 0.5 * Math.cos(worldX * 2.2e-4 - worldZ * 2.7e-4)),
      );
    }
  }
  const flood = priorityFloodOpenRim(
    edge,
    edge,
    heights,
    seaLevel,
    MACRO_EVOLUTION_PRODUCTION_CONFIG.fillEpsilonMetersPerTexel,
  );
  const flow = computeMfdFlowAccumulation(edge, edge, flood.filledHeight, flood.floodParent, {
    slopeExponent: MACRO_EVOLUTION_PRODUCTION_CONFIG.mfdSlopeExponent,
  });
  const erosionMask = new Uint8Array(count);
  let masked = 0;
  for (let index = 0; index < count; index += 1) {
    if (heights[index]! <= seaLevel) {
      erosionMask[index] = 1;
      masked += 1;
    }
  }
  // The parity fixtures must exercise the masked-restore contract for real;
  // the small loopless smoke fixture may legitimately sit entirely above sea.
  if ((requireMaskedCells && masked === 0) || masked === count) {
    throw new Error(`degenerate fixture mask: ${masked}/${count} cells masked`);
  }
  return {
    width: edge,
    height: edge,
    texelSizeMeters,
    seaLevel,
    heights,
    receivers: flow.receivers,
    flowAccumulation: flow.flowAccumulation,
    erodibility,
    reposeDegrees,
    erosionMask,
  };
}

interface CpuReferenceConfig {
  readonly streamPowerIterations: number;
  readonly talusIterations: number;
}

/** The exact operator sequence evolveMacroTerrain runs between flood passes. */
function cpuReference(
  inputs: TerrainMacroErosionGpuRunInputs,
  config: CpuReferenceConfig,
): Float32Array {
  const incised = applyStreamPowerIncision(
    inputs.heights,
    inputs.receivers,
    inputs.flowAccumulation,
    {
      iterations: config.streamPowerIterations,
      coefficient: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerCoefficient,
      areaExponent: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerAreaExponent,
      timeStep: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerTimeStep,
      texelSizeMeters: inputs.texelSizeMeters,
      seaLevel: inputs.seaLevel,
      erodibility: inputs.erodibility,
      erosionMask: inputs.erosionMask,
    },
  );
  return applyThermalTalusRelaxation(incised, {
    width: inputs.width,
    height: inputs.height,
    texelSizeMeters: inputs.texelSizeMeters,
    iterations: config.talusIterations,
    defaultReposeDegrees: MACRO_EVOLUTION_PRODUCTION_CONFIG.defaultReposeDegrees,
    transferFraction: MACRO_EVOLUTION_PRODUCTION_CONFIG.talusTransferFraction,
    reposeDegrees: inputs.reposeDegrees,
    erosionMask: inputs.erosionMask,
  });
}

function expectBitIdentical(
  first: Float32Array,
  second: Float32Array,
  context: string,
): void {
  const firstBits = new Uint32Array(first.buffer, first.byteOffset, first.length);
  const secondBits = new Uint32Array(second.buffer, second.byteOffset, second.length);
  expect(firstBits.length, context).toBe(secondBits.length);
  for (let index = 0; index < firstBits.length; index += 1) {
    if (firstBits[index] !== secondBits[index]) {
      expect.fail(
        `${context}: bit divergence at cell ${index}: `
        + `0x${firstBits[index]!.toString(16)} != 0x${secondBits[index]!.toString(16)}`,
      );
    }
  }
}

function maskedCellsBitEqualInput(
  evolved: Float32Array,
  inputs: TerrainMacroErosionGpuRunInputs,
  context: string,
): number {
  const evolvedBits = new Uint32Array(evolved.buffer, evolved.byteOffset, evolved.length);
  const inputBits = new Uint32Array(
    inputs.heights.buffer,
    inputs.heights.byteOffset,
    inputs.heights.length,
  );
  let maskedCount = 0;
  for (let index = 0; index < evolved.length; index += 1) {
    if (inputs.erosionMask[index]! < 0.5) continue;
    maskedCount += 1;
    if (evolvedBits[index] !== inputBits[index]) {
      expect.fail(
        `${context}: masked cell ${index} not restored bit-for-bit `
        + `(0x${evolvedBits[index]!.toString(16)} != 0x${inputBits[index]!.toString(16)})`,
      );
    }
  }
  return maskedCount;
}

describe("terrain macro erosion GPU port (W-1a)", () => {
  it("is bit-deterministic GPU-vs-GPU and tolerance-bounded against the CPU oracle at 64²", async () => {
    const inputs = buildFixtureInputs(CRITERIA.smallGridEdgeTexels);
    const testConfig = {
      streamPowerIterations: CRITERIA.smallGridStreamPowerIterations,
      talusIterations: CRITERIA.smallGridTalusIterations,
    };

    const { firstRun, secondRun, freshInstanceRun } = await withEngine(async (engine) => {
      const producer = new TerrainMacroErosionGpu(engine, testConfig);
      expect(producer.deviceFingerprint.startsWith("gpu-macro-v1")).toBe(true);
      const first = await producer.run(inputs);
      const second = await producer.run(inputs);
      // A fresh instance re-creates pipelines and buffers from scratch; the
      // evict/regenerate form of the determinism claim.
      const fresh = new TerrainMacroErosionGpu(engine, testConfig);
      const third = await fresh.run(inputs);
      producer.dispose();
      fresh.dispose();
      return { firstRun: first, secondRun: second, freshInstanceRun: third };
    });

    // (a) GPU-vs-GPU bit determinism: exact IEEE-754 byte equality.
    expectBitIdentical(firstRun.evolvedHeight, secondRun.evolvedHeight, "same-producer rerun");
    expectBitIdentical(
      firstRun.evolvedHeight,
      freshInstanceRun.evolvedHeight,
      "fresh-instance rerun",
    );

    // Masked-restore contract: exact input bits through both operators.
    const maskedCount = maskedCellsBitEqualInput(firstRun.evolvedHeight, inputs, "64² fixture");
    expect(maskedCount).toBeGreaterThan(0);

    // (b) CPU tolerance parity over ALL cells, achieved bound recorded.
    const cpu = cpuReference(inputs, testConfig);
    let worst = 0;
    let worstIndex = 0;
    for (let index = 0; index < cpu.length; index += 1) {
      const delta = Math.abs(firstRun.evolvedHeight[index]! - cpu[index]!);
      if (delta > worst) {
        worst = delta;
        worstIndex = index;
      }
    }
    console.log(
      `macro erosion GPU parity (64², ${testConfig.streamPowerIterations} SP + `
      + `${testConfig.talusIterations} talus): max |Δh| = ${worst.toExponential(3)} m `
      + `at cell ${worstIndex} over ${cpu.length} cells (${maskedCount} masked, bit-exact); `
      + `tolerance ${CRITERIA.smallGridToleranceMeters} m`,
    );
    expect(worst, `max |Δh| over ${cpu.length} cells`).toBeLessThan(
      CRITERIA.smallGridToleranceMeters,
    );
  }, 120_000);

  it("completes without a running render loop, as during FlightRenderer.create", async () => {
    // The hybrid leg runs inside renderer startup, BEFORE any render loop
    // pumps frames: every sync/readback must flush explicitly (noDelay).
    const inputs = buildFixtureInputs(32, false);
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    try {
      await engine.initAsync();
      const producer = new TerrainMacroErosionGpu(engine, {
        streamPowerIterations: 3,
        talusIterations: 3,
      });
      const first = await producer.run(inputs);
      const second = await producer.run(inputs);
      producer.dispose();
      expectBitIdentical(first.evolvedHeight, second.evolvedHeight, "loopless rerun");
      maskedCellsBitEqualInput(first.evolvedHeight, inputs, "loopless 32²");
      let changed = 0;
      for (let index = 0; index < first.evolvedHeight.length; index += 1) {
        if (!Number.isFinite(first.evolvedHeight[index]!)) {
          expect.fail(`non-finite height at cell ${index}`);
        }
        if (first.evolvedHeight[index] !== inputs.heights[index]) changed += 1;
      }
      // The operators must have actually run, not silently returned input.
      expect(changed).toBeGreaterThan(0);
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 120_000);

  it("holds tolerance parity at the production 1024² shape and reports GPU wall time", async () => {
    // Real inputs at the real domain: the benchmark world (seed 333438),
    // sampled at production layout, with the real flood + MFD head.
    const world = createWorld(333438, { worldEvolution: "eroded" });
    const width = EVOLUTION_DOMAIN_TEXELS;
    const height = EVOLUTION_DOMAIN_TEXELS;
    const sampled = sampleTerrainMacroEvolutionInputs({
      seedHash: world.seedHash,
      width,
      height,
      minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
      minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
    });
    const flood = priorityFloodOpenRim(
      width,
      height,
      sampled.heights,
      world.seaLevel,
      MACRO_EVOLUTION_PRODUCTION_CONFIG.fillEpsilonMetersPerTexel,
    );
    const flow = computeMfdFlowAccumulation(width, height, flood.filledHeight, flood.floodParent, {
      slopeExponent: MACRO_EVOLUTION_PRODUCTION_CONFIG.mfdSlopeExponent,
    });
    const count = width * height;
    const erosionMask = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      if (sampled.heights[index]! <= world.seaLevel) erosionMask[index] = 1;
    }
    const inputs: TerrainMacroErosionGpuRunInputs = {
      width,
      height,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      seaLevel: world.seaLevel,
      heights: sampled.heights,
      receivers: flow.receivers,
      flowAccumulation: flow.flowAccumulation,
      erodibility: sampled.erodibility,
      reposeDegrees: sampled.reposeDegrees,
      erosionMask,
    };

    const { firstRun, secondRun } = await withEngine(async (engine) => {
      const producer = new TerrainMacroErosionGpu(engine);
      expect(producer.config).toEqual(TERRAIN_MACRO_EROSION_GPU_PRODUCTION_CONFIG);
      const first = await producer.run(inputs);
      const second = await producer.run(inputs);
      producer.dispose();
      return { firstRun: first, secondRun: second };
    });

    // Production-shape GPU-vs-GPU bit determinism.
    expectBitIdentical(firstRun.evolvedHeight, secondRun.evolvedHeight, "1024² rerun");
    const maskedCount = maskedCellsBitEqualInput(firstRun.evolvedHeight, inputs, "1024²");

    const cpu = cpuReference(inputs, {
      streamPowerIterations: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerIterations,
      talusIterations: MACRO_EVOLUTION_PRODUCTION_CONFIG.talusIterations,
    });
    // The strided subset is the frozen criterion (point count included);
    // the full-grid bound is measured and reported alongside it.
    const stride = CRITERIA.productionStrideTexels;
    let stridedWorst = 0;
    let stridedSamples = 0;
    let fullWorst = 0;
    let fullWorstIndex = 0;
    for (let index = 0; index < count; index += 1) {
      const delta = Math.abs(firstRun.evolvedHeight[index]! - cpu[index]!);
      if (delta > fullWorst) {
        fullWorst = delta;
        fullWorstIndex = index;
      }
      if (index % stride === 0) {
        stridedSamples += 1;
        if (delta > stridedWorst) stridedWorst = delta;
      }
    }
    expect(stridedSamples).toBeGreaterThanOrEqual(CRITERIA.productionMinimumSamples);
    const timings = firstRun.timings;
    console.log(
      "macro erosion GPU production run (1024², 24 SP + 32x2 talus dispatches):\n"
      + `  stream power ${timings.streamPowerMilliseconds.toFixed(1)} ms, `
      + `talus ${timings.talusMilliseconds.toFixed(1)} ms, `
      + `readback ${timings.readbackMilliseconds.toFixed(1)} ms, `
      + `total ${timings.totalMilliseconds.toFixed(1)} ms\n`
      + `  parity: strided max |Δh| = ${stridedWorst.toExponential(3)} m over `
      + `${stridedSamples} samples (tolerance ${CRITERIA.productionToleranceMeters} m); `
      + `full-grid max |Δh| = ${fullWorst.toExponential(3)} m at cell ${fullWorstIndex}; `
      + `${maskedCount} masked cells bit-exact`,
    );
    expect(
      stridedWorst,
      `strided max |Δh| over ${stridedSamples} samples`,
    ).toBeLessThan(CRITERIA.productionToleranceMeters);
  }, 300_000);
});
