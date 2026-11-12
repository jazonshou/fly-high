/**
 * Where the face's and hands' features are on the finished figure, for the
 * texture bake to paint them in the right places: the eyes from the fitted
 * eyeballs (`buildEyes`), the mouth and nose from the body, the fingertips and palms from
 * the fitted skeleton, the toes from the boots.
 */
import { SIDES } from "../../src/render/webgpu/person/skeleton";
import type { FittedBody } from "./body.mts";
import { OUTFIT } from "./clothes.mts";
import { hairOf } from "./hair.mts";
import { cross, dot, normalize, scale, sub, type V3 } from "./math.mts";
import type { Part } from "./parts.mts";
import type { EyeFit } from "./eyes.mts";
import type { Landmarks } from "./textures.mts";

/** The iris's radius, metres (11.8 to 12.2 mm across in adults). */
export const IRIS_RADIUS = 0.0061;

export interface LidOpening {
  /** The opening between the lids seen from the front, against the eyeball's middle: its middle across (z), its lower and upper edges there (y), its width. */
  readonly across: number;
  readonly lower: number;
  readonly upper: number;
  readonly width: number;
}

/**
 * The opening between an eye's lids, seen from straight ahead: the part of
 * the eyeball's front no skin stands in front of. Found on a quarter-
 * millimetre grid: the skin's faces drawn onto it nearest-first.
 */
export function lidOpening(body: FittedBody, eye: EyeFit): LidOpening {
  const STEP = 0.00025;
  const HALF_Z = 0.024;
  const HALF_Y = 0.016;
  const nz = Math.round((2 * HALF_Z) / STEP);
  const ny = Math.round((2 * HALF_Y) / STEP);
  const skinFront = new Float32Array(nz * ny).fill(-Infinity);
  const P = body.positions;
  const z0 = eye.center[2] - HALF_Z;
  const y0 = eye.center[1] - HALF_Y;
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    for (let k = 1; k + 1 < f.vertices.length; k += 1) {
      const tri = [f.vertices[0]!, f.vertices[k]!, f.vertices[k + 1]!].map((v) => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]);
      const zs = tri.map((q) => (q[2]! - z0) / STEP);
      const ys = tri.map((q) => (q[1]! - y0) / STEP);
      if (Math.max(...zs) < 0 || Math.min(...zs) > nz || Math.max(...ys) < 0 || Math.min(...ys) > ny) continue;
      const area = (zs[1]! - zs[0]!) * (ys[2]! - ys[0]!) - (zs[2]! - zs[0]!) * (ys[1]! - ys[0]!);
      if (Math.abs(area) < 1e-9) continue;
      for (let j = Math.max(0, Math.floor(Math.min(...ys))); j <= Math.min(ny - 1, Math.ceil(Math.max(...ys))); j += 1)
        for (let i = Math.max(0, Math.floor(Math.min(...zs))); i <= Math.min(nz - 1, Math.ceil(Math.max(...zs))); i += 1) {
          const w0 = ((zs[1]! - (i + 0.5)) * (ys[2]! - (j + 0.5)) - (zs[2]! - (i + 0.5)) * (ys[1]! - (j + 0.5))) / area;
          const w1 = ((zs[2]! - (i + 0.5)) * (ys[0]! - (j + 0.5)) - (zs[0]! - (i + 0.5)) * (ys[2]! - (j + 0.5))) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const x = tri[0]![0]! * w0 + tri[1]![0]! * w1 + tri[2]![0]! * w2;
          if (x > skinFront[j * nz + i]!) skinFront[j * nz + i] = x;
        }
    }
  }
  const open = (i: number, j: number): boolean => {
    const dz = (z0 + (i + 0.5) * STEP - eye.center[2]) / eye.axes[2];
    const dy = (y0 + (j + 0.5) * STEP - eye.center[1]) / eye.axes[1];
    const inside = 1 - dz * dz - dy * dy;
    return inside > 0 && eye.center[0] + eye.axes[0] * Math.sqrt(inside) > skinFront[j * nz + i]!;
  };
  // Its width: the widest row. Its middle across: that row's. Its edges: up and down that middle's column.
  let widest = 0;
  let across = 0;
  for (let j = 0; j < ny; j += 1) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < nz; i += 1) {
      if (!open(i, j)) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first >= 0 && last - first > widest) {
      widest = last - first;
      across = z0 + ((first + last + 1) / 2) * STEP - eye.center[2];
    }
  }
  const column = Math.round((eye.center[2] + across - z0) / STEP - 0.5);
  let lower = Infinity;
  let upper = -Infinity;
  for (let j = 0; j < ny; j += 1) {
    if (!open(column, j)) continue;
    lower = Math.min(lower, y0 + j * STEP - eye.center[1]);
    upper = Math.max(upper, y0 + (j + 1) * STEP - eye.center[1]);
  }
  return { across, lower, upper, width: (widest + 1) * STEP };
}

