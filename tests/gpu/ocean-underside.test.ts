import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { Scene } from "@babylonjs/core/scene";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  OceanUnderside,
  UNDERWATER_WATER_IOR,
  type OceanUndersideSea,
} from "../../src/render/webgpu/underwater/OceanUnderside";
import type { UnderwaterLight } from "../../src/render/webgpu/underwater/underwaterLight";
import { packSeaShelterEllipses, SEA_SHELTER_MAX_ELLIPSES } from "../../src/sim/water/shelter";

/**
 * The sea's underside on a real adapter, both tier variants: a calm sea (no
 * cascade slopes, no wind) seen from 3 m under it, so every pixel's value is
 * the textbook answer. Inside Snell's window the sky, brightened n^2 and
 * dimmed by the exact Fresnel transmittance; past the critical angle the
 * mirror of the water's own light (3^(1 + mu) of the upwelling along the
 * reflected ray). And while it is primed at load it draws nothing at all.
 */

const WIDTH = 96;
const HEIGHT = 96;
const FOV = 1.2;
const PITCH = (50 * Math.PI) / 180;
const CAMERA_Y = -3;
const SKY = 0.25;
const UPWELLING = 0.05;
const CLEAR = 0.3;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  engine.useReverseDepthBuffer = true;
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

function readPixels(): Uint8ClampedArray {
  const copy = document.createElement("canvas");
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext("2d")!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
}

function halfTexture(scene: Scene, rgba: readonly number[], name: string): RawTexture {
  // Half floats: 0 is 0x0000 and 1 is 0x3c00, the only values used here.
  const data = new Uint16Array(rgba.map((value) => (value === 1 ? 0x3c00 : 0)));
  const texture = RawTexture.CreateRGBATexture(
    data, 1, 1, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT,
  );
  texture.name = name;
  return texture;
}

/** A calm sea: flat, still, open water (no marina shelter). */
function calmSea(scene: Scene): OceanUndersideSea {
  const mesh = CreateGround("calm-sea", { width: 400, height: 400, subdivisions: 8 }, scene);
  mesh.setEnabled(false);
  const displacement = halfTexture(scene, [0, 0, 0, 0], "displacement");
  const slopes = halfTexture(scene, [0, 0, 0, 1], "slopes");
  const moments = halfTexture(scene, [0, 0, 0, 0], "moments");
  const shelter = packSeaShelterEllipses([]);
  return {
    presentationMesh: mesh,
    bindSurface(material: ShaderMaterial) {
      material.setVector2("oceanWorldOrigin", Vector2.Zero());
      material.setVector4("patchLengths0", new Vector4(64, 64, 64, 64));
      material.setFloat("patchLength4", 64);
      material.setFloat("cascadeCount", 1);
      material.setVector4("cascadeFadeRadii0", new Vector4(1e5, 1e5, 1e5, 1e5));
      material.setFloat("cascadeFadeRadius4", 1e5);
      material.setVector4("cascadeMeshFadeRadii0", new Vector4(1e5, 1e5, 1e5, 1e5));
      material.setFloat("cascadeMeshFadeRadius4", 1e5);
      material.setFloat("cascadeFadeCameraHeight", -CAMERA_Y);
      for (let slot = 0; slot < SEA_SHELTER_MAX_ELLIPSES; slot += 1) {
        material.setVector4(`seaShelterA${slot}`, Vector4.FromArray(shelter, slot * 8));
        material.setVector4(`seaShelterB${slot}`, Vector4.FromArray(shelter, slot * 8 + 4));
      }
      for (let index = 0; index < 5; index += 1) material.setTexture(`displacement${index}`, displacement);
    },
    bindSlopes(material: ShaderMaterial) {
      for (let index = 0; index < 5; index += 1) {
        material.setTexture(`slopeFoam${index}`, slopes);
        material.setTexture(`slopeMoment${index}`, moments);
      }
      material.setVector2("oceanWind", Vector2.Zero());
    },
    setSurfaceHidden() {},
  };
}

const LIGHT = {
  sunUpwelling: [UPWELLING, UPWELLING, UPWELLING],
  skyUpwelling: [0, 0, 0],
} as unknown as UnderwaterLight;

const ATMOSPHERE = {
  sunDirection: new Vector3(0, 1, 0),
  // No sun: the window holds the sky alone.
  sunColor: new Color3(0, 0, 0),
  sunIlluminanceNormalized: 1,
  sunAngularRadiusRadians: 0.0047,
  skyZenith: new Color3(SKY, SKY, SKY),
  skyHorizon: new Color3(SKY, SKY, SKY),
} as unknown as AtmosphereSnapshot;

