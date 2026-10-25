import { describe, expect, it } from "vitest";
import {
  flightVerdict,
  heapKiBPerFrame,
  percentiles,
  renderVerdictMarkdown,
  workerFallbackExitCode,
  type FlightRunReport,
} from "../scripts/perfFlightVerdict.mts";
import { DetailWatchdogProbe, type DetailWatchdogSample } from "./perf/ab/detailWatchdog";
import type {
  DetailWatchdogReport,
  DetailWorkerState,
  FlightFrame,
  FlightReport,
  StreamReport,
} from "./perf/ab/protocol";

/**
 * perf:flight's reading of the detail worker. The watchdog probe turns the
 * runtime's private clocks, sampled once a frame, into the spans the runtime
 * charged its worker for; a span charged 2,000 ms would have tripped the
 * 240-update deadline at 120 Hz. The verdict turns a run's report into
 * TRIPPED / WOULD-TRIP per arm and phase, and decides
 * `--fail-on-worker-fallback`'s exit status.
 */

const CLIENT = { name: "worker client" };

/** A runtime at `update`, its clock at `nowMs`, everything else idle unless given. */
function sample(update: number, nowMs: number, overrides: Partial<DetailWatchdogSample> = {}): DetailWatchdogSample {
  return {
    wallMs: nowMs,
    nowMs,
    updateSequence: update,
    presentationUpdate: null,
    presentationMs: null,
    generationUpdate: null,
    generationMs: null,
    generationAnswered: true,
    workerBuildId: null,
    client: CLIENT,
    buildTimeouts: 0,
    cancellations: 0,
    ...overrides,
  };
}

