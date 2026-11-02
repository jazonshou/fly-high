/**
 * The walker's body: MakeHuman's base mesh shaped to a young adult man (a
 * third each of its African, Asian and Caucasian young-male targets, so no
 * one population's averages and no one person), turned into the walker's
 * frame and metres, and fitted onto the walker's skeleton.
 *
 * The base mesh carries, besides the skin ("body"), helper shells MakeHuman
 * fits its proxies to: a skin-tight suit over the torso and legs
 * ("helper-tights"), a cap over the scalp ("helper-hair"), the eyes and the
 * lashes. Every vertex, helpers included, has skin weights and follows the
 * targets, so the helpers come out of the fit already shaped to this body.
 */
import { BONE, BONE_COUNT } from "../../src/render/webgpu/person/skeleton";
import { PROPORTIONS } from "../../src/render/webgpu/person/figureProportions";
import { applyTarget, parseObj, parseSkeleton, parseWeights, type ObjFace, type SOURCE_FILES } from "./sources.mts";
import { applyMap, fitMaps, retarget, skeletonJoints, walkerWeights, type FitReport, type VertexWeights } from "./retarget.mts";
import type { V3 } from "./math.mts";
import { relaxHands, type HandReport } from "./hands.mts";

type Read = (path: (typeof SOURCE_FILES)[number]) => string;

export interface FittedBody {
  /** Every base-mesh vertex (helpers too), fitted, walker frame, metres. */
  readonly positions: Float64Array;
  /** The same before the fit (shaped and converted only). */
  readonly unfitted: Float64Array;
  readonly uvs: Float64Array;
  readonly faces: readonly ObjFace[];
  readonly weights: VertexWeights;
  readonly fit: FitReport;
  readonly hands: HandReport;
  /** A MakeHuman joint's fitted position (its helper cube's mean). */
  readonly joint: (name: string) => V3;
  readonly unfittedJoint: (name: string) => V3;
  /** The shaped mesh in MakeHuman's own frame and decimetres (for fitting its proxies, as MakeHuman does). */
  readonly mh: Float64Array;
  /** A point on the head in MakeHuman's frame, into the fitted walker's. */
  readonly headPoint: (mh: V3) => V3;
}

export const TARGET_WEIGHTS = Object.freeze({
  "makehuman/data/targets/macrodetails/african-male-young.target": 1 / 3,
  "makehuman/data/targets/macrodetails/asian-male-young.target": 1 / 3,
  "makehuman/data/targets/macrodetails/caucasian-male-young.target": 1 / 3,
} as const);

export function buildBody(read: Read): FittedBody {
  const obj = parseObj(read("makehuman/data/3dobjs/base.obj"));
  const mh = Float64Array.from(obj.positions);
  for (const [path, weight] of Object.entries(TARGET_WEIGHTS)) applyTarget(mh, read(path as keyof typeof TARGET_WEIGHTS), weight);

  // Into the walker's frame: +X forward (MakeHuman's +Z), +Y up, +Z right (MakeHuman's -X), metres (MakeHuman's are decimetres).
  const n = mh.length / 3;
  const ours = new Float64Array(mh.length);
  for (let v = 0; v < n; v += 1) {
    ours[v * 3] = mh[v * 3 + 2]! * 0.1;
    ours[v * 3 + 1] = mh[v * 3 + 1]! * 0.1;
    ours[v * 3 + 2] = -mh[v * 3]! * 0.1;
  }
  // The soles on y = 0 (the skin's lowest point), the ankles over x = 0.
  const bodyVertices = new Set<number>();
  for (const face of obj.faces) if (face.group === "body") for (const v of face.vertices) bodyVertices.add(v);
  let sole = Infinity;
  let top = -Infinity;
  for (const v of bodyVertices) {
    sole = Math.min(sole, ours[v * 3 + 1]!);
    top = Math.max(top, ours[v * 3 + 1]!);
  }
  const skeleton = parseSkeleton(read("makehuman/data/rigs/default.mhskel"));
  const rawJoint = skeletonJoints(skeleton, ours);
  const ankleX = (rawJoint("foot.L____head")[0] + rawJoint("foot.R____head")[0]) / 2;
  for (let v = 0; v < n; v += 1) {
    ours[v * 3]! -= ankleX;
    ours[v * 3 + 1]! -= sole;
  }
  const unfittedJoint = skeletonJoints(skeleton, ours);
  const mhWeights = parseWeights(read("makehuman/data/rigs/default_weights.mhw"));
  const weights = walkerWeights(mhWeights, n);
  const fit = fitMaps(unfittedJoint, top - sole, PROPORTIONS.stature);
  if (fit.maps.length !== BONE_COUNT || fit.maps.some((m) => !m)) throw new Error("walker body: a bone has no map");
  const positions = retarget(ours, weights, fit.maps);
  const hands = relaxHands(positions, mhWeights, skeletonJoints(skeleton, positions));
  const headPoint = (q: V3): V3 => applyMap(fit.maps[BONE.head]!, [q[2] * 0.1 - ankleX, q[1] * 0.1 - sole, -q[0] * 0.1]);
  return { positions, unfitted: ours, uvs: obj.uvs, faces: obj.faces, weights, fit, hands, joint: skeletonJoints(skeleton, positions), unfittedJoint, mh, headPoint };
}
