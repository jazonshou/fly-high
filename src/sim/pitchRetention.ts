import { clamp } from "./math";
import type { FlightControls, FlightState, FlightTelemetry } from "./types";

const PILOT_COMMAND_THRESHOLD = 0.025;
const MIN_CONTROL_AIRSPEED = 12;
const ATTITUDE_GAIN = 2.15;
const BODY_RATE_DAMPING = 0.68;
const AUTHORITY_REGULARIZATION = 0.12;
const TRIM_TARGET_RADIANS_PER_UNIT = (25 * Math.PI) / 180;
/**
 * On release the airframe still carries pitch rate (keyboard input decays at
 * 2.8/s and the elevator actuator at 7/s), so freezing the release-instant
 * attitude guarantees a momentum overshoot followed by a pull-back - the
 * reported bounce. The capture instead leads the attitude by the rate:
 * d(noseVertical)/dt = pitchRate * pitchAuthority for a pure body-pitch rate,
 * so the target is where the nose will coast to as the rate decays.
 */
const SETTLE_LEAD_SECONDS = 0.35;
/**
 * The attitude-error term fades in over this period after capture so the
 * holder shepherds the nose toward the settle target instead of snatching at
 * it while rates are still high. Rate damping runs at full strength from the
 * first frame - it opposes the bounce. `apply` runs exactly once per fixed
 * 120 Hz simulation step (the worker calls it inside its fixed-step loop), so
 * engagement time advances by a fixed 1/120 per airborne call.
 */
const ENGAGE_RAMP_SECONDS = 0.5;
const ENGAGE_STEP_SECONDS = 1 / 120;

interface PitchRetentionFrame {
  noseVertical: number;
  pitchAuthority: number;
}

/**
 * Extracts the attitude needed by the pitch holder directly from the aircraft
 * quaternion. `noseVertical` is the world-up component of body-forward, while
 * `pitchAuthority` is the world-up component of body-up and therefore the
 * signed amount by which positive body pitch moves the nose vertically.
 *
 * Unlike an Euler pitch angle this stays finite at vertical and correctly
 * reverses elevator authority when the aircraft is inverted.
 */
function pitchRetentionFrame(state: FlightState): PitchRetentionFrame {
  const orientation = state.orientation;
  const lengthSquared =
    orientation.x * orientation.x +
    orientation.y * orientation.y +
    orientation.z * orientation.z +
    orientation.w * orientation.w;
  const inverseLength =
    Number.isFinite(lengthSquared) && lengthSquared > 1e-12
      ? 1 / Math.sqrt(lengthSquared)
      : 1;
  const x = Number.isFinite(orientation.x) ? orientation.x * inverseLength : 0;
  const y = Number.isFinite(orientation.y) ? orientation.y * inverseLength : 0;
  const z = Number.isFinite(orientation.z) ? orientation.z * inverseLength : 0;
  const w = Number.isFinite(orientation.w) ? orientation.w * inverseLength : 1;

  return {
    // Y components of R * body-forward (+X) and R * body-up (+Y).
    noseVertical: clamp(2 * (x * y + w * z), -1, 1),
    pitchAuthority: clamp(1 - 2 * (x * x + z * z), -1, 1),
  };
}

/**
 * Direct controls retain byte-for-byte surface authority while the pilot is
 * moving the pitch axis. The holder is deliberately unarmed at construction
 * and after every reset: only an actual pilot pitch command followed by a
 * return to neutral captures an attitude.
 *
 * The captured target is the nose's world-vertical component rather than an
 * Euler angle. Elevator allocation uses signed body-up authority, so the
 * controller remains bounded and commands the correct direction when banked,
 * inverted, or passing through vertical.
 */
export class DirectPitchRetention {
  private targetNoseVertical: number | null = null;
  private pilotWasCommanding = false;
  private lastRequestedTrim: number | null = null;
  private engagementSeconds = 0;

  /** Disarms retention. Pause/resume intentionally does not call this. */
  reset(): void {
    this.targetNoseVertical = null;
    this.pilotWasCommanding = false;
    this.lastRequestedTrim = null;
    this.engagementSeconds = 0;
  }

