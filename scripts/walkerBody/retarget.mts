/**
 * Fits MakeHuman's body onto the walker's skeleton (`BIND_POSITIONS`), so the
 * figure's motion, which poses that skeleton, drives it unchanged.
 *
 * Each walker bone gets an affine map from the MakeHuman joint it stands for
 * to its own bind joint: a turn that lays the MakeHuman bone along the
 * walker's (straightening MakeHuman's bent elbows and spread legs into the
 * walker's bind pose, arms 11 degrees out, feet under the hips), a stretch
 * along the bone to the walker's segment length, and the overall scale to the
 * walker's stature across it. A vertex moves by its skin weights' blend of
 * those maps (linear blend skinning), so the body bends smoothly at the
 * joints, as it would posed.
 */
import { BIND_POSITIONS, BONE, BONE_COUNT, SIDES } from "../../src/render/webgpu/person/skeleton";
import { IDENTITY, add, cross, dot, frame, mulMM, mulMV, normalize, rotationBetween, scale, sub, transpose, type M3, type V3 } from "./math.mts";
import type { MhSkeleton } from "./sources.mts";

/** The walker bone a MakeHuman bone's weights go to. */
export function walkerBoneFor(mhBone: string): number {
  const side = mhBone.endsWith(".L") ? SIDES[0]! : mhBone.endsWith(".R") ? SIDES[1]! : null;
  const name = mhBone.replace(/\.(L|R)$/, "");
  if (side) {
    if (name === "clavicle" || name === "shoulder01") return side.clavicle;
    if (name.startsWith("upperarm")) return side.upperArm;
    if (name.startsWith("lowerarm")) return side.forearm;
    if (name === "wrist" || name.startsWith("metacarpal")) return side.hand;
    if (name.startsWith("finger1-")) return side.thumb;
    if (name.startsWith("finger")) return side.fingers;
    if (name.startsWith("upperleg")) return side.thigh;
    if (name.startsWith("lowerleg")) return side.shin;
    if (name === "foot") return side.foot;
    if (name.startsWith("toe")) return side.toe;
    if (name === "pelvis") return BONE.pelvis;
    if (name === "breast") return BONE.spine3;
    // The face's paired muscles and the eyes.
    return BONE.head;
  }
  if (name === "root" || name === "spine05") return BONE.pelvis;
  if (name === "spine04" || name === "spine03") return BONE.spine1;
  if (name === "spine02") return BONE.spine2;
  if (name === "spine01") return BONE.spine3;
  if (name.startsWith("neck")) return BONE.neck;
  return BONE.head;
}

export interface VertexWeights {
  /** Four walker bones and weights per vertex. */
  readonly bones: Uint8Array;
  readonly weights: Float32Array;
}

export function walkerWeights(mh: Readonly<Record<string, readonly (readonly [number, number])[]>>, vertexCount: number): VertexWeights {
  const sums = new Float64Array(vertexCount * BONE_COUNT);
  for (const [bone, list] of Object.entries(mh)) {
    const ours = walkerBoneFor(bone);
    for (const [vertex, weight] of list) sums[vertex * BONE_COUNT + ours]! += weight;
  }
  const bones = new Uint8Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v += 1) {
    const ranked: [number, number][] = [];
    for (let b = 0; b < BONE_COUNT; b += 1) {
      const w = sums[v * BONE_COUNT + b]!;
      if (w > 1e-4) ranked.push([b, w]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 4);
    const total = top.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) {
      bones[v * 4] = BONE.pelvis;
      weights[v * 4] = 1;
      continue;
    }
    top.forEach(([b, w], i) => {
      bones[v * 4 + i] = b;
      weights[v * 4 + i] = w / total;
    });
  }
  return { bones, weights };
}

/** A walker bone's map: v -> target + targetFrame * diag(axial, across, across) * sourceFrame^T * (v - source). */
export interface BoneMap {
  readonly source: V3;
  readonly target: V3;
  readonly sourceFrame: M3;
  readonly targetFrame: M3;
  readonly axial: number;
  readonly across: number;
}

export function applyMap(map: BoneMap, v: V3): V3 {
  const local = mulMV(transpose(map.sourceFrame), sub(v, map.source));
  return add(map.target, mulMV(map.targetFrame, [local[0] * map.axial, local[1] * map.across, local[2] * map.across]));
}

const bind = (bone: number): V3 => [BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!];

