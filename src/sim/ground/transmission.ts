import type {
  CarControlState,
  CarDiffLocks,
  CarGearbox,
  CarSetup,
  CarTransferRange,
  CarVisualState,
} from "@/src/game/types";
import { LANDCRUISER_76 } from "@/src/vehicles/landcruiser76";
import { RPM_PER_RAD_S, type Engine } from "./engine";

/**
 * Everything between the crank and the propeller shafts that a driver
 * chooses or a controller schedules: the automatic's selector, shift
 * schedule, kickdown, sequential mode and lockup; the manual's gears and its
 * dry clutch, worked by the auto-clutch or the player's pedal; the transfer
 * range and the diff locks. It runs once per 120 Hz step and hands the
 * driveline solver its ratios, inertias and clutch capacities.
 *
 * The pedals: W is the accelerator and S the service brake, except that at
 * a stop holding S selects reverse and holding W selects drive (the plan's
 * controls), and in reverse S drives and W brakes. Only a fresh press does
 * it: S held through the stop holds the car, as a brake pedal does on a
 * hill, and S let up and held again backs it up. The manual does that only
 * with the auto-clutch; with the player's clutch it is a plain H-pattern
 * through R, N and 1 to 5 on the shift keys.
 */

const AT = LANDCRUISER_76.automatic;
const MT = LANDCRUISER_76.manual;
const TRANSFER = LANDCRUISER_76.transfer;

/** Under this speed, m/s, the car counts as stopped for the selector, the range and the locks. */
export const STOPPED_SPEED = 0.4;
/** How long S (or W in reverse) must be held at a stop to change direction, s. */
const DIRECTION_HOLD_SECONDS = 0.3;
/** The sequential mode's protection: no downshift that would put the input over this rpm. */
const MANUAL_MODE_OVERREV_RPM = 3_800;
/** And it steps down by itself when the input falls under this. */
const MANUAL_MODE_LUG_RPM = 950;
const LOCKUP_RELEASE_SECONDS = 0.1;
/** The auto-clutch's hold on the launch speed, N m of clutch torque per rad/s the engine is over it. */
const AUTO_CLUTCH_GAIN = 12;
/** Off the throttle the auto-clutch is open by this multiple of idle at the input shaft. */
const AUTO_CLUTCH_COAST = 1.1;
/** How far ahead of its release time the auto-clutch reads the shaft's fall: the plate slips late. */
const AUTO_CLUTCH_LEAD = 1.5;
/** The smoothing of the input shaft's rate, s. */
const INPUT_RATE_SECONDS = 0.05;

/** Each gearbox's ratios by `gear + 1`, signed: reverse, neutral, then the forward gears. */
const AT_GEAR_RATIOS = Float64Array.of(-AT.reverse, 0, ...AT.ratios);
const MT_GEAR_RATIOS = Float64Array.of(-MT.reverse, 0, ...MT.ratios);

export interface DriverPedals {
  /** The accelerator and service brake as the car uses them, after reverse's swap. */
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
  engineOmega: number;
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

type AutoClutchPhase = "engaged" | "releasing" | "engaging";

export class Transmission {
  readonly gearbox: CarGearbox;
  readonly manualClutch: boolean;
  /** The automatic's selector; null with the manual. */
  selector: "P" | "R" | "N" | "D" | "M" | null;
  /** Gear engaged: -1 reverse, 0 neutral (and P), 1..6 or 1..5. */
  gear: number;
  range: CarTransferRange = "2H";
  locks: CarDiffLocks = "off";
  /** The manual's clutch engagement, 0 open .. 1 engaged; the automatic's lockup clutch likewise. */
  clutch: number;
  lockup = 0;
  /** Seconds left of a shift's torque gap. */
  shiftTime = 0;
  /** The automatic's turbine (or the manual's clutch disc) speed last step, rad/s. */
  inputOmega = 0;

