import { LANDCRUISER_76 } from "@/src/vehicles/landcruiser76";

/**
 * The 76's recirculating-ball steering as the road wheels see it: a rack
 * position from -1 (full left) to +1 (full right), the inner wheel's angle
 * linear in it and the outer one from true Ackermann,
 *
 *   cot(outer) = cot(inner) + kingpin track / wheelbase,
 *
 * which gives 34 degrees inner and 26 outer at full lock and the published
 * 12.6 m circle. The rack follows the input at a slew rate that falls with
 * speed, and the lock is limited at speed to what a kinematic lateral
 * acceleration of 0.55 g allows, so a held key cannot roll the car at
 * 100 km/h. The input profile eases keyboard steering already; a stick's
 * position maps straight to the rack through the same limits.
 */

const STEERING = LANDCRUISER_76.steering;
const WHEELBASE = LANDCRUISER_76.geometry.wheelbase;
const ACKERMANN = STEERING.kingpinTrack / WHEELBASE;
/** The bicycle-model (centre wheel) angle at full lock. */
const FULL_LOCK_CENTRE = Math.atan(
  2 / (1 / Math.tan(STEERING.innerLock) + 1 / Math.tan(outerAngle(STEERING.innerLock))),
);

/** The outer wheel's angle for an inner angle, both positive. */
export function outerAngle(inner: number): number {
  if (inner <= 1e-9) return inner;
  return Math.atan(1 / (1 / Math.tan(inner) + ACKERMANN));
}

/** The rack a full input may reach at this speed, 0..1. */
export function rackLimit(speed: number): number {
  const v2 = speed * speed;
  if (v2 < 1e-6) return 1;
  const centre = Math.atan((WHEELBASE * STEERING.maxKinematicLateralAcceleration) / v2);
  return Math.min(1, centre / FULL_LOCK_CENTRE);
}

/** What the steering reads each step: the step, s, and the car's speed, m/s. */
export interface SteeringMotion {
  readonly dt: number;
  readonly speed: number;
}

/**
 * The input travels in `input` and the step in the motion object, so a step
 * passes no number through a call (V8 boxes one that crosses a call it does
 * not inline, and the car's step allocates nothing).
 */
export class Steering {
  /** -1 full left .. +1 full right. */
  rack = 0;
  /** Road-wheel angles, radians, positive with the wheel's front to the right: front left, front right. */
  left = 0;
  right = 0;
  /** The driver's input, -1..1, read by `update`. */
  input = 0;

  update(motion: Readonly<SteeringMotion>): void {
    const speed = motion.speed;
    // rackLimit(speed), inline.
    const v2 = speed * speed;
    const limit = v2 < 1e-6
      ? 1
      : Math.min(1, Math.atan((WHEELBASE * STEERING.maxKinematicLateralAcceleration) / v2) / FULL_LOCK_CENTRE);
    const input = this.input;
    const command = (Number.isFinite(input) ? Math.max(-1, Math.min(1, input)) : 0) * limit;
    const rate = (STEERING.slewRate * STEERING.slewHalfSpeed) / (STEERING.slewHalfSpeed + Math.abs(speed));
    const step = (rate / STEERING.innerLock) * motion.dt;
    const delta = command - this.rack;
    this.rack += delta > step ? step : delta < -step ? -step : delta;
    this.applyRack();
  }

  setRack(rack: number): void {
    this.rack = rack;
    this.applyRack();
  }

  /** The wheels' angles from the rack: the inner one linear in it, the outer from Ackermann (outerAngle, inline). */
  private applyRack(): void {
    const inner = Math.abs(this.rack) * STEERING.innerLock;
    const outer = inner <= 1e-9 ? inner : Math.atan(1 / (1 / Math.tan(inner) + ACKERMANN));
    if (this.rack >= 0) {
      // Turning right: the right wheel is the inner one.
      this.right = inner;
      this.left = outer;
    } else {
      this.left = -inner;
      this.right = -outer;
    }
  }

  /** The steering wheel's angle, radians: 3.6 turns lock to lock. */
  get wheelAngle(): number {
    return this.rack * STEERING.turnsLockToLock * Math.PI;
  }
}
