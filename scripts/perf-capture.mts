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
/**
 * Luminance at or above which a pixel counts as near-clipped.
 *
 * 245 of 255 — high enough that ordinary sunlit highlights do not trip it (a
 * clean daylight baseline reads 56 over the whole frame) and low enough to
 * catch a light source blowing out, which reads in the thousands.
 */
export const PERF_CAPTURE_NEAR_CLIPPED_LUMINANCE = 245 / 255;

export const PERF_CAPTURE_SSIM_THRESHOLD = 0.985;
/** Per-channel SSIM catches hue/chroma regressions that luma SSIM cannot see. */
export const PERF_CAPTURE_RGB_SSIM_THRESHOLD = 0.95;
/** The lower frame isolates nearby terrain/foliage from a stable sky majority. */
export const PERF_CAPTURE_LOWER_FRAME_RGB_SSIM_THRESHOLD = 0.94;
/** A local defect cannot hide inside a good whole-frame average. */
export const PERF_CAPTURE_WORST_TILE_RGB_SSIM_THRESHOLD = 0.72;
/** rAF-paced frames measured per shot (Z-1/Z-2): fps and hitch metrics come only from these. */
export const PERF_CAPTURE_MEASURE_FRAMES = 240;

/**
 * Transit speed for `VITE_PERF_TRANSLATE`'s approach, when a shot does not
 * state its own.
 *
 * **Deliberately NOT `airspeedMetersPerSecond`, and the distinction is the
 * whole point.** Airspeed describes the aircraft's state IN the photograph — a
 * shot parked 2 m from a grove is parked, and that is true and intended. The
 * approach describes how the observer GOT there, which is a property of the
 * journey. Nothing about "this photograph shows a stationary aircraft" implies
 * "this observer materialised from nothing", and conflating the two left
 * translation inert on **15 of 38 shots including all four near-tree
 * vantages** — the exact vantages the instrument was commissioned for.
 *
 * **80 m/s is chosen against the LATTICE, not against plausibility.**
 * `resident.distance` refreshes only when the observer crosses a 256 m
 * quantum (`WorldDetailRuntime.ts`, `cellSizeMeters * 0.5`), so an approach
 * shorter than one period may cross NO boundary at all depending on where the
 * grid falls:
 *
 *     240 warm-up frames at  62 m/s = 248 m = 0.97 periods   may cross none
 *     240 warm-up frames at  80 m/s = 320 m = 1.25 periods   always crosses
 *
 * **A null from an approach under one period is not evidence of no effect — it
 * is evidence of insufficient travel**, and it would read as "the streaming
 * window is clean". At 1.25 periods a crossing is guaranteed whatever the
 * phase, with margin either side.
 *
 * **It is a diagnostic transit speed, not a claim about how the vantage would
 * be reached in flight.** The mode is opt-in, refuses `VITE_PERF_REBASELINE`,
 * and the frame it finally measures is the pinned pose either way — what the
 * approach changes is the state the streaming system is in when that frame is
 * taken, which is the only thing it is for.
 */
export const DEFAULT_APPROACH_SPEED_METERS_PER_SECOND = 80;
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
 *
 * **The two tail fields are optional; the other four are not.** A shot may be
 * first-pinned on its mean-like floors while its p95/p999 ceilings wait for a
 * run set whose TAIL is quiet — the "quiet host" verdict that clears a set is
 * computed from `wallClockFps`, a mean, and does not certify an order
 * statistic. `scripts/deliveryFloors.mts` `TAIL_DEFERRED_SHOTS` names every
 * shot in that state and records the measurement behind it.
 *
 * **An absent tail field is an unasserted gate, never a passing one.** The
 * driver skips the assertion; it does not substitute a default. Anything that
 * reports coverage must count these as missing, and
 * `tests/delivery-floors.test.ts` fails if a shot that HAD a tail ceiling
 * loses it.
 */
