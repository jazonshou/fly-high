import { describe, expect, it } from "vitest";
import { divisorFor, FramePacer, IDLE_PROBE_LEAD_TICKS, REPROBE_TICKS } from "../src/game/framePacer";
import type { CadenceFallbackRequest } from "../src/render/webgpu/core/AdaptiveGovernor";
import {
  fallbackDivisorFor,
  fallbackDivisorRange,
  SLOWEST_TRUSTED_DISPLAY_PERIOD_MS,
  type PresentationCadence,
} from "../src/render/webgpu/core/presentationCadence";
import type { FrameRateSetting } from "../src/settings";

/**
 * PR B part 2b (G6, design §21.3 and §21.5): the frame pacer applies the
 * governor's even fallback. The governor asks; the pacer decides. Only under
 * "60 fps", only with an even divisor above its own, the fastest the host's
 * mean interval fits, and only on a confirmed period the governor trusts.
 * Switching in or out never draws a frame early, and the skips the fallback
 * makes are the pacer's own, so they measure the display as the 30 fps
 * setting's do.
 *
 * A display ticks at a fixed rate with the deterministic stamp jitter of
 * the G6 prototype's pacer check (±0.4 ms); a drawn frame that costs more
 * than a refresh pushes the next tick to the vsync after it. Every pacer
 * here paces the 60 setting explicitly, as `game.frame-pacer.test.ts` does.
 */

interface FlightOptions {
  readonly ticks?: number;
  /** The startup probe's quiet lead before the first game tick, which confirms the period. */
  readonly probe?: boolean;
  readonly setting?: (tick: number) => FrameRateSetting;
  readonly request?: (tick: number) => CadenceFallbackRequest | null;
  readonly paused?: (tick: number) => boolean;
  /** A drawn frame's cost: the next tick waits for the vsync after it. */
  readonly costMs?: number;
  /** Stamp jitter in ms on a tick. */
  readonly jitter?: (tick: number) => number;
  /** The display's rate from a tick on (default `hz` throughout). */
  readonly hzAt?: (tick: number) => number;
  readonly pacer?: FramePacer;
  readonly startMs?: number;
}

interface Frame {
  readonly tick: number;
  readonly ms: number;
  /** The divisor of the cadence in force on the tick that drew it, and the period the pacer held. */
  readonly divisor: number;
  readonly pacedPeriodMs: number;
  /** The display's period on that tick. */
  readonly periodMs: number;
  readonly afterReprobe: boolean;
}

interface Flight {
  readonly pacer: FramePacer;
  readonly frames: Frame[];
  readonly cadences: { readonly tick: number; readonly cadence: PresentationCadence }[];
  readonly endMs: number;
}

const sineJitter = (tick: number): number => Math.sin(tick * 7.1) * 0.4;

function fly(hz: number, options: FlightOptions = {}): Flight {
  const pacer = options.pacer ?? new FramePacer({ pace60: true });
  const jitter = options.jitter ?? sineJitter;
  let vsync = options.startMs ?? 1_000;
  if (options.probe ?? true) {
    for (let tick = 0; tick < IDLE_PROBE_LEAD_TICKS; tick += 1) {
      pacer.probe(vsync + jitter(tick), true);
      vsync += 1_000 / hz;
    }
  }
  const frames: Frame[] = [];
  const cadences: { tick: number; cadence: PresentationCadence }[] = [];
  for (let tick = 0; tick < (options.ticks ?? hz * 6); tick += 1) {
    const periodMs = 1_000 / (options.hzAt?.(tick) ?? hz);
    const now = vsync + jitter(tick);
    const result = pacer.tick(
      now,
      options.setting?.(tick) ?? "60",
      options.paused?.(tick) ?? false,
      options.request?.(tick) ?? null,
    );
    if (result.cadence !== null) cadences.push({ tick, cadence: result.cadence });
    let refreshes = 1;
    if (result.render) {
      // Before the first estimate there is no cadence: every tick draws.
      const cadence = pacer.currentCadence;
      frames.push({
        tick,
        ms: now,
        divisor: cadence?.divisor ?? 1,
        pacedPeriodMs: cadence?.displayPeriodMs ?? periodMs,
        periodMs,
        afterReprobe: result.afterReprobe,
      });
      refreshes = Math.max(1, Math.ceil((options.costMs ?? 0) / periodMs - 1e-9));
    }
    vsync += refreshes * periodMs;
  }
  return { pacer, frames, cadences, endMs: vsync };
}

