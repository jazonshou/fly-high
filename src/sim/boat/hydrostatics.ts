import type { Vec3 } from "../types";
import type { HullMesh } from "./hullMesh";

/**
 * Hydrostatics at any attitude, after Kerner ("Water interaction model for
 * boats in video games", 2015): every hull triangle is clipped against the
 * local water surface and each submerged piece is pushed by the pressure of
 * the water above it,
 *
 *   dF = -rho g d n dA,   d = depth below the local surface,
 *
 * integrated EXACTLY over each piece for the linear depth field: the force is
 * -rho g A d_centroid n and the moment uses the triangle's second moment,
 * int(d r dA) = A/12 (sum d_i sum r_i + sum d_i r_i). Because the surface is
 * the wave surface, the Froude-Krylov part of the wave load comes with it, and
 * an upright, heeled, swamped or upside-down hull all integrate the same way.
 *
 * The submerged pieces are kept (centroid, area vector, mean depth, tag) for
 * the skin-friction pass, which spreads ITTC-57 friction over them.
 */

/** Room for two clipped pieces per triangle. */
export interface HydrostaticPieces {
  count: number;
  readonly centroid: Float64Array;
  readonly areaVector: Float64Array;
  readonly depth: Float64Array;
  readonly tag: Uint8Array;
  readonly triangle: Uint16Array;
}

export interface HydrostaticResult {
  /** World force and world torque about the CG, N and N m. */
  readonly force: Vec3;
  readonly torque: Vec3;
  /** Submerged volume, m^3 (the buoyant part, before any pressure weighting). */
  volume: number;
  /** Wetted area of the bottom and chine pieces, m^2. */
  bottomArea: number;
  readonly pieces: HydrostaticPieces;
}

export function createHydrostaticResult(mesh: HullMesh): HydrostaticResult {
  const capacity = mesh.triangleCount * 2;
  return {
    force: { x: 0, y: 0, z: 0 },
    torque: { x: 0, y: 0, z: 0 },
    volume: 0,
    bottomArea: 0,
    pieces: {
      count: 0,
      centroid: new Float64Array(capacity * 3),
      areaVector: new Float64Array(capacity * 3),
      depth: new Float64Array(capacity),
      tag: new Uint8Array(capacity),
      triangle: new Uint16Array(capacity),
    },
  };
}

// Scratch for one clipped piece: three points (relative to the CG) and depths.
const px = new Float64Array(3);
const py = new Float64Array(3);
const pz = new Float64Array(3);
const pd = new Float64Array(3);

/**
 * Integrate the mesh against the water. `worldVertices` are the mesh's vertices
 * in the world, `depth` their depth below the local surface (positive under
 * water), `pressureWeight` a per-triangle factor on the pressure (1 normally;
 * the near-transom release and a dry transom lower it). `rhoG` is the water's
 * specific weight.
 */
export function integrateHydrostatics(
  mesh: HullMesh,
  worldVertices: Float64Array,
  depth: Float64Array,
  centre: Readonly<Vec3>,
  pressureWeight: Float64Array,
  rhoG: number,
  out: HydrostaticResult,
): HydrostaticResult {
  const force = out.force;
  const torque = out.torque;
  force.x = 0;
  force.y = 0;
  force.z = 0;
  torque.x = 0;
  torque.y = 0;
  torque.z = 0;
  out.volume = 0;
  out.bottomArea = 0;
  out.pieces.count = 0;
  const triangles = mesh.triangles;
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const i0 = triangles[t * 3]!;
    const i1 = triangles[t * 3 + 1]!;
    const i2 = triangles[t * 3 + 2]!;
    const d0 = depth[i0]!;
    const d1 = depth[i1]!;
    const d2 = depth[i2]!;
    const wet0 = d0 > 0;
    const wet1 = d1 > 0;
    const wet2 = d2 > 0;
    const wetCount = (wet0 ? 1 : 0) + (wet1 ? 1 : 0) + (wet2 ? 1 : 0);
    if (wetCount === 0) continue;
    if (wetCount === 3) {
      loadPoint(0, worldVertices, i0, d0, centre);
      loadPoint(1, worldVertices, i1, d1, centre);
      loadPoint(2, worldVertices, i2, d2, centre);
      addPiece(out, t, mesh.tags[t]!, pressureWeight[t]!, rhoG);
      continue;
    }
    // Rotate (cyclically, keeping the winding) so the odd vertex is first:
    // the lone wet one when one is wet, the lone dry one when two are.
    let a = i0;
    let b = i1;
    let c = i2;
    let da = d0;
    let db = d1;
    let dc = d2;
    const loneWet = wetCount === 1;
    const odd0 = loneWet ? wet0 : !wet0;
    const odd1 = loneWet ? wet1 : !wet1;
    if (odd1) {
      a = i1;
      b = i2;
      c = i0;
      da = d1;
      db = d2;
      dc = d0;
    } else if (!odd0) {
      a = i2;
      b = i0;
      c = i1;
      da = d2;
      db = d0;
      dc = d1;
    }
    const tab = da / (da - db);
    const tac = da / (da - dc);
    if (loneWet) {
      // Piece: a, a->b crossing, a->c crossing.
      loadPoint(0, worldVertices, a, da, centre);
      loadCrossing(1, worldVertices, a, b, tab, centre);
      loadCrossing(2, worldVertices, a, c, tac, centre);
      addPiece(out, t, mesh.tags[t]!, pressureWeight[t]!, rhoG);
    } else {
      // a is dry; b and c are wet. Quad b, c, c->a crossing, a->b crossing.
      loadPoint(0, worldVertices, b, db, centre);
      loadPoint(1, worldVertices, c, dc, centre);
      loadCrossing(2, worldVertices, a, c, tac, centre);
      addPiece(out, t, mesh.tags[t]!, pressureWeight[t]!, rhoG);
      loadPoint(0, worldVertices, b, db, centre);
      loadCrossing(1, worldVertices, a, c, tac, centre);
      loadCrossing(2, worldVertices, a, b, tab, centre);
      addPiece(out, t, mesh.tags[t]!, pressureWeight[t]!, rhoG);
    }
  }
  return out;
}

