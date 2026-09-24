/**
 * THE 747'S FLIGHT-DECK GLAZING, sited by angle and cast onto the built skin.
 *
 * Each pane is specified as the window of sky it shows -- an azimuth and an
 * elevation range seen from a reference on the centreline at the pilots'
 * station -- and made by casting that window onto the nose's own triangles.
 * The panes used to be boxes placed by station and height, and the design in
 * docs/findings/AIRLINER_NOSE_GLAZING.md measured what that produced: an
 * opening about 19 degrees tall where the type's is ~35, the No.1 panes' top
 * edge sitting ON the crown, and No.3 reaching back behind the pilot's
 * shoulder. Specified by angle, the view is the input and the stations fall
 * out of it.
 *
 * TWO FRAMES, and confusing them is the trap the design nearly fell into:
 * azimuths are AIRCRAFT-frame, from `FLIGHT_DECK_REFERENCE` on the centreline,
 * so the glazing is symmetric about the aeroplane and the centre pillar is on
 * the centreline. The left-seat eye (`catalogue.cockpitEye`) is only where
 * the result is CHECKED from, and it is the cockpit engineer's to re-solve --
 * so the reference is pinned here rather than read from the eye, or re-solving
 * the eye would move the glass.
 *
 * Pure geometry: no Babylon. `airlinerVisual.ts` hands in the skin's
 * triangles and builds the meshes; the tests read the same functions.
 */

export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The azimuth reference: on the centreline at the pilots' station and eye height. */
export const FLIGHT_DECK_REFERENCE: Point3 = Object.freeze({ x: 29.9, y: 2.93, z: 0 });

/** A pane of any airframe's glazing, specified as the window of sky it shows from a reference point. */
export interface GlazingPane {
  readonly name: string;
  /** Degrees from dead ahead, outboard positive, on the pane's own side. */
  readonly azimuth: readonly [number, number];
  /** Degrees above the horizontal. */
  readonly elevation: readonly [number, number];
  /**
   * A pane whose edges are NOT lines of constant azimuth and elevation: the
   * (azimuth, elevation) at a point of the unit square, columns inboard to
   * outboard and rows bottom to top. A real windscreen's pillars and sills are
   * lines on the airframe, not sightlines from the reference, so a pane laid
   * out on the body is a curved patch in angle. When given, `azimuth` and
   * `elevation` are only its bounding ranges and the grid is cast through this.
   */
  readonly at?: (columnFraction: number, rowFraction: number) => readonly [number, number];
}

export interface FlightDeckPane extends GlazingPane {
  readonly name: "one" | "two" | "three";
  /** Degrees from dead ahead, outboard positive, on the pane's own side. */
  readonly azimuth: readonly [number, number];
  /** Degrees above the horizontal. */
  readonly elevation: readonly [number, number];
}

/**
 * The centre member's half-width, degrees of azimuth from the centreline at R:
 * the No.1 panes start here and the centre post fills the gap between them.
 * 1.9, not the design's first 2.5: seen from the left seat the member read
 * 5.5 degrees wide where the type's is about 3.6 (the cockpit engineer's K3
 * measurement). The cockpit engineer then measured it from the eye on the
 * kit's 2 cm lining at each candidate: 1.6 -> 3.11, 1.8 -> 3.48, 1.9 -> 3.67
 * (face 3.46 + side 0.20), 2.0 -> 3.85, against the type's 3.6 and a 3.8
 * ceiling. 1.9 is the nearest inside it.
 */
export const CENTRE_POST_HALF_AZIMUTH = 1.9;

/**
 * The accepted design. The centre member is +-CENTRE_POST_HALF_AZIMUTH;
 * between panes a 2-degree pillar is taken out of the ranges' shared edge (25
 * and 55), half from each side. No.1 runs 30 degrees tall (-18..+12) against
 * the type's ~35 and the old build's ~19.
 */
export const FLIGHT_DECK_PANES: readonly FlightDeckPane[] = Object.freeze([
  { name: "one", azimuth: [CENTRE_POST_HALF_AZIMUTH, 24], elevation: [-18, 12] },
  { name: "two", azimuth: [26, 54], elevation: [-15, 10] },
  { name: "three", azimuth: [56, 75], elevation: [-12, 8] },
]);

/**
 * Grid points per side of each pane. The nose is 28 segments round, so a pane
 * spans two to four facets, and between grid points the glass is a chord
 * across whatever facet crease lies under it. Measured on the built panes at
 * every cell centre: the outer face stays 2.2 cm or more outside the skin
 * (`PANE_PROUD` less up to 1.8 cm of that sag), the inner face 4.6 cm or more
 * inside it (tests/render.airliner-glazing.test.ts).
 */
export const PANE_GRID = 8;
/** Glass outside the skin, along the skin's normal. */
export const PANE_PROUD = 0.04;
/** Glass inside the skin: the inner face the cockpit looks through. */
export const PANE_DEPTH = 0.06;

/** The unit sightline at an azimuth and elevation; `side` +1 starboard (+z), -1 port. */
export function sightline(azimuthDegrees: number, elevationDegrees: number, side: 1 | -1): Point3 {
  const azimuth = (azimuthDegrees * Math.PI) / 180;
  const elevation = (elevationDegrees * Math.PI) / 180;
  return {
    x: Math.cos(elevation) * Math.cos(azimuth),
    y: Math.sin(elevation),
    z: side * Math.cos(elevation) * Math.sin(azimuth),
  };
}

