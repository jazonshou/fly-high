import {
  createWorldPageKey,
  worldPageBounds,
  type WorldPageAddress,
  type WorldPageBounds,
  type WorldPageKey,
} from "./pageKey";

export interface WorldPageStreamingObserver {
  readonly positionX: number;
  /**
   * Altitude above the page plane (1B-3). Optional so headless tools that
   * only reason horizontally stay valid; omitted means 0. Priority uses 3D
   * distance — at altitude, directly-underfoot pages stop outranking pages
   * the aircraft is actually flying toward. 4-5's CDLOD needs exactly this.
   */
  readonly positionY?: number;
  readonly positionZ: number;
  readonly velocityX: number;
  readonly velocityZ: number;
}

export interface WorldPageStreamingPriorityOptions {
  readonly basePageExtentMeters: number;
  readonly lookAheadSeconds: number;
  readonly corridorRadiusMeters: number;
  readonly minimumPredictionSpeedMetersPerSecond: number;
  /** Cost of distance remaining at closest approach to the prediction segment. */
  readonly predictionDistanceWeight: number;
  /** Converts time-to-entry into a distance-like cost using current speed. */
  readonly arrivalTimeWeight: number;
  readonly behindPenaltyWeight: number;
  /** Optional penalty per coarser level; keep zero when parents are explicitly biased. */
  readonly levelPenaltyMeters: number;
}

export const DEFAULT_WORLD_PAGE_STREAMING_PRIORITY_OPTIONS: Readonly<
  WorldPageStreamingPriorityOptions
> = Object.freeze({
  basePageExtentMeters: 512,
  lookAheadSeconds: 12,
  corridorRadiusMeters: 384,
  minimumPredictionSpeedMetersPerSecond: 8,
  predictionDistanceWeight: 0.8,
  arrivalTimeWeight: 0.15,
  behindPenaltyWeight: 0.35,
  levelPenaltyMeters: 0,
});

export interface WorldPageStreamingPriority {
  /** Lower values should be requested first. */
  readonly score: number;
  readonly key: WorldPageKey;
  readonly bounds: WorldPageBounds;
  readonly currentDistanceMeters: number;
  readonly closestApproachDistanceMeters: number;
  readonly corridorMissDistanceMeters: number;
  readonly alongTrackDistanceMeters: number;
  readonly timeToClosestSeconds: number;
  readonly predictionUsed: boolean;
  readonly ahead: boolean;
}

export interface WorldPageStreamingCandidate {
  readonly address: WorldPageAddress;
  /** Negative values promote visible/required-parent pages; positive values defer background work. */
  readonly priorityBiasMeters?: number;
}

