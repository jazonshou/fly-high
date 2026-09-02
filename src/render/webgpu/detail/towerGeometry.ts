/**
 * `7-15`: the ATC tower, as pure geometry.
 *
 * **Why this is a module and not inline mesh building.** Two consumers must
 * enumerate exactly the same set of surfaces: `AirportSystem`, which turns them
 * into meshes, and `render.webgpu-prototype-winding.test.ts`, which checks every
 * one is wound the way Babylon expects. A hand-written roster in the test is how
 * `clutter.mossCushion` and `buildBladeRibbon` both went unwatched — a fix
 * without a case has a shelf life. So the parts are named ONCE, here, and both
 * consumers derive from `TOWER_PART_NAMES`.
 *
 * **Winding.** Babylon's own primitives measure agreement −1.000 between
 * `cross(b − a, c − a)` and the outward normal. Every face here is authored
 * CLOCKWISE as seen from outside, which produces that directly, and `tri()` is
 * the single place any adaptation would live rather than ~30 emission sites —
 * which is the shape that produced six inverted surfaces on 2026-08-31.
 *
 * **The convention was established by measurement, not by derivation.** The
 * first version of this file reasoned its way to outward-CCW-then-reverse and
 * was wrong by a sign; the winding test named all six bands at agreement
 * +1.000. `post()` still authors the opposite way and is reversed at its one
 * call site with that noted. Two conventions in one file is worth the comment
 * it costs, because the alternative was re-deriving a cross-product handedness
 * that has already been got wrong twice in this project.
 *
 * Normals are authored outward independently and are never derived from the
 * index order: deriving them would make a surface self-consistently inside-out
 * — passing the agreement test while rendering black.
 */