  /*
   * What the driveline reads every substep, kept current by `refresh` as
   * plain fields: V8 boxes a number a getter returns when it does not inline
   * the getter, and the car's step allocates nothing.
   */
  /** The axles' final drive. */
  finalDrive: number;
  /** The transfer case's ratio in this range. */
  transferRatio: number = TRANSFER.high;
  /** Input shaft speed per rear propeller shaft speed: the gear times the transfer range (negative in reverse). */
  inputRatio = 0;
  /** The turbine (or clutch disc) and input shaft's inertia, kg m^2. */
  inputInertia: number;
  /** Share of the turbine's torque that reaches the output: less during a clutch-to-clutch shift. */
  torqueShare = 1;
  /** The coupling between the crank and the input shaft, N m: the dry clutch, or the converter's lockup. */
  couplingCapacity = 0;

  private readonly gearRatios: Float64Array;
  private dt = 0;
  private speed = 0;
  /**
   * This step's turbine rpm per unit of gear ratio at the output speed:
   * times a gear's ratio, the turbine rpm the box would have in that gear.
   */
  private rpmPerRatio = 0;

  /** The input shaft's speed change, rad/s per s, smoothed: the auto-clutch reads a stop coming. */
  private inputRate = 0;
  private directionHold = 0;
  /** The direction rule's pedal has been up with the car stopped: only a fresh press at a stop changes direction. */
  private directionArmed = false;
  private autoClutchPhase: AutoClutchPhase = "engaged";
  private autoClutchTime = 0;
  private pendingGear = 0;
  private readonly shiftUp = new PressCounter();
  private readonly shiftDown = new PressCounter();
  private readonly autoMode = new PressCounter();
  private readonly rangePresses = new PressCounter();
  private readonly lockPresses = new PressCounter();

  constructor(setup: Readonly<CarSetup>) {
    this.gearbox = setup.gearbox;
    this.manualClutch = setup.gearbox === "manual" && setup.manualClutch;
    const automatic = setup.gearbox === "automatic";
    this.finalDrive = automatic ? AT.finalDrive : MT.finalDrive;
    this.inputInertia = automatic ? AT.inputInertia : MT.inputInertia;
    this.gearRatios = automatic ? AT_GEAR_RATIOS : MT_GEAR_RATIOS;
    if (automatic) {
      this.selector = "P";
      this.gear = 0;
      this.clutch = 1;
    } else {
      this.selector = null;
      // The auto-clutch waits in first with the clutch open; the player's clutch starts in neutral.
      this.gear = this.manualClutch ? 0 : 1;
      this.clutch = this.manualClutch ? 1 : 0;
      this.autoClutchPhase = "engaging";
    }
    this.refresh();
  }

  get automatic(): boolean {
    return this.gearbox === "automatic";
  }

  get fourWheelDrive(): boolean {
    return this.range !== "2H";
  }

  /** The gear's own ratio, signed: negative in reverse, 0 in neutral or park. */
  gearRatio(gear = this.gear): number {
    return this.gearRatios[gear + 1]!;
  }

  /** The automatic is driving through its converter (D, M or R). */
  get converterEngaged(): boolean {
    return this.automatic && this.gear !== 0;
  }

  get parked(): boolean {
    return this.selector === "P";
  }

  /** Whether a stalled engine may crank now: the clutch down (the pedal past 0.8), or the automatic in P or N. */
  canCrank(controls: Readonly<CarControlState>): boolean {
    if (this.automatic) return this.gear === 0;
    return this.gear === 0 || this.clutch < 0.05 || (this.manualClutch && controls.clutch > 0.8);
  }

  /** Bring the fields the driveline reads up to date with the gear, range, clutch and shift. */
  private refresh(): void {
    this.transferRatio = this.range === "4L" ? TRANSFER.low : TRANSFER.high;
    this.inputRatio = this.gearRatios[this.gear + 1]! * this.transferRatio;
    this.torqueShare = this.automatic && this.shiftTime > 0 ? AT.shiftTorqueShare : 1;
    this.couplingCapacity = this.gear === 0
      ? 0
      : this.automatic ? AT.lockupCapacity * this.lockup : MT.clutchCapacity * this.clutch;
  }

