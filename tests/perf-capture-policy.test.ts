import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const driver = readFileSync(
  new URL("./perf/perf-capture.test.ts", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
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

  it("writes a candidate only after strict and renderer-error validations", () => {
    const strictGate = driver.indexOf("tier1BalancedPerformanceFailures({");
    const imageContentGate = driver.indexOf("perfCaptureImageContentFailures(shot.tiles");
    const gpuErrorGate = driver.indexOf(
      "WebGPU reported uncaptured errors during the capture",
    );
    const rendererErrorGate = driver.indexOf("Babylon logged errors during the capture");
    const candidateWrite = driver.indexOf("`${candidateDir}/${screenshot.name}.png`");
    expect(strictGate).toBeGreaterThan(-1);
    expect(imageContentGate).toBeGreaterThan(-1);
    expect(gpuErrorGate).toBeGreaterThan(-1);
    expect(rendererErrorGate).toBeGreaterThan(-1);
    expect(candidateWrite).toBeGreaterThan(strictGate);
    expect(candidateWrite).toBeGreaterThan(imageContentGate);
    expect(candidateWrite).toBeGreaterThan(gpuErrorGate);
    expect(candidateWrite).toBeGreaterThan(rendererErrorGate);
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
    const candidateWrite = driver.indexOf("`${candidateDir}/${screenshot.name}.png`");
    expect(settleGate).toBeGreaterThan(-1);
    expect(shotReport).toBeGreaterThan(settleGate);
    expect(publicationGate).toBeGreaterThan(shotReport);
    expect(candidateWrite).toBeGreaterThan(publicationGate);
  });

  it("drains motion-created streaming work at the fixed final pose before readback", () => {
    const temporalLoop = driver.indexOf(
      "for (let frame = 0; frame < PERF_CAPTURE_TEMPORAL_FRAMES",
    );
    const postMotionDrain = driver.indexOf("const maxPostMotionDrainFrames = 600", temporalLoop);
    const finalReadback = driver.indexOf("// Final frame and readback must share one task");
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
      "strict tier-1 medium/balanced frame-delivery gate failed",
      "measured fps fell below the committed floor",
      "more hitch frames than the committed ceiling",
      "worst frame exceeded the committed ceiling",
      "p999 frame exceeded the committed ceiling",
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
    ]) {
      expect(isDeliveryGated(message), `${message} must hold on every host`).toBe(false);
    }

    // Exactly the six wrappers enumerated above; nothing else may be relaxed.
    expect([...driver.matchAll(/gateDelivery\(/g)]).toHaveLength(6);
  });

  it("keeps GPU and non-mutating perf gates wired to automatic CI with artifacts", () => {
    expect(rendererWorkflow).toContain("pull_request:");
    expect(rendererWorkflow).toContain("npm run test:gpu");
    expect(rendererWorkflow).toContain("npm run perf:capture:ci");
    expect(rendererWorkflow).toContain("git diff --exit-code -- tests/perf/baseline");
    expect(rendererWorkflow).toContain("actions/upload-artifact@v4");
  });
});
