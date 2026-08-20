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
    expect(markup).not.toContain(">FLAP<");
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

  it("reports the active WebGPU profile and compute workloads", () => {
    const diagnostics: RenderDiagnostics = {
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
      terrainWorkersBusy: 4,
      estimatedGpuMemoryMiB: 402.4,
      inventoriedGpuMemoryMiB: 312.9,
      budgetProbeActive: false,
      budgetProbeReport: [{ pass: "world-page-visibility", gpuP95DeltaMs: 0.6 }],
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
    expect(markup).toContain("5 pending · 4 workers");
    expect(markup).toContain("~402 MiB est");
    expect(markup).toContain("world-page-visibility 3.7 · volumetric-cloud-integration 1.2 ms CPU p95");
    expect(markup).toContain("RUN GPU BUDGET PROBE");
    expect(markup).toContain("world-page-visibility 0.6 ms GPU");
  });
});
