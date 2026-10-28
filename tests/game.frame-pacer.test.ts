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
  IDLE_PROBE_MAX_LEAD_MS,
  IDLE_PROBE_MIN_LEAD_TICKS,
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
 * it. Every test that paces "60" passes `pace60: true`, so it keeps pacing
 * if shipping switches 60 fps pacing off again.
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
  it("paces the 60 setting now that the governor judges the paced cadence", () => {
    expect(FRAME_PACING_ENABLED).toBe(true);
    expect(effectiveFrameRate("60")).toBe("60");
    expect(effectiveFrameRate("30")).toBe("30");
    expect(effectiveFrameRate("display")).toBe("display");
    expect(effectiveFrameRate("60", false)).toBe("display");
  });

  it("draws every refresh at every setting where the browser cannot skip a frame", () => {
    for (const setting of ["60", "30", "display"] as const) {
      expect(effectiveFrameRate(setting, true, false)).toBe("display");
    }
    const flight = fly(120, "30", { pacer: new FramePacer({ pace60: true, canSkipFrames: false }), ticks: 600 });
    expect(flight.rendered).toHaveLength(600);
    expect(flight.pacer.paces("30")).toBe(false);
  });

  it("draws every 2nd refresh at 120 Hz at the shipped 60 setting", () => {
    const flight = fly(120, "60", { pacer: new FramePacer(), ticks: 600 });
    expect(flight.rendered.length).toBeGreaterThanOrEqual(300);
    expect(flight.rendered.length).toBeLessThanOrEqual(310);
    expect(flight.pacer.currentCadence).toEqual(cadenceOf(60, 2, 120, true));
    expect(flight.pacer.paces("60")).toBe(true);
  });

  it("draws every refresh at the 60 setting where 60 fps pacing is switched off", () => {
    const flight = fly(120, "60", { pacer: new FramePacer({ pace60: false }), ticks: 600 });
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

describe("runs of jitter", () => {
  it("hold 240 Hz at Match display where they leave quiet deltas a quarter short", () => {
    // Stamps 1.4 ms late, 0.35 ms late, 0.7 ms early and 1.4 ms early, twice
    // in every ten refreshes: a dozen quiet deltas of 3.1 ms in every ring,
    // a 320 Hz period whose grid holds no tick and no common rate is near.
    // Match display tests no reading with a skip, so it held 320 Hz to the end.
    const offsets = [1.4, 0.35, -0.7, -1.4, 1.4, 0.35, -0.7, -1.4, 0, 0];
    const period = 1_000 / 240;
    const pacer = new FramePacer({ pace60: true });
    for (let tick = 0; tick < IDLE_PROBE_LEAD_TICKS; tick += 1) pacer.probe(1_000 + tick * period);
    const rates = new Set<number>();
    for (let tick = 2 * IDLE_PROBE_LEAD_TICKS; tick < 4_800; tick += 1) {
      pacer.tick(1_000 + tick * period + offsets[tick % offsets.length]!, "display");
      rates.add(Math.round(1_000 / pacer.currentCadence!.displayPeriodMs!));
    }
    expect([...rates]).toEqual([240]);
    expect(pacer.currentCadence?.periodConfirmed).toBe(true);
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

  it("draws the tick after a reset, even in the middle of a check round", () => {
    // 60 Hz, then 144 Hz under frames of two refreshes: read as 72 Hz and
    // drawn every tick at the 60 setting, so the pacer skips one tick in
    // every few to check. A reset after any tick of that round still draws
    // the next one.
    const run = (resetAfter: number): { firstSkip: number | null; drewAfterReset: boolean | null } => {
      const pacer = new FramePacer({ pace60: true });
      let vsync = 1_000;
      for (let tick = 0; tick < IDLE_PROBE_LEAD_TICKS; tick += 1) {
        pacer.probe(vsync, tick + 1 < IDLE_PROBE_LEAD_TICKS);
        vsync += 1_000 / 60;
      }
      vsync += 100;
      let firstSkip: number | null = null;
      let drewAfterReset: boolean | null = null;
      for (let tick = 0; tick < 1_200; tick += 1) {
        const fast = tick >= 600;
        const result = pacer.tick(vsync, "60");
        if (tick === resetAfter + 1) drewAfterReset = result.render;
        if (!result.render) firstSkip ??= tick;
        vsync += (fast && result.render ? 2 : 1) * (1_000 / (fast ? 144 : 60));
        if (tick === resetAfter) pacer.reset();
      }
      return { firstSkip, drewAfterReset };
    };
    const { firstSkip } = run(-2);
    expect(firstSkip).not.toBeNull();
    expect(firstSkip!).toBeGreaterThanOrEqual(600);
    for (let after = firstSkip! - 1; after < firstSkip! + 40; after += 1) {
      expect(run(after).drewAfterReset, `reset after tick ${after}`).toBe(true);
    }
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

  it("flags the drawn tick that ends a re-probe's skipped ticks, and no other", () => {
    const pacer = new FramePacer({ pace60: true });
    const period = 1_000 / 120;
    const flagged: number[] = [];
    for (let tick = 0; tick < 600; tick += 1) {
      // Paused for 100 ticks, then for 10: resumed inside the re-probe.
      const paused = (tick >= 300 && tick < 400) || (tick >= 500 && tick < 510);
      const result = pacer.tick(1_000 + tick * period, "60", paused);
      if (result.afterReprobe) {
        expect(result.render).toBe(true);
        flagged.push(tick);
      }
    }
    expect(flagged).toEqual([300 + REPROBE_TICKS, 510]);
    const unpaced = new FramePacer({ pace60: true });
    for (let tick = 0; tick < 600; tick += 1) {
      expect(unpaced.tick(1_000 + tick * period, "display", tick >= 300).afterReprobe).toBe(false);
    }
  });

  it("re-measures a paused flight after a reset, where the display changed while the tab was hidden", () => {
    // Paused at 120 Hz: the re-probe reads 120. The tab hides while paused
    // (a reset), the window moves to a 60 Hz display, and the tab shows
    // again, still paused: the pause's own re-probe has run, so the reset
    // starts another.
    const pacer = new FramePacer({ pace60: true });
    const before = fly(120, "60", { pacer, ticks: 600, paused: (tick) => tick >= 400 });
    expect(pacer.currentCadence).toEqual(cadenceOf(60, 2, 120, true));
    pacer.reset();
    const after = fly(60, "60", { pacer, startMs: before.endMs + 2_000, ticks: 600, paused: (tick) => tick < 100 });
    expect(pacer.currentCadence).toEqual(cadenceOf(60, 1, 60, true));
    expect(after.renderedTicks.filter((tick) => tick >= 100)).toHaveLength(500);
  });

  it("does not skip a paused frame where it would not pace anyway", () => {
    const flight = fly(120, "display", { ticks: 400, paused: (tick) => tick >= 200 });
    expect(flight.rendered).toHaveLength(400);
    const unpaced = fly(120, "60", { pacer: new FramePacer({ pace60: false }), ticks: 400, paused: (tick) => tick >= 200 });
    expect(unpaced.rendered).toHaveLength(400);
  });

  it("re-measures the display when the pause menu turns pacing on", () => {
    // A busy startup read a 60 Hz display as 30 Hz, and "Match display" with
    // frames of two refreshes never contradicts it. The pause began unpaced,
    // so only the setting change can start the re-probe.
    const pacer = new FramePacer({ pace60: true });
    const period = 1_000 / 60;
    let vsync = 1_000;
    for (let tick = 0; tick < IDLE_PROBE_LEAD_TICKS; tick += 1) {
      pacer.probe(vsync);
      vsync += 2 * period;
    }
    for (let tick = 0; tick < 1_500; tick += 1) {
      const result = pacer.tick(vsync, tick < 600 ? "display" : "30", tick >= 500 && tick < 700);
      vsync += (result.render ? 2 : 1) * period;
    }
    expect(pacer.currentCadence).toEqual(cadenceOf(30, 2, 60, true));
  });

  it("withdraws a rate whose skips read fast once the display drops to one drawn every tick, and confirms no third", () => {
    // Every skipped 165 Hz tick is stamped 0.4 ms late, so the skips read
    // 176 Hz, 6.6% fast: still the held rate while every tick sits on its
    // grid. Then a 60 Hz display is drawn every tick at divisor 2, skips
    // none, and its ticks sit on the 180 Hz grid that 176 Hz seeds.
    const pacer = new FramePacer({ pace60: true });
    let vsync = 1_000;
    for (let tick = 0; tick < IDLE_PROBE_LEAD_TICKS; tick += 1) {
      pacer.probe(vsync);
      vsync += 1_000 / 165;
    }
    let drew = true;
    for (let tick = 0; tick < 1_200; tick += 1) {
      drew = pacer.tick(vsync + (drew ? 0.4 : 0), "60").render;
      vsync += 1_000 / 165;
    }
    expect(pacer.currentCadence).toEqual(cadenceOf(60, 2, 165, true));
    const rates = new Set<number>();
    for (let tick = 0; tick < 1_200; tick += 1) {
      pacer.tick(vsync, "60");
      const periodMs = pacer.currentCadence?.displayPeriodMs ?? null;
      rates.add(periodMs === null ? 0 : Math.round(1_000 / periodMs));
      vsync += 1_000 / 60;
    }
    expect([...rates].filter((hz) => hz !== 165 && hz !== 60)).toEqual([]);
    const final = pacer.currentCadence!;
    expect(final.periodConfirmed && final.displayPeriodMs !== 1_000 / 60).toBe(false);
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
    const timers = new Map<number, () => void>();
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
      setTimeout: (callback, milliseconds) => {
        timers.set(milliseconds, callback);
        return `timer ${milliseconds}`;
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
    return { fake, frames, step, fireTimer: (milliseconds: number) => timers.get(milliseconds)?.(), cleared };
  }

  /** Whether `idle`'s lead has settled, once pending callbacks have run. */
  async function settledOf(idle: { readonly lead: Promise<void> }): Promise<boolean> {
    let settled = false;
    void idle.lead.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    return settled;
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

  it("settles its lead after 300 ms once 13 ticks have come, and after 1 s even when no frame comes", async () => {
    expect([IDLE_PROBE_LEAD_MS, IDLE_PROBE_MIN_LEAD_TICKS, IDLE_PROBE_MAX_LEAD_MS]).toEqual([300, 13, 1_000]);
    const ticked = host();
    const quick = startIdleProbe(new FramePacer(), ticked.fake);
    for (let tick = 0; tick < IDLE_PROBE_MIN_LEAD_TICKS; tick += 1) ticked.step(tick * (1_000 / 48));
    expect(await settledOf(quick)).toBe(false);
    ticked.fireTimer(IDLE_PROBE_LEAD_MS);
    expect(await settledOf(quick)).toBe(true);
    quick.stop();
    // A hidden tab gets no frames.
    const { fake, fireTimer } = host();
    const idle = startIdleProbe(new FramePacer(), fake);
    fireTimer(IDLE_PROBE_LEAD_MS);
    expect(await settledOf(idle)).toBe(false);
    fireTimer(IDLE_PROBE_MAX_LEAD_MS);
    expect(await settledOf(idle)).toBe(true);
    idle.stop();
  });

  it("waits past 300 ms for 13 ticks with no gap, where the first frame came late or a stall cut the lead", async () => {
    // Fewer than 13 quiet ticks confirm nothing, and renderer creation then
    // leaves no clean run: under frames of two refreshes the flight would
    // read half the rate, unconfirmed, until the first pause.
    for (const before of [0, 3, 12]) {
      const { fake, step, fireTimer } = host();
      const pacer = new FramePacer({ pace60: true });
      const probe = vi.spyOn(pacer, "probe");
      const idle = startIdleProbe(pacer, fake);
      let now = 1_000;
      for (let tick = 0; tick < before; tick += 1, now += 1_000 / 60) step(now);
      // The main thread stalls, or the first frame comes late: 260 ms.
      now += 260;
      fireTimer(IDLE_PROBE_LEAD_MS);
      for (let tick = 0; tick < IDLE_PROBE_MIN_LEAD_TICKS - 1; tick += 1, now += 1_000 / 60) step(now);
      expect(await settledOf(idle), `${before} ticks before`).toBe(false);
      step(now);
      expect(await settledOf(idle), `${before} ticks before`).toBe(true);
      expect(probe.mock.calls.slice(-2).map(([, quiet]) => quiet)).toEqual([true, false]);
      // Renderer creation misses every other refresh.
      for (let tick = 0; tick < 60; tick += 1) step((now += 1_000 / 30));
      idle.stop();
      pacer.tick(now + 100, "60");
      expect(pacer.currentCadence, `${before} ticks before`).toEqual(cadenceOf(60, 1, 60, true));
    }
  });

  it("reads the run that settles a lead two stalls cut as quiet, past the 24th tick", async () => {
    // Each stall ends a run, so the 13 ticks with no gap that settle the
    // lead can start after the 24th: they are still the quiet lead's. Read
    // as busy, they left no clean evidence, and frames of two refreshes then
    // read half the rate for the whole flight.
    for (const [first, second] of [[9, 11], [6, 12]] as const) {
      const { fake, step, fireTimer } = host();
      const pacer = new FramePacer({ pace60: true });
      const idle = startIdleProbe(pacer, fake);
      let now = 1_000;
      for (let tick = 0; tick < first; tick += 1, now += 1_000 / 120) step(now);
      now += 260;
      fireTimer(IDLE_PROBE_LEAD_MS);
      for (let tick = 0; tick < second; tick += 1, now += 1_000 / 120) step(now);
      now += 260;
      for (let tick = 0; tick < IDLE_PROBE_MIN_LEAD_TICKS - 1; tick += 1, now += 1_000 / 120) step(now);
      expect(await settledOf(idle), `${first} and ${second} ticks`).toBe(false);
      step(now);
      expect(await settledOf(idle), `${first} and ${second} ticks`).toBe(true);
      // Renderer creation misses every other refresh.
      for (let tick = 0; tick < 60; tick += 1) step((now += 1_000 / 60));
      idle.stop();
      pacer.tick(now + 100, "60");
      expect(pacer.currentCadence, `${first} and ${second} ticks`).toEqual(cadenceOf(60, 2, 120, true));
    }
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
    expect(cleared).toEqual(expect.arrayContaining([`timer ${IDLE_PROBE_LEAD_MS}`, `timer ${IDLE_PROBE_MAX_LEAD_MS}`]));
    await expect(idle.lead).resolves.toBeUndefined();
    step(16);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("reads a lead its 300 ms cut to 13-15 ticks whole, and the ticks after it as busy, never as the display's", async () => {
    // A 48 or 50 Hz display, or a first frame 50 ms late at 60 Hz: the
    // estimates fall every 8 deltas, so none reads the run while it is 12
    // long or more. Then renderer creation misses every other refresh.
    for (const quiet of [13, 14, 15]) {
      const { fake, step, fireTimer } = host();
      const pacer = new FramePacer({ pace60: true });
      const idle = startIdleProbe(pacer, fake);
      let now = 1_000;
      for (let tick = 0; tick < quiet; tick += 1, now += 1_000 / 60) step(now);
      fireTimer(IDLE_PROBE_LEAD_MS);
      await idle.lead;
      for (let tick = 0; tick < 40; tick += 1, now += 1_000 / 30) step(now);
      idle.stop();
      pacer.tick(now + 100, "60");
      expect(pacer.currentCadence, `${quiet} quiet ticks`).toEqual(cadenceOf(60, 1, 60, true));
    }
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
