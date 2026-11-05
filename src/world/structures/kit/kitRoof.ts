import type { StructureSurface } from "../structureModel";
import { STRUCTURE_EAVE_OVERHANG } from "../structureEnvelope";
import { type KitBuilder, FACE, type Vec3, add, beam, scale } from "./kitBuilder";
import type { RoofForm } from "./kitStyles";

/**
 * Pitched roofs over a rectangular body: gable (two slabs, gable triangles
 * on the end walls, barge boards) or hip (four faces as polygons). Both have
 * a fascia board along every eave whose outer face is exactly the eaves'
 * overhang (`STRUCTURE_EAVE_OVERHANG`) out from the walls, and a soffit (the
 * slab's underside) under the overhang.
 *
 * THE EAVE LINE is the fascia's bottom edge: the lowest point of the roof.
 * The roof's collider box has its underside there, and rooms stop below it.
 * The walls reach up past it to meet the slab's underside (`wallTop`), so the
 * closed attic sits between the eave line and the ridge.
 */

/** Fascia board thickness; the slab stops this far inside the eaves' overhang. */
export const FASCIA_THICKNESS = 0.03;
/** How far the fascia hangs below the slab's underside edge. */
export const FASCIA_DROP = 0.02;
/** Slab thickness, perpendicular to the slope. */
export const ROOF_THICKNESS = 0.2;

export interface RoofSpec {
  readonly form: RoofForm;
  /** The ridge's axis: "x" (eaves on the front and back) or "z" (gables front and back). */
  readonly ridge: "x" | "z";
  /** Half the body (walls' outer faces) along x and z. */
  readonly halfW: number;
  readonly halfD: number;
  /** Radians. */
  readonly pitch: number;
  /** Gable overhang past the end walls, to the barge board's outer face. */
  readonly rake: number;
  /** The eave line (the fascia's bottom), building frame y. */
  readonly eaveY: number;
  readonly covering: StructureSurface;
  readonly colour: number;
  readonly trimColour: number;
  readonly soffitColour: number;
  /** The gable triangles' cladding. */
  readonly gableSurface: StructureSurface;
  readonly gableColour: number;
}

export interface RoofGeometry {
  /** Where the slab's underside meets the walls' outer faces: the eave walls' top. */
  readonly wallTop: number;
  /** The roof surface's highest line (without the ridge cap). */
  readonly ridgeY: number;
  /** The ridge cap's top. */
  readonly topY: number;
  /** The slab's underside height at a distance `c` across from the ridge line (|c| from 0 to the eaves). */
  readonly undersideAt: (c: number) => number;
  /** The roof surface's height at a distance `c` across from the ridge line. */
  readonly surfaceAt: (c: number) => number;
  /** Half the roof's plan along x and z, fascias included. */
  readonly planHalfX: number;
  readonly planHalfZ: number;
}

/** The roof's numbers, without drawing anything. */
export function roofGeometry(spec: RoofSpec): RoofGeometry {
  const overhang = STRUCTURE_EAVE_OVERHANG;
  const halfC = spec.ridge === "x" ? spec.halfD : spec.halfW;
  const halfA = spec.ridge === "x" ? spec.halfW : spec.halfD;
  const tan = Math.tan(spec.pitch);
  const sin = Math.sin(spec.pitch);
  const cos = Math.cos(spec.pitch);
  const t = ROOF_THICKNESS;
  // The top surface's outer edge touches the fascia's inner face.
  const cT = halfC + overhang - FASCIA_THICKNESS;
  const yU = spec.eaveY + FASCIA_DROP;
  const cU = cT - t * sin;
  const yT = yU + t * cos;
  const undersideAt = (c: number) => yU + (cU - Math.abs(c)) * tan;
  const surfaceAt = (c: number) => yT + (cT - Math.abs(c)) * tan;
  const ridgeY = surfaceAt(0);
  const capHeight = spec.covering === "metal" ? 0.05 : 0.09;
  const planA = spec.form === "hip" ? halfA + overhang : halfA + spec.rake;
  return {
    wallTop: undersideAt(halfC),
    ridgeY,
    topY: ridgeY + capHeight,
    undersideAt,
    surfaceAt,
    planHalfX: spec.ridge === "x" ? planA : halfC + overhang,
    planHalfZ: spec.ridge === "x" ? halfC + overhang : planA,
  };
}

/** Axis vectors: A along the ridge, C across it. */
function axes(ridge: "x" | "z"): { A: Vec3; C: Vec3 } {
  return ridge === "x" ? { A: [1, 0, 0], C: [0, 0, 1] } : { A: [0, 0, 1], C: [1, 0, 0] };
}

