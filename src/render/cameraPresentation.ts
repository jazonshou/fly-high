import type { CockpitEyeSpec } from "@/src/aircraft/catalogue";
import type { CameraMode } from "@/src/game/types";

export interface MutablePresentationVector {
  x: number;
  y: number;
  z: number;
}

/**
 * Exterior cameras follow only enough bank to communicate the turn. Cockpit
 * view remains physically attached to the aircraft; reduced motion keeps an
 * exterior horizon level.
 */
export function cameraBankFollow(cameraMode: CameraMode, reducedMotion: boolean): number {
  if (cameraMode === "cockpit") return 1;
  if (cameraMode === "freefly") return 0;
  if (reducedMotion) return 0;
  return cameraMode === "cinematic" ? 0.3 : 0.18;
}

/** Cockpit view deliberately preserves aircraft roll; exterior stabilized views do not. */
export function shouldStabilizeCameraHorizon(
  cameraMode: CameraMode,
  stabilizedCamera: boolean,
): boolean {
  return stabilizedCamera && cameraMode !== "cockpit";
}

/** One response governs exterior position, aim, up and FOV as a single camera rig. */
export function cameraPresentationResponse(
  cameraMode: CameraMode,
  cameraCut: boolean,
  deltaSeconds: number,
  reducedMotion: boolean,
): number {
  // Free-fly is a direct rig like cockpit: mouse-look must not lag.
  if (cameraCut || cameraMode === "cockpit" || cameraMode === "freefly") return 1;
  const delta = Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
  return 1 - Math.exp(-delta * (reducedMotion ? 12 : 7));
}

/** Allocation-free vector smoothing, kept pure enough for the 67b jitter guard. */
export function smoothCameraVectorToRef(
  current: Readonly<MutablePresentationVector>,
  desired: Readonly<MutablePresentationVector>,
  response: number,
  result: MutablePresentationVector,
): void {
  const amount = Math.min(1, Math.max(0, Number.isFinite(response) ? response : 0));
  result.x = current.x + (desired.x - current.x) * amount;
  result.y = current.y + (desired.y - current.y) * amount;
  result.z = current.z + (desired.z - current.z) * amount;
}

/**
 * Project an up candidate onto the camera plane and normalize it in place.
 * Keeping up orthogonal to view prevents a changing look target from turning
 * a harmless bank response into camera roll/shear. Inputs may alias `result`.
 */
export function orthogonalizeCameraUpToRef(
  candidate: Readonly<MutablePresentationVector>,
  viewDirection: Readonly<MutablePresentationVector>,
  fallback: Readonly<MutablePresentationVector>,
  result: MutablePresentationVector,
): void {
  const vx = Number.isFinite(viewDirection.x) ? viewDirection.x : 0;
  const vy = Number.isFinite(viewDirection.y) ? viewDirection.y : 0;
  const vz = Number.isFinite(viewDirection.z) ? viewDirection.z : 0;
  const viewLengthSquared = vx * vx + vy * vy + vz * vz;
  let upX = Number.isFinite(candidate.x) ? candidate.x : 0;
  let upY = Number.isFinite(candidate.y) ? candidate.y : 0;
  let upZ = Number.isFinite(candidate.z) ? candidate.z : 0;

  if (viewLengthSquared > 1e-12) {
    let projection = (upX * vx + upY * vy + upZ * vz) / viewLengthSquared;
    upX -= vx * projection;
    upY -= vy * projection;
    upZ -= vz * projection;
    if (upX * upX + upY * upY + upZ * upZ <= 1e-12) {
      upX = Number.isFinite(fallback.x) ? fallback.x : 0;
      upY = Number.isFinite(fallback.y) ? fallback.y : 0;
      upZ = Number.isFinite(fallback.z) ? fallback.z : 0;
      projection = (upX * vx + upY * vy + upZ * vz) / viewLengthSquared;
      upX -= vx * projection;
      upY -= vy * projection;
      upZ -= vz * projection;
    }
    if (upX * upX + upY * upY + upZ * upZ <= 1e-12) {
      // Select the world axis least parallel to the view, then project it.
      const absX = Math.abs(vx);
      const absY = Math.abs(vy);
      const absZ = Math.abs(vz);
      upX = absX <= absY && absX <= absZ ? 1 : 0;
      upY = absY < absX && absY <= absZ ? 1 : 0;
      upZ = upX === 0 && upY === 0 ? 1 : 0;
      projection = (upX * vx + upY * vy + upZ * vz) / viewLengthSquared;
      upX -= vx * projection;
      upY -= vy * projection;
      upZ -= vz * projection;
    }
  } else if (upX * upX + upY * upY + upZ * upZ <= 1e-12) {
    upX = Number.isFinite(fallback.x) ? fallback.x : 0;
    upY = Number.isFinite(fallback.y) ? fallback.y : 1;
    upZ = Number.isFinite(fallback.z) ? fallback.z : 0;
  }

  let length = Math.hypot(upX, upY, upZ);
  if (!Number.isFinite(length) || length <= 1e-12) {
    upX = 0;
    upY = 1;
    upZ = 0;
    length = 1;
  }
  result.x = upX / length;
  result.y = upY / length;
  result.z = upZ / length;
}

