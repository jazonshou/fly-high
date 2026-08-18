/// <reference types="vite/client" />
import { afterAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { FlightRenderer } from "../../src/render/FlightRenderer";
import {
  createWorld,
  generateTerrainTile,
  sampleTerrain,
  sampleTerrainHeight,
} from "../../src/world";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../../src/game/types";
import {
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_SSIM_THRESHOLD,
  PERF_CAPTURE_WARMUP_FRAMES,
  PERF_CAPTURE_WIDTH,
  luminanceFromRgba,
  meanSsim,
  tileStatistics,
  type PerfCaptureReport,
  type PerfCaptureShotReport,
} from "../../scripts/perf-capture.mts";

/**
 * 1A-1c — the perf-capture driver. Boots the real renderer against the fixed
 * baseline world and captures the three plan shots plus the numeric report.
 * Baselines live in tests/perf/baseline (committed); per-run artifacts go to
 * tests/perf/artifacts (ignored). See vitest.perf.config.ts for the policy.
 */

const BASELINE_DIR = "tests/perf/baseline";
const ARTIFACT_DIR = "tests/perf/artifacts";
const REBASELINE = import.meta.env.VITE_PERF_REBASELINE === "1";

function pitchDownQuaternion(degrees: number): { x: number; y: number; z: number; w: number } {
  // Body axes are +X forward, +Y up; pitching down rotates about +Z by −θ.
  const half = (-degrees * Math.PI) / 360;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

async function readBaselineLuminance(name: string): Promise<Float32Array | null> {
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
  const canvas = document.createElement("canvas");
  canvas.width = PERF_CAPTURE_WIDTH;
  canvas.height = PERF_CAPTURE_HEIGHT;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, PERF_CAPTURE_WIDTH, PERF_CAPTURE_HEIGHT).data;
  return luminanceFromRgba(data, PERF_CAPTURE_WIDTH, PERF_CAPTURE_HEIGHT);
}

describe("perf capture (1A-1c)", () => {
  let renderer: FlightRenderer | null = null;

  afterAll(() => {
    renderer?.dispose();
  });

  it("captures the three fixed shots and the numeric report", async () => {
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
      ...(world.airport ? { runway: world.airport } : {}),
    });
    renderer.setAtmosphere({ dayOfYear: 171, solarTimeHours: 12.5 }, "clear");

    // Page-generation cost at the plan's reference resolution (65).
    const generationRuns = 5;
    const generationStarted = performance.now();
    for (let run = 0; run < generationRuns; run += 1) {
      generateTerrainTile(world, {
        tileX: 3 + run,
        tileZ: -2,
        size: 512,
        resolution: 65,
      });
    }
    const pageGenerationMs = (performance.now() - generationStarted) / generationRuns;

    const shotReports: PerfCaptureShotReport[] = [];
    let simulationTime = 0;
    for (const shot of PERF_CAPTURE_SHOTS) {
      const positionX = airportX + shot.offsetXMeters;
      const positionZ = airportZ + shot.offsetZMeters;
      const groundHeight = sampleTerrainHeight(world, positionX, positionZ);
      const altitude = shot.altitudeAglMeters !== null
        ? groundHeight + shot.altitudeAglMeters
        : shot.altitudeMslMeters!;
      const orientation = shot.pitchDownDegrees > 0
        ? pitchDownQuaternion(shot.pitchDownDegrees)
        : { x: 0, y: 0, z: 0, w: 1 };
      const state: FlightVisualState = {
        ...INITIAL_VISUAL_STATE,
        position: { x: positionX, y: altitude, z: positionZ },
        velocity: { x: shot.airspeedMetersPerSecond, y: 0, z: 0 },
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
      // before the capture.
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
      for (let settle = 0; settle < 150; settle += 1) {
        simulationTime += 1 / 60;
        renderer.render({ ...state, simulationTime }, 1 / 60);
        if (settle % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Final frame and readback must share one task: the presented WebGPU
      // buffer is cleared once the compositor consumes it.
      simulationTime += 1 / 60;
      renderer.render({ ...state, simulationTime }, 1 / 60);
      const copy = document.createElement("canvas");
      copy.width = PERF_CAPTURE_WIDTH;
      copy.height = PERF_CAPTURE_HEIGHT;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const pngBase64 = copy.toDataURL("image/png").split(",")[1]!;
      const rgba = context.getImageData(0, 0, PERF_CAPTURE_WIDTH, PERF_CAPTURE_HEIGHT).data;
      const luminance = luminanceFromRgba(rgba, PERF_CAPTURE_WIDTH, PERF_CAPTURE_HEIGHT);

      const diagnostics = renderer.getDiagnostics();
      const baseline = REBASELINE ? null : await readBaselineLuminance(shot.name);
      const ssim = baseline === null
        ? null
        : meanSsim(baseline, luminance, PERF_CAPTURE_WIDTH, PERF_CAPTURE_HEIGHT);

      await commands.writeFile(`${ARTIFACT_DIR}/${shot.name}.png`, pngBase64, "base64");
      if (REBASELINE || baseline === null) {
        await commands.writeFile(`${BASELINE_DIR}/${shot.name}.png`, pngBase64, "base64");
      }

      shotReports.push({
        name: shot.name,
        description: shot.description,
        ssimAgainstBaseline: ssim === null ? null : Math.round(ssim * 10_000) / 10_000,
        tiles: tileStatistics(luminance, PERF_CAPTURE_WIDTH, PERF_CAPTURE_HEIGHT),
        fps: Math.round(diagnostics.fps),
        cpuFrameMsP95: diagnostics.cpuP95Ms ?? diagnostics.cpuFrameTime,
        gpuFrameMsP95: diagnostics.gpuP95Ms,
        drawCalls: diagnostics.drawCalls,
        triangles: diagnostics.triangles,
        residentTerrainPages: diagnostics.residentTerrainPages,
        pendingTerrainPages: diagnostics.pendingTerrainPages,
        renderPixels: diagnostics.renderPixels,
        estimatedGpuMemoryMiB: Math.round(diagnostics.estimatedGpuMemoryMiB * 10) / 10,
      });
    }

    const report: PerfCaptureReport = {
      seed: PERF_CAPTURE_SEED,
      width: PERF_CAPTURE_WIDTH,
      height: PERF_CAPTURE_HEIGHT,
      warmupFrames: PERF_CAPTURE_WARMUP_FRAMES,
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

    expect(shotReports).toHaveLength(PERF_CAPTURE_SHOTS.length);
    for (const shot of shotReports) {
      expect(shot.tiles.meanLuminance).toBeGreaterThan(0.01);
      if (shot.ssimAgainstBaseline !== null) {
        expect(
          shot.ssimAgainstBaseline,
          `${shot.name} diverged from the committed baseline — a regression unless this is `
          + "one of the four sanctioned churn points (then rerun with perf:capture:rebaseline)",
        ).toBeGreaterThanOrEqual(PERF_CAPTURE_SSIM_THRESHOLD);
      }
    }
  });
});
