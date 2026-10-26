import { HULL_LENGTH, RUNABOUT_21_CLEATS, sampleHullLines, transomX } from "@/src/vehicles/boat/hullLines";
import { dialUv, finishUv, nonSkidUv, type BoatDial, type BoatFinish } from "./boatAtlas";
import {
  drawnHalfSection,
  drawnStationX,
  hullHalfBreadthAt,
  MOTOR_WELL,
  sheerPoint,
  TRANSOM_BLEND_METERS,
} from "./boatHull";
import { polygonSurface, Surface, type Vec3Tuple } from "./boatMeshData";

/**
 * The Runabout 21's deck and everything on it, hull frame, starboard halves
 * mirrored by the caller where a part is symmetric. A bowrider's layout:
 *
 *   transom 0 - aft deck and motor well - 0.55 - rear bench - 1.12
 *   - helm and passenger seats ~1.9-2.45 - twin consoles 2.62-3.34 under a
 *   wraparound windscreen - bow cockpit with U lounge 3.75-5.55 - foredeck
 *   to the stem head at 6.55.
 *
 * Heights are above the keel baseline. The cockpit sole is at
 * `COCKPIT.soleY`, 0.42 m, which with the hull's rest waterline at 0.40 m
 * is where a runabout's sole sits (just above the water, not self-bailing);
 * the gunwale is 0.6-0.7 m above it, thigh high.
 */
export const COCKPIT = Object.freeze({
  soleY: 0.42,
  /** Gunwale cap width inboard of the sheer. */
  capWidth: 0.17,
  /** Aft end of the cockpit (the aft deck's forward face) and forward end (the foredeck's aft face). */
  aftX: 0.55,
  forwardX: 5.55,
});

export const CONSOLE = Object.freeze({
  aftX: 2.62,
  forwardX: 3.34,
  /** The walk-through's half width: each console runs from here out to the liner. */
  innerZ: 0.22,
  /** The dash face, a straight slope from (aftX, dashBottomY) to (dashTopX, dashTopY). */
  dashBottomY: 0.66,
  dashTopX: 2.86,
  dashTopY: 1.06,
  topY: 1.15,
});

const DEG = Math.PI / 180;

/** The cockpit's half-profile at station x, from the sheer inward: (z, y), z >= 0. */
export function cockpitProfile(x: number): [number, number][] {
  const sheer = drawnHalfSection(x, [])[12]!;
  const [zs, ys] = sheer;
  const sole = COCKPIT.soleY;
  const footHeight = sole + 0.06;
  const hullAtFoot = hullHalfBreadthAt(x, footHeight);
  const capInner = zs - COCKPIT.capWidth;
  const footZ = Math.max(0.12, Math.min(capInner - 0.1, hullAtFoot - 0.05));
  return [
    [zs, ys],
    [capInner, ys + 0.012],
    [capInner - 0.025, ys - 0.03],
    [footZ, footHeight],
    // The sole's edge, inside the bottom panel, which narrows fast below the chine.
    [Math.max(0.06, Math.min(footZ - 0.05, hullHalfBreadthAt(x, sole) - 0.03)), sole],
    [0, sole],
  ];
}

/** The liner wall's half-breadth at height y on station x (cap lip to liner foot, linear). */
export function linerHalfBreadthAt(x: number, y: number): number {
  const profile = cockpitProfile(x);
  const [zTop, yTop] = profile[2]!;
  const [zFoot, yFoot] = profile[3]!;
  if (y < yFoot) {
    // The fillet from the foot down to the sole's edge.
    const [zSole, ySole] = profile[4]!;
    const t = Math.min(1, Math.max(0, (y - ySole) / (yFoot - ySole)));
    return zSole + (zFoot - zSole) * t;
  }
  const t = Math.min(1, (y - yFoot) / (yTop - yFoot));
  return zFoot + (zTop - zFoot) * t;
}

function stationsBetween(from: number, to: number, step: number): number[] {
  const count = Math.max(1, Math.ceil((to - from) / step - 1e-9));
  const stations: number[] = [];
  for (let i = 0; i <= count; i += 1) stations.push(from + ((to - from) * i) / count);
  return stations;
}

const PROFILE_FINISHES: readonly (BoatFinish | "nonSkid")[] = ["gelcoat", "gelcoat", "liner", "liner", "nonSkid"];

