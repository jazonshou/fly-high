import type { PresentationCadence } from "@/src/render/webgpu/core/presentationCadence";
import type { FrameRateSetting } from "@/src/settings";

/**
 * The frame pacer (PR B): which requestAnimationFrame ticks the game draws.
 *
 * "60 fps (smooth)" draws every Nth display refresh with N = floor(rate/60),
 * so frames stay evenly spaced: 120 and 240 Hz draw 60, 144 Hz draws 72 and
 * 165 Hz draws 82.5, and 60-100 Hz displays draw every refresh. "30 fps"
 * uses N = round(rate/30). "Match display" draws every refresh, as the game
 * always did. A tick that does not draw only asks for the next frame.
 *
 * The display period is measured from the ticks themselves, and only clean
 * evidence may confirm it: runs of ticks that nothing asked to draw (the
 * startup probe's quiet lead, a re-probe while paused), and ticks the pacer
 * skipped with time to spare. Render cost cannot stretch either, so a slow
 * machine never relaxes its own target. Not every tick that drew nothing is
 * clean. Probe ticks after the lead share the main thread with renderer
 * creation, which misses vsyncs at random. And a stamp is not its vsync:
 * Firefox on macOS can move a stamp early by several ms, never late (its
 * vsync callback clamps a stamp from the future to now), so once frames
 * take two refreshes or more, nearly the only ticks the pacer skips are the
 * early ones, skipped by a hair, and the delta after each is 1.5 to nearly
 * 2 periods (12.5-15.6 ms at 120 Hz), never one. Counted as clean, those
 * deltas confirmed rates no display runs at (132 Hz on a 120 Hz panel), or
 * a divisor of 1 that turned pacing off.
 *
 * The same stamps break the rule that intervals cannot beat the display: a
 * tick stamped early shortens the delta before it as much as it lengthens
 * the next. Consecutive deltas still add up to whole periods, so a faster
 * period wins only where it holds on quiet deltas (both neighbours on whole
 * multiples of them), which jitter cannot fake. Where it may stand for
 * frames of two refreshes of a display twice as fast and the pacer would
 * draw every tick, the pacer holds the old rate unconfirmed and skips a few
 * ticks to measure the display. Everything else the drawn ticks show goes
 * through a grid fit over every tick, along which jitter cancels: it may
 * sharpen the clean period or snap it to a common rate, or, when it keeps
 * contradicting it, withdraw the confirmation while the rate is held. It
 * never sets a rate of its own.
 *
 * Pure, with no DOM: `startIdleProbe` takes the browser's frame and timer
 * functions as a host. A tick allocates nothing.
 */

/**
 * Whether "60 fps" paces. On since the governor judges windows against the
 * paced cadence (PR B's G1): without that, a 120 Hz player paced to 60 lands
 * in the regime where shed work never comes back. Switched off, "60 fps"
 * draws every refresh; "30 fps" is an explicit choice and paces either way.
 */
export const FRAME_PACING_ENABLED = true;

/** Deltas kept per ring. */
const RING_SIZE = 64;
/** All-ring samples before an estimate. */
const MIN_SAMPLES = 16;
/**
 * Clean deltas before they can confirm the period: a probe's run, or skips.
 * Fewer than the all ring needs, so the startup probe's 24-tick lead
 * confirms on its own: a busy renderer creation after it may leave no
 * other clean run.
 */
const MIN_CLEAN_SAMPLES = 12;
/** Below this a delta is no display's period (a catch-up callback). */
const MIN_DELTA_MS = 1.5;
/** At or above this a delta is a gap: the tab was hidden or the main thread stalled. */
export const GAP_MS = 250;
/** Estimate after this many new samples. */
const ESTIMATE_EVERY_SAMPLES = 8;
/** A measured rate within this of a common rate is that rate. */
const SNAP_TOLERANCE = 0.02;
/** Two rates closer than this are the same rate (165 and 170 Hz are). */
const SAME_RATE_TOLERANCE = 0.035;
/**
 * A skip is clean when the tick came at least this many periods before the
 * render threshold of N - 0.5: within N - 0.75 periods of the last frame.
 * A stamp moved early by over half a refresh is skipped by a hair; one
 * moved early by more than 0.75 of a period starts a delta of 1.75 periods,
 * which `MAX_SKIP_SAMPLE_PERIODS` turns away. A frame that cost fewer
 * refreshes than N leaves its skip half a period short of the threshold, a
 * quarter period inside the margin.
 */
const CLEAN_SKIP_MARGIN = 0.25;
/**
 * A skipped tick's delta longer than this many adopted periods is no clean
 * sample: the skipped tick drew nothing, so the next tick comes one refresh
 * later unless the main thread stalled, or the stamp it starts from was
 * moved early by most of a period (at 144 Hz and up, Firefox's shifts
 * reach one). A display that slowed this much is found by a re-probe.
 */
const MAX_SKIP_SAMPLE_PERIODS = 1.5;
/** Clean samples this close to their median make the skips' period. */
const CLEAN_BAND = 0.12;
/**
 * A neighbour within this share of a delta of a whole multiple of it, on
 * both sides, makes a rendered delta quiet: a run of short deltas jitter
 * cannot fake, since consecutive deltas add up to whole periods.
 */
const QUIET_TOLERANCE = 0.15;
/** A delta further than this share of a period from a whole number of them is a stall. */
const STALL_TOLERANCE = 0.25;
/** Deltas longer than this many periods are stalls. */
const MAX_MULTIPLE = 8;
/** Passes of the multiple-aware mean. */
const REFINE_PASSES = 3;
/**
 * A quiet period below this share of the clean or held one is a faster
 * display, or frames of whole refreshes of one (see `fasterQuietPeriod`).
 */
