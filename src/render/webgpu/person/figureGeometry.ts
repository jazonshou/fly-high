import { PROPORTIONS, FOREARM_LENGTH, UPPER_ARM_LENGTH } from "./figureProportions";
import { BIND_POSITIONS, BONE, PALM_LENGTH, SIDES, type SideBones } from "./skeleton";
import { MAX_SHADE, faceUv, swatchUv, type FigureSwatch } from "./figureAtlas";

/**
 * The walker's skinned mesh in the bind pose, built from lofted cross-sections
 * the way the car and boat are built from theirs: a torso, neck and head, two
 * arms with mitten hands and thumbs, two trouser legs and two boots. Every
 * vertex carries up to four bone weights; every part picks its finish from
 * the figure's atlas by UV (`figureAtlas.ts`), so the whole figure is one
 * material and one draw.
 *
 * DETAIL. `FIGURE_LODS` sets the segments round and the rings along each part:
 * LOD0 about 9k triangles (within 25 m), LOD1 3k (to 80 m), LOD2 0.8k.
 *
 * FRAME. The root's: +X forward, +Y up, +Z right, feet on y = 0.
 */
export interface FigureGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** Four bone indices and four weights per vertex (weights sum to 1). */
  readonly matricesIndices: Float32Array;
  readonly matricesWeights: Float32Array;
}

export interface FigureLodSpec {
  /** Segments round the torso, legs, arms, head; rings per metre along the limbs and torso. */
  readonly torsoSegments: number;
  readonly limbSegments: number;
  readonly armSegments: number;
  readonly headSegments: number;
  readonly handSegments: number;
  readonly footSegments: number;
  readonly ringsPerMeter: number;
  readonly headRings: number;
  /** A ring at every key section at least (the shoulders, knees, boot tops), or only by length. */
  readonly ringPerKey: boolean;
  /** Hair as its own shell over the skull, its edge following the hairline, or painted on the head's rings. */
  readonly hairCap: boolean;
}

export const FIGURE_LODS: readonly FigureLodSpec[] = Object.freeze([
  Object.freeze({ torsoSegments: 30, limbSegments: 18, armSegments: 14, headSegments: 28, handSegments: 10, footSegments: 12, ringsPerMeter: 38, headRings: 16, ringPerKey: true, hairCap: true }),
  Object.freeze({ torsoSegments: 16, limbSegments: 11, armSegments: 9, headSegments: 14, handSegments: 6, footSegments: 8, ringsPerMeter: 19, headRings: 9, ringPerKey: true, hairCap: true }),
  Object.freeze({ torsoSegments: 10, limbSegments: 6, armSegments: 5, headSegments: 8, handSegments: 4, footSegments: 5, ringsPerMeter: 7, headRings: 4, ringPerKey: false, hairCap: false }),
]);

/** A key cross-section along a loft. */
interface KeyRing {
  /** Distance along the loft's axis from its start, metres. */
  readonly t: number;
  /** Extents along +front, -front, +side, -side, metres. */
  readonly front: number;
  readonly back: number;
  readonly sideP: number;
  readonly sideN: number;
  /** Superellipse exponent: 2 an ellipse, higher squarer. */
  readonly n: number;
  /** Offset of the section's centre along front and side, metres. */
  readonly df?: number;
  readonly ds?: number;
}

type Vec3 = [number, number, number];

interface BoneWeight {
  bone: number;
  weight: number;
}

interface LoftSpec {
  readonly origin: Vec3;
  /** Unit axis along the loft. */
  readonly axis: Vec3;
  /** Unit "front" direction, square to the axis; side = axis x front. */
  readonly front: Vec3;
  readonly keys: readonly KeyRing[];
  readonly segments: number;
  readonly ringsPerMeter: number;
  readonly ringPerKey: boolean;
  /** Close the start and end with domes this deep (metres along the axis), or leave open (0). */
  readonly startDome: number;
  readonly endDome: number;
  /** Bone weights at a vertex; `t` along the axis, `angle` round from front toward side. */
  readonly weights: (p: Vec3, t: number, angle: number) => readonly BoneWeight[];
  /** The finish at a vertex. */
  readonly finish: (p: Vec3, t: number, angle: number) => FinishKey;
  /** Moves a vertex after it is placed (bumps such as a nose). */
  readonly displace?: (p: Vec3, normalGuess: Vec3) => void;
}

/** A finish: one of the atlas's swatches, or the painted face. */
type FinishKey = FigureSwatch | "face";

class MeshBuilder {
  readonly positions: number[] = [];
  readonly finishes: FinishKey[] = [];
  readonly indices: number[] = [];
  readonly boneIndices: number[] = [];
  readonly boneWeights: number[] = [];
  /** Per vertex: the bone it hangs from most (for the occlusion bake). */
  readonly ownBone: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  addVertex(p: Vec3, finish: FinishKey, weights: readonly BoneWeight[]): number {
    const index = this.vertexCount;
    this.positions.push(p[0], p[1], p[2]);
    this.finishes.push(finish);
    // Keep the four heaviest, normalised.
    const sorted = [...weights].filter((w) => w.weight > 1e-4).sort((a, b) => b.weight - a.weight).slice(0, 4);
    const total = sorted.reduce((sum, w) => sum + w.weight, 0) || 1;
    for (let i = 0; i < 4; i += 1) {
      this.boneIndices.push(sorted[i]?.bone ?? 0);
      const w = sorted[i];
      this.boneWeights.push(w ? w.weight / total : 0);
    }
    this.ownBone.push(sorted[0]?.bone ?? 0);
    return index;
  }

