import type { QualityLevel } from "@/src/game/types";
import type { RenderingMode } from "@/src/settings";

/**
 * The camera far plane (1C-4). Beyond this the shared aerial perspective
 * leaves under 5% luminance transmittance in clear weather, so geometry is
 * invisible; ring counts per tier are chosen against this number and the
 * pairing is pinned by tests.
 */
export const CAMERA_FAR_PLANE_METERS = 45_000;

export interface WebGpuQualityProfile {
  readonly tier: 0 | 1 | 2 | 3;
  readonly quality: QualityLevel;
  readonly mode: RenderingMode;
  readonly renderScale: number;
  /**
   * Absolute ceiling on rendered pixels per frame (1A-6a). Applied as a
   * hardware-scaling clamp after DPR and renderScale, so no display or
   * governor state can push the render target past it.
   */
  readonly maxRenderPixels: number;
  /** Per-tier ceiling on the device pixel ratio entering the scale product (1A-6a). */
  readonly maxDevicePixelRatio: number;
  /**
   * MSAA sample count for the offscreen beauty target (1B-11). 1 keeps the
   * FXAA fallback; 4 is genuinely cheap on Apple TBDR. Alpha-to-coverage is
   * off, so alpha-tested foliage gets no MSAA benefit — this fixes ridge
   * lines, runway edges and wing silhouettes, not tree canopies.
   */
  readonly msaaSamples: number;
  /**
   * The tier's controllable frame-time target (Z-2), mirrored from
   * `FRAME_TARGET_MS` so consumers read a profile datum instead of a tier
   * table. A hitch is a frame slower than twice this number.
   */
  readonly frameTargetMs: number;
  readonly terrainRings: number;
  /**
   * Vertices per tile edge at every level (1B-3). One constant per tier —
   * constant ground-sample-distance ratios between adjacent levels (2:1)
   * kill the 4:1 T-junction the audit measured at L2/L3. A datum, not a
   * policy: 4-5's CDLOD deletes it (plan A5).
   */
  readonly terrainTileResolution: number;
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

const MIN_TIMING_MILLISECONDS = 0.01;
const MAX_TIMING_MILLISECONDS = 250;

/** Four tiers since 1A-6b: high+ultra reaches tier 3 (Ultra, 4.0 Mpx, 30 fps). */
function clampTier(value: number): 0 | 1 | 2 | 3 {
  return Math.max(0, Math.min(3, value)) as 0 | 1 | 2 | 3;
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
      maxRenderPixels: 1_000_000,
      maxDevicePixelRatio: 1,
      msaaSamples: 1,
      frameTargetMs: 13.7,
      terrainRings: 6,
      terrainTileResolution: 33,
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
      maxRenderPixels: 1_500_000,
      maxDevicePixelRatio: 1.5,
      // 2Z free win (PRE_PHASE_4_REALIGNMENT.md §3): 2×, was 4×. At the
      // reference viewport 4× MSAA is ~69 MiB of framebuffer, and the
      // alpha-tested foliage Phase 2 makes dominant gets no MSAA benefit
      // (alpha-to-coverage is off) — the cheapest ~34 MiB in the programme.
      msaaSamples: 2,
      frameTargetMs: 13.7,
      terrainRings: 7,
      terrainTileResolution: 65,
      shadowMapSize: 2_048,
      shadowCascades: 2,
      shadowDistance: 7_000,
      oceanResolution: 128,
      oceanCascades: 4,
      cloudResolutionScale: 0.45,
      cloudPrimarySteps: 60,
      cloudLightSteps: 6,
      vegetationDistance: 4_500,
      vegetationDensity: 0.75,
      activeAnimalBudget: 48,
    };
  }
  if (tier === 2) {
    return {
      tier,
      quality,
      mode,
      renderScale: 1,
      maxRenderPixels: 2_400_000,
      maxDevicePixelRatio: 2,
      // 2× at this tier: Phase 1's full-distance 4096² CSM leaves no room
      // for 4× inside the 700 MiB ceiling (assertion 19); 4-8's near-field
      // shadow maps buy it back.
      msaaSamples: 2,
      frameTargetMs: 13.7,
      // 1C-4: the 45 km far plane makes level 7 (the 131 km ring) pure
      // waste. Levels 0–6 still guarantee 65.5 km worst-case coverage —
      // the lower tiers keep their counts because cutting them would end
      // terrain INSIDE the far plane (guaranteed coverage is 512·2^rings).
      terrainRings: 7,
      terrainTileResolution: 65,
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
  // Tier 3 (Ultra, high+ultra): a 30 fps tier that spends its frame on
  // pixels. Beyond the pixel cap and cloud integration scale it matches tier
  // 2 — the remaining §5.3 Ultra rows (ocean cascade 6, PCSS, capillary)
  // belong to the phases that build those features.
  return {
    tier,
    quality,
    mode,
    renderScale: 1,
    maxRenderPixels: 4_000_000,
    maxDevicePixelRatio: 2,
    msaaSamples: 4,
    frameTargetMs: 30,
    // 1C-4: level 7 sits wholly beyond the 45 km far plane (see tier 2).
    terrainRings: 7,
    terrainTileResolution: 65,
    shadowMapSize: 4_096,
    shadowCascades: 4,
    shadowDistance: 16_000,
    oceanResolution: 256,
    oceanCascades: 5,
    cloudResolutionScale: 0.7,
    cloudPrimarySteps: 96,
    cloudLightSteps: 6,
    vegetationDistance: 8_000,
    vegetationDensity: 1,
    activeAnimalBudget: 128,
  };
}

/**
 * Ignore zero/stale counter defaults and implausibly long gaps caused by a
 * suspended tab. The upper bound still permits genuine 4 FPS workload samples.
 */
export function isUsableFrameTiming(milliseconds: number): boolean {
  return Number.isFinite(milliseconds)
    && milliseconds >= MIN_TIMING_MILLISECONDS
    && milliseconds <= MAX_TIMING_MILLISECONDS;
}

/** Return a timing only while its asynchronously produced sample is still current. */
export function freshFrameTiming(
  milliseconds: number | null,
  sampleFrameIndex: number,
  currentFrameIndex: number,
  maximumAgeFrames: number,
): number | null {
  if (milliseconds === null || !isUsableFrameTiming(milliseconds)) return null;
  const age = currentFrameIndex - sampleFrameIndex;
  if (!Number.isFinite(age) || age < 0 || age > Math.max(0, maximumAgeFrames)) return null;
  return milliseconds;
}

/** Nearest-rank p95 over only usable timing values. */
export function frameTimingPercentile95(samples: readonly number[]): number | null {
  const valid = samples.filter(isUsableFrameTiming).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const index = Math.max(0, Math.ceil(valid.length * 0.95) - 1);
  return valid[index] ?? null;
}

/**
 * Nearest-rank percentile over every finite positive sample — deliberately
 * *without* the 250 ms usability ceiling (Z-2). The governor's p95 must
 * ignore suspended-tab gaps; the hitch metrics exist precisely to see them.
 */
export function frameTimingPercentile(
  samples: readonly number[],
  quantile: number,
): number | null {
  const valid = samples
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const index = Math.max(0, Math.ceil(valid.length * quantile) - 1);
  return valid[Math.min(index, valid.length - 1)] ?? null;
}

// worstFrameTimingPercentile95 and nextDynamicRenderScale are deleted (1A-6b):
// feeding the worst p95 across CPU/GPU/interval streams into a resolution step
// was, mechanically, the one-way ratchet. The AdaptiveGovernor module owns the
// replacement and its arbiter.