const LOWER_WINS_RATIO = 0.9;
/**
 * Clean evidence this close to the adopted period confirms it rather than
 * proposing another rate. Clean skips are single deltas, so their mean
 * keeps a stamp's jitter (2% at 120 Hz with 1.5 ms of it); common rates
 * are 10% apart or the same rate.
 */
const CONFIRMS_TOLERANCE = 0.1;
/**
 * A rate this close to a common one seeds the grid fit with the common
 * period: the fit needs a seed within a few percent to place every tick,
 * and the true rate is almost always a common one.
 */
const SEED_SNAP_TOLERANCE = 0.08;
/** A grid fit further than this factor from its seed locked onto another multiple. */
const GRID_BASIN = 1.4;
/** A grid fit further than this from the period, or none, contradicts it. */
const CONTRADICTS_RATIO = 0.06;
/** Least-squares passes of the grid fit. */
const FIT_PASSES = 2;
/** A tick further than this share of a period from the line is misplaced: the fit leaves it out. */
const FIT_KEEP = 0.4;
/**
 * A probe-run delta past this many medians is a stall of whole periods. A
 * single period with 1.5 ms of jitter either side reaches 1.72 at 240 Hz.
 */
const STALL_PERIODS = 1.75;
/** The same in a run's median deltas, which jitter may bias by 8%. */
const MISSED_VSYNC_MEDIANS = 2.5;
/**
 * A probe run's grid fit this coherent wins over its ordinal line (see
 * `forcedRunPeriod`). Firefox's shifts leave most ticks on the grid, at
 * 0.8 and more; 1.5 ms of uniform jitter at 240 Hz leaves the true grid
 * 0.2 to 0.6 and a wrong one as much by chance.
 */
const CLEAR_GRID = 0.65;
/** The coherence below which the ticks hold no grid (see `gridFit`). */
const MIN_COHERENCE = 0.1;
/**
 * Clean skips of another rate move a held one only when every tick is
 * this much more coherent on the other rate's grid than on the held one.
 * Skips are a biased sample under heavy jitter (a skip close to the
 * margin keeps the earlier stamps); every tick together is not.
 */
const QUALITY_MARGIN = 0.15;
/**
 * A faster quiet period is the display's period or a whole multiple of it
 * (frames of that many refreshes): finer common grids up to this multiple
 * are weighed against it.
 */
const MAX_FINER_MULTIPLE = 3;
/**
 * Check skips one rate change may spend (see `tick`): twice the clean
 * samples a confirmation needs, so jitter that turns some away still
 * leaves enough.
 */
const CHECK_SKIPS = 2 * MIN_CLEAN_SAMPLES;
/** Drawn ticks between check skips: one frame in this many repeats. */
const CHECK_EVERY_TICKS = 3;
/** Consecutive estimates that must agree before the rate changes. */
const AGREEING_ESTIMATES = 3;
/**
 * Consecutive estimates whose grid fit must contradict the confirmed
 * period before the confirmation is withdrawn: 48 new deltas, so a
 * jittery window cannot do it alone.
 */
const CONTRADICTING_ESTIMATES = 6;
/** An estimate counts only when this share of the ring sits within its band. */
const MIN_BAND_SHARE = 0.5;
/** Ticks skipped to re-measure the display when the flight is paused. */
export const REPROBE_TICKS = 24;
/** The startup probe's lead before the renderer is created: this many ticks... */
export const IDLE_PROBE_LEAD_TICKS = 24;
/** ...or this long, whichever comes first. */
export const IDLE_PROBE_LEAD_MS = 300;

export const COMMON_REFRESH_RATES_HZ = [
  30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 360,
] as const;

/**
 * The bench's `estimateRefresh` rule (src/bench/stats.ts), so the two agree:
 * the mean of the deltas within [0.8, 1.25] of the 10th percentile (nearest
 * rank), which is the fastest cadence the loop sustains with misses and
 * stalls left out. Null with fewer than `minSamples` deltas.
 *
 * Leaves `scratch` holding the deltas sorted, followed by +Infinity, so the
 * caller can read the sorted values without sorting again. `scratch` must be
 * at least as long as `deltas`; neither is reallocated.
 */
export function estimatePeriodMs(
  deltas: Float64Array,
  count: number,
  scratch: Float64Array,
  minSamples = MIN_SAMPLES,
): number | null {
  if (count < minSamples) return null;
  for (let index = 0; index < scratch.length; index += 1) {
    scratch[index] = index < count ? deltas[index]! : Number.POSITIVE_INFINITY;
  }
  scratch.sort();
  const p10 = scratch[Math.max(0, Math.ceil(0.1 * count) - 1)]!;
  let sum = 0;
  let kept = 0;
  for (let index = 0; index < count; index += 1) {
    const value = scratch[index]!;
    if (value < p10 * 0.8 || value > p10 * 1.25) continue;
    sum += value;
    kept += 1;
  }
  return sum / kept;
}

/** The nearest common refresh rate within 2%; otherwise the measured rate. */
export function nominalHz(periodMs: number): number {
  return nominalHzWithin(periodMs, SNAP_TOLERANCE) ?? 1_000 / periodMs;
}

/** The nearest common refresh rate within `tolerance` of `periodMs`'s rate, or null. */
function nominalHzWithin(periodMs: number, tolerance: number): number | null {
  const hz = 1_000 / periodMs;
  let best: number | null = null;
  let bestOff = Number.POSITIVE_INFINITY;
  for (const rate of COMMON_REFRESH_RATES_HZ) {
    const off = Math.abs(hz - rate) / rate;
    if (off <= tolerance && off < bestOff) {
      best = rate;
      bestOff = off;
    }
  }
  return best;
}

/**
 * The owner's divisors on the nominal rate. The +0.05 only absorbs
 * measurement error on a rate that does not snap (117-119.9 Hz draws 2).
 * JavaScript rounds 2.5 up, so 75 Hz at the 30 setting draws every 3rd
 * refresh (25 fps) and 165 Hz every 6th (27.5).
 */
