/**
 * The walker's textures, baked from the finished mesh: every texel of the
 * atlas is found on the surface (rasterising the triangles in UV space), and
 * painted from where it is on the body and what it belongs to. Three maps:
 *
 *  - albedo (sRGB): skin with its tone varying (redder cheeks, nose, ears,
 *    lips and knuckles, a shade under the eyes, stubble, brows, nails, a soft
 *    hairline), the jacket's soft-shell and its seams, zip and bindings, the
 *    trousers' cotton and seams, the boots' leather, laces and rubber sole,
 *    hair strands, the irises; a little of the occlusion multiplied in;
 *  - normal (tangent space, +X along U, +Y along V): pores, fabric grain,
 *    folds at the elbows, knees and ankles, seams and stitching, the zip's
 *    teeth, leather grain and creases, the sole's tread, hair strands;
 *  - ORM: R the ray-traced ambient occlusion, G roughness, B metallic.
 *
 * Painted at the full size and halved (in linear light, normals
 * renormalised) for the smaller tiers.
 */
import { BIND_POSITIONS, SIDES } from "../../src/render/webgpu/person/skeleton";
import type { ExportedMesh, PartKind } from "./parts.mts";
import type { OcclusionTracer } from "./ao.mts";
import { cellular, fbm, noise3 } from "./noise.mts";
import { HAIR_SHELL_FROM, OUTFIT } from "./clothes.mts";
import { BOOT } from "./boots.mts";

type V3 = [number, number, number];

export interface Landmarks {
  /** Per eye: its middle, half-sizes and the way it looks. */
  readonly eyes: readonly { readonly center: V3; readonly axes: V3; readonly forward: V3 }[];
  /** The middle of the lips' parting line. */
  readonly mouth: V3;
  readonly mouthHalfWidth: number;
  readonly noseTip: V3;
  /** How much hair a point on the head carries, 0 to 1. */
  readonly hair: (q: V3) => number;
  /** Per finger and thumb, its tip and the back of the hand's direction there. */
  readonly fingertips: readonly { readonly tip: V3; readonly dorsal: V3 }[];
  /** Per side, the direction the palm faces. */
  readonly palms: readonly V3[];
  /** The jacket's collar top at the front, and the hem. */
  readonly collarTop: number;
  /** Per boot: the toe's front, the foot's middle across, and the front's outline (x, y) up the middle from where the lacing starts. */
  readonly toes: readonly { readonly x: number; readonly z: number; readonly lacing: readonly (readonly [number, number])[] }[];
}

export interface BakedMaps {
  readonly size: number;
  /** RGB, rows from the image's top (V = 1). */
  readonly albedo: Uint8Array;
  readonly normal: Uint8Array;
  readonly orm: Uint8Array;
}

const bind = (bone: number): V3 => [BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const gauss = (d: number, sigma: number) => Math.exp(-(d * d) / (2 * sigma * sigma));
const srgb = (r: number, g: number, b: number): V3 => [r / 255, g / 255, b / 255];
/** Fabric folds: ridged noise, sharp crests between soft hollows, centred on zero. */
const fold = (a: number, b: number, seed: number) => {
  const r = 1 - Math.abs(noise3(a, b, seed));
  return r * r - 0.55;
};

interface Shade {
  color: V3;
  rough: number;
  metal: number;
}

/** Which triangle covers each texel and where in it (rows from V = 1). */
interface Raster {
  readonly size: number;
  readonly tri: Int32Array;
  readonly baryA: Float32Array;
  readonly baryB: Float32Array;
}

function rasterise(mesh: ExportedMesh, size: number): Raster {
  const { uvs: UV, indices: I, trianglePart } = mesh;
  const triCount = I.length / 3;
  const texels = size * size;
  const tri = new Int32Array(texels).fill(-1);
  const baryA = new Float32Array(texels);
  const baryB = new Float32Array(texels);
  // Part by part in the list's order (later ones over earlier ones where they share texels).
  const order = Array.from({ length: triCount }, (_, t) => t).sort((a, b) => trianglePart[a]! - trianglePart[b]! || a - b);
  for (const t of order) {
    const ia = I[t * 3]!;
    const ib = I[t * 3 + 1]!;
    const ic = I[t * 3 + 2]!;
    const ax = UV[ia * 2]! * size;
    const ay = (1 - UV[ia * 2 + 1]!) * size;
    const bx = UV[ib * 2]! * size;
    const by = (1 - UV[ib * 2 + 1]!) * size;
    const cx = UV[ic * 2]! * size;
    const cy = (1 - UV[ic * 2 + 1]!) * size;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    // Texels whose centre is inside, or within a third of a texel of an edge (no cracks between triangles).
    const eps = (-0.35 * Math.max(Math.abs(bx - ax) + Math.abs(by - ay), 1e-6)) / Math.abs(area);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        const n = y * size + x;
        tri[n] = t;
        baryA[n] = w0;
        baryB[n] = w1;
      }
    }
  }
  return { size, tri, baryA, baryB };
}

/** The surface point and smooth normal at a texel of a raster. */
function surfaceAt(mesh: ExportedMesh, raster: Raster, i: number, p: V3, n: V3): void {
  const { positions: P, normals: N, indices: I } = mesh;
  const t = raster.tri[i]!;
  // Inside the triangle: a texel taken just past an edge would otherwise sit off the surface, under its neighbour.
  let w0 = Math.max(0, raster.baryA[i]!);
  let w1 = Math.max(0, raster.baryB[i]!);
  let w2 = Math.max(0, 1 - raster.baryA[i]! - raster.baryB[i]!);
  const sum = w0 + w1 + w2;
  w0 /= sum;
  w1 /= sum;
  w2 /= sum;
  const a = I[t * 3]!;
  const b = I[t * 3 + 1]!;
  const c = I[t * 3 + 2]!;
  for (let k = 0; k < 3; k += 1) {
    p[k] = P[a * 3 + k]! * w0 + P[b * 3 + k]! * w1 + P[c * 3 + k]! * w2;
    n[k] = N[a * 3 + k]! * w0 + N[b * 3 + k]! * w1 + N[c * 3 + k]! * w2;
  }
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  n[0] /= l;
  n[1] /= l;
  n[2] /= l;
}

/**
 * The occlusion traced per texel of a half-size raster (it changes slowly
 * over the surface), smoothed a little within each island, grown past the
 * islands' edges, then read bilinearly.
 * Per texel rather than per vertex: a vertex buried under another part (the
 * collar's foot inside the jacket) would smear its darkness up its long
 * triangles into the open.
 */
