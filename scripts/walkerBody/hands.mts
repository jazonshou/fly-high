/**
 * Relaxes the hands. MakeHuman's base mesh holds them open, the fingers
 * straight and fanned wide and the thumb out; a standing person's hands hang
 * relaxed, the fingers close together and curled a little more from the index
 * to the little finger, the thumb resting along the index. The bake poses
 * MakeHuman's own finger bones that way (each phalanx turned about its joint,
 * blended by MakeHuman's per-phalanx skin weights) after the fit, so the
 * walker's bind pose has relaxed hands and its fingers bone curls them further
 * from there.
 */
import { SIDES } from "../../src/render/webgpu/person/skeleton";
import { add, axisAngle, cross, dot, mulMM, mulMV, normalize, scale, sub, type M3, type V3 } from "./math.mts";

/** A rigid motion v -> r v + t. */
interface Rigid {
  readonly r: M3;
  readonly t: V3;
}

const about = (axis: V3, angle: number, pivot: V3): Rigid => {
  const r = axisAngle(axis, angle);
  return { r, t: sub(pivot, mulMV(r, pivot)) };
};
const compose = (a: Rigid, b: Rigid): Rigid => ({ r: mulMM(a.r, b.r), t: add(mulMV(a.r, b.t), a.t) });
const applyRigid = (m: Rigid, v: V3): V3 => add(mulMV(m.r, v), m.t);

const deg = (d: number) => (d * Math.PI) / 180;

/** Per finger (index, middle, ring, little): how much of its fan toward the middle finger to close, and each joint's curl, degrees. */
const FINGERS = Object.freeze([
  { n: 2, close: 0.7, curl: [8, 14, 8] },
  { n: 3, close: 0, curl: [12, 20, 10] },
  { n: 4, close: 0.75, curl: [15, 26, 12] },
  { n: 5, close: 0.75, curl: [20, 32, 14] },
]);

export interface HandReport {
  /** Per side: each finger's fan from the middle finger before and after, degrees. */
  readonly fans: readonly string[];
}

export function relaxHands(positions: Float64Array, mhWeights: Readonly<Record<string, readonly (readonly [number, number])[]>>, joint: (name: string) => V3): HandReport {
  const motions = new Map<string, Rigid>();
  const fans: string[] = [];
  for (const side of SIDES) {
    const L = side.sign < 0 ? "L" : "R";
    const j = (name: string, end: "head" | "tail" = "head") => joint(`${name}.${L}____${end}`);
    const wrist = j("wrist");
    const axis = normalize(sub(j("finger3-1"), wrist));
    let normal = normalize(cross(axis, sub(j("finger2-1"), j("finger5-1"))));
    // The palm faces the body's midline (the thigh).
    if (dot(normal, [0, 0, -side.sign]) < 0) normal = scale(normal, -1);
    const middleDir = normalize(sub(j("finger3-3", "tail"), j("finger3-1")));
    const inPalm = (v: V3) => normalize(sub(v, scale(normal, dot(v, normal))));
    const fanLine: string[] = [];
    for (const finger of FINGERS) {
      const k1 = j(`finger${finger.n}-1`);
      const dir = normalize(sub(j(`finger${finger.n}-3`, "tail"), k1));
      const a = inPalm(dir);
      const m = inPalm(middleDir);
      const fan = Math.atan2(dot(cross(a, m), normal), dot(a, m));
      const spread = about(normal, fan * finger.close, k1);
      const spreadDir = mulMV(spread.r, dir);
      fanLine.push(`${((fan * 180) / Math.PI).toFixed(0)}->${((fan * (1 - finger.close) * 180) / Math.PI).toFixed(0)}`);
      // Curl toward the palm: about dir x normal, so the tip turns toward `normal`.
      const curlAxis = normalize(cross(dir, normal));
      const curlAxisAfter = normalize(cross(spreadDir, normal));
      const t1 = compose(about(curlAxisAfter, deg(finger.curl[0]!), k1), spread);
      const t2 = compose(t1, about(curlAxis, deg(finger.curl[1]!), j(`finger${finger.n}-2`)));
      const t3 = compose(t2, about(curlAxis, deg(finger.curl[2]!), j(`finger${finger.n}-3`)));
      motions.set(`finger${finger.n}-1.${L}`, t1);
      motions.set(`finger${finger.n}-2.${L}`, t2);
      motions.set(`finger${finger.n}-3.${L}`, t3);
    }
    // The thumb: in toward the index (about the palm normal at its base), then a little flexion at its two outer joints.
    const c1 = j("finger1-1");
    const thumbDir = normalize(sub(j("finger1-3", "tail"), c1));
    const towardIndex = Math.atan2(dot(cross(inPalm(thumbDir), axis), normal), dot(inPalm(thumbDir), axis));
    const base = about(normal, towardIndex * 0.35, c1);
    const thumbCurl = normalize(cross(thumbDir, normal));
    const t2 = compose(base, about(thumbCurl, deg(10), j("finger1-2")));
    const t3 = compose(t2, about(thumbCurl, deg(12), j("finger1-3")));
    motions.set(`finger1-1.${L}`, base);
    motions.set(`finger1-2.${L}`, t2);
    motions.set(`finger1-3.${L}`, t3);
    fanLine.push(`thumb ${((towardIndex * 180) / Math.PI).toFixed(0)}`);
    fans.push(`${L}: ${fanLine.join(" ")}`);
  }

  // Blend per vertex by MakeHuman's own weights (the rest of a vertex's weight stays put).
  const n = positions.length / 3;
  const acc = new Float64Array(n * 3);
  const moved = new Float64Array(n);
  for (const [bone, list] of Object.entries(mhWeights)) {
    const m = motions.get(bone);
    if (!m) continue;
    for (const [v, w] of list) {
      const p = applyRigid(m, [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
      acc[v * 3]! += p[0] * w;
      acc[v * 3 + 1]! += p[1] * w;
      acc[v * 3 + 2]! += p[2] * w;
      moved[v]! += w;
    }
  }
  const total = vertexTotals(mhWeights, n);
  for (let v = 0; v < n; v += 1) {
    if (moved[v] === 0) continue;
    const t = total[v]! || 1;
    const rest = Math.max(0, t - moved[v]!);
    for (let k = 0; k < 3; k += 1) positions[v * 3 + k] = (acc[v * 3 + k]! + positions[v * 3 + k]! * rest) / t;
  }
  return { fans };
}

function vertexTotals(mhWeights: Readonly<Record<string, readonly (readonly [number, number])[]>>, n: number): Float64Array {
  const total = new Float64Array(n);
  for (const list of Object.values(mhWeights)) for (const [v, w] of list) total[v]! += w;
  return total;
}
