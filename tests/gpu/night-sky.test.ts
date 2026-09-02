import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { AtmosphereSystem } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { StarFieldSystem } from "../../src/render/webgpu/atmosphere/StarField";
import { ScotopicVisionPass } from "../../src/render/webgpu/atmosphere/ScotopicVision";
import { AerialPerspectiveRegistry } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { resolveEnvironmentState } from "../../src/render/webgpu/nature/EnvironmentDirector";
import { FULL_MOON_ILLUMINANCE_LUX, moonState } from "../../src/render/webgpu/atmosphere/Ephemeris";
import { createEnvironmentClock } from "../../src/world/environmentClock";

/**
 * Gate 7A on-adapter: the rule `2-12` set after five capture-only failures —
 * every material-stack feature lands with a test that draws REAL PIXELS on a
 * real device, not one that merely compiles. The night sky adds three new
 * pipeline permutations at once (a screen-space star sprite with custom
 * vertex attributes, the sky fragment's moon and Milky Way branch, and a
 * WGSL post-process ahead of the tone map), and every one of them is
 * invisible in the daylight captures that would otherwise gate them.
 */

const CANVAS_SIZE = 256;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

async function renderFrames(scene: Scene, count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Render and copy in ONE synchronous task: the WebGPU swapchain texture is
 * recycled as soon as the compositor consumes the frame, so an `await`
 * between the draw and the copy reads back an empty canvas. (Learned the
 * hard way here, and already recorded in `foliage-material-compile`.)
 */
function renderAndRead(scene: Scene): Uint8ClampedArray {
  engine.beginFrame();
  scene.render();
  engine.endFrame();
  return readPixels();
}

function readPixels(): Uint8ClampedArray {
  const copy = document.createElement("canvas");
  copy.width = CANVAS_SIZE;
  copy.height = CANVAS_SIZE;
  const context = copy.getContext("2d")!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
}

describe("the night sky on a real adapter (Gate 7A)", () => {
  it("draws stars, the moon and the scotopic pass with no GPU errors", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("night-camera", Vector3.Zero(), scene);
    camera.minZ = 1;
    camera.maxZ = 45_000;
    scene.activeCamera = camera;

    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const atmosphere = new AtmosphereSystem(scene, camera, profile);
    const stars = new StarFieldSystem(scene, 1);
    const aerial = new AerialPerspectiveRegistry();
    let scotopic: ScotopicVisionPass | null = null;

    try {
      // A clock at which the moon sits around 30° up and mostly lit: high
      // enough to be unambiguously in frame, low enough that a camera aimed
      // at it keeps a well-conditioned up vector.
      let chosen = createEnvironmentClock(171, 23.5);
      let bestAltitude = -1;
      let bestError = Number.POSITIVE_INFINITY;
      for (let day = 0; day < 60; day += 1) {
        const clock = createEnvironmentClock(day, 23.5);
        const state = resolveEnvironmentState({
          clock,
          latitudeDegrees: 45,
          weather: "clear",
        });
        atmosphere.applyEnvironment(state, clock, 45, 0);
        const moon = atmosphere.snapshot;
        const error = Math.abs(moon.moonDirection.y - 0.5);
        if (moon.moonIlluminatedFraction > 0.6 && error < bestError) {
          bestError = error;
          bestAltitude = moon.moonDirection.y;
          chosen = clock;
        }
      }
      expect(bestAltitude, "no night in two months has the moon up and lit")
        .toBeGreaterThan(0.2);
      expect(bestAltitude).toBeLessThan(0.85);

      const state = resolveEnvironmentState({
        clock: chosen,
        latitudeDegrees: 45,
        weather: "clear",
      });
      atmosphere.applyEnvironment(state, chosen, 45, 0);
      stars.setClock(chosen, 45, state.sun.direction[1]);
      const galactic = stars.galacticFrame(chosen, 45);
      atmosphere.setGalacticFrame(galactic.pole, galactic.center);
      stars.setOutputSize(CANVAS_SIZE, CANVAS_SIZE);

      const moonSnapshot = atmosphere.snapshot;
      aerial.setProjection({
        state,
        cameraAltitudeMeters: 100,
        sunColor: [1, 0.96, 0.9],
        skyHorizonColor: [0.05, 0.06, 0.1],
        sunIlluminanceNormalized: 0,
        moonDirection: [
          moonSnapshot.moonDirection.x,
          moonSnapshot.moonDirection.y,
          moonSnapshot.moonDirection.z,
        ],
        moonIlluminanceNormalizedToFull:
          moonSnapshot.moonIlluminanceLux / FULL_MOON_ILLUMINANCE_LUX,
      }, 0, 0);
      const binding = aerial.currentBinding;
      expect(binding).not.toBeNull();
      atmosphere.setAerialPerspective(binding!);
      atmosphere.update(Vector3.Zero());
      stars.update(Vector3.Zero());

      // Point the camera at the moon, through a NARROW field of view. The
      // moon is 0.52° across; at a normal 46° FOV it covers about two pixels
      // on a 256 px canvas, and a two-pixel assertion cannot tell a correct
      // disc from a lucky one. At 3.4° it covers ~40 px, so the phase, the
      // maria and the limb all have somewhere to be wrong.
      const moonDirection = atmosphere.snapshot.moonDirection;
      camera.position.set(0, 0, 0);
      camera.setTarget(moonDirection.scale(1_000));
      camera.fov = 0.06;

      // First WITHOUT the post-process: the sky, the moon and the stars have
      // to put pixels on the canvas on their own, or a later "the pass
      // changed something" assertion would be measuring the pass against a
      // black frame.
      await renderFrames(scene, 3);
      const bare = renderAndRead(scene);
      let litBare = 0;
      for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
        if ((bare[index * 4] ?? 0) + (bare[index * 4 + 1] ?? 0) > 10) litBare += 1;
      }
      expect(gpuErrors.join("\n")).toBe("");
      expect(litBare, "the moon disc rasterized nothing before the post-process")
        .toBeGreaterThan(120);
      // ...and part of it is DARK: a disc with no terminator would be
      // uniformly lit, and the phase is the whole item.
      let litDisc = 0;
      let darkDisc = 0;
      for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
        const x = index % CANVAS_SIZE;
        const y = Math.floor(index / CANVAS_SIZE);
        const radius = Math.hypot(x - CANVAS_SIZE / 2, y - CANVAS_SIZE / 2);
        if (radius > CANVAS_SIZE * 0.16) continue;
        if ((bare[index * 4 + 1] ?? 0) > 40) litDisc += 1;
        else darkDisc += 1;
      }
      expect(litDisc, "no lit limb").toBeGreaterThan(100);
      expect(darkDisc, "no terminator — the disc is uniformly lit").toBeGreaterThan(100);

      scotopic = new ScotopicVisionPass(camera, engine, profile.msaaSamples);
      // Post-process pipeline creation is asynchronous on WebGPU. Under the
      // full serial adapter suite it can take longer than the four historical
      // warm-up frames, and reading before `isReady()` returns the cleared
      // swapchain even though the same test passes in isolation. Wait for the
      // pipeline contract explicitly; once ready, a black frame still fails
      // the pixel assertions below rather than being retried away.
      for (let warmup = 0; warmup < 120 && !scotopic.postProcess.isReady(); warmup += 1) {
        await renderFrames(scene, 1);
      }
      expect(scotopic.postProcess.isReady(), "the scotopic pipeline never became ready")
        .toBe(true);
      // Daylight first: the scotopic pass must be a pass-through, so a
      // night-only feature cannot quietly change every daytime capture.
      scotopic.setState({
        rodFraction: 0,
        adaptedLuminanceCdM2: 3_000,
        sceneToNits: 7_346,
        displayGain: 0.15,
      });
      await renderFrames(scene, 4);
      const cone = renderAndRead(scene);

      scotopic.setState({
        rodFraction: 1,
        adaptedLuminanceCdM2: atmosphere.snapshot.adaptedLuminanceCdM2,
        sceneToNits: 7_346,
        displayGain: 0.15,
      });
      await renderFrames(scene, 4);
      const rod = renderAndRead(scene);

      expect(gpuErrors.join("\n")).toBe("");

      // 1. The sky is not black: stars, the moon and the Milky Way band all
      //    write into it. A pipeline that failed to build would leave the
      //    clear colour behind, which is exactly the failure this catches.
      let litCone = 0;
      let brightest = 0;
      for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
        const value = Math.max(
          cone[index * 4] ?? 0,
          cone[index * 4 + 1] ?? 0,
          cone[index * 4 + 2] ?? 0,
        );
        if (value > 8) litCone += 1;
        brightest = Math.max(brightest, value);
      }
      expect(litCone, "the night sky rasterized nothing").toBeGreaterThan(120);
      expect(brightest, "the moon disc never reached a bright value")
        .toBeGreaterThan(90);

      // 2. The rod pass changes the image, and changes it toward the blue —
      //    the Purkinje shift, on an image whose own light is warm.
      let coneRedExcess = 0;
      let rodBlueExcess = 0;
      let changed = 0;
      for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
        const r = cone[index * 4] ?? 0;
        const b = cone[index * 4 + 2] ?? 0;
        const rr = rod[index * 4] ?? 0;
        const rb = rod[index * 4 + 2] ?? 0;
        if (Math.abs(rr - r) + Math.abs(rb - b) > 6) changed += 1;
        coneRedExcess += r - b;
        rodBlueExcess += rb - rr;
      }
      expect(changed, "the scotopic pass changed nothing").toBeGreaterThan(
        CANVAS_SIZE * CANVAS_SIZE * 0.05,
      );
      expect(rodBlueExcess, "the rod image is not blue-shifted").toBeGreaterThan(0);
      expect(coneRedExcess).toBeLessThan(rodBlueExcess * 1_000_000);
    } finally {
      aerial.dispose();
      scotopic?.dispose(camera);
      stars.dispose();
      atmosphere.dispose();
      scene.dispose();
    }
  }, 180_000);

  it("moves the moon and the constellations together across the night", async () => {
    // Not a pixel test: the frame the disc rides and the frame the stars
    // ride are the same matrix, so a moon that drifts out of its
    // constellation means the two consumers have diverged.
    const clock = createEnvironmentClock(171, 22);
    const later = createEnvironmentClock(171, 23);
    const scene = new Scene(engine);
    const camera = new FreeCamera("frame-camera", Vector3.Zero(), scene);
    scene.activeCamera = camera;
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const atmosphere = new AtmosphereSystem(scene, camera, profile);
    try {
      const at = (hour: typeof clock) => {
        const state = resolveEnvironmentState({
          clock: hour,
          latitudeDegrees: 45,
          weather: "clear",
        });
        atmosphere.applyEnvironment(state, hour, 45, 0);
        return atmosphere.snapshot.moonDirection.clone();
      };
      const first = at(clock);
      const second = at(later);
      // An hour of sidereal rotation is 15°; the moon's own motion along the
      // ecliptic is ~0.5°, so the disc sweeps essentially with the sky.
      const dot = Math.min(1, Math.max(-1, Vector3.Dot(first, second)));
      const degrees = (Math.acos(dot) * 180) / Math.PI;
      expect(degrees).toBeGreaterThan(12);
      expect(degrees).toBeLessThan(18);
      // ...and the ephemeris the sky drew agrees with the one the CPU has.
      const moon = moonState(clock);
      expect(moon.angularRadiusRadians).toBeGreaterThan(0.004);
    } finally {
      atmosphere.dispose();
      scene.dispose();
    }
  }, 60_000);
});
