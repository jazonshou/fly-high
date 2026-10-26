import type { BoatControlState } from "@/src/game/types";
import type { StabilityAssistMode } from "../assists";
import { clamp } from "../math";
import type { BoatDefinition } from "./definition";

/**
 * The boat's three assist modes, mapped from the aircraft's (the plan's
 * "Assists" table):
 *
 * - Scenic: Active Trim (power trim scheduled by speed, then held at a 4
 *   degree running trim, as Mercury's Active Trim does), tabs levelling the
 *   heel on their own, steering eased at speed, and the throttle eased while
 *   the propeller is ventilating so it hooks back up.
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
  /** Speed through the water, m/s. */
  speed: number;
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
    out.steerAngle = steer * lock * authority;
    out.steerRate = 30 * DEG;
    // Active Trim, with the driver's rocker as an offset on the schedule.
    this.trimOffset = clamp(this.trimOffset + out.trimRate * 2 * DEG * input.dt, -6 * DEG, 6 * DEG);
    const planing = knots > 22;
    if (planing && input.ventilation < 0.3) {
      this.trimHold = clamp(this.trimHold + (4 * DEG - input.runningTrim) * 0.6 * input.dt, -4 * DEG, 4 * DEG);
    } else {
      this.trimHold *= Math.max(0, 1 - input.dt);
    }
    const ventilationTrimIn = input.ventilation * 6 * DEG;
    out.trimAuto = true;
    out.trimTarget = activeTrimSchedule(this.definition, input.speed) + this.trimHold + this.trimOffset - ventilationTrimIn;
    // Tabs level the heel when the helm is near centre and the boat is running.
    out.tabsAuto = true;
    if (Math.abs(steer) < 0.15 && knots > 12) {
      this.tabHeelIntegral = clamp(this.tabHeelIntegral + input.heel * 0.8 * input.dt, -0.5, 0.5);
    } else {
      this.tabHeelIntegral *= Math.max(0, 1 - 0.5 * input.dt);
    }
    out.tabDifferential = clamp(input.heel * 2.5 + this.tabHeelIntegral, -0.6, 0.6);
    // Ease the throttle while the propeller is blown out, so it hooks back up.
    if (input.ventilation > 0.3 && Math.abs(out.lever) > 0.4) {
      out.lever *= 1 - 0.45 * clamp((input.ventilation - 0.3) / 0.5, 0, 1);
    }
    return out;
  }
}
