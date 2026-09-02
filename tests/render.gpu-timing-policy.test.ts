import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";

import {
  gpuTimingEnabledAtStartup,
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
  // `W-1d`: every stage of the multi-frame page-erosion DAG runs per frame
  // under the `erosionCompute` meter, and its consumer is
  // `TerrainPageErosionGpu.consumeMeasuredDispatchCostMs` ->
  // `TerrainPageGenerator.consumeMeasuredErosionDispatchCostMs` ->
  // `TerrainClipmapSystem.observeDispatchCosts` ->
  // `ComputeBudget.observeDispatchCostMs("erosionCompute", ...)`. Untiming
  // them puts the DAG back on its pinned seeds forever, and the seeds are
  // per-STAGE here — the admission price changes as the page walks the DAG.
  "src/render/webgpu/terrain/TerrainPageErosionGpu.ts",
  // `6-9`, wave G's first debt: the ground-cover placement dispatches used to
  // opt OUT of timing, which was correct only while `groundCoverCompute` was
  // not a `ComputeBudget` client. It is one now, so its counter has a
  // consumer — `GroundCoverSystem.observeDispatchCosts` ->
  // `ComputeBudget.observeDispatchCostMs("groundCoverCompute", ...)` — and
  // untiming it would pin the only per-FRAME compute client on its seed
  // estimate forever. Only ring 0's shader is sampled: the three rings run
  // the same kernel over different lattice sizes, and the meter's job is to
  // price a dispatch, not to average three of them.
  "src/render/webgpu/detail/GroundCoverSystem.ts",
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
    const source = readSource(path);
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
  describe("capture observer-cost policy", () => {
    it("keeps costly continuous telemetry off by default", () => {
      expect(gpuTimingEnabledAtStartup({
        timestampQuerySupported: true,
        captureGpuTiming: undefined,
        pinnedCapture: false,
      })).toBe(false);
      expect(gpuTimingEnabledAtStartup({
        timestampQuerySupported: false,
        captureGpuTiming: undefined,
        pinnedCapture: false,
      })).toBe(false);
    });

    it("permits either diagnostic state only on pinned capture renderers", () => {
      expect(gpuTimingEnabledAtStartup({
        timestampQuerySupported: true,
        captureGpuTiming: true,
        pinnedCapture: true,
      })).toBe(true);
      expect(gpuTimingEnabledAtStartup({
        timestampQuerySupported: true,
        captureGpuTiming: false,
        pinnedCapture: true,
      })).toBe(false);
      expect(() => gpuTimingEnabledAtStartup({
        timestampQuerySupported: true,
        captureGpuTiming: false,
        pinnedCapture: false,
      })).toThrow(/pinned capture renderer/);
      expect(() => gpuTimingEnabledAtStartup({
        timestampQuerySupported: true,
        captureGpuTiming: true,
        pinnedCapture: false,
      })).toThrow(/pinned diagnostic capture/);
    });

    it("locks Babylon's global timer once, before any scene work is encoded", () => {
      const source = readFileSync(
        join(projectRoot, "src/render/FlightRenderer.ts"),
        "utf8",
      );
      const assignments = source.match(/engine\.enableGPUTimingMeasurements\s*=/gu) ?? [];

      // Babylon's setter tears down its shared timestamp query set. Calling it
      // after a frame has been encoded can leave the next unsent encoder
      // referencing a destroyed query set; WebGPU then rejects the whole
      // submit, which presents as a random black frame. The renderer may pick
      // the value at startup, but it must never toggle it while live.
      expect(assignments).toHaveLength(1);
      const assignment = source.indexOf(
        "engine.enableGPUTimingMeasurements = gpuTimingEnabled",
      );
      const firstScene = source.indexOf("const scene = new Scene(engine)");
      expect(assignment).toBeGreaterThan(0);
      expect(firstScene).toBeGreaterThan(assignment);
    });
  });

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
