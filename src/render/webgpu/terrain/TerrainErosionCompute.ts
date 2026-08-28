import {
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
  coreToStoredIndex,
  storedEdge,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  MACRO_FILL_EPSILON_METERS_PER_TEXEL,
  MACRO_MFD_SLOPE_EXPONENT,
  applyStreamPowerIncision,
  applyThermalTalusRelaxation,
  computeMfdFlowAccumulation,
  fingerprintEvolutionFields,
} from "./TerrainMacroEvolution";

/**
 * Page erosion's scratch border. It is intentionally independent from the
 * four-texel stored-page gutter and is never part of a page payload.
 */
export const EROSION_HALO_TEXELS = 64;
export const EROSION_PIT_BREACH_RADIUS_TEXELS = 16;
export const EROSION_STREAM_POWER_ITERATIONS = 24;
export const EROSION_TALUS_ITERATIONS = 32;

/** Largest declared single-operator propagation distance in the fixed DAG. */
export const EROSION_MAX_OPERATOR_REACH_TEXELS = Math.max(
  EROSION_PIT_BREACH_RADIUS_TEXELS,
  EROSION_STREAM_POWER_ITERATIONS,
  EROSION_TALUS_ITERATIONS,
);

/** 384 for the production 256-texel height core; fixtures may use less. */
export const EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS =
  WORLD_PAGE_HEIGHT_CORE + EROSION_HALO_TEXELS * 2;

export const EROSION_FIXED_ITERATION_COUNTS = Object.freeze({
  pitBreachRadiusTexels: EROSION_PIT_BREACH_RADIUS_TEXELS,
  streamPower: EROSION_STREAM_POWER_ITERATIONS,
  talus: EROSION_TALUS_ITERATIONS,
});

export interface TerrainErosionConfig {
  /** A local search bound, never a global depression-fill pass. */
  readonly pitBreachRadiusTexels: number;
  readonly drainageEpsilonMetersPerTexel: number;
  readonly mfdSlopeExponent: number;
  readonly streamPowerIterations: number;
  readonly streamPowerCoefficient: number;
  readonly streamPowerAreaExponent: number;
  readonly streamPowerTimeStep: number;
  readonly talusIterations: number;
  readonly defaultReposeDegrees: number;
  readonly talusTransferFraction: number;
}

/**
 * Class-K world constants. Graphics tiers affect admission pacing only; they
 * are deliberately absent from this type and from TerrainErosionCompute.
 */
export const TERRAIN_EROSION_PRODUCTION_CONFIG: Readonly<TerrainErosionConfig> = Object.freeze({
  pitBreachRadiusTexels: EROSION_PIT_BREACH_RADIUS_TEXELS,
  drainageEpsilonMetersPerTexel: MACRO_FILL_EPSILON_METERS_PER_TEXEL,
  mfdSlopeExponent: MACRO_MFD_SLOPE_EXPONENT,
  streamPowerIterations: EROSION_STREAM_POWER_ITERATIONS,
  streamPowerCoefficient: 0.018,
  streamPowerAreaExponent: 0.5,
  streamPowerTimeStep: 1,
  talusIterations: EROSION_TALUS_ITERATIONS,
  defaultReposeDegrees: 34,
  talusTransferFraction: 0.25,
});

export interface TerrainErosionInput {
  /** Core samples per edge. Production passes WORLD_PAGE_HEIGHT_CORE. */
  readonly coreSize: number;
  /** Defaults to EROSION_HALO_TEXELS; exposed for bounded unit fixtures. */
  readonly haloTexels?: number;
  readonly texelSizeMeters: number;
  /** `(coreSize + 2 * haloTexels)^2` row-major uplift/detail samples. */
  readonly heights: ArrayLike<number>;
  /** Bicubic parent contributing area, already rescaled for the child level. */
  readonly parentFlowAccumulation?: ArrayLike<number>;
  /** Optional parent receiver hints in scratch-local row-major coordinates. */
  readonly receiverHints?: ArrayLike<number>;
  readonly erodibility?: ArrayLike<number>;
  readonly reposeDegrees?: ArrayLike<number>;
  /** Values >= 0.5 protect runway/apron earthworks bit-for-bit. */
  readonly erosionMask?: ArrayLike<number>;
  /** Optional perimeter-ditch receiver overrides, scratch-local indices. */
  readonly receiverOverrides?: ArrayLike<number>;
  readonly config?: Partial<TerrainErosionConfig>;
}

