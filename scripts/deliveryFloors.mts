/**
 * Delivery floors, DERIVED from recorded run samples rather than transcribed.
 *
 * **Why this file exists.** A floor measured once and typed into a second place
 * is a copy, and the copy becomes what everything trusts while the source moves
 * underneath it. This phase hit that fault in three separate files. The obvious
 * repair — "derive the number at test time from the thing that produces it" —
 * does NOT work for a delivery floor: what produces a floor is a set of capture
 * runs, and deriving it from the run under test would compare a run against
 * itself and pass unconditionally. **That is a decorative gate, not a strict
 * one**, and it is the "numbers compared against themselves" antipattern.
 *
 * So the samples are the stored thing, and the floors are computed from them.
 * The samples describe **finished, named runs and therefore cannot drift** —
 * the runs are over. Re-pinning means adding run data, not editing a threshold,
 * and a committed floor that disagrees with its own samples fails
 * `tests/delivery-floors.test.ts`.
 *
 * **The rules are `PerfCaptureShotCeilings`' own**, not invented here:
 *
 *   minFps / minWallClockFps = floor(min-across-runs x 0.85)
 *   maxFrameIntervalMsP95    = ceil(max-across-runs x 1.2, to 0.1)
 *   hitchCount               = max(2 x max-across-runs, 3)
 *   maxFrameMs               = 50   (the strict tier-1 gate, not derived)
 *   p999FrameMs              = min(50, ceil(max-across-runs x 1.5))
 *
 * **Three runs minimum.** One cool-host run samples the favourable end of a
 * ~20% thermal band — measured, not assumed: the same-tree spread on
 * `reference-viewport` was 74.0 / 115.1 / 120.1 fps inside one session.
 */

/** Where the samples came from. Provenance is part of the data, not a comment. */
export const DELIVERY_FLOOR_PROVENANCE = Object.freeze({
  commit: "3053b8f",
  capturedOn: "2026-09-01",
  /** Candidate directories under tests/perf/artifacts/rebaseline-candidates/. */
  runs: Object.freeze([
    "2026-09-01T04-42-11.547Z",
    "2026-09-01T04-47-33.334Z",
    "2026-09-01T04-51-42.294Z",
  ] as const),
  host: "Apple Metal 3 / headless Chromium, medium/balanced, delivery gates enforced",
  note:
    "All three runs reported APPROVABLE. drawCalls were identical across all "
    + "three on every shot, which is the host-independent check that they are "
    + "three clean runs rather than three noisy ones.",
});

export interface DeliveryFloorSamples {
  readonly fps: readonly number[];
  readonly wallClockFps: readonly number[];
  readonly frameIntervalMsP95: readonly number[];
  readonly hitchCount: readonly number[];
  readonly p999FrameMs: readonly number[];
}

/**
 * **The two tail fields are optional and the other four are not.** That split
 * is measured, not stylistic — see `TAIL_DEFERRED_SHOTS` for why a shot may be
 * pinned without them. An ABSENT field means "deliberately not gated yet"; it
 * never means "passes". `ratchetedFloorsFrom` will not drop a field a previous
 * floor had, because dropping a gate is a loosening like any other.
 */
export interface DerivedDeliveryFloors {
  readonly maxFrameMs: number;
  readonly p999FrameMs?: number;
  readonly hitchCount: number;
  readonly minFps: number;
  readonly minWallClockFps: number;
  readonly maxFrameIntervalMsP95?: number;
}

/** The derived fields that are order statistics in the frame-time tail. */
export const TAIL_DERIVED_FIELDS = Object.freeze([
  "maxFrameIntervalMsP95",
  "p999FrameMs",
] as const);

/** The strict tier-1 single-frame gate. Not derived from samples by design. */
export const STRICT_MAX_FRAME_MS = 50;

/** Apply the documented rules. Pure arithmetic, no host, no I/O. */
export function deliveryFloorsFrom(samples: DeliveryFloorSamples): DerivedDeliveryFloors {
  const need = (xs: readonly number[], what: string) => {
    if (xs.length < 3) {
      throw new Error(
        `delivery floors need at least three runs of ${what}; got ${xs.length}. `
        + "One run is a thermometer reading, not a measurement.",
      );
    }
    return xs;
  };
  return {
    maxFrameMs: STRICT_MAX_FRAME_MS,
    p999FrameMs: Math.min(50, Math.ceil(Math.max(...need(samples.p999FrameMs, "p999FrameMs")) * 1.5)),
    hitchCount: Math.max(2 * Math.max(...need(samples.hitchCount, "hitchCount")), 3),
    minFps: Math.floor(Math.min(...need(samples.fps, "fps")) * 0.85),
    minWallClockFps: Math.floor(Math.min(...need(samples.wallClockFps, "wallClockFps")) * 0.85),
    maxFrameIntervalMsP95:
      Math.ceil(Math.max(...need(samples.frameIntervalMsP95, "frameIntervalMsP95")) * 1.2 * 10) / 10,
  };
}

/**
 * Per-shot measurements from the three runs above. **Do not hand-edit a value
 * here** — these are readings from finished runs. To re-pin, append a run and
 * regenerate.
 */
