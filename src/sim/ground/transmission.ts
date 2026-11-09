import type { CarControlState, CarDiffLocks, CarTransferRange, CarVisualState } from "@/src/game/types";
import { LANDCRUISER_76 } from "@/src/vehicles/landcruiser76";
import { DOUBLE_ZERO } from "./doubleZero";
import { RPM_PER_RAD_S } from "./engine";

/**
 * Everything between the crank and the propeller shafts that a driver
 * chooses or a controller schedules: the six-speed automatic's selector,
 * shift schedule, kickdown and lockup, the transfer range and the diff
 * locks. The driver never picks a gear: the pedals choose D or R and the
 * schedule the gear. It runs once per 120 Hz step and hands the driveline
 * solver its ratios, inertias and lockup capacity.
 *
 * The pedals (Jason, 2026-11-05): W goes forward, S goes back, Space
 * brakes. Going forward W is the accelerator and S the brake; held on
 * through the stop, S selects R a moment later and is then the accelerator,
 * with W the brake, until W held through the next stop selects D again.
 * From P, at a start, either selects its way at once. Space brakes either
 * way and never changes direction, so it is what holds the car on a hill.
 */

const AT = LANDCRUISER_76.automatic;
const TRANSFER = LANDCRUISER_76.transfer;

/** Under this speed, m/s, the car counts as stopped for the selector, the range and the locks. */
export const STOPPED_SPEED = 0.4;
/** How long S (or W in reverse) must be held at a stop to change direction, s. */
const DIRECTION_HOLD_SECONDS = 0.3;
/** A pedal past this is down; under the second, up. */
const PEDAL_DOWN = 0.05;
const PEDAL_UP = 0.02;
const LOCKUP_RELEASE_SECONDS = 0.1;

/** The ratios by `gear + 1`, signed: reverse, neutral (and P), then the six forward gears. */
const GEAR_RATIOS = Float64Array.of(-AT.reverse, 0, ...AT.ratios);

export interface DriverPedals {
  /** The accelerator and service brake as the car uses them: W, S and Space through the direction. */
  accelerator: number;
  brake: number;
}

/** What the transmission needs to know about the car each step. */
export interface TransmissionMotion {
  /** The step, s. */
  dt: number;
  /** Signed forward speed, m/s. */
  speed: number;
  /** Rear propeller shaft speed, rad/s. */
  rearPropOmega: number;
}

/** Counts presses the way the input profile sends them: a change of count, the first count a baseline. */
class PressCounter {
  private last: number | null = null;

  take(count: number): number {
    if (!Number.isFinite(count)) return 0;
    if (this.last === null) {
      this.last = count;
      return 0;
    }
    const presses = count - this.last;
    this.last = count;
    return presses > 0 ? presses : 0;
  }
}

export class Transmission {
  /** The selector: P at a start, then D or R as the pedals choose. */
  selector: "P" | "R" | "D" = "P";
  /** Gear engaged: -1 reverse, 0 in P, 1..6. */
  gear = 0;
  range: CarTransferRange = "2H";
  locks: CarDiffLocks = "off";
  /** The converter's lockup clutch, 0 open .. 1 engaged. */
  lockup = DOUBLE_ZERO;
  /** Seconds left of a shift's torque gap. */
  shiftTime = DOUBLE_ZERO;
  /** The turbine's speed last step, rad/s. */
  inputOmega = DOUBLE_ZERO;

  /*
   * What the driveline reads every substep, kept current by `refresh` as
   * plain fields: V8 boxes a number a getter returns when it does not inline
   * the getter, and the car's step allocates nothing.
   */
  /** The axles' final drive. */
  readonly finalDrive = AT.finalDrive;
  /** The transfer case's ratio in this range. */
  transferRatio = DOUBLE_ZERO;
  /** Input shaft speed per rear propeller shaft speed: the gear times the transfer range (negative in reverse). */
  inputRatio = DOUBLE_ZERO;
  /** The turbine and input shaft's inertia, kg m^2. */
  readonly inputInertia = AT.inputInertia;
  /** Share of the turbine's torque that reaches the output: less during a clutch-to-clutch shift. */
  torqueShare = DOUBLE_ZERO;
  /** The coupling between the crank and the input shaft past the converter: the lockup clutch, N m. */
  couplingCapacity = DOUBLE_ZERO;

  private readonly gearRatios = GEAR_RATIOS;
  private dt = DOUBLE_ZERO;
  private speed = DOUBLE_ZERO;
  /**
   * This step's turbine rpm per unit of gear ratio at the output speed:
   * times a gear's ratio, the turbine rpm the box would have in that gear.
   */
  private rpmPerRatio = DOUBLE_ZERO;

  /** How long the other way's pedal has been held at a stop, s. */
  private directionHold = DOUBLE_ZERO;
  private readonly rangePresses = new PressCounter();
  private readonly lockPresses = new PressCounter();

  constructor() {
    this.refresh();
  }

  get fourWheelDrive(): boolean {
    return this.range !== "2H";
  }

