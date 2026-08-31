/**
 * Fixed-seed screenshot and numeric capture (1A-1c) — the pure half.
 *
 * INVARIANT THIS FILE OWNS: the perf capture's shot list, image statistics
 * (tile-wise mean/variance) and the SSIM comparison are deterministic pure
 * functions, so a baseline diff can only come from the renderer.
 *
 * The driver that boots the renderer lives in tests/perf/perf-capture.test.ts
 * and runs under vitest.perf.config.ts (`npm run perf:capture`); it imports
 * everything below. Class P: no Babylon, no DOM, no Node APIs.
 */

export const PERF_CAPTURE_SEED = "phase1-perf-baseline";
export const PERF_CAPTURE_WIDTH = 1_280;
export const PERF_CAPTURE_HEIGHT = 720;
/** Frames rendered before the capture so streaming and temporal state settle. */
export const PERF_CAPTURE_WARMUP_FRAMES = 240;
export const PERF_CAPTURE_TILE = 32;
export const PERF_CAPTURE_COLOR_TILE = 64;
/**
 * A screenshot must contain local luminance structure, not merely non-black
 * pixels. The dim but valid night reference measures 0.000178; the known
 * uniform `high-10000ft-down` failure measured 0.000006.
 */
export const PERF_CAPTURE_MIN_MEAN_TILE_VARIANCE = 0.000_1;
/** A tile with at least this much local variance carries visible structure. */
export const PERF_CAPTURE_STRUCTURED_TILE_VARIANCE = 0.000_01;
/** Local structure must cover the frame rather than hide in one noisy patch. */
export const PERF_CAPTURE_MIN_STRUCTURED_TILE_FRACTION = 0.5;
/** SSIM below this against the committed baseline fails the capture. */
export const PERF_CAPTURE_SSIM_THRESHOLD = 0.985;
/** Per-channel SSIM catches hue/chroma regressions that luma SSIM cannot see. */
export const PERF_CAPTURE_RGB_SSIM_THRESHOLD = 0.95;
/** The lower frame isolates nearby terrain/foliage from a stable sky majority. */
export const PERF_CAPTURE_LOWER_FRAME_RGB_SSIM_THRESHOLD = 0.94;
/** A local defect cannot hide inside a good whole-frame average. */
export const PERF_CAPTURE_WORST_TILE_RGB_SSIM_THRESHOLD = 0.72;
/** rAF-paced frames measured per shot (Z-1/Z-2): fps and hitch metrics come only from these. */
export const PERF_CAPTURE_MEASURE_FRAMES = 240;
/** Consecutive frames read back at the end of a motion shot for temporal metrics (Z-3). */
export const PERF_CAPTURE_TEMPORAL_FRAMES = 24;

/** The strict tier-1 (medium/balanced) delivery contract. */
export const PERF_CAPTURE_FRAME_BUDGET_MS = 16.67;
export const PERF_CAPTURE_HITCH_BUDGET_MS = 27.4;
export const PERF_CAPTURE_MAX_FRAME_MS = 50;
export const PERF_CAPTURE_MAX_HITCHES = 5;
export const PERF_CAPTURE_MIN_WALL_CLOCK_FPS = 60;

/**
 * `6-11.1` — the delivery contract at each TIER's own frame target.
 *
 * The constants above are tier 1's and stay exactly as they are: tier 1 is the
 * shipping default and the standing regression gate, and nothing here may move
 * it. This table exists so the four-tier sweep can hold each tier to its own
 * promise instead of to tier 1's, which would fail Ultra for being Ultra.
 *
 * Tiers 0–2 share tier 1's contract because §5.3 gives all three the same
 * 13.7 ms internal frame target — they differ in what they DRAW, not in how
 * fast they must deliver it. Tier 3 (Ultra) is the exception the table exists
 * for: `FRAME_TARGET_MS[3]` is 30.0 ms, so it promises 30 fps, and every
 * threshold scales by the same 2x rather than being re-invented. A tier-3
 * capture judged at 60 fps would report a failure that is not one.
 */
export interface PerfCaptureDeliveryContract {
  readonly minWallClockFps: number;
  readonly frameBudgetMs: number;
  readonly hitchBudgetMs: number;
  readonly maxHitches: number;
  readonly maxFrameMs: number;
}

export function perfCaptureDeliveryContract(tier: number): PerfCaptureDeliveryContract {
  if (tier === 3) {
    return {
      minWallClockFps: 30,
      frameBudgetMs: 33.34,
      hitchBudgetMs: PERF_CAPTURE_HITCH_BUDGET_MS * 2,
      maxHitches: PERF_CAPTURE_MAX_HITCHES,
      maxFrameMs: PERF_CAPTURE_MAX_FRAME_MS * 2,
    };
  }
  return {
    minWallClockFps: PERF_CAPTURE_MIN_WALL_CLOCK_FPS,
    frameBudgetMs: PERF_CAPTURE_FRAME_BUDGET_MS,
    hitchBudgetMs: PERF_CAPTURE_HITCH_BUDGET_MS,
    maxHitches: PERF_CAPTURE_MAX_HITCHES,
    maxFrameMs: PERF_CAPTURE_MAX_FRAME_MS,
  };
}

/** The sweep's three viewports (`6-11.1`), smallest first. */
export const PERF_CAPTURE_SWEEP_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "720p", width: 1_280, height: 720 }),
  Object.freeze({ name: "1080p", width: 1_920, height: 1_080 }),
  Object.freeze({ name: "1440p", width: 2_560, height: 1_440 }),
]);

/** The sweep's four tiers, as the (quality, mode) pairs that resolve to them. */
export const PERF_CAPTURE_SWEEP_TIERS = Object.freeze([
  Object.freeze({ tier: 0, quality: "low" as const, mode: "balanced" as const }),
  Object.freeze({ tier: 1, quality: "medium" as const, mode: "balanced" as const }),
  Object.freeze({ tier: 2, quality: "high" as const, mode: "balanced" as const }),
  Object.freeze({ tier: 3, quality: "high" as const, mode: "ultra" as const }),
]);

export interface PerfCaptureClock {
  readonly dayOfYear: number;
  readonly solarTimeHours: number;
}

/** The default clock every Phase-1 baseline was measured at (D-10). */
export const PERF_CAPTURE_DEFAULT_CLOCK: PerfCaptureClock = Object.freeze({
  dayOfYear: 171,
  solarTimeHours: 12.5,
});

/**
 * Z-2: hard per-shot ceilings, asserted by the driver. These are measured
 * numbers with headroom, not aspirations — a breach is a performance
 * regression the same way an SSIM drop is a visual one. `null` skips the
 * assertion (used exactly once, when first landing a new shot to measure it).
 *
 * Gate 0-a (Phase 6) re-pinned every row from three clean idle-reference-host
 * runs (2026-08-30, apple metal-3, deliveryGatesEnforced, gpuTiming off;
 * cross-run spread: fps ±0.5, drawCalls identical, hitches 0 everywhere).
 * Pinning rules, superseding the 2018-08-18 Z-2 rules because absolute rates
 * tripled and host thermal drift is ~20%:
 *   minFps / minWallClockFps = floor(min-across-runs × 0.85)
 *   maxFrameIntervalMsP95    = ceil(max-across-runs × 1.2, 0.1)
 *   hitchCount (renderer-ring 2×13.7 ms count, NOT framesOver27_4Ms)
 *                            = max(2 × measured, 3)
 *   maxFrameMs               = 50, aligned with the strict tier-1 gate
 *   p999FrameMs              = min(50, ceil(max-across-runs × 1.5))
 * Rows move only at PHASE_6_EXECUTION_PLAN.md §9 rebaseline points, by
 * recorded decision, re-pinned from fresh runs — never loosened in place.
 */
export interface PerfCaptureShotCeilings {
  readonly maxFrameMs: number;
  readonly p999FrameMs: number;
  readonly hitchCount: number;
  readonly minFps: number;
  /** Gate 0-a: raw (untrimmed) wall-clock fps floor. */
  readonly minWallClockFps: number;
  /** Gate 0-a: raw frame-interval p95 ceiling, milliseconds. */
  readonly maxFrameIntervalMsP95: number;
}

/**
 * Gate 0-c (Phase 6, = 6-11.4a): tolerance for the recorded pre-existing
 * inventoried-memory overage above the tier-1 estimate ceiling. The gating
 * estimate reads ~380 MiB while the Babylon texture+geometry inventory floor
 * measures 489.0 MiB at reference-viewport (the shot where the cap binds) —
 * only the estimate gates, which is ~100 MiB of false headroom. This assert
 * catches every NEW allocation against the real number. The tolerance is the
 * measured 2026-08-30 maximum plus 6 MiB of slack; 6-11.4 reconciles the
 * estimate model and ratchets this back down.
 */
