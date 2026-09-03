import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  validateTerrainChannelGraphExport,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import { TerrainMacroInputsGpu } from "../../src/render/webgpu/terrain/TerrainMacroErosionGpu";
import { TerrainMacroEvolution } from "../../src/render/webgpu/terrain/TerrainMacroEvolution";
import { TERRAIN_KERNEL_FORBIDDEN_BUILTINS } from "../../src/render/webgpu/terrain/TerrainKernel";
import {
  TERRAIN_UPLIFT_FABRIC_LATTICES,
  TERRAIN_UPLIFT_GPU_EXTRACTION_BAND,
  TERRAIN_UPLIFT_GPU_PARITY_CRITERIA,
  TERRAIN_UPLIFT_KERNEL_LATTICES,
  TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
  TERRAIN_UPLIFT_KERNEL_WGSL,
  buildTerrainUpliftKernelPageUniform,
  composedTerrainUpliftKernelWgsl,
} from "../../src/render/webgpu/terrain/TerrainUpliftKernel";
import { ChannelNetwork } from "../../src/render/webgpu/water/ChannelNetwork";
import { sampleTerrainMacroEvolutionInputs } from "../../src/workers/terrainMacroEvolutionRuntime";
import { createWorld } from "../../src/world";
import {
  TERRAIN_PLATE_MOTION_CHANNEL,
  TERRAIN_PLATE_SITE_CHANNEL,
} from "../../src/world/geology";
import { hashSeed, mixSeed } from "../../src/world/seed";
import {
  sampleTerrainEvolutionGeology,
  sampleTerrainFineBandRelief,
  sampleTerrainUpliftHeight,
  type TerrainEvolutionGeologySample,
} from "../../src/world/terrain";

/**
 * `W-1b` (Gate W): the WGSL uplift/geology sampler twins against their CPU
 * oracles, per the PHASE_6 §11 D-3 doctrine:
 *
 * - GPU-vs-GPU bit determinism is the authority claim (pure per-cell function
 *   of page uniforms — same device, same bytes).
 * - CPU parity is TOLERANCE-tier with the frozen measured criteria in
 *   TERRAIN_UPLIFT_GPU_PARITY_CRITERIA (point count part of the criterion;
 *   achieved bounds console.logged as recorded measurements). No new integer
 *   paths exist — the hash layer is the included TERRAIN_KERNEL_WGSL's, which
 *   terrain-height-parity.test.ts pins bit-exactly — so the bit tier here is
 *   the pre-mixed seed table, checked against the transliterated chain.
 * - The downstream-amplification gate: priority flood + MFD break ties by
 *   comparison, so f32-level input deltas may legally flip receivers, move
 *   lakes, and reshape basins. The pinned claims are that ChannelNetwork
 *   extraction of the GPU-input evolution SUCCEEDS (a missing lake outlet
 *   throws at startup) and that lake/channel-seed populations stay inside
 *   TERRAIN_UPLIFT_GPU_EXTRACTION_BAND of the CPU-input evolution.
 */

const SEED_HASH = hashSeed("uplift-parity");
const CRITERIA = TERRAIN_UPLIFT_GPU_PARITY_CRITERIA;
const BAND = TERRAIN_UPLIFT_GPU_EXTRACTION_BAND;

/**
 * Outputs per probe: height, fabricCos2, fabricSin2, erodibility, repose, and
 * (`W-4`) the post-erosion fine-band relief. The band is a THIRD sampler in
 * this kernel now, and it has to be twinned here or the CPU page path and the
 * GPU page DAG stop describing one landscape.
 */
const PROBE_RESULT_STRIDE = 6;

const PROBE_KERNEL = /* wgsl */ `
${
  // upliftKernelPages at binding 0; the DEAD height-kernel page binding at 4
  // (required to compile, pruned by Tint, never mapped or set).
  composedTerrainUpliftKernelWgsl(0, 0, 4)
}
struct UpliftProbe { pageIndex: u32, pad: u32, localX: f32, localZ: f32 };

@group(0) @binding(1) var<storage, read> probes: array<UpliftProbe>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&probes)) { return; }
  let probe = probes[id.x];
  kSelectPage(probe.pageIndex);
  let base = id.x * ${PROBE_RESULT_STRIDE}u;
  results[base] = terrainUpliftHeight(probe.localX, probe.localZ);
  let geology = terrainEvolutionGeologySample(probe.localX, probe.localZ);
  results[base + 1u] = geology.x;
  results[base + 2u] = geology.y;
  results[base + 3u] = geology.z;
  results[base + 4u] = geology.w;
  results[base + 5u] = terrainFineBandRelief(probe.localX, probe.localZ);
}
`;

