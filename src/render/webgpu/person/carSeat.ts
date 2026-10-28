import type { PersonBoardingState } from "@/src/game/types";
import { CAR_SEATING, PERSON } from "@/src/vehicles/person";
import { BODY, DOOR_LINES, FRONT_DOOR_HINGE, GLASSHOUSE, STEERING_WHEEL } from "../ground/lc76Lines";
import { both, channels, createChannels, mirrorChannels, mixChannels } from "./channels";
import { PROPORTIONS } from "./figureProportions";
import { STAND } from "./actions";

/**
 * The walker in the LandCruiser's driver's seat, and getting in and out.
 *
 * THE SEAT FRAME. While boarding and seated the renderer poses the figure's
 * root at the driver's hip point (`CAR_SEATING.driverHip`) in the car's
 * body axes: +X forward, +Y up, +Z right. Every place below is in that frame,
 * metres, read off the drawn car (`lc76Lines.ts`, `carCockpit.ts`):
 *  - the hip point (SAE H-point) 0.135 m ahead of the seat back's face and
 *    0.09 m over the cushion as a seated body presses it, from the drawn
 *    front seat: the back's face runs from (-0.52, 1.00) to (-0.62, 1.60) and
 *    the cushion's top from (-0.58, 1.03) to (-0.12, 1.06) (x, height above
 *    the ground) in the body frame, so the hip point stands at x -0.40,
 *    1.09 m above the ground, over the seat's middle (z 0.37). MEASURED on
 *    the drawing; `CAR_SEATING.driverHip` holds it;
 *  - the steering wheel's hub and rim (`STEERING_WHEEL`), the side step's top
 *    (0.50 m above the ground, 0.80-0.93 m out), the cabin floor (0.68 m),
 *    the A-pillar and the front door's hinge line (`DOOR_LINES`).
 *
 * The wheel stands 0.58 m ahead of the hip point and only 0.11 m above it,
 * further than a 1.76 m driver's arms reach from a reclined back, so the
 * figure sits forward off the backrest, leaning about 14 degrees, to hold it
 * at a quarter to three.
 *
 * GETTING IN (right door, right-hand drive; the left door is the mirror
 * image, sliding across the passenger seat): walk from where the walker
 * stood to the door while it opens (progress 0-0.22), the inner hand to the
 * A-pillar's grab handle and the inner foot onto the side step, hoist up and
 * turn, sit on the seat's edge facing out, swing the legs in round to face
 * forward with the feet to the pedals, then the outer hand pulls the door
 * shut (0.8-1.0) and both go to the wheel. GETTING OUT runs the other way and
 * ends standing on `CAR_SEATING.doorStand` facing away from the car.
 *
 * The door's swing is `doorOpenAt`, the one both the figure's hands and the
 * car's hinged door read. ESTIMATES: the poses, the door's full opening
 * (`DOOR_OPEN_RADIANS`), the pedals' places.
 */
const HIP = CAR_SEATING.driverHip;
const HIP_ABOVE_GROUND = CAR_SEATING.cgAboveGround + HIP.up;

/** A body-frame point (x, height above the ground, z) in the seat frame. */
function seatPoint(x: number, height: number, z: number): readonly [number, number, number] {
  return Object.freeze([x - HIP.forward, height - HIP_ABOVE_GROUND, z - HIP.right]) as unknown as readonly [number, number, number];
}

/** The front door: its hinge's station, its length to the trailing edge, its swing at full opening. */
const DOOR_HINGE_X = FRONT_DOOR_HINGE.x;
const DOOR_LENGTH = FRONT_DOOR_HINGE.x - DOOR_LINES.frontDoorRear;
const DOOR_OPEN_RADIANS = FRONT_DOOR_HINGE.openRadians;