  /** The gear's own ratio, signed: negative in reverse, 0 in neutral or park. */
  gearRatio(gear = this.gear): number {
    return this.gearRatios[gear + 1]!;
  }

  /** Driving through the converter (D or R). */
  get converterEngaged(): boolean {
    return this.gear !== 0;
  }

  get parked(): boolean {
    return this.selector === "P";
  }

  /** Whether a stalled engine may crank now: in P. */
  get canCrank(): boolean {
    return this.gear === 0;
  }

  /** Bring the fields the driveline reads up to date with the gear, range, lockup and shift. */
  private refresh(): void {
    this.transferRatio = this.range === "4L" ? TRANSFER.low : TRANSFER.high;
    this.inputRatio = this.gearRatios[this.gear + 1]! * this.transferRatio;
    this.torqueShare = this.shiftTime > 0 ? AT.shiftTorqueShare : 1;
    this.couplingCapacity = this.gear === 0 ? 0 : AT.lockupCapacity * this.lockup;
  }

  /**
   * One 120 Hz step of `motion.dt`: presses, the direction rule, the
   * schedule and the lockup. Writes the pedals as the car uses them into
   * `pedals`.
   */
  update(controls: Readonly<CarControlState>, motion: Readonly<TransmissionMotion>, pedals: DriverPedals): void {
    const dt = motion.dt;
    this.dt = dt;
    this.speed = motion.speed;
    const stopped = Math.abs(motion.speed) < STOPPED_SPEED;
    this.inputOmega = this.inputRatio * motion.rearPropOmega;
    const ratio = this.gearRatios[this.gear + 1]!;
    this.rpmPerRatio = ratio === 0 ? 0 : (this.inputOmega / ratio) * RPM_PER_RAD_S;
    this.updateRange(controls);
    if (this.shiftTime > 0) this.shiftTime = Math.max(0, this.shiftTime - dt);
    this.updateAutomatic(controls, stopped, pedals);
    this.refresh();
  }

  private updateRange(controls: Readonly<CarControlState>): void {
    const speed = this.speed;
    const rangePresses = this.rangePresses.take(controls.rangePresses);
    for (let i = 0; i < rangePresses; i += 1) {
      const next: CarTransferRange = this.range === "2H" ? "4H" : this.range === "4H" ? "4L" : "2H";
      const lowChange = next === "4L" || this.range === "4L";
      if (lowChange ? Math.abs(speed) > TRANSFER.lowRangeMaxSpeed : Math.abs(speed) > TRANSFER.highRangeShiftMaxSpeed) break;
      this.range = next;
      // 4L and back is a gear change: the automatic's lockup lets go.
      if (lowChange) this.lockup = 0;
    }
    if (this.range !== "4L") this.locks = "off";
    this.refresh();
    const lockPresses = this.lockPresses.take(controls.lockPresses);
    for (let i = 0; i < lockPresses && this.range === "4L"; i += 1) {
      // Toyota's order: the rear engages first, then the front; a third press frees both.
      this.locks = this.locks === "off" ? "rear" : this.locks === "rear" ? "both" : "off";
    }
  }

  private updateAutomatic(controls: Readonly<CarControlState>, stopped: boolean, pedals: DriverPedals): void {
    const w = controls.accelerator;
    const s = controls.reverse;
    if (this.selector === "P") {
      // A start: either pedal alone selects its way at once.
      if (stopped && w > PEDAL_DOWN && s <= PEDAL_UP) this.selectDrive();
      else if (stopped && s > PEDAL_DOWN && w <= PEDAL_UP) this.selectReverse();
    } else if (this.directionRequested(stopped, controls)) {
      if (this.selector === "D") this.selectReverse();
      else this.selectDrive();
    }

    if (this.selector === "R") {
      pedals.accelerator = s;
      pedals.brake = w;
    } else if (this.selector === "D") {
      pedals.accelerator = w;
      pedals.brake = s;
    } else {
      pedals.accelerator = 0;
      pedals.brake = 0;
    }
    if (controls.brake > pedals.brake) pedals.brake = controls.brake;

    if (this.selector === "D") this.schedule(pedals, stopped);
    this.updateLockup();
  }

  /**
   * The direction rule's trigger: the other way's pedal (S in D, W in R)
   * held with the car stopped for `DIRECTION_HOLD_SECONDS`, this way's pedal
   * up. It brakes the car down to the stop first, so S held from speed stops
   * the car and then backs it up without being let go.
   */
  private directionRequested(stopped: boolean, controls: Readonly<CarControlState>): boolean {
    const reversing = this.selector === "R";
    const pedal = reversing ? controls.accelerator : controls.reverse;
    const other = reversing ? controls.reverse : controls.accelerator;
    if (!stopped || pedal <= PEDAL_DOWN || other > PEDAL_UP) {
      this.directionHold = 0;
      return false;
    }
    this.directionHold += this.dt;
    return this.directionHold >= DIRECTION_HOLD_SECONDS;
  }

  private selectDrive(): void {
    this.selector = "D";
    this.gear = 1;
    this.directionHold = 0;
    this.lockup = 0;
  }