export const DELIVERY_FLOOR_SAMPLES: Readonly<Record<string, DeliveryFloorSamples>> = Object.freeze({
  // FIRST PIN (2026-09-01), three clean runs at committed 0af134c in a worktree.
  // Cross-run wallClockFps spread 0.054 against the 0.5 tolerance; a fourth
  // first-run capture was taken and discarded by protocol and agreed anyway.
  "dusk-mesopic": {
    fps: [121, 120.9, 121.2],
    wallClockFps: [120.07, 120.07, 120.12],
    frameIntervalMsP95: [9.2, 9.2, 9.4],
    hitchCount: [0, 0, 0],
    p999FrameMs: [9.3, 9.3, 9.4],
  },
  "approach-500ft": {
    fps: [121.5, 121.3, 121.7],
    wallClockFps: [120.11, 119.82, 120.1],
    frameIntervalMsP95: [9.8, 9.8, 10.1],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 10.3],
  },
  "slant-10km": {
    fps: [121.2, 121.4, 120.9],
    wallClockFps: [119.96, 119.89, 119.95],
    frameIntervalMsP95: [9.5, 9.9, 9.4],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 10],
  },
  "high-10000ft-down": {
    fps: [121.2, 121.3, 121.1],
    wallClockFps: [120.03, 119.93, 119.91],
    frameIntervalMsP95: [9.3, 9.6, 9.6],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 10],
  },
  "reference-viewport": {
    fps: [121.6, 121.6, 121.5],
    wallClockFps: [120.18, 120.16, 120.2],
    frameIntervalMsP95: [9.8, 9.8, 9.6],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 10.1],
  },
  "cruise-horizon": {
    fps: [121, 121.3, 121.7],
    wallClockFps: [119.88, 119.88, 120],
    frameIntervalMsP95: [9.3, 9.6, 10.4],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.2, 10.3, 10.4],
  },
  "winter-noon": {
    fps: [121.3, 121.8, 121.6],
    wallClockFps: [120.06, 120.2, 120.05],
    frameIntervalMsP95: [9.6, 10, 9.9],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.4, 10.3],
  },
  "night": {
    fps: [121.5, 121.6, 121.5],
    wallClockFps: [120.11, 120.1, 120.06],
    frameIntervalMsP95: [9.8, 10.1, 9.7],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10, 10.3, 10.3],
  },
  "night-moonlit": {
    fps: [121.3, 121.4, 121.1],
    wallClockFps: [120.03, 120.08, 120.03],
    frameIntervalMsP95: [9.8, 9.7, 9.3],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.4, 10.3, 10.2],
  },
  "motion-banked-turn": {
    fps: [121.9, 121.9, 122.1],
    wallClockFps: [120.29, 119.99, 120.26],
    frameIntervalMsP95: [9.4, 9.5, 9.5],
    hitchCount: [0, 0, 0],
    p999FrameMs: [13.2, 13.2, 13.2],
  },
  "page-thrash-turn": {
    fps: [121.7, 121.7, 121.3],
    wallClockFps: [119.82, 119.84, 119.85],
    frameIntervalMsP95: [10.2, 10.1, 9.5],
    hitchCount: [0, 0, 0],
    p999FrameMs: [11.9, 12.1, 12.3],
  },
  "cdlod-transition": {
    fps: [121.1, 121.2, 121.3],
    wallClockFps: [119.87, 119.99, 119.92],
    frameIntervalMsP95: [9.6, 9.7, 9.9],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10, 10.4, 10.3],
  },
  "cruise-sun-30": {
    fps: [121.4, 121.2, 121.4],
    wallClockFps: [119.86, 119.92, 119.99],
    frameIntervalMsP95: [9.7, 9.7, 9.8],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.4, 10.4, 10.6],
  },
  "forest-500ft-sunbehind": {
    fps: [121.4, 121.7, 121.4],
    wallClockFps: [119.83, 120.23, 120.13],
    frameIntervalMsP95: [10, 9.7, 9.5],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 10.4],
  },
  "coast-10km-lowsun": {
    fps: [121.3, 121, 121.2],
    wallClockFps: [119.96, 119.84, 119.93],
    frameIntervalMsP95: [9.5, 9.4, 9.7],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.6, 10, 10.2],
  },
  "ground-2m-lowsun": {
    fps: [121.2, 121.4, 121],
    wallClockFps: [120.19, 120.19, 120.19],
    frameIntervalMsP95: [9.3, 9.3, 9.1],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 9.6],
  },
  "canopy-1200ft": {
    fps: [121.9, 121.9, 121.5],
    wallClockFps: [120.16, 120.34, 120.14],
    frameIntervalMsP95: [10, 10, 9.3],
    hitchCount: [0, 0, 0],
    p999FrameMs: [11.6, 10.4, 11.1],
  },
  "runway-on-approach": {
    fps: [121.8, 121.7, 121.4],
    wallClockFps: [119.8, 119.77, 120.13],
    frameIntervalMsP95: [10.5, 10.2, 9.4],
    hitchCount: [0, 0, 0],
    p999FrameMs: [12, 12.2, 12.9],
  },
  "water-25ft": {
    fps: [121.1, 121.4, 121.1],
    wallClockFps: [119.96, 119.92, 119.9],
    frameIntervalMsP95: [9.4, 9.8, 9.5],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.2, 10],
  },
  "grove-forest-2m": {
    fps: [120.9, 120.8, 121.8],
    wallClockFps: [120.17, 120.01, 120.1],
    frameIntervalMsP95: [8.9, 9, 10.3],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.2, 10.2, 10.4],
  },
  "grove-meadow-2m": {
    fps: [120.7, 121, 121.9],
    wallClockFps: [119.79, 120.27, 120.21],
    frameIntervalMsP95: [9, 9.1, 9.9],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.2, 10.2, 10.4],
  },
  "hills-dusk-glint": {
    fps: [121.5, 121.6, 121.5],
    wallClockFps: [120.11, 120.16, 120.1],
    frameIntervalMsP95: [9.6, 9.8, 9.7],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 10.3],
  },
  "mountain-close": {
    fps: [121.8, 120.8, 121.2],
    wallClockFps: [119.83, 119.8, 120.12],
    frameIntervalMsP95: [10.4, 9.1, 9.1],
    hitchCount: [0, 0, 0],
    p999FrameMs: [13.1, 10.2, 10.4],
  },
  "forest-line-highsun": {
    fps: [121.8, 121.9, 121.4],
    wallClockFps: [120.26, 120.19, 120.14],
    frameIntervalMsP95: [9.7, 10.3, 9.6],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.4, 10.4, 10],
  },
  "cliff-60m": {
    fps: [121.5, 121.7, 120.8],
    wallClockFps: [120.05, 119.83, 120.11],
    frameIntervalMsP95: [9.3, 10.1, 9],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.4, 9.7],
  },
  "water-3m": {
    fps: [121.4, 120.9, 121.2],
    wallClockFps: [119.95, 119.93, 119.9],
    frameIntervalMsP95: [9.7, 9.3, 9.7],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.2, 10, 10.3],
  },
  "veg-seam-1600ft-oblique": {
    fps: [121.6, 121.3, 121.1],
    wallClockFps: [120.16, 120.1, 120.04],
    frameIntervalMsP95: [9.9, 9.5, 9.3],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.4, 10.2, 9.8],
  },
  "veg-seam-near-500ft": {
    fps: [121.6, 121.4, 121.7],
    wallClockFps: [120.16, 120.19, 120.04],
    frameIntervalMsP95: [9.6, 9.5, 10],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.3, 10.3, 10.3],
  },
  "terrain-material-1600ft-down": {
    fps: [121.1, 120.9, 121.6],
    wallClockFps: [119.76, 119.8, 119.86],
    frameIntervalMsP95: [9.2, 9.1, 10.3],
    hitchCount: [0, 0, 0],
    p999FrameMs: [12.4, 10.1, 10.4],
  },
  "horizon-shadow-far-annulus": {
    fps: [121.3, 121.8, 121.3],
    wallClockFps: [119.95, 119.93, 119.95],
    frameIntervalMsP95: [9.6, 10.6, 9.5],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.2, 10.4, 10.3],
  },
  "canopy-backlit-lowsun": {
    fps: [121.9, 122, 121.4],
    wallClockFps: [120.26, 120.26, 120.27],
    frameIntervalMsP95: [10, 10.4, 8.9],
    hitchCount: [0, 0, 0],
    p999FrameMs: [10.4, 10.4, 10.4],
  },
});

/**
 * The floors as they stood BEFORE this re-pin, kept as data so the ratchet can
 * be applied mechanically instead of remembered.
 *
 * **This is not history for its own sake.** `docs/PERFORMANCE.md` states that
 * "performance ceilings cannot be rebaselined downward", and a mechanical
 * re-derivation from fresh samples does not honour that on its own: measured
 * against these, deriving raw from the three runs recorded in
 * `DELIVERY_FLOOR_PROVENANCE` would **LOOSEN 15 of the 24 shots that have a
 * previous floor** — 18 fields in all: eleven p95 ceilings, five fps floors and
 * two p999 ceilings.
 *
 * A re-pin that loosens is how a regression is laundered into the baseline. So
 * the committed floor is the STRICTER of (previous, derived), field by field.
 *
 * **Do not trust this paragraph's arithmetic — it is a restated count and it
 * has already gone stale once** (it read "14 of the 24, nine fps floors" while
 * describing a different set of runs). `tests/delivery-floors.test.ts` derives
 * the same quantity from the data on every run; that test is the authority and
 * this sentence is a summary of it.
 */
export const PREVIOUS_DELIVERY_FLOORS: Readonly<Record<string, DerivedDeliveryFloors>> =
  Object.freeze({
  "approach-500ft": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.9 },
  "slant-10km": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.6 },
  "high-10000ft-down": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12 },
  "reference-viewport": { maxFrameMs: 50, p999FrameMs: 18, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12.2 },
  "cruise-horizon": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.4 },
  "winter-noon": { maxFrameMs: 50, p999FrameMs: 18, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12 },
  "night": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12 },
  "motion-banked-turn": { maxFrameMs: 50, p999FrameMs: 21, hitchCount: 3, minFps: 101, minWallClockFps: 99, maxFrameIntervalMsP95: 12 },
  "page-thrash-turn": { maxFrameMs: 50, p999FrameMs: 19, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
  "cdlod-transition": { maxFrameMs: 50, p999FrameMs: 17, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12.2 },
  "cruise-sun-30": { maxFrameMs: 50, p999FrameMs: 18, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
  "forest-500ft-sunbehind": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
  "coast-10km-lowsun": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.7 },
  "ground-2m-lowsun": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 12.6 },
  "canopy-1200ft": { maxFrameMs: 50, p999FrameMs: 20, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12 },
  "runway-on-approach": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12.4 },
  "water-25ft": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 11.9 },
  "grove-forest-2m": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 99, minWallClockFps: 98, maxFrameIntervalMsP95: 11.9 },
  "grove-meadow-2m": { maxFrameMs: 50, p999FrameMs: 17, hitchCount: 3, minFps: 101, minWallClockFps: 99, maxFrameIntervalMsP95: 11.9 },
  "hills-dusk-glint": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 102, maxFrameIntervalMsP95: 11.9 },
  "mountain-close": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 12.3 },
  "forest-line-highsun": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 103, minWallClockFps: 101, maxFrameIntervalMsP95: 12.2 },
  "cliff-60m": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.6 },
  "water-3m": { maxFrameMs: 50, p999FrameMs: 16, hitchCount: 3, minFps: 102, minWallClockFps: 101, maxFrameIntervalMsP95: 11.8 },
});

