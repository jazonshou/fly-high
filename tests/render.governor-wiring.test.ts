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

interface HeldReceiver extends Receiver {
  governorHeld: boolean;
  frameIndex: number;
  lastGpuFrameMilliseconds: number | null;
  lastGpuTimingFrameIndex: number;
  renderScale: number;
  lastSignals: unknown;
  streamingBacklog: () => number;
  applyWorkLevels: (cpu: number, gpu: number) => void;
  deferGovernedRenderScale: () => boolean;
}

/** A receiver that can run whole governor windows: the subsystems it would touch are stubbed. */
function governedReceiver(start: GovernorState): HeldReceiver {
  const target = receiver({ governorState: start, frameIntervalDurations: [], cpuFrameDurations: [] }) as HeldReceiver;
  return Object.assign(target, {
    governorHeld: false,
    frameIndex: 0,
    lastGpuFrameMilliseconds: null,
    lastGpuTimingFrameIndex: 0,
    renderScale: start.renderScale,
    lastSignals: null,
    streamingBacklog: () => 0,
    applyWorkLevels: () => undefined,
    deferGovernedRenderScale: () => true,
  });
}

/** One full window of `intervalMs` frames at `cpuMs`, then the decision render() would ask for. */
function runWindow(target: HeldReceiver, intervalMs: number, cpuMs: number): void {
  for (let frame = 0; frame < target.governorConfig.windowFrames; frame += 1) {
    target.frameIntervalDurations.push(intervalMs);
    target.cpuFrameDurations.push(cpuMs);
  }
  (Reflect.get(FlightRenderer.prototype, "updateGovernor") as (this: HeldReceiver) => void).call(target);
}

function holdGovernor(target: HeldReceiver, held: boolean): void {
  FlightRenderer.prototype.setGovernorHold.call(target as unknown as FlightRenderer, held);
}

describe("setGovernorHold", () => {
  it("restarts the window in flight on each change, and only on a change", () => {
    const target = governedReceiver(createGovernorState(governorConfigForProfile(medium)));
    target.frameIntervalDurations.push(16.7, 16.6);
    target.cpuFrameDurations.push(5, 5);
    holdGovernor(target, false);
    expect(target.frameIntervalDurations).toHaveLength(2);
    holdGovernor(target, true);
    expect(target.governorHeld).toBe(true);
    expect(target.frameIntervalDurations).toHaveLength(0);
    expect(target.cpuFrameDurations).toHaveLength(0);
    target.frameIntervalDurations.push(16.7);
    holdGovernor(target, true);
    expect(target.frameIntervalDurations).toHaveLength(1);
    holdGovernor(target, false);
    expect(target.frameIntervalDurations).toHaveLength(0);
  });

  it("gives back nothing while paused, and the resume recovers as flight left off", () => {
    // A CPU-bound flight settled at CPU level 5. Paused, render() falls to 8
    // ms and every frame is on time: judged, those windows would recover a
    // rung every four, and the resume would pay for each again.
    const config = governorConfigForProfile(medium);
    const settled = Object.freeze({ ...createGovernorState(config), cpuWorkLevel: 5 });
    const target = governedReceiver(settled);
    runWindow(target, 1_000 / 60, 19);
    const flying = target.governorState;
    holdGovernor(target, true);
    for (let window = 0; window < 60; window += 1) runWindow(target, 1_000 / 60, 8);
    expect(target.governorState).toBe(flying);
    expect(target.frameIntervalDurations).toHaveLength(0);
    // Unheld, the same calm windows recover as flight left off.
    const free = governedReceiver(flying);
    for (let window = 0; window < 8; window += 1) runWindow(free, 1_000 / 60, 8);
    expect(free.governorState.cpuWorkLevel).toBeLessThan(5);
    holdGovernor(target, false);
    for (let window = 0; window < 8; window += 1) runWindow(target, 1_000 / 60, 8);
    expect(target.governorState.cpuWorkLevel).toBe(free.governorState.cpuWorkLevel);
  });
});

describe("discardNextFrameInterval", () => {
  it("keeps the gap a re-probe leaves out of diagnostics and the governor's window", () => {
    const target = Object.assign(receiver({ frameIntervalDurations: [] }), {
      previousFrameStartedAt: null as number | null,
      diagnosticIntervalDurations: [] as number[],
      diagnosticPresentWaitDurations: [] as number[],
      lastFrameIntervalMilliseconds: 0,
      lastPresentWaitMilliseconds: null as number | null,
      lastCpuFrameMilliseconds: 5,
    });
    const capture = Reflect.get(FlightRenderer.prototype, "captureFrameInterval") as (
      this: typeof target,
      started: number,
      deltaSeconds: number,
    ) => void;
    capture.call(target, 1_000, 1 / 60);
    capture.call(target, 1_016.7, 1 / 60);
    expect(target.diagnosticIntervalDurations).toEqual([expect.closeTo(16.7, 6)]);
    expect(target.frameIntervalDurations).toHaveLength(1);
    // 24 skipped refreshes at 120 Hz are 200 ms: under the 250 ms stall
    // gate, so without the call they count as a hitch and a late frame.
    FlightRenderer.prototype.discardNextFrameInterval.call(target as unknown as FlightRenderer);
    capture.call(target, 1_216.7, 0.1);
    expect(target.diagnosticIntervalDurations).toHaveLength(1);
    expect(target.frameIntervalDurations).toHaveLength(1);
    // Only that one: the frame after it counts again.
    capture.call(target, 1_233.4, 1 / 60);
    expect(target.diagnosticIntervalDurations).toHaveLength(2);
    expect(target.frameIntervalDurations).toHaveLength(2);
  });
});