export const SEAT = Object.freeze({
  /** The ground and the cabin floor's heights in the seat frame. */
  ground: -HIP_ABOVE_GROUND,
  floor: 0.68 - HIP_ABOVE_GROUND,
  /** The wheel's hub, rim radius and the column's rake (the rim's top forward of its foot). */
  wheelCentre: seatPoint(STEERING_WHEEL.x, STEERING_WHEEL.height, STEERING_WHEEL.z),
  wheelRadius: STEERING_WHEEL.radius,
  wheelTilt: STEERING_WHEEL.tiltRadians,
  /** The right side step's top where the inner foot goes (z mirrored for the left). */
  step: seatPoint(0.05, 0.5, 0.865),
  /** The grab handle inside the A-pillar. */
  pillarHandle: seatPoint(BODY.cowlX - 0.16, 1.5, GLASSHOUSE.footHalfWidth - 0.1),
  /** Where the walker stands outside the door. */
  doorStand: seatPoint(CAR_SEATING.doorStand.forward, 0, CAR_SEATING.doorStand.right),
  /** The ankles' places on the pedals: right on the accelerator, left on the clutch. */
  rightPedal: seatPoint(0.27, 0.77, 0.37 + 0.12),
  leftPedal: seatPoint(0.25, 0.77, 0.37 - 0.16),
  /** The passenger's seat, the left door's way through. */
  passengerOffset: -2 * HIP.right,
});

/** How far open the boarding door is (0 shut .. 1 open) at a boarding progress: the timing the walk plan set. */
export function doorOpenAt(action: PersonBoardingState["action"], progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  if (action === "getIn") return smooth(0, 0.25, p) * (1 - smooth(0.8, 1, p));
  return smooth(0, 0.2, p) * (1 - smooth(0.75, 1, p));
}

/** A point on the right front door opened by `open`, `along` metres back from the hinge, `height` above the ground, `out` off its skin, into limb `limb`'s target. */
function doorPoint(open: number, along: number, height: number, out: number, target: Float64Array, limb: number): void {
  const angle = open * DOOR_OPEN_RADIANS;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  target[limb * 3] = DOOR_HINGE_X - along * c + out * s - HIP.forward;
  target[limb * 3 + 1] = height - HIP_ABOVE_GROUND;
  target[limb * 3 + 2] = FRONT_DOOR_HINGE.z + along * s + out * c - HIP.right;
}

// --- Key poses (channels), right door. ---------------------------------------------------------

export const SEATED = channels({
  ...both({ hipFlex: 84, hipAbd: 7, hipRot: -6, knee: 78, ankle: 12, shFlex: 52, shAbd: 10, shRot: 10, elbow: 38, clavProt: 25, foreTwist: 40, fingers: 62, thumb: 30, wristFlex: -10 }),
  pelvisTilt: -12,
  spineFlex: 36,
  neckFlex: -18,
  headFlex: -6,
});
const STEP_UP = channels({ ...both({ shAbd: -4, elbow: 15, fingers: 25 }), hipFlexL: 72, kneeL: 92, ankleL: 10, hipFlexR: 4, kneeR: 6, spineFlex: 10 });
const HOIST = channels({ ...both({ elbow: 25, fingers: 30 }), hipFlexL: 30, kneeL: 30, hipFlexR: 25, kneeR: 45, ankleR: -20, hipAbdR: 10, spineFlex: 18, neckFlex: -10 });
const SIT_OUT = channels({ ...both({ hipFlex: 82, hipAbd: 8, knee: 82, ankle: 5, elbow: 20, fingers: 30 }), pelvisTilt: -10, spineFlex: 14 });
const LEGS_IN = channels({ ...both({ hipFlex: 104, hipAbd: 10, knee: 112, ankle: 15, elbow: 30, fingers: 35 }), pelvisTilt: -14, spineFlex: 6 });
const SLIDE_OUT = channels({ ...both({ elbow: 20, fingers: 30 }), hipFlexL: 70, kneeL: 85, hipFlexR: 40, kneeR: 30, ankleR: -10, pelvisTilt: -6, spineFlex: 18 });

type Key = readonly [p: number, x: number, y: number, z: number, yaw: number, pose: Float64Array];

const STAND_HIP = SEAT.ground + PROPORTIONS.hipHeight;
const DOOR = SEAT.doorStand;
const STEP = SEAT.step;

