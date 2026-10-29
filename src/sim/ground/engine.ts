import type { TorqueCurve } from "@/src/vehicles/landcruiser76";
import { LANDCRUISER_76 } from "@/src/vehicles/landcruiser76";

/**
 * The 1GD-FTV as the crank sees it: full-load torque from the published
 * curve, a turbo whose boost lags the pedal, an idle governor, the fuel cut
 * near 4,000 rpm, motoring friction, a stall below 380 rpm and the starter
 * that brings a stalled engine back.
 *
 * A diesel's pedal asks for fuel, so in the steady state part-throttle
 * torque is the pedal's share of the curve. The turbo limits it in a
 * transient: the fuel the air allows (the smoke limit) is the curve times
 * the unboosted share plus the boost built, and boost builds towards the
 * pedal with a lag, so a pedal stamped from idle gives half the curve at
 * first. The governor adds fuel below idle and nothing above it.
 * Everything is a smooth torque on the crank; the clutch or converter that
 * loads it is the driveline's.
 */

const ENGINE = LANDCRUISER_76.engine;
export const RPM_PER_RAD_S = 60 / (2 * Math.PI);
export const IDLE_OMEGA = ENGINE.idleRpm / RPM_PER_RAD_S;
const STALL_OMEGA = ENGINE.stallRpm / RPM_PER_RAD_S;
const LIMITER_OMEGA = ENGINE.limiterRpm / RPM_PER_RAD_S;
const LIMITER_BAND = 150 / RPM_PER_RAD_S;
/** Idle governor gain, N m per rad/s below idle. */
const GOVERNOR_GAIN = 20;
/** The starter's torque while cranking, N m, and the speed the engine fires at. */
const STARTER_TORQUE = 70;
const FIRING_OMEGA = 180 / RPM_PER_RAD_S;
/** Below this the friction torque fades in, so a stopped crank holds still. */
const FRICTION_SMOOTHING = 3;

/**
 * The engine's inputs and outputs are fields: the car writes `omega`,
 * `pedal`, `crank` and `dt` and calls `evaluate` or `update`, which pass no
 * number through a call (V8 boxes one that crosses a call it does not
 * inline, and the car's step allocates nothing).
 */
export class Engine {
  private readonly curve: TorqueCurve;
  private readonly curveRpm: Float64Array;
  private readonly curveTorque: Float64Array;
  running = true;
  stalled = false;
  /** Hydrolocked: water reached the intake. Only a recovery clears it. */
  flooded = false;
  /** Turbo boost built, 0..1 of full. */
  boost = 0;
  /** What the engine was last asked for, 0..1 of full load: the sound's load. */
  load = 0;
  cranking = false;
  private crankTime = 0;

  /** Inputs: crank speed (rad/s), pedal (0..1), whether the key turns a stalled engine, and the step (s). */
  omega = 0;
  pedal = 0;
  crank = false;
  dt = 0;
  /** `evaluate`'s outputs: the pedal's combustion torque within the smoke limit, and the net torque on the crank, N m. */
  pedalTorque = 0;
  netTorque = 0;

  constructor(curve: TorqueCurve) {
    this.curve = curve;
    this.curveRpm = Float64Array.from(curve, (point) => point[0]);
    this.curveTorque = Float64Array.from(curve, (point) => point[1]);
  }

  /** The most torque the air allows at `omega` with the boost built now (the smoke limit), N m. For tests and probes. */
  fullLoadTorque(omega: number): number {
    const share = ENGINE.naturallyAspiratedShare;
    return interpolateCurve(this.curve, omega * RPM_PER_RAD_S) * (share + (1 - share) * this.boost);
  }