describe("detail watchdog probe", () => {
  it("reads a demand episode as one span, charged from the runtime's marker", () => {
    const probe = new DetailWatchdogProbe();
    probe.beginWindow(0);
    // 19543c0: the marker stays at the first demand update until accepted
    // output resets it, 50 ms a frame here (a 20 fps harness).
    for (let update = 10; update <= 52; update += 1) {
      probe.observe(sample(update, update * 50, { presentationUpdate: 10, presentationMs: 500 }));
    }
    probe.observe(sample(53, 2_650));
    const report = probe.report();
    expect(report.frames).toBe(44);
    expect(report.wallMs).toBe(2_650);
    expect(report.presentation).toEqual({
      spans: 1,
      maxChargedMs: 2_100,
      maxChargedUpdates: 42,
      maxWallMs: 2_100,
      wouldTripAt120Hz: 1,
      openChargedMs: null,
    });
  });

  it("does not charge an update gap the runtime excluded, though the wall span shows it", () => {
    const probe = new DetailWatchdogProbe();
    probe.beginWindow(0);
    probe.observe(sample(1, 0, { presentationUpdate: 1, presentationMs: 0 }));
    // A 3 s harness frame: the runtime pushed its marker past all but the
    // 100 ms allowance of it.
    probe.observe(sample(2, 3_000, { presentationUpdate: 1, presentationMs: 2_900 }));
    const { presentation } = probe.report();
    expect(presentation.maxChargedMs).toBe(100);
    expect(presentation.maxWallMs).toBe(3_000);
    expect(presentation.wouldTripAt120Hz).toBe(0);
    expect(presentation.openChargedMs).toBe(100);
  });

  it("ends a span when a heartbeat moves the marker, and holds it through a pause", () => {
    const probe = new DetailWatchdogProbe();
    probe.beginWindow(0);
    let marker = 1;
    let markerMs = 0;
    for (let update = 1; update <= 120; update += 1) {
      const now = update * 25;
      if (update % 4 === 0) {
        // A heartbeat landed before this update.
        marker = update - 1;
        markerMs = now - 25;
      }
      probe.observe(sample(update, now, { presentationUpdate: marker, presentationMs: markerMs }));
    }
    // A paused span: both markers advance with every update.
    for (let update = 121; update <= 130; update += 1) {
      marker += 1;
      markerMs += 25;
      probe.observe(sample(update, update * 25, { presentationUpdate: marker, presentationMs: markerMs }));
    }
    const { presentation } = probe.report();
    expect(presentation.spans).toBe(30);
    expect(presentation.maxChargedUpdates).toBe(4);
    expect(presentation.maxChargedMs).toBe(100);
    expect(presentation.wouldTripAt120Hz).toBe(0);
    expect(presentation.openChargedMs).not.toBeNull();
  });

  it("times generation as the runtime does: the update arm only after a first answer", () => {
    const unanswered = new DetailWatchdogProbe();
    unanswered.beginWindow(0);
    for (const now of [0, 2_500, 7_999]) {
      unanswered.observe(sample(now / 10, now, { generationUpdate: 0, generationMs: 0, generationAnswered: false }));
    }
    expect(unanswered.report().generation.wouldTripAt120Hz).toBe(0);
    unanswered.observe(sample(800, 8_000, { generationUpdate: 0, generationMs: 0, generationAnswered: false }));
    expect(unanswered.report().generation.wouldTripAt120Hz).toBe(1);

    const answered = new DetailWatchdogProbe();
    answered.beginWindow(0);
    for (const now of [0, 2_500]) {
      answered.observe(sample(now / 10, now, { generationUpdate: 0, generationMs: 0 }));
    }
    expect(answered.report().generation.wouldTripAt120Hz).toBe(1);
  });

  it("counts a span once, though it stays open across windows", () => {
    const probe = new DetailWatchdogProbe();
    probe.beginWindow(0);
    probe.observe(sample(1, 0, { presentationUpdate: 1, presentationMs: 0 }));
    probe.observe(sample(2, 2_500, { presentationUpdate: 1, presentationMs: 0 }));
    expect(probe.report().presentation.wouldTripAt120Hz).toBe(1);
    // The other arm's leg: this runtime did not update.
    probe.beginWindow(60_000);
    probe.observe(sample(3, 60_050, { presentationUpdate: 1, presentationMs: 57_550 }));
    probe.observe(sample(4, 60_100));
    const next = probe.report();
    expect(next.presentation).toMatchObject({ spans: 1, wouldTripAt120Hz: 0, maxChargedMs: 2_500, maxWallMs: 0 });
  });

  it("times accepted worker builds only, not cancelled, timed-out or inline ones", () => {
    const probe = new DetailWatchdogProbe();
    probe.beginWindow(0);
    // Build 1: accepted after 5 frames.
    for (let frame = 0; frame < 5; frame += 1) probe.observe(sample(frame, frame * 40, { workerBuildId: 1 }));
    probe.observe(sample(5, 200));
    // Build 2: cancelled (a rebase), build 3 posted in the same update.
    probe.observe(sample(6, 240, { workerBuildId: 2 }));
    probe.observe(sample(7, 280, { workerBuildId: 3, cancellations: 1 }));
    // Build 3: timed out, and the worker went with it.
    probe.observe(sample(8, 320, { workerBuildId: 3, cancellations: 1 }));
    probe.observe(sample(9, 360, { client: null, buildTimeouts: 1, cancellations: 1 }));
    const report = probe.report();
    expect(report.buildLatencyMs).toEqual([200]);
    expect(report.buildLatencyUpdates).toEqual([5]);
    expect(report.buildsNotAccepted).toBe(2);
    expect(report.workerLostAtFrames).toEqual([9]);
  });

  it("does not take a build of a new worker for the old one's, though the ids match", () => {
    const probe = new DetailWatchdogProbe();
    probe.beginWindow(0);
    const respawned = { name: "respawned client" };
    probe.observe(sample(1, 0, { workerBuildId: 4 }));
    probe.observe(sample(2, 40, { workerBuildId: 4, client: respawned }));
    probe.observe(sample(3, 80, { client: respawned }));
    const report = probe.report();
    expect(report.buildsNotAccepted).toBe(1);
    expect(report.buildLatencyMs).toEqual([40]);
    expect(report.workerLostAtFrames).toEqual([1]);
  });

  it("leaves a build first seen in an earlier window out of the latencies", () => {
    const probe = new DetailWatchdogProbe();
    probe.beginWindow(0);
    probe.observe(sample(1, 0, { workerBuildId: 1 }));
    probe.beginWindow(90_000);
    probe.observe(sample(2, 90_040));
    expect(probe.report()).toMatchObject({ buildLatencyMs: [], buildsNotAccepted: 0 });
  });
});

