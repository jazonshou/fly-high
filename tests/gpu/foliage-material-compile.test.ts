import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Side-effect import: tree-shaken Babylon needs the shadow scene component
// registered before shadow maps render.
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { CloudShadowMaterialPlugin } from "../../src/render/webgpu/clouds/CloudShadowMaterialPlugin";
import { AerialPerspectiveMaterialPlugin } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { DetailInstanceMaterialPlugin } from "../../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { createFoliageAtlas } from "../../src/render/webgpu/detail/FoliageAtlas";
import {
  createImpostorAtlas,
  impostorBakeFrame,
  impostorLayerIndex,
  IMPOSTOR_SPECIES,
} from "../../src/render/webgpu/detail/ImpostorAtlas";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_STRIDE_BYTES,
  DetailInstanceWriter,
  yawQuaternion,
} from "../../src/render/webgpu/detail/instanceFormat";
import {
  buildGrassPatchPrototype,
  buildShrubPrototype,
  buildTreePrototype,
  type PrototypeGeometry,
} from "../../src/render/webgpu/detail/prototypeGeometry";

/**
 * 2-12 — on-adapter compile test for the detail material stack.
 *
 * Five successive 2-12 rebaseline failures only manifested on a real WebGPU
 * device, each costing a seven-minute capture to see:
 *   1. `fragmentInputs.vMainUV1` absent (PBR only emits it with own textures),
 *   2. 17 vertex output locations > the 16 limit (PBR + 4-cascade CSM),
 *   3. atlas never bound (plugin constructor enable-order) → createBindGroup,
 *   4. `textureSample` in non-uniform control flow in the depth fragment,
 *   5. the ShadowDepthWrapper's injected `shadowMapVertexNormalBias` include.
 * This test assembles the EXACT production stack — real prototype geometry,
 * real foliage atlas, real plugin with the atlas define, real ShadowDepthWrapper
 * under a CascadedShadowGenerator with AtmosphereSystem's settings — renders a
 * few frames, and fails on ANY uncaptured GPU error, with the offending
 * generated WGSL excerpted in the failure message.
 */

const CANVAS_SIZE = 256;

interface ShaderRecord {
  label: string;
  code: string;
}

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];
const shaderModules: ShaderRecord[] = [];

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

  // Record every shader module so a parse error can be excerpted, and collect
  // uncaptured errors instead of letting Babylon merely log them.
  const device = (engine as unknown as { _device: GPUDevice })._device;
  const originalCreate = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
    shaderModules.push({
      label: String(descriptor.label ?? ""),
      code: String(descriptor.code),
    });
    if (shaderModules.length > 64) shaderModules.shift();
    return originalCreate(descriptor);
  };
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/** Annotate "…:LINE:COL error…" parse failures with the generated source. */
function describeGpuErrors(): string {
  return gpuErrors
    .map((message) => {
      const location = /:(\d+):(\d+) error/.exec(message);
      if (!location) return message;
      const line = Number(location[1]);
      const shaderRecord = [...shaderModules]
        .reverse()
        .find((record) => record.code.split("\n").length >= line);
      if (!shaderRecord) return message;
      const lines = shaderRecord.code.split("\n");
      const excerpt = lines
        .slice(Math.max(0, line - 8), line + 2)
        .map((text, index) => `${Math.max(0, line - 8) + index + 1}: ${text}`)
        .join("\n");
      return `${message}\n--- ${shaderRecord.label} ---\n${excerpt}`;
    })
    .join("\n\n");
}

/** Mirrors WorldDetailRuntime.buildPrototypeMesh. */
function buildPrototypeMesh(
  name: string,
  geometry: PrototypeGeometry,
  scene: Scene,
): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = geometry.positions;
  data.normals = geometry.normals;
  data.uvs = geometry.uvs;
  data.tangents = geometry.tangents;
  data.colors = geometry.colors;
  data.indices = geometry.indices;
  data.applyToMesh(mesh, false);
  mesh.setVerticesBuffer(new VertexBuffer(
    scene.getEngine(),
    geometry.atlasLayer,
    "atlasLayer",
    { updatable: false, instanced: false, size: 1 },
  ));
  return mesh;
}

