import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect import: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { withoutDispatchTiming } from "@/src/render/webgpu/core/GpuTimingPolicy";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";
import { MACRO_EVOLUTION_PRODUCTION_CONFIG } from "./TerrainMacroEvolution";
import {
  TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
  buildTerrainUpliftKernelPageUniform,
  composedTerrainUpliftKernelWgsl,
} from "./TerrainUpliftKernel";

/**
 * `W-1a` (Gate W): WGSL compute ports of the two embarrassingly parallel
 * macro-erosion operators — implicit stream-power incision and two-pass
 * thermal talus relaxation — the 2.0 s middle of the CPU macro benchmark
 * (169 ms + 1,851 ms on the reference host).
 *
 * The CPU reference in TerrainMacroEvolution.ts stays the oracle and is never
 * modified; per PHASE_6 deviation D-3 no bit-exact CPU==GPU parity is
 * attempted (the CPU operators accumulate in f64). The contracts here are:
 *
 * - GPU-vs-GPU bit determinism on one device: every pass is a pure per-cell
 *   gather over the previous buffer with fixed iteration counts, fixed
 *   neighbour order, no atomics and no workgroup-shared reductions, so bytes
 *   cannot depend on workgroup scheduling. The talus gather recomputes each
 *   neighbour's full excess distribution per cell (double ALU) instead of
 *   scattering, exactly so both passes stay per-cell pure functions.
 * - CPU-oracle tolerance parity, frozen in
 *   {@link TERRAIN_MACRO_EROSION_GPU_PARITY_CRITERIA} (measured-not-conceded,
 *   point count part of the criterion; tests/gpu/terrain-macro-erosion-gpu).
 * - Masked-cell restore: cells with `erosionMask >= 0.5` leave every operator
 *   with the exact input bits (each pass bit-copies them; the talus apply
 *   pass copies rather than adds an exactly-zero delta so `-0.0` survives).
 *
 * This pass runs ONCE at startup inside the hybrid eroded load; nothing
 * consumes per-frame dispatch timing, so every ComputeShader is wrapped in
 * withoutDispatchTiming (tests/render.gpu-timing-policy.test.ts).
 *
 * All config coefficients are injected into the WGSL from the TypeScript
 * config (TerrainKernel's injected-constant pattern) — never retyped.
 */

export interface TerrainMacroErosionGpuConfig {
  readonly streamPowerIterations: number;
  readonly streamPowerCoefficient: number;
  readonly streamPowerAreaExponent: number;
  readonly streamPowerTimeStep: number;
  readonly talusIterations: number;
  readonly talusTransferFraction: number;
}

export const TERRAIN_MACRO_EROSION_GPU_PRODUCTION_CONFIG: Readonly<TerrainMacroErosionGpuConfig> =
  Object.freeze({
    streamPowerIterations: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerIterations,
    streamPowerCoefficient: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerCoefficient,
    streamPowerAreaExponent: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerAreaExponent,
    streamPowerTimeStep: MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerTimeStep,
    talusIterations: MACRO_EVOLUTION_PRODUCTION_CONFIG.talusIterations,
    talusTransferFraction: MACRO_EVOLUTION_PRODUCTION_CONFIG.talusTransferFraction,
  });

/**
 * Frozen measured-criteria contract for CPU-oracle tolerance parity
 * (`TERRAIN_HEIGHT_PARITY_CRITERIA` doctrine: the point count is part of the
 * criterion; tolerances are measured, then pinned with ~2x headroom; the
 * achieved bound is console.logged by the test as a recorded measurement).
 *
 * Measured on the reference host (Apple silicon, ANGLE Metal, 2026-08-30):
 * - 64² fixture, 6 SP + 8 talus iterations: max |Δh| = 6.104e-4 m over all
 *   4,096 cells -> pinned 1.5e-3 m.
 * - 1024² production shape, 24 SP + 32 talus iterations: max |Δh| = 3.052e-3 m
 *   (strided criterion subset 262,144 points; full-grid bound identical)
 *   -> pinned 7.5e-3 m.
 * The divergence is the f64-internal CPU accumulation vs the f32 GPU chain
 * compounding over the fixed iteration counts — not a formulation difference.
 * Masked cells are excluded from tolerance because they are bit-exact.
 */
export const TERRAIN_MACRO_EROSION_GPU_PARITY_CRITERIA = Object.freeze({
  smallGridEdgeTexels: 64,
  smallGridStreamPowerIterations: 6,
  smallGridTalusIterations: 8,
  smallGridToleranceMeters: 0.0015,
  productionStrideTexels: 4,
  productionMinimumSamples: 262_144,
  productionToleranceMeters: 0.0075,
});

export interface TerrainMacroErosionGpuRunInputs {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  readonly seaLevel: number;
  /** Row-major f32 uplift surface (the operator input, not the filled surface). */
  readonly heights: Float32Array;
  /** Primary receivers from the first MFD pass; -1 terminates a chain. */
  readonly receivers: Int32Array;
  /** MFD contributing area in source texels. */
  readonly flowAccumulation: Float32Array;
  readonly erodibility: Float32Array;
  readonly reposeDegrees: Float32Array;
  /** Values >= 0.5 are restored bit-for-bit through every operator. */
  readonly erosionMask: Uint8Array;
}

export interface TerrainMacroErosionGpuTimings {
  readonly streamPowerMilliseconds: number;
  readonly talusMilliseconds: number;
  readonly readbackMilliseconds: number;
  readonly totalMilliseconds: number;
}