/**
 * Time constant of the exterior position response, in seconds.
 *
 * `cameraPresentationResponse` is `1 - exp(-dt/tau)`; these are the taus it
 * uses. Exposed because the chase rig has to reason about the response's
 * steady-state error explicitly — see `cameraTrailMeters`.
 */
export const CAMERA_RESPONSE_SECONDS = 1 / 7;
export const CAMERA_RESPONSE_SECONDS_REDUCED_MOTION = 1 / 12;

/**
 * How far behind the aircraft the chase camera USED to settle, over and above
 * the distance its profile asks for.
 *
 * A first-order lag chasing a target that translates at constant speed does
 * not converge: it settles a fixed `speed * tau` behind it. The chase rig
 * smoothed an ABSOLUTE world position, so that error was real and large —
 * measured in-game at 20.6 m against a 13.5 m profile for the trainer (7.1 m
 * of it lag, predicted 52 * 1/7 = 7.4) and 30.3 m against 14.3 m for the jet
 * (16 m of lag, predicted 140 * 1/7 = 20).
 *
 * The rig now smooths the offset FROM the aircraft, which has no such error,
 * so this term is added back deliberately along the body axis to leave the
 * settled framing exactly where players already know it. Two things make the
 * deliberate version better than the accident it replaces:
 *
 *  - it lies along the aircraft's nose, not along its ground track, so a
 *    crosswind no longer pushes the airframe sideways out of frame; and
 *  - it is a distance, not a lag, so it no longer leaves a lateral residue
 *    for seconds after every turn.
 *
 * Reduced motion uses the faster response and therefore a shorter trail, as
 * it did before.
 *
 * **The speed is the aircraft's OBSERVED motion between frames, not its
 * airspeed.** The lag this replaces was produced by the aeroplane moving, so
 * an aeroplane that is not moving never had one. Reading the airspeed field
 * instead is wrong wherever the two disagree, and they disagree in exactly the
 * place it matters: a perf-capture shot holds a fixed position while declaring
 * an airspeed, and an airspeed-derived trail pushed the camera tens of metres
 * back in every chase shot in the canonical set — measured as 30% to 99% of
 * pixels moving, against a same-arm noise floor of under 1%.
 */
export function cameraTrailMeters(
  cameraMode: CameraMode,
  reducedMotion: boolean,
  observedGroundSpeed: number,
): number {
  if (cameraMode !== "chase" && cameraMode !== "cinematic") return 0;
  const speed = Number.isFinite(observedGroundSpeed) ? Math.max(0, observedGroundSpeed) : 0;
  return speed * (reducedMotion
    ? CAMERA_RESPONSE_SECONDS_REDUCED_MOTION
    : CAMERA_RESPONSE_SECONDS);
}

/**
 * The vertical reference an exterior rig should build its offsets on.
 *
 * `cameraBankFollow` says how much of the aircraft's BANK the view adopts, and
 * the camera's own up vector honours it. The rig's position and aim point did
 * not: they were raised along the aircraft's up at full strength while the
 * view rolled only 18% of the way there, so the two disagreed by 82% of the
 * bank. Because the aim point sits 1.25 m up the body axis and the camera
 * 5.1 m up it, the airframe hangs about 3.3 m below the view axis — and
 * rolling the frame under an off-axis object slides it sideways. Measured on
 * the shipped rig: 0.155% of frame width per degree of bank, leftward in a
 * right bank, on both airframes.
 *
 * Blending from `up0` — the up this aircraft would have at the same heading
 * and pitch with its wings level — rather than from world up keeps PITCH
 * following at full strength, so a wings-level frame is unchanged at any
 * pitch attitude and only the roll component is attenuated.
 */
