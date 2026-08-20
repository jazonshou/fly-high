/// <reference types="vite/client" />
import { afterAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { Logger } from "@babylonjs/core/Misc/logger";
import { FlightRenderer } from "../../src/render/FlightRenderer";
import {
  createWorld,
  sampleTerrain,
  sampleTerrainHeight,
} from "../../src/world";
import { sunDirectionForClock } from "../../src/render/webgpu/nature/EnvironmentDirector";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../../src/game/types";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_MEASURE_FRAMES,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_SSIM_THRESHOLD,
  PERF_CAPTURE_TEMPORAL_FRAMES,
  PERF_CAPTURE_WARMUP_FRAMES,
  PERF_CAPTURE_WIDTH,
  headingVectorFromYaw,
  locateShotOffset,
  luminanceFromRgba,
  meanSsim,
  orientationFromYawPitchBank,
  sustainedFpsFromFrameIntervals,
  temporalStability,
  tileStatistics,
  yawForSunBearing,
  type PerfCaptureReport,
  type PerfCaptureShotDefinition,
  type PerfCaptureShotReport,
  type ShotPlacement,
  type TemporalStability,
} from "../../scripts/perf-capture.mts";

/**
 * 1A-1c, rebuilt by Gate 2Z — the perf-capture driver. Boots the real
 * renderer against the fixed baseline world and captures the shot list plus
 * the numeric report. Z-1: the render scale is pinned to 1.0 (no letterbox,
 * no governor), the measurement loop is rAF-paced so fps is a frame rate,
 * and any renderer console error fails the capture. Z-2: per-shot hitch
 * metrics asserted against committed ceilings. Z-3: per-shot clocks and
 * viewports, feature-located shots, and a temporal-stability motion scene.
 * Baselines live in tests/perf/baseline (committed); per-run artifacts go to
 * tests/perf/artifacts (ignored). See vitest.perf.config.ts for the policy.
 */

const BASELINE_DIR = "tests/perf/baseline";
const ARTIFACT_DIR = "tests/perf/artifacts";
const REBASELINE = import.meta.env.VITE_PERF_REBASELINE === "1";

/**
 * Comma-separated shot names to run, for diagnosis. A full capture is ~4
 * minutes of wall clock, which is the wrong feedback loop for "why is this
 * one shot black" — and that question has now come up twice (2-12's five
 * on-adapter-only failures, and the perf-debt pass's black approach shot).
 * Rebaselining is refused while a filter is active: a partial run must never
 * be able to overwrite the committed set.
 */