/**
 * Derive from samples, then ratchet against the previous pin: a floor may
 * tighten or hold, never loosen. Both inputs are stored data, so the result is
 * fully determined — there is no hand-chosen value anywhere in the chain.
 */
export function ratchetedFloorsFrom(
  samples: DeliveryFloorSamples,
  previous: DerivedDeliveryFloors | undefined,
): DerivedDeliveryFloors {
  const derived = deliveryFloorsFrom(samples);
  if (!previous) return derived;
  // An optional field ratchets like any other where both sides have it. Where
  // only the PREVIOUS has it, the previous value survives: a re-pin that drops
  // a gate has loosened it to infinity, which is the largest loosening there is
  // and the easiest to miss, because the field simply stops appearing.
  const tighter = (
    a: number | undefined,
    b: number | undefined,
  ): number | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
  return {
    maxFrameMs: Math.min(derived.maxFrameMs, previous.maxFrameMs),
    ...(tighter(derived.p999FrameMs, previous.p999FrameMs) === undefined
      ? {}
      : { p999FrameMs: tighter(derived.p999FrameMs, previous.p999FrameMs)! }),
    hitchCount: Math.min(derived.hitchCount, previous.hitchCount),
    minFps: Math.max(derived.minFps, previous.minFps),
    minWallClockFps: Math.max(derived.minWallClockFps, previous.minWallClockFps),
    ...(tighter(derived.maxFrameIntervalMsP95, previous.maxFrameIntervalMsP95) === undefined
      ? {}
      : {
          maxFrameIntervalMsP95: tighter(
            derived.maxFrameIntervalMsP95,
            previous.maxFrameIntervalMsP95,
          )!,
        }),
  };
}

/**
 * The five shots first-pinned on 2026-09-01 **without** their two tail fields.
 *
 * **Why the tail fields and not the others.** The three runs behind
 * `DELIVERY_FLOOR_SAMPLES` are the widest-tailed of the three sets on this host
 * that are still retained: median per-shot p95 spread 0.500 ms against 0.200 ms
 * for the 2026-08-31 evening set, at an almost identical fps median spread
 * (0.120 vs 0.114). A first pin taken from that set would look measured forever
 * while encoding one set's bad night. An unpinned ceiling is a stated debt; a
 * ceiling pinned off the widest-tailed set is a number nobody will re-examine.
 *
 * **`p999FrameMs` is deferred alongside `maxFrameIntervalMsP95` even though the
 * instruction named only p95.** p999 is the more extreme order statistic, and
 * measured on this set it is the noisier one: worst per-shot spread 2.90 ms
 * against p95's 1.50 ms, and `terrain-material-1600ft-down` alone spreads
 * 2.30 ms on p999 against 1.20 ms on p95. Deferring p95 for tail noise while
 * pinning p999 from the same runs would defeat the reason for deferring.
 *
 * **What IS pinned for these shots, and why each is safe here:**
 * - `minFps`, `minWallClockFps` — means over ~1800 frames. `wallClockFps`
 *   median spread 0.120 ms across the set.
 * - `hitchCount` — measured 0 in all 30 shots of all 3 runs, so the rule
 *   returns its floor of 3 rather than any reading from this set. Across all
 *   591 retained shot-records the counter has never been nonzero, which is
 *   consistent rather than blind: a hitch is an interval above 27.4 ms
 *   (2 x 13.7, `hitchThresholdMilliseconds`) and the worst single frame ever
 *   recorded is 22.80 ms. The gate is real and simply has never been tripped.
 * - `maxFrameMs` — the constant `STRICT_MAX_FRAME_MS`, not a reading.
 * - `drawCallCeiling` — byte-identical across all three runs for every shot.
 *
 * To retire an entry: capture a tail-quiet set, pin the two fields from it, and
 * delete the name. `tests/delivery-floors.test.ts` fails if a name here still
 * carries a tail field, and fails if a shot with a previous tail floor is added.
 */
export const TAIL_DEFERRED_SHOTS: ReadonlySet<string> = new Set<string>([
  "veg-seam-1600ft-oblique",
  "veg-seam-near-500ft",
  "terrain-material-1600ft-down",
  "horizon-shadow-far-annulus",
  "canopy-backlit-lowsun",
]);

/** Derivation for a tail-deferred first pin: every field except the tail two. */
export function tailDeferredFloorsFrom(samples: DeliveryFloorSamples): DerivedDeliveryFloors {
  const { maxFrameMs, hitchCount, minFps, minWallClockFps } = deliveryFloorsFrom(samples);
  return { maxFrameMs, hitchCount, minFps, minWallClockFps };
}

/**
 * Cold start, same retained-sample treatment. These three fresh-browser
 * reference-host runs use the strengthened completion definition: render,
 * synchronous canvas readback, the raw GPU submitted-work fence, and one
 * asynchronous error-delivery task. Pixel classification follows the clock
 * stop and therefore does not inflate the acceptance interval.
 *
 * **A fourth reading of 1,412 ms was proposed as the pin and refused**, because
 * it is a single sample of a metric that shares the host's noise source — and
 * it sits BELOW all three of these, so it is an outlier rather than the
 * favourable end of a spread. That refusal was correct and is recorded so the
 * number does not get "restored" by someone who finds it in a log.
 */
export const COLD_START_SAMPLES = Object.freeze({
  createMs: Object.freeze([1_537.6, 1_537.1, 1_542.6] as const),
  completionMs: Object.freeze([280.1, 278.3, 278.7] as const),
  rejectedCreateOutlierMs: 1_412,
});

/** Shipping analytic-default deadline; guarded against the derivation below. */
export const ANALYTIC_COLD_START_DEADLINE_MS = 2_300;

export interface ColdStartSamples {
  readonly createMs: readonly number[];
  readonly completionMs: readonly number[];
}

/** Paired create + completed-frame samples: the renderer is not ready before both. */
export function coldStartReadySamplesMs(samples: ColdStartSamples): readonly number[] {
  if (samples.createMs.length !== samples.completionMs.length) {
    throw new RangeError("cold-start create and completed-frame samples must be paired");
  }
  return samples.createMs.map(
    (createMs, index) => createMs + samples.completionMs[index]!,
  );
}

/**
 * Cold time-to-ready ceiling: median of the paired create + completed-frame
 * samples, plus 25% headroom, rounded up to 50 ms. Deliberately looser than
 * the delivery floors' 15% because startup contends with page load, shader
 * compilation and completed-frame allocation — none of which the steady-state
 * capture measures.
 */
export function coldStartCeilingMs(samples: ColdStartSamples = COLD_START_SAMPLES): number {
  const sorted = [...coldStartReadySamplesMs(samples)].sort((a, b) => a - b);
  if (sorted.length < 3) {
    throw new RangeError(
      `cold-start ceiling needs at least three paired samples; got ${sorted.length}`,
    );
  }
  const median = sorted[sorted.length >> 1]!;
  return Math.ceil((median * 1.25) / 50) * 50;
}

/**
 * **A FIRST pin has no predecessor, so the no-loosening ratchet has nothing to
 * compare against. This is what guards it instead.**
 *
 * The asymmetry matters: for a *re*-pin the dangerous direction is loosening,
 * and the previous value catches it. For a *first* pin there is no previous
 * value, and the dangerous direction is **too loose** — a floor set wide enough
 * that the shot can never fail is a decorative gate, and it is indistinguishable
 * from a measured one forever after. (Too tight is self-correcting: it fails on
 * the next run and somebody notices.)
 *
 * Three things guard a first pin, and none of them is history:
 *
 * 1. **Exact equality to the derivation.** The committed floor must equal
 *    `deliveryFloorsFrom(samples)` precisely — there is no room to add quiet
 *    headroom, because any hand-loosening makes the assertion fail. This is the
 *    same check a re-pin gets and it does not depend on a predecessor.
 * 2. **A spread gate on the samples.** `min-across-runs` is only meaningful if
 *    the runs agree. If three runs disagree by more than the host-cleanliness
 *    tolerance, the "minimum" is 0.85 of an accident and the floor is pinned on
 *    noise. `firstPinFrom` REFUSES rather than deriving.
 * 3. **Declared, not inferred.** A shot without a predecessor must be named in
 *    `FIRST_PIN_SHOTS`. Otherwise "no previous value" and "ratchet passed" look
 *    identical to a reader and to a test — which is how an assertion silently
 *    stops covering something.
 */