/** Each drawn frame after the first from `fromTick` on, with its interval in refreshes of the display. */
function gaps(flight: Flight, fromTick = 0): { readonly frame: Frame; readonly refreshes: number; readonly ms: number }[] {
  const out: { frame: Frame; refreshes: number; ms: number }[] = [];
  for (let index = 1; index < flight.frames.length; index += 1) {
    const frame = flight.frames[index]!;
    if (flight.frames[index - 1]!.tick < fromTick) continue;
    const ms = frame.ms - flight.frames[index - 1]!.ms;
    out.push({ frame, refreshes: Math.round(ms / frame.periodMs), ms });
  }
  return out;
}

function cadenceOf(
  divisor: number,
  hz: number,
  periodConfirmed: boolean,
  frameCapHz: PresentationCadence["frameCapHz"] = 60,
  fallbackHz?: number,
): PresentationCadence {
  return {
    frameCapHz,
    divisor,
    displayPeriodMs: 1_000 / hz,
    periodConfirmed,
    ...(fallbackHz !== undefined ? { fallbackHz } : {}),
  };
}

const request = (minIntervalMs = 0, hz = 30): CadenceFallbackRequest => ({ hz, minIntervalMs });

/**
 * Design §21.5: [refresh Hz, the rate drawn when the host's mean fits the
 * faster neighbour's interval, the rate when it does not]; null where no
 * fallback applies. The divisors are generated from `fallbackDivisorRange`
 * below, so the pacer cannot drift from the rule the governor gates on.
 */
const TABLE: readonly [number, number | null, number | null][] = [
  [60, 30, 30],
  [75, 37.5, 25],
  [90, 30, 30],
  [100, 100 / 3, 100 / 3],
  [120, 30, 30],
  [144, 36, 28.8],
  [165, 33, 27.5],
  [240, 30, 30],
  // The range is [2, 2], but a 50 Hz period is not one the governor trusts.
  [50, null, null],
  // No even divisor above the paced one.
  [30, null, null],
];

describe("the even fallback's divisor, as the pacer applies it", () => {
  for (const [hz, fitsFps, doesNotFps] of TABLE) {
    it(`${hz} Hz: ${fitsFps === null ? "no fallback" : `${fitsFps.toFixed(1)} or ${doesNotFps!.toFixed(1)} fps`}`, () => {
      const periodMs = 1_000 / hz;
      const paced = divisorFor("60", hz);
      const range = fallbackDivisorRange(hz, 30, paced);
      const trusted = periodMs <= SLOWEST_TRUSTED_DISPLAY_PERIOD_MS;
      expect(range !== null && trusted, "the table says whether one applies").toBe(fitsFps !== null);
      // Below and above the faster neighbour's interval: the host's mean fits it, or does not.
      const faster = (range?.[0] ?? paced) * periodMs;
      const cases: readonly [number, number | null][] = [[faster - 1, fitsFps], [faster + 1, doesNotFps]];
      for (const [minIntervalMs, fps] of cases) {
        const flight = fly(hz, { request: () => request(minIntervalMs) });
        const divisor = range !== null && trusted ? fallbackDivisorFor(range, periodMs, minIntervalMs) : paced;
        const label = `${hz} Hz, min interval ${minIntervalMs.toFixed(2)} ms`;
        if (fps === null) {
          expect(divisor, label).toBe(paced);
        } else {
          expect(hz / divisor, label).toBeCloseTo(fps, 9);
        }
        expect(flight.pacer.currentCadence, label).toStrictEqual(
          cadenceOf(divisor, hz, true, 60, divisor > paced ? hz / divisor : undefined),
        );
        // One cadence, from the first tick: the request was there before it.
        expect(flight.cadences, label).toHaveLength(1);
        // Evenly spaced at the divisor, every frame.
        expect(new Set(gaps(flight).map(({ refreshes }) => refreshes)), label).toEqual(new Set([divisor]));
      }
    });
  }

  it("reports the rate it draws unrounded, the refresh over the divisor (100 Hz: 33.3 fps)", () => {
    const flight = fly(100, { request: () => request() });
    expect(flight.pacer.currentCadence?.fallbackHz).toBe(100 / 3);
  });
});