export interface RankedWorldPageStreamingCandidate<T extends WorldPageStreamingCandidate> {
  readonly candidate: T;
  readonly priority: WorldPageStreamingPriority;
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function requireNonNegative(value: number, label: string): number {
  requireFinite(value, label);
  if (value < 0) throw new RangeError(`${label} must be non-negative`);
  return value;
}

function distanceToBounds(x: number, z: number, bounds: WorldPageBounds): number {
  const deltaX = Math.max(bounds.minX - x, 0, x - bounds.maxX);
  const deltaZ = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
  return Math.hypot(deltaX, deltaZ);
}

function normalizeOptions(
  overrides: Partial<WorldPageStreamingPriorityOptions>,
): WorldPageStreamingPriorityOptions {
  const options = { ...DEFAULT_WORLD_PAGE_STREAMING_PRIORITY_OPTIONS, ...overrides };
  if (options.basePageExtentMeters <= 0 || !Number.isFinite(options.basePageExtentMeters)) {
    throw new RangeError("Base page extent must be finite and greater than zero");
  }
  requireNonNegative(options.lookAheadSeconds, "Look-ahead time");
  requireNonNegative(options.corridorRadiusMeters, "Streaming corridor radius");
  requireNonNegative(options.minimumPredictionSpeedMetersPerSecond, "Minimum prediction speed");
  requireNonNegative(options.predictionDistanceWeight, "Prediction-distance weight");
  requireNonNegative(options.arrivalTimeWeight, "Arrival-time weight");
  requireNonNegative(options.behindPenaltyWeight, "Behind-page penalty weight");
  requireNonNegative(options.levelPenaltyMeters, "Level penalty");
  return options;
}

/**
 * Scores a page against the swept horizontal flight corridor. This favors pages
 * the aircraft will reach soon without starving pages already close to camera.
 */
export function calculateWorldPageStreamingPriority(
  address: WorldPageAddress,
  observer: WorldPageStreamingObserver,
  overrides: Partial<WorldPageStreamingPriorityOptions> = {},
  priorityBiasMeters = 0,
): WorldPageStreamingPriority {
  const options = normalizeOptions(overrides);
  requireFinite(observer.positionX, "Observer x");
  requireFinite(observer.positionZ, "Observer z");
  requireFinite(observer.velocityX, "Observer x velocity");
  requireFinite(observer.velocityZ, "Observer z velocity");
  requireFinite(priorityBiasMeters, "Priority bias");

  const bounds = worldPageBounds(address, options.basePageExtentMeters);
  const key = createWorldPageKey(address);
  const altitudeMeters = Math.abs(observer.positionY ?? 0);
  const currentDistanceMeters = Math.hypot(
    distanceToBounds(observer.positionX, observer.positionZ, bounds),
    altitudeMeters,
  );
  const speed = Math.hypot(observer.velocityX, observer.velocityZ);
  const predictionUsed =
    speed >= options.minimumPredictionSpeedMetersPerSecond && options.lookAheadSeconds > 0;

  let closestApproachDistanceMeters = currentDistanceMeters;
  let corridorMissDistanceMeters = currentDistanceMeters;
  let alongTrackDistanceMeters = 0;
  let timeToClosestSeconds = 0;
  let ahead = true;
  let score = currentDistanceMeters;

  if (predictionUsed) {
    const directionX = observer.velocityX / speed;
    const directionZ = observer.velocityZ / speed;
    const deltaX = bounds.centerX - observer.positionX;
    const deltaZ = bounds.centerZ - observer.positionZ;
    alongTrackDistanceMeters = deltaX * directionX + deltaZ * directionZ;

    const halfExtent = bounds.extentMeters * 0.5;
    const projectedHalfExtent = halfExtent * (Math.abs(directionX) + Math.abs(directionZ));
    const entryDistance = alongTrackDistanceMeters - projectedHalfExtent;
    const exitDistance = alongTrackDistanceMeters + projectedHalfExtent;
    ahead = exitDistance >= 0;

    timeToClosestSeconds = Math.min(
      options.lookAheadSeconds,
      Math.max(0, alongTrackDistanceMeters / speed),
    );
    const closestX = observer.positionX + observer.velocityX * timeToClosestSeconds;
    const closestZ = observer.positionZ + observer.velocityZ * timeToClosestSeconds;
    closestApproachDistanceMeters = Math.hypot(
      distanceToBounds(closestX, closestZ, bounds),
      altitudeMeters,
    );
    corridorMissDistanceMeters = Math.max(
      0,
      closestApproachDistanceMeters - options.corridorRadiusMeters,
    );

    if (ahead) {
      const timeToEntrySeconds = Math.min(
        options.lookAheadSeconds,
        Math.max(0, entryDistance / speed),
      );
      const routeCost =
        corridorMissDistanceMeters * options.predictionDistanceWeight +
        timeToEntrySeconds * speed * options.arrivalTimeWeight;
      score = Math.min(currentDistanceMeters, routeCost);
    } else {
      score =
        currentDistanceMeters + Math.max(0, -exitDistance) * options.behindPenaltyWeight;
    }
  }

  score += address.level * options.levelPenaltyMeters + priorityBiasMeters;
  return {
    score,
    key,
    bounds,
    currentDistanceMeters,
    closestApproachDistanceMeters,
    corridorMissDistanceMeters,
    alongTrackDistanceMeters,
    timeToClosestSeconds,
    predictionUsed,
    ahead,
  };
}

/** Stable ranking helper; canonical keys break exact score ties deterministically. */
export function rankWorldPageStreamingCandidates<T extends WorldPageStreamingCandidate>(
  candidates: readonly T[],
  observer: WorldPageStreamingObserver,
  options: Partial<WorldPageStreamingPriorityOptions> = {},
): readonly RankedWorldPageStreamingCandidate<T>[] {
  return candidates
    .map((candidate) => ({
      candidate,
      priority: calculateWorldPageStreamingPriority(
        candidate.address,
        observer,
        options,
        candidate.priorityBiasMeters ?? 0,
      ),
    }))
    .sort(
      (first, second) =>
        first.priority.score - second.priority.score ||
        first.priority.key.localeCompare(second.priority.key),
    );
}
