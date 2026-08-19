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
/** SSIM below this against the committed baseline fails the capture. */
export const PERF_CAPTURE_SSIM_THRESHOLD = 0.985;
/** rAF-paced frames measured per shot (Z-1/Z-2): fps and hitch metrics come only from these. */
export const PERF_CAPTURE_MEASURE_FRAMES = 240;
/** Consecutive frames read back at the end of a motion shot for temporal metrics (Z-3). */
export const PERF_CAPTURE_TEMPORAL_FRAMES = 24;

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
 */
export interface PerfCaptureShotCeilings {
  readonly maxFrameMs: number;
  readonly p999FrameMs: number;
  readonly hitchCount: number;
  readonly minFps: number;
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
  /**
   * Z-3: heading as the sun bearing off the nose in degrees (0 = flying into
   * the sun, 180 = sun dead astern). Resolved by the driver against the
   * shot's own clock. Unset = fly +x, the Phase-1 convention.
   */
  readonly relativeSunBearingDegrees?: number;
  /** Z-3: locate the shot over a terrain feature instead of a fixed offset. */
  readonly locate?: "fixed" | "forest" | "coast";
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
  /** Motion shots do not diff against a PNG baseline (their gate is temporal). */
  readonly comparesToBaseline?: boolean;
  /**
   * Per-shot SSIM floor override. The resize-path shot carries slightly more
   * temporal variance than the fixed-viewport shots (measured 0.981 against
   * its own fresh baseline); everything else uses PERF_CAPTURE_SSIM_THRESHOLD.
   */
  readonly ssimThreshold?: number;
  /** Z-3: committed floors for the motion shot's temporal-stability metrics. */
  readonly temporalFloors?: {
    readonly minConsecutiveSsim: number;
    readonly maxMeanLuminanceDelta: number;
  };
  readonly ceilings: PerfCaptureShotCeilings | null;
}

