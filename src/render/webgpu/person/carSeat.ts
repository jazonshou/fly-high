import { DOUBLE_ZERO } from "@/src/sim/ground/doubleZero";
import type { PersonBoardingState } from "@/src/game/types";
import { boardingDoorOpening, CAR_SEATING, PERSON } from "@/src/vehicles/person";
import { BODY, DOOR_LINES, FRONT_DOOR_HINGE, GLASSHOUSE, STEERING_WHEEL } from "../ground/lc76Lines";
import { both, CHANNEL_COUNT, channels, createChannels, mirrorChannels } from "./channels";
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
 * THE SEAT IS HIGH: its cushion stands 1.0 m above the ground, over a
 * standing man's crotch, and the door's opening is ahead of it, from the B
 * pillar beside the hip point forward. Nobody sits down into it backwards or
 * stands up on the step in the doorway (the door's top is 0.78 m over the hip
 * point, under a standing man's chin there). He climbs in facing forward and
 * slides out facing outward, ducking under the door's top both ways.
 *
 * GETTING IN (right door, right-hand drive; the left door is the mirror
 * image, sliding across the passenger seat): walk from where the walker
 * stood to the door stand, behind the door's trailing edge, the outer hand
 * out to the handle; pull the door open past him; a step in to the opening,
 * the outer hand to the door's pull inside; the inner foot up onto the side
 * step, the inner hand to the A-pillar's grab handle; up off the step,
 * leaning in under the door's top, the outer leg trailing; the inner leg into
 * the footwell and down onto the seat, the outer leg after it, the outer hand
 * drawing the door shut as he sits; both hands to the wheel. GETTING OUT: the
 * outer hand pushes the door open; he turns out on the seat and swings the
 * outer leg onto the step; slides forward off the cushion and out under the
 * door's top, the inner hand on the grab handle; the inner foot down to the
 * ground, then the outer off the step; two steps clear to
 * `CAR_SEATING.doorStand`, the inner hand swinging the door shut behind him;
 * he ends facing away from the car.
 *
 * THE PELVIS'S PATH and the pose run on ONE curve through the keys (a
 * Catmull-Rom spline in the progress): its speed carries through every key
 * but the ones the body truly rests at, so the move reads as one motion and
 * not a pose-to-pose march.
 *
 * The door's swing is `doorOpenAt` (`boardingDoorOpening`), the one the
 * figure's hands, the sim and the car's hinged door read. ESTIMATES: the
 * poses, the timings, the door's full opening (`DOOR_OPEN_RADIANS`), the
 * pedals' places.
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
  /**
   * The right side step's top where a foot stands on it (z mirrored for the
   * left): on its outer half, clear of the sill over its inner one.
   */
  step: seatPoint(0.05, 0.5, 0.94),
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

