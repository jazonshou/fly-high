import {
  GROUND_COVER_LAWS,
} from "@/src/render/webgpu/detail/groundCoverLaw";
import type { GroundCoverLaw } from "@/src/render/webgpu/detail/groundCoverLaw";
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

/**
 * wave R: the ocean presentation disk's lattice, moved here from a
 * `profile.tier` table in `water/SpectralOceanSystem.ts` (the tier rule's
 * grandfathered ocean reader, now retired).
 *
 * A camera-centred radial grid spends vertices where wave displacement is
 * visible and lets cells grow smoothly toward the hazed horizon, rather than
 * wasting a uniform 80 km grid. `nearStepMeters` is the radial step of the
 * innermost rings and is now load-bearing twice over: it sets how short a wave
 * the mesh can carry at all (wave R's mesh-Nyquist cascade fade reads it), and
 * the disk's world position is quantised to a multiple of it so residual
 * lattice aliasing stays glued to the WORLD instead of to the viewer.
 */
export interface OceanPresentationTopology {
  readonly radialRings: number;
  readonly angularSegments: number;
  readonly nearStepMeters: number;
}

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
  /**
   * `7-5`: whether the bloom post-process runs.
   *
   * DATA, NOT A `profile.tier` BRANCH, per the tier rule -- and here that rule
   * is load-bearing rather than stylistic. Whether tier 2 should carry 4x MSAA
   * at all is a fidelity call for Jason, and if it drops to 1x, tier 2's bloom
   * question reopens with real headroom. Keeping this a data field makes that
   * a GATE FLIP rather than a redesign.
   *
   * Why the rows below are what they are, with the reason per row rather than
   * one blanket justification -- they are not the same reason:
   *  - tier 0: UNMEASURED, not refused. Nobody has priced bloom there.
   *  - tier 1: ON. The gate was ratified here, and this is the tier whose
   *    headroom is actually measured.
   *  - tiers 2 and Ultra: UNFUNDED. The plan funded bloom against tier 2's
   *    0.05 ms of *modelled* slack (D-4, §2.3(g)); the sweep measured a
   *    10.0-46.7 ms deficit at 0 of 21 shot-configurations, of which 32.79 ms
   *    is `msaaSamples` alone. There is no slack to fund against, and the sign
   *    is wrong rather than the magnitude.
   *
   * COST AND SAMPLES. Bloom is not the first post-process, so it reads a
   * RESOLVED target -- `toneMap.samples = 1` already records that non-first
   * passes are single-sampled. Its marginal cost should therefore be
   * independent of `msaaSamples`, which is the opposite of the assumption that
   * a post-process cost must carry a sample count. That is a claim to be
   * MEASURED at both 1x and 4x before it is quoted, not asserted here.
   */
  readonly bloomEnabled: boolean;
  readonly msaaSamples: number;
  /**
   * The tier's controllable frame-time target (Z-2), mirrored from
   * `FRAME_TARGET_MS` so consumers read a profile datum instead of a tier
   * table. A hitch is a frame slower than twice this number.
   */
  readonly frameTargetMs: number;
  /** R-21: the tier's rendered-density law (the one vegetation authority). */
  readonly renderedDensityLaw: RenderedDensityLaw;
  /** Wave G: the tier's ground-cover blade law (rings, densities, gate). */
  readonly groundCoverLaw: GroundCoverLaw;
  /** 2-12: cap on crown-geometry variants per selected prototype species. */
  readonly treeVariantCap: number;
  /**
   * Tier 0/1 collapse authored species into conifer, broadleaf and willow
   * prototype families. Per-instance dimensions, tint, lean and wind remain
   * intact; only the mesh prototype is shared. This is the draw-call lever:
   * the old five-variant, seven-species tier-1 path submitted roughly two
   * hundred vegetation draws and missed 60 fps by a wide margin.
   */
  readonly treePrototypeMode: "families" | "species";
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
   *
   * **`4.5-A1` re-measured this and left every value alone, deliberately.**
   * Under the global error queue the NODE BUDGET binds first at every shipped
   * tier: with real kernel deviations the selector spends its whole budget at
   * thresholds of 3 AND 6 pixels and produces the identical node set, because
   * a kilometre-texel node at the horizon subtends far more than either. The
   * threshold is now the knob that governs the un-budget-bound case (calm
   * ocean, high cruise over flat ground); `cdlodNodeBudget` is the knob that
   * governs how fine the ground gets under the aircraft.
   */
  readonly cdlodPixelThreshold: number;
  /**
   * `4-0`/`4-5`: ceiling on simultaneously drawn CDLOD nodes.
   *
   * `4.5-A1` re-tuned this against the new selector. Measured with real kernel
   * deviations at 500 ft over the baseline airport, the level under the camera
   * is a step function of this number: 240 converges at L3, 288-320 reaches
   * L2. The values below are the smallest that reach each tier's intended
   * level; page demand goes up with them and stays far inside every atlas
   * (tier 1: 24 pages + 4 parents against 196 slots).
   */
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
  /**
   * `7-4b`/`7-9`: the clustered light container's tile and slice geometry.
   *
   * **Profile data rather than a runtime lever, and that is a Babylon
   * constraint rather than a preference.** Changing any of the three
   * reallocates the tile-mask texture, the storage buffer and the thin-instance
   * matrix buffer, so `ClusteredLightingSystem` applies them once at
   * construction and never again.
   *
   * **UNIFORM ACROSS TIERS TODAY, AND THAT IS DELIBERATE RATHER THAN
   * UNFINISHED.** Slices drive the per-light-slot UBO — `vSliceData: vec2f`
   * plus `vSliceRanges: array<vec4f, CLUSTLIGHT_SLICES>`, so 2 + 4x slices
   * floats, 264 B at 16 — which is far too small to differentiate on memory
   * against the 2.7 MiB of inventoried headroom. The real cost of coarser tiles
   * is MORE LIGHTS PER TILE and therefore more per-pixel shading, and that is a
   * frame-time question. **Differentiating these rows without measuring it
   * would be inventing four numbers and calling them a tier row**, which is the
   * failure `7-9` exists to avoid. The mechanism is wired so the sweep can tune
   * it; the sweep is blocked on a quiet host.
   */
  readonly clusteredLighting: {
    readonly horizontalTiles: number;
    readonly verticalTiles: number;
    readonly depthSlices: number;
  };
  readonly shadowMapSize: number;
  readonly shadowCascades: number;
  readonly shadowDistance: number;
  readonly oceanResolution: 128 | 256;
  readonly oceanCascades: number;
  /**
   * wave R: the ocean presentation lattice. Data, not a `profile.tier` branch,
   * per the tier rule — this row is why `SpectralOceanSystem.ts` could leave
   * the boundary test's grandfathered-reader list.
   */
  readonly oceanPresentation: OceanPresentationTopology;
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
  /**
   * `4.5-C1`: whether near-band vegetation is registered as a SHADOW CASTER.
   *
   * The largest single term in the tier-1 vegetation draw model: the near band
   * submits every (species, variant, crown/trunk) mesh once per cascade, which
   * at 2×1280 cascades is 148 of 347 draws and **3.85 ms of the modelled 9.0
   * ms** — the cheapest large win that exists, and one no item before Phase 6
   * otherwise owns. Trees keep the shadows they RECEIVE (the horizon map and
   * the cloud-shadow projection are unaffected); what goes is the shadow a
   * tree casts on the ground beside it.
   *
   * §5.3's ordered lever list does not contain shadow casting, and neither
   * does its "not budget knobs at any tier" fidelity list. The governing
   * precedent is D15, which cut a tier-2 cascade specifically to reduce
   * vegetation shadow draws — i.e. the shadow side is outside the vegetation
   * ladder. This knob only ever lowers a count row, so the §5.3 ratchet is
   * satisfied.
   *
   * Data, not a `profile.tier` branch, per the tier rule.
   */
  readonly vegetationCastsShadows: boolean;
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
function resolveBaseQualityProfile(
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
      bloomEnabled: false,
      msaaSamples: 1,
      frameTargetMs: 13.7,
      renderedDensityLaw: RENDERED_DENSITY_LAWS[0]!,
      groundCoverLaw: GROUND_COVER_LAWS[0]!,
      treeVariantCap: 1,
      treePrototypeMode: "families",
      grassRadiusMeters: 90,
      materialArrayEdge: 256,
      terrainTriplanarMode: "planar",
      heightBlendMaxMaterials: 2,
      cdlodPixelThreshold: 4,
      // `4.5-A1`: 160 -> 224. Low keeps L3 (512 m nodes, 16 m height texels)
      // under the aircraft rather than the L6 the per-level loop converged on.
      cdlodNodeBudget: 224,
      // Low never streams L0: 4 m effective spacing without a second page
      // geometry, and one less level of streaming pressure.
      finestResidentLevel: 1,
      heightAtlasSlots: 144,
      // DEVIATION from §5.3's 144, recorded in PHASE_4_EXECUTION_PLAN.md §4
      // **D14** (this comment said D13 until `4.5-D`'s stale-comment sweep;
      // the plan document's numbering is authoritative and D13 is the `P1`
      // headroom re-measure): at 144 the derived channel atlas is
      // 71.1 MiB raw here, leaving
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
      clusteredLighting: { horizontalTiles: 64, verticalTiles: 64, depthSlices: 16 },
      shadowDistance: 900,
      oceanResolution: 128,
      oceanCascades: 3,
      // wave R deliberately left Low's lattice ALONE. Shrinking the near step
      // without adding rings is not free: the rings spent close in are rings
      // the quintic ramp no longer has, so the step at 20-30 m grows. Measured
      // on the harness, 1 m -> 0.5 m at 96 rings moves cascade 0's mesh fade
      // end 29.9 m -> 23.3 m, i.e. it takes MORE near chop away than the first
      // two metres of finer lattice give back. Low keeps 1 m.
      oceanPresentation: {
        radialRings: 96,
        angularSegments: 128,
        nearStepMeters: 1,
      },
      cloudResolutionScale: 0.25,
      maxCloudPixels: 350_000,
      cloudPrimarySteps: 40,
      cloudLightSteps: 4,
      vegetationDistance: 2_000,
      vegetationDensity: 0.45,
      // `4.5-C1`: off below tier 2. At tier 0 the shadow term is 106 of 257
      // modelled draws.
      vegetationCastsShadows: false,
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
      // Tier 1 is the strict playability contract. Closed opaque crowns make
      // early-Z useful, but a 2× multisampled half-float beauty target still
      // duplicates its dominant colour/depth traffic. FXAA is already the
      // renderer's sample-count-1 path, so Balanced spends this row on frame
      // cadence rather than hardware MSAA; higher tiers retain multisampling.
      bloomEnabled: true,
      msaaSamples: 1,
      frameTargetMs: 13.7,
      renderedDensityLaw: RENDERED_DENSITY_LAWS[1]!,
      groundCoverLaw: GROUND_COVER_LAWS[1]!,
      // Playability is the tier-1 contract. Yaw, scale, lean, colour and wind
      // retain stem-level variation; one mesh variant per prototype family
      // removes the dominant species×variant×band submission multiplier.
      treeVariantCap: 1,
      treePrototypeMode: "families",
      // `4.5-C1`'s A/B left this at §5.3's Balanced row. §7 ranks
      // `grassRadiusMeters` 150 → 90-110 as the next lever after vegetation
      // shadow casting, at "~7 ms extra in ground-level shots"; measured at
      // the `ground-2m-lowsun` pose it moves ground-cover instances 3,372 →
      // 1,836 (a real cut, the knob works) and the shot's GPU p95 by 0.11 ms,
      // which is noise. Row 3 of §7 is a single-reader estimate and the
      // measurement does not support it here. `6-11` owns the re-tier.
      grassRadiusMeters: 150,
      materialArrayEdge: 512,
      terrainTriplanarMode: "biplanar",
      heightBlendMaxMaterials: 3,
      cdlodPixelThreshold: 3,
      // `4.5-A1`: 240 -> 320, the measured step that reaches L2 (128 m nodes,
      // 4 m height texels) under the aircraft at 500 ft. At 240 the new
      // selector converges at L3 and at 288 it reaches L2 with no margin.
      cdlodNodeBudget: 320,
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
      clusteredLighting: { horizontalTiles: 64, verticalTiles: 64, depthSlices: 16 },
      shadowDistance: 1_400,
      oceanResolution: 128,
      oceanCascades: 4,
      // wave R: 144 rings / 0.75 m -> 200 rings / 0.25 m. At 0.75 m the near
      // lattice could not carry ANY of cascade 0's 1-8 m band without
      // aliasing, and the radial step passed the band's own half-wavelength
      // (4 m) at 44 m from the eye — the measured source of the reported
      // "plastic tubes". At 0.25 m/200 rings that radius moves to 49.5 m and
      // the innermost 7.5 m genuinely resolves half-metre waves. Cost: 27,649
      // -> 38,401 vertices and 55,104 -> 76,608 triangles on one disk.
      oceanPresentation: {
        radialRings: 200,
        angularSegments: 192,
        nearStepMeters: 0.25,
      },
      cloudResolutionScale: 0.45,
      maxCloudPixels: 700_000,
      cloudPrimarySteps: 60,
      cloudLightSteps: 6,
      // Perf-debt pass: §5.3's Balanced impostor radius. Gate 2C shipped
      // 4,500 m against a table that says 3,000; the far band's submitted
      // chunk count falls with the square of this number.
      vegetationDistance: 3_000,
      vegetationDensity: 0.75,
      // `4.5-C1`: OFF at the G-C tier. 148 of 347 modelled draws, 3.85 of the
      // 9.02 ms row.
      vegetationCastsShadows: false,
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
      bloomEnabled: false,
      msaaSamples: 4,
      frameTargetMs: 13.7,
      renderedDensityLaw: RENDERED_DENSITY_LAWS[2]!,
      groundCoverLaw: GROUND_COVER_LAWS[2]!,
      treeVariantCap: 5,
      treePrototypeMode: "species",
      grassRadiusMeters: 220,
      materialArrayEdge: 512,
      terrainTriplanarMode: "triplanar",
      heightBlendMaxMaterials: 4,
      cdlodPixelThreshold: 2,
      // `4.5-A1`: 320 -> 448. Same L2 floor as tier 1 with the mid field
      // carried a level finer.
      cdlodNodeBudget: 448,
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
      // `7-CSM`: 3 -> 2. Cascades were bought here on the assumption that more
      // of them means more coverage. MEASURED off `_splitFrustum` on the
      // shipping constants, the opposite holds: a log-weighted split pushes the
      // FIRST split nearer as cascades are added, so 3 cascades gave cascade 0
      // only 133.8 m where 2 give it 207.4 m — and every cascade past the first
      // was costing a full-resolution render for range the tier below covered
      // better. Two cascades cover the whole 1,800 m at 2 renders per caster.
      shadowCascades: 2,
      clusteredLighting: { horizontalTiles: 64, verticalTiles: 64, depthSlices: 16 },
      shadowDistance: 1_800,
      oceanResolution: 256,
      oceanCascades: 5,
      // wave R: strictly denser than tier 1 on every axis. 240 rings keeps the
      // disk inside 16-bit indices (61,441 vertices against the 65,535 limit),
      // which is worth more than the four extra rings 256 would buy.
      oceanPresentation: {
        radialRings: 240,
        angularSegments: 256,
        nearStepMeters: 0.2,
      },
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
      // High and Ultra keep tree shadows: their frame targets are met by
      // spending pixels, and D15 already cut this tier's cascade count once.
      vegetationCastsShadows: true,
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
    bloomEnabled: false,
    msaaSamples: 4,
    frameTargetMs: 30,
    renderedDensityLaw: RENDERED_DENSITY_LAWS[3]!,
      groundCoverLaw: GROUND_COVER_LAWS[3]!,
    treeVariantCap: 5,
    treePrototypeMode: "species",
    grassRadiusMeters: 320,
    materialArrayEdge: 512,
    terrainTriplanarMode: "triplanar",
    heightBlendMaxMaterials: 4,
    cdlodPixelThreshold: 1.5,
    // `4.5-A1`: 448 -> 640.
    cdlodNodeBudget: 640,
    finestResidentLevel: 0,
    heightAtlasSlots: 256,
    channelAtlasSlots: 256,
    // `4-8b`: 2048 @ 2400 m. PCSS struck here too (see tier 2).
    shadowMapSize: 2_048,
    // `7-CSM`: 4 -> 2, and this tier is why the rule was found. At 4 cascades
    // cascade 0 reached 132.8 m — LESS near coverage than tier 1's 162.3 m,
    // while paying for a larger map and four array layers. At 2 it reaches
    // 274.8 m and covers the full 2,400 m.
    //
    // MEASURED at tier 3, three arms interleaved two runs each: rendering all
    // FOUR cascades costs -12.6% mean fps (-21.3% worst) and +128 MiB against
    // shipped, while TWO cascades cost nothing resolvable (+0.3% mean; the four
    // per-shot deltas alternate sign, which is what no effect looks like).
    // The cost tracks the number of full-resolution cascade renders, NOT the
    // draw count: +31% draw calls was free, +96% was not.
    shadowCascades: 2,
    clusteredLighting: { horizontalTiles: 64, verticalTiles: 64, depthSlices: 16 },
    shadowDistance: 2_400,
    oceanResolution: 256,
    oceanCascades: 5,
    // wave R: Ultra matches tier 2's lattice, as it matches every other ocean
    // row (§5.3's remaining Ultra ocean rows belong to a later phase).
    oceanPresentation: {
      radialRings: 240,
      angularSegments: 256,
      nearStepMeters: 0.2,
    },
    cloudResolutionScale: 0.7,
    maxCloudPixels: 1_600_000,
    cloudPrimarySteps: 96,
    cloudLightSteps: 6,
    // Perf-debt pass: §5.3's Ultra impostor radius.
    vegetationDistance: 6_000,
    vegetationDensity: 1,
    vegetationCastsShadows: true,
    activeAnimalBudget: 128,
  };
}