  apply(
    out: FlightControls,
    requested: FlightControls,
    state: FlightState,
    telemetry: FlightTelemetry,
  ): FlightControls {
    const pilotIsCommanding = Math.abs(requested.pitch) > PILOT_COMMAND_THRESHOLD;

    // A landing, crash, or loss of meaningful control authority starts a fresh
    // lifecycle instead of restoring a stale airborne target later.
    if (state.onGround || telemetry.indicatedAirspeed < MIN_CONTROL_AIRSPEED) {
      this.reset();
      this.pilotWasCommanding = pilotIsCommanding;
      this.lastRequestedTrim = requested.trim;
      return out;
    }

    const frame = pitchRetentionFrame(state);

    // Active Direct input is never reshaped, limited, damped, or supplemented.
    if (pilotIsCommanding) {
      this.pilotWasCommanding = true;
      this.lastRequestedTrim = requested.trim;
      return out;
    }

    if (this.pilotWasCommanding) {
      // Rate-led settle target: capture where the nose will coast to given
      // its current body pitch rate, not where it happens to point right now.
      const releasePitchRate = Number.isFinite(state.angularVelocity.z)
        ? state.angularVelocity.z
        : 0;
      this.targetNoseVertical = clamp(
        frame.noseVertical +
          releasePitchRate * frame.pitchAuthority * SETTLE_LEAD_SECONDS,
        -1,
        1,
      );
      this.engagementSeconds = 0;
      this.pilotWasCommanding = false;
      this.lastRequestedTrim = requested.trim;
    } else if (this.targetNoseVertical === null) {
      // Neutral Direct input before the pilot has selected an attitude is raw
      // flight, not a hidden hold of the spawn or menu-demo pitch.
      this.lastRequestedTrim = requested.trim;
      return out;
    }

    const previousTrim = this.lastRequestedTrim ?? requested.trim;
    const trimDelta = requested.trim - previousTrim;
    this.lastRequestedTrim = requested.trim;
    if (Math.abs(trimDelta) > 1e-9) {
      // A normal 0.04 keyboard trim step requests roughly one degree near
      // wings-level, with the physical direction correctly reversed inverted.
      this.targetNoseVertical = clamp(
        this.targetNoseVertical +
          trimDelta * TRIM_TARGET_RADIANS_PER_UNIT * frame.pitchAuthority,
        -1,
        1,
      );
    }

    const noseError = this.targetNoseVertical - frame.noseVertical;
    const authority = frame.pitchAuthority;
    // Regularized allocation preserves sign inverted, boosts useful response at
    // high bank, and smoothly reaches zero at knife-edge without division by a
    // vanishing control derivative.
    const allocation =
      (authority * (1 + AUTHORITY_REGULARIZATION)) /
      (authority * authority + AUTHORITY_REGULARIZATION);
    const pitchRate = Number.isFinite(state.angularVelocity.z)
      ? state.angularVelocity.z
      : 0;
    // Only the attitude-error term ramps; rate damping opposes the bounce and
    // acts at full strength from the capture frame onward.
    const holdAuthority = clamp(
      this.engagementSeconds / ENGAGE_RAMP_SECONDS,
      0,
      1,
    );
    this.engagementSeconds = Math.min(
      ENGAGE_RAMP_SECONDS,
      this.engagementSeconds + ENGAGE_STEP_SECONDS,
    );
    out.pitch = clamp(
      noseError * ATTITUDE_GAIN * allocation * holdAuthority -
        pitchRate * BODY_RATE_DAMPING,
      -0.72,
      0.72,
    );
    return out;
  }

  get isArmed(): boolean {
    return this.targetNoseVertical !== null;
  }

  /** Principal-angle view retained for diagnostics and backwards compatibility. */
  get target(): number | null {
    return this.targetNoseVertical === null
      ? null
      : Math.asin(clamp(this.targetNoseVertical, -1, 1));
  }

  get noseVerticalTarget(): number | null {
    return this.targetNoseVertical;
  }
}
