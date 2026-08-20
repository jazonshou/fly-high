import { describe, expect, it } from "vitest";
import {
  TerrainAtlasResidency,
  invariantSlotKey,
  seasonSlotKeys,
} from "../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  TERRAIN_DEBUG_OVERLAY_MODES,
  terrainDebugOverlayColor,
} from "../src/render/webgpu/terrain/TerrainDebugOverlay";
import {
  NullTerrainCollisionMirror,
  PublishingTerrainCollisionMirror,
} from "../src/render/webgpu/terrain/TerrainCollisionMirror";
import {
  SEASON_BUCKETS,
  terrainSlotKeyString,
} from "../src/render/webgpu/terrain/TerrainSpineContract";
import {
  WORLD_PAGE_ALLOWED_TRANSITIONS,
  WORLD_PAGE_LIFECYCLE_STATES,
  WorldPageLifecycle,
} from "../src/render/webgpu/world/lifecycle";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_HEIGHT_CORE,
} from "../src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  createWorldPageKey,
} from "../src/render/webgpu/world/pageKey";

function residency(slots: number): TerrainAtlasResidency {
  return new TerrainAtlasResidency(slots, {
    worldRevision: "test-world",
    slotByteLength: 264 * 264 * 4,
  });
}

const address = (level: number, x: number, z: number) => createWorldPageAddress(level, x, z);

/**
 * `4-2`'s gate. The atlas is the first consumer of `WorldPageLifecycle`'s
 * ASYNCHRONOUS half, which `ARCHITECTURE.md`'s `0-3` entry records as untested
 * until now — and three of its transitions had never executed at all.
 */
