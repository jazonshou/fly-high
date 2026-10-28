import { describe, expect, it } from "vitest";
import { divisorFor, FramePacer, IDLE_PROBE_LEAD_TICKS, type FramePacerTick } from "../src/game/framePacer";
import type { PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import type { FrameRateSetting } from "../src/settings";

/**
 * The frame pacer against the stamps browsers really hand it (PR #36's
 * Firefox bug). `game.frame-pacer.test.ts` jitters every stamp the same way
 * either side of its vsync; here a stamp is displaced the way Firefox 158
 * on macOS displaces it, fitted to Jason's M2 Pro bench report: its vsync
 * callback can only move a stamp early, by up to 6.5 ms under load, and
 * every stamp sits on a 0.02 ms grid. Frames cost whole refreshes at the
 * report's measured weights, renderer creation keeps the main thread busy
 * through the startup probe, and displays change rate mid-flight.
 *
 * Under those stamps the pacer used to confirm rates no display runs at:
 * when every frame takes two refreshes, the only ticks it skips are the
 * ones stamped early, so the deltas it took as the display's were 1.5 to
 * 1.9 periods. "Wrong" is what the governor would judge against: a divisor
 * the true rate does not imply, or a period more than 3.5% off it.
 *
 * Deterministic: each vsync draws its stamp's displacement and the cost of
 * a frame begun on it from a seeded xorshift stream, so a pacer and the
 * true cadence (`TrueCadence`) see the same display and the same frames.
 * The tests count ticks and frames; none reads a clock.
 */

// --- the display and the load -------------------------------------------------

/** A stamp's displacement from its vsync, ms, from three uniforms; `heavy` while the load is. */
type Stamps = (sign: number, pick: number, size: number, heavy: boolean) => number;
/** A drawn frame's cost in refreshes, from a uniform and the flight time. */
type Cost = (u: number, ms: number) => number;

/** Firefox's rAF stamps sit on this grid. */
const STAMP_GRID_MS = 0.02;
/** A cadence period further than this share from the true one is wrong (as `sameRate` reads two rates). */
const RATE_TOLERANCE = 0.035;
/** Wrong cadences and frames count from this much flight on: the pacer has had a few estimates. */
const JUDGE_FROM_MS = 2_000;
/** The flight's first tick comes this long after the probe's last (FlightRenderer.create returning). */
const FIRST_TICK_GAP_MS = 100;
/** A share of judged ticks the cadence may be wrong on: a few estimates' worth in a flight. */
const MAX_WRONG_SHARE = 0.005;

/** xorshift32, seeded through a multiplicative hash so neighbouring seeds share nothing. */
function xorshift(seed: number, salt: number): () => number {
  let x = Math.imul((seed + 1) ^ Math.imul(salt + 1, 0x85ebca6b), 0x9e3779b1) | 0 || 1;
  const next = (): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4_294_967_296;
  };
  for (let index = 0; index < 8; index += 1) next();
  return next;
}

/**
 * Firefox 158 on macOS, fitted to the bench report: under load 3% of stamps
 * 2-6.5 ms off and 16% up to 1.5 ms, under light load 8% up to 1.25 ms.
 * `early`: never late (gfxPlatformMac.cpp clamps a stamp from the future to
 * now); otherwise either way, the fit's other reading.
 */
const firefox = (early: boolean): Stamps => (sign, pick, size, heavy) => {
  const direction = early || sign < 0.5 ? -1 : 1;
  if (heavy && pick < 0.03) return direction * (2 + 4.5 * size);
  if (pick < (heavy ? 0.19 : 0.08)) return direction * (heavy ? 1.5 : 1.25) * size;
  return 0;
};
/** Uniform jitter either way: Chrome-like at ±0.5 ms. */
const uniform = (ms: number): Stamps => (sign) => (sign * 2 - 1) * ms;
const exact: Stamps = () => 0;

/** Frame costs in refreshes, by weight (index 0 = one refresh). */
function weighted(weights: readonly number[]): Cost {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return (u) => {
    let x = u * total;
    for (let index = 0; index < weights.length; index += 1) {
      x -= weights[index]!;
      if (x < 0) return index + 1;
    }
    return weights.length;
  };
}
const ONE: Cost = () => 1;
const TWO: Cost = () => 2;
/** The bench report's Medium air window at 120 Hz: mostly two refreshes, a fifth three. */
const MEDIUM = weighted([111, 3_582, 955, 24, 2, 3]);
/** Its High: mostly three and four refreshes, and a few hitches. */
const HIGH = weighted([0, 18, 838, 574, 11, 7, 1, 2]);
/** `heavy` until `ms`, light after: the load that lightens. */
const until = (endMs: number, heavy: Cost, light: Cost = ONE): Cost => (u, ms) => (ms < endMs ? heavy : light)(u, ms);
const always = (): boolean => true;