/** How far open the boarding door is (0 shut .. 1 open) at a boarding progress (`boardingDoorOpening`). */
export function doorOpenAt(action: PersonBoardingState["action"], progress: number, walkShare = 0): number {
  return boardingDoorOpening(action, progress, walkShare);
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

/** The limbs' slots in the targets and weights. */
const LEFT_HAND = 0;
const RIGHT_HAND = 1;
const LEFT_FOOT = 2;
const RIGHT_FOOT = 3;

// --- Key poses (channels), right door: the left side is the inner one, toward the car. ----------

export const SEATED = channels({
  ...both({ hipFlex: 84, hipAbd: 7, hipRot: -6, knee: 78, ankle: 12, shFlex: 52, shAbd: 10, shRot: 10, elbow: 38, clavProt: 25, foreTwist: 40, fingers: 62, thumb: 30, wristFlex: -10 }),
  pelvisTilt: -12,
  spineFlex: 36,
  neckFlex: -18,
  headFlex: -6,
});
const GRIP = { fingers: 55, thumb: 28 } as const;
/** At the door, an arm out to its handle, the weight a little back as it swings open. */
const AT_DOOR = channels({ ...both({ shAbd: -4, elbow: 14, fingers: 28, thumb: 15, knee: 4, kneeRot: -6 }), spineFlex: 7, spineTurn: -6, neckFlex: 5 });
const DOOR_OPEN = channels({ ...both({ shAbd: -4, elbow: 16, fingers: 30, thumb: 15, knee: 3, kneeRot: -6 }), spineFlex: 2, neckFlex: 3 });
/** A step in to the opening, the hands going up. */
const STEP_IN = channels({ ...both({ shFlex: 18, elbow: 30, knee: 14, hipFlex: 6, ankle: 7, kneeRot: -6, ...GRIP }), spineFlex: 6, neckFlex: -2 });
/** The inner foot up on the side step, the weight going onto it. */
const FOOT_UP = channels({
  ...both({ shFlex: 30, elbow: 40, ...GRIP }),
  hipFlexL: 76, kneeL: 98, ankleL: 8, hipAbdL: 8, hipFlexR: -4, kneeR: 6, pelvisTilt: 6, spineFlex: 18, neckFlex: -8,
});
/** Up off the step: the inner leg straightening under him, the outer one off the ground, the trunk in under the door's top. */
const HOIST = channels({
  ...both({ shFlex: 35, elbow: 55, ...GRIP }),
  hipFlexL: 66, kneeL: 76, ankleL: 12, hipAbdL: 6, hipFlexR: 8, kneeR: 46, ankleR: -28, hipAbdR: 6, pelvisTilt: 10, spineFlex: 32, neckFlex: -14,
});
/** In the doorway over the seat's corner, the inner leg going to the footwell, the outer knee coming up. */
const DUCK_IN = channels({
  ...both({ shFlex: 38, elbow: 55, ...GRIP }),
  hipFlexL: 70, kneeL: 66, ankleL: 6, hipAbdL: 4, hipFlexR: 40, kneeR: 84, ankleR: -16, hipAbdR: 14, pelvisTilt: 6, spineFlex: 36, neckFlex: -16, headFlex: -4,
});
/** Down onto the cushion, the outer leg coming in over the sill. */
const SIT_IN = channels({
  ...both({ shFlex: 42, elbow: 45, ...GRIP }),
  hipFlexL: 84, kneeL: 82, ankleL: 10, hipAbdL: 6, hipFlexR: 80, kneeR: 100, ankleR: 2, hipAbdR: 22, hipRotR: -10, pelvisTilt: -6, spineFlex: 34, neckFlex: -17, headFlex: -5,
});

/** Turned out on the seat, looking out of the door, the outer leg swinging over the sill. */
const TURN_OUT = channels({
  ...both({ shFlex: 42, elbow: 45, ...GRIP }),
  hipFlexL: 84, kneeL: 80, ankleL: 10, hipAbdL: 2, hipFlexR: 82, kneeR: 76, ankleR: 4, hipAbdR: 26, hipRotR: -14,
  pelvisTilt: -8, spineFlex: 38, spineTurn: 14, neckFlex: -8, neckTurn: 16, headTurn: 10,
});
/** On the cushion's edge, the outer foot on the step, leaning out under the door's top. */
const EDGE = channels({
  ...both({ shFlex: 36, elbow: 45, ...GRIP }),
  hipFlexL: 82, kneeL: 92, ankleL: 0, hipAbdL: 8, hipFlexR: 74, kneeR: 98, ankleR: 8, hipAbdR: 12,
  pelvisTilt: 2, spineFlex: 40, spineTurn: 8, neckFlex: -6, neckTurn: 8,
});
/** Off the cushion, the weight on the step, the inner leg reaching down for the ground. */
const STEP_DOWN = channels({
  ...both({ shFlex: 30, elbow: 40, ...GRIP }),
  hipFlexL: 42, kneeL: 22, ankleL: -28, hipAbdL: 4, hipFlexR: 80, kneeR: 108, ankleR: 14, hipAbdR: 8, pelvisTilt: 8, spineFlex: 30, neckFlex: -8,
});
/** The inner foot on the ground taking the weight, the outer coming off the step. */
const TOUCH_DOWN = channels({
  ...both({ shFlex: 14, elbow: 30, fingers: 40, thumb: 20 }),
  hipFlexL: 20, kneeL: 12, ankleL: -4, hipFlexR: 50, kneeR: 84, ankleR: -10, hipAbdR: 8, pelvisTilt: 4, spineFlex: 16, neckFlex: -6,
});
/** Both feet down, the knees still soft. */
const ON_GROUND = channels({ ...both({ shAbd: -3, elbow: 18, fingers: 30, thumb: 15, hipFlex: 8, knee: 14, ankle: 6, kneeRot: -6 }), spineFlex: 6 });

/**
 * A key: the progress, the pelvis's place, the body's turn to the right, the
 * pose, and whether the body rests there (the curve's speed is zero at a
 * rest, and carries through every other key).
 */
type Key = readonly [p: number, x: number, y: number, z: number, yaw: number, pose: Float64Array, rest?: boolean];

const STAND_HIP = SEAT.ground + PROPORTIONS.hipHeight;
const DOOR = SEAT.doorStand;
const STEP = SEAT.step;
/** The facing at the door stand getting in: forward along the car and in toward it. */
const AT_DOOR_YAW = -0.5;

/** Where the hips are a step in to the opening, and the body's turn there. */
const STEP_IN_AT = Object.freeze([0.12, 0.9, -0.42] as const);
/** Where the outer foot's ankle comes down on that step: under its hip there (0.09 m out from the pelvis) and 0.06 m on, the way he faces. */
const STEP_IN_FOOT = Object.freeze([
  STEP_IN_AT[0] - 0.09 * Math.sin(STEP_IN_AT[2]) + 0.06 * Math.cos(STEP_IN_AT[2]),
  STEP_IN_AT[1] + 0.09 * Math.cos(STEP_IN_AT[2]) + 0.06 * Math.sin(STEP_IN_AT[2]),
] as const);

/**
 * Getting in from the door stand, over the progress left after the walk to
 * it (0 at the stand .. 1 seated).
 */
const GET_IN: readonly Key[] = [
  [0, DOOR[0], STAND_HIP, DOOR[2], AT_DOOR_YAW, AT_DOOR, true],
  // (He stands until the door has swung past him and his feet are together under him.)
  [0.13, DOOR[0] - 0.01, STAND_HIP, DOOR[2] + 0.01, -0.46, DOOR_OPEN],
  // In to the opening, between the open door and the B pillar: one step, the outer foot leading.
  [0.27, STEP_IN_AT[0], STAND_HIP - 0.025, STEP_IN_AT[1], STEP_IN_AT[2], STEP_IN],
  [0.38, 0.2, STAND_HIP - 0.025, 0.82, -0.38, FOOT_UP],
  // The hips stay ahead of the B pillar (x 0.025) until they are inboard of the door's skin.
  [0.49, 0.32, -0.07, 0.62, -0.3, HOIST],
  [0.6, 0.3, 0.01, 0.4, -0.16, DUCK_IN],
  [0.71, 0.1, 0.01, 0.14, -0.05, SIT_IN],
  [0.84, 0, 0, 0, 0, SEATED, true],
  [1, 0, 0, 0, 0, SEATED, true],
];

const GET_OUT: readonly Key[] = [
  [0, 0, 0, 0, 0, SEATED, true],
  [0.1, 0, 0, 0.02, 0.08, SEATED],
  [0.26, 0.05, 0, 0.12, 0.45, TURN_OUT],
  [0.4, 0.18, -0.01, 0.36, 0.9, EDGE],
  // Out past the B pillar (x 0.025) with the hips square to it, then back clear of the door's swing.
  [0.52, 0.22, -0.06, 0.62, 1.15, STEP_DOWN],
  [0.62, 0.12, STAND_HIP - 0.04, 0.88, 1.35, TOUCH_DOWN],
  [0.73, 0, STAND_HIP - 0.01, 1.01, 1.47, ON_GROUND],
  [0.87, DOOR[0], STAND_HIP, DOOR[2], Math.PI / 2, STAND, true],
  [1, DOOR[0], STAND_HIP, DOOR[2], Math.PI / 2, STAND, true],
];

/** The keys of a move and, per key, the curve's slope weight there: 0 at a rest, else 1 over the span from the key before to the key after. */
interface Track {
  readonly keys: readonly Key[];
  readonly slope: readonly number[];
}

function track(keys: readonly Key[]): Track {
  const slope = keys.map((key, i) => (i === 0 || i === keys.length - 1 || key[6] ? 0 : 1 / (keys[i + 1]![0] - keys[i - 1]![0])));
  return { keys, slope: Object.freeze(slope) };
}

const GET_IN_TRACK = track(GET_IN);
const GET_OUT_TRACK = track(GET_OUT);

/** Past a re-grip's threshold by this share of a third of a turn before the hand lets go. */
const REGRIP_MARGIN = 0.05;
/** A foot going between two of its places lifts this far over the straight line between them. */
const FOOT_ARC = 0.05;
/** The inner foot's way up to the step from the ground: its aim starts this far over the step and comes down onto it (a quarter of it over the straight line, midway). */
const STEP_UP_ARC = 0.3;
/** Where a foot passes over the door's sill between the footwell and the outside: clear of the floor's edge, inside the door's skin. */
const SILL: readonly [number, number, number] = Object.freeze([0.48, SEAT.floor + 0.17, 0.45]) as unknown as readonly [number, number, number];

export interface SeatPlacement {
  /** The pelvis's place and the body's turn to the right, in the seat frame. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Getting in, walking to the door: the walk's speed m/s (the gait plays), else 0. */
  walkSpeed: number;
  /**
   * How much of the gait the body plays at that speed, 0..1: all of it on
   * the way, none as he arrives (the rest is the pose he stands at the door
   * in, which he comes into over the walk's last steps).
   */
  gait: number;
  /** 0..1: how much the feet stand on the ground (the foot planter's weight). */
  ground: number;
  /** Each foot asked to stand on the ground, left then right. */
  stance: [boolean, boolean];
  /** A foot to step as the body moves off, once the other is down, and where its ankle comes down, seat frame (the foot planter's `step`): 0 left, 1 right, -1 none. */
  step: -1 | 0 | 1;
  stepX: number;
  stepZ: number;
  /** Limb targets, seat frame, and their weights: left hand, right hand, left foot, right foot. */
  readonly targets: Float64Array;
  readonly weights: Float64Array;
}

export interface BoardingFrom {
  readonly forward: number;
  readonly up: number;
  readonly right: number;
  readonly facing: number;
  /** The walker's velocity as the boarding began, m/s along the car's forward and right: the walk to the door carries on from it. */
  readonly velocityForward?: number;
  readonly velocityRight?: number;
}

/**
 * The seated driver and getting in and out, as the figure's motion reads
 * them each frame: channels, the pelvis's placement and the limbs' targets.
 */
export class CarSeatMotion {
  readonly placement: SeatPlacement = {
    x: DOUBLE_ZERO,
    y: DOUBLE_ZERO,
    z: DOUBLE_ZERO,
    yaw: DOUBLE_ZERO,
    walkSpeed: DOUBLE_ZERO,
    gait: DOUBLE_ZERO,
    ground: DOUBLE_ZERO,
    stance: [true, true],
    step: -1,
    stepX: DOUBLE_ZERO,
    stepZ: DOUBLE_ZERO,
    targets: new Float64Array(12),
    weights: new Float64Array(4),
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
    place.gait = 0;
    place.step = -1;
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
      this.pedals(1, 1);
      this.mix();
      return place;
    }
    const sideSign = boarding.side === "right" ? 1 : -1;
    const p = Math.min(1, Math.max(0, boarding.progress));
    const getIn = boarding.action === "getIn";
    // Getting in: the walk to the door stand takes `walk` of the progress, the getting in itself the rest (`q`).
    const walk = getIn ? Math.min(0.9, Math.max(0, boarding.walkShare ?? 0)) : 0;
    const q = getIn ? Math.max(0, (p - walk) / (1 - walk)) : p;
    // Everything is drawn for the right door; the left door's is its mirror image (below).
    sampleTrack(getIn ? GET_IN_TRACK : GET_OUT_TRACK, q, place, out);
    const walking = getIn && p < walk;
    if (walking) walkToDoor(p / walk, walk * (boardingSeconds(walk)), from, sideSign, place);
    const door = doorOpening ?? doorOpenAt(boarding.action, p, walk);
    let seatedShare: number;
    if (getIn) {
      // Both feet on the ground to the door, and the outer one a step in to the opening as the door swings clear;
      // then the inner one up onto the step, and the outer off the ground as he rises.
      // (The feet keep the planter's hold until both are off the ground and into the pose's own places.)
      place.ground = 1 - smooth(0.54, 0.6, q);
      place.stance[0] = q < 0.26;
      place.stance[1] = q < 0.4;
      if (q > 0.115 && q < 0.2) {
        place.step = 1;
        place.stepX = STEP_IN_FOOT[0];
        place.stepZ = STEP_IN_FOOT[1];
      }
      // The inner foot up off the ground and down onto the step from over it, then over the sill to its pedal;
      // the outer one after it.
      const up = smooth(0.26, 0.41, q);
      lerpLimb(mt, LEFT_FOOT, STEP[0], STEP[1] + PROPORTIONS.ankleHeight + STEP_UP_ARC * (1 - up), STEP[2], SILL[0], SILL[1], SILL[2], smooth(0.55, 0.65, q));
      mw[LEFT_FOOT] = up * (1 - smooth(0.63, 0.75, q));
      setLimb(mt, mw, RIGHT_FOOT, SILL[0] - 0.05, SILL[1], SILL[2] + 0.04, smooth(0.55, 0.67, q) * (1 - smooth(0.69, 0.81, q)));
      // The outer hand goes out to the door's handle as he comes up to it, pulls it open and lets it swing on,
      // then holds its pull inside from the step in until it has drawn the door shut.
      const reach = walking ? smooth(0.5, 0.95, p / walk) : 1 - smooth(0.08, 0.2, q);
      const hold = smooth(0.2, 0.34, q) * (1 - smooth(0.86, 0.98, q));
      if (q < 0.2) doorPoint(door, DOOR_LENGTH - 0.12, 1.12, 0.05, mt, RIGHT_HAND);
      else doorPoint(door, DOOR_LENGTH - 0.45, 1.02, -0.08, mt, RIGHT_HAND);
      mw[RIGHT_HAND] = Math.max(reach, hold);
      // The inner hand takes the pillar's handle as the body comes within its reach.
      setLimb(mt, mw, LEFT_HAND, SEAT.pillarHandle[0], SEAT.pillarHandle[1], SEAT.pillarHandle[2], smooth(0.27, 0.45, q) * (1 - smooth(0.66, 0.82, q)));
      seatedShare = smooth(0.71, 0.84, q);
      // Each hand goes straight from its hold to the wheel (the two weights cross).
      this.hands(steeringWheel, smooth(0.66, 0.82, q), smooth(0.86, 0.98, q), deltaSeconds);
      this.pedals(smooth(0.61, 0.79, q), smooth(0.69, 0.87, q));
    } else {
      // The inner foot reaches the ground as the hips come down off the sill, then the outer one off the step.
      place.ground = smooth(0.56, 0.63, p);
      place.stance[0] = p > 0.6;
      place.stance[1] = p > 0.72;
      // The outer foot off its pedal, over the sill and onto the step. Facing out, the outer leg is the one toward
      // the car's tail: its foot goes on the step behind the inner one's line.
      lerpLimb(mt, RIGHT_FOOT, SILL[0] - 0.05, SILL[1], SILL[2] - 0.05, STEP[0] - 0.25, STEP[1] + PROPORTIONS.ankleHeight, STEP[2], smooth(0.22, 0.34, p));
      mw[RIGHT_FOOT] = smooth(0.1, 0.22, p) * (1 - smooth(0.58, 0.72, p));
      // The inner foot over the sill after it, then down for the ground.
      setLimb(mt, mw, LEFT_FOOT, SILL[0], SILL[1], SILL[2], smooth(0.22, 0.34, p) * (1 - smooth(0.36, 0.46, p)));
      // The outer hand pushes the door open by its pull and steadies him on it down to the ground.
      // (From the driver's seat to the far door he reaches for it as he slides across, not at arm's length at once.)
      doorPoint(door, DOOR_LENGTH - 0.45, 1.02, -0.08, mt, RIGHT_HAND);
      mw[RIGHT_HAND] = (sideSign < 0 ? smooth(0.04, 0.22, p) : smooth(0.02, 0.09, p)) * (1 - smooth(0.48, 0.66, p));
      // The inner hand takes the pillar's handle, then goes across to the door's edge and swings it shut behind him.
      doorPoint(door, DOOR_LENGTH - 0.15, 1.15, 0.06, mt, LEFT_HAND);
      lerpLimb(
        mt, LEFT_HAND, SEAT.pillarHandle[0], SEAT.pillarHandle[1], SEAT.pillarHandle[2],
        mt[LEFT_HAND * 3]!, mt[LEFT_HAND * 3 + 1]!, mt[LEFT_HAND * 3 + 2]!, smooth(0.54, 0.72, p),
      );
      mw[LEFT_HAND] = smooth(0.26, 0.42, p) * (1 - smooth(0.86, 0.95, p));
      seatedShare = 1 - smooth(0.1, 0.26, p);
      this.hands(steeringWheel, 1 - smooth(0.18, 0.3, p), 1 - smooth(0, 0.07, p), deltaSeconds);
      this.pedals(1 - smooth(0.2, 0.34, p), 1 - smooth(0.1, 0.22, p));
    }
    if (sideSign < 0) {
      this.mirrorMoves(out);
      // Across from the passenger's seat to the driver's (in) or back (out), and only there do the hands take the wheel.
      const across = getIn ? smooth(0.76, 0.99, q) : 1 - smooth(0, 0.2, p);
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
  }

  private pedals(leftWeight: number, rightWeight: number): void {
    setLimb(this.seatTargets, this.seatWeights, LEFT_FOOT, SEAT.leftPedal[0], SEAT.leftPedal[1], SEAT.leftPedal[2], leftWeight);
    setLimb(this.seatTargets, this.seatWeights, RIGHT_FOOT, SEAT.rightPedal[0], SEAT.rightPedal[1], SEAT.rightPedal[2], rightWeight);
  }

  /**
   * The moves' and the seat's targets together: a limb going from one to the
   * other passes between them, a foot lifted over the sill on the way.
   */
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
      if (limb >= LEFT_FOOT) place.targets[limb * 3 + 1] = place.targets[limb * 3 + 1]! + (FOOT_ARC * 4 * a * b) / (total * total);
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
    if (place.step >= 0) {
      place.step = place.step === 0 ? 1 : 0;
      place.stepZ = mirrorZ(place.stepZ);
    }
  }
}