export interface TerrainErosionResult {
  readonly coreSize: number;
  readonly haloTexels: number;
  readonly scratchEdge: number;
  readonly texelSizeMeters: number;
  readonly evolvedHeight: Float32Array;
  readonly drainageHeight: Float32Array;
  readonly receivers: Int32Array;
  readonly flowAccumulation: Float32Array;
  readonly erosionMask: Uint8Array;
  readonly config: Readonly<TerrainErosionConfig>;
}

export interface LocalPitBreachResult {
  readonly breachedHeight: Float32Array;
  /** The first carved step, or a supplied parent hint for unresolved pits. */
  readonly breachReceivers: Int32Array;
}

const OFFSETS = Object.freeze([
  Object.freeze({ dx: -1, dz: -1, distance: Math.SQRT2 }),
  Object.freeze({ dx: 0, dz: -1, distance: 1 }),
  Object.freeze({ dx: 1, dz: -1, distance: Math.SQRT2 }),
  Object.freeze({ dx: -1, dz: 0, distance: 1 }),
  Object.freeze({ dx: 1, dz: 0, distance: 1 }),
  Object.freeze({ dx: -1, dz: 1, distance: Math.SQRT2 }),
  Object.freeze({ dx: 0, dz: 1, distance: 1 }),
  Object.freeze({ dx: 1, dz: 1, distance: Math.SQRT2 }),
] as const);

function requireInteger(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireFinitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return value;
}

function requireField(
  field: ArrayLike<number> | undefined,
  count: number,
  label: string,
): void {
  if (field && field.length !== count) throw new RangeError(`${label} length mismatch`);
}

export function resolveTerrainErosionConfig(
  overrides: Partial<TerrainErosionConfig> | undefined,
): Readonly<TerrainErosionConfig> {
  const config: TerrainErosionConfig = {
    ...TERRAIN_EROSION_PRODUCTION_CONFIG,
    ...overrides,
  };
  requireInteger(config.pitBreachRadiusTexels, 0, "pit-breach radius");
  if (config.pitBreachRadiusTexels > EROSION_PIT_BREACH_RADIUS_TEXELS) {
    throw new RangeError(
      `pit-breach radius must not exceed ${EROSION_PIT_BREACH_RADIUS_TEXELS} texels`,
    );
  }
  requireFiniteNonNegative(config.drainageEpsilonMetersPerTexel, "drainage epsilon");
  requireFinitePositive(config.mfdSlopeExponent, "MFD slope exponent");
  requireInteger(config.streamPowerIterations, 0, "stream-power iterations");
  requireFiniteNonNegative(config.streamPowerCoefficient, "stream-power coefficient");
  requireFinitePositive(config.streamPowerAreaExponent, "stream-power area exponent");
  requireFiniteNonNegative(config.streamPowerTimeStep, "stream-power time step");
  requireInteger(config.talusIterations, 0, "talus iterations");
  if (!(config.defaultReposeDegrees > 0 && config.defaultReposeDegrees < 90)) {
    throw new RangeError("default repose must be between 0 and 90 degrees");
  }
  if (!(config.talusTransferFraction > 0 && config.talusTransferFraction <= 0.5)) {
    throw new RangeError("talus transfer fraction must be in (0, 0.5]");
  }
  return Object.freeze(config);
}

function isBorder(index: number, edge: number): boolean {
  const x = index % edge;
  const z = Math.floor(index / edge);
  return x === 0 || z === 0 || x === edge - 1 || z === edge - 1;
}

