import { clamp } from "./math";
import type { FlightControls, FlightState, FlightTelemetry } from "./types";

const PILOT_COMMAND_THRESHOLD = 0.025;
const MIN_CONTROL_AIRSPEED = 12;
const ATTITUDE_GAIN = 2.15;
const BODY_RATE_DAMPING = 0.68;
const AUTHORITY_REGULARIZATION = 0.12;
const TRIM_TARGET_RADIANS_PER_UNIT = (25 * Math.PI) / 180;

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

  /** Disarms retention. Pause/resume intentionally does not call this. */
  reset(): void {
    this.targetNoseVertical = null;
    this.pilotWasCommanding = false;
    this.lastRequestedTrim = null;
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
      this.targetNoseVertical = frame.noseVertical;
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
    out.pitch = clamp(
      noseError * ATTITUDE_GAIN * allocation - pitchRate * BODY_RATE_DAMPING,
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
