import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
  type TerrainEvolutionProvenance,
} from "./TerrainEvolutionContract";

/**
 * Deterministic CPU reference for Phase 5's macro landscape evolution.
 *
 * The production renderer will execute equivalent fixed-pass operators on the
 * GPU.  This module deliberately has no Babylon import: it is the Class-K
 * oracle used by contract tests, small synthetic fixtures, and offline tuning.
 * Every loop count and coefficient is data, and none of them accepts a quality
 * tier or frame-time input.
 */

const SQRT_TWO = Math.SQRT2;

const NEIGHBOURS = Object.freeze([
  Object.freeze({ dx: -1, dz: -1, distance: SQRT_TWO }),
  Object.freeze({ dx: 0, dz: -1, distance: 1 }),
  Object.freeze({ dx: 1, dz: -1, distance: SQRT_TWO }),
  Object.freeze({ dx: -1, dz: 0, distance: 1 }),
  Object.freeze({ dx: 1, dz: 0, distance: 1 }),
  Object.freeze({ dx: -1, dz: 1, distance: SQRT_TWO }),
  Object.freeze({ dx: 0, dz: 1, distance: 1 }),
  Object.freeze({ dx: 1, dz: 1, distance: SQRT_TWO }),
] as const);

// Flattened mirrors of NEIGHBOURS, derived from it so the two can never drift.
// The hot gathers below walk these instead of the frozen object list: same
// order, same dx/dz, bit-identical distances, no property loads.
const NEIGHBOUR_COUNT = NEIGHBOURS.length;
const NEIGHBOUR_DX = Int32Array.from(NEIGHBOURS, (offset) => offset.dx);
const NEIGHBOUR_DZ = Int32Array.from(NEIGHBOURS, (offset) => offset.dz);
const NEIGHBOUR_DISTANCE = Float64Array.from(NEIGHBOURS, (offset) => offset.distance);

export const MACRO_FILL_EPSILON_METERS_PER_TEXEL = 1e-3;
export const MACRO_MFD_SLOPE_EXPONENT = 1.1;
export const MACRO_STREAM_POWER_ITERATIONS = 24;
export const MACRO_TALUS_ITERATIONS = 32;

export interface MacroEvolutionConfig {
  /** Small positive drainage gradient used to resolve filled flats. */
  readonly fillEpsilonMetersPerTexel: number;
  /** Freeman-style MFD exponent: `weight = positiveSlope ^ exponent`. */
  readonly mfdSlopeExponent: number;
  /** Fixed implicit-Jacobi incision count. */
  readonly streamPowerIterations: number;
  readonly streamPowerCoefficient: number;
  readonly streamPowerAreaExponent: number;
  readonly streamPowerTimeStep: number;
  /** Fixed mass-conserving two-pass talus count. */
  readonly talusIterations: number;
  readonly defaultReposeDegrees: number;
  /** Fraction of the available excess slope moved in one talus iteration. */
  readonly talusTransferFraction: number;
  /** Hydrological depth below which a filled cell is not a lake. */
  readonly minimumLakeDepthMeters: number;
  /** Accumulating texels required to export a channel seed. */
  readonly channelInitiationAreaTexels: number;
}

export const MACRO_EVOLUTION_PRODUCTION_CONFIG: Readonly<MacroEvolutionConfig> = Object.freeze({
  fillEpsilonMetersPerTexel: MACRO_FILL_EPSILON_METERS_PER_TEXEL,
  mfdSlopeExponent: MACRO_MFD_SLOPE_EXPONENT,
  streamPowerIterations: MACRO_STREAM_POWER_ITERATIONS,
  streamPowerCoefficient: 0.035,
  streamPowerAreaExponent: 0.5,
  streamPowerTimeStep: 1,
  talusIterations: MACRO_TALUS_ITERATIONS,
  defaultReposeDegrees: 34,
  talusTransferFraction: 0.25,
  minimumLakeDepthMeters: 0.01,
  channelInitiationAreaTexels: 256,
});

export interface MacroEvolutionInput {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  readonly seaLevel: number;
  /** Row-major bed/uplift elevations. The input is never mutated. */
  readonly heights: ArrayLike<number>;
  /** Optional spatial K field. */
  readonly erodibility?: ArrayLike<number>;
  /** Optional spatial angle-of-repose field, in degrees. */
  readonly reposeDegrees?: ArrayLike<number>;
  readonly config?: Partial<MacroEvolutionConfig>;
}

export interface MacroLakeExport {
  /** Stable, one-based identifier also written to `lakeMask`. */
  readonly id: number;
  readonly outletIndex: number;
  /** The first receiver outside the lake, or -1 at the open rim. */
  readonly outletReceiverIndex: number;
  readonly spillElevationMeters: number;
  readonly maxDepthMeters: number;
  readonly surfaceAreaM2: number;
  readonly texelCount: number;
}

export interface MacroBaseLevelExport {
  readonly id: number;
  readonly outletIndex: number;
  readonly elevationMeters: number;
}

export interface PriorityFloodResult {
  readonly filledHeight: Float32Array;
  /** Receiver used to break flats toward the open rim. */
  readonly floodParent: Int32Array;
  /** Low-to-high deterministic settlement order. */
  readonly settlementOrder: Uint32Array;
}

export interface MfdFlowResult {
  /** Primary receiver, used for graph topology and termination checks. */
  readonly receivers: Int32Array;
  /** Multiple-flow-direction contributing area, in source texels. */
  readonly flowAccumulation: Float32Array;
}

export interface MacroEvolutionResult {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  readonly evolvedHeight: Float32Array;
  readonly filledHeight: Float32Array;
  readonly receivers: Int32Array;
  readonly flowAccumulation: Float32Array;
  readonly lakeDepth: Float32Array;
  readonly lakeMask: Uint32Array;
  readonly lakes: readonly MacroLakeExport[];
  readonly basinIds: Uint32Array;
  readonly baseLevels: readonly MacroBaseLevelExport[];
  readonly channelSeeds: Uint32Array;
  readonly config: Readonly<MacroEvolutionConfig>;
}