export const SAMPLE_SPREAD_TOLERANCE_FPS = 0.5;

/**
 * Shots whose floors are being pinned for the first time, so there is no
 * predecessor to ratchet against. **Membership is asserted both ways**: a
 * member that turns out to HAVE a predecessor is a stale entry and fails, so
 * this set cannot outlive its reason.
 */
export const FIRST_PIN_SHOTS: ReadonlySet<string> = new Set<string>([
  "night-moonlit",
  // First-pinned 2026-09-01 at 0af134c; see its ceilings block for provenance.
  "dusk-mesopic",
]);

/** Cross-run wall-clock fps spread — the host-cleanliness evidence. */
export function sampleSpreadFps(samples: DeliveryFloorSamples): number {
  return Math.max(...samples.wallClockFps) - Math.min(...samples.wallClockFps);
}

/**
 * Derive a FIRST pin. Same arithmetic as a re-pin, plus the spread gate: three
 * runs that disagree are not three clean runs, and a floor derived from them
 * describes the host rather than the tree.
 */
export function firstPinFrom(
  samples: DeliveryFloorSamples,
  toleranceFps: number = SAMPLE_SPREAD_TOLERANCE_FPS,
): DerivedDeliveryFloors {
  const spread = sampleSpreadFps(samples);
  if (spread > toleranceFps) {
    throw new Error(
      `cross-run fps spread ${spread.toFixed(3)} exceeds ${toleranceFps} — these are not `
      + "three clean runs, and a first pin derived from them would record the host's "
      + "noise as the tree's floor. Re-run on a quiet machine rather than widening this.",
    );
  }
  return deliveryFloorsFrom(samples);
}

/**
 * **Draw-call ceilings get a different treatment from delivery floors, and the
 * reason is a property of the quantity rather than a preference.**
 *
 * `drawCalls` is a CPU-side submitted count: **host-independent, and measured
 * byte-identical across all three R4 runs on all 29 shots — zero disagreements.**
 * So neither of the floors' devices applies. A 15% margin would be absorbing
 * variance that does not exist, and the spread gate has nothing to gate: the
 * spread is exactly zero everywhere.
 *
 * **The right pin is therefore the measured value itself.** A ceiling above the
 * measurement is headroom for growth nobody has justified — and the field's own
 * docblock says "measured drawCalls ceiling … asserted hard on every host",
 * which is not what the committed values did.
 *
 * **What the committed values actually were, and why this is a finding rather
 * than a tidy-up:** they sat **6 to 10 draws above** the measurement, with no
 * single rule — the observed margins are 6, 8, 9 and 10. **An undocumented,
 * inconsistent margin on a field described as "measured" is this phase's own
 * defect class**: a figure whose rule is nowhere stated, so nothing can tell
 * whether it drifted. A margin of 8 also means eight draws of real growth pass
 * silently, which is what the gate exists to catch.
 *
 * **Direction is guaranteed, not hoped for.** `PREVIOUS_DRAW_CALL_CEILINGS`
 * records what shipped, and the test asserts every new ceiling is **less than
 * or equal to** it — this change can only tighten. If the "host-independent"
 * claim is ever wrong, that shows up as a red CI on a different machine, which
 * is information worth having rather than a risk to paper over with margin.
 */
export const DRAW_CALL_SAMPLES: Readonly<Record<string, readonly number[]>> = Object.freeze({
  // RE-PINNED at 768f1cb from three byte-identical arms (R1/R2/R3) plus a
  // discarded warm-up: 36 shots, tier 1, medium/balanced, zero nondeterministic
  // shots across the three. The previous samples are gone rather than kept
  // because a sample list is the ceiling's derivation, not its history --
  // MEASURED_DRAW_DELTAS and DRAW_CALL_RAISES carry what moved and why.
  "approach-500ft":              [261, 261, 261],
  "slant-10km":                  [222, 222, 222],
  "high-10000ft-down":           [223, 223, 223],
  "reference-viewport":          [262, 262, 262],
  "cruise-horizon":              [214, 214, 214],
  "winter-noon":                 [261, 261, 261],
  "night":                       [263, 263, 263],
  "night-moonlit":               [263, 263, 263],
  "dusk-mesopic":                [262, 262, 262],
  "motion-banked-turn":          [268, 268, 268],
  "page-thrash-turn":            [267, 267, 267],
  "cdlod-transition":            [208, 208, 208],
  "cruise-sun-30":               [240, 240, 240],
  "forest-500ft-sunbehind":      [262, 262, 262],
  "coast-10km-lowsun":           [235, 235, 235],
  "ground-2m-lowsun":            [268, 268, 268],
  "canopy-1200ft":               [260, 260, 260],
  "runway-on-approach":          [269, 269, 269],
  "water-25ft":                  [238, 238, 238],
  "grove-forest-2m":             [267, 267, 267],
  "grove-meadow-2m":             [281, 281, 281],
  "hills-dusk-glint":            [258, 258, 258],
  "mountain-close":              [285, 285, 285],
  "forest-line-highsun":         [258, 258, 258],
  "cliff-60m":                   [251, 251, 251],
  "water-3m":                    [237, 237, 237],
  "veg-seam-1600ft-oblique":     [255, 255, 255],
  "veg-seam-near-500ft":         [263, 263, 263],
  "terrain-material-1600ft-down":[282, 282, 282],
  "horizon-shadow-far-annulus":  [238, 238, 238],
  "canopy-backlit-lowsun":       [246, 246, 246],
});

/**
 * What actually ships today — the ratchet's reference, stored as data.
 *
 * **This was stale and the staleness mattered.** It used to hold the
 * PRE-TIGHTENING ceilings, the ones carrying 6-to-10 draws of undocumented
 * margin. Measured against those, bloom's +4 passed on every shot with slack to
 * spare, so the ratchet was comparing against a baseline that no longer shipped
 * and therefore constrained nothing. The margin described elsewhere in this file
 * as "eight draws of real growth passing silently" is exactly what let a real
 * feature's growth through without a recorded decision — the same outcome as a
 * hand-edited ceiling, reached by a different route. `mountain-close` had two
 * draws left before that stopped.
 *
 * Refreshed to the values committed at 285eb2b. From here a ceiling can only
 * rise through `DRAW_CALL_RAISES`.
 */
export const PREVIOUS_DRAW_CALL_CEILINGS: Readonly<Record<string, number>> = Object.freeze({
  // Added with the 768f1cb batch. These two entered the ratchet at their own
  // first measurement and were never raised, so no baseline was ever written
  // for them -- which the raise guard found the moment a raise first named
  // them. Their baseline IS their first committed ceiling, read from the
  // pre-edit file rather than retyped.
  "night-moonlit":                157,
  "dusk-mesopic":                 156,
  "approach-500ft":               150,
  "slant-10km":                   132,
  "high-10000ft-down":            135,
  "reference-viewport":           151,
  "cruise-horizon":               127,
  "winter-noon":                  150,
  "night":                        152,
  "motion-banked-turn":           155,
  "page-thrash-turn":             154,
  "cdlod-transition":             122,
  "cruise-sun-30":                131,
  "forest-500ft-sunbehind":       151,
  "coast-10km-lowsun":            127,
  "ground-2m-lowsun":             159,
  "canopy-1200ft":                149,
  "runway-on-approach":           161,
  "water-25ft":                   130,
  "grove-forest-2m":              156,
  "grove-meadow-2m":              168,
  "hills-dusk-glint":             147,
  "mountain-close":               175,
  "forest-line-highsun":          147,
  "cliff-60m":                    163,
  "water-3m":                     129,
  "veg-seam-1600ft-oblique":      144,
  "veg-seam-near-500ft":          152,
  "terrain-material-1600ft-down": 172,
  "horizon-shadow-far-annulus":   148,
  "canopy-backlit-lowsun":        156,
});

