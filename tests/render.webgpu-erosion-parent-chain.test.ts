import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  COMPUTE_DISPATCH_SEED_COST_MS,
  ComputeBudget,
} from "../src/render/webgpu/core/ComputeBudget";
import { DYNAMIC_ALLOCATIONS } from "../src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  TerrainClipmapSystem,
  type TerrainComputeFactory,
} from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import {
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  EROSION_HALO_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
} from "../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  invariantSlotKey,
  type TerrainAtlasSlot,
  type TerrainPageAtlas,
} from "../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL,
  terrainErosionAdmissionDependencies,
  terrainErosionParentSeedBlock,
  terrainErosionSeedModeForLevel,
} from "../src/render/webgpu/terrain/TerrainPageErosion";
import {
  TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
  TERRAIN_EROSION_SEED_BAND_ROWS,
  TERRAIN_EROSION_STAGE_SEED_COST_MS,
} from "../src/render/webgpu/terrain/TerrainPageErosionGpu";
import { WORLD_PAGE_CHANNEL_CORE, WORLD_PAGE_HEIGHT_CORE } from "../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress, type WorldPageAddress } from "../src/render/webgpu/world/pageKey";
import { FRAME_BUDGET_MS } from "../src/render/webgpu/core/PerformanceBudget";
import { createWorld } from "../src/world";

/**
 * `W-2` (Gate W): the resident-parent seeding chain and its admission gate.
 *
 * The register's C-2 gap was that "pages seed height and accumulation directly
 * from the canonical macro plus band-limited fine detail; no parent-arrival
 * dependency". Closing it makes a page's inputs depend on OTHER pages, which
 * is a streaming property before it is a terrain property — hence a residency
 * fixture rather than a GPU test. What the GPU suite proves is that the seed
 * pass reads what these rules say it reads; what this file proves is that the
 * rules cannot deadlock the ladder and that the chain terminates.
 */

const OBSERVER = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };

function macroFixture(seed: string, seaLevelMeters: number): TerrainMacroEvolutionExport {
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: seed, deviceFingerprint: "parent-chain-fixture" },
    seaLevelMeters,
    heightMeters: new Float32Array(0),
    flowAccumulationAreaM2: new Float32Array(0),
    lakeMask: new Uint8Array(0),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(0),
  };
}

/**
 * A producer that completes pages the way the real one does: the height slot
 * goes resident, and the paired channel slot's hydrology is committed — which
 * is exactly the condition `W-2`'s gate reads. `erosionDagDemand` is present
 * so the clipmap takes the multi-frame branch.
 */
