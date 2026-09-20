import { clamp } from "./math";

/**
 * Pitch command from a vertical-speed demand, with the trim learned rather than
 * assumed.
 *
 * **Extracted from `attract.ts`, where it was proved, because a second caller
 * arrived.** The menu flight uses it to hold a set altitude; Scenic uses it to
 * hold whatever altitude the pilot let go at. The arithmetic here is
 * byte-identical to the attract law it came out of — `scripts/attract-hold-probe.mts`
 * reports the same heights and the same zero re-seeds across it.
 *
 * **Why the integral is the point.** Measured level-flight attitude, sweeping
 * commanded pitch until vertical speed settles at zero:
 *
 * | throttle | trainer | jet | bizjet |
 * | --- | ---: | ---: | ---: |
 * | 0.60 | +1.25° | −2.25° | −0.50° |
 * | 0.75 | +0.25° | −2.50° | −0.75° |
 * | 0.90 | −0.50° | −2.50° | −1.00° |
 *
 * There is no single trim attitude — not across aeroplanes (the spread is 3.75°,
 * a quarter of Scenic's whole ±14° authority) and not even for one aeroplane,
 * since it moves with throttle. Anything that is TOLD a trim figure is tuned
 * against one aeroplane at one power setting, and will be wrong for the F-16 and
 * 747-8 that do not exist yet. This finds it.
 */

/** Proportional and integral gains on vertical-speed error, in pitch command. */
export const VERTICAL_PITCH_P = 0.06;
export const VERTICAL_PITCH_I = 0.02;
/**
 * Speed floor as a multiple of stall speed, below which height stops being the
 * objective. An altitude hold that will not give up altitude is a stall with
 * extra steps.
 */
export const VERTICAL_SPEED_FLOOR = 1.25;

export interface VerticalSpeedPitchInput {
  /** Vertical speed the caller wants, m/s. Positive is up. */
  readonly desiredVerticalSpeed: number;
  /** Vertical speed the aeroplane actually has, m/s. */
  readonly verticalSpeed: number;
  /** EQUIVALENT airspeed, m/s — the same quantity `stallSpeed()` returns. */
  readonly equivalentAirspeed: number;
  /** Level 1 g stall speed at this flap setting, EQUIVALENT airspeed, m/s. */
  readonly stallSpeed: number;
  /** Seconds since the last call. */
  readonly dt: number;
}

export class VerticalSpeedPitchTrim {
  private integral = 0;

  reset(): void {
    this.integral = 0;
  }

  /**
   * The trim the integrator has learned, as a pitch command in [-1, 1].
   *
   * This is what a caller adds a pilot's stick to, so that moving the stick off
   * centre and back produces no step: both sides of the deadband are the same
   * expression, `learnedTrim + stick`.
   */
  get learnedTrim(): number {
    return clamp(VERTICAL_PITCH_I * this.integral, -1, 1);
  }

  /**
   * One step. Returns the pitch command in [-1, 1].
   *
   * `integrate` false holds the learned trim still — used while a pilot is
   * commanding a climb, so the integrator does not wind up chasing a vertical
   * speed the pilot asked for and then argue with them on release.
   */
  update(input: VerticalSpeedPitchInput, integrate = true): number {
    const dt = Math.max(input.dt, 1e-4);
    const verticalError = input.desiredVerticalSpeed - input.verticalSpeed;
    const candidateIntegral = integrate
      ? this.integral + verticalError * dt
      : this.integral;
    const rawPitch = VERTICAL_PITCH_P * verticalError + VERTICAL_PITCH_I * candidateIntegral;
    const pitch = clamp(rawPitch, -1, 1);
    // Anti-windup: accept only the integration the command could actually use.
    if (pitch === rawPitch) this.integral = candidateIntegral;

    // The speed floor outranks the vertical-speed demand.
    const floor = input.stallSpeed * VERTICAL_SPEED_FLOOR;
    const speedShortfall = floor - input.equivalentAirspeed;
    if (speedShortfall <= 0) return pitch;
    // Lower the nose in proportion to the shortfall and stop the integrator
    // arguing for height.
    const recovery = clamp(speedShortfall / Math.max(floor * 0.25, 1e-3), 0, 1);
    this.integral = Math.min(this.integral, 0);
    return clamp(Math.min(pitch, -recovery), -1, 1);
  }
}