export interface TerrainMacroErosionGpuRunResult {
  readonly evolvedHeight: Float32Array;
  readonly timings: TerrainMacroErosionGpuTimings;
}

const WORKGROUP_EDGE = 8;

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function requireIterationCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

/** Emit a float literal WGSL accepts; injected constants are never retyped. */
function wgslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function resolveConfig(
  overrides: Partial<TerrainMacroErosionGpuConfig> | undefined,
): Readonly<TerrainMacroErosionGpuConfig> {
  const config: TerrainMacroErosionGpuConfig = {
    ...TERRAIN_MACRO_EROSION_GPU_PRODUCTION_CONFIG,
    ...overrides,
  };
  requireIterationCount(config.streamPowerIterations, "stream-power iterations");
  requireIterationCount(config.talusIterations, "talus iterations");
  if (!(config.streamPowerCoefficient >= 0)) {
    throw new RangeError("stream-power coefficient must be non-negative");
  }
  if (!(config.streamPowerAreaExponent > 0)) {
    throw new RangeError("stream-power area exponent must be positive");
  }
  if (!(config.streamPowerTimeStep >= 0)) {
    throw new RangeError("stream-power time step must be non-negative");
  }
  if (!(config.talusTransferFraction > 0 && config.talusTransferFraction <= 0.5)) {
    throw new RangeError("talus transfer fraction must be in (0, 0.5]");
  }
  return Object.freeze(config);
}

/** Params are per-run data; config coefficients are compiled-in constants. */
export const MACRO_EROSION_PARAMS_WGSL = /* wgsl */ `
struct MacroErosionParams {
  width: u32,
  height: u32,
  seaLevel: f32,
  texelSizeMeters: f32,
};
@group(0) @binding(0) var<storage, read> params: MacroErosionParams;
`;

/**
 * The 8-neighbour order and distances are the CPU reference's NEIGHBOURS
 * table verbatim; a fixed order keeps every f32 summation bit-reproducible.
 */
export function neighbourhoodWgsl(): string {
  return /* wgsl */ `
const K_SQRT2: f32 = ${wgslFloat(Math.SQRT2)};

fn kNeighbourOffset(order: u32) -> vec2i {
  switch (order) {
    case 0u: { return vec2i(-1, -1); }
    case 1u: { return vec2i(0, -1); }
    case 2u: { return vec2i(1, -1); }
    case 3u: { return vec2i(-1, 0); }
    case 4u: { return vec2i(1, 0); }
    case 5u: { return vec2i(-1, 1); }
    case 6u: { return vec2i(0, 1); }
    default: { return vec2i(1, 1); }
  }
}

fn kNeighbourDistance(order: u32) -> f32 {
  switch (order) {
    case 1u, 3u, 4u, 6u: { return 1.0; }
    default: { return K_SQRT2; }
  }
}
`;
}

/**
 * One implicit-Jacobi stream-power iteration: a pure gather over `heightIn`.
 * Mirrors applyStreamPowerIncision's per-iteration body exactly, including
 * the skip conditions; skipped cells bit-copy through.
 */
export function streamPowerWgsl(config: TerrainMacroErosionGpuConfig): string {
  return /* wgsl */ `
${MACRO_EROSION_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> heightIn: array<f32>;
@group(0) @binding(2) var<storage, read> receivers: array<i32>;
@group(0) @binding(3) var<storage, read> flowAccumulation: array<f32>;
@group(0) @binding(4) var<storage, read> erodibility: array<f32>;
@group(0) @binding(5) var<storage, read> erosionMask: array<u32>;
@group(0) @binding(6) var<storage, read_write> heightOut: array<f32>;

const K_SP_COEFFICIENT: f32 = ${wgslFloat(config.streamPowerCoefficient)};
const K_SP_AREA_EXPONENT: f32 = ${wgslFloat(config.streamPowerAreaExponent)};
const K_SP_TIME_STEP: f32 = ${wgslFloat(config.streamPowerTimeStep)};

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  let current = heightIn[index];
  // Bit-copy default: skipped and masked cells carry their exact input bits.
  heightOut[index] = current;
  if (erosionMask[index] != 0u || current <= params.seaLevel) { return; }
  let receiver = receivers[index];
  if (receiver < 0 || receiver >= i32(params.width * params.height)) { return; }
  let receiverHeight = heightIn[u32(receiver)];
  if (!(current > receiverHeight)) { return; }
  let localK = max(0.0, erodibility[index]);
  let area = max(1.0, flowAccumulation[index]);
  let c = K_SP_COEFFICIENT * localK * pow(area, K_SP_AREA_EXPONENT) * K_SP_TIME_STEP
    / params.texelSizeMeters;
  if (!(c > 0.0)) { return; }
  heightOut[index] = max(receiverHeight, (current + c * receiverHeight) / (1.0 + c));
}
`;
}

/**
 * Talus pass 1: per-cell delta as (inflow gathered from neighbours) minus
 * (this cell's own outflow). Each neighbour's full excess distribution is
 * recomputed so the pass stays a pure gather — no atomics, no scatter.
 */
