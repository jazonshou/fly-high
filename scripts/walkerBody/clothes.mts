/**
 * The walker's clothes and hair, made from the fitted body itself so they fit
 * it and move with it: each garment is the patch of skin it covers lifted off
 * by its ease, then draped (concavities filled, the trousers hanging straight
 * from the knee, the jacket straight from the chest, the sleeves from the
 * elbow), keeping the body's UVs and skin weights. Every open edge (a hem, a
 * cuff, the collar's top) gets a band turned in toward the body, so the
 * garment has a thickness and no gap shows into it. The skin they hide is
 * removed, but for a margin under each edge.
 *
 * The outfit (the old figure's, kept): an olive-grey soft-shell jacket with a
 * stand-up collar, closed; stone trousers; brown leather boots (`boots.mts`);
 * short dark-brown hair.
 */
import { BIND_POSITIONS, BONE, SIDES } from "../../src/render/webgpu/person/skeleton";
import { dot, normalize, scale, sub, type V3 } from "./math.mts";
import type { FittedBody } from "./body.mts";
import { adjacency, boundaryLoops, vertexNormals, vertexOf, type Part, type PartKind } from "./parts.mts";
import { SWATCH, type SwatchCursor } from "./swatches.mts";

const bind = (bone: number): V3 => [BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!];
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Heights and lines, metres, walker frame. */
export const OUTFIT = Object.freeze({
  /** The jacket's hem, over the hips. */
  jacketHem: 0.855,
  /** The trousers' waistband, a little under the navel (hidden under the jacket). */
  trouserWaist: 1.0,
  /** The trouser hem: lower at the heel than over the instep (the break). */
  trouserHemFront: 0.1,
  trouserHemBack: 0.072,
  /** The boots' shaft top, over the ankle bone. */
  bootTop: 0.16,
  /** The stand-up collar's height above the neckline (the neck's base, where it meets the shoulders and the chest), on average. */
  collarHeight: 0.054,
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
/** The collar's height over the neckline: a little lower on the sides, where the neckline rises up the neck. */
const collarHeightAt = (q: V3) => {
  const a = Math.atan2(q[2] - NECK_AXIS[2], q[0] - NECK_AXIS[0]);
  return OUTFIT.collarHeight + 0.006 * Math.cos(2 * a);
};
const neckRadiusOf = (q: V3) => Math.hypot(q[0] - NECK_AXIS[0], q[2] - NECK_AXIS[2]);

interface Region {
  readonly faces: number[][];
  readonly faceUvs: number[][];
}

export interface Garments {
  readonly skin: Part;
  readonly jacket: Part;
  readonly trousers: Part;
  readonly hair: Part;
  readonly report: readonly string[];
}

export function buildGarments(body: FittedBody, swatches: SwatchCursor): Garments {
  const P = body.positions;
  const count = P.length / 3;
  const bodyFaces: number[][] = [];
  const bodyUvs: number[][] = [];
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    bodyFaces.push([...f.vertices]);
    bodyUvs.push(f.uvs.flatMap((t) => [body.uvs[t * 2]!, body.uvs[t * 2 + 1]!]));
  }
  const N = vertexNormals(P, bodyFaces, count);
  const W = body.weights;
  const share = (v: number, bones: ReadonlySet<number>) => {
    let s = 0;
    for (let k = 0; k < 4; k += 1) if (bones.has(W.bones[v * 4 + k]!)) s += W.weights[v * 4 + k]!;
    return s;
  };
  const ARM = new Set(SIDES.flatMap((s) => [s.upperArm, s.forearm, s.hand, s.fingers, s.thumb]));
  const FOOT = new Set(SIDES.flatMap((s) => [s.foot, s.toe]));
  const p = (v: number) => vertexOf(P, v);
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
  // The neck: its radius per sector round its axis a little under the jaw, and per sector the height where the body narrows to it.
  const neckRadius = new Float64Array(NECK_SECTORS);
  for (let v = 0; v < count; v += 1) {
    const q = p(v);
    // The neck's narrowest a little under the jaw, above the shoulders' slope into it.
    if (isArm(v) || q[1] < 1.495 || q[1] > 1.53) continue;
    const k = neckSector(q);
    neckRadius[k] = neckRadius[k] === 0 ? neckRadiusOf(q) : Math.min(neckRadius[k]!, neckRadiusOf(q));
  }
  // Sectors the mesh left empty take their neighbours'.
  for (const table of [neckRadius]) {
    const empty = (x: number) => x === 0 || !Number.isFinite(x);
    for (let pass = 0; pass < NECK_SECTORS && Array.from(table).some(empty); pass += 1) {
      const copy = Float64Array.from(table);
      for (let k = 0; k < NECK_SECTORS; k += 1) {
        if (!empty(copy[k]!)) continue;
        const near = [copy[(k + 1) % NECK_SECTORS]!, copy[(k + NECK_SECTORS - 1) % NECK_SECTORS]!].filter((x) => !empty(x));
        if (near.length) table[k] = near.reduce((a, b) => a + b, 0) / near.length;
      }
    }
  }
  const trouserHem = (x: number) => (x > 0.02 ? OUTFIT.trouserHemFront : x < -0.02 ? OUTFIT.trouserHemBack : OUTFIT.trouserHemBack + ((x + 0.02) / 0.04) * (OUTFIT.trouserHemFront - OUTFIT.trouserHemBack));

  const inJacket = (v: number) => {
    const q = p(v);
    if (isArm(v)) return alongForearm(v) < OUTFIT.cuff;
    return q[1] >= OUTFIT.jacketHem && q[1] < necklineAt(q);
  };
  const inTrousers = (v: number) => {
    const q = p(v);
    if (isArm(v)) return false;
    return q[1] <= OUTFIT.trouserWaist && q[1] >= trouserHem(q[0]) && !(share(v, FOOT) > 0.5);
  };
  const skinShows = (v: number) => {
    const q = p(v);
    if (isArm(v)) return alongForearm(v) > OUTFIT.cuff - OUTFIT.skinMargin;
    if (isFoot(v)) return false;
    // The neck, and a margin under the jacket's neckline.
    return q[1] > necklineAt(q) - OUTFIT.skinMargin;
  };

  const select = (keep: (face: number[]) => boolean): Region => {
    const faces: number[][] = [];
    const faceUvs: number[][] = [];
    bodyFaces.forEach((f, i) => {
      if (!keep(f)) return;
      faces.push(f);
      faceUvs.push(bodyUvs[i]!);
    });
    return { faces, faceUvs };
  };

  // --- the jacket
  const torsoAxis: V3 = [0.01, 0, 0];
  const jacketRegion = select((f) => f.every(inJacket));
  const jacket = shell("jacket", "jacket", jacketRegion, P, N, W, {
    ease: (v) => {
      if (isArm(v)) return 0.014;
      const q = p(v);
      // Light on the shoulders, where the fabric rests.
      const shoulder = smoothstep(1.36, 1.42, q[1]);
      return 0.016 - 0.008 * shoulder;
    },
    minEase: (v) => (isArm(v) ? 0.008 : 0.006),
    hang: (v) => {
      if (isArm(v)) {
        const q = p(v);
        const side = q[2] < 0 ? SIDES[0]! : SIDES[1]!;
        // A sleeve hangs from the elbow to the cuff, loose round the forearm, snug at the cuff.
        const elbow = bind(side.forearm);
        const wrist = bind(side.hand);
        return { origin: elbow, axis: normalize(sub(wrist, elbow)), start: -0.02, taper: 0.993, group: side.sign < 0 ? 1 : 2 };
      }
      return { origin: [torsoAxis[0], 1.3, 0], axis: [0, -1, 0], start: 0, taper: 0.9985, group: 0 };
    },
    iterations: 24,
  });
  const collarTop = standUpCollar(jacket, P, N, swatches, (q) => neckRadius[neckSector(q)]!);
  // A snug cuff: the sleeve's last 4 cm pulled in toward the wrist.
  for (let i = 0; i < jacket.bodyVertex.length; i += 1) {
    const v = jacket.bodyVertex[i]!;
    if (!isArm(v)) continue;
    const s = alongForearm(v);
    const snug = smoothstep(OUTFIT.cuff - 0.05, OUTFIT.cuff - 0.005, s);
    if (snug <= 0) continue;
    const q = vertexOf(jacket.part.positions, i);
    const side = q[2] < 0 ? SIDES[0]! : SIDES[1]!;
    const wrist = bind(side.hand);
    const dir = normalize(sub(wrist, bind(side.forearm)));
    const onAxis = sub(sub(q, wrist), scale(dir, dot(sub(q, wrist), dir)));
    const r = Math.hypot(...onAxis);
    const body = sub(sub(p(v), wrist), scale(dir, dot(sub(p(v), wrist), dir)));
    const want = Math.hypot(...body) + 0.006;
    const rr = r + (Math.min(r, want) - r) * snug;
    const k = rr / (r || 1);
    for (let a = 0; a < 3; a += 1) jacket.part.positions[i * 3 + a] = wrist[a]! + dir[a]! * dot(sub(q, wrist), dir) + onAxis[a]! * k;
  }
  addBands(jacket, P, N, swatches, SWATCH.jacket, 0.004, new Set(collarTop));
  report.push(`jacket: ${jacket.part.faces.length} faces, ${jacket.loops} edges banded`);

  // --- the trousers
  const trousersRegion = select((f) => f.every(inTrousers));
  const trousers = shell("trousers", "trousers", trousersRegion, P, N, W, {
    ease: (v) => {
      const q = p(v);
      // Snug at the seat and the waist, easier down the thigh.
      return 0.006 + 0.006 * smoothstep(0.85, 0.6, q[1]);
    },
    minEase: () => 0.004,
    hang: (v) => {
      const q = p(v);
      const side = q[2] < 0 ? SIDES[0]! : SIDES[1]!;
      if (q[1] > 0.54) return null;
      return { origin: [0, 0.54, side.sign * Math.abs(bind(side.thigh)[2])], axis: [0, -1, 0], start: 0, taper: 0.9935, group: side.sign < 0 ? 1 : 2 };
    },
    iterations: 20,
  });
  addBands(trousers, P, N, swatches, SWATCH.trousers, 0.003);
  report.push(`trousers: ${trousers.part.faces.length} faces, ${trousers.loops} edges banded`);

  // --- the hair
  // The shell stands up only where the hair is thick: the thin edge of the cut is painted on the skin (the
  // texture bake's hairline), so the shell's edge, stepped along the body's faces, rises from where both
  // already show the same hair and casts no line of shadow on the skin.
  const hairFactor = hairline(body);
  const hairRegion = select((f) => f.every((v) => hairFactor(v) > HAIR_SHELL_FROM));
  // And it rises over the three rings of vertices in from its edge, wherever along the edge the cut is thick.
  const fromEdge = ringsFromEdge(hairRegion.faces);
  const thick = (v: number) => smoothstep(HAIR_SHELL_FROM, 1, hairFactor(v)) * Math.min(1, (fromEdge.get(v) ?? 0) / 3);
  const hair = shell("hair", "hair", hairRegion, P, N, W, {
    ease: (v) => {
      const n: V3 = [N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!];
      // Longer on top, short at the sides and the nape (a short taper cut).
      const top = smoothstep(0.2, 0.85, n[1]);
      return 0.0005 + thick(v) * (0.005 + 0.007 * top);
    },
    minEase: (v) => 0.0004 + thick(v) * 0.004,
    hang: () => null,
    iterations: 6,
    fixBoundary: true,
  });
  report.push(`hair: ${hair.part.faces.length} faces`);

  // --- the skin that shows
  const skinRegion = select((f) => f.some(skinShows));
  const skin = shell("skin", "skin", skinRegion, P, N, W, { ease: () => 0, minEase: () => 0, hang: () => null, iterations: 0 });
  report.push(`skin: ${skin.part.faces.length} faces`);

  return { skin: skin.part, jacket: jacket.part, trousers: trousers.part, hair: hair.part, report };
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
  readonly fixBoundary?: boolean;
}

interface Shell {
  readonly part: Part;
  /** Per part vertex, the body vertex it was lifted from. */
  readonly bodyVertex: number[];
  loops: number;
}

function shell(name: string, kind: PartKind, region: Region, P: Float64Array, N: Float64Array, W: FittedBody["weights"], options: ShellOptions): Shell {
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
        if (onBoundary[i] && options.fixBoundary) continue;
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
      bones.push(W.bones[v * 4 + k]!);
      weights.push(W.weights[v * 4 + k]!);
    }
  }
  return { part: { name, kind, positions, bones, weights, faces, faceUvs: region.faceUvs.map((uv) => [...uv]) }, bodyVertex, loops: 0 };
}