  /** Per triangle: the finish it wears, or null to take its corners' (`buildFigureGeometry`). */
  readonly triangleFinishes: (FinishKey | null)[] = [];

  triangle(a: number, b: number, c: number, finish: FinishKey | null = null): void {
    this.indices.push(a, b, c);
    this.triangleFinishes.push(finish);
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Catmull-Rom through the keys' numeric fields at a fractional key index. */
function interpolateKey(keys: readonly KeyRing[], u: number): Required<KeyRing> {
  const i = Math.min(keys.length - 2, Math.max(0, Math.floor(u)));
  const s = u - i;
  const k0 = keys[Math.max(0, i - 1)]!;
  const k1 = keys[i]!;
  const k2 = keys[i + 1]!;
  const k3 = keys[Math.min(keys.length - 1, i + 2)]!;
  const cr = (a: number, b: number, c: number, d: number): number =>
    0.5 * (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s * s + (-a + 3 * b - 3 * c + d) * s * s * s);
  // Linear in t keeps rings evenly spread; the shape is smooth.
  const lin = (a: number, b: number): number => a + (b - a) * s;
  return {
    t: lin(k1.t, k2.t),
    front: Math.max(0.002, cr(k0.front, k1.front, k2.front, k3.front)),
    back: Math.max(0.002, cr(k0.back, k1.back, k2.back, k3.back)),
    sideP: Math.max(0.002, cr(k0.sideP, k1.sideP, k2.sideP, k3.sideP)),
    sideN: Math.max(0.002, cr(k0.sideN, k1.sideN, k2.sideN, k3.sideN)),
    n: lin(k1.n, k2.n),
    df: cr(k0.df ?? 0, k1.df ?? 0, k2.df ?? 0, k3.df ?? 0),
    ds: cr(k0.ds ?? 0, k1.ds ?? 0, k2.ds ?? 0, k3.ds ?? 0),
  };
}

/** A superellipse's point at `angle` (0 = front, pi/2 = side). */
function sectionPoint(ring: Required<KeyRing>, angle: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const e = 2 / ring.n;
  const f = Math.sign(c) * Math.pow(Math.abs(c), e) * (c >= 0 ? ring.front : ring.back);
  const d = Math.sign(s) * Math.pow(Math.abs(s), e) * (s >= 0 ? ring.sideP : ring.sideN);
  return [f + ring.df, d + ring.ds];
}

function addLoft(builder: MeshBuilder, spec: LoftSpec): void {
  const axis = normalize(spec.axis);
  const front = normalize(spec.front);
  const side = normalize(cross(axis, front));
  const keys = spec.keys;
  const length = keys[keys.length - 1]!.t - keys[0]!.t;
  // Rings by length; at least one per key section where the LOD keeps them.
  const ringCount = Math.max(spec.ringPerKey ? keys.length : 3, Math.round(length * spec.ringsPerMeter) + 1);
  const rings: Required<KeyRing>[] = [];
  for (let r = 0; r < ringCount; r += 1) {
    // Evenly in t: find the fractional key index for this t.
    const t = keys[0]!.t + (length * r) / (ringCount - 1);
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1]!.t < t) k += 1;
    const span = keys[k + 1]!.t - keys[k]!.t;
    const u = k + (span > 0 ? (t - keys[k]!.t) / span : 0);
    rings.push(interpolateKey(keys, Math.min(keys.length - 1, u)));
  }
  const segments = spec.segments;
  const place = (ring: Required<KeyRing>, along: number, angle: number, scale: number): { p: Vec3; n: Vec3 } => {
    const [f, d] = sectionPoint(ring, angle);
    const p: Vec3 = [
      spec.origin[0] + axis[0] * along + front[0] * (f * scale + ring.df * (1 - scale)) + side[0] * (d * scale + ring.ds * (1 - scale)),
      spec.origin[1] + axis[1] * along + front[1] * (f * scale + ring.df * (1 - scale)) + side[1] * (d * scale + ring.ds * (1 - scale)),
      spec.origin[2] + axis[2] * along + front[2] * (f * scale + ring.df * (1 - scale)) + side[2] * (d * scale + ring.ds * (1 - scale)),
    ];
    const n = normalize([
      front[0] * Math.cos(angle) + side[0] * Math.sin(angle),
      front[1] * Math.cos(angle) + side[1] * Math.sin(angle),
      front[2] * Math.cos(angle) + side[2] * Math.sin(angle),
    ]);
    return { p, n };
  };
  const vertex = (ring: Required<KeyRing>, along: number, angle: number, scale: number): number => {
    const { p, n } = place(ring, along, angle, scale);
    spec.displace?.(p, n);
    return builder.addVertex(p, spec.finish(p, along, angle), spec.weights(p, along, angle));
  };
  const grid: number[][] = [];
  /** Each grid row's distance along the axis. */
  const rowAlong: number[] = [];
  const domeSteps = Math.max(1, Math.round(segments / 6));
  const domeRings = (ring: Required<KeyRing>, along: number, depth: number, direction: 1 | -1): { rows: number[][]; along: number[] } => {
    const rows: number[][] = [];
    const alongs: number[] = [];
    for (let step = 1; step <= domeSteps; step += 1) {
      const phi = (step / (domeSteps + 1)) * (Math.PI / 2);
      const scale = Math.cos(phi);
      const at = along + direction * depth * Math.sin(phi);
      const row: number[] = [];
      for (let j = 0; j < segments; j += 1) row.push(vertex(ring, at, (2 * Math.PI * j) / segments, scale));
      rows.push(row);
      alongs.push(at);
    }
    return { rows, along: alongs };
  };
  const startAlong = rings[0]!.t - keys[0]!.t;
  if (spec.startDome > 0) {
    const dome = domeRings(rings[0]!, startAlong, spec.startDome, -1);
    grid.push(...dome.rows.reverse());
    rowAlong.push(...dome.along.reverse());
  }
  for (const ring of rings) {
    const row: number[] = [];
    for (let j = 0; j < segments; j += 1) row.push(vertex(ring, ring.t - keys[0]!.t, (2 * Math.PI * j) / segments, 1));
    grid.push(row);
    rowAlong.push(ring.t - keys[0]!.t);
  }
  const endRing = rings[rings.length - 1]!;
  if (spec.endDome > 0) {
    const dome = domeRings(endRing, endRing.t - keys[0]!.t, spec.endDome, 1);
    grid.push(...dome.rows);
    rowAlong.push(...dome.along);
  }
  // Quads between rows; the winding faces outward (side = axis x front).
  // Both halves of a quad wear the finish at its centre, so a seam between
  // finishes runs along the rings instead of zigzagging across them.
  const centre: Vec3 = [0, 0, 0];
  for (let r = 0; r + 1 < grid.length; r += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = grid[r]![j]!;
      const b = grid[r]![(j + 1) % segments]!;
      const c = grid[r + 1]![(j + 1) % segments]!;
      const d = grid[r + 1]![j]!;
      for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
        centre[axisIndex] = (builder.positions[a * 3 + axisIndex]! + builder.positions[b * 3 + axisIndex]!
          + builder.positions[c * 3 + axisIndex]! + builder.positions[d * 3 + axisIndex]!) / 4;
      }
      const finish = spec.finish(centre, (rowAlong[r]! + rowAlong[r + 1]!) / 2, (2 * Math.PI * (j + 0.5)) / segments);
      builder.triangle(a, c, b, finish);
      builder.triangle(a, d, c, finish);
    }
  }
  // Pole caps.
  if (spec.startDome > 0) {
    const pole = vertex(rings[0]!, startAlong - spec.startDome, 0, 0);
    const row = grid[0]!;
    for (let j = 0; j < segments; j += 1) builder.triangle(pole, row[j]!, row[(j + 1) % segments]!);
  }
  if (spec.endDome > 0) {
    const pole = vertex(endRing, endRing.t - keys[0]!.t + spec.endDome, 0, 0);
    const row = grid[grid.length - 1]!;
    for (let j = 0; j < segments; j += 1) builder.triangle(pole, row[(j + 1) % segments]!, row[j]!);
  }
}