/** Deterministic low-discrepancy sequence, so a failure is reproducible. */
function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * fraction;
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

interface ProbeSet {
  readonly pageOrigins: readonly (readonly [number, number])[];
  readonly probes: Float32Array;
  readonly worldX: Float64Array;
  readonly worldZ: Float64Array;
  readonly count: number;
}

/**
 * Page origins on the 512 m lattice (exactly representable in f32 — the
 * fabric frame's absolute-origin contract), locals over a page-plus-gutter
 * span, and CPU-side world coordinates built from the f32-ROUNDED locals so
 * both samplers see the same point (the height-parity doctrine).
 */
function buildProbes(radiusMeters: number, pagesPerAxis: number, perPage: number): ProbeSet {
  const pageOrigins: (readonly [number, number])[] = [];
  const step = (2 * radiusMeters) / pagesPerAxis;
  for (let row = 0; row < pagesPerAxis; row += 1) {
    for (let column = 0; column < pagesPerAxis; column += 1) {
      const x = Math.round((-radiusMeters + column * step) / 512) * 512;
      const z = Math.round((-radiusMeters + row * step) / 512) * 512;
      pageOrigins.push([x, z]);
    }
  }
  const count = pageOrigins.length * perPage;
  const probes = new Float32Array(count * 4);
  const pageIndices = new Uint32Array(probes.buffer);
  const worldX = new Float64Array(count);
  const worldZ = new Float64Array(count);
  let index = 0;
  for (let page = 0; page < pageOrigins.length; page += 1) {
    const [originX, originZ] = pageOrigins[page]!;
    for (let sample = 0; sample < perPage; sample += 1) {
      const localX = halton(sample + 1, 2) * 528 - 8;
      const localZ = halton(sample + 1, 3) * 528 - 8;
      pageIndices[index * 4] = page;
      probes[index * 4 + 2] = localX;
      probes[index * 4 + 3] = localZ;
      worldX[index] = originX + Math.fround(localX);
      worldZ[index] = originZ + Math.fround(localZ);
      index += 1;
    }
  }
  return { pageOrigins, probes, worldX, worldZ, count };
}

function packPages(
  origins: readonly (readonly [number, number])[],
  filterWidthMeters: number,
): Uint8Array {
  const packed = new Uint8Array(origins.length * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES);
  origins.forEach(([originX, originZ], index) => {
    packed.set(
      new Uint8Array(buildTerrainUpliftKernelPageUniform({
        seedHash: SEED_HASH,
        originX,
        originZ,
        filterWidthMeters,
      })),
      index * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
    );
  });
  return packed;
}

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

