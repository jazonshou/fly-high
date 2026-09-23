import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

/**
 * A double-precision CPU z-buffer over DRAWN faces, for asking what a camera
 * actually sees of the built airframe without a GPU.
 *
 * WHY NOT `scene.pickWithRay`: on this Babylon (9.21) under a NullEngine, a
 * unit box picked from above AND from below both returned the box CENTRE's
 * distance, with no picked point, so a pick-based census is silently wrong.
 * And a pick sees back faces, which the GPU culls
 * (`render.cockpit-drawn-faces`). This draws what the GPU draws: a triangle
 * counts only when the eye is on its outside, by the convention every builder
 * here winds to (measured on a Babylon box): cross(b - a, c - a) points INTO
 * the solid, flipped by a mirrored world matrix.
 *
 * Coverage is the pixel centre's barycentric test; depth is the view-axis
 * distance, interpolated as 1/z. Pixels are (x, y) with y DOWN, as a frame's.
 */
export interface Pinhole {
  readonly eye: Vector3;
  readonly target: Vector3;
  readonly up: Vector3;
  /** Vertical field of view, radians. */
  readonly fovY: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface Basis {
  readonly forward: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
  /** Pixels per unit of tangent. */
  readonly focal: number;
}

function basis(camera: Pinhole): Basis {
  const forward = camera.target.subtract(camera.eye).normalize();
  const right = Vector3.Cross(forward, camera.up).normalize();
  const up = Vector3.Cross(right, forward).normalize();
  return { forward, right, up, focal: (camera.height / 2) / Math.tan(camera.fovY / 2) };
}

/** A world point's pixel position (y down) and view depth. */
export function projectPoint(camera: Pinhole, point: Vector3): { x: number; y: number; depth: number } {
  const b = basis(camera);
  return projectWith(camera, b, point);
}

function projectWith(camera: Pinhole, b: Basis, point: Vector3) {
  const d = point.subtract(camera.eye);
  const depth = Vector3.Dot(d, b.forward);
  return {
    x: camera.width / 2 + (b.focal * Vector3.Dot(d, b.right)) / depth,
    y: camera.height / 2 - (b.focal * Vector3.Dot(d, b.up)) / depth,
    depth,
  };
}

/** Every vertex of `meshes`, in world space. */
export function worldVertices(mesh: AbstractMesh): Vector3[] {
  mesh.computeWorldMatrix(true);
  const matrix = mesh.getWorldMatrix();
  const positions = mesh.getVerticesData("position") ?? [];
  const out: Vector3[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(positions[i]!, positions[i + 1]!, positions[i + 2]!), matrix));
  }
  return out;
}

/** The pixel rectangle `points` project into, padded. */
export function boundingRect(camera: Pinhole, points: readonly Vector3[], pad = 3): PixelRect {
  const b = basis(camera);
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const point of points) {
    const p = projectWith(camera, b, point);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return {
    x0: Math.max(0, Math.floor(x0) - pad),
    y0: Math.max(0, Math.floor(y0) - pad),
    x1: Math.min(camera.width - 1, Math.ceil(x1) + pad),
    y1: Math.min(camera.height - 1, Math.ceil(y1) + pad),
  };
}

export interface RasterResult {
  readonly rect: PixelRect;
  readonly width: number;
  /** Index into `meshes` of the nearest drawn face per pixel, -1 for none. */
  readonly mesh: Int32Array;
  readonly depth: Float64Array;
  /** The world point a pixel's centre ray meets its nearest drawn face at. */
  point(index: number): Vector3;
  /**
   * Every pixel index whose nearest drawn face belongs to `mesh`. With
   * `broadOnly`, only faces lying across the mesh's own local y -- a plate's
   * top and bottom, not its rim -- which is what a plate's plane is fitted to:
   * near edge-on, a 35-60 mm rim is a large share of what a camera sees of a
   * panel, and a fit through rim and face together reads a plane that is
   * neither (2-3 degrees off, stable at five times the resolution).
   */
  pixelsOf(mesh: AbstractMesh, broadOnly?: boolean): number[];
}

/** A face counts as BROAD when its local normal is within about 37 degrees of the mesh's local y. */
const BROAD_FACE_LOCAL_Y = 0.8;