/**
 * Fields the override may never touch, because they are IDENTITY rather than
 * configuration: other code keys on them (`FRAME_BUDGET_MS[tier]`,
 * `OTHER_DETAIL_ALLOWANCE_MIB[tier]`, the capture's delivery contract), so
 * overriding one corrupts every downstream lookup instead of testing a field.
 * Stripped here rather than left to the caller's discipline — the experiment's
 * scope exclusion is enforced by construction, the same reason the override
 * lives at the single point of resolution.
 */
const PROFILE_OVERRIDE_FORBIDDEN_KEYS = ["tier", "quality", "mode", "frameTargetMs"] as const;

let captureExperimentProfileOverride: Partial<WebGpuQualityProfile> | null = null;

/**
 * TEST-ONLY. Force individual profile fields for the tier-cliff A/B capture.
 *
 * **What it is for.** Tier 2 misses its 13.7 ms frame contract on 0 of 21
 * measured shot-configurations, by 10.0-46.7 ms, and **30 of 35 profile fields
 * differ between tier 1 and tier 2**, so the cause cannot be isolated by
 * reading the diff. The A/B reverts one group of fields at a time from tier 2
 * toward tier 1 and measures the recovery. Nothing else can vary a single
 * field: the profile is a frozen literal per tier.
 *
 * **Why it lives here rather than in `FlightRendererOptions`.** The profile is
 * resolved at THREE sites in `FlightRenderer` (construction, the async create
 * path, and the runtime quality switch). An override threaded through options
 * could be applied at some and not others, producing an experiment arm that
 * silently tested a MIXTURE of tier-1 and tier-2 fields — and that arm would
 * look like a clean measurement. Applying it at the single point of resolution
 * makes that inconsistency impossible rather than unlikely.
 *
 * **What removes it.** Delete this, its clearer, and the wrapper below once the
 * cliff has a cause — the finding is the deliverable, not the scaffold. If the
 * A/B returns NULL (the cliff is not in the profile at all) it should be
 * deleted too, because a scaffold kept for a question it could not answer is
 * how an experiment hook becomes API. It has no other caller by design, and
 * `tests/render.webgpu-profile-override-absent.test.ts` fails the build if one
 * appears under `src/`.
 */
export function __setProfileOverrideForCaptureExperimentsOnly(
  override: Partial<WebGpuQualityProfile> | null,
): void {
  if (!override) {
    captureExperimentProfileOverride = null;
    return;
  }
  const safe: Record<string, unknown> = { ...override };
  for (const key of PROFILE_OVERRIDE_FORBIDDEN_KEYS) delete safe[key];
  captureExperimentProfileOverride = safe as Partial<WebGpuQualityProfile>;
}

/**
 * Resolve the tier profile, applying the capture experiment's override if one
 * is set. Inert — and identical to `resolveBaseQualityProfile` — when it is not,
 * which is every path that is not the A/B harness.
 */
export function resolveWebGpuQualityProfile(
  quality: QualityLevel,
  mode: RenderingMode,
): WebGpuQualityProfile {
  const base = resolveBaseQualityProfile(quality, mode);
  if (!captureExperimentProfileOverride) return base;
  return Object.freeze({ ...base, ...captureExperimentProfileOverride });
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

/** A hitch is a frame slower than twice the tier's controllable target. */
export function hitchThresholdMilliseconds(profile: Pick<WebGpuQualityProfile, "frameTargetMs">): number {
  return profile.frameTargetMs * 2;
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
