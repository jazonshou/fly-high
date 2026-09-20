import { clamp } from "./math";
import {
  VERTICAL_PITCH_I,
  VERTICAL_PITCH_P,
  VERTICAL_SPEED_FLOOR,
  VerticalSpeedPitchTrim,
} from "./verticalSpeedPitch";

/**
 * The attract flight's supervisor: what flies the aeroplane on the menu screen.
 *
 * **Why it exists.** The menu runs a live flight with `attractMode` on, which
 * forces Scenic and holds neutral pilot controls. Scenic is an attitude-command
 * law and its neutral is NOT level — `applyFlightAssistance` commands
 * `2.5deg + requested.pitch * 14deg`, so a neutral stick asks for 2.5 degrees
 * nose-up, forever, with the power on. The demo was not drifting upward; it was
 * being told to climb and nothing ever told it to stop. Jason: *"if I stay on
 * the menu screen for a long time, the plane keeps defaulting to flying higher
 * and higher."*
 *
 * **What this is.** An OUTER loop that writes the pilot-side `pitch`, `throttle`
 * and `roll` that Scenic then flies. Scenic itself is untouched, so the inner
 * attitude loop, its damping and its stall recovery all behave exactly as they
 * do for a player. Everything here runs only under `attractMode`.
 *
 * **Why the integral is the whole design.** Measured level-flight attitude, by
 * sweeping commanded pitch until vertical speed settles at zero:
 *
 * | throttle | trainer | jet | bizjet |
 * | --- | --- | --- | --- |
 * | 0.60 | +1.25 deg | -2.25 deg | -0.50 deg |
 * | 0.75 | +0.25 deg | -2.50 deg | -0.75 deg |
 * | 0.90 | -0.50 deg | -2.50 deg | -1.00 deg |
 *
 * Three things follow. Scenic's 2.5 degrees is above level for EVERY aeroplane
 * at EVERY throttle — it was not chosen as level-ish for one type, it is
 * nose-up for all of them. The level attitude moves with throttle, so there is
 * no single trim figure even for one aeroplane. And the spread across kinds is
 * 3.75 degrees, a quarter of Scenic's entire authority. So this controller is
 * never TOLD a trim attitude: the integrator FINDS each airframe's own, which
 * is why it will still work for the F-16 and the 747-8 that do not exist yet.
 * Every aircraft-specific number arrives as an argument from the catalogue;
 * this module holds none.
 *
 * **Why it turns away rather than only climbing.** Measured on the trainer from
 * the attract spawn: full nose-up and full throttle settles at ~5 m/s of climb
 * over ~35 m/s of groundspeed — a 14% gradient — and bleeds IAS from 46 to 34,
 * into Scenic's own stall-recovery branch. A realistic command is ~5%. Clearing
 * a ridge H metres higher therefore needs 7H-20H metres of ground track, and
 * there is ~10 s of lag before the climb is even established. Against ranges
 * that now reach 1,900 m, looking ahead and climbing is not a margin, it is a
 * shortfall. So the demo climbs over what it can and turns away from what it
 * cannot, and the old "below 65 m, re-seed" became a last resort instead of the
 * routine outcome.
 */

/** Speeds are EQUIVALENT/INDICATED airspeed throughout — never true or ground. */
export interface AttractHoldInput {
  /**
   * Clearance above the surface below, metres. This is `telemetry.altitudeAgl`,
   * which since the water-surface change measures to the WATER over the sea, so
   * the demo holds its height above the sea rather than above the sea bed.
   */
  readonly clearance: number;
  /** Target clearance: the player's own `airborneStartAgl` setting, metres. */
  readonly targetClearance: number;
  /**
   * The steepest climb the terrain ahead demands, m/s, and the same for a track
   * turned left and right. See `attractClimbRateFor` for why this is a RATE and
   * not a height: reducing a scan to its highest point throws away WHERE that
   * point is, and a ridge 500 m ahead and one 4 km ahead ask for completely
   * different things. Negative means the ground ahead falls away.
   */
  readonly requiredClimbRate: number;
  readonly requiredClimbRateLeft: number;
  readonly requiredClimbRateRight: number;
  readonly verticalSpeed: number;
  readonly groundSpeed: number;
  /** Equivalent airspeed, m/s. Matches `stallSpeed()` and survives the TAS/EAS split. */
  readonly equivalentAirspeed: number;
  /** Cruise target for this aircraft kind, EAS, from the catalogue. */
  readonly targetAirspeed: number;
  /** Level 1 g stall speed for this aircraft at this flap setting, EAS. */
  readonly stallSpeed: number;
  readonly dt: number;
}