// --- the flight -----------------------------------------------------------------

interface FlightOptions {
  readonly hz: number;
  /** The display's rate from `switchAtMs` (flight time) on. */
  readonly toHz?: number;
  readonly switchAtMs?: number;
  readonly durationMs: number;
  readonly seed?: number;
  readonly setting?: FrameRateSetting | ((ms: number) => FrameRateSetting);
  readonly stamps?: Stamps;
  /** One refresh a frame by default. */
  readonly cost?: Cost;
  /** Whether the load counts as heavy at `ms`: Firefox's heavy mixture follows it. */
  readonly heavy?: (ms: number) => boolean;
  readonly paused?: (ms: number) => boolean;
  /** Renderer creation on a busy main thread after the probe's lead, with two stalls. */
  readonly busyStartup?: boolean;
  /** The probe's quiet lead in ticks: 24, or fewer where its 300 ms come first. */
  readonly leadTicks?: number;
  /** After a frame of 2+ refreshes, the share of vsyncs that call back twice, the first early (Chrome). */
  readonly doubleCallbacks?: number;
  /** A main-thread stall at this flight ms, this long: no tick until the first vsync after it. */
  readonly stall?: readonly [atMs: number, ms: number];
  /** Decide with the true cadence instead of the pacer. */
  readonly oracle?: boolean;
}

interface Flight {
  readonly pacer: FramePacer;
  readonly changes: readonly { readonly ms: number; readonly cadence: PresentationCadence }[];
  /** Ticks from `JUDGE_FROM_MS` on, and those whose cadence is wrong for the display then. */
  readonly judged: number;
  readonly wrong: number;
  /**
   * Frames drawn from `JUDGE_FROM_MS` on, outside pauses and the pacer's own
   * skips, and those drawn fewer (early) or more (missed) vsyncs after the
   * last than due: the true divisor, or the last frame's cost if longer.
   */
  readonly frames: number;
  readonly early: number;
  readonly missed: number;
  /** After a switch, the longest run (ms) at neither the old rate nor the new one. */
  readonly thirdMs: number;
  /** Flight ms of the tick from which the cadence stayed right to the end, or null. */
  readonly rightFromMs: number | null;
  /** Drawn ticks flagged afterReprobe with no pause since the last drawn one. */
  readonly unpausedFlags: number;
  /** Flight ms of each tick that drew nothing outside a pause. */
  readonly unpausedSkipsMs: readonly number[];
}

/**
 * The pacer's render rule fed the true cadence: the early and missed frames
 * any measured period is held to. With a divisor of 2 or more it misses a
 * due tick stamped over half a refresh early, as the pacer does.
 */
class TrueCadence {
  hz = 60;
  private lastRenderMs: number | null = null;
  private readonly out: FramePacerTick = { render: true, cadence: null, afterReprobe: false };

  tick(nowMs: number, setting: FrameRateSetting): FramePacerTick {
    const divisor = divisorFor(setting, this.hz);
    this.out.render = divisor <= 1
      || this.lastRenderMs === null
      || nowMs - this.lastRenderMs >= (divisor - 0.5) * (1_000 / this.hz);
    if (this.out.render) this.lastRenderMs = nowMs;
    return this.out;
  }
}

const offBy = (cadence: PresentationCadence | null, hz: number): boolean =>
  cadence?.displayPeriodMs == null || Math.abs(1_000 / cadence.displayPeriodMs - hz) > RATE_TOLERANCE * hz;

const isRight = (cadence: PresentationCadence | null, setting: FrameRateSetting, hz: number): boolean =>
  !offBy(cadence, hz) && cadence!.divisor === divisorFor(setting, hz);

