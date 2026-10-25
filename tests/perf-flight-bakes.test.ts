import { describe, expect, it } from "vitest";
import {
  bakeReport,
  describeLegBakes,
  renderBakeMarkdown,
  type BakeRow,
} from "../scripts/perfFlightBakes.mts";
import type { FlightRenderer } from "../src/render/FlightRenderer";
import { FlightBakeProbe, readBakeStats, type BakeStatsReading } from "./perf/ab/bakeProbe";
import type { FlightFrame, FlightFrameBake, FlightReport } from "./perf/ab/protocol";

/**
 * perf:flight's per-frame record of the renderer's two bakes that spread over
 * frames: the agent reads `getBakeStatsForCapture()` after each frame, and the
 * probe turns its running counters and newest-call figures into what that
 * frame did. The report then says, per arm and leg, which frames of a sliced
 * sky re-light went over 1 ms and what each ground-cover call cost, and n/a
 * for a base whose renderer does not report them.
 */

/** For tsc: the probe reads no figure the head's renderer does not report, under the name it reports it by. */
export const rendererReportsWhatTheProbeReads = (
  stats: ReturnType<FlightRenderer["getBakeStatsForCapture"]>,
): BakeStatsReading => stats;

/** A renderer's bake counters; every figure 0 unless given. */
function reading(
  sky: Partial<BakeStatsReading["sky"]> = {},
  skyRebake: Partial<BakeStatsReading["skyRebake"]> = {},
  groundCover: Partial<BakeStatsReading["groundCover"]> = {},
): BakeStatsReading {
  return {
    sky: { frameIndex: 0, lastMilliseconds: 0, ...sky },
    skyRebake: { advanceCalls: 0, lastAdvanceMilliseconds: 0, bakesCompleted: 0, lastApplyMilliseconds: 0, ...skyRebake },
    groundCover: { lastMilliseconds: 0, tilesCompleted: 0, paceFloorCalls: 0, ...groundCover },
  };
}