export const PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB = 495;

/** Human-readable inventoried-memory failures, shared by driver and unit tests. */
export function inventoriedMemoryFailures(
  inventoriedGpuMemoryMiB: number,
  ceilingMiB: number = PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB,
): string[] {
  if (!Number.isFinite(inventoriedGpuMemoryMiB) || inventoriedGpuMemoryMiB <= 0) {
    return [`inventoried GPU memory ${inventoriedGpuMemoryMiB} MiB is not a plausible reading`];
  }
  if (inventoriedGpuMemoryMiB > ceilingMiB) {
    return [
      `inventoried GPU memory ${inventoriedGpuMemoryMiB.toFixed(1)} MiB exceeds the `
      + `${ceilingMiB} MiB pinned ceiling`,
    ];
  }
  return [];
}

export interface PerfCaptureShotDefinition {
  readonly name: string;
  readonly description: string;
  readonly cameraMode: "chase" | "cockpit";
  /** Metres above the local terrain (AGL shots) — resolved by the driver. */
  readonly altitudeAglMeters: number | null;
  /** Metres above sea level when not AGL-anchored. */
  readonly altitudeMslMeters: number | null;
  /** Horizontal offset from the airport centre, metres. */
  readonly offsetXMeters: number;
  readonly offsetZMeters: number;
  /** Pitch-down angle of the aircraft body, degrees. */
  readonly pitchDownDegrees: number;
  readonly airspeedMetersPerSecond: number;
  /** Z-3: per-shot environment clock (R-15) — defaults to the D-10 clock. */
  readonly clock?: PerfCaptureClock;
  /** Z-3: viewport override; defaults to 1280×720 @ DPR 1. */
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  /** Optional DPR/cap-equivalent stress scale; ordinary shots use tier 1's 0.86. */
  readonly captureRenderScale?: number;
  /**
   * Z-3: heading as the sun bearing off the nose in degrees (0 = flying into
   * the sun, 180 = sun dead astern). Resolved by the driver against the
   * shot's own clock. Unset = fly +x, the Phase-1 convention.
   */
  readonly relativeSunBearingDegrees?: number;
  /** Z-3: locate the shot over a terrain feature instead of a fixed offset. */
  readonly locate?: "fixed" | "forest" | "grassland" | "mountain" | "cliff" | "coast";
  /** Z-3: "motion" runs a scripted banked turn and asserts temporal stability. */
  readonly kind?: "still" | "motion";
  /** Bank angle used by motion shots, degrees. */
  readonly bankDegrees?: number;
  /**
   * Minimum acceptable mean luminance. The night shot lowers this: before
   * Gate 7A the night ground is genuinely near-black, and the shot exists to
   * make that measurable, not to pretend otherwise.
  */
  readonly minMeanLuminance?: number;
  /**
   * Minimum mean within-tile luminance variance. This is an independent
   * non-vacuity gate: a uniformly grey frame can satisfy mean luminance and
   * match a stale blank baseline. Defaults to the capture-wide floor above.
   */
  readonly minMeanTileVariance?: number;
  /** Minimum fraction of 32 px tiles carrying local luminance structure. */
  readonly minStructuredTileFraction?: number;
  /** Motion shots do not diff against a PNG baseline (their gate is temporal). */
  readonly comparesToBaseline?: boolean;
  /**
   * Per-shot SSIM floor override. The resize-path shot carries slightly more
   * temporal variance than the fixed-viewport shots (measured 0.981 against
   * its own fresh baseline); everything else uses PERF_CAPTURE_SSIM_THRESHOLD.
   */
  readonly ssimThreshold?: number;
  /** Optional override for whole-frame, per-channel RGB SSIM. */
  readonly rgbSsimThreshold?: number;
  /** Optional override for RGB SSIM over the lower 60% of the frame. */
  readonly lowerFrameRgbSsimThreshold?: number;
  /** Optional override for the least-similar full 64px tile. */
  readonly worstTileRgbSsimThreshold?: number;
  /** Z-3: committed floors for the motion shot's temporal-stability metrics. */
  readonly temporalFloors?: {
    readonly minConsecutiveSsim: number;
    readonly maxMeanLuminanceDelta: number;
  };
  readonly ceilings: PerfCaptureShotCeilings | null;
  /**
   * Gate 0-a (Phase 6): measured drawCalls ceiling. Host-INDEPENDENT (draw
   * counts were byte-identical across the three pinning runs), so it lives
   * outside the nullable delivery row and is asserted hard on every host —
   * real draw growth the rendered-density model cannot see (conservative
   * shadow-pass draws, new water meshes) fails here.
   */
  readonly drawCallCeiling?: number;
  /**
   * W-7 (Phase 6 Gate W): the world this shot captures. Defaults to
   * "analytic" (the shipping default). Eroded shots must be APPENDED after
   * every analytic shot — the driver rebuilds the world and renderer at each
   * mode boundary (dispose-before-create; the 480 MiB wall forbids two
   * resident worlds), so grouping by mode keeps that to one rebuild per run,
   * and appending preserves every existing canonical phase index.
   */
  readonly worldEvolution?: "analytic" | "eroded";
  /**
   * `4-10`: page-residency ceilings, for the scenes that exist to stress
   * streaming rather than shading.
   *
   * Peak `pendingTerrainPages` is the streaming pump's queue depth and peak
   * `residentTerrainPages` is the atlas's occupancy; a turn that admits pages
   * faster than the compute meter retires them shows up here as a rising
   * pending count long before it shows up as a hitch.
   */
  readonly residencyCeilings?: {
    readonly maxPendingTerrainPages: number;
    readonly maxResidentTerrainPages: number;
  };
}

/**
 * The capture shot list. Three Phase-1 shots, Gate 2Z's coverage additions
 * (reference viewport, cruise horizon, winter noon, night, the banked-turn
 * motion scene — R-8/R-9/R-15), and the five Phase-2 §10.2 scenes including
 * the 2 m eye-height and 1,200 ft canopy views. Positions are relative to the
 * world's airport so the definitions survive seed changes at sanctioned
 * rebaselines; forest/coast shots locate themselves from the terrain field.
 * The per-shot ceilings below are supplemental diagnostics. They cannot relax
 * or replace the strict tier-1 raw delivery contract declared at the top of
 * this file.
 *
 * Every per-shot ceilings row is pinned by Gate 0-a (2026-08-30) under the
 * rules recorded in the PerfCaptureShotCeilings docblock. Floors move only at
 * PHASE_6_EXECUTION_PLAN.md §9 rebaseline points, by recorded decision.
 *
 * Retained from the superseded pinning history: canopy-1200ft was the one
 * shot Phase 3 made slower, re-pinned 27 → 24 at the 2026-08-19 churn point.
 */
