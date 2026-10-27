/**
 * B2: the observed ground speed the chase trail is made of
 * (`cameraTrailMeters`), measured against simulation time.
 *
 * The distance the aircraft moved between two frames comes from two
 * interpolated simulation poses, so it covers the simulation time between
 * them. The renderer divided it by the frame's WALL delta, which it clamps to
 * 0.1 s, so after any frame over 100 ms the speed overshot (a 300 ms stall
 * read 3x, and the trail pulled the camera back as far as its cap,
 * `aimAhead` less 4 m, allows), and a late simulation snapshot, which freezes
 * the pose's clock and then catches it up, read as a stop and then a burst:
 * every hitch was shown twice. Dividing by the simulation delta instead
 * removes both.
 *
 * A steady frame, whose two deltas agree to half a millisecond, keeps the old
 * division bit for bit, so the perf harness, which advances simulation time
 * by exactly the delta it renders with, frames every shot as before. So does
 * a frame whose simulation delta is shorter than any frame FlightGame hands
 * the renderer (`CAMERA_GROUND_SPEED_MIN_SIM_DELTA_SECONDS`).
 */

/** Wall and simulation deltas this close make a steady frame: the old division. */
export const CAMERA_GROUND_SPEED_STEADY_TOLERANCE_SECONDS = 0.0005;

/**
 * The shortest simulation delta the distance is divided by: FlightGame's
 * shortest frame delta, so the speed never reads higher than the old division
 * could for the same distance. Below it the old division stands. A pose
 * correction (a new snapshot replacing an extrapolated pose) can move the
 * aircraft in a frame whose simulation clock barely moved, and the distance
 * over that sliver read thousands of metres a second. And a display above
 * 240 Hz, whose frame delta FlightGame raises to 1/240 s while the
 * simulation clock moves by the real interval, keeps every steady frame as
 * it was.
 */
export const CAMERA_GROUND_SPEED_MIN_SIM_DELTA_SECONDS = 1 / 240;

/**
 * Frames a frozen simulation clock holds the last speed for before the wall
 * division takes over again. Three is 25 ms at 120 Hz, long enough to ride
 * out a late snapshot and short enough that a pause still settles at once.
 */
export const CAMERA_GROUND_SPEED_HELD_FRAMES = 3;

export interface CameraGroundSpeedInput {
  /** Metres the aircraft moved since the previous frame. */
  readonly travelled: number;
  /** The renderer's clamped frame delta. */
  readonly wallDeltaSeconds: number;
  /** The pose's simulation time less the previous frame's. */
  readonly simDeltaSeconds: number;
  /** The previous frame's observed ground speed. */
  readonly previous: number;
  /** Consecutive frames a frozen simulation clock has held it. */
  readonly heldFrames: number;
  /**
   * Whether a frozen clock holds the speed at all. Interactive play only: a
   * pinned (perf capture) renderer re-renders a shot's last state with no
   * simulation time passing, and must frame it exactly as before.
   */
  readonly holdWhenFrozen: boolean;
}

export interface CameraGroundSpeed {
  readonly speed: number;
  readonly heldFrames: number;
}

/** The next frame's observed ground speed, in m/s, and its hold count. */
export function nextObservedGroundSpeed(input: CameraGroundSpeedInput): CameraGroundSpeed {
  const { travelled, wallDeltaSeconds, simDeltaSeconds } = input;
  if (
    simDeltaSeconds >= CAMERA_GROUND_SPEED_MIN_SIM_DELTA_SECONDS
    && Math.abs(simDeltaSeconds - wallDeltaSeconds) > CAMERA_GROUND_SPEED_STEADY_TOLERANCE_SECONDS
  ) {
    return { speed: travelled / simDeltaSeconds, heldFrames: 0 };
  }
  if (simDeltaSeconds <= 0 && input.holdWhenFrozen) {
    if (input.heldFrames < CAMERA_GROUND_SPEED_HELD_FRAMES) {
      return { speed: input.previous, heldFrames: input.heldFrames + 1 };
    }
    // Held long enough: a pause, not a late snapshot. The count stays spent
    // until the clock moves again.
    return { speed: travelled / Math.max(1e-4, wallDeltaSeconds), heldFrames: input.heldFrames };
  }
  return { speed: travelled / Math.max(1e-4, wallDeltaSeconds), heldFrames: 0 };
}