/**
 * Binary min-heap over (elevation, index), held in parallel typed arrays.
 *
 * The ordering is the one the previous object-per-entry version expressed as
 * `(first.elevation - second.elevation) || (first.index - second.index)`. For
 * the finite elevations the flood produces, that subtraction is negative
 * exactly when `first.elevation < second.elevation` and falsy exactly when the
 * two are equal, so `compare(a, b) <= 0` is precisely
 * `ea < eb || (ea === eb && ia <= ib)` — spelled out below. The pop sequence is
 * therefore unchanged, which is what keeps the filled surface, the flood
 * parents and the settlement order bit-identical. What changes is that a
 * million-cell flood no longer allocates a million entry objects.
 */
class StableMinHeap {
  private readonly elevations: Float64Array;
  private readonly indices: Uint32Array;
  private length = 0;
  /** Key of the entry the most recent `pop` returned. */
  poppedElevation = 0;

  constructor(capacity: number) {
    this.elevations = new Float64Array(capacity);
    this.indices = new Uint32Array(capacity);
  }

  get size(): number {
    return this.length;
  }

  push(index: number, elevation: number): void {
    const elevations = this.elevations;
    const indices = this.indices;
    let child = this.length;
    this.length = child + 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const parentElevation = elevations[parent]!;
      const parentIndex = indices[parent]!;
      if (
        parentElevation < elevation
        || (parentElevation === elevation && parentIndex <= index)
      ) break;
      elevations[child] = parentElevation;
      indices[child] = parentIndex;
      child = parent;
    }
    elevations[child] = elevation;
    indices[child] = index;
  }

  /** Removes the minimum and returns its cell index; key in `poppedElevation`. */
  pop(): number {
    const elevations = this.elevations;
    const indices = this.indices;
    const rootIndex = indices[0]!;
    this.poppedElevation = elevations[0]!;
    const length = this.length - 1;
    this.length = length;
    if (length === 0) return rootIndex;
    const tailElevation = elevations[length]!;
    const tailIndex = indices[length]!;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      let child = left;
      let childElevation = elevations[left]!;
      let childIndex = indices[left]!;
      if (right < length) {
        const rightElevation = elevations[right]!;
        const rightIndex = indices[right]!;
        if (
          rightElevation < childElevation
          || (rightElevation === childElevation && rightIndex < childIndex)
        ) {
          child = right;
          childElevation = rightElevation;
          childIndex = rightIndex;
        }
      }
      if (
        tailElevation < childElevation
        || (tailElevation === childElevation && tailIndex <= childIndex)
      ) break;
      elevations[parent] = childElevation;
      indices[parent] = childIndex;
      parent = child;
    }
    elevations[parent] = tailElevation;
    indices[parent] = tailIndex;
    return rootIndex;
  }
}

function requireGrid(width: number, height: number, values: ArrayLike<number>, label: string): void {
  if (!Number.isSafeInteger(width) || width < 3 || !Number.isSafeInteger(height) || height < 3) {
    throw new RangeError("Evolution grids must be at least 3 by 3 texels");
  }
  if (values.length !== width * height) {
    throw new RangeError(`${label} must contain exactly ${width * height} values`);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) {
      throw new RangeError(`${label}[${index}] must be finite`);
    }
  }
}

function requirePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function requireNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return value;
}

function requireIterationCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function resolveMacroConfig(
  overrides: Partial<MacroEvolutionConfig> | undefined,
): Readonly<MacroEvolutionConfig> {
  const config: MacroEvolutionConfig = {
    ...MACRO_EVOLUTION_PRODUCTION_CONFIG,
    ...overrides,
  };
  requireNonNegative(config.fillEpsilonMetersPerTexel, "fill epsilon");
  requirePositive(config.mfdSlopeExponent, "MFD slope exponent");
  requireIterationCount(config.streamPowerIterations, "stream-power iterations");
  requireNonNegative(config.streamPowerCoefficient, "stream-power coefficient");
  requirePositive(config.streamPowerAreaExponent, "stream-power area exponent");
  requireNonNegative(config.streamPowerTimeStep, "stream-power time step");
  requireIterationCount(config.talusIterations, "talus iterations");
  if (!(config.defaultReposeDegrees > 0 && config.defaultReposeDegrees < 90)) {
    throw new RangeError("default repose must be between 0 and 90 degrees");
  }
  if (!(config.talusTransferFraction > 0 && config.talusTransferFraction <= 0.5)) {
    throw new RangeError("talus transfer fraction must be in (0, 0.5]");
  }
  requireNonNegative(config.minimumLakeDepthMeters, "minimum lake depth");
  requirePositive(config.channelInitiationAreaTexels, "channel initiation area");
  return Object.freeze(config);
}

const FLOAT32_KEY_VALUE = new Float32Array(1);
const FLOAT32_KEY_BITS = new Uint32Array(FLOAT32_KEY_VALUE.buffer);

/**
 * Indices ordered by (height descending, index descending) — the exact
 * permutation `sort((a, b) => (h[b] - h[a]) || (b - a))` produces, not merely
 * an equivalent one.
 *
 * When every height is exactly float32-representable — the production case,
 * where the drainage surface is a `Float32Array` — the order is produced by a
 * stable LSD radix sort over the standard monotonic float32-to-uint32 key.
 * That map is an order isomorphism on float32 bit patterns, so radix ascending
 * from the identity permutation yields (height asc, index asc) and reversing it
 * yields the comparator's order. `-0` is folded to `+0` first because the
 * comparator's subtraction treats the two as a tie. Any wider input (a
 * Float64Array carrying values a float32 cannot hold) falls back to the
 * comparator itself, so the contract holds for every caller.
 *
 * This matters for bits, not just speed: two cells at the same drainage height
 * never drain into each other, but they can share a lower receiver, and the
 * running `accumulation[receiver] +=` is float64 addition, which is not
 * associative. Any deviation from the comparator's tie-break moves bits.
 */