/** The seat frame's z mirrored across the car's centre line. */
function mirrorZ(z: number): number {
  return -z + SEAT.passengerOffset;
}

/**
 * Getting in, the walk from where the walker stood to the door stand, `t`
 * 0..1 through its `seconds`, for the right door (the left door's start
 * mirrored): the pelvis's place carries on from the walker's own velocity
 * and comes to rest at the stand; he turns to walk there when it is more
 * than a step away, then to face the door; the gait plays at the speed he
 * makes along his facing, and a shorter move is shuffled on standing feet.
 */
function walkToDoor(t: number, seconds: number, from: BoardingFrom | null, sideSign: number, place: SeatPlacement): void {
  const x0 = from ? from.forward : DOOR[0];
  const z0 = from ? (sideSign > 0 ? from.right : mirrorZ(from.right)) : DOOR[2];
  const facing = from ? from.facing * sideSign : AT_DOOR_YAW;
  const up = from ? from.up - SEAT.ground : 0;
  const dx = DOOR[0] - x0;
  const dz = DOOR[2] - z0;
  const distance = Math.hypot(dx, dz);
  // The start's velocity as travel over the whole walk, no more than a curve that still ends at the stand can carry.
  let vx = (from?.velocityForward ?? 0) * seconds;
  let vz = (from?.velocityRight ?? 0) * sideSign * seconds;
  const most = 2.5 * distance;
  const carried = Math.hypot(vx, vz);
  if (carried > most) {
    vx *= most / carried;
    vz *= most / carried;
  }
  const h01 = t * t * (3 - 2 * t);
  const h10 = t * (1 - t) * (1 - t);
  place.x = x0 + dx * h01 + vx * h10;
  place.z = z0 + dz * h01 + vz * h10;
  place.y = STAND_HIP + up * (1 - h01);
  // Its speed along the path, m/s.
  const d01 = 6 * t * (1 - t);
  const d10 = (1 - t) * (1 - 3 * t);
  const sx = (dx * d01 + vx * d10) / seconds;
  const sz = (dz * d01 + vz * d10) / seconds;
  const speed = Math.hypot(sx, sz);
  // He turns to walk to a stand more than a step away, unless it is behind him (then he backs and turns to it).
  const toTravel = distance > 1e-3 ? angleDelta(facing, Math.atan2(dz, dx)) : 0;
  const walks = smooth(0.3, 0.7, distance) * (1 - smooth(1.8, 2.6, Math.abs(toTravel)));
  const along = facing + toTravel * walks * smooth(0, 0.4, t);
  place.yaw = along + angleDelta(along, AT_DOOR_YAW) * smooth(0.55 * walks, 1, t);
  const heading = speed > 1e-3 ? Math.atan2(sz, sx) : place.yaw;
  place.walkSpeed = speed * walks * Math.max(0, Math.cos(place.yaw - heading));
  place.gait = walks * (1 - smooth(0.55, 1, t));
}

