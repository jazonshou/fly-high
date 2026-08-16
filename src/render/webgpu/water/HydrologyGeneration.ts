const TAU = Math.PI * 2;

export interface HydrologyTerrainSample {
  readonly height: number;
  /** Optional normalized moisture. Missing values use a neutral 0.5. */
  readonly moisture?: number;
}

export type HydrologyTerrainSampler = (
  worldX: number,
  worldZ: number,
) => HydrologyTerrainSample;

export interface HydrologyBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export type DownhillTermination = "sea" | "basin" | "boundary" | "limit" | "loop";

export interface DownhillTracePoint {
  readonly x: number;
  readonly z: number;
  readonly terrainHeight: number;
  readonly moisture: number;
}

export interface DownhillTraceOptions {
  readonly worldSeed: string | number;
  readonly terrainSample: HydrologyTerrainSampler;
  readonly startX: number;
  readonly startZ: number;
  readonly bounds: HydrologyBounds;
  readonly seaLevel: number;
  readonly stepMeters?: number;
  readonly angularSamples?: number;
  readonly maximumSteps?: number;
  readonly minimumDropMeters?: number;
  readonly directionInertia?: number;
}

export interface DownhillTrace {
  readonly points: readonly DownhillTracePoint[];
  readonly termination: DownhillTermination;
  readonly terrainSampleCount: number;
}

export interface HydrologyRiverPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly widthMeters: number;
  readonly flowSpeedMetersPerSecond: number;
  readonly estimatedDischargeCubicMetersPerSecond: number;
}

export interface HydrologyRiver {
  readonly id: string;
  readonly points: readonly HydrologyRiverPoint[];
  readonly termination: DownhillTermination | "confluence";
  readonly lengthMeters: number;
  readonly maximumWidthMeters: number;
}

export interface HydrologyLakeBoundaryPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface HydrologyLake {
  readonly id: string;
  readonly centerX: number;
  readonly centerZ: number;
  readonly surfaceHeight: number;
  readonly maximumDepthMeters: number;
  readonly radiusMeters: number;
  readonly areaSquareMeters: number;
  readonly flowDirection: readonly [number, number];
  readonly boundary: readonly HydrologyLakeBoundaryPoint[];
}

export interface HydrologyGenerationConfig {
  readonly centerX: number;
  readonly centerZ: number;
  readonly extentMeters: number;
  readonly seaLevel: number;
  readonly sourceCandidateSpacingMeters: number;
  readonly minimumSourceElevationAboveSeaMeters: number;
  readonly minimumSourceSeparationMeters: number;
  readonly traceStepMeters: number;
  readonly traceAngularSamples: number;
  readonly maximumTraceSteps: number;
  readonly minimumRiverPoints: number;
  /** Headwater density bound for one base region; incoming halo rivers are additional. */
  readonly maximumRivers: number;
  readonly minimumDownhillDropMeters: number;
  readonly directionInertia: number;
  readonly riverSurfaceOffsetMeters: number;
  readonly baseRiverWidthMeters: number;
  readonly riverWidthGrowthMeters: number;
  readonly maximumRiverWidthMeters: number;
  /** Basin-owner density bound for one base region; incoming halo basins are additional. */
  readonly maximumLakes: number;
  readonly minimumLakeDepthMeters: number;
  readonly maximumLakeDepthMeters: number;
  readonly minimumLakeRadiusMeters: number;
  readonly maximumLakeRadiusMeters: number;
  readonly lakeBoundarySegments: number;
}

export interface HydrologyGenerationOptions extends Partial<HydrologyGenerationConfig> {
  readonly worldSeed: string | number;
  readonly terrainSample: HydrologyTerrainSampler;
}

export interface HydrologyGenerationStatistics {
  readonly terrainSampleCount: number;
  readonly haloSourceCellCount: number;
  readonly maximumDirectionalTraceSamples: number;
  readonly candidateSourceCount: number;
  readonly tracedSourceCount: number;
  readonly riverCount: number;
  readonly lakeCount: number;
  readonly rawRiverPointCount: number;
  readonly splinePointCount: number;
  readonly totalRiverLengthMeters: number;
  readonly totalLakeAreaSquareMeters: number;
}

export interface HydrologyGenerationResult {
  readonly config: HydrologyGenerationConfig;
  readonly bounds: HydrologyBounds;
  readonly rivers: readonly HydrologyRiver[];
  readonly lakes: readonly HydrologyLake[];
  readonly statistics: HydrologyGenerationStatistics;
}