export function talusGatherWgsl(config: TerrainMacroErosionGpuConfig): string {
  return /* wgsl */ `
${MACRO_EROSION_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> heightIn: array<f32>;
@group(0) @binding(2) var<storage, read> reposeDegrees: array<f32>;
@group(0) @binding(3) var<storage, read> erosionMask: array<u32>;
@group(0) @binding(4) var<storage, read_write> delta: array<f32>;

${neighbourhoodWgsl()}
const K_TALUS_TRANSFER_FRACTION: f32 = ${wgslFloat(config.talusTransferFraction)};
const K_PI: f32 = ${wgslFloat(Math.PI)};

// For a source cell KNOWN to be non-rim and unmasked: x = the cell's total
// moved mass ('available'), y = the share routed to targetIndex (0 when the
// target is not a candidate). targetIndex < 0 requests only x.
// Mirrors applyThermalTalusRelaxation's pass-1 body: excess over
// tan(repose) * texelSize * distance toward each unmasked lower neighbour,
// available = min(excessSum * transferFraction, (h - minNeighbour) * 0.5),
// distributed proportional to excess.
fn talusOutflow(sourceX: u32, sourceZ: u32, targetIndex: i32) -> vec2f {
  let sourceIndex = sourceZ * params.width + sourceX;
  let repose = reposeDegrees[sourceIndex];
  if (!(repose > 0.0 && repose < 90.0)) { return vec2f(0.0, 0.0); }
  let tangent = tan(repose * K_PI / 180.0);
  let sourceHeight = heightIn[sourceIndex];
  var excessSum = 0.0;
  var excessToTarget = 0.0;
  var minimumNeighbour = sourceHeight;
  for (var order = 0u; order < 8u; order = order + 1u) {
    let offset = kNeighbourOffset(order);
    // The source is non-rim, so all eight neighbours are in-grid.
    let neighbourIndex = u32(i32(sourceZ) + offset.y) * params.width
      + u32(i32(sourceX) + offset.x);
    if (erosionMask[neighbourIndex] != 0u) { continue; }
    let neighbourHeight = heightIn[neighbourIndex];
    minimumNeighbour = min(minimumNeighbour, neighbourHeight);
    let excess = sourceHeight - neighbourHeight
      - tangent * params.texelSizeMeters * kNeighbourDistance(order);
    if (!(excess > 0.0)) { continue; }
    excessSum = excessSum + excess;
    if (i32(neighbourIndex) == targetIndex) { excessToTarget = excess; }
  }
  if (!(excessSum > 0.0)) { return vec2f(0.0, 0.0); }
  let available = min(
    excessSum * K_TALUS_TRANSFER_FRACTION,
    max(0.0, (sourceHeight - minimumNeighbour) * 0.5),
  );
  var share = 0.0;
  if (excessToTarget > 0.0) { share = available * excessToTarget / excessSum; }
  return vec2f(available, share);
}

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  var outflow = 0.0;
  var inflow = 0.0;
  // Masked cells neither give (rim/mask skip) nor receive (candidates exclude
  // masked neighbours), so their delta is exactly zero.
  if (erosionMask[index] == 0u) {
    let onRim = id.x == 0u || id.y == 0u
      || id.x == params.width - 1u || id.y == params.height - 1u;
    if (!onRim) {
      outflow = talusOutflow(id.x, id.y, -1).x;
    }
    for (var order = 0u; order < 8u; order = order + 1u) {
      let offset = kNeighbourOffset(order);
      let sourceX = i32(id.x) + offset.x;
      let sourceZ = i32(id.y) + offset.y;
      // Only non-rim sources move mass; non-rim implies in-grid.
      if (sourceX <= 0 || sourceZ <= 0
        || sourceX >= i32(params.width) - 1 || sourceZ >= i32(params.height) - 1) {
        continue;
      }
      let sourceIndex = u32(sourceZ) * params.width + u32(sourceX);
      if (erosionMask[sourceIndex] != 0u) { continue; }
      inflow = inflow + talusOutflow(u32(sourceX), u32(sourceZ), i32(index)).y;
    }
  }
  delta[index] = inflow - outflow;
}
`;
}

/**
 * Talus pass 2: apply the gathered deltas. An exactly-zero delta bit-copies
 * the input so masked (and untouched) cells preserve their bits, including
 * signed zero.
 */
export const TALUS_APPLY_WGSL = /* wgsl */ `
${MACRO_EROSION_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> heightIn: array<f32>;
@group(0) @binding(2) var<storage, read> delta: array<f32>;
@group(0) @binding(3) var<storage, read_write> heightOut: array<f32>;

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  let current = heightIn[index];
  let cellDelta = delta[index];
  if (cellDelta == 0.0) {
    heightOut[index] = current;
  } else {
    heightOut[index] = current + cellDelta;
  }
}
`;

interface GpuBuffers {
  readonly count: number;
  /** Bytes this set reports to the renderer's memory-inventory floor. */
  readonly inventoriedBytes: number;
  readonly params: StorageBuffer;
  readonly heightA: StorageBuffer;
  readonly heightB: StorageBuffer;
  readonly delta: StorageBuffer;
  readonly receivers: StorageBuffer;
  readonly flowAccumulation: StorageBuffer;
  readonly erodibility: StorageBuffer;
  readonly reposeDegrees: StorageBuffer;
  readonly erosionMask: StorageBuffer;
}

interface GpuShaders {
  readonly streamPowerFromA: ComputeShader;
  readonly streamPowerFromB: ComputeShader;
  readonly talusGatherFromA: ComputeShader;
  readonly talusGatherFromB: ComputeShader;
  readonly talusApplyAtoB: ComputeShader;
  readonly talusApplyBtoA: ComputeShader;
}

