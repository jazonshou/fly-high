import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGovernedWork } from "../src/render/governedWork";
import { workLeverSettingsFor } from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { TerrainClipmapSystem, type TerrainObserver } from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import type * as Quadtree from "../src/render/webgpu/terrain/TerrainQuadtree";
import type { TerrainNodeSelectionInput } from "../src/render/webgpu/terrain/TerrainQuadtree";
import type { WorldPageAddress } from "../src/render/webgpu/world/pageKey";
import { createWorld } from "../src/world";

/**
 * PR B part 2 (G5, R3): the governed CDLOD selection, through the terrain
 * system's own update.
 *
 *  - The node budget only ever drops below the profile's, clamped to the
 *    beauty buffers' capacity, so nothing reallocates; at the profile's own
 *    budget the system holds no governed value at all.
 *  - The split threshold glides 0.05 px per selection: tier 1's ×4/3 notch
 *    (3 → 4 px) arrives in exactly 20, on the target exactly.
 *  - A profile change restarts both on the new profile's values.
 *  - On the G5 study's seeded world (the selection replay's seed 7, cruising
 *    at 914 m, which is budget-bound at tier 1), the system selects to the
 *    first notch's 272 nodes, and at the profile exactly what
 *    `selectTerrainNodes` does with the inputs it took before the governor
 *    had this lever.
 *
 * The selection itself is the real one: the module is wrapped only to record
 * the inputs the system hands it and, for the fixture, to swap the world's
 * measured deviations (which need resident pages, so a GPU) for the seeded
 * ones.
 */

const recorded = vi.hoisted(() => ({
  inputs: [] as TerrainNodeSelectionInput[],
  world: null as Pick<TerrainNodeSelectionInput, "deviationFor" | "heightRangeFor"> | null,
  actual: null as typeof Quadtree.selectTerrainNodes | null,
}));