export interface AttractHoldOutput {
  pitch: number;
  roll: number;
  throttle: number;
}

/**
 * Vertical speed the hold will ask for, at most, in either direction.
 *
 * 3 m/s against the trainer's ~47 m/s of groundspeed is a 6.4% gradient, close
 * to the ~5% a realistic Scenic command actually sustains, so the aeroplane can
 * deliver it without bleeding speed. It is also slow enough to read as cruising
 * rather than as an autopilot correcting. Anything steeper is the turn's job.
 */
export const ATTRACT_MAX_VERTICAL_SPEED = 3;
/**
 * The climb the hold will ask for when TERRAIN demands it, as opposed to
 * ordinary altitude keeping. 5 m/s is what the trainer actually sustains at the
 * stop; asking for more would only saturate the pitch command and bleed speed.
 */
export const ATTRACT_MAX_TERRAIN_CLIMB = 5;
/**
 * Clearance the turn exists to protect, metres.
 *
 * **The turn is about not hitting anything, NOT about holding the target.** The
 * first version tested the shortfall against `targetClearance`, so the demo
 * turned whenever it could not keep the full 450 m over a rise -- which in
 * ordinary hill country is almost always. Measured over three half-hour runs it
 * spent 98%, 62% and 56% of the time in a turn: it had stopped cruising and
 * started circling. Passing a ridge with 300 m of air instead of 450 is not
 * worth turning for; passing it with 20 m is. 150 m sits comfortably above the
 * 65 m re-seed floor and low enough that only real terrain triggers it.
 */
export const ATTRACT_TURN_SAFE_CLEARANCE = 150;
/**
 * Minimum clearance expressed as SECONDS of flight rather than metres.
 *
 * 6 s is 282 m at the trainer's 47 m/s -- under the 450 m default, so it never
 * binds and the trainer holds exactly what the player set. It is 930 m for the
 * jet and 1,260 m for the Global, which is the point: at 210 m/s a 450 m floor
 * gives about two seconds between noticing a ridge and being on it.
 */
export const ATTRACT_MIN_CLEARANCE_SECONDS = 6;
/** Clearance error to vertical-speed demand. 100 m of error asks for 3 m/s. */
export const ATTRACT_CLIMB_GAIN = 0.03;
/**
 * The PI gains and the speed floor moved to `verticalSpeedPitch.ts` when Scenic
 * grew a hold of its own. Re-exported under their old names because the numbers
 * were measured here and the docs cite them from here; there is one definition.
 */
export const ATTRACT_PITCH_P = VERTICAL_PITCH_P;
export const ATTRACT_PITCH_I = VERTICAL_PITCH_I;
/**
 * Speed floor as a multiple of stall speed. Below this the hold stops being an
 * altitude hold: it lowers the nose and adds power whatever the altitude error
 * says, so it can never trade airspeed for height into a stall. Scenic's own
 * recovery starts at 11.5 degrees of incidence; this keeps the demo well clear
 * of ever reaching it.
 */
export const ATTRACT_SPEED_FLOOR = VERTICAL_SPEED_FLOOR;
/** Throttle gains, and the rate limit that keeps the engine from being heard hunting. */
export const ATTRACT_THROTTLE_P = 0.01;
export const ATTRACT_THROTTLE_I = 0.004;
export const ATTRACT_THROTTLE_RATE_PER_SECOND = 0.06;
/**
 * The turn is commanded as a RATE, not as a bank angle, and the difference is
 * the whole difference between a turn that works and one that does not.
 *
 * A bank angle is a constant measured against one aeroplane -- the same trap as
 * Scenic's 2.5 degrees. Measured: an 18 degree bank turns the trainer at
 * 3.9 deg/s, so 90 degrees takes 23 s and 1.1 km; it turns the Global 8000 at
 * 0.87 deg/s, so 90 degrees takes 103 s and TWENTY-ONE KILOMETRES. A bizjet
 * banked 18 degrees is not avoiding a mountain, it is flying into it slightly
 * sideways. A standard-rate turn is the same three degrees a second for every
 * aeroplane, and the bank that delivers it falls out of the speed:
 * `tan(bank) = omega * V / g` -- 14 degrees for the trainer, 40 for the jet,
 * 48 for the Global.
 */