export const DEFAULT_HYDROLOGY_CONFIG: HydrologyGenerationConfig = Object.freeze({
  centerX: 0,
  centerZ: 0,
  extentMeters: 14_400,
  seaLevel: 0,
  sourceCandidateSpacingMeters: 900,
  minimumSourceElevationAboveSeaMeters: 80,
  minimumSourceSeparationMeters: 720,
  traceStepMeters: 90,
  traceAngularSamples: 16,
  maximumTraceSteps: 180,
  minimumRiverPoints: 10,
  maximumRivers: 10,
  minimumDownhillDropMeters: 0.08,
  directionInertia: 0.18,
  riverSurfaceOffsetMeters: 0.16,
  baseRiverWidthMeters: 2.4,
  riverWidthGrowthMeters: 1.2,
  maximumRiverWidthMeters: 22,
  maximumLakes: 5,
  minimumLakeDepthMeters: 1.2,
  maximumLakeDepthMeters: 16,
  minimumLakeRadiusMeters: 45,
  maximumLakeRadiusMeters: 900,
  lakeBoundarySegments: 32,
});

/** Hard bounds for a single paged hydrology job, including its source halo. */
export const MAX_HYDROLOGY_HALO_SOURCE_CELLS = 100;
export const MAX_HYDROLOGY_DIRECTIONAL_TRACE_SAMPLES = 300_000;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positive(value: number, label: string): number {
  finite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function integerRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function mixHash(seed: number, value: number): number {
  let hash = (seed ^ Math.imul(value, 0x9e3779b1)) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function unitHash(seed: number, value: number): number {
  return mixHash(seed, value) / 4_294_967_296;
}

function seedHash(seed: string | number): number {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new RangeError("worldSeed must be finite");
    return mixHash(0xa3c59ac3, Math.trunc(seed));
  }
  return hashText(seed);
}

function validateBounds(bounds: HydrologyBounds): void {
  finite(bounds.minX, "bounds.minX");
  finite(bounds.maxX, "bounds.maxX");
  finite(bounds.minZ, "bounds.minZ");
  finite(bounds.maxZ, "bounds.maxZ");
  if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) {
    throw new RangeError("Hydrology bounds must have positive area");
  }
}

