import { polygonSurface, Surface, type Vec3Tuple } from "../boat/boatMeshData";
import { finishUv, grilleUv, sideUv, type CarFinish } from "./carAtlas";
import {
  arc,
  bar,
  box,
  clipOutline,
  cross3,
  insetOutline,
  disc,
  normalize3,
  prismX,
  prismY,
  prismZ,
  quad,
  resampleOutline,
  revealBand,
  latheX,
  ring,
  roundedBox,
  roundedPrismX,
  roundedPrismY,
  roundedPrismZ,
  roundedRect,
  sweep,
  tube,
  type Point2,
  type UvFor,
} from "./carShapes";
import {
  ARCH,
  BODY,
  BUMPERS,
  DOOR_LINES,
  FOG_LAMP,
  GLASSHOUSE,
  GRILLE_INSERT,
  GROUND_Y,
  h,
  HEADLAMP,
  LC76_FRONT_AXLE_X,
  LC76_REAR_AXLE_X,
  LC76_REAR_TRACK,
  LC76_TYRE_LOADED_RADIUS,
  MIRROR,
  SIDE_WINDOW_BOTTOM,
  SIDE_WINDOW_TOP,
  SIDE_WINDOWS,
  SNORKEL,
  TAIL_LAMP,
} from "./lc76Lines";

/**
 * The LandCruiser 76's body, drawn: the steel shell, the glasshouse and its
 * glass, bumpers, flares, steps, mirrors, snorkel and what hangs under the
 * floor, as `Surface` smoothing groups in the body frame (+X forward, +Y up,
 * +Z right). Parts of one side are built on the right (+Z) and mirrored.
 *
 * THE SHELL is two extrusions of the side elevation. The SIDE SLABS are the
 * outer 100 mm of each flank, down to the sills between the wheels; the
 * CENTRE BODY between them stops at the floor pan. Each is chamfered, so where
 * they butt the bevels leave a groove: the bonnet's shut lines along the
 * guards, and the barn doors' against the rear quarters. The wheel arches are
 * cut through both, so the wheels have their tubs, and the arch rims and the
 * bottoms wear the underbody's dark finish.
 *
 * THE GLASSHOUSE is four planar panels on the belt (two sides with a little
 * tumblehome, the raked windscreen and the near-upright rear doors), each
 * split into pillars and bands round its window openings. Each opening has a
 * black rubber reveal running through the panel's 30 mm to its inner skin,
 * and its glass 12 mm in. The inner skin is the cabin's trim, so the glass is
 * looked through from inside too.
 */

const swatch = (finish: CarFinish): UvFor => {
  const uv = finishUv(finish);
  return () => uv;
};
const sideMap: UvFor = (point) => sideUv(point[0], point[1] - GROUND_Y);

const FA = LC76_FRONT_AXLE_X;
const RA = LC76_REAR_AXLE_X;
/** The wheel centres' height above the ground at rest: the arches' centres. */
const WHEEL_HEIGHT = LC76_TYRE_LOADED_RADIUS;

/** Where the side slabs meet the centre body: the bonnet's and the barn doors' shut lines. */
export const SHELL_SPLIT_Z = BODY.halfWidth - 0.1;
/** The cabin and cargo floors' undersides, above the ground. */
export const FLOOR_PAN = Object.freeze({ cabin: 0.62, cargo: 0.72 });
/** The glasshouse's skin: its inner trim stands this far in from the outer panels. */
const SKIN = 0.03;
const GLASS_DEPTH = 0.012;

/** A superellipse arch over a wheel, (x, height) from its rear foot to its front foot. */
export function archOutline(
  centreX: number,
  halfWidth: number,
  height: number,
  rearFoot: number,
  frontFoot: number,
  steps = 18,
): Point2[] {
  const n = ARCH.exponent;
  const footAngle = (foot: number): number => Math.asin(Math.min(1, Math.max(0, (foot - WHEEL_HEIGHT) / height)) ** (n / 2));
  const from = Math.PI - footAngle(rearFoot);
  const to = footAngle(frontFoot);
  const points: Point2[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const angle = from + ((to - from) * k) / steps;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    points.push([
      centreX + halfWidth * Math.sign(c) * Math.abs(c) ** (2 / n),
      WHEEL_HEIGHT + height * Math.abs(s) ** (2 / n),
    ]);
  }
  return points;
}

/** Inside the arch's superellipse (with a margin), at (x, height above the ground). */
function inArch(x: number, height: number, margin: number): boolean {
  const n = ARCH.exponent;
  for (const centre of [FA, RA]) {
    const r = (Math.abs(x - centre) / ARCH.halfWidth) ** n + (Math.abs(height - WHEEL_HEIGHT) / ARCH.height) ** n;
    if (r <= margin) return true;
  }
  return false;
}

/** The shell's side elevation, (x, height) counter-clockwise seen from the right. */
function shellOutline(sill: number, rearBottom: number): Point2[] {
  const corner = 0.045;
  return [
    [BODY.rear, rearBottom],
    ...archOutline(RA, ARCH.halfWidth, ARCH.height, rearBottom, sill),
    ...archOutline(FA, ARCH.halfWidth, ARCH.height, sill, BODY.frontBottom),
    [BODY.front, BODY.frontBottom],
    // Where the bonnet's lip comes down over the front.
    [BODY.front, BODY.bonnetFront - BONNET.lip],
    ...arc([BODY.front - corner, BODY.bonnetFront - corner], corner, 0, Math.PI / 2, 4),
    [BODY.cowlX, BODY.bonnetCowl],
    [GLASSHOUSE.screenFootX, BODY.belt],
    [BODY.rear, BODY.belt],
  ];
}

/** An elevation's (x, height) points as body-frame (x, y). */
function elevation(points: readonly Point2[]): Point2[] {
  return points.map(([x, height]) => [x, h(height)]);
}

/** The shell's rim: dark in the wheel tubs and underneath, paint everywhere else. */
const shellRimUv: UvFor = (point) => {
  const height = point[1] - GROUND_Y;
  if (height < 0.66 || inArch(point[0], height, 1.04)) return finishUv("underbody");
  return finishUv("paint");
};

/** 0 below `from`, 1 past `to` (either way round), smooth between. */
function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** The bonnet's line along the centre at x, before its crown and bulge: rising from the front to the cowl. */
function bonnetLine(x: number): number {
  const front = BODY.front - BONNET.nose;
  return BODY.bonnetFront + ((BODY.bonnetCowl - BODY.bonnetFront) * (front - x)) / (front - BODY.cowlX);
}

/** The side slab's top at x: the guards' tops ahead of the cowl, the belt behind the windscreen. */
function slabTop(x: number): number {
  if (x >= BODY.cowlX) return x > BODY.front - BONNET.nose ? BODY.bonnetFront : bonnetLine(x);
  if (x <= GLASSHOUSE.screenFootX) return BODY.belt;
  return BODY.bonnetCowl + ((BODY.belt - BODY.bonnetCowl) * (BODY.cowlX - x)) / (BODY.cowlX - GLASSHOUSE.screenFootX);
}

/**
 * The flanks' rounds: the shoulders along the guards' tops and the door
 * tops roll over 35 mm, the guards' noses and the rear corners nearly as
 * much, and the shut lines, sills and arch lips are broken 5 mm.
 */
function flankRadius(point: Vec3Tuple): number {
  const x = point[0];
  const height = point[1] - GROUND_Y;
  const shoulder = smoothstep(slabTop(x) - 0.08, slabTop(x) - 0.015, height);
  const nose = smoothstep(BODY.front - 0.08, BODY.front - 0.01, x);
  const tail = smoothstep(BODY.rear + 0.08, BODY.rear + 0.01, x);
  return 0.005 + 0.03 * Math.max(shoulder, 0.85 * nose, 0.75 * tail);
}

/** The doors' bottoms: below them the sill panel runs between the arches. */
const DOOR_BOTTOM = BODY.sill + 0.06;
/** Half a shut line's width. */
const SHUT = 0.0025;

/**
 * The steel shell. Each flank is cut into its panels (the front guard, the
 * two doors over the sill panel, the rear quarter) along the shut lines, and
 * every panel is a rounded slab, so the gaps between them are real grooves
 * with rolled edges. The centre body between the flanks carries the grille's
 * face, the cowl, the barn doors and the floor; the bonnet is its own panel.
 */