export const PERF_CAPTURE_SHOTS: readonly PerfCaptureShotDefinition[] = Object.freeze([
  {
    name: "approach-500ft",
    description: "500 ft AGL, 2.5 km out on approach to the airport",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 158,
  },
  {
    name: "slant-10km",
    description: "Mid-altitude view with ~10 km of terrain in slant range",
    cameraMode: "chase",
    altitudeAglMeters: null,
    altitudeMslMeters: 1_200,
    offsetXMeters: -8_000,
    offsetZMeters: 4_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 84,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.6 },
    drawCallCeiling: 140,
  },
  {
    name: "high-10000ft-down",
    description: "10,000 ft MSL, cockpit view pitched 45° down",
    cameraMode: "cockpit",
    altitudeAglMeters: null,
    altitudeMslMeters: 3_048,
    offsetXMeters: 2_000,
    // The old -6 km placement aimed every reconstructed view ray at open
    // ocean, so a smooth water/haze frame could masquerade as a terrain gate.
    // +8 km keeps the entire 45-degree-down frustum over deterministic land.
    offsetZMeters: 8_000,
    pitchDownDegrees: 45,
    airspeedMetersPerSecond: 92,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 144,
  },
  {
    // Z-3: the high-DPR/cap-equivalent lane. A deterministic DPR-1 browser at
    // scale 1 rasterises 1.485 Mpx, matching the tier-1 1.5 Mpx cap without
    // silently making every ordinary 1280×720 shot 35% heavier than shipping.
    name: "reference-viewport",
    description: "Approach pose at the 1512×982 reference viewport (shipping tier-1 scale)",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    viewportWidth: 1_512,
    viewportHeight: 982,
    captureRenderScale: 1,
    ssimThreshold: 0.975,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 18, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12.2 },
    drawCallCeiling: 159,
  },
  {
    // Z-3/R-9: the far-plane opacity criterion was only ever measured at
    // ground level; this shot keeps the slanted high-altitude horizon in the
    // baseline set permanently.
    name: "cruise-horizon",
    description: "10,000 ft MSL level flight, horizon and far plane in frame",
    cameraMode: "chase",
    altitudeAglMeters: null,
    altitudeMslMeters: 3_048,
    offsetXMeters: 2_000,
    offsetZMeters: -6_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 92,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.4 },
    drawCallCeiling: 137,
  },
  {
    // R-15: midwinter noon at 45°N — ~21.6° solar elevation, the longest
    // shadows and largest cascade workload the tier tables were never
    // measured at.
    name: "winter-noon",
    description: "Approach pose at midwinter noon (longest shadows of the year)",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    clock: { dayOfYear: 355, solarTimeHours: 12.5 },
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 18, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 158,
  },
  {
    // R-15: night. Pre-7A this is honestly near-black — the shot pins that
    // state so Gate 7A's change is a visible, sanctioned baseline churn.
    name: "night",
    description: "Approach pose at 23:45 solar time",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    clock: { dayOfYear: 171, solarTimeHours: 23.75 },
    // Gate 7A made this shot the noisiest in the set, and the reason is
    // structural rather than a defect: the scotopic pass's Naka-Rushton
    // response half-saturates at the SCENE's key luminance, so it applies a
    // large gain to a very dark image — and the cloud pass's own temporal
    // jitter, which is invisible by day, is amplified along with everything
    // else. Measured 0.972 between two runs of an identical build. 0.96
    // still catches a real regression (a missing moon, a frozen sidereal
    // frame and a broken rod blend all move it far further) while surviving
    // the jitter; the same per-shot relaxation the resize-path shot uses.
    ssimThreshold: 0.96,
    minMeanLuminance: 0.000_5,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 160,
  },
  {
    // Z-3: N consecutive rAF frames through a banked turn at 500 ft over the
    // treeline — the only reading of "no flicker" that is not an opinion.
    name: "motion-banked-turn",
    description: "45° banked turn at 500 ft AGL over closed forest (temporal stability)",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -4_000,
    offsetZMeters: 3_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    locate: "forest",
    kind: "motion",
    bankDegrees: 45,
    comparesToBaseline: false,
    // Measured 0.764 / 0.0007 (2026-08-18); flicker collapses the SSIM floor
    // and spikes the luminance delta by an order of magnitude.
    // Fix-pack re-pin 0.7 -> 0.67: the terrain meso band, crown cluster
    // shading and water capillary band add world-locked high-frequency
    // content, which lowers consecutive-frame SSIM under camera MOTION
    // without any flicker (page-thrash-turn measured 0.6988 at the fix-pack
    // close; the maxMeanLuminanceDelta flicker gate held). Genuine flicker
    // still fails both gates.
    temporalFloors: { minConsecutiveSsim: 0.67, maxMeanLuminanceDelta: 0.01 },
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 21, hitchCount: 3, minFps: 101, minWallClockFps: 99, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 163,
  },
  {
    // 4-10: the PAGE-THRASH scene. A sustained 60° turn at 500 ft forces the
    // quadtree to admit and evict L0 pages continuously — the one flight
    // manoeuvre that can outrun the compute meter, and the reason `4-0b`
    // exists. Its gate is hitch count and residency depth, not an image.
    name: "page-thrash-turn",
    description: "Sustained 60° banked turn at 500 ft AGL (L0 page admission under load)",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -3_200,
    offsetZMeters: 1_800,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 78,
    kind: "motion",
    bankDegrees: 60,
    comparesToBaseline: false,
    // Fix-pack re-pin 0.7 -> 0.67: the terrain meso band, crown cluster
    // shading and water capillary band add world-locked high-frequency
    // content, which lowers consecutive-frame SSIM under camera MOTION
    // without any flicker (page-thrash-turn measured 0.6988 at the fix-pack
    // close; the maxMeanLuminanceDelta flicker gate held). Genuine flicker
    // still fails both gates.
    temporalFloors: { minConsecutiveSsim: 0.67, maxMeanLuminanceDelta: 0.01 },
    // The residency ceilings below remain the Phase-4 DESIGN INTENTS — the
    // atlas holds 196 slots at tier 1, and a pump that leaves more than 24
    // pages pending is admitting faster than the meter retires. `4.5-D1`
    // measured them non-binding (see the next note). Gate 0-a (2026-08-30)
    // re-pinned only the delivery and draw-call rows; a residency re-pin waits
    // on the W-7 eroded-capture work, which changes what this scene admits.
    // `4.5-D1`: re-pinned from what the fixed selector actually produces
    // (measured 47-54 resident, 0 pending) rather than the tier's whole atlas
    // budget, which was a design intent nothing could fail.
    residencyCeilings: { maxPendingTerrainPages: 24, maxResidentTerrainPages: 88 },
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 19, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 162,
  },
  {
    // 4-10: the CDLOD-TRANSITION scene. Straight and level outbound from the
    // airport, so nodes cross level boundaries continuously in front of the
    // camera. Geomorph popping has a number here — the consecutive-frame SSIM
    // — instead of being a thing someone did or did not notice.
    name: "cdlod-transition",
    description: "Outbound climb across CDLOD level boundaries (geomorph stability)",
    cameraMode: "chase",
    altitudeAglMeters: null,
    altitudeMslMeters: 900,
    offsetXMeters: 5_500,
    offsetZMeters: -1_200,
    pitchDownDegrees: 12,
    airspeedMetersPerSecond: 96,
    kind: "motion",
    bankDegrees: 0,
    comparesToBaseline: false,
    // A geomorph that pops shows as a consecutive-frame SSIM collapse in
    // exactly the way flicker does; a working one is indistinguishable from
    // straight flight, which is the point of the item.
    // Fix-pack re-pin 0.7 -> 0.67: the terrain meso band, crown cluster
    // shading and water capillary band add world-locked high-frequency
    // content, which lowers consecutive-frame SSIM under camera MOTION
    // without any flicker (page-thrash-turn measured 0.6988 at the fix-pack
    // close; the maxMeanLuminanceDelta flicker gate held). Genuine flicker
    // still fails both gates.
    temporalFloors: { minConsecutiveSsim: 0.67, maxMeanLuminanceDelta: 0.01 },
    // `4.5-D1`: re-pinned from what the fixed selector actually produces
    // (measured 47-54 resident, 0 pending) rather than the tier's whole atlas
    // budget, which was a design intent nothing could fail.
    residencyCeilings: { maxPendingTerrainPages: 24, maxResidentTerrainPages: 88 },
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 17, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12.2 },
    drawCallCeiling: 130,
  },
  {
    // Phase 2 §10.2 scene 1: cloud shape, silver lining, shadowed sides.
    name: "cruise-sun-30",
    description: "Cruise at 7,500 ft, sun 30° off the nose, mid-afternoon",
    cameraMode: "chase",
    altitudeAglMeters: null,
    altitudeMslMeters: 2_286,
    offsetXMeters: 4_000,
    offsetZMeters: 2_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 92,
    clock: { dayOfYear: 171, solarTimeHours: 15 },
    relativeSunBearingDegrees: 30,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 18, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 139,
  },
  {
    // Phase 2 §10.2 scene 2: foliage translucency, grass scale reference,
    // the LOD transition band.
    name: "forest-500ft-sunbehind",
    description: "500 ft AGL over closed forest, sun dead astern",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -4_000,
    offsetZMeters: 3_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    clock: { dayOfYear: 171, solarTimeHours: 16.5 },
    relativeSunBearingDegrees: 180,
    locate: "forest",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 159,
  },
  {
    // Phase 2 §10.2 scene 3: sun glitter path, foam, aerial perspective
    // across the water/land boundary.
    name: "coast-10km-lowsun",
    description: "Coastline in ~10 km slant range, low sun over the water",
    cameraMode: "chase",
    altitudeAglMeters: null,
    altitudeMslMeters: 800,
    offsetXMeters: -12_000,
    offsetZMeters: 8_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 84,
    clock: { dayOfYear: 171, solarTimeHours: 19 },
    locate: "coast",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.7 },
    drawCallCeiling: 135,
  },
  {
    // Phase 2 §10.2 scene 4 — the only capture in the programme taken from
    // the height a person stands at. Grass blade separation, ground-cover
    // mix, clutter bedding, trunk and bark at rollout range.
    name: "ground-2m-lowsun",
    description: "On the ground at the airfield boundary, ~2 m eye height, raking sun",
    cameraMode: "cockpit",
    altitudeAglMeters: 0.9,
    altitudeMslMeters: null,
    offsetXMeters: -650,
    offsetZMeters: 120,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 18.5 },
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12.6 },
    drawCallCeiling: 167,
  },
  {
    // Phase 2 §10.2 scene 5: the 1–3 km band where a forest reads as a
    // textured surface — clumping, clearings, edge profile, species patchwork.
    name: "canopy-1200ft",
    description: "Forest canopy from 1,200 ft, 45° down, mid-morning",
    cameraMode: "cockpit",
    altitudeAglMeters: 366,
    altitudeMslMeters: null,
    offsetXMeters: -4_000,
    offsetZMeters: 3_000,
    pitchDownDegrees: 45,
    airspeedMetersPerSecond: 62,
    clock: { dayOfYear: 171, solarTimeHours: 9.5 },
    locate: "forest",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 20, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 157,
  },
  {
    // Phase 3 §10: the scene 3-9 is judged in. Short final over the threshold,
    // where the runway fills the lower frame — SDF-painted asphalt, the ragged
    // grass-invaded edge, the worn centreline and threshold bars, and the
    // rubber at the touchdown zone. It is also the one shot in the harness
    // where the earthworks embankment is on screen.
    //
    // APPENDED, never inserted: perf-capture.test.ts pins
    // `simulationTime = 500 + shotReports.length * 120`, so inserting mid-array
    // shifts the temporal phase of every later shot and fails their SSIM gates
    // with no renderer change.
    name: "runway-on-approach",
    description: "Short final, 200 ft AGL, runway threshold filling the frame",
    cameraMode: "chase",
    altitudeAglMeters: 61,
    altitudeMslMeters: null,
    // 900 m out on the approach centreline: the threshold bars and the near
    // touchdown zone are both inside the frame at a 62 deg horizontal FOV.
    offsetXMeters: -900,
    offsetZMeters: 0,
    pitchDownDegrees: 3,
    airspeedMetersPerSecond: 34,
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12.4 },
    drawCallCeiling: 169,
  },
  {
    // Fix-pack W5 (2026-08-25, APPENDED per the rule above): the first shot
    // that puts the camera NEAR the water. Every prior water view was ≥800 m
    // MSL, so the near-field capillary band, the sub-grid roughness tail and
    // the world-locked ripple parallax — the reported "plastic up close" —
    // had no gate at all.
    name: "water-25ft",
    description: "8 m over open water, low sun ahead — near-field ripple and glint",
    cameraMode: "chase",
    altitudeAglMeters: null,
    altitudeMslMeters: 8,
    offsetXMeters: -12_000,
    offsetZMeters: 8_000,
    pitchDownDegrees: 6,
    airspeedMetersPerSecond: 60,
    clock: { dayOfYear: 171, solarTimeHours: 18.5 },
    relativeSunBearingDegrees: 20,
    locate: "coast",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 138,
  },
  {
    // Vegetation overhaul (wave P): the terrain-viewer money shot — a
    // standing eye inside closed forest, where the skeletal trees' branch
    // structure, leaf-card canopies and the blade field all read at once.
    // This is the regime the whole overhaul exists for, and the shot that
    // gates it from now on.
    name: "grove-forest-2m",
    description: "Standing inside closed forest, ~2 m eye height, afternoon sun",
    cameraMode: "cockpit",
    altitudeAglMeters: 1.7,
    altitudeMslMeters: null,
    offsetXMeters: -4_000,
    offsetZMeters: 3_000,
    pitchDownDegrees: 2,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 15.5 },
    relativeSunBearingDegrees: 140,
    locate: "forest",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 99, minWallClockFps: 98, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 164,
  },
  {
    // Wave G's own gate: open grassland at eye height with the compute blade
    // field at full density, sun raking so blade shading and the terrain
    // colour harmonisation both show.
    name: "grove-meadow-2m",
    description: "Standing in open mown grass, eye height, raking sun",
    cameraMode: "cockpit",
    altitudeAglMeters: 1.7,
    altitudeMslMeters: null,
    offsetXMeters: -1_450,
    offsetZMeters: 900,
    pitchDownDegrees: 6,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 17.5 },
    relativeSunBearingDegrees: 60,
    locate: "grassland",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 17, hitchCount: 3, minFps: 101, minWallClockFps: 99, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 176,
  },
  {
    // Wave Q gate 1: the dusk terrain-glint + tree-band-handoff scene. A low
    // sun ahead rakes rolling forested ground with trees from the near band
    // out past the impostor switch — the frame that showed the "plastic
    // ground" Fresnel sheen and the binary bright/dark tree line at
    // ~1.0-1.1 km before the wave-Q fixes.
    name: "hills-dusk-glint",
    description: "Low sun ahead over rolling forested hills, glint and band handoff in frame",
    cameraMode: "chase",
    altitudeAglMeters: 250,
    altitudeMslMeters: null,
    offsetXMeters: -4_000,
    offsetZMeters: 3_000,
    pitchDownDegrees: 6,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 18.2 },
    relativeSunBearingDegrees: 205,
    locate: "forest",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 155,
  },
  {
    // Wave Q gate 2: the close-mountainside scene — the frame that showed
    // the Rock tile's reptile-scale lattice and the axis-locked strata
    // streaks. The locate predicate walks to a steep rise ahead of the
    // camera so the slope fills the frame at texture-resolving range.
    name: "mountain-close",
    description: "Steep rocky mountainside filling the frame at close range, low sun",
    cameraMode: "chase",
    altitudeAglMeters: 220,
    altitudeMslMeters: null,
    offsetXMeters: 6_000,
    offsetZMeters: -5_000,
    pitchDownDegrees: 2,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 17.8 },
    relativeSunBearingDegrees: 140,
    locate: "mountain",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 12.3 },
    drawCallCeiling: 181,
  },
  {
    // Wave R gate 1: the user's tree-line screenshot geometry — a few
    // hundred metres up over forest with a HIGH sun behind the camera, the
    // angle where the impostor band's view-locked response diverged worst
    // from the geometry bands.
    name: "forest-line-highsun",
    description: "High sun behind camera over forest, geometry-to-impostor handoff in frame",
    cameraMode: "chase",
    altitudeAglMeters: 320,
    altitudeMslMeters: null,
    offsetXMeters: -4_000,
    offsetZMeters: 3_000,
    pitchDownDegrees: 14,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 14.5 },
    relativeSunBearingDegrees: 225,
    locate: "forest",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12.2 },
    drawCallCeiling: 155,
  },
  {
    // Wave R gate 2: the very-close mountainside — the range where the rock
    // read "black, brown and white camo" before the wave-R material work.
    name: "cliff-60m",
    description: "Steep rock face at very close range",
    cameraMode: "chase",
    altitudeAglMeters: 120,
    altitudeMslMeters: null,
    offsetXMeters: 6_000,
    offsetZMeters: -5_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 15.5 },
    relativeSunBearingDegrees: 120,
    locate: "cliff",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.6 },
    drawCallCeiling: 173,
  },
  {
    // Wave R gate 3: water at standing height — the range where the ocean
    // read as plastic tubes before the wave-R water work.
    name: "water-3m",
    description: "Just above the water surface looking toward shore, low sun ahead",
    cameraMode: "cockpit",
    altitudeAglMeters: null,
    altitudeMslMeters: 4,
    offsetXMeters: -8_000,
    offsetZMeters: 0,
    pitchDownDegrees: 3,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 16.5 },
    // Sun AHEAD: with it astern the first framing showed only the matte
    // sky-reflection side of the sea — the glint path, sparkle and wave
    // shading this gate exists to judge were all behind the camera.
    relativeSunBearingDegrees: 25,
    locate: "coast",
    // Gate 0-a floors, pinned 2026-08-30 — see the PerfCaptureShotCeilings docblock.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.8 },
    drawCallCeiling: 137,
  },

  // -------------------------------------------------------------------------
  // The three `eroded-*` shots that lived here were REMOVED when Jason
  // terminated the eroded world for this phase (§8 resolved NO; see
  // PHASE_6_EXECUTION_PLAN.md D-24). They are not "skipped" because a shot with
  // no committed baseline is FATAL to a normal capture — `readBaselinePixels`
  // is called with `required = !REBASELINE` — so leaving them would break
  // `npm run perf:capture` for everyone, and gating them out would still spend
  // ~17,000 streaming frames per run on a shelved feature.
  //
  // Removal is safe HERE and only here, because temporal phase is keyed by
  // canonical INDEX (`PERF_CAPTURE_SHOTS.findIndex` by name, then
  // `simulationTime = 500 + index * 120`). These were the trailing entries, so
  // deleting them shifts no surviving shot's index and every analytic shot
  // keeps its exact phase and pixels. The append-only rule still stands for
  // insertion; this is a truncation of the tail.
  //
  // To restore them, re-append at the END with `worldEvolution: "eroded"` and
  // permissive ceilings — D-24 records the definitions.
  // -------------------------------------------------------------------------
]);

