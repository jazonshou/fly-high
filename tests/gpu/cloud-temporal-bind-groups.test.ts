import { describe, expect, it } from "vitest";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { AtmosphereGpuResources } from "../../src/render/webgpu/atmosphere/AtmosphereGpuResources";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { VolumetricCloudSystem } from "../../src/render/webgpu/clouds/VolumetricCloudSystem";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  beginGpuWorkWindow,
  endGpuWorkWindow,
  installGpuWorkCounters,
  uninstallGpuWorkCounters,
} from "../perf/gpuWorkCounters";

/**
 * The clouds' steady frames create no GPU bind groups.
 *
 * The temporal resolve ping-pongs between two history textures. Rebinding one
 * compute shader to the other half every frame made Babylon build a new bind
 * group every frame, on every tier (a GPU object only a major GC frees). One
 * shader per parity keeps both (`temporalCompute` in VolumetricCloudSystem).
 * Counted the perf capture's way (`tests/perf/gpuWorkCounters.ts`).
 *
 * A count alone would pass with the parities miswired, so every frame also
 * checks what the resolve that ran was bound to: it reads the half the
 * material showed last frame, writes the half the material samples now, and
 * the device reports no error.
 */

/** The parts of the cloud system the wiring checks read. */
interface CloudTemporalInternals {
  readonly pipeline: {
    readonly temporalCompute: readonly [ComputeShader, ComputeShader];
    readonly resolvedCloud: readonly [BaseTexture, BaseTexture];
    readonly resolvedAux: readonly [BaseTexture, BaseTexture];
  } | null;
  readonly material: { readonly _textures: Readonly<Record<string, BaseTexture | undefined>> };
}

/** What each of a compute shader's bindings holds (Babylon's `_bindings`). */
function bound(shader: ComputeShader, name: string): unknown {
  return (shader as unknown as { _bindings: Record<string, { object: unknown } | undefined> })
    ._bindings[name]?.object;
}

const SNAPSHOT: AtmosphereSnapshot = {
  sunDirection: new Vector3(0.3, 0.8, 0.52).normalize(),
  sunColor: new Color3(1, 0.96, 0.9),
  sunIntensity: 4.6,
  skyZenith: new Color3(0.2, 0.45, 0.85),
  skyHorizon: new Color3(0.7, 0.78, 0.88),
  ambientColor: new Color3(0.4, 0.45, 0.55),
  skylightIlluminanceNormalized: 1,
  sunIlluminanceNormalized: 0.88,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.35,
  humidity: 0.45,
  windSpeed: 8,
  windDirection: new Vector2(0.28, 0.96),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 6_000,
  sceneKeyLuminanceCdM2: 1_000,
};

