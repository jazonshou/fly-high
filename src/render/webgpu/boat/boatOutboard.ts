import { RUNABOUT_21_OUTBOARD } from "@/src/vehicles/boat/hullLines";
import { finishUv, type BoatFinish } from "./boatAtlas";
import { bevelledBox } from "./boatDeck";
import { Surface, type Vec3Tuple } from "./boatMeshData";

/**
 * The 200 hp V6 outboard and its propeller, hull frame at zero trim and zero
 * steer, hung from the physics thread's points (`RUNABOUT_21_OUTBOARD`): the
 * tilt pivot, the steering axis, the propeller hub and its 14.5 in diameter,
 * the anti-ventilation plate level with the keel, the gearcase and the skeg.
 *
 * The cowl is the powerhead's 0.77 m long, 0.57 m wide shell centred on
 * `powerhead`, black gloss with a grey lower cover; the leg is a streamlined
 * section, black above the plate and grey below, ending in the gearcase
 * torpedo and the skeg.
 */

interface CowlStation {
  readonly x: number;
  readonly centreY: number;
  readonly halfHeight: number;
  readonly halfWidth: number;
}

const POWERHEAD = RUNABOUT_21_OUTBOARD.powerhead;

/** Front to back. The top line rises a little aft, as cowls do. */
const COWL_STATIONS: readonly CowlStation[] = [
  { x: POWERHEAD.x + 0.4, centreY: POWERHEAD.y - 0.05, halfHeight: 0.12, halfWidth: 0.11 },
  { x: POWERHEAD.x + 0.37, centreY: POWERHEAD.y - 0.035, halfHeight: 0.24, halfWidth: 0.21 },
  { x: POWERHEAD.x + 0.3, centreY: POWERHEAD.y - 0.02, halfHeight: 0.31, halfWidth: 0.265 },
  { x: POWERHEAD.x + 0.12, centreY: POWERHEAD.y, halfHeight: 0.345, halfWidth: 0.285 },
  { x: POWERHEAD.x - 0.12, centreY: POWERHEAD.y + 0.01, halfHeight: 0.35, halfWidth: 0.285 },
  { x: POWERHEAD.x - 0.26, centreY: POWERHEAD.y + 0.025, halfHeight: 0.32, halfWidth: 0.26 },
  { x: POWERHEAD.x - 0.35, centreY: POWERHEAD.y + 0.05, halfHeight: 0.25, halfWidth: 0.2 },
  { x: POWERHEAD.x - 0.385, centreY: POWERHEAD.y + 0.07, halfHeight: 0.14, halfWidth: 0.11 },
];

/** A superellipse ring in (z, y) about `centreY`, top first, going to starboard. */
function superellipseRing(station: CowlStation, segments: number, exponent: number): Vec3Tuple[] {
  const ring: Vec3Tuple[] = [];
  for (let k = 0; k <= segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2;
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const z = station.halfWidth * Math.sign(s) * Math.abs(s) ** (2 / exponent);
    const y = station.centreY + station.halfHeight * Math.sign(c) * Math.abs(c) ** (2 / exponent);
    ring.push([station.x, y, z]);
  }
  return ring;
}

/** A loft of rings front to back (decreasing x), shown outward, with both ends closed on a point. */
function closedLoft(stations: readonly CowlStation[], segments: number, exponent: number, finish: BoatFinish): Surface[] {
  const body = new Surface();
  const rings = stations.map((station) => superellipseRing(station, segments, exponent));
  const uv = finishUv(finish);
  body.grid(rings, () => uv);
  const surfaces = [body];
  for (const [ring, station, facing] of [
    [rings[0]!, stations[0]!, [1, 0, 0] as Vec3Tuple],
    [rings[rings.length - 1]!, stations[stations.length - 1]!, [-1, 0, 0] as Vec3Tuple],
  ] as const) {
    const cap = new Surface();
    const centre = cap.vertex(station.x + facing[0] * 0.012, station.centreY, 0, uv[0], uv[1]);
    const vertices = ring.map((point) => cap.vertexAt(point, uv));
    for (let k = 0; k < segments; k += 1) cap.triFacing(centre, vertices[k]!, vertices[k + 1]!, facing);
    surfaces.push(cap);
  }
  return surfaces;
}