  private selectReverse(): void {
    this.selector = "R";
    this.gear = -1;
    this.directionHold = 0;
    this.lockup = 0;
  }

  private schedule(pedals: Readonly<DriverPedals>, stopped: boolean): void {
    if (stopped) {
      if (this.gear > 1) this.shiftTo(1);
      return;
    }
    if (this.shiftTime > 0) return;
    const throttle = pedals.accelerator;
    const gear = this.gear;
    const perRatio = this.rpmPerRatio;
    const rpm = perRatio * this.gearRatios[gear + 1]!;
    const up = AT.upshiftRpm + AT.upshiftRpmPerThrottle * throttle;
    const down = AT.downshiftRpm + AT.downshiftRpmPerThrottle * throttle;
    if (gear < AT.ratios.length && rpm > up) {
      this.shiftTo(gear + 1);
      return;
    }
    if (gear > 1) {
      const lower = perRatio * this.gearRatios[gear]!;
      if (lower < down || (throttle > AT.kickdownThrottle && lower < AT.kickdownMaxRpm)) this.shiftTo(gear - 1);
    }
  }

  private shiftTo(gear: number): void {
    if (gear === this.gear) return;
    this.gear = gear;
    this.shiftTime = AT.shiftSeconds;
    this.lockup = 0;
  }

  private updateLockup(): void {
    const dt = this.dt;
    // The turbine's rpm in the gear engaged now (after a shift this step, the old gear's: the shift holds the lockup off).
    const turbineRpm = this.gearRatios[this.gear + 1] === 0 ? 0 : Math.abs(this.inputOmega) * RPM_PER_RAD_S;
    let target = 0;
    if (this.gear >= AT.lockupFromGear && this.shiftTime <= 0) {
      if (turbineRpm > AT.lockupRpm) target = 1;
      else if (turbineRpm > AT.lockupReleaseRpm && this.lockup > 0) target = 1;
    }
    if (target > this.lockup) this.lockup = Math.min(1, this.lockup + dt / AT.lockupSeconds);
    else if (target < this.lockup) this.lockup = Math.max(0, this.lockup - dt / LOCKUP_RELEASE_SECONDS);
  }

  /** The payload's selector, gear, range and locks. */
  fill(state: Pick<CarVisualState, "selector" | "gear" | "range" | "locks">): void {
    state.selector = this.selector;
    state.gear = this.gear;
    state.range = this.range;
    state.locks = this.locks;
  }

  /** A recovery: stopped in P, in the range and locks it had. */
  reset(): void {
    this.shiftTime = 0;
    this.lockup = 0;
    this.directionHold = 0;
    this.selector = "P";
    this.gear = 0;
    this.refresh();
  }
}

export interface ConverterState {
  /** Inputs: the pump (engine) and turbine speeds, rad/s. */
  pumpOmega: number;
  turbineOmega: number;
  /** Outputs: the torque the fluid takes from the pump, and gives the turbine, N m. */
  pump: number;
  turbine: number;
}

/**
 * The torque converter's two torques, N m, from the pump (engine) and
 * turbine speeds: pump (w / K)^2 times a capacity factor, the turbine that
 * times the torque ratio. Below the coupling point the ratio falls from the
 * stall ratio to 1 and the capacity is full; above it the capacity fades to
 * nothing at a speed ratio of 1. On the overrun the turbine drives the pump
 * at 60% of the drive capacity: engine braking through the fluid.
 */
export function converterTorques(out: ConverterState): void {
  const pumpOmega = out.pumpOmega;
  const turbineOmega = out.turbineOmega;
  const K = AT.converterK;
  const coupling = AT.converterCouplingPoint;
  const stall = AT.converterStallRatio;
  if (!(pumpOmega > 1)) {
    // A stopped engine: the turbine spins the fluid against nothing much.
    const drag = (turbineOmega / K) * (turbineOmega / K) * 0.05 * Math.sign(turbineOmega);
    out.pump = -drag;
    out.turbine = -drag;
    return;
  }
  if (turbineOmega <= pumpOmega) {
    const ratio = turbineOmega / pumpOmega;
    let capacity = 1;
    let torqueRatio = 1;
    if (ratio < 0) {
      // The car rolling against the gear: more than stall, the fluid fights it.
      capacity = 1 - 0.5 * Math.max(ratio, -2);
      torqueRatio = stall;
    } else if (ratio < coupling) {
      torqueRatio = stall - (stall - 1) * (ratio / coupling);
    } else {
      capacity = (1 - ratio) / (1 - coupling);
    }
    const pump = (pumpOmega / K) * (pumpOmega / K) * capacity;
    out.pump = pump;
    out.turbine = pump * torqueRatio;
    return;
  }
  const ratio = pumpOmega / turbineOmega;
  const capacity = ratio < coupling ? 1 : (1 - ratio) / (1 - coupling);
  const torque = -(turbineOmega / K) * (turbineOmega / K) * capacity * 0.6;
  out.pump = torque;
  out.turbine = torque;
}
