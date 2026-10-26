import { describe, expect, it } from "vitest";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { INITIAL_VISUAL_STATE, type BoatVisualState, type FlightVisualState } from "../../src/game/types";
import { resolveAerialPerspectiveBinding } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { createBoatEffects } from "../../src/render/webgpu/boat/BoatEffects";
import { OCEAN_HULL_CLIP_DEFINE, OCEAN_HULL_CLIP_WGSL } from "../../src/render/webgpu/boat/oceanHullClip";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { resolveEnvironmentState } from "../../src/render/webgpu/nature/EnvironmentDirector";
import { SpectralOceanSystem, WATER_FRAGMENT_WGSL } from "../../src/render/webgpu/water/SpectralOceanSystem";

/**
 * The boat's effects on a real adapter: the wake, the spray and the hull
 * clip compiled into the ocean, which no Node test can see. And the other
 * half of the clip's promise: an aircraft session's ocean shader is EXACTLY
 * the one it was, because the clip lives behind a define nothing else sets.
 *
 * Compile errors are read from `getCompilationInfo`, not from an error
 * channel: Babylon owns the uncaptured-error handler (`light-points-compile`
 * records how that once passed a broken shader).
 */

const SEED = 0x4f434541;
const OCEAN_FRAGMENT_SHADER = "aerolithSpectralWaterPixelShader";
// Unique to each stage's source, to find its module among the engine's.
const OCEAN_FRAGMENT_MARKER = "fn cascadeSlopeVariance(";
const WAKE_MARKER = "wakeAcross";
const SPRAY_MARKER = "spray";

const atmosphere: AtmosphereSnapshot = {
  sunDirection: new Vector3(0.3, 0.35, 0.89).normalize(),
  sunColor: new Color3(1, 0.86, 0.7),
  sunIntensity: 3.2,
  skyZenith: new Color3(0.2, 0.36, 0.7),
  skyHorizon: new Color3(0.86, 0.66, 0.5),
  ambientColor: new Color3(0.4, 0.4, 0.45),
  skylightIlluminanceNormalized: 0.7,
  sunIlluminanceNormalized: 0.62,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.2,
  humidity: 0.45,
  windSpeed: 8,
  windDirection: new Vector2(0.28, 0.96),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 4_000,
  sceneKeyLuminanceCdM2: 800,
};

const PLANING: BoatVisualState = {
  kind: "boat",
  speedThroughWater: 18,
  gear: "forward",
  lever: 0.9,
  steerAngle: 0,
  trim: 0.4,
  trimAngle: 0.1,
  tabPort: 0,
  tabStarboard: 0,
  depthUnderKeel: 30,
  propellerImmersion: 1,
  moored: false,
  ventilating: false,
  capsized: false,
  planing: 0.9,
  wettedLength: 3,
  transomImmersion: 0,
  sprayRoots: [3, -0.2, 1, 9, 3, -0.2, -1, 9],
  sprayRootCount: 2,
};

interface ShaderRecord {
  readonly code: string;
  readonly module: GPUShaderModule;
}

/** Wait, frame by frame, for every material's effect to compile, kicking each one. */
async function compiled(engine: WebGPUEngine, meshes: readonly AbstractMesh[], tick: () => void): Promise<void> {
  for (let frame = 0; frame < 600; frame += 1) {
    tick();
    const pending = meshes.filter((mesh) => !((mesh.material as Material | null)?.isReady(mesh, false) ?? false));
    if (pending.length === 0) return;
    await new Promise<void>((resolve) => engine.onEndFrameObservable.addOnce(() => resolve()));
  }
  const unready = meshes.flatMap((mesh) => {
    const material = mesh.material as unknown as {
      _textures?: Record<string, { isReady(): boolean }>;
      _internalTextures?: Record<string, { isReady: boolean }>;
    };
    return [
      ...Object.entries(material._textures ?? {}).filter(([, texture]) => !texture.isReady()).map(([name]) => `${mesh.name}.${name}`),
      ...Object.entries(material._internalTextures ?? {}).filter(([, texture]) => !texture.isReady).map(([name]) => `${mesh.name}.${name} (internal)`),
    ];
  });
  const pending = meshes.filter((mesh) => !((mesh.material as Material | null)?.isReady(mesh, false) ?? false));
  throw new Error(`never ready: ${pending.map((mesh) => mesh.name).join(", ")}; textures not ready: ${unready.join(", ") || "none"}`);
}

/**
 * One engine, one ocean, optionally a boat session's effects, and every
 * shader module the engine created. `patchOceanFragment` replaces the ocean's
 * fragment source after the ocean registered it and before anything compiled.
 */
