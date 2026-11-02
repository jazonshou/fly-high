/**
 * The figure's parts while it is baked: the skin, each garment, the hair and
 * the eyes, each a polygon mesh with per-corner UVs (into the one atlas) and
 * four walker bone weights per vertex. `exportParts` welds them into one
 * indexed triangle mesh, split where the UVs are.
 */
import { add, cross, normalize, sub, type V3 } from "./math.mts";

export type PartKind = "skin" | "jacket" | "trousers" | "boots" | "hair" | "eyes";

export interface Part {
  readonly name: string;
  readonly kind: PartKind;
  positions: number[];
  bones: number[];
  weights: number[];
  faces: number[][];
  /** Two numbers per face corner, matching `faces`. */
  faceUvs: number[][];
}

export const vertexOf = (positions: ArrayLike<number>, v: number): V3 => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];

/** Area-weighted vertex normals over polygon faces. */
export function vertexNormals(positions: ArrayLike<number>, faces: readonly (readonly number[])[], count = positions.length / 3): Float64Array {
  const normals = new Float64Array(count * 3);
  for (const face of faces) {
    // A polygon's area vector: the sum of its fan's cross products.
    let n: V3 = [0, 0, 0];
    const p0 = vertexOf(positions, face[0]!);
    for (let k = 1; k + 1 < face.length; k += 1) n = add(n, cross(sub(vertexOf(positions, face[k]!), p0), sub(vertexOf(positions, face[k + 1]!), p0)));
    for (const v of face) {
      normals[v * 3]! += n[0];
      normals[v * 3 + 1]! += n[1];
      normals[v * 3 + 2]! += n[2];
    }
  }
  for (let v = 0; v < count; v += 1) {
    const u = normalize([normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!]);
    normals[v * 3] = u[0];
    normals[v * 3 + 1] = u[1];
    normals[v * 3 + 2] = u[2];
  }
  return normals;
}

export function adjacency(faces: readonly (readonly number[])[], count: number): number[][] {
  const sets: Set<number>[] = Array.from({ length: count }, () => new Set());
  for (const face of faces) {
    for (let k = 0; k < face.length; k += 1) {
      const a = face[k]!;
      const b = face[(k + 1) % face.length]!;
      sets[a]!.add(b);
      sets[b]!.add(a);
    }
  }
  return sets.map((s) => [...s]);
}

/** The faces' open edges chained into loops, each as vertices in order (the faces' winding). */
export function boundaryLoops(faces: readonly (readonly number[])[]): number[][] {
  const count = new Map<string, number>();
  const next = new Map<number, number>();
  for (const face of faces) {
    for (let k = 0; k < face.length; k += 1) {
      const a = face[k]!;
      const b = face[(k + 1) % face.length]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  for (const face of faces) {
    for (let k = 0; k < face.length; k += 1) {
      const a = face[k]!;
      const b = face[(k + 1) % face.length]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (count.get(key) === 1) next.set(a, b);
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

export interface ExportedMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly bones: Uint8Array;
  readonly weights: Float32Array;
  /** Per vertex, the index of its part in the list passed. */
  readonly partOf: Uint8Array;
  /** Per triangle, its part. */
  readonly trianglePart: Uint8Array;
}

/**
 * Welds the parts into one triangle mesh: a vertex per (part vertex, UV)
 * pair, quads split along their shorter diagonal, normals smooth across UV
 * seams within a part.
 */
export function exportParts(parts: readonly Part[]): ExportedMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const bones: number[] = [];
  const weights: number[] = [];
  const partOf: number[] = [];
  const indices: number[] = [];
  const trianglePart: number[] = [];
  parts.forEach((part, partIndex) => {
    const n = vertexNormals(part.positions, part.faces);
    const keyed = new Map<string, number>();
    const corner = (v: number, u: number, w: number): number => {
      const key = `${v}:${u.toFixed(6)}:${w.toFixed(6)}`;
      let index = keyed.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        keyed.set(key, index);
        positions.push(part.positions[v * 3]!, part.positions[v * 3 + 1]!, part.positions[v * 3 + 2]!);
        normals.push(n[v * 3]!, n[v * 3 + 1]!, n[v * 3 + 2]!);
        uvs.push(u, w);
        for (let k = 0; k < 4; k += 1) {
          bones.push(part.bones[v * 4 + k]!);
          weights.push(part.weights[v * 4 + k]!);
        }
        partOf.push(partIndex);
      }
      return index;
    };
    part.faces.forEach((face, f) => {
      const uv = part.faceUvs[f]!;
      const ids = face.map((v, k) => corner(v, uv[k * 2]!, uv[k * 2 + 1]!));
      if (ids.length === 4) {
        const d02 = Math.hypot(...sub(vertexOf(part.positions, face[0]!), vertexOf(part.positions, face[2]!)));
        const d13 = Math.hypot(...sub(vertexOf(part.positions, face[1]!), vertexOf(part.positions, face[3]!)));
        if (d02 <= d13) indices.push(ids[0]!, ids[1]!, ids[2]!, ids[0]!, ids[2]!, ids[3]!);
        else indices.push(ids[0]!, ids[1]!, ids[3]!, ids[1]!, ids[2]!, ids[3]!);
        trianglePart.push(partIndex, partIndex);
      } else {
        for (let k = 1; k + 1 < ids.length; k += 1) {
          indices.push(ids[0]!, ids[k]!, ids[k + 1]!);
          trianglePart.push(partIndex);
        }
      }
    });
  });
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    bones: Uint8Array.from(bones),
    weights: Float32Array.from(weights),
    partOf: Uint8Array.from(partOf),
    trianglePart: Uint8Array.from(trianglePart),
  };
}