/** Mirrors WorldDetailRuntime.uploadBatch for a single instance. */
function uploadOneInstance(
  mesh: Mesh,
  scene: Scene,
  fade = 1,
  fadeIncoming = false,
): void {
  const writer = new DetailInstanceWriter(1);
  writer.push({
    x: 0,
    y: 0,
    z: 0,
    quaternion: yawQuaternion(0.4),
    heightScaleMeters: 18,
    radialScale: 1,
    fade,
    fadeIncoming,
    variant: 1 + 3 * 32, // variant 1 with the thinned-crown modifier (bits 3)
    tint: [0.35, 0.5, 0.3, 1],
    windPhase: 0.25,
    windResponse: 0.6,
  });
  const packed = writer.finish();
  const engine = scene.getEngine();
  const shared = new Buffer(
    engine,
    packed,
    false,
    DETAIL_INSTANCE_STRIDE_BYTES,
    false,
    true,
    true,
  );
  const typeFor = (name: string): number =>
    name === "float" ? VertexBuffer.FLOAT
    : name === "snorm16" ? VertexBuffer.SHORT
    : name === "unorm16" ? VertexBuffer.UNSIGNED_SHORT
    : VertexBuffer.UNSIGNED_BYTE;
  for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, shared, attribute.kind, {
        updatable: false,
        instanced: true,
        size: attribute.size,
        offset: attribute.byteOffset,
        stride: DETAIL_INSTANCE_STRIDE_BYTES,
        useBytes: true,
        type: typeFor(attribute.type),
        normalized: attribute.normalized,
      }),
      false,
    );
  }
  mesh.resetDrawCache(undefined, true);
  mesh.forcedInstanceCount = 1;
  mesh.setBoundingInfo(new BoundingInfo(
    new Vector3(-30, 0, -30),
    new Vector3(30, 40, 30),
  ));
}

