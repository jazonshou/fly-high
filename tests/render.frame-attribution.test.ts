import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attributePresentFrame } from "../src/render/frameAttribution";

describe("present-to-present frame attribution (B-0)", () => {
  it("treats CPU and GPU as overlapping streams", () => {
    expect(attributePresentFrame(40, 6, 15)).toEqual({
      intervalMs: 40,
      cpuBusyMs: 6,
      gpuBusyMs: 15,
      presentWaitMs: 25,
    });
  });

  it("does not invent present wait without a GPU counter", () => {
    expect(attributePresentFrame(33.3, 7, null)).toEqual({
      intervalMs: 33.3,
      cpuBusyMs: 7,
      gpuBusyMs: null,
      presentWaitMs: null,
    });
  });

  it("bounds attribution to the measured interval and rejects invalid timing", () => {
    expect(attributePresentFrame(16, 20, 12)?.presentWaitMs).toBe(0);
    expect(attributePresentFrame(0, 4, 5)?.intervalMs).toBeNull();
    expect(attributePresentFrame(Number.NaN, 4, 5)?.presentWaitMs).toBeNull();
  });

  it("keeps async GPU aggregates out of frame-aligned residuals", () => {
    const rendererSource = readFileSync(
      new URL("../src/render/FlightRenderer.ts", import.meta.url),
      "utf8",
    );
    expect(rendererSource).toContain(
      "this.recordPresentAttribution(interval, this.lastCpuFrameMilliseconds, null)",
    );
    expect(rendererSource).toContain(
      "frameTimingPercentile95(this.diagnosticPresentWaitDurations)",
    );
    expect(rendererSource).not.toMatch(
      /attributePresentFrame\(\s*frameIntervalP95Ms,\s*cpuP95Ms,\s*gpuP95Ms/u,
    );
  });
});