/**
 * One-shot GPU producer for the hybrid eroded load path. Construct once with
 * the engine (config overrides are a test-only seam; production uses the
 * frozen macro constants), call {@link run} with stage-1 fields, dispose when
 * startup completes so the ~36 MiB of 1024² scratch returns before pages
 * allocate.
 */
export class TerrainMacroErosionGpu {
  readonly config: Readonly<TerrainMacroErosionGpuConfig>;
  /**
   * Hybrid provenance label: same-device bit reproducibility is the contract,
   * cross-device identity is explicitly NOT (D-3), so the fingerprint names
   * the GPU path and the adapter.
   */
  readonly deviceFingerprint: string;
  private readonly engine: WebGPUEngine;
  private buffers: GpuBuffers | null = null;
  private shaders: GpuShaders | null = null;
  private disposed = false;

  constructor(engine: WebGPUEngine, config: Partial<TerrainMacroErosionGpuConfig> = {}) {
    this.engine = engine;
    this.config = resolveConfig(config);
    this.deviceFingerprint = describeGpuMacroFingerprint(engine);
  }

  async run(inputs: TerrainMacroErosionGpuRunInputs): Promise<TerrainMacroErosionGpuRunResult> {
    if (this.disposed) throw new Error("TerrainMacroErosionGpu is disposed");
    const width = requirePositiveInteger(inputs.width, "macro erosion width");
    const height = requirePositiveInteger(inputs.height, "macro erosion height");
    if (width < 3 || height < 3) {
      throw new RangeError("macro erosion grids must be at least 3 by 3 texels");
    }
    if (!(inputs.texelSizeMeters > 0) || !Number.isFinite(inputs.texelSizeMeters)) {
      throw new RangeError("macro erosion texel size must be positive");
    }
    if (!Number.isFinite(inputs.seaLevel)) throw new RangeError("seaLevel must be finite");
    const count = width * height;
    for (const [label, field] of [
      ["heights", inputs.heights],
      ["receivers", inputs.receivers],
      ["flowAccumulation", inputs.flowAccumulation],
      ["erodibility", inputs.erodibility],
      ["reposeDegrees", inputs.reposeDegrees],
      ["erosionMask", inputs.erosionMask],
    ] as const) {
      if (field.length !== count) {
        throw new RangeError(`macro erosion ${label} must contain exactly ${count} values`);
      }
    }

    const startedAt = performance.now();
    const buffers = this.ensureBuffers(count);
    const shaders = this.ensureShaders(buffers);

    const paramsBytes = new ArrayBuffer(16);
    const paramsU32 = new Uint32Array(paramsBytes);
    const paramsF32 = new Float32Array(paramsBytes);
    paramsU32[0] = width;
    paramsU32[1] = height;
    paramsF32[2] = inputs.seaLevel;
    paramsF32[3] = inputs.texelSizeMeters;
    buffers.params.update(new Uint8Array(paramsBytes));
    buffers.heightA.update(inputs.heights);
    buffers.receivers.update(inputs.receivers);
    buffers.flowAccumulation.update(inputs.flowAccumulation);
    buffers.erodibility.update(inputs.erodibility);
    buffers.reposeDegrees.update(inputs.reposeDegrees);
    // The CPU contract thresholds mask values at 0.5; bake the comparison so
    // the WGSL reads a plain 0/1 word per cell.
    const mask = new Uint32Array(count);
    for (let index = 0; index < count; index += 1) {
      if (inputs.erosionMask[index]! >= 0.5) mask[index] = 1;
    }
    buffers.erosionMask.update(mask);

    const groupsX = Math.ceil(width / WORKGROUP_EDGE);
    const groupsY = Math.ceil(height / WORKGROUP_EDGE);
    let readFromA = true;

    // Stream power: one dispatch per implicit-Jacobi iteration, ping-pong.
    const streamPowerStartedAt = performance.now();
    for (let iteration = 0; iteration < this.config.streamPowerIterations; iteration += 1) {
      const shader = readFromA ? shaders.streamPowerFromA : shaders.streamPowerFromB;
      await dispatch(shader, groupsX, groupsY);
      readFromA = !readFromA;
    }
    await this.waitForGpuIdle(buffers);
    const streamPowerMilliseconds = performance.now() - streamPowerStartedAt;

    // Talus: gather deltas (pure per-cell function of the current surface),
    // then apply into the other buffer; two dispatches per iteration.
    const talusStartedAt = performance.now();
    for (let iteration = 0; iteration < this.config.talusIterations; iteration += 1) {
      await dispatch(
        readFromA ? shaders.talusGatherFromA : shaders.talusGatherFromB,
        groupsX,
        groupsY,
      );
      await dispatch(
        readFromA ? shaders.talusApplyAtoB : shaders.talusApplyBtoA,
        groupsX,
        groupsY,
      );
      readFromA = !readFromA;
    }
    await this.waitForGpuIdle(buffers);
    const talusMilliseconds = performance.now() - talusStartedAt;

    const readbackStartedAt = performance.now();
    const finalBuffer = readFromA ? buffers.heightA : buffers.heightB;
    const view = await finalBuffer.read(0, count * 4, undefined, true);
    const evolvedHeight = new Float32Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + count * 4),
    );
    const readbackMilliseconds = performance.now() - readbackStartedAt;

    return Object.freeze({
      evolvedHeight,
      timings: Object.freeze({
        streamPowerMilliseconds,
        talusMilliseconds,
        readbackMilliseconds,
        totalMilliseconds: performance.now() - startedAt,
      }),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseBuffers();
    this.shaders = null;
  }

  private releaseBuffers(): void {
    const buffers = this.buffers;
    if (!buffers) return;
    this.buffers = null;
    buffers.params.dispose();
    buffers.heightA.dispose();
    buffers.heightB.dispose();
    buffers.delta.dispose();
    buffers.receivers.dispose();
    buffers.flowAccumulation.dispose();
    buffers.erodibility.dispose();
    buffers.reposeDegrees.dispose();
    buffers.erosionMask.dispose();
    releaseGpuBufferBytes(buffers.inventoriedBytes);
  }

  private ensureBuffers(count: number): GpuBuffers {
    if (this.buffers?.count === count) return this.buffers;
    this.releaseBuffers();
    // A rebind invalidates the cached shader bind groups; recreate shaders
    // against the new buffers.
    this.shaders = null;
    const engine = this.engine;
    const bytes = count * 4;
    // DEFAULT creation flags on purpose: STORAGE|READ drops WRITE and
    // update() silently does nothing (the recorded StorageBuffer trap).
    this.buffers = Object.freeze({
      count,
      params: new StorageBuffer(engine, 16, undefined, "macroErosionParams"),
      heightA: new StorageBuffer(engine, bytes, undefined, "macroErosionHeightA"),
      heightB: new StorageBuffer(engine, bytes, undefined, "macroErosionHeightB"),
      delta: new StorageBuffer(engine, bytes, undefined, "macroErosionDelta"),
      receivers: new StorageBuffer(engine, bytes, undefined, "macroErosionReceivers"),
      flowAccumulation: new StorageBuffer(engine, bytes, undefined, "macroErosionFlow"),
      erodibility: new StorageBuffer(engine, bytes, undefined, "macroErosionErodibility"),
      reposeDegrees: new StorageBuffer(engine, bytes, undefined, "macroErosionRepose"),
      erosionMask: new StorageBuffer(engine, bytes, undefined, "macroErosionMask"),
      // Gate 0-c: the renderer's inventory walks textures and geometry only,
      // so scratch this size is invisible to the memory wall unless it says so.
      inventoriedBytes: 16 + bytes * 8,
    });
    registerGpuBufferBytes(this.buffers.inventoriedBytes);
    return this.buffers;
  }

  private ensureShaders(buffers: GpuBuffers): GpuShaders {
    if (this.shaders) return this.shaders;
    const engine = this.engine;
    const streamPowerSource = streamPowerWgsl(this.config);
    const gatherSource = talusGatherWgsl(this.config);

    const streamPowerShader = (name: string): ComputeShader =>
      withoutDispatchTiming(new ComputeShader(
        name,
        engine,
        { computeSource: streamPowerSource },
        {
          bindingsMapping: {
            params: { group: 0, binding: 0 },
            heightIn: { group: 0, binding: 1 },
            receivers: { group: 0, binding: 2 },
            flowAccumulation: { group: 0, binding: 3 },
            erodibility: { group: 0, binding: 4 },
            erosionMask: { group: 0, binding: 5 },
            heightOut: { group: 0, binding: 6 },
          },
        },
      ));
    const gatherShader = (name: string): ComputeShader =>
      withoutDispatchTiming(new ComputeShader(
        name,
        engine,
        { computeSource: gatherSource },
        {
          bindingsMapping: {
            params: { group: 0, binding: 0 },
            heightIn: { group: 0, binding: 1 },
            reposeDegrees: { group: 0, binding: 2 },
            erosionMask: { group: 0, binding: 3 },
            delta: { group: 0, binding: 4 },
          },
        },
      ));
    const applyShader = (name: string): ComputeShader =>
      withoutDispatchTiming(new ComputeShader(
        name,
        engine,
        { computeSource: TALUS_APPLY_WGSL },
        {
          bindingsMapping: {
            params: { group: 0, binding: 0 },
            heightIn: { group: 0, binding: 1 },
            delta: { group: 0, binding: 2 },
            heightOut: { group: 0, binding: 3 },
          },
        },
      ));

    const streamPowerFromA = streamPowerShader("macro-erosion-stream-power-a");
    const streamPowerFromB = streamPowerShader("macro-erosion-stream-power-b");
    for (const [shader, input, output] of [
      [streamPowerFromA, buffers.heightA, buffers.heightB],
      [streamPowerFromB, buffers.heightB, buffers.heightA],
    ] as const) {
      shader.setStorageBuffer("params", buffers.params);
      shader.setStorageBuffer("heightIn", input);
      shader.setStorageBuffer("receivers", buffers.receivers);
      shader.setStorageBuffer("flowAccumulation", buffers.flowAccumulation);
      shader.setStorageBuffer("erodibility", buffers.erodibility);
      shader.setStorageBuffer("erosionMask", buffers.erosionMask);
      shader.setStorageBuffer("heightOut", output);
    }

    const talusGatherFromA = gatherShader("macro-erosion-talus-gather-a");
    const talusGatherFromB = gatherShader("macro-erosion-talus-gather-b");
    for (const [shader, input] of [
      [talusGatherFromA, buffers.heightA],
      [talusGatherFromB, buffers.heightB],
    ] as const) {
      shader.setStorageBuffer("params", buffers.params);
      shader.setStorageBuffer("heightIn", input);
      shader.setStorageBuffer("reposeDegrees", buffers.reposeDegrees);
      shader.setStorageBuffer("erosionMask", buffers.erosionMask);
      shader.setStorageBuffer("delta", buffers.delta);
    }

    const talusApplyAtoB = applyShader("macro-erosion-talus-apply-ab");
    const talusApplyBtoA = applyShader("macro-erosion-talus-apply-ba");
    for (const [shader, input, output] of [
      [talusApplyAtoB, buffers.heightA, buffers.heightB],
      [talusApplyBtoA, buffers.heightB, buffers.heightA],
    ] as const) {
      shader.setStorageBuffer("params", buffers.params);
      shader.setStorageBuffer("heightIn", input);
      shader.setStorageBuffer("delta", buffers.delta);
      shader.setStorageBuffer("heightOut", output);
    }

    this.shaders = Object.freeze({
      streamPowerFromA,
      streamPowerFromB,
      talusGatherFromA,
      talusGatherFromB,
      talusApplyAtoB,
      talusApplyBtoA,
    });
    return this.shaders;
  }

  /**
   * Flush the recorded dispatches and wait for completion (tiny noDelay read;
   * startup has no render loop pumping frames, so the flush must be explicit).
   * The final height buffer is never rewritten after its producing dispatch,
   * so a plain awaited read is safe without the bounds-ring pattern — that
   * ring exists for per-frame atomics that get re-seeded.
   */
  private async waitForGpuIdle(buffers: GpuBuffers): Promise<void> {
    await buffers.params.read(0, 4, undefined, true);
  }
}

