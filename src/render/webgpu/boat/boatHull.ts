import {
  createHullLinesSample,
  featureExtent,
  HULL_LENGTH,
  HULL_REVERSE_CHINE,
  HULL_STRAKES,
  sampleHullLines,
  transomX,
  type HullLinesSample,
} from "@/src/vehicles/boat/hullLines";
import { finishUv, type BoatFinish } from "./boatAtlas";
import { earClip, Surface, type Vec3Tuple } from "./boatMeshData";

/**
 * The Runabout 21's drawn hull, lofted from the physics thread's lines
 * (`src/vehicles/boat/hullLines.ts`) and nothing else, so the hull on screen
 * is the hull that floats. Everything here is in the HULL frame (+x forward
 * from the transom's bottom edge, +y up from the keel baseline, +z starboard);
 * `createWebGpuBoat` moves it to the body frame.
 *
 * THE SECTION. `hullHalfSection` is the lines' own section builder; it drops
 * a strake where it has run out, so its point count changes along the hull.
 * A loft needs one topology from transom to stem, so `drawnHalfSection` emits
 * the SAME points with the same formulas, keeping a run-out strake as a
 * zero-width one in place (its three corners coincide on the bottom panel).
 * `tests/render.boat-model.test.ts` holds the two to each other wherever every
 * feature is present.
 *
 * THE TRANSOM. The lines put the transom on a plane raked 12 degrees, top
 * forward (`transomX(y)`), and say to evaluate the aft ring at x = 0 and move
 * each point onto that plane. Every ring within `TRANSOM_BLEND_METERS` of the
 * transom is moved by the same rule faded out with distance, so the rings
 * never cross: a point at height y on ring x sits at
 * x + transomX(y) (1 - x / TRANSOM_BLEND_METERS).
 */
export const TRANSOM_BLEND_METERS = 0.6;

/** Fixed-topology half-section: these kinds, in this order, at every station. */
export const DRAWN_SECTION_KINDS = Object.freeze([
  "keel",
  "strake0Inner", "strake0Outer", "strake0Step",
  "strake1Inner", "strake1Outer", "strake1Step",
  "strake2Inner", "strake2Outer", "strake2Step",
  "chine",
  "reverseChineOuter",
  "sheer",
] as const);
export const DRAWN_SECTION_POINTS = DRAWN_SECTION_KINDS.length;
const REVERSE_CHINE = DRAWN_SECTION_KINDS.indexOf("reverseChineOuter");
const SHEER = DRAWN_SECTION_KINDS.indexOf("sheer");

/** (z, y) pairs, z >= 0, keel to sheer. */
export type HalfSection = [number, number][];

const DEG = Math.PI / 180;
const scratchLines = createHullLinesSample();

/** The drawn half-section at nominal station `x`, into `out` (resized to `DRAWN_SECTION_POINTS`). */
export function drawnHalfSection(x: number, out: HalfSection = [], lines: HullLinesSample = scratchLines): HalfSection {
  sampleHullLines(x, lines);
  out.length = 0;
  const tanDeadrise = Math.tan(lines.deadrise * DEG);
  const chine = lines.chineHalfBeam;
  out.push([0, lines.keel]);
  for (const strake of HULL_STRAKES) {
    const extent = chine > 0 ? featureExtent(strake, lines.x) : 0;
    const zInner = strake.fraction * chine;
    // `hullHalfSection` skips a strake that would reach the chine; here it
    // narrows to fit, which is the same thing at zero width.
    const width = Math.max(0, Math.min(strake.width * extent, chine - zInner));
    const yInner = lines.keel + zInner * tanDeadrise;
    const zOuter = zInner + width;
    out.push([zInner, yInner]);
    out.push([zOuter, yInner - width * Math.tan(strake.downAngle * DEG)]);
    out.push([zOuter, lines.keel + zOuter * tanDeadrise]);
  }
  out.push([chine, lines.chineHeight]);
  const reverse = chine > 0 ? featureExtent(HULL_REVERSE_CHINE, lines.x) : 0;
  const reverseWidth = HULL_REVERSE_CHINE.width * reverse;
  out.push([chine + reverseWidth, lines.chineHeight - reverseWidth * Math.tan(HULL_REVERSE_CHINE.downAngle * DEG)]);
  out.push([lines.sheerHalfBeam, lines.sheerHeight]);
  return out;
}

/** Where a point of nominal station `x` at height `y` is drawn along the hull. */
export function drawnStationX(x: number, y: number): number {
  return x + transomX(y) * Math.max(0, 1 - x / TRANSOM_BLEND_METERS);
}

