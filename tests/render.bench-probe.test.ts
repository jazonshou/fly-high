import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { FlightRenderer, type RendererBenchProbe } from "../src/render/FlightRenderer";
import {
  createGovernorState,
  governorConfigForProfile,
  workLeverSettingsFor,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { readSource } from "./support/sourceText";

/**
 * `readBenchProbe` is the one renderer change the `?bench=1` benchmark makes.
 * It must be read-only, so a benchmarked renderer renders what a player's
 * does, and cheap enough to call after every frame.
 */

const projectRoot = join(import.meta.dirname, "..");

function receiver(overrides: Record<string, unknown> = {}) {
  const governorConfig = governorConfigForProfile({ tier: 1, renderScale: 0.86, governorPixelFloorRatio: 0.6 });
  const fields = {
    frameIndex: 42,
    governorConfig,
    governorState: createGovernorState(governorConfig),
    lastSignals: Object.freeze({ gpuP95Ms: null, cpuP95Ms: 6.5, intervalP95Ms: 16.9 }),
    workLeverSettings: workLeverSettingsFor(1, 2),
    appliedRenderScale: 0.81,
    pinnedRenderScale: null,
    lastGpuFrameMilliseconds: 7.25,
    lastGpuTimingFrameIndex: 41,
    engine: Object.freeze({ getRenderWidth: () => 1_212, getRenderHeight: () => 682 }),
    presentationCadence: Object.freeze({
      frameCapHz: 60,
      divisor: 2,
      displayPeriodMs: 1_000 / 120,
      periodConfirmed: true,
    }),
    ...overrides,
  };
  // Frozen, so any write to the receiver throws (class bodies are strict).
  return { fields, renderer: Object.freeze(fields) as unknown as FlightRenderer };
}

function emptyProbe(): RendererBenchProbe {
  return {} as RendererBenchProbe;
}

describe("the renderer's bench probe", () => {
  it("copies references and numbers without touching the renderer", () => {
    const { fields, renderer } = receiver();
    const before = { ...fields };
    const probe = emptyProbe();

    FlightRenderer.prototype.readBenchProbe.call(renderer, probe);

    expect(probe.frameIndex).toBe(42);
    expect(probe.governorState).toBe(fields.governorState);
    expect(probe.governorSignals).toBe(fields.lastSignals);
    expect(probe.governorConfig).toBe(fields.governorConfig);
    expect(probe.workLevers).toBe(fields.workLeverSettings);
    expect(probe.appliedRenderScale).toBe(0.81);
    expect(probe.renderWidth).toBe(1_212);
    expect(probe.renderHeight).toBe(682);
    expect(probe.pinned).toBe(false);
    expect(probe.presentationCadence).toBe(fields.presentationCadence);
    expect({ ...fields }).toEqual(before);
  });

  it("writes every field of the probe, so one object can be reused from the first frame", () => {
    const { renderer } = receiver();
    const probe = emptyProbe();

    FlightRenderer.prototype.readBenchProbe.call(renderer, probe);

    expect(Object.keys(probe).sort()).toEqual([
      "appliedRenderScale",
      "frameIndex",
      "governorConfig",
      "governorSignals",
      "governorState",
      "gpuFrameMs",
      "pinned",
      "presentationCadence",
      "renderHeight",
      "renderWidth",
      "workLevers",
    ]);
  });

  it("reports GPU milliseconds only for a sample resolved during this frame", () => {
    const stale = emptyProbe();
    FlightRenderer.prototype.readBenchProbe.call(receiver().renderer, stale);
    expect(stale.gpuFrameMs).toBeNull();

    const fresh = emptyProbe();
    FlightRenderer.prototype.readBenchProbe.call(
      receiver({ lastGpuTimingFrameIndex: 42 }).renderer,
      fresh,
    );
    expect(fresh.gpuFrameMs).toBe(7.25);

    // Timing off: the renderer never stamps a frame.
    const off = emptyProbe();
    FlightRenderer.prototype.readBenchProbe.call(
      receiver({
        lastGpuFrameMilliseconds: null,
        lastGpuTimingFrameIndex: Number.NEGATIVE_INFINITY,
      }).renderer,
      off,
    );
    expect(off.gpuFrameMs).toBeNull();
  });

  it("says whether the renderer is pinned", () => {
    const probe = emptyProbe();
    FlightRenderer.prototype.readBenchProbe.call(
      receiver({ pinnedRenderScale: 1.2 }).renderer,
      probe,
    );
    expect(probe.pinned).toBe(true);
  });

  it("assigns no renderer field, constructs nothing and calls only the engine's size getters", () => {
    const source = readSource(join(projectRoot, "src/render/FlightRenderer.ts"));
    const body = source.match(
      /\n {2}readBenchProbe\(into: RendererBenchProbe\): void \{([\s\S]*?)\n {2}\}\n/u,
    )?.[1] ?? "";

    expect(body).toContain("into.frameIndex = this.frameIndex;");
    expect(body).not.toMatch(/\bthis\.[\w.]+\s*=[^=]/u);
    expect(body).not.toMatch(/\bnew\b|[{[]/u);
    expect(body.match(/[\w$]+\(/gu)).toEqual(["getRenderWidth(", "getRenderHeight("]);
  });

  it("is called only from src/bench", () => {
    const sourceFiles = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.tsx?$/u.test(entry.name) ? [path] : [];
      });
    const callers = sourceFiles(join(projectRoot, "src"))
      .filter((path) => /\.readBenchProbe\(/u.test(readSource(path)))
      .map((path) => relative(projectRoot, path).split(sep).join("/"));

    expect(callers.every((path) => path.startsWith("src/bench/"))).toBe(true);
  });
});