function shellSurfaces(): { readonly side: Surface[]; readonly centre: Surface[] } {
  const outline = elevation(shellOutline(BODY.sill, BODY.rearBottom));
  const far = Number.POSITIVE_INFINITY;
  const pieces: readonly (readonly [number, number, number, number])[] = [
    // x from, x to, height from, height to.
    [DOOR_LINES.frontDoorFront + SHUT, far, -far, far],
    [DOOR_LINES.frontDoorRear + SHUT, DOOR_LINES.frontDoorFront - SHUT, DOOR_BOTTOM + SHUT, far],
    [DOOR_LINES.rearDoorRear + SHUT, DOOR_LINES.frontDoorRear - SHUT, DOOR_BOTTOM + SHUT, far],
    [DOOR_LINES.rearDoorRear + SHUT, DOOR_LINES.frontDoorFront - SHUT, -far, DOOR_BOTTOM - SHUT],
    [-far, DOOR_LINES.rearDoorRear - SHUT, -far, far],
  ];
  const side: Surface[] = [];
  for (const [x0, x1, b0, b1] of pieces) {
    const piece = clipOutline(outline, x0, x1, h(b0), h(b1));
    if (piece.length < 3) continue;
    side.push(...roundedPrismZ(resampleOutline(piece, 0.06), SHELL_SPLIT_Z, BODY.halfWidth, {
      farRadius: flankRadius,
      nearRadius: 0.004,
      segments: 3,
      creaseRadians: 0.5,
      faceUv: sideMap,
      // Its inner face shows only through the shut lines and in the arches.
      nearFaceUv: swatch("seal"),
      rimUv: shellRimUv,
    }));
  }
  // Dark behind the shut lines, so a gap never shows the cabin's back faces.
  side.push(quad(
    [BODY.rear, h(BODY.sill), SHELL_SPLIT_Z - 0.001],
    [GLASSHOUSE.screenFootX + 0.1, h(BODY.sill), SHELL_SPLIT_Z - 0.001],
    [GLASSHOUSE.screenFootX + 0.1, h(BODY.belt), SHELL_SPLIT_Z - 0.001],
    [BODY.rear, h(BODY.belt), SHELL_SPLIT_Z - 0.001],
    swatch("seal"),
  ));
  const centre = roundedPrismZ(resampleOutline(elevation(shellOutline(FLOOR_PAN.cabin, FLOOR_PAN.cargo)), 0.2), -SHELL_SPLIT_Z, SHELL_SPLIT_Z, {
    farRadius: 0.004,
    nearRadius: 0.004,
    segments: 2,
    creaseRadians: 0.5,
    faceUv: swatch("paint"),
    rimUv: shellRimUv,
    skipNearFace: true,
    skipFarFace: true,
    // No lid at the belt: the cabin and the cargo bay are open to the glasshouse;
    // and the bonnet is its own panel down to its lip.
    openRim: (point) =>
      (Math.abs(point[1] - h(BODY.belt)) < 0.02 && point[0] < GLASSHOUSE.screenFootX - 0.005 && point[0] > BODY.rear + 0.005)
      || (point[0] > BODY.cowlX + 0.001 && point[1] > h(BODY.bonnetFront - BONNET.lip)),
  });
  return { side, centre };
}

/**
 * The bonnet: a panel between the guards, crowned across, its broad centre
 * bulge rising from just behind the nose and running back to the cowl, its
 * nose rolled down over the grille to a lip. Its edges turn down into the
 * shut lines along the guards.
 */
export const BONNET = Object.freeze({
  /** The nose's roll-over radius, and how far the lip hangs below the bonnet's front line. */
  nose: 0.045,
  lip: 0.068,
  halfWidth: SHELL_SPLIT_Z - 0.004,
  crown: 0.01,
  /** The bulge: its height, its flat top's and its foot's half widths. */
  bulge: 0.045,
  bulgeTop: 0.42,
  bulgeFoot: 0.56,
});

/** The bonnet's lift over its line: the crown across and the bulge. */
function bonnetLift(x: number, z: number): number {
  const across = Math.abs(z);
  const crown = BONNET.crown * (1 - (across / BONNET.halfWidth) ** 2);
  const along = smoothstep(BODY.front - 0.08, BODY.front - 0.3, x) * (1 - 0.3 * smoothstep(BODY.cowlX + 0.3, BODY.cowlX, x));
  return crown + BONNET.bulge * (1 - smoothstep(BONNET.bulgeTop, BONNET.bulgeFoot, across)) * along;
}

/** The bonnet's top surface at (x, z) above the ground: where the scoop sits. */
export function bonnetTop(x: number, z: number): number {
  return bonnetLine(x) + bonnetLift(x, z);
}

function bonnetSurfaces(): Surface[] {
  const r = BONNET.nose;
  const front = BODY.front;
  // The centre line's section: (x, height, how much of the lift it carries).
  const section: (readonly [number, number, number])[] = [];
  const rearX = BODY.cowlX + 0.004;
  const topStations = [0, 0.05, 0.12, 0.2, 0.3, 0.42, 0.55, 0.62, 0.7, 0.76, 0.82, 0.88, 0.94, 1];
  for (const t of topStations) {
    const x = rearX + (front - r - rearX) * t;
    section.push([x, bonnetLine(x), 1]);
  }
  for (let k = 1; k <= 5; k += 1) {
    const angle = (Math.PI / 2) * (1 - k / 5);
    section.push([front - r + Math.cos(angle) * r, BODY.bonnetFront - r + Math.sin(angle) * r, Math.sin(angle)]);
  }
  section.push([front, BODY.bonnetFront - BONNET.lip, 0], [front - 0.015, BODY.bonnetFront - BONNET.lip, 0]);
  // Across, from +z to -z so the grid shows up: the edges turn down into the shut lines.
  const w = BONNET.halfWidth;
  const half = [w, w - 0.003, w - 0.008, w - 0.016, 0.7, 0.62, 0.58, 0.555, 0.53, 0.505, 0.48, 0.455, 0.43, 0.38, 0.28, 0.16, 0.05];
  const drop = (z: number): number => {
    const from = w - Math.abs(z);
    return from >= 0.016 ? 0 : from >= 0.008 ? 0.0015 * (0.016 - from) / 0.008 : from >= 0.003 ? 0.0015 + (0.0045 * (0.008 - from)) / 0.005 : 0.006 + (0.008 * (0.003 - from)) / 0.003;
  };
  const across = [...half, ...half.slice().reverse().map((z) => -z)];
  const rows = section.map(([x, height, carry]) => across.map((z): Vec3Tuple => [x, h(height + carry * bonnetLift(x, z) - drop(z)), z]));
  const bonnet = new Surface();
  const paint = finishUv("paint");
  bonnet.grid(rows, () => paint);
  // The engine bay under the bonnet, dark through its shut lines.
  const bay = quad(
    [BODY.cowlX, h(1.0), SHELL_SPLIT_Z],
    [front - 0.02, h(1.0), SHELL_SPLIT_Z],
    [front - 0.02, h(1.0), -SHELL_SPLIT_Z],
    [BODY.cowlX, h(1.0), -SHELL_SPLIT_Z],
    swatch("seal"),
  );
  return [bonnet, bay];
}

/** A flare: a black moulding round an arch, from foot to foot, standing proud of the flank. */
function flareSurfaces(centreX: number, rearFoot: number, frontFoot: number): Surface[] {
  const outer = archOutline(centreX, ARCH.halfWidth + ARCH.flareWidth, ARCH.height + ARCH.flareWidth, rearFoot, frontFoot);
  const inner = archOutline(centreX, ARCH.halfWidth - 0.01, ARCH.height - 0.01, rearFoot, frontFoot);
  // Moulded: its face rolls round both edges, the lip over the tyre and the edge on the flank.
  return roundedPrismZ(elevation([...outer, ...inner.reverse()]), BODY.halfWidth - 0.03, BODY.flareHalfWidth, {
    farRadius: 0.03,
    nearRadius: 0,
    segments: 3,
    creaseRadians: 0.7,
    faceUv: swatch("flare"),
    skipNearFace: true,
  });
}

/**
 * The wheel wells' inner walls on the right, inboard of each tyre (and of the
 * front coil, which stands in the well): the arch's opening closed off, so
 * the tub is not a tunnel through the car.
 */
function linerSurfaces(): Surface[] {
  const uv = swatch("underbody");
  const wells: readonly (readonly [number, number, number, number])[] = [
    [FA, FLOOR_PAN.cabin, BODY.frontBottom, 0.47],
    [RA, FLOOR_PAN.cargo, FLOOR_PAN.cabin, 0.55],
  ];
  // The arch runs clockwise seen from the right: reversed, it shows +Z, toward the tyre.
  return wells.map(([centre, rearFoot, frontFoot, z]) => polygonSurface(
    archOutline(centre, ARCH.halfWidth, ARCH.height, rearFoot, frontFoot).reverse(),
    (x, height) => [x, h(height), z],
    uv,
  ));
}

/** The tubular side steps between the arches, on the right. */
function stepSurfaces(): Surface[] {
  const front = FA - ARCH.halfWidth - 0.05;
  const rear = RA + ARCH.halfWidth + 0.05;
  // Inside the flares' 935 mm, as the car's published width says.
  const outline: Point2[] = [
    [rear, 0.8],
    [front, 0.8],
    [front, 0.905],
    [front - 0.03, 0.928],
    [rear + 0.03, 0.928],
    [rear, 0.905],
  ];
  const surfaces = roundedPrismY(outline, h(0.47), h(0.5), { farRadius: 0.008, nearRadius: 0.008, segments: 2, faceUv: swatch("blackPlastic") });
  // Rubber treads along the top.
  for (const z of [0.83, 0.865, 0.9]) {
    surfaces.push(...roundedBox([rear + 0.06, h(0.5) - 0.002, z - 0.009], [front - 0.06, h(0.5) + 0.005, z + 0.009], 0.003, swatch("rubber"), 1));
  }
  return surfaces;
}

