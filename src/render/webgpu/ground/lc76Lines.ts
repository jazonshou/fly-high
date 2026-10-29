import { LC76_GEOMETRY } from "@/src/vehicles/landcruiser76";

/**
 * The LandCruiser 76 GXL wagon's drawn lines: where every part of the drawn
 * car sits, in the BODY FRAME the sim reports its pose in (+X forward, +Y up,
 * +Z right, origin at the centre of gravity).
 *
 * The running gear's numbers are the physics record's (`LC76_GEOMETRY`), so
 * the drawn wheels stand where the simulated ones do. The published envelope
 * (Toyota Australia, 2024 GXL wagon) is 4,910 mm long, 1,870 mm wide over the
 * flares and 1,940 mm tall, with 33 and 23 degree approach and departure
 * angles; the bumpers, sills and tank sit where the record's collision hull
 * probes them. Everything else (the bonnet's height, the belt line, where
 * the pillars stand) is read from photographs of the car against those
 * numbers.
 *
 * `h(...)` is a height above flat ground, the way a drawing of the car is
 * dimensioned; the drawn parts use `y = GROUND_Y + h`.
 */

export const LC76_WHEELBASE = LC76_GEOMETRY.wheelbase;
export const LC76_FRONT_AXLE_X = LC76_GEOMETRY.frontAxleX;
export const LC76_REAR_AXLE_X = LC76_GEOMETRY.rearAxleX;
export const LC76_FRONT_TRACK = LC76_GEOMETRY.frontTrack;
export const LC76_REAR_TRACK = LC76_GEOMETRY.rearTrack;
/** The centre of gravity above flat ground at kerb ride. */
export const LC76_CG_HEIGHT = LC76_GEOMETRY.cgHeight;
export const GROUND_Y = -LC76_CG_HEIGHT;
/** 265/70R16: a 777 mm tyre, 0.37 m loaded under the car's weight. */
export const LC76_TYRE_FREE_RADIUS = LC76_GEOMETRY.freeTyreRadius;
export const LC76_TYRE_LOADED_RADIUS = LC76_GEOMETRY.loadedTyreRadius;
export const LC76_TYRE_WIDTH = LC76_GEOMETRY.tyreWidth;
/** The steel rim: 16 inches across the bead seat, 7 inches wide. */
export const LC76_RIM_RADIUS = 0.2032;
export const LC76_RIM_WIDTH = 0.178;
/** The wheel centres' height with no axle travel. */
export const LC76_WHEEL_CENTRE_Y = LC76_GEOMETRY.wheelCentreY;
export const LC76_BUMP_TRAVEL = LC76_GEOMETRY.bumpTravel;
export const LC76_DROOP_TRAVEL = LC76_GEOMETRY.droopTravel;

/** A height above flat ground in the body frame. */
export function h(heightAboveGround: number): number {
  return GROUND_Y + heightAboveGround;
}

/** The body's overall stations: bumper faces and the body's own front and rear faces. */
export const BODY = Object.freeze({
  /** The front bumper's face: 0.88 m of front overhang (the physics record's). */
  bumperFront: LC76_FRONT_AXLE_X + 0.88,
  /** The grille and the guards' fronts. */
  front: LC76_FRONT_AXLE_X + 0.8,
  /** The rear barn doors. */
  rear: LC76_REAR_AXLE_X - 1.245,
  /** The rear bumper's face, and the tow hitch's: 4,910 mm overall. */
  bumperRear: LC76_REAR_AXLE_X - 1.265,
  towHitch: LC76_REAR_AXLE_X - 1.3,
  /** Half the body's width at its sides; the flares stand out to 935 mm. */
  halfWidth: 0.885,
  flareHalfWidth: 0.935,
  /** The guards' and bonnet's tops, at the front and at the cowl. */
  bonnetFront: 1.19,
  bonnetCowl: 1.235,
  /** The cowl: where the windscreen meets the bonnet. */
  cowlX: LC76_FRONT_AXLE_X - 0.47,
  /** The belt line under the side glass. */
  belt: 1.3,
  /** The roof's top, 1,940 mm overall. */
  roof: 1.935,
  /** The sills between the wheels, and the body's bottom ahead and behind them. */
  sill: 0.5,
  frontBottom: 0.63,
  rearBottom: 0.62,
});

/** The steel bumpers' heights above the ground, bottom and top (the hull's bumper probes). */
export const BUMPERS = Object.freeze({
  frontBottom: 0.49,
  frontTop: 0.75,
  rearBottom: 0.54,
  rearTop: 0.68,
});

/**
 * The glasshouse: a frustum on the belt, raked at the windscreen, with a
 * little tumblehome. Its foot stands 45 mm in from the flanks, on the doors'
 * rolled tops, as the 76's side glass does.
 */