function occlusionMap(mesh: ExportedMesh, trace: OcclusionTracer, size: number): (u: number, v: number) => number {
  const raster = rasterise(mesh, size);
  const texels = size * size;
  const value = new Float32Array(texels);
  const filled = new Uint8Array(texels);
  const p: V3 = [0, 0, 0];
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < texels; i += 1) {
    if (raster.tri[i]! < 0) continue;
    surfaceAt(mesh, raster, i, p, n);
    value[i] = trace(p, n, i);
    filled[i] = 1;
  }
  // One 3 x 3 pass over each texel's filled neighbours: the rays' noise, not the shape, goes.
  const smooth = Float32Array.from(value);
  for (let y = 1; y < size - 1; y += 1)
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      if (!filled[i]) continue;
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const j = i + dy * size + dx;
          if (filled[j]) {
            sum += value[j]!;
            count += 1;
          }
        }
      smooth[i] = sum / count;
    }
  value.set(smooth);
  dilate(size, filled, [value], 4);
  for (let i = 0; i < texels; i += 1) if (!filled[i]) value[i] = 1;
  return (u, v) => {
    const x = u * size - 0.5;
    const y = (1 - v) * size - 0.5;
    const x0 = Math.max(0, Math.min(size - 2, Math.floor(x)));
    const y0 = Math.max(0, Math.min(size - 2, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - x0));
    const fy = Math.min(1, Math.max(0, y - y0));
    const i = y0 * size + x0;
    return mix(mix(value[i]!, value[i + 1]!, fx), mix(value[i + size]!, value[i + size + 1]!, fx), fy);
  };
}

/** Grows filled texels into their empty neighbours `passes` times, averaging each channel array (one value per texel, or `stride` per texel). */
function dilate(size: number, filled: Uint8Array, channels: readonly Float32Array[], passes: number, stride = 1): void {
  for (let pass = 0; pass < passes; pass += 1) {
    const grown = Uint8Array.from(filled);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        if (filled[i]) continue;
        let count = 0;
        const neighbours: number[] = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          const j = yy * size + xx;
          if (!filled[j]) continue;
          count += 1;
          neighbours.push(j);
        }
        if (!count) continue;
        for (const channel of channels)
          for (let k = 0; k < stride; k += 1) {
            let sum = 0;
            for (const j of neighbours) sum += channel[j * stride + k]!;
            channel[i * stride + k] = sum / count;
          }
        grown[i] = 1;
      }
    filled.set(grown);
  }
}

export function bakeTextures(mesh: ExportedMesh, kinds: readonly PartKind[], trace: OcclusionTracer, marks: Landmarks, size: number): BakedMaps {
  const { positions: P, uvs: UV, indices: I, trianglePart } = mesh;
  const triCount = I.length / 3;
  const texels = size * size;
  const { tri, baryA, baryB } = rasterise(mesh, size);
  const occlusionAt = occlusionMap(mesh, trace, Math.max(256, size / 2));

  // Per triangle: the tangent frame (dP/dU, dP/dV) and the world size of a texel.
  const tangent = new Float32Array(triCount * 6);
  const texelSize = new Float32Array(triCount);
  for (let t = 0; t < triCount; t += 1) {
    const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
    const e1: V3 = [P[b * 3]! - P[a * 3]!, P[b * 3 + 1]! - P[a * 3 + 1]!, P[b * 3 + 2]! - P[a * 3 + 2]!];
    const e2: V3 = [P[c * 3]! - P[a * 3]!, P[c * 3 + 1]! - P[a * 3 + 1]!, P[c * 3 + 2]! - P[a * 3 + 2]!];
    const du1 = UV[b * 2]! - UV[a * 2]!;
    const dv1 = UV[b * 2 + 1]! - UV[a * 2 + 1]!;
    const du2 = UV[c * 2]! - UV[a * 2]!;
    const dv2 = UV[c * 2 + 1]! - UV[a * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    const r = Math.abs(det) > 1e-14 ? 1 / det : 0;
    for (let k = 0; k < 3; k += 1) {
      tangent[t * 6 + k] = (e1[k]! * dv2 - e2[k]! * dv1) * r;
      tangent[t * 6 + 3 + k] = (e2[k]! * du1 - e1[k]! * du2) * r;
    }
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const area3 = Math.hypot(cross[0]!, cross[1]!, cross[2]!) / 2;
    const areaUv = (Math.abs(det) / 2) * size * size;
    texelSize[t] = areaUv > 0 ? Math.sqrt(area3 / areaUv) : 0.001;
  }

  const painter = new Painter(marks);
  const albedo = new Float32Array(texels * 3);
  const normal = new Float32Array(texels * 3);
  const orm = new Float32Array(texels * 3);
  const filled = new Uint8Array(texels);
  const shade: Shade = { color: [0, 0, 0], rough: 0.5, metal: 0 };
  const p: V3 = [0, 0, 0];
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < texels; i += 1) {
    const t = tri[i]!;
    if (t < 0) continue;
    surfaceAt(mesh, { size, tri, baryA, baryB }, i, p, n);
    const w0 = baryA[i]!;
    const w1 = baryB[i]!;
    const w2 = 1 - w0 - w1;
    const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
    // Never quite black: light bounces into the deepest creases too.
    const ao = 0.15 + 0.85 * occlusionAt(UV[a * 2]! * w0 + UV[b * 2]! * w1 + UV[c * 2]! * w2, UV[a * 2 + 1]! * w0 + UV[b * 2 + 1]! * w1 + UV[c * 2 + 1]! * w2);
    const kind = kinds[trianglePart[t]!]!;
    const ts = texelSize[t]!;
    painter.shade(kind, p, n, ts, shade);

    // The tangent frame at the texel, made square to the normal.
    const T = orthogonal([tangent[t * 6]!, tangent[t * 6 + 1]!, tangent[t * 6 + 2]!], n);
    const B0 = orthogonal([tangent[t * 6 + 3]!, tangent[t * 6 + 4]!, tangent[t * 6 + 5]!], n);
    const step = Math.max(ts, 0.00015);
    const h0 = painter.height(kind, p, n, ts);
    const hT = painter.height(kind, [p[0] + T[0] * step, p[1] + T[1] * step, p[2] + T[2] * step], n, ts);
    const hB = painter.height(kind, [p[0] + B0[0] * step, p[1] + B0[1] * step, p[2] + B0[2] * step], n, ts);
    let nx = -(hT - h0) / step;
    let ny = -(hB - h0) / step;
    let nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len;
    ny /= len;
    nz /= len;

    const darken = mix(1, ao, 0.4);
    albedo[i * 3] = shade.color[0] * darken;
    albedo[i * 3 + 1] = shade.color[1] * darken;
    albedo[i * 3 + 2] = shade.color[2] * darken;
    normal[i * 3] = nx;
    normal[i * 3 + 1] = ny;
    normal[i * 3 + 2] = nz;
    orm[i * 3] = ao;
    orm[i * 3 + 1] = shade.rough;
    orm[i * 3 + 2] = shade.metal;
    filled[i] = 1;
  }

  // Grow every island a few texels, so filtering and the smaller mip levels never reach the background.
  dilate(size, filled, [albedo, normal, orm], 8, 3);
  // Everything else: a neutral fill (flat normal, mid grey).
  for (let i = 0; i < texels; i += 1) {
    if (filled[i]) continue;
    albedo.set([0.4, 0.4, 0.4], i * 3);
    normal.set([0, 0, 1], i * 3);
    orm.set([1, 0.8, 0], i * 3);
  }
  return encode(size, albedo, normal, orm);
}