/**
 * The front bumper: pressed steel wrapped round the corners, its section a
 * flat face under a rolled top flange, creased into a lower face that tucks
 * back under; the plate in the middle of the face and the fog lamps' black
 * bezels toward its ends.
 */
function frontBumperSurfaces(): Surface[] {
  const face = BODY.bumperFront;
  const path: Point2[] = [];
  const wing = (t: number): Point2 => {
    // The wing's plan: from the face's end round to the guard's corner.
    const angle = t * (Math.PI / 2) * 0.8;
    return [face - 0.16 + Math.cos(angle) * 0.16, 0.8 + Math.sin(angle) * 0.13];
  };
  for (let k = 6; k >= 0; k -= 1) {
    const [x, z] = wing(k / 6);
    path.push([x, -z]);
  }
  for (let k = 1; k <= 7; k += 1) path.push([face, -0.8 + (1.6 * k) / 8]);
  for (let k = 0; k <= 6; k += 1) path.push(wing(k / 6));
  // Section: (out from the path, height) from the top flange's back, over the face, under to the bottom's back.
  const section: Point2[] = [
    [-0.1, h(BUMPERS.frontTop)],
    [-0.016, h(BUMPERS.frontTop + 0.002)],
    [-0.005, h(BUMPERS.frontTop - 0.002)],
    [0, h(BUMPERS.frontTop - 0.012)],
    [0, h(0.6)],
    [-0.003, h(0.588)],
    [-0.011, h(0.579)],
    [-0.05, h(0.53)],
    [-0.062, h(0.506)],
    [-0.075, h(BUMPERS.frontBottom + 0.004)],
    [-0.1, h(BUMPERS.frontBottom)],
  ];
  const surfaces = sweep(path, section, swatch("bumper"));
  // The plate, 372 x 134 mm, on the face.
  surfaces.push(...plateSurfaces(face, 1, 0.6 + 0.004, 0));
  for (const side of [-1, 1]) {
    surfaces.push(ring([face + 0.0035, h(FOG_LAMP.height), side * FOG_LAMP.halfSpacing], [1, 0, 0], FOG_LAMP.radius - 0.002, FOG_LAMP.radius + 0.012, 24, swatch("blackPlastic")));
  }
  return surfaces;
}

/** A number plate, 372 x 134 mm, in a black surround, on a face at `x` looking along `facing` x. */
function plateSurfaces(x: number, facing: 1 | -1, bottom: number, z: number): Surface[] {
  const plate = (at: number, inset: number, finish: CarFinish): Surface => {
    const left = z - 0.186 - inset;
    const right = z + 0.186 + inset;
    const corners: Vec3Tuple[] = [
      [at, h(bottom - inset), facing > 0 ? right : left],
      [at, h(bottom - inset), facing > 0 ? left : right],
      [at, h(bottom + 0.134 + inset), facing > 0 ? left : right],
      [at, h(bottom + 0.134 + inset), facing > 0 ? right : left],
    ];
    return quad(corners[0]!, corners[1]!, corners[2]!, corners[3]!, swatch(finish));
  };
  return [plate(x + facing * 0.002, 0.012, "seal"), plate(x + facing * 0.004, 0, "plate")];
}

/** The rear bumper, wrapped round the corners, its rubber step pad and the tow hitch's receiver. */
function rearBumperSurfaces(): Surface[] {
  const face = BODY.bumperRear;
  const path: Point2[] = [];
  const wing = (t: number): Point2 => {
    const angle = t * (Math.PI / 2) * 0.8;
    return [face + 0.14 - Math.cos(angle) * 0.14, 0.8 + Math.sin(angle) * 0.1];
  };
  for (let k = 6; k >= 0; k -= 1) path.push(wing(k / 6));
  for (let k = 1; k <= 7; k += 1) path.push([face, 0.8 - (1.6 * k) / 8]);
  for (let k = 0; k <= 6; k += 1) {
    const [x, z] = wing(k / 6);
    path.push([x, -z]);
  }
  const section: Point2[] = [
    [-0.12, h(BUMPERS.rearTop)],
    [-0.014, h(BUMPERS.rearTop + 0.002)],
    [-0.004, h(BUMPERS.rearTop - 0.003)],
    [0, h(BUMPERS.rearTop - 0.014)],
    [0, h(0.585)],
    [-0.004, h(0.572)],
    [-0.014, h(0.562)],
    [-0.05, h(BUMPERS.rearBottom + 0.004)],
    [-0.12, h(BUMPERS.rearBottom)],
  ];
  return [
    ...sweep(path, section, swatch("bumper")),
    ...roundedBox([face - 0.004, h(BUMPERS.rearTop) - 0.002, -0.3], [face + 0.12, h(BUMPERS.rearTop) + 0.009, 0.3], 0.004, swatch("rubber")),
    ...box([BODY.towHitch, h(0.47), -0.035], [BODY.rear + 0.2, h(0.54), 0.035], swatch("chassis"), 0.006),
    ...box([BODY.towHitch + 0.004, h(0.49), -0.012], [BODY.towHitch + 0.06, h(0.52), 0.012], swatch("lugNut")),
  ];
}

/**
 * The 2024 face: one black fascia across the front between the guards,
 * holding the round LED headlamps at its ends in chrome bezels and, between
 * them, the black mesh grille in its frame with the TOYOTA letters standing
 * proud of it. Under the fascia the body-coloured panel carries the three
 * cooling slots, over the bumper.
 */
export const FASCIA = Object.freeze({
  halfWidth: SHELL_SPLIT_Z - 0.01,
  bottom: 0.884,
  top: BODY.bonnetFront - 0.07,
  /** Its face, proud of the body's front. */
  face: BODY.front + 0.012,
});
const GRILLE = GRILLE_INSERT;
/** The headlamps' bezels stand out of the fascia; the bowl's rim and its lens sit inside them. */
export const HEADLAMP_RIM_X = FASCIA.face + 0.026;
const HEADLAMP_BOWL_DEPTH = 0.02;

/** The bowl's x at a radius: a shallow dish from the rim back to the projector. */
export function headlampBowlX(radius: number): number {
  return HEADLAMP_RIM_X - HEADLAMP_BOWL_DEPTH * (1 - (radius / HEADLAMP.radius) ** 2);
}

/** Seen from ahead (+X looking back), u to the viewer's right is -z. */
const fromAhead = (u: number, height: number): Point2 => [-u, h(height)];

/** The TOYOTA letters' outlines in (u, height) from ahead, each a list of solid parts (an O is its outer and inner loops). */
function letterParts(): { readonly solids: Point2[][]; readonly rings: (readonly [Point2[], Point2[]])[] } {
  const H = GRILLE.letters;
  const s = H * 0.21;
  const widths = { T: H * 0.95, O: H * 1.04, Y: H * 0.98, A: H * 1.02 } as const;
  const gap = H * 0.36;
  const word = "TOYOTA";
  const total = [...word].reduce((sum, letter) => sum + widths[letter as keyof typeof widths], 0) + gap * (word.length - 1);
  const base = (GRILLE.bottom + GRILLE.top) / 2 - H / 2;
  const solids: Point2[][] = [];
  const rings: (readonly [Point2[], Point2[]])[] = [];
  let left = -total / 2;
  for (const letter of word) {
    const W = widths[letter as keyof typeof widths];
    const c = left + W / 2;
    const at = (u: number, v: number): Point2 => fromAhead(left + u, base + v);
    if (letter === "T") {
      solids.push([at(0, H), at(0, H - s), at(W / 2 - s / 2, H - s), at(W / 2 - s / 2, 0), at(W / 2 + s / 2, 0), at(W / 2 + s / 2, H - s), at(W, H - s), at(W, H)]);
    } else if (letter === "O") {
      const loop = (inset: number): Point2[] => {
        const r = H / 2 - inset;
        const straight = W / 2 - H / 2;
        const points: Point2[] = [];
        for (let k = 0; k <= 10; k += 1) {
          const angle = -Math.PI / 2 + (Math.PI * k) / 10;
          points.push(fromAhead(c + straight + Math.cos(angle) * r, base + H / 2 + Math.sin(angle) * r));
        }
        for (let k = 0; k <= 10; k += 1) {
          const angle = Math.PI / 2 + (Math.PI * k) / 10;
          points.push(fromAhead(c - straight + Math.cos(angle) * r, base + H / 2 + Math.sin(angle) * r));
        }
        return points;
      };
      rings.push([loop(0), loop(s)]);
    } else if (letter === "Y") {
      const j = H * 0.44;
      const arm = s * 1.2;
      solids.push([at(W / 2 - s / 2, 0), at(W / 2 + s / 2, 0), at(W / 2 + s / 2, j), at(W, H), at(W - arm, H), at(W / 2, j + s * 0.95), at(arm, H), at(0, H), at(W / 2 - s / 2, j)]);
    } else {
      const leg = s * 1.22;
      const apex = s * 1.25;
      const inner = H - s * 1.35;
      solids.push([at(0, 0), at(leg, 0), at(W / 2, inner), at(W - leg, 0), at(W, 0), at(W / 2 + apex / 2, H), at(W / 2 - apex / 2, H)]);
      // The crossbar between the legs' inner edges.
      const edge = (v: number, sign: number): number => W / 2 + sign * (W / 2 - leg) * (1 - v / inner);
      const v0 = H * 0.2;
      const v1 = v0 + s * 0.85;
      solids.push([at(edge(v0, -1), v0), at(edge(v0, 1), v0), at(edge(v1, 1), v1), at(edge(v1, -1), v1)]);
    }
    void c;
    left += W + gap;
  }
  return { solids, rings };
}

