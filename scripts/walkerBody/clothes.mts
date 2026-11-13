/**
 * The walker's clothes and hair, made from the fitted body itself so they fit
 * it and move with it: each garment is the patch of skin it covers, cut along
 * its own edges (a hem, a cuff, the open throat: `clip`), lifted off by its
 * ease, then draped (concavities filled, the jeans hanging straight from the
 * thigh, the jacket from the chest, the sleeves from the elbow), keeping the
 * body's UVs and skin weights. Every open edge gets a band turned in toward
 * the body, so the garment has a thickness and no gap shows into it. The skin
 * they hide is removed, but for a margin under each edge.
 *
 * The outfit is a man's own clothes, not a uniform: a brown leather flight
 * jacket cut short, its knitted waistband and cuffs drawn in snug, its collar
 * laid down and the zip left open at the throat over a T-shirt (painted on
 * the skin there); straight-legged indigo jeans; brown leather boots
 * (`boots.mts`). The hair is `hair.mts`'s.
 */
import { BIND_POSITIONS, BONE, SIDES } from "../../src/render/webgpu/person/skeleton";
import { add, cross, dot, lerp, normalize, scale, sub, type V3 } from "./math.mts";
import type { FittedBody } from "./body.mts";
import { adjacency, boundaryLoops, vertexNormals, vertexOf, type Part, type PartKind } from "./parts.mts";
import { SWATCH, type SwatchCursor } from "./swatches.mts";
import { buildHair } from "./hair.mts";

const bind = (bone: number): V3 => [BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!];
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Heights and lines, metres, walker frame. */
export const OUTFIT = Object.freeze({
  /** The jacket's hem: the lower edge of its knitted waistband, at the belt (above the hip joints, so it does not bend with the thighs). */
  jacketHem: 0.95,
  /** The knitted waistband's and the knitted cuffs' widths. */
  waistband: 0.06,
  knitCuff: 0.055,
  /** The jacket is open at the throat: the zip is done up to this height, and above it each front falls open by this much per metre up. */
  zipTop: 1.355,
  openSlope: 0.44,
  /** The collar: how far it stands up the neck at the back before it folds over, how far it falls from the fold, and its points' fall at the front. */
  collarStand: 0.03,
  collarFall: 0.058,
  collarPoint: 0.074,
  /** The T-shirt's neck: this far under the jacket's neckline round the neck's base. */
  shirtNeck: 0.01,
  /** The jeans' waistband, a little under the navel (under the jacket's). */
  trouserWaist: 1.0,
  /** The jeans' hem: lower at the heel than over the instep (the break). */
  trouserHemFront: 0.1,
  trouserHemBack: 0.072,
  /** The boots' shaft top, over the ankle bone. */
  bootTop: 0.16,
  /** Where a sleeve ends: this far along the forearm past the wrist joint (negative: short of it). */
  cuff: -0.004,
  /** Skin kept under an edge, metres. */
  skinMargin: 0.03,
});

/** The neck's axis, vertical through this point. */
const NECK_AXIS: V3 = [0.022, 0, 0];
const NECK_SECTORS = 24;
const neckSector = (q: V3) => {
  const a = Math.atan2(q[2] - NECK_AXIS[2], q[0] - NECK_AXIS[0]);
  return ((Math.floor(((a + Math.PI) / (2 * Math.PI)) * NECK_SECTORS) % NECK_SECTORS) + NECK_SECTORS) % NECK_SECTORS;
};
/**
 * The jacket's neckline round the neck's base: just over the notch between
 * the collarbones at the front, at the neck's root on the sides and over the
 * seventh vertebra at the back (y = a + b cos + c cos 2 of the angle round
 * the neck from the front).
 */
const necklineAt = (q: V3) => {
  const a = Math.atan2(q[2] - NECK_AXIS[2], q[0] - NECK_AXIS[0]);
  return 1.47125 - 0.0175 * Math.cos(a) - 0.01875 * Math.cos(2 * a);
};
const neckRadiusOf = (q: V3) => Math.hypot(q[0] - NECK_AXIS[0], q[2] - NECK_AXIS[2]);
const neckAngleOf = (q: V3) => Math.atan2(q[2] - NECK_AXIS[2], q[0] - NECK_AXIS[0]);
/**
 * The jacket's open throat: how far a point is outside the V its two fronts
 * leave above the zip's top (metres across; negative inside it).
 */
export const outsideThroat = (q: V3) => (q[0] > 0 ? Math.abs(q[2]) - OUTFIT.openSlope * (q[1] - OUTFIT.zipTop) : Infinity);
/** The jeans' hem at a point this far forward of the ankle: lower at the heel than over the instep. */
export const trouserHemAt = (x: number) => (x > 0.02 ? OUTFIT.trouserHemFront : x < -0.02 ? OUTFIT.trouserHemBack : OUTFIT.trouserHemBack + ((x + 0.02) / 0.04) * (OUTFIT.trouserHemFront - OUTFIT.trouserHemBack));
/** The T-shirt's neck: the height its edge lies at round the neck's base. */
export const shirtNeckAt = (q: V3) => necklineAt(q) - OUTFIT.shirtNeck;