async function dispatchProbes(
  engine: WebGPUEngine,
  set: ProbeSet,
  filterWidthMeters: number,
): Promise<Float32Array> {
  const pageBuffer = new StorageBuffer(
    engine,
    set.pageOrigins.length * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
  );
  pageBuffer.update(packPages(set.pageOrigins, filterWidthMeters));
  const probeBuffer = new StorageBuffer(engine, set.probes.byteLength);
  probeBuffer.update(new Uint8Array(set.probes.buffer));
  const resultBuffer = new StorageBuffer(engine, set.count * PROBE_RESULT_STRIDE * 4);
  const shader = new ComputeShader(
    `terrain-uplift-parity-${filterWidthMeters}`,
    engine,
    { computeSource: PROBE_KERNEL },
    {
      bindingsMapping: {
        upliftKernelPages: { group: 0, binding: 0 },
        probes: { group: 0, binding: 1 },
        results: { group: 0, binding: 2 },
      },
    },
  );
  shader.setStorageBuffer("upliftKernelPages", pageBuffer);
  shader.setStorageBuffer("probes", probeBuffer);
  shader.setStorageBuffer("results", resultBuffer);
  await shader.dispatchWhenReady(Math.ceil(set.count / 64), 1, 1);
  const view = await resultBuffer.read();
  const results = new Float32Array(
    view.buffer.slice(view.byteOffset, view.byteOffset + set.count * PROBE_RESULT_STRIDE * 4),
  );
  pageBuffer.dispose();
  probeBuffer.dispose();
  resultBuffer.dispose();
  return results;
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

const PRODUCTION_LAYOUT = {
  width: EVOLUTION_DOMAIN_TEXELS,
  height: EVOLUTION_DOMAIN_TEXELS,
  minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
  minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
  texelSizeMeters: EVOLUTION_TEXEL_METERS,
} as const;

describe("terrain uplift/geology kernel CPU/GPU parity (W-1b)", () => {
  it("hoists the transliterated seed chain and emits no forbidden builtins", () => {
    // Bit tier: the only integer path this kernel ADDS over the height
    // kernel's (bit-pinned) hash layer is the pre-mixed seed table.
    const uniform = buildTerrainUpliftKernelPageUniform({
      seedHash: SEED_HASH,
      originX: 0,
      originZ: 0,
      filterWidthMeters: 0,
    });
    const splitCount = TERRAIN_UPLIFT_KERNEL_LATTICES.length;
    const fabricCount = TERRAIN_UPLIFT_FABRIC_LATTICES.length;
    // W-4 appends two non-lattice seeds after the rows: the plate model's site
    // and motion channels.
    const seedCount = splitCount + fabricCount + 2;
    const seeds = new Uint32Array(
      uniform,
      TERRAIN_UPLIFT_KERNEL_PAGE_BYTES - Math.ceil(seedCount / 4) * 16,
      seedCount,
    );
    expect(seedCount).toBeGreaterThan(0);
    TERRAIN_UPLIFT_KERNEL_LATTICES.forEach((lattice, index) => {
      const channelSeed = mixSeed(SEED_HASH, lattice.channel);
      const octaveSeed = lattice.octaveChannel === null
        ? channelSeed
        : mixSeed(channelSeed, lattice.octaveChannel);
      expect(seeds[index], lattice.name).toBe(mixSeed(octaveSeed, 0) >>> 0);
    });
    TERRAIN_UPLIFT_FABRIC_LATTICES.forEach((lattice, index) => {
      const channelSeed = mixSeed(SEED_HASH, lattice.channel);
      const octaveSeed = lattice.octaveChannel === null
        ? channelSeed
        : mixSeed(channelSeed, lattice.octaveChannel);
      expect(seeds[splitCount + index], lattice.name).toBe(mixSeed(octaveSeed, 0) >>> 0);
    });
    // The plate seeds are hashed directly by sampleTerrainPlates — one mix,
    // no per-octave mix and no `mixSeed(..., 0)` tail.
    expect(seeds[splitCount + fabricCount], "plate site seed")
      .toBe(mixSeed(SEED_HASH, TERRAIN_PLATE_SITE_CHANNEL) >>> 0);
    expect(seeds[splitCount + fabricCount + 1], "plate motion seed")
      .toBe(mixSeed(SEED_HASH, TERRAIN_PLATE_MOTION_CHANNEL) >>> 0);

    // Rule 2 of TerrainKernel.ts applies to this module's WGSL too: the
    // builtins whose rounding differs from the TypeScript source are banned.
    for (const builtin of TERRAIN_KERNEL_FORBIDDEN_BUILTINS) {
      expect(
        TERRAIN_UPLIFT_KERNEL_WGSL.includes(builtin),
        `uplift WGSL uses ${builtin}`,
      ).toBe(false);
    }
  });

  it("agrees with the TypeScript samplers across radius and filter width", async () => {
    // 16×16 pages × 160 = 40,960 near points; the count is part of the
    // criterion (a smaller probe set reports passes a larger one fails).
    const near = buildProbes(CRITERIA.nearRadiusMeters, 16, 160);
    expect(near.count).toBeGreaterThanOrEqual(CRITERIA.nearMinimumSamples);
    const far = buildProbes(CRITERIA.farRadiusMeters, 12, 90);
    const wrap = buildProbes(CRITERIA.wrapRadiusMeters, 8, 60);

    interface TierRow {
      readonly context: string;
      readonly heightTolerance: number;
      readonly fineBandTolerance: number;
      readonly worstHeight: number;
      readonly worstErodibility: number;
      readonly worstRepose: number;
      readonly worstFabric: number;
      readonly worstFineBand: number;
    }
    const report: string[] = [];
    const rows: TierRow[] = [];
    const geology: TerrainEvolutionGeologySample = {
      fabricCos2: 1,
      fabricSin2: 0,
      erodibility: 1,
      reposeDegrees: 34,
    };
    await withEngine(async (engine) => {
      for (const [set, radius, heightTolerance, fineBandTolerance] of [
        [near, CRITERIA.nearRadiusMeters, CRITERIA.nearHeightToleranceMeters,
          CRITERIA.nearFineBandToleranceMeters],
        [far, CRITERIA.farRadiusMeters, CRITERIA.farHeightToleranceMeters,
          CRITERIA.farFineBandToleranceMeters],
        [wrap, CRITERIA.wrapRadiusMeters, CRITERIA.wrapHeightToleranceMeters,
          CRITERIA.wrapFineBandToleranceMeters],
      ] as const) {
        for (const filterWidthMeters of CRITERIA.filterWidthsMeters) {
          const gpu = await dispatchProbes(engine, set, filterWidthMeters);
          let worstHeight = 0;
          let worstHeightIndex = 0;
          let worstFabric = 0;
          let worstErodibility = 0;
          let worstRepose = 0;
          let worstFineBand = 0;
          for (let index = 0; index < set.count; index += 1) {
            const wx = set.worldX[index]!;
            const wz = set.worldZ[index]!;
            const expectedHeight = sampleTerrainUpliftHeight(
              SEED_HASH,
              wx,
              wz,
              filterWidthMeters,
            );
            sampleTerrainEvolutionGeology(SEED_HASH, wx, wz, filterWidthMeters, geology);
            const base = index * PROBE_RESULT_STRIDE;
            const heightDelta = Math.abs(gpu[base]! - expectedHeight);
            if (heightDelta > worstHeight) {
              worstHeight = heightDelta;
              worstHeightIndex = index;
            }
            worstFabric = Math.max(
              worstFabric,
              Math.abs(gpu[base + 1]! - geology.fabricCos2),
              Math.abs(gpu[base + 2]! - geology.fabricSin2),
            );
            worstErodibility = Math.max(
              worstErodibility,
              Math.abs(gpu[base + 3]! - geology.erodibility),
            );
            worstRepose = Math.max(
              worstRepose,
              Math.abs(gpu[base + 4]! - geology.reposeDegrees),
            );
            worstFineBand = Math.max(
              worstFineBand,
              Math.abs(gpu[base + 5]! - sampleTerrainFineBandRelief(
                SEED_HASH,
                wx,
                wz,
                filterWidthMeters,
              )),
            );
          }
          report.push(
            `±${radius} m, fw ${filterWidthMeters}: max |Δh| = ${worstHeight.toExponential(3)} m `
            + `at (${set.worldX[worstHeightIndex]!.toFixed(1)}, `
            + `${set.worldZ[worstHeightIndex]!.toFixed(1)}), `
            + `|Δerod| = ${worstErodibility.toExponential(2)}, `
            + `|Δrepose| = ${worstRepose.toExponential(2)}°, `
            + `|Δfabric| = ${worstFabric.toExponential(2)}, `
            + `|Δband| = ${worstFineBand.toExponential(2)} m over ${set.count} points`,
          );
          rows.push({
            context: `±${radius} m at filter width ${filterWidthMeters} over ${set.count} points`,
            heightTolerance,
            fineBandTolerance,
            worstHeight,
            worstErodibility,
            worstRepose,
            worstFabric,
            worstFineBand,
          });
        }
      }
    });
    // Printed BEFORE any assertion so the achieved bounds stay recorded
    // measurements even on a red run (the measured-not-conceded doctrine).
    console.log(`terrain uplift parity:\n  ${report.join("\n  ")}`);
    for (const row of rows) {
      expect(row.worstHeight, `height ${row.context}`).toBeLessThan(row.heightTolerance);
      expect(row.worstErodibility, `erodibility ${row.context}`)
        .toBeLessThan(CRITERIA.erodibilityTolerance);
      expect(row.worstRepose, `repose ${row.context}`)
        .toBeLessThan(CRITERIA.reposeToleranceDegrees);
      expect(row.worstFabric, `fabric double-angle ${row.context}`)
        .toBeLessThan(CRITERIA.fabricDoubleAngleTolerance);
      // Its own tier row: a pure fabric-frame term has no split-origin content
      // to dilute its f32 phase error (see TERRAIN_UPLIFT_GPU_PARITY_CRITERIA).
      expect(row.worstFineBand, `fine-band relief ${row.context}`)
        .toBeLessThan(row.fineBandTolerance);
    }
  }, 300_000);

  it("is bit-deterministic and tolerance-bounded at the production 1024² layout", async () => {
    const world = createWorld(333438, { worldEvolution: "eroded" });
    const request = { seedHash: world.seedHash, ...PRODUCTION_LAYOUT };

    const { first, second, fresh } = await withEngine(async (engine) => {
      const sampler = new TerrainMacroInputsGpu(engine);
      expect(sampler.deviceFingerprint.startsWith("gpu-macro-v1")).toBe(true);
      const firstRun = await sampler.sampleMacroInputs(request);
      const secondRun = await sampler.sampleMacroInputs(request);
      const freshSampler = new TerrainMacroInputsGpu(engine);
      const freshRun = await freshSampler.sampleMacroInputs(request);
      sampler.dispose();
      freshSampler.dispose();
      return { first: firstRun, second: secondRun, fresh: freshRun };
    });

    // (c) GPU-vs-GPU determinism: byte equality across all three outputs,
    // same instance and a fresh instance (evict/regenerate form).
    for (const [field, a, b, c] of [
      ["heights", first.heights, second.heights, fresh.heights],
      ["erodibility", first.erodibility, second.erodibility, fresh.erodibility],
      ["reposeDegrees", first.reposeDegrees, second.reposeDegrees, fresh.reposeDegrees],
    ] as const) {
      expectBitIdentical(a, b, `${field} same-instance rerun`);
      expectBitIdentical(a, c, `${field} fresh-instance rerun`);
    }

    // Tolerance parity against the EXACT CPU loop being twinned, at every one
    // of the 1,048,576 production cells.
    const cpu = sampleTerrainMacroEvolutionInputs(request);
    let worstHeight = 0;
    let worstHeightIndex = 0;
    let sumHeight = 0;
    let worstErodibility = 0;
    let worstRepose = 0;
    for (let index = 0; index < cpu.heights.length; index += 1) {
      const heightDelta = Math.abs(first.heights[index]! - cpu.heights[index]!);
      sumHeight += heightDelta;
      if (heightDelta > worstHeight) {
        worstHeight = heightDelta;
        worstHeightIndex = index;
      }
      worstErodibility = Math.max(
        worstErodibility,
        Math.abs(first.erodibility[index]! - cpu.erodibility[index]!),
      );
      worstRepose = Math.max(
        worstRepose,
        Math.abs(first.reposeDegrees[index]! - cpu.reposeDegrees[index]!),
      );
    }
    const meanHeight = sumHeight / cpu.heights.length;
    const timings = first.timings;
    console.log(
      "macro inputs GPU production run (1024², filter width 512):\n"
      + `  uniforms ${timings.uniformMilliseconds.toFixed(1)} ms, `
      + `dispatch ${timings.dispatchMilliseconds.toFixed(1)} ms, `
      + `readback ${timings.readbackMilliseconds.toFixed(1)} ms, `
      + `total ${timings.totalMilliseconds.toFixed(1)} ms\n`
      + `  parity: max |Δh| = ${worstHeight.toExponential(3)} m at cell ${worstHeightIndex}, `
      + `mean |Δh| = ${meanHeight.toExponential(3)} m, `
      + `max |Δerod| = ${worstErodibility.toExponential(3)}, `
      + `max |Δrepose| = ${worstRepose.toExponential(3)}° over ${cpu.heights.length} cells`,
    );
    // The max bound is dominated by isolated near-zeros of the fabric
    // direction field (see TERRAIN_UPLIFT_GPU_PARITY_CRITERIA); the mean
    // bound is what pins the landscape's overall agreement.
    expect(worstHeight, "production height parity (max)")
      .toBeLessThan(CRITERIA.productionHeightToleranceMeters);
    expect(meanHeight, "production height parity (mean)")
      .toBeLessThan(CRITERIA.productionMeanHeightToleranceMeters);
    expect(worstErodibility, "production erodibility parity")
      .toBeLessThan(CRITERIA.erodibilityTolerance);
    expect(worstRepose, "production repose parity")
      .toBeLessThan(CRITERIA.reposeToleranceDegrees);
  }, 300_000);

  it("keeps macro evolution extractable and population-stable on GPU inputs across seeds", async () => {
    // The downstream-amplification sweep: receiver flips at f32 ties are
    // EXPECTED; what must hold is that the traced channel graph never loses a
    // lake outlet (ChannelNetwork.extract throws at startup if it does) and
    // that lake/seed populations stay inside the pinned band.
    const rows: string[] = [];
    await withEngine(async (engine) => {
      const sampler = new TerrainMacroInputsGpu(engine);
      const evolution = new TerrainMacroEvolution();
      for (const seed of BAND.seeds) {
        const world = createWorld(seed, { worldEvolution: "eroded" });
        const request = { seedHash: world.seedHash, ...PRODUCTION_LAYOUT };
        const gpuInputs = await sampler.sampleMacroInputs(request);
        const cpuInputs = sampleTerrainMacroEvolutionInputs(request);

        // Input-surface delta (the quantity that seeds any receiver flip).
        let maxInputDelta = 0;
        let sumInputDelta = 0;
        for (let index = 0; index < cpuInputs.heights.length; index += 1) {
          const delta = Math.abs(gpuInputs.heights[index]! - cpuInputs.heights[index]!);
          maxInputDelta = Math.max(maxInputDelta, delta);
          sumInputDelta += delta;
        }

        const provenance = {
          worldSeed: world.seed,
          deviceFingerprint: sampler.deviceFingerprint,
        };
        const evolveInput = {
          width: PRODUCTION_LAYOUT.width,
          height: PRODUCTION_LAYOUT.height,
          texelSizeMeters: PRODUCTION_LAYOUT.texelSizeMeters,
          seaLevel: world.seaLevel,
        };
        const gpuExport = evolution.evolveExport(
          { ...evolveInput, ...gpuInputs },
          provenance,
        );
        const cpuExport = evolution.evolveExport(
          { ...evolveInput, ...cpuInputs },
          { worldSeed: world.seed, deviceFingerprint: "cpu-reference" },
        );

        // Extraction robustness: extract() itself validates the macro export
        // and resolves every meshed lake's outlet; a missing outlet throws.
        const graph = new ChannelNetwork().extract(gpuExport);
        const issues = validateTerrainChannelGraphExport(graph);
        expect(issues, `seed ${seed} channel graph issues`).toEqual([]);
        expect(graph.nodes.length, `seed ${seed} traced nodes`).toBeGreaterThan(0);

        // Evolved-surface delta: quantifies how far divergence amplified.
        let maxEvolvedDelta = 0;
        let sumEvolvedDelta = 0;
        for (let index = 0; index < cpuExport.heightMeters.length; index += 1) {
          const delta = Math.abs(
            gpuExport.heightMeters[index]! - cpuExport.heightMeters[index]!,
          );
          maxEvolvedDelta = Math.max(maxEvolvedDelta, delta);
          sumEvolvedDelta += delta;
        }

        const gpuLakes = gpuExport.lakes.length;
        const cpuLakes = cpuExport.lakes.length;
        const gpuSeeds = gpuExport.channelSeedTexelIndices.length;
        const cpuSeeds = cpuExport.channelSeedTexelIndices.length;
        rows.push(
          `seed ${seed}: lakes ${cpuLakes} cpu / ${gpuLakes} gpu, `
          + `channel seeds ${cpuSeeds} cpu / ${gpuSeeds} gpu, `
          + `graph ${graph.nodes.length} nodes / ${graph.lakes.length} meshed lakes; `
          + `input |Δh| max ${maxInputDelta.toExponential(2)} m `
          + `mean ${(sumInputDelta / cpuInputs.heights.length).toExponential(2)} m; `
          + `evolved |Δh| max ${maxEvolvedDelta.toExponential(2)} m `
          + `mean ${(sumEvolvedDelta / cpuExport.heightMeters.length).toExponential(2)} m`,
        );

        expect(
          Math.abs(gpuLakes - cpuLakes),
          `seed ${seed} lake population (cpu ${cpuLakes}, gpu ${gpuLakes})`,
        ).toBeLessThanOrEqual(
          Math.max(BAND.lakeCountAbsoluteFloor, BAND.lakeCountRelativeBand * cpuLakes),
        );
        expect(
          Math.abs(gpuSeeds - cpuSeeds),
          `seed ${seed} channel seed population (cpu ${cpuSeeds}, gpu ${gpuSeeds})`,
        ).toBeLessThanOrEqual(BAND.channelSeedRelativeBand * Math.max(1, cpuSeeds));
      }
      sampler.dispose();
    });
    console.log(`uplift GPU extraction sweep:\n  ${rows.join("\n  ")}`);
  }, 300_000);
});
