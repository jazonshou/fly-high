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

  it("reports the requested mode separately from the effective backend and technique", () => {
    const diagnostics: RenderDiagnostics = {
      fps: 58,
      frameTime: 17.2,
      drawCalls: 42,
      triangles: 180_000,
      geometries: 18,
      textures: 14,
      terrainTiles: 36,
      requestedRenderingMode: "ray-traced",
      renderBackend: "webgl2",
      renderTechnique: "ray-marched-screen-space",
      hardwareRayTracing: false,
      renderingFallbackReason:
        "No WebGPU ray-query backend is active; using half-resolution screen-space ray marching.",
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
    }));

    expect(markup).toContain("WEBGL2 · SCREEN-SPACE RAY MARCH");
    expect(markup).toContain("Requested: screen-space ray march · Hardware RT: OFF");
    expect(markup).not.toContain("Requested: ray-traced");
    expect(markup).toContain("No WebGPU ray-query backend is active");
    expect(markup).not.toContain("hardware ray tracing enabled");
  });
});
