import { describe, expect, it } from "vitest";
import type { FlightRenderer } from "../src/render/FlightRenderer";
import { FlightBakeProbe, readBakeStats, type BakeStatsReading } from "./perf/ab/bakeProbe";

/**
 * perf:flight's per-frame record of the renderer's two bakes that spread over
 * frames: the agent reads `getBakeStatsForCapture()` after each frame, and the
 * probe turns its running counters and newest-call figures into what that
 * frame did.
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
