import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  GROUND_COVER_TILE_BAKE_PACE_COLUMNS,
  GROUND_COVER_TILE_BAKE_STEP_ATTRIBUTE_COLUMNS,
  GROUND_COVER_TILE_BAKE_STEP_HEIGHT_COLUMNS,
  GroundCoverSystem,
  type GroundCoverSystemOptions,
} from "../src/render/webgpu/detail/GroundCoverSystem";
import {
  GROUND_COVER_ATTRIBUTE_TILE_EDGE,
  GROUND_COVER_HEIGHT_TILE_EDGE,
  GROUND_COVER_LAWS,
  GROUND_COVER_TILE_BAKE_MILLISECONDS_PER_FRAME,
  GROUND_COVER_TILE_SPAN_METERS,
} from "../src/render/webgpu/detail/groundCoverLaw";
import { createWorld, sampleTerrain, sampleTerrainHeight, TerrainBiome } from "../src/world";
import type { TerrainSample } from "../src/world/types";

/**
 * The ground-cover domain tile bakes in budgeted steps.
 *
 * `advanceTileBake` checked its 1.5 ms budget only between rows, and a row is
 * 256 full terrain samples (4-10 ms) plus, every fourth row, a 64-column
 * attribute row, so every call near the ground ran at least one whole row,
 * frame after frame, for as long as the camera kept the tile moving. With the
 * height-only sampler the bake resumes at a column cursor and checks the clock
 * every 32 m of row. What has to hold:
 *
 * 1. the tile's bytes do not depend on the budget, the step or the sampler;
 * 2. without the height-only sampler every call makes exactly the progress the
 *    whole-row bake made, so a host that has not wired it is never slower;
 * 3. with it, a tile on a ground roll takes no more frames than the whole-row
 *    bake and every frame costs less, bounded by the budget plus one step on a
 *    host fast enough to keep pace inside the budget;
 * 4. the perf probe's counters report what the bake cost.
 *
 * NullEngine has no compute, so the system constructs inert. Switching
 * `gpuActive` on afterwards leaves it without a material, textures or rings
 * (`buildRings` returns at its first guard) and lets `update` run its CPU
 * half: the gate, the snap and the bake.
 */

interface BakeInternals {
  gpuActive: boolean;
  backHeights: Float32Array;
  backAttributes: Uint8Array;
  backDrivers: Uint8Array;
  backTileRow: number;
  backTileColumn: number;
  backTilePhase: "height" | "attribute";
  backTileSweptColumns: number;
}

const LAW = GROUND_COVER_LAWS[1]!;
const BUDGET = GROUND_COVER_TILE_BAKE_MILLISECONDS_PER_FRAME;
const HEIGHT_EDGE = GROUND_COVER_HEIGHT_TILE_EDGE;
const ATTRIBUTE_EDGE = GROUND_COVER_ATTRIBUTE_TILE_EDGE;
const ROWS_PER_ATTRIBUTE_ROW = HEIGHT_EDGE / ATTRIBUTE_EDGE;

/**
 * Per-sample costs the work clock charges, in milliseconds. Binary fractions,
 * so the clock's sums are exact and no comparison with the budget can round.
 * The slow host is about this cloud container (measured: ~40 us a full sample,
 * ~10 us the height alone), whose height-only row, at 2 ms here, does not fit
 * the budget. The fast one is about the M1 runner (a 4.4 ms full row), whose
 * height-only row, at 1 ms here, does.
 */
interface SampleCosts {
  readonly full: number;
  readonly height: number;
}
const SLOW_HOST: SampleCosts = { full: 1 / 32, height: 1 / 128 };
const FAST_HOST: SampleCosts = { full: 1 / 64, height: 1 / 256 };

/** A clock only work moves: each sampler call charges its modelled cost. */
class WorkClock {
  milliseconds = 0;
  readonly now = (): number => this.milliseconds;
}

interface Samplers {
  readonly terrainSample: (x: number, z: number) => TerrainSample;
  readonly terrainHeight: (x: number, z: number) => number;
}

