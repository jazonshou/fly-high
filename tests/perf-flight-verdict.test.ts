import { describe, expect, it } from "vitest";
import { DetailWatchdogProbe, type DetailWatchdogSample } from "./perf/ab/detailWatchdog";

/**
 * perf:flight's reading of the detail worker. The watchdog probe turns the
 * runtime's private clocks, sampled once a frame, into the spans the runtime
 * charged its worker for; a span charged 2,000 ms would have tripped the
 * 240-update deadline at 120 Hz.
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