function inBounds(bounds: HydrologyBounds, x: number, z: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

function readTerrainSample(
  terrainSample: HydrologyTerrainSampler,
  x: number,
  z: number,
): DownhillTracePoint {
  const sample = terrainSample(x, z);
  if (!sample || !Number.isFinite(sample.height)) {
    throw new RangeError(`terrainSample returned an invalid height at (${x}, ${z})`);
  }
  const moisture = sample.moisture ?? 0.5;
  if (!Number.isFinite(moisture)) {
    throw new RangeError(`terrainSample returned invalid moisture at (${x}, ${z})`);
  }
  return { x, z, terrainHeight: sample.height, moisture: clamp(moisture, 0, 1) };
}

export function resolveHydrologyConfig(
  input: Partial<HydrologyGenerationConfig> = {},
): HydrologyGenerationConfig {
  const config = Object.freeze({ ...DEFAULT_HYDROLOGY_CONFIG, ...input });
  assertHydrologyConfig(config);
  return config;
}

export function assertHydrologyConfig(config: HydrologyGenerationConfig): void {
  finite(config.centerX, "hydrology.centerX");
  finite(config.centerZ, "hydrology.centerZ");
  positive(config.extentMeters, "hydrology.extentMeters");
  if (config.extentMeters > 50_000) {
    throw new RangeError("hydrology.extentMeters cannot exceed 50 km");
  }
  finite(config.seaLevel, "hydrology.seaLevel");
  positive(config.sourceCandidateSpacingMeters, "hydrology.sourceCandidateSpacingMeters");
  if (Math.ceil(config.extentMeters / config.sourceCandidateSpacingMeters) > 40) {
    throw new RangeError("hydrology source lattice cannot exceed 40 cells per axis");
  }
  finite(
    config.minimumSourceElevationAboveSeaMeters,
    "hydrology.minimumSourceElevationAboveSeaMeters",
  );
  positive(config.minimumSourceSeparationMeters, "hydrology.minimumSourceSeparationMeters");
  positive(config.traceStepMeters, "hydrology.traceStepMeters");
  integerRange(config.traceAngularSamples, 8, 32, "hydrology.traceAngularSamples");
  integerRange(config.maximumTraceSteps, 4, 256, "hydrology.maximumTraceSteps");
  integerRange(config.minimumRiverPoints, 3, 64, "hydrology.minimumRiverPoints");
  integerRange(config.maximumRivers, 1, 24, "hydrology.maximumRivers");
  positive(config.minimumDownhillDropMeters, "hydrology.minimumDownhillDropMeters");
  if (config.directionInertia < 0 || config.directionInertia > 1) {
    throw new RangeError("hydrology.directionInertia must be in [0, 1]");
  }
  finite(config.riverSurfaceOffsetMeters, "hydrology.riverSurfaceOffsetMeters");
  positive(config.baseRiverWidthMeters, "hydrology.baseRiverWidthMeters");
  positive(config.riverWidthGrowthMeters, "hydrology.riverWidthGrowthMeters");
  positive(config.maximumRiverWidthMeters, "hydrology.maximumRiverWidthMeters");
  if (config.maximumRiverWidthMeters < config.baseRiverWidthMeters) {
    throw new RangeError("hydrology maximum river width must exceed its base width");
  }
  integerRange(config.maximumLakes, 0, 16, "hydrology.maximumLakes");
  positive(config.minimumLakeDepthMeters, "hydrology.minimumLakeDepthMeters");
  positive(config.maximumLakeDepthMeters, "hydrology.maximumLakeDepthMeters");
  if (config.maximumLakeDepthMeters < config.minimumLakeDepthMeters) {
    throw new RangeError("hydrology maximum lake depth must exceed its minimum depth");
  }
  positive(config.minimumLakeRadiusMeters, "hydrology.minimumLakeRadiusMeters");
  positive(config.maximumLakeRadiusMeters, "hydrology.maximumLakeRadiusMeters");
  if (config.maximumLakeRadiusMeters < config.minimumLakeRadiusMeters) {
    throw new RangeError("hydrology maximum lake radius must exceed its minimum radius");
  }
  integerRange(config.lakeBoundarySegments, 12, 64, "hydrology.lakeBoundarySegments");
}

/**
 * Deterministic continuous downhill tracer. Every accepted point is strictly
 * lower than its predecessor, and both samples and output length are bounded.
 */
export function traceDownhillPath(options: DownhillTraceOptions): DownhillTrace {
  validateBounds(options.bounds);
  finite(options.startX, "startX");
  finite(options.startZ, "startZ");
  finite(options.seaLevel, "seaLevel");
  if (!inBounds(options.bounds, options.startX, options.startZ)) {
    throw new RangeError("Downhill trace start must be inside bounds");
  }
  const stepMeters = options.stepMeters ?? DEFAULT_HYDROLOGY_CONFIG.traceStepMeters;
  const angularSamples = options.angularSamples ?? DEFAULT_HYDROLOGY_CONFIG.traceAngularSamples;
  const maximumSteps = options.maximumSteps ?? DEFAULT_HYDROLOGY_CONFIG.maximumTraceSteps;
  const minimumDrop = options.minimumDropMeters
    ?? DEFAULT_HYDROLOGY_CONFIG.minimumDownhillDropMeters;
  const inertia = options.directionInertia ?? DEFAULT_HYDROLOGY_CONFIG.directionInertia;
  positive(stepMeters, "stepMeters");
  integerRange(angularSamples, 8, 32, "angularSamples");
  integerRange(maximumSteps, 1, 256, "maximumSteps");
  positive(minimumDrop, "minimumDropMeters");
  if (!Number.isFinite(inertia) || inertia < 0 || inertia > 1) {
    throw new RangeError("directionInertia must be in [0, 1]");
  }

  const hash = seedHash(options.worldSeed);
  const angularOffset = unitHash(hash, 0x27182818) * TAU;
  let sampleCount = 0;
  const sample = (x: number, z: number): DownhillTracePoint => {
    sampleCount += 1;
    return readTerrainSample(options.terrainSample, x, z);
  };
  const points: DownhillTracePoint[] = [];
  const visited = new Set<string>();
  let current = sample(options.startX, options.startZ);
  let previousDirection: readonly [number, number] | null = null;
  let termination: DownhillTermination = "limit";

  for (let stepIndex = 0; stepIndex < maximumSteps; stepIndex += 1) {
    const key = `${Math.round(current.x / (stepMeters * 0.35))}:${Math.round(current.z / (stepMeters * 0.35))}`;
    if (visited.has(key)) {
      termination = "loop";
      break;
    }
    visited.add(key);
    points.push(current);
    if (current.terrainHeight <= options.seaLevel + 0.25) {
      termination = "sea";
      break;
    }

    let best: DownhillTracePoint | null = null;
    let bestDirection: readonly [number, number] | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let outsideHasDescent = false;
    for (let directionIndex = 0; directionIndex < angularSamples; directionIndex += 1) {
      const angle = angularOffset + directionIndex * TAU / angularSamples;
      const direction: readonly [number, number] = [Math.cos(angle), Math.sin(angle)];
      const x = current.x + direction[0] * stepMeters;
      const z = current.z + direction[1] * stepMeters;
      const candidate = sample(x, z);
      const drop = current.terrainHeight - candidate.terrainHeight;
      if (!inBounds(options.bounds, x, z)) {
        outsideHasDescent ||= drop >= minimumDrop;
        continue;
      }
      if (drop < minimumDrop) continue;
      const alignment = previousDirection
        ? previousDirection[0] * direction[0] + previousDirection[1] * direction[1]
        : 0;
      const tieBreak = unitHash(hash, stepIndex * 67 + directionIndex) * 1e-7;
      const score = drop / stepMeters + alignment * inertia * 0.002 + tieBreak;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
        bestDirection = direction;
      }
    }
    if (!best || !bestDirection) {
      termination = outsideHasDescent ? "boundary" : "basin";
      break;
    }
    previousDirection = bestDirection;
    current = best;
  }
  return Object.freeze({
    points: Object.freeze(points),
    termination,
    terrainSampleCount: sampleCount,
  });
}

