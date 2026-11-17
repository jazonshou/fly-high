/**
 * The walker's boots: brown leather ankle boots on a rubber sole.
 *
 * Each boot is the foot and ankle grown outward by the leather's thickness
 * and the padding (an offset surface, so it fits the foot without following
 * the gaps between the toes), set on a sole slab the shape of its footprint,
 * cut off over the ankle bone. The surface is found on a voxel grid (the
 * distance to the foot's skin; marching tetrahedra), smoothed and simplified.
 *
 * The foot is squashed down under the ankle first, by the sole's thickness,
 * so the boot's sole stands on y = 0 with the ankle where the skeleton keeps
 * it (the foot inside is never seen).
 *
 * UVs: six planar charts per boot (sides, top, bottom, toe, heel), packed
 * into the corner of the atlas where MakeHuman lays out the feet, which the
 * boots hide.
 */
import { MeshoptSimplifier } from "meshoptimizer";
import { BIND_POSITIONS, SIDES } from "../../src/render/webgpu/person/skeleton";
import type { FittedBody } from "./body.mts";
import { adjacency, type Part } from "./parts.mts";
import type { UvRect } from "./swatches.mts";

export const BOOT = Object.freeze({
  /** The rubber sole's thickness under the foot, metres. */
  sole: 0.024,
  /** The upper's thickness over the skin (leather, lining, padding). */
  upper: 0.0075,
  /** The shaft's top. */
  top: 0.16,
  /** How far the sole stands out past the upper (the welt). */
  welt: 0.004,
  voxel: 0.0025,
});

/** Where the boots' charts go: MakeHuman's feet islands, which nothing else uses once the boots are on. */
export const BOOT_RECTS: readonly UvRect[] = Object.freeze([
  { u0: 0.01, v0: 0.006, u1: 0.185, v1: 0.13 },
  { u0: 0.19, v0: 0.006, u1: 0.365, v1: 0.13 },
]);

type V3 = [number, number, number];

export function buildBoots(body: FittedBody): { part: Part; report: string[] } {
  const part: Part = { name: "boots", kind: "boots", positions: [], bones: [], weights: [], faces: [], faceUvs: [] };
  const report: string[] = [];
  SIDES.forEach((side, s) => {
    const boot = buildBoot(body, side.sign, side.foot, BOOT_RECTS[s]!);
    const base = part.positions.length / 3;
    part.positions.push(...boot.positions);
    part.bones.push(...boot.bones);
    part.weights.push(...boot.weights);
    for (const f of boot.faces) part.faces.push(f.map((v) => v + base));
    part.faceUvs.push(...boot.faceUvs);
    report.push(`boot ${side.sign < 0 ? "L" : "R"}: ${boot.faces.length} triangles, ${boot.positions.length / 3} vertices`);
  });
  return { part, report };
}

interface Boot {
  positions: number[];
  bones: number[];
  weights: number[];
  faces: number[][];
  faceUvs: number[][];
}