  /**
   * One 120 Hz step of `motion.dt`: presses, the direction rule, the
   * schedule and the clutch. Writes the pedals as the car uses them into
   * `pedals`.
   */
  update(
    controls: Readonly<CarControlState>,
    motion: Readonly<TransmissionMotion>,
    engine: Engine,
    pedals: DriverPedals,
  ): void {
    const dt = motion.dt;
    this.dt = dt;
    this.speed = motion.speed;
    const stopped = Math.abs(motion.speed) < STOPPED_SPEED;
    const previousInput = this.inputOmega;
    this.inputOmega = this.inputRatio * motion.rearPropOmega;
    const ratio = this.gearRatios[this.gear + 1]!;
    this.rpmPerRatio = ratio === 0 ? 0 : (this.inputOmega / ratio) * RPM_PER_RAD_S;
    if (dt > 0) this.inputRate += (Math.min(1, dt / INPUT_RATE_SECONDS)) * ((this.inputOmega - previousInput) / dt - this.inputRate);
    this.updateRange(controls);
    if (this.shiftTime > 0) this.shiftTime = Math.max(0, this.shiftTime - dt);
    if (this.automatic) this.updateAutomatic(controls, stopped, pedals);
    else this.updateManual(controls, motion, stopped, engine, pedals);
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
    const s = controls.brake;
    const ups = this.shiftUp.take(controls.shiftUpPresses);
    const downs = this.shiftDown.take(controls.shiftDownPresses);
    const autoPresses = this.autoMode.take(controls.autoModePresses);
    const selector = this.selector!;

    // Direction: W at a stop selects D; S held at a stop selects R; W held at a stop in R selects D.
    if (selector === "R") {
      pedals.accelerator = s;
      pedals.brake = w;
      if (this.directionRequested(stopped, controls, true)) this.selectDrive();
    } else if (selector === "P" || selector === "N") {
      pedals.accelerator = 0;
      pedals.brake = s;
      if (stopped && w > 0.05) this.selectDrive();
      else if (this.directionRequested(stopped, controls, false)) this.selectReverse();
      if (this.selector === "D") pedals.accelerator = w;
    } else {
      pedals.accelerator = w;
      pedals.brake = s;
      if (this.directionRequested(stopped, controls, false)) {
        this.selectReverse();
        pedals.accelerator = s;
        pedals.brake = 0;
      }
    }

    if (this.selector === "D" || this.selector === "M") {
      if (ups + downs > 0 && this.selector === "D") this.selector = "M";
      if (autoPresses > 0 && this.selector === "M") this.selector = "D";
      if (this.selector === "M") this.manualMode(ups, downs, stopped);
      else this.schedule(pedals, stopped);
    }
    this.updateLockup();
    this.clutch = this.gear === 0 ? 0 : 1;
  }