/** A closed skin surface as a triangle soup, in the aircraft's body frame. */
export interface SkinTriangles {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  /** Per-vertex shading normals, so a hit can carry the normal the skin is lit with. */
  readonly normals: ArrayLike<number>;
}

export interface SkinHit {
  readonly point: Point3;
  /** The skin's shading normal at the hit, unit, pointing out of the body. */
  readonly normal: Point3;
  readonly distance: number;
}

/**
 * Where a ray from INSIDE the body leaves it.
 *
 * The body is a UNION of closed lofts (the fuselage is still the outer skin
 * aft of ~29.6 and the nose forward of it), and a ray from inside may cross a
 * buried cap or the other loft's surface before it gets out. So every
 * crossing is found and the FARTHEST is the exit -- right for as long as the
 * body is star-shaped from the origin along the ray, which a nose seen from
 * its own flight deck is. Faces are hit from either side: the exit is seen
 * from behind, and a caster that only hit front faces would find nothing.
 */
export class SkinCaster {
  private readonly surfaces: readonly SkinTriangles[];

  constructor(surfaces: readonly SkinTriangles[]) {
    if (surfaces.length === 0) throw new RangeError("A skin caster needs at least one surface");
    this.surfaces = surfaces;
  }

  exit(origin: Point3, direction: Point3, maxDistance = 10): SkinHit | null {
    let best: SkinHit | null = null;
    for (const surface of this.surfaces) {
      const { positions: p, indices, normals: n } = surface;
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const i0 = indices[t]! * 3;
        const i1 = indices[t + 1]! * 3;
        const i2 = indices[t + 2]! * 3;
        // Moller-Trumbore, two-sided.
        const e1x = p[i1]! - p[i0]!;
        const e1y = p[i1 + 1]! - p[i0 + 1]!;
        const e1z = p[i1 + 2]! - p[i0 + 2]!;
        const e2x = p[i2]! - p[i0]!;
        const e2y = p[i2 + 1]! - p[i0 + 1]!;
        const e2z = p[i2 + 2]! - p[i0 + 2]!;
        const px = direction.y * e2z - direction.z * e2y;
        const py = direction.z * e2x - direction.x * e2z;
        const pz = direction.x * e2y - direction.y * e2x;
        const determinant = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(determinant) < 1e-12) continue;
        const inverse = 1 / determinant;
        const sx = origin.x - p[i0]!;
        const sy = origin.y - p[i0 + 1]!;
        const sz = origin.z - p[i0 + 2]!;
        const u = (sx * px + sy * py + sz * pz) * inverse;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inverse;
        if (v < 0 || u + v > 1) continue;
        const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
        if (distance <= 1e-6 || distance > maxDistance) continue;
        if (best && distance <= best.distance) continue;
        const w = 1 - u - v;
        let nx = w * n[i0]! + u * n[i1]! + v * n[i2]!;
        let ny = w * n[i0 + 1]! + u * n[i1 + 1]! + v * n[i2 + 1]!;
        let nz = w * n[i0 + 2]! + u * n[i1 + 2]! + v * n[i2 + 2]!;
        const length = Math.hypot(nx, ny, nz);
        if (!(length > 0)) continue;
        // An exit is where the ray leaves: the outward normal is along it.
        const sign = nx * direction.x + ny * direction.y + nz * direction.z < 0 ? -1 : 1;
        nx = (sign * nx) / length;
        ny = (sign * ny) / length;
        nz = (sign * nz) / length;
        best = {
          point: {
            x: origin.x + direction.x * distance,
            y: origin.y + direction.y * distance,
            z: origin.z + direction.z * distance,
          },
          normal: { x: nx, y: ny, z: nz },
          distance,
        };
      }
    }
    return best;
  }
}

export interface PaneGrid {
  /** `[row][column]`: rows run bottom to top in elevation, columns inboard to outboard in azimuth. */
  readonly points: readonly (readonly Point3[])[];
  readonly normals: readonly (readonly Point3[])[];
}

/**
 * The pane's window of sky, cast onto the skin: PANE_GRID rows and, unless a
 * narrow strip asks for fewer, PANE_GRID columns. `reference` is the point the
 * angles are measured from: the 747's R unless another airframe names its own.
 */
export function paneGrid(
  caster: SkinCaster,
  pane: GlazingPane,
  side: 1 | -1,
  columns = PANE_GRID,
  reference: Point3 = FLIGHT_DECK_REFERENCE,
): PaneGrid {
  if (!Number.isInteger(columns) || columns < 2) throw new RangeError("A pane grid needs at least two columns");
  const points: Point3[][] = [];
  const normals: Point3[][] = [];
  for (let row = 0; row < PANE_GRID; row += 1) {
    const rowFraction = row / (PANE_GRID - 1);
    const pointRow: Point3[] = [];
    const normalRow: Point3[] = [];
    for (let column = 0; column < columns; column += 1) {
      const columnFraction = column / (columns - 1);
      const [azimuth, elevation] = pane.at
        ? pane.at(columnFraction, rowFraction)
        : [
            pane.azimuth[0] + (pane.azimuth[1] - pane.azimuth[0]) * columnFraction,
            pane.elevation[0] + (pane.elevation[1] - pane.elevation[0]) * rowFraction,
          ];
      const hit = caster.exit(reference, sightline(azimuth, elevation, side));
      if (!hit) {
        throw new RangeError(`flight-deck pane ${pane.name}: no skin at az ${azimuth.toFixed(2)}, el ${elevation.toFixed(2)}`);
      }
      pointRow.push(hit.point);
      normalRow.push(hit.normal);
    }
    points.push(pointRow);
    normals.push(normalRow);
  }
  return { points, normals };
}
