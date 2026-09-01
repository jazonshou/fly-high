/// <reference types="vite/client" />
import { afterAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { Logger } from "@babylonjs/core/Misc/logger";
import { FlightRenderer } from "../../src/render/FlightRenderer";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../../src/game/types";
import type { RenderingMode } from "../../src/settings";
import {
  createWorld,
  sampleTerrain,
  sampleTerrainHeight,
} from "../../src/world";
import { sunDirectionForClock } from "../../src/render/webgpu/nature/EnvironmentDirector";
import { densityField } from "../../src/render/webgpu/detail/densityField";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../../src/game/types";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_MEASURE_FRAMES,
  PERF_CAPTURE_LOWER_FRAME_RGB_SSIM_THRESHOLD,
  PERF_CAPTURE_RGB_SSIM_THRESHOLD,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_SSIM_THRESHOLD,
  PERF_CAPTURE_TEMPORAL_FRAMES,
  PERF_CAPTURE_WORST_TILE_RGB_SSIM_THRESHOLD,
  PERF_CAPTURE_WARMUP_FRAMES,
  PERF_CAPTURE_WIDTH,
  headingVectorFromYaw,
  locateShotOffset,
  luminanceFromRgba,
  meanRgbSsim,
  meanSsim,
  orientationFromYawPitchBank,
  perfCaptureImageContentFailures,
  rawFrameIntervalMetrics,
  sustainedFpsFromFrameIntervals,
  temporalStability,
  inventoriedMemoryFailures,
  deliveryFailuresAgainst,
  perfCaptureDeliveryContract,
  tier1BalancedPerformanceFailures,
  tileStatistics,
  worstTileRgbSsim,
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
 * the numeric report. Z-1: the render scale is pinned to the shipping
 * medium/balanced profile (no governor), the measurement loop is rAF-paced so fps is a frame rate,
 * and any renderer console error fails the capture. Z-2: per-shot hitch
 * metrics asserted against committed ceilings. Z-3: per-shot clocks and
 * viewports, feature-located shots, and a temporal-stability motion scene.
 * Baselines live in tests/perf/baseline (committed and read-only); per-run
 * artifacts go to tests/perf/artifacts (ignored). A rebaseline run buffers a
 * complete candidate until all validations pass, then writes it only beneath
 * the ignored artifact directory. See vitest.perf.config.ts for the policy.
 */

const BASELINE_DIR = "tests/perf/baseline";
const ARTIFACT_DIR = "tests/perf/artifacts";
const CANDIDATE_ROOT = `${ARTIFACT_DIR}/rebaseline-candidates`;
const REBASELINE = import.meta.env.VITE_PERF_REBASELINE === "1";
/** Diagnostic only; normal captures match shipping's observer-free path. */
const GPU_TIMING_ENABLED = import.meta.env.VITE_PERF_GPU_TIMING === "1";
/**
 * `VITE_PERF_UNPINNED_HOST=1` — this run is NOT on the pinned reference
 * adapter, so the frame-DELIVERY contracts are reported instead of enforced.
 *
 * The split is not a convenience. `docs/PERFORMANCE.md` defines the tier-1
 * contract — 60 raw wall-clock fps, p95 <= 16.67 ms, <= 5 intervals over
 * 27.4 ms, none over 50 ms — "on the pinned reference adapter", and a hosted
 * CI runner is not that adapter: the same commit that measures 120 fps /
 * 9.2 ms p95 here measures ~44 fps / 22.6 ms p50 / a 783 ms worst frame on
 * GitHub's macOS runner, which also silently loses the detail Worker and
 * synthesises every chunk inline. Gating a virtualised GPU against a
 * reference-adapter contract measures the runner, not the diff.
 *
 * Everything that does NOT depend on how fast the host is stays gated there,
 * and that is the majority of this file's value: uncaptured GPU errors,
 * renderer/console errors, blank-or-structureless frames, the render-scale
 * pin, the settling fences, and every SSIM comparison. SSIM in particular is
 * host-independent by measurement, not by assumption — `reference-viewport`
 * scored an identical 0.6284 on this M3 Pro and on the hosted runner while
 * both were still comparing against the then-stale Phase-4.5 baseline.
 *
 * A LOCAL `npm run perf:capture` never sets this and stays fully strict.
 */
const UNPINNED_HOST = import.meta.env.VITE_PERF_UNPINNED_HOST === "1";
const TIER1_CAPTURE_PROFILE = resolveWebGpuQualityProfile("medium", "balanced");

/**
 * `6-11.1` — the four-tier x three-viewport sweep knobs.
 *
 * A capture with any of these set is a SWEEP RUN: an archived acceptance report
 * at one tier and viewport, never a baseline. It cannot compare against
 * committed baselines (a different tier draws a different world by design, so
 * every SSIM would be a false failure) and it cannot produce a candidate. The
 * canonical tier-1 720p configuration is the DEFAULT, so an unqualified
 * `npm run perf:capture` is bit-for-bit the run it has always been — the sweep
 * adds a mode, it does not change the standing gate.
 */
/**
 * `VITE_PERF_HIDE_VEGETATION=1` — render the shot with every `detail-` mesh
 * hidden, so the frame can be differenced against a normal capture to yield a
 * vegetation mask. Diagnostic only: it is mutually exclusive with rebaseline
 * for the obvious reason, and it never compares against a baseline.
 */
const HIDE_VEGETATION = import.meta.env.VITE_PERF_HIDE_VEGETATION === "1";

/**
 * `VITE_PERF_SUN_HOUR` / `VITE_PERF_SUN_BEARING` — override a shot's solar time
 * and its sun bearing relative to the view, for the measured
 * elevation x azimuth acceptance grid. Diagnostic only: any override forces the
 * run off baseline comparison, because a different sun is a different picture.
 */
const SUN_HOUR_OVERRIDE = Number.parseFloat(String(import.meta.env.VITE_PERF_SUN_HOUR ?? ""));
const SUN_BEARING_OVERRIDE = Number.parseFloat(
  String(import.meta.env.VITE_PERF_SUN_BEARING ?? ""),
);
const SUN_OVERRIDDEN = Number.isFinite(SUN_HOUR_OVERRIDE) || Number.isFinite(SUN_BEARING_OVERRIDE);
if (SUN_OVERRIDDEN && REBASELINE) {
  throw new Error(
    "VITE_PERF_SUN_HOUR / VITE_PERF_SUN_BEARING cannot be combined with "
    + "VITE_PERF_REBASELINE: an overridden sun is a diagnostic frame, not a baseline.",
  );
}
if (HIDE_VEGETATION && REBASELINE) {
  throw new Error(
    "VITE_PERF_HIDE_VEGETATION and VITE_PERF_REBASELINE are mutually exclusive: "
    + "a vegetation-free frame is a diagnostic mask, never a baseline.",
  );
}

const SWEEP_QUALITY = String(import.meta.env.VITE_PERF_QUALITY ?? "").trim();
const SWEEP_MODE = String(import.meta.env.VITE_PERF_MODE ?? "").trim();
const SWEEP_VIEWPORT = String(import.meta.env.VITE_PERF_VIEWPORT ?? "").trim();
const IS_SWEEP = SWEEP_QUALITY !== "" || SWEEP_MODE !== "" || SWEEP_VIEWPORT !== "";
const CAPTURE_QUALITY = (SWEEP_QUALITY === "" ? "medium" : SWEEP_QUALITY) as QualityLevel;
const CAPTURE_MODE = (SWEEP_MODE === "" ? "balanced" : SWEEP_MODE) as RenderingMode;
const CAPTURE_PROFILE = resolveWebGpuQualityProfile(CAPTURE_QUALITY, CAPTURE_MODE);
const DELIVERY = perfCaptureDeliveryContract(CAPTURE_PROFILE.tier);
const SWEEP_SIZE = ((): { width: number; height: number } | null => {
  if (SWEEP_VIEWPORT === "") return null;
  const match = /^(\d+)x(\d+)$/u.exec(SWEEP_VIEWPORT);
  if (!match) throw new Error(`VITE_PERF_VIEWPORT must be WIDTHxHEIGHT, got "${SWEEP_VIEWPORT}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
})();
if (IS_SWEEP && REBASELINE) {
  throw new Error(
    "VITE_PERF_REBASELINE cannot be combined with the sweep knobs "
    + "(VITE_PERF_QUALITY / VITE_PERF_MODE / VITE_PERF_VIEWPORT): a non-canonical "
    + "tier or viewport draws a different world by design and can never be a baseline.",
  );
}

/**
 * Comma-separated shot names to run, for diagnosis. A full capture is ~4
 * minutes of wall clock, which is the wrong feedback loop for "why is this
 * one shot black" — and that question has now come up twice (2-12's five
 * on-adapter-only failures, and the perf-debt pass's black approach shot).
 * Candidate generation is refused while a filter is active: reviewers must
 * always receive the exact full canonical set in canonical order.
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
    + "partial capture cannot produce a reviewable rebaseline candidate.",
  );
}
if (UNPINNED_HOST && REBASELINE) {
  throw new Error(
    "VITE_PERF_UNPINNED_HOST and VITE_PERF_REBASELINE are mutually exclusive: a "
    + "baseline candidate may only be generated on the pinned reference adapter.",
  );
}
if (
  REBASELINE
  && (
    SELECTED_SHOTS.length !== PERF_CAPTURE_SHOTS.length
    || SELECTED_SHOTS.some((shot, index) => shot.name !== PERF_CAPTURE_SHOTS[index]?.name)
  )
) {
  throw new Error(
    "A rebaseline candidate requires the exact full canonical shot set in canonical order.",
  );
}
if (SHOT_FILTER.length > 0 && SELECTED_SHOTS.length !== SHOT_FILTER.length) {
  throw new Error(
    `VITE_PERF_SHOTS named a shot that does not exist: ${SHOT_FILTER.join(", ")}`,
  );
}

interface BaselinePixels {
  readonly rgba: Uint8ClampedArray;
  readonly luminance: Float32Array;
}

/** Stable, useful assertion text for the browser-native WebGPU error event. */
function serializeGpuUncapturedError(event: GPUUncapturedErrorEvent): string {
  const error = event.error;
  const named = error as GPUError & { readonly name?: unknown };
  const name = typeof named.name === "string" ? named.name : null;
  return JSON.stringify({
    type: error.constructor?.name || "GPUError",
    ...(name ? { name } : {}),
    message: error.message,
  });
}

async function readBaselinePixels(
  name: string,
  width: number,
  height: number,
  required: boolean,
): Promise<BaselinePixels | null> {
  let base64: string;
  try {
    base64 = await commands.readFile(`${BASELINE_DIR}/${name}.png`, "base64");
  } catch (error) {
    if (required) {
      throw new Error(
        `Required committed baseline ${name}.png is missing or unreadable`,
        { cause: error },
      );
    }
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
    if (required) {
      throw new Error(
        `Required committed baseline ${name}.png is ${image.naturalWidth}x${image.naturalHeight}; `
        + `the shot requires ${width}x${height}`,
      );
    }
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  return {
    rgba: data,
    luminance: luminanceFromRgba(data, width, height),
  };
}

/** Three decimals is plenty for an aggregate nothing is gated on. */
function round3(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
}

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("perf capture (1A-1c / 2Z)", () => {
  let renderer: FlightRenderer | null = null;
  let removeGpuUncapturedErrorListener: (() => void) | null = null;
  const gpuUncapturedErrors: string[] = [];
  const consoleErrors: string[] = [];
  const loggerErrors: string[] = [];
  const originalConsoleError = console.error;
  const originalLoggerError = Logger.Error;

  afterAll(() => {
    removeGpuUncapturedErrorListener?.();
    removeGpuUncapturedErrorListener = null;
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

    // W-7: world identity is per-shot (analytic default, eroded shots
    // appended). These are LET bindings so the placement and terrain-sample
    // closures below always read the ACTIVE world at call time, and the
    // renderer/canvas swap at a mode boundary reassigns them all together.
    let activeWorldEvolution: "analytic" | "eroded" = "analytic";
    let world = createWorld(PERF_CAPTURE_SEED);
    let airportX = world.airport?.centerX ?? 0;
    let airportZ = world.airport?.centerZ ?? 0;

    const createCaptureCanvas = (): HTMLCanvasElement => {
      // A fresh canvas per renderer: Babylon engine re-acquisition on a
      // disposed canvas is unexercised anywhere, and canvases are free.
      const element = document.createElement("canvas");
      element.width = PERF_CAPTURE_WIDTH;
      element.height = PERF_CAPTURE_HEIGHT;
      element.style.width = `${PERF_CAPTURE_WIDTH}px`;
      element.style.height = `${PERF_CAPTURE_HEIGHT}px`;
      document.body.appendChild(element);
      return element;
    };
    let canvas = createCaptureCanvas();

    // Reads the let-bindings at invocation, so the same factory serves both
    // the initial renderer and any W-7 mode-boundary rebuild.
    const captureRendererOptions = () => ({
      canvas,
      aircraft: "trainer" as const,
      terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
      world,
      seed: world.sourceSeedHash,
      quality: CAPTURE_QUALITY,
      renderingMode: CAPTURE_MODE,
      reducedMotion: false,
      // Z-1: deterministic shipping pixels — no governor may rewrite the
      // target, but the capture must not silently replace medium's 0.86 with
      // a 35%-larger scale-1 workload. Under the sweep this is the SWEPT
      // tier's own scale, which is the point: a tier row promises the levers
      // that tier actually ships, so the governor stays frozen at each.
      pinnedRenderScale: CAPTURE_PROFILE.renderScale,
      captureGpuTiming: GPU_TIMING_ENABLED,
      ...(world.airport ? { runway: world.airport } : {}),
    });

    renderer = await FlightRenderer.create(captureRendererOptions());
    // This is the authoritative rejected-submit channel. A WebGPU validation
    // error is a device event, not necessarily a call through the page's
    // patched console, and the exact black-frame regression rendered quickly.
    // Install it before any shot streaming/rendering work begins and retain it
    // until after every candidate/publication assertion has run.
    removeGpuUncapturedErrorListener = renderer.addGpuUncapturedErrorListenerForCapture(
      (event) => gpuUncapturedErrors.push(serializeGpuUncapturedError(event)),
    );

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
      if (shot.locate === "grassland") {
        // Open grass with a guaranteed-clear lens: terrain sampling alone
        // cannot see scattered trees/ferns (two blind landings put one across
        // the camera), but the airport clearance culls ALL detail vegetation
        // except ground-cover blades — so the mown surround is the one place
        // a standing-height blade shot is deterministic. Require solid
        // clearance influence, off the runway itself, on flat grassland.
        const found = locateShotOffset((x, z) => {
          for (const [dx, dz] of [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]] as const) {
            const sample = sampleTerrain(world, airportX + x + dx, airportZ + z + dz);
            if (sample.biomeName !== "grassland") return false;
            if (sample.slope > 0.08) return false;
            if (sample.isRunway) return false;
            if (sample.airportInfluence < 0.35 || sample.airportInfluence > 0.85) return false;
          }
          return true;
        }, { stepMeters: 120, maxRadiusMeters: 3_000 });
        return found ?? fallback;
      }
      if (shot.locate === "mountain") {
        // A steep high face 400-900 m ahead on the +x heading, with the
        // camera spot itself standable (moderate slope, above water).
        const found = locateShotOffset((x, z) => {
          const here = sampleTerrain(world, airportX + x, airportZ + z);
          if (here.height < world.seaLevel + 5 || here.slope > 0.3) return false;
          let steep = 0;
          for (const ahead of [400, 650, 900] as const) {
            const face = sampleTerrain(world, airportX + x + ahead, airportZ + z);
            if (face.slope > 0.4 && face.height > here.height + 180) steep += 1;
          }
          return steep >= 2;
        }, { stepMeters: 400, maxRadiusMeters: 20_000 });
        return found ?? fallback;
      }
      if (shot.locate === "cliff") {
        // A steep face 120-280 m ahead — close enough that the rock texture
        // fills the frame at material-detail range.
        const found = locateShotOffset((x, z) => {
          const here = sampleTerrain(world, airportX + x, airportZ + z);
          if (here.height < world.seaLevel + 5 || here.slope > 0.3) return false;
          let steep = 0;
          for (const ahead of [120, 200, 280] as const) {
            const face = sampleTerrain(world, airportX + x + ahead, airportZ + z);
            if (face.slope > 0.45 && face.height > here.height + 60) steep += 1;
          }
          return steep >= 2;
        }, { stepMeters: 300, maxRadiusMeters: 20_000 });
        return found ?? fallback;
      }
      if (shot.locate === "canopy-backlit") {
        // `L-4`: closed canopy along the SUN-DERIVED heading, not +x.
        //
        // Two departures from `forest`, both deliberate:
        //
        // 1. **Gated on the vegetation field, not the biome id.** A biome-only
        //    predicate accepts forest with no stems standing in it — exactly
        //    what shipped `horizon-shadow-far-annulus` at 0 stems/m2 on every
        //    annulus sample, a shot that could not fail.
        // 2. **Scanned along this shot's own heading.** With
        //    `relativeSunBearingDegrees: 0` the corridor the camera looks down
        //    is not the corridor a +x predicate checks, and validating the
        //    wrong corridor blesses terrain the capture never frames.
        //
        // The span 0-2,400 m covers the frame's own reach at 400 m AGL /
        // pitch 20 (479-5,278 m measured), so mid, far and beyond-far canopy
        // are all required rather than hoped for.
        const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
        const heading = headingVectorFromYaw(
          yawForSunBearing(
            sunDirectionForClock(clock, world.latitudeDegrees),
            shot.relativeSunBearingDegrees ?? 0,
          ),
        );
        const found = locateShotOffset((x, z) => {
          for (let ahead = 0; ahead <= 2_400; ahead += 200) {
            const sx = airportX + x + heading.x * ahead;
            const sz = airportZ + z + heading.z * ahead;
            const sample = sampleTerrain(world, sx, sz);
            if (sample.biomeName === "water") return false;
            const field = densityField(world.sourceSeedHash, {
              x: sx,
              z: sz,
              heightMeters: sample.height,
              seaLevelMeters: world.seaLevel,
              slope: sample.slope,
              moisture: sample.moisture,
              normalX: sample.normal.x,
              normalZ: sample.normal.z,
              airportInfluence: sample.airportInfluence,
              dayOfYear: clock.dayOfYear,
              // 0 = the full-bandwidth field, which is what per-stem placement
              // uses; only a page bake passes a width (`4-6b`/D12).
              filterWidthMeters: 0,
            });
            if (field.treeStemsPerSquareMeter < 0.006 || field.heightFactor < 0.35) return false;
          }
          return true;
        }, { stepMeters: 500, maxRadiusMeters: 18_000 });
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
    const candidateScreenshots: Array<{ readonly name: string; readonly pngBase64: string }> = [];
    let simulationTime = 0;
    for (const shot of SELECTED_SHOTS) {
      // W-7: a mode boundary rebuilds the world and renderer. Dispose fully
      // BEFORE creating (two resident worlds would breach the Gate 0-c
      // inventoried-memory wall); error arrays keep accumulating across the
      // swap so the run-wide zero-error gates still cover both renderers.
      // Eroded shots are appended after all analytic shots, so this fires at
      // most once per run.
      const shotWorldEvolution = shot.worldEvolution ?? "analytic";
      if (shotWorldEvolution !== activeWorldEvolution) {
        removeGpuUncapturedErrorListener?.();
        removeGpuUncapturedErrorListener = null;
        renderer.dispose();
        canvas.remove();
        world = createWorld(PERF_CAPTURE_SEED, { worldEvolution: shotWorldEvolution });
        airportX = world.airport?.centerX ?? 0;
        airportZ = world.airport?.centerZ ?? 0;
        canvas = createCaptureCanvas();
        renderer = await FlightRenderer.create(captureRendererOptions());
        removeGpuUncapturedErrorListener = renderer.addGpuUncapturedErrorListenerForCapture(
          (event) => gpuUncapturedErrors.push(serializeGpuUncapturedError(event)),
        );
        activeWorldEvolution = shotWorldEvolution;
      }
      // 6-11.1: a sweep viewport overrides every shot's own size, so one
      // sweep run is one resolution across the whole set and the three
      // viewport columns are comparable to each other.
      const viewportWidth = SWEEP_SIZE?.width ?? shot.viewportWidth ?? PERF_CAPTURE_WIDTH;
      const viewportHeight = SWEEP_SIZE?.height ?? shot.viewportHeight ?? PERF_CAPTURE_HEIGHT;
      if (
        canvas.style.width !== `${viewportWidth}px`
        || canvas.style.height !== `${viewportHeight}px`
      ) {
        // Babylon owns the backing-store dimensions once hardware scaling is
        // active. Writing canvas.width/height here replaced its scaled colour
        // attachment without rebuilding the scaled depth attachment, making
        // the next WebGPU render pass invalid. Resize only the CSS viewport;
        // FlightRenderer's observer resizes every attachment coherently.
        canvas.style.width = `${viewportWidth}px`;
        canvas.style.height = `${viewportHeight}px`;
        // Let the renderer's ResizeObserver see the new content box.
        await nextAnimationFrame();
        await nextAnimationFrame();
      }
      // 6-11.1: the SWEPT tier's own render scale. Each tier ships a different
      // scale, and pinning tier 1's across the sweep would measure tier 1's
      // pixel count with another tier's settings — the one thing a tier row
      // must not do.
      if (HIDE_VEGETATION) {
        // After streaming, so the meshes exist to hide; before the settle and
        // readback, so the captured frame is the vegetation-free one.
        renderer.setVegetationVisibleForCapture(false);
      }
      const captureRenderScale = shot.captureRenderScale ?? CAPTURE_PROFILE.renderScale;
      renderer.setPinnedRenderScaleForCapture(captureRenderScale);

      // R-15: the clock is per shot and applied inside the loop.
      const baseClock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
      const clock = Number.isFinite(SUN_HOUR_OVERRIDE)
        ? { ...baseClock, solarTimeHours: SUN_HOUR_OVERRIDE }
        : baseClock;
      renderer.setAtmosphere(clock, "clear");

      const placement = resolvePlacement(shot);
      const positionX = airportX + placement.offsetXMeters;
      const positionZ = airportZ + placement.offsetZMeters;
      const groundHeight = sampleTerrainHeight(world, positionX, positionZ);
      const altitude = shot.altitudeAglMeters !== null
        ? groundHeight + shot.altitudeAglMeters
        : shot.altitudeMslMeters!;
      const relativeSunBearing = Number.isFinite(SUN_BEARING_OVERRIDE)
        ? SUN_BEARING_OVERRIDE
        : shot.relativeSunBearingDegrees;
      const yawDegrees = relativeSunBearing !== undefined
        ? yawForSunBearing(
            sunDirectionForClock(clock, world.latitudeDegrees),
            relativeSunBearing,
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
      /**
       * Raised from 6,000 once exhausting it became a LOUD failure rather than
       * a silent half-built frame (see the `pendingTerrainPages` assertion in
       * the gate block below).
       *
       * The eroded world is what forced this. Its page DAG is ~163 dispatches
       * amortised at roughly one admitted dispatch per frame, measured at ~31
       * frames per page with one page in flight, so `eroded-valley-500ft`'s
       * 168-page working set costs ~5,208 frames — 87% of the old ceiling. The
       * headroom is for the working sets 6-11's lower tiers and viewports will
       * ask for; the loop still exits the moment streaming settles, so a larger
       * cap costs nothing on a shot that finishes early.
       */
      const maxStreamingFrames = 24_000;
      let stableChecks = 0;
      let lastVisibleInstances = -1;
      let streamingFramesUsed = maxStreamingFrames;
      for (let frame = 0; frame < maxStreamingFrames; frame += 1) {
        simulationTime += 1 / 60;
        renderer.render({ ...state, simulationTime }, 1 / 60);
        // Yield regularly so terrain/hydrology/detail worker results land.
        if (frame % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
        if (frame >= PERF_CAPTURE_WARMUP_FRAMES && frame % 30 === 29) {
          const diagnostics = renderer.getDiagnostics();
          if (
            diagnostics.pendingTerrainPages === 0
            && diagnostics.pendingDetailWork === 0
            && diagnostics.visibleInstances === lastVisibleInstances
          ) {
            stableChecks += 1;
            if (stableChecks >= 3) {
              streamingFramesUsed = frame + 1;
              break;
            }
          } else {
            stableChecks = 0;
          }
          lastVisibleInstances = diagnostics.visibleInstances;
        }
      }
      // Counter reset is not a queue drain. The streaming loop above can
      // submit much faster than the GPU consumes work, so fence it before
      // the paced temporal settle or the first measured frame inherits an
      // arbitrary backlog.
      await renderer.waitForGpuIdleForCapture();
      // Pin the temporal phase before the settle: the streaming loop above
      // exits after a RUN-DEPENDENT number of frames, so accumulated time
      // would put waves and cloud advection at a different phase every run.
      // The settle then rebuilds all temporal state (cloud history, foam
      // decay) at these exact instants.
      //
      // Wave R: the phase keys on the shot's index in the CANONICAL list,
      // not its position in the selected subset. Baselines come from full
      // runs (where the two indices coincide, so no baseline moved with
      // this change) — but a VITE_PERF_SHOTS subset used to renumber the
      // shots and pin a DIFFERENT wind/wave phase than the baseline's.
      // From altitude that phase error is sub-pixel; at the 2 m shots the
      // whole blade-and-leaf field sways by pixels, and CI's fixed 5-shot
      // subset failed ground-2m-lowsun's SSIM deterministically (0.929, an
      // exact reproduction locally at subset index 0) while every full run
      // on the same code passed.
      const canonicalShotIndex = PERF_CAPTURE_SHOTS.findIndex(
        (candidate) => candidate.name === shot.name,
      );
      simulationTime = 500 + canonicalShotIndex * 120;
      for (let settle = 0; settle < 150; settle += 1) {
        await nextAnimationFrame();
        simulationTime += 1 / 60;
        renderer.render({ ...state, simulationTime }, 1 / 60);
      }
      await renderer.waitForGpuIdleForCapture();
      // A few ordinary paced, unmeasured frames rebuild compositor cadence
      // after the explicit queue fence.
      for (let drain = 0; drain < 4; drain += 1) {
        await nextAnimationFrame();
        simulationTime += 1 / 60;
        renderer.render({ ...state, simulationTime }, 1 / 60);
      }
      await renderer.waitForGpuIdleForCapture();

      // Z-1/Z-2: the measurement phase. rAF-paced so frame intervals are
      // real presentation intervals; the timing window is reset first so the
      // tight streaming loop above cannot masquerade as hitches.
      renderer.resetPerformanceWindow();
      const detailPresentationBefore = renderer.getDetailPresentationDiagnosticsForCapture();
      const copy = document.createElement("canvas");
      copy.width = viewportWidth;
      copy.height = viewportHeight;
      const copyContext = copy.getContext("2d", { willReadFrequently: true })!;
      copyContext.imageSmoothingEnabled = true;
      copyContext.imageSmoothingQuality = "high";
      const captureRaster = renderer.getCaptureRenderSize();
      const resolvePresentedFrame = (): void => {
        // Hardware scaling renders into the upper-left internal raster of the
        // swapchain canvas. Resolve that raster to the canonical CSS-sized
        // artifact; copying the whole backing store leaves transparent bands.
        copyContext.drawImage(
          canvas,
          0,
          0,
          captureRaster.width,
          captureRaster.height,
          0,
          0,
          viewportWidth,
          viewportHeight,
        );
      };
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
      let lastFrameState: FlightVisualState = { ...state, simulationTime };
      const advanceFrameState = (): FlightVisualState => {
        simulationTime += 1 / 60;
        let frameState: FlightVisualState = { ...state, simulationTime };
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
        lastFrameState = frameState;
        return frameState;
      };
      // Align the first interval to a fresh rAF boundary; time spent between
      // the drain fence and this boundary is setup, not gameplay delivery.
      await nextAnimationFrame();
      let previousDetailMarker = renderer.getDetailPresentationMarkerForCapture();
      const startDetailMarker = previousDetailMarker;
      let previousFrameEnd = performance.now();
      const frameIntervalsMs: number[] = [];
      const renderCallMs: number[] = [];
      const detailFrameMarkers: Array<{
        workerResultBeforeRender: boolean;
        publicationDuringRender: boolean;
      }> = [];
      for (let frame = 0; frame < PERF_CAPTURE_MEASURE_FRAMES; frame += 1) {
        await nextAnimationFrame();
        const beforeRenderMarker = renderer.getDetailPresentationMarkerForCapture();
        const renderStarted = performance.now();
        renderer.render(advanceFrameState(), 1 / 60);
        const frameEnd = performance.now();
        const afterRenderMarker = renderer.getDetailPresentationMarkerForCapture();
        detailFrameMarkers.push({
          workerResultBeforeRender:
            beforeRenderMarker.workerResultsQueued > previousDetailMarker.workerResultsQueued,
          publicationDuringRender:
            afterRenderMarker.publications > beforeRenderMarker.publications,
        });
        previousDetailMarker = afterRenderMarker;
        renderCallMs.push(frameEnd - renderStarted);
        frameIntervalsMs.push(frameEnd - previousFrameEnd);
        previousFrameEnd = frameEnd;
      }
      const timedDiagnostics = renderer.getDiagnostics();
      const detailPresentationAfter = renderer.getDetailPresentationDiagnosticsForCapture();
      if (isMotion) {
        console.info(
          `${shot.name}: CPU pass diagnostic `
          + JSON.stringify(timedDiagnostics.topPassesByCpuMs),
        );
        const detailPresentationDelta = {
          buildStarts: detailPresentationAfter.buildStarts
            - detailPresentationBefore.buildStarts,
          buildSlices: detailPresentationAfter.buildSlices
            - detailPresentationBefore.buildSlices,
          completedSlices: detailPresentationAfter.completedSlices
            - detailPresentationBefore.completedSlices,
          timeBudgetStops: detailPresentationAfter.timeBudgetStops
            - detailPresentationBefore.timeBudgetStops,
          workBudgetStops: detailPresentationAfter.workBudgetStops
            - detailPresentationBefore.workBudgetStops,
          workUnitsTotal: detailPresentationAfter.workUnitsTotal
            - detailPresentationBefore.workUnitsTotal,
          publications: detailPresentationAfter.publications
            - detailPresentationBefore.publications,
          publishedRecords: detailPresentationAfter.publishedRecords
            - detailPresentationBefore.publishedRecords,
          observerQuantumChanges: detailPresentationAfter.observerQuantumChanges
            - detailPresentationBefore.observerQuantumChanges,
          observerSensitiveBuildStarts: detailPresentationAfter.observerSensitiveBuildStarts
            - detailPresentationBefore.observerSensitiveBuildStarts,
          residentCellsInSensitiveBuilds:
            detailPresentationAfter.residentCellsInSensitiveBuilds
            - detailPresentationBefore.residentCellsInSensitiveBuilds,
          workerBuildStarts: detailPresentationAfter.workerBuildStarts
            - detailPresentationBefore.workerBuildStarts,
          workerResultsQueued: detailPresentationAfter.workerResultsQueued
            - detailPresentationBefore.workerResultsQueued,
          workerBuildPublications: detailPresentationAfter.workerBuildPublications
            - detailPresentationBefore.workerBuildPublications,
          workerBuildRejections: detailPresentationAfter.workerBuildRejections
            - detailPresentationBefore.workerBuildRejections,
          workerBuildTimeouts: detailPresentationAfter.workerBuildTimeouts
            - detailPresentationBefore.workerBuildTimeouts,
          workerGenerationTimeouts: detailPresentationAfter.workerGenerationTimeouts
            - detailPresentationBefore.workerGenerationTimeouts,
          workerFallbacks: detailPresentationAfter.workerFallbacks
            - detailPresentationBefore.workerFallbacks,
          cancellations: detailPresentationAfter.cancellations
            - detailPresentationBefore.cancellations,
          endingActiveBuildSource: detailPresentationAfter.activeBuildSource,
          endingWorkerRetainedCells: detailPresentationAfter.workerRetainedCells,
          endingPendingDetailWork: timedDiagnostics.pendingDetailWork,
          endingBackloggedChunks: detailPresentationAfter.backloggedChunks,
          endingActiveChunkKey: detailPresentationAfter.activeChunkKey,
        };
        console.info(
          `${shot.name}: detail presentation diagnostic `
          + JSON.stringify(detailPresentationDelta),
        );
      }
      const gpuTiming = renderer.getGpuTimingStatusForCapture();
      // Sustained rate, robust to sparse stalls — spikes are gated separately
      // by maxFrameMs / p999FrameMs / hitchCount.
      const measuredFps = sustainedFpsFromFrameIntervals(frameIntervalsMs);
      // The strict playability gate never trims. A freeze consumes the player's
      // wall time even if it is rare, so it remains in every metric below.
      const rawTiming = rawFrameIntervalMetrics(frameIntervalsMs);
      if (isMotion) {
        const overBudgetFrameIndices = frameIntervalsMs
          .map((interval, index) => (interval > 1_000 / 60 ? index : -1))
          .filter((index) => index >= 0);
        const markerSummary = {
          workerResultFrames: detailFrameMarkers
            .map((marker, index) => (marker.workerResultBeforeRender ? index : -1))
            .filter((index) => index >= 0),
          publicationFrames: detailFrameMarkers
            .map((marker, index) => (marker.publicationDuringRender ? index : -1))
            .filter((index) => index >= 0),
          overBudgetFrames: overBudgetFrameIndices,
          overBudgetWithWorkerResult: overBudgetFrameIndices.filter(
            (index) => detailFrameMarkers[index]?.workerResultBeforeRender,
          ).length,
          overBudgetWithPublication: overBudgetFrameIndices.filter(
            (index) => detailFrameMarkers[index]?.publicationDuringRender,
          ).length,
          // Streaming fix-pack counters (cumulative in the marker; printed
          // as measurement-window deltas). `publishedBytes` proves the byte
          // budget spread uploads, `createdBatches`/`reboundBatches` prove
          // structural work stayed off the publication frame, and the
          // suppression/stale counters prove chunks stayed visible.
          publishedBytes: previousDetailMarker.publishedBytes
            - startDetailMarker.publishedBytes,
          createdBatches: previousDetailMarker.createdBatches
            - startDetailMarker.createdBatches,
          reboundBatches: previousDetailMarker.reboundBatches
            - startDetailMarker.reboundBatches,
          revealRampsStarted: previousDetailMarker.revealRampsStarted
            - startDetailMarker.revealRampsStarted,
          suppressedChunks: previousDetailMarker.suppressedChunks
            - startDetailMarker.suppressedChunks,
          staleVisibleChunks: previousDetailMarker.staleVisibleChunks
            - startDetailMarker.staleVisibleChunks,
        };
        console.info(`${shot.name}: detail frame correlation ${JSON.stringify(markerSummary)}`);
        const sortedIntervals = [...frameIntervalsMs].sort((first, second) => first - second);
        const percentile = (fraction: number): number => sortedIntervals[
          Math.min(
            sortedIntervals.length - 1,
            Math.max(0, Math.ceil(sortedIntervals.length * fraction) - 1),
          )
        ]!;
        const sortedRenderCalls = [...renderCallMs].sort((first, second) => first - second);
        const renderPercentile = (fraction: number): number => sortedRenderCalls[
          Math.min(
            sortedRenderCalls.length - 1,
            Math.max(0, Math.ceil(sortedRenderCalls.length * fraction) - 1),
          )
        ]!;
        const overBudget = frameIntervalsMs.flatMap((intervalMs, frame) =>
          intervalMs > 16.67 ? [{ frame, intervalMs: Math.round(intervalMs * 100) / 100 }] : []);
        const histogram = [8.5, 12, 16.67, 20, 27.4].map((ceilingMs, index, ceilings) => ({
          band: index === 0 ? `<=${ceilingMs}` : `>${ceilings[index - 1]}..<=${ceilingMs}`,
          count: frameIntervalsMs.filter((intervalMs) =>
            intervalMs <= ceilingMs && (index === 0 || intervalMs > ceilings[index - 1]!)).length,
        }));
        histogram.push({
          band: ">27.4",
          count: frameIntervalsMs.filter((intervalMs) => intervalMs > 27.4).length,
        });
        console.info(`${shot.name}: motion interval diagnostic ${JSON.stringify({
          percentilesMs: {
            p50: Math.round(percentile(0.5) * 100) / 100,
            p75: Math.round(percentile(0.75) * 100) / 100,
            p90: Math.round(percentile(0.9) * 100) / 100,
            p95: Math.round(percentile(0.95) * 100) / 100,
            p99: Math.round(percentile(0.99) * 100) / 100,
          },
          histogram,
          overBudget,
          renderCallMs: {
            p95: Math.round(renderPercentile(0.95) * 100) / 100,
            max: Math.round(sortedRenderCalls[sortedRenderCalls.length - 1]! * 100) / 100,
          },
        })}`);
      }
      if (rawTiming.maxFrameMs > 50) {
        const worstFrameIndex = frameIntervalsMs.indexOf(rawTiming.maxFrameMs);
        const maxRenderCallMs = Math.max(...renderCallMs);
        const maxRenderCallFrameIndex = renderCallMs.indexOf(maxRenderCallMs);
        console.info(
          `${shot.name}: worst interval ${rawTiming.maxFrameMs.toFixed(2)} ms at frame `
          + `${worstFrameIndex}; synchronous render ${renderCallMs[worstFrameIndex]!.toFixed(2)} ms; `
          + `max synchronous render ${maxRenderCallMs.toFixed(2)} ms at frame `
          + `${maxRenderCallFrameIndex}`,
        );
      }

      // Temporal screenshots are deliberately a second, untimed loop.
      // drawImage/getImageData are synchronous GPU readbacks; doing 23 of
      // them between measured frames previously contaminated p95 and max.
      if (isMotion) {
        for (let frame = 0; frame < PERF_CAPTURE_TEMPORAL_FRAMES; frame += 1) {
          await nextAnimationFrame();
          renderer.render(advanceFrameState(), 1 / 60);
          resolvePresentedFrame();
          const rgba = copyContext.getImageData(0, 0, viewportWidth, viewportHeight).data;
          temporalFrames.push(luminanceFromRgba(rgba, viewportWidth, viewportHeight));
        }

        // The temporal loop is still moving the observer and can legitimately
        // enqueue the final terrain/detail frontier after the timed window has
        // ended. Hold the exact final pose and let that work publish before the
        // canonical screenshot is read. Requiring consecutive empty frames
        // catches a worker result which publishes one chunk and queues the next.
        // Always execute the full fixed count: frame-index/delta-driven systems
        // must receive the same number of updates on fast and slow machines.
        // Keep simulationTime fixed so this drain cannot select a different
        // visual moment merely because one machine needed more worker turns.
        const maxPostMotionDrainFrames = 600;
        const requiredStableDrainFrames = 30;
        let stableDrainFrames = 0;
        for (let frame = 0; frame < maxPostMotionDrainFrames; frame += 1) {
          await nextAnimationFrame();
          renderer.render(lastFrameState, 1 / 60);
          const drainDiagnostics = renderer.getDiagnostics();
          if (
            drainDiagnostics.pendingTerrainPages === 0
            && drainDiagnostics.pendingDetailWork === 0
          ) {
            stableDrainFrames += 1;
          } else {
            stableDrainFrames = 0;
          }
        }
        await renderer.waitForGpuIdleForCapture();
        const finalDrainDiagnostics = renderer.getDiagnostics();
        expect(
          stableDrainFrames,
          `${shot.name}: final-pose streaming work did not remain drained`,
        ).toBeGreaterThanOrEqual(requiredStableDrainFrames);
        expect(
          finalDrainDiagnostics.pendingTerrainPages,
          `${shot.name}: terrain remained pending after the fixed final-pose drain`,
        ).toBe(0);
        expect(
          finalDrainDiagnostics.pendingDetailWork,
          `${shot.name}: detail remained pending after the fixed final-pose drain`,
        ).toBe(0);
      }

      // Final frame and readback must share one task: the presented WebGPU
      // buffer is cleared once the compositor consumes it.
      renderer.render(lastFrameState, 1 / 60);
      resolvePresentedFrame();
      const pngBase64 = copy.toDataURL("image/png").split(",")[1]!;
      const rgba = copyContext.getImageData(0, 0, viewportWidth, viewportHeight).data;
      const luminance = luminanceFromRgba(rgba, viewportWidth, viewportHeight);

      const sceneDiagnostics = renderer.getDiagnostics();
      // 6-11.1: a sweep run never compares to a baseline. A different tier or
      // viewport draws a different world ON PURPOSE, so every SSIM would be a
      // false failure and a passing one would be the real surprise.
      const comparesToBaseline = !IS_SWEEP && !HIDE_VEGETATION && !SUN_OVERRIDDEN
        && (shot.comparesToBaseline ?? true);
      const baseline = !comparesToBaseline
        ? null
        : await readBaselinePixels(
            shot.name,
            viewportWidth,
            viewportHeight,
            !REBASELINE,
          );
      const ssim = baseline === null
        ? null
        : meanSsim(baseline.luminance, luminance, viewportWidth, viewportHeight);
      const rgbSsim = baseline === null
        ? null
        : meanRgbSsim(baseline.rgba, rgba, viewportWidth, viewportHeight);
      const lowerFrameY = Math.floor(viewportHeight * 0.4);
      const lowerFrameRgbSsim = baseline === null
        ? null
        : meanRgbSsim(baseline.rgba, rgba, viewportWidth, viewportHeight, {
            x: 0,
            y: lowerFrameY,
            width: viewportWidth,
            height: viewportHeight - lowerFrameY,
          });
      const worstTileSsim = baseline === null
        ? null
        : worstTileRgbSsim(baseline.rgba, rgba, viewportWidth, viewportHeight);

      if (REBASELINE) {
        candidateScreenshots.push({ name: shot.name, pngBase64 });
      } else {
        await commands.writeFile(`${ARTIFACT_DIR}/${shot.name}.png`, pngBase64, "base64");
      }

      let temporal: TemporalStability | undefined;
      if (temporalFrames.length >= 2) {
        temporal = temporalStability(temporalFrames, viewportWidth, viewportHeight);
      }

      shotReports.push({
        name: shot.name,
        worldEvolution: shotWorldEvolution,
        description: shot.description,
        ssimAgainstBaseline: ssim === null ? null : Math.round(ssim * 10_000) / 10_000,
        rgbSsimAgainstBaseline: rgbSsim === null
          ? null
          : Math.round(rgbSsim * 10_000) / 10_000,
        lowerFrameRgbSsimAgainstBaseline: lowerFrameRgbSsim === null
          ? null
          : Math.round(lowerFrameRgbSsim * 10_000) / 10_000,
        worstTileRgbSsimAgainstBaseline: worstTileSsim === null
          ? null
          : Math.round(worstTileSsim * 10_000) / 10_000,
        tiles: tileStatistics(luminance, viewportWidth, viewportHeight),
        fps: Math.round(measuredFps * 10) / 10,
        wallClockFps: rawTiming.wallClockFps,
        frameIntervalMsP95: rawTiming.frameIntervalMsP95,
        framesOver16_67Ms: rawTiming.framesOver16_67Ms,
        framesOver27_4Ms: rawTiming.framesOver27_4Ms,
        cpuFrameMsP95: timedDiagnostics.cpuP95Ms ?? timedDiagnostics.cpuFrameTime,
        gpuFrameMsP95: timedDiagnostics.gpuP95Ms,
        gpuTiming,
        presentWaitMsP95: timedDiagnostics.presentWaitP95Ms,
        maxFrameMs: rawTiming.maxFrameMs,
        p999FrameMs: timedDiagnostics.p999FrameMs === null
          ? null
          : Math.round(timedDiagnostics.p999FrameMs * 10) / 10,
        hitchCount: timedDiagnostics.hitchCount,
        drawCalls: sceneDiagnostics.drawCalls,
        vegetationBatches: sceneDiagnostics.vegetationBatches,
        triangles: sceneDiagnostics.triangles,
        residentTerrainPages: sceneDiagnostics.residentTerrainPages,
        pendingTerrainPages: sceneDiagnostics.pendingTerrainPages,
        pendingDetailWork: sceneDiagnostics.pendingDetailWork,
        streamingFramesUsed,
        streamingFrameBudget: maxStreamingFrames,
        renderPixels: sceneDiagnostics.renderPixels,
        renderScale: sceneDiagnostics.renderScale,
        viewportWidth,
        viewportHeight,
        estimatedGpuMemoryMiB: Math.round(sceneDiagnostics.estimatedGpuMemoryMiB * 10) / 10,
        inventoriedGpuMemoryMiB: Math.round(sceneDiagnostics.inventoriedGpuMemoryMiB * 10) / 10,
        // 4.5-C3: uncorrelated per-pass aggregates. Never compared against a
        // ceiling — they exist so the interval-versus-GPU gap is inspectable.
        gpuPassMs: {
          mainPass: round3(timedDiagnostics.gpuPassMs.mainPass),
          shadows: round3(timedDiagnostics.gpuPassMs.shadows),
          terrainCompute: round3(timedDiagnostics.gpuPassMs.terrainCompute),
          total: round3(timedDiagnostics.gpuPassMs.total),
        },
        ...(temporal ? { temporal } : {}),
      });
    }

    // Validation errors are delivered asynchronously. Make every shot submit
    // complete, then yield one task so `uncapturederror` reaches the dedicated
    // listener before any visual/performance assertion or candidate write.
    await renderer.waitForGpuIdleForCapture();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const report: PerfCaptureReport = {
      seed: PERF_CAPTURE_SEED,
      width: PERF_CAPTURE_WIDTH,
      height: PERF_CAPTURE_HEIGHT,
      warmupFrames: PERF_CAPTURE_WARMUP_FRAMES,
      measureFrames: PERF_CAPTURE_MEASURE_FRAMES,
      pageGenerationMs: Math.round(pageGenerationMs * 100) / 100,
      captureEnvironment: {
        adapter: renderer.getDiagnostics().adapter,
        devicePixelRatio: window.devicePixelRatio || 1,
        userAgent: navigator.userAgent,
        // 6-11.1: the report must name the configuration it actually measured,
        // or an archived tier row is indistinguishable from a tier-1 one.
        quality: CAPTURE_QUALITY,
        renderingMode: CAPTURE_MODE,
        tier: CAPTURE_PROFILE.tier,
        sweep: IS_SWEEP,
        pinnedRenderScale: CAPTURE_PROFILE.renderScale,
        gpuTimingEnabled: renderer.getGpuTimingStatusForCapture().enabled,
        // Whether the frame-delivery numbers below were contract or diagnostic.
        deliveryGatesEnforced: !UNPINNED_HOST,
      },
      shots: shotReports,
    };
    if (!REBASELINE) {
      await commands.writeFile(
        `${ARTIFACT_DIR}/report.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }

    /**
     * Write the reviewable artifacts BEFORE any assertion runs.
     *
     * This used to happen at the very end, which meant the first failing gate
     * threw and the run produced **no images at all** — the instrument withheld
     * its evidence exactly when something was wrong, and left "go and look at
     * the frames" impossible without first silencing the gate. Gate F hit this
     * within minutes: the eroded shots breached a memory ceiling and the run
     * died before writing a single eroded frame.
     *
     * A capture's frames are diagnostic input, not a reward for passing.
     *
     * The original ordering existed for a real reason — a failed run must not
     * leave a candidate that could be mistaken for an approved baseline — and
     * that property is KEPT, by an explicit status file rather than by
     * withholding the evidence. The directory is stamped NOT APPROVABLE here
     * and only restamped once every gate below has passed, so approvability is
     * something a promoter can read rather than infer from a file's existence.
     */
    const candidateId = new Date().toISOString().replaceAll(":", "-");
    const candidateDir = `${CANDIDATE_ROOT}/${candidateId}`;
    if (REBASELINE) {
      for (const screenshot of candidateScreenshots) {
        await commands.writeFile(
          `${candidateDir}/${screenshot.name}.png`,
          screenshot.pngBase64,
          "base64",
        );
      }
      await commands.writeFile(
        `${candidateDir}/report.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
      await commands.writeFile(
        `${candidateDir}/STATUS.txt`,
        "NOT APPROVABLE — the capture's gates had not been evaluated when these\n"
        + "frames were written. If this file still says NOT APPROVABLE, the run\n"
        + "FAILED a gate: read the failure, and do not promote this directory.\n"
        + "The frames are here for diagnosis, which is why they are written\n"
        + "before the gates rather than after them.\n",
      );
      console.info(`Reviewable candidate frames written to ${candidateDir}`);
    }

    expect(shotReports).toHaveLength(SELECTED_SHOTS.length);
    // Renderer errors invalidate every pixel and timing metric. Surface them
    // before SSIM/performance assertions so a broken render pass cannot be
    // misdiagnosed as an ordinary visual or frame-rate regression.
    expect(
      gpuUncapturedErrors,
      "WebGPU reported uncaptured errors during the capture (rejected-submit/black-frame gate)",
    ).toEqual([]);
    expect(
      consoleErrors,
      "The renderer logged console errors during the capture (Z-1 gate)",
    ).toEqual([]);
    expect(
      loggerErrors,
      "Babylon logged errors during the capture (Z-1 gate)",
    ).toEqual([]);

    /**
     * Delivery contracts, run as assertions on the reference adapter and as
     * a report everywhere else. Wrapping the ORIGINAL assertion (rather than
     * recomputing a boolean) keeps one authority for each contract and one
     * wording for each failure, so the note an unpinned host prints is the
     * exact sentence the reference adapter would have failed with.
     */
    const unpinnedDeliveryNotes: string[] = [];
    const gateDelivery = (assertion: () => void): void => {
      if (!UNPINNED_HOST) {
        assertion();
        return;
      }
      try {
        assertion();
      } catch (error) {
        unpinnedDeliveryNotes.push(error instanceof Error ? error.message : String(error));
      }
    };

    for (let index = 0; index < shotReports.length; index += 1) {
      const definition = SELECTED_SHOTS[index]!;
      const shot = shotReports[index]!;
      // Z-1: the pinned shipping scale must hold. Rendered dimensions round
      // independently, so permit only a small integer-size tolerance.
      // 6-11.1: the tier's own pixel CAP bounds this, and above the cap the
      // renderer scales down regardless of the pinned scale. Without the cap
      // term this assertion fails on any swept viewport larger than the tier
      // allows — and it fails describing a scale error rather than the cap,
      // which is what it actually is.
      //
      // Worth knowing beyond the assertion: because the cap binds, the three
      // viewport columns do NOT measure three resolutions at every tier. At
      // tier 1 (1.5 Mpx) both 1080p and 1440p render at the cap, so those two
      // columns are the same workload with different presentation.
      const expectedRenderPixels = Math.min(
        shot.viewportWidth * shot.viewportHeight * shot.renderScale ** 2,
        CAPTURE_PROFILE.maxRenderPixels,
      );
      expect(
        Math.abs(shot.renderPixels - expectedRenderPixels) / expectedRenderPixels,
        `${shot.name}: renderPixels must match the medium/balanced scale pin`,
      ).toBeLessThan(0.01);
      expect(shot.renderScale).toBeCloseTo(
        definition.captureRenderScale ?? CAPTURE_PROFILE.renderScale,
        6,
      );
      expect(
        perfCaptureImageContentFailures(shot.tiles, definition),
        `${shot.name}: screenshot is blank or lacks local visual structure`,
      ).toEqual([]);
      if (shot.ssimAgainstBaseline !== null && !REBASELINE) {
        expect(
          shot.ssimAgainstBaseline,
          `${shot.name} diverged from the committed baseline — a regression unless this is `
          + "a sanctioned churn point (then generate and review a perf:capture:candidate)",
        ).toBeGreaterThanOrEqual(definition.ssimThreshold ?? PERF_CAPTURE_SSIM_THRESHOLD);
      }
      if (shot.rgbSsimAgainstBaseline !== null && !REBASELINE) {
        expect(
          shot.rgbSsimAgainstBaseline,
          `${shot.name}: RGB/chroma diverged from the committed baseline`,
        ).toBeGreaterThanOrEqual(
          definition.rgbSsimThreshold ?? PERF_CAPTURE_RGB_SSIM_THRESHOLD,
        );
        expect(
          shot.lowerFrameRgbSsimAgainstBaseline,
          `${shot.name}: nearby terrain/foliage diverged even if the sky remained stable`,
        ).toBeGreaterThanOrEqual(
          definition.lowerFrameRgbSsimThreshold
            ?? PERF_CAPTURE_LOWER_FRAME_RGB_SSIM_THRESHOLD,
        );
        expect(
          shot.worstTileRgbSsimAgainstBaseline,
          `${shot.name}: a local visual regression was diluted by the whole-frame score`,
        ).toBeGreaterThanOrEqual(
          definition.worstTileRgbSsimThreshold
            ?? PERF_CAPTURE_WORST_TILE_RGB_SSIM_THRESHOLD,
        );
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
      // The tier-1 medium/balanced delivery contract is intentionally raw:
      // no percentile trimming may hide a freeze or a run that averages 59.9.
      // 6-11.1: judged at THIS tier's own contract. Off the sweep that is
      // byte-for-byte tier 1's, so the standing gate is unchanged; on it, a
      // tier-3 run is held to 30 fps rather than failed for not being tier 1.
      gateDelivery(() => expect(
        deliveryFailuresAgainst(DELIVERY, {
          wallClockFps: shot.wallClockFps,
          frameIntervalMsP95: shot.frameIntervalMsP95,
          framesOver27_4Ms: shot.framesOver27_4Ms,
          maxFrameMs: shot.maxFrameMs,
        }),
        `${shot.name}: strict tier-${CAPTURE_PROFILE.tier} `
        + `${CAPTURE_QUALITY}/${CAPTURE_MODE} frame-delivery gate failed`,
      ).toEqual([]));

      // Z-2: retain the historical per-shot gate as a diagnostic regression
      // contract in addition to (never instead of) the strict tier-1 gate.
      //
      // `6-11.1`: SKIPPED under the sweep, and this is not a convenience.
      // These per-shot floors were pinned from tier-1 captures at 1280x720
      // (Gate 0-a, and re-pinned at each rebaseline point from >=3 runs of that
      // same configuration). They are statements about ONE tier at ONE
      // viewport. Judging a tier-3 Ultra row — which promises 30 fps against
      // `FRAME_TARGET_MS[3]` — against tier 1's ~101 fps floor would fail it for
      // being Ultra, and judging any row at 1080p or 1440p against a 720p floor
      // fails it for the resolution it was asked to render. Either would be a
      // false failure that reads exactly like a real one.
      //
      // Delivery is still gated under the sweep: `deliveryFailuresAgainst`
      // above holds every row to ITS OWN tier's contract. This block is the
      // tier-1 regression pin, and a sweep row is not a tier-1 regression.
      const ceilings = IS_SWEEP ? null : definition.ceilings;
      if (ceilings !== null) {
        gateDelivery(() => expect(
          shot.fps,
          `${shot.name}: measured fps fell below the committed floor`,
        ).toBeGreaterThanOrEqual(ceilings.minFps));
        gateDelivery(() => expect(
          shot.hitchCount,
          `${shot.name}: more hitch frames than the committed ceiling`,
        ).toBeLessThanOrEqual(ceilings.hitchCount));
        gateDelivery(() => expect(
          shot.maxFrameMs,
          `${shot.name}: worst frame exceeded the committed ceiling`,
        ).toBeLessThanOrEqual(ceilings.maxFrameMs));
        // `ceilings.p999FrameMs` absent = deliberately not gated yet (see
        // TAIL_DEFERRED_SHOTS); `shot.p999FrameMs` null = the run produced no
        // reading. Different causes, same skip, so keep them separate.
        const p999Ceiling = ceilings.p999FrameMs;
        if (shot.p999FrameMs !== null && p999Ceiling !== undefined) {
          gateDelivery(() => expect(
            shot.p999FrameMs,
            `${shot.name}: p999 frame exceeded the committed ceiling`,
          ).toBeLessThanOrEqual(p999Ceiling));
        }
        // Gate 0-a (Phase 6): floors pinned at today's delivery, not the
        // 60 fps contract minimum — the strict gate alone would let the
        // phase shed ~45% of current delivery with everything green.
        gateDelivery(() => expect(
          shot.wallClockFps,
          `${shot.name}: wall-clock fps fell below the committed floor`,
        ).toBeGreaterThanOrEqual(ceilings.minWallClockFps));
        const p95Ceiling = ceilings.maxFrameIntervalMsP95;
        if (p95Ceiling !== undefined) {
          gateDelivery(() => expect(
            shot.frameIntervalMsP95,
            `${shot.name}: frame-interval p95 exceeded the committed ceiling`,
          ).toBeLessThanOrEqual(p95Ceiling));
        }
      }
      // Gate 0-a: drawCalls is a host-independent counter (byte-identical
      // across the pinning runs), so it stays hard on every host, outside
      // the nullable delivery row.
      //
      // HOST-independent is not TIER-independent, and the ceiling is pinned
      // from tier 1 at 1280x720. Tier 2 submits roughly ten times tier 1's
      // vegetation draws BY DESIGN (507.6 against 53.3 modelled), and the
      // measured tier-3 rows ran 197-533 draws against ceilings of 122-161.
      // Applied under a sweep, this ceiling fails every row of every higher
      // tier for being that tier -- a false failure that reads exactly like a
      // real regression, on the axis the sweep exists to vary.
      //
      // The original comment is not wrong; it reasons about the host axis and
      // is silent about the tier axis. That silence is the defect: a scope
      // claim that names one axis reads as though it had considered them all.
      // Same fix and same reason as `ceilings` above -- a sweep row is not a
      // tier-1 regression, and `deliveryFailuresAgainst` still holds every row
      // to its own tier's contract.
      if (!IS_SWEEP && definition.drawCallCeiling !== undefined) {
        expect(
          shot.drawCalls,
          `${shot.name}: more draw calls than the committed ceiling`,
        ).toBeLessThanOrEqual(definition.drawCallCeiling);
      }
      // Gate 0-c (Phase 6, = 6-11.4a): the Babylon inventory floor is the
      // real memory number — only the ~380 MiB estimate gates the 480 MiB
      // ceiling while the inventory reads 489 MiB at the binding shot.
      // Hard on every host: the settle loop guarantees pendingDetailWork=0,
      // so allocations converge identically.
      //
      // `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB` is 495, pinned from tier 1
      // where real headroom is 2.7 MiB. Higher tiers legitimately allocate far
      // more -- `MEMORY_CEILING_MIB` is 260/480/700/1000 -- and the measured
      // tier-3 rows read 650.5-661.7 MiB. Under a sweep this ceiling therefore
      // fails every row above tier 1 for being above tier 1.
      //
      // The ceiling is NOT swapped for the tier's own: that constant gates the
      // ESTIMATE, this one gates the Babylon INVENTORY, and the docblock on the
      // constant says explicitly that the two measure different quantities and
      // must never be compared. Substituting one for the other would be a
      // fabricated threshold wearing a real one's name. So the sweep keeps the
      // plausibility check -- a non-finite or non-positive reading is still a
      // broken instrument at any tier -- and drops only the tier-1 regression
      // pin, which a sweep row is not.
      expect(
        inventoriedMemoryFailures(
          shot.inventoriedGpuMemoryMiB,
          IS_SWEEP ? Number.POSITIVE_INFINITY : undefined,
        ),
        `${shot.name}: inventoried GPU memory breached the pinned ceiling`,
      ).toEqual([]);
      // 4-10 (assertion 84b): page residency under streaming load. The
      // page-thrash and CDLOD-transition scenes exist to make a pump that
      // outruns the compute meter visible as a rising queue rather than as a
      // hitch nobody can attribute.
      const residency = definition.residencyCeilings;
      expect(
        shot.pendingDetailWork,
        `${shot.name}: detail generation/presentation was still pending at capture`,
      ).toBe(0);
      /**
       * Terrain, made symmetric with detail above — a shot's pixels are only
       * meaningful if the world had finished building when they were read.
       *
       * This was previously asserted ONLY inside the motion branch's final-pose
       * drain, so the 24 static shots recorded `pendingTerrainPages` in the
       * report and asserted nothing against it. A static shot that exhausted
       * `maxStreamingFrames` therefore screenshotted a HALF-BUILT world, wrote
       * the number that proved it into the report, and passed — and Gate F's
       * eroded shots are exactly the ones close enough to the budget for that
       * to happen (168 pages × ~31 frames/page = 5,208 of 6,000). The very
       * first eroded reference images could have been frames of a world that
       * had not finished streaming.
       *
       * The two streaming-stress shots keep their explicit allowance: a rising
       * queue is the phenomenon they exist to measure. Everything else must be
       * done, and the failure is loud rather than a number in a report.
       */
      if (!residency) {
        expect(
          shot.pendingTerrainPages,
          `${shot.name}: terrain was still streaming when the frame was read — `
          + "this shot's pixels are of a half-built world. Raise "
          + "maxStreamingFrames, or reduce the shot's working set.",
        ).toBe(0);
      }
      /**
       * The margin, asserted rather than discovered.
       *
       * Finishing inside the budget is necessary but not reassuring on its own:
       * the failure above only fires once a shot has ALREADY crossed, and by
       * then a reviewer is looking at a half-built frame and wondering why the
       * terrain changed. This fails while there is still room, so the shot that
       * is creeping toward the cap is caught on the run before the one that
       * exceeds it.
       */
      const streamingUsedFraction = shot.streamingFramesUsed / shot.streamingFrameBudget;
      expect(
        streamingUsedFraction,
        `${shot.name}: used ${shot.streamingFramesUsed} of ${shot.streamingFrameBudget} `
        + "streaming frames to settle. That is most of the budget, and the next "
        + "increase in this shot's working set will exhaust it and screenshot a "
        + "half-built world. Raise the budget now.",
      ).toBeLessThan(0.75);
      if (residency) {
        // Queue DEPTH is what the wall-clock compute meter admits per frame,
        // so it follows the host the same way the delivery rows do.
        gateDelivery(() => expect(
          shot.pendingTerrainPages,
          `${shot.name}: more pages pending generation than the committed ceiling`,
        ).toBeLessThanOrEqual(residency.maxPendingTerrainPages));
        // Atlas OCCUPANCY is a capacity bound. It stays hard on every host.
        expect(
          shot.residentTerrainPages,
          `${shot.name}: more resident page slots than the atlas holds`,
        ).toBeLessThanOrEqual(residency.maxResidentTerrainPages);
      }
    }

    // Never silent. An unpinned run states every contract it declined to
    // enforce, so "green on CI" can never be read as "met the tier-1 bar".
    if (UNPINNED_HOST) {
      console.info(
        `frame-delivery contracts were NOT enforced (VITE_PERF_UNPINNED_HOST=1): `
        + `${unpinnedDeliveryNotes.length} would have failed on the pinned reference adapter`
        + (unpinnedDeliveryNotes.length === 0
          ? ""
          : `\n${unpinnedDeliveryNotes.map((note) => `  - ${note}`).join("\n")}`),
      );
    }

    if (REBASELINE) {
      expect(
        candidateScreenshots.map(({ name }) => name),
        "A rebaseline candidate must contain the exact full canonical shot set",
      ).toEqual(PERF_CAPTURE_SHOTS.map(({ name }) => name));

      // Every gate above passed, so this directory becomes approvable. The
      // frames themselves were written before the gates ran (see the STATUS
      // note there); reaching this line is what makes them promotable, and the
      // stamp says so explicitly rather than leaving it to be inferred from the
      // directory existing at all. Each run gets a fresh directory, so a failed
      // retry cannot make an older candidate look newly generated, and the
      // committed baseline directory still has no write path.
      await commands.writeFile(
        `${candidateDir}/STATUS.txt`,
        `APPROVABLE — every capture gate passed on ${candidateId}.\n`
        + "Reviewed frames may be promoted to tests/perf/baseline/.\n",
      );
      console.info(`Rebaseline candidate PASSED all gates: ${candidateDir}`);
    }
  }, 1_500_000);
});