const bind = (bone: number): Vec3 => [BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!];

/** Two bones blended across [from, to] of a coordinate. */
function blend(a: number, b: number, from: number, to: number, x: number): BoneWeight[] {
  const w = smoothstep(from, to, x);
  return [{ bone: a, weight: 1 - w }, { bone: b, weight: w }];
}

/** The spine's bones blended by height. */
function spineWeights(y: number): BoneWeight[] {
  const levels: readonly (readonly [number, number])[] = [
    [BONE.pelvis, 0.93],
    [BONE.spine1, 1.02],
    [BONE.spine2, 1.15],
    [BONE.spine3, 1.3],
    [BONE.neck, 1.47],
  ];
  if (y <= levels[0]![1]!) return [{ bone: levels[0]![0]!, weight: 1 }];
  for (let i = 0; i + 1 < levels.length; i += 1) {
    if (y <= levels[i + 1]![1]!) {
      const w = smoothstep(levels[i]![1]!, levels[i + 1]![1]!, y);
      return [{ bone: levels[i]![0]!, weight: 1 - w }, { bone: levels[i + 1]![0]!, weight: w }];
    }
  }
  return [{ bone: BONE.neck, weight: 1 }];
}

function torso(builder: MeshBuilder, lod: FigureLodSpec): void {
  // y, centre x, half-width, front, back, exponent. Clothes' ease included.
  const rows: readonly (readonly [number, number, number, number, number, number])[] = [
    [0.8, 0.0, 0.1, 0.05, 0.06, 2.0],
    [0.835, 0.0, 0.16, 0.08, 0.1, 2.3],
    [0.875, -0.005, 0.18, 0.093, 0.122, 2.5],
    [0.93, -0.005, 0.182, 0.1, 0.123, 2.5],
    [0.985, 0.0, 0.171, 0.103, 0.108, 2.4],
    [1.03, 0.005, 0.163, 0.105, 0.098, 2.35],
    [1.08, 0.008, 0.162, 0.108, 0.097, 2.35],
    [1.15, 0.01, 0.168, 0.117, 0.105, 2.35],
    [1.22, 0.012, 0.176, 0.128, 0.115, 2.4],
    [1.275, 0.012, 0.18, 0.132, 0.118, 2.45],
    [1.325, 0.008, 0.184, 0.122, 0.118, 2.6],
    [1.375, 0.0, 0.19, 0.1, 0.11, 2.9],
    [1.41, -0.01, 0.188, 0.084, 0.096, 3.2],
    [1.44, -0.015, 0.14, 0.068, 0.078, 2.8],
    [1.468, -0.016, 0.075, 0.06, 0.064, 2.0],
  ];
  const y0 = rows[0]![0]!;
  addLoft(builder, {
    origin: [0, y0, 0],
    axis: [0, 1, 0],
    front: [1, 0, 0],
    keys: rows.map(([y, cx, hw, f, b, n]) => ({ t: y - y0, front: f, back: b, sideP: hw, sideN: hw, n, df: cx })),
    segments: lod.torsoSegments,
    ringsPerMeter: lod.ringsPerMeter,
    ringPerKey: lod.ringPerKey,
    startDome: 0.03,
    endDome: 0,
    weights: (p) => {
      const spine = spineWeights(p[1]);
      const lateral = Math.abs(p[2]);
      // The seat and the hips' sides follow their thigh; the shoulders' tops their clavicle, as the arm lifts.
      const thighShare = 0.65 * smoothstep(0.02, 0.12, lateral) * (1 - smoothstep(0.86, 0.99, p[1]));
      const clavicleShare = 0.6 * smoothstep(0.1, 0.17, lateral) * smoothstep(1.3, 1.38, p[1]);
      if (thighShare <= 0 && clavicleShare <= 0) return spine;
      const share = thighShare + clavicleShare;
      const bone = thighShare > 0
        ? (p[2] < 0 ? BONE.thighL : BONE.thighR)
        : (p[2] < 0 ? BONE.clavicleL : BONE.clavicleR);
      return [...spine.map((w) => ({ bone: w.bone, weight: w.weight * (1 - share) })), { bone, weight: share }];
    },
    finish: (p) => (p[1] < 0.995 ? "trousers" : p[1] < 1.03 ? "belt" : "jacket"),
  });
}