export function cameraRigLiftToRef(
  forward: Readonly<MutablePresentationVector>,
  up: Readonly<MutablePresentationVector>,
  bankFollow: number,
  result: MutablePresentationVector,
): void {
  const follow = Math.min(1, Math.max(0, Number.isFinite(bankFollow) ? bankFollow : 1));
  // Horizontal starboard, h = forward x worldUp = (-fz, 0, fx). Degenerate
  // only when the nose points straight up or down, where "wings level" has no
  // meaning and the aircraft's own up is the best reference available.
  const horizontal = Math.hypot(forward.x, forward.z);
  if (!(horizontal > 1e-6)) {
    result.x = up.x;
    result.y = up.y;
    result.z = up.z;
    return;
  }
  const hx = -forward.z / horizontal;
  const hz = forward.x / horizontal;
  // up0 = h x forward. h has no y component, so this reduces to:
  let ux = -hz * forward.y;
  let uy = hz * forward.x - hx * forward.z;
  let uz = hx * forward.y;
  const length0 = Math.hypot(ux, uy, uz);
  if (!(length0 > 1e-12)) {
    result.x = up.x;
    result.y = up.y;
    result.z = up.z;
    return;
  }
  ux /= length0;
  uy /= length0;
  uz /= length0;
  let x = ux + (up.x - ux) * follow;
  let y = uy + (up.y - uy) * follow;
  let z = uz + (up.z - uz) * follow;
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-12)) {
    x = up.x;
    y = up.y;
    z = up.z;
  } else {
    x /= length;
    y /= length;
    z /= length;
  }
  result.x = x;
  result.y = y;
  result.z = z;
}

/**
 * How far the chase camera drops toward the aircraft's own level in a bank:
 * its height is `height x (1 - CHASE_BANK_HEIGHT_DROP x sin^2 bank)`, so 2/3 of
 * the profile's at 45 degrees, 1/2 at 60 and 1/3 at 90 -- never below the
 * aircraft.
 *
 * WHY. Building the rig on the blended lift (`cameraRigLiftToRef`) stopped the
 * airframe sliding sideways in a bank, and in exchange it sank: the old rig
 * raised the camera along the aircraft's BANKED up, which in a bank is lower
 * in world terms, and the blended lift keeps it near world up. Measured on the
 * two banked perf shots with only the lift switched (highlight centroid,
 * percent down / across the frame): 45 degrees 74.0 / 37.2 with the old lift
 * and 82.7 / 49.2 with the blended one; 60 degrees 65.3 / 35.1 and 77.8 / 49.3.
 * Dropping the camera by bank alone gives the height back without giving back
 * the slide: at 2/3 the same shots read 75.0 / 51.1 and 65.2 / 48.9.
 *
 * A steeper blend matched 45 degrees exactly too, but drifted the airframe 2-3
 * percent sideways, a flatter view showing more of the lit lower wing. 2/3 is
 * the constant that keeps it within about 1 percent of centre.
 */
export const CHASE_BANK_HEIGHT_DROP = 2 / 3;

/**
 * sin^2 of the aircraft's bank, measured from wings-level at the same heading
 * and pitch -- the `up0` `cameraRigLiftToRef` blends from -- so pitch alone
 * never reads as bank. `up` lies in the plane of `up0` and the horizontal
 * starboard `h`, as `cos(bank) up0 + sin(bank) h`, so sin(bank) is `up . h`.
 *
 * Exactly 0 wings level (below 1e-12, a bank of about 6e-5 degrees) and where
 * the nose points straight up or down, where "bank" has no meaning: the chase
 * rig is then bit-for-bit what it was.
 */
export function chaseBankSinSquared(
  forward: Readonly<MutablePresentationVector>,
  up: Readonly<MutablePresentationVector>,
): number {
  const horizontal = Math.hypot(forward.x, forward.z);
  if (!(horizontal > 1e-6)) return 0;
  const sinBank = (up.x * -forward.z + up.z * forward.x) / horizontal;
  const squared = sinBank * sinBank;
  if (!(squared >= 1e-12)) return 0;
  return Math.min(1, squared);
}

/** The chase camera's height for this attitude: `height` itself, exactly, wings level. */
export function chaseRigHeightForBank(
  height: number,
  forward: Readonly<MutablePresentationVector>,
  up: Readonly<MutablePresentationVector>,
): number {
  const sinSquared = chaseBankSinSquared(forward, up);
  return sinSquared === 0 ? height : height * (1 - CHASE_BANK_HEIGHT_DROP * sinSquared);
}

