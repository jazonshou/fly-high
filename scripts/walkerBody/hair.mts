/**
 * The walker's hair: where it grows (`hairAmount`), how long the cut leaves
 * it and which way it is combed (`design.mts`'s `LOOK.hair`), and the mesh.
 *
 * The mesh is the scalp's own faces where the hair is thick, divided finer,
 * cut along the hairline and lifted off the skin by the cut's length: the
 * full length within a centimetre or so of the hairline, so the hair has a
 * body and an edge (a cap that climbed over four centimetres read as paint on
 * a bald head), then pushed into locks along the combing. Its outline is what tells a head
 * of hair from a helmet, so the locks are in the mesh, not only in the
 * normal map. It keeps the scalp's UVs and skin weights.
 *
 * The thin edge of the cut is painted on the skin (the texture bake's
 * hairline), so the mesh rises from where both already show the same hair.
 */
import { BIND_POSITIONS, BONE } from "../../src/render/webgpu/person/skeleton";
import type { FittedBody } from "./body.mts";
import { LOOK } from "./design.mts";
import { noise3 } from "./noise.mts";
import { vertexOf, type Part } from "./parts.mts";
import type { V3 } from "./math.mts";

const bind = (bone: number): V3 => [BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!];
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** The hair's mesh covers the scalp wherever it carries more hair than this (`Hair.amount`). */
export const HAIR_SHELL_FROM = 0.3;

export interface Hair {
  /** How much hair a point on the head carries, 0 to 1. */
  readonly amount: (q: V3) => number;
  /** How long the cut leaves it there, metres, given the scalp's normal. */
  readonly length: (q: V3, n: V3) => number;
  /**
   * Noise drawn out along the combing, about -1 to 1: streaks `long` metres
   * long and `wide` across. On top the hair lies one way (back from the
   * forehead and across); on the sides and the back it lies down the head.
   */
  readonly grain: (q: V3, n: V3, long: number, wide: number, seed: number) => number;
  /** How grey it has gone there, 0 to 1 (the share of its strands). */
  readonly grey: (q: V3) => number;
}

/**
 * The cut: a man's short crop, longer on top and pushed up off the forehead
 * and across to his right, the sides and the nape tapered short; the hairline
 * across the top of the forehead and gone back at the temples (he is about
 * forty), sideburns down to the middle of the ear, round above the ears and
 * down to the nape.
 */