export interface PerfCaptureShotCeilings {
  readonly maxFrameMs: number;
  /** Tail order statistic — absent while deferred. See `TAIL_DEFERRED_SHOTS`. */
  readonly p999FrameMs?: number;
  readonly hitchCount: number;
  readonly minFps: number;
  /** Gate 0-a: raw (untrimmed) wall-clock fps floor. */
  readonly minWallClockFps: number;
  /**
   * Gate 0-a: raw frame-interval p95 ceiling, milliseconds.
   * Tail order statistic — absent while deferred. See `TAIL_DEFERRED_SHOTS`.
   */
  readonly maxFrameIntervalMsP95?: number;
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
 *
 * **RESOLVED 2026-08-31 (`6-11.4`, recorded by `6-12`) — and it resolved the
 * OPPOSITE way to the last sentence above.** The estimate model was not
 * re-derived and this ceiling was not ratcheted down. Measured across all 24
 * shots of the promoted baseline: `estimatedGpuMemoryMiB` reads **367.5–380.7
 * MiB** while `inventoriedGpuMemoryMiB` reads **483.9–492.3 MiB** — a shortfall
 * of 111–119 MiB at a ratio of **1.293–1.324**.
 *
 * **The tightness of that ratio across the 24 shots of the 2026-08-31 baseline
 * (a historical count — the list has grown since) with very different content is
 * the finding, not the size of the gap.** Drift accumulated per-item would
 * scatter; a stable multiplier means the model omits a whole CATEGORY of
 * allocation. So the verdict is neither "re-derive the rows" nor "move the
 * ceiling" but: **the estimate is not a usable proxy, and the ceiling must be
 * judged on the inventory** — which is what this constant does, and why it and
 * not `MEMORY_CEILING_MIB` is the real gate.
 *
 * For anyone reading a memory number here:
 * - **Never quote `estimatedGpuMemoryMiB` as headroom.** It understates by ~30%.
 * - `MEMORY_CEILING_MIB[1]` is **480**, and the tier-1 inventory (492.3) is
 *   already ABOVE it. Nothing is broken — that row gates the estimate only —
 *   but the two ceilings measure different quantities and must never be
 *   compared or quoted together.
 * - ~~Real tier-1 headroom is **2.7 MiB (0.5%)**, at `reference-viewport`.~~
 *   **STRUCK 2026-09-02.** That figure was measured through an inventory
 *   that over-counted single-channel float textures fourfold; the fix at
 *   `4543b7e` removed ~236 MiB of phantom at tier 1. **The same shot now
 *   reads 256.7 MiB against the same 495 ceiling — 238.3 MiB of headroom,
 *   not 2.7.** Struck rather than deleted: the 0.5% was quoted onward and
 *   a reader who met it elsewhere needs to find it withdrawn here, not
 *   absent. See `PERF_CAPTURE_CEILING_PROVENANCE` below for the
 *   measurement that supersedes it.
 *
 * The superseded text is kept above rather than rewritten, because the
 * prediction it made is itself the lesson: a forward-looking promise in a
 * comment is a claim like any other, and nothing ever re-checks it.
 */
export const PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB = 495;

/**
 * WHERE THE CEILING'S NUMBER CAME FROM, AS DATA RATHER THAN AS PROSE.
 *
 * **The failure this exists to prevent was never that 495 was wrong. It was
 * that nothing re-derived it when the instrument underneath it changed
 * definition.** `inventoryGpuMemoryMiB` read a texture's TYPE and never its
 * FORMAT, counting single-channel float atlases at four times their size; the
 * fix at `4543b7e` removed ~236 MiB of phantom at tier 1. The ceiling was
 * derived twice from the inflated readings — `489.0 + 6.0`, then re-justified
 * as `492.3 + 2.7` — and **neither derivation records WHY that slack, so
 * neither could survive its own input changing.**
 *
 * Recording tier and shot count as DATA is what makes a frame error impossible
 * rather than merely embarrassing: the figures above and below are only
 * comparable to a run with the same tier and the same shot set. **That error
 * has already been made by hand — a tier-2 figure lifted from a docblock and
 * differenced against a tier-1 measurement, giving 163 MiB where the answer was
 * 238.**
 */
export const PERF_CAPTURE_CEILING_PROVENANCE = Object.freeze({
  /** Maximum `inventoriedGpuMemoryMiB` across the whole set, and its shot. */
  measuredMaxMiB: 256.7,
  measuredMaxShot: "reference-viewport",
  measuredMinMiB: 248.3,
  /** The run's own `captureEnvironment`. A ceiling is only valid for these. */
  shotCount: 36,
  /**
   * Shots added SINCE that run, whose inventoried memory has never been
   * measured — declared rather than silently folded into `shotCount`.
   *
   * **This is the second of the two honest exits when the set grows.** The
   * first is to re-measure the maximum and update the figures above. This one
   * says "a shot exists that this provenance does not describe", which is a
   * true statement and a cheap one; **bumping `shotCount` to make the guard
   * green would be a false statement and equally cheap, which is why the guard
   * offers both explicitly rather than leaving the lazy exit as the obvious
   * one.**
   *
   * A name here is a promise that somebody knows the shot is unmeasured — not
   * that it is cheap. **"It is probably a light shot" is the assumption the
   * entire 495 episode was built on.**
   */
  unmeasuredShots: Object.freeze([
    // Added after the 2026-09-02 inventory run, so its inventoried memory has
    // never been measured. 1.5 km out on the extended centreline at 60 m AGL --
    // the only vantage that frames the approach lighting system at all.
    "approach-lights-outboard",
    // Added by the 4121940 merge, after the same inventory run. Cockpit height
    // beside a forested lake 30 km out -- and it is named here rather than
    // folded into shotCount precisely BECAUSE it is not obviously cheap: dense
    // vegetation at eye level against a full water plate is the shape of a new
    // maximum, not of a light shot. Nobody has measured it.
    "lake-island-piercing",
  ] as readonly string[]),
  tier: 1,
  quality: "medium",
  renderingMode: "balanced",
  /** The commit whose inventory definition these readings were taken under. */
  inventoryDefinedAt: "4543b7e",
  measuredOn: "2026-09-02",
  /** `tests/perf/artifacts/` is gitignored, so this path is machine-local. */
  reportPath:
    "tests/perf/artifacts/rebaseline-candidates/2026-09-02T03-05-29.027Z/report.json",
});

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
  /**
   * Horizontal offset from the airport centre, metres — **BUT ONLY WHEN
   * `locate` IS ABSENT.**
   *
   * **This field means two different things and its name and type say which
   * one is which for neither.** On a shot with no `locate`, it is a POSITION.
   * On a shot with `locate`, it is a SEARCH SEED — where a terrain search
   * begins — and the camera ends up over whatever feature the search finds,
   * which can be kilometres away. **16 of the 35 shots carry a `locate`.**
   *
   * **So any table sorted or differenced by this field silently mixes two
   * populations.** That is not hypothetical: `7-9`'s draw-call analysis
   * concluded a bimodal +24/+12 split "does not track distance" on the grounds
   * that `mountain-close` and `cliff-60m` share offsets and land in different
   * groups. **They share a seed, not a position, and the two shots are sited on
   * different terrain features.** The conclusion was retracted; re-run over the
   * 19 shots without a `locate` alone, distance separated the groups cleanly.
   *
   * **Before computing any distance from this field, filter to `locate == null`
   * or resolve the search.** A mixed set gives an answer that looks clean.
   *
   * **The `==` there is LOOSE ON PURPOSE and must stay loose.** No shot
   * carries `locate: null`; unlocated shots simply omit the key, so
   * `locate == null` catches them via `undefined == null` and selects 19
   * of 35. Tightening it to `===` selects ZERO and returns a clean-looking
   * empty answer rather than an error.
   */
  readonly offsetXMeters: number;
  readonly offsetZMeters: number;
  /** Pitch-down angle of the aircraft body, degrees. */
  readonly pitchDownDegrees: number;
  readonly airspeedMetersPerSecond: number;
  /**
   * Transit speed for `VITE_PERF_TRANSLATE`'s approach to this pose. Optional;
   * `DEFAULT_APPROACH_SPEED_METERS_PER_SECOND` applies when absent. Set it
   * only where a shot's approach must differ from the default — NOT to mirror
   * `airspeedMetersPerSecond`, which describes the pose rather than the
   * journey and is zero on 15 shots that still need approaching.
   */
  readonly approachSpeedMetersPerSecond?: number;
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
  /**
   * Z-3: locate the shot over a terrain feature instead of a fixed offset.
   *
   * `canopy-backlit` (`L-4`, 2026-08-31) differs from `forest` in two ways that
   * matter: it gates on the VEGETATION field rather than the biome id, and it
   * scans along the shot's own sun-derived heading rather than +x. A biome-only
   * predicate accepts forest with no stems in it — the failure that shipped
   * `horizon-shadow-far-annulus` with 0 stems/m² at every sampled range, a shot
   * that could not fail.
   */
  readonly locate?:
    | "fixed"
    | "forest"
    | "grassland"
    | "mountain"
    | "cliff"
    | "coast"
    | "canopy-backlit";
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
  /**
   * `7-5`: the airfield-is-lit content gate — bright ground-level pixels must
   * exist in the band where the runway projects, or the shot fails.
   *
   * DELIBERATELY BASELINE-INDEPENDENT AND CONSTANT-INDEPENDENT. The airfield
   * went dark through three wrong values of one scale factor (3.6e-2, 36.1,
   * 5.7e5 — see `AIRFIELD_LAMP_SCENE_SCALE`), and a promoted baseline became
   * the candidate once already (`090bf2f`), which would have read "no change"
   * over a dark airfield. So this gate reads ONLY the captured frame: no
   * baseline, no lighting constant, no import from the lamp code. It cares
   * that bright pixels exist where the runway is, whatever produced them.
   *
   * The band is in FRACTIONS of the viewport (sweep viewports rescale), and
   * the scan size is asserted non-zero so a drifted crop fails loudly instead
   * of passing over nothing.
   */
  /**
   * Whole-frame ceiling on near-clipped pixels. Set on DAY shots: it is the
   * gate that would have caught the airfield lamps burning at their night
   * calibration at solar noon — 10,019 clipped pixels against a baseline 56.
   */
  /**
   * Seconds added to this shot's pinned `simulationTime`.
   *
   * **Exists because every shot samples an identical lamp phase.** The harness
   * pins `simulationTime = 500 + index * 120`, and both flashing rates divide
   * 120 s into whole periods — 45 fpm is 90 periods and 60 fpm is 120 — so the
   * beacon is lit and the strobe dark in *every* frame the set contains. No
   * capture can see the complementary state, and a lamp wired to the wrong
   * timer would look identical in all of them.
   *
   * An offset moves one shot off that lattice. It is deliberately a per-shot
   * field rather than a global change: moving the lattice itself would rewrite
   * the phase of every shot in the set and churn every baseline.
   */
  readonly simulationTimeOffsetSeconds?: number;
  readonly maxNearClippedPixels?: number;
  readonly litRegion?: {
    /** Scan band, as fractions of viewport height (0 = top). */
    readonly yMinFraction: number;
    readonly yMaxFraction: number;
    /** Rec. 709 luminance floor (0..1) that counts a pixel as lamp-bright. */
    readonly luminanceFloor: number;
    /** Minimum count of qualifying pixels for the shot to pass. */
    readonly minBrightPixels: number;
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 261,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.6 },
    drawCallCeiling: 222,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.6 },
    drawCallCeiling: 223,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.8 },
    drawCallCeiling: 262,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.4 },
    drawCallCeiling: 214,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 261,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 263,
  },
  {
    name: "night-moonlit",
    description: "Approach pose at 23:45 solar time under a full moon 17.6 deg up",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    /**
     * **Day 179, not 171, and not 356.** The shipped `night` shot sits at day
     * 171, where the moon is 0.4985 lit and **0.62 deg above the horizon** --
     * essentially set. Its ground illuminance is 2.573e-4 lx against a
     * full-moon 0.267 lx: **1038x dimmer**, i.e. effectively moonless. Gate 7A
     * shipped the moon, scotopic vision and the star field validated against a
     * set with no moonlight in it.
     *
     * **The dimming is ALTITUDE, not phase, and the distinction is
     * actionable.** Decomposed: phase contributes ~10.8x, altitude ~88x. A fix
     * that chooses a fuller phase without checking altitude gains ~11x and
     * still ships a moonless frame -- a plausible fix that leaves the defect
     * standing. **The moon is above the horizon on only 188 of 365 days at
     * this solar time**, so choosing a night-shot day without an altitude
     * check is a coin flip, which is how the original shipped.
     *
     * Day 179: lit **1.000**, altitude **17.6 deg**, 7.094e-2 lx --
     * **276x brighter than the `night` shot** and 3.8x dimmer than a zenith
     * full moon.
     *
     * **Day 356 was rejected despite being the year's brightest (72.4 deg,
     * 1.00x full).** `dayOfYear` drives the snowline (R-13's seasonal
     * descent), the land-cover classification and ground-cover density, so at
     * latitude 45 day 356 is WINTER: the shot would differ from `night` in
     * **two** variables and could not attribute an effect to moonlight, which
     * is the only reason it is being added. Day 179 holds the season eight
     * days away. Full-moon-on-snow is a real and untested case -- the hardest
     * one for the scotopic range's top end -- and is deferred to Phase 7 as a
     * deliberate two-variable shot with that purpose stated.
     *
     * Verify with `scripts/moon-night-shot-probe.mts`, which composes the
     * renderer's own call chain rather than re-deriving the astronomy.
     */
    clock: { dayOfYear: 179, solarTimeHours: 23.75 },
    // Same structural jitter as `night`: the scotopic pass half-saturates at
    // the scene's key luminance, so it applies a large gain to a dark image
    // and amplifies the cloud pass's temporal jitter along with it. A moonlit
    // frame is brighter and should be steadier, but the relaxation is carried
    // over rather than tightened on an assumption -- pin it from the R4 run.
    ssimThreshold: 0.96,
    // `minMeanLuminance` is OMITTED, not null: the field is optional and
    // `exactOptionalPropertyTypes` rejects null. `night` uses 0.000_5, a floor
    // sized for a near-black frame; copying it onto a moonlit one would make
    // the assertion vacuous. Pin it from the R4 run.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 102, maxFrameIntervalMsP95: 11.8 },
    drawCallCeiling: 263,
    // `drawCallCeiling` likewise omitted rather than null. Draw calls are
    // host-independent and pinned to the measured count exactly, so this
    // gets its value from the R4 run rather than a placeholder.
    comparesToBaseline: true,
    /**
     * `7-5`: the airfield must be LIT in this frame — the phase's headline
     * deliverable, gated on the artifact so no constant rewrite or baseline
     * promotion can silently darken it again (it already went dark through
     * three values of one scale factor).
     *
     * CALIBRATED 2026-09-01 from a vegetation-visible single-command pair
     * (`Principle Engineer`): HEAD at the landed 5.7e5 constant vs a worktree
     * at the old 36.1, band y[216,447) of 720, 295,680 pixels scanned.
     * Non-lamp content in the band tops out between 0.85 and 0.90 luminance;
     * lamp pixels run to ~0.95. At floor 0.90 the dark arm reads EXACTLY 0
     * and the lit arm 431 — the red demonstration fails hard, and the lamps
     * can lose 54% of their bright pixels before the gate trips, against a
     * measured run-to-run floor of ~0.1%.
     *
     * THE FIRST DRAFT OF THIS GATE PASSED ON THE REGRESSION IT EXISTS TO
     * CATCH: a provisional floor of 0.5 admitted non-lamp content and read
     * 326 on the old-constant arm, over the 200 threshold. Only the
     * demonstrate-red-before-trusting-green run exposed it. Do not retune
     * these numbers without re-running BOTH arms.
     *
     * Ceiling bound, measured: nothing in the band exceeds 0.98 — lamp cores
     * saturate just under it — so a floor above ~0.95 gates on nothing,
     * silently. The band itself needs no tightening: the floor alone
     * separates lamps from everything else, and it brackets the measured
     * runway projection (brightest lamp at y=285/720 = 0.396) with the
     * moon's glare excluded above y~0.28.
     */
    litRegion: {
      yMinFraction: 0.3,
      yMaxFraction: 0.62,
      luminanceFloor: 0.9,
      minBrightPixels: 200,
    },
  },
  {
    name: "dusk-mesopic",
    description:
      "Approach pose at 20:27 solar time, in the mesopic band - the only shot "
      + "where rodFraction is strictly between 0 and 1",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    /**
     * **The regime `7-4a` applies at PARTIAL weight, and nothing covered it.**
     * The highlight term reaches the frame through
     * `mix(scene, rodImage, rodFraction)`, so the blend is only exercised when
     * `rodFraction` is strictly inside (0, 1). Measured across every shipping
     * shot clock: **every one lands at exactly 0.000000 or exactly 1.000000.**
     * Sixteen distinct clocks, no partial weight anywhere in the set.
     *
     * **The clock is COMPUTED, not chosen.** `scripts/mesopic-clock-probe.mts`
     * composes the shipping chain -- `resolveEnvironmentState` ->
     * `adaptedLuminanceCdM2` -> `rodFractionForAdaptedLuminance` -- rather than
     * re-deriving it. The night set already shipped with an effectively
     * moonless clock because a plausible hour was picked without checking the
     * moon's altitude (`D-6`, `moon-night-shot-probe.mts`); this is the same
     * mistake one variable over, so the hour is measured.
     *
     * **20.45 h is on the PLATEAU, deliberately not at rod = 0.5.** Day 171 has
     * two contiguous mesopic windows of ~73 min each (02.49-03.71 and
     * 20.29-21.52 h), and the evening one is strongly asymmetric: a ~7-minute
     * cliff where `d(rod)/dt` reaches **12 per hour**, then a long shelf at
     * **~0.22 per hour**. Sitting at rod = 0.5 would put the shot on the cliff,
     * where a small change to the exposure or atmosphere model swings rod far
     * and churns the baseline for a reason unrelated to what the shot tests.
     *
     * Stability at +/- 3 minutes, measured:
     *   20.41 h  rod 0.7236  swing 0.4015   <- cliff still within 3 min
     *   20.42 h  rod 0.7257  swing 0.2903
     *   20.45 h  rod 0.7321  swing 0.0224   <- chosen, ~18x steadier
     *
     * At 20.45 h: **rodFraction 0.7321**, adapted luminance 0.143 cd/m2 --
     * inside the mesopic band (0.03, 3.0) with an order of magnitude of margin
     * at each end, and `shouldRunScotopicPass` true.
     *
     * The pose is `night`'s and `night-moonlit`'s exactly, so the three form a
     * ladder in which ONLY the clock varies: dusk (rod 0.73), moonlit night
     * (rod 1.00), moonless night (rod 1.00). A shot that changed pose as well
     * could not attribute a difference to the blend.
     */
    clock: { dayOfYear: 171, solarTimeHours: 20.45 },
    // Carried from `night` rather than tightened: the scotopic pass applies a
    // large gain to a dark image and amplifies the cloud pass's temporal
    // jitter with it. A mesopic frame is brighter than `night` and should be
    // steadier, but this shot has never been captured and that is an
    // inference. Pin it from three clean runs.
    ssimThreshold: 0.96,
    // `minMeanLuminance`, `ceilings` and `drawCallCeiling` are all pinned from
    // the first three clean runs. `ceilings` is required-and-nullable so it is
    // null; the other two are optional and are OMITTED rather than nulled,
    // because `exactOptionalPropertyTypes` rejects null on an optional field.
    // FIRST PIN (2026-09-01). Three clean runs at committed 0af134c in a worktree,
    // cross-run wallClockFps spread 0.054 against the 0.5 tolerance, plus a
    // fourth first-run capture taken and discarded by protocol. Derived through
    // `firstPinFrom`, which refuses a set whose spread would record the host's
    // noise as the tree's floor rather than widening to accommodate it.
    ceilings: { maxFrameMs: 50, p999FrameMs: 15, hitchCount: 3, minFps: 102, minWallClockFps: 102, maxFrameIntervalMsP95: 11.3 },
    // Measured 156/156/156, byte-identical, and the discarded warm-up agreed.
    // NOT under the raise mechanism: this shot postdates
    // `PREVIOUS_DRAW_CALL_CEILINGS`, so it has no baseline it moved from and no
    // raise can name it. The ceiling is simply the measurement, which is what
    // the field is defined as.
    drawCallCeiling: 262,
    comparesToBaseline: false,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 20, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.4 },
    drawCallCeiling: 268,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 19, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 267,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 208,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.8 },
    drawCallCeiling: 240,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 262,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.7 },
    drawCallCeiling: 235,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.2 },
    drawCallCeiling: 268,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 18, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12 },
    drawCallCeiling: 260,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12.4 },
    drawCallCeiling: 269,
    // `7-9`: 60 measured with the daylight attenuation term, against 56 in the
    // pre-lamp baseline and **10,019 without it**. 400 is ~6.7x the measured
    // value and still 25x below the defect — wide enough that ordinary
    // highlight churn cannot trip it, narrow enough that a lamp calibrated for
    // night blowing out this daylight frame cannot pass.
    maxNearClippedPixels: 400,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.8 },
    drawCallCeiling: 238,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 102, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 267,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
    drawCallCeiling: 281,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.8 },
    drawCallCeiling: 258,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 12.3 },
    drawCallCeiling: 285,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12.2 },
    drawCallCeiling: 258,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.6 },
    drawCallCeiling: 251,
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
    // R4 floors: derived from three runs at 29fd611, ratcheted against the
    // previous pin so none loosened. See scripts/deliveryFloors.mts.
    ceilings: { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.7 },
    drawCallCeiling: 237,
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

  // ---------------------------------------------------------------------------
  // P0 DEFECT SHOTS (2026-08-31). Jason flew the SHIPPING analytic world and
  // reported defects no existing shot frames at a readable scale. As he
  // corrected it: the trees are NOT blue - "there's very clearly a LINE where
  // trees shift from dark green to light green ... it doesn't make sense why
  // the line is so obvious". So the defect is a hard SEAM at a vegetation LOD
  // boundary, plus camo-like brown/blue splotches in the ground materials.
  //
  // THE VANTAGE IS NOT TRANSPLANTABLE, which is why these are feature-located.
  // Jason flew a URL-seeded world (`?seed=`, base-36); captures pin
  // PERF_CAPTURE_SEED = "phase1-perf-baseline". His reported -14,445 / 11,555 at
  // 508 m MSL reproduces in NEITHER frame here: read as an airport offset the
  // terrain is -98.5 m (open ocean, and all three shots below returned 100% sea
  // when first written that way), read as world-absolute it is 122.2 m, and
  // neither yields his 19 m of ground. Coordinates do not survive a seed change;
  // terrain FEATURES do. Hence `locate`, per this list's own docblock.
  //
  // WHY THESE FRAMINGS. Vegetation band membership is keyed on HORIZONTAL
  // distance (`Math.hypot(tree.x - observerX, tree.z - observerZ)`,
  // presentationBuild.ts), never slant range, so altitude cannot push a stand
  // into the next band and the pitch that puts a seam mid-frame is fixed by the
  // altitude alone. At tier 1 (`RENDERED_DENSITY_LAWS[1]`, the shipping
  // G-target), with the fade margin and membership slack applied:
  //   T1 near -> card     the near representation ends at 246 m (150 + 96)
  //   T2 card -> impostor both representations coexist over 904-1,196 m
  //   T3 impostor cull    fades out over 2,580-3,096 m
  // Vertical SCREEN extent of each transition, measured across the 24 existing
  // shots at 720 px: T1 is at most 5 px and off-frame in 19 of 24; T2 peaks at
  // 84 px (forest-line-highsun, itself built for wave R's handoff line); T3
  // peaks at 22 px. A seam crushed into 5 px cannot read as a line. That is how
  // a 24-shot suite drew these defects and gated none of them.
  //
  // SUN BEARING 105 IS LOAD-BEARING, NOT DECORATIVE. It is near side-lit, so
  // both bands take comparable illumination and a brightness step across the
  // seam is attributable to the REPRESENTATION rather than to phase angle. It
  // is also the nearest side-lit bearing with unbroken forest across the seam:
  // sampling the located forest site every 15 degrees, bearings 0-90 break
  // (bearing 90 is grassland at 904-1,000 m, exactly inside T2) while 105-195
  // hold forest at all of 500/700/850/904/1,000/1,100/1,196/1,300/1,400 m.
  // Trees on BOTH sides of the seam are what makes the shot able to fail.
  //
  // PARTIALLY PINNED 2026-09-01, and the omission is the point.
  //
  // These were unpinned because the reference host was thermally exhausted
  // (117.73 -> 31.0 fps on identical code, 2026-08-31) and a ceiling pinned
  // there would bake a 3x throttle in as the standard. Three clean idle-host
  // runs now exist (`DELIVERY_FLOOR_PROVENANCE`), so the mean-like floors and
  // the draw-call ceilings are pinned from them.
  //
  // Their p95 and p999 ceilings are NOT, and are not an oversight: that run set
  // has the widest frame-time TAIL of the three retained sets on this host
  // (median per-shot p95 spread 0.500 ms against 0.200 ms on 2026-08-31
  // evening) at almost identical fps stability (0.120 vs 0.114). The "quiet
  // host" check that cleared the set reads `wallClockFps`, a mean, and does not
  // certify an order statistic. `TAIL_DEFERRED_SHOTS` in
  // `scripts/deliveryFloors.mts` names them and carries the full measurement.
  //
  // `comparesToBaseline: false` until a rebaseline promotes a baseline for
  // each: a shot with no committed baseline is FATAL to a normal capture
  // (`readBaselinePixels` runs with `required = !REBASELINE`), which is what the
  // three eroded shots did to the branch head today. Flip all four to
  // baseline-comparing in the SAME commit that promotes their baselines.
  // ---------------------------------------------------------------------------
  {
    // THE seam shot. Puts the card -> impostor boundary across the middle of the
    // frame at 130 px of vertical extent, against the best existing 84 px, with
    // decimated-card trees filling the lower frame and impostors the upper, so
    // the dark-green/light-green line appears as a step INSIDE one image rather
    // than as a difference between two shots taken at different times. The cull
    // fade also stays on screen at 40 px (best existing 22 px).
    //
    // Framed for the TILE SSIM, not the frame average. A seam is thin,
    // high-contrast and spatially localised - precisely what a whole-frame mean
    // washes out, and this project has already read 0.98 whole-frame against
    // 0.42 in a single tile. The boundary is placed well inside the image rather
    // than at the top edge so it lands across whole 64 px tiles, which is what
    // `worstTileRgbSsimThreshold` actually samples.
    name: "veg-seam-1600ft-oblique",
    description:
      "1,600 ft AGL oblique over closed forest with the card-to-impostor seam "
      + "across mid-frame and trees both sides - catches the dark-green to "
      + "light-green line; framed so worst-tile SSIM sees it, not just the mean",
    cameraMode: "cockpit",
    altitudeAglMeters: 489,
    altitudeMslMeters: null,
    offsetXMeters: 500,
    offsetZMeters: 500,
    pitchDownDegrees: 25,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 14 },
    relativeSunBearingDegrees: 105,
    locate: "forest",
    comparesToBaseline: true,
    ceilings: { maxFrameMs: 50, hitchCount: 3, minFps: 102, minWallClockFps: 102 },
    drawCallCeiling: 255,
  },
  {
    // The secondary seam, and a coverage hole every other shot shares. T1 - the
    // full-geometry -> card boundary at 246 m - is off-frame in every shot with
    // the altitude to see it and at most 5 px in the three ground-level shots.
    // Here it spans 294 px. Same located forest as the shot above, so the two
    // differ only in which seam they frame; the altitude is lower only because
    // at 489 m AGL the 246 m ring sits 63 degrees below the horizon, an attitude
    // no aircraft holds. If the line Jason sees is the geometry -> card boundary
    // rather than the card -> impostor one, this is the only shot that can
    // show it, and the pair together says WHICH boundary is at fault.
    name: "veg-seam-near-500ft",
    description:
      "500 ft AGL over the same forest framing the geometry-to-card boundary - "
      + "the only shot that frames the 246 m near-band edge at a readable "
      + "scale, and the control that says which of the two seams is at fault",
    cameraMode: "cockpit",
    altitudeAglMeters: 150,
    altitudeMslMeters: null,
    offsetXMeters: 500,
    offsetZMeters: 500,
    pitchDownDegrees: 30,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 14 },
    relativeSunBearingDegrees: 105,
    locate: "forest",
    comparesToBaseline: true,
    ceilings: { maxFrameMs: 50, hitchCount: 3, minFps: 103, minWallClockFps: 102 },
    drawCallCeiling: 263,
  },
  {
    // The ground-material shot. Terrain fills the frame - its top edge is 23
    // degrees below the horizon, so there is no sky and no horizon line to
    // anchor exposure - across roughly 322 m to 1,133 m of ground, the scale at
    // which a metre-scale material mask reads as a splotch rather than as
    // texture. Located on a mountain so the rock/slope material family is in
    // frame at 82% terrain coverage: that is the family with the precedent,
    // since wave R found Rock's joint crease was an 84%-coverage half-plane
    // produced by a REVERSED `smoothstep`, which read as "black, brown and
    // white camo" (ARCHITECTURE.md:362). `cliff-60m` gates that family at 60 m
    // and nothing gates it at the range an aircraft actually sees it from.
    // The remaining ~18% is sea along the top edge, which is wanted here: it
    // puts a shoreline in frame, and the reported splotches were brown AND
    // blue.
    name: "terrain-material-1600ft-down",
    description:
      "1,600 ft AGL steep look-down filling the frame with mountain terrain "
      + "322-1,133 m out - catches camo-like brown and blue splotches in the "
      + "ground materials at the range they were reported from",
    cameraMode: "cockpit",
    altitudeAglMeters: 489,
    altitudeMslMeters: null,
    offsetXMeters: -1_200,
    offsetZMeters: -5_600,
    pitchDownDegrees: 40,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 14 },
    relativeSunBearingDegrees: 105,
    locate: "mountain",
    comparesToBaseline: true,
    ceilings: { maxFrameMs: 50, hitchCount: 3, minFps: 102, minWallClockFps: 101 },
    drawCallCeiling: 282,
  },
  {
    // E-5's far-annulus shot: the horizon-shadow term applied to FAR VEGETATION.
    // Vantage measured by the horizon-shadow session with a CPU search, and
    // re-derived here against this seed: camera ground 1,043.5 m (it said
    // 1,043), target ground 483.9 m at 2.2 km (it said 484). The term can only
    // act between `shadowDistance` 1,400 m, where the cascades stop, and
    // `vegetationDistance` 3,000 m, where vegetation stops; the 559 m drop to
    // the target is what holds that annulus open at a sane pitch instead of
    // compressing it to a sliver at the horizon.
    //
    // Clock 18.2 h is pinned, NOT inherited from the 19 h low-sun shots: at
    // 19 h so much of the world is shadowed that a bug disabling the term
    // entirely would still look plausible, whereas at 18.2 h roughly 13% of the
    // field is occluded, so lit and shadowed vegetation are both in frame and
    // the terminator reads as an edge. A frame where everything is shadowed
    // proves as little as one where nothing is.
    //
    // KNOWN LIMIT, recorded rather than discovered later: at this vantage the
    // ridge ahead rises to 1,485 m by 3,000 m out - above the camera - so the
    // shot frames the 1,400-2,600 m part of the annulus (depressions 26.5 to
    // 10.1 degrees) and not its outer end. That is the part where impostor
    // trees stand on ground the horizon field shadows, which is the claim under
    // test. Terrain coverage 77.9%, sea 0.3%.
    //
    // Unlike the three above this one is FIXED, not feature-located: it is
    // aimed at one specific ridge-and-basin pair, so it does not survive a seed
    // change and must be re-derived if the capture seed ever moves.
    name: "horizon-shadow-far-annulus",
    description:
      "Low sun at 18.2 h framing impostor-band CANOPY across the horizon "
      + "terminator at 1,400-2,600 m - lit forest one side, shadowed forest the "
      + "other. The only shot evidencing the horizon term on FAR VEGETATION "
      + "rather than on terrain",
    cameraMode: "cockpit",
    // R4: 120 -> 400 m. At 120 m the vantage's forested band sits at only
    // 3.7-4.4 deg of depression, so a pitch of 18 looks well BELOW it and
    // fills the frame with near ground the CSM already shadows. Measured by
    // ray-marching this shot's own parameters, **2-6% of land samples fell in
    // the 1,400-3,000 m annulus** — the only band where the horizon term can
    // act. Two sessions measured this independently and got 1.8% and 5.7%;
    // the spread is ray-grid density, not a disagreement about the finding,
    // and the range is quoted rather than either number, because neither is
    // the one. The frame was overwhelmingly near ground the CSM already
    // shadows. The shot could not fail on its own stated purpose.
    //
    // The compression was flagged when the vantage was chosen and no altitude
    // or pitch was specified with it: a caveat stated without a corresponding
    // parameter is a caveat that does not act. The second session's own note
    // is worth carrying too — this shot was cited as covering `L-3` on the
    // strength of its docblock being canopy-gated, without measuring how much
    // of its frame reaches the band. The docblock was true and the coverage
    // was not implied by it.
    //
    // Swept AGL x pitch at this vantage and bearing, in-band land coverage /
    // canopy samples in band / sky:
    //   120 m  1.8% /  34 / 0.0%      400 m  27.6% / 326 / 1.7%
    //   250 m 14.3% / 166 / 0.2%      600 m  39.7% / 507 / 4.3%
    // The second sweep agrees on the remedy to within 0.3 pp (27.9% at 400 m)
    // while differing on the baseline — the fix reproduces, the floor does
    // not. 400 is the stop: ~15x the in-band coverage of 120 with sky still
    // negligible, where 600 starts spending frame on sky.
    altitudeAglMeters: 400,
    altitudeMslMeters: null,
    /**
     * **A FIXED-OFFSET vantage — the only one among the four seam shots — so
     * its coordinates mean something on their own and must be validated
     * directly. The other three are `locate`-based, where the predicate finds
     * the feature and the raw offset is merely a search seed.**
     *
     * Mixing the two conventions in one set is a trap this shot already fell
     * into once: `forest-500ft-sunbehind`'s raw offset `(-4000, +3000)` samples
     * at -33 m, biome 0 — UNDERWATER — and its `locate: "forest"` does all the
     * work. So a fixed-offset vantage cannot be checked against a `locate`
     * shot's realised position, or the reverse, and reading one as the other
     * validates a point the capture never visits.
     *
     * **Re-sited 2026-08-31 because the original vantage had NO TREES.** It was
     * chosen on horizon-occlusion margin alone and never gated on vegetation:
     * measured canopy along the sun ray was 0 stems/m2 at every one of 1,400 /
     * 1,800 / 2,200 / 2,600 / 3,000 m. A shadowed bare hillside evidences only
     * what `4-7` already shipped for terrain in Phase 4 and would look
     * identical with the horizon-shadow change reverted — **a shot that cannot
     * fail**, which is the instrument failure this phase has produced most
     * often.
     *
     * This vantage is gated on the CONJUNCTION: impostor-capable canopy
     * (>= 0.0075 stems/m2, heightFactor >= 0.4 to exclude krummholz) AND both
     * shadowed and lit canopy in frame, because a uniformly dark frame proves
     * as little as a uniformly lit one. Closed forest 0.07-0.08 stems/m2 from
     * 1,400-2,000 m, thinning to 0.037 by 2,400; the horizon terminator falls
     * between 1,800 and 2,100 m, inside tier 1's 1,400-3,000 m annulus.
     *
     * Stated limit rather than buried: the ground here is nearly flat, so the
     * forested band spans only 4.4deg to 3.7deg of depression and reads as a
     * compressed horizontal strip. Raising AGL barely helps. Trees are
     * non-negotiable; compression is a framing problem. Runners-up if it frames
     * badly: (2000, -18000) ground 134 m at 18.5 h, and (-1500, 4500) ground
     * 65 m at 18.2 h.
     */
    offsetXMeters: 5_000,
    offsetZMeters: 3_000,
    pitchDownDegrees: 18,
    airspeedMetersPerSecond: 0,
    clock: { dayOfYear: 171, solarTimeHours: 18.2 },
    relativeSunBearingDegrees: 161,
    comparesToBaseline: true,
    ceilings: { maxFrameMs: 50, hitchCount: 3, minFps: 103, minWallClockFps: 101 },
    drawCallCeiling: 238,
  },
  {
    /**
     * **`L-4` (`PHASE_7_EXECUTION_PLAN.md` §10a): the only shot that looks INTO
     * a low sun.** Appended 2026-08-31.
     *
     * The filed defect is a far/mid luminance ratio of 0.510 under a low,
     * deeply back-lit sun — the far band at half the mid band's brightness.
     * **That figure is carried on another session's measurement and is
     * UNVERIFIED**; nothing in the suite could confirm or refute it, because no
     * committed shot puts the camera on the sunward side of the canopy.
     * `forest-500ft-sunbehind` is sun ASTERN, i.e. front-lit — the opposite
     * phase angle. This shot exists to settle that row either way.
     *
     * **BEARING 0, AND THE BRIEF THAT SAID OTHERWISE WAS WRONG.** The item was
     * handed over as "elevation 15, azimuth 180". As a WORLD azimuth that is
     * unrealisable: on `dayOfYear` 171 at latitude 45 the sun is due south only
     * at local noon and therefore at maximum elevation, never at 15deg. As a
     * RELATIVE bearing, 180 is sun-astern — front-lit, the opposite of the
     * condition the row describes. The artifact settles it:
     * `DetailInstanceMaterialPlugin`'s `impostorBacklit` docblock records that
     * "every backlit stand stepped from glowing mid hulls to flat far sprites
     * at the handoff ring" — the mid/far step is a BACK-LIT phenomenon, so the
     * camera must face the sun. Bearing 0. The ambiguity is written down rather
     * than silently resolved, because a later reader handed the same brief will
     * otherwise re-derive it from the same broken wording.
     *
     * **WHY IT CAN FAIL.** A back-lit ratio needs all three canopy
     * representations in ONE frame, or a step between them is unattributable.
     * Verified before capture with `scripts/frame-forensics.mts`, marching 180
     * real rays through this exact camera: **0% water**, 48.9% impostor-capable
     * canopy, ground range 479-5,278 m, and band coverage mid 114 / far 51 /
     * beyond-far 15. The mid->far ring at 1,196 m lands near row 328, well
     * inside the image rather than at an edge.
     *
     * **LOCATED, NOT FIXED**, and gated on the VEGETATION field rather than the
     * biome id — see the `locate` docblock. The raw offset below is only the
     * search seed. It is also scanned along the SUN-derived heading, not +x:
     * with `relativeSunBearingDegrees: 0` the corridor the camera looks down is
     * not the corridor a +x predicate checks, and validating the wrong corridor
     * is how a shot gets blessed for terrain it never frames.
     *
     * **PARTIALLY PINNED 2026-09-01.** Mean-like floors and `drawCallCeiling`
     * are derived from the three clean runs in `DELIVERY_FLOOR_PROVENANCE`. Its
     * p95/p999 ceilings are deliberately absent — that set has the widest tail
     * of the three retained sets, and this shot is its worst p95 spread at
     * 1.50 ms (10.0 / 10.4 / 8.9). See `TAIL_DEFERRED_SHOTS`.
     *
     * `comparesToBaseline: false` until R4 promotes a baseline for it — a shot
     * with no committed baseline is FATAL to a normal capture. Flip it in the
     * same commit that promotes the baseline, never separately.
     *
     * **The one number I could not derive without a host: the luminance
     * floors.** Solar elevation 15deg over closed canopy, looking into the sun,
     * may sit near the 0.01 default `minMeanLuminance`. The defaults are left
     * in place rather than guessed downward — if the first capture trips them,
     * the floor is the thing to re-derive from that frame, with the reasoning
     * recorded the way `night`'s 0.0005 was. Lowering it pre-emptively would
     * make it decorative.
     */
    name: "canopy-backlit-lowsun",
    description:
      "400 m AGL looking INTO a 15deg sun over closed canopy, with mid, far "
      + "and beyond-far vegetation all in frame - the only shot on the sunward "
      + "side of the canopy, and the only one that can settle L-4's far/mid ratio",
    cameraMode: "cockpit",
    altitudeAglMeters: 400,
    altitudeMslMeters: null,
    // Search seed only; `locate: "canopy-backlit"` does the work. Verified
    // vantage on the current seed resolves near (11000, 12000), ground 151.4 m.
    offsetXMeters: 11_000,
    offsetZMeters: 12_000,
    pitchDownDegrees: 20,
    airspeedMetersPerSecond: 0,
    // 18.13 h -> solar elevation 15.03deg, bisected against `solarPosition`.
    clock: { dayOfYear: 171, solarTimeHours: 18.13 },
    relativeSunBearingDegrees: 0,
    locate: "canopy-backlit",
    comparesToBaseline: true,
    ceilings: { maxFrameMs: 50, hitchCount: 3, minFps: 103, minWallClockFps: 102 },
    drawCallCeiling: 246,
  },
  /**
   * NIGHT_LOOK_ARCHITECTURE §2.1, Option B — two PROBE clocks bracketing the
   * twilight dip, for Jason's four-frame reaction set (golden hour, blue
   * hour, the dusk-mesopic mover, the night-moonlit unchanged control).
   * PROBES, not baselined shots: `comparesToBaseline: false`, `ceilings:
   * null`, APPENDED at the list's end — an insertion above would renumber
   * every canonical index and move the pinned wave phase of every baselined
   * shot (the Wave R trap).
   *
   * Both clocks are BISECTED against the shipping ephemeris to a target sun
   * elevation, not picked — the `night` shot shipped effectively moonless
   * because a plausible hour went unchecked. Same approach pose as
   * `dusk-mesopic`/`night-moonlit`, so all four frames differ only in clock.
   */
  {
    name: "golden-hour",
    description: "Approach pose with the sun at +5.0 deg — bright and warm, ABOVE the twilight dip window",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    // 19.148 h -> sun sine +0.0872 (+5.0 deg), bisected on day 179 at 45N.
    clock: { dayOfYear: 179, solarTimeHours: 19.148 },
    comparesToBaseline: false,
    ceilings: null,
  },
  {
    name: "blue-hour",
    description: "Approach pose with the sun at -3.0 deg — inside the twilight dip's full hold",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    // 20.047 h -> sun sine -0.0523 (-3.0 deg), bisected on day 179 at 45N.
    clock: { dayOfYear: 179, solarTimeHours: 20.047 },
    comparesToBaseline: false,
    ceilings: null,
  },
  {
    name: "night-beacon-offset",
    description:
      "Night approach pose sampled off the lamp-phase lattice: beacon DARK and "
      + "strobes LIT, the complement of every other shot in the set",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    clock: { dayOfYear: 179, solarTimeHours: 23.75 },
    /**
     * **The shot `7-0-a` was to append and did not.** The plan names it three
     * times — including in `7-8`'s own text as the thing that catches the
     * beacon's off phase — and it was never created. `dusk-mesopic`, its twin
     * from the same bullet, was missing too and is now in.
     *
     * **Why the set needs it.** The harness pins
     * `simulationTime = 500 + index * 120`, and both flashing rates divide
     * 120 s into whole periods — 45 fpm gives 90 and 60 fpm gives 120. So
     * **every** shot samples beacon phase 0 and strobe phase 0.5: beacon lit,
     * strobe dark, in every captured frame. The complementary state is captured
     * nowhere, and a beacon wired to the strobe's timer — or either lamp stuck
     * on — would look identical in every one of them.
     *
     * **0.53 s is computed, not chosen.** Searched for the offset maximising
     * the smaller margin to a duty edge, so the shot is not perched on a
     * transition: at `t = 500 + 120k + 0.53` the beacon sits at phase 0.3975
     * (off, 0.1775 periods clear of its 0.22 duty edge) and the strobe at 0.03
     * (lit, 0.03 clear of both edges). Verified at k = 0, 1, 2.
     *
     * Same pose and clock as `night-moonlit`, so the ONLY difference between
     * the two frames is lamp phase — a shot that changed pose as well could
     * not attribute a difference to the lamps.
     */
    simulationTimeOffsetSeconds: 0.53,
    // Carried from `night`, not tightened: the scotopic pass amplifies the
    // cloud pass's temporal jitter and this shot has never been captured.
    ssimThreshold: 0.96,
    ceilings: null,
    comparesToBaseline: false,
  },
  {
    name: "apron-hangar-variety",
    description:
      "Ground pose off the runway shoulder framing hangars 0 and 1 \u2014 the 3-bay "
      + "gabled and the 6-bay arched \u2014 so both hash-driven plan channels are in one frame",
    cameraMode: "cockpit",
    altitudeAglMeters: 1.7,
    altitudeMslMeters: null,
    offsetXMeters: -233,
    offsetZMeters: -12,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 0,
    /**
     * **7-10's "visually distinct under the same seed" needs TWO hangars, and no
     * existing shot contains one.** `AirfieldStructures.ts` states the failure
     * mode outright: "three hangars differing only in height read as one
     * building at three scales." A single-hangar frame cannot show variety --
     * obliqueness buys pilasters, but variety needs something to vary against.
     *
     * **The pose is oblique because the features are on different walls.** Door
     * leaves sit on the -across wall only, the clerestory on both across walls,
     * and the pilasters ONLY on the +/-along gable ends. A camera square-on to
     * the apron sees doors and glazing and NO PILASTER -- and the pilasters are
     * the only place the bay count becomes visible geometry.
     *
     * **The bay-count signal is pilaster PITCH, not pier width.**
     * `pilasterWidthMeters` is 0.70 m on every hangar that will ever exist, so a
     * budget gated on it reads identically whether bay counts vary, are uniform,
     * or are broken. Under this seed the emitted pitches are 15.10 / 7.55 /
     * 11.32 m: hangar 0 draws the 3-bay minimum and gabled, hangar 1 draws 6
     * bays and ARCHED -- differing in both independent hash channels.
     *
     * **Framing verified by frustum projection, NOT by the terrain oracle.**
     * `cockpitTerrainCoverage` is blind to buildings; it would return identical
     * numbers if the hangars did not exist, so it establishes only that this is
     * not a capture of empty ocean (46.4% terrain, 13 sea rays of 943). Both
     * target hangars project FULLY inside the 56 x 33.3 deg cockpit frustum:
     * hangar 0 spans horiz [-20.7, 0.3] deg and hangar 1 [-0.2, 22.3] against a
     * 28 deg half-angle; vertically 12.5 at worst against 16.7. Hangar 2 clips
     * the right edge and is a bonus, not a requirement.
     *
     * **`relativeSunBearingDegrees` is derived, not chosen.** Aiming is only
     * reachable through the sun bearing, so -38.92 is the value yielding the
     * 69.40 deg yaw that points at the 0/1 midpoint; round-tripped through
     * `yawForSunBearing`.
     */
    relativeSunBearingDegrees: -38.92,
    comparesToBaseline: false,
    ceilings: null,
  },
  {
    name: "sunset-sunward",
    description:
      "Blue-hour approach pose FACING the sunset azimuth — the twilight sky's "
      + "sunward half, which no other shot has ever framed",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    /**
     * **The gap this shot closes hid a physics gap for six rounds.** Every
     * twilight shot in the set flies the +x convention, 137–152 deg off
     * the sun; measuring the shipping integral showed the twilight sky is
     * AZIMUTHALLY UNIFORM below sunset (sunward R/B ≡ anti-solar to
     * three digits at −3 deg and −6 deg, while golden-hour's +5 deg
     * sunward reads 5.51 — the warm machinery works only while the sun
     * is up). Nobody saw the missing sunset because nothing looked at it:
     * two gaps, one hiding the other. This shot is landed BEFORE the warm
     * lobe that fixes the model, so its first baseline is the honest
     * "before" — a uniformly blue sunset.
     *
     * Bearing 0 = flying INTO the sun's azimuth (the field's own
     * convention); the blue-hour clock (−3.0 deg, bisected day 179)
     * because real sunset colour peaks in early civil twilight, and the
     * probe should sit where the missing signal is largest.
     *
     * APPENDED AT THE END, never inserted: a mid-list insertion renumbers
     * every canonical shot index and moves every baselined wave phase (the
     * Wave R trap, re-proven at the golden/blue-hour append).
     */
    relativeSunBearingDegrees: 0,
    clock: { dayOfYear: 179, solarTimeHours: 20.047 },
    comparesToBaseline: false,
    ceilings: null,
  },
  {
    name: "approach-lights-outboard",
    description:
      "1.5 km out on the extended centreline, looking back along the approach "
      + "light row - the only shot that frames the crossbar and the outer lamps",
    cameraMode: "chase",
    altitudeAglMeters: 60,
    altitudeMslMeters: null,
    offsetXMeters: -1_500,
    offsetZMeters: 0,
    pitchDownDegrees: 6,
    airspeedMetersPerSecond: 34,
    /**
     * **`runway-on-approach` cannot show the approach lighting system, and that
     * is why this exists.** Resolved through the harness's own camera
     * construction, its crossbar sits **62 m BEHIND the camera**: short final
     * flies past the whole system before the frame is taken. Two more lamps are
     * behind it, two are outside the vertical FOV, exactly ONE near-end lamp is
     * in frame, and what it does show of the system is the OPPOSITE row at
     * 1.6-2.0 km. **A vegetation fix verified against that shot would have come
     * back clean whatever it did.**
     *
     * MEASURED for this vantage instead: **16 of 16 near-end approach lamps in
     * frame**, the ten-lamp crossbar at 540 m and 7.9 deg depression, the outer
     * lamps at 422-482 m. `-1400/45 m/5 deg` and `-1600/80 m/7 deg` also give
     * 16 of 16, so the framing is not knife-edge.
     *
     * **Why it needs framing: the exclusion around the airfield is a rounded
     * rectangle 740 m half-length plus a 240 m blend, and the approach row runs
     * to 1080 m.** The last four lamps sit at clearance 1.000 - the airport term
     * does nothing at all - and the crossbar at 0.980, which measured 74.7
     * trees/ha and 217.2 shrubs/ha against 783/ha open ground 3 km away.
     *
     * Daylight, because the defect being verified is VEGETATION. The lamps are
     * why the trees matter; the trees are what the frame has to show.
     *
     * APPENDED AT THE END, never inserted: a mid-list insertion renumbers every
     * canonical shot index and moves every baselined wave phase.
     */
    clock: { dayOfYear: 171, solarTimeHours: 9.5 },
    comparesToBaseline: false,
    ceilings: null,
  },
  {
    name: "lake-island-piercing",
    description:
      "Ground-level daylight look at hydrology lake 23:-16, where terrain "
      + "rose up to 10.1 m through the legacy water plate (the analytic twin "
      + "of the W-5 dropped-island residual; fixed by appendContainedLake)",
    cameraMode: "cockpit",
    altitudeAglMeters: 90,
    altitudeMslMeters: null,
    /**
     * Jason's in-flight report, verbatim: "blue blotches over the green
     * terrain… hard geometric shapes that go through the terrain… especially
     * near water." scripts/hydrology-piercing-probe.mts measured every
     * analytic lake pierced by ground (1.1% of lake area; worst 10.1 m at
     * (20520, −14630), two instruments converged — a coarse first grid
     * read 8.34 m), and lakeShoreline.ts records why: "Interior
     * (hole/island) rings are dropped: the polygon export contract is a
     * single ring. Recorded W-5 residual" — the plate is triangulated over
     * its islands. This shot stands 75–100 m west of the worst measured
     * ridge run (20503..20533, −14627), flying the +x convention straight
     * at it, daylight default clock, fixed offsets (no locate: the point is
     * exact, not searched).
     *
     * APPENDED AT THE END, never inserted: a mid-list insertion renumbers
     * every canonical shot index (the Wave R trap).
     */
    offsetXMeters: 20_395,
    offsetZMeters: -14_501,
    pitchDownDegrees: 22,
    airspeedMetersPerSecond: 0,
    comparesToBaseline: false,
    ceilings: null,
  },
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
  /**
   * `7-5`: the airfield-is-lit scan, present exactly when the shot declares
   * `litRegion`. Recorded in the report so the gate's inputs are auditable:
   * `brightPixels` above the declared luminance floor inside the declared
   * band, and `pixelsScanned` so a zero-size scan is a loud failure rather
   * than a vacuous pass.
   */
  /** Whole-frame count of near-clipped pixels — the day-side lamp gate. */
  readonly nearClippedPixels: number;
  readonly litRegion?: {
    readonly brightPixels: number;
    readonly pixelsScanned: number;
  };
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
  /**
   * Metres the observer actually covered approaching this pose, measured from
   * the positions rendered rather than from the distance planned.
   *
   * **Zero on every shot unless `VITE_PERF_TRANSLATE=1`**, because the settle
   * loop otherwise renders a fixed position for all 240 warm-up frames — so
   * every pinned capture streams its world from a standstill and arrives at
   * its pose without a journey. An early exit (the stability break, or the
   * undrained cut) reports the distance genuinely covered, not the planned
   * one: this is an OUTCOME, and a guard reading `translating: true` learns
   * only that a flag was set.
   */
  readonly observerTravelMeters: number;
  /**
   * The approach speed this shot actually resolved to, after the default.
   * Published so the report explains its own travel without anyone
   * cross-referencing the shot table.
   */
  readonly approachSpeedMetersPerSecond: number;
  /**
   * Warm-up frames the approach ACTUALLY ran, not the number planned.
   *
   * These differ whenever the settle loop exits early — the stability break or
   * `VITE_PERF_UNDRAINED_FRAMES`. Measured: an undrained cut at 200 against a
   * 240-frame approach produced 205.6 m rather than 248.0 m. **A guard
   * predicting distance from the PLANNED count would have been wrong by a
   * fifth on that run and had no way to know.**
   */
  readonly approachFrames: number;
  /**
   * The residency total above, split by WHY each page is wanted. Only `drawn`
   * could ever be reduced by a visibility test: the collision ring is
   * omnidirectional on purpose, morph parents pop their children, and erosion
   * seed blocks gate admission. `drawnBeyondShadowDistance` is the figure a
   * frustum cull would be sized from, because terrain inside the shadow
   * distance casts into view from any direction.
   */
  readonly residencyReasons: {
    readonly drawn: number;
    readonly parent: number;
    readonly collision: number;
    readonly seed: number;
    readonly drawnBeyondShadowDistance: number;
  };
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
  /**
   * The estimate restricted to what the inventory walk can see — misc, the
   * eroded-only reservations and the slack factor removed. The re-pin trigger
   * compares THIS against the inventory; the unrestricted figure above is not
   * comparable to a measurement and never was.
   */
  readonly estimatedInventoriableGpuMemoryMiB: number;
  /** Z-4: the renderer's actual-allocation floor reading. */
  readonly inventoriedGpuMemoryMiB: number;
  /**
   * The floor reading's three lanes, summing to it.
   *
   * Recorded because the estimate's re-pin trigger fired at 47.3% and the
   * report held only the two ends of that subtraction, so the divergence could
   * be measured and not attributed. `MISC_ALLOWANCE_MIB` claims 40 MiB for
   * "pipelines, shader cache, aircraft/airport meshes, sky dome, small LUTs" —
   * the meshes and LUTs are IN this walk, the pipelines and cache are not, and
   * without the lanes there is no way to say how much of the 40 is which.
   */
  readonly inventoriedGpuMemoryLanes: {
    readonly textureMiB: number;
    readonly geometryMiB: number;
    readonly bufferMiB: number;
  };
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
  /**
   * Frames the settle loop was cut short at, or null for a normal settled run.
   *
   * NON-NULL MEANS THIS REPORT IS A DIAGNOSTIC, NOT A BASELINE. The capture was
   * taken with streaming work still in flight — deliberately, to reach the one
   * state every other path here removes — so its pixels, its memory readings and
   * its draw counts all describe a half-resolved world. Nothing pinned may be
   * derived from it.
   */
  readonly undrained: number | null;
  /**
   * `VITE_PERF_TRANSLATE=1`: the observer FLEW INTO this pose rather than
   * appearing at it. The measured frame is the same pose as a pinned capture;
   * what differs is that the world was streamed by a moving observer, so
   * residency, cell replans and `resident.distance` reflect an arrival rather
   * than a stand. **A translated run is deliberately not reproducible** — the
   * 256 m distance lattice is crossed at different points on different runs —
   * so it must never be read as a baseline or differenced against one.
   */
  readonly translating: boolean;
    /**
     * The tier-cliff A/B arm: the profile fields this run forced, verbatim, or
     * null for an unmodified run. Recorded so an archived arm carries its own
     * configuration — and its absence is a positive signal that the override
     * plumbing was missing when the run was taken.
     */
    readonly profileOverride: Readonly<Record<string, unknown>> | null;
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