function costed(samplers: Samplers, clock: WorkClock, costs: SampleCosts): Samplers {
  return {
    terrainSample: (x, z) => {
      clock.milliseconds += costs.full;
      return samplers.terrainSample(x, z);
    },
    terrainHeight: (x, z) => {
      clock.milliseconds += costs.height;
      return samplers.terrainHeight(x, z);
    },
  };
}

class BakingSystem {
  readonly system: GroundCoverSystem;
  readonly internals: BakeInternals;
  private readonly engine = new NullEngine();
  private readonly scene = new Scene(this.engine);

  constructor(options: GroundCoverSystemOptions) {
    this.system = new GroundCoverSystem(this.scene, options);
    this.internals = this.system as unknown as BakeInternals;
    this.internals.gpuActive = true;
  }

  frame(cameraX: number, cameraZ: number, cameraY: number): void {
    this.system.update({
      cameraWorldX: cameraX,
      cameraWorldY: cameraY,
      cameraWorldZ: cameraZ,
      floatingOriginX: 0,
      floatingOriginZ: 0,
      law: LAW,
      windDirectionX: 1,
      windDirectionZ: 0,
      windStrength01: 0.3,
      windGust01: 0.2,
      simulationTimeSeconds: 0,
    });
  }

  dispose(): void {
    this.system.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}

// ---------------------------------------------------------------------------
// The home field's tile: runway, airfield grass and open grassland
// ---------------------------------------------------------------------------

const world = createWorld();
const fullSamples = new Map<string, TerrainSample>();
const heights = new Map<string, number>();
/** The real samplers, memoised: every run bakes the same grid points. */
const worldSamplers: Samplers = {
  terrainSample: (x, z) => {
    const key = `${x},${z}`;
    let sample = fullSamples.get(key);
    if (!sample) {
      sample = sampleTerrain(world, x, z);
      fullSamples.set(key, sample);
    }
    return sample;
  },
  terrainHeight: (x, z) => {
    const key = `${x},${z}`;
    let height = heights.get(key);
    if (height === undefined) {
      height = sampleTerrainHeight(world, x, z);
      heights.set(key, height);
    }
    return height;
  },
};
const HOME_X = world.airport!.centerX;
const HOME_Z = world.airport!.centerZ;
const HOME_Y = sampleTerrainHeight(world, HOME_X, HOME_Z) + 3;

interface BakedTile {
  readonly heights: Float32Array;
  readonly attributes: Uint8Array;
  readonly drivers: Uint8Array;
  readonly updates: number;
}

/** Bake one tile at the home field, the camera parked, and copy its bytes. */
function bakeHomeTile(
  options: GroundCoverSystemOptions,
  afterUpdate?: (baking: BakingSystem, update: number) => void,
): BakedTile {
  const baking = new BakingSystem({
    seedHash: world.sourceSeedHash,
    seaLevelMeters: world.seaLevel,
    ...options,
  });
  try {
    let updates = 0;
    while (baking.system.bakeStats.tilesCompleted === 0) {
      baking.frame(HOME_X, HOME_Z, HOME_Y);
      updates += 1;
      afterUpdate?.(baking, updates);
      expect(updates, "the tile never completed").toBeLessThanOrEqual(2 * HEIGHT_EDGE);
    }
    return {
      heights: baking.internals.backHeights.slice(),
      attributes: baking.internals.backAttributes.slice(),
      drivers: baking.internals.backDrivers.slice(),
      updates,
    };
  } finally {
    baking.dispose();
  }
}

function expectSameBytes(run: string, actual: BakedTile, expected: BakedTile): void {
  const same = (a: ArrayBufferView, b: ArrayBufferView): boolean =>
    Buffer.compare(
      Buffer.from(a.buffer, a.byteOffset, a.byteLength),
      Buffer.from(b.buffer, b.byteOffset, b.byteLength),
    ) === 0;
  expect(same(actual.heights, expected.heights), `${run}: heights`).toBe(true);
  expect(same(actual.attributes, expected.attributes), `${run}: attributes`).toBe(true);
  expect(same(actual.drivers, expected.drivers), `${run}: drivers`).toBe(true);
}

let referenceTile: BakedTile | null = null;
/** The whole-row bake with no budget at all: one call, the code path as it was. */
function reference(): BakedTile {
  referenceTile ??= bakeHomeTile({ terrainSample: worldSamplers.terrainSample, now: () => 0 });
  return referenceTile;
}

describe("ground-cover tile bake: the bytes", () => {
  it("bakes a tile with something in it", () => {
    const tile = reference();
    expect(tile.updates).toBe(1);
    let bare = 0;
    let covered = 0;
    let driven = 0;
    for (let texel = 0; texel < ATTRIBUTE_EDGE * ATTRIBUTE_EDGE; texel += 1) {
      if (tile.attributes[texel * 4 + 3] === 0) bare += 1;
      else covered += 1;
      if (tile.drivers[texel * 4 + 3]! > 0) driven += 1;
    }
    // Runway (no cover), grass (cover) and the density field's coverage lane.
    expect(bare).toBeGreaterThan(0);
    expect(covered).toBeGreaterThan(0);
    expect(driven).toBeGreaterThan(0);
    expect(new Set(tile.heights).size).toBeGreaterThan(1000);
  });

  it("is the same at every budget and step, and with either sampler", () => {
    const wholeRowsSlow = new WorkClock();
    expectSameBytes(
      "whole rows, slow host",
      bakeHomeTile({
        terrainSample: costed(worldSamplers, wholeRowsSlow, SLOW_HOST).terrainSample,
        now: wholeRowsSlow.now,
      }),
      reference(),
    );
    expectSameBytes(
      "columns, no budget",
      bakeHomeTile({ ...worldSamplers, now: () => 0 }),
      reference(),
    );
    const fast = new WorkClock();
    expectSameBytes(
      "columns, fast host (the budget binds)",
      bakeHomeTile({ ...costed(worldSamplers, fast, FAST_HOST), now: fast.now }),
      reference(),
    );
    const slow = new WorkClock();
    expectSameBytes(
      "columns, slow host (the pace floor binds)",
      bakeHomeTile({ ...costed(worldSamplers, slow, SLOW_HOST), now: slow.now }),
      reference(),
    );
  });

  it("is the same when every call takes a single 32 m step", () => {
    // A clock that stands still for a head start, then reads over budget at
    // every check: the first call sweeps well ahead of the pace floor, and
    // every call after it takes exactly one step until the floor catches up.
    let reads = 0;
    const headStartReads = 1_500;
    const now = (): number => {
      reads += 1;
      return reads <= headStartReads ? 0 : reads * 2 * BUDGET;
    };
    let swept = 0;
    let singleSteps = 0;
    let endedInsideHeightRow = false;
    let endedInsideAttributeRow = false;
    const tile = bakeHomeTile({ ...worldSamplers, now }, (baking) => {
      const internals = baking.internals;
      if (internals.backTileRow < 0) return;
      if (internals.backTileSweptColumns - swept === GROUND_COVER_TILE_BAKE_STEP_HEIGHT_COLUMNS) {
        singleSteps += 1;
        if (internals.backTileColumn > 0 && internals.backTilePhase === "height") {
          endedInsideHeightRow = true;
        }
        if (internals.backTileColumn > 0 && internals.backTilePhase === "attribute") {
          endedInsideAttributeRow = true;
        }
      }
      swept = internals.backTileSweptColumns;
    });
    expectSameBytes("columns, one step per call", tile, reference());
    expect(singleSteps).toBeGreaterThan(100);
    expect(endedInsideHeightRow).toBe(true);
    expect(endedInsideAttributeRow).toBe(true);
    expect(tile.updates).toBeLessThanOrEqual(HEIGHT_EDGE);
  });

  it("starts over cleanly when the ground under a half-baked tile changes", () => {
    // An airport spawning under the tile mid-bake. The cursor has to rewind
    // to the first column of the first height row: a column or phase left
    // behind would keep texels baked against the old ground.
    let raised = 0;
    const changing: Samplers = {
      terrainSample: (x, z) => {
        const sample = worldSamplers.terrainSample(x, z);
        return raised === 0 ? sample : { ...sample, height: sample.height + raised };
      },
      terrainHeight: (x, z) => worldSamplers.terrainHeight(x, z) + raised,
    };
    const expected = (() => {
      raised = 2;
      try {
        return bakeHomeTile({ terrainSample: changing.terrainSample, now: () => 0 });
      } finally {
        raised = 0;
      }
    })();
    let reads = 0;
    const now = (): number => {
      reads += 1;
      return reads * 2 * BUDGET;
    };
    let invalidated = false;
    const tile = bakeHomeTile({ ...changing, now }, (baking, update) => {
      const internals = baking.internals;
      if (invalidated || update < 20 || internals.backTilePhase !== "attribute") return;
      if (internals.backTileColumn === 0) return;
      invalidated = true;
      raised = 2;
      const span = GROUND_COVER_TILE_SPAN_METERS;
      expect(baking.system.invalidateArea(HOME_X - span, HOME_Z - span, HOME_X + span, HOME_Z + span))
        .toBe(true);
      expect(internals.backTileRow).toBe(0);
      expect(internals.backTileColumn).toBe(0);
      expect(internals.backTilePhase).toBe("height");
    });
    expect(invalidated, "the bake never stopped inside an attribute row").toBe(true);
    expectSameBytes("columns, rewound mid attribute row", tile, expected);
  });
});

// ---------------------------------------------------------------------------
// Progress per call, frames per tile and the cost of a frame
// ---------------------------------------------------------------------------

/** Rolling grassland, cheap to sample, so the clock is all modelled cost. */
function rollingSample(x: number, z: number): TerrainSample {
  return {
    height: rollingHeight(x, z),
    normal: { x: 0, y: 1, z: 0 },
    slope: 0.05,
    moisture: 0.55 + 0.2 * Math.sin(z / 97),
    temperature: 0.6,
    temperatureOffset: 0,
    dryness: 0,
    sandCover: 0,
    ergWeight: 0,
    biome: TerrainBiome.GRASSLAND,
    biomeName: "grassland",
    color: { r: 0.3, g: 0.5, b: 0.2 },
    airportInfluence: 0,
    isRunway: false,
  };
}

function rollingHeight(x: number, z: number): number {
  return 20 + 3 * Math.sin(x / 53) * Math.cos(z / 71);
}

const rollingSamplers: Samplers = { terrainSample: rollingSample, terrainHeight: rollingHeight };

/**
 * Today's loop as arithmetic: whole rows, each a full sample per column plus
 * the attribute row every fourth, with the clock read between rows.
 */
function todaysRowsPerCall(startRow: number, costs: SampleCosts): number {
  let row = startRow;
  let elapsed = 0;
  while (row < HEIGHT_EDGE && elapsed < BUDGET) {
    elapsed += HEIGHT_EDGE * costs.full;
    if (row % ROWS_PER_ATTRIBUTE_ROW === 0) elapsed += ATTRIBUTE_EDGE * costs.full;
    row += 1;
  }
  return row - startRow;
}

interface RollResult {
  /** Calls each completed tile took, restart to completion. */
  readonly framesPerTile: number[];
  /** What each frame that baked spent, on the work clock. */
  readonly bakeMilliseconds: number[];
  /** Whether the pace floor held each of those frames past the budget. */
  readonly paceFloorHeld: boolean[];
}

/** A take-off roll at 65 m/s and 60 Hz: the tile re-centres after every bake. */
function groundRoll(costs: SampleCosts, withHeightSampler: boolean, frames: number): RollResult {
  const clock = new WorkClock();
  const samplers = costed(rollingSamplers, clock, costs);
  const baking = new BakingSystem({
    terrainSample: samplers.terrainSample,
    ...(withHeightSampler ? { terrainHeight: samplers.terrainHeight } : {}),
    now: clock.now,
  });
  try {
    const framesPerTile: number[] = [];
    const bakeMilliseconds: number[] = [];
    const paceFloorHeld: boolean[] = [];
    let completed = 0;
    let lastCompletion = -1;
    let paceFloorCalls = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const x = 1_000 + (65 * frame) / 60;
      baking.frame(x, 500, rollingHeight(x, 500) + 3);
      const stats = baking.system.bakeStats;
      if (stats.lastMilliseconds > 0) {
        bakeMilliseconds.push(stats.lastMilliseconds);
        paceFloorHeld.push(stats.paceFloorCalls > paceFloorCalls);
      }
      paceFloorCalls = stats.paceFloorCalls;
      if (stats.tilesCompleted > completed) {
        completed = stats.tilesCompleted;
        framesPerTile.push(frame - lastCompletion);
        lastCompletion = frame;
      }
    }
    return { framesPerTile, bakeMilliseconds, paceFloorHeld };
  } finally {
    baking.dispose();
  }
}