vi.mock("../src/render/webgpu/terrain/TerrainQuadtree", async (importOriginal) => {
  const actual = await importOriginal<typeof Quadtree>();
  recorded.actual = actual.selectTerrainNodes;
  return {
    ...actual,
    selectTerrainNodes: (input: TerrainNodeSelectionInput) => {
      const replaced = recorded.world ? { ...input, ...recorded.world } : input;
      recorded.inputs.push(replaced);
      return actual.selectTerrainNodes(replaced);
    },
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  recorded.inputs.length = 0;
  recorded.world = null;
});

const medium = resolveWebGpuQualityProfile("medium", "balanced");

function createSystem(quality: "low" | "medium" | "high" = "medium") {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const world = createWorld("quadtree-host", { worldEvolution: "analytic" });
  const system = new TerrainClipmapSystem(scene, world, resolveWebGpuQualityProfile(quality, "balanced"));
  cleanups.push(() => {
    system.dispose();
    scene.dispose();
    engine.dispose();
  });
  return system;
}

/** The selection replay's 3,000 ft cruise pose at 1080p (`tests/terrain-selection-replay.test.ts`). */
const CRUISE: TerrainObserver = {
  x: 1_234,
  y: 914,
  z: -777,
  velocityX: 60,
  velocityZ: 12,
  pixelsPerMeterAtUnitDistance: 935.3074360871938,
};

let frame = 0;
/** One update; the inputs the system handed the selector. */
function select(system: TerrainClipmapSystem, observer: TerrainObserver = CRUISE): TerrainNodeSelectionInput {
  frame += 1;
  system.update(observer, frame);
  return recorded.inputs.at(-1)!;
}

const governedBudget = (system: TerrainClipmapSystem) => Reflect.get(system, "governedNodeBudget") as number | null;

/** The selection replay's seeded world (`world(seed)` in `tests/terrain-selection-replay.test.ts`). */
function hash01(seed: number, level: number, x: number, z: number, salt: number): number {
  let h = (seed ^ Math.imul(level + 1, 0x9e3779b1) ^ Math.imul(x, 0x85ebca77)
    ^ Math.imul(z, 0xc2b2ae3d) ^ Math.imul(salt, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4_294_967_296;
}

function seededWorld(seed: number): Pick<TerrainNodeSelectionInput, "deviationFor" | "heightRangeFor"> {
  return {
    deviationFor: (a: WorldPageAddress): number | null =>
      hash01(seed, a.level, a.x, a.z, 1) < 0.06
        ? null
        : 2.2 * 2 ** a.level * (0.4 + hash01(seed, a.level, a.x, a.z, 2)),
    heightRangeFor: (a: WorldPageAddress): readonly [number, number] | null => {
      if (hash01(seed, a.level, a.x, a.z, 3) < 0.1) return null;
      const low = 40 + 300 * hash01(seed, a.level, a.x, a.z, 4);
      return [low, low + 20 + 2 ** a.level * 6 * hash01(seed, a.level, a.x, a.z, 5)];
    },
  };
}

describe("the governed CDLOD node budget", () => {
  it("is held only below the profile's, as a whole number of nodes", () => {
    const system = createSystem();
    expect(governedBudget(system)).toBeNull();
    system.setGovernedSelection(272.9, 3);
    expect(governedBudget(system)).toBe(272);
    expect(select(system).nodeBudget).toBe(272);
    system.setGovernedSelection(0, 3);
    expect(governedBudget(system)).toBe(1);
    // Restoring the profile's budget (or more) stores nothing.
    system.setGovernedSelection(medium.cdlodNodeBudget, 3);
    expect(governedBudget(system)).toBeNull();
    expect(select(system).nodeBudget).toBe(medium.cdlodNodeBudget);
    system.setGovernedSelection(10_000, 3);
    expect(governedBudget(system)).toBeNull();
  });

  it("never exceeds the beauty buffers' capacity, so nothing reallocates", () => {
    // Medium sizes the buffers at 320; a switch to High keeps them (a known
    // latent truncation, outside this lever), and High's first notch is 380.
    const system = createSystem("medium");
    const high = resolveWebGpuQualityProfile("high", "balanced");
    system.setProfile(high);
    const buffers = Reflect.get(system, "beautyBuffers") as { readonly capacity: number };
    expect(buffers.capacity).toBe(medium.cdlodNodeBudget);
    system.setGovernedSelection(Math.floor(high.cdlodNodeBudget * 0.85), high.cdlodPixelThreshold);
    expect(governedBudget(system)).toBe(buffers.capacity);
    expect(Reflect.get(system, "beautyBuffers")).toBe(buffers);
  });
});

describe("the governed CDLOD split threshold", () => {
  it("glides from 3 to 4 px in exactly 20 selections, and back", () => {
    const system = createSystem();
    expect(select(system).pixelThreshold).toBe(3);
    system.setGovernedSelection(medium.cdlodNodeBudget, 4);
    const rising = Array.from({ length: 21 }, () => select(system).pixelThreshold);
    expect(rising[0]).toBeCloseTo(3.05, 12);
    for (let index = 1; index < 19; index += 1) expect(rising[index]).toBeGreaterThan(rising[index - 1]!);
    expect(rising[18]).toBeLessThan(4);
    expect(rising[19]).toBe(4);
    expect(rising[20]).toBe(4);
    system.setGovernedSelection(medium.cdlodNodeBudget, 3);
    const falling = Array.from({ length: 20 }, () => select(system).pixelThreshold);
    expect(falling[18]).toBeGreaterThan(3);
    expect(falling[19]).toBe(3);
  });

  it("restarts on the new profile's values when the profile changes", () => {
    const system = createSystem();
    system.setGovernedSelection(224, 4);
    for (let index = 0; index < 5; index += 1) select(system);
    expect(governedBudget(system)).toBe(224);
    expect(Reflect.get(system, "pixelThreshold")).not.toBe(4);
    const low = resolveWebGpuQualityProfile("low", "balanced");
    system.setProfile(low);
    expect(governedBudget(system)).toBeNull();
    const inputs = select(system);
    expect(inputs.nodeBudget).toBe(low.cdlodNodeBudget);
    expect(inputs.pixelThreshold).toBe(low.cdlodPixelThreshold);
    // And back: the setter compares against the profile in force.
    system.setProfile(medium);
    expect(select(system)).toMatchObject({
      nodeBudget: medium.cdlodNodeBudget,
      pixelThreshold: medium.cdlodPixelThreshold,
    });
  });
});

describe("the governed selection on the seeded cruise (G5 study, tier 1)", () => {
  it("selects to the first notch's 272 nodes, and at the profile exactly what it did before", () => {
    recorded.world = seededWorld(7);
    const system = createSystem();
    const notch = resolveGovernedWork(medium, { ...workLeverSettingsFor(0, 0), cdlodNodeBudgetScale: 0.85 });
    expect(notch.cdlodNodeBudget).toBe(272);

    const identity = resolveGovernedWork(medium, workLeverSettingsFor(0, 0));
    system.setGovernedSelection(identity.cdlodNodeBudget, identity.cdlodPixelThreshold);
    const inputs = select(system);
    const profileRun = system.selectedNodes;
    // Budget-bound at the profile: the notch below has something to cut.
    expect(profileRun.length).toBeGreaterThan(notch.cdlodNodeBudget);
    // The inputs selection took before this lever existed, field by field.
    const today = recorded.actual!({
      ...inputs,
      pixelThreshold: medium.cdlodPixelThreshold,
      nodeBudget: medium.cdlodNodeBudget,
    });
    expect(JSON.stringify(profileRun)).toBe(JSON.stringify(today));

    system.setGovernedSelection(notch.cdlodNodeBudget, notch.cdlodPixelThreshold);
    expect(select(system).nodeBudget).toBe(272);
    // The notch binds: a split adds three nodes, so a budget-bound selection
    // ends within one split of its budget.
    expect(system.selectedNodes.length).toBeLessThanOrEqual(272);
    expect(system.selectedNodes.length).toBeGreaterThan(272 - 3);
  });
});
