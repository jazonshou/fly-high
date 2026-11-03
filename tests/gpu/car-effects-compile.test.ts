import { describe, expect, it } from "vitest";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { INITIAL_VISUAL_STATE, type CarVisualState, type FlightVisualState } from "../../src/game/types";
import { resolveAerialPerspectiveBinding } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { AsyncPipelineCompiles } from "../../src/render/webgpu/core/AsyncPipelineCompiles";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { CAR_BOW_WAVE_SEA_DEFINE } from "../../src/render/webgpu/ground/CarBowWave";
import { createCarEffects } from "../../src/render/webgpu/ground/CarEffects";
import { resolveEnvironmentState } from "../../src/render/webgpu/nature/EnvironmentDirector";
import { SurfaceMaterial } from "../../src/render/webgpu/terrain/surfaceMaterials";
import { SpectralOceanSystem } from "../../src/render/webgpu/water/SpectralOceanSystem";

/**
 * The LandCruiser's effects on a real adapter: the particles, the tyre tracks
 * and the bow wave compile, which no Node test can see, the bow wave both
 * flat and riding the drawn sea's displacement (`CAR_BOW_WAVE_SEA`, the
 * renderer's build). Compile errors are read from `getCompilationInfo`, as
 * `boat-effects-compile` reads them. Then the renderer's spawn: with its
 * off-frame compiles (`AsyncPipelineCompiles`) each effect's pipeline is built
 * while the car stands still, so the first dust, print and ford compile
 * nothing in their frame (`CarPipelinePrime`).
 */

const SEED = 0x4f434541;

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

/** Wading through a ford on sandy ground: every source and the bow wave have something to show. */
const FORDING: CarVisualState = {
  kind: "car",
  speed: 3,
  gearbox: "automatic",
  selector: "D",
  gear: 1,
  range: "4L",
  locks: "rear",
  downhillAssist: false,
  downhillAssistActive: false,
  tractionControlActive: false,
  absActive: false,
  clutch: 1,
  engineRunning: true,
  stalled: false,
  flooded: false,
  rolled: false,
  boost: 0.1,
  headlights: "off",
  brakeLights: false,
  reversing: false,
  tyrePressure: "sand",
  tyrePressureBar: 1.2,
  wadingDepth: 0.45,
  wadingSea: 0,
  settling: false,
  wheelSteer: [0, 0, 0, 0],
  wheelSpin: [0, 0, 0, 0],
  wheelSpinRate: [12, 12, 12, 12],
  wheelLoad: [5_000, 5_000, 5_000, 5_000],
  wheelSlip: [0.2, 0.2, 0.2, 0.2],
  wheelSinkage: [0.04, 0.04, 0, 0],
  wheelSurface: [-1, -1, 0, 0],
  wheelWetness: [1, 1, 0, 0],
  axleHeave: [0, 0],
  axleRoll: [0, 0],
  steeringWheel: 0,
  bumpStop: 0,
  scrape: 0,
  splash: 0,
};

interface ShaderRecord {
  readonly code: string;
  readonly module: GPUShaderModule;
}

