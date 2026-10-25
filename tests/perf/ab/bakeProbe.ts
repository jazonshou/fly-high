/**
 * Each flight frame's share of the renderer's two bakes that spread over
 * frames, the sky probe's re-light and the ground-cover tile, for
 * perf:flight's report (`scripts/perfFlightBakes.mts`).
 *
 * `FlightRenderer.getBakeStatsForCapture()` holds running counters and the
 * newest call's figures, and the agent reads it once after every frame of a
 * leg, outside the frame's timed and heap windows. Against the previous read:
 *  - the sky-probe refresh ran in this frame when its frame index moved, and
 *    its `lastMilliseconds` is then this frame's;
 *  - a sliced rebake sampled in this frame when `advanceCalls` moved, and one
 *    landed its irradiance (the converter) when `bakesCompleted` moved; the
 *    refresh does at most one of each a frame, so each `last` figure is then
 *    this frame's (`SkyRebakeStats` says to read them so);
 *  - the ground-cover update zeroes its `lastMilliseconds` on every frame
 *    before it bakes, and runs on every frame (the world-page-visibility
 *    pass), so a figure above zero is this frame's call; so is a move of
 *    `tilesCompleted` or `paceFloorCalls`, which also catches a call that
 *    finished a tile inside one tick of the clock. It has no call counter.
 *
 * Constant time. The probe allocates only a frame that baked its record; the
 * renderer's read makes a few small objects every frame, in the window
 * between the frame's heap figures that neither counts. Pure: a node test
 * drives it with made-up readings (tests/perf-flight-bakes.test.ts).
 */

import type { FlightFrameBake } from "./protocol";

/** What the probe reads of `getBakeStatsForCapture()`, loosely: a base build has no such method. */
export interface BakeStatsReading {
  readonly sky: { readonly frameIndex: number; readonly lastMilliseconds: number };
  readonly skyRebake: {
    readonly advanceCalls: number;
    readonly lastAdvanceMilliseconds: number;
    readonly bakesCompleted: number;
    readonly lastApplyMilliseconds: number;
  };
  readonly groundCover: {
    readonly lastMilliseconds: number;
    readonly tilesCompleted: number;
    readonly paceFloorCalls: number;
  };
}

/** The renderer's bake counters, or null from a build whose renderer does not report them. */
export function readBakeStats(renderer: object): BakeStatsReading | null {
  return (renderer as { getBakeStatsForCapture?: () => BakeStatsReading }).getBakeStatsForCapture?.() ?? null;
}

export class FlightBakeProbe {
  private skyFrameIndex: number;
  private advanceCalls: number;
  private bakesCompleted: number;
  private tilesCompleted: number;
  private paceFloorCalls: number;

  /** `start`: a read before the window's first frame. */
  constructor(start: BakeStatsReading) {
    this.skyFrameIndex = start.sky.frameIndex;
    this.advanceCalls = start.skyRebake.advanceCalls;
    this.bakesCompleted = start.skyRebake.bakesCompleted;
    this.tilesCompleted = start.groundCover.tilesCompleted;
    this.paceFloorCalls = start.groundCover.paceFloorCalls;
  }

  /** The frame just rendered, from a read after it: null when neither bake did anything. */
  observe(after: BakeStatsReading): FlightFrameBake | null {
    const { sky, skyRebake, groundCover } = after;
    const skyRan = sky.frameIndex !== this.skyFrameIndex;
    const skyAdvances = skyRebake.advanceCalls - this.advanceCalls;
    const skyLandings = skyRebake.bakesCompleted - this.bakesCompleted;
    const tiles = groundCover.tilesCompleted - this.tilesCompleted;
    const paceFloor = groundCover.paceFloorCalls - this.paceFloorCalls;
    this.skyFrameIndex = sky.frameIndex;
    this.advanceCalls = skyRebake.advanceCalls;
    this.bakesCompleted = skyRebake.bakesCompleted;
    this.tilesCompleted = groundCover.tilesCompleted;
    this.paceFloorCalls = groundCover.paceFloorCalls;
    const groundCoverCalls = groundCover.lastMilliseconds > 0 || tiles > 0 || paceFloor > 0 ? 1 : 0;
    if (!skyRan && skyAdvances === 0 && skyLandings === 0 && groundCoverCalls === 0) return null;
    return {
      skyMs: skyRan ? sky.lastMilliseconds : null,
      skyAdvances,
      skyAdvanceMs: skyAdvances > 0 ? skyRebake.lastAdvanceMilliseconds : null,
      skyLandings,
      skyApplyMs: skyLandings > 0 ? skyRebake.lastApplyMilliseconds : null,
      groundCoverCalls,
      groundCoverMs: groundCoverCalls > 0 ? groundCover.lastMilliseconds : null,
      groundCoverPaceFloorCalls: paceFloor,
      groundCoverTilesCompleted: tiles,
    };
  }
}