describe("flight bake probe", () => {
  it("reads a frame on which nothing baked as null, though the last figures hold", () => {
    // The renderer's last figures stay until the next call sets them: the
    // refresh ran on frame 40, a slice and a landing before that.
    const held = reading(
      { frameIndex: 40, lastMilliseconds: 0.7 },
      { advanceCalls: 9, lastAdvanceMilliseconds: 0.5, bakesCompleted: 2, lastApplyMilliseconds: 1.4 },
      { tilesCompleted: 3, paceFloorCalls: 1 },
    );
    const probe = new FlightBakeProbe(held);
    expect(probe.observe(held)).toBeNull();
    expect(probe.observe(held)).toBeNull();
  });

  it("attributes a sliced re-light's frames: begin, slice, landing, cube, LUT", () => {
    const probe = new FlightBakeProbe(reading({ frameIndex: 10, lastMilliseconds: 3 }));
    // Begin and its first slice on frame 101.
    expect(probe.observe(reading({ frameIndex: 101, lastMilliseconds: 0.62 }, { advanceCalls: 1, lastAdvanceMilliseconds: 0.51 })))
      .toEqual({
        skyMs: 0.62, skyAdvances: 1, skyAdvanceMs: 0.51, skyLandings: 0, skyApplyMs: null,
        groundCoverCalls: 0, groundCoverMs: null, groundCoverPaceFloorCalls: 0, groundCoverTilesCompleted: 0,
      });
    expect(probe.observe(reading({ frameIndex: 102, lastMilliseconds: 0.55 }, { advanceCalls: 2, lastAdvanceMilliseconds: 0.53 })))
      .toMatchObject({ skyMs: 0.55, skyAdvances: 1, skyAdvanceMs: 0.53, skyLandings: 0, skyApplyMs: null });
    // The landing: the converter, no slice (the slice's last figure holds).
    expect(probe.observe(reading(
      { frameIndex: 103, lastMilliseconds: 0.9 },
      { advanceCalls: 2, lastAdvanceMilliseconds: 0.53, bakesCompleted: 1, lastApplyMilliseconds: 0.85 },
    ))).toMatchObject({ skyMs: 0.9, skyAdvances: 0, skyAdvanceMs: null, skyLandings: 1, skyApplyMs: 0.85 });
    // The cube's re-arm and the LUT: the refresh ran, nothing counted.
    for (const frameIndex of [104, 105]) {
      expect(probe.observe(reading(
        { frameIndex, lastMilliseconds: 0.2 },
        { advanceCalls: 2, lastAdvanceMilliseconds: 0.53, bakesCompleted: 1, lastApplyMilliseconds: 0.85 },
      ))).toMatchObject({ skyMs: 0.2, skyAdvances: 0, skyLandings: 0, skyApplyMs: null });
    }
    // Then nothing: the frame index stays at 105.
    expect(probe.observe(reading(
      { frameIndex: 105, lastMilliseconds: 0.2 },
      { advanceCalls: 2, lastAdvanceMilliseconds: 0.53, bakesCompleted: 1, lastApplyMilliseconds: 0.85 },
    ))).toBeNull();
  });

  it("counts a ground-cover call by its ms, or by a tile or a pace-floor hold within one clock tick", () => {
    const probe = new FlightBakeProbe(reading({}, {}, { tilesCompleted: 4, paceFloorCalls: 2 }));
    expect(probe.observe(reading({}, {}, { lastMilliseconds: 1.7, tilesCompleted: 4, paceFloorCalls: 2 })))
      .toMatchObject({ skyMs: null, groundCoverCalls: 1, groundCoverMs: 1.7, groundCoverPaceFloorCalls: 0, groundCoverTilesCompleted: 0 });
    expect(probe.observe(reading({}, {}, { lastMilliseconds: 2.4, tilesCompleted: 4, paceFloorCalls: 3 })))
      .toMatchObject({ groundCoverCalls: 1, groundCoverMs: 2.4, groundCoverPaceFloorCalls: 1, groundCoverTilesCompleted: 0 });
    // The update zeroes the figure each frame: no call.
    expect(probe.observe(reading({}, {}, { lastMilliseconds: 0, tilesCompleted: 4, paceFloorCalls: 3 }))).toBeNull();
    // A call that finished the tile inside one tick of the clock.
    expect(probe.observe(reading({}, {}, { lastMilliseconds: 0, tilesCompleted: 5, paceFloorCalls: 3 })))
      .toMatchObject({ groundCoverCalls: 1, groundCoverMs: 0, groundCoverTilesCompleted: 1 });
  });

  it("reads nothing from a build whose renderer does not report its bakes", () => {
    expect(readBakeStats({})).toBeNull();
    const stats = reading({ frameIndex: 7 });
    // Called as the renderer's method, on the renderer.
    const renderer = { stats, getBakeStatsForCapture(this: { stats: BakeStatsReading }) { return this.stats; } };
    expect(readBakeStats(renderer)).toBe(stats);
  });
});

const IDLE: FlightFrameBake = {
  skyMs: null, skyAdvances: 0, skyAdvanceMs: null, skyLandings: 0, skyApplyMs: null,
  groundCoverCalls: 0, groundCoverMs: null, groundCoverPaceFloorCalls: 0, groundCoverTilesCompleted: 0,
};
const sky = (skyMs: number, rest: Partial<FlightFrameBake> = {}): FlightFrameBake => ({ ...IDLE, skyMs, ...rest });
const slice = (skyMs: number, advanceMs = 0.5) => sky(skyMs, { skyAdvances: 1, skyAdvanceMs: advanceMs });
const landing = (skyMs: number, applyMs: number) => sky(skyMs, { skyLandings: 1, skyApplyMs: applyMs });
const cover = (ms: number, rest: Partial<FlightFrameBake> = {}): FlightFrameBake =>
  ({ ...IDLE, groundCoverCalls: 1, groundCoverMs: ms, ...rest });

/** A frame of `renderMs` with this bake record; `undefined` leaves the record out, as a base build does. */
function frame(bake: FlightFrameBake | null | undefined, renderMs = 20): FlightFrame {
  return {
    renderMs, betweenMs: 1, heapRenderBytes: 0, heapBetweenBytes: 0, pipelinesCreated: 0,
    shaderModulesCreated: 0, shaderCodeChars: 0, passMs: {},
    ...(bake === undefined ? {} : { bake }),
  };
}

function leg(frames: readonly FlightFrame[]): FlightReport {
  return {
    frames, renderCalls: frames.length, elapsedMs: 1_000, longTasks: [], position: { x: 0, y: 0, z: 0 },
    pendingTerrainPages: 0, pendingDetailWork: 0, visibleInstances: 0, residentTerrainPages: 0, detailWorker: null,
  };
}