interface SourceCandidate {
  readonly x: number;
  readonly z: number;
  readonly score: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly key: string;
  readonly lakeEligible: boolean;
}

function coordinateHash(seed: number, x: number, z: number): number {
  return mixHash(mixHash(seed, x), z);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

interface SourceCandidateBuildResult {
  readonly candidates: readonly SourceCandidate[];
  readonly haloSourceCellCount: number;
  readonly maximumDirectionalTraceSamples: number;
}

function buildSourceCandidates(
  config: HydrologyGenerationConfig,
  bounds: HydrologyBounds,
  terrainSample: HydrologyTerrainSampler,
  hash: number,
): SourceCandidateBuildResult {
  // The source lattice is anchored to absolute world coordinates. A region's
  // bounds only select cells; they never change jitter, score, or identity.
  // This is essential because adjacent paging regions intentionally overlap.
  const cellWidth = config.sourceCandidateSpacingMeters;
  const minimumCellX = Math.floor(bounds.minX / cellWidth);
  const maximumCellX = Math.floor(bounds.maxX / cellWidth);
  const minimumCellZ = Math.floor(bounds.minZ / cellWidth);
  const maximumCellZ = Math.floor(bounds.maxZ / cellWidth);
  const maximumCellsPerAxis = Math.ceil(config.extentMeters / cellWidth) + 1;
  let sourceStride = 1;
  while (
    Math.ceil(maximumCellsPerAxis / sourceStride) ** 2 > config.maximumRivers
    || (sourceStride - 0.64) * cellWidth < config.minimumSourceSeparationMeters
  ) sourceStride += 1;
  const sourceOffsetX = Math.floor(unitHash(hash, 0x4f1bbcdc) * sourceStride);
  const sourceOffsetZ = Math.floor(unitHash(hash, 0x2c9277b5) * sourceStride);
  let lakeStride = sourceStride;
  if (config.maximumLakes > 0) {
    while (
      Math.ceil(maximumCellsPerAxis / lakeStride) ** 2 > config.maximumLakes
    ) lakeStride += sourceStride;
  }
  const lakeStrideSlots = config.maximumLakes > 0 ? lakeStride / sourceStride : 0;
  const lakeOffsetX = sourceOffsetX + sourceStride * Math.floor(
    unitHash(hash, 0x6d2b79f5) * lakeStrideSlots,
  );
  const lakeOffsetZ = sourceOffsetZ + sourceStride * Math.floor(
    unitHash(hash, 0x1b56c4e9) * lakeStrideSlots,
  );
  const gradientRadius = config.traceStepMeters * 2;
  const candidates: SourceCandidate[] = [];
  let haloSourceCellCount = 0;
  for (let cellZ = minimumCellZ; cellZ <= maximumCellZ; cellZ += 1) {
    for (let cellX = minimumCellX; cellX <= maximumCellX; cellX += 1) {
      // A seed-offset sparse sub-lattice gives every possible region the same
      // source ownership and guarantees the configured hard river bound before
      // terrain rejection. No page-local top-N decision can morph an overlap.
      if (
        positiveModulo(cellX - sourceOffsetX, sourceStride) !== 0
        || positiveModulo(cellZ - sourceOffsetZ, sourceStride) !== 0
      ) continue;
      haloSourceCellCount += 1;
      const maximumDirectionalTraceSamples = haloSourceCellCount
        * config.maximumTraceSteps
        * config.traceAngularSamples;
      if (
        haloSourceCellCount > MAX_HYDROLOGY_HALO_SOURCE_CELLS
        || maximumDirectionalTraceSamples > MAX_HYDROLOGY_DIRECTIONAL_TRACE_SAMPLES
      ) {
        throw new RangeError(
          "Hydrology source halo exceeds its bounded generation work budget",
        );
      }
      const cellHash = coordinateHash(hash, cellX, cellZ);
      const x = (cellX + 0.18 + unitHash(cellHash, 1) * 0.64) * cellWidth;
      const z = (cellZ + 0.18 + unitHash(cellHash, 2) * 0.64) * cellWidth;
      if (!inBounds(bounds, x, z)) continue;
      const center = readTerrainSample(terrainSample, x, z);
      const minimumNeighbor = Math.min(
        readTerrainSample(terrainSample, x - gradientRadius, z).terrainHeight,
        readTerrainSample(terrainSample, x + gradientRadius, z).terrainHeight,
        readTerrainSample(terrainSample, x, z - gradientRadius).terrainHeight,
        readTerrainSample(terrainSample, x, z + gradientRadius).terrainHeight,
      );
      const relief = center.terrainHeight - minimumNeighbor;
      const elevation = center.terrainHeight - config.seaLevel;
      if (elevation < config.minimumSourceElevationAboveSeaMeters
        || relief < config.minimumDownhillDropMeters) {
        continue;
      }
      candidates.push({
        x,
        z,
        score: elevation * 0.45
          + relief * 4
          + center.moisture * 80
          + unitHash(cellHash, 90_001) * 40,
        cellX,
        cellZ,
        key: `${cellX}:${cellZ}`,
        lakeEligible: config.maximumLakes > 0
          && positiveModulo(cellX - lakeOffsetX, lakeStride) === 0
          && positiveModulo(cellZ - lakeOffsetZ, lakeStride) === 0,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.z - b.z || a.x - b.x);
  return Object.freeze({
    candidates: Object.freeze(candidates),
    haloSourceCellCount,
    maximumDirectionalTraceSamples: haloSourceCellCount
      * config.maximumTraceSteps
      * config.traceAngularSamples,
  });
}

interface SmoothedPosition {
  readonly x: number;
  readonly z: number;
  /** Fractional downhill source-step index; stable when a trace gains a suffix. */
  readonly downstreamSteps: number;
}

function smoothTrace(points: readonly DownhillTracePoint[]): readonly SmoothedPosition[] {
  if (points.length <= 2) {
    return points.map((point, index) => ({
      x: point.x,
      z: point.z,
      downstreamSteps: index,
    }));
  }
  const smoothed: SmoothedPosition[] = [{
    x: points[0]?.x ?? 0,
    z: points[0]?.z ?? 0,
    downstreamSteps: 0,
  }];
  for (let index = 0; index < points.length - 1; index += 1) {
    const first = points[index];
    const second = points[index + 1];
    if (!first || !second) continue;
    smoothed.push({
      x: first.x * 0.75 + second.x * 0.25,
      z: first.z * 0.75 + second.z * 0.25,
      downstreamSteps: index + 0.25,
    });
    smoothed.push({
      x: first.x * 0.25 + second.x * 0.75,
      z: first.z * 0.25 + second.z * 0.75,
      downstreamSteps: index + 0.75,
    });
  }
  const last = points[points.length - 1];
  if (last) {
    smoothed.push({
      x: last.x,
      z: last.z,
      downstreamSteps: points.length - 1,
    });
  }
  return smoothed;
}

function buildRiver(
  id: string,
  tracePoints: readonly DownhillTracePoint[],
  termination: HydrologyRiver["termination"],
  config: HydrologyGenerationConfig,
  terrainSample: HydrologyTerrainSampler,
): HydrologyRiver {
  const smoothed = smoothTrace(tracePoints);
  const provisional: Array<{
    x: number;
    y: number;
    z: number;
    width: number;
    moisture: number;
  }> = [];
  let previousY = Number.POSITIVE_INFINITY;
  let previousX = 0;
  let previousZ = 0;
  for (const position of smoothed) {
    const terrain = readTerrainSample(terrainSample, position.x, position.z);
    const distance = provisional.length === 0
      ? 0
      : Math.hypot(position.x - previousX, position.z - previousZ);
    const terrainSurface = terrain.terrainHeight + config.riverSurfaceOffsetMeters;
    const y = provisional.length === 0
      ? terrainSurface
      : Math.min(terrainSurface, previousY - distance * 0.0002);
    const catchmentFactor = Math.sqrt(
      1 + position.downstreamSteps * (0.45 + terrain.moisture),
    );
    const width = clamp(
      config.baseRiverWidthMeters + catchmentFactor * config.riverWidthGrowthMeters,
      config.baseRiverWidthMeters,
      config.maximumRiverWidthMeters,
    );
    provisional.push({ x: position.x, y, z: position.z, width, moisture: terrain.moisture });
    previousX = position.x;
    previousY = y;
    previousZ = position.z;
  }

  let lengthMeters = 0;
  const points: HydrologyRiverPoint[] = provisional.map((point, index) => {
    const next = provisional[Math.min(index + 1, provisional.length - 1)];
    const previous = provisional[Math.max(index - 1, 0)];
    const segmentDistance = next && previous
      ? Math.max(Math.hypot(next.x - previous.x, next.z - previous.z), 0.001)
      : 1;
    const grade = next && previous ? Math.max((previous.y - next.y) / segmentDistance, 0.0002) : 0.0002;
    const depth = 0.22 + point.width * 0.075;
    const speed = clamp(Math.sqrt(9.80665 * depth * grade) + point.moisture * 0.35, 0.28, 6.5);
    const discharge = point.width * depth * speed * 0.62;
    if (index > 0) {
      const prior = provisional[index - 1];
      if (prior) lengthMeters += Math.hypot(point.x - prior.x, point.z - prior.z);
    }
    return Object.freeze({
      x: point.x,
      y: point.y,
      z: point.z,
      widthMeters: point.width,
      flowSpeedMetersPerSecond: speed,
      estimatedDischargeCubicMetersPerSecond: discharge,
    });
  });
  return Object.freeze({
    id,
    points: Object.freeze(points),
    termination,
    lengthMeters,
    maximumWidthMeters: points.reduce((maximum, point) => Math.max(maximum, point.widthMeters), 0),
  });
}

function cropRiverToBounds(
  river: HydrologyRiver,
  bounds: HydrologyBounds,
  minimumPoints: number,
): HydrologyRiver | null {
  let bestStart = -1;
  let bestEnd = -1;
  let runStart = -1;
  for (let index = 0; index <= river.points.length; index += 1) {
    const point = river.points[index];
    const inside = point ? inBounds(bounds, point.x, point.z) : false;
    if (inside && runStart < 0) runStart = index;
    if (inside || runStart < 0) continue;
    const runEnd = index - 1;
    if (runEnd - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = runEnd;
    }
    runStart = -1;
  }
  if (bestStart < 0 || bestEnd - bestStart + 1 < minimumPoints) return null;
  // Keep one source-owned neighbor at each edge so the ribbon crosses the page
  // boundary instead of stopping one tessellation interval short.
  const start = Math.max(0, bestStart - 1);
  const end = Math.min(river.points.length, bestEnd + 2);
  const points = river.points.slice(start, end);
  let lengthMeters = 0;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (current && previous) {
      lengthMeters += Math.hypot(current.x - previous.x, current.z - previous.z);
    }
  }
  return Object.freeze({
    id: river.id,
    points: Object.freeze(points),
    termination: start > 0 || end < river.points.length ? "boundary" : river.termination,
    lengthMeters,
    maximumWidthMeters: points.reduce(
      (maximum, point) => Math.max(maximum, point.widthMeters),
      0,
    ),
  });
}

function polygonArea(points: readonly HydrologyLakeBoundaryPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current && next) twiceArea += current.x * next.z - next.x * current.z;
  }
  return Math.abs(twiceArea) * 0.5;
}

function lakeIntersectsBounds(lake: HydrologyLake, bounds: HydrologyBounds): boolean {
  return lake.centerX + lake.radiusMeters >= bounds.minX
    && lake.centerX - lake.radiusMeters <= bounds.maxX
    && lake.centerZ + lake.radiusMeters >= bounds.minZ
    && lake.centerZ - lake.radiusMeters <= bounds.maxZ;
}

function buildBasinLake(
  id: string,
  basin: DownhillTracePoint,
  config: HydrologyGenerationConfig,
  terrainSample: HydrologyTerrainSampler,
  hash: number,
): HydrologyLake | null {
  const radialStep = Math.max(config.traceStepMeters * 0.35, 12);
  const rayMaxima: number[] = [];
  const raySamples: Array<readonly DownhillTracePoint[]> = [];
  for (let segment = 0; segment < config.lakeBoundarySegments; segment += 1) {
    const angle = segment * TAU / config.lakeBoundarySegments;
    const ray: DownhillTracePoint[] = [];
    let maximum = basin.terrainHeight;
    for (let radius = radialStep; radius <= config.maximumLakeRadiusMeters; radius += radialStep) {
      const point = readTerrainSample(
        terrainSample,
        basin.x + Math.cos(angle) * radius,
        basin.z + Math.sin(angle) * radius,
      );
      ray.push(point);
      maximum = Math.max(maximum, point.terrainHeight);
    }
    rayMaxima.push(maximum);
    raySamples.push(ray);
  }
  const spillHeight = Math.min(...rayMaxima);
  const enclosureDepth = spillHeight - basin.terrainHeight;
  if (!Number.isFinite(enclosureDepth) || enclosureDepth < config.minimumLakeDepthMeters) return null;
  const waterDepth = Math.min(config.maximumLakeDepthMeters, enclosureDepth * 0.82);
  const surfaceHeight = basin.terrainHeight + waterDepth;
  const boundary: HydrologyLakeBoundaryPoint[] = [];
  let radiusSum = 0;
  for (let segment = 0; segment < config.lakeBoundarySegments; segment += 1) {
    const angle = segment * TAU / config.lakeBoundarySegments;
    const ray = raySamples[segment];
    if (!ray) return null;
    let previousHeight = basin.terrainHeight;
    let previousRadius = 0;
    let crossingRadius = Number.NaN;
    for (let sampleIndex = 0; sampleIndex < ray.length; sampleIndex += 1) {
      const point = ray[sampleIndex];
      if (!point) continue;
      const radius = (sampleIndex + 1) * radialStep;
      if (point.terrainHeight >= surfaceHeight) {
        const fraction = clamp(
          (surfaceHeight - previousHeight) / Math.max(point.terrainHeight - previousHeight, 1e-6),
          0,
          1,
        );
        crossingRadius = previousRadius + (radius - previousRadius) * fraction;
        break;
      }
      previousHeight = point.terrainHeight;
      previousRadius = radius;
    }
    if (!Number.isFinite(crossingRadius) || crossingRadius < config.minimumLakeRadiusMeters) {
      return null;
    }
    radiusSum += crossingRadius;
    boundary.push(Object.freeze({
      x: basin.x + Math.cos(angle) * crossingRadius,
      y: surfaceHeight + config.riverSurfaceOffsetMeters,
      z: basin.z + Math.sin(angle) * crossingRadius,
    }));
  }
  const averageRadius = radiusSum / boundary.length;
  const flowAngle = unitHash(hash, Number.parseInt(id.split(":").at(-1) ?? "0", 10) + 71) * TAU;
  return Object.freeze({
    id,
    centerX: basin.x,
    centerZ: basin.z,
    surfaceHeight: surfaceHeight + config.riverSurfaceOffsetMeters,
    maximumDepthMeters: waterDepth,
    radiusMeters: averageRadius,
    areaSquareMeters: polygonArea(boundary),
    flowDirection: Object.freeze([Math.cos(flowAngle), Math.sin(flowAngle)]) as readonly [number, number],
    boundary: Object.freeze(boundary),
  });
}

export function generateHydrology(options: HydrologyGenerationOptions): HydrologyGenerationResult {
  const { worldSeed, terrainSample: sourceTerrainSample, ...configInput } = options;
  const config = resolveHydrologyConfig(configInput);
  const hash = seedHash(worldSeed);
  const bounds: HydrologyBounds = Object.freeze({
    minX: config.centerX - config.extentMeters * 0.5,
    maxX: config.centerX + config.extentMeters * 0.5,
    minZ: config.centerZ - config.extentMeters * 0.5,
    maxZ: config.centerZ + config.extentMeters * 0.5,
  });
  const haloMeters = config.traceStepMeters * config.maximumTraceSteps;
  const sourceBounds: HydrologyBounds = Object.freeze({
    minX: bounds.minX - haloMeters,
    maxX: bounds.maxX + haloMeters,
    minZ: bounds.minZ - haloMeters,
    maxZ: bounds.maxZ + haloMeters,
  });
  let terrainSampleCount = 0;
  const terrainSample: HydrologyTerrainSampler = (x, z) => {
    terrainSampleCount += 1;
    const point = readTerrainSample(sourceTerrainSample, x, z);
    return { height: point.terrainHeight, moisture: point.moisture };
  };
  const sourceBuild = buildSourceCandidates(config, sourceBounds, terrainSample, hash);
  const candidates = sourceBuild.candidates;
  const rivers: HydrologyRiver[] = [];
  const lakes: HydrologyLake[] = [];
  let tracedSourceCount = 0;
  let rawRiverPointCount = 0;

  for (const candidate of candidates) {
    tracedSourceCount += 1;
    const traceRadius = config.traceStepMeters * (config.maximumTraceSteps + 2);
    const traceBounds: HydrologyBounds = {
      minX: candidate.x - traceRadius,
      maxX: candidate.x + traceRadius,
      minZ: candidate.z - traceRadius,
      maxZ: candidate.z + traceRadius,
    };
    const trace = traceDownhillPath({
      worldSeed: `${String(worldSeed)}/river/${candidate.key}`,
      terrainSample,
      startX: candidate.x,
      startZ: candidate.z,
      // Tracing is owned by the global source, not the requesting page. The
      // same source therefore has the same complete path in every overlap.
      bounds: traceBounds,
      seaLevel: config.seaLevel,
      stepMeters: config.traceStepMeters,
      angularSamples: config.traceAngularSamples,
      maximumSteps: config.maximumTraceSteps,
      minimumDropMeters: config.minimumDownhillDropMeters,
      directionInertia: config.directionInertia,
    });
    if (candidate.lakeEligible && trace.termination === "basin") {
      const basin = trace.points.at(-1);
      if (basin && basin.terrainHeight > config.seaLevel + 0.5) {
        const lake = buildBasinLake(
          `${hash.toString(16)}:lake:${candidate.cellX}:${candidate.cellZ}`,
          basin,
          config,
          terrainSample,
          hash,
        );
        if (lake && lakeIntersectsBounds(lake, bounds)) lakes.push(lake);
      }
    }

    if (trace.points.length < config.minimumRiverPoints) continue;
    const completeRiver = buildRiver(
      `${hash.toString(16)}:river:${candidate.cellX}:${candidate.cellZ}`,
      trace.points,
      trace.termination,
      config,
      terrainSample,
    );
    const river = cropRiverToBounds(completeRiver, bounds, config.minimumRiverPoints);
    if (!river) continue;
    if (river.lengthMeters < config.traceStepMeters * (config.minimumRiverPoints - 2)) continue;
    rawRiverPointCount += Math.ceil(river.points.length * 0.5);
    rivers.push(river);
  }

  const statistics: HydrologyGenerationStatistics = Object.freeze({
    terrainSampleCount,
    haloSourceCellCount: sourceBuild.haloSourceCellCount,
    maximumDirectionalTraceSamples: sourceBuild.maximumDirectionalTraceSamples,
    candidateSourceCount: candidates.length,
    tracedSourceCount,
    riverCount: rivers.length,
    lakeCount: lakes.length,
    rawRiverPointCount,
    splinePointCount: rivers.reduce((sum, river) => sum + river.points.length, 0),
    totalRiverLengthMeters: rivers.reduce((sum, river) => sum + river.lengthMeters, 0),
    totalLakeAreaSquareMeters: lakes.reduce((sum, lake) => sum + lake.areaSquareMeters, 0),
  });
  return Object.freeze({
    config,
    bounds,
    rivers: Object.freeze(rivers),
    lakes: Object.freeze(lakes),
    statistics,
  });
}