function neckAndHead(builder: MeshBuilder, lod: FigureLodSpec): void {
  addLoft(builder, {
    origin: [-0.012, 1.4, 0],
    axis: [0, 1, 0],
    front: [1, 0, 0],
    keys: [
      { t: 0, front: 0.056, back: 0.064, sideP: 0.066, sideN: 0.066, n: 2.1 },
      { t: 0.06, front: 0.054, back: 0.06, sideP: 0.06, sideN: 0.06, n: 2 },
      { t: 0.12, front: 0.051, back: 0.058, sideP: 0.056, sideN: 0.056, n: 2 },
      { t: 0.17, front: 0.05, back: 0.058, sideP: 0.055, sideN: 0.055, n: 2 },
    ],
    segments: Math.max(6, Math.round(lod.limbSegments * 0.8)),
    ringsPerMeter: lod.ringsPerMeter,
    ringPerKey: lod.ringPerKey,
    startDome: 0,
    endDome: 0,
    weights: (p) => (p[1] < 1.47 ? blend(BONE.spine3, BONE.neck, 1.42, 1.47, p[1]) : blend(BONE.neck, BONE.head, 1.53, 1.57, p[1])),
    finish: (p) => (p[1] < 1.455 ? "jacket" : "skin"),
  });
  // The head: rings up from under the jaw to the crown, then bumps for the face and ears.
  const headRows: readonly (readonly [number, number, number, number, number])[] = [
    [1.522, 0.045, 0.045, 0.048, 2],
    [1.54, 0.088, 0.058, 0.06, 2],
    [1.57, 0.098, 0.074, 0.068, 2.1],
    [1.605, 0.103, 0.088, 0.073, 2.2],
    [1.637, 0.104, 0.098, 0.077, 2.3],
    [1.667, 0.1, 0.103, 0.079, 2.3],
    [1.702, 0.092, 0.103, 0.078, 2.2],
    [1.73, 0.073, 0.09, 0.067, 2.1],
    [1.75, 0.04, 0.055, 0.04, 2],
  ];
  const y0 = headRows[0]![0]!;
  const cx = 0.008;
  const hairline = (p: Vec3): number => hairlineAt(Math.atan2(p[2], p[0] - cx));
  const headKeys: KeyRing[] = headRows.map(([y, f, b, s, n]) => ({ t: y - y0, front: f, back: b, sideP: s, sideN: s, n }));
  // Under a hair cap the head's own hair stays a ring clear of the cap's edge, so no step of it shows below.
  const hairMargin = lod.hairCap ? 0.012 : 0;
  addLoft(builder, {
    origin: [cx, y0, 0],
    axis: [0, 1, 0],
    front: [1, 0, 0],
    keys: headKeys,
    segments: lod.headSegments,
    ringsPerMeter: lod.headRings / (headRows[headRows.length - 1]![0]! - y0),
    ringPerKey: lod.ringPerKey,
    startDome: 0,
    endDome: 0.012,
    weights: () => [{ bone: BONE.head, weight: 1 }],
    finish: (p) => {
      if (p[1] > hairline(p) + hairMargin) return "hair";
      return p[0] > cx + 0.035 ? "face" : "skin";
    },
    displace: (p) => {
      const x = p[0] - cx;
      const y = p[1];
      const z = p[2];
      const g = (value: number, centre: number, sigma: number): number => Math.exp(-(((value - centre) / sigma) ** 2));
      if (x > 0) {
        const front = Math.min(1, x / 0.06);
        // Nose tip and bridge, brow, lips, chin; sockets pressed in.
        let dx = 0.021 * g(y, 1.613, 0.013) * g(z, 0, 0.011)
          + 0.009 * g(y, 1.645, 0.02) * g(z, 0, 0.008)
          + 0.004 * g(y, 1.668, 0.008) * g(Math.abs(z), 0.032, 0.022)
          + 0.004 * g(y, 1.578, 0.008) * g(z, 0, 0.018)
          + 0.007 * g(y, 1.547, 0.012) * g(z, 0, 0.02)
          - 0.006 * g(y, 1.647, 0.011) * g(Math.abs(z), 0.033, 0.013);
        dx *= front;
        p[0] += dx;
      }
      p[2] += Math.sign(z) * earBump(x, y);
      // Hair sits a little proud (the cap, where there is one, stands off instead).
      if (!lod.hairCap && y > hairline(p)) {
        const r = Math.hypot(x, y - 1.645, z) || 1;
        p[0] += (0.004 * x) / r;
        p[1] += (0.004 * (y - 1.645)) / r;
        p[2] += (0.004 * z) / r;
      }
    },
  });
  if (lod.hairCap) hairCap(builder, lod, [cx, y0, 0], headKeys);
}

