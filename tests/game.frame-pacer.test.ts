import { describe, expect, it, vi } from "vitest";
import { estimateRefresh } from "../src/bench/stats";
import {
  divisorFor,
  effectiveFrameRate,
  estimatePeriodMs,
  FRAME_PACING_ENABLED,
  FramePacer,
  IDLE_PROBE_LEAD_MS,
  IDLE_PROBE_LEAD_TICKS,
  nominalHz,
  REPROBE_TICKS,
  startIdleProbe,
  type IdleProbeHost,
} from "../src/game/framePacer";
import type { PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import type { FrameRateSetting } from "../src/settings";

/**
 * The frame pacer (PR B, step 3.1) in simulation: a display ticks at a fixed
 * rate, each timestamp carries uniform jitter, and a rendered frame that
 * costs more than a refresh pushes the next tick to the next vsync after
 * it. Every test that paces "60" passes `pace60: true`, because shipping
 * keeps it off until the governor judges the paced cadence.
 */

interface FlightOptions {
  readonly ticks?: number;
  /** Uniform timestamp jitter, ± ms. */
  readonly jitterMs?: number;
  /** Idle startup probe ticks before the first game tick. */
  readonly probeTicks?: number;
  /** A rendered frame's cost: the next tick waits for the vsync after it. */
  readonly costMs?: number;
  /** The first rendered frame from this tick on takes three refreshes (25 ms at 120 Hz). */
  readonly dropAt?: number;
  readonly seed?: number;
  readonly pacer?: FramePacer;
  readonly startMs?: number;
  readonly paused?: (tick: number) => boolean;
  readonly setting?: (tick: number) => FrameRateSetting;
}

interface Flight {
  readonly pacer: FramePacer;
  /** Timestamps of the rendered ticks. */
  readonly rendered: number[];
  readonly renderedTicks: number[];
  readonly cadences: { readonly tick: number; readonly cadence: PresentationCadence }[];
  readonly endMs: number;
}

function fly(hz: number, setting: FrameRateSetting, options: FlightOptions = {}): Flight {
  const period = 1_000 / hz;
  const pacer = options.pacer ?? new FramePacer({ pace60: true });
  let seed = options.seed ?? 12_345;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const jitter = () => (options.jitterMs ? (random() - 0.5) * 2 * options.jitterMs : 0);
  let vsync = options.startMs ?? 1_000;
  for (let index = 0; index < (options.probeTicks ?? 0); index += 1) {
    pacer.probe(vsync + jitter());
    vsync += period;
  }
  const rendered: number[] = [];
  const renderedTicks: number[] = [];
  const cadences: { tick: number; cadence: PresentationCadence }[] = [];
  let dropped = false;
  for (let tick = 0; tick < (options.ticks ?? 3_600); tick += 1) {
    const now = vsync + jitter();
    const result = pacer.tick(now, options.setting?.(tick) ?? setting, options.paused?.(tick) ?? false);
    if (result.cadence !== null) cadences.push({ tick, cadence: result.cadence });
    let refreshes = 1;
    if (result.render) {
      rendered.push(now);
      renderedTicks.push(tick);
      refreshes = Math.max(1, Math.ceil((options.costMs ?? 0) / period - 1e-9));
      if (options.dropAt !== undefined && tick >= options.dropAt && !dropped) {
        refreshes = Math.max(refreshes, 3);
        dropped = true;
      }
    }
    vsync += refreshes * period;
  }
  return { pacer, rendered, renderedTicks, cadences, endMs: vsync };
}

/** Intervals between rendered frames from `fromTick` on. */
function intervals(flight: Flight, fromTick = 240): number[] {
  const out: number[] = [];
  for (let index = 1; index < flight.rendered.length; index += 1) {
    if (flight.renderedTicks[index - 1]! >= fromTick) out.push(flight.rendered[index]! - flight.rendered[index - 1]!);
  }
  return out;
}

function fps(flight: Flight, fromTick = 240): number {
  const values = intervals(flight, fromTick);
  return 1_000 / (values.reduce((sum, value) => sum + value, 0) / values.length);
}

function cadenceOf(
  frameCapHz: PresentationCadence["frameCapHz"],
  divisor: number,
  hz: number,
  periodConfirmed: boolean,
): PresentationCadence {
  return { frameCapHz, divisor, displayPeriodMs: 1_000 / hz, periodConfirmed };
}

describe("the divisor", () => {
  it("follows the owner's formulas on the nominal rate", () => {
    // [refresh, "60" divisor, "30" divisor] (PR B §5.4).
    const table: readonly [number, number, number][] = [
      [48, 1, 2], [50, 1, 2], [60, 1, 2], [75, 1, 3], [90, 1, 3], [100, 1, 3],
      [120, 2, 4], [144, 2, 5], [165, 2, 6], [180, 3, 6], [200, 3, 7], [240, 4, 8], [360, 6, 12],
    ];
    for (const [hz, sixty, thirty] of table) {
      expect(divisorFor("60", hz), `${hz} Hz at 60`).toBe(sixty);
      expect(divisorFor("30", hz), `${hz} Hz at 30`).toBe(thirty);
      expect(divisorFor("display", hz)).toBe(1);
    }
  });

  it("rounds the 30 setting half up, so the boundaries land the same way every time", () => {
    expect(divisorFor("30", 75)).toBe(3);
    expect(divisorFor("30", 165)).toBe(6);
    expect(divisorFor("30", 45)).toBe(2);
    expect(divisorFor("30", 105)).toBe(4);
  });

  it("absorbs measurement error just below 120 Hz at the 60 setting", () => {
    expect(divisorFor("60", 117)).toBe(2);
    expect(divisorFor("60", 116)).toBe(1);
    expect(divisorFor("60", 30)).toBe(1);
  });
});

describe("the nominal rate", () => {
  it("snaps to the nearest common rate within 2%", () => {
    expect(nominalHz(1_000 / 59.94)).toBe(60);
    expect(nominalHz(1_000 / 119.88)).toBe(120);
    expect(nominalHz(1_000 / 143.9)).toBe(144);
    expect(nominalHz(1_000 / 164.8)).toBe(165);
    expect(nominalHz(1_000 / 168)).toBe(170);
    expect(nominalHz(1_000 / 74.97)).toBe(75);
  });

  it("keeps a rate that is near no common one", () => {
    expect(nominalHz(1_000 / 57.3)).toBeCloseTo(57.3, 9);
    expect(nominalHz(1_000 / 110)).toBeCloseTo(110, 9);
  });
});

describe("what a setting does", () => {
  it("leaves the 60 setting on every refresh until pacing is switched on", () => {
    expect(FRAME_PACING_ENABLED).toBe(false);
    expect(effectiveFrameRate("60")).toBe("display");
    expect(effectiveFrameRate("30")).toBe("30");
    expect(effectiveFrameRate("display")).toBe("display");
    expect(effectiveFrameRate("60", true)).toBe("60");
  });

  it("draws every refresh at every setting where the browser cannot skip a frame", () => {
    for (const setting of ["60", "30", "display"] as const) {
      expect(effectiveFrameRate(setting, true, false)).toBe("display");
    }
    const flight = fly(120, "30", { pacer: new FramePacer({ pace60: true, canSkipFrames: false }), ticks: 600 });
    expect(flight.rendered).toHaveLength(600);
    expect(flight.pacer.paces("30")).toBe(false);
  });

  it("draws every refresh at the shipped 60 setting while pacing is off", () => {
    const flight = fly(120, "60", { pacer: new FramePacer(), ticks: 600 });
    expect(flight.rendered).toHaveLength(600);
    expect(flight.pacer.currentCadence).toEqual(cadenceOf(null, 1, 120, false));
    expect(flight.pacer.paces("60")).toBe(false);
    expect(flight.pacer.paces("30")).toBe(true);
  });
});

describe("steady pacing with ±0.5 ms timestamp jitter", () => {
  // [refresh, fps at 60, fps at 30] (PR B §5.4).
  const rates: readonly [number, number, number][] = [
    [60, 60, 30], [75, 75, 25], [90, 90, 30], [120, 60, 30], [144, 72, 28.8], [165, 82.5, 27.5], [240, 60, 30],
  ];
  for (const [hz, sixty, thirty] of rates) {
    it(`${hz} Hz draws ${sixty} fps at 60, ${thirty} at 30 and ${hz} at Match display`, () => {
      expect(fps(fly(hz, "60", { jitterMs: 0.5 }))).toBeCloseTo(sixty, 1);
      expect(fps(fly(hz, "30", { jitterMs: 0.5 }))).toBeCloseTo(thirty, 1);
      expect(fps(fly(hz, "display", { jitterMs: 0.5 }))).toBeCloseTo(hz, 1);
    });
  }

  it("never draws two frames closer than N - 0.5 refreshes once the period is known", () => {
    for (const [hz] of rates) {
      for (const setting of ["60", "30"] as const) {
        const flight = fly(hz, setting, { jitterMs: 0.5 });
        const divisor = flight.pacer.currentCadence!.divisor;
        expect(Math.min(...intervals(flight)), `${hz} Hz at ${setting}`).toBeGreaterThanOrEqual((divisor - 0.5) * (1_000 / hz));
      }
    }
  });

  it("emits the cadence twice: measured at once, then confirmed by the ticks it skipped", () => {
    const flight = fly(120, "60", { jitterMs: 0.5 });
    expect(flight.cadences.map(({ cadence }) => cadence)).toEqual([
      cadenceOf(60, 2, 120, false),
      cadenceOf(60, 2, 120, true),
    ]);
    // Within about 40 ticks of the first: a third of a second at 120 Hz.
    expect(flight.cadences[1]!.tick).toBeLessThanOrEqual(64);
  });
});

describe("heavy timestamp jitter", () => {
  const cases: readonly [number, number][] = [[120, 1], [120, 1.5], [144, 1], [60, 1.5]];
  for (const [hz, jitterMs] of cases) {
    it(`${hz} Hz at ±${jitterMs} ms: at most two cadences a minute, evenly spaced frames`, () => {
      const flight = fly(hz, "60", { jitterMs, ticks: hz * 60 });
      expect(flight.cadences.length).toBeLessThanOrEqual(2);
      const divisor = divisorFor("60", hz);
      expect(flight.pacer.currentCadence).toEqual(cadenceOf(60, divisor, hz, divisor > 1));
      expect(Math.min(...intervals(flight))).toBeGreaterThanOrEqual((divisor - 0.5) * (1_000 / hz) - 1.5);
    });
  }

  it("never reads a jittery 120 Hz display as 144 Hz", () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const flight = fly(120, "60", { jitterMs: 1.5, ticks: 7_200, seed });
      expect(flight.cadences.every(({ cadence }) => cadence.divisor === 2 && cadence.displayPeriodMs === 1_000 / 120), `seed ${seed}`).toBe(true);
    }
  });
});