describe("cloud temporal resolve bind groups", () => {
  it("binds each parity to read last frame's half and write the shown one, and creates none once both have run", async () => {
    installGpuWorkCounters();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    const deviceErrors: string[] = [];
    try {
      await engine.initAsync();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      device.addEventListener("uncapturederror", (event) => {
        deviceErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
      });
      const scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new UniversalCamera("cloud-bind-group-camera", new Vector3(0, 600, 0), scene);
      scene.activeCamera = camera;
      const resources = new AtmosphereGpuResources(scene, camera);
      const clouds = new VolumetricCloudSystem(
        scene, camera, resolveWebGpuQualityProfile("low", "balanced"), SNAPSHOT, resources,
      );
      try {
        await clouds.whenReadyAsync(undefined, 30_000);
        const internals = clouds as unknown as CloudTemporalInternals;
        const pipeline = internals.pipeline;
        if (pipeline === null) throw new Error("this test needs the compute pipeline");
        const shown = (name: "cloudSampler" | "cloudAuxSampler") => internals.material._textures[name];
        // Which parity's shader ran each frame.
        const dispatched: Array<0 | 1> = [];
        for (const parity of [0, 1] as const) {
          const shader = pipeline.temporalCompute[parity];
          const dispatch = shader.dispatch.bind(shader);
          shader.dispatch = (x, y, z) => {
            dispatched.push(parity);
            return dispatch(x, y, z);
          };
        }
        // Each parity reads the other half and writes its own.
        const expectParityWiring = (): void => {
          for (const parity of [0, 1] as const) {
            const shader = pipeline.temporalCompute[parity];
            expect(bound(shader, "history_cloud"), `[${parity}] history_cloud`).toBe(pipeline.resolvedCloud[1 - parity]);
            expect(bound(shader, "history_aux"), `[${parity}] history_aux`).toBe(pipeline.resolvedAux[1 - parity]);
            expect(bound(shader, "resolved_cloud"), `[${parity}] resolved_cloud`).toBe(pipeline.resolvedCloud[parity]);
            expect(bound(shader, "resolved_aux"), `[${parity}] resolved_aux`).toBe(pipeline.resolvedAux[parity]);
          }
        };
        expectParityWiring();
        let frameIndex = 0;
        const frames = async (count: number): Promise<void> => {
          for (let frame = 0; frame < count; frame += 1, frameIndex += 1) {
            camera.position.set(frameIndex * 3, 600, -frameIndex * 2);
            const pair = pipeline.resolvedCloud;
            const shownCloud = shown("cloudSampler");
            const shownAux = shown("cloudAuxSampler");
            const dispatchedBefore = dispatched.length;
            engine.beginFrame();
            clouds.update(camera.position, frameIndex / 60);
            scene.render(false, false);
            engine.endFrame();
            await device.queue.onSubmittedWorkDone();
            expect(dispatched.length - dispatchedBefore, `frame ${frameIndex}: one resolve`).toBe(1);
            const ran = pipeline.temporalCompute[dispatched[dispatched.length - 1] ?? 0];
            expect(bound(ran, "resolved_cloud"), `frame ${frameIndex}: shows what it wrote`).toBe(shown("cloudSampler"));
            expect(bound(ran, "resolved_aux"), `frame ${frameIndex}: shows what it wrote`).toBe(shown("cloudAuxSampler"));
            expect(bound(ran, "history_cloud"), `frame ${frameIndex}: reads the other half`).not.toBe(shown("cloudSampler"));
            // A resize inside update() rebuilds the pair; otherwise the
            // history is the half last frame wrote.
            if (pipeline.resolvedCloud === pair) {
              expect(bound(ran, "history_cloud"), `frame ${frameIndex}: reads last frame's`).toBe(shownCloud);
              expect(bound(ran, "history_aux"), `frame ${frameIndex}: reads last frame's`).toBe(shownAux);
            }
          }
        };
        // Both parities dispatch once and build their bind groups.
        await frames(2);
        const before = clouds.statistics.temporalResolveDispatchCount;
        beginGpuWorkWindow();
        await frames(8);
        const steady = endGpuWorkWindow(8);
        expect(clouds.statistics.temporalResolveDispatchCount - before, "every frame resolved").toBe(8);
        expect(steady.bindGroupsCreated, "bind groups created over 8 steady frames").toBe(0);

        // CONTROL: the counter sees the bind groups a resize must build (new cloud targets).
        beginGpuWorkWindow();
        engine.setSize(400, 224);
        await frames(2);
        expect(endGpuWorkWindow(2).bindGroupsCreated).toBeGreaterThan(0);
        // Both shaders were rebound to the rebuilt pair.
        expectParityWiring();
        await frames(2);
        expect([...new Set(dispatched)].sort(), "both parities ran").toEqual([0, 1]);
        await device.queue.onSubmittedWorkDone();
        expect(deviceErrors, "uncaptured device errors").toEqual([]);
      } finally {
        clouds.dispose();
        resources.dispose();
        scene.dispose();
      }
    } finally {
      uninstallGpuWorkCounters();
      engine.dispose();
      canvas.remove();
    }
  });
});
