/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { Logger } from "@babylonjs/core/Misc/logger";
import {
  FlightRenderer,
  beginRendererStartupTrace,
  endRendererStartupTrace,
  readRendererStartupTrace,
} from "../../src/render/FlightRenderer";
import { createWorld, sampleTerrain } from "../../src/world";
import { PERF_CAPTURE_SEED } from "../../scripts/perf-capture.mts";

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
 * The number is deliberately NOT pinned here yet. It is pinned from a cold
 * reference host, and the host that built this harness had been running
 * captures for hours — see §1.2's A->B->A amendment for why a number taken then
 * would be a thermometer reading rather than an acceptance figure. The ceiling
 * below is a LOOSE upper bound whose only job is to catch a hang; tightening it
 * to a real acceptance number is the remaining half of this item.
 */

/**
 * Loose enough that only a hang trips it, and deliberately so until the real
 * number is pinned. A hang is the failure this must never miss; a slow-but-
 * finite start is a number to record, not an assertion to fail on a host whose
 * thermal state is unknown.
 */
const COLD_START_HANG_CEILING_MS = 120_000;

/** What a cold start must produce to count as ready, not merely as returned. */
interface ColdStartResult {
  readonly totalMs: number;
  readonly stages: readonly { readonly label: string; readonly milliseconds: number }[];
  readonly firstFrameMs: number;
  readonly consoleErrors: readonly string[];
}

async function measureColdStart(worldEvolution: "analytic" | "eroded"): Promise<ColdStartResult> {
  const consoleErrors: string[] = [];
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

  let renderer: FlightRenderer | null = null;
  try {
    const world = createWorld(PERF_CAPTURE_SEED, { worldEvolution });
    beginRendererStartupTrace();
    const startedAt = performance.now();

    // The timeout is the harness's own, not the renderer's: a stage that hangs
    // INSIDE the renderer's own budget still has to fail here, and a hang with
    // no error is exactly the case an error-only check cannot see.
    const created = await Promise.race([
      FlightRenderer.create({
        canvas,
        aircraft: "trainer",
        terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
        world,
        seed: world.sourceSeedHash,
        quality: "medium",
        renderingMode: "balanced",
        reducedMotion: false,
        ...(world.airport ? { runway: world.airport } : {}),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(
            `cold start did not become ready within ${COLD_START_HANG_CEILING_MS} ms `
            + `(world=${worldEvolution}). This is the HANG half of the gate: the `
            + "failure class it guards produces no console error at all.",
          )),
          COLD_START_HANG_CEILING_MS,
        );
      }),
    ]);
    renderer = created;
    const totalMs = performance.now() - startedAt;
    const stages = readRendererStartupTrace().map((s) => ({ ...s }));

    // "Ready" is not "create() returned" — a renderer that resolves and then
    // cannot draw is the black-frame failure wearing a green hat. Ready means a
    // frame was actually presented.
    const firstFrameStartedAt = performance.now();
    renderer.render({
      ...(await import("../../src/game/types")).INITIAL_VISUAL_STATE,
      simulationTime: 0,
    }, 1 / 60);
    const firstFrameMs = performance.now() - firstFrameStartedAt;

    return { totalMs, stages, firstFrameMs, consoleErrors };
  } finally {
    endRendererStartupTrace();
    renderer?.dispose();
    canvas.remove();
    console.error = originalConsoleError;
    Logger.Error = originalLoggerError;
  }
}

describe("cold start (6-11.3)", () => {
  it("reaches a first presented frame with no console error, and reports the stage split", async () => {
    const result = await measureColdStart("analytic");

    // The ERROR half. A cold start that logs is not a cold start that worked,
    // however fast it was.
    expect(
      result.consoleErrors,
      `the analytic cold start logged errors: ${result.consoleErrors.join(" | ")}`,
    ).toEqual([]);

    // The TIMEOUT half is enforced by the race inside measureColdStart; this
    // records what it cost. Reported, not yet pinned — see the file docblock.
    const split = result.stages
      .map((s) => `${s.label}=${s.milliseconds.toFixed(0)}ms`)
      .join(" ");
    console.info(
      `COLD-START analytic total=${result.totalMs.toFixed(0)}ms `
      + `firstFrame=${result.firstFrameMs.toFixed(0)}ms | ${split}`,
    );

    // Non-vacuity: a trace with no stages would make the split meaningless and
    // would silently pass, which is the failure mode this whole file exists to
    // avoid reproducing.
    expect(
      result.stages.length,
      "no startup stages were recorded — the trace is not wired to awaitRendererStartup",
    ).toBeGreaterThan(2);
    expect(result.totalMs).toBeGreaterThan(0);
    expect(result.totalMs).toBeLessThan(COLD_START_HANG_CEILING_MS);
  }, 300_000);
});