/** A base leg: as many frames, none recorded. */
const unrecorded = (frames: number) => leg(Array.from({ length: frames }, () => frame(undefined)));

const SHAS = { base: "05f17b4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", head: "1234567890abcdefabcdefabcdefabcdefabcdef" };

function row(rows: readonly BakeRow[], phase: string, arm: "base" | "head"): BakeRow {
  return rows.find((entry) => entry.phase === phase && entry.arm === arm)!;
}

describe("flight bake report", () => {
  // Leg 1: a one-frame re-light, then a sliced one (begin, two slices, the
  // landing, the cube, the LUT), then three ground-cover calls. It ends on a
  // second landing, whose cube and LUT fall on leg 2's first two frames, the
  // LUT's with the begin of the next rebake.
  const headLeg1 = leg([
    frame(sky(2)),
    frame(slice(0.6)),
    frame(slice(0.55)),
    frame(slice(1.3, 0.52), 31),
    frame(landing(1.5, 1.4), 33),
    frame(sky(0.1)),
    frame(sky(0.4)),
    frame(null),
    frame(cover(1.6)),
    frame(cover(2.3, { groundCoverPaceFloorCalls: 1 })),
    frame(cover(0, { groundCoverTilesCompleted: 1 })),
    frame(slice(0.5)),
    frame(landing(0.9, 0.85)),
  ]);
  const headLeg2 = leg([frame(sky(0.2)), frame(slice(0.7)), frame(null), frame(cover(1.1))]);
  const report = bakeReport({
    shas: SHAS,
    reports: { base: [unrecorded(13), unrecorded(4)], head: [headLeg1, headLeg2] },
    settleTrials: [{
      start: { x: 1, z: 2, yawDegrees: 0, distanceMeters: 25_000, vegetatedShare: 0.8 },
      base: unrecorded(3),
      // A trial is a new renderer: a teleport's one-frame re-light, then a rebake's begin.
      head: leg([frame(sky(3.2)), frame(slice(0.5)), frame(null)]),
    }],
  });

  it("is n/a for every row of an arm whose build does not report its bakes", () => {
    for (const phase of ["leg 1", "leg 2", "all legs", "trial 1"]) {
      expect(row(report.rows, phase, "base")).toEqual({ phase, arm: "base", sha: SHAS.base, sky: null, groundCover: null });
    }
  });

  it("orders the rows by leg, base before head, then each arm over its legs, then the trials", () => {
    expect(report.rows.map((entry) => `${entry.phase} ${entry.arm}`)).toEqual([
      "leg 1 base", "leg 1 head", "leg 2 base", "leg 2 head",
      "all legs base", "all legs head",
      "trial 1 base", "trial 1 head",
    ]);
  });

  it("names each sky-work frame's part of the re-light, carrying it across the arm's legs", () => {
    const first = row(report.rows, "leg 1", "head").sky!;
    expect(first.landed).toBe(2);
    expect(first.oneFrame).toBe(1);
    expect(first.workFrames).toBe(9);
    expect(first.worst).toMatchObject({ frame: 0, work: ["one-frame"], skyMs: 2 });
    expect(first.overTarget.map((entry) => [entry.frame, entry.work.join("+"), entry.skyMs, entry.renderMs])).toEqual([
      [0, "one-frame", 2, 20],
      [3, "advance", 1.3, 31],
      [4, "land", 1.5, 33],
    ]);
    expect(first.overTarget[1]).toMatchObject({ advanceMs: 0.52, applyMs: null });
    expect(first.overTarget[2]).toMatchObject({ advanceMs: null, applyMs: 1.4 });
    const second = row(report.rows, "leg 2", "head").sky!;
    expect(second.landed).toBe(0);
    expect(second.overTarget).toEqual([]);
    expect(second.worst).toMatchObject({ frame: 1, work: ["LUT", "begin"], skyMs: 0.7 });
    const all = row(report.rows, "all legs", "head").sky!;
    expect(all.landed).toBe(2);
    expect(all.workFrames).toBe(11);
    expect(all.overTarget).toHaveLength(3);
    const trial = row(report.rows, "trial 1", "head").sky!;
    expect(trial.oneFrame).toBe(1);
    expect(trial.worst).toMatchObject({ phase: "trial 1", frame: 0, work: ["one-frame"], skyMs: 3.2 });
  });

  it("tells a slice that begins a rebake from one that continues it", () => {
    // Not known at the start of the arm's first leg: a slice reads "advance".
    const unknown = bakeReport({ shas: SHAS, reports: { base: [], head: [leg([frame(slice(1.2)), frame(slice(1.1))])] } });
    expect(row(unknown.rows, "leg 1", "head").sky!.overTarget.map((entry) => entry.work)).toEqual([["advance"], ["advance"]]);
    // After a landing or a one-frame re-light nothing is in flight: the next slice begins one.
    for (const before of [landing(1.1, 1), sky(1.1)]) {
      const known = bakeReport({
        shas: SHAS,
        reports: { base: [], head: [leg([frame(before), frame(null), frame(null), frame(slice(1.2)), frame(slice(1.1))])] },
      });
      expect(row(known.rows, "leg 1", "head").sky!.overTarget.slice(1).map((entry) => entry.work)).toEqual([["begin"], ["advance"]]);
    }
  });

  it("gives each ground-cover call's ms, the calls over 2 ms, pace-floor holds and tiles", () => {
    expect(row(report.rows, "leg 1", "head").groundCover).toEqual({
      calls: 3, ms: { p50: 1.6, p95: 2.3, max: 2.3 }, overTarget: 1, paceFloorCalls: 1, tilesCompleted: 1,
    });
    expect(row(report.rows, "leg 2", "head").groundCover).toEqual({
      calls: 1, ms: { p50: 1.1, p95: 1.1, max: 1.1 }, overTarget: 0, paceFloorCalls: 0, tilesCompleted: 0,
    });
    expect(row(report.rows, "all legs", "head").groundCover).toMatchObject({ calls: 4, overTarget: 1, paceFloorCalls: 1 });
    // Recorded, but no call (held still above the blades): zero calls, not n/a.
    expect(row(report.rows, "trial 1", "head").groundCover).toEqual({
      calls: 0, ms: null, overTarget: 0, paceFloorCalls: 0, tilesCompleted: 0,
    });
  });

  it("renders both tables, n/a for the base, and lists the sky-work frames over 1 ms once", () => {
    const markdown = renderBakeMarkdown(report);
    expect(markdown).toContain("### Sky re-light and ground-cover bake");
    expect(markdown).toContain("| leg 1 | base | 05f17b4aaa | n/a | n/a | n/a | n/a | n/a |");
    expect(markdown).toContain("| leg 1 | head | 1234567890 | 2 | 1 | 9 | 2.00 (one-frame) | **3** |");
    expect(markdown).toContain("| leg 2 | head | 1234567890 | 0 | 0 | 2 | 0.70 (LUT + begin) | 0 |");
    expect(markdown).toContain("| leg 1 | head | 1234567890 | 3 | 1.60 / 2.30 / 2.30 | **1** | 1 | 1 |");
    expect(markdown).toContain("| trial 1 | head | 1234567890 | 0 | - | 0 | 0 | 0 |");
    expect(markdown).toContain("- head leg 1 frame 3: advance 1.30 ms (slice 0.52), render() 31.00 ms");
    expect(markdown).toContain("- head leg 1 frame 4: land 1.50 ms (converter 1.40), render() 33.00 ms");
    expect(markdown).toContain("- head trial 1 frame 0: one-frame 3.20 ms, render() 20.00 ms");
    // The "all legs" rows repeat the legs' frames; the list does not.
    expect(markdown.match(/- head leg 1 frame 4:/g)).toHaveLength(1);
  });

  it("says so when no recorded frame went over 1 ms, and nothing when no arm was recorded", () => {
    const quiet = renderBakeMarkdown(bakeReport({ shas: SHAS, reports: { base: [unrecorded(2)], head: [leg([frame(sky(0.3))])] } }));
    expect(quiet).toContain("No sky-work frame over 1 ms.");
    const none = renderBakeMarkdown(bakeReport({ shas: SHAS, reports: { base: [unrecorded(2)], head: [unrecorded(2)] } }));
    expect(none).not.toContain("No sky-work frame");
    expect(none).not.toContain("- head");
  });

  it("logs a leg's bakes in one line, and nothing for a build that does not report them", () => {
    expect(describeLegBakes(unrecorded(4))).toBe("");
    expect(describeLegBakes(headLeg1)).toBe(
      ", sky 2 landed / 1 one-frame, worst 2.00 ms, 3 over 1 ms; ground cover 3 calls, max 2.30 ms, 1 over 2 ms",
    );
  });
});