function orderByHeightDescending(heights: ArrayLike<number>, count: number): Uint32Array {
  const keys = new Uint32Array(count);
  const histograms = new Int32Array(4 * 256);
  let radixApplies = true;
  for (let index = 0; index < count; index += 1) {
    const value = heights[index]!;
    if (Math.fround(value) !== value) {
      radixApplies = false;
      break;
    }
    FLOAT32_KEY_VALUE[0] = value === 0 ? 0 : value;
    const bits = FLOAT32_KEY_BITS[0]!;
    const key = (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits ^ 0x80000000) >>> 0);
    keys[index] = key;
    const byte0 = key & 0xff;
    const byte1 = 256 + ((key >>> 8) & 0xff);
    const byte2 = 512 + ((key >>> 16) & 0xff);
    const byte3 = 768 + (key >>> 24);
    histograms[byte0] = histograms[byte0]! + 1;
    histograms[byte1] = histograms[byte1]! + 1;
    histograms[byte2] = histograms[byte2]! + 1;
    histograms[byte3] = histograms[byte3]! + 1;
  }
  if (!radixApplies) {
    const comparatorOrder = Array.from({ length: count }, (_, index) => index);
    comparatorOrder.sort((first, second) => {
      const elevation = heights[second]! - heights[first]!;
      return elevation || second - first;
    });
    return Uint32Array.from(comparatorOrder);
  }

  let source = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) source[index] = index;
  let target = new Uint32Array(count);
  let sourceKeys = keys;
  let targetKeys = new Uint32Array(count);
  const offsets = new Int32Array(256);
  for (let pass = 0; pass < 4; pass += 1) {
    const shift = pass * 8;
    const base = pass * 256;
    // Every key shares this byte, so the stable pass would be the identity.
    if (histograms[base + ((sourceKeys[0]! >>> shift) & 0xff)] === count) continue;
    let running = 0;
    for (let bucket = 0; bucket < 256; bucket += 1) {
      offsets[bucket] = running;
      running += histograms[base + bucket]!;
    }
    for (let index = 0; index < count; index += 1) {
      const key = sourceKeys[index]!;
      const bucket = (key >>> shift) & 0xff;
      const at = offsets[bucket]!;
      offsets[bucket] = at + 1;
      target[at] = source[index]!;
      targetKeys[at] = key;
    }
    [source, target] = [target, source];
    [sourceKeys, targetKeys] = [targetKeys, sourceKeys];
  }
  const descending = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) descending[index] = source[count - 1 - index]!;
  return descending;
}

function isRim(index: number, width: number, height: number): boolean {
  const x = index % width;
  const z = Math.floor(index / width);
  return x === 0 || z === 0 || x === width - 1 || z === height - 1;
}

function forEachNeighbour(
  index: number,
  width: number,
  height: number,
  visit: (neighbour: number, distance: number, order: number) => void,
): void {
  const x = index % width;
  const z = Math.floor(index / width);
  for (let order = 0; order < NEIGHBOURS.length; order += 1) {
    const offset = NEIGHBOURS[order]!;
    const nx = x + offset.dx;
    const nz = z + offset.dz;
    if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
    visit(nz * width + nx, offset.distance, order);
  }
}

/**
 * Deterministic open-rim priority flood.
 *
 * The bed is never lowered. Submerged cells route on `max(bed, seaLevel)` so
 * the ocean is an outlet rather than one enormous depression; `evolvedHeight`
 * retains the actual bathymetry.
 */
export function priorityFloodOpenRim(
  width: number,
  height: number,
  heights: ArrayLike<number>,
  seaLevel: number,
  epsilonMetersPerTexel = MACRO_FILL_EPSILON_METERS_PER_TEXEL,
): PriorityFloodResult {
  requireGrid(width, height, heights, "heights");
  if (!Number.isFinite(seaLevel)) throw new RangeError("seaLevel must be finite");
  requireNonNegative(epsilonMetersPerTexel, "fill epsilon");
  const count = width * height;
  const filled = new Float64Array(count);
  filled.fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(count);
  parent.fill(-1);
  const visited = new Uint8Array(count);
  const order = new Uint32Array(count);
  // Every cell is pushed at most once (the `visited` guard), so the heap can
  // never outgrow the grid.
  const heap = new StableMinHeap(count);
  // Container-only hoist: an exact float64 copy of the bed keeps the eight
  // reads per settled cell off a polymorphic ArrayLike.
  const bed = Float64Array.from(heights as ArrayLike<number>);

  const seed = (index: number): void => {
    if (visited[index]) return;
    visited[index] = 1;
    const elevation = Math.max(bed[index]!, seaLevel);
    filled[index] = elevation;
    heap.push(index, elevation);
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let z = 1; z < height - 1; z += 1) {
    seed(z * width);
    seed(z * width + width - 1);
  }

  const neighbourOffsets = new Int32Array(NEIGHBOUR_COUNT);
  for (let step = 0; step < NEIGHBOUR_COUNT; step += 1) {
    neighbourOffsets[step] = NEIGHBOUR_DZ[step]! * width + NEIGHBOUR_DX[step]!;
  }
  let settled = 0;
  while (heap.size > 0) {
    const index = heap.pop();
    const elevation = heap.poppedElevation;
    order[settled] = index;
    settled += 1;
    const x = index % width;
    const z = (index - x) / width;
    for (let step = 0; step < NEIGHBOUR_COUNT; step += 1) {
      const nx = x + NEIGHBOUR_DX[step]!;
      const nz = z + NEIGHBOUR_DZ[step]!;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      const neighbour = index + neighbourOffsets[step]!;
      if (visited[neighbour]) continue;
      visited[neighbour] = 1;
      parent[neighbour] = index;
      const drainageFloor = elevation + epsilonMetersPerTexel * NEIGHBOUR_DISTANCE[step]!;
      const neighbourElevation = Math.max(bed[neighbour]!, seaLevel, drainageFloor);
      filled[neighbour] = neighbourElevation;
      heap.push(neighbour, neighbourElevation);
    }
  }
  if (settled !== count) throw new Error("Priority flood failed to visit the complete grid");
  return Object.freeze({
    filledHeight: Float32Array.from(filled),
    floodParent: parent,
    settlementOrder: order,
  });
}