function chainComputeFactory(options: {
  readonly refuse?: (address: WorldPageAddress) => boolean;
  readonly erosionCostMs?: number;
} = {}): {
  readonly factory: TerrainComputeFactory;
  readonly generated: WorldPageAddress[];
  readonly admittedCounts: number[];
  readonly demands: { count: number; costMs: number }[];
  observedErosionCostMs: number | null;
} {
  const generated: WorldPageAddress[] = [];
  const admittedCounts: number[] = [];
  const demands: { count: number; costMs: number }[] = [];
  const state = { observedErosionCostMs: null as number | null, pending: 0 };
  const factory: TerrainComputeFactory = ({ heightAtlas, channelAtlas, existingPyramid }) => ({
    pageGenerator: {
      erosionDagDemand: (pendingPageCount: number) => {
        const demand = {
          count: pendingPageCount > 0 || state.pending > 0 ? 4 : 0,
          costMs: options.erosionCostMs ?? TERRAIN_EROSION_STAGE_SEED_COST_MS.seed,
        };
        demands.push(demand);
        return demand;
      },
      hasActiveErosionDag: () => state.pending > 0,
      consumeMeasuredErosionDispatchCostMs: () => {
        state.observedErosionCostMs = 0.11;
        return 0.11;
      },
      generate: async (slots: readonly TerrainAtlasSlot[], admittedDispatches?: number) => {
        admittedCounts.push(admittedDispatches ?? -1);
        // One page at a time, like the real producer.
        const slot = slots.find((candidate) =>
          candidate.token !== null && !candidate.generationSubmitted);
        if (!slot?.token) return;
        if (options.refuse?.(slot.address)) return;
        slot.generationSubmitted = true;
        generated.push(slot.address);
        await Promise.resolve();
        completePage(heightAtlas, channelAtlas, slot);
      },
      ensureHydrology: async () => undefined,
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    occlusionBake: {
      bake: async (slots) => slots,
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    splatBake: {
      bake: async (slots) => slots.length,
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    pyramid: existingPyramid ?? {
      recenter: async () => undefined,
      isResident: true,
      dispose: () => undefined,
    },
  });
  return {
    factory,
    generated,
    admittedCounts,
    demands,
    get observedErosionCostMs() { return state.observedErosionCostMs; },
  };
}

function completePage(
  heightAtlas: TerrainPageAtlas,
  channelAtlas: TerrainPageAtlas,
  slot: TerrainAtlasSlot,
): void {
  const channelSlot = channelAtlas.residency.get(slot.key);
  if (channelSlot?.token) {
    channelAtlas.residency.markHydrologyReady(channelSlot.key, channelSlot.token);
  }
  if (slot.token) {
    heightAtlas.residency.complete(slot.key, slot.token, {
      minHeightMeters: 0,
      maxHeightMeters: 400,
      maxDeviationFromParent: 6,
    });
  }
}

async function pump(
  system: TerrainClipmapSystem,
  count: number,
  startFrame = 1,
): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    system.update(OBSERVER, startFrame + frame);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function createSystem(options: Parameters<typeof chainComputeFactory>[0] = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const world = createWorld("w2-parent-chain", { airport: false, worldEvolution: "eroded" });
  const recording = chainComputeFactory(options);
  const system = new TerrainClipmapSystem(
    scene,
    world,
    resolveWebGpuQualityProfile("medium", "balanced"),
    { computeFactory: recording.factory },
  );
  system.setMacroEvolution(macroFixture(world.seed, world.seaLevel));
  return {
    engine,
    scene,
    system,
    recording,
    dispose: () => {
      system.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

describe("W-2 parent-converged seeding rules", () => {
  it("terminates the chain on a macro-seeded level", () => {
    expect(terrainErosionSeedModeForLevel(TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL))
      .toBe("parent");
    expect(terrainErosionSeedModeForLevel(TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL + 1))
      .toBe("macro");
    // Every dependency names a STRICTLY coarser level, and the transitive
    // closure is finite: that pair is the whole deadlock-freedom argument.
    let frontier = [createWorldPageAddress(0, 3, -7)];
    let depth = 0;
    while (frontier.length > 0) {
      const next = frontier.flatMap((address) => {
        const dependencies = terrainErosionAdmissionDependencies(address);
        for (const parent of dependencies) expect(parent.level).toBe(address.level + 1);
        return [...dependencies];
      });
      frontier = next;
      depth += 1;
      expect(depth, "the parent seeding chain did not terminate").toBeLessThan
        (32);
    }
    expect(depth).toBe(TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL + 2);
  });

  it("covers every parent texel a child's 384-texel scratch can bilinearly tap", () => {
    // The seed pass resolves each tap to the parent page whose CORE owns that
    // world texel — never to a gutter copy — so the 2x2 block has to cover the
    // whole support on both axes, in both parities of the child index.
    for (const child of [
      createWorldPageAddress(0, 0, 0),
      createWorldPageAddress(0, 7, -4),
      createWorldPageAddress(0, -9, 11),
      createWorldPageAddress(0, -1, -1),
    ]) {
      const block = terrainErosionParentSeedBlock(child);
      expect(block).toHaveLength(4);
      for (const parent of block) expect(parent.level).toBe(child.level + 1);
      const pagesX = new Set(block.map((parent) => parent.x));
      const pagesZ = new Set(block.map((parent) => parent.z));
      const scratch = EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS;
      for (const [childBase, core, pages] of [
        [child.x, WORLD_PAGE_HEIGHT_CORE, pagesX],
        [child.z, WORLD_PAGE_HEIGHT_CORE, pagesZ],
      ] as const) {
        // Child scratch texel range, in PARENT height texels (2 child texels).
        const first = (childBase * core - EROSION_HALO_TEXELS) / 2;
        const last = (childBase * core - EROSION_HALO_TEXELS + scratch - 1) / 2;
        // Bilinear reaches one texel past the last tap's floor.
        for (const texel of [Math.floor(first), Math.floor(last) + 1]) {
          expect(pages.has(Math.floor(texel / core))).toBe(true);
        }
      }
      // And the channel-resolution flow taps, at half the height resolution.
      for (const [childBase, pages] of [[child.x, pagesX], [child.z, pagesZ]] as const) {
        const first = (childBase * WORLD_PAGE_HEIGHT_CORE - EROSION_HALO_TEXELS) / 4;
        const last = first + scratch / 4;
        for (const texel of [Math.floor(first) - 1, Math.floor(last) + 1]) {
          expect(pages.has(Math.floor(texel / WORLD_PAGE_CHANNEL_CORE))).toBe(true);
        }
      }
    }
  });

  it("keeps every DAG stage inside the tier-1 erosionCompute row", () => {
    // A stage priced above a tier's row cannot be admitted by the reservation
    // pass at all: it needs the surplus, or the floor of one, and the floor is
    // an over-cap burst by construction (assertion 105). Tier 1 is the
    // shipping tier and the row every stage must fit.
    //
    // Two stages are ABOVE tier 0's 0.2 ms row on the reference adapter — the
    // seed band at 0.29 and the talus pair at 0.32 — and neither can be split
    // further inside this item: a seed band is already ONE workgroup row, and
    // the talus gather/apply pair is W-1a's shader. In eroded mode
    // terrainCompute has no demand at all, so its whole row is surplus every
    // frame and tier 0 still admits them; recorded rather than hidden.
    const tier1Row = FRAME_BUDGET_MS[1].erosionCompute;
    for (const [stage, costMs] of Object.entries(TERRAIN_EROSION_STAGE_SEED_COST_MS)) {
      expect(costMs, `${stage} is priced above the tier-1 erosionCompute row`)
        .toBeLessThanOrEqual(tier1Row);
    }
    expect(EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS % TERRAIN_EROSION_SEED_BAND_ROWS).toBe(0);
    expect(EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS % TERRAIN_EROSION_GEOLOGY_BAND_ROWS).toBe(0);
    // The client-level seed is the average dispatch of a whole page's mix, so
    // it has to sit inside the per-stage extremes rather than beyond them.
    const stageCosts = Object.values(TERRAIN_EROSION_STAGE_SEED_COST_MS);
    expect(COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute)
      .toBeGreaterThanOrEqual(Math.min(...stageCosts));
    expect(COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute)
      .toBeLessThanOrEqual(Math.max(...stageCosts));
  });

  it("inventories exactly the scratch the producer allocates", () => {
    // Six 384² r32 fields, one page in flight. The count is load-bearing:
    // tier 0's ceiling has under a megabyte of headroom at its largest
    // viewport, so a seventh field would break assertion 19 outright.
    expect(DYNAMIC_ALLOCATIONS.erosionScratchEdge)
      .toBe(EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS);
    expect(DYNAMIC_ALLOCATIONS.erosionScratchFieldCount).toBe(6);
    expect(DYNAMIC_ALLOCATIONS.erosionScratchBytesPerTexel).toBe(4);
  });
});

describe("W-2 admission gate (residency fixture)", () => {
  it("streams the parent seed block and never admits a child before it", async () => {
    const fixture = createSystem();
    try {
      const height = fixture.system.atlases.height.residency;
      const channel = fixture.system.atlases.channel.residency;
      const admissionOrder: WorldPageAddress[] = [];
      const seen = new Set<string>();
      for (let frame = 0; frame < 220; frame += 1) {
        await pump(fixture.system, 1, frame + 1);
        for (const slot of height.entries) {
          const key = `${slot.address.level}:${slot.address.x}:${slot.address.z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          admissionOrder.push(slot.address);
          // THE GATE: at the instant this page was admitted, every member of
          // its seed block must already have been converged.
          for (const parent of terrainErosionAdmissionDependencies(slot.address)) {
            const parentSlot = height.get(invariantSlotKey(parent));
            expect(
              parentSlot?.lifecycle.state,
              `L${slot.address.level} page admitted before its L${parent.level} parent`,
            ).toBe("resident");
            expect(channel.get(parentSlot!.key)?.hydrologyReady).toBe(true);
          }
        }
      }
      const levels = new Set(admissionOrder.map((address) => address.level));
      expect(admissionOrder.length).toBeGreaterThan(0);
      // No deadlock: the macro-seeded levels stream, and the gated level
      // eventually follows them rather than starving forever.
      expect([...levels].some((level) => level > TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL))
        .toBe(true);
      const gated = admissionOrder.filter((address) =>
        terrainErosionSeedModeForLevel(address.level) === "parent");
      expect(gated.length, "no parent-seeded page was ever admitted").toBeGreaterThan(0);
      expect(height.residentCount).toBeGreaterThan(0);
    } finally {
      fixture.dispose();
    }
  });

  it("keeps the ladder moving when a gated page can never be satisfied", async () => {
    // The pathological shape: the producer refuses every level-1 page, so no
    // level-0 page can ever be admitted. The gate must `continue` past the
    // blocked child rather than `return`, or one unsatisfiable candidate stops
    // every coarser page behind it and streaming dies outright.
    const fixture = createSystem({
      refuse: (address) => address.level === TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL + 1,
    });
    try {
      await pump(fixture.system, 40);
      const height = fixture.system.atlases.height.residency;
      expect(height.residentCount, "the ladder stalled behind a blocked child")
        .toBeGreaterThan(0);
      const residentLevels = new Set(
        height.entries
          .filter((slot) => slot.lifecycle.state === "resident")
          .map((slot) => slot.address.level),
      );
      expect([...residentLevels].every((level) =>
        level > TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL)).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("books the DAG's dispatch demand and feeds its measured cost back", async () => {
    const fixture = createSystem({ erosionCostMs: 0.12 });
    try {
      await pump(fixture.system, 8);
      // Demand is declared in DISPATCHES at the stage price, and the admitted
      // count is handed to the producer rather than used to slice pages.
      expect(fixture.recording.demands.length).toBeGreaterThan(0);
      expect(fixture.recording.demands.some((demand) => demand.count > 1)).toBe(true);
      expect(fixture.recording.admittedCounts.some((count) => count > 0)).toBe(true);
      // erosionCompute shipped with no cost observation at all; this is it.
      expect(fixture.recording.observedErosionCostMs).toBe(0.11);
      // The meter smooths the observation into its running estimate, which is
      // what production admits against once the pinned seed is left behind.
      const budget = new ComputeBudget(resolveWebGpuQualityProfile("medium", "balanced"));
      expect(budget.estimatedCostMs("erosionCompute"))
        .toBeCloseTo(COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute, 9);
      budget.observeDispatchCostMs("erosionCompute", 0.11);
      expect(budget.estimatedCostMs("erosionCompute"))
        .not.toBeCloseTo(COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute, 9);
    } finally {
      fixture.dispose();
    }
  });
});
