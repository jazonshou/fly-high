import { describe, expect, it } from "vitest";
import {
  calculateWorldPageStreamingPriority,
  createWorldPageAddress,
  rankWorldPageStreamingCandidates,
  worldPageBounds,
  worldPositionToPageAddress,
} from "../src/render/webgpu/world";

describe("WebGPU velocity-aware world streaming", () => {
  const movingNorth = {
    positionX: 0,
    positionZ: 0,
    velocityX: 0,
    velocityZ: 200,
  } as const;

  it("prefetches an approaching page ahead of an equally distant page behind", () => {
    const ahead = calculateWorldPageStreamingPriority(
      createWorldPageAddress(0, 0, 4),
      movingNorth,
    );
    const behind = calculateWorldPageStreamingPriority(
      createWorldPageAddress(0, 0, -5),
      movingNorth,
    );
    expect(ahead.currentDistanceMeters).toBe(behind.currentDistanceMeters);
    expect(ahead.predictionUsed).toBe(true);
    expect(ahead.ahead).toBe(true);
    expect(behind.ahead).toBe(false);
    expect(ahead.score).toBeLessThan(behind.score);
  });

  it("falls back to current distance below the prediction speed threshold", () => {
    const stationary = { ...movingNorth, velocityZ: 0 };
    const ahead = calculateWorldPageStreamingPriority(
      createWorldPageAddress(0, 0, 4),
      stationary,
    );
    const behind = calculateWorldPageStreamingPriority(
      createWorldPageAddress(0, 0, -5),
      stationary,
    );
    expect(ahead.predictionUsed).toBe(false);
    expect(ahead.score).toBe(ahead.currentDistanceMeters);
    expect(ahead.score).toBe(behind.score);
  });

  it("ranks deterministically and accepts explicit parent/visibility bias", () => {
    const candidates = [
      { address: createWorldPageAddress(0, 0, 3), label: "detail" },
      {
        address: createWorldPageAddress(1, 0, 1),
        label: "required-parent",
        priorityBiasMeters: -10_000,
      },
      { address: createWorldPageAddress(0, 1, 3), label: "adjacent" },
    ];
    const ranked = rankWorldPageStreamingCandidates(candidates, movingNorth);
    expect(ranked[0]?.candidate.label).toBe("required-parent");
    expect(ranked.map((entry) => entry.candidate.label)).toHaveLength(3);
  });

  it("maps negative world coordinates to seam-consistent page bounds", () => {
    const address = worldPositionToPageAddress(-0.01, -512.01, 0, 512);
    expect(address).toEqual({ level: 0, x: -1, z: -2 });
    expect(worldPageBounds(address, 512)).toMatchObject({
      minX: -512,
      maxX: 0,
      minZ: -1_024,
      maxZ: -512,
    });
  });
});