describe("misses, gaps and resets", () => {
  it("does not draw twice to catch up after a dropped frame", () => {
    const flight = fly(120, "60", { jitterMs: 0.5, dropAt: 1_201, ticks: 1_600 });
    const values = intervals(flight, 1_000);
    // One 25 ms interval, then the even 16.67 again: no 8.33 ms frame to catch up.
    expect(values.filter((value) => value > 21)).toHaveLength(1);
    expect(Math.abs(Math.max(...values) - 25)).toBeLessThanOrEqual(1);
    expect(Math.min(...values)).toBeGreaterThan(12.5);
  });

  it("draws on the first tick after a reset and keeps the cadence it had", () => {
    const flight = fly(120, "60", { ticks: 600 });
    const cadence = flight.pacer.currentCadence;
    expect(cadence).toEqual(cadenceOf(60, 2, 120, true));
    flight.pacer.reset();
    const after = fly(120, "60", { pacer: flight.pacer, startMs: flight.endMs + 3, ticks: 400 });
    expect(after.renderedTicks[0]).toBe(0);
    expect(after.cadences).toEqual([]);
    expect(flight.pacer.currentCadence).toBe(cadence);
    expect(after.rendered).toHaveLength(200);
  });

  it("treats a gap of 250 ms or more as a reset", () => {
    const flight = fly(120, "60", { ticks: 600 });
    const cadence = flight.pacer.currentCadence;
    const after = fly(120, "60", { pacer: flight.pacer, startMs: flight.endMs + 5_000, ticks: 41 });
    expect(after.renderedTicks[0]).toBe(0);
    expect(after.renderedTicks.filter((tick) => tick >= 1)).toHaveLength(20);
    expect(flight.pacer.currentCadence).toBe(cadence);
  });

  it("returns the same result object on every tick", () => {
    const pacer = new FramePacer({ pace60: true });
    const first = pacer.tick(0, "60");
    expect(pacer.tick(8.3, "60")).toBe(first);
    expect(pacer.tick(16.7, "30")).toBe(first);
  });
});

