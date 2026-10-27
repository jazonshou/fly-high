import { clamp, smoothstep } from "./noise";
import type { InfrastructureProfileSample, InfrastructureSegment } from "./infrastructure";

/**
 * The home marina's earthwork profiles for the infrastructure stage
 * (`infrastructure.ts` states the contract; `marinaEarthworks.ts` lays the
 * segments out). Each is a CPU function and its WGSL transliteration, listed
 * in `INFRASTRUCTURE_PROFILES`.
 *
 * BOXES, NOT CAPSULES. The basin, the quay apron, the car park and the
 * slipway are rectangles: their core is the box along in [0, length], |across|
 * <= halfWidth, square-cornered, and their batters run from the box's edge
 * (`marinaBoxDistance`). The box lies inside the stage's capsule core, and the
 * box distance is never less than the capsule distance less halfWidth, so a
 * weight that fades by box distance `reach` is 0 wherever the stage stops
 * evaluating. The breakwater keeps the capsule: its round heads are a
 * breakwater's roundheads.
 *
 * Every weight is continuous, so the ground never steps; the quay face is a
 * very steep batter, hidden inside the quay wall the marina draws.
 */

/** Distance outside the box along in [0, length], |across| <= halfWidth; 0 inside. */
export function marinaBoxDistance(along: number, across: number, length: number, halfWidth: number): number {
  const dx = Math.max(0, -along, along - length);
  const dz = Math.max(0, Math.abs(across) - halfWidth);
  return Math.hypot(dx, dz);
}

/** The fade every marina profile shares: full to 70% of reach, 0 at reach. */
function fade(beyond: number, reach: number): number {
  return 1 - smoothstep(0.7 * reach, reach, beyond);
}

/**
 * `marinaDredge` (mode cut): a basin or channel dredged to a depth over the
 * box, with an underwater batter back up to the bed outside it. It dredges
 * water only: the cut fades out where the ground stands above the shore band,
 * so a basin edge that meets a headland leaves the land alone.
 *
 * params[0]: depth below sea level, metres.
 * params[1]: batter run per metre of rise (4 = 1:4).
 * params[2], params[3]: the shore band, metres above sea level: full cut
 *            below params[2], none above params[3].
 */
export function marinaDredgeHeight(
  along: number,
  across: number,
  length: number,
  segment: InfrastructureSegment,
  ground: number,
  seaLevel: number,
  out: InfrastructureProfileSample,
): void {
  const depth = segment.params[0] ?? 0;
  const run = Math.max(0.1, segment.params[1] ?? 0);
  const shoreFrom = segment.params[2] ?? 0;
  const shoreTo = Math.max(shoreFrom + 0.01, segment.params[3] ?? 0);
  const beyond = marinaBoxDistance(along, across, length, segment.halfWidth);
  out.target = seaLevel - depth + beyond / run;
  out.weight = fade(beyond, segment.reach) * (1 - smoothstep(seaLevel + shoreFrom, seaLevel + shoreTo, ground));
}

const MARINA_DREDGE_WGSL = /* wgsl */ `
fn terrainInfraMarinaBox(along: f32, across: f32, segmentLength: f32, halfWidth: f32) -> f32 {
  let dx = max(0.0, max(-along, along - segmentLength));
  let dz = max(0.0, abs(across) - halfWidth);
  return length(vec2f(dx, dz));
}

fn terrainInfraMarinaFade(beyond: f32, reach: f32) -> f32 {
  return 1.0 - kSmoothstep(0.7 * reach, reach, beyond);
}

fn terrainInfra_marinaDredge(
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  let depth = seg.p0.x;
  let run = max(0.1, seg.p0.y);
  let shoreFrom = seg.p0.z;
  let shoreTo = max(shoreFrom + 0.01, seg.p0.w);
  let beyond = terrainInfraMarinaBox(along, across, seg.shape.x, seg.shape.y);
  return vec2f(
    seaLevel - depth + beyond / run,
    terrainInfraMarinaFade(beyond, seg.shape.z)
      * (1.0 - kSmoothstep(seaLevel + shoreFrom, seaLevel + shoreTo, ground)),
  );
}
`;

/**
 * `marinaPad` (mode set): a pad over the box, level or on a steady grade
 * across it, battered to the ground beyond. The quay apron (level, with a
 * near-vertical front: the quay cut) and the car park (graded up inland).
 *
 * "Front" is the +across side: a segment laid along the marina's right axis
 * has +across seaward.
 *
 * params[0]: pad level at the front edge, metres above sea level.
 * params[1]: pad level at the back edge (-across), metres above sea level.
 * params[2]: batter run per metre of rise off the back and the ends.
 * params[3]: batter run per metre of rise off the front (0.15 is a quay face).
 */
export function marinaPadHeight(
  along: number,
  across: number,
  length: number,
  segment: InfrastructureSegment,
  ground: number,
  seaLevel: number,
  out: InfrastructureProfileSample,
): void {
  const front = segment.params[0] ?? 0;
  const back = segment.params[1] ?? 0;
  const sideRun = Math.max(0.05, segment.params[2] ?? 0);
  const frontRun = Math.max(0.05, segment.params[3] ?? 0);
  const halfWidth = segment.halfWidth;
  const t = halfWidth > 0 ? clamp((across + halfWidth) / (2 * halfWidth), 0, 1) : 1;
  const level = seaLevel + back + (front - back) * t;
  const beyond = marinaBoxDistance(along, across, length, halfWidth);
  if (beyond <= 0) {
    out.target = level;
    out.weight = 1;
    return;
  }
  // Off the front the front batter, off the back and ends the side batter,
  // blended round the front corners so the ground never steps.
  const frontShare = Math.max(0, across - halfWidth) / beyond;
  const rise = beyond / (sideRun + (frontRun - sideRun) * frontShare);
  out.target = level + clamp(ground - level, -rise, rise);
  out.weight = fade(beyond, segment.reach);
}