/** Getting in after the walk to the door: the pelvis's place, the body's turn right, the pose. */
const GET_IN: readonly Key[] = [
  [0.22, DOOR[0], STAND_HIP, DOOR[2], -0.55, STAND],
  [0.3, DOOR[0] + 0.02, STAND_HIP - 0.01, DOOR[2] - 0.03, -0.7, STAND],
  [0.36, DOOR[0] + 0.06, STAND_HIP + 0.02, DOOR[2] - 0.1, -0.75, STEP_UP],
  [0.48, STEP[0] - 0.2, STEP[1] + PROPORTIONS.hipHeight - 0.06, STEP[2] + 0.18, 0.25, HOIST],
  // The hips stay ahead of the B pillar (body x -0.375) until they are inboard of the door's skin.
  [0.58, 0.16, 0.09, 0.32, 1.0, SIT_OUT],
  [0.64, 0.06, 0.0, 0.18, 1.12, SIT_OUT],
  [0.72, 0.03, 0.01, 0.08, 0.6, LEGS_IN],
  [0.8, 0, 0, 0, 0, SEATED],
  [1, 0, 0, 0, 0, SEATED],
];

const GET_OUT: readonly Key[] = [
  [0, 0, 0, 0, 0, SEATED],
  [0.12, 0.01, 0.01, 0.03, 0.2, SEATED],
  [0.28, 0.04, 0.01, 0.1, 0.85, LEGS_IN],
  [0.38, 0.06, 0.0, 0.2, 1.15, SIT_OUT],
  [0.45, 0.17, -0.03, 0.36, 1.2, SIT_OUT],
  [0.52, STEP[0] - 0.22, STEP[1] + PROPORTIONS.hipHeight - 0.12, STEP[2] + 0.1, 1.25, SLIDE_OUT],
  [0.62, DOOR[0] + 0.03, STAND_HIP - 0.04, DOOR[2] - 0.12, 1.35, STAND],
  [0.75, DOOR[0], STAND_HIP, DOOR[2], Math.PI / 2, STAND],
  [1, DOOR[0], STAND_HIP, DOOR[2], Math.PI / 2, STAND],
];

/** Where the getting-in walk ends, and its share of the progress. */
export const GET_IN_WALK_END = 0.22;

/** Past a re-grip's threshold by this share of a third of a turn before the hand lets go. */
const REGRIP_MARGIN = 0.05;

export interface SeatPlacement {
  /** The pelvis's place and the body's turn to the right, in the seat frame. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Getting in, walking to the door: the walk's speed m/s (the gait plays), else 0. */
  walkSpeed: number;
  /** 0..1: how much the feet stand on the ground (the foot planter's weight). */
  ground: number;
  /** Each foot asked to stand on the ground, left then right. */
  stance: [boolean, boolean];
  /** Limb targets, seat frame, and their weights: left hand, right hand, left foot, right foot. */
  readonly targets: Float64Array;
  readonly weights: Float64Array;
  /** The feet's orientation on their targets: flat (0) or toes up on a pedal (radians). */
  footPitch: number;
  /** The grip's place on the wheel, per hand, and the wheel's hub (seat frame) for the hands' turn. */
  gripping: number;
}

/**
 * The seated driver and getting in and out, as the figure's motion reads
 * them each frame: channels, the pelvis's placement and the limbs' targets.
 */