export const ATTRACT_TURN_RATE_RADIANS_PER_SECOND = (3 * Math.PI) / 180;
/** Scenic's own mapping: roll 1.0 asks for 42 degrees, scaled by speed authority. */
const SCENIC_ROLL_TO_BANK_RADIANS = (42 * Math.PI) / 180;

/**
 * The roll command that gives a standard-rate turn at this speed, inverting
 * Scenic's own roll-to-bank mapping so the outer loop asks in the units the
 * inner loop actually flies.
 */
/**
 * SATURATES above 168.6 m/s, and that is a real limit rather than a
 * rounding one. Scenic's roll command tops out at 42 degrees of bank, which
 * delivers a standard rate up to 168.6 m/s; the Global 8000 at 210 m/s would
 * need 48 degrees, so it turns at 2.4 deg/s instead of 3 -- ninety degrees in
 * 37 s and 7.8 km rather than 30 s and 6.3 km. Still four times better than the
 * fixed 18 degree bank this replaced, which needed 21.7 km, and the remaining
 * shortfall is Scenic's authority, not this function's arithmetic.
 */
export function attractTurnRoll(trueAirspeed: number, equivalentAirspeed: number): number {
  const bank = Math.atan(
    (ATTRACT_TURN_RATE_RADIANS_PER_SECOND * Math.max(trueAirspeed, 1)) / 9.80665,
  );
  // Scenic scales its bank target by this authority; divide it back out so the
  // commanded rate is delivered rather than quietly reduced at low speed.
  const authority = clamp((equivalentAirspeed - 18) / 12, 0.35, 1);
  return clamp(bank / (SCENIC_ROLL_TO_BANK_RADIANS * authority), 0, 1);
}
/**
 * Safety factor on the climb the aeroplane is assumed to be able to deliver
 * before it decides to turn instead. Below 1 because the measured gradient was
 * taken at the stop, in still air, with the speed bleeding.
 */
export const ATTRACT_CLIMB_CONFIDENCE = 0.6;
/** Seconds of response lag between deciding to climb and climbing. */
export const ATTRACT_CLIMB_LAG_SECONDS = 10;
/**
 * Hysteresis on the turn, in m/s of demanded climb. Once committed, the demo
 * keeps turning until the track ahead asks this much less than it can give, so
 * it cannot dither between left and right along a ridge line.
 */
export const ATTRACT_TURN_RELEASE_RATE = 1.5;
/** Below this groundspeed the look-ahead means nothing and the turn is disabled. */
export const ATTRACT_MIN_PREDICTION_SPEED = 8;

/**
 * The terrain scan, as constants rather than as wiring, because TWO callers
 * run it -- the worker and `scripts/attract-hold-probe.mts` -- and a probe that
 * scanned differently from the shipped path would be measuring a lookalike.
 *
 * **The horizon has to be as long as the climb is slow.** The first version
 * looked 30 seconds ahead, which at the trainer's 47 m/s is 1.4 km. Climbing H
 * metres takes roughly 9H metres of track at the rate this controller asks for,
 * so 1.4 km buys about 150 m of height -- while the terrain it was meeting rose
 * three times that. Measured, the demo neither climbed over those ridges nor
 * turned away from them: it flew into the gap between the two and bottomed out
 * at 65 m of clearance with three re-seeds in half an hour. Ninety seconds of
 * look-ahead is 4.2 km at that speed, which buys ~240 m and matches the two
 * numbers to each other.
 */
export const ATTRACT_SCAN_SECONDS = 90;
export const ATTRACT_SCAN_MIN_METERS = 1_500;
/**
 * The cap has to be in SECONDS of flight, not metres, and 6 km was the mistake.
 * At the trainer's 47 m/s, 6 km is two minutes of warning; at the jet's 155 m/s
 * it is thirty-nine seconds, of which the ten-second climb lag eats a quarter.
 * Measured with a 6 km cap: the jet re-seeded ten times in half an hour and
 * turned away 0% of the time -- it was not refusing to avoid terrain, it could
 * not SEE it in time to decide. 20 km keeps ninety seconds of warning at every
 * speed up to 220 m/s, which is every aeroplane in the catalogue.
 */