export interface FitReport {
  readonly maps: readonly BoneMap[];
  /** Where MakeHuman's thumb base lands, per side, against the walker's thumb bone. */
  readonly thumbOffsets: readonly number[];
  /** The turn about the forearm that brought the palms to face the thighs, per side, radians. */
  readonly palmTwists: readonly number[];
}

/**
 * The maps. `joint(name)` is a MakeHuman joint's position (the mean of its
 * helper cube's vertices) in the walker's frame and metres, before any fit;
 * `stature` that body's height.
 */
export function fitMaps(joint: (name: string) => V3, mhStature: number, statureTarget: number): FitReport {
  const across = statureTarget / mhStature;
  const maps: BoneMap[] = new Array(BONE_COUNT);

  // The trunk, neck and head as one block, scaled about the hips: MakeHuman's
  // own proportions there (its neck is shorter than the spacing of the
  // walker's neck and head pivots, and stretching it to them read as a long
  // neck), the walker's bones turning it about their own pivots.
  const hipL = joint("upperleg01.L____head");
  const hipR = joint("upperleg01.R____head");
  const hips = scale(add(hipL, hipR), 0.5);
  const trunk = (): BoneMap => ({ source: hips, target: bind(BONE.pelvis), sourceFrame: [...IDENTITY], targetFrame: [...IDENTITY], axial: across, across });
  for (const bone of [BONE.root, BONE.pelvis, BONE.spine1, BONE.spine2, BONE.spine3, BONE.neck, BONE.head]) maps[bone] = trunk();

  // A bone laid from `s0` toward `s1` (MakeHuman) onto `t0` toward `t1` (walker), its twist set by `reference`.
  const segment = (bone: number, s0: V3, s1: V3, t0: V3, t1: V3, reference: V3, axialLength?: number): BoneMap => {
    const sourceFrame = frame(sub(s1, s0), reference);
    const targetFrame = frame(sub(t1, t0), reference);
    const sl = Math.hypot(...sub(s1, s0));
    const tl = axialLength ?? Math.hypot(...sub(t1, t0));
    return { source: s0, target: t0, sourceFrame, targetFrame, axial: tl / sl, across };
  };

  const thumbOffsets: number[] = [];
  const palmTwists: number[] = [];
  for (const side of SIDES) {
    const L = side.sign < 0 ? "L" : "R";
    const j = (name: string, end: "head" | "tail" = "head") => joint(`${name}.${L}____${end}`);
    // Legs: twist from the body's forward.
    const ball = scale(add(add(j("toe1-1"), j("toe3-1")), j("toe5-1")), 1 / 3);
    const toeTip = j("toe3-3", "tail");
    maps[side.thigh] = segment(side.thigh, j("upperleg01"), j("lowerleg01"), bind(side.thigh), bind(side.shin), [1, 0, 0]);
    maps[side.shin] = segment(side.shin, j("lowerleg01"), j("foot"), bind(side.shin), bind(side.foot), [1, 0, 0]);
    maps[side.foot] = segment(side.foot, j("foot"), ball, bind(side.foot), bind(side.toe), [0, 1, 0]);
    const ourTip: V3 = add(bind(side.toe), [0.0774, -0.012, 0]);
    maps[side.toe] = segment(side.toe, ball, toeTip, bind(side.toe), ourTip, [0, 1, 0], Math.hypot(...sub(toeTip, ball)) * across);

    // Clavicle: from the sternal end out to the shoulder joint.
    maps[side.clavicle] = segment(side.clavicle, j("clavicle"), j("upperarm01"), bind(side.clavicle), bind(side.upperArm), [0, 1, 0]);

    // The arm: the upper arm laid along the walker's, twist from the forward; the
    // forearm, hand and fingers each straightened onto it by the least turn.
    const shoulder = j("upperarm01");
    const elbow = j("lowerarm01");
    const wrist = j("wrist");
    const knuckle = j("finger3-1");
    const fingertip = j("finger3-3", "tail");
    const upper = segment(side.upperArm, shoulder, elbow, bind(side.upperArm), bind(side.forearm), [1, 0, 0]);
    maps[side.upperArm] = upper;
    const armDir = normalize(sub(bind(side.forearm), bind(side.upperArm)));
    // The turn the upper arm's map applies, as a rotation.
    const turnOf = (m: BoneMap): M3 => mulMM(m.targetFrame, transpose(m.sourceFrame));
    const chain = (prev: M3, from: V3, to: V3): M3 => mulMM(rotationBetween(mulMV(prev, normalize(sub(to, from))), armDir), prev);
    let rForearm = chain(turnOf(upper), elbow, wrist);
    let rHand = chain(rForearm, wrist, knuckle);
    // Palms to the thighs: the palm's normal (back of the hand outward) turned about the arm until it faces the body's side.
    const across2 = normalize(sub(j("finger2-1"), j("finger5-1")));
    const palmAcross = mulMV(rHand, across2);
    // Wanted: the index knuckle forward of the little one (thumb forward), the palm facing in.
    const wantAcross = normalize(sub([1, 0, 0], scale(armDir, dot([1, 0, 0], armDir))));
    const got = normalize(sub(palmAcross, scale(armDir, dot(palmAcross, armDir))));
    const twist = Math.atan2(dot(cross(got, wantAcross), armDir), dot(got, wantAcross));
    palmTwists.push(twist);
    const twistTurn = rotationAbout(armDir, twist);
    rForearm = mulMM(rotationAbout(armDir, twist * 0.5), rForearm);
    rHand = mulMM(twistTurn, rHand);
    const rFingers = chain(rHand, knuckle, fingertip);
    const sFore = Math.hypot(...sub(wrist, elbow));
    const sHand = Math.hypot(...sub(knuckle, wrist));
    const rotMap = (bone: number, source: V3, rotation: M3, axialLength: number | null, sourceLength: number): BoneMap => {
      // Express the rotation as source/target frames sharing the source's axes.
      const dir = rotation === null ? armDir : armDir;
      const sourceFrame = frame(mulMV(transpose(rotation), dir), mulMV(transpose(rotation), [1, 0, 0]));
      const targetFrame = mulMM(rotation, sourceFrame);
      return { source, target: bind(bone), sourceFrame, targetFrame, axial: (axialLength ?? sourceLength * across) / sourceLength, across };
    };
    maps[side.forearm] = rotMap(side.forearm, elbow, rForearm, Math.hypot(...sub(bind(side.hand), bind(side.forearm))), sFore);
    maps[side.hand] = rotMap(side.hand, wrist, rHand, Math.hypot(...sub(bind(side.fingers), bind(side.hand))), sHand);
    maps[side.fingers] = rotMap(side.fingers, knuckle, rFingers, null, Math.hypot(...sub(fingertip, knuckle)));
    // The thumb rides with the hand; where its base lands is reported.
    const handMap = maps[side.hand]!;
    maps[side.thumb] = { ...handMap };
    thumbOffsets.push(Math.hypot(...sub(applyMap(handMap, j("finger1-2")), bind(side.thumb))));
  }
  return { maps, thumbOffsets, palmTwists };
}

