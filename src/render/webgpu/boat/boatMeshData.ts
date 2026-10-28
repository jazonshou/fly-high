import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";

/**
 * Plain geometry for the boat's meshes, built in Node and uploaded once.
 *
 * WINDING. `tri(a, b, c)` takes its corners COUNTER-CLOCKWISE seen from the
 * side the face shows, the right-hand rule a reader expects, and stores them
 * the other way round, which is what this right-handed scene's front faces
 * and `VertexData.ComputeNormals` want (the aircraft loft does the same with
 * `reverseTriangleWinding`). Normals then point out of the shown side.
 *
 * SMOOTHING. A `Surface` is one smoothing group: its normals are computed
 * from its own faces only and averaged where its triangles share vertices.
 * A chine or a strake edge is two surfaces meeting, so it stays a crisp line,
 * while each panel shades smoothly along the hull.
 */

export type Vec3Tuple = readonly [number, number, number];

export class Surface {
  readonly positions: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];
  /**
   * Normals the surface sets itself, one per vertex (a rounded edge's exact
   * normals, so it meets the flat panel beside it without a shading seam).
   * Null, as almost every surface leaves it, means computed from its faces.
   */
  normals: number[] | null = null;

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, u: number, v: number): number {
    this.positions.push(x, y, z);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  vertexAt(point: Vec3Tuple, uv: readonly [number, number]): number {
    return this.vertex(point[0], point[1], point[2], uv[0], uv[1]);
  }

  /** A vertex with its own normal: every vertex of such a surface must have one. */
  vertexWithNormal(point: Vec3Tuple, normal: Vec3Tuple, uv: readonly [number, number]): number {
    this.normals ??= [];
    this.normals.push(normal[0], normal[1], normal[2]);
    return this.vertexAt(point, uv);
  }

  /** Counter-clockwise from the shown side. */
  tri(a: number, b: number, c: number): void {
    this.indices.push(a, c, b);
  }

  /** A triangle shown towards `facing`, whichever way its corners were listed. */
  triFacing(a: number, b: number, c: number, facing: Vec3Tuple): void {
    const p = this.positions;
    const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
    const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (n[0]! * facing[0] + n[1]! * facing[1] + n[2]! * facing[2] >= 0) this.tri(a, b, c);
    else this.tri(a, c, b);
  }

  /** a, b, c, d counter-clockwise from the shown side. */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /**
   * A strip grid: `rows[i][j]` is station i, girth point j. Quads run
   * (i, j) -> (i+1, j) -> (i+1, j+1) -> (i, j+1), so the shown side is
   * (station direction) x (girth direction).
   */
  grid(rows: readonly (readonly Vec3Tuple[])[], uv: (i: number, j: number, point: Vec3Tuple) => readonly [number, number]): void {
    const base = this.vertexCount;
    const width = rows[0]!.length;
    for (const [i, row] of rows.entries()) {
      if (row.length !== width) throw new RangeError("A surface grid needs rows of one length");
      for (const [j, point] of row.entries()) this.vertexAt(point, uv(i, j, point));
    }
    for (let i = 0; i < rows.length - 1; i += 1) {
      for (let j = 0; j < width - 1; j += 1) {
        const a = base + i * width + j;
        this.quad(a, a + width, a + width + 1, a + 1);
      }
    }
  }

  /** A copy reflected through z = 0, its winding turned so it shows the mirrored side. */
  mirrored(): Surface {
    const copy = new Surface();
    for (let index = 0; index < this.positions.length; index += 3) {
      copy.positions.push(this.positions[index]!, this.positions[index + 1]!, -this.positions[index + 2]!);
    }
    copy.uvs.push(...this.uvs);
    if (this.normals) copy.normals = this.normals.map((value, index) => (index % 3 === 2 ? -value : value));
    for (let index = 0; index < this.indices.length; index += 3) {
      copy.indices.push(this.indices[index]!, this.indices[index + 2]!, this.indices[index + 1]!);
    }
    return copy;
  }

  /** Flip which side is shown. */
  flipped(): Surface {
    const copy = new Surface();
    copy.positions.push(...this.positions);
    copy.uvs.push(...this.uvs);
    if (this.normals) copy.normals = this.normals.map((value) => -value);
    for (let index = 0; index < this.indices.length; index += 3) {
      copy.indices.push(this.indices[index]!, this.indices[index + 2]!, this.indices[index + 1]!);
    }
    return copy;
  }
}

