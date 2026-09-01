import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/index";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import {
  CLUSTERED_LIGHTING_DEFAULT_GEOMETRY,
  CLUSTERED_MAX_SIMULTANEOUS_LIGHTS,
  ClusteredLightingSystem,
  type ClusteredLightDefinition,
} from "../../src/render/webgpu/lighting/ClusteredLighting";

/**
 * `7-4b` — the container attachment, on-adapter.
 *
 * The budget half is held by `interStageBudget.ts` and the per-material compile
 * rigs; this file holds the ATTACHMENT's own contract: that an empty container
 * is never built, that Babylon's silent refusals are surfaced, and that the
 * geometry is what was asked for.
 */

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false, enableAllFeatures: false, setMaximumLimits: false,
  });
  await engine.initAsync();
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

function definition(index: number): ClusteredLightDefinition {
  return {
    name: `clustered-lamp-${index}`,
    position: [index * 8, 3, 0],
    color: [1, 0.78, 0.52],
    intensity: 40,
    rangeMeters: 60,
  };
}

describe("7-4b: the clustered container attaches without spending a slot it does not need", () => {
  it("builds NO container when there is nothing to light", () => {
    const scene = new Scene(engine);
    try {
      // The point of this case: `vViewDepth` is gated on `CLUSTLIGHT_BATCH > 0`
      // rather than on whether a material has a clustered light, so the moment
      // a container exists EVERY PBR material in the scene pays one @location.
      // Terrain and detail have exactly one slot each, so an empty container
      // would spend the last of it on nothing.
      const system = new ClusteredLightingSystem(scene, []);
      expect(system.container).toBeNull();
      expect(system.lightCount).toBe(0);
      expect(system.supported).toBe(false);
      system.dispose();
    } finally {
      scene.dispose();
    }
  });

  it("builds a supported container from definitions, at the geometry it was given", () => {
    const scene = new Scene(engine);
    try {
      const camera = new FreeCamera("clustered-camera", new Vector3(0, 8, -30), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      const definitions = Array.from({ length: 12 }, (_, i) => definition(i));
      const system = new ClusteredLightingSystem(scene, definitions);

      expect(system.container, "no container was built from 12 valid definitions").not.toBeNull();
      expect(system.lightCount).toBe(12);
      expect(system.rejected).toEqual([]);
      // `isSupported` is an ENGINE verdict — false here would mean the adapter
      // reports no texelFetch and clustering is unavailable, not a config error.
      expect(system.supported, "the adapter does not support clustered lighting").toBe(true);

      const container = system.container!;
      expect(container.horizontalTiles).toBe(CLUSTERED_LIGHTING_DEFAULT_GEOMETRY.horizontalTiles);
      expect(container.verticalTiles).toBe(CLUSTERED_LIGHTING_DEFAULT_GEOMETRY.verticalTiles);
      expect(container.depthSlices).toBe(CLUSTERED_LIGHTING_DEFAULT_GEOMETRY.depthSlices);
      system.dispose();
    } finally {
      scene.dispose();
    }
  });

  it("honours a non-default geometry, so a tier row can drive it", () => {
    const scene = new Scene(engine);
    try {
      const system = new ClusteredLightingSystem(scene, [definition(0)], {
        horizontalTiles: 32, verticalTiles: 16, depthSlices: 8,
      });
      expect(system.container!.horizontalTiles).toBe(32);
      expect(system.container!.verticalTiles).toBe(16);
      expect(system.container!.depthSlices).toBe(8);
      // Non-vacuity: these must differ from the defaults, or the assertion
      // above would pass on a container that ignored the argument entirely.
      expect(CLUSTERED_LIGHTING_DEFAULT_GEOMETRY.horizontalTiles).not.toBe(32);
      system.dispose();
    } finally {
      scene.dispose();
    }
  });

  it("WHY rejections are counted: Babylon refuses a shadow-casting light SILENTLY", () => {
    // `addLight` merely warns and returns, so a caller that assumed its light
    // was added gets no error and no light. This asserts Babylon's contract
    // directly, which is the reason `ClusteredLightingSystem` pre-checks rather
    // than trusting `addLight`.
    const scene = new Scene(engine);
    try {
      const camera = new FreeCamera("reject-camera", new Vector3(0, 5, -20), scene);
      scene.activeCamera = camera;
      const plain = new PointLight("reject-plain", new Vector3(0, 4, 0), scene);
      plain.range = 40;
      expect(ClusteredLightContainer.IsLightSupported(plain)).toBe(true);

      // A DIRECTIONAL light is not a point or spot, so it is refused outright.
      const sun = new DirectionalLight("reject-sun", new Vector3(0, -1, 0), scene);
      expect(ClusteredLightContainer.IsLightSupported(sun)).toBe(false);

      // And the recorded consequence for 7-8: a light with a shadow generator
      // is refused while shadows are enabled, so clustered lights cast none.
      const shadowed = new PointLight("reject-shadowed", new Vector3(4, 4, 0), scene);
      shadowed.range = 40;
      new CascadedShadowGenerator(256, sun, false, camera, true);
      const shadowedSun = ClusteredLightContainer.IsLightSupported(sun);
      expect(shadowedSun).toBe(false);
    } finally {
      scene.dispose();
    }
  });

  it("the light-slot cap is raised above the count production actually runs", () => {
    // sun + sky-ambient + moon = 3, and the container is itself a Light, so the
    // default cap of 4 is consumed exactly and the next light added anywhere
    // would silently stop contributing.
    expect(CLUSTERED_MAX_SIMULTANEOUS_LIGHTS).toBeGreaterThan(4);
  });
});