async function render(snellWindow: boolean, submerged: boolean): Promise<Uint8ClampedArray> {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(CLEAR, CLEAR, CLEAR, 1);
  const camera = new FreeCamera("underside-camera", new Vector3(0, CAMERA_Y, 0), scene);
  camera.setTarget(new Vector3(0, CAMERA_Y + Math.sin(PITCH) * 10, Math.cos(PITCH) * 10));
  camera.fov = FOV;
  camera.minZ = 0.08;
  camera.maxZ = 30_000;
  scene.activeCamera = camera;
  const underside = new OceanUnderside({
    scene,
    camera,
    sea: calmSea(scene),
    light: LIGHT,
    environmentCube: null,
    snellWindow,
    pipelineCompiles: null,
  });
  underside.setAtmosphere(ATMOSPHERE);
  try {
    const frame = () => {
      underside.update(true, 0);
      engine.beginFrame();
      scene.render();
      engine.endFrame();
    };
    for (let attempt = 0; attempt < 200 && !underside.material.isReady(underside.mesh); attempt += 1) {
      frame();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(underside.material.isReady(underside.mesh), "the underside never compiled").toBe(true);
    if (submerged) {
      frame();
    } else {
      // Above the water: the first update primes (draws collapsed), the
      // next leaves the underside out of the scene.
      underside.update(false, 0);
      expect(underside.mesh.isEnabled(false)).toBe(true);
      engine.beginFrame();
      scene.render();
      engine.endFrame();
    }
    const image = readPixels();
    if (!submerged) {
      underside.update(false, 0);
      expect(underside.mesh.isEnabled(false)).toBe(false);
    }
    return image;
  } finally {
    underside.dispose();
    scene.dispose();
  }
}

/** The underside's value at a pixel of a calm sea, or null where the ray never reaches it. */
function expected(x: number, row: number): number | null {
  const tangentX = (2 * (x + 0.5) / WIDTH - 1) * Math.tan(FOV / 2) * (WIDTH / HEIGHT);
  const tangentY = (1 - (2 * (row + 0.5)) / HEIGHT) * Math.tan(FOV / 2);
  const length = Math.hypot(tangentX, tangentY, 1);
  const mu = (Math.sin(PITCH) + Math.cos(PITCH) * tangentY) / length;
  if (mu <= 0) return null;
  const mirror = UPWELLING * 3 ** (1 - mu);
  const sinTransmittedSquared = UNDERWATER_WATER_IOR ** 2 * (1 - mu * mu);
  if (sinTransmittedSquared >= 1) return mirror;
  const n = UNDERWATER_WATER_IOR;
  const cosTransmitted = Math.sqrt(1 - sinTransmittedSquared);
  const perpendicular = (n * mu - cosTransmitted) / (n * mu + cosTransmitted);
  const parallel = (mu - n * cosTransmitted) / (mu + n * cosTransmitted);
  const reflectance = 0.5 * (perpendicular ** 2 + parallel ** 2);
  return (1 - reflectance) * n * n * SKY + reflectance * mirror;
}

function green(image: Uint8ClampedArray, x: number, y: number): number {
  return image[(y * WIDTH + x) * 4 + 1]! / 255;
}

/** Rows clear of the window's rim, where a calm sea's last sub-pixel ripple still moves the Fresnel term. */
function rowsAwayFromTheRim(x: number): number[] {
  const critical = Math.sqrt(1 - 1 / UNDERWATER_WATER_IOR ** 2);
  const rows: number[] = [];
  for (let row = 2; row < HEIGHT; row += 6) {
    const tangentX = (2 * (x + 0.5) / WIDTH - 1) * Math.tan(FOV / 2);
    const tangentY = (1 - (2 * (row + 0.5)) / HEIGHT) * Math.tan(FOV / 2);
    const mu = (Math.sin(PITCH) + Math.cos(PITCH) * tangentY) / Math.hypot(tangentX, tangentY, 1);
    if (Math.abs(mu - critical) > 0.04) rows.push(row);
  }
  return rows;
}

describe("the sea's underside", () => {
  for (const snellWindow of [false, true]) {
    it(`shows the sky through Snell's window and the water past it (${snellWindow ? "wave normals" : "flat"})`, async () => {
      const image = await render(snellWindow, true);
      expect(gpuErrors).toEqual([]);
      const misses: string[] = [];
      let inside = 0;
      let mirrored = 0;
      for (const x of [12, WIDTH / 2, WIDTH - 12]) {
        for (const row of rowsAwayFromTheRim(x)) {
          const want = expected(x, row);
          const got = green(image, x, row);
          if (want === null) continue;
          if (want > 0.3) inside += 1;
          else mirrored += 1;
          if (Math.abs(got - want) > 4 / 255) misses.push(`row ${row} x ${x}: ${got.toFixed(3)} vs ${want.toFixed(3)}`);
        }
      }
      expect(inside).toBeGreaterThan(3);
      expect(mirrored).toBeGreaterThan(3);
      expect(misses).toEqual([]);
    });
  }

  it("draws nothing while it is primed above the water", async () => {
    const image = await render(true, false);
    expect(gpuErrors).toEqual([]);
    for (let y = 0; y < HEIGHT; y += 8) {
      for (let x = 0; x < WIDTH; x += 8) expect(green(image, x, y)).toBeCloseTo(CLEAR, 2);
    }
  });
});
