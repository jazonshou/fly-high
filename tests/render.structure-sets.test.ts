import { describe, expect, it } from "vitest";
import { StructureRecordStore } from "@/src/render/structures/StructureRecordStore";
import {
  STRUCTURE_HANDOFF_BAND_METERS,
  STRUCTURE_NEAR_HYSTERESIS_METERS,
  STRUCTURE_OPEN_BUILD_METERS,
  STRUCTURE_OPEN_DRAW_METERS,
  structureBodyDistance,
  StructureSets,
  type StructureDrawRanges,
} from "@/src/render/structures/StructureSets";
import { structureToWorld, type StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * Which buildings the structure renderer puts in its far, near and open
 * meshes: the store's visible records as regions come and go and a rule
 * hides some, and the sets decided from the camera with their hysteresis.
 */

function record(id: number, x: number, z: number, overrides: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id,
    archetype: "house",
    style: "temperate",
    x,
    z,
    heading: 0.4,
    width: 10,
    depth: 8,
    storeys: 2,
    floorY: 50,
    baseY: 49.4,
    entryY: 49.6,
    foundation: "plinth",
    seed: id,
    settlement: 1,
    settlementKind: "hamlet",
    basalt: false,
    ...overrides,
  };
}

const RANGES: StructureDrawRanges = {
  structureNearRadiusMeters: 400,
  structureFarRadiusMeters: 4_000,
  structureOpenBuildings: 2,
};

