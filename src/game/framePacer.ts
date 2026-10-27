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
 * The display period is measured from the ticks themselves. Only ticks that
 * drew nothing (the startup probe, a re-probe while paused, ticks the pacer
 * skipped) can confirm it, because their deltas cannot be stretched by
 * render cost: a slow machine never relaxes its own target. A faster period
 * seen on rendered ticks always wins, because intervals cannot beat the
 * display; a slower one never replaces a confirmed period.
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
/** Idle-ring samples before an estimate can confirm the period. */
const MIN_CONFIRM_SAMPLES = 16;
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
 * An observed period this close to the idle one is confirmed by it. Idle
 * deltas are not consecutive, so jitter does not cancel in their mean as it
 * does in the all ring's; display multiples are 100% apart.
 */
const CONFIRMS_TOLERANCE = 0.1;
/** A delta further than this share of a period from a whole number of them is a stall. */
const STALL_TOLERANCE = 0.25;
/** Deltas longer than this many periods are stalls. */
const MAX_MULTIPLE = 8;
/** Passes of the multiple-aware mean. */
const REFINE_PASSES = 3;
/** An observed period below this share of the confirmed one replaces it. */
const LOWER_WINS_RATIO = 0.9;
/** Consecutive estimates that must agree before the rate changes. */
const AGREEING_ESTIMATES = 3;
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
  const hz = 1_000 / periodMs;
  let best: number | null = null;
  let bestOff = Number.POSITIVE_INFINITY;
  for (const rate of COMMON_REFRESH_RATES_HZ) {
    const off = Math.abs(hz - rate) / rate;
    if (off <= SNAP_TOLERANCE && off < bestOff) {
      best = rate;
      bestOff = off;
    }
  }
  return best ?? hz;
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
   * True on the drawn tick that ends a re-probe's skipped ticks: its delta
   * is the pacer's own gap, up to 24 refreshes, and no frame time.
   */
  afterReprobe: boolean;
}

function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_RATE_TOLERANCE * Math.min(a, b);
}

export class FramePacer {
  private readonly pace60: boolean;
  private readonly canSkipFrames: boolean;
  /** Every tick's delta. */
  private readonly all = new Float64Array(RING_SIZE);
  private allCount = 0;
  private allHead = 0;
  /** Deltas whose previous tick drew nothing. */
  private readonly idle = new Float64Array(RING_SIZE);
  private idleCount = 0;
  private idleHead = 0;
  private readonly scratch = new Float64Array(RING_SIZE);
  private samplesSinceEstimate = 0;
  private lastTickMs: number | null = null;
  private lastRenderMs: number | null = null;
  private previousTickWasIdle = false;
  /** The adopted nominal rate; null until the first estimate. */
  private rateHz: number | null = null;
  private periodMs: number | null = null;
  private confirmed = false;
  /** A different rate the estimates propose, and how many in a row have. */
  private candidateHz = 0;
  private candidateConfirmed = false;
  private candidateCount = 0;
  private divisor = 1;
  private cadence: PresentationCadence | null = null;
  private wasPaused = false;
  private reprobeTicksLeft = 0;
  /** A re-probe skipped ticks since the last drawn one. */
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

  /** A startup tick that draws nothing, so its delta measures the display. */
  probe(nowMs: number): void {
    this.record(nowMs);
    this.previousTickWasIdle = true;
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
    this.record(nowMs);
    if (this.samplesSinceEstimate >= ESTIMATE_EVERY_SAMPLES) this.estimate();
    this.out.cadence = this.updateCadence(effective);
    let render: boolean;
    if (this.reprobeTicksLeft > 0) {
      this.reprobeTicksLeft -= 1;
      this.reprobeSkipped = true;
      render = false;
    } else {
      const period = this.periodMs;
      render = period === null
        || this.divisor <= 1
        || this.lastRenderMs === null
        || nowMs - this.lastRenderMs >= (this.divisor - 0.5) * period;
    }
    this.out.afterReprobe = render && this.reprobeSkipped;
    if (render) {
      this.lastRenderMs = nowMs;
      this.reprobeSkipped = false;
    }
    this.previousTickWasIdle = !render;
    this.out.render = render;
    return this.out;
  }

