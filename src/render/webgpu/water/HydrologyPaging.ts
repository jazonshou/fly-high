export interface HydrologyPagingObserver {
  readonly x: number;
  readonly z: number;
  readonly velocityX: number;
  readonly velocityZ: number;
}

export interface HydrologyRegionAddress {
  readonly x: number;
  readonly z: number;
}

export interface HydrologyRegionSelection extends HydrologyRegionAddress {
  readonly key: string;
  readonly centerX: number;
  readonly centerZ: number;
  readonly lookAheadX: number;
  readonly lookAheadZ: number;
}

export interface HydrologyPagingConfig {
  /** Stable center of paging address (0, 0), normally the initial airport region. */
  readonly anchorX: number;
  readonly anchorZ: number;
  /** Width and depth of each generated region. */
  readonly extentMeters: number;
  /** Distance between region centers. Must be no more than the extent. */
  readonly spacingMeters: number;
  /** Seconds of horizontal velocity projected ahead of the observer. */
  readonly lookAheadSeconds: number;
  /** Hard bound on look-ahead so the observer stays inside overlapping regions. */
  readonly maximumLookAheadMeters: number;
  /** Below this horizontal speed, no look-ahead bias is applied. */
  readonly minimumLookAheadSpeed: number;
  /** Duration for which the prior region remains resident during a swap. */
  readonly transitionSeconds: number;
  /** Upper bound for either worker or scheduled fallback generation. */
  readonly generationTimeoutMilliseconds: number;
}

export type HydrologyPagingOptions = Partial<Omit<HydrologyPagingConfig, "anchorX" | "anchorZ" | "extentMeters">>;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positive(value: number, label: string): number {
  finite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

export function resolveHydrologyPagingConfig(
  anchorX: number,
  anchorZ: number,
  extentMeters: number,
  options: HydrologyPagingOptions = {},
): HydrologyPagingConfig {
  finite(anchorX, "hydrology paging anchorX");
  finite(anchorZ, "hydrology paging anchorZ");
  positive(extentMeters, "hydrology paging extentMeters");
  const spacingMeters = options.spacingMeters ?? extentMeters * 0.5;
  const lookAheadSeconds = options.lookAheadSeconds ?? 18;
  const maximumLookAheadMeters = options.maximumLookAheadMeters ?? extentMeters * 0.2;
  const minimumLookAheadSpeed = options.minimumLookAheadSpeed ?? 4;
  const transitionSeconds = options.transitionSeconds ?? 0.65;
  const generationTimeoutMilliseconds = options.generationTimeoutMilliseconds ?? 30_000;
  positive(spacingMeters, "hydrology paging spacingMeters");
  if (spacingMeters > extentMeters) {
    throw new RangeError("hydrology paging spacingMeters cannot exceed the region extent");
  }
  if (spacingMeters * 0.5 + maximumLookAheadMeters >= extentMeters * 0.5) {
    throw new RangeError(
      "hydrology paging look-ahead must keep the observer inside each selected region",
    );
  }
  positive(lookAheadSeconds, "hydrology paging lookAheadSeconds");
  if (maximumLookAheadMeters < 0 || !Number.isFinite(maximumLookAheadMeters)) {
    throw new RangeError("hydrology paging maximumLookAheadMeters must be finite and non-negative");
  }
  if (minimumLookAheadSpeed < 0 || !Number.isFinite(minimumLookAheadSpeed)) {
    throw new RangeError("hydrology paging minimumLookAheadSpeed must be finite and non-negative");
  }
  if (transitionSeconds < 0 || !Number.isFinite(transitionSeconds)) {
    throw new RangeError("hydrology paging transitionSeconds must be finite and non-negative");
  }
  positive(
    generationTimeoutMilliseconds,
    "hydrology paging generationTimeoutMilliseconds",
  );
  return Object.freeze({
    anchorX,
    anchorZ,
    extentMeters,
    spacingMeters,
    lookAheadSeconds,
    maximumLookAheadMeters,
    minimumLookAheadSpeed,
    transitionSeconds,
    generationTimeoutMilliseconds,
  });
}

export function hydrologyRegionKey(address: HydrologyRegionAddress): string {
  if (!Number.isSafeInteger(address.x) || !Number.isSafeInteger(address.z)) {
    throw new RangeError("Hydrology region coordinates must be safe integers");
  }
  return `${address.x}:${address.z}`;
}

/**
 * Selects an overlapping, globally snapped region around a velocity-biased
 * observer. The look-ahead clamp guarantees the observer remains within the
 * selected region even at the snapping boundary.
 */
export function selectHydrologyRegion(
  observer: HydrologyPagingObserver,
  config: HydrologyPagingConfig,
): HydrologyRegionSelection {
  finite(observer.x, "hydrology observer x");
  finite(observer.z, "hydrology observer z");
  finite(observer.velocityX, "hydrology observer velocityX");
  finite(observer.velocityZ, "hydrology observer velocityZ");
  const speed = Math.hypot(observer.velocityX, observer.velocityZ);
  const projectedDistance = speed >= config.minimumLookAheadSpeed
    ? Math.min(speed * config.lookAheadSeconds, config.maximumLookAheadMeters)
    : 0;
  const directionX = speed > 1e-6 ? observer.velocityX / speed : 0;
  const directionZ = speed > 1e-6 ? observer.velocityZ / speed : 0;
  const lookAheadX = directionX * projectedDistance;
  const lookAheadZ = directionZ * projectedDistance;
  const targetX = observer.x + lookAheadX;
  const targetZ = observer.z + lookAheadZ;
  const x = Math.round((targetX - config.anchorX) / config.spacingMeters);
  const z = Math.round((targetZ - config.anchorZ) / config.spacingMeters);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
    throw new RangeError("Hydrology observer is outside the safe paging coordinate range");
  }
  return Object.freeze({
    x,
    z,
    key: hydrologyRegionKey({ x, z }),
    centerX: config.anchorX + x * config.spacingMeters,
    centerZ: config.anchorZ + z * config.spacingMeters,
    lookAheadX,
    lookAheadZ,
  });
}
