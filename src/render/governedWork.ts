/**
 * PR B (G3): what the governor's work levers mean for one profile.
 *
 * The ladders hold factors and added intervals (`WorkLeverSettings`); this
 * turns them into the values each subsystem takes. A rung is therefore a
 * real cut on every tier: the old absolute caps (48 animals, 1,800 m of
 * shadow casters, a cloud-shadow interval of 3 frames) were at or above the
 * lower tiers' own values, so those rungs moved a number and shed nothing.
 *
 * At level (0, 0) every value is exactly what the subsystems took before
 * the governor existed: no request budget, compute scale 1, no detail cap,
 * no cloud-shadow floor, unbounded casters, the profile's own animals and
 * vegetation reach, and (PR B part 2) the profile's own cloud march, CSM and
 * cloud-depth refresh intervals with no frames added, and CDLOD budget and
 * threshold. A frozen (pinned-capture) governor never leaves (0, 0), which
 * is what keeps the reference pictures byte-identical.
 */
import type { WorkLeverSettings } from "./webgpu/core/AdaptiveGovernor";
import type { WebGpuQualityProfile } from "./webgpu/core/QualityProfile";
import { resolveCloudShadowSchedule } from "./webgpu/clouds/runtimePolicy";
import {
  resolveDetailGenerationBudget,
  type DetailGenerationBudget,
} from "./webgpu/detail/generationBudget";

export interface GovernedWork {
  readonly terrainPageRequestsPerUpdate: number;
  readonly computeBudgetScale: number;
  /** null leaves detail generation on the profile's own slice. */
  readonly detailGenerationCap: DetailGenerationBudget | null;
  readonly activeAnimalBudget: number;
  /** null leaves the cloud shadow on the tier's own schedule. */
  readonly cloudShadowIntervalFloor: number | null;
  /** The terrain clamps this to the profile's shadow distance. */
  readonly shadowCasterDistanceMeters: number;
  readonly vegetationDistance: number;
  readonly groundCoverGateScale: number;
  /** 1 leaves the cloud view march on the profile's own steps and step lengths. */
  readonly cloudMarchScale: number;
  /**
   * The profile's frames between CSM renders, at the tier's own frame target
   * (a rate). It travels apart from the governor's frames below (a cost):
   * the rate is converted to the presented cadence, rounding, and the frames
   * are added after it. Summed first, a rung would vanish at the 30 fps
   * setting: round((1 + 1) × 16.67 / 33.33) = 1 = round(1 × 0.5).
   */
  readonly shadowRefreshFrames: number;
  /** Presented frames the governor adds once that rate is converted to the cadence (a cost). */
  readonly shadowRefreshExtraFrames: number;
  /** As above, for cloud-scene-depth. */
  readonly cloudDepthRefreshFrames: number;
  readonly cloudDepthRefreshExtraFrames: number;
  /** Never above the profile's; the terrain clamps it to its buffer capacity. */
  readonly cdlodNodeBudget: number;
  readonly cdlodPixelThreshold: number;
}

export type GovernedProfileInputs = Pick<
  WebGpuQualityProfile,
  | "activeAnimalBudget"
  | "cloudResolutionScale"
  | "shadowDistance"
  | "vegetationDensity"
  | "vegetationDistance"
  | "cdlodNodeBudget"
  | "cdlodPixelThreshold"
  | "shadowRefreshFrames"
  | "cloudDepthRefreshFrames"
>;

export function resolveGovernedWork(profile: GovernedProfileInputs, levers: WorkLeverSettings): GovernedWork {
  const detail = levers.detailBudgetScale;
  const base = resolveDetailGenerationBudget(profile);
  return Object.freeze({
    terrainPageRequestsPerUpdate: levers.terrainPageRequestsPerUpdate,
    computeBudgetScale: levers.computeBudgetScale,
    // Rounded, and never below one cell, so the slice always admits a cell.
    detailGenerationCap: detail >= 1
      ? null
      : Object.freeze({
          maximumCells: Math.max(1, Math.round(base.maximumCells * detail)),
          maximumMilliseconds: base.maximumMilliseconds * detail,
        }),
    activeAnimalBudget: levers.animalBudgetScale >= 1
      ? profile.activeAnimalBudget
      : Math.max(1, Math.floor(profile.activeAnimalBudget * levers.animalBudgetScale)),
    cloudShadowIntervalFloor: levers.cloudShadowExtraFrames === 0
      ? null
      : resolveCloudShadowSchedule(profile).updateEveryNFrames + levers.cloudShadowExtraFrames,
    shadowCasterDistanceMeters: levers.shadowCasterDistanceScale >= 1
      ? Number.POSITIVE_INFINITY
      : profile.shadowDistance * levers.shadowCasterDistanceScale,
    vegetationDistance: profile.vegetationDistance * levers.vegetationDistanceScale,
    groundCoverGateScale: levers.groundCoverGateScale,
    cloudMarchScale: levers.cloudMarchScale,
    shadowRefreshFrames: profile.shadowRefreshFrames,
    shadowRefreshExtraFrames: levers.shadowRefreshExtraFrames,
    cloudDepthRefreshFrames: profile.cloudDepthRefreshFrames,
    cloudDepthRefreshExtraFrames: levers.cloudDepthRefreshExtraFrames,
    // Floored, never below one node: exact at the profile value.
    cdlodNodeBudget: levers.cdlodNodeBudgetScale >= 1
      ? profile.cdlodNodeBudget
      : Math.max(1, Math.floor(profile.cdlodNodeBudget * levers.cdlodNodeBudgetScale)),
    cdlodPixelThreshold: levers.cdlodPixelThresholdScale === 1
      ? profile.cdlodPixelThreshold
      : profile.cdlodPixelThreshold * levers.cdlodPixelThresholdScale,
  });
}