/**
 * A raise is a NAMED DECISION, and its arithmetic is checked.
 *
 * The ratchet says draw-call ceilings may only tighten. That is right as a
 * default and wrong as an absolute: a feature that genuinely costs draws has to
 * be able to land. The question a guard can actually answer is not "is this
 * cost acceptable" — it cannot know — but **"is this one feature's cost, or is
 * it assorted creep?"**
 *
 * **Uniformity is the measurable signature of the first.** Bloom attaches four
 * post-process passes with no content gating, so it costs exactly four draws on
 * every shot; measured, 30 of 30 at +4 with all three runs byte-identical.
 * Creep does not look like that.
 *
 * **Two admissible forms, and the cheap one is the uniform one:**
 * - `kind: "uniform"` — one delta, applied to every shot named. The test
 *   asserts every named shot moved by EXACTLY that much, so a raise claiming
 *   uniformity it does not have fails.
 * - `kind: "per-shot"` — each shot's delta listed individually, with
 *   `whyNonUniform` explaining what varies. Not blocked, deliberately more
 *   expensive to write and to read, because the per-shot list is the thing a
 *   reviewer has to look at.
 *
 * **The non-uniform form exists so the first legitimately non-uniform feature
 * does not meet a guard it cannot satisfy.** That is how a ratchet becomes a
 * formality: someone widens the rule under deadline pressure. A content-gated
 * pass, or one whose work scales with what is in frame, is a real possibility
 * and it stays possible here — just visibly costlier to declare.
 *
 * **Entries are not permanent permission.** The test asserts every raise is
 * still NEEDED: each named shot's committed ceiling must actually exceed its
 * previous by that delta. A raise whose feature was later removed fails, so
 * these cannot accumulate into a standing allowance.
 */
export type DrawCallRaise =
  | {
      readonly kind: "uniform";
      readonly feature: string;
      readonly commit: string;
      readonly reason: string;
      readonly delta: number;
      readonly shots: readonly string[];
    }
  | {
      readonly kind: "per-shot";
      readonly feature: string;
      readonly commit: string;
      readonly reason: string;
      /** What varies between shots. Required: it is the whole justification. */
      readonly whyNonUniform: string;
      readonly deltas: Readonly<Record<string, number>>;
    };

/**
 * WHICH SHOTS A RAISE MAY NAME IS NOT A JUDGEMENT CALL — it falls out of the
 * mechanism, and this comment exists because the only way to learn that
 * currently is to have a gate reject you.
 *
 * A raise declares how far a shot's ceiling moved from
 * `PREVIOUS_DRAW_CALL_CEILINGS`. A shot with no entry in that snapshot has no
 * value it moved FROM, so its movement is not expressible as a raise at all —
 * `undefined` is not a baseline of zero. Both `bloom` and `airfield-lighting`
 * name exactly the same 29 shots, and neither author chose that number: it is
 * the size of the snapshot.
 *
 * `dusk-mesopic` and `night-moonlit` postdate the snapshot. Their ceilings are
 * still the measured count — that field is defined as the measurement, not as a
 * ratcheted value — but they sit OUTSIDE the raise mechanism until they get a
 * first pin (`firstPinFrom`, `FIRST_PIN_SHOTS`) or the snapshot is refreshed.
 * Adding either to a raise's `shots` list fails with "which has no previous
 * ceiling", which is correct and reads like a bug in the entry.
 */
