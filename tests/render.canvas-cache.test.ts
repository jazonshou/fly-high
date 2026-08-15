import { describe, expect, it } from "vitest";
import { shouldRefreshCanvasRidgeProfiles } from "../src/render/CanvasFlightRenderer";

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
});
