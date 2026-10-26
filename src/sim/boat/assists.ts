import type { BoatControlState } from "@/src/game/types";
import type { StabilityAssistMode } from "../assists";
import { clamp } from "../math";
import type { BoatDefinition } from "./definition";

/**
 * The boat's three assist modes, mapped from the aircraft's (the plan's
 * "Assists" table):
 *
 * - Scenic: Active Trim (power trim scheduled by speed, then held at a 4
 *   degree running trim, as Mercury's Active Trim does, and trimmed in
 *   with the helm over), tabs levelling the
 *   heel on their own, steering eased at speed and eased off as the hull
 *   slides, and the throttle eased while the propeller is ventilating so it
 *   hooks back up.
 * - Pilot: trim and tabs are the driver's; the helm turns at a limited rate.
 * - Direct ("unassisted"): everything raw, at the hydraulics' own rates,
 *   including porpoising if the engine is trimmed out too far.
 *
 * The output is what the actuators are driven toward this step.
 */
export interface BoatActuatorTargets {
  /** Binnacle lever after any easing, -1..1. */
  lever: number;
  /** Engine steer angle the helm asks for, radians, and how fast it may move, rad/s. */
  steerAngle: number;
  steerRate: number;
  /** Trim: a rate (-1..1 of the trim pump) or, when `trimAuto`, a target angle in radians. */
  trimRate: number;
  trimAuto: boolean;
  trimTarget: number;
  /** Tabs, each 0..1: a collective rate and, when `tabsAuto`, a differential target (starboard minus port). */
  tabRate: number;
  tabsAuto: boolean;
  tabDifferential: number;
}

export function createBoatActuatorTargets(): BoatActuatorTargets {
  return {
    lever: 0,
    steerAngle: 0,
    steerRate: 0,
    trimRate: 0,
    trimAuto: false,
    trimTarget: 0,
    tabRate: 0,
    tabsAuto: false,
    tabDifferential: 0,
  };
}

/** What the assists read of the boat. */
export interface BoatAssistInput {
  /** Speed through the water, m/s, and the CG's sideslip, radians (positive sliding to starboard). */
  speed: number;
  sideslip: number;
  /** Running trim of the keel against the local water, radians, bow up. */
  runningTrim: number;
  /** Heel, radians, starboard down positive. */
  heel: number;
  /** Current engine trim angle, radians. */
  trimAngle: number;
  ventilation: number;
  dt: number;
}

const DEG = Math.PI / 180;
const KNOT = 0.514444;

/** Scenic's Active Trim: the trim it schedules by speed before holding the running trim. */
export function activeTrimSchedule(definition: BoatDefinition, speed: number): number {
  const knots = speed / KNOT;
  const inDeg = definition.trimMinDegrees;
  // Trimmed fully in for the hole shot; out to +3 deg by 25 kn and +6 deg by 40 kn.
  if (knots <= 15) return inDeg * DEG;
  if (knots <= 25) return (inDeg + ((knots - 15) / 10) * 7) * DEG;
  return Math.min(8, 3 + ((knots - 25) / 15) * 3) * DEG;
}

export class BoatAssists {
  private trimOffset = 0;
  private trimHold = 0;
  private tabHeelIntegral = 0;

  constructor(private readonly definition: BoatDefinition) {}

  reset(): void {
    this.trimOffset = 0;
    this.trimHold = 0;
    this.tabHeelIntegral = 0;
  }

  apply(
    mode: StabilityAssistMode,
    controls: Readonly<BoatControlState>,
    input: Readonly<BoatAssistInput>,
    out: BoatActuatorTargets,
  ): BoatActuatorTargets {
    const lock = this.definition.steerLockDegrees * DEG;
    const steer = clamp(controls.steer, -1, 1);
    out.lever = clamp(controls.lever, -1, 1);
    out.trimRate = clamp(controls.trim, -1, 1);
    out.tabRate = clamp(controls.tabs, -1, 1);
    out.trimAuto = false;
    out.tabsAuto = false;
    out.tabDifferential = 0;
    if (mode === "unassisted") {
      out.steerAngle = steer * lock;
      out.steerRate = this.definition.steerRateDegrees * DEG;
      return out;
    }
    if (mode === "pilot") {
      out.steerAngle = steer * lock;
      out.steerRate = 40 * DEG;
      return out;
    }
    // Scenic.
    const knots = input.speed / KNOT;
    const authority = clamp(1 - ((knots - 10) / 30) * 0.55, 0.45, 1);
    // Past 12 degrees of sideslip on the plane the hull is sliding rather
    // than carving: the helm backs off toward a third, so a full-lock turn
    // stays a turn instead of a spin-out that drops off the plane.
    const sliding = knots > 12 ? clamp((Math.abs(input.sideslip) - 12 * DEG) / (10 * DEG), 0, 1) : 0;
    out.steerAngle = steer * lock * authority * (1 - 0.65 * sliding);
    out.steerRate = 30 * DEG;
    // Active Trim, with the driver's rocker as an offset on the schedule.
    this.trimOffset = clamp(this.trimOffset + out.trimRate * 2 * DEG * input.dt, -6 * DEG, 6 * DEG);
    const planing = knots > 22;
    // With the helm over, Active Trim trims in as a driver does before a
    // turn: the bow down keeps the propeller bitten, and a deep-V trimmed
    // out and heeled at speed starts to walk on its chines.
    const turning = clamp((Math.abs(steer) - 0.15) / 0.6, 0, 1);
    if (planing && input.ventilation < 0.3 && turning === 0) {
      this.trimHold = clamp(this.trimHold + (4 * DEG - input.runningTrim) * 0.6 * input.dt, -4 * DEG, 4 * DEG);
    } else if (turning === 0) {
      this.trimHold *= Math.max(0, 1 - input.dt);
    }
    const ventilationTrimIn = input.ventilation * 6 * DEG;
    out.trimAuto = true;
    out.trimTarget =
      activeTrimSchedule(this.definition, input.speed) + this.trimHold + this.trimOffset - ventilationTrimIn - turning * 5 * DEG;
    // Tabs level the heel when the helm is near centre and the boat is
    // running. With the helm over they stand off (a levelling system's turn
    // detection): the heel into a turn is the turn, and fighting it through
    // the tabs' slow travel only sets the hull rolling.
    out.tabsAuto = true;
    // Inside half a degree the tabs leave the heel alone (a levelling
    // system's deadband): the propeller's own torque list is not worth the drag.
    const level = Math.sign(input.heel) * Math.max(0, Math.abs(input.heel) - 0.5 * DEG);
    const straight = Math.abs(steer) < 0.15 && knots > 12;
    if (straight) {
      this.tabHeelIntegral = clamp(this.tabHeelIntegral + level * 0.8 * input.dt, -0.25, 0.25);
    } else {
      this.tabHeelIntegral *= Math.max(0, 1 - 0.5 * input.dt);
    }
    out.tabDifferential = clamp((straight ? level * 2.5 : 0) + this.tabHeelIntegral, -0.6, 0.6);
    // Ease the throttle while the propeller is blown out, so it hooks back up.
    if (input.ventilation > 0.3 && Math.abs(out.lever) > 0.4) {
      out.lever *= 1 - 0.45 * clamp((input.ventilation - 0.3) / 0.5, 0, 1);
    }
    return out;
  }
}
