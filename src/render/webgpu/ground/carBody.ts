import { polygonSurface, Surface, type Vec3Tuple } from "../boat/boatMeshData";
import { finishUv, grilleUv, sideUv, type CarFinish } from "./carAtlas";
import {
  arc,
  bar,
  box,
  cross3,
  disc,
  insetOutline,
  normalize3,
  outlineArea,
  partitionSurface,
  prismX,
  prismY,
  prismZ,
  quad,
  revealBand,
  ring,
  splitByRegion,
  tube,
  type HalfPlane,
  type Point2,
  type PrismOptions,
  type UvFor,
} from "./carShapes";
import {
  A_PILLAR_WIDTH,
  ARCH,
  BODY,
  BUMPERS,
  DOOR_LINES,
  GLASSHOUSE,
  GROUND_Y,
  h,
  HEADLAMP,
  LC76_FRONT_AXLE_X,
  LC76_REAR_AXLE_X,
  LC76_TYRE_LOADED_RADIUS,
  MIRROR,
  SIDE_WINDOW_BOTTOM,
  SIDE_WINDOW_TOP,
  SIDE_WINDOWS,
  SNORKEL,
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

/**
 * The front door's leading edge at a height: raked from behind the flare to
 * the A pillar's foot below the belt, the pillar's rear edge above it.
 */
export function frontDoorEdgeX(height: number): number {
  if (height <= BODY.belt) {
    const t = (height - DOOR_LINES.frontDoorBottom) / (BODY.belt - DOOR_LINES.frontDoorBottom);
    return DOOR_LINES.frontDoorFoot + (DOOR_LINES.frontDoorBelt - DOOR_LINES.frontDoorFoot) * t;
  }
  return screenX(height) - A_PILLAR_WIDTH;
}

/**
 * The front door in the side glasshouse's (x, height): behind the A pillar,
 * ahead of its shut line at the B pillar, under the gutter.
 */
function frontDoorGlasshouseRegion(): HalfPlane[] {
  // x <= screenX(height) - pillar, with screenX linear in height.
  const rake = (GLASSHOUSE.screenHeadX - GLASSHOUSE.screenFootX) / GH_SPAN;
  const atBelt = GLASSHOUSE.screenFootX - A_PILLAR_WIDTH;
  return [
    { a: 1, b: 0, c: -DOOR_LINES.frontDoorRear },
    { a: -1, b: rake, c: atBelt - rake * BODY.belt },
    { a: 0, b: -1, c: DOOR_LINES.doorTop },
  ];
}

const SHELL_CHAMFER = 0.014;

/**
 * The right side slab, its front door cut out. The door's corners on the
 * belt join the outline (on its straight top, so nothing there moves), the
 * flat faces are the door and the slab round it, sharing their corners, and
 * the rim over the door goes with it. Jambs close the cut on both sides,
 * inside the slab while the door is shut.
 */
function sideSlabSurfaces(options: PrismOptions): { readonly body: Surface[]; readonly door: Surface[] } {
  const bottom = DOOR_LINES.frontDoorBottom;
  const rearX = DOOR_LINES.frontDoorRear;
  // The door's front corner on the belt: where its edge meets the faces' inset top.
  const insetTop = BODY.belt - SHELL_CHAMFER;
  const frontX = frontDoorEdgeX(insetTop);
  const outline: Point2[] = [];
  for (const point of shellOutline(BODY.sill, BODY.rearBottom)) {
    const previous = outline[outline.length - 1];
    if (previous && previous[1] === BODY.belt && point[1] === BODY.belt) {
      // The top edge, front to rear: the door's corners sit on it.
      const along = [frontX, rearX].filter((x) => (x - previous[0]) * (x - point[0]) < 0);
      if (point[0] > previous[0]) along.reverse();
      for (const x of along) outline.push([x, BODY.belt]);
    }
    outline.push(point);
  }
  const elevated = elevation(outline);
  const ccw = outlineArea(elevated) > 0 ? elevated : [...elevated].reverse();
  const inset = insetOutline(ccw, SHELL_CHAMFER);
  const corner = (x: number): number => ccw.findIndex((point) => point[0] === x && point[1] === h(BODY.belt));
  const frontCorner = corner(frontX);
  const rearCorner = corner(rearX);
  const doorBottomFront: Point2 = [DOOR_LINES.frontDoorFoot, h(bottom)];
  const doorBottomRear: Point2 = [rearX, h(bottom)];
  const door: Point2[] = [doorBottomRear, doorBottomFront, inset[frontCorner]!, inset[rearCorner]!];
  // The slab's faces: the inset outline with the door notched into its top.
  const notched: Point2[] = [];
  for (const [index, point] of inset.entries()) {
    notched.push(point);
    if (index === frontCorner && (index + 1) % inset.length === rearCorner) notched.push(doorBottomFront, doorBottomRear);
    if (index === rearCorner && (index + 1) % inset.length === frontCorner) notched.push(doorBottomRear, doorBottomFront);
  }
  const far = (a: number, b: number): Vec3Tuple => [a, b, BODY.halfWidth];
  const near = (a: number, b: number): Vec3Tuple => [a, b, SHELL_SPLIT_Z];
  const nearUv = options.nearFaceUv ?? options.faceUv;
  const body: Surface[] = [polygonSurface(notched, far, options.faceUv), polygonSurface(notched, near, nearUv).flipped()];
  const doorSurfaces: Surface[] = [polygonSurface(door, far, options.faceUv), polygonSurface(door, near, nearUv).flipped()];
  for (const rim of prismZ(ccw, SHELL_SPLIT_Z, BODY.halfWidth, { ...options, skipFarFace: true, skipNearFace: true })) {
    const [overDoor, rest] = partitionSurface(rim, ([x, y]) => x > rearX && x < frontX && y > h(BODY.belt - 0.05));
    if (overDoor.indices.length > 0) doorSurfaces.push(overDoor);
    if (rest.indices.length > 0) body.push(rest);
  }
  // The jambs: the cut's three faces through the slab, with its chamfered
  // profile at the belt. The body's show into the opening, the door's out of it.
  const rimUv = options.rimUv ?? options.faceUv;
  const yBottom = h(bottom);
  const yInset = h(insetTop);
  const profile: Point2[] = [
    [SHELL_SPLIT_Z, yBottom],
    [BODY.halfWidth, yBottom],
    [BODY.halfWidth, yInset],
    [BODY.halfWidth - SHELL_CHAMFER, h(BODY.belt)],
    [SHELL_SPLIT_Z + SHELL_CHAMFER, h(BODY.belt)],
    [SHELL_SPLIT_Z, yInset],
  ];
  // In (z, y), counter-clockwise shows -X: the door's trailing jamb, the body's leading one.
  const trailing = polygonSurface(profile, (z, y) => [rearX, y, z], rimUv);
  const leadingX = (y: number): number => DOOR_LINES.frontDoorFoot + ((frontX - DOOR_LINES.frontDoorFoot) * (y - yBottom)) / (yInset - yBottom);
  const leading = polygonSurface(profile, (z, y) => [leadingX(y), y, z], rimUv);
  // In (x, z), counter-clockwise shows -Y: the door's bottom.
  const sill = polygonSurface(
    [[rearX, SHELL_SPLIT_Z], [DOOR_LINES.frontDoorFoot, SHELL_SPLIT_Z], [DOOR_LINES.frontDoorFoot, BODY.halfWidth], [rearX, BODY.halfWidth]],
    (x, z) => [x, yBottom, z],
    rimUv,
  );
  body.push(trailing.flipped(), leading, sill.flipped());
  doorSurfaces.push(trailing, leading.flipped(), sill);
  return { body, door: doorSurfaces };
}

/** The steel shell: right side slab (mirrored for the left) and the centre body. */
function shellSurfaces(): { readonly side: Surface[]; readonly door: Surface[]; readonly centre: Surface[] } {
  const slab = sideSlabSurfaces({
    chamfer: SHELL_CHAMFER,
    creaseRadians: 0.5,
    faceUv: sideMap,
    // Its inner face shows only under the floor pan and in the arches.
    nearFaceUv: swatch("underbody"),
    rimUv: shellRimUv,
  });
  const centre = prismZ(elevation(shellOutline(FLOOR_PAN.cabin, FLOOR_PAN.cargo)), -SHELL_SPLIT_Z, SHELL_SPLIT_Z, {
    chamfer: 0.014,
    creaseRadians: 0.5,
    faceUv: swatch("paint"),
    rimUv: shellRimUv,
    skipNearFace: true,
    skipFarFace: true,
    // No lid at the belt: the cabin and the cargo bay are open to the glasshouse.
    openRim: (point) => Math.abs(point[1] - h(BODY.belt)) < 0.02 && point[0] < GLASSHOUSE.screenFootX - 0.005 && point[0] > BODY.rear + 0.005,
  });
  return { side: slab.body, door: slab.door, centre };
}

/** A flare: a black moulding round an arch, from foot to foot, standing proud of the flank. */
function flareSurfaces(centreX: number, rearFoot: number, frontFoot: number): Surface[] {
  const outer = archOutline(centreX, ARCH.halfWidth + ARCH.flareWidth, ARCH.height + ARCH.flareWidth, rearFoot, frontFoot);
  const inner = archOutline(centreX, ARCH.halfWidth - 0.01, ARCH.height - 0.01, rearFoot, frontFoot);
  return prismZ(elevation([...outer, ...inner.reverse()]), BODY.halfWidth - 0.03, BODY.flareHalfWidth, {
    chamfer: 0.016,
    creaseRadians: 0.7,
    faceUv: swatch("blackPlastic"),
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
  return prismY(outline, h(0.47), h(0.5), { chamfer: 0.008, faceUv: swatch("blackPlastic") });
}

/** The front bumper: a steel bar wrapped round the corners, a black valance under it, the plate. */
function frontBumperSurfaces(): Surface[] {
  const face = BODY.bumperFront;
  const back = BODY.front - 0.1;
  const plan: Point2[] = [
    [back, -0.93],
    [face - 0.13, -0.93],
    [face - 0.025, -0.86],
    [face, -0.79],
    [face, 0.79],
    [face - 0.025, 0.86],
    [face - 0.13, 0.93],
    [back, 0.93],
  ];
  const valanceTop = BUMPERS.frontBottom + 0.06;
  const surfaces = [
    ...prismY(plan, h(valanceTop), h(BUMPERS.frontTop), { chamfer: 0.018, creaseRadians: 0.45, faceUv: swatch("bumper") }),
    ...prismY(
      plan.map(([x, z]) => [Math.min(x, face - 0.04), z * 0.97] as Point2),
      h(BUMPERS.frontBottom),
      h(valanceTop + 0.01),
      { chamfer: 0.01, creaseRadians: 0.45, faceUv: swatch("blackPlastic") },
    ),
  ];
  // The plate, 372 x 134 mm, on the bar's face.
  surfaces.push(...plateSurfaces(face, 1, valanceTop + 0.035, 0));
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

/** The rear bumper, its step pad and the tow hitch's receiver. */
function rearBumperSurfaces(): Surface[] {
  const face = BODY.bumperRear;
  const back = BODY.rear + 0.1;
  const plan: Point2[] = [
    [back, -0.9],
    [back, 0.9],
    [face + 0.06, 0.9],
    [face, 0.84],
    [face, -0.84],
    [face + 0.06, -0.9],
  ];
  return [
    ...prismY(plan, h(BUMPERS.rearBottom), h(BUMPERS.rearTop), { chamfer: 0.016, creaseRadians: 0.45, faceUv: swatch("bumper") }),
    ...box([face - 0.004, h(BUMPERS.rearTop) - 0.004, -0.25], [face + 0.12, h(BUMPERS.rearTop) + 0.008, 0.25], swatch("rubber"), 0.004),
    ...box([BODY.towHitch, h(0.47), -0.035], [BODY.rear + 0.2, h(0.54), 0.035], swatch("chassis"), 0.006),
    ...box([BODY.towHitch + 0.004, h(0.49), -0.012], [BODY.towHitch + 0.06, h(0.52), 0.012], swatch("lugNut")),
  ];
}

/** The headlamps' chrome bezels stand proud of their pods (whose face is 12 mm out); the lenses sit just behind the bezels. */
const HEADLAMP_BEZEL_X = BODY.front + 0.017;
const HEADLAMP_LENS_X = BODY.front + 0.014;

/** The grille, the headlamps' black pods and chrome bezels, the bonnet scoop. */
function frontSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const grille = { halfWidth: 0.525, bottom: 0.865, top: 1.135 };
  surfaces.push(...prismX(
    [
      [-grille.halfWidth, h(grille.bottom)],
      [grille.halfWidth, h(grille.bottom)],
      [grille.halfWidth, h(grille.top)],
      [-grille.halfWidth, h(grille.top)],
    ],
    BODY.front - 0.01,
    BODY.front + 0.015,
    {
      chamfer: 0.008,
      // Seen from ahead, +Z is on the left: the grille's s runs from +z to -z.
      faceUv: (point) => grilleUv((grille.halfWidth - point[2]) / (2 * grille.halfWidth), (point[1] - GROUND_Y - grille.bottom) / (grille.top - grille.bottom)),
      rimUv: swatch("blackPlastic"),
      skipNearFace: true,
    },
  ));
  for (const side of [-1, 1]) {
    const z = side * HEADLAMP.halfSpacing;
    const pod = 0.115;
    const pts: Point2[] = [];
    // A rounded square round the lamp: four quarter arcs.
    const round = 0.04;
    for (const [cz, cy, from] of [
      [z + pod - round, HEADLAMP.height - pod + round, -Math.PI / 2],
      [z + pod - round, HEADLAMP.height + pod - round, 0],
      [z - pod + round, HEADLAMP.height + pod - round, Math.PI / 2],
      [z - pod + round, HEADLAMP.height - pod + round, Math.PI],
    ] as const) {
      pts.push(...arc([cz, h(cy)], round, from, from + Math.PI / 2, 3));
    }
    surfaces.push(...prismX(pts, BODY.front - 0.01, BODY.front + 0.012, {
      chamfer: 0.006,
      faceUv: swatch("grilleBlack"),
      skipNearFace: true,
    }));
    surfaces.push(ring([HEADLAMP_BEZEL_X, h(HEADLAMP.height), z], [1, 0, 0], HEADLAMP.radius, HEADLAMP.radius + 0.013, 28, swatch("chrome")));
    // The bezel's lip: a short barrel from the pod's face round the lens.
    surfaces.push(...tube(
      [[BODY.front + 0.01, h(HEADLAMP.height), z], [HEADLAMP_BEZEL_X, h(HEADLAMP.height), z]],
      HEADLAMP.radius + 0.013,
      28,
      swatch("chrome"),
      false,
    ));
  }
  // The bonnet scoop: a raised intake on the bonnet's centre line, its mouth forward.
  const bonnetAt = (x: number): number =>
    BODY.bonnetFront + ((BODY.bonnetCowl - BODY.bonnetFront) * (BODY.front - 0.045 - x)) / (BODY.front - 0.045 - BODY.cowlX);
  const scoopRear = FA - 0.15;
  const scoopFront = FA + 0.38;
  const scoop: Point2[] = [
    [scoopRear, bonnetAt(scoopRear) - 0.02],
    [scoopFront, bonnetAt(scoopFront) - 0.02],
    [scoopFront, bonnetAt(scoopFront) + 0.058],
    [scoopFront - 0.07, bonnetAt(scoopFront - 0.07) + 0.066],
    [scoopRear + 0.05, bonnetAt(scoopRear + 0.05) + 0.012],
  ];
  surfaces.push(...prismZ(scoop.map(([x, height]) => [x, h(height)] as Point2), -0.27, 0.27, {
    chamfer: 0.014,
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
}

interface GlasshouseParts {
  readonly outer: Surface[];
  readonly inner: Surface[];
  readonly glass: Surface[];
}

/**
 * A panel's outer skin, inner trim, reveals and glass. With a `door`, the
 * panel's part inside the door's region (convex, in the panel's (a, b)) and
 * the openings wholly inside it go to the door's parts instead.
 */
function buildPanel(
  panel: Panel,
  parts: GlasshouseParts,
  innerFinish: CarFinish,
  door?: { readonly region: readonly HalfPlane[]; readonly parts: GlasshouseParts },
): void {
  const n = planeNormal(panel.place);
  const offset = (depth: number) => (a: number, b: number): Vec3Tuple => {
    const p = panel.place(a, b);
    return [p[0] - n[0] * depth, p[1] - n[1] * depth, p[2] - n[2] * depth];
  };
  const inner = offset(SKIN);
  const glass = offset(GLASS_DEPTH);
  const skin = (piece: readonly Point2[], into: GlasshouseParts): void => {
    into.outer.push(polygonSurface(piece, panel.place, panel.outerUv));
    into.inner.push(polygonSurface(piece, inner, swatch(innerFinish)).flipped());
  };
  for (const piece of panel.pieces) {
    if (!door) {
      skin(piece, parts);
      continue;
    }
    const ccw = signedArea(piece) > 0 ? piece : [...piece].reverse();
    const split = splitByRegion(ccw, door.region);
    if (split.inside) skin(split.inside, door.parts);
    for (const outside of split.outside) skin(outside, parts);
  }
  for (const opening of panel.openings) {
    const ccw = signedArea(opening) > 0 ? opening : [...opening].reverse();
    const into = door && ccw.every(([a, b]) => door.region.every((plane) => plane.a * a + plane.b * b + plane.c >= -1e-9))
      ? door.parts
      : parts;
    into.outer.push(...revealBand(ccw.map(([a, b]) => panel.place(a, b)), [-n[0] * SKIN, -n[1] * SKIN, -n[2] * SKIN], swatch("seal")));
    into.glass.push(polygonSurface(ccw, glass, swatch("seal")));
  }
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
  const pillar = A_PILLAR_WIDTH;
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
  };
}

/** The roof: a gently crowned panel on the glasshouse, its gutters along the sides. */
function roofSurfaces(): { readonly symmetric: Surface[]; readonly single: Surface[] } {
  const front = GLASSHOUSE.screenHeadX;
  const rear = GLASSHOUSE.rearHeadX;
  const width = GLASSHOUSE.headHalfWidth;
  const crown = BODY.roof - GLASSHOUSE.head;
  const ease = (x: number): number => {
    const d = Math.min(x - rear, front - x) / 0.14;
    const t = Math.min(1, Math.max(0, d));
    return t * t * (3 - 2 * t);
  };
  const rows: Vec3Tuple[][] = [];
  const stations = 16;
  const girth = 12;
  for (let i = 0; i <= stations; i += 1) {
    const x = front + ((rear - front) * i) / stations;
    const row: Vec3Tuple[] = [];
    for (let j = 0; j <= girth; j += 1) {
      const z = -width + (2 * width * j) / girth;
      const lift = crown * (1 - (z / width) ** 2) * ease(x);
      row.push([x, h(GLASSHOUSE.head + lift), z]);
    }
    rows.push(row);
  }
  const roof = new Surface();
  const paint = finishUv("paint");
  roof.grid(rows, () => paint);
  const gutter = box([rear - 0.005, h(GLASSHOUSE.head - 0.026), width - 0.006], [front + 0.005, h(GLASSHOUSE.head + 0.005), width + 0.013], swatch("paint"), 0.005);
  return { symmetric: gutter, single: [roof] };
}

/** The door mirror on the right: its sail, arm and black head, the glass on its back. */
function mirrorSurfaces(): Surface[] {
  const m = MIRROR;
  const surfaces: Surface[] = [
    ...box([m.armX - 0.06, h(BODY.belt - 0.01), BODY.halfWidth - 0.04], [m.armX + 0.025, h(BODY.belt + 0.1), BODY.halfWidth + 0.03], swatch("blackPlastic"), 0.01),
    ...box([m.headX - 0.016, h(BODY.belt + 0.05), BODY.halfWidth + 0.02], [m.headX + 0.016, h(BODY.belt + 0.09), m.headInner + 0.01], swatch("blackPlastic"), 0.006),
  ];
  const round = 0.025;
  const head: Point2[] = [];
  for (const [cz, cy, from] of [
    [m.headInner + round, m.headHeight - m.headHalfHeight + round, Math.PI],
    [m.headOuter - round, m.headHeight - m.headHalfHeight + round, -Math.PI / 2],
    [m.headOuter - round, m.headHeight + m.headHalfHeight - round, 0],
    [m.headInner + round, m.headHeight + m.headHalfHeight - round, Math.PI / 2],
  ] as const) {
    head.push(...arc([cz, cy], round, from, from + Math.PI / 2, 2));
  }
  surfaces.push(...prismX(head.map(([z, height]) => [z, h(height)] as Point2), m.headX - m.depth / 2, m.headX + m.depth / 2, {
    chamfer: 0.012,
    faceUv: swatch("blackPlastic"),
  }));
  const x = m.headX - m.depth / 2 - 0.002;
  const inset = 0.014;
  surfaces.push(quad(
    [x, h(m.headHeight - m.headHalfHeight + inset), m.headInner + inset],
    [x, h(m.headHeight - m.headHalfHeight + inset), m.headOuter - inset],
    [x, h(m.headHeight + m.headHalfHeight - inset), m.headOuter - inset],
    [x, h(m.headHeight + m.headHalfHeight - inset), m.headInner + inset],
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
    ...box([top[0] - 0.05, top[1] - 0.07, top[2] - 0.065], [top[0] + 0.085, top[1] + 0.055, top[2] + 0.065], swatch("blackPlastic"), 0.022),
    // Standoff brackets to the pillar.
    ...bar([path[2]![0], path[2]![1], path[2]![2] - 0.03], [path[2]![0] - 0.02, path[2]![1], tumble(1.36) - 0.01], 0.01, 5, swatch("blackPlastic")),
    ...bar([path[3]![0], path[3]![1], path[3]![2] - 0.03], [path[3]![0] - 0.02, path[3]![1], tumble(1.8) - 0.01], 0.01, 5, swatch("blackPlastic")),
  ];
}

/** The rear doors' split line, handle and plate, and the quarters' seams. */
function rearDetailSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const x = BODY.rear - 0.0015;
  const z = REAR_DOOR_SPLIT_Z;
  surfaces.push(quad([x, h(BODY.rearBottom + 0.02), z - 0.003], [x, h(BODY.rearBottom + 0.02), z + 0.003], [x, h(BODY.belt), z + 0.003], [x, h(BODY.belt), z - 0.003], swatch("seal")));
  // The right door's handle, by the split, and the plate under it.
  surfaces.push(...box([x - 0.03, h(1.17), z + 0.06], [x + 0.005, h(1.205), z + 0.2], swatch("blackPlastic"), 0.006));
  surfaces.push(...plateSurfaces(x, -1, 0.74, 0.3));
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
function cabinShellSurfaces(): { readonly symmetric: Surface[]; readonly single: Surface[]; readonly door: Surface[] } {
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
  // The side wall in three: the kick panel, the front door's card (it swings
  // with the door) and the rest.
  const doorFront = DOOR_LINES.frontDoorFoot;
  const doorRear = DOOR_LINES.frontDoorRear;
  const wallPanel = (from: number, to: number): Surface =>
    quad([from, h(cabinFloor), wall], [to, h(cabinFloor), wall], [to, h(BODY.belt), wall], [from, h(BODY.belt), wall], trim);
  const symmetric: Surface[] = [
    wallPanel(front, doorFront),
    wallPanel(doorRear, back),
    // The rear wheels' tubs, boxed in under the bench and the cargo floor.
    ...box([RA - ARCH.halfWidth, h(cabinFloor - 0.02), 0.56], [RA + ARCH.halfWidth, h(ARCH.height + WHEEL_HEIGHT + 0.03), wall + 0.004], trim, 0.04),
    // The rear door's armrest.
    ...box([-1.3, h(1.07), wall - 0.05], [-0.44, h(1.12), wall + 0.005], trim, 0.012),
  ];
  const door: Surface[] = [
    wallPanel(doorFront, doorRear),
    ...box([-0.38, h(1.07), wall - 0.05], [Math.min(0.72, doorFront - 0.01), h(1.12), wall + 0.005], trim, 0.012),
  ];
  return { symmetric, single, door };
}

export interface CarBodySurfaces {
  /** Built on the right; the mesh adds each with its mirror image. */
  readonly symmetric: readonly Surface[];
  readonly single: readonly Surface[];
  readonly glass: readonly Surface[];
  /**
   * The right front door, cut from the slab, the glasshouse and the cabin's
   * wall (the left is its mirror image): its painted and trimmed parts, and
   * its window's glass. Shut, it lies exactly in the body's place.
   */
  readonly door: { readonly body: readonly Surface[]; readonly glass: readonly Surface[] };
}

/** Every static part of the body and its glass, body frame. */
export function carBodySurfaces(): CarBodySurfaces {
  const shell = shellSurfaces();
  const roof = roofSurfaces();
  const under = underbodySurfaces();
  const cabin = cabinShellSurfaces();
  const side: GlasshouseParts = { outer: [], inner: [], glass: [] };
  const doorSide: GlasshouseParts = { outer: [], inner: [], glass: [] };
  buildPanel(sidePanel(), side, "trim", { region: frontDoorGlasshouseRegion(), parts: doorSide });
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
      ...roof.symmetric,
      ...under.symmetric,
      ...cabin.symmetric,
    ],
    single: [
      ...shell.centre,
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
    door: {
      body: [...shell.door, ...doorSide.outer, ...doorSide.inner, ...cabin.door],
      glass: doorSide.glass,
    },
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
  const x = HEADLAMP_LENS_X;
  for (const side of [-1, 1]) {
    const centre: Vec3Tuple = [x, h(HEADLAMP.height), side * HEADLAMP.halfSpacing];
    surfaces.push(disc(centre, [1, 0, 0], HEADLAMP.radius - 0.016, 28, lampUv(CAR_LAMP_TEXELS.headlamp)));
    surfaces.push(ring([x + 0.0005, centre[1], centre[2]], [1, 0, 0], HEADLAMP.radius - 0.016, HEADLAMP.radius, 28, lampUv(CAR_LAMP_TEXELS.dayRunning)));
    const zIn = side > 0 ? SHELL_SPLIT_Z + 0.012 : -(BODY.halfWidth - 0.016);
    const zOut = side > 0 ? BODY.halfWidth - 0.016 : -(SHELL_SPLIT_Z + 0.012);
    surfaces.push(...box([BODY.front - 0.005, h(0.795), zIn], [BODY.front + 0.012, h(0.85), zOut], lampUv(CAR_LAMP_TEXELS.indicator), 0.004));
  }
  const rear = BODY.rear;
  for (const side of [-1, 1]) {
    const zIn = side > 0 ? BODY.halfWidth - 0.125 : -(BODY.halfWidth - 0.012);
    const zOut = side > 0 ? BODY.halfWidth - 0.012 : -(BODY.halfWidth - 0.125);
    const cluster = (from: number, to: number, texel: number): Surface[] =>
      box([rear - 0.014, h(from), zIn], [rear + 0.004, h(to), zOut], lampUv(texel), 0.004);
    surfaces.push(...cluster(0.94, 1.05, CAR_LAMP_TEXELS.indicator));
    surfaces.push(...cluster(0.8, 0.935, CAR_LAMP_TEXELS.tail));
    surfaces.push(...cluster(0.7, 0.795, CAR_LAMP_TEXELS.reverse));
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