describe("terrain page atlas residency (4-2)", () => {
  it("adds a GPU-generation branch without widening the CPU upload path", () => {
    expect(WORLD_PAGE_LIFECYCLE_STATES).toContain("generating");
    expect(WORLD_PAGE_ALLOWED_TRANSITIONS.queued).toContain("generating");
    expect(WORLD_PAGE_ALLOWED_TRANSITIONS.generating)
      .toEqual(["resident", "unloaded", "failed"]);
    // beginUpload still asserts cpu-ready: the CPU tile path relies on that
    // check until 4-4 retires the terrain worker.
    const lifecycle = new WorldPageLifecycle(
      createWorldPageKey(address(0, 0, 0)),
      () => 1,
    );
    lifecycle.queue();
    expect(() => lifecycle.beginUpload()).toThrow(/expected cpu-ready/);
  });

  it("runs a page from queued through generating to resident", () => {
    const clock = { frame: 1 };
    const lifecycle = new WorldPageLifecycle(
      createWorldPageKey(address(0, 3, -2)),
      () => clock.frame,
    );
    const token = lifecycle.queue();
    expect(lifecycle.beginGeneration(token)).toBe(true);
    expect(lifecycle.state).toBe("generating");
    expect(lifecycle.markGenerated(token)).toBe(true);
    expect(lifecycle.state).toBe("resident");
    // A stale completion is rejected harmlessly rather than throwing.
    expect(lifecycle.markGenerated({ key: lifecycle.key, epoch: 0 })).toBe(false);
  });

  it("exercises the three transitions that had never executed", () => {
    const key = createWorldPageKey(address(0, 1, 1));
    // 1. cancelEviction(): zero call sites before this item.
    const retained = new WorldPageLifecycle(key, () => 1);
    const load = retained.queue();
    retained.beginLoading(load);
    retained.markCpuReady(load);
    retained.markResident(retained.beginUpload());
    const eviction = retained.beginEviction();
    expect(retained.cancelEviction(eviction)).toBe(true);
    expect(retained.state).toBe("resident");

    // 2. cancelOperation(token, true): the retention path, never called with
    //    true. An abandoned upload keeps its CPU payload for resubmission.
    const retainedUpload = new WorldPageLifecycle(key, () => 1);
    const second = retainedUpload.queue();
    retainedUpload.beginLoading(second);
    retainedUpload.markCpuReady(second);
    const upload = retainedUpload.beginUpload();
    expect(retainedUpload.cancelOperation(upload, true)).toBe(true);
    expect(retainedUpload.state).toBe("cpu-ready");

    // 3. A completion rejected after a competing queue() bumped the epoch.
    const raced = new WorldPageLifecycle(key, () => 1);
    const stale = raced.queue();
    raced.beginGeneration(stale);
    raced.cancelOperation(stale);
    const fresh = raced.queue();
    raced.beginGeneration(fresh);
    expect(raced.markGenerated(stale)).toBe(false);
    expect(raced.state).toBe("generating");
    expect(raced.markGenerated(fresh)).toBe(true);
  });

  it("hands out every slot before evicting anything", () => {
    const atlas = residency(4);
    atlas.beginFrame(1);
    for (let index = 0; index < 4; index += 1) {
      const request = atlas.request(invariantSlotKey(address(0, index, 0)), address(0, index, 0));
      expect(request).not.toBeNull();
      atlas.complete(request!.slot.key, request!.token!, {
        minHeightMeters: 0, maxHeightMeters: 1, maxDeviationFromParent: 0.5,
      });
    }
    expect(atlas.residentCount).toBe(4);
    expect(atlas.freeCount).toBe(0);
    // Surplus slots ARE the cache: a re-request of a resident page is a hit
    // with no dispatch.
    const hit = atlas.request(invariantSlotKey(address(0, 2, 0)), address(0, 2, 0));
    expect(hit?.token).toBeNull();
    expect(hit?.slot.slotIndex).toBe(2);
  });

  it("evicts in compareWorldPageCacheEvictionOrder and never a required page", () => {
    const atlas = residency(3);
    atlas.beginFrame(1);
    for (let index = 0; index < 3; index += 1) {
      const request = atlas.request(invariantSlotKey(address(0, index, 0)), address(0, index, 0))!;
      atlas.complete(request.slot.key, request.token!, {
        minHeightMeters: 0, maxHeightMeters: 1, maxDeviationFromParent: 0,
      });
    }
    // Frame 2: two of the three are still wanted; page 0 is not.
    atlas.beginFrame(2);
    atlas.touch(invariantSlotKey(address(0, 1, 0)));
    atlas.touch(invariantSlotKey(address(0, 2, 0)));
    expect(atlas.evictionCandidates().map((slot) => slot.address.x)).toEqual([0]);

    const admitted = atlas.request(invariantSlotKey(address(0, 9, 9)), address(0, 9, 9));
    expect(admitted).not.toBeNull();
    // The stale page lost its slot; the two required pages kept theirs.
    expect(atlas.slotIndexOf(invariantSlotKey(address(0, 0, 0)))).toBe(-1);
    expect(atlas.slotIndexOf(invariantSlotKey(address(0, 1, 0)))).toBe(1);
    expect(atlas.slotIndexOf(invariantSlotKey(address(0, 2, 0)))).toBe(2);

    // With nothing evictable the atlas DEFERS rather than thrashing.
    atlas.touch(invariantSlotKey(address(0, 9, 9)));
    expect(atlas.request(invariantSlotKey(address(0, 7, 7)), address(0, 7, 7))).toBeNull();
  });

  it("never evicts a slot with a dispatch in flight", () => {
    const atlas = residency(1);
    atlas.beginFrame(1);
    const first = atlas.request(invariantSlotKey(address(0, 0, 0)), address(0, 0, 0))!;
    expect(first.token).not.toBeNull();
    atlas.beginFrame(2);
    // The generating page is not a candidate: its slot is being written.
    expect(atlas.evictionCandidates()).toHaveLength(0);
    expect(atlas.request(invariantSlotKey(address(0, 5, 5)), address(0, 5, 5))).toBeNull();
  });

  it("frees the slot when a generation fails", () => {
    const atlas = residency(2);
    atlas.beginFrame(1);
    const request = atlas.request(invariantSlotKey(address(0, 0, 0)), address(0, 0, 0))!;
    expect(atlas.fail(request.slot.key, request.token!, "device lost")).toBe(true);
    expect(atlas.freeCount).toBe(2);
    expect(atlas.slotIndexOf(request.slot.key)).toBe(-1);
  });

  it("keys season-dependent slots by bucket and nothing else by anything", () => {
    const page = createWorldPageKey(address(0, 4, 4));
    const summer = seasonSlotKeys(page, 171);
    expect(summer.lo).not.toBe(summer.hi);
    expect(summer.hi.variant).toBe((summer.lo.variant + 1) % SEASON_BUCKETS);
    expect(terrainSlotKeyString(summer.lo)).toBe(`${page}#${summer.lo.variant}`);
    // Height, occlusion and horizon are geometry-only: variant 0, always.
    expect(invariantSlotKey(address(0, 4, 4)).variant).toBe(0);
    // The two buckets are different SLOTS of the same page, which is why the
    // page key does not change and the atlas is sized for two.
    expect(summer.lo.page).toBe(summer.hi.page);
  });
});

/**
 * Assertion 86's plumbing, a phase early. Before `4-2` both halves of this
 * contract were inert declarations, so "must stay 0 below 500 m AGL" could not
 * be checked at all.
 */