export const ATTRACT_SCAN_MAX_METERS = 20_000;
/** Samples are spaced, not counted: a longer horizon needs proportionally more. */
export const ATTRACT_SCAN_SPACING_METERS = 350;
export const ATTRACT_SCAN_MIN_SAMPLES = 8;
export const ATTRACT_SCAN_MAX_SAMPLES = 28;

/**
 * How many samples to take over this distance. 350 m of spacing samples the
 * 2,550 m main ridge band seven times and the 1,050 m local band three, which
 * is the shortest feature this can honestly claim to see.
 */
export function attractScanSamples(distance: number): number {
  return Math.min(
    Math.max(Math.round(distance / ATTRACT_SCAN_SPACING_METERS), ATTRACT_SCAN_MIN_SAMPLES),
    ATTRACT_SCAN_MAX_SAMPLES,
  );
}
/** Re-scan after this much travel rather than every fixed step. */
export const ATTRACT_SCAN_TRAVEL_METERS = 45;
/** Half-angle of the left/right probes the turn chooses between, radians. */
export const ATTRACT_SCAN_TURN_RADIANS = 0.6;
/**
 * Where the nearest sample sits, metres ahead.
 *
 * **This existing to be small is the whole point, and getting it wrong cost a
 * bottomed-out demo three times an hour.** The first version spread its samples
 * from 15% of the horizon outward, on the reasoning that the point under the
 * aeroplane is already known from telemetry. At a 4.6 km horizon that put the
 * nearest sample 690 m ahead and left a hole in between -- and a hole in a
 * terrain scan is not a gap in resolution, it is a blind spot. Traced: the
 * aeroplane climbed at its maximum for eighty seconds while the ground beneath
 * it rose from 482 m to 542 m, and the scan calmly reported 281 m ahead, so
 * nothing ever asked for a steeper climb or a turn. It flew into a hill it was
 * looking straight over the top of, three times, at exactly 480-second
 * intervals. Near samples are the cheap ones and the ones that matter.
 */
export const ATTRACT_SCAN_NEAR_METERS = 60;

/**
 * The ground-projected direction the aeroplane is going, from its heading.
 *
 * **`telemetry.heading` is RADIANS.** It is `atan2(forward.x, forward.z)`
 * straight out of the simulator; the worker's `visualState` converts it to
 * degrees for the HUD, and that conversion is the only one there should be.
 * Treating the telemetry value as degrees points this 57 times too close to
 * north: a demo tracking 45 degrees scanned along 0.9, terrain entered the scan
 * only once it was a few hundred metres away, and the required-climb figure
 * jumped from -4 m/s to +122 m/s in six seconds with nothing left to do about
 * it. That single line was the cause of every terrain symptom this controller
 * appeared to have. It is a function so there is ONE place to get it wrong, and
 * `sim.attract-hold.test.ts` checks it against a flying aeroplane's real ground
 * track in all four quadrants.
 *
 * NORMALISED, unlike the chase camera's own look-ahead, which uses the raw
 * forward vector and so shortens its horizon by cos(pitch) exactly when the
 * aeroplane is climbing and needs it most.
 */
export function attractTrackVector(headingRadians: number): readonly [number, number] {
  return [Math.sin(headingRadians), Math.cos(headingRadians)];
}

/**
 * Distance of the i-th sample (1-based) along a track of this length.
 *
 * **Spaced QUADRATICALLY, dense near the aeroplane.** Even spacing puts every
 * sample 350 m apart over a 5 km horizon, and a terrain of ridges simply steps
 * between them: traced on the default seed, the scan reported a peak of 277 m
 * ahead while the ground DIRECTLY BENEATH the aeroplane was already at 316 m.
 * It was not looking too far or too close, it was looking through the hills.
 *
 * The two ends of the scan are doing different jobs, which is why one spacing
 * cannot serve both. The near field decides whether this ridge is cleared, and
 * an error there is metres from the ground; the far field only has to notice a
 * mountain early enough to start a turn, where a few hundred metres of
 * resolution is plenty. Quadratic spacing gives the near field ~25 m and the
 * far field ~600 m out of the same sample budget.
 */
