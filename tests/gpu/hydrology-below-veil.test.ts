import { afterAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { resolveAerialPerspectiveBinding } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import {
  DepthOnlyCascadedShadowGenerator,
  type AtmosphereSnapshot,
} from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { resolveEnvironmentState } from "../../src/render/webgpu/nature/EnvironmentDirector";
import type { HydrologyLake } from "../../src/render/webgpu/water/HydrologyGeneration";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HydrologySystem,
} from "../../src/render/webgpu/water/HydrologySystem";

/**
 * A lake seen from below while the underwater view's water column is on
 * leaves the water between it and the camera to the column
 * (`belowVeilScale`, `HydrologySystem.setUnderwaterColumnActive`), and
 * nothing else about the inland water moves.
 *
 * The shipped material is drawn on a real adapter against the fragment as it
 * stood before the uniform existed (the same text with the two veiled paths
 * put back to the plain camera distance), each on its own engine so neither
 * reuses the other's compiled effect. Seen from above, the frames match byte
 * for byte whether the column is on or off; seen from below with the column
 * off they match too, and only the column's own case differs.
 */

const WIDTH = 96;
const HEIGHT = 64;

const ATMOSPHERE: AtmosphereSnapshot = {
  sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
  sunColor: new Color3(1, 0.96, 0.88),
  sunIntensity: 4.8,
  skyZenith: new Color3(0.1, 0.36, 0.78),
  skyHorizon: new Color3(0.58, 0.77, 0.96),
  ambientColor: new Color3(0.18, 0.27, 0.42),
  skylightIlluminanceNormalized: 1,
  sunIlluminanceNormalized: 0.92,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.32,
  humidity: 0.62,
  windSpeed: 9,
  windDirection: new Vector2(0.93, 0.37).normalize(),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 6_000,
  sceneKeyLuminanceCdM2: 1_000,
};

const LAKE_LEVEL = 98;
const LAKE = {
  id: "below-veil-lake",
  centerX: 0,
  centerZ: 0,
  surfaceHeight: LAKE_LEVEL,
  maximumDepthMeters: 22,
  radiusMeters: 620,
  areaSquareMeters: Math.PI * 620 * 620,
  flowDirection: [0, 1],
  boundary: Array.from({ length: 28 }, (_, index) => {
    const angle = (index / 28) * Math.PI * 2;
    return { x: Math.cos(angle) * 620, y: LAKE_LEVEL, z: Math.sin(angle) * 620 };
  }),
} as HydrologyLake;

/** The fragment before `belowVeilScale`: both veiled paths back to the plain camera distance. */
function fragmentBefore(): string {
  const swaps: readonly (readonly [string, string])[] = [
    [
      "  let cameraDistance = distance(uniforms.cameraPosition, input.worldPosition);\n  if (cameraBelow) {",
      "  if (cameraBelow) {",
    ],
    [
      "      cameraDistance * uniforms.belowVeilScale,\n",
      "      distance(uniforms.cameraPosition, input.worldPosition),\n",
    ],
    [
      "    select(cameraDistance, cameraDistance * uniforms.belowVeilScale, cameraBelow),\n",
      "    distance(uniforms.cameraPosition, input.worldPosition),\n",
    ],
  ];
  let text = HYDROLOGY_WATER_FRAGMENT_WGSL;
  for (const [now, before] of swaps) {
    expect(text.split(now).length, `the fragment holds ${JSON.stringify(now)} once`).toBe(2);
    text = text.replace(now, before);
  }
  // The uniform's declaration stays: unread, it changes no arithmetic.
  expect(text.split("uniforms.belowVeilScale").length).toBe(1);
  return text;
}

interface Frame {
  readonly pixels: Uint8ClampedArray;
  readonly gpuErrors: readonly string[];
}

const shaderKeys: string[] = [];
afterAll(() => {
  for (const key of shaderKeys) ShaderStore.ShadersStoreWGSL[key] = HYDROLOGY_WATER_FRAGMENT_WGSL;
});

