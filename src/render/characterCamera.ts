import { PERSON, type PersonCameraSpec } from "@/src/vehicles/person";

/**
 * The walker's "character" camera (the walking plan, "Camera"): an orbit
 * about a pivot at the neck, offset to the right shoulder, with its heading
 * and pitch driven by the mouse or the right stick and its boom pulled in at
 * once by anything between the pivot and the eye, then eased back out over
 * `easeOutSeconds`. First person puts the eye in the head. Pure numbers in
 * and out, in the renderer's floating-origin frame (world Y, X and Z less the
 * origin), so a test can hold it.
 *
 * Headings as `FlightTelemetry.heading`: forward (sin h, cos h), and they
 * grow turning LEFT, so the view's right is the heading less 90 degrees.
 */

/** An oriented box the boom cannot pass, in the camera's frame (the parked car's body). */
export interface CameraObstacleBox {
  centerX: number;
  centerY: number;
  centerZ: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  /** Rotation from box-local into the frame, a unit quaternion. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface CharacterCameraFrame {
  /** The walker's feet point and facing heading. */
  feetX: number;
  feetY: number;
  feetZ: number;
  facing: number;
  /** Look gathered since the last frame: radians right and up, wheel notches out. */
  lookYaw: number;
  lookPitch: number;
  zoom: number;
  deltaSeconds: number;
  firstPerson: boolean;
  /** Ground height under a frame point (x, z in the camera's frame). */
  groundHeight(x: number, z: number): number;
  /** The water the eye keeps to one side of, or null where there is none to ask. */
  water: CharacterCameraWater | null;
  obstacles: readonly CameraObstacleBox[];
  /**
   * The probe sphere swept through the world's static colliders from one
   * frame point to another, answering the share of the way it travels
   * before it touches one (1: clear); null where there are none.
   */
  sweep: ((fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number, radius: number) => number) | null;
}

/** The drawn water surface over a point and the band either side of it the eye keeps out of. */
export interface CameraWaterBand {
  surface: number;
  clearance: number;
}

/**
 * The water for the camera: the eye stays on the walker's head's side of the
 * surface, out of the band where the drawn surface could be either side of
 * it (`CameraWaterSample.clearance`), and so crosses it in one move.
 */
export interface CharacterCameraWater {
  /** Writes the surface over a frame point to `out`; false over dry ground. */
  at(x: number, y: number, z: number, out: CameraWaterBand): boolean;
  /** Whether the walker's head is under the surface, so the eye keeps below it. */
  below: boolean;
}

/** What the camera reads back each frame. */
export interface CharacterCameraPose {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  /** 0 the figure solid .. 1 faded out, for a camera inside its personal space. */
  fade: number;
  fieldOfView: number;
}

/** Samples along the boom for the ground test, and bisection steps once crossed. */
const GROUND_SAMPLES = 6;
const GROUND_BISECTIONS = 3;
/** The boom never pulls in shorter than this, metres. */
const MIN_BOOM = 0.35;
/** The first-person eye sits this far ahead of the head's centre, metres. */
const FIRST_PERSON_FORWARD = 0.12;

export class CharacterCamera {
  /** The view's heading and pitch, radians. */
  heading = 0;
  pitch = -0.18;
  /** Boom length asked for (the wheel's), and the one in use after collision. */
  distance: number;
  private boom: number;
  private readonly band: CameraWaterBand = { surface: 0, clearance: 0 };
  readonly pose: CharacterCameraPose = {
    eyeX: 0,
    eyeY: 0,
    eyeZ: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    fade: 0,
    fieldOfView: PERSON.camera.fieldOfView,
  };

  constructor(private readonly spec: PersonCameraSpec = PERSON.camera) {
    this.distance = spec.distance;
    this.boom = spec.distance;
  }

  /** Behind the walker, at the default pitch, boom out: a start, getting out of the car, a cut. */
  reset(facing: number): void {
    this.heading = facing;
    this.pitch = -0.18;
    this.boom = this.distance;
  }