describe("where the pacer ignores a request", () => {
  it("draws every refresh under Match display", () => {
    const flight = fly(60, { setting: () => "display", request: () => request() });
    expect(flight.pacer.currentCadence).toStrictEqual(cadenceOf(1, 60, true, null));
    expect(flight.frames).toHaveLength(360);
  });

  it("keeps the 30 fps setting's own round, the player's choice", () => {
    // 75 Hz: the fallback would take 37.5 fps for a host that fits it; "30 fps" keeps 25.
    const flight = fly(75, { setting: () => "30", request: () => request() });
    expect(flight.pacer.currentCadence).toStrictEqual(cadenceOf(3, 75, true, 30));
    expect(new Set(gaps(flight).map(({ refreshes }) => refreshes))).toEqual(new Set([3]));
  });

  it("has nothing to fall back to where the range is empty", () => {
    // A 30 Hz rAF throttle, and a request for a rate the setting already draws.
    expect(fly(30, { request: () => request() }).pacer.currentCadence).toStrictEqual(cadenceOf(1, 30, true));
    const sixty = fly(60, { request: () => request(0, 60) });
    expect(sixty.pacer.currentCadence).toStrictEqual(cadenceOf(1, 60, true));
    expect(sixty.frames).toHaveLength(360);
  });

  it("applies none on a period it has not confirmed, nor on one the governor does not trust", () => {
    // 60 Hz drawn every tick with no probe: never confirmed.
    const unconfirmed = fly(60, { probe: false, request: () => request() });
    expect(unconfirmed.pacer.currentCadence).toStrictEqual(cadenceOf(1, 60, false));
    expect(unconfirmed.frames).toHaveLength(360);
    // 50 Hz, confirmed by the probe: slower than the governor trusts under "60 fps".
    const fifty = fly(50, { request: () => request() });
    expect(fifty.pacer.currentCadence).toStrictEqual(cadenceOf(1, 50, true));
    expect(fifty.frames).toHaveLength(300);
  });

  it("waits for the confirmation before it applies one", () => {
    // 120 Hz with no probe: measured at once, confirmed by the ticks the 60
    // setting skips; only the confirmed period takes the fallback.
    const flight = fly(120, { probe: false, request: () => request() });
    expect(flight.cadences.map(({ cadence }) => cadence)).toStrictEqual([
      cadenceOf(2, 120, false),
      cadenceOf(4, 120, true, 60, 30),
    ]);
  });

  it("leaves the setting's cadence for a malformed request, and keeps drawing", () => {
    for (const bad of [request(0, 0), request(0, -30), request(0, Number.NaN), request(Number.NaN)]) {
      const flight = fly(60, { request: () => bad });
      expect(flight.pacer.currentCadence, JSON.stringify(bad)).toStrictEqual(cadenceOf(1, 60, true));
      expect(flight.frames).toHaveLength(360);
    }
  });

  it("drops the fallback on the tick the setting leaves 60 fps", () => {
    const flight = fly(60, {
      ticks: 600,
      setting: (tick) => (tick < 200 ? "60" : tick < 400 ? "display" : "30"),
      request: () => request(),
    });
    expect(flight.cadences.map(({ tick, cadence }) => [tick, cadence])).toStrictEqual([
      [0, cadenceOf(2, 60, true, 60, 30)],
      [200, cadenceOf(1, 60, true, null)],
      [400, cadenceOf(2, 60, true, 30)],
    ]);
  });
});

describe("the cadence's shape", () => {
  it("omits fallbackHz when no fallback applies, before and after one", () => {
    const flight = fly(60, { ticks: 600, request: (tick) => (tick >= 200 && tick < 400 ? request() : null) });
    expect(flight.cadences.map(({ tick }) => tick)).toEqual([0, 200, 400]);
    const [before, during, after] = flight.cadences.map(({ cadence }) => cadence);
    expect(during).toStrictEqual(cadenceOf(2, 60, true, 60, 30));
    expect(Object.isFrozen(during)).toBe(true);
    for (const plain of [before, after]) {
      expect(Object.keys(plain!)).not.toContain("fallbackHz");
      expect(plain).toStrictEqual(cadenceOf(1, 60, true));
    }
  });

  it("emits a new cadence when only the host's interval moves the divisor", () => {
    // 75 Hz: 37.5 fps while the host's mean fits 26.67 ms, 25 once it does not.
    const flight = fly(75, { ticks: 600, request: (tick) => request(tick < 300 ? 22 : 30) });
    expect(flight.cadences.map(({ tick, cadence }) => [tick, cadence])).toStrictEqual([
      [0, cadenceOf(2, 75, true, 60, 37.5)],
      [300, cadenceOf(3, 75, true, 60, 25)],
    ]);
  });
});