export interface CaptureQuaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

function multiplyQuaternions(a: CaptureQuaternion, b: CaptureQuaternion): CaptureQuaternion {
  // Hamilton product a⊗b: applies b first, then a.
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * Body orientation from yaw (about +y), pitch-down (about +z, matching the
 * Phase-1 convention: body axes +x forward, +y up) and bank (about +x).
 * Yaw 0 flies +x; positive yaw turns the nose toward −z.
 */
export function orientationFromYawPitchBank(
  yawDegrees: number,
  pitchDownDegrees: number,
  bankDegrees: number,
): CaptureQuaternion {
  const yawHalf = (yawDegrees * Math.PI) / 360;
  const pitchHalf = (-pitchDownDegrees * Math.PI) / 360;
  const bankHalf = (bankDegrees * Math.PI) / 360;
  const yaw: CaptureQuaternion = { x: 0, y: Math.sin(yawHalf), z: 0, w: Math.cos(yawHalf) };
  const pitch: CaptureQuaternion = { x: 0, y: 0, z: Math.sin(pitchHalf), w: Math.cos(pitchHalf) };
  const bank: CaptureQuaternion = { x: Math.sin(bankHalf), y: 0, z: 0, w: Math.cos(bankHalf) };
  return multiplyQuaternions(yaw, multiplyQuaternions(pitch, bank));
}

export type CaptureVector3 = readonly [number, number, number];

export interface CockpitTerrainCoverageInput {
  readonly aircraftPosition: CaptureVector3;
  readonly yawDegrees: number;
  readonly pitchDownDegrees: number;
  readonly bankDegrees?: number;
  readonly seaLevelMeters: number;
  readonly terrainHeightAt: (x: number, z: number) => number;
  /** Shipping cockpit camera uses a horizontal-fixed 56 degree FOV. */
  readonly horizontalFovDegrees?: number;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly columns?: number;
  readonly rows?: number;
  /** Samples along each ray before its sea-plane intersection. */
  readonly raySteps?: number;
}

export interface CockpitTerrainCoverage {
  readonly sampledRays: number;
  readonly terrainHits: number;
  readonly seaHits: number;
  readonly skyRays: number;
  readonly terrainHitFraction: number;
}

function rotateCaptureVector(
  vector: CaptureVector3,
  quaternion: CaptureQuaternion,
): CaptureVector3 {
  // v' = v + 2w(q.xyz × v) + 2(q.xyz × (q.xyz × v)).
  const crossX = quaternion.y * vector[2] - quaternion.z * vector[1];
  const crossY = quaternion.z * vector[0] - quaternion.x * vector[2];
  const crossZ = quaternion.x * vector[1] - quaternion.y * vector[0];
  const doubleCrossX = quaternion.y * crossZ - quaternion.z * crossY;
  const doubleCrossY = quaternion.z * crossX - quaternion.x * crossZ;
  const doubleCrossZ = quaternion.x * crossY - quaternion.y * crossX;
  return [
    vector[0] + 2 * (quaternion.w * crossX + doubleCrossX),
    vector[1] + 2 * (quaternion.w * crossY + doubleCrossY),
    vector[2] + 2 * (quaternion.w * crossZ + doubleCrossZ),
  ];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Pure semantic coverage oracle for a cockpit capture. It reconstructs a
 * regular grid of beauty-camera rays and marches each only as far as the sea
 * plane. A ray counts as terrain exactly when the analytic terrain rises into
 * it before water would. This prevents a terrain-named shot from silently
 * becoming a beautifully stable capture of empty ocean.
 */
export function cockpitTerrainCoverage(
  input: CockpitTerrainCoverageInput,
): CockpitTerrainCoverage {
  const viewportWidth = positiveInteger(input.viewportWidth ?? PERF_CAPTURE_WIDTH, "viewportWidth");
  const viewportHeight = positiveInteger(
    input.viewportHeight ?? PERF_CAPTURE_HEIGHT,
    "viewportHeight",
  );
  const columns = positiveInteger(input.columns ?? 41, "columns");
  const rows = positiveInteger(input.rows ?? 23, "rows");
  const raySteps = positiveInteger(input.raySteps ?? 256, "raySteps");
  const horizontalFovDegrees = input.horizontalFovDegrees ?? 56;
  const finiteScalars = [
    ...input.aircraftPosition,
    input.yawDegrees,
    input.pitchDownDegrees,
    input.bankDegrees ?? 0,
    input.seaLevelMeters,
    horizontalFovDegrees,
  ];
  if (!finiteScalars.every(Number.isFinite)) {
    throw new RangeError("Cockpit terrain coverage inputs must be finite");
  }
  if (horizontalFovDegrees <= 0 || horizontalFovDegrees >= 179) {
    throw new RangeError("horizontalFovDegrees must be in (0, 179)");
  }

  const orientation = orientationFromYawPitchBank(
    input.yawDegrees,
    input.pitchDownDegrees,
    input.bankDegrees ?? 0,
  );
  const forward = rotateCaptureVector([1, 0, 0], orientation);
  const up = rotateCaptureVector([0, 1, 0], orientation);
  const horizontal = rotateCaptureVector([0, 0, 1], orientation);
  // Keep this paired with FlightRenderer's cockpit rig: 1.15 m through the
  // nose and 1.12 m above the aircraft origin.
  const cameraX = input.aircraftPosition[0] + forward[0] * 1.15 + up[0] * 1.12;
  const cameraY = input.aircraftPosition[1] + forward[1] * 1.15 + up[1] * 1.12;
  const cameraZ = input.aircraftPosition[2] + forward[2] * 1.15 + up[2] * 1.12;
  const horizontalScale = Math.tan((horizontalFovDegrees * Math.PI) / 360);
  const verticalScale = horizontalScale * viewportHeight / viewportWidth;

  let terrainHits = 0;
  let seaHits = 0;
  let skyRays = 0;
  for (let row = 0; row < rows; row += 1) {
    const screenY = rows === 1 ? 0 : 1 - (2 * row) / (rows - 1);
    for (let column = 0; column < columns; column += 1) {
      const screenX = columns === 1 ? 0 : -1 + (2 * column) / (columns - 1);
      const unnormalizedX = forward[0]
        + horizontal[0] * screenX * horizontalScale
        + up[0] * screenY * verticalScale;
      const unnormalizedY = forward[1]
        + horizontal[1] * screenX * horizontalScale
        + up[1] * screenY * verticalScale;
      const unnormalizedZ = forward[2]
        + horizontal[2] * screenX * horizontalScale
        + up[2] * screenY * verticalScale;
      const inverseLength = 1 / Math.hypot(unnormalizedX, unnormalizedY, unnormalizedZ);
      const directionX = unnormalizedX * inverseLength;
      const directionY = unnormalizedY * inverseLength;
      const directionZ = unnormalizedZ * inverseLength;
      if (directionY >= 0) {
        skyRays += 1;
        continue;
      }
      const seaDistance = (input.seaLevelMeters - cameraY) / directionY;
      if (seaDistance <= 0) {
        skyRays += 1;
        continue;
      }

      let hitTerrain = false;
      for (let step = 0; step <= raySteps; step += 1) {
        const distance = seaDistance * step / raySteps;
        const x = cameraX + directionX * distance;
        const y = cameraY + directionY * distance;
        const z = cameraZ + directionZ * distance;
        const terrainHeight = input.terrainHeightAt(x, z);
        if (!Number.isFinite(terrainHeight)) {
          throw new RangeError("terrainHeightAt must return a finite height");
        }
        if (y <= terrainHeight) {
          hitTerrain = true;
          break;
        }
      }
      if (hitTerrain) terrainHits += 1;
      else seaHits += 1;
    }
  }

  const sampledRays = rows * columns;
  return {
    sampledRays,
    terrainHits,
    seaHits,
    skyRays,
    terrainHitFraction: terrainHits / sampledRays,
  };
}

/** The world-space horizontal heading vector for a yaw angle (yaw 0 → +x). */
export function headingVectorFromYaw(yawDegrees: number): { x: number; z: number } {
  const yaw = (yawDegrees * Math.PI) / 180;
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

/**
 * The yaw that places the sun at `relativeBearingDegrees` off the nose
 * (0 = flying into the sun, 180 = sun dead astern), given the sun's world
 * direction (+x east, +y up, +z north).
 */
export function yawForSunBearing(
  sunDirection: readonly [number, number, number],
  relativeBearingDegrees: number,
): number {
  const noseTowardSun = Math.atan2(-sunDirection[2], sunDirection[0]) * (180 / Math.PI);
  // Yaw is measured about +y with 0 at +x and positive toward −z, which is
  // exactly atan2(−z, x) of the desired heading vector.
  return noseTowardSun + relativeBearingDegrees;
}

export interface ShotPlacement {
  readonly offsetXMeters: number;
  readonly offsetZMeters: number;
}

/**
 * Deterministic spiral scan for a terrain feature near the airport, so
 * feature-anchored shots survive seed changes without hand-tuned offsets.
 * Scans a 500 m grid ring by ring and returns the first candidate whose
 * 5-point neighbourhood (centre ± 250 m) satisfies the predicate.
 */
export function locateShotOffset(
  accepts: (offsetX: number, offsetZ: number) => boolean,
  options?: { readonly stepMeters?: number; readonly maxRadiusMeters?: number },
): ShotPlacement | null {
  const step = options?.stepMeters ?? 500;
  const maxRadius = options?.maxRadiusMeters ?? 14_000;
  const maxRing = Math.floor(maxRadius / step);
  for (let ring = 1; ring <= maxRing; ring += 1) {
    for (let ix = -ring; ix <= ring; ix += 1) {
      for (let iz = -ring; iz <= ring; iz += 1) {
        if (Math.max(Math.abs(ix), Math.abs(iz)) !== ring) continue;
        const x = ix * step;
        const z = iz * step;
        if (accepts(x, z)) return { offsetXMeters: x, offsetZMeters: z };
      }
    }
  }
  return null;
}

/** Temporal-stability metrics over consecutive rAF frames of a motion shot (Z-3). */
export interface TemporalStability {
  /** Minimum SSIM between consecutive frames — flicker crashes this. */
  readonly minConsecutiveSsim: number;
  readonly meanConsecutiveSsim: number;
  /** Largest jump of whole-frame mean luminance between consecutive frames. */
  readonly maxMeanLuminanceDelta: number;
}

/**
 * Legacy sustained frame-rate diagnostic, robust to sparse stalls.
 *
 * This still backs the historical per-shot `minFps` rows, but it is not the
 * tier-1 delivery gate: `rawFrameIntervalMetrics` and
 * `tier1BalancedPerformanceFailures` retain and reject every stall. Within
 * the legacy Z-2 rows, `maxFrameMs`/`p999FrameMs`/
 * `hitchCount` own SPIKES, `minFps` owns the SUSTAINED rate. A wall-clock
 * mean re-counts a handful of one-off stalls (page streaming, GC, headless
 * compositor scheduling — measured ~1.5 s of stalls inside an 8 s window on
 * an otherwise-fast run) as a sustained-rate failure, which made the floor
 * bimodal on identical builds. Trimming the slowest 5% of intervals removes
 * sparse stalls while a genuinely slow build stays slow in every interval:
 * the 2A regression this gate must catch (every frame ~32 ms of GPU work)
 * trims to the same failing rate.
 */
export function sustainedFpsFromFrameIntervals(
  intervalsMs: readonly number[],
  trimFraction = 0.05,
): number {
  if (intervalsMs.length === 0) {
    throw new RangeError("Sustained fps needs at least one frame interval");
  }
  if (!Number.isFinite(trimFraction) || trimFraction < 0 || trimFraction >= 1) {
    throw new RangeError("trimFraction must be in [0, 1)");
  }
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  const kept = sorted.slice(
    0,
    Math.max(1, sorted.length - Math.ceil(sorted.length * trimFraction)),
  );
  const keptMs = kept.reduce((sum, value) => sum + value, 0);
  return kept.length / Math.max(1e-6, keptMs / 1_000);
}

export function temporalStability(
  frames: readonly Float32Array[],
  width: number,
  height: number,
): TemporalStability {
  if (frames.length < 2) {
    throw new RangeError("Temporal stability needs at least two frames");
  }
  let minSsim = 1;
  let ssimSum = 0;
  let maxDelta = 0;
  const mean = (values: Float32Array): number => {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[index]!;
    return sum / values.length;
  };
  let previousMean = mean(frames[0]!);
  for (let index = 1; index < frames.length; index += 1) {
    const ssim = meanSsim(frames[index - 1]!, frames[index]!, width, height);
    minSsim = Math.min(minSsim, ssim);
    ssimSum += ssim;
    const currentMean = mean(frames[index]!);
    maxDelta = Math.max(maxDelta, Math.abs(currentMean - previousMean));
    previousMean = currentMean;
  }
  return {
    minConsecutiveSsim: Math.round(minSsim * 10_000) / 10_000,
    meanConsecutiveSsim: Math.round((ssimSum / (frames.length - 1)) * 10_000) / 10_000,
    maxMeanLuminanceDelta: Math.round(maxDelta * 100_000) / 100_000,
  };
}

export interface TileStatistics {
  readonly tileEdge: number;
  readonly columns: number;
  readonly rows: number;
  /** Mean of per-tile mean luminance, 0..1. */
  readonly meanLuminance: number;
  /** Mean of per-tile luminance variance. */
  readonly meanVariance: number;
  /** Fraction of tiles whose local variance reaches the structure threshold. */
  readonly structuredTileFraction: number;
  /** Per-tile means, row-major, rounded for a stable JSON diff. */
  readonly tileMeans: readonly number[];
}

export interface PerfCaptureImageContentThresholds {
  readonly minMeanLuminance?: number;
  readonly minMeanTileVariance?: number;
  readonly minStructuredTileFraction?: number;
}

/**
 * Independent screenshot non-vacuity gate. Baseline similarity is not enough:
 * an old blank reference and a new blank render can have perfect SSIM.
 */
export function perfCaptureImageContentFailures(
  statistics: Pick<
    TileStatistics,
    "meanLuminance" | "meanVariance" | "structuredTileFraction"
  >,
  thresholds: PerfCaptureImageContentThresholds = {},
): string[] {
  const minMeanLuminance = thresholds.minMeanLuminance ?? 0.01;
  const minMeanTileVariance = thresholds.minMeanTileVariance
    ?? PERF_CAPTURE_MIN_MEAN_TILE_VARIANCE;
  const minStructuredTileFraction = thresholds.minStructuredTileFraction
    ?? PERF_CAPTURE_MIN_STRUCTURED_TILE_FRACTION;
  if (!Number.isFinite(minMeanLuminance) || minMeanLuminance < 0) {
    throw new RangeError("Minimum mean luminance must be a finite non-negative number");
  }
  if (!Number.isFinite(minMeanTileVariance) || minMeanTileVariance < 0) {
    throw new RangeError("Minimum mean tile variance must be a finite non-negative number");
  }
  if (
    !Number.isFinite(minStructuredTileFraction)
    || minStructuredTileFraction < 0
    || minStructuredTileFraction > 1
  ) {
    throw new RangeError("Minimum structured tile fraction must be in [0, 1]");
  }

  const failures: string[] = [];
  if (!Number.isFinite(statistics.meanLuminance)
    || statistics.meanLuminance <= minMeanLuminance) {
    failures.push(
      `mean luminance ${statistics.meanLuminance.toFixed(6)} is not above `
      + `${minMeanLuminance.toFixed(6)}`,
    );
  }
  if (!Number.isFinite(statistics.meanVariance)
    || statistics.meanVariance <= minMeanTileVariance) {
    failures.push(
      `mean per-tile luminance variance ${statistics.meanVariance.toFixed(6)} is not above `
      + `${minMeanTileVariance.toFixed(6)}`,
    );
  }
  if (
    !Number.isFinite(statistics.structuredTileFraction)
    || statistics.structuredTileFraction < minStructuredTileFraction
  ) {
    failures.push(
      `structured tile fraction ${statistics.structuredTileFraction.toFixed(4)} is below `
      + `${minStructuredTileFraction.toFixed(4)} (tile variance threshold `
      + `${PERF_CAPTURE_STRUCTURED_TILE_VARIANCE.toFixed(6)})`,
    );
  }
  return failures;
}

export interface PerfCaptureShotReport {
  readonly name: string;
  /** W-7: the world this shot captured ("analytic" unless the shot pins eroded). */
  readonly worldEvolution: "analytic" | "eroded";
  readonly description: string;
  readonly ssimAgainstBaseline: number | null;
  /** Mean SSIM over independent R/G/B planes; detects equal-luma hue shifts. */
  readonly rgbSsimAgainstBaseline: number | null;
  /** RGB SSIM over the lower 60%, where nearby terrain and foliage live. */
  readonly lowerFrameRgbSsimAgainstBaseline: number | null;
  /** Lowest RGB SSIM among full 64px tiles; prevents sky/global dilution. */
  readonly worstTileRgbSsimAgainstBaseline: number | null;
  readonly tiles: TileStatistics;
  /** Legacy 5%-trimmed sustained-rate diagnostic; never the strict fps gate. */
  readonly fps: number;
  /** Untrimmed frames / elapsed wall time over every measured interval. */
  readonly wallClockFps: number;
  /** B-0: present-to-present p95, before attribution into overlapping streams. */
  readonly frameIntervalMsP95: number;
  /** Frames missing a 60 fps delivery slot, using the explicit 16.67 ms budget. */
  readonly framesOver16_67Ms: number;
  /** User-visible hitch frames, using the explicit 2 × tier target (27.4 ms). */
  readonly framesOver27_4Ms: number;
  readonly cpuFrameMsP95: number;
  readonly gpuFrameMsP95: number | null;
  /** Timestamp-query provenance for this shot's measurement epoch. */
  readonly gpuTiming: {
    readonly enabled: boolean;
    readonly epoch: number;
    /** Fresh whole-frame timestamp results resolved during the measured window. */
    readonly sampleCount: number;
    readonly latestSampleAgeFrames: number | null;
  };
  /** B-0: compositor/present residual; null without frame-correlated GPU timing. */
  readonly presentWaitMsP95: number | null;
  /** Raw worst interval over the measurement phase; no stalls are trimmed. */
  readonly maxFrameMs: number;
  readonly p999FrameMs: number | null;
  readonly hitchCount: number;
  readonly drawCalls: number;
  /**
   * Vegetation batches surviving frustum culling. This measures submission
   * overhead only; alpha-tested fragment coverage, overdraw and geometry can
   * dominate even after batches collapse, so it never closes the vegetation
   * frame row by itself.
   */
  readonly vegetationBatches: number;
  readonly triangles: number;
  readonly residentTerrainPages: number;
  readonly pendingTerrainPages: number;
  /** Detail generation/presentation backlog remaining when the shot was read. */
  readonly pendingDetailWork: number;
  /**
   * Frames the pre-capture streaming loop needed before the world settled, and
   * the ceiling it was allowed. Recorded so the margin can be ASSERTED rather
   * than discovered: a shot creeping toward its budget is a shot about to be
   * screenshotted half-built.
   */
  readonly streamingFramesUsed: number;
  readonly streamingFrameBudget: number;
  readonly renderPixels: number;
  readonly renderScale: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly estimatedGpuMemoryMiB: number;
  /** Z-4: the renderer's actual-allocation floor reading. */
  readonly inventoriedGpuMemoryMiB: number;
  /**
   * `4.5-C3`: per-pass GPU milliseconds, as UNCORRELATED aggregates from
   * Babylon's own counters. They say what each pass costs the GPU; they do not
   * attribute any part of `frameIntervalMsP95`. Recorded so the gap between a
   * ~15 ms GPU p95 and a 40-50 ms interval is at least inspectable — `B-0`'s
   * correlation rule still forbids inferring a present wait from them.
   */
  readonly gpuPassMs?: {
    readonly mainPass: number | null;
    readonly shadows: number | null;
    readonly terrainCompute: number | null;
    readonly total: number | null;
  };
  /** Z-3: present only for motion shots. */
  readonly temporal?: TemporalStability;
}

export interface PerfCaptureReport {
  readonly seed: string;
  readonly width: number;
  readonly height: number;
  readonly warmupFrames: number;
  readonly measureFrames: number;
  /** Mean milliseconds to generate one 512 m tile at resolution 65. */
  readonly pageGenerationMs: number;
  /** Provenance needed to distinguish DPR/cap and adapter-specific results. */
  readonly captureEnvironment: {
    readonly adapter: string;
    readonly devicePixelRatio: number;
    readonly userAgent: string;
    readonly quality: string;
    readonly renderingMode: string;
    /** `6-11.1`: the tier these numbers describe, and whether this is a sweep run. */
    readonly tier: number;
    readonly sweep: boolean;
    readonly pinnedRenderScale: number;
    /** Whether Babylon's continuous timestamp-query observers were enabled. */
    readonly gpuTimingEnabled: boolean;
    /**
     * Whether the frame-delivery rows in this report were CONTRACT or merely
     * DIAGNOSTIC. False on any host that is not the pinned reference adapter
     * (`VITE_PERF_UNPINNED_HOST=1`), where fps/p95/hitch figures describe the
     * runner. The visual, renderer-error and settling gates hold either way.
     */
    readonly deliveryGatesEnforced: boolean;
  };
  readonly shots: readonly PerfCaptureShotReport[];
}

export interface RawFrameIntervalMetrics {
  readonly wallClockFps: number;
  readonly frameIntervalMsP95: number;
  readonly framesOver16_67Ms: number;
  readonly framesOver27_4Ms: number;
  readonly maxFrameMs: number;
}

export interface Tier1BalancedPerfSample {
  readonly wallClockFps: number;
  readonly frameIntervalMsP95: number;
  readonly framesOver27_4Ms: number;
  readonly maxFrameMs: number;
}

/**
 * Raw presentation metrics. Nothing is trimmed: a freeze is part of the
 * player's elapsed time and must remain visible to the strict playability gate.
 */
export function rawFrameIntervalMetrics(
  intervalsMs: readonly number[],
): RawFrameIntervalMetrics {
  if (intervalsMs.length === 0) {
    throw new RangeError("Frame interval metrics need at least one interval");
  }
  for (const interval of intervalsMs) {
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new RangeError("Frame intervals must be finite positive numbers");
    }
  }
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  const percentile = (value: number): number => {
    const index = Math.max(0, Math.ceil(sorted.length * value) - 1);
    return sorted[Math.min(sorted.length - 1, index)]!;
  };
  const elapsedMs = intervalsMs.reduce((sum, interval) => sum + interval, 0);
  return {
    wallClockFps: intervalsMs.length / (elapsedMs / 1_000),
    frameIntervalMsP95: percentile(0.95),
    framesOver16_67Ms: intervalsMs.filter(
      (interval) => interval > PERF_CAPTURE_FRAME_BUDGET_MS,
    ).length,
    framesOver27_4Ms: intervalsMs.filter(
      (interval) => interval > PERF_CAPTURE_HITCH_BUDGET_MS,
    ).length,
    maxFrameMs: sorted[sorted.length - 1]!,
  };
}

/** Human-readable strict tier-1 failures, shared by the driver and unit tests. */
export function tier1BalancedPerformanceFailures(
  sample: Tier1BalancedPerfSample,
): string[] {
  const failures: string[] = [];
  if (!Number.isFinite(sample.wallClockFps)
    || sample.wallClockFps < PERF_CAPTURE_MIN_WALL_CLOCK_FPS) {
    failures.push(
      `wall-clock fps ${sample.wallClockFps.toFixed(2)} is below ${PERF_CAPTURE_MIN_WALL_CLOCK_FPS}`,
    );
  }
  if (!Number.isFinite(sample.frameIntervalMsP95)
    || sample.frameIntervalMsP95 > PERF_CAPTURE_FRAME_BUDGET_MS) {
    failures.push(
      `frame-interval p95 ${sample.frameIntervalMsP95.toFixed(2)} ms exceeds `
      + `${PERF_CAPTURE_FRAME_BUDGET_MS} ms`,
    );
  }
  if (!Number.isInteger(sample.framesOver27_4Ms)
    || sample.framesOver27_4Ms < 0
    || sample.framesOver27_4Ms > PERF_CAPTURE_MAX_HITCHES) {
    failures.push(
      `${sample.framesOver27_4Ms} frames exceeded ${PERF_CAPTURE_HITCH_BUDGET_MS} ms; `
      + `maximum is ${PERF_CAPTURE_MAX_HITCHES}`,
    );
  }
  if (!Number.isFinite(sample.maxFrameMs) || sample.maxFrameMs > PERF_CAPTURE_MAX_FRAME_MS) {
    failures.push(
      `maximum frame ${sample.maxFrameMs.toFixed(2)} ms exceeds ${PERF_CAPTURE_MAX_FRAME_MS} ms`,
    );
  }
  return failures;
}

/**
 * `6-11.1` — the same contract, evaluated against an arbitrary tier's numbers.
 *
 * Deliberately a SEPARATE function rather than a rewrite of
 * `tier1BalancedPerformanceFailures` with parameters. That function is the
 * standing gate for the shipping tier and its constants are quoted in
 * `docs/PERFORMANCE.md`; making it configurable would mean the shipping
 * contract could be weakened by passing an argument, which is exactly the
 * property it should not have. The tier-1 path keeps calling the original —
 * and a test asserts the two agree on tier 1's contract, so this cannot drift
 * into a second, quietly different definition of "delivered".
 */
export function deliveryFailuresAgainst(
  contract: PerfCaptureDeliveryContract,
  sample: Tier1BalancedPerfSample,
): string[] {
  const failures: string[] = [];
  if (!Number.isFinite(sample.wallClockFps) || sample.wallClockFps < contract.minWallClockFps) {
    failures.push(
      `wall-clock fps ${sample.wallClockFps.toFixed(2)} is below ${contract.minWallClockFps}`,
    );
  }
  if (!Number.isFinite(sample.frameIntervalMsP95)
    || sample.frameIntervalMsP95 > contract.frameBudgetMs) {
    failures.push(
      `frame-interval p95 ${sample.frameIntervalMsP95.toFixed(2)} ms exceeds `
      + `${contract.frameBudgetMs} ms`,
    );
  }
  if (!Number.isInteger(sample.framesOver27_4Ms)
    || sample.framesOver27_4Ms < 0
    || sample.framesOver27_4Ms > contract.maxHitches) {
    failures.push(
      `${sample.framesOver27_4Ms} frames exceeded ${contract.hitchBudgetMs} ms; `
      + `maximum is ${contract.maxHitches}`,
    );
  }
  if (!Number.isFinite(sample.maxFrameMs) || sample.maxFrameMs > contract.maxFrameMs) {
    failures.push(
      `maximum frame ${sample.maxFrameMs.toFixed(2)} ms exceeds ${contract.maxFrameMs} ms`,
    );
  }
  return failures;
}

/** Rec. 709 luma from an RGBA byte buffer. */
export function luminanceFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  if (rgba.length < width * height * 4) {
    throw new RangeError("RGBA buffer is smaller than width × height × 4");
  }
  const out = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    out[index] =
      (0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!) / 255;
  }
  return out;
}