/** A flat ring of a letter (outer and inner loops of one count) pushed through x0..x1: its face and both walls. */
function ringThroughX(outer: readonly Point2[], inner: readonly Point2[], x0: number, x1: number, uv: UvFor): Surface[] {
  const at = ([z, y]: Point2, x: number): Vec3Tuple => [x, y, z];
  const face = new Surface();
  const outerWall = new Surface();
  const innerWall = new Surface();
  const count = outer.length;
  for (let k = 0; k < count; k += 1) {
    const next = (k + 1) % count;
    const ids = [at(outer[k]!, x1), at(outer[next]!, x1), at(inner[next]!, x1), at(inner[k]!, x1)].map((point) => face.vertexAt(point, uv(point)));
    face.triFacing(ids[0]!, ids[1]!, ids[2]!, [1, 0, 0]);
    face.triFacing(ids[0]!, ids[2]!, ids[3]!, [1, 0, 0]);
    for (const [wall, loop, sign] of [[outerWall, outer, 1], [innerWall, inner, -1]] as const) {
      const p = loop[k]!;
      const q = loop[next]!;
      // Away from the ring's middle for the outer wall, toward it for the inner.
      const mid: Point2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const centre = loop.reduce<Point2>((sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count], [0, 0]);
      const facing: Vec3Tuple = [0, (mid[1] - centre[1]) * sign, (mid[0] - centre[0]) * sign];
      const w = [at(p, x1), at(q, x1), at(q, x0), at(p, x0)].map((point) => wall.vertexAt(point, uv(point)));
      wall.triFacing(w[0]!, w[1]!, w[2]!, facing);
      wall.triFacing(w[0]!, w[2]!, w[3]!, facing);
    }
  }
  return [face, outerWall, innerWall];
}

/** The fascia, the headlamps' bezels and bowls' surrounds, the grille's frame, mesh and letters, the slots and the indicators' surrounds. */
function frontSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  // The fascia: a black panel with rolled edges, standing proud of the front.
  surfaces.push(...roundedPrismX(
    roundedRect(-FASCIA.halfWidth, h(FASCIA.bottom), FASCIA.halfWidth, h(FASCIA.top), 0.05, 4),
    BODY.front - 0.01,
    FASCIA.face,
    { farRadius: 0.008, nearRadius: 0, segments: 2, faceUv: swatch("grilleBlack"), skipNearFace: true },
  ));
  // The grille insert: the mesh just proud of the fascia, framed by a rounded bar.
  const meshX = FASCIA.face + 0.001;
  surfaces.push(quad(
    [meshX, h(GRILLE.bottom), GRILLE.halfWidth],
    [meshX, h(GRILLE.bottom), -GRILLE.halfWidth],
    [meshX, h(GRILLE.top), -GRILLE.halfWidth],
    [meshX, h(GRILLE.top), GRILLE.halfWidth],
    (point) => grilleUv((GRILLE.halfWidth - point[2]) / (2 * GRILLE.halfWidth), (point[1] - GROUND_Y - GRILLE.bottom) / (GRILLE.top - GRILLE.bottom)),
  ));
  const bar = 0.014;
  const frameFront = FASCIA.face + 0.012;
  const frame = swatch("blackPlastic");
  surfaces.push(...roundedBox([FASCIA.face - 0.002, h(GRILLE.top), -GRILLE.halfWidth - bar], [frameFront, h(GRILLE.top + bar), GRILLE.halfWidth + bar], 0.005, frame));
  surfaces.push(...roundedBox([FASCIA.face - 0.002, h(GRILLE.bottom - bar), -GRILLE.halfWidth - bar], [frameFront, h(GRILLE.bottom), GRILLE.halfWidth + bar], 0.005, frame));
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? GRILLE.halfWidth : -GRILLE.halfWidth - bar;
    surfaces.push(...roundedPrismZ(
      roundedRect(FASCIA.face - 0.002, h(GRILLE.bottom), frameFront, h(GRILLE.top), 0.005, 2),
      z0,
      z0 + bar,
      { farRadius: 0.004, nearRadius: 0.004, segments: 2, faceUv: frame },
    ));
  }
  // The letters, silver, 7 mm proud of the mesh.
  const letters = letterParts();
  const silver = swatch("lettering");
  for (const solid of letters.solids) {
    surfaces.push(...roundedPrismX(solid, meshX, meshX + 0.007, { farRadius: 0.0018, nearRadius: 0, segments: 2, faceUv: silver, skipNearFace: true }));
  }
  for (const [outer, inner] of letters.rings) surfaces.push(...ringThroughX(outer, inner, meshX, meshX + 0.007, silver));
  for (const side of [-1, 1]) {
    const z = side * HEADLAMP.halfSpacing;
    const centre: readonly [number, number] = [h(HEADLAMP.height), z];
    // The lamp's barrel out of the fascia, and its chrome bezel rolled over the rim.
    surfaces.push(latheX(
      [[HEADLAMP.radius + 0.018, FASCIA.face - 0.002], [HEADLAMP.radius + 0.018, HEADLAMP_RIM_X - 0.006]],
      40, centre, swatch("grilleBlack"), (_point, outward) => outward,
    ));
    surfaces.push(latheX(
      [
        [HEADLAMP.radius + 0.018, HEADLAMP_RIM_X - 0.006],
        [HEADLAMP.radius + 0.0175, HEADLAMP_RIM_X - 0.001],
        [HEADLAMP.radius + 0.014, HEADLAMP_RIM_X + 0.004],
        [HEADLAMP.radius + 0.008, HEADLAMP_RIM_X + 0.006],
        [HEADLAMP.radius + 0.002, HEADLAMP_RIM_X + 0.004],
        [HEADLAMP.radius, HEADLAMP_RIM_X],
      ],
      40, centre, swatch("chrome"), (_point, outward) => outward,
    ));
    // The projector's chrome collar, in the middle of the bowl.
    surfaces.push(latheX(
      [[0.04, headlampBowlX(0.04) + 0.0005], [0.04, headlampBowlX(0.04) + 0.008], [0.032, headlampBowlX(0.04) + 0.01]],
      24, centre, swatch("chrome"), (_point, outward) => outward,
    ));
  }
  // The three cooling slots in the panel under the fascia.
  for (const middle of [-0.25, 0, 0.25]) {
    surfaces.push(polygonSurface(
      roundedRect(middle - 0.105, h(0.808), middle + 0.105, h(0.848), 0.014, 3).map(([z, y]) => [-z, y] as Point2),
      (a, y) => [BODY.front + 0.0015, y, -a],
      swatch("seal"),
    ));
  }
  // The indicators' black surrounds on the guards' noses.
  for (const side of [-1, 1]) {
    const zIn = SHELL_SPLIT_Z + 0.01;
    const zOut = BODY.halfWidth - 0.03;
    const [z0, z1] = side > 0 ? [zIn, zOut] : [-zOut, -zIn];
    surfaces.push(...roundedBox([BODY.front - 0.004, h(0.786), z0], [BODY.front + 0.008, h(0.859), z1], 0.004, swatch("blackPlastic")));
  }
  // The bonnet scoop: a raised intake on the bulge's centre line, its mouth forward, its sides rolled.
  const scoopRear = FA - 0.17;
  const scoopFront = FA + 0.36;
  const seat = (x: number): number => bonnetTop(x, 0);
  const scoop: Point2[] = [
    [scoopRear, seat(scoopRear) - 0.02],
    [scoopFront, seat(scoopFront) - 0.02],
    [scoopFront, seat(scoopFront) + 0.052],
    [scoopFront - 0.06, seat(scoopFront - 0.06) + 0.056],
    [scoopRear + 0.12, seat(scoopRear + 0.12) + 0.014],
    [scoopRear + 0.04, seat(scoopRear + 0.04) + 0.002],
  ];
  surfaces.push(...roundedPrismZ(scoop.map(([x, height]) => [x, h(height)] as Point2), -0.27, 0.27, {
    farRadius: 0.018,
    nearRadius: 0.018,
    segments: 3,
    creaseRadians: 0.5,
    faceUv: swatch("paint"),
    rimUv: (point) => (point[0] > scoopFront - 0.004 ? finishUv("grilleBlack") : finishUv("paint")),
  }));
  return surfaces;
}