interface Region {
  readonly faces: number[][];
  readonly faceUvs: number[][];
}

/**
 * The body's skin as the garments are cut from it: its own vertices, and the
 * ones the cuts add along the garments' edges (each between two of them).
 */
interface Cloth {
  readonly P: number[];
  readonly N: number[];
  readonly bones: number[];
  readonly weights: number[];
}

/** What the painters need of the clothes' shape. */
export interface GarmentMarks {
  /** The collar's outer edge and its fold, as lines round the neck from one point to the other. */
  readonly collarEdge: readonly V3[];
  readonly collarFold: readonly V3[];
}

export interface Garments {
  readonly skin: Part;
  readonly jacket: Part;
  readonly collar: Part;
  readonly trousers: Part;
  readonly hair: Part;
  readonly marks: GarmentMarks;
  readonly report: readonly string[];
}

/**
 * The faces where `field` is positive, cut along where it is zero: a face
 * the line crosses is trimmed to it, on new vertices placed along its edges
 * (shared between the faces either side), so a garment's edge is the line
 * meant and not the mesh's own steps. A face touching a `never` vertex is
 * left out whole.
 */
function clip(mesh: Cloth, faces: readonly number[][], faceUvs: readonly number[][], field: (v: number) => number, never: (v: number) => boolean = () => false): Region {
  const values = new Map<number, number>();
  const at = (v: number) => {
    let x = values.get(v);
    if (x === undefined) values.set(v, (x = field(v)));
    return x;
  };
  const cuts = new Map<string, { index: number; t: number }>();
  /** The vertex where the line crosses the edge from `inside` to `outside`, and how far along it. */
  const cut = (inside: number, outside: number) => {
    const key = inside < outside ? `${inside},${outside}` : `${outside},${inside}`;
    let c = cuts.get(key);
    if (c) return c;
    const fa = at(inside);
    const fb = at(outside);
    // Not within a twelfth of either end: no slivers.
    const t = Math.min(0.92, Math.max(0.08, fa / (fa - fb)));
    const index = mesh.P.length / 3;
    const n = normalize(lerp(vertexOf(mesh.N, inside), vertexOf(mesh.N, outside), t));
    const q = lerp(vertexOf(mesh.P, inside), vertexOf(mesh.P, outside), t);
    mesh.P.push(q[0], q[1], q[2]);
    mesh.N.push(n[0], n[1], n[2]);
    const blended = new Map<number, number>();
    for (const [v, share] of [[inside, 1 - t], [outside, t]] as const)
      for (let k = 0; k < 4; k += 1) blended.set(mesh.bones[v * 4 + k]!, (blended.get(mesh.bones[v * 4 + k]!) ?? 0) + mesh.weights[v * 4 + k]! * share);
    const top = [...blended.entries()].filter(([, w]) => w > 0).sort((x, y) => y[1] - x[1]).slice(0, 4);
    const total = top.reduce((sum, [, w]) => sum + w, 0);
    for (let k = 0; k < 4; k += 1) {
      mesh.bones.push(top[k]?.[0] ?? 0);
      mesh.weights.push(top[k] ? top[k]![1] / total : 0);
    }
    values.set(index, 0);
    cuts.set(key, (c = { index, t }));
    return c;
  };
  const out: Region = { faces: [], faceUvs: [] };
  faces.forEach((face, f) => {
    if (face.some(never)) return;
    const uv = faceUvs[f]!;
    const inside = face.map((v) => at(v) > 0);
    if (inside.every((x) => x)) {
      out.faces.push([...face]);
      out.faceUvs.push([...uv]);
      return;
    }
    if (!inside.some((x) => x)) return;
    const polygon: number[] = [];
    const polygonUv: number[] = [];
    for (let k = 0; k < face.length; k += 1) {
      const j = (k + 1) % face.length;
      if (inside[k]) {
        polygon.push(face[k]!);
        polygonUv.push(uv[k * 2]!, uv[k * 2 + 1]!);
      }
      if (inside[k] === inside[j]) continue;
      const from = inside[k] ? k : j;
      const to = inside[k] ? j : k;
      const c = cut(face[from]!, face[to]!);
      polygon.push(c.index);
      polygonUv.push(uv[from * 2]! + (uv[to * 2]! - uv[from * 2]!) * c.t, uv[from * 2 + 1]! + (uv[to * 2 + 1]! - uv[from * 2 + 1]!) * c.t);
    }
    if (polygon.length < 3) return;
    out.faces.push(polygon);
    out.faceUvs.push(polygonUv);
  });
  return out;
}