export function tileStatistics(
  luminance: Float32Array,
  width: number,
  height: number,
  tileEdge = PERF_CAPTURE_TILE,
): TileStatistics {
  if (luminance.length !== width * height) {
    throw new RangeError("Luminance buffer does not match width × height");
  }
  const columns = Math.floor(width / tileEdge);
  const rows = Math.floor(height / tileEdge);
  const tileMeans: number[] = [];
  let varianceSum = 0;
  let structuredTiles = 0;
  for (let tileRow = 0; tileRow < rows; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < columns; tileColumn += 1) {
      let sum = 0;
      let sumSquares = 0;
      for (let y = 0; y < tileEdge; y += 1) {
        const rowOffset = (tileRow * tileEdge + y) * width + tileColumn * tileEdge;
        for (let x = 0; x < tileEdge; x += 1) {
          const value = luminance[rowOffset + x]!;
          sum += value;
          sumSquares += value * value;
        }
      }
      const count = tileEdge * tileEdge;
      const mean = sum / count;
      const variance = Math.max(0, sumSquares / count - mean * mean);
      tileMeans.push(Math.round(mean * 10_000) / 10_000);
      varianceSum += variance;
      if (variance >= PERF_CAPTURE_STRUCTURED_TILE_VARIANCE) structuredTiles += 1;
    }
  }
  const tileCount = Math.max(1, tileMeans.length);
  return {
    tileEdge,
    columns,
    rows,
    meanLuminance:
      Math.round((tileMeans.reduce((a, b) => a + b, 0) / tileCount) * 10_000) / 10_000,
    meanVariance: Math.round((varianceSum / tileCount) * 1_000_000) / 1_000_000,
    structuredTileFraction: Math.round((structuredTiles / tileCount) * 10_000) / 10_000,
    tileMeans,
  };
}