/**
 * Deadline for a compute pipeline to become dispatchable. A pipeline that has
 * not compiled in this long is not going to.
 */
const TERRAIN_MACRO_DISPATCH_TIMEOUT_MILLISECONDS = 10_000;
const TERRAIN_MACRO_DISPATCH_POLL_MILLISECONDS = 16;

async function dispatch(shader: ComputeShader, groupsX: number, groupsY: number): Promise<void> {
  // dispatch() returns false only while the pipeline is still compiling.
  if (shader.dispatch(groupsX, groupsY, 1)) return;
  // Babylon's `dispatchWhenReady` NEVER SETTLES when the pipeline fails to
  // compile — it polls, gives up, and leaves the promise pending forever. The
  // sampling leg's whole contract is to fail OPEN to the worker's CPU twin,
  // and a promise that never settles cannot be caught: the load would instead
  // hang to the 180 s evolution-startup timeout on any adapter that rejects
  // this WGSL. So poll with a deadline and REJECT, the way the water stack's
  // `dispatchBathymetryComputeWhenReady` already does for the same reason.
  await new Promise<void>((resolve, reject) => {
    const startedAt = performance.now();
    const previousError = shader.onError;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (shader.onError === onError) shader.onError = previousError;
      if (error) reject(error);
      else resolve();
    };
    const onError: NonNullable<ComputeShader["onError"]> = (effect, errors): void => {
      try {
        previousError?.(effect, errors);
      } finally {
        finish(new Error(`Unable to compile ${shader.name}: ${errors || "unknown WGSL error"}`));
      }
    };
    shader.onError = onError;
    const poll = (): void => {
      if (settled) return;
      if (shader.dispatch(groupsX, groupsY, 1)) {
        finish();
        return;
      }
      if (performance.now() - startedAt >= TERRAIN_MACRO_DISPATCH_TIMEOUT_MILLISECONDS) {
        finish(new Error(
          `${shader.name} was not dispatchable within `
          + `${TERRAIN_MACRO_DISPATCH_TIMEOUT_MILLISECONDS} ms`,
        ));
        return;
      }
      setTimeout(poll, TERRAIN_MACRO_DISPATCH_POLL_MILLISECONDS);
    };
    setTimeout(poll, TERRAIN_MACRO_DISPATCH_POLL_MILLISECONDS);
  });
}

