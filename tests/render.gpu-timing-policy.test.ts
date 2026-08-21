import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasDispatchTiming,
  withoutDispatchTiming,
} from "@/src/render/webgpu/core/GpuTimingPolicy";

const projectRoot = join(import.meta.dirname, "..");
const renderRoot = join(projectRoot, "src/render");

/**
 * Compute dispatches whose `gpuTimeInFrame` counter HAS a consumer, and which
 * must therefore stay timed. Both feed `ComputeBudget.observeDispatchCostMs`
 * through `consumeGpuDispatchCostMs`; untiming them puts the admission meter
 * back on its seed estimates forever (`4.5-B2(a)`).
 */
const TIMED_ON_PURPOSE = [
  "src/render/webgpu/terrain/TerrainPageAtlas.ts",
  "src/render/webgpu/terrain/PageOcclusionBake.ts",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

/** Index of every `new ComputeShader(` occurrence, with its wrapped-ness. */
function computeShaderSites(): Array<{ file: string; wrapped: boolean }> {
  const sites: Array<{ file: string; wrapped: boolean }> = [];
  for (const path of sourceFiles(renderRoot)) {
    const source = readFileSync(path, "utf8");
    let index = source.indexOf("new ComputeShader(");
    while (index >= 0) {
      const prefix = source.slice(Math.max(0, index - 24), index);
      sites.push({
        file: relative(projectRoot, path),
        wrapped: prefix.includes("withoutDispatchTiming("),
      });
      index = source.indexOf("new ComputeShader(", index + 1);
    }
  }
  return sites;
}

describe("G0-2 GPU dispatch timing policy", () => {
  describe("withoutDispatchTiming", () => {
    it("clears the counter and returns the same instance", () => {
      const shader = { gpuTimeInFrame: { counter: { count: 0, current: 0 } } };
      expect(hasDispatchTiming(shader)).toBe(true);
      expect(withoutDispatchTiming(shader)).toBe(shader);
      expect(hasDispatchTiming(shader)).toBe(false);
      expect(shader.gpuTimeInFrame).toBeUndefined();
    });

    it("is a no-op when timing was never enabled", () => {
      const shader = {};
      expect(hasDispatchTiming(shader)).toBe(false);
      expect(() => withoutDispatchTiming(shader)).not.toThrow();
      expect(hasDispatchTiming(shader)).toBe(false);
    });
  });

  describe("every compute dispatch is a deliberate decision", () => {
    // The whole cost model rests on this: Babylon gates BOTH the timestamp
    // write and the resolve+submit+mapAsync on `if (gpuPerfCounter)`, so a
    // counter nobody reads is a per-frame submit bought for nothing. A new
    // ComputeShader must therefore either be wrapped or be listed above.
    it("either untimes a dispatch or names a consumer for its counter", () => {
      const unaccounted = computeShaderSites().filter(
        (site) => !site.wrapped && !TIMED_ON_PURPOSE.includes(site.file),
      );
      expect(
        unaccounted.map((site) => site.file),
        "each of these constructs a ComputeShader that keeps a gpuTimeInFrame "
        + "counter with no consumer — wrap it in withoutDispatchTiming(), or add "
        + "it to TIMED_ON_PURPOSE and say which consumer reads it",
      ).toEqual([]);
    });

    it("keeps the compute-budget dispatches timed", () => {
      const sites = computeShaderSites();
      for (const file of TIMED_ON_PURPOSE) {
        const forFile = sites.filter((site) => site.file === file);
        expect(forFile.length, `${file} no longer constructs a ComputeShader`)
          .toBeGreaterThan(0);
        expect(
          forFile.every((site) => !site.wrapped),
          `${file} feeds ComputeBudget.observeDispatchCostMs and must stay timed`,
        ).toBe(true);
      }
    });

    it("still untimes the spectral ocean, the dominant per-frame cost", () => {
      // Tier 1 averages 44 ocean dispatches per frame (14 FFT stages plus
      // evolution and derivation, four cascades on a 1/1/2/4 cadence). This is
      // the line item G0-2 exists to remove; a regression here is the whole
      // frame budget coming back.
      const ocean = computeShaderSites().filter((site) =>
        site.file.endsWith("SpectralOceanSystem.ts"),
      );
      expect(ocean.length).toBeGreaterThan(0);
      expect(ocean.every((site) => site.wrapped)).toBe(true);
    });
  });

  describe("the Babylon behaviour this policy relies on", () => {
    it("still gates the timestamp write and the resolve on the counter", () => {
      const source = readFileSync(
        join(
          projectRoot,
          "node_modules/@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader.pure.js",
        ),
        "utf8",
      );
      // Both halves must be counter-gated, or clearing it stops saving anything.
      expect(source).toContain("if (gpuPerfCounter) {");
      expect(source).toContain("this._timestampQuery.startPass(ComputePassDescriptor");
      expect(source).toContain("this._timestampQuery.endPass(this._timestampIndex, gpuPerfCounter)");
    });

    it("still creates the counter only when GPU timing is enabled", () => {
      const source = readFileSync(
        join(projectRoot, "node_modules/@babylonjs/core/Compute/computeShader.pure.js"),
        "utf8",
      );
      expect(source).toContain("if (engine.enableGPUTimingMeasurements)");
      expect(source).toContain("this.gpuTimeInFrame = new WebGPUPerfCounter()");
    });
  });
});