function orthogonal(v: V3, n: V3): V3 {
  const d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  const o: V3 = [v[0] - n[0] * d, v[1] - n[1] * d, v[2] - n[2] * d];
  const l = Math.hypot(o[0], o[1], o[2]) || 1;
  return [o[0] / l, o[1] / l, o[2] / l];
}

function encode(size: number, albedo: Float32Array, normal: Float32Array, orm: Float32Array): BakedMaps {
  const a = new Uint8Array(size * size * 3);
  const nn = new Uint8Array(size * size * 3);
  const o = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size * 3; i += 1) {
    a[i] = Math.round(clamp01(albedo[i]!) * 255);
    nn[i] = Math.round(clamp01(normal[i]! * 0.5 + 0.5) * 255);
    o[i] = Math.round(clamp01(orm[i]!) * 255);
  }
  return { size, albedo: a, normal: nn, orm: o };
}

/** Halves the maps: albedo averaged in linear light, normals renormalised. */
export function halve(maps: BakedMaps): BakedMaps {
  const s = maps.size / 2;
  const toLinear = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const toSrgb = (x: number) => Math.round(255 * clamp01(x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
  const a = new Uint8Array(s * s * 3);
  const n = new Uint8Array(s * s * 3);
  const o = new Uint8Array(s * s * 3);
  for (let y = 0; y < s; y += 1)
    for (let x = 0; x < s; x += 1) {
      const src = [(2 * y * maps.size + 2 * x) * 3, (2 * y * maps.size + 2 * x + 1) * 3, ((2 * y + 1) * maps.size + 2 * x) * 3, ((2 * y + 1) * maps.size + 2 * x + 1) * 3];
      const dst = (y * s + x) * 3;
      const v: V3 = [0, 0, 0];
      for (let k = 0; k < 3; k += 1) {
        a[dst + k] = toSrgb(src.reduce((sum, i) => sum + toLinear(maps.albedo[i + k]!), 0) / 4);
        o[dst + k] = Math.round(src.reduce((sum, i) => sum + maps.orm[i + k]!, 0) / 4);
        v[k] = src.reduce((sum, i) => sum + (maps.normal[i + k]! / 255) * 2 - 1, 0);
      }
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      for (let k = 0; k < 3; k += 1) n[dst + k] = Math.round(clamp01((v[k]! / l) * 0.5 + 0.5) * 255);
    }
  return { size: s, albedo: a, normal: n, orm: o };
}

/** The painters, one per part kind. */
class Painter {
  private readonly shoulders: V3[];
  private readonly elbows: V3[];
  private readonly wrists: V3[];
  private readonly hips: V3[];

  constructor(private readonly marks: Landmarks) {
    this.shoulders = SIDES.map((s) => bind(s.upperArm));
    this.elbows = SIDES.map((s) => bind(s.forearm));
    this.wrists = SIDES.map((s) => bind(s.hand));
    this.hips = SIDES.map((s) => bind(s.thigh));
  }

  shade(kind: PartKind, p: V3, n: V3, ts: number, out: Shade): void {
    switch (kind) {
      case "skin":
        return this.skin(p, n, ts, out);
      case "eyes":
        return this.eye(p, out);
      case "boots":
        return this.boot(p, n, ts, out);
      case "trousers":
        return this.trousers(p, n, ts, out);
      case "jacket":
        return this.jacket(p, n, ts, out);
      case "hair":
        return this.hair(p, n, ts, out);
    }
  }

  height(kind: PartKind, p: V3, n: V3, ts: number): number {
    switch (kind) {
      case "skin":
        return this.skinHeight(p, n, ts);
      case "eyes":
        return 0;
      case "boots":
        return this.bootHeight(p, n, ts);
      case "trousers":
        return this.trousersHeight(p, ts);
      case "jacket":
        return this.jacketHeight(p, n, ts);
      case "hair":
        return this.hairHeight(p, n, ts);
    }
  }

  // ---------- skin

  private face(p: V3) {
    const m = this.marks;
    const side = p[2] < 0 ? 0 : 1;
    const eye = m.eyes[side]!.center;
    return { side, eye, dz: Math.abs(p[2]), dy: p[1] - m.mouth[1] };
  }

  /** The stubble's cover: the moustache, the chin and the jaw, the cheeks below the beard line, the throat. */
  private beard(p: V3, n: V3): number {
    const m = this.marks;
    if (p[1] < m.mouth[1] - 0.1 || p[1] > m.mouth[1] + 0.06 || p[0] < 0.0) return 0;
    const dz = Math.abs(p[2]);
    // The upper edge: under the nose over the moustache, down to the mouth's corners, then up the cheek line to the sideburn.
    const top =
      dz < 0.018
        ? m.mouth[1] + 0.021
        : dz < 0.032
          ? m.mouth[1] + mix(0.021, 0.008, smoothstep(0.018, 0.032, dz))
          : m.mouth[1] + 0.008 + (dz - 0.032) * 1.0;
    // The lower edge: down the throat under the jaw.
    const bottom = m.mouth[1] - 0.088;
    const inBand = smoothstep(top + 0.003, top - 0.005, p[1]) * smoothstep(bottom - 0.012, bottom + 0.012, p[1]);
    // Not on the lips, not round to the back of the neck.
    const front = smoothstep(-0.01, 0.04, p[0] - 0.02 + (0.07 - dz) * 0.4);
    return inBand * (1 - this.lips(p, n)) * front;
  }

  /** How much of a point is lip (the vermilion), 0 to 1. */
  private lips(p: V3, n: V3): number {
    const m = this.marks;
    if (n[0] < -0.2) return 0;
    const across = Math.abs(p[2] - m.mouth[2]) / m.mouthHalfWidth;
    if (across > 1.2 || p[0] < m.mouth[0] - 0.014) return 0;
    const dy = p[1] - m.mouth[1];
    // The vermilion's height over and under the parting: the upper lip with its Cupid's bow, the fuller lower lip, both narrowing to the corners.
    const bow = 0.0009 * gauss(across - 0.3, 0.13) - 0.0007 * gauss(across, 0.1);
    const upper = (0.0098 + bow) * Math.pow(Math.max(0, 1 - across * across), 0.55) + 0.0004;
    const lower = 0.0105 * Math.pow(Math.max(0, 1 - Math.pow(across, 2.2)), 0.65) + 0.0004;
    const edge = 0.0011;
    const inUpper = smoothstep(upper + edge, upper - edge, dy) * smoothstep(-0.0015, 0, dy);
    const inLower = smoothstep(-lower - edge, -lower + edge, dy) * smoothstep(0.0015, 0, dy);
    return clamp01(Math.max(inUpper, inLower)) * smoothstep(1.2, 0.9, across);
  }

  private brow(p: V3): { amount: number; along: number } {
    const { eye, dz } = this.face(p);
    // Across from the eye's middle outward (+) and in toward the nose (-).
    const out = dz - Math.abs(eye[2]);
    if (out < -0.024 || out > 0.03 || p[0] < eye[0] - 0.02) return { amount: 0, along: 0 };
    const t = clamp01((out + 0.02) / 0.047);
    // Over the brow ridge, arching a little a third of the way out, the tail lower.
    const centre = eye[1] + 0.021 + 0.005 * Math.sin(Math.PI * Math.min(1, t * 1.3)) - 0.005 * t * t;
    const half = 0.0034 * (1 - 0.6 * t) + 0.0009;
    const dy = Math.abs(p[1] - centre);
    const fadeEnds = smoothstep(0, 0.16, t) * smoothstep(1.02, 0.8, t);
    return { amount: smoothstep(half + 0.0018, half - 0.0006, dy) * fadeEnds, along: t };
  }

  /** The lids' edges, where the lashes grow: skin resting on the eyeball. */
  private lashes(p: V3): number {
    const e = this.marks.eyes[p[2] < 0 ? 0 : 1]!;
    if (p[0] < e.center[0]) return 0;
    const rho = Math.hypot((p[0] - e.center[0]) / e.axes[0], (p[1] - e.center[1]) / e.axes[1], (p[2] - e.center[2]) / e.axes[2]);
    const upper = p[1] > e.center[1] - 0.001 ? 1 : 0.35;
    return smoothstep(1.2, 1.06, rho) * upper;
  }

  private nail(p: V3, n: V3): number {
    let best = 0;
    for (const f of this.marks.fingertips) {
      const d = dist(p, f.tip);
      if (d > 0.016) continue;
      const back = n[0] * f.dorsal[0] + n[1] * f.dorsal[1] + n[2] * f.dorsal[2];
      best = Math.max(best, smoothstep(0.0125, 0.0095, d) * smoothstep(0.25, 0.55, back));
    }
    return best;
  }

  private skin(p: V3, n: V3, ts: number, out: Shade): void {
    const m = this.marks;
    let c = srgb(196, 146, 118);
    // Tone that varies over the body, and a fine mottle.
    const tone = fbm(p[0], p[1], p[2], 0.05, 3, ts);
    const mottle = fbm(p[0] + 3, p[1], p[2], 0.004, 3, ts);
    c = c.map((x, k) => x * (1 + 0.05 * tone + 0.025 * mottle - (k === 2 ? 0.01 * tone : 0))) as V3;
    let rough = 0.55 + 0.05 * mottle;
    const onHead = p[1] > 1.45;
    if (onHead) {
      const { eye, dz } = this.face(p);
      // Redder: cheeks, the nose's tip, the ears.
      const cheek = gauss(dist(p, [eye[0] - 0.005, eye[1] - 0.033, Math.sign(p[2]) * (Math.abs(eye[2]) + 0.014)]), 0.016);
      const nose = gauss(dist(p, m.noseTip), 0.011);
      const ear = dz > 0.07 && p[0] < eye[0] - 0.06 ? smoothstep(0.07, 0.085, dz) : 0;
      const red = 0.4 * cheek + 0.35 * nose + 0.35 * ear;
      c = [mix(c[0], 0.77, red * 0.6), mix(c[1], 0.47, red * 0.6), mix(c[2], 0.42, red * 0.6)];
      // A shade under the eyes and in the lids' creases.
      const under = gauss(Math.hypot(p[1] - (eye[1] - 0.013), dz - Math.abs(eye[2])), 0.008) * smoothstep(eye[0] - 0.02, eye[0] + 0.01, p[0]);
      const lid = gauss(Math.hypot(p[1] - (eye[1] + 0.011), dz - Math.abs(eye[2])), 0.009) * smoothstep(eye[0] - 0.02, eye[0] + 0.01, p[0]);
      c = c.map((x, k) => x * (1 - 0.1 * under - 0.08 * lid + (k === 2 ? 0.03 * under : 0))) as V3;
      // An oilier T-zone.
      const tzone = (smoothstep(0.03, 0.0, dz) * smoothstep(m.mouth[1] + 0.01, m.mouth[1] + 0.03, p[1])) * smoothstep(0.5, 0.9, n[0]);
      rough -= 0.1 * tzone;
      // Lips: a deeper, browner pink than the skin round them, and the dark line where they meet.
      const lips = this.lips(p, n);
      if (lips > 0) {
        const lipColor = srgb(176, 112, 100);
        const lines = 0.035 * noise3(p[2] / 0.0007, p[1] / 0.004, 0);
        c = c.map((x, k) => mix(x, lipColor[k]! * (1 + lines), lips * 0.7)) as V3;
        rough = mix(rough, 0.4, lips);
      }
      {
        const across = Math.abs(p[2]) / m.mouthHalfWidth;
        const line = gauss(p[1] - m.mouth[1], 0.0007) * smoothstep(1.15, 0.8, across) * smoothstep(m.mouth[0] - 0.012, m.mouth[0] - 0.004, p[0]);
        c = c.map((x) => x * (1 - 0.45 * line)) as V3;
      }
      // Stubble: a faint grey-blue shadow over the beard, the follicles barely there.
      const beard = this.beard(p, n);
      if (beard > 0) {
        const cell = cellular(p[0] / 0.0007, p[1] / 0.0007, p[2] / 0.0007);
        const dot = smoothstep(0.4, 0.2, cell) * smoothstep(0.0012, 0.0004, ts);
        const shadow = 0.13 + 0.1 * dot;
        const hairColor = srgb(78, 66, 62);
        c = c.map((x, k) => mix(x, hairColor[k]!, shadow * beard)) as V3;
        rough = mix(rough, 0.6, beard * 0.5);
      }
      // Brows: short hairs along the brow, thinning at the ends.
      const brow = this.brow(p);
      if (brow.amount > 0) {
        const strands = noise3(p[1] / 0.0005 + brow.along * 6, (p[2] * Math.sign(p[2]) - p[1] * 0.6) / 0.0035, p[0] / 0.002);
        const cover = clamp01(brow.amount * (0.6 + 0.55 * strands));
        const browColor = srgb(58, 45, 35);
        c = c.map((x, k) => mix(x, browColor[k]!, cover * 0.85)) as V3;
      }
      // Lashes: a dark line along the upper lid's edge, a fainter one under the eye.
      const lash = this.lashes(p);
      c = c.map((x) => x * (1 - 0.6 * lash)) as V3;
      // The hairline: short hairs thinning out at the edge of the cut.
      const hair = m.hair(p);
      if (hair > 0) {
        // Sparse dots at the edge, closing to the hair shell's own look where the cut is thick, so the shell's
        // edge (stepped along the body's faces) meets the skin with nothing to tell them apart.
        const dots = smoothstep(0.45, 0.2, cellular(p[0] / 0.0008, p[1] / 0.0008, p[2] / 0.0008));
        const cover = clamp01(smoothstep(0, 0.8, hair) * mix(0.75 + 0.25 * dots, 1, smoothstep(0.5, 0.9, hair)));
        const look = this.hairLook(p, n, ts);
        c = c.map((x, k) => mix(x, look.color[k]!, cover)) as V3;
        rough = mix(rough, look.rough, cover);
      }
    } else if (p[1] > 0.6 && p[1] < 1.0) {
      // The hands: pinker palms, redder knuckles, nails.
      const side = p[2] < 0 ? 0 : 1;
      const palm = this.marks.palms[side]!;
      const facing = n[0] * palm[0] + n[1] * palm[1] + n[2] * palm[2];
      const palmSide = smoothstep(0.1, 0.5, facing);
      c = [mix(c[0], 0.82, palmSide * 0.2), mix(c[1], 0.58, palmSide * 0.2), mix(c[2], 0.5, palmSide * 0.2)];
      rough = mix(rough, 0.62, palmSide);
      const nail = this.nail(p, n);
      if (nail > 0) {
        const nailColor = srgb(214, 168, 152);
        c = c.map((x, k) => mix(x, nailColor[k]!, nail * 0.85)) as V3;
        rough = mix(rough, 0.3, nail);
      }
    }
    out.color = c;
    out.rough = clamp01(rough);
    out.metal = 0;
  }

  private skinHeight(p: V3, n: V3, ts: number): number {
    let h = 0;
    if (p[1] > 1.45) {
      // Pores, finer at the eyes, coarser on the nose and cheeks.
      if (ts < 0.0005) {
        const pore = cellular(p[0] / 0.0007, p[1] / 0.0007, p[2] / 0.0007);
        h -= 0.000035 * smoothstep(0.3, 0.05, pore);
      }
      h += 0.00002 * fbm(p[0], p[1], p[2], 0.0015, 2, ts);
      // The lips' fine vertical lines.
      const lips = this.lips(p, n);
      if (lips > 0) h += lips * 0.00003 * Math.sin(p[2] / 0.0009 * Math.PI * 2 + 2 * noise3(p[2] / 0.002, p[1] / 0.002, 0));
      // Faint lines across the forehead.
      const m = this.marks;
      const forehead = smoothstep(m.eyes[0]!.center[1] + 0.03, m.eyes[0]!.center[1] + 0.04, p[1]) * smoothstep(0.05, 0.02, Math.abs(p[2])) * smoothstep(0.6, 0.9, n[0]);
      if (forehead > 0) h += forehead * 0.00004 * Math.sin(p[1] / 0.0095 * Math.PI * 2 + 1.5 * noise3(p[2] / 0.02, p[1] / 0.02, 1));
    } else {
      h += 0.000025 * fbm(p[0], p[1], p[2], 0.002, 2, ts);
      // Knuckle creases: rings round the fingers near their joints, on the back.
      for (const f of this.marks.fingertips) {
        const d = dist(p, f.tip);
        if (d < 0.07 && d > 0.015) {
          const back = n[0] * f.dorsal[0] + n[1] * f.dorsal[1] + n[2] * f.dorsal[2];
          if (back > 0) h += 0.00005 * back * Math.max(0, Math.sin(d / 0.0028 * Math.PI)) * gauss(d - 0.03, 0.006);
        }
      }
    }
    return h;
  }

  // ---------- eyes

  private eye(p: V3, out: Shade): void {
    const e = this.marks.eyes[p[2] < 0 ? 0 : 1]!;
    const d: V3 = [p[0] - e.center[0], p[1] - e.center[1], p[2] - e.center[2]];
    // How far off the line of sight, in metres, and round it (periodic, so the iris has no seam).
    const r = d[0] > 0 ? Math.hypot(d[1], d[2]) : 1;
    const around = Math.atan2(d[1], d[2] * Math.sign(p[2] || 1));
    const ca = Math.cos(around);
    const sa = Math.sin(around);
    const IRIS = 0.0059;
    const PUPIL = 0.0019;
    const iris = smoothstep(IRIS + 0.00035, IRIS - 0.00025, r);
    const pupil = smoothstep(PUPIL + 0.0002, PUPIL - 0.00015, r);
    // Across the iris, 0 at the pupil to 1 at its rim: radial fibres, a lighter ring round the pupil, a dark rim.
    const t = clamp01((r - PUPIL) / (IRIS - PUPIL));
    const fibre = 0.55 * noise3(ca * 9, sa * 9, t * 2.2) + 0.35 * noise3(ca * 26, sa * 26, t * 4 + 3) + 0.2 * noise3(ca * 60, sa * 60, t * 6 + 7);
    const collarette = gauss(t - 0.28, 0.1);
    const rim = smoothstep(0.78, 1, t);
    const tone = clamp01(0.5 + fibre);
    const irisColor: V3 = [mix(0.16, 0.36, tone), mix(0.09, 0.21, tone), mix(0.045, 0.1, tone)].map((x, k) => x * (1 + (k === 2 ? 0.3 : 0.55) * collarette) * (1 - 0.55 * rim)) as V3;
    // The white: warm, a few veins and a pinker cast toward the corners.
    const vein = smoothstep(0.93, 0.985, 1 - Math.abs(noise3(ca * 5, sa * 5, r / 0.004))) * smoothstep(0.008, 0.013, r);
    const pink = smoothstep(0.009, 0.014, r);
    const sclera: V3 = [mix(0.85, 0.78, vein) * (1 - 0.03 * pink), mix(0.81, 0.55, vein) * (1 - 0.09 * pink), mix(0.76, 0.52, vein) * (1 - 0.1 * pink)];
    out.color = [0, 1, 2].map((k) => mix(mix(sclera[k]!, irisColor[k]!, iris), 0.02, pupil)) as V3;
    out.rough = 0.05;
    out.metal = 0;
  }

  // ---------- boots

  private bootFrame(p: V3) {
    const toe = this.marks.toes[p[2] < 0 ? 0 : 1]!;
    const soleTop = BOOT.sole - 0.007 * clamp01((p[0] - (toe.x - 0.13)) / 0.08);
    return { toe, soleTop, across: p[2] - toe.z };
  }

  /**
   * The lacing: across (-1 to 1 between the eyelets' rows) and along (metres up the front's outline from where it
   * starts), or null off it.
   */
  private lacing(p: V3, n: V3) {
    const { toe, across } = this.bootFrame(p);
    const w = across / 0.012;
    if (Math.abs(w) > 1.8 || n[0] < -0.2) return null;
    // The nearest point of the outline, seen from the side.
    let best = Infinity;
    let along = 0;
    let travelled = 0;
    const line = toe.lacing;
    for (let k = 0; k + 1 < line.length; k += 1) {
      const [ax, ay] = line[k]!;
      const [bx, by] = line[k + 1]!;
      const ex = bx - ax;
      const ey = by - ay;
      const len = Math.hypot(ex, ey);
      const t = clamp01(((p[0] - ax) * ex + (p[1] - ay) * ey) / (len * len || 1));
      const d = Math.hypot(p[0] - ax - ex * t, p[1] - ay - ey * t);
      if (d < best) {
        best = d;
        along = travelled + t * len;
      }
      travelled += len;
    }
    // Only on the front itself (the outline runs down its middle; the sides fall away from it).
    if (best > 0.012 || along < 0.004) return null;
    return { w, along };
  }

  private boot(p: V3, n: V3, ts: number, out: Shade): void {
    const { toe, soleTop } = this.bootFrame(p);
    const leather = srgb(88, 58, 38);
    const tone = fbm(p[0], p[1], p[2], 0.03, 3, ts);
    let c: V3 = leather.map((x) => x * (1 + 0.08 * tone)) as V3;
    let rough = 0.48 + 0.06 * tone;
    let metal = 0;
    // Worn lighter over the toe cap and where the foot flexes, scuffed here and there.
    const toeWear = gauss(Math.hypot(p[0] - (toe.x - 0.025), p[1] - 0.055, (p[2] - toe.z) * 0.8), 0.03);
    const scuff = smoothstep(0.55, 0.8, fbm(p[0] + 7, p[1], p[2], 0.01, 3, ts));
    c = c.map((x) => x * (1 + 0.22 * toeWear + 0.1 * scuff)) as V3;
    rough = mix(rough, 0.4, toeWear * 0.5);
    // The welt and its stitching, then the rubber sole.
    if (p[1] < soleTop + 0.0045) {
      const welt = smoothstep(soleTop - 0.001, soleTop + 0.0005, p[1]);
      const rubber = srgb(36, 33, 30);
      const weltColor = srgb(66, 46, 32);
      c = [mix(rubber[0], weltColor[0], welt), mix(rubber[1], weltColor[1], welt), mix(rubber[2], weltColor[2], welt)];
      rough = mix(0.9, 0.55, welt);
      const stitchBand = gauss(p[1] - (soleTop + 0.0022), 0.0005);
      const stitch = stitchBand * smoothstep(0.25, 0.1, Math.abs((((p[0] + Math.abs(p[2]) * 0.3) / 0.004) % 1) - 0.5));
      const thread = srgb(140, 116, 84);
      c = c.map((x, k) => mix(x, thread[k]!, stitch * 0.8)) as V3;
    }
    // The tongue between the quarters, their stitched edges, the eyelets and the crossed laces.
    const lacing = this.lacing(p, n);
    if (lacing) {
      const { w, along } = lacing;
      const PERIOD = 0.014;
      const s = along / PERIOD;
      // Where a texel is too coarse to draw the laces and eyelets, they fade to their average.
      const detail = smoothstep(0.0024, 0.0012, ts);
      const tongue = smoothstep(1.5, 1.35, Math.abs(w));
      c = c.map((x) => x * (1 - 0.1 * tongue)) as V3;
      const edgeStitch = gauss(Math.abs(w) - 1.62, 0.04) * (Math.abs(((along / 0.0035) % 1) - 0.5) < 0.25 ? 1 : 0.3);
      c = c.map((x) => x * (1 - 0.25 * edgeStitch)) as V3;
      const eyelet = smoothstep(0.0024, 0.0018, Math.hypot((((s % 1) + 1) % 1 - 0.5) * PERIOD, (Math.abs(w) - 1.15) * 0.012));
      c = c.map((x) => mix(x, 0.16, eyelet * detail)) as V3;
      metal = mix(metal, 0.85, eyelet);
      rough = mix(rough, 0.35, eyelet);
      const lace = mix(0.35 * smoothstep(1.2, 1.1, Math.abs(w)), this.laces(w, s), detail);
      const laceColor = srgb(48, 36, 28);
      c = c.map((x, k) => mix(x, laceColor[k]! * (1 + 0.15 * noise3(along / 0.002, w * 3, 4)), lace)) as V3;
      rough = mix(rough, 0.75, lace);
    }
    // The padded collar at the top.
    const collar = smoothstep(BOOT.top - 0.014, BOOT.top - 0.008, p[1]);
    c = c.map((x) => x * (1 - 0.15 * collar)) as V3;
    out.color = c;
    out.rough = clamp01(rough);
    out.metal = metal;
  }

  /** The laces' cover at (across, eyelet rows): each crosses from one row's eyelet to the other row's next. */
  private laces(w: number, s: number): number {
    if (Math.abs(w) > 1.2) return 0;
    const f = (w + 1.15) / 2.3;
    const crossA = Math.abs((((s - f) % 1) + 1) % 1 - 0.5);
    const crossB = Math.abs((((s - (1 - f)) % 1) + 1) % 1 - 0.5);
    // Distances from the two lines, in rows: on a line the wrapped offset is half a row.
    return Math.max(smoothstep(0.16, 0.09, 0.5 - crossA), smoothstep(0.16, 0.09, 0.5 - crossB)) * smoothstep(1.2, 1.1, Math.abs(w));
  }

  private bootHeight(p: V3, n: V3, ts: number): number {
    const { toe, soleTop } = this.bootFrame(p);
    let h = 0;
    if (p[1] < soleTop + 0.0045) {
      // The tread underneath, the sole's edge ribbed.
      if (n[1] < -0.6) h += 0.0012 * smoothstep(0.35, 0.5, cellular(p[0] / 0.009, 0, p[2] / 0.009));
      else h += 0.00025 * Math.sin(p[1] / 0.003 * Math.PI * 2);
      h -= 0.0003 * gauss(p[1] - (soleTop + 0.0022), 0.0006);
      return h;
    }
    // Leather grain.
    if (ts < 0.0012) h -= 0.00004 * smoothstep(0.1, 0.4, cellular(p[0] / 0.0011, p[1] / 0.0011, p[2] / 0.0011));
    h += 0.00003 * fbm(p[0], p[1], p[2], 0.004, 2, ts);
    // Creases across the toes' flex, on top.
    const flex = gauss(p[0] - (toe.x - 0.075), 0.015) * smoothstep(0.3, 0.7, n[1]);
    h += flex * 0.0005 * Math.sin((p[0] + 0.3 * Math.abs(p[2] - toe.z)) / 0.007 * Math.PI * 2 + 2 * noise3(p[2] / 0.01, p[0] / 0.01, 2));
    // The vamp's stitched seam round the toe cap.
    const capLine = Math.abs(Math.hypot((p[0] - (toe.x - 0.03)) * 0.9, (p[2] - toe.z) * 1.3) - 0.05);
    h -= 0.00025 * gauss(capLine, 0.0007);
    const lacing = this.lacing(p, n);
    if (lacing) {
      // The laces stand proud, the quarters' edges step down onto the tongue.
      h += 0.0011 * this.laces(lacing.w, lacing.along / 0.014);
      h += 0.0005 * smoothstep(1.35, 1.5, Math.abs(lacing.w));
    }
    return h;
  }

  // ---------- trousers

  private legFrame(p: V3) {
    const side = p[2] < 0 ? 0 : 1;
    const hip = this.hips[side]!;
    const angle = Math.atan2((p[2] - hip[2]) * Math.sign(hip[2]), p[0]);
    return { side, angle };
  }

  private trousers(p: V3, n: V3, ts: number, out: Shade): void {
    const base = srgb(150, 137, 112);
    const heather = fbm(p[0], p[1], p[2], 0.003, 3, ts);
    const tone = fbm(p[0], p[1], p[2], 0.08, 2, ts);
    let c: V3 = base.map((x) => x * (1 + 0.04 * heather + 0.04 * tone)) as V3;
    const { angle } = this.legFrame(p);
    // The outer seam and the inseam: darker lines.
    const seam = Math.max(gauss(Math.abs(angle) - Math.PI / 2, 0.025), gauss(Math.abs(angle) - Math.PI / 2 - 0.0, 0.025) * 0) * (p[1] < 0.95 ? 1 : 0);
    const inseam = gauss(Math.PI - Math.abs(angle) - Math.PI / 2, 0.03) * 0;
    const lines = Math.max(seam, inseam);
    c = c.map((x) => x * (1 - 0.08 * lines)) as V3;
    // A little lighter where it wears: the knees.
    const knee = gauss(p[1] - 0.5, 0.05) * smoothstep(0.2, 0.8, n[0]);
    c = c.map((x) => x * (1 + 0.04 * knee)) as V3;
    out.color = c;
    out.rough = 0.86 + 0.04 * heather;
    out.metal = 0;
  }

  private trousersHeight(p: V3, ts: number): number {
    let h = 0.00004 * fbm(p[0], p[1], p[2], 0.0018, 2, ts);
    // Twill: fine diagonal ribs where the texels are small enough to hold them.
    if (ts < 0.0006) h += 0.000025 * Math.sin((p[1] + p[0] * 0.7 + p[2] * 0.7) / 0.0011 * Math.PI * 2);
    const { angle } = this.legFrame(p);
    // The side seam: a raised ridge with stitching beside it.
    if (p[1] < 0.95) {
      const off = Math.abs(angle) - Math.PI / 2;
      h += 0.0004 * gauss(off, 0.012) - 0.00015 * gauss(off - 0.035, 0.006) * (Math.sin(p[1] / 0.0035 * Math.PI * 2) > 0 ? 1 : 0);
    }
    // Folds: behind the knee, and the break over the boots.
    const behindKnee = gauss(p[1] - 0.47, 0.035) * smoothstep(0.3, 1.2, Math.abs(angle));
    h += behindKnee * 0.0013 * fold((p[1] + angle * 0.008) / 0.02, angle * 1.4, 3);
    const crook = gauss(p[1] - 0.47, 0.04) * smoothstep(1.2, 0.3, Math.abs(angle));
    h += crook * 0.0006 * fold(p[1] / 0.03, angle * 2, 5);
    const brk = smoothstep(0.2, 0.11, p[1]);
    h += brk * 0.002 * fold((p[1] + angle * 0.012) / 0.024, angle * 1.1, 9);
    // Long soft drape folds down the shin.
    h += 0.0006 * noise3(angle * 2.5, p[1] / 0.12, 4) * smoothstep(0.55, 0.3, p[1]);
    return h;
  }

  // ---------- jacket

  private armFrame(p: V3) {
    const side = p[2] < 0 ? 0 : 1;
    const sh = this.shoulders[side]!;
    const el = this.elbows[side]!;
    const wr = this.wrists[side]!;
    const sign = side === 0 ? -1 : 1;
    // Along the arm from the shoulder (metres), and the angle round it (0 forward, + up and out).
    const upper = Math.hypot(el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]);
    const dirU: V3 = [(el[0] - sh[0]) / upper, (el[1] - sh[1]) / upper, (el[2] - sh[2]) / upper];
    const fore = Math.hypot(wr[0] - el[0], wr[1] - el[1], wr[2] - el[2]);
    const dirF: V3 = [(wr[0] - el[0]) / fore, (wr[1] - el[1]) / fore, (wr[2] - el[2]) / fore];
    const tU = (p[0] - sh[0]) * dirU[0] + (p[1] - sh[1]) * dirU[1] + (p[2] - sh[2]) * dirU[2];
    const onFore = tU > upper;
    const origin = onFore ? el : sh;
    const dir = onFore ? dirF : dirU;
    const t = (p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1] + (p[2] - origin[2]) * dir[2];
    const along = onFore ? upper + t : tU;
    const r: V3 = [p[0] - origin[0] - dir[0] * t, p[1] - origin[1] - dir[1] * t, p[2] - origin[2] - dir[2] * t];
    // In the plane square to the arm: forward is +X; out is the side's.
    const angle = Math.atan2(r[2] * sign - r[1] * 0.2, r[0]);
    return { side, along, angle, length: upper + fore };
  }

  private isSleeve(p: V3): boolean {
    const side = p[2] < 0 ? 0 : 1;
    const sh = this.shoulders[side]!;
    // Out past the armhole seam, or below the armpit and outside the torso.
    return Math.abs(p[2]) > Math.abs(sh[2]) + 0.02 - Math.max(0, sh[1] - p[1]) * 0.15 && p[1] < sh[1] + 0.03;
  }

  private jacket(p: V3, n: V3, ts: number, out: Shade): void {
    const base = srgb(84, 92, 78);
    const heather = fbm(p[0], p[1], p[2], 0.002, 3, ts);
    const tone = fbm(p[0], p[1], p[2], 0.1, 2, ts);
    let c: V3 = base.map((x) => x * (1 + 0.035 * heather + 0.03 * tone)) as V3;
    let rough = 0.74 + 0.03 * heather;
    let metal = 0;
    const m = this.marks;
    const front = p[0] > 0.0;
    // The zip up the middle of the front: tape, teeth, and the pull at the collar's top.
    if (front && Math.abs(p[2]) < 0.008 && p[1] < m.collarTop + 0.01) {
      const tape = smoothstep(0.0075, 0.006, Math.abs(p[2]));
      const zip = srgb(40, 42, 40);
      c = c.map((x, k) => mix(x, zip[k]!, tape)) as V3;
      rough = mix(rough, 0.45, tape);
      const pull = smoothstep(0.012, 0.009, Math.abs(p[1] - (m.collarTop - 0.016))) * smoothstep(0.0055, 0.004, Math.abs(p[2]));
      c = c.map((x) => mix(x, 0.12, pull)) as V3;
      metal = mix(metal, 0.9, pull);
      rough = mix(rough, 0.3, pull);
    }
    // The chest pocket's zip, on the left.
    if (front && p[2] < 0) {
      const pocket = gauss(p[2] + 0.075 + (p[1] - 1.3) * 0.12, 0.0018) * smoothstep(1.2, 1.215, p[1]) * smoothstep(1.37, 1.355, p[1]);
      c = c.map((x) => x * (1 - 0.55 * pocket)) as V3;
    }
    // Bindings: the hem and the cuffs, a darker band.
    const hem = smoothstep(OUTFIT.jacketHem + 0.016, OUTFIT.jacketHem + 0.01, p[1]) * (this.isSleeve(p) ? 0 : 1);
    const arm = this.armFrame(p);
    const cuff = this.isSleeve(p) ? smoothstep(arm.length - 0.04, arm.length - 0.03, arm.along) : 0;
    const binding = Math.max(hem, cuff);
    c = c.map((x) => x * (1 - 0.18 * binding)) as V3;
    // Seams: darker hairlines.
    c = c.map((x) => x * (1 - 0.1 * this.jacketSeams(p))) as V3;
    out.color = c;
    out.rough = clamp01(rough);
    out.metal = metal;
  }

  private jacketSeams(p: V3): number {
    let s = 0;
    const side = p[2] < 0 ? 0 : 1;
    const sh = this.shoulders[side]!;
    // The shoulder seam, along the top of the shoulder.
    if (p[1] > sh[1] - 0.02 && !this.isSleeve(p)) s = Math.max(s, gauss(p[0] - (sh[0] + 0.012), 0.0015));
    // The armhole, round the shoulder joint.
    const armhole = Math.hypot(p[0] - sh[0], (p[1] - sh[1]) * 0.85, p[2] - sh[2] * 0.82);
    if (p[1] > sh[1] - 0.12) s = Math.max(s, gauss(armhole - 0.075, 0.0015));
    // The side seams under the arms.
    if (p[1] < sh[1] - 0.1 && !this.isSleeve(p)) s = Math.max(s, gauss(p[0] - (-0.005 + (p[1] - 1.1) * 0.05), 0.0018) * smoothstep(0.08, 0.12, Math.abs(p[2])));
    // The sleeve's underside seam.
    if (this.isSleeve(p)) {
      const { angle } = this.armFrame(p);
      s = Math.max(s, gauss(Math.abs(angle) - 2.6, 0.03));
    }
    // Stitching beside the zip.
    if (p[0] > 0 && Math.abs(p[2]) < 0.02) s = Math.max(s, gauss(Math.abs(p[2]) - 0.0125, 0.0006) * 0.6);
    return s;
  }

  private jacketHeight(p: V3, n: V3, ts: number): number {
    let h = 0.000025 * fbm(p[0], p[1], p[2], 0.0012, 2, ts);
    // Seams: a ridge.
    h += 0.00035 * this.jacketSeams(p);
    const m = this.marks;
    // The zip's teeth.
    if (p[0] > 0 && Math.abs(p[2]) < 0.0045 && p[1] < m.collarTop + 0.005) {
      const offset = p[2] > 0 ? 0.5 : 0;
      h += 0.0006 * smoothstep(0.0045, 0.0032, Math.abs(p[2])) * (((p[1] / 0.0042 + offset) % 1 + 1) % 1 < 0.5 ? 1 : 0.3);
    }
    if (this.isSleeve(p)) {
      const { along, angle, length } = this.armFrame(p);
      const sh = this.shoulders[p[2] < 0 ? 0 : 1]!;
      const upper = Math.hypot(this.elbows[0]![0] - sh[0], this.elbows[0]![1] - sh[1], this.elbows[0]![2] - sh[2]);
      // The crook of the elbow: folds round the inside.
      const crook = gauss(along - upper, 0.035) * smoothstep(1.4, 0.2, Math.abs(angle));
      h += crook * 0.0015 * fold((along + angle * 0.006) / 0.018, angle * 1.5, 1);
      // Bunching over the forearm toward the cuff.
      const bunch = smoothstep(length - 0.17, length - 0.06, along) * smoothstep(length - 0.025, length - 0.045, along);
      h += bunch * 0.0013 * fold((along + angle * 0.012) / 0.022, angle * 1.2, 2);
      // Soft drag folds down the upper arm.
      h += 0.0005 * noise3(angle * 2, along / 0.08, 6);
    } else {
      // Drag folds from under the arms, and soft bunching over the hem.
      const side = p[2] < 0 ? 0 : 1;
      const sh = this.shoulders[side]!;
      const fromPit = Math.hypot(p[1] - (sh[1] - 0.1), Math.abs(p[2]) - Math.abs(sh[2]) + 0.04);
      h += 0.0008 * gauss(fromPit, 0.06) * fold((p[1] + Math.abs(p[2]) * 0.8) / 0.035, p[0] / 0.05, 3);
      const aboveHem = gauss(p[1] - (OUTFIT.jacketHem + 0.07), 0.04);
      h += aboveHem * 0.0008 * fold(Math.atan2(p[2], p[0]) * 4, p[1] / 0.07, 8);
      h += 0.0004 * noise3(p[0] / 0.08, p[1] / 0.12, p[2] / 0.08);
    }
    // The bindings' edge: a step.
    h -= 0.0003 * smoothstep(OUTFIT.jacketHem + 0.017, OUTFIT.jacketHem + 0.015, p[1]) * (this.isSleeve(p) ? 0 : 1);
    void n;
    return h;
  }

  // ---------- hair

  private flow(p: V3, n: V3): V3 {
    // From the crown out and down, combed a little forward at the front.
    const crown: V3 = [-0.015, 1.77, 0];
    const d: V3 = [p[0] - crown[0] + 0.02, p[1] - crown[1], p[2] - crown[2]];
    const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    const t: V3 = [d[0] - n[0] * dn, d[1] - n[1] * dn, d[2] - n[2] * dn];
    const l = Math.hypot(t[0], t[1], t[2]) || 1;
    return [t[0] / l, t[1] / l, t[2] / l];
  }

  private strands(p: V3, n: V3): number {
    const d = this.flow(p, n);
    const across: V3 = [n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]];
    const a = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
    const b = p[0] * across[0] + p[1] * across[1] + p[2] * across[2];
    return 0.6 * noise3(a / 0.01, b / 0.0006, 0) + 0.4 * noise3(a / 0.004, b / 0.00025, 5);
  }

  /** The skin under the hair, where the cut thins out over it. */
  private readonly underHair: Shade = { color: [0, 0, 0], rough: 0, metal: 0 };

  /** The hair's colour and roughness, wherever it grows: strands combed from the crown. */
  private hairLook(p: V3, n: V3, ts: number): { color: V3; rough: number } {
    const base = srgb(46, 35, 27);
    const s = this.strands(p, n);
    const tone = fbm(p[0], p[1], p[2], 0.03, 2, ts);
    return { color: base.map((x) => x * (1 + 0.45 * s + 0.1 * tone)) as V3, rough: 0.48 + 0.1 * s };
  }

  private hair(p: V3, n: V3, ts: number, out: Shade): void {
    // At the shell's edge exactly the skin's own shade (its painted hairline included), so the shell meets the
    // skin's faces with no seam; all the hair's own look only where the cut is thick.
    const density = smoothstep(HAIR_SHELL_FROM, 0.95, this.marks.hair(p));
    this.skin(p, n, ts, this.underHair);
    const look = this.hairLook(p, n, ts);
    out.color = look.color.map((x, k) => mix(this.underHair.color[k]!, x, density)) as V3;
    out.rough = mix(this.underHair.rough, look.rough, density);
    out.metal = 0;
  }

  private hairHeight(p: V3, n: V3, ts: number): number {
    const hair = this.marks.hair(p);
    return mix(this.skinHeight(p, n, ts), 0.00025 * this.strands(p, n), smoothstep(HAIR_SHELL_FROM, 0.95, hair));
  }
}