function fly(options: FlightOptions): Flight {
  const seed = options.seed ?? 1;
  // Per vsync: the stamp's sign, pick and size, and a frame's cost.
  const draws = xorshift(seed, 1);
  const misc = xorshift(seed, 2);
  const switchPhase = xorshift(seed, 3)();
  const pacer = new FramePacer({ pace60: true });
  const oracle = options.oracle ? new TrueCadence() : null;
  const stamps = options.stamps ?? exact;
  const cost = options.cost ?? ONE;
  const settingAt = (ms: number): FrameRateSetting =>
    typeof options.setting === "function" ? options.setting(ms) : options.setting ?? "60";
  const heavyAt = (ms: number): boolean => options.heavy?.(ms) ?? false;

  let hz = options.hz;
  let period = 1_000 / hz;
  let vsync = 1_000 + misc() * 40;
  let vsyncs = 0;
  let flightStart = Number.POSITIVE_INFINITY;
  let switched = false;
  let sign = 0;
  let pick = 0;
  let size = 0;
  let costU = 0;
  const drawVsync = (): void => {
    sign = draws();
    pick = draws();
    size = draws();
    costU = draws();
  };
  drawVsync();
  const advance = (refreshes = 1): void => {
    for (let index = 0; index < refreshes; index += 1) {
      let next = vsync + period;
      if (!switched && options.toHz !== undefined && next - flightStart >= options.switchAtMs!) {
        hz = options.toHz;
        period = 1_000 / hz;
        next = flightStart + options.switchAtMs! + switchPhase * period;
        while (next <= vsync + 0.5) next += period;
        switched = true;
      }
      vsync = next;
      vsyncs += 1;
      drawVsync();
    }
  };
  let lastStampMs = Number.NEGATIVE_INFINITY;
  const stamp = (heavy: boolean, earlyBy = 0): number => {
    const at = vsync + stamps(sign, pick, size, heavy) - earlyBy;
    // rAF stamps never run backwards.
    lastStampMs = Math.max(lastStampMs, Math.round(at / STAMP_GRID_MS) * STAMP_GRID_MS);
    return lastStampMs;
  };

  // As `startIdleProbe`: the tick that settles the lead and every one
  // after it hand the pacer a busy delta; the timer settles a shorter lead
  // after its last tick.
  for (let index = 0; index < (options.leadTicks ?? IDLE_PROBE_LEAD_TICKS); index += 1) {
    pacer.probe(stamp(heavyAt(0)), index + 1 < IDLE_PROBE_LEAD_TICKS);
    advance();
  }
  if (options.busyStartup) {
    // Renderer creation: 4.3 s of probe ticks that miss refreshes at random,
    // with stalls of 370-690 ms and 1.1-1.3 s, as the report's (both reset).
    const end = vsync + 4_300;
    let stallA = vsync + misc() * 3_400;
    let stallB = vsync + misc() * 3_400;
    while (vsync < end) {
      pacer.probe(stamp(true), false);
      let ms: number;
      const u = misc();
      if (vsync >= stallA) {
        ms = 370 + misc() * 320;
        stallA = Number.POSITIVE_INFINITY;
      } else if (vsync >= stallB) {
        ms = 1_100 + misc() * 200;
        stallB = Number.POSITIVE_INFINITY;
      } else {
        ms = u < 0.5 ? 0 : u < 0.9 ? (2 + misc() * 6) * 8.33 : (8 + misc() * 20) * 8.33;
      }
      advance(Math.max(1, Math.floor(ms / period)));
    }
  }
  advance(Math.round(FIRST_TICK_GAP_MS / period));
  flightStart = vsync;

  const decide = (nowMs: number, setting: FrameRateSetting, paused: boolean): FramePacerTick => {
    if (oracle === null) return pacer.tick(nowMs, setting, paused);
    oracle.hz = hz;
    return oracle.tick(nowMs, setting);
  };
  const changes: { ms: number; cadence: PresentationCadence }[] = [];
  let judged = 0;
  let wrong = 0;
  let frames = 0;
  let early = 0;
  let missed = 0;
  let thirdMs = 0;
  let thirdSince: number | null = null;
  let rightFromMs: number | null = null;
  let unpausedFlags = 0;
  const unpausedSkipsMs: number[] = [];
  let pausedSinceDraw = false;
  let longFrame = false;
  let lastDrawVsync = -1;
  let lastCost = 1;
  let lastDrawSwitched = false;
  let stalled = false;
  while (vsync - flightStart < options.durationMs) {
    const ms = vsync - flightStart;
    const setting = settingAt(ms);
    const paused = options.paused?.(ms) ?? false;
    const heavy = heavyAt(ms);
    if (paused) pausedSinceDraw = true;
    if (longFrame && options.doubleCallbacks !== undefined && misc() < options.doubleCallbacks) {
      // A late callback stamped just before the vsync, then the vsync's own.
      const first = decide(stamp(heavy, 0.1 + 1.3 * misc()), setting, paused);
      if (first.cadence !== null) changes.push({ ms, cadence: first.cadence });
    }
    const result = decide(stamp(heavy), setting, paused);
    if (result.cadence !== null) changes.push({ ms, cadence: result.cadence });
    const cadence = pacer.currentCadence;
    const right = isRight(cadence, setting, hz);
    if (ms >= JUDGE_FROM_MS) {
      judged += 1;
      if (!right) wrong += 1;
    }
    rightFromMs = right ? rightFromMs ?? ms : null;
    if (switched) {
      const third = cadence !== null && offBy(cadence, options.hz) && offBy(cadence, options.toHz!);
      if (third) thirdSince ??= ms;
      else if (thirdSince !== null) {
        thirdMs = Math.max(thirdMs, ms - thirdSince);
        thirdSince = null;
      }
    }
    let refreshes = 1;
    if (!result.render && !paused) unpausedSkipsMs.push(ms);
    if (result.render) {
      if (result.afterReprobe && !pausedSinceDraw) unpausedFlags += 1;
      if (ms >= JUDGE_FROM_MS && lastDrawVsync >= 0 && !pausedSinceDraw && !result.afterReprobe && lastDrawSwitched === switched) {
        const gap = vsyncs - lastDrawVsync;
        const due = Math.max(divisorFor(setting, hz), lastCost);
        frames += 1;
        if (gap < due) early += 1;
        if (gap > due) missed += 1;
      }
      refreshes = Math.max(1, cost(costU, ms));
      lastDrawVsync = vsyncs;
      lastCost = refreshes;
      lastDrawSwitched = switched;
      pausedSinceDraw = false;
    }
    longFrame = refreshes >= 2;
    advance(refreshes);
    if (options.stall !== undefined && !stalled && vsync - flightStart >= options.stall[0]) {
      stalled = true;
      advance(Math.ceil(options.stall[1] / period));
    }
  }
  if (thirdSince !== null) thirdMs = Math.max(thirdMs, vsync - flightStart - thirdSince);
  return { pacer, changes, judged, wrong, frames, early, missed, thirdMs, rightFromMs, unpausedFlags, unpausedSkipsMs };
}