export function divisorFor(setting: FrameRateSetting, hz: number): number {
  if (setting === "display") return 1;
  if (setting === "60") return Math.max(1, Math.floor(hz / 60 + 0.05));
  return Math.max(1, Math.round(hz / 30));
}

/**
 * What the pacer actually does for a setting: "60" draws every refresh while
 * `pace60` is off, and every setting does where the browser cannot skip a
 * frame safely.
 */
export function effectiveFrameRate(
  setting: FrameRateSetting,
  pace60: boolean = FRAME_PACING_ENABLED,
  canSkipFrames = true,
): FrameRateSetting {
  if (!canSkipFrames) return "display";
  return setting === "60" && !pace60 ? "display" : setting;
}

export interface FramePacerOptions {
  /** Pace the "60 fps" setting. `FRAME_PACING_ENABLED` unless a test says otherwise. */
  readonly pace60?: boolean;
  /**
   * False where a tick that draws nothing may not keep the last frame on
   * screen; every setting then draws every refresh. A capability of the
   * browser, never a setting.
   */
  readonly canSkipFrames?: boolean;
}

/** One tick's answer. The pacer returns the same object every time. */
export interface FramePacerTick {
  render: boolean;
  /** The new cadence on the tick it changes; null on every other tick. */
  cadence: PresentationCadence | null;
  /**
   * True on the drawn tick that ends a re-probe's skipped ticks, or a check
   * skip (see `FramePacer.tick`): its delta is the pacer's own gap, up to
   * 24 refreshes, and no frame time.
   */
  afterReprobe: boolean;
}

function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_RATE_TOLERANCE * Math.min(a, b);
}

/** How far `periodMs`'s rate is from the nearest common rate, as a share of it. */
function commonRateOffset(periodMs: number): number {
  const hz = 1_000 / periodMs;
  let best = Number.POSITIVE_INFINITY;
  for (const rate of COMMON_REFRESH_RATES_HZ) best = Math.min(best, Math.abs(hz - rate) / rate);
  return best;
}

/** Whether `hz` is one of the common rates exactly, as `nominalHz` snaps. */
function isCommonRate(hz: number): boolean {
  for (const rate of COMMON_REFRESH_RATES_HZ) if (rate === hz) return true;
  return false;
}

/** Whether `neighbour` sits within `QUIET_TOLERANCE` of `delta` of a whole multiple of it. */
function onMultiple(neighbour: number, delta: number): boolean {
  const multiple = Math.round(neighbour / delta);
  return multiple >= 1 && Math.abs(neighbour - multiple * delta) <= QUIET_TOLERANCE * delta;
}

/*
 * Why the previous tick drew nothing, which says what the next delta measures.
 */
/** It drew: the next delta carries its frame's cost. */
const DREW = 0;
/** A probe or re-probe tick: nothing asked it to draw, so the next delta is the display's. */
const FORCED = 1;
/** The pacer skipped it with time to spare: the next delta is the display's too. */
const CLEAN_SKIP = 2;
/**
 * The pacer skipped it by a hair, its stamp may have decided that; or a
 * probe tick after the lead, on a busy main thread: the next delta is no sample.
 */
const CLOSE_SKIP = 3;
type IdleKind = typeof DREW | typeof FORCED | typeof CLEAN_SKIP | typeof CLOSE_SKIP;

export class FramePacer {
  private readonly pace60: boolean;
  private readonly canSkipFrames: boolean;
  /** Every tick's delta, in order. */
  private readonly all = new Float64Array(RING_SIZE);
  private allCount = 0;
  private allHead = 0;
  /** Deltas after clean skips in flight. */
  private readonly skips = new Float64Array(RING_SIZE);
  private skipCount = 0;
  private skipHead = 0;
  private readonly scratch = new Float64Array(RING_SIZE);
  private samplesSinceEstimate = 0;
  private lastTickMs: number | null = null;
  private lastRenderMs: number | null = null;
  private previousIdle: IdleKind = DREW;
  /** The newest deltas that each followed a probe or re-probe tick, in a row. */
  private forcedRun = 0;
  /** Probe ticks so far: only the first `IDLE_PROBE_LEAD_TICKS` are the quiet lead. */
  private probeTicks = 0;
  /** The period the last probe or re-probe run fits, or null: clean evidence that outlives the run. */
  private forcedPeriodMs: number | null = null;
  /** The adopted nominal rate; null until the first estimate. */
  private rateHz: number | null = null;
  private periodMs: number | null = null;
  private confirmed = false;
  /**
   * A rate has been confirmed once: from then on only clean evidence, or a
   * faster quiet period, moves it, and a withdrawn confirmation holds it.
   */
  private held = false;
  /** A different rate the estimates propose, and how many in a row have. */
  private candidateHz = 0;
  private candidateConfirmed = false;
  private candidateCount = 0;
  /** Every estimate behind the candidate came from a faster quiet period. */
  private candidateFaster = false;
  /** The coherence of the ticks on the last `gridFit`'s grid. */
  private fitQuality = 0;
  /** Consecutive estimates whose grid fit contradicts the period they confirm. */
  private contradictions = 0;
  /**
   * The newest ticks from the first of the last `fasterQuietPeriod`'s fast
   * deltas: the ticks of the faster display, without those of the slower
   * one before it, whose grid's phase is unrelated.
   */
  private fastTicks = 0;
  /** The last `fasterPeriod` found a finer common grid the ticks cannot rule out. */
  private finerPossible = false;
  /** The setting the last tick paced for: whether a rate can test itself. */
  private effective: FrameRateSetting = "display";
  /** Check skips left to spend, and drawn ticks until the next one. */
  private checkSkipsLeft = 0;
  private checkBudget = CHECK_SKIPS;
  private checkCountdown = 0;
  private divisor = 1;
  private cadence: PresentationCadence | null = null;
  private wasPaused = false;
  private reprobeTicksLeft = 0;
  /** A re-probe or a check skipped ticks since the last drawn one. */
  private reprobeSkipped = false;
  private readonly out: FramePacerTick = { render: true, cadence: null, afterReprobe: false };