export class CarSeatMotion {
  readonly placement: SeatPlacement = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    walkSpeed: 0,
    ground: 0,
    stance: [true, true],
    targets: new Float64Array(12),
    weights: new Float64Array(4),
    footPitch: 0,
    gripping: 0,
  };
  private readonly mirror = createChannels();
  /** The getting-in-and-out moves' own targets (door, pillar, step) and the seat's (wheel, pedals), mixed at the end. */
  private readonly moveTargets = new Float64Array(12);
  private readonly moveWeights = new Float64Array(4);
  private readonly seatTargets = new Float64Array(12);
  private readonly seatWeights = new Float64Array(4);
  /** Each hand's re-grip offset on the wheel, radians, easing out, and the shuffle count it was at. */
  private readonly regrip = new Float64Array(2);
  private readonly shuffle = new Float64Array(2);

  /**
   * Writes the pose into `out` and the placement for a seated driver turning
   * the wheel by `steeringWheel` radians, or getting in or out.
   */
  update(
    boarding: PersonBoardingState | null,
    steeringWheel: number,
    from: BoardingFrom | null,
    /** The boarding door's opening as the car draws it (0..1), or null to time it from the progress. */
    doorOpening: number | null,
    deltaSeconds: number,
    out: Float64Array,
  ): SeatPlacement {
    const place = this.placement;
    const mt = this.moveTargets;
    const mw = this.moveWeights;
    mw.fill(0);
    this.seatWeights.fill(0);
    place.walkSpeed = 0;
    place.footPitch = 0.6;
    if (!boarding) {
      out.set(SEATED);
      place.x = 0;
      place.y = 0;
      place.z = 0;
      place.yaw = 0;
      place.ground = 0;
      place.stance[0] = false;
      place.stance[1] = false;
      this.hands(steeringWheel, 1, 1, deltaSeconds);
      this.pedals(1);
      this.mix();
      return place;
    }
    const sideSign = boarding.side === "right" ? 1 : -1;
    const p = Math.min(1, Math.max(0, boarding.progress));
    const getIn = boarding.action === "getIn";
    // Everything is drawn for the right door; the left door's is its mirror image (below).
    sampleKeys(getIn ? GET_IN : GET_OUT, p, place, out);
    if (getIn && p < GET_IN_WALK_END) {
      // Walk from where the walker stood to the door.
      const start = from ?? { forward: DOOR[0], up: SEAT.ground, right: sideSign > 0 ? DOOR[2] : mirrorZ(DOOR[2]), facing: -0.55 * sideSign };
      const startZ = sideSign > 0 ? start.right : mirrorZ(start.right);
      const facing = start.facing * sideSign;
      const t = p / GET_IN_WALK_END;
      const u = t * t * (3 - 2 * t);
      place.x = start.forward + (DOOR[0] - start.forward) * u;
      place.z = startZ + (DOOR[2] - startZ) * u;
      place.y = STAND_HIP + (start.up - SEAT.ground) * (1 - u);
      place.yaw = facing + angleDelta(facing, -0.55) * smooth(0.3, 1, u);
      const distance = Math.hypot(DOOR[0] - start.forward, DOOR[2] - startZ);
      place.walkSpeed = (distance * 6 * t * (1 - t)) / (GET_IN_WALK_END * PERSON.getInSeconds);
      out.set(STAND);
    }
    let seatedShare: number;
    if (getIn) {
      place.ground = 1 - smooth(0.44, 0.52, p);
      place.stance[0] = p < 0.29;
      place.stance[1] = p < 0.46;
      // The inner (left) foot onto the step and off it as the legs swing in.
      setLimb(mt, mw, 2, STEP[0], STEP[1] + PROPORTIONS.ankleHeight, STEP[2], smooth(0.29, 0.36, p) * (1 - smooth(0.58, 0.66, p)));
      // The outer hand opens the door and later pulls it shut; the inner takes the pillar.
      const door = doorOpening ?? doorOpenAt("getIn", p);
      const opening = smooth(0.1, 0.18, p) * (1 - smooth(0.27, 0.34, p));
      const shutting = smooth(0.76, 0.82, p) * (1 - smooth(0.9, 0.95, p));
      if (shutting > 0) doorPoint(door, DOOR_LENGTH - 0.45, 1.02, -0.08, mt, 3);
      else doorPoint(door, DOOR_LENGTH - 0.12, 1.12, 0.05, mt, 3);
      mw[1] = Math.max(opening, shutting);
      setLimb(mt, mw, 0, SEAT.pillarHandle[0], SEAT.pillarHandle[1], SEAT.pillarHandle[2], smooth(0.24, 0.32, p) * (1 - smooth(0.66, 0.74, p)));
      seatedShare = smooth(0.72, 0.8, p);
      this.hands(steeringWheel, smooth(0.7, 0.84, p), smooth(0.92, 1, p), deltaSeconds);
      this.pedals(smooth(0.74, 0.84, p));
    } else {
      // The outer foot reaches the ground as the hips come down off the sill, then the inner one off the step.
      place.ground = smooth(0.58, 0.64, p);
      place.stance[0] = p > 0.66;
      place.stance[1] = p > 0.6;
      setLimb(mt, mw, 2, STEP[0], STEP[1] + PROPORTIONS.ankleHeight, STEP[2], smooth(0.34, 0.42, p) * (1 - smooth(0.62, 0.68, p)));
      const door = doorOpening ?? doorOpenAt("getOut", p);
      doorPoint(door, DOOR_LENGTH - 0.45, 1.02, -0.08, mt, 3);
      mw[1] = smooth(0.04, 0.1, p) * (1 - smooth(0.2, 0.28, p));
      // The inner hand takes the pillar, then pushes the door shut behind.
      const push = smooth(0.72, 0.78, p) * (1 - smooth(0.9, 0.98, p));
      if (push > 0) doorPoint(door, DOOR_LENGTH - 0.2, 1.2, 0.08, mt, 0);
      else setLimb(mt, mw, 0, SEAT.pillarHandle[0], SEAT.pillarHandle[1], SEAT.pillarHandle[2], 0);
      mw[0] = Math.max(push, smooth(0.16, 0.26, p) * (1 - smooth(0.56, 0.64, p)));
      seatedShare = 1 - smooth(0.12, 0.28, p);
      this.hands(steeringWheel, 1 - smooth(0.1, 0.18, p), 1 - smooth(0, 0.06, p), deltaSeconds);
      this.pedals(1 - smooth(0.12, 0.25, p));
    }
    if (sideSign < 0) {
      this.mirrorMoves(out);
      // Across from the passenger's seat to the driver's (in) or back (out), and only there do the hands take the wheel.
      const across = getIn ? smooth(0.82, 0.96, p) : 1 - smooth(0.02, 0.14, p);
      place.z += -SEAT.passengerOffset * across * seatedShare;
      for (let limb = 0; limb < 4; limb += 1) this.seatWeights[limb] = this.seatWeights[limb]! * across;
    }
    this.mix();
    return place;
  }

  /** Both hands on the wheel at a quarter to three, following it as it turns, re-gripping past a third of a turn. */
  private hands(steeringWheel: number, leftWeight: number, rightWeight: number, deltaSeconds: number): void {
    const third = (2 * Math.PI) / 3;
    for (let hand = 0; hand < 2; hand += 1) {
      // Each hand slips back a third of a turn whenever the wheel has turned it half that far from its
      // grip, the hand on the side the wheel turns toward first (at 30 degrees, the other at 90), with a
      // margin either side so a wheel held at the threshold does not re-grip back and forth.
      const turns = (steeringWheel + (hand === 0 ? -1 : 1) * (third / 4)) / third;
      if (Math.abs(turns - this.shuffle[hand]!) > 0.5 + REGRIP_MARGIN) {
        const count = Math.round(turns);
        this.regrip[hand] = this.regrip[hand]! + (count - this.shuffle[hand]!) * third;
        this.shuffle[hand] = count;
      }
      this.regrip[hand] = this.regrip[hand]! * Math.max(0, 1 - deltaSeconds / 0.12);
      const clock = (hand === 0 ? -1 : 1) * (Math.PI / 2 + 0.15) + steeringWheel - this.shuffle[hand]! * third + this.regrip[hand]!;
      gripPoint(clock, this.seatTargets, hand * 3);
      this.seatWeights[hand] = hand === 0 ? leftWeight : rightWeight;
    }
    this.placement.gripping = Math.max(leftWeight, rightWeight);
  }

  private pedals(weight: number): void {
    setLimb(this.seatTargets, this.seatWeights, 2, SEAT.leftPedal[0], SEAT.leftPedal[1], SEAT.leftPedal[2], weight);
    setLimb(this.seatTargets, this.seatWeights, 3, SEAT.rightPedal[0], SEAT.rightPedal[1], SEAT.rightPedal[2], weight);
  }

  /** The moves' and the seat's targets together: a limb going from one to the other passes between them. */
  private mix(): void {
    const place = this.placement;
    for (let limb = 0; limb < 4; limb += 1) {
      const a = this.moveWeights[limb]!;
      const b = this.seatWeights[limb]!;
      const total = a + b;
      place.weights[limb] = Math.min(1, total);
      if (total <= 0) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        const i = limb * 3 + axis;
        place.targets[i] = (this.moveTargets[i]! * a + this.seatTargets[i]! * b) / total;
      }
    }
  }

  /** The left door: the right door's moves mirrored across the car's centre line. */
  private mirrorMoves(pose: Float64Array): void {
    const place = this.placement;
    mirrorChannels(pose, this.mirror);
    pose.set(this.mirror);
    place.z = mirrorZ(place.z);
    place.yaw = -place.yaw;
    const t = this.moveTargets;
    const w = this.moveWeights;
    for (const [a, b] of [[0, 1], [2, 3]] as const) {
      const ax = t[a * 3]!;
      const ay = t[a * 3 + 1]!;
      const az = t[a * 3 + 2]!;
      t[a * 3] = t[b * 3]!;
      t[a * 3 + 1] = t[b * 3 + 1]!;
      t[a * 3 + 2] = mirrorZ(t[b * 3 + 2]!);
      t[b * 3] = ax;
      t[b * 3 + 1] = ay;
      t[b * 3 + 2] = mirrorZ(az);
      const wa = w[a]!;
      w[a] = w[b]!;
      w[b] = wa;
    }
    const stance = place.stance[0];
    place.stance[0] = place.stance[1];
    place.stance[1] = stance;
  }
}

