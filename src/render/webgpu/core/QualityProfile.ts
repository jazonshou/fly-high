import {
  RENDERED_DENSITY_LAWS,
  type RenderedDensityLaw,
} from "@/src/render/webgpu/detail/renderedDensity";
import type { QualityLevel } from "@/src/game/types";
import type { RenderingMode } from "@/src/settings";

/**
 * The camera far plane (1C-4). Beyond this the shared aerial perspective
 * leaves under 5% luminance transmittance in clear weather, so geometry is
 * invisible; ring counts per tier are chosen against this number and the
 * pairing is pinned by tests.
 */
export const CAMERA_FAR_PLANE_METERS = 45_000;

/**
 * `3-5`'s projection ladder. Planar is the XZ projection alone with a
 * slope-stretch correction; biplanar blends the two dominant axes (the
 * mandatory Balanced fast path); triplanar blends all three.
 */
export type TerrainTriplanarMode = "planar" | "biplanar" | "triplanar";

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
  /** R-21: the tier's rendered-density law (the one vegetation authority). */
  readonly renderedDensityLaw: RenderedDensityLaw;
  /** 2-12: cap on crown-geometry variants per species (Low keeps three). */
  readonly treeVariantCap: number;
  /**
   * 2-16: grass draw radius — THE first tier knob per §5.3, because grass
   * is the renderer's largest single triangle consumer. The 1/d density
   * ramp inside it holds screen-space blade density roughly constant.
   */
  readonly grassRadiusMeters: number;
  /**
   * `3-0`: edge of both terrain material `Texture2DArray`s. `3-1` synthesises
   * at this edge and `estimateGpuMemory`'s material-array row follows it, so
   * the tier knob and the budget cannot disagree (assertion 56).
   *
   * §5.3 publishes 256/512/512/**1024**; Ultra ships 512 instead. `3-1`
   * synthesises on the CPU (see that file's deviation note on `C2`), measured
   * at 1.07 s for all ten 512² layers and ~4.3 s at 1024² — several seconds of
   * blocked main thread at startup, for a resolution the de-tiling warp and
   * 16× anisotropy largely mask. It also returned 80 MiB to a tier that was
   * sitting at 96% of its ceiling. The row reopens the moment synthesis moves
   * to GPU compute, which is the optimisation `C2` deliberately deferred.
   */
  readonly materialArrayEdge: number;
  /**
   * `3-0`/`3-5`: how the surface plugin projects material UVs. §5.3's row —
   * Low gets a slope-stretched planar projection and no triplanar at all,
   * Balanced gets the mandatory 2-axis fast path, High and Ultra get 3-axis.
   */
  readonly terrainTriplanarMode: TerrainTriplanarMode;
  /**
   * `3-0`/`3-6`: how many materials the height blend may carry (§5.3's row —
   * 2/3/4/4). Phase 3's provisional splat offers at most three candidates
   * (the bracketed pair on the material axis plus the slope/snow override),
   * so Low genuinely compiles fewer samples; `4-6`'s 4-way page splat spends
   * the rest.
   */
  readonly heightBlendMaxMaterials: number;
  /**
   * `4-0`/`4-5`: screen-space error, in pixels, above which a CDLOD node
   * splits. Split when `maxDeviationFromParent × pixelsPerMeter(distance3D)`
   * exceeds this. Monotone decreasing in tier — a smaller threshold splits
   * sooner, so Ultra buys detail here rather than through a finer height page
   * (see `terrainTexelSizeMeters`, which takes no tier argument).
   */
  readonly cdlodPixelThreshold: number;
  /** `4-0`/`4-5`: ceiling on simultaneously drawn CDLOD nodes. */
  readonly cdlodNodeBudget: number;
  /**
   * `4-0`: the finest page level this tier ever streams. Low reaches its
   * 4 m effective spacing by never admitting L0, NOT by storing a coarser
   * page — §1.3's height authority must not be a function of a graphics
   * setting.
   */
  readonly finestResidentLevel: number;
  /**
   * `4-0`/`4-2`: r32float height-atlas slots. Surplus slots ARE the LRU
   * cache. The estimator's `heightAtlasMiB` row is derived from this field,
   * so the tier knob and the budget cannot disagree (assertion 69).
   */
  readonly heightAtlasSlots: number;
  /**
   * `4-0`/`4-6`/`4-7`: channel-atlas slots (splat, occlusion, horizon).
   * Independent of `heightAtlasSlots`: a page may hold a height slot with no
   * channel slot, in which case its surface falls back to the provisional
   * splat — the co-residency rule `4-2` states.
   */
  readonly channelAtlasSlots: number;
  readonly shadowMapSize: number;
  readonly shadowCascades: number;
  readonly shadowDistance: number;
  readonly oceanResolution: 128 | 256;
  readonly oceanCascades: number;
  readonly cloudResolutionScale: number;
  /**
   * Absolute ceiling on cloud-integration pixels (2-6). Clamped alongside
   * the resolution scale in resolveCloudRenderSize — a multiply is not a cap
   * (the 1A-6a argument, applied to the cloud pass).
   */
  readonly maxCloudPixels: number;
  readonly cloudPrimarySteps: number;
  readonly cloudLightSteps: number;
  /**
   * §5.3's impostor radius, and therefore the outer edge of the
   * rendered-density law's far band: beyond it `6-8`'s canopy splat is the
   * only vegetation representation, so a larger value describes plants that
   * are not drawn. Kept equal to `renderedDensityLaw.far.outerRadiusMeters`
   * — the pairing is pinned by test.
   */
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
      renderedDensityLaw: RENDERED_DENSITY_LAWS[0]!,
      treeVariantCap: 3,
      grassRadiusMeters: 90,
      materialArrayEdge: 256,
      terrainTriplanarMode: "planar",
      heightBlendMaxMaterials: 2,
      cdlodPixelThreshold: 4,
      cdlodNodeBudget: 160,
      // Low never streams L0: 4 m effective spacing without a second page
      // geometry, and one less level of streaming pressure.
      finestResidentLevel: 1,
      heightAtlasSlots: 144,
      // DEVIATION from §5.3's 144, recorded in PHASE_4_EXECUTION_PLAN.md §4
      // D13: at 144 the derived channel atlas is 71.1 MiB raw here, leaving
      // tier 0 at ~255/260 — inside the estimator's own +/-15% calibration
      // tolerance, i.e. not actually legal. §5.2's stated rule is to take
      // such a saving in sampling rather than in a second geometry; 100 slots
      // is that saving, and Low's `finestResidentLevel: 1` already halves its
      // finest-level page demand, so channel residency is where it belongs.
      channelAtlasSlots: 100,
      // `4-8b`: §5.3's near-field rows. Terrain beyond `shadowDistance` is
      // shadowed by `4-7`'s horizon map, which reaches 45 km — so the cascades
      // stop being a distance instrument and become a CONTACT one, and the
      // texel density inside them roughly triples at every tier.
      shadowMapSize: 1_024,
      shadowCascades: 2,
      shadowDistance: 900,
      oceanResolution: 128,
      oceanCascades: 3,
      cloudResolutionScale: 0.25,
      maxCloudPixels: 350_000,
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
      renderedDensityLaw: RENDERED_DENSITY_LAWS[1]!,
      treeVariantCap: 5,
      grassRadiusMeters: 150,
      materialArrayEdge: 512,
      terrainTriplanarMode: "biplanar",
      heightBlendMaxMaterials: 3,
      cdlodPixelThreshold: 3,
      cdlodNodeBudget: 240,
      finestResidentLevel: 0,
      heightAtlasSlots: 196,
      channelAtlasSlots: 196,
      // `4-8b`: 1280 @ 1400 m, with TWO cascades rather than §5.3's three.
      //
      // DEVIATION, measured (PHASE_4_EXECUTION_PLAN.md §4 D15). A third
      // cascade multiplies the vegetation SHADOW draw estimate by 1.5 —
      // `estimateVegetationDrawCalls` counts near-band chunks once per
      // cascade — at the one tier whose vegetation frame row is already ~5×
      // over budget and whose draw ceiling this pass may not raise. What it
      // buys is near-cascade texel density, and two cascades over 1400 m at
      // 1280² already give ~0.23 m/texel in the contact cascade against the
      // ~1.5 m Phase 1 shipped at 2×2048 over 7 km. Six times finer for the
      // same draw count is the trade; the third cascade is not.
      //
      // `RENDERING_PLAN.md`'s `4-8` item text said "3×1536, 1.8 km, PCSS",
      // which is the HIGH row plus a filter that cannot run (tier-2 note).
      shadowMapSize: 1_280,
      shadowCascades: 2,
      shadowDistance: 1_400,
      oceanResolution: 128,
      oceanCascades: 4,
      cloudResolutionScale: 0.45,
      maxCloudPixels: 700_000,
      cloudPrimarySteps: 60,
      cloudLightSteps: 6,
      // Perf-debt pass: §5.3's Balanced impostor radius. Gate 2C shipped
      // 4,500 m against a table that says 3,000; the far band's submitted
      // chunk count falls with the square of this number.
      vegetationDistance: 3_000,
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
      // `4-8b` restores 4×, which the `1B-11` decision in ARCHITECTURE.md
      // explicitly deferred to this item: Phase 1's full-distance 4096² CSM
      // left no room for it inside the 700 MiB ceiling, and the near-field
      // rows above have now paid for it. Note this COSTS 54.9 MiB raw here —
      // more than the shadow refund — so `4-8b` is net +8.7 MiB at this tier.
      // It is not a refund, and the D3 table carries it as a cost.
      msaaSamples: 4,
      frameTargetMs: 13.7,
      renderedDensityLaw: RENDERED_DENSITY_LAWS[2]!,
      treeVariantCap: 5,
      grassRadiusMeters: 220,
      materialArrayEdge: 512,
      terrainTriplanarMode: "triplanar",
      heightBlendMaxMaterials: 4,
      cdlodPixelThreshold: 2,
      cdlodNodeBudget: 320,
      finestResidentLevel: 0,
      heightAtlasSlots: 256,
      channelAtlasSlots: 256,
      // `4-8b`: 3 × 1536 @ 1800 m, superseding `4-8a`'s temporary 2048 cut.
      //
      // **`FILTER_PCF`, not PCSS.** §5.3 published PCSS at High and Ultra and
      // it cannot run: `computeShadowWithCSMPCSS` needs a second
      // `texture_2d_array<f32>` bound from the shadow map's COLOUR attachment,
      // and `1A-5` deleted that attachment — the single largest memory win in
      // Phase 1. Buying it back costs more than softer contact shadows are
      // worth here, so PCSS is a Phase 7 conversation.
      shadowMapSize: 1_536,
      shadowCascades: 3,
      shadowDistance: 1_800,
      oceanResolution: 256,
      oceanCascades: 5,
      // Temporal reconstruction provides the stability return at this tier. Keep
      // the fully integrated per-frame ray march below a brute-force cost cliff.
      cloudResolutionScale: 0.6,
      maxCloudPixels: 1_000_000,
      cloudPrimarySteps: 96,
      cloudLightSteps: 6,
      // Perf-debt pass: §5.3's High impostor radius. The realignment added
      // this row because 8 km bought ~95% more rendered stems than Balanced
      // for a 5.6% frame-row increase and sat outside every cut ladder.
      vegetationDistance: 4_000,
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
    renderedDensityLaw: RENDERED_DENSITY_LAWS[3]!,
    treeVariantCap: 5,
    grassRadiusMeters: 320,
    materialArrayEdge: 512,
    terrainTriplanarMode: "triplanar",
    heightBlendMaxMaterials: 4,
    cdlodPixelThreshold: 1.5,
    cdlodNodeBudget: 448,
    finestResidentLevel: 0,
    heightAtlasSlots: 256,
    channelAtlasSlots: 256,
    // `4-8b`: 4 × 2048 @ 2400 m. PCSS struck here too (see tier 2).
    shadowMapSize: 2_048,
    shadowCascades: 4,
    shadowDistance: 2_400,
    oceanResolution: 256,
    oceanCascades: 5,
    cloudResolutionScale: 0.7,
    maxCloudPixels: 1_600_000,
    cloudPrimarySteps: 96,
    cloudLightSteps: 6,
    // Perf-debt pass: §5.3's Ultra impostor radius.
    vegetationDistance: 6_000,
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