/** The ears: how far the head's side stands out, metres, at (x from the head's centre, y). */
function earBump(x: number, y: number): number {
  const g = (value: number, centre: number, sigma: number): number => Math.exp(-(((value - centre) / sigma) ** 2));
  return 0.013 * g(y, 1.633, 0.022) * g(x, -0.01, 0.016);
}

/** The hairline's height round the head, by the angle from the front (+X) toward the right (+Z): the forehead, the temples over the ears, the nape. */
function hairlineAt(angle: number): number {
  return 1.655 + 0.062 * Math.cos(angle);
}

/**
 * Short hair as a shell over the skull: rows from the hairline, which runs
 * round the head at a slant (`hairlineAt`), up to the crown, standing off the
 * head's surface by 1.5 mm at its edge and 8.5 mm on top. Its edge follows
 * the hairline exactly, where hair painted on the head's level rings would
 * step at every ring.
 */
function hairCap(builder: MeshBuilder, lod: FigureLodSpec, origin: Vec3, keys: readonly KeyRing[]): void {
  const segments = lod.headSegments;
  const rows = Math.max(3, Math.round(lod.headRings / 3));
  // The head's last ring; the cap closes over the head's end dome.
  const top = keys[keys.length - 1]!.t + origin[1];
  const sectionAt = (y: number): Required<KeyRing> => {
    const t = y - origin[1];
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1]!.t < t) k += 1;
    const span = keys[k + 1]!.t - keys[k]!.t;
    return interpolateKey(keys, Math.min(keys.length - 1, k + Math.min(1, Math.max(0, (t - keys[k]!.t) / span))));
  };
  // As the head's loft: its section's side axis is up x front, which is -Z.
  const point = (y: number, angle: number, offset: number): Vec3 => {
    const [f, d] = sectionPoint(sectionAt(y), angle);
    const r = Math.hypot(f, d) || 1;
    const z = -d * (1 + offset / r);
    // Over the ears' tops as the head's skin is.
    return [origin[0] + f * (1 + offset / r), y, origin[2] + z + Math.sign(z) * earBump(f, y)];
  };
  const weights = [{ bone: BONE.head, weight: 1 }];
  const grid: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const v = row / (rows - 1);
    const offset = 0.0015 + 0.007 * smoothstep(0, 0.35, v);
    const line: number[] = [];
    for (let j = 0; j < segments; j += 1) {
      const angle = (2 * Math.PI * j) / segments;
      const base = hairlineAt(angle);
      line.push(builder.addVertex(point(base + (top - base) * v, angle, offset), "hair", weights));
    }
    grid.push(line);
  }
  for (let r = 0; r + 1 < grid.length; r += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = grid[r]![j]!;
      const b = grid[r]![(j + 1) % segments]!;
      const c = grid[r + 1]![(j + 1) % segments]!;
      const d = grid[r + 1]![j]!;
      builder.triangle(a, c, b, "hair");
      builder.triangle(a, d, c, "hair");
    }
  }
  // The crown: the head's end dome, raised by the cap's thickness.
  const pole = builder.addVertex([origin[0], top + 0.012 + 0.0085, origin[2]], "hair", weights);
  const last = grid[grid.length - 1]!;
  for (let j = 0; j < segments; j += 1) builder.triangle(pole, last[(j + 1) % segments]!, last[j]!, "hair");
}