  update(frame: CharacterCameraFrame): CharacterCameraPose {
    const spec = this.spec;
    this.heading = wrap(this.heading - frame.lookYaw);
    this.pitch = Math.min(spec.maxPitch, Math.max(spec.minPitch, this.pitch + frame.lookPitch));
    if (frame.zoom !== 0) {
      this.distance = Math.min(spec.maxDistance, Math.max(spec.minDistance, this.distance * Math.pow(1.12, frame.zoom)));
    }
    const sineHeading = Math.sin(this.heading);
    const cosineHeading = Math.cos(this.heading);
    const cosinePitch = Math.cos(this.pitch);
    const forwardX = sineHeading * cosinePitch;
    const forwardY = Math.sin(this.pitch);
    const forwardZ = cosineHeading * cosinePitch;
    const pose = this.pose;
    pose.fieldOfView = spec.fieldOfView;

    if (frame.firstPerson) {
      const headY = frame.feetY + PERSON.eyeHeight;
      pose.eyeX = frame.feetX + Math.sin(frame.facing) * FIRST_PERSON_FORWARD;
      pose.eyeY = headY;
      pose.eyeZ = frame.feetZ + Math.cos(frame.facing) * FIRST_PERSON_FORWARD;
      pose.targetX = pose.eyeX + forwardX * 10;
      pose.targetY = pose.eyeY + forwardY * 10;
      pose.targetZ = pose.eyeZ + forwardZ * 10;
      pose.fade = 0;
      this.boom = this.distance;
      return pose;
    }

    // The pivot: the neck, and the right shoulder (the view's right).
    const pivotX = frame.feetX - cosineHeading * spec.shoulderOffset;
    const pivotY = frame.feetY + spec.pivotHeight;
    const pivotZ = frame.feetZ + sineHeading * spec.shoulderOffset;
    const backX = -forwardX;
    const backY = -forwardY;
    const backZ = -forwardZ;
    let allowed = this.distance;
    allowed = Math.min(allowed, this.groundHit(frame, pivotX, pivotY, pivotZ, backX, backY, backZ, allowed));
    for (const box of frame.obstacles) {
      const hit = rayBoxDistance(pivotX, pivotY, pivotZ, backX, backY, backZ, box, spec.probeRadius);
      if (hit < allowed) allowed = hit;
    }
    if (frame.sweep && allowed > 0) {
      allowed *= frame.sweep(
        pivotX, pivotY, pivotZ,
        pivotX + backX * allowed, pivotY + backY * allowed, pivotZ + backZ * allowed,
        spec.probeRadius,
      );
    }
    allowed = Math.max(MIN_BOOM, allowed);
    // In at once, out over the ease time.
    if (allowed < this.boom) this.boom = allowed;
    else {
      const rate = 1 - Math.exp(-frame.deltaSeconds * 3 / Math.max(1e-3, spec.easeOutSeconds));
      this.boom += (allowed - this.boom) * rate;
    }
    pose.eyeX = pivotX + backX * this.boom;
    pose.eyeY = pivotY + backY * this.boom;
    pose.eyeZ = pivotZ + backZ * this.boom;
    const water = frame.water;
    if (water && water.at(pose.eyeX, pose.eyeY, pose.eyeZ, this.band)) {
      const { surface, clearance } = this.band;
      if (water.below) pose.eyeY = Math.min(pose.eyeY, surface - clearance);
      else pose.eyeY = Math.max(pose.eyeY, surface + clearance);
    }
    pose.targetX = pivotX + forwardX * 10;
    pose.targetY = pivotY + forwardY * 10;
    pose.targetZ = pivotZ + forwardZ * 10;
    // Fade the figure as the eye comes within `fadeDistance` of its body axis.
    const toAxisY = Math.min(Math.max(pose.eyeY, frame.feetY), frame.feetY + PERSON.stature);
    const fromBody = Math.hypot(pose.eyeX - frame.feetX, pose.eyeY - toAxisY, pose.eyeZ - frame.feetZ) - PERSON.capsuleRadius;
    pose.fade = Math.min(1, Math.max(0, 1 - fromBody / spec.fadeDistance));
    return pose;
  }

  /** How far the probe sphere travels back from the pivot before it meets the ground. */
  private groundHit(
    frame: CharacterCameraFrame,
    px: number,
    py: number,
    pz: number,
    dx: number,
    dy: number,
    dz: number,
    length: number,
  ): number {
    const clearance = this.spec.probeRadius;
    const below = (t: number): boolean =>
      py + dy * t - clearance < frame.groundHeight(px + dx * t, pz + dz * t);
    if (below(0)) return 0;
    let previous = 0;
    for (let sample = 1; sample <= GROUND_SAMPLES; sample += 1) {
      const t = (length * sample) / GROUND_SAMPLES;
      if (below(t)) {
        let low = previous;
        let high = t;
        for (let step = 0; step < GROUND_BISECTIONS; step += 1) {
          const mid = (low + high) / 2;
          if (below(mid)) high = mid;
          else low = mid;
        }
        return low;
      }
      previous = t;
    }
    return length;
  }
}

/**
 * Distance along a unit ray to an oriented box grown by `margin` (slab test
 * in the box's frame), or Infinity when it misses or starts inside.
 */
export function rayBoxDistance(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: CameraObstacleBox,
  margin: number,
): number {
  // Into the box's frame: the conjugate rotation of the offset and the direction.
  const rx = ox - box.centerX;
  const ry = oy - box.centerY;
  const rz = oz - box.centerZ;
  const [lox, loy, loz] = inverseRotate(box, rx, ry, rz);
  const [ldx, ldy, ldz] = inverseRotate(box, dx, dy, dz);
  const hx = box.halfX + margin;
  const hy = box.halfY + margin;
  const hz = box.halfZ + margin;
  if (Math.abs(lox) <= hx && Math.abs(loy) <= hy && Math.abs(loz) <= hz) return Infinity;
  let near = -Infinity;
  let far = Infinity;
  const slab = (origin: number, direction: number, half: number): boolean => {
    if (Math.abs(direction) < 1e-9) return Math.abs(origin) <= half;
    let t0 = (-half - origin) / direction;
    let t1 = (half - origin) / direction;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    return near <= far;
  };
  if (!slab(lox, ldx, hx) || !slab(loy, ldy, hy) || !slab(loz, ldz, hz)) return Infinity;
  return near >= 0 ? near : Infinity;
}

function inverseRotate(box: CameraObstacleBox, x: number, y: number, z: number): [number, number, number] {
  const qx = -box.qx;
  const qy = -box.qy;
  const qz = -box.qz;
  const qw = box.qw;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
