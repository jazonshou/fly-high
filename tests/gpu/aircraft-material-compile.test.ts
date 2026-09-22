import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditInterStage,
  captureShaderModules,
  CSM_RECEIVE_MARKERS,
  fragmentInputCount,
  INTER_STAGE_LIMIT,
  type ShaderRecord,
} from "./interStageBudget";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Logger } from "@babylonjs/core/Misc/logger";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import { INITIAL_VISUAL_STATE } from "../../src/game/types";
import { AIRCRAFT_KINDS } from "../../src/sim";
import { createWebGpuAircraft } from "../../src/render/webgpu/aircraft";
import { AerialPerspectiveRegistry } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "../../src/render/webgpu/clouds/CloudShadowReceiverRegistry";
import { DEFAULT_ENVIRONMENT_STATE } from "../../src/render/webgpu/nature/EnvironmentState";

/** Gate A: production PBR paint mips plus clearcoat/refraction compile on WebGPU. */

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

describe("aircraft material stack compiles on-adapter (Gate A)", () => {
  it("renders trainer and jet paint, normal/BRDF mips, clearcoat glass and transmission", async () => {
    gpuErrors.length = 0;
    const loggerErrors: string[] = [];
    const originalLoggerError = Logger.Error;
    Logger.Error = ((message: string | unknown[], limit?: number) => {
      loggerErrors.push(Array.isArray(message) ? message.join(" ") : String(message));
      originalLoggerError.call(Logger, message as string, limit);
    }) as typeof Logger.Error;
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.05, 0.09, 0.13, 1);
    try {
      const camera = new FreeCamera("aircraft-compile-camera", new Vector3(12, 5, -16), scene);
      camera.setTarget(new Vector3(0, 0, 0));
      scene.activeCamera = camera;
      const sun = new DirectionalLight(
        "aircraft-compile-sun",
        new Vector3(-0.6, -0.8, 0.2).normalize(),
        scene,
      );
      sun.intensity = 2.4;
      const fill = new HemisphericLight("aircraft-compile-fill", Vector3.Up(), scene);
      fill.intensity = 0.7;
      const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
      shadows.numCascades = 4;
      const probe = new ReflectionProbe("aircraft-compile-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;

      const trainer = createWebGpuAircraft(scene, "trainer");
      trainer.root.position.z = 3.2;
      const jet = createWebGpuAircraft(scene, "jet");
      jet.root.position.z = -3.2;
      for (const mesh of [...trainer.meshes, ...jet.meshes]) {
        if (mesh.metadata?.castsShadow !== false) shadows.addShadowCaster(mesh, false);
      }
      const cloudShadowReceivers = new CloudShadowReceiverRegistry();
      cloudShadowReceivers.registerMeshes(trainer.meshes);
      cloudShadowReceivers.registerMeshes(jet.meshes);
      const aerialReceivers = new AerialPerspectiveRegistry();
      aerialReceivers.registerMeshes(trainer.meshes);
      aerialReceivers.registerMeshes(jet.meshes);
      aerialReceivers.setProjection({
        state: DEFAULT_ENVIRONMENT_STATE,
        cameraAltitudeMeters: camera.position.y,
        sunColor: [1, 0.95, 0.88],
        skyHorizonColor: [0.35, 0.55, 0.72],
        sunIlluminanceNormalized: 1,
        moonDirection: [0, -1, 0],
        moonIlluminanceNormalizedToFull: 0,
      }, 0, 0);
      trainer.update({
        ...INITIAL_VISUAL_STATE,
        engineRpm: 2_250,
        simulationTime: 1,
      }, 1 / 60);

      await scene.whenReadyAsync();
      for (let frame = 0; frame < 4; frame += 1) scene.render();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();
      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);
      expect(loggerErrors, loggerErrors.join("\n\n")).toEqual([]);
      aerialReceivers.dispose();
      cloudShadowReceivers.dispose();
      trainer.dispose();
      jet.dispose();
      shadows.dispose();
      probe.dispose();
    } finally {
      Logger.Error = originalLoggerError;
      scene.dispose();
    }
    // 7-4b: THE INTER-STAGE AUDIT. A `ClusteredLightContainer` is a SCENE light
    // -- it reaches every material taking Babylon's light loop and adds exactly
    // one `@location` to each. A material already at the device maximum does not
    // DEGRADE when one is attached: pipeline creation fails and the mesh stops
    // drawing entirely.
    //
    // `requiredMarkers` is asserted against the compiled source, not declared.
    // aircraft paint (clearcoat + transmission)'s meshes set `receiveShadows`, so a run that compiles no
    // `vPositionFromLight` is measuring a permutation eight varyings lighter
    // than the one that ships -- which is exactly how this file once reported
    // 3 of 16 with thirteen slots free.
    const { peak, headroom, absent } = auditInterStage(shaderModules, {
      label: "aircraft paint (clearcoat + transmission)",
      requiredMarkers: CSM_RECEIVE_MARKERS,
    });
    expect(
      absent,
      "the rig did not compile the shipping shadow path, so the budget below "
      + "describes a material that does not exist",
    ).toEqual([]);
    expect(peak, "no FragmentInputs struct was captured -- the audit is vacuous")
      .toBeGreaterThan(0);
    expect(
      peak,
      `aircraft paint (clearcoat + transmission) compiles at ${peak} fragment inputs, over the device maximum of `
      + `${INTER_STAGE_LIMIT}. The mesh will not draw at all.`,
    ).toBeLessThanOrEqual(INTER_STAGE_LIMIT);
    // The MARGIN is the deliverable, not the pass: a clean audit that names its
    // headroom is what makes the next attach safe.
    expect(
      headroom,
      `aircraft paint (clearcoat + transmission) has NO slot for a clustered light container (peak ${peak}/${INTER_STAGE_LIMIT}). `
      + "Attaching one stops this material drawing; free a varying first, as 7-4b did for detail.",
    ).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("every airframe's materials keep a slot for the clustered container (Gate A, all four)", () => {
  /**
   * WHY THIS BLOCK EXISTS. The block above compiles the trainer and the jet and
   * nothing else. The 747 was never compiled on an adapter by any GPU test, so
   * when its livery put the fuselage at UV1 + UV2 + vertex colour, nothing in
   * the repository could see the result: with the airfield's clustered
   * container attached, the fragment stage wanted 17 inputs, the device refused
   * the pipeline, and the renderer stopped and drew a black canvas under a live
   * HUD. The headroom assertion above is precisely the check that catches that
   * build -- it simply never ran on the airframe that had it.
   *
   * So this compiles EVERY airframe the game can fly, from AIRCRAFT_KINDS rather
   * than a hand-written list, and holds each MATERIAL to the same standard: at
   * most 16, and one slot left for the container, which costs every lit
   * material exactly one `@location` the moment it exists.
   *
   * ATTRIBUTION IS PER MATERIAL, read from each sub-mesh's own compiled effect.
   * A single peak over the scene says a limit was reached without saying by
   * what. And the captured-module list cannot be trusted for attribution here:
   * Babylon caches effects by source and defines, so a permutation already
   * compiled by the block above is REUSED with no fresh `createShaderModule`
   * call, and a capture-only audit would silently omit it. The effect still
   * carries its final WGSL (`Effect.fragmentSourceCode`, "the final source code
   * that will be compiled"), so reading it there cannot miss a cached one. The
   * positive control below proves that string is the artefact the device saw.
   */
  it("compiles all four with no device error, and every material at <= 15 of 16", async () => {
    gpuErrors.length = 0;
    // A WIDE capture for this block. The file-level capture keeps a rolling 64,
    // and four airframes compile far more than that, so the permutation being
    // audited can roll out of it before the control reads it.
    const blockModules = captureShaderModules(engine, 4_096);
    const loggerErrors: string[] = [];
    const originalLoggerError = Logger.Error;
    Logger.Error = ((message: string | unknown[], limit?: number) => {
      loggerErrors.push(Array.isArray(message) ? message.join(" ") : String(message));
      originalLoggerError.call(Logger, message as string, limit);
    }) as typeof Logger.Error;
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.05, 0.09, 0.13, 1);
    // The SAME rig as the block above, deliberately: a cascaded generator WITH
    // casters (the receive path does not compile without one), a reflection
    // probe as the environment, and both receiver registries. A lighter rig
    // measures a lighter permutation than the one that ships.
    const counts: { kind: string; material: string; mesh: string; pass: number; inputs: number; code: string }[] = [];
    let blackScreenBuild = -1;
    let mainPass = -1;
    try {
      const camera = new FreeCamera("aircraft-compile-all-camera", new Vector3(0, 60, -260), scene);
      camera.setTarget(new Vector3(0, 0, 0));
      scene.activeCamera = camera;
      // The main colour pass is the CAMERA'S render pass, not RENDERPASS_MAIN:
      // every camera allocates its own id, so in this engine it is whatever
      // number the earlier blocks left next (it measured 12, with the four
      // shadow cascades on 13-16).
      mainPass = camera.renderPassId;
      const sun = new DirectionalLight("aircraft-compile-all-sun", new Vector3(-0.6, -0.8, 0.2).normalize(), scene);
      sun.intensity = 2.4;
      const fill = new HemisphericLight("aircraft-compile-all-fill", Vector3.Up(), scene);
      fill.intensity = 0.7;
      const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
      shadows.numCascades = 4;
      const probe = new ReflectionProbe("aircraft-compile-all-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;

      const visuals = AIRCRAFT_KINDS.map((kind, index) => {
        const visual = createWebGpuAircraft(scene, kind);
        visual.root.position.x = (index - (AIRCRAFT_KINDS.length - 1) / 2) * 90;
        return { kind, visual };
      });
      const cloudShadowReceivers = new CloudShadowReceiverRegistry();
      const aerialReceivers = new AerialPerspectiveRegistry();
      for (const { visual } of visuals) {
        for (const mesh of visual.meshes) {
          if (mesh.metadata?.castsShadow !== false) shadows.addShadowCaster(mesh, false);
        }
        cloudShadowReceivers.registerMeshes(visual.meshes);
        aerialReceivers.registerMeshes(visual.meshes);
        visual.update({ ...INITIAL_VISUAL_STATE, engineRpm: 2_250, simulationTime: 1 }, 1 / 60);
      }
      aerialReceivers.setProjection({
        state: DEFAULT_ENVIRONMENT_STATE,
        cameraAltitudeMeters: camera.position.y,
        sunColor: [1, 0.95, 0.88],
        skyHorizonColor: [0.35, 0.55, 0.72],
        sunIlluminanceNormalized: 1,
        moonDirection: [0, -1, 0],
        moonIlluminanceNormalizedToFull: 0,
      }, 0, 0);

      await scene.whenReadyAsync();
      for (let frame = 0; frame < 4; frame += 1) scene.render();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();

      for (const { kind, visual } of visuals) {
        for (const mesh of visual.meshes) {
          const material = mesh.material?.name ?? "(none)";
          for (const subMesh of mesh.subMeshes ?? []) {
            // EVERY RENDER PASS, not `subMesh.effect`. That getter returns the
            // effect for `engine.currentRenderPassId` at the moment of reading,
            // which after a frame can be a reflection-probe face or a shadow
            // pass rather than the main colour pass -- this audit's first
            // version read an arbitrary pass, and its own positive control is
            // what exposed it. Each pass is a permutation the device must
            // accept, so the worst over all of them is the one that decides.
            const wrappers = (subMesh as unknown as {
              _drawWrappers: ({ effect?: { fragmentSourceCode?: string } | null } | undefined)[];
            })._drawWrappers ?? [];
            wrappers.forEach((wrapper, pass) => {
              const code = wrapper?.effect?.fragmentSourceCode ?? "";
              if (code) counts.push({ kind, material, mesh: mesh.name, pass, inputs: fragmentInputCount(code), code });
            });
          }
        }
      }

      // POSITIVE CONTROL for the budget assertion itself: rebuild, in memory,
      // the exact build that blacked out the 747 -- the fuselage shell with
      // UV1 + a SECOND UV set carrying the livery + vertex colour -- and read
      // its count. It must come out at 16: a legal pipeline in this rig, but
      // one with NO slot left, so the headroom check below rejects it. If it
      // reads less, this test cannot see the defect it exists to catch.
      //
      // Built on a FRESH CLONE of the shell, not by mutating it: Babylon marks
      // material defines dirty only on the draw wrapper of the render pass that
      // is CURRENT when `markAsDirty` runs, so a mutation made between frames
      // dirties the wrong pass and the main pass keeps its old effect. This
      // control's first version did exactly that and read the unchanged 14. A
      // new sub-mesh has no cached defines and compiles from scratch.
      const shell = visuals.find((entry) => entry.kind === "airliner")!.visual.meshes
        .find((mesh) => mesh.name === "airliner-fuselage-shell");
      expect(shell, "no airliner fuselage shell to rebuild the black-screen build on").toBeDefined();
      const rebuilt = (shell as unknown as { clone: (name: string) => typeof shell }).clone("black-screen-build")!;
      (rebuilt as unknown as { makeGeometryUnique: () => void }).makeGeometryUnique();
      rebuilt.setVerticesData(VertexBuffer.UV2Kind, Float32Array.from(rebuilt.getVerticesData(VertexBuffer.UVKind)!), false, 2);
      rebuilt.setVerticesData(VertexBuffer.ColorKind, new Float32Array(rebuilt.getTotalVertices() * 4).fill(1), false, 4);
      (rebuilt.material as unknown as { albedoTexture: { coordinatesIndex: number } }).albedoTexture.coordinatesIndex = 1;
      await scene.whenReadyAsync();
      scene.render();
      await device.queue.onSubmittedWorkDone();
      blackScreenBuild = fragmentInputCount(
        rebuilt.subMeshes[0]!._getDrawWrapper(mainPass)?.effect?.fragmentSourceCode ?? "",
      );

      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);
      expect(loggerErrors, loggerErrors.join("\n\n")).toEqual([]);
      aerialReceivers.dispose();
      cloudShadowReceivers.dispose();
      for (const { visual } of visuals) visual.dispose();
      shadows.dispose();
      probe.dispose();
    } finally {
      Logger.Error = originalLoggerError;
      scene.dispose();
    }

    // One line per (airframe, material), worst sub-mesh, so the margin is on
    // record for every material and not only the one that is tight today.
    const worst = new Map<string, (typeof counts)[number]>();
    for (const row of counts) {
      const key = `${row.kind}/${row.material}`;
      if (!worst.has(key) || worst.get(key)!.inputs < row.inputs) worst.set(key, row);
    }
    for (const [key, row] of [...worst.entries()].sort((a, b) => b[1].inputs - a[1].inputs)) {
      const passes = [...new Set(counts.filter((c) => `${c.kind}/${c.material}` === key).map((c) => c.pass))].sort((a, b) => a - b);
      console.log(`[inter-stage] ${key.padEnd(44)} ${row.inputs}/${INTER_STAGE_LIMIT} `
        + `headroom=${INTER_STAGE_LIMIT - row.inputs}  (${row.mesh}, worst in pass ${row.pass}; passes ${passes.join(",")})`);
    }

    // NON-VACUITY. Every airframe must have been attributed, with real counts;
    // an audit that read no effects would otherwise pass over nothing.
    for (const kind of AIRCRAFT_KINDS) {
      expect(counts.filter((row) => row.kind === kind && row.inputs > 0).length,
        `no compiled fragment effect was attributed to ${kind}`).toBeGreaterThan(0);
    }
    expect(AIRCRAFT_KINDS, "the airframe list lost the 747").toContain("airliner");
    for (const kind of AIRCRAFT_KINDS) {
      expect(counts.some((row) => row.kind === kind && row.pass === mainPass && row.inputs > 0),
        `${kind}: the MAIN colour pass was never attributed -- the audit read only side passes`).toBe(true);
    }
    // THE SHIPPING PATH WAS BUILT: shadow-receiving paint compiled the CSM
    // receive varyings. Asserted on the attributed code, never declared.
    for (const kind of AIRCRAFT_KINDS) {
      const paint = counts.filter((row) => row.kind === kind && CSM_RECEIVE_MARKERS.every((m) => row.code.includes(m)));
      expect(paint.length, `${kind}: no attributed material compiled the CSM receive path`).toBeGreaterThan(0);
    }
    // POSITIVE CONTROL for the attribution, at the level that decides the count.
    // The airliner's fuselage skin is compiled fresh in this block (no earlier
    // block builds it), so the device MUST have been handed its FragmentInputs
    // struct. Find that struct, verbatim, in a module the device received, and
    // require the device-side count to equal the effect-side one. If this
    // fails, `fragmentSourceCode` is not what the device compiled and every
    // count above describes something else.
    const struct = (code: string) => /struct\s+FragmentInputs\s*\{([\s\S]*?)\n\}/u.exec(code)?.[0] ?? "";
    const skin = counts.filter((row) => row.kind === "airliner" && row.mesh === "airliner-fuselage-shell");
    expect(skin.length, "the airliner's fuselage shell was not attributed at all").toBeGreaterThan(0);
    const fragmentModules = blockModules.filter((module) => struct(module.code) !== "");
    console.log(`[inter-stage] control: ${blockModules.length} modules captured in this block, `
      + `${fragmentModules.length} with a FragmentInputs struct`);
    const matched = skin.filter((row) => {
      const needle = struct(row.code);
      return needle !== "" && fragmentModules.some((module) =>
        struct(module.code) === needle && fragmentInputCount(module.code) === row.inputs);
    });
    expect(
      matched.length,
      "the fuselage shell's FragmentInputs struct, as read off its effect, appears in no module the "
      + "device compiled with the same count",
    ).toBeGreaterThan(0);

    console.log(`[inter-stage] control: the black-screen build (shell + vertex colour) = `
      + `${blackScreenBuild}/${INTER_STAGE_LIMIT}, headroom=${INTER_STAGE_LIMIT - blackScreenBuild}`);
    expect(blackScreenBuild, "the rebuilt black-screen build must sit at the device maximum")
      .toBe(INTER_STAGE_LIMIT);
    expect(INTER_STAGE_LIMIT - blackScreenBuild >= 1,
      "the headroom check must REJECT the build that stopped the renderer").toBe(false);

    // THE LIVERY COSTS NOTHING OVER ORDINARY PAINT. The skin carries its
    // image on UV1 precisely so that it sits level with every other airframe's
    // body paint; a skin heavier than the lightest airframe body means a
    // varying crept back in (a second UV set, or vertex colour).
    const livery = worst.get("airliner/airliner-skin");
    const plainPaint = Math.min(...["trainer/trainer-body", "jet/jet-body"]
      .map((key) => worst.get(key)?.inputs ?? Number.POSITIVE_INFINITY));
    expect(livery, "the airliner's livery skin was not attributed").toBeDefined();
    expect(Number.isFinite(plainPaint), "no plain airframe paint was attributed to compare with").toBe(true);
    expect(livery!.inputs, `the livery skin compiles at ${livery!.inputs}, heavier than plain airframe `
      + `paint at ${plainPaint}: a varying crept back onto the fuselage shell`).toBeLessThanOrEqual(plainPaint);

    for (const [key, row] of worst) {
      expect(row.inputs, `${key} compiles at ${row.inputs} fragment inputs, over the device maximum of `
        + `${INTER_STAGE_LIMIT}. The mesh will not draw at all.`).toBeLessThanOrEqual(INTER_STAGE_LIMIT);
      expect(INTER_STAGE_LIMIT - row.inputs, `${key} has NO slot for the clustered container `
        + `(${row.inputs}/${INTER_STAGE_LIMIT}, on ${row.mesh}). The airfield attaches one in production, `
        + "so this material stops drawing the moment the airport has lamps. Free a varying first.")
        .toBeGreaterThanOrEqual(1);
    }
  }, 120_000);
});