/** The nominal rates of every cadence the flight emitted, rounded. */
const ratesOf = (flight: Flight): number[] =>
  [...new Set(flight.changes.map(({ cadence }) => Math.round(1_000 / cadence.displayPeriodMs!)))];
const wrongShare = (flight: Flight): number => flight.wrong / flight.judged;

// --- the tests --------------------------------------------------------------------

describe("Firefox's early stamps under frames of two refreshes", () => {
  it("keep 120 Hz at every 2nd refresh when every frame takes two, after a quiet or a busy startup", () => {
    // The only ticks the pacer skips are stamped early; the delta after each
    // is a refresh plus the shift (12.5-15.6 ms), which no display's period is.
    for (const busyStartup of [false, true]) {
      for (const seed of [1, 2, 3, 4]) {
        const flight = fly({ hz: 120, durationMs: 60_000, seed, busyStartup, stamps: firefox(true), heavy: always, cost: TWO });
        expect(ratesOf(flight), `seed ${seed}${busyStartup ? ", busy" : ""}`).toEqual([120]);
        expect(flight.wrong).toBe(0);
        expect(flight.pacer.currentCadence).toMatchObject({ divisor: 2, displayPeriodMs: 1_000 / 120, periodConfirmed: true });
      }
    }
  });

  it("keep 120 Hz under the bench's Medium load, after a quiet or a busy startup", () => {
    for (const busyStartup of [false, true]) {
      for (const seed of [1, 2, 3, 4]) {
        const flight = fly({ hz: 120, durationMs: 60_000, seed, busyStartup, stamps: firefox(true), heavy: always, cost: MEDIUM });
        expect(wrongShare(flight), `seed ${seed}${busyStartup ? ", busy" : ""}`).toBeLessThan(MAX_WRONG_SHARE);
        expect(flight.pacer.currentCadence).toMatchObject({ divisor: 2, displayPeriodMs: 1_000 / 120, periodConfirmed: true });
      }
    }
  });

  it("keep 144 and 165 Hz at every 2nd refresh, shifted early or either way", () => {
    for (const hz of [144, 165]) {
      for (const early of [true, false]) {
        for (const seed of [1, 2]) {
          const flight = fly({ hz, durationMs: 40_000, seed, busyStartup: true, stamps: firefox(early), heavy: always, cost: TWO });
          expect(wrongShare(flight), `${hz} Hz seed ${seed}`).toBeLessThan(MAX_WRONG_SHARE);
          expect(flight.pacer.currentCadence).toMatchObject({ divisor: 2, displayPeriodMs: 1_000 / hz });
        }
      }
    }
  });

  it("draw no earlier and miss no more frames than the true cadence would", () => {
    // The render rule misses a due tick stamped over half a refresh early
    // whatever the period: that floor is the true cadence's. The pacer's
    // early frames and misses stay on it, within one frame in a thousand.
    for (const hz of [120, 144, 165]) {
      for (const cost of [TWO, MEDIUM]) {
        for (const seed of [1, 2]) {
          const options = { hz, durationMs: 40_000, seed, busyStartup: true, stamps: firefox(true), heavy: always, cost };
          const flight = fly(options);
          const floor = fly({ ...options, oracle: true });
          const slack = Math.max(1, flight.frames / 1_000);
          expect(flight.early, `${hz} Hz seed ${seed} early`).toBeLessThanOrEqual(floor.early + slack);
          expect(flight.missed, `${hz} Hz seed ${seed} missed`).toBeLessThanOrEqual(floor.missed + slack);
        }
      }
    }
  });
});