/**
 * Mean SSIM over non-overlapping 8×8 windows of two equal-size luminance
 * images (constants for L = 1). Small and dependency-free; plenty to catch a
 * real regression while tolerating temporal-noise-level differences.
 */
export function meanSsim(
  first: Float32Array,
  second: Float32Array,
  width: number,
  height: number,
  window = 8,
): number {
  if (first.length !== second.length || first.length !== width * height) {
    throw new RangeError("SSIM inputs must be equal-size luminance buffers");
  }
  const c1 = 0.01 * 0.01;
  const c2 = 0.03 * 0.03;
  let total = 0;
  let windows = 0;
  for (let top = 0; top + window <= height; top += window) {
    for (let left = 0; left + window <= width; left += window) {
      let sumA = 0;
      let sumB = 0;
      let sumAa = 0;
      let sumBb = 0;
      let sumAb = 0;
      for (let y = 0; y < window; y += 1) {
        const row = (top + y) * width + left;
        for (let x = 0; x < window; x += 1) {
          const a = first[row + x]!;
          const b = second[row + x]!;
          sumA += a;
          sumB += b;
          sumAa += a * a;
          sumBb += b * b;
          sumAb += a * b;
        }
      }
      const n = window * window;
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varA = Math.max(0, sumAa / n - meanA * meanA);
      const varB = Math.max(0, sumBb / n - meanB * meanB);
      const covariance = sumAb / n - meanA * meanB;
      total +=
        ((2 * meanA * meanB + c1) * (2 * covariance + c2))
        / ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
      windows += 1;
    }
  }
  return windows > 0 ? total / windows : 1;
}

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function normalizedPixelRegion(
  imageWidth: number,
  imageHeight: number,
  region?: PixelRegion,
): PixelRegion {
  const value = region ?? { x: 0, y: 0, width: imageWidth, height: imageHeight };
  if (
    !Number.isSafeInteger(value.x)
    || !Number.isSafeInteger(value.y)
    || !Number.isSafeInteger(value.width)
    || !Number.isSafeInteger(value.height)
    || value.x < 0
    || value.y < 0
    || value.width <= 0
    || value.height <= 0
    || value.x + value.width > imageWidth
    || value.y + value.height > imageHeight
  ) {
    throw new RangeError("RGB SSIM region must be a positive integer rectangle inside the image");
  }
  return value;
}