function arm(builder: MeshBuilder, side: SideBones, lod: FigureLodSpec): void {
  const s = side.sign;
  const shoulder = bind(side.upperArm);
  const a = PROPORTIONS.bindArmAbduction;
  const down: Vec3 = [0, -Math.cos(a), s * Math.sin(a)];
  const elbowT = UPPER_ARM_LENGTH;
  const wristT = UPPER_ARM_LENGTH + FOREARM_LENGTH;
  // Front is +X; the section's "side" is axis x front, which points out for the right arm and in for the left.
  const out = (outer: number, inner: number): { sideP: number; sideN: number } => (s > 0 ? { sideP: outer, sideN: inner } : { sideP: inner, sideN: outer });
  const ring = (t: number, front: number, back: number, outer: number, inner: number, n = 2): KeyRing => ({ t, front, back, ...out(outer, inner), n });
  addLoft(builder, {
    origin: shoulder,
    axis: down,
    front: [1, 0, 0],
    keys: [
      ring(-0.03, 0.048, 0.048, 0.05, 0.046),
      ring(-0.005, 0.056, 0.056, 0.062, 0.05),
      ring(0.03, 0.06, 0.06, 0.064, 0.052),
      ring(0.09, 0.056, 0.056, 0.058, 0.05),
      ring(0.17, 0.05, 0.051, 0.05, 0.046),
      ring(elbowT - 0.03, 0.045, 0.047, 0.044, 0.042),
      ring(elbowT, 0.044, 0.047, 0.043, 0.041),
      ring(elbowT + 0.04, 0.047, 0.046, 0.044, 0.042),
      ring(elbowT + 0.11, 0.046, 0.043, 0.042, 0.04),
      ring(wristT - 0.05, 0.039, 0.037, 0.036, 0.034),
      ring(wristT - 0.015, 0.038, 0.037, 0.037, 0.035),
      ring(wristT - 0.004, 0.036, 0.035, 0.035, 0.033),
    ],
    segments: lod.armSegments,
    ringsPerMeter: lod.ringsPerMeter,
    ringPerKey: lod.ringPerKey,
    startDome: 0.02,
    endDome: 0.012,
    weights: (_p, t) => {
      if (t < 0.02) return [{ bone: side.upperArm, weight: 0.75 }, { bone: side.clavicle, weight: 0.25 }];
      if (t < elbowT + 0.06) return blend(side.upperArm, side.forearm, elbowT - 0.04, elbowT + 0.03, t);
      return blend(side.forearm, side.hand, wristT - 0.03, wristT + 0.01, t);
    },
    finish: () => "jacket",
  });
  // The hand: palm toward the thigh, thumb forward; a mitten of fingers.
  const wrist = bind(side.hand);
  const handSide = (outer: number, inner: number): { sideP: number; sideN: number } => out(outer, inner);
  const handRing = (t: number, front: number, back: number, outer: number, inner: number, n = 2.2): KeyRing => ({ t, front, back, ...handSide(outer, inner), n });
  addLoft(builder, {
    origin: wrist,
    axis: down,
    front: [1, 0, 0],
    keys: [
      handRing(-0.03, 0.022, 0.022, 0.019, 0.019, 2),
      handRing(0.0, 0.026, 0.026, 0.017, 0.017, 2.2),
      handRing(0.03, 0.04, 0.036, 0.016, 0.017, 2.6),
      handRing(PALM_LENGTH - 0.02, 0.044, 0.037, 0.014, 0.016, 2.8),
      handRing(PALM_LENGTH + 0.005, 0.042, 0.036, 0.012, 0.014, 2.6),
      handRing(PALM_LENGTH + 0.05, 0.038, 0.034, 0.011, 0.012, 2.5),
      handRing(PALM_LENGTH + 0.085, 0.028, 0.026, 0.01, 0.01, 2.2),
    ],
    segments: lod.handSegments,
    ringsPerMeter: lod.ringsPerMeter * 1.4,
    ringPerKey: lod.ringPerKey,
    startDome: 0,
    endDome: 0.012,
    weights: (_p, t) => (t < 0.0 ? blend(side.forearm, side.hand, -0.03, 0, t) : blend(side.hand, side.fingers, PALM_LENGTH - 0.012, PALM_LENGTH + 0.012, t)),
    finish: () => "skin",
  });
  const thumbBase = bind(side.thumb);
  const thumbAxis = normalize([0.62, -0.72 * Math.cos(a), s * 0.72 * Math.sin(a) - s * 0.3]);
  addLoft(builder, {
    origin: thumbBase,
    axis: thumbAxis,
    front: normalize(cross([0, 0, s], thumbAxis)),
    keys: [
      { t: -0.01, front: 0.013, back: 0.013, sideP: 0.012, sideN: 0.012, n: 2 },
      { t: 0.025, front: 0.012, back: 0.012, sideP: 0.011, sideN: 0.011, n: 2 },
      { t: 0.05, front: 0.01, back: 0.01, sideP: 0.0095, sideN: 0.0095, n: 2 },
    ],
    segments: Math.max(4, lod.handSegments - 2),
    ringsPerMeter: lod.ringsPerMeter,
    ringPerKey: lod.ringPerKey,
    startDome: 0,
    endDome: 0.009,
    weights: () => [{ bone: side.thumb, weight: 1 }],
    finish: () => "skin",
  });
}