  /**
   * The arcade direction rule's trigger: the pedal (S going forward, W in
   * reverse: `viaAccelerator`) pressed afresh once the car is stopped and
   * held for a moment, with the other up. A pedal held through the stop
   * only holds the car, so the brake holds it on a hill; let it up and
   * press again to change direction.
   */
  private directionRequested(stopped: boolean, controls: Readonly<CarControlState>, viaAccelerator: boolean): boolean {
    const pedal = viaAccelerator ? controls.accelerator : controls.brake;
    const other = viaAccelerator ? controls.brake : controls.accelerator;
    if (!stopped) {
      this.directionArmed = false;
      this.directionHold = 0;
      return false;
    }
    if (pedal <= 0.02) {
      this.directionArmed = true;
      this.directionHold = 0;
      return false;
    }
    if (!this.directionArmed || pedal <= 0.05 || other > 0.02) {
      this.directionHold = 0;
      return false;
    }
    this.directionHold += this.dt;
    if (this.directionHold < DIRECTION_HOLD_SECONDS) return false;
    // The pedal is the other direction's accelerator now: it must come up before it can change back.
    this.directionHold = 0;
    this.directionArmed = false;
    return true;
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

  private manualMode(ups: number, downs: number, stopped: boolean): void {
    const perRatio = this.rpmPerRatio;
    for (let i = 0; i < ups && this.gear < AT.ratios.length; i += 1) this.shiftTo(this.gear + 1);
    for (let i = 0; i < downs && this.gear > 1; i += 1) {
      if (perRatio * this.gearRatios[this.gear]! > MANUAL_MODE_OVERREV_RPM) break;
      this.shiftTo(this.gear - 1);
    }
    if (this.shiftTime > 0) return;
    if (stopped && this.gear > 1) this.shiftTo(1);
    else if (this.gear > 1 && perRatio * this.gearRatios[this.gear + 1]! < MANUAL_MODE_LUG_RPM) this.shiftTo(this.gear - 1);
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

  private updateManual(
    controls: Readonly<CarControlState>,
    motion: Readonly<TransmissionMotion>,
    stopped: boolean,
    engine: Engine,
    pedals: DriverPedals,
  ): void {
    const dt = this.dt;
    const w = controls.accelerator;
    const s = controls.brake;
    const ups = this.shiftUp.take(controls.shiftUpPresses);
    const downs = this.shiftDown.take(controls.shiftDownPresses);
    this.autoMode.take(controls.autoModePresses);
    pedals.accelerator = w;
    pedals.brake = s;

    if (this.manualClutch) {
      const pedal = Number.isFinite(controls.clutch) ? Math.max(0, Math.min(1, controls.clutch)) : 0;
      const t = Math.max(0, Math.min(1, (pedal - 0.15) / 0.7));
      this.clutch = 1 - t * t * (3 - 2 * t);
      // A gear goes in only with the clutch down.
      if (pedal > 0.7) {
        for (let i = 0; i < ups; i += 1) this.gear = this.nextManualGear(this.gear, 1);
        for (let i = 0; i < downs; i += 1) this.gear = this.nextManualGear(this.gear, -1);
      }
      return;
    }

    // The auto-clutch: the direction rule, sequential presses, launches and anti-stall.
    if (this.gear < 0) {
      pedals.accelerator = s;
      pedals.brake = w;
    }
    let requested = this.pendingGear !== 0 || this.autoClutchPhase === "releasing" ? this.pendingGear : this.gear;
    for (let i = 0; i < ups; i += 1) requested = this.nextManualGear(requested, 1);
    for (let i = 0; i < downs; i += 1) requested = this.nextManualGear(requested, -1);
    const forward = this.gear >= 0;
    if (this.directionRequested(stopped, controls, !forward)) {
      requested = forward ? -1 : 1;
    }
    if (requested !== this.gear && this.autoClutchPhase !== "releasing") {
      this.pendingGear = requested;
      this.autoClutchPhase = "releasing";
      this.autoClutchTime = 0;
    }

    switch (this.autoClutchPhase) {
      case "releasing": {
        this.autoClutchTime += dt;
        this.clutch = Math.max(0, this.clutch - dt / MT.autoClutchReleaseSeconds);
        // The throttle lifts through the change: the shift's torque gap.
        pedals.accelerator = 0;
        if (this.clutch <= 0) {
          this.gear = this.pendingGear;
          this.pendingGear = 0;
          this.autoClutchPhase = "engaging";
          this.shiftTime = MT.autoClutchEngageSeconds;
        }
        break;
      }
      case "engaging":
      case "engaged":
        this.autoClutchTake(motion, engine, pedals);
        break;
    }
  }

  /** The auto-clutch's take-up: hold the engine at the launch speed while the clutch slips, then lock. */
  private autoClutchTake(motion: Readonly<TransmissionMotion>, engine: Engine, pedals: DriverPedals): void {
    const dt = this.dt;
    if (this.gear === 0 || !engine.running) {
      this.clutch = Math.max(0, this.clutch - dt / MT.autoClutchReleaseSeconds);
      this.autoClutchPhase = "engaging";
      return;
    }
    const engineOmega = motion.engineOmega;
    const inputOmega = this.gearRatios[this.gear + 1]! * this.transferRatio * motion.rearPropOmega;
    const slip = engineOmega - inputOmega;
    const idle = LANDCRUISER_76.engine.idleRpm / RPM_PER_RAD_S;
    const throttle = pedals.accelerator;
    if (this.autoClutchPhase === "engaged") {
      // Anti-stall: off the throttle, the clutch lets go before the shaft's fall would take the
      // engine under idle by the time it is open; on it, the engine pulled under idle means it lugs.
      const opening = inputOmega + Math.min(0, this.inputRate) * MT.autoClutchReleaseSeconds * AUTO_CLUTCH_LEAD;
      if (engineOmega < idle * 0.85 || (throttle < 0.02 && opening < idle * AUTO_CLUTCH_COAST)) {
        this.autoClutchPhase = "engaging";
      } else {
        this.clutch = Math.min(1, this.clutch + dt / MT.autoClutchEngageSeconds);
        return;
      }
    }
    // Engaging: no throttle and slow means wait with the clutch open (no creep in a manual).
    if (throttle < 0.02 && inputOmega < idle * AUTO_CLUTCH_COAST) {
      this.clutch = Math.max(0, this.clutch - dt / MT.autoClutchReleaseSeconds);
      return;
    }
    if (inputOmega > engineOmega + 5) {
      // A downshift or the car pushing: the clutch takes up and drags the engine to speed.
      this.clutch = Math.min(1, this.clutch + dt / MT.autoClutchEngageSeconds);
    } else {
      // A launch: pass what the engine makes at this pedal, plus more while it is over the launch
      // speed and less while it is pulled under it, so the engine sits at the launch speed.
      const launch = (MT.launchRpm + MT.launchRpmPerThrottle * throttle) / RPM_PER_RAD_S;
      const target = Math.max(launch, inputOmega);
      engine.omega = engineOmega;
      engine.pedal = throttle;
      engine.evaluate();
      const torque = engine.pedalTorque + AUTO_CLUTCH_GAIN * (engineOmega - target);
      const wanted = Math.max(0, Math.min(1, torque / MT.clutchCapacity));
      const up = dt / MT.autoClutchEngageSeconds;
      const down = dt / MT.autoClutchReleaseSeconds;
      this.clutch += Math.max(-down, Math.min(up, wanted - this.clutch));
    }
    if (Math.abs(slip) < 8 && inputOmega > idle * 0.9) this.autoClutchPhase = "engaged";
  }

  /** The manual's sequence R, N, 1..5; reverse only nearly stopped. */
  private nextManualGear(gear: number, step: number): number {
    const next = gear + step;
    if (next > MT.ratios.length) return gear;
    if (next < -1) return gear;
    if (next === -1 && Math.abs(this.speed) > 1.5) return gear;
    return next;
  }

  /** The payload's selector, gear and clutch fields. */
  fill(state: Pick<CarVisualState, "selector" | "gear" | "clutch" | "range" | "locks" | "gearbox">): void {
    state.gearbox = this.gearbox;
    state.selector = this.selector;
    state.gear = this.gear;
    state.clutch = this.automatic ? (this.gear === 0 ? 0 : 1) : this.gear === 0 ? 0 : this.clutch;
    state.range = this.range;
    state.locks = this.locks;
  }

  /** A recovery: stopped in P (automatic) or first with the clutch open (manual), 2H. */
  reset(): void {
    this.shiftTime = 0;
    this.lockup = 0;
    this.directionHold = 0;
    this.directionArmed = false;
    this.pendingGear = 0;
    this.inputRate = 0;
    if (this.automatic) {
      this.selector = "P";
      this.gear = 0;
    } else {
      this.gear = this.manualClutch ? 0 : 1;
      this.clutch = this.manualClutch ? 1 : 0;
      this.autoClutchPhase = "engaging";
    }
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
