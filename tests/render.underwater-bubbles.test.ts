import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  bubbleRadiusAtDepth,
  bubbleRiseSpeed,
  UNDERWATER_BUBBLE_BREATH_COUNT,
  UNDERWATER_BUBBLE_CAP,
  UNDERWATER_BUBBLE_ENTRY_COUNT,
  UnderwaterBubbles,
  type BubbleSource,
} from "../src/render/webgpu/underwater/UnderwaterBubbles";
import type { UnderwaterLight } from "../src/render/webgpu/underwater/underwaterLight";

/**
 * The walker's breath under the water (`UnderwaterBubbles`): how fast a
 * bubble rises and swells, when the burst and the breaths come, and that
 * bubbles leave at the surface and the draw leaves the scene with them.
 */

const LIGHT = { downwelling: [1, 1, 1] } as unknown as UnderwaterLight;

function harness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, -2, -3), scene);
  scene.activeCamera = camera;
  const bubbles = new UnderwaterBubbles({ scene, camera, light: LIGHT, pipelineCompiles: null });
  const dispose = () => {
    bubbles.dispose();
    scene.dispose();
    engine.dispose();
  };
  return { bubbles, dispose };
}

function head(under: boolean, y = -2): BubbleSource {
  return { x: 0, y, z: 0, under, surfaceHeight: 0 };
}

describe("a bubble's rise", () => {
  it("rises at clean bubbles' terminal speeds, levelling off near 0.3 m/s", () => {
    expect(bubbleRiseSpeed(0.0005)).toBeGreaterThan(0.08);
    expect(bubbleRiseSpeed(0.0005)).toBeLessThan(0.12);
    expect(bubbleRiseSpeed(0.001)).toBeGreaterThan(0.15);
    expect(bubbleRiseSpeed(0.001)).toBeLessThan(0.2);
    expect(bubbleRiseSpeed(0.004)).toBeGreaterThan(0.28);
    expect(bubbleRiseSpeed(0.02)).toBeLessThanOrEqual(0.3);
  });

  it("swells as the pressure on it falls (Boyle)", () => {
    // From 10.3 m (two atmospheres) to the surface, the volume doubles.
    expect(bubbleRadiusAtDepth(0.002, 10.3, 0) ** 3).toBeCloseTo(2 * 0.002 ** 3, 12);
    expect(bubbleRadiusAtDepth(0.002, 3, 3)).toBe(0.002);
  });
});

describe("the walker's breath", () => {
  it("bursts as the head goes under, breathes out every few seconds, and leaves at the surface", () => {
    const { bubbles, dispose } = harness();
    let time = 0;
    const step = (source: BubbleSource | null, seconds: number) => {
      for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) {
        time += 1 / 60;
        bubbles.update(time, source, 0, 0);
      }
    };
    step(head(false), 0.5);
    expect(bubbles.count).toBe(0);
    // The plunge.
    bubbles.update((time += 1 / 60), head(true), 0, 0);
    expect(bubbles.count).toBe(UNDERWATER_BUBBLE_ENTRY_COUNT);
    expect(bubbles.mesh.isEnabled(false)).toBe(true);
    // Two metres down, a 4 mm bubble is at the surface in well under ten seconds.
    step(head(true, -30), 2.4);
    const beforeBreath = bubbles.count;
    step(head(true, -30), 6);
    // At least one breath out (2.5-4.5 s after the plunge), on top of the trickle.
    expect(bubbles.count).toBeGreaterThanOrEqual(UNDERWATER_BUBBLE_BREATH_COUNT);
    expect(bubbles.count).toBeLessThanOrEqual(UNDERWATER_BUBBLE_CAP);
    expect(beforeBreath).toBeLessThanOrEqual(UNDERWATER_BUBBLE_ENTRY_COUNT + 3);
    // Out of the water: no more breath, and everything rises out.
    step(head(false), 15);
    expect(bubbles.count).toBe(0);
    expect(bubbles.mesh.isEnabled(false)).toBe(false);
    dispose();
  });

  it("draws nothing with no one in the water", () => {
    const { bubbles, dispose } = harness();
    // The first frame primes the pipeline (every disc collapsed); then it is out of the scene.
    bubbles.update(0, null, 0, 0);
    bubbles.update(1 / 60, null, 0, 0);
    expect(bubbles.count).toBe(0);
    expect(bubbles.mesh.isEnabled(false)).toBe(false);
    dispose();
  });
});
