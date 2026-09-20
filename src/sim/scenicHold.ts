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
 * **Nothing it does may STEP the commanded pitch.** Scenic is attitude-command,
 * so what this writes becomes commanded attitude directly, and every place the
 * hold changes its mind about who is flying is a place the attitude can jump.
 * There are five, and all five were measured before they were fixed — see
 * `docs/findings/SCENIC_HEIGHT_HOLD_2026_09_20.md` for the traces:
 *
 * 1. **Engaging** is a latch, not a per-frame condition, so ground rising under
 *    the aeroplane cannot hand it back mid-air (`SCENIC_HOLD_MIN_CLEARANCE`).
 * 2. **The speed floor** fades in rather than switching on, in
 *    `VerticalSpeedPitchTrim`.
 * 3. **Touchdown** ramps down what the hold last added, over a second — and
 *    the ramp survives a bounce.
 * 4. **Crossing the deadband** hands the demand over ACROSS it, not at it, and
 *    adds the pilot's stick on both sides.
 * 5. **The hand-off from the menu flight** adopts the trim it already learned
 *    (`adopt`).
 *
 * A runway start still rotates exactly as it did before this existed: nothing
 * has been engaged, so there is nothing to add and nothing to hand back, and
 * the stick is the command from frame one.
 */

/**
 * Stick displacement below which the pilot counts as hands-off.
 *
 * 0.025 matches `PILOT_COMMAND_THRESHOLD` in `pitchRetention.ts`, which is the
 * same judgement about the same hardware in the neighbouring assist.
 */
export const SCENIC_HOLD_DEADBAND = 0.025;
/**
 * Clearance at which the hold ENGAGES after leaving the ground — a latch, not a
 * condition.
 *
 * It was a condition first, tested every frame, and that was wrong in a way
 * worth recording. Measured with `2.5deg + pitch * 14deg` logged frame by frame:
 * an aeroplane hands-off at 40 m over 600 m-wavelength ridges crossed this line
 * 2–7 times a run, and every crossing stepped the commanded pitch — 2.5deg on
 * the trainer, 7.2deg on the jet — because dropping below it called `reset()`
 * and threw away a learned trim mid-air. The pilot had done nothing; the ground
 * underneath had simply risen.
 *
 * As a latch it engages ONCE, the first time the aeroplane is this far above
 * the ground, at which point the trim is still zero and engaging costs nothing.
 * It then stays engaged until the wheels are back down. The take-off roll, the
 * rotation and the first moments of the climb are still the pilot's, which is
 * all the threshold was ever for. 30 m is above the tallest gear and well below
 * any cruise.
 */
export const SCENIC_HOLD_MIN_CLEARANCE = 30;
/**
 * Seconds over which a learned trim is given back to the pilot on touchdown.
 *
 * Zeroing it at the instant the wheels touch would step the command by the
 * whole trim, at the one moment the aeroplane is least able to absorb it.
 */
