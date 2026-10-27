import { clamp, smoothstep } from "./noise";
import type { InfrastructureProfileSample, InfrastructureSegment } from "./infrastructure";

/**
 * The roads' earthwork profiles for the infrastructure stage
 * (`infrastructure.ts` states the contract; `roads/roadInfrastructure.ts`
 * lays the segments out from the network's pieces and pads). Each is a CPU
 * function and its WGSL transliteration, listed in `INFRASTRUCTURE_PROFILES`.
 *
 * A road is a chain of straight pieces, each its own segment, composed in
 * the chain's order (the order key). Two neighbours overlap round the joint
 * between them, so each piece fades IN over the first `ROAD_JOIN_BLEND_METERS`
 * behind its start and carries its far end's round cap at full weight: the
 * later piece then takes over from the earlier one continuously, and the cap
 * fills the wedge on the outside of a bend. Every weight is continuous and
 * every target continuous in the ground, so the stage never steps and the GPU
 * twin (f32) stays within a millimetre of this one.
 *
 * Batters run 1:2 in fill and 1:1.5 in cut, from the formation's edge until
 * they meet the ground; a cutting has a ditch at its foot. The segment's
 * `reach` is sized by the layout to where the batters meet the ground, so
 * the fade over its last 30% only matters where they could not.
 */

/** Batter runs, metres horizontal per metre vertical. `roadClasses.ts` names the same two. */
export const ROAD_FILL_BATTER_RUN = 2;
export const ROAD_CUT_BATTER_RUN = 1.5;
/** Over this length behind its start a piece fades in over the piece before it, metres. */
export const ROAD_JOIN_BLEND_METERS = 1;

/** Rise per metre to the right of the crown, for a cross slope `c` and a cross-fall `k` (the crown's runoff). */
function rightSlope(c: number, k: number): number {
  return Math.min(c, Math.max(2 * c - k, -k));
}

/**
 * The formation's height off the centreline: a crown falling `k` each side
 * on a straight, a single plane rising `c` to the right on a superelevated
 * curve, and between the two the outer half rotating about the centreline
 * while the inner keeps its fall (the usual superelevation runoff).
 */
export function roadCrossOffset(across: number, c: number, k: number): number {
  return across >= 0 ? rightSlope(c, k) * across : rightSlope(-c, k) * -across;
}

/** The batter beyond the formation edge at height `edge`, `beyond` metres out, over `ground`. */
export function roadBatterTarget(
  edge: number,
  beyond: number,
  ground: number,
  ditchDepth: number,
  ditchWidth: number,
): number {
  const fill = edge - beyond / ROAD_FILL_BATTER_RUN;
  const cut = ditchWidth > 0 && beyond <= ditchWidth
    ? edge - (ditchDepth * beyond) / ditchWidth
    : edge - ditchDepth + (beyond - ditchWidth) / ROAD_CUT_BATTER_RUN;
  return Math.min(Math.max(ground, fill), cut);
}

/**
 * `carriageway`: one straight piece of a road. A track is one with no
 * cross-fall, no superelevation and no ditch (two ruts on a level
 * formation; the ruts are paint and the near ribbons').
 *
 * params[0], params[1]: centreline height at a and at b, metres above sea
 *            level (linear between, and carried on at the piece's grade past b).
 * params[2], params[3]: cross slope at a and at b, rise per metre to the
 *            right of a->b (superelevation; 0 on a crowned straight).
 * params[4]: cross-fall each side of the crown, rise per metre.
 * params[5], params[6]: the ditch at a cutting's foot: depth and width
 *            (formation edge to the ditch's bottom), metres; depth/width at
 *            most 1/2, so the cut never undercuts the fill.
 */
export function roadCarriagewayHeight(
  along: number,
  across: number,
  length: number,
  segment: InfrastructureSegment,
  ground: number,
  seaLevel: number,
  out: InfrastructureProfileSample,
): void {
  const enter = smoothstep(-ROAD_JOIN_BLEND_METERS, 0, along);
  if (!(enter > 0)) {
    out.target = ground;
    out.weight = 0;
    return;
  }
  const p = segment.params;
  const ha = seaLevel + (p[0] ?? 0);
  const hb = seaLevel + (p[1] ?? 0);
  const ca = p[2] ?? 0;
  const cb = p[3] ?? 0;
  const crossfall = p[4] ?? 0;
  const grade = length > 0 ? (hb - ha) / length : 0;
  const half = segment.halfWidth;
  // Past b, the round cap: distances are radial from b. Before a (the join
  // band), the body's.
  const past = Math.max(0, along - length);
  const radial = Math.hypot(past, across);
  if (radial <= half) {
    const c = length > 0 ? ca + (cb - ca) * clamp(along / length, 0, 1) : ca;
    out.target = ha + grade * along + roadCrossOffset(across, c, crossfall);
    out.weight = enter;
    return;
  }
  // The formation edge on the way out from the centreline.
  const scale = half / radial;
  const edgeAlong = Math.min(along, length) + past * scale;
  const edgeAcross = across * scale;
  const c = length > 0 ? ca + (cb - ca) * clamp(edgeAlong / length, 0, 1) : ca;
  const edge = ha + grade * edgeAlong + roadCrossOffset(edgeAcross, c, crossfall);
  const beyond = radial - half;
  out.target = roadBatterTarget(edge, beyond, ground, p[5] ?? 0, p[6] ?? 0);
  out.weight = enter * (1 - smoothstep(0.7 * segment.reach, segment.reach, beyond));
}

