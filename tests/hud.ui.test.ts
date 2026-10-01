import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  INITIAL_VISUAL_STATE,
  type CameraMode,
  type RenderDiagnostics,
} from "../src/game/types";
import type { AircraftKind } from "../src/sim";
import { Hud } from "../src/ui/Hud";

function renderHud(
  cameraMode: CameraMode,
  crashed = false,
  aircraft: AircraftKind = "trainer",
  stateOverrides: Partial<typeof INITIAL_VISUAL_STATE> = {},
): string {
  return renderToStaticMarkup(createElement(Hud, {
    state: {
      ...INITIAL_VISUAL_STATE,
      crashed,
      onGround: crashed,
      stalled: crashed,
      bank: crashed ? 82 : 0,
      engineRpm: aircraft === "jet" ? 80 : INITIAL_VISUAL_STATE.engineRpm,
      ...stateOverrides,
    },
    aircraft,
    mode: "full",
    flightMode: "unassisted",
    units: "aviation",
    diagnostics: null,
    showDiagnostics: false,
    cameraMode,
    cameraLabel: cameraMode === "cinematic" ? "ORBIT CAM" : "CHASE CAM",
    seedLabel: "AUD1T0",
    mouseFlight: false,
  }));
}

describe("flight HUD camera and terminal-state presentation", () => {
  it("shows the fixed aircraft reticle in chase view but removes it from orbit view", () => {
    expect(renderHud("chase")).toContain("attitude__aircraft");
    const orbit = renderHud("cinematic");
    expect(orbit).not.toContain("attitude__aircraft");
    expect(orbit).toContain("ORBIT CAM");
  });

  it("shows only the terminal reset alert after a crash", () => {
    const crashed = renderHud("chase", true);
    expect(crashed).toContain("AIRCRAFT DAMAGED · PRESS R");
    expect(crashed).not.toContain("STALL · LOWER NOSE");
    expect(crashed).not.toContain("BANK ANGLE");
  });

  it("keeps the flight HUD focused on pilot-facing controls", () => {
    const markup = renderHud("chase");
    expect(markup).toContain("Shift power · Ctrl reduce");
    expect(markup).not.toContain("+ power · − reduce");
    // The flap block came back on 2026-09-30 (Jason): the keys worked and nothing on screen said so.
    expect(markup).toContain("F flaps down · V up");
    expect(markup).not.toContain(">BRK<");
    expect(markup).not.toContain("hud-brand");
    expect(markup).not.toContain("AEROLITH");
  });

  it("uses propulsion-correct engine instrumentation", () => {
    const trainer = renderHud("chase");
    expect(trainer).toContain("<small>RPM</small>");
    expect(trainer).toContain("<em>PROP</em>");

    const jet = renderHud("chase", false, "jet");
    expect(jet).toContain("<small>N2</small>");
    expect(jet).toContain("<strong>80</strong>");
    expect(jet).toContain("<em>%</em>");
    expect(jet).not.toContain("<em>PROP</em>");
  });

  it("shows jet gear state and context-aware braking controls", () => {
    const airborne = renderHud("chase", false, "jet", { gear: 0.45, brake: 1, onGround: false });
    expect(airborne).toContain("GEAR");
    expect(airborne).toContain("TRANSIT");
    expect(airborne).toContain("45%");
    expect(airborne).toContain("SPEED BRAKE");
    expect(airborne).toContain("G gear · Space speed / wheel brake");

    const rollout = renderHud("chase", false, "jet", { gear: 1, brake: 1, onGround: true });
    expect(rollout).toContain("DOWN");
    expect(rollout).toContain("SPEED + WHEEL BRAKE");
  });

  it("shows where the flap panels are on every airframe, and the keys that move them", () => {
    const flapBlock = (flaps: number, aircraft: AircraftKind = "airliner") => {
      const markup = renderHud("chase", false, aircraft, { flaps });
      const match = /<div class="instrument-readout" aria-label="Flaps ([a-z]+)"><small>FLAPS<\/small><strong>([A-Z]+)<\/strong><em>([^<]+)<\/em><\/div>/.exec(markup);
      expect(match, `${aircraft} at flaps ${flaps}`).not.toBeNull();
      return { spoken: match![1], shown: match![2], under: match![3] };
    };
    // The three detents the lever has, read off the panels.
    expect(flapBlock(0)).toEqual({ spoken: "up", shown: "UP", under: "F DN · V UP" });
    expect(flapBlock(0.5)).toEqual({ spoken: "half", shown: "HALF", under: "F DN · V UP" });
    expect(flapBlock(1)).toEqual({ spoken: "full", shown: "FULL", under: "F DN · V UP" });
    // Between detents the panels are still running: say so, with how far.
    expect(flapBlock(0.76)).toEqual({ spoken: "moving", shown: "MOVING", under: "76%" });
    expect(flapBlock(0.25)).toEqual({ spoken: "moving", shown: "MOVING", under: "25%" });
    // Every airframe has flaps, the fixed-gear trainer included.
    for (const aircraft of ["trainer", "jet", "bizjet", "airliner"] as const) {
      expect(flapBlock(0.5, aircraft).shown).toBe("HALF");
      expect(renderHud("chase", false, aircraft)).toContain("<span>F flaps down · V up</span>");
    }
    // The block sits last in the strip, after the gear where there is one.
    const jet = renderHud("chase", false, "jet");
    expect(jet.indexOf("<small>GEAR</small>")).toBeGreaterThan(0);
    expect(jet.indexOf("<small>FLAPS</small>")).toBeGreaterThan(jet.indexOf("<small>GEAR</small>"));
  });

  it("reports the active WebGPU profile and compute workloads", () => {
    const diagnostics: RenderDiagnostics = {
      residencyReasons: { drawn: 0, parent: 0, collision: 0, seed: 0, drawnBeyondShadowDistance: 0 },
      fps: 58,
      frameTime: 17.2,
      drawCalls: 42,
      triangles: 180_000,
      geometries: 18,
      textures: 14,
      terrainTiles: 36,
      requestedRenderingMode: "ultra",
      renderBackend: "webgpu",
      renderTechnique: "forward-spectral-volumetric",
      renderScale: 0.86,
      cpuFrameTime: 4.2,
      gpuFrameTime: 11.8,
      presentWaitTime: 5.4,
      visibleInstances: 24_500,
      vegetationBatches: 24,
      activeAnimals: 48,
      riverCount: 9,
      lakeCount: 3,
      hydrologyMainThreadFallback: false,
      hydrologyLastGenerationUsedWorker: true,
      residentTerrainPages: 42,
    collisionSamplesServedByFallback: 0,
      cloudResolutionScale: 0.5,
      cloudRaySteps: 72,
      oceanFftCascades: 4,
      oceanFftResolution: 256,
      adapter: "Test GPU",
      renderingFallbackReason: null,
      activeGovernor: "cpu-work",
      gpuP95Ms: 9.4,
      cpuP95Ms: 15.6,
      frameIntervalP95Ms: 24.8,
      presentWaitP95Ms: 9.2,
      maxFrameMs: 41.5,
      p999FrameMs: 38.2,
      hitchCount: 2,
      cpuWorkLevel: 3,
      cpuWorkLever: "terrain-page-requests",
      gpuWorkLevel: 1,
      resolutionInsensitive: true,
      renderPixels: 1_480_000,
      topPassesByCpuMs: [
        { name: "world-page-visibility", p95Ms: 3.7 },
        { name: "volumetric-cloud-integration", p95Ms: 1.2 },
      ],
      pendingTerrainPages: 5,
      pendingDetailWork: 0,
      terrainComputeDispatches: 4,
      estimatedGpuMemoryMiB: 402.4,
      // Below the unrestricted figure, as the real one always is: misc, the
      // eroded-only reservations and the slack factor are out of it.
      estimatedInventoriableGpuMemoryMiB: 306.9,
      inventoriedGpuMemoryMiB: 312.9,
      // Lanes sum to the total above, as the real walk's do — a fixture whose
      // parts contradict its whole would let a reconciliation check pass here
      // and fail on any real frame.
      inventoriedGpuMemoryLanes: { textureMiB: 280.4, geometryMiB: 24.5, bufferMiB: 8.0 },
      budgetProbeActive: false,
      budgetProbeReport: [{ pass: "world-page-visibility", gpuP95DeltaMs: 0.6 }],
      gpuPassMs: { mainPass: 8.1, shadows: 1.4, terrainCompute: 1.9, total: 11.4 },
    };
    const markup = renderToStaticMarkup(createElement(Hud, {
      state: INITIAL_VISUAL_STATE,
      aircraft: "trainer",
      mode: "full",
      flightMode: "unassisted",
      units: "aviation",
      diagnostics,
      showDiagnostics: true,
      cameraMode: "chase",
      cameraLabel: "CHASE CAM",
      seedLabel: "AUD1T0",
      mouseFlight: false,
      onRunBudgetProbe: () => undefined,
    }));

    expect(markup).toContain("WEBGPU · WEBGPU FORWARD / SPECTRAL / VOLUMETRIC");
    expect(markup).toContain("ULTRA · 4×256² FFT · 72 cloud steps");
    expect(markup).toContain("24,500 detail instances · 48 animals · 9 rivers / 3 lakes");
    expect(markup).not.toContain("WATER GEN ON MAIN THREAD");
    // A main-thread hydrology fallback is a standing hitch source: say so.
    const fallbackMarkup = renderToStaticMarkup(createElement(Hud, {
      state: INITIAL_VISUAL_STATE,
      aircraft: "trainer",
      mode: "full",
      flightMode: "unassisted",
      units: "aviation",
      diagnostics: { ...diagnostics, hydrologyMainThreadFallback: true },
      showDiagnostics: true,
      cameraMode: "chase",
      cameraLabel: "CHASE CAM",
      seedLabel: "AUD1T0",
      mouseFlight: false,
      onRunBudgetProbe: () => undefined,
    }));
    expect(fallbackMarkup).toContain("9 rivers / 3 lakes · WATER GEN ON MAIN THREAD");
    expect(markup).toContain("Test GPU");
    expect(markup).toContain("17.2 ms frame");
    expect(markup).toContain("4.2 ms CPU");
    expect(markup).toContain("11.8 ms GPU");
    expect(markup).toContain("5.4 ms present wait");
    // 1A-6b: the user must be able to see why the picture changed.
    expect(markup).toContain("GOV CPU-WORK");
    expect(markup).toContain("RES-INSENSITIVE");
    expect(markup).toContain("cpu L3 · gpu L1 (terrain-page-requests)");
    expect(markup).toContain("42 ms max · 38 ms p999 · 2 hitches");
    expect(markup).toContain("9.4 ms GPU p95");
    expect(markup).toContain("15.6 ms CPU p95");
    expect(markup).toContain("24.8 ms interval p95 · 9.2 ms present wait p95");
    expect(markup).toContain("1.48 Mpx");
    // 4-4: the CPU worker pool is gone; the HUD reports GPU dispatches.
    expect(markup).toContain("5 pending · 4 dispatches");
    expect(markup).toContain("~402 MiB est");
    expect(markup).toContain("world-page-visibility 3.7 · volumetric-cloud-integration 1.2 ms CPU p95");
    expect(markup).toContain("RUN GPU BUDGET PROBE");
    expect(markup).toContain("world-page-visibility 0.6 ms GPU");
  });
});