describe("dense stamp jitter", () => {
  it("keeps 240 Hz at every 4th refresh with ±1.5 ms stamps under High load", () => {
    for (const seed of [1, 2, 3, 4]) {
      const flight = fly({ hz: 240, durationMs: 40_000, seed, stamps: uniform(1.5), cost: HIGH });
      expect(wrongShare(flight), `seed ${seed}`).toBeLessThan(MAX_WRONG_SHARE);
      expect(flight.pacer.currentCadence).toMatchObject({ divisor: 4 });
    }
  });

  it("never reads a Chrome catch-up callback as a slower display", () => {
    // After a long frame, 5% of next vsyncs call back twice: a late callback
    // stamped just before the vsync, then the vsync's own.
    for (const seed of [1, 2, 3]) {
      const flight = fly({ hz: 165, durationMs: 40_000, seed, busyStartup: true, cost: TWO, doubleCallbacks: 0.05 });
      expect(wrongShare(flight), `seed ${seed}`).toBeLessThan(MAX_WRONG_SHARE);
    }
  });
});

describe("a display that changes rate mid-flight", () => {
  const SWITCH_MS = 20_000;
  const pause = (ms: number): boolean => ms >= 23_000 && ms < 24_000;

  it("follows 120 to 100, 144 to 120 and 60 to 120 Hz within 2 s at light load", () => {
    // Each new rate shows in the deltas: a tick the old divisor skips, or a
    // faster period.
    for (const [hz, toHz] of [[120, 100], [144, 120], [60, 120]] as const) {
      for (const stamps of [firefox(true), uniform(0.5)]) {
        for (const seed of [1, 2]) {
          const flight = fly({ hz, toHz, switchAtMs: SWITCH_MS, durationMs: 30_000, seed, stamps });
          expect(flight.rightFromMs, `${hz} to ${toHz} Hz, seed ${seed}`).not.toBeNull();
          expect(flight.rightFromMs!).toBeLessThanOrEqual(SWITCH_MS + 2_000);
          expect(flight.pacer.currentCadence).toMatchObject({ displayPeriodMs: 1_000 / toHz, periodConfirmed: true });
        }
      }
    }
  });

  it("follows 120 to 100, 144 to 120, 60 to 120 and 120 to 60 Hz by a pause's re-probe, within 1 s of it", () => {
    for (const [hz, toHz] of [[120, 100], [144, 120], [60, 120], [120, 60]] as const) {
      for (const seed of [1, 2, 3]) {
        const flight = fly({ hz, toHz, switchAtMs: SWITCH_MS, durationMs: 30_000, seed, stamps: firefox(true), paused: pause });
        expect(flight.rightFromMs, `${hz} to ${toHz} Hz, seed ${seed}`).not.toBeNull();
        expect(flight.rightFromMs!).toBeLessThanOrEqual(24_000);
        expect(flight.thirdMs).toBe(0);
        expect(flight.pacer.currentCadence).toMatchObject({ displayPeriodMs: 1_000 / toHz, periodConfirmed: true });
      }
    }
  });

  it("draws every tick after 120 to 60 Hz with no pause, through no third rate", () => {
    // Every 60 Hz tick is one the 120 Hz divisor draws anyway, so no tick
    // tells the two apart until a pause re-probes: the frames are right.
    for (const seed of [1, 2]) {
      const flight = fly({ hz: 120, toHz: 60, switchAtMs: SWITCH_MS, durationMs: 30_000, seed, stamps: uniform(0.5) });
      expect(flight.thirdMs).toBe(0);
      expect(flight.unpausedSkipsMs.filter((ms) => ms >= SWITCH_MS + 100)).toEqual([]);
    }
  });

  it("follows 120 to 100 Hz once two-refresh frames lighten, through no third rate", () => {
    for (const seed of [1, 2, 3]) {
      const flight = fly({
        hz: 120, toHz: 100, switchAtMs: SWITCH_MS, durationMs: 32_000, seed, stamps: firefox(true),
        heavy: (ms) => ms < 26_000, cost: until(26_000, TWO),
      });
      expect(flight.thirdMs).toBeLessThanOrEqual(1_000);
      expect(flight.rightFromMs).not.toBeNull();
      expect(flight.rightFromMs!).toBeLessThanOrEqual(28_000);
    }
  });

  it("follows 60 to 144 Hz under two-refresh frames without settling on 72 Hz", () => {
    // Frames of two 144 Hz refreshes come every 13.9 ms, as a 72 Hz display's.
    for (const seed of [1, 2, 3]) {
      const flight = fly({
        hz: 60, toHz: 144, switchAtMs: SWITCH_MS, durationMs: 32_000, seed, stamps: uniform(0.5),
        heavy: (ms) => ms < 26_000, cost: (u, ms) => (ms >= SWITCH_MS && ms < 26_000 ? 2 : 1),
      });
      expect(flight.thirdMs).toBeLessThanOrEqual(1_000);
      expect(flight.rightFromMs).not.toBeNull();
      expect(flight.rightFromMs!).toBeLessThanOrEqual(28_000);
    }
  });

  it("measures 60 to 144 Hz under two-refresh frames with a bounded number of flagged check skips", () => {
    // A 72 Hz reading draws every tick at the 60 setting, so no skip of its
    // own tests it: the pacer skips a few ticks to read one refresh, and
    // flags the drawn tick after each.
    for (const seed of [1, 2, 3]) {
      const flight = fly({
        hz: 60, toHz: 144, switchAtMs: SWITCH_MS, durationMs: 26_000, seed, stamps: firefox(true),
        heavy: always, cost: until(SWITCH_MS, ONE, TWO),
      });
      expect(flight.unpausedFlags).toBeLessThanOrEqual(24);
      expect(flight.thirdMs).toBeLessThanOrEqual(1_000);
    }
  });

  it("never skips a tick to measure the display at Match display, even mid-check", () => {
    const options = {
      hz: 60, toHz: 144, switchAtMs: SWITCH_MS, durationMs: 26_000, stamps: firefox(true),
      heavy: always, cost: until(SWITCH_MS, ONE, TWO),
    };
    for (const seed of [1, 2]) {
      const throughout = fly({ ...options, seed, setting: "display" });
      expect(throughout.unpausedSkipsMs).toEqual([]);
      expect(throughout.unpausedFlags).toBe(0);
      // The same flight at 60 until its first check skip, then Match display:
      // the checks left are not spent there.
      const checked = fly({ ...options, seed });
      const firstCheckMs = checked.unpausedSkipsMs.find((ms) => ms >= SWITCH_MS);
      expect(firstCheckMs, `seed ${seed}`).toBeDefined();
      const changed = fly({ ...options, seed, setting: (ms) => (ms <= firstCheckMs! ? "60" : "display") });
      expect(changed.unpausedSkipsMs.filter((ms) => ms > firstCheckMs!)).toEqual([]);
    }
  });

  it("withdraws a 165 Hz confirmation the ticks contradict after a switch to 60 Hz, and re-measures on the pause", () => {
    // Every 60 Hz tick is one the 165 Hz divisor draws anyway, so the ticks
    // cannot say which rate it is, only that it is not 165 Hz.
    for (const seed of [1, 2]) {
      const flight = fly({ hz: 165, toHz: 60, switchAtMs: SWITCH_MS, durationMs: 32_000, seed, stamps: uniform(0.5) });
      for (const { ms, cadence } of flight.changes.filter((change) => change.ms >= SWITCH_MS)) {
        const hz = 1_000 / cadence.displayPeriodMs!;
        // The new rate, or the old one unconfirmed: never a third rate, never 165 Hz confirmed again.
        expect(Math.abs(hz - 60) < 2 || (Math.abs(hz - 165) < 2 && !cadence.periodConfirmed), `${ms} ms`).toBe(true);
      }
      expect(flight.pacer.currentCadence?.periodConfirmed === false || flight.rightFromMs !== null).toBe(true);
      const paused = fly({ hz: 165, toHz: 60, switchAtMs: SWITCH_MS, durationMs: 30_000, seed, stamps: uniform(0.5), paused: pause });
      expect(paused.rightFromMs).not.toBeNull();
      expect(paused.rightFromMs!).toBeLessThanOrEqual(24_000);
      expect(paused.pacer.currentCadence).toMatchObject({ divisor: 1, displayPeriodMs: 1_000 / 60, periodConfirmed: true });
    }
  });

  it("follows a display that slows with no pause within 2 s, confirmed, wherever its ticks show it", () => {
    // A skipped tick draws nothing, so the next comes one new refresh after
    // it: skips past the old clean margin, or drawn ticks the old divisor
    // waited for, say the display slowed.
    const cases = [[240, 144, "60"], [240, 120, "60"], [165, 120, "60"], [144, 100, "60"], [120, 60, "30"], [165, 60, "30"]] as const;
    for (const [hz, toHz, setting] of cases) {
      for (const stamps of [exact, firefox(true), uniform(0.5)]) {
        const flight = fly({ hz, toHz, switchAtMs: SWITCH_MS, durationMs: 30_000, setting, stamps });
        expect(flight.rightFromMs, `${hz} to ${toHz} Hz at ${setting}`).not.toBeNull();
        expect(flight.rightFromMs!, `${hz} to ${toHz} Hz at ${setting}`).toBeLessThanOrEqual(SWITCH_MS + 2_000);
        expect(flight.thirdMs).toBe(0);
        expect(flight.pacer.currentCadence).toMatchObject({ displayPeriodMs: 1_000 / toHz, periodConfirmed: true });
      }
    }
  });

  it("moves to a rate under 10% slower once, without confirming and withdrawing it over and over", () => {
    // Skips of 110 Hz confirm nothing at 120 Hz: they are 9% off, more than
    // jitter makes, and every tick sits on 110 Hz's grid instead.
    for (const [hz, toHz] of [[120, 110], [144, 133], [165, 155]] as const) {
      for (const setting of ["60", "30"] as const) {
        const flight = fly({ hz, toHz, switchAtMs: SWITCH_MS, durationMs: 50_000, setting });
        expect(flight.changes.length, `${hz} to ${toHz} Hz at ${setting}`).toBeLessThanOrEqual(3);
        expect(flight.rightFromMs, `${hz} to ${toHz} Hz at ${setting}`).not.toBeNull();
        expect(flight.rightFromMs!).toBeLessThanOrEqual(SWITCH_MS + 2_000);
        expect(1_000 / flight.pacer.currentCadence!.displayPeriodMs!).toBeCloseTo(toHz, 1);
        expect(flight.pacer.currentCadence?.periodConfirmed).toBe(true);
      }
    }
  });

  it("keeps a rate its skips found through a 300 ms stall, and through two-refresh frames after it", () => {
    // The stall resets the timing: the startup probe's period must not come
    // back as clean evidence of the rate the display left.
    const cases = [
      { hz: 120, toHz: 100 },
      { hz: 144, toHz: 120, cost: until(25_000, ONE, TWO) },
    ];
    for (const { hz, toHz, cost } of cases) {
      for (const seed of [1, 2]) {
        const flight = fly({
          hz, toHz, switchAtMs: SWITCH_MS, durationMs: 40_000, seed, stamps: uniform(0.3), stall: [30_000, 300], ...(cost ? { cost } : {}),
        });
        expect(flight.rightFromMs, `${hz} to ${toHz} Hz, seed ${seed}`).not.toBeNull();
        expect(flight.rightFromMs!, `${hz} to ${toHz} Hz, seed ${seed}`).toBeLessThanOrEqual(SWITCH_MS + 2_000);
        expect(ratesOf(flight)).toEqual([hz, toHz]);
      }
    }
  });

  it("follows 60 to 144 and 100 to 120 Hz within 2 s under ±1.5 ms stamps, where few deltas are quiet", () => {
    // ±1.5 ms either way is a fifth of a 144 Hz refresh: a quiet delta, both
    // neighbours within 15% of it, is rare, but most spans of four are short.
    for (const [hz, toHz] of [[60, 144], [100, 120]] as const) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const flight = fly({ hz, toHz, switchAtMs: 10_000, durationMs: 16_000, seed, stamps: uniform(1.5) });
        expect(flight.rightFromMs, `${hz} to ${toHz} Hz, seed ${seed}`).not.toBeNull();
        expect(flight.rightFromMs!, `${hz} to ${toHz} Hz, seed ${seed}`).toBeLessThanOrEqual(12_000);
      }
    }
  });

  it("confirms no third rate when 120 Hz becomes 240 Hz under High load and Firefox's stamps", () => {
    // Frames of three and four refreshes leave skips that slide from one
    // rate's period to the other's: a rate between them must hold the ticks.
    // The old rate may stay: frames that long hide the new one.
    for (let seed = 1; seed <= 12; seed += 1) {
      const flight = fly({ hz: 120, toHz: 240, switchAtMs: SWITCH_MS, durationMs: 60_000, seed, stamps: firefox(true), heavy: always, cost: HIGH });
      expect(flight.thirdMs, `seed ${seed}`).toBeLessThanOrEqual(1_000);
    }
  });
});