  constructor(options: FramePacerOptions = {}) {
    this.pace60 = options.pace60 ?? FRAME_PACING_ENABLED;
    this.canSkipFrames = options.canSkipFrames ?? true;
  }

  /** The cadence as last emitted; null before the period is measured. */
  get currentCadence(): PresentationCadence | null {
    return this.cadence;
  }

  /** Whether this setting can draw less than every refresh here. */
  paces(setting: FrameRateSetting): boolean {
    return effectiveFrameRate(setting, this.pace60, this.canSkipFrames) !== "display";
  }

  /**
   * A startup tick that draws nothing, so its delta measures the display.
   * Only the lead's are clean: after it the renderer is created, and a busy
   * main thread misses vsyncs at random, which no fit of 64 deltas can
   * always tell from a slower display.
   */
  probe(nowMs: number): void {
    this.record(nowMs);
    this.probeTicks += 1;
    this.previousIdle = this.probeTicks <= IDLE_PROBE_LEAD_TICKS ? FORCED : CLOSE_SKIP;
    if (this.samplesSinceEstimate >= ESTIMATE_EVERY_SAMPLES) this.estimate();
  }

  /**
   * One requestAnimationFrame tick. `paused` is true while the flight is
   * paused: on the first paused tick the pacer skips `REPROBE_TICKS` ticks
   * of the static scene to measure the display again.
   */
  tick(nowMs: number, setting: FrameRateSetting, paused = false): FramePacerTick {
    const effective = effectiveFrameRate(setting, this.pace60, this.canSkipFrames);
    if (paused && !this.wasPaused && effective !== "display") this.startReprobe();
    if (!paused || effective === "display") this.reprobeTicksLeft = 0;
    this.wasPaused = paused;
    this.effective = effective;
    this.record(nowMs);
    if (this.samplesSinceEstimate >= ESTIMATE_EVERY_SAMPLES) this.estimate();
    this.out.cadence = this.updateCadence(effective);
    let idle: IdleKind = DREW;
    if (this.reprobeTicksLeft > 0) {
      this.reprobeTicksLeft -= 1;
      this.reprobeSkipped = true;
      idle = FORCED;
    } else {
      const period = this.periodMs;
      if (period !== null && this.divisor > 1 && this.lastRenderMs !== null) {
        const elapsed = nowMs - this.lastRenderMs;
        if (elapsed < (this.divisor - 0.5) * period) {
          idle = elapsed <= (this.divisor - 0.5 - CLEAN_SKIP_MARGIN) * period ? CLEAN_SKIP : CLOSE_SKIP;
        }
      }
      if (idle === DREW && this.checkSkipsLeft > 0 && this.previousIdle === DREW && effective !== "display") {
        // A check skip: the tick after one that drew draws nothing, so the
        // next delta is one refresh (see `estimate`). Its frame repeats once.
        // Never at Match display, which draws every refresh: a setting
        // changed in the middle of a check keeps the rest for later.
        this.checkCountdown -= 1;
        if (this.checkCountdown <= 0) {
          this.checkCountdown = CHECK_EVERY_TICKS;
          this.checkSkipsLeft -= 1;
          this.reprobeSkipped = true;
          idle = CLEAN_SKIP;
        }
      }
    }
    const render = idle === DREW;
    this.out.afterReprobe = render && this.reprobeSkipped;
    if (render) {
      this.lastRenderMs = nowMs;
      this.reprobeSkipped = false;
    }
    this.previousIdle = idle;
    this.out.render = render;
    return this.out;
  }

  /**
   * Forget the timing (a hidden tab, a gap): the next tick draws. The adopted
   * period, its confirmation and the last cadence are kept, and so is the
   * last probe run's period, which is what confirmed it.
   */
  reset(): void {
    this.allCount = 0;
    this.allHead = 0;
    this.skipCount = 0;
    this.skipHead = 0;
    this.forcedRun = 0;
    this.samplesSinceEstimate = 0;
    this.lastTickMs = null;
    this.lastRenderMs = null;
    this.previousIdle = DREW;
    this.candidateCount = 0;
    this.contradictions = 0;
  }

  private startReprobe(): void {
    // A fresh measurement: skips from before the pause would outvote it.
    this.skipCount = 0;
    this.skipHead = 0;
    this.reprobeTicksLeft = REPROBE_TICKS;
    // The re-probe measures what a check would have.
    this.checkSkipsLeft = 0;
    this.checkBudget = CHECK_SKIPS;
  }

  /** Clean evidence turned out stale: only new evidence may confirm again. */
  private forgetCleanEvidence(): void {
    this.skipCount = 0;
    this.skipHead = 0;
    this.forcedPeriodMs = null;
  }

  private record(nowMs: number): void {
    const last = this.lastTickMs;
    this.lastTickMs = nowMs;
    if (last === null) return;
    const delta = nowMs - last;
    if (!(delta < GAP_MS)) {
      this.reset();
      this.lastTickMs = nowMs;
      return;
    }
    if (delta < MIN_DELTA_MS && this.previousIdle !== FORCED) {
      // A second callback for one vsync, after a long frame. Probe and
      // re-probe ticks draw nothing, so none follows them: a short delta
      // there is a jittered stamp (1.5 ms either way of a 240 Hz period
      // reaches 1.2 ms), and the run's fit needs every stamp.
      return;
    }
    this.all[this.allHead] = delta;
    this.allHead = (this.allHead + 1) % RING_SIZE;
    this.allCount = Math.min(RING_SIZE, this.allCount + 1);
    this.forcedRun = this.previousIdle === FORCED ? this.forcedRun + 1 : 0;
    if (
      this.previousIdle === CLEAN_SKIP
      && (this.periodMs === null || delta < MAX_SKIP_SAMPLE_PERIODS * this.periodMs)
    ) {
      this.skips[this.skipHead] = delta;
      this.skipHead = (this.skipHead + 1) % RING_SIZE;
      this.skipCount = Math.min(RING_SIZE, this.skipCount + 1);
    }
    this.samplesSinceEstimate += 1;
  }