/**
 * Where the chase camera and its aim point sit, relative to the aircraft.
 *
 * Pure, and separated from the renderer for one reason: the claim that this
 * rig leaves an UNBANKED frame exactly where the old one did is a claim about
 * arithmetic, and trying to establish it from rendered pixels failed. Two
 * identical capture runs of identical code moved 30% of a frame with maxima of
 * 170/255 on this machine, which is a noise floor far too blunt to clear a
 * camera change against. Here it is a fact a test can check to the last bit.
 *
 * At zero bank `lift` IS the aircraft's up vector (`cameraRigLiftToRef`) and
 * at zero motion `trail` is exactly 0 (`cameraTrailMeters`), so both results
 * below reduce, character for character, to the pre-fix formulas
 * `-forward*distance + up*height` and `forward*aimAhead + up*1.25`.
 *
 * The trail is carried by BOTH offsets. That is what leaves the view direction
 * untouched — the camera and its target move back together, so only the
 * framing distance grows and the aeroplane stays where it was in frame.
 */
export function chaseRigOffsetsToRef(
  forward: Readonly<MutablePresentationVector>,
  lift: Readonly<MutablePresentationVector>,
  distance: number,
  height: number,
  aimAhead: number,
  aimHeight: number,
  trail: number,
  camera: MutablePresentationVector,
  target: MutablePresentationVector,
): void {
  // The trail is clamped so the aim point can never fall behind the aircraft.
  //
  // It reproduces a lag that was calibrated against aeroplanes doing 52 and
  // 140 m/s, and it grows linearly with speed for ever. An F-16 in reheat does
  // 410, where an unclamped trail is 58.6 m against a 30.5 m profile distance
  // and drives `aimAhead - trail` to MINUS 17.6 m — the camera aiming at a
  // point behind the aeroplane it is following. The Global crosses zero too,
  // at about 250 m/s. Nothing below roughly 190 m/s is affected, so the
  // framing players already know is untouched; this only stops the
  // extrapolation running away above the speeds it was measured at.
  const usableTrail = Math.max(0, Math.min(trail, aimAhead - MINIMUM_CHASE_AIM_AHEAD_METERS));
  const behind = distance + usableTrail;
  camera.x = -forward.x * behind + lift.x * height;
  camera.y = -forward.y * behind + lift.y * height;
  camera.z = -forward.z * behind + lift.z * height;
  const ahead = aimAhead - usableTrail;
  target.x = forward.x * ahead + lift.x * aimHeight;
  target.y = forward.y * ahead + lift.y * aimHeight;
  target.z = forward.z * ahead + lift.z * aimHeight;
}

/** The aim point's height up the rig's vertical, in metres. */
export const CHASE_AIM_HEIGHT_METERS = 1.25;

/**
 * How far ahead of the aircraft the chase camera must keep aiming, in metres.
 *
 * Not a style choice: at or below zero the camera is looking at a point behind
 * the aeroplane, which puts the airframe above the centre of frame and moving
 * the wrong way relative to the aim as speed changes. Four metres keeps a
 * positive lead on every airframe at every speed either of them can reach.
 */
export const MINIMUM_CHASE_AIM_AHEAD_METERS = 4;

/**
 * The gameplay cockpit lens: 75 degrees HORIZONTAL.
 *
 * The flight camera is `FOVMODE_HORIZONTAL_FIXED`, so every field of view the
 * renderer sets is the horizontal one. At 16:9, 75 degrees is 46.7 vertical:
 * azimuth +-37.5 and elevation +-23.4 at the centre line.
 *
 * The lens this replaced was 56 degrees — 33.5 vertical, a telephoto. It put
 * every instrument below the bottom of the frame (the dials sit 17 to 25
 * degrees under the eye and the frame stopped at 16.7) and left no room for a
 * windscreen post, a sill or a glareshield to fit in view at all. A real
 * cockpit shows the pilot a great deal more than that.
 */
export const COCKPIT_HORIZONTAL_FOV_DEGREES = 75;