function buildBoot(body: FittedBody, sign: number, footBone: number, rect: UvRect): Boot {
  const ankle = BIND_POSITIONS[footBone * 3 + 1]!;
  const P = body.positions;
  // The skin round the foot and ankle on this side, squashed under the ankle.
  const squash = (y: number) => (y < ankle ? BOOT.sole + (y * (ankle - BOOT.sole)) / ankle : y);
  const triangles: number[] = [];
  const used = new Set<number>();
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    if (!f.vertices.every((v) => P[v * 3 + 1]! < BOOT.top + 0.06 && P[v * 3 + 2]! * sign > 0.01)) continue;
    for (let k = 1; k + 1 < f.vertices.length; k += 1) triangles.push(f.vertices[0]!, f.vertices[k]!, f.vertices[k + 1]!);
    for (const v of f.vertices) used.add(v);
  }
  const skin = new Float64Array(P.length);
  for (const v of used) {
    skin[v * 3] = P[v * 3]!;
    skin[v * 3 + 1] = squash(P[v * 3 + 1]!);
    skin[v * 3 + 2] = P[v * 3 + 2]!;
  }

  // The grid.
  const h = BOOT.voxel;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of used) {
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a]!, skin[v * 3 + a]!);
      hi[a] = Math.max(hi[a]!, skin[v * 3 + a]!);
    }
  }
  lo[0] -= 0.02;
  lo[2] -= 0.02;
  hi[0] += 0.02;
  hi[2] += 0.02;
  lo[1] = -2 * h;
  hi[1] = BOOT.top + 2 * h;
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1;
  const ny = Math.ceil((hi[1] - lo[1]) / h) + 1;
  const nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const point = (i: number, j: number, k: number): V3 => [lo[0] + i * h, lo[1] + j * h, lo[2] + k * h];

  // Unsigned distance to the skin within a band, from a hash of the triangles.
  const BAND = BOOT.upper + 0.008;
  const cell = 0.01;
  const hash = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let t = 0; t < triangles.length; t += 3) {
    const tri = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
    const tlo = [0, 1, 2].map((a) => Math.min(...tri.map((v) => skin[v * 3 + a]!)) - BAND);
    const thi = [0, 1, 2].map((a) => Math.max(...tri.map((v) => skin[v * 3 + a]!)) + BAND);
    for (let x = Math.floor(tlo[0]! / cell); x <= Math.floor(thi[0]! / cell); x += 1)
      for (let y = Math.floor(tlo[1]! / cell); y <= Math.floor(thi[1]! / cell); y += 1)
        for (let z = Math.floor(tlo[2]! / cell); z <= Math.floor(thi[2]! / cell); z += 1) {
          const k = `${x},${y},${z}`;
          let list = hash.get(k);
          if (!list) hash.set(k, (list = []));
          list.push(t);
        }
  }
  const distance = new Float32Array(nx * ny * nz).fill(BAND);
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1)
      for (let i = 0; i < nx; i += 1) {
        const q = point(i, j, k);
        const list = hash.get(key(q[0], q[1], q[2]));
        if (!list) continue;
        let best = BAND;
        for (const t of list) {
          const d = pointTriangle(q, skin, triangles[t]!, triangles[t + 1]!, triangles[t + 2]!);
          if (d < best) best = d;
        }
        distance[at(i, j, k)] = best;
      }

  // Inside the foot: what the outside cannot reach without crossing the grown skin.
  const solid = (n: number) => distance[n]! < BOOT.upper;
  const outside = new Uint8Array(nx * ny * nz);
  const queue: number[] = [];
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1)
      for (let i = 0; i < nx; i += 1) {
        if (i > 0 && j > 0 && k > 0 && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
        const n = at(i, j, k);
        if (!solid(n) && !outside[n]) {
          outside[n] = 1;
          queue.push(n);
        }
      }
  while (queue.length) {
    const n = queue.pop()!;
    const i = n % nx;
    const j = Math.floor(n / nx) % ny;
    const k = Math.floor(n / (nx * ny));
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const a = i + di;
      const b = j + dj;
      const c = k + dk;
      if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
      const m = at(a, b, c);
      if (outside[m] || solid(m)) continue;
      outside[m] = 1;
      queue.push(m);
    }
  }

  // The footprint: columns the grown foot fills low down, as a 2-D distance (positive inside), grown by the welt.
  const column = new Uint8Array(nx * nz);
  for (let k = 0; k < nz; k += 1)
    for (let i = 0; i < nx; i += 1)
      for (let j = 0; j < ny && point(0, j, 0)[1] < BOOT.sole + 0.03; j += 1) {
        const n = at(i, j, k);
        if (solid(n) || !outside[n]) column[k * nx + i] = 1;
      }
  const footprint = new Float32Array(nx * nz);
  const R = 8;
  for (let k = 0; k < nz; k += 1)
    for (let i = 0; i < nx; i += 1) {
      const inside = column[k * nx + i] === 1;
      let best = R * h;
      for (let dk = -R; dk <= R; dk += 1)
        for (let di = -R; di <= R; di += 1) {
          const a = i + di;
          const c = k + dk;
          const other = a < 0 || c < 0 || a >= nx || c >= nz ? 0 : column[c * nx + a]!;
          if ((other === 1) !== inside) best = Math.min(best, Math.hypot(di, dk) * h);
        }
      footprint[k * nx + i] = (inside ? best : -best) + BOOT.welt;
    }

  // Smooth the footprint's edge (the columns are a staircase).
  for (let pass = 0; pass < 3; pass += 1) {
    const copy = Float32Array.from(footprint);
    for (let k = 1; k + 1 < nz; k += 1)
      for (let i = 1; i + 1 < nx; i += 1) {
        let sum = 0;
        for (let dk = -1; dk <= 1; dk += 1) for (let di = -1; di <= 1; di += 1) sum += copy[(k + dk) * nx + i + di]!;
        footprint[k * nx + i] = sum / 9;
      }
  }
  // The toe box: room in front of and over the toes.
  let toeX = -Infinity;
  for (const v of used) if (skin[v * 3 + 1]! < 0.06) toeX = Math.max(toeX, skin[v * 3]!);
  const toeRoom = (x: number) => 0.006 * Math.min(1, Math.max(0, (x - (toeX - 0.07)) / 0.07));
  // The field, positive inside the boot.
  const field = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1)
      for (let i = 0; i < nx; i += 1) {
        const n = at(i, j, k);
        const y = point(i, j, k)[1];
        const x = point(i, j, k)[0];
        const room = toeRoom(x);
        const upper = outside[n] ? BOOT.upper + room - distance[n]! : BOOT.upper + room;
        // The sole: thickest under the heel, thinner under the ball, its edge standing out by the welt.
        const soleTop = BOOT.sole - 0.007 * Math.min(1, Math.max(0, (x - (toeX - 0.13)) / 0.08));
        const slab = Math.min(y, soleTop - y, footprint[k * nx + i]! + room * 0.6);
        field[n] = Math.min(Math.max(upper, slab), BOOT.top - y, y + 0.0004);
      }
  // Round it off: two box blurs, so the leather reads smooth and the edges soft.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      const copy = Float32Array.from(field);
      for (let k = 1; k + 1 < nz; k += 1)
        for (let j = 1; j + 1 < ny; j += 1)
          for (let i = 1; i + 1 < nx; i += 1) {
            const n = at(i, j, k);
            field[n] = (copy[at(i - di, j - dj, k - dk)]! + copy[n]! + copy[at(i + di, j + dj, k + dk)]!) / 3;
          }
    }
  }
  // Nothing below the ground (the blur softened the sole's underside).
  for (let k = 0; k < nz; k += 1) for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    const n = at(i, j, k);
    const y = point(i, j, k)[1];
    if (y <= 0) field[n] = Math.min(field[n]!, y + 0.0004);
  }

  // Marching tetrahedra: six per cube, vertices on the cube's edges shared by key.
  const positions: number[] = [];
  const edgeVertex = new Map<number, number>();
  const total = nx * ny * nz;
  const vertexOn = (a: number, b: number): number => {
    const k = a < b ? a * total + b : b * total + a;
    let index = edgeVertex.get(k);
    if (index === undefined) {
      const fa = field[a]!;
      const fb = field[b]!;
      const t = fa / (fa - fb);
      const pa = point(a % nx, Math.floor(a / nx) % ny, Math.floor(a / (nx * ny)));
      const pb = point(b % nx, Math.floor(b / nx) % ny, Math.floor(b / (nx * ny)));
      index = positions.length / 3;
      positions.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
      edgeVertex.set(k, index);
    }
    return index;
  };
  const tris: number[] = [];
  const TETS = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
  ];
  const corner = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  for (let k = 0; k + 1 < nz; k += 1)
    for (let j = 0; j + 1 < ny; j += 1)
      for (let i = 0; i + 1 < nx; i += 1) {
        const ids = corner.map(([a, b, c]) => at(i + a!, j + b!, k + c!));
        let any = false;
        let all = true;
        for (const n of ids) {
          if (field[n]! > 0) any = true;
          else all = false;
        }
        if (!any || all) continue;
        for (const tet of TETS) {
          const v = tet.map((c) => ids[c]!);
          const inside = v.filter((n) => field[n]! > 0);
          const out = v.filter((n) => field[n]! <= 0);
          if (inside.length === 1 || inside.length === 3) {
            const lone = inside.length === 1 ? inside[0]! : out[0]!;
            const rest = inside.length === 1 ? out : inside;
            tris.push(vertexOn(lone, rest[0]!), vertexOn(lone, rest[1]!), vertexOn(lone, rest[2]!));
          } else if (inside.length === 2) {
            const [a, b] = inside as [number, number];
            const [c, d] = out as [number, number];
            tris.push(vertexOn(a, c), vertexOn(a, d), vertexOn(b, d), vertexOn(a, c), vertexOn(b, d), vertexOn(b, c));
          }
        }
      }
  // Face every triangle outward (down the field).
  const gradient = (q: V3): V3 => {
    const i = Math.min(nx - 2, Math.max(1, Math.round((q[0] - lo[0]) / h)));
    const j = Math.min(ny - 2, Math.max(1, Math.round((q[1] - lo[1]) / h)));
    const k = Math.min(nz - 2, Math.max(1, Math.round((q[2] - lo[2]) / h)));
    return [field[at(i + 1, j, k)]! - field[at(i - 1, j, k)]!, field[at(i, j + 1, k)]! - field[at(i, j - 1, k)]!, field[at(i, j, k + 1)]! - field[at(i, j, k - 1)]!];
  };
  const vp = (v: number): V3 => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  for (let t = 0; t < tris.length; t += 3) {
    const a = vp(tris[t]!);
    const b = vp(tris[t + 1]!);
    const c = vp(tris[t + 2]!);
    const n = cross3(sub3(b, a), sub3(c, a));
    const g = gradient([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
    if (n[0] * g[0] + n[1] * g[1] + n[2] * g[2] > 0) [tris[t + 1], tris[t + 2]] = [tris[t + 2]!, tris[t + 1]!];
  }

  // Weld, smooth (Taubin, the sole's underside kept flat), simplify.
  const welded = weld(positions, tris);
  taubin(welded.positions, welded.indices, 16);
  const simplified = simplify(welded.positions, welded.indices, 3200);

  // Skin weights: from the nearest skin vertices (squashed, as the boot was grown round them).
  const near = [...used];
  const bones: number[] = [];
  const weights: number[] = [];
  for (let v = 0; v < simplified.positions.length / 3; v += 1) {
    const q: V3 = [simplified.positions[v * 3]!, simplified.positions[v * 3 + 1]!, simplified.positions[v * 3 + 2]!];
    const best = near
      .map((u) => ({ u, d: Math.hypot(skin[u * 3]! - q[0], skin[u * 3 + 1]! - q[1], skin[u * 3 + 2]! - q[2]) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 4);
    const blend = new Map<number, number>();
    for (const { u, d } of best) {
      const w = 1 / (d + 0.004);
      for (let k = 0; k < 4; k += 1) {
        const b = body.weights.bones[u * 4 + k]!;
        blend.set(b, (blend.get(b) ?? 0) + body.weights.weights[u * 4 + k]! * w);
      }
    }
    const top = [...blend.entries()].filter(([, w]) => w > 1e-6).sort((x, y) => y[1] - x[1]).slice(0, 4);
    const sum = top.reduce((s2, [, w]) => s2 + w, 0);
    for (let k = 0; k < 4; k += 1) {
      bones.push(top[k]?.[0] ?? 0);
      weights.push(top[k] ? top[k]![1] / sum : 0);
    }
  }

  const { faces, faceUvs, positions: charted, bones: chartedBones, weights: chartedWeights } = chart(simplified.positions, simplified.indices, bones, weights, rect);
  return { positions: charted, bones: chartedBones, weights: chartedWeights, faces, faceUvs };
}

function sub3(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function pointTriangle(p: V3, P: Float64Array, ia: number, ib: number, ic: number): number {
  // Ericson, Real-Time Collision Detection, 5.1.5.
  const a: V3 = [P[ia * 3]!, P[ia * 3 + 1]!, P[ia * 3 + 2]!];
  const b: V3 = [P[ib * 3]!, P[ib * 3 + 1]!, P[ib * 3 + 2]!];
  const c: V3 = [P[ic * 3]!, P[ic * 3 + 1]!, P[ic * 3 + 2]!];
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const ap = sub3(p, a);
  const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const len = (u: V3) => Math.hypot(u[0], u[1], u[2]);
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub3(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return len(sub3(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]));
  }
  const cp = sub3(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return len(sub3(p, [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return len(sub3(p, [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return len(sub3(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]));
}

/** Merges vertices closer than a micrometre and drops degenerate triangles. */
function weld(positions: number[], indices: number[]): { positions: number[]; indices: number[] } {
  const map = new Map<string, number>();
  const remap: number[] = [];
  const out: number[] = [];
  for (let v = 0; v < positions.length / 3; v += 1) {
    const k = `${Math.round(positions[v * 3]! * 1e6)},${Math.round(positions[v * 3 + 1]! * 1e6)},${Math.round(positions[v * 3 + 2]! * 1e6)}`;
    let i = map.get(k);
    if (i === undefined) {
      i = out.length / 3;
      map.set(k, i);
      out.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
    }
    remap.push(i);
  }
  const tris: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]!]!;
    const b = remap[indices[t + 1]!]!;
    const c = remap[indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { positions: out, indices: tris };
}

/** Taubin smoothing (lambda then mu), the sole's underside held on y = 0. */
function taubin(positions: number[], indices: number[], iterations: number): void {
  const n = positions.length / 3;
  const faces: number[][] = [];
  for (let t = 0; t < indices.length; t += 3) faces.push([indices[t]!, indices[t + 1]!, indices[t + 2]!]);
  const neighbours = adjacency(faces, n);
  const ground = new Uint8Array(n);
  for (let v = 0; v < n; v += 1) if (positions[v * 3 + 1]! < 0.0015) ground[v] = 1;
  for (let it = 0; it < iterations * 2; it += 1) {
    const factor = it % 2 === 0 ? 0.5 : -0.53;
    const next = positions.slice();
    for (let v = 0; v < n; v += 1) {
      const list = neighbours[v]!;
      if (!list.length) continue;
      for (let a = 0; a < 3; a += 1) {
        let s = 0;
        for (const u of list) s += positions[u * 3 + a]!;
        next[v * 3 + a] = positions[v * 3 + a]! + factor * (s / list.length - positions[v * 3 + a]!);
      }
      if (ground[v]) next[v * 3 + 1] = 0;
    }
    for (let k = 0; k < positions.length; k += 1) positions[k] = next[k]!;
  }
}

function simplify(positions: number[], indices: number[], targetTriangles: number): { positions: number[]; indices: number[] } {
  const [result] = MeshoptSimplifier.simplify(Uint32Array.from(indices), Float32Array.from(positions), 3, targetTriangles * 3, 0.0012, ["ErrorAbsolute"]);
  // Keep only the vertices used, in first-use order.
  const remap = new Map<number, number>();
  const out: number[] = [];
  const tris: number[] = [];
  for (const v of result) {
    let i = remap.get(v);
    if (i === undefined) {
      i = out.length / 3;
      remap.set(v, i);
      out.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
    }
    tris.push(i);
  }
  return { positions: out, indices: tris };
}

/**
 * Planar charts: each triangle goes to the axis its normal is nearest
 * (smoothed so the charts are not ragged), each chart is projected along its
 * axis, and the charts are shelf-packed into `rect` at the largest scale that
 * fits. Vertices on a chart's edge are split.
 */
function chart(positions: number[], indices: number[], bones: number[], weights: number[], rect: UvRect) {
  const triCount = indices.length / 3;
  const AXES: V3[] = [
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
  ];
  const vp = (v: number): V3 => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  const normals: V3[] = [];
  const label = new Int8Array(triCount);
  for (let t = 0; t < triCount; t += 1) {
    const a = vp(indices[t * 3]!);
    const n = cross3(sub3(vp(indices[t * 3 + 1]!), a), sub3(vp(indices[t * 3 + 2]!), a));
    const l = Math.hypot(...n) || 1;
    normals.push([n[0] / l, n[1] / l, n[2] / l]);
    let best = 0;
    let score = -Infinity;
    AXES.forEach((axis, i) => {
      // The sides win ties: they take the long faces of the boot.
      const d = normals[t]![0] * axis[0] + normals[t]![1] * axis[1] + normals[t]![2] * axis[2] + (i < 2 ? 0.08 : 0);
      if (d > score) {
        score = d;
        best = i;
      }
    });
    label[t] = best;
  }
  // Majority smoothing over shared edges.
  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < triCount; t += 1)
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t * 3 + k]!;
      const b = indices[t * 3 + ((k + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let list = edgeTris.get(key);
      if (!list) edgeTris.set(key, (list = []));
      list.push(t);
    }
  const neighbours: number[][] = Array.from({ length: triCount }, () => []);
  for (const list of edgeTris.values()) if (list.length === 2) {
    neighbours[list[0]!]!.push(list[1]!);
    neighbours[list[1]!]!.push(list[0]!);
  }
  for (let pass = 0; pass < 4; pass += 1) {
    const next = Int8Array.from(label);
    for (let t = 0; t < triCount; t += 1) {
      const counts = new Map<number, number>();
      for (const u of neighbours[t]!) counts.set(label[u]!, (counts.get(label[u]!) ?? 0) + 1);
      for (const [l, c] of counts) {
        const axis = AXES[l]!;
        const ok = normals[t]![0] * axis[0] + normals[t]![1] * axis[1] + normals[t]![2] * axis[2] > 0.2;
        if (c >= 2 && l !== label[t] && ok) next[t] = l;
      }
    }
    label.set(next);
  }
  // Per chart: projected 2-D coordinates (metres) and bounds.
  const project = (axis: number, q: V3): [number, number] => {
    switch (axis) {
      case 0: return [q[0], q[1]];
      case 1: return [-q[0], q[1]];
      case 2: return [q[0], -q[2]];
      case 3: return [q[0], q[2]];
      case 4: return [-q[2], q[1]];
      default: return [q[2], q[1]];
    }
  };
  const bounds = AXES.map(() => ({ u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity }));
  for (let t = 0; t < triCount; t += 1)
    for (let k = 0; k < 3; k += 1) {
      const [u, v] = project(label[t]!, vp(indices[t * 3 + k]!));
      const b = bounds[label[t]!]!;
      b.u0 = Math.min(b.u0, u);
      b.v0 = Math.min(b.v0, v);
      b.u1 = Math.max(b.u1, u);
      b.v1 = Math.max(b.v1, v);
    }
  const charts = bounds.map((b, i) => ({ i, w: Math.max(0, b.u1 - b.u0), h: Math.max(0, b.v1 - b.v0) })).filter((c) => c.w > 0);
  // Shelf packing at a scale found by bisection.
  const pad = 0.004;
  const place = (scale: number) => {
    const spots = new Map<number, [number, number]>();
    let x = rect.u0;
    let y = rect.v0;
    let shelf = 0;
    for (const c of [...charts].sort((a, b) => b.h - a.h)) {
      const w = c.w * scale;
      const hh = c.h * scale;
      if (x + w > rect.u1) {
        x = rect.u0;
        y += shelf + pad;
        shelf = 0;
      }
      if (x + w > rect.u1 || y + hh > rect.v1) return null;
      spots.set(c.i, [x, y]);
      x += w + pad;
      shelf = Math.max(shelf, hh);
    }
    return spots;
  };
  let lo = 0;
  let hi = 2;
  for (let it = 0; it < 30; it += 1) {
    const mid = (lo + hi) / 2;
    if (place(mid)) lo = mid;
    else hi = mid;
  }
  const scale = lo;
  const spots = place(scale)!;
  // Split vertices per chart.
  const outPositions: number[] = [];
  const outBones: number[] = [];
  const outWeights: number[] = [];
  const split = new Map<string, number>();
  const faces: number[][] = [];
  const faceUvs: number[][] = [];
  for (let t = 0; t < triCount; t += 1) {
    const l = label[t]!;
    const face: number[] = [];
    const uv: number[] = [];
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k]!;
      const key = `${v}:${l}`;
      let i = split.get(key);
      if (i === undefined) {
        i = outPositions.length / 3;
        split.set(key, i);
        outPositions.push(...vp(v));
        for (let m = 0; m < 4; m += 1) {
          outBones.push(bones[v * 4 + m]!);
          outWeights.push(weights[v * 4 + m]!);
        }
      }
      face.push(i);
      const [u, w] = project(l, vp(v));
      const [sx, sy] = spots.get(l)!;
      uv.push(sx + (u - bounds[l]!.u0) * scale, sy + (w - bounds[l]!.v0) * scale);
    }
    faces.push(face);
    faceUvs.push(uv);
  }
  return { faces, faceUvs, positions: outPositions, bones: outBones, weights: outWeights, scale };
}
