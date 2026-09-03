/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { Logger } from "@babylonjs/core/Misc/logger";
import {
  FlightRenderer,
  beginRendererStartupTrace,
  endRendererStartupTrace,
  readRendererStartupTrace,
} from "../../src/render/FlightRenderer";
import { INITIAL_VISUAL_STATE } from "../../src/game/types";
import { createWorld, sampleTerrain } from "../../src/world";
import {
  luminanceFromRgba,
  lowerOuterHorizontalDetailFraction,
  PERF_CAPTURE_SEED,
  perfCaptureImageContentFailures,
  tileStatistics,
} from "../../scripts/perf-capture.mts";
import { ANALYTIC_COLD_START_DEADLINE_MS } from "../../scripts/deliveryFloors.mts";
import {
  coldStartFrameCompletenessFailures,
  drainFenceAndErrorDeliveryTurn,
  settleWithin,
} from "../../scripts/coldStartHarness.mts";

/**
 * `6-11.3` — cold time-to-ready, measured from zero.
 *
 * Nothing in this project measured startup before this file. `perf:capture`
 * cannot: it boots one renderer and then holds it for the whole shot list, so
 * its numbers describe a warm steady state and say nothing about the first
 * seconds a player actually meets. Every startup regression to date was found
 * by someone noticing a load felt slow.
 *
 * **This fails on TIMEOUT or CONSOLE ERROR — both halves, deliberately.** The
 * failure class it guards (`4.5-0`'s poisoned depth-defines crash) hung with
 * *no* error at all, so an error-only check would have watched it hang forever
 * and reported nothing; and the eroded Gate F failure logged nothing while
 * taking 90 s, so a timeout-only check would have called that healthy right up
 * until it crossed. Neither half is redundant.
 *
 * The analytic-default deadline is derived from the retained reference-host
 * samples in `scripts/deliveryFloors.mts`: paired create + completed-frame times,
 * median + 25% startup headroom, rounded to 50 ms. It is independent of W-1's
 * parked eroded-world 1.5 s target. The loose ceiling below remains separate:
 * it catches a Promise that never settles and is not an acceptance budget.
 */

/**
 * Loose enough that only a hang trips it. A hang is the failure this must never
 * miss; the analytic acceptance deadline is the derived constant beside it.
 */
const COLD_START_HANG_CEILING_MS = 120_000;
/** Give device destruction one bounded turn to settle a timed-out raw queue fence. */
const COLD_START_TEARDOWN_DRAIN_MS = 1_000;
const ENFORCE_REFERENCE_HOST_DEADLINE = import.meta.env.VITE_PERF_UNPINNED_HOST !== "1";