function leg(builder: MeshBuilder, side: SideBones, lod: FigureLodSpec): void {
  const s = side.sign;
  const hip = bind(side.thigh);
  const knee = PROPORTIONS.kneeHeight;
  // Top down; front +X, side = axis x front: down x X = +Z, so sideP is +Z.
  const ring = (y: number, front: number, back: number, outer: number, inner: number, n = 2.1): KeyRing => ({
    t: hip[1] + 0.07 - y,
    front,
    back,
    ...(s > 0 ? { sideP: outer, sideN: inner } : { sideP: inner, sideN: outer }),
    n,
  });
  addLoft(builder, {
    origin: [hip[0], hip[1] + 0.07, hip[2]],
    axis: [0, -1, 0],
    front: [1, 0, 0],
    keys: [
      ring(hip[1] + 0.07, 0.08, 0.09, 0.09, 0.07),
      ring(hip[1], 0.094, 0.1, 0.104, 0.084),
      ring(0.86, 0.09, 0.094, 0.098, 0.08),
      ring(0.78, 0.082, 0.082, 0.087, 0.073),
      ring(0.7, 0.074, 0.07, 0.076, 0.064),
      ring(0.6, 0.066, 0.062, 0.066, 0.058),
      ring(knee + 0.02, 0.064, 0.058, 0.062, 0.056),
      ring(knee - 0.03, 0.06, 0.062, 0.059, 0.055),
      ring(0.4, 0.056, 0.068, 0.058, 0.055),
      ring(0.32, 0.054, 0.062, 0.055, 0.052),
      ring(0.24, 0.054, 0.058, 0.055, 0.053),
      ring(0.17, 0.058, 0.064, 0.06, 0.058),
      ring(0.135, 0.06, 0.066, 0.062, 0.06),
    ],
    segments: lod.limbSegments,
    ringsPerMeter: lod.ringsPerMeter,
    ringPerKey: lod.ringPerKey,
    startDome: 0,
    endDome: 0,
    weights: (p) => {
      if (p[1] > hip[1] - 0.04) return [{ bone: side.thigh, weight: 0.8 }, { bone: BONE.pelvis, weight: 0.2 }];
      if (p[1] > knee - 0.08) return blend(side.shin, side.thigh, knee - 0.035, knee + 0.035, p[1]);
      return blend(side.foot, side.shin, 0.12, 0.2, p[1]);
    },
    finish: () => "trousers",
  });
  // The boot: a shaft round the ankle and a foot from heel to toe, sole underneath.
  const ankle = bind(side.foot);
  addLoft(builder, {
    origin: [ankle[0] - 0.005, 0.02, ankle[2]],
    axis: [0, 1, 0],
    front: [1, 0, 0],
    keys: [
      { t: 0, front: 0.05, back: 0.058, sideP: 0.046, sideN: 0.046, n: 2.2 },
      { t: 0.06, front: 0.05, back: 0.054, sideP: 0.046, sideN: 0.046, n: 2.1 },
      { t: 0.12, front: 0.052, back: 0.055, sideP: 0.05, sideN: 0.05, n: 2 },
      { t: 0.16, front: 0.054, back: 0.057, sideP: 0.052, sideN: 0.052, n: 2 },
    ],
    segments: lod.footSegments,
    ringsPerMeter: lod.ringsPerMeter,
    ringPerKey: lod.ringPerKey,
    startDome: 0,
    endDome: 0,
    weights: (p) => blend(side.foot, side.shin, 0.09, 0.16, p[1]),
    finish: () => "boot",
  });
  const footAngle = s * (6 * Math.PI) / 180;
  const along: Vec3 = [Math.cos(footAngle), 0, Math.sin(footAngle)];
  const heelX = -PROPORTIONS.heelBack - 0.012;
  const ballT = PROPORTIONS.ballForward - heelX;
  const toeT = PROPORTIONS.toeForward + 0.012 - heelX;
  // Sections: a rounded box standing on the sole (y = 0), front = up here, side = along x up.
  const footRing = (t: number, height: number, halfWidth: number): KeyRing => ({
    t,
    front: height / 2,
    back: height / 2,
    sideP: halfWidth,
    sideN: halfWidth,
    n: 3.2,
    df: height / 2,
  });
  addLoft(builder, {
    origin: [ankle[0] + heelX * along[0], 0, ankle[2] + heelX * along[2]],
    axis: along,
    front: [0, 1, 0],
    keys: [
      footRing(0, 0.085, 0.034),
      footRing(0.03, 0.105, 0.04),
      footRing(0.09, 0.098, 0.044),
      footRing(0.15, 0.072, 0.05),
      footRing(ballT, 0.056, 0.052),
      footRing(ballT + 0.04, 0.046, 0.048),
      footRing(toeT - 0.02, 0.04, 0.04),
    ],
    segments: lod.footSegments,
    ringsPerMeter: lod.ringsPerMeter * 1.2,
    ringPerKey: lod.ringPerKey,
    startDome: 0.018,
    endDome: 0.024,
    weights: (p) => {
      const t = (p[0] - ankle[0]) * along[0] + (p[2] - ankle[2]) * along[2] - heelX;
      return blend(side.foot, side.toe, ballT - 0.02, ballT + 0.015, t);
    },
    finish: (p) => (p[1] < 0.016 ? "sole" : "boot"),
  });
}

/** One level of detail of the figure, bind pose, with its per-vertex occlusion baked into the swatches' shade. */
export function buildFigureGeometry(lod: FigureLodSpec): FigureGeometry {
  const builder = new MeshBuilder();
  torso(builder, lod);
  neckAndHead(builder, lod);
  for (const side of SIDES) {
    arm(builder, side, lod);
    leg(builder, side, lod);
  }
  // Normals on the shared topology, so a finish's edge is not a crease.
  const sharedNormals = computeNormals(builder.positions, builder.indices);
  // Every triangle wears one finish: a corner of another is split off.
  const vertexOf: number[] = [];
  const finishOf: FinishKey[] = [];
  const split = new Map<string, number>();
  const indices = new Uint32Array(builder.indices.length);
  const take = (vertex: number, finish: FinishKey): number => {
    if (builder.finishes[vertex] === finish && vertexOf[vertex] === vertex) return vertex;
    const key = `${vertex}:${finish}`;
    let index = split.get(key);
    if (index === undefined) {
      index = vertexOf.length;
      vertexOf.push(vertex);
      finishOf.push(finish);
      split.set(key, index);
    }
    return index;
  };
  for (let v = 0; v < builder.vertexCount; v += 1) {
    vertexOf.push(v);
    finishOf.push(builder.finishes[v]!);
  }
  for (let i = 0; i < builder.indices.length; i += 3) {
    const corners = [builder.indices[i]!, builder.indices[i + 1]!, builder.indices[i + 2]!];
    const f = corners.map((v) => builder.finishes[v]!);
    const finish = (builder.triangleFinishes[i / 3] ?? (f[1] === f[2] ? f[1] : f[0]))!;
    for (let c = 0; c < 3; c += 1) indices[i + c] = take(corners[c]!, finish);
  }
  const count = vertexOf.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const matricesIndices = new Float32Array(count * 4);
  const matricesWeights = new Float32Array(count * 4);
  for (let v = 0; v < count; v += 1) {
    const source = vertexOf[v]!;
    for (let axis = 0; axis < 3; axis += 1) {
      positions[v * 3 + axis] = builder.positions[source * 3 + axis]!;
      normals[v * 3 + axis] = sharedNormals[source * 3 + axis]!;
    }
    for (let k = 0; k < 4; k += 1) {
      matricesIndices[v * 4 + k] = builder.boneIndices[source * 4 + k]!;
      matricesWeights[v * 4 + k] = builder.boneWeights[source * 4 + k]!;
    }
    const finish = finishOf[v]!;
    let uv: readonly [number, number];
    if (finish === "face") {
      uv = faceUv(positions[v * 3 + 2]!, positions[v * 3 + 1]!);
    } else {
      uv = swatchUv(finish, occlusionAt(positions, normals, v, builder.ownBone[source]!));
    }
    uvs[v * 2] = uv[0];
    uvs[v * 2 + 1] = uv[1];
  }
  return { positions, normals, uvs, indices, matricesIndices, matricesWeights };
}