function channelSsimInRegion(
  first: Uint8ClampedArray | Uint8Array,
  second: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  channel: 0 | 1 | 2,
  region: PixelRegion,
  window: number,
): number {
  if (first.length !== second.length || first.length !== width * height * 4) {
    throw new RangeError("RGB SSIM inputs must be equal-size RGBA buffers");
  }
  if (!Number.isSafeInteger(window) || window <= 0) {
    throw new RangeError("RGB SSIM window must be a positive integer");
  }
  const c1 = 0.01 * 0.01;
  const c2 = 0.03 * 0.03;
  let total = 0;
  let windows = 0;
  for (let top = region.y; top + window <= region.y + region.height; top += window) {
    for (let left = region.x; left + window <= region.x + region.width; left += window) {
      let sumA = 0;
      let sumB = 0;
      let sumAa = 0;
      let sumBb = 0;
      let sumAb = 0;
      for (let y = 0; y < window; y += 1) {
        for (let x = 0; x < window; x += 1) {
          const offset = ((top + y) * width + left + x) * 4 + channel;
          const a = first[offset]! / 255;
          const b = second[offset]! / 255;
          sumA += a;
          sumB += b;
          sumAa += a * a;
          sumBb += b * b;
          sumAb += a * b;
        }
      }
      const count = window * window;
      const meanA = sumA / count;
      const meanB = sumB / count;
      const varianceA = Math.max(0, sumAa / count - meanA * meanA);
      const varianceB = Math.max(0, sumBb / count - meanB * meanB);
      const covariance = sumAb / count - meanA * meanB;
      total += (
        (2 * meanA * meanB + c1) * (2 * covariance + c2)
      ) / (
        (meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2)
      );
      windows += 1;
    }
  }
  return windows > 0 ? total / windows : 1;
}