describe("no early frame", () => {
  // The G6 prototype's pacer check: the fallback from 2 s to 4 s of a 6 s flight.
  const twoToFour = (hz: number) => (tick: number): CadenceFallbackRequest | null =>
    tick >= 2 * hz && tick < 4 * hz ? request() : null;

  for (const hz of [60, 75, 120, 144, 165, 50, 48]) {
    it(`${hz} Hz: never closer than N - 0.5 refreshes, and even while the fallback holds`, () => {
      const flight = fly(hz, { request: twoToFour(hz) });
      const paced = divisorFor("60", hz);
      const periodMs = 1_000 / hz;
      const range = fallbackDivisorRange(hz, 30, paced);
      const applies = range !== null && periodMs <= SLOWEST_TRUSTED_DISPLAY_PERIOD_MS;
      const fallback = applies ? range[0] : paced;
      const all = gaps(flight);
      for (const { frame, ms } of all) {
        expect(ms, `${hz} Hz, tick ${frame.tick}`).toBeGreaterThanOrEqual((frame.divisor - 0.5) * frame.pacedPeriodMs);
      }
      // Every interval is the paced one, the fallback's, or one between them
      // (leaving the fallback mid-interval): no long frame at either switch.
      for (const { frame, refreshes } of all) {
        expect(refreshes, `${hz} Hz, tick ${frame.tick}`).toBeGreaterThanOrEqual(paced);
        expect(refreshes, `${hz} Hz, tick ${frame.tick}`).toBeLessThanOrEqual(fallback);
      }
      const during = all.filter(({ frame }) => frame.tick > 2 * hz + fallback && frame.tick < 4 * hz);
      expect(during.length).toBeGreaterThan(0);
      expect(new Set(during.map(({ refreshes }) => refreshes))).toEqual(new Set([fallback]));
      const after = all.filter(({ frame }) => frame.tick > 4 * hz + fallback);
      expect(new Set(after.map(({ refreshes }) => refreshes))).toEqual(new Set([paced]));
      // The switch itself draws the fallback's first frame a whole fallback interval after the last paced one.
      const first = all.find(({ frame }) => frame.tick >= 2 * hz)!;
      expect(first.refreshes).toBe(fallback);
    });
  }

  it("moves to the slower divisor without an early frame (75 Hz: 2, then 3; 144 Hz: 4, then 5)", () => {
    for (const [hz, fits, fitsNot] of [[75, 22, 30], [144, 27, 30]] as const) {
      const flight = fly(hz, { request: (tick) => request(tick < 3 * hz ? fits : fitsNot) });
      const all = gaps(flight);
      for (const { frame, ms } of all) {
        expect(ms, `${hz} Hz, tick ${frame.tick}`).toBeGreaterThanOrEqual((frame.divisor - 0.5) * frame.pacedPeriodMs);
      }
      const range = fallbackDivisorRange(hz, 30, divisorFor("60", hz))!;
      expect(new Set(all.filter(({ frame }) => frame.tick < 3 * hz).map(({ refreshes }) => refreshes))).toEqual(new Set([range[0]]));
      expect(new Set(all.filter(({ frame }) => frame.tick >= 3 * hz).map(({ refreshes }) => refreshes))).toEqual(new Set([range[1]]));
    }
  });

  it("ignores the request at Match display and 30 fps, so nothing switches", () => {
    for (const setting of ["display", "30"] as const) {
      const flight = fly(60, { setting: () => setting, request: twoToFour(60) });
      expect(flight.cadences, setting).toHaveLength(1);
      const divisor = divisorFor(setting, 60);
      expect(new Set(gaps(flight).map(({ refreshes }) => refreshes)), setting).toEqual(new Set([divisor]));
    }
  });
});