export const DRAW_CALL_RAISES: readonly DrawCallRaise[] = Object.freeze([
  Object.freeze({
    kind: "per-shot" as const,
    feature: "csm-cascade-decoupling",
    commit: "034aedd",
    deltas: Object.freeze({
      "approach-500ft":              67,
      "slant-10km":                  61,
      "high-10000ft-down":           59,
      "reference-viewport":          67,
      "cruise-horizon":              58,
      "winter-noon":                 67,
      "night":                       67,
      "night-moonlit":               67,
      "dusk-mesopic":                67,
      "motion-banked-turn":          69,
      "page-thrash-turn":            69,
      "cdlod-transition":            57,
      "cruise-sun-30":               65,
      "forest-500ft-sunbehind":      67,
      "coast-10km-lowsun":           64,
      "ground-2m-lowsun":            65,
      "canopy-1200ft":               67,
      "runway-on-approach":          64,
      "water-25ft":                  64,
      "grove-forest-2m":             67,
      "grove-meadow-2m":             69,
      "hills-dusk-glint":            67,
      "mountain-close":              66,
      "forest-line-highsun":         67,
      "cliff-60m":                   59,
      "water-3m":                    64,
      "veg-seam-1600ft-oblique":     67,
      "veg-seam-near-500ft":         67,
      "terrain-material-1600ft-down":66,
      "horizon-shadow-far-annulus":  61,
      "canopy-backlit-lowsun":       61,
    }),
    reason:
      "`DepthOnlyCascadedShadowGenerator` passed `noColorAttachment: true`, which "
      + "nulled the render target's colour texture -- and `RenderTargetTexture`'s "
      + "per-layer loop is gated on `is2DArray`, which READS that colour texture. "
      + "The loop was skipped and only cascade 0 ever rendered. The optimisation "
      + "disabled cascade rendering through a property unrelated to where shadow "
      + "data is stored, and `034aedd` decoupled them. "
      + "PER-SHOT, not uniform, and the reason is the mechanism: the cost is one "
      + "extra depth render per CASTING MESH IN FRAME, so it scales with how much "
      + "geometry casts at that vantage. Declared from the difference between the "
      + "shipped arm and an arm with only this change reverted (`NOCASC`), which "
      + "is the only way to attribute it -- three arms alone gave an "
      + "unattributable total.",
    whyNonUniform:
      "57..69, mean 65.1 across 36 shots. The spread is caster count in frame: "
      + "a vantage with more shadow-casting geometry pays more. No shot is at "
      + "zero, because the terrain sheet casts everywhere.",
  }),
  Object.freeze({
    kind: "uniform" as const,
    feature: "since-pin-global",
    commit: "768f1cb",
    delta: 24,
    shots: Object.freeze([
      "slant-10km",
      "high-10000ft-down",
      "cruise-horizon",
      "cdlod-transition",
      "cliff-60m",
      "horizon-shadow-far-annulus",
      "canopy-backlit-lowsun",
    ]),
    reason:
      "AGGREGATE, and deliberately not attributed per feature. Everything landed "
      + "between the previous pin and `768f1cb` EXCEPT the cascade decoupling "
      + "above, measured as `NOCASC` minus the committed ceiling. It is +24 on "
      + "exactly these seven shots and +39 on the other twenty-four; this entry "
      + "is the global half. "
      + "THE SEVEN ARE THE SHOTS WITH NO AIRFIELD IN FRAME, and that is checkable "
      + "rather than asserted: the identical seven appear as the zero group in "
      + "`hangar-detail` and as the negative group in `parametric-hangars`, three "
      + "measurements from three commit pairs by three owners. The boundary is "
      + "`AIRFIELD_STRUCTURE_LOD.cullDistanceMeters = 6000`. "
      + "NOT DECOMPOSED FURTHER because this measurement cannot: it has one arm "
      + "for the whole span. Splitting it per owner would be arithmetic dressed "
      + "as attribution.",
  }),
  Object.freeze({
    kind: "uniform" as const,
    feature: "since-pin-airfield",
    commit: "768f1cb",
    delta: 39,
    shots: Object.freeze([
      "approach-500ft",
      "reference-viewport",
      "winter-noon",
      "night",
      "night-moonlit",
      "dusk-mesopic",
      "motion-banked-turn",
      "page-thrash-turn",
      "cruise-sun-30",
      "forest-500ft-sunbehind",
      "coast-10km-lowsun",
      "ground-2m-lowsun",
      "canopy-1200ft",
      "runway-on-approach",
      "water-25ft",
      "grove-forest-2m",
      "grove-meadow-2m",
      "hills-dusk-glint",
      "mountain-close",
      "forest-line-highsun",
      "water-3m",
      "veg-seam-1600ft-oblique",
      "veg-seam-near-500ft",
      "terrain-material-1600ft-down",
    ]),
    reason:
      "The airfield half of the same aggregate: +39 where the airfield is within "
      + "the 6000 m structure cull, against +24 where it is not. The 15-draw "
      + "difference is the airfield's own growth over the span -- hangars, tower, "
      + "signage, obstruction lighting -- and is NOT decomposed per feature for "
      + "the reason given on the global entry. "
      + "Declared as two uniform raises rather than one per-shot raise so that "
      + "GROUP MEMBERSHIP IS EXPLICIT: a shot moving between the groups is a "
      + "visibility change and should fail loudly, which a per-shot table of the "
      + "same numbers would absorb silently.",
  }),
  Object.freeze({
    kind: "uniform" as const,
    feature: "airfield-lighting",
    commit: "122f9fa",
    reason:
      "AirfieldLightingSystem populates LightPointSystem, which had been "
      + "constructed with an EMPTY fixture list and so issued no draw at all. One "
      + "instanced draw now carries every light point -- 279 placed fixtures "
      + "expanded per lit direction plus 8 PAPI lamps, 402 in total -- so the cost "
      + "is one draw however many lamps are in frame, and it did NOT move when the "
      + "lamps were recalibrated brighter. Uniform because the mesh sets "
      + "`alwaysSelectAsActiveMesh = true` and is submitted on every shot whether "
      + "or not the airfield is in view; a frustum-culled mesh would have made "
      + "this per-shot. MEASURED +1 on 30 of 30, three byte-identical warm runs "
      + "in a clean worktree at committed 326f94e. A fourth, first-run capture was "
      + "taken and discarded by protocol: SWE II 1 measured a real first-run effect "
      + "(136 vs 157 on `night`, residentTerrainPages and vegetationBatches moving "
      + "with it), and although it did not occur here, a non-reproduction on a "
      + "different shot and thermal state is not a refutation. `dusk-mesopic` is "
      + "deliberately NOT named: it is new, has no committed ceiling, and needs "
      + "its own three clean runs rather than riding in on this one. `night-moonlit` + is absent for the same structural reason: both postdate + `PREVIOUS_DRAW_CALL_CEILINGS`, so there is no baseline to have moved FROM + and their movement is not expressible as a raise. Their ceilings are still + the measured count -- that field is defined as the measurement, not as a + ratcheted value -- but they sit outside the raise mechanism until the + snapshot is next refreshed. Bloom names the same 29 for the same reason.",
    delta: 1,
    shots: Object.freeze([
      "approach-500ft",
      "canopy-1200ft",
      "canopy-backlit-lowsun",
      "cdlod-transition",
      "cliff-60m",
      "coast-10km-lowsun",
      "cruise-horizon",
      "cruise-sun-30",
      "forest-500ft-sunbehind",
      "forest-line-highsun",
      "ground-2m-lowsun",
      "grove-forest-2m",
      "grove-meadow-2m",
      "high-10000ft-down",
      "hills-dusk-glint",
      "horizon-shadow-far-annulus",
      "motion-banked-turn",
      "mountain-close",
      "night",
      "page-thrash-turn",
      "reference-viewport",
      "runway-on-approach",
      "slant-10km",
      "terrain-material-1600ft-down",
      "veg-seam-1600ft-oblique",
      "veg-seam-near-500ft",
      "water-25ft",
      "water-3m",
      "winter-noon",
    ]),
  }),
  Object.freeze({
    kind: "uniform" as const,
    feature: "bloom",
    commit: "285eb2b",
    reason:
      "BloomPass attaches four PostProcess instances — bright, blur-h, blur-v, "
      + "composite — to the camera chain at tier 1. There is no content gating: "
      + "the threshold is applied per pixel INSIDE the bright shader, so it "
      + "decides what glows, never whether the pass runs. Every tier-1 shot pays "
      + "four draws and only the shots with a bright source get anything for "
      + "them. Measured 30 of 30 at +4, byte-identical across three runs.",
    delta: 4,
    shots: Object.freeze([
    "approach-500ft",
    "slant-10km",
    "high-10000ft-down",
    "reference-viewport",
    "cruise-horizon",
    "winter-noon",
    "night",
    "motion-banked-turn",
    "page-thrash-turn",
    "cdlod-transition",
    "cruise-sun-30",
    "forest-500ft-sunbehind",
    "coast-10km-lowsun",
    "ground-2m-lowsun",
    "canopy-1200ft",
    "runway-on-approach",
    "water-25ft",
    "grove-forest-2m",
    "grove-meadow-2m",
    "hills-dusk-glint",
    "mountain-close",
    "forest-line-highsun",
    "cliff-60m",
    "water-3m",
    "veg-seam-1600ft-oblique",
    "veg-seam-near-500ft",
    "terrain-material-1600ft-down",
    "horizon-shadow-far-annulus",
    "canopy-backlit-lowsun",
    ]),
  }),
]);

/**
 * **Measured draw-call deltas that have not yet become raise entries.**
 *
 * `DRAW_CALL_RAISES` cannot be written one owner at a time: its guard asserts
 * `committed - previous === declaredRaiseFor(name)` exactly, so a raise cannot
 * land without the ceilings moving in the same change, and moving the ceilings
 * needs three clean runs. Four owners would mean four re-pins with three
 * intermediate states nobody can satisfy. **So every owner measures, nothing
 * lands, and ONE re-pin carries all the entries and all the ceilings together.**
 *
 * **This exists because that gap has a cost, and it was paid twice in one
 * evening.** Between measuring and landing, a delta lives only in conversation
 * — so anyone doing arithmetic over the set subtracts from memory. Two correct
 * decompositions disagreed by 5 draws because one of them had no way to know
 * two terms had already been measured: the aircraft lamps at +4 and Babylon's
 * clustered-container proxy mesh at +1. **Neither party got a number wrong.
 * One of them was working from a list that did not contain them.**
 *
 * That nearly sent an owner to reconcile a predicted 14 against a target of 19
 * — hunting five draws of tower that do not exist. **A search with a target
 * usually finds something**, which would have been worse than the arithmetic
 * being wrong, because the wrong answer would have arrived with a measurement
 * attached.
 *
 * **So: measure into here, then promote out of here.** An entry leaves when its
 * feature becomes a `DRAW_CALL_RAISES` entry, and the test below fails if one
 * is ever in both — a staged delta that has been declared is a duplicate
 * waiting to be subtracted twice.
 */
export interface MeasuredDrawDelta {
  /** Which session measured it, so a disagreement has someone to ask. */
  readonly owner: string;
  /** The feature name it will carry into `DRAW_CALL_RAISES`. */
  readonly feature: string;
  /** The exact pair given to `scripts/decompose-draw-calls.sh`. */
  readonly baseRef: string;
  readonly headRef: string;
  /** How many shots were measured. A 2-shot discovery pass is not an entry. */
  readonly shotsMeasured: number;
  /**
   * The delta. A number when every measured shot moved by the same amount; a
   * per-shot map otherwise. **A sign change cannot be expressed as a uniform
   * number and must not be averaged into one.**
   */
  readonly delta: number | Readonly<Record<string, number>>;
  /** What the number means, and anything that qualifies it. */
  readonly note: string;
}

/**
 * **Everything measured so far, with its provenance.** Anyone subtracting
 * across the set should subtract from THIS, not from memory or from chat.
 */
