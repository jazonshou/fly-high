import { describe, expect, it } from "vitest";
import {
  applyHardwareScalingLevel,
  DISPLAY_RESIZE_REQUEST,
  GOVERNED_SCALE_REQUEST,
  mergeRenderScaleRequests,
  RenderScaleQueue,
  resolveHardwareScalingLevel,
  scalingLevelChanged,
  type HardwareScalingEngine,
  type HardwareScalingInputs,
} from "../src/render/renderScaleLevel";
import { readSource } from "./support/sourceText";

/** FlightRenderer.applyRenderScale's arithmetic as it stood at 19543c0. */
function inlineLevelAt19543c0(inputs: HardwareScalingInputs): number {
  const pixelRatio = Math.min(
    inputs.maxDevicePixelRatio,
    inputs.devicePixelRatio || 1,
  );
  const requestedScale = Math.max(0.1, pixelRatio * inputs.renderScale);
  const cssPixels = Math.max(
    1,
    inputs.cssWidth * inputs.cssHeight,
  );
  const pixelCapScale = Math.sqrt(inputs.maxRenderPixels / cssPixels);
  return 1 / Math.min(requestedScale, pixelCapScale);
}

/** Records every engine call, with the frame boundaries, in order. */
class FakeEngine implements HardwareScalingEngine {
  readonly calls: string[] = [];

  constructor(public level = 1) {}

  getHardwareScalingLevel(): number {
    return this.level;
  }

  setHardwareScalingLevel(level: number): void {
    this.level = level;
    this.calls.push(`set ${level}`);
  }

  resize(forceSetSize = false): void {
    this.calls.push(forceSetSize ? "resize forced" : "resize");
  }

  beginFrame(): void {
    this.calls.push("beginFrame");
  }

  endFrame(): void {
    this.calls.push("endFrame");
  }
}

// Medium on a 14" MacBook Pro: Retina, and the 2.4 Mpx cap binds.
const RETINA_MEDIUM = {
  maxDevicePixelRatio: 2,
  devicePixelRatio: 2,
  cssWidth: 1512,
  cssHeight: 982,
  maxRenderPixels: 2_400_000,
};

/** A renderer stand-in with FlightRenderer.render's order (asserted below). */
function rig(initialScale: number, display = RETINA_MEDIUM) {
  const view = { renderScale: initialScale, ...display };
  const level = () => resolveHardwareScalingLevel(view);
  const engine = new FakeEngine();
  const queue = new RenderScaleQueue(engine, level);
  queue.applyNow();
  engine.calls.length = 0;
  const applied: ReturnType<RenderScaleQueue["applyPending"]>[] = [];
  /** One frame; `governor` runs where updateGovernor does, after endFrame. */
  const frame = (governor?: () => void): void => {
    applied.push(queue.applyPending());
    engine.beginFrame();
    engine.endFrame();
    governor?.();
  };
  /** updateGovernor's half: queue a step only when it moves the level. */
  const governorStep = (scale: number) => (): boolean => {
    view.renderScale = scale;
    const changed = queue.levelWouldChange();
    if (changed) queue.defer(GOVERNED_SCALE_REQUEST);
    return changed;
  };
  return { view, engine, queue, frame, governorStep, applied };
}

