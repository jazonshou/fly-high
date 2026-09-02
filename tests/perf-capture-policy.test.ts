import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import {
  PERF_CAPTURE_FRAME_BUDGET_MS,
  PERF_CAPTURE_MAX_FRAME_MS,
  PERF_CAPTURE_MAX_HITCHES,
  PERF_CAPTURE_MIN_WALL_CLOCK_FPS,
  deliveryFailuresAgainst,
  perfCaptureDeliveryContract,
  tier1BalancedPerformanceFailures,
} from "../scripts/perf-capture.mts";

// COMMENTS STRIPPED, and this is load-bearing rather than tidiness.
// `isDeliveryGated` locates an assertion by searching for its MESSAGE TEXT, so
// any docblock in the driver that quotes a gate's message becomes a second,
// earlier match — and the wrapper found before it belongs to an unrelated
// assertion. That is not hypothetical: a docblock added on 2026-09-02 quoted
// "terrain remained pending after the fixed final-pose drain" while explaining
// why a diagnostic mode skips it, and this guard immediately reported that gate
// as host-relaxed when nothing about it had changed.
const driver = readSource(
  new URL("./perf/perf-capture.test.ts", import.meta.url),
);
const packageJson = JSON.parse(
  readSource(new URL("../package.json", import.meta.url)),
) as { readonly scripts: Readonly<Record<string, string>> };
const rendererWorkflow = readFileSync(
  new URL("../.github/workflows/gpu-tests.yml", import.meta.url),
  "utf8",
);
const flightRenderer = readFileSync(
  new URL("../src/render/FlightRenderer.ts", import.meta.url),
  "utf8",
);