export const MEASURED_DRAW_DELTAS: readonly MeasuredDrawDelta[] = Object.freeze([
  Object.freeze({
    owner: "7-4b / clustered lighting",
    feature: "aircraft-lamps",
    baseRef: "37cf3aa^", headRef: "37cf3aa",
    shotsMeasured: 2,
    delta: 4,
    note:
      "Four lamp spheres on the trainer -- tail-navigation-light, "
      + "anticollision-beacon, port-strobe-light, starboard-strobe-light -- each "
      + "carrying `metadata.castsShadow = false`, so 1.00 draw apiece rather "
      + "than 2.00. The aircraft is in every shot, so the delta is uniform. "
      + "PREDICTED from the mesh count and the caster flag before measuring.",
  }),
  Object.freeze({
    owner: "7-4b / clustered lighting",
    feature: "clustered-container-proxy",
    baseRef: "1db14f0", headRef: "d1c02c1",
    shotsMeasured: 2,
    delta: 1,
    note:
      "Babylon's `ClusteredLightContainer` constructs `_proxyMesh = "
      + "CreatePlane(\"ProxyMesh\")`. `ClusteredLightingSystem` builds NO container "
      + "when it has no children, so this draw exists exactly when the container "
      + "does -- it appeared when the hangar floods were restored. NOT a cost of "
      + "the floods themselves; a cost of the container having any child at all.",
  }),
  Object.freeze({
    owner: "7-10 / parametric hangars",
    feature: "parametric-hangars",
    baseRef: "37cf3aa", headRef: "82c4182",
    shotsMeasured: 34,
    delta: Object.freeze({
      // +6 where the hangars draw: six meshes replacing three CreateBox placeholders.
      "approach-500ft": 6, "blue-hour": 6, "canopy-1200ft": 6,
      "coast-10km-lowsun": 6, "cruise-sun-30": 6, "dusk-mesopic": 6,
      "forest-500ft-sunbehind": 6, "forest-line-highsun": 6, "golden-hour": 6,
      "ground-2m-lowsun": 6, "grove-forest-2m": 6, "grove-meadow-2m": 6,
      "hills-dusk-glint": 6, "motion-banked-turn": 6, "mountain-close": 6,
      "night": 6, "night-beacon-offset": 6, "night-moonlit": 6,
      "page-thrash-turn": 6, "reference-viewport": 6, "runway-on-approach": 6,
      "terrain-material-1600ft-down": 6, "veg-seam-1600ft-oblique": 6, "veg-seam-near-500ft": 6,
      "water-25ft": 6, "water-3m": 6, "winter-noon": 6,
      // -6 where they do not: the placeholders are gone and nothing replaces them.
      "canopy-backlit-lowsun": -6, "cdlod-transition": -6, "cliff-60m": -6,
      "cruise-horizon": -6, "high-10000ft-down": -6, "horizon-shadow-far-annulus": -6,
      "slant-10km": -6,
    }),
    note:
      "THE BRIDGE MEASUREMENT, promoted from the two-shot discovery pass. Full "
      + "34 of 34 shots, both arms 34, shot sets identical -- stated before the "
      + "delta because a partial decomposition is the failure this table exists "
      + "to exclude. Measured via `37cf3aa -> 82c4182` because `ddc5a63` does "
      + "not run; see MULTI_OWNER_COMMITS. "
      + "EVERY shot moved, by exactly +6 or -6, no shot at zero and no third "
      + "value. Six hangar meshes replace three `CreateBox` placeholders at "
      + "2.00 draws each, so the commit ADDS 6 where the hangars draw and SAVES "
      + "6 where they do not. A sign change rather than a magnitude change, and "
      + "the swing of 12 is the whole of the +24/+12 bimodality that started "
      + "this. "
      + "EVIDENCE LOCATION, stated honestly: both reports are on the capture "
      + "host at `tests/perf/artifacts/run-archive/bridge-37cf3aa-82c4182/`, "
      + "which is GITIGNORED (`.gitignore:45`) and therefore NOT in the tree. "
      + "`git ls-files tests/perf/artifacts/run-archive/` returns zero. Do not "
      + "read `archived` as `retrievable`; a clean checkout has none of it.",
    whyNonUniform:
      "`AIRFIELD_STRUCTURE_LOD.cullDistanceMeters = 6000`, installed by "
      + "`buildHangar` as a Babylon LOD level with a NULL replacement, so beyond "
      + "it the shell is not drawn at all. What varies across shots is whether "
      + "the camera is inside that radius. "
      + "CORROBORATED INDEPENDENTLY: the seven shots that go negative here are "
      + "EXACTLY the seven that read 0 in the `hangar-detail` entry above, "
      + "measured by a different owner from a different commit pair "
      + "(`1a23abf -> 2bfe84a`). Two measurements, two commit pairs, the same "
      + "27/7 partition of the shot set. "
      + "THE TWO APPARENT EXCEPTIONS ARE MEASUREMENT ERROR IN THE PROXY, NOT IN "
      + "THE MECHANISM, and are recorded because the earlier working called them "
      + "a refutation. `cdlod-transition` (5701 m to the datum) and "
      + "`horizon-shadow-far-annulus` (5845 m) look INSIDE the cull. The hangars "
      + "sit up to 250 m from the airport datum (`hangarFootprint` gives "
      + "across 135, along -210.4 / -158.4 / -106.4), so their true distances "
      + "reach 5951 m and 6095 m -- the second crosses the cull outright and the "
      + "first lands within 1% of it. The proxy ignores the airport's "
      + "`headingRadians` rotation and measures to the datum rather than to each "
      + "mesh, so it cannot resolve the last 50 m and no claim is made that it "
      + "does. "
      + "AND THIS RETIRES A RETRACTED CLAIM RATHER THAN LEAVING IT OPEN: the "
      + "`+24/+12` working once concluded the split `does not track distance`, "
      + "citing `mountain-close` and `cliff-60m` at equal offsets in different "
      + "groups. Both carry a `locate`, so those offsets are search SEEDS and "
      + "not positions; see RETRACTED_DRAW_READINGS. Distance is the mechanism.",
  }),
  Object.freeze({
    owner: "7-10 / hangars",
    feature: "hangar-detail",
    baseRef: "1a23abf", headRef: "2bfe84a",
    shotsMeasured: 34,
    delta: Object.freeze({
      // +3 on 27 shots: the hangars are drawn.
      "approach-500ft": 3, "blue-hour": 3, "canopy-1200ft": 3, "coast-10km-lowsun": 3,
      "cruise-sun-30": 3, "dusk-mesopic": 3, "forest-500ft-sunbehind": 3,
      "forest-line-highsun": 3, "golden-hour": 3, "ground-2m-lowsun": 3,
      "grove-forest-2m": 3, "grove-meadow-2m": 3, "hills-dusk-glint": 3,
      "motion-banked-turn": 3, "mountain-close": 3, "night": 3,
      "night-beacon-offset": 3, "night-moonlit": 3, "page-thrash-turn": 3,
      "reference-viewport": 3, "runway-on-approach": 3,
      "terrain-material-1600ft-down": 3, "veg-seam-1600ft-oblique": 3,
      "veg-seam-near-500ft": 3, "water-25ft": 3, "water-3m": 3, "winter-noon": 3,
      // 0 on 7: the hangars are not drawn at all.
      "canopy-backlit-lowsun": 0, "cdlod-transition": 0, "cliff-60m": 0,
      "cruise-horizon": 0, "high-10000ft-down": 0, "horizon-shadow-far-annulus": 0,
      "slant-10km": 0,
    }),
    note:
      "The clerestory glazing needs a third material and therefore a third mesh "
      + "per hangar. It is excluded from `shadowCasters` -- the band stands 6 cm "
      + "off a wall that already casts -- so each costs 1.00 draw, not 2.00: "
      + "three hangars, +3. PREDICTED as +3 before measuring, with the "
      + "falsifiers registered; none fired. +6 would have meant the caster "
      + "exclusion was not reaching the renderer, 0 would have meant the mesh "
      + "was not drawing, and any value tracking TRIANGLES would have shown up "
      + "because the same commit made the shell a closed manifold, adding ~330 "
      + "triangles per hangar at constant mesh count. Nothing moved by anything "
      + "but 3 or 0. "
      + "SEPARATE FROM `parametric-hangars` AND NOT A SIGN CHANGE: that commit "
      + "replaced placeholders and so could go negative; this one only ADDS a "
      + "mesh, so its floor is zero. "
      + "WHY NOT UNIFORM: +3 wherever the hangars are drawn, 0 where they are "
      + "not, for three distinct reasons. (a) Beyond the 6000 m LOD cull -- "
      + "measured in ONE frame by converting the hangars through `runwayToWorld` "
      + "onto the capture world, 17 of the 18 shots whose distance is computable "
      + "agree exactly, including `horizon-shadow-far-annulus` at 6007 m, seven "
      + "metres past the line. (b) Relocated by terrain search onto ground far "
      + "from the airfield: `cliff-60m` and `canopy-backlit-lowsun` read 0 while "
      + "the other 14 located shots find terrain near enough and read +3; their "
      + "distances are NOT computable, since a located shot's offset is a search "
      + "seed. (c) `cdlod-transition` sits 224 m INSIDE the cull and still reads "
      + "0: it is a motion shot climbing outbound at 96 m/s, and `drawCalls` "
      + "comes from one `getDiagnostics()` call at the END of the capture, so "
      + "the sampled frame is several hundred metres beyond the 5776 m start. "
      + "Mechanism named; the arithmetic is NOT closed, because the final "
      + "position was never pinned. "
      + "Both feature passes were byte-identical on `drawCalls` across all 34 "
      + "shots, so this counter carries no first-run effect. Baseline arm from "
      + "the harness run that failed; feature arm re-run alone in a clean "
      + "worktree after the failure, warm-up plus keep.",
  }),
  Object.freeze({
    owner: "7-13 / airfield furniture",
    feature: "airfield-furniture",
    baseRef: "679815a^", headRef: "679815a",
    shotsMeasured: 34,
    delta: 11,
    note:
      "Windsock 3 meshes casting = 6, fence 1 non-casting = 1, fuel farm 2, "
      + "signage 2. PREDICTED from construction before measuring, then measured "
      + "uniform on 34 of 34. Its uniformity is what eliminated furniture as the "
      + "cause of the +24/+12 split.",
  }),
]);