/** The wipers, parked along the windscreen's foot. */
function wiperSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const t = 0.07;
  const lift = 0.016;
  const n = screenNormal();
  const at = (z: number, height: number): Vec3Tuple => {
    const p = screenPoint(z, height);
    return [p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift];
  };
  for (const [pivot, tip] of [[0.52, -0.2], [-0.1, -0.74]] as const) {
    surfaces.push(...tube([at(pivot, BODY.belt + t), at(tip, BODY.belt + t + 0.03)], 0.007, 6, swatch("blackPlastic")));
  }
  return surfaces;
}

// ---------------------------------------------------------------------------
// The glasshouse.

const GH_SPAN = GLASSHOUSE.head - BODY.belt;

/** The side panel's half width at a height: the tumblehome. */
export function tumble(height: number): number {
  const t = (height - BODY.belt) / GH_SPAN;
  return GLASSHOUSE.footHalfWidth + (GLASSHOUSE.headHalfWidth - GLASSHOUSE.footHalfWidth) * t;
}

/** The windscreen's and the rear doors' stations at a height. */
function screenX(height: number): number {
  const t = (height - BODY.belt) / GH_SPAN;
  return GLASSHOUSE.screenFootX + (GLASSHOUSE.screenHeadX - GLASSHOUSE.screenFootX) * t;
}
function rearX(height: number): number {
  const t = (height - BODY.belt) / GH_SPAN;
  return GLASSHOUSE.rearFootX + (GLASSHOUSE.rearHeadX - GLASSHOUSE.rearFootX) * t;
}

function screenPoint(z: number, height: number): Vec3Tuple {
  return [screenX(height), h(height), z];
}
function screenNormal(): Vec3Tuple {
  return planeNormal((a, b) => screenPoint(-a, b));
}

/** The unit normal a panel's `place(a, b)` shows for outlines counter-clockwise in (a, b). */
function planeNormal(place: (a: number, b: number) => Vec3Tuple): Vec3Tuple {
  const o = place(0, 1.5);
  const pa = place(1, 1.5);
  const pb = place(0, 2.5);
  return normalize3(cross3([pa[0] - o[0], pa[1] - o[1], pa[2] - o[2]], [pb[0] - o[0], pb[1] - o[1], pb[2] - o[2]]));
}

interface Panel {
  /** The panel's pieces round its openings, counter-clockwise in (a, b). */
  readonly pieces: readonly (readonly Point2[])[];
  readonly openings: readonly (readonly Point2[])[];
  readonly place: (a: number, b: number) => Vec3Tuple;
  readonly outerUv: UvFor;
  /**
   * How far along a the inner trim reaches at height b: a skin's depth short
   * of the glasshouse's corners, so its edge never lies in the next panel's
   * face, where it fought that face's depth in a dashed line down each pillar.
   */
  readonly trimSpan: (b: number) => readonly [number, number];
}

interface GlasshouseParts {
  readonly outer: Surface[];
  readonly inner: Surface[];
  readonly glass: Surface[];
}

/** A panel's outer skin, inner trim, reveals and glass. */
function buildPanel(panel: Panel, parts: GlasshouseParts, innerFinish: CarFinish): void {
  const n = planeNormal(panel.place);
  const offset = (depth: number) => (a: number, b: number): Vec3Tuple => {
    const p = panel.place(a, b);
    return [p[0] - n[0] * depth, p[1] - n[1] * depth, p[2] - n[2] * depth];
  };
  const inner = offset(SKIN);
  const glass = offset(GLASS_DEPTH);
  for (const piece of panel.pieces) {
    parts.outer.push(polygonSurface(piece, panel.place, panel.outerUv));
    const trim = piece.map(([a, b]): Point2 => {
      const [from, to] = panel.trimSpan(b);
      return [Math.min(to, Math.max(from, a)), b];
    });
    parts.inner.push(polygonSurface(trim, inner, swatch(innerFinish)).flipped());
  }
  for (const opening of panel.openings) {
    const ccw = signedArea(opening) > 0 ? opening : [...opening].reverse();
    parts.outer.push(...revealBand(ccw.map(([a, b]) => panel.place(a, b)), [-n[0] * SKIN, -n[1] * SKIN, -n[2] * SKIN], swatch("seal")));
    parts.outer.push(gasket(ccw, offset(-GASKET.proud), n));
    parts.glass.push(polygonSurface(ccw, glass, swatch("seal")));
  }
}

/**
 * How far short of the rear corners the side and rear trims stop. Trim up to
 * a skin's depth from the corner still lay in the shadow map's back faces a
 * few centimetres behind the lit panels, as a dashed line down each D pillar
 * seen from the chase camera; a chamfer joins the two trims instead.
 */
const D_PILLAR_TRIM = 0.12;

/** The D pillars' inner trim: a chamfer across the right rear corner from the side trim's end to the rear trim's. */
function dPillarTrim(): Surface {
  const sideNormal = planeNormal((x, height) => [x, h(height), tumble(height)]);
  const rearNormal = planeNormal((z, height) => [rearX(height), h(height), z]);
  const inset = (point: Vec3Tuple, n: Vec3Tuple): Vec3Tuple => [point[0] - n[0] * SKIN, point[1] - n[1] * SKIN, point[2] - n[2] * SKIN];
  const side = (height: number): Vec3Tuple => inset([rearX(height) + D_PILLAR_TRIM, h(height), tumble(height)], sideNormal);
  const rear = (height: number): Vec3Tuple => inset([rearX(height), h(height), tumble(height) - D_PILLAR_TRIM], rearNormal);
  const surface = new Surface();
  const uv = finishUv("trim");
  const [a, b, c, d] = [side(BODY.belt), side(GLASSHOUSE.head), rear(GLASSHOUSE.head), rear(BODY.belt)].map((point) => surface.vertexAt(point, uv));
  const facing: Vec3Tuple = [1, 0, -1];
  surface.triFacing(a!, b!, c!, facing);
  surface.triFacing(a!, c!, d!, facing);
  return surface;
}

/** The windows' black rubber: a band over the panel round each opening, its inner edge rounded into the glass. */
const GASKET = Object.freeze({ over: 0.012, into: 0.008, radius: 0.045, proud: 0.0015 });

/**
 * A gasket round an opening (counter-clockwise in the panel's (a, b)): from
 * `GASKET.over` out on the panel to `GASKET.into` in over the glass, where its
 * corners round off, so every window reads as a rounded pane in rubber.
 */
function gasket(opening: readonly Point2[], place: (a: number, b: number) => Vec3Tuple, normal: Vec3Tuple): Surface {
  const outer = insetOutline(opening, -GASKET.over);
  const inner = insetOutline(opening, GASKET.into);
  const surface = new Surface();
  const uv = finishUv("seal");
  const vertex = (point: Point2): number => surface.vertexAt(place(point[0], point[1]), uv);
  const count = inner.length;
  // Each corner of the inner outline, rounded: its arc's points, from the edge before to the edge after.
  const arcs: Point2[][] = [];
  for (let index = 0; index < count; index += 1) {
    const c = inner[index]!;
    const p = inner[(index + count - 1) % count]!;
    const q = inner[(index + 1) % count]!;
    const e1 = normalize2d([p[0] - c[0], p[1] - c[1]]);
    const e2 = normalize2d([q[0] - c[0], q[1] - c[1]]);
    const half = Math.acos(Math.min(1, Math.max(-1, e1[0] * e2[0] + e1[1] * e2[1]))) / 2;
    const room = Math.min(Math.hypot(p[0] - c[0], p[1] - c[1]), Math.hypot(q[0] - c[0], q[1] - c[1])) * 0.45;
    const r = Math.min(GASKET.radius, room * Math.tan(half));
    const t = r / Math.tan(half);
    const bisector = normalize2d([e1[0] + e2[0], e1[1] + e2[1]]);
    const centre: Point2 = [c[0] + (bisector[0] * r) / Math.sin(half), c[1] + (bisector[1] * r) / Math.sin(half)];
    const t1: Point2 = [c[0] + e1[0] * t, c[1] + e1[1] * t];
    const t2: Point2 = [c[0] + e2[0] * t, c[1] + e2[1] * t];
    const a1 = Math.atan2(t1[1] - centre[1], t1[0] - centre[0]);
    let a2 = Math.atan2(t2[1] - centre[1], t2[0] - centre[0]);
    // The short way round.
    while (a2 - a1 > Math.PI) a2 -= Math.PI * 2;
    while (a2 - a1 < -Math.PI) a2 += Math.PI * 2;
    const points: Point2[] = [];
    for (let k = 0; k <= 4; k += 1) {
      const angle = a1 + ((a2 - a1) * k) / 4;
      points.push([centre[0] + Math.cos(angle) * r, centre[1] + Math.sin(angle) * r]);
    }
    arcs.push(points);
  }
  for (let index = 0; index < count; index += 1) {
    const corner = vertex(outer[index]!);
    const arcIds = arcs[index]!.map(vertex);
    for (let k = 0; k < arcIds.length - 1; k += 1) surface.triFacing(corner, arcIds[k]!, arcIds[k + 1]!, normal);
    const next = (index + 1) % count;
    const nextCorner = vertex(outer[next]!);
    const from = arcIds[arcIds.length - 1]!;
    const to = vertex(arcs[next]![0]!);
    surface.triFacing(corner, from, to, normal);
    surface.triFacing(corner, to, nextCorner, normal);
  }
  return surface;
}

