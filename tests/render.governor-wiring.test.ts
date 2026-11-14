import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FlightRenderer } from "../src/render/FlightRenderer";
import { HitchWindow } from "../src/render/hitchWindow";
import { resolveHardwareScalingLevel } from "../src/render/renderScaleLevel";
import {
  createGovernorState,
  FALLBACK_OFF,
  governorConfigForProfile,
  type CadenceFallbackPhase,
  type GovernorConfig,
  type GovernorState,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import type { PresentationCadence } from "../src/render/webgpu/core/presentationCadence";
import { hitchThresholdMilliseconds, resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
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

/** Every `.ts` under `dir`, as a path relative to the repository. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

describe("the CSM and cloud-depth refresh holds (PR B part 2, G5)", () => {
  it("syncs both intervals immediately before the scene renders, every frame", () => {
    expect(count(renderer, "this.syncRefreshHolds();")).toBe(1);
    expect(renderer).toMatch(
      /name: "hdr-present",[^}]*?execute: \(\) => \{\s*this\.syncRefreshHolds\(\);\s*this\.scene\.render\(false, false\);\s*\}/u,
    );
  });

  it("forces both fresh on every history invalidation, from the pass that renders them", () => {
    expect(renderer).toMatch(
      /this\.scene\.render\(false, false\);\s*\},\s*invalidateHistory: \(\) => \{\s*forceRefresh\(this\.atmosphere\.shadows\.getShadowMap\(\)\);\s*forceRefresh\(this\.atmosphereResources\.sceneDepth\);\s*\}/u,
    );
  });

  it("keeps the two holds off each other's frames, after both intervals are synced", () => {
    expect(count(renderer, "staggerRefresh(")).toBe(1);
    expect(renderer).toMatch(
      /work\.cloudDepthRefreshExtraFrames,\s*\);\s*const shadowCountBefore = this\.shadowRefreshCountSeen;\s*this\.shadowRefreshCountSeen = shadowMap\?\.currentRefreshId \?\? Number\.NaN;\s*staggerRefresh\(shadowMap, sceneDepth, shadowCountBefore\);\s*\}/u,
    );
  });

  it("adds the governor's frames after the profile's rate is converted to the cadence", () => {
    expect(renderer).toContain(
      "refreshIntervalAtCadence(work.shadowRefreshFrames, tier, shown) + work.shadowRefreshExtraFrames",
    );
    expect(renderer).toContain(
      "refreshIntervalAtCadence(work.cloudDepthRefreshFrames, tier, shown) + work.cloudDepthRefreshExtraFrames",
    );
  });

  it("writes refreshRate nowhere in src but the hold and the two render-once targets", () => {
    // A per-frame write resets Babylon's counter and renders every frame
    // (verify F3), so every interval goes through syncRefreshInterval.
    const allowed = new Set([
      join("src", "render", "refreshHold.ts"),
      join("src", "render", "webgpu", "atmosphere", "SkyEnvironmentProbe.ts"),
      join("src", "render", "webgpu", "atmosphere", "AtmosphereGpuResources.ts"),
    ]);
    const writes = /\.refreshRate\s*=(?!=)/u;
    const writers = sourceFiles("src").filter((path) => writes.test(readSource(path)));
    expect(writers.sort()).toEqual([...allowed].sort());
    // The one write in AtmosphereGpuResources is the sky LUT's render-once.
    expect(count(readSource(join("src", "render", "webgpu", "atmosphere", "AtmosphereGpuResources.ts")), ".refreshRate =")).toBe(1);
  });
});

const medium = resolveWebGpuQualityProfile("medium", "balanced");

describe("the render-scale level (PR B part 2, G4)", () => {
  it("keeps the pinned path on the 1A-6a resolver and steps the capped frame otherwise", () => {
    expect(renderer).toMatch(new RegExp(
      String.raw`private resolveRenderScaleLevel\(\): number \{\s*const inputs = \{[^}]*\};\s*`
      + String.raw`if \(this\.pinnedRenderScale !== null\) return resolveHardwareScalingLevel\(inputs\);\s*`
      + String.raw`return resolveGovernedHardwareScalingLevel\(\{\s*\.\.\.inputs,\s*`
      + String.raw`ceilingScale: this\.governorConfig\.scaleCeiling,\s*minRenderPixels: GOVERNED_MIN_RENDER_PIXELS,\s*\}\);\s*\}`,
      "u",
    ));
  });

  it("is the 1A-6a level at the ceiling, and applies an unpinned step after the cap", () => {
    // Medium at 1080p: 0.86 asks for 1.53 Mpx and the 1.5 Mpx cap binds.
    const display = { clientWidth: 1_920, clientHeight: 1_080 };
    const cssPixels = display.clientWidth * display.clientHeight;
    const inputs = (renderScale: number) => ({
      maxDevicePixelRatio: medium.maxDevicePixelRatio,
      devicePixelRatio: 1,
      renderScale,
      cssWidth: display.clientWidth,
      cssHeight: display.clientHeight,
      maxRenderPixels: medium.maxRenderPixels,
    });
    const level = (renderScale: number, pinnedRenderScale: number | null): number => {
      const target = {
        profile: medium,
        domElement: display,
        renderScale,
        pinnedRenderScale,
        governorConfig: governorConfigForProfile(medium),
      };
      return (Reflect.get(FlightRenderer.prototype, "resolveRenderScaleLevel") as (this: typeof target) => number)
        .call(target);
    };
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    try {
      const ceiling = medium.renderScale;
      expect(Object.is(level(ceiling, null), resolveHardwareScalingLevel(inputs(ceiling)))).toBe(true);
      expect(cssPixels / level(ceiling, null) ** 2).toBeCloseTo(medium.maxRenderPixels, 3);
      // Pinned (a capture at a lower scale): the cap-only rule, as before.
      expect(Object.is(level(0.81, 0.81), resolveHardwareScalingLevel(inputs(0.81)))).toBe(true);
      // Unpinned, the same step lands on the capped frame: 1.5 × (0.81 / 0.86)² Mpx,
      // where the cap-only rule gives 1.36.
      const governed = level(0.81, null);
      expect(cssPixels / governed ** 2).toBeCloseTo(medium.maxRenderPixels * (0.81 / ceiling) ** 2, 3);
      expect(governed).toBeGreaterThan(resolveHardwareScalingLevel(inputs(0.81)));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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

describe("cadenceFallbackRequest (PR B part 2b, G6)", () => {
  const sixty: PresentationCadence = { frameCapHz: 60, divisor: 1, displayPeriodMs: 1_000 / 60, periodConfirmed: true };
  const lowAt30 = { ...resolveWebGpuQualityProfile("low", "balanced"), cadenceFallbackHz: 30 };

  /** FlightRenderer's receiver, on the fields it reads; the config as resolveGovernorConfig gives it. */
  function fallbackReceiver(pinnedRenderScale: number | null, phase: CadenceFallbackPhase) {
    const fields = { profile: lowAt30, presentationCadence: sixty, pinnedRenderScale };
    const target = Object.assign(Object.create(FlightRenderer.prototype) as object, fields) as typeof fields & {
      governorConfig: GovernorConfig;
      governorState: GovernorState;
    };
    target.governorConfig = (Reflect.get(FlightRenderer.prototype, "resolveGovernorConfig") as (this: typeof target) => GovernorConfig)
      .call(target);
    setFallback(target, phase, 22);
    return target;
  }

  function setFallback(
    target: { governorConfig: GovernorConfig; governorState: GovernorState },
    phase: CadenceFallbackPhase,
    minIntervalMs: number,
  ): void {
    target.governorState = Object.freeze({
      ...createGovernorState(target.governorConfig),
      fallback: Object.freeze({ ...FALLBACK_OFF, phase, minIntervalMs }),
    });
  }

  function ask(target: ReturnType<typeof fallbackReceiver>) {
    return FlightRenderer.prototype.cadenceFallbackRequest.call(target as unknown as FlightRenderer);
  }

  function asked(pinnedRenderScale: number | null, phase: CadenceFallbackPhase) {
    return ask(fallbackReceiver(pinnedRenderScale, phase));
  }

  it("is null for a fresh governor, and asks while the fallback is engaged", () => {
    expect(asked(null, "off")).toBeNull();
    expect(asked(null, "engaged")).toEqual({ hz: 30, minIntervalMs: 22 });
    expect(asked(null, "settled")).toEqual({ hz: 30, minIntervalMs: 22 });
  });

  it("is null while pinned, whatever the state", () => {
    expect(asked(0.72, "engaged")).toBeNull();
    expect(asked(0.72, "settled")).toBeNull();
  });

  it("hands the frame loop the same request while it holds, and a new one when it moves", () => {
    // The frame loop asks after every drawn frame, and a fallback holds for
    // minutes: a new object each time was garbage at the frame rate.
    const target = fallbackReceiver(null, "engaged");
    const first = ask(target);
    expect(first).toEqual({ hz: 30, minIntervalMs: 22 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(ask(target)).toBe(first);
    // Settled at the same interval: the same request.
    setFallback(target, "settled", 22);
    expect(ask(target)).toBe(first);
    // The divisor moved, and with it the interval: a new request, then that one again.
    setFallback(target, "settled", 2_000 / 75);
    const moved = ask(target);
    expect(moved).not.toBe(first);
    expect(moved).toEqual({ hz: 30, minIntervalMs: 2_000 / 75 });
    expect(Object.isFrozen(moved)).toBe(true);
    expect(ask(target)).toBe(moved);
    // A new rate is a new request too.
    target.governorConfig = Object.freeze({ ...target.governorConfig, cadenceFallbackHz: 36 });
    const faster = ask(target);
    expect(faster).not.toBe(moved);
    expect(faster).toEqual({ hz: 36, minIntervalMs: 2_000 / 75 });
    expect(ask(target)).toBe(faster);
    // A trial asks for nothing, nor does a pinned capture, whatever was asked before.
    setFallback(target, "trial", 2_000 / 75);
    expect(ask(target)).toBeNull();
    setFallback(target, "engaged", 2_000 / 75);
    expect(ask(target)).toEqual({ hz: 36, minIntervalMs: 2_000 / 75 });
    target.pinnedRenderScale = 0.72;
    expect(ask(target)).toBeNull();
  });

  it("reports the phase in diagnostics only where the config allows a fallback, and the cadence's rate", () => {
    expect(renderer).toMatch(
      /cadenceFallback: this\.pinnedRenderScale !== null \|\| this\.governorConfig\.cadenceFallbackHz === null \? null : \{/u,
    );
    expect(renderer).toContain("fallbackHz: this.presentationCadence.fallbackHz ?? null,");
  });
});

const DIAGNOSTIC_WINDOW_FRAMES = Number(/const DIAGNOSTIC_WINDOW_FRAMES = (\d+);/u.exec(renderer)?.[1]);

/** A receiver with the fields captureFrameInterval writes. */
function capturing(base: Receiver) {
  return Object.assign(base, {
    previousFrameStartedAt: null as number | null,
    diagnosticIntervalDurations: [] as number[],
    diagnosticHitches: new HitchWindow(DIAGNOSTIC_WINDOW_FRAMES),
    diagnosticPresentWaitDurations: [] as number[],
    lastFrameIntervalMilliseconds: 0,
    lastPresentWaitMilliseconds: null as number | null,
    lastCpuFrameMilliseconds: 5,
  });
}

const capture = Reflect.get(FlightRenderer.prototype, "captureFrameInterval") as (
  this: ReturnType<typeof capturing>,
  started: number,
  deltaSeconds: number,
) => void;

describe("the diagnostics' hitch count (PR B part 2b)", () => {
  // Low under "60 fps" on a 60 Hz display: 27.4 ms at 60, 60 ms while the even fallback holds.
  const lowAt30 = { ...resolveWebGpuQualityProfile("low", "balanced"), cadenceFallbackHz: 30 };
  const sixty: PresentationCadence = { frameCapHz: 60, divisor: 1, displayPeriodMs: 1_000 / 60, periodConfirmed: true };
  const fallback: PresentationCadence = { ...sixty, divisor: 2, fallbackHz: 30 };

  it("judges each interval against the cadence it was drawn at, so a switch never judges the window again", () => {
    expect(DIAGNOSTIC_WINDOW_FRAMES).toBe(600);
    expect(hitchThresholdMilliseconds(lowAt30, sixty)).toBeCloseTo(27.4, 9);
    expect(hitchThresholdMilliseconds(lowAt30, fallback)).toBeCloseTo(60, 9);
    const target = capturing(receiver({ profile: lowAt30, presentationCadence: fallback, frameIntervalDurations: [] }));
    const thirty = 1_000 / 30;
    let now = 1_000;
    capture.call(target, now, 1 / 30);
    const draw = (frames: number) => {
      for (let frame = 0; frame < frames; frame += 1) {
        now += thirty;
        capture.call(target, now, 1 / 30);
      }
    };
    // Engaged: a full window of 33.3 ms frames, none a hitch against 60 ms.
    draw(600);
    expect(target.diagnosticIntervalDurations).toHaveLength(600);
    expect(target.diagnosticHitches.count).toBe(0);
    // A 60 fps trial starts. Judged again against 27.4 ms, the window read 600 hitches.
    setCadence(target, sixty);
    expect(target.diagnosticHitches.count).toBe(0);
    // The machine cannot hold 60: each 33.3 ms frame it draws now is a hitch.
    draw(120);
    expect(target.diagnosticHitches.count).toBe(120);
    // The trial fails and the fallback engages again. Judged again against
    // 60 ms, the trial's hitches vanished.
    setCadence(target, fallback);
    expect(target.diagnosticHitches.count).toBe(120);
    // They leave the window with their intervals: first the 480 engaged
    // frames before them, then one hitch a frame.
    draw(480);
    expect(target.diagnosticHitches.count).toBe(120);
    draw(20);
    expect(target.diagnosticHitches.count).toBe(100);
    draw(100);
    expect(target.diagnosticHitches.count).toBe(0);
    expect(target.diagnosticIntervalDurations).toHaveLength(600);
  });

  it("is the count getDiagnostics reports, cleared with the window, beside the threshold of the moment", () => {
    expect(renderer).toContain("private readonly diagnosticHitches = new HitchWindow(DIAGNOSTIC_WINDOW_FRAMES);");
    expect(renderer).toMatch(
      /this\.pushDiagnosticSample\(this\.diagnosticIntervalDurations, interval\);\s*this\.diagnosticHitches\.push\(interval, hitchThresholdMilliseconds\(this\.profile, this\.presentationCadence\)\);/u,
    );
    expect(count(renderer, "this.diagnosticHitches.push(")).toBe(1);
    expect(renderer).toContain("const hitchCount = this.diagnosticHitches.count;");
    expect(renderer).toMatch(/this\.diagnosticIntervalDurations\.length = 0;\s*this\.diagnosticHitches\.clear\(\);/u);
    expect(renderer).toContain(
      "const hitchThresholdMs = hitchThresholdMilliseconds(this.profile, this.presentationCadence);",
    );
    // Nothing counts the window against the threshold of the moment any more.
    expect(renderer).not.toMatch(/> hitchThresholdMs\b/u);
  });
});

describe("discardNextFrameInterval", () => {
  it("keeps the gap a re-probe leaves out of diagnostics and the governor's window", () => {
    const target = capturing(receiver({ frameIntervalDurations: [] }));
    capture.call(target, 1_000, 1 / 60);
    capture.call(target, 1_016.7, 1 / 60);
    expect(target.diagnosticIntervalDurations).toEqual([expect.closeTo(16.7, 6)]);
    expect(target.frameIntervalDurations).toHaveLength(1);
    // 24 skipped refreshes at 120 Hz are 200 ms: under the 250 ms stall
    // gate, so without the call they count as a hitch and a late frame.
    FlightRenderer.prototype.discardNextFrameInterval.call(target as unknown as FlightRenderer);
    capture.call(target, 1_216.7, 0.1);
    expect(target.diagnosticIntervalDurations).toHaveLength(1);
    expect(target.diagnosticHitches.count).toBe(0);
    expect(target.frameIntervalDurations).toHaveLength(1);
    // Only that one: the frame after it counts again.
    capture.call(target, 1_233.4, 1 / 60);
    expect(target.diagnosticIntervalDurations).toHaveLength(2);
    expect(target.frameIntervalDurations).toHaveLength(2);
  });
});
