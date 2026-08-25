import { clamp } from "./math";
import type { FlightControls, FlightState, FlightTelemetry } from "./types";

/**
 * The DirectPitchRetention doctrine, verbatim: an axis the pilot is actively
 * commanding is never modified. Below this threshold the axis is treated as
 * neutral and the damper contribution is added to the (near-zero) request.
 */
const PILOT_COMMAND_THRESHOLD = 0.04;
/** The dampers only make sense with real aerodynamic authority. */
const MIN_ENGAGE_INDICATED_AIRSPEED = 30;
/**
 * Washout high-pass time constant. Steady coordinated-turn yaw rate washes
 * out with tau = 1.2 s, so the damper fights the dutch-roll oscillation
 * (omega_n 2-4.3 rad/s, omega*tau >= 2.5) at nearly full gain while a held
 * turn sees the rudder contribution decay to nothing.
 */
const WASHOUT_TIME_CONSTANT_SECONDS = 1.2;
/**
 * `apply` runs exactly once per fixed 120 Hz simulation step - the worker
 * calls it inside its fixed-step loop next to DirectPitchRetention - so the
 * washout filter advances by a fixed 1/120 s per airborne call.
 */
const FILTER_STEP_SECONDS = 1 / 120;
/**
 * Yaw-damper gain, derived from the F-22 coefficients via the two-DOF
 * dutch-roll model (see the FAST_JET comment in aircraft.ts):
 *   added damping = qS*b*Cn_dr*k_r/Iyy per unit washed yaw rate.
 * At 200 m/s sea level qS*b*Cn_dr/Iyy = 9.72, and lifting 2*zeta*omega_n
 * from the open loop to zeta 0.5 would need k_r ~ 0.11 in that sketch. The
 * full nonlinear model loses damping to roll coupling the sketch ignores,
 * and the fix-pack's hard floor is zeta >= 0.45 at BOTH 120 and 250 m/s;
 * rate-feedback authority scales with dynamic pressure, so the 120 m/s
 * corner sizes the gain (together with the airframe's Cnr, see aircraft.ts).
 * Measured closed-loop zeta with this gain: 0.47 at 120 m/s, 0.60 at 200,
 * 0.67 at 250, 0.73 at 300 - the 200 m/s point sits above the plan's
 * "about 0.5" because the 120 m/s floor binds first.
 */
const YAW_DAMPER_GAIN = 0.20;
const YAW_DAMPER_LIMIT = 0.35;
/** Small roll-rate damper taking the edge off dutch-roll coupling into roll. */
const ROLL_DAMPER_GAIN = 0.08;
const ROLL_DAMPER_LIMIT = 0.2;

/**
 * Washout-filtered yaw damper plus roll-rate damper for the jet's default
 * Direct (unassisted) mode. The dutch roll is otherwise underdamped enough
 * (open-loop zeta 0.34 at sea level, falling with sqrt(rho) at altitude) that
 * every rudder or gust input rings visibly - the "drunk" report.
 *
 * Like DirectPitchRetention this is pure state-in/controls-out, engages only
 * airborne with meaningful airspeed, and never touches an axis the pilot is
 * actively commanding. The worker applies it only for the jet; the trainer's
 * control path never sees it.
 */
export class JetStabilityAugmentation {
  private yawRateLowPass = 0;
  private washoutPrimed = false;
  private lastRudderContribution = 0;
  private lastAileronContribution = 0;

  /** Clears the washout filter. Called on every spawn, like pitch retention. */
  reset(): void {
    this.yawRateLowPass = 0;
    this.washoutPrimed = false;
    this.lastRudderContribution = 0;
    this.lastAileronContribution = 0;
  }

  apply(
    out: FlightControls,
    requested: FlightControls,
    state: FlightState,
    telemetry: FlightTelemetry,
  ): FlightControls {
    if (
      state.onGround ||
      state.crashed ||
      telemetry.indicatedAirspeed < MIN_ENGAGE_INDICATED_AIRSPEED
    ) {
      this.reset();
      return out;
    }

    const yawRate = Number.isFinite(state.angularVelocity.y)
      ? state.angularVelocity.y
      : 0;
    // Priming to the current rate on engagement makes the washed rate start
    // at zero, so crossing the engage speed mid-turn cannot kick the rudder.
    if (!this.washoutPrimed) {
      this.yawRateLowPass = yawRate;
      this.washoutPrimed = true;
    }
    // The filter advances every airborne call, including while the pilot
    // commands the axis, so a later release never sees stale turn history.
    this.yawRateLowPass +=
      (yawRate - this.yawRateLowPass) *
      (FILTER_STEP_SECONDS / WASHOUT_TIME_CONSTANT_SECONDS);
    const washedYawRate = yawRate - this.yawRateLowPass;

    if (Math.abs(requested.yaw) <= PILOT_COMMAND_THRESHOLD) {
      // Positive body yaw rate is nose-right; positive rudder command is also
      // nose-right, so the damper opposes the washed rate directly.
      this.lastRudderContribution = clamp(
        -YAW_DAMPER_GAIN * washedYawRate,
        -YAW_DAMPER_LIMIT,
        YAW_DAMPER_LIMIT,
      );
      out.yaw = clamp(out.yaw + this.lastRudderContribution, -1, 1);
    } else {
      this.lastRudderContribution = 0;
    }

    if (Math.abs(requested.roll) <= PILOT_COMMAND_THRESHOLD) {
      // Body +X roll rate is a left-bank rate; the pilot-positive (right)
      // aileron command opposes it, matching the pilot-mode damper sign.
      const pilotSignRollRate = Number.isFinite(state.angularVelocity.x)
        ? -state.angularVelocity.x
        : 0;
      this.lastAileronContribution = clamp(
        -ROLL_DAMPER_GAIN * pilotSignRollRate,
        -ROLL_DAMPER_LIMIT,
        ROLL_DAMPER_LIMIT,
      );
      out.roll = clamp(out.roll + this.lastAileronContribution, -1, 1);
    } else {
      this.lastAileronContribution = 0;
    }

    return out;
  }

  /** Diagnostics for tests: the rudder the damper is currently adding. */
  get rudderContribution(): number {
    return this.lastRudderContribution;
  }

  /** Diagnostics for tests: the aileron the damper is currently adding. */
  get aileronContribution(): number {
    return this.lastAileronContribution;
  }
}