// ---------------------------------------------------------------------------
// `W-1b`: the macro INPUT sampling pass — GPU twins of the two erosion input
// samplers (sampleTerrainUpliftHeight / sampleTerrainEvolutionGeology),
// batched over the production cell-centred macro grid.
// ---------------------------------------------------------------------------

/**
 * Same shape as the worker runtime's TerrainMacroUpliftSamplingInput: cell
 * centres at `minWorld + texel/2 + i*texel`, filter width = texel size. The
 * GPU pass MUST evaluate the same points with the same footprint the CPU
 * sampler does, or the two producers stop describing one landscape.
 */
export interface TerrainMacroInputsGpuRequest {
  readonly seedHash: number;
  readonly width: number;
  readonly height: number;
  /** World coordinate of the OUTER grid edge; samples are cell-centred. */
  readonly minWorldX: number;
  readonly minWorldZ: number;
  readonly texelSizeMeters: number;
}

export interface TerrainMacroInputsGpuTimings {
  readonly uniformMilliseconds: number;
  readonly dispatchMilliseconds: number;
  readonly readbackMilliseconds: number;
  readonly totalMilliseconds: number;
}

export interface TerrainMacroInputsGpuResult {
  readonly heights: Float32Array;
  readonly erodibility: Float32Array;
  readonly reposeDegrees: Float32Array;
  readonly timings: TerrainMacroInputsGpuTimings;
}

/**
 * Cells per page tile. The split-origin doctrine wants local offsets small;
 * 64 cells × 512 m = 32,768 m of page extent keeps every local coordinate an
 * exact f32 (multiples of half a texel) while a 1024² grid needs only 16×16
 * page uniforms (~296 KB).
 */