/** A plain `VertexData`-compatible surface. */
export interface TowerPart {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Every surface the tower emits, in build order.
 *
 * **This is the roster both consumers derive from.** Adding a part here without
 * building it fails `buildTowerGeometry`'s own completeness check; building one
 * without listing it is impossible, because the builder writes into a record
 * keyed by this list.
 */
export const TOWER_PART_NAMES = [
  "base",
  "shaft",
  "gallery",
  "railing",
  "cab",
  "cabRoof",
  "mast",
] as const;

export type TowerPartName = (typeof TOWER_PART_NAMES)[number];

/**
 * Where other items mount things on this tower.
 *
 * **Exposed deliberately rather than left to be hunted for.** `7-14` puts red
 * obstruction lights on the cab roof and mast, and `7-7` mounts its rotating
 * beacon on the cab roof — both need positions from this geometry, and both
 * would otherwise re-derive them from constants that could drift out from under
 * them. These are runway-LOCAL, in the same frame as the returned positions:
 * the caller applies the airport root's heading and elevation.
 */
export interface TowerAttachments {
  /** Centre of the cab roof — `7-7`'s rotating beacon sits here. */
  readonly beaconMount: readonly [number, number, number];
  /** Top of the antenna mast — the highest obstruction light. */
  readonly mastTip: readonly [number, number, number];
  /** Cab roof perimeter, one point per corner, for `7-14`'s ring. */
  readonly cabRoofRing: readonly (readonly [number, number, number])[];
  /** Overall height above the tower's own base, metres. */
  readonly heightMeters: number;
}

export interface TowerGeometry {
  readonly parts: Readonly<Record<TowerPartName, TowerPart>>;
  readonly attachments: TowerAttachments;
}

/**
 * Tower dimensions, metres — a regional tower, not a major-hub one.
 *
 * **On the Gate 7D criterion, "the tower reads as a tower from 3 NM": at 720p
 * this tower is 6.8 px tall at that range, and no realistically-sized tower
 * would be much more.** 3 NM is 5,556 m; 46 m subtends 0.474°, and a 720p frame
 * over a ~50° vertical FOV spans 0.069°/px. Reaching even 20 px would need a
 * 135 m tower, which no field like this one has.
 *
 * Measured rather than modelled: at `approach-500ft`'s 2.5 km the rendered
 * footprint is **17 px tall**, against 15.2 px predicted — so the arithmetic is
 * the right arithmetic and the 3 NM figure follows from it.
 *
 * **An earlier version of this comment claimed "hundreds of pixels tall", which
 * was wrong by two orders of magnitude and was never checked.** The criterion
 * as literally written cannot be met by a plausible tower at this resolution;
 * what 6.8 px does achieve is a distinct vertical mark against the horizon,
 * which is what a tower looks like at 3 NM in life. Flagged for the criterion
 * to be re-read rather than silently satisfied by inflating the geometry.
 */
const BASE_HALF = 7;
const BASE_TOP_HALF = 5;
const BASE_HEIGHT = 6;
const SHAFT_BOTTOM_HALF = 5;
const SHAFT_TOP_HALF = 3.5;
const SHAFT_TOP_Y = 32;
const GALLERY_HALF = 8;
const GALLERY_THICKNESS = 0.4;
const RAILING_HEIGHT = 1.1;
const RAILING_POSTS = 16;
const CAB_FLOOR_HALF = 5.5;
const CAB_ROOF_HALF = 6.25;
const CAB_HEIGHT = 4;
const MAST_RADIUS = 0.35;
const MAST_HEIGHT = 10;

/** Octagonal cross-sections throughout — a tower silhouette, not a chimney. */
import {
  AIRFIELD_ASPECT_V_START,
  AIRFIELD_CONCRETE_TILE_METERS,
  AIRFIELD_METAL_TILE_METERS,
} from "../airfield/AirfieldMaterials";

/**
 * Which 7-11 surface each part is drawn with, and therefore which tile period
 * its U is measured in. **Read off `AirportSystem`'s material map rather than
 * chosen here** — the two must agree or the UVs are metrically right for a
 * texture the part does not carry.
 */
export const TOWER_PART_SURFACE = Object.freeze({
  base: "concrete", shaft: "concrete", gallery: "concrete",
  railing: "metal", cab: "glass", cabRoof: "metal", mast: "metal",
} as const);

/** Metres of surface one tile covers along U, by surface. */
export const TOWER_TILE_METERS = Object.freeze({
  concrete: AIRFIELD_CONCRETE_TILE_METERS,
  metal: AIRFIELD_METAL_TILE_METERS,
  // Untextured: any period is inert, so it takes metal's rather than inventing
  // a third number that would read as meaningful.
  glass: AIRFIELD_METAL_TILE_METERS,
});

/**
 * `7-11`'s aspect V-start for a face, from the HORIZONTAL direction it looks.
 *
 * **The hangar tests `Math.abs(normal[0]) > 0.5` on the full normal, and that
 * is the same thing ONLY because its walls are vertical.** A tower band is
 * raked, so its outward normal carries a vertical component that shrinks the
 * horizontal ones — a steeply raked face pointing straight at the runway can
 * read `|n.x| < 0.5` and be classified a side. Aspect is about which way a face
 * looks in PLAN, not how far it leans, so this takes the in-plane direction.
 *
 * Runway-relative, never compass: the runway lies in −across from the tower, so
 * a −x face is the one the airfield sees and maintains.
 */
function aspectVStartFor(horizontalX: number): number {
  if (Math.abs(horizontalX) <= 0.5) return AIRFIELD_ASPECT_V_START.sides;
  return horizontalX < 0
    ? AIRFIELD_ASPECT_V_START.facingRunway
    : AIRFIELD_ASPECT_V_START.awayFromRunway;
}

const SIDES = 8;

interface Accumulator {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function accumulator(): Accumulator {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

function vertex(
  acc: Accumulator,
  p: readonly [number, number, number],
  n: readonly [number, number, number],
  u: number,
  v: number,
): number {
  const index = acc.positions.length / 3;
  acc.positions.push(p[0], p[1], p[2]);
  acc.normals.push(n[0], n[1], n[2]);
  acc.uvs.push(u, v);
  return index;
}

/**
 * A triangle whose corners are given CLOCKWISE as seen from outside.
 *
 * The convention lives here so a call site cannot pick a different one
 * silently. `post()` is the one caller that authors the other way and says so.
 */
function tri(acc: Accumulator, a: number, b: number, c: number): void {
  acc.indices.push(a, b, c);
}

/** A quad in outward-CW order, as two triangles. */
function quad(acc: Accumulator, a: number, b: number, c: number, d: number): void {
  tri(acc, a, b, c);
  tri(acc, a, c, d);
}

function finish(acc: Accumulator): TowerPart {
  return {
    positions: new Float32Array(acc.positions),
    normals: new Float32Array(acc.normals),
    uvs: new Float32Array(acc.uvs),
    indices: new Uint32Array(acc.indices),
  };
}

/** Unit octagon corner `i`, in the across/along plane. */
function corner(i: number, half: number): readonly [number, number] {
  const angle = (i / SIDES) * Math.PI * 2 + Math.PI / SIDES;
  // Scaled so `half` is the apothem-ish half-extent rather than the
  // circumradius; keeps the declared dimensions readable as "across".
  const r = half / Math.cos(Math.PI / SIDES);
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

/**
 * A closed prism/frustum band between two heights, with a cap at each end when
 * asked. Side normals are the true outward normal of the sloped face, computed
 * from the ring radii rather than assumed horizontal — a raked cab lit with
 * horizontal normals reads flat, which is the whole point of raking it.
 */
function band(
  acc: Accumulator,
  bottomHalf: number,
  topHalf: number,
  bottomY: number,
  topY: number,
  capBottom: boolean,
  capTop: boolean,
  tileMeters: number,
): void {
  const dy = topY - bottomY;
  const dr = topHalf - bottomHalf;
  const slopeLength = Math.hypot(dy, dr) || 1;
  // Outward normal of a sloped side: radial component dy, vertical −dr.
  const radial = dy / slopeLength;
  const vertical = -dr / slopeLength;

  const height = topY - bottomY;
  // Running arc distance around the ring, so U is continuous across the seams.
  let uOrigin = 0;
  for (let i = 0; i < SIDES; i += 1) {
    const j = (i + 1) % SIDES;
    const b0 = corner(i, bottomHalf);
    const b1 = corner(j, bottomHalf);
    const t0 = corner(i, topHalf);
    const t1 = corner(j, topHalf);
    // Face normal from the mid-edge direction, so the two corners of a face
    // share it and the octagon reads faceted rather than smooth.
    const mx = (b0[0] + b1[0]) * 0.5;
    const mz = (b0[1] + b1[1]) * 0.5;
    const ml = Math.hypot(mx, mz) || 1;
    const n: readonly [number, number, number] = [
      (mx / ml) * radial, vertical, (mz / ml) * radial,
    ];
    // `7-11` UV CONTRACT. U runs along the face in METRES / tileMeters and
    // wraps; V runs DOWN the face from the aspect start to 1, so weathering
    // accumulates with +V and reads as gravity.
    //
    // **U is arc length, not `i / SIDES`.** A normalised sweep gives every band
    // one tile per face regardless of size, so the mast — an eighth of the
    // base's girth — would carry the same seam count and read far coarser. The
    // running `uOrigin` carries distance across the eight seams so tiling does
    // not restart at each, the way the hangar carries `uOriginMeters` across a
    // split gable.
    const uAt = (px: number, pz: number): number =>
      (uOrigin + Math.hypot(px - b0[0], pz - b0[1])) / tileMeters;
    // Aspect from the face's in-plane direction; see `aspectVStartFor`.
    const aspect = aspectVStartFor(mx / ml);
    // A zero-height band (the railing's top rail) has no top-to-bottom run to
    // put a gradient on, matching the hangar's `height > 1e-9` guard.
    const vTop = aspect;
    const vBottom = height > 1e-9 ? 1 : aspect;
    // Outward-CCW seen from outside: bottom-left, bottom-right, top-right,
    // top-left.
    const a = vertex(acc, [b0[0], bottomY, b0[1]], n, uAt(b0[0], b0[1]), vBottom);
    const b = vertex(acc, [b1[0], bottomY, b1[1]], n, uAt(b1[0], b1[1]), vBottom);
    const c = vertex(acc, [t1[0], topY, t1[1]], n, uAt(t1[0], t1[1]), vTop);
    const d = vertex(acc, [t0[0], topY, t0[1]], n, uAt(t0[0], t0[1]), vTop);
    quad(acc, a, b, c, d);
    uOrigin += Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
  }

  if (capTop) {
    const up: readonly [number, number, number] = [0, 1, 0];
    const centre = vertex(acc, [0, topY, 0], up, 0.5, 0.5);
    const ring: number[] = [];
    for (let i = 0; i < SIDES; i += 1) {
      const c0 = corner(i, topHalf);
      ring.push(vertex(acc, [c0[0], topY, c0[1]], up, 0.5 + c0[0] * 0.02, 0.5 + c0[1] * 0.02));
    }
    // Seen from above (+y), CCW is increasing angle.
    for (let i = 0; i < SIDES; i += 1) {
      tri(acc, centre, ring[i]!, ring[(i + 1) % SIDES]!);
    }
  }

  if (capBottom) {
    const down: readonly [number, number, number] = [0, -1, 0];
    const centre = vertex(acc, [0, bottomY, 0], down, 0.5, 0.5);
    const ring: number[] = [];
    for (let i = 0; i < SIDES; i += 1) {
      const c0 = corner(i, bottomHalf);
      ring.push(vertex(acc, [c0[0], bottomY, c0[1]], down, 0.5 + c0[0] * 0.02, 0.5 + c0[1] * 0.02));
    }
    // Seen from BELOW, CCW is decreasing angle — hence the reversed pair.
    for (let i = 0; i < SIDES; i += 1) {
      tri(acc, centre, ring[(i + 1) % SIDES]!, ring[i]!);
    }
  }
}

/** An axis-aligned rectangular post, as a closed box with authored normals. */
function post(
  acc: Accumulator,
  cx: number, cz: number,
  halfX: number, halfZ: number,
  bottomY: number, topY: number,
  tileMeters: number,
): void {
  const x0 = cx - halfX, x1 = cx + halfX;
  const z0 = cz - halfZ, z1 = cz + halfZ;
  const faces: ReadonlyArray<{
    n: readonly [number, number, number];
    c: ReadonlyArray<readonly [number, number, number]>;
  }> = [
    { n: [0, 0, 1], c: [[x0, bottomY, z1], [x1, bottomY, z1], [x1, topY, z1], [x0, topY, z1]] },
    { n: [0, 0, -1], c: [[x1, bottomY, z0], [x0, bottomY, z0], [x0, topY, z0], [x1, topY, z0]] },
    { n: [1, 0, 0], c: [[x1, bottomY, z1], [x1, bottomY, z0], [x1, topY, z0], [x1, topY, z1]] },
    { n: [-1, 0, 0], c: [[x0, bottomY, z0], [x0, bottomY, z1], [x0, topY, z1], [x0, topY, z0]] },
    { n: [0, 1, 0], c: [[x0, topY, z1], [x1, topY, z1], [x1, topY, z0], [x0, topY, z0]] },
    { n: [0, -1, 0], c: [[x0, bottomY, z0], [x1, bottomY, z0], [x1, bottomY, z1], [x0, bottomY, z1]] },
  ];
  const height = topY - bottomY;
  for (const face of faces) {
    // Same `7-11` contract as `band()`: U in metres / tileMeters from the
    // face's own corner 0, V from the aspect start at the TOP down to 1.
    // A horizontal cap (n.y = +/-1) has no top or bottom edge to run a
    // gravity gradient between, so it takes the aspect start flat rather than
    // a gradient invented from its plan extent.
    const horizontal = Math.hypot(face.n[0], face.n[2]);
    const aspect = horizontal > 1e-9
      ? aspectVStartFor(face.n[0] / horizontal)
      : AIRFIELD_ASPECT_V_START.sides;
    const flat = horizontal <= 1e-9 || height <= 1e-9;
    const origin = face.c[0]!;
    const idx = face.c.map((p, i) => vertex(
      acc, p, face.n,
      Math.hypot(p[0] - origin[0], p[2] - origin[2]) / tileMeters,
      flat ? aspect : (i > 1 ? aspect : 1),
    ));
    // Reversed relative to the list above: these faces are authored
    // CCW-seen-from-outside, where `band()` authors CW. Measured, not
    // reasoned — the railing was the one part reading agreement +0.714
    // while every band read -1.000, which is what a mixed convention
    // inside a single surface looks like.
    quad(acc, idx[0]!, idx[3]!, idx[2]!, idx[1]!);
  }
}

/**
 * Build the tower.
 *
 * Pure and parameter-free by design: the tower is one authored structure rather
 * than a seeded family, so there is nothing here to key on a hash — and
 * therefore no opportunity to reach for the wrong seed. (`world.seedHash` vs
 * `sourceSeedHash` has already cost two Phase 6 items; the safest version of
 * that rule is not to need a seed.)
 */
export function buildTowerGeometry(): TowerGeometry {
  const parts = {} as Record<TowerPartName, TowerPart>;
  // Each part's tile period, via its surface — so a part that changes material
  // changes period in one place and cannot drift from `AirportSystem`'s map.
  const TILE = Object.fromEntries(
    TOWER_PART_NAMES.map((name) => [name, TOWER_TILE_METERS[TOWER_PART_SURFACE[name]]]),
  ) as Record<TowerPartName, number>;

  const baseAcc = accumulator();
  band(baseAcc, BASE_HALF, BASE_TOP_HALF, 0, BASE_HEIGHT, false, false, TILE.base);
  parts.base = finish(baseAcc);

  const shaftAcc = accumulator();
  band(shaftAcc, SHAFT_BOTTOM_HALF, SHAFT_TOP_HALF, BASE_HEIGHT, SHAFT_TOP_Y, false, false, TILE.shaft);
  parts.shaft = finish(shaftAcc);

  // The gallery is a slab, not a ring: an annulus would need an inner wall and
  // the shaft already occupies that volume.
  const galleryAcc = accumulator();
  band(
    galleryAcc, GALLERY_HALF, GALLERY_HALF,
    SHAFT_TOP_Y - GALLERY_THICKNESS, SHAFT_TOP_Y, true, true, TILE.gallery,
  );
  parts.gallery = finish(galleryAcc);

  const railAcc = accumulator();
  const railTop = SHAFT_TOP_Y + RAILING_HEIGHT;
  for (let i = 0; i < RAILING_POSTS; i += 1) {
    const angle = (i / RAILING_POSTS) * Math.PI * 2;
    const r = GALLERY_HALF / Math.cos(Math.PI / SIDES) - 0.35;
    post(
      railAcc, Math.cos(angle) * r, Math.sin(angle) * r,
      0.06, 0.06, SHAFT_TOP_Y, railTop, TILE.railing,
    );
  }
  // Top rail, as a thin band closing the ring.
  band(railAcc, GALLERY_HALF - 0.3, GALLERY_HALF - 0.3, railTop - 0.09, railTop, true, true, TILE.railing);
  parts.railing = finish(railAcc);

  // The cab RAKES OUTWARD — wider at the roof than the floor — which is what
  // makes a control tower read as one rather than as a water tank. It also
  // angles the glass down toward the runway, which is why real cabs do it.
  const cabAcc = accumulator();
  band(cabAcc, CAB_FLOOR_HALF, CAB_ROOF_HALF, SHAFT_TOP_Y, SHAFT_TOP_Y + CAB_HEIGHT, false, false, TILE.cab);
  parts.cab = finish(cabAcc);

  const roofY = SHAFT_TOP_Y + CAB_HEIGHT;
  const roofAcc = accumulator();
  band(roofAcc, CAB_ROOF_HALF, CAB_ROOF_HALF - 0.6, roofY, roofY + 0.7, false, true, TILE.cabRoof);
  parts.cabRoof = finish(roofAcc);

  const mastBottom = roofY + 0.7;
  const mastAcc = accumulator();
  band(mastAcc, MAST_RADIUS, MAST_RADIUS * 0.6, mastBottom, mastBottom + MAST_HEIGHT, false, true, TILE.mast);
  parts.mast = finish(mastAcc);

  // Completeness: the roster and the build must agree. A part named and not
  // built would otherwise reach the winding test as `undefined` and be skipped
  // — passing by examining nothing, which is the failure this file's docblock
  // exists to prevent.
  for (const name of TOWER_PART_NAMES) {
    if (!parts[name]) throw new Error(`tower part '${name}' is named but not built`);
  }

  const cabRoofRing: Array<readonly [number, number, number]> = [];
  for (let i = 0; i < SIDES; i += 1) {
    const c0 = corner(i, CAB_ROOF_HALF - 0.3);
    cabRoofRing.push([c0[0], roofY + 0.7, c0[1]]);
  }

  return {
    parts,
    attachments: {
      beaconMount: [0, roofY + 0.7, 0],
      mastTip: [0, mastBottom + MAST_HEIGHT, 0],
      cabRoofRing,
      heightMeters: mastBottom + MAST_HEIGHT,
    },
  };
}
