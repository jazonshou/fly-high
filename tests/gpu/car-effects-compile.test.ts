import { describe, expect, it } from "vitest";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { INITIAL_VISUAL_STATE, type CarVisualState, type FlightVisualState } from "../../src/game/types";
import { resolveAerialPerspectiveBinding } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { createCarEffects } from "../../src/render/webgpu/ground/CarEffects";
import { resolveEnvironmentState } from "../../src/render/webgpu/nature/EnvironmentDirector";

/**
 * The LandCruiser's effects on a real adapter: the particles, the tyre tracks
 * and the bow wave compile, which no Node test can see. Compile errors are
 * read from `getCompilationInfo`, as `boat-effects-compile` reads them.
 */

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

describe("the car's effects on a real adapter", () => {
  it("compiles the particles, the tyre tracks and the bow wave without an error", async () => {
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
      const effects = createCarEffects(scene, {
        profile,
        world: { prevailingWindRadians: 0.4, prevailingWindSpeed: 4 },
        atmosphere,
        groundHeight: () => 0,
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
      const diagnostics = await errorsIn(ours);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      effects.particles.dispose();
      effects.tracks.dispose();
      effects.bowWave.dispose();
      scene.dispose();
    } finally {
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 600_000);
});