describe("detail material stack compiles on-adapter (2-12)", () => {
  it("renders crown + trunk batches under CSM with zero uncaptured GPU errors", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const camera = new FreeCamera("compile-camera", new Vector3(0, 14, -40), scene);
      camera.setTarget(new Vector3(0, 8, 0));
      scene.activeCamera = camera;

      // AtmosphereSystem's exact CSM configuration (normalBias included —
      // failure 5 only exists with SM_NORMALBIAS 1).
      const sun = new DirectionalLight(
        "compile-sun",
        new Vector3(-0.4, -0.75, 0.3).normalize(),
        scene,
      );
      sun.intensity = 2;
      // Ambient fill standing in for the production sky probe — without it
      // the two-sided crown reads black and the visibility assertion below
      // cannot tell a tree from the background.
      const fill = new HemisphericLight("compile-fill", new Vector3(0, 1, 0), scene);
      fill.intensity = 0.8;
      const shadows = new CascadedShadowGenerator(1024, sun, false, camera, true);
      shadows.numCascades = 4;
      shadows.stabilizeCascades = true;
      shadows.lambda = 0.78;
      shadows.cascadeBlendPercentage = 0.12;
      shadows.shadowMaxZ = 200;
      shadows.bias = 0.00035;
      shadows.normalBias = 0.035;
      shadows.filter = ShadowGenerator.FILTER_PCF;
      shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;

      // Production parity: scene.environmentTexture is the sky probe's cube
      // (1C-6) — its REFLECTION defines add fragment inputs on every PBR
      // material, and the 16-input budget must be proven against them.
      const probe = new ReflectionProbe("compile-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;

      const ground = CreateGround("compile-ground", { width: 120, height: 120 }, scene);
      const groundMaterial = new StandardMaterial("compile-ground-material", scene);
      groundMaterial.diffuseColor = new Color3(0.6, 0.6, 0.6);
      ground.material = groundMaterial;
      ground.receiveShadows = true;

      const atlas = createFoliageAtlas(scene, "foliage-compile-test");
      const prototype = buildTreePrototype("pine", 1, 7);

      // Mirrors WorldDetailRuntime.createMaterial, atlas path on the crown.
      const buildMaterial = (
        name: string,
        samplesAtlas: boolean,
        bandFades = true,
        opaqueCrown = false,
      ) => {
        const material = new PBRMaterial(name, scene);
        // 7-4b: production sets this on every detail material
        // (`WorldDetailRuntime.createMaterial`). Mirrored here because a
        // budget measured on a permutation that does not ship is worth
        // nothing -- and without it this rig would pin 16 while production
        // compiles 15.
        material.forceIrradianceInFragment = true;
        material.albedoColor = new Color3(0.4, 0.5, 0.35);
        material.metallic = 0;
        material.roughness = 0.9;
        const plugin = new DetailInstanceMaterialPlugin(material);
        plugin.setTimeSeconds(1.5);
        // Production parity: FlightRenderer registers every detail material
        // with BOTH receiver registries — their plugins ride along here so
        // the varying/input budget the rig proves is the shipping one.
        new CloudShadowMaterialPlugin(material);
        new AerialPerspectiveMaterialPlugin(material);
        // Production parity: TREE materials run fragment-computed band
        // fades (2-17 close) — the record's fade lane carries a band code.
        // Shrubs/grass keep legacy baked fades, exactly as production wires
        // them (the hardened per-region check caught the rig over-applying
        // band fades to the shrub, whose legacy byte decoded as a nonsense
        // band code and dithered it to nothing).
        if (bandFades) plugin.setBandFades(400, 1_400, 8_000);
        if (samplesAtlas) {
          plugin.setFoliageAtlas(atlas.texture);
          if (opaqueCrown) {
            // Near closed crowns compile a distinct no-discard, one-sided
            // opaque pipeline. Alpha=1 on the old card material is not
            // equivalent and would fail to exercise early-Z behavior.
            plugin.setOpaqueCrown(true);
            material.backFaceCulling = true;
            material.twoSidedLighting = false;
            material.transparencyMode = Material.MATERIAL_OPAQUE;
          } else {
            // Mid cards remain double-sided in the alpha-test bucket.
            material.backFaceCulling = false;
            material.twoSidedLighting = true;
            material.transparencyMode = Material.MATERIAL_ALPHATEST;
          }
        }
        material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene, {
          remappedVariables: ["vNormalW", "vertexOutputs.vNormalW"],
        });
        return material;
      };

      const crown = buildPrototypeMesh("compile-crown", prototype.crown, scene);
      crown.material = buildMaterial(
        "compile-crown-material",
        true,
        true,
        true,
      );
      crown.useVertexColors = true;
      crown.receiveShadows = true;
      // Closed near crown uses the vertex-area transition, never dither.
      uploadOneInstance(crown, scene, 0 / 127, false);

      const trunk = buildPrototypeMesh("compile-trunk", prototype.trunk, scene);
      trunk.material = buildMaterial(
        "compile-trunk-material",
        false,
      );
      trunk.useVertexColors = true;
      trunk.receiveShadows = true;
      uploadOneInstance(trunk, scene, 0 / 127, false);

      // 2-12b: a card shrub rides the same stack (atlas define, alpha-test
      // bucket, double-sided) on its own mesh — drawn here so the shrub
      // path proves pixels on-adapter too, per the 2-12 rule.
      const shrub = buildPrototypeMesh(
        "compile-shrub",
        buildShrubPrototype("juniper", 0, 7),
        scene,
      );
      shrub.material = buildMaterial("compile-shrub-material", true, false);
      shrub.useVertexColors = true;
      shrub.receiveShadows = true;
      // 2-14: the INCOMING comparison path (survive bayer >= 1 - fade).
      uploadOneInstance(shrub, scene, 0.6, true);
      shrub.position.x = 14;

      // 2-16: the ground-cover shape (two-sided atlas cards + receivers).
      const grass = buildPrototypeMesh(
        "compile-grass",
        buildGrassPatchPrototype(7, "grass"),
        scene,
      );
      grass.material = buildMaterial("compile-grass-material", true, false);
      grass.useVertexColors = true;
      grass.receiveShadows = true;
      uploadOneInstance(grass, scene, 1, false);
      grass.position.x = 7;

      // 2-17: a billboard impostor through its own pipeline permutation
      // (DETAIL_IMPOSTOR define, three-view blend, season mix) — drawn
      // mid-frame like everything else, per the pixels-not-just-compiles
      // rule. Impostors neither cast nor receive shadows.
      const impostorAtlas = createImpostorAtlas(scene, "foliage-compile-test");
      const impostorMaterial = new PBRMaterial("compile-impostor-material", scene);
      impostorMaterial.forceIrradianceInFragment = true;
      impostorMaterial.albedoColor = new Color3(1, 1, 1);
      impostorMaterial.metallic = 0;
      impostorMaterial.roughness = 0.95;
      const impostorPlugin = new DetailInstanceMaterialPlugin(impostorMaterial);
      new CloudShadowMaterialPlugin(impostorMaterial);
      new AerialPerspectiveMaterialPlugin(impostorMaterial);
      // Perf-debt pass: ONE material for every species, the bake frames a
      // uniform table indexed by the instance's variant byte, and the
      // normal/depth array bound alongside the albedo array (2-17 uploaded
      // it and deferred the shading hookup).
      impostorPlugin.setImpostorAtlas(
        impostorAtlas.albedo,
        impostorAtlas.normalDepth,
        IMPOSTOR_SPECIES.map((species) => {
          const frame = impostorBakeFrame(species);
          return {
            extentUnit: frame.extentUnit,
            centerYUnit: frame.centerYUnit,
            leafedLayer: impostorLayerIndex(species, 0),
            bareLayer: impostorLayerIndex(species, 1),
          };
        }),
      );
      impostorPlugin.setImpostorSeason(0.3);
      // `6-11`: bind the global horizon field so DETAIL_HORIZON_SHADOW is ON
      // for this permutation. Without this the far-field receiver compiles
      // out and the whole block would ship never having met an adapter —
      // which is the 2-12 failure mode this file exists for.
      //
      // An all-zero field is the parity sentinel: horizon sin 0 means nothing
      // occludes the sun, so the term returns 1 and the rasterization
      // assertion below still reads an unshadowed, chromatic tree.
      const horizonLayers = [0, 1].map(() => RawTexture.CreateRGBATexture(
        new Uint8Array(8 * 8 * 4),
        8,
        8,
        scene,
        false,
        false,
        Texture.BILINEAR_SAMPLINGMODE,
      ));
      impostorPlugin.setHorizonField(
        horizonLayers[0]!, horizonLayers[1]!, -4_000, -4_000, 8_000);
      impostorMaterial.backFaceCulling = false;
      impostorMaterial.twoSidedLighting = true;
      impostorMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
      const impostor = new Mesh("compile-impostor", scene);
      const impostorData = new VertexData();
      impostorData.positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
      impostorData.normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
      impostorData.uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
      impostorData.indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
      impostorData.applyToMesh(impostor, false);
      impostor.material = impostorMaterial;
      // The production contract: registerBatch forces receive ON, and the
      // impostor path must force it back OFF — with front_facing and the
      // blend varyings, cascade inputs overflow the 16-fragment-input limit.
      impostor.receiveShadows = true;
      impostor.receiveShadows = false;
      uploadOneInstance(impostor, scene, 1, false);
      impostor.position.x = -14;

      shadows.addShadowCaster(crown);
      shadows.addShadowCaster(trunk);
      shadows.addShadowCaster(shrub);

      // Render until the shadow depth effects report ready (they compile
      // asynchronously) — without this the zero-error assertion would pass
      // vacuously whenever compilation simply never finished.
      let depthReady = false;
      for (let frame = 0; frame < 300 && !depthReady; frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
        depthReady = [crown, trunk].every((mesh) => {
          const subMesh = mesh.subMeshes[0];
          return subMesh !== undefined
            && (shadows.isReady(subMesh, true, false)
              || shadows.isReady(subMesh, false, false));
        });
        if (gpuErrors.length > 0) break;
      }
      for (let frame = 0; frame < 10; frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // Uncaptured errors arrive asynchronously — drain the queue.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(gpuErrors, describeGpuErrors()).toEqual([]);
      expect(depthReady, "shadow depth effects never became ready").toBe(true);

      // `6-11`, non-vacuity: a zero-error render proves nothing about a block
      // that compiled OUT. An undeclared plugin define survives only through
      // `MaterialDefines.rebuild()`'s Object.keys re-derivation, and the
      // recorded incident (DETAIL_BAND_FADES) is exactly a define that read
      // false in silence while every binding stayed correct — an invisible
      // forest. So assert the far-field receiver reached the adapter.
      expect(
        shaderModules.some((record) => record.code.includes("fn detailHorizonShadow(")),
        "DETAIL_HORIZON_SHADOW never reached a compiled shader — the far-field "
        + "horizon receiver was stripped, and the zero-error render above is vacuous",
      ).toBe(true);
      // And that it runs the SHARED operator rather than a restatement.
      expect(
        shaderModules.some((record) => record.code.includes("fn horizonFieldShadow(")),
        "the impostor shader does not compose HorizonField's lookup",
      ).toBe(true);

      // `6-11`: the per-stage binding budget, measured on the COMPILED source
      // rather than declared.
      //
      // This assertion exists because a declared budget is not the real one.
      // The terrain material's hand-maintained `TERRAIN_SAMPLED_BINDINGS` list
      // is checked only for uniqueness and against 16, and it both lists PBR
      // samplers the material never binds and omits the shadow and
      // cloud-shadow projection samplers it does — nothing compares it to a
      // shader. The detail material had no such list at all, and this item
      // added two samplers to the heaviest permutation in the project (PBR +
      // impostor atlases + CSM depth array + cloud shadow + aerial
      // perspective). Exceeding a per-stage limit is a pipeline-creation
      // failure, not a graceful fallback, so the count is pinned here where a
      // real adapter has already compiled it.
      const impostorFragment = [...shaderModules]
        .reverse()
        .find((record) => record.code.includes("fn detailHorizonShadow("));
      expect(impostorFragment, "no compiled impostor fragment shader was recorded")
        .toBeDefined();
      const declarations = impostorFragment!.code;
      const samplers = declarations.match(/var\s+\w+\s*:\s*sampler(_comparison)?\s*;/g) ?? [];
      const textures = declarations.match(/var\s+\w+\s*:\s*texture_\w+</g) ?? [];
      // WebGPU's base limits are 16 sampled textures and 16 samplers per stage.
      // MEASURED on the reference adapter: this permutation compiles to 7
      // samplers, of which `6-11` added 2 — so the far-field receiver spends
      // 2 of 11 remaining slots and leaves 9. Report the margin in the failure
      // message so a future addition sees the room it is spending rather than
      // discovering the wall at pipeline creation.
      expect(
        samplers.length,
        `compiled impostor fragment declares ${samplers.length} samplers (limit 16)`,
      ).toBeLessThanOrEqual(16);
      expect(
        textures.length,
        `compiled impostor fragment declares ${textures.length} sampled textures (limit 16)`,
      ).toBeLessThanOrEqual(16);
      // Non-vacuity: a regex that matched nothing would pass both bounds.
      expect(samplers.length).toBeGreaterThan(3);
      expect(textures.length).toBeGreaterThan(3);

      // 7-4b: THE INTER-STAGE BUDGET, which is the tight one and had nothing
      // watching it. This material sits at EXACTLY the device limit with zero
      // slots free, so the next varying anyone adds does not degrade — it
      // fails pipeline creation and the mesh stops drawing entirely.
      //
      // COUNT IT THE WAY THE DEVICE DOES. The adapter's own message is
      // "Total fragment input variables count (17 = 16 (user-defined) + 1
      // (front_facing)) exceeds the maximum (16)" — so `@location` plus
      // `front_facing`, and `@builtin(position)` is NOT counted. Counting all
      // builtins over-reports by one and makes a material with a free slot
      // look full; counting locations alone under-reports and makes a full one
      // look free. Both mistakes were made before this line existed.
      //
      // MEASURED, both arms, same tree, one flag: attaching a
      // `ClusteredLightContainer` adds exactly +1 `@location` to every
      // permutation of this material. Before 7-4b that took the peak from
      // 16/16 to 17/16 and the crowns, trunks and impostors ALL stopped
      // rasterizing — a budget wall, not a wiring bug.
      //
      // 7-4b freed the slot with `forceIrradianceInFragment`, set above and in
      // production, which deletes `vEnvironmentIrradiance`. The peak is now 15
      // and the container fits with nothing to spare.
      const peakFragmentInputs = Math.max(
        ...shaderModules.map((record) => {
          const struct = /struct\s+FragmentInputs\s*\{([\s\S]*?)\n\}/u.exec(record.code);
          if (!struct) return 0;
          const locations = [...struct[1]!.matchAll(/@location\(/gu)].length;
          const frontFacing = /@builtin\(front_facing\)/u.test(struct[1]!) ? 1 : 0;
          return locations + frontFacing;
        }),
      );
      expect(
        peakFragmentInputs,
        `the detail material's peak fragment-input count is ${peakFragmentInputs}, over the `
        + "device maximum of 16. The mesh will not draw at all — this is not a soft regression.",
      ).toBeLessThanOrEqual(16);
      // Pinned EXACTLY, in both directions, because both are news. Going UP is
      // the wall above. Going DOWN means a slot was freed, which is the one
      // thing that would let the clustered container onto this material, and
      // it must not happen silently.
      expect(
        peakFragmentInputs,
        "the detail material's fragment-input count moved. UP means the ONE slot 7-4b freed "
        + "has been spent and a clustered light container no longer fits; DOWN means another "
        + "was freed. Either way, re-derive before repinning -- and check this rig still sets "
        + "`forceIrradianceInFragment` the way production does.",
      ).toBe(15);

      // Non-vacuity 2: the instance must actually RASTERIZE. A tree that
      // compiles cleanly but draws no pixels (degenerate decode, zero scale,
      // full transparency) costs full GPU time while looking like bare
      // terrain — precisely the 2-12 rebaseline failure mode. Background and
      // ground are achromatic (black / grey); the crown tint and bark are
      // not, so chromatic pixels ARE the tree. Render-and-copy must happen
      // in one synchronous task before the compositor consumes the frame.
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      const copy = document.createElement("canvas");
      copy.width = CANVAS_SIZE;
      copy.height = CANVAS_SIZE;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
      // Column-resolved: each population sits in its own screen third
      // (impostor x=-14 left, tree centre, grass/shrub right), so a single
      // invisible population cannot hide behind the others' pixels — the
      // undeclared-define regression passed a whole-frame floor exactly
      // that way.
      const columnThird = (index: number) =>
        Math.min(2, Math.floor(((index % CANVAS_SIZE) * 3) / CANVAS_SIZE));
      const chromaticByThird: [number, number, number] = [0, 0, 0];
      for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
        const r = image[index * 4] ?? 0;
        const g = image[index * 4 + 1] ?? 0;
        const b = image[index * 4 + 2] ?? 0;
        const spread = Math.max(r, g, b) - Math.min(r, g, b);
        if (spread > 24) chromaticByThird[columnThird(index)] = chromaticByThird[columnThird(index)]! + 1;
      }
      expect(
        chromaticByThird[0]!,
        "the impostor rasterized no visible pixels",
      ).toBeGreaterThan(40);
      expect(
        chromaticByThird[1]!,
        "the tree rasterized no visible pixels",
      ).toBeGreaterThan(80);
      expect(
        chromaticByThird[2]!,
        "the shrub/grass rasterized no visible pixels",
      ).toBeGreaterThan(40);
    } finally {
      scene.dispose();
    }
  });
});
