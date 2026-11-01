/**
 * The presentation cadence (PR B): how often the game's frame loop draws,
 * as the frame pacer (`src/game/framePacer.ts`) chose it, and the numbers
 * the renderer derives from it. The pacer writes it, the renderer and the
 * governor read it, and the `?bench=1` benchmark records it.
 *
 * INVARIANT THIS FILE OWNS: a slow machine can never relax its own target.
 * Only an explicit 30 fps choice, or a confirmed display period, may raise
 * the slowest interval the cadence allows. The pacer confirms a period only
 * on evidence render cost cannot stretch: ticks that drew nothing, or drawn
 * ticks faster than the period held before, which no frame's cost can make.
 * A period merely observed from rendered frames never raises it. The
 * governor's even fallback (PR B part 2b, G6) keeps to the same rule: the
 * governor asks for one only on a confirmed period the floor trusts, and the
 * floor it gives is that period times the fallback's divisor.
 *
 * Class P: pure types and numbers. No Babylon import, Node-testable. The
 * fallback's divisor rules live here, so that the frame pacer (`src/game`,
 * which may import this file's functions as well as its types) and the
 * governor read one copy.
 */

/** The frame-rate setting's cap: 60, 30, or null for "Match display". */
export type FrameRateCap = 60 | 30 | null;

/**
 * One cadence. The pacer replaces the object when its identity changes, and
 * only then; the identity is the cap, the divisor, the nominal display rate,
 * whether the period is confirmed and the fallback's rate. `displayPeriodMs`
 * is always exactly `1000 / nominal rate`, so comparing it compares the rate.
 */
export interface PresentationCadence {
  readonly frameCapHz: FrameRateCap;
  /** Render every Nth display refresh. */
  readonly divisor: number;
  /** Nominal display period in ms (snapped to a common rate), or null when not yet measured. */
  readonly displayPeriodMs: number | null;
  /**
   * True only when the period was measured on evidence render cost cannot
   * stretch: ticks that drew nothing, or ticks faster than the period held
   * before (see `FramePacer`).
   */
  readonly periodConfirmed: boolean;
  /**
   * PR B part 2b (G6): present only while the pacer applies the governor's
   * fallback: the even rate it then draws at (refresh / divisor). `frameCapHz`
   * stays the setting's cap, and `divisor` is the fallback's.
   */
  readonly fallbackHz?: number;
}

/** Ultra's own 1000/30 − 30: what a capped cadence keeps for present and the compositor. */
export const PRESENTATION_HEADROOM_MS = 10 / 3;

/**
 * A confirmed display period slower than this (57 Hz) does not raise the
 * floor unless the player chose 30 fps. The idle probe runs while the
 * renderer starts, which is the busiest main-thread time on exactly the
 * machines that are slow, so a 50 Hz or 30 Hz reading is not trusted to
 * relax the target in this PR: those displays shed as they did before.
 */
export const SLOWEST_TRUSTED_DISPLAY_PERIOD_MS = 1_000 / 57;

/**
 * The slowest interval the chosen cadence legitimately produces; 0 = no floor.
 * Under the governor's fallback (G6) that is the interval actually drawn,
 * the fallback's divisor times the period: 33.33 ms at 60 Hz, 26.67 ms at
 * 75 Hz with divisor 2, 34.72 ms at 144 Hz with 5. The governor asks for
 * one only on a confirmed period this function trusts (`fallbackAllowed`),
 * so the rule below already gives it, and a fallback cadence on any other
 * period still relaxes nothing.
 */
export function cadenceFloorMs(cadence: PresentationCadence | null): number {
  if (cadence === null) return 0;
  const capFloor = cadence.frameCapHz === 30 ? 1_000 / 30 : 0;
  const period = cadence.periodConfirmed ? cadence.displayPeriodMs : null;
  const trusted = period !== null
    && (period <= SLOWEST_TRUSTED_DISPLAY_PERIOD_MS || cadence.frameCapHz === 30);
  return Math.max(capFloor, trusted ? cadence.divisor * period : 0);
}

/** The nominal display rate in Hz, or null before the period is measured. */
export function cadenceDisplayHz(cadence: PresentationCadence | null): number | null {
  return cadence?.displayPeriodMs ? 1_000 / cadence.displayPeriodMs : null;
}

/** Same identity: cap, divisor, nominal display rate, confirmation and fallback rate (both absent is equal). */
export function sameCadence(a: PresentationCadence | null, b: PresentationCadence | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.frameCapHz === b.frameCapHz
    && a.divisor === b.divisor
    && a.displayPeriodMs === b.displayPeriodMs
    && a.periodConfirmed === b.periodConfirmed
    && a.fallbackHz === b.fallbackHz;
}

/**
 * G6: the divisors an even fallback near `targetHz` may use on a `rateHz`
 * display, above the setting's `pacedDivisor`: from floor (the faster
 * neighbour; +0.05 absorbs measurement error, as divisorFor does) to round
 * (the slower). [2, 2] at 60 Hz, [2, 3] at 75, [4, 5] at 144, [5, 6] at 165.
 * Null where none is above the paced divisor (a 30 Hz display).
 */
export function fallbackDivisorRange(
  rateHz: number,
  targetHz: number,
  pacedDivisor: number,
): readonly [number, number] | null {
  const slowest = Math.max(1, Math.round(rateHz / targetHz));
  const fastest = Math.max(pacedDivisor + 1, Math.floor(rateHz / targetHz + 0.05));
  return fastest <= slowest ? Object.freeze([fastest, slowest] as const) : null;
}

/**
 * G6 (PR B part 2b, K4): a mean up to this share of a refresh over a
 * divisor's interval still fits it. Vsync puts a window's mean on the
 * lattice, so a host whose every frame takes N refreshes averages N
 * refreshes give or take its timestamps' noise (26.67 ms ± a few µs at
 * 75 Hz), and a bare ceil turned that noise into 25 fps instead of 37.5. A
 * mean of N + 0.05 refreshes is 5% of frames one refresh longer: late at a
 * divisor of N, but no more than a window on cadence may hold. A window
 * drawn at N never has a frame shorter than N refreshes, so when it is off
 * cadence its mean always reaches the next divisor.
 */
const FALLBACK_FIT_REFRESHES = 0.05;

/**
 * G6: the fastest divisor in the range whose interval covers `minIntervalMs`
 * (the mean interval the host showed when it fell back, to within
 * `FALLBACK_FIT_REFRESHES`), else the slowest. So a 75 Hz host averaging
 * 22 ms, or every frame on 26.67 ms, draws every 2nd refresh (37.5 fps), and
 * one averaging 30 ms every 3rd (25 fps).
 */
export function fallbackDivisorFor(range: readonly [number, number], periodMs: number, minIntervalMs: number): number {
  // 1e-6 more keeps the 5% itself (6 of 120 frames) inside, past float noise.
  return Math.min(range[1], Math.max(range[0], Math.ceil(minIntervalMs / periodMs - FALLBACK_FIT_REFRESHES - 1e-6)));
}