describe("ground-cover tile bake: progress and cost", () => {
  it("keeps today's whole-row progress per call without the height sampler", () => {
    // A row of 8 ms, of 1 ms and of 0.25 ms: one, two and six rows a call.
    for (const full of [1 / 32, 1 / 256, 1 / 1024]) {
      const costs: SampleCosts = { full, height: full };
      const clock = new WorkClock();
      const baking = new BakingSystem({
        terrainSample: costed(rollingSamplers, clock, costs).terrainSample,
        now: clock.now,
      });
      try {
        let row = 0;
        let calls = 0;
        while (baking.system.bakeStats.tilesCompleted === 0) {
          baking.frame(1_000, 500, rollingHeight(1_000, 500) + 3);
          calls += 1;
          const after = baking.internals.backTileRow < 0 ? HEIGHT_EDGE : baking.internals.backTileRow;
          expect(after - row, `full sample ${full} ms, call ${calls} from row ${row}`)
            .toBe(todaysRowsPerCall(row, costs));
          row = after;
        }
        let todaysCalls = 0;
        for (let start = 0; start < HEIGHT_EDGE; start += todaysRowsPerCall(start, costs)) {
          todaysCalls += 1;
        }
        expect(calls, `full sample ${full} ms: calls per tile`).toBe(todaysCalls);
      } finally {
        baking.dispose();
      }
    }
  });

  it("takes no more frames per tile than today on a ground roll, each frame cheaper", () => {
    for (const [host, costs] of [["slow host", SLOW_HOST], ["fast host", FAST_HOST]] as const) {
      const today = groundRoll(costs, false, 1_100);
      const columns = groundRoll(costs, true, 1_100);
      // Non-vacuous: a full row overruns the budget on both hosts, so today's
      // bake takes exactly one row a call, and the roll re-centres every tile.
      expect(today.framesPerTile.length, host).toBeGreaterThanOrEqual(4);
      expect(new Set(today.framesPerTile), host).toEqual(new Set([HEIGHT_EDGE]));
      expect(columns.framesPerTile.length, host).toBeGreaterThanOrEqual(today.framesPerTile.length);
      expect(Math.max(...columns.framesPerTile), host)
        .toBeLessThanOrEqual(Math.min(...today.framesPerTile));
      expect(Math.max(...columns.bakeMilliseconds), host)
        .toBeLessThan(Math.min(...today.bakeMilliseconds));
    }
  });

  it("bounds a frame by the budget plus one step where the host keeps pace", () => {
    const step = Math.max(
      GROUND_COVER_TILE_BAKE_STEP_HEIGHT_COLUMNS * FAST_HOST.height,
      GROUND_COVER_TILE_BAKE_STEP_ATTRIBUTE_COLUMNS * FAST_HOST.full,
    );
    const roll = groundRoll(FAST_HOST, true, 600);
    expect(roll.bakeMilliseconds.length).toBeGreaterThan(500);
    for (const spent of roll.bakeMilliseconds) {
      expect(spent).toBeLessThanOrEqual(BUDGET + step);
    }
    expect(roll.paceFloorHeld).not.toContain(true);
    // And the slow host, which cannot keep pace inside the budget, spends the
    // pace's worth of work and one step more, never a whole row's overrun, and
    // the probe can tell each such frame from a budget overrun.
    const slow = groundRoll(SLOW_HOST, true, 600);
    const pace = GROUND_COVER_TILE_BAKE_PACE_COLUMNS * Math.max(SLOW_HOST.height, SLOW_HOST.full / 4);
    const slowStep = Math.max(
      GROUND_COVER_TILE_BAKE_STEP_HEIGHT_COLUMNS * SLOW_HOST.height,
      GROUND_COVER_TILE_BAKE_STEP_ATTRIBUTE_COLUMNS * SLOW_HOST.full,
    );
    let overBudgetAndStep = 0;
    slow.bakeMilliseconds.forEach((spent, frame) => {
      expect(spent).toBeLessThanOrEqual(pace + slowStep);
      if (spent > BUDGET + slowStep) {
        overBudgetAndStep += 1;
        expect(slow.paceFloorHeld[frame], `frame ${frame}: ${spent} ms`).toBe(true);
      }
    });
    expect(overBudgetAndStep).toBeGreaterThan(500);
  });

  it("reads only the height for the altitude gate when it has the sampler", () => {
    for (const withHeightSampler of [false, true]) {
      let fullSamples = 0;
      const baking = new BakingSystem({
        terrainSample: (x, z) => {
          fullSamples += 1;
          return rollingSample(x, z);
        },
        ...(withHeightSampler ? { terrainHeight: rollingHeight } : {}),
        now: () => 0,
      });
      try {
        baking.frame(1_000, 500, rollingHeight(1_000, 500) + 3);
        expect(baking.system.bakeStats.tilesCompleted).toBe(1);
        // The tile is baked and the camera parked: the gate is all that samples.
        fullSamples = 0;
        baking.frame(1_000, 500, rollingHeight(1_000, 500) + 3);
        expect(fullSamples).toBe(withHeightSampler ? 0 : 1);
        expect(baking.system.pendingTileRows).toBe(0);
      } finally {
        baking.dispose();
      }
    }
  });

  it("reports the last and worst bake and the tiles finished", () => {
    const clock = new WorkClock();
    const baking = new BakingSystem({
      terrainSample: costed(rollingSamplers, clock, SLOW_HOST).terrainSample,
      now: clock.now,
    });
    try {
      const groundY = rollingHeight(1_000, 500);
      expect(baking.system.bakeStats).toEqual({
        lastMilliseconds: 0,
        maxMilliseconds: 0,
        tilesCompleted: 0,
        paceFloorCalls: 0,
      });
      // Row 0 carries attribute row 0; row 1 is a height row alone.
      baking.frame(1_000, 500, groundY + 3);
      const rowWithAttributes = (HEIGHT_EDGE + ATTRIBUTE_EDGE) * SLOW_HOST.full;
      expect(baking.system.bakeStats.lastMilliseconds).toBe(rowWithAttributes);
      baking.frame(1_000, 500, groundY + 3);
      expect(baking.system.bakeStats.lastMilliseconds).toBe(HEIGHT_EDGE * SLOW_HOST.full);
      expect(baking.system.bakeStats.maxMilliseconds).toBe(rowWithAttributes);
      // Above the gate nothing bakes, and the last bake reads 0.
      baking.frame(1_000, 500, groundY + LAW.altitudeFadeHighMeters + 50);
      expect(baking.system.bakeStats.lastMilliseconds).toBe(0);
      while (baking.system.bakeStats.tilesCompleted === 0) baking.frame(1_000, 500, groundY + 3);
      baking.frame(1_000, 500, groundY + 3);
      expect(baking.system.bakeStats).toEqual({
        lastMilliseconds: 0,
        maxMilliseconds: rowWithAttributes,
        tilesCompleted: 1,
        paceFloorCalls: 0,
      });
    } finally {
      baking.dispose();
    }
  });
});