export const SCENIC_HOLD_HANDBACK_SECONDS = 1;
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
  private engaged = false;
  private handbackRemaining = 0;
  /**
   * The last thing the hold ADDED to the pilot's stick while airborne, kept so
   * the hand-back can ramp it down from exactly where it was.
   */
  private contribution = 0;

  reset(): void {
    this.trim.reset();
    this.capturedAltitude = null;
    this.settledSeconds = 0;
    this.engaged = false;
    this.handbackRemaining = 0;
    this.contribution = 0;
  }

  /** Whether the latch has engaged. Diagnostics and tests only. */
  get isEngaged(): boolean {
    return this.engaged;
  }

  /**
   * Adopt a trim another hold has already learned, and engage.
   *
   * The menu flight and this one run the same law over the same aeroplane, so
   * at the hand-off from attract to the pilot the trim is already known. Taking
   * it makes the hand-off step-free; learning it again from zero would put the
   * whole trim into the command over the following seconds.
   */
  adopt(source: VerticalSpeedPitchTrim): void {
    this.trim.adopt(source);
    this.capturedAltitude = null;
    this.settledSeconds = 0;
    this.engaged = true;
  }

  /**
   * Gives the aeroplane back over `SCENIC_HOLD_HANDBACK_SECONDS`, by ramping
   * down what the hold last added rather than by dropping it.
   *
   * Shared by the wheels touching and by a bounce, because the ramp has to
   * survive the aeroplane leaving the ground again mid-way through it.
   */
  private handBack(stick: number, dt: number): number {
    if (this.handbackRemaining <= 0) {
      this.trim.reset();
      this.contribution = 0;
      return stick;
    }
    const authority = clamp(this.handbackRemaining / SCENIC_HOLD_HANDBACK_SECONDS, 0, 1);
    this.handbackRemaining -= dt;
    return clamp(this.contribution * authority + stick, -1, 1);
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

    // Wheels down: the stick is the command again, but it takes the command
    // back over a second instead of in a frame.
    //
    // Deleting the trim at touchdown was the obvious version and it stepped the
    // command by the whole trim — up to 14deg. Decaying only the trim was
    // better and still stepped it by 1.7–3.7deg, because the PROPORTIONAL term
    // went with it in the same frame. Keeping the law running and fading its
    // authority fixed the touchdown frame but left the law chasing the gear's
    // own bounce for a second, which the jets showed as 2deg steps on the roll.
    //
    // So what fades is the number the hold last ADDED, frozen at the value it
    // had in the air and ramped linearly to zero. The touchdown frame is then
    // continuous by construction — authority is 1, so the command is what it
    // was — and no frame after it can move by more than dt/1s of that value.
    //
    // A runway start has nothing to hand back — `handbackRemaining` is zero
    // until the hold has actually been engaged — so it is still exactly the
    // stick, from frame one.
    if (input.onGround) {
      if (this.engaged) {
        this.engaged = false;
        this.handbackRemaining = SCENIC_HOLD_HANDBACK_SECONDS;
      }
      this.capturedAltitude = null;
      this.settledSeconds = 0;
      return this.handBack(stick, input.dt);
    }

    // The latch. Engaging while the trim is still zero is what makes this
    // step-free; NOT disengaging when the ground rises under the aeroplane is
    // the whole point of it being a latch (see SCENIC_HOLD_MIN_CLEARANCE).
    if (!this.engaged) {
      // Airborne but not engaged. Either the aeroplane has never been 30 m
      // clear — in which case there is nothing to hand back and this is the
      // raw stick — or it has just BOUNCED off the runway, in which case the
      // ramp that started at the wheels carries on through the bounce. Ending
      // it early because the wheels left the ground would drop whatever was
      // left of it in a single frame, which is the thing this all exists to
      // avoid, and a firm landing does exactly that.
      if (!(input.clearance > SCENIC_HOLD_MIN_CLEARANCE)) {
        return this.handBack(stick, input.dt);
      }
      this.engaged = true;
      // Re-engaging inside the hand-back second — a go-around steep enough to
      // clear 30 m in under a second — resumes the law at full authority. The
      // trim is still intact (it is only cleared once the ramp finishes), so
      // the law's output is close to what the ramp was paying out, and the
      // difference is `contribution * (1 - authority)`: bounded, and smaller
      // the sooner it happens.
      this.handbackRemaining = 0;
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
      this.contribution = this.trim.learnedTrim;
      return clamp(this.contribution + stick, -1, 1);
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

    // Hand the demand over across the deadband rather than at it. Displaced,
    // the demand is the aeroplane's own vertical speed (error zero, so the
    // command is the learned trim and the pilot is flying). Centred, it is the
    // height correction. Switching between them AT the boundary steps the
    // command by P times the difference, which is the pilot's own stick
    // movement uncovering a jump they did not ask for: measured at 1.04deg on
    // the trainer, 1.34deg on the jet and 4.88deg on the bizjet, every one of
    // them at stick 0.025 exactly.
    const released = clamp(Math.abs(stick) / SCENIC_HOLD_DEADBAND, 0, 1);
    const demand = correction + (input.verticalSpeed - correction) * released;

    const command = this.trim.update({
      desiredVerticalSpeed: demand,
      verticalSpeed: input.verticalSpeed,
      equivalentAirspeed: input.equivalentAirspeed,
      stallSpeed: input.stallSpeed,
      dt: input.dt,
    });
    // The stick is added on THIS side of the deadband too, so both sides are
    // the one expression `contribution + stick`. Ignoring a centred stick here
    // and honouring it a thousandth of a unit later was worth 0.35deg on its
    // own. A stick inside the deadband is small by definition, and the
    // integrator absorbs it, so the height is still held.
    this.contribution = command;
    return clamp(command + stick, -1, 1);
  }
}