/**
 * **Readings that were LOAD-BEARING, are WRONG, and must not be rebuilt on.**
 *
 * Struck rather than deleted, for the reason a struck docblock is: **deleting
 * hides that the question was ever asked, and the next person re-derives it.**
 *
 * **This exists because a retraction cannot travel and a claim can.** A wrong
 * number stated in conversation reaches everyone reading at that moment and
 * then keeps going; the withdrawal reaches only whoever is reading when it
 * lands, hours later, against the original's head start. **Every entry below
 * was withdrawn and then quoted back as a premise anyway.**
 *
 * The rule that follows: **move a claim out of conversation and into an
 * artifact the moment it becomes load-bearing** — then a correction has
 * somewhere to attach, and anyone building on it reads the strike with it.
 */
export interface RetractedDrawReading {
  /** Who said it, so the correction has the same author as the claim. */
  readonly author: string;
  /** The claim, as stated, so it is recognisable when someone quotes it. */
  readonly claim: string;
  /** Why it is wrong — the mechanism, not the verdict. */
  readonly whyWrong: string;
  /** What replaced it. */
  readonly correctedTo: string;
  /** What it cost after withdrawal, which is the argument for this record. */
  readonly costAfterRetraction: string;
}

export const RETRACTED_DRAW_READINGS: readonly RetractedDrawReading[] = Object.freeze([
  Object.freeze({
    author: "7-4b / clustered lighting",
    claim:
      "\"+6 inside the 6000 m LOD cull and -6 beyond -- six meshes, beauty only, "
      + "no shadow draws at 2642 m.\"",
    whyWrong:
      "An ABSOLUTE compared against a DELTA. `37cf3aa` had THREE CreateBox "
      + "placeholder hangars and `82c4182` has six meshes, so the mesh delta is "
      + "+3, not 6. +6 over +3 meshes is 2.00 per mesh, not 1.00.",
    correctedTo:
      "2.00 draws per casting mesh -- one beauty plus exactly ONE shadow cascade, "
      + "at a tier declaring `shadowCascades: 2`. Confirmed by a discriminating "
      + "shot at ~820 m reading +6 where a two-cascade reading required +9, and "
      + "independently on furniture, and directly off Babylon's `_drawCalls` "
      + "counter at 40 m.",
    costAfterRetraction:
      "Quoted back hours later as the premise of an entire range-gating "
      + "derivation for the tower, which predicted +7 where the measurement gave "
      + "+14. The retraction was in the conversation the whole time.",
  }),
  Object.freeze({
    author: "7-4b / clustered lighting",
    claim:
      "\"The +24/+12 split does not track distance -- `mountain-close` and "
      + "`cliff-60m` sit at identical offsets and land in different groups.\"",
    whyWrong:
      "Both shots carry a `locate` value, and a located shot's "
      + "`offsetXMeters` is a SEARCH SEED rather than a position -- the camera "
      + "ends up over whatever terrain feature the search finds. The two shots "
      + "compared have unknown, different distances. The comparison could not "
      + "bear on the question.",
    correctedTo:
      "Over the shots WITHOUT a `locate` key, where offsets ARE comparable, "
      + "distance separates the groups cleanly: +24 at 661-4472 m, +12 at "
      + "5629-8944 m. Held as PROVISIONAL -- the unlocated shots are not a "
      + "RANDOM subset: located shots are chosen by terrain feature and "
      + "unlocated ones are fixed vantages, so the split is selected, not "
      + "sampled. That is the caveat; the fraction never was. "
      + "RE-MEASURED 2026-09-01: 18 unlocated of 34 (16 carry a `locate`). "
      + "NOT a half -- an earlier same-day correction said `17 of 34, an "
      + "exact half` and that is wrong too; counted twice, from the "
      + "imported artifact and textually within the array bounds, both "
      + "giving 16/18. The original read `15 of 31`: 31 was a stale shot "
      + "count (the set is 34) and 15 was never the figure. On the "
      + "predicate: `locate: null` appears once in the tree, in the "
      + "`perf-capture.mts` docblock, not in any shot -- `locate` is an "
      + "optional string, absent when unused. But the filter that docblock "
      + "PRESCRIBES, `locate == null`, is LOOSE equality and does select "
      + "the right 18, since `undefined == null`. Only the strict `===` "
      + "form silently selects zero. A denominator inside a retraction is still a live "
      + "number and rots like any other.",
    costAfterRetraction:
      "Handed to three sessions as evidence against distance before it was "
      + "withdrawn. Two of them built on it.",
  }),
  Object.freeze({
    author: "7-4b / clustered lighting",
    claim:
      "\"The REPO/node_modules defect is the root cause of the 98-minute capture "
      + "that produced no report.\"",
    whyWrong:
      "The defect is real -- `REPO` derives from the script's own path, so a "
      + "worktree copy symlinks the wrong `node_modules` -- but it does not "
      + "explain the symptom. The failing run's BASE arm used the identical "
      + "chained symlink and completed in twelve minutes with a full report, and "
      + "chained symlinks were then shown to resolve on this host. **The bug's "
      + "existence was verified; its CAUSATION was not, and only the second "
      + "claim was made.**",
    correctedTo:
      "Cause UNKNOWN and deliberately left open. Contention is the leading "
      + "candidate -- the arm ran against two live decomposition worktrees at "
      + "load 6-10 -- but there is no evidence from inside the failed run, "
      + "because its output went to /dev/null. The logging fix means the next "
      + "occurrence answers this in seconds. **Do not close this question on the "
      + "REPO fix.**",
    costAfterRetraction:
      "Reported to the PM and to the affected owner as the root cause within "
      + "the hour, and refuted by that owner's own baseline arm.",
  }),
]);



/** Total declared raise for a shot, or 0 if none is declared. */
export function declaredRaiseFor(name: string): number {
  let total = 0;
  for (const raise of DRAW_CALL_RAISES) {
    if (raise.kind === "uniform") {
      if (raise.shots.includes(name)) total += raise.delta;
    } else if (raise.deltas[name] !== undefined) {
      total += raise.deltas[name];
    }
  }
  return total;
}


/**
 * The ceiling is the measured count, and the guard is that every run agrees.
 * Disagreement means the quantity is NOT host-independent, which invalidates
 * the whole treatment — so it throws rather than picking a maximum.
 */
export function drawCallCeilingFrom(samples: readonly number[]): number {
  if (samples.length < 3) {
    throw new Error(`draw-call ceilings need at least three runs; got ${samples.length}`);
  }
  const distinct = new Set(samples);
  if (distinct.size !== 1) {
    throw new Error(
      `drawCalls disagree across runs (${samples.join("/")}) — this quantity is asserted `
      + "host-independent and is not. Do not take the maximum: find out why it varies.",
    );
  }
  return samples[0]!;
}
