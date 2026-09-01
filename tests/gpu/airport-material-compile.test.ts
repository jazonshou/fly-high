import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditInterStage,
  captureShaderModules,
  INTER_STAGE_LIMIT,
  type ShaderRecord,
} from "./interStageBudget";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import { AerialPerspectiveRegistry } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "../../src/render/webgpu/clouds/CloudShadowReceiverRegistry";
import { AirportSystem } from "../../src/render/webgpu/detail/AirportSystem";
import { DEFAULT_ENVIRONMENT_STATE } from "../../src/render/webgpu/nature/EnvironmentState";
import { createWorld } from "../../src/world";

/**
 * `7-4b`'s inter-stage audit for the AIRPORT material, and its own file because
 * plugin injections leak across modules — compiling two materials with
 * different plugin sets in one module contaminates whichever compiles second
 * (see `clustered-lighting-detail-spike`).
 *
 * **Why this material and why now.** A `ClusteredLightContainer` is a scene
 * light: it reaches every material taking Babylon's light loop and costs each
 * exactly one `@location`. The detail material sat at 16 of 16 and simply
 * stopped drawing when one was attached. The airport material had never been
 * measured, and it is being actively grown — `7-10` adds hangars and `7-15` a
 * tower, both on these materials. **An unaudited varying budget under two
 * sessions adding geometry is where an overflow surfaces as somebody else's
 * bug.**
 *
 * **THE SHIPPING PATH FOR THIS MATERIAL IS NOT THE ONE THE OTHERS HAVE, and
 * the audit is only worth its number if the rig reproduces it.**
 * `FlightRenderer` registers the airport as a shadow CASTER
 * (`atmosphere.addShadowCaster` over `airport.shadowCasters`), a CLOUD-shadow
 * receiver (`cloudShadowReceivers.registerMeshes`) and an AERIAL-perspective
 * receiver (`aerialReceivers.registerMeshes`). It does NOT set
 * `receiveShadows`, so unlike wildlife, foliage and aircraft these meshes never
 * compile the CSM receive path and its eight varyings are legitimately absent.
 *
 * **So a low count here is the material, not the rig** — the distinction that
 * matters, because the same low number from an incomplete rig would be a false
 * pass. `requiredMarkers` below asserts the two plugins that DO ship actually
 * compiled, which is the part a declaration could get wrong.
 */

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];
let shaderModules: ShaderRecord[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  shaderModules = captureShaderModules(engine);
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

describe("airport material compiles on-adapter, and its inter-stage budget (7-4b)", () => {
  it("compiles the hangar material with the receivers production attaches", async () => {
    gpuErrors.length = 0;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.07, 0.1, 1);
    try {
      const camera = new FreeCamera("airport-compile-camera", new Vector3(0, 30, -120), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      const sun = new DirectionalLight(
        "airport-compile-sun",
        new Vector3(-0.5, -0.8, 0.3).normalize(),
        scene,
      );
      sun.intensity = 2.4;
      const fill = new HemisphericLight("airport-compile-fill", Vector3.Up(), scene);
      fill.intensity = 0.7;
      const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
      shadows.numCascades = 4;
      // 1C-6: production binds the sky probe, and `USESPHERICALINVERTEX` only
      // exists when a cubic reflection texture is present — a rig without one
      // silently drops `vEnvironmentIrradiance` and under-reports by a slot.
      const probe = new ReflectionProbe("airport-compile-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;

      const world = createWorld();
      const definition = world.airport;
      expect(definition, "the default world has no airport to audit").toBeTruthy();
      const airport = new AirportSystem(scene, definition!, () => definition!.elevation, world.seedHash);
      airport.setFloatingOrigin(0, 0);

      // Exactly what `FlightRenderer` attaches, in the same order.
      for (const mesh of airport.shadowCasters) shadows.addShadowCaster(mesh, false);
      const meshes = airport.root.getChildMeshes(false);
      expect(meshes.length, "the airport built no meshes to audit").toBeGreaterThan(0);
      const cloudShadowReceivers = new CloudShadowReceiverRegistry();
      cloudShadowReceivers.registerMeshes(meshes);
      const aerialReceivers = new AerialPerspectiveRegistry();
      aerialReceivers.registerMeshes(meshes);
      aerialReceivers.setProjection({
        state: DEFAULT_ENVIRONMENT_STATE,
        cameraAltitudeMeters: camera.position.y,
        sunColor: [1, 0.95, 0.88],
        skyHorizonColor: [0.35, 0.55, 0.72],
        sunIlluminanceNormalized: 1,
        moonDirection: [0, -1, 0],
        moonIlluminanceNormalizedToFull: 0,
      }, 0, 0);

      // AIM AT THE GEOMETRY. The hangars sit at runway-local coordinates off
      // the world origin, so a camera pointed at (0,0,0) framed empty space and
      // nothing compiled at all — the marker guard caught it as peak=0 rather
      // than letting a zero be read as a budget.
      const bounds = airport.root.getHierarchyBoundingVectors(true);
      const centre = bounds.min.add(bounds.max).scale(0.5);
      const span = bounds.max.subtract(bounds.min).length();
      camera.position = centre.add(new Vector3(0, span * 0.4, -span));
      camera.setTarget(centre);
      camera.maxZ = Math.max(2_000, span * 8);

      // `whenReadyAsync` FIRST: Babylon compiles WebGPU shaders asynchronously
      // and simply skips a not-ready mesh, so rendering without it drew nothing
      // and created no shader modules at all.
      await scene.whenReadyAsync();
      for (let frame = 0; frame < 4; frame += 1) scene.render();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();
      expect(gpuErrors, `airport material produced GPU errors:\n${gpuErrors.join("\n")}`)
        .toEqual([]);
    } finally {
      scene.dispose();
    }

    // The audit. Markers are the two receivers production DOES attach; the CSM
    // receive path is deliberately NOT required, because these meshes never set
    // `receiveShadows` and requiring it would fail a faithful rig.
    const { peak, headroom, absent } = auditInterStage(shaderModules, {
      label: "airport (hangar metal)",
      requiredMarkers: ["cloudShadowReceiverValid", "aerialPerspective("],
      missingPaths: "CSM receive is absent in PRODUCTION too — these meshes cast, they do not receive",
    });
    expect(
      absent,
      "the rig did not compile a receiver production attaches, so the budget "
      + "below describes a material that does not ship",
    ).toEqual([]);
    expect(peak, "no FragmentInputs struct was captured — the audit is vacuous")
      .toBeGreaterThan(0);
    expect(
      peak,
      `the airport material compiles at ${peak} fragment inputs, over the device `
      + `maximum of ${INTER_STAGE_LIMIT}. The hangars will not draw at all.`,
    ).toBeLessThanOrEqual(INTER_STAGE_LIMIT);
    // The margin is the deliverable. 7-10 and 7-15 are adding geometry to this
    // material; if either needs a varying, this is the budget it spends from.
    expect(
      headroom,
      `the airport material has NO slot for a clustered light container `
      + `(peak ${peak}/${INTER_STAGE_LIMIT}). Attaching one stops the hangars drawing.`,
    ).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