/**
 * The capture shot list. Three Phase-1 shots, Gate 2Z's coverage additions
 * (reference viewport, cruise horizon, winter noon, night, the banked-turn
 * motion scene — R-8/R-9/R-15), and the five Phase-2 §10.2 scenes including
 * the 2 m eye-height and 1,200 ft canopy views. Positions are relative to the
 * world's airport so the definitions survive seed changes at sanctioned
 * rebaselines; forest/coast shots locate themselves from the terrain field.
 *
 * Floors/ceilings re-pinned 2026-08-18 at the sanctioned Gate 2A rebaseline
 * (three clean quiet-machine runs with the volumetric sky live). Rule:
 * `minFps = floor(min over clean runs) − 2`, never raised above the Z-2
 * value. The pre-cloud floors dated from a cloudless renderer; under the
 * cloud composite, headless rAF pacing settles ~1–4 fps lower at identical
 * GPU cost. Every re-pinned floor still catches the one real regression
 * observed while landing 2A (slant-10km at 26.4 fps before the
 * adaptive-march work). `minFps` gates the TRIMMED sustained rate
 * (`sustainedFpsFromFrameIntervals`); sparse stalls belong to the spike
 * gates below.
 *
 * Hitch ceilings tightened at the sanctioned 2-8 rebaseline against the 3×
 * frame-target hitch definition (the 2× definition saturated — a typical
 * Phase-2 headless frame sat near 2× the target, so the counts measured
 * scheduler jitter). Rule: `2 × max over the two clean ×3 runs, floor 15,
 * rounded up to 5`. Observed clean counts are 3–39 per 240 frames; the old
 * saturated counts (90–230) breach these ceilings by 3–10×.
 *
 * Floors re-pinned UPWARD at the sanctioned 2-12 rebaseline (three
 * consecutive clean quiet-machine runs with card forests live): the
 * law-priced band prototypes + per-band variant caps left most shots FASTER
 * than the 2B-close baseline (the 17 M-triangle cone system they replace),
 * e.g. cruise-horizon 44.4 → 59.1+ fps — the old floors would have let an
 * 8-fps regression through silently. Same `min(clean runs) − 2` rule.
 *
 * Floors re-pinned MIXED at the sanctioned 2-17 rebaseline (three clean
 * runs within ±0.3 fps, hitch threshold moved 3× → 4× in the same re-pin —
 * the 3× line sat inside the heavy shots' vsync-quantization band and
 * counted 190–236 phantom hitches per 240 frames on identical builds).
 * Far-field shots RISE (coast 45 → 52, cruise-sun 49 → 53: the impostor
 * band replacing crossed cards); near-field airport shots DROP (approach
 * 33 → 24, reference 32 → 21) carrying the full Gate-2C understory —
 * grass, shrubs, clutter, rocks, wind, season, continuous crossfades — at
 * honest capture-rig cost. That drop is RECORDED PERF DEBT against the
 * §5.4 vegetation frame rows (see the 2-17 decision-log row), not an
 * accepted end state: the ladder's remaining rungs (near-field density
 * tuning, buffer reuse, R-21 constant revision) are scheduled work, and
 * these floors exist to catch regressions from THIS state meanwhile.
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 20, minFps: 24 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 15, minFps: 49 },
  },
  {
    name: "high-10000ft-down",
    description: "10,000 ft MSL, cockpit view pitched 45° down",
    cameraMode: "cockpit",
    altitudeAglMeters: null,
    altitudeMslMeters: 3_048,
    offsetXMeters: 2_000,
    offsetZMeters: -6_000,
    pitchDownDegrees: 45,
    airspeedMetersPerSecond: 92,
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 15, minFps: 47 },
  },
  {
    // Z-3: the only configuration where the tier-1 pixel cap binds — i.e.
    // where Governor A is structurally dead (R-6) and the GPU work ladder is
    // the only actuator. 1512×982 at scale 1 ≈ the capped 1.5 Mpx the
    // reference MacBook actually rasterises.
    name: "reference-viewport",
    description: "Approach pose at the 1512×982 reference viewport (tier-1 cap binds)",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
    viewportWidth: 1_512,
    viewportHeight: 982,
    ssimThreshold: 0.975,
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 30, minFps: 21 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 15, minFps: 57 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 15, minFps: 24 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 15, minFps: 24 },
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
    temporalFloors: { minConsecutiveSsim: 0.7, maxMeanLuminanceDelta: 0.01 },
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 80, minFps: 27 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 15, minFps: 53 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 70, minFps: 26 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 15, minFps: 52 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 70, minFps: 24 },
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
    // Z-2 ceilings measured 2026-08-18 (three runs, headless Chromium on the
    // M-series reference machine). Headless rAF pacing is noisy (hitch counts
    // varied ±45 between runs), so the hitch ceilings sit ~2.5-3x above the
    // observed medians — they catch order-of-magnitude regressions, while
    // minFps and the SSIM gate catch everything gradual.
    ceilings: { maxFrameMs: 1_500, p999FrameMs: 1_500, hitchCount: 65, minFps: 27 },
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
 * Sustained frame rate from per-frame intervals, robust to sparse stalls.
 *
 * Each Z-2 gate owns one failure mode: `maxFrameMs`/`p999FrameMs`/
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
  /** Per-tile means, row-major, rounded for a stable JSON diff. */
  readonly tileMeans: readonly number[];
}

export interface PerfCaptureShotReport {
  readonly name: string;
  readonly description: string;
  readonly ssimAgainstBaseline: number | null;
  readonly tiles: TileStatistics;
  /**
   * Z-1: frames ÷ wall-clock over the rAF-paced measurement phase — a real
   * frame rate, not a macrotask-yield artefact.
   */
  readonly fps: number;
  readonly cpuFrameMsP95: number;
  readonly gpuFrameMsP95: number | null;
  /** Z-2 hitch metrics over the measurement phase only. */
  readonly maxFrameMs: number | null;
  readonly p999FrameMs: number | null;
  readonly hitchCount: number;
  readonly drawCalls: number;
  /**
   * Vegetation batches surviving frustum culling — the vegetation frame
   * row's real currency (2-12: ~26 µs per draw, `Δgpu` linear in `Δdraws`).
   * Added by the vegetation perf-debt pass so the row can be measured
   * rather than asserted.
   */
  readonly vegetationBatches: number;
  readonly triangles: number;
  readonly residentTerrainPages: number;
  readonly pendingTerrainPages: number;
  readonly renderPixels: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly estimatedGpuMemoryMiB: number;
  /** Z-4: the renderer's actual-allocation floor reading. */
  readonly inventoriedGpuMemoryMiB: number;
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
  readonly shots: readonly PerfCaptureShotReport[];
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
      tileMeans.push(Math.round(mean * 10_000) / 10_000);
      varianceSum += Math.max(0, sumSquares / count - mean * mean);
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