/** The seconds a whole getting-in takes whose walk is `walkShare` of it. */
function boardingSeconds(walkShare: number): number {
  return PERSON.getInSeconds / (1 - walkShare);
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

/** Limb `limb`'s target `s` of the way from (ax, ay, az) to (bx, by, bz). */
function lerpLimb(targets: Float64Array, limb: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, s: number): void {
  targets[limb * 3] = ax + (bx - ax) * s;
  targets[limb * 3 + 1] = ay + (by - ay) * s;
  targets[limb * 3 + 2] = az + (bz - az) * s;
}

function setLimb(targets: Float64Array, weights: Float64Array, limb: number, x: number, y: number, z: number, weight: number): void {
  targets[limb * 3] = x;
  targets[limb * 3 + 1] = y;
  targets[limb * 3 + 2] = z;
  weights[limb] = weight;
}

/**
 * A track at progress `p`: the pelvis's place, the turn and the pose on the
 * cubic through the keys either side of it (Hermite, each key's slope the
 * chord between its neighbours, zero at a rest), held before the first key
 * and after the last. The curve is a weighted sum of four keys, so the pose
 * blends as plain numbers with no scratch array.
 */
function sampleTrack(track: Track, p: number, place: SeatPlacement, pose: Float64Array): void {
  const keys = track.keys;
  const last = keys.length - 1;
  let i = 0;
  while (i + 1 < last && p > keys[i + 1]![0]) i += 1;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const span = b[0] - a[0];
  const u = Math.min(1, Math.max(0, (p - a[0]) / span));
  const u2 = u * u;
  const u3 = u2 * u;
  const ka = (u3 - 2 * u2 + u) * span * track.slope[i]!;
  const kb = (u3 - u2) * span * track.slope[i + 1]!;
  const w0 = -ka;
  const w1 = 2 * u3 - 3 * u2 + 1 - kb;
  const w2 = -2 * u3 + 3 * u2 + ka;
  const w3 = kb;
  const before = keys[Math.max(0, i - 1)]!;
  const after = keys[Math.min(last, i + 2)]!;
  place.x = w0 * before[1] + w1 * a[1] + w2 * b[1] + w3 * after[1];
  place.y = w0 * before[2] + w1 * a[2] + w2 * b[2] + w3 * after[2];
  place.z = w0 * before[3] + w1 * a[3] + w2 * b[3] + w3 * after[3];
  place.yaw = w0 * before[4] + w1 * a[4] + w2 * b[4] + w3 * after[4];
  const p0 = before[5];
  const p1 = a[5];
  const p2 = b[5];
  const p3 = after[5];
  for (let c = 0; c < CHANNEL_COUNT; c += 1) pose[c] = w0 * p0[c]! + w1 * p1[c]! + w2 * p2[c]! + w3 * p3[c]!;
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