export const GLASSHOUSE = Object.freeze({
  /** The windscreen's foot and head stations. */
  screenFootX: BODY.cowlX - 0.02,
  screenHeadX: BODY.cowlX - 0.29,
  /** The rear doors' stations: flush with the tail at the belt, one skin as the barn doors are, leaning in above it. */
  rearFootX: BODY.rear,
  rearHeadX: BODY.rear + 0.045,
  footHalfWidth: 0.84,
  headHalfWidth: 0.778,
  /** The gutter's top, just under the roof's crown. */
  head: 1.905,
});

/**
 * Wheel arches: a squared-off opening over each wheel (a superellipse of
 * `exponent` about the wheel centre at rest), its black flare standing proud
 * of the body. The opening clears the tyre at full bump.
 */
export const ARCH = Object.freeze({
  halfWidth: 0.56,
  height: 0.54,
  exponent: 3,
  flareWidth: 0.085,
});

/** The side glass's openings along the body (x from, x to), between the belt and the head. */
export const SIDE_WINDOWS = Object.freeze([
  Object.freeze({ name: "front-door", front: GLASSHOUSE.screenFootX - 0.07, rear: -0.33 }),
  Object.freeze({ name: "rear-door", front: -0.42, rear: -1.27 }),
  Object.freeze({ name: "quarter", front: -1.36, rear: BODY.rear + 0.1 }),
]);
/** The side glass's bottom and top edges above the ground. */
export const SIDE_WINDOW_BOTTOM = BODY.belt + 0.035;
export const SIDE_WINDOW_TOP = GLASSHOUSE.head - 0.07;

/** The door shut lines on the body's side, stations along x. */
export const DOOR_LINES = Object.freeze({
  frontDoorFront: BODY.cowlX - 0.02,
  frontDoorRear: -0.375,
  rearDoorRear: -1.315,
});

/** Where the side slabs meet the centre body, z: the bonnet's shut lines along the guards, and the barn doors' outer edges. */
export const SHELL_SPLIT_Z = BODY.halfWidth - 0.1;
/** The 60/40 split between the barn doors, z: from the doors' foot up through the windows' mullion to the gutter. */
export const REAR_DOOR_SPLIT_Z = -0.17;

/** The headlamps: round 7-inch LED units at the grille's ends. */
export const HEADLAMP = Object.freeze({
  halfSpacing: 0.64,
  height: 1.005,
  radius: 0.088,
});

/** The grille insert between the headlamps: its mesh and the TOYOTA letters' height. */
export const GRILLE_INSERT = Object.freeze({ halfWidth: 0.47, bottom: 0.91, top: 1.096, letters: 0.06 });

/** The tail lamp clusters at the rear corners, above the bumper, in black housings; the lenses stand `proud` of the body. */
export const TAIL_LAMP = Object.freeze({
  outer: BODY.halfWidth - 0.016,
  inner: BODY.halfWidth - 0.13,
  bottom: 0.7,
  top: 1.05,
  proud: 0.012,
});

/** The round fog lamps in the front bumper's face. */
export const FOG_LAMP = Object.freeze({ halfSpacing: 0.6, height: 0.667, radius: 0.034 });

/** The snorkel's air intake, on the right (driver's) A-pillar. */
export const SNORKEL = Object.freeze({
  radius: 0.046,
  /** Its path from the guard up the pillar to the ram head, body frame x, height, z. */
  path: Object.freeze([
    Object.freeze([BODY.cowlX + 0.12, 1.05, BODY.halfWidth + 0.02]),
    Object.freeze([BODY.cowlX + 0.08, 1.2, BODY.halfWidth + 0.055]),
    Object.freeze([BODY.cowlX - 0.0, 1.36, GLASSHOUSE.footHalfWidth + 0.058]),
    Object.freeze([BODY.cowlX - 0.22, 1.8, GLASSHOUSE.headHalfWidth + 0.095]),
    Object.freeze([BODY.cowlX - 0.245, 1.93, GLASSHOUSE.headHalfWidth + 0.09]),
  ] as const),
});

/** The door mirrors, on arms from the front doors' leading corners. */
export const MIRROR = Object.freeze({
  armX: GLASSHOUSE.screenFootX - 0.06,
  armHeight: BODY.belt + 0.05,
  headX: GLASSHOUSE.screenFootX - 0.1,
  headHeight: BODY.belt + 0.17,
  headOuter: 1.07,
  headInner: 0.9,
  headHalfHeight: 0.105,
  depth: 0.07,
});

/**
 * The driver's eye, right-hand drive: over the right front seat, about 0.2 m
 * lower than a seated driver's. The cockpit camera looks level along the body,
 * and from the true eye height the gauges and the wheel fall below its lens;
 * from here they sit along the frame's foot with the bonnet above them.
 */
export const DRIVER_EYE = Object.freeze({ x: -0.36, height: 1.5, z: 0.37 });

/** The steering wheel: a 380 mm rim before the driver, tilted back from upright. */
export const STEERING_WHEEL = Object.freeze({
  x: 0.17,
  height: 1.2,
  z: DRIVER_EYE.z,
  radius: 0.19,
  /** The column's tilt from vertical, back toward the driver. */
  tiltRadians: (24 * Math.PI) / 180,
});