  /**
   * Forget the timing (a hidden tab, a gap): the next tick draws. The adopted
   * period, its confirmation and the last cadence are kept.
   */
  reset(): void {
    this.allCount = 0;
    this.allHead = 0;
    this.idleCount = 0;
    this.idleHead = 0;
    this.samplesSinceEstimate = 0;
    this.lastTickMs = null;
    this.lastRenderMs = null;
    this.previousTickWasIdle = false;
    this.candidateCount = 0;
  }

  private startReprobe(): void {
    // A fresh measurement: old idle deltas would outvote it.
    this.idleCount = 0;
    this.idleHead = 0;
    this.reprobeTicksLeft = REPROBE_TICKS;
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
    if (delta < MIN_DELTA_MS) return;
    this.all[this.allHead] = delta;
    this.allHead = (this.allHead + 1) % RING_SIZE;
    this.allCount = Math.min(RING_SIZE, this.allCount + 1);
    if (this.previousTickWasIdle) {
      this.idle[this.idleHead] = delta;
      this.idleHead = (this.idleHead + 1) % RING_SIZE;
      this.idleCount = Math.min(RING_SIZE, this.idleCount + 1);
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
   * times over. On the all ring, whose deltas are consecutive, the total is
   * the time between the ring's ends, so jitter cancels out; leaving a
   * delta out would break that, so none is. Half the ring must sit within a
   * quarter period of a whole number of them, or the ring is not paced by a
   * display (a stall, a variable-rate panel) and says nothing.
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

  private estimate(): void {
    this.samplesSinceEstimate = 0;
    const idle = this.measure(this.idle, this.idleCount, MIN_CONFIRM_SAMPLES);
    const observed = this.measure(this.all, this.allCount, MIN_SAMPLES);
    const known = idle ?? (this.confirmed ? this.periodMs : null);
    let period: number | null;
    let confirmed: boolean;
    if (known !== null) {
      confirmed = true;
      if (observed !== null && observed < LOWER_WINS_RATIO * known) {
        // Intervals cannot beat the display: a faster observed period wins.
        period = observed;
      } else if (observed !== null && Math.abs(observed - known) <= CONFIRMS_TOLERANCE * known) {
        // The idle ticks confirm what the rendered ones measured more precisely.
        period = observed;
      } else {
        // Rendered ticks run slower than the display: they may sharpen the
        // confirmed period as multiples of it, never replace it.
        const sharpened = this.refine(this.all, this.allCount, known);
        period = sharpened !== null && Math.abs(sharpened - known) <= CONFIRMS_TOLERANCE * known
          ? sharpened
          : known;
      }
    } else {
      period = observed;
      confirmed = false;
    }
    if (period === null) return;
    const hz = nominalHz(period);
    if (hz === null) return;
    // The first rate, and a confirmation of the rate already adopted, apply
    // at once: neither can flip back. Any other change waits for agreement.
    if (this.rateHz === null || (confirmed && !this.confirmed && sameRate(hz, this.rateHz))) {
      this.adopt(hz, confirmed);
      return;
    }
    if (sameRate(hz, this.rateHz) && confirmed === this.confirmed) {
      this.candidateCount = 0;
      return;
    }
    if (this.candidateCount > 0 && sameRate(hz, this.candidateHz) && confirmed === this.candidateConfirmed) {
      this.candidateCount += 1;
    } else {
      this.candidateHz = hz;
      this.candidateConfirmed = confirmed;
      this.candidateCount = 1;
    }
    if (this.candidateCount >= AGREEING_ESTIMATES) this.adopt(hz, confirmed);
  }

  private adopt(hz: number, confirmed: boolean): void {
    this.rateHz = hz;
    this.periodMs = 1_000 / hz;
    this.confirmed = confirmed;
    this.candidateCount = 0;
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
