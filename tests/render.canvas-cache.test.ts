import { describe, expect, it } from "vitest";
import { keyboardRollDirection } from "../src/input";
import {
  canvasAircraftScreenPose,
  shouldRefreshCanvasRidgeProfiles,
} from "../src/render/CanvasFlightRenderer";
import { requestedRenderingTelemetryKey } from "../src/render/types";

describe("Canvas scenery sampling cadence", () => {
  const stable = {
    hasProfiles: true,
    anchorX: 0,
    anchorZ: 0,
    cachedHeading: 0,
    lastRefreshTime: 10,
    positionX: 0,
    positionZ: 0,
    heading: 0,
    simulationTime: 11,
  };

  it("samples once initially and not on ordinary render frames", () => {
    expect(shouldRefreshCanvasRidgeProfiles({ ...stable, hasProfiles: false })).toBe(true);
    expect(
      shouldRefreshCanvasRidgeProfiles({
        ...stable,
        positionX: 120,
        heading: Math.PI / 60,
      }),
    ).toBe(false);
  });

  it("requires meaningful movement or heading and enforces a minimum cadence", () => {
    expect(
      shouldRefreshCanvasRidgeProfiles({
        ...stable,
        positionX: 400,
        simulationTime: 10.1,
      }),
    ).toBe(false);
    expect(
      shouldRefreshCanvasRidgeProfiles({
        ...stable,
        positionX: 400,
        simulationTime: 10.4,
      }),
    ).toBe(true);
    expect(
      shouldRefreshCanvasRidgeProfiles({
        ...stable,
        heading: Math.PI / 24,
        simulationTime: 10.4,
      }),
    ).toBe(true);
  });

  it("centres chase flight on the HUD and presents A/D with pilot-facing bank signs", () => {
    const left = canvasAircraftScreenPose(
      1_600,
      900,
      keyboardRollDirection("KeyA") * 20,
      false,
    );
    const right = canvasAircraftScreenPose(
      1_600,
      900,
      keyboardRollDirection("KeyD") * 20,
      false,
    );

    expect(left.centerX).toBe(800);
    expect(left.centerY).toBe(450);
    expect(left.rotation).toBeLessThan(0);
    expect(right.rotation).toBeGreaterThan(0);

    // Orbit composition stays intentionally offset because Hud removes its
    // fixed aircraft reticle in cinematic mode.
    expect(canvasAircraftScreenPose(1_600, 900, 0, true)).toMatchObject({
      centerX: 688,
      centerY: 513,
    });
  });

  it("does not expose the legacy ray-traced storage key as an effective request claim", () => {
    expect(requestedRenderingTelemetryKey("ray-traced")).toBe("screen-space-ray-marching");
    expect(requestedRenderingTelemetryKey("hybrid")).toBe("hybrid");
    expect(requestedRenderingTelemetryKey("balanced")).toBe("balanced");
  });
});
