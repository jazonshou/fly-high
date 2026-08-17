import { describe, expect, it } from "vitest";
import {
  coreToStoredIndex,
  pageTexelSizeMeters,
  storedEdge,
  storedIndexToCore,
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
  WORLD_PAGE_LAYOUT,
} from "../src/render/webgpu/world/pageGeometry";
import {
  getWorldPageStoredDimensions,
} from "../src/render/webgpu/world/payload";
import { worldPageExtentMeters } from "../src/render/webgpu/world/pageKey";

describe("world page geometry (0-2)", () => {
  it("pins the resolved page geometry to its exact values", () => {
    // These four numbers are the §1.4 "page geometry — one number" decision.
    // A drift to 132², 260², or 66² anywhere must fail here, by name.
    expect(WORLD_PAGE_BASE_EXTENT_METERS).toBe(512);
    expect(WORLD_PAGE_GUTTER).toBe(4);
    expect(WORLD_PAGE_HEIGHT_CORE).toBe(256);
    expect(WORLD_PAGE_CHANNEL_CORE).toBe(128);
    expect(storedEdge(WORLD_PAGE_HEIGHT_CORE)).toBe(264);
    expect(storedEdge(WORLD_PAGE_CHANNEL_CORE)).toBe(136);
  });

  it("ships exactly one canonical layout and it is frozen", () => {
    expect(WORLD_PAGE_LAYOUT).toEqual({
      extentMeters: 512,
      heightResolution: 256,
      surfaceResolution: 128,
      gutter: 4,
    });
    expect(Object.isFrozen(WORLD_PAGE_LAYOUT)).toBe(true);
  });

  it("agrees with payload.ts stored dimensions", () => {
    const stored = getWorldPageStoredDimensions(WORLD_PAGE_LAYOUT);
    expect(stored.heightEdge).toBe(storedEdge(WORLD_PAGE_HEIGHT_CORE));
    expect(stored.heightSampleCount).toBe(264 * 264);
    expect(stored.surfaceEdge).toBe(storedEdge(WORLD_PAGE_CHANNEL_CORE));
    expect(stored.surfaceTexelCount).toBe(136 * 136);
  });

  it("agrees with pageKey.ts level extents", () => {
    for (let level = 0; level <= 8; level += 1) {
      const extent = worldPageExtentMeters(level, WORLD_PAGE_BASE_EXTENT_METERS);
      expect(pageTexelSizeMeters(level, WORLD_PAGE_HEIGHT_CORE)).toBe(extent / 256);
      expect(pageTexelSizeMeters(level, WORLD_PAGE_CHANNEL_CORE)).toBe(extent / 128);
    }
    // The level-0 height texel is the 2 m spacing the plan builds L0 around.
    expect(pageTexelSizeMeters(0, WORLD_PAGE_HEIGHT_CORE)).toBe(2);
    expect(pageTexelSizeMeters(0, WORLD_PAGE_CHANNEL_CORE)).toBe(4);
  });

  it("round-trips core and gutter addressing for every supported shape", () => {
    for (const core of [128, 256]) {
      for (const gutter of [0, 1, 4]) {
        const edge = storedEdge(core, gutter);
        expect(edge).toBe(core + gutter * 2);

        // The four extreme stored corners, the four core corners, and one
        // sample from each gutter band, plus interior spot checks.
        const low = gutter > 0 ? -gutter : 0;
        const high = core + gutter - 1;
        const probes: Array<readonly [number, number]> = [
          [low, low],
          [low, high],
          [high, low],
          [high, high],
          [0, 0],
          [0, core - 1],
          [core - 1, 0],
          [core - 1, core - 1],
          [Math.floor(core / 2), Math.floor(core / 3)],
        ];
        if (gutter > 0) {
          probes.push(
            [-1, Math.floor(core / 2)], // north gutter band
            [core, Math.floor(core / 2)], // south gutter band
            [Math.floor(core / 2), -1], // west gutter band
            [Math.floor(core / 2), core], // east gutter band
          );
        }
        for (const [row, column] of probes) {
          const index = coreToStoredIndex(row, column, core, gutter);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(edge * edge);
          expect(storedIndexToCore(index, core, gutter)).toEqual({ row, column });
        }

        // The convention itself, spelled out: core (row, column) lives at
        // (row + gutter) * storedEdge + (column + gutter).
        expect(coreToStoredIndex(0, 0, core, gutter)).toBe(gutter * edge + gutter);
        expect(coreToStoredIndex(2, 3, core, gutter)).toBe(
          (2 + gutter) * edge + 3 + gutter,
        );
      }
    }
  });

  it("exhaustively round-trips every stored sample of the shipped shapes", () => {
    for (const core of [WORLD_PAGE_HEIGHT_CORE, WORLD_PAGE_CHANNEL_CORE]) {
      const gutter = WORLD_PAGE_GUTTER;
      const edge = storedEdge(core, gutter);
      for (let index = 0; index < edge * edge; index += 1) {
        const { row, column } = storedIndexToCore(index, core, gutter);
        expect(coreToStoredIndex(row, column, core, gutter)).toBe(index);
      }
    }
  });

  it("rejects out-of-range coordinates and malformed shapes", () => {
    expect(() => coreToStoredIndex(-5, 0, 128, 4)).toThrow(RangeError);
    expect(() => coreToStoredIndex(0, 132, 128, 4)).toThrow(RangeError);
    expect(() => coreToStoredIndex(0.5, 0, 128, 4)).toThrow(RangeError);
    expect(() => storedIndexToCore(136 * 136, 128, 4)).toThrow(RangeError);
    expect(() => storedIndexToCore(-1, 128, 4)).toThrow(RangeError);
    expect(() => storedEdge(0)).toThrow(RangeError);
    expect(() => storedEdge(128, -1)).toThrow(RangeError);
    expect(() => pageTexelSizeMeters(-1, 256)).toThrow(RangeError);
    expect(() => pageTexelSizeMeters(0, 0)).toThrow(RangeError);
  });
});