describe("the period under a fallback", () => {
  // The fallback's skips are the pacer's own: a fast host's skipped ticks
  // confirm the display as the 30 fps setting's do, and a slow host's frames
  // of two refreshes say nothing new. Neither may move or withdraw the rate.
  const hosts: readonly [number, number][] = [[60, 0], [60, 12], [60, 22], [60, 30], [120, 0], [120, 22], [144, 30]];
  for (const [hz, costMs] of hosts) {
    it(`${hz} Hz, frames of ${costMs} ms: 60 s at the fallback keep the rate and its confirmation`, () => {
      const flight = fly(hz, { ticks: hz * 60, costMs, request: () => request(costMs) });
      expect(flight.cadences, `${hz} Hz at ${costMs} ms`).toHaveLength(1);
      const cadence = flight.pacer.currentCadence!;
      expect(cadence.displayPeriodMs).toBe(1_000 / hz);
      expect(cadence.periodConfirmed).toBe(true);
      expect(cadence.fallbackHz).toBeDefined();
    });
  }

  it("holds the rate and its confirmation through heavy stamp jitter", () => {
    for (const [hz, jitterMs] of [[60, 1.5], [120, 1.5], [144, 1], [240, 1.5]] as const) {
      for (let seed = 1; seed <= 3; seed += 1) {
        let state = seed;
        const random = (): number => {
          state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
          return state / 2_147_483_648;
        };
        const flight = fly(hz, { ticks: hz * 60, jitter: () => (random() - 0.5) * 2 * jitterMs, request: () => request() });
        const label = `${hz} Hz ±${jitterMs} ms, seed ${seed}`;
        expect(flight.cadences, label).toHaveLength(1);
        expect(flight.pacer.currentCadence?.displayPeriodMs, label).toBe(1_000 / hz);
        expect(flight.pacer.currentCadence?.periodConfirmed, label).toBe(true);
        for (const { frame, ms } of gaps(flight)) {
          expect(ms, `${label}, tick ${frame.tick}`).toBeGreaterThanOrEqual((frame.divisor - 0.5) * frame.pacedPeriodMs);
        }
      }
    }
  });

  it("follows the display to a new rate and takes the fallback there", () => {
    // 60 Hz, then 120 Hz from the 5th second: the skips of the fallback measure it.
    const up = fly(60, { ticks: 1_500, hzAt: (tick) => (tick < 300 ? 60 : 120), request: () => request() });
    expect(up.pacer.currentCadence).toStrictEqual(cadenceOf(4, 120, true, 60, 30));
    // And down again, from 120 Hz to 60 Hz.
    const down = fly(120, { ticks: 1_500, hzAt: (tick) => (tick < 600 ? 120 : 60), request: () => request() });
    expect(down.pacer.currentCadence).toStrictEqual(cadenceOf(2, 60, true, 60, 30));
    // Never early on the period the pacer held, while it learned the new one.
    for (const flight of [up, down]) {
      for (const { frame, ms } of gaps(flight)) {
        expect(ms, `tick ${frame.tick}`).toBeGreaterThanOrEqual((frame.divisor - 0.5) * frame.pacedPeriodMs);
      }
    }
  });
});

describe("resets and pauses", () => {
  it("keeps the cadence, fallbackHz with it, across a reset, and draws the next tick", () => {
    const before = fly(60, { ticks: 300, request: () => request() });
    const cadence = before.pacer.currentCadence;
    expect(cadence).toStrictEqual(cadenceOf(2, 60, true, 60, 30));
    before.pacer.reset();
    expect(before.pacer.currentCadence).toBe(cadence);
    const after = fly(60, { pacer: before.pacer, probe: false, startMs: before.endMs + 2_000, ticks: 300, request: () => request() });
    expect(after.cadences).toEqual([]);
    expect(before.pacer.currentCadence).toBe(cadence);
    expect(after.frames[0]!.tick).toBe(0);
    expect(new Set(gaps(after).map(({ refreshes }) => refreshes))).toEqual(new Set([2]));
  });

  it("lets the paused re-probe skip its ticks whatever the request", () => {
    // Applied before the pause, and first asked on the pause's own tick.
    for (const from of [0, 300]) {
      const flight = fly(60, {
        ticks: 600,
        paused: (tick) => tick >= 300 && tick < 450,
        request: (tick) => (tick >= from ? request() : null),
      });
      const drawn = flight.frames.map(({ tick }) => tick);
      expect(drawn.filter((tick) => tick >= 300 && tick < 300 + REPROBE_TICKS), `from ${from}`).toEqual([]);
      expect(flight.frames.filter(({ afterReprobe }) => afterReprobe).map(({ tick }) => tick)).toEqual([300 + REPROBE_TICKS]);
      // Paused after the re-probe, and flying again: at the fallback's divisor.
      const later = gaps(flight, 300 + REPROBE_TICKS);
      expect(new Set(later.map(({ refreshes }) => refreshes)), `from ${from}`).toEqual(new Set([2]));
      expect(flight.pacer.currentCadence).toStrictEqual(cadenceOf(2, 60, true, 60, 30));
    }
  });
});
