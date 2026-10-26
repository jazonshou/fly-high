import { clamp, smoothstep } from "./noise";
import {
  infrastructureCapsuleDistance,
  type InfrastructureProfile,
  type InfrastructureProfileSample,
  type InfrastructureSegment,
} from "./infrastructure";

/**
 * Every infrastructure profile, indexed by id: the CPU function the stage
 * calls and the WGSL twin the GPU dispatches to (`infrastructure.ts` states
 * the contract). Owners add their profiles here; an id is its index, and a
 * profile's weight must reach 0 at halfWidth + reach.
 */

/**
 * `platform`: a level pad over the segment's capsule core, battered down (or
 * up) to the ground at a constant grade, the batter faded out over the last
 * 30% of `reach` where it has not met the ground by then. A car park, a dock
 * access pad, a road's shoulder platform.
 *
 * params[0]: pad level above sea level, metres.
 * params[1]: batter grade, metres horizontal per metre vertical (2 = 1:2);
 *            0 or less reads 2.
 */
function platformHeight(
  along: number,
  across: number,
  length: number,
  segment: InfrastructureSegment,
  ground: number,
  seaLevel: number,
  out: InfrastructureProfileSample,
): void {
  const level = seaLevel + (segment.params[0] ?? 0);
  const gradeParam = segment.params[1] ?? 0;
  const grade = gradeParam > 0 ? gradeParam : 2;
  const beyond = infrastructureCapsuleDistance(along, across, length) - segment.halfWidth;
  if (beyond <= 0) {
    out.target = level;
    out.weight = 1;
    return;
  }
  const rise = beyond / grade;
  out.target = level + clamp(ground - level, -rise, rise);
  out.weight = 1 - smoothstep(0.7 * segment.reach, segment.reach, beyond);
}

const PLATFORM_WGSL = /* wgsl */ `
fn terrainInfra_platform(
  along: f32,
  across: f32,
  seg: TerrainInfrastructureSegment,
  ground: f32,
  seaLevel: f32,
) -> vec2f {
  let level = seaLevel + seg.p0.x;
  let grade = select(2.0, seg.p0.y, seg.p0.y > 0.0);
  let beyond = terrainInfraCapsuleDistance(along, across, seg.shape.x) - seg.shape.y;
  if (beyond <= 0.0) { return vec2f(level, 1.0); }
  let rise = beyond / grade;
  let reach = seg.shape.z;
  return vec2f(
    level + kClamp(ground - level, -rise, rise),
    1.0 - kSmoothstep(0.7 * reach, reach, beyond),
  );
}
`;

export const INFRASTRUCTURE_PROFILE = Object.freeze({
  platform: 0,
});

export const INFRASTRUCTURE_PROFILES: readonly InfrastructureProfile[] = Object.freeze([
  Object.freeze({ id: INFRASTRUCTURE_PROFILE.platform, name: "platform", height: platformHeight, wgsl: PLATFORM_WGSL }),
]);
