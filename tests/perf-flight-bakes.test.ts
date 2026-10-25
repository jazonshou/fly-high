import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bakeReport,
  bakeSection,
  describeLegBakes,
  reaches,
  renderBakeMarkdown,
  type BakeRow,
} from "../scripts/perfFlightBakes.mts";
import { PERF_CAPTURE_SEED } from "../scripts/perf-capture.mts";
import type { FlightRenderer } from "../src/render/FlightRenderer";
import { createWorld, sampleTerrain, sampleTerrainHeight } from "../src/world";
import { FlightBakeProbe, readBakeStats, type BakeStatsReading } from "./perf/ab/bakeProbe";
import type { FlightFrame, FlightFrameBake, FlightReport } from "./perf/ab/protocol";
import { agentTerrainSamplers } from "./perf/ab/terrainSamplers";

/**
 * perf:flight's per-frame record of the renderer's two bakes that spread over
 * frames: the agent reads `getBakeStatsForCapture()` after each frame, and the
 * probe turns its running counters and newest-call figures into what that
 * frame did. The report then says, per arm and leg, which frames of a sliced
 * sky re-light went over 1 ms and what each ground-cover call cost, and n/a
 * for a base whose renderer does not report them. And perf:flight flies the
 * game's terrain samplers, which perf:ab must not.
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

  it("reads nothing from a build whose bake stats have another shape, rather than NaN or no call", () => {
    const full = reading({ frameIndex: 7 });
    const reports = (stats: unknown) => ({ getBakeStatsForCapture: () => stats });
    for (const stats of [
      null,
      undefined,
      {},
      { sky: full.sky, skyRebake: full.skyRebake },
      { ...full, sky: { frameIndex: 7 } },
      // A renamed counter, a regrouped one, a figure that is not a number.
      { ...full, skyRebake: { ...full.skyRebake, advanceCalls: undefined, advances: 3 } },
      { ...full, groundCover: { lastMilliseconds: 0, tilesCompleted: 0 }, pace: { paceFloorCalls: 0 } },
      { ...full, groundCover: { ...full.groundCover, lastMilliseconds: "0.5" } },
    ]) {
      expect(readBakeStats(reports(stats))).toBeNull();
    }
    expect(readBakeStats(reports(full))).toBe(full);
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
function frame(bake: FlightFrameBake | null | undefined, renderMs = 20, heapRenderBytes = 0): FlightFrame {
  return {
    renderMs, betweenMs: 1, heapRenderBytes, heapBetweenBytes: 0, pipelinesCreated: 0,
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
    expect(first.slicedFrames).toBe(8);
    expect(first.worst).toMatchObject({ frame: 4, work: ["land"], skyMs: 1.5 });
    expect(first.overTarget.map((entry) => [entry.frame, entry.work.join("+"), entry.skyMs, entry.renderMs])).toEqual([
      [3, "advance", 1.3, 31],
      [4, "land", 1.5, 33],
    ]);
    expect(first.overTarget[0]).toMatchObject({ advanceMs: 0.52, applyMs: null });
    expect(first.overTarget[1]).toMatchObject({ advanceMs: null, applyMs: 1.4 });
    const second = row(report.rows, "leg 2", "head").sky!;
    expect(second.landed).toBe(0);
    expect(second.slicedFrames).toBe(2);
    expect(second.overTarget).toEqual([]);
    expect(second.worst).toMatchObject({ frame: 1, work: ["LUT", "begin"], skyMs: 0.7 });
    const all = row(report.rows, "all legs", "head").sky!;
    expect(all.landed).toBe(2);
    expect(all.slicedFrames).toBe(10);
    expect(all.overTarget).toHaveLength(2);
    expect(all.oneFrame).toHaveLength(1);
  });

  it("keeps one-frame re-lights out of the sliced re-light's target, in a column of their own", () => {
    // Leg 1's first frame re-lights in one frame at 2 ms: more than any
    // sliced frame, but not the worst sliced frame, nor over the target.
    const first = row(report.rows, "leg 1", "head").sky!;
    expect(first.oneFrame.map((entry) => [entry.frame, entry.work, entry.skyMs])).toEqual([[0, ["one-frame"], 2]]);
    expect(first.overTarget.map((entry) => entry.frame)).not.toContain(0);
    // A trial's new renderer re-lights in one frame first: 3.2 ms, outside the target.
    const trial = row(report.rows, "trial 1", "head").sky!;
    expect(trial.oneFrame.map((entry) => [entry.phase, entry.frame, entry.skyMs])).toEqual([["trial 1", 0, 3.2]]);
    expect(trial.overTarget).toEqual([]);
    expect(trial.slicedFrames).toBe(1);
    expect(trial.worst).toMatchObject({ phase: "trial 1", frame: 1, work: ["begin"], skyMs: 0.5 });
  });

  it("follows each sliced re-light frame by frame, from its begin to the frame after its LUT", () => {
    const followed = report.relights.map((relight) => [
      relight.arm,
      relight.sha,
      relight.outcome,
      relight.frames.map((entry) => `${entry.phase}:${entry.frame}:${entry.work.join("+")}`),
    ]);
    expect(followed).toEqual([
      ["head", SHAS.head, "landed", [
        "leg 1:1:begin", "leg 1:2:advance", "leg 1:3:advance", "leg 1:4:land", "leg 1:5:cube", "leg 1:6:LUT", "leg 1:7:after",
      ]],
      // Across the legs: its cube and LUT fall on leg 2, and the LUT's frame begins the next.
      ["head", SHAS.head, "landed", ["leg 1:11:begin", "leg 1:12:land", "leg 2:0:cube", "leg 2:1:LUT+begin"]],
      ["head", SHAS.head, "unfinished", ["leg 2:1:LUT+begin"]],
      ["head", SHAS.head, "unfinished", ["trial 1:1:begin"]],
    ]);
    const first = report.relights[0]!.frames;
    expect(first[3]).toMatchObject({ skyMs: 1.5, advanceMs: null, applyMs: 1.4, renderMs: 33 });
    // The frame after the LUT did no sky work.
    expect(first[6]).toMatchObject({ work: ["after"], skyMs: null, advanceMs: null, applyMs: null });
    // A one-frame re-light before it lands drops it.
    const dropped = bakeReport({
      shas: SHAS,
      reports: { base: [], head: [leg([frame(null), frame(slice(0.5)), frame(slice(0.5)), frame(sky(2)), frame(null)])] },
    });
    expect(dropped.relights.map((relight) => [relight.outcome, relight.frames.map((entry) => entry.frame)]))
      .toEqual([["dropped", [1, 2]]]);
  });

  it("gives each re-light frame's render() and the passes its work lands in, against the leg's medians", () => {
    const timed = (bake: FlightFrameBake | null, renderMs: number, presentation: number, scene: number): FlightFrame => ({
      ...frame(bake, renderMs),
      passMs: { "flight-presentation": presentation, "hdr-present": scene, "world-page-visibility": 3 },
    });
    const quiet = Array.from({ length: 9 }, () => timed(null, 10, 1, 5));
    const relit = bakeReport({
      shas: SHAS,
      reports: {
        base: [],
        head: [leg([
          ...quiet,
          timed(slice(1.2, 0.6), 12, 1.6, 5),
          timed(landing(4.6, 4.2), 16, 4.8, 5),
          // The cube: no time in the refresh, the six faces in the scene pass.
          timed(sky(0), 19.3, 0.2, 13),
          timed(sky(0.7), 17.9, 9.5, 5),
          timed(null, 27.8, 0.2, 17.9),
          // A build that does not time the scene pass on this frame.
          { ...frame(null, 10), passMs: { "flight-presentation": 1 } },
        ])],
      },
    });
    const [relight] = relit.relights;
    expect(relight!.frames.map((entry) => entry.work.join("+"))).toEqual(["begin", "land", "cube", "LUT", "after"]);
    expect(relight!.frames[2]).toMatchObject({
      renderMs: 19.3,
      renderP50Ms: 10,
      passes: { "flight-presentation": { ms: 0.2, p50Ms: 1 }, "hdr-present": { ms: 13, p50Ms: 5 } },
    });
    const markdown = renderBakeMarkdown(relit);
    expect(markdown).toContain(
      "| re-light | arm | phase | frame | work | sky ms | render() ms (leg p50) | flight-presentation ms (leg p50) "
        + "| hdr-present ms (leg p50) |",
    );
    expect(markdown).toContain("| 1 landed | head | leg 1 | 9 | begin | 1.20 (slice 0.60) | 12.00 (10.00) | 1.60 (1.00) | 5.00 (5.00) |");
    expect(markdown).toContain("| 1 landed | head | leg 1 | 10 | land | 4.60 (converter 4.20) | 16.00 (10.00) | 4.80 (1.00) | 5.00 (5.00) |");
    expect(markdown).toContain("| 1 landed | head | leg 1 | 11 | cube | 0.00 | 19.30 (10.00) | 0.20 (1.00) | 13.00 (5.00) |");
    expect(markdown).toContain("| 1 landed | head | leg 1 | 13 | after | - | 27.80 (10.00) | 0.20 (1.00) | 17.90 (5.00) |");
    // No re-light, no table.
    const none = renderBakeMarkdown(bakeReport({ shas: SHAS, reports: { base: [], head: [leg([frame(sky(2)), frame(null)])] } }));
    expect(none).not.toContain("| re-light |");
    // A pass the frame did not time reads n/a.
    const untimed = bakeReport({
      shas: SHAS,
      reports: { base: [], head: [leg([frame(null), { ...frame(slice(0.5)), passMs: { "flight-presentation": 0.9 } }])] },
    });
    expect(untimed.relights[0]!.frames[0]!.passes).toEqual({ "flight-presentation": { ms: 0.9, p50Ms: 0.9 }, "hdr-present": null });
  });

  it("tells a slice that begins a rebake from one that continues it", () => {
    // Not known at the start of the arm's first leg: a slice reads "advance".
    const unknown = bakeReport({ shas: SHAS, reports: { base: [], head: [leg([frame(slice(1.2)), frame(slice(1.1))])] } });
    expect(row(unknown.rows, "leg 1", "head").sky!.overTarget.map((entry) => entry.work)).toEqual([["advance"], ["advance"]]);
    // Nor after a frame without sky work: a rebake in flight runs the refresh on every frame.
    const quiet = bakeReport({ shas: SHAS, reports: { base: [], head: [leg([frame(null), frame(slice(1.3)), frame(slice(1.2))])] } });
    expect(row(quiet.rows, "leg 1", "head").sky!.overTarget.map((entry) => entry.work)).toEqual([["begin"], ["advance"]]);
    // After a landing or a one-frame re-light nothing is in flight: the next slice begins one.
    for (const before of [landing(1.1, 1), sky(1.1)]) {
      const known = bakeReport({
        shas: SHAS,
        reports: { base: [], head: [leg([frame(before), frame(null), frame(null), frame(slice(1.2)), frame(slice(1.1))])] },
      });
      const sliced = row(known.rows, "leg 1", "head").sky!.overTarget;
      expect(sliced.slice(sliced.length - 2).map((entry) => entry.work)).toEqual([["begin"], ["advance"]]);
    }
  });

  it("counts a reading at the target with those over it, whichever way the float error falls", () => {
    // The page's clock reads in 0.1 ms steps; a difference of two readings is
    // the step's multiple give or take the last bit.
    expect(reaches(1, 1)).toBe(true);
    expect(reaches(1.0000000000000002, 1)).toBe(true);
    expect(reaches(0.9999999999999998, 1)).toBe(true);
    expect(reaches(0.9000000000000004, 1)).toBe(false);
    expect(reaches(1.9999999999999996, 2)).toBe(true);
    expect(reaches(1.9, 2)).toBe(false);
    const atTarget = bakeReport({
      shas: SHAS,
      reports: {
        base: [],
        head: [leg([
          frame(null), frame(slice(0.9999999999999998)), frame(slice(0.9000000000000004)),
          frame(cover(1.9999999999999996)), frame(cover(1.9)),
        ])],
      },
    });
    const head = row(atTarget.rows, "leg 1", "head");
    expect(head.sky!.overTarget.map((entry) => entry.frame)).toEqual([1]);
    expect(head.groundCover!.overTarget.map((call) => call.frame)).toEqual([3]);
  });

  it("gives each ground-cover call's ms, the calls over 2 ms, pace-floor holds and tiles", () => {
    expect(row(report.rows, "leg 1", "head").groundCover).toEqual({
      calls: 3,
      ms: { p50: 1.6, p95: 2.3, max: 2.3 },
      overTarget: [{
        phase: "leg 1", frame: 9, ms: 2.3, paceFloor: true, tileCompleted: false, collection: false, renderMs: 20,
      }],
      overTargetUnflagged: 0,
      paceFloorCalls: 1,
      tilesCompleted: 1,
    });
    expect(row(report.rows, "leg 2", "head").groundCover).toEqual({
      calls: 1, ms: { p50: 1.1, p95: 1.1, max: 1.1 }, overTarget: [], overTargetUnflagged: 0, paceFloorCalls: 0, tilesCompleted: 0,
    });
    expect(row(report.rows, "all legs", "head").groundCover).toMatchObject({ calls: 4, paceFloorCalls: 1 });
    expect(row(report.rows, "all legs", "head").groundCover!.overTarget).toHaveLength(1);
    // Recorded, but no call (held still above the blades): zero calls, not n/a.
    expect(row(report.rows, "trial 1", "head").groundCover).toEqual({
      calls: 0, ms: null, overTarget: [], overTargetUnflagged: 0, paceFloorCalls: 0, tilesCompleted: 0,
    });
  });

  it("flags each call over 2 ms with a collection in its frame's render(), a pace-floor hold or the tile's uploads", () => {
    const flagged = bakeReport({
      shas: SHAS,
      reports: {
        base: [],
        head: [leg([
          // Over 2 ms: with a collection (the heap fell in render()), a
          // pace-floor hold, the tile's uploads, none, and an unmeasured heap.
          frame(cover(5.1), 24, -31_000_000),
          frame(cover(2.4, { groundCoverPaceFloorCalls: 1 }), 22, 1_500_000),
          frame(cover(3, { groundCoverTilesCompleted: 1 }), 21, 1_200_000),
          frame(cover(4.2), 23, 1_800_000),
          frame(cover(2.2), 19, Number.NaN),
          // Under: flags do not matter.
          frame(cover(1.5), 18, -2_000_000),
        ])],
      },
    });
    const cover1 = row(flagged.rows, "leg 1", "head").groundCover!;
    expect(cover1.overTarget.map((call) => [call.frame, call.collection, call.paceFloor, call.tileCompleted])).toEqual([
      [0, true, false, false],
      [1, false, true, false],
      [2, false, false, true],
      [3, false, false, false],
      [4, null, false, false],
    ]);
    // The tile's uploads are the bake's own cost, and an unmeasured heap is no collection known.
    expect(cover1.overTargetUnflagged).toBe(3);
    const markdown = renderBakeMarkdown(flagged);
    expect(markdown).toContain("| leg 1 | head | 1234567890 | 6 | 2.40 / 5.10 / 5.10 | **5** | 3 | 1 | 1 |");
    expect(markdown).toContain("- head leg 1 frame 0: 5.10 ms; collection in render(), render() 24.00 ms");
    expect(markdown).toContain("- head leg 1 frame 1: 2.40 ms; pace-floor hold, render() 22.00 ms");
    expect(markdown).toContain("- head leg 1 frame 2: 3.00 ms; finished the tile (its three uploads), render() 21.00 ms");
    expect(markdown).toContain("- head leg 1 frame 3: 4.20 ms, render() 23.00 ms");
    expect(markdown).toContain("- head leg 1 frame 4: 2.20 ms; heap not measured, render() 19.00 ms");
    expect(markdown).not.toContain("frame 5: 1.50");
    expect(describeLegBakes(leg([frame(cover(5.1), 24, -31_000_000), frame(cover(4.2))])))
      .toBe(", no sliced sky re-light; ground cover 2 calls, max 5.10 ms, 2 at or over 2 ms (1 with no collection or pace-floor hold)");
  });

  it("renders both tables, n/a for the base, and lists the sky-work frames over 1 ms once", () => {
    const markdown = renderBakeMarkdown(report);
    expect(markdown).toContain("### Sky re-light and ground-cover bake");
    expect(markdown).toContain("| leg 1 | base | 05f17b4aaa | n/a | n/a | n/a | n/a | n/a |");
    expect(markdown).toContain("| leg 1 | head | 1234567890 | 2 | 8 | 1.50 (land) | **2** | 1 (2.00) |");
    expect(markdown).toContain("| leg 2 | head | 1234567890 | 0 | 2 | 0.70 (LUT + begin) | 0 | 0 |");
    expect(markdown).toContain("| trial 1 | head | 1234567890 | 0 | 1 | 0.50 (begin) | 0 | 1 (3.20) |");
    expect(markdown).toContain("| leg 1 | head | 1234567890 | 3 | 1.60 / 2.30 / 2.30 | **1** | 0 | 1 | 1 |");
    expect(markdown).toContain("| trial 1 | head | 1234567890 | 0 | - | - | - | 0 | 0 |");
    expect(markdown).toContain("| leg 1 | base | 05f17b4aaa | n/a | n/a | n/a | n/a | n/a | n/a |");
    expect(markdown).toContain("- head leg 1 frame 9: 2.30 ms; pace-floor hold, render() 20.00 ms");
    expect(markdown).toContain("- head leg 1 frame 3: advance 1.30 ms (slice 0.52), render() 31.00 ms");
    expect(markdown).toContain("- head leg 1 frame 4: land 1.50 ms (converter 1.40), render() 33.00 ms");
    // The one-frame re-lights in a list of their own, after the sliced frames'.
    const oneFrameList = markdown.indexOf("One-frame re-lights, outside the target:");
    expect(oneFrameList).toBeGreaterThan(markdown.indexOf("- head leg 1 frame 4:"));
    expect(markdown.indexOf("- head leg 1 frame 0: one-frame 2.00 ms, render() 20.00 ms")).toBeGreaterThan(oneFrameList);
    expect(markdown.indexOf("- head trial 1 frame 0: one-frame 3.20 ms, render() 20.00 ms")).toBeGreaterThan(oneFrameList);
    // The "all legs" rows repeat the legs' frames; the list does not.
    expect(markdown.match(/- head leg 1 frame 4:/g)).toHaveLength(1);
  });

  it("says so when no sliced frame reached 1 ms, and nothing when no arm was recorded", () => {
    const quiet = renderBakeMarkdown(bakeReport({ shas: SHAS, reports: { base: [unrecorded(2)], head: [leg([frame(slice(0.3))])] } }));
    expect(quiet).toContain("No sliced-re-light frame at or over 1 ms.");
    const none = renderBakeMarkdown(bakeReport({ shas: SHAS, reports: { base: [unrecorded(2)], head: [unrecorded(2)] } }));
    expect(none).not.toContain("No sliced-re-light frame");
    expect(none).not.toContain("Not exercised");
    expect(none).not.toContain("- head");
  });

  it("says a target was not exercised when an arm's legs never reached it, not that it held", () => {
    // The specified smoke runs: a climb too short for a re-light, an approach
    // that never came down to the blades. Only a one-frame re-light and
    // slices that did not land.
    const unexercised = bakeReport({
      shas: SHAS,
      reports: {
        base: [unrecorded(4), unrecorded(4)],
        head: [leg([frame(sky(2.5)), frame(null), frame(null)]), leg([frame(null), frame(slice(0.4)), frame(slice(0.5))])],
      },
    });
    const markdown = renderBakeMarkdown(unexercised);
    expect(markdown).toContain("| leg 1 | head | 1234567890 | 0 | 0 | - | - | 1 (2.50) |");
    expect(markdown).toContain("| leg 2 | head | 1234567890 | 0 | 2 | 0.50 (advance) | 0 | 0 |");
    expect(markdown).toContain("| all legs | head | 1234567890 | 0 | 2 | 0.50 (advance) | 0 | 1 (2.50) |");
    // The ground-cover table: no call, so neither the per-call ms nor the calls over 2 ms.
    expect(markdown).toContain("| all legs | head | 1234567890 | 0 | - | - | - | 0 | 0 |");
    expect(markdown).toContain(
      "**Not exercised:** no sliced re-light landed in the legs of head, so this run does not check the 1 ms target there.",
    );
    expect(markdown).toContain(
      "**Not exercised:** no tile-bake call in the legs of head, so this run does not check the 2 ms target there.",
    );
    expect(markdown).toContain("--leg-frames 720");
    expect(markdown).toContain("--start <x,z>");
    // The base reads n/a, not "not exercised".
    expect(markdown).not.toMatch(/legs of base/);
    // Once each arm's legs exercise both, neither note.
    expect(renderBakeMarkdown(report)).not.toContain("Not exercised");
  });

  it("costs only its own section when it cannot read the frames: the rest of the report is still written", () => {
    const good = bakeSection({ shas: SHAS, reports: { base: [], head: [headLeg2] } });
    expect(good.bakes).toEqual(bakeReport({ shas: SHAS, reports: { base: [], head: [headLeg2] } }));
    expect(good.markdown).toBe(renderBakeMarkdown(good.bakes!));
    const broken = { ...headLeg2, frames: null } as unknown as FlightReport;
    const failed = bakeSection({ shas: SHAS, reports: { base: [], head: [broken] } });
    expect(failed.bakes).toBeNull();
    expect(failed.markdown).toMatch(/^### Sky re-light and ground-cover bake\n\nThe bake section failed: .+; report\.json carries `bakes: null`\.\n$/);
    expect(describeLegBakes(broken)).toMatch(/^, bake summary failed: /);
    // perf:flight writes report.json and report.md from it, not from the throwing parts.
    const flight = readFileSync(fileURLToPath(new URL("../scripts/perf-flight.mts", import.meta.url)), "utf8");
    expect(flight).toContain("bakeSection({ shas, reports, settleTrials: trials })");
    expect(flight).not.toMatch(/\b(bakeReport|renderBakeMarkdown)\(/);
  });

  it("logs a leg's bakes in one line, and nothing for a build that does not report them", () => {
    expect(describeLegBakes(unrecorded(4))).toBe("");
    expect(describeLegBakes(headLeg1)).toBe(
      ", sky 2 landed, worst sliced frame 1.50 ms, 2 at or over 1 ms, 1 one-frame (worst 2.00 ms); "
        + "ground cover 3 calls, max 2.30 ms, 1 at or over 2 ms (0 with no collection or pace-floor hold)",
    );
    // Recorded, with neither bake at work (a leg too high for the blades, below any re-light).
    expect(describeLegBakes(leg([frame(null), frame(null)]))).toBe(", no sliced sky re-light; no ground-cover bake");
    expect(describeLegBakes(leg([frame(sky(4.5)), frame(null)])))
      .toBe(", no sliced sky re-light, 1 one-frame (worst 4.50 ms); no ground-cover bake");
  });
});

describe("the agent's terrain samplers", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");

  it("hand the renderer the full sample alone unless perf:flight asks for the game's pair", () => {
    const calls: string[] = [];
    const world = { name: "world" };
    const sample = (target: typeof world, x: number, z: number) => {
      calls.push(`sample ${target.name} ${x} ${z}`);
      return { height: x + z };
    };
    const height = (target: typeof world, x: number, z: number) => {
      calls.push(`height ${target.name} ${x} ${z}`);
      return x - z;
    };
    for (const flag of [undefined, null, false]) {
      const samplers = agentTerrainSamplers(world, flag, sample, height);
      // perf:ab's renderer options: the key is absent, not undefined.
      expect(Object.keys(samplers)).toEqual(["terrainSample"]);
      expect(samplers.terrainSample(3, 4)).toEqual({ height: 7 });
    }
    const game = agentTerrainSamplers(world, true, sample, height);
    expect(Object.keys(game)).toEqual(["terrainSample", "terrainHeight"]);
    expect(game.terrainHeight!(3, 4)).toBe(-1);
    expect(game.terrainSample(5, 6)).toEqual({ height: 11 });
    expect(calls).toEqual([
      "sample world 3 4", "sample world 3 4", "sample world 3 4", "height world 3 4", "sample world 5 6",
    ]);
  });

  it("give the perf world's height bit for bit as its full sample, as FlightRenderer requires", () => {
    // The world the agent flies perf:flight's shot in (its seed, the shot's evolution or "analytic").
    const world = createWorld(PERF_CAPTURE_SEED, { worldEvolution: "analytic" });
    const { terrainSample, terrainHeight } = agentTerrainSamplers(world, true, sampleTerrain, sampleTerrainHeight);
    const airportX = world.airport?.centerX ?? 0;
    const airportZ = world.airport?.centerZ ?? 0;
    for (const [dx, dz] of [[0, 0], [-2_500, 0], [-2_437.5, 61.25], [8_000, -4_000], [-31_000, 17_500]] as const) {
      expect(terrainHeight!(airportX + dx, airportZ + dz)).toBe(terrainSample(airportX + dx, airportZ + dz).height);
    }
  });

  it("are asked for by perf:flight alone: perf:ab and the capture never pass the height-only sampler", () => {
    const flight = read("scripts/perf-flight.mts");
    expect(flight).toMatch(/call\("configure", \{[^}]*gameTerrainHeight: true,\n\s*\}\)/);
    // Its report says the base may not have honoured it: a build before the option ignores it.
    expect(flight).toContain('gameTerrainHeight: "requested; a build without FlightRendererOptions.terrainHeight ignores it",');
    expect(renderBakeMarkdown(bakeReport({ shas: SHAS, reports: { base: [], head: [] } })))
      .toContain("a build without FlightRendererOptions.terrainHeight (before 69746b7) ignores it and bakes whole rows");
    // perf:ab's agent configuration names no such field, so it is absent.
    expect(read("scripts/perf-ab.mts")).not.toMatch(/gameTerrainHeight|terrainHeight/);
    // The agent passes the flag to the helper and nowhere else.
    const agent = read("tests/perf/ab/agent.ts");
    expect(agent.match(/gameTerrainHeight/g)).toHaveLength(1);
    expect(agent).toContain(
      "...agentTerrainSamplers(activeWorld, config.gameTerrainHeight, sampleTerrain, sampleTerrainHeight),",
    );
    expect(agent).not.toMatch(/terrainHeight:/);
    // The capture creates its own renderer, with the full sample alone.
    expect(read("tests/perf/perf-capture.test.ts")).not.toMatch(/terrainHeight|agentTerrainSamplers/);
  });

  it("leave perf:ab's frames without the bake read: only a flight leg reads it, and perf:ab never flies", () => {
    const agent = read("tests/perf/ab/agent.ts");
    const flight = agent.indexOf("  async flight(request: FlightRequest): Promise<FlightReport> {");
    const next = agent.indexOf("\n  landStarts(", flight);
    expect(flight).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(flight);
    const reads = [...agent.matchAll(/readBakeStats\(active\)/g)].map((match) => match.index);
    expect(reads).toHaveLength(2);
    for (const index of reads) {
      expect(index).toBeGreaterThan(flight);
      expect(index).toBeLessThan(next);
    }
    expect(read("scripts/perf-ab.mts")).not.toMatch(/\.call\("flight"/);
  });
});