describe("setting changes", () => {
  it("emits the new cadence on the tick the setting changes", () => {
    const flight = fly(120, "60", {
      ticks: 300,
      setting: (tick) => (tick < 100 ? "60" : tick < 200 ? "30" : "display"),
    });
    const changes = flight.cadences.filter(({ tick }) => tick >= 100);
    expect(changes.map(({ tick, cadence }) => [tick, cadence.frameCapHz, cadence.divisor])).toEqual([
      [100, 30, 4],
      [200, null, 1],
    ]);
    expect(flight.renderedTicks.filter((tick) => tick >= 200)).toHaveLength(100);
  });
});

describe("confirmation", () => {
  it("never confirms a slow machine's own pace", () => {
    const flight = fly(60, "60", { costMs: 20, ticks: 600 });
    expect(flight.pacer.currentCadence).toEqual(cadenceOf(60, 1, 30, false));
  });

  it("confirms the display on the startup probe's idle ticks", () => {
    const flight = fly(60, "60", { costMs: 20, ticks: 600, probeTicks: 24 });
    expect(flight.pacer.currentCadence).toEqual(cadenceOf(60, 1, 60, true));
    expect(flight.cadences).toHaveLength(1);
  });

  it("confirms a 50 Hz display only with the probe", () => {
    expect(fly(50, "60", { ticks: 600, probeTicks: 24 }).pacer.currentCadence).toEqual(cadenceOf(60, 1, 50, true));
    expect(fly(50, "60", { ticks: 600 }).pacer.currentCadence).toEqual(cadenceOf(60, 1, 50, false));
  });

  it("confirms a 30 Hz rAF throttle on the probe", () => {
    expect(fly(30, "60", { ticks: 300, probeTicks: 24 }).pacer.currentCadence).toEqual(cadenceOf(60, 1, 30, true));
  });

  it("lets a faster observed period replace the confirmed one: intervals cannot beat the display", () => {
    const pacer = new FramePacer({ pace60: true });
    const before = fly(60, "60", { pacer, probeTicks: 24, ticks: 120 });
    expect(pacer.currentCadence).toEqual(cadenceOf(60, 1, 60, true));
    fly(120, "60", { pacer, startMs: before.endMs, ticks: 600 });
    expect(pacer.currentCadence).toEqual(cadenceOf(60, 2, 120, true));
  });

  it("never lets a slower observed period replace a confirmed one", () => {
    const pacer = new FramePacer({ pace60: true });
    const before = fly(120, "60", { pacer, probeTicks: 24, ticks: 120 });
    const cadence = pacer.currentCadence;
    expect(cadence).toEqual(cadenceOf(60, 2, 120, true));
    // A machine that now takes a full 60 Hz frame and more to draw.
    const after = fly(120, "60", { pacer, startMs: before.endMs, ticks: 1_200, costMs: 12 });
    expect(pacer.currentCadence).toBe(cadence);
    expect(after.cadences).toEqual([]);
    expect(after.rendered).toHaveLength(1_200);
    expect(fps(after)).toBeCloseTo(60, 1);
  });

  it("re-measures the display while the flight is paused, skipping only the probe's ticks", () => {
    const flight = fly(120, "60", { ticks: 600, paused: (tick) => tick >= 300 && tick < 400 });
    const skipped = flight.renderedTicks.filter((tick) => tick >= 300 && tick < 300 + REPROBE_TICKS);
    expect(skipped).toEqual([]);
    expect(flight.renderedTicks.filter((tick) => tick >= 300 + REPROBE_TICKS && tick < 400).length).toBeGreaterThan(30);
    expect(flight.pacer.currentCadence).toEqual(cadenceOf(60, 2, 120, true));
  });

  it("does not skip a paused frame where it would not pace anyway", () => {
    const flight = fly(120, "display", { ticks: 400, paused: (tick) => tick >= 200 });
    expect(flight.rendered).toHaveLength(400);
    const shipping = fly(120, "60", { pacer: new FramePacer(), ticks: 400, paused: (tick) => tick >= 200 });
    expect(shipping.rendered).toHaveLength(400);
  });
});