const ROAD_COMMON_WGSL = /* wgsl */ `
const K_ROAD_FILL_RUN: f32 = ${ROAD_FILL_BATTER_RUN.toFixed(4)};
const K_ROAD_CUT_RUN: f32 = ${ROAD_CUT_BATTER_RUN.toFixed(4)};

fn terrainInfraRoadRightSlope(c: f32, k: f32) -> f32 {
  return min(c, max(2.0 * c - k, -k));
}

fn terrainInfraRoadCrossOffset(across: f32, c: f32, k: f32) -> f32 {
  if (across >= 0.0) { return terrainInfraRoadRightSlope(c, k) * across; }
  return terrainInfraRoadRightSlope(-c, k) * -across;
}

fn terrainInfraRoadBatter(edge: f32, beyond: f32, ground: f32, ditchDepth: f32, ditchWidth: f32) -> f32 {
  let fill = edge - beyond / K_ROAD_FILL_RUN;
  var cut: f32;
  if (ditchWidth > 0.0 && beyond <= ditchWidth) {
    cut = edge - (ditchDepth * beyond) / ditchWidth;
  } else {
    cut = edge - ditchDepth + (beyond - ditchWidth) / K_ROAD_CUT_RUN;
  }
  return min(max(ground, fill), cut);
}
`;

const ROAD_CARRIAGEWAY_WGSL = /* wgsl */ `
fn terrainInfra_carriageway(
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  let enter = kSmoothstep(-${ROAD_JOIN_BLEND_METERS.toFixed(4)}, 0.0, along);
  if (!(enter > 0.0)) { return vec2f(ground, 0.0); }
  let segmentLength = seg.shape.x;
  let halfWidth = seg.shape.y;
  let reach = seg.shape.z;
  let ha = seaLevel + seg.p0.x;
  let hb = seaLevel + seg.p0.y;
  let ca = seg.p0.z;
  let cb = seg.p0.w;
  let crossfall = seg.p1.x;
  let grade = select(0.0, (hb - ha) / segmentLength, segmentLength > 0.0);
  let past = max(0.0, along - segmentLength);
  let radial = length(vec2f(past, across));
  if (radial <= halfWidth) {
    let c = select(ca, ca + (cb - ca) * kClamp(along / segmentLength, 0.0, 1.0), segmentLength > 0.0);
    return vec2f(ha + grade * along + terrainInfraRoadCrossOffset(across, c, crossfall), enter);
  }
  let scale = halfWidth / radial;
  let edgeAlong = min(along, segmentLength) + past * scale;
  let edgeAcross = across * scale;
  let c = select(ca, ca + (cb - ca) * kClamp(edgeAlong / segmentLength, 0.0, 1.0), segmentLength > 0.0);
  let edge = ha + grade * edgeAlong + terrainInfraRoadCrossOffset(edgeAcross, c, crossfall);
  let beyond = radial - halfWidth;
  return vec2f(
    terrainInfraRoadBatter(edge, beyond, ground, seg.p1.y, seg.p1.z),
    enter * (1.0 - kSmoothstep(0.7 * reach, reach, beyond)),
  );
}
`;

/**
 * `junctionPad`: a disc where roads meet or one ends, composed after every
 * road. Level within an inner radius; out to its edge (`halfWidth`) it may
 * follow what the roads graded under it (their crowns) by a growing
 * allowance, so a road's cross-section runs onto the pad without a kerb;
 * past the edge, the roads' batters (no ditch) down or up to the ground.
 *
 * params[0]: pad level, metres above sea level.
 * params[1]: level-core radius, metres (at most `halfWidth`).
 * params[2]: the allowance's growth from the core to the edge, rise per metre.
 */
export function roadJunctionPadHeight(
  along: number,
  across: number,
  length: number,
  segment: InfrastructureSegment,
  ground: number,
  seaLevel: number,
  out: InfrastructureProfileSample,
): void {
  const level = seaLevel + (segment.params[0] ?? 0);
  const halfWidth = segment.halfWidth;
  const core = Math.min(halfWidth, Math.max(0, segment.params[1] ?? 0));
  const apron = Math.max(0, segment.params[2] ?? 0);
  const radial = Math.hypot(Math.max(0, -along, along - length), across);
  const allowance = apron * clamp(radial - core, 0, halfWidth - core);
  const beyond = Math.max(0, radial - halfWidth);
  const fall = allowance + beyond / ROAD_FILL_BATTER_RUN;
  const rise = allowance + beyond / ROAD_CUT_BATTER_RUN;
  out.target = level + clamp(ground - level, -fall, rise);
  out.weight = 1 - smoothstep(0.7 * segment.reach, segment.reach, beyond);
}

const ROAD_JUNCTION_PAD_WGSL = /* wgsl */ `
fn terrainInfra_junctionPad(
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  let segmentLength = seg.shape.x;
  let halfWidth = seg.shape.y;
  let reach = seg.shape.z;
  let level = seaLevel + seg.p0.x;
  let core = min(halfWidth, max(0.0, seg.p0.y));
  let apron = max(0.0, seg.p0.z);
  let radial = length(vec2f(max(0.0, max(-along, along - segmentLength)), across));
  let allowance = apron * kClamp(radial - core, 0.0, halfWidth - core);
  let beyond = max(0.0, radial - halfWidth);
  let fall = allowance + beyond / K_ROAD_FILL_RUN;
  let rise = allowance + beyond / K_ROAD_CUT_RUN;
  return vec2f(
    level + kClamp(ground - level, -fall, rise),
    1.0 - kSmoothstep(0.7 * reach, reach, beyond),
  );
}
`;

/** The WGSL the stage's kernel includes, by profile name; the shared helpers ride with the first. */
export const ROAD_PROFILE_WGSL = Object.freeze({
  carriageway: ROAD_COMMON_WGSL + ROAD_CARRIAGEWAY_WGSL,
  junctionPad: ROAD_JUNCTION_PAD_WGSL,
});