describe("terrain collision mirror (4-2)", () => {
  it("keeps the null mirror inert and counting nothing", () => {
    const mirror = new NullTerrainCollisionMirror();
    mirror.publishPage();
    expect(mirror.sampleHeight()).toBeNull();
    expect(mirror.fallbackSampleCount).toBe(0);
    expect(mirror.publishedPageCount).toBe(0);
  });

  it("serves published pages and counts every miss", () => {
    const mirror = new PublishingTerrainCollisionMirror(WORLD_PAGE_BASE_EXTENT_METERS);
    const core = WORLD_PAGE_HEIGHT_CORE;
    const heights = new Float32Array(core * core);
    for (let row = 0; row < core; row += 1) {
      for (let column = 0; column < core; column += 1) {
        // A plane, so bilinear reconstruction is exact and the assertion is
        // about the plumbing rather than the interpolation kernel.
        heights[row * core + column] = 10 + column * 0.5 + row * 0.25;
      }
    }
    mirror.publishPage(0, 0, 0, heights);
    expect(mirror.publishedPageCount).toBe(1);
    expect(mirror.fallbackSampleCount).toBe(0);

    const spacing = WORLD_PAGE_BASE_EXTENT_METERS / core;
    expect(mirror.sampleHeight(0, 0)).toBeCloseTo(10, 6);
    expect(mirror.sampleHeight(spacing * 4, spacing * 8)).toBeCloseTo(10 + 2 + 2, 6);
    expect(mirror.sampleHeight(spacing * 3.5, 0)).toBeCloseTo(10 + 1.75, 6);
    expect(mirror.fallbackSampleCount).toBe(0);

    // Outside the published ring: a fallback, and it is counted.
    expect(mirror.sampleHeight(-WORLD_PAGE_BASE_EXTENT_METERS, 0)).toBeNull();
    expect(mirror.fallbackSampleCount).toBe(1);
    mirror.resetCounters();
    expect(mirror.fallbackSampleCount).toBe(0);

    // Coarse pages are refused outright: a second, lower-authority answer to
    // the same question is exactly what §1.3 exists to prevent.
    mirror.publishPage(1, 0, 0, heights);
    expect(mirror.publishedPageCount).toBe(1);
    expect(() => mirror.publishPage(0, 1, 0, new Float32Array(4))).toThrow(RangeError);
  });

  it("bounds the published ring", () => {
    const mirror = new PublishingTerrainCollisionMirror(WORLD_PAGE_BASE_EXTENT_METERS);
    const heights = new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE);
    for (let index = 0; index < 60; index += 1) mirror.publishPage(0, index, 0, heights);
    expect(mirror.publishedPageCount).toBeLessThanOrEqual(36);
    // The most recent publications survive; the oldest are dropped.
    expect(mirror.sampleHeight(59 * WORLD_PAGE_BASE_EXTENT_METERS + 1, 1)).not.toBeNull();
  });
});

describe("terrain debug overlay (4-3)", () => {
  it("false-colours residency, level and height, and draws nothing when off", () => {
    const resident = {
      state: "resident", level: 0, minHeightMeters: 0, maxHeightMeters: 40,
    } as const;
    expect(terrainDebugOverlayColor("off", resident)[3]).toBe(0);
    // An empty slot is still drawn — "nothing is resident here" is the signal
    // Gate 4A most needs, and a transparent slot would look like a working one.
    expect(terrainDebugOverlayColor("residency", null)[3]).toBeGreaterThan(0);
    const generating = terrainDebugOverlayColor(
      "residency",
      { ...resident, state: "generating" },
    );
    expect(generating).not.toEqual(terrainDebugOverlayColor("residency", resident));

    // Level colours cycle, so a ring structure reads without a legend.
    expect(terrainDebugOverlayColor("level", resident))
      .toEqual(terrainDebugOverlayColor("level", { ...resident, level: 6 }));
    expect(terrainDebugOverlayColor("level", resident))
      .not.toEqual(terrainDebugOverlayColor("level", { ...resident, level: 1 }));

    // Height maps relief span, and saturates rather than wrapping.
    const flat = terrainDebugOverlayColor("height", resident);
    const alpine = terrainDebugOverlayColor(
      "height",
      { ...resident, maxHeightMeters: 900 },
    );
    expect(alpine[0]).toBeGreaterThan(flat[0]!);
    expect(terrainDebugOverlayColor("height", { ...resident, maxHeightMeters: 5_000 }))
      .toEqual(alpine);
    for (const channel of alpine) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  it("cycles through every mode and back to off", () => {
    expect(TERRAIN_DEBUG_OVERLAY_MODES[0]).toBe("off");
    expect(new Set(TERRAIN_DEBUG_OVERLAY_MODES).size)
      .toBe(TERRAIN_DEBUG_OVERLAY_MODES.length);
  });
});