/** A streamlined horizontal section: leading edge at `leadX`, trailing at `trailX`, `halfThickness` at its widest. */
function foilRing(leadX: number, trailX: number, halfThickness: number, y: number, points = 14): Vec3Tuple[] {
  const ring: Vec3Tuple[] = [];
  // Leading edge, down the starboard side to the trailing edge, back up port.
  for (let k = 0; k <= points; k += 1) {
    const t = k / points;
    const xi = 0.5 - 0.5 * Math.cos(Math.PI * t);
    // NACA four-digit thickness, scaled so its widest is `halfThickness`.
    const naca = 0.2969 * Math.sqrt(xi) - 0.126 * xi - 0.3516 * xi ** 2 + 0.2843 * xi ** 3 - 0.1036 * xi ** 4;
    ring.push([leadX + (trailX - leadX) * xi, y, Math.max(0, halfThickness * 10 * naca)]);
  }
  for (let k = points - 1; k >= 0; k -= 1) {
    const [x, , z] = ring[k]!;
    ring.push([x, y, -z]);
  }
  return ring;
}

/** A leg section extruded bottom to top, shown outward. */
function legSurface(
  y0: number,
  y1: number,
  lead: readonly [number, number],
  trail: readonly [number, number],
  thickness: readonly [number, number],
  finish: BoatFinish,
): Surface {
  const surface = new Surface();
  const rows = [0, 0.5, 1].map((t) =>
    foilRing(
      lead[0] + (lead[1] - lead[0]) * t,
      trail[0] + (trail[1] - trail[0]) * t,
      thickness[0] + (thickness[1] - thickness[0]) * t,
      y0 + (y1 - y0) * t,
    ),
  );
  const uv = finishUv(finish);
  surface.grid(rows, () => uv);
  return surface;
}