function forEachNeighbour(
  index: number,
  edge: number,
  visit: (neighbour: number, distance: number) => void,
): void {
  const x = index % edge;
  const z = Math.floor(index / edge);
  for (const offset of OFFSETS) {
    const nx = x + offset.dx;
    const nz = z + offset.dz;
    if (nx < 0 || nz < 0 || nx >= edge || nz >= edge) continue;
    visit(nz * edge + nx, offset.distance);
  }
}

interface BreachPath {
  readonly targetIndex: number;
  readonly steps: number;
  readonly dx: number;
  readonly dz: number;
}

function pathIndex(startX: number, startZ: number, path: BreachPath, step: number, edge: number): number {
  const x = startX + Math.round(path.dx * step / path.steps);
  const z = startZ + Math.round(path.dz * step / path.steps);
  return z * edge + x;
}

function pathIsClear(
  startX: number,
  startZ: number,
  path: BreachPath,
  edge: number,
  mask: ArrayLike<number> | undefined,
): boolean {
  for (let step = 1; step <= path.steps; step += 1) {
    if ((mask?.[pathIndex(startX, startZ, path, step, edge)] ?? 0) >= 0.5) return false;
  }
  return true;
}

/**
 * Deterministic local pit breach. It only inspects/carves within `radius` of a
 * sink and therefore cannot acquire the world-spanning reach of a fill.
 */
export function breachLocalPits(
  edge: number,
  heights: ArrayLike<number>,
  radiusTexels: number,
  epsilonMetersPerTexel: number,
  options: {
    readonly erosionMask?: ArrayLike<number>;
    readonly receiverHints?: ArrayLike<number>;
  } = {},
): LocalPitBreachResult {
  requireInteger(edge, 3, "erosion scratch edge");
  if (heights.length !== edge * edge) throw new RangeError("height length mismatch");
  requireInteger(radiusTexels, 0, "pit-breach radius");
  if (radiusTexels > EROSION_PIT_BREACH_RADIUS_TEXELS) {
    throw new RangeError("pit-breach radius exceeds the declared operator bound");
  }
  requireFiniteNonNegative(epsilonMetersPerTexel, "drainage epsilon");
  requireField(options.erosionMask, heights.length, "erosion mask");
  requireField(options.receiverHints, heights.length, "receiver hints");
  const breached = Float64Array.from(heights);
  const receivers = new Int32Array(heights.length);
  receivers.fill(-1);

  for (let index = 0; index < heights.length; index += 1) {
    if (isBorder(index, edge) || (options.erosionMask?.[index] ?? 0) >= 0.5) continue;
    let directReceiver = -1;
    let directHeight = heights[index]!;
    forEachNeighbour(index, edge, (neighbour) => {
      if ((options.erosionMask?.[neighbour] ?? 0) >= 0.5) return;
      const candidateHeight = heights[neighbour]!;
      if (candidateHeight < directHeight
        || (candidateHeight === directHeight && directReceiver >= 0 && neighbour < directReceiver)) {
        directHeight = candidateHeight;
        directReceiver = neighbour;
      }
    });
    if (directReceiver >= 0) {
      receivers[index] = directReceiver;
      continue;
    }

    const startX = index % edge;
    const startZ = Math.floor(index / edge);
    let best: BreachPath | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let dz = -radiusTexels; dz <= radiusTexels; dz += 1) {
      for (let dx = -radiusTexels; dx <= radiusTexels; dx += 1) {
        const steps = Math.max(Math.abs(dx), Math.abs(dz));
        if (steps === 0 || steps > radiusTexels) continue;
        const x = startX + dx;
        const z = startZ + dz;
        if (x < 0 || z < 0 || x >= edge || z >= edge) continue;
        const targetIndex = z * edge + x;
        const distance = Math.hypot(dx, dz);
        const targetHeight = heights[targetIndex]!;
        if (!(targetHeight + epsilonMetersPerTexel * distance < heights[index]!)) continue;
        const path = { targetIndex, steps, dx, dz };
        if (!pathIsClear(startX, startZ, path, edge, options.erosionMask)) continue;
        const score = targetHeight + epsilonMetersPerTexel * distance;
        if (score < bestScore || (score === bestScore && targetIndex < (best?.targetIndex ?? Infinity))) {
          best = path;
          bestScore = score;
        }
      }
    }
    if (!best) {
      const hint = options.receiverHints?.[index] ?? -1;
      if (Number.isSafeInteger(hint) && hint >= 0 && hint < heights.length && hint !== index) {
        receivers[index] = hint;
      }
      continue;
    }

    const outletHeight = heights[best.targetIndex]!;
    for (let step = 1; step < best.steps; step += 1) {
      const pathCell = pathIndex(startX, startZ, best, step, edge);
      const descendingHeight = heights[index]!
        + (outletHeight - heights[index]!) * step / best.steps;
      breached[pathCell] = Math.min(breached[pathCell]!, descendingHeight);
    }
    receivers[index] = pathIndex(startX, startZ, best, 1, edge);
  }

  return Object.freeze({
    breachedHeight: Float32Array.from(breached),
    breachReceivers: receivers,
  });
}

