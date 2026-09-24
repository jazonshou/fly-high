/**
 * The clean room every pinned GPU price is measured in.
 *
 * A price is a pass's own execution time: what admitting it adds to a frame.
 * Contention is the budget's headroom problem, not the price's. On 2026-09-22
 * a steady load beside a short pass inflated its reading (occlusion 0.17 ms
 * alone, ~0.27 ms beside the load), and runs that started seconds after
 * another GPU test disagreed with runs that did not (page generation
 * 2.02-2.03 ms after a 20 s idle gap, 5.42 and 3.25 ms straight after the
 * ground-cover test): docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md.
 *
 * So a pricing run is marked (`VITE_PRICING_RUN=1`), and the runner passes
 * how long the GPU was idle before it (`VITE_PRICING_IDLE_GAP_MS`). A pricing
 * run with a shorter gap is refused rather than measured. The runner checks
 * for other GPU work across the gap; a user's own browser tab it cannot see is
 * why windows are also confirmed by message.
 *
 * Outside a pricing run the cost tests behave as before: a regression alarm
 * on whatever host runs them, not a measurement anyone prices from.
 */
export const PRICING_IDLE_GAP_MS = 20_000;

export interface PricingRun {
  /** How long the GPU was idle before this run, as the runner measured it. */
  readonly idleGapMs: number;
}

/** The pricing run this is, or null when it is an ordinary test run. */
export function pricingRun(): PricingRun | null {
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_PRICING_RUN !== "1") return null;
  const idleGapMs = Number(env.VITE_PRICING_IDLE_GAP_MS);
  if (!Number.isFinite(idleGapMs) || idleGapMs < PRICING_IDLE_GAP_MS) {
    throw new Error(
      `a pricing run needs at least ${PRICING_IDLE_GAP_MS} ms of idle GPU before it; `
      + `this one reports ${env.VITE_PRICING_IDLE_GAP_MS ?? "none"}`,
    );
  }
  return { idleGapMs };
}

/** One line per priced sample, beside the inputs that produced it, for the pricing log. */
export function logPricingSample(
  client: string,
  index: number,
  milliseconds: number,
  inputs: Readonly<Record<string, unknown>>,
): void {
  console.log(`PRICING ${client} #${index}: ${milliseconds.toFixed(4)} ms ${JSON.stringify(inputs)}`);
}