/** A body of revolution about an axis parallel to x through (y, z = 0): `profile` is (x, radius) nose to tail. */
function revolution(profile: readonly (readonly [number, number])[], axisY: number, segments: number, finish: BoatFinish): Surface {
  const surface = new Surface();
  const rows = profile.map(([x, radius]) => {
    const ring: Vec3Tuple[] = [];
    for (let k = 0; k <= segments; k += 1) {
      const angle = (k / segments) * Math.PI * 2;
      ring.push([x, axisY + Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    return ring;
  });
  const uv = finishUv(finish);
  surface.grid(rows, () => uv);
  return surface;
}

/** A thin plate: `outline` (x, z) counter-clockwise seen from above, between y0 and y1. */
function plate(outline: readonly (readonly [number, number])[], y0: number, y1: number, finish: BoatFinish): Surface[] {
  const uv = finishUv(finish);
  const top = new Surface();
  const bottom = new Surface();
  const edge = new Surface();
  const n = outline.length;
  const topRing = outline.map(([x, z]) => top.vertex(x, y1, z, uv[0], uv[1]));
  const bottomRing = outline.map(([x, z]) => bottom.vertex(x, y0, z, uv[0], uv[1]));
  for (let k = 1; k < n - 1; k += 1) {
    top.triFacing(topRing[0]!, topRing[k]!, topRing[k + 1]!, [0, 1, 0]);
    bottom.triFacing(bottomRing[0]!, bottomRing[k]!, bottomRing[k + 1]!, [0, -1, 0]);
  }
  let cx = 0;
  let cz = 0;
  for (const [x, z] of outline) {
    cx += x / n;
    cz += z / n;
  }
  for (let k = 0; k < n; k += 1) {
    const [ax, az] = outline[k]!;
    const [bx, bz] = outline[(k + 1) % n]!;
    const a0 = edge.vertex(ax, y0, az, uv[0], uv[1]);
    const a1 = edge.vertex(ax, y1, az, uv[0], uv[1]);
    const b0 = edge.vertex(bx, y0, bz, uv[0], uv[1]);
    const b1 = edge.vertex(bx, y1, bz, uv[0], uv[1]);
    const outward: Vec3Tuple = [(ax + bx) / 2 - cx, 0, (az + bz) / 2 - cz];
    edge.triFacing(a0, b0, b1, outward);
    edge.triFacing(a0, b1, a1, outward);
  }
  return [top, bottom, edge];
}

/** The engine below the transom bracket, hull frame, at zero trim and steer: everything that tilts and steers. */
export function outboardSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const outboard = RUNABOUT_21_OUTBOARD;
  const hubY = outboard.propellerHub.y;
  surfaces.push(...closedLoft(COWL_STATIONS, 32, 3.2, "cowl"));
  // The lower motor cover under the cowl.
  surfaces.push(...closedLoft([
    { x: POWERHEAD.x + 0.33, centreY: 0.7, halfHeight: 0.05, halfWidth: 0.17 },
    { x: POWERHEAD.x + 0.25, centreY: 0.7, halfHeight: 0.075, halfWidth: 0.235 },
    { x: POWERHEAD.x - 0.15, centreY: 0.705, halfHeight: 0.08, halfWidth: 0.25 },
    { x: POWERHEAD.x - 0.3, centreY: 0.715, halfHeight: 0.065, halfWidth: 0.2 },
    { x: POWERHEAD.x - 0.33, centreY: 0.72, halfHeight: 0.04, halfWidth: 0.12 },
  ], 24, 3, "lowerUnit"));
  // The steering head round the swivel tube, between the bracket and the leg.
  const steer = outboard.steerAxisPoint;
  surfaces.push(...bevelledBox([steer.x - 0.05, steer.y - 0.14, -0.075], [steer.x + 0.06, steer.y + 0.1, 0.075], 0.015, "anodized"));
  // Midsection, black, from the plate up into the lower cover.
  surfaces.push(legSurface(0.012, 0.66, [-0.2, -0.17], [-0.47, -0.5], [0.07, 0.09], "cowl"));
  // Gearcase leg below the plate, grey.
  surfaces.push(legSurface(hubY + 0.03, 0.0, [-0.26, -0.22], [-0.45, -0.46], [0.045, 0.06], "lowerUnit"));
  // The anti-ventilation plate, level with the keel.
  const plateEdge = outboard.antiVentilationPlate;
  surfaces.push(...plate([
    [-0.21, 0.06], [plateEdge.forwardX, 0.13], [plateEdge.aftX + 0.06, 0.125], [plateEdge.aftX, 0.06],
    [plateEdge.aftX, -0.06], [plateEdge.aftX + 0.06, -0.125], [plateEdge.forwardX, -0.13], [-0.21, -0.06],
  ], plateEdge.y - 0.008, plateEdge.y + 0.012, "lowerUnit"));
  // The gearcase torpedo, nose to the propeller.
  surfaces.push(revolution([
    [-0.15, 0], [-0.155, 0.026], [-0.17, 0.042], [-0.2, 0.053], [-0.28, 0.058], [-0.4, 0.055], [outboard.propellerHub.x + 0.02, 0.047],
  ], hubY, 20, "lowerUnit"));
  // The skeg, a thin fin to `skegBottom`.
  const skeg = outboard.skegBottom;
  surfaces.push(...fin([[-0.33, hubY - 0.04], [-0.5, hubY - 0.04], [skeg.x - 0.012, skeg.y], [skeg.x + 0.035, skeg.y + 0.01]], 0.007, "lowerUnit"));
  // A zinc anode under the plate.
  surfaces.push(revolution([[-0.42, 0], [-0.425, 0.014], [-0.5, 0.014], [-0.505, 0]], plateEdge.y - 0.025, 10, "zinc"));
  // A red accent line round the cowl's side, the maker's stripe without a maker.
  surfaces.push(...cowlStripe());
  return surfaces;
}

/** A thin vertical fin in the x-y plane: `outline` (x, y), half-thickness `half`. */
function fin(outline: readonly (readonly [number, number])[], half: number, finish: BoatFinish): Surface[] {
  const uv = finishUv(finish);
  const surfaces: Surface[] = [];
  for (const side of [1, -1]) {
    const face = new Surface();
    const vertices = outline.map(([x, y]) => face.vertex(x, y, side * half, uv[0], uv[1]));
    for (let k = 1; k < vertices.length - 1; k += 1) face.triFacing(vertices[0]!, vertices[k]!, vertices[k + 1]!, [0, 0, side]);
    surfaces.push(face);
  }
  const edge = new Surface();
  let cx = 0;
  let cy = 0;
  for (const [x, y] of outline) {
    cx += x / outline.length;
    cy += y / outline.length;
  }
  for (let k = 0; k < outline.length; k += 1) {
    const [ax, ay] = outline[k]!;
    const [bx, by] = outline[(k + 1) % outline.length]!;
    const a0 = edge.vertex(ax, ay, -half, uv[0], uv[1]);
    const a1 = edge.vertex(ax, ay, half, uv[0], uv[1]);
    const b0 = edge.vertex(bx, by, -half, uv[0], uv[1]);
    const b1 = edge.vertex(bx, by, half, uv[0], uv[1]);
    const outward: Vec3Tuple = [(ax + bx) / 2 - cx, (ay + by) / 2 - cy, 0];
    edge.triFacing(a0, b0, b1, outward);
    edge.triFacing(a0, b1, a1, outward);
  }
  surfaces.push(edge);
  return surfaces;
}

/** A band 2.5 cm tall round the cowl's sides, a hair proud of the shell. */
function cowlStripe(): Surface[] {
  const surfaces: Surface[] = [];
  const middle = COWL_STATIONS.slice(1, -1);
  for (const side of [1, -1]) {
    const band = new Surface();
    const rows = middle.map((station) => {
      const at = (dy: number): Vec3Tuple => {
        const t = Math.min(1, Math.abs((POWERHEAD.y + dy - station.centreY) / station.halfHeight));
        const z = station.halfWidth * (1 - t ** 3.2) ** (1 / 3.2) + 0.002;
        return [station.x, POWERHEAD.y + dy, side * z];
      };
      return [at(-0.05), at(-0.025)];
    });
    band.grid(rows, () => finishUv("cowlAccent"));
    // Girth runs up, stations aft: that shows -z, outward only to port.
    surfaces.push(side > 0 ? band.flipped() : band);
  }
  return surfaces;
}

/** Propeller geometry, in the propeller's own frame: hub centre at the origin, shaft along x, forward +x. */
export const PROPELLER = Object.freeze({
  radius: RUNABOUT_21_OUTBOARD.propellerDiameter / 2,
  hubRadius: 0.045,
  blades: 3,
  /** 19 in pitch, the class's usual stainless three-blade. */
  pitch: 0.48,
  /** The lower unit's reduction, crank to propeller (a 200 hp V6's 1.85:1). */
  gearRatio: 1.85,
});

/** The propeller's chord at radius fraction rho (0 hub .. 1 tip), metres: widest past mid-span, round at the tip. */
function bladeChord(rho: number): number {
  return 0.165 * Math.sqrt(Math.max(0, 1 - rho * rho)) * (0.45 + 0.55 * rho) + 0.004;
}

/**
 * Three helical blades and the hub. Each blade sits on the helix of the
 * pitch: at radius r its chord is inclined atan(pitch / 2 pi r) to the shaft's
 * plane, from about 60 degrees at the hub to 22 at the tip, the twist a real
 * propeller has. A blade is two faces 6 mm apart and an edge.
 */
export function propellerSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const uv = finishUv("propeller");
  const radial = 9;
  const chordwise = 7;
  for (let blade = 0; blade < PROPELLER.blades; blade += 1) {
    const base = (blade / PROPELLER.blades) * Math.PI * 2;
    for (const side of [1, -1]) {
      const face = new Surface();
      const grid: number[][] = [];
      for (let i = 0; i <= radial; i += 1) {
        const rho = i / radial;
        const r = PROPELLER.hubRadius + (PROPELLER.radius - PROPELLER.hubRadius) * rho;
        const beta = Math.atan2(PROPELLER.pitch, 2 * Math.PI * r);
        const chord = bladeChord(rho);
        const row: number[] = [];
        for (let j = 0; j <= chordwise; j += 1) {
          const u = j / chordwise - 0.5;
          const thickness = 0.003 * (1 - 0.7 * rho) * Math.cos(Math.PI * u);
          const angle = base + (u * chord * Math.cos(beta)) / r;
          const x = -u * chord * Math.sin(beta) + side * thickness;
          row.push(face.vertex(x, Math.cos(angle) * r, Math.sin(angle) * r, uv[0], uv[1]));
        }
        grid.push(row);
      }
      for (let i = 0; i < radial; i += 1) {
        for (let j = 0; j < chordwise; j += 1) {
          face.triFacing(grid[i]![j]!, grid[i + 1]![j]!, grid[i + 1]![j + 1]!, [side, 0, 0]);
          face.triFacing(grid[i]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!, [side, 0, 0]);
        }
      }
      surfaces.push(face);
    }
  }
  // The hub barrel and its exhaust outlet, aft to the cone.
  const hub = new Surface();
  const profile: readonly (readonly [number, number])[] = [
    [0.03, 0], [0.03, 0.04], [0.02, PROPELLER.hubRadius], [-0.06, PROPELLER.hubRadius - 0.004], [-0.1, 0.03], [-0.12, 0.012], [-0.122, 0],
  ];
  const rows = profile.map(([x, radius]) => {
    const ring: Vec3Tuple[] = [];
    for (let k = 0; k <= 18; k += 1) {
      const angle = (k / 18) * Math.PI * 2;
      ring.push([x, Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    return ring;
  });
  hub.grid(rows, () => uv);
  surfaces.push(hub);
  return surfaces;
}