export function attractScanOffset(index: number, samples: number, distance: number): number {
  if (samples <= 1) return distance;
  const span = Math.max(distance - ATTRACT_SCAN_NEAR_METERS, 0);
  const t = (index - 1) / (samples - 1);
  return ATTRACT_SCAN_NEAR_METERS + span * t * t;
}

/**
 * How far ahead to scan at this groundspeed, metres. Shared so the worker and
 * the probe cannot disagree about it.
 */
export function attractScanDistance(groundSpeed: number): number {
  return Math.min(
    Math.max(Math.max(groundSpeed, 0) * ATTRACT_SCAN_SECONDS, ATTRACT_SCAN_MIN_METERS),
    ATTRACT_SCAN_MAX_METERS,
  );
}

/** Today's re-seed test, moved out of the worker so a harness can share it. */
export const ATTRACT_RESEED_CLEARANCE_METERS = 65;

/**
 * Whether the attract flight should be thrown away and re-seeded.
 *
 * Unchanged in meaning from the inline test it replaces. It is a DECISION, not
 * an action: the caller owns the re-spawn, because that needs the world and the
 * aircraft kind and cannot be pure.
 */
export function shouldReseedAttract(crashed: boolean, clearance: number): boolean {
  return crashed || clearance < ATTRACT_RESEED_CLEARANCE_METERS;
}

/**
 * The climb rate the terrain at one scan point demands, m/s.
 *
 * **Why a rate and not a height, which is the bug this replaced.** The first
 * version reduced the scan to its highest point and compared that against the
 * height the aeroplane could gain over the WHOLE horizon. Traced on the default
 * seed: a ridge 500 m ahead was judged against a 4.4 km climb budget, the
 * arithmetic said "you will clear it by 328 m", and the aeroplane flew into it
 * with 65 m to spare, three times, at exactly 480-second intervals. A max over
 * heights forgets the distance that made each height reachable or not.
 *
 * The lag is subtracted from the time available, not added as a fudge: for the
 * first `ATTRACT_CLIMB_LAG_SECONDS` the aeroplane is still establishing the
 * climb and gains nothing, so that part of the approach is simply not there.
 */
export function attractClimbRateFor(
  surfaceHeight: number,
  distanceAhead: number,
  currentAltitude: number,
  groundSpeed: number,
): number {
  const seconds = Math.max(
    distanceAhead / Math.max(groundSpeed, 1) - ATTRACT_CLIMB_LAG_SECONDS,
    1,
  );
  return (surfaceHeight + ATTRACT_TURN_SAFE_CLEARANCE - currentAltitude) / seconds;
}

/** The climb this controller is willing to believe an aeroplane will deliver. */
export function attractAchievableClimbRate(): number {
  return ATTRACT_MAX_TERRAIN_CLIMB * ATTRACT_CLIMB_CONFIDENCE;
}

/**
 * The supervisor. One instance per attract flight; `reset` on every re-seed so
 * a fresh aeroplane does not inherit the last one's trim.
 */
export class AttractHold {
  private readonly trim = new VerticalSpeedPitchTrim();
  private throttleIntegral = 0;
  private throttleCommand: number;
  private turningRight: boolean | null = null;
  private readonly initialThrottle: number;

  constructor(initialThrottle = 0.6) {
    this.initialThrottle = clamp(initialThrottle, 0, 1);
    this.throttleCommand = this.initialThrottle;
  }

  /**
   * The trim this flight has learned, for handing to the pilot's own hold.
   *
   * The menu flight and Scenic run the same law over the same aeroplane, so at
   * `takeControl` the answer is already known; see `ScenicAltitudeHold.adopt`.
   */
  get verticalTrim(): VerticalSpeedPitchTrim {
    return this.trim;
  }

  reset(initialThrottle = this.initialThrottle): void {
    this.trim.reset();
    this.throttleIntegral = 0;
    this.throttleCommand = clamp(initialThrottle, 0, 1);
    this.turningRight = null;
  }

  /** True while the demo is turning away from ground it cannot out-climb. */
  get isTurning(): boolean {
    return this.turningRight !== null;
  }

