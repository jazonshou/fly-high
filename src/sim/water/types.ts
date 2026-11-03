import type { Vec3 } from "../types";

/**
 * The water a point is in. `"none"` is dry ground (or a bed above the water
 * table); lakes and rivers come from the renderer's hydrology and are
 * published to the worker by a later phase (W3), so today the sim sees only
 * `"none"` and `"sea"`.
 */
export type WaterKind = "none" | "sea" | "lake" | "river";

/**
 * Out-parameter for `WaterSurfaceAuthority.sample`; callers keep one and
 * reuse it, so sampling allocates nothing.
 */
export interface WaterSurfaceSample {
  kind: WaterKind;
  /** World Y of the water surface at this point, waves included. */
  height: number;
  /** World Y of the still surface: sea level, a lake's level, a river's local level. */
  stillHeight: number;
  /** Velocity of the surface water, world m/s: wave orbital motion plus any current. */
  velocity: Vec3;
  /** Unit outward surface normal, world frame. */
  normal: Vec3;
  /** Metres from the still surface down to the bed; 0 where `kind` is `"none"`. */
  depth: number;
}

export function createWaterSurfaceSample(): WaterSurfaceSample {
  return {
    kind: "none",
    height: 0,
    stillHeight: 0,
    velocity: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    depth: 0,
  };
}

/**
 * The single authority for "where is the water surface" in the sim, the way
 * the terrain authority is for the ground (docs/architecture/ARCHITECTURE.md
 * §3): the surface a hull floats on is the surface the renderer draws.
 *
 * `setTime` is called once per fixed step with the simulation clock, the same
 * `state.simulationTime` the renderer's ocean is stepped with.
 */
export interface WaterSurfaceAuthority {
  setTime(time: number): void;
  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample;
  /**
   * Optional, for a caller that already knows the bed under a point: true
   * only where `sample` would certainly answer `"none"` at (`at.x`, `at.z`)
   * over a bed at `at.height` (the authority's own bed there, to within a
   * few decimetres), so the caller can skip it. False means ask `sample`.
   * No number crosses the call, so V8 boxes none.
   */
  isDry?(at: Readonly<WaterBedPoint>): boolean;
}

/** A point and the bed's height under it, for `WaterSurfaceAuthority.isDry`. */
export interface WaterBedPoint {
  x: number;
  z: number;
  height: number;
}

/**
 * Where a hull is this step, so a wave sampler can prepare a local expansion
 * once and answer every hull point cheaply. Heading is radians,
 * `atan2(forward.x, forward.z)`, as `FlightTelemetry.heading`.
 */
export interface WaveFieldFocus {
  x: number;
  z: number;
  heading: number;
  halfLength: number;
  halfBeam: number;
}

/**
 * A water authority that can sample many points around one hull quickly.
 * `sample` stays correct anywhere; near the focus it is meant to be cheap.
 */
export interface HullWaterSampler extends WaterSurfaceAuthority {
  setFocus(focus: Readonly<WaveFieldFocus>): void;
}

/**
 * One sheltered basin: inside the ellipse the sea's wave displacement is
 * scaled by `floor`, rising smoothly to 1 over `feather` metres outside it.
 * The GPU ocean and the sim's twin apply the same field per point, so the
 * calm water the hull feels is the calm water on screen. Published by the
 * home marina; the open sea is exactly 1.
 */
export interface SeaShelterEllipse {
  centerX: number;
  centerZ: number;
  /** Radians, `atan2(axis.x, axis.z)` of the long axis. */
  heading: number;
  radiusAlong: number;
  radiusAcross: number;
  floor: number;
  feather: number;
}