/** What a cold start must produce to count as ready, not merely as returned. */
interface ColdStartResult {
  readonly createMs: number;
  readonly stages: readonly {
    readonly label: string;
    readonly kind: "sync" | "async";
    readonly milliseconds: number;
  }[];
  /** Render, synchronous readback, GPU fence, and one error-delivery task. */
  readonly completionMs: number;
  readonly readyMs: number;
  readonly consoleErrors: readonly string[];
  readonly rendererErrors: readonly string[];
  readonly frameCompletenessFailures: readonly string[];
  readonly foregroundDetailFraction: number;
  readonly terrainTiles: number;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("cold-start deadline expired"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onAbort = () => finish({ error: new Error("cold-start deadline expired") });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
  });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function measureColdStart(worldEvolution: "analytic" | "eroded"): Promise<ColdStartResult> {
  const consoleErrors: string[] = [];
  const rendererErrors: string[] = [];
  const originalConsoleError = console.error;
  const originalLoggerError = Logger.Error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((a) => String(a)).join(" "));
    originalConsoleError(...args);
  };
  Logger.Error = (message: string | string[]) => {
    consoleErrors.push(Array.isArray(message) ? message.join(" ") : String(message));
    originalLoggerError(message);
  };

  const canvas = document.createElement("canvas");
  canvas.style.width = "1280px";
  canvas.style.height = "720px";
  document.body.appendChild(canvas);

  const rendererOwner: { current: FlightRenderer | null } = { current: null };
  const abortController = new AbortController();
  let deadlineExpired = false;
  let submittedWorkFence: Promise<void> | null = null;
  const deadlineError = new Error(
    `cold start did not produce a readable completed frame within `
    + `${COLD_START_HANG_CEILING_MS} ms (world=${worldEvolution}). This is the HANG half `
    + "of the gate: the failure class it guards produces no console error at all.",
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const world = createWorld(PERF_CAPTURE_SEED, { worldEvolution });
    beginRendererStartupTrace();
    const startedAt = performance.now();
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        deadlineExpired = true;
        abortController.abort();
        reject(deadlineError);
      }, COLD_START_HANG_CEILING_MS);
    });

    // One operation owns creation, the first frame, its synchronous canvas
    // readback, the queue fence, and the asynchronous error-delivery task. A
    // deadline therefore cannot strand a late renderer beside the next test.
    const operation = (async (): Promise<ColdStartResult> => {
      const created = await FlightRenderer.create({
        canvas,
        aircraft: "trainer",
        terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
        world,
        seed: world.sourceSeedHash,
        quality: "medium",
        renderingMode: "balanced",
        reducedMotion: false,
        ...(world.airport ? { runway: world.airport } : {}),
        signal: abortController.signal,
        onDeviceLost: (reason) => rendererErrors.push(`device lost: ${reason}`),
        onGpuUncapturedError: (reason) => rendererErrors.push(`WebGPU: ${reason}`),
      });
      // A create path that ignores its AbortSignal can resolve after the
      // deadline branch has already returned and restored the global hooks.
      // It never transfers ownership in that case: dispose at this boundary.
      if (deadlineExpired) {
        created.dispose();
        throw deadlineError;
      }
      rendererOwner.current = created;
      const createMs = performance.now() - startedAt;
      const stages = readRendererStartupTrace().map((s) => ({ ...s }));

      // "Ready" is not "render() returned". Render and read the swapchain in
      // the same task (the browser may clear it after compositing), then wait
      // for all submitted GPU work and one event-loop task so asynchronous
      // validation/device errors belong to this run rather than the next one.
      const completionStartedAt = performance.now();
      created.render({
        ...INITIAL_VISUAL_STATE,
        simulationTime: 0,
      }, 1 / 60);
      const raster = created.getCaptureRenderSize();
      const copy = document.createElement("canvas");
      copy.width = 1_280;
      copy.height = 720;
      const context = copy.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new Error("Unable to create cold-start readback context");
      context.drawImage(
        canvas,
        0,
        0,
        raster.width,
        raster.height,
        0,
        0,
        copy.width,
        copy.height,
      );
      const rgba = context.getImageData(0, 0, copy.width, copy.height).data;
      submittedWorkFence = created.waitForGpuIdleForCapture();
      await abortable(submittedWorkFence, abortController.signal);
      await abortable(nextTask(), abortController.signal);
      if (deadlineExpired) throw deadlineError;
      const completionMs = performance.now() - completionStartedAt;
      const readyMs = performance.now() - startedAt;
      // Pixel classification proves the timed readback was meaningful, but is
      // test-side analysis rather than renderer readiness and stays outside
      // the measured interval.
      const luminance = luminanceFromRgba(rgba, copy.width, copy.height);
      const imageContentFailures = perfCaptureImageContentFailures(
        tileStatistics(luminance, copy.width, copy.height),
      );
      const foregroundDetailFraction = lowerOuterHorizontalDetailFraction(
        luminance,
        copy.width,
        copy.height,
      );
      // Existing renderer truth, sampled after the completed frame: unlike a
      // colour/edge heuristic this distinguishes the intended terrain scene
      // from a structured cloud layer that happens to satisfy the pixel gates.
      const terrainTiles = created.getDiagnostics().terrainTiles;
      const frameCompletenessFailures = coldStartFrameCompletenessFailures({
        imageContentFailures,
        foregroundDetailFraction,
        terrainTiles,
      });

      return {
        createMs,
        stages,
        completionMs,
        readyMs,
        consoleErrors: [...consoleErrors],
        rendererErrors: [...rendererErrors],
        frameCompletenessFailures,
        foregroundDetailFraction,
        terrainTiles,
      };
    })();
    // Promise.race observes the normal path; this explicit sink also owns a
    // late rejection if the deadline wins first.
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (deadlineExpired) {
        // The deadline is the ownership boundary for a genuinely hung queue:
        // destroy its device first, then keep the global hooks installed while
        // the raw fence gets a bounded chance to reject/settle and its event
        // delivery task runs. Waiting forever here would defeat the hang gate.
        const timedOutRenderer = rendererOwner.current;
        rendererOwner.current = null;
        timedOutRenderer?.dispose();
        // Cleanup cannot unconditionally await the operation whose failure
        // mode is "never settles". Give abort-aware stages a bounded chance to
        // unwind; the late-value guard above owns any renderer produced later.
        await settleWithin(operation, COLD_START_TEARDOWN_DRAIN_MS);
        await drainFenceAndErrorDeliveryTurn(
          submittedWorkFence,
          COLD_START_TEARDOWN_DRAIN_MS,
        );
        throw deadlineError;
      }
      throw error;
    }
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    abortController.abort();
    endRendererStartupTrace();
    try {
      rendererOwner.current?.dispose();
    } finally {
      canvas.remove();
      console.error = originalConsoleError;
      Logger.Error = originalLoggerError;
    }
  }
}