async function buildSession(
  boat: boolean,
  patchOceanFragment?: (source: string) => string,
): Promise<ShaderRecord[]> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  const modules: ShaderRecord[] = [];
  const registered = ShaderStore.ShadersStoreWGSL[OCEAN_FRAGMENT_SHADER];
  try {
    await engine.initAsync();
    const device = (engine as unknown as { _device: GPUDevice })._device;
    const createModule = device.createShaderModule.bind(device);
    device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
      const created = createModule(descriptor);
      modules.push({ code: String(descriptor.code), module: created });
      return created;
    };
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    engine.runRenderLoop(() => {});
    const camera = new UniversalCamera("boat-compile-camera", new Vector3(0, 8, 0), scene);
    scene.activeCamera = camera;
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const ocean = await SpectralOceanSystem.create(scene, camera, 0, profile, SEED, atmosphere);
    try {
      if (patchOceanFragment) {
        ShaderStore.ShadersStoreWGSL[OCEAN_FRAGMENT_SHADER] = patchOceanFragment(
          ShaderStore.ShadersStoreWGSL[OCEAN_FRAGMENT_SHADER]!,
        );
      }
      const meshes: AbstractMesh[] = scene.meshes.filter((mesh) => mesh.material?.name === "spectral-ocean-material");
      expect(meshes.length).toBeGreaterThan(0);
      ocean.update(camera.position, 600, 1 / 60);
      if (boat) {
        const effects = createBoatEffects(scene, {
          profile,
          world: { prevailingWindRadians: 0.4, prevailingWindSpeed: 6, seaLevel: 0 },
          ocean,
        });
        const environment = resolveEnvironmentState({
          clock: { dayOfYear: 171, solarTimeHours: 15 },
          latitudeDegrees: 45,
          weather: "clear",
        });
        const binding = resolveAerialPerspectiveBinding(environment, 8, [1, 0.9, 0.75], [0.55, 0.72, 0.93], 0.87);
        effects.wake.setAerialPerspective(binding);
        effects.spray.setAerialPerspective(binding);
        const state: FlightVisualState = {
          ...INITIAL_VISUAL_STATE,
          simulationTime: 600,
          engineRpm: 5_100,
          position: { x: 0, y: 0.38, z: 0 },
          velocity: { x: 18, y: 0, z: 0 },
          vehicle: PLANING,
        };
        effects.wake.update(state);
        effects.wake.bindOcean();
        effects.spray.update(state);
        effects.hullClip.setPose(new Vector3(0, 0.38, 0), Quaternion.Identity());
        meshes.push(effects.wake.mesh!, effects.spray.mesh!);
      }
      let time = 600;
      await compiled(engine, meshes, () => {
        time += 1 / 60;
        ocean.update(camera.position, time, 1 / 60);
      });
      return modules;
    } finally {
      ocean.dispose();
      scene.dispose();
    }
  } finally {
    ShaderStore.ShadersStoreWGSL[OCEAN_FRAGMENT_SHADER] = registered!;
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

async function errorsIn(records: readonly ShaderRecord[]): Promise<string[]> {
  const diagnostics: string[] = [];
  for (const record of records) {
    const info = await record.module.getCompilationInfo();
    for (const message of info.messages) {
      if (message.type === "error") diagnostics.push(`${message.lineNum}:${message.linePos} ${message.message}`);
    }
  }
  return diagnostics;
}

function oceanFragment(records: readonly ShaderRecord[]): ShaderRecord[] {
  return records.filter((record) => record.code.includes(OCEAN_FRAGMENT_MARKER));
}

describe("the boat's effects on a real adapter", () => {
  it("compiles the clipped ocean, the wake and the spray without an error", async () => {
    const records = await buildSession(true);
    const ocean = oceanFragment(records);
    expect(ocean.length).toBeGreaterThan(0);
    expect(ocean.every((record) => record.code.includes("fn oceanHullClipped("))).toBe(true);
    const wake = records.filter((record) => record.code.includes(WAKE_MARKER));
    const spray = records.filter((record) => record.code.includes(SPRAY_MARKER) && !record.code.includes(WAKE_MARKER));
    expect(wake.length, "no wake module").toBeGreaterThanOrEqual(2);
    expect(spray.length, "no spray module").toBeGreaterThanOrEqual(2);
    const diagnostics = await errorsIn([...ocean, ...wake, ...spray]);
    expect(diagnostics, diagnostics.join("\n")).toEqual([]);
  }, 600_000);

  it("leaves an aircraft session's ocean shader exactly what it was before the clip", async () => {
    const today = oceanFragment(await buildSession(false));
    // The fragment with the clip's two blocks taken out again, as it was written before them.
    const withoutClip = (source: string): string => {
      const declarations = `#ifdef ${OCEAN_HULL_CLIP_DEFINE}\n${OCEAN_HULL_CLIP_WGSL}\n#endif\n\n`;
      const discard = `#ifdef ${OCEAN_HULL_CLIP_DEFINE}\n`
        + "  // A boat session: no sea inside the hull (boat/oceanHullClip.ts).\n"
        + "  if (oceanHullClipped(input.worldPosition)) { discard; }\n"
        + "#endif\n";
      expect(source).toContain(declarations);
      expect(source).toContain(discard);
      return source.replace(declarations, "").replace(discard, "");
    };
    expect(WATER_FRAGMENT_WGSL).toContain(OCEAN_FRAGMENT_MARKER);
    const before = oceanFragment(await buildSession(false, withoutClip));
    expect(today.length).toBeGreaterThan(0);
    expect(today.map((record) => record.code)).toEqual(before.map((record) => record.code));
    expect(today.some((record) => record.code.includes("oceanHullClip"))).toBe(false);
  }, 600_000);
});
