import type { HydrologyRiverPoint } from "./HydrologyGeneration";

/**
 * W-5 (C-5) — arc-length river resampling for graph-mode hydrology.
 *
 * The channel graph exports one node every 512 m macro texel; laying lanes
 * on those raw segments was the recorded "512 m ribbons" defect. Stations
 * here subdivide each exported segment to a spacing that scales with the
 * channel's own hydraulic width, while every exported node remains a
 * station verbatim — so the confluence single-shared-point convention holds
 * bit-exactly and per-station hydraulics are pure interpolations of the
 * exported edge hydraulics (no second hydraulic law; the contract forbids
 * recomputation).
 *
 * `arcLengthMeters` is the accumulated true arc length from the reach head
 * (a world-fixed graph node), so a parameter derived from it is
 * world-anchored: 6-1's flow-map advection keys its phase off it and needs
 * cross-seam continuity.
 */
export interface ResampledRiverStation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly widthMeters: number;
  readonly flowSpeedMetersPerSecond: number;
  readonly estimatedDischargeCubicMetersPerSecond: number;
  /** Accumulated true arc length from the reach head, metres. */
  readonly arcLengthMeters: number;
  /** Discrete Frenet tangent (central difference over stations), unit XZ. */
  readonly tangentX: number;
  readonly tangentZ: number;
  /**
   * Local bed grade (drop / run) over the same central difference, already
   * computed here for `whitewater` and now exported in its own right: 6-1
   * keys the standing-wave amplitude off it, and `whitewater` is not
   * invertible for it (the clamp saturates exactly where rapids are).
   */
  readonly grade: number;
  /** Recomputed from the resampled stations (same law as the 5-12 lanes). */
  readonly whitewater: number;
}

export const RIVER_STATION_MINIMUM_SPACING_METERS = 32;
export const RIVER_STATION_MAXIMUM_SPACING_METERS = 256;
/** Station spacing scales with channel width: clamp(width * 2, 32, 256) m. */
export function riverStationSpacingMeters(widthMeters: number): number {
  const width = Number.isFinite(widthMeters) ? Math.max(widthMeters, 0) : 0;
  return Math.min(
    RIVER_STATION_MAXIMUM_SPACING_METERS,
    Math.max(RIVER_STATION_MINIMUM_SPACING_METERS, width * 2),
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface MutableStation {
  x: number;
  y: number;
  z: number;
  widthMeters: number;
  flowSpeedMetersPerSecond: number;
  estimatedDischargeCubicMetersPerSecond: number;
  arcLengthMeters: number;
}

/**
 * Arc-length stations along a river polyline. Every input point survives as
 * a station with its hydraulics copied verbatim (bit-checkable at nodes and
 * at shared confluence endpoints); interior stations are linear
 * interpolations positioned exactly on the source polyline.
 */
export function resampleHydrologyRiverStations(
  points: readonly HydrologyRiverPoint[],
): ResampledRiverStation[] {
  if (points.length < 2) return [];
  const stations: MutableStation[] = [{
    x: points[0]!.x,
    y: points[0]!.y,
    z: points[0]!.z,
    widthMeters: points[0]!.widthMeters,
    flowSpeedMetersPerSecond: points[0]!.flowSpeedMetersPerSecond,
    estimatedDischargeCubicMetersPerSecond: points[0]!.estimatedDischargeCubicMetersPerSecond,
    arcLengthMeters: 0,
  }];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const segmentLength = Math.hypot(to.x - from.x, to.z - from.z);
    const arcBase = stations.at(-1)!.arcLengthMeters;
    if (segmentLength <= 1e-9) {
      if (index === points.length - 2) {
        stations.push({
          x: to.x,
          y: to.y,
          z: to.z,
          widthMeters: to.widthMeters,
          flowSpeedMetersPerSecond: to.flowSpeedMetersPerSecond,
          estimatedDischargeCubicMetersPerSecond: to.estimatedDischargeCubicMetersPerSecond,
          arcLengthMeters: arcBase,
        });
      }
      continue;
    }
    const spacing = riverStationSpacingMeters(Math.min(from.widthMeters, to.widthMeters));
    const subdivisions = Math.max(1, Math.ceil(segmentLength / spacing));
    for (let step = 1; step < subdivisions; step += 1) {
      const t = step / subdivisions;
      stations.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
        widthMeters: from.widthMeters + (to.widthMeters - from.widthMeters) * t,
        flowSpeedMetersPerSecond: from.flowSpeedMetersPerSecond
          + (to.flowSpeedMetersPerSecond - from.flowSpeedMetersPerSecond) * t,
        estimatedDischargeCubicMetersPerSecond: from.estimatedDischargeCubicMetersPerSecond
          + (to.estimatedDischargeCubicMetersPerSecond
            - from.estimatedDischargeCubicMetersPerSecond) * t,
        arcLengthMeters: arcBase + segmentLength * t,
      });
    }
    stations.push({
      x: to.x,
      y: to.y,
      z: to.z,
      widthMeters: to.widthMeters,
      flowSpeedMetersPerSecond: to.flowSpeedMetersPerSecond,
      estimatedDischargeCubicMetersPerSecond: to.estimatedDischargeCubicMetersPerSecond,
      arcLengthMeters: arcBase + segmentLength,
    });
  }
  if (stations.length < 2) return [];
  return stations.map((station, index) => {
    const previous = stations[Math.max(0, index - 1)]!;
    const next = stations[Math.min(stations.length - 1, index + 1)]!;
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz);
    const tangentX = length > 1e-6 ? dx / length : 0;
    const tangentZ = length > 1e-6 ? dz / length : 1;
    const drop = Math.max(previous.y - next.y, 0);
    const run = Math.max(Math.hypot(dx, dz), 1);
    const grade = drop / run;
    const whitewater = clamp01(
      (station.flowSpeedMetersPerSecond - 1.5) * 0.24 + grade * 14,
    );
    return Object.freeze({
      ...station,
      tangentX,
      tangentZ,
      grade,
      whitewater,
    });
  });
}