/**
 * The lens the perf-capture harness keeps for its cockpit-mode shots.
 *
 * Fourteen capture shots use the cockpit camera as a free camera. They were
 * placed, and their placement predicates written, for a 56 degree lens, and
 * they have to stay comparable with their committed baselines, so they keep
 * it. The harness passes `PERF_COCKPIT_RIG` to the renderer and NOTHING ELSE
 * does (`tests/render.cockpit-rig.test.ts` scans for it): a second caller
 * would put a player on the wrong lens without anything failing.
 */
export const PERF_COCKPIT_HORIZONTAL_FOV_DEGREES = 56;

/** A cockpit rig that replaces the gameplay one. Perf capture only. */
export interface CockpitRigOverride {
  readonly horizontalFovDegrees: number;
  /**
   * Drop the eye's lateral offset, so the eye sits on the body centreline as
   * it did before the pilot moved to the left seat. Without this the fourteen
   * capture shots would still move sideways by up to 0.26 m (the trainer's
   * seat offset) and keeping their lens would only be half of keeping them.
   */
  readonly pinEyeToCentreline: boolean;
  /**
   * Draw NO part of the aeroplane through this camera while cockpit view is on: not the skin, the
   * cabin roof, the centre windscreen frame, the posts, the cockpit-only kit or the propeller disc.
   *
   * The fourteen cockpit capture shots exist to measure VEGETATION, GROUND AND WATER from a pilot's
   * eye. Once the cockpit had a kit in it, about 40% of every one of those frames was aeroplane --
   * the centre frame a large obelisk down the middle at this rig's centreline eye, the cowl stand-in
   * and the panel filling the lower third -- against committed baselines that are pure world. That
   * costs the shots the coverage they were placed for, adds draws to ten ceilings, and writes every
   * future cockpit change into the perf baselines. A world-only rig measures the world.
   */
  readonly hideAircraft: boolean;
  /**
   * The eye, in metres along the body's nose and up axes, FROZEN at what the renderer used when the
   * fourteen cockpit baselines were promoted (`4b60d85`, `FlightRenderer.ts`: `forward.scale(1.15)`
   * then `up.scale(1.12)`, one eye for every kind and no lateral term).
   *
   * It is pinned rather than read from the catalogue because the catalogue's eye MOVED during the
   * cockpit work -- the trainer's is now (1.38, 0.12) -- and the terrain engineer measured the
   * consequence directly: a 2 to 3 pixel VERTICAL shift of the world in all fourteen shots against
   * their baselines (canopy-1200ft dy -2, veg-seam-near-500ft dy -3, horizon-shadow dy -1, while the
   * chase shots were dy 0). With the aeroplane hidden, the world is the only thing left in those
   * frames, so the eye that framed the baselines is the one that has to stay.
   */
  readonly eyeForwardMetres: number;
  readonly eyeUpMetres: number;
}

/** The rig every perf-capture cockpit shot renders with: the previous one, exactly. */
export const PERF_COCKPIT_RIG: CockpitRigOverride = Object.freeze({
  horizontalFovDegrees: PERF_COCKPIT_HORIZONTAL_FOV_DEGREES,
  pinEyeToCentreline: true,
  hideAircraft: true,
  eyeForwardMetres: 1.15,
  eyeUpMetres: 1.12,
});

/**
 * The eye a cockpit camera sits at, after any override: the catalogue's for a player, the frozen
 * pre-wave one for perf capture (see `PERF_COCKPIT_RIG`).
 */
export function cockpitEyeForwardUpMetres(
  eye: Readonly<Pick<CockpitEyeSpec, "forward" | "up">>,
  override: Readonly<CockpitRigOverride> | null,
): { readonly forward: number; readonly up: number } {
  return override === null
    ? { forward: eye.forward, up: eye.up }
    : { forward: override.eyeForwardMetres, up: override.eyeUpMetres };
}

/** Whether this rig draws the aeroplane at all in cockpit view. */
export function cockpitRigDrawsAircraft(override: Readonly<CockpitRigOverride> | null): boolean {
  return override === null || !override.hideAircraft;
}

/** How far ahead of the eye the cockpit camera aims, in metres. */
export const COCKPIT_AIM_DISTANCE_METERS = 400;

/** The horizontal field of view, in degrees, the cockpit camera should have. */
export function cockpitFieldOfViewDegrees(
  override: Readonly<CockpitRigOverride> | null,
): number {
  return override === null ? COCKPIT_HORIZONTAL_FOV_DEGREES : override.horizontalFovDegrees;
}

