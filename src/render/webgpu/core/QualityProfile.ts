import type { QualityLevel } from "@/src/game/types";
import type { RenderingMode } from "@/src/settings";

export interface WebGpuQualityProfile {
  readonly tier: 0 | 1 | 2;
  readonly quality: QualityLevel;
  readonly mode: RenderingMode;
  readonly renderScale: number;
  readonly terrainRings: number;
  readonly shadowMapSize: number;
  readonly shadowCascades: number;
  readonly shadowDistance: number;
  readonly oceanResolution: 128 | 256;
  readonly oceanCascades: number;
  readonly cloudResolutionScale: number;
  readonly cloudPrimarySteps: number;
  readonly cloudLightSteps: number;
  readonly vegetationDistance: number;
  readonly vegetationDensity: number;
  readonly activeAnimalBudget: number;
}

const QUALITY_WEIGHT: Readonly<Record<QualityLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

const MODE_WEIGHT: Readonly<Record<RenderingMode, number>> = {
  performance: -1,
  balanced: 0,
  ultra: 1,
};

function clampTier(value: number): 0 | 1 | 2 {
  return Math.max(0, Math.min(2, value)) as 0 | 1 | 2;
}

/** Resolve one bounded profile instead of scattering quality branches across systems. */
export function resolveWebGpuQualityProfile(
  quality: QualityLevel,
  mode: RenderingMode,
): WebGpuQualityProfile {
  const tier = clampTier(QUALITY_WEIGHT[quality] + MODE_WEIGHT[mode]);
  if (tier === 0) {
    return {
      tier,
      quality,
      mode,
      renderScale: 0.72,
      terrainRings: 8,
      shadowMapSize: 1_024,
      shadowCascades: 2,
      shadowDistance: 4_500,
      oceanResolution: 128,
      oceanCascades: 3,
      cloudResolutionScale: 0.25,
      cloudPrimarySteps: 40,
      cloudLightSteps: 4,
      vegetationDistance: 2_000,
      vegetationDensity: 0.45,
      activeAnimalBudget: 16,
    };
  }
  if (tier === 1) {
    return {
      tier,
      quality,
      mode,
      renderScale: 0.86,
      terrainRings: 8,
      shadowMapSize: 2_048,
      shadowCascades: 3,
      shadowDistance: 9_000,
      oceanResolution: 256,
      oceanCascades: 4,
      cloudResolutionScale: 0.5,
      cloudPrimarySteps: 72,
      cloudLightSteps: 6,
      vegetationDistance: 4_500,
      vegetationDensity: 0.75,
      activeAnimalBudget: 48,
    };
  }
  return {
    tier,
    quality,
    mode,
    renderScale: 1,
    terrainRings: 8,
    shadowMapSize: 4_096,
    shadowCascades: 4,
    shadowDistance: 16_000,
    oceanResolution: 256,
    oceanCascades: 5,
    // Temporal reconstruction provides the stability return at this tier. Keep
    // the fully integrated per-frame ray march below a brute-force cost cliff.
    cloudResolutionScale: 0.6,
    cloudPrimarySteps: 96,
    cloudLightSteps: 6,
    vegetationDistance: 8_000,
    vegetationDensity: 1,
    activeAnimalBudget: 128,
  };
}

/** Slow changes avoid a visible resolution feedback loop during transient frames. */
export function nextDynamicRenderScale(
  current: number,
  p95FrameMilliseconds: number,
  profile: WebGpuQualityProfile,
): number {
  const lowerBound = Math.min(0.62, profile.renderScale);
  const value = Number.isFinite(current) ? current : profile.renderScale;
  if (!Number.isFinite(p95FrameMilliseconds)) return value;
  if (p95FrameMilliseconds > 18) return Math.max(lowerBound, value - 0.04);
  if (p95FrameMilliseconds < 13.5) return Math.min(profile.renderScale, value + 0.02);
  return value;
}
