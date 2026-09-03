import { describe, expect, it } from "vitest";
import {
  TERRAIN_PAGE_EROSION_GPU_PARITY_CRITERIA,
  TERRAIN_PAGE_EROSION_GPU_SEAM_CRITERIA,
  TerrainErosionCancelledError,
} from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";
import {
  generateTerrainErodedPage,
  terrainErosionSeedModeForLevel,
} from "../../src/render/webgpu/terrain/TerrainPageErosion";
import { TERRAIN_HEIGHT_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { WORLD_PAGE_HEIGHT_CORE } from "../../src/render/webgpu/world/pageGeometry";
import { invariantSlotKey } from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  admit,
  buildGpuGenerator,
  buildHarness,
  nextFrame,
  overlapIsBitExact,
  publishParentBlock,
  runPage,
  sameFloat32Bits,
  withScene,
} from "./terrainPageErosionGpuHarness";

/**
 * `W-1d` + `W-2` (Gate W): the multi-frame GPU page-erosion DAG.
 *
 * Doctrine (PHASE_6 §11 D-3, and W-1a's precedent next door): GPU-vs-GPU bit
 * determinism is the AUTHORITY — every GPU stage is a pure per-cell gather
 * with a fixed neighbour order, or an order-independent atomicMin over a
 * monotonic float encoding, so one adapter must produce identical bytes for
 * one page every time, including through a real evict-and-regenerate cycle
 * (assertion 89's GPU form) and across a page seam (assertion 90's).
 *
 * CPU-oracle agreement is TOLERANCE-tier and only for MACRO-seeded pages: the
 * GPU chain is f32 where the CPU operators accumulate in f64, and the
 * `W-2` parent-seeded pages have no CPU oracle at all by construction (their
 * seed reads resident parent pages). Those are held to determinism, seams and
 * a physical sanity envelope instead.
 */