export function findLandmarks(body: FittedBody, eyes: readonly EyeFit[], boots: Part): Landmarks {
  const openings = eyes.map((e) => lidOpening(body, e));
  // The irises sit where MakeHuman's own eyes look at rest (its eye bones: a little down and out from
  // the eyeballs' middles), which is where its lids were modelled to frame them: painted on the
  // eyeballs' middles instead, the upper lids hid half of each iris and the eyes looked drugged.
  const eyeMarks = eyes.map((e, side) => {
    const L = side === 0 ? "L" : "R";
    const from = body.joint(`eye.${L}____head`);
    const to = body.joint(`eye.${L}____tail`);
    const k = e.axes[0] / (to[0] - from[0]);
    return { center: e.center, axes: e.axes, forward: [1, 0, 0] as V3, gaze: [(to[1] - from[1]) * k, (to[2] - from[2]) * k] as [number, number], opening: openings[side]! };
  });

  // The nose's tip: the body's most forward point on the midline between the eyes and the mouth.
  const mouthJoint = body.joint("oris05____head");
  let noseTip: V3 = [0, 0, 0];
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    for (const v of f.vertices) {
      const p: V3 = [body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!];
      if (Math.abs(p[2]) < 0.006 && p[1] > mouthJoint[1] + 0.005 && p[1] < eyeMarks[0]!.center[1] && p[0] > noseTip[0]) noseTip = p;
    }
  }
  // The lips' parting: the midline's front outline (the most forward point in each millimetre of height) is
  // furthest back between the two lips; looked for between the lower lip's joint and the upper's.
  const lower = body.joint("oris01____tail");
  const upper = body.joint("oris05____tail");
  const outline = new Map<number, V3>();
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    for (const v of f.vertices) {
      const p: V3 = [body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!];
      if (Math.abs(p[2]) > 0.003 || p[1] < lower[1] - 0.004 || p[1] > upper[1]) continue;
      const bin = Math.floor(p[1] * 1000);
      if (p[0] > (outline.get(bin)?.[0] ?? -Infinity)) outline.set(bin, p);
    }
  }
  let parting: V3 = mouthJoint;
  for (const p of outline.values()) if (p[0] < parting[0] || parting === mouthJoint) parting = p;
  const fingertips: { tip: V3; dorsal: V3 }[] = [];
  const palms: V3[] = [];
  for (const side of SIDES) {
    const L = side.sign < 0 ? "L" : "R";
    const j = (name: string, end: "head" | "tail" = "head") => body.joint(`${name}.${L}____${end}`);
    const wrist = j("wrist");
    const axis = normalize(sub(j("finger3-1"), wrist));
    const acrossToIndex = normalize(sub(j("finger2-1"), j("finger5-1")));
    let normal = normalize(cross(axis, acrossToIndex));
    if (dot(normal, [0, 0, -side.sign]) < 0) normal = scale(normal, -1);
    palms.push(normal);
    for (let n = 1; n <= 5; n += 1) {
      const tip = j(`finger${n}-3`, "tail");
      const dir = normalize(sub(tip, j(`finger${n}-3`)));
      // The nail faces away from the palm; the thumb's turns out toward the index's side.
      const away: V3 = n === 1 ? normalize([acrossToIndex[0] - normal[0], acrossToIndex[1] - normal[1], acrossToIndex[2] - normal[2]]) : scale(normal, -1);
      fingertips.push({ tip, dorsal: normalize(sub(away, scale(dir, dot(away, dir)))) });
    }
  }

  const toes = SIDES.map((side) => {
    let x = -Infinity;
    let z = 0;
    let count = 0;
    for (let v = 0; v < boots.positions.length / 3; v += 1) {
      if (Math.sign(boots.positions[v * 3 + 2]!) !== side.sign) continue;
      x = Math.max(x, boots.positions[v * 3]!);
      z += boots.positions[v * 3 + 2]!;
      count += 1;
    }
    z /= count;
    // The front's outline down the middle, from the instep to the top: seen from the side, the furthest point
    // of the middle's vertices in each direction out from a point inside the boot behind the instep.
    const inside: [number, number] = [x - 0.17, 0.04];
    const reach = new Map<number, [number, number, number]>();
    for (let v = 0; v < boots.positions.length / 3; v += 1) {
      if (Math.abs(boots.positions[v * 3 + 2]! - z) > 0.006) continue;
      const dx = boots.positions[v * 3]! - inside[0];
      const dy = boots.positions[v * 3 + 1]! - inside[1];
      const degrees = Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 3) * 3;
      if (degrees < 12 || degrees > 96) continue;
      const r = Math.hypot(dx, dy);
      if (r > (reach.get(degrees)?.[2] ?? 0)) reach.set(degrees, [boots.positions[v * 3]!, boots.positions[v * 3 + 1]!, r]);
    }
    const outline = [...reach.entries()].sort((a, b) => a[0] - b[0]).map(([, [ox, oy]]) => [ox, oy] as [number, number]);
    // Smoothed, so the distance along it runs evenly over the surface (the furthest vertices step about).
    for (let pass = 0; pass < 6; pass += 1) {
      const previous = outline.map((q) => [...q] as [number, number]);
      for (let k = 1; k + 1 < outline.length; k += 1)
        for (let a = 0; a < 2; a += 1) outline[k]![a] = (previous[k - 1]![a]! + 2 * previous[k]![a]! + previous[k + 1]![a]!) / 4;
    }
    // From where the lacing starts, back over the instep, to the top.
    const start = outline.findIndex(([ox]) => ox < x - 0.095);
    return { x, z, lacing: outline.slice(Math.max(0, start - 1)) };
  });

  // The collar's top at the front: the neckline there (1.435) and the collar's height over it.
  const collarTop = 1.47125 - 0.0175 - 0.01875 + OUTFIT.collarHeight + 0.006;
  // The mouth's corners: just inside where the muscles that lift them end.
  const mouthHalfWidth = 0.96 * (Math.abs(body.joint("levator05.L____tail")[2]) + Math.abs(body.joint("levator05.R____tail")[2])) / 2;
  return { eyes: eyeMarks, mouth: [parting[0], parting[1], 0], mouthHalfWidth, noseTip, hair: hairOf(body), fingertips, palms, collarTop, toes };
}