export function rasterise(camera: Pinhole, meshes: readonly AbstractMesh[], rect: PixelRect): RasterResult {
  const b = basis(camera);
  const width = rect.x1 - rect.x0 + 1;
  const height = rect.y1 - rect.y0 + 1;
  const depth = new Float64Array(width * height).fill(Infinity);
  const nearest = new Int32Array(width * height).fill(-1);
  const broad = new Uint8Array(width * height);
  meshes.forEach((mesh, meshIndex) => {
    const indices = mesh.getIndices();
    if (!indices) return;
    const local = mesh.getVerticesData("position") ?? [];
    const world = worldVertices(mesh);
    const mirrored = mesh.getWorldMatrix().determinant() < 0;
    for (let t = 0; t < indices.length; t += 3) {
      const A = world[indices[t]!]!; const B = world[indices[t + 1]!]!; const C = world[indices[t + 2]!]!;
      const into = Vector3.Cross(B.subtract(A), C.subtract(A));
      if ((mirrored ? -1 : 1) * Vector3.Dot(into, A.subtract(camera.eye)) <= 0) continue;
      const a = projectWith(camera, b, A); const bb = projectWith(camera, b, B); const c = projectWith(camera, b, C);
      if (a.depth <= 0.05 || bb.depth <= 0.05 || c.depth <= 0.05) continue;
      const minX = Math.max(rect.x0, Math.floor(Math.min(a.x, bb.x, c.x)));
      const maxX = Math.min(rect.x1, Math.ceil(Math.max(a.x, bb.x, c.x)));
      const minY = Math.max(rect.y0, Math.floor(Math.min(a.y, bb.y, c.y)));
      const maxY = Math.min(rect.y1, Math.ceil(Math.max(a.y, bb.y, c.y)));
      if (minX > maxX || minY > maxY) continue;
      const area = (bb.x - a.x) * (c.y - a.y) - (c.x - a.x) * (bb.y - a.y);
      if (area === 0) continue;
      const corner = (i: number) => new Vector3(local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!);
      const localA = corner(indices[t]!);
      const localNormal = Vector3.Cross(corner(indices[t + 1]!).subtract(localA), corner(indices[t + 2]!).subtract(localA));
      const isBroad = Math.abs(localNormal.y) >= BROAD_FACE_LOCAL_Y * localNormal.length() ? 1 : 0;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5; const py = y + 0.5;
          const w0 = ((bb.x - px) * (c.y - py) - (c.x - px) * (bb.y - py)) / area;
          const w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = 1 / (w0 / a.depth + w1 / bb.depth + w2 / c.depth);
          const k = (y - rect.y0) * width + (x - rect.x0);
          if (z < depth[k]!) { depth[k] = z; nearest[k] = meshIndex; broad[k] = isBroad; }
        }
      }
    }
  });
  return {
    rect,
    width,
    mesh: nearest,
    depth,
    point(index: number): Vector3 {
      const x = rect.x0 + (index % width) + 0.5;
      const y = rect.y0 + Math.floor(index / width) + 0.5;
      const ray = b.forward
        .add(b.right.scale((x - camera.width / 2) / b.focal))
        .add(b.up.scale(-(y - camera.height / 2) / b.focal));
      return camera.eye.add(ray.scale(depth[index]!));
    },
    pixelsOf(mesh: AbstractMesh, broadOnly = false): number[] {
      const wanted = meshes.indexOf(mesh);
      const out: number[] = [];
      if (wanted < 0) return out;
      nearest.forEach((value, index) => {
        if (value === wanted && (!broadOnly || broad[index] === 1)) out.push(index);
      });
      return out;
    },
  };
}

/**
 * The least-squares plane through `points`, as its unit normal (sign
 * arbitrary): the smallest-eigenvalue eigenvector of their covariance, by
 * Jacobi rotation, so a plane at any attitude fits the same way.
 */
export function planeNormal(points: readonly Vector3[]): Vector3 {
  if (points.length < 3) throw new RangeError(`A plane needs three points; got ${points.length}`);
  const mean = points.reduce((sum, p) => sum.add(p), Vector3.Zero()).scale(1 / points.length);
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = [p.x - mean.x, p.y - mean.y, p.z - mean.z];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) m[i]![j]! += d[i]! * d[j]!;
  }
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(m[p]![q]!) < 1e-18) continue;
      const theta = (m[q]![q]! - m[p]![p]!) / (2 * m[p]![q]!);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1); const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const mkp = m[k]![p]!; const mkq = m[k]![q]!;
        m[k]![p] = c * mkp - s * mkq; m[k]![q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < 3; k += 1) {
        const mpk = m[p]![k]!; const mqk = m[q]![k]!;
        m[p]![k] = c * mpk - s * mqk; m[q]![k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k]![p]!; const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq; v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  const smallest = [0, 1, 2].reduce((best, i) => (m[i]![i]! < m[best]![best]! ? i : best), 0);
  return new Vector3(v[0]![smallest]!, v[1]![smallest]!, v[2]![smallest]!).normalize();
}

/** The angle between two planes' normals, in degrees, 0..90. */
export function planeAngleDegrees(a: Vector3, b: Vector3): number {
  return (Math.acos(Math.min(1, Math.abs(Vector3.Dot(a, b)))) * 180) / Math.PI;
}
