import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLD_START_MIN_FOREGROUND_DETAIL_FRACTION,
  coldStartFrameCompletenessFailures,
  drainFenceAndErrorDeliveryTurn,
  settleWithin,
} from "../scripts/coldStartHarness.mts";
import {
  lowerOuterHorizontalDetailFraction,
  luminanceFromRgba,
  perfCaptureImageContentFailures,
  tileStatistics,
} from "../scripts/perf-capture.mts";

function structuredAtmosphereEvidence(terrainTiles: number) {
  const width = 128;
  const height = 128;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Horizontally mottled bands: deliberately enough distributed structure
      // to defeat both pixel-only gates while still containing no ground.
      const value = 55
        + (Math.floor(y / 16) % 2) * 24
        + ((Math.floor(x / 4) + Math.floor(y / 9)) % 2) * 36;
      rgba.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  const luminance = luminanceFromRgba(rgba, width, height);
  return {
    imageContentFailures: perfCaptureImageContentFailures(
      tileStatistics(luminance, width, height),
    ),
    foregroundDetailFraction: lowerOuterHorizontalDetailFraction(luminance, width, height),
    terrainTiles,
  };
}

describe("cold-start frame completeness", () => {
  it("rejects a horizontally structured atmosphere-only adversary", () => {
    const evidence = structuredAtmosphereEvidence(0);

    // These assertions make the adversary discriminating: both pre-existing
    // pixel gates accept it, so only the real terrain draw signal rejects it.
    expect(evidence.imageContentFailures).toEqual([]);
    expect(evidence.foregroundDetailFraction)
      .toBeGreaterThan(COLD_START_MIN_FOREGROUND_DETAIL_FRACTION);
    expect(coldStartFrameCompletenessFailures(evidence)).toEqual([
      expect.stringContaining("does not contain a CDLOD terrain node"),
    ]);
  });

  it("requires the pixel evidence even when terrain nodes were drawn", () => {
    expect(coldStartFrameCompletenessFailures({
      imageContentFailures: ["structured tile fraction is too low"],
      foregroundDetailFraction: 0,
      terrainTiles: 24,
    })).toEqual([
      "structured tile fraction is too low",
      expect.stringContaining("lower-frame detail fraction"),
    ]);
  });

  it("accepts agreeing structural and pixel evidence without a colour heuristic", () => {
    expect(coldStartFrameCompletenessFailures({
      imageContentFailures: [],
      foregroundDetailFraction: 0.2,
      terrainTiles: 24,
    })).toEqual([]);
  });
});

describe("cold-start bounded fence teardown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a deferred fence resolution and the following delivery turn", async () => {
    let resolveFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      resolveFence = resolve;
    });
    let completed = false;
    const draining = drainFenceAndErrorDeliveryTurn(fence, 1_000);
    const observed = draining.then((result) => {
      completed = true;
      return result;
    });

    resolveFence();
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    await expect(observed).resolves.toBe("settled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a deferred fence rejection and still waits for the delivery turn", async () => {
    let rejectFence!: (reason: unknown) => void;
    const fence = new Promise<void>((_resolve, reject) => {
      rejectFence = reject;
    });
    let completed = false;
    const draining = drainFenceAndErrorDeliveryTurn(fence, 1_000);
    const observed = draining.then((result) => {
      completed = true;
      return result;
    });

    rejectFence(new Error("device destroyed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    await expect(observed).resolves.toBe("settled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a never-settling fence and takes one delivery turn afterward", async () => {
    let completed = false;
    const draining = drainFenceAndErrorDeliveryTurn(new Promise<void>(() => undefined), 1_000);
    const observed = draining.then((result) => {
      completed = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    await expect(observed).resolves.toBe("timed-out");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds cleanup of the operation that triggered the hang deadline", async () => {
    const settling = settleWithin(new Promise<void>(() => undefined), 1_000);
    await vi.advanceTimersByTimeAsync(999);
    let complete = false;
    void settling.then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(settling).resolves.toBe("timed-out");
    expect(vi.getTimerCount()).toBe(0);
  });
});