async function compiled(engine: WebGPUEngine, meshes: readonly AbstractMesh[], tick: () => void): Promise<void> {
  for (let frame = 0; frame < 600; frame += 1) {
    tick();
    const pending = meshes.filter((mesh) => !((mesh.material as Material | null)?.isReady(mesh, false) ?? false));
    if (pending.length === 0) return;
    await new Promise<void>((resolve) => engine.onEndFrameObservable.addOnce(() => resolve()));
  }
  const pending = meshes.filter((mesh) => !((mesh.material as Material | null)?.isReady(mesh, false) ?? false));
  throw new Error(`never ready: ${pending.map((mesh) => mesh.name).join(", ")}`);
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

async function compileCarEffects(withSea: boolean): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  const modules: ShaderRecord[] = [];
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
    const camera = new UniversalCamera("car-compile-camera", new Vector3(-10, 3, 0), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const ocean = withSea ? await SpectralOceanSystem.create(scene, camera, 0, profile, SEED, atmosphere) : null;
    const effects = createCarEffects(scene, {
      profile,
      world: { prevailingWindRadians: 0.4, prevailingWindSpeed: 4 },
      atmosphere,
      groundHeight: () => 0,
      ...(ocean ? { sea: { ocean, seaLevel: 0 } } : {}),
    });
    const environment = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 15 },
      latitudeDegrees: 45,
      weather: "clear",
    });
    const binding = resolveAerialPerspectiveBinding(environment, 3, [1, 0.9, 0.75], [0.55, 0.72, 0.93], 0.87);
    effects.particles.setAerialPerspective(binding);
    effects.bowWave.setAerialPerspective(binding);
    let time = 600;
    const step = (): void => {
      time += 1 / 60;
      const state: FlightVisualState = {
        ...INITIAL_VISUAL_STATE,
        simulationTime: time,
        position: { x: 3 * (time - 600), y: 0.8, z: 0 },
        velocity: { x: 3, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        throttle: 0.8,
        vehicle: FORDING,
      };
      effects.particles.update(state);
      effects.tracks.update(state);
      effects.bowWave.update(state);
      ocean?.update(camera.position, time, 1 / 60);
      effects.bowWave.bindOcean();
    };
    step();
    step();
    const meshes = [effects.particles.mesh!, effects.tracks.mesh!, effects.bowWave.bowMesh];
    expect(effects.particles.drawing).toBe(true);
    expect(effects.tracks.drawing).toBe(true);
    expect(effects.bowWave.drawing).toBe(true);
    await compiled(engine, meshes, step);
    const ours = modules.filter((record) => /carA|trackA|bowPose/u.test(record.code));
    expect(ours.length, "not every effect built its modules").toBeGreaterThanOrEqual(6);
    const bow = ours.filter((record) => record.code.includes("bowPose"));
    expect(bow.some((record) => record.code.includes("fn oceanSurfaceDisplacement(")), "the sea's displacement").toBe(withSea);
    const diagnostics = await errorsIn(ours);
    expect(diagnostics, diagnostics.join("\n")).toEqual([]);
    effects.particles.dispose();
    effects.tracks.dispose();
    effects.bowWave.dispose();
    ocean?.dispose();
    scene.dispose();
  } finally {
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

describe("the car's effects on a real adapter", () => {
  it("compiles the particles, the tyre tracks and the bow wave without an error", async () => {
    await compileCarEffects(false);
  }, 600_000);

  it(`compiles the bow wave on the drawn sea (${CAR_BOW_WAVE_SEA_DEFINE}) without an error`, async () => {
    await compileCarEffects(true);
  }, 600_000);
});

/** The car standing on paving: nothing to throw, print or push. */
const PARKED: CarVisualState = {
  ...FORDING,
  speed: 0,
  boost: 0,
  wadingDepth: 0,
  wheelSpinRate: [0, 0, 0, 0],
  wheelSlip: [0, 0, 0, 0],
  wheelSinkage: [0, 0, 0, 0],
  wheelSurface: [SurfaceMaterial.Asphalt, SurfaceMaterial.Asphalt, SurfaceMaterial.Asphalt, SurfaceMaterial.Asphalt],
  wheelWetness: [0, 0, 0, 0],
};

describe("the car's effects at spawn", () => {
  it("build their pipelines off the frame while the car stands, so the first dust, print and ford compile nothing in theirs", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    const prototype = Mesh.prototype as unknown as Record<string, unknown>;
    let processRendering: ((this: Mesh, ...args: unknown[]) => unknown) | null = null;
    const pipelines: { readonly mesh: string | null; readonly mode: "sync" | "async" }[] = [];
    const gpuErrors: string[] = [];
    let drawingMesh: string | null = null;
    try {
      await engine.initAsync();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      device.addEventListener("uncapturederror", (event) => {
        gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
      });
      const createRenderPipeline = device.createRenderPipeline.bind(device);
      const createRenderPipelineAsync = device.createRenderPipelineAsync.bind(device);
      device.createRenderPipeline = (descriptor) => {
        pipelines.push({ mesh: drawingMesh, mode: "sync" });
        return createRenderPipeline(descriptor);
      };
      device.createRenderPipelineAsync = (descriptor) => {
        pipelines.push({ mesh: drawingMesh, mode: "async" });
        return createRenderPipelineAsync(descriptor);
      };
      const scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new UniversalCamera("car-spawn-camera", new Vector3(-10, 3, 0), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      const compiles = AsyncPipelineCompiles.install(scene)!;
      expect(compiles, "the Babylon surface the off-frame compiles hook is missing").not.toBeNull();
      // Every pass's mesh draw names its mesh for the records above, around
      // the off-frame compiles' own hook.
      const hooked = prototype["_processRendering"] as (this: Mesh, ...args: unknown[]) => unknown;
      processRendering = hooked;
      prototype["_processRendering"] = function (this: Mesh, ...args: unknown[]) {
        const outer = drawingMesh;
        drawingMesh = this.name;
        try {
          return hooked.apply(this, args);
        } finally {
          drawingMesh = outer;
        }
      };
      const effects = createCarEffects(scene, {
        profile: resolveWebGpuQualityProfile("medium", "balanced"),
        world: { prevailingWindRadians: 0.4, prevailingWindSpeed: 4 },
        atmosphere,
        groundHeight: () => 0,
        pipelineCompiles: compiles,
      });
      const environment = resolveEnvironmentState({
        clock: { dayOfYear: 171, solarTimeHours: 15 },
        latitudeDegrees: 45,
        weather: "clear",
      });
      const binding = resolveAerialPerspectiveBinding(environment, 3, [1, 0.9, 0.75], [0.55, 0.72, 0.93], 0.87);
      effects.particles.setAerialPerspective(binding);
      effects.bowWave.setAerialPerspective(binding);
      let time = 600;
      let x = 0;
      const frame = (vehicle: CarVisualState): void => {
        time += 1 / 60;
        x += vehicle.speed / 60;
        const state: FlightVisualState = {
          ...INITIAL_VISUAL_STATE,
          simulationTime: time,
          position: { x, y: 0.8, z: 0 },
          velocity: { x: vehicle.speed, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
          throttle: vehicle.speed > 0 ? 0.8 : 0,
          vehicle,
        };
        effects.particles.update(state);
        effects.tracks.update(state);
        effects.bowWave.update(state);
        engine.beginFrame();
        scene.render();
        engine.endFrame();
      };
      const priming = () => [effects.particles.drawing, effects.tracks.drawing, effects.bowWave.drawing];

      // Spawn: parked, each effect draws empty until its pipeline is built.
      frame(PARKED);
      expect(priming(), "the spawn primes every effect").toEqual([true, true, true]);
      for (let attempt = 0; attempt < 120 && priming().some(Boolean); attempt += 1) {
        await compiles.whenIdle();
        await new Promise((resolve) => setTimeout(resolve, 0));
        frame(PARKED);
      }
      expect(priming(), "the prime never finished").toEqual([false, false, false]);
      const ours = (from: number, mode: "sync" | "async") =>
        pipelines.slice(from).filter((record) => record.mode === mode && /^car-/u.test(record.mesh ?? "")).map((record) => record.mesh);
      expect(new Set(ours(0, "async")), "each effect compiled off the frame").toEqual(new Set(["car-particles", "car-tracks", "car-bow-wave"]));
      expect(ours(0, "sync"), "an effect compiled in a spawn frame").toEqual([]);

      // Then into a ford on sand: dust, mud, water, prints and the skirt, all at once.
      const mark = pipelines.length;
      const deferredBefore = compiles.statistics.deferredDraws;
      for (let step = 0; step < 30; step += 1) frame(FORDING);
      expect(priming(), "every effect has something to show").toEqual([true, true, true]);
      expect(ours(mark, "sync"), "the first dust, print or ford compiled in its frame").toEqual([]);
      expect(ours(mark, "async"), "the first dust, print or ford waited for a compile").toEqual([]);
      expect(compiles.statistics.deferredDraws).toBe(deferredBefore);
      expect(gpuErrors).toEqual([]);
      effects.particles.dispose();
      effects.tracks.dispose();
      effects.bowWave.dispose();
      compiles.dispose();
      scene.dispose();
    } finally {
      if (processRendering) prototype["_processRendering"] = processRendering;
      engine.dispose();
      canvas.remove();
    }
  }, 600_000);
});