/**
 * Per-channel RGB SSIM. Unlike Rec.709-luma SSIM, an equal-luminance hue
 * replacement cannot pass this comparison unnoticed.
 */
export function meanRgbSsim(
  first: Uint8ClampedArray | Uint8Array,
  second: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  region?: PixelRegion,
  window = 8,
): number {
  const resolvedRegion = normalizedPixelRegion(width, height, region);
  return (
    channelSsimInRegion(first, second, width, height, 0, resolvedRegion, window)
    + channelSsimInRegion(first, second, width, height, 1, resolvedRegion, window)
    + channelSsimInRegion(first, second, width, height, 2, resolvedRegion, window)
  ) / 3;
}

/** Lowest local RGB SSIM, so a broken ground/tree patch cannot hide under a good sky. */
export function worstTileRgbSsim(
  first: Uint8ClampedArray | Uint8Array,
  second: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  tileEdge = PERF_CAPTURE_COLOR_TILE,
): number {
  if (!Number.isSafeInteger(tileEdge) || tileEdge < 8 || tileEdge % 8 !== 0) {
    throw new RangeError("RGB SSIM tile edge must be a positive multiple of eight");
  }
  let worst = 1;
  let tiles = 0;
  for (let top = 0; top + tileEdge <= height; top += tileEdge) {
    for (let left = 0; left + tileEdge <= width; left += tileEdge) {
      worst = Math.min(worst, meanRgbSsim(first, second, width, height, {
        x: left,
        y: top,
        width: tileEdge,
        height: tileEdge,
      }));
      tiles += 1;
    }
  }
  return tiles > 0 ? worst : meanRgbSsim(first, second, width, height);
}