  /**
   * From `omega` and `pedal`: `pedalTorque`, the pedal's share of the curve
   * within the smoke limit, and `netTorque` on the crank with the idle
   * governor, the fuel cut, friction and the starter while cranking.
   */
  evaluate(): void {
    const omega = this.omega;
    const friction = (ENGINE.frictionTorque + ENGINE.frictionTorquePerRpm * Math.abs(omega) * RPM_PER_RAD_S)
      * Math.tanh(omega / FRICTION_SMOOTHING);
    // The curve at this speed (interpolateCurve, inline).
    const rpm = Math.max(omega, 0) * RPM_PER_RAD_S;
    const rpms = this.curveRpm;
    const torques = this.curveTorque;
    let spooled = 0;
    if (rpm <= rpms[0]!) spooled = torques[0]!;
    else {
      for (let i = 1; i < rpms.length; i += 1) {
        if (rpm <= rpms[i]!) {
          spooled = torques[i - 1]! + (torques[i]! - torques[i - 1]!) * ((rpm - rpms[i - 1]!) / (rpms[i]! - rpms[i - 1]!));
          break;
        }
      }
    }
    const share = ENGINE.naturallyAspiratedShare;
    const full = spooled * (share + (1 - share) * this.boost);
    this.pedalTorque = Math.min(this.pedal * spooled, full);
    if (!this.running) {
      this.load = 0;
      this.netTorque = (this.cranking ? STARTER_TORQUE : 0) - friction;
      return;
    }
    const governor = Math.min(full, Math.max(0, GOVERNOR_GAIN * (IDLE_OMEGA - omega)));
    let combustion = Math.max(this.pedalTorque, governor);
    if (omega > LIMITER_OMEGA) combustion *= Math.max(0, 1 - (omega - LIMITER_OMEGA) / LIMITER_BAND);
    this.load = full > 0 ? combustion / full : 0;
    this.netTorque = combustion - friction;
  }

  /**
   * Once per 120 Hz step, from `omega`, `pedal`, `crank` and `dt`: the
   * turbo spools towards the pedal, quicker with engine speed, a running
   * engine below the stall speed stops, and a stalled one cranks while
   * `crank` asks for it (the clutch down or the box in P or N).
   */
  update(): void {
    const omega = this.omega;
    const dt = this.dt;
    const rpm = omega * RPM_PER_RAD_S;
    const target = this.running ? Math.max(0, Math.min(1, this.pedal)) : 0;
    const spoolT = Math.max(0, Math.min(1, (rpm - 1_200) / (3_000 - 1_200)));
    // Below 1,200 rpm the exhaust weakens with speed: the lag grows as 1/rpm.
    const tau = rpm < 1_200
      ? (ENGINE.spoolSecondsAt1200 * 1_200) / Math.max(rpm, 600)
      : ENGINE.spoolSecondsAt1200 + (ENGINE.spoolSecondsAt3000 - ENGINE.spoolSecondsAt1200) * spoolT;
    // Boost falls quicker than it builds: the wastegate and blow-off.
    const rate = target > this.boost ? 1 / tau : 2.5 / tau;
    this.boost += (target - this.boost) * Math.min(1, rate * dt);

    if (this.running) {
      this.cranking = false;
      if (omega < STALL_OMEGA) {
        this.running = false;
        this.stalled = true;
        this.boost = 0;
      }
      return;
    }
    if (this.flooded || !this.crank) {
      this.cranking = false;
      this.crankTime = 0;
      return;
    }
    this.cranking = true;
    this.crankTime += dt;
    if (this.crankTime >= ENGINE.crankSeconds && omega >= FIRING_OMEGA) {
      this.running = true;
      this.stalled = false;
      this.cranking = false;
      this.crankTime = 0;
    }
  }

  /** Water at the intake: the engine stops at once and will not restart. */
  hydrolock(): void {
    this.flooded = true;
    this.running = false;
    this.stalled = true;
    this.cranking = false;
    this.boost = 0;
  }

  /** A recovery: running at idle, dry. */
  reset(): void {
    this.flooded = false;
    this.running = true;
    this.stalled = false;
    this.cranking = false;
    this.crankTime = 0;
    this.boost = 0;
    this.load = 0;
  }
}

/** Piecewise-linear torque against rpm; zero outside the curve. */
export function interpolateCurve(curve: TorqueCurve, rpm: number): number {
  const first = curve[0]!;
  if (rpm <= first[0]) return first[1];
  for (let i = 1; i < curve.length; i += 1) {
    const point = curve[i]!;
    if (rpm <= point[0]) {
      const previous = curve[i - 1]!;
      const t = (rpm - previous[0]) / (point[0] - previous[0]);
      return previous[1] + (point[1] - previous[1]) * t;
    }
  }
  return 0;
}
