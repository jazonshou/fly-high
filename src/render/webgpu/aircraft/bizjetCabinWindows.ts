import { SkinCaster, type Point3 } from "./airlinerGlazing";

/**
 * THE GLOBAL'S CABIN WINDOWS, cast onto the fuselage as built.
 *
 * The row as the type has it, measured against Bombardier's own renders
 * (docs/findings/GLOBAL_LIVERY.md): fourteen a side, the first 6.2 m aft of
 * the nose tip, 0.92 m apart, the top edge at y 0.65-0.71. What was wrong was
 * the pane, not the row. It was a 12-sided oval, 20 % short of the type's 300
 * square inches, and it was drawn FLAT: it was bowed to the section by writing
 * into a buffer created non-updatable, which Babylon drops without a word, so
 * the CPU copy every test read was bowed while the GPU drew a flat cylinder
 * whose face crossed the skin at y 0.19 and cut every window off there.
 *
 * Now each pane is a grid in the window's own outline -- a rounded rectangle
 * 0.37 x 0.56 m, a superellipse of exponent 4, 0.192 m^2 = 298 in^2 -- and every
 * grid point is found by casting straight out of the body onto the fuselage's
 * OWN triangles, so the glass lies on the facets the skin is drawn with.
 * `skinPanel` builds each pane once from those points; nothing is written into
 * a buffer after it is made. Pure geometry here, no Babylon.
 */
export const CABIN_WINDOW_COUNT = 14;
/** The forward-most window's station, and the pitch aft from it. */
export const CABIN_WINDOW_FORWARD_X = 8.8;
export const CABIN_WINDOW_PITCH = 0.92;
/** The window centre's height: sill 0.10, top 0.66. */
export const CABIN_WINDOW_CENTRE_Y = 0.38;
export const CABIN_WINDOW_WIDTH = 0.37;
export const CABIN_WINDOW_HEIGHT = 0.56;
/** The outline's superellipse exponent: 2 is an ellipse, higher is squarer. 4 reads as the type's rounded rectangle. */
export const CABIN_WINDOW_SQUARENESS = 4;
/**
 * Glass outside the skin along its normal. The grid points lie ON the facets,
 * and between two of them the glass is a chord across whatever crease is under
 * it: at the row's height the 48-segment section creases every 7.5 degrees,
 * and a 5.6 cm cell straddling one lets the skin rise up to 1.8 mm above the
 * chord. 6 mm clears that everywhere with 4 mm to spare -- measured on the
 * built panes by `render.bizjet-cabin-windows` -- and still reads as flush.
 */
export const CABIN_PANE_PROUD = 0.006;
/** Glass inside the skin: the inner face, closed to the outer by the rim. */
export const CABIN_PANE_DEPTH = 0.03;
/** Grid points across (x) and up (y). Cells of 6.2 x 5.6 cm. */
export const CABIN_PANE_COLUMNS = 7;
export const CABIN_PANE_ROWS = 11;

/** Every window's station, forward to aft. */
export function cabinWindowStations(): number[] {
  return Array.from({ length: CABIN_WINDOW_COUNT }, (_, index) => CABIN_WINDOW_FORWARD_X - index * CABIN_WINDOW_PITCH);
}

/**
 * A point of the unit square (s, t in -1..1) mapped into the window's outline
 * as an offset from its centre, in metres. RADIAL: each concentric square of
 * the grid goes to the concentric superellipse of the same scale, so the
 * square's edge lands on the outline and the grid stays a grid (which is what
 * `skinPanel` takes). The centre maps to itself.
 */
export function cabinWindowOffset(s: number, t: number): { dx: number; dy: number } {
  const halfWidth = CABIN_WINDOW_WIDTH / 2;
  const halfHeight = CABIN_WINDOW_HEIGHT / 2;
  const scale = Math.max(Math.abs(s), Math.abs(t));
  if (scale === 0) return { dx: 0, dy: 0 };
  // The direction's point on the square's edge, and how far along that
  // direction the superellipse's edge is, both in the outline's own axes.
  const ex = (s / scale) * halfWidth;
  const ey = (t / scale) * halfHeight;
  const n = CABIN_WINDOW_SQUARENESS;
  const reach = (Math.abs(ex / halfWidth) ** n + Math.abs(ey / halfHeight) ** n) ** (-1 / n);
  return { dx: ex * reach * scale, dy: ey * reach * scale };
}

/** The outline's area, m^2: 4ab Gamma(1+1/n)^2 / Gamma(1+2/n), in closed form for n = 4. */
export function cabinWindowArea(): number {
  // Gamma(1.25)^2 / Gamma(1.5) = 0.906402477^2 / 0.886226925
  const shape = CABIN_WINDOW_SQUARENESS === 4 ? (0.9064024770554771 ** 2) / 0.886226925452758 : Number.NaN;
  return 4 * (CABIN_WINDOW_WIDTH / 2) * (CABIN_WINDOW_HEIGHT / 2) * shape;
}

export interface CabinPaneGrid {
  /** `[row][column]`: rows run bottom to top, columns aft to forward. */
  readonly points: readonly (readonly Point3[])[];
  readonly normals: readonly (readonly Point3[])[];
}

/**
 * One window's outline cast onto the skin: for each grid point, a ray from the
 * body's centre plane straight out through that station and height; where it
 * leaves the body is the skin point, carrying the skin's shading normal.
 */
export function cabinPaneGrid(caster: SkinCaster, station: number, side: 1 | -1): CabinPaneGrid {
  const points: Point3[][] = [];
  const normals: Point3[][] = [];
  for (let row = 0; row < CABIN_PANE_ROWS; row += 1) {
    const t = -1 + (2 * row) / (CABIN_PANE_ROWS - 1);
    const pointRow: Point3[] = [];
    const normalRow: Point3[] = [];
    for (let column = 0; column < CABIN_PANE_COLUMNS; column += 1) {
      const s = -1 + (2 * column) / (CABIN_PANE_COLUMNS - 1);
      const { dx, dy } = cabinWindowOffset(s, t);
      const origin = { x: station + dx, y: CABIN_WINDOW_CENTRE_Y + dy, z: 0 };
      const hit = caster.exit(origin, { x: 0, y: 0, z: side }, 3);
      if (!hit) throw new RangeError(`cabin window at x ${station.toFixed(2)}: no skin at (${origin.x.toFixed(3)}, ${origin.y.toFixed(3)})`);
      pointRow.push(hit.point);
      normalRow.push(hit.normal);
    }
    points.push(pointRow);
    normals.push(normalRow);
  }
  return { points, normals };
}