/** Positions, normals, UVs and indices of one mesh, in its node's frame. */
export class BoatMeshData {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /**
   * Add one smoothing group, translated by `-origin` (hull frame in, the
   * node's frame out). Normals are computed before the move.
   */
  add(surface: Surface, origin: Vec3Tuple = [0, 0, 0]): void {
    if (surface.indices.length === 0) return;
    let normals: number[] = [];
    if (surface.normals && surface.normals.length === surface.positions.length) normals = surface.normals;
    else VertexData.ComputeNormals(surface.positions, surface.indices, normals);
    const base = this.vertexCount;
    for (let index = 0; index < surface.positions.length; index += 3) {
      this.positions.push(
        surface.positions[index]! - origin[0],
        surface.positions[index + 1]! - origin[1],
        surface.positions[index + 2]! - origin[2],
      );
    }
    this.normals.push(...normals);
    this.uvs.push(...surface.uvs);
    for (const index of surface.indices) this.indices.push(base + index);
  }

  /** Add a surface and its mirror image. */
  addSymmetric(surface: Surface, origin: Vec3Tuple = [0, 0, 0]): void {
    this.add(surface, origin);
    this.add(surface.mirrored(), origin);
  }

  toVertexData(): VertexData {
    const data = new VertexData();
    data.positions = this.positions;
    data.normals = this.normals;
    data.uvs = this.uvs;
    data.indices = this.indices;
    return data;
  }
}

/**
 * Ear-clip a simple polygon given counter-clockwise in its own (a, b) plane,
 * returning triangles as index triples into `points`, counter-clockwise too.
 * Consecutive duplicate points are dropped first. Small (tens of points), so
 * the O(n^3) worst case does not matter.
 */
export function earClip(points: readonly (readonly [number, number])[]): number[] {
  const order: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = order.length > 0 ? points[order[order.length - 1]!]! : null;
    const point = points[index]!;
    if (previous && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1e-7) continue;
    order.push(index);
  }
  if (order.length > 2) {
    const first = points[order[0]!]!;
    const last = points[order[order.length - 1]!]!;
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-7) order.pop();
  }
  const cross = (o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): boolean =>
    cross(a, b, p) > 1e-12 && cross(b, c, p) > 1e-12 && cross(c, a, p) > 1e-12;
  const triangles: number[] = [];
  const remaining = [...order];
  let guard = remaining.length * remaining.length + 8;
  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const ia = remaining[(index + remaining.length - 1) % remaining.length]!;
      const ib = remaining[index]!;
      const ic = remaining[(index + 1) % remaining.length]!;
      const a = points[ia]!;
      const b = points[ib]!;
      const c = points[ic]!;
      const turn = cross(a, b, c);
      if (turn <= 1e-12) {
        // Collinear: drop the middle point, it adds no area.
        if (Math.abs(turn) <= 1e-12) {
          remaining.splice(index, 1);
          clipped = true;
          break;
        }
        continue;
      }
      let blocked = false;
      for (const other of remaining) {
        if (other === ia || other === ib || other === ic) continue;
        if (inside(points[other]!, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      triangles.push(ia, ib, ic);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) {
    const [ia, ib, ic] = remaining as [number, number, number];
    if (cross(points[ia]!, points[ib]!, points[ic]!) > 1e-12) triangles.push(ia, ib, ic);
  }
  return triangles;
}

/**
 * A flat polygon mapped to 3D by `place`. It shows the side from which
 * `outline` runs counter-clockwise: in (a, b) terms, a counter-clockwise
 * outline shows (a axis) x (b axis) and a clockwise one the opposite side.
 */
export function polygonSurface(
  outline: readonly (readonly [number, number])[],
  place: (a: number, b: number) => Vec3Tuple,
  uv: (point: Vec3Tuple) => readonly [number, number],
): Surface {
  // A clockwise outline shows the other side: clip it reversed, wind it back.
  let area = 0;
  for (let index = 0; index < outline.length; index += 1) {
    const [a0, b0] = outline[index]!;
    const [a1, b1] = outline[(index + 1) % outline.length]!;
    area += a0 * b1 - a1 * b0;
  }
  const clockwise = area < 0;
  const ordered = clockwise ? [...outline].reverse() : outline;
  const surface = new Surface();
  const indices = earClip(ordered);
  const vertices = ordered.map(([a, b]) => {
    const point = place(a, b);
    return surface.vertexAt(point, uv(point));
  });
  for (let index = 0; index < indices.length; index += 3) {
    const a = vertices[indices[index]!]!;
    const b = vertices[indices[index + 1]!]!;
    const c = vertices[indices[index + 2]!]!;
    if (clockwise) surface.tri(a, c, b);
    else surface.tri(a, b, c);
  }
  return surface;
}