export function hairOf(body: FittedBody): Hair {
  const P = body.positions;
  const eyes = ["helper-l-eye", "helper-r-eye"].map((g) => {
    const seen = new Set<number>();
    for (const f of body.faces) if (f.group === g) for (const v of f.vertices) seen.add(v);
    const c: V3 = [0, 0, 0];
    for (const v of seen) for (let a = 0; a < 3; a += 1) c[a]! += P[v * 3 + a]! / seen.size;
    return c;
  });
  const eyeY = (eyes[0]![1] + eyes[1]![1]) / 2;
  const eyeX = (eyes[0]![0] + eyes[1]![0]) / 2;
  // The head's vertical axis, over the ears.
  const cx = eyeX - 0.095;
  const heightAt = (azimuth: number) => {
    const line = LOOK.hair.line;
    const a = Math.min(180, Math.abs(azimuth));
    for (let k = 1; k < line.length; k += 1) {
      if (a <= line[k]![0]) {
        const [a0, h0] = line[k - 1]!;
        const [a1, h1] = line[k]!;
        const t = (a - a0) / (a1 - a0);
        return h0 + (h1 - h0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      }
    }
    return line[line.length - 1]![1];
  };
  const headBone = bind(BONE.head);
  // How far out from the axis the skull's side stands just over the ears: the ears stand out past it.
  let skull = 0;
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    for (const v of f.vertices) {
      const y = P[v * 3 + 1]!;
      if (y < eyeY + 0.03 || y > eyeY + 0.055) continue;
      const azimuth = (Math.atan2(Math.abs(P[v * 3 + 2]!), P[v * 3]! - cx) * 180) / Math.PI;
      if (azimuth > 72 && azimuth < 104) skull = Math.max(skull, Math.hypot(P[v * 3]! - cx, P[v * 3 + 2]!));
    }
  }
  const amount = (q: V3): number => {
    if (q[1] < headBone[1] - 0.06) return 0;
    const azimuth = (Math.atan2(Math.abs(q[2]), q[0] - cx) * 180) / Math.PI;
    // The ear itself carries none: it stands off the skull's side.
    const out = Math.hypot(q[0] - cx, q[2]);
    const ear = smoothstep(64, 70, azimuth) * smoothstep(112, 104, azimuth) * smoothstep(skull + 0.0005, skull + 0.0025, out) * smoothstep(eyeY + 0.026, eyeY + 0.018, q[1]) * smoothstep(eyeY - 0.056, eyeY - 0.046, q[1]);
    // The line is not ruled: it wanders a millimetre or two, and one side sits a little higher than the other.
    const wander = 0.0022 * noise3(q[2] / 0.011, q[0] / 0.011, 7.3) + 0.0012 * Math.sign(q[2]) * smoothstep(0, 40, azimuth) * smoothstep(70, 40, azimuth);
    const h = eyeY + heightAt(azimuth) + wander;
    return smoothstep(h - 0.002, h + 0.012, q[1]) * (1 - ear);
  };
  const cut = LOOK.hair;
  // How far a point of the scalp is on the head's top (1) rather than its sides (0).
  const top = (n: V3) => smoothstep(-0.05, 0.9, n[1]);
  const length = (q: V3, n: V3): number => {
    const t = top(n);
    // The sides taper from the top's edge down to the sideburns and the nape.
    const low = smoothstep(eyeY + 0.045, eyeY - 0.035, q[1]);
    const sides = mix(cut.sides, cut.nape, low);
    // On top: longest at the front, where it is pushed up, shorter back to the crown.
    const front = smoothstep(cx - 0.02, cx + 0.085, q[0]);
    const onTop = mix(cut.crown, cut.front, front);
    // Combed across: it piles a little higher on the side it is pushed to.
    const across = 1 + cut.pile * Math.max(-1, Math.min(1, q[2] / 0.06)) * t;
    return mix(sides, onTop * across, t * t);
  };
  // On top the hair lies one way everywhere, so its streaks are straight lines in one frame; on the sides
  // they run down the head, in a frame wrapped round it. (Streaks drawn along a direction that turns from
  // place to place curl into wood grain.)
  const l = Math.hypot(1, cut.across);
  const alongTop: V3 = [-1 / l, 0, cut.across / l];
  const acrossTop: V3 = [cut.across / l, 0, 1 / l];
  const grain = (q: V3, n: V3, long: number, wide: number, seed: number): number => {
    const t = smoothstep(0.35, 0.8, n[1]);
    const a1 = q[0] * alongTop[0] + q[2] * alongTop[2] + 0.35 * q[1];
    const b1 = q[0] * acrossTop[0] + q[2] * acrossTop[2];
    const onTop = t > 0 ? noise3(a1 / long, b1 / wide, seed) : 0;
    const onSides = t < 1 ? noise3(q[1] / long + 9, (Math.atan2(q[2], q[0] - cx) * 0.078) / wide, seed + 3) : 0;
    return mix(onSides, onTop, t);
  };
  const grey = (q: V3): number => {
    // The temples first, in front of and over the ears.
    const temple = Math.exp(-(((q[0] - (cx + 0.045)) / 0.04) ** 2) - ((q[1] - (eyeY + 0.03)) / 0.035) ** 2) * smoothstep(0.045, 0.065, Math.abs(q[2]));
    return Math.min(1, cut.grey + cut.greyTemples * temple);
  };
  return { amount, length, grain, grey };
}

/** The locks the hair gathers into, as a share of its length (about -0.5 to 0.5): ridges along the combing. */
export function locks(hair: Hair, q: V3, n: V3): number {
  const ridge = 1 - Math.abs(hair.grain(q, n, 0.06, 0.014, 2.7));
  return 0.75 * (ridge * ridge - 0.45) + 0.3 * noise3(q[0] / 0.03, q[1] / 0.03, q[2] / 0.03);
}

interface Mesh {
  /** Scalp positions and normals per vertex. */
  positions: number[];
  normals: number[];
  bones: number[];
  weights: number[];
  faces: number[][];
  faceUvs: number[][];
}