function validateErosionInput(
  input: TerrainErosionInput,
  config: Readonly<TerrainErosionConfig>,
): { haloTexels: number; scratchEdge: number; count: number } {
  requireInteger(input.coreSize, 1, "erosion core size");
  const haloTexels = requireInteger(input.haloTexels ?? EROSION_HALO_TEXELS, 0, "erosion halo");
  const requiredReach = Math.max(
    config.pitBreachRadiusTexels,
    config.streamPowerIterations,
    config.talusIterations,
  );
  if (haloTexels < requiredReach) {
    throw new RangeError(`erosion halo ${haloTexels} is smaller than operator reach ${requiredReach}`);
  }
  requireFinitePositive(input.texelSizeMeters, "erosion texel size");
  const scratchEdge = input.coreSize + haloTexels * 2;
  const count = scratchEdge * scratchEdge;
  if (input.heights.length !== count) {
    throw new RangeError(`heights must contain exactly ${count} scratch samples`);
  }
  requireField(input.parentFlowAccumulation, count, "parent accumulation");
  requireField(input.receiverHints, count, "receiver hints");
  requireField(input.erodibility, count, "erodibility");
  requireField(input.reposeDegrees, count, "repose");
  requireField(input.erosionMask, count, "erosion mask");
  requireField(input.receiverOverrides, count, "receiver overrides");
  for (let index = 0; index < count; index += 1) {
    if (!Number.isFinite(input.heights[index])) {
      throw new RangeError(`heights[${index}] must be finite`);
    }
  }
  return { haloTexels, scratchEdge, count };
}

