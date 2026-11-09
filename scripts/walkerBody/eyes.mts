/**
 * The eyes: MakeHuman's high-poly eyeballs (CC0), fitted into the sockets the
 * way MakeHuman fits its proxies (each vertex three base-mesh vertices'
 * weighted sum plus an offset scaled by the head's size, `.mhclo`), then
 * carried onto the walker with the head. They ride the head bone.
 *
 * Their UVs are new: each eye's surface seen from straight ahead, the angle
 * from its front mapped out from the eye square's middle (as the square root,
 * so the iris and pupil take a large share of the texels), both eyes on the
 * same square and painted alike. The back halves, inside the head, are left
 * out.
 */
import { BONE } from "../../src/render/webgpu/person/skeleton";
import type { FittedBody } from "./body.mts";
import type { Part } from "./parts.mts";
import type { V3 } from "./math.mts";
import { parseMhclo, parseObj, type SOURCE_FILES } from "./sources.mts";
import { EYE_RECT } from "./swatches.mts";

type Read = (path: (typeof SOURCE_FILES)[number]) => string;

export interface EyeFit {
  /** The eyeball's middle, and its half-sizes along each axis (the fitting scales it a little unevenly). */
  readonly center: V3;
  readonly axes: V3;
}

export function buildEyes(body: FittedBody, read: Read): { part: Part; fits: EyeFit[] } {
  const obj = parseObj(read("makehuman/data/eyes/high-poly/high-poly.obj"));
  const fit = parseMhclo(read("makehuman/data/eyes/high-poly/high-poly.mhclo"));
  const mh = body.mh;
  const count = obj.positions.length / 3;
  if (fit.refs.length !== count) throw new Error(`walker body: the eyes' fitting has ${fit.refs.length} vertices, the mesh ${count}`);
  // The offsets' scale along each of MakeHuman's axes: a span of the head now over the span the proxy was made on.
  const scale = fit.scale.map(([a, b, den], axis) => Math.abs(mh[a! * 3 + axis]! - mh[b! * 3 + axis]!) / den!);
  const positions: number[] = [];
  for (let v = 0; v < count; v += 1) {
    const q: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k += 1) {
      const r = fit.refs[v]![k]!;
      const w = fit.weights[v]![k]!;
      for (let a = 0; a < 3; a += 1) q[a]! += mh[r * 3 + a]! * w;
    }
    for (let a = 0; a < 3; a += 1) q[a]! += fit.offsets[v]![a]! * scale[a]!;
    positions.push(...body.headPoint(q));
  }
  const bones: number[] = [];
  const weights: number[] = [];
  for (let v = 0; v < count; v += 1) {
    bones.push(BONE.head, 0, 0, 0);
    weights.push(1, 0, 0, 0);
  }
  // Each eye's box: its middle and half-sizes.
  const fits: EyeFit[] = [-1, 1].map((sign) => {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v += 1) {
      if (Math.sign(positions[v * 3 + 2]!) !== sign) continue;
      for (let a = 0; a < 3; a += 1) {
        lo[a] = Math.min(lo[a]!, positions[v * 3 + a]!);
        hi[a] = Math.max(hi[a]!, positions[v * 3 + a]!);
      }
    }
    return { center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], axes: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
  });
  // Per vertex: the angle from the eye's front, and round it.
  const angle = new Float64Array(count);
  const uv = new Float64Array(count * 2);
  const cu = (EYE_RECT.u0 + EYE_RECT.u1) / 2;
  const cv = (EYE_RECT.v0 + EYE_RECT.v1) / 2;
  for (let v = 0; v < count; v += 1) {
    const side = positions[v * 3 + 2]! < 0 ? 0 : 1;
    const { center, axes } = fits[side]!;
    const d = [0, 1, 2].map((a) => (positions[v * 3 + a]! - center[a]!) / axes[a]!) as V3;
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    angle[v] = Math.acos(Math.max(-1, Math.min(1, d[0] / l)));
    // Round the eye: up is +V, and the nose's side is -U on both (mirrored, so they paint alike).
    const around = Math.atan2(d[1], d[2] * (side === 0 ? -1 : 1));
    const r = Math.sqrt(angle[v]! / Math.PI);
    uv[v * 2] = cu + 0.5 * (EYE_RECT.u1 - EYE_RECT.u0) * r * Math.cos(around);
    uv[v * 2 + 1] = cv + 0.5 * (EYE_RECT.v1 - EYE_RECT.v0) * r * Math.sin(around);
  }
  const BACK = 1.9;
  const kept = obj.faces.filter((f) => f.vertices.some((v) => angle[v]! < BACK));
  const faces = kept.map((f) => [...f.vertices]);
  const faceUvs = kept.map((f) => f.vertices.flatMap((v) => [uv[v * 2]!, uv[v * 2 + 1]!]));
  return { part: { name: "eyes", kind: "eyes", positions, bones, weights, faces, faceUvs }, fits };
}