export function buildGarments(body: FittedBody, swatches: SwatchCursor): Garments {
  const count = body.positions.length / 3;
  const bodyFaces: number[][] = [];
  const bodyUvs: number[][] = [];
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    bodyFaces.push([...f.vertices]);
    bodyUvs.push(f.uvs.flatMap((t) => [body.uvs[t * 2]!, body.uvs[t * 2 + 1]!]));
  }
  const bodyNormals = vertexNormals(body.positions, bodyFaces, count);
  // The skin, and room for the vertices the cuts add.
  const mesh: Cloth = { P: Array.from(body.positions), N: Array.from(bodyNormals), bones: Array.from(body.weights.bones), weights: Array.from(body.weights.weights) };
  const share = (v: number, bones: ReadonlySet<number>) => {
    let s = 0;
    for (let k = 0; k < 4; k += 1) if (bones.has(mesh.bones[v * 4 + k]!)) s += mesh.weights[v * 4 + k]!;
    return s;
  };
  const ARM = new Set(SIDES.flatMap((s) => [s.upperArm, s.forearm, s.hand, s.fingers, s.thumb]));
  const FOOT = new Set(SIDES.flatMap((s) => [s.foot, s.toe]));
  const p = (v: number) => vertexOf(mesh.P, v);
  const report: string[] = [];

  // Along the forearm past the wrist joint, for an arm vertex.
  const alongForearm = (v: number): number => {
    const q = p(v);
    const side = q[2] < 0 ? SIDES[0]! : SIDES[1]!;
    const wrist = bind(side.hand);
    const dir = normalize(sub(wrist, bind(side.forearm)));
    return dot(sub(q, wrist), dir);
  };
  const isArm = (v: number) => share(v, ARM) > 0.5;
  const isFoot = (v: number) => share(v, FOOT) > 0.5 || p(v)[1] < OUTFIT.bootTop;
  // The neck: its radius per sector round its axis a little under the jaw.
  const neckRadius = new Float64Array(NECK_SECTORS);
  for (let v = 0; v < count; v += 1) {
    const q = p(v);
    // The neck's narrowest a little under the jaw, above the shoulders' slope into it.
    if (isArm(v) || q[1] < 1.495 || q[1] > 1.53) continue;
    const k = neckSector(q);
    neckRadius[k] = neckRadius[k] === 0 ? neckRadiusOf(q) : Math.min(neckRadius[k]!, neckRadiusOf(q));
  }
  // Sectors the mesh left empty take their neighbours'.
  {
    const empty = (x: number) => x === 0 || !Number.isFinite(x);
    for (let pass = 0; pass < NECK_SECTORS && Array.from(neckRadius).some(empty); pass += 1) {
      const copy = Float64Array.from(neckRadius);
      for (let k = 0; k < NECK_SECTORS; k += 1) {
        if (!empty(copy[k]!)) continue;
        const near = [copy[(k + 1) % NECK_SECTORS]!, copy[(k + NECK_SECTORS - 1) % NECK_SECTORS]!].filter((x) => !empty(x));
        if (near.length) neckRadius[k] = near.reduce((a, b) => a + b, 0) / near.length;
      }
    }
  }

  // How far inside each garment a vertex is (metres; its edge where this is zero).
  const insideJacket = (v: number) => {
    const q = p(v);
    if (isArm(v)) return OUTFIT.cuff - alongForearm(v);
    return Math.min(q[1] - OUTFIT.jacketHem, necklineAt(q) - q[1], outsideThroat(q));
  };
  const insideTrousers = (v: number) => {
    const q = p(v);
    return Math.min(OUTFIT.trouserWaist - q[1], q[1] - trouserHemAt(q[0]));
  };
  const skinShows = (v: number) => {
    const q = p(v);
    if (isArm(v)) return alongForearm(v) > OUTFIT.cuff - OUTFIT.skinMargin;
    if (isFoot(v)) return false;
    // The neck, the open throat, and a margin under the jacket's edge round both.
    return q[1] > necklineAt(q) - OUTFIT.skinMargin || (q[1] > OUTFIT.zipTop - OUTFIT.skinMargin && outsideThroat(q) < OUTFIT.skinMargin);
  };

  // --- the jacket
  const torsoAxis: V3 = [0.01, 0, 0];
  const jacket = shell("jacket", "jacket", clip(mesh, bodyFaces, bodyUvs, insideJacket), mesh, {
    ease: (v) => {
      const q = p(v);
      const side = q[2] < 0 ? SIDES[0]! : SIDES[1]!;
      // Built out a little at the shoulder's point, as a jacket's shoulder is: it squares his.
      const joint = bind(side.upperArm);
      const point = 0.01 * Math.exp(-((q[0] - joint[0]) ** 2 + (q[1] - joint[1] - 0.035) ** 2 + (q[2] - joint[2] - side.sign * 0.01) ** 2) / (2 * 0.06 ** 2));
      if (isArm(v)) return 0.012 + point;
      // Light on the top of the shoulders by the neck, where the leather rests, and at the open throat, where the fronts lie on the chest.
      const rests = Math.max(smoothstep(1.38, 1.44, q[1]) * smoothstep(0.13, 0.07, Math.abs(q[2])), q[1] > OUTFIT.zipTop - 0.03 ? smoothstep(0.045, 0.005, outsideThroat(q)) : 0);
      return 0.016 - 0.009 * rests + point;
    },
    minEase: (v) => (isArm(v) ? 0.008 : 0.006),
    // (The throat's edges stay where they were cut, so its V keeps its point.)
    fixBoundary: (v) => {
      const q = p(v);
      return !isArm(v) && outsideThroat(q) < 0.003 && outsideThroat(q) < necklineAt(q) - q[1];
    },
    hang: (v) => {
      if (isArm(v)) {
        const q = p(v);
        const side = q[2] < 0 ? SIDES[0]! : SIDES[1]!;
        // A sleeve hangs from the elbow to the cuff, loose round the forearm, gathered into the cuff.
        const elbow = bind(side.forearm);
        const wrist = bind(side.hand);
        return { origin: elbow, axis: normalize(sub(wrist, elbow)), start: -0.02, taper: 0.988, group: side.sign < 0 ? 1 : 2 };
      }
      // From the chest it falls in toward the waist: cut to a man's shape, not a box.
      return { origin: [torsoAxis[0], 1.3, 0], axis: [0, -1, 0], start: 0, taper: 0.9975, group: 0 };
    },
    iterations: 24,
  });
  // The knitted cuffs and waistband: drawn in snug to the wrist and the hips, the leather blousing over them.
  for (let i = 0; i < jacket.bodyVertex.length; i += 1) {
    const v = jacket.bodyVertex[i]!;
    const snug = isArm(v) ? smoothstep(OUTFIT.cuff - OUTFIT.knitCuff - 0.025, OUTFIT.cuff - OUTFIT.knitCuff, alongForearm(v)) : smoothstep(OUTFIT.jacketHem + OUTFIT.waistband + 0.03, OUTFIT.jacketHem + OUTFIT.waistband, p(v)[1]);
    if (snug <= 0) continue;
    const off = isArm(v) ? 0.006 : 0.011;
    for (let a = 0; a < 3; a += 1) {
      const worn = mesh.P[v * 3 + a]! + mesh.N[v * 3 + a]! * off;
      jacket.part.positions[i * 3 + a]! += (worn - jacket.part.positions[i * 3 + a]!) * snug;
    }
  }
  const collar = foldedCollar(jacket, mesh, swatches, (q) => neckRadius[neckSector(q)]!);
  addBands(jacket, mesh, swatches, SWATCH.jacket, 0.004);
  report.push(`jacket: ${jacket.part.faces.length} faces, ${jacket.loops} edges banded; collar: ${collar.part.faces.length} faces round ${(collar.length * 100).toFixed(0)} cm`);

  // --- the jeans
  const trousers = shell("trousers", "trousers", clip(mesh, bodyFaces, bodyUvs, insideTrousers, (v) => isArm(v) || share(v, FOOT) > 0.5), mesh, {
    ease: (v) => {
      const q = p(v);
      // Snug at the seat and the waist, easy down the thigh.
      return 0.006 + 0.008 * smoothstep(0.9, 0.7, q[1]);
    },
    minEase: () => 0.004,
    hang: (v) => {
      const q = p(v);
      const side = q[2] < 0 ? SIDES[0]! : SIDES[1]!;
      // Straight legs: from the thigh the denim falls on its own, in a little to the hem.
      if (q[1] > 0.72) return null;
      return { origin: [0, 0.72, side.sign * Math.abs(bind(side.thigh)[2])], axis: [0, -1, 0], start: 0, taper: 0.993, group: side.sign < 0 ? 1 : 2 };
    },
    iterations: 20,
  });
  addBands(trousers, mesh, swatches, SWATCH.trousers, 0.003);
  report.push(`trousers: ${trousers.part.faces.length} faces, ${trousers.loops} edges banded`);

  // --- the hair
  const hair = buildHair(body, bodyFaces, bodyUvs, bodyNormals);
  report.push(hair.report);

  // --- the skin that shows (and the T-shirt painted on it in the open throat)
  const skinFaces: number[][] = [];
  const skinUvs: number[][] = [];
  bodyFaces.forEach((f, i) => {
    if (!f.some(skinShows)) return;
    skinFaces.push(f);
    skinUvs.push(bodyUvs[i]!);
  });
  const skin = shell("skin", "skin", { faces: skinFaces, faceUvs: skinUvs }, mesh, { ease: () => 0, minEase: () => 0, hang: () => null, iterations: 0 });
  report.push(`skin: ${skin.part.faces.length} faces`);

  return { skin: skin.part, jacket: jacket.part, collar: collar.part, trousers: trousers.part, hair: hair.part, marks: { collarEdge: collar.edge, collarFold: collar.fold }, report };
}

