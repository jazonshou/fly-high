/**
 * Ambient occlusion, ray-traced against the whole figure: the share of a
 * cosine-weighted hemisphere of rays that leave within `reach` without
 * hitting it. The armpits, the gaps between fingers, the ear's folds, under
 * the collar and the jacket's hem come out darker.
 */
type V3 = [number, number, number];

/** How open the surface is at a point (0 shut in, 1 open sky), given its normal and a seed that turns the ray pattern. */
export type OcclusionTracer = (origin: V3, normal: V3, seed: number) => number;

/**
 * A bounding-volume tree over the triangles (median splits, up to 4 per
 * leaf), flattened into typed arrays, and an any-hit ray query within `reach`.
 */
export function occlusionTracer(positions: Float32Array, indices: Uint32Array, rays = 64, reach = 0.18): OcclusionTracer {
  const triCount = indices.length / 3;
  const order = Int32Array.from({ length: triCount }, (_, i) => i);
  const centroid = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t += 1)
    for (let a = 0; a < 3; a += 1) centroid[t * 3 + a] = (positions[indices[t * 3]! * 3 + a]! + positions[indices[t * 3 + 1]! * 3 + a]! + positions[indices[t * 3 + 2]! * 3 + a]!) / 3;
  const maxNodes = triCount * 2;
  const bounds = new Float32Array(maxNodes * 6);
  // Per node: the left child (-1 for a leaf), the right child, and its first triangle and count.
  const links = new Int32Array(maxNodes * 4);
  let nodeCount = 0;
  const build = (start: number, count: number): number => {
    const node = nodeCount++;
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i += 1) {
      const t = order[i]!;
      for (let k = 0; k < 3; k += 1) {
        const v = indices[t * 3 + k]! * 3;
        for (let a = 0; a < 3; a += 1) {
          lo[a] = Math.min(lo[a]!, positions[v + a]!);
          hi[a] = Math.max(hi[a]!, positions[v + a]!);
        }
      }
    }
    bounds.set([...lo, ...hi], node * 6);
    if (count <= 4) {
      links.set([-1, -1, start, count], node * 4);
      return node;
    }
    const spans = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = spans[0]! >= spans[1]! && spans[0]! >= spans[2]! ? 0 : spans[1]! >= spans[2]! ? 1 : 2;
    const slice = Array.from(order.subarray(start, start + count)).sort((p, q) => centroid[p * 3 + axis]! - centroid[q * 3 + axis]!);
    order.set(slice, start);
    const half = count >> 1;
    const left = build(start, half);
    const right = build(start + half, count - half);
    links.set([left, right, start, count], node * 4);
    return node;
  };
  build(0, triCount);
  // The triangles' corners in leaf order: a, then b - a and c - a.
  const tris = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount; i += 1) {
    const t = order[i]!;
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    for (let k = 0; k < 3; k += 1) {
      tris[i * 9 + k] = positions[a + k]!;
      tris[i * 9 + 3 + k] = positions[b + k]! - positions[a + k]!;
      tris[i * 9 + 6 + k] = positions[c + k]! - positions[a + k]!;
    }
  }

  const stack = new Int32Array(128);
  const hit = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean => {
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top]!;
      const b = node * 6;
      let ta = (bounds[b]! - ox) * ix;
      let tb = (bounds[b + 3]! - ox) * ix;
      let near = Math.min(ta, tb);
      let far = Math.max(ta, tb);
      ta = (bounds[b + 1]! - oy) * iy;
      tb = (bounds[b + 4]! - oy) * iy;
      near = Math.max(near, Math.min(ta, tb));
      far = Math.min(far, Math.max(ta, tb));
      ta = (bounds[b + 2]! - oz) * iz;
      tb = (bounds[b + 5]! - oz) * iz;
      near = Math.max(near, Math.min(ta, tb), 0);
      far = Math.min(far, Math.max(ta, tb), reach);
      if (near > far) continue;
      const l = node * 4;
      const left = links[l]!;
      if (left >= 0) {
        stack[top++] = left;
        stack[top++] = links[l + 1]!;
        continue;
      }
      const end = links[l + 2]! + links[l + 3]!;
      for (let i = links[l + 2]!; i < end; i += 1) {
        const o = i * 9;
        const e1x = tris[o + 3]!;
        const e1y = tris[o + 4]!;
        const e1z = tris[o + 5]!;
        const e2x = tris[o + 6]!;
        const e2y = tris[o + 7]!;
        const e2z = tris[o + 8]!;
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const tx = ox - tris[o]!;
        const ty = oy - tris[o + 1]!;
        const tz = oz - tris[o + 2]!;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-5 && t < reach) return true;
      }
    }
    return false;
  };

  // A fixed set of cosine-weighted directions about +Z (a Fibonacci spiral), turned onto each normal.
  const dirs: V3[] = [];
  for (let i = 0; i < rays; i += 1) {
    const r = Math.sqrt((i + 0.5) / rays);
    const phi = i * 2.399963229728653;
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - r * r))]);
  }
  return (origin, n, seed) => {
    const ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t = normalize(cross(ref, n));
    const b = cross(n, t);
    // A twist of the spiral per point, so neighbours' noise does not line up.
    const twist = ((seed * 0.618034) % 1) * Math.PI * 2;
    const c = Math.cos(twist);
    const s = Math.sin(twist);
    const ox = origin[0] + n[0] * 0.0006;
    const oy = origin[1] + n[1] * 0.0006;
    const oz = origin[2] + n[2] * 0.0006;
    let open = 0;
    for (const [x0, y0, z] of dirs) {
      const x = x0 * c - y0 * s;
      const y = x0 * s + y0 * c;
      if (!hit(ox, oy, oz, t[0] * x + b[0] * y + n[0] * z, t[1] * x + b[1] * y + n[1] * z, t[2] * x + b[2] * y + n[2] * z)) open += 1;
    }
    return open / rays;
  };
}

/** Per vertex. */
export function vertexOcclusion(positions: Float32Array, normals: Float32Array, indices: Uint32Array, rays = 64, reach = 0.18): Float32Array {
  const trace = occlusionTracer(positions, indices, rays, reach);
  const count = positions.length / 3;
  const out = new Float32Array(count);
  for (let v = 0; v < count; v += 1) out[v] = trace([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!], [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!], v);
  return out;
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
