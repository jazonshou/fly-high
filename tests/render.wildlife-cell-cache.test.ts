import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  WildlifeSystem,
  type WildlifeAgent,
  type WildlifeObserver,
  type WildlifeTerrainSampler,
} from "../src/render/webgpu/wildlife";
import { TerrainBiome } from "../src/world";

/**
 * D2: the wildlife system keeps generated cells in an LRU, so the population
 * rebuild at each cell crossing generates only the cells it has not seen.
 *
 * Every generated cell here is counted and DEEP-FROZEN on its way out of
 * `generateWildlifeCell`. Modules are strict, so any write to a cell, a spawn
 * or a spawn's vector throws — which is what makes sharing cached cells,
 * rather than copying them, safe.
 */
const generated = vi.hoisted(() => ({ cells: 0 }));
vi.mock("../src/render/webgpu/wildlife/generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render/webgpu/wildlife/generation")>();
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  return {
    ...actual,
    generateWildlifeCell: (...args: Parameters<typeof actual.generateWildlifeCell>) => {
      generated.cells += 1;
      return deepFreeze(actual.generateWildlifeCell(...args));
    },
  };
});

/** A coast: water west of x = 0 (gulls), rolling forest east of it (hawks, deer, boar). */
const coast: WildlifeTerrainSampler = (x, z) => x < 0
  ? { height: -4, slope: 0, biome: TerrainBiome.WATER }
  : {
    height: 40 + Math.sin(x * 0.0021) * 12 + Math.cos(z * 0.0017) * 9,
    slope: 0.06,
    biome: TerrainBiome.FOREST,
  };

const PROFILE = resolveWebGpuQualityProfile("medium", "balanced");
const ORIGIN = { x: 0, y: 0, z: 0 };
const FRAME_SECONDS = 1 / 60;
/** 250 m/s on a diagonal out of the sea and over the forest: 5 km in 1,200 frames. */
const PATH_FRAMES = 1_200;
function pathObserver(frame: number): WildlifeObserver {
  const seconds = frame * FRAME_SECONDS;
  return { x: -1_500 + 200 * seconds, y: 420, z: 300 + 150 * seconds, velocityX: 200, velocityZ: 150 };
}

const rigs: { scene: Scene; engine: NullEngine; system: WildlifeSystem }[] = [];
afterEach(() => {
  for (const { system, scene, engine } of rigs.splice(0)) {
    system.dispose();
    scene.dispose();
    engine.dispose();
  }
});

function rig(capacity: number | undefined) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const system = new WildlifeSystem(scene, {
    worldSeed: "wildlife-cell-cache",
    terrainSample: coast,
    ...(capacity === undefined ? {} : { wildlifeCellCacheCapacity: capacity }),
  });
  rigs.push({ scene, engine, system });
  /** Runs one update; returns how many cells it generated. */
  const update = (observer: WildlifeObserver, budget = PROFILE.activeAnimalBudget): number => {
    const before = generated.cells;
    system.update(observer, ORIGIN, { ...PROFILE, activeAnimalBudget: budget }, FRAME_SECONDS);
    return generated.cells - before;
  };
  const agents = () => (system as unknown as { agents: WildlifeAgent[] }).agents;
  return { system, update, agents };
}

describe("the wildlife cell cache (D2)", () => {
  it("is off by default and refuses a capacity that is not a whole number of cells", () => {
    const off = rig(undefined);
    const observer = pathObserver(0);
    const first = off.update(observer);
    expect(first).toBeGreaterThan(20);
    // A rebuild of the same window (a budget change) regenerates every cell.
    expect(off.update(observer, PROFILE.activeAnimalBudget - 1)).toBe(first);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    for (const capacity of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new WildlifeSystem(scene, {
        worldSeed: "wildlife-cell-cache",
        terrainSample: coast,
        wildlifeCellCacheCapacity: capacity,
      }), String(capacity)).toThrow(RangeError);
    }
    scene.dispose();
    engine.dispose();
  });

  it("flies a 5 km path to the same agents every frame for at most 30% of the generation", () => {
    const uncached = rig(0);
    const cached = rig(64);
    let uncachedCells = 0;
    let cachedCells = 0;
    for (let frame = 0; frame < PATH_FRAMES; frame += 1) {
      uncachedCells += uncached.update(pathObserver(frame));
      cachedCells += cached.update(pathObserver(frame));
      // Every agent, every field: ids, kinds, positions, velocities, phases.
      expect(JSON.stringify(cached.agents()), `frame ${frame}`)
        .toBe(JSON.stringify(uncached.agents()));
    }
    expect(cached.system.statistics).toEqual(uncached.system.statistics);
    // Not a test of nothing: the path crosses cells, and animals live there.
    expect(uncached.system.statistics.populationRebuilds).toBeGreaterThan(8);
    expect(uncached.agents().length).toBeGreaterThan(20);
    expect(uncached.agents().some((agent) => agent.kind === "ground")).toBe(true);
    // The cache saves 70% of the generation at least.
    expect(cachedCells).toBeLessThanOrEqual(uncachedCells * 0.3);
  });

  it("generates a forgotten cell again after invalidateCellCache", () => {
    const uncached = rig(0);
    const cached = rig(64);
    const observer = pathObserver(0);
    const window = uncached.update(observer);
    expect(cached.update(observer)).toBe(window);
    // Same window, rebuilt: every cell comes from the cache...
    expect(uncached.update(observer, PROFILE.activeAnimalBudget - 1)).toBe(window);
    expect(cached.update(observer, PROFILE.activeAnimalBudget - 1)).toBe(0);
    // ...until the terrain is said to have changed.
    cached.system.invalidateCellCache();
    expect(uncached.update(observer, PROFILE.activeAnimalBudget - 2)).toBe(window);
    expect(cached.update(observer, PROFILE.activeAnimalBudget - 2)).toBe(window);
    expect(JSON.stringify(cached.agents())).toBe(JSON.stringify(uncached.agents()));
  });

  it("keeps at most its capacity, dropping the least recently used cells first", () => {
    const here = pathObserver(0);
    const away = { ...here, x: here.x + 40_000 };
    const window = rig(0).update(here);
    const small = rig(window);
    const large = rig(window * 2);
    for (const { update } of [small, large]) {
      expect(update(here)).toBe(window);
      expect(update(away)).toBe(window);
    }
    // The small cache gave `here` up to make room for `away`; the large one did not.
    expect(small.update(here)).toBe(window);
    expect(large.update(here)).toBe(0);
    // Coming back made `here` the most recent, so `away` went to make room for it.
    expect(small.update(away)).toBe(window);
  });
});