describe("hardware scaling level (B1)", () => {
  it("equals the inline arithmetic it replaced, bit for bit", () => {
    let cases = 0;
    for (const devicePixelRatio of [0, 1, 1.25, 2, 3]) {
      for (const maxDevicePixelRatio of [1, 1.5, 2]) {
        for (const [cssWidth, cssHeight] of [
          [0, 0], [1, 1], [390, 844], [1280, 720], [1512, 982], [1920, 1080], [3840, 2160],
        ] as const) {
          for (const maxRenderPixels of [1_000_000, 1_500_000, 2_400_000, 4_000_000]) {
            for (const renderScale of [0.05, 0.5, 0.75, 0.8, 0.85, 0.9, 1, 1.1]) {
              const inputs = {
                maxDevicePixelRatio,
                devicePixelRatio,
                renderScale,
                cssWidth,
                cssHeight,
                maxRenderPixels,
              };
              expect(Object.is(
                resolveHardwareScalingLevel(inputs),
                inlineLevelAt19543c0(inputs),
              )).toBe(true);
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(5 * 3 * 7 * 4 * 8);
  });

  it("treats a level within 1e-4 of the applied one as unchanged", () => {
    expect(scalingLevelChanged(0.5, 0.5)).toBe(false);
    expect(scalingLevelChanged(0.5 + 1e-4, 0.5)).toBe(false);
    expect(scalingLevelChanged(0.5 - 1e-4, 0.5)).toBe(false);
    expect(scalingLevelChanged(0.5 + 1.01e-4, 0.5)).toBe(true);
    expect(scalingLevelChanged(0.5 - 1.01e-4, 0.5)).toBe(true);
  });

  it("resizes only on a changed level or a forced request", () => {
    const run = (current: number, level: number, force: boolean) => {
      const engine = new FakeEngine(current);
      const changed = applyHardwareScalingLevel(engine, level, force);
      return { changed, calls: engine.calls };
    };
    expect(run(0.5, 0.5, false)).toEqual({ changed: false, calls: [] });
    expect(run(0.5, 0.5, true)).toEqual({ changed: false, calls: ["resize forced"] });
    expect(run(0.5, 0.6, false)).toEqual({ changed: true, calls: ["set 0.6", "resize"] });
    expect(run(0.5, 0.6, true)).toEqual({ changed: true, calls: ["set 0.6", "resize forced"] });
  });

  it("makes no engine call at all for a governor step the pixel cap absorbs", () => {
    const { engine, frame, governorStep, applied } = rig(1);
    const levelBefore = engine.level;
    let changed: boolean | undefined;
    frame(() => {
      changed = governorStep(0.9)();
    });
    frame();
    frame();
    expect(changed).toBe(false);
    expect(engine.level).toBe(levelBefore);
    expect(engine.calls).toEqual([
      "beginFrame", "endFrame",
      "beginFrame", "endFrame",
      "beginFrame", "endFrame",
    ]);
    expect(applied).toEqual([null, null, null]);
  });

  it("applies a real step before the NEXT frame's beginFrame, never after endFrame", () => {
    // 1080p at DPR 1: the cap does not bind, so 0.9 moves the level.
    const { engine, frame, governorStep, applied } = rig(1, {
      ...RETINA_MEDIUM,
      devicePixelRatio: 1,
      cssWidth: 1920,
      cssHeight: 1080,
    });
    let changed: boolean | undefined;
    frame(() => {
      changed = governorStep(0.9)();
    });
    expect(changed).toBe(true);
    // The decision frame drew and was left alone.
    expect(engine.calls).toEqual(["beginFrame", "endFrame"]);
    frame();
    expect(engine.calls).toEqual([
      "beginFrame", "endFrame",
      `set ${1 / 0.9}`, "resize", "beginFrame", "endFrame",
    ]);
    expect(applied[1]).toEqual({
      force: false,
      resetTimingWindow: false,
      reason: "dynamic resolution changed",
      changed: true,
    });
  });

  it("keeps a pending request through skipped frames", () => {
    const { engine, queue, frame, governorStep } = rig(1, {
      ...RETINA_MEDIUM,
      devicePixelRatio: 1,
      cssWidth: 1920,
      cssHeight: 1080,
    });
    frame(() => {
      governorStep(0.85)();
    });
    // No render for a while (a hidden tab, a thrown frame): nothing applies.
    expect(queue.hasPending).toBe(true);
    expect(engine.calls).toEqual(["beginFrame", "endFrame"]);
    frame();
    expect(queue.hasPending).toBe(false);
    expect(engine.calls.slice(2)).toEqual([
      `set ${1 / 0.85}`, "resize", "beginFrame", "endFrame",
    ]);
  });

  it("resolves the level when it applies, from the scale current then", () => {
    const { view, engine, queue, frame } = rig(1, {
      ...RETINA_MEDIUM,
      devicePixelRatio: 1,
      cssWidth: 1920,
      cssHeight: 1080,
    });
    view.renderScale = 0.9;
    queue.defer(GOVERNED_SCALE_REQUEST);
    view.renderScale = 0.8;
    frame();
    expect(engine.calls).toEqual([`set ${1 / 0.8}`, "resize", "beginFrame", "endFrame"]);
  });

  it("forces a display resize at the next frame even at an unchanged level", () => {
    const { engine, queue, frame, applied } = rig(1);
    queue.defer(DISPLAY_RESIZE_REQUEST);
    expect(engine.calls).toEqual([]);
    frame();
    expect(engine.calls).toEqual(["resize forced", "beginFrame", "endFrame"]);
    expect(applied[0]).toEqual({
      force: true,
      resetTimingWindow: true,
      reason: "display resize",
      changed: false,
    });
  });

  it("merges a governor step and a display resize into one forced apply", () => {
    expect(mergeRenderScaleRequests(null, GOVERNED_SCALE_REQUEST)).toBe(GOVERNED_SCALE_REQUEST);
    for (const merged of [
      mergeRenderScaleRequests(GOVERNED_SCALE_REQUEST, DISPLAY_RESIZE_REQUEST),
      mergeRenderScaleRequests(DISPLAY_RESIZE_REQUEST, GOVERNED_SCALE_REQUEST),
    ]) {
      expect(merged).toEqual(DISPLAY_RESIZE_REQUEST);
    }
    expect(mergeRenderScaleRequests(GOVERNED_SCALE_REQUEST, GOVERNED_SCALE_REQUEST))
      .toEqual(GOVERNED_SCALE_REQUEST);
  });

  it("applies construction, profile and capture-pin changes immediately and forced", () => {
    const { view, engine, queue } = rig(1);
    // Unchanged level: still resized, as every one of these paths always was.
    expect(queue.applyNow()).toBe(false);
    expect(engine.calls).toEqual(["resize forced"]);
    view.devicePixelRatio = 1;
    view.cssWidth = 1920;
    view.cssHeight = 1080;
    view.renderScale = 0.8;
    expect(queue.applyNow()).toBe(true);
    expect(engine.calls).toEqual(["resize forced", `set ${1 / 0.8}`, "resize forced"]);
    expect(queue.hasPending).toBe(false);
  });
});

describe("FlightRenderer applies scale changes at frame start (B1)", () => {
  const source = readSource(new URL("../src/render/FlightRenderer.ts", import.meta.url));
  const method = (signature: RegExp, next: RegExp): string => {
    const start = source.search(signature);
    expect(start).toBeGreaterThan(0);
    const rest = source.slice(start);
    const end = rest.slice(1).search(next);
    expect(end).toBeGreaterThan(0);
    return rest.slice(0, end + 1);
  };

  it("applies a pending request in render() before beginFrame", () => {
    const render = method(/\n {2}render\(state: FlightVisualState/u, /\n {2}(?:private |\/\*\*)/u);
    const apply = render.indexOf("this.applyPendingRenderScale();");
    expect(apply).toBeGreaterThan(0);
    expect(apply).toBeLessThan(render.indexOf("this.engine.beginFrame();"));
    expect(apply).toBeLessThan(render.indexOf("this.captureFrameInterval(started, deltaSeconds);"));
    expect(render.indexOf("this.updateGovernor();"))
      .toBeGreaterThan(render.indexOf("this.engine.endFrame();"));
  });

  it("never resizes from the governor, which runs after endFrame", () => {
    const governor = method(/\n {2}private updateGovernor\(\): void/u, /\n {2}(?:private |\/\*\*)/u);
    expect(governor).toContain("this.deferGovernedRenderScale()");
    expect(governor).not.toContain("applyRenderScale");
    expect(governor).not.toContain("resize(");
    expect(source).not.toMatch(/\bengine\.resize\(/u);
  });

  it("defers an unpinned display resize and keeps the pinned one immediate", () => {
    const observer = source.match(/new ResizeObserver\(\(\) => \{[\s\S]*?\n {4}\}\);/u)?.[0] ?? "";
    expect(observer).toMatch(
      /if \(this\.pinnedRenderScale === null\) \{\s*this\.renderScaleQueue\.defer\(DISPLAY_RESIZE_REQUEST\);\s*return;\s*\}\s*this\.applyRenderScale\(\);\s*this\.resetTimingWindow\(\);\s*this\.graph\.invalidateHistory\("display resize"\);/u,
    );
  });

  it("keeps construction, profile changes and the capture pin forced and immediate", () => {
    const applyRenderScale = method(/\n {2}private applyRenderScale\(\): boolean/u, /\n {2}(?:private |\/\*\*)/u);
    expect(applyRenderScale).toMatch(
      /const changed = this\.renderScaleQueue\.applyNow\(\);\s*this\.appliedRenderScale = this\.renderScale;\s*return changed;/u,
    );
    const constructor = method(/\n {2}private constructor\(/u, /\n {2}private readonly handleDebugKey/u);
    expect(constructor.indexOf("this.renderScaleQueue = new RenderScaleQueue("))
      .toBeLessThan(constructor.indexOf("this.applyRenderScale();"));
    const capturePin = method(/\n {2}setPinnedRenderScaleForCapture\(/u, /\n {2}\}\n/u);
    expect(capturePin).toContain("this.applyRenderScale();");
    const applyProfile = method(/\n {2}private applyProfile\(\): void/u, /\n {2}\}\n/u);
    expect(applyProfile).toContain("this.applyRenderScale();");
    expect(source.match(/this\.applyRenderScale\(\);/gu)).toHaveLength(4);
  });

  it("reports the applied scale, so a snapshot pairs it with the pixels rendered", () => {
    const diagnostics = method(/\n {2}getDiagnostics\(\): RenderDiagnostics/u, /\n {2}(?:private |\/\*\*)/u);
    expect(diagnostics).toContain("renderScale: this.appliedRenderScale,");
    expect(diagnostics).toContain("renderPixels: this.engine.getRenderWidth() * this.engine.getRenderHeight(),");
    const applyPending = method(/\n {2}private applyPendingRenderScale\(\): void/u, /\n {2}(?:private |\/\*\*)/u);
    expect(applyPending).toMatch(
      /if \(applied === null\) return;\s*this\.appliedRenderScale = this\.renderScale;/u,
    );
    // A governor step the pixel cap absorbs is applied as it is decided; one
    // that moves the level is applied at the next frame's start.
    const deferGoverned = method(/\n {2}private deferGovernedRenderScale\(\): boolean/u, /\n {2}(?:private |\/\*\*)/u);
    expect(deferGoverned).toMatch(
      /if \(changed\) \{\s*this\.renderScaleQueue\.defer\(GOVERNED_SCALE_REQUEST\);\s*\} else \{\s*this\.appliedRenderScale = this\.renderScale;\s*\}/u,
    );
    // Those two and applyRenderScale are the only writers.
    expect(source.match(/this\.appliedRenderScale = /gu)).toHaveLength(3);
  });
});