  /**
   * A ring's period in ms, or null. The bench's estimate finds the fastest
   * cadence, but timestamp jitter biases it low; the median does not, when
   * it sits in that cadence's cluster, so it seeds the refinement instead.
   * Jitter biases the bench's estimate low, never high, so a refined period
   * well below it has locked onto half the period, and is no reading.
   */
  private measure(ring: Float64Array, count: number, minSamples: number): number | null {
    const first = estimatePeriodMs(ring, count, this.scratch, minSamples);
    if (first === null) return null;
    const median = this.scratch[Math.max(0, Math.ceil(0.5 * count) - 1)]!;
    const period = this.refine(ring, count, median < first * 1.75 ? median : first);
    return period !== null && period >= 0.85 * first ? period : null;
  }

  /**
   * Each delta is read as its nearest whole number of periods, and the
   * period is the deltas' total over their total count of periods, three
   * times over. Half the ring must sit within a quarter period of a whole
   * number of them, or the ring is not paced by a display (a stall, a
   * variable-rate panel) and says nothing.
   */
  private refine(ring: Float64Array, count: number, unitMs: number): number | null {
    let period = unitMs;
    let onCadence = 0;
    for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
      let sum = 0;
      let periods = 0;
      onCadence = 0;
      for (let index = 0; index < count; index += 1) {
        const delta = ring[index]!;
        const multiple = Math.max(1, Math.round(delta / period));
        if (multiple > MAX_MULTIPLE) continue;
        sum += delta;
        periods += multiple;
        if (Math.abs(delta - multiple * period) <= STALL_TOLERANCE * period) onCadence += 1;
      }
      if (periods === 0) return null;
      period = sum / periods;
    }
    return onCadence >= MIN_BAND_SHARE * count ? period : null;
  }

  /**
   * The period of the grid the newest `count` ticks of the all ring sit on,
   * seeded with `unitMs`, or null when the ticks hold no such grid:
   * `fitQuality`, their coherence (the mean cosine of each tick's offset
   * from the grid, as a phase), is under `MIN_COHERENCE`. The grid's phase
   * is the ticks' circular mean on the seed's period, so no single stamp
   * anchors it; each tick is placed on the nearest whole number of periods
   * along the line, and the least-squares line through the placed ticks is
   * fitted twice over. The ticks are consecutive, so the slope is the time
   * between the window's ends over its periods: jitter cancels instead of
   * averaging, a frame's cost is only a longer step, and a stamp shifted
   * past half a period misplaces itself and no other tick. The slope stays
   * near the seed, so the coherence says whether the ticks sit on the
   * seed's grid: 1 on it, about 0 on any other, 0.34 on it with 1.5 ms of
   * uniform jitter at 240 Hz. A grid of half the period holds every tick
   * of the period's grid too; the callers seed within a period's basin.
   */
  private gridFit(unitMs: number, count: number): number | null {
    this.fitQuality = 0;
    if (count < MIN_CLEAN_SAMPLES) return null;
    const ring = this.all;
    const start = (this.allHead - count + RING_SIZE) % RING_SIZE;
    // The phase: tick times are measured from the window's first tick.
    let sine = 0;
    let cosine = 1;
    let time = 0;
    for (let index = 0; index < count; index += 1) {
      time += ring[(start + index) % RING_SIZE]!;
      const angle = (2 * Math.PI * time) / unitMs;
      sine += Math.sin(angle);
      cosine += Math.cos(angle);
    }
    let slope = unitMs;
    let intercept = (Math.atan2(sine, cosine) / (2 * Math.PI)) * unitMs;
    for (let pass = 0; pass < FIT_PASSES; pass += 1) {
      let points = 0;
      let sumN = 0;
      let sumT = 0;
      let sumNN = 0;
      let sumNT = 0;
      time = 0;
      for (let index = -1; index < count; index += 1) {
        if (index >= 0) time += ring[(start + index) % RING_SIZE]!;
        const periods = Math.round((time - intercept) / slope);
        if (Math.abs(time - intercept - periods * slope) > FIT_KEEP * slope) continue;
        points += 1;
        sumN += periods;
        sumT += time;
        sumNN += periods * periods;
        sumNT += periods * time;
      }
      const determinant = points * sumNN - sumN * sumN;
      if (points < MIN_CLEAN_SAMPLES || !(determinant > 0)) return null;
      slope = (points * sumNT - sumN * sumT) / determinant;
      intercept = (sumT - slope * sumN) / points;
      if (!(slope > 0)) return null;
    }
    let coherence = 0;
    time = 0;
    for (let index = -1; index < count; index += 1) {
      if (index >= 0) time += ring[(start + index) % RING_SIZE]!;
      coherence += Math.cos((2 * Math.PI * (time - intercept)) / slope);
    }
    this.fitQuality = coherence / (count + 1);
    return this.fitQuality >= MIN_COHERENCE ? slope : null;
  }

  /**
   * The newest probe or re-probe run's period, or null: the grid fit over
   * the run, or its ordinal line where the ticks hold no clear grid.
   *
   * The run's ticks are consecutive idle ticks, so their order places
   * them: the ordinal line is the least-squares line through the tick
   * times with each one period after the last, or the nearest whole number
   * of periods after a delta past `STALL_PERIODS` of them (a missed vsync).
   * Jitter cancels along it: 1.5 ms either way of a 240 Hz period moves its
   * slope by under 1%, where the grid holds so few ticks (coherence 0.2 to
   * 0.35) that a grid 8% off can hold as many in 24. The grid fit, seeded
   * with the line or the median, wins where it holds the ticks clearly: a
   * stamp Firefox moved early by most of a period, next to a missed vsync,
   * misleads the order but not the grid.
   */
  private forcedRunPeriod(): number | null {
    const count = Math.min(this.forcedRun, this.allCount);
    if (count < MIN_CLEAN_SAMPLES) return null;
    const ring = this.all;
    const scratch = this.scratch;
    const start = (this.allHead - count + RING_SIZE) % RING_SIZE;
    for (let index = 0; index < RING_SIZE; index += 1) {
      scratch[index] = index < count ? ring[(start + index) % RING_SIZE]! : Number.POSITIVE_INFINITY;
    }
    scratch.sort();
    const median = scratch[Math.ceil(0.5 * count) - 1]!;
    // The first pass counts periods in medians, the second in the first
    // pass's slope: the median of 24 jittered deltas may be 8% off.
    let line: number | null = median;
    let stall = MISSED_VSYNC_MEDIANS;
    for (let pass = 0; pass < 2 && line !== null; pass += 1) {
      let sumN = 0;
      let sumT = 0;
      let sumNN = 0;
      let sumNT = 0;
      let time = 0;
      let periods = 0;
      for (let index = 0; index < count; index += 1) {
        const delta = ring[(start + index) % RING_SIZE]!;
        time += delta;
        periods += delta > stall * line ? Math.round(delta / line) : 1;
        sumN += periods;
        sumT += time;
        sumNN += periods * periods;
        sumNT += periods * time;
      }
      // The run's first tick is the origin: (0, 0) adds nothing to the sums.
      const determinant = (count + 1) * sumNN - sumN * sumN;
      const slope = ((count + 1) * sumNT - sumN * sumT) / determinant;
      line = determinant > 0 && slope > 0 ? slope : null;
      stall = STALL_PERIODS;
    }
    const fromMedian = this.gridPeriod(median, count);
    let quality = this.fitQuality;
    let grid = fromMedian;
    if (line !== null) {
      const fromLine = this.gridPeriod(line, count);
      if (fromLine !== null && (grid === null || this.fitQuality > quality)) {
        grid = fromLine;
        quality = this.fitQuality;
      }
    }
    if (grid === null || line === null || quality >= CLEAR_GRID) return grid ?? line;
    // A grid that holds the ticks only loosely wins only where it is nearer
    // a common rate than a line that snaps to none, since the display
    // almost always runs at one.
    const lineOffset = commonRateOffset(line);
    return lineOffset > SNAP_TOLERANCE && commonRateOffset(grid) < lineOffset ? grid : line;
  }

  /**
   * The mean of the sorted `scratch` values within `CLEAN_BAND` of
   * `centreMs`, when at least half of `count` are; otherwise null.
   */
  private bandMean(count: number, centreMs: number): number | null {
    let sum = 0;
    let kept = 0;
    for (let index = 0; index < count; index += 1) {
      const value = this.scratch[index]!;
      if (Math.abs(value - centreMs) > CLEAN_BAND * centreMs) continue;
      sum += value;
      kept += 1;
    }
    return kept >= MIN_BAND_SHARE * count ? sum / kept : null;
  }

  /**
   * The clean skips' period: the mean of those within `CLEAN_BAND` of their
   * median, when at least half are, or else the median. A clean skip's
   * delta is one period but for a stall or a stamp's jitter; the deltas are
   * not consecutive, so jitter does not cancel in the mean, and the grid
   * fit sharpens it. Firefox's shifts leave most deltas exact and a few far
   * out, which the band drops; 1.5 ms of jitter either way of a 240 Hz
   * period spreads them all wider than any band, around the period still.
   */
  private skipPeriod(): number | null {
    const count = this.skipCount;
    if (count < MIN_CLEAN_SAMPLES) return null;
    const scratch = this.scratch;
    for (let index = 0; index < RING_SIZE; index += 1) {
      scratch[index] = index < count ? this.skips[index]! : Number.POSITIVE_INFINITY;
    }
    scratch.sort();
    const median = scratch[Math.ceil(0.5 * count) - 1]!;
    return this.bandMean(count, median) ?? median;
  }

  /**
   * A faster period than `referenceMs` on quiet deltas (both neighbours on
   * whole multiples), drawn or not, or null: their median, when at least
   * `MIN_CLEAN_SAMPLES` of them and half of all quiet ones are below
   * `LOWER_WINS_RATIO` of the reference. Jitter cannot make consecutive
   * deltas short together, since they add up to whole periods.
   */
  private fasterQuietPeriod(referenceMs: number): number | null {
    const count = this.allCount;
    const ring = this.all;
    const scratch = this.scratch;
    const start = (this.allHead - count + RING_SIZE) % RING_SIZE;
    const below = LOWER_WINS_RATIO * referenceMs;
    let quiet = 0;
    let fast = 0;
    this.fastTicks = 0;
    for (let index = 1; index < count - 1; index += 1) {
      const delta = ring[(start + index) % RING_SIZE]!;
      if (
        !onMultiple(ring[(start + index - 1) % RING_SIZE]!, delta)
        || !onMultiple(ring[(start + index + 1) % RING_SIZE]!, delta)
      ) continue;
      quiet += 1;
      if (delta < below) {
        if (fast === 0) this.fastTicks = count - index + 1;
        scratch[fast] = delta;
        fast += 1;
      }
    }
    if (fast < MIN_CLEAN_SAMPLES || fast < MIN_BAND_SHARE * quiet) return null;
    for (let index = fast; index < RING_SIZE; index += 1) scratch[index] = Number.POSITIVE_INFINITY;
    scratch.sort();
    return scratch[Math.ceil(0.5 * fast) - 1]!;
  }

  /**
   * The period of the grid the newest `count` ticks sit on near `seedMs`:
   * the grid fit seeded with the nearest common period within
   * `SEED_SNAP_TOLERANCE` (or `seedMs` itself), or null when none fits or
   * the fit left the seed's basin (`GRID_BASIN` either way: it locked onto
   * half or twice the period). The seed only says which multiple of the
   * grid to look for; the ticks, consecutive, say where it is exactly, so
   * a seed that skips or a probe biased by a few percent still lands on
   * the display's rate.
   */
  private gridPeriod(seedMs: number, count: number): number | null {
    const common = nominalHzWithin(seedMs, SEED_SNAP_TOLERANCE);
    const fit = this.gridFit(common === null ? seedMs : 1_000 / common, count);
    if (fit === null || !(fit > seedMs / GRID_BASIN && fit < seedMs * GRID_BASIN)) return null;
    return fit;
  }

  /**
   * The period a faster quiet period `quickMs` stands for: its own grid's,
   * or a finer common grid's (a whole fraction of it) that holds clearly
   * more of the ticks, as frames of two refreshes and one together do.
   * Sets `finerPossible` when a finer common grid does not, since it holds
   * every tick of the coarse grid too: frames that each take two refreshes
   * of 144 Hz look exactly like a 72 Hz display.
   */
  private fasterPeriod(quickMs: number): number {
    const count = Math.min(this.allCount, Math.max(MIN_SAMPLES, this.fastTicks));
    const coarse = this.gridPeriod(quickMs, count) ?? quickMs;
    const coarseQuality = this.fitQuality;
    this.finerPossible = false;
    for (let multiple = 2; multiple <= MAX_FINER_MULTIPLE; multiple += 1) {
      const hz = nominalHzWithin(coarse / multiple, SNAP_TOLERANCE);
      if (hz === null) continue;
      const fine = this.gridPeriod(1_000 / hz, count);
      if (fine !== null && this.fitQuality >= coarseQuality + QUALITY_MARGIN) return fine;
      this.finerPossible = true;
    }
    return coarse;
  }

  private estimate(): void {
    this.samplesSinceEstimate = 0;
    const run = this.forcedRunPeriod();
    if (run !== null) this.forcedPeriodMs = run;
    // Skips in flight are newer than the last probe run, so they win.
    const skips = this.skipPeriod();
    const clean = skips ?? this.forcedPeriodMs;
    const adopted = this.periodMs;
    // Once a rate was confirmed, the held period is the reference even when
    // its confirmation was withdrawn: only clean evidence moves it.
    const reference = clean ?? (this.held ? adopted : null);
    let period: number | null;
    let confirmed: boolean;
    let faster = false;
    let contradicted = false;
    if (reference !== null) {
      const quick = this.fasterQuietPeriod(reference);
      if (quick !== null) {
        // An interval cut short by an early stamp can beat the display, but
        // no run of quiet ones can: a faster quiet period wins, confirmed
        // unless a finer grid may be the display's. The pacer's
        // own skips then test the rate it reads: drawing every Nth refresh
        // of a finer display skips a tick N - 1 refreshes early.
        period = this.fasterPeriod(quick);
        confirmed = !this.finerPossible;
        faster = true;
        if (
          this.finerPossible
          && this.effective !== "display"
          && divisorFor(this.effective, nominalHz(period)) === 1
        ) {
          // A rate drawn on every tick never skips one, so nothing would
          // test it: hold the rate (the ticks only prove it too slow, and
          // drawing every tick is what any rate the ticks allow would do),
          // withdraw its confirmation, and skip a tick now and then to
          // measure the display. The probe's period is stale.
          this.forcedPeriodMs = null;
          this.confirmed = false;
          this.candidateCount = 0;
          this.contradictions = 0;
          if (this.checkSkipsLeft === 0 && this.checkBudget > 0) {
            this.checkSkipsLeft = this.checkBudget;
            this.checkBudget = 0;
            this.checkCountdown = 1;
          }
          if (this.checkSkipsLeft > 0) return;
          // The checks are spent and settled nothing: read the ticks.
        }
      } else if (adopted === null) {
        // The first rate: the clean one, as every tick places it.
        period = this.gridPeriod(clean!, this.allCount) ?? clean;
        confirmed = true;
      } else if (clean !== null && Math.abs(clean - adopted) > CONFIRMS_TOLERANCE * adopted) {
        // Clean evidence of another rate: every tick says which rate near
        // it the display runs at, and it must hold clearly more of them
        // than the adopted rate does, or the clean evidence was a biased
        // few and the rate stays.
        if (skips === null) {
          // A probe or re-probe run: consecutive idle ticks, a fit already.
          period = clean;
        } else {
          const other = this.gridPeriod(clean, this.allCount);
          const otherQuality = this.fitQuality;
          this.gridFit(adopted, this.allCount);
          period = other !== null && otherQuality >= this.fitQuality + QUALITY_MARGIN ? other : null;
        }
        confirmed = true;
      } else {
        // Clean evidence of the adopted rate, or none since the rate was
        // held: every tick may snap the adopted rate to a common one, never
        // move it, and a grid that keeps disagreeing contradicts it.
        const fit = this.gridFit(adopted, this.allCount);
        const fitQuality = this.fitQuality;
        period = adopted;
        if (!isCommonRate(this.rateHz!)) {
          // An unsnapped rate (a first reading) gives way to the nearest
          // common one whose grid every tick holds as well.
          const common = nominalHzWithin(clean ?? adopted, SEED_SNAP_TOLERANCE);
          if (common !== null && this.gridFit(1_000 / common, this.allCount) !== null
            && this.fitQuality >= fitQuality - QUALITY_MARGIN / 3) period = 1_000 / common;
        } else if (clean !== null && nominalHzWithin(clean, SEED_SNAP_TOLERANCE) !== this.rateHz) {
          // A common rate as close to the clean one as 170 is to 165 Hz
          // gives way, by agreement, to the clean one where every tick sits
          // clearly more on its grid. A grid seeded 3% off slides two
          // periods along 64 ticks, so the adopted rate's own fit cannot.
          const near = this.gridPeriod(clean, this.allCount);
          if (near !== null && this.fitQuality >= fitQuality + QUALITY_MARGIN && isCommonRate(nominalHz(near))) {
            period = near;
          }
        }
        confirmed = clean !== null || this.confirmed;
        contradicted = this.allCount >= MIN_SAMPLES
          && (fit === null || Math.abs(fit - adopted) > CONTRADICTS_RATIO * adopted);
      }
    } else {
      // Nothing clean yet: the rendered ticks give a first, unconfirmed rate.
      const observed = this.measure(this.all, this.allCount, MIN_SAMPLES);
      period = observed === null ? null : this.gridPeriod(observed, this.allCount) ?? observed;
      confirmed = false;
    }
    this.contradictions = contradicted ? this.contradictions + 1 : 0;
    if (this.contradictions >= CONTRADICTING_ESTIMATES && this.confirmed) {
      // Every tick keeps showing another grid: the clean evidence is stale
      // (the display changed under a load that hides it) or was wrong. Hold
      // the rate, withdraw the confirmation, and wait for fresh evidence.
      this.contradictions = 0;
      this.forgetCleanEvidence();
      this.confirmed = false;
      this.candidateCount = 0;
      return;
    }
    if (period === null) return;
    const measured = nominalHz(period);
    // A snapped rate is exact: an unsnapped reading of the same rate never
    // replaces it, but a snapped one replaces an unsnapped first reading at
    // once, and another snapped one (165 for 170 Hz) by agreement.
    const snapped = this.rateHz !== null && isCommonRate(this.rateHz);
    const hz = this.rateHz !== null && sameRate(measured, this.rateHz) && snapped && !isCommonRate(measured)
      ? this.rateHz
      : measured;
    // The first rate, and a confirmation of the rate already adopted, apply
    // at once: neither can flip back. Any other change waits for agreement.
    if (
      this.rateHz === null
      || (sameRate(hz, this.rateHz) && confirmed && !this.confirmed)
      || (sameRate(hz, this.rateHz) && confirmed === this.confirmed && hz !== this.rateHz && isCommonRate(hz) && !snapped)
    ) {
      this.adopt(hz, confirmed, faster);
      return;
    }
    if (sameRate(hz, this.rateHz) && confirmed === this.confirmed && (hz === this.rateHz || !snapped)) {
      this.candidateCount = 0;
      return;
    }
    if (this.candidateCount > 0 && sameRate(hz, this.candidateHz) && confirmed === this.candidateConfirmed) {
      this.candidateCount += 1;
      this.candidateFaster = this.candidateFaster && faster;
    } else {
      this.candidateHz = hz;
      this.candidateConfirmed = confirmed;
      this.candidateCount = 1;
      this.candidateFaster = faster;
    }
    if (this.candidateCount >= AGREEING_ESTIMATES) this.adopt(hz, confirmed, this.candidateFaster);
  }

  private adopt(hz: number, confirmed: boolean, faster: boolean): void {
    this.rateHz = hz;
    this.periodMs = 1_000 / hz;
    this.confirmed = confirmed;
    if (confirmed) this.held = true;
    // A faster period replaced a slower one: the evidence for it is stale.
    if (faster) this.forgetCleanEvidence();
    this.candidateCount = 0;
    this.contradictions = 0;
    this.checkSkipsLeft = 0;
    this.checkBudget = CHECK_SKIPS;
  }

  private updateCadence(effective: FrameRateSetting): PresentationCadence | null {
    if (this.rateHz === null) return null;
    const frameCapHz = effective === "60" ? 60 : effective === "30" ? 30 : null;
    const divisor = divisorFor(effective, this.rateHz);
    this.divisor = divisor;
    const current = this.cadence;
    if (
      current !== null
      && current.frameCapHz === frameCapHz
      && current.divisor === divisor
      && current.displayPeriodMs === this.periodMs
      && current.periodConfirmed === this.confirmed
    ) return null;
    this.cadence = Object.freeze({
      frameCapHz,
      divisor,
      displayPeriodMs: this.periodMs,
      periodConfirmed: this.confirmed,
    });
    return this.cadence;
  }
}