const MACRO_INPUTS_PAGE_EDGE_CELLS = 64;

const MACRO_INPUTS_WGSL = /* wgsl */ `
struct MacroInputsParams {
  width: u32,
  height: u32,
  pagesPerRow: u32,
  pageEdgeCells: u32,
  texelSizeMeters: f32,
  halfTexelMeters: f32,
  pad0: f32,
  pad1: f32,
};
@group(0) @binding(0) var<storage, read> params: MacroInputsParams;
${
  // Binding 5 is the DEAD height-kernel page binding: required for the
  // composed source to type-check, pruned by Tint (nothing reachable reads
  // it), and deliberately absent from bindingsMapping below.
  composedTerrainUpliftKernelWgsl(0, 1, 5)
}
@group(0) @binding(2) var<storage, read_write> heightsOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> erodibilityOut: array<f32>;
@group(0) @binding(4) var<storage, read_write> reposeOut: array<f32>;

@compute @workgroup_size(${WORKGROUP_EDGE}, ${WORKGROUP_EDGE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let index = id.y * params.width + id.x;
  let page = (id.y / params.pageEdgeCells) * params.pagesPerRow
    + (id.x / params.pageEdgeCells);
  kSelectPage(page);
  let localX = params.halfTexelMeters
    + f32(id.x % params.pageEdgeCells) * params.texelSizeMeters;
  let localZ = params.halfTexelMeters
    + f32(id.y % params.pageEdgeCells) * params.texelSizeMeters;
  heightsOut[index] = terrainUpliftHeight(localX, localZ);
  let geology = terrainEvolutionGeologySample(localX, localZ);
  erodibilityOut[index] = geology.z;
  reposeOut[index] = geology.w;
}
`;

interface MacroInputsBuffers {
  readonly count: number;
  /** Bytes this set reports to the renderer's memory-inventory floor. */
  readonly inventoriedBytes: number;
  readonly pageCount: number;
  readonly params: StorageBuffer;
  readonly pages: StorageBuffer;
  readonly heights: StorageBuffer;
  readonly erodibility: StorageBuffer;
  readonly repose: StorageBuffer;
}

/**
 * One-shot GPU producer for the macro-erosion INPUT fields (`W-1b`): the
 * WGSL twins of `sampleTerrainUpliftHeight`/`sampleTerrainEvolutionGeology`
 * batched over the cell-centred macro grid. Pure per-cell function of the
 * page uniforms — no atomics, no shared memory — so one device produces
 * identical bytes on every run (the D-3 determinism contract). CPU-oracle
 * agreement is tolerance-tier, frozen in TERRAIN_UPLIFT_GPU_PARITY_CRITERIA.
 *
 * Runs during startup with no render loop pumping frames: every readback is
 * an explicit noDelay flush, mirroring TerrainMacroErosionGpu. Dispose when
 * the hybrid load completes so the ~12.3 MiB of 1024² outputs returns.
 */
export class TerrainMacroInputsGpu {
  readonly deviceFingerprint: string;
  private readonly engine: WebGPUEngine;
  private buffers: MacroInputsBuffers | null = null;
  private shader: ComputeShader | null = null;
  private disposed = false;

  constructor(engine: WebGPUEngine) {
    this.engine = engine;
    this.deviceFingerprint = describeGpuMacroFingerprint(engine);
  }

