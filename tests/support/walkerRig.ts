import type { PersonControlState, PersonVisualState } from "../../src/game/types";
import type { ColliderWorld } from "../../src/sim/colliders";
import type { GroundField, GroundPoint } from "../../src/sim/ground/terrainPatch";
import { Walker } from "../../src/sim/person/walker";
import {
  NEUTRAL_BOAT_CONTROLS,
  NEUTRAL_PERSON_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
} from "../../src/sim/surface/types";
import { CalmWaterSurface } from "../../src/sim/water/calmWater";
import type { WaterBedPoint, WaterSurfaceAuthority, WaterSurfaceSample } from "../../src/sim/water/types";

/**
 * A test rig for the walker: exact ground shapes (no lattice, no world), a
 * fixed surface material, still or wavy water over the same ground, and the
 * colliders a test builds. Heading 0 faces world +Z; +X is heading 90 deg.
 */

export const STEP = 1 / 120;

/** A ground shape: writes the height and its gradient at (`out.x`, `out.z`) into `out`. */
export type Shape = (out: GroundPoint) => void;

export interface Ground extends GroundField {
  height(x: number, z: number): number;
}

export function groundOf(shape: Shape): Ground {
  const point: GroundPoint = { x: 0, z: 0, height: 0, dhdx: 0, dhdz: 0 };
  return {
    evaluate: shape,
    height(x: number, z: number): number {
      point.x = x;
      point.z = z;
      shape(point);
      return point.height;
    },
  };
}

export function flat(height = 0): Ground {
  return groundOf((out) => {
    out.height = height;
    out.dhdx = 0;
    out.dhdz = 0;
  });
}

/** A plane rising along +X at `degrees` through the origin. */
export function slopeAlongX(degrees: number): Ground {
  const grade = Math.tan((degrees * Math.PI) / 180);
  return groundOf((out) => {
    out.height = grade * out.x;
    out.dhdx = grade;
    out.dhdz = 0;
  });
}

/** Level at `low` up to x = `toe`, then rising along +X at `grade` (rise over run) to `high`, level again. */
export function rampAlongX(low: number, toe: number, grade: number, high: number): Ground {
  return groundOf((out) => {
    const rise = (out.x - toe) * grade;
    if (rise <= 0) {
      out.height = low;
      out.dhdx = 0;
    } else if (low + rise >= high) {
      out.height = high;
      out.dhdx = 0;
    } else {
      out.height = low + rise;
      out.dhdx = grade;
    }
    out.dhdz = 0;
  });
}

export function walker(
  position: { x: number; y: number; z: number },
  heading: number,
  ground: Ground,
  surface?: number,
): Walker {
  return new Walker({ position, heading }, surface === undefined ? { ground } : { ground, surface: () => surface });
}

export interface RigOptions {
  water?: WaterSurfaceAuthority;
  /** Calm water at this level over the ground (instead of `water`). */
  seaLevel?: number;
  colliders?: ColliderWorld | null;
  nearSolids?: ColliderWorld | null;
}

export function environment(ground: Ground, options: RigOptions = {}): SurfaceVehicleEnvironment {
  const bed = (x: number, z: number) => ground.height(x, z);
  return {
    water: options.water ?? new CalmWaterSurface(options.seaLevel ?? -1_000, bed),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: bed,
    colliders: options.colliders ?? null,
    nearSolids: options.nearSolids ?? null,
    gravity: 9.80665,
  };
}

export function controls(input: Partial<PersonControlState>): SurfaceVehicleControls {
  return { assist: "scenic", boat: NEUTRAL_BOAT_CONTROLS, person: { ...NEUTRAL_PERSON_CONTROLS, ...input } };
}

/** Hold `input` for `seconds`, the water's clock kept with the walker's, calling `each` after every step. */
export function run(
  subject: Walker,
  environmentValue: SurfaceVehicleEnvironment,
  seconds: number,
  input: Partial<PersonControlState>,
  each?: (subject: Walker, step: number) => void,
): void {
  subject.setControls(controls(input));
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) {
    environmentValue.water.setTime(subject.state.time);
    subject.setEnvironment(environmentValue);
    subject.step(STEP);
    each?.(subject, i);
  }
}

export function payload(subject: Walker): PersonVisualState {
  const value = subject.snapshot().payload;
  if (value.kind !== "person") throw new Error("expected a person payload");
  return value;
}

/** Horizontal speed in the world, m/s. */
export function groundSpeed(subject: Walker): number {
  const velocity = subject.state.velocity;
  return Math.hypot(velocity.x, velocity.z);
}

/** The facing as `FlightTelemetry.heading`, radians in [0, 2 pi): body +X rotated into the world. */
export function headingOf(subject: Walker): number {
  const q = subject.state.orientation;
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  const heading = Math.atan2(fx, fz);
  return heading < 0 ? heading + 2 * Math.PI : heading;
}

/**
 * A long-crested swell over the ground: height `level + amplitude sin(k x -
 * w t)` (deep-water dispersion), with the surface's vertical velocity and the
 * orbital horizontal one, a still level of `level`.
 */
export class Swell implements WaterSurfaceAuthority {
  private time = 0;
  private readonly bed: GroundPoint = { x: -0, z: -0, height: -0, dhdx: -0, dhdz: -0 };
  readonly k: number;
  readonly omega: number;
  samples = 0;

  constructor(
    private readonly ground: Ground,
    readonly level: number,
    readonly amplitude: number,
    wavelength: number,
  ) {
    this.k = (2 * Math.PI) / wavelength;
    this.omega = Math.sqrt(9.80665 * this.k);
  }

  setTime(time: number): void {
    this.time = time;
  }

  isDry(at: Readonly<WaterBedPoint>): boolean {
    return at.height > this.level + this.amplitude + 0.1;
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    this.samples += 1;
    // The bed through `evaluate`, which takes no numbers to box.
    this.bed.x = x;
    this.bed.z = z;
    this.ground.evaluate(this.bed);
    const bed = this.bed.height;
    const phase = this.k * x - this.omega * this.time;
    const height = this.level + this.amplitude * Math.sin(phase);
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    if (height <= bed) {
      out.kind = "none";
      out.height = bed;
      out.stillHeight = this.level;
      out.depth = 0;
      out.velocity.x = 0;
      out.velocity.y = 0;
      out.velocity.z = 0;
      return out;
    }
    out.kind = "sea";
    out.height = height;
    out.stillHeight = this.level;
    out.depth = this.level - bed;
    out.velocity.x = this.amplitude * this.omega * Math.sin(phase);
    out.velocity.y = -this.amplitude * this.omega * Math.cos(phase);
    out.velocity.z = 0;
    return out;
  }
}

/** Still water at `level` that flows along +X at `current` m/s: a river. */
export class River implements WaterSurfaceAuthority {
  constructor(
    private readonly ground: Ground,
    readonly level: number,
    readonly current: number,
  ) {}

  setTime(): void {}

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const bed = this.ground.height(x, z);
    const wet = bed < this.level;
    out.kind = wet ? "river" : "none";
    out.height = wet ? this.level : bed;
    out.stillHeight = this.level;
    out.depth = wet ? this.level - bed : 0;
    out.velocity.x = wet ? this.current : 0;
    out.velocity.y = 0;
    out.velocity.z = 0;
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    return out;
  }
}