function loadPoint(slot: number, world: Float64Array, index: number, d: number, centre: Readonly<Vec3>): void {
  px[slot] = world[index * 3]! - centre.x;
  py[slot] = world[index * 3 + 1]! - centre.y;
  pz[slot] = world[index * 3 + 2]! - centre.z;
  pd[slot] = d;
}

/** The waterline crossing on edge from -> to, a fraction `t` along it; its depth is zero. */
function loadCrossing(slot: number, world: Float64Array, from: number, to: number, t: number, centre: Readonly<Vec3>): void {
  const fx = world[from * 3]!;
  const fy = world[from * 3 + 1]!;
  const fz = world[from * 3 + 2]!;
  px[slot] = fx + (world[to * 3]! - fx) * t - centre.x;
  py[slot] = fy + (world[to * 3 + 1]! - fy) * t - centre.y;
  pz[slot] = fz + (world[to * 3 + 2]! - fz) * t - centre.z;
  pd[slot] = 0;
}

function addPiece(out: HydrostaticResult, triangle: number, tag: number, weight: number, rhoG: number): void {
  const e1x = px[1]! - px[0]!;
  const e1y = py[1]! - py[0]!;
  const e1z = pz[1]! - pz[0]!;
  const e2x = px[2]! - px[0]!;
  const e2y = py[2]! - py[0]!;
  const e2z = pz[2]! - pz[0]!;
  const ax = 0.5 * (e1y * e2z - e1z * e2y);
  const ay = 0.5 * (e1z * e2x - e1x * e2z);
  const az = 0.5 * (e1x * e2y - e1y * e2x);
  const depthSum = pd[0]! + pd[1]! + pd[2]!;
  const meanDepth = depthSum / 3;
  // Buoyant volume counts every piece at full pressure (the waterplane closes it).
  out.volume -= meanDepth * ay;
  const scale = -rhoG * weight;
  const pressure = scale * meanDepth;
  out.force.x += pressure * ax;
  out.force.y += pressure * ay;
  out.force.z += pressure * az;
  // S = sum(d) sum(r) + sum(d r); torque = (S / 12) x (scale * A).
  const sx = (depthSum * (px[0]! + px[1]! + px[2]!) + pd[0]! * px[0]! + pd[1]! * px[1]! + pd[2]! * px[2]!) / 12;
  const sy = (depthSum * (py[0]! + py[1]! + py[2]!) + pd[0]! * py[0]! + pd[1]! * py[1]! + pd[2]! * py[2]!) / 12;
  const sz = (depthSum * (pz[0]! + pz[1]! + pz[2]!) + pd[0]! * pz[0]! + pd[1]! * pz[1]! + pd[2]! * pz[2]!) / 12;
  const fx = scale * ax;
  const fy = scale * ay;
  const fz = scale * az;
  out.torque.x += sy * fz - sz * fy;
  out.torque.y += sz * fx - sx * fz;
  out.torque.z += sx * fy - sy * fx;
  const pieces = out.pieces;
  const index = pieces.count;
  if (index * 3 + 2 >= pieces.centroid.length) return;
  pieces.count = index + 1;
  pieces.centroid[index * 3] = (px[0]! + px[1]! + px[2]!) / 3;
  pieces.centroid[index * 3 + 1] = (py[0]! + py[1]! + py[2]!) / 3;
  pieces.centroid[index * 3 + 2] = (pz[0]! + pz[1]! + pz[2]!) / 3;
  pieces.areaVector[index * 3] = ax;
  pieces.areaVector[index * 3 + 1] = ay;
  pieces.areaVector[index * 3 + 2] = az;
  pieces.depth[index] = meanDepth;
  pieces.tag[index] = tag;
  pieces.triangle[index] = triangle;
  if (tag <= 1) out.bottomArea += Math.hypot(ax, ay, az);
}