  async sampleMacroInputs(
    request: TerrainMacroInputsGpuRequest,
  ): Promise<TerrainMacroInputsGpuResult> {
    if (this.disposed) throw new Error("TerrainMacroInputsGpu is disposed");
    const width = requirePositiveInteger(request.width, "macro inputs width");
    const height = requirePositiveInteger(request.height, "macro inputs height");
    if (!Number.isSafeInteger(request.seedHash)) {
      throw new RangeError("macro inputs seedHash must be a safe integer");
    }
    if (!Number.isFinite(request.minWorldX) || !Number.isFinite(request.minWorldZ)) {
      throw new RangeError("macro inputs origin must be finite");
    }
    if (!(request.texelSizeMeters > 0) || !Number.isFinite(request.texelSizeMeters)) {
      throw new RangeError("macro inputs texel size must be positive");
    }

    const startedAt = performance.now();
    const texel = request.texelSizeMeters;
    const pageEdge = MACRO_INPUTS_PAGE_EDGE_CELLS;
    const pagesPerRow = Math.ceil(width / pageEdge);
    const pageRows = Math.ceil(height / pageEdge);
    const pageCount = pagesPerRow * pageRows;
    const count = width * height;
    const buffers = this.ensureBuffers(count, pageCount);
    const shader = this.ensureShader(buffers);

    // Page origins stay f64 until buildTerrainUpliftKernelPageUniform splits
    // them; the filter width IS the texel size (the CPU sampler's contract).
    const packedPages = new Uint8Array(pageCount * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES);
    for (let pageZ = 0; pageZ < pageRows; pageZ += 1) {
      for (let pageX = 0; pageX < pagesPerRow; pageX += 1) {
        const pageUniform = buildTerrainUpliftKernelPageUniform({
          seedHash: request.seedHash,
          originX: request.minWorldX + pageX * pageEdge * texel,
          originZ: request.minWorldZ + pageZ * pageEdge * texel,
          filterWidthMeters: texel,
        });
        packedPages.set(
          new Uint8Array(pageUniform),
          (pageZ * pagesPerRow + pageX) * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
        );
      }
    }
    buffers.pages.update(packedPages);

    const paramsBytes = new ArrayBuffer(32);
    const paramsU32 = new Uint32Array(paramsBytes);
    const paramsF32 = new Float32Array(paramsBytes);
    paramsU32[0] = width;
    paramsU32[1] = height;
    paramsU32[2] = pagesPerRow;
    paramsU32[3] = pageEdge;
    paramsF32[4] = texel;
    paramsF32[5] = texel * 0.5;
    buffers.params.update(new Uint8Array(paramsBytes));
    const uniformMilliseconds = performance.now() - startedAt;

    const dispatchStartedAt = performance.now();
    await dispatch(shader, Math.ceil(width / WORKGROUP_EDGE), Math.ceil(height / WORKGROUP_EDGE));
    // Explicit flush + completion fence: a tiny noDelay read, because startup
    // has no render loop to submit the recorded encoder.
    await buffers.params.read(0, 4, undefined, true);
    const dispatchMilliseconds = performance.now() - dispatchStartedAt;

    const readbackStartedAt = performance.now();
    const copyOut = async (buffer: StorageBuffer): Promise<Float32Array> => {
      const view = await buffer.read(0, count * 4, undefined, true);
      return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + count * 4));
    };
    const heights = await copyOut(buffers.heights);
    const erodibility = await copyOut(buffers.erodibility);
    const reposeDegrees = await copyOut(buffers.repose);
    const readbackMilliseconds = performance.now() - readbackStartedAt;

    return Object.freeze({
      heights,
      erodibility,
      reposeDegrees,
      timings: Object.freeze({
        uniformMilliseconds,
        dispatchMilliseconds,
        readbackMilliseconds,
        totalMilliseconds: performance.now() - startedAt,
      }),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseBuffers();
    this.shader = null;
  }

  private releaseBuffers(): void {
    const buffers = this.buffers;
    if (!buffers) return;
    this.buffers = null;
    buffers.params.dispose();
    buffers.pages.dispose();
    buffers.heights.dispose();
    buffers.erodibility.dispose();
    buffers.repose.dispose();
    releaseGpuBufferBytes(buffers.inventoriedBytes);
  }

  private ensureBuffers(count: number, pageCount: number): MacroInputsBuffers {
    if (this.buffers?.count === count && this.buffers.pageCount === pageCount) {
      return this.buffers;
    }
    this.releaseBuffers();
    this.shader = null;
    const engine = this.engine;
    const bytes = count * 4;
    // DEFAULT creation flags on purpose (the recorded StorageBuffer trap).
    this.buffers = Object.freeze({
      count,
      pageCount,
      params: new StorageBuffer(engine, 32, undefined, "macroInputsParams"),
      pages: new StorageBuffer(
        engine,
        pageCount * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES,
        undefined,
        "macroInputsPages",
      ),
      heights: new StorageBuffer(engine, bytes, undefined, "macroInputsHeights"),
      erodibility: new StorageBuffer(engine, bytes, undefined, "macroInputsErodibility"),
      repose: new StorageBuffer(engine, bytes, undefined, "macroInputsRepose"),
      // Gate 0-c: invisible to the texture/geometry inventory without this.
      inventoriedBytes: 32 + pageCount * TERRAIN_UPLIFT_KERNEL_PAGE_BYTES + bytes * 3,
    });
    registerGpuBufferBytes(this.buffers.inventoriedBytes);
    return this.buffers;
  }

  private ensureShader(buffers: MacroInputsBuffers): ComputeShader {
    if (this.shader) return this.shader;
    const shader = withoutDispatchTiming(new ComputeShader(
      "macro-inputs-sampler",
      this.engine,
      { computeSource: MACRO_INPUTS_WGSL },
      {
        bindingsMapping: {
          // The dead terrainKernelPages binding (group 0, binding 5) is
          // pruned by Tint and must NOT be mapped or set.
          params: { group: 0, binding: 0 },
          upliftKernelPages: { group: 0, binding: 1 },
          heightsOut: { group: 0, binding: 2 },
          erodibilityOut: { group: 0, binding: 3 },
          reposeOut: { group: 0, binding: 4 },
        },
      },
    ));
    shader.setStorageBuffer("params", buffers.params);
    shader.setStorageBuffer("upliftKernelPages", buffers.pages);
    shader.setStorageBuffer("heightsOut", buffers.heights);
    shader.setStorageBuffer("erodibilityOut", buffers.erodibility);
    shader.setStorageBuffer("reposeOut", buffers.repose);
    this.shader = shader;
    return shader;
  }
}

/**
 * The BASE hybrid label: `gpu-macro-v1/<adapter>`. It names the device, not
 * the whole producer composition — when the macro INPUTS are also sampled on
 * device the landscape belongs to a different same-device family, and
 * TerrainEvolutionRuntime's `gpuSampledMacroFingerprint` re-families this
 * label accordingly. That composition lives there, not here, because only the
 * composer knows whether GPU sampling actually ran (it fails open to CPU).
 */
function describeGpuMacroFingerprint(engine: WebGPUEngine): string {
  try {
    const info = (engine as unknown as {
      getInfo?: () => { vendor?: string; renderer?: string };
    }).getInfo?.();
    const adapter = [info?.vendor, info?.renderer]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    return adapter ? `gpu-macro-v1/${adapter}` : "gpu-macro-v1";
  } catch {
    return "gpu-macro-v1";
  }
}