  update(input: AttractHoldInput, out: AttractHoldOutput): AttractHoldOutput {
    const dt = Math.max(input.dt, 1e-4);

    // --- Turn decision, first, because it changes what the climb is for ------
    const canPredict = input.groundSpeed >= ATTRACT_MIN_PREDICTION_SPEED;
    const achievable = attractAchievableClimbRate();
    if (!canPredict) {
      this.turningRight = null;
    } else if (this.turningRight === null) {
      if (input.requiredClimbRate > achievable) {
        // Commit toward whichever side asks less of the aeroplane. A consistent
        // choice plus the release margin below is what stops it dithering along
        // a ridge line.
        this.turningRight = input.requiredClimbRateRight < input.requiredClimbRateLeft;
      }
    } else if (input.requiredClimbRate < achievable - ATTRACT_TURN_RELEASE_RATE) {
      this.turningRight = null;
    }
    const turnRoll = attractTurnRoll(input.groundSpeed, input.equivalentAirspeed);
    out.roll = this.turningRight === null
      ? 0
      : (this.turningRight ? turnRoll : -turnRoll);

    // --- Altitude hold -------------------------------------------------------
    // A HEIGHT that is generous for a Cessna is marginal for a Global 8000,
    // because what height buys you is TIME, and a bizjet spends it four times
    // faster. The floor is that time: below it there is not enough room to see
    // terrain, decide, and act. It never lowers the player's setting, and at
    // the trainer's speed it does not bind at all.
    const effectiveTarget = Math.max(
      input.targetClearance,
      input.groundSpeed * ATTRACT_MIN_CLEARANCE_SECONDS,
    );
    const clearanceError = effectiveTarget - input.clearance;
    const holdDemand = clearanceError * ATTRACT_CLIMB_GAIN;
    // Terrain buys a steeper climb than ordinary altitude keeping does: level
    // cruise should look calm, but a ridge is worth climbing properly for. The
    // terrain demand is taken as it comes and capped at what the aeroplane can
    // give; whatever is left over is the turn's problem, not the elevator's.
    const terrainDemand = Math.min(input.requiredClimbRate, ATTRACT_MAX_TERRAIN_CLIMB);
    const climbCeiling = terrainDemand > ATTRACT_MAX_VERTICAL_SPEED
      ? ATTRACT_MAX_TERRAIN_CLIMB
      : ATTRACT_MAX_VERTICAL_SPEED;
    const desiredVerticalSpeed = clamp(
      Math.max(holdDemand, terrainDemand),
      -ATTRACT_MAX_VERTICAL_SPEED,
      climbCeiling,
    );
    // The PI, its anti-windup and the speed floor now live in
    // `VerticalSpeedPitchTrim`, shared with Scenic's own hold. The arithmetic
    // is the same one this law was measured with -- the probe reports
    // identical heights and the same zero re-seeds across the extraction.
    out.pitch = this.trim.update({
      desiredVerticalSpeed,
      verticalSpeed: input.verticalSpeed,
      equivalentAirspeed: input.equivalentAirspeed,
      stallSpeed: input.stallSpeed,
      dt,
    });

    // --- Throttle: slow, and rate-limited so it cannot be heard hunting ------
    // The same shortfall the trim above acts on, recomputed here rather than
    // reached into: the trim owns the elevator's response to it, the throttle
    // owns its own.
    const speedShortfall = input.stallSpeed * ATTRACT_SPEED_FLOOR - input.equivalentAirspeed;
    const speedError = input.targetAirspeed - input.equivalentAirspeed;
    const candidateThrottleIntegral = this.throttleIntegral + speedError * dt;
    const rawThrottle = this.initialThrottle
      + ATTRACT_THROTTLE_P * speedError
      + ATTRACT_THROTTLE_I * candidateThrottleIntegral;
    const targetThrottle = clamp(speedShortfall > 0 ? 1 : rawThrottle, 0, 1);
    if (targetThrottle === rawThrottle) this.throttleIntegral = candidateThrottleIntegral;
    const step = ATTRACT_THROTTLE_RATE_PER_SECOND * dt;
    this.throttleCommand += clamp(targetThrottle - this.throttleCommand, -step, step);
    this.throttleCommand = clamp(this.throttleCommand, 0, 1);
    out.throttle = this.throttleCommand;

    return out;
  }
}