export interface MfdFlowOptions {
  readonly slopeExponent?: number;
  readonly initialAccumulation?: ArrayLike<number>;
  /** 1 prevents another cell routing into this texel (runway/apron hook). */
  readonly receiverExclusionMask?: ArrayLike<number>;
  /** Optional deterministic perimeter-ditch receiver override. */
  readonly receiverOverrides?: ArrayLike<number>;
}

/** Atomic-free, deterministic MFD gather over a pre-filled drainage surface. */
export function computeMfdFlowAccumulation(
  width: number,
  height: number,
  drainageHeight: ArrayLike<number>,
  floodParent: ArrayLike<number>,
  options: MfdFlowOptions = {},
): MfdFlowResult {
  requireGrid(width, height, drainageHeight, "drainageHeight");
  if (floodParent.length !== width * height) {
    throw new RangeError("floodParent length does not match the grid");
  }
  const count = width * height;
  const exponent = options.slopeExponent ?? MACRO_MFD_SLOPE_EXPONENT;
  requirePositive(exponent, "MFD slope exponent");
  const initial = options.initialAccumulation;
  const excluded = options.receiverExclusionMask;
  const overrides = options.receiverOverrides;
  if (initial && initial.length !== count) throw new RangeError("initial accumulation length mismatch");
  if (excluded && excluded.length !== count) throw new RangeError("receiver mask length mismatch");
  if (overrides && overrides.length !== count) throw new RangeError("receiver override length mismatch");

  const accumulation = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const value = initial?.[index] ?? 1;
    accumulation[index] = Math.max(0, Number.isFinite(value) ? value : 0);
  }
  const receivers = new Int32Array(count);
  receivers.fill(-1);
  // Containers only. The drainage surface and the exclusion predicate are
  // hoisted into monomorphic typed arrays so the eight-neighbour gather never
  // indexes a polymorphic ArrayLike; float64 copies of the surface are exact,
  // and the mask stores the same `>= 0.5` decision the original evaluated
  // inline. `floodParent` is deliberately left alone: it is read once per cell
  // and its out-of-range/fractional edge cases are load-bearing.
  const surface = Float64Array.from(drainageHeight as ArrayLike<number>);
  let exclusionMask: Uint8Array | null = null;
  if (excluded) {
    exclusionMask = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      exclusionMask[index] = (excluded[index] ?? 0) >= 0.5 ? 1 : 0;
    }
  }
  const order = orderByHeightDescending(surface, count);

  const neighbourOffsets = new Int32Array(NEIGHBOUR_COUNT);
  for (let step = 0; step < NEIGHBOUR_COUNT; step += 1) {
    neighbourOffsets[step] = NEIGHBOUR_DZ[step]! * width + NEIGHBOUR_DX[step]!;
  }
  const candidateIndices = new Int32Array(NEIGHBOUR_COUNT);
  const candidateWeights = new Float64Array(NEIGHBOUR_COUNT);
  const lastX = width - 1;
  const lastZ = height - 1;
  for (let position = 0; position < count; position += 1) {
    const index = order[position]!;
    const x = index % width;
    const z = (index - x) / width;
    if (x === 0 || z === 0 || x === lastX || z === lastZ) continue;
    const sourceExcluded = exclusionMask !== null && exclusionMask[index] === 1;
    const override = overrides?.[index];
    if (override !== undefined && override >= 0) {
      if (!Number.isSafeInteger(override) || override >= count || override === index) {
        throw new RangeError(`receiver override ${override} is invalid at ${index}`);
      }
      if (!sourceExcluded && exclusionMask !== null && exclusionMask[override] === 1) {
        throw new RangeError(`receiver override ${override} enters a protected cell at ${index}`);
      }
      receivers[index] = override;
      accumulation[override] = accumulation[override]! + accumulation[index]!;
      continue;
    }

    let candidates = 0;
    let weightSum = 0;
    let primary = -1;
    let primaryWeight = Number.NEGATIVE_INFINITY;
    const elevation = surface[index]!;
    // Interior cells only, so every offset is in bounds by construction.
    for (let step = 0; step < NEIGHBOUR_COUNT; step += 1) {
      const neighbour = index + neighbourOffsets[step]!;
      if (exclusionMask !== null && exclusionMask[neighbour] === 1 && !sourceExcluded) continue;
      const drop = elevation - surface[neighbour]!;
      if (!(drop > 0)) continue;
      const weight = Math.pow(drop / NEIGHBOUR_DISTANCE[step]!, exponent);
      candidateIndices[candidates] = neighbour;
      candidateWeights[candidates] = weight;
      candidates += 1;
      weightSum += weight;
      if (weight > primaryWeight || (weight === primaryWeight && neighbour < primary)) {
        primary = neighbour;
        primaryWeight = weight;
      }
    }

    if (candidates === 0 || !(weightSum > 0)) {
      const fallback = floodParent[index] ?? -1;
      if (
        fallback >= 0
        && fallback !== index
        && (sourceExcluded || exclusionMask === null || exclusionMask[fallback] !== 1)
      ) {
        receivers[index] = fallback;
        accumulation[fallback] = accumulation[fallback]! + accumulation[index]!;
      }
      continue;
    }
    receivers[index] = primary;
    const sourceArea = accumulation[index]!;
    for (let candidate = 0; candidate < candidates; candidate += 1) {
      const receiver = candidateIndices[candidate]!;
      accumulation[receiver] = accumulation[receiver]!
        + sourceArea * candidateWeights[candidate]! / weightSum;
    }
  }
  return Object.freeze({
    receivers,
    flowAccumulation: Float32Array.from(accumulation),
  });
}

export interface StreamPowerOptions {
  readonly iterations: number;
  readonly coefficient: number;
  readonly areaExponent: number;
  readonly timeStep: number;
  readonly texelSizeMeters: number;
  readonly seaLevel?: number;
  readonly erodibility?: ArrayLike<number>;
  /** Values >= 0.5 are copied bit-for-bit through every iteration. */
  readonly erosionMask?: ArrayLike<number>;
}