/** Gunwale cap, lip, liner wall, foot and sole: starboard, one group per panel. */
export function cockpitSurfaces(): Surface[] {
  const stations = stationsBetween(COCKPIT.aftX, COCKPIT.forwardX, 0.1);
  const profiles = stations.map((x) => cockpitProfile(x));
  const surfaces: Surface[] = [];
  for (let j = 0; j < 5; j += 1) {
    const surface = new Surface();
    const finish = PROFILE_FINISHES[j]!;
    const rows = profiles.map((profile, i) => [
      [stations[i]!, profile[j]![1], profile[j]![0]] as const,
      [stations[i]!, profile[j + 1]![1], profile[j + 1]![0]] as const,
    ]);
    surface.grid(rows, (_i, _j, point) => (finish === "nonSkid" ? nonSkidUv(point[0], point[2]) : finishUv(finish)));
    surfaces.push(surface);
  }
  return surfaces;
}

/** Height of the foredeck's crown above the sheer at the foredeck's aft edge. */
const FOREDECK_CAMBER = 0.045;

/** Foredeck from the cockpit's forward end to the stem head, starboard: gelcoat border, non-skid centre. */
export function foredeckSurfaces(): Surface[] {
  const stations = stationsBetween(COCKPIT.forwardX, HULL_LENGTH, 0.05);
  const fractions = [1, 0.8, 0.55, 0.28, 0];
  const aftSheer = sheerPoint(COCKPIT.forwardX)[2];
  const profiles = stations.map((x) => {
    const [, ys, zs] = sheerPoint(x);
    const camber = FOREDECK_CAMBER * Math.min(1, zs / aftSheer);
    return fractions.map((f) => [x, ys + camber * (1 - f * f), zs * f] as const);
  });
  const surfaces: Surface[] = [];
  for (let j = 0; j < fractions.length - 1; j += 1) {
    const surface = new Surface();
    const rows = profiles.map((profile) => [profile[j]!, profile[j + 1]!]);
    surface.grid(rows, (_i, _j, point) => (j === 0 ? finishUv("gelcoat") : nonSkidUv(point[0], point[2])));
    surfaces.push(surface);
  }
  return surfaces;
}

/**
 * The foredeck's aft face, from its deck down to the sole across the
 * cockpit's forward end, starboard half. Shows aft, into the bow cockpit.
 */
export function foredeckFaceSurface(): Surface {
  const x = COCKPIT.forwardX;
  const [, ys] = sheerPoint(x);
  const profile = cockpitProfile(x);
  // Counter-clockwise seen from astern (+z right, +y up): down the centre,
  // out along the sole, up the liner to the cap, back along the deck crown.
  const outline: [number, number][] = [
    [0, ys + FOREDECK_CAMBER],
    [0, COCKPIT.soleY],
    [profile[4]![0], profile[4]![1]],
    [profile[3]![0], profile[3]![1]],
    [profile[2]![0], profile[2]![1]],
    [profile[1]![0], profile[1]![1]],
  ];
  return polygonSurface(outline, (z, y) => [x, y, z], () => finishUv("liner"));
}

/**
 * The sheer's half-breadth at DRAWN x near the transom, where the rings are
 * moved onto the raked plane: invert `drawnStationX` at the sheer's height.
 */
function sheerHalfBeamAtDrawnX(x: number): number {
  const shift = transomX(sheerPoint(0)[1]);
  const nominal = Math.max(0, (x - shift) / (1 - shift / TRANSOM_BLEND_METERS));
  return sheerPoint(Math.min(nominal, x))[2];
}

/** The aft deck: the transom's top to the cockpit, either side of the motor well, and across it forward of the well. */
export function aftDeckSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const topAt = (x: number): number => sheerPoint(x)[1] + 0.012;
  const sideStations = stationsBetween(drawnStationX(0, topAt(0)), MOTOR_WELL.forwardX, 0.05);
  const side = new Surface();
  side.grid(
    sideStations.map((x) => {
        return [[x, topAt(x), sheerHalfBeamAtDrawnX(x)] as const, [x, topAt(x), MOTOR_WELL.halfWidth] as const];
    }),
    () => finishUv("gelcoat"),
  );
  surfaces.push(side);
  const across = new Surface();
  across.grid(
    stationsBetween(MOTOR_WELL.forwardX, COCKPIT.aftX, 0.05).map((x) => {
        return [[x, topAt(x), sheerHalfBeamAtDrawnX(x)] as const, [x, topAt(x), 0] as const];
    }),
    () => finishUv("gelcoat"),
  );
  surfaces.push(across);
  // Its forward face down to the sole: shows forward, into the cockpit.
  const x = COCKPIT.aftX;
  const profile = cockpitProfile(x);
  const outline: [number, number][] = [
    [0, topAt(x)],
    [profile[1]![0], profile[1]![1]],
    [profile[2]![0], profile[2]![1]],
    [profile[3]![0], profile[3]![1]],
    [profile[4]![0], profile[4]![1]],
    [0, COCKPIT.soleY],
  ];
  // Seen from ahead +z is to the viewer's LEFT, so this outline, clockwise in
  // (z, y), is counter-clockwise to that viewer.
  surfaces.push(polygonSurface(outline.map(([z, y]) => [-z, y] as [number, number]), (a, y) => [x, y, -a], () => finishUv("liner")));
  return surfaces;
}