/** Executes the fixed bounded page DAG; it has no frame/tier/admission inputs. */
export function erodeTerrainPage(input: TerrainErosionInput): TerrainErosionResult {
  const config = resolveTerrainErosionConfig(input.config);
  const { haloTexels, scratchEdge, count } = validateErosionInput(input, config);
  const mask = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    mask[index] = (input.erosionMask?.[index] ?? 0) >= 0.5 ? 1 : 0;
  }
  const breached = breachLocalPits(
    scratchEdge,
    input.heights,
    config.pitBreachRadiusTexels,
    config.drainageEpsilonMetersPerTexel,
    {
      erosionMask: mask,
      ...(input.receiverHints ? { receiverHints: input.receiverHints } : {}),
    },
  );
  const flow = computeMfdFlowAccumulation(
    scratchEdge,
    scratchEdge,
    breached.breachedHeight,
    breached.breachReceivers,
    {
      slopeExponent: config.mfdSlopeExponent,
      ...(input.parentFlowAccumulation
        ? { initialAccumulation: input.parentFlowAccumulation }
        : {}),
      receiverExclusionMask: mask,
      ...(input.receiverOverrides ? { receiverOverrides: input.receiverOverrides } : {}),
    },
  );
  // The parent's area field is the hierarchical boundary condition. Reusing
  // it directly prevents a scratch edge from becoming an invented headwater;
  // the local MFD pass still supplies deterministic receiver topology. Macro
  // pages (which have no parent area field) retain full MFD accumulation.
  const flowAccumulation = input.parentFlowAccumulation
    ? Float32Array.from(input.parentFlowAccumulation)
    : flow.flowAccumulation;
  const incised = applyStreamPowerIncision(
    breached.breachedHeight,
    flow.receivers,
    flowAccumulation,
    {
      iterations: config.streamPowerIterations,
      coefficient: config.streamPowerCoefficient,
      areaExponent: config.streamPowerAreaExponent,
      timeStep: config.streamPowerTimeStep,
      texelSizeMeters: input.texelSizeMeters,
      ...(input.erodibility ? { erodibility: input.erodibility } : {}),
      erosionMask: mask,
    },
  );
  const evolvedHeight = applyThermalTalusRelaxation(incised, {
    width: scratchEdge,
    height: scratchEdge,
    texelSizeMeters: input.texelSizeMeters,
    iterations: config.talusIterations,
    defaultReposeDegrees: config.defaultReposeDegrees,
    transferFraction: config.talusTransferFraction,
    ...(input.reposeDegrees ? { reposeDegrees: input.reposeDegrees } : {}),
    erosionMask: mask,
  });
  // Preserve authored pavement using the exact Float32 source representation,
  // even if a future operator accidentally writes a masked cell internally.
  for (let index = 0; index < count; index += 1) {
    if (mask[index]) evolvedHeight[index] = Math.fround(input.heights[index]!);
  }
  return Object.freeze({
    coreSize: input.coreSize,
    haloTexels,
    scratchEdge,
    texelSizeMeters: input.texelSizeMeters,
    evolvedHeight,
    drainageHeight: breached.breachedHeight,
    receivers: flow.receivers,
    flowAccumulation,
    erosionMask: mask,
    config,
  });
}

export type ErosionMaskSampler = (
  worldX: number,
  worldZ: number,
  sourceHeight: number,
) => boolean | number;

/**
 * Builds a protection mask from the existing earthworks authority. Callers
 * supply its SDF/profile predicate so this module never becomes a second
 * runway-geometry definition site.
 */
export function createErosionProtectionMask(options: {
  readonly edge: number;
  readonly worldOriginX: number;
  readonly worldOriginZ: number;
  readonly texelSizeMeters: number;
  readonly sourceHeight: ArrayLike<number>;
  readonly sample: ErosionMaskSampler;
}): Uint8Array {
  requireInteger(options.edge, 1, "mask edge");
  requireFinitePositive(options.texelSizeMeters, "mask texel size");
  const count = options.edge * options.edge;
  if (options.sourceHeight.length !== count) throw new RangeError("mask source length mismatch");
  const mask = new Uint8Array(count);
  for (let z = 0; z < options.edge; z += 1) {
    for (let x = 0; x < options.edge; x += 1) {
      const index = z * options.edge + x;
      const protectedSample = options.sample(
        options.worldOriginX + x * options.texelSizeMeters,
        options.worldOriginZ + z * options.texelSizeMeters,
        options.sourceHeight[index]!,
      );
      mask[index] = typeof protectedSample === "boolean"
        ? protectedSample ? 1 : 0
        : protectedSample >= 0.5 ? 1 : 0;
    }
  }
  return mask;
}

/** Copies the production stored core+gutter rectangle out of the scratch. */
export function extractStoredErosionHeight(
  result: TerrainErosionResult,
  gutter = WORLD_PAGE_GUTTER,
): Float32Array {
  requireInteger(gutter, 0, "stored gutter");
  if (gutter > result.haloTexels) {
    throw new RangeError("stored gutter must fit inside the erosion halo");
  }
  const edge = storedEdge(result.coreSize, gutter);
  const stored = new Float32Array(edge * edge);
  for (let row = -gutter; row < result.coreSize + gutter; row += 1) {
    for (let column = -gutter; column < result.coreSize + gutter; column += 1) {
      const scratchIndex = (row + result.haloTexels) * result.scratchEdge
        + column + result.haloTexels;
      stored[coreToStoredIndex(row, column, result.coreSize, gutter)] =
        result.evolvedHeight[scratchIndex]!;
    }
  }
  return stored;
}

