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
 * (omega_n 2.16-3.82 rad/s on the J-45, so omega*tau >= 2.59 and the
 * high-pass passes >= 93% of the mode) at nearly full gain while a held turn
 * sees the rudder contribution decay to nothing. Re-checked against the
 * J-45's measured omega_n: the fit does not call for a longer constant.
 */
const WASHOUT_TIME_CONSTANT_SECONDS = 1.2;
/**
 * `apply` runs exactly once per fixed 120 Hz simulation step - the worker
 * calls it inside its fixed-step loop next to DirectPitchRetention - so the
 * washout filter advances by a fixed 1/120 s per airborne call.
 */
const FILTER_STEP_SECONDS = 1 / 120;
/**
 * Yaw-damper gain, re-derived for the Vesper J-45's coefficients (Cn_beta
 * 0.13, Cn_r -0.38, Cn_dr 0.082, Iyy 54,000, b 9.6 m, S 25.8 m^2) via the
 * two-DOF dutch-roll model, then sized against the full nonlinear model.
 *
 * Two-DOF sketch (beta_dot = Ybeta'*beta - r; r_dot = Nbeta*beta + Nr'*r):
 *   N_dr = qS*b*Cn_dr/Iyy is the rudder yaw authority, so washed-rate
 *   feedback adds k_r*N_dr*H(omega) to 2*zeta*omega_n, where H is the
 *   washout high-pass gain omega*tau/sqrt(1 + (omega*tau)^2).
 * At the binding 120 m/s corner (2,000 m, rho 0.968, q 6,971 Pa):
 *   N_dr = 6971*25.8*9.6*0.082/54000 = 2.62 s^-2 per unit rudder
 *   omega_n = 2.16 rad/s measured, H(2.16, tau 1.2) = 0.93
 *   open loop 2*zeta*omega_n = 2*0.163*2.16 = 0.70 s^-1
 *   lifting that to zeta 0.45 needs k_r = 1.24/(2.62*0.93) = 0.51.
 * The sketch ignores roll coupling, and the J-45 couples hard: Cl_beta 0.052
 * into Ixx 11,900 is a far smaller roll inertia than the yaw inertia driving
 * the mode. Measured in the full model (5-degree sideslip release, log
 * decrement over peaks above 5% of the initial amplitude), k_r 0.51 delivers
 * only zeta 0.385 at 120 m/s. The nonlinear fit sizes the gain at 1.1, where
 * the 120 m/s response has also reached its plateau (1.4 buys nothing) so the
 * choice is not on a knife edge.
 *
 * Measured open/closed-loop zeta with k_r 1.1 and k_p 0.12, at 2,000 m:
 *   120 m/s: 0.163 -> 0.487
 *   160 m/s: 0.164 -> 0.571
 *   200 m/s: 0.164 -> 0.623
 *   230 m/s: 0.163 -> 0.651
 *   260 m/s: 0.163 -> 0.675
 * (open-loop zeta is nearly speed-invariant at fixed density and scales with
 * sqrt(rho) at altitude, which is exactly why a rate damper rather than more
 * airframe Cn_r is the right instrument; closed loop clears the zeta >= 0.45
 * floor at 120 m/s and the >= 0.5 floor across the 200-260 m/s cruise band.)
 *
 * This is ~5x the gain the F-22 build carried because that airframe was given
 * Cn_r -0.70 (open-loop zeta 0.32) while the J-45 keeps its original -0.38
 * (open-loop zeta 0.163) - the damper has to supply roughly twice as much.
 * The 0.35 limit is never reached by the mode itself: it corresponds to a
 * washed yaw rate of 18 deg/s, and the measured dutch-roll peak at 120 m/s is
 * 8 deg/s, so the limit only bounds a violent departure.
 */
const YAW_DAMPER_GAIN = 1.1;
const YAW_DAMPER_LIMIT = 0.35;
/**
 * Small roll-rate damper taking the edge off dutch-roll coupling into roll.
 * At 200 m/s it adds 0.12*qS*b*Cl_da/Ixx = 4.3 s^-1 on top of the airframe's
 * own 7.2 s^-1 of roll damping - a ~60% increase on a neutral stick only, and
 * worth ~0.02 of closed-loop zeta at every speed.
 */
const ROLL_DAMPER_GAIN = 0.12;
const ROLL_DAMPER_LIMIT = 0.2;

/**
 * Washout-filtered yaw damper plus roll-rate damper for the jet's default
 * Direct (unassisted) mode. The dutch roll is otherwise underdamped enough
 * (open-loop zeta 0.163, falling with sqrt(rho) at altitude) that every
 * rudder or gust input rings visibly - the "drunk" report.
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