describe("the structure record store", () => {
  it("keeps each region's buildings, replaces a region installed again, and drops one removed", () => {
    const store = new StructureRecordStore();
    const start = store.version;
    store.apply([{ key: "settlements:0:0", structures: [record(1, 0, 0), record(2, 30, 0)] }, { key: "roads:track:0:0" }], []);
    expect(store.version).toBeGreaterThan(start);
    expect(store.visible().map((r) => r.id)).toEqual([1, 2]);
    expect(store.regionCount).toBe(1);
    const cached = store.visible();
    expect(store.visible()).toBe(cached);

    store.apply([{ key: "settlements:0:0", structures: [record(3, 0, 0)] }], []);
    expect(store.visible().map((r) => r.id)).toEqual([3]);

    // A road region's key going is nothing to the store.
    const version = store.version;
    store.apply([], ["roads:track:0:0"]);
    expect(store.version).toBe(version);

    store.apply([], ["settlements:0:0"]);
    expect(store.visible()).toEqual([]);
    expect(store.regionCount).toBe(0);
  });

  it("hides what a rule hides, and shows it again when the rule goes", () => {
    const store = new StructureRecordStore();
    store.apply([{ key: "settlements:1:1", structures: [record(1, 0, 0), record(2, 500, 0), record(3, 900, 0)] }], []);
    store.setHidden((r) => r.x > 400);
    expect(store.visible().map((r) => r.id)).toEqual([1]);
    expect(store.hiddenCount()).toBe(2);
    store.setHidden(null);
    expect(store.visible().map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe("the structure sets", () => {
  it("put every visible building in the far set, again only when the records change", () => {
    const store = new StructureRecordStore();
    store.apply([{ key: "settlements:0:0", structures: [record(1, 0, 0), record(2, 3_000, 0)] }], []);
    const sets = new StructureSets(RANGES);
    const camera = { x: 0, y: 60, z: 0 };
    expect(sets.update(camera, store.visible(), store.version).far?.map((r) => r.id)).toEqual([1, 2]);
    expect(sets.update({ x: 900, y: 60, z: 0 }, store.visible(), store.version).far).toBeNull();
    store.apply([], ["settlements:0:0"]);
    expect(sets.update(camera, store.visible(), store.version).far).toEqual([]);
    // No blocks at all on a profile that draws none.
    sets.setRanges({ ...RANGES, structureFarRadiusMeters: 0 });
    store.apply([{ key: "settlements:0:0", structures: [record(1, 0, 0)] }], []);
    expect(sets.update(camera, store.visible(), store.version).far).toEqual([]);
  });

  it("hold every building within the near radius and its band wherever the camera is between decisions", () => {
    const records: StructureRecord[] = [];
    for (let i = 0; i < 400; i += 1) records.push(record(i, (i % 20) * 60 - 600, Math.floor(i / 20) * 60 - 600));
    const sets = new StructureSets(RANGES);
    let near: readonly StructureRecord[] = [];
    let rebuilds = 0;
    // A drive across the grid, 2 m a step.
    for (let step = 0; step <= 600; step += 1) {
      const camera = { x: -600 + step * 2, y: 52, z: 37 + step * 0.5 };
      const changes = sets.update(camera, records, 1);
      if (changes.near) {
        near = changes.near;
        rebuilds += 1;
      }
      const drawn = new Set(near.map((r) => r.id));
      for (const r of records) {
        if (Math.hypot(r.x - camera.x, r.z - camera.z) <= RANGES.structureNearRadiusMeters + STRUCTURE_HANDOFF_BAND_METERS) {
          expect(drawn.has(r.id), `building ${r.id} at step ${step}`).toBe(true);
        }
      }
    }
    // Decided again every 40 m of the 1,240 m driven, rebuilt only when that changed who is in it.
    expect(rebuilds).toBeLessThanOrEqual(Math.ceil(1_240 / STRUCTURE_NEAR_HYSTERESIS_METERS) + 1);
    expect(rebuilds).toBeGreaterThan(5);
  });

  it("does not rebuild the near set for a camera that stays put, or circles inside the hysteresis", () => {
    const records = [record(1, 0, 0), record(2, 100, 0)];
    const sets = new StructureSets(RANGES);
    expect(sets.update({ x: 0, y: 52, z: 30 }, records, 1).near?.length).toBe(2);
    for (let k = 0; k < 50; k += 1) {
      const a = (k / 50) * 2 * Math.PI;
      expect(sets.update({ x: 15 * Math.cos(a), y: 52, z: 30 + 15 * Math.sin(a) }, records, 1).near).toBeNull();
    }
  });

  it("opens the nearest enterable buildings only, built from further than they are drawn", () => {
    const records = [
      record(1, 0, 0),
      record(2, 30, 0),
      record(3, 60, 0),
      record(4, 10, 25, { archetype: "tank", width: 3, depth: 3 }),
    ];
    const sets = new StructureSets(RANGES);
    const camera = { x: 15, y: 50.5, z: 12 };
    const changes = sets.update(camera, records, 1);
    // Two at most on this profile, nearest first, and never the tank.
    expect(changes.openWanted?.map((r) => r.id)).toEqual([1, 2]);
    for (const r of changes.openWanted!) expect(structureBodyDistance(r, camera)).toBeLessThanOrEqual(STRUCTURE_OPEN_BUILD_METERS);
    expect(sets.openDrawn(() => true).map((r) => r.id)).toEqual([1, 2]);
    // Drawn open only once built.
    expect(sets.openDrawn((r) => r.id === 2).map((r) => r.id)).toEqual([2]);
    // Unchanged while the same buildings are wanted.
    expect(sets.update({ x: 16, y: 50.5, z: 12 }, records, 1).openWanted).toBeNull();
    // From an aircraft 300 m over the hamlet: none.
    expect(sets.update({ x: 15, y: 350, z: 12 }, records, 1).openWanted).toEqual([]);
    expect(sets.openDrawn(() => true)).toEqual([]);
  });

  it("measures the open distance to the body, eaves and footings included", () => {
    const building = record(1, 100, -40, { heading: 1.1 });
    // On each face, just outside: the distance is how far out.
    const out = (lx: number, ly: number, lz: number) => structureToWorld(building, lx, ly, lz, { x: 0, y: 0, z: 0 });
    expect(structureBodyDistance(building, out(0, 1, 0))).toBe(0);
    expect(structureBodyDistance(building, out(5 + 3, 1, 0))).toBeCloseTo(3, 9);
    expect(structureBodyDistance(building, out(0, 1, -4 - 7))).toBeCloseTo(7, 9);
    expect(structureBodyDistance(building, out(0, 2 * 2.9 + 4, 0))).toBeCloseTo(4, 9);
    expect(structureBodyDistance(building, out(5 + 3, 1, 4 + 4))).toBeCloseTo(5, 9);
    expect(STRUCTURE_OPEN_DRAW_METERS).toBeLessThan(STRUCTURE_OPEN_BUILD_METERS);
  });
});
