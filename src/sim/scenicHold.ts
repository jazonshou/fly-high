import { clamp } from "./math";
import { VerticalSpeedPitchTrim } from "./verticalSpeedPitch";

/**
 * Scenic's centred stick holds HEIGHT.
 *
 * Jason, asked whether he wanted this: *"Yes, hold height"*.
 *
 * **What it replaces.** Scenic is an attitude-command law and its neutral was
 * not level: `applyFlightAssistance` commands `2.5deg + stick * 14deg`, so
 * letting go of the stick asked for two and a half degrees nose-up, forever.
 * That is why the menu flight climbed to its service ceiling, and a player who
 * let go climbed for exactly the same reason — slowly enough to read as drift
 * rather than as a command, which is what made it survive this long.
 *
 * **What it does.** It writes the PILOT-SIDE pitch that Scenic then flies, so
 * Scenic itself is untouched: the bank law, the coordinated yaw, the damping
 * and the stall recovery all behave exactly as they did. The command is always
 *
 *     requested.pitch = learnedTrim + stick
 *
 * on BOTH sides of the deadband, which is what makes moving the stick off
 * centre and back produce no step in commanded pitch. `learnedTrim` is the
 * integrator's own state (see `VerticalSpeedPitchTrim`): the attitude that
 * happens to hold this aeroplane level at this speed and power, found rather
 * than assumed, because there is no single such attitude across aeroplanes or
 * even across throttle settings.
 *
 * **It levels off where the aeroplane ends up.** Height is captured only once
 * the vertical speed has actually settled, never at the instant of release, so
 * a pilot who climbs and lets go stays at the top of the climb instead of being
 * flown back down to where they started. The captured height is then held
 * WEAKLY — enough that it does not drift over minutes, gently enough that it is
 * not felt as an autopilot.
 *
 * **Airspeed outranks height**, as in the attract law: below a margin over the
 * stall the hold lets the nose down and accepts a descent, so hands-off at idle
 * ends in a stable glide rather than a mush.
 *
 * **On the ground and through rotation it does nothing at all** — the stick
 * passes through untouched and the integrator is held at zero, so a runway
 * start rotates exactly as it did before this existed.
 */

/**
 * Stick displacement below which the pilot counts as hands-off.
 *
 * 0.025 matches `PILOT_COMMAND_THRESHOLD` in `pitchRetention.ts`, which is the
 * same judgement about the same hardware in the neighbouring assist.
 */
export const SCENIC_HOLD_DEADBAND = 0.025;
/**
 * Below this clearance the hold stays out of the way entirely: the take-off
 * roll, the rotation and the first moments of the climb are the pilot's, and
 * an altitude hold has no business in them. 30 m is above the tallest gear and
 * well below any cruise.
 */
export const SCENIC_HOLD_MIN_CLEARANCE = 30;
/**
 * Vertical speed below which the aeroplane counts as settled, so the height it
 * is at becomes the height to keep. Capturing at the instant of release instead
 * would fly the aeroplane back down to where the climb started, which is not
 * what letting go means.
 */
export const SCENIC_HOLD_CAPTURE_VERTICAL_SPEED = 0.6;
/** Seconds the vertical speed must stay settled before the height is captured. */
export const SCENIC_HOLD_CAPTURE_SECONDS = 1.5;
/**
 * How hard a captured height is held, in m/s of demanded vertical speed per
 * metre of error, and the ceiling on that demand.
 *
 * Deliberately weak. Its whole job is to stop a slow drift over minutes; if it
 * is strong enough to be felt as a correction it has overstepped, because the
 * pilot did not ask for an autopilot, they let go of the stick.
 */
export const SCENIC_HOLD_ALTITUDE_GAIN = 0.02;
export const SCENIC_HOLD_MAX_CORRECTION = 1.2;

export interface ScenicHoldInput {
  /** Pilot pitch command, [-1, 1], as it arrives from the input layer. */
  readonly pitchStick: number;
  /** True while any wheel is on the ground. */
  readonly onGround: boolean;
  /** Clearance below the aeroplane, metres (`telemetry.altitudeAgl`). */
  readonly clearance: number;
  /** Height above mean sea level, metres — what a captured height is measured in. */
  readonly altitude: number;
  readonly verticalSpeed: number;
  /** EQUIVALENT airspeed, m/s. */
  readonly equivalentAirspeed: number;
  /** Level 1 g stall speed at this flap setting, EQUIVALENT airspeed, m/s. */
  readonly stallSpeed: number;
  readonly dt: number;
}

export class ScenicAltitudeHold {
  private readonly trim = new VerticalSpeedPitchTrim();
  private capturedAltitude: number | null = null;
  private settledSeconds = 0;

  reset(): void {
    this.trim.reset();
    this.capturedAltitude = null;
    this.settledSeconds = 0;
  }

  /** The height being held, or null when nothing is captured. Diagnostics only. */
  get holdingAltitude(): number | null {
    return this.capturedAltitude;
  }

  /**
   * Returns the pitch to hand Scenic in place of the pilot's raw stick.
   *
   * Everything else about the pilot's controls is untouched; this replaces one
   * axis and only in Scenic.
   */
  update(input: ScenicHoldInput): number {
    const stick = clamp(input.pitchStick, -1, 1);

    // On the ground, through rotation, and below the engagement height: the
    // stick is the command and the hold holds nothing. Resetting here is what
    // guarantees a runway start is bit-identical to the old behaviour.
    if (input.onGround || !(input.clearance > SCENIC_HOLD_MIN_CLEARANCE)) {
      this.reset();
      return stick;
    }

    const handsOff = Math.abs(stick) < SCENIC_HOLD_DEADBAND;
    if (!handsOff) {
      // The pilot is flying. Do not integrate their commanded climb away, and
      // do not keep a height they have left behind.
      this.capturedAltitude = null;
      this.settledSeconds = 0;
      // Still stepped, with integration off, so the speed floor keeps working
      // and the learned trim stays available.
      this.trim.update(
        {
          desiredVerticalSpeed: input.verticalSpeed,
          verticalSpeed: input.verticalSpeed,
          equivalentAirspeed: input.equivalentAirspeed,
          stallSpeed: input.stallSpeed,
          dt: input.dt,
        },
        false,
      );
      return clamp(this.trim.learnedTrim + stick, -1, 1);
    }

    // Hands off. Settle first, capture second, hold third.
    if (Math.abs(input.verticalSpeed) < SCENIC_HOLD_CAPTURE_VERTICAL_SPEED) {
      this.settledSeconds += input.dt;
    } else {
      this.settledSeconds = 0;
      this.capturedAltitude = null;
    }
    if (this.capturedAltitude === null && this.settledSeconds >= SCENIC_HOLD_CAPTURE_SECONDS) {
      this.capturedAltitude = input.altitude;
    }

    const correction = this.capturedAltitude === null
      ? 0
      : clamp(
        (this.capturedAltitude - input.altitude) * SCENIC_HOLD_ALTITUDE_GAIN,
        -SCENIC_HOLD_MAX_CORRECTION,
        SCENIC_HOLD_MAX_CORRECTION,
      );

    return this.trim.update({
      desiredVerticalSpeed: correction,
      verticalSpeed: input.verticalSpeed,
      equivalentAirspeed: input.equivalentAirspeed,
      stallSpeed: input.stallSpeed,
      dt: input.dt,
    });
  }
}