/** The motor well: floor, starboard wall and half the forward wall. */
export function motorWellSurfaces(): Surface[] {
  const top = sheerPoint(0.2)[1] + 0.012;
  const floor = MOTOR_WELL.floorY;
  const aftFloor = transomX(floor);
  const halfWidth = MOTOR_WELL.halfWidth;
  const forward = MOTOR_WELL.forwardX;
  const surfaces: Surface[] = [];
  const uv = finishUv("gelcoat");
  const floorSurface = new Surface();
  floorSurface.quad(
    floorSurface.vertex(aftFloor, floor, 0, uv[0], uv[1]),
    floorSurface.vertex(aftFloor, floor, halfWidth, uv[0], uv[1]),
    floorSurface.vertex(forward, floor, halfWidth, uv[0], uv[1]),
    floorSurface.vertex(forward, floor, 0, uv[0], uv[1]),
  );
  surfaces.push(floorSurface);
  const wall = new Surface();
  // Starboard wall at z = halfWidth, shows -z (into the well).
  wall.quad(
    wall.vertex(aftFloor, floor, halfWidth, uv[0], uv[1]),
    wall.vertex(transomX(top), top, halfWidth, uv[0], uv[1]),
    wall.vertex(forward, top, halfWidth, uv[0], uv[1]),
    wall.vertex(forward, floor, halfWidth, uv[0], uv[1]),
  );
  surfaces.push(wall);
  const front = new Surface();
  // Forward wall at x = forward, shows -x (aft, into the well).
  front.quad(
    front.vertex(forward, floor, 0, uv[0], uv[1]),
    front.vertex(forward, floor, halfWidth, uv[0], uv[1]),
    front.vertex(forward, top, halfWidth, uv[0], uv[1]),
    front.vertex(forward, top, 0, uv[0], uv[1]),
  );
  surfaces.push(front);
  return surfaces;
}

/**
 * A box with chamfered edges, for cushions and pedestals: `min`/`max` its
 * extents, `bevel` the chamfer. Every face its own group, so it reads as a
 * stitched cushion rather than a blob. Faces whose outward axis is listed in
 * `omit` ("-x", "+y" ...) are left out where they would be hidden.
 */