/** Fixed-count implicit stream-power Jacobi operator. */
export function applyStreamPowerIncision(
  sourceHeight: ArrayLike<number>,
  receivers: ArrayLike<number>,
  flowAccumulation: ArrayLike<number>,
  options: StreamPowerOptions,
): Float32Array {
  const count = sourceHeight.length;
  if (receivers.length !== count || flowAccumulation.length !== count) {
    throw new RangeError("stream-power fields must have matching lengths");
  }
  requireIterationCount(options.iterations, "stream-power iterations");
  requireNonNegative(options.coefficient, "stream-power coefficient");
  requirePositive(options.areaExponent, "stream-power area exponent");
  requireNonNegative(options.timeStep, "stream-power time step");
  requirePositive(options.texelSizeMeters, "stream-power texel size");
  if (options.erodibility && options.erodibility.length !== count) {
    throw new RangeError("erodibility length mismatch");
  }
  if (options.erosionMask && options.erosionMask.length !== count) {
    throw new RangeError("erosion mask length mismatch");
  }
  const original = Float64Array.from(sourceHeight);
  let current = Float64Array.from(sourceHeight);
  let next = new Float64Array(count);
  const seaLevel = options.seaLevel ?? Number.NEGATIVE_INFINITY;
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    next.set(current);
    for (let index = 0; index < count; index += 1) {
      if ((options.erosionMask?.[index] ?? 0) >= 0.5 || current[index]! <= seaLevel) continue;
      const receiver = receivers[index] ?? -1;
      if (receiver < 0 || receiver >= count) continue;
      const receiverHeight = current[receiver]!;
      if (!(current[index]! > receiverHeight)) continue;
      const localK = Math.max(0, options.erodibility?.[index] ?? 1);
      const area = Math.max(1, flowAccumulation[index] ?? 1);
      const c = options.coefficient * localK
        * Math.pow(area, options.areaExponent) * options.timeStep / options.texelSizeMeters;
      if (!(c > 0)) continue;
      next[index] = Math.max(receiverHeight, (current[index]! + c * receiverHeight) / (1 + c));
    }
    [current, next] = [next, current];
  }
  if (options.erosionMask) {
    for (let index = 0; index < count; index += 1) {
      if ((options.erosionMask[index] ?? 0) >= 0.5) current[index] = original[index]!;
    }
  }
  return Float32Array.from(current);
}

export interface ThermalTalusOptions {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  readonly iterations: number;
  readonly defaultReposeDegrees: number;
  readonly transferFraction: number;
  readonly reposeDegrees?: ArrayLike<number>;
  readonly erosionMask?: ArrayLike<number>;
}

/** Fixed-count, two-pass, mass-conserving thermal/talus relaxation. */
export function applyThermalTalusRelaxation(
  sourceHeight: ArrayLike<number>,
  options: ThermalTalusOptions,
): Float32Array {
  requireGrid(options.width, options.height, sourceHeight, "talus height");
  requirePositive(options.texelSizeMeters, "talus texel size");
  requireIterationCount(options.iterations, "talus iterations");
  if (!(options.defaultReposeDegrees > 0 && options.defaultReposeDegrees < 90)) {
    throw new RangeError("talus repose must be between 0 and 90 degrees");
  }
  if (!(options.transferFraction > 0 && options.transferFraction <= 0.5)) {
    throw new RangeError("talus transfer fraction must be in (0, 0.5]");
  }
  const count = sourceHeight.length;
  if (options.reposeDegrees && options.reposeDegrees.length !== count) {
    throw new RangeError("repose field length mismatch");
  }
  if (options.erosionMask && options.erosionMask.length !== count) {
    throw new RangeError("erosion mask length mismatch");
  }
  const original = Float64Array.from(sourceHeight);
  const current = Float64Array.from(sourceHeight);
  const delta = new Float64Array(count);
  const lowerIndices = new Int32Array(NEIGHBOURS.length);
  const excesses = new Float64Array(NEIGHBOURS.length);
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    delta.fill(0);
    for (let index = 0; index < count; index += 1) {
      if (isRim(index, options.width, options.height)) continue;
      if ((options.erosionMask?.[index] ?? 0) >= 0.5) continue;
      const repose = options.reposeDegrees?.[index] ?? options.defaultReposeDegrees;
      if (!(repose > 0 && repose < 90)) continue;
      const tangent = Math.tan(repose * Math.PI / 180);
      let candidates = 0;
      let excessSum = 0;
      forEachNeighbour(index, options.width, options.height, (neighbour, distance) => {
        if ((options.erosionMask?.[neighbour] ?? 0) >= 0.5) return;
        const excess = current[index]! - current[neighbour]!
          - tangent * options.texelSizeMeters * distance;
        if (!(excess > 0)) return;
        lowerIndices[candidates] = neighbour;
        excesses[candidates] = excess;
        candidates += 1;
        excessSum += excess;
      });
      if (candidates === 0 || !(excessSum > 0)) continue;
      const available = Math.min(
        excessSum * options.transferFraction,
        Math.max(0, (current[index]! - minimumNeighbourHeight(
          index,
          current,
          options.width,
          options.height,
          options.erosionMask,
        )) * 0.5),
      );
      delta[index] = delta[index]! - available;
      for (let candidate = 0; candidate < candidates; candidate += 1) {
        const receiver = lowerIndices[candidate]!;
        delta[receiver] = delta[receiver]! + available * excesses[candidate]! / excessSum;
      }
    }
    for (let index = 0; index < count; index += 1) {
      current[index] = current[index]! + delta[index]!;
    }
  }
  if (options.erosionMask) {
    for (let index = 0; index < count; index += 1) {
      if ((options.erosionMask[index] ?? 0) >= 0.5) current[index] = original[index]!;
    }
  }
  return Float32Array.from(current);
}

function minimumNeighbourHeight(
  index: number,
  height: ArrayLike<number>,
  width: number,
  gridHeight: number,
  mask: ArrayLike<number> | undefined,
): number {
  let minimum = height[index]!;
  forEachNeighbour(index, width, gridHeight, (neighbour) => {
    if ((mask?.[neighbour] ?? 0) < 0.5) minimum = Math.min(minimum, height[neighbour]!);
  });
  return minimum;
}