function normalize2d(vector: Point2): Point2 {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 1e-12 ? [vector[0] / length, vector[1] / length] : [0, 0];
}

function signedArea(outline: readonly Point2[]): number {
  let area = 0;
  for (let index = 0; index < outline.length; index += 1) {
    const [a0, b0] = outline[index]!;
    const [a1, b1] = outline[(index + 1) % outline.length]!;
    area += a0 * b1 - a1 * b0;
  }
  return area / 2;
}

/** The right side's glasshouse panel: A to D pillars, the bands, three windows. */
function sidePanel(): Panel {
  const b0 = BODY.belt;
  const b1 = SIDE_WINDOW_BOTTOM;
  const b2 = SIDE_WINDOW_TOP;
  const b3 = GLASSHOUSE.head;
  const pillar = 0.075;
  const [frontDoor, rearDoor, quarter] = SIDE_WINDOWS;
  const windowFront = (height: number): number => screenX(height) - pillar;
  const band = (from: number, to: number): Point2[] => [
    [rearX(from), from],
    [screenX(from), from],
    [screenX(to), to],
    [rearX(to), to],
  ];
  const strip = (rear: (height: number) => number, front: (height: number) => number): Point2[] => [
    [rear(b1), b1],
    [front(b1), b1],
    [front(b2), b2],
    [rear(b2), b2],
  ];
  const at = (x: number) => () => x;
  return {
    pieces: [
      band(b0, b1),
      band(b2, b3),
      strip(windowFront, screenX),
      strip(at(rearDoor!.front), at(frontDoor!.rear)),
      strip(at(quarter!.front), at(rearDoor!.rear)),
      strip(rearX, at(quarter!.rear)),
    ],
    openings: [
      strip(at(frontDoor!.rear), windowFront),
      strip(at(rearDoor!.rear), at(rearDoor!.front)),
      strip(at(quarter!.rear), at(quarter!.front)),
    ],
    place: (x, height) => [x, h(height), tumble(height)],
    outerUv: sideMap,
    trimSpan: (height) => [rearX(height) + D_PILLAR_TRIM, screenX(height) - SKIN],
  };
}

/** The windscreen's frame: its pillars' faces, the header and the cowl strip. (a, b) = (-z, height). */
function screenPanel(): Panel {
  const b0 = BODY.belt;
  const b1 = BODY.belt + 0.04;
  const b2 = GLASSHOUSE.head - 0.075;
  const b3 = GLASSHOUSE.head;
  const pillar = 0.07;
  const outer = (height: number): number => tumble(height);
  const innerEdge = (height: number): number => tumble(height) - pillar;
  const band = (from: number, to: number): Point2[] => [
    [-outer(from), from],
    [outer(from), from],
    [outer(to), to],
    [-outer(to), to],
  ];
  return {
    pieces: [
      band(b0, b1),
      band(b2, b3),
      [[-outer(b1), b1], [-innerEdge(b1), b1], [-innerEdge(b2), b2], [-outer(b2), b2]],
      [[innerEdge(b1), b1], [outer(b1), b1], [outer(b2), b2], [innerEdge(b2), b2]],
    ],
    openings: [[[-innerEdge(b1), b1], [innerEdge(b1), b1], [innerEdge(b2), b2], [-innerEdge(b2), b2]]],
    place: (a, height) => screenPoint(-a, height),
    outerUv: swatch("paint"),
    trimSpan: (height) => [-outer(height) + SKIN, outer(height) - SKIN],
  };
}

/** The rear barn doors' upper half: 60/40 split, a window in each. (a, b) = (z, height). */
export const REAR_DOOR_SPLIT_Z = -0.17;
function rearPanel(): Panel {
  const b0 = BODY.belt;
  const b1 = BODY.belt + 0.07;
  const b2 = GLASSHOUSE.head - 0.09;
  const b3 = GLASSHOUSE.head;
  const frame = 0.085;
  const mullion = 0.05;
  const outer = (height: number): number => tumble(height);
  const band = (from: number, to: number): Point2[] => [
    [-outer(from), from],
    [outer(from), from],
    [outer(to), to],
    [-outer(to), to],
  ];
  const strip = (left: (height: number) => number, right: (height: number) => number): Point2[] => [
    [left(b1), b1],
    [right(b1), b1],
    [right(b2), b2],
    [left(b2), b2],
  ];
  const at = (z: number) => () => z;
  const split = REAR_DOOR_SPLIT_Z;
  return {
    pieces: [
      band(b0, b1),
      band(b2, b3),
      strip((height) => -outer(height), (height) => -outer(height) + frame),
      strip(at(split - mullion), at(split + mullion)),
      strip((height) => outer(height) - frame, outer),
    ],
    openings: [
      strip((height) => -outer(height) + frame, at(split - mullion)),
      strip(at(split + mullion), (height) => outer(height) - frame),
    ],
    place: (z, height) => [rearX(height), h(height), z],
    outerUv: swatch("paint"),
    trimSpan: (height) => [-outer(height) + D_PILLAR_TRIM, outer(height) - D_PILLAR_TRIM],
  };
}

/**
 * The roof: a crowned panel on the glasshouse whose crown is flat across the
 * middle and rolls down at its sides, front and rear, pressed with four
 * shallow channels along it, as the 76's steel roof is. A drip rail runs
 * along each side over the doors, and the A pillars' outer edges are rolled.
 */
const ROOF_CHANNELS = Object.freeze({ at: [0.2, 0.5] as const, halfWidth: 0.028, depth: 0.004 });

function roofSurfaces(): { readonly symmetric: Surface[]; readonly single: Surface[] } {
  const front = GLASSHOUSE.screenHeadX;
  const rear = GLASSHOUSE.rearHeadX;
  const width = GLASSHOUSE.headHalfWidth;
  const crown = BODY.roof - GLASSHOUSE.head;
  // A superellipse: flat over the middle, rolling down over the last few centimetres.
  const roll = (distanceIn: number, reach: number): number => {
    const t = Math.min(1, Math.max(0, 1 - distanceIn / reach));
    return Math.sqrt(Math.max(0, 1 - t ** 6));
  };
  const channel = (z: number): number => {
    let depth = 0;
    for (const at of ROOF_CHANNELS.at) {
      const d = Math.abs(Math.abs(z) - at) / ROOF_CHANNELS.halfWidth;
      if (d < 1) depth = Math.max(depth, ROOF_CHANNELS.depth * 0.5 * (1 + Math.cos(Math.PI * d)));
    }
    return depth;
  };
  const xs: number[] = [];
  for (const d of [0, 0.006, 0.015, 0.03, 0.05, 0.08, 0.12, 0.2]) xs.push(front - d);
  for (let k = 1; k < 8; k += 1) xs.push(front - 0.2 - ((front - rear - 0.4) * k) / 8);
  for (const d of [0.2, 0.12, 0.08, 0.05, 0.03, 0.015, 0.006, 0]) xs.push(rear + d);
  const halfZs = new Set<number>([0]);
  for (let z = 0.06; z < width - 0.12; z += 0.06) halfZs.add(Number(z.toFixed(3)));
  for (const at of ROOF_CHANNELS.at) for (const d of [-1, -0.6, -0.3, 0, 0.3, 0.6, 1]) halfZs.add(Number((at + d * ROOF_CHANNELS.halfWidth).toFixed(4)));
  for (const d of [0.12, 0.08, 0.05, 0.03, 0.015, 0.006, 0]) halfZs.add(Number((width - d).toFixed(4)));
  const positive = [...halfZs].sort((p, q) => p - q);
  const zs = [...positive.slice(1).reverse().map((z) => -z), ...positive];
  const rows: Vec3Tuple[][] = xs.map((x) => zs.map((z): Vec3Tuple => {
    const lift = crown * roll(width - Math.abs(z), 0.12) * roll(Math.min(front - x, x - rear), 0.14) - channel(z);
    return [x, h(GLASSHOUSE.head + lift), z];
  }));
  const roof = new Surface();
  const paint = finishUv("paint");
  roof.grid(rows, () => paint);
  // The drip rail over the side glass, and the rolled edge of the A pillars.
  const rail: Vec3Tuple[] = [
    [rear + 0.01, h(GLASSHOUSE.head - 0.004), width + 0.004],
    [front - 0.01, h(GLASSHOUSE.head - 0.004), width + 0.004],
  ];
  const aPillar: Vec3Tuple[] = [];
  for (let k = 0; k <= 6; k += 1) {
    const height = BODY.belt + ((GLASSHOUSE.head - BODY.belt) * k) / 6;
    aPillar.push([screenX(height) - 0.004, h(height), tumble(height) - 0.004]);
  }
  return {
    symmetric: [
      ...tube(rail, 0.009, 8, swatch("paint")),
      ...tube(aPillar, 0.011, 8, swatch("paint")),
    ],
    single: [roof],
  };
}

