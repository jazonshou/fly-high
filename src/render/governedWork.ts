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
 * vegetation reach. A frozen (pinned-capture) governor never leaves (0, 0),
 * which is what keeps the reference pictures byte-identical.
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
}

export type GovernedProfileInputs = Pick<
  WebGpuQualityProfile,
  "activeAnimalBudget" | "cloudResolutionScale" | "shadowDistance" | "vegetationDensity" | "vegetationDistance"
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
  });
}