/** A new vertex of `out`, every attribute the weighted mean of `mesh`'s `sources` (vertex, share). */
function blended(mesh: Mesh, out: Mesh, sources: readonly (readonly [number, number])[]): number {
  const index = out.positions.length / 3;
  for (let a = 0; a < 3; a += 1) out.positions.push(sources.reduce((s, [v, w]) => s + mesh.positions[v * 3 + a]! * w, 0));
  const n: V3 = [0, 0, 0];
  for (const [v, w] of sources) for (let a = 0; a < 3; a += 1) n[a]! += mesh.normals[v * 3 + a]! * w;
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  out.normals.push(n[0] / l, n[1] / l, n[2] / l);
  const share = new Map<number, number>();
  for (const [v, w] of sources) for (let k = 0; k < 4; k += 1) share.set(mesh.bones[v * 4 + k]!, (share.get(mesh.bones[v * 4 + k]!) ?? 0) + mesh.weights[v * 4 + k]! * w);
  const heaviest = [...share.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const total = heaviest.reduce((s, [, w]) => s + w, 0);
  for (let k = 0; k < 4; k += 1) {
    out.bones.push(heaviest[k]?.[0] ?? 0);
    out.weights.push(heaviest[k] ? heaviest[k]![1] / total : 0);
  }
  return index;
}

/** Each face into four: a vertex at every edge's middle (and a quad's own), every attribute averaged. */
function subdivide(mesh: Mesh): Mesh {
  const out: Mesh = { positions: [...mesh.positions], normals: [...mesh.normals], bones: [...mesh.bones], weights: [...mesh.weights], faces: [], faceUvs: [] };
  const blend = (sources: readonly number[]): number => blended(mesh, out, sources.map((v) => [v, 1 / sources.length] as const));
  const middles = new Map<string, number>();
  const middle = (a: number, b: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let m = middles.get(key);
    if (m === undefined) middles.set(key, (m = blend([a, b])));
    return m;
  };
  mesh.faces.forEach((face, f) => {
    const uv = mesh.faceUvs[f]!;
    const count = face.length;
    const corner = (k: number): [number, number] => [uv[(k % count) * 2]!, uv[(k % count) * 2 + 1]!];
    const half = (k: number): [number, number] => [(corner(k)[0] + corner(k + 1)[0]) / 2, (corner(k)[1] + corner(k + 1)[1]) / 2];
    const mids = face.map((v, k) => middle(v, face[(k + 1) % count]!));
    if (count === 4) {
      const centre = blend(face);
      const centreUv: [number, number] = [(uv[0]! + uv[2]! + uv[4]! + uv[6]!) / 4, (uv[1]! + uv[3]! + uv[5]! + uv[7]!) / 4];
      for (let k = 0; k < 4; k += 1) {
        out.faces.push([face[k]!, mids[k]!, centre, mids[(k + 3) % 4]!]);
        out.faceUvs.push([...corner(k), ...half(k), ...centreUv, ...half(k + 3)]);
      }
    } else {
      for (let k = 0; k < 3; k += 1) {
        out.faces.push([face[k]!, mids[k]!, mids[(k + 2) % 3]!]);
        out.faceUvs.push([...corner(k), ...half(k), ...half(k + 2)]);
      }
      out.faces.push([mids[0]!, mids[1]!, mids[2]!]);
      out.faceUvs.push([...half(0), ...half(1), ...half(2)]);
    }
  });
  return out;
}

/**
 * The part of the mesh where `value` (per vertex) is over `level`: faces the
 * line crosses are cut along it, so the mesh's edge is the line itself and
 * not the faces' stepped outline.
 */
function cutAlong(mesh: Mesh, value: (v: number) => number, level: number): Mesh {
  const out: Mesh = { positions: [], normals: [], bones: [], weights: [], faces: [], faceUvs: [] };
  const kept = new Map<number, number>();
  const keep = (v: number): number => {
    let i = kept.get(v);
    if (i === undefined) kept.set(v, (i = blended(mesh, out, [[v, 1]])));
    return i;
  };
  const crossings = new Map<string, number>();
  const crossing = (a: number, b: number, t: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let i = crossings.get(key);
    if (i === undefined) crossings.set(key, (i = blended(mesh, out, [[a, 1 - t], [b, t]])));
    return i;
  };
  mesh.faces.forEach((face, f) => {
    const uv = mesh.faceUvs[f]!;
    const values = face.map(value);
    if (values.every((x) => x <= level)) return;
    const polygon: number[] = [];
    const polygonUvs: number[] = [];
    for (let k = 0; k < face.length; k += 1) {
      const j = (k + 1) % face.length;
      const inside = values[k]! > level;
      if (inside) {
        polygon.push(keep(face[k]!));
        polygonUvs.push(uv[k * 2]!, uv[k * 2 + 1]!);
      }
      if (inside !== values[j]! > level) {
        const t = (level - values[k]!) / (values[j]! - values[k]!);
        polygon.push(crossing(face[k]!, face[j]!, t));
        polygonUvs.push(uv[k * 2]! + (uv[j * 2]! - uv[k * 2]!) * t, uv[k * 2 + 1]! + (uv[j * 2 + 1]! - uv[k * 2 + 1]!) * t);
      }
    }
    if (polygon.length < 3) return;
    out.faces.push(polygon);
    out.faceUvs.push(polygonUvs);
  });
  return out;
}

/**
 * The hair's mesh, from the body's faces (`faces`, with their corner UVs) and
 * the skin's vertex normals.
 */
export function buildHair(body: FittedBody, faces: readonly number[][], faceUvs: readonly number[][], N: Float64Array): { part: Part; report: string } {
  const hair = hairOf(body);
  const P = body.positions;
  const W = body.weights;
  // The scalp's faces that carry hair, on their own vertices.
  const index = new Map<number, number>();
  let mesh: Mesh = { positions: [], normals: [], bones: [], weights: [], faces: [], faceUvs: [] };
  faces.forEach((face, f) => {
    if (!face.some((v) => hair.amount(vertexOf(P, v)) > HAIR_SHELL_FROM)) return;
    mesh.faces.push(
      face.map((v) => {
        let i = index.get(v);
        if (i === undefined) {
          i = mesh.positions.length / 3;
          index.set(v, i);
          mesh.positions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
          mesh.normals.push(N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!);
          for (let k = 0; k < 4; k += 1) {
            mesh.bones.push(W.bones[v * 4 + k]!);
            mesh.weights.push(W.weights[v * 4 + k]!);
          }
        }
        return i;
      }),
    );
    mesh.faceUvs.push([...faceUvs[f]!]);
  });
  for (let level = 0; level < LOOK.hair.subdivisions; level += 1) mesh = subdivide(mesh);
  // Cut along the hairline, so the mesh ends on its smooth curve.
  {
    const whole = mesh;
    mesh = cutAlong(whole, (v) => hair.amount(vertexOf(whole.positions, v)), HAIR_SHELL_FROM);
  }
  const count = mesh.positions.length / 3;
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  const onEdge = new Uint8Array(count);
  const edgeUse = new Map<string, number>();
  for (const face of mesh.faces)
    for (let k = 0; k < face.length; k += 1) {
      const a = face[k]!;
      const b = face[(k + 1) % face.length]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  for (const [key, uses] of edgeUse) {
    const [a, b] = key.split(",").map(Number) as [number, number];
    neighbours[a]!.push(b);
    neighbours[b]!.push(a);
    if (uses === 1) onEdge[a] = onEdge[b] = 1;
  }

  // Lifted by the cut's length where the hair is thick, gathered into locks; flat on the skin (which is
  // painted as hair there) along its edge.
  const lift = new Float64Array(count);
  for (let v = 0; v < count; v += 1) {
    if (onEdge[v]) {
      lift[v] = 0.0005;
      continue;
    }
    const q = vertexOf(mesh.positions, v);
    const n = vertexOf(mesh.normals, v);
    const rise = Math.pow(smoothstep(HAIR_SHELL_FROM, 1, hair.amount(q)), LOOK.hair.rise);
    const long = hair.length(q, n);
    lift[v] = 0.0005 + rise * long * (1 + LOOK.hair.locks * locks(hair, q, n));
  }
  // Once smoothed over its neighbours, so no single vertex stands out as a spike.
  const smoothed = Float64Array.from(lift);
  for (let v = 0; v < count; v += 1) {
    if (onEdge[v] || neighbours[v]!.length === 0) continue;
    smoothed[v] = 0.6 * lift[v]! + (0.4 * neighbours[v]!.reduce((s, w) => s + lift[w]!, 0)) / neighbours[v]!.length;
  }
  const positions = new Array<number>(count * 3);
  let tallest = 0;
  for (let v = 0; v < count; v += 1) {
    for (let a = 0; a < 3; a += 1) positions[v * 3 + a] = mesh.positions[v * 3 + a]! + mesh.normals[v * 3 + a]! * smoothed[v]!;
    tallest = Math.max(tallest, positions[v * 3 + 1]!);
  }
  return {
    part: { name: "hair", kind: "hair", positions, bones: mesh.bones, weights: mesh.weights, faces: mesh.faces, faceUvs: mesh.faceUvs },
    report: `hair: ${mesh.faces.length} faces, up to ${(Math.max(...smoothed) * 1000).toFixed(0)} mm long, its top at ${tallest.toFixed(3)} m`,
  };
}