/**
 * The widest window, width over height, on which the gameplay cockpit lens is
 * still its 75 degrees HORIZONTAL: 16:9. Wider than this it holds the vertical
 * field it has here instead (`cockpitHorizontalFieldOfViewForAspect`).
 */
export const COCKPIT_LENS_HELD_ASPECT = 16 / 9;

/**
 * The cockpit camera's horizontal field of view, in degrees, on a window of
 * `aspect` (width over height): a hybrid lens.
 *
 * Up to 16:9 it is `cockpitFieldOfViewDegrees(override)`, the same number: the
 * horizontal-fixed 75 degrees every deck is built and measured against. Wider,
 * the gameplay lens keeps the VERTICAL field it has at 16:9 (46.69 degrees) and
 * grows sideways, to 90.4 degrees at 21:9. Horizontal-fixed alone crops a wide
 * window from below: at 21:9 the frame's bottom is 18.2 degrees under the eye
 * (23.35 at 16:9), which left none of the F-16's MFDs or the 747's glass in
 * view and 13 % of the Global's screens (docs/findings/COCKPIT_HUD_LAYOUT_2026_09_23.md).
 *
 * The perf rig's lens (an override) is fixed at every aspect: its shots and
 * baselines were framed on it.
 */
export function cockpitHorizontalFieldOfViewForAspect(
  override: Readonly<CockpitRigOverride> | null,
  aspect: number,
): number {
  const lens = cockpitFieldOfViewDegrees(override);
  // A window with no height (an infinite aspect) keeps the plain lens rather than a 180 degree one.
  if (override !== null || !Number.isFinite(aspect) || !(aspect > COCKPIT_LENS_HELD_ASPECT)) return lens;
  const tanHalfVertical = Math.tan((lens * Math.PI) / 360) / COCKPIT_LENS_HELD_ASPECT;
  return (Math.atan(tanHalfVertical * aspect) * 360) / Math.PI;
}

/** The eye's lateral offset in metres, positive to starboard, after any override. */
export function cockpitEyeRightMeters(
  eye: Readonly<Pick<CockpitEyeSpec, "right">>,
  override: Readonly<CockpitRigOverride> | null,
): number {
  return override !== null && override.pinEyeToCentreline ? 0 : eye.right;
}

/**
 * Where the cockpit camera and its aim point are, in the same space as
 * `origin` (the aircraft's position).
 *
 * The eye sits `eye.forward` ahead of the origin along the nose, `eye.up`
 * above it along the aircraft's up and `eyeRight` to starboard along
 * `forward x up` — the body frame's +Z, so every term rolls and pitches with
 * the airframe. The aim point is the eye plus `aimDistance` along the nose and
 * NOTHING else: it carries the same lateral offset the eye does, which keeps
 * the view direction parallel to the body axis wherever the eye is. Aiming at
 * a point on the centreline instead would toe the view in by
 * `atan(eyeRight / aimDistance)` and the HUD's centre mark would stop meaning
 * "where the nose points".
 *
 * The additions run in the order the renderer used before there was a lateral
 * term (origin, then forward, then up) and the lateral term is skipped when it
 * is zero, so a zero `eyeRight` reproduces the previous camera to the last bit
 * — which is what lets the perf shots stay comparable.
 */
export function cockpitRigPositionsToRef(
  origin: Readonly<MutablePresentationVector>,
  forward: Readonly<MutablePresentationVector>,
  up: Readonly<MutablePresentationVector>,
  eye: Readonly<Pick<CockpitEyeSpec, "forward" | "up">>,
  eyeRight: number,
  aimDistance: number,
  camera: MutablePresentationVector,
  target: MutablePresentationVector,
): void {
  camera.x = origin.x + forward.x * eye.forward;
  camera.y = origin.y + forward.y * eye.forward;
  camera.z = origin.z + forward.z * eye.forward;
  camera.x += up.x * eye.up;
  camera.y += up.y * eye.up;
  camera.z += up.z * eye.up;
  if (eyeRight !== 0) {
    // forward x up: starboard, in the body frame's right-handed +X/+Y/+Z.
    camera.x += (forward.y * up.z - forward.z * up.y) * eyeRight;
    camera.y += (forward.z * up.x - forward.x * up.z) * eyeRight;
    camera.z += (forward.x * up.y - forward.y * up.x) * eyeRight;
  }
  target.x = camera.x + forward.x * aimDistance;
  target.y = camera.y + forward.y * aimDistance;
  target.z = camera.z + forward.z * aimDistance;
}
