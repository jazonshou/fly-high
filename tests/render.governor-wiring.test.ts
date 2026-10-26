import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlightRenderer } from "../src/render/FlightRenderer";
import {
  createGovernorState,
  governorConfigForProfile,
  type GovernorConfig,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import type { PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { readSource } from "./support/sourceText";

/**
 * How FlightRenderer feeds the governor in PR B (G-2). The governor judges
 * the rAF deltas the frame loop hands `render()`, which are what the pilot
 * sees presented; the `performance.now()` interval stays for diagnostics and
 * present attribution. The presentation cadence the frame pacer sets moves
 * the governor's targets, and the window in flight restarts only when they
 * move, at most once per window, and never for a pinned capture.
 */

const renderer = readSource(join(import.meta.dirname, "..", "src", "render", "FlightRenderer.ts"));

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("the renderer's governor wiring", () => {
  it("feeds the governor the frame loop's presented intervals", () => {
    expect(count(renderer, "this.captureFrameInterval(started, deltaSeconds);")).toBe(1);
    expect(renderer).toContain("const presentedMilliseconds = deltaSeconds * 1_000;");
    expect(count(renderer, "this.frameIntervalDurations.push(")).toBe(1);
    expect(renderer).toContain("this.frameIntervalDurations.push(presentedMilliseconds);");
    // Diagnostics keep the performance.now() interval, stalls included.
    expect(renderer).toContain("this.pushDiagnosticSample(this.diagnosticIntervalDurations, interval);");
  });

  it("summarises each window against the cadence's late threshold and hitch threshold", () => {
    expect(renderer).toContain(
      "summariseIntervals(this.frameIntervalDurations, this.governorConfig.lateIntervalMs)",
    );
    expect(renderer).toContain("hitchThresholdMilliseconds(this.profile, this.presentationCadence)");
    expect(renderer).toContain("governorConfigForProfile(this.profile, this.presentationCadence)");
    // A pinned renderer never decides, so its signals stay at their first value.
    expect(renderer).toMatch(/this\.pinnedRenderScale === null\s*&& this\.frameIntervalDurations\.length >= this\.governorConfig\.windowFrames\s*\)\s*\{\s*this\.updateGovernor\(\);/u);
  });
});

const medium = resolveWebGpuQualityProfile("medium", "balanced");

/** A governor mid-window: a probe out, a calm streak, and levels to keep. */
function busyState(config: GovernorConfig): GovernorState {
  return Object.freeze({
    ...createGovernorState(config),
    cpuWorkLevel: 2,
    gpuWorkLevel: 3,
    renderScale: 0.81,
    pendingProbe: Object.freeze({
      preStepGpuP95Ms: 33.3,
      preStepScale: 0.86,
      metric: "interval" as const,
      preIntervalMeanMs: 20,
      preLateFraction: 0.2,
    }),
    calmStreak: Object.freeze([0, 0.01]),
    offCadenceWindows: 1,
  });
}

interface Receiver {
  profile: typeof medium;
  presentationCadence: PresentationCadence | null;
  pinnedRenderScale: number | null;
  governorConfig: GovernorConfig;
  governorState: GovernorState;
  governorRebasedThisWindow: boolean;
  frameIntervalDurations: number[];
  cpuFrameDurations: number[];
  gpuFrameDurations: number[];
}

function receiver(overrides: Partial<Receiver> = {}): Receiver {
  const governorConfig = governorConfigForProfile(medium);
  const fields: Receiver = {
    profile: medium,
    presentationCadence: null,
    pinnedRenderScale: null,
    governorConfig,
    governorState: busyState(governorConfig),
    governorRebasedThisWindow: false,
    frameIntervalDurations: [16.7, 16.6, 16.7],
    cpuFrameDurations: [5, 5, 5],
    gpuFrameDurations: [],
    ...overrides,
  };
  return Object.assign(Object.create(FlightRenderer.prototype) as object, fields) as Receiver;
}

function setCadence(target: Receiver, cadence: PresentationCadence | null): void {
  FlightRenderer.prototype.setPresentationCadence.call(target as unknown as FlightRenderer, cadence);
}

const paced60At120: PresentationCadence = { frameCapHz: 60, divisor: 2, displayPeriodMs: 1_000 / 120, periodConfirmed: true };
const thirtyAt60: PresentationCadence = { frameCapHz: 30, divisor: 2, displayPeriodMs: 1_000 / 60, periodConfirmed: true };

describe("setPresentationCadence", () => {
  it("ignores a cadence with the same identity without writing anything", () => {
    const target = Object.freeze(receiver({ presentationCadence: paced60At120 }));
    // Frozen, so any write throws; a fresh object with the same identity is no change.
    expect(() => setCadence(target, { ...paced60At120 })).not.toThrow();
  });

  it("at the 60 setting on a 120 Hz panel moves only the late threshold, and the window carries on", () => {
    const target = receiver();
    const state = target.governorState;
    setCadence(target, paced60At120);
    expect(target.presentationCadence).toBe(paced60At120);
    expect(target.governorConfig.presentationTargetMs).toBe(1_000 / 60);
    expect(target.governorConfig.gpuTargetMs).toBe(13.7);
    expect(target.governorConfig.lateIntervalMs).toBeCloseTo(2.5 * (1_000 / 120), 9);
    expect(target.governorState).toBe(state);
    expect(target.frameIntervalDurations).toHaveLength(3);
    expect(target.governorRebasedThisWindow).toBe(false);
  });

  it("at the 30 setting moves the targets, rebases the governor and restarts the window, once per window", () => {
    const target = receiver();
    setCadence(target, thirtyAt60);
    expect(target.governorConfig.presentationTargetMs).toBe(1_000 / 30);
    expect(target.governorConfig.gpuTargetMs).toBe(30);
    expect(target.governorState).toMatchObject({
      pendingProbe: null,
      calmStreak: [],
      offCadenceWindows: 0,
      cpuWorkLevel: 2,
      gpuWorkLevel: 3,
      renderScale: 0.81,
    });
    expect(target.frameIntervalDurations).toHaveLength(0);
    expect(target.cpuFrameDurations).toHaveLength(0);
    expect(target.governorRebasedThisWindow).toBe(true);

    // Back again inside the same window: the config follows, the window does not restart.
    target.frameIntervalDurations.push(33.3, 33.4);
    target.governorState = busyState(target.governorConfig);
    const state = target.governorState;
    setCadence(target, null);
    expect(target.governorConfig).toEqual(governorConfigForProfile(medium));
    expect(target.governorState).toBe(state);
    expect(target.frameIntervalDurations).toHaveLength(2);
  });

  it("keeps a pinned capture's governor frozen", () => {
    const target = receiver({ pinnedRenderScale: 0.86 });
    const state = target.governorState;
    setCadence(target, thirtyAt60);
    expect(target.governorConfig.frozen).toBe(true);
    expect(target.governorConfig.scaleCeiling).toBe(0.86);
    expect(target.governorConfig.scaleFloor).toBe(0.86);
    expect(target.governorState).toBe(state);
    expect(target.frameIntervalDurations).toHaveLength(3);
  });
});