describe("agreement with the bench's refresh estimate", () => {
  /** Timestamps of `count` vsyncs at `hz`, each delta in `multiples` refreshes, read through `round`. */
  function deltas(hz: number, multiples: readonly number[], round: (ms: number) => number = (ms) => ms): Float64Array {
    const values = new Float64Array(multiples.length);
    let vsync = 10_000;
    let previous = round(vsync);
    multiples.forEach((multiple, index) => {
      vsync += (multiple * 1_000) / hz;
      const now = round(vsync);
      values[index] = now - previous;
      previous = now;
    });
    return values;
  }
  const fixtures: readonly [string, Float64Array][] = [
    ["a 1 ms timer at 60 Hz (16 and 17 ms)", deltas(60, Array(64).fill(1), Math.floor)],
    ["120 Hz with dropped frames", deltas(120, Array.from({ length: 64 }, (_, index) => (index % 5 === 4 ? 2 : 1)))],
    ["60 Hz with 33 ms misses", deltas(60, Array.from({ length: 48 }, (_, index) => (index % 3 === 2 ? 2 : 1)))],
  ];

  for (const [name, values] of fixtures) {
    it(name, () => {
      const bench = estimateRefresh(values)!;
      const scratch = new Float64Array(64);
      expect(estimatePeriodMs(values, values.length, scratch)).toBeCloseTo(bench.periodMs, 9);
      // The pacer itself lands on the same nominal rate as the bench.
      const pacer = new FramePacer({ pace60: true });
      let now = 0;
      pacer.tick(now, "display");
      for (const delta of values) {
        now += delta;
        pacer.tick(now, "display");
      }
      expect(pacer.currentCadence!.displayPeriodMs).toBe(1_000 / nominalHz(bench.periodMs));
    });
  }
});