describe("cold start (6-11.3)", () => {
  it("reaches a readable GPU-complete frame with an exhaustive split and the reference-host deadline", async () => {
    const result = await measureColdStart("analytic");

    // The ERROR half. A cold start that logs is not a cold start that worked,
    // however fast it was.
    expect(
      result.consoleErrors,
      `the analytic cold start logged errors: ${result.consoleErrors.join(" | ")}`,
    ).toEqual([]);
    expect(
      result.rendererErrors,
      `the analytic cold start reported renderer errors: ${result.rendererErrors.join(" | ")}`,
    ).toEqual([]);
    expect(
      result.frameCompletenessFailures,
      `the analytic cold start did not produce the complete terrain scene: `
        + result.frameCompletenessFailures.join(" | "),
    ).toEqual([]);

    // The TIMEOUT half is enforced by the race inside measureColdStart. Keep
    // its loose hang ceiling separate from the measured acceptance deadline.
    const split = result.stages
      .map((s) => `${s.kind}:${s.label}=${s.milliseconds.toFixed(0)}ms`)
      .join(" ");
    const attributedMs = result.stages.reduce((sum, stage) => sum + stage.milliseconds, 0);
    console.info(
      `COLD-START analytic create=${result.createMs.toFixed(1)}ms `
      + `completion=${result.completionMs.toFixed(1)}ms `
      + `ready=${result.readyMs.toFixed(1)}ms `
      + `foregroundDetail=${(result.foregroundDetailFraction * 100).toFixed(2)}% `
      + `terrainTiles=${result.terrainTiles} `
      + `deadline=${ANALYTIC_COLD_START_DEADLINE_MS}ms `
      + `attributed=${attributedMs.toFixed(0)}ms `
      + `gap=${(result.createMs - attributedMs).toFixed(1)}ms | ${split}`,
    );

    // Non-vacuity: an empty, overlapping, or partial trace would recreate the
    // old "81% untraced" result while looking like instrumentation. This is the
    // deliberate-red architecture check: adding startup work after the final
    // checkpoint, or reverting to selected Promise timers, leaves a measurable
    // gap and fails here.
    expect(
      result.stages.length,
      "no startup stages were recorded — the critical path is not attributed",
    ).toBeGreaterThan(10);
    expect(new Set(result.stages.map((stage) => stage.label)).size).toBe(result.stages.length);
    expect(new Set(result.stages.map((stage) => stage.kind))).toEqual(new Set(["sync", "async"]));
    expect(result.stages.every(
      (stage) => Number.isFinite(stage.milliseconds) && stage.milliseconds >= 0,
    )).toBe(true);
    expect(
      Math.abs(result.createMs - attributedMs),
      "startup trace does not exhaustively cover FlightRenderer.create()",
    ).toBeLessThan(5);
    expect(result.createMs).toBeGreaterThan(0);
    expect(result.readyMs).toBeLessThan(COLD_START_HANG_CEILING_MS);
    if (ENFORCE_REFERENCE_HOST_DEADLINE) {
      expect(
        result.readyMs,
        `analytic cold time-to-ready exceeded its ${ANALYTIC_COLD_START_DEADLINE_MS} ms `
          + "reference-host deadline (the parked eroded target is a different budget)",
      ).toBeLessThanOrEqual(ANALYTIC_COLD_START_DEADLINE_MS);
    } else {
      console.info(
        "COLD-START deadline reported only: VITE_PERF_UNPINNED_HOST=1; "
          + "timeout, console-error, frame-completion, and trace-coverage gates remain enforced",
      );
    }
  }, 300_000);
});
