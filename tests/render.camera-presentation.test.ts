import { describe, expect, it } from "vitest";
import { shouldStabilizeCameraHorizon } from "../src/render/cameraPresentation";

describe("camera presentation", () => {
  it("stabilizes exterior views while preserving cockpit roll", () => {
    expect(shouldStabilizeCameraHorizon("chase", true)).toBe(true);
    expect(shouldStabilizeCameraHorizon("cinematic", true)).toBe(true);
    expect(shouldStabilizeCameraHorizon("cockpit", true)).toBe(false);
  });

  it("retains aircraft roll when stabilization is disabled", () => {
    expect(shouldStabilizeCameraHorizon("chase", false)).toBe(false);
    expect(shouldStabilizeCameraHorizon("cinematic", false)).toBe(false);
  });
});
