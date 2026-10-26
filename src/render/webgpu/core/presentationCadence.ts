/**
 * The presentation cadence (PR B): how often the game's frame loop draws,
 * as the frame pacer (`src/game/framePacer.ts`) chose it, and the numbers
 * the renderer derives from it. The pacer writes it, the renderer and the
 * governor read it, and the `?bench=1` benchmark records it.
 *
 * INVARIANT THIS FILE OWNS: a slow machine can never relax its own target.
 * Only an explicit 30 fps choice, or a display period measured on ticks that
 * drew nothing, may raise the slowest interval the cadence allows; a period
 * merely observed from rendered frames never does.
 *
 * Class P: pure types and numbers. No Babylon import, Node-testable.
 */

/** The frame-rate setting's cap: 60, 30, or null for "Match display". */
export type FrameRateCap = 60 | 30 | null;

/**
 * One cadence. The pacer replaces the object when its identity changes, and
 * only then; the identity is the cap, the divisor, the nominal display rate
 * and whether the period is confirmed. `displayPeriodMs` is always exactly
 * `1000 / nominal rate`, so comparing it compares the rate.
 */
export interface PresentationCadence {
  readonly frameCapHz: FrameRateCap;
  /** Render every Nth display refresh. */
  readonly divisor: number;
  /** Nominal display period in ms (snapped to a common rate), or null when not yet measured. */
  readonly displayPeriodMs: number | null;
  /** True only when the period was measured on ticks that drew nothing. */
  readonly periodConfirmed: boolean;
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

/** The slowest interval the chosen cadence legitimately produces; 0 = no floor. */
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

/** Same identity: cap, divisor, nominal display rate and confirmation. */
export function sameCadence(a: PresentationCadence | null, b: PresentationCadence | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.frameCapHz === b.frameCapHz
    && a.divisor === b.divisor
    && a.displayPeriodMs === b.displayPeriodMs
    && a.periodConfirmed === b.periodConfirmed;
}