function discoverLakes(
  width: number,
  height: number,
  bed: ArrayLike<number>,
  filled: ArrayLike<number>,
  receivers: ArrayLike<number>,
  seaLevel: number,
  minimumDepth: number,
  texelSizeMeters: number,
): {
  lakeMask: Uint32Array;
  lakeDepth: Float32Array;
  lakes: readonly MacroLakeExport[];
} {
  const count = width * height;
  const wet = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    wet[index] = bed[index]! > seaLevel && filled[index]! - bed[index]! > minimumDepth ? 1 : 0;
  }
  const lakeMask = new Uint32Array(count);
  const lakeDepth = new Float32Array(count);
  const lakes: MacroLakeExport[] = [];
  const queue = new Int32Array(count);
  const neighbourOffsets = new Int32Array(NEIGHBOUR_COUNT);
  for (let step = 0; step < NEIGHBOUR_COUNT; step += 1) {
    neighbourOffsets[step] = NEIGHBOUR_DZ[step]! * width + NEIGHBOUR_DX[step]!;
  }
  for (let start = 0; start < count; start += 1) {
    if (!wet[start] || lakeMask[start] !== 0) continue;
    const id = lakes.length + 1;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    lakeMask[start] = id;
    while (head < tail) {
      const index = queue[head]!;
      head += 1;
      const x = index % width;
      const z = (index - x) / width;
      for (let step = 0; step < NEIGHBOUR_COUNT; step += 1) {
        const nx = x + NEIGHBOUR_DX[step]!;
        const nz = z + NEIGHBOUR_DZ[step]!;
        if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
        const neighbour = index + neighbourOffsets[step]!;
        if (!wet[neighbour] || lakeMask[neighbour] !== 0) continue;
        lakeMask[neighbour] = id;
        queue[tail] = neighbour;
        tail += 1;
      }
    }
    // The BFS pops in queue order, so `queue[0 .. memberCount)` is exactly the
    // member list the previous version accumulated into a separate array.
    const memberCount = tail;
    let outletIndex = queue[0]!;
    let outletReceiverIndex = receivers[outletIndex] ?? -1;
    let outletElevation = Number.POSITIVE_INFINITY;
    for (let member = 0; member < memberCount; member += 1) {
      const index = queue[member]!;
      const receiver = receivers[index] ?? -1;
      if (receiver >= 0 && lakeMask[receiver] === id) continue;
      const elevation = filled[index]!;
      if (elevation < outletElevation || (elevation === outletElevation && index < outletIndex)) {
        outletIndex = index;
        outletReceiverIndex = receiver;
        outletElevation = elevation;
      }
    }
    if (!Number.isFinite(outletElevation)) outletElevation = filled[outletIndex]!;
    let maxDepth = 0;
    for (let member = 0; member < memberCount; member += 1) {
      const index = queue[member]!;
      const depth = Math.max(0, outletElevation - bed[index]!);
      lakeDepth[index] = depth;
      maxDepth = Math.max(maxDepth, depth);
    }
    lakes.push(Object.freeze({
      id,
      outletIndex,
      outletReceiverIndex,
      spillElevationMeters: outletElevation,
      maxDepthMeters: maxDepth,
      surfaceAreaM2: memberCount * texelSizeMeters * texelSizeMeters,
      texelCount: memberCount,
    }));
  }
  return { lakeMask, lakeDepth, lakes: Object.freeze(lakes) };
}

function deriveBaseLevels(
  width: number,
  height: number,
  receivers: ArrayLike<number>,
  evolvedHeight: ArrayLike<number>,
  seaLevel: number,
): { basinIds: Uint32Array; baseLevels: readonly MacroBaseLevelExport[] } {
  const count = width * height;
  const terminal = new Int32Array(count);
  terminal.fill(-2);
  const trace = new Int32Array(count);
  // Rim membership as a lookup instead of two divisions per trace step. Only
  // the four edges are written, so building it costs 4*(width+height) stores.
  const rim = new Uint8Array(count);
  for (let x = 0; x < width; x += 1) {
    rim[x] = 1;
    rim[(height - 1) * width + x] = 1;
  }
  for (let z = 0; z < height; z += 1) {
    rim[z * width] = 1;
    rim[z * width + width - 1] = 1;
  }
  for (let start = 0; start < count; start += 1) {
    if (terminal[start] !== -2) continue;
    let length = 0;
    let index = start;
    // -3 marks "already on the current trace", replacing a `new Set()` per
    // start cell — a million allocations on the production domain. It folds
    // into the `=== -2` test the loop already performed, and every cell marked
    // -3 is in `trace`, so the assignment below always clears it. Both -2 and
    // -3 fail the `>= 0` test that resolves the terminal, so the outcome is
    // the one the Set produced.
    while (index >= 0 && terminal[index] === -2) {
      terminal[index] = -3;
      trace[length] = index;
      length += 1;
      const receiver = receivers[index] ?? -1;
      if (receiver < 0 || rim[index] === 1) {
        terminal[index] = index;
        break;
      }
      index = receiver;
    }
    const resolved = index >= 0 && terminal[index]! >= 0
      ? terminal[index]!
      : index >= 0
        ? index
        : trace[Math.max(0, length - 1)]!;
    for (let offset = length - 1; offset >= 0; offset -= 1) terminal[trace[offset]!] = resolved;
  }
  // Basin ids are one-based, so 0 doubles as "not yet assigned". Terminals are
  // cell indices for every graph this module produces; the map is kept only for
  // the off-grid receiver the previous Map-keyed lookup tolerated.
  const basinOfOutlet = new Int32Array(count);
  const strayOutlets = new Map<number, number>();
  const basinIds = new Uint32Array(count);
  const baseLevels: MacroBaseLevelExport[] = [];
  for (let index = 0; index < count; index += 1) {
    const outlet = terminal[index]!;
    const onGrid = outlet >= 0 && outlet < count;
    let id = onGrid ? basinOfOutlet[outlet]! : strayOutlets.get(outlet) ?? 0;
    if (id === 0) {
      id = baseLevels.length + 1;
      if (onGrid) basinOfOutlet[outlet] = id;
      else strayOutlets.set(outlet, id);
      baseLevels.push(Object.freeze({
        id,
        outletIndex: outlet,
        elevationMeters: Math.max(seaLevel, evolvedHeight[outlet] ?? seaLevel),
      }));
    }
    basinIds[index] = id;
  }
  return { basinIds, baseLevels: Object.freeze(baseLevels) };
}

