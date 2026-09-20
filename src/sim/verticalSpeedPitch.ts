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
/**
 * Seconds over which the speed floor bleeds away a learned nose-up trim, at
 * full shortfall.
 *
 * Measured: deleting it in one frame instead (`integral = min(integral, 0)`)
 * put the whole learned trim into the command as a single step — 11.9deg on the
 * trainer, 14.0deg on the jet — and then did it again every 18 s, because the
 * nose dropped, the speed came back, the trim rebuilt and the floor fired
 * again. A hands-off idle glide is exactly the case that sits on this boundary,
 * so it is the one the pilot would have felt.
 */
export const VERTICAL_FLOOR_TRIM_BLEED = 0.5;

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
   * Bleed the learned trim toward zero over `seconds`, without running the law.
   *
   * For handing control back — on touchdown — so the command WALKS to the raw
   * stick instead of stepping to it. Exponential with a time constant of a
   * quarter of `seconds`, so about 2% is left after `seconds`: below any
   * deadband, and smooth the whole way.
   */
  /**
   * Take on another instance's learned trim, for a hand-off between two holds
   * flying the same aeroplane.
   */
  adopt(source: VerticalSpeedPitchTrim): void {
    this.integral = source.integral;
  }

  decay(dt: number, seconds: number): void {
    const timeConstant = Math.max(seconds, 1e-4) / 4;
    this.integral *= Math.exp(-Math.max(dt, 0) / timeConstant);
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
    // arguing for height. Both must be CONTINUOUS in `recovery`, because
    // `recovery` passes through zero every time the aeroplane touches the
    // boundary, which at idle it does over and over.
    const recovery = clamp(speedShortfall / Math.max(floor * 0.25, 1e-3), 0, 1);
    // Bleed a nose-up trim away rather than deleting it: at recovery 0 this is
    // the identity, at recovery 1 it is most of the way gone in a second. A
    // nose-DOWN integral is left alone, which is what min() meant here.
    if (this.integral > 0) {
      this.integral *= Math.exp(-(recovery * dt) / VERTICAL_FLOOR_TRIM_BLEED);
    }
    // Blend toward the floor's own command instead of switching to it. At
    // recovery 0 this returns `pitch` exactly, so authority fades in from
    // nothing; at recovery 1 it is full nose-down, as before.
    return clamp(pitch + (-recovery - pitch) * recovery, -1, 1);
  }
}