export function bevelledBox(
  min: Vec3Tuple,
  max: Vec3Tuple,
  bevel: number,
  finish: BoatFinish,
  omit: readonly string[] = [],
): Surface[] {
  const b = Math.max(0, Math.min(bevel, (max[0] - min[0]) / 2.01, (max[1] - min[1]) / 2.01, (max[2] - min[2]) / 2.01));
  const uv = finishUv(finish);
  const surfaces: Surface[] = [];
  // The eight corners of the inner box, pushed out along each face normal.
  const corner = (sx: number, sy: number, sz: number, nx: number, ny: number, nz: number): Vec3Tuple => [
    (sx < 0 ? min[0] + b : max[0] - b) + nx * b,
    (sy < 0 ? min[1] + b : max[1] - b) + ny * b,
    (sz < 0 ? min[2] + b : max[2] - b) + nz * b,
  ];
  const axes: { name: string; n: Vec3Tuple; u: Vec3Tuple; v: Vec3Tuple }[] = [
    { name: "+x", n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { name: "-x", n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { name: "+y", n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { name: "-y", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { name: "+z", n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { name: "-z", n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const faceCorners = (axis: (typeof axes)[number]): Vec3Tuple[] => {
    // u x v = n, so (-u-v), (+u-v), (+u+v), (-u+v) is counter-clockwise from outside.
    const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    return signs.map(([su, sv]) => {
      const s = [0, 1, 2].map((k) => axis.n[k]! + su * axis.u[k]! + sv * axis.v[k]!) as [number, number, number];
      return corner(s[0], s[1], s[2], axis.n[0], axis.n[1], axis.n[2]);
    });
  };
  for (const axis of axes) {
    if (omit.includes(axis.name)) continue;
    const face = new Surface();
    const [a, c0, c1, d] = faceCorners(axis).map((p) => face.vertexAt(p, uv)) as [number, number, number, number];
    face.quad(a, c0, c1, d);
    surfaces.push(face);
  }
  if (b > 0) {
    // The chamfers: one quad per edge between two faces, and a triangle per corner.
    const bevels = new Surface();
    for (let i = 0; i < axes.length; i += 1) {
      for (let j = i + 1; j < axes.length; j += 1) {
        const a = axes[i]!;
        const c = axes[j]!;
        if (a.n.some((value, k) => value !== 0 && c.n[k] !== 0)) continue;
        // Along the edge: the axis neither face normal uses.
        const along = [0, 1, 2].find((k) => a.n[k] === 0 && c.n[k] === 0)!;
        const ends = [-1, 1].map((end) => {
          const s = [a.n[0] + c.n[0], a.n[1] + c.n[1], a.n[2] + c.n[2]] as [number, number, number];
          s[along] = end;
          return [corner(s[0], s[1], s[2], a.n[0], a.n[1], a.n[2]), corner(s[0], s[1], s[2], c.n[0], c.n[1], c.n[2])] as const;
        });
        const p0 = ends[0]![0];
        const p1 = ends[1]![0];
        const p2 = ends[1]![1];
        const p3 = ends[0]![1];
        const vertices = [p0, p1, p2, p3].map((p) => bevels.vertexAt(p, uv)) as [number, number, number, number];
        // Wind it to show outward: test against the edge's outward direction.
        const outward = [a.n[0] + c.n[0], a.n[1] + c.n[1], a.n[2] + c.n[2]];
        const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const e2 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
        const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        if (n[0]! * outward[0]! + n[1]! * outward[1]! + n[2]! * outward[2]! >= 0) bevels.quad(...vertices);
        else bevels.quad(vertices[0], vertices[3], vertices[2], vertices[1]);
      }
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const p = [corner(sx, sy, sz, sx, 0, 0), corner(sx, sy, sz, 0, sy, 0), corner(sx, sy, sz, 0, 0, sz)];
          const vertices = p.map((point) => bevels.vertexAt(point, uv)) as [number, number, number];
          // Counter-clockwise from outside when the corner's octant has an even number of negatives.
          if (sx * sy * sz > 0) bevels.tri(vertices[0], vertices[1], vertices[2]);
          else bevels.tri(vertices[0], vertices[2], vertices[1]);
        }
      }
    }
    surfaces.push(bevels);
  }
  return surfaces;
}

/**
 * Pull every vertex of a starboard part that stands outside the liner wall
 * back onto it, so a box built wider than the cockpit meets the sloping wall
 * along its whole height instead of poking through the hull below it.
 */
function clampToLiner(surfaces: Surface[], allowance = 0.004): Surface[] {
  for (const surface of surfaces) {
    const p = surface.positions;
    for (let index = 0; index < p.length; index += 3) {
      const x = p[index]!;
      const y = p[index + 1]!;
      const wall = Math.min(linerHalfBreadthAt(x, y) + allowance, hullHalfBreadthAt(x, y) - 0.02);
      if (p[index + 2]! > wall) p[index + 2] = Math.max(0, wall);
    }
  }
  return surfaces;
}

/** Seating, starboard: rear bench half, helm seat, bow lounge. The caller mirrors it. */
export function seatSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const sole = COCKPIT.soleY;

  // Rear bench: base, cushion and backrest across the cockpit, half here.
  const benchWidth = linerHalfBreadthAt(0.85, 0.8);
  surfaces.push(...clampToLiner(bevelledBox([COCKPIT.aftX, sole, 0], [1.12, 0.8, benchWidth + 0.1], 0.01, "liner", ["-z", "-y", "-x"])));
  surfaces.push(...bevelledBox([0.57, 0.8, 0], [1.15, 0.9, benchWidth - 0.03], 0.035, "vinyl", ["-z", "-y"]));
  surfaces.push(...tiltedCushion([0.6, 0.9, 0], [0.72, 1.14, linerHalfBreadthAt(0.66, 1.0) - 0.04], 12, "vinyl"));
  // An accent piping band along the bench cushion's front.
  surfaces.push(...bevelledBox([1.15, 0.83, 0], [1.156, 0.87, benchWidth - 0.06], 0, "vinylAccent", ["-z", "-x", "-y", "+y"]));

  // Helm seat on its pedestal (the passenger seat is its mirror).
  surfaces.push(...bevelledBox([2.03, sole, 0.4], [2.36, 0.74, 0.72], 0.012, "liner", ["-y"]));
  surfaces.push(...bevelledBox([1.95, 0.74, 0.33], [2.45, 0.87, 0.79], 0.04, "vinyl", ["-y"]));
  surfaces.push(...tiltedCushion([1.86, 0.86, 0.35], [1.99, 1.4, 0.77], 10, "vinyl"));
  surfaces.push(...tiltedCushion([1.845, 0.9, 0.37], [1.86, 1.2, 0.75], 10, "vinylAccent"));

  // Bow lounge along the liner, base and cushion swept with the hull.
  const loungeStations = stationsBetween(3.75, COCKPIT.forwardX, 0.1);
  const seatTop = 0.82;
  const cushionTop = 0.92;
  const base = new Surface();
  const top = new Surface();
  const back = new Surface();
  const baseRows: Vec3Tuple[][] = [];
  const topRows: Vec3Tuple[][] = [];
  const backRows: Vec3Tuple[][] = [];
  for (const x of loungeStations) {
    const wall = linerHalfBreadthAt(x, seatTop);
    const inner = Math.max(0.1, wall - 0.44);
    baseRows.push([[x, seatTop, inner], [x, sole, inner]]);
    topRows.push([[x, cushionTop - 0.02, inner - 0.012], [x, cushionTop, inner + 0.03], [x, cushionTop, wall - 0.02], [x, seatTop, wall + 0.01]]);
    const [, ys] = sheerPoint(x);
    const backTop = ys - 0.06;
    const wallTop = linerHalfBreadthAt(x, backTop);
    backRows.push([[x, backTop, wallTop - 0.07], [x, cushionTop, linerHalfBreadthAt(x, cushionTop) - 0.08]]);
  }
  base.grid(baseRows, () => finishUv("liner"));
  top.grid(topRows, () => finishUv("vinyl"));
  back.grid(backRows, () => finishUv("vinyl"));
  surfaces.push(base, top.flipped(), back);
  // The lounge's aft end, facing aft.
  const endX = loungeStations[0]!;
  const endWall = linerHalfBreadthAt(endX, seatTop);
  const endInner = Math.max(0.1, endWall - 0.44);
  surfaces.push(...clampToLiner([polygonSurface(
    [[endInner, sole], [endWall + 0.1, sole], [endWall + 0.1, cushionTop], [endInner, cushionTop]],
    (z, y) => [endX, y, z],
    () => finishUv("liner"),
  )]));
  // The filler cushion across the bow's narrow end.
  const fillerWall = linerHalfBreadthAt(5.3, seatTop);
  surfaces.push(...clampToLiner(bevelledBox([5.22, sole + 0.01, 0], [COCKPIT.forwardX, seatTop, fillerWall + 0.1], 0.01, "liner", ["-z", "-y", "+x"])));
  surfaces.push(...clampToLiner(bevelledBox([5.2, seatTop, 0], [COCKPIT.forwardX - 0.01, cushionTop, fillerWall + 0.02], 0.03, "vinyl", ["-z", "-y", "+x"])));
  return surfaces;
}

/** A cushion leaning back `degrees` about its bottom-aft edge (a backrest), bevelled. */
function tiltedCushion(min: Vec3Tuple, max: Vec3Tuple, degrees: number, finish: BoatFinish): Surface[] {
  const surfaces = bevelledBox(min, max, 0.03, finish, ["-y"]);
  const angle = degrees * DEG;
  const pivotX = min[0];
  const pivotY = min[1];
  for (const surface of surfaces) {
    for (let index = 0; index < surface.positions.length; index += 3) {
      const dx = surface.positions[index]! - pivotX;
      const dy = surface.positions[index + 1]! - pivotY;
      surface.positions[index] = pivotX + dx * Math.cos(angle) - dy * Math.sin(angle);
      surface.positions[index + 1] = pivotY + dx * Math.sin(angle) + dy * Math.cos(angle);
    }
  }
  return surfaces;
}

/** The dash face's frame: a point at distance `s` up the slope and `z` across, its normal, up and right. */
export function dashFrame(s: number, z: number): { point: Vec3Tuple; normal: Vec3Tuple; up: Vec3Tuple; right: Vec3Tuple } {
  const dx = CONSOLE.dashTopX - CONSOLE.aftX;
  const dy = CONSOLE.dashTopY - CONSOLE.dashBottomY;
  const length = Math.hypot(dx, dy);
  const up: Vec3Tuple = [dx / length, dy / length, 0];
  const normal: Vec3Tuple = [-dy / length, dx / length, 0];
  // Seen by a driver facing the dash (looking along -normal), right is (-normal) x up.
  const right: Vec3Tuple = [0, 0, 1];
  return { point: [CONSOLE.aftX + up[0] * s, CONSOLE.dashBottomY + up[1] * s, z], normal, up, right };
}

/** The dash's instruments: where each dial sits on the starboard dash face, and its radius. */
export const DASH_DIALS: readonly { readonly dial: BoatDial; readonly s: number; readonly z: number; readonly radius: number }[] = Object.freeze([
  { dial: "tachometer", s: 0.33, z: 0.41, radius: 0.052 },
  { dial: "speedometer", s: 0.33, z: 0.64, radius: 0.052 },
  { dial: "trim", s: 0.37, z: 0.85, radius: 0.034 },
  { dial: "depth", s: 0.22, z: 0.85, radius: 0.034 },
]);

/** Where the wheel's hub is, and the steering shaft's direction (out of the dash, towards the driver). */
export const WHEEL = Object.freeze({
  radius: 0.18,
  dashS: 0.12,
  z: 0.53,
  shaftLength: 0.2,
});

/** The consoles: starboard helm with the dash, and the port passenger console. */
export function consoleSurfaces(side: "starboard" | "port"): Surface[] {
  const surfaces: Surface[] = [];
  // Out past the liner, then pulled back onto it vertex by vertex below.
  const outer = linerHalfBreadthAt(3.0, 0.9) + 0.1;
  const inner = CONSOLE.innerZ;
  // The console's side profile in (x, y), aft-bottom round to forward-bottom.
  const profile: { x: number; y: number; finish: BoatFinish }[] = [
    { x: CONSOLE.aftX, y: COCKPIT.soleY, finish: "liner" },
    { x: CONSOLE.aftX, y: CONSOLE.dashBottomY, finish: side === "starboard" ? "dash" : "gloveBox" },
    { x: CONSOLE.dashTopX, y: CONSOLE.dashTopY, finish: "dash" },
    { x: CONSOLE.dashTopX - 0.05, y: CONSOLE.dashTopY + 0.055, finish: "dash" },
    { x: CONSOLE.dashTopX + 0.1, y: CONSOLE.topY - 0.01, finish: "gelcoat" },
    { x: CONSOLE.forwardX, y: CONSOLE.topY, finish: "gelcoat" },
    { x: CONSOLE.forwardX, y: COCKPIT.soleY, finish: "gelcoat" },
  ];
  for (let k = 0; k < profile.length - 1; k += 1) {
    const a = profile[k]!;
    const b = profile[k + 1]!;
    const face = new Surface();
    const uv = finishUv(a.finish);
    // Along the profile then across +z: (b - a) x (+z) shows outward for this
    // clockwise-in-(x, y) profile.
    face.quad(
      face.vertex(a.x, a.y, outer, uv[0], uv[1]),
      face.vertex(b.x, b.y, outer, uv[0], uv[1]),
      face.vertex(b.x, b.y, inner, uv[0], uv[1]),
      face.vertex(a.x, a.y, inner, uv[0], uv[1]),
    );
    surfaces.push(face);
  }
  // The walk-through side at z = inner, showing -z.
  // Clockwise in (x, y), so it shows -z: the walk-through side.
  const outline = profile.map((point) => [point.x, point.y] as [number, number]);
  surfaces.push(polygonSurface(outline, (x, y) => [x, y, inner], () => finishUv("liner")));
  clampToLiner(surfaces);
  if (side === "starboard") {
    for (const dial of DASH_DIALS) surfaces.push(dialFace(dial.dial, dial.s, dial.z, dial.radius));
  } else {
    // The glove box door, a shade proud of the face.
    surfaces.push(dashPanel(0.16, 0.36, 0.42, 0.82, "gloveBox"));
  }
  return side === "port" ? surfaces.map((surface) => surface.mirrored()) : surfaces;
}

/** A dial face disc on the dash, its texture from the atlas's dial strip, 4 mm proud. */
function dialFace(dial: BoatDial, s: number, z: number, radius: number): Surface {
  const frame = dashFrame(s, z);
  const surface = new Surface();
  const lift = 0.004;
  const centre: Vec3Tuple = [frame.point[0] + frame.normal[0] * lift, frame.point[1] + frame.normal[1] * lift, frame.point[2]];
  const segments = 28;
  const middle = surface.vertexAt(centre, dialUv(dial, 0, 0));
  const ring: number[] = [];
  for (let k = 0; k < segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2;
    const sr = Math.cos(angle);
    const su = Math.sin(angle);
    ring.push(surface.vertexAt(
      [
        centre[0] + (frame.right[0] * sr + frame.up[0] * su) * radius,
        centre[1] + (frame.right[1] * sr + frame.up[1] * su) * radius,
        centre[2] + (frame.right[2] * sr + frame.up[2] * su) * radius,
      ],
      dialUv(dial, sr, su),
    ));
  }
  for (let k = 0; k < segments; k += 1) {
    // Counter-clockwise in (right, up): the side the driver sees.
    surface.tri(middle, ring[k]!, ring[(k + 1) % segments]!);
  }
  return surface;
}

/** A flat panel on the dash face, from s0..s1 up the slope and z0..z1 across. */
function dashPanel(s0: number, s1: number, z0: number, z1: number, finish: BoatFinish): Surface {
  const surface = new Surface();
  const uv = finishUv(finish);
  const lift = 0.006;
  const at = (s: number, z: number): number => {
    const frame = dashFrame(s, z);
    return surface.vertexAt([frame.point[0] + frame.normal[0] * lift, frame.point[1] + frame.normal[1] * lift, z], uv);
  };
  surface.quad(at(s0, z0), at(s0, z1), at(s1, z1), at(s1, z0));
  return surface;
}

/** The windscreen's plan: where its base meets the consoles and the cap, across z. */
export function windscreenBase(z: number): { x: number; y: number } {
  const t = Math.min(1, Math.abs(z) / 1.12);
  const x = 3.3 - 0.45 * t ** 4;
  const edge = Math.min(1, Math.max(0, (Math.abs(z) - 0.95) / 0.17));
  const y = CONSOLE.topY - 0.04 * edge * edge * (3 - 2 * edge);
  return { x, y };
}

/** The glass's height and the rake that carries its top aft. */
export const WINDSCREEN = Object.freeze({ height: 0.34, rake: 0.22, halfSpan: 1.1 });

function windscreenTop(z: number): Vec3Tuple {
  const base = windscreenBase(z);
  const fade = Math.min(1, Math.max(0, (Math.abs(z) - 0.75) / 0.35));
  const scale = 1 - 0.55 * fade * fade * (3 - 2 * fade);
  return [base.x - WINDSCREEN.rake * scale, base.y + WINDSCREEN.height * scale, z];
}

/** The windscreen glass, port to starboard in one sheet. Shows forward; the glass material is two-sided. */
export function windscreenGlassSurface(): Surface {
  const surface = new Surface();
  const columns = 44;
  const rows: Vec3Tuple[][] = [];
  for (let k = 0; k <= columns; k += 1) {
    const z = -WINDSCREEN.halfSpan + (2 * WINDSCREEN.halfSpan * k) / columns;
    const base = windscreenBase(z);
    rows.push([[base.x, base.y, z], windscreenTop(z)]);
  }
  surface.grid(rows, () => finishUv("gelcoat"));
  return surface.flipped();
}

/** The windscreen's frame: a top rail, the walk-through posts and the end posts, anodised black. */
export function windscreenFrameSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const rail = new Surface();
  const columns = 44;
  const rows: Vec3Tuple[][] = [];
  for (let k = 0; k <= columns; k += 1) {
    const z = -WINDSCREEN.halfSpan + (2 * WINDSCREEN.halfSpan * k) / columns;
    const [x, y] = windscreenTop(z);
    rows.push([
      [x + 0.012, y - 0.012, z],
      [x + 0.012, y + 0.014, z],
      [x - 0.014, y + 0.014, z],
      [x - 0.014, y - 0.012, z],
      [x + 0.012, y - 0.012, z],
    ]);
  }
  rail.grid(rows, () => finishUv("anodized"));
  surfaces.push(rail.flipped());
  for (const z of [-WINDSCREEN.halfSpan, -CONSOLE.innerZ, CONSOLE.innerZ, WINDSCREEN.halfSpan]) {
    const base = windscreenBase(z);
    const top = windscreenTop(z);
    const post = new Surface();
    const ring: Vec3Tuple[][] = [];
    for (const [px, py] of [[base.x, base.y], [top[0], top[1]]] as const) {
      ring.push([
        [px + 0.012, py, z - 0.012],
        [px + 0.012, py, z + 0.012],
        [px - 0.012, py, z + 0.012],
        [px - 0.012, py, z - 0.012],
        [px + 0.012, py, z - 0.012],
      ]);
    }
    post.grid(ring, () => finishUv("anodized"));
    surfaces.push(post);
  }
  return surfaces;
}

/** A horn cleat at a deck point, along x. */
export function cleatSurfaces(at: Vec3Tuple, length = 0.16): Surface[] {
  const [x, y, z] = at;
  return [
    ...bevelledBox([x - 0.03, y, z - 0.018], [x + 0.03, y + 0.03, z + 0.018], 0.006, "stainless", ["-y"]),
    ...bevelledBox([x - length / 2, y + 0.028, z - 0.014], [x + length / 2, y + 0.048, z + 0.014], 0.008, "stainless"),
  ];
}

/** All five cleats where the lines say, sat on the deck. */
export function allCleatSurfaces(): Surface[] {
  return RUNABOUT_21_CLEATS.flatMap((cleat) => cleatSurfaces([cleat.x, cleat.y, cleat.z]));
}

/** The all-round white light's pole, port aft, and where its lamp is. */
export const STERN_POLE = Object.freeze({ x: 0.3, z: -0.8, topY: 2.36, radius: 0.012 });

/** A vertical round post from y0 to y1 at (x, z). */
export function postSurface(x: number, z: number, y0: number, y1: number, radius: number, finish: BoatFinish, segments = 10): Surface {
  const surface = new Surface();
  const rows: Vec3Tuple[][] = [];
  for (const y of [y0, y1]) {
    const ring: Vec3Tuple[] = [];
    for (let k = 0; k <= segments; k += 1) {
      const angle = (k / segments) * Math.PI * 2;
      ring.push([x + Math.cos(angle) * radius, y, z - Math.sin(angle) * radius]);
    }
    rows.push(ring);
  }
  surface.grid(rows, () => finishUv(finish));
  return surface.flipped();
}

/** Fittings: the stern pole and its base, the bow lantern's housing, the steering shaft and the binnacle. */
export function fittingSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const deckY = sheerPoint(STERN_POLE.x)[1] + 0.012;
  surfaces.push(...bevelledBox([STERN_POLE.x - 0.035, deckY, STERN_POLE.z - 0.035], [STERN_POLE.x + 0.035, deckY + 0.05, STERN_POLE.z + 0.035], 0.01, "anodized", ["-y"]));
  surfaces.push(postSurface(STERN_POLE.x, STERN_POLE.z, deckY + 0.05, STERN_POLE.topY - 0.03, STERN_POLE.radius, "stainless"));
  // The bi-colour lantern's housing on the stem head: the lenses are the lamp mesh.
  const lantern = BOW_LANTERN;
  surfaces.push(...bevelledBox(
    [lantern.x - 0.07, lantern.y - lantern.height / 2 - 0.01, -0.03],
    [lantern.x - 0.005, lantern.y + lantern.height / 2 + 0.008, 0.03],
    0.008,
    "lensHousing",
    ["-y"],
  ));
  // A screen between the lenses so each is seen only across its own arc.
  surfaces.push(...bevelledBox([lantern.x - 0.01, lantern.y - lantern.height / 2, -0.002], [lantern.x + lantern.radius + 0.004, lantern.y + lantern.height / 2, 0.002], 0, "lensHousing"));
  // The steering shaft from the dash to the wheel hub.
  const frame = dashFrame(WHEEL.dashS, WHEEL.z);
  const shaft = new Surface();
  const rows: Vec3Tuple[][] = [];
  for (const along of [0, WHEEL.shaftLength - 0.02]) {
    const ring: Vec3Tuple[] = [];
    for (let k = 0; k <= 10; k += 1) {
      const angle = (k / 10) * Math.PI * 2;
      const sr = Math.cos(angle) * 0.022;
      const su = Math.sin(angle) * 0.022;
      ring.push([
        frame.point[0] + frame.normal[0] * along + frame.up[0] * su,
        frame.point[1] + frame.normal[1] * along + frame.up[1] * su,
        frame.point[2] + sr,
      ]);
    }
    rows.push(ring);
  }
  shaft.grid(rows, () => finishUv("dash"));
  surfaces.push(shaft.flipped());
  // The binnacle control box on the liner beside the helm.
  const binnacle = BINNACLE;
  surfaces.push(...bevelledBox([binnacle.x - 0.07, binnacle.y - 0.1, binnacle.z - 0.05], [binnacle.x + 0.07, binnacle.y + 0.03, binnacle.z + 0.09], 0.015, "dash"));
  // The outboard's transom bracket, clamped over the motor-well floor.
  surfaces.push(...bevelledBox([transomX(0.4) - 0.02, 0.38, -0.14], [transomX(0.66) + 0.05, MOTOR_WELL.floorY + 0.03, 0.14], 0.01, "anodized"));
  return surfaces;
}

/** The bow lantern: a bi-colour fixture on the stem head, lens radius and height. */
export const BOW_LANTERN = Object.freeze({
  x: 6.42,
  y: (() => {
    const lines = sampleHullLines(6.42);
    return lines.sheerHeight + 0.075;
  })(),
  radius: 0.032,
  height: 0.04,
});

/** The throttle-and-shift lever's pivot on the binnacle, and its reach. */
export const BINNACLE = Object.freeze({ x: 2.5, y: 0.93, z: 0.98, leverLength: 0.2, leverTravelDegrees: 35 });