const BASE_SHA = "c43eb86f6f0000000000000000000000000000aa";
const HEAD_SHA = "19543c0172000000000000000000000000000bbb";
const CLEAN: DetailWorkerState = { active: true, fallbacks: 0, generationTimeouts: 0, buildTimeouts: 0, buildRejections: 0 };
/** Round 3, job 2's head (far east): the worker was gone by the end of leg 0. */
const J2_HEAD_TRIP: DetailWorkerState = {
  active: false,
  fallbacks: 1,
  generationTimeouts: 0,
  buildTimeouts: 1,
  buildRejections: 1,
};

function frame(renderMs: number, heapRenderBytes = 0, heapBetweenBytes = 0): FlightFrame {
  return {
    renderMs,
    betweenMs: 0.5,
    passMs: {},
    heapRenderBytes,
    heapBetweenBytes,
    pipelinesCreated: 0,
    shaderModulesCreated: 0,
    shaderCodeChars: 0,
    effectsCompiled: [],
  };
}

function watchdog(overrides: { presentation?: number; generation?: number; wouldTrip?: number; latency?: number[] } = {}): DetailWatchdogReport {
  const clock = (maxChargedMs: number, wouldTripAt120Hz: number) => ({
    spans: 3,
    maxChargedMs,
    maxChargedUpdates: Math.round(maxChargedMs / 40),
    maxWallMs: maxChargedMs,
    wouldTripAt120Hz,
    openChargedMs: null,
  });
  return {
    frames: 600,
    wallMs: 24_000,
    presentation: clock(overrides.presentation ?? 900, overrides.wouldTrip ?? 0),
    generation: clock(overrides.generation ?? 60, 0),
    buildLatencyMs: overrides.latency ?? [120, 300, 80],
    buildLatencyUpdates: [3, 7, 2],
    buildsNotAccepted: 1,
    workerLostAtFrames: [],
  };
}

function leg(renderCalls: number, worker: DetailWorkerState, frames: readonly FlightFrame[], probe?: DetailWatchdogReport): FlightReport {
  return {
    frames,
    renderCalls,
    elapsedMs: 30_000,
    longTasks: [{ start: 0, duration: 80 }],
    position: { x: 0, y: 0, z: 0 },
    pendingTerrainPages: 0,
    pendingDetailWork: 0,
    visibleInstances: 1,
    residentTerrainPages: 1,
    detailWorker: worker,
    ...(probe ? { detailWatchdog: probe } : {}),
  };
}

function stream(worker: DetailWorkerState, probe: DetailWatchdogReport): StreamReport {
  return {
    frames: 962,
    settled: true,
    renderCalls: 964,
    elapsedMs: 40_000,
    pendingTerrainPages: 0,
    pendingDetailWork: 0,
    droppedDraws: 0,
    suppressedPasses: 0,
    bakedWhileClosed: {},
    detailWorker: worker,
    detailWatchdog: probe,
  };
}

const steady = (scale: number) => Array.from({ length: 100 }, (_, index) => frame((index + 1) * scale, 2_048, -4_096));

/** A report.json as perf:flight wrote it before the probe (round 3, job 2), and one with it. */
function j2Report(withProbe: boolean): FlightRunReport {
  return {
    identity: { base: "c43eb86 (c43eb86f6f)", head: "19543c0 (19543c0172)" },
    ...(withProbe ? { shas: { base: BASE_SHA, head: HEAD_SHA } } : {}),
    reports: {
      base: [962, 1562, 2162].map((calls) => leg(calls, CLEAN, steady(1), withProbe ? watchdog() : undefined)),
      head: [1142, 1742, 2342].map((calls) => leg(calls, J2_HEAD_TRIP, steady(2), withProbe ? watchdog() : undefined)),
    },
  };
}