const MARINA_PAD_WGSL = /* wgsl */ `
fn terrainInfra_marinaPad(
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  let front = seg.p0.x;
  let back = seg.p0.y;
  let sideRun = max(0.05, seg.p0.z);
  let frontRun = max(0.05, seg.p0.w);
  let halfWidth = seg.shape.y;
  var t = 1.0;
  if (halfWidth > 0.0) { t = kClamp((across + halfWidth) / (2.0 * halfWidth), 0.0, 1.0); }
  let level = seaLevel + back + (front - back) * t;
  let beyond = terrainInfraMarinaBox(along, across, seg.shape.x, halfWidth);
  if (beyond <= 0.0) { return vec2f(level, 1.0); }
  let frontShare = max(0.0, across - halfWidth) / beyond;
  let rise = beyond / (sideRun + (frontRun - sideRun) * frontShare);
  return vec2f(
    level + kClamp(ground - level, -rise, rise),
    terrainInfraMarinaFade(beyond, seg.shape.z),
  );
}
`;

/**
 * `marinaSlipway` (mode set): a ramp from a to b on a steady grade, its top
 * at a and its toe at b, battered to the ground at its sides and ends.
 *
 * params[0]: level at a (the top), metres above sea level.
 * params[1]: level at b (the toe), metres above sea level.
 * params[2]: batter run per metre of rise.
 */
export function marinaSlipwayHeight(
  along: number,
  across: number,
  length: number,
  segment: InfrastructureSegment,
  ground: number,
  seaLevel: number,
  out: InfrastructureProfileSample,
): void {
  const top = segment.params[0] ?? 0;
  const toe = segment.params[1] ?? 0;
  const run = Math.max(0.05, segment.params[2] ?? 0);
  const t = length > 0 ? clamp(along / length, 0, 1) : 0;
  const level = seaLevel + top + (toe - top) * t;
  const beyond = marinaBoxDistance(along, across, length, segment.halfWidth);
  if (beyond <= 0) {
    out.target = level;
    out.weight = 1;
    return;
  }
  const rise = beyond / run;
  out.target = level + clamp(ground - level, -rise, rise);
  out.weight = fade(beyond, segment.reach);
}

const MARINA_SLIPWAY_WGSL = /* wgsl */ `
fn terrainInfra_marinaSlipway(
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  let top = seg.p0.x;
  let toe = seg.p0.y;
  let run = max(0.05, seg.p0.z);
  var t = 0.0;
  if (seg.shape.x > 0.0) { t = kClamp(along / seg.shape.x, 0.0, 1.0); }
  let level = seaLevel + top + (toe - top) * t;
  let beyond = terrainInfraMarinaBox(along, across, seg.shape.x, seg.shape.y);
  if (beyond <= 0.0) { return vec2f(level, 1.0); }
  let rise = beyond / run;
  return vec2f(
    level + kClamp(ground - level, -rise, rise),
    terrainInfraMarinaFade(beyond, seg.shape.z),
  );
}
`;

/**
 * `marinaBreakwater` (mode fill): a rubble mound, its crest level over a
 * crest half width round the centreline (round heads at both ends), its
 * sides at a steady slope down to the bed.
 *
 * The segment's halfWidth is the mound's half width at the waterline, so its
 * painted surface covers what stands out of the water; the crest is params.
 *
 * params[0]: crest level, metres above sea level.
 * params[1]: crest half width, metres.
 * params[2]: side slope, run per metre of fall (1.5 = 1:1.5).
 */
export function marinaBreakwaterHeight(
  along: number,
  across: number,
  length: number,
  segment: InfrastructureSegment,
  _ground: number,
  seaLevel: number,
  out: InfrastructureProfileSample,
): void {
  const crest = segment.params[0] ?? 0;
  const crestHalfWidth = segment.params[1] ?? 0;
  const run = Math.max(0.05, segment.params[2] ?? 0);
  const distance = capsuleDistance(along, across, length);
  out.target = seaLevel + crest - Math.max(0, distance - crestHalfWidth) / run;
  out.weight = fade(Math.max(0, distance - segment.halfWidth), segment.reach);
}

/** `infrastructureCapsuleDistance`, local so this module stays a leaf. */
function capsuleDistance(along: number, across: number, length: number): number {
  if (along < 0) return Math.hypot(along, across);
  if (along > length) return Math.hypot(along - length, across);
  return Math.abs(across);
}

const MARINA_BREAKWATER_WGSL = /* wgsl */ `
fn terrainInfra_marinaBreakwater(
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  let crest = seg.p0.x;
  let crestHalfWidth = seg.p0.y;
  let run = max(0.05, seg.p0.z);
  let distance = terrainInfraCapsuleDistance(along, across, seg.shape.x);
  return vec2f(
    seaLevel + crest - max(0.0, distance - crestHalfWidth) / run,
    terrainInfraMarinaFade(max(0.0, distance - seg.shape.y), seg.shape.z),
  );
}
`;

/** The WGSL twins. The dredge twin also defines the box and fade helpers the other three call. */
export const MARINA_PROFILE_WGSL = Object.freeze({
  marinaDredge: MARINA_DREDGE_WGSL,
  marinaPad: MARINA_PAD_WGSL,
  marinaSlipway: MARINA_SLIPWAY_WGSL,
  marinaBreakwater: MARINA_BREAKWATER_WGSL,
});