function computeNormals(positions: readonly number[], indices: readonly number[]): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    // Babylon's convention for a triangle (a, b, c): (a - b) x (c - b) faces out.
    const abx = positions[a]! - positions[b]!;
    const aby = positions[a + 1]! - positions[b + 1]!;
    const abz = positions[a + 2]! - positions[b + 2]!;
    const cbx = positions[c]! - positions[b]!;
    const cby = positions[c + 1]! - positions[b + 1]!;
    const cbz = positions[c + 2]! - positions[b + 2]!;
    const nx = aby * cbz - abz * cby;
    const ny = abz * cbx - abx * cbz;
    const nz = abx * cby - aby * cbx;
    for (const v of [a, b, c]) {
      normals[v] = normals[v]! + nx;
      normals[v + 1] = normals[v + 1]! + ny;
      normals[v + 2] = normals[v + 2]! + nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v]!, normals[v + 1]!, normals[v + 2]!) || 1;
    normals[v] = normals[v]! / l;
    normals[v + 1] = normals[v + 1]! / l;
    normals[v + 2] = normals[v + 2]! / l;
  }
  return normals;
}

/** The body as capsules in the bind pose for the occlusion bake: two bones and a radius. */
const OCCLUDERS: readonly (readonly [number, number, number])[] = [
  [BONE.pelvis, BONE.spine2, 0.15],
  [BONE.spine2, BONE.neck, 0.15],
  [BONE.thighL, BONE.shinL, 0.085],
  [BONE.shinL, BONE.footL, 0.055],
  [BONE.thighR, BONE.shinR, 0.085],
  [BONE.shinR, BONE.footR, 0.055],
  [BONE.upperArmL, BONE.forearmL, 0.05],
  [BONE.forearmL, BONE.handL, 0.042],
  [BONE.upperArmR, BONE.forearmR, 0.05],
  [BONE.forearmR, BONE.handR, 0.042],
  [BONE.neck, BONE.head, 0.06],
];

/** Which part of the body each bone belongs to: trunk 0, head 1, left arm 2, right arm 3, left leg 4, right leg 5. */
const BONE_PART: Int8Array = (() => {
  const part = new Int8Array(BIND_POSITIONS.length / 3);
  part[BONE.neck] = 1;
  part[BONE.head] = 1;
  for (const side of SIDES) {
    for (const bone of [side.clavicle, side.upperArm, side.forearm, side.hand, side.fingers, side.thumb]) part[bone] = side.sign < 0 ? 2 : 3;
    for (const bone of [side.thigh, side.shin, side.foot, side.toe]) part[bone] = side.sign < 0 ? 4 : 5;
  }
  return part;
})();

function partOf(bone: number): number {
  return BONE_PART[bone]!;
}

/**
 * Ambient occlusion at a vertex from the body's OTHER parts, as capsules in
 * the bind pose (a sphere's (r / d)^2 times the cosine toward it), and from
 * the ground under the boots: the armpits, the inner thighs, under the chin
 * and the boots' lower edges read darker. 0 open .. `MAX_SHADE`.
 */
function occlusionAt(positions: Float32Array, normals: Float32Array, v: number, ownBone: number): number {
  const own = partOf(ownBone);
  const px = positions[v * 3]!;
  const py = positions[v * 3 + 1]!;
  const pz = positions[v * 3 + 2]!;
  const nx = normals[v * 3]!;
  const ny = normals[v * 3 + 1]!;
  const nz = normals[v * 3 + 2]!;
  let occlusion = 0;
  for (const [a, b, radius] of OCCLUDERS) {
    const part = partOf(a);
    if (part === own) continue;
    // The trunk does not shade its own neck, nor the neck the trunk.
    if ((part === 0 && own === 1) || (part === 1 && own === 0)) continue;
    const ax = BIND_POSITIONS[a * 3]!;
    const ay = BIND_POSITIONS[a * 3 + 1]!;
    const az = BIND_POSITIONS[a * 3 + 2]!;
    const bx = BIND_POSITIONS[b * 3]! - ax;
    const by = BIND_POSITIONS[b * 3 + 1]! - ay;
    const bz = BIND_POSITIONS[b * 3 + 2]! - az;
    const t = Math.min(1, Math.max(0, ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / (bx * bx + by * by + bz * bz)));
    const dx = ax + bx * t - px;
    const dy = ay + by * t - py;
    const dz = az + bz * t - pz;
    const distance = Math.hypot(dx, dy, dz) || 1;
    const facing = Math.max(0, (dx * nx + dy * ny + dz * nz) / distance);
    occlusion += facing * Math.min(1, (radius / Math.max(radius, distance)) ** 2);
  }
  // The ground: a plane under the feet, felt within a hand's breadth.
  occlusion += Math.max(0, -ny) * Math.max(0, 1 - py / 0.12) * 0.6;
  return Math.min(MAX_SHADE, occlusion * 0.8);
}