/**
 * The half of the pipeline that runs after the operators: one priority flood,
 * one MFD gather, lake discovery, base levels and the channel-seed scan over an
 * already-evolved surface. Both entry points funnel through it, so the
 * single-shot and hybrid paths cannot drift apart.
 */
function completeMacroEvolution(
  width: number,
  height: number,
  texelSizeMeters: number,
  seaLevel: number,
  evolvedHeight: Float32Array,
  config: Readonly<MacroEvolutionConfig>,
): MacroEvolutionResult {
  const count = width * height;
  const finalFlood = priorityFloodOpenRim(
    width,
    height,
    evolvedHeight,
    seaLevel,
    config.fillEpsilonMetersPerTexel,
  );
  const finalFlow = computeMfdFlowAccumulation(
    width,
    height,
    finalFlood.filledHeight,
    finalFlood.floodParent,
    { slopeExponent: config.mfdSlopeExponent },
  );
  const lakeData = discoverLakes(
    width,
    height,
    evolvedHeight,
    finalFlood.filledHeight,
    finalFlow.receivers,
    seaLevel,
    config.minimumLakeDepthMeters,
    texelSizeMeters,
  );
  const drainage = deriveBaseLevels(width, height, finalFlow.receivers, evolvedHeight, seaLevel);
  const seeds: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (
      evolvedHeight[index]! > seaLevel
      && finalFlow.flowAccumulation[index]! >= config.channelInitiationAreaTexels
    ) seeds.push(index);
  }
  return Object.freeze({
    width,
    height,
    texelSizeMeters,
    evolvedHeight,
    filledHeight: finalFlood.filledHeight,
    receivers: finalFlow.receivers,
    flowAccumulation: finalFlow.flowAccumulation,
    lakeDepth: lakeData.lakeDepth,
    lakeMask: lakeData.lakeMask,
    lakes: lakeData.lakes,
    basinIds: drainage.basinIds,
    baseLevels: drainage.baseLevels,
    channelSeeds: Uint32Array.from(seeds),
    config,
  });
}

/**
 * The completion half alone, for a surface whose stream-power and talus passes
 * have already run elsewhere — the GPU, in the hybrid macro path.
 *
 * This returns exactly what `evolveMacroTerrain` returns when both operator
 * counts are zero, minus the flood/MFD pair that path computes and discards.
 * At zero iterations each operator is a `Float32Array.from(Float64Array.from(x))`
 * round trip whose only effect is `Math.fround`, and its result feeds nothing
 * but the next operator, so the leading flood and MFD are pure waste. The
 * `Float32Array.from` below reproduces that rounding, which is what keeps the
 * two paths bit-identical for an input that is not already float32; the
 * `requireGrid` on the rounded surface reproduces the talus pass's own
 * validation, so a height that is finite but rounds to infinity still fails the
 * same way with the same message.
 *
 * `erodibility` and `reposeDegrees` are accepted and length-validated but
 * unused: they only ever fed the operators.
 */
export function finishMacroEvolutionFromEvolvedHeight(
  input: MacroEvolutionInput,
): MacroEvolutionResult {
  requireGrid(input.width, input.height, input.heights, "macro heights");
  requirePositive(input.texelSizeMeters, "macro texel size");
  if (!Number.isFinite(input.seaLevel)) throw new RangeError("seaLevel must be finite");
  const count = input.width * input.height;
  if (input.erodibility && input.erodibility.length !== count) {
    throw new RangeError("macro erodibility length mismatch");
  }
  if (input.reposeDegrees && input.reposeDegrees.length !== count) {
    throw new RangeError("macro repose length mismatch");
  }
  const config = resolveMacroConfig(input.config);
  const evolvedHeight = Float32Array.from(input.heights);
  requireGrid(input.width, input.height, evolvedHeight, "talus height");
  return completeMacroEvolution(
    input.width,
    input.height,
    input.texelSizeMeters,
    input.seaLevel,
    evolvedHeight,
    config,
  );
}

export function evolveMacroTerrain(input: MacroEvolutionInput): MacroEvolutionResult {
  requireGrid(input.width, input.height, input.heights, "macro heights");
  requirePositive(input.texelSizeMeters, "macro texel size");
  if (!Number.isFinite(input.seaLevel)) throw new RangeError("seaLevel must be finite");
  const count = input.width * input.height;
  if (input.erodibility && input.erodibility.length !== count) {
    throw new RangeError("macro erodibility length mismatch");
  }
  if (input.reposeDegrees && input.reposeDegrees.length !== count) {
    throw new RangeError("macro repose length mismatch");
  }
  const config = resolveMacroConfig(input.config);
  const initialFlood = priorityFloodOpenRim(
    input.width,
    input.height,
    input.heights,
    input.seaLevel,
    config.fillEpsilonMetersPerTexel,
  );
  const initialFlow = computeMfdFlowAccumulation(
    input.width,
    input.height,
    initialFlood.filledHeight,
    initialFlood.floodParent,
    { slopeExponent: config.mfdSlopeExponent },
  );
  // Submarine bathymetry is authored by the tectonic profile, not by fluvial
  // erosion. Protect it while still routing its water surface at sea level.
  const protectedMask = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    if (input.heights[index]! <= input.seaLevel) protectedMask[index] = 1;
  }
  const incised = applyStreamPowerIncision(
    input.heights,
    initialFlow.receivers,
    initialFlow.flowAccumulation,
    {
      iterations: config.streamPowerIterations,
      coefficient: config.streamPowerCoefficient,
      areaExponent: config.streamPowerAreaExponent,
      timeStep: config.streamPowerTimeStep,
      texelSizeMeters: input.texelSizeMeters,
      seaLevel: input.seaLevel,
      ...(input.erodibility ? { erodibility: input.erodibility } : {}),
      erosionMask: protectedMask,
    },
  );
  const evolvedHeight = applyThermalTalusRelaxation(incised, {
    width: input.width,
    height: input.height,
    texelSizeMeters: input.texelSizeMeters,
    iterations: config.talusIterations,
    defaultReposeDegrees: config.defaultReposeDegrees,
    transferFraction: config.talusTransferFraction,
    ...(input.reposeDegrees ? { reposeDegrees: input.reposeDegrees } : {}),
    erosionMask: protectedMask,
  });
  return completeMacroEvolution(
    input.width,
    input.height,
    input.texelSizeMeters,
    input.seaLevel,
    evolvedHeight,
    config,
  );
}