/**
 * The hull's half-breadth at height `y` on station `x`: the first crossing of
 * that height going up the section from the keel, or the sheer half-breadth
 * above the sheer. 0 below the keel.
 */
export function hullHalfBreadthAt(x: number, y: number, section: HalfSection = drawnHalfSection(x, [])): number {
  if (y <= section[0]![1]) return 0;
  for (let index = 1; index < section.length; index += 1) {
    const [z0, y0] = section[index - 1]!;
    const [z1, y1] = section[index]!;
    if ((y0 <= y && y <= y1) || (y1 <= y && y <= y0)) {
      if (Math.abs(y1 - y0) < 1e-9) return Math.max(z0, z1);
      return z0 + ((y - y0) / (y1 - y0)) * (z1 - z0);
    }
  }
  return section[section.length - 1]![0];
}

/**
 * The topsides' livery, as heights on the hull: the hull colour from the
 * chine up to `sheer - LIVERY.colourBelowSheer(x)`, then a white gap, a
 * pinstripe, and white gelcoat to the sheer. The colour line follows the
 * sheer, a little closer to it forward, as sport-boat graphics run.
 */
export const LIVERY = Object.freeze({
  colourBelowSheerAft: 0.27,
  colourBelowSheerForward: 0.2,
  gap: 0.028,
  pinstripe: 0.022,
});

function colourBelowSheer(x: number): number {
  const t = Math.min(1, Math.max(0, x / HULL_LENGTH));
  return LIVERY.colourBelowSheerAft + (LIVERY.colourBelowSheerForward - LIVERY.colourBelowSheerAft) * t;
}

/** Stations along the hull, closer where the bow curves fastest. */
export function hullStations(): number[] {
  const stations: number[] = [];
  for (let x = 0; x < 4.5 - 1e-9; x += 0.15) stations.push(x);
  for (let x = 4.5; x < 6.0 - 1e-9; x += 0.075) stations.push(x);
  for (let x = 6.0; x < HULL_LENGTH - 1e-9; x += 0.035) stations.push(x);
  stations.push(HULL_LENGTH);
  return stations;
}