describe("the startup idle probe", () => {
  function host() {
    const frames = new Map<number, (nowMs: number) => void>();
    let nextHandle = 1;
    let timer: (() => void) | null = null;
    const cleared: unknown[] = [];
    const fake: IdleProbeHost = {
      requestAnimationFrame: (callback) => {
        const handle = nextHandle;
        nextHandle += 1;
        frames.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame: (handle) => {
        frames.delete(handle);
      },
      setTimeout: (callback) => {
        timer = callback;
        return "timer";
      },
      clearTimeout: (handle) => {
        cleared.push(handle);
      },
    };
    const step = (nowMs: number) => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(nowMs);
    };
    return { fake, frames, step, fireTimer: () => timer?.(), cleared };
  }

  it("hands every tick to the pacer and settles its lead after 24 ticks", async () => {
    const { fake, step } = host();
    const pacer = new FramePacer({ pace60: true });
    const probe = vi.spyOn(pacer, "probe");
    const idle = startIdleProbe(pacer, fake);
    let settled = false;
    void idle.lead.then(() => {
      settled = true;
    });
    for (let tick = 0; tick < IDLE_PROBE_LEAD_TICKS - 1; tick += 1) step(tick * (1_000 / 120));
    await Promise.resolve();
    expect(settled).toBe(false);
    step(IDLE_PROBE_LEAD_TICKS * (1_000 / 120));
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(probe).toHaveBeenCalledTimes(IDLE_PROBE_LEAD_TICKS);
    idle.stop();
  });

  it("settles its lead after 300 ms even when no frame comes", async () => {
    const { fake, fireTimer } = host();
    const idle = startIdleProbe(new FramePacer(), fake);
    let settled = false;
    void idle.lead.then(() => {
      settled = true;
    });
    expect(IDLE_PROBE_LEAD_MS).toBe(300);
    fireTimer();
    await Promise.resolve();
    expect(settled).toBe(true);
    idle.stop();
  });

  it("stops: no more frames, the timer cleared, the lead settled, twice without harm", async () => {
    const { fake, frames, step, cleared } = host();
    const pacer = new FramePacer();
    const probe = vi.spyOn(pacer, "probe");
    const idle = startIdleProbe(pacer, fake);
    step(0);
    idle.stop();
    idle.stop();
    expect(frames.size).toBe(0);
    expect(cleared).toContain("timer");
    await expect(idle.lead).resolves.toBeUndefined();
    step(16);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("confirms the period before the game's first tick, so a gap after it loses nothing", () => {
    const pacer = new FramePacer({ pace60: true });
    for (let tick = 0; tick < IDLE_PROBE_LEAD_TICKS; tick += 1) pacer.probe(tick * (1_000 / 120));
    // FlightRenderer.create takes seconds: the first game tick comes after a gap.
    const first = pacer.tick(5_000, "60");
    expect(first.render).toBe(true);
    expect(first.cadence).toEqual(cadenceOf(60, 2, 120, true));
  });
});