/**
 * The jacket's stand-up collar, closed (zipped to the top): a band of
 * fabric rising from the neckline, out from the neck by its ease, a little
 * in toward it at the top, its top edge turned in to the neck. Its weights
 * go from the neckline's to a share of the neck's at the top, so it turns a
 * little with the head.
 */
/** Returns the collar's turned-in top edge, which needs no band (it already meets the neck). */
function standUpCollar(target: Shell, P: Float64Array, N: Float64Array, swatches: SwatchCursor, neckRadiusAt: (q: V3) => number): number[] {
  const part = target.part;
  const loops = boundaryLoops(part.faces);
  // The neckline: the open edge highest up the body.
  const meanY = (loop: number[]) => loop.reduce((s, i) => s + part.positions[i * 3 + 1]!, 0) / loop.length;
  const neckline = loops.reduce((best, loop) => (meanY(loop) > meanY(best) ? loop : best));
  const RINGS = 6;
  const rings: number[][] = [neckline];
  const along = [0];
  for (let k = 1; k <= neckline.length; k += 1) along.push(along[k - 1]! + Math.hypot(...sub(vertexOf(part.positions, neckline[k % neckline.length]!), vertexOf(part.positions, neckline[k - 1]!))));
  const addVertex = (q: V3, from: number, neckShare: number): number => {
    const index = part.positions.length / 3;
    part.positions.push(q[0], q[1], q[2]);
    // Blend the neckline vertex's weights toward the neck bone's.
    const blended = new Map<number, number>();
    for (let k = 0; k < 4; k += 1) {
      const b = part.bones[from * 4 + k]!;
      blended.set(b, (blended.get(b) ?? 0) + part.weights[from * 4 + k]! * (1 - neckShare));
    }
    blended.set(BONE.neck, (blended.get(BONE.neck) ?? 0) + neckShare);
    const top = [...blended.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((s, [, w]) => s + w, 0);
    for (let k = 0; k < 4; k += 1) {
      part.bones.push(top[k]?.[0] ?? 0);
      part.weights.push(top[k] ? top[k]![1] / total : 0);
    }
    target.bodyVertex.push(target.bodyVertex[from]!);
    return index;
  };
  for (let j = 1; j <= RINGS; j += 1) {
    const f = j / RINGS;
    rings.push(
      neckline.map((i) => {
        const s = vertexOf(part.positions, i);
        const dx = s[0] - NECK_AXIS[0];
        const dz = s[2] - NECK_AXIS[2];
        const r0 = Math.hypot(dx, dz) || 1;
        const rTop = Math.max(neckRadiusAt(s) + 0.013, r0 * 0.86);
        const r = r0 + (rTop - r0) * smoothstep(0, 0.6, f);
        const y = s[1] + collarHeightAt(s) * f;
        return addVertex([NECK_AXIS[0] + (dx / r0) * r, y, NECK_AXIS[2] + (dz / r0) * r], i, 0.35 * f);
      }),
    );
  }
  // The top edge turned in: down a little to the neck's skin.
  const inner = neckline.map((i, k) => {
    const s = vertexOf(part.positions, rings[RINGS]![k]!);
    const dx = s[0] - NECK_AXIS[0];
    const dz = s[2] - NECK_AXIS[2];
    const r0 = Math.hypot(dx, dz) || 1;
    const r = Math.min(r0 - 0.004, neckRadiusAt(s) + 0.002);
    return addVertex([NECK_AXIS[0] + (dx / r0) * r, s[1] - 0.006, NECK_AXIS[2] + (dz / r0) * r], i, 0.4);
  });
  rings.push(inner);
  // The collar, near the face, takes the swatch's whole width (about as many texels per metre as the jacket's body).
  const strip = swatches.strip(SWATCH.jacket, along[neckline.length]!, 0.03, 1);
  for (let j = 0; j + 1 < rings.length; j += 1) {
    const lower = rings[j]!;
    const upper = rings[j + 1]!;
    const v0 = strip.v0 + ((strip.v1 - strip.v0) * j) / (rings.length - 1);
    const v1 = strip.v0 + ((strip.v1 - strip.v0) * (j + 1)) / (rings.length - 1);
    for (let k = 0; k < neckline.length; k += 1) {
      const k1 = (k + 1) % neckline.length;
      // The neckline runs a -> b in the jacket's faces; the collar takes it b -> a.
      part.faces.push([lower[k1]!, lower[k]!, upper[k]!, upper[k1]!]);
      const u0 = strip.u(along[k]!);
      const u1 = strip.u(along[k + 1]!);
      part.faceUvs.push([u1, v0, u0, v0, u0, v1, u1, v1]);
    }
  }
  return inner;
}

/**
 * A band at each open edge, from the edge in toward the skin (`inset` off
 * it), so the garment shows a thickness there and nothing shows through.
 */
function addBands(target: Shell, P: Float64Array, N: Float64Array, swatches: SwatchCursor, swatch: (typeof SWATCH)[keyof typeof SWATCH], inset: number, skip: ReadonlySet<number> = new Set()): void {
  const part = target.part;
  const loops = boundaryLoops(part.faces).filter((loop) => !loop.every((i) => skip.has(i)));
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

/** The hair shell covers the faces whose every corner carries more hair than this (`hairlineAt`). */
export const HAIR_SHELL_FROM = 0.4;

/** Per vertex of a region, how many edges in it is from its open edge (0 on the edge). */
function ringsFromEdge(faces: readonly number[][]): Map<number, number> {
  const edges = new Map<string, number>();
  const neighbours = new Map<number, Set<number>>();
  for (const f of faces)
    for (let k = 0; k < f.length; k += 1) {
      const a = f[k]!;
      const b = f[(k + 1) % f.length]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      if (!neighbours.has(b)) neighbours.set(b, new Set());
      neighbours.get(a)!.add(b);
      neighbours.get(b)!.add(a);
    }
  const rings = new Map<number, number>();
  let front: number[] = [];
  for (const [key, count] of edges) {
    if (count !== 1) continue;
    for (const v of key.split(",").map(Number)) {
      if (rings.has(v)) continue;
      rings.set(v, 0);
      front.push(v);
    }
  }
  for (let ring = 1; front.length > 0; ring += 1) {
    const next: number[] = [];
    for (const v of front)
      for (const w of neighbours.get(v)!) {
        if (rings.has(w)) continue;
        rings.set(w, ring);
        next.push(w);
      }
    front = next;
  }
  return rings;
}

/**
 * How much hair a scalp vertex carries, 0 to 1: a short man's cut, the
 * hairline across the top of the forehead, receding a little at the temples,
 * sideburns down to the middle of the ear, round above the ears and down to
 * the nape.
 */
function hairline(body: FittedBody): (v: number) => number {
  const at = hairlineAt(body);
  return (v) => at(vertexOf(body.positions, v));
}

/** The same for any point on the head. */
export function hairlineAt(body: FittedBody): (q: V3) => number {
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
  // (azimuth from the front, degrees; hairline height above the eyes, metres)
  const line: [number, number][] = [
    [0, 0.054],
    [22, 0.056],
    [40, 0.05],
    [58, 0.032],
    // The sideburn, in front of the ear (which spans about 70 to 95 degrees round, up to 12 mm over the eyes).
    [65, 0.006],
    [70, -0.014],
    [75, -0.008],
    // Round over the ear, close above it.
    [82, 0.012],
    [92, 0.018],
    [104, 0.014],
    [118, -0.012],
    [134, -0.044],
    [150, -0.066],
    [165, -0.076],
    [180, -0.079],
  ];
  const heightAt = (azimuth: number) => {
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
  return (q) => {
    if (q[1] < headBone[1] - 0.06) return 0;
    const azimuth = (Math.atan2(Math.abs(q[2]), q[0] - cx) * 180) / Math.PI;
    // The ear itself carries none: it stands off the skull's side (the skull's 73 to 76 mm out from the axis
    // there, the ear's rim 79 to 87).
    const out = Math.hypot(q[0] - cx, q[2]);
    const ear = smoothstep(66, 72, azimuth) * smoothstep(128, 122, azimuth) * smoothstep(0.0765, 0.0785, out) * smoothstep(eyeY + 0.018, eyeY + 0.012, q[1]) * smoothstep(eyeY - 0.056, eyeY - 0.046, q[1]);
    const h = eyeY + heightAt(azimuth);
    return smoothstep(h - 0.002, h + 0.012, q[1]) * (1 - ear);
  };
}