/** The door mirror on the right: its sail, arm and black head, the glass on its back. */
function mirrorSurfaces(): Surface[] {
  const m = MIRROR;
  const black = swatch("blackPlastic");
  const surfaces: Surface[] = [
    // The sail on the door's corner, and the arm out to the head.
    ...roundedBox([m.armX - 0.07, h(BODY.belt - 0.012), BODY.halfWidth - 0.05], [m.armX + 0.02, h(BODY.belt + 0.095), BODY.halfWidth + 0.022], 0.014, black),
    ...tube([[m.headX, h(BODY.belt + 0.06), BODY.halfWidth + 0.01], [m.headX, h(BODY.belt + 0.075), m.headInner + 0.02]], 0.013, 8, black),
  ];
  // The head: a deep rounded box, its glass on the back.
  surfaces.push(...roundedPrismX(
    roundedRect(m.headInner, h(m.headHeight - m.headHalfHeight), m.headOuter, h(m.headHeight + m.headHalfHeight), 0.03, 3),
    m.headX - m.depth / 2,
    m.headX + m.depth / 2,
    { farRadius: 0.022, nearRadius: 0.006, segments: 3, faceUv: black },
  ));
  const x = m.headX - m.depth / 2 - 0.002;
  const inset = 0.012;
  surfaces.push(polygonSurface(
    roundedRect(m.headInner + inset, h(m.headHeight - m.headHalfHeight + inset), m.headOuter - inset, h(m.headHeight + m.headHalfHeight - inset), 0.022, 3),
    (z, y) => [x, y, z],
    swatch("mirrorGlass"),
  ));
  return surfaces;
}

/** The snorkel up the right A-pillar and its ram head, facing forward. */
function snorkelSurfaces(): Surface[] {
  const path = SNORKEL.path.map((point): Vec3Tuple => [point[0]!, h(point[1]!), point[2]!]);
  const top = path[path.length - 1]!;
  return [
    ...tube(path, SNORKEL.radius, 12, swatch("blackPlastic")),
    // The ram head: a rolled bucket over the tube's mouth, its slotted face forward.
    ...roundedBox([top[0] - 0.05, top[1] - 0.07, top[2] - 0.065], [top[0] + 0.085, top[1] + 0.055, top[2] + 0.065], 0.034, swatch("blackPlastic"), 3),
    ...[-0.03, 0, 0.03].flatMap((dy) =>
      roundedBox([top[0] + 0.081, top[1] - 0.012 + dy, top[2] - 0.04], [top[0] + 0.088, top[1] + 0.002 + dy, top[2] + 0.04], 0.005, swatch("seal"))),
    // Standoff brackets to the pillar.
    ...bar([path[2]![0], path[2]![1], path[2]![2] - 0.03], [path[2]![0] - 0.02, path[2]![1], tumble(1.36) - 0.01], 0.01, 5, swatch("blackPlastic")),
    ...bar([path[3]![0], path[3]![1], path[3]![2] - 0.03], [path[3]![0] - 0.02, path[3]![1], tumble(1.8) - 0.01], 0.01, 5, swatch("blackPlastic")),
  ];
}

/**
 * A band pressed 4 mm proud of the rear panel at `x`, `outline` in (z, y):
 * its edges ramp up over 2.5 cm rather than roll, so from the chase camera
 * they shade as a soft crease a few pixels wide, not a sub-pixel highlight
 * that breaks into dashes.
 */
function pressedBand(outline: readonly Point2[], x: number): Surface[] {
  const rise = 0.004;
  const ramp = 0.025;
  const ccw = signedArea(outline) > 0 ? outline : [...outline].reverse();
  const top = insetOutline(ccw, ramp);
  const uv = swatch("paint");
  const facing: Vec3Tuple = [-1, 0, 0];
  const edge = new Surface();
  // From 1 mm inside the panel, so the ramp leaves it without a crack.
  const foot = ccw.map(([a, b]) => edge.vertexAt([x + 0.001, b, a], uv([x, b, a])));
  const head = top.map(([a, b]) => edge.vertexAt([x - rise, b, a], uv([x, b, a])));
  for (let index = 0; index < ccw.length; index += 1) {
    const next = (index + 1) % ccw.length;
    edge.triFacing(foot[index]!, foot[next]!, head[next]!, facing);
    edge.triFacing(foot[index]!, head[next]!, head[index]!, facing);
  }
  return [edge, polygonSurface(top, (a, b) => [x - rise, b, a], uv)];
}

/** The rear doors' split line, handle and plate, and the quarters' seams. */
function rearDetailSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const x = BODY.rear - 0.0015;
  const z = REAR_DOOR_SPLIT_Z;
  // The split between the barn doors: a dark gap with the doors' edges either side.
  surfaces.push(quad([x, h(BODY.rearBottom + 0.02), z - 0.003], [x, h(BODY.rearBottom + 0.02), z + 0.003], [x, h(BODY.belt), z + 0.003], [x, h(BODY.belt), z - 0.003], swatch("seal")));
  // The right door's handle, by the split, and the plate under it.
  surfaces.push(...roundedBox([x - 0.028, h(1.168), z + 0.06], [x + 0.005, h(1.205), z + 0.2], 0.008, swatch("blackPlastic")));
  surfaces.push(...plateSurfaces(x, -1, 0.74, 0.3));
  // A pressed band across both doors at the lamps' height.
  for (const [from, to] of [[-SHELL_SPLIT_Z + 0.06, z - 0.03], [z + 0.03, SHELL_SPLIT_Z - 0.06]] as const) {
    surfaces.push(...pressedBand(roundedRect(from, h(0.9), to, h(0.98), 0.02, 3), BODY.rear));
  }
  // The doors' exposed hinges on their outer edges, two each, and the tail lamps' black housings.
  for (const side of [-1, 1]) {
    for (const height of [0.8, 1.2]) {
      const z0 = side * (SHELL_SPLIT_Z - 0.1);
      surfaces.push(...roundedBox([x - 0.02, h(height - 0.035), Math.min(z0, z0 + side * 0.05)], [x + 0.004, h(height + 0.035), Math.max(z0, z0 + side * 0.05)], 0.007, swatch("blackPlastic")));
    }
    // The mud flap behind each rear wheel.
    surfaces.push(...roundedBox([RA - 0.5, h(0.24), side * (LC76_REAR_TRACK / 2) - 0.15], [RA - 0.488, h(0.6), side * (LC76_REAR_TRACK / 2) + 0.15], 0.005, swatch("rubber")));
    const zIn = TAIL_LAMP.inner;
    const zOut = TAIL_LAMP.outer;
    const [z0, z1] = side > 0 ? [zIn, zOut] : [-zOut, -zIn];
    surfaces.push(...roundedBox([BODY.rear - 0.008, h(TAIL_LAMP.bottom), z0], [BODY.rear + 0.004, h(TAIL_LAMP.top), z1], 0.008, swatch("blackPlastic")));
  }
  return surfaces;
}

/** What hangs under the floor: rails, crossmembers, sump, gearbox and transfer case, exhaust and muffler. */
function underbodySurfaces(): { readonly symmetric: Surface[]; readonly single: Surface[] } {
  const chassis = swatch("chassis");
  const symmetric = [
    ...box([BODY.bumperRear + 0.05, h(0.46), 0.37], [BODY.front - 0.12, h(FLOOR_PAN.cabin + 0.005), 0.49], chassis, 0.006),
  ];
  const single: Surface[] = [];
  for (const x of [FA + 0.55, 0.12, -0.75, RA - 0.62]) {
    single.push(...box([x - 0.04, h(0.5), -0.37], [x + 0.04, h(0.58), 0.37], chassis, 0.004));
  }
  single.push(...box([FA - 0.42, h(0.55), -0.22], [FA + 0.28, h(FLOOR_PAN.cabin + 0.005), 0.2], swatch("axle"), 0.02));
  single.push(...box([-0.36, h(0.41), -0.17], [0.32, h(FLOOR_PAN.cabin + 0.005), 0.16], swatch("axle"), 0.03));
  single.push(...box([-0.85, h(0.47), -0.74], [-0.25, h(0.6), -0.52], swatch("exhaust"), 0.03));
  single.push(...tube(
    [
      [FA + 0.1, h(0.56), -0.24],
      [0.35, h(0.5), -0.28],
      [-0.2, h(0.52), -0.62],
      [-0.9, h(0.53), -0.62],
      [-2.0, h(0.56), -0.62],
      [EXHAUST_TIP[0], EXHAUST_TIP[1], EXHAUST_TIP[2]],
    ],
    0.03,
    8,
    swatch("exhaust"),
  ));
  return { symmetric, single };
}

/** The exhaust's tip, body frame, for the exhaust puffs: behind the rear wheel on the left, pointing out. */
export const EXHAUST_TIP: Vec3Tuple = Object.freeze([RA - 0.86, h(0.52), -0.72]) as Vec3Tuple;