describe("terrain page erosion GPU DAG (W-1d / W-2)", () => {
  it("erodes a macro-seeded page deterministically, twice and after eviction", async () => {
    const results = await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const address = createWorldPageAddress(3, -3, 5);
        expect(terrainErosionSeedModeForLevel(address.level)).toBe("macro");
        const first = await runPage(harness, address, 64);
        // Second run through a fresh admission: the slot was released above,
        // so this is the evict-and-regenerate cycle, not a cached result.
        const second = await runPage(harness, address, 64);
        // A third at a DIFFERENT admitted-dispatch rate: the page's bytes may
        // not depend on how the meter happened to pace its DAG.
        const third = await runPage(harness, address, 3);
        return {
          first: first.page.storedHeight,
          second: second.page.storedHeight,
          third: third.page.storedHeight,
          frames: [first.frames, second.frames, third.frames] as const,
          stats: first.page.stats,
        };
      } finally {
        harness.dispose();
      }
    });
    console.log(
      "W-1d page frames (64 dispatches/pump, 64 again, then 3):",
      JSON.stringify(results.frames),
      "stats:",
      JSON.stringify(results.stats),
    );
    expect(results.first.length).toBe(TERRAIN_HEIGHT_SLOT_EDGE * TERRAIN_HEIGHT_SLOT_EDGE);
    expect(results.first.some((value) => value !== 0)).toBe(true);
    expect(sameFloat32Bits(results.first, results.second)).toBe(true);
    expect(sameFloat32Bits(results.first, results.third)).toBe(true);
  }, 240_000);

  it("agrees across adjacent pages' stored overlap within the pinned seam bound", async () => {
    const measured = await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const origin = createWorldPageAddress(3, -3, 5);
        const east = createWorldPageAddress(3, -2, 5);
        const south = createWorldPageAddress(3, -3, 6);
        const left = await runPage(harness, origin, 64);
        const right = await runPage(harness, east, 64);
        const below = await runPage(harness, south, 64);
        // The CONTROL: the same three pages from the CPU reference. It is what
        // separates "the GPU port lost the seam" from "this fixture's composed
        // operator reach leaks past the 64-texel halo" (the live W-8 concern),
        // and the CPU is the side whose bit-exact claim is on record.
        const cpu = [origin, east, south].map((address) =>
          generateTerrainErodedPage(harness.world, harness.macro, address));
        return {
          gpu: {
            horizontal: overlapIsBitExact(left.page, right.page, "horizontal"),
            vertical: overlapIsBitExact(left.page, below.page, "vertical"),
          },
          cpu: {
            horizontal: overlapIsBitExact(cpu[0]!, cpu[1]!, "horizontal"),
            vertical: overlapIsBitExact(cpu[0]!, cpu[2]!, "vertical"),
          },
        };
      } finally {
        harness.dispose();
      }
    });
    console.log("W-1d seam overlap:", JSON.stringify(measured));
    expect(measured.gpu.horizontal.compared).toBeGreaterThan(0);
    // The CPU reference's bit-exact seam claim (assertion 90) still holds, on
    // this very fixture, which is what makes the GPU number below a property
    // of the PORT rather than of the operator reach.
    expect(measured.cpu.horizontal.exact, "the CPU oracle lost its own seam").toBe(true);
    expect(measured.cpu.vertical.exact, "the CPU oracle lost its own seam").toBe(true);
    // The GPU port does NOT reproduce bit equality here, and cannot: the WGSL
    // kernels are PAGE-RELATIVE by construction (split-origin lattice
    // coordinates, the world-scale precision rule), so two pages evaluate the
    // same world texel through different (origin, local) splits and land ulps
    // apart before a single erosion iteration has run. See
    // TERRAIN_PAGE_EROSION_GPU_SEAM_CRITERIA for the recorded bound.
    for (const axis of ["horizontal", "vertical"] as const) {
      expect(measured.gpu[axis].worstAbsolute, `${axis} seam`)
        .toBeLessThan(TERRAIN_PAGE_EROSION_GPU_SEAM_CRITERIA.worstAbsoluteToleranceMeters);
    }
  }, 240_000);

  // W-4: the PAGE COUNT is part of the criterion, like the point count is next
  // door. One page cannot separate "these two producers disagree" from "this
  // one page's trunk channel is contested"; three regimes can.
  const ORACLE_PARITY_PAGES = [
    createWorldPageAddress(3, -3, 5),
    createWorldPageAddress(3, 2, -4),
    createWorldPageAddress(3, 7, 3),
  ] as const;

  it("agrees with the CPU oracle inside the pinned tolerance for macro-seeded pages", async () => {
    // ONE engine and ONE harness for all three pages. Each `withScene` creates
    // a WebGPU device, this file is far down the suite, and a device the
    // browser declines to grant reads back a ZEROED buffer — which the
    // orderable decode turns into NaN rather than an error. Three engines here
    // was enough to push the next file over that edge.
    const measurements = await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const rows = [];
        for (const address of ORACLE_PARITY_PAGES) {
        const gpu = await runPage(harness, address, 64);
        const oracle = generateTerrainErodedPage(harness.world, harness.macro, address);
        let sum = 0;
        let worst = 0;
        const deltas: number[] = [];
        for (let index = 0; index < oracle.storedHeight.length; index += 1) {
          const delta = Math.abs(gpu.page.storedHeight[index]! - oracle.storedHeight[index]!);
          deltas.push(delta);
          sum += delta;
          worst = Math.max(worst, delta);
        }
        deltas.sort((a, b) => a - b);
        // The SHAPE of the tail is what says whether a disagreement is the
        // accepted rerouted-channel class (a handful of texels, metres apart,
        // on a landscape the two producers otherwise share) or a structural
        // divergence. Counting it here keeps that judgement measurable.
        const above = (threshold: number): number => {
          const first = deltas.findIndex((delta) => delta > threshold);
          return first < 0 ? 0 : deltas.length - first;
        };
        rows.push({
          page: `L${address.level} (${address.x}, ${address.z})`,
          count: deltas.length,
          mean: sum / deltas.length,
          p99: deltas[Math.floor(deltas.length * 0.99)]!,
          p999: deltas[Math.floor(deltas.length * 0.999)]!,
          max: worst,
          above10cm: above(0.1),
          above1m: above(1),
          oracleStats: oracle.stats,
          gpuStats: gpu.page.stats,
        });
        }
        return rows;
      } finally {
        harness.dispose();
      }
    });
    for (const measured of measurements) {
      console.log("W-1d CPU-oracle parity:", JSON.stringify(measured));
    }
    const criteria = TERRAIN_PAGE_EROSION_GPU_PARITY_CRITERIA;
    expect(measurements).toHaveLength(ORACLE_PARITY_PAGES.length);
    for (const measured of measurements) {
      expect(measured.count, measured.page)
        .toBe(TERRAIN_HEIGHT_SLOT_EDGE * TERRAIN_HEIGHT_SLOT_EDGE);
      expect(measured.mean, measured.page)
        .toBeLessThan(criteria.meanAbsoluteToleranceMeters);
      expect(measured.p99, measured.page)
        .toBeLessThan(criteria.p99AbsoluteToleranceMeters);
      expect(measured.max, measured.page)
        .toBeLessThan(criteria.maxAbsoluteToleranceMeters);
      // The tail must stay a rerouted-channel cluster, not a spread: a
      // structural divergence would put a large share of the page over 10 cm.
      expect(measured.above10cm / measured.count, measured.page)
        .toBeLessThan(criteria.reroutedTexelShare);
    }
  }, 240_000);

  it("releases the scratch and the worker's stage state when a page is cancelled", async () => {
    await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const address = createWorldPageAddress(3, -3, 5);
        const slot = admit(harness, address);
        const token = slot.token!;
        const rejected = harness.producer.beginPage(slot, token);
        const failure = rejected.catch((error: unknown) => error);
        // Walk the DAG partway in, then evict the slot underneath it: the
        // producer's per-pump staleness check must cancel rather than write
        // into a slot that now holds someone else's page.
        for (let frame = 0; frame < 12; frame += 1) {
          await harness.producer.pump(4);
          await nextFrame();
        }
        expect(harness.producer.hasActiveJob).toBe(true);
        harness.heightAtlas.residency.release(slot.key);
        await harness.producer.pump(4);
        const error = await failure;
        expect(error).toBeInstanceOf(TerrainErosionCancelledError);
        expect(harness.producer.hasActiveJob).toBe(false);
        expect(harness.producer.activeStage).toBe("idle");
        // And the producer accepts the very next page, on the same scratch.
        const next = await runPage(harness, createWorldPageAddress(3, -2, 5), 64);
        expect(next.page.storedHeight.some((value) => value !== 0)).toBe(true);
      } finally {
        harness.dispose();
      }
    });
  }, 240_000);

  it("seeds a level-0 page from its resident parents and stays deterministic", async () => {
    const measured = await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const child = createWorldPageAddress(0, -6, 10);
        expect(terrainErosionSeedModeForLevel(child.level)).toBe("parent");
        // The generator is what drives residency in production; here the test
        // publishes the four parents itself, through the real upload path.
        const parents = await publishParentBlock(harness, engine, child);
        const first = await runPage(harness, child, 64);
        const second = await runPage(harness, child, 5);
        const oracle = generateTerrainErodedPage(harness.world, harness.macro, child);
        let worst = 0;
        for (let index = 0; index < oracle.storedHeight.length; index += 1) {
          worst = Math.max(
            worst,
            Math.abs(first.page.storedHeight[index]! - oracle.storedHeight[index]!),
          );
        }
        return {
          parents,
          deterministic: sameFloat32Bits(first.page.storedHeight, second.page.storedHeight),
          stats: first.page.stats,
          worstVersusMacroSeeded: worst,
          frames: first.frames,
        };
      } finally {
        harness.dispose();
      }
    });
    console.log("W-2 parent-seeded L0 page:", JSON.stringify(measured));
    expect(measured.parents).toBe(4);
    expect(measured.deterministic).toBe(true);
    // Sanity envelope: a parent-seeded page has NO CPU oracle (its seed reads
    // resident pages), so what is asserted is that it is a plausible landscape
    // and that it genuinely differs from the macro-seeded composition.
    expect(measured.stats.minHeightMeters).toBeGreaterThan(-12_000);
    expect(measured.stats.maxHeightMeters).toBeLessThan(12_000);
    expect(measured.stats.maxHeightMeters).toBeGreaterThan(measured.stats.minHeightMeters);
    expect(measured.worstVersusMacroSeeded).toBeGreaterThan(0);
  }, 240_000);

  it("refuses to start a parent-seeded page whose seed block has not converged", async () => {
    await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const child = createWorldPageAddress(0, 40, -22);
        const slot = admit(harness, child);
        const failure = harness.producer.beginPage(slot, slot.token!)
          .catch((error: unknown) => error);
        for (let frame = 0; frame < 8; frame += 1) {
          await harness.producer.pump(4);
          await nextFrame();
        }
        const error = await failure;
        expect(error).toBeInstanceOf(TerrainErosionCancelledError);
        expect(String(error)).toMatch(/parent block/);
        harness.heightAtlas.residency.release(slot.key);
      } finally {
        harness.dispose();
      }
    });
  }, 120_000);

  it("brings a GPU-produced page to residency through the unchanged upload path", async () => {
    const observed = await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      const child = createWorldPageAddress(0, -6, 10);
      const parents = await publishParentBlock(harness, engine, child);
      const generator = buildGpuGenerator(harness, engine);
      const auxPages: number[] = [];
      const collisionPages: { readonly level: number; readonly heights: Float32Array }[] = [];
      generator.setAuxPagePublisher((page) => auxPages.push(page.level));
      generator.setCollisionPagePublisher((page) => {
        collisionPages.push({ level: page.level, heights: Float32Array.from(page.heights) });
      });
      try {
        const key = invariantSlotKey(child);
        const height = harness.heightAtlas.residency.request(key, child);
        const channel = harness.channelAtlas.residency.request(key, child);
        if (!height?.token || !channel?.token) throw new Error("the fixture atlas refused a slot");
        let frames = 0;
        while (
          harness.heightAtlas.residency.slotIndexOf(key) < 0
          && frames < 900
        ) {
          frames += 1;
          const pending = harness.heightAtlas.residency.entries.filter(
            (slot) => slot.lifecycle.state === "generating" && slot.token !== null,
          );
          await generator.generate(pending, 64);
          await nextFrame();
        }
        await generator.settle();
        for (let wait = 0; wait < 20; wait += 1) await nextFrame();
        return {
          parents,
          frames,
          resident: harness.heightAtlas.residency.slotIndexOf(key) >= 0,
          hydrologyReady: harness.channelAtlas.residency.get(key)?.hydrologyReady === true,
          stats: harness.heightAtlas.residency.get(key)?.stats ?? null,
          auxPages: [...auxPages],
          collisionLevels: collisionPages.map((page) => page.level),
          collisionSamples: collisionPages[0]?.heights.length ?? 0,
          collisionFinite: collisionPages[0]
            ? collisionPages[0].heights.every((value) => Number.isFinite(value))
            : false,
        };
      } finally {
        generator.dispose();
        harness.dispose();
      }
    });
    console.log("W-1d end-to-end residency:", JSON.stringify({
      ...observed,
      collisionSamples: observed.collisionSamples,
    }));
    expect(observed.parents).toBe(4);
    expect(observed.resident, "the GPU page never reached residency").toBe(true);
    // The hydrology gate, the aux publication and the L0 collision readback are
    // the three orderings the CPU path established and the GPU product must
    // still satisfy: residency completes only after hydrology commits, the aux
    // page publishes only once the height page is resident, and simulation
    // gets the 256² core BEFORE anything can sample the slot.
    expect(observed.hydrologyReady).toBe(true);
    expect(observed.auxPages).toContain(0);
    expect(observed.collisionLevels).toContain(0);
    expect(observed.collisionSamples).toBe(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE);
    expect(observed.collisionFinite).toBe(true);
    expect(observed.stats?.maxHeightMeters).toBeGreaterThan(observed.stats!.minHeightMeters);
  }, 240_000);
});