function rotationAbout(axis: V3, angle: number): M3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [x, y, z] = normalize(axis);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

/** Every vertex moved by its weights' blend of the bone maps. */
export function retarget(positions: Float64Array, weights: VertexWeights, maps: readonly BoneMap[]): Float64Array {
  const out = new Float64Array(positions.length);
  const n = positions.length / 3;
  for (let v = 0; v < n; v += 1) {
    const p: V3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < 4; i += 1) {
      const w = weights.weights[v * 4 + i]!;
      if (w <= 0) continue;
      const q = applyMap(maps[weights.bones[v * 4 + i]!]!, p);
      x += q[0] * w;
      y += q[1] * w;
      z += q[2] * w;
    }
    out[v * 3] = x;
    out[v * 3 + 1] = y;
    out[v * 3 + 2] = z;
  }
  return out;
}

export function skeletonJoints(skeleton: MhSkeleton, positions: Float64Array): (name: string) => V3 {
  const cache = new Map<string, V3>();
  return (name) => {
    let p = cache.get(name);
    if (!p) {
      const list = skeleton.joints[name];
      if (!list) throw new Error(`walker body: no MakeHuman joint ${name}`);
      let x = 0;
      let y = 0;
      let z = 0;
      for (const v of list) {
        x += positions[v * 3]!;
        y += positions[v * 3 + 1]!;
        z += positions[v * 3 + 2]!;
      }
      p = [x / list.length, y / list.length, z / list.length];
      cache.set(name, p);
    }
    return p;
  };
}