/** The cabin's inner skin below the belt: floors, door cards and armrests, the cargo bay's walls. */
function cabinShellSurfaces(): { readonly symmetric: Surface[]; readonly single: Surface[] } {
  // Just inside the side slabs' inner faces: the door tops above are the slabs' painted steel.
  const wall = SHELL_SPLIT_Z - 0.005;
  const cabinFloor = 0.68;
  const cargoFloor = 0.76;
  const step = -1.45;
  const front = BODY.cowlX - 0.06;
  const back = BODY.rear + 0.04;
  const carpet = swatch("carpet");
  const trim = swatch("trim");
  const single: Surface[] = [
    quad([front, h(cabinFloor), wall], [front, h(cabinFloor), -wall], [step, h(cabinFloor), -wall], [step, h(cabinFloor), wall], carpet),
    quad([step, h(cargoFloor), wall], [step, h(cargoFloor), -wall], [back, h(cargoFloor), -wall], [back, h(cargoFloor), wall], carpet),
    quad([step, h(cabinFloor), -wall], [step, h(cabinFloor), wall], [step, h(cargoFloor), wall], [step, h(cargoFloor), -wall], carpet).flipped(),
    // The barn doors' inside.
    quad([back, h(cargoFloor), -wall], [back, h(cargoFloor), wall], [back, h(BODY.belt), wall], [back, h(BODY.belt), -wall], trim).flipped(),
  ];
  const symmetric: Surface[] = [
    quad([front, h(cabinFloor), wall], [back, h(cabinFloor), wall], [back, h(BODY.belt), wall], [front, h(BODY.belt), wall], trim),
    // The rear wheels' tubs, boxed in under the bench and the cargo floor.
    ...box([RA - ARCH.halfWidth, h(cabinFloor - 0.02), 0.56], [RA + ARCH.halfWidth, h(ARCH.height + WHEEL_HEIGHT + 0.03), wall + 0.004], trim, 0.04),
  ];
  for (const [from, to] of [[0.72, -0.38], [-0.44, -1.3]] as const) {
    symmetric.push(...box([to, h(1.07), wall - 0.05], [from, h(1.12), wall + 0.005], trim, 0.012));
  }
  return { symmetric, single };
}

export interface CarBodySurfaces {
  /** Built on the right; the mesh adds each with its mirror image. */
  readonly symmetric: readonly Surface[];
  readonly single: readonly Surface[];
  readonly glass: readonly Surface[];
}

/** Every static part of the body and its glass, body frame. */
export function carBodySurfaces(): CarBodySurfaces {
  const shell = shellSurfaces();
  const roof = roofSurfaces();
  const under = underbodySurfaces();
  const cabin = cabinShellSurfaces();
  const side: GlasshouseParts = { outer: [], inner: [], glass: [] };
  buildPanel(sidePanel(), side, "trim");
  const ends: GlasshouseParts = { outer: [], inner: [], glass: [] };
  buildPanel(screenPanel(), ends, "dash");
  buildPanel(rearPanel(), ends, "trim");
  const headliner = quad(
    [GLASSHOUSE.screenHeadX - SKIN, h(GLASSHOUSE.head - 0.012), GLASSHOUSE.headHalfWidth - SKIN],
    [GLASSHOUSE.rearHeadX + SKIN, h(GLASSHOUSE.head - 0.012), GLASSHOUSE.headHalfWidth - SKIN],
    [GLASSHOUSE.rearHeadX + SKIN, h(GLASSHOUSE.head - 0.012), -(GLASSHOUSE.headHalfWidth - SKIN)],
    [GLASSHOUSE.screenHeadX - SKIN, h(GLASSHOUSE.head - 0.012), -(GLASSHOUSE.headHalfWidth - SKIN)],
    swatch("headliner"),
  );
  return {
    symmetric: [
      ...shell.side,
      ...flareSurfaces(FA, BODY.sill, BODY.frontBottom),
      ...flareSurfaces(RA, BODY.rearBottom, BODY.sill),
      ...stepSurfaces(),
      ...linerSurfaces(),
      ...mirrorSurfaces(),
      ...side.outer,
      ...side.inner,
      dPillarTrim(),
      ...roof.symmetric,
      ...under.symmetric,
      ...cabin.symmetric,
    ],
    single: [
      ...shell.centre,
      ...bonnetSurfaces(),
      ...frontBumperSurfaces(),
      ...rearBumperSurfaces(),
      ...frontSurfaces(),
      ...wiperSurfaces(),
      ...ends.outer,
      ...ends.inner,
      ...roof.single,
      ...snorkelSurfaces(),
      ...rearDetailSurfaces(),
      ...under.single,
      ...cabin.single,
      headliner,
    ],
    glass: [...side.glass, ...side.glass.map((surface) => surface.mirrored()), ...ends.glass],
  };
}

/** The lamp lenses' texels in the lamp material's `CAR_LAMP_TEXEL_COUNT` x 1 textures. */
export const CAR_LAMP_TEXELS = Object.freeze({
  headlamp: 0,
  dayRunning: 1,
  tail: 2,
  reverse: 3,
  indicator: 4,
  highStop: 5,
  /** The headlamps' reflector dishes, which brighten with the beams. */
  reflector: 6,
  fog: 7,
});
export const CAR_LAMP_TEXEL_COUNT = 8;

function lampUv(texel: number): UvFor {
  const uv: readonly [number, number] = [(texel + 0.5) / CAR_LAMP_TEXEL_COUNT, 0.5];
  return () => uv;
}

/**
 * The lamps' lenses, body frame: the round headlamps inside their LED
 * day-running rings, the amber indicators on the guards' corners, the rear
 * clusters (indicator over tail-and-stop over reversing) and the high stop
 * lamp over the rear doors.
 */
export function carLampSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  for (const side of [-1, 1]) {
    const centre: readonly [number, number] = [h(HEADLAMP.height), side * HEADLAMP.halfSpacing];
    // The reflector's dish, the projector's lens in its middle, the day-running ring round its rim.
    const dish: Point2[] = [];
    for (let k = 0; k <= 5; k += 1) {
      const radius = HEADLAMP.radius - ((HEADLAMP.radius - 0.04) * k) / 5;
      dish.push([radius, headlampBowlX(radius)]);
    }
    surfaces.push(latheX(dish, 36, centre, lampUv(CAR_LAMP_TEXELS.reflector), () => [1, 0, 0]));
    const lensBase = headlampBowlX(0.04) + 0.01;
    surfaces.push(latheX(
      [[0.032, lensBase], [0.028, lensBase + 0.006], [0.019, lensBase + 0.011], [0.008, lensBase + 0.0135], [0, lensBase + 0.014]],
      24, centre, lampUv(CAR_LAMP_TEXELS.headlamp), () => [1, 0, 0],
    ));
    surfaces.push(ring([HEADLAMP_RIM_X - 0.0015, centre[0], centre[1]], [1, 0, 0], HEADLAMP.radius - 0.014, HEADLAMP.radius - 0.004, 36, lampUv(CAR_LAMP_TEXELS.dayRunning)));
    // The indicators in their surrounds on the guards' noses.
    const zIn = SHELL_SPLIT_Z + 0.015;
    const zOut = BODY.halfWidth - 0.035;
    const [z0, z1] = side > 0 ? [zIn, zOut] : [-zOut, -zIn];
    surfaces.push(...roundedBox([BODY.front, h(0.791), z0], [BODY.front + 0.011, h(0.854), z1], 0.004, lampUv(CAR_LAMP_TEXELS.indicator)));
    // The fog lamps in the bumper's face.
    surfaces.push(disc([BODY.bumperFront + 0.004, h(FOG_LAMP.height), side * FOG_LAMP.halfSpacing], [1, 0, 0], FOG_LAMP.radius, 24, lampUv(CAR_LAMP_TEXELS.fog)));
  }
  const rear = BODY.rear;
  for (const side of [-1, 1]) {
    const zIn = TAIL_LAMP.inner + 0.006;
    const zOut = TAIL_LAMP.outer - 0.006;
    const [z0, z1] = side > 0 ? [zIn, zOut] : [-zOut, -zIn];
    const cluster = (from: number, to: number, texel: number): Surface[] =>
      roundedBox([rear - TAIL_LAMP.proud - 0.004, h(from), z0], [rear - 0.004, h(to), z1], 0.005, lampUv(texel));
    surfaces.push(...cluster(0.948, TAIL_LAMP.top - 0.006, CAR_LAMP_TEXELS.indicator));
    surfaces.push(...cluster(0.8, 0.942, CAR_LAMP_TEXELS.tail));
    surfaces.push(...cluster(TAIL_LAMP.bottom + 0.006, 0.794, CAR_LAMP_TEXELS.reverse));
  }
  const top = GLASSHOUSE.head - 0.012;
  surfaces.push(...box(
    [rearX(top) - 0.016, h(top - 0.03), -0.12],
    [rearX(top) + 0.004, h(top), 0.12],
    lampUv(CAR_LAMP_TEXELS.highStop),
    0.004,
  ));
  return surfaces;
}