/** The seat frame's z mirrored across the car's centre line. */
function mirrorZ(z: number): number {
  return -z + SEAT.passengerOffset;
}

export interface BoardingFrom {
  readonly forward: number;
  readonly up: number;
  readonly right: number;
  readonly facing: number;
}

/** A point on the wheel's rim at a clock angle (radians clockwise from the top as the driver sees it), seat frame. */
export function gripPoint(clock: number, out: Float64Array, offset: number): void {
  const r = SEAT.wheelRadius;
  const up = r * Math.cos(clock);
  const right = r * Math.sin(clock);
  // The rim's plane leans its top forward by the column's rake.
  out[offset] = SEAT.wheelCentre[0] + up * Math.sin(SEAT.wheelTilt);
  out[offset + 1] = SEAT.wheelCentre[1] + up * Math.cos(SEAT.wheelTilt);
  out[offset + 2] = SEAT.wheelCentre[2] + right;
}

function setLimb(targets: Float64Array, weights: Float64Array, limb: number, x: number, y: number, z: number, weight: number): void {
  targets[limb * 3] = x;
  targets[limb * 3 + 1] = y;
  targets[limb * 3 + 2] = z;
  weights[limb] = weight;
}

function sampleKeys(keys: readonly Key[], p: number, place: SeatPlacement, pose: Float64Array): void {
  let a = keys[0]!;
  let b = a;
  let u = 0;
  if (p <= a[0]) {
    b = a;
  } else if (p >= keys[keys.length - 1]![0]) {
    a = keys[keys.length - 1]!;
    b = a;
  } else {
    for (let i = 0; i + 1 < keys.length; i += 1) {
      if (p <= keys[i + 1]![0]) {
        a = keys[i]!;
        b = keys[i + 1]!;
        u = (p - a[0]) / (b[0] - a[0]);
        break;
      }
    }
  }
  const s = u * u * (3 - 2 * u);
  place.x = a[1] + (b[1] - a[1]) * s;
  place.y = a[2] + (b[2] - a[2]) * s;
  place.z = a[3] + (b[3] - a[3]) * s;
  place.yaw = a[4] + (b[4] - a[4]) * s;
  mixChannels(a[5], b[5], s, pose);
}

function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