async function drawLake(cameraY: number, targetY: number, options: { before?: boolean; columnActive?: boolean }): Promise<Frame> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  engine.useReverseDepthBuffer = true;
  const gpuErrors: string[] = [];
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(1, 0, 1, 1);
  try {
    const camera = new FreeCamera("below-veil-camera", new Vector3(0, cameraY, -240), scene);
    camera.setTarget(new Vector3(0, targetY, 60));
    camera.minZ = 0.1;
    camera.maxZ = 20_000;
    scene.activeCamera = camera;
    const system = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: "below-veil",
      terrainSample: () => {
        throw new Error("graph mode must not sample analytic terrain");
      },
      seaLevel: 0,
      centerX: 0,
      centerZ: 0,
      graphHydrology: { rivers: [], lakes: [LAKE] },
    });
    // The constructor registers the shipped text; the "before" arm swaps it in
    // ahead of the first compile.
    const key = Object.keys(ShaderStore.ShadersStoreWGSL).find(
      (name) => ShaderStore.ShadersStoreWGSL[name] === HYDROLOGY_WATER_FRAGMENT_WGSL,
    );
    expect(key, "the shipped fragment is registered").toBeDefined();
    if (options.before) {
      ShaderStore.ShadersStoreWGSL[key!] = fragmentBefore();
      shaderKeys.push(key!);
    }
    // The renderer's other bindings: a flat bed under the lake, the sun's
    // cascades, a clear cloud-shadow map, and the haze.
    const material = system.lakeMesh!.material as ShaderMaterial;
    for (const level of ["bathymetryNear", "bathymetryFar"]) {
      material.setTexture(level, RawTexture.CreateRTexture(
        new Float32Array([LAKE_LEVEL - 22]), 1, 1, scene, false, false,
        Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      ));
      material.setVector4(`${level}Placement`, new Vector4(-1, -1, 2_000, 1));
    }
    material.setFloat("bathymetrySeaLevel", 0);
    const sun = new DirectionalLight("below-veil-sun", ATMOSPHERE.sunDirection.scale(-1), scene);
    system.setSunShadows(new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true));
    const clear = RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    );
    system.setCloudShadow({
      texture: clear,
      centerX: 0,
      centerZ: 0,
      worldSizeMeters: 10_000,
      referenceAltitudeMeters: 2_000,
      sunDirectionX: ATMOSPHERE.sunDirection.x,
      sunDirectionY: ATMOSPHERE.sunDirection.y,
      sunDirectionZ: ATMOSPHERE.sunDirection.z,
      valid: false,
    });
    const environment = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 15 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    system.setAerialPerspective(
      resolveAerialPerspectiveBinding(environment, cameraY, [1, 0.9, 0.75], [0.55, 0.72, 0.93], 0.87),
    );
    if (options.columnActive !== undefined) system.setUnderwaterColumnActive(options.columnActive);
    system.update(0, camera.position);
    for (let frame = 0; frame < 300 && !scene.isReady(); frame += 1) {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scene.isReady(), "the lake's material never compiled").toBe(true);
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    // Read straight away: the canvas's frame is gone once the task yields.
    const copy = document.createElement("canvas");
    copy.width = WIDTH;
    copy.height = HEIGHT;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    if (options.before) ShaderStore.ShadersStoreWGSL[key!] = HYDROLOGY_WATER_FRAGMENT_WGSL;
    system.dispose();
    return { pixels, gpuErrors };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}

/** Pixels that are not the clear colour: the lake drew there. */
function lakePixels(frame: Frame): number {
  let count = 0;
  for (let index = 0; index < frame.pixels.length; index += 4) {
    if (frame.pixels[index] !== 255 || frame.pixels[index + 1] !== 0 || frame.pixels[index + 2] !== 255) count += 1;
  }
  return count;
}

function differing(a: Frame, b: Frame): number {
  let count = 0;
  for (let index = 0; index < a.pixels.length; index += 4) {
    if (
      a.pixels[index] !== b.pixels[index]
      || a.pixels[index + 1] !== b.pixels[index + 1]
      || a.pixels[index + 2] !== b.pixels[index + 2]
    ) count += 1;
  }
  return count;
}

describe("a lake seen from below under the water column", () => {
  it("draws every byte as before from above, column or not", async () => {
    const before = await drawLake(LAKE_LEVEL + 14, LAKE_LEVEL, { before: true });
    const after = await drawLake(LAKE_LEVEL + 14, LAKE_LEVEL, {});
    const column = await drawLake(LAKE_LEVEL + 14, LAKE_LEVEL, { columnActive: true });
    for (const frame of [before, after, column]) expect(frame.gpuErrors).toEqual([]);
    expect(lakePixels(before)).toBeGreaterThan(WIDTH * HEIGHT * 0.3);
    expect(differing(before, after)).toBe(0);
    expect(differing(before, column)).toBe(0);
  }, 120_000);

  it("veils itself as before from below with the column off, and leaves the path to the column with it on", async () => {
    const before = await drawLake(LAKE_LEVEL - 4, LAKE_LEVEL + 10, { before: true });
    const after = await drawLake(LAKE_LEVEL - 4, LAKE_LEVEL + 10, { columnActive: false });
    const column = await drawLake(LAKE_LEVEL - 4, LAKE_LEVEL + 10, { columnActive: true });
    for (const frame of [before, after, column]) expect(frame.gpuErrors).toEqual([]);
    expect(lakePixels(before)).toBeGreaterThan(WIDTH * HEIGHT * 0.3);
    expect(differing(before, after)).toBe(0);
    // Every far texel of the underside loses the lake's own veil.
    expect(differing(after, column)).toBeGreaterThan(lakePixels(after) * 0.5);
  }, 120_000);
});