const SHOT_FILTER = String(import.meta.env.VITE_PERF_SHOTS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const SELECTED_SHOTS = SHOT_FILTER.length === 0
  ? PERF_CAPTURE_SHOTS
  : PERF_CAPTURE_SHOTS.filter((shot) => SHOT_FILTER.includes(shot.name));
if (SHOT_FILTER.length > 0 && REBASELINE) {
  throw new Error(
    "VITE_PERF_SHOTS and VITE_PERF_REBASELINE are mutually exclusive: a "
    + "partial capture must never overwrite the committed baseline set.",
  );
}
if (SHOT_FILTER.length > 0 && SELECTED_SHOTS.length !== SHOT_FILTER.length) {
  throw new Error(
    `VITE_PERF_SHOTS named a shot that does not exist: ${SHOT_FILTER.join(", ")}`,
  );
}

async function readBaselineLuminance(
  name: string,
  width: number,
  height: number,
): Promise<Float32Array | null> {
  let base64: string;
  try {
    base64 = await commands.readFile(`${BASELINE_DIR}/${name}.png`, "base64");
  } catch {
    return null;
  }
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Baseline ${name}.png failed to decode`));
  });
  image.src = `data:image/png;base64,${base64}`;
  await loaded;
  if (image.naturalWidth !== width || image.naturalHeight !== height) {
    // A shot's viewport changed: treat the old baseline as absent so the
    // capture re-baselines it (a sanctioned-churn event, visible in review).
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  return luminanceFromRgba(data, width, height);
}

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("perf capture (1A-1c / 2Z)", () => {
  let renderer: FlightRenderer | null = null;
  const consoleErrors: string[] = [];
  const loggerErrors: string[] = [];
  const originalConsoleError = console.error;
  const originalLoggerError = Logger.Error;

  afterAll(() => {
    console.error = originalConsoleError;
    Logger.Error = originalLoggerError;
    renderer?.dispose();
  });

  it("captures the shot list and the numeric report", async () => {
    // Z-1: a renderer error is a failed capture, not a log line. Babylon's
    // Logger holds its own console reference from module load, so the Logger
    // static is intercepted as well as console.error.
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((value) => String(value)).join(" "));
      originalConsoleError.apply(console, args as []);
    };
    Logger.Error = ((message: string | unknown[], limit?: number) => {
      loggerErrors.push(Array.isArray(message) ? message.join(" ") : String(message));
      originalLoggerError.call(Logger, message as string, limit);
    }) as typeof Logger.Error;

    const world = createWorld(PERF_CAPTURE_SEED);
    const airportX = world.airport?.centerX ?? 0;
    const airportZ = world.airport?.centerZ ?? 0;

    const canvas = document.createElement("canvas");
    canvas.width = PERF_CAPTURE_WIDTH;
    canvas.height = PERF_CAPTURE_HEIGHT;
    canvas.style.width = `${PERF_CAPTURE_WIDTH}px`;
    canvas.style.height = `${PERF_CAPTURE_HEIGHT}px`;
    document.body.appendChild(canvas);

    renderer = await FlightRenderer.create({
      canvas,
      aircraft: "trainer",
      terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
      world,
      seed: world.sourceSeedHash,
      quality: "medium",
      renderingMode: "balanced",
      reducedMotion: false,
      // Z-1: deterministic pixels — no governor may rewrite the target.
      pinnedRenderScale: 1,
      ...(world.airport ? { runway: world.airport } : {}),
    });

    // 4-9: `generateTerrainTile` is deleted with the CPU render path. What
    // this row measured — the CPU cost of building one page — no longer
    // exists at all: pages are a compute dispatch now. The row is kept and
    // re-pointed at the analytic kernel over one page's worth of L0 samples,
    // which is what the COLLISION path still costs and is the only CPU
    // terrain cost left to watch.
    const generationRuns = 5;
    const generationStarted = performance.now();
    for (let run = 0; run < generationRuns; run += 1) {
      const originX = (3 + run) * 512;
      for (let index = 0; index < 4_225; index += 1) {
        sampleTerrainHeight(
          world,
          originX + (index % 65) * 8,
          -1_024 + Math.floor(index / 65) * 8,
        );
      }
    }
    const pageGenerationMs = (performance.now() - generationStarted) / generationRuns;

    // Z-3: feature-located shots resolve their offsets from the terrain
    // field, deterministically per seed.
    const resolvePlacement = (shot: PerfCaptureShotDefinition): ShotPlacement => {
      const fallback: ShotPlacement = {
        offsetXMeters: shot.offsetXMeters,
        offsetZMeters: shot.offsetZMeters,
      };
      if (!shot.locate || shot.locate === "fixed") return fallback;
      if (shot.locate === "forest") {
        const found = locateShotOffset((x, z) => {
          for (const [dx, dz] of [[0, 0], [250, 0], [-250, 0], [0, 250], [0, -250]] as const) {
            const sample = sampleTerrain(world, airportX + x + dx, airportZ + z + dz);
            if (sample.biomeName !== "forest") return false;
          }
          return true;
        });
        return found ?? fallback;
      }
      // Coast: over water with land ~3 km ahead on the +x heading.
      const found = locateShotOffset((x, z) => {
        const here = sampleTerrainHeight(world, airportX + x, airportZ + z);
        if (here > world.seaLevel - 2) return false;
        const ahead = sampleTerrainHeight(world, airportX + x + 3_000, airportZ + z);
        return ahead > world.seaLevel + 5;
      }, { maxRadiusMeters: 20_000 });
      return found ?? fallback;
    };

    const shotReports: PerfCaptureShotReport[] = [];
    let simulationTime = 0;
    for (const shot of SELECTED_SHOTS) {
      const viewportWidth = shot.viewportWidth ?? PERF_CAPTURE_WIDTH;
      const viewportHeight = shot.viewportHeight ?? PERF_CAPTURE_HEIGHT;
      if (canvas.width !== viewportWidth || canvas.height !== viewportHeight) {
        canvas.width = viewportWidth;
        canvas.height = viewportHeight;
        canvas.style.width = `${viewportWidth}px`;
        canvas.style.height = `${viewportHeight}px`;
        // Let the renderer's ResizeObserver see the new content box.
        await nextAnimationFrame();
        await nextAnimationFrame();
      }

      // R-15: the clock is per shot and applied inside the loop.
      const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
      renderer.setAtmosphere(clock, "clear");

      const placement = resolvePlacement(shot);
      const positionX = airportX + placement.offsetXMeters;
      const positionZ = airportZ + placement.offsetZMeters;
      const groundHeight = sampleTerrainHeight(world, positionX, positionZ);
      const altitude = shot.altitudeAglMeters !== null
        ? groundHeight + shot.altitudeAglMeters
        : shot.altitudeMslMeters!;
      const yawDegrees = shot.relativeSunBearingDegrees !== undefined
        ? yawForSunBearing(
            sunDirectionForClock(clock, world.latitudeDegrees),
            shot.relativeSunBearingDegrees,
          )
        : 0;
      const heading = headingVectorFromYaw(yawDegrees);
      const orientation = orientationFromYawPitchBank(yawDegrees, shot.pitchDownDegrees, 0);
      const state: FlightVisualState = {
        ...INITIAL_VISUAL_STATE,
        position: { x: positionX, y: altitude, z: positionZ },
        velocity: {
          x: shot.airspeedMetersPerSecond * heading.x,
          y: 0,
          z: shot.airspeedMetersPerSecond * heading.z,
        },
        orientation,
        airspeed: shot.airspeedMetersPerSecond,
        altitude,
        altitudeAgl: altitude - groundHeight,
        simulationTime,
      };
      renderer.setCameraMode(shot.cameraMode);

      // Stream until the desired terrain pages are fully resident AND the
      // detail instance population stops changing (the 1B-10 worker streams
      // cells asynchronously), then a fixed settle for temporal state —
      // otherwise reruns diff on whichever pages or cells happened to arrive
      // before the capture. This phase runs as fast as the CPU allows; no
      // timing metric is read from it.
      const maxStreamingFrames = 6_000;
      let stableChecks = 0;
      let lastVisibleInstances = -1;
      for (let frame = 0; frame < maxStreamingFrames; frame += 1) {
        simulationTime += 1 / 60;
        renderer.render({ ...state, simulationTime }, 1 / 60);
        // Yield regularly so terrain/hydrology/detail worker results land.
        if (frame % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
        if (frame >= PERF_CAPTURE_WARMUP_FRAMES && frame % 30 === 29) {
          const diagnostics = renderer.getDiagnostics();
          if (
            diagnostics.pendingTerrainPages === 0
            && diagnostics.visibleInstances === lastVisibleInstances
          ) {
            stableChecks += 1;
            if (stableChecks >= 3) break;
          } else {
            stableChecks = 0;
          }
          lastVisibleInstances = diagnostics.visibleInstances;
        }
      }
      // Pin the temporal phase before the settle: the streaming loop above
      // exits after a RUN-DEPENDENT number of frames, so accumulated time
      // would put waves and cloud advection at a different phase every run.
      // The settle then rebuilds all temporal state (cloud history, foam
      // decay) at these exact instants.
      simulationTime = 500 + shotReports.length * 120;
      for (let settle = 0; settle < 150; settle += 1) {
        simulationTime += 1 / 60;
        renderer.render({ ...state, simulationTime }, 1 / 60);
        if (settle % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Z-1/Z-2: the measurement phase. rAF-paced so frame intervals are
      // real presentation intervals; the timing window is reset first so the
      // tight streaming loop above cannot masquerade as hitches.
      renderer.resetPerformanceWindow();
      const copy = document.createElement("canvas");
      copy.width = viewportWidth;
      copy.height = viewportHeight;
      const copyContext = copy.getContext("2d", { willReadFrequently: true })!;
      const temporalFrames: Float32Array[] = [];
      const isMotion = shot.kind === "motion";
      const bankDegrees = shot.bankDegrees ?? 0;
      // Standard coordinated-turn rate for the scripted bank.
      const turnRateRadPerSecond = isMotion
        ? (9.81 * Math.tan((bankDegrees * Math.PI) / 180))
          / Math.max(20, shot.airspeedMetersPerSecond)
        : 0;
      let motionYawDegrees = yawDegrees;
      let motionX = positionX;
      let motionZ = positionZ;
      let previousFrameEnd = performance.now();
      const frameIntervalsMs: number[] = [];
      for (let frame = 0; frame < PERF_CAPTURE_MEASURE_FRAMES; frame += 1) {
        await nextAnimationFrame();
        simulationTime += 1 / 60;
        let frameState = { ...state, simulationTime };
        if (isMotion) {
          motionYawDegrees += (turnRateRadPerSecond * (180 / Math.PI)) / 60;
          const motionHeading = headingVectorFromYaw(motionYawDegrees);
          motionX += (shot.airspeedMetersPerSecond * motionHeading.x) / 60;
          motionZ += (shot.airspeedMetersPerSecond * motionHeading.z) / 60;
          frameState = {
            ...frameState,
            position: { x: motionX, y: altitude, z: motionZ },
            velocity: {
              x: shot.airspeedMetersPerSecond * motionHeading.x,
              y: 0,
              z: shot.airspeedMetersPerSecond * motionHeading.z,
            },
            orientation: orientationFromYawPitchBank(
              motionYawDegrees,
              shot.pitchDownDegrees,
              bankDegrees,
            ),
          };
        }
        renderer.render(frameState, 1 / 60);
        const frameEnd = performance.now();
        frameIntervalsMs.push(frameEnd - previousFrameEnd);
        previousFrameEnd = frameEnd;
        if (
          isMotion
          && frame >= PERF_CAPTURE_MEASURE_FRAMES - PERF_CAPTURE_TEMPORAL_FRAMES
        ) {
          // Readback must share the task with the render that produced it.
          copyContext.drawImage(canvas, 0, 0);
          const rgba = copyContext.getImageData(0, 0, viewportWidth, viewportHeight).data;
          temporalFrames.push(luminanceFromRgba(rgba, viewportWidth, viewportHeight));
        }
      }
      // Sustained rate, robust to sparse stalls — spikes are gated separately
      // by maxFrameMs / p999FrameMs / hitchCount.
      const measuredFps = sustainedFpsFromFrameIntervals(frameIntervalsMs);

      // Final frame and readback must share one task: the presented WebGPU
      // buffer is cleared once the compositor consumes it.
      simulationTime += 1 / 60;
      renderer.render({ ...state, simulationTime }, 1 / 60);
      copyContext.drawImage(canvas, 0, 0);
      const pngBase64 = copy.toDataURL("image/png").split(",")[1]!;
      const rgba = copyContext.getImageData(0, 0, viewportWidth, viewportHeight).data;
      const luminance = luminanceFromRgba(rgba, viewportWidth, viewportHeight);

      const diagnostics = renderer.getDiagnostics();
      const comparesToBaseline = shot.comparesToBaseline ?? true;
      const baseline = REBASELINE || !comparesToBaseline
        ? null
        : await readBaselineLuminance(shot.name, viewportWidth, viewportHeight);
      const ssim = baseline === null
        ? null
        : meanSsim(baseline, luminance, viewportWidth, viewportHeight);

      await commands.writeFile(`${ARTIFACT_DIR}/${shot.name}.png`, pngBase64, "base64");
      if (comparesToBaseline && (REBASELINE || baseline === null)) {
        await commands.writeFile(`${BASELINE_DIR}/${shot.name}.png`, pngBase64, "base64");
      }

      let temporal: TemporalStability | undefined;
      if (temporalFrames.length >= 2) {
        temporal = temporalStability(temporalFrames, viewportWidth, viewportHeight);
      }

      shotReports.push({
        name: shot.name,
        description: shot.description,
        ssimAgainstBaseline: ssim === null ? null : Math.round(ssim * 10_000) / 10_000,
        tiles: tileStatistics(luminance, viewportWidth, viewportHeight),
        fps: Math.round(measuredFps * 10) / 10,
        frameIntervalMsP95: diagnostics.frameIntervalP95Ms,
        cpuFrameMsP95: diagnostics.cpuP95Ms ?? diagnostics.cpuFrameTime,
        gpuFrameMsP95: diagnostics.gpuP95Ms,
        presentWaitMsP95: diagnostics.presentWaitP95Ms,
        maxFrameMs: diagnostics.maxFrameMs === null
          ? null
          : Math.round(diagnostics.maxFrameMs * 10) / 10,
        p999FrameMs: diagnostics.p999FrameMs === null
          ? null
          : Math.round(diagnostics.p999FrameMs * 10) / 10,
        hitchCount: diagnostics.hitchCount,
        drawCalls: diagnostics.drawCalls,
        vegetationBatches: diagnostics.vegetationBatches,
        triangles: diagnostics.triangles,
        residentTerrainPages: diagnostics.residentTerrainPages,
        pendingTerrainPages: diagnostics.pendingTerrainPages,
        renderPixels: diagnostics.renderPixels,
        viewportWidth,
        viewportHeight,
        estimatedGpuMemoryMiB: Math.round(diagnostics.estimatedGpuMemoryMiB * 10) / 10,
        inventoriedGpuMemoryMiB: Math.round(diagnostics.inventoriedGpuMemoryMiB * 10) / 10,
        ...(temporal ? { temporal } : {}),
      });
    }

    const report: PerfCaptureReport = {
      seed: PERF_CAPTURE_SEED,
      width: PERF_CAPTURE_WIDTH,
      height: PERF_CAPTURE_HEIGHT,
      warmupFrames: PERF_CAPTURE_WARMUP_FRAMES,
      measureFrames: PERF_CAPTURE_MEASURE_FRAMES,
      pageGenerationMs: Math.round(pageGenerationMs * 100) / 100,
      shots: shotReports,
    };
    await commands.writeFile(
      `${ARTIFACT_DIR}/report.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    if (REBASELINE || shotReports.every((shot) => shot.ssimAgainstBaseline === null)) {
      await commands.writeFile(
        `${BASELINE_DIR}/report.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }

    expect(shotReports).toHaveLength(SELECTED_SHOTS.length);
    for (let index = 0; index < shotReports.length; index += 1) {
      const definition = SELECTED_SHOTS[index]!;
      const shot = shotReports[index]!;
      // Z-1: the pinned scale must hold — the render target is exactly the
      // canvas, no letterbox, no black tiles.
      expect(
        shot.renderPixels,
        `${shot.name}: renderPixels must equal the shot viewport (Z-1 pin)`,
      ).toBe(shot.viewportWidth * shot.viewportHeight);
      expect(shot.tiles.meanLuminance).toBeGreaterThan(
        definition.minMeanLuminance ?? 0.01,
      );
      if (shot.ssimAgainstBaseline !== null) {
        expect(
          shot.ssimAgainstBaseline,
          `${shot.name} diverged from the committed baseline — a regression unless this is `
          + "a sanctioned churn point (then rerun with perf:capture:rebaseline)",
        ).toBeGreaterThanOrEqual(definition.ssimThreshold ?? PERF_CAPTURE_SSIM_THRESHOLD);
      }
      if (definition.temporalFloors && shot.temporal) {
        expect(
          shot.temporal.minConsecutiveSsim,
          `${shot.name}: consecutive-frame SSIM fell below the committed floor (flicker)`,
        ).toBeGreaterThanOrEqual(definition.temporalFloors.minConsecutiveSsim);
        expect(
          shot.temporal.maxMeanLuminanceDelta,
          `${shot.name}: frame-to-frame luminance jumped above the committed ceiling`,
        ).toBeLessThanOrEqual(definition.temporalFloors.maxMeanLuminanceDelta);
      }
      // Z-2: the committed per-shot performance gate.
      const ceilings = definition.ceilings;
      if (ceilings !== null) {
        expect(
          shot.fps,
          `${shot.name}: measured fps fell below the committed floor`,
        ).toBeGreaterThanOrEqual(ceilings.minFps);
        expect(
          shot.hitchCount,
          `${shot.name}: more hitch frames than the committed ceiling`,
        ).toBeLessThanOrEqual(ceilings.hitchCount);
        if (shot.maxFrameMs !== null) {
          expect(
            shot.maxFrameMs,
            `${shot.name}: worst frame exceeded the committed ceiling`,
          ).toBeLessThanOrEqual(ceilings.maxFrameMs);
        }
        if (shot.p999FrameMs !== null) {
          expect(
            shot.p999FrameMs,
            `${shot.name}: p999 frame exceeded the committed ceiling`,
          ).toBeLessThanOrEqual(ceilings.p999FrameMs);
        }
      }
    }

    // Z-1: the renderer must not have logged an error during the run.
    expect(
      consoleErrors,
      "The renderer logged console errors during the capture (Z-1 gate)",
    ).toEqual([]);
    expect(
      loggerErrors,
      "Babylon logged errors during the capture (Z-1 gate)",
    ).toEqual([]);
  }, 1_500_000);
});