interface Hang {
  /** A point on the axis the fabric hangs round, the axis (pointing down the garment), where along it the hang starts. */
  readonly origin: V3;
  readonly axis: V3;
  readonly start: number;
  /** The radius kept per centimetre down from the widest point above. */
  readonly taper: number;
  /** Vertices hang with others of their group only (each leg, each sleeve). */
  readonly group: number;
}

interface ShellOptions {
  readonly ease: (v: number) => number;
  readonly minEase: (v: number) => number;
  readonly hang: (v: number) => Hang | null;
  readonly iterations: number;
  /** Vertices on an open edge that the smoothing leaves where they were cut. */
  readonly fixBoundary?: (v: number) => boolean;
}

interface Shell {
  readonly part: Part;
  /** Per part vertex, the body vertex it was lifted from. */
  readonly bodyVertex: number[];
  loops: number;
}

function shell(name: string, kind: PartKind, region: Region, mesh: Cloth, options: ShellOptions): Shell {
  const { P, N } = mesh;
  const index = new Map<number, number>();
  const bodyVertex: number[] = [];
  const faces = region.faces.map((f) =>
    f.map((v) => {
      let i = index.get(v);
      if (i === undefined) {
        i = bodyVertex.length;
        index.set(v, i);
        bodyVertex.push(v);
      }
      return i;
    }),
  );
  const n = bodyVertex.length;
  const positions = new Array<number>(n * 3);
  const minOffset = new Float64Array(n);
  bodyVertex.forEach((v, i) => {
    const e = options.ease(v);
    for (let a = 0; a < 3; a += 1) positions[i * 3 + a] = P[v * 3 + a]! + N[v * 3 + a]! * e;
    minOffset[i] = options.minEase(v);
  });

  const hangs = bodyVertex.map((v) => options.hang(v));
  const applyHang = () => {
    // Per group: bins round the axis and down it; each bin's radius at least the widest above it, tapered.
    const groups = new Map<number, number[]>();
    hangs.forEach((h, i) => {
      if (!h) return;
      let list = groups.get(h.group);
      if (!list) groups.set(h.group, (list = []));
      list.push(i);
    });
    const SECTORS = 36;
    const STEP = 0.01;
    for (const list of groups.values()) {
      const h = hangs[list[0]!]!;
      const axis = normalize(h.axis);
      const ref: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
      const u = normalize(sub(ref, scale(axis, dot(ref, axis))));
      const w: V3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
      const local = list.map((i) => {
        const q = sub(vertexOf(positions, i), h.origin);
        const t = dot(q, axis);
        const x = dot(q, u);
        const y = dot(q, w);
        return { i, t, angle: Math.atan2(y, x), r: Math.hypot(x, y) };
      });
      const steps = Math.ceil((Math.max(...local.map((l) => l.t)) - h.start) / STEP) + 1;
      const widest = new Float64Array(steps * SECTORS);
      const sectorOf = (angle: number) => ((Math.floor(((angle + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS) + SECTORS) % SECTORS;
      for (const l of local) {
        if (l.t < h.start) continue;
        const s = Math.min(steps - 1, Math.floor((l.t - h.start) / STEP));
        const k = s * SECTORS + sectorOf(l.angle);
        widest[k] = Math.max(widest[k]!, l.r);
      }
      // Smooth round each ring a little (a fold of fabric spans sectors), then carry the widest down.
      const envelope = new Float64Array(steps * SECTORS);
      for (let s = 0; s < steps; s += 1) {
        for (let k = 0; k < SECTORS; k += 1) {
          const here = Math.max(widest[s * SECTORS + k]!, 0.6 * widest[s * SECTORS + ((k + 1) % SECTORS)]! + 0.4 * widest[s * SECTORS + k]!, 0.6 * widest[s * SECTORS + ((k + SECTORS - 1) % SECTORS)]! + 0.4 * widest[s * SECTORS + k]!);
          const above = s > 0 ? envelope[(s - 1) * SECTORS + k]! * h.taper : 0;
          envelope[s * SECTORS + k] = Math.max(here, above);
        }
      }
      // The envelope between bin centres, so the fabric shows no steps.
      const envelopeAt = (t: number, angle: number) => {
        const fs = Math.min(steps - 1, Math.max(0, (t - h.start) / STEP - 0.5));
        const s0 = Math.floor(fs);
        const s1 = Math.min(steps - 1, s0 + 1);
        const ft = fs - s0;
        const fa = ((angle + Math.PI) / (2 * Math.PI)) * SECTORS - 0.5;
        const a0 = ((Math.floor(fa) % SECTORS) + SECTORS) % SECTORS;
        const a1 = (a0 + 1) % SECTORS;
        const fu = fa - Math.floor(fa);
        const at = (s: number, a: number) => envelope[s * SECTORS + a]!;
        return (1 - ft) * ((1 - fu) * at(s0, a0) + fu * at(s0, a1)) + ft * ((1 - fu) * at(s1, a0) + fu * at(s1, a1));
      };
      for (const l of local) {
        if (l.t < h.start) continue;
        const r = envelopeAt(l.t, l.angle);
        if (r <= l.r) continue;
        const k = r / (l.r || 1);
        const q = sub(vertexOf(positions, l.i), h.origin);
        const along = scale(axis, l.t);
        for (let a = 0; a < 3; a += 1) positions[l.i * 3 + a] = h.origin[a]! + along[a]! + (q[a]! - along[a]!) * k;
      }
    }
  };

  const loops = boundaryLoops(faces);
  const onBoundary = new Uint8Array(n);
  const boundaryNeighbours: number[][] = Array.from({ length: n }, () => []);
  for (const loop of loops) {
    loop.forEach((v, k) => {
      onBoundary[v] = 1;
      boundaryNeighbours[v]!.push(loop[(k + 1) % loop.length]!, loop[(k + loop.length - 1) % loop.length]!);
    });
  }
  const neighbours = adjacency(faces, n);
  const smooth = (iterations: number, floor: Float64Array) => {
    for (let it = 0; it < iterations; it += 1) {
      const next = positions.slice();
      for (let i = 0; i < n; i += 1) {
        if (onBoundary[i] && options.fixBoundary?.(bodyVertex[i]!)) continue;
        const list = onBoundary[i] ? boundaryNeighbours[i]! : neighbours[i]!;
        if (list.length === 0) continue;
        for (let a = 0; a < 3; a += 1) {
          let s = 0;
          for (const j of list) s += positions[j * 3 + a]!;
          next[i * 3 + a] = positions[i * 3 + a]! + 0.5 * (s / list.length - positions[i * 3 + a]!);
        }
        // Never closer to the skin than the floor, along the skin's normal.
        const v = bodyVertex[i]!;
        const d = (next[i * 3]! - P[v * 3]!) * N[v * 3]! + (next[i * 3 + 1]! - P[v * 3 + 1]!) * N[v * 3 + 1]! + (next[i * 3 + 2]! - P[v * 3 + 2]!) * N[v * 3 + 2]!;
        if (d < floor[i]!) for (let a = 0; a < 3; a += 1) next[i * 3 + a]! += N[v * 3 + a]! * (floor[i]! - d);
      }
      for (let k = 0; k < positions.length; k += 1) positions[k] = next[k]!;
    }
  };
  if (options.iterations > 0) {
    smooth(options.iterations, minOffset);
    if (hangs.some((h) => h)) {
      applyHang();
      // The hung shape is the floor now: smooth it without falling back inside it.
      const floor = new Float64Array(n);
      bodyVertex.forEach((v, i) => {
        const d = (positions[i * 3]! - P[v * 3]!) * N[v * 3]! + (positions[i * 3 + 1]! - P[v * 3 + 1]!) * N[v * 3 + 1]! + (positions[i * 3 + 2]! - P[v * 3 + 2]!) * N[v * 3 + 2]!;
        floor[i] = Math.max(minOffset[i]!, hangs[i] ? d * 0.97 : minOffset[i]!);
      });
      smooth(12, floor);
    }
  }

  const bones: number[] = [];
  const weights: number[] = [];
  for (const v of bodyVertex) {
    for (let k = 0; k < 4; k += 1) {
      bones.push(mesh.bones[v * 4 + k]!);
      weights.push(mesh.weights[v * 4 + k]!);
    }
  }
  return { part: { name, kind, positions, bones, weights, faces, faceUvs: region.faceUvs.map((uv) => [...uv]) }, bodyVertex, loops: 0 };
}

interface Collar {
  readonly part: Part;
  readonly edge: V3[];
  readonly fold: V3[];
  /** Its length round the neck, metres. */
  readonly length: number;
}

/**
 * The jacket's collar, laid down: a strip of leather sewn to the neckline
 * from one front round the back of the neck to the other. It stands a little
 * way up the neck (most at the back), folds over, and falls outward onto the
 * shoulders and the chest, where its two points lie either side of the open
 * throat. A part of its own, so the painter knows it from the jacket under
 * it. Its foot follows the neckline's skin weights; the fold takes a share of
 * the neck's, so it gives a little as the head turns.
 */
function foldedCollar(jacket: Shell, mesh: Cloth, swatches: SwatchCursor, neckRadiusAt: (q: V3) => number): Collar {
  const cloth = jacket.part.positions;
  const loops = boundaryLoops(jacket.part.faces);
  // The jacket's edge round the neck and the throat: the open edge highest up the body.
  const meanY = (loop: number[]) => loop.reduce((s, i) => s + cloth[i * 3 + 1]!, 0) / loop.length;
  const opening = loops.reduce((best, loop) => (meanY(loop) > meanY(best) ? loop : best));
  // The seam: the part of that edge that lies on the neckline (the rest is the two fronts, down the throat).
  const onSeam = opening.map((i) => {
    const q = vertexOf(mesh.P, jacket.bodyVertex[i]!);
    return necklineAt(q) - q[1] < outsideThroat(q);
  });
  const first = onSeam.findIndex((x, k) => x && !onSeam[(k + onSeam.length - 1) % onSeam.length]);
  if (first < 0) throw new Error("walker body: the jacket's neckline has no ends (is the throat open?)");
  const seam: number[] = [];
  for (let k = 0; k < opening.length && onSeam[(first + k) % opening.length]; k += 1) seam.push(opening[(first + k) % opening.length]!);
  const skinAt = (i: number) => vertexOf(mesh.P, jacket.bodyVertex[i]!);
  const along = [0];
  for (let k = 1; k < seam.length; k += 1) along.push(along[k - 1]! + Math.hypot(...sub(skinAt(seam[k]!), skinAt(seam[k - 1]!))));
  const length = along[seam.length - 1]!;

  // The jacket's surface near a point: the plane of the vertices nearest it.
  const clothNormals = vertexNormals(cloth, jacket.part.faces);
  const near: number[] = [];
  for (let i = 0; i < jacket.bodyVertex.length; i += 1) if (cloth[i * 3 + 1]! > 1.2) near.push(i);
  const onCloth = (g: V3): { q: V3; n: V3 } => {
    const best: [number, number][] = [];
    for (const i of near) {
      const d = (cloth[i * 3]! - g[0]) ** 2 + (cloth[i * 3 + 1]! - g[1]) ** 2 + (cloth[i * 3 + 2]! - g[2]) ** 2;
      if (best.length < 6) best.push([d, i]);
      else if (d < best[5]![0]) best[5] = [d, i];
      else continue;
      best.sort((x, y) => x[0] - y[0]);
    }
    let total = 0;
    let middle: V3 = [0, 0, 0];
    let normal: V3 = [0, 0, 0];
    for (const [d, i] of best) {
      const w = 1 / (d + 1e-6);
      total += w;
      middle = add(middle, scale(vertexOf(cloth, i), w));
      normal = add(normal, scale(vertexOf(clothNormals, i), w));
    }
    const n = normalize(normal);
    middle = scale(middle, 1 / total);
    return { q: sub(g, scale(n, dot(sub(g, middle), n))), n };
  };
  /** From a point on the jacket, `distance` over its surface the way `heading` leans. */
  const over = (start: V3, heading: V3, distance: number): { q: V3; n: V3 } => {
    let here = onCloth(start);
    for (let left = distance; left > 1e-6; left -= 0.008) {
      const way = normalize(sub(heading, scale(here.n, dot(heading, here.n))));
      here = onCloth(add(here.q, scale(way, Math.min(0.008, left))));
    }
    return here;
  };

  const COLUMNS = 48;
  // Per ring: the neck's share of its weights.
  const NECK_SHARE = [0, 0.3, 0.3, 0.22, 0.12, 0.05, 0.05];
  const RINGS = NECK_SHARE.length;
  const part: Part = { name: "collar", kind: "collar", positions: [], bones: [], weights: [], faces: [], faceUvs: [] };
  const rings: number[][] = Array.from({ length: RINGS }, () => []);
  const across: number[][] = [];
  const edge: V3[] = [];
  const fold: V3[] = [];
  const addVertex = (q: V3, from: number, neckShare: number): number => {
    const index = part.positions.length / 3;
    part.positions.push(q[0], q[1], q[2]);
    const v = jacket.bodyVertex[from]!;
    const blended = new Map<number, number>();
    for (let k = 0; k < 4; k += 1) blended.set(mesh.bones[v * 4 + k]!, (blended.get(mesh.bones[v * 4 + k]!) ?? 0) + mesh.weights[v * 4 + k]! * (1 - neckShare));
    blended.set(BONE.neck, (blended.get(BONE.neck) ?? 0) + neckShare);
    const top = [...blended.entries()].filter(([, w]) => w > 0).sort((x, y) => y[1] - x[1]).slice(0, 4);
    const total = top.reduce((sum, [, w]) => sum + w, 0);
    for (let k = 0; k < 4; k += 1) {
      part.bones.push(top[k]?.[0] ?? 0);
      part.weights.push(top[k] ? top[k]![1] / total : 0);
    }
    return index;
  };
  for (let c = 0; c < COLUMNS; c += 1) {
    const s = (length * c) / (COLUMNS - 1);
    let k = 0;
    while (k + 2 < seam.length && along[k + 1]! < s) k += 1;
    const t = Math.min(1, Math.max(0, (s - along[k]!) / (along[k + 1]! - along[k]! || 1)));
    const nearest = t < 0.5 ? seam[k]! : seam[k + 1]!;
    // The seam on the skin and on the jacket, and the skin's normal there.
    const skin = lerp(skinAt(seam[k]!), skinAt(seam[k + 1]!), t);
    const skinNormal = normalize(lerp(vertexOf(mesh.N, jacket.bodyVertex[seam[k]!]!), vertexOf(mesh.N, jacket.bodyVertex[seam[k + 1]!]!), t));
    const worn = lerp(vertexOf(cloth, seam[k]!), vertexOf(cloth, seam[k + 1]!), t);
    const angle = neckAngleOf(skin);
    const out: V3 = [Math.cos(angle), 0, Math.sin(angle)];
    // How far from the nearer point, and how much of a collar there is there: none stands at the points themselves.
    const fromEnd = Math.min(s, length - s);
    const body = smoothstep(0, 0.07, fromEnd);
    const stand = 0.011 + (OUTFIT.collarStand - 0.004 * Math.cos(angle) ** 2 - 0.011) * body;
    const fall = OUTFIT.collarPoint + (OUTFIT.collarFall - OUTFIT.collarPoint) * smoothstep(0.0, 0.1, fromEnd);
    // The fold: up the neck from the seam, a finger off the neck.
    const reach = neckRadiusOf(skin);
    const foldRadius = Math.min(reach + 0.006, Math.max(reach - 0.02, neckRadiusAt(skin) + 0.014));
    const inner: V3 = [NECK_AXIS[0] + out[0] * (reach + (foldRadius - reach) * body), skin[1] + stand, NECK_AXIS[2] + out[2] * (reach + (foldRadius - reach) * body)];
    const crest = add(inner, [out[0] * 0.007, 0.0015, out[2] * 0.007]);
    // The leaf: out and down over the jacket to its edge, lifted off it less and less (and hardly at all at the points, which lie flat).
    const heading = normalize([out[0], -0.35, out[2]]);
    const beyond = Math.max(0.014, fall - stand);
    const lift = 0.3 + 0.7 * smoothstep(0, 0.03, fromEnd);
    const leaf = [0.34, 0.68, 1].map((share, j) => {
      const at = over(worn, heading, beyond * share);
      return add(at.q, scale(at.n, lift * ([0.004 + 0.5 * stand, 0.004 + 0.18 * stand, 0.0045][j]!)));
    });
    const last = over(worn, heading, beyond - 0.005);
    const under = add(last.q, scale(last.n, lift * 0.0012));
    const column: V3[] = [add(skin, scale(skinNormal, 0.0015)), inner, crest, leaf[0]!, leaf[1]!, leaf[2]!, under];
    const run = [0];
    column.forEach((q, j) => {
      rings[j]!.push(addVertex(q, nearest, NECK_SHARE[j]!));
      if (j > 0) run.push(run[j - 1]! + Math.hypot(...sub(q, column[j - 1]!)));
    });
    across.push(run.map((x) => x / run[RINGS - 1]!));
    edge.push(leaf[2]!);
    fold.push(crest);
  }
  // The leaf faces up and out; the stand's inside, the neck. Which way round that is depends on the way the seam runs.
  const probe = (c: number) => {
    const a = vertexOf(part.positions, rings[3]![c]!);
    const b = vertexOf(part.positions, rings[3]![c + 1]!);
    const d = vertexOf(part.positions, rings[4]![c]!);
    return cross(sub(b, a), sub(d, a));
  };
  const middle = Math.floor(COLUMNS / 2);
  const outward = sub(vertexOf(part.positions, rings[3]![middle]!), [NECK_AXIS[0], vertexOf(part.positions, rings[3]![middle]!)[1] - 0.05, NECK_AXIS[2]]);
  const flip = dot(probe(middle), outward) < 0;
  // The collar is next to the face: it takes the swatch's whole width.
  const strip = swatches.strip(SWATCH.jacket, length, 0.05, 1);
  for (let j = 0; j + 1 < RINGS; j += 1) {
    for (let c = 0; c + 1 < COLUMNS; c += 1) {
      const u0 = strip.u((length * c) / (COLUMNS - 1));
      const u1 = strip.u((length * (c + 1)) / (COLUMNS - 1));
      const v = (column: number, ring: number) => strip.v0 + (strip.v1 - strip.v0) * across[column]![ring]!;
      const quad = [rings[j]![c]!, rings[j]![c + 1]!, rings[j + 1]![c + 1]!, rings[j + 1]![c]!];
      const uv = [u0, v(c, j), u1, v(c + 1, j), u1, v(c + 1, j + 1), u0, v(c, j + 1)];
      if (flip) {
        part.faces.push([quad[3]!, quad[2]!, quad[1]!, quad[0]!]);
        part.faceUvs.push([uv[6]!, uv[7]!, uv[4]!, uv[5]!, uv[2]!, uv[3]!, uv[0]!, uv[1]!]);
      } else {
        part.faces.push(quad);
        part.faceUvs.push(uv);
      }
    }
  }
  return { part, edge, fold, length };
}

/**
 * A band at each open edge, from the edge in toward the skin (`inset` off
 * it), so the garment shows a thickness there and nothing shows through.
 */
function addBands(target: Shell, mesh: Cloth, swatches: SwatchCursor, swatch: (typeof SWATCH)[keyof typeof SWATCH], inset: number): void {
  const { P, N } = mesh;
  const part = target.part;
  const loops = boundaryLoops(part.faces);
  for (const loop of loops) {
    const inner = loop.map((i) => {
      const v = target.bodyVertex[i]!;
      const index = part.positions.length / 3;
      for (let a = 0; a < 3; a += 1) part.positions.push(P[v * 3 + a]! + N[v * 3 + a]! * inset);
      for (let k = 0; k < 4; k += 1) {
        part.bones.push(part.bones[i * 4 + k]!);
        part.weights.push(part.weights[i * 4 + k]!);
      }
      target.bodyVertex.push(v);
      return index;
    });
    // The loop's length, for the band's UVs along it.
    const along = [0];
    for (let k = 1; k <= loop.length; k += 1) along.push(along[k - 1]! + Math.hypot(...sub(vertexOf(part.positions, loop[k % loop.length]!), vertexOf(part.positions, loop[k - 1]!))));
    const strip = swatches.strip(swatch, along[loop.length]!);
    for (let k = 0; k < loop.length; k += 1) {
      const a = loop[k]!;
      const b = loop[(k + 1) % loop.length]!;
      const ia = inner[k]!;
      const ib = inner[(k + 1) % loop.length]!;
      // The open edge runs a -> b in the garment's faces; the band takes it b -> a.
      part.faces.push([b, a, ia, ib]);
      const u0 = strip.u(along[k]!);
      const u1 = strip.u(along[k + 1]!);
      part.faceUvs.push([u1, strip.v0, u0, strip.v0, u0, strip.v1, u1, strip.v1]);
    }
  }
  target.loops = loops.length;
}