/** The browser functions the startup probe runs on; tests pass their own. */
export interface IdleProbeHost {
  requestAnimationFrame(callback: (nowMs: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdleProbe {
  /**
   * Settles after `IDLE_PROBE_LEAD_TICKS` probe ticks or `IDLE_PROBE_LEAD_MS`,
   * whichever comes first, or when the probe stops. It never rejects.
   */
  readonly lead: Promise<void>;
  /** Stops probing. Safe to call more than once. */
  stop(): void;
}

function browserHost(): IdleProbeHost {
  return {
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * The startup idle probe: a rAF loop that draws nothing and hands every
 * tick to `pacer.probe`, so the period can be confirmed before the first
 * frame. It runs while the renderer is created, where a player waits anyway,
 * and starts a short lead before that, while the main thread is still quiet.
 */
export function startIdleProbe(pacer: FramePacer, host: IdleProbeHost = browserHost()): IdleProbe {
  let handle: number | null = null;
  let ticks = 0;
  let settle: () => void = () => undefined;
  const lead = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const timer = host.setTimeout(() => settle(), IDLE_PROBE_LEAD_MS);
  const step = (nowMs: number): void => {
    pacer.probe(nowMs);
    ticks += 1;
    if (ticks >= IDLE_PROBE_LEAD_TICKS) settle();
    handle = host.requestAnimationFrame(step);
  };
  handle = host.requestAnimationFrame(step);
  return {
    lead,
    stop: () => {
      if (handle !== null) host.cancelAnimationFrame(handle);
      handle = null;
      host.clearTimeout(timer);
      settle();
    },
  };
}