function lerpPoint(a: readonly [number, number], b: readonly [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * The starboard half of the hull's skin as smoothing groups: one per bottom
 * panel, strake face and reverse-chine flat, and one per livery band on the
 * topsides. Mirror for port.
 */
export function hullSkinSurfaces(stations: readonly number[] = hullStations()): Surface[] {
  const sections = stations.map((x) => drawnHalfSection(x, []));
  const surfaces: Surface[] = [];
  const place = (i: number, point: readonly [number, number]): Vec3Tuple => [drawnStationX(stations[i]!, point[1]), point[1], point[0]];

  // Keel to reverse chine: every panel its own group, so each edge is crisp.
  for (let j = 0; j < REVERSE_CHINE; j += 1) {
    const surface = new Surface();
    const rows = sections.map((section, i) => [place(i, section[j]!), place(i, section[j + 1]!)]);
    const uv = finishUv("bottom");
    surface.grid(rows, () => uv);
    surfaces.push(surface);
  }

  // Topsides, reverse chine to sheer, split into the livery bands.
  const bands: { finish: BoatFinish; from: (i: number) => number; to: (i: number) => number }[] = [];
  const topsideHeight = (i: number, fromSheer: number): number => sections[i]![SHEER]![1] - fromSheer;
  const colourTop = (i: number) => topsideHeight(i, colourBelowSheer(stations[i]!));
  const gapTop = (i: number) => colourTop(i) + LIVERY.gap;
  const stripeTop = (i: number) => gapTop(i) + LIVERY.pinstripe;
  bands.push({ finish: "hullColour", from: () => Number.NEGATIVE_INFINITY, to: colourTop });
  bands.push({ finish: "gelcoat", from: colourTop, to: gapTop });
  bands.push({ finish: "pinstripe", from: gapTop, to: stripeTop });
  bands.push({ finish: "gelcoat", from: stripeTop, to: () => Number.POSITIVE_INFINITY });
  for (const band of bands) {
    const surface = new Surface();
    const rows = sections.map((section, i) => {
      const low = section[REVERSE_CHINE]!;
      const high = section[SHEER]!;
      const span = high[1] - low[1];
      const at = (height: number): [number, number] => {
        if (!(span > 1e-9)) return height === Number.POSITIVE_INFINITY ? [high[0], high[1]] : [low[0], low[1]];
        const t = Math.min(1, Math.max(0, (height - low[1]) / span));
        return lerpPoint(low, high, t);
      };
      return [place(i, at(band.from(i))), place(i, at(band.to(i)))];
    });
    const uv = finishUv(band.finish);
    surface.grid(rows, () => uv);
    surfaces.push(surface);
  }
  return surfaces;
}

/** The motor-well notch in the transom's top edge (hull frame). */
export const MOTOR_WELL = Object.freeze({
  halfWidth: 0.4,
  /** The notch's floor: the outboard bracket's 25 in mount height. */
  floorY: 0.635,
  /** The well's forward wall. */
  forwardX: 0.5,
});

/**
 * The transom face, both sides at once: the aft ring's outline (keel, round
 * the bottom to the sheer each side) closed along the top with the motor-well
 * notch, on the raked plane. Shows aft.
 */
export function transomSurface(): Surface {
  const ring = drawnHalfSection(0, []);
  // The aft deck's height, which the notch's sides rise to.
  const top = ring[SHEER]![1] + 0.012;
  // Counter-clockwise seen from astern, where +z is to the viewer's right.
  const outline: [number, number][] = [];
  for (const [z, y] of ring) outline.push([z, y]);
  outline.push([MOTOR_WELL.halfWidth, top]);
  outline.push([MOTOR_WELL.halfWidth, MOTOR_WELL.floorY]);
  outline.push([-MOTOR_WELL.halfWidth, MOTOR_WELL.floorY]);
  outline.push([-MOTOR_WELL.halfWidth, top]);
  for (let index = ring.length - 1; index >= 1; index -= 1) outline.push([-ring[index]![0], ring[index]![1]]);
  const surface = new Surface();
  const triangles = earClip(outline);
  // One finish for the whole face: a UV that changed across it would blend
  // through the atlas texels between two swatches.
  const uv = finishUv("gelcoat");
  const vertices = outline.map(([z, y]) => surface.vertexAt([transomX(y), y, z], uv));
  // Seen from astern the outline runs counter-clockwise with +z to the right
  // and +y up, so (z, y) -> (x, y, z) shows the -x side, as the transom must.
  for (let index = 0; index < triangles.length; index += 3) {
    surface.tri(vertices[triangles[index]!]!, vertices[triangles[index + 1]!]!, vertices[triangles[index + 2]!]!);
  }
  return surface;
}

/** The sheer line at station x (hull frame), starboard, at its drawn x. */
export function sheerPoint(x: number): Vec3Tuple {
  const section = drawnHalfSection(x, []);
  const [z, y] = section[SHEER]!;
  return [drawnStationX(x, y), y, z];
}

/**
 * The rub rail along the sheer, starboard: a black rubber profile standing
 * proud of the topsides with a stainless insert. It is swept along the sheer
 * from the transom to the stem, offset outward along the sheer's plan normal.
 */
export function rubRailSurfaces(stations: readonly number[] = hullStations()): Surface[] {
  const path = stations.map((x) => sheerPoint(x));
  const profile: { readonly out: number; readonly up: number }[] = [
    { out: 0, up: 0.012 },
    { out: 0.022, up: 0.006 },
    { out: 0.026, up: -0.012 },
    { out: 0.022, up: -0.034 },
    { out: 0, up: -0.04 },
  ];
  const rubber = new Surface();
  const insert = new Surface();
  const rows: Vec3Tuple[][] = [];
  const insertRows: Vec3Tuple[][] = [];
  for (let i = 0; i < path.length; i += 1) {
    const before = path[Math.max(0, i - 1)]!;
    const after = path[Math.min(path.length - 1, i + 1)]!;
    const dx = after[0] - before[0];
    const dz = after[2] - before[2];
    const length = Math.hypot(dx, dz) || 1;
    // Outward in plan for the starboard side: the tangent turned clockwise.
    const nx = dz / length;
    const nz = -dx / length;
    const outward = nz < 0 ? { x: -nx, z: -nz } : { x: nx, z: nz };
    const [px, py, pz] = path[i]!;
    rows.push(profile.map(({ out, up }) => [px + outward.x * out, py + up, pz + outward.z * out] as const));
    insertRows.push([
      [px + outward.x * 0.0275, py - 0.004, pz + outward.z * 0.0275],
      [px + outward.x * 0.0275, py - 0.019, pz + outward.z * 0.0275],
    ]);
  }
  // Girth runs top to bottom on the outside, so (station) x (down) shows
  // inboard; flipped, it shows out.
  rubber.grid(rows, () => finishUv("rubber"));
  insert.grid(insertRows, () => finishUv("stainless"));
  return [rubber.flipped(), insert.flipped()];
}