/**
 * Converts the richer evolution oracle result to 5-1's one legal transferable
 * macro contract. Small test fixtures deliberately fail this production-only
 * boundary rather than masquerading as a world authority.
 */
export function toTerrainMacroEvolutionExport(
  result: MacroEvolutionResult,
  seaLevelMeters: number,
  provenance: TerrainEvolutionProvenance,
): TerrainMacroEvolutionExport {
  if (result.width !== EVOLUTION_DOMAIN_TEXELS || result.height !== EVOLUTION_DOMAIN_TEXELS) {
    throw new RangeError(
      `macro export requires the production ${EVOLUTION_DOMAIN_TEXELS}² evolution domain`,
    );
  }
  if (result.texelSizeMeters !== EVOLUTION_TEXEL_METERS) {
    throw new RangeError(`macro export requires ${EVOLUTION_TEXEL_METERS} metre texels`);
  }
  if (!Number.isFinite(seaLevelMeters)) throw new RangeError("seaLevelMeters must be finite");
  const expectedCount = EVOLUTION_DOMAIN_TEXELS * EVOLUTION_DOMAIN_TEXELS;
  for (const [label, field] of [
    ["height", result.evolvedHeight],
    ["filled height", result.filledHeight],
    ["receiver", result.receivers],
    ["flow accumulation", result.flowAccumulation],
    ["lake depth", result.lakeDepth],
    ["lake mask", result.lakeMask],
    ["basin id", result.basinIds],
  ] as const) {
    if (field.length !== expectedCount) {
      throw new RangeError(`${label} field must contain exactly ${expectedCount} values`);
    }
  }
  const texelAreaM2 = result.texelSizeMeters * result.texelSizeMeters;
  const flowAccumulationAreaM2 = new Float32Array(result.flowAccumulation.length);
  const lakeMask = new Uint8Array(result.lakeMask.length);
  for (let index = 0; index < result.flowAccumulation.length; index += 1) {
    flowAccumulationAreaM2[index] = Math.fround(result.flowAccumulation[index]! * texelAreaM2);
    lakeMask[index] = result.lakeMask[index] === 0 ? 0 : 1;
  }
  const lakes = result.lakes.map((lake) => Object.freeze({
    lakeId: lake.id,
    spillElevationMeters: lake.spillElevationMeters,
    outletTexel: Object.freeze({
      x: lake.outletIndex % result.width,
      z: Math.floor(lake.outletIndex / result.width),
    }),
    maximumDepthMeters: lake.maxDepthMeters,
    surfaceAreaM2: lake.surfaceAreaM2,
  }));
  const drainageBaseLevels: Array<
    TerrainMacroEvolutionExport["drainageBaseLevels"][number]
  > = result.baseLevels.map((baseLevel) => Object.freeze({
    drainageId: baseLevel.id,
    elevationMeters: baseLevel.elevationMeters,
    outletTexel: Object.freeze({
      x: baseLevel.outletIndex % result.width,
      z: Math.floor(baseLevel.outletIndex / result.width),
    }),
    termination: baseLevel.elevationMeters <= seaLevelMeters ? "sea" as const : "rim" as const,
  }));
  // Retained lakes are explicit local base levels in addition to the open-rim
  // basin terminal. This is what lets page erosion stop incision at the lake
  // surface without losing the basin's eventual route to the sea/rim.
  for (const lake of result.lakes) {
    drainageBaseLevels.push(Object.freeze({
      drainageId: drainageBaseLevels.length + 1,
      elevationMeters: lake.spillElevationMeters,
      outletTexel: Object.freeze({
        x: lake.outletIndex % result.width,
        z: Math.floor(lake.outletIndex / result.width),
      }),
      termination: "lake" as const,
    }));
  }
  return Object.freeze({
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance,
    seaLevelMeters,
    heightMeters: result.evolvedHeight,
    flowAccumulationAreaM2,
    lakeMask,
    lakes: Object.freeze(lakes),
    drainageBaseLevels: Object.freeze(drainageBaseLevels),
    channelSeedTexelIndices: result.channelSeeds,
  });
}

/** Stable byte fingerprint used by eviction/regeneration tests. */
export function fingerprintEvolutionFields(fields: readonly ArrayBufferView[]): number {
  let hash = 0x811c9dc5;
  for (const field of fields) {
    const bytes = new Uint8Array(field.buffer, field.byteOffset, field.byteLength);
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

export class TerrainMacroEvolution {
  readonly config: Readonly<MacroEvolutionConfig>;

  constructor(config: Partial<MacroEvolutionConfig> = {}) {
    this.config = resolveMacroConfig(config);
  }

  evolve(input: Omit<MacroEvolutionInput, "config">): MacroEvolutionResult {
    return evolveMacroTerrain({ ...input, config: this.config });
  }

  evolveExport(
    input: Omit<MacroEvolutionInput, "config">,
    provenance: TerrainEvolutionProvenance,
  ): TerrainMacroEvolutionExport {
    const result = this.evolve(input);
    return toTerrainMacroEvolutionExport(result, input.seaLevel, provenance);
  }
}