/** A point from ridge coordinates (a along, y, c across). */
function at(ridge: "x" | "z", a: number, y: number, c: number): Vec3 {
  return ridge === "x" ? [a, y, c] : [c, y, a];
}

/** Push a polygon facing `normal` (reorders the corners if they wind the other way). */
export function polygonFacing(b: KitBuilder, corners: readonly Vec3[], normal: Vec3, surface: StructureSurface, colour: number, indoor = 0): void {
  // Newell's normal of the corners as given.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const p = corners[i]!;
    const q = corners[(i + 1) % corners.length]!;
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const ordered = nx * normal[0] + ny * normal[1] + nz * normal[2] >= 0 ? corners : [...corners].reverse();
  b.polygon(ordered.flatMap((p) => [p[0], p[1], p[2]]), surface, colour, indoor);
}

/**
 * Draw the roof (closed and open levels: slabs, fascias, barges, caps,
 * gables; block level: the bare surfaces and gables). Returns its geometry.
 */
export function drawRoof(b: KitBuilder, spec: RoofSpec): RoofGeometry {
  const g = roofGeometry(spec);
  const { A, C } = axes(spec.ridge);
  const r = spec.ridge;
  const halfC = r === "x" ? spec.halfD : spec.halfW;
  const halfA = r === "x" ? spec.halfW : spec.halfD;
  const sin = Math.sin(spec.pitch);
  const cos = Math.cos(spec.pitch);
  const overhang = STRUCTURE_EAVE_OVERHANG;
  const cT = halfC + overhang - FASCIA_THICKNESS;
  const yT = g.surfaceAt(cT);
  const t = ROOF_THICKNESS;

  if (spec.form === "gable") {
    const aOut = halfA + spec.rake - FASCIA_THICKNESS;
    // The gable triangles on the end walls, under the slabs.
    for (const end of [1, -1] as const) {
      const corners: Vec3[] = [
        at(r, end * (halfA + 0.002), g.wallTop, -halfC),
        at(r, end * (halfA + 0.002), g.wallTop, halfC),
        at(r, end * (halfA + 0.002), g.undersideAt(0), 0),
      ];
      polygonFacing(b, corners, scale(A, end), spec.gableSurface, spec.gableColour);
    }
    if (b.block) {
      for (const side of [1, -1] as const) {
        const corners: Vec3[] = [
          at(r, -aOut, yT, side * cT),
          at(r, aOut, yT, side * cT),
          at(r, aOut, g.ridgeY, 0),
          at(r, -aOut, g.ridgeY, 0),
        ];
        polygonFacing(b, corners, add(scale(C, side * sin), [0, cos, 0]), spec.covering, spec.colour);
      }
      return g;
    }
    for (const side of [1, -1] as const) {
      const n: Vec3 = add(scale(C, side * sin), [0, cos, 0]);
      const s: Vec3 = add(scale(C, -side * cos), [0, sin, 0]);
      const cU = cT - t * sin;
      const U: Vec3 = at(r, 0, g.undersideAt(cU), side * cU);
      const len = cT / cos;
      const centre = add(add(U, scale(n, t * 0.5)), scale(s, len * 0.5));
      const u = scale(A, aOut);
      const v = scale(n, t * 0.5);
      const w = scale(s, len * 0.5);
      b.obox(centre, u, v, w, spec.covering, spec.colour, FACE.py);
      b.obox(centre, u, v, w, "timber", spec.soffitColour, FACE.ny);
      // Fascia along the eave: from the eave line to the roof's edge, outer face at the overhang.
      const fc = side * (cT + FASCIA_THICKNESS * 0.5);
      const fy0 = spec.eaveY;
      const fy1 = yT;
      b.obox(
        at(r, 0, (fy0 + fy1) * 0.5, fc), scale(A, halfA + spec.rake), [0, (fy1 - fy0) * 0.5, 0], scale(C, FASCIA_THICKNESS * 0.5),
        "trim", spec.trimColour, FACE.px | FACE.nx | (side > 0 ? FACE.pz : FACE.nz),
      );
      // Barge boards over the slab's ends, from the fascia's top to the ridge.
      for (const end of [1, -1] as const) {
        // Proud of the slab by 0.04 above and FASCIA_DROP below, so its foot stays on the eave line.
        const bc = add(add(U, scale(n, (t + 0.04 - FASCIA_DROP) * 0.5)), scale(s, len * 0.5));
        const centreB = add(bc, scale(A, end * (aOut + FASCIA_THICKNESS * 0.5)));
        b.obox(centreB, scale(A, FASCIA_THICKNESS * 0.5), scale(n, (t + 0.04 + FASCIA_DROP) * 0.5), w, "trim", spec.trimColour, (end > 0 ? FACE.px : FACE.nx) | FACE.nz);
      }
    }
    // Ridge cap.
    const capH = g.topY - g.ridgeY;
    b.obox(at(r, 0, g.ridgeY + capH * 0.5 - 0.01, 0), scale(A, halfA + spec.rake), [0, capH * 0.5 + 0.01, 0], scale(C, 0.13),
      spec.covering === "metal" ? "metal" : spec.covering, shadeCap(spec.colour), FACE.py | FACE.px | FACE.nx | FACE.pz | FACE.nz);
    return g;
  }

  // Hip: four faces from the fascia line to the ridge (or the apex).
  const aT = halfA + overhang - FASCIA_THICKNESS;
  const ridgeHalf = Math.max(0, aT - cT);
  const yR = g.ridgeY;
  const faces: { corners: Vec3[]; normal: Vec3 }[] = [];
  for (const side of [1, -1] as const) {
    faces.push({
      corners: [at(r, -aT, yT, side * cT), at(r, aT, yT, side * cT), at(r, ridgeHalf, yR, 0), at(r, -ridgeHalf, yR, 0)],
      normal: add(scale(C, side * sin), [0, cos, 0]),
    });
    faces.push({
      corners: [at(r, side * aT, yT, -cT), at(r, side * aT, yT, cT), at(r, side * ridgeHalf, yR, 0)],
      normal: add(scale(A, side * sin), [0, cos, 0]),
    });
  }
  // The undersides: parallel planes a slab's thickness below, their eave edges pulled in by t sin(pitch).
  const yU = spec.eaveY + FASCIA_DROP;
  const aU = aT - t * sin;
  const cU = cT - t * sin;
  const yRU = g.undersideAt(0);
  const unders: Vec3[][] = [];
  for (const side of [1, -1] as const) {
    unders.push([at(r, -aU, yU, side * cU), at(r, aU, yU, side * cU), at(r, ridgeHalf, yRU, 0), at(r, -ridgeHalf, yRU, 0)]);
    unders.push([at(r, side * aU, yU, -cU), at(r, side * aU, yU, cU), at(r, side * ridgeHalf, yRU, 0)]);
  }
  faces.forEach((f, i) => {
    polygonFacing(b, f.corners, f.normal, spec.covering, spec.colour);
    if (!b.block) polygonFacing(b, unders[i]!, scale(f.normal, -1), "timber", spec.soffitColour);
  });
  if (b.block) return g;
  // Fascias all round; the ones across the ends run between the long ones.
  for (const side of [1, -1] as const) {
    const fc = side * (cT + FASCIA_THICKNESS * 0.5);
    b.obox(at(r, 0, (spec.eaveY + yT) * 0.5, fc), scale(A, aT + FASCIA_THICKNESS), [0, (yT - spec.eaveY) * 0.5, 0], scale(C, FASCIA_THICKNESS * 0.5),
      "trim", spec.trimColour, FACE.px | FACE.nx | (side > 0 ? FACE.pz : FACE.nz));
    const fa = side * (aT + FASCIA_THICKNESS * 0.5);
    const endFace = side > 0 ? FACE.px : FACE.nx;
    b.obox(at(r, fa, (spec.eaveY + yT) * 0.5, 0), scale(A, FASCIA_THICKNESS * 0.5), [0, (yT - spec.eaveY) * 0.5, 0], scale(C, cT),
      "trim", spec.trimColour, endFace);
  }
  // Caps along the hips and the ridge.
  const capColour = shadeCap(spec.colour);
  const capSurface = spec.covering === "metal" ? "metal" : spec.covering;
  for (const sa of [1, -1] as const) {
    for (const sc of [1, -1] as const) {
      // From a little in from the corner, so the cap's width stays inside the fascias.
      const inset = 0.09;
      const from = at(r, sa * (aT - inset), yT + inset * (sin / cos) + 0.03, sc * (cT - inset));
      const to = at(r, sa * ridgeHalf, yR + 0.03, 0);
      beam(b, from, to, 0.06, capSurface, capColour, FACE.all & ~FACE.ny & ~FACE.pz, 0, 0.16);
    }
  }
  if (ridgeHalf > 0.05) {
    b.obox(at(r, 0, yR + 0.025, 0), scale(A, ridgeHalf), [0, 0.035, 0], scale(C, 0.1), capSurface, capColour, FACE.py | FACE.px | FACE.nx | FACE.pz | FACE.nz);
  }
  return g;
}

function shadeCap(colour: number): number {
  const k = 0.82;
  const ch = (shift: number) => Math.round(((colour >> shift) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
