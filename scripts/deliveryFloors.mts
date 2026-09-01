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
 * Cold start, same treatment. Three samples taken inside the R4 runs.
 *
 * **A fourth reading of 1,412 ms was proposed as the pin and refused**, because
 * it is a single sample of a metric that shares the host's noise source — and
 * it sits BELOW all three of these, so it is an outlier rather than the
 * favourable end of a spread. That refusal was correct and is recorded so the
 * number does not get "restored" by someone who finds it in a log.
 */
export const COLD_START_SAMPLES = Object.freeze({
  totalMs: Object.freeze([1_594, 1_602, 1_616] as const),
  firstFrameMs: Object.freeze([73, 73, 69] as const),
  rejectedOutlierMs: 1_412,
});

/**
 * Cold-start ceiling: median of the samples, plus 25% headroom, rounded up to
 * 50 ms. Deliberately looser than the delivery floors' 15% because startup
 * contends with page load, shader compilation and first-frame allocation —
 * none of which the steady-state capture measures.
 */
export function coldStartCeilingMs(samples: typeof COLD_START_SAMPLES = COLD_START_SAMPLES): number {
  const sorted = [...samples.totalMs].sort((a, b) => a - b);
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
export const FIRST_PIN_SHOTS: ReadonlySet<string> = new Set<string>(["night-moonlit"]);

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
  "approach-500ft":               [154, 154, 154],
  "slant-10km":                   [136, 136, 136],
  "high-10000ft-down":            [139, 139, 139],
  "reference-viewport":           [155, 155, 155],
  "cruise-horizon":               [131, 131, 131],
  "winter-noon":                  [154, 154, 154],
  "night":                        [156, 156, 156],
  "night-moonlit":                [156, 156, 156],
  "motion-banked-turn":           [159, 159, 159],
  "page-thrash-turn":             [158, 158, 158],
  "cdlod-transition":             [126, 126, 126],
  "cruise-sun-30":                [135, 135, 135],
  "forest-500ft-sunbehind":       [155, 155, 155],
  "coast-10km-lowsun":            [131, 131, 131],
  "ground-2m-lowsun":             [163, 163, 163],
  "canopy-1200ft":                [153, 153, 153],
  "runway-on-approach":           [165, 165, 165],
  "water-25ft":                   [134, 134, 134],
  "grove-forest-2m":              [160, 160, 160],
  "grove-meadow-2m":              [172, 172, 172],
  "hills-dusk-glint":             [151, 151, 151],
  "mountain-close":               [179, 179, 179],
  "forest-line-highsun":          [151, 151, 151],
  "cliff-60m":                    [167, 167, 167],
  "water-3m":                     [133, 133, 133],
  "veg-seam-1600ft-oblique":      [148, 148, 148],
  "veg-seam-near-500ft":          [156, 156, 156],
  "terrain-material-1600ft-down": [176, 176, 176],
  "horizon-shadow-far-annulus":   [152, 152, 152],
  "canopy-backlit-lowsun":        [160, 160, 160],
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

export const DRAW_CALL_RAISES: readonly DrawCallRaise[] = Object.freeze([
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