describe("perf-capture baseline policy", () => {
  it("has no command that writes or removes anything in the committed baseline directory", () => {
    const baselineMutations = [
      ...driver.matchAll(
        /commands\.(?:writeFile|removeFile)\([\s\S]{0,160}BASELINE_DIR/g,
      ),
    ];
    expect(baselineMutations).toEqual([]);
    expect(driver).not.toContain("shotReports.every");
  });

  it("keeps normal capture and candidate generation as separate commands", () => {
    expect(packageJson.scripts["perf:capture"]).not.toContain("VITE_PERF_REBASELINE");
    expect(packageJson.scripts["perf:capture:candidate"]).toContain(
      "VITE_PERF_REBASELINE=1",
    );
    expect(packageJson.scripts["perf:capture:rebaseline"]).toBe(
      "npm run perf:capture:candidate",
    );
  });

  it("requires compatible committed images in normal mode and a full candidate set", () => {
    expect(driver).toContain("missing or unreadable");
    expect(driver).toContain("the shot requires");
    expect(driver).toContain("!REBASELINE,");
    expect(driver).toContain("VITE_PERF_SHOTS and VITE_PERF_REBASELINE are mutually exclusive");
    expect(driver).toContain(
      "A rebaseline candidate requires the exact full canonical shot set in canonical order",
    );
    expect(driver).toContain("candidateScreenshots.map(({ name }) => name)");
  });

  it("leaves the WebGPU backing-store size under Babylon's hardware-scale ownership", () => {
    // Directly assigning the CSS viewport to canvas.width/height after the
    // engine creates its scaled attachments can resize the swapchain colour
    // target without rebuilding the depth target. That invalidates every
    // subsequent render pass at medium's non-unit render scale.
    expect(driver).not.toContain("canvas.width = viewportWidth");
    expect(driver).not.toContain("canvas.height = viewportHeight");
    expect(driver).toContain("canvas.style.width = `${viewportWidth}px`");
    expect(driver).toContain("canvas.style.height = `${viewportHeight}px`");
    expect(driver).toContain("renderer.getCaptureRenderSize()");
    expect(driver).toContain("renderer.setPinnedRenderScaleForCapture(captureRenderScale)");
    expect(driver).toContain("devicePixelRatio: window.devicePixelRatio || 1");
    expect(driver).toContain("adapter: renderer.getDiagnostics().adapter");
  });

  it("labels timestamp-query observer state and resolved sample coverage", () => {
    // Normal/CI matches shipping's observer-free path. Explicit `=1` exists
    // only for controlled diagnostic captures.
    expect(driver).toContain('import.meta.env.VITE_PERF_GPU_TIMING === "1"');
    expect(driver).toContain("captureGpuTiming: GPU_TIMING_ENABLED");
    expect(driver).toContain("renderer.getGpuTimingStatusForCapture()");
    expect(driver).toContain("gpuTimingEnabled:");
  });

  /**
   * Frames BEFORE the gates; approval AFTER them.
   *
   * This test used to require the opposite — that no candidate byte was written
   * until every validation had passed — on the reasoning that a failed run must
   * not leave something mistakable for an approved baseline. That reasoning is
   * still right, but the implementation had a serious cost that Gate F made
   * concrete: the first failing gate threw, and the run produced **no images at
   * all**. The instrument withheld its evidence at exactly the moment something
   * was wrong, and "go and look at the frames" required silencing the gate
   * first. A capture's frames are diagnostic input, not a reward for passing.
   *
   * The safety property is now carried explicitly by `STATUS.txt` instead of
   * implicitly by the absence of files: the directory is stamped NOT APPROVABLE
   * when the frames are written and restamped only after every gate has passed.
   * Both halves are pinned here.
   */
  it("writes candidate frames before the gates and approves them only after", () => {
    const strictGate = driver.indexOf("deliveryFailuresAgainst(DELIVERY, {");
    const imageContentGate = driver.indexOf("perfCaptureImageContentFailures(shot.tiles");
    const gpuErrorGate = driver.indexOf(
      "WebGPU reported uncaptured errors during the capture",
    );
    const rendererErrorGate = driver.indexOf("Babylon logged errors during the capture");
    const candidateWrite = driver.indexOf("`${candidateDir}/${screenshot.name}.png`");
    const notApprovable = driver.indexOf("NOT APPROVABLE —");
    const approved = driver.indexOf("APPROVABLE — every capture gate passed");
    expect(strictGate).toBeGreaterThan(-1);
    expect(imageContentGate).toBeGreaterThan(-1);
    expect(gpuErrorGate).toBeGreaterThan(-1);
    expect(rendererErrorGate).toBeGreaterThan(-1);
    expect(candidateWrite).toBeGreaterThan(-1);
    expect(notApprovable, "the candidate is never stamped unapprovable").toBeGreaterThan(-1);
    expect(approved, "no gate-passed stamp is ever written").toBeGreaterThan(-1);

    // The evidence lands first, so a failing run is diagnosable from its frames.
    expect(candidateWrite).toBeLessThan(strictGate);
    expect(candidateWrite).toBeLessThan(imageContentGate);
    expect(candidateWrite).toBeLessThan(gpuErrorGate);
    expect(candidateWrite).toBeLessThan(rendererErrorGate);
    // ...carrying the warning with it, written in the same breath.
    expect(notApprovable).toBeGreaterThan(candidateWrite);
    expect(notApprovable).toBeLessThan(strictGate);

    // Approval is the LAST thing, after every gate — this is the half that
    // keeps a failed run's candidate from looking promotable.
    expect(approved).toBeGreaterThan(strictGate);
    expect(approved).toBeGreaterThan(imageContentGate);
    expect(approved).toBeGreaterThan(gpuErrorGate);
    expect(approved).toBeGreaterThan(rendererErrorGate);
  });

  it("observes the device error channel for the whole rendered shot lifetime", () => {
    const cleanupStart = driver.indexOf("afterAll(() => {");
    const cleanupEnd = driver.indexOf("  });", cleanupStart);
    const listenerInstall = driver.indexOf(
      "renderer.addGpuUncapturedErrorListenerForCapture(",
    );
    const firstShotRender = driver.indexOf("for (const shot of SELECTED_SHOTS)");
    const queueDrain = driver.indexOf("await renderer.waitForGpuIdleForCapture();", firstShotRender);
    const gpuErrorGate = driver.indexOf(
      "WebGPU reported uncaptured errors during the capture",
    );
    const listenerCleanup = driver.indexOf("removeGpuUncapturedErrorListener?.();");

    expect(listenerInstall).toBeGreaterThan(-1);
    expect(listenerInstall).toBeLessThan(firstShotRender);
    expect(queueDrain).toBeGreaterThan(firstShotRender);
    expect(queueDrain).toBeLessThan(gpuErrorGate);
    expect(listenerCleanup).toBeGreaterThan(cleanupStart);
    expect(listenerCleanup).toBeLessThan(cleanupEnd);
    expect(driver).toContain("serializeGpuUncapturedError(event)");
    expect(flightRenderer).toContain('device.addEventListener("uncapturederror", listener)');
    expect(flightRenderer).toContain('device.removeEventListener("uncapturederror", listener)');
  });

  it("does not declare a shot stable while detail presentation is backlogged", () => {
    const settleGate = driver.indexOf("diagnostics.pendingDetailWork === 0");
    const shotReport = driver.indexOf("pendingDetailWork: sceneDiagnostics.pendingDetailWork");
    const publicationGate = driver.indexOf(
      "detail generation/presentation was still pending at capture",
    );
    // The candidate's FRAMES are now written before the gates so a failing run
    // is still diagnosable; its APPROVAL is what must follow the publication
    // gate, and that is the ordering this test cares about.
    const approved = driver.indexOf("APPROVABLE — every capture gate passed");
    expect(settleGate).toBeGreaterThan(-1);
    expect(shotReport).toBeGreaterThan(settleGate);
    expect(publicationGate).toBeGreaterThan(shotReport);
    expect(approved).toBeGreaterThan(publicationGate);
  });

  it("drains motion-created streaming work at the fixed final pose before readback", () => {
    const temporalLoop = driver.indexOf(
      "for (let frame = 0; frame < PERF_CAPTURE_TEMPORAL_FRAMES",
    );
    const postMotionDrain = driver.indexOf("const maxPostMotionDrainFrames = 600", temporalLoop);
    // ANCHORED ON CODE, NOT ON A COMMENT. This read used to locate the readback
    // by the comment above it — "// Final frame and readback must share one
    // task" — which made the guard depend on prose surviving verbatim, and it
    // returned -1 the moment the driver was read with comments stripped. The
    // `resolvePresentedFrame()` call immediately after it is the actual landmark
    // and cannot be edited away without changing behaviour.
    const finalReadback = driver.indexOf("resolvePresentedFrame();", postMotionDrain);
    const drainBody = driver.slice(postMotionDrain, finalReadback);

    expect(temporalLoop).toBeGreaterThan(-1);
    expect(postMotionDrain).toBeGreaterThan(temporalLoop);
    expect(finalReadback).toBeGreaterThan(postMotionDrain);
    expect(drainBody).toContain("await nextAnimationFrame()");
    expect(drainBody).toContain("renderer.render(lastFrameState, 1 / 60)");
    expect(drainBody).toContain("drainDiagnostics.pendingTerrainPages === 0");
    expect(drainBody).toContain("drainDiagnostics.pendingDetailWork === 0");
    expect(drainBody).toContain("requiredStableDrainFrames = 30");
    expect(drainBody).toContain("await renderer.waitForGpuIdleForCapture()");
    expect(drainBody).toContain("finalDrainDiagnostics.pendingTerrainPages");
    expect(drainBody).toContain("finalDrainDiagnostics.pendingDetailWork");
    expect(drainBody).toContain("toBeGreaterThanOrEqual(requiredStableDrainFrames)");
    expect(drainBody).not.toContain("advanceFrameState()");
    expect(drainBody).not.toContain("break;");
    expect(drainBody).not.toContain("simulationTime +=");
  });

  it("enforces frame delivery only on the pinned reference adapter", () => {
    // A hosted runner renders the same pixels as the reference machine and
    // delivers them roughly three times slower, so gating it against the
    // tier-1 contract measures the runner rather than the diff. The split is
    // load-bearing in one direction only: a shrinking set of ENFORCED gates
    // is how this file stops being a regression instrument, so name both
    // halves here and let a future edit that moves a gate across the line
    // fail loudly.
    expect(driver).toContain('import.meta.env.VITE_PERF_UNPINNED_HOST === "1"');
    expect(driver).toContain(
      "VITE_PERF_UNPINNED_HOST and VITE_PERF_REBASELINE are mutually exclusive",
    );
    // The local commands stay strict; only the workflow declares its host.
    expect(packageJson.scripts["perf:capture"]).not.toContain("VITE_PERF_UNPINNED_HOST");
    expect(packageJson.scripts["perf:capture:ci"]).not.toContain("VITE_PERF_UNPINNED_HOST");
    expect(rendererWorkflow).toContain('VITE_PERF_UNPINNED_HOST: "1"');

    // Gate 0-d (Phase 6): the PR subset must cover the water surfaces the
    // phase's Wave-1 work touches — without these, every water PR merges with
    // no pixel gate on the surfaces it changes. Remove only at phase close,
    // by recorded decision (PHASE_6_EXECUTION_PLAN.md §3).
    for (const shot of ["water-3m", "water-25ft", "coast-10km-lowsun"]) {
      expect(packageJson.scripts["perf:capture:ci"]).toContain(shot);
    }

    /** True when this assertion's failure is downgraded on an unpinned host. */
    const isDeliveryGated = (message: string): boolean => {
      const index = driver.indexOf(message);
      expect(index, `${message} is no longer asserted by the driver`).toBeGreaterThan(-1);
      const assertion = driver.lastIndexOf("expect(", index);
      return driver
        .slice(Math.max(0, assertion - "gateDelivery(() => ".length), assertion)
        .includes("gateDelivery(() => ");
    };

    // Host-dependent: what the machine could deliver in the time it had.
    for (const message of [
      // 6-11.1 made this message tier-aware (`strict tier-${tier}
      // ${quality}/${mode} ...`), so the stable substring is the tail. The
      // gate itself is unchanged at tier 1 — asserted by the contract-agreement
      // test below.
      "frame-delivery gate failed",
      "measured fps fell below the committed floor",
      "more hitch frames than the committed ceiling",
      "worst frame exceeded the committed ceiling",
      "p999 frame exceeded the committed ceiling",
      // Gate 0-a (Phase 6): floors pinned at today's delivery levels.
      "wall-clock fps fell below the committed floor",
      "frame-interval p95 exceeded the committed ceiling",
      "more pages pending generation than the committed ceiling",
    ]) {
      expect(isDeliveryGated(message), `${message} must follow the host`).toBe(true);
    }

    // Host-independent: what was drawn, whether the renderer erred, and
    // whether the scene had settled. These gate on every adapter, always.
    for (const message of [
      "diverged from the committed baseline",
      "RGB/chroma diverged",
      "nearby terrain/foliage diverged",
      "a local visual regression was diluted",
      "screenshot is blank or lacks local visual structure",
      "renderPixels must match the medium/balanced scale pin",
      "WebGPU reported uncaptured errors during the capture",
      "The renderer logged console errors during the capture",
      "Babylon logged errors during the capture",
      "consecutive-frame SSIM fell below the committed floor",
      "frame-to-frame luminance jumped above the committed ceiling",
      "detail generation/presentation was still pending at capture",
      "terrain remained pending after the fixed final-pose drain",
      "detail remained pending after the fixed final-pose drain",
      "more resident page slots than the atlas holds",
      // Gate 0-a/0-c (Phase 6): draw counts and the memory inventory are
      // arithmetic over the frozen shipping profile, not host speed.
      "more draw calls than the committed ceiling",
      "inventoried GPU memory breached the pinned ceiling",
    ]) {
      expect(isDeliveryGated(message), `${message} must hold on every host`).toBe(false);
    }

    // Exactly the eight wrappers enumerated above; nothing else may be relaxed.
    expect([...driver.matchAll(/gateDelivery\(/g)]).toHaveLength(8);

    // THE SECOND WRAPPER, and the invariant that makes it safe to have two.
    //
    // `gateAlways` exists because `gateDelivery` bundles two properties —
    // non-aborting AND host-conditional — and every gate outside the eight
    // above wants only the first. A conversion that reached for `gateDelivery`
    // to stop a gate masking the ones behind it would ALSO have made the
    // draw-call ceiling and the inventoried-memory check waivable on an
    // unpinned host. That was caught here rather than in a capture.
    //
    // The COUNT is not the invariant — it moves whenever a gate is added. What
    // must never change is that `gateAlways` does not consult `UNPINNED_HOST`:
    // the moment it does, the two wrappers collapse into one and the list above
    // stops meaning anything.
    const gateAlwaysBody = driver.slice(
      driver.indexOf("const gateAlways ="),
      driver.indexOf("};", driver.indexOf("const gateAlways =")),
    );
    expect(
      gateAlwaysBody,
      "gateAlways is defined but the driver no longer uses it — either the "
      + "wrapper was removed or its gates were moved onto gateDelivery, which "
      + "would relax them",
    ).not.toHaveLength(0);
    expect(
      gateAlwaysBody.includes("UNPINNED_HOST"),
      "gateAlways must NOT consult UNPINNED_HOST — it is the always-enforced "
      + "wrapper, and reading the host flag would silently relax every gate "
      + "that uses it, which is the whole distinction from gateDelivery",
    ).toBe(false);
    expect(
      [...driver.matchAll(/gateAlways\(\(\) =>/g)].length,
      "no gate uses gateAlways — the non-aborting, always-enforced path is "
      + "unused, so either masking has returned or the gates were relaxed",
    ).toBeGreaterThan(0);
  });

  it("keeps GPU and non-mutating perf gates wired to automatic CI with artifacts", () => {
    expect(rendererWorkflow).toContain("pull_request:");
    expect(rendererWorkflow).toContain("npm run test:gpu");
    expect(rendererWorkflow).toContain("npm run perf:capture:ci");
    expect(rendererWorkflow).toContain("git diff --exit-code -- tests/perf/baseline");
    expect(rendererWorkflow).toContain("actions/upload-artifact@v4");
  });

  /**
   * `6-11.1`: the sweep's generalised contract must not become a SECOND,
   * quietly different definition of "delivered".
   *
   * `deliveryFailuresAgainst` exists so a tier-3 run is judged at 30 fps
   * instead of being failed for not being tier 1. The risk it introduces is
   * drift: two functions that both claim to express the delivery contract, one
   * of which is configurable. This pins them together at tier 1 — the shipping
   * tier, whose constants `docs/PERFORMANCE.md` quotes — so any future edit to
   * either that changes a tier-1 verdict fails here.
   */
  it("agrees with the standing tier-1 gate on every tier-1 verdict", () => {
    const tier1 = perfCaptureDeliveryContract(1);
    expect(tier1.minWallClockFps).toBe(PERF_CAPTURE_MIN_WALL_CLOCK_FPS);
    expect(tier1.frameBudgetMs).toBe(PERF_CAPTURE_FRAME_BUDGET_MS);
    expect(tier1.maxFrameMs).toBe(PERF_CAPTURE_MAX_FRAME_MS);
    expect(tier1.maxHitches).toBe(PERF_CAPTURE_MAX_HITCHES);
    // Tiers 0 and 2 share tier 1's 13.7 ms internal target, so they share its
    // delivery contract; only tier 3 (30 ms target) may differ.
    expect(perfCaptureDeliveryContract(0)).toEqual(tier1);
    expect(perfCaptureDeliveryContract(2)).toEqual(tier1);
    expect(perfCaptureDeliveryContract(3).minWallClockFps).toBe(30);

    const samples = [
      { wallClockFps: 120, frameIntervalMsP95: 9.2, framesOver27_4Ms: 0, maxFrameMs: 12 },
      { wallClockFps: 59.9, frameIntervalMsP95: 9.2, framesOver27_4Ms: 0, maxFrameMs: 12 },
      { wallClockFps: 60, frameIntervalMsP95: 16.68, framesOver27_4Ms: 0, maxFrameMs: 12 },
      { wallClockFps: 60, frameIntervalMsP95: 16.67, framesOver27_4Ms: 6, maxFrameMs: 12 },
      { wallClockFps: 60, frameIntervalMsP95: 16.67, framesOver27_4Ms: 5, maxFrameMs: 50.1 },
      { wallClockFps: Number.NaN, frameIntervalMsP95: 9, framesOver27_4Ms: 0, maxFrameMs: 12 },
    ];
    let sawFailure = false;
    for (const sample of samples) {
      const standing = tier1BalancedPerformanceFailures(sample);
      const swept = deliveryFailuresAgainst(tier1, sample);
      expect(swept, `tier-1 verdict diverged for ${JSON.stringify(sample)}`).toEqual(standing);
      if (standing.length > 0) sawFailure = true;
    }
    // Non-vacuity: agreeing on six passes would prove nothing.
    expect(sawFailure, "no sample exercised a failing verdict").toBe(true);

    // A tier-3 sample that tier 1 rejects must be ACCEPTED at tier 3 — the
    // whole reason the table exists.
    const ultra = { wallClockFps: 31, frameIntervalMsP95: 32, framesOver27_4Ms: 0, maxFrameMs: 60 };
    expect(tier1BalancedPerformanceFailures(ultra).length).toBeGreaterThan(0);
    expect(deliveryFailuresAgainst(perfCaptureDeliveryContract(3), ultra)).toEqual([]);
  });
});