describe("displays at rates no common one is", () => {
  it("draw 112, 175 and 222 Hz at \"60\" and 160 Hz at \"30\" by their own rate, not the nearest common one", () => {
    // 175 Hz read as 180 drew every 3rd refresh (58 fps); 112 read as 120
    // drew every 2nd (56) and kept re-emitting the cadence.
    const cases = [[112, "60"], [175, "60"], [222, "60"], [160, "30"]] as const;
    for (const [hz, setting] of cases) {
      for (const stamps of [exact, firefox(true)]) {
        const flight = fly({ hz, durationMs: 20_000, setting, stamps });
        expect(wrongShare(flight), `${hz} Hz at ${setting}`).toBeLessThan(MAX_WRONG_SHARE);
        expect(flight.changes.length, `${hz} Hz at ${setting}`).toBeLessThanOrEqual(2);
        expect(flight.pacer.currentCadence).toMatchObject({ divisor: divisorFor(setting, hz), periodConfirmed: true });
      }
    }
  });
});

describe("steady flights", () => {
  it("skip no frame outside a pause to measure the display", () => {
    for (const hz of [60, 120, 144, 165, 240]) {
      for (const cost of [ONE, MEDIUM]) {
        const flight = fly({ hz, durationMs: 30_000, stamps: firefox(true), heavy: always, cost });
        expect(flight.unpausedFlags, `${hz} Hz`).toBe(0);
        expect(wrongShare(flight), `${hz} Hz`).toBeLessThan(MAX_WRONG_SHARE);
      }
    }
  });

  it("confirm 60 Hz from a lead cut to 18 ticks by its 300 ms limit, then a busy startup", () => {
    for (const seed of [1, 2, 3, 4]) {
      const flight = fly({ hz: 60, durationMs: 30_000, seed, leadTicks: 18, busyStartup: true, stamps: firefox(true), heavy: always, cost: MEDIUM });
      expect(wrongShare(flight), `seed ${seed}`).toBeLessThan(MAX_WRONG_SHARE);
      expect(flight.pacer.currentCadence).toMatchObject({ divisor: 1, displayPeriodMs: 1_000 / 60 });
    }
  });

  it("hold a display 0.1% below its nominal rate (59.94, 119.88, 239.76 Hz)", () => {
    for (const hz of [59.94, 119.88, 239.76]) {
      const flight = fly({ hz, durationMs: 40_000, stamps: uniform(0.5), cost: MEDIUM });
      expect(wrongShare(flight), `${hz} Hz`).toBeLessThan(MAX_WRONG_SHARE);
    }
  });
});