describe("flight verdict", () => {
  it("finds round 3 job 2's head trip in a report from before the probe", () => {
    const verdict = flightVerdict(j2Report(false));
    const head = verdict.rows.filter((row) => row.arm === "head");
    expect(head.map((row) => [row.phase, row.tripped, row.firstTripped])).toEqual([
      ["leg 1", true, true],
      ["leg 2", true, false],
      ["leg 3", true, false],
    ]);
    expect(head[0]!.wouldTrip).toBeNull();
    expect(verdict.rows.filter((row) => row.arm === "base").every((row) => row.tripped === false)).toBe(true);
    // Without full SHAs, the short ones in the identity key the commits.
    expect(verdict.trippedBySha).toEqual({ c43eb86f6f: false, "19543c0172": true });
    expect(renderVerdictMarkdown(verdict)).toContain(
      "| leg 1 | head | 19543c0172 | **TRIPPED** (build timeouts 1, generation timeouts 0, fallbacks 1, inactive) |",
    );
  });

  it("fails --fail-on-worker-fallback on the commit that tripped, whichever side it ran on", () => {
    const verdict = flightVerdict(j2Report(true));
    expect(workerFallbackExitCode(verdict, HEAD_SHA)).toBe(1);
    expect(workerFallbackExitCode(verdict, BASE_SHA)).toBe(0);
    expect(() => workerFallbackExitCode(verdict, "0".repeat(40))).toThrow(/no arm was built from/);
  });

  it("passes a clean head", () => {
    const report = j2Report(true);
    const clean: FlightRunReport = {
      ...report,
      reports: { base: report.reports.base, head: report.reports.base },
    };
    const verdict = flightVerdict(clean);
    expect(verdict.rows.every((row) => row.tripped === false)).toBe(true);
    expect(workerFallbackExitCode(verdict, HEAD_SHA)).toBe(0);
  });

  it("counts restarts and timeouts as trips though the worker is active again", () => {
    const report = j2Report(true);
    const restarted: DetailWorkerState = { ...CLEAN, buildTimeouts: 1, respawns: 1 };
    const verdict = flightVerdict({
      ...report,
      reports: { base: report.reports.base, head: [leg(962, restarted, steady(1))] },
    });
    expect(verdict.rows.find((row) => row.arm === "head")!.tripped).toBe(true);
    expect(workerFallbackExitCode(verdict, HEAD_SHA)).toBe(1);
  });

  it("reads the stream to rest as a phase of its own, where the CI trips happened", () => {
    const report = j2Report(true);
    const verdict = flightVerdict({
      ...report,
      settle: {
        base: stream(CLEAN, watchdog({ presentation: 2_400, wouldTrip: 1 })),
        head: stream(J2_HEAD_TRIP, watchdog({ presentation: 8_000, wouldTrip: 1 })),
      },
    });
    const settle = verdict.rows.filter((row) => row.phase === "settle");
    expect(settle.map((row) => [row.arm, row.tripped, row.firstTripped, row.wouldTrip])).toEqual([
      ["base", false, false, 1],
      ["head", true, true, 1],
    ]);
    expect(settle[1]!.maxChargedMs).toEqual({ presentation: 8_000, generation: 60 });
    expect(settle[0]!.renderMs).toBeNull();
    expect(settle[0]!.framesPerSecond).toBeCloseTo(25, 9);
    // The head's legs carry the settle's trip; only the settle is its first.
    expect(verdict.rows.filter((row) => row.arm === "head" && row.firstTripped).map((row) => row.phase)).toEqual(["settle"]);
  });

  it("reports render percentiles, heap per frame, build latency and the head/base ratios", () => {
    const verdict = flightVerdict(j2Report(true));
    const baseLeg = verdict.rows.find((row) => row.arm === "base" && row.phase === "leg 2")!;
    expect(baseLeg.renderMs).toEqual({ p50: 50, p95: 95 });
    expect(baseLeg.heapKiBPerFrame).toBe(2);
    expect(baseLeg.buildLatencyMs).toEqual({ p50: 120, p95: 300, count: 3 });
    expect(baseLeg.longTasks).toBe(1);
    expect(verdict.ratios).toEqual([
      { phase: "after the first leg", renderP50: 2, renderP95: 2, heapKiBPerFrame: 1 },
      { phase: "the first leg", renderP50: 2, renderP95: 2, heapKiBPerFrame: 1 },
    ]);
  });

  it("takes nearest-rank percentiles and counts only heap growth", () => {
    expect(percentiles([5, 1, 4, 2, 3])).toEqual({ p50: 3, p95: 5, p99: 5, max: 5, mean: 3 });
    expect(percentiles([]).p50).toBeNaN();
    expect(heapKiBPerFrame([frame(1, 4_096, -10_000_000), frame(1, 0, 2_048)])).toBe(3);
  });
});