export type ErosionAdjacency = "horizontal" | "vertical";

function equalFloat32Bits(
  first: Float32Array,
  firstIndex: number,
  second: Float32Array,
  secondIndex: number,
): boolean {
  const firstBits = new Uint32Array(first.buffer, first.byteOffset, first.length);
  const secondBits = new Uint32Array(second.buffer, second.byteOffset, second.length);
  return firstBits[firstIndex] === secondBits[secondIndex];
}

/**
 * Tests both stored-gutter/core bands representing the same world samples.
 * This is exact IEEE-754 bit equality, including signed zero.
 */
export function erosionOverlapIsBitExact(
  first: TerrainErosionResult,
  second: TerrainErosionResult,
  adjacency: ErosionAdjacency,
  gutter = WORLD_PAGE_GUTTER,
): boolean {
  if (first.coreSize !== second.coreSize || first.texelSizeMeters !== second.texelSizeMeters) {
    return false;
  }
  const firstStored = extractStoredErosionHeight(first, gutter);
  const secondStored = extractStoredErosionHeight(second, gutter);
  const edge = storedEdge(first.coreSize, gutter);
  const start = -gutter;
  const end = first.coreSize + gutter;
  for (let cross = start; cross < end; cross += 1) {
    for (let offset = 0; offset < gutter; offset += 1) {
      const firstOuter = adjacency === "horizontal"
        ? coreToStoredIndex(cross, first.coreSize + offset, first.coreSize, gutter)
        : coreToStoredIndex(first.coreSize + offset, cross, first.coreSize, gutter);
      const secondInner = adjacency === "horizontal"
        ? coreToStoredIndex(cross, offset, second.coreSize, gutter)
        : coreToStoredIndex(offset, cross, second.coreSize, gutter);
      const firstInner = adjacency === "horizontal"
        ? coreToStoredIndex(cross, first.coreSize - gutter + offset, first.coreSize, gutter)
        : coreToStoredIndex(first.coreSize - gutter + offset, cross, first.coreSize, gutter);
      const secondOuter = adjacency === "horizontal"
        ? coreToStoredIndex(cross, -gutter + offset, second.coreSize, gutter)
        : coreToStoredIndex(-gutter + offset, cross, second.coreSize, gutter);
      if (
        !equalFloat32Bits(firstStored, firstOuter, secondStored, secondInner)
        || !equalFloat32Bits(firstStored, firstInner, secondStored, secondOuter)
      ) return false;
    }
  }
  return firstStored.length === edge * edge && secondStored.length === edge * edge;
}

export function fingerprintTerrainErosion(result: TerrainErosionResult): number {
  return fingerprintEvolutionFields([
    result.evolvedHeight,
    result.drainageHeight,
    result.receivers,
    result.flowAccumulation,
    result.erosionMask,
  ]);
}

export class TerrainErosionCompute {
  readonly config: Readonly<TerrainErosionConfig>;

  constructor(config: Partial<TerrainErosionConfig> = {}) {
    this.config = resolveTerrainErosionConfig(config);
  }

  erode(input: Omit<TerrainErosionInput, "config">): TerrainErosionResult {
    return erodeTerrainPage({ ...input, config: this.config });
  }
}

if (EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS !== 384) {
  throw new Error("Phase 5 erosion scratch geometry drifted from its measured 384-texel edge");
}
if (EROSION_MAX_OPERATOR_REACH_TEXELS >= EROSION_HALO_TEXELS) {
  throw new Error("Erosion operators exceed the seam-proof scratch halo");
}
