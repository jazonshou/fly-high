import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

/**
 * EVERY crossing of a ray with a mesh's triangles, not the nearest hit of each mesh.
 *
 * `scene.pickWithRay` and `multiPickWithRay` return ONE `PickingInfo` per mesh (the
 * nearest hit), so anything built on them that COUNTS crossings, or that needs
 * the FAR side of a shell (the last crossing, where a ray leaves the outer
 * skin of two overlapping closed lofts, as the 747's fuselage and radome are),
 * reads the wrong thing. These are the mesh's own world-space triangles and a
 * Moller-Trumbore test, double sided, so they can be asked for all of them.
 */

export interface Triangle {
  readonly a: Vector3;
  readonly b: Vector3;
  readonly c: Vector3;
}

export function worldTriangles(mesh: AbstractMesh): Triangle[] {
  mesh.computeWorldMatrix(true);
  const data = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
  const world = mesh.getWorldMatrix();
  const vertices: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    vertices.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  }
  const indices = mesh.getIndices() ?? [];
  const triangles: Triangle[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    triangles.push({ a: vertices[indices[i]!]!, b: vertices[indices[i + 1]!]!, c: vertices[indices[i + 2]!]! });
  }
  return triangles;
}

/** Distance along the unit vector `direction` from `origin` to the triangle (either side), or NaN. */
export function hitTriangle(origin: Vector3, direction: Vector3, triangle: Triangle): number {
  const e1 = triangle.b.subtract(triangle.a);
  const e2 = triangle.c.subtract(triangle.a);
  const p = Vector3.Cross(direction, e2);
  const determinant = Vector3.Dot(e1, p);
  if (Math.abs(determinant) < 1e-12) return Number.NaN;
  const inverse = 1 / determinant;
  const s = origin.subtract(triangle.a);
  const u = Vector3.Dot(s, p) * inverse;
  if (u < 0 || u > 1) return Number.NaN;
  const q = Vector3.Cross(s, e1);
  const v = Vector3.Dot(direction, q) * inverse;
  if (v < 0 || u + v > 1) return Number.NaN;
  const distance = Vector3.Dot(e2, q) * inverse;
  return distance > 1e-9 ? distance : Number.NaN;
}

/** Every crossing, nearest first; a ray through an edge or a vertex meets two triangles at one distance and is counted once. */
export function crossings(origin: Vector3, direction: Vector3, triangles: readonly Triangle[]): number[] {
  const hits: number[] = [];
  for (const triangle of triangles) {
    const distance = hitTriangle(origin, direction, triangle);
    if (Number.isFinite(distance)) hits.push(distance);
  }
  hits.sort((a, b) => a - b);
  return hits.filter((hit, index) => index === 0 || Math.abs(hit - hits[index - 1]!) > 1e-7);
}

/** The closest point of a triangle to `p` (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestPointOnTriangle(p: Vector3, { a, b, c }: Triangle): Vector3 {
  const ab = b.subtract(a);
  const ac = c.subtract(a);
  const ap = p.subtract(a);
  const d1 = Vector3.Dot(ab, ap);
  const d2 = Vector3.Dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = p.subtract(b);
  const d3 = Vector3.Dot(ab, bp);
  const d4 = Vector3.Dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return a.add(ab.scale(d1 / (d1 - d3)));
  const cp = p.subtract(c);
  const d5 = Vector3.Dot(ab, cp);
  const d6 = Vector3.Dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return a.add(ac.scale(d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return b.add(c.subtract(b).scale((d4 - d3) / (d4 - d3 + (d5 - d6))));
  }
  const denominator = 1 / (va + vb + vc);
  return a.add(ab.scale(vb * denominator)).add(ac.scale(vc * denominator));
}

/** Distance from `p` to the nearest point of any of `triangles`. */
export function distanceToTriangles(p: Vector3, triangles: readonly Triangle[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const triangle of triangles) best = Math.min(best, Vector3.Distance(p, closestPointOnTriangle(p, triangle)));
  return best;
}
